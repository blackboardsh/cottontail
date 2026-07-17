import { Buffer } from "./buffer.js";
import { _wrapAsyncCallback } from "./async_hooks.js";
import { X509Certificate, createHash, createDecipheriv } from "./crypto.js";
import { connect as netConnect, isIP, Server as NetServer, Socket } from "./net.js";

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

function normalizeCertificateLabels(value) {
  return String(value ?? "")
    .replace(/-----BEGIN (?:X509 |TRUSTED )CERTIFICATE-----/g, "-----BEGIN CERTIFICATE-----")
    .replace(/-----END (?:X509 |TRUSTED )CERTIFICATE-----/g, "-----END CERTIFICATE-----");
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
  return list.flatMap((cert) => parsePemCertificates(cert));
}

function installTlsEventDispatcher() {
  const listeners = globalThis.__cottontailTlsListeners ??= new Map();
  if (!globalThis.__cottontailFdWatchHandlerInstalled && typeof cottontail.fdSetEventHandler === "function") {
    globalThis.__cottontailFdWatchHandlerInstalled = true;
    cottontail.fdSetEventHandler((event) => {
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
  } else {
    options.port = list[0];
    if (typeof list[1] === "string") {
      options.host = list[1];
      if (typeof list[2] === "object" && list[2] !== null) options = { ...list[2], ...options };
    } else if (typeof list[1] === "object" && list[1] !== null) {
      options = { ...list[1], ...options };
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
  const text = Array.isArray(value) ? value.map(String).join("\n") : String(value);
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
  const passphraseOption = options?.passphrase ?? context.passphrase;
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
    key: prepareTlsKey(options?.key ?? context.key, passphrase),
    passphrase,
  };
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
  return encoding ? new TextDecoder().decode(view) : Buffer.from(view);
}

function bufferFromNativeBytes(bytes) {
  if (bytes == null) return undefined;
  if (bytes instanceof ArrayBuffer) return Buffer.from(new Uint8Array(bytes));
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return undefined;
}

function legacyCertificateFromBytes(bytes) {
  const raw = bufferFromNativeBytes(bytes);
  if (raw == null || raw.byteLength === 0) return {};
  try {
    return new X509Certificate(raw).toLegacyObject();
  } catch {
    return { raw };
  }
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
  if (!detailed) return certificates[0].toLegacyObject();

  const legacy = certificates.map((certificate) => certificate.toLegacyObject());
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

function dnsNames(cert) {
  return String(cert?.subjectaltname ?? "")
    .split(/\s*,\s*/)
    .filter((item) => item.toUpperCase().startsWith("DNS:"))
    .map((item) => item.slice(4).trim())
    .filter(Boolean);
}

function ipNames(cert) {
  return String(cert?.subjectaltname ?? "")
    .split(/\s*,\s*/)
    .filter((item) => item.toUpperCase().startsWith("IP ADDRESS:"))
    .map((item) => item.slice("IP Address:".length).trim())
    .filter(Boolean);
}

function commonNames(cert) {
  const cn = cert?.subject?.CN;
  if (Array.isArray(cn)) return cn.map(String);
  return cn == null ? [] : [String(cn)];
}

function matchDnsName(host, pattern) {
  const hostname = String(host).toLowerCase();
  const candidate = String(pattern).toLowerCase();
  if (candidate === hostname) return true;
  if (!candidate.startsWith("*.")) return false;
  const suffix = candidate.slice(1);
  return hostname.endsWith(suffix) && hostname.slice(0, -suffix.length).indexOf(".") === -1;
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
  const hostname = String(host);
  if (isIP(hostname)) {
    const ips = ipNames(cert);
    if (ips.includes(hostname)) return undefined;
    return altNameError(hostname, cert, `IP: ${hostname} is not in the cert's list: ${ips.join(", ")}`);
  }

  const names = dnsNames(cert);
  if (names.length > 0) {
    if (names.some((name) => matchDnsName(hostname, name))) return undefined;
    return altNameError(hostname, cert, `Host: ${hostname}. is not in the cert's altnames: ${String(cert?.subjectaltname ?? "")}`);
  }

  const cns = commonNames(cert);
  if (cns.some((name) => matchDnsName(hostname, name))) return undefined;
  return altNameError(hostname, cert, `Host: ${hostname}. is not cert's CN: ${cns.join(", ")}`);
}

export class SecureContext {
  constructor(options = {}) {
    validateCiphers(options?.ciphers);
    this.context = {
      ...options,
      ca: options.ca == null ? undefined : normalizeCertificates(options.ca),
      cert: options.cert == null ? undefined : normalizeCertificates(options.cert),
    };
  }
}

export function createSecureContext(options = {}) {
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
    super({});
    this.encrypted = true;
    this.authorized = false;
    this.authorizationError = null;
    this.alpnProtocol = false;
    this.servername = options?.servername;
    this._parent = socket;
    this._secureContext = options?.secureContext ?? createSecureContext(options ?? {});
    this._tlsId = null;
    this._tlsInfo = null;
    this._encoding = null;
    this._tlsListenerInstalled = false;
    this._tlsHandshakeTimer = null;
    this._memoryTransport = null;
    this._memoryTransportListeners = null;
    this._memoryTransportEnded = false;
    this._memoryTransportEndPending = null;
    this._secureEventsEmitted = false;
    this._session = bufferFromNativeBytes(options?.session);
    this._renegotiationDisabled = false;
    this._rejectUnauthorized = options?.rejectUnauthorized !== false;
    this._requestCert = options?.requestCert !== false;
    this._checkServerIdentity = options?.checkServerIdentity ?? checkServerIdentity;
    this.isServer = options?.isServer === true;
    this.secureConnecting = true;
    this._secureEstablished = false;
    this._securePending = true;
    if (socket && typeof socket === "object" && typeof socket._detachFdForTls !== "function") {
      this._handle = socket;
      try { socket._parentWrap = this; } catch {}
    }
    // Node's TLSSocket always disables half-open, ignoring the option.
    this.allowHalfOpen = false;
    this.connecting = true;
  }

  _attachNative(native, connectedEvent = "secureConnect") {
    this._tlsId = Number(native.id);
    this.fd = Number(native.fd ?? -1);
    this._tlsInfo = native;
    this.destroyed = false;
    this.readable = true;
    this.writable = true;
    this._setAddressInfo(native.local, native.remote);
    if (native.pending === true) {
      this.connecting = true;
      this.authorized = false;
      this._continueTlsHandshake(connectedEvent);
      return this;
    }
    this._finishTlsConnect(connectedEvent);
    return this;
  }

  _attachMemoryTransport(native, transport, connectedEvent = "secureConnect") {
    this._tlsId = Number(native.id);
    this.fd = -1;
    this._tlsInfo = native;
    this._memoryTransport = transport;
    this.destroyed = false;
    this.readable = true;
    this.writable = true;
    const onData = (chunk) => {
      if (this.destroyed || this._tlsId == null) return;
      try {
        cottontail.tlsConnectionFeedMemory(this._tlsId, bytesFrom(chunk));
        this._refreshTimeout?.();
        if (this.connecting) this._driveMemoryHandshake(connectedEvent);
        else if (this._secureEventsEmitted) {
          this._drainMemoryPlaintext();
          this._flushMemoryCiphertext();
        }
      } catch (error) {
        this.destroy(normalizeTlsError(error));
      }
    };
    const onEnd = () => this._endMemoryTransport();
    const onClose = () => this._endMemoryTransport();
    const onError = (error) => this.destroy(normalizeTlsError(error));
    const onDrain = () => this.emit("drain");
    this._memoryTransportListeners = { onData, onEnd, onClose, onError, onDrain };
    transport.on("data", onData);
    transport.once("end", onEnd);
    transport.once("close", onClose);
    transport.once("error", onError);
    transport.on("drain", onDrain);
    this._tlsHandshakeTimer = setTimeout(() => {
      if (!this.connecting || this.destroyed) return;
      const error = tlsError("TLS handshake timed out", "ETIMEDOUT");
      this.destroy(error);
    }, 10000);
    this._driveMemoryHandshake(connectedEvent);
    return this;
  }

  _driveMemoryHandshake(connectedEvent) {
    if (this.destroyed || this._tlsId == null || !this.connecting) return;
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

  _drainMemoryPlaintext() {
    if (this._tlsId == null || this._memoryTransport == null || this.connecting) return;
    const result = cottontail.tlsConnectionReadMemory(this._tlsId);
    const chunk = bufferFromNativeBytes(result?.data);
    if (chunk != null && chunk.byteLength > 0) {
      this.bytesRead += chunk.byteLength;
      this._emitData(this._encoding ? chunk.toString(this._encoding) : chunk);
      this._refreshTimeout?.();
    }
    if (result?.error) {
      const error = tlsError(String(result.error), result.code);
      this.destroy(error);
      return;
    }
    if (result?.ended) this._endMemoryTransport(true);
  }

  _endMemoryTransport(receivedCloseNotify = false) {
    if (this._memoryTransportEnded || this.destroyed) return;
    if (!this.connecting && !this._secureEventsEmitted) {
      this._memoryTransportEndPending = Boolean(receivedCloseNotify || this._memoryTransportEndPending);
      return;
    }
    this._memoryTransportEnded = true;
    if (this.connecting) {
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
    if (!this.isServer && !authorizationError && typeof this._checkServerIdentity === "function") {
      const certificate = legacyPeerCertificate(info);
      if (certificate?.raw) {
        try {
          authorizationError = this._checkServerIdentity(this.servername || this._host || "localhost", certificate) || null;
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
    this.alpnProtocol = this._tlsInfo?.alpnProtocol || false;
    if (authorizationError && this._rejectUnauthorized) {
      this.destroy(authorizationError);
      return;
    }
    queueMicrotask(() => {
      if (this.destroyed) return;
      this._flushPendingWrites?.();
      this._startTlsRead();
      this.emit("connect");
      this.emit(connectedEvent);
      this.emit("secure", this);
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
    });
  }

  _continueTlsHandshake(connectedEvent) {
    const startedAt = Date.now();
    const step = () => {
      this._tlsHandshakeTimer = null;
      if (this.destroyed || this._tlsId == null) return;
      try {
        if (cottontail.tlsClientHandshake(this._tlsId) === true) {
          this._tlsInfo = cottontail.tlsConnectionInfo?.(this._tlsId) ?? this._tlsInfo;
          this._finishTlsConnect(connectedEvent);
          return;
        }
        if (Date.now() - startedAt >= 10000) {
          const error = new Error("TLS handshake timed out");
          error.code = "ETIMEDOUT";
          throw error;
        }
        this._tlsHandshakeTimer = setTimeout(step, 1);
      } catch (error) {
        error = normalizeTlsError(error);
        this.authorized = false;
        this.authorizationError = error?.message ?? String(error);
        this.connecting = false;
        this.destroy(error);
      }
    };
    this._tlsHandshakeTimer = setTimeout(step, 0);
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
      if (event.type === "end") {
        this.readable = false;
        const tlsId = this._tlsId;
        listeners.delete(tlsId);
        this._emitEnd();
        // A TLS close_notify ends both application-data directions. The
        // native reader retains its connection until this acknowledgement so
        // queued terminal events cannot race a freed SSL object.
        if (this._tlsId === tlsId) {
          try { cottontail.tlsConnectionClose(tlsId); } catch {}
          this._tlsId = null;
        }
        return;
      }
      if (event.type === "error") {
        const error = new Error(event.message || "TLS read failed");
        if (/connection reset/i.test(error.message)) error.code = "ECONNRESET";
        else if (/broken pipe/i.test(error.message)) error.code = "EPIPE";
        this.destroy(error);
      }
    }));
    this._tlsListenerInstalled = true;
    cottontail.tlsConnectionReadStart(this._tlsId);
    return this;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this.connecting && !this.destroyed && this.writable) {
      this._pendingWrites.push({ chunk, encoding, callback });
      return true;
    }
    if (this.destroyed || this._tlsId == null || !this.writable) {
      const error = new Error("TLS socket is closed");
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      this.emit("error", error);
      return false;
    }
    const bytes = bytesFrom(chunk, encoding);
    const ok = cottontail.tlsConnectionWrite(this._tlsId, bytes) === true;
    if (this._memoryTransport != null) this._flushMemoryCiphertext();
    if (ok) {
      this.bytesWritten += bytes.byteLength;
      this._refreshTimeout?.();
    }
    if (typeof callback === "function") queueMicrotask(() => callback(ok ? undefined : new Error("TLS socket write failed")));
    if (!ok) this.emit("error", new Error("TLS socket write failed"));
    return ok;
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (chunk != null) this.write(chunk, encoding);
    this.writable = false;
    if (!this._finishEmitted) {
      this._finishEmitted = true;
      this.emit("finish");
    }
    if (this._tlsId != null) {
      try {
        cottontail.tlsConnectionShutdown(this._tlsId);
        if (this._memoryTransport != null) this._flushMemoryCiphertext();
      } catch {}
    }
    if (this._memoryTransport != null) {
      try { this._memoryTransport.end?.(); } catch {}
    }
    if (typeof callback === "function") callback();
    return this;
  }

  destroy(error = undefined) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable = false;
    this.writable = false;
    this._clearTimeoutTimer?.();
    if (this._tlsHandshakeTimer != null) {
      clearTimeout(this._tlsHandshakeTimer);
      this._tlsHandshakeTimer = null;
    }
    const listeners = globalThis.__cottontailTlsListeners;
    this._removeMemoryTransportListeners();
    if (this._tlsId != null) {
      listeners?.delete?.(this._tlsId);
      try { cottontail.tlsConnectionClose(this._tlsId); } catch {}
      this._tlsId = null;
    }
    if (this._parent && !this._parent._tlsDetached) {
      try { this._parent.destroy(); } catch {}
    }
    if (error) this.emit("error", error);
    this.emit("close", Boolean(error));
    return this;
  }

  setEncoding(encoding = "utf8") {
    this._encoding = String(encoding || "utf8").toLowerCase();
    return this;
  }

  getCertificate() {
    return legacyCertificateFromBytes(this._currentTlsInfo()?.localCertificate);
  }
  getCipher() {
    const info = this._currentTlsInfo();
    if (!info?.cipher) return undefined;
    return { name: info.cipher, standardName: info.cipher, version: info.cipherVersion ?? info.protocol ?? undefined };
  }
  getEphemeralKeyInfo() { return {}; }
  getSharedSigalgs() {
    const value = this._currentTlsInfo()?.sharedSigalgs;
    return Array.isArray(value) ? [...value] : [];
  }
  getFinished() { return undefined; }
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
  getPeerFinished() { return undefined; }
  getProtocol() {
    const info = this._currentTlsInfo();
    return info?.protocol ?? null;
  }
  getOCSPResponse() {
    return bufferFromNativeBytes(this._currentTlsInfo()?.ocspResponse);
  }
  getSession() {
    return bufferFromNativeBytes(this._currentTlsInfo()?.session) ?? this._session;
  }
  getTLSTicket() {
    return bufferFromNativeBytes(this._currentTlsInfo()?.tlsTicket);
  }
  isSessionReused() {
    return Boolean(this._currentTlsInfo()?.sessionReused);
  }
  setSession(session) {
    this._session = bufferFromNativeBytes(session) ?? Buffer.from(session ?? []);
    return this;
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
    return this._tlsId == null ? true : cottontail.tlsConnectionSetMaxSendFragment?.(this._tlsId, size) === true;
  }
  exportKeyingMaterial(length, label, context = undefined) {
    if (this._tlsId == null || typeof cottontail.tlsConnectionExportKeyingMaterial !== "function") {
      throw tlsError("TLS socket is not connected", "ERR_TLS_INVALID_STATE");
    }
    const result = cottontail.tlsConnectionExportKeyingMaterial(
      this._tlsId,
      Number(length),
      String(label),
      context == null ? undefined : bytesFrom(context),
    );
    return bufferFromNativeBytes(result) ?? Buffer.alloc(0);
  }
  disableRenegotiation() {
    this._renegotiationDisabled = true;
    return undefined;
  }
  enableTrace() {
    this._traceEnabled = true;
  }
  renegotiate(options = {}, callback = undefined) {
    if (options == null || typeof options !== "object") {
      throw new TypeError('The "options" argument must be of type object');
    }
    if (this._renegotiationDisabled) {
      const error = new Error("TLS renegotiation is disabled");
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      this.emit("error", error);
      return false;
    }
    if (typeof callback === "function") queueMicrotask(() => callback(null));
    return true;
  }
}

export class Server extends NetServer {
  constructor(options = {}, secureConnectionListener = undefined) {
    super(options);
    this._tlsOptions = options ?? {};
    this._tlsServerId = null;
    this._tlsAcceptTimer = null;
    this._tlsAddress = null;
    this._tlsContexts = new Map();
    validateCiphers(this._tlsOptions.ciphers);
    this.on("connection", (socket) => {
      if (!socket?.encrypted) this._upgradeAcceptedSocket(socket);
    });
    if (typeof secureConnectionListener === "function") this.on("secureConnection", secureConnectionListener);
  }

  setSecureContext(options = {}) {
    const context = options instanceof SecureContext ? options.context : options;
    validateCiphers(context?.ciphers);
    this._tlsOptions = { ...this._tlsOptions, ...(context ?? {}) };
    return this;
  }

  addContext(hostname, context) {
    if (typeof hostname !== "string" || hostname.length === 0) {
      const error = new TypeError("hostname must be a string");
      error.code = "ERR_TLS_REQUIRED_SERVER_NAME";
      throw error;
    }
    const secureContext = context instanceof SecureContext ? context : createSecureContext(context);
    this._tlsContexts.set(hostname, secureContext);
    return this;
  }

  _upgradeAcceptedSocket(parentSocket) {
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
      return;
    }
    socket.server = this;
    socket.once("error", (error) => this.emit("tlsClientError", error, socket));
    socket.once("secureConnect", () => this.emit("secureConnection", socket));
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
      const credentials = tlsCredentialOptions(this._tlsOptions);
      cottontail.tlsValidateServerContext?.(
        credentials.cert,
        credentials.key,
        credentials.passphrase,
        credentials.ca,
        this._tlsOptions.ciphers,
        Boolean(this._tlsOptions.requestCert),
        this._tlsOptions.rejectUnauthorized !== false,
      );
    } catch (error) {
      queueMicrotask(() => this.emit("error", normalizeTlsError(error)));
      return this;
    }
    if (listenOptions.path == null && listenOptions.host == null && listenOptions.hostname == null) {
      listenOptions.host = "::";
      listenOptions.family = 6;
    }
    return super.listen(listenOptions, callback);
  }

  _acceptTls() {
    if (!this.listening || this._tlsServerId == null) return;
    for (;;) {
      let accepted;
      try {
        accepted = cottontail.tlsServerAccept(this._tlsServerId);
      } catch (error) {
        this.emit("tlsClientError", error);
        return;
      }
      if (accepted == null) return;
      const socket = new TLSSocket(undefined, { ...this._tlsOptions, isServer: true })._attachNative(accepted, "secureConnect");
      this.connections += 1;
      socket.once("close", () => {
        if (this.connections > 0) this.connections -= 1;
      });
      this.emit("connection", socket);
      this.emit("secureConnection", socket);
    }
  }

  close(callback = undefined) {
    if (this._tlsServerId == null) return super.close(callback);
    if (callback) this.once("close", callback);
    if (this._tlsAcceptTimer) {
      clearInterval(this._tlsAcceptTimer);
      this._tlsAcceptTimer = null;
    }
    if (this._tlsServerId != null) {
      try { cottontail.tlsServerClose(this._tlsServerId); } catch {}
      this._tlsServerId = null;
    }
    this.listening = false;
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  address() {
    return this._tlsAddress ?? super.address();
  }


  getTicketKeys() {
    throw new Error("TLS ticket key access is not available");
  }

  setTicketKeys() {
    throw new Error("TLS ticket key access is not available");
  }
}

export function connect(...args) {
  const [options, callback] = normalizeConnectArgs(args);
  validateCiphers(options.ciphers);
  let parentSocket = options.socket;
  const socket = new TLSSocket(parentSocket, options);
  const host = options.host ?? options.hostname ?? "localhost";
  const defaultServername = isIP(String(host)) ? "" : String(host);
  const servername = options.servername ?? defaultServername;
  socket.servername = servername || undefined;
  socket._host = String(host);
  socket[bunTlsConnectOptions] = {
    serverName: options.servername ?? String(host),
    servername,
    rejectUnauthorized: options.rejectUnauthorized !== false,
    requestCert: options.requestCert !== false,
    checkServerIdentity: options.checkServerIdentity ?? checkServerIdentity,
    session: options.session ?? null,
  };
  if (typeof callback === "function") socket.once("secureConnect", callback);

  const fail = (error) => {
    if (socket.destroyed) return;
    socket.authorized = false;
    socket.authorizationError = error?.message ?? String(error);
    socket.connecting = false;
    socket.destroy(error instanceof Error ? error : new Error(String(error)));
  };

  const upgrade = () => {
    parentSocket?.removeListener?.("error", fail);
    try {
      const credentials = tlsCredentialOptions(options);
      const alpnProtocols = prepareALPNProtocols(options.ALPNProtocols);
      if (typeof parentSocket?._detachFdForTls === "function" && typeof cottontail.tlsClientConnectFd === "function") {
        const fd = parentSocket._detachFdForTls();
        const native = cottontail.tlsClientConnectFd(
          fd,
          servername,
          options.rejectUnauthorized !== false,
          credentials.ca,
          credentials.cert,
          credentials.key,
          credentials.passphrase,
          alpnProtocols,
          options.ciphers,
        );
        socket._attachNative(native, "secureConnect");
        return;
      }
      if (typeof parentSocket?.on === "function" && typeof parentSocket?.write === "function" &&
          typeof cottontail.tlsClientConnectMemory === "function") {
        const native = cottontail.tlsClientConnectMemory(
          servername,
          options.rejectUnauthorized !== false,
          credentials.ca,
          credentials.cert,
          credentials.key,
          credentials.passphrase,
          alpnProtocols,
          options.ciphers,
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
    parentSocket = netConnect({
      host: options.host ?? options.hostname ?? "localhost",
      port: Number(options.port ?? 443),
      family: options.family,
      localAddress: options.localAddress,
      localPort: options.localPort,
    });
    socket._parent = parentSocket;
  }
  parentSocket.once("error", fail);
  if (parentSocket.connecting) parentSocket.once("connect", upgrade);
  else queueMicrotask(upgrade);
  return socket;
}

export function _upgradeServerSocket(parentSocket, options = {}) {
  if (typeof parentSocket?._detachFdForTls !== "function" || typeof cottontail.tlsServerUpgradeFd !== "function") {
    const error = new TypeError("The socket must be a connected Cottontail net.Socket");
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  const socket = new TLSSocket(parentSocket, options);
  const fd = parentSocket._detachFdForTls();
  const credentials = tlsCredentialOptions(options);
  const native = cottontail.tlsServerUpgradeFd(
    fd,
    credentials.cert,
    credentials.key,
    credentials.passphrase,
    prepareALPNProtocols(options.ALPNProtocols),
    credentials.ca,
    Boolean(options.requestCert),
    options.rejectUnauthorized !== false,
    options.ciphers,
  );
  if (options.contexts && typeof cottontail.tlsConnectionAddServerContext === "function") {
    for (const [hostname, secureContext] of options.contexts) {
      const contextOptions = secureContext instanceof SecureContext ? secureContext.context : secureContext;
      const contextCredentials = tlsCredentialOptions(contextOptions);
      cottontail.tlsConnectionAddServerContext(
        native.id,
        hostname,
        contextCredentials.cert,
        contextCredentials.key,
        contextCredentials.ca,
        contextCredentials.passphrase,
        Boolean(options.requestCert),
        options.rejectUnauthorized !== false,
        contextOptions?.ciphers ?? options.ciphers,
      );
    }
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
  } else {
    const chunks = [];
    for (const protocol of Array.from(protocols ?? [])) {
      const item = Buffer.from(String(protocol));
      if (item.byteLength > 255) {
        throw new RangeError(`The byte length of the protocol exceeds the maximum length. It must be <= 255. Received ${item.byteLength}`);
      }
      chunks.push(Buffer.from([item.byteLength]), item);
    }
    bytes = Buffer.concat(chunks);
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
  process._rawDebug?.(`Warning: ignoring extra certs from \`${path}\`, load failed: ${reason}`);
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
      new X509Certificate(certificate);
      certificates.push(certificate);
    } catch (error) {
      warnExtraCA(path, error?.message || String(error));
      break;
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

// COTTONTAIL-COMPAT: node:tls sockets - OpenSSL-backed connect/createServer/TLSSocket streams, certificate identity checks, legacy peer/local certificate objects, CA helpers, SNI contexts, arbitrary Duplex transports, ALPN, cipher selection, and keying-material export are implemented; active renegotiation, finished-message/OCSP/TLS-ticket extraction, and resumable session injection need deeper native bindings.

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
