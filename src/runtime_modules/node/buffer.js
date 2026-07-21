import "../bun/ffi.js";
import { Buffer as RuntimeBuffer } from "./internal/buffer-polyfill.js";

// Use the complete, Cottontail-vendored Buffer implementation for both the
// global and node:buffer. ffi.js installs an early bootstrap Buffer so modules
// can initialize before node:buffer is evaluated.
function invokeBufferConstructor(target, thisArgument, argumentsList, newTarget) {
  const [value, encodingOrOffset, length] = argumentsList;
  if (typeof value === "number") {
    if (typeof encodingOrOffset === "string") {
      throw invalidArgType("string", "of type string", value);
    }
    validateBufferSize(value);
    return newTarget
      ? Reflect.construct(target, argumentsList, newTarget)
      : Reflect.apply(target, thisArgument, argumentsList);
  }
  return Buffer.from(value, encodingOrOffset, length);
}

export const Buffer = new Proxy(RuntimeBuffer, {
  apply(target, thisArgument, argumentsList) {
    return invokeBufferConstructor(target, thisArgument, argumentsList);
  },
  construct(target, argumentsList, newTarget) {
    return invokeBufferConstructor(target, undefined, argumentsList, newTarget);
  },
});
globalThis.Buffer = Buffer;
export const Blob = globalThis.Blob;
export let File = globalThis.File;
export const atob = globalThis.atob;
export const btoa = globalThis.btoa;
export const INSPECT_MAX_BYTES = 50;
export const kMaxLength = 4294967296;
export const kStringMaxLength = 2147483647;
export const constants = {
  MAX_LENGTH: kMaxLength,
  MAX_STRING_LENGTH: kStringMaxLength,
};

// bun/index.js installs the final public File constructor after node:buffer is
// initialized. Keep this named export live so both APIs expose one identity.
Object.defineProperty(globalThis, "__cottontailRefreshBufferFile", {
  value(value) {
    File = value;
  },
  configurable: true,
});
queueMicrotask(() => {
  File = globalThis.File;
});

const originalBufferFrom = Buffer.from.bind(Buffer);
const originalBufferAlloc = Buffer.alloc.bind(Buffer);
const originalBufferAllocUnsafe = Buffer.allocUnsafe.bind(Buffer);
const originalBufferAllocUnsafeSlow = Buffer.allocUnsafeSlow.bind(Buffer);
const originalBufferByteLength = Buffer.byteLength.bind(Buffer);
const originalBufferIsEncoding = Buffer.isEncoding.bind(Buffer);
const originalBufferToString = Buffer.prototype.toString;
const originalBufferWrite = Buffer.prototype.write;
const originalBufferFill = Buffer.prototype.fill;
const utf8TextDecoder = typeof TextDecoder === "function" ? new TextDecoder() : null;
const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
const sharedArrayBufferByteLengthGetter = typeof SharedArrayBuffer === "function"
  ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get
  : undefined;

function nodeError(ErrorType, code, message) {
  const error = new ErrorType(message);
  error.code = code;
  return error;
}

function describeReceived(value) {
  if (value === null || value === undefined) return `Received ${value}`;
  if (typeof value === "function") return `Received function ${value.name}`;
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) === null) return "Received [Object: null prototype] {}";
    const name = value.constructor?.name;
    return name ? `Received an instance of ${name}` : `Received ${String(value)}`;
  }
  if (typeof value === "string") {
    const text = value.length > 28 ? `${value.slice(0, 25)}...` : value;
    return text.includes("'") ? `Received type string (${JSON.stringify(text)})` : `Received type string ('${text}')`;
  }
  if (typeof value === "bigint") return `Received type bigint (${value}n)`;
  return `Received type ${typeof value} (${String(value)})`;
}

function invalidArgType(name, expected, value) {
  return nodeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be ${expected}. ${describeReceived(value)}`);
}

function outOfRange(name, range, value) {
  return nodeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`);
}

function unknownEncoding(encoding) {
  return nodeError(TypeError, "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${encoding}`);
}

function validateInteger(value, name, minimum, maximum, infinityIsInteger = true) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  const invalidInteger = Number.isNaN(value) || (Number.isFinite(value) ? !Number.isInteger(value) : infinityIsInteger);
  if (invalidInteger) {
    throw outOfRange(name, "an integer", value);
  }
  if (value < minimum || value > maximum) {
    throw outOfRange(name, `>= ${minimum} and <= ${maximum}`, value);
  }
  return value;
}

function invalidBufferFrom(value) {
  return nodeError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    "The first argument must be of type string, Buffer, ArrayBuffer, Array, or Array-like Object. " + describeReceived(value),
  );
}

function validateBufferSize(size) {
  if (typeof size !== "number") throw invalidArgType("size", "of type number", size);
  if (Number.isNaN(size) || size < 0 || size > kMaxLength) {
    throw outOfRange("size", `>= 0 && <= ${kMaxLength}`, size);
  }
  return size;
}

function getArrayBufferByteLength(value) {
  try {
    return arrayBufferByteLengthGetter.call(value);
  } catch {}
  if (sharedArrayBufferByteLengthGetter) {
    try {
      return sharedArrayBufferByteLengthGetter.call(value);
    } catch {}
  }
  return undefined;
}

function bufferSourceBytes(value) {
  if (ArrayBuffer.isView(value)) {
    try {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } catch {
      throw nodeError(TypeError, "ERR_INVALID_STATE", "Cannot validate on a detached ArrayBuffer");
    }
  }
  if (getArrayBufferByteLength(value) !== undefined) {
    try {
      return new Uint8Array(value);
    } catch {
      throw nodeError(TypeError, "ERR_INVALID_STATE", "Cannot validate on a detached ArrayBuffer");
    }
  }
  throw invalidArgType("input", "an instance of ArrayBuffer, Buffer, or TypedArray", value);
}

function isUint8Array(value) {
  return Buffer.isBuffer(value) || Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function compareBytes(left, leftStart, leftEnd, right, rightStart, rightEnd) {
  const length = Math.min(leftEnd - leftStart, rightEnd - rightStart);
  for (let index = 0; index < length; index += 1) {
    const leftByte = left[leftStart + index];
    const rightByte = right[rightStart + index];
    if (leftByte !== rightByte) return leftByte < rightByte ? -1 : 1;
  }
  const leftLength = leftEnd - leftStart;
  const rightLength = rightEnd - rightStart;
  return leftLength === rightLength ? 0 : leftLength < rightLength ? -1 : 1;
}

function normalizeBase64Url(value) {
  let text = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const remainder = text.length % 4;
  if (remainder !== 0) text += "=".repeat(4 - remainder);
  return text;
}

function base64UrlFromBase64(value) {
  return String(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isBase64UrlEncoding(value) {
  return typeof value === "string" && value.toLowerCase() === "base64url";
}

function isHexEncoding(value) {
  return typeof value === "string" && value.toLowerCase() === "hex";
}

function hexNibble(code) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function validHexPrefix(value) {
  let end = 0;
  while (end + 1 < value.length) {
    if (hexNibble(value.charCodeAt(end)) < 0 || hexNibble(value.charCodeAt(end + 1)) < 0) break;
    end += 2;
  }
  return end === value.length ? value : value.slice(0, end);
}

Buffer.from = function from(value, encodingOrOffset, length) {
  const valueType = typeof value;
  if (value == null || (valueType !== "string" && valueType !== "object")) {
    throw invalidBufferFrom(value);
  }
  try {
    if (typeof value === "string" && isBase64UrlEncoding(encodingOrOffset)) {
      return originalBufferFrom(normalizeBase64Url(value), "base64");
    }
    if (typeof value === "string" && isHexEncoding(encodingOrOffset)) {
      return originalBufferFrom(validHexPrefix(value), "hex");
    }
    return originalBufferFrom(value, encodingOrOffset, length);
  } catch (error) {
    if (typeof value === "string" && error instanceof TypeError && /Unknown encoding/.test(error.message)) {
      throw unknownEncoding(encodingOrOffset);
    }
    const arrayBuffer = getArrayBufferByteLength(value) !== undefined;
    if (arrayBuffer && error instanceof RangeError && /^"(?:offset|length)" is outside of buffer bounds$/.test(error.message)) {
      error.code = "ERR_BUFFER_OUT_OF_BOUNDS";
      throw error;
    }
    if (error instanceof TypeError && !arrayBuffer && !ArrayBuffer.isView(value)) {
      throw invalidBufferFrom(value);
    }
    throw error;
  }
};

Buffer.copyBytesFrom = function copyBytesFrom(view, offset = 0, length = undefined) {
  if (!ArrayBuffer.isView(view) || typeof view.BYTES_PER_ELEMENT !== "number") {
    throw invalidArgType("view", "of type TypedArray", view);
  }
  validateInteger(offset, "offset", 0, Number.MAX_SAFE_INTEGER);
  if (length === undefined) length = view.length - offset;
  validateInteger(length, "length", 0, Number.MAX_SAFE_INTEGER);
  const start = Math.min(offset, view.length);
  const count = Math.min(length, view.length - start);
  const bytesPerElement = view.BYTES_PER_ELEMENT;
  const bytes = new Uint8Array(view.buffer, view.byteOffset + start * bytesPerElement, count * bytesPerElement);
  return originalBufferFrom(bytes);
};

function validateHexFill(value) {
  const text = String(value);
  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(text)) {
    throw nodeError(TypeError, "ERR_INVALID_ARG_VALUE", "The argument 'value' is invalid for encoding hex");
  }
}

function fillBufferPattern(target, pattern, start, end) {
  const length = end - start;
  if (length <= 0) return target;
  if (pattern.length === 1) {
    Uint8Array.prototype.fill.call(target, pattern[0], start, end);
    return target;
  }

  let filled = Math.min(pattern.length, length);
  Uint8Array.prototype.set.call(target, pattern.subarray(0, filled), start);
  while (filled < length) {
    const copyLength = Math.min(filled, length - filled);
    Uint8Array.prototype.set.call(target, target.subarray(start, start + copyLength), start + filled);
    filled += copyLength;
  }
  return target;
}

function tryFastBufferFill(target, value, start, end, encoding) {
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    Uint8Array.prototype.fill.call(target, Number(value) & 0xff, start, end);
    return true;
  }

  let pattern;
  if (typeof value === "string") {
    if (value.length === 0) {
      Uint8Array.prototype.fill.call(target, 0, start, end);
      return true;
    }
    pattern = originalBufferFrom(value, encoding);
  } else if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    pattern = value;
  } else {
    return false;
  }
  if (pattern.length === 0) return false;
  fillBufferPattern(target, pattern, start, end);
  return true;
}

Buffer.alloc = function alloc(size, fill = undefined, encoding = undefined) {
  validateBufferSize(size);
  if (fill !== undefined) {
    if (encoding !== undefined && typeof encoding !== "string") {
      throw invalidArgType("encoding", "of type string", encoding);
    }
    if (isBase64UrlEncoding(encoding)) {
      return originalBufferAlloc(size, normalizeBase64Url(fill), "base64");
    }
    if (typeof encoding === "string" && encoding.toLowerCase() === "hex") validateHexFill(fill);
    if (Buffer.isBuffer(fill) && fill.length === 0) {
      throw nodeError(TypeError, "ERR_INVALID_ARG_VALUE", "The argument 'value' is invalid. Received an empty Buffer");
    }
  }
  const output = originalBufferAlloc(size);
  if (fill === undefined || tryFastBufferFill(output, fill, 0, output.length, encoding)) return output;
  return originalBufferAlloc(size, fill, encoding);
};

Buffer.allocUnsafe = function allocUnsafe(size) {
  validateBufferSize(size);
  return originalBufferAllocUnsafe(size);
};

Buffer.allocUnsafeSlow = function allocUnsafeSlow(size) {
  validateBufferSize(size);
  return originalBufferAllocUnsafeSlow(size);
};

Buffer.byteLength = function byteLength(value, encoding) {
  if (typeof value !== "string") {
    if (ArrayBuffer.isView(value)) return value.byteLength;
    const length = getArrayBufferByteLength(value);
    if (length !== undefined) return length;
    throw invalidArgType("string", "of type string or an instance of Buffer or ArrayBuffer", value);
  }
  if (typeof value === "string" && isBase64UrlEncoding(encoding)) {
    return originalBufferByteLength(normalizeBase64Url(value), "base64");
  }
  if ((encoding == null || encoding === "" || /^(?:utf8|utf-8)$/i.test(String(encoding))) &&
      /^[\x00-\x7f]*$/.test(value)) {
    return value.length;
  }
  return originalBufferByteLength(value, encoding);
};

Buffer.isEncoding = function isEncoding(encoding) {
  return isBase64UrlEncoding(encoding) || originalBufferIsEncoding(encoding);
};

Buffer.compare = function compare(buf1, buf2) {
  if (!isUint8Array(buf1)) throw invalidArgType("buf1", "of type Buffer or Uint8Array", buf1);
  if (!isUint8Array(buf2)) throw invalidArgType("buf2", "of type Buffer or Uint8Array", buf2);
  return compareBytes(buf1, 0, buf1.length, buf2, 0, buf2.length);
};

function validateCompareIndex(value, name, maximum) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < 0 || value > maximum) throw outOfRange(name, `>= 0 and <= ${maximum}`, value);
  return value;
}

Buffer.prototype.compare = function compare(target, targetStart = 0, targetEnd = target?.length, sourceStart = 0, sourceEnd = this.length) {
  if (!isUint8Array(target)) throw invalidArgType("target", "of type Buffer or Uint8Array", target);
  targetStart = validateCompareIndex(targetStart, "targetStart", 0xffffffff);
  targetEnd = validateCompareIndex(targetEnd, "targetEnd", target.length);
  sourceStart = validateCompareIndex(sourceStart, "sourceStart", this.length);
  sourceEnd = validateCompareIndex(sourceEnd, "sourceEnd", this.length);
  const clampedTargetStart = Math.min(targetStart, target.length);
  if (sourceStart >= sourceEnd && clampedTargetStart >= targetEnd) return 0;
  if (sourceStart >= sourceEnd) return -1;
  if (clampedTargetStart >= targetEnd) return 1;
  return compareBytes(this, sourceStart, sourceEnd, target, clampedTargetStart, targetEnd);
};

Buffer.prototype.equals = function equals(otherBuffer) {
  if (!isUint8Array(otherBuffer)) {
    throw invalidArgType("otherBuffer", "of type Buffer or Uint8Array", otherBuffer);
  }
  return this === otherBuffer || compareBytes(this, 0, this.length, otherBuffer, 0, otherBuffer.length) === 0;
};

Buffer.prototype.toString = function toString(encoding, start, end) {
  if (encoding !== undefined) {
    encoding = String(encoding);
    if (!Buffer.isEncoding(encoding)) throw unknownEncoding(encoding);
  }
  if (isBase64UrlEncoding(encoding)) {
    return base64UrlFromBase64(originalBufferToString.call(this, "base64", start, end));
  }
  if (utf8TextDecoder != null && start === undefined && end === undefined &&
      (encoding === undefined || encoding.toLowerCase() === "utf8" || encoding.toLowerCase() === "utf-8")) {
    const nativeDecoded = globalThis.cottontail?.icuDecode?.("UTF-8", this, false);
    if (nativeDecoded !== null && nativeDecoded !== undefined) return nativeDecoded;
    return utf8TextDecoder.decode(this);
  }
  return originalBufferToString.call(this, encoding, start, end);
};

function currentInspectMaxBytes() {
  const exported = globalThis.__cottontailBuiltinModules?.get?.("buffer");
  const value = exported?.INSPECT_MAX_BYTES;
  return typeof value === "number" && value >= 0 && !Number.isNaN(value) ? value : INSPECT_MAX_BYTES;
}

const patchedInspectExports = new WeakSet();

function patchMutableInspectExport(moduleExports) {
  if ((typeof moduleExports !== "object" && typeof moduleExports !== "function") || moduleExports === null) return;
  if (patchedInspectExports.has(moduleExports) || moduleExports.Buffer !== Buffer) return;
  let value = moduleExports.INSPECT_MAX_BYTES;
  Object.defineProperty(moduleExports, "INSPECT_MAX_BYTES", {
    get() {
      return value;
    },
    set(nextValue) {
      if (typeof nextValue !== "number") throw invalidArgType("value", "of type number", nextValue);
      if (Number.isNaN(nextValue) || nextValue < 0) {
        throw outOfRange("value", "a non-negative number", nextValue);
      }
      value = nextValue;
    },
    enumerable: true,
    configurable: true,
  });
  patchedInspectExports.add(moduleExports);
}

function installInspectExportBridge() {
  const marker = Symbol.for("cottontail.buffer.mutableInspectExport");
  const install = (map) => {
    if (!map || typeof map.set !== "function" || map[marker]) return;
    const originalSet = map.set;
    Object.defineProperty(map, marker, { value: true, configurable: true });
    Object.defineProperty(map, "set", {
      value(name, moduleExports) {
        if (name === "buffer" || name === "node:buffer") patchMutableInspectExport(moduleExports);
        return Reflect.apply(originalSet, this, [name, moduleExports]);
      },
      writable: true,
      configurable: true,
    });
    patchMutableInspectExport(map.get?.("buffer"));
    patchMutableInspectExport(map.get?.("node:buffer"));
  };

  if (globalThis.__cottontailBuiltinModules) {
    install(globalThis.__cottontailBuiltinModules);
    return;
  }
  let map;
  Object.defineProperty(globalThis, "__cottontailBuiltinModules", {
    get() {
      return map;
    },
    set(value) {
      map = value;
      install(value);
      Object.defineProperty(globalThis, "__cottontailBuiltinModules", {
        value,
        writable: true,
        configurable: true,
      });
    },
    configurable: true,
  });
}

function isBufferIndexKey(key, length) {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function inspectBuffer(depth, options, inspect) {
  const maximum = Math.min(this.length, currentInspectMaxBytes());
  const hex = originalBufferToString.call(this, "hex", 0, maximum).replace(/(.{2})/g, "$1 ").trim();
  const remaining = this.length - maximum;
  const bytes = remaining > 0
    ? `${hex}${hex ? " " : ""}... ${remaining} more byte${remaining === 1 ? "" : "s"}`
    : hex;
  const properties = [];
  for (const key of Object.keys(this)) {
    if (isBufferIndexKey(key, this.length)) continue;
    const value = typeof inspect === "function"
      ? inspect(this[key], { ...options, depth: options?.depth == null ? options?.depth : options.depth - 1 })
      : String(this[key]);
    properties.push(`${key}: ${value}`);
  }
  return `<Buffer ${[bytes, ...properties].filter(Boolean).join(", ")}>`;
}

Buffer.prototype.inspect = inspectBuffer;
Buffer.prototype[customInspectSymbol] = inspectBuffer;
installInspectExportBridge();

function bufferBoundsError() {
  const error = new RangeError("Attempt to access memory outside buffer bounds");
  error.code = "ERR_BUFFER_OUT_OF_BOUNDS";
  return error;
}

function requireByteView(value) {
  if (!ArrayBuffer.isView(value) || typeof value.byteLength !== "number") {
    throw new TypeError("Buffer method called on incompatible receiver");
  }
  return value;
}

function normalizeWriteRange(view, rawOffset = 0, rawLength = undefined) {
  let offset = Number(rawOffset);
  if (!Number.isFinite(offset)) offset = 0;
  offset = Math.trunc(offset);
  if (offset < 0 || offset > view.length) throw bufferBoundsError();

  const available = view.length - offset;
  let length = rawLength === undefined ? available : Number(rawLength);
  if (!Number.isFinite(length)) length = 0;
  length = Math.trunc(length);
  if (length < 0) throw bufferBoundsError();
  // Bun clamps coercible objects but rejects an explicitly oversized numeric
  // length in these low-level methods.
  if (typeof rawLength === "number" && length > available) throw bufferBoundsError();
  return { offset, length: Math.min(length, available) };
}

function writeEncoded(view, value, rawOffset, rawLength, encoding) {
  requireByteView(view);
  const { offset, length } = normalizeWriteRange(view, rawOffset, rawLength);
  let input = String(value);
  if (encoding === "hex") input = validHexPrefix(input);
  return originalBufferWrite.call(view, input, offset, length, encoding);
}

Buffer.prototype.utf8Write = function utf8Write(value, offset = 0, length = undefined) {
  return writeEncoded(this, value, offset, length, "utf8");
};
Buffer.prototype.asciiWrite = function asciiWrite(value, offset = 0, length = undefined) {
  return writeEncoded(this, value, offset, length, "ascii");
};
Buffer.prototype.latin1Write = function latin1Write(value, offset = 0, length = undefined) {
  return writeEncoded(this, value, offset, length, "latin1");
};
Buffer.prototype.base64Write = function base64Write(value, offset = 0, length = undefined) {
  return writeEncoded(this, value, offset, length, "base64");
};
Buffer.prototype.base64urlWrite = function base64urlWrite(value, offset = 0, length = undefined) {
  return writeEncoded(this, normalizeBase64Url(value), offset, length, "base64");
};
Buffer.prototype.ucs2Write = Buffer.prototype.utf16leWrite = function utf16leWrite(value, offset = 0, length = undefined) {
  return writeEncoded(this, value, offset, length, "utf16le");
};
Buffer.prototype.utf16beWrite = function utf16beWrite(value, rawOffset = 0, rawLength = undefined) {
  requireByteView(this);
  const { offset, length } = normalizeWriteRange(this, rawOffset, rawLength);
  const source = originalBufferFrom(String(value), "utf16le");
  const written = Math.min(length - (length % 2), source.length - (source.length % 2));
  for (let index = 0; index < written; index += 2) {
    this[offset + index] = source[index + 1];
    this[offset + index + 1] = source[index];
  }
  return written;
};
Buffer.prototype.hexWrite = function hexWrite(value, offset = 0, length = undefined) {
  return writeEncoded(this, value, offset, length, "hex");
};

Buffer.prototype.write = function write(value, offset, length, encoding) {
  if (typeof offset === "string" && length !== undefined) {
    const error = new TypeError(`The "offset" argument must be of type number. Received type string ('${offset}')`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (offset !== undefined && typeof offset !== "string") {
    validateInteger(offset, "offset", 0, this.length);
  }
  const numericOffset = typeof offset === "number" ? offset : 0;
  if (length !== undefined && typeof length !== "string") {
    validateInteger(length, "length", 0, this.length);
  }
  const selectedEncoding = typeof offset === "string"
    ? offset
    : typeof length === "string"
      ? length
      : encoding;
  if (typeof selectedEncoding === "string" && !Buffer.isEncoding(selectedEncoding)) {
    throw unknownEncoding(selectedEncoding);
  }
  if (isBase64UrlEncoding(encoding) || isBase64UrlEncoding(length) || (length === undefined && isBase64UrlEncoding(offset))) {
    if (length === undefined && typeof offset === "string") {
      return this.base64urlWrite(value, 0, this.length);
    }
    if (typeof length === "string") {
      return this.base64urlWrite(value, offset, this.length - Number(offset || 0));
    }
    const clampedLength = length === undefined
      ? this.length - numericOffset
      : Math.min(Number(length), this.length - numericOffset);
    return this.base64urlWrite(value, numericOffset, clampedLength);
  }
  if (typeof value === "string" && isHexEncoding(selectedEncoding)) {
    value = validHexPrefix(value);
  }
  return originalBufferWrite.call(this, value, offset, length, encoding);
};

Buffer.prototype.fill = function fill(value, start = 0, end = this.length, encoding = undefined) {
  requireByteView(this);
  if (value === "" || (Array.isArray(value) && value.length === 0)) value = 0;
  if (typeof start === "string") {
    encoding = start;
    start = 0;
    end = this.length;
  } else if (typeof end === "string") {
    encoding = end;
    end = this.length;
  } else {
    if (typeof start !== "number") throw invalidArgType("offset", "of type number", start);
    if (typeof end !== "number") throw invalidArgType("end", "of type number", end);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0 || start > this.length || end > this.length) {
    const error = new RangeError("Out of range index");
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  if (encoding !== undefined) {
    if (typeof encoding !== "string") throw invalidArgType("encoding", "of type string", encoding);
    if (!Buffer.isEncoding(encoding)) throw unknownEncoding(encoding);
    if (encoding.toLowerCase() === "hex") validateHexFill(value);
    if (isBase64UrlEncoding(encoding)) {
      value = normalizeBase64Url(value);
      encoding = "base64";
    }
  }
  if (Buffer.isBuffer(value) && value.length === 0) {
    throw nodeError(TypeError, "ERR_INVALID_ARG_VALUE", "The argument 'value' is invalid. Received an empty Buffer");
  }
  if (tryFastBufferFill(this, value, start, end, encoding)) return this;
  return originalBufferFill.call(this, value, start, end, encoding);
};

function coerceCopyIndex(value, fallback) {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  return Number.isNaN(numeric) ? 0 : Math.floor(numeric);
}

Buffer.prototype.copy = function copy(target, targetStart, sourceStart, sourceEnd) {
  if (!isUint8Array(this)) {
    throw nodeError(TypeError, "ERR_INVALID_THIS", "Value of this must be of type Buffer or Uint8Array");
  }
  if (!isUint8Array(target)) throw invalidArgType("target", "of type Buffer or Uint8Array", target);

  targetStart = coerceCopyIndex(targetStart, 0);
  sourceStart = coerceCopyIndex(sourceStart, 0);
  sourceEnd = coerceCopyIndex(sourceEnd, this.length);
  if (targetStart < 0 || targetStart > 0xffffffff) {
    throw outOfRange("targetStart", `>= 0 and <= ${target.length}`, targetStart);
  }
  if (sourceStart < 0 || sourceStart > this.length || sourceStart > 0xffffffff) {
    throw outOfRange("sourceStart", `>= 0 and <= ${this.length}`, sourceStart);
  }
  if (sourceEnd < 0 || sourceEnd > 0xffffffff) {
    throw outOfRange("sourceEnd", `>= 0 and <= ${this.length}`, sourceEnd);
  }
  if (sourceEnd <= sourceStart || targetStart >= target.length || this.length === 0 || target.length === 0) return 0;

  const count = Math.min(sourceEnd, this.length) - sourceStart;
  const copied = Math.min(count, target.length - targetStart);
  if (copied <= 0) return 0;
  const source = this.subarray(sourceStart, sourceStart + copied);
  Uint8Array.prototype.set.call(target, source, targetStart);
  return copied;
};

function isUtf16Encoding(encoding) {
  if (typeof encoding !== "string") return false;
  return ["ucs2", "ucs-2", "utf16le", "utf-16le"].includes(encoding.toLowerCase());
}

function normalizeEmptySearchOffset(byteOffset, length, forward) {
  let offset = Number(byteOffset);
  if (Number.isNaN(offset)) offset = forward ? 0 : length;
  else offset = Math.trunc(offset);
  if (offset < 0) offset += length;
  return Math.max(0, Math.min(length, offset));
}

function normalizeSearchOffset(byteOffset, length, forward) {
  let offset = Number(byteOffset);
  if (Number.isNaN(offset)) offset = forward ? 0 : length - 1;
  else offset = Math.trunc(offset);
  if (offset < 0) offset += length;
  if (forward) return offset < 0 ? 0 : offset >= length ? -1 : offset;
  return offset < 0 ? -1 : Math.min(offset, length - 1);
}

function bytesMatch(buffer, needle, offset) {
  for (let index = 1; index < needle.length; index += 1) {
    if (buffer[offset + index] !== needle[index]) return false;
  }
  return true;
}

const byteSearchDecoder = new TextDecoder("latin1");

function searchBuffer(buffer, value, byteOffset, encoding, forward) {
  if (!isUint8Array(buffer)) {
    throw nodeError(TypeError, "ERR_INVALID_THIS", "Value of this must be of type Buffer or Uint8Array");
  }
  if (typeof byteOffset === "string") {
    encoding = byteOffset;
    byteOffset = undefined;
  }

  if (typeof value === "number") {
    const offset = normalizeSearchOffset(byteOffset, buffer.length, forward);
    if (offset < 0) return -1;
    const byte = value & 0xff;
    return forward
      ? Uint8Array.prototype.indexOf.call(buffer, byte, offset)
      : Uint8Array.prototype.lastIndexOf.call(buffer, byte, offset);
  }

  let needle;
  if (typeof value === "string") needle = Buffer.from(value, encoding);
  else if (isUint8Array(value)) needle = value;
  else throw invalidArgType("value", "of type number, string, Buffer, or Uint8Array", value);

  if (needle.length === 0) return normalizeEmptySearchOffset(byteOffset, buffer.length, forward);
  if (needle.length > buffer.length || buffer.length === 0) return -1;

  const wide = isUtf16Encoding(encoding);
  if (wide && (buffer.length < 2 || needle.length < 2)) return -1;
  let offset = normalizeSearchOffset(byteOffset, buffer.length, forward);
  if (offset < 0) return -1;
  const maximum = buffer.length - needle.length;
  if (!forward) offset = Math.min(offset, maximum);
  if (wide) {
    offset = Math.floor(offset / 2) * 2;
    if (forward) {
      for (let index = offset; index <= maximum; index += 2) {
        if (buffer[index] === needle[0] && bytesMatch(buffer, needle, index)) return index;
      }
    } else {
      for (let index = offset; index >= 0; index -= 2) {
        if (buffer[index] === needle[0] && bytesMatch(buffer, needle, index)) return index;
      }
    }
    return -1;
  }

  const haystack = byteSearchDecoder.decode(buffer);
  const pattern = byteSearchDecoder.decode(needle);
  return forward ? haystack.indexOf(pattern, offset) : haystack.lastIndexOf(pattern, offset);
}

const searchMethods = {
  indexOf(value, byteOffset, encoding) {
    return searchBuffer(this, value, byteOffset, encoding, true);
  },
  lastIndexOf(value, byteOffset, encoding) {
    return searchBuffer(this, value, byteOffset, encoding, false);
  },
  includes(value, byteOffset, encoding) {
    return searchBuffer(this, value, byteOffset, encoding, true) !== -1;
  },
};
Buffer.prototype.indexOf = searchMethods.indexOf;
Buffer.prototype.lastIndexOf = searchMethods.lastIndexOf;
Buffer.prototype.includes = searchMethods.includes;

function normalizeSliceRange(view, rawStart = 0, rawEnd = undefined, strict = false) {
  requireByteView(view);
  let start = Number(rawStart);
  if (!Number.isFinite(start)) start = 0;
  start = Math.trunc(start);
  let end = rawEnd === undefined ? view.length : Math.trunc(Number(rawEnd));
  if (!Number.isFinite(end)) end = 0;
  if (strict && (start < 0 || start > view.length || end < 0 || end > view.length)) throw bufferBoundsError();
  start = Math.max(0, Math.min(view.length, start));
  end = Math.max(0, Math.min(view.length, end));
  return { start, end };
}

function sliceString(view, encoding, rawStart, rawEnd, strict = false) {
  const { start, end } = normalizeSliceRange(view, rawStart, rawEnd, strict);
  if (end <= start) return "";
  return originalBufferToString.call(view, encoding, start, end);
}

Buffer.prototype.asciiSlice = function asciiSlice(start = 0, end = undefined) {
  return sliceString(this, "ascii", start, end);
};
Buffer.prototype.latin1Slice = function latin1Slice(start = 0, end = undefined) {
  return sliceString(this, "latin1", start, end, end !== undefined);
};
Buffer.prototype.utf8Slice = function utf8Slice(start = 0, end = undefined) {
  return sliceString(this, "utf8", start, end);
};
Buffer.prototype.hexSlice = function hexSlice(start = 0, end = undefined) {
  const { start: normalizedStart, end: normalizedEnd } = normalizeSliceRange(this, start, end);
  if ((normalizedEnd - normalizedStart) * 2 > kStringMaxLength) {
    throw new RangeError(`Cannot create a string longer than ${kStringMaxLength} characters`);
  }
  return sliceString(this, "hex", normalizedStart, normalizedEnd);
};
Buffer.prototype.ucs2Slice = Buffer.prototype.utf16leSlice = function utf16leSlice(start = 0, end = undefined) {
  return sliceString(this, "utf16le", start, end);
};
Buffer.prototype.base64Slice = function base64Slice(start = 0, end = undefined) {
  return sliceString(this, "base64", start, end);
};
Buffer.prototype.base64urlSlice = function base64urlSlice(start = 0, end = undefined) {
  return base64UrlFromBase64(sliceString(this, "base64", start, end));
};

function validateNumericOffset(view, rawOffset, byteLength, infinityIsInteger = true) {
  requireByteView(view);
  const offset = rawOffset;
  if (typeof offset !== "number") throw invalidArgType("offset", "of type number", offset);
  const invalidInteger = Number.isNaN(offset) || (Number.isFinite(offset) ? !Number.isInteger(offset) : infinityIsInteger);
  if (invalidInteger) throw outOfRange("offset", "an integer", offset);
  if (view.length < byteLength) throw bufferBoundsError();
  const maximum = view.length - byteLength;
  if (offset < 0 || offset > maximum) throw outOfRange("offset", `>= 0 and <= ${maximum}`, offset);
  return offset;
}

function validateByteLength(byteLength) {
  return validateInteger(byteLength, "byteLength", 1, 6, false);
}

const fixedReadMethods = [
  ["readUInt8", 1], ["readInt8", 1],
  ["readUInt16LE", 2], ["readUInt16BE", 2], ["readInt16LE", 2], ["readInt16BE", 2],
  ["readUInt32LE", 4], ["readUInt32BE", 4], ["readInt32LE", 4], ["readInt32BE", 4],
];

for (const [name, byteLength] of fixedReadMethods) {
  const original = Buffer.prototype[name];
  Buffer.prototype[name] = function readInteger(offset = 0) {
    offset = validateNumericOffset(this, offset, byteLength);
    return original.call(this, offset);
  };
}

for (const name of ["readUIntLE", "readUIntBE", "readIntLE", "readIntBE"]) {
  const original = Buffer.prototype[name];
  Buffer.prototype[name] = function readVariableInteger(offset, byteLength) {
    byteLength = validateByteLength(byteLength);
    offset = validateNumericOffset(this, offset, byteLength);
    return original.call(this, offset, byteLength);
  };
}

function readFloatingPoint(view, rawOffset, byteLength, littleEndian) {
  const offset = validateNumericOffset(view, rawOffset, byteLength);
  const dataView = new DataView(view.buffer, view.byteOffset, view.byteLength);
  return byteLength === 4
    ? dataView.getFloat32(offset, littleEndian)
    : dataView.getFloat64(offset, littleEndian);
}

Buffer.prototype.readFloatLE = function readFloatLE(offset = 0) {
  return readFloatingPoint(this, offset, 4, true);
};
Buffer.prototype.readFloatBE = function readFloatBE(offset = 0) {
  return readFloatingPoint(this, offset, 4, false);
};
Buffer.prototype.readDoubleLE = function readDoubleLE(offset = 0) {
  return readFloatingPoint(this, offset, 8, true);
};
Buffer.prototype.readDoubleBE = function readDoubleBE(offset = 0) {
  return readFloatingPoint(this, offset, 8, false);
};

function integerValueRange(signed, byteLength) {
  const bits = byteLength * 8;
  if (signed) {
    const limit = 2 ** (bits - 1);
    return {
      minimum: -limit,
      maximum: limit - 1,
      description: byteLength > 4 ? `>= -(2 ** ${bits - 1}) and < 2 ** ${bits - 1}` : `>= ${-limit} and <= ${limit - 1}`,
    };
  }
  const limit = 2 ** bits;
  return {
    minimum: 0,
    maximum: limit - 1,
    description: byteLength > 4 ? `>= 0 and < 2 ** ${bits}` : `>= 0 and <= ${limit - 1}`,
  };
}

function validateIntegerWriteValue(value, signed, byteLength) {
  let numeric;
  try {
    numeric = +value;
  } catch {
    return;
  }
  const range = integerValueRange(signed, byteLength);
  if (numeric < range.minimum || numeric > range.maximum) {
    throw outOfRange("value", range.description, value);
  }
}

const fixedWriteMethods = [
  ["writeUInt8", 1, false], ["writeInt8", 1, true],
  ["writeUInt16LE", 2, false], ["writeUInt16BE", 2, false],
  ["writeInt16LE", 2, true], ["writeInt16BE", 2, true],
  ["writeUInt32LE", 4, false], ["writeUInt32BE", 4, false],
  ["writeInt32LE", 4, true], ["writeInt32BE", 4, true],
];

for (const [name, byteLength, signed] of fixedWriteMethods) {
  const original = Buffer.prototype[name];
  Buffer.prototype[name] = function writeInteger(value, offset = 0) {
    validateIntegerWriteValue(value, signed, byteLength);
    offset = validateNumericOffset(this, offset, byteLength);
    return original.call(this, value, offset);
  };
}

for (const [name, signed] of [["writeUIntLE", false], ["writeUIntBE", false], ["writeIntLE", true], ["writeIntBE", true]]) {
  const original = Buffer.prototype[name];
  Buffer.prototype[name] = function writeVariableInteger(value, offset, byteLength) {
    byteLength = validateByteLength(byteLength);
    validateIntegerWriteValue(value, signed, byteLength);
    offset = validateNumericOffset(this, offset, byteLength, false);
    return original.call(this, value, offset, byteLength);
  };
}

function writeFloatingPoint(view, value, rawOffset, byteLength, littleEndian) {
  const offset = validateNumericOffset(view, rawOffset, byteLength, false);
  const dataView = new DataView(view.buffer, view.byteOffset, view.byteLength);
  if (byteLength === 4) dataView.setFloat32(offset, Number(value), littleEndian);
  else dataView.setFloat64(offset, Number(value), littleEndian);
  return offset + byteLength;
}

Buffer.prototype.writeFloatLE = function writeFloatLE(value, offset = 0) {
  return writeFloatingPoint(this, value, offset, 4, true);
};
Buffer.prototype.writeFloatBE = function writeFloatBE(value, offset = 0) {
  return writeFloatingPoint(this, value, offset, 4, false);
};
Buffer.prototype.writeDoubleLE = function writeDoubleLE(value, offset = 0) {
  return writeFloatingPoint(this, value, offset, 8, true);
};
Buffer.prototype.writeDoubleBE = function writeDoubleBE(value, offset = 0) {
  return writeFloatingPoint(this, value, offset, 8, false);
};

for (const name of ["readBigUInt64LE", "readBigUInt64BE", "readBigInt64LE", "readBigInt64BE"]) {
  const original = Buffer.prototype[name];
  Buffer.prototype[name] = function readBigInteger(offset = 0) {
    offset = validateNumericOffset(this, offset, 8);
    return original.call(this, offset);
  };
}

for (const [name, signed] of [
  ["writeBigUInt64LE", false], ["writeBigUInt64BE", false],
  ["writeBigInt64LE", true], ["writeBigInt64BE", true],
]) {
  const original = Buffer.prototype[name];
  Buffer.prototype[name] = function writeBigInteger(value, offset = 0) {
    if (typeof value !== "bigint") throw invalidArgType("value", "of type bigint", value);
    const minimum = signed ? -(1n << 63n) : 0n;
    const maximum = signed ? (1n << 63n) - 1n : (1n << 64n) - 1n;
    if (value < minimum || value > maximum) {
      const range = signed ? ">= -(2n ** 63n) and < 2n ** 63n" : ">= 0n and < 2n ** 64n";
      throw outOfRange("value", range, `${value}n`);
    }
    offset = validateNumericOffset(this, offset, 8);
    return original.call(this, value, offset);
  };
}

for (const [alias, canonical] of [
  ["readUint8", "readUInt8"], ["readUintBE", "readUIntBE"], ["readUintLE", "readUIntLE"],
  ["readUint16BE", "readUInt16BE"], ["readUint16LE", "readUInt16LE"],
  ["readUint32BE", "readUInt32BE"], ["readUint32LE", "readUInt32LE"],
  ["readBigUint64BE", "readBigUInt64BE"], ["readBigUint64LE", "readBigUInt64LE"],
  ["writeUint8", "writeUInt8"], ["writeUintBE", "writeUIntBE"], ["writeUintLE", "writeUIntLE"],
  ["writeUint16BE", "writeUInt16BE"], ["writeUint16LE", "writeUInt16LE"],
  ["writeUint32BE", "writeUInt32BE"], ["writeUint32LE", "writeUInt32LE"],
  ["writeBigUint64BE", "writeBigUInt64BE"], ["writeBigUint64LE", "writeBigUInt64LE"],
]) {
  Buffer.prototype[alias] = Buffer.prototype[canonical];
}

Buffer.prototype.toLocaleString = Buffer.prototype.toString;

// JavaScriptCore typed arrays cannot exceed this many bytes; Bun surfaces the
// engine's message when Buffer.concat would exceed it. Mirror that here since
// our fallback allocation errors ("length too large") differ from Bun's.
const MAX_TYPED_ARRAY_BYTES = 4294967296;

Buffer.concat = function concat(list, totalLength) {
  if (!Array.isArray(list)) throw invalidArgType("list", "of type Array", list);
  for (let index = 0; index < list.length; index += 1) {
    if (!isUint8Array(list[index])) {
      throw invalidArgType(`list[${index}]`, "of type Buffer or Uint8Array", list[index]);
    }
  }
  if (list.length === 0) return Buffer.alloc(0);

  let length;
  if (totalLength === undefined) {
    length = 0;
    for (const item of list) length += item.length;
  } else {
    length = validateInteger(totalLength, "totalLength", 0, kMaxLength);
  }
  if (length >= MAX_TYPED_ARRAY_BYTES) {
    throw new RangeError(
      `Out of memory: JavaScriptCore typed arrays are currently limited to ${MAX_TYPED_ARRAY_BYTES} bytes`,
    );
  }

  const result = Buffer.alloc(length);
  let offset = 0;
  for (const item of list) {
    if (offset >= length) break;
    const count = Math.min(item.length, length - offset);
    Uint8Array.prototype.set.call(result, item.subarray(0, count), offset);
    offset += count;
  }
  return result;
};

if (Buffer && typeof Buffer.isEncoding !== "function") {
  const knownEncodings = new Set([
    "utf8", "utf-8",
    "hex",
    "base64", "base64url",
    "ascii",
    "latin1", "binary",
    "ucs2", "ucs-2",
    "utf16le", "utf-16le",
  ]);
  Buffer.isEncoding = function isEncoding(encoding) {
    return typeof encoding === "string" && encoding.length !== 0 && knownEncodings.has(encoding.toLowerCase());
  };
}

if (Buffer && typeof Buffer.of !== "function") {
  Buffer.of = function of(...items) {
    return Buffer.from(items);
  };
}

function bytesFrom(value) {
  if (value == null) return new Uint8Array(0);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value));
}

function normalizedEncoding(encoding = "utf8") {
  const text = String(encoding || "utf8").toLowerCase().replace(/[-_]/g, "");
  if (text === "utf8" || text === "utf") return "utf8";
  if (text === "utf16le" || text === "ucs2") return "utf16le";
  if (text === "latin1" || text === "binary") return "latin1";
  if (text === "ascii") return "ascii";
  if (text === "base64") return "base64";
  if (text === "hex") return "hex";
  return "utf8";
}

function stringFromBytes(bytes, encoding = "utf8") {
  return Buffer.from(bytes).toString(normalizedEncoding(encoding));
}

export function SlowBuffer(size) {
  return Buffer.allocUnsafe(Number(size) || 0);
}

const nativeIsAscii = globalThis.cottontail.createBufferIsAscii();
export const isAscii = new Proxy(nativeIsAscii, {
  apply(target, thisArgument, [input]) {
    bufferSourceBytes(input);
    return Reflect.apply(target, thisArgument, [input]);
  },
});

export function isUtf8(input) {
  const bytes = bufferSourceBytes(input);
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    if (first <= 0x7f) continue;
    let needed = 0;
    let codePoint = 0;
    if ((first & 0xe0) === 0xc0) {
      needed = 1;
      codePoint = first & 0x1f;
      if (codePoint === 0) return false;
    } else if ((first & 0xf0) === 0xe0) {
      needed = 2;
      codePoint = first & 0x0f;
    } else if ((first & 0xf8) === 0xf0) {
      needed = 3;
      codePoint = first & 0x07;
    } else {
      return false;
    }
    if (index + needed > bytes.length) return false;
    for (let offset = 0; offset < needed; offset += 1) {
      const next = bytes[index++];
      if ((next & 0xc0) !== 0x80) return false;
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return false;
    if (needed === 1 && codePoint < 0x80) return false;
    if (needed === 2 && codePoint < 0x800) return false;
    if (needed === 3 && codePoint < 0x10000) return false;
  }
  return true;
}

function transcodeImplementation(source, fromEncoding, toEncoding) {
  return Buffer.from(stringFromBytes(bytesFrom(source), fromEncoding), normalizedEncoding(toEncoding));
}

Object.defineProperty(globalThis, "__cottontailBufferTranscodeImplementation", {
  value: transcodeImplementation,
  configurable: true,
});

export const transcode = globalThis.cottontail.createBufferTranscode();

export function resolveObjectURL(id) {
  if (typeof globalThis.resolveObjectURL === "function") return globalThis.resolveObjectURL(id);
  return undefined;
}

export default {
  Blob,
  Buffer,
  File,
  INSPECT_MAX_BYTES,
  SlowBuffer,
  atob,
  btoa,
  constants,
  isAscii,
  isUtf8,
  kMaxLength,
  kStringMaxLength,
  resolveObjectURL,
  transcode,
};
