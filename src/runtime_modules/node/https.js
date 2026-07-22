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
import { isIP } from "./net.js";

export { IncomingMessage, OutgoingMessage, ServerResponse, STATUS_CODES };

class AgentImpl extends HttpAgent {
  constructor(options = {}) {
    const agentOptions = Object.assign(Object.create(null), options);
    agentOptions.defaultPort ??= 443;
    agentOptions.protocol ??= "https:";
    super(agentOptions);
    this.defaultPort = agentOptions.defaultPort;
    this.protocol = agentOptions.protocol;
    this.maxCachedSessions = this.options.maxCachedSessions;
    if (this.maxCachedSessions === undefined) this.maxCachedSessions = 100;
    this._sessionCache = { map: {}, list: [] };
  }

  getName(options = {}) {
    let name = super.getName(options);
    name += ":";
    if (options.ca) name += options.ca;
    name += ":";
    if (options.cert) name += options.cert;
    name += ":";
    if (options.clientCertEngine) name += options.clientCertEngine;
    name += ":";
    if (options.ciphers) name += options.ciphers;
    name += ":";
    if (options.key) name += options.key;
    name += ":";
    if (options.pfx) name += options.pfx;
    name += ":";
    if (options.rejectUnauthorized !== undefined) name += options.rejectUnauthorized;
    name += ":";
    if (options.servername && options.servername !== options.host) name += options.servername;
    name += ":";
    if (options.minVersion) name += options.minVersion;
    name += ":";
    if (options.maxVersion) name += options.maxVersion;
    name += ":";
    if (options.secureProtocol) name += options.secureProtocol;
    name += ":";
    if (options.crl) name += options.crl;
    name += ":";
    if (options.honorCipherOrder !== undefined) name += options.honorCipherOrder;
    name += ":";
    if (options.ecdhCurve) name += options.ecdhCurve;
    name += ":";
    if (options.dhparam) name += options.dhparam;
    name += ":";
    if (options.secureOptions !== undefined) name += options.secureOptions;
    name += ":";
    if (options.sessionIdContext) name += options.sessionIdContext;
    name += ":";
    if (options.sigalgs) name += JSON.stringify(options.sigalgs);
    name += ":";
    if (options.privateKeyIdentifier) name += options.privateKeyIdentifier;
    name += ":";
    if (options.privateKeyEngine) name += options.privateKeyEngine;
    return name;
  }

  _getSession(key) {
    return this._sessionCache.map[key];
  }

  _cacheSession(key, session) {
    if (this.maxCachedSessions === 0 || session == null) return;
    if (this._sessionCache.map[key]) {
      this._sessionCache.map[key] = session;
      return;
    }
    if (this._sessionCache.list.length >= this.maxCachedSessions) {
      const oldest = this._sessionCache.list.shift();
      delete this._sessionCache.map[oldest];
    }
    this._sessionCache.list.push(key);
    this._sessionCache.map[key] = session;
  }

  _evictSession(key) {
    const index = this._sessionCache.list.indexOf(key);
    if (index >= 0) {
      this._sessionCache.list.splice(index, 1);
      delete this._sessionCache.map[key];
    }
  }

  createConnection(...args) {
    let options;
    if (args[0] !== null && typeof args[0] === "object") {
      options = { ...args[0] };
    } else if (args[1] !== null && typeof args[1] === "object") {
      options = { ...args[1] };
    } else if (args[2] !== null && typeof args[2] === "object") {
      options = { ...args[2] };
    } else {
      options = {};
    }
    if (typeof args[0] === "number") options.port = args[0];
    if (typeof args[1] === "string") options.host = args[1];
    const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined;

    const key = options._agentKey;
    if (key) {
      const session = this._getSession(key);
      if (session) options = { session, ...options };
    }

    const host = options.host ?? options.hostname ?? "localhost";
    const servername = options.servername == null
      ? (isIP(host) ? "" : host)
      : options.servername;
    const socket = tlsConnect({ ...options, host, servername }, callback);

    if (key) {
      const cacheSession = (session) => {
        if (session != null) this._cacheSession(key, session);
      };
      const refreshSession = () => {
        try { cacheSession(socket.getSession?.()); } catch {}
      };
      socket.on?.("session", cacheSession);
      socket.once?.("secureConnect", refreshSession);
      // Stock-JSC's TLS bridge currently exposes post-handshake tickets through
      // getSession() before the first application-data event.
      socket.once?.("data", refreshSession);
      socket.once?.("close", (hadError) => {
        if (hadError) this._evictSession(key);
      });
    }
    return socket;
  }
}

Object.defineProperty(AgentImpl, "name", { value: "Agent", configurable: true });
Object.defineProperty(AgentImpl, "length", { value: 1, configurable: true });
export const Agent = new Proxy(AgentImpl, {
  apply(target, _thisArg, args) {
    return Reflect.construct(target, args);
  },
});

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

function requestImpl(input, options = undefined, callback = undefined) {
  return new ClientRequest(input, options, callback);
}

function getImpl(input, options = undefined, callback = undefined) {
  const req = requestImpl(input, options, callback);
  req.end();
  return req;
}

const httpsDefault = {
  Agent,
  ClientRequest,
  IncomingMessage,
  OutgoingMessage,
  STATUS_CODES,
  Server,
  ServerResponse,
  createServer,
  get: getImpl,
  globalAgent,
  request: requestImpl,
};

export function request(...args) {
  return httpsDefault.request(...args);
}

export function get(...args) {
  return httpsDefault.get(...args);
}

export default httpsDefault;
