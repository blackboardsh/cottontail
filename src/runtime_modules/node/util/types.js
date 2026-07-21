import { KeyObject } from "../crypto.js";

// util.types: brand checks that survive prototype swaps (matching Node's
// native checks as closely as pure JS allows). Each helper probes an internal
// slot via a builtin prototype accessor/method rather than instanceof.

const proxyRegistry = globalThis.__cottontailProxyRegistry ?? new WeakSet();
globalThis.__cottontailProxyRegistry = proxyRegistry;
const proxyDetails = globalThis.__cottontailProxyDetails ??= new WeakMap();

function installProxyTracking() {
  const NativeProxy = globalThis.Proxy;
  if (typeof NativeProxy !== "function" || NativeProxy.__cottontailProxyTracking) return;

  function CottontailProxy(target, handler) {
    if (!new.target) throw new TypeError("Constructor Proxy requires 'new'");
    const proxy = new NativeProxy(target, handler);
    proxyRegistry.add(proxy);
    proxyDetails.set(proxy, { target, handler, revoked: false });
    return proxy;
  }

  Object.setPrototypeOf(CottontailProxy, NativeProxy);
  Object.defineProperty(CottontailProxy, "revocable", {
    value(target, handler) {
      const result = NativeProxy.revocable(target, handler);
      proxyRegistry.add(result.proxy);
      const details = { target, handler, revoked: false };
      proxyDetails.set(result.proxy, details);
      const nativeRevoke = result.revoke;
      const wrappedRevoke = function () {
        details.revoked = true;
        details.target = null;
        details.handler = null;
        return nativeRevoke();
      };
      // Match the native revoke function's anonymous name.
      Object.defineProperty(wrappedRevoke, "name", { value: "", configurable: true });
      result.revoke = wrappedRevoke;
      return result;
    },
  });
  Object.defineProperty(CottontailProxy, "__cottontailProxyTracking", { value: true });
  globalThis.Proxy = CottontailProxy;
}

installProxyTracking();

// Map/Set iterator tracking: lets util.inspect preview the remaining entries
// of a live iterator (Node uses a native V8 hook for this). We wrap the
// iterator-producing methods to remember (source, kind) and the shared
// iterator prototypes' next() to count consumed entries.
const iteratorInfo = globalThis.__cottontailIteratorInfo ??= new WeakMap();

function installIteratorTracking() {
  if (globalThis.__cottontailIteratorTrackingInstalled) return;
  globalThis.__cottontailIteratorTrackingInstalled = true;

  const track = (isMap) => function tracked(original, kind) {
    const wrapper = {
      [kind](...args) {
        const iterator = original.apply(this, args);
        try {
          iteratorInfo.set(iterator, { source: this, kind, consumed: 0, returned: false, isMap });
        } catch {
          // non-object iterator; ignore
        }
        return iterator;
      },
    }[kind];
    return wrapper;
  };

  const define = (target, name, value) => {
    try {
      Object.defineProperty(target, name, { value, writable: true, configurable: true });
    } catch {
      // frozen prototype; give up silently
    }
  };

  const mapTrack = track(true);
  const mapEntries = mapTrack(Map.prototype.entries, "entries");
  define(Map.prototype, "entries", mapEntries);
  define(Map.prototype, Symbol.iterator, mapEntries);
  define(Map.prototype, "keys", mapTrack(Map.prototype.keys, "keys"));
  define(Map.prototype, "values", mapTrack(Map.prototype.values, "values"));

  const setTrack = track(false);
  const setValues = setTrack(Set.prototype.values, "values");
  define(Set.prototype, "values", setValues);
  define(Set.prototype, "keys", setValues);
  define(Set.prototype, Symbol.iterator, setValues);
  define(Set.prototype, "entries", setTrack(Set.prototype.entries, "entries"));

  for (const IteratorSource of [Map, Set]) {
    const prototype = Object.getPrototypeOf(new IteratorSource()[Symbol.iterator]());
    const originalNext = prototype.next;
    define(prototype, "next", function next(...args) {
      const result = originalNext.apply(this, args);
      const info = iteratorInfo.get(this);
      if (info !== undefined) {
        if (result && result.done === true) info.returned = true;
        else info.consumed += 1;
      }
      return result;
    });
    const originalReturn = prototype.return;
    if (typeof originalReturn === "function") {
      define(prototype, "return", function returnMethod(...args) {
        const info = iteratorInfo.get(this);
        if (info !== undefined) info.returned = true;
        return originalReturn.apply(this, args);
      });
    }
  }
}

installIteratorTracking();

// Not exported as a named binding: `import * as ns from "util/types"` must
// only expose the Node predicate set (upstream tests iterate the keys).
// util.inspect's previewEntries reaches it through the default export, where
// it is attached non-enumerably below.
function getTrackedIteratorInfo(value) {
  if (value === null || typeof value !== "object") return undefined;
  return iteratorInfo.get(value);
}

// SharedArrayBuffer shim fixes: the embedded bootstrap installs a minimal
// pure-JS SharedArrayBuffer when JSC lacks the native one. That shim rejects
// `new SharedArrayBuffer()` (length must default to 0 via ToIndex) and knows
// nothing about growable buffers ({ maxByteLength }). Replace it with a
// Node-faithful constructor that reuses the same prototype object (so
// instanceof keeps working across worker_threads structured clones).
const sharedBufferRegistry = (globalThis.__cottontailSharedBufferRegistry ??= new WeakSet());
const sharedBufferGrowState = (globalThis.__cottontailSharedBufferGrowState ??= new WeakMap());

function installSharedArrayBufferShimFixes() {
  const Shim = globalThis.SharedArrayBuffer;
  const nativeMark = globalThis.__cottontailMarkSharedArrayBuffer;
  // Only patch the pure-JS shim; a real native SharedArrayBuffer needs no fix.
  if (typeof Shim !== "function" || typeof nativeMark !== "function") return;
  if (Shim.__cottontailNodeSemantics) return;

  const proto = Shim.prototype;
  const nativeCreate = globalThis.cottontail?.sharedArrayBufferCreate;
  const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;

  const markShared = (buffer) => {
    if (buffer !== null && typeof buffer === "object") sharedBufferRegistry.add(buffer);
    return nativeMark(buffer);
  };
  // Keep worker_threads (which calls this dynamically) registering clones here too.
  globalThis.__cottontailMarkSharedArrayBuffer = markShared;

  const toIndex = (value, message) => {
    if (value === undefined) return 0;
    let n = Number(value);
    n = Number.isNaN(n) ? 0 : Math.trunc(n);
    if (n < 0 || n > Number.MAX_SAFE_INTEGER) throw new RangeError(message);
    return n;
  };

  const allocate = (size) => {
    // Zero-length shared mappings come back with a NULL data pointer, which
    // JSC treats as a detached buffer; use a plain ArrayBuffer(0) instead.
    const buffer = size === 0 || typeof nativeCreate !== "function"
      ? new ArrayBuffer(size)
      : nativeCreate(size);
    return markShared(buffer);
  };

  function SharedArrayBuffer(length, options) {
    if (!new.target) throw new TypeError("Constructor SharedArrayBuffer requires 'new'");
    const size = toIndex(length, "Invalid SharedArrayBuffer length");
    let maxByteLength;
    if (options !== null && typeof options === "object" && options.maxByteLength !== undefined) {
      maxByteLength = toIndex(options.maxByteLength, "Invalid options.maxByteLength");
      if (maxByteLength < size) throw new RangeError("Invalid options.maxByteLength");
    }
    if (maxByteLength === undefined) return allocate(size);
    // Growable buffer: reserve the maximum capacity up front and track the
    // logical byteLength; grow() only bumps the logical size.
    const buffer = allocate(maxByteLength);
    sharedBufferGrowState.set(buffer, { byteLength: size, maxByteLength });
    return buffer;
  }
  Object.defineProperty(SharedArrayBuffer, "__cottontailNodeSemantics", { value: true });
  // Module transpilation may rename the binding (e.g. SharedArrayBuffer2);
  // pin the observable function name.
  Object.defineProperty(SharedArrayBuffer, "name", { value: "SharedArrayBuffer", configurable: true });
  SharedArrayBuffer.prototype = proto;
  Object.defineProperty(proto, "constructor", { value: SharedArrayBuffer, writable: true, configurable: true });
  // The bootstrap shim assigns Symbol.toStringTag with `=`, which the
  // non-writable inherited ArrayBuffer tag silently rejects; define it properly.
  Object.defineProperty(proto, Symbol.toStringTag, { value: "SharedArrayBuffer", configurable: true });

  const requireShared = (value) => {
    if (value === null || typeof value !== "object" || !sharedBufferRegistry.has(value)) {
      throw new TypeError("Receiver must be a SharedArrayBuffer");
    }
  };
  Object.defineProperty(proto, "byteLength", {
    configurable: true,
    get: function byteLength() {
      requireShared(this);
      const state = sharedBufferGrowState.get(this);
      if (state !== undefined) return state.byteLength;
      return arrayBufferByteLengthGetter.call(this);
    },
  });
  Object.defineProperty(proto, "growable", {
    configurable: true,
    get: function growable() {
      requireShared(this);
      return sharedBufferGrowState.has(this);
    },
  });
  Object.defineProperty(proto, "maxByteLength", {
    configurable: true,
    get: function maxByteLength() {
      requireShared(this);
      const state = sharedBufferGrowState.get(this);
      if (state !== undefined) return state.maxByteLength;
      return arrayBufferByteLengthGetter.call(this);
    },
  });
  Object.defineProperty(proto, "grow", {
    writable: true,
    configurable: true,
    value: function grow(newLength) {
      requireShared(this);
      const state = sharedBufferGrowState.get(this);
      if (state === undefined) throw new TypeError("SharedArrayBuffer.prototype.grow called on a non-growable SharedArrayBuffer");
      const size = toIndex(newLength, "Invalid SharedArrayBuffer length");
      if (size < state.byteLength || size > state.maxByteLength) {
        throw new RangeError("SharedArrayBuffer.prototype.grow requires a length between the current byteLength and maxByteLength");
      }
      state.byteLength = size;
      return undefined;
    },
  });

  globalThis.SharedArrayBuffer = SharedArrayBuffer;
}

installSharedArrayBufferShimFixes();

function tag(value) {
  return Object.prototype.toString.call(value);
}

const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
).get;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === "function"
  ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get ?? null
  : null;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength").get;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size").get;
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, "size").get;
const regExpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, "source").get;
const weakMapHas = WeakMap.prototype.has;
const weakSetHas = WeakSet.prototype.has;
const dateGetTime = Date.prototype.getTime;
const booleanValueOf = Boolean.prototype.valueOf;
const numberValueOf = Number.prototype.valueOf;
const stringValueOf = String.prototype.valueOf;
const symbolValueOf = Symbol.prototype.valueOf;
const bigIntValueOf = BigInt.prototype.valueOf;

function brand(check, value) {
  try {
    check(value);
    return true;
  } catch {
    return false;
  }
}

function typedArrayTag(value) {
  try {
    return typedArrayTagGetter.call(value);
  } catch {
    return undefined;
  }
}

export function isAnyArrayBuffer(value) {
  return isArrayBuffer(value) || isSharedArrayBuffer(value);
}

export function isArgumentsObject(value) {
  return tag(value) === "[object Arguments]";
}

export function isArrayBuffer(value) {
  // The SharedArrayBuffer shim backs shared buffers with real ArrayBuffers;
  // those must not report as plain ArrayBuffers (Node keeps them disjoint).
  if (value !== null && typeof value === "object" && sharedBufferRegistry.has(value)) return false;
  return brand((v) => arrayBufferByteLength.call(v), value);
}

export function isArrayBufferView(value) {
  return ArrayBuffer.isView(value);
}

const functionToString = Function.prototype.toString;
const functionHasInstance = Function.prototype[Symbol.hasInstance];
let resolveMessageConstructor;
let buildMessageConstructor;

function functionSource(value) {
  try {
    return functionToString.call(value);
  } catch {
    return null;
  }
}

// Source-based detection: unlike Object.prototype.toString this survives
// Object.setPrototypeOf tricks, matching V8's internal-slot semantics.
export function isAsyncFunction(value) {
  if (typeof value !== "function") return false;
  const source = functionSource(value);
  return source !== null && /^\s*async\b/.test(source);
}

export function isBigInt64Array(value) {
  return typedArrayTag(value) === "BigInt64Array";
}

export function isBigIntObject(value) {
  return typeof value === "object" && value !== null && brand((v) => bigIntValueOf.call(v), value);
}

export function isBigUint64Array(value) {
  return typedArrayTag(value) === "BigUint64Array";
}

export function isBooleanObject(value) {
  return typeof value === "object" && value !== null && brand((v) => booleanValueOf.call(v), value);
}

export function isBoxedPrimitive(value) {
  return isStringObject(value) || isNumberObject(value) || isBooleanObject(value) || isBigIntObject(value) || isSymbolObject(value);
}

export function isCryptoKey(value) {
  return typeof CryptoKey !== "undefined" && value instanceof CryptoKey;
}

export function isDataView(value) {
  return brand((v) => dataViewByteLength.call(v), value);
}

export function isDate(value) {
  return brand((v) => dateGetTime.call(v), value);
}

export function isExternal() {
  return false;
}

export function isEventTarget(value) {
  return typeof EventTarget === "function" && value instanceof EventTarget;
}

export function isFloat16Array(value) {
  return typedArrayTag(value) === "Float16Array";
}

export function isFloat32Array(value) {
  return typedArrayTag(value) === "Float32Array";
}

export function isFloat64Array(value) {
  return typedArrayTag(value) === "Float64Array";
}

export function isGeneratorFunction(value) {
  if (typeof value !== "function") return false;
  const source = functionSource(value);
  return source !== null && /^\s*(?:async\s+)?(?:function\s*\*|\*)/.test(source);
}

export function isGeneratorObject(value) {
  const objectTag = tag(value);
  return objectTag === "[object Generator]" || objectTag === "[object AsyncGenerator]";
}

export function isInt16Array(value) {
  return typedArrayTag(value) === "Int16Array";
}

export function isInt32Array(value) {
  return typedArrayTag(value) === "Int32Array";
}

export function isInt8Array(value) {
  return typedArrayTag(value) === "Int8Array";
}

export function isKeyObject(value) {
  return value instanceof KeyObject;
}

export function isMap(value) {
  return brand((v) => mapSize.call(v), value);
}

export function isMapIterator(value) {
  const info = getTrackedIteratorInfo(value);
  if (info !== undefined) return info.isMap;
  return tag(value) === "[object Map Iterator]";
}

export function isModuleNamespaceObject(value) {
  return tag(value) === "[object Module]";
}

export function isNativeError(value) {
  if (typeof Error.isError === "function") {
    if (Error.isError(value)) return true;
  } else if (value instanceof Error && tag(value) === "[object Error]") {
    return true;
  }

  // Bun treats its resolver/compiler message objects as native errors even
  // though they do not inherit from Error (oven-sh/bun#11780).
  if (value === null || typeof value !== "object" || proxyRegistry.has(value)) return false;
  if (resolveMessageConstructor === undefined && typeof globalThis.ResolveMessage === "function") {
    resolveMessageConstructor = globalThis.ResolveMessage;
  }
  if (buildMessageConstructor === undefined && typeof globalThis.BuildMessage === "function") {
    buildMessageConstructor = globalThis.BuildMessage;
  }
  for (const Constructor of [resolveMessageConstructor, buildMessageConstructor]) {
    if (Constructor === undefined) continue;
    try {
      if (functionHasInstance.call(Constructor, value)) return true;
    } catch {
      // A damaged constructor/prototype must not make a predicate throw.
    }
  }
  return false;
}

export function isNumberObject(value) {
  return typeof value === "object" && value !== null && brand((v) => numberValueOf.call(v), value);
}

export function isPromise(value) {
  if (value instanceof Promise) return true;
  // Recognize promises whose prototype was tampered with, as long as they
  // went through the tracked Promise.resolve/reject paths.
  const peekStates = globalThis.__cottontailPromisePeekStates;
  return peekStates !== undefined && typeof value === "object" && value !== null && peekStates.has(value);
}

export function isProxy(value) {
  return (value !== null && (typeof value === "object" || typeof value === "function")) && proxyRegistry.has(value);
}

export function isRegExp(value) {
  if (value === RegExp.prototype) return false;
  return (typeof value === "object" || typeof value === "function") && value !== null &&
    brand((v) => regExpSource.call(v), value);
}

export function isSet(value) {
  return brand((v) => setSize.call(v), value);
}

export function isSetIterator(value) {
  const info = getTrackedIteratorInfo(value);
  if (info !== undefined) return !info.isMap;
  return tag(value) === "[object Set Iterator]";
}

export function isSharedArrayBuffer(value) {
  if (sharedArrayBufferByteLength !== null) return brand((v) => sharedArrayBufferByteLength.call(v), value);
  return typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer;
}

export function isStringObject(value) {
  return typeof value === "object" && value !== null && brand((v) => stringValueOf.call(v), value);
}

export function isSymbolObject(value) {
  return typeof value === "object" && value !== null && brand((v) => symbolValueOf.call(v), value);
}

export function isTypedArray(value) {
  return typedArrayTag(value) !== undefined;
}

export function isUint16Array(value) {
  return typedArrayTag(value) === "Uint16Array";
}

export function isUint32Array(value) {
  return typedArrayTag(value) === "Uint32Array";
}

export function isUint8Array(value) {
  return typedArrayTag(value) === "Uint8Array";
}

export function isUint8ClampedArray(value) {
  return typedArrayTag(value) === "Uint8ClampedArray";
}

export function isWeakMap(value) {
  return brand((v) => weakMapHas.call(v, weakMapHas), value);
}

export function isWeakSet(value) {
  return brand((v) => weakSetHas.call(v, weakSetHas), value);
}

const typesDefault = {
  isAnyArrayBuffer,
  isArgumentsObject,
  isArrayBuffer,
  isArrayBufferView,
  isAsyncFunction,
  isBigInt64Array,
  isBigIntObject,
  isBigUint64Array,
  isBooleanObject,
  isBoxedPrimitive,
  isCryptoKey,
  isDataView,
  isDate,
  isEventTarget,
  isExternal,
  isFloat16Array,
  isFloat32Array,
  isFloat64Array,
  isGeneratorFunction,
  isGeneratorObject,
  isInt16Array,
  isInt32Array,
  isInt8Array,
  isKeyObject,
  isMap,
  isMapIterator,
  isModuleNamespaceObject,
  isNativeError,
  isNumberObject,
  isPromise,
  isProxy,
  isRegExp,
  isSet,
  isSetIterator,
  isSharedArrayBuffer,
  isStringObject,
  isSymbolObject,
  isTypedArray,
  isUint16Array,
  isUint32Array,
  isUint8Array,
  isUint8ClampedArray,
  isWeakMap,
  isWeakSet,
};

// Internal hook for util.inspect's iterator previews; non-enumerable so it
// never shows up when consumers enumerate the Node predicate set.
Object.defineProperty(typesDefault, "getTrackedIteratorInfo", {
  value: getTrackedIteratorInfo,
  writable: true,
  configurable: true,
});

export default typesDefault;
