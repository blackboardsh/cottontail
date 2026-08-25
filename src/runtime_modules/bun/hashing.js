import { asBuffer } from "./web-buffer-utils.js";
import { isBunFileLike } from "./file-like.js";

function bunHashValue(algorithm, value, seed = 0n) {
  return BigInt(cottontail.hashValue(algorithm, asBuffer(value), String(seed ?? 0)));
}

const hash64Function = (algorithm) => function (value = "", seed = 0n) {
  if (new.target) throw new TypeError("species is not a constructor");
  return bunHashValue(algorithm, value, seed);
};
const hash32Function = (algorithm) => function (value = "", seed = 0) {
  if (new.target) throw new TypeError("species is not a constructor");
  return Number(bunHashValue(algorithm, value, seed)) >>> 0;
};

export const hash = Object.assign(hash64Function(0), {
  wyhash: hash64Function(0),
  adler32: hash32Function(1),
  crc32: hash32Function(2),
  cityHash32: hash32Function(3),
  cityHash64: hash64Function(4),
  xxHash32: hash32Function(5),
  xxHash64: hash64Function(6),
  xxHash3: hash64Function(7),
  murmur32v3: hash32Function(8),
  murmur32v2: hash32Function(9),
  murmur64v2: hash64Function(10),
  rapidhash: hash64Function(11),
});

function normalizeCryptoHasherAlgorithm(algorithm) {
  const normalized = String(algorithm).toLowerCase().replace(/[_/]/g, "-");
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (compact === "sha128" || compact === "sha1") return "sha1";
  if (compact === "sha224") return "sha224";
  if (compact === "sha256") return "sha256";
  if (compact === "sha384") return "sha384";
  if (compact === "sha512") return "sha512";
  if (compact === "sha512224") return "sha512-224";
  if (compact === "sha512256") return "sha512-256";
  if (compact === "ripemd160" || compact === "rmd160") return "ripemd160";
  if (compact === "blake2b256") return "blake2b256";
  if (compact === "blake2b512") return "blake2b512";
  if (compact === "blake2s256") return "blake2s256";
  if (compact === "md4") return "md4";
  if (compact === "md5") return "md5";
  if (compact.startsWith("sha3")) return `sha3-${compact.slice(4)}`;
  if (compact === "shake128" || compact === "shake256") return compact;
  return normalized;
}


function cryptoHasherBytes(data, encoding = undefined) {
  if (arguments.length === 0 || data == null) throw new TypeError("CryptoHasher update requires data");
  if (isBunFileLike(data)) throw new TypeError("Bun.file is not supported by CryptoHasher");
  if (typeof globalThis.Blob === "function" && data instanceof globalThis.Blob) {
    const bytes = data?._bytes instanceof Uint8Array
      ? data._bytes.slice()
      : typeof data?._getBytes === "function"
        ? data._getBytes()
        : new Uint8Array(0);
    if (bytes.byteLength !== Number(data.size)) throw new TypeError("Unable to read Blob bytes synchronously");
    return bytes;
  }
  if (typeof data === "string") return globalThis.Buffer.from(data, encoding);
  return asBuffer(data);
}

function encodeCryptoDigest(bytes, encoding) {
  if (encoding != null && typeof encoding === "object" && (ArrayBuffer.isView(encoding) || encoding instanceof ArrayBuffer)) {
    const target = encoding instanceof ArrayBuffer
      ? new Uint8Array(encoding)
      : new Uint8Array(encoding.buffer, encoding.byteOffset, encoding.byteLength);
    if (target.byteLength < bytes.length) {
      throw new TypeError(`TypedArray must be at least ${bytes.length} bytes`);
    }
    target.set(bytes);
    return encoding;
  }
  if (encoding == null || encoding === "buffer") return globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : bytes;
  if (encoding === "base64url") {
    const base64 = globalThis.Buffer?.from ? globalThis.Buffer.from(bytes).toString("base64") : btoa(String.fromCharCode(...bytes));
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  return (globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : asBuffer(bytes)).toString(encoding);
}

const cryptoHasherNativeHandle = Symbol("CryptoHasher.nativeHandle");
const cryptoHasherNativeKeyed = Symbol("CryptoHasher.nativeKeyed");

function cryptoHasherNativeOutput(encoding) {
  if (encoding != null && typeof encoding === "object" && (ArrayBuffer.isView(encoding) || encoding instanceof ArrayBuffer)) {
    const target = encoding instanceof ArrayBuffer
      ? new Uint8Array(encoding)
      : new Uint8Array(encoding.buffer, encoding.byteOffset, encoding.byteLength);
    return [8, target, encoding];
  }
  if (encoding == null || encoding === "buffer") return [0];

  switch (String(encoding).toLowerCase()) {
    case "hex":
      return [1];
    case "base64":
      return [2];
    case "base64url":
      return [3];
    case "latin1":
    case "binary":
      return [4];
    case "ascii":
      return [5];
    case "utf8":
    case "utf-8":
      return [6];
    case "ucs2":
    case "ucs-2":
    case "utf16le":
    case "utf-16le":
      return [7];
    default:
      // Delegate invalid-encoding validation to Buffer before finalizing the
      // native state so a generic CryptoHasher remains retryable.
      encodeCryptoDigest(new Uint8Array(0), encoding);
      return [0];
  }
}

function nativeCryptoHasherDigest(handle, encoding) {
  const output = cryptoHasherNativeOutput(encoding);
  const result = output.length === 3
    ? globalThis.cottontail.cryptoHasherDigest(handle, output[0], output[1])
    : globalThis.cottontail.cryptoHasherDigest(handle, output[0]);
  if (output.length === 3) return output[2];
  if (output[0] === 0) {
    return globalThis.Buffer?.from ? globalThis.Buffer.from(result) : new Uint8Array(result);
  }
  return result;
}

export class CryptoHasher {
  constructor(algorithm, key = undefined) {
    if (algorithm == null) throw new TypeError("Expected an algorithm name as an argument");
    this.algorithm = normalizeCryptoHasherAlgorithm(algorithm);
    const keyBytes = key === undefined ? undefined : cryptoHasherBytes(key);
    if (keyBytes !== undefined && !["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-224", "sha512-256", "blake2b512"].includes(this.algorithm)) {
      throw new Error(`${this.algorithm} is not supported`);
    }
    const nativeCreate = globalThis.cottontail?.cryptoHasherCreate;
    if (typeof nativeCreate !== "function") throw new Error("CryptoHasher capability native library did not initialize");
    const nativeHandle = keyBytes === undefined
      ? nativeCreate(this.algorithm)
      : nativeCreate(this.algorithm, keyBytes);
    if (nativeHandle == null) throw new Error(`${this.algorithm} is not supported`);
    this[cryptoHasherNativeHandle] = nativeHandle;
    this[cryptoHasherNativeKeyed] = keyBytes !== undefined;
    this._finished = false;
  }

  get byteLength() {
    if (this._finished) throw new Error("CryptoHasher hasher already digested");
    return {
      md4: 16,
      md5: 16,
      ripemd160: 20,
      sha1: 20,
      sha224: 28,
      sha256: 32,
      sha384: 48,
      sha512: 64,
      "sha512-224": 28,
      "sha512-256": 32,
      "sha3-224": 28,
      "sha3-256": 32,
      "sha3-384": 48,
      "sha3-512": 64,
      shake128: 16,
      shake256: 32,
      blake2b256: 32,
      blake2b512: 64,
      blake2s256: 32,
    }[this.algorithm] ?? 0;
  }

  update(data, encoding = undefined) {
    if (this._finished) throw new Error("Digest already called");
    const bytes = cryptoHasherBytes(data, encoding);
    globalThis.cottontail.cryptoHasherUpdate(this[cryptoHasherNativeHandle], bytes);
    return this;
  }

  digest(encoding = undefined) {
    if (this._finished) throw new Error("Digest already called");
    const handle = this[cryptoHasherNativeHandle];
    const output = nativeCryptoHasherDigest(handle, encoding);
    if (this[cryptoHasherNativeKeyed]) this._finished = true;
    return output;
  }

  copy() {
    if (this._finished) throw new Error("CryptoHasher hasher already digested");
    const handle = this[cryptoHasherNativeHandle];
    const next = Object.create(CryptoHasher.prototype);
    next.algorithm = this.algorithm;
    next[cryptoHasherNativeHandle] = globalThis.cottontail.cryptoHasherCopy(handle);
    next[cryptoHasherNativeKeyed] = this[cryptoHasherNativeKeyed];
    next._finished = false;
    return next;
  }

  static hash(algorithm, data, encoding = undefined) {
    const hasher = new CryptoHasher(algorithm);
    return hasher.update(data).digest(encoding);
  }
}

Object.defineProperty(CryptoHasher, "algorithms", {
  value: Object.freeze([
    "blake2b256",
    "blake2b512",
    "blake2s256",
    "md4",
    "md5",
    "ripemd160",
    "sha1",
    "sha224",
    "sha256",
    "sha384",
    "sha512",
    "sha512-224",
    "sha512-256",
    "sha3-224",
    "sha3-256",
    "sha3-384",
    "sha3-512",
    "shake128",
    "shake256",
  ]),
  writable: false,
  enumerable: true,
  configurable: true,
});

function hashClass(algorithm) {
  return class BunHash {
    constructor() {
      this._hasher = new CryptoHasher(algorithm);
    }
    get byteLength() {
      return this._hasher.byteLength;
    }
    update(data, encoding = undefined) {
      if (this._finished) throw new Error(`${this.constructor.name} hasher already digested, create a new instance to update`);
      this._hasher.update(data, encoding);
      return this;
    }
    digest(encoding = undefined) {
      if (this._finished) throw new Error(`${this.constructor.name} hasher already digested, create a new instance to digest again`);
      this._finished = true;
      return this._hasher.digest(encoding);
    }
    static hash(data, encoding = undefined) {
      // Fast path for the overwhelmingly common one-shot case: hash a
      // string/typed-array directly through the native digest without
      // building CryptoHasher/node Hash instances.
      if (
        typeof cottontail?.cryptoHashSync === "function" &&
        (typeof data === "string" || ArrayBuffer.isView(data) || data instanceof ArrayBuffer) &&
        (encoding === undefined || encoding === "hex" || encoding === "base64")
      ) {
        try {
          const bytes = typeof data === "string" ? asBuffer(data) : data;
          if (encoding === "hex") {
            const hex = cottontail.cryptoHashSync(algorithm, bytes, undefined, "hex");
            if (typeof hex === "string") return hex;
            return globalThis.Buffer.from(hex).toString("hex");
          }
          const digest = globalThis.Buffer.from(cottontail.cryptoHashSync(algorithm, bytes));
          if (encoding === undefined) return digest;
          return digest.toString(encoding);
        } catch {
          // fall through to the generic implementation
        }
      }
      return CryptoHasher.hash(algorithm, data, encoding);
    }
  };
}

export const MD4 = hashClass("md4");
export const MD5 = hashClass("md5");
export const SHA1 = hashClass("sha1");
export const SHA224 = hashClass("sha224");
export const SHA256 = hashClass("sha256");
export const SHA384 = hashClass("sha384");
export const SHA512 = hashClass("sha512");
export const SHA512_256 = hashClass("sha512-256");
