import {
  Agent as HttpAgent,
  ClientRequest as HttpClientRequest,
  IncomingMessage,
  OutgoingMessage,
  STATUS_CODES,
  ServerResponse,
  _attachHttpConnection,
  _configureHttpServer,
  _httpListeningCallbackArgs,
} from "./http.js";
import { Server as TlsServer, connect as tlsConnect } from "./tls.js";
import { Buffer } from "./buffer.js";
import { isIP } from "./net.js";

export { IncomingMessage, OutgoingMessage, ServerResponse, STATUS_CODES };

export class Agent extends HttpAgent {
  constructor(options = {}) {
    super({ ...options, defaultPort: 443, protocol: "https:" });
    this.defaultPort = 443;
    this.protocol = "https:";
    this.maxCachedSessions = options.maxCachedSessions ?? 100;
    this._sessionCache = { map: Object.create(null), list: [] };
  }

  getName(options = {}) {
    let name = super.getName(options);
    for (const key of [
      "ca", "cert", "clientCertEngine", "ciphers", "key", "pfx", "rejectUnauthorized",
      "servername", "minVersion", "maxVersion", "secureProtocol", "crl", "honorCipherOrder",
      "ecdhCurve", "dhparam", "secureOptions", "sessionIdContext",
    ]) {
      const value = options[key] ?? this.options[key];
      if (value !== undefined) name += `:${key}=${tlsCacheKey(value)}`;
    }
    return name;
  }

  _getSession(key) {
    return this._sessionCache.map[key];
  }

  _cacheSession(key, session) {
    if (this.maxCachedSessions === 0 || session == null) return;
    if (this._sessionCache.map[key] == null) {
      if (this._sessionCache.list.length >= this.maxCachedSessions) {
        const oldest = this._sessionCache.list.shift();
        delete this._sessionCache.map[oldest];
      }
      this._sessionCache.list.push(key);
    }
    this._sessionCache.map[key] = session;
  }

  _evictSession(key) {
    delete this._sessionCache.map[key];
    const index = this._sessionCache.list.indexOf(key);
    if (index >= 0) this._sessionCache.list.splice(index, 1);
  }

  createConnection(options = {}, callback = undefined) {
    const merged = { ...this.options, ...options };
    delete merged.path;
    const name = this.getName(merged);
    if (merged.session == null) merged.session = this._getSession(name);
    const host = merged.host ?? merged.hostname ?? "localhost";
    const servername = merged.servername == null
      ? (isIP(host) ? "" : host)
      : merged.servername;
    const socket = tlsConnect({
      ...merged,
      host,
      servername,
      port: Number(merged.port ?? 443),
    }, callback);
    socket.once?.("secureConnect", () => {
      try { this._cacheSession(name, socket.getSession?.()); } catch {}
    });
    socket.once?.("error", () => this._evictSession(name));
    return socket;
  }
}

function tlsCacheKey(value) {
  if (Array.isArray(value)) return value.map(tlsCacheKey).join(",");
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("base64");
  return String(value);
}

export const globalAgent = new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000 });

export class ClientRequest extends HttpClientRequest {
  constructor(input, options = undefined, callback = undefined) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (input instanceof URL || typeof input === "string") {
      options = { _defaultAgent: globalAgent, ...(options ?? {}) };
    } else {
      input = { _defaultAgent: globalAgent, ...(input ?? {}) };
      if (options && typeof options === "object") options = { ...options };
    }
    super(input, options, callback, "https:");
  }
}

class ServerImpl extends TlsServer {
  constructor(options = {}, requestListener = undefined) {
    if (typeof options === "function") {
      requestListener = options;
      options = {};
    }
    super(options);
    this._connections = new Set();
    this._closing = false;
    this.maxRequestsPerSocket = 0;
    _configureHttpServer(this, options, requestListener);
    this.on("secureConnection", (socket) => {
      this._connections.add(socket);
      socket.once("close", () => this._connections.delete(socket));
      this.emit("connection", socket);
      _attachHttpConnection(this, socket);
    });
  }

  listen(...args) {
    const forwarded = Array.from(args);
    const callback = typeof forwarded[forwarded.length - 1] === "function" ? forwarded.pop() : undefined;
    let options = {};
    if (forwarded[0] != null && typeof forwarded[0] === "object") options = forwarded[0];
    else if (typeof forwarded[0] === "string") options = { path: forwarded[0] };
    else options = { port: forwarded[0], host: typeof forwarded[1] === "string" ? forwarded[1] : undefined };
    if (callback) {
      this.once("listening", () => callback.call(this, ..._httpListeningCallbackArgs(this, options)));
    }
    return super.listen(...forwarded);
  }

  setTimeout(timeout = 0, callback = undefined) {
    const value = Number(timeout);
    if (!Number.isInteger(value) || value < 0) {
      const error = new RangeError(`The value of "msecs" is out of range. It must be >= 0. Received ${timeout}`);
      error.code = "ERR_OUT_OF_RANGE";
      throw error;
    }
    this.timeout = value;
    if (typeof callback === "function") this.on("timeout", callback);
    return this;
  }

  closeAllConnections() {
    for (const socket of Array.from(this._connections)) socket.destroy?.();
  }

  closeIdleConnections() {
    for (const socket of Array.from(this._connections)) {
      if (socket._httpMessage == null) socket.destroy?.();
    }
  }

  close(callback = undefined) {
    this._closing = true;
    this.closeIdleConnections();
    return super.close(callback);
  }
}

Object.defineProperty(ServerImpl, "name", { value: "Server", configurable: true });
export const Server = new Proxy(ServerImpl, {
  apply(target, _thisArg, args) {
    return new target(...args);
  },
});

export function createServer(options = {}, requestListener = undefined) {
  return new Server(options, requestListener);
}

export function request(input, options = undefined, callback = undefined) {
  return new ClientRequest(input, options, callback);
}

export function get(input, options = undefined, callback = undefined) {
  const req = request(input, options, callback);
  req.end();
  return req;
}

export default {
  Agent,
  ClientRequest,
  IncomingMessage,
  OutgoingMessage,
  STATUS_CODES,
  Server,
  ServerResponse,
  createServer,
  get,
  globalAgent,
  request,
};
