import "../bun/ffi.js";
import { Buffer as RuntimeBuffer } from "./internal/buffer-polyfill.js";

// Use the complete, Cottontail-vendored Buffer implementation for both the
// global and node:buffer. ffi.js installs an early bootstrap Buffer so modules
// can initialize before node:buffer is evaluated.
globalThis.Buffer = RuntimeBuffer;
export const Buffer = RuntimeBuffer;
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
const originalBufferByteLength = Buffer.byteLength.bind(Buffer);
const originalBufferIsEncoding = Buffer.isEncoding.bind(Buffer);
const originalBufferToString = Buffer.prototype.toString;
const originalBufferWrite = Buffer.prototype.write;
const originalBufferFill = Buffer.prototype.fill;
const originalBufferCopy = Buffer.prototype.copy;
const originalBufferLastIndexOf = Buffer.prototype.lastIndexOf;

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

Buffer.from = function from(value, encodingOrOffset, length) {
  if (typeof value === "function") {
    throw new TypeError('The first argument must be a string, Buffer, ArrayBuffer, Array, or array-like object');
  }
  if (typeof value === "string" && isBase64UrlEncoding(encodingOrOffset)) {
    return originalBufferFrom(normalizeBase64Url(value), "base64");
  }
  return originalBufferFrom(value, encodingOrOffset, length);
};

function validateHexFill(value) {
  const text = String(value);
  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(text)) {
    throw new TypeError("The argument 'value' is invalid for encoding hex");
  }
}

Buffer.alloc = function alloc(size, fill = undefined, encoding = undefined) {
  if (fill !== undefined) {
    if (encoding !== undefined && typeof encoding !== "string") {
      throw new TypeError('The "encoding" argument must be of type string');
    }
    if (isBase64UrlEncoding(encoding)) {
      return originalBufferAlloc(size, normalizeBase64Url(fill), "base64");
    }
    if (typeof encoding === "string" && encoding.toLowerCase() === "hex") validateHexFill(fill);
    if (Buffer.isBuffer(fill) && fill.length === 0) {
      throw new TypeError("The argument 'value' is invalid. Received an empty Buffer");
    }
  }
  return fill === undefined ? originalBufferAlloc(size) : originalBufferAlloc(size, fill, encoding);
};

Buffer.byteLength = function byteLength(value, encoding) {
  if (typeof value === "string" && isBase64UrlEncoding(encoding)) {
    return originalBufferByteLength(normalizeBase64Url(value), "base64");
  }
  return originalBufferByteLength(value, encoding);
};

Buffer.isEncoding = function isEncoding(encoding) {
  return isBase64UrlEncoding(encoding) || originalBufferIsEncoding(encoding);
};

Buffer.prototype.toString = function toString(encoding, start, end) {
  if (isBase64UrlEncoding(encoding)) {
    return base64UrlFromBase64(originalBufferToString.call(this, "base64", start, end));
  }
  return originalBufferToString.call(this, encoding, start, end);
};

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
  return originalBufferWrite.call(view, String(value), offset, length, encoding);
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
  if (isBase64UrlEncoding(encoding) || isBase64UrlEncoding(length) || (length === undefined && isBase64UrlEncoding(offset))) {
    if (length === undefined && typeof offset === "string") {
      return this.base64urlWrite(value, 0, this.length);
    }
    if (typeof length === "string") {
      return this.base64urlWrite(value, offset, this.length - Number(offset || 0));
    }
    const numericOffset = Number(offset || 0);
    const clampedLength = length === undefined
      ? this.length - numericOffset
      : Math.min(Number(length), this.length - numericOffset);
    return this.base64urlWrite(value, numericOffset, clampedLength);
  }
  return originalBufferWrite.call(this, value, offset, length, encoding);
};

Buffer.prototype.fill = function fill(value, start = 0, end = this.length, encoding = undefined) {
  requireByteView(this);
  if (typeof start === "string") {
    encoding = start;
    start = 0;
    end = this.length;
  } else if (typeof end === "string") {
    encoding = end;
    end = this.length;
  } else {
    if (typeof start !== "number" || typeof end !== "number") {
      throw new TypeError('The "offset" and "end" arguments must be numbers');
    }
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0 || start > this.length || end > this.length) {
    const error = new RangeError("Out of range index");
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  if (encoding !== undefined) {
    if (typeof encoding !== "string") throw new TypeError('The "encoding" argument must be of type string');
    if (!Buffer.isEncoding(encoding)) throw new TypeError(`Unknown encoding: ${encoding}`);
    if (encoding.toLowerCase() === "hex") validateHexFill(value);
    if (isBase64UrlEncoding(encoding)) {
      value = normalizeBase64Url(value);
      encoding = "base64";
    }
  }
  if (Buffer.isBuffer(value) && value.length === 0) {
    throw new TypeError("The argument 'value' is invalid. Received an empty Buffer");
  }
  return originalBufferFill.call(this, value, start, end, encoding);
};

Buffer.prototype.copy = function copy(target, targetStart, sourceStart, sourceEnd) {
  for (const [name, value] of [["targetStart", targetStart], ["sourceStart", sourceStart], ["sourceEnd", sourceEnd]]) {
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
      const error = new RangeError(`The value of "${name}" is out of range`);
      error.code = "ERR_OUT_OF_RANGE";
      throw error;
    }
  }
  return originalBufferCopy.call(this, target, targetStart, sourceStart, sourceEnd);
};

Buffer.prototype.lastIndexOf = function lastIndexOf(value, byteOffset, encoding) {
  const normalized = typeof encoding === "string" ? encoding.toLowerCase() : "";
  if (["ucs2", "ucs-2", "utf16le", "utf-16le"].includes(normalized)) {
    requireByteView(this);
    const needle = Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
    if (needle.length === 0) return Math.min(this.length, byteOffset === undefined ? this.length : Number(byteOffset));
    let offset = byteOffset === undefined ? this.length - needle.length : Number(byteOffset);
    if (!Number.isFinite(offset)) offset = this.length - needle.length;
    if (offset < 0) offset = this.length + Math.trunc(offset);
    offset = Math.min(this.length - needle.length, Math.trunc(offset));
    offset -= offset % 2;
    outer: for (let index = offset; index >= 0; index -= 2) {
      for (let needleIndex = 0; needleIndex < needle.length; needleIndex += 1) {
        if (this[index + needleIndex] !== needle[needleIndex]) continue outer;
      }
      return index;
    }
    return -1;
  }
  return originalBufferLastIndexOf.call(this, value, byteOffset, encoding);
};

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

if (Buffer && typeof Buffer.concat === "function" && !Buffer.concat.__cottontailPatched) {
  const originalConcat = Buffer.concat.bind(Buffer);
  const patchedConcat = function concat(list, totalLength) {
    if (!Array.isArray(list)) {
      const err = new TypeError('The "list" argument must be an instance of Array. Received ' +
        (list === null ? "null" : `type ${typeof list}`));
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    let length = 0;
    if (totalLength === undefined) {
      for (let index = 0; index < list.length; index += 1) {
        const item = list[index];
        length += item?.length ?? 0;
      }
    } else {
      length = Number(totalLength) || 0;
    }
    if (length >= MAX_TYPED_ARRAY_BYTES) {
      throw new RangeError(
        `Out of memory: JavaScriptCore typed arrays are currently limited to ${MAX_TYPED_ARRAY_BYTES} bytes`,
      );
    }
    try {
      return originalConcat(list, totalLength);
    } catch (error) {
      if (error instanceof RangeError && /length too large|out of memory/i.test(String(error.message))) {
        throw new RangeError(
          `Out of memory: JavaScriptCore typed arrays are currently limited to ${MAX_TYPED_ARRAY_BYTES} bytes`,
        );
      }
      throw error;
    }
  };
  patchedConcat.__cottontailPatched = true;
  Buffer.concat = patchedConcat;
}

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

export const isAscii = globalThis.cottontail.createBufferIsAscii();

export function isUtf8(input) {
  const bytes = bytesFrom(input);
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
