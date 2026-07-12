import { EventEmitter } from "./events.js";
import { Readable, Writable } from "./stream.js";
import { Buffer } from "./buffer.js";
import { connect as netConnect, createServer as createNetServer } from "./net.js";
import { connect as tlsConnect } from "./tls.js";
import { createHash, randomBytes } from "./crypto.js";
import { Headers } from "../bun/index.js";
import { AsyncResource } from "./async_hooks.js";

const asyncIdSymbol = Symbol.for("nodejs.async_id_symbol");
const socketAsyncResourceSymbol = Symbol("cottontail.http.socketAsyncResource");

// Module evaluation order can reach this file before bun/index.js installs the
// Symbol.dispose/asyncDispose polyfills, so ensure the shared symbol here.
export function ensureAsyncDisposeSymbol() {
  if (Symbol.asyncDispose == null) {
    Object.defineProperty(Symbol, "asyncDispose", {
      value: Symbol.for("Symbol.asyncDispose"),
      configurable: true,
    });
  }
  return Symbol.asyncDispose;
}

// The vendored "ws" package constructs buffer views via Buffer[Symbol.species]
// (new FastBuffer(arrayBuffer, byteOffset, length)). The runtime's Buffer does
// not define Symbol.species, so provide a compatible constructor here. This
// copies instead of aliasing; a zero-copy version belongs in bun/ffi.js next to
// CottontailBuffer.
(() => {
  const BufferCtor = globalThis.Buffer;
  if (typeof BufferCtor !== "function" || BufferCtor[Symbol.species] != null) return;
  function BufferSpecies(input, byteOffset = undefined, length = undefined) {
    if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && input instanceof SharedArrayBuffer)) {
      const offset = Number(byteOffset ?? 0);
      const view = length === undefined ? new Uint8Array(input, offset) : new Uint8Array(input, offset, Number(length));
      return BufferCtor.from(view);
    }
    if (typeof input === "number") return BufferCtor.alloc(input);
    return BufferCtor.from(input, byteOffset, length);
  }
  try {
    Object.defineProperty(BufferCtor, Symbol.species, {
      get() { return BufferSpecies; },
      configurable: true,
    });
  } catch {}
})();

function assignSocketAsyncId(socket) {
  const previous = socket?.[socketAsyncResourceSymbol];
  if (previous && typeof previous.emitDestroy === "function") previous.emitDestroy();
  const resource = new AsyncResource("TCPWRAP");
  Object.defineProperty(socket, socketAsyncResourceSymbol, {
    value: resource,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(socket, asyncIdSymbol, {
    value: resource.asyncId(),
    writable: true,
    configurable: true,
  });
}

function markSocketAsyncFree(socket) {
  const resource = socket?.[socketAsyncResourceSymbol];
  if (resource && typeof resource.emitDestroy === "function") resource.emitDestroy();
  if (socket) {
    socket[socketAsyncResourceSymbol] = null;
    socket[asyncIdSymbol] = -1;
  }
}

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

export const maxHeaderSize = Number(globalThis.process?.env?.BUN_HTTP_MAX_HEADER_SIZE ?? "") || 16 * 1024;

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
    const urlPath = String(path).startsWith("/") ? path : "/";
    url = new URL(`${protocol}//${hostname}${port}${urlPath}`);
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

function findByte(buffer, byte, from = 0) {
  const length = buffer.byteLength;
  for (let index = Math.max(0, from); index < length; index += 1) {
    if (buffer[index] === byte) return index;
  }
  return -1;
}

function findHeaderEnd(buffer, from = 0) {
  const length = buffer.byteLength;
  for (let index = Math.max(0, from); index + 3 < length; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10 && buffer[index + 2] === 13 && buffer[index + 3] === 10) {
      return index;
    }
  }
  return -1;
}

// Incremental chunked transfer-encoding decoder that operates on bytes and
// never re-scans previously consumed data.
class ChunkedDecoder {
  constructor() {
    this.chunks = [];
    this.byteLength = 0;
    this.state = "size";
    this.lineBytes = [];
    this.lineLength = 0;
    this.remaining = 0;
    this.skip = 0;
    this.trailerLines = [];
    this.done = false;
    this.trailers = {};
    this.rawTrailers = [];
  }

  _takeLine(buffer, offset) {
    const nl = findByte(buffer, 10, offset);
    if (nl < 0) {
      const rest = buffer.subarray(offset);
    this.lineBytes.push(rest);
      this.lineLength += rest.byteLength;
      if (this.lineLength > 65536) throw new Error("Invalid HTTP chunk size");
      return null;
    }
    this.lineBytes.push(buffer.subarray(offset, nl + 1));
    const raw = this.lineBytes.length === 1 ? this.lineBytes[0] : Buffer.concat(this.lineBytes);
    this.lineBytes = [];
    this.lineLength = 0;
    const text = Buffer.from(raw).toString("latin1").replace(/\r?\n$/, "");
    return { text, next: nl + 1 };
  }

  // Returns leftover bytes once the terminating chunk (and trailers) have been
  // consumed; returns null while more input is required.
  push(buffer) {
    let offset = 0;
    const length = buffer.byteLength;
    while (offset < length) {
      if (this.state === "size") {
        const line = this._takeLine(buffer, offset);
        if (line == null) return null;
        offset = line.next;
        const sizeText = line.text.split(";", 1)[0].trim();
        if (sizeText === "") continue; // tolerate stray blank line
        if (!/^[0-9a-fA-F]+$/.test(sizeText)) throw new Error("Invalid HTTP chunk size");
        const size = Number.parseInt(sizeText, 16);
        if (!Number.isFinite(size) || size < 0) throw new Error("Invalid HTTP chunk size");
        if (size === 0) {
          this.state = "trailers";
          continue;
        }
        this.remaining = size;
        this.state = "data";
        continue;
      }
      if (this.state === "data") {
        const take = Math.min(this.remaining, length - offset);
        this.chunks.push(buffer.subarray(offset, offset + take));
        this.byteLength += take;
        this.remaining -= take;
        offset += take;
        if (this.remaining === 0) {
          this.state = "crlf";
          this.skip = 2;
        }
        continue;
      }
      if (this.state === "crlf") {
        while (this.skip > 0 && offset < length) {
          const byte = buffer[offset];
          if ((this.skip === 2 && byte !== 13) || (this.skip === 1 && byte !== 10)) {
            throw new Error("Invalid chunk ending");
          }
          offset += 1;
          this.skip -= 1;
        }
        if (this.skip === 0) this.state = "size";
        continue;
      }
      if (this.state === "trailers") {
        const line = this._takeLine(buffer, offset);
        if (line == null) return null;
        offset = line.next;
        if (line.text === "") {
          const parsed = this.trailerLines.length > 0 ? parseHeaderLines(this.trailerLines.join("\r\n")) : null;
          this.trailers = parsed?.headers ?? {};
          this.rawTrailers = parsed?.rawHeaders ?? [];
          this.done = true;
          return buffer.subarray(offset);
        }
        this.trailerLines.push(line.text);
        continue;
      }
      throw new Error("Invalid chunked decoder state");
    }
    return null;
  }

  body() {
    if (this.chunks.length === 0) return kEmptyBuffer;
    if (this.chunks.length === 1) return Buffer.from(this.chunks[0]);
    return Buffer.concat(this.chunks);
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
    this._incomingBody = bytesFromBody(init.body);
    queueMicrotask(() => {
      if (this._incomingBody.byteLength > 0) this.push(Buffer.from(this._incomingBody));
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
    // node:stream is backed by readable-stream, whose prototype defines
    // writableEnded as a getter-only accessor; shadow it with an own,
    // assignable data property since http messages track it themselves.
    Object.defineProperty(this, "writableEnded", {
      value: false,
      writable: true,
      enumerable: true,
      configurable: true,
    });
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

const kEmptyBuffer = Buffer.alloc(0);

function bodyBufferFrom(chunk, encoding = undefined) {
  if (typeof chunk === "string") return Buffer.from(chunk, encoding ?? "utf8");
  // bytesFromBody returns a view without copying for Buffer/TypedArray inputs.
  return bytesFromBody(chunk);
}

export class ServerResponse extends OutgoingMessage {
  constructor(req = undefined) {
    super();
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.req = typeof req === "object" && req !== null ? req : null;
    this.socket = null;
    this.connection = null;
    this.sendDate = true;
    this.shouldKeepAlive = true;
    this.strictContentLength = false;
    Object.defineProperty(this, "writableFinished", {
      get: () => this._finishEmitted,
      configurable: true,
    });
    this._keepAlive = true;
    this._suppressBody = this.req ? String(this.req.method ?? "").toUpperCase() === "HEAD" : false;
    this._chunkedWire = false;
    this._headerSent = false;
    this._bodyWritten = false;
    this._pendingHeadBlock = null;
    this._onFinishFlushed = null;
    this._drainForwarder = null;
    this._socketCloseForwarder = null;
    this._closeEmitted = false;
    this._finishEmitted = false;
  }

  assignSocket(socket) {
    if (!socket) return this;
    if (socket._httpMessage) {
      const error = new Error("Socket already assigned");
      error.code = "ERR_HTTP_SOCKET_ASSIGNED";
      throw error;
    }
    this.socket = socket;
    this.connection = socket;
    socket._httpMessage = this;
    this._drainForwarder = () => this.emit("drain");
    socket.on?.("drain", this._drainForwarder);
    this._socketCloseForwarder = () => {
      if (!this._finishEmitted) this._emitCloseOnce();
    };
    socket.once?.("close", this._socketCloseForwarder);
    if (this._pendingHeadBlock != null) {
      const block = this._pendingHeadBlock;
      this._pendingHeadBlock = null;
      if (!socket.destroyed && socket.writable) socket.write(block);
    }
    this.emit("socket", socket);
    return this;
  }

  detachSocket(socket = undefined) {
    const target = socket ?? this.socket;
    if (target) {
      if (this._drainForwarder) target.off?.("drain", this._drainForwarder);
      if (this._socketCloseForwarder) target.off?.("close", this._socketCloseForwarder);
      if (target._httpMessage === this) target._httpMessage = null;
    }
    this._drainForwarder = null;
    this._socketCloseForwarder = null;
    this.socket = null;
    this.connection = null;
    return this;
  }

  setHeader(name, value) {
    if (this._headerSent) {
      const error = new Error("Cannot set headers after they are sent to the client");
      error.code = "ERR_HTTP_HEADERS_SENT";
      throw error;
    }
    return super.setHeader(name, value);
  }

  removeHeader(name) {
    if (this._headerSent) {
      const error = new Error("Cannot remove headers after they are sent to the client");
      error.code = "ERR_HTTP_HEADERS_SENT";
      throw error;
    }
    return super.removeHeader(name);
  }

  writeHead(statusCode, statusMessage = undefined, headers = undefined) {
    if (this._headerSent) {
      const error = new Error("Cannot write headers after they are sent to the client");
      error.code = "ERR_HTTP_HEADERS_SENT";
      throw error;
    }
    if (typeof statusMessage === "object" && statusMessage !== null) {
      headers = statusMessage;
      statusMessage = undefined;
    }
    this.statusCode = Number(statusCode);
    if (statusMessage != null) this.statusMessage = String(statusMessage);
    if (headers) {
      if (Array.isArray(headers)) {
        for (let index = 0; index + 1 < headers.length; index += 2) this.setHeader(headers[index], headers[index + 1]);
      } else {
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      }
    }
    this._flushHead();
    return this;
  }

  writeContinue(callback = undefined) {
    const socket = this.socket;
    if (socket && !socket.destroyed && socket.writable) socket.write("HTTP/1.1 100 Continue\r\n\r\n", callback);
    else if (typeof callback === "function") queueMicrotask(callback);
  }

  writeProcessing() {
    const socket = this.socket;
    if (socket && !socket.destroyed && socket.writable) socket.write("HTTP/1.1 102 Processing\r\n\r\n");
  }

  flushHeaders() {
    this._flushHead();
  }

  setTimeout(timeout, callback = undefined) {
    if (typeof callback === "function") this.once("timeout", callback);
    this.socket?.setTimeout?.(Number(timeout) || 0, () => this.emit("timeout"));
    return this;
  }

  _implicitHeader() {
    // Route implicit header sending through this.writeHead so user
    // reassignments of writeHead observe it (Bun issue #3585).
    this.writeHead(this.statusCode);
  }

  _flushHead(singleShotLength = undefined) {
    if (this._headerSent) return;
    if (singleShotLength === undefined) singleShotLength = this._singleShotLength ?? null;
    this._singleShotLength = null;
    const status = Number(this.statusCode) || 200;
    const statusText = this.statusMessage != null ? String(this.statusMessage) : (STATUS_CODES[status] ?? "unknown");
    if (/[\r\n]/.test(statusText)) {
      const error = new Error("Invalid character in statusMessage.");
      error.code = "ERR_INVALID_CHAR";
      throw error;
    }
    this._headerSent = true;
    this.headersSent = true;
    this.statusMessage = statusText;
    const headers = headerEntries(this);
    const lowerNames = new Set(headers.map(([name]) => String(name).toLowerCase()));
    const lines = [`HTTP/1.1 ${status} ${statusText}`];
    for (const [name, value] of headers) lines.push(`${name}: ${value}`);
    const noBodyStatus = status === 204 || status === 304 || (status >= 100 && status < 200);
    if (noBodyStatus) this._suppressBody = true;
    const httpMajor = this.req?.httpVersionMajor ?? 1;
    const httpMinor = this.req?.httpVersionMinor ?? 1;
    const oldHttp = httpMajor === 0 || (httpMajor === 1 && httpMinor === 0);
    let chunked = false;
    if (lowerNames.has("content-length") || noBodyStatus) {
      chunked = false;
    } else if (lowerNames.has("transfer-encoding")) {
      chunked = String(this.getHeader("transfer-encoding"))
        .toLowerCase()
        .split(",")
        .some((value) => value.trim() === "chunked");
    } else if (singleShotLength != null) {
      lines.push(`Content-Length: ${singleShotLength}`);
    } else if (oldHttp) {
      // HTTP/1.0 cannot use chunked encoding; stream identity and close.
      this._keepAlive = false;
    } else {
      chunked = true;
      lines.push("Transfer-Encoding: chunked");
    }
    this._chunkedWire = chunked;
    if (this._trailers.length > 0 && chunked && !lowerNames.has("trailer")) {
      lines.push(`Trailer: ${this._trailers.map(([name]) => name).join(", ")}`);
    }
    if (lowerNames.has("connection")) {
      const value = String(this.getHeader("connection")).toLowerCase();
      if (value.split(",").some((item) => item.trim() === "close")) this._keepAlive = false;
    } else {
      lines.push(this._keepAlive ? "Connection: keep-alive" : "Connection: close");
    }
    if (this.sendDate && !lowerNames.has("date")) lines.push(`Date: ${new Date().toUTCString()}`);
    lines.push("", "");
    const block = lines.join("\r\n");
    const socket = this.socket;
    if (socket && !socket.destroyed && socket.writable) socket.write(block);
    else this._pendingHeadBlock = block;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this.writableEnded) {
      const error = new Error("write after end");
      error.code = "ERR_STREAM_WRITE_AFTER_END";
      queueMicrotask(() => {
        if (typeof callback === "function") callback(error);
        if (this.listenerCount("error") > 0) this.emit("error", error);
      });
      return false;
    }
    const buf = bodyBufferFrom(chunk, encoding);
    if (!this._headerSent) this._implicitHeader();
    this._bodyWritten = true;
    if (this._suppressBody) {
      if (typeof callback === "function") queueMicrotask(callback);
      return true;
    }
    return this._writeBody(buf, callback);
  }

  _writeBody(buf, callback = undefined) {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) {
      if (typeof callback === "function") queueMicrotask(() => callback());
      return false;
    }
    if (this._chunkedWire) {
      if (buf.byteLength === 0) {
        if (typeof callback === "function") queueMicrotask(callback);
        return true;
      }
      const okHead = socket.write(`${buf.byteLength.toString(16)}\r\n`);
      const okBody = socket.write(buf, callback);
      const okTail = socket.write("\r\n");
      return okHead && okBody && okTail;
    }
    return socket.write(buf, callback);
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this.writableEnded) {
      if (typeof callback === "function") queueMicrotask(callback);
      return this;
    }
    const buf = chunk != null ? bodyBufferFrom(chunk, encoding) : null;
    if (!this._headerSent) {
      this._singleShotLength = this._bodyWritten ? null : (buf?.byteLength ?? 0);
      this._implicitHeader();
    }
    if (buf != null && buf.byteLength > 0) {
      this._bodyWritten = true;
      if (!this._suppressBody) this._writeBody(buf);
    }
    const socket = this.socket;
    if (this._chunkedWire && !this._suppressBody && socket && !socket.destroyed && socket.writable) {
      const trailers = trailerEntries(this);
      if (trailers.length > 0) {
        socket.write(`0\r\n${trailers.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`);
      } else {
        socket.write("0\r\n\r\n");
      }
    }
    this.writableEnded = true;
    this.finished = true;
    const finalize = () => {
      if (this._finishEmitted) return;
      this._finishEmitted = true;
      this.emit("prefinish");
      this.emit("finish");
      if (typeof callback === "function") callback();
      const done = this._onFinishFlushed;
      this._onFinishFlushed = null;
      if (typeof done === "function") done();
      this._emitCloseOnce();
    };
    if (socket && !socket.destroyed && socket.writable) socket.write(kEmptyBuffer, finalize);
    else queueMicrotask(finalize);
    return this;
  }

  destroy(error = undefined) {
    const socket = this.socket;
    this.detachSocket(socket ?? undefined);
    socket?.destroy?.(error);
    this.finished = true;
    this.writableEnded = true;
    this._emitCloseOnce();
    return this;
  }

  _emitCloseOnce() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit("close");
  }
}

class AgentImpl extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...options };
    this.protocol = options.protocol ?? "http:";
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
      this.reuseSocket(socket, request);
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
    assignSocketAsyncId(created);
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
    assignSocketAsyncId(socket);
    request.reusedSocket = true;
  }

  _releaseSocket(socket, options = {}) {
    const name = options._agentName ?? this.getName(options);
    this.removeSocket(socket, { ...options, _agentName: name });
    markSocketAsyncFree(socket);
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

// Node's http.Agent is callable without `new` (e.g. Agent.apply({})).
export const Agent = new Proxy(AgentImpl, {
  apply(target, _thisArg, args) {
    return new target(...args);
  },
});

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
    this.socket = null;
    this._agentOptions = null;
    this.agent = normalized.options.agent === false
      ? null
      : (normalized.options.agent ?? normalized.options._defaultAgent ?? globalAgent);
    this.reusedSocket = false;
    this._dispatched = false;
    this._responseEmitted = false;
    this._closeEmitted = false;
    this._timeout = Number(normalized.options.timeout) || 0;
    this._timeoutAutoDestroy = this._timeout > 0;
    this._timeoutTimer = null;
    if (normalized.options.headers) {
      for (const [name, value] of Object.entries(normalized.options.headers)) this.setHeader(name, value);
    }
    const signal = normalized.options.signal;
    if (signal && typeof signal.addEventListener === "function") {
      const onAbort = () => this.abort();
      if (signal.aborted) queueMicrotask(onAbort);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (typeof callback === "function") this.once("response", callback);
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    super.end(chunk, encoding, callback);
    this._dispatch();
    return this;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    return super.write(chunk, encoding, callback);
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.emit("abort");
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
    this._timeoutAutoDestroy = false;
    if (typeof callback === "function") this.once("timeout", callback);
    if (this._socket || this._timeout === 0) this._installTimeout();
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
        if (this._timeoutAutoDestroy && !this._responseEmitted && !this.destroyed) this.destroy();
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
    parsed.message.socket = this._socket;
    parsed.message.connection = this._socket;
    parsed.message.req = this;
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
    if (this.aborted || this._dispatched) return;
    this._dispatched = true;
    const secure = this.protocol === "https:";
    const defaultPort = secure ? 443 : 80;
    const requestOptions = {
      ...this._options,
      host: this.url.hostname || "localhost",
      hostname: this.url.hostname || "localhost",
      port: Number(this._options._port || defaultPort),
      _agentName: this.agent?.getName?.({
        ...this._options,
        host: this.url.hostname || "localhost",
        hostname: this.url.hostname || "localhost",
        port: Number(this._options._port || defaultPort),
      }),
    };
    this._agentOptions = requestOptions;
    if (this.agent && typeof this.agent.addRequest === "function") {
      this.agent.addRequest(this, requestOptions);
      return;
    }
    const socketOptions = { ...requestOptions };
    if (socketOptions.socketPath != null) socketOptions.path = socketOptions.socketPath;
    else delete socketOptions.path;
    const socket = secure
      ? tlsConnect({
          ...socketOptions,
          servername: socketOptions.servername ?? socketOptions.host,
        })
      : netConnect(socketOptions);
    this.onSocket(socket, false);
  }

  onSocket(socket, reused = false) {
    if (this.aborted || this.destroyed) {
      socket.destroy?.();
      return;
    }
    this._socket = socket;
    this.socket = socket;
    this.reusedSocket = Boolean(reused);
    queueMicrotask(() => this.emit("socket", socket));
    let completed = false;
    let parser = null;
    const resetParser = () => {
      parser = {
        phase: "headers",
        headBuffer: kEmptyBuffer,
        searchPos: 0,
        info: null,
        bodyChunks: [],
        bodyBytes: 0,
        contentLength: null,
        chunked: null,
        readToEof: false,
      };
    };
    resetParser();
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
      const usesChunkedEncoding = String(this.getHeader("transfer-encoding") ?? "")
        .toLowerCase()
        .split(",")
        .some((value) => value.trim() === "chunked");
      if (body.byteLength > 0 && !usesChunkedEncoding && !this.hasHeader("content-length")) this.setHeader("Content-Length", body.byteLength);
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
        const wireBody = usesChunkedEncoding
          ? Buffer.concat([
              Buffer.from(`${body.byteLength.toString(16)}\r\n`),
              body,
              Buffer.from("\r\n0\r\n\r\n"),
            ])
          : body;
        socket.write(Buffer.concat([Buffer.from(lines.join("\r\n")), wireBody]));
      }
    };
    const finishResponse = (body, leftover, trailers = {}, rawTrailers = []) => {
      const info = parser.info;
      const message = new IncomingMessage({
        httpVersion: info.httpVersion,
        statusCode: info.statusCode,
        statusMessage: info.statusMessage,
        headers: info.headers,
        rawHeaders: info.rawHeaders,
        trailers,
        rawTrailers,
        body,
      });
      const parsed = { message, head: leftover ?? kEmptyBuffer, consumed: 0 };
      let listenerError = null;
      try {
        this._emitParsedResponse(parsed);
      } catch (error) {
        listenerError = error;
      }
      releaseOrClose(parsed);
      if (listenerError) setTimeout(() => { throw listenerError; }, 0);
    };
    const onData = (chunk) => {
      if (this._responseEmitted) return;
      this._installTimeout();
      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      try {
        while (buf != null && buf.byteLength > 0 && !this._responseEmitted) {
          if (parser.phase === "headers") {
            parser.headBuffer = parser.headBuffer.byteLength === 0 ? buf : Buffer.concat([parser.headBuffer, buf]);
            buf = null;
            const idx = findHeaderEnd(parser.headBuffer, parser.searchPos);
            if (idx < 0) {
              parser.searchPos = Math.max(0, parser.headBuffer.byteLength - 3);
              return;
            }
            const headText = parser.headBuffer.subarray(0, idx).toString("latin1");
            const rest = parser.headBuffer.subarray(idx + 4);
            parser.headBuffer = kEmptyBuffer;
            parser.searchPos = 0;
            const [statusLine, ...headerLines] = headText.split("\r\n");
            const match = /^HTTP\/(\d+)\.(\d+)\s+(\d+)\s*(.*)$/.exec(statusLine);
            if (!match) throw new Error("Invalid HTTP response");
            const statusCode = Number(match[3]);
            const parsedHeaders = parseHeaderLines(headerLines.join("\r\n"));
            if (statusCode >= 100 && statusCode < 200 && statusCode !== 101) {
              if (statusCode === 100) {
                this.emit("continue");
                sendContinueBody();
              } else {
                this.emit("information", {
                  statusCode,
                  statusMessage: match[4] || STATUS_CODES[statusCode] || "",
                  headers: parsedHeaders.headers,
                  rawHeaders: parsedHeaders.rawHeaders,
                });
              }
              resetParser();
              buf = rest;
              continue;
            }
            parser.info = {
              httpVersion: `${match[1]}.${match[2]}`,
              statusCode,
              statusMessage: match[4] || STATUS_CODES[statusCode] || "",
              headers: parsedHeaders.headers,
              rawHeaders: parsedHeaders.rawHeaders,
            };
            const noBody = this.method === "HEAD" ||
              (this.method === "CONNECT" && statusCode >= 200 && statusCode < 300) ||
              statusCode === 101 || statusCode === 204 || statusCode === 304;
            if (noBody) {
              finishResponse(kEmptyBuffer, rest);
              return;
            }
            const transferEncoding = String(parsedHeaders.headers["transfer-encoding"] ?? "").toLowerCase();
            if (transferEncoding.split(",").map((item) => item.trim()).includes("chunked")) {
              parser.chunked = new ChunkedDecoder();
            } else if (parsedHeaders.headers["content-length"] != null) {
              parser.contentLength = contentLengthFromHeaders(parsedHeaders.headers);
            } else {
              parser.readToEof = true;
            }
            parser.phase = "body";
            buf = rest;
            if (parser.contentLength === 0) {
              finishResponse(kEmptyBuffer, buf);
              return;
            }
            continue;
          }
          // body phase
          if (parser.chunked != null) {
            const leftover = parser.chunked.push(buf);
            if (parser.chunked.done) {
              finishResponse(parser.chunked.body(), leftover, parser.chunked.trailers, parser.chunked.rawTrailers);
            }
            return;
          }
          if (parser.contentLength != null) {
            const need = parser.contentLength - parser.bodyBytes;
            const take = Math.min(need, buf.byteLength);
            parser.bodyChunks.push(buf.subarray(0, take));
            parser.bodyBytes += take;
            if (parser.bodyBytes >= parser.contentLength) {
              const body = parser.bodyChunks.length === 1 ? Buffer.from(parser.bodyChunks[0]) : Buffer.concat(parser.bodyChunks);
              finishResponse(body, buf.subarray(take));
            }
            return;
          }
          parser.bodyChunks.push(buf);
          parser.bodyBytes += buf.byteLength;
          return;
        }
      } catch (error) {
        cleanup();
        socket.destroy?.();
        if (this.listenerCount("error") > 0) this.emit("error", error);
        this._emitClose();
      }
    };
    const onEnd = () => {
      if (!this._responseEmitted && parser.phase === "body" && parser.readToEof && parser.info != null) {
        const body = parser.bodyChunks.length === 1 ? Buffer.from(parser.bodyChunks[0]) : Buffer.concat(parser.bodyChunks);
        finishResponse(body, kEmptyBuffer);
      } else if (!this._responseEmitted && !this.destroyed && !this.aborted) {
        const error = new Error("socket hang up");
        error.code = "ECONNRESET";
        cleanup();
        socket.destroy?.();
        if (this.listenerCount("error") > 0) this.emit("error", error);
        this._emitClose();
        return;
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

export function _attachHttpConnection(server, socket) {
  let req = null;
  const resetReqParser = () => {
    req = {
      phase: "headers",
      headBuffer: kEmptyBuffer,
      searchPos: 0,
      head: null,
      chunked: null,
      contentLength: null,
      bodyChunks: [],
      bodyBytes: 0,
      continueSent: false,
    };
  };
  resetReqParser();
  let tunnelChunks = [];
  const queue = [];
  let active = null;
  let tunnel = null;
  let stopped = false;
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
    if (server.listenerCount("clientError") > 0) server.emit("clientError", error, socket);
    else {
      try { socket.end("HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch {}
      socket.destroy?.();
    }
  };
  const refreshHeadersTimer = () => {
    if (!(server.headersTimeout > 0) || headersTimer != null) return;
    headersTimer = setTimeout(() => failParserTimeout("Request header timeout"), server.headersTimeout);
  };
  const refreshRequestTimer = () => {
    if (!(server.requestTimeout > 0) || requestTimer != null) return;
    requestTimer = setTimeout(() => failParserTimeout("Request timeout"), server.requestTimeout);
  };
  refreshHeadersTimer();
  if (server.timeout > 0) {
    socket.setTimeout?.(server.timeout, () => {
      server.emit("timeout", socket);
      if (server.listenerCount("timeout") === 0) socket.destroy?.();
    });
  }

  const detachParser = () => {
    stopped = true;
    socket.off?.("data", onData);
    socket.off?.("error", onSocketError);
    clearParserTimers();
    clearKeepAliveTimer();
  };

  const fail = (error, statusLine = "400 Bad Request") => {
    detachParser();
    if (error && error.code == null) error.code = "HPE_INTERNAL";
    // Swallow any late write errors (e.g. a clientError listener responding on
    // a socket that is already closed).
    socket.on?.("error", () => {});
    try { socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`); } catch {}
    if (server.listenerCount("clientError") > 0) server.emit("clientError", error, socket);
  };

  const dispatchTunnel = () => {
    const item = tunnel;
    tunnel = null;
    detachParser();
    const head = tunnelChunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(tunnelChunks.map((part) => Buffer.from(part)));
    tunnelChunks = [];
    if (server.listenerCount(item.type) > 0) server.emit(item.type, item.message, socket, head);
    else socket.destroy?.();
  };

  const processNext = () => {
    if (active || stopped) return;
    if (queue.length === 0) {
      if (tunnel != null) dispatchTunnel();
      return;
    }
    const message = queue.shift();
    clearKeepAliveTimer();
    const connectionTokens = String(message.headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((item) => item.trim());
    const keepAlive = message.httpVersionMajor === 1 && message.httpVersionMinor === 0
      ? connectionTokens.includes("keep-alive")
      : !connectionTokens.includes("close");
  const response = new ServerResponse(message);
    response._keepAlive = keepAlive;
    response.shouldKeepAlive = keepAlive;
    response.assignSocket(socket);
    active = response;
    response._onFinishFlushed = () => {
      if (active !== response) return;
      active = null;
      response.detachSocket(socket);
      if (!response._keepAlive) {
        socket.end?.();
        return;
      }
      if (queue.length === 0 && tunnel == null && server.keepAliveTimeout > 0 && !socket.destroyed) {
        clearKeepAliveTimer();
        keepAliveTimer = setTimeout(() => socket.destroy?.(), server.keepAliveTimeout);
      }
      processNext();
    };
    const requestResource = new AsyncResource("HTTPINCOMINGMESSAGE");
    try {
      if (String(message.headers.expect ?? "").toLowerCase() === "100-continue" && server.listenerCount("checkContinue") > 0) {
        requestResource.runInAsyncScope(() => server.emit("checkContinue", message, response), server);
      } else {
        requestResource.runInAsyncScope(() => server.emit("request", message, response), server);
      }
    } catch (error) {
      // Surface handler exceptions asynchronously so uncaught-exception
      // machinery (and bun:test failure capture) sees them instead of the
      // socket read dispatcher.
      setTimeout(() => { throw error; }, 0);
    }
  };

  const onData = (chunk) => {
    clearKeepAliveTimer();
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (tunnel != null || stopped) {
      if (buf.byteLength > 0) tunnelChunks.push(buf);
      return;
    }
    try {
      while (buf != null) {
        if (req.phase === "headers") {
          if (buf.byteLength > 0) {
            req.headBuffer = req.headBuffer.byteLength === 0 ? buf : Buffer.concat([req.headBuffer, buf]);
          }
          buf = null;
          const idx = findHeaderEnd(req.headBuffer, req.searchPos);
          if (idx < 0) {
            req.searchPos = Math.max(0, req.headBuffer.byteLength - 3);
            if (req.headBuffer.byteLength > 0) refreshHeadersTimer();
            break;
          }
          if (headersTimer != null) {
            clearTimeout(headersTimer);
            headersTimer = null;
          }
          const headText = req.headBuffer.subarray(0, idx).toString("latin1");
          const rest = req.headBuffer.subarray(idx + 4);
          req.headBuffer = kEmptyBuffer;
          req.searchPos = 0;
          const [requestLine, ...headerLines] = headText.split("\r\n");
          const requestMatch = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s+(\S+)\s+HTTP\/(\d+)\.(\d+)$/.exec(requestLine);
          if (!requestMatch) throw new Error("Invalid HTTP request");
          const parsedHeaders = (() => {
            try {
              return parseHeaderLines(headerLines.join("\r\n"));
            } catch (error) {
              if (error && error.code == null && /valid HTTP token/i.test(String(error.message))) {
                error.code = "HPE_INVALID_HEADER_TOKEN";
              }
              throw error;
            }
          })();
          for (let rawIndex = 1; rawIndex < parsedHeaders.rawHeaders.length; rawIndex += 2) {
            if (/[\r\n]/.test(String(parsedHeaders.rawHeaders[rawIndex]))) {
              const error = new Error("Invalid header value");
              error.code = "HPE_INTERNAL";
              fail(error);
              return;
            }
          }
          req.head = {
            method: requestMatch[1],
            url: requestMatch[2],
            major: Number(requestMatch[3]),
            minor: Number(requestMatch[4]),
            headers: parsedHeaders.headers,
            rawHeaders: parsedHeaders.rawHeaders,
          };
          if (req.head.major !== 1 || req.head.minor > 1) {
            const error = new Error("Unsupported HTTP version");
            error.code = "HPE_INTERNAL";
            fail(error, "505 HTTP Version Not Supported");
            return;
          }
          if (req.head.minor >= 1 && parsedHeaders.headers.host == null) {
            const error = new Error("Missing Host header");
            error.code = "HPE_INTERNAL";
            fail(error);
            return;
          }
          if (parsedHeaders.headers["content-length"] != null && parsedHeaders.headers["transfer-encoding"] != null) {
            const error = new Error("Both Content-Length and Transfer-Encoding are set");
            error.code = "HPE_INVALID_TRANSFER_ENCODING";
            fail(error);
            return;
          }
          const expect = String(parsedHeaders.headers.expect ?? "").toLowerCase();
          if (expect === "100-continue" && server.listenerCount("checkContinue") === 0 && !req.continueSent) {
            req.continueSent = true;
            socket.write("HTTP/1.1 100 Continue\r\n\r\n");
          }
          const transferEncoding = String(parsedHeaders.headers["transfer-encoding"] ?? "").toLowerCase();
          if (transferEncoding.split(",").map((item) => item.trim()).includes("chunked")) {
            req.chunked = new ChunkedDecoder();
          } else {
            req.contentLength = contentLengthFromHeaders(parsedHeaders.headers);
          }
          req.phase = "body";
          buf = rest;
          continue;
        }
        // body phase
        let completeBody = null;
        let trailers = {};
        let rawTrailers = [];
        let leftover = null;
        if (req.chunked != null) {
          leftover = buf != null && buf.byteLength > 0 ? req.chunked.push(buf) : null;
          buf = null;
          if (!req.chunked.done) {
            refreshRequestTimer();
            break;
          }
          completeBody = req.chunked.body();
          trailers = req.chunked.trailers;
          rawTrailers = req.chunked.rawTrailers;
        } else {
          const expected = req.contentLength ?? 0;
          const need = expected - req.bodyBytes;
          if (need > 0 && buf != null && buf.byteLength > 0) {
            const take = Math.min(need, buf.byteLength);
            req.bodyChunks.push(buf.subarray(0, take));
            req.bodyBytes += take;
            leftover = buf.subarray(take);
          } else {
            leftover = buf ?? kEmptyBuffer;
          }
          buf = null;
          if (req.bodyBytes < expected) {
            refreshRequestTimer();
            break;
          }
          completeBody = req.bodyChunks.length === 0
            ? kEmptyBuffer
            : req.bodyChunks.length === 1 ? Buffer.from(req.bodyChunks[0]) : Buffer.concat(req.bodyChunks);
        }
        if (requestTimer != null) {
          clearTimeout(requestTimer);
          requestTimer = null;
        }
        const head = req.head;
        const message = new IncomingMessage({
          httpVersion: `${head.major}.${head.minor}`,
          method: head.method,
          url: head.url,
          headers: head.headers,
          rawHeaders: head.rawHeaders,
          trailers,
          rawTrailers,
          body: completeBody,
        });
        message.socket = socket;
        message.connection = socket;
        const lowerConnection = String(head.headers.connection ?? "").toLowerCase();
        resetReqParser();
        if (String(head.method).toUpperCase() === "CONNECT") {
          tunnel = { type: "connect", message };
          if (leftover != null && leftover.byteLength > 0) tunnelChunks.push(leftover);
          break;
        }
        if (head.headers.upgrade != null || lowerConnection.split(",").map((item) => item.trim()).includes("upgrade")) {
          tunnel = { type: "upgrade", message };
          if (leftover != null && leftover.byteLength > 0) tunnelChunks.push(leftover);
          break;
        }
        queue.push(message);
        buf = leftover != null && leftover.byteLength > 0 ? leftover : null;
      }
    } catch (error) {
      fail(error);
      return;
    }
    processNext();
  };

  const onSocketError = (error) => {
    if (server.listenerCount("clientError") > 0) server.emit("clientError", error, socket);
    else socket.destroy?.();
  };
  socket.on("error", onSocketError);
  socket.on("data", onData);
  socket.on("close", () => {
    clearParserTimers();
    clearKeepAliveTimer();
  });
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
    this._handle = null;
    this._connections = new Set();
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
      this._connections.add(socket);
      socket.once("close", () => this._connections.delete(socket));
      this.emit("connection", socket);
      _attachHttpConnection(this, socket);
    };
    this._native = createNetServer(connectionListener);
    this._handle = this._native;
    this._native.on("error", (error) => this.emit("error", error));
    this._native.on("close", () => {
      this.listening = false;
      this._handle = null;
      this.emit("close");
    });
    this._native.listen(options, (error, host, port) => {
      this.listening = true;
      this.emit("listening", error, host, port);
    });
    return this;
  }

  close(callback = undefined) {
    if (typeof callback === "function") this.once("close", callback);
    this.closeIdleConnections();
    if (!this._native) {
      queueMicrotask(() => this.emit("close"));
      return this;
    }
    const native = this._native;
    this._native = null;
    this._handle = null;
    native.close();
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

  [ensureAsyncDisposeSymbol()]() {
    return new Promise((resolve) => this.close(() => resolve()));
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
    let parsed = new URL(String(url));
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      // Bun's WebSocket accepts http(s) URLs and treats them as ws(s).
      parsed = new URL(String(parsed.href).replace(/^http/, "ws"));
    }
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
    const connectFailure = this.readyState === WebSocket.CONNECTING;
    const cause = connectFailure ? "Failed to connect" : (error?.message ?? String(error));
    const message = `WebSocket connection to '${this.url}' failed: ${cause}`;
    const failure = new Error(message);
    const event = typeof globalThis.ErrorEvent === "function"
      ? new globalThis.ErrorEvent("error", { message, error: failure })
      : { type: "error", message, error: failure, target: this };
    this.dispatchEvent(event);
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

// Bun exposes the WebSocket client as a global.
globalThis.WebSocket ??= WebSocket;

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
