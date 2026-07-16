import {
  Agent as HttpAgent,
  ClientRequest as HttpClientRequest,
  IncomingMessage,
  OutgoingMessage,
  STATUS_CODES,
  ServerResponse,
  _attachHttpConnection,
} from "./http.js";
import { Server as TlsServer, connect as tlsConnect } from "./tls.js";

export { IncomingMessage, OutgoingMessage, ServerResponse, STATUS_CODES };

export class Agent extends HttpAgent {
  constructor(options = {}) {
    super({ ...options });
    this.protocol = "https:";
  }

  createConnection(options = {}, callback = undefined) {
    const merged = { ...this.options, ...options };
    delete merged.path;
    return tlsConnect({
      ...merged,
      host: merged.host ?? merged.hostname ?? "localhost",
      servername: merged.servername ?? merged.host ?? merged.hostname ?? "localhost",
      port: Number(merged.port ?? 443),
    }, callback);
  }
}

export const globalAgent = new Agent({ protocol: "https:" });

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

export class Server extends TlsServer {
  constructor(options = {}, requestListener = undefined) {
    super(options);
    this.timeout = Number(options?.timeout ?? 0);
    this.requestTimeout = Number(options?.requestTimeout ?? 300000);
    this.headersTimeout = Number(options?.headersTimeout ?? 60000);
    this.keepAliveTimeout = Number(options?.keepAliveTimeout ?? 5000);
    this._connections = new Set();
    this._closing = false;
    if (typeof requestListener === "function") this.on("request", requestListener);
    this.on("secureConnection", (socket) => {
      this._connections.add(socket);
      socket.once("close", () => this._connections.delete(socket));
      this.emit("connection", socket);
      _attachHttpConnection(this, socket);
    });
  }

  setTimeout(timeout = 0, callback = undefined) {
    this.timeout = Number(timeout) || 0;
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
