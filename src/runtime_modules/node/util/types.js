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

export function getTrackedIteratorInfo(value) {
  if (value === null || typeof value !== "object") return undefined;
  return iteratorInfo.get(value);
}

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
  return brand((v) => arrayBufferByteLength.call(v), value);
}

export function isArrayBufferView(value) {
  return ArrayBuffer.isView(value);
}

const functionToString = Function.prototype.toString;

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
  if (typeof Error.isError === "function") return Error.isError(value);
  return value instanceof Error && tag(value) === "[object Error]";
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

export default {
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
