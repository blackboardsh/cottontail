import constantsObject from "./constants.js";

const supportedHashes = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"];

function normalizeAlgorithm(algorithm) {
  const normalized = String(algorithm).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "sha" || normalized === "sha1") return "sha1";
  if (normalized.endsWith("sha1")) return "sha1";
  if (normalized.endsWith("sha224")) return "sha224";
  if (normalized.endsWith("sha256")) return "sha256";
  if (normalized.endsWith("sha384")) return "sha384";
  if (normalized.endsWith("sha512")) return "sha512";
  if (normalized === "md5" || normalized.endsWith("md5")) return "md5";
  return normalized;
}

function bytesFromData(data, encoding = undefined) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === "string") {
    if (encoding === "hex") {
      const bytes = new Uint8Array(Math.floor(data.length / 2));
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(data.slice(index * 2, index * 2 + 2), 16);
      }
      return bytes;
    }
    return new TextEncoder().encode(data);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data));
}

function concatBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function hexFromBytes(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlFromBase64(value) {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function digestBytes(algorithm, data) {
  const normalized = normalizeAlgorithm(algorithm);
  if (!supportedHashes.includes(normalized)) {
    throw new Error(`Digest algorithm is not supported in Cottontail yet: ${algorithm}`);
  }
  if (typeof cottontail.cryptoHashSync !== "function") {
    throw new Error("native crypto hashing is unavailable");
  }
  return new Uint8Array(cottontail.cryptoHashSync(normalized, data));
}

function hmacBytes(algorithm, key, data) {
  const normalized = normalizeAlgorithm(algorithm);
  if (!supportedHashes.includes(normalized)) {
    throw new Error(`HMAC algorithm is not supported in Cottontail yet: ${algorithm}`);
  }
  if (typeof cottontail.cryptoHmacSync !== "function") {
    throw new Error("native crypto HMAC is unavailable");
  }
  return new Uint8Array(cottontail.cryptoHmacSync(normalized, key, data));
}

function encodeDigest(bytes, encoding = "buffer") {
  if (encoding == null || encoding === "buffer") {
    return globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : new Uint8Array(bytes);
  }
  if (encoding === "hex") return hexFromBytes(bytes);
  if (encoding === "base64" || encoding === "base64url") {
    const base64 = globalThis.Buffer?.from
      ? globalThis.Buffer.from(bytes).toString("base64")
      : btoa(String.fromCharCode(...bytes));
    return encoding === "base64url" ? base64UrlFromBase64(base64) : base64;
  }
  if (encoding === "latin1" || encoding === "binary") {
    return String.fromCharCode(...bytes);
  }
  throw new TypeError(`Unsupported digest encoding: ${encoding}`);
}

export class Hash {
  constructor(algorithm) {
    this.algorithm = normalizeAlgorithm(algorithm);
    this.chunks = [];
    this.finished = false;
  }

  update(data, inputEncoding = undefined) {
    if (this.finished) throw new Error("Digest already called");
    this.chunks.push(bytesFromData(data, inputEncoding));
    return this;
  }

  digest(encoding = undefined) {
    if (this.finished) throw new Error("Digest already called");
    this.finished = true;
    return encodeDigest(digestBytes(this.algorithm, concatBytes(this.chunks)), encoding ?? "buffer");
  }

  copy() {
    const next = new Hash(this.algorithm);
    next.chunks = this.chunks.map((chunk) => new Uint8Array(chunk));
    return next;
  }
}

export class Hmac {
  constructor(algorithm, key) {
    this.algorithm = normalizeAlgorithm(algorithm);
    this.key = bytesFromData(key);
    this.chunks = [];
    this.finished = false;
  }

  update(data, inputEncoding = undefined) {
    if (this.finished) throw new Error("Digest already called");
    this.chunks.push(bytesFromData(data, inputEncoding));
    return this;
  }

  digest(encoding = undefined) {
    if (this.finished) throw new Error("Digest already called");
    this.finished = true;
    return encodeDigest(hmacBytes(this.algorithm, this.key, concatBytes(this.chunks)), encoding ?? "buffer");
  }
}

export function createHash(algorithm) {
  return new Hash(algorithm);
}

export function createHmac(algorithm, key) {
  return new Hmac(algorithm, key);
}

export function hash(algorithm, data, outputEncoding = "hex") {
  return encodeDigest(digestBytes(algorithm, bytesFromData(data)), outputEncoding);
}

export function getHashes() {
  return [...supportedHashes];
}

export function randomBytes(size) {
  const length = Number(size) || 0;
  if (length < 0 || !Number.isFinite(length)) {
    throw new RangeError("randomBytes size must be a non-negative finite number");
  }
  if (typeof cottontail.randomBytes !== "function") {
    throw new Error("native randomBytes is unavailable");
  }
  return globalThis.Buffer?.from
    ? globalThis.Buffer.from(cottontail.randomBytes(length))
    : new Uint8Array(cottontail.randomBytes(length));
}

export const rng = randomBytes;
export const prng = randomBytes;
export const pseudoRandomBytes = randomBytes;

export function randomFillSync(buffer, offset = 0, size = undefined) {
  if (!ArrayBuffer.isView(buffer) && !(buffer instanceof ArrayBuffer)) {
    throw new TypeError("randomFillSync buffer must be an ArrayBuffer or typed array");
  }
  const view = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const start = Number(offset) || 0;
  const length = size == null ? view.byteLength - start : Number(size);
  if (start < 0 || length < 0 || start + length > view.byteLength) {
    throw new RangeError("randomFillSync offset/size out of range");
  }
  view.set(randomBytes(length), start);
  return buffer;
}

export function randomFill(buffer, offset = 0, size = undefined, callback = undefined) {
  if (typeof offset === "function") {
    callback = offset;
    offset = 0;
    size = undefined;
  } else if (typeof size === "function") {
    callback = size;
    size = undefined;
  }
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  queueMicrotask(() => {
    try {
      callback(null, randomFillSync(buffer, offset, size));
    } catch (error) {
      callback(error);
    }
  });
}

export function randomInt(min, max = undefined, callback = undefined) {
  if (typeof max === "function") {
    callback = max;
    max = min;
    min = 0;
  }
  if (max == null) {
    max = min;
    min = 0;
  }
  const low = Math.ceil(Number(min));
  const high = Math.floor(Number(max));
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || high <= low) {
    throw new RangeError("randomInt requires a valid integer range");
  }
  const range = high - low;
  const bytes = randomBytes(6);
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  const result = low + (value % range);
  if (typeof callback === "function") {
    queueMicrotask(() => callback(null, result));
    return;
  }
  return result;
}

export function getRandomValues(view) {
  if (!ArrayBuffer.isView(view) || view instanceof DataView) {
    throw new TypeError("crypto.getRandomValues requires an integer typed array");
  }
  if (view.byteLength > 65536) {
    throw new Error("crypto.getRandomValues quota exceeded");
  }
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(randomBytes(view.byteLength));
  return view;
}

export function randomUUID() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export function timingSafeEqual(left, right) {
  const leftBytes = bytesFromData(left);
  const rightBytes = bytesFromData(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    throw new RangeError("Input buffers must have the same byte length");
  }
  let out = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    out |= leftBytes[index] ^ rightBytes[index];
  }
  return out === 0;
}

export const constants = constantsObject;
export const webcrypto = globalThis.crypto ?? { getRandomValues, randomUUID, subtle: undefined };
export const subtle = webcrypto.subtle;
export let fips = 0;

export function getFips() {
  return fips;
}

export function setFips(value) {
  fips = Number(value) ? 1 : 0;
}

// COTTONTAIL-COMPAT: node:crypto asymmetric crypto/ciphers/KDFs - require native OpenSSL/CommonCrypto-backed key and cipher support.

export default {
  Hash,
  Hmac,
  constants,
  createHash,
  createHmac,
  fips,
  getFips,
  getHashes,
  getRandomValues,
  hash,
  prng,
  pseudoRandomBytes,
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  randomUUID,
  rng,
  setFips,
  subtle,
  timingSafeEqual,
  webcrypto,
};
