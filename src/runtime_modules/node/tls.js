import { Buffer } from "./buffer.js";
import { X509Certificate } from "./crypto.js";
import { isIP, Server as NetServer, Socket } from "./net.js";

export const CLIENT_RENEG_LIMIT = 3;
export const CLIENT_RENEG_WINDOW = 600;
export const DEFAULT_CIPHERS = "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";
export const DEFAULT_ECDH_CURVE = "auto";
export const DEFAULT_MAX_VERSION = "TLSv1.3";
export const DEFAULT_MIN_VERSION = "TLSv1.2";

const certificatePaths = [
  "/etc/ssl/cert.pem",
  "/etc/ssl/certs/ca-certificates.crt",
  "/opt/homebrew/etc/ca-certificates/cert.pem",
  "/usr/local/etc/openssl@3/cert.pem",
];

function parsePemCertificates(text) {
  const matches = String(text || "").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  return matches ? matches.map((cert) => cert.trim()) : [];
}

function systemRootCertificates() {
  for (const path of certificatePaths) {
    try {
      const certs = parsePemCertificates(cottontail.readFile(path));
      if (certs.length > 0) return certs;
    } catch {}
  }
  try {
    const result = cottontail.spawnSync("security", ["find-certificate", "-a", "-p", "/System/Library/Keychains/SystemRootCertificates.keychain"], { stdio: "pipe" });
    if (result.status === 0) return parsePemCertificates(result.stdout);
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
  } else {
    options.port = list[0] ?? 0;
    if (typeof list[1] === "string") options.host = list[1];
  }
  return [options, callback];
}

function flattenPem(value) {
  if (value == null) return "";
  return Array.isArray(value) ? value.map(String).join("\n") : String(value);
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
    this.context = {
      ...options,
      ca: options.ca == null ? undefined : normalizeCertificates(options.ca),
      cert: options.cert == null ? undefined : normalizeCertificates(options.cert),
    };
  }
}

export function createSecureContext(options = {}) {
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
    this._session = bufferFromNativeBytes(options?.session);
    this._renegotiationDisabled = false;
    this.allowHalfOpen = options?.allowHalfOpen === true;
  }

  _attachNative(native, connectedEvent = "secureConnect") {
    this._tlsId = Number(native.id);
    this.fd = Number(native.fd ?? -1);
    this._tlsInfo = native;
    this.destroyed = false;
    this.readable = true;
    this.writable = true;
    this._setAddressInfo(native.local, native.remote);
    this.authorized = true;
    this.authorizationError = null;
    queueMicrotask(() => {
      this.emit("connect");
      this.emit(connectedEvent);
      this._startTlsRead();
    });
    return this;
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
    const listeners = installTlsEventDispatcher();
    listeners.set(this._tlsId, (event) => {
      if (this.destroyed) return;
      if (event.type === "data") {
        const chunk = chunkFromBytes(event.data ?? new ArrayBuffer(0), this._encoding);
        const length = Number(chunk?.byteLength ?? chunk?.length ?? 0);
        if (length > 0) {
          this.bytesRead += length;
          this.emit("data", chunk);
          this._refreshTimeout?.();
        }
        return;
      }
      if (event.type === "end") {
        this.readable = false;
        listeners.delete(this._tlsId);
        this.emit("end");
        if (!this.allowHalfOpen) this.destroy();
        return;
      }
      if (event.type === "error") {
        this.destroy(new Error(event.message || "TLS read failed"));
      }
    });
    this._tlsListenerInstalled = true;
    cottontail.tlsConnectionReadStart(this._tlsId);
    return this;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this.destroyed || this._tlsId == null || !this.writable) {
      const error = new Error("TLS socket is closed");
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      this.emit("error", error);
      return false;
    }
    const bytes = bytesFrom(chunk, encoding);
    const ok = cottontail.tlsConnectionWrite(this._tlsId, bytes) === true;
    if (ok) {
      this.bytesWritten += bytes.byteLength;
      this._refreshTimeout?.();
    }
    if (typeof callback === "function") queueMicrotask(() => callback(ok ? undefined : new Error("TLS socket write failed")));
    if (!ok) this.emit("error", new Error("TLS socket write failed"));
    return ok;
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    if (typeof chunk === "function") callback = chunk;
    else if (typeof encoding === "function") callback = encoding;
    if (chunk != null) this.write(chunk, encoding);
    this.writable = false;
    this.emit("finish");
    if (this._tlsId != null) {
      try { cottontail.tlsConnectionShutdown(this._tlsId); } catch {}
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
    const listeners = globalThis.__cottontailTlsListeners;
    if (this._tlsId != null) {
      listeners?.delete?.(this._tlsId);
      try { cottontail.tlsConnectionClose(this._tlsId); } catch {}
      this._tlsId = null;
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
    return { name: info.cipher, standardName: info.cipher, version: info.protocol ?? undefined };
  }
  getEphemeralKeyInfo() { return {}; }
  getFinished() { return undefined; }
  getPeerCertificate() {
    return legacyCertificateFromBytes(this._currentTlsInfo()?.peerCertificate);
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
  setMaxSendFragment() { return false; }
}

export class Server extends NetServer {
  constructor(options = {}, secureConnectionListener = undefined) {
    super(options);
    this._tlsOptions = options ?? {};
    this._tlsServerId = null;
    this._tlsAcceptTimer = null;
    this._tlsAddress = null;
    if (typeof secureConnectionListener === "function") this.on("secureConnection", secureConnectionListener);
  }

  listen(...args) {
    const [listenOptions, callback] = normalizeListenArgs(args);
    if (typeof callback === "function") this.once("listening", callback);
    queueMicrotask(() => {
      try {
        const native = cottontail.tlsServerListen(
          Number(listenOptions.port ?? 0),
          listenOptions.host ?? listenOptions.hostname ?? "127.0.0.1",
          flattenPem(this._tlsOptions.cert),
          flattenPem(this._tlsOptions.key),
        );
        this._tlsServerId = Number(native.id);
        this._tlsAddress = native.address ?? null;
        this.listening = true;
        this._tlsAcceptTimer = setInterval(() => this._acceptTls(), 1);
        this.emit("listening");
      } catch (error) {
        this.emit("error", error);
      }
    });
    return this;
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
      const socket = new TLSSocket(undefined, this._tlsOptions)._attachNative(accepted, "secureConnect");
      this.connections += 1;
      socket.once("close", () => {
        if (this.connections > 0) this.connections -= 1;
      });
      this.emit("connection", socket);
      this.emit("secureConnection", socket);
    }
  }

  close(callback = undefined) {
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
    return this._tlsAddress;
  }
}

export function connect(...args) {
  const [options, callback] = normalizeConnectArgs(args);
  const socket = new TLSSocket(undefined, options);
  if (typeof callback === "function") socket.once("secureConnect", callback);
  queueMicrotask(() => {
    try {
      const native = cottontail.tlsClientConnect(
        Number(options.port ?? 443),
        options.host ?? options.hostname ?? "localhost",
        options.servername ?? options.host ?? options.hostname ?? "localhost",
        options.rejectUnauthorized !== false,
        flattenPem(options.ca),
      );
      socket._attachNative(native, "secureConnect");
    } catch (error) {
      socket.authorized = false;
      socket.authorizationError = error?.message ?? String(error);
      socket.destroy(error);
    }
  });
  return socket;
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

export const rootCertificates = systemRootCertificates();
let defaultCACertificates = [...rootCertificates];

export function getCACertificates(type = "default") {
  const normalized = String(type ?? "default");
  if (normalized === "default") return [...defaultCACertificates];
  if (normalized === "system" || normalized === "bundled") return [...rootCertificates];
  if (normalized === "extra") return [];
  throw new TypeError(`Unknown CA certificate type: ${type}`);
}

export function setDefaultCACertificates(certs) {
  defaultCACertificates = normalizeCertificates(certs);
}

const defaultCipherNames = defaultCipherList();

export function getCiphers() {
  return [...defaultCipherNames];
}

// COTTONTAIL-COMPAT: node:tls sockets - OpenSSL-backed connect/createServer/TLSSocket streams, certificate identity checks, legacy peer/local certificate objects, session buffers, CA certificate helpers, SecureContext option capture, constants, ALPN encoding, default cipher inventory, session setters, trace toggles, and OCSP/TLS-ticket accessors are implemented; protocol-level renegotiation, OCSP stapling generation, and resumable session cache wiring need deeper bindings.

export default {
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
  rootCertificates,
  setDefaultCACertificates,
};
