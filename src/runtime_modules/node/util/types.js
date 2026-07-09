const typedArrayConstructors = new Set([
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  BigInt64Array,
  BigUint64Array,
  Float32Array,
  Float64Array,
  globalThis.Float16Array,
].filter(Boolean));

function tag(value) {
  return Object.prototype.toString.call(value);
}

function isBoxed(value, name) {
  return tag(value) === `[object ${name}]` && typeof value === "object";
}

export function isAnyArrayBuffer(value) {
  return isArrayBuffer(value) || isSharedArrayBuffer(value);
}

export function isArgumentsObject(value) {
  return tag(value) === "[object Arguments]";
}

export function isArrayBuffer(value) {
  return value instanceof ArrayBuffer;
}

export function isArrayBufferView(value) {
  return ArrayBuffer.isView(value);
}

export function isAsyncFunction(value) {
  return tag(value) === "[object AsyncFunction]";
}

export function isBigInt64Array(value) {
  return typeof BigInt64Array !== "undefined" && value instanceof BigInt64Array;
}

export function isBigIntObject(value) {
  return isBoxed(value, "BigInt");
}

export function isBigUint64Array(value) {
  return typeof BigUint64Array !== "undefined" && value instanceof BigUint64Array;
}

export function isBooleanObject(value) {
  return isBoxed(value, "Boolean");
}

export function isBoxedPrimitive(value) {
  return isStringObject(value) || isNumberObject(value) || isBooleanObject(value) || isBigIntObject(value) || isSymbolObject(value);
}

export function isCryptoKey(value) {
  return typeof CryptoKey !== "undefined" && value instanceof CryptoKey;
}

export function isDataView(value) {
  return value instanceof DataView;
}

export function isDate(value) {
  return value instanceof Date;
}

export function isExternal() {
  // COTTONTAIL-COMPAT: util.types.isExternal - requires native VM object introspection; add a JSC-backed predicate.
  return false;
}

export function isFloat16Array(value) {
  return typeof Float16Array !== "undefined" && value instanceof Float16Array;
}

export function isFloat32Array(value) {
  return value instanceof Float32Array;
}

export function isFloat64Array(value) {
  return value instanceof Float64Array;
}

export function isGeneratorFunction(value) {
  return tag(value) === "[object GeneratorFunction]";
}

export function isGeneratorObject(value) {
  return tag(value) === "[object Generator]";
}

export function isInt16Array(value) {
  return value instanceof Int16Array;
}

export function isInt32Array(value) {
  return value instanceof Int32Array;
}

export function isInt8Array(value) {
  return value instanceof Int8Array;
}

export function isKeyObject() {
  // COTTONTAIL-COMPAT: util.types.isKeyObject - requires native crypto KeyObject support; connect this once node:crypto grows KeyObject.
  return false;
}

export function isMap(value) {
  return value instanceof Map;
}

export function isMapIterator(value) {
  return tag(value) === "[object Map Iterator]";
}

export function isModuleNamespaceObject(value) {
  return tag(value) === "[object Module]";
}

export function isNativeError(value) {
  return value instanceof Error;
}

export function isNumberObject(value) {
  return isBoxed(value, "Number");
}

export function isPromise(value) {
  return value instanceof Promise || (value != null && typeof value.then === "function" && typeof value.catch === "function");
}

export function isProxy() {
  // COTTONTAIL-COMPAT: util.types.isProxy - requires native proxy introspection; add a JSC-backed predicate.
  return false;
}

export function isRegExp(value) {
  return value instanceof RegExp;
}

export function isSet(value) {
  return value instanceof Set;
}

export function isSetIterator(value) {
  return tag(value) === "[object Set Iterator]";
}

export function isSharedArrayBuffer(value) {
  return typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
}

export function isStringObject(value) {
  return isBoxed(value, "String");
}

export function isSymbolObject(value) {
  return isBoxed(value, "Symbol");
}

export function isTypedArray(value) {
  return typedArrayConstructors.has(value?.constructor);
}

export function isUint16Array(value) {
  return value instanceof Uint16Array;
}

export function isUint32Array(value) {
  return value instanceof Uint32Array;
}

export function isUint8Array(value) {
  return value instanceof Uint8Array;
}

export function isUint8ClampedArray(value) {
  return value instanceof Uint8ClampedArray;
}

export function isWeakMap(value) {
  return value instanceof WeakMap;
}

export function isWeakSet(value) {
  return value instanceof WeakSet;
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
