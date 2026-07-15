import "../bun/ffi.js";

export const Buffer = globalThis.Buffer;
export const Blob = globalThis.Blob;
export const File = globalThis.File;
export const atob = globalThis.atob;
export const btoa = globalThis.btoa;
export const INSPECT_MAX_BYTES = 50;
export const kMaxLength = Number.MAX_SAFE_INTEGER;
export const kStringMaxLength = 536870888;
export const constants = {
  MAX_LENGTH: kMaxLength,
  MAX_STRING_LENGTH: kStringMaxLength,
};

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

export function isAscii(input) {
  return bytesFrom(input).every((byte) => byte <= 0x7f);
}

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

export function transcode(source, fromEncoding, toEncoding) {
  return Buffer.from(stringFromBytes(bytesFrom(source), fromEncoding), normalizedEncoding(toEncoding));
}

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
