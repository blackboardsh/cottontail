import { EventEmitter } from "./events.js";
import { Readable, Writable } from "./stream.js";
import { Buffer } from "./buffer.js";
import { connect as netConnect, createServer as createNetServer } from "./net.js";
import { connect as tlsConnect } from "./tls.js";
import { createHash, randomBytes } from "./crypto.js";
import { Headers } from "../bun/index.js";

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

function requestPath(url, options = undefined) {
  if (String(options?.method ?? "").toUpperCase() === "CONNECT" && options?.path != null) return String(options.path);
  return `${url.pathname || "/"}${url.search || ""}`;
}

function normalizeListenArgs(args) {
  const list = Array.from(args);
  const callback = typeof list[list.length - 1] === "function" ? list.pop() : undefined;
  let options = {};
  if (typeof list[0] === "object" && list[0] !== null) {
    options = { ...list[0] };
  } else if (typeof list[0] === "string") {
    options.path = list[0];
    if (typeof list[1] === "number") options.backlog = list[1];
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
  merged._port = merged.port ?? String(url.href).match(/^https?:\/\/[^/:]+:(\d+)/)?.[1] ?? (url.protocol === "https:" ? 443 : 80);
  return { url, options: merged };
}

function parseHeaderLines(text) {
  const lines = String(text).split("\r\n");
  const entries = [];
  let current = null;
  for (const line of lines) {
    if (!line) continue;
    if (/^[\t ]/.test(line)) {
      if (current == null) throw new Error("Invalid HTTP folded header");
      current.value = `${current.value} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("Invalid HTTP header");
    const name = line.slice(0, colon);
    validateHeaderName(name);
    current = { name, value: line.slice(colon + 1).trimStart() };
    entries.push(current);
  }

  const headers = {};
  const rawHeaders = [];
  for (const { name, value } of entries) {
    rawHeaders.push(name, value);
    const key = name.toLowerCase();
    if (key === "set-cookie") {
      if (headers[key] == null) headers[key] = [value];
      else headers[key].push(value);
    } else {
      headers[key] = headers[key] == null ? value : `${headers[key]}, ${value}`;
    }
  }
  return { headers, rawHeaders };
}

function contentLengthFromHeaders(headers) {
  const value = headers["content-length"];
  if (value == null) return 0;
  const values = Array.isArray(value) ? value : String(value).split(",");
  let expected = null;
  for (const item of values) {
    const text = String(item).trim();
    if (!/^\d+$/.test(text)) throw new Error("Invalid HTTP content-length");
    const next = Number(text);
    if (!Number.isSafeInteger(next)) throw new Error("Invalid HTTP content-length");
    if (expected == null) expected = next;
    else if (expected !== next) throw new Error("Conflicting HTTP content-length");
  }
  return expected ?? 0;
}

function decodeChunkedBody(buffer) {
  const chunks = [];
  let offset = 0;
  for (;;) {
    const text = buffer.subarray(offset).toString("latin1");
    const lineEnd = text.indexOf("\r\n");
    if (lineEnd < 0) return null;
    const sizeText = text.slice(0, lineEnd).split(";", 1)[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) throw new Error("Invalid HTTP chunk size");
    const chunkStart = offset + lineEnd + 2;
    const chunkEnd = chunkStart + size;
    if (buffer.byteLength < chunkEnd + 2) return null;
    if (size === 0) {
      const trailerBytes = buffer.subarray(chunkStart);
      if (trailerBytes.byteLength < 2) return null;
      if (trailerBytes[0] === 13 && trailerBytes[1] === 10) {
        return { body: Buffer.concat(chunks), consumed: chunkStart + 2, trailers: {}, rawTrailers: [] };
      }
      const trailerText = trailerBytes.toString("latin1");
      const trailerEnd = trailerText.indexOf("\r\n\r\n");
      if (trailerEnd < 0) return null;
      const parsedTrailers = parseHeaderLines(trailerText.slice(0, trailerEnd));
      return {
        body: Buffer.concat(chunks),
        consumed: chunkStart + trailerEnd + 4,
        trailers: parsedTrailers.headers,
        rawTrailers: parsedTrailers.rawHeaders,
      };
    }
    chunks.push(buffer.subarray(chunkStart, chunkEnd));
    offset = chunkEnd + 2;
  }
}

function tryParseHttpResponse(buffer, { final = false, method = "GET" } = {}) {
  const text = buffer.toString("latin1");
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const headerText = text.slice(0, headerEnd);
  const [statusLine, ...headerLines] = headerText.split("\r\n");
  const match = /^HTTP\/(\d+)\.(\d+)\s+(\d+)\s*(.*)$/.exec(statusLine);
  if (!match) throw new Error("Invalid HTTP response");
  const statusCode = Number(match[3]);
  const parsedHeaders = parseHeaderLines(headerLines.join("\r\n"));
  const bodyStart = headerEnd + 4;
  const bodyBuffer = buffer.subarray(bodyStart);
  const noBody = method === "HEAD" || method === "CONNECT" || (statusCode >= 100 && statusCode < 200) || statusCode === 204 || statusCode === 304;
  let body = Buffer.alloc(0);
  let consumed = bodyStart;
  if (!noBody) {
    const transferEncoding = String(parsedHeaders.headers["transfer-encoding"] ?? "").toLowerCase();
    if (transferEncoding.split(",").map((item) => item.trim()).includes("chunked")) {
      const decoded = decodeChunkedBody(bodyBuffer);
      if (decoded == null) return null;
      body = decoded.body;
      consumed = bodyStart + decoded.consumed;
      parsedHeaders.trailers = decoded.trailers;
      parsedHeaders.rawTrailers = decoded.rawTrailers;
    } else if (parsedHeaders.headers["content-length"] != null) {
      const contentLength = contentLengthFromHeaders(parsedHeaders.headers);
      if (bodyBuffer.byteLength < contentLength) return null;
      body = bodyBuffer.subarray(0, contentLength);
      consumed = bodyStart + contentLength;
    } else {
      if (!final) return null;
      body = bodyBuffer;
      consumed = buffer.byteLength;
    }
  }
  return {
    consumed,
    head: buffer.subarray(consumed),
    message: new IncomingMessage({
      httpVersion: `${match[1]}.${match[2]}`,
      statusCode,
      statusMessage: match[4] || STATUS_CODES[statusCode] || "",
      headers: parsedHeaders.headers,
      rawHeaders: parsedHeaders.rawHeaders,
      trailers: parsedHeaders.trailers,
      rawTrailers: parsedHeaders.rawTrailers,
      body,
    }),
  };
}

function tryParseHttpRequest(buffer) {
  const text = buffer.toString("latin1");
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const headerText = text.slice(0, headerEnd);
  const [requestLine, ...headerLines] = headerText.split("\r\n");
  const requestMatch = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s+(\S+)\s+HTTP\/(\d+)\.(\d+)$/.exec(requestLine);
  if (!requestMatch) throw new Error("Invalid HTTP request");
  const [, method, url, major, minor] = requestMatch;
  const version = `HTTP/${major}.${minor}`;
  const parsedHeaders = parseHeaderLines(headerLines.join("\r\n"));
  const transferEncoding = String(parsedHeaders.headers["transfer-encoding"] ?? "").toLowerCase();
  const bodyStart = headerEnd + 4;
  const bodyBuffer = buffer.subarray(bodyStart);
  let body = Buffer.alloc(0);
  let consumed = bodyStart;
  let trailers = {};
  let rawTrailers = [];
  if (transferEncoding.split(",").map((item) => item.trim()).includes("chunked")) {
    const decoded = decodeChunkedBody(bodyBuffer);
    if (decoded == null) return null;
    body = decoded.body;
    consumed = bodyStart + decoded.consumed;
    trailers = decoded.trailers;
    rawTrailers = decoded.rawTrailers;
  } else {
    const contentLength = contentLengthFromHeaders(parsedHeaders.headers);
    if (bodyBuffer.byteLength < contentLength) return null;
    body = bodyBuffer.subarray(0, contentLength);
    consumed = bodyStart + contentLength;
  }
  return {
    consumed,
    head: buffer.subarray(consumed),
    message: new IncomingMessage({
      httpVersion: `${major}.${minor}`,
      method,
      url,
      headers: parsedHeaders.headers,
      rawHeaders: parsedHeaders.rawHeaders,
      trailers,
      rawTrailers,
      body,
    }),
    version,
  };
}

function tryParseHttpRequestHead(buffer) {
  const text = buffer.toString("latin1");
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const headerText = text.slice(0, headerEnd);
  const [requestLine, ...headerLines] = headerText.split("\r\n");
  const requestMatch = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s+(\S+)\s+HTTP\/(\d+)\.(\d+)$/.exec(requestLine);
  if (!requestMatch) throw new Error("Invalid HTTP request");
  const [, method, url, major, minor] = requestMatch;
  const version = `HTTP/${major}.${minor}`;
  const parsedHeaders = parseHeaderLines(headerLines.join("\r\n"));
  return { headerText, headerEnd, method, url, version, headers: parsedHeaders.headers, rawHeaders: parsedHeaders.rawHeaders };
}

function headerEntries(message) {
  const entries = [];
  for (const entry of message._headerMap.values()) {
    const value = entry.value;
    if (Array.isArray(value)) {
      for (const item of value) entries.push([entry.name, String(item)]);
    } else {
      entries.push([entry.name, String(value)]);
    }
  }
  return entries;
}

function trailerEntries(message) {
  const entries = [];
  for (const [name, value] of message._trailers ?? []) {
    if (Array.isArray(value)) {
      for (const item of value) entries.push([name, String(item)]);
    } else {
      entries.push([name, String(value)]);
    }
  }
  return entries;
}

export function _writeServerResponse(socket, response, options = {}) {
  const body = response._bodyBuffer();
  const status = response.statusCode || 200;
  const statusText = response.statusMessage || STATUS_CODES[status] || "OK";
  const headers = headerEntries(response);
  const trailers = trailerEntries(response);
  const lowerHeaders = new Set(headers.map(([name]) => String(name).toLowerCase()));
  const useChunked = trailers.length > 0 && !lowerHeaders.has("content-length");
  const lines = [`HTTP/1.1 ${status} ${statusText}`];
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  if (trailers.length > 0 && !lowerHeaders.has("trailer")) {
    lines.push(`Trailer: ${trailers.map(([name]) => name).join(", ")}`);
  }
  if (useChunked && !lowerHeaders.has("transfer-encoding")) {
    lines.push("Transfer-Encoding: chunked");
  } else if (!useChunked && !lowerHeaders.has("content-length")) {
    lines.push(`Content-Length: ${body.byteLength}`);
  }
  if (!lowerHeaders.has("connection")) lines.push(options.keepAlive ? "Connection: keep-alive" : "Connection: close");
  lines.push("", "");
  if (useChunked) {
    const trailerLines = trailers.map(([name, value]) => `${name}: ${value}`);
    socket.write(Buffer.concat([
      Buffer.from(lines.join("\r\n")),
      Buffer.from(`${body.byteLength.toString(16)}\r\n`),
      body,
      Buffer.from(`\r\n0\r\n${trailerLines.join("\r\n")}\r\n\r\n`),
    ]));
  } else {
    socket.write(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
  }
  if (!options.keepAlive) socket.end();
}

function websocketAcceptKey(key) {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function readUInt16BE(bytes, offset = 0) {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUInt64BE(bytes, offset = 0) {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
  return value;
}

function websocketFrame(opcode, payload = Buffer.alloc(0), masked = true) {
  const body = Buffer.from(bytesFromBody(payload));
  const header = [];
  header.push(0x80 | (opcode & 0x0f));
  if (body.byteLength < 126) {
    header.push((masked ? 0x80 : 0) | body.byteLength);
  } else if (body.byteLength <= 0xffff) {
    header.push((masked ? 0x80 : 0) | 126, (body.byteLength >> 8) & 0xff, body.byteLength & 0xff);
  } else {
    const length = BigInt(body.byteLength);
    header.push((masked ? 0x80 : 0) | 127);
    for (let shift = 56n; shift >= 0n; shift -= 8n) header.push(Number((length >> shift) & 0xffn));
  }

  if (!masked) return Buffer.concat([Buffer.from(header), body]);
  const mask = randomBytes(4);
  const output = Buffer.from(body);
  for (let index = 0; index < output.byteLength; index += 1) output[index] ^= mask[index % 4];
  return Buffer.concat([Buffer.from(header), mask, output]);
}

function parseWebSocketFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.byteLength - offset >= 2) {
    const frameStart = offset;
    const first = buffer[offset++];
    const second = buffer[offset++];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    if (length === 126) {
      if (buffer.byteLength - offset < 2) return { frames, remaining: buffer.subarray(frameStart) };
      length = readUInt16BE(buffer, offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.byteLength - offset < 8) return { frames, remaining: buffer.subarray(frameStart) };
      const bigLength = readUInt64BE(buffer, offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("WebSocket frame too large");
      length = Number(bigLength);
      offset += 8;
    }
    if (masked && buffer.byteLength - offset < 4) return { frames, remaining: buffer.subarray(frameStart) };
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (buffer.byteLength - offset < length) return { frames, remaining: buffer.subarray(frameStart) };
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    offset += length;
    if (mask) {
      for (let index = 0; index < payload.byteLength; index += 1) payload[index] ^= mask[index % 4];
    }
    frames.push({ fin, opcode, payload });
  }
  return { frames, remaining: buffer.subarray(offset) };
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
    this.httpVersion = String(init.httpVersion ?? "1.1");
    const [major = "1", minor = "1"] = this.httpVersion.split(".");
    this.httpVersionMajor = Number(major) || 1;
    this.httpVersionMinor = Number(minor) || 0;
    this.method = init.method;
    this.url = init.url;
    this.statusCode = init.statusCode;
    this.statusMessage = init.statusMessage ?? STATUS_CODES[this.statusCode] ?? "";
    this.socket = init.socket ?? null;
    this.connection = this.socket;
    this.trailers = init.trailers ?? {};
    this.rawTrailers = init.rawTrailers ?? [];
    this._body = bytesFromBody(init.body);
    queueMicrotask(() => {
      if (this._body.byteLength > 0) this.push(Buffer.from(this._body));
      this.push(null);
    });
  }

  setTimeout(_timeout, callback = undefined) {
    if (typeof callback === "function") this.once("timeout", callback);
    this.socket?.setTimeout?.(Number(_timeout) || 0, () => this.emit("timeout"));
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
    this._trailers = [];
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

  addTrailers(headers = {}) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      validateHeaderName(name);
      this._trailers.push([String(name), value]);
    }
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
    this._resolveResponse(this);
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

  createConnection(options = {}, callback = undefined) {
    const connectOptions = { ...this.options, ...options };
    if (connectOptions.socketPath != null) connectOptions.path = connectOptions.socketPath;
    else delete connectOptions.path;
    return netConnect(connectOptions, callback);
  }

  getName(options = {}) {
    if (options.socketPath != null) return `${options.socketPath}:${options.localAddress ?? ""}`;
    return `${options.host ?? options.hostname ?? "localhost"}:${options.port ?? ""}:${options.localAddress ?? ""}`;
  }

  _activeCount(name) {
    return (this.sockets[name] ?? []).filter((socket) => !socket.destroyed).length;
  }

  _rememberSocket(name, socket) {
    const list = this.sockets[name] ?? [];
    if (!list.includes(socket)) list.push(socket);
    this.sockets[name] = list;
    socket.once?.("close", () => this.removeSocket(socket, { _agentName: name }));
  }

  _takeSocket(options = {}) {
    const name = options._agentName ?? this.getName(options);
    const free = this.freeSockets[name] ?? [];
    while (free.length > 0) {
      const socket = free.shift();
      if (!socket?.destroyed && socket.writable !== false) {
        this.sockets[name] = this.sockets[name] ?? [];
        if (!this.sockets[name].includes(socket)) this.sockets[name].push(socket);
        return socket;
      }
    }
    if (free.length === 0) delete this.freeSockets[name];
    return null;
  }

  addRequest(request, options = {}) {
    const name = options._agentName ?? this.getName(options);
    options._agentName = name;
    const socket = this._takeSocket(options);
    if (socket) {
      queueMicrotask(() => request.onSocket(socket, true));
      return;
    }
    if (this._activeCount(name) >= Number(this.maxSockets)) {
      const queue = this.requests[name] ?? [];
      queue.push({ request, options: { ...options } });
      this.requests[name] = queue;
      return;
    }
    const created = this.createConnection(options, () => {});
    this._rememberSocket(name, created);
    request.onSocket(created, false);
  }

  removeSocket(socket, options = {}) {
    const name = options._agentName ?? this.getName(options);
    const active = this.sockets[name] ?? [];
    this.sockets[name] = active.filter((item) => item !== socket);
    if (this.sockets[name].length === 0) delete this.sockets[name];
    const free = this.freeSockets[name] ?? [];
    this.freeSockets[name] = free.filter((item) => item !== socket);
    if (this.freeSockets[name].length === 0) delete this.freeSockets[name];
  }

  keepSocketAlive(socket) {
    socket.setKeepAlive?.(true);
    socket.unref?.();
    return true;
  }

  reuseSocket(socket, request) {
    socket.ref?.();
    request.reusedSocket = true;
  }

  _releaseSocket(socket, options = {}) {
    const name = options._agentName ?? this.getName(options);
    this.removeSocket(socket, { ...options, _agentName: name });
    const queued = this.requests[name]?.shift();
    if (queued) {
      if ((this.requests[name] ?? []).length === 0) delete this.requests[name];
      this._rememberSocket(name, socket);
      this.reuseSocket(socket, queued.request);
      queueMicrotask(() => queued.request.onSocket(socket, true));
      return;
    }
    if (!this.keepAlive || socket.destroyed || socket.writable === false || this.keepSocketAlive(socket) === false) {
      socket.destroy?.();
      return;
    }
    const free = this.freeSockets[name] ?? [];
    if (free.length >= Number(this.maxFreeSockets)) {
      socket.destroy?.();
      return;
    }
    free.push(socket);
    this.freeSockets[name] = free;
    this.emit("free", socket, options);
  }

  destroy() {
    for (const socket of Object.values(this.sockets).flat()) socket.destroy?.();
    for (const socket of Object.values(this.freeSockets).flat()) socket.destroy?.();
    this.requests = {};
    this.sockets = {};
    this.freeSockets = {};
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
    this.path = requestPath(this.url, normalized.options);
    this.host = this.url.host;
    this.protocol = this.url.protocol;
    this.aborted = false;
    this.destroyed = false;
    this._options = normalized.options;
    this._socket = null;
    this._agentOptions = null;
    this.agent = normalized.options.agent === false ? null : (normalized.options.agent ?? globalAgent);
    this.reusedSocket = false;
    this._responseEmitted = false;
    this._closeEmitted = false;
    this._timeout = 0;
    this._timeoutTimer = null;
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
    if (this.destroyed) return this;
    this.destroyed = true;
    this._clearTimeoutTimer();
    if (this._socket) this._socket.destroy();
    if (error) this.emit("error", error);
    this._emitClose();
    return this;
  }

  flushHeaders() {
    this.headersSent = true;
  }

  setNoDelay() { return this; }
  setSocketKeepAlive() { return this; }
  setTimeout(timeout, callback = undefined) {
    this._timeout = Number(timeout) || 0;
    if (typeof callback === "function") this.once("timeout", callback);
    if (this._socket) this._installTimeout();
    return this;
  }

  _clearTimeoutTimer() {
    if (this._timeoutTimer != null) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  }

  _installTimeout() {
    this._clearTimeoutTimer();
    if (!(this._timeout > 0) || this.destroyed) return;
    this._timeoutTimer = setTimeout(() => {
      this._timeoutTimer = null;
      if (!this.destroyed) {
        this.emit("timeout");
        this._socket?.emit?.("timeout");
      }
    }, this._timeout);
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit("close");
  }

  _emitParsedResponse(parsed) {
    if (this._responseEmitted || parsed == null) return;
    this._responseEmitted = true;
    if (this.method === "CONNECT" && parsed.message.statusCode >= 200 && parsed.message.statusCode < 300) {
      this.emit("connect", parsed.message, this._socket, Buffer.from(parsed.head ?? []));
      return;
    }
    if (parsed.message.statusCode === 101) {
      this.emit("upgrade", parsed.message, this._socket, Buffer.from(parsed.head ?? []));
      return;
    }
    this.emit("response", parsed.message);
  }

  _dispatch() {
    if (this.aborted) return;
    const requestOptions = {
      ...this._options,
      host: this.url.hostname || "localhost",
      hostname: this.url.hostname || "localhost",
      port: Number(this._options._port || 80),
      _agentName: this.agent?.getName?.({
        ...this._options,
        host: this.url.hostname || "localhost",
        hostname: this.url.hostname || "localhost",
        port: Number(this._options._port || 80),
      }),
    };
    this._agentOptions = requestOptions;
    if (this.agent && typeof this.agent.addRequest === "function") {
      this.agent.addRequest(this, requestOptions);
      return;
    }
    const socket = netConnect(requestOptions);
    this.onSocket(socket, false);
  }

  onSocket(socket, reused = false) {
    if (this.aborted || this.destroyed) {
      socket.destroy?.();
      return;
    }
    this._socket = socket;
    this.reusedSocket = Boolean(reused);
    let responseBuffer = Buffer.alloc(0);
    let completed = false;
    let continueBody = null;
    let continueTimer = null;
    const sendContinueBody = () => {
      if (continueBody == null) return;
      const body = continueBody;
      continueBody = null;
      if (continueTimer != null) {
        clearTimeout(continueTimer);
        continueTimer = null;
      }
      if (body.byteLength > 0) socket.write(body);
    };
    const cleanup = () => {
      this._clearTimeoutTimer();
      if (continueTimer != null) {
        clearTimeout(continueTimer);
        continueTimer = null;
      }
      socket.off?.("connect", onConnect);
      socket.off?.("data", onData);
      socket.off?.("end", onEnd);
      socket.off?.("error", onError);
    };
    const releaseOrClose = (parsed) => {
      if (completed) return;
      completed = true;
      cleanup();
      const lowerConnection = String(parsed?.message?.headers?.connection ?? "").toLowerCase();
      const isTunnel = (this.method === "CONNECT" && parsed?.message?.statusCode >= 200 && parsed?.message?.statusCode < 300) || parsed?.message?.statusCode === 101;
      const canKeepAlive = this.agent?.keepAlive && lowerConnection !== "close" && this.method !== "CONNECT" && parsed?.message?.statusCode !== 101;
      if (!isTunnel) {
        if (canKeepAlive) this.agent._releaseSocket?.(socket, this._agentOptions ?? this._options);
        else socket.end?.();
      }
      this._emitClose();
    };
    const onConnect = () => {
      if (this.aborted || this.destroyed) return;
      this._installTimeout();
      const body = this.method === "HEAD" ? Buffer.alloc(0) : this._bodyBuffer();
      if (!this.hasHeader("host")) this.setHeader("Host", this.url.host);
      if (body.byteLength > 0 && !this.hasHeader("content-length")) this.setHeader("Content-Length", body.byteLength);
      if (!this.hasHeader("connection")) this.setHeader("Connection", this.agent?.keepAlive ? "keep-alive" : "close");
      const lines = [`${this.method} ${this.path} HTTP/1.1`];
      for (const [name, value] of Object.entries(this.getHeaders())) {
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${name}: ${item}`);
        } else {
          lines.push(`${name}: ${value}`);
        }
      }
      lines.push("", "");
      const expectsContinue = String(this.getHeader("expect") ?? "").toLowerCase() === "100-continue";
      if (expectsContinue && body.byteLength > 0) {
        continueBody = body;
        socket.write(Buffer.from(lines.join("\r\n")));
        continueTimer = setTimeout(sendContinueBody, 1000);
      } else {
        socket.write(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
      }
    };
    const onData = (chunk) => {
      if (this._responseEmitted) return;
      this._installTimeout();
      responseBuffer = Buffer.concat([responseBuffer, Buffer.from(chunk)]);
      for (;;) {
        const parsed = tryParseHttpResponse(responseBuffer, { method: this.method });
        if (parsed == null) return;
        responseBuffer = responseBuffer.subarray(parsed.consumed);
        if (parsed.message.statusCode >= 100 && parsed.message.statusCode < 200 && parsed.message.statusCode !== 101) {
          if (parsed.message.statusCode === 100) {
            this.emit("continue");
            sendContinueBody();
          } else {
            this.emit("information", {
              statusCode: parsed.message.statusCode,
              statusMessage: parsed.message.statusMessage,
              headers: parsed.message.headers,
              rawHeaders: parsed.message.rawHeaders,
            });
          }
          continue;
        }
        this._emitParsedResponse(parsed);
        releaseOrClose(parsed);
        return;
      }
    };
    const onEnd = () => {
      if (!this._responseEmitted) {
        const parsed = tryParseHttpResponse(responseBuffer, { final: true, method: this.method });
        this._emitParsedResponse(parsed);
      }
      cleanup();
      this._emitClose();
    };
    const onError = (error) => {
      cleanup();
      this.emit("error", error);
      this._emitClose();
    };
    socket.once("connect", onConnect);
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
    if (reused || socket.readyState === "open") queueMicrotask(onConnect);
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
    this.timeout = Number(options?.timeout ?? 0);
    this.requestTimeout = Number(options?.requestTimeout ?? 300000);
    this.headersTimeout = Number(options?.headersTimeout ?? 60000);
    this.keepAliveTimeout = Number(options?.keepAliveTimeout ?? 5000);
    if (typeof requestListener === "function") this.on("request", requestListener);
  }

  listen(...args) {
    const [options, callback] = normalizeListenArgs(args);
    if (typeof callback === "function") this.once("listening", callback);
    const connectionListener = (socket) => {
      this.emit("connection", socket);
      let buffer = Buffer.alloc(0);
      const continuedHeaders = new Set();
      let headersTimer = null;
      let requestTimer = null;
      let keepAliveTimer = null;
      const clearKeepAliveTimer = () => {
        if (keepAliveTimer != null) clearTimeout(keepAliveTimer);
        keepAliveTimer = null;
      };
      const clearParserTimers = () => {
        if (headersTimer != null) clearTimeout(headersTimer);
        if (requestTimer != null) clearTimeout(requestTimer);
        headersTimer = null;
        requestTimer = null;
      };
      const failParserTimeout = (message) => {
        const error = new Error(message);
        error.code = "ERR_HTTP_REQUEST_TIMEOUT";
        clearParserTimers();
        if (this.listenerCount("clientError") > 0) this.emit("clientError", error, socket);
        else {
          try { socket.end("HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch {}
          socket.destroy?.();
        }
      };
      const refreshHeadersTimer = () => {
        if (!(this.headersTimeout > 0) || headersTimer != null) return;
        headersTimer = setTimeout(() => failParserTimeout("Request header timeout"), this.headersTimeout);
      };
      const refreshRequestTimer = () => {
        if (!(this.requestTimeout > 0) || requestTimer != null) return;
        requestTimer = setTimeout(() => failParserTimeout("Request timeout"), this.requestTimeout);
      };
      refreshHeadersTimer();
      if (this.timeout > 0) {
        socket.setTimeout?.(this.timeout, () => {
          this.emit("timeout", socket);
          if (this.listenerCount("timeout") === 0) socket.destroy?.();
        });
      }
      socket.on("data", (chunk) => {
        clearKeepAliveTimer();
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        const head = tryParseHttpRequestHead(buffer);
        if (head != null) {
          if (headersTimer != null) {
            clearTimeout(headersTimer);
            headersTimer = null;
          }
          const contentLength = Number(head.headers["content-length"] ?? 0) || 0;
          if (contentLength > 0 && buffer.byteLength < head.headerEnd + 4 + contentLength) refreshRequestTimer();
          const expect = String(head.headers.expect ?? "").toLowerCase();
          if (expect === "100-continue" && this.listenerCount("checkContinue") === 0 && !continuedHeaders.has(head.headerText)) {
            continuedHeaders.add(head.headerText);
            socket.write("HTTP/1.1 100 Continue\r\n\r\n");
          }
        }
        for (;;) {
          const parsed = tryParseHttpRequest(buffer);
          if (parsed == null) return;
          if (requestTimer != null) {
            clearTimeout(requestTimer);
            requestTimer = null;
          }
          const lowerConnection = String(parsed.message.headers.connection ?? "").toLowerCase();
          const upgrade = parsed.message.headers.upgrade;
          const head = parsed.head ?? Buffer.alloc(0);
          buffer = buffer.subarray(parsed.consumed);
          parsed.message.socket = socket;
          parsed.message.connection = socket;
          if (String(parsed.message.method).toUpperCase() === "CONNECT") {
            if (this.listenerCount("connect") > 0) this.emit("connect", parsed.message, socket, head);
            else socket.destroy();
            return;
          }
          if (upgrade != null || lowerConnection.split(",").map((item) => item.trim()).includes("upgrade")) {
            if (this.listenerCount("upgrade") > 0) this.emit("upgrade", parsed.message, socket, head);
            else socket.destroy();
            return;
          }
          const keepAlive = lowerConnection !== "close";
          const response = new ServerResponse((completed) => {
            _writeServerResponse(socket, completed, { keepAlive });
            if (keepAlive && this.keepAliveTimeout > 0) {
              clearKeepAliveTimer();
              keepAliveTimer = setTimeout(() => socket.destroy?.(), this.keepAliveTimeout);
            }
          });
          if (String(parsed.message.headers.expect ?? "").toLowerCase() === "100-continue" && this.listenerCount("checkContinue") > 0) {
            this.emit("checkContinue", parsed.message, response);
          } else {
            this.emit("request", parsed.message, response);
          }
        }
      });
      socket.on("close", () => {
        clearParserTimers();
        clearKeepAliveTimer();
      });
    };
    this._native = createNetServer(connectionListener);
    this._native.on("error", (error) => this.emit("error", error));
    this._native.on("close", () => {
      this.listening = false;
      this.emit("close");
    });
    this._native.listen(options, () => {
      this.listening = true;
      this.emit("listening");
    });
    return this;
  }

  close(callback = undefined) {
    if (typeof callback === "function") this.once("close", callback);
    if (!this._native) {
      queueMicrotask(() => this.emit("close"));
      return this;
    }
    const native = this._native;
    this._native = null;
    native.close();
    return this;
  }

  address() {
    if (!this._native) return null;
    return this._native.address();
  }

  ref() {
    this._native?.ref?.();
    return this;
  }

  unref() {
    this._native?.unref?.();
    return this;
  }

  setTimeout(timeout = 0, callback = undefined) {
    this.timeout = Number(timeout) || 0;
    if (typeof callback === "function") this.on("timeout", callback);
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
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, protocols = undefined) {
    super();
    const parsed = new URL(String(url));
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new SyntaxError("WebSocket URL protocol must be ws: or wss:");
    }
    this.CONNECTING = WebSocket.CONNECTING;
    this.OPEN = WebSocket.OPEN;
    this.CLOSING = WebSocket.CLOSING;
    this.CLOSED = WebSocket.CLOSED;
    this.readyState = WebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.url = parsed.href;
    this.extensions = "";
    this.protocol = "";
    this.binaryType = "blob";
    this.onopen = null;
    this.onerror = null;
    this.onclose = null;
    this.onmessage = null;
    this._socket = null;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;
    this._protocols = Array.isArray(protocols) ? protocols.map(String) : protocols == null ? [] : [String(protocols)];
    this._connect(parsed);
  }

  addEventListener(name, handler) {
    if (typeof handler === "function") this.on(name, handler);
  }

  removeEventListener(name, handler) {
    if (typeof handler === "function") this.off(name, handler);
  }

  dispatchEvent(event) {
    const property = `on${event.type}`;
    if (typeof this[property] === "function") this[property](event);
    this.emit(event.type, event);
    return true;
  }

  _connect(parsed) {
    const secure = parsed.protocol === "wss:";
    const explicitPort = parsed.port ?? String(parsed.href).match(/^wss?:\/\/[^/:]+:(\d+)/)?.[1];
    const port = Number(explicitPort || (secure ? 443 : 80));
    const host = parsed.hostname || "localhost";
    const key = randomBytes(16).toString("base64");
    const socket = secure
      ? tlsConnect({ host, port, servername: host, rejectUnauthorized: false })
      : netConnect(port, host);
    this._socket = socket;
    socket.on("connect", () => {
      const path = `${parsed.pathname || "/"}${parsed.search || ""}`;
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}${explicitPort ? `:${explicitPort}` : ""}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
      ];
      if (this._protocols.length > 0) lines.push(`Sec-WebSocket-Protocol: ${this._protocols.join(", ")}`);
      lines.push("", "");
      socket.write(lines.join("\r\n"));
    });
    socket.on("data", (chunk) => this._handleData(Buffer.from(chunk), key));
    socket.on("error", (error) => this._fail(error));
    socket.on("close", () => {
      if (this.readyState !== WebSocket.CLOSED) this._close(1006, "", false);
    });
  }

  _handleData(chunk, key) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    if (this.readyState === WebSocket.CONNECTING) {
      const text = this._buffer.toString("latin1");
      const headerEnd = text.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = text.slice(0, headerEnd);
      const [statusLine, ...headerLines] = headerText.split("\r\n");
      const status = Number(statusLine.split(/\s+/)[1]);
      const headers = parseHeaderLines(headerLines.join("\r\n")).headers;
      if (status !== 101 || String(headers.upgrade ?? "").toLowerCase() !== "websocket" ||
          String(headers["sec-websocket-accept"] ?? "") !== websocketAcceptKey(key)) {
        this._fail(new Error("Invalid WebSocket upgrade response"));
        return;
      }
      this.protocol = String(headers["sec-websocket-protocol"] ?? "");
      this.readyState = WebSocket.OPEN;
      this._buffer = this._buffer.subarray(headerEnd + 4);
      this.dispatchEvent({ type: "open", target: this });
    }

    const parsed = parseWebSocketFrames(this._buffer);
    this._buffer = parsed.remaining;
    for (const frame of parsed.frames) this._handleFrame(frame);
  }

  _handleFrame(frame) {
    if (frame.opcode === 0x8) {
      const code = frame.payload.byteLength >= 2 ? readUInt16BE(frame.payload, 0) : 1000;
      const reason = frame.payload.byteLength > 2 ? frame.payload.subarray(2).toString("utf8") : "";
      if (this.readyState === WebSocket.OPEN) this._socket?.write?.(websocketFrame(0x8, frame.payload));
      this._close(code, reason, true);
      return;
    }
    if (frame.opcode === 0x9) {
      if (this.readyState === WebSocket.OPEN) this._socket?.write?.(websocketFrame(0xA, frame.payload));
      return;
    }
    if (frame.opcode === 0xA) return;

    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      this._fragmentOpcode = frame.opcode;
      this._fragments = [frame.payload];
    } else if (frame.opcode === 0x0 && this._fragmentOpcode) {
      this._fragments.push(frame.payload);
    } else {
      return;
    }
    if (!frame.fin) return;

    const payload = Buffer.concat(this._fragments);
    const opcode = this._fragmentOpcode;
    this._fragments = [];
    this._fragmentOpcode = 0;
    const data = opcode === 0x1
      ? payload.toString("utf8")
      : this.binaryType === "arraybuffer"
        ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
        : payload;
    this.dispatchEvent(new MessageEvent("message", { data, origin: this.url, source: this }));
  }

  _fail(error) {
    this.dispatchEvent({ type: "error", error, message: error?.message ?? String(error), target: this });
    this._close(1006, "", false);
  }

  _close(code = 1000, reason = "", wasClean = true) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    try { this._socket?.destroy?.(); } catch {}
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
  }

  send(data) {
    if (this.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
    const opcode = typeof data === "string" ? 0x1 : 0x2;
    const frame = websocketFrame(opcode, data);
    this.bufferedAmount += frame.byteLength;
    const ok = this._socket.write(frame, () => {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - frame.byteLength);
    });
    return ok;
  }

  close(code = 1000, reason = "") {
    if (this.readyState === WebSocket.CLOSED || this.readyState === WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSING;
    const payload = Buffer.alloc(2 + Buffer.byteLength(String(reason)));
    const closeCode = Number(code) || 1000;
    payload[0] = (closeCode >> 8) & 0xff;
    payload[1] = closeCode & 0xff;
    payload.set(Buffer.from(String(reason)), 2);
    this._socket?.write?.(websocketFrame(0x8, payload));
    this._socket?.end?.();
  }
};

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
