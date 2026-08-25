const cottontailExecPath = cottontail.execPath?.() ?? "cottontail";
const platform = () => cottontail.platform();
const pointerKeepalive = [];
const ffiTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
const stringFromBytes = bytes => ffiTextDecoder.decode(bytes);

export const FFIType = {
  0: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  11: 11,
  12: 12,
  13: 13,
  14: 14,
  15: 15,
  16: 16,
  17: 17,
  bool: 11,
  c_int: 5,
  c_uint: 6,
  char: 0,
  "char*": 12,
  double: 9,
  f32: 10,
  f64: 9,
  float: 10,
  i16: 3,
  i32: 5,
  i64: 7,
  i8: 1,
  int: 5,
  int16_t: 3,
  int32_t: 5,
  int64_t: 7,
  int8_t: 1,
  isize: 7,
  u16: 4,
  u32: 6,
  u64: 8,
  u8: 2,
  uint16_t: 4,
  uint32_t: 6,
  uint64_t: 8,
  uint8_t: 2,
  usize: 8,
  "void*": 12,
  ptr: 12,
  pointer: 12,
  void: 13,
  cstring: 14,
  i64_fast: 15,
  u64_fast: 16,
  function: 17,
  callback: 17,
  fn: 17,
  napi_env: 18,
  napi_value: 19,
  buffer: 20,
};

export const suffix = platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";

const ffiNativeTypes = [
  "i8",
  "i8",
  "u8",
  "i16",
  "u16",
  "i32",
  "u32",
  "i64",
  "u64",
  "f64",
  "f32",
  "bool",
  "ptr",
  "void",
  "cstring",
  "i64",
  "u64",
  "function",
  "napi_env",
  "napi_value",
  "ptr",
];

const ffiCTypeNames = [
  "char",
  "int8_t",
  "uint8_t",
  "int16_t",
  "uint16_t",
  "int32_t",
  "uint32_t",
  "int64_t",
  "uint64_t",
  "double",
  "float",
  "bool",
  "void *",
  "void",
  "char *",
  "int64_t",
  "uint64_t",
  "void *",
  "napi_env",
  "napi_value",
  "void *",
];

const ffiTypeAliases = {
  size_t: FFIType.usize,
  ssize_t: FFIType.isize,
};

const supportedFFITypes = Object.keys(FFIType).filter((name) => !/^\d+$/.test(name)).sort().join(", ");

function ffiTypeId(type, fallback = undefined) {
  if (type == null && fallback !== undefined) return fallback;
  if (typeof type === "number" && Number.isInteger(type) && type >= 0 && type < ffiNativeTypes.length) return type;
  if (typeof type === "string") {
    const value = Object.prototype.hasOwnProperty.call(FFIType, type) ? FFIType[type] : ffiTypeAliases[type];
    if (typeof value === "number") return value;
  }
  throw new TypeError(`Unsupported type ${String(type)}. Must be one of: ${supportedFFITypes}`);
}

function normalizeLibraryPath(value) {
  if (value && typeof value === "object") {
    if (value instanceof URL) value = value.href;
    else if (typeof value._bunFilePath === "string") value = value._bunFilePath;
    else if (typeof value.href === "string") value = value.href;
    else if (typeof value.name === "string") value = value.name;
  }
  if (typeof value !== "string") throw new TypeError("Expected string");
  const path = value;
  if (!path.startsWith("file:")) return path;
  const url = new URL(path);
  if (url.protocol !== "file:") return path;
  let pathname = decodeURIComponent(url.pathname);
  if (platform() === "win32" && /^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
  return pathname;
}

function invalidPointer(message) {
  const error = new TypeError(message);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function isBufferSource(value) {
  return value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer) ||
    ArrayBuffer.isView(value);
}

function keepPointerAlive(value) {
  pointerKeepalive.push(value);
  if (pointerKeepalive.length > 4096) pointerKeepalive.splice(0, 1024);
}

export function ptr(value, byteOffset) {
  if (!isBufferSource(value)) {
    throw invalidPointer(`Expected ArrayBufferView but received ${value == null ? "null" : Object.prototype.toString.call(value)}`);
  }
  if (value.byteLength === 0) {
    throw invalidPointer("ArrayBufferView must have a length > 0. A pointer to empty memory doesn't work");
  }
  let offset = 0;
  if (byteOffset !== undefined && byteOffset !== null) {
    if (typeof byteOffset !== "number" || !Number.isFinite(byteOffset)) {
      throw invalidPointer("Expected number for byteOffset");
    }
    offset = Math.trunc(byteOffset);
  }
  if (offset > value.byteLength) throw invalidPointer("byteOffset out of bounds");
  keepPointerAlive(value);
  const address = Number(cottontail.memoryAddress(value)) + offset;
  if (!Number.isFinite(address) || address <= 0) throw invalidPointer("Pointer must not be 0");
  return address;
}

function pointerNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalidPointer(value === 0
      ? "ptr cannot be zero, that would segfault Bun :("
      : "ptr must be a number.");
  }
  return value;
}

function pointerOffset(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidPointer("Expected number for byteOffset");
  return Math.trunc(value);
}

function pointerLength(value, explicit) {
  if (!explicit) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidPointer("length must be a number.");
  const length = Math.trunc(value);
  if (length <= 0) throw invalidPointer("length must be > 0. This usually means a bug in your code.");
  if (!Number.isSafeInteger(length)) {
    throw invalidPointer("length exceeds max addressable memory. This usually means a bug in your code.");
  }
  return length;
}

function memoryUntilNul(pointer, offset = 0) {
  const chunkSize = 4096;
  const maxLength = 8 * 1024 * 1024;
  for (let length = 0; length < maxLength; length += chunkSize) {
    const chunk = new Uint8Array(cottontail.memoryView(pointer, offset + length, Math.min(chunkSize, maxLength - length)));
    const nul = chunk.indexOf(0);
    if (nul >= 0) return length + nul;
  }
  throw new RangeError("CString exceeds the 8 MiB safety limit");
}

const pointerViewFinalizers = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ address, callback, context }) => {
      try {
        cottontail.nativeCallPointer(callback, "void", ["ptr", "ptr"], [address, context]);
      } catch {}
    })
  : null;

function finalizerPointer(value, label, allowNull = false) {
  if (value instanceof JSCallback) value = value.ptr;
  if (allowNull && (value === undefined || value === null)) return 0;
  if ((typeof value !== "number" && typeof value !== "bigint") || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw new TypeError(`Expected ${label} to be a C pointer (number or BigInt)`);
  }
  return Number(value);
}

export function toArrayBuffer(pointer, byteOffset = undefined, byteLength = undefined, finalizationCtxOrPtr = undefined, finalizationCallback = undefined) {
  const address = pointerNumber(pointer);
  const offset = pointerOffset(byteOffset);
  const explicitLength = arguments.length >= 3 && byteLength !== undefined && byteLength !== null;
  const length = pointerLength(byteLength, explicitLength) ?? memoryUntilNul(address, offset);
  const arrayBuffer = cottontail.memoryView(address, offset, length);
  if (finalizationCtxOrPtr != null || finalizationCallback != null) {
    if (!pointerViewFinalizers) throw new Error("FinalizationRegistry is unavailable in this JavaScriptCore build");
    const callback = finalizerPointer(finalizationCallback ?? finalizationCtxOrPtr, "callback");
    const context = finalizationCallback == null ? 0 : finalizerPointer(finalizationCtxOrPtr, "user data", true);
    pointerViewFinalizers.register(arrayBuffer, { address: address + offset, callback, context });
  }
  return arrayBuffer;
}

export function toBuffer(pointer, byteOffset = undefined, byteLength = undefined, finalizationCtxOrPtr = undefined, finalizationCallback = undefined) {
  const arrayBuffer = toArrayBuffer(pointer, byteOffset, byteLength, finalizationCtxOrPtr, finalizationCallback);
  return globalThis.Buffer.from(arrayBuffer);
}

function dataView(pointer, byteLength, offset = 0) {
  return new DataView(cottontail.memoryView(pointerNumber(pointer), pointerOffset(offset), byteLength));
}

export const read = {
  u8(pointer, offset = 0) { return dataView(pointer, 1, offset).getUint8(0); },
  u16(pointer, offset = 0) { return dataView(pointer, 2, offset).getUint16(0, true); },
  u32(pointer, offset = 0) { return dataView(pointer, 4, offset).getUint32(0, true); },
  ptr(pointer, offset = 0) { return Number(dataView(pointer, 8, offset).getBigUint64(0, true)); },
  i8(pointer, offset = 0) { return dataView(pointer, 1, offset).getInt8(0); },
  i16(pointer, offset = 0) { return dataView(pointer, 2, offset).getInt16(0, true); },
  i32(pointer, offset = 0) { return dataView(pointer, 4, offset).getInt32(0, true); },
  i64(pointer, offset = 0) { return dataView(pointer, 8, offset).getBigInt64(0, true); },
  u64(pointer, offset = 0) { return dataView(pointer, 8, offset).getBigUint64(0, true); },
  intptr(pointer, offset = 0) { return Number(dataView(pointer, 8, offset).getBigInt64(0, true)); },
  f32(pointer, offset = 0) { return dataView(pointer, 4, offset).getFloat32(0, true); },
  f64(pointer, offset = 0) { return dataView(pointer, 8, offset).getFloat64(0, true); },
};

function readCString(pointer) {
  const address = pointerNumber(pointer);
  const length = memoryUntilNul(address);
  return stringFromBytes(new Uint8Array(cottontail.memoryView(address, 0, length)));
}

const cstringArrayBuffers = new WeakMap();

class CStringImpl extends String {
  constructor(value, byteOffset, byteLength) {
    const pointer = value == null ? 0 : value;
    let text = "";
    if (pointer !== 0) {
      const address = pointerNumber(pointer);
      const offset = pointerOffset(byteOffset);
      if (byteLength === undefined || byteLength === null) {
        text = readCString(address + offset);
      } else {
        const length = pointerLength(byteLength, true);
        text = stringFromBytes(new Uint8Array(cottontail.memoryView(address, offset, length)));
      }
    }
    super(text);
    this.ptr = typeof pointer === "number" ? pointer : 0;
    this.byteOffset = byteOffset;
    this.byteLength = byteLength;
  }

  get arrayBuffer() {
    const cached = cstringArrayBuffers.get(this);
    if (cached) return cached;
    const arrayBuffer = !this.ptr
      ? new ArrayBuffer(0)
      : toArrayBuffer(this.ptr, this.byteOffset ?? 0, this.byteLength);
    cstringArrayBuffers.set(this, arrayBuffer);
    return arrayBuffer;
  }
}

// Called without `new`, Bun.FFI.CString returns the decoded string as a
// primitive instead of throwing a class-constructor error (issue #25231).
export const CString = new Proxy(CStringImpl, {
  apply(target, thisArg, args) {
    return String(Reflect.construct(target, args));
  },
});

const callbackState = new WeakMap();

export class JSCallback {
  constructor(fn, options) {
    if (typeof fn !== "function") throw new TypeError("Expected callback to be a function");
    options ??= {};
    if (options == null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Expected callback options to be an object");
    }
    const argIds = functionArgs(options.args);
    const returnId = ffiTypeId(options.returns, FFIType.void);
    const threadsafe = Boolean(options.threadsafe);
    const callback = (...args) => {
      const converted = args.map((value, index) => callbackValue(value, argIds[index] ?? FFIType.ptr));
      return nativeArg(fn(...converted), returnId);
    };
    const pointer = cottontail.createCallback(callback, argIds.map((id) => ffiNativeTypes[id]), ffiNativeTypes[returnId], threadsafe);
    if (typeof pointer !== "number" || pointer <= 0) throw new Error("failed to create FFI callback");
    this.ptr = pointer;
    callbackState.set(this, { callback, pointer, threadsafe });
  }

  get threadsafe() {
    return callbackState.get(this)?.threadsafe ?? false;
  }

  [Symbol.toPrimitive]() {
    return typeof this.ptr === "number" ? this.ptr : 0;
  }

  close() {
    const state = callbackState.get(this);
    const pointer = this.ptr;
    this.ptr = null;
    if (!state || !pointer) return;
    callbackState.delete(this);
    cottontail.closeCallback?.(pointer);
  }

  [Symbol.dispose]() {
    this.close();
  }
}

function functionArgs(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('Expected "args" to be an array');
  return value.map((type) => ffiTypeId(type));
}

function exactNativeInteger(value) {
  const text = value.toString();
  return {
    toString() { return text; },
    [Symbol.toPrimitive](hint) {
      if (hint === "number") throw new TypeError("exact 64-bit integer");
      return text;
    },
  };
}

function nativeWord(value, bits, signed) {
  let bigint;
  try {
    bigint = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value) || 0));
  } catch {
    bigint = 0n;
  }
  const word = BigInt.asUintN(bits, bigint);
  return word <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(word) : exactNativeInteger(word);
}

function pointerArgument(value, functionPointer = false) {
  if (value == null) return null;
  if (value instanceof JSCallback || value instanceof CString) value = value.ptr;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Unable to convert ${String(value)} to a pointer`);
    return value;
  }
  if (functionPointer && typeof value === "bigint") return Number(value);
  if (ArrayBuffer.isView(value)) return value;
  if (isBufferSource(value) && !ArrayBuffer.isView(value)) return ptr(value);
  if (typeof value === "string") throw new TypeError("To convert a string to a pointer, encode it as a buffer");
  if (functionPointer && value && (typeof value.ptr === "number" || typeof value.ptr === "bigint")) {
    return Number(value.ptr);
  }
  throw new TypeError(functionPointer
    ? "Expected function to be a JSCallback or a number"
    : `Unable to convert ${String(value)} to a pointer`);
}

function nativeArg(value, type) {
  const id = typeof type === "number" ? type : ffiTypeId(type);
  switch (id) {
    case 0:
    case 1:
      return nativeWord(Number(value) | 0, 8, true);
    case 2: {
      const number = Number(value) || 0;
      return number < 0 ? 0 : number >= 255 ? 255 : number | 0;
    }
    case 3: {
      const number = Number(value) || 0;
      return nativeWord(number <= -32768 ? -32768 : number >= 32768 ? 32768 : number | 0, 16, true);
    }
    case 4: {
      const number = typeof value === "bigint" ? Number(value) : Number(value);
      const integer = number | 0;
      return integer <= 0 ? 0 : integer > 0xffff ? 0xffff : integer;
    }
    case 5:
      return nativeWord(Number(value) | 0, 32, true);
    case 6: {
      const number = Number(value) || 0;
      return number < 0 ? 0 : number > 0xffffffff ? 0xffffffff : number >>> 0;
    }
    case 7:
      return nativeWord(value, 64, true);
    case 8:
      return nativeWord(typeof value === "bigint" ? value : Math.max(0, Number(value) || 0), 64, false);
    case 9:
      return typeof value === "bigint" ? Number(value) : Number(value) || 0;
    case 10:
      return Math.fround(Number(value) || 0);
    case 11:
      return Boolean(value);
    case 12:
    case 14:
      return pointerArgument(value);
    case 13:
      return undefined;
    case 15: {
      if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(-Number.MAX_SAFE_INTEGER)) {
        return nativeWord(Number(value), 64, true);
      }
      return nativeWord(value, 64, true);
    }
    case 16: {
      if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= 0n) {
        return Number(value);
      }
      return nativeWord(typeof value === "bigint" ? value : Math.max(0, Number(value) || 0), 64, false);
    }
    case 17:
      return pointerArgument(value, true);
    case 18:
    case 19:
      return value;
    case 20:
      if (!ArrayBuffer.isView(value)) throw new TypeError("Expected a TypedArray");
      return value;
    default:
      return value;
  }
}

function callbackValue(value, type) {
  switch (type) {
    case 7:
    case 8:
      return typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value) || 0));
    case 15:
    case 16:
      return value;
    case 11:
      return Boolean(value);
    case 12:
    case 17:
      return value ? Number(value) : null;
    default:
      return value;
  }
}

function validateSymbolOptions(symbols) {
  if (symbols == null || typeof symbols !== "object" || Array.isArray(symbols)) {
    throw new TypeError("Expected an options object with symbol names");
  }
  const entries = Object.entries(symbols);
  if (entries.length === 0) throw new TypeError("Expected at least one symbol");
  return entries;
}

function symbolSpec(name, value, requirePointer) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Symbol "${name}" must be an object`);
  }
  const args = functionArgs(value.args);
  const returns = ffiTypeId(value.returns, FFIType.void);
  let pointer;
  if (requirePointer) {
    pointer = value.ptr ?? value.pointer;
    if ((typeof pointer !== "number" && typeof pointer !== "bigint") || !Number.isFinite(Number(pointer)) || Number(pointer) <= 0) {
      throw new TypeError(`Symbol "${name}" is missing a "ptr" field. When using linkSymbols() or CFunction(), you must provide a "ptr" field with the memory address of the native function.`);
    }
    pointer = Number(pointer);
  }
  return { args, returns, pointer };
}

function preparedArityWrapper(prepared, count, returnsCString) {
  if (returnsCString) {
    switch (count) {
      case 0: return function () { return new CString(prepared() || 0); };
      case 1: return function (a) { return new CString(prepared(a) || 0); };
      case 2: return function (a, b) { return new CString(prepared(a, b) || 0); };
      case 3: return function (a, b, c) { return new CString(prepared(a, b, c) || 0); };
      case 4: return function (a, b, c, d) { return new CString(prepared(a, b, c, d) || 0); };
      case 5: return function (a, b, c, d, e) { return new CString(prepared(a, b, c, d, e) || 0); };
      case 6: return function (a, b, c, d, e, f) { return new CString(prepared(a, b, c, d, e, f) || 0); };
      case 7: return function (a, b, c, d, e, f, h) { return new CString(prepared(a, b, c, d, e, f, h) || 0); };
      case 8: return function (a, b, c, d, e, f, h, i) { return new CString(prepared(a, b, c, d, e, f, h, i) || 0); };
      default: return function (...args) { return new CString(prepared(...args) || 0); };
    }
  }

  const fastCall = prepared.__cottontailFastCall;
  switch (count) {
    case 0: return function () { return prepared(); };
    case 1: return typeof fastCall === "function"
      ? function (a) { return typeof a === "number" ? fastCall(a) : prepared(a); }
      : function (a) { return prepared(a); };
    case 2: return function (a, b) { return prepared(a, b); };
    case 3: return function (a, b, c) { return prepared(a, b, c); };
    case 4: return function (a, b, c, d) { return prepared(a, b, c, d); };
    case 5: return function (a, b, c, d, e) { return prepared(a, b, c, d, e); };
    case 6: return function (a, b, c, d, e, f) { return prepared(a, b, c, d, e, f); };
    case 7: return function (a, b, c, d, e, f, h) { return prepared(a, b, c, d, e, f, h); };
    case 8: return function (a, b, c, d, e, f, h, i) { return prepared(a, b, c, d, e, f, h, i); };
    default: return function (...args) { return prepared(...args); };
  }
}

function ffiCallable(name, spec, pointer, napiIdentity = undefined) {
  const prepared = cottontail.prepareNativeCall(
    pointer,
    spec.returns,
    spec.args,
    napiIdentity,
    JSCallback,
    CString,
  );
  const returnsCString = spec.returns === FFIType.cstring;
  const nativeFunction = preparedArityWrapper(prepared, spec.args.length, returnsCString);
  const wrapped = spec.args.length > 0 || returnsCString
    ? preparedArityWrapper(prepared, spec.args.length, returnsCString)
    : nativeFunction;
  Object.defineProperty(nativeFunction, "name", { value: name, configurable: true });
  if (wrapped !== nativeFunction) Object.defineProperty(wrapped, "name", { value: name, configurable: true });
  wrapped.native = nativeFunction;
  nativeFunction.native = nativeFunction;
  return wrapped;
}

function closeHandle() {
  let closed = false;
  return function close() {
    if (closed) return undefined;
    closed = true;
    return undefined;
  };
}

function wrapLibraryError(error, libraryPath, symbolName = undefined) {
  const detail = String(error?.message ?? error);
  if (/dlopen|failed to open|cannot open|no such file|image not found/i.test(detail)) {
    throw new Error(`Failed to open library "${libraryPath}": ${detail}`);
  }
  if (symbolName) throw new Error(`Symbol "${symbolName}" not found in library "${libraryPath}": ${detail}`);
  throw error;
}

function defineSymbol(target, name, value) {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function dlopen(path, symbols) {
  const libraryPath = normalizeLibraryPath(path);
  const wrapped = {};
  for (const [name, value] of validateSymbolOptions(symbols)) {
    const spec = symbolSpec(name, value, false);
    let pointer;
    try {
      pointer = Number(cottontail.nativeSymbol(libraryPath, name));
    } catch (error) {
      wrapLibraryError(error, libraryPath, name);
    }
    const callable = ffiCallable(name, spec, pointer, libraryPath);
    callable.ptr = pointer;
    callable.native.ptr = pointer;
    defineSymbol(wrapped, name, callable);
  }
  return { symbols: wrapped, close: closeHandle() };
}

let cFunctionId = 0;

export function CFunction(pointerOrSpec, options = {}) {
  const value = pointerOrSpec && typeof pointerOrSpec === "object" && !(pointerOrSpec instanceof ArrayBuffer) && !ArrayBuffer.isView(pointerOrSpec)
    ? pointerOrSpec
    : { ptr: pointerOrSpec, ...options };
  const name = `CFunction${cFunctionId++}`;
  const spec = symbolSpec(name, value, true);
  const callable = ffiCallable(name, spec, spec.pointer);
  callable.ptr = spec.pointer;
  callable.native.ptr = spec.pointer;
  callable.close = closeHandle();
  callable[Symbol.dispose] = callable.close;
  return callable;
}

export function linkSymbols(symbols) {
  const wrapped = {};
  for (const [name, value] of validateSymbolOptions(symbols)) {
    const spec = symbolSpec(name, value, true);
    const callable = ffiCallable(name, spec, spec.pointer);
    callable.ptr = spec.pointer;
    callable.native.ptr = spec.pointer;
    defineSymbol(wrapped, name, callable);
  }
  return { symbols: wrapped, close: closeHandle() };
}

function pathJoin(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

function pathDirname(value) {
  const path = String(value ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  const slash = path.lastIndexOf("/");
  if (slash < 0) return ".";
  if (slash === 0) return "/";
  return path.slice(0, slash);
}

function tmpRoot() {
  const env = globalThis.process?.env ?? cottontail.env();
  const base = String(env.COTTONTAIL_TMP_DIR || env.TMPDIR || env.TEMP || env.TMP || "/tmp");
  const dir = pathJoin(base, "cottontail", "bun-ffi-cc");
  cottontail.mkdirSync(dir, true);
  return dir;
}

function compilerCommand() {
  const env = globalThis.process?.env ?? cottontail.env();
  if (env.CC) return { file: env.CC, prefix: [], kind: "cc" };
  const zigName = platform() === "win32" ? "zig.exe" : "zig";
  const executableDir = pathDirname(globalThis.process?.execPath ?? cottontailExecPath);
  const roots = [
    env.COTTONTAIL_REPO_ROOT,
    cottontail.cwd(),
    pathDirname(pathDirname(executableDir)),
    pathDirname(executableDir),
  ];
  for (const root of roots) {
    if (!root) continue;
    const zig = pathJoin(root, "vendors", "zig", zigName);
    if (cottontail.existsSync(zig)) return { file: zig, prefix: ["cc"], kind: "zig" };
  }
  const pathZig = globalThis.Bun?.which?.(platform() === "win32" ? "zig" : zigName);
  if (pathZig) return { file: pathZig, prefix: ["cc"], kind: "zig" };
  return { file: "cc", prefix: [], kind: "cc" };
}

function sourcePathForCc(source) {
  let text = source;
  if (text && typeof text === "object") text = normalizeLibraryPath(text);
  text = String(text ?? "");
  if (text.startsWith("file:")) text = normalizeLibraryPath(text);
  if (cottontail.existsSync(text)) return text;
  const path = pathJoin(tmpRoot(), `source-${Date.now()}-${Math.floor(Math.random() * 1000000)}.c`);
  cottontail.writeFile(path, text);
  return path;
}

function ccArguments(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

// Match Bun's embedded TinyCC default include/library search paths so headers
// like <node/node_api.h> installed under /usr/local or Homebrew are found when
// compiling through the system compiler (zig cc / clang), which does not search
// these directories by default.
function systemCcSearchFlags() {
  const flags = [];
  const addInclude = dir => {
    if (dir && cottontail.existsSync(dir)) flags.push(`-I${dir}`);
  };
  const addLibrary = dir => {
    if (dir && cottontail.existsSync(dir)) flags.push(`-L${dir}`);
  };
  const platformName = platform();
  if (platformName === "darwin" && cottontail.arch() === "arm64") {
    addInclude("/opt/homebrew/include");
    addLibrary("/opt/homebrew/lib");
  }
  if (platformName !== "win32") {
    addInclude("/usr/local/include");
    addLibrary("/usr/local/lib");
  }
  return flags;
}

function windowsNapiImportLibrary(compiler, sourcePaths, dir) {
  if (platform() !== "win32" || compiler.kind !== "zig") return null;
  const names = new Set();
  for (const sourcePath of sourcePaths) {
    const source = String(cottontail.readFile(sourcePath));
    for (const match of source.matchAll(/\b(?:napi|node_api)_[A-Za-z0-9_]+\b/g)) {
      names.add(match[0]);
    }
  }
  if (names.size === 0) return null;

  const id = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const definitionPath = pathJoin(dir, `cottontail-napi-${id}.def`);
  const libraryPath = pathJoin(dir, `cottontail-napi-${id}.lib`);
  const executableName = String(globalThis.process?.execPath ?? "cottontail.exe")
    .replaceAll("\\", "/")
    .split("/")
    .pop();
  cottontail.writeFile(
    definitionPath,
    `LIBRARY ${JSON.stringify(executableName)}\nEXPORTS\n${[...names].sort().map(name => `  ${name}`).join("\n")}\n`,
  );
  const result = cottontail.spawnSync(
    compiler.file,
    ["dlltool", "-d", definitionPath, "-l", libraryPath, "-m", "i386:x86-64"],
    { stdio: "pipe" },
  );
  if (Number(result.status ?? 0) !== 0) {
    throw new Error(String(result.stderr || result.stdout || `Bun.cc import library failed with status ${result.status}`));
  }
  return libraryPath;
}

export function cc(options) {
  if (options == null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Expected options to be an object");
  }
  const source = options.source ?? options.file ?? options.path;
  const symbols = options.symbols ?? options.exports;
  if (source == null) throw new TypeError("Expected source to be a string to a file path");
  if (symbols == null || typeof symbols !== "object") throw new TypeError('Bun.cc requires a "symbols" object');

  const dir = tmpRoot();
  const output = pathJoin(dir, `libcc-${Date.now()}-${Math.floor(Math.random() * 1000000)}.${suffix}`);
  const sourcePaths = (Array.isArray(source) ? source : [source]).map(sourcePathForCc);
  if (sourcePaths.length === 0) throw new TypeError("Expected source to be a string to a file path");
  const compiler = compilerCommand();
  const napiImportLibrary = windowsNapiImportLibrary(compiler, sourcePaths, dir);
  const platformName = platform();
  const sharedArgs = platformName === "darwin"
    ? ["-dynamiclib", "-undefined", "dynamic_lookup"]
    : platformName === "win32"
      ? ["-shared"]
      : ["-shared", "-fPIC"];
  const defines = Object.entries(options.define || {}).map(([name, value]) => `-D${name}=${value == null ? "1" : String(value)}`);
  const includeDirs = ccArguments(options.include).map(dir => `-I${dir}`);
  const args = [
    ...compiler.prefix,
    ...sourcePaths,
    ...(napiImportLibrary ? [napiImportLibrary] : []),
    ...sharedArgs,
    ...includeDirs,
    ...systemCcSearchFlags(),
    ...defines,
    "-o",
    output,
    ...ccArguments(options.flags),
    ...ccArguments(options.args),
  ].map(String);
  const result = cottontail.spawnSync(compiler.file, args, { stdio: "pipe" });
  if (Number(result.status ?? 0) !== 0) {
    throw new Error(String(result.stderr || result.stdout || `Bun.cc failed with status ${result.status}`));
  }
  try {
    return dlopen(output, symbols);
  } catch (error) {
    const message = String(error?.message ?? error);
    const missing = /Symbol "([^"]+)" not found/.exec(message);
    if (missing) throw new Error(`Symbol "${missing[1]}" is missing from the compiled library`);
    throw error;
  }
}

const nativeDlopen = function dlopen(path) {
  return dlopen(path, arguments[1]);
};

export const native = {
  dlopen: nativeDlopen,
  callback() {
    throw new Error("Deprecated. Use new JSCallback(options, fn) instead");
  },
};

function cIdentifier(value) {
  const identifier = String(value).replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(identifier) ? `_${identifier}` : identifier;
}

function ffiSource(name, value, callback) {
  const spec = symbolSpec(name, value, false);
  const returnType = ffiCTypeNames[spec.returns];
  const params = spec.args.length === 0
    ? "void"
    : spec.args.map((type, index) => `${ffiCTypeNames[type]} arg${index}`).join(", ");
  const declaration = `${returnType} ${cIdentifier(name)}(${params});`;
  return [
    "/* Generated by Cottontail bun:ffi.viewSource(). */",
    "#include <stdbool.h>",
    "#include <stdint.h>",
    "#include <stddef.h>",
    "typedef void *napi_env;",
    "typedef void *napi_value;",
    callback ? "/* Callback ABI declaration used by the libffi closure. */" : "/* Dynamic-library symbol declaration used by libffi. */",
    declaration,
    "",
  ].join("\n");
}

export function viewSource(value, isCallback = false) {
  if (isCallback) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Expected an object");
    }
    return ffiSource("my_callback_function", value, true);
  }
  return validateSymbolOptions(value).map(([name, spec]) => ffiSource(name, spec, false));
}

export default {
  CFunction,
  CString,
  FFIType,
  JSCallback,
  cc,
  dlopen,
  linkSymbols,
  native,
  ptr,
  read,
  suffix,
  toArrayBuffer,
  toBuffer,
  viewSource,
};
