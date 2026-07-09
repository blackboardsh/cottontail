import { Buffer } from "./buffer.js";
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

function unsupportedTls(name) {
  return new Error(`${name} requires native TLS socket bindings that are not implemented in Cottontail yet`);
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
    super(options ?? {});
    this.encrypted = true;
    this.authorized = false;
    this.authorizationError = null;
    this.alpnProtocol = false;
    this.servername = options?.servername;
    this._parent = socket;
    this._secureContext = options?.secureContext ?? createSecureContext(options ?? {});
  }

  getCertificate() { return {}; }
  getCipher() { return null; }
  getEphemeralKeyInfo() { return {}; }
  getFinished() { return undefined; }
  getPeerCertificate() { return {}; }
  getPeerFinished() { return undefined; }
  getProtocol() { return null; }
  getSession() { return undefined; }
  isSessionReused() { return false; }
  renegotiate(_options, callback) {
    const error = unsupportedTls("tls.TLSSocket.renegotiate");
    if (typeof callback === "function") queueMicrotask(() => callback(error));
    else queueMicrotask(() => this.emit("error", error));
    return false;
  }
  setMaxSendFragment() { return false; }
}

export class Server extends NetServer {
  constructor(options = {}, secureConnectionListener = undefined) {
    super(options, secureConnectionListener);
    this._tlsOptions = options ?? {};
  }

  listen(...args) {
    const callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
    if (callback) this.once("listening", callback);
    queueMicrotask(() => this.emit("error", unsupportedTls("tls.Server.listen")));
    return this;
  }
}

export function connect(...args) {
  const callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
  const options = args.find((arg) => arg && typeof arg === "object") ?? {};
  const socket = new TLSSocket(undefined, options);
  if (typeof callback === "function") socket.once("secureConnect", callback);
  queueMicrotask(() => socket.destroy(unsupportedTls("tls.connect")));
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

// COTTONTAIL-COMPAT: node:tls sockets - certificate identity checks, CA certificate helpers, SecureContext option capture, constants, ALPN encoding, and default cipher inventory are implemented; exported TLS socket/server entry points fail loudly until native TLS bindings land.

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
