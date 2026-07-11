import constantsObject from "./constants.js";
import { Buffer } from "./buffer.js";

const supportedHashes = [
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
  "blake2b512",
  "blake2s256",
];
const hashOutputLengths = {
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
  blake2b512: 64,
  blake2s256: 32,
};
const supportedCiphers = [
  ["aes-128-cbc", "cbc", 16, 16, 16],
  ["aes-192-cbc", "cbc", 16, 16, 24],
  ["aes-256-cbc", "cbc", 16, 16, 32],
  ["aes-128-ctr", "ctr", 1, 16, 16],
  ["aes-192-ctr", "ctr", 1, 16, 24],
  ["aes-256-ctr", "ctr", 1, 16, 32],
  ["aes-128-cfb", "cfb", 1, 16, 16],
  ["aes-192-cfb", "cfb", 1, 16, 24],
  ["aes-256-cfb", "cfb", 1, 16, 32],
  ["aes-128-cfb8", "cfb8", 1, 16, 16],
  ["aes-192-cfb8", "cfb8", 1, 16, 24],
  ["aes-256-cfb8", "cfb8", 1, 16, 32],
  ["aes-128-ofb", "ofb", 1, 16, 16],
  ["aes-192-ofb", "ofb", 1, 16, 24],
  ["aes-256-ofb", "ofb", 1, 16, 32],
  ["aes-128-ecb", "ecb", 16, 0, 16],
  ["aes-192-ecb", "ecb", 16, 0, 24],
  ["aes-256-ecb", "ecb", 16, 0, 32],
  ["aes-128-gcm", "gcm", 1, 12, 16, 16],
  ["aes-192-gcm", "gcm", 1, 12, 24, 16],
  ["aes-256-gcm", "gcm", 1, 12, 32, 16],
  ["chacha20-poly1305", "chacha20-poly1305", 1, 12, 32, 16],
].map(([name, mode, blockSize, ivLength, keyLength, authTagLength = 0]) => ({
  name,
  mode,
  blockSize,
  ivLength,
  keyLength,
  authTagLength,
}));
const supportedCipherMap = Object.fromEntries(supportedCiphers.map((cipher) => [cipher.name, cipher]));
const ed25519StreamErrorMessage = "Unsupported crypto operation";
const supportedNativeEcCurves = ["secp256k1", "secp384r1", "secp521r1"];
const smallPrimeBases = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
const dhGroupPrimes = {
  modp14: "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E08" +
    "8A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B" +
    "302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9" +
    "A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE6" +
    "49286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8" +
    "FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D" +
    "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C" +
    "180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718" +
    "3995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFF" +
    "FFFFFFFF",
};
const p256 = {
  name: "prime256v1",
  p: BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff"),
  a: BigInt("0xffffffff00000001000000000000000000000000fffffffffffffffffffffffc"),
  b: BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b"),
  n: BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"),
  gx: BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"),
  gy: BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"),
  size: 32,
};
const rsaDigestInfoPrefixes = {
  md5: "3020300c06082a864886f70d020505000410",
  sha1: "3021300906052b0e03021a05000414",
  sha224: "302d300d06096086480165030402040500041c",
  sha256: "3031300d060960864801650304020105000420",
  sha384: "3041300d060960864801650304020205000430",
  sha512: "3051300d060960864801650304020305000440",
};
const x509NameOids = {
  "2.5.4.3": "CN",
  "2.5.4.4": "SN",
  "2.5.4.5": "serialNumber",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.9": "street",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.12": "title",
  "2.5.4.42": "GN",
  "1.2.840.113549.1.9.1": "emailAddress",
};
const x509SignatureAlgorithms = {
  "1.2.840.113549.1.1.5": { name: "sha1WithRSAEncryption", digest: "sha1", keyType: "rsa" },
  "1.2.840.113549.1.1.11": { name: "sha256WithRSAEncryption", digest: "sha256", keyType: "rsa" },
  "1.2.840.113549.1.1.12": { name: "sha384WithRSAEncryption", digest: "sha384", keyType: "rsa" },
  "1.2.840.113549.1.1.13": { name: "sha512WithRSAEncryption", digest: "sha512", keyType: "rsa" },
  "1.2.840.10045.4.3.2": { name: "ecdsa-with-SHA256", digest: "sha256", keyType: "ec" },
  "1.2.840.10045.4.3.3": { name: "ecdsa-with-SHA384", digest: "sha384", keyType: "ec" },
  "1.2.840.10045.4.3.4": { name: "ecdsa-with-SHA512", digest: "sha512", keyType: "ec" },
  "1.3.101.112": { name: "ED25519", digest: null, keyType: "ed25519" },
  "1.3.101.113": { name: "ED448", digest: null, keyType: "ed448" },
};
const x509EcCurveOids = {
  "1.2.840.10045.3.1.7": { asn1Curve: "prime256v1", nistCurve: "P-256" },
  "1.3.132.0.34": { asn1Curve: "secp384r1", nistCurve: "P-384" },
  "1.3.132.0.35": { asn1Curve: "secp521r1", nistCurve: "P-521" },
  "1.3.132.0.10": { asn1Curve: "secp256k1", nistCurve: "secp256k1" },
};

function normalizeAlgorithm(algorithm) {
  const normalized = String(algorithm).toLowerCase().replace(/[^a-z0-9]/g, "");
  const sha3Match = normalized.match(/^sha3(224|256|384|512)$/);
  if (sha3Match) return `sha3-${sha3Match[1]}`;
  if (normalized === "shake128" || normalized === "shake256") return normalized;
  if (normalized === "ripemd160" || normalized === "rmd160") return "ripemd160";
  if (normalized === "blake2b512" || normalized === "blake2s256") return normalized;
  if (normalized === "md4") return "md4";
  if (normalized === "sha" || normalized === "sha1") return "sha1";
  if (normalized === "sha128") return "sha1";
  if (normalized === "sha512224") return "sha512-224";
  if (normalized === "sha512256") return "sha512-256";
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
  if (data instanceof KeyObject) return new Uint8Array(data.export());
  if (typeof data === "string") {
    if (Buffer?.from) return new Uint8Array(Buffer.from(data, encoding ?? "utf8"));
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

function md4Digest(data) {
  const input = bytesFromData(data);
  const bitLength = BigInt(input.length) * 8n;
  const paddedLength = (((input.length + 8) >>> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  for (let index = 0; index < 8; index += 1) {
    padded[paddedLength - 8 + index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
  }

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const words = new Uint32Array(16);
  const f = (x, y, z) => ((x & y) | (~x & z)) >>> 0;
  const g = (x, y, z) => ((x & y) | (x & z) | (y & z)) >>> 0;
  const h = (x, y, z) => (x ^ y ^ z) >>> 0;

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const byteOffset = offset + index * 4;
      words[index] = padded[byteOffset] |
        (padded[byteOffset + 1] << 8) |
        (padded[byteOffset + 2] << 16) |
        (padded[byteOffset + 3] << 24);
    }

    const aa = a;
    const bb = b;
    const cc = c;
    const dd = d;

    for (let index = 0; index < 16; index += 4) {
      a = rotateLeft32((a + f(b, c, d) + words[index]) >>> 0, 3);
      d = rotateLeft32((d + f(a, b, c) + words[index + 1]) >>> 0, 7);
      c = rotateLeft32((c + f(d, a, b) + words[index + 2]) >>> 0, 11);
      b = rotateLeft32((b + f(c, d, a) + words[index + 3]) >>> 0, 19);
    }

    for (const group of [[0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15]]) {
      a = rotateLeft32((a + g(b, c, d) + words[group[0]] + 0x5a827999) >>> 0, 3);
      d = rotateLeft32((d + g(a, b, c) + words[group[1]] + 0x5a827999) >>> 0, 5);
      c = rotateLeft32((c + g(d, a, b) + words[group[2]] + 0x5a827999) >>> 0, 9);
      b = rotateLeft32((b + g(c, d, a) + words[group[3]] + 0x5a827999) >>> 0, 13);
    }

    for (const group of [[0, 8, 4, 12], [2, 10, 6, 14], [1, 9, 5, 13], [3, 11, 7, 15]]) {
      a = rotateLeft32((a + h(b, c, d) + words[group[0]] + 0x6ed9eba1) >>> 0, 3);
      d = rotateLeft32((d + h(a, b, c) + words[group[1]] + 0x6ed9eba1) >>> 0, 9);
      c = rotateLeft32((c + h(d, a, b) + words[group[2]] + 0x6ed9eba1) >>> 0, 11);
      b = rotateLeft32((b + h(c, d, a) + words[group[3]] + 0x6ed9eba1) >>> 0, 15);
    }

    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  const output = new Uint8Array(16);
  const values = [a, b, c, d];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    output[index * 4] = value & 0xff;
    output[index * 4 + 1] = (value >>> 8) & 0xff;
    output[index * 4 + 2] = (value >>> 16) & 0xff;
    output[index * 4 + 3] = (value >>> 24) & 0xff;
  }
  return output;
}

function hmacFallback(algorithm, key, data) {
  const blockSize = 64;
  let keyBytes = bytesFromData(key);
  if (keyBytes.length > blockSize) keyBytes = digestBytes(algorithm, keyBytes);
  const normalizedKey = new Uint8Array(blockSize);
  normalizedKey.set(keyBytes);
  const innerPad = new Uint8Array(blockSize);
  const outerPad = new Uint8Array(blockSize);
  for (let index = 0; index < blockSize; index += 1) {
    innerPad[index] = normalizedKey[index] ^ 0x36;
    outerPad[index] = normalizedKey[index] ^ 0x5c;
  }
  const inner = digestBytes(algorithm, concatBytes([innerPad, bytesFromData(data)]));
  return digestBytes(algorithm, concatBytes([outerPad, inner]));
}

function hexFromBytes(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(hex) {
  const normalized = String(hex).replace(/\s+/g, "");
  const out = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < out.byteLength; index += 1) {
    out[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function base64UrlFromBase64(value) {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64FromBase64Url(value) {
  const text = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return `${text}${"=".repeat((4 - (text.length % 4)) % 4)}`;
}

function base64UrlFromBytes(bytes) {
  const base64 = Buffer?.from
    ? Buffer.from(bytes).toString("base64")
    : btoa(String.fromCharCode(...bytes));
  return base64UrlFromBase64(base64);
}

function bytesFromBase64Url(value) {
  const base64 = base64FromBase64Url(value);
  if (Buffer?.from) return new Uint8Array(Buffer.from(base64, "base64"));
  return new Uint8Array(Array.from(atob(base64), (char) => char.charCodeAt(0)));
}

function colonHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

function pemFromDer(label, der) {
  const base64 = Buffer.from(der).toString("base64");
  const lines = [];
  for (let index = 0; index < base64.length; index += 64) lines.push(base64.slice(index, index + 64));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function derFromPemOrBytes(value, label) {
  if (typeof value !== "string") return bytesFromData(value);
  const match = value.match(new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`));
  if (!match) throw new Error("PEM start line not found");
  return bytesFromData(match[1].replace(/\s+/g, ""), "base64");
}

function asn1Read(bytes, offset = 0) {
  const start = offset;
  if (offset >= bytes.byteLength) throw new Error("Invalid ASN.1 offset");
  const tag = bytes[offset++];
  let length = bytes[offset++];
  if ((length & 0x80) !== 0) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || offset + count > bytes.byteLength) throw new Error("Invalid ASN.1 length");
    length = 0;
    for (let index = 0; index < count; index += 1) length = (length << 8) | bytes[offset++];
  }
  const valueStart = offset;
  const end = valueStart + length;
  if (end > bytes.byteLength) throw new Error("ASN.1 length exceeds input");
  return {
    tag,
    start,
    valueStart,
    end,
    bytes: bytes.slice(start, end),
    value: bytes.slice(valueStart, end),
  };
}

function asn1Children(node) {
  const children = [];
  let offset = 0;
  while (offset < node.value.byteLength) {
    const child = asn1Read(node.value, offset);
    children.push(child);
    offset = child.end;
  }
  if (offset !== node.value.byteLength) throw new Error("Invalid ASN.1 children");
  return children;
}

function asn1Oid(node) {
  const bytes = node.value;
  if (node.tag !== 0x06 || bytes.byteLength === 0) throw new Error("Invalid ASN.1 object identifier");
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (let index = 1; index < bytes.byteLength; index += 1) {
    value = value * 128 + (bytes[index] & 0x7f);
    if ((bytes[index] & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

function asn1String(node) {
  if (node.tag === 0x13 || node.tag === 0x16 || node.tag === 0x0c || node.tag === 0x14 || node.tag === 0x12) {
    return new TextDecoder().decode(node.value);
  }
  if (node.tag === 0x1e) {
    let out = "";
    for (let index = 0; index + 1 < node.value.byteLength; index += 2) {
      out += String.fromCharCode((node.value[index] << 8) | node.value[index + 1]);
    }
    return out;
  }
  return new TextDecoder().decode(node.value);
}

function asn1IntegerBytes(node) {
  if (node.tag !== 0x02) throw new Error("Invalid ASN.1 integer");
  let bytes = node.value;
  while (bytes.byteLength > 1 && bytes[0] === 0) bytes = bytes.slice(1);
  return bytes;
}

function parseX509Name(node) {
  const object = Object.create(null);
  const lines = [];
  for (const rdn of asn1Children(node)) {
    for (const attribute of asn1Children(rdn)) {
      const pair = asn1Children(attribute);
      if (pair.length < 2) continue;
      const oid = asn1Oid(pair[0]);
      const name = x509NameOids[oid] ?? oid;
      const value = asn1String(pair[1]);
      object[name] = object[name] == null ? value : `${object[name]}, ${value}`;
      lines.push(`${name}=${value}`);
    }
  }
  return { object, text: lines.join("\n") };
}

function parseX509Time(node) {
  const text = asn1String(node);
  const generalized = node.tag === 0x18;
  const year = generalized ? Number(text.slice(0, 4)) : Number(text.slice(0, 2)) + (Number(text.slice(0, 2)) >= 50 ? 1900 : 2000);
  const offset = generalized ? 4 : 2;
  const month = Number(text.slice(offset, offset + 2)) - 1;
  const day = Number(text.slice(offset + 2, offset + 4));
  const hour = Number(text.slice(offset + 4, offset + 6));
  const minute = Number(text.slice(offset + 6, offset + 8));
  const second = Number(text.slice(offset + 8, offset + 10));
  return new Date(Date.UTC(year, month, day, hour, minute, second));
}

function formatX509Date(date) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")} ${date.getUTCFullYear()} GMT`;
}

function digestBytes(algorithm, data, outputLength = undefined) {
  const normalized = normalizeAlgorithm(algorithm);
  if (!supportedHashes.includes(normalized)) {
    throw new Error(`Digest algorithm is not supported in Cottontail yet: ${algorithm}`);
  }
  if (normalized === "md4") return md4Digest(data);
  if (typeof cottontail.cryptoHashSync !== "function") {
    throw new Error("native crypto hashing is unavailable");
  }
  return new Uint8Array(cottontail.cryptoHashSync(normalized, data, outputLength));
}

function hmacBytes(algorithm, key, data) {
  const normalized = normalizeAlgorithm(algorithm);
  if (!supportedHashes.includes(normalized)) {
    throw new Error(`HMAC algorithm is not supported in Cottontail yet: ${algorithm}`);
  }
  if (normalized === "md4") return hmacFallback(normalized, key, data);
  if (typeof cottontail.cryptoHmacSync !== "function") {
    throw new Error("native crypto HMAC is unavailable");
  }
  return new Uint8Array(cottontail.cryptoHmacSync(normalized, key, data));
}

function bufferFromBytes(bytes) {
  return Buffer?.from ? Buffer.from(bytes) : new Uint8Array(bytes);
}

function normalizeCipherName(algorithm) {
  const normalized = String(algorithm).toLowerCase().replace(/_/g, "-");
  const compact = normalized.replace(/-/g, "");
  const compactMatch = compact.match(/^aes(128|192|256)(cbc|ctr|cfb8?|ofb|ecb)$/);
  if (compactMatch) return `aes-${compactMatch[1]}-${compactMatch[2]}`;
  return normalized;
}

function normalizeCipherInfo(info, fallbackName) {
  if (info == null) return undefined;
  const result = {
    mode: String(info.mode ?? "").toLowerCase(),
    name: String(info.name ?? fallbackName).toLowerCase(),
    blockSize: Number(info.blockSize),
    keyLength: Number(info.keyLength),
  };
  if (info.ivLength != null) result.ivLength = Number(info.ivLength);
  if (info.authTagLength != null) result.authTagLength = Number(info.authTagLength);
  return result;
}

function nativeCipherInfo(name) {
  if (typeof cottontail.cryptoCipherInfo !== "function") return undefined;
  return normalizeCipherInfo(cottontail.cryptoCipherInfo(name), name);
}

function cipherInfoForName(name) {
  const normalized = normalizeCipherName(name);
  return supportedCipherMap[normalized] ?? nativeCipherInfo(normalized) ?? nativeCipherInfo(name);
}

function encodeDigest(bytes, encoding = "buffer") {
  if (encoding == null || encoding === "buffer") {
    return bufferFromBytes(bytes);
  }
  if (encoding === "hex") return hexFromBytes(bytes);
  if (encoding === "base64" || encoding === "base64url") {
    const base64 = Buffer?.from
      ? Buffer.from(bytes).toString("base64")
      : btoa(String.fromCharCode(...bytes));
    return encoding === "base64url" ? base64UrlFromBase64(base64) : base64;
  }
  if (encoding === "latin1" || encoding === "binary") {
    return String.fromCharCode(...bytes);
  }
  if (encoding === "utf8" || encoding === "utf-8") {
    return new TextDecoder().decode(bytes);
  }
  throw new TypeError(`Invalid digest encoding: ${encoding}`);
}

function positiveInteger(value, name, allowZero = false) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new RangeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return number;
}

function bigintFromBytes(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bytesFromBigint(value, minLength = 0) {
  if (value < 0n) throw new RangeError("BigInt value must be non-negative");
  const bytes = [];
  let current = value;
  while (current > 0n) {
    bytes.unshift(Number(current & 0xffn));
    current >>= 8n;
  }
  while (bytes.length < minLength) bytes.unshift(0);
  return new Uint8Array(bytes.length === 0 ? [0] : bytes);
}

function bitLength(value) {
  let bits = 0;
  let current = value;
  while (current > 0n) {
    bits += 1;
    current >>= 1n;
  }
  return bits;
}

function bigintFromValue(value, encoding = undefined) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && encoding == null && /^(0x[0-9a-f]+|\d+)$/i.test(value)) return BigInt(value);
  return bigintFromBytes(bytesFromData(value, encoding));
}

function modPow(base, exponent, modulus) {
  if (modulus <= 0n) throw new RangeError("modulus must be positive");
  let result = 1n;
  let factor = ((base % modulus) + modulus) % modulus;
  let power = exponent;
  while (power > 0n) {
    if ((power & 1n) === 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
    power >>= 1n;
  }
  return result;
}

function mod(value, modulus) {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

function modInverse(value, modulus) {
  let t = 0n;
  let nextT = 1n;
  let r = modulus;
  let nextR = mod(value, modulus);
  while (nextR !== 0n) {
    const quotient = r / nextR;
    [t, nextT] = [nextT, t - quotient * nextT];
    [r, nextR] = [nextR, r - quotient * nextR];
  }
  if (r > 1n) throw new RangeError("Value has no modular inverse");
  return mod(t, modulus);
}

function isProbablePrime(value) {
  const candidate = typeof value === "bigint" ? value : bigintFromValue(value);
  if (candidate < 2n) return false;
  for (const prime of smallPrimeBases) {
    if (candidate === prime) return true;
    if (candidate % prime === 0n) return false;
  }
  let d = candidate - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s += 1;
  }
  for (const base of smallPrimeBases) {
    if (base >= candidate - 2n) continue;
    let x = modPow(base, d, candidate);
    if (x === 1n || x === candidate - 1n) continue;
    let passed = false;
    for (let index = 1; index < s; index += 1) {
      x = (x * x) % candidate;
      if (x === candidate - 1n) {
        passed = true;
        break;
      }
    }
    if (!passed) return false;
  }
  return true;
}

function p256Point(x, y) {
  return { x: mod(x, p256.p), y: mod(y, p256.p) };
}

function p256IsOnCurve(point) {
  if (point == null) return true;
  const left = mod(point.y * point.y, p256.p);
  const right = mod(point.x * point.x * point.x + p256.a * point.x + p256.b, p256.p);
  return left === right;
}

function p256Add(left, right) {
  if (left == null) return right;
  if (right == null) return left;
  if (left.x === right.x && mod(left.y + right.y, p256.p) === 0n) return null;
  const slope = left.x === right.x && left.y === right.y
    ? mod((3n * left.x * left.x + p256.a) * modInverse(2n * left.y, p256.p), p256.p)
    : mod((right.y - left.y) * modInverse(right.x - left.x, p256.p), p256.p);
  const x = mod(slope * slope - left.x - right.x, p256.p);
  const y = mod(slope * (left.x - x) - left.y, p256.p);
  return { x, y };
}

function p256Multiply(scalar, point = p256Point(p256.gx, p256.gy)) {
  let n = mod(scalar, p256.n);
  if (n === 0n) return null;
  let result = null;
  let addend = point;
  while (n > 0n) {
    if ((n & 1n) === 1n) result = p256Add(result, addend);
    addend = p256Add(addend, addend);
    n >>= 1n;
  }
  return result;
}

function p256PrivateFromValue(value, encoding = undefined) {
  const privateKey = bigintFromValue(value, encoding);
  if (privateKey <= 0n || privateKey >= p256.n) throw new RangeError("Private key is out of range");
  return privateKey;
}

function p256CurveName(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "p256" || normalized === "prime256v1" || normalized === "secp256r1") return "prime256v1";
  return normalized;
}

function ecCurveName(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "p256" || normalized === "prime256v1" || normalized === "secp256r1") return "prime256v1";
  if (normalized === "p384" || normalized === "secp384r1") return "secp384r1";
  if (normalized === "p521" || normalized === "secp521r1") return "secp521r1";
  if (normalized === "secp256k1") return "secp256k1";
  return normalized;
}

function ecPublicFromPrivate(namedCurve, privateKey) {
  if (typeof cottontail.cryptoEcPublicFromPrivate !== "function") cryptoFeatureError(`crypto.ec.${namedCurve}`);
  return new Uint8Array(cottontail.cryptoEcPublicFromPrivate(namedCurve, privateKey));
}

function p256PublicFromPrivate(privateKey) {
  const publicKey = p256Multiply(privateKey);
  if (publicKey == null) throw new Error("Failed to derive P-256 public key");
  return publicKey;
}

function p256RandomPrivateKey() {
  for (;;) {
    const privateKey = bigintFromBytes(randomBytes(p256.size));
    if (privateKey > 0n && privateKey < p256.n) return privateKey;
  }
}

function p256DecodePoint(value, encoding = undefined) {
  const bytes = bytesFromData(value, encoding);
  if (bytes.byteLength === 65 && bytes[0] === 4) {
    const point = p256Point(bigintFromBytes(bytes.slice(1, 33)), bigintFromBytes(bytes.slice(33, 65)));
    if (!p256IsOnCurve(point)) throw new Error("Public key is not on the curve");
    return point;
  }
  if (bytes.byteLength === 33 && (bytes[0] === 2 || bytes[0] === 3)) {
    const x = bigintFromBytes(bytes.slice(1));
    const ySquared = mod(x * x * x + p256.a * x + p256.b, p256.p);
    let y = modPow(ySquared, (p256.p + 1n) / 4n, p256.p);
    if (Number(y & 1n) !== (bytes[0] & 1)) y = p256.p - y;
    const point = p256Point(x, y);
    if (!p256IsOnCurve(point)) throw new Error("Public key is not on the curve");
    return point;
  }
  if (bytes.byteLength === 65 && (bytes[0] === 6 || bytes[0] === 7)) {
    const point = p256Point(bigintFromBytes(bytes.slice(1, 33)), bigintFromBytes(bytes.slice(33, 65)));
    if (!p256IsOnCurve(point) || Number(point.y & 1n) !== (bytes[0] & 1)) throw new Error("Public key is not on the curve");
    return point;
  }
  throw new TypeError("Invalid public key");
}

function p256EncodePoint(point, format = "uncompressed") {
  if (point == null) throw new Error("Invalid public key");
  const x = bytesFromBigint(point.x, p256.size);
  const y = bytesFromBigint(point.y, p256.size);
  const normalized = String(format ?? "uncompressed").toLowerCase();
  if (normalized === "compressed") return bufferFromBytes(new Uint8Array([(point.y & 1n) === 0n ? 2 : 3, ...x]));
  if (normalized === "hybrid") return bufferFromBytes(new Uint8Array([(point.y & 1n) === 0n ? 6 : 7, ...x, ...y]));
  return bufferFromBytes(new Uint8Array([4, ...x, ...y]));
}

function p256PointFromJwk(jwk) {
  if (!jwk || String(jwk.kty).toUpperCase() !== "EC" || p256CurveName(jwk.crv) !== "prime256v1") {
    throw new TypeError("Only EC P-256 JWK keys are supported");
  }
  const point = p256Point(bigintFromBytes(bytesFromBase64Url(jwk.x)), bigintFromBytes(bytesFromBase64Url(jwk.y)));
  if (!p256IsOnCurve(point)) throw new Error("Public key is not on the curve");
  return point;
}

function p256PrivateFromJwk(jwk) {
  if (jwk?.d == null) throw new TypeError("EC private JWK requires a d parameter");
  const privateKey = p256PrivateFromValue(bytesFromBase64Url(jwk.d));
  const publicKey = p256PointFromJwk(jwk);
  const derived = p256PublicFromPrivate(privateKey);
  if (derived.x !== publicKey.x || derived.y !== publicKey.y) throw new Error("EC private JWK public coordinates do not match d");
  return { privateKey, publicKey };
}

function p256JwkFromKey(keyObject) {
  const point = keyObject.publicPoint;
  const jwk = {
    kty: "EC",
    x: base64UrlFromBytes(bytesFromBigint(point.x, p256.size)),
    y: base64UrlFromBytes(bytesFromBigint(point.y, p256.size)),
    crv: "P-256",
  };
  if (keyObject.type === "private") jwk.d = base64UrlFromBytes(bytesFromBigint(keyObject.privateKey, p256.size));
  return jwk;
}

function nativeEcSize(namedCurve) {
  if (namedCurve === "secp384r1") return 48;
  if (namedCurve === "secp521r1") return 66;
  return 32;
}

function nativeEcWebCurveName(namedCurve) {
  return webcryptoEcCurveNames[namedCurve] ?? namedCurve;
}

function nativeEcJwkFromKey(keyObject) {
  const namedCurve = keyObject.namedCurve ?? keyObject.asymmetricKeyDetails?.namedCurve;
  const size = nativeEcSize(namedCurve);
  const publicKey = bytesFromData(keyObject.publicKeyBytes);
  if (publicKey[0] !== 4 || publicKey.byteLength < 1 + size * 2) throw new TypeError("Invalid EC public key");
  const jwk = {
    kty: "EC",
    x: base64UrlFromBytes(publicKey.slice(1, 1 + size)),
    y: base64UrlFromBytes(publicKey.slice(1 + size, 1 + size * 2)),
    crv: nativeEcWebCurveName(namedCurve),
  };
  if (keyObject.type === "private") jwk.d = base64UrlFromBytes(keyObject.privateKeyBytes);
  return jwk;
}

function nativeEcPublicBytesFromJwk(jwk) {
  const x = bytesFromBase64Url(jwk.x);
  const y = bytesFromBase64Url(jwk.y);
  return new Uint8Array([4, ...x, ...y]);
}

function nativeEcEncodePoint(publicKey, namedCurve, format = "uncompressed") {
  const bytes = bytesFromData(publicKey);
  const normalized = String(format ?? "uncompressed").toLowerCase();
  if (normalized === "uncompressed") return bufferFromBytes(bytes);
  const size = nativeEcSize(namedCurve);
  if (bytes[0] !== 4 || bytes.byteLength < 1 + size * 2) throw new TypeError("Invalid EC public key");
  const x = bytes.slice(1, 1 + size);
  const y = bytes.slice(1 + size, 1 + size * 2);
  const odd = y[y.byteLength - 1] & 1;
  if (normalized === "compressed") return bufferFromBytes(new Uint8Array([odd ? 3 : 2, ...x]));
  if (normalized === "hybrid") return bufferFromBytes(new Uint8Array([odd ? 7 : 6, ...x, ...y]));
  throw new TypeError(`Invalid ECDH public key format: ${format}`);
}

function ed25519PrivateFromJwk(jwk) {
  if (!jwk || String(jwk.kty).toUpperCase() !== "OKP" || String(jwk.crv) !== "Ed25519") {
    throw new TypeError("Only Ed25519 OKP JWK keys are supported");
  }
  if (jwk.d == null) throw new TypeError("Ed25519 private JWK requires a d parameter");
  const privateKey = bytesFromBase64Url(jwk.d);
  if (privateKey.byteLength !== 32) throw new TypeError("Ed25519 private key must be 32 bytes");
  const publicKey = jwk.x == null ? ed25519PublicFromPrivate(privateKey) : bytesFromBase64Url(jwk.x);
  if (publicKey.byteLength !== 32) throw new TypeError("Ed25519 public key must be 32 bytes");
  return { privateKey, publicKey };
}

function ed25519PublicFromJwk(jwk) {
  if (!jwk || String(jwk.kty).toUpperCase() !== "OKP" || String(jwk.crv) !== "Ed25519") {
    throw new TypeError("Only Ed25519 OKP JWK keys are supported");
  }
  if (jwk.x == null) throw new TypeError("Ed25519 public JWK requires an x parameter");
  const publicKey = bytesFromBase64Url(jwk.x);
  if (publicKey.byteLength !== 32) throw new TypeError("Ed25519 public key must be 32 bytes");
  return publicKey;
}

function ed25519JwkFromKey(keyObject) {
  const jwk = {
    crv: "Ed25519",
    x: base64UrlFromBytes(keyObject.publicKey),
    kty: "OKP",
  };
  if (keyObject.type === "private") jwk.d = base64UrlFromBytes(keyObject.privateKeyBytes);
  return jwk;
}

function ed25519PublicFromPrivate(privateKey) {
  if (typeof cottontail.cryptoEd25519PublicFromPrivate !== "function") cryptoFeatureError("crypto.ed25519");
  return new Uint8Array(cottontail.cryptoEd25519PublicFromPrivate(privateKey));
}

const rawKeyInfo = {
  x25519: { privateLength: 32, publicLength: 32, crv: "X25519", dh: true },
  x448: { privateLength: 56, publicLength: 56, crv: "X448", dh: true },
  ed448: { privateLength: 57, publicLength: 57, crv: "Ed448", sign: true },
};

function rawPublicFromPrivate(type, privateKey) {
  if (typeof cottontail.cryptoRawPublicFromPrivate !== "function") cryptoFeatureError(`crypto.${type}`);
  return new Uint8Array(cottontail.cryptoRawPublicFromPrivate(type, privateKey));
}

function rawJwkFromKey(keyObject) {
  const info = rawKeyInfo[keyObject.asymmetricKeyType];
  const jwk = {
    crv: info.crv,
    x: base64UrlFromBytes(keyObject.publicKey),
    kty: "OKP",
  };
  if (keyObject.type === "private") jwk.d = base64UrlFromBytes(keyObject.privateKeyBytes);
  return jwk;
}

function assertEd25519Digest(algorithm) {
  if (algorithm != null) throw new Error("error:1C80007A:Provider routines::invalid digest");
}

function throwEd25519StreamError() {
  throw new Error(ed25519StreamErrorMessage);
}

function ed25519SignData(algorithm, data, keyObject) {
  assertEd25519Digest(algorithm);
  if (!(keyObject instanceof KeyObject) || keyObject.type !== "private" || keyObject.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Ed25519 signing requires an Ed25519 private KeyObject");
  }
  if (typeof cottontail.cryptoEd25519Sign !== "function") cryptoFeatureError("crypto.ed25519.sign");
  return bufferFromBytes(new Uint8Array(cottontail.cryptoEd25519Sign(keyObject.privateKeyBytes, data)));
}

function ed25519VerifyData(algorithm, data, keyObject, signature) {
  assertEd25519Digest(algorithm);
  const publicKey = resolvePublicKeyObject(keyObject);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("Ed25519 verification requires an Ed25519 public KeyObject");
  if (typeof cottontail.cryptoEd25519Verify !== "function") cryptoFeatureError("crypto.ed25519.verify");
  return cottontail.cryptoEd25519Verify(publicKey.publicKey, data, signature);
}

function rawSignData(algorithm, data, keyObject) {
  assertEd25519Digest(algorithm);
  if (!(keyObject instanceof KeyObject) || keyObject.type !== "private" || !rawKeyInfo[keyObject.asymmetricKeyType]?.sign) {
    throw new TypeError(`${keyObject?.asymmetricKeyType ?? "Raw"} signing requires a private KeyObject`);
  }
  if (typeof cottontail.cryptoRawSign !== "function") cryptoFeatureError(`crypto.${keyObject.asymmetricKeyType}.sign`);
  return bufferFromBytes(new Uint8Array(cottontail.cryptoRawSign(keyObject.asymmetricKeyType, keyObject.privateKeyBytes, data)));
}

function rawVerifyData(algorithm, data, keyObject, signature) {
  assertEd25519Digest(algorithm);
  const publicKey = resolvePublicKeyObject(keyObject);
  if (!rawKeyInfo[publicKey.asymmetricKeyType]?.sign) throw new TypeError("Raw verification requires a public KeyObject");
  if (typeof cottontail.cryptoRawVerify !== "function") cryptoFeatureError(`crypto.${publicKey.asymmetricKeyType}.verify`);
  return cottontail.cryptoRawVerify(publicKey.asymmetricKeyType, publicKey.publicKey, data, signature);
}

function ecdsaDigestInteger(digest) {
  let value = bigintFromBytes(digest);
  const digestBits = digest.byteLength * 8;
  const orderBits = bitLength(p256.n);
  if (digestBits > orderBits) value >>= BigInt(digestBits - orderBits);
  return value;
}

function derInteger(value) {
  let bytes = bytesFromBigint(value);
  if ((bytes[0] & 0x80) !== 0) bytes = new Uint8Array([0, ...bytes]);
  return new Uint8Array([0x02, bytes.byteLength, ...bytes]);
}

function derEncodeEcdsa(r, s) {
  const left = derInteger(r);
  const right = derInteger(s);
  return bufferFromBytes(new Uint8Array([0x30, left.byteLength + right.byteLength, ...left, ...right]));
}

function derReadLength(bytes, offset) {
  let length = bytes[offset++];
  if ((length & 0x80) === 0) return { length, offset };
  const count = length & 0x7f;
  if (count <= 0 || count > 2 || offset + count > bytes.byteLength) throw new TypeError("Invalid ECDSA signature DER length");
  length = 0;
  for (let index = 0; index < count; index += 1) length = (length << 8) | bytes[offset++];
  return { length, offset };
}

function derDecodeInteger(bytes, offset) {
  if (bytes[offset++] !== 0x02) throw new TypeError("Invalid ECDSA signature DER integer");
  const read = derReadLength(bytes, offset);
  const end = read.offset + read.length;
  if (read.length <= 0 || end > bytes.byteLength) throw new TypeError("Invalid ECDSA signature DER integer length");
  let valueBytes = bytes.slice(read.offset, end);
  while (valueBytes.byteLength > 1 && valueBytes[0] === 0) valueBytes = valueBytes.slice(1);
  return { value: bigintFromBytes(valueBytes), offset: end };
}

function ecdsaSignatureFromBytes(signature, dsaEncoding = "der") {
  const bytes = bytesFromData(signature);
  if (dsaEncoding === "ieee-p1363") {
    if (bytes.byteLength !== p256.size * 2) throw new TypeError("Invalid ieee-p1363 ECDSA signature length");
    return {
      r: bigintFromBytes(bytes.slice(0, p256.size)),
      s: bigintFromBytes(bytes.slice(p256.size)),
    };
  }
  if (bytes[0] !== 0x30) throw new TypeError("Invalid ECDSA signature DER sequence");
  const sequence = derReadLength(bytes, 1);
  const end = sequence.offset + sequence.length;
  if (end !== bytes.byteLength) throw new TypeError("Invalid ECDSA signature DER sequence length");
  const r = derDecodeInteger(bytes, sequence.offset);
  const s = derDecodeInteger(bytes, r.offset);
  if (s.offset !== end) throw new TypeError("Invalid ECDSA signature DER trailing data");
  return { r: r.value, s: s.value };
}

function ecdsaEncodeSignature(r, s, dsaEncoding = "der") {
  if (dsaEncoding === "ieee-p1363") {
    return bufferFromBytes(new Uint8Array([...bytesFromBigint(r, p256.size), ...bytesFromBigint(s, p256.size)]));
  }
  return derEncodeEcdsa(r, s);
}

function ecdsaSignDigest(digest, keyObject, dsaEncoding = "der") {
  if (!(keyObject instanceof KeyObject) || keyObject.type !== "private" || keyObject.asymmetricKeyType !== "ec") {
    throw new TypeError("ECDSA signing requires an EC private KeyObject");
  }
  if (keyObject.privateKeyBytes != null) {
    if (typeof cottontail.cryptoEcSign !== "function") cryptoFeatureError(`crypto.ec.${keyObject.namedCurve}.sign`);
    const der = bufferFromBytes(new Uint8Array(cottontail.cryptoEcSign(keyObject.namedCurve, keyObject.privateKeyBytes, digest)));
    return dsaEncoding === "ieee-p1363" ? derDecodeEcdsaRaw(der, nativeEcSize(keyObject.namedCurve)) : der;
  }
  const z = ecdsaDigestInteger(digest);
  for (;;) {
    const k = p256RandomPrivateKey();
    const point = p256Multiply(k);
    if (point == null) continue;
    const r = mod(point.x, p256.n);
    if (r === 0n) continue;
    const s = mod(modInverse(k, p256.n) * (z + r * keyObject.privateKey), p256.n);
    if (s === 0n) continue;
    return ecdsaEncodeSignature(r, s, dsaEncoding);
  }
}

function ecdsaVerifyDigest(digest, keyObject, signature, dsaEncoding = "der") {
  const publicKey = resolvePublicKeyObject(keyObject);
  if (publicKey.asymmetricKeyType !== "ec") throw new TypeError("ECDSA verification requires an EC public KeyObject");
  if (publicKey.publicKeyBytes != null) {
    if (typeof cottontail.cryptoEcVerify !== "function") cryptoFeatureError(`crypto.ec.${publicKey.namedCurve}.verify`);
    const encodedSignature = dsaEncoding === "ieee-p1363" ? derEncodeEcdsaRaw(signature) : bytesFromData(signature);
    return cottontail.cryptoEcVerify(publicKey.namedCurve, publicKey.publicKeyBytes, digest, encodedSignature);
  }
  let decoded;
  try {
    decoded = ecdsaSignatureFromBytes(signature, dsaEncoding);
  } catch {
    return false;
  }
  const { r, s } = decoded;
  if (r <= 0n || r >= p256.n || s <= 0n || s >= p256.n) return false;
  const z = ecdsaDigestInteger(digest);
  const w = modInverse(s, p256.n);
  const u1 = mod(z * w, p256.n);
  const u2 = mod(r * w, p256.n);
  const point = p256Add(p256Multiply(u1), p256Multiply(u2, publicKey.publicPoint));
  if (point == null) return false;
  return mod(point.x, p256.n) === r;
}

function byteLengthForBigint(value) {
  return Math.ceil(bitLength(value) / 8);
}

function fixedBytesFromBigint(value, length) {
  const bytes = bytesFromBigint(value);
  if (bytes.byteLength > length) throw new RangeError("Integer is too large for RSA modulus");
  const out = new Uint8Array(length);
  out.set(bytes, length - bytes.byteLength);
  return out;
}

function normalizePublicExponent(value = 0x10001) {
  const exponent = typeof value === "bigint" ? value : BigInt(Number(value));
  if (exponent < 3n || (exponent & 1n) === 0n) throw new RangeError("RSA publicExponent must be an odd integer greater than 2");
  return exponent;
}

function rsaPublicParts(parts) {
  const n = BigInt(parts.n);
  const e = normalizePublicExponent(parts.e);
  if (n <= e || bitLength(n) < 16) throw new RangeError("RSA modulus is out of range");
  return { n, e };
}

function rsaPrivateParts(parts) {
  const publicParts = rsaPublicParts(parts);
  const d = BigInt(parts.d);
  if (d <= 0n || d >= publicParts.n) throw new RangeError("RSA private exponent is out of range");
  const privateParts = { ...publicParts, d };
  for (const name of ["p", "q", "dp", "dq", "qi"]) {
    if (parts[name] != null) privateParts[name] = BigInt(parts[name]);
  }
  return privateParts;
}

function rsaPublicPartsFromJwk(jwk) {
  if (!jwk || String(jwk.kty).toUpperCase() !== "RSA") throw new TypeError("Only RSA JWK keys are supported");
  if (jwk.n == null || jwk.e == null) throw new TypeError("RSA JWK requires n and e parameters");
  return rsaPublicParts({
    n: bigintFromBytes(bytesFromBase64Url(jwk.n)),
    e: bigintFromBytes(bytesFromBase64Url(jwk.e)),
  });
}

function rsaPrivatePartsFromJwk(jwk) {
  if (jwk?.d == null) throw new TypeError("RSA private JWK requires a d parameter");
  const parts = {
    ...rsaPublicPartsFromJwk(jwk),
    d: bigintFromBytes(bytesFromBase64Url(jwk.d)),
  };
  for (const name of ["p", "q", "dp", "dq", "qi"]) {
    if (jwk[name] != null) parts[name] = bigintFromBytes(bytesFromBase64Url(jwk[name]));
  }
  return rsaPrivateParts(parts);
}

function rsaJwkFromKey(keyObject) {
  const parts = keyObject.rsa;
  const jwk = {
    kty: "RSA",
    n: base64UrlFromBytes(bytesFromBigint(parts.n)),
    e: base64UrlFromBytes(bytesFromBigint(parts.e)),
  };
  if (keyObject.type === "private") {
    jwk.d = base64UrlFromBytes(bytesFromBigint(parts.d));
    for (const name of ["p", "q", "dp", "dq", "qi"]) {
      if (parts[name] != null) jwk[name] = base64UrlFromBytes(bytesFromBigint(parts[name]));
    }
  }
  return jwk;
}

function rsaEncodedTypeForKey(keyObject, options = {}) {
  if (options.type != null) return String(options.type).toLowerCase();
  return keyObject.type === "private" ? "pkcs8" : "spki";
}

function nativeExportFormat(options = {}) {
  const format = String(options.format ?? "pem").toLowerCase();
  if (format !== "pem" && format !== "der") throw new TypeError(`Invalid key export format: ${options.format}`);
  return format;
}

function rsaNativeExportKey(keyObject, options = {}) {
  if (typeof cottontail.cryptoRsaExportKey !== "function") cryptoFeatureError("crypto.rsa.exportKey");
  const format = nativeExportFormat(options);
  const encodingType = rsaEncodedTypeForKey(keyObject, options);
  const parts = keyObject.rsa;
  const exported = cottontail.cryptoRsaExportKey(
    keyObject.type,
    format,
    encodingType,
    rsaPartBytes(parts, "n"),
    rsaPartBytes(parts, "e"),
    rsaPartBytes(parts, "d"),
    rsaPartBytes(parts, "p"),
    rsaPartBytes(parts, "q"),
    rsaPartBytes(parts, "dp"),
    rsaPartBytes(parts, "dq"),
    rsaPartBytes(parts, "qi"),
  );
  return format === "pem" ? String(exported) : bufferFromBytes(new Uint8Array(exported));
}

function ecEncodedTypeForKey(keyObject, options = {}) {
  if (options.type != null) return String(options.type).toLowerCase();
  return keyObject.type === "private" ? "pkcs8" : "spki";
}

function ecNativeExportKey(keyObject, options = {}) {
  if (typeof cottontail.cryptoEcExportKey !== "function") cryptoFeatureError("crypto.ec.exportKey");
  const format = nativeExportFormat(options);
  const encodingType = ecEncodedTypeForKey(keyObject, options);
  const namedCurve = keyObject.namedCurve ?? keyObject.asymmetricKeyDetails?.namedCurve ?? "prime256v1";
  const keyBytes = keyObject.type === "private"
    ? (keyObject.privateKeyBytes ?? bytesFromBigint(keyObject.privateKey, p256.size))
    : (keyObject.publicKeyBytes ?? p256EncodePoint(keyObject.publicPoint));
  const exported = cottontail.cryptoEcExportKey(keyObject.type, format, encodingType, namedCurve, keyBytes);
  return format === "pem" ? String(exported) : bufferFromBytes(new Uint8Array(exported));
}

function rawEncodedTypeForKey(keyObject, options = {}) {
  if (options.type != null) return String(options.type).toLowerCase();
  return keyObject.type === "private" ? "pkcs8" : "spki";
}

function rawNativeExportKey(keyObject, options = {}) {
  if (typeof cottontail.cryptoRawExportKey !== "function") cryptoFeatureError(`crypto.${keyObject.asymmetricKeyType}.exportKey`);
  const format = nativeExportFormat(options);
  const encodingType = rawEncodedTypeForKey(keyObject, options);
  const keyBytes = keyObject.type === "private" ? keyObject.privateKeyBytes : keyObject.publicKey;
  const exported = cottontail.cryptoRawExportKey(keyObject.type, format, encodingType, keyObject.asymmetricKeyType, keyBytes);
  return format === "pem" ? String(exported) : bufferFromBytes(new Uint8Array(exported));
}

function rsaPartsFromNativeKey(nativeKey) {
  const parts = {
    n: bigintFromBytes(bytesFromData(nativeKey.n)),
    e: bigintFromBytes(bytesFromData(nativeKey.e)),
  };
  for (const name of ["d", "p", "q", "dp", "dq", "qi"]) {
    if (nativeKey[name] != null) parts[name] = bigintFromBytes(bytesFromData(nativeKey[name]));
  }
  return parts;
}

function keyObjectFromNativeKey(nativeKey, requestedType = undefined) {
  const type = String(nativeKey?.asymmetricKeyType);
  if (type === "rsa") {
    if (nativeKey.type === "private" && requestedType !== "public") return createRsaPrivateKey(rsaPartsFromNativeKey(nativeKey));
    return createRsaPublicKey(rsaPartsFromNativeKey(nativeKey));
  }
  if (type === "ec") {
    const namedCurve = ecCurveName(nativeKey.namedCurve);
    const publicKey = bytesFromData(nativeKey.publicKey);
    if (nativeKey.type === "private" && requestedType !== "public") {
      const privateKey = bytesFromData(nativeKey.privateKey);
      if (namedCurve === "prime256v1") return createEcPrivateKey(privateKey);
      return createNativeEcPrivateKey(namedCurve, privateKey, publicKey);
    }
    if (namedCurve === "prime256v1") return createEcPublicKey(p256DecodePoint(publicKey));
    return createNativeEcPublicKey(namedCurve, publicKey);
  }
  if (type === "ed25519") {
    const publicKey = bytesFromData(nativeKey.publicKey);
    if (nativeKey.type === "private" && requestedType !== "public") return createEd25519PrivateKey(bytesFromData(nativeKey.privateKey), publicKey);
    return createEd25519PublicKey(publicKey);
  }
  if (rawKeyInfo[type]) {
    const publicKey = bytesFromData(nativeKey.publicKey);
    if (nativeKey.type === "private" && requestedType !== "public") return createRawPrivateKey(type, bytesFromData(nativeKey.privateKey), publicKey);
    return createRawPublicKey(type, publicKey);
  }
  throw new TypeError(`Invalid encoded key type: ${type}`);
}

function keyObjectFromEncodedInput(input, requestedType = undefined) {
  if (typeof cottontail.cryptoImportKey !== "function") cryptoFeatureError("crypto.importKey");
  const options = input && typeof input === "object" && input.key != null ? input : { key: input };
  const keyData = options.key;
  const format = String(options.format ?? (typeof keyData === "string" ? "pem" : "der")).toLowerCase();
  const keyType = String(options.type ?? "");
  const nativeKey = cottontail.cryptoImportKey(requestedType ?? "", format, keyType, bytesFromData(keyData));
  return keyObjectFromNativeKey(nativeKey, requestedType);
}

function rsaKeyOptions(parts) {
  return {
    asymmetricKeyType: "rsa",
    asymmetricKeyDetails: {
      modulusLength: bitLength(parts.n),
      publicExponent: parts.e,
    },
  };
}

function rsaModulusLength(keyObject) {
  return byteLengthForBigint(keyObject.rsa.n);
}

function rsaApply(exponent, modulus, input) {
  const length = Math.ceil(bitLength(modulus) / 8);
  const value = bigintFromBytes(input);
  if (value >= modulus) throw new RangeError("RSA input is too large for modulus");
  return bufferFromBytes(fixedBytesFromBigint(modPow(value, exponent, modulus), length));
}

function rsaPublicApply(keyObject, input) {
  return rsaApply(keyObject.rsa.e, keyObject.rsa.n, input);
}

function rsaPrivateApply(keyObject, input) {
  if (keyObject.type !== "private") throw new TypeError("RSA private operation requires a private KeyObject");
  return rsaApply(keyObject.rsa.d, keyObject.rsa.n, input);
}

function rsaPkcs1DigestInfo(algorithm, digest) {
  const normalized = normalizeAlgorithm(algorithm);
  const prefix = rsaDigestInfoPrefixes[normalized];
  if (!prefix) throw new TypeError(`RSA signing does not support digest algorithm: ${algorithm}`);
  return concatBytes([bytesFromHex(prefix), digest]);
}

function rsaPkcs1SignBlock(algorithm, digest, length) {
  const info = rsaPkcs1DigestInfo(algorithm, digest);
  if (info.byteLength + 11 > length) throw new RangeError("RSA key is too small for digest");
  const out = new Uint8Array(length);
  out[0] = 0;
  out[1] = 1;
  out.fill(0xff, 2, length - info.byteLength - 1);
  out[length - info.byteLength - 1] = 0;
  out.set(info, length - info.byteLength);
  return out;
}

function rsaPartBytes(parts, name) {
  return parts[name] == null ? new Uint8Array(0) : bytesFromBigint(parts[name]);
}

function rsaSignatureSaltLength(options = undefined, signing = true) {
  const padding = signaturePadding(options, constantsObject.RSA_PKCS1_PADDING);
  if (padding !== constantsObject.RSA_PKCS1_PSS_PADDING) return 0;
  if (options && typeof options === "object" && options.saltLength != null) return Number(options.saltLength);
  return signing ? constantsObject.RSA_PSS_SALTLEN_MAX_SIGN : constantsObject.RSA_PSS_SALTLEN_AUTO;
}

function rsaNativeSignData(algorithm, data, keyObject, options = undefined) {
  if (typeof cottontail.cryptoRsaSign !== "function") return undefined;
  const padding = signaturePadding(options, constantsObject.RSA_PKCS1_PADDING);
  if (padding !== constantsObject.RSA_PKCS1_PADDING && padding !== constantsObject.RSA_PKCS1_PSS_PADDING) {
    throw new TypeError("Invalid RSA signing padding");
  }
  const parts = keyObject.rsa;
  return bufferFromBytes(new Uint8Array(cottontail.cryptoRsaSign(
    normalizeAlgorithm(algorithm),
    padding,
    rsaSignatureSaltLength(options, true),
    rsaPartBytes(parts, "n"),
    rsaPartBytes(parts, "e"),
    rsaPartBytes(parts, "d"),
    rsaPartBytes(parts, "p"),
    rsaPartBytes(parts, "q"),
    rsaPartBytes(parts, "dp"),
    rsaPartBytes(parts, "dq"),
    rsaPartBytes(parts, "qi"),
    data,
  )));
}

function rsaNativeVerifyData(algorithm, data, keyObject, signature, options = undefined) {
  if (typeof cottontail.cryptoRsaVerify !== "function") return undefined;
  const publicKey = resolvePublicKeyObject(keyObject);
  const padding = signaturePadding(options, constantsObject.RSA_PKCS1_PADDING);
  if (padding !== constantsObject.RSA_PKCS1_PADDING && padding !== constantsObject.RSA_PKCS1_PSS_PADDING) {
    throw new TypeError("Invalid RSA verification padding");
  }
  const parts = publicKey.rsa;
  return cottontail.cryptoRsaVerify(
    normalizeAlgorithm(algorithm),
    padding,
    rsaSignatureSaltLength(options, false),
    rsaPartBytes(parts, "n"),
    rsaPartBytes(parts, "e"),
    data,
    signature,
  );
}

function rsaSignDigest(algorithm, digest, keyObject, options = undefined) {
  if (!(keyObject instanceof KeyObject) || keyObject.type !== "private" || keyObject.asymmetricKeyType !== "rsa") {
    throw new TypeError("RSA signing requires an RSA private KeyObject");
  }
  const padding = signaturePadding(options, constantsObject.RSA_PKCS1_PADDING);
  if (padding !== constantsObject.RSA_PKCS1_PADDING) throw new TypeError("Invalid RSA signing padding");
  return rsaPrivateApply(keyObject, rsaPkcs1SignBlock(algorithm, digest, rsaModulusLength(keyObject)));
}

function rsaVerifyDigest(algorithm, digest, keyObject, signature, options = undefined) {
  const publicKey = resolvePublicKeyObject(keyObject);
  if (publicKey.asymmetricKeyType !== "rsa") throw new TypeError("RSA verification requires an RSA public KeyObject");
  const padding = signaturePadding(options, constantsObject.RSA_PKCS1_PADDING);
  if (padding !== constantsObject.RSA_PKCS1_PADDING) throw new TypeError("Invalid RSA verification padding");
  const signatureBytes = bytesFromData(signature);
  if (signatureBytes.byteLength !== rsaModulusLength(publicKey)) return false;
  let actual;
  try {
    actual = rsaPublicApply(publicKey, signatureBytes);
  } catch {
    return false;
  }
  const expected = rsaPkcs1SignBlock(algorithm, digest, rsaModulusLength(publicKey));
  return timingSafeEqual(actual, expected);
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

function generateRsaPrime(bits, exponent) {
  for (;;) {
    const prime = generatePrimeBigint(bits);
    if (gcd(exponent, prime - 1n) === 1n) return prime;
  }
}

function generateRsaKeyPair(modulusLength, publicExponent) {
  const bits = positiveInteger(modulusLength, "modulusLength");
  if (bits < 512) throw new RangeError("RSA modulusLength must be at least 512 bits");
  const e = normalizePublicExponent(publicExponent ?? 0x10001);
  const pBits = Math.ceil(bits / 2);
  const qBits = Math.floor(bits / 2);
  for (;;) {
    const p = generateRsaPrime(pBits, e);
    let q = generateRsaPrime(qBits, e);
    if (p === q) continue;
    const n = p * q;
    if (bitLength(n) !== bits) continue;
    const phi = (p - 1n) * (q - 1n);
    if (gcd(e, phi) !== 1n) continue;
    const d = modInverse(e, phi);
    return {
      n,
      e,
      d,
      p,
      q,
      dp: d % (p - 1n),
      dq: d % (q - 1n),
      qi: modInverse(q, p),
    };
  }
}

function mgf1(seed, length, algorithm) {
  const chunks = [];
  for (let counter = 0; concatBytes(chunks).byteLength < length; counter += 1) {
    chunks.push(digestBytes(algorithm, concatBytes([seed, new Uint8Array([
      (counter >>> 24) & 0xff,
      (counter >>> 16) & 0xff,
      (counter >>> 8) & 0xff,
      counter & 0xff,
    ])])));
  }
  return concatBytes(chunks).slice(0, length);
}

function nonZeroRandomBytes(length) {
  const out = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const chunk = randomBytes(length - offset);
    for (const byte of chunk) {
      if (byte === 0) continue;
      out[offset++] = byte;
      if (offset === length) break;
    }
  }
  return out;
}

function rsaOaepEncode(message, length, algorithm = "sha1", label = undefined) {
  const hashLength = digestBytes(algorithm, new Uint8Array()).byteLength;
  if (message.byteLength > length - 2 * hashLength - 2) throw new RangeError("RSA OAEP message is too long");
  const labelHash = digestBytes(algorithm, bytesFromData(label ?? new Uint8Array()));
  const ps = new Uint8Array(length - message.byteLength - 2 * hashLength - 2);
  const db = concatBytes([labelHash, ps, new Uint8Array([1]), message]);
  const seed = randomBytes(hashLength);
  const dbMask = mgf1(seed, length - hashLength - 1, algorithm);
  const maskedDb = xorBytes(db, dbMask);
  const seedMask = mgf1(maskedDb, hashLength, algorithm);
  const maskedSeed = xorBytes(seed, seedMask);
  return concatBytes([new Uint8Array([0]), maskedSeed, maskedDb]);
}

function rsaOaepDecode(encoded, algorithm = "sha1", label = undefined) {
  const bytes = bytesFromData(encoded);
  const hashLength = digestBytes(algorithm, new Uint8Array()).byteLength;
  if (bytes.byteLength < 2 * hashLength + 2 || bytes[0] !== 0) throw new Error("RSA OAEP decoding failed");
  const maskedSeed = bytes.slice(1, 1 + hashLength);
  const maskedDb = bytes.slice(1 + hashLength);
  const seedMask = mgf1(maskedDb, hashLength, algorithm);
  const seed = xorBytes(maskedSeed, seedMask);
  const dbMask = mgf1(seed, bytes.byteLength - hashLength - 1, algorithm);
  const db = xorBytes(maskedDb, dbMask);
  const labelHash = digestBytes(algorithm, bytesFromData(label ?? new Uint8Array()));
  if (!timingSafeEqual(db.slice(0, hashLength), labelHash)) throw new Error("RSA OAEP label hash mismatch");
  let index = hashLength;
  while (index < db.byteLength && db[index] === 0) index += 1;
  if (index >= db.byteLength || db[index] !== 1) throw new Error("RSA OAEP separator not found");
  return bufferFromBytes(db.slice(index + 1));
}

function rsaPkcs1EncryptBlock(message, length) {
  if (message.byteLength > length - 11) throw new RangeError("RSA message is too long");
  const padding = nonZeroRandomBytes(length - message.byteLength - 3);
  return concatBytes([new Uint8Array([0, 2]), padding, new Uint8Array([0]), message]);
}

function rsaPkcs1DecryptBlock(encoded, expectedType) {
  const bytes = bytesFromData(encoded);
  if (bytes.byteLength < 11 || bytes[0] !== 0 || bytes[1] !== expectedType) throw new Error("RSA PKCS#1 decoding failed");
  let index = 2;
  while (index < bytes.byteLength && bytes[index] !== 0) {
    if (expectedType === 1 && bytes[index] !== 0xff) throw new Error("RSA PKCS#1 block type mismatch");
    index += 1;
  }
  if (index < 10 || index >= bytes.byteLength) throw new Error("RSA PKCS#1 separator not found");
  return bufferFromBytes(bytes.slice(index + 1));
}

function rsaPrivateEncryptBlock(message, length) {
  if (message.byteLength > length - 11) throw new RangeError("RSA message is too long");
  const out = new Uint8Array(length);
  out[0] = 0;
  out[1] = 1;
  out.fill(0xff, 2, length - message.byteLength - 1);
  out[length - message.byteLength - 1] = 0;
  out.set(message, length - message.byteLength);
  return out;
}

function parseX509Algorithm(node) {
  const oid = asn1Oid(asn1Children(node)[0]);
  return { oid, ...(x509SignatureAlgorithms[oid] ?? { name: oid, digest: undefined, keyType: undefined }) };
}

function parseX509PublicKeyInfo(node) {
  const [algorithmNode, bitStringNode] = asn1Children(node);
  const algorithmChildren = asn1Children(algorithmNode);
  const algorithmOid = asn1Oid(algorithmChildren[0]);
  if (bitStringNode?.tag !== 0x03 || bitStringNode.value[0] !== 0) throw new Error("Invalid X.509 subject public key");
  const publicKeyBytes = bitStringNode.value.slice(1);
  let nativeKeyObject;
  try {
    nativeKeyObject = createPublicKey({ key: node.bytes, format: "der", type: "spki" });
  } catch {
    nativeKeyObject = undefined;
  }

  if (algorithmOid === "1.2.840.113549.1.1.1") {
    const rsaParts = asn1Children(asn1Read(publicKeyBytes));
    return {
      keyObject: createRsaPublicKey({
        n: bigintFromBytes(asn1IntegerBytes(rsaParts[0])),
        e: bigintFromBytes(asn1IntegerBytes(rsaParts[1])),
      }),
      legacy: {
        modulus: hexFromBytes(asn1IntegerBytes(rsaParts[0])).toUpperCase(),
        exponent: `0x${bigintFromBytes(asn1IntegerBytes(rsaParts[1])).toString(16)}`,
        pubkey: bufferFromBytes(node.bytes),
        bits: bitLength(bigintFromBytes(asn1IntegerBytes(rsaParts[0]))),
      },
    };
  }

  if (algorithmOid === "1.2.840.10045.2.1" && algorithmChildren[1]) {
    const curve = x509EcCurveOids[asn1Oid(algorithmChildren[1])];
    if (curve == null) throw new Error(`X.509 EC curve is not available: ${asn1Oid(algorithmChildren[1])}`);
    return {
      keyObject: nativeKeyObject ?? (curve.asn1Curve === "prime256v1"
        ? createEcPublicKey(p256DecodePoint(publicKeyBytes))
        : createNativeEcPublicKey(curve.asn1Curve, publicKeyBytes)),
      legacy: {
        pubkey: bufferFromBytes(node.bytes),
        asn1Curve: curve.asn1Curve,
        nistCurve: curve.nistCurve,
      },
    };
  }

  if (nativeKeyObject != null) {
    return {
      keyObject: nativeKeyObject,
      legacy: {
        pubkey: bufferFromBytes(node.bytes),
      },
    };
  }

  throw new Error(`X.509 public key algorithm is not available: ${algorithmOid}`);
}

function parseX509GeneralNames(node) {
  const names = [];
  for (const child of asn1Children(asn1Read(node.value))) {
    if (child.tag === 0x82) names.push(`DNS:${new TextDecoder().decode(child.value)}`);
    if (child.tag === 0x87) {
      if (child.value.byteLength === 4) names.push(`IP Address:${Array.from(child.value).join(".")}`);
      else names.push(`IP Address:${Array.from(child.value, (byte) => byte.toString(16).padStart(2, "0")).join(":")}`);
    }
    if (child.tag === 0x81) names.push(`email:${new TextDecoder().decode(child.value)}`);
  }
  return names.join(", ");
}

function parseX509Extensions(node) {
  const result = {};
  for (const extension of asn1Children(asn1Children(node)[0])) {
    const children = asn1Children(extension);
    const oid = asn1Oid(children[0]);
    const valueNode = children.find((child) => child.tag === 0x04);
    if (!valueNode) continue;
    if (oid === "2.5.29.17") result.subjectAltName = parseX509GeneralNames(valueNode);
    if (oid === "2.5.29.19") {
      const basic = asn1Children(asn1Read(valueNode.value));
      result.ca = basic[0]?.tag === 0x01 && basic[0].value[0] !== 0;
    }
    if (oid === "2.5.29.15") result.keyUsage = colonHex(valueNode.value);
  }
  return result;
}

function parseX509Certificate(input) {
  const raw = derFromPemOrBytes(input, "CERTIFICATE");
  const certificate = asn1Read(raw);
  if (certificate.tag !== 0x30 || certificate.end !== raw.byteLength) throw new Error("Invalid X.509 certificate");
  const [tbs, signatureAlgorithmNode, signatureValueNode] = asn1Children(certificate);
  const tbsChildren = asn1Children(tbs);
  let index = 0;
  if ((tbsChildren[index].tag & 0xe0) === 0xa0) index += 1;
  const serialNumber = hexFromBytes(asn1IntegerBytes(tbsChildren[index++])).toUpperCase();
  index += 1;
  const issuer = parseX509Name(tbsChildren[index++]);
  const validity = asn1Children(tbsChildren[index++]);
  const validFromDate = parseX509Time(validity[0]);
  const validToDate = parseX509Time(validity[1]);
  const subject = parseX509Name(tbsChildren[index++]);
  const publicKeyInfo = parseX509PublicKeyInfo(tbsChildren[index++]);
  let extensions = {};
  for (; index < tbsChildren.length; index += 1) {
    if (tbsChildren[index].tag === 0xa3) extensions = parseX509Extensions(tbsChildren[index]);
  }
  const signatureAlgorithm = parseX509Algorithm(signatureAlgorithmNode);
  const signature = signatureValueNode?.tag === 0x03 ? signatureValueNode.value.slice(1) : new Uint8Array();
  return {
    raw,
    tbs: tbs.bytes,
    signature,
    signatureAlgorithm,
    subject,
    issuer,
    validFromDate,
    validToDate,
    serialNumber,
    publicKey: publicKeyInfo.keyObject,
    legacyPublicKey: publicKeyInfo.legacy,
    subjectAltName: extensions.subjectAltName,
    keyUsage: extensions.keyUsage,
    ca: Boolean(extensions.ca),
  };
}

function randomBigint(bits) {
  const length = Math.ceil(bits / 8);
  const bytes = randomBytes(length);
  const excessBits = length * 8 - bits;
  bytes[0] &= 0xff >>> excessBits;
  bytes[0] |= 1 << (7 - excessBits);
  bytes[length - 1] |= 1;
  return bigintFromBytes(bytes);
}

function generatePrimeBigint(size, options = {}) {
  const bits = positiveInteger(size, "prime size");
  if (bits < 2) throw new RangeError("prime size must be at least 2 bits");
  const add = options?.add == null ? null : bigintFromValue(options.add);
  const rem = options?.rem == null ? 1n : bigintFromValue(options.rem);
  for (;;) {
    const candidate = randomBigint(bits);
    if (add != null && candidate % add !== rem % add) continue;
    if (options?.safe && !isProbablePrime((candidate - 1n) / 2n)) continue;
    if (isProbablePrime(candidate)) return candidate;
  }
}

function encodeBigint(value, encoding = undefined, minLength = 0) {
  return encodeDigest(bytesFromBigint(value, minLength), encoding ?? "buffer");
}

function dhByteLength(prime) {
  return Math.ceil(bitLength(prime) / 8);
}

function randomDhPrivateKey(prime) {
  const max = prime - 3n;
  if (max <= 0n) throw new RangeError("Diffie-Hellman prime is too small");
  const length = dhByteLength(prime);
  let value;
  do {
    value = (bigintFromBytes(randomBytes(length)) % max) + 2n;
  } while (value <= 1n || value >= prime - 1n);
  return value;
}

function normalizeDhParameters(primeOrLength, keyEncodingOrGenerator = undefined, generator = undefined, generatorEncoding = undefined) {
  if (typeof primeOrLength === "number") {
    return {
      prime: generatePrimeBigint(primeOrLength),
      generator: generator == null ? bigintFromValue(keyEncodingOrGenerator ?? 2) : bigintFromValue(generator, generatorEncoding),
    };
  }
  if (typeof keyEncodingOrGenerator === "string") {
    return {
      prime: bigintFromValue(primeOrLength, keyEncodingOrGenerator),
      generator: bigintFromValue(generator ?? 2, generatorEncoding),
    };
  }
  return {
    prime: bigintFromValue(primeOrLength),
    generator: bigintFromValue(keyEncodingOrGenerator ?? 2),
  };
}

function callbackify(work, callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  queueMicrotask(() => {
    try {
      callback(null, work());
    } catch (error) {
      callback(error);
    }
  });
}

function argon2AlgorithmName(algorithm) {
  const normalized = String(algorithm).toLowerCase();
  if (normalized === "argon2d" || normalized === "argon2i" || normalized === "argon2id") return normalized;
  throw new TypeError("Invalid Argon2 algorithm; expected one of: argon2d, argon2i, argon2id");
}

function argon2Parameters(parameters) {
  if (parameters == null || typeof parameters !== "object") throw new TypeError("Argon2 parameters must be an object");
  const message = bytesFromData(parameters.message);
  const nonce = bytesFromData(parameters.nonce);
  const parallelism = positiveInteger(parameters.parallelism, "parallelism");
  const tagLength = positiveInteger(parameters.tagLength, "tagLength");
  const memory = positiveInteger(parameters.memory, "memory");
  const passes = positiveInteger(parameters.passes, "passes");
  const secret = parameters.secret == null ? undefined : bytesFromData(parameters.secret);
  const associatedData = parameters.associatedData == null ? undefined : bytesFromData(parameters.associatedData);
  return { message, nonce, parallelism, tagLength, memory, passes, secret, associatedData };
}

function cryptoFeatureError(name) {
  throw new Error(`${name} is unavailable in this Cottontail build`);
}

function assertNativeCipher() {
  if (typeof cottontail.cryptoCipherCreate !== "function" ||
      typeof cottontail.cryptoCipherUpdate !== "function" ||
      typeof cottontail.cryptoCipherFinal !== "function") {
    throw new Error("native cipher support is unavailable");
  }
}

function rotateLeft32(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function readUint32LE(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function salsa208(block) {
  const input = new Uint32Array(16);
  const x = new Uint32Array(16);
  for (let index = 0; index < 16; index += 1) {
    input[index] = readUint32LE(block, index * 4);
    x[index] = input[index];
  }

  for (let round = 0; round < 8; round += 2) {
    x[4] ^= rotateLeft32((x[0] + x[12]) >>> 0, 7);
    x[8] ^= rotateLeft32((x[4] + x[0]) >>> 0, 9);
    x[12] ^= rotateLeft32((x[8] + x[4]) >>> 0, 13);
    x[0] ^= rotateLeft32((x[12] + x[8]) >>> 0, 18);
    x[9] ^= rotateLeft32((x[5] + x[1]) >>> 0, 7);
    x[13] ^= rotateLeft32((x[9] + x[5]) >>> 0, 9);
    x[1] ^= rotateLeft32((x[13] + x[9]) >>> 0, 13);
    x[5] ^= rotateLeft32((x[1] + x[13]) >>> 0, 18);
    x[14] ^= rotateLeft32((x[10] + x[6]) >>> 0, 7);
    x[2] ^= rotateLeft32((x[14] + x[10]) >>> 0, 9);
    x[6] ^= rotateLeft32((x[2] + x[14]) >>> 0, 13);
    x[10] ^= rotateLeft32((x[6] + x[2]) >>> 0, 18);
    x[3] ^= rotateLeft32((x[15] + x[11]) >>> 0, 7);
    x[7] ^= rotateLeft32((x[3] + x[15]) >>> 0, 9);
    x[11] ^= rotateLeft32((x[7] + x[3]) >>> 0, 13);
    x[15] ^= rotateLeft32((x[11] + x[7]) >>> 0, 18);

    x[1] ^= rotateLeft32((x[0] + x[3]) >>> 0, 7);
    x[2] ^= rotateLeft32((x[1] + x[0]) >>> 0, 9);
    x[3] ^= rotateLeft32((x[2] + x[1]) >>> 0, 13);
    x[0] ^= rotateLeft32((x[3] + x[2]) >>> 0, 18);
    x[6] ^= rotateLeft32((x[5] + x[4]) >>> 0, 7);
    x[7] ^= rotateLeft32((x[6] + x[5]) >>> 0, 9);
    x[4] ^= rotateLeft32((x[7] + x[6]) >>> 0, 13);
    x[5] ^= rotateLeft32((x[4] + x[7]) >>> 0, 18);
    x[11] ^= rotateLeft32((x[10] + x[9]) >>> 0, 7);
    x[8] ^= rotateLeft32((x[11] + x[10]) >>> 0, 9);
    x[9] ^= rotateLeft32((x[8] + x[11]) >>> 0, 13);
    x[10] ^= rotateLeft32((x[9] + x[8]) >>> 0, 18);
    x[12] ^= rotateLeft32((x[15] + x[14]) >>> 0, 7);
    x[13] ^= rotateLeft32((x[12] + x[15]) >>> 0, 9);
    x[14] ^= rotateLeft32((x[13] + x[12]) >>> 0, 13);
    x[15] ^= rotateLeft32((x[14] + x[13]) >>> 0, 18);
  }

  const out = new Uint8Array(64);
  for (let index = 0; index < 16; index += 1) {
    writeUint32LE(out, index * 4, (x[index] + input[index]) >>> 0);
  }
  return out;
}

function xorBytes(left, right) {
  const out = new Uint8Array(left.byteLength);
  for (let index = 0; index < left.byteLength; index += 1) out[index] = left[index] ^ right[index];
  return out;
}

function scryptBlockMix(block, r) {
  const chunkCount = 2 * r;
  let x = block.slice((chunkCount - 1) * 64, chunkCount * 64);
  const y = new Array(chunkCount);
  for (let index = 0; index < chunkCount; index += 1) {
    x = salsa208(xorBytes(x, block.slice(index * 64, (index + 1) * 64)));
    y[index] = x;
  }
  const out = new Uint8Array(block.byteLength);
  let offset = 0;
  for (let index = 0; index < chunkCount; index += 2) {
    out.set(y[index], offset);
    offset += 64;
  }
  for (let index = 1; index < chunkCount; index += 2) {
    out.set(y[index], offset);
    offset += 64;
  }
  return out;
}

function scryptIntegerify(block, r) {
  return readUint32LE(block, (2 * r - 1) * 64);
}

function scryptRomix(block, N, r) {
  let x = new Uint8Array(block);
  const v = new Array(N);
  for (let index = 0; index < N; index += 1) {
    v[index] = x;
    x = scryptBlockMix(x, r);
  }
  for (let index = 0; index < N; index += 1) {
    const j = scryptIntegerify(x, r) & (N - 1);
    x = scryptBlockMix(xorBytes(x, v[j]), r);
  }
  return x;
}

function scryptOptions(options = {}) {
  const N = positiveInteger(options.N ?? options.cost ?? 16384, "N");
  const r = positiveInteger(options.r ?? options.blockSize ?? 8, "r");
  const p = positiveInteger(options.p ?? options.parallelization ?? 1, "p");
  const maxmem = positiveInteger(options.maxmem ?? 32 * 1024 * 1024, "maxmem");
  if ((N & (N - 1)) !== 0 || N <= 1) throw new RangeError("N must be a power of two greater than 1");
  if (128 * N * r + 128 * r * p > maxmem) throw new RangeError("Invalid scrypt params: memory limit exceeded");
  return { N, r, p };
}

export class Hash {
  constructor(algorithm, options = undefined) {
    this.algorithm = normalizeAlgorithm(algorithm);
    const requestedOutputLength = options && typeof options === "object" ? options.outputLength : undefined;
    this.outputLength = requestedOutputLength == null
      ? hashOutputLengths[this.algorithm]
      : positiveInteger(requestedOutputLength, "outputLength");
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
    return encodeDigest(digestBytes(this.algorithm, concatBytes(this.chunks), this.outputLength), encoding ?? "buffer");
  }

  copy() {
    const next = new Hash(this.algorithm, { outputLength: this.outputLength });
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

export class KeyObject {
  constructor(type, data, options = {}) {
    const normalizedType = String(type);
    if (normalizedType !== "secret" && normalizedType !== "public" && normalizedType !== "private") {
      throw new TypeError("KeyObject type must be secret, public, or private");
    }
    this.type = normalizedType;
    this.asymmetricKeyType = options.asymmetricKeyType;
    this.asymmetricKeyDetails = options.asymmetricKeyDetails;
    if (normalizedType === "secret") {
      this.bytes = bytesFromData(data, options.encoding);
      return;
    }
    if (options.asymmetricKeyType === "rsa") {
      this.rsa = normalizedType === "private" ? rsaPrivateParts(data) : rsaPublicParts(data);
      this.asymmetricKeyDetails = rsaKeyOptions(this.rsa).asymmetricKeyDetails;
      return;
    }
    if (options.asymmetricKeyType === "ed25519") {
      this.asymmetricKeyDetails = {};
      if (normalizedType === "private") {
        this.privateKeyBytes = bytesFromData(data.privateKey ?? data);
        if (this.privateKeyBytes.byteLength !== 32) throw new TypeError("Ed25519 private key must be 32 bytes");
        this.publicKey = data.publicKey == null ? ed25519PublicFromPrivate(this.privateKeyBytes) : bytesFromData(data.publicKey);
      } else {
        this.publicKey = bytesFromData(data);
      }
      if (this.publicKey.byteLength !== 32) throw new TypeError("Ed25519 public key must be 32 bytes");
      return;
    }
    if (rawKeyInfo[options.asymmetricKeyType]) {
      const info = rawKeyInfo[options.asymmetricKeyType];
      this.asymmetricKeyDetails = {};
      if (normalizedType === "private") {
        this.privateKeyBytes = bytesFromData(data.privateKey ?? data);
        if (this.privateKeyBytes.byteLength !== info.privateLength) throw new TypeError(`${options.asymmetricKeyType} private key must be ${info.privateLength} bytes`);
        this.publicKey = data.publicKey == null ? rawPublicFromPrivate(options.asymmetricKeyType, this.privateKeyBytes) : bytesFromData(data.publicKey);
      } else {
        this.publicKey = bytesFromData(data);
      }
      if (this.publicKey.byteLength !== info.publicLength) throw new TypeError(`${options.asymmetricKeyType} public key must be ${info.publicLength} bytes`);
      return;
    }
    if (options.asymmetricKeyType !== "ec") {
      throw new TypeError("Only EC KeyObjects are supported");
    }
    const namedCurve = ecCurveName(options.asymmetricKeyDetails?.namedCurve);
    this.asymmetricKeyDetails = { namedCurve };
    if (namedCurve !== "prime256v1") {
      this.namedCurve = namedCurve;
      if (normalizedType === "private") {
        this.privateKeyBytes = bytesFromData(data.privateKey ?? data);
        this.publicKeyBytes = data.publicKey == null ? ecPublicFromPrivate(namedCurve, this.privateKeyBytes) : bytesFromData(data.publicKey);
      } else {
        this.publicKeyBytes = bytesFromData(data);
      }
      return;
    }
    this.privateKey = normalizedType === "private" ? p256PrivateFromValue(data) : undefined;
    this.publicPoint = normalizedType === "private" ? p256PublicFromPrivate(this.privateKey) : data;
  }

  get symmetricKeySize() {
    return this.type === "secret" ? this.bytes.byteLength : undefined;
  }

  export(options = undefined) {
    const format = options?.format == null ? undefined : String(options.format).toLowerCase();
    if (this.type !== "secret" && this.asymmetricKeyType === "ed25519" && format === "jwk") return ed25519JwkFromKey(this);
    if (this.type !== "secret" && rawKeyInfo[this.asymmetricKeyType] && format === "jwk") return rawJwkFromKey(this);
    if (this.type !== "secret" && this.asymmetricKeyType === "rsa" && format === "jwk") return rsaJwkFromKey(this);
    if (this.type !== "secret" && this.asymmetricKeyType === "rsa" && (format === "pem" || format === "der")) return rsaNativeExportKey(this, options);
    if (this.type !== "secret" && this.asymmetricKeyType === "ec" && (format === "pem" || format === "der")) return ecNativeExportKey(this, options);
    if (this.type !== "secret" && (this.asymmetricKeyType === "ed25519" || rawKeyInfo[this.asymmetricKeyType]) && (format === "pem" || format === "der")) return rawNativeExportKey(this, options);
    if (this.type !== "secret" && format === "jwk") return this.publicKeyBytes != null ? nativeEcJwkFromKey(this) : p256JwkFromKey(this);
    if (this.type !== "secret") throw new Error("Invalid asymmetric KeyObject export format");
    if (options != null && typeof options === "object" && options.format && options.format !== "buffer") {
      throw new TypeError("Secret KeyObject export only supports buffer format");
    }
    return bufferFromBytes(this.bytes);
  }

  equals(otherKeyObject) {
    if (!(otherKeyObject instanceof KeyObject)) return false;
    if (this.type !== otherKeyObject.type) return false;
    if (this.type !== "secret") {
      const left = this.export({ format: "jwk" });
      const right = otherKeyObject.export({ format: "jwk" });
      return JSON.stringify(left) === JSON.stringify(right);
    }
    if (this.bytes.byteLength !== otherKeyObject.bytes.byteLength) return false;
    return timingSafeEqual(this.bytes, otherKeyObject.bytes);
  }
}

function ecKeyOptions() {
  return { asymmetricKeyType: "ec", asymmetricKeyDetails: { namedCurve: "prime256v1" } };
}

function createEcPrivateKey(privateKey) {
  return new KeyObject("private", privateKey, ecKeyOptions());
}

function createEcPublicKey(publicPoint) {
  return new KeyObject("public", publicPoint, ecKeyOptions());
}

function nativeEcKeyOptions(namedCurve) {
  return { asymmetricKeyType: "ec", asymmetricKeyDetails: { namedCurve } };
}

function createNativeEcPrivateKey(namedCurve, privateKey, publicKey = undefined) {
  return new KeyObject("private", { privateKey, publicKey }, nativeEcKeyOptions(namedCurve));
}

function createNativeEcPublicKey(namedCurve, publicKey) {
  return new KeyObject("public", publicKey, nativeEcKeyOptions(namedCurve));
}

function createRsaPrivateKey(parts) {
  return new KeyObject("private", parts, rsaKeyOptions(parts));
}

function createRsaPublicKey(parts) {
  return new KeyObject("public", parts, rsaKeyOptions(parts));
}

function ed25519KeyOptions() {
  return { asymmetricKeyType: "ed25519", asymmetricKeyDetails: {} };
}

function createEd25519PrivateKey(privateKey, publicKey = undefined) {
  return new KeyObject("private", { privateKey, publicKey }, ed25519KeyOptions());
}

function createEd25519PublicKey(publicKey) {
  return new KeyObject("public", publicKey, ed25519KeyOptions());
}

function rawKeyOptions(type) {
  return { asymmetricKeyType: type, asymmetricKeyDetails: {} };
}

function createRawPrivateKey(type, privateKey, publicKey = undefined) {
  return new KeyObject("private", { privateKey, publicKey }, rawKeyOptions(type));
}

function createRawPublicKey(type, publicKey) {
  return new KeyObject("public", publicKey, rawKeyOptions(type));
}

function keyObjectFromJwk(jwk, type = undefined) {
  if (String(jwk?.kty ?? "").toUpperCase() === "OKP" && String(jwk?.crv) === "Ed25519") {
    if (jwk?.d != null && type !== "public") {
      const parsed = ed25519PrivateFromJwk(jwk);
      return createEd25519PrivateKey(parsed.privateKey, parsed.publicKey);
    }
    return createEd25519PublicKey(ed25519PublicFromJwk(jwk));
  }
  if (String(jwk?.kty ?? "").toUpperCase() === "OKP") {
    const entry = Object.entries(rawKeyInfo).find(([, info]) => info.crv === String(jwk?.crv));
    if (entry == null) throw new TypeError("Invalid OKP JWK curve");
    const [rawType] = entry;
    const publicKey = bytesFromBase64Url(jwk.x);
    if (jwk?.d != null && type !== "public") return createRawPrivateKey(rawType, bytesFromBase64Url(jwk.d), publicKey);
    return createRawPublicKey(rawType, publicKey);
  }
  if (String(jwk?.kty ?? "").toUpperCase() === "RSA") {
    if (jwk?.d != null && type !== "public") return createRsaPrivateKey(rsaPrivatePartsFromJwk(jwk));
    return createRsaPublicKey(rsaPublicPartsFromJwk(jwk));
  }
  if (String(jwk?.kty ?? "").toUpperCase() === "EC" && p256CurveName(jwk?.crv) !== "prime256v1") {
    const namedCurve = ecCurveName(jwk.crv);
    const publicKey = nativeEcPublicBytesFromJwk(jwk);
    if (jwk?.d != null && type !== "public") return createNativeEcPrivateKey(namedCurve, bytesFromBase64Url(jwk.d), publicKey);
    return createNativeEcPublicKey(namedCurve, publicKey);
  }
  if (jwk?.d != null && type !== "public") {
    const parsed = p256PrivateFromJwk(jwk);
    return createEcPrivateKey(parsed.privateKey);
  }
  return createEcPublicKey(p256PointFromJwk(jwk));
}

function keyObjectFromInput(input, type = undefined) {
  if (input instanceof KeyObject) {
    if (type === "private" && input.type !== "private") throw new TypeError("Expected a private KeyObject");
    if (type === "public" && input.type === "secret") throw new TypeError("Expected a public or private KeyObject");
    return input;
  }
  if (input && typeof input === "object" && input.key != null) {
    const keyData = input.key;
    if (typeof keyData === "string" || keyData instanceof ArrayBuffer || ArrayBuffer.isView(keyData)) return keyObjectFromEncodedInput(input, type);
    return keyObjectFromInput(keyData, type);
  }
  if (input && typeof input === "object" && String(input.kty ?? "").toUpperCase() === "OKP") return keyObjectFromJwk(input, type);
  if (input && typeof input === "object" && String(input.kty ?? "").toUpperCase() === "EC") return keyObjectFromJwk(input, type);
  if (input && typeof input === "object" && String(input.kty ?? "").toUpperCase() === "RSA") return keyObjectFromJwk(input, type);
  if (typeof input === "string" || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) return keyObjectFromEncodedInput(input, type);
  throw new TypeError("Only EC P-256/RSA JWK and KeyObject inputs are supported");
}

function resolvePublicKeyObject(input) {
  const key = keyObjectFromInput(input, "public");
  if (key.type === "public") return key;
  if (key.type === "private" && key.asymmetricKeyType === "ec" && key.publicKeyBytes != null) return createNativeEcPublicKey(key.namedCurve, key.publicKeyBytes);
  if (key.type === "private" && key.asymmetricKeyType === "ec") return createEcPublicKey(key.publicPoint);
  if (key.type === "private" && key.asymmetricKeyType === "rsa") return createRsaPublicKey(key.rsa);
  if (key.type === "private" && key.asymmetricKeyType === "ed25519") return createEd25519PublicKey(key.publicKey);
  if (key.type === "private" && rawKeyInfo[key.asymmetricKeyType]) return createRawPublicKey(key.asymmetricKeyType, key.publicKey);
  throw new TypeError("Expected an asymmetric public or private KeyObject");
}

function normalizeDsaEncoding(options = undefined) {
  const value = options && typeof options === "object" ? options.dsaEncoding : undefined;
  if (value == null || value === "der") return "der";
  if (value === "ieee-p1363") return "ieee-p1363";
  throw new TypeError(`Invalid dsaEncoding: ${value}`);
}

function keyInputFromSignOptions(options) {
  return options && typeof options === "object" && options.key != null ? options.key : options;
}

function signaturePadding(options = undefined, fallback = constantsObject.RSA_PKCS1_PADDING) {
  return options && typeof options === "object" && options.padding != null ? options.padding : fallback;
}

function rsaOperationOptions(key, fallbackPadding) {
  const options = key && typeof key === "object" && key.key != null ? key : {};
  return {
    key: options.key ?? key,
    padding: options.padding ?? fallbackPadding,
    oaepHash: options.oaepHash ?? "sha1",
    oaepLabel: options.oaepLabel,
  };
}

function encapsulateSync(key) {
  const publicKey = resolvePublicKeyObject(key);
  if (publicKey.asymmetricKeyType === "ec") {
    const ephemeralPrivate = p256RandomPrivateKey();
    const ephemeralPublic = p256PublicFromPrivate(ephemeralPrivate);
    const secret = p256Multiply(ephemeralPrivate, publicKey.publicPoint);
    if (secret == null) throw new Error("Failed to compute KEM shared key");
    return {
      sharedKey: bufferFromBytes(digestBytes("sha256", bytesFromBigint(secret.x, p256.size))),
      ciphertext: p256EncodePoint(ephemeralPublic),
    };
  }
  if (publicKey.asymmetricKeyType === "rsa") {
    const length = rsaModulusLength(publicKey);
    let material;
    do {
      material = randomBytes(length);
    } while (bigintFromBytes(material) >= publicKey.rsa.n);
    return {
      sharedKey: bufferFromBytes(digestBytes("sha512", material)),
      ciphertext: rsaPublicApply(publicKey, material),
    };
  }
  throw new TypeError(`KEM key type is not available: ${publicKey.asymmetricKeyType}`);
}

function decapsulateSync(key, ciphertext) {
  const privateKey = keyObjectFromInput(key, "private");
  const bytes = bytesFromData(ciphertext);
  if (privateKey.asymmetricKeyType === "ec") {
    const publicPoint = p256DecodePoint(bytes);
    const secret = p256Multiply(privateKey.privateKey, publicPoint);
    if (secret == null) throw new Error("Failed to compute KEM shared key");
    return bufferFromBytes(digestBytes("sha256", bytesFromBigint(secret.x, p256.size)));
  }
  if (privateKey.asymmetricKeyType === "rsa") {
    return bufferFromBytes(digestBytes("sha512", rsaPrivateApply(privateKey, bytes)));
  }
  throw new TypeError(`KEM key type is not available: ${privateKey.asymmetricKeyType}`);
}

export class DiffieHellman {
  constructor(primeOrLength, keyEncodingOrGenerator = undefined, generator = undefined, generatorEncoding = undefined) {
    const params = normalizeDhParameters(primeOrLength, keyEncodingOrGenerator, generator, generatorEncoding);
    if (params.prime <= 3n || !isProbablePrime(params.prime)) {
      throw new RangeError("Diffie-Hellman prime must be a prime greater than 3");
    }
    if (params.generator <= 1n || params.generator >= params.prime) {
      throw new RangeError("Diffie-Hellman generator out of range");
    }
    this.prime = params.prime;
    this.generator = params.generator;
    this.privateKey = randomDhPrivateKey(this.prime);
    this.publicKey = undefined;
  }

  computeSecret(otherPublicKey, inputEncoding = undefined, outputEncoding = undefined) {
    const publicKey = bigintFromValue(otherPublicKey, inputEncoding);
    if (publicKey <= 1n || publicKey >= this.prime) throw new RangeError("Public key is out of range");
    return encodeBigint(modPow(publicKey, this.privateKey, this.prime), outputEncoding, dhByteLength(this.prime));
  }

  generateKeys(encoding = undefined) {
    this.publicKey = modPow(this.generator, this.privateKey, this.prime);
    return this.getPublicKey(encoding);
  }

  getGenerator(encoding = undefined) {
    return encodeBigint(this.generator, encoding);
  }

  getPrime(encoding = undefined) {
    return encodeBigint(this.prime, encoding, dhByteLength(this.prime));
  }

  getPrivateKey(encoding = undefined) {
    return encodeBigint(this.privateKey, encoding, dhByteLength(this.prime));
  }

  getPublicKey(encoding = undefined) {
    if (this.publicKey == null) this.generateKeys();
    return encodeBigint(this.publicKey, encoding, dhByteLength(this.prime));
  }

  setPrivateKey(privateKey, encoding = undefined) {
    const value = bigintFromValue(privateKey, encoding);
    if (value <= 1n || value >= this.prime - 1n) throw new RangeError("Private key is out of range");
    this.privateKey = value;
    this.publicKey = undefined;
  }

  setPublicKey(publicKey, encoding = undefined) {
    const value = bigintFromValue(publicKey, encoding);
    if (value <= 1n || value >= this.prime) throw new RangeError("Public key is out of range");
    this.publicKey = value;
  }
}

export class DiffieHellmanGroup extends DiffieHellman {
  constructor(name) {
    const normalized = String(name).toLowerCase();
    const prime = dhGroupPrimes[normalized];
    if (!prime) throw new TypeError(`Unknown Diffie-Hellman group: ${name}`);
    super(prime, "hex", 2);
    this.name = normalized;
  }
}

export class Certificate {
  static verifySpkac(spkac, encoding = undefined) {
    return new Certificate().verifySpkac(spkac, encoding);
  }

  static exportPublicKey(spkac, encoding = undefined) {
    return new Certificate().exportPublicKey(spkac, encoding);
  }

  static exportChallenge(spkac, encoding = undefined) {
    return new Certificate().exportChallenge(spkac, encoding);
  }

  verifySpkac(spkac, encoding = undefined) {
    if (typeof cottontail.cryptoSpkacVerify !== "function") cryptoFeatureError("crypto.Certificate.verifySpkac");
    return Boolean(cottontail.cryptoSpkacVerify(bytesFromData(spkac, encoding)));
  }

  exportPublicKey(spkac, encoding = undefined) {
    if (typeof cottontail.cryptoSpkacExportPublicKey !== "function") cryptoFeatureError("crypto.Certificate.exportPublicKey");
    return bufferFromBytes(new Uint8Array(cottontail.cryptoSpkacExportPublicKey(bytesFromData(spkac, encoding))));
  }

  exportChallenge(spkac, encoding = undefined) {
    try {
      const encoded = new TextDecoder().decode(bytesFromData(spkac, encoding)).trim();
      const signed = asn1Read(bytesFromData(encoded, "base64"));
      if (signed.tag !== 0x30 || signed.end !== signed.bytes.byteLength) return bufferFromBytes(new Uint8Array());
      const [publicKeyAndChallenge] = asn1Children(signed);
      if (publicKeyAndChallenge?.tag !== 0x30) return bufferFromBytes(new Uint8Array());
      const [, challenge] = asn1Children(publicKeyAndChallenge);
      if (challenge?.tag !== 0x16) return bufferFromBytes(new Uint8Array());
      return bufferFromBytes(challenge.value);
    } catch {
      return bufferFromBytes(new Uint8Array());
    }
  }
}

class CipherBase {
  constructor(algorithm, key, iv, options = {}, encrypt = true) {
    this.algorithm = normalizeCipherName(algorithm);
    this.info = cipherInfoForName(this.algorithm);
    if (!this.info) throw new TypeError(`Unknown cipher algorithm: ${algorithm}`);
    this.key = bytesFromData(key);
    const ivLength = this.info.ivLength ?? 0;
    this.iv = ivLength === 0 ? new Uint8Array(0) : bytesFromData(iv);
    if (this.key.byteLength !== this.info.keyLength) throw new RangeError("Invalid key length");
    if (this.info.authTagLength > 0) {
      if (this.iv.byteLength === 0) throw new TypeError("Invalid initialization vector");
    } else if (this.iv.byteLength !== ivLength) {
      throw new TypeError("Invalid initialization vector");
    }
    this.encrypt = encrypt;
    this.autoPadding = options?.autoPadding !== false;
    if (this.info.authTagLength > 0 && options?.authTagLength !== undefined) {
      const authTagLength = options.authTagLength;
      if (typeof authTagLength !== "number" || !Number.isInteger(authTagLength) || authTagLength <= 0) {
        throw new TypeError(`The property 'options.authTagLength' is invalid. Received ${authTagLength}`);
      }
    }
    this.authTagLength = this.info.authTagLength > 0
      ? positiveInteger(options?.authTagLength ?? this.info.authTagLength, "authTagLength")
      : 0;
    this.finalized = false;
    this.id = null;
    this.readBuffer = null;
  }

  _ensureCipher() {
    if (this.finalized) throw new Error("Cipher already finalized");
    if (this.id == null) {
      assertNativeCipher();
      this.id = cottontail.cryptoCipherCreate(this.algorithm, this.key, this.iv, this.encrypt, this.autoPadding);
    }
    return this.id;
  }

  update(data, inputEncoding = undefined, outputEncoding = undefined) {
    const bytes = bytesFromData(data, inputEncoding);
    const output = new Uint8Array(cottontail.cryptoCipherUpdate(this._ensureCipher(), bytes));
    return encodeDigest(output, outputEncoding ?? "buffer");
  }

  final(outputEncoding = undefined) {
    const id = this._ensureCipher();
    try {
      const output = new Uint8Array(cottontail.cryptoCipherFinal(id));
      return encodeDigest(output, outputEncoding ?? "buffer");
    } finally {
      this.finalized = true;
      if (!this.encrypt || this.info.authTagLength === 0) this.id = null;
    }
  }

  end(data = undefined, inputEncoding = undefined) {
    const chunks = [];
    if (data != null) chunks.push(bytesFromData(this.update(data, inputEncoding)));
    chunks.push(bytesFromData(this.final()));
    this.readBuffer = bufferFromBytes(concatBytes(chunks));
    return this;
  }

  read() {
    const value = this.readBuffer;
    this.readBuffer = null;
    return value;
  }

  setAAD(buffer, options = undefined) {
    if (this.finalized) throw new Error("Cipher already finalized");
    if (this.info.authTagLength === 0) throw new Error("setAAD is only available for AEAD ciphers");
    if (!this.encrypt && options?.plaintextLength != null) void positiveInteger(options.plaintextLength, "plaintextLength", true);
    cottontail.cryptoCipherSetAAD(this._ensureCipher(), bytesFromData(buffer));
    return this;
  }

  setAutoPadding(autoPadding = true) {
    if (this.id != null) throw new Error("setAutoPadding must be called before cipher update");
    this.autoPadding = Boolean(autoPadding);
    return this;
  }
}

export class Cipheriv extends CipherBase {
  constructor(algorithm, key, iv, options = {}) {
    super(algorithm, key, iv, options, true);
  }

  getAuthTag() {
    if (this.info.authTagLength === 0) throw new Error("getAuthTag is only available for AEAD ciphers");
    if (!this.finalized || this.id == null) throw new Error("getAuthTag must be called after final");
    const tag = new Uint8Array(cottontail.cryptoCipherGetAuthTag(this.id));
    this.id = null;
    return bufferFromBytes(tag.slice(0, this.authTagLength));
  }
}

export class Decipheriv extends CipherBase {
  constructor(algorithm, key, iv, options = {}) {
    super(algorithm, key, iv, options, false);
  }

  setAuthTag(tag) {
    if (this.finalized) throw new Error("Cipher already finalized");
    if (this.info.authTagLength === 0) throw new Error("setAuthTag is only available for AEAD ciphers");
    const bytes = bytesFromData(tag);
    if (bytes.byteLength === 0 || bytes.byteLength > 16) throw new TypeError("Invalid authentication tag length");
    cottontail.cryptoCipherSetAuthTag(this._ensureCipher(), bytes);
    return this;
  }
}

export class ECDH {
  constructor(curveName) {
    const normalized = ecCurveName(curveName);
    if (normalized !== "prime256v1") {
      if (!supportedNativeEcCurves.includes(normalized)) cryptoFeatureError(`crypto.ECDH(${curveName})`);
      this.nativeCurveName = normalized;
      this.privateKeyBytes = undefined;
      this.publicKeyBytes = undefined;
      return;
    }
    this.curve = p256;
    this.privateKey = undefined;
    this.publicKey = undefined;
  }

  generateKeys(encoding = undefined, format = "uncompressed") {
    if (this.nativeCurveName != null) {
      if (typeof cottontail.cryptoEcGenerateKeyPair !== "function") cryptoFeatureError(`crypto.ECDH(${this.nativeCurveName})`);
      const pair = cottontail.cryptoEcGenerateKeyPair(this.nativeCurveName);
      this.privateKeyBytes = new Uint8Array(pair.privateKey);
      this.publicKeyBytes = new Uint8Array(pair.publicKey);
      return encodeDigest(nativeEcEncodePoint(this.publicKeyBytes, this.nativeCurveName, format), encoding ?? "buffer");
    }
    this.privateKey = p256RandomPrivateKey();
    this.publicKey = p256Multiply(this.privateKey);
    return encodeDigest(p256EncodePoint(this.publicKey, format), encoding ?? "buffer");
  }

  computeSecret(otherPublicKey, inputEncoding = undefined, outputEncoding = undefined) {
    if (this.nativeCurveName != null) {
      if (this.privateKeyBytes == null) throw new Error("Private key is not set");
      if (typeof cottontail.cryptoEcDiffieHellman !== "function") cryptoFeatureError(`crypto.ECDH(${this.nativeCurveName}).computeSecret`);
      const point = bytesFromData(otherPublicKey, inputEncoding);
      return encodeDigest(new Uint8Array(cottontail.cryptoEcDiffieHellman(this.nativeCurveName, this.privateKeyBytes, point)), outputEncoding ?? "buffer");
    }
    if (this.privateKey == null) throw new Error("Private key is not set");
    const point = p256DecodePoint(otherPublicKey, inputEncoding);
    const secret = p256Multiply(this.privateKey, point);
    if (secret == null) throw new Error("Failed to compute ECDH secret");
    return encodeDigest(bytesFromBigint(secret.x, p256.size), outputEncoding ?? "buffer");
  }

  getPrivateKey(encoding = undefined) {
    if (this.nativeCurveName != null) {
      if (this.privateKeyBytes == null) throw new Error("Private key is not set");
      return encodeDigest(this.privateKeyBytes, encoding ?? "buffer");
    }
    if (this.privateKey == null) throw new Error("Private key is not set");
    return encodeDigest(bytesFromBigint(this.privateKey, p256.size), encoding ?? "buffer");
  }

  getPublicKey(encoding = undefined, format = "uncompressed") {
    if (this.nativeCurveName != null) {
      if (this.publicKeyBytes == null) {
        if (this.privateKeyBytes == null) throw new Error("Public key is not set");
        this.publicKeyBytes = ecPublicFromPrivate(this.nativeCurveName, this.privateKeyBytes);
      }
      return encodeDigest(nativeEcEncodePoint(this.publicKeyBytes, this.nativeCurveName, format), encoding ?? "buffer");
    }
    if (this.publicKey == null) {
      if (this.privateKey == null) throw new Error("Public key is not set");
      this.publicKey = p256Multiply(this.privateKey);
    }
    return encodeDigest(p256EncodePoint(this.publicKey, format), encoding ?? "buffer");
  }

  setPrivateKey(privateKey, encoding = undefined) {
    if (this.nativeCurveName != null) {
      this.privateKeyBytes = bytesFromData(privateKey, encoding);
      this.publicKeyBytes = ecPublicFromPrivate(this.nativeCurveName, this.privateKeyBytes);
      return;
    }
    this.privateKey = p256PrivateFromValue(privateKey, encoding);
    this.publicKey = p256Multiply(this.privateKey);
  }

  setPublicKey(publicKey, encoding = undefined) {
    if (this.nativeCurveName != null) {
      this.publicKeyBytes = bytesFromData(publicKey, encoding);
      return;
    }
    this.publicKey = p256DecodePoint(publicKey, encoding);
  }
}

export class Sign {
  constructor(algorithm) {
    this.algorithm = String(algorithm);
    this.chunks = [];
  }

  update(data, inputEncoding = undefined) {
    this.chunks.push(bytesFromData(data, inputEncoding));
    return this;
  }

  end() {
    return this;
  }

  sign(privateKey, outputEncoding = undefined) {
    const dsaEncoding = normalizeDsaEncoding(privateKey);
    const options = privateKey && typeof privateKey === "object" && privateKey.key != null ? privateKey : undefined;
    const key = keyObjectFromInput(keyInputFromSignOptions(privateKey), "private");
    if (key.asymmetricKeyType === "ed25519") throwEd25519StreamError();
    if (key.asymmetricKeyType === "rsa") {
      const nativeSignature = rsaNativeSignData(this.algorithm, concatBytes(this.chunks), key, options);
      if (nativeSignature !== undefined) return outputEncoding == null ? nativeSignature : encodeDigest(nativeSignature, outputEncoding);
    }
    const digest = digestBytes(this.algorithm, concatBytes(this.chunks));
    const signature = key.asymmetricKeyType === "rsa"
      ? rsaSignDigest(this.algorithm, digest, key, options)
      : ecdsaSignDigest(digest, key, dsaEncoding);
    return outputEncoding == null ? signature : encodeDigest(signature, outputEncoding);
  }
}

export class Verify {
  constructor(algorithm) {
    this.algorithm = String(algorithm);
    this.chunks = [];
  }

  update(data, inputEncoding = undefined) {
    this.chunks.push(bytesFromData(data, inputEncoding));
    return this;
  }

  end() {
    return this;
  }

  verify(publicKey, signature, signatureEncoding = undefined) {
    const dsaEncoding = normalizeDsaEncoding(publicKey);
    const options = publicKey && typeof publicKey === "object" && publicKey.key != null ? publicKey : undefined;
    const key = keyObjectFromInput(keyInputFromSignOptions(publicKey), "public");
    if (resolvePublicKeyObject(key).asymmetricKeyType === "ed25519") throwEd25519StreamError();
    const signatureBytes = typeof signature === "string" ? bytesFromData(signature, signatureEncoding) : bytesFromData(signature);
    if (resolvePublicKeyObject(key).asymmetricKeyType === "rsa") {
      const nativeResult = rsaNativeVerifyData(this.algorithm, concatBytes(this.chunks), key, signatureBytes, options);
      if (nativeResult !== undefined) return nativeResult;
    }
    const digest = digestBytes(this.algorithm, concatBytes(this.chunks));
    return key.asymmetricKeyType === "rsa"
      ? rsaVerifyDigest(this.algorithm, digest, key, signatureBytes, options)
      : ecdsaVerifyDigest(digest, key, signatureBytes, dsaEncoding);
  }
}

export class X509Certificate {
  constructor(buffer) {
    const parsed = parseX509Certificate(buffer);
    this.raw = bufferFromBytes(parsed.raw);
    this.subject = parsed.subject.text || undefined;
    this.subjectObject = parsed.subject.object;
    this.subjectAltName = parsed.subjectAltName || undefined;
    this.issuer = parsed.issuer.text || undefined;
    this.issuerObject = parsed.issuer.object;
    this.issuerCertificate = undefined;
    this.infoAccess = undefined;
    this.validFromDate = parsed.validFromDate;
    this.validToDate = parsed.validToDate;
    this.validFrom = formatX509Date(parsed.validFromDate);
    this.validTo = formatX509Date(parsed.validToDate);
    this.fingerprint = colonHex(digestBytes("sha1", parsed.raw));
    this.fingerprint256 = colonHex(digestBytes("sha256", parsed.raw));
    this.fingerprint512 = colonHex(digestBytes("sha512", parsed.raw));
    this.keyUsage = parsed.keyUsage;
    this.serialNumber = parsed.serialNumber;
    this.signatureAlgorithm = parsed.signatureAlgorithm.name;
    this.signatureAlgorithmOid = parsed.signatureAlgorithm.oid;
    this.publicKey = parsed.publicKey;
    this.ca = parsed.ca;
    this._parsed = parsed;
  }

  toString() {
    return pemFromDer("CERTIFICATE", this.raw);
  }

  toJSON() {
    return this.toString();
  }

  checkHost(name) {
    const host = String(name).toLowerCase();
    const altNames = String(this.subjectAltName ?? "").split(/,\s*/).filter(Boolean);
    for (const entry of altNames) {
      if (entry.toLowerCase() === `dns:${host}`) return name;
    }
    if (String(this.subjectObject.CN ?? "").toLowerCase() === host) return name;
    return undefined;
  }

  checkEmail(email) {
    const value = String(email).toLowerCase();
    const altNames = String(this.subjectAltName ?? "").split(/,\s*/).filter(Boolean);
    for (const entry of altNames) {
      if (entry.toLowerCase() === `email:${value}`) return email;
    }
    if (String(this.subjectObject.emailAddress ?? "").toLowerCase() === value) return email;
    return undefined;
  }

  checkIP(ip) {
    const value = String(ip);
    const altNames = String(this.subjectAltName ?? "").split(/,\s*/).filter(Boolean);
    for (const entry of altNames) {
      if (entry === `IP Address:${value}`) return ip;
    }
    return undefined;
  }

  checkIssued(otherCert) {
    return otherCert instanceof X509Certificate && this.issuer === otherCert.subject;
  }

  checkPrivateKey(privateKey) {
    try {
      return createPublicKey(privateKey).equals(this.publicKey);
    } catch {
      return false;
    }
  }

  verify(publicKey) {
    const key = resolvePublicKeyObject(publicKey);
    if (this._parsed.signatureAlgorithm.keyType === "rsa") {
      return rsaVerifyDigest(this._parsed.signatureAlgorithm.digest, digestBytes(this._parsed.signatureAlgorithm.digest, this._parsed.tbs), key, this._parsed.signature);
    }
    if (this._parsed.signatureAlgorithm.keyType === "ec") {
      return ecdsaVerifyDigest(digestBytes(this._parsed.signatureAlgorithm.digest, this._parsed.tbs), key, this._parsed.signature);
    }
    if (this._parsed.signatureAlgorithm.keyType === "ed25519" || this._parsed.signatureAlgorithm.keyType === "ed448") {
      return verify(null, this._parsed.tbs, key, this._parsed.signature);
    }
    return false;
  }

  toLegacyObject() {
    return {
      subject: this.subjectObject,
      issuer: this.issuerObject,
      subjectaltname: this.subjectAltName,
      infoAccess: this.infoAccess,
      ca: this.ca,
      ...this._parsed.legacyPublicKey,
      valid_from: this.validFrom,
      valid_to: this.validTo,
      fingerprint: this.fingerprint,
      fingerprint256: this.fingerprint256,
      fingerprint512: this.fingerprint512,
      ext_key_usage: undefined,
      serialNumber: this.serialNumber,
      raw: this.raw,
      asn1Curve: this._parsed.legacyPublicKey.asn1Curve,
      nistCurve: this._parsed.legacyPublicKey.nistCurve,
    };
  }
}

export function createHash(algorithm, options = undefined) {
  return new Hash(algorithm, options);
}

export function createHmac(algorithm, key) {
  return new Hmac(algorithm, key);
}

export function hash(algorithm, data, outputEncoding = "hex") {
  return encodeDigest(digestBytes(algorithm, bytesFromData(data), hashOutputLengths[normalizeAlgorithm(algorithm)]), outputEncoding);
}

export function getHashes() {
  return [...supportedHashes];
}

export function createSecretKey(key, encoding = undefined) {
  return new KeyObject("secret", key, { encoding });
}

export function hkdfSync(digest, ikm, salt, info, keylen) {
  const length = positiveInteger(keylen, "keylen", true);
  const hashLength = digestBytes(digest, new Uint8Array()).byteLength;
  if (length > 255 * hashLength) throw new RangeError("HKDF key length is too large");
  const saltBytes = bytesFromData(salt);
  const extractSalt = saltBytes.byteLength === 0 ? new Uint8Array(hashLength) : saltBytes;
  const prk = hmacBytes(digest, extractSalt, bytesFromData(ikm));
  const infoBytes = bytesFromData(info);
  const chunks = [];
  let previous = new Uint8Array(0);
  for (let counter = 1; concatBytes(chunks).byteLength < length; counter += 1) {
    if (counter > 255) throw new RangeError("HKDF counter overflow");
    previous = hmacBytes(digest, prk, concatBytes([previous, infoBytes, new Uint8Array([counter])]));
    chunks.push(previous);
  }
  return bufferFromBytes(concatBytes(chunks).slice(0, length));
}

export function hkdf(digest, ikm, salt, info, keylen, callback) {
  callbackify(() => hkdfSync(digest, ikm, salt, info, keylen), callback);
}

export function pbkdf2Sync(password, salt, iterations, keylen, digest = "sha1") {
  const count = positiveInteger(iterations, "iterations");
  const length = positiveInteger(keylen, "keylen", true);
  const algorithm = digest ?? "sha1";
  const passwordBytes = bytesFromData(password);
  const saltBytes = bytesFromData(salt);
  const hashLength = hmacBytes(algorithm, passwordBytes, new Uint8Array()).byteLength;
  const blocks = Math.ceil(length / hashLength);
  const output = new Uint8Array(blocks * hashLength);
  for (let block = 1; block <= blocks; block += 1) {
    const blockIndex = new Uint8Array([
      (block >>> 24) & 0xff,
      (block >>> 16) & 0xff,
      (block >>> 8) & 0xff,
      block & 0xff,
    ]);
    let u = hmacBytes(algorithm, passwordBytes, concatBytes([saltBytes, blockIndex]));
    const t = new Uint8Array(u);
    for (let index = 1; index < count; index += 1) {
      u = hmacBytes(algorithm, passwordBytes, u);
      for (let byteIndex = 0; byteIndex < t.byteLength; byteIndex += 1) {
        t[byteIndex] ^= u[byteIndex];
      }
    }
    output.set(t, (block - 1) * hashLength);
  }
  return bufferFromBytes(output.slice(0, length));
}

export function pbkdf2(password, salt, iterations, keylen, digest, callback) {
  if (typeof digest === "function") {
    callback = digest;
    digest = "sha1";
  }
  callbackify(() => pbkdf2Sync(password, salt, iterations, keylen, digest), callback);
}

export function scryptSync(password, salt, keylen, options = {}) {
  const length = positiveInteger(keylen, "keylen", true);
  const { N, r, p } = scryptOptions(options ?? {});
  const blockLength = 128 * r;
  const initial = pbkdf2Sync(password, salt, 1, p * blockLength, "sha256");
  const mixed = new Uint8Array(initial.byteLength);
  for (let index = 0; index < p; index += 1) {
    const start = index * blockLength;
    mixed.set(scryptRomix(initial.slice(start, start + blockLength), N, r), start);
  }
  return pbkdf2Sync(password, mixed, 1, length, "sha256");
}

export function scrypt(password, salt, keylen, options = undefined, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  callbackify(() => scryptSync(password, salt, keylen, options ?? {}), callback);
}

export function checkPrimeSync(candidate) {
  return isProbablePrime(bigintFromValue(candidate));
}

export function checkPrime(candidate, options = undefined, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
  }
  callbackify(() => checkPrimeSync(candidate), callback);
}

export function generatePrimeSync(size, options = {}) {
  const prime = generatePrimeBigint(size, options);
  return options?.bigint ? prime : bufferFromBytes(bytesFromBigint(prime, Math.ceil(Number(size) / 8)));
}

export function generatePrime(size, options = undefined, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  callbackify(() => generatePrimeSync(size, options ?? {}), callback);
}

export function createDiffieHellman(primeOrLength, keyEncodingOrGenerator = undefined, generator = undefined, generatorEncoding = undefined) {
  return new DiffieHellman(primeOrLength, keyEncodingOrGenerator, generator, generatorEncoding);
}

export function createDiffieHellmanGroup(name) {
  return new DiffieHellmanGroup(name);
}

export const getDiffieHellman = createDiffieHellmanGroup;

export function createECDH(curveName) {
  return new ECDH(curveName);
}

export function diffieHellman(options) {
  const privateKey = keyObjectFromInput(options?.privateKey, "private");
  const publicKey = resolvePublicKeyObject(options?.publicKey);
  if (rawKeyInfo[privateKey.asymmetricKeyType]?.dh && publicKey.asymmetricKeyType === privateKey.asymmetricKeyType) {
    if (typeof cottontail.cryptoRawDiffieHellman !== "function") cryptoFeatureError(`crypto.diffieHellman(${privateKey.asymmetricKeyType})`);
    return bufferFromBytes(new Uint8Array(cottontail.cryptoRawDiffieHellman(privateKey.asymmetricKeyType, privateKey.privateKeyBytes, publicKey.publicKey)));
  }
  if (privateKey.asymmetricKeyType === "ec" && privateKey.privateKeyBytes != null && publicKey.publicKeyBytes != null) {
    if (privateKey.namedCurve !== publicKey.namedCurve) throw new TypeError("EC keys must use the same named curve");
    if (typeof cottontail.cryptoEcDiffieHellman !== "function") cryptoFeatureError(`crypto.diffieHellman(${privateKey.namedCurve})`);
    return bufferFromBytes(new Uint8Array(cottontail.cryptoEcDiffieHellman(privateKey.namedCurve, privateKey.privateKeyBytes, publicKey.publicKeyBytes)));
  }
  if (privateKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyType !== "ec") {
    throw new TypeError("diffieHellman requires matching EC or X25519/X448 KeyObjects");
  }
  const secret = p256Multiply(privateKey.privateKey, publicKey.publicPoint);
  if (secret == null) throw new Error("Failed to compute ECDH secret");
  return bufferFromBytes(bytesFromBigint(secret.x, p256.size));
}

export function createCipheriv(algorithm, key, iv, options = undefined) {
  return new Cipheriv(algorithm, key, iv, options);
}

export function createDecipheriv(algorithm, key, iv, options = undefined) {
  return new Decipheriv(algorithm, key, iv, options);
}

export function createPrivateKey(key) {
  const privateKey = keyObjectFromInput(key, "private");
  if (privateKey.type !== "private") throw new TypeError("createPrivateKey requires private key material");
  return privateKey;
}

export function createPublicKey(key) {
  return resolvePublicKeyObject(key);
}

export function createSign(algorithm) {
  return new Sign(algorithm);
}

export function createVerify(algorithm) {
  return new Verify(algorithm);
}

function encodeGeneratedKey(key, encoding = undefined) {
  if (encoding == null) return key;
  return key.export(encoding);
}

export function generateKeyPairSync(type, options = {}) {
  const normalized = String(type).toLowerCase();
  let privateKey;
  let publicKey;
  if (normalized === "ec") {
    const namedCurve = ecCurveName(options?.namedCurve);
    if (namedCurve === "prime256v1") {
      privateKey = createEcPrivateKey(p256RandomPrivateKey());
      publicKey = createEcPublicKey(privateKey.publicPoint);
    } else {
      if (!supportedNativeEcCurves.includes(namedCurve) || typeof cottontail.cryptoEcGenerateKeyPair !== "function") cryptoFeatureError(`crypto.generateKeyPairSync(${options?.namedCurve})`);
      const pair = cottontail.cryptoEcGenerateKeyPair(namedCurve);
      const nativePrivateKey = new Uint8Array(pair.privateKey);
      const nativePublicKey = new Uint8Array(pair.publicKey);
      privateKey = createNativeEcPrivateKey(namedCurve, nativePrivateKey, nativePublicKey);
      publicKey = createNativeEcPublicKey(namedCurve, nativePublicKey);
    }
  } else if (normalized === "rsa") {
    if (typeof options?.modulusLength !== "number") throw new TypeError("RSA key generation requires options.modulusLength");
    const privateParts = generateRsaKeyPair(options.modulusLength, options?.publicExponent);
    privateKey = createRsaPrivateKey(privateParts);
    publicKey = createRsaPublicKey(privateParts);
  } else if (normalized === "ed25519") {
    if (typeof cottontail.cryptoEd25519GenerateKeyPair !== "function") cryptoFeatureError("crypto.generateKeyPairSync(ed25519)");
    const pair = cottontail.cryptoEd25519GenerateKeyPair();
    const generatedPrivateKey = new Uint8Array(pair.privateKey);
    const generatedPublicKey = new Uint8Array(pair.publicKey);
    privateKey = createEd25519PrivateKey(generatedPrivateKey, generatedPublicKey);
    publicKey = createEd25519PublicKey(generatedPublicKey);
  } else if (rawKeyInfo[normalized]) {
    if (typeof cottontail.cryptoRawKeyGenerateKeyPair !== "function") cryptoFeatureError(`crypto.generateKeyPairSync(${normalized})`);
    const pair = cottontail.cryptoRawKeyGenerateKeyPair(normalized);
    const generatedPrivateKey = new Uint8Array(pair.privateKey);
    const generatedPublicKey = new Uint8Array(pair.publicKey);
    privateKey = createRawPrivateKey(normalized, generatedPrivateKey, generatedPublicKey);
    publicKey = createRawPublicKey(normalized, generatedPublicKey);
  } else {
    cryptoFeatureError("crypto.generateKeyPairSync");
  }
  return {
    publicKey: encodeGeneratedKey(publicKey, options?.publicKeyEncoding),
    privateKey: encodeGeneratedKey(privateKey, options?.privateKeyEncoding),
  };
}

export function generateKeyPair(type, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  queueMicrotask(() => {
    try {
      const pair = generateKeyPairSync(type, options ?? {});
      callback(null, pair.publicKey, pair.privateKey);
    } catch (error) {
      callback(error);
    }
  });
}

export function generateKeySync(type, options = {}) {
  const normalized = String(type).toLowerCase();
  const length = positiveInteger(options?.length, "key length");
  if (normalized === "hmac") {
    return createSecretKey(randomBytes(Math.ceil(length / 8)));
  }
  if (normalized === "aes") {
    if (length !== 128 && length !== 192 && length !== 256) {
      throw new RangeError("AES key length must be 128, 192, or 256 bits");
    }
    return createSecretKey(randomBytes(length / 8));
  }
  throw new TypeError(`Invalid secret key type: ${type}`);
}

export function generateKey(type, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  callbackify(() => generateKeySync(type, options ?? {}), callback);
}

export function getCiphers() {
  const native = typeof cottontail.cryptoGetCiphers === "function"
    ? Array.from(cottontail.cryptoGetCiphers(), (name) => String(name).toLowerCase())
    : [];
  return Array.from(new Set([...supportedCiphers.map((cipher) => cipher.name), ...native])).sort();
}

export function getCipherInfo(nameOrNid) {
  if (typeof nameOrNid === "number") return undefined;
  const info = cipherInfoForName(nameOrNid);
  if (!info) return undefined;
  const result = {
    mode: info.mode,
    name: info.name,
    blockSize: info.blockSize,
    keyLength: info.keyLength,
  };
  if (info.ivLength > 0) result.ivLength = info.ivLength;
  return result;
}

export function getCurves() {
  return ["prime256v1", ...supportedNativeEcCurves];
}

export function privateDecrypt(privateKey, buffer) {
  const options = rsaOperationOptions(privateKey, constantsObject.RSA_PKCS1_OAEP_PADDING);
  const key = keyObjectFromInput(options.key, "private");
  if (key.asymmetricKeyType !== "rsa") throw new TypeError("privateDecrypt requires an RSA private KeyObject");
  const decrypted = rsaPrivateApply(key, bytesFromData(buffer));
  if (options.padding === constantsObject.RSA_NO_PADDING) return decrypted;
  if (options.padding === constantsObject.RSA_PKCS1_PADDING) return rsaPkcs1DecryptBlock(decrypted, 2);
  if (options.padding === constantsObject.RSA_PKCS1_OAEP_PADDING) return rsaOaepDecode(decrypted, options.oaepHash, options.oaepLabel);
  throw new TypeError("Invalid RSA privateDecrypt padding");
}

export function privateEncrypt(privateKey, buffer) {
  const options = rsaOperationOptions(privateKey, constantsObject.RSA_PKCS1_PADDING);
  const key = keyObjectFromInput(options.key, "private");
  if (key.asymmetricKeyType !== "rsa") throw new TypeError("privateEncrypt requires an RSA private KeyObject");
  const input = bytesFromData(buffer);
  if (options.padding === constantsObject.RSA_NO_PADDING) {
    if (input.byteLength !== rsaModulusLength(key)) throw new RangeError("RSA_NO_PADDING input must match modulus length");
    return rsaPrivateApply(key, input);
  }
  if (options.padding === constantsObject.RSA_PKCS1_PADDING) return rsaPrivateApply(key, rsaPrivateEncryptBlock(input, rsaModulusLength(key)));
  throw new TypeError("Invalid RSA privateEncrypt padding");
}

export function publicDecrypt(publicKey, buffer) {
  const options = rsaOperationOptions(publicKey, constantsObject.RSA_PKCS1_PADDING);
  const key = resolvePublicKeyObject(options.key);
  if (key.asymmetricKeyType !== "rsa") throw new TypeError("publicDecrypt requires an RSA public KeyObject");
  const decrypted = rsaPublicApply(key, bytesFromData(buffer));
  if (options.padding === constantsObject.RSA_NO_PADDING) return decrypted;
  if (options.padding === constantsObject.RSA_PKCS1_PADDING) return rsaPkcs1DecryptBlock(decrypted, 1);
  throw new TypeError("Invalid RSA publicDecrypt padding");
}

export function publicEncrypt(publicKey, buffer) {
  const options = rsaOperationOptions(publicKey, constantsObject.RSA_PKCS1_OAEP_PADDING);
  const key = resolvePublicKeyObject(options.key);
  if (key.asymmetricKeyType !== "rsa") throw new TypeError("publicEncrypt requires an RSA public KeyObject");
  const input = bytesFromData(buffer);
  if (options.padding === constantsObject.RSA_NO_PADDING) {
    if (input.byteLength !== rsaModulusLength(key)) throw new RangeError("RSA_NO_PADDING input must match modulus length");
    return rsaPublicApply(key, input);
  }
  if (options.padding === constantsObject.RSA_PKCS1_PADDING) return rsaPublicApply(key, rsaPkcs1EncryptBlock(input, rsaModulusLength(key)));
  if (options.padding === constantsObject.RSA_PKCS1_OAEP_PADDING) return rsaPublicApply(key, rsaOaepEncode(input, rsaModulusLength(key), options.oaepHash, options.oaepLabel));
  throw new TypeError("Invalid RSA publicEncrypt padding");
}

export function sign(algorithm, data, key) {
  const dsaEncoding = normalizeDsaEncoding(key);
  const options = key && typeof key === "object" && key.key != null ? key : undefined;
  const privateKey = keyObjectFromInput(keyInputFromSignOptions(key), "private");
  const input = bytesFromData(data);
  if (privateKey.asymmetricKeyType === "ed25519") return ed25519SignData(algorithm, input, privateKey);
  if (rawKeyInfo[privateKey.asymmetricKeyType]?.sign) return rawSignData(algorithm, input, privateKey);
  if (privateKey.asymmetricKeyType === "rsa") {
    const nativeSignature = rsaNativeSignData(algorithm ?? "sha256", input, privateKey, options);
    if (nativeSignature !== undefined) return nativeSignature;
  }
  const digest = digestBytes(algorithm ?? "sha256", bytesFromData(data));
  return privateKey.asymmetricKeyType === "rsa"
    ? rsaSignDigest(algorithm ?? "sha256", digest, privateKey, options)
    : ecdsaSignDigest(digest, privateKey, dsaEncoding);
}

export function verify(algorithm, data, key, signature) {
  const dsaEncoding = normalizeDsaEncoding(key);
  const options = key && typeof key === "object" && key.key != null ? key : undefined;
  const publicKey = keyObjectFromInput(keyInputFromSignOptions(key), "public");
  const input = bytesFromData(data);
  const signatureBytes = bytesFromData(signature);
  if (resolvePublicKeyObject(publicKey).asymmetricKeyType === "ed25519") return ed25519VerifyData(algorithm, input, publicKey, signatureBytes);
  if (rawKeyInfo[resolvePublicKeyObject(publicKey).asymmetricKeyType]?.sign) return rawVerifyData(algorithm, input, publicKey, signatureBytes);
  if (resolvePublicKeyObject(publicKey).asymmetricKeyType === "rsa") {
    const nativeResult = rsaNativeVerifyData(algorithm ?? "sha256", input, publicKey, signatureBytes, options);
    if (nativeResult !== undefined) return nativeResult;
  }
  const digest = digestBytes(algorithm ?? "sha256", bytesFromData(data));
  return publicKey.asymmetricKeyType === "rsa"
    ? rsaVerifyDigest(algorithm ?? "sha256", digest, publicKey, signature, options)
    : ecdsaVerifyDigest(digest, publicKey, signature, dsaEncoding);
}

export function encapsulate(key, callback = undefined) {
  if (callback !== undefined && typeof callback !== "function") throw new TypeError("callback must be a function");
  if (typeof callback === "function") {
    queueMicrotask(() => {
      try {
        callback(null, encapsulateSync(key));
      } catch (error) {
        callback(error);
      }
    });
    return;
  }
  return encapsulateSync(key);
}

export function decapsulate(key, ciphertext, callback = undefined) {
  if (callback !== undefined && typeof callback !== "function") throw new TypeError("callback must be a function");
  if (typeof callback === "function") {
    queueMicrotask(() => {
      try {
        callback(null, decapsulateSync(key, ciphertext));
      } catch (error) {
        callback(error);
      }
    });
    return;
  }
  return decapsulateSync(key, ciphertext);
}

export function argon2Sync(algorithm, parameters) {
  const normalized = argon2AlgorithmName(algorithm);
  const parsed = argon2Parameters(parameters);
  if (typeof cottontail.cryptoArgon2Sync !== "function") cryptoFeatureError("crypto.argon2Sync");
  return bufferFromBytes(cottontail.cryptoArgon2Sync(
    normalized,
    parsed.message,
    parsed.nonce,
    parsed.parallelism,
    parsed.tagLength,
    parsed.memory,
    parsed.passes,
    parsed.secret,
    parsed.associatedData,
  ));
}

export function argon2(algorithm, parameters, callback) {
  callbackify(() => argon2Sync(algorithm, parameters), callback);
}

export function setEngine(id) {
  if (id === "dynamic") return;
  const error = new Error(`Engine "${String(id)}" was not found`);
  error.code = "ERR_CRYPTO_ENGINE_UNKNOWN";
  throw error;
}

export function secureHeapUsed() {
  return { total: 0, used: 0, utilization: 0, min: 0 };
}

export function randomBytes(size) {
  const length = Number(size) || 0;
  if (length < 0 || !Number.isFinite(length)) {
    throw new RangeError("randomBytes size must be a non-negative finite number");
  }
  if (typeof cottontail.randomBytes !== "function") {
    throw new Error("native randomBytes is unavailable");
  }
  return bufferFromBytes(cottontail.randomBytes(length));
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

function arrayBufferFromBytes(bytes) {
  const view = bytesFromData(bytes);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

const webcryptoHashNames = {
  "SHA-1": "sha1",
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
};

const webcryptoNamedCurves = {
  "P-256": "prime256v1",
  "P-384": "secp384r1",
  "P-521": "secp521r1",
};

const webcryptoEcCurveNames = Object.fromEntries(Object.entries(webcryptoNamedCurves).map(([web, node]) => [node, web]));
const webcryptoRsaAlgorithms = ["RSA-PSS", "RSASSA-PKCS1-v1_5", "RSA-OAEP"];
const webcryptoOkpAlgorithms = ["Ed25519", "Ed448", "X25519", "X448"];

function webcryptoAlgorithmName(algorithm) {
  return String(typeof algorithm === "string" ? algorithm : algorithm?.name ?? "").toUpperCase();
}

function webcryptoHashName(hash) {
  const name = typeof hash === "string" ? hash : hash?.name;
  const canonical = String(name ?? "").toUpperCase();
  const normalized = webcryptoHashNames[canonical];
  if (!normalized) throw new TypeError(`Invalid WebCrypto hash: ${name}`);
  return normalized;
}

function webcryptoHashAlgorithm(hash) {
  const normalized = webcryptoHashName(hash);
  return Object.keys(webcryptoHashNames).find((name) => webcryptoHashNames[name] === normalized);
}

function webcryptoEcNodeCurve(namedCurve) {
  const curve = String(namedCurve ?? "");
  const normalized = webcryptoNamedCurves[curve];
  if (!normalized) throw new TypeError(`Invalid WebCrypto namedCurve: ${namedCurve}`);
  return normalized;
}

function webcryptoEcNamedCurveFromKey(keyObject) {
  const curve = keyObject.asymmetricKeyDetails?.namedCurve ?? keyObject.namedCurve;
  return webcryptoEcCurveNames[curve] ?? (curve === "prime256v1" ? "P-256" : curve);
}

function webcryptoUsageList(usages = []) {
  return Array.from(usages ?? [], (usage) => String(usage));
}

export class CryptoKey {
  constructor(type, algorithm, extractable, usages, material) {
    this.type = type;
    this.extractable = Boolean(extractable);
    this.algorithm = algorithm;
    this.usages = webcryptoUsageList(usages);
    this.material = material;
  }

  get [Symbol.toStringTag]() {
    return "CryptoKey";
  }
}

function assertCryptoKey(key, usage = undefined) {
  if (!(key instanceof CryptoKey)) throw new TypeError("Expected a CryptoKey");
  if (usage != null && !key.usages.includes(usage)) throw new Error(`CryptoKey does not support ${usage}`);
  return key;
}

function webcryptoSecretKey(algorithm, bytes, extractable, usages) {
  return new CryptoKey("secret", algorithm, extractable, usages, bytesFromData(bytes));
}

function webcryptoKeyObject(type, algorithm, extractable, usages, keyObject) {
  return new CryptoKey(type, algorithm, extractable, usages, keyObject);
}

function webcryptoKeyObjectUsages(algorithmName, type, usages) {
  const requested = webcryptoUsageList(usages);
  if (requested.length > 0) return requested;
  if (algorithmName === "ECDH" || algorithmName === "X25519" || algorithmName === "X448") {
    return type === "private" ? ["deriveBits", "deriveKey"] : [];
  }
  if (algorithmName === "RSA-OAEP") return type === "private" ? ["decrypt", "unwrapKey"] : ["encrypt", "wrapKey"];
  if (type === "private") return ["sign"];
  if (type === "public") return ["verify"];
  return requested;
}

function webcryptoKeyFromKeyObject(keyObject, algorithm, extractable, usages) {
  const type = keyObject.type === "secret" ? "secret" : keyObject.type;
  return webcryptoKeyObject(type, algorithm, extractable, webcryptoKeyObjectUsages(algorithm.name, type, usages), keyObject);
}

function webcryptoAlgorithmForKeyObject(algorithmName, keyObject, hash = undefined) {
  if (keyObject.asymmetricKeyType === "rsa") {
    return {
      name: algorithmName,
      modulusLength: keyObject.asymmetricKeyDetails?.modulusLength,
      publicExponent: bytesFromBigint(keyObject.asymmetricKeyDetails?.publicExponent ?? 65537n),
      hash: { name: webcryptoHashAlgorithm(hash ?? "SHA-256") },
    };
  }
  if (keyObject.asymmetricKeyType === "ec") {
    return { name: algorithmName, namedCurve: webcryptoEcNamedCurveFromKey(keyObject) };
  }
  if (keyObject.asymmetricKeyType === "ed25519") return { name: "Ed25519" };
  if (rawKeyInfo[keyObject.asymmetricKeyType]) return { name: rawKeyInfo[keyObject.asymmetricKeyType].crv };
  return { name: algorithmName };
}

function webcryptoPublicExponent(value = new Uint8Array([1, 0, 1])) {
  const bytes = bytesFromData(value);
  if (bytes.byteLength === 0) return 65537;
  let exponent = 0;
  for (const byte of bytes) exponent = exponent * 256 + byte;
  return exponent;
}

function webcryptoAesName(algorithm) {
  const name = webcryptoAlgorithmName(algorithm);
  if (name === "AES-GCM") return "AES-GCM";
  if (name === "AES-CBC") return "AES-CBC";
  if (name === "AES-CTR") return "AES-CTR";
  if (name === "AES-KW") return "AES-KW";
  return undefined;
}

function webcryptoAesCipherName(name, keyBytes) {
  const bits = keyBytes.byteLength * 8;
  if (name === "AES-GCM") return `aes-${bits}-gcm`;
  if (name === "AES-CBC") return `aes-${bits}-cbc`;
  if (name === "AES-CTR") return `aes-${bits}-ctr`;
  if (name === "AES-KW") return `aes-${bits}-ecb`;
  throw new TypeError(`Invalid AES operation: ${name}`);
}

function webcryptoNormalizeKeyAlgorithm(algorithm) {
  const name = webcryptoAlgorithmName(algorithm);
  if (webcryptoAesName(algorithm)) return { name: webcryptoAesName(algorithm), length: Number(algorithm.length) || undefined };
  if (name === "HMAC") return { name: "HMAC", hash: { name: webcryptoHashAlgorithm(algorithm.hash ?? "SHA-256") } };
  if (name === "PBKDF2") return { name: "PBKDF2" };
  if (name === "HKDF") return { name: "HKDF" };
  if (name === "ECDSA" || name === "ECDH") return { name, namedCurve: String(algorithm.namedCurve) };
  if (webcryptoRsaAlgorithms.includes(name)) return { name, hash: { name: webcryptoHashAlgorithm(algorithm.hash ?? "SHA-256") } };
  if (webcryptoOkpAlgorithms.includes(String(typeof algorithm === "string" ? algorithm : algorithm?.name))) return { name: String(typeof algorithm === "string" ? algorithm : algorithm.name) };
  throw new TypeError(`Invalid WebCrypto algorithm: ${name}`);
}

function webcryptoEcdsaSize(namedCurve) {
  if (namedCurve === "P-384") return 48;
  if (namedCurve === "P-521") return 66;
  return 32;
}

function derEncodeEcdsaRaw(rawSignature) {
  const bytes = bytesFromData(rawSignature);
  const size = Math.floor(bytes.byteLength / 2);
  if (size <= 0 || bytes.byteLength !== size * 2) throw new TypeError("Invalid ECDSA signature length");
  return derEncodeEcdsa(bigintFromBytes(bytes.slice(0, size)), bigintFromBytes(bytes.slice(size)));
}

function derDecodeEcdsaRaw(signature, size) {
  const decoded = ecdsaSignatureFromBytes(signature, "der");
  return bufferFromBytes(new Uint8Array([
    ...bytesFromBigint(decoded.r, size),
    ...bytesFromBigint(decoded.s, size),
  ]));
}

function webcryptoRawEcPublicJwk(namedCurve, raw) {
  const bytes = bytesFromData(raw);
  if (bytes[0] !== 4) throw new TypeError("EC raw public keys must be uncompressed");
  const size = webcryptoEcdsaSize(namedCurve);
  return {
    kty: "EC",
    crv: namedCurve,
    x: base64UrlFromBytes(bytes.slice(1, 1 + size)),
    y: base64UrlFromBytes(bytes.slice(1 + size, 1 + size * 2)),
  };
}

function webcryptoKeyToNodeKey(key, usage = undefined) {
  const cryptoKey = assertCryptoKey(key, usage);
  if (!(cryptoKey.material instanceof KeyObject)) throw new TypeError("CryptoKey does not contain asymmetric key material");
  return cryptoKey.material;
}

function webcryptoSecretBytes(key, usage = undefined) {
  const cryptoKey = assertCryptoKey(key, usage);
  if (cryptoKey.type !== "secret") throw new TypeError("Expected a secret CryptoKey");
  return cryptoKey.material;
}

function aesKwBlock(keyBytes, block, encrypt) {
  const cipher = encrypt
    ? createCipheriv(webcryptoAesCipherName("AES-KW", keyBytes), keyBytes, null)
    : createDecipheriv(webcryptoAesCipherName("AES-KW", keyBytes), keyBytes, null);
  cipher.setAutoPadding(false);
  return bytesFromData(concatBytes([bytesFromData(cipher.update(block)), bytesFromData(cipher.final())]));
}

function aesKwXorT(a, t) {
  const out = new Uint8Array(a);
  for (let index = 7; index >= 0 && t > 0; index -= 1) {
    out[index] ^= t & 0xff;
    t = Math.floor(t / 256);
  }
  return out;
}

function webcryptoAesKwWrap(key, data, usage = "encrypt") {
  const keyBytes = webcryptoSecretBytes(key, usage);
  const input = bytesFromData(data);
  if (input.byteLength < 16 || input.byteLength % 8 !== 0) throw new TypeError("AES-KW data must be at least 16 bytes and a multiple of 64 bits");
  const n = input.byteLength / 8;
  let a = new Uint8Array(8).fill(0xa6);
  const r = [];
  for (let index = 0; index < n; index += 1) r.push(input.slice(index * 8, index * 8 + 8));
  for (let j = 0; j < 6; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const b = aesKwBlock(keyBytes, concatBytes([a, r[i]]), true);
      a = aesKwXorT(b.slice(0, 8), n * j + i + 1);
      r[i] = b.slice(8, 16);
    }
  }
  return arrayBufferFromBytes(concatBytes([a, ...r]));
}

function webcryptoAesKwUnwrap(key, data, usage = "decrypt") {
  const keyBytes = webcryptoSecretBytes(key, usage);
  const input = bytesFromData(data);
  if (input.byteLength < 24 || input.byteLength % 8 !== 0) throw new TypeError("AES-KW wrapped data must be at least 24 bytes and a multiple of 64 bits");
  const n = input.byteLength / 8 - 1;
  let a = input.slice(0, 8);
  const r = [];
  for (let index = 0; index < n; index += 1) r.push(input.slice((index + 1) * 8, (index + 2) * 8));
  for (let j = 5; j >= 0; j -= 1) {
    for (let i = n - 1; i >= 0; i -= 1) {
      const b = aesKwBlock(keyBytes, concatBytes([aesKwXorT(a, n * j + i + 1), r[i]]), false);
      a = b.slice(0, 8);
      r[i] = b.slice(8, 16);
    }
  }
  if (!a.every((byte) => byte === 0xa6)) throw new Error("AES-KW integrity check failed");
  return arrayBufferFromBytes(concatBytes(r));
}

function webcryptoAesEncrypt(algorithm, key, data) {
  const keyBytes = webcryptoSecretBytes(key, "encrypt");
  if (key.algorithm.name === "AES-KW") return webcryptoAesKwWrap(key, data);
  const cipherName = webcryptoAesCipherName(key.algorithm.name, keyBytes);
  const iv = bytesFromData(algorithm.iv ?? algorithm.counter);
  const cipher = createCipheriv(cipherName, keyBytes, iv, { authTagLength: Math.ceil((algorithm.tagLength ?? 128) / 8) });
  if (algorithm.additionalData != null && typeof cipher.setAAD === "function") cipher.setAAD(bytesFromData(algorithm.additionalData));
  const encrypted = concatBytes([bytesFromData(cipher.update(data)), bytesFromData(cipher.final())]);
  if (key.algorithm.name !== "AES-GCM") return arrayBufferFromBytes(encrypted);
  return arrayBufferFromBytes(concatBytes([encrypted, bytesFromData(cipher.getAuthTag())]));
}

function webcryptoAesDecrypt(algorithm, key, data) {
  const keyBytes = webcryptoSecretBytes(key, "decrypt");
  if (key.algorithm.name === "AES-KW") return webcryptoAesKwUnwrap(key, data);
  const cipherName = webcryptoAesCipherName(key.algorithm.name, keyBytes);
  const iv = bytesFromData(algorithm.iv ?? algorithm.counter);
  let input = bytesFromData(data);
  const decipher = createDecipheriv(cipherName, keyBytes, iv, { authTagLength: Math.ceil((algorithm.tagLength ?? 128) / 8) });
  if (algorithm.additionalData != null && typeof decipher.setAAD === "function") decipher.setAAD(bytesFromData(algorithm.additionalData));
  if (key.algorithm.name === "AES-GCM") {
    const tagLength = Math.ceil((algorithm.tagLength ?? 128) / 8);
    decipher.setAuthTag(input.slice(input.byteLength - tagLength));
    input = input.slice(0, input.byteLength - tagLength);
  }
  return arrayBufferFromBytes(concatBytes([bytesFromData(decipher.update(input)), bytesFromData(decipher.final())]));
}

function webcryptoExportJwkSecret(key) {
  const bytes = webcryptoSecretBytes(key);
  const jwk = {
    kty: "oct",
    k: base64UrlFromBytes(bytes),
    ext: key.extractable,
    key_ops: key.usages.slice(),
  };
  if (key.algorithm.name.startsWith("AES-")) jwk.alg = `A${bytes.byteLength * 8}${key.algorithm.name.slice(4)}`;
  if (key.algorithm.name === "HMAC") jwk.alg = `HS${hashOutputLengths[webcryptoHashName(key.algorithm.hash)] * 8}`;
  return jwk;
}

function webcryptoDecorateJwk(jwk, key) {
  return {
    ...jwk,
    ext: key.extractable,
    key_ops: key.usages.slice(),
  };
}

const subtleCrypto = {
  async digest(algorithm, data) {
    const name = typeof algorithm === "string" ? algorithm : algorithm?.name;
    const bytes = digestBytes(name, bytesFromData(data), hashOutputLengths[normalizeAlgorithm(name)]);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },

  async generateKey(algorithm, extractable, keyUsages) {
    const name = webcryptoAlgorithmName(algorithm);
    if (webcryptoAesName(algorithm)) {
      const length = positiveInteger(algorithm.length, "length");
      if (length !== 128 && length !== 192 && length !== 256) throw new RangeError("AES key length must be 128, 192, or 256 bits");
      return webcryptoSecretKey({ name: webcryptoAesName(algorithm), length }, randomBytes(length / 8), extractable, keyUsages);
    }
    if (name === "HMAC") {
      const hash = webcryptoHashAlgorithm(algorithm.hash ?? "SHA-256");
      const length = positiveInteger(algorithm.length ?? ((hash === "SHA-384" || hash === "SHA-512") ? 1024 : 512), "length");
      return webcryptoSecretKey({ name: "HMAC", length, hash: { name: hash } }, randomBytes(Math.ceil(length / 8)), extractable, keyUsages);
    }
    if (name === "ECDSA" || name === "ECDH") {
      const namedCurve = String(algorithm.namedCurve);
      const pair = generateKeyPairSync("ec", { namedCurve: webcryptoEcNodeCurve(namedCurve) });
      return {
        publicKey: webcryptoKeyFromKeyObject(pair.publicKey, { name, namedCurve }, true, name === "ECDH" ? [] : ["verify"]),
        privateKey: webcryptoKeyFromKeyObject(pair.privateKey, { name, namedCurve }, extractable, keyUsages?.length ? keyUsages : (name === "ECDH" ? ["deriveBits", "deriveKey"] : ["sign"])),
      };
    }
    if (webcryptoRsaAlgorithms.includes(name)) {
      const hash = webcryptoHashAlgorithm(algorithm.hash ?? "SHA-256");
      const modulusLength = positiveInteger(algorithm.modulusLength, "modulusLength");
      const publicExponent = bytesFromBigint(BigInt(webcryptoPublicExponent(algorithm.publicExponent)));
      const pair = generateKeyPairSync("rsa", { modulusLength, publicExponent: webcryptoPublicExponent(algorithm.publicExponent) });
      const keyAlgorithm = { name, modulusLength, publicExponent, hash: { name: hash } };
      const publicUsages = name === "RSA-OAEP" ? ["encrypt", "wrapKey"] : ["verify"];
      const privateUsages = name === "RSA-OAEP" ? ["decrypt", "unwrapKey"] : ["sign"];
      return {
        publicKey: webcryptoKeyFromKeyObject(pair.publicKey, keyAlgorithm, true, publicUsages.filter((usage) => (keyUsages ?? publicUsages).includes(usage))),
        privateKey: webcryptoKeyFromKeyObject(pair.privateKey, keyAlgorithm, extractable, privateUsages.filter((usage) => (keyUsages ?? privateUsages).includes(usage))),
      };
    }
    if (webcryptoOkpAlgorithms.includes(String(typeof algorithm === "string" ? algorithm : algorithm.name))) {
      const type = String(typeof algorithm === "string" ? algorithm : algorithm.name).toLowerCase();
      const pair = generateKeyPairSync(type);
      const keyAlgorithm = { name: rawKeyInfo[type]?.crv ?? "Ed25519" };
      const publicUsages = rawKeyInfo[type]?.dh ? [] : ["verify"];
      const privateUsages = rawKeyInfo[type]?.dh ? ["deriveBits", "deriveKey"] : ["sign"];
      return {
        publicKey: webcryptoKeyFromKeyObject(pair.publicKey, keyAlgorithm, true, publicUsages),
        privateKey: webcryptoKeyFromKeyObject(pair.privateKey, keyAlgorithm, extractable, keyUsages?.length ? keyUsages : privateUsages),
      };
    }
    throw new TypeError(`Invalid WebCrypto generateKey algorithm: ${name}`);
  },

  async importKey(format, keyData, algorithm, extractable, keyUsages) {
    const normalizedFormat = String(format).toLowerCase();
    const normalizedAlgorithm = webcryptoNormalizeKeyAlgorithm(algorithm);
    if (normalizedFormat === "raw") {
      if (normalizedAlgorithm.name.startsWith("AES-")) {
        const bytes = bytesFromData(keyData);
        return webcryptoSecretKey({ name: normalizedAlgorithm.name, length: bytes.byteLength * 8 }, bytes, extractable, keyUsages);
      }
      if (normalizedAlgorithm.name === "HMAC" || normalizedAlgorithm.name === "PBKDF2" || normalizedAlgorithm.name === "HKDF") {
        const bytes = bytesFromData(keyData);
        const algorithmDetails = normalizedAlgorithm.name === "HMAC"
          ? { ...normalizedAlgorithm, length: bytes.byteLength * 8 }
          : normalizedAlgorithm;
        return webcryptoSecretKey(algorithmDetails, bytes, extractable, keyUsages);
      }
      if (normalizedAlgorithm.name === "ECDSA" || normalizedAlgorithm.name === "ECDH") {
        const namedCurve = String(algorithm.namedCurve);
        const nodeCurve = webcryptoEcNodeCurve(namedCurve);
        const publicKey = nodeCurve === "prime256v1" ? createEcPublicKey(p256DecodePoint(keyData)) : createNativeEcPublicKey(nodeCurve, bytesFromData(keyData));
        return webcryptoKeyFromKeyObject(publicKey, { name: normalizedAlgorithm.name, namedCurve }, extractable, keyUsages);
      }
      if (normalizedAlgorithm.name === "Ed25519") {
        return webcryptoKeyFromKeyObject(createEd25519PublicKey(bytesFromData(keyData)), normalizedAlgorithm, extractable, keyUsages);
      }
      if (normalizedAlgorithm.name === "Ed448") {
        return webcryptoKeyFromKeyObject(createRawPublicKey("ed448", bytesFromData(keyData)), normalizedAlgorithm, extractable, keyUsages);
      }
      if (normalizedAlgorithm.name === "X25519" || normalizedAlgorithm.name === "X448") {
        return webcryptoKeyFromKeyObject(createRawPublicKey(normalizedAlgorithm.name.toLowerCase(), bytesFromData(keyData)), normalizedAlgorithm, extractable, keyUsages);
      }
    }
    if (normalizedFormat === "jwk") {
      if (keyData?.kty === "oct") {
        return webcryptoSecretKey(normalizedAlgorithm, bytesFromBase64Url(keyData.k), keyData.ext ?? extractable, keyData.key_ops ?? keyUsages);
      }
      const keyObject = keyObjectFromJwk(keyData, keyData?.d == null ? "public" : undefined);
      return webcryptoKeyFromKeyObject(keyObject, webcryptoAlgorithmForKeyObject(normalizedAlgorithm.name, keyObject, normalizedAlgorithm.hash), extractable, keyUsages);
    }
    if (normalizedFormat === "spki" || normalizedFormat === "pkcs8") {
      const keyObject = normalizedFormat === "spki"
        ? createPublicKey({ key: keyData, format: "der", type: "spki" })
        : createPrivateKey({ key: keyData, format: "der", type: "pkcs8" });
      return webcryptoKeyFromKeyObject(keyObject, webcryptoAlgorithmForKeyObject(normalizedAlgorithm.name, keyObject, normalizedAlgorithm.hash), extractable, keyUsages);
    }
    throw new TypeError(`Invalid WebCrypto importKey format: ${format}`);
  },

  async exportKey(format, key) {
    const cryptoKey = assertCryptoKey(key);
    if (!cryptoKey.extractable) throw new Error("CryptoKey is not extractable");
    const normalizedFormat = String(format).toLowerCase();
    if (normalizedFormat === "raw") {
      if (cryptoKey.type === "secret") return arrayBufferFromBytes(cryptoKey.material);
      const keyObject = webcryptoKeyToNodeKey(cryptoKey);
      if (keyObject.asymmetricKeyType === "ec") {
        const publicKey = resolvePublicKeyObject(keyObject);
        return arrayBufferFromBytes(publicKey.publicKeyBytes ?? p256EncodePoint(publicKey.publicPoint));
      }
      if (rawKeyInfo[keyObject.asymmetricKeyType] || keyObject.asymmetricKeyType === "ed25519") {
        return arrayBufferFromBytes(resolvePublicKeyObject(keyObject).publicKey);
      }
    }
    if (normalizedFormat === "jwk") {
      if (cryptoKey.type === "secret") return webcryptoExportJwkSecret(cryptoKey);
      return webcryptoDecorateJwk(webcryptoKeyToNodeKey(cryptoKey).export({ format: "jwk" }), cryptoKey);
    }
    if (normalizedFormat === "spki") {
      return arrayBufferFromBytes(resolvePublicKeyObject(webcryptoKeyToNodeKey(cryptoKey)).export({ format: "der", type: "spki" }));
    }
    if (normalizedFormat === "pkcs8") {
      return arrayBufferFromBytes(webcryptoKeyToNodeKey(cryptoKey).export({ format: "der", type: "pkcs8" }));
    }
    throw new TypeError(`Invalid WebCrypto exportKey format: ${format}`);
  },

  async sign(algorithm, key, data) {
    const cryptoKey = assertCryptoKey(key, "sign");
    const name = webcryptoAlgorithmName(algorithm) || cryptoKey.algorithm.name;
    if (cryptoKey.type === "secret" && cryptoKey.algorithm.name === "HMAC") {
      return arrayBufferFromBytes(hmacBytes(webcryptoHashName(cryptoKey.algorithm.hash), cryptoKey.material, bytesFromData(data)));
    }
    const keyObject = webcryptoKeyToNodeKey(cryptoKey);
    if (name === "ECDSA") {
      const hash = webcryptoHashName(algorithm.hash ?? cryptoKey.algorithm.hash ?? "SHA-256");
      const der = sign(hash, data, keyObject);
      return arrayBufferFromBytes(derDecodeEcdsaRaw(der, webcryptoEcdsaSize(cryptoKey.algorithm.namedCurve)));
    }
    if (name === "RSA-PSS") {
      return arrayBufferFromBytes(sign(webcryptoHashName(cryptoKey.algorithm.hash), data, {
        key: keyObject,
        padding: constantsObject.RSA_PKCS1_PSS_PADDING,
        saltLength: positiveInteger(algorithm.saltLength, "saltLength", true),
      }));
    }
    if (name === "RSASSA-PKCS1-V1_5" || name === "RSASSA-PKCS1-v1_5") {
      return arrayBufferFromBytes(sign(webcryptoHashName(cryptoKey.algorithm.hash), data, keyObject));
    }
    if (name === "ED25519" || name === "ED448" || cryptoKey.algorithm.name === "Ed25519" || cryptoKey.algorithm.name === "Ed448") {
      return arrayBufferFromBytes(sign(null, data, keyObject));
    }
    throw new TypeError(`Invalid WebCrypto sign algorithm: ${name}`);
  },

  async verify(algorithm, key, signature, data) {
    const cryptoKey = assertCryptoKey(key, "verify");
    const name = webcryptoAlgorithmName(algorithm) || cryptoKey.algorithm.name;
    if (cryptoKey.type === "secret" && cryptoKey.algorithm.name === "HMAC") {
      const expected = hmacBytes(webcryptoHashName(cryptoKey.algorithm.hash), cryptoKey.material, bytesFromData(data));
      const actual = bytesFromData(signature);
      return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
    }
    const keyObject = webcryptoKeyToNodeKey(cryptoKey);
    if (name === "ECDSA") {
      const hash = webcryptoHashName(algorithm.hash ?? cryptoKey.algorithm.hash ?? "SHA-256");
      return verify(hash, data, keyObject, derEncodeEcdsaRaw(signature));
    }
    if (name === "RSA-PSS") {
      return verify(webcryptoHashName(cryptoKey.algorithm.hash), data, {
        key: keyObject,
        padding: constantsObject.RSA_PKCS1_PSS_PADDING,
        saltLength: positiveInteger(algorithm.saltLength, "saltLength", true),
      }, signature);
    }
    if (name === "RSASSA-PKCS1-V1_5" || name === "RSASSA-PKCS1-v1_5") {
      return verify(webcryptoHashName(cryptoKey.algorithm.hash), data, keyObject, signature);
    }
    if (name === "ED25519" || name === "ED448" || cryptoKey.algorithm.name === "Ed25519" || cryptoKey.algorithm.name === "Ed448") {
      return verify(null, data, keyObject, signature);
    }
    throw new TypeError(`Invalid WebCrypto verify algorithm: ${name}`);
  },

  async encrypt(algorithm, key, data) {
    const cryptoKey = assertCryptoKey(key, "encrypt");
    const name = webcryptoAlgorithmName(algorithm) || cryptoKey.algorithm.name;
    if (name.startsWith("AES-")) return webcryptoAesEncrypt(algorithm, cryptoKey, data);
    if (name === "RSA-OAEP") {
      return arrayBufferFromBytes(publicEncrypt({
        key: webcryptoKeyToNodeKey(cryptoKey),
        padding: constantsObject.RSA_PKCS1_OAEP_PADDING,
        oaepHash: webcryptoHashName(cryptoKey.algorithm.hash),
        oaepLabel: algorithm.label,
      }, data));
    }
    throw new TypeError(`Invalid WebCrypto encrypt algorithm: ${name}`);
  },

  async decrypt(algorithm, key, data) {
    const cryptoKey = assertCryptoKey(key, "decrypt");
    const name = webcryptoAlgorithmName(algorithm) || cryptoKey.algorithm.name;
    if (name.startsWith("AES-")) return webcryptoAesDecrypt(algorithm, cryptoKey, data);
    if (name === "RSA-OAEP") {
      return arrayBufferFromBytes(privateDecrypt({
        key: webcryptoKeyToNodeKey(cryptoKey),
        padding: constantsObject.RSA_PKCS1_OAEP_PADDING,
        oaepHash: webcryptoHashName(cryptoKey.algorithm.hash),
        oaepLabel: algorithm.label,
      }, data));
    }
    throw new TypeError(`Invalid WebCrypto decrypt algorithm: ${name}`);
  },

  async deriveBits(algorithm, baseKey, length) {
    const cryptoKey = assertCryptoKey(baseKey, "deriveBits");
    const name = webcryptoAlgorithmName(algorithm) || cryptoKey.algorithm.name;
    const byteLength = length == null ? undefined : Math.ceil(Number(length) / 8);
    if (name === "PBKDF2") {
      return arrayBufferFromBytes(pbkdf2Sync(cryptoKey.material, algorithm.salt, positiveInteger(algorithm.iterations, "iterations"), byteLength, webcryptoHashName(algorithm.hash)));
    }
    if (name === "HKDF") {
      return arrayBufferFromBytes(hkdfSync(webcryptoHashName(algorithm.hash), cryptoKey.material, algorithm.salt, algorithm.info, byteLength));
    }
    if (name === "ECDH" || name === "X25519" || name === "X448") {
      const secret = diffieHellman({ privateKey: webcryptoKeyToNodeKey(cryptoKey), publicKey: webcryptoKeyToNodeKey(algorithm.public) });
      return arrayBufferFromBytes(byteLength == null ? secret : secret.slice(0, byteLength));
    }
    throw new TypeError(`Invalid WebCrypto deriveBits algorithm: ${name}`);
  },

  async deriveKey(algorithm, baseKey, derivedKeyAlgorithm, extractable, keyUsages) {
    const target = webcryptoNormalizeKeyAlgorithm(derivedKeyAlgorithm);
    const length = positiveInteger(derivedKeyAlgorithm.length, "length");
    const bits = await this.deriveBits(algorithm, baseKey, length);
    if (target.name.startsWith("AES-") || target.name === "HMAC") {
      return this.importKey("raw", bits, derivedKeyAlgorithm, extractable, keyUsages);
    }
    throw new TypeError(`Invalid WebCrypto deriveKey target: ${target.name}`);
  },

  async wrapKey(format, key, wrappingKey, wrapAlgorithm) {
    const exported = await this.exportKey(format, key);
    const name = webcryptoAlgorithmName(wrapAlgorithm) || wrappingKey.algorithm?.name;
    if (name === "AES-KW") return webcryptoAesKwWrap(assertCryptoKey(wrappingKey, "wrapKey"), exported, "wrapKey");
    return this.encrypt(wrapAlgorithm, wrappingKey, exported);
  },

  async unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgorithm, unwrappedKeyAlgorithm, extractable, keyUsages) {
    const name = webcryptoAlgorithmName(unwrapAlgorithm) || unwrappingKey.algorithm?.name;
    const data = name === "AES-KW"
      ? await webcryptoAesKwUnwrap(assertCryptoKey(unwrappingKey, "unwrapKey"), wrappedKey, "unwrapKey")
      : await this.decrypt(unwrapAlgorithm, unwrappingKey, wrappedKey);
    return this.importKey(format, data, unwrappedKeyAlgorithm, extractable, keyUsages);
  },
};

export const constants = constantsObject;
export const webcrypto = globalThis.crypto ?? { getRandomValues, randomUUID };
if (webcrypto.subtle == null) webcrypto.subtle = subtleCrypto;
export const subtle = webcrypto.subtle;
export let fips = 0;

export function getFips() {
  return fips;
}

export function setFips(value) {
  fips = Number(value) ? 1 : 0;
}

export default {
  Certificate,
  Cipheriv,
  Decipheriv,
  DiffieHellman,
  DiffieHellmanGroup,
  ECDH,
  Hash,
  Hmac,
  KeyObject,
  Sign,
  Verify,
  X509Certificate,
  argon2,
  argon2Sync,
  checkPrime,
  checkPrimeSync,
  constants,
  createCipheriv,
  createDecipheriv,
  createDiffieHellman,
  createDiffieHellmanGroup,
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  createSign,
  createVerify,
  decapsulate,
  diffieHellman,
  encapsulate,
  fips,
  generateKey,
  generateKeyPair,
  generateKeyPairSync,
  generateKeySync,
  generatePrime,
  generatePrimeSync,
  getCipherInfo,
  getCiphers,
  getCurves,
  getDiffieHellman,
  getFips,
  getHashes,
  getRandomValues,
  hash,
  hkdf,
  hkdfSync,
  pbkdf2,
  pbkdf2Sync,
  privateDecrypt,
  privateEncrypt,
  prng,
  pseudoRandomBytes,
  publicDecrypt,
  publicEncrypt,
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  randomUUID,
  rng,
  scrypt,
  scryptSync,
  secureHeapUsed,
  setEngine,
  setFips,
  sign,
  subtle,
  timingSafeEqual,
  verify,
  webcrypto,
};
