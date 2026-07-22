import { EventEmitter } from "./events.js";
import { resolve } from "./path.js";
import { Readable, Writable } from "./stream.js";
import { jscHeapSnapshotToV8 } from "./internal/heap_snapshot.js";
import { format as formatValue, inspect as inspectValue } from "./util.js";
import { isContext } from "./vm.js";
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
const environmentData = new Map();
const markedUntransferable = new WeakSet();
const markedUncloneable = new WeakSet();
const crossThreadMessagingStateKey = Symbol.for("cottontail.worker_threads.crossThreadMessagingState");
let crossThreadMessagingState = globalThis[crossThreadMessagingStateKey];
if (!crossThreadMessagingState) {
  crossThreadMessagingState = {
    broadcastChannelBrand: new WeakSet(),
    broadcastChannels: new Map(),
    broadcastChannelIds: new Map(),
    broadcastSubscriptions: new Map(),
    threadMessageRequests: new Map(),
    nextBroadcastChannelId: 1,
    nextThreadMessageRequestId: 1,
  };
  Object.defineProperty(globalThis, crossThreadMessagingStateKey, {
    configurable: true,
    value: crossThreadMessagingState,
  });
}
const broadcastChannelBrand = crossThreadMessagingState.broadcastChannelBrand;
const workerInstances = new Map();
const broadcastChannels = crossThreadMessagingState.broadcastChannels;
const broadcastChannelIds = crossThreadMessagingState.broadcastChannelIds;
const broadcastSubscriptions = crossThreadMessagingState.broadcastSubscriptions;
const threadMessageRequests = crossThreadMessagingState.threadMessageRequests;
const transferredPortPeers = new Map();
const transferredPortRoutes = new Map();
const transferredPortTargets = new Map();
const receivedMessagePorts = new Map();
const referencedMessagePorts = new Set();
const sharedEnvironmentGroups = new Map();
const portMessageEnvelopeKey = "__cottontailWorkerThreadsPortMessage";
const workerControlEnvelopeKey = "__cottontailWorkerThreadsControl";
const messagePortBrand = Symbol.for("cottontail.worker_threads.MessagePort");
const createMessagePortToken = {};
let nextPortId = 1;
let nextWorkerControlRequestId = 1;
let nextSharedEnvironmentGroupId = 1;
let activeSharedEnvironmentGroupId = null;
let sharedEnvironmentProxyInstalled = false;
let applyingSharedEnvironmentUpdate = false;
const inheritedUncaughtExceptionListeners = new Set(globalThis.process?.listeners?.("uncaughtException") ?? []);
let workerUserCaptureCallbackInstalled = false;
const workerRuntimeCacheId = String(globalThis.__cottontailWorkerRuntimeCacheId ??
  `${globalThis.process?.pid ?? 0}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`);
Object.defineProperty(globalThis, "__cottontailWorkerRuntimeCacheId", {
  configurable: true,
  value: workerRuntimeCacheId,
  writable: true,
});

export const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");
export const isMainThread = !cottontail.isWorker?.();
export const isInternalThread = false;
export const threadId = isMainThread ? 0 : Number(cottontail.workerThreadId?.() ?? 1);
export let threadName = isMainThread ? "" : "";
export let workerData = null;
export let resourceLimits = {};

const workerNativeTimerKinds = new Map();
const nativeWorkerTimerClear = !isMainThread && typeof cottontail.timerClear === "function"
  ? cottontail.timerClear
  : null;

if (!isMainThread && typeof cottontail.timerSchedule === "function") {
  const nativeTimerSchedule = cottontail.timerSchedule;
  cottontail.timerSchedule = function timerSchedule(handle, id, delay, repeat, kind, referenced) {
    const timerId = nativeTimerSchedule(handle, id, delay, repeat, kind, referenced);
    workerNativeTimerKinds.set(Number(timerId), Number(kind) || 0);
    return timerId;
  };
}

function clearWorkerNativeTimers() {
  if (nativeWorkerTimerClear === null) return;
  for (const [timerId, kind] of workerNativeTimerKinds) {
    nativeWorkerTimerClear(timerId, kind === 2 ? 2 : 0);
  }
  workerNativeTimerKinds.clear();
}

if (!isMainThread && typeof globalThis.process?.setUncaughtExceptionCaptureCallback === "function") {
  const setCaptureCallback = globalThis.process.setUncaughtExceptionCaptureCallback;
  if (globalThis.process.hasUncaughtExceptionCaptureCallback?.()) {
    setCaptureCallback.call(globalThis.process, null);
  }
  globalThis.process.setUncaughtExceptionCaptureCallback = function setUncaughtExceptionCaptureCallback(callback) {
    const result = setCaptureCallback.call(this, callback);
    workerUserCaptureCallbackInstalled = typeof callback === "function";
    return result;
  };
}

function dataCloneError(message) {
  if (typeof globalThis.DOMException === "function") {
    return new globalThis.DOMException(String(message), "DataCloneError");
  }
  const error = new Error(String(message));
  error.name = "DataCloneError";
  return error;
}

function bytesFromBuffer(buffer) {
  if (isDetachedArrayBuffer(buffer)) throw dataCloneError("ArrayBuffer is detached");
  return Array.from(new Uint8Array(buffer));
}

function viewName(value) {
  if (globalThis.Buffer?.isBuffer?.(value)) return "Buffer";
  if (value instanceof DataView) return "DataView";
  return value?.constructor?.name ?? "Uint8Array";
}

function sharedBufferInfo(value) {
  const buffer = ArrayBuffer.isView(value) ? value.buffer : value;
  if (typeof globalThis.SharedArrayBuffer !== "function" ||
      !(buffer instanceof globalThis.SharedArrayBuffer)) return null;
  try {
    const info = cottontail.sharedArrayBufferInfo?.(buffer);
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
  if (transferList && typeof transferList === "object" &&
      typeof transferList[Symbol.iterator] !== "function" &&
      Object.prototype.hasOwnProperty.call(transferList, "transfer")) {
    transferList = transferList.transfer;
  }
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
    if (item instanceof ArrayBuffer && isDetachedArrayBuffer(item)) throw dataCloneError("ArrayBuffer is detached");
  }
  return transfers;
}

function isDetachedArrayBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || sharedBufferInfo(buffer)) return false;
  try {
    new Uint8Array(buffer);
    return false;
  } catch {
    return true;
  }
}

function detachArrayBufferForTransfer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || sharedBufferInfo(buffer) || isDetachedArrayBuffer(buffer)) return;
  if (typeof buffer.transfer === "function") {
    const transferred = buffer.transfer();
    void transferred;
    if (isDetachedArrayBuffer(buffer)) return;
  }
  if (typeof globalThis.structuredClone !== "function") {
    throw nativeBoundaryError("worker_threads ArrayBuffer transfer");
  }
  const cloned = globalThis.structuredClone(buffer, { transfer: [buffer] });
  void cloned;
  if (!isDetachedArrayBuffer(buffer)) {
    throw nativeBoundaryError("worker_threads ArrayBuffer transfer");
  }
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
  if (typeof value === "function" || typeof value === "symbol") {
    throw dataCloneError(`${String(value)} could not be cloned.`);
  }
  if (markedUncloneable.has(value)) throw dataCloneError("Object is marked as uncloneable");
  const existingId = state.ids.get(value);
  if (existingId != null) return { t: "Ref", id: existingId };
  if (value instanceof MessagePort) {
    if (!state.transfers?.has(value)) {
      throw dataCloneError("Object that needs transfer was found in message but not listed in transferList");
    }
    if (value._closed) throw dataCloneError("MessagePort is closed");
    const id = state.nextId++;
    state.ids.set(value, id);
    const remoteEndpointThreadId = value._remoteEndpointThreadId ?? value._remote?.threadId ?? threadId;
    if (value._peer) transferredPortPeers.set(value._id, value._peer);
    else if (value._remote) transferredPortRoutes.set(value._id, value._remote);
    if (state.transferContext?.threadId >= 0) {
      value._remote = { threadId: state.transferContext.threadId, portId: value._id };
      transferredPortTargets.set(value._id, value._remote);
    }
    value._transferred = true;
    value._closed = true;
    value._syncRefHandle();
    queueMicrotask(() => value.emit("close"));
    return { t: "MessagePort", id, portId: value._id, sourceThreadId: threadId, remoteEndpointThreadId };
  }
  const id = state.nextId++;
  state.ids.set(value, id);

  if (value instanceof Boolean) return { t: "Boxed", id, name: "Boolean", v: Boolean(value.valueOf()) };
  if (value instanceof Number) return { t: "Boxed", id, name: "Number", v: encodeClone(value.valueOf()) };
  if (value instanceof String) return { t: "Boxed", id, name: "String", v: String(value.valueOf()) };
  if (value instanceof Date) return { t: "Date", id, v: value.toISOString() };
  if (value instanceof RegExp) return { t: "RegExp", id, source: value.source, flags: value.flags };
  const shared = !ArrayBuffer.isView(value) ? sharedBufferInfo(value) : null;
  if (shared) return { t: "SharedArrayBuffer", id, sharedId: shared.id, byteLength: shared.byteLength };
  if (value instanceof ArrayBuffer) {
    return { t: "ArrayBuffer", id, bytes: bytesFromBuffer(value) };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      t: "View",
      id,
      name: viewName(value),
      buffer: encodeClone(value.buffer, state),
      byteOffset: value.byteOffset,
      length: value instanceof DataView ? value.byteLength : value.length,
    };
  }
  if (value instanceof Map) return { t: "Map", id, v: [...value].map(([key, item]) => [encodeClone(key, state), encodeClone(item, state)]) };
  if (value instanceof Set) return { t: "Set", id, v: [...value].map((item) => encodeClone(item, state)) };
  if (Array.isArray(value)) {
    return {
      t: "Array",
      id,
      length: value.length,
      v: Object.keys(value).map((key) => [key, encodeClone(value[key], state)]),
    };
  }
  if (value instanceof Error) {
    const encoded = { t: "Error", id, name: value.name, message: value.message, stack: value.stack };
    if (Object.prototype.hasOwnProperty.call(value, "cause")) encoded.cause = encodeClone(value.cause, state);
    if (typeof AggregateError === "function" && value instanceof AggregateError) {
      encoded.errors = encodeClone(Array.from(value.errors ?? []), state);
    }
    return encoded;
  }
  return { t: "Object", id, v: Object.entries(value).map(([key, item]) => [key, encodeClone(item, state)]) };
}

function remember(refs, encoded, value) {
  if (encoded?.id != null) refs.set(encoded.id, value);
  return value;
}

function decodeClone(encoded, refs = new Map(), context = undefined) {
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
    case "Boxed": {
      const primitive = encoded.name === "Number" ? decodeClone(encoded.v, refs, context) : encoded.v;
      const Constructor = encoded.name === "Boolean" ? Boolean : encoded.name === "Number" ? Number : String;
      return remember(refs, encoded, new Constructor(primitive));
    }
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
      const buffer = encoded.buffer ? decodeClone(encoded.buffer, refs, context) : new Uint8Array(encoded.bytes ?? []).buffer;
      const byteOffset = Number(encoded.byteOffset ?? 0);
      if (encoded.name === "Buffer") {
        const view = new Uint8Array(buffer, byteOffset, Number(encoded.length ?? buffer.byteLength));
        return remember(refs, encoded, globalThis.Buffer?.from ? globalThis.Buffer.from(view.buffer, view.byteOffset, view.byteLength) : view);
      }
      if (encoded.name === "DataView") return remember(refs, encoded, new DataView(buffer, byteOffset, encoded.length ?? undefined));
      const Constructor = typedArrayConstructors[encoded.name] ?? Uint8Array;
      return remember(refs, encoded, new Constructor(buffer, byteOffset, encoded.length ?? undefined));
    }
    case "MessagePort": {
      const port = remember(refs, encoded, new MessagePort(createMessagePortToken));
      port._id = String(encoded.portId ?? port._id);
      const sourceThreadId = Number(encoded.sourceThreadId ?? (isMainThread ? -1 : 0));
      const remoteEndpointThreadId = Number(encoded.remoteEndpointThreadId ?? sourceThreadId);
      port._remoteEndpointThreadId = remoteEndpointThreadId;
      if (sourceThreadId === threadId) {
        const peer = transferredPortPeers.get(port._id);
        if (peer) {
          transferredPortPeers.delete(port._id);
          port._peer = peer;
          peer._peer = port;
        }
      } else if (sourceThreadId >= 0) {
        const transportSourceThreadId = Number(context?.transportSourceThreadId);
        const routeThreadId = remoteEndpointThreadId > 0
          ? remoteEndpointThreadId
          : Number.isInteger(transportSourceThreadId) ? transportSourceThreadId : sourceThreadId;
        port._remote = { threadId: routeThreadId, portId: port._id };
        receivedMessagePorts.set(port._id, port);
      }
      return port;
    }
    case "Map": {
      const map = remember(refs, encoded, new Map());
      for (const [key, value] of encoded.v ?? []) map.set(decodeClone(key, refs, context), decodeClone(value, refs, context));
      return map;
    }
    case "Set": {
      const set = remember(refs, encoded, new Set());
      for (const value of encoded.v ?? []) set.add(decodeClone(value, refs, context));
      return set;
    }
    case "Array": {
      const entries = encoded.v ?? [];
      const legacy = entries.length > 0 && !Array.isArray(entries[0]);
      const array = remember(refs, encoded, new Array(Number(encoded.length ?? (legacy ? entries.length : 0))));
      if (legacy) {
        for (let index = 0; index < entries.length; index += 1) array[index] = decodeClone(entries[index], refs, context);
      } else {
        for (const [key, value] of entries) array[key] = decodeClone(value, refs, context);
      }
      return array;
    }
    case "Error": {
      const Constructor = typeof globalThis[encoded.name] === "function" && globalThis[encoded.name].prototype instanceof Error
        ? globalThis[encoded.name]
        : Error;
      const error = encoded.name === "AggregateError" && typeof globalThis.AggregateError === "function"
        ? new AggregateError([], encoded.message)
        : new Constructor(encoded.message);
      error.name = encoded.name;
      error.stack = encoded.stack;
      remember(refs, encoded, error);
      if (encoded.cause) error.cause = decodeClone(encoded.cause, refs, context);
      if (encoded.errors) error.errors = decodeClone(encoded.errors, refs, context);
      return error;
    }
    case "Object": {
      const object = remember(refs, encoded, {});
      for (const [key, value] of encoded.v ?? []) object[key] = decodeClone(value, refs, context);
      return object;
    }
    default: throw dataCloneError("Invalid cloned worker payload");
  }
}

function encodeWireMessage(value, transferList = undefined, transferContext = undefined) {
  const transfers = validateTransferList(transferList);
  const state = {
    ids: new WeakMap(),
    nextId: 1,
    transfers: new Set(transfers),
    transferContext,
  };
  const encodedValue = encodeClone(value, state);
  const encodedPorts = transfers
    .filter(item => item instanceof MessagePort)
    .map(port => encodeClone(port, state));
  for (const item of transfers) detachArrayBufferForTransfer(item);
  return JSON.stringify({ cottontailWorkerClone: wireVersion, value: encodedValue, ports: encodedPorts });
}

function decodeWirePayload(payload, context = undefined) {
  const refs = new Map();
  const decoded = decodeClone(payload.value, refs, context);
  const ports = (payload.ports ?? []).map(port => decodeClone(port, refs, context));
  if (context) context.transferredPorts = ports;
  return decoded;
}

function decodeWireMessage(value, context = undefined) {
  if (value && typeof value === "object" && value.cottontailWorkerClone === wireVersion) {
    return decodeWirePayload(value, context);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed?.cottontailWorkerClone === wireVersion) return decodeWirePayload(parsed, context);
      return parsed;
    } catch {}
  }
  return value;
}

function cloneForMessage(value, transferList = undefined, context = undefined) {
  return decodeWireMessage(encodeWireMessage(value, transferList, { threadId }), context);
}

function makePortMessage(portId, valueWire = undefined, type = "message", destinationThreadId = undefined) {
  return {
    [portMessageEnvelopeKey]: {
      portId,
      valueWire,
      type,
      sourceThreadId: threadId,
      destinationThreadId,
    },
  };
}

function forwardPortMessage(remote, message) {
  if (!remote) return false;
  const packet = message?.[portMessageEnvelopeKey];
  const routed = packet
    ? {
        ...message,
        [portMessageEnvelopeKey]: {
          ...packet,
          sourceThreadId: threadId,
          destinationThreadId: remote.threadId,
        },
      }
    : message;
  const encoded = encodeWireMessage(routed);
  if (remote.threadId > 0 && typeof cottontail.workerPostMessageTo === "function") {
    cottontail.workerPostMessageTo(remote.threadId, encoded);
    return true;
  }
  if (remote.threadId === 0 && !isMainThread && typeof cottontail.workerPostMessage === "function") {
    cottontail.workerPostMessage(encoded);
    return true;
  }
  return false;
}

function deliverPortPacket(port, packet) {
  if (!port || port._closed) return false;
  if (packet.type === "close") {
    port._closeLocal();
    return true;
  }
  try {
    const context = { transportSourceThreadId: packet.sourceThreadId };
    const value = decodeWireMessage(packet.valueWire, context);
    port._queue.push({ value, ports: context.transferredPorts ?? [] });
    port._scheduleDispatch?.();
  } catch (error) {
    port._emitMessageError(error);
  }
  return true;
}

function dispatchTransferredPortMessage(message) {
  const packet = message?.[portMessageEnvelopeKey];
  if (!packet || packet.portId == null) return false;
  const portId = String(packet.portId);
  const peer = transferredPortPeers.get(portId);
  if (deliverPortPacket(peer, packet)) return true;
  const destinationThreadId = Number(packet.destinationThreadId);
  if (Number.isInteger(destinationThreadId) && destinationThreadId >= 0 && destinationThreadId !== threadId) {
    return forwardPortMessage({ threadId: destinationThreadId, portId }, message) || true;
  }
  const target = transferredPortTargets.get(portId);
  const route = transferredPortRoutes.get(portId);
  const next = target && Number(packet.sourceThreadId) === target.threadId ? route : target ?? route;
  forwardPortMessage(next, message);
  return true;
}

function dispatchReceivedPortMessage(message) {
  const packet = message?.[portMessageEnvelopeKey];
  if (!packet || packet.portId == null) return false;
  const portId = String(packet.portId);
  const port = receivedMessagePorts.get(portId);
  if (deliverPortPacket(port, packet)) return true;
  const destinationThreadId = Number(packet.destinationThreadId);
  if (Number.isInteger(destinationThreadId) && destinationThreadId >= 0 && destinationThreadId !== threadId) {
    return forwardPortMessage({ threadId: destinationThreadId, portId }, message) || true;
  }
  const target = transferredPortTargets.get(portId);
  const route = transferredPortRoutes.get(portId);
  const next = target && Number(packet.sourceThreadId) === target.threadId ? route : target ?? route;
  forwardPortMessage(next, message);
  return true;
}

function workerTempDir() {
  const configured = cottontail.env?.()?.COTTONTAIL_TMP_DIR;
  return configured ? `${configured}/workers` : `${cottontail.cwd()}/.cottontail-tmp`;
}

function workerEvalFilename() {
  return `${String(cottontail.cwd()).replace(/\\/g, "/")}/[worker eval]`;
}

function workerFileKind(path, options) {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".cjs") || lowerPath.endsWith(".cts")) return "commonjs";
  if (lowerPath.endsWith(".mjs") || lowerPath.endsWith(".mts")) return "module";
  if (options.type === "commonjs" || options.type === "module") return options.type;

  if (typeof cottontail.readFile === "function" && typeof cottontail.transpilerScan === "function") {
    try {
      const extension = lowerPath.slice(lowerPath.lastIndexOf(".") + 1);
      const loader = ["js", "jsx", "ts", "tsx"].includes(extension) ? extension : "js";
      const source = cottontail.readFile(path);
      const scan = JSON.parse(cottontail.transpilerScan(String(source), "{}", loader));
      if (scan.exports?.length > 0 || scan.imports?.some(item => item.kind === "import-statement")) {
        return "module";
      }
      if (scan.imports?.some(item => item.kind === "require-call")) return "commonjs";
    } catch {}
  }

  return "commonjs";
}

function normalizeWorkerInput(filename, options) {
  if (options.eval === true) {
    if (typeof filename !== "string") throw invalidArgumentType("filename", "string", filename);
    return { kind: "eval", source: filename, filename: workerEvalFilename() };
  }

  if (typeof filename !== "string" && !(filename instanceof URL)) {
    throw invalidArgumentType("filename", "string or an instance of URL", filename);
  }
  let text = String(filename);
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(text) && !text.startsWith("file:") && !text.startsWith("data:")) {
    const url = new URL(text);
    const error = new TypeError(`The URL must be of scheme file. Received protocol '${url.protocol}'`);
    error.code = "ERR_INVALID_URL_SCHEME";
    throw error;
  }
  if (text.startsWith("file:")) {
    const url = new URL(text);
    if (url.protocol !== "file:") {
      const error = new TypeError(`The URL must be of scheme file. Received protocol '${url.protocol}'`);
      error.code = "ERR_INVALID_URL_SCHEME";
      throw error;
    }
    text = decodeURIComponent(url.pathname);
  }
  if (text.startsWith("data:")) return { kind: "module", specifier: text, filename: text };
  const path = resolve(text);
  return {
    kind: workerFileKind(path, options),
    specifier: path.replace(/\\/g, "/"),
    filename: path,
  };
}

function normalizeWorkerOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw invalidArgumentType("options", "object", options);
  }
  if (options.execArgv && !Array.isArray(options.execArgv)) {
    throw invalidArgumentType("options.execArgv", "an instance of Array", options.execArgv);
  }
  if (options.argv != null && !Array.isArray(options.argv)) {
    throw invalidArgumentType("options.argv", "an instance of Array", options.argv);
  }
  if (options.env != null && options.env !== SHARE_ENV && typeof options.env !== "object") {
    throw invalidArgumentType("options.env", "object", options.env);
  }
  if (options.resourceLimits != null &&
      (typeof options.resourceLimits !== "object" || Array.isArray(options.resourceLimits))) {
    throw invalidArgumentType("options.resourceLimits", "object", options.resourceLimits);
  }
  return options;
}

function workerHeapLimitBytes(limits) {
  const oldGeneration = typeof limits?.maxOldGenerationSizeMb === "number"
    ? limits.maxOldGenerationSizeMb
    : 0;
  const youngGeneration = typeof limits?.maxYoungGenerationSizeMb === "number"
    ? limits.maxYoungGenerationSizeMb
    : 0;
  const oldSize = Number.isFinite(oldGeneration) && oldGeneration > 0 ? oldGeneration : 0;
  const youngSize = Number.isFinite(youngGeneration) && youngGeneration > 0 ? youngGeneration : 0;
  const megabytes = oldSize > 0 && youngSize > 0 ? oldSize + youngSize : oldSize || youngSize;
  if (megabytes === 0) return undefined;
  const bytes = megabytes * 1024 * 1024;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

function workerStackSizeBytes(limits) {
  const megabytes = typeof limits?.stackSizeMb === "number" ? limits.stackSizeMb : 0;
  if (!Number.isFinite(megabytes) || megabytes <= 0) return undefined;
  const bytes = megabytes * 1024 * 1024;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

function stringEnvironment(source) {
  const result = {};
  for (const key of Object.keys(source ?? {})) {
    const value = source[key];
    if (value !== undefined) result[key] = String(value);
  }
  return result;
}

function sharedEnvironmentGroup(groupId) {
  const id = String(groupId);
  let group = sharedEnvironmentGroups.get(id);
  if (!group) {
    group = { members: new Set() };
    sharedEnvironmentGroups.set(id, group);
  }
  return group;
}

function applySharedEnvironmentUpdate(key, value, deleted) {
  if (!globalThis.process?.env) return;
  applyingSharedEnvironmentUpdate = true;
  try {
    if (deleted) delete globalThis.process.env[key];
    else globalThis.process.env[key] = value;
  } finally {
    applyingSharedEnvironmentUpdate = false;
  }
}

function brokerSharedEnvironmentUpdate(control) {
  if (!isMainThread) return;
  const groupId = String(control.groupId);
  const group = sharedEnvironmentGroups.get(groupId);
  if (!group) return;
  const sourceThreadId = Number(control.sourceThreadId);
  for (const targetThreadId of group.members) {
    if (targetThreadId === sourceThreadId) continue;
    if (targetThreadId === 0) {
      applySharedEnvironmentUpdate(String(control.key), control.value, control.deleted === true);
      continue;
    }
    try {
      sendControlToThread(targetThreadId, {
        type: "sharedEnvironmentUpdate",
        groupId,
        sourceThreadId,
        key: String(control.key),
        value: control.value,
        deleted: control.deleted === true,
      });
    } catch {
      group.members.delete(targetThreadId);
    }
  }
}

function publishSharedEnvironmentUpdate(key, value, deleted = false) {
  if (activeSharedEnvironmentGroupId === null || applyingSharedEnvironmentUpdate) return;
  const control = {
    type: "sharedEnvironmentUpdate",
    groupId: activeSharedEnvironmentGroupId,
    sourceThreadId: threadId,
    key: String(key),
    value,
    deleted,
  };
  if (isMainThread) brokerSharedEnvironmentUpdate(control);
  else sendControlToThread(0, control);
}

function installSharedEnvironmentProxy() {
  if (sharedEnvironmentProxyInstalled || !globalThis.process?.env) return;
  const environment = globalThis.process.env;
  const shared = new Proxy(environment, {
    set(target, key, value) {
      const result = Reflect.set(target, key, value, target);
      if (result && typeof key !== "symbol") {
        publishSharedEnvironmentUpdate(key, Reflect.get(target, key, target), false);
      }
      return result;
    },
    defineProperty(target, key, descriptor) {
      const result = Reflect.defineProperty(target, key, descriptor);
      if (result && typeof key !== "symbol") {
        publishSharedEnvironmentUpdate(key, Reflect.get(target, key, target), false);
      }
      return result;
    },
    deleteProperty(target, key) {
      const result = Reflect.deleteProperty(target, key);
      if (result && typeof key !== "symbol") publishSharedEnvironmentUpdate(key, undefined, true);
      return result;
    },
  });
  globalThis.process.env = shared;
  if (globalThis.Bun) globalThis.Bun.env = shared;
  sharedEnvironmentProxyInstalled = true;
}

function activateSharedEnvironment(groupId) {
  if (groupId == null) return null;
  activeSharedEnvironmentGroupId = String(groupId);
  installSharedEnvironmentProxy();
  return activeSharedEnvironmentGroupId;
}

function ensureSharedEnvironmentGroup() {
  if (activeSharedEnvironmentGroupId === null) {
    activateSharedEnvironment(`${threadId}:${nextSharedEnvironmentGroupId++}`);
    if (isMainThread) sharedEnvironmentGroup(activeSharedEnvironmentGroupId).members.add(threadId);
    else sendControlToThread(0, {
      type: "sharedEnvironmentRegister",
      groupId: activeSharedEnvironmentGroupId,
      memberThreadIds: [threadId],
    });
  }
  return activeSharedEnvironmentGroupId;
}

function registerSharedEnvironmentWorker(groupId, workerThreadId) {
  if (groupId == null) return;
  const members = [threadId, Number(workerThreadId)];
  if (isMainThread) {
    const group = sharedEnvironmentGroup(groupId);
    for (const member of members) group.members.add(member);
  } else {
    sendControlToThread(0, {
      type: "sharedEnvironmentRegister",
      groupId: String(groupId),
      memberThreadIds: members,
    });
  }
}

function unregisterSharedEnvironmentWorker(groupId, workerThreadId) {
  if (groupId == null) return;
  if (isMainThread) {
    sharedEnvironmentGroups.get(String(groupId))?.members.delete(Number(workerThreadId));
  } else {
    try {
      sendControlToThread(0, {
        type: "sharedEnvironmentUnregister",
        groupId: String(groupId),
        memberThreadId: Number(workerThreadId),
      });
    } catch {}
  }
}

function workerRunSource(input) {
  if (input.kind === "eval") {
    return [
      `const __ctModuleNamespace = await import("node:module");`,
      `const __ctModule = __ctModuleNamespace.Module ?? __ctModuleNamespace.default;`,
      `const __ctEvalModule = new __ctModule(${JSON.stringify(input.filename)}, null);`,
      `__ctEvalModule.filename = ${JSON.stringify(input.filename)};`,
      `__ctEvalModule.paths = __ctModule._nodeModulePaths?.(${JSON.stringify(cottontail.cwd())}) ?? [];`,
      `let __ctEvalSource = globalThis.__cottontailWorkerEvalSource;`,
      `try {`,
      `  try {`,
      `    __ctEvalModule._compile(__ctEvalSource, ${JSON.stringify(input.filename)});`,
      `  } catch (__ctEvalError) {`,
      `    throw globalThis.__cottontailNormalizeWorkerEvalError?.(__ctEvalError) ?? __ctEvalError;`,
      `  }`,
      `} finally {`,
      `  __ctEvalSource = undefined;`,
      `  try { delete globalThis.__cottontailWorkerEvalSource; } catch { globalThis.__cottontailWorkerEvalSource = undefined; }`,
      `}`,
    ].join("\n");
  }
  if (input.kind === "commonjs") {
    return [
      `const __ctModuleNamespace = await import("node:module");`,
      `const __ctRunMain = __ctModuleNamespace.runMain ?? __ctModuleNamespace.default?.runMain;`,
      `__ctRunMain(${JSON.stringify(input.filename)});`,
    ].join("\n");
  }
  return [
    `const __ctWorkerSpecifier = ${JSON.stringify(input.specifier)};`,
    `await import(__ctWorkerSpecifier);`,
  ].join("\n");
}

function makeWorkerWrapper(input, options = {}, sharedEnvironmentGroupId = null) {
  const workerDataWire = encodeWireMessage(
    Object.prototype.hasOwnProperty.call(options, "workerData") ? options.workerData : undefined,
    options.transferList,
  );
  const environmentDataWire = encodeWireMessage([...environmentData]);
  const resourceLimitsWire = encodeWireMessage(options.resourceLimits ?? {});
  const execArgv = options.execArgv
    ? Array.from(options.execArgv, String)
    : Array.from(globalThis.process?.execArgv ?? [], String);
  const argv = [
    String(globalThis.process?.argv?.[0] ?? globalThis.process?.execPath ?? "cottontail"),
    input.filename,
    ...Array.from(options.argv ?? [], String),
  ];
  const shareEnvironment = options.env === SHARE_ENV;
  const workerEnvironment = stringEnvironment(
    options.env && !shareEnvironment
      ? options.env
      : globalThis.process?.env ?? cottontail.env?.() ?? {},
  );
  const bootstrap = {
    workerDataWire,
    environmentDataWire,
    resourceLimitsWire,
    threadName: String(options.name ?? ""),
    stdin: options.stdin === true,
    stdout: options.stdout === true,
    stderr: options.stderr === true,
    shareEnvironment,
    sharedEnvironmentGroupId,
  };
  const dir = workerTempDir();
  cottontail.mkdirSync?.(dir, true);
  const nonce = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const wrapperPath = `${dir}/worker-thread-${nonce}.mjs`;
  const source = [
    `globalThis.__cottontailWorkerRuntimeCacheId = ${JSON.stringify(workerRuntimeCacheId)};`,
    `globalThis.__cottontailWorkerBootstrap = ${JSON.stringify(bootstrap)};`,
    `if (globalThis.process) {`,
    `  globalThis.process.argv = ${JSON.stringify(argv)};`,
    `  globalThis.process.execArgv = ${JSON.stringify(execArgv)};`,
    `}`,
    `if (globalThis.Bun) globalThis.Bun.argv = ${JSON.stringify(argv)};`,
    `if (globalThis.process) {`,
    `  const __ctWorkerEnv = globalThis.process.env ?? {};`,
    `  for (const __ctKey of Object.keys(__ctWorkerEnv)) delete __ctWorkerEnv[__ctKey];`,
    `  Object.assign(__ctWorkerEnv, ${JSON.stringify(workerEnvironment)});`,
    `  globalThis.process.env = __ctWorkerEnv;`,
    `}`,
    `await import("node:worker_threads");`,
    `globalThis.__cottontailConfigureWorkerStdio?.();`,
    `globalThis.__cottontailWorkerThreadsNotifyReady?.();`,
    `try {`,
    workerRunSource(input),
    `} catch (__ctWorkerError) {`,
    `  globalThis.__cottontailWorkerThreadsReportError?.(__ctWorkerError);`,
    `}`,
  ].join("\n");
  cottontail.writeFile(wrapperPath, source);
  return wrapperPath;
}

function bytesViewForStdio(chunk, encoding = undefined) {
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (globalThis.Buffer?.from) return globalThis.Buffer.from(String(chunk), encoding ?? "utf8");
  return new TextEncoder().encode(String(chunk));
}

function installWorkerStdioFdDispatcher() {
  const listeners = globalThis.__cottontailFdWatchListeners ??= new Map();
  if (!globalThis.__cottontailFdWatchHandlerInstalled && typeof cottontail.fdSetEventHandler === "function") {
    globalThis.__cottontailFdWatchHandlerInstalled = true;
    cottontail.fdSetEventHandler((event) => {
      const connectListener = globalThis.__cottontailTcpConnectListeners?.get?.(Number(event?.id));
      if (typeof connectListener === "function") {
        connectListener(event);
        return;
      }
      const listener = listeners.get(Number(event?.id));
      if (typeof listener === "function") {
        listener(event);
        return;
      }
      const tlsListener = globalThis.__cottontailTlsListeners?.get?.(Number(event?.id));
      if (typeof tlsListener === "function") tlsListener(event);
    });
  }
  return listeners;
}

function workerStdioError(errno, operation = "write") {
  const normalized = Math.abs(Number(errno) || 5);
  const code = normalized === 32 ? "EPIPE"
    : normalized === 9 ? "EBADF"
      : normalized === 22 ? "EINVAL"
        : normalized === 3 ? "ESRCH"
          : "EIO";
  const error = new Error(`${code}: ${operation}`);
  error.errno = -normalized;
  error.code = code;
  error.syscall = operation;
  return error;
}

class ReadableWorkerStdio extends Readable {
  constructor(workerThreadId, streamName, fd, referenced = true) {
    super({ highWaterMark: 64 * 1024 });
    this._workerThreadId = workerThreadId;
    this._streamName = streamName;
    this._nativeFd = fd;
    this._watchId = 0;
    this._watchListener = null;
    this._referenced = referenced;
    this._nativeClosed = false;
  }

  _read() {
    if (this.destroyed || this._nativeClosed) return;
    if (this._watchId) {
      cottontail.fdWatchSetPaused?.(this._watchId, false);
      return;
    }
    const listeners = installWorkerStdioFdDispatcher();
    const watch = cottontail.fdWatchStart?.(
      this._nativeFd,
      Math.max(1, Math.min(this.readableHighWaterMark, 1024 * 1024)),
      this._referenced,
      false,
    );
    this._watchId = Number(watch?.id ?? 0);
    if (!this._watchId) {
      this.destroy(new Error("failed to start worker stdio reader"));
      return;
    }
    const watchId = this._watchId;
    this._watchListener = (event) => {
      if (this.destroyed) return;
      if (event.type === "data") {
        const bytes = new Uint8Array(event.data ?? new ArrayBuffer(0));
        if (bytes.byteLength === 0) return;
        const chunk = globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : bytes;
        if (!this.push(chunk)) cottontail.fdWatchSetPaused?.(watchId, true);
        return;
      }
      if (event.type === "end") {
        this._stopWatcher();
        this._closeNative();
        this.push(null);
        return;
      }
      if (event.type === "error") {
        const error = new Error(String(event.message ?? "worker stdio read failed"));
        if (event.code != null) error.code = String(event.code);
        if (event.errno != null) error.errno = Number(event.errno);
        this.destroy(error);
      }
    };
    listeners.set(watchId, this._watchListener);
  }

  _stopWatcher() {
    const watchId = this._watchId;
    this._watchId = 0;
    this._watchListener = null;
    if (!watchId) return;
    globalThis.__cottontailFdWatchListeners?.delete?.(watchId);
    cottontail.fdWatchStop?.(watchId);
  }

  _closeNative() {
    if (this._nativeClosed) return;
    this._nativeClosed = true;
    cottontail.workerStdioClose?.(this._workerThreadId, this._streamName, "read");
  }

  _destroy(error, callback) {
    this._stopWatcher();
    this._closeNative();
    callback(error);
  }
}

class WritableWorkerStdio extends Writable {
  constructor(workerThreadId, streamName) {
    super({ highWaterMark: 64 * 1024 });
    this._workerThreadId = workerThreadId;
    this._streamName = streamName;
    this._pendingNativeWrite = null;
    this._writeRetryTimer = null;
    this._nativeClosed = false;
  }

  _write(chunk, encoding, callback) {
    this._pendingNativeWrite = {
      bytes: bytesViewForStdio(chunk, encoding),
      offset: 0,
      callback,
    };
    this._flushNativeWrite();
  }

  _flushNativeWrite() {
    const pending = this._pendingNativeWrite;
    if (!pending || this.destroyed) return;
    while (pending.offset < pending.bytes.byteLength) {
      let written;
      try {
        written = Number(cottontail.workerStdioWrite(
          this._workerThreadId,
          this._streamName,
          pending.bytes.subarray(pending.offset),
        ));
      } catch (error) {
        this._completeNativeWrite(error);
        return;
      }
      if (written < 0) {
        this._completeNativeWrite(workerStdioError(-written));
        return;
      }
      if (written === 0) {
        this._writeRetryTimer = setTimeout(() => {
          this._writeRetryTimer = null;
          this._flushNativeWrite();
        }, 1);
        return;
      }
      pending.offset += written;
    }
    this._completeNativeWrite();
  }

  _completeNativeWrite(error = undefined) {
    const pending = this._pendingNativeWrite;
    this._pendingNativeWrite = null;
    if (this._writeRetryTimer != null) clearTimeout(this._writeRetryTimer);
    this._writeRetryTimer = null;
    pending?.callback(error);
  }

  _closeNative() {
    if (this._nativeClosed) return;
    this._nativeClosed = true;
    cottontail.workerStdioClose?.(this._workerThreadId, this._streamName, "write");
  }

  _final(callback) {
    this._closeNative();
    callback();
  }

  _destroy(error, callback) {
    if (this._writeRetryTimer != null) clearTimeout(this._writeRetryTimer);
    this._writeRetryTimer = null;
    const pending = this._pendingNativeWrite;
    this._pendingNativeWrite = null;
    this._closeNative();
    if (pending) queueMicrotask(() => pending.callback(error ?? workerStdioError(32)));
    callback(error);
  }
}

function workerNotRunningError() {
  const error = new Error("Worker instance not running");
  error.code = "ERR_WORKER_NOT_RUNNING";
  return error;
}

function workerMessagingError(code, message, cause = undefined) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

function missingArgumentsError(...names) {
  const quoted = names.map(name => `"${name}"`);
  const expected = quoted.length === 1
    ? `The ${quoted[0]} argument must be specified`
    : `The ${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)} arguments must be specified`;
  const error = new TypeError(expected);
  error.code = "ERR_MISSING_ARGS";
  return error;
}

function invalidThisError(name) {
  const error = new TypeError(`Value of "this" must be of type ${name}`);
  error.code = "ERR_INVALID_THIS";
  return error;
}

function nativeBoundaryError(api) {
  const error = new Error(`${api} requires a native per-worker runtime hook`);
  error.code = "ERR_COTTONTAIL_NATIVE_BOUNDARY";
  return error;
}

function bunNotImplementedError(feature) {
  const error = new Error(`${feature} is not yet implemented in Bun.`);
  error.name = "NotImplementedError";
  error.code = "ERR_NOT_IMPLEMENTED";
  return error;
}

function deserializeWorkerError(payload) {
  const name = typeof payload?.name === "string" ? payload.name : "Error";
  const message = typeof payload?.message === "string" ? payload.message : String(payload ?? "Worker error");
  const Constructor = typeof globalThis[name] === "function" && globalThis[name].prototype instanceof Error
    ? globalThis[name]
    : Error;
  const error = new Constructor(message);
  error.name = name;
  if (payload?.code !== undefined) error.code = payload.code;
  if (typeof payload?.stack === "string") error.stack = payload.stack;
  return error;
}

function invalidArgumentType(name, expected, value) {
  const actual = value === null ? "null" : `type ${typeof value} (${String(value)})`;
  const subject = String(name).includes(".") ? "property" : "argument";
  const error = new TypeError(`The "${name}" ${subject} must be of type ${expected}. Received ${actual}`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

class HeapSnapshotStream extends Readable {
  constructor(payload) {
    super();
    this._payload = payload;
  }

  _read() {
    if (this._payload === null) return;
    const payload = this._payload;
    this._payload = null;
    this.push(payload);
    this.push(null);
  }
}

function eventLoopUtilizationDelta(earlier, later) {
  const idle = Number(later?.idle ?? 0) - Number(earlier?.idle ?? 0);
  const active = Number(later?.active ?? 0) - Number(earlier?.active ?? 0);
  const elapsed = idle + active;
  return { idle, active, utilization: elapsed > 0 ? active / elapsed : 0 };
}

class WorkerPerformance {
  constructor(worker) {
    this._worker = worker;
  }

  eventLoopUtilization(utilization1 = undefined, utilization2 = undefined) {
    if (utilization2 && typeof utilization2 === "object") {
      return eventLoopUtilizationDelta(utilization1, utilization2);
    }
    const current = cottontail.workerPerformance?.(this._worker._nativeThreadId) ?? { idle: 0, active: 0, utilization: 0 };
    return utilization1 && typeof utilization1 === "object"
      ? eventLoopUtilizationDelta(utilization1, current)
      : current;
  }
}

export class Worker extends EventEmitter {
  constructor(filename, options = undefined) {
    super();
    options = normalizeWorkerOptions(options);
    const processObject = globalThis.process;
    const processEmitAtCreation = processObject?.emit;
    const input = normalizeWorkerInput(filename, options);
    const emptyEvalSource = input.kind === "eval" && !/\S/.test(input.source);
    const sharedEnvironmentGroupId = options.env === SHARE_ENV ? ensureSharedEnvironmentGroup() : null;
    const wrapper = makeWorkerWrapper(input, options, sharedEnvironmentGroupId);

    this.threadId = 0;
    this.threadName = String(options.name ?? "");
    this.resourceLimits = { ...(options.resourceLimits ?? {}) };
    this.stdin = null;
    this.stdout = null;
    this.stderr = null;
    this._running = true;
    this._input = input;
    this._emptyEvalSource = emptyEvalSource;
    this._exitEmitted = false;
    this._exitCode = undefined;
    this._reportedExitCode = undefined;
    this._onlineEmitted = false;
    this._refed = true;
    this._controlRequests = new Map();
    this._terminationPromise = null;
    this._terminationResolve = null;
    this._sharedEnvironmentGroupId = sharedEnvironmentGroupId;

    this._worker = new globalThis.Worker(wrapper, {
      [Symbol.for("cottontail.worker.prepared-script")]: true,
      [Symbol.for("cottontail.worker.eval-source")]: input.kind === "eval" ? input.source : undefined,
      [Symbol.for("cottontail.worker.thread-name")]: this.threadName,
      [Symbol.for("cottontail.worker.stack-size")]: workerStackSizeBytes(options.resourceLimits),
      [Symbol.for("cottontail.worker.native-options")]: {
        heapLimit: workerHeapLimitBytes(options.resourceLimits),
        stdin: options.stdin === true,
        stdout: options.stdout === true,
        stderr: options.stderr === true,
      },
    });
    this.threadId = Number(this._worker.id ?? this._worker.handle?.id ?? 0);
    this._nativeThreadId = this.threadId;
    const nativeHandle = this._worker.handle ?? {};
    if (options.stdin === true) {
      this.stdin = new WritableWorkerStdio(this._nativeThreadId, "stdin");
    }
    if (options.stdout === true) {
      const fd = Number(nativeHandle.stdoutFd);
      if (!Number.isInteger(fd) || fd < 0) throw nativeBoundaryError("Worker stdout");
      this.stdout = new ReadableWorkerStdio(this._nativeThreadId, "stdout", fd, false);
    }
    if (options.stderr === true) {
      const fd = Number(nativeHandle.stderrFd);
      if (!Number.isInteger(fd) || fd < 0) throw nativeBoundaryError("Worker stderr");
      this.stderr = new ReadableWorkerStdio(this._nativeThreadId, "stderr", fd, false);
    }
    if (typeof cottontail.workerHasRef === "function") {
      this._refed = Boolean(cottontail.workerHasRef(this._nativeThreadId));
    }
    this.performance = new WorkerPerformance(this);

    for (const item of options.transferList ?? []) {
      if (item instanceof MessagePort) {
        item._remote = { threadId: this._nativeThreadId, portId: item._id };
        if (item._peer) item._remoteEndpointThreadId = this._nativeThreadId;
        transferredPortTargets.set(item._id, item._remote);
      }
    }
    workerInstances.set(this._nativeThreadId, this);
    registerSharedEnvironmentWorker(this._sharedEnvironmentGroupId, this._nativeThreadId);

    this._worker.onmessage = (event) => this._handleMessage(event);
    this._worker.onerror = (event) => {
      this._emitWorkerError(this._normalizeWorkerError(
        event?.error ?? new Error(String(event?.message ?? event)),
      ));
    };
    this._worker.addEventListener?.("open", () => this._emitOnline());
    this._worker.addEventListener?.("exit", (event) => {
      this._emitExit(Number(event?.code ?? 0));
    });

    queueMicrotask(() => {
      const currentEmit = processObject?.emit;
      if (typeof currentEmit !== "function") {
        const error = new TypeError(`${String(currentEmit)} is not a function`);
        if (typeof processEmitAtCreation === "function" &&
            processEmitAtCreation.call(processObject, "uncaughtException", error)) return;
        throw error;
      }
      currentEmit.call(processObject, "worker", this);
    });
  }

  _emitOnline() {
    if (this._onlineEmitted || !this._running) return;
    this._onlineEmitted = true;
    this.emit("online");
  }

  _emitWorkerError(error) {
    if (this.listenerCount("error") > 0) {
      this.emit("error", error);
      return;
    }
    queueMicrotask(() => this.emit("error", error));
  }

  _normalizeWorkerError(error) {
    if (this._input?.kind !== "eval" && /Cannot find module|ModuleNotFound/.test(String(error?.message ?? error))) {
      return new Error(`BuildMessage: ModuleNotFound resolving ${JSON.stringify(this._input.filename)} (entry point)`);
    }
    return error;
  }

  _handleMessage(event) {
    let message;
    try {
      message = decodeWireMessage(event.data);
    } catch (error) {
      this.emit("messageerror", error);
      return;
    }
    if (dispatchTransferredPortMessage(message)) return;
    const control = message?.[workerControlEnvelopeKey];
    if (!control) {
      this.emit("message", message);
      return;
    }

    if (handleWorkerControl(control)) return;

    if (control.type === "error") {
      this._emitWorkerError(this._normalizeWorkerError(deserializeWorkerError(control.error)));
      return;
    }
    if (control.type === "exitCode") {
      if (!this._terminationPromise) this._reportedExitCode = Number(control.code) || 0;
      return;
    }
    if (control.type === "ready") {
      return;
    }
    if (control.type === "stdio") {
      const stream = control.stream === "stderr" ? this.stderr : this.stdout;
      if (stream) {
        const bytes = new Uint8Array(control.data ?? []);
        stream.push(globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : bytes);
      }
      return;
    }
    if (control.requestId != null) {
      const requestId = Number(control.requestId);
      const request = this._controlRequests.get(requestId);
      if (!request) return;
      this._controlRequests.delete(requestId);
      if (control.error != null) request.reject(new Error(String(control.error)));
      else request.resolve(control.value ?? control.snapshot ?? control.statistics);
    }
  }

  _emitExit(code) {
    if (this._exitEmitted) return;
    this._exitEmitted = true;
    this._running = false;
    this._refed = false;
    const nativeExitCode = Number(code) || 0;
    this._exitCode = this._terminationPromise ? nativeExitCode : (this._reportedExitCode ?? nativeExitCode);
    workerInstances.delete(this._nativeThreadId);
    unregisterSharedEnvironmentWorker(this._sharedEnvironmentGroupId, this._nativeThreadId);
    if (isMainThread) {
      removeBroadcastSubscriptionsForThread(this._nativeThreadId);
      cleanupBrokerLocksForThread(this._nativeThreadId);
    }
    else {
      try {
        sendControlToThread(0, { type: "broadcastOwnerExit", ownerThreadId: this._nativeThreadId });
        sendControlToThread(0, { type: "lockOwnerExit", ownerThreadId: this._nativeThreadId });
      } catch {}
    }
    rejectThreadMessageRequestsForTarget(this._nativeThreadId);
    this.threadId = -1;
    this.threadName = null;
    this.resourceLimits = {};
    for (const request of this._controlRequests.values()) request.reject(workerNotRunningError());
    this._controlRequests.clear();
    this._terminationResolve?.(this._exitCode);
    this._terminationResolve = null;
    this.emit("exit", this._exitCode);
  }

  _postControl(control) {
    if (!this._running) throw workerNotRunningError();
    this.postMessage({ [workerControlEnvelopeKey]: control });
  }

  _requestControl(type, payload = undefined) {
    if (!this._running) return Promise.reject(workerNotRunningError());
    const requestId = nextWorkerControlRequestId++;
    return new Promise((resolve, reject) => {
      this._controlRequests.set(requestId, { resolve, reject });
      try {
        this._postControl({ ...payload, type, requestId });
      } catch (error) {
        this._controlRequests.delete(requestId);
        reject(error);
      }
    });
  }

  postMessage(value, transferList = undefined) {
    if (!this._running) return;
    const encoded = encodeWireMessage(value, transferList, { threadId: this._nativeThreadId });
    if (this._nativeThreadId > 0 && typeof cottontail.workerPostMessageTo === "function") {
      cottontail.workerPostMessageTo(this._nativeThreadId, encoded);
      return;
    }
    this._worker.postMessage(JSON.parse(encoded));
  }

  _forceTerminate() {
    if (!this._running) return;
    this._worker.terminate();
  }

  terminate(callback = undefined) {
    if (callback !== undefined && typeof callback !== "function") {
      throw invalidArgumentType("callback", "function", callback);
    }
    if (typeof callback === "function") {
      globalThis.process?.emitWarning?.(
        "Passing a callback to worker.terminate() is deprecated. It returns a Promise instead.",
        "DeprecationWarning",
        "DEP0132",
      );
    }
    if (!this._running) {
      const settled = Promise.resolve(this._exitCode ?? 0);
      if (callback) settled.then(code => callback(null, code));
      return settled;
    }
    if (!this._terminationPromise) {
      this._terminationPromise = new Promise(resolve => {
        this._terminationResolve = resolve;
      });
      this._forceTerminate();
    }
    if (callback) this._terminationPromise.then(code => callback(null, code));
    return this._terminationPromise;
  }

  async [Symbol.asyncDispose]() {
    await this.terminate();
  }

  ref() {
    if (!this._running) {
      this._refed = false;
      return;
    }
    this._worker.ref?.();
    this._refed = typeof cottontail.workerSetRef === "function"
      ? Boolean(cottontail.workerSetRef(this._nativeThreadId, true))
      : true;
  }

  unref() {
    if (!this._running) {
      this._refed = false;
      return;
    }
    this._worker.unref?.();
    if (typeof cottontail.workerSetRef === "function") {
      cottontail.workerSetRef(this._nativeThreadId, false);
    }
    this._refed = false;
  }

  hasRef() {
    if (!this._running) return false;
    if (typeof cottontail.workerHasRef === "function") {
      this._refed = Boolean(cottontail.workerHasRef(this._nativeThreadId));
    }
    return this._refed;
  }

  getHeapStatistics() {
    return this._requestControl("heapStatisticsRequest");
  }

  getHeapSnapshot(options = undefined) {
    if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
      throw invalidArgumentType("options", "object", options);
    }
    for (const key of ["exposeInternals", "exposeNumericValues"]) {
      if (options?.[key] !== undefined && typeof options[key] !== "boolean") {
        throw invalidArgumentType(`options.${key}`, "boolean", options[key]);
      }
    }
    if (!this._running || this._emptyEvalSource) return Promise.reject(workerNotRunningError());
    return this._requestControl("heapSnapshotRequest", { options })
      .then(snapshot => new HeapSnapshotStream(jscHeapSnapshotToV8(String(snapshot ?? ""))));
  }

  cpuUsage() {
    return Promise.reject(nativeBoundaryError("worker_threads.Worker.cpuUsage"));
  }

  startCpuProfile() {
    return Promise.reject(nativeBoundaryError("worker_threads.Worker.startCpuProfile"));
  }

  startHeapProfile() {
    return Promise.reject(nativeBoundaryError("worker_threads.Worker.startHeapProfile"));
  }
}

export class MessagePort extends EventEmitter {
  static [Symbol.hasInstance](value) {
    return Boolean(value && (value[messagePortBrand] || Function.prototype[Symbol.hasInstance].call(this, value)));
  }

  constructor(token = undefined) {
    if (token !== createMessagePortToken) throw new TypeError("Illegal constructor");
    super();
    this[messagePortBrand] = true;
    this._id = `${threadId}:${nextPortId++}`;
    this._queue = [];
    this._closed = false;
    this._started = false;
    this._peer = null;
    this._remote = null;
    this._remoteEndpointThreadId = null;
    this._transferred = false;
    this._onmessage = null;
    this._onmessageerror = null;
    this._ref = false;
    this._dispatchScheduled = false;
    this._eventTargetListeners = new Map();
  }

  get onmessage() {
    return this._onmessage;
  }

  set onmessage(handler) {
    this._onmessage = typeof handler === "function" ? handler : null;
    if (this._onmessage) this.start();
    this._syncRefFromMessageListeners();
  }

  get onmessageerror() {
    return this._onmessageerror;
  }

  set onmessageerror(handler) {
    this._onmessageerror = typeof handler === "function" ? handler : null;
  }

  postMessage(value, transferList = undefined) {
    if (this._closed) return;
    const transfers = validateTransferList(transferList);
    if (transfers.includes(this)) throw dataCloneError("Transfer list contains source port");
    if (this._peer && transfers.includes(this._peer)) {
      throw dataCloneError("Transfer list contains the receiving port");
    }
    const remote = this._remote ?? this._peer?._remote;
    if (remote) {
      const endpointThreadId = this._remoteEndpointThreadId ?? this._peer?._remoteEndpointThreadId ?? remote.threadId;
      const valueWire = encodeWireMessage(value, transfers, { threadId: endpointThreadId });
      const encoded = encodeWireMessage(makePortMessage(remote.portId, valueWire, "message", endpointThreadId));
      if (remote.threadId > 0 && typeof cottontail.workerPostMessageTo === "function") {
        cottontail.workerPostMessageTo(remote.threadId, encoded);
        return;
      }
      if (remote.threadId === 0 && !isMainThread && typeof cottontail.workerPostMessage === "function") {
        cottontail.workerPostMessage(encoded);
        return;
      }
    }
    if (!this._peer || this._peer._closed) return;
    const context = {};
    const cloned = cloneForMessage(value, transfers, context);
    this._peer._queue.push({ value: cloned, ports: context.transferredPorts ?? [] });
    this._peer._scheduleDispatch();
  }

  start() {
    this._started = true;
    this._scheduleDispatch();
  }

  close() {
    if (this._closed) return;
    const remote = this._remote ?? this._peer?._remote;
    if (remote) {
      const endpointThreadId = this._remoteEndpointThreadId ?? this._peer?._remoteEndpointThreadId ?? remote.threadId;
      const encoded = encodeWireMessage(makePortMessage(remote.portId, undefined, "close", endpointThreadId));
      if (remote.threadId > 0 && typeof cottontail.workerPostMessageTo === "function") {
        cottontail.workerPostMessageTo(remote.threadId, encoded);
      } else if (remote.threadId === 0 && !isMainThread && typeof cottontail.workerPostMessage === "function") {
        cottontail.workerPostMessage(encoded);
      }
    }
    this._closeLocal();
    if (this._peer && !this._peer._closed) this._peer._closeLocal();
  }

  _closeLocal() {
    if (this._closed) return;
    this._closed = true;
    receivedMessagePorts.delete(this._id);
    this._syncRefHandle();
    queueMicrotask(() => {
      const event = { type: "close", target: this, currentTarget: this };
      this._dispatchEventTarget("close", event);
      this.emit("close");
    });
  }

  ref() {
    this._ref = true;
    this._syncRefHandle();
  }

  unref() {
    this._ref = false;
    this._syncRefHandle();
  }

  hasRef() {
    return this._ref;
  }

  _syncRefHandle() {
    if (!this._closed && this._ref) referencedMessagePorts.add(this);
    else referencedMessagePorts.delete(this);
  }

  _hasMessageListeners() {
    return this.listenerCount("message") > 0 || typeof this._onmessage === "function" ||
      Boolean(this._eventTargetListeners.get("message")?.size);
  }

  _syncRefFromMessageListeners() {
    this._ref = this._hasMessageListeners();
    this._syncRefHandle();
  }

  addListener(name, handler) {
    super.addListener(name, handler);
    if (String(name) === "message") {
      this.start();
      this._ref = true;
      this._syncRefHandle();
    }
    return this;
  }

  on(name, handler) {
    return this.addListener(name, handler);
  }

  prependListener(name, handler) {
    super.prependListener(name, handler);
    if (String(name) === "message") {
      this.start();
      this._ref = true;
      this._syncRefHandle();
    }
    return this;
  }

  removeListener(name, handler) {
    super.removeListener(name, handler);
    if (String(name) === "message") this._syncRefFromMessageListeners();
    return this;
  }

  off(name, handler) {
    return this.removeListener(name, handler);
  }

  removeAllListeners(name = undefined) {
    if (arguments.length === 0) super.removeAllListeners();
    else super.removeAllListeners(name);
    if (arguments.length === 0 || String(name) === "message") this._syncRefFromMessageListeners();
    return this;
  }

  addEventListener(name, handler, options = undefined) {
    if (typeof handler !== "function" && typeof handler?.handleEvent !== "function") return;
    const key = String(name);
    const byType = this._eventTargetListeners.get(key) ?? new Map();
    if (byType.has(handler)) return;
    byType.set(handler, { handler, once: options?.once === true });
    this._eventTargetListeners.set(key, byType);
    if (key === "message") {
      this.start();
      this._ref = true;
      this._syncRefHandle();
    }
  }

  removeEventListener(name, handler) {
    const key = String(name);
    const byType = this._eventTargetListeners.get(key);
    if (!byType?.has(handler)) return;
    byType.delete(handler);
    if (byType.size === 0) this._eventTargetListeners.delete(key);
    if (key === "message") this._syncRefFromMessageListeners();
  }

  _dispatchEventTarget(name, event) {
    const byType = this._eventTargetListeners.get(String(name));
    if (!byType) return;
    for (const entry of [...byType.values()]) {
      if (entry.once) this.removeEventListener(name, entry.handler);
      if (typeof entry.handler === "function") entry.handler.call(this, event);
      else entry.handler.handleEvent(event);
    }
  }

  _emitMessageError(error) {
    const event = { type: "messageerror", data: error, error, target: this, currentTarget: this };
    if (typeof this.onmessageerror === "function") this.onmessageerror(event);
    this._dispatchEventTarget("messageerror", event);
    this.emit("messageerror", error);
  }

  _scheduleDispatch() {
    if (this._dispatchScheduled || this._closed) return;
    this._dispatchScheduled = true;
    queueMicrotask(() => {
      this._dispatchScheduled = false;
      this._dispatch();
    });
  }

  _dispatch() {
    if (!this._started && typeof this.onmessage !== "function" && this.listenerCount("message") === 0 &&
        !this._eventTargetListeners.get("message")?.size) return;
    while (this._queue.length > 0 && !this._closed) {
      const entry = this._queue.shift();
      const value = entry?.value;
      const event = {
        type: "message",
        data: value,
        ports: entry?.ports ?? [],
        origin: "",
        source: null,
        target: this,
        currentTarget: this,
      };
      if (typeof this.onmessage === "function") this.onmessage(event);
      this._dispatchEventTarget("message", event);
      this.emit("message", value);
    }
  }

  _keepsEventLoopAlive() {
    return !this._closed && this._ref;
  }
}

Object.defineProperty(MessagePort.prototype, Symbol.toStringTag, {
  configurable: true,
  value: "MessagePort",
});

export class MessageChannel {
  constructor() {
    this.port1 = new MessagePort(createMessagePortToken);
    this.port2 = new MessagePort(createMessagePortToken);
    this.port1._peer = this.port2;
    this.port2._peer = this.port1;
  }
}

Object.defineProperty(MessageChannel.prototype, Symbol.toStringTag, {
  configurable: true,
  value: "MessageChannel",
});

globalThis.MessagePort = MessagePort;
globalThis.MessageChannel = MessageChannel;

function initializeWorkerMetadata() {
  if (isMainThread) return;
  const bootstrap = globalThis.__cottontailWorkerBootstrap ?? {};
  activateSharedEnvironment(bootstrap.sharedEnvironmentGroupId);
  workerData = bootstrap.workerDataWire != null
    ? decodeWireMessage(bootstrap.workerDataWire)
    : globalThis.__cottontailWorkerData ?? null;
  resourceLimits = bootstrap.resourceLimitsWire != null
    ? decodeWireMessage(bootstrap.resourceLimitsWire)
    : globalThis.__cottontailWorkerResourceLimits ?? {};
  threadName = String(bootstrap.threadName ?? globalThis.__cottontailWorkerThreadName ?? "");
  const entries = bootstrap.environmentDataWire != null
    ? decodeWireMessage(bootstrap.environmentDataWire)
    : globalThis.__cottontailEnvironmentData ?? [];
  for (const [key, value] of entries ?? []) environmentData.set(key, value);
}

initializeWorkerMetadata();

function assertBroadcastChannel(channel) {
  if (!broadcastChannelBrand.has(channel)) throw invalidThisError("BroadcastChannel");
}

function makeMessageEvent(type, data, target, ports = []) {
  let event;
  try {
    event = new globalThis.MessageEvent(type, { data, ports });
  } catch {
    event = { type, data, ports, origin: "", source: null };
  }
  for (const [key, value] of [["target", target], ["currentTarget", target]]) {
    try {
      Object.defineProperty(event, key, { configurable: true, value });
    } catch {}
  }
  return event;
}

function broadcastSubscriptionState(name) {
  let subscriptions = broadcastSubscriptions.get(name);
  if (!subscriptions) {
    subscriptions = new Map();
    broadcastSubscriptions.set(name, subscriptions);
  }
  return subscriptions;
}

function registerBroadcastSubscription(name, channelId, ownerThreadId) {
  if (!isMainThread) return;
  broadcastSubscriptionState(String(name)).set(String(channelId), Number(ownerThreadId));
}

function unregisterBroadcastSubscription(name, channelId) {
  if (!isMainThread) return;
  const subscriptions = broadcastSubscriptions.get(String(name));
  subscriptions?.delete(String(channelId));
  if (subscriptions?.size === 0) broadcastSubscriptions.delete(String(name));
}

function removeBroadcastSubscriptionsForThread(ownerThreadId) {
  if (!isMainThread) return;
  for (const [name, subscriptions] of broadcastSubscriptions) {
    for (const [channelId, subscriberThreadId] of subscriptions) {
      if (subscriberThreadId === ownerThreadId) subscriptions.delete(channelId);
    }
    if (subscriptions.size === 0) broadcastSubscriptions.delete(name);
  }
}

function publishBroadcast(name, sourceThreadId, sourceChannelId, valueWire) {
  if (!isMainThread) return;
  const localChannels = broadcastChannels.get(String(name)) ?? [];
  for (const channel of localChannels) {
    if (sourceThreadId === 0 && channel._id === sourceChannelId) continue;
    channel._enqueueWire(valueWire);
  }
  for (const [targetChannelId, targetThreadId] of broadcastSubscriptions.get(String(name)) ?? []) {
    if (targetThreadId === sourceThreadId && targetChannelId === sourceChannelId) continue;
    try {
      sendControlToThread(targetThreadId, {
        type: "broadcastDeliver",
        name: String(name),
        targetChannelId,
        valueWire,
      });
    } catch {
      unregisterBroadcastSubscription(name, targetChannelId);
    }
  }
}

export class BroadcastChannel extends EventEmitter {
  constructor(name) {
    if (arguments.length === 0) throw missingArgumentsError("name");
    if (typeof name === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    super();
    broadcastChannelBrand.add(this);
    this._name = String(name);
    this._id = `${threadId}:${crossThreadMessagingState.nextBroadcastChannelId++}`;
    this.onmessage = null;
    this.onmessageerror = null;
    this._closed = false;
    this._refed = true;
    this._queue = [];
    this._dispatchScheduled = false;
    this._eventTargetListeners = new Map();
    const channels = broadcastChannels.get(this._name) ?? new Set();
    channels.add(this);
    broadcastChannels.set(this._name, channels);
    broadcastChannelIds.set(this._id, this);
    if (!isMainThread) {
      sendControlToThread(0, {
        type: "broadcastSubscribe",
        name: this._name,
        channelId: this._id,
        ownerThreadId: threadId,
      });
    }
  }

  get name() {
    assertBroadcastChannel(this);
    return this._name;
  }

  postMessage(value) {
    assertBroadcastChannel(this);
    if (this._closed) {
      const error = typeof globalThis.DOMException === "function"
        ? new DOMException("BroadcastChannel is closed", "InvalidStateError")
        : new Error("BroadcastChannel is closed");
      throw error;
    }
    if (arguments.length === 0) throw missingArgumentsError("message");
    const valueWire = encodeWireMessage(value);
    if (isMainThread) publishBroadcast(this._name, 0, this._id, valueWire);
    else sendControlToThread(0, {
      type: "broadcastPost",
      name: this._name,
      sourceThreadId: threadId,
      sourceChannelId: this._id,
      valueWire,
    });
  }

  _enqueueWire(valueWire) {
    if (this._closed) return;
    try {
      this._queue.push(decodeWireMessage(valueWire));
    } catch (error) {
      const event = makeMessageEvent("messageerror", error, this);
      this.onmessageerror?.(event);
      this._dispatchEventTarget("messageerror", event);
      this.emit("messageerror", error);
      return;
    }
    this._scheduleDispatch();
  }

  _scheduleDispatch() {
    if (this._dispatchScheduled || this._closed) return;
    this._dispatchScheduled = true;
    queueMicrotask(() => {
      this._dispatchScheduled = false;
      while (this._queue.length > 0 && !this._closed) {
        const value = this._queue.shift();
        const event = makeMessageEvent("message", value, this);
        this.onmessage?.(event);
        this._dispatchEventTarget("message", event);
        this.emit("message", value);
      }
    });
  }

  addEventListener(name, handler, options = undefined) {
    assertBroadcastChannel(this);
    if (typeof handler !== "function" && typeof handler?.handleEvent !== "function") return;
    const key = String(name);
    const byType = this._eventTargetListeners.get(key) ?? new Map();
    if (byType.has(handler)) return;
    byType.set(handler, { handler, once: options?.once === true });
    this._eventTargetListeners.set(key, byType);
  }

  removeEventListener(name, handler) {
    assertBroadcastChannel(this);
    const key = String(name);
    const byType = this._eventTargetListeners.get(key);
    if (!byType?.has(handler)) return;
    byType.delete(handler);
    if (byType.size === 0) this._eventTargetListeners.delete(key);
  }

  _dispatchEventTarget(name, event) {
    const byType = this._eventTargetListeners.get(String(name));
    if (!byType) return;
    for (const entry of [...byType.values()]) {
      if (entry.once) this.removeEventListener(name, entry.handler);
      if (typeof entry.handler === "function") entry.handler.call(this, event);
      else entry.handler.handleEvent(event);
    }
  }

  close() {
    assertBroadcastChannel(this);
    if (this._closed) return;
    this._closed = true;
    this._queue.length = 0;
    broadcastChannels.get(this._name)?.delete(this);
    if (broadcastChannels.get(this._name)?.size === 0) broadcastChannels.delete(this._name);
    broadcastChannelIds.delete(this._id);
    if (!isMainThread) {
      sendControlToThread(0, {
        type: "broadcastUnsubscribe",
        name: this._name,
        channelId: this._id,
      });
    }
    this._eventTargetListeners.clear();
  }

  ref() {
    assertBroadcastChannel(this);
    this._refed = true;
    return this;
  }

  unref() {
    assertBroadcastChannel(this);
    this._refed = false;
    return this;
  }

  hasRef() {
    assertBroadcastChannel(this);
    return this._refed;
  }

  [Symbol.for("nodejs.util.inspect.custom")](depth, options = undefined) {
    assertBroadcastChannel(this);
    if (depth < 0) return "BroadcastChannel";
    return `BroadcastChannel { name: ${inspectValue(this._name, options)}, active: ${!this._closed} }`;
  }
}

Object.defineProperty(BroadcastChannel.prototype, Symbol.toStringTag, {
  configurable: true,
  value: "BroadcastChannel",
});

globalThis.BroadcastChannel = BroadcastChannel;

function sendControlToThread(targetThreadId, control) {
  const target = Number(targetThreadId);
  const routedControl = { ...control, destinationThreadId: target };
  if (target === threadId) {
    queueMicrotask(() => handleWorkerControl(routedControl));
    return true;
  }
  const encoded = encodeWireMessage({ [workerControlEnvelopeKey]: routedControl });
  if (target === 0) {
    if (isMainThread) {
      queueMicrotask(() => handleWorkerControl(routedControl));
      return true;
    }
    if (typeof cottontail.workerPostMessage !== "function") throw new Error("main thread is unavailable");
    return cottontail.workerPostMessage(encoded);
  }
  if (typeof cottontail.workerPostMessageTo !== "function") throw new Error("worker messaging is unavailable");
  return cottontail.workerPostMessageTo(target, encoded);
}

function settleThreadMessageRequest(control) {
  const request = threadMessageRequests.get(String(control.requestId));
  if (!request) return;
  threadMessageRequests.delete(String(control.requestId));
  if (request.timer != null) clearTimeout(request.timer);
  if (control.status === "ok") {
    request.resolve(undefined);
    return;
  }
  const code = String(control.code ?? "ERR_WORKER_MESSAGING_FAILED");
  const message = String(control.message ?? "Cannot find the destination thread or listener");
  const cause = control.error ? deserializeWorkerError(control.error) : undefined;
  request.reject(workerMessagingError(code, message, cause));
}

function rejectThreadMessageRequestsForTarget(targetThreadId) {
  for (const [requestId, request] of threadMessageRequests) {
    if (request.targetThreadId !== targetThreadId) continue;
    threadMessageRequests.delete(requestId);
    if (request.timer != null) clearTimeout(request.timer);
    request.reject(workerMessagingError(
      "ERR_WORKER_MESSAGING_FAILED",
      "Cannot find the destination thread or listener",
    ));
  }
}

function acknowledgeThreadMessage(control, status, code = undefined, message = undefined, error = undefined) {
  if (control.requestId == null) return;
  try {
    sendControlToThread(Number(control.sourceThreadId), {
      type: "threadMessageAck",
      requestId: String(control.requestId),
      status,
      code,
      message,
      error,
    });
  } catch {}
}

function dispatchThreadMessage(control) {
  try {
    const emit = globalThis.process?.emit;
    const listenerCount = Number(globalThis.process?.listenerCount?.("workerMessage") ?? 0);
    if (typeof emit !== "function" || listenerCount === 0) {
      acknowledgeThreadMessage(
        control,
        "error",
        "ERR_WORKER_MESSAGING_FAILED",
        "Cannot find the destination thread or listener",
      );
      return;
    }
    emit.call(globalThis.process, "workerMessage", control.value, Number(control.sourceThreadId));
    acknowledgeThreadMessage(control, "ok");
  } catch (error) {
    acknowledgeThreadMessage(
      control,
      "error",
      "ERR_WORKER_MESSAGING_ERRORED",
      "The destination thread threw an error while processing the message",
      workerErrorPayload(error),
    );
  }
}

function handleWorkerControl(control) {
  const destinationThreadId = Number(control?.destinationThreadId);
  if (Number.isInteger(destinationThreadId) && destinationThreadId >= 0 && destinationThreadId !== threadId) {
    try {
      sendControlToThread(destinationThreadId, control);
    } catch {}
    return true;
  }
  switch (control?.type) {
    case "sharedEnvironmentRegister": {
      if (isMainThread) {
        const group = sharedEnvironmentGroup(control.groupId);
        for (const member of control.memberThreadIds ?? []) group.members.add(Number(member));
      }
      return true;
    }
    case "sharedEnvironmentUnregister": {
      if (isMainThread) {
        sharedEnvironmentGroups.get(String(control.groupId))?.members.delete(Number(control.memberThreadId));
      }
      return true;
    }
    case "sharedEnvironmentUpdate":
      if (isMainThread) brokerSharedEnvironmentUpdate(control);
      else if (String(control.groupId) === activeSharedEnvironmentGroupId) {
        applySharedEnvironmentUpdate(String(control.key), control.value, control.deleted === true);
      }
      return true;
    case "threadMessage":
      dispatchThreadMessage(control);
      return true;
    case "threadMessageAck":
      settleThreadMessageRequest(control);
      return true;
    case "broadcastSubscribe":
      registerBroadcastSubscription(control.name, control.channelId, control.ownerThreadId);
      return true;
    case "broadcastUnsubscribe":
      unregisterBroadcastSubscription(control.name, control.channelId);
      return true;
    case "broadcastOwnerExit":
      removeBroadcastSubscriptionsForThread(Number(control.ownerThreadId));
      return true;
    case "broadcastPost":
      publishBroadcast(
        control.name,
        Number(control.sourceThreadId),
        String(control.sourceChannelId),
        control.valueWire,
      );
      return true;
    case "broadcastDeliver":
      broadcastChannelIds.get(String(control.targetChannelId))?._enqueueWire(control.valueWire);
      return true;
    case "lockAcquire":
    case "lockRelease":
    case "lockCancel":
    case "lockOwnerExit":
    case "lockQuery":
    case "lockGranted":
    case "lockUnavailable":
    case "lockRevoked":
    case "lockQueryResult":
      handleLockControl(control);
      return true;
    default:
      return false;
  }
}

function sendParentControl(control) {
  if (typeof cottontail.workerPostMessage !== "function") return;
  cottontail.workerPostMessage(encodeWireMessage({ [workerControlEnvelopeKey]: control }));
}

function normalizeWorkerEvalError(value) {
  const message = String(value?.message ?? value);
  const missingModule = message.match(/Cannot find module ['"]([^'"]+)['"]/);
  if (missingModule) {
    const id = globalThis.crypto?.randomUUID?.() ?? `${threadId}-${Date.now()}`;
    const error = new Error(`error: Cannot find module '${missingModule[1]}' from 'blob:${id}'`);
    if (value?.code !== undefined) error.code = value.code;
    return error;
  }
  const unexpected = message.match(/Unexpected (?:keyword|token) ['"]([^'"]+)['"]/);
  if (value?.name === "SyntaxError" && unexpected) {
    const error = new Error(`error: Unexpected ${unexpected[1]}`);
    if (value?.code !== undefined) error.code = value.code;
    return error;
  }
  return value;
}

function workerErrorPayload(value) {
  let name = "Error";
  let message;
  let stack;
  let code;
  try {
    if (typeof value?.name === "string") name = value.name;
  } catch {}
  try {
    if (typeof value?.message === "string") message = value.message;
  } catch {}
  try {
    if (typeof value?.stack === "string") stack = value.stack;
  } catch {}
  try {
    if (value?.code !== undefined) code = value.code;
  } catch {}
  if (message === undefined) {
    try {
      message = formatValue(value);
    } catch {
      try {
        message = String(value);
      } catch {
        message = "Worker execution failed";
      }
    }
  }
  return { name, message, stack, code };
}

export const parentPort = isMainThread ? null : new class ParentPort extends MessagePort {
  constructor() {
    super(createMessagePortToken);
    const transportListener = (event) => {
      let message;
      const context = {};
      try {
        message = decodeWireMessage(event.data, context);
      } catch (error) {
        this._emitMessageError(error);
        return;
      }
      if (dispatchReceivedPortMessage(message)) return;
      const control = message?.[workerControlEnvelopeKey];
      if (control) {
        this._handleControl(control);
        return;
      }
      if (!this._closed) {
        this._queue.push({ value: message, ports: context.transferredPorts ?? [] });
        this._scheduleDispatch();
      }
    };
    transportListener[Symbol.for("cottontail.worker_threads.transportListener")] = true;
    this._transportListener = transportListener;
    globalThis.addEventListener?.("message", transportListener);
  }

  _handleControl(control) {
    if (handleWorkerControl(control)) return;
    if (control.type === "terminate") {
      globalThis.process.exitCode = 1;
      sendParentControl({ type: "exitCode", code: 1 });
      globalThis.__cottontailWorkerThreadsFatalCleanup?.();
      cottontail.exit?.(1);
      return;
    }
    if (control.type === "stdin") {
      const stdin = globalThis.process?.stdin;
      if (control.end === true) stdin?.push?.(null);
      else {
        const bytes = new Uint8Array(control.data ?? []);
        stdin?.push?.(globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : bytes);
      }
      return;
    }
    const respond = (type, value = undefined, error = undefined) => {
      sendParentControl({ type, requestId: control.requestId, value, error });
    };
    if (control.type === "heapSnapshotRequest") {
      try {
        respond("heapSnapshotResult", String(cottontail.jscHeapSnapshot()));
      } catch (error) {
        respond("heapSnapshotResult", undefined, String(error?.message ?? error));
      }
      return;
    }
    if (control.type === "heapStatisticsRequest") {
      try {
        respond("heapStatisticsResult", cottontail.jscMemoryUsage?.() ?? {});
      } catch (error) {
        respond("heapStatisticsResult", undefined, String(error?.message ?? error));
      }
    }
  }

  postMessage(value, transferList = undefined) {
    if (this._closed) return;
    if (typeof cottontail.workerPostMessage === "function") {
      cottontail.workerPostMessage(encodeWireMessage(value, transferList, { threadId: 0 }));
    } else {
      globalThis.postMessage?.(value, transferList);
    }
  }

  close() {
    if (this._closed) return;
    this._closeLocal();
    this.removeAllListeners();
  }
}();

function hasReferencedMessagingHandles() {
  if (referencedMessagePorts.size > 0) return true;
  for (const channels of broadcastChannels.values()) {
    for (const channel of channels) {
      if (!channel._closed && channel._refed) return true;
    }
  }
  return false;
}

if (isMainThread) {
  const previousWebHasActiveHandles = globalThis.__cottontailWebHasActiveHandles;
  globalThis.__cottontailWebHasActiveHandles = () =>
    Boolean(previousWebHasActiveHandles?.() || hasReferencedMessagingHandles());
}

if (!isMainThread) {
  globalThis.__cottontailNormalizeWorkerEvalError = normalizeWorkerEvalError;
  const previousWebHasActiveHandles = globalThis.__cottontailWebHasActiveHandles;
  const previousWebPollAlways = globalThis.__cottontailWebPollAlways;
  let workerIdleEpochNotified = false;
  let workerNaturalExitReported = false;
  const hasWorkerVisibleHandles = () => {
    if (previousWebHasActiveHandles?.()) return true;
    if (parentPort?._keepsEventLoopAlive()) return true;
    if (threadMessageRequests.size > 0) return true;
    if (localLockRequests.size > 0 || localLockQueries.size > 0) return true;
    return hasReferencedMessagingHandles();
  };
  globalThis.__cottontailWebHasActiveHandles = () => {
    if (hasWorkerVisibleHandles()) {
      workerIdleEpochNotified = false;
      workerNaturalExitReported = false;
      return true;
    }
    if (!workerIdleEpochNotified) {
      workerIdleEpochNotified = true;
      const exitCode = Number(globalThis.process?.exitCode ?? 0) || 0;
      globalThis.process?.emit?.("beforeExit", exitCode);
      if (hasWorkerVisibleHandles()) {
        workerIdleEpochNotified = false;
        return true;
      }
    }
    if (!workerNaturalExitReported) {
      workerNaturalExitReported = true;
      sendParentControl({ type: "exitCode", code: Number(globalThis.process?.exitCode ?? 0) || 0 });
    }
    return false;
  };
  globalThis.__cottontailWebPollAlways = () => {
    if (previousWebPollAlways?.()) return true;
    // The transport listener itself is not a user-visible active handle, but it
    // must be polled while another handle keeps the worker loop alive so control
    // messages such as terminate and stdin can be consumed.
    if (parentPort && !parentPort._closed) return true;
    return receivedMessagePorts.size > 0;
  };
  globalThis.__cottontailWorkerThreadsFatalCleanup = () => {
    clearWorkerNativeTimers();
    parentPort?.close();
    globalThis.__cottontailWebHasActiveHandles = () => false;
    globalThis.__cottontailWebPollAlways = () => false;
    Object.defineProperty(globalThis, "__cottontailHasActiveHandles", {
      configurable: true,
      writable: true,
      value: () => false,
    });
  };
  globalThis.__cottontailWorkerThreadsReportError = (error) => {
    if (workerUserCaptureCallbackInstalled &&
        globalThis.process?.hasUncaughtExceptionCaptureCallback?.() === true &&
        globalThis.process._fatalException?.(error, false)) return;
    const userListeners = (globalThis.process?.rawListeners?.("uncaughtException") ??
      globalThis.process?.listeners?.("uncaughtException") ?? [])
      .filter(listener => !inheritedUncaughtExceptionListeners.has(listener.listener ?? listener));
    if (userListeners.length > 0) {
      for (const listener of userListeners) listener.call(globalThis.process, error, "uncaughtException");
      return;
    }
    sendParentControl({ type: "error", error: workerErrorPayload(error) });
    sendParentControl({ type: "exitCode", code: 1 });
    globalThis.__cottontailWorkerThreadsFatalCleanup();
    cottontail.exit?.(1);
  };
  globalThis.__cottontailConfigureWorkerStdio = () => {
    const bootstrap = globalThis.__cottontailWorkerBootstrap ?? {};
    const nativeStdio = cottontail.workerStdioInfo?.() ?? {};
    if (bootstrap.stdin === true) {
      const fd = Number(nativeStdio.stdinFd);
      if (!Number.isInteger(fd) || fd < 0) throw nativeBoundaryError("Worker stdin");
      globalThis.process.stdin = new ReadableWorkerStdio(threadId, "stdin", fd, true);
    }

    const installOutput = (streamName) => {
      if (nativeStdio[streamName] !== true) throw nativeBoundaryError(`Worker ${streamName}`);
      const stream = new WritableWorkerStdio(threadId, streamName);
      globalThis.process[streamName] = stream;
      return stream;
    };

    if (bootstrap.stdout === true) {
      const stdout = installOutput("stdout");
      for (const name of ["log", "info", "debug"]) {
        globalThis.console[name] = (...args) => {
          stdout.write(`${formatValue(...args)}\n`);
        };
      }
    }
    if (bootstrap.stderr === true) {
      const stderr = installOutput("stderr");
      for (const name of ["error", "warn"]) {
        globalThis.console[name] = (...args) => {
          stderr.write(`${formatValue(...args)}\n`);
        };
      }
    }
  };

  globalThis.parentPort ??= parentPort;
  globalThis.workerData ??= workerData;
  globalThis.__cottontailWorkerThreadsNotifyReady = () => sendParentControl({ type: "ready" });

  if (typeof globalThis.process?.exit === "function") {
    const processExit = globalThis.process.exit;
    globalThis.process.exit = function exit(code = this?.exitCode ?? 0) {
      const exitCode = Number(code) || 0;
      sendParentControl({ type: "exitCode", code: exitCode });
      globalThis.__cottontailWorkerThreadsFatalCleanup?.();
      return processExit.call(this, exitCode);
    };
  }
}

export function setEnvironmentData(key, value) {
  if (value === undefined) environmentData.delete(key);
  else environmentData.set(key, value);
}

export function getEnvironmentData(key) {
  return environmentData.get(key);
}

export function markAsUntransferable(object) {
  if (object === undefined) {
    throw bunNotImplementedError("worker_threads.markAsUntransferable");
  }
  if (object && typeof object === "object") markedUntransferable.add(object);
}

export function isMarkedAsUntransferable(object) {
  return Boolean(object && typeof object === "object" && markedUntransferable.has(object));
}

export function markAsUncloneable(object) {
  if (object && typeof object === "object") markedUncloneable.add(object);
}

export function moveMessagePortToContext(port, contextifiedSandbox) {
  if (port === undefined) {
    throw bunNotImplementedError("worker_threads.moveMessagePortToContext");
  }
  if (!(port instanceof MessagePort)) throw invalidArgumentType("port", "a MessagePort instance", port);
  if (!isContext(contextifiedSandbox)) {
    throw invalidArgumentType("contextifiedSandbox", "a vm.Context", contextifiedSandbox);
  }
  // node:vm contexts currently share one JSC realm, so the live port already
  // has the prototypes and backing state visible from the target context.
  return port;
}

export function receiveMessageOnPort(port) {
  if (!(port instanceof MessagePort) && !broadcastChannelBrand.has(port)) {
    const error = new TypeError('The "port" argument must be a MessagePort instance');
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (port instanceof MessagePort && port._queue.length === 0 && isMainThread) {
    for (const worker of workerInstances.values()) worker._worker?._poll?.();
  }
  if (port._queue.length === 0) return undefined;
  const entry = port._queue.shift();
  return { message: port instanceof MessagePort ? entry.value : entry };
}

export function postMessageToThread(targetThreadId, value, transferList = undefined, timeout = undefined) {
  if (typeof transferList === "number" && timeout === undefined) {
    timeout = transferList;
    transferList = undefined;
  }
  let target;
  try {
    target = Number(targetThreadId);
  } catch {
    return Promise.reject(invalidArgumentType("threadId", "an integer", targetThreadId));
  }
  if (!Number.isInteger(target) || target < 0) {
    return Promise.reject(invalidArgumentType("threadId", "an integer", targetThreadId));
  }
  if (target === threadId) {
    return Promise.reject(workerMessagingError(
      "ERR_WORKER_MESSAGING_SAME_THREAD",
      "Cannot send a message to the same thread",
    ));
  }
  if (timeout !== undefined && (!Number.isFinite(Number(timeout)) || Number(timeout) < 0)) {
    return Promise.reject(invalidArgumentType("timeout", "a non-negative number", timeout));
  }

  const requestId = `${threadId}:${crossThreadMessagingState.nextThreadMessageRequestId++}`;
  let encoded;
  try {
    encoded = encodeWireMessage({
      [workerControlEnvelopeKey]: {
        type: "threadMessage",
        destinationThreadId: target,
        requestId,
        sourceThreadId: threadId,
        value,
      },
    }, transferList, { threadId: target });
  } catch (cause) {
    return Promise.reject(cause);
  }

  return new Promise((resolve, reject) => {
    const numericTimeout = timeout === undefined ? undefined : Number(timeout);
    const request = { resolve, reject, targetThreadId: target, timer: null };
    if (numericTimeout !== undefined) {
      request.timer = setTimeout(() => {
        threadMessageRequests.delete(requestId);
        reject(workerMessagingError(
          "ERR_WORKER_MESSAGING_TIMEOUT",
          "Sending a message to another thread timed out",
        ));
      }, numericTimeout);
      request.timer?.unref?.();
    }
    threadMessageRequests.set(requestId, request);
    try {
      if (target === 0 && !isMainThread) cottontail.workerPostMessage(encoded);
      else if (target > 0) cottontail.workerPostMessageTo(target, encoded);
      else throw new Error("worker not found");
    } catch (cause) {
      threadMessageRequests.delete(requestId);
      if (request.timer != null) clearTimeout(request.timer);
      reject(workerMessagingError(
        "ERR_WORKER_MESSAGING_FAILED",
        "Cannot find the destination thread or listener",
        cause,
      ));
    }
  });
}

const lockBrokerStates = new Map();
const localLockRequests = new Map();
const localLockQueries = new Map();
let nextLocalLockRequestId = 1;
let nextLocalLockQueryId = 1;

function lockAbortError() {
  if (typeof globalThis.DOMException === "function") return new DOMException("The operation was aborted", "AbortError");
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function lockBrokerState(name) {
  let state = lockBrokerStates.get(name);
  if (!state) {
    state = { held: [], pending: [] };
    lockBrokerStates.set(name, state);
  }
  return state;
}

function brokerCanGrantLock(state, request) {
  return state.held.length === 0 ||
    (request.mode === "shared" && state.held.every(lock => lock.mode === "shared"));
}

function sendLockControl(ownerThreadId, control) {
  sendControlToThread(ownerThreadId, control);
}

function brokerGrantLock(request) {
  const state = lockBrokerState(request.name);
  state.held.push(request);
  sendLockControl(request.ownerThreadId, {
    type: "lockGranted",
    requestId: request.requestId,
    name: request.name,
    mode: request.mode,
    clientId: request.clientId,
  });
}

function pumpBrokerLockQueue(name) {
  const state = lockBrokerState(name);
  while (state.pending.length > 0) {
    const request = state.pending[0];
    if (!brokerCanGrantLock(state, request)) break;
    state.pending.shift();
    brokerGrantLock(request);
    if (request.mode === "exclusive") break;
  }
  if (state.held.length === 0 && state.pending.length === 0) lockBrokerStates.delete(name);
}

function brokerAcquireLock(control) {
  const request = {
    requestId: String(control.requestId),
    ownerThreadId: Number(control.ownerThreadId),
    name: String(control.name),
    mode: control.mode === "shared" ? "shared" : "exclusive",
    clientId: `thread-${Number(control.ownerThreadId)}`,
  };
  const state = lockBrokerState(request.name);
  if (control.steal === true) {
    for (const held of state.held.splice(0)) {
      sendLockControl(held.ownerThreadId, {
        type: "lockRevoked",
        requestId: held.requestId,
      });
    }
    brokerGrantLock(request);
    return;
  }
  const available = state.pending.length === 0 && brokerCanGrantLock(state, request);
  if (control.ifAvailable === true && !available) {
    sendLockControl(request.ownerThreadId, {
      type: "lockUnavailable",
      requestId: request.requestId,
    });
    return;
  }
  state.pending.push(request);
  pumpBrokerLockQueue(request.name);
}

function brokerReleaseLock(control) {
  const requestId = String(control.requestId);
  for (const [name, state] of lockBrokerStates) {
    const heldIndex = state.held.findIndex(request => request.requestId === requestId);
    if (heldIndex < 0) continue;
    state.held.splice(heldIndex, 1);
    pumpBrokerLockQueue(name);
    return;
  }
}

function brokerCancelLock(control) {
  const requestId = String(control.requestId);
  for (const [name, state] of lockBrokerStates) {
    const pendingIndex = state.pending.findIndex(request => request.requestId === requestId);
    if (pendingIndex < 0) continue;
    state.pending.splice(pendingIndex, 1);
    pumpBrokerLockQueue(name);
    return;
  }
}

function cleanupBrokerLocksForThread(ownerThreadId) {
  if (!isMainThread) return;
  const affectedNames = [];
  for (const [name, state] of lockBrokerStates) {
    const heldLength = state.held.length;
    const pendingLength = state.pending.length;
    state.held = state.held.filter(request => request.ownerThreadId !== ownerThreadId);
    state.pending = state.pending.filter(request => request.ownerThreadId !== ownerThreadId);
    if (state.held.length !== heldLength || state.pending.length !== pendingLength) affectedNames.push(name);
  }
  for (const name of affectedNames) pumpBrokerLockQueue(name);
}

function brokerLockQuery(control) {
  const held = [];
  const pending = [];
  for (const state of lockBrokerStates.values()) {
    for (const lock of state.held) held.push({ name: lock.name, mode: lock.mode, clientId: lock.clientId });
    for (const lock of state.pending) pending.push({ name: lock.name, mode: lock.mode, clientId: lock.clientId });
  }
  sendLockControl(Number(control.ownerThreadId), {
    type: "lockQueryResult",
    queryId: String(control.queryId),
    value: { held, pending },
  });
}

function finishLocalLockRequest(request, kind, value, release = false) {
  if (request.settled) return;
  request.settled = true;
  request.abortCleanup?.();
  localLockRequests.delete(request.requestId);
  if (release) {
    try {
      sendControlToThread(0, { type: "lockRelease", requestId: request.requestId });
    } catch {}
  }
  if (kind === "resolve") request.resolve(value);
  else request.reject(value);
}

function runLocalLockCallback(request, lock, release) {
  Promise.resolve()
    .then(() => {
      if (request.revoked) throw lockAbortError();
      return request.callback(lock);
    })
    .then(
      value => finishLocalLockRequest(request, "resolve", value, release),
      error => finishLocalLockRequest(request, "reject", error, release),
    );
}

function handleLockControl(control) {
  switch (control.type) {
    case "lockAcquire":
      if (isMainThread) brokerAcquireLock(control);
      return;
    case "lockRelease":
      if (isMainThread) brokerReleaseLock(control);
      return;
    case "lockCancel":
      if (isMainThread) brokerCancelLock(control);
      return;
    case "lockOwnerExit":
      if (isMainThread) cleanupBrokerLocksForThread(Number(control.ownerThreadId));
      return;
    case "lockQuery":
      if (isMainThread) brokerLockQuery(control);
      return;
    case "lockGranted": {
      const request = localLockRequests.get(String(control.requestId));
      if (!request || request.settled) return;
      request.granted = true;
      request.abortCleanup?.();
      request.abortCleanup = null;
      runLocalLockCallback(request, {
        name: String(control.name),
        mode: control.mode === "shared" ? "shared" : "exclusive",
      }, true);
      return;
    }
    case "lockUnavailable": {
      const request = localLockRequests.get(String(control.requestId));
      if (!request || request.settled) return;
      request.abortCleanup?.();
      request.abortCleanup = null;
      runLocalLockCallback(request, null, false);
      return;
    }
    case "lockRevoked": {
      const request = localLockRequests.get(String(control.requestId));
      if (!request || request.settled) return;
      request.revoked = true;
      finishLocalLockRequest(request, "reject", lockAbortError(), false);
      return;
    }
    case "lockQueryResult": {
      const query = localLockQueries.get(String(control.queryId));
      if (!query) return;
      localLockQueries.delete(String(control.queryId));
      query.resolve(control.value ?? { held: [], pending: [] });
    }
  }
}

export const locks = {
  request(name, options = {}, callback = undefined) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (typeof callback !== "function") throw invalidArgumentType("callback", "function", callback);
    if (options === null || typeof options !== "object") throw invalidArgumentType("options", "object", options);
    if (typeof name === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    const lockName = String(name);
    if (lockName.startsWith("-")) {
      if (typeof globalThis.DOMException === "function") throw new DOMException("Lock names must not start with '-'", "NotSupportedError");
      const error = new Error("Lock names must not start with '-'");
      error.name = "NotSupportedError";
      throw error;
    }
    const mode = options.mode ?? "exclusive";
    if (mode !== "exclusive" && mode !== "shared") {
      const error = new TypeError(`The provided value '${String(mode)}' is not a valid enum value of type LockMode.`);
      error.code = "ERR_INVALID_ARG_VALUE";
      throw error;
    }
    if (options.steal === true && mode !== "exclusive") {
      throw new TypeError("The 'steal' option may only be used with exclusive locks");
    }
    if (options.steal === true && options.ifAvailable === true) {
      throw new TypeError("The 'steal' and 'ifAvailable' options cannot be used together");
    }
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? lockAbortError());

    return new Promise((resolve, reject) => {
      const requestId = `${threadId}:lock:${nextLocalLockRequestId++}`;
      const request = {
        requestId,
        name: lockName,
        mode,
        callback,
        resolve,
        reject,
        abortCleanup: null,
        granted: false,
        revoked: false,
        settled: false,
      };
      if (options.signal?.addEventListener) {
        const abort = () => {
          if (request.granted || request.settled) return;
          try {
            sendControlToThread(0, { type: "lockCancel", requestId });
          } catch {}
          finishLocalLockRequest(request, "reject", options.signal.reason ?? lockAbortError(), false);
        };
        options.signal.addEventListener("abort", abort, { once: true });
        request.abortCleanup = () => options.signal.removeEventListener?.("abort", abort);
      }
      localLockRequests.set(requestId, request);
      try {
        sendControlToThread(0, {
          type: "lockAcquire",
          requestId,
          ownerThreadId: threadId,
          name: lockName,
          mode,
          ifAvailable: options.ifAvailable === true,
          steal: options.steal === true,
        });
      } catch (error) {
        finishLocalLockRequest(request, "reject", error, false);
      }
    });
  },

  query() {
    const queryId = `${threadId}:lock-query:${nextLocalLockQueryId++}`;
    return new Promise((resolve, reject) => {
      localLockQueries.set(queryId, { resolve, reject });
      try {
        sendControlToThread(0, { type: "lockQuery", queryId, ownerThreadId: threadId });
      } catch (error) {
        localLockQueries.delete(queryId);
        reject(error);
      }
    });
  },
};

try {
  const navigatorObject = globalThis.navigator ?? {};
  if (globalThis.navigator == null) globalThis.navigator = navigatorObject;
  Object.defineProperty(navigatorObject, "locks", {
    configurable: true,
    enumerable: true,
    value: locks,
  });
} catch {}

// COTTONTAIL-COMPAT: Per-thread CPU/profilers still need additional stock-JSC
// host support. The JavaScript implementation does not synthesize those
// measurements or claim support for them.

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
