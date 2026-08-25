import { asBuffer, concatManyBuffers } from "./web-buffer-utils.js";

const defaultCSRFSecret = "cottontail-default-csrf-secret";
const defaultCSRFMaxAgeMs = 24 * 60 * 60 * 1000;
const csrfHeaderLength = 32;

function csrfAlgorithm(algorithm = "sha256") {
  const normalized = String(algorithm ?? "sha256").toLowerCase().replace(/_/g, "-");
  if (normalized === "blake2b256") return { name: "blake2b512", length: 32 };
  if (normalized === "blake2b512") return { name: "blake2b512", length: 64 };
  if (normalized === "sha512-256") return { name: "sha512", length: 32 };
  if (normalized === "sha256" || normalized === "sha384" || normalized === "sha512") return { name: normalized };
  return { name: normalized };
}

function csrfWriteU64(bytes, offset, value) {
  let current = BigInt(Math.max(0, Math.trunc(Number(value))));
  for (let index = offset + 7; index >= offset; index -= 1) {
    bytes[index] = Number(current & 0xffn);
    current >>= 8n;
  }
}

function csrfReadU64(bytes, offset) {
  let value = 0n;
  for (let index = offset; index < offset + 8; index += 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  return Number(value);
}

function csrfMac(secret, algorithm, payload) {
  const spec = csrfAlgorithm(algorithm);
  const key = typeof secret === "string" ? new TextEncoder().encode(secret) : asBuffer(secret);
  let digest = new Uint8Array(cottontail.cryptoHmacSync(spec.name, key, payload));
  if (spec.length != null) digest = digest.subarray(0, spec.length);
  return digest;
}

function csrfEncode(bytes, encoding = "base64url") {
  const buffer = globalThis.Buffer.from(bytes);
  if (encoding === "hex") return buffer.toString("hex");
  if (encoding === "base64") return buffer.toString("base64");
  if (encoding === "base64url" || encoding == null) {
    return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  throw new TypeError(`Unsupported CSRF token encoding: ${encoding}`);
}

function csrfDecode(token, encoding = "base64url") {
  const text = String(token);
  if (encoding === "hex") {
    if (text.length % 2 !== 0 || /[^0-9a-f]/i.test(text)) return null;
    return asBuffer(globalThis.Buffer.from(text, "hex"));
  }
  if (encoding === "base64") return asBuffer(globalThis.Buffer.from(text, "base64"));
  if (encoding === "base64url" || encoding == null) {
    if (/[^A-Za-z0-9_-]/.test(text)) return null;
    const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
    if (base64.length % 4 === 1) return null;
    return asBuffer(globalThis.Buffer.from(base64 + "=".repeat((4 - (base64.length % 4)) % 4), "base64"));
  }
  throw new TypeError(`Unsupported CSRF token encoding: ${encoding}`);
}

function csrfSecret(value) {
  const secret = value ?? defaultCSRFSecret;
  if (String(secret).length === 0) throw new TypeError("CSRF secret must not be empty");
  return secret;
}

export const CSRF = {
  generate(secret = defaultCSRFSecret, options = {}) {
    const actualSecret = csrfSecret(secret);
    const now = Date.now();
    const expiresIn = options.expiresIn == null ? defaultCSRFMaxAgeMs : Number(options.expiresIn);
    const header = new Uint8Array(csrfHeaderLength);
    csrfWriteU64(header, 0, now);
    csrfWriteU64(header, 8, now + Math.max(0, expiresIn));
    header.set(new Uint8Array(cottontail.randomBytes(16)), 16);
    const mac = csrfMac(actualSecret, options.algorithm, header);
    return csrfEncode(concatManyBuffers([header, mac]), options.encoding ?? "base64url");
  },
  verify(token, options = {}) {
    if (String(token ?? "").length === 0) throw new TypeError("CSRF token must not be empty");
    const actualSecret = csrfSecret(options.secret);
    const bytes = csrfDecode(token, options.encoding ?? "base64url");
    if (!bytes || bytes.byteLength <= csrfHeaderLength) return false;
    const header = bytes.subarray(0, csrfHeaderLength);
    const mac = bytes.subarray(csrfHeaderLength);
    const expected = csrfMac(actualSecret, options.algorithm, header);
    if (mac.byteLength !== expected.byteLength) return false;
    let diff = 0;
    for (let index = 0; index < mac.byteLength; index += 1) diff |= mac[index] ^ expected[index];
    if (diff !== 0) return false;
    const issuedAt = csrfReadU64(header, 0);
    const expiresAt = csrfReadU64(header, 8);
    const now = Date.now();
    if (expiresAt <= now) return false;
    if (options.maxAge != null && now - issuedAt > Number(options.maxAge)) return false;
    return true;
  },
};
