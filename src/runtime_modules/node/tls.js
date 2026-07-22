import { Buffer } from "./buffer.js";
import { _wrapAsyncCallback } from "./async_hooks.js";
import { X509Certificate, createHash, createDecipheriv, randomBytes } from "./crypto.js";
import { connect as netConnect, isIP, Server as NetServer, Socket, SocketAddress } from "./net.js";

export const CLIENT_RENEG_LIMIT = 3;
export const CLIENT_RENEG_WINDOW = 600;
export const DEFAULT_CIPHERS = "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";
export const DEFAULT_ECDH_CURVE = "auto";
export const DEFAULT_MAX_VERSION = "TLSv1.3";
export const DEFAULT_MIN_VERSION = "TLSv1.2";

const certificatePaths = [
  "/etc/ssl/cert.pem",
  "/etc/ssl/certs/ca-certificates.crt",
  "/opt/homebrew/etc/ca-certificates/cert.pem",
  "/usr/local/etc/openssl@3/cert.pem",
];

const bunTlsConnectOptions = Symbol.for("::buntlsconnectoptions::");
const rejectUnauthorizedDefault = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0" && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "false";
let rejectUnauthorizedWarningEmitted = false;

function invalidArgType(name, expected, value) {
  const received = value === null ? "null" : `type ${typeof value} (${String(value)})`;
  const error = new TypeError(`The "${name}" argument must be ${expected}. Received ${received}`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function invalidArgValue(name, value, reason = "is invalid") {
  const error = new TypeError(`The argument '${name}' ${reason}. Received ${JSON.stringify(value)}`);
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

function outOfRange(name, range, value) {
  const error = new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`);
  error.code = "ERR_OUT_OF_RANGE";
  return error;
}

function tlsError(message, code, details = undefined) {
  const error = new Error(message);
  if (code != null) error.code = code;
  if (details) Object.assign(error, details);
  return error;
}

function normalizeTlsError(value, fallback = "TLS operation failed") {
  if (value instanceof Error) return value;
  const error = new Error(value == null ? fallback : String(value));
  if (/connection reset|unexpected eof|closed before.*handshake/i.test(error.message)) error.code = "ECONNRESET";
  return error;
}

function validateCiphers(ciphers, name = "options") {
  if (ciphers == null) return;
  if (typeof ciphers !== "string") {
    const error = new TypeError(`The "${name}.ciphers" property must be of type string. Received ${typeof ciphers}`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (ciphers.length === 0) return;
  try {
    cottontail.tlsValidateCiphers?.(ciphers);
  } catch (error) {
    if (error?.code !== "ERR_SSL_NO_CIPHER_MATCH") throw error;
    error.library = "SSL routines";
    error.reason = "no cipher match";
    error.message = "No cipher match";
    throw error;
  }
}

const tlsVersionNumbers = Object.freeze({
  TLSv1: 0x0301,
  "TLSv1.1": 0x0302,
  "TLSv1.2": 0x0303,
  "TLSv1.3": 0x0304,
});

function tlsProtocolError(message, code) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function protocolVersionNumber(value, optionName) {
  const version = tlsVersionNumbers[value];
  if (version == null) {
    throw tlsProtocolError(`${optionName} must be a valid TLS protocol version. Received ${String(value)}`, "ERR_TLS_INVALID_PROTOCOL_VERSION");
  }
  return version;
}

function protocolMethodRange(method) {
  if (/^SSLv(?:2|3)(?:_(?:client|server))?_method$/.test(method)) {
    const version = method.startsWith("SSLv2") ? "SSLv2" : "SSLv3";
    throw tlsProtocolError(`${version} methods disabled`, "ERR_TLS_INVALID_PROTOCOL_METHOD");
  }
  if (/^(?:TLS|SSLv23)(?:_(?:client|server))?_method$/.test(method)) {
    return [tlsVersionNumbers[DEFAULT_MIN_VERSION], tlsVersionNumbers[DEFAULT_MAX_VERSION]];
  }
  const exact = /^TLSv1(?:_([12]))?(?:_(?:client|server))?_method$/.exec(method);
  if (exact) {
    const version = exact[1] == null ? "TLSv1" : `TLSv1.${exact[1]}`;
    const number = tlsVersionNumbers[version];
    return [number, number];
  }
  throw tlsProtocolError(`Unknown method: ${method}`, "ERR_TLS_INVALID_PROTOCOL_METHOD");
}

function tlsProtocolOptions(options = {}) {
  const context = options?.secureContext?.context ?? {};
  const minValue = options?.minVersion ?? context.minVersion;
  const maxValue = options?.maxVersion ?? context.maxVersion;
  const method = options?.secureProtocol ?? context.secureProtocol;
  if (method != null && (minValue != null || maxValue != null)) {
    throw tlsProtocolError("Secure protocol method conflicts with minVersion or maxVersion", "ERR_TLS_PROTOCOL_VERSION_CONFLICT");
  }
  let minVersion;
  let maxVersion;
  if (method != null) {
    [minVersion, maxVersion] = protocolMethodRange(String(method));
  } else {
    minVersion = protocolVersionNumber(minValue ?? DEFAULT_MIN_VERSION, "minVersion");
    maxVersion = protocolVersionNumber(maxValue ?? DEFAULT_MAX_VERSION, "maxVersion");
  }
  if (minVersion > maxVersion) {
    throw tlsProtocolError("minVersion must not exceed maxVersion", "ERR_TLS_INVALID_PROTOCOL_VERSION");
  }
  const rawSecureOptions = options?.secureOptions ?? context.secureOptions ?? 0;
  if (typeof rawSecureOptions !== "number" || !Number.isFinite(rawSecureOptions)) {
    throw invalidArgType("options.secureOptions", "of type number", rawSecureOptions);
  }
  return {
    minVersion,
    maxVersion,
    secureOptions: Math.trunc(rawSecureOptions) >>> 0,
  };
}

function normalizeCertificateLabels(value) {
  return String(value ?? "")
    .replace(/-----BEGIN (?:X509 |TRUSTED )CERTIFICATE-----/g, "-----BEGIN CERTIFICATE-----")
    .replace(/-----END (?:X509 |TRUSTED )CERTIFICATE-----/g, "-----END CERTIFICATE-----");
}

function valueToPem(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString();
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString();
  if (typeof value === "object" && value.pem != null) return valueToPem(value.pem);
  return String(value);
}

function parsePemCertificates(text, trailingNewline = false) {
  const matches = normalizeCertificateLabels(text).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  return matches ? matches.map((cert) => `${cert.trim()}${trailingNewline ? "\n" : ""}`) : [];
}

function uniqueCertificates(certificates) {
  return Array.from(new Set(certificates));
}

function systemRootCertificates() {
  for (const path of certificatePaths) {
    try {
      const certs = parsePemCertificates(cottontail.readFile(path));
      if (certs.length > 0) return uniqueCertificates(certs);
    } catch {}
  }
  try {
    const result = cottontail.spawnSync("security", ["find-certificate", "-a", "-p", "/System/Library/Keychains/SystemRootCertificates.keychain"], { stdio: "pipe" });
    if (result.status === 0) return uniqueCertificates(parsePemCertificates(result.stdout));
  } catch {}
  return [];
}

function normalizeCertificates(certs) {
  const list = Array.isArray(certs) ? certs : [certs];
  return list.flatMap((cert) => parsePemCertificates(valueToPem(cert)));
}

function installTlsEventDispatcher() {
  const listeners = globalThis.__cottontailTlsListeners ??= new Map();
  if (!globalThis.__cottontailFdWatchHandlerInstalled && typeof cottontail.fdSetEventHandler === "function") {
    globalThis.__cottontailFdWatchHandlerInstalled = true;
    cottontail.fdSetEventHandler((event) => {
      const connectListener = globalThis.__cottontailTcpConnectListeners?.get?.(Number(event?.id));
      if (typeof connectListener === "function") {
        connectListener(event);
        return;
      }
      const fdListeners = globalThis.__cottontailFdWatchListeners;
      const fdListener = fdListeners?.get?.(Number(event?.id));
      if (typeof fdListener === "function") {
        fdListener(event);
        return;
      }
      const tlsListener = listeners.get(Number(event?.id));
      if (typeof tlsListener === "function") tlsListener(event);
    });
  }
  return listeners;
}

function normalizeConnectArgs(args) {
  const list = Array.from(args ?? []);
  const callback = typeof list[list.length - 1] === "function" ? list.pop() : undefined;
  let options = {};
  if (typeof list[0] === "object" && list[0] !== null) {
    options = { ...list[0] };
  } else if (typeof list[0] === "string" && (list[0].trim() === "" || !Number.isFinite(Number(list[0])) || Number(list[0]) < 0)) {
    options.path = list[0];
    if (typeof list[1] === "object" && list[1] !== null) options = { ...options, ...list[1] };
  } else {
    options.port = list[0];
    if (typeof list[1] === "string") {
      options.host = list[1];
      if (typeof list[2] === "object" && list[2] !== null) options = { ...options, ...list[2] };
    } else if (typeof list[1] === "object" && list[1] !== null) {
      options = { ...options, ...list[1] };
    }
  }
  return [options, callback];
}

function normalizeListenArgs(args) {
  const list = Array.from(args ?? []);
  const callback = typeof list[list.length - 1] === "function" ? list.pop() : undefined;
  let options = {};
  if (typeof list[0] === "object" && list[0] !== null) {
    options = { ...list[0] };
  } else if (typeof list[0] === "string" && !/^\d+$/.test(list[0])) {
    options.path = list[0];
  } else {
    options.port = list[0] ?? 0;
    if (typeof list[1] === "string") options.host = list[1];
  }
  return [options, callback];
}

function flattenPem(value) {
  if (value == null) return "";
  const text = Array.isArray(value) ? value.map(valueToPem).join("\n") : valueToPem(value);
  return normalizeCertificateLabels(text);
}

// Decrypt a traditional (Proc-Type: 4,ENCRYPTED) PEM private key in JS: the
// native TLS binding would otherwise fall through to OpenSSL's interactive
// terminal passphrase prompt and hang the process.
function decryptEncryptedPemKey(pem, passphrase) {
  const match = pem.match(/-----BEGIN ([A-Z0-9 ]+)-----\r?\nProc-Type: 4,ENCRYPTED\r?\nDEK-Info: ([A-Za-z0-9-]+),([0-9A-Fa-f]+)\r?\n\r?\n([\s\S]*?)-----END \1-----/);
  if (!match) {
    const err = new Error("error:1E08010C:DECODER routines::unsupported");
    err.code = "ERR_OSSL_UNSUPPORTED";
    throw err;
  }
  if (passphrase == null) {
    const err = new Error("Passphrase required for encrypted key");
    err.code = "ERR_MISSING_PASSPHRASE";
    throw err;
  }
  const [, label, cipherName, ivHex, body] = match;
  const iv = Buffer.from(ivHex, "hex");
  const data = Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  const keySizes = { "AES-128-CBC": 16, "AES-192-CBC": 24, "AES-256-CBC": 32, "DES-EDE3-CBC": 24, "DES-CBC": 8 };
  const keyLength = keySizes[cipherName.toUpperCase()];
  if (!keyLength) {
    const err = new Error(`Unsupported encrypted PEM cipher: ${cipherName}`);
    err.code = "ERR_OSSL_UNSUPPORTED";
    throw err;
  }
  // OpenSSL derives the key via EVP_BytesToKey(MD5, salt = first 8 IV bytes).
  const salt = iv.subarray(0, 8);
  const pass = Buffer.from(String(passphrase));
  let key = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (key.length < keyLength) {
    previous = createHash("md5").update(Buffer.concat([previous, pass, salt])).digest();
    key = Buffer.concat([key, previous]);
  }
  key = key.subarray(0, keyLength);
  let decrypted;
  try {
    const decipher = createDecipheriv(cipherName.toLowerCase(), key, iv);
    decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    const err = new Error("error:1C800064:Provider routines::bad decrypt");
    err.code = "ERR_OSSL_EVP_BAD_DECRYPT";
    err.reason = "bad decrypt";
    throw err;
  }
  const base64 = decrypted.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n+$/, "");
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

function prepareTlsKey(keyOption, passphrase) {
  const pem = flattenPem(keyOption);
  if (!pem) return pem;
  if (/Proc-Type: 4,ENCRYPTED/.test(pem)) return decryptEncryptedPemKey(pem, passphrase);
  if (/BEGIN ENCRYPTED PRIVATE KEY/.test(pem)) {
    if (passphrase == null) {
      const err = new Error("Passphrase required for encrypted key");
      err.code = "ERR_MISSING_PASSPHRASE";
      throw err;
    }
    return pem;
  }
  return pem;
}

function tlsCredentialOptions(options) {
  const context = options?.secureContext?.context ?? {};
  const keyOption = options?.key ?? context.key;
  const keyEntries = Array.isArray(keyOption) ? keyOption : [keyOption];
  const keyPassphrase = keyEntries.find((entry) => entry && typeof entry === "object" && !ArrayBuffer.isView(entry) && entry.passphrase != null)?.passphrase;
  const passphraseOption = options?.passphrase ?? context.passphrase ?? keyPassphrase;
  const passphrase = passphraseOption == null
    ? undefined
    : ArrayBuffer.isView(passphraseOption) || passphraseOption instanceof ArrayBuffer
      ? Buffer.from(passphraseOption).toString()
      : String(passphraseOption);
  const caOption = options?.ca ?? context.ca;
  let ca = caOption == null ? undefined : flattenPem(caOption);
  if (caOption == null && (defaultCACertificatesWasSet || extraCACertificates.length > 0)) {
    ca = flattenPem(defaultCACertificates);
  }
  return {
    ca,
    cert: flattenPem(options?.cert ?? context.cert),
    key: prepareTlsKey(keyOption, passphrase),
    passphrase,
  };
}

function validateNativeServerContext(options, credentials = tlsCredentialOptions(options), protocols = tlsProtocolOptions(options)) {
  cottontail.tlsValidateServerContext?.(
    credentials.cert,
    credentials.key,
    credentials.passphrase,
    credentials.ca,
    options?.ciphers,
    Boolean(options?.requestCert),
    options?.rejectUnauthorized !== false,
    protocols.minVersion,
    protocols.maxVersion,
    protocols.secureOptions,
  );
}

function bytesFrom(chunk, encoding = undefined) {
  if (chunk == null) return new Uint8Array(0);
  if (typeof chunk === "string") return Buffer.from(chunk, encoding ?? "utf8");
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk));
}

function chunkFromBytes(bytes, encoding = null) {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(0);
  const buffer = Buffer.from(view);
  return encoding ? buffer.toString(encoding) : buffer;
}

function bufferFromNativeBytes(bytes) {
  if (bytes == null) return undefined;
  if (bytes instanceof ArrayBuffer) return Buffer.from(new Uint8Array(bytes));
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return undefined;
}

function validateSessionTimeout(value, name = "options.sessionTimeout") {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value) || value < 0 || value > 2 ** 31 - 1) {
    throw outOfRange(name, `>= 0 && <= ${2 ** 31 - 1}`, value);
  }
  return value;
}

function validateTicketKeys(value, name = "ticketKeys") {
  if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
    throw invalidArgType(name, "an instance of Buffer, TypedArray, DataView, or ArrayBuffer", value);
  }
  const keys = Buffer.from(bytesFrom(value));
  if (keys.byteLength !== 48) {
    const message = name === "options.ticketKeys"
      ? `The property '${name}' must be exactly 48 bytes. Received ${keys.byteLength}`
      : "Session ticket keys must be a 48-byte buffer";
    const error = new TypeError(message);
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }
  return keys;
}

function validateSessionIdContext(value, name = "options.sessionIdContext") {
  if (typeof value !== "string") throw invalidArgType(name, "of type string", value);
  const context = Buffer.from(value);
  if (context.byteLength > 32) throw invalidArgValue(name, value, "must not exceed 32 bytes");
  return value;
}

let defaultServerSessionIdContext;
function serverSessionIdContext() {
  if (defaultServerSessionIdContext == null) {
    defaultServerSessionIdContext = createHash("sha1").update(process.argv.join(" ")).digest("hex").slice(0, 32);
  }
  return defaultServerSessionIdContext;
}

function legacyCertificateFromBytes(bytes) {
  const raw = bufferFromNativeBytes(bytes);
  if (raw == null || raw.byteLength === 0) return {};
  try {
    return normalizeLegacyCertificate(new X509Certificate(raw).toLegacyObject());
  } catch {
    return { raw };
  }
}

function normalizeLegacyCertificate(certificate) {
  if (certificate == null || typeof certificate !== "object") return certificate;
  if (typeof certificate.modulus === "string") certificate.modulus = certificate.modulus.toLowerCase();
  if (typeof certificate.serialNumber === "string") certificate.serialNumber = certificate.serialNumber.toLowerCase();
  return certificate;
}

function peerX509CertificateChain(info) {
  const chain = Array.isArray(info?.peerCertificateChain) && info.peerCertificateChain.length > 0
    ? info.peerCertificateChain
    : info?.peerCertificate == null
      ? []
      : [info.peerCertificate];
  const certificates = [];
  for (const bytes of chain) {
    const raw = bufferFromNativeBytes(bytes);
    if (raw == null || raw.byteLength === 0) continue;
    try {
      certificates.push(new X509Certificate(raw));
    } catch {}
  }
  return certificates;
}

function isSelfIssuedCertificate(certificate) {
  if (!(certificate instanceof X509Certificate) || certificate.subject !== certificate.issuer) return false;
  try {
    return certificate.verify(certificate.publicKey);
  } catch {
    return false;
  }
}

function legacyPeerCertificate(info, detailed = false) {
  const certificates = peerX509CertificateChain(info);
  if (certificates.length === 0) return {};
  if (!detailed) return normalizeLegacyCertificate(certificates[0].toLegacyObject());

  const legacy = certificates.map((certificate) => normalizeLegacyCertificate(certificate.toLegacyObject()));
  for (let index = 0; index + 1 < legacy.length; index += 1) {
    legacy[index].issuerCertificate = legacy[index + 1];
  }
  const lastIndex = legacy.length - 1;
  if (isSelfIssuedCertificate(certificates[lastIndex])) {
    legacy[lastIndex].issuerCertificate = legacy[lastIndex];
  }
  return legacy[0];
}

function defaultCipherList() {
  return Array.from(new Set(
    DEFAULT_CIPHERS
      .split(":")
      .map((cipher) => cipher.trim())
      .filter((cipher) => cipher && cipher !== "HIGH" && !cipher.startsWith("!") && !cipher.includes("@"))
      .map((cipher) => cipher.toLowerCase()),
  ));
}

function unfqdn(host) {
  return String(host).replace(/[.]$/, "");
}

function splitHost(host) {
  return unfqdn(host).replace(/[A-Z]/g, (character) => character.toLowerCase()).split(".");
}

function matchDnsName(hostParts, pattern, wildcards = true) {
  if (!pattern) return false;
  const patternParts = splitHost(pattern);
  if (hostParts.length !== patternParts.length || patternParts.includes("")) return false;
  if (patternParts.some((part) => /[^\u0021-\u007f]/u.test(part))) return false;
  for (let index = hostParts.length - 1; index > 0; index -= 1) {
    if (hostParts[index] !== patternParts[index]) return false;
  }
  const hostSubdomain = hostParts[0];
  const patternSubdomain = patternParts[0];
  const wildcardParts = patternSubdomain.split("*");
  if (wildcardParts.length === 1 || patternSubdomain.includes("xn--")) return hostSubdomain === patternSubdomain;
  if (!wildcards || wildcardParts.length > 2 || patternParts.length <= 2) return false;
  const [prefix, suffix] = wildcardParts;
  return prefix.length + suffix.length <= hostSubdomain.length && hostSubdomain.startsWith(prefix) && hostSubdomain.endsWith(suffix);
}

const jsonStringPattern = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/;

function splitEscapedAltNames(altNames) {
  const result = [];
  let current = "";
  let offset = 0;
  while (offset !== altNames.length) {
    const separator = altNames.indexOf(", ", offset);
    const quote = altNames.indexOf('"', offset);
    if (quote !== -1 && (separator === -1 || quote < separator)) {
      current += altNames.substring(offset, quote);
      const match = jsonStringPattern.exec(altNames.substring(quote));
      if (!match) throw tlsError("Invalid subject alternative name string", "ERR_TLS_CERT_ALTNAME_FORMAT");
      current += JSON.parse(match[0]);
      offset = quote + match[0].length;
    } else if (separator !== -1) {
      current += altNames.substring(offset, separator);
      result.push(current);
      current = "";
      offset = separator + 2;
    } else {
      current += altNames.substring(offset);
      offset = altNames.length;
    }
  }
  result.push(current);
  return result;
}

function canonicalizeIP(address) {
  const text = String(address);
  if (isIP(text) === 4) return text.split(".").map(Number).join(".");
  if (isIP(text) === 6) return SocketAddress.parse(`[${text}]`)?.address ?? text.toLowerCase();
  return text;
}

function altNameError(host, cert, reason) {
  const error = new Error(`Hostname/IP does not match certificate's altnames: ${reason}`);
  error.code = "ERR_TLS_CERT_ALTNAME_INVALID";
  error.reason = reason;
  error.host = host;
  error.cert = cert;
  return error;
}

export function checkServerIdentity(host, cert) {
  let hostname = String(host);
  const subject = cert?.subject;
  const altNames = cert?.subjectaltname;
  const dnsNames = [];
  const ips = [];
  if (altNames) {
    const names = String(altNames).includes('"') ? splitEscapedAltNames(String(altNames)) : String(altNames).split(", ");
    for (const name of names) {
      if (name.startsWith("DNS:")) dnsNames.push(name.slice(4));
      else if (name.startsWith("IP Address:")) ips.push(canonicalizeIP(name.slice(11)));
    }
  }
  hostname = unfqdn(hostname);
  let valid = false;
  let reason = "Unknown reason";
  if (isIP(hostname)) {
    valid = ips.includes(canonicalizeIP(hostname));
    if (!valid) reason = `IP: ${hostname} is not in the cert's list: ${ips.join(", ")}`;
  } else if (dnsNames.length > 0 || subject?.CN) {
    const hostParts = splitHost(hostname);
    if (dnsNames.length > 0) {
      valid = dnsNames.some((name) => matchDnsName(hostParts, name, true));
      if (!valid) reason = `Host: ${hostname}. is not in the cert's altnames: ${altNames}`;
    } else {
      const commonName = subject.CN;
      valid = Array.isArray(commonName)
        ? commonName.some((name) => matchDnsName(hostParts, name, true))
        : matchDnsName(hostParts, commonName, true);
      if (!valid) reason = `Host: ${hostname}. is not cert's CN: ${commonName}`;
    }
  } else {
    reason = "Cert does not contain a DNS name";
  }
  return valid ? undefined : altNameError(hostname, cert, reason);
}

function validateTlsMaterial(name, value, allowKeyObject = false) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) validateTlsMaterial(`${name}[${index}]`, value[index], allowKeyObject);
    return;
  }
  if (typeof value === "string" || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
  if (allowKeyObject && typeof value === "object" && value.pem != null) {
    validateTlsMaterial(`${name}.pem`, value.pem, false);
    if (value.passphrase != null && typeof value.passphrase !== "string" && !ArrayBuffer.isView(value.passphrase)) {
      throw invalidArgType(`${name}.passphrase`, "of type string or an instance of Buffer", value.passphrase);
    }
    return;
  }
  throw invalidArgType(name, "of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer", value);
}

class SecureContextImpl {
  constructor(options = {}) {
    if (options == null) options = {};
    if (typeof options !== "object") throw invalidArgType("options", "of type object", options);
    validateTlsMaterial("options.cert", options.cert);
    validateTlsMaterial("options.key", options.key, true);
    validateTlsMaterial("options.ca", options.ca);
    if (options.passphrase != null && typeof options.passphrase !== "string" && !ArrayBuffer.isView(options.passphrase)) {
      throw invalidArgType("options.passphrase", "of type string or an instance of Buffer", options.passphrase);
    }
    if (options.servername != null && typeof options.servername !== "string") throw invalidArgType("options.servername", "of type string", options.servername);
    if (options.secureOptions != null && typeof options.secureOptions !== "number") throw invalidArgType("options.secureOptions", "of type number", options.secureOptions);
    for (const versionName of ["minVersion", "maxVersion", "secureProtocol"]) {
      if (options[versionName] != null && typeof options[versionName] !== "string") throw invalidArgType(`options.${versionName}`, "of type string", options[versionName]);
    }
    validateCiphers(options.ciphers);
    const context = { ...options };
    if (options.ticketKeys != null) context.ticketKeys = validateTicketKeys(options.ticketKeys, "options.ticketKeys");
    if (options.sessionTimeout != null) context.sessionTimeout = validateSessionTimeout(options.sessionTimeout);
    if (options.sessionIdContext != null) context.sessionIdContext = validateSessionIdContext(options.sessionIdContext);
    const protocols = tlsProtocolOptions(context);
    const credentials = tlsCredentialOptions(context);
    try {
      cottontail.tlsValidateSecureContext?.(
        credentials.cert,
        credentials.key,
        credentials.passphrase,
        credentials.ca,
        context.ciphers,
        protocols.minVersion,
        protocols.maxVersion,
        protocols.secureOptions,
      );
    } catch (error) {
      throw normalizeTlsError(error, "Failed to initialize TLS context");
    }
    this.context = context;
    this.servername = options.servername;
  }
}

Object.defineProperty(SecureContextImpl, "name", { value: "SecureContext", configurable: true });
export const SecureContext = new Proxy(SecureContextImpl, {
  apply(target, _thisArg, args) {
    return Reflect.construct(target, args);
  },
});

export function createSecureContext(options = {}) {
  if (options instanceof SecureContext) return options;
  const { privateKeyIdentifier, privateKeyEngine } = options ?? {};
  // Node only validates the engine/identifier pair when an identifier is
  // provided.
  if (privateKeyIdentifier !== undefined && privateKeyIdentifier !== null) {
    if (privateKeyEngine === undefined || privateKeyEngine === null) {
      const err = new TypeError(`The property 'options.privateKeyEngine' is invalid. Received ${privateKeyEngine === null ? "null" : "undefined"}`);
      err.code = "ERR_INVALID_ARG_VALUE";
      throw err;
    }
    if (typeof privateKeyEngine !== "string") {
      const err = new TypeError(`The "options.privateKeyEngine" property must be of type string, null, or undefined. Received ${typeof privateKeyEngine} (${String(privateKeyEngine)})`);
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    if (typeof privateKeyIdentifier !== "string") {
      const err = new TypeError(`The "options.privateKeyIdentifier" property must be of type string, null, or undefined. Received ${typeof privateKeyIdentifier} (${String(privateKeyIdentifier)})`);
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
  }
  return new SecureContext(options);
}

export class TLSSocket extends Socket {
  constructor(socket = undefined, options = {}) {
    const isTransport = socket != null && typeof socket === "object" &&
      (typeof socket._detachFdForTls === "function" || (typeof socket.on === "function" && typeof socket.write === "function"));
    if (!isTransport && socket != null) {
      options = socket;
      socket = undefined;
    }
    if (options == null) options = {};
    if (typeof options !== "object") throw invalidArgType("options", "of type object", options);
    super({ ...options, fd: undefined, allowHalfOpen: false });
    validateCiphers(options.ciphers);
    if (options.secureContext != null && !(options.secureContext instanceof SecureContext)) {
      throw invalidArgType("options.secureContext", "an instance of SecureContext", options.secureContext);
    }
    if (options.SNICallback != null && typeof options.SNICallback !== "function") throw invalidArgType("options.SNICallback", "of type function", options.SNICallback);
    if (options.ALPNCallback != null && typeof options.ALPNCallback !== "function") throw invalidArgType("options.ALPNCallback", "of type function", options.ALPNCallback);
    if (options.ALPNCallback != null && options.ALPNProtocols != null) {
      throw tlsError("ALPNCallback and ALPNProtocols are mutually exclusive", "ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS");
    }
    this.encrypted = true;
    this.authorized = false;
    this.authorizationError = null;
    this.alpnProtocol = null;
    this.servername = options?.servername;
    this._parent = socket;
    this._secureContext = options?.secureContext ?? createSecureContext(options ?? {});
    this.ALPNProtocols = prepareALPNProtocols(options.ALPNProtocols);
    this._SNICallback = options.SNICallback;
    this._ALPNCallback = options.ALPNCallback;
    this._clientHelloHandling = false;
    this._clientHelloError = null;
    this._ticketKeys = options.ticketKeys == null ? undefined : validateTicketKeys(options.ticketKeys, "options.ticketKeys");
    this._sessionTimeout = options.sessionTimeout == null ? undefined : validateSessionTimeout(options.sessionTimeout);
    this._sessionIdContext = options.sessionIdContext == null
      ? undefined
      : Buffer.from(validateSessionIdContext(options.sessionIdContext));
    this.ciphers = options.ciphers;
    this._tlsId = null;
    this._tlsInfo = null;
    this._tlsTransportConnected = false;
    this._encoding = null;
    this._tlsListenerInstalled = false;
    this._tlsReadEndTimer = null;
    this._tlsHandshakeTimer = null;
    this._tlsDestroyTimer = null;
    this._tlsDestroyId = null;
    this._memoryTransport = null;
    this._memoryTransportListeners = null;
    this._memoryTransportEnded = false;
    this._memoryTransportEndPending = null;
    this._secureEventsEmitted = false;
    this._session = typeof options.session === "string"
      ? Buffer.from(options.session, "latin1")
      : bufferFromNativeBytes(options.session);
    if (options.session != null && this._session == null) {
      throw invalidArgType("options.session", "of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer", options.session);
    }
    this._maxSendFragment = null;
    this._tlsWriteBlocked = false;
    this._tlsNativeWriteBlocked = false;
    this._tlsTransportWriteBlocked = false;
    this._tlsShutdownSent = false;
    this._renegotiationDisabled = false;
    this.isServer = options?.isServer === true;
    this._rejectUnauthorized = options?.rejectUnauthorized == null ? rejectUnauthorizedDefault : options.rejectUnauthorized !== false;
    this._requestCert = this.isServer ? options?.requestCert === true : options?.requestCert !== false;
    this._requestOCSP = options?.requestOCSP === true;
    this._ocspResponseEmitted = false;
    this._checkServerIdentity = options?.checkServerIdentity ?? checkServerIdentity;
    this._identityHostname = options?.identityHostname;
    this._skipServerIdentity = options?.skipServerIdentity === true;
    const handshakeTimeout = options.handshakeTimeout ?? (this.isServer ? 120000 : 10000);
    if (typeof handshakeTimeout !== "number" || !Number.isFinite(handshakeTimeout) || handshakeTimeout < 0) {
      throw outOfRange("options.handshakeTimeout", "a non-negative finite number", handshakeTimeout);
    }
    this._handshakeTimeout = Math.trunc(handshakeTimeout);
    this.secureConnecting = true;
    this._secureEstablished = false;
    this._securePending = true;
    if (socket && typeof socket === "object") {
      this._handle = socket;
      try { socket._parentWrap = this; } catch {}
    }
    // Node's TLSSocket always disables half-open, ignoring the option.
    this.allowHalfOpen = false;
    this.connecting = true;
  }

  _markTlsTransportConnected() {
    if (this._tlsTransportConnected) return;
    this._tlsTransportConnected = true;
    this.connecting = false;
    if (this.isServer) return;
    this.emit("connect");
    if (!this._readyEmitted) {
      this._readyEmitted = true;
      this.emit("ready");
    }
  }

  _attachNative(native, connectedEvent = "secureConnect") {
    this._tlsId = Number(native.id);
    this.fd = Number(native.fd ?? -1);
    this._tlsInfo = native;
    this.destroyed = false;
    this.readable = true;
    this.writable = !this._ending;
    cottontail.tlsConnectionSetRef?.(this._tlsId, this._refed);
    if (this._renegotiationDisabled) cottontail.tlsConnectionDisableRenegotiation?.(this._tlsId);
    this._setAddressInfo(native.local, native.remote);
    if (this._maxSendFragment != null) {
      try { cottontail.tlsConnectionSetMaxSendFragment?.(this._tlsId, this._maxSendFragment); } catch {}
    }
    this._markTlsTransportConnected();
    if (native.pending === true) {
      this.authorized = false;
      this._continueTlsHandshake(connectedEvent);
      return this;
    }
    this._finishTlsConnect(connectedEvent);
    return this;
  }

  _attachMemoryTransport(native, transport, connectedEvent = "secureConnect") {
    this._tlsId = Number(native.id);
    this.fd = null;
    this._tlsInfo = native;
    this._memoryTransport = transport;
    this.destroyed = false;
    this.readable = true;
    this.writable = !this._ending;
    if (this._renegotiationDisabled) cottontail.tlsConnectionDisableRenegotiation?.(this._tlsId);
    const onData = (chunk) => {
      if (this.destroyed || this._tlsId == null) return;
      try {
        cottontail.tlsConnectionFeedMemory(this._tlsId, bytesFrom(chunk));
        this._refreshTimeout?.();
        this._tlsNativeWriteBlocked = false;
        this._tlsWriteBlocked = this._tlsTransportWriteBlocked;
        if (this.secureConnecting) this._driveMemoryHandshake(connectedEvent);
        else if (this._secureEventsEmitted) {
          this._drainMemoryPlaintext();
          this._flushMemoryCiphertext();
          this._flushTlsPendingWrites();
        }
      } catch (error) {
        this.destroy(normalizeTlsError(error));
      }
    };
    const onEnd = () => this._endMemoryTransport();
    const onClose = () => this._endMemoryTransport();
    const onError = (error) => this.destroy(normalizeTlsError(error));
    const onDrain = () => {
      this._tlsTransportWriteBlocked = false;
      this._tlsWriteBlocked = this._tlsNativeWriteBlocked;
      this._flushTlsPendingWrites();
      if (this.writableNeedDrain && this.writableLength === 0) {
        this.writableNeedDrain = false;
        this.emit("drain");
      }
    };
    this._memoryTransportListeners = { onData, onEnd, onClose, onError, onDrain };
    transport.on("data", onData);
    transport.once("end", onEnd);
    transport.once("close", onClose);
    transport.once("error", onError);
    transport.on("drain", onDrain);
    if (this._handshakeTimeout > 0) {
      this._tlsHandshakeTimer = setTimeout(() => {
        if (!this.secureConnecting || this.destroyed) return;
        const error = tlsError("TLS handshake timed out", "ETIMEDOUT");
        this.destroy(error);
      }, this._handshakeTimeout);
      if (!this._refed) this._tlsHandshakeTimer.unref?.();
    }
    this._markTlsTransportConnected();
    this._driveMemoryHandshake(connectedEvent);
    return this;
  }

  _driveMemoryHandshake(connectedEvent) {
    if (this.destroyed || this._tlsId == null || !this.secureConnecting) return;
    try {
      const complete = cottontail.tlsClientHandshake(this._tlsId) === true;
      this._flushMemoryCiphertext();
      if (!complete) return;
      if (this._tlsHandshakeTimer != null) {
        clearTimeout(this._tlsHandshakeTimer);
        this._tlsHandshakeTimer = null;
      }
      this._tlsInfo = cottontail.tlsConnectionInfo?.(this._tlsId) ?? this._tlsInfo;
      this._finishTlsConnect(connectedEvent);
      this._flushMemoryCiphertext();
    } catch (error) {
      this.destroy(normalizeTlsError(error));
    }
  }

  _flushMemoryCiphertext() {
    if (this._tlsId == null || this._memoryTransport == null) return true;
    let writable = true;
    for (;;) {
      const encrypted = cottontail.tlsConnectionDrainMemory(this._tlsId);
      const chunk = bufferFromNativeBytes(encrypted);
      if (chunk == null || chunk.byteLength === 0) break;
      writable = this._memoryTransport.write(chunk) !== false && writable;
    }
    return writable;
  }

  _emitPendingSessions() {
    if (this._tlsId == null || typeof cottontail.tlsConnectionTakeSession !== "function") return;
    for (;;) {
      const session = bufferFromNativeBytes(cottontail.tlsConnectionTakeSession(this._tlsId));
      if (session == null || session.byteLength === 0) return;
      this._session = session;
      this.emit("session", session);
    }
  }

  _handleRenegotiationSecure() {
    const info = cottontail.tlsConnectionInfo?.(this._tlsId) ?? this._tlsInfo ?? {};
    this._tlsInfo = info;
    const authorizationError = info.verifyErrorCode
      ? tlsError(info.verifyErrorMessage || info.verifyErrorCode, info.verifyErrorCode)
      : null;
    this.authorized = authorizationError == null;
    this.authorizationError = authorizationError == null
      ? null
      : authorizationError.code || authorizationError.message;
    if (authorizationError && this._rejectUnauthorized) {
      this.destroy(authorizationError);
      return;
    }
    this.alpnProtocol = info.alpnProtocol || false;
    this.emit("secure", this);
  }

  _drainMemoryPlaintext() {
    if (this._tlsId == null || this._memoryTransport == null || this.secureConnecting) return;
    const result = cottontail.tlsConnectionReadMemory(this._tlsId);
    if (result?.secure) this._handleRenegotiationSecure();
    if (this.destroyed) return;
    const chunk = bufferFromNativeBytes(result?.data);
    if (chunk != null && chunk.byteLength > 0) {
      this.bytesRead += chunk.byteLength;
      this._emitData(this._encoding ? chunk.toString(this._encoding) : chunk);
      this._refreshTimeout?.();
    }
    if (result?.error) {
      const message = String(result.error);
      const code = result.code ?? (/no renegotiation|renegotiation.*disabled/i.test(message)
        ? "ERR_TLS_RENEGOTIATION_DISABLED"
        : undefined);
      const error = tlsError(message, code);
      this.destroy(error);
      return;
    }
    this._emitPendingSessions();
    if (result?.ended) this._endMemoryTransport(true);
  }

  _endMemoryTransport(receivedCloseNotify = false) {
    if (this._memoryTransportEnded || this.destroyed) return;
    if (!this.secureConnecting && !this._secureEventsEmitted) {
      this._memoryTransportEndPending = Boolean(receivedCloseNotify || this._memoryTransportEndPending);
      return;
    }
    this._memoryTransportEnded = true;
    if (this.secureConnecting) {
      this.destroy(tlsError("Client network socket disconnected before secure TLS connection was established", "ECONNRESET"));
      return;
    }
    if (!receivedCloseNotify) {
      try { this._drainMemoryPlaintext(); } catch {}
      if (this.destroyed) return;
    }
    if (this.writable) this.end();
    this.readable = false;
    this._emitEnd();
  }

  _removeMemoryTransportListeners() {
    const transport = this._memoryTransport;
    const listeners = this._memoryTransportListeners;
    if (transport == null || listeners == null) return;
    transport.removeListener?.("data", listeners.onData);
    transport.removeListener?.("end", listeners.onEnd);
    transport.removeListener?.("close", listeners.onClose);
    transport.removeListener?.("error", listeners.onError);
    transport.removeListener?.("drain", listeners.onDrain);
    this._memoryTransportListeners = null;
  }

  _finishTlsConnect(connectedEvent) {
    this.connecting = false;
    this.secureConnecting = false;
    this._secureEstablished = true;
    this._securePending = false;
    const info = this._currentTlsInfo() ?? {};
    let authorizationError = info.verifyErrorCode
      ? tlsError(info.verifyErrorMessage || info.verifyErrorCode, info.verifyErrorCode)
      : null;
    if (!this.isServer && !authorizationError && !this._skipServerIdentity && typeof this._checkServerIdentity === "function") {
      const certificate = legacyPeerCertificate(info);
      if (certificate?.raw) {
        try {
          authorizationError = this._checkServerIdentity(this._identityHostname || this.servername || this._host || "localhost", certificate) || null;
        } catch (error) {
          authorizationError = normalizeTlsError(error);
        }
      }
    }
    this.authorized = authorizationError == null;
    this.authorizationError = authorizationError == null
      ? null
      : authorizationError.code || authorizationError.message;
    this.servername = info.servername || this.servername;
    this.alpnProtocol = info.alpnProtocol || false;
    if (authorizationError && this._rejectUnauthorized) {
      this.destroy(authorizationError);
      return;
    }
    queueMicrotask(() => {
      if (this.destroyed) return;
      this._flushTlsPendingWrites();
      if (this.destroyed) return;
      this._startTlsRead();
      if (!this.isServer && this._requestOCSP && !this._ocspResponseEmitted) {
        this._ocspResponseEmitted = true;
        this.emit("OCSPResponse", bufferFromNativeBytes(info.ocspResponse) ?? null);
      }
      this._markTlsTransportConnected();
      if (this.isServer) this.server?._onTlsSecure?.(this);
      this.emit("secure", this);
      if (!this.isServer) this.emit(connectedEvent);
      this._secureEventsEmitted = true;
      if (this._memoryTransport != null) {
        this._drainMemoryPlaintext();
        this._flushMemoryCiphertext();
        if (!this.destroyed && this._memoryTransportEndPending != null) {
          const receivedCloseNotify = this._memoryTransportEndPending;
          this._memoryTransportEndPending = null;
          this._endMemoryTransport(receivedCloseNotify);
        }
      }
      this._finishTlsWritable();
    });
  }

  _addServerContext(servername, secureContext) {
    const contextOptions = secureContext.context ?? {};
    const credentials = tlsCredentialOptions(contextOptions);
    const protocols = tlsProtocolOptions(contextOptions);
    const sessionIdContext = contextOptions.sessionIdContext == null
      ? this._sessionIdContext
      : Buffer.from(contextOptions.sessionIdContext);
    cottontail.tlsConnectionAddServerContext(
      this._tlsId,
      servername,
      credentials.cert,
      credentials.key,
      credentials.ca,
      credentials.passphrase,
      contextOptions.requestCert == null ? this._requestCert : Boolean(contextOptions.requestCert),
      contextOptions.rejectUnauthorized == null ? this._rejectUnauthorized : contextOptions.rejectUnauthorized !== false,
      contextOptions.ciphers ?? this.ciphers,
      protocols.minVersion,
      protocols.maxVersion,
      protocols.secureOptions,
      contextOptions.ticketKeys ?? this._ticketKeys,
      contextOptions.sessionTimeout ?? this._sessionTimeout,
      sessionIdContext,
    );
  }

  _rejectClientHello(error, alert = 80) {
    this._clientHelloError = normalizeTlsError(error, "TLS ClientHello callback failed");
    try {
      cottontail.tlsConnectionResolveClientHello(this._tlsId, undefined, true, alert);
    } catch (resolveError) {
      this._clientHelloError = normalizeTlsError(resolveError);
    }
    this._clientHelloHandling = false;
  }

  _handleClientHello(hello) {
    if (this._clientHelloHandling || this._tlsId == null) return;
    this._clientHelloHandling = true;
    const servername = typeof hello?.servername === "string" ? hello.servername : undefined;
    const protocols = Array.isArray(hello?.protocols) ? hello.protocols.map(String) : [];
    this.servername = servername ?? this.servername;

    let selectedProtocol;
    if (typeof this._ALPNCallback === "function" && protocols.length > 0) {
      try {
        selectedProtocol = this._ALPNCallback({ servername, protocols: [...protocols] });
      } catch (error) {
        this._rejectClientHello(error);
        return;
      }
      if (typeof selectedProtocol !== "string" || !protocols.includes(selectedProtocol)) {
        this._rejectClientHello(
          tlsError(
            `ALPN callback selected a protocol that was not offered: ${String(selectedProtocol)}`,
            "ERR_TLS_ALPN_CALLBACK_INVALID_RESULT",
          ),
          120,
        );
        return;
      }
    }

    let callbackCalled = false;
    const finish = (error, secureContext) => {
      if (callbackCalled || !this._clientHelloHandling || this._tlsId == null) return;
      callbackCalled = true;
      if (error) {
        this._rejectClientHello(error);
        return;
      }
      try {
        if (secureContext != null) {
          if (!(secureContext instanceof SecureContext)) {
            throw tlsError("Invalid SNI context", "ERR_TLS_INVALID_CONTEXT");
          }
          if (servername != null) this._addServerContext(servername, secureContext);
        }
        const selected = selectedProtocol == null ? undefined : Buffer.from(selectedProtocol);
        cottontail.tlsConnectionResolveClientHello(this._tlsId, selected, false, 0);
        this._clientHelloHandling = false;
      } catch (contextError) {
        this._rejectClientHello(contextError);
      }
    };

    if (servername != null && typeof this._SNICallback === "function") {
      try {
        this._SNICallback(servername, finish);
      } catch (error) {
        finish(error);
      }
      return;
    }
    finish(null, null);
  }

  _continueTlsHandshake(connectedEvent) {
    const startedAt = Date.now();
    const step = () => {
      this._tlsHandshakeTimer = null;
      if (this.destroyed || this._tlsId == null) return;
      try {
        if (this._clientHelloHandling) {
          if (this._handshakeTimeout > 0 && Date.now() - startedAt >= this._handshakeTimeout) {
            throw tlsError("TLS handshake timed out", "ETIMEDOUT");
          }
          this._tlsHandshakeTimer = setTimeout(step, 1);
          if (!this._refed) this._tlsHandshakeTimer.unref?.();
          return;
        }
        if (cottontail.tlsClientHandshake(this._tlsId) === true) {
          this._tlsInfo = cottontail.tlsConnectionInfo?.(this._tlsId) ?? this._tlsInfo;
          this._finishTlsConnect(connectedEvent);
          return;
        }
        const hello = cottontail.tlsConnectionClientHello?.(this._tlsId);
        if (hello != null) this._handleClientHello(hello);
        if (this._handshakeTimeout > 0 && Date.now() - startedAt >= this._handshakeTimeout) {
          const error = new Error("TLS handshake timed out");
          error.code = "ETIMEDOUT";
          throw error;
        }
        this._tlsHandshakeTimer = setTimeout(step, 1);
        if (!this._refed) this._tlsHandshakeTimer.unref?.();
      } catch (error) {
        error = this._clientHelloError ?? normalizeTlsError(error);
        this._clientHelloError = null;
        if (this.isServer && error.code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" && this._secureContext?.context?.ca != null) {
          error.code = "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
          error.message = "unable to verify the first certificate";
        }
        this.authorized = false;
        this.authorizationError = error?.message ?? String(error);
        this.connecting = false;
        this.destroy(error);
      }
    };
    this._tlsHandshakeTimer = setTimeout(step, 0);
    if (!this._refed) this._tlsHandshakeTimer.unref?.();
  }

  _currentTlsInfo() {
    if (this._tlsId != null && typeof cottontail.tlsConnectionInfo === "function") {
      const info = cottontail.tlsConnectionInfo(this._tlsId);
      if (info != null) this._tlsInfo = info;
    }
    return this._tlsInfo;
  }

  _startTlsRead() {
    if (this._tlsId == null || this._tlsListenerInstalled) return this;
    if (this._memoryTransport != null) return this;
    const listeners = installTlsEventDispatcher();
    listeners.set(this._tlsId, _wrapAsyncCallback((event) => {
      if (this.destroyed) return;
      if (event.type === "data") {
        const chunk = chunkFromBytes(event.data ?? new ArrayBuffer(0), this._encoding);
        const length = Number(chunk?.byteLength ?? chunk?.length ?? 0);
        if (length > 0) {
          this.bytesRead += length;
          this._emitData(chunk);
          this._refreshTimeout?.();
        }
        return;
      }
      if (event.type === "session") {
        const session = bufferFromNativeBytes(event.data);
        if (session != null && session.byteLength > 0) {
          this._session = session;
          this.emit("session", session);
        }
        return;
      }
      if (event.type === "secure") {
        this._handleRenegotiationSecure();
        return;
      }
      if (event.type === "writable") {
        this._tlsNativeWriteBlocked = false;
        this._tlsWriteBlocked = this._tlsTransportWriteBlocked;
        this._flushTlsPendingWrites();
        return;
      }
      if (event.type === "end") {
        if (this._tlsReadEndTimer != null) return;
        const tlsId = this._tlsId;
        this._tlsReadEndTimer = setTimeout(() => {
          this._tlsReadEndTimer = null;
          if (this.destroyed || this._tlsId !== tlsId) return;
          this.readable = false;
          listeners.delete(tlsId);
          this._tlsListenerInstalled = false;
          this._emitEnd();
          // A TLS close_notify ends both application-data directions. The
          // native reader retains its connection until this acknowledgement so
          // queued terminal events cannot race a freed SSL object.
          if (this._tlsId === tlsId) {
            try { cottontail.tlsConnectionClose(tlsId); } catch {}
            this._tlsId = null;
          }
        }, 0);
        if (!this._refed) this._tlsReadEndTimer.unref?.();
        return;
      }
      if (event.type === "error") {
        const error = new Error(event.message || "TLS read failed");
        if (event.code != null) error.code = String(event.code);
        else if (/renegotiation attack/i.test(error.message)) error.code = "ERR_TLS_SESSION_ATTACK";
        else if (/no renegotiation|renegotiation.*disabled/i.test(error.message)) error.code = "ERR_TLS_RENEGOTIATION_DISABLED";
        else if (/connection reset/i.test(error.message)) error.code = "ECONNRESET";
        else if (/broken pipe/i.test(error.message)) error.code = "EPIPE";
        if (event.errno != null) error.errno = Number(event.errno);
        this.destroy(error);
      }
    }));
    this._tlsListenerInstalled = true;
    cottontail.tlsConnectionSetRef?.(this._tlsId, this._refed);
    cottontail.tlsConnectionSetReadPaused?.(this._tlsId, this._paused);
    cottontail.tlsConnectionReadStart(this._tlsId);
    return this;
  }

  _flushTlsPendingWrites() {
    if (this.destroyed || this.secureConnecting || this._tlsId == null) return false;
    while (this._pendingWrites.length > 0) {
      const entry = this._pendingWrites[0];
      const offset = entry.offset ?? 0;
      const remaining = offset === 0 ? entry.bytes : entry.bytes.subarray(offset);
      let result;
      try {
        result = this._writeTlsChunkSome(remaining);
      } catch (error) {
        this.destroy(normalizeTlsError(error, "TLS socket write failed"));
        return false;
      }
      if (result.written < 0) {
        this.destroy(tlsError("TLS socket write failed", "EPIPE"));
        return false;
      }

      if (result.written > 0) {
        entry.offset = offset + result.written;
        this.writableLength = Math.max(0, this.writableLength - result.written);
        this._bytesDispatchedValue += result.written;
        this._refreshTimeout?.();
      }

      if ((entry.offset ?? offset) >= entry.bytes.byteLength) {
        this._pendingWrites.shift();
        if (typeof entry.callback === "function") queueMicrotask(() => entry.callback());
      }

      this._tlsNativeWriteBlocked = (entry.offset ?? offset) < entry.bytes.byteLength;
      this._tlsTransportWriteBlocked = !result.transportWritable;
      this._tlsWriteBlocked = this._tlsNativeWriteBlocked || this._tlsTransportWriteBlocked;
      if (this._tlsWriteBlocked) {
        this.writableNeedDrain = true;
        return false;
      }
    }
    if (this.writableNeedDrain && this.writableLength === 0) {
      queueMicrotask(() => {
        if (this.destroyed || this.writableLength !== 0 || !this.writableNeedDrain) return;
        this.writableNeedDrain = false;
        this.emit("drain");
      });
    }
    this._finishTlsWritable();
    return true;
  }

  _writeTlsChunkSome(bytes) {
    let written = Number(cottontail.tlsConnectionWrite(this._tlsId, bytes));
    if (!Number.isFinite(written)) written = -1;
    written = Math.trunc(written);
    if (written >= 0) written = Math.min(bytes.byteLength, written);
    const transportWritable = this._memoryTransport == null || this._flushMemoryCiphertext();
    return { written, transportWritable };
  }

  _writeBunTlsBytesSome(chunk) {
    if (this.destroyed || this.connecting || this._tlsId == null || !this.writable) return -1;
    if (this._tlsWriteBlocked) return 0;
    const bytes = bytesFrom(chunk);
    let result;
    try {
      result = this._writeTlsChunkSome(bytes);
    } catch (error) {
      queueMicrotask(() => {
        if (!this.destroyed) this.destroy(normalizeTlsError(error, "TLS socket write failed"));
      });
      return -1;
    }
    if (result.written < 0) {
      queueMicrotask(() => {
        if (!this.destroyed) this.destroy(tlsError("TLS socket write failed", "EPIPE"));
      });
      return -1;
    }
    if (result.written > 0) {
      this._bytesDispatchedValue += result.written;
      this._refreshTimeout?.();
    }
    this._tlsNativeWriteBlocked = result.written < bytes.byteLength;
    this._tlsTransportWriteBlocked = !result.transportWritable;
    this._tlsWriteBlocked = this._tlsNativeWriteBlocked || this._tlsTransportWriteBlocked;
    if (this._tlsWriteBlocked) {
      this.writableNeedDrain = true;
    }
    return result.written;
  }

  _finishTlsWritable() {
    if (!this._ending || this.secureConnecting || this._pendingWrites.length > 0 || this._finishEmitted) return;
    if (this._tlsId != null && !this._tlsShutdownSent) {
      this._tlsShutdownSent = true;
      try {
        cottontail.tlsConnectionShutdown(this._tlsId);
        if (this._memoryTransport != null) this._flushMemoryCiphertext();
      } catch {}
    }
    if (this._memoryTransport != null) {
      try { this._memoryTransport.end?.(); } catch {}
    }
    this._finishEmitted = true;
    this.emit("finish");
    this._maybeClose?.();
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (callback !== undefined && typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    if (chunk === null) throw tlsError("May not write null values to stream", "ERR_STREAM_NULL_VALUES");
    if (typeof chunk !== "string" && !(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk)) {
      throw invalidArgType("chunk", "of type string or an instance of Buffer, TypedArray, or DataView", chunk);
    }
    if (this._ending || !this.writable) {
      const error = tlsError("write after end", "ERR_STREAM_WRITE_AFTER_END");
      queueMicrotask(() => {
        callback?.(error);
        if (!this.destroyed) this.destroy(error);
      });
      return false;
    }
    if (this.destroyed || (!this.secureConnecting && this._tlsId == null)) {
      const error = tlsError("TLS socket is closed", "ERR_SOCKET_CLOSED");
      queueMicrotask(() => callback?.(error));
      return false;
    }
    const bytes = bytesFrom(chunk, encoding ?? this._defaultEncoding);
    this.writableLength += bytes.byteLength;
    this._pendingWrites.push({ bytes, callback, offset: 0 });
    const overHighWaterMark = this.writableLength >= this.writableHighWaterMark;
    if (overHighWaterMark) this.writableNeedDrain = true;
    const flushed = this.secureConnecting ? true : this._flushTlsPendingWrites();
    return flushed && !overHighWaterMark;
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (typeof callback === "function") {
      if (this._finishEmitted) queueMicrotask(callback);
      else this.once("finish", callback);
    } else if (callback !== undefined) {
      throw invalidArgType("callback", "of type function", callback);
    }
    if (this._ending) {
      if (chunk != null) this.write(chunk, encoding);
      return this;
    }
    if (chunk != null) this.write(chunk, encoding);
    this._ending = true;
    this.writable = false;
    this._flushTlsPendingWrites();
    this._finishTlsWritable();
    return this;
  }

  destroy(error = undefined) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.connecting = false;
    this.secureConnecting = false;
    this.readable = false;
    this.writable = false;
    this._hadError = Boolean(error);
    this._clearTimeoutTimer?.();
    if (this._tlsHandshakeTimer != null) {
      clearTimeout(this._tlsHandshakeTimer);
      this._tlsHandshakeTimer = null;
    }
    if (this._tlsReadEndTimer != null) {
      clearTimeout(this._tlsReadEndTimer);
      this._tlsReadEndTimer = null;
    }
    const listeners = globalThis.__cottontailTlsListeners;
    this._removeMemoryTransportListeners();
    const tlsId = this._tlsId;
    if (this._tlsId != null) {
      listeners?.delete?.(this._tlsId);
      this._tlsDestroyId = this._tlsId;
      this._tlsId = null;
    }
    this._tlsListenerInstalled = false;
    const writeError = error ?? tlsError("TLS socket is closed", "ERR_SOCKET_CLOSED");
    for (const entry of this._pendingWrites.splice(0)) queueMicrotask(() => entry.callback?.(writeError));
    this.writableLength = 0;
    if (!this._closeEmitted) {
      const hadError = Boolean(error);
      this._closeEmitted = true;
      this._tlsDestroyTimer = setTimeout(() => {
        this._tlsDestroyTimer = null;
        if (tlsId != null) {
          try { cottontail.tlsConnectionClose(tlsId); } catch {}
          this._tlsDestroyId = null;
        }
        if (this._memoryTransport && !this._memoryTransport.destroyed) {
          try { this._memoryTransport.destroy?.(error); } catch {}
        }
        if (this._parent && !this._parent._tlsDetached) {
          try { this._parent.destroy(error); } catch {}
        }
        if (error) this.emit("error", error);
        this.emit("close", hadError);
      }, 0);
      if (!this._refed) this._tlsDestroyTimer.unref?.();
    }
    return this;
  }

  setEncoding(encoding = "utf8") {
    this._encoding = String(encoding || "utf8").toLowerCase();
    return this;
  }

  pause() {
    this._paused = true;
    if (this._tlsId != null) cottontail.tlsConnectionSetReadPaused?.(this._tlsId, true);
    this._memoryTransport?.pause?.();
    return this;
  }

  resume() {
    this._paused = false;
    this._flushPendingData?.();
    if (this._tlsId != null) cottontail.tlsConnectionSetReadPaused?.(this._tlsId, false);
    this._memoryTransport?.resume?.();
    return this;
  }

  ref() {
    super.ref();
    this._tlsHandshakeTimer?.ref?.();
    this._tlsDestroyTimer?.ref?.();
    this._parent?.ref?.();
    this._memoryTransport?.ref?.();
    const tlsId = this._tlsId ?? this._tlsDestroyId;
    if (tlsId != null) cottontail.tlsConnectionSetRef?.(tlsId, true);
    return this;
  }

  unref() {
    super.unref();
    this._tlsHandshakeTimer?.unref?.();
    this._tlsDestroyTimer?.unref?.();
    this._parent?.unref?.();
    this._memoryTransport?.unref?.();
    const tlsId = this._tlsId ?? this._tlsDestroyId;
    if (tlsId != null) cottontail.tlsConnectionSetRef?.(tlsId, false);
    return this;
  }

  getCertificate() {
    return legacyCertificateFromBytes(this._currentTlsInfo()?.localCertificate);
  }
  getCipher() {
    const info = this._currentTlsInfo();
    if (!info?.cipher) return undefined;
    const version = String(info.cipher).startsWith("TLS_") ? "TLSv1/SSLv3" : info.cipherVersion ?? info.protocol ?? undefined;
    return { name: info.cipher, standardName: info.cipher, version };
  }
  getEphemeralKeyInfo() {
    if (this.isServer) return null;
    return this._currentTlsInfo()?.ephemeralKeyInfo ?? {};
  }
  getSharedSigalgs() {
    const value = this._currentTlsInfo()?.sharedSigalgs;
    return Array.isArray(value) ? [...value] : [];
  }
  getFinished() {
    const info = this._currentTlsInfo();
    if (info?.protocol === "TLSv1.3") return undefined;
    return bufferFromNativeBytes(info?.finished);
  }
  getPeerCertificate(detailed = false) {
    return legacyPeerCertificate(this._currentTlsInfo(), Boolean(detailed));
  }
  getPeerX509Certificate() {
    const certificates = peerX509CertificateChain(this._currentTlsInfo());
    if (certificates.length === 0) return undefined;
    if (certificates.length > 1) certificates[0].issuerCertificate = certificates[1];
    return certificates[0];
  }
  getX509Certificate() {
    const raw = bufferFromNativeBytes(this._currentTlsInfo()?.localCertificate);
    return raw == null || raw.byteLength === 0 ? undefined : new X509Certificate(raw);
  }
  getPeerFinished() {
    const info = this._currentTlsInfo();
    if (info?.protocol === "TLSv1.3") return undefined;
    return bufferFromNativeBytes(info?.peerFinished);
  }
  getProtocol() {
    const info = this._currentTlsInfo();
    return info?.protocol ?? null;
  }
  getOCSPResponse() {
    return bufferFromNativeBytes(this._currentTlsInfo()?.ocspResponse);
  }
  getSession() {
    return this._session ?? bufferFromNativeBytes(this._currentTlsInfo()?.session);
  }
  getTLSTicket() {
    return bufferFromNativeBytes(this._currentTlsInfo()?.tlsTicket);
  }
  isSessionReused() {
    return Boolean(this._currentTlsInfo()?.sessionReused);
  }
  setSession(session) {
    if (typeof session === "string") this._session = Buffer.from(session, "latin1");
    else {
      this._session = bufferFromNativeBytes(session);
      if (this._session == null) throw invalidArgType("session", "of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer", session);
    }
    if (this._tlsId != null) cottontail.tlsConnectionSetSession?.(this._tlsId, this._session);
    return undefined;
  }
  setServername(name) {
    if (typeof name !== "string") {
      const error = new TypeError(`The "name" argument must be of type string. Received ${name === null ? "null" : `type ${typeof name} (${String(name)})`}`);
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    if (this.isServer) {
      throw tlsError("Cannot issue SNI from a TLS server-side socket", "ERR_TLS_SNI_FROM_SERVER");
    }
    this.servername = name;
    if (this._tlsId != null) cottontail.tlsConnectionSetServername?.(this._tlsId, name);
  }
  setMaxSendFragment(size) {
    if (typeof size !== "number") {
      const error = new TypeError(`The "size" argument must be of type number. Received type ${typeof size} (${String(size)})`);
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    if (!Number.isInteger(size)) {
      const error = new RangeError(`The value of "size" is out of range. It must be an integer. Received ${String(size)}`);
      error.code = "ERR_OUT_OF_RANGE";
      throw error;
    }
    if (size < 512 || size > 16384) return false;
    this._maxSendFragment = size;
    return this._tlsId == null ? true : cottontail.tlsConnectionSetMaxSendFragment?.(this._tlsId, size) === true;
  }
  exportKeyingMaterial(length, label, context = undefined) {
    if (typeof length !== "number") throw invalidArgType("length", "of type number", length);
    if (!Number.isInteger(length) || length < 0 || length > 16 * 1024 * 1024) throw outOfRange("length", ">= 0 && <= 16777216", length);
    if (typeof label !== "string") throw invalidArgType("label", "of type string", label);
    if (context != null && !(context instanceof ArrayBuffer) && !ArrayBuffer.isView(context)) {
      throw invalidArgType("context", "an instance of Buffer, TypedArray, DataView, or ArrayBuffer", context);
    }
    if (this._tlsId == null || typeof cottontail.tlsConnectionExportKeyingMaterial !== "function") {
      throw tlsError("TLS socket is not connected", "ERR_TLS_INVALID_STATE");
    }
    const result = cottontail.tlsConnectionExportKeyingMaterial(
      this._tlsId,
      length,
      label,
      context == null ? undefined : bytesFrom(context),
    );
    return bufferFromNativeBytes(result) ?? Buffer.alloc(0);
  }
  disableRenegotiation() {
    this._renegotiationDisabled = true;
    if (this._tlsId != null) cottontail.tlsConnectionDisableRenegotiation?.(this._tlsId);
    return undefined;
  }
  enableTrace() {
    // COTTONTAIL-COMPAT: Requires a native OpenSSL message callback.
  }
  renegotiate(options = {}, callback = undefined) {
    if (options == null || typeof options !== "object") {
      throw invalidArgType("options", "of type object", options);
    }
    if (callback !== undefined && typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    if (this._renegotiationDisabled) {
      const error = tlsError("TLS session renegotiation disabled for this socket", "ERR_TLS_RENEGOTIATION_DISABLED");
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      return false;
    }
    if (this._tlsId == null || typeof cottontail.tlsConnectionRenegotiate !== "function") {
      const error = tlsError("TLS renegotiation is not supported by this transport", "ERR_TLS_RENEGOTIATION_UNSUPPORTED");
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      return false;
    }
    const requestCert = options.requestCert === undefined ? this._requestCert : Boolean(options.requestCert);
    const rejectUnauthorized = options.rejectUnauthorized === undefined
      ? this._rejectUnauthorized
      : Boolean(options.rejectUnauthorized);
    let onSecure;
    let onError;
    const cleanup = () => {
      if (onSecure) this.removeListener("secure", onSecure);
      if (onError) this.removeListener("error", onError);
    };
    if (typeof callback === "function") {
      onSecure = () => {
        cleanup();
        callback(null);
      };
      onError = (error) => {
        cleanup();
        callback(normalizeTlsError(error));
      };
      this.once("secure", onSecure);
      this.once("error", onError);
    }
    try {
      cottontail.tlsConnectionRenegotiate(this._tlsId, requestCert, rejectUnauthorized);
      if (this._memoryTransport != null) this._flushMemoryCiphertext();
      this._requestCert = requestCert;
      this._rejectUnauthorized = rejectUnauthorized;
      return true;
    } catch (error) {
      cleanup();
      if (typeof callback === "function") queueMicrotask(() => callback(normalizeTlsError(error)));
      return false;
    }
  }
}

class ServerImpl extends NetServer {
  constructor(options = {}, secureConnectionListener = undefined) {
    if (typeof options === "function") {
      secureConnectionListener = options;
      options = {};
    }
    if (options == null) options = {};
    if (typeof options !== "object") throw invalidArgType("options", "of type object", options);
    if (options.handshakeTimeout != null && (typeof options.handshakeTimeout !== "number" || !Number.isFinite(options.handshakeTimeout) || options.handshakeTimeout < 0)) {
      throw outOfRange("options.handshakeTimeout", "a non-negative finite number", options.handshakeTimeout);
    }
    if (options.SNICallback != null && typeof options.SNICallback !== "function") throw invalidArgType("options.SNICallback", "of type function", options.SNICallback);
    if (options.ALPNCallback != null && typeof options.ALPNCallback !== "function") throw invalidArgType("options.ALPNCallback", "of type function", options.ALPNCallback);
    if (options.ALPNCallback != null && options.ALPNProtocols != null) {
      throw tlsError("ALPNCallback and ALPNProtocols are mutually exclusive", "ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS");
    }
    const ticketKeys = options.ticketKeys == null
      ? Buffer.from(randomBytes(48))
      : validateTicketKeys(options.ticketKeys, "options.ticketKeys");
    const sessionTimeout = options.sessionTimeout == null ? 300 : validateSessionTimeout(options.sessionTimeout);
    const sessionIdContext = options.sessionIdContext == null
      ? serverSessionIdContext()
      : validateSessionIdContext(options.sessionIdContext);
    super(options);
    this._tlsOptions = {};
    this._tlsContexts = new Map();
    this._tlsServerId = null;
    this._tlsAcceptTimer = null;
    this._tlsAddress = null;
    this._secureContext = null;
    this._requestCert = false;
    this._rejectUnauthorized = rejectUnauthorizedDefault;
    this._ticketKeys = ticketKeys;
    this._sessionTimeout = sessionTimeout;
    this._sessionIdContext = Buffer.from(sessionIdContext);
    this.setSecureContext(options);
    if (typeof secureConnectionListener === "function") this.on("secureConnection", secureConnectionListener);
  }

  setSecureContext(options = {}) {
    const secureContext = options instanceof SecureContext ? options : createSecureContext(options);
    const context = secureContext.context ?? {};
    const merged = { ...this._tlsOptions, ...context };
    if (merged.ALPNCallback != null && merged.ALPNProtocols != null) {
      throw tlsError("ALPNCallback and ALPNProtocols are mutually exclusive", "ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS");
    }
    if (context.ticketKeys != null) this._ticketKeys = validateTicketKeys(context.ticketKeys, "options.ticketKeys");
    if (context.sessionTimeout != null) this._sessionTimeout = validateSessionTimeout(context.sessionTimeout);
    if (context.sessionIdContext != null) {
      this._sessionIdContext = Buffer.from(validateSessionIdContext(context.sessionIdContext));
    }
    this._secureContext = secureContext;
    this._tlsOptions = {
      ...merged,
      secureContext,
      ticketKeys: Buffer.from(this._ticketKeys),
      sessionTimeout: this._sessionTimeout,
      sessionIdContext: this._sessionIdContext.toString(),
    };
    this.key = context.key;
    this.cert = context.cert;
    this.ca = context.ca;
    this.passphrase = context.passphrase;
    this.secureOptions = context.secureOptions ?? 0;
    this.servername = context.servername;
    this.ALPNProtocols = merged.ALPNProtocols;
    this.ALPNCallback = merged.ALPNCallback;
    this.SNICallback = merged.SNICallback;
    this._requestCert = Boolean(merged.requestCert);
    this._rejectUnauthorized = merged.rejectUnauthorized == null ? rejectUnauthorizedDefault : merged.rejectUnauthorized !== false;
    return this;
  }

  addContext(hostname, context) {
    if (typeof hostname !== "string") throw invalidArgType("hostname", "of type string", hostname);
    const secureContext = context instanceof SecureContext ? context : createSecureContext(context);
    this._tlsContexts.set(hostname, secureContext);
    return undefined;
  }

  _createAcceptedSocket(_accepted, socketOptions) {
    const parentSocket = new Socket({ ...socketOptions, pauseOnConnect: true });
    let socket;
    try {
      socket = _upgradeServerSocket(parentSocket, {
        ...this._tlsOptions,
        isServer: true,
        contexts: this._tlsContexts,
      });
    } catch (error) {
      error = normalizeTlsError(error);
      parentSocket?.destroy?.();
      this.emit("tlsClientError", error, parentSocket);
      return null;
    }
    socket.server = this;
    const onError = (error) => {
      if (!socket._secureEventsEmitted) this.emit("tlsClientError", error, socket);
    };
    socket.on("error", onError);
    socket._tlsServerErrorListener = onError;
    return socket;
  }

  _onTlsSecure(socket) {
    if (socket._tlsSecureConnectionEmitted) return;
    socket._tlsSecureConnectionEmitted = true;
    if (socket._tlsServerErrorListener) socket.removeListener("error", socket._tlsServerErrorListener);
    this.emit("secureConnection", socket);
  }

  _acceptTls() {
    if (!this.listening || this._tlsServerId == null) return;
    for (;;) {
      if (!this.listening || this._tlsServerId == null) return;
      let accepted;
      try {
        accepted = cottontail.tlsServerAccept(this._tlsServerId);
      } catch (error) {
        this.emit("tlsClientError", normalizeTlsError(error));
        return;
      }
      if (accepted == null) return;
      let socket;
      try {
        socket = new TLSSocket(undefined, { ...this._tlsOptions, isServer: true });
        socket.server = this;
        socket._attachNative(accepted, "secureConnect");
      } catch (error) {
        try { cottontail.tlsConnectionClose?.(accepted.id); } catch {}
        this.emit("tlsClientError", normalizeTlsError(error));
        continue;
      }
      const onError = (error) => {
        if (!socket._secureEventsEmitted) this.emit("tlsClientError", error, socket);
      };
      socket.on("error", onError);
      socket._tlsServerErrorListener = onError;
      this._incrementConnections();
      socket.once("close", () => this._decrementConnections());
      this.emit("connection", socket);
    }
  }

  listen(...args) {
    const first = args?.[0];
    if (first !== null && typeof first === "object" && !Array.isArray(first)) {
      if (first.port === undefined && first.path == null && first.fd == null) {
        const error = new TypeError(`The argument 'options' must have the property "port" or "path". Received ${JSON.stringify(first)}`);
        error.code = "ERR_INVALID_ARG_VALUE";
        throw error;
      }
    }
    const [listenOptions, callback] = normalizeListenArgs(args);
    if (listenOptions.port !== undefined && listenOptions.path == null) {
      const port = Number(listenOptions.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        const error = new RangeError(`options.port should be >= 0 and < 65536. Received type ${typeof listenOptions.port} (${listenOptions.port}).`);
        error.code = "ERR_SOCKET_BAD_PORT";
        throw error;
      }
    }
    try {
      validateNativeServerContext(this._tlsOptions);
    } catch (error) {
      queueMicrotask(() => this.emit("error", normalizeTlsError(error)));
      return this;
    }
    return super.listen(listenOptions, callback);
  }

  close(callback = undefined) {
    if (this._tlsServerId == null) return super.close(callback);
    if (callback !== undefined && typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    if (callback) this.once("close", callback);
    this._closePending = true;
    if (this._tlsAcceptTimer != null) {
      clearInterval(this._tlsAcceptTimer);
      this._tlsAcceptTimer = null;
    }
    try { cottontail.tlsServerClose(this._tlsServerId); } catch {}
    this._tlsServerId = null;
    this._tlsAddress = null;
    this.listening = false;
    this._emitCloseIfDrained();
    return this;
  }

  address() {
    return this._tlsServerId != null && this.listening ? this._tlsAddress : super.address();
  }

  ref() {
    this._tlsAcceptTimer?.ref?.();
    return super.ref();
  }

  unref() {
    this._tlsAcceptTimer?.unref?.();
    return super.unref();
  }


  getTicketKeys() {
    return Buffer.from(this._ticketKeys);
  }

  setTicketKeys(keys) {
    this._ticketKeys = validateTicketKeys(keys);
    this._tlsOptions.ticketKeys = Buffer.from(this._ticketKeys);
    for (const socket of this._activeSockets) {
      socket._ticketKeys = Buffer.from(this._ticketKeys);
      if (socket._tlsId != null) cottontail.tlsConnectionSetTicketKeys?.(socket._tlsId, this._ticketKeys);
    }
    return undefined;
  }
}

Object.defineProperty(ServerImpl, "name", { value: "Server", configurable: true });
Object.defineProperty(ServerImpl, "length", { value: 2, configurable: true });
export const Server = new Proxy(ServerImpl, {
  apply(target, _thisArg, args) {
    return Reflect.construct(target, args);
  },
});

export function connect(...args) {
  const [options, callback] = normalizeConnectArgs(args);
  validateCiphers(options.ciphers);
  const protocolOptions = tlsProtocolOptions(options);
  if (options.servername != null && typeof options.servername !== "string") throw invalidArgType("options.servername", "of type string", options.servername);
  if (options.servername && isIP(options.servername)) {
    throw invalidArgValue("options.servername", options.servername, "Setting the TLS ServerName to an IP address is not permitted");
  }
  if (options.checkServerIdentity != null && typeof options.checkServerIdentity !== "function") {
    throw invalidArgType("options.checkServerIdentity", "of type function", options.checkServerIdentity);
  }
  const alpnProtocols = prepareALPNProtocols(options.ALPNProtocols);
  let parentSocket = options.socket;
  if (parentSocket != null && (typeof parentSocket !== "object" || typeof parentSocket.on !== "function" || typeof parentSocket.write !== "function")) {
    throw invalidArgType("options.socket", "a Duplex stream", parentSocket);
  }
  const socket = new TLSSocket(parentSocket, options);
  const host = options.host ?? options.hostname ?? parentSocket?._host ?? parentSocket?.remoteAddress ?? "localhost";
  const defaultServername = isIP(String(host)) ? "" : String(host);
  const servername = options.servername ?? defaultServername;
  socket.servername = options.servername || undefined;
  socket._host = String(host);
  socket._identityHostname = options.servername;
  socket._skipServerIdentity = options.skipServerIdentity === true || options.servername == null;
  if (options.timeout != null) socket.setTimeout(options.timeout);
  socket[bunTlsConnectOptions] = {
    serverName: options.servername ?? String(host),
    servername,
    rejectUnauthorized: socket._rejectUnauthorized,
    requestCert: options.requestCert !== false,
    checkServerIdentity: options.checkServerIdentity ?? checkServerIdentity,
    session: options.session ?? null,
  };
  if (typeof callback === "function") socket.once("secureConnect", callback);

  if (!socket._rejectUnauthorized && options.rejectUnauthorized == null && !rejectUnauthorizedDefault && !rejectUnauthorizedWarningEmitted) {
    rejectUnauthorizedWarningEmitted = true;
    process.emitWarning?.(
      "Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification.",
      "Warning",
    );
  }

  const fail = (error) => {
    if (socket.destroyed) return;
    socket.authorized = false;
    socket.authorizationError = error?.message ?? String(error);
    socket.connecting = false;
    socket.destroy(error instanceof Error ? error : new Error(String(error)));
  };

  const upgrade = () => {
    parentSocket?.removeListener?.("error", fail);
    parentSocket?.removeListener?.("close", onParentClose);
    try {
      const credentials = tlsCredentialOptions(options);
      if (parentSocket?.encrypted !== true && typeof parentSocket?._detachFdForTls === "function" && typeof cottontail.tlsClientConnectFd === "function") {
        const fd = parentSocket._detachFdForTls();
        const native = cottontail.tlsClientConnectFd(
          fd,
          servername,
          socket._rejectUnauthorized,
          credentials.ca,
          credentials.cert,
          credentials.key,
          credentials.passphrase,
          alpnProtocols,
          options.ciphers,
          protocolOptions.minVersion,
          protocolOptions.maxVersion,
          protocolOptions.secureOptions,
          socket._session,
          socket._requestOCSP,
        );
        socket._attachNative(native, "secureConnect");
        return;
      }
      if (typeof parentSocket?.on === "function" && typeof parentSocket?.write === "function" &&
          typeof cottontail.tlsClientConnectMemory === "function") {
        const native = cottontail.tlsClientConnectMemory(
          servername,
          socket._rejectUnauthorized,
          credentials.ca,
          credentials.cert,
          credentials.key,
          credentials.passphrase,
          alpnProtocols,
          options.ciphers,
          protocolOptions.minVersion,
          protocolOptions.maxVersion,
          protocolOptions.secureOptions,
          socket._session,
          socket._requestOCSP,
        );
        socket._attachMemoryTransport(native, parentSocket, "secureConnect");
        return;
      }
      const error = new TypeError('The "options.socket" property must be a Duplex stream');
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    } catch (error) {
      fail(error);
    }
  };

  if (parentSocket == null) {
    const transportOptions = { ...options, host: options.host ?? options.hostname ?? "localhost" };
    delete transportOptions.socket;
    delete transportOptions.signal;
    if (options.path != null) {
      delete transportOptions.host;
      delete transportOptions.port;
      transportOptions.path = options.path;
    }
    parentSocket = netConnect(transportOptions);
    socket._parent = parentSocket;
  }
  const onParentClose = () => {
    if (socket.secureConnecting && !socket.destroyed) fail(tlsError("Client network socket disconnected before secure TLS connection was established", "ECONNRESET"));
  };
  parentSocket.once("error", fail);
  parentSocket.once("close", onParentClose);
  if (parentSocket.connecting) parentSocket.once("connect", upgrade);
  else queueMicrotask(upgrade);
  return socket;
}

// Internal entry point for Bun's in-place Socket.upgradeTLS(). Unlike
// connect(), validation and memory-BIO setup happen synchronously so invalid
// TLS material can be reported from upgradeTLS() before it returns.
export function _connectMemoryTransport(parentSocket, options = {}) {
  if (parentSocket == null || typeof parentSocket !== "object" ||
      typeof parentSocket.on !== "function" || typeof parentSocket.write !== "function") {
    throw invalidArgType("parentSocket", "a Duplex stream", parentSocket);
  }
  if (options == null || typeof options !== "object") {
    throw invalidArgType("options", "of type object", options);
  }

  validateCiphers(options.ciphers);
  const protocolOptions = tlsProtocolOptions(options);
  if (options.servername != null && typeof options.servername !== "string") {
    throw invalidArgType("options.servername", "of type string", options.servername);
  }
  if (options.servername && isIP(options.servername)) {
    throw invalidArgValue("options.servername", options.servername, "Setting the TLS ServerName to an IP address is not permitted");
  }
  if (options.checkServerIdentity != null && typeof options.checkServerIdentity !== "function") {
    throw invalidArgType("options.checkServerIdentity", "of type function", options.checkServerIdentity);
  }

  const alpnProtocols = prepareALPNProtocols(options.ALPNProtocols);
  const socket = new TLSSocket(parentSocket, options);
  const host = options.host ?? options.hostname ?? parentSocket?._host ?? parentSocket?.remoteAddress ?? "localhost";
  const defaultServername = isIP(String(host)) ? "" : String(host);
  const servername = options.servername ?? defaultServername;
  socket.servername = options.servername || undefined;
  socket._host = String(host);
  socket._identityHostname = options.servername;
  socket._skipServerIdentity = options.skipServerIdentity === true || options.servername == null;
  if (options.timeout != null) socket.setTimeout(options.timeout);
  socket[bunTlsConnectOptions] = {
    serverName: options.servername ?? String(host),
    servername,
    rejectUnauthorized: socket._rejectUnauthorized,
    requestCert: options.requestCert !== false,
    checkServerIdentity: options.checkServerIdentity ?? checkServerIdentity,
    session: options.session ?? null,
  };

  const credentials = tlsCredentialOptions(options);
  const native = cottontail.tlsClientConnectMemory(
    servername,
    socket._rejectUnauthorized,
    credentials.ca,
    credentials.cert,
    credentials.key,
    credentials.passphrase,
    alpnProtocols,
    options.ciphers,
    protocolOptions.minVersion,
    protocolOptions.maxVersion,
    protocolOptions.secureOptions,
    socket._session,
    socket._requestOCSP,
  );
  socket._attachMemoryTransport(native, parentSocket, "secureConnect");
  return socket;
}

export function _upgradeServerSocket(parentSocket, options = {}) {
  if (typeof parentSocket?._detachFdForTls !== "function" || typeof cottontail.tlsServerUpgradeFd !== "function") {
    const error = new TypeError("The socket must be a connected Cottontail net.Socket");
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  const credentials = tlsCredentialOptions(options);
  const alpnProtocols = prepareALPNProtocols(options.ALPNProtocols);
  const protocolOptions = tlsProtocolOptions(options);
  validateNativeServerContext(options, credentials, protocolOptions);
  const contexts = [];
  if (options.contexts && typeof options.SNICallback !== "function") {
    for (const [hostname, secureContext] of options.contexts) {
      const contextOptions = secureContext instanceof SecureContext ? secureContext.context : secureContext;
      contexts.push({
        hostname,
        options: contextOptions,
        credentials: tlsCredentialOptions(contextOptions),
        protocols: tlsProtocolOptions(contextOptions),
      });
    }
  }
  const socket = new TLSSocket(parentSocket, options);
  const fd = parentSocket._detachFdForTls();
  const rejectUnauthorized = options.rejectUnauthorized == null ? rejectUnauthorizedDefault : options.rejectUnauthorized !== false;
  const native = cottontail.tlsServerUpgradeFd(
    fd,
    credentials.cert,
    credentials.key,
    credentials.passphrase,
    alpnProtocols,
    credentials.ca,
    Boolean(options.requestCert),
    rejectUnauthorized,
    options.ciphers,
    protocolOptions.minVersion,
    protocolOptions.maxVersion,
    protocolOptions.secureOptions,
    typeof options.SNICallback === "function" || typeof options.ALPNCallback === "function",
    typeof options.ALPNCallback === "function",
    options.ticketKeys,
    options.sessionTimeout,
    socket._sessionIdContext,
    CLIENT_RENEG_LIMIT,
    CLIENT_RENEG_WINDOW,
  );
  try {
    if (typeof cottontail.tlsConnectionAddServerContext === "function") {
      for (const context of contexts) {
        cottontail.tlsConnectionAddServerContext(
          native.id,
          context.hostname,
          context.credentials.cert,
          context.credentials.key,
          context.credentials.ca,
          context.credentials.passphrase,
          context.options?.requestCert == null ? Boolean(options.requestCert) : Boolean(context.options.requestCert),
          context.options?.rejectUnauthorized == null ? rejectUnauthorized : context.options.rejectUnauthorized !== false,
          context.options?.ciphers ?? options.ciphers,
          context.protocols.minVersion,
          context.protocols.maxVersion,
          context.protocols.secureOptions,
          context.options?.ticketKeys ?? options.ticketKeys,
          context.options?.sessionTimeout ?? options.sessionTimeout,
          context.options?.sessionIdContext == null
            ? socket._sessionIdContext
            : Buffer.from(context.options.sessionIdContext),
        );
      }
    }
  } catch (error) {
    try { cottontail.tlsConnectionClose(native.id); } catch {}
    throw error;
  }
  parentSocket._tlsOwner = socket;
  socket.once("close", (hadError) => {
    parentSocket._tlsOwner = null;
    if (!parentSocket._tlsCloseEmitted) {
      parentSocket._tlsCloseEmitted = true;
      parentSocket.emit("close", Boolean(hadError));
    }
  });
  return socket._attachNative(native, "secureConnect");
}

export function createServer(options = {}, secureConnectionListener = undefined) {
  return new Server(options, secureConnectionListener);
}

export function convertALPNProtocols(protocols, out = {}) {
  let bytes;
  if (ArrayBuffer.isView(protocols) || protocols instanceof ArrayBuffer) {
    bytes = Buffer.from(protocols);
  } else if (Array.isArray(protocols)) {
    const chunks = [];
    for (let index = 0; index < protocols.length; index += 1) {
      const protocol = protocols[index];
      if (typeof protocol !== "string") throw invalidArgType(`protocols[${index}]`, "of type string", protocol);
      const item = Buffer.from(protocol);
      if (item.byteLength === 0) throw invalidArgValue(`protocols[${index}]`, protocol, "must not be empty");
      if (item.byteLength > 255) {
        throw new RangeError(`The byte length of the protocol at index ${index} exceeds the maximum length. It must be <= 255. Received ${item.byteLength}`);
      }
      chunks.push(Buffer.from([item.byteLength]), item);
    }
    bytes = Buffer.concat(chunks);
  } else {
    throw invalidArgType("protocols", "an instance of Array, Buffer, TypedArray, DataView, or ArrayBuffer", protocols);
  }
  out.ALPNProtocols = bytes;
}

function prepareALPNProtocols(protocols) {
  if (protocols == null) return undefined;
  const out = {};
  convertALPNProtocols(protocols, out);
  return out.ALPNProtocols;
}

function immutableCertificateArray(certificates) {
  const target = Object.freeze(uniqueCertificates(certificates));
  return new Proxy(target, {
    set: readonlyRootCertificates,
    defineProperty: readonlyRootCertificates,
    deleteProperty: readonlyRootCertificates,
    setPrototypeOf: readonlyRootCertificates,
  });
}

function readonlyRootCertificates() {
  throw new TypeError("Attempted to assign to readonly property.");
}

function invalidCAArgument(name, value, expected) {
  const error = new TypeError(`The "${name}" argument must be ${expected}. Received ${value === null ? "null" : typeof value}`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function validatedCACertificates(certs) {
  if (!Array.isArray(certs)) throw invalidCAArgument("certs", certs, "an instance of Array");
  const certificates = [];
  for (let index = 0; index < certs.length; index += 1) {
    const value = certs[index];
    if (typeof value !== "string" && !ArrayBuffer.isView(value)) {
      throw invalidCAArgument(`certs[${index}]`, value, "of type string or an instance of ArrayBufferView");
    }
    const text = typeof value === "string" ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString();
    const parsed = parsePemCertificates(text, true);
    for (const certificate of parsed) {
      try {
        new X509Certificate(certificate);
      } catch (cause) {
        const error = new Error(cause?.message || "Failed to parse CA certificate");
        error.code = cause?.code || "ERR_OSSL_PEM_BAD_BASE64_DECODE";
        throw error;
      }
      certificates.push(certificate);
    }
  }
  if (certs.length > 0 && certificates.length === 0) {
    const error = new Error("No valid certificates found in the provided array");
    error.code = "ERR_CRYPTO_OPERATION_FAILED";
    throw error;
  }
  return uniqueCertificates(certificates);
}

function warnExtraCA(path, reason) {
  const message = `Warning: ignoring extra certs from \`${path}\`, load failed: ${reason}`;
  if (typeof process._rawDebug === "function") process._rawDebug(message);
  else cottontail.fdWrite?.(2, `${message}\n`);
}

function validateExtraCACertificate(certificate) {
  const parsed = new X509Certificate(certificate);
  const payload = String(certificate)
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s/g, "");
  const decoded = Buffer.from(payload, "base64");
  const raw = Buffer.from(parsed.raw);
  if (decoded.byteLength !== raw.byteLength || !decoded.equals(raw)) {
    const error = new Error("PEM certificate contains invalid DER data");
    error.code = "ERR_OSSL_PEM_BAD_BASE64_DECODE";
    throw error;
  }
}

function loadExtraCACertificates() {
  const path = String(process.env.NODE_EXTRA_CA_CERTS ?? "");
  if (!path) return [];
  let text;
  try {
    text = cottontail.readFile(path);
  } catch (error) {
    warnExtraCA(path, error?.message || String(error));
    return [];
  }

  const parsed = parsePemCertificates(text, true);
  if (parsed.length === 0) {
    warnExtraCA(path, "no certificate or CRL found");
    return [];
  }
  const certificates = [];
  for (const certificate of parsed) {
    try {
      validateExtraCACertificate(certificate);
      certificates.push(certificate);
    } catch (error) {
      warnExtraCA(path, error?.message || String(error));
      return [];
    }
  }
  return uniqueCertificates(certificates);
}

export const rootCertificates = immutableCertificateArray(systemRootCertificates());
const systemCACertificates = immutableCertificateArray(rootCertificates);
const extraCACertificates = immutableCertificateArray(loadExtraCACertificates());
let defaultCACertificates = immutableCertificateArray([...rootCertificates, ...extraCACertificates]);
let defaultCACertificatesWasSet = false;

export function getCACertificates(type = "default") {
  const normalized = String(type ?? "default");
  if (normalized === "default") return defaultCACertificates;
  if (normalized === "bundled") return rootCertificates;
  if (normalized === "system") return systemCACertificates;
  if (normalized === "extra") return extraCACertificates;
  throw new TypeError(`Unknown CA certificate type: ${type}`);
}

export function setDefaultCACertificates(certs) {
  defaultCACertificates = immutableCertificateArray(validatedCACertificates(certs));
  defaultCACertificatesWasSet = true;
}

const defaultCipherNames = defaultCipherList();

export function getCiphers() {
  return [...defaultCipherNames];
}

// COTTONTAIL-COMPAT: OpenSSL trace output, OCSP stapling callbacks, and custom
// server-side newSession/resumeSession stores are not exposed by the stock-JSC host boundary yet.

const tlsDefault = {
  CLIENT_RENEG_LIMIT,
  CLIENT_RENEG_WINDOW,
  DEFAULT_CIPHERS,
  DEFAULT_ECDH_CURVE,
  DEFAULT_MAX_VERSION,
  DEFAULT_MIN_VERSION,
  SecureContext,
  Server,
  TLSSocket,
  checkServerIdentity,
  connect,
  convertALPNProtocols,
  createSecureContext,
  createServer,
  getCACertificates,
  getCiphers,
  setDefaultCACertificates,
};

// Node exposes rootCertificates as a frozen array behind a read-only property.
Object.defineProperty(tlsDefault, "rootCertificates", {
  get: () => rootCertificates,
  set: readonlyRootCertificates,
  configurable: false,
  enumerable: true,
});

function lockRootCertificatesExport(namespace) {
  if (namespace == null || (typeof namespace !== "object" && typeof namespace !== "function")) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(namespace, "rootCertificates");
    if (descriptor?.configurable === false) return namespace.rootCertificates === rootCertificates;
    Object.defineProperty(namespace, "rootCertificates", {
      get: () => rootCertificates,
      set: readonlyRootCertificates,
      configurable: false,
      enumerable: true,
    });
    return true;
  } catch {
    return false;
  }
}

function installRootCertificatesExportLock() {
  const modules = globalThis.__cottontailBuiltinModules ??= new Map();
  if (lockRootCertificatesExport(modules.get("tls") ?? modules.get("node:tls"))) return;

  // Embedded modules are initialized before the builtin registry is filled.
  // Lock the generated namespace at the point where the registry receives it.
  const previousOwnDescriptor = Object.getOwnPropertyDescriptor(modules, "set");
  const originalSet = modules.set;
  Object.defineProperty(modules, "set", {
    configurable: true,
    writable: true,
    value(name, namespace) {
      const result = Reflect.apply(originalSet, this, [name, namespace]);
      if ((name === "tls" || name === "node:tls") && lockRootCertificatesExport(namespace)) {
        if (previousOwnDescriptor) Object.defineProperty(this, "set", previousOwnDescriptor);
        else delete this.set;
      }
      return result;
    },
  });
}

installRootCertificatesExportLock();

export default tlsDefault;
