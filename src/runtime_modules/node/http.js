import { EventEmitter } from "./events.js";
import { Readable, Writable } from "./stream.js";
import { Buffer } from "./buffer.js";
import { serve, fetch, Headers, Request, Response } from "../bun/index.js";

export const METHODS = [
  "ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK",
  "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS",
  "PATCH", "POST", "PRI", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "REBIND", "REPORT",
  "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE",
];

export const STATUS_CODES = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  509: "Bandwidth Limit Exceeded",
  510: "Not Extended",
  511: "Network Authentication Required",
};

export const maxHeaderSize = 16 * 1024;

const tokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function bytesFromBody(body) {
  if (body == null) return new Uint8Array(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(String(body));
}

function appendHeaderValue(headers, name, value) {
  if (Array.isArray(value)) {
    for (const item of value) headers.append(name, String(item));
  } else if (value != null) {
    headers.append(name, String(value));
  }
}

function headersObjectFromHeaders(headers) {
  const out = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function rawHeadersFromHeaders(headers) {
  const out = [];
  headers.forEach((value, key) => {
    out.push(key, value);
  });
  return out;
}

function requestPath(url) {
  return `${url.pathname || "/"}${url.search || ""}`;
}

function normalizeListenArgs(args) {
  const list = Array.from(args);
  const callback = typeof list[list.length - 1] === "function" ? list.pop() : undefined;
  let options = {};
  if (typeof list[0] === "object" && list[0] !== null) {
    options = { ...list[0] };
  } else {
    options.port = list[0] ?? 0;
    if (typeof list[1] === "string") options.host = list[1];
    else if (typeof list[1] === "number") options.backlog = list[1];
    if (typeof list[2] === "number") options.backlog = list[2];
  }
  return [options, callback];
}

function normalizeRequestOptions(input, options = undefined, defaultProtocol = "http:") {
  let url;
  let merged = {};
  if (input instanceof URL || typeof input === "string") {
    url = new URL(String(input));
    merged = { ...(options ?? {}) };
  } else {
    merged = { ...(input ?? {}) };
    if (options && typeof options === "object") merged = { ...merged, ...options };
    const protocol = merged.protocol ?? defaultProtocol;
    const hostname = merged.hostname ?? merged.host ?? "localhost";
    const port = merged.port != null ? `:${merged.port}` : "";
    const path = merged.path ?? `${merged.pathname ?? "/"}${merged.search ?? ""}`;
    url = new URL(`${protocol}//${hostname}${port}${path}`);
  }
  if (merged.protocol) url.protocol = merged.protocol;
  if (merged.hostname) url.hostname = merged.hostname;
  if (merged.host && !merged.hostname) url.host = merged.host;
  if (merged.port != null) url.port = String(merged.port);
  if (merged.path) {
    const pathUrl = new URL(url);
    const [pathname, search = ""] = String(merged.path).split("?", 2);
    pathUrl.pathname = pathname || "/";
    pathUrl.search = search ? `?${search}` : "";
    url = pathUrl;
  }
  return { url, options: merged };
}

export function validateHeaderName(name, label = "Header name") {
  const value = String(name);
  if (!tokenPattern.test(value)) throw new TypeError(`${label} must be a valid HTTP token`);
}

export function validateHeaderValue(name, value) {
  validateHeaderName(name);
  if (value == null) throw new TypeError(`Invalid value for header ${name}`);
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(String(value))) {
    throw new TypeError(`Invalid value for header ${name}`);
  }
}

export class IncomingMessage extends Readable {
  constructor(init = {}) {
    super();
    this.aborted = false;
    this.complete = true;
    this.headers = init.headers ?? {};
    this.rawHeaders = init.rawHeaders ?? [];
    this.httpVersion = "1.1";
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.method = init.method;
    this.url = init.url;
    this.statusCode = init.statusCode;
    this.statusMessage = init.statusMessage ?? STATUS_CODES[this.statusCode] ?? "";
    this.socket = init.socket ?? null;
    this.connection = this.socket;
    this.trailers = {};
    this.rawTrailers = [];
    this._body = bytesFromBody(init.body);
    queueMicrotask(() => {
      if (this._body.byteLength > 0) this.push(Buffer.from(this._body));
      this.push(null);
    });
  }

  setTimeout(_timeout, callback = undefined) {
    if (typeof callback === "function") this.once("timeout", callback);
    return this;
  }
}

export class OutgoingMessage extends Writable {
  constructor() {
    super();
    this.headersSent = false;
    this.finished = false;
    this.writableEnded = false;
    this.sendDate = true;
    this.shouldKeepAlive = false;
    this._headerMap = new Map();
    this._chunks = [];
  }

  setHeader(name, value) {
    validateHeaderValue(name, Array.isArray(value) ? value.join(", ") : value);
    this._headerMap.set(String(name).toLowerCase(), { name: String(name), value });
    return this;
  }

  appendHeader(name, value) {
    validateHeaderName(name);
    const existing = this.getHeader(name);
    if (existing == null) return this.setHeader(name, value);
    const next = Array.isArray(existing) ? [...existing, value] : [existing, value];
    return this.setHeader(name, next);
  }

  getHeader(name) {
    return this._headerMap.get(String(name).toLowerCase())?.value;
  }

  getHeaderNames() {
    return Array.from(this._headerMap.keys());
  }

  getHeaders() {
    const out = {};
    for (const [name, entry] of this._headerMap) out[name] = entry.value;
    return out;
  }

  hasHeader(name) {
    return this._headerMap.has(String(name).toLowerCase());
  }

  removeHeader(name) {
    this._headerMap.delete(String(name).toLowerCase());
  }

  writeHead(statusCode, statusMessage = undefined, headers = undefined) {
    if (typeof statusMessage === "object" && statusMessage !== null) {
      headers = statusMessage;
      statusMessage = undefined;
    }
    this.statusCode = Number(statusCode);
    if (statusMessage != null) this.statusMessage = String(statusMessage);
    if (headers) {
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    }
    this.headersSent = true;
    return this;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (typeof chunk === "string") this._chunks.push(Buffer.from(chunk, encoding ?? "utf8"));
    else this._chunks.push(Buffer.from(bytesFromBody(chunk)));
    this.headersSent = true;
    if (typeof callback === "function") callback();
    return true;
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
    this.finished = true;
    this.writableEnded = true;
    this.emit("finish");
    if (typeof callback === "function") callback();
    return this;
  }

  _headersForFetch() {
    const headers = new Headers();
    for (const entry of this._headerMap.values()) appendHeaderValue(headers, entry.name, entry.value);
    return headers;
  }

  _bodyBuffer() {
    return Buffer.concat(this._chunks.map((chunk) => Buffer.from(chunk)));
  }
}

export class ServerResponse extends OutgoingMessage {
  constructor(resolveResponse) {
    super();
    this.statusCode = 200;
    this.statusMessage = STATUS_CODES[200];
    this._resolveResponse = resolveResponse;
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    super.end(chunk, encoding, callback);
    const status = this.statusCode || 200;
    const headers = this._headersForFetch();
    this._resolveResponse(new Response(this._bodyBuffer(), {
      status,
      statusText: this.statusMessage || STATUS_CODES[status] || "",
      headers,
    }));
    return this;
  }
}

export class Agent extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...options };
    this.requests = {};
    this.sockets = {};
    this.freeSockets = {};
    this.keepAlive = Boolean(options.keepAlive);
    this.maxSockets = options.maxSockets ?? Infinity;
    this.maxFreeSockets = options.maxFreeSockets ?? 256;
  }

  createConnection() {
    throw new Error("http.Agent.createConnection requires node:net socket bindings");
  }

  getName(options = {}) {
    return `${options.host ?? options.hostname ?? "localhost"}:${options.port ?? ""}:${options.localAddress ?? ""}`;
  }

  destroy() {
    this.emit("free");
  }
}

export const globalAgent = new Agent();

export class ClientRequest extends OutgoingMessage {
  constructor(input, options = undefined, callback = undefined, defaultProtocol = "http:") {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    super();
    const normalized = normalizeRequestOptions(input, options, defaultProtocol);
    this.url = normalized.url;
    this.method = String(normalized.options.method ?? "GET").toUpperCase();
    this.path = requestPath(this.url);
    this.host = this.url.host;
    this.protocol = this.url.protocol;
    this.aborted = false;
    this.destroyed = false;
    if (normalized.options.headers) {
      for (const [name, value] of Object.entries(normalized.options.headers)) this.setHeader(name, value);
    }
    if (typeof callback === "function") this.once("response", callback);
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    super.end(chunk, encoding, callback);
    this._dispatch();
    return this;
  }

  abort() {
    this.aborted = true;
    this.destroy();
  }

  destroy(error = undefined) {
    this.destroyed = true;
    if (error) this.emit("error", error);
    this.emit("close");
    return this;
  }

  flushHeaders() {
    this.headersSent = true;
  }

  setNoDelay() { return this; }
  setSocketKeepAlive() { return this; }
  setTimeout(_timeout, callback = undefined) {
    if (typeof callback === "function") this.once("timeout", callback);
    return this;
  }

  async _dispatch() {
    if (this.aborted) return;
    try {
      const body = this.method === "GET" || this.method === "HEAD" ? undefined : this._bodyBuffer();
      const response = await fetch(String(this.url), {
        method: this.method,
        headers: this._headersForFetch(),
        body,
      });
      const responseBody = await response.arrayBuffer();
      const message = new IncomingMessage({
        statusCode: response.status,
        statusMessage: response.statusText || STATUS_CODES[response.status] || "",
        headers: headersObjectFromHeaders(response.headers),
        rawHeaders: rawHeadersFromHeaders(response.headers),
        body: responseBody,
      });
      this.emit("response", message);
      this.emit("close");
    } catch (error) {
      this.emit("error", error);
      this.emit("close");
    }
  }
}

export class Server extends EventEmitter {
  constructor(options = {}, requestListener = undefined) {
    super();
    if (typeof options === "function") {
      requestListener = options;
      options = {};
    }
    this.listening = false;
    this._options = options ?? {};
    this._native = null;
    if (typeof requestListener === "function") this.on("request", requestListener);
  }

  listen(...args) {
    const [options, callback] = normalizeListenArgs(args);
    if (typeof callback === "function") this.once("listening", callback);
    const hostname = options.host ?? options.hostname ?? "127.0.0.1";
    const port = Number(options.port ?? 0);
    this._native = serve({
      hostname,
      port,
      fetch: async (request) => {
        const url = new URL(request.url);
        const requestBody = await request.arrayBuffer();
        const incoming = new IncomingMessage({
          method: request.method,
          url: requestPath(url),
          headers: headersObjectFromHeaders(request.headers),
          rawHeaders: rawHeadersFromHeaders(request.headers),
          body: requestBody,
        });
        return new Promise((resolve) => {
          const response = new ServerResponse(resolve);
          this.emit("request", incoming, response);
        });
      },
    });
    this.listening = true;
    queueMicrotask(() => this.emit("listening"));
    return this;
  }

  close(callback = undefined) {
    if (typeof callback === "function") this.once("close", callback);
    const stopped = this._native?.stop?.();
    this._native = null;
    this.listening = false;
    Promise.resolve(stopped).then(() => this.emit("close"));
    return this;
  }

  address() {
    if (!this._native) return null;
    return { address: this._native.hostname, family: "IPv4", port: this._native.port };
  }

  ref() {
    this._native?.ref?.();
    return this;
  }

  unref() {
    this._native?.unref?.();
    return this;
  }
}

export function createServer(options = {}, requestListener = undefined) {
  return new Server(options, requestListener);
}

export function request(input, options = undefined, callback = undefined) {
  return new ClientRequest(input, options, callback, "http:");
}

export function get(input, options = undefined, callback = undefined) {
  const req = request(input, options, callback);
  req.end();
  return req;
}

export function setMaxIdleHTTPParsers(value) {
  setMaxIdleHTTPParsers.value = Number(value);
}
setMaxIdleHTTPParsers.value = 1000;

export function _connectionListener(socket) {
  this?.emit?.("connection", socket);
}

export class MessageEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.data = init.data;
    this.origin = init.origin ?? "";
    this.lastEventId = init.lastEventId ?? "";
    this.source = init.source ?? null;
    this.ports = init.ports ?? [];
  }
}

export class CloseEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.wasClean = Boolean(init.wasClean);
    this.code = Number(init.code ?? 0);
    this.reason = String(init.reason ?? "");
  }
}

export const WebSocket = globalThis.WebSocket ?? class WebSocket extends EventEmitter {
  constructor() {
    super();
    throw new Error("WebSocket is not available in Cottontail node:http yet");
  }
};

// COTTONTAIL-COMPAT: node:http sockets - HTTP server/client behavior is backed by Cottontail's native HTTP server and fetch; the fetch-backed client is synchronous today, and raw socket upgrades, CONNECT tunneling, same-process loopback, and WebSocket transport need native socket/client bindings.

export default {
  Agent,
  ClientRequest,
  CloseEvent,
  IncomingMessage,
  METHODS,
  MessageEvent,
  OutgoingMessage,
  STATUS_CODES,
  Server,
  ServerResponse,
  WebSocket,
  _connectionListener,
  createServer,
  get,
  globalAgent,
  maxHeaderSize,
  request,
  setMaxIdleHTTPParsers,
  validateHeaderName,
  validateHeaderValue,
};
