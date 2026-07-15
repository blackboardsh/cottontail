import { EventEmitter } from "./events.js";
import { resolve } from "./path.js";
import { Readable, Writable } from "./stream.js";
import "../bun/ffi.js";

const wireVersion = 1;
const typedArrayConstructors = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};
const environmentData = new Map(globalThis.__cottontailEnvironmentData ?? []);
const markedUntransferable = new WeakSet();
const markedUncloneable = new WeakSet();
const detachedArrayBuffers = new WeakSet();
const workerInstances = new Map();
const broadcastChannels = new Map();
const transferredPortPeers = new Map();
const portMessageEnvelopeKey = "__cottontailWorkerThreadsPortMessage";
let nextPortId = 1;
let detachedViewAccessorsPatched = false;

export const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");
export const isMainThread = !cottontail.isWorker?.();
export const isInternalThread = false;
export const threadId = isMainThread ? 0 : Number(cottontail.workerThreadId?.() ?? 1);
export const threadName = isMainThread ? "" : String(globalThis.__cottontailWorkerThreadName ?? "worker");
export const workerData = isMainThread ? null : globalThis.__cottontailWorkerData ?? null;
export const resourceLimits = isMainThread ? {} : globalThis.__cottontailWorkerResourceLimits ?? {};

function dataCloneError(message) {
  const error = new Error(message);
  error.name = "DataCloneError";
  error.code = "ERR_WORKER_UNSERIALIZABLE_ERROR";
  return error;
}

function bytesFromView(view) {
  if (detachedArrayBuffers.has(view.buffer)) throw dataCloneError("ArrayBuffer is detached");
  return Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
}

function bytesFromBuffer(buffer) {
  if (detachedArrayBuffers.has(buffer)) throw dataCloneError("ArrayBuffer is detached");
  return Array.from(new Uint8Array(buffer));
}

function viewName(value) {
  if (globalThis.Buffer?.isBuffer?.(value)) return "Buffer";
  if (value instanceof DataView) return "DataView";
  return value?.constructor?.name ?? "Uint8Array";
}

function sharedBufferInfo(value) {
  try {
    const info = cottontail.sharedArrayBufferInfo?.(value);
    return info && typeof info === "object" && info.id != null ? info : null;
  } catch {
    return null;
  }
}

function wrapSharedBuffer(sharedId) {
  const buffer = cottontail.sharedArrayBufferWrap?.(Number(sharedId));
  return globalThis.__cottontailMarkSharedArrayBuffer?.(buffer) ?? buffer;
}

function isTransferable(item) {
  return item instanceof MessagePort || (item instanceof ArrayBuffer && !sharedBufferInfo(item));
}

function validateTransferList(transferList = undefined) {
  if (transferList == null) return [];
  if (typeof transferList[Symbol.iterator] !== "function") throw new TypeError("transferList must be an iterable");
  const transfers = Array.from(transferList);
  const seen = new Set();
  for (const item of transfers) {
    if (seen.has(item)) throw dataCloneError("Transfer list contains duplicate item");
    seen.add(item);
    if (!isTransferable(item)) throw dataCloneError("Object is not transferable");
    if (isMarkedAsUntransferable(item)) throw dataCloneError("Object is marked as untransferable");
    if (item instanceof MessagePort && item._closed) throw dataCloneError("MessagePort is closed");
    if (item instanceof ArrayBuffer && detachedArrayBuffers.has(item)) throw dataCloneError("ArrayBuffer is detached");
  }
  return transfers;
}

function findPropertyDescriptor(proto, key) {
  for (let cursor = proto; cursor; cursor = Object.getPrototypeOf(cursor)) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) return descriptor;
  }
  return null;
}

function patchViewAccessor(proto, key) {
  const original = findPropertyDescriptor(proto, key);
  if (typeof original?.get !== "function") return;
  try {
    Object.defineProperty(proto, key, {
      configurable: true,
      get() {
        if (ArrayBuffer.isView(this)) {
          try {
            if (detachedArrayBuffers.has(this.buffer)) return 0;
          } catch {}
        }
        return original.get.call(this);
      },
    });
  } catch {}
}

function patchDetachedViewAccessors() {
  if (detachedViewAccessorsPatched) return;
  detachedViewAccessorsPatched = true;
  for (const Constructor of Object.values(typedArrayConstructors)) {
    patchViewAccessor(Constructor.prototype, "length");
    patchViewAccessor(Constructor.prototype, "byteLength");
    patchViewAccessor(Constructor.prototype, "byteOffset");
  }
  patchViewAccessor(DataView.prototype, "byteLength");
  patchViewAccessor(DataView.prototype, "byteOffset");
}

function detachArrayBufferForTransfer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || sharedBufferInfo(buffer) || detachedArrayBuffers.has(buffer)) return;
  patchDetachedViewAccessors();
  detachedArrayBuffers.add(buffer);
  try {
    Object.defineProperty(buffer, "byteLength", { get: () => 0, configurable: true });
  } catch {}
}

function encodeClone(value, state = { ids: new WeakMap(), nextId: 1 }) {
  if (value === undefined) return { t: "undefined" };
  if (value === null) return { t: "null" };
  if (typeof value === "boolean" || typeof value === "string") return { t: typeof value, v: value };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { t: "number", v: "NaN" };
    if (value === Infinity) return { t: "number", v: "Infinity" };
    if (value === -Infinity) return { t: "number", v: "-Infinity" };
    if (Object.is(value, -0)) return { t: "number", v: "-0" };
    return { t: "number", v: value };
  }
  if (typeof value === "bigint") return { t: "bigint", v: value.toString() };
  if (typeof value === "function" || typeof value === "symbol") throw dataCloneError("Value cannot be cloned");
  if (markedUncloneable.has(value)) throw dataCloneError("Object is marked as uncloneable");
  const existingId = state.ids.get(value);
  if (existingId != null) return { t: "Ref", id: existingId };
  if (value instanceof MessagePort) {
    if (!state.transfers?.has(value)) throw dataCloneError("MessagePort must be listed in transferList");
    if (value._closed) throw dataCloneError("MessagePort is closed");
    const id = state.nextId++;
    state.ids.set(value, id);
    if (state.transferContext?.threadId > 0) {
      value._remote = { threadId: state.transferContext.threadId, portId: value._id };
      if (value._peer) transferredPortPeers.set(value._id, value._peer);
    }
    value._transferred = true;
    value._closed = true;
    queueMicrotask(() => value.emit("close"));
    return { t: "MessagePort", id, portId: value._id };
  }
  const id = state.nextId++;
  state.ids.set(value, id);

  if (value instanceof Date) return { t: "Date", id, v: value.toISOString() };
  if (value instanceof RegExp) return { t: "RegExp", id, source: value.source, flags: value.flags };
  if (value instanceof ArrayBuffer) {
    const shared = sharedBufferInfo(value);
    if (shared) return { t: "SharedArrayBuffer", id, sharedId: shared.id, byteLength: shared.byteLength };
    return { t: "ArrayBuffer", id, bytes: bytesFromBuffer(value) };
  }
  if (ArrayBuffer.isView(value)) {
    const shared = sharedBufferInfo(value.buffer);
    if (shared) {
      return {
        t: "SharedView",
        id,
        name: viewName(value),
        sharedId: shared.id,
        byteOffset: value.byteOffset,
        length: value instanceof DataView ? value.byteLength : value.length,
      };
    }
    return { t: "View", id, name: viewName(value), bytes: bytesFromView(value) };
  }
  if (value instanceof Map) return { t: "Map", id, v: [...value].map(([key, item]) => [encodeClone(key, state), encodeClone(item, state)]) };
  if (value instanceof Set) return { t: "Set", id, v: [...value].map((item) => encodeClone(item, state)) };
  if (Array.isArray(value)) return { t: "Array", id, v: value.map((item) => encodeClone(item, state)) };
  if (value instanceof Error) return { t: "Error", id, name: value.name, message: value.message, stack: value.stack };
  return { t: "Object", id, v: Object.entries(value).map(([key, item]) => [key, encodeClone(item, state)]) };
}

function remember(refs, encoded, value) {
  if (encoded?.id != null) refs.set(encoded.id, value);
  return value;
}

function decodeClone(encoded, refs = new Map()) {
  switch (encoded?.t) {
    case "Ref": {
      if (!refs.has(encoded.id)) throw dataCloneError("Invalid cloned reference");
      return refs.get(encoded.id);
    }
    case "undefined": return undefined;
    case "null": return null;
    case "boolean":
    case "string": return encoded.v;
    case "number":
      if (encoded.v === "NaN") return NaN;
      if (encoded.v === "Infinity") return Infinity;
      if (encoded.v === "-Infinity") return -Infinity;
      if (encoded.v === "-0") return -0;
      return Number(encoded.v);
    case "bigint": return BigInt(encoded.v);
    case "Date": return remember(refs, encoded, new Date(encoded.v));
    case "RegExp": return remember(refs, encoded, new RegExp(encoded.source, encoded.flags));
    case "SharedArrayBuffer": return remember(refs, encoded, wrapSharedBuffer(encoded.sharedId));
    case "SharedView": {
      const buffer = wrapSharedBuffer(encoded.sharedId);
      if (encoded.name === "DataView") return remember(refs, encoded, new DataView(buffer, encoded.byteOffset ?? 0, encoded.length ?? undefined));
      const Constructor = typedArrayConstructors[encoded.name] ?? Uint8Array;
      return remember(refs, encoded, new Constructor(buffer, encoded.byteOffset ?? 0, encoded.length ?? undefined));
    }
    case "ArrayBuffer": return remember(refs, encoded, new Uint8Array(encoded.bytes ?? []).buffer);
    case "View": {
      const bytes = new Uint8Array(encoded.bytes ?? []);
      if (encoded.name === "Buffer") return remember(refs, encoded, globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : bytes);
      if (encoded.name === "DataView") return remember(refs, encoded, new DataView(bytes.buffer));
      const Constructor = typedArrayConstructors[encoded.name] ?? Uint8Array;
      return remember(refs, encoded, new Constructor(bytes.buffer));
    }
    case "MessagePort": {
      const port = remember(refs, encoded, new MessagePort());
      port._id = Number(encoded.portId ?? port._id);
      return port;
    }
    case "Map": {
      const map = remember(refs, encoded, new Map());
      for (const [key, value] of encoded.v ?? []) map.set(decodeClone(key, refs), decodeClone(value, refs));
      return map;
    }
    case "Set": {
      const set = remember(refs, encoded, new Set());
      for (const value of encoded.v ?? []) set.add(decodeClone(value, refs));
      return set;
    }
    case "Array": {
      const array = remember(refs, encoded, []);
      for (let index = 0; index < (encoded.v ?? []).length; index += 1) array[index] = decodeClone(encoded.v[index], refs);
      return array;
    }
    case "Error": {
      const error = new Error(encoded.message);
      error.name = encoded.name;
      error.stack = encoded.stack;
      return remember(refs, encoded, error);
    }
    case "Object": {
      const object = remember(refs, encoded, {});
      for (const [key, value] of encoded.v ?? []) object[key] = decodeClone(value, refs);
      return object;
    }
    default: throw dataCloneError("Invalid cloned worker payload");
  }
}

function encodeWireMessage(value, transferList = undefined, transferContext = undefined) {
  const transfers = validateTransferList(transferList);
  const encoded = JSON.stringify({
    cottontailWorkerClone: wireVersion,
    value: encodeClone(value, { ids: new WeakMap(), nextId: 1, transfers: new Set(transfers), transferContext }),
  });
  for (const item of transfers) detachArrayBufferForTransfer(item);
  return encoded;
}

function decodeWireMessage(value) {
  if (value && typeof value === "object" && value.cottontailWorkerClone === wireVersion) return decodeClone(value.value);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed?.cottontailWorkerClone === wireVersion) return decodeClone(parsed.value);
      return parsed;
    } catch {}
  }
  return value;
}

function cloneForMessage(value, transferList = undefined) {
  return decodeClone(JSON.parse(encodeWireMessage(value, transferList)).value);
}

function makePortMessage(portId, value) {
  return { [portMessageEnvelopeKey]: { portId, value } };
}

function dispatchTransferredPortMessage(message) {
  const packet = message?.[portMessageEnvelopeKey];
  if (!packet || packet.portId == null) return false;
  const peer = transferredPortPeers.get(Number(packet.portId));
  if (!peer || peer._closed) return true;
  peer._queue.push(packet.value);
  peer._dispatch();
  return true;
}

function workerCodecSource() {
  return `
const __workerTypedArrays = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array };
const __cottontailWorkerPortEnvelopeKey = ${JSON.stringify(portMessageEnvelopeKey)};
const __cottontailWorkerPorts = new Map();
function __workerBytesFromView(view){ return Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)); }
function __workerBytesFromBuffer(buffer){ return Array.from(new Uint8Array(buffer)); }
function __workerViewName(value){ if (globalThis.Buffer?.isBuffer?.(value)) return "Buffer"; if (value instanceof DataView) return "DataView"; return value?.constructor?.name ?? "Uint8Array"; }
function __workerSharedInfo(value){ try{ const info=cottontail.sharedArrayBufferInfo?.(value); return info&&typeof info==="object"&&info.id!=null?info:null; }catch{ return null; } }
function __workerWrapShared(id){ const buffer=cottontail.sharedArrayBufferWrap?.(Number(id)); return globalThis.__cottontailMarkSharedArrayBuffer?.(buffer)??buffer; }
function __workerEncode(value,state={ids:new WeakMap(),nextId:1}){ if(value===undefined)return{t:"undefined"}; if(value===null)return{t:"null"}; if(typeof value==="boolean"||typeof value==="string")return{t:typeof value,v:value}; if(typeof value==="number"){ if(Number.isNaN(value))return{t:"number",v:"NaN"}; if(value===Infinity)return{t:"number",v:"Infinity"}; if(value===-Infinity)return{t:"number",v:"-Infinity"}; if(Object.is(value,-0))return{t:"number",v:"-0"}; return{t:"number",v:value}; } if(typeof value==="bigint")return{t:"bigint",v:value.toString()}; if(typeof value==="function"||typeof value==="symbol")throw new Error("Value cannot be cloned"); if(globalThis.MessagePort&&value instanceof globalThis.MessagePort)throw new Error("MessagePort must be listed in transferList"); const existing=state.ids.get(value); if(existing!=null)return{t:"Ref",id:existing}; const id=state.nextId++; state.ids.set(value,id); if(value instanceof Date)return{t:"Date",id,v:value.toISOString()}; if(value instanceof RegExp)return{t:"RegExp",id,source:value.source,flags:value.flags}; if(value instanceof ArrayBuffer){ const shared=__workerSharedInfo(value); if(shared)return{t:"SharedArrayBuffer",id,sharedId:shared.id,byteLength:shared.byteLength}; return{t:"ArrayBuffer",id,bytes:__workerBytesFromBuffer(value)}; } if(ArrayBuffer.isView(value)){ const shared=__workerSharedInfo(value.buffer); if(shared)return{t:"SharedView",id,name:__workerViewName(value),sharedId:shared.id,byteOffset:value.byteOffset,length:value instanceof DataView?value.byteLength:value.length}; return{t:"View",id,name:__workerViewName(value),bytes:__workerBytesFromView(value)}; } if(value instanceof Map)return{t:"Map",id,v:[...value].map(([key,item])=>[__workerEncode(key,state),__workerEncode(item,state)])}; if(value instanceof Set)return{t:"Set",id,v:[...value].map((item)=>__workerEncode(item,state))}; if(Array.isArray(value))return{t:"Array",id,v:value.map((item)=>__workerEncode(item,state))}; if(value instanceof Error)return{t:"Error",id,name:value.name,message:value.message,stack:value.stack}; return{t:"Object",id,v:Object.entries(value).map(([key,item])=>[key,__workerEncode(item,state)])}; }
function __workerRemember(refs,encoded,value){ if(encoded?.id!=null)refs.set(encoded.id,value); return value; }
function __workerDecode(encoded,refs=new Map()){ switch(encoded?.t){ case "Ref": if(!refs.has(encoded.id))throw new Error("Invalid cloned reference"); return refs.get(encoded.id); case "undefined": return undefined; case "null": return null; case "boolean": case "string": return encoded.v; case "number": if(encoded.v==="NaN")return NaN; if(encoded.v==="Infinity")return Infinity; if(encoded.v==="-Infinity")return -Infinity; if(encoded.v==="-0")return -0; return Number(encoded.v); case "bigint": return BigInt(encoded.v); case "Date": return __workerRemember(refs,encoded,new Date(encoded.v)); case "RegExp": return __workerRemember(refs,encoded,new RegExp(encoded.source,encoded.flags)); case "SharedArrayBuffer": return __workerRemember(refs,encoded,__workerWrapShared(encoded.sharedId)); case "SharedView": { const buffer=__workerWrapShared(encoded.sharedId); if(encoded.name==="DataView")return __workerRemember(refs,encoded,new DataView(buffer,encoded.byteOffset||0,encoded.length)); const Ctor=__workerTypedArrays[encoded.name]||Uint8Array; return __workerRemember(refs,encoded,new Ctor(buffer,encoded.byteOffset||0,encoded.length)); } case "ArrayBuffer": return __workerRemember(refs,encoded,new Uint8Array(encoded.bytes||[]).buffer); case "View": { const bytes=new Uint8Array(encoded.bytes||[]); if(encoded.name==="Buffer")return __workerRemember(refs,encoded,globalThis.Buffer?.from?globalThis.Buffer.from(bytes):bytes); if(encoded.name==="DataView")return __workerRemember(refs,encoded,new DataView(bytes.buffer)); const Ctor=__workerTypedArrays[encoded.name]||Uint8Array; return __workerRemember(refs,encoded,new Ctor(bytes.buffer)); } case "MessagePort": return __workerRemember(refs,encoded,__cottontailGetWorkerPort(encoded.portId)); case "Map": { const map=__workerRemember(refs,encoded,new Map()); for(const [key,value] of encoded.v||[])map.set(__workerDecode(key,refs),__workerDecode(value,refs)); return map; } case "Set": { const set=__workerRemember(refs,encoded,new Set()); for(const value of encoded.v||[])set.add(__workerDecode(value,refs)); return set; } case "Array": { const array=__workerRemember(refs,encoded,[]); for(let index=0;index<(encoded.v||[]).length;index++)array[index]=__workerDecode(encoded.v[index],refs); return array; } case "Error": { const error=new Error(encoded.message); error.name=encoded.name; error.stack=encoded.stack; return __workerRemember(refs,encoded,error); } case "Object": { const object=__workerRemember(refs,encoded,{}); for(const [key,value] of encoded.v||[])object[key]=__workerDecode(value,refs); return object; } default: throw new Error("Invalid cloned worker payload"); } }
function __cottontailEncodeWorkerMessage(value){ return JSON.stringify({ cottontailWorkerClone: ${wireVersion}, value: __workerEncode(value) }); }
function __cottontailDecodeWorkerMessage(value){ if(value&&typeof value==="object"&&value.cottontailWorkerClone===${wireVersion})return __workerDecode(value.value); if(typeof value==="string"){ try{ const parsed=JSON.parse(value); if(parsed?.cottontailWorkerClone===${wireVersion})return __workerDecode(parsed.value); return parsed; }catch{} } return value; }
class __CottontailWorkerMessagePort {
  constructor(id){ this._id=Number(id??Math.floor(Math.random()*1000000000)); this._queue=[]; this._closed=false; this._started=false; this._peer=null; this._handlers=new Set(); this.onmessage=null; this.onmessageerror=null; }
  postMessage(value){ if(this._closed)return; if(this._peer&&!this._peer._closed){ this._peer._queue.push(__cottontailDecodeWorkerMessage(__cottontailEncodeWorkerMessage(value))); this._peer._dispatch(); return; } cottontail.workerPostMessage(__cottontailEncodeWorkerMessage({ [__cottontailWorkerPortEnvelopeKey]: { portId: this._id, value } })); }
  start(){ this._started=true; this._dispatch(); return this; }
  close(){ this._closed=true; this._handlers.clear(); return this; }
  ref(){ return this; }
  unref(){ return this; }
  hasRef(){ return true; }
  on(name,handler){ if(String(name)==="message"&&typeof handler==="function"){ this._handlers.add(handler); this.start(); } return this; }
  once(name,handler){ if(String(name)!=="message"||typeof handler!=="function")return this; const wrapped=(value)=>{ this.off("message",wrapped); handler(value); }; return this.on(name,wrapped); }
  off(name,handler){ if(String(name)==="message")this._handlers.delete(handler); return this; }
  addEventListener(name,handler){ return this.on(name,(value)=>handler({ data: value })); }
  removeEventListener(_name,_handler){ return this; }
  _dispatch(){ if(!this._started&&typeof this.onmessage!=="function"&&this._handlers.size===0)return; while(this._queue.length>0){ const value=this._queue.shift(); const event={ data: value }; if(typeof this.onmessage==="function")this.onmessage(event); for(const handler of [...this._handlers])handler(value); } }
}
class __CottontailWorkerMessageChannel {
  constructor(){ this.port1=new __CottontailWorkerMessagePort(); this.port2=new __CottontailWorkerMessagePort(); this.port1._peer=this.port2; this.port2._peer=this.port1; }
}
function __cottontailGetWorkerPort(portId){ const id=Number(portId); let port=__cottontailWorkerPorts.get(id); if(!port){ port=new __CottontailWorkerMessagePort(id); __cottontailWorkerPorts.set(id,port); } return port; }
function __cottontailDispatchWorkerPortMessage(message){ const packet=message?.[__cottontailWorkerPortEnvelopeKey]; if(!packet||packet.portId==null)return false; const port=__cottontailGetWorkerPort(packet.portId); port._queue.push(packet.value); port._dispatch(); return true; }
globalThis.MessagePort = __CottontailWorkerMessagePort;
globalThis.MessageChannel = __CottontailWorkerMessageChannel;
globalThis.__cottontailEncodeWorkerMessage = __cottontailEncodeWorkerMessage;
globalThis.__cottontailDecodeWorkerMessage = __cottontailDecodeWorkerMessage;
`;
}

function normalizeWorkerPath(filename, evalMode = false) {
  if (evalMode) {
    const dir = workerTempDir();
    cottontail.mkdirSync?.(dir, true);
    const sourcePath = `${dir}/worker-eval-${Date.now()}-${Math.floor(Math.random() * 1000000)}.js`;
    cottontail.writeFile(sourcePath, String(filename));
    return sourcePath;
  }
  const text = String(filename);
  if (text.startsWith("file://")) return decodeURIComponent(new URL(text).pathname);
  if (text.startsWith("data:")) throw new Error("data: workers are not supported by Cottontail worker_threads yet");
  return resolve(text);
}

function workerTempDir() {
  const configured = cottontail.env?.()?.COTTONTAIL_TMP_DIR;
  return configured ? `${configured}/workers` : `${cottontail.cwd()}/.cottontail-tmp`;
}

const workerWrapperCache = new Map();

function makeWorkerWrapper(targetPath, options = {}) {
  const workerDataWire = JSON.stringify(JSON.parse(encodeWireMessage(options.workerData ?? null)));
  const environmentDataWire = JSON.stringify(JSON.parse(encodeWireMessage([...environmentData])));
  const resourceLimitsWire = JSON.stringify(JSON.parse(encodeWireMessage(options.resourceLimits ?? {})));
  const cacheable = !(options.transferList?.length > 0) && !workerDataWire.includes('"t":"Port"');
  const cacheKey = cacheable
    ? JSON.stringify([targetPath, workerDataWire, environmentDataWire, resourceLimitsWire, options.name ?? ""])
    : null;
  const cached = cacheKey == null ? null : workerWrapperCache.get(cacheKey);
  if (cached && cottontail.existsSync?.(cached)) return cached;

  const dir = workerTempDir();
  cottontail.mkdirSync?.(dir, true);
  const wrapperPath = `${dir}/worker-thread-${Date.now()}-${Math.floor(Math.random() * 1000000)}.js`;
  const source = [
    workerCodecSource(),
    `globalThis.__cottontailWorkerData = __cottontailDecodeWorkerMessage(${workerDataWire});`,
    `globalThis.__cottontailEnvironmentData = __cottontailDecodeWorkerMessage(${environmentDataWire});`,
    `globalThis.__cottontailWorkerResourceLimits = __cottontailDecodeWorkerMessage(${resourceLimitsWire});`,
    `globalThis.__cottontailWorkerThreadName = ${JSON.stringify(options.name ?? "")};`,
    `globalThis.workerData = globalThis.__cottontailWorkerData;`,
    `let __cottontailWorkerShouldExit = false;`,
    `const __cottontailWorkerExitSentinel = { cottontailWorkerExit: true };`,
    `const __cottontailWorkerImmediateQueue = [];`,
    `globalThis.setImmediate ??= (callback, ...args) => { const handle = { ref(){ return this; }, unref(){ return this; }, hasRef(){ return true; } }; __cottontailWorkerImmediateQueue.push({ callback, args, handle }); queueMicrotask(() => { const index = __cottontailWorkerImmediateQueue.findIndex((item) => item.handle === handle); if (index < 0 || __cottontailWorkerShouldExit) return; const item = __cottontailWorkerImmediateQueue.splice(index, 1)[0]; try { const result = item.callback(...item.args); if (result && typeof result.then === "function") result.catch((error) => { if (error !== __cottontailWorkerExitSentinel) throw error; }); } catch (error) { if (error !== __cottontailWorkerExitSentinel) throw error; } }); return handle; };`,
    `globalThis.clearImmediate ??= (handle) => { const index = __cottontailWorkerImmediateQueue.findIndex((item) => item.handle === handle); if (index >= 0) __cottontailWorkerImmediateQueue.splice(index, 1); };`,
    `globalThis.process ??= { exitCode: 0, execArgv: [], env: {}, nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)), exit(code = 0) { this.exitCode = Number(code) || 0; __cottontailWorkerShouldExit = true; cottontail.exit(this.exitCode); throw __cottontailWorkerExitSentinel; } };`,
    `globalThis.__cottontailHasActiveHandles = () => !__cottontailWorkerShouldExit && (typeof globalThis.onmessage === "function" || __cottontailParentPortHandlers.size > 0 || __cottontailWorkerImmediateQueue.length > 0);`,
    `const __cottontailParentPortHandlers = new Set();`,
    `globalThis.addEventListener("message", (event) => {`,
    `  const message = __cottontailDecodeWorkerMessage(event.data);`,
    `  if (__cottontailDispatchWorkerPortMessage(message)) return;`,
    `  for (const handler of [...__cottontailParentPortHandlers]) handler(message);`,
    `});`,
    `globalThis.parentPort = {`,
    `  on(name, handler) { if (String(name) === "message" && typeof handler === "function") __cottontailParentPortHandlers.add(handler); return this; },`,
    `  once(name, handler) { const wrapped = (value) => { __cottontailParentPortHandlers.delete(wrapped); handler(value); }; return this.on(name, wrapped); },`,
    `  off(name, handler) { if (String(name) === "message") __cottontailParentPortHandlers.delete(handler); return this; },`,
    `  postMessage(value) { cottontail.workerPostMessage(__cottontailEncodeWorkerMessage(value)); },`,
    `  close() {}, ref() { return this; }, unref() { return this; }`,
    `};`,
    `const __cottontailWorkerEnvironmentDataMap = new Map(globalThis.__cottontailEnvironmentData ?? []);`,
    `function __cottontailWorkerThreadsBuiltin(){ return {`,
    `  BroadcastChannel: globalThis.BroadcastChannel, MessageChannel: globalThis.MessageChannel, MessagePort: globalThis.MessagePort,`,
    `  SHARE_ENV: Symbol.for("nodejs.worker_threads.SHARE_ENV"), Worker: globalThis.Worker,`,
    `  getEnvironmentData: (key) => __cottontailWorkerEnvironmentDataMap.get(key),`,
    `  setEnvironmentData: (key, value) => { __cottontailWorkerEnvironmentDataMap.set(key, value); },`,
    `  isInternalThread: false, isMainThread: false, isMarkedAsUntransferable: () => false,`,
    `  locks: { async request(_name, options, callback){ if (typeof options === "function") callback = options; return callback ? callback({ name: String(_name), mode: "exclusive" }) : undefined; }, async query(){ return { held: [], pending: [] }; } },`,
    `  markAsUncloneable: () => {}, markAsUntransferable: () => {}, moveMessagePortToContext: (port) => port,`,
    `  parentPort: globalThis.parentPort, postMessageToThread: async () => false, receiveMessageOnPort: () => undefined,`,
    `  resourceLimits: globalThis.__cottontailWorkerResourceLimits, threadId: Number(cottontail.workerThreadId?.() ?? 1), threadName: globalThis.__cottontailWorkerThreadName, workerData: globalThis.__cottontailWorkerData`,
    `}; }`,
    `function __cottontailWorkerAsyncHooksBuiltin(){ return { createHook(callbacks = {}) { return { enable(){ return this; }, disable(){ return this; }, callbacks }; }, executionAsyncId: () => 0, triggerAsyncId: () => 0, executionAsyncResource: () => ({}), AsyncResource: class AsyncResource { constructor(type){ this.type = String(type); this.id = 0; } asyncId(){ return this.id; } triggerAsyncId(){ return 0; } runInAsyncScope(fn, thisArg, ...args){ return fn.apply(thisArg, args); } emitDestroy(){} bind(fn, thisArg){ return (...args) => this.runInAsyncScope(fn, thisArg, ...args); } } }; }`,
    `function __cottontailWorkerRequire(specifier){`,
    `  const text = String(specifier);`,
    `  if (text === "node:worker_threads" || text === "worker_threads") return __cottontailWorkerThreadsBuiltin();`,
    `  if (text === "node:async_hooks" || text === "async_hooks") return __cottontailWorkerAsyncHooksBuiltin();`,
    `  throw new Error("Cannot find module '" + text + "'");`,
    `}`,
    `globalThis.require = __cottontailWorkerRequire;`,
    `function __cottontailRewriteWorkerNamedImports(spec){ return spec.split(",").map((part) => { const trimmed = part.trim(); if (!trimmed) return ""; const pieces = trimmed.split(/\\s+as\\s+/); return pieces.length === 2 ? pieces[0].trim() + ": " + pieces[1].trim() : trimmed; }).filter(Boolean).join(", "); }`,
    `function __cottontailTransformWorkerSource(source, filename){`,
    `  const dir = String(filename).replace(/\\/[^/]*$/, "") || ".";`,
    `  const fileUrl = "file://" + String(filename);`,
    `  let out = String(source);`,
    `  out = out.replace(/import\\.meta\\.dirname/g, JSON.stringify(dir)).replace(/import\\.meta\\.dir/g, JSON.stringify(dir)).replace(/import\\.meta\\.filename/g, JSON.stringify(filename)).replace(/import\\.meta\\.path/g, JSON.stringify(filename)).replace(/import\\.meta\\.url/g, JSON.stringify(fileUrl)).replace(/import\\.meta\\.main/g, "false");`,
    `  out = out.replace(/^\\s*import\\s+\\{([^}]*)\\}\\s+from\\s+(['"])([^'"]+)\\2\\s*;?\\s*$/mg, (_all, names, _quote, specifier) => "const { " + __cottontailRewriteWorkerNamedImports(names) + " } = __cottontailWorkerRequire(" + JSON.stringify(specifier) + ");");`,
    `  out = out.replace(/^\\s*import\\s+\\*\\s+as\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+(['"])([^'"]+)\\2\\s*;?\\s*$/mg, (_all, name, _quote, specifier) => "const " + name + " = __cottontailWorkerRequire(" + JSON.stringify(specifier) + ");");`,
    `  out = out.replace(/^\\s*import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+(['"])([^'"]+)\\2\\s*;?\\s*$/mg, (_all, name, _quote, specifier) => "const __module_" + name + " = __cottontailWorkerRequire(" + JSON.stringify(specifier) + "); const " + name + " = __module_" + name + ".default ?? __module_" + name + ";");`,
    `  out = out.replace(/^\\s*import\\s+(['"])([^'"]+)\\1\\s*;?\\s*$/mg, (_all, _quote, specifier) => "__cottontailWorkerRequire(" + JSON.stringify(specifier) + ");");`,
    `  out = out.replace(/^\\s*export\\s+\\{[^}]*\\}\\s*;?\\s*$/mg, "");`,
    `  return out;`,
    `}`,
    `async function __cottontailRunWorkerTarget(filename){`,
    `  const source = __cottontailTransformWorkerSource(cottontail.readFile(filename), filename);`,
    `  const AsyncFunction = (async function(){}).constructor;`,
    `  const run = new AsyncFunction("__cottontailWorkerRequire", source + "\\n//# sourceURL=" + filename);`,
    `  try { await run(__cottontailWorkerRequire); } catch (error) { if (error !== __cottontailWorkerExitSentinel) throw error; }`,
    `}`,
    `await __cottontailRunWorkerTarget(${JSON.stringify(targetPath)});`,
  ].join("\n");
  cottontail.writeFile(wrapperPath, source);
  if (cacheKey != null) workerWrapperCache.set(cacheKey, wrapperPath);
  return wrapperPath;
}

class NullWritable extends Writable {
  write(_chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") callback = encoding;
    callback?.();
    return true;
  }
}

export class Worker extends EventEmitter {
  constructor(filename, options = {}) {
    super();
    const target = normalizeWorkerPath(filename, options.eval === true);
    const wrapper = makeWorkerWrapper(target, options);
    this.threadId = 0;
    this.threadName = options.name ?? "";
    this.resourceLimits = { ...(options.resourceLimits ?? {}) };
    this.stdin = options.stdin ? new NullWritable() : null;
    this.stdout = new Readable();
    this.stderr = new Readable();
    this._worker = new globalThis.Worker(wrapper);
    this.threadId = this._worker.id ?? this._worker.handle?.id ?? 0;
    workerInstances.set(this.threadId, this);
    this._worker.onmessage = (event) => {
      const message = decodeWireMessage(event.data);
      if (dispatchTransferredPortMessage(message)) return;
      this.emit("message", message);
    };
    this._worker.onerror = (event) => this.emit("error", event?.error ?? new Error(String(event?.message ?? event)));
    this._worker.addEventListener?.("exit", (event) => {
      workerInstances.delete(this.threadId);
      this.emit("exit", Number(event?.code ?? 0));
    });
    queueMicrotask(() => this.emit("online"));
  }

  postMessage(value, transferList = undefined) {
    if (this.threadId > 0 && typeof cottontail.workerPostMessageTo === "function") {
      cottontail.workerPostMessageTo(this.threadId, encodeWireMessage(value, transferList, { threadId: this.threadId }));
      return;
    }
    this._worker.postMessage(JSON.parse(encodeWireMessage(value, transferList, { threadId: this.threadId })));
  }

  terminate() {
    this._worker.terminate();
    workerInstances.delete(this.threadId);
    this.emit("exit", 0);
    return Promise.resolve(0);
  }

  ref() { return this; }
  unref() { return this; }

  getHeapStatistics() {
    return Promise.resolve(globalThis.process?.memoryUsage?.() ?? {});
  }

  getHeapSnapshot() {
    return Promise.resolve(Readable.from(["{}"]));
  }

  cpuUsage() {
    return Promise.resolve(globalThis.process?.cpuUsage?.() ?? { user: 0, system: 0 });
  }

  startCpuProfile() {
    return Promise.resolve({ stop: () => Promise.resolve({}) });
  }

  startHeapProfile() {
    return Promise.resolve({ stop: () => Promise.resolve({}) });
  }
}

export class MessagePort extends EventEmitter {
  constructor() {
    super();
    this._id = nextPortId++;
    this._queue = [];
    this._closed = false;
    this._started = false;
    this._peer = null;
    this._remote = null;
    this._transferred = false;
    this.onmessage = null;
    this.onmessageerror = null;
    this._ref = true;
  }

  postMessage(value, transferList = undefined) {
    if (this._closed) return;
    const remote = this._remote ?? this._peer?._remote;
    if (remote?.threadId > 0 && typeof cottontail.workerPostMessageTo === "function") {
      cottontail.workerPostMessageTo(remote.threadId, encodeWireMessage(makePortMessage(remote.portId, value), transferList));
      return;
    }
    if (!this._peer || this._peer._closed) return;
    this._peer._queue.push(cloneForMessage(value, transferList));
    this._peer._dispatch();
  }

  start() {
    this._started = true;
    this._dispatch();
  }

  close() {
    this._closed = true;
    this.emit("close");
  }

  ref() { this._ref = true; return this; }
  unref() { this._ref = false; return this; }
  hasRef() { return this._ref; }

  _dispatch() {
    if (!this._started && typeof this.onmessage !== "function" && this.listenerCount("message") === 0) return;
    while (this._queue.length > 0) {
      const value = this._queue.shift();
      const event = { data: value };
      if (typeof this.onmessage === "function") this.onmessage(event);
      this.emit("message", value);
    }
  }
}

export class MessageChannel {
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    this.port1._peer = this.port2;
    this.port2._peer = this.port1;
  }
}

export class BroadcastChannel extends EventEmitter {
  constructor(name) {
    super();
    this.name = String(name);
    this.onmessage = null;
    this.onmessageerror = null;
    this._closed = false;
    const channels = broadcastChannels.get(this.name) ?? new Set();
    channels.add(this);
    broadcastChannels.set(this.name, channels);
  }

  postMessage(value) {
    for (const channel of broadcastChannels.get(this.name) ?? []) {
      if (channel === this || channel._closed) continue;
      const cloned = cloneForMessage(value);
      queueMicrotask(() => {
        const event = { data: cloned };
        channel.onmessage?.(event);
        channel.emit("message", event);
      });
    }
  }

  close() {
    this._closed = true;
    broadcastChannels.get(this.name)?.delete(this);
  }

  ref() { return this; }
  unref() { return this; }
}

export const parentPort = isMainThread ? null : new class ParentPort extends EventEmitter {
  constructor() {
    super();
    globalThis.addEventListener?.("message", (event) => this.emit("message", decodeWireMessage(event.data)));
  }

  postMessage(value, transferList = undefined) {
    validateTransferList(transferList);
    if (typeof cottontail.workerPostMessage === "function") cottontail.workerPostMessage(encodeWireMessage(value, transferList));
    else globalThis.postMessage?.(value);
  }

  close() {}
  ref() { return this; }
  unref() { return this; }
}();

if (!isMainThread) {
  globalThis.parentPort ??= parentPort;
  globalThis.workerData ??= workerData;
}

export function setEnvironmentData(key, value) {
  environmentData.set(key, value);
}

export function getEnvironmentData(key) {
  return environmentData.get(key);
}

export function markAsUntransferable(object) {
  if (object && typeof object === "object") markedUntransferable.add(object);
}

export function isMarkedAsUntransferable(object) {
  return Boolean(object && typeof object === "object" && markedUntransferable.has(object));
}

export function markAsUncloneable(object) {
  if (object && typeof object === "object") markedUncloneable.add(object);
}

export function moveMessagePortToContext(port, contextifiedSandbox) {
  void contextifiedSandbox;
  return port;
}

export function receiveMessageOnPort(port) {
  if (!port?._queue || port._queue.length === 0) return undefined;
  return { message: port._queue.shift() };
}

export function postMessageToThread(targetThreadId, value, transferList = undefined, timeout = undefined) {
  void timeout;
  const worker = workerInstances.get(Number(targetThreadId));
  if (!worker) return Promise.resolve(false);
  worker.postMessage(value, transferList);
  return Promise.resolve(true);
}

export const locks = {
  async request(name, options = {}, callback = undefined) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const lock = { name: String(name), mode: options.mode ?? "exclusive" };
    return callback ? callback(lock) : undefined;
  },
  async query() {
    return { held: [], pending: [] };
  },
};

export default {
  BroadcastChannel,
  MessageChannel,
  MessagePort,
  SHARE_ENV,
  Worker,
  getEnvironmentData,
  isInternalThread,
  isMainThread,
  isMarkedAsUntransferable,
  locks,
  markAsUncloneable,
  markAsUntransferable,
  moveMessagePortToContext,
  parentPort,
  postMessageToThread,
  receiveMessageOnPort,
  resourceLimits,
  setEnvironmentData,
  threadId,
  threadName,
  workerData,
};
