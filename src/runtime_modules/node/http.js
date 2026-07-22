import { EventEmitter } from "./events.js";
import { Readable, Writable } from "./stream.js";
import { Buffer } from "./buffer.js";
import { connect as netConnect, createServer as createNetServer, isIP } from "./net.js";
import { connect as tlsConnect } from "./tls.js";
import { createHash, randomBytes } from "./crypto.js";
import { deflateRawSync, inflateRawSync, constants as zlibConstants } from "./zlib.js";
import { AsyncResource } from "./async_hooks.js";
import { HTTPParser as BindingHTTPParser, allMethods as bindingHTTPMethods } from "../internal/node-http-parser.js";

const asyncIdSymbol = Symbol.for("nodejs.async_id_symbol");
const captureRejectionSymbol = Symbol.for("nodejs.rejection");
const socketAsyncResourceSymbol = Symbol("cottontail.http.socketAsyncResource");
const freeSocketErrorSymbol = Symbol("cottontail.http.freeSocketError");
const clientSocketCleanupSymbol = Symbol("cottontail.http.clientSocketCleanup");
const incomingParserResumeSymbol = Symbol("cottontail.http.incomingParserResume");
const agentSocketStateSymbol = Symbol("cottontail.http.agentSocketState");
const agentRequestOptionsSymbol = Symbol("cottontail.http.agentRequestOptions");
const agentRequestResourceSymbol = Symbol("cottontail.http.agentRequestResource");
const eventLoopTaskStateSymbol = Symbol.for("cottontail.eventLoopTaskState");
const httpResponseTaskRefSymbol = Symbol("cottontail.http.responseTaskRef");
const eventLoopTaskState = globalThis[eventLoopTaskStateSymbol] ??= { activeTasks: 0, concurrentRef: 0 };

function refHttpResponseTask(response) {
  if (response?.[httpResponseTaskRefSymbol]) return;
  Object.defineProperty(response, httpResponseTaskRefSymbol, { value: true, writable: true });
  eventLoopTaskState.activeTasks += 1;
}

function unrefHttpResponseTask(response) {
  if (!response?.[httpResponseTaskRefSymbol]) return;
  response[httpResponseTaskRefSymbol] = false;
  eventLoopTaskState.activeTasks = Math.max(0, eventLoopTaskState.activeTasks - 1);
}

function createWebHeaders(init = undefined) {
  const HeadersCtor = globalThis.Headers;
  if (typeof HeadersCtor !== "function") {
    throw new ReferenceError("Headers is not defined");
  }
  return new HeadersCtor(init);
}

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
  if (typeof BufferCtor !== "function") return;
  // Install when Buffer has no species, or when the inherited species would
  // produce plain Uint8Array views (which breaks ws's FastBuffer usage:
  // message payloads would stringify as comma-joined byte lists).
  const currentSpecies = (() => { try { return BufferCtor[Symbol.species]; } catch { return null; } })();
  if (currentSpecies != null && currentSpecies !== Uint8Array) return;
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
  306: "Switch Proxy",
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

function configuredMaxHeaderSize() {
  let configuredEnv = globalThis.process?.env?.BUN_HTTP_MAX_HEADER_SIZE;
  if (configuredEnv == null && typeof cottontail === "object" && typeof cottontail?.env === "function") {
    try { configuredEnv = cottontail.env()?.BUN_HTTP_MAX_HEADER_SIZE; } catch {}
  }
  const fromEnv = Number(configuredEnv ?? "");
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const execArgs = globalThis.process?.execArgv ??
    (typeof cottontail === "object" ? cottontail?.execArgv : undefined) ?? [];
  for (const arg of execArgs) {
    const match = /^--max-http-header-size=(\d+)$/.exec(String(arg));
    if (match) return Number(match[1]);
  }
  return null;
}

// Bun allows reassigning http.maxHeaderSize at runtime (Node's is read-only);
// the live value drives the 431 header-overflow enforcement below.
// Runtime modules can evaluate before node:process has populated env/execArgv;
// the host environment fallback keeps named and default imports consistent.
let currentMaxHeaderSize = configuredMaxHeaderSize() ?? 16 * 1024;
let maxHeaderSizeWasAssigned = false;

const activeFetchHeaderLimitPatch = Symbol.for("cottontail.http.maxHeaderSize.fetch");

function activeServerForUrl(value) {
  const origins = globalThis.__cottontailActiveServeOrigins;
  if (!(origins instanceof Map) || origins.size === 0) return null;
  try {
    const url = new URL(String(value));
    const hostname = String(url.hostname);
    const authority = `${hostname}${url.port ? `:${url.port}` : ""}`;
    return origins.get(`${url.protocol}//${authority}`)
      ?? (hostname === "localhost" ? origins.get(`${url.protocol}//127.0.0.1:${url.port}`) : null)
      ?? ((hostname === "0.0.0.0" || hostname === "[::]")
        ? origins.get(`${url.protocol}//127.0.0.1:${url.port}`) ?? origins.get(`${url.protocol}//localhost:${url.port}`)
        : null);
  } catch {
    return null;
  }
}

function outgoingHeaderLength(input, init = undefined) {
  let url = input?.url ?? input;
  let method = input?.method ?? "GET";
  let source = input?.headers;
  if (init && typeof init === "object") {
    if (init.method != null) method = init.method;
    if (init.headers != null) source = init.headers;
  }
  if (!activeServerForUrl(url)) return 0;
  const headers = createWebHeaders(source ?? {});
  let length = String(method).length + String(url).length + 12;
  headers.forEach((value, name) => {
    length += Buffer.byteLength(String(name), "latin1") + Buffer.byteLength(String(value), "latin1") + 4;
  });
  return length;
}

function responseAllowsBody(status, method) {
  return method !== "HEAD" && status !== 204 && status !== 205 && status !== 304 && !(status >= 100 && status < 200);
}

function rawFetchRequest(url, method, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const request = new ClientRequest(url, {
      method,
      headers,
      agent: false,
      signal,
    });
    request.once("error", reject);
    request.once("response", (message) => {
      const chunks = [];
      message.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      message.once("error", reject);
      message.once("end", () => {
        const responseHeaders = createWebHeaders();
        for (let index = 0; index + 1 < message.rawHeaders.length; index += 2) {
          responseHeaders.append(message.rawHeaders[index], message.rawHeaders[index + 1]);
        }
        const bytes = chunks.length === 0 ? kEmptyBuffer : chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
        const status = Number(message.statusCode) || 200;
        const response = new Response(responseAllowsBody(status, method) ? bytes : null, {
          status,
          statusText: message.statusMessage,
          headers: responseHeaders,
        });
        response.url = String(url);
        resolve(response);
      });
    });
    request.end(body && body.byteLength > 0 ? body : undefined);
  });
}

async function fetchWithoutDecompression(input, init = {}) {
  const requestInit = { ...init };
  delete requestInit.decompress;
  const prepared = new Request(input, requestInit);
  const headers = {};
  prepared.headers.forEach((value, name) => { headers[name] = value; });
  const method = String(prepared.method || "GET").toUpperCase();
  const body = method === "GET" || method === "HEAD"
    ? kEmptyBuffer
    : Buffer.from(await prepared.arrayBuffer());
  const redirectMode = String(requestInit.redirect ?? prepared.redirect ?? "follow");

  const perform = async (url, requestMethod, requestBody, depth, redirected) => {
    if (depth > 20) throw new TypeError("redirect count exceeded");
    const response = await rawFetchRequest(url, requestMethod, headers, requestBody, prepared.signal);
    const status = response.status;
    const location = response.headers.get("location");
    const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
    if (!isRedirect || location == null || redirectMode === "manual") {
      response.redirected = redirected;
      return response;
    }
    if (redirectMode === "error") throw new TypeError("fetch failed");
    let nextMethod = requestMethod;
    let nextBody = requestBody;
    if (status === 303 || ((status === 301 || status === 302) && requestMethod === "POST")) {
      nextMethod = "GET";
      nextBody = kEmptyBuffer;
      delete headers["content-length"];
      delete headers["content-type"];
      delete headers["transfer-encoding"];
    }
    return perform(String(new URL(location, url)), nextMethod, nextBody, depth + 1, true);
  };

  return perform(prepared.url, method, body, 0, false);
}

function ensureActiveFetchHeaderLimit() {
  if (globalThis[activeFetchHeaderLimitPatch] || typeof globalThis.fetch !== "function") return;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = function fetchWithActiveServerHeaderLimit(input, init = undefined) {
    if (init?.decompress === false) return fetchWithoutDecompression(input, init);
    if (outgoingHeaderLength(input, init) > getCurrentMaxHeaderSize()) {
      return Promise.resolve(new Response(null, {
        status: 431,
        headers: { "content-length": "0", "connection": "close" },
      }));
    }
    return nativeFetch(input, init);
  };
  Object.defineProperty(globalThis, activeFetchHeaderLimitPatch, { value: true, configurable: true });
}

function getCurrentMaxHeaderSize() {
  if (!maxHeaderSizeWasAssigned) {
    const configured = configuredMaxHeaderSize();
    if (configured != null) currentMaxHeaderSize = configured;
  }
  ensureActiveFetchHeaderLimit();
  return currentMaxHeaderSize;
}

function setCurrentMaxHeaderSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return currentMaxHeaderSize;
  currentMaxHeaderSize = size;
  maxHeaderSizeWasAssigned = true;
  ensureActiveFetchHeaderLimit();
  return currentMaxHeaderSize;
}

export { currentMaxHeaderSize as maxHeaderSize };

// Bun.serve's compact native backend is polled from JavaScript. Enforce the
// same process-wide header limit at that boundary so assigning
// http.maxHeaderSize applies consistently to both HTTP server backends.
const nativeHeaderLimitPatch = Symbol.for("cottontail.http.maxHeaderSize.poll");
if (typeof cottontail === "object" && cottontail != null &&
    typeof cottontail.httpServerPoll === "function" && !cottontail[nativeHeaderLimitPatch]) {
  try {
    const nativePoll = cottontail.httpServerPoll;
    cottontail.httpServerPoll = function httpServerPollWithHeaderLimit(serverId) {
      for (;;) {
        const item = nativePoll(serverId);
        if (item == null) return item;
        const requestLineLength = String(item.method ?? "GET").length + String(item.url ?? "/").length + 12;
        const headerLength = Buffer.byteLength(String(item.headersText ?? ""), "latin1") + requestLineLength;
        if (headerLength <= getCurrentMaxHeaderSize()) return item;
        try {
          cottontail.httpServerRespond(
            serverId,
            item.id,
            431,
            "Content-Length: 0\r\nConnection: close\r\n",
            new ArrayBuffer(0),
          );
        } catch {}
      }
    };
    Object.defineProperty(cottontail, nativeHeaderLimitPatch, { value: true, configurable: true });
  } catch {}
}

const tokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const invalidPathPattern = /[^\u0021-\u00ff]/;
const bodylessRequestMethods = new Set(["GET", "HEAD", "DELETE", "OPTIONS", "TRACE", "CONNECT"]);

function nodeError(ErrorType, code, message) {
  const error = new ErrorType(message);
  error.code = code;
  return error;
}

function validateIntegerOption(value, name, minimum = 0) {
  if (typeof value !== "number") {
    throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be of type number. Received ${typeof value}`);
  }
  if (!Number.isInteger(value) || value < minimum) {
    throw nodeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "${name}" is out of range. It must be >= ${minimum}. Received ${value}`);
  }
  return value;
}

function validateBooleanOption(value, name) {
  if (typeof value !== "boolean") {
    throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be of type boolean. Received ${typeof value}`);
  }
  return value;
}

function distinctHeaders(rawHeaders, fallback = {}) {
  const result = Object.create(null);
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index]).toLowerCase();
    (result[name] ??= []).push(String(rawHeaders[index + 1]));
  }
  if (rawHeaders.length === 0) {
    for (const [name, value] of Object.entries(fallback ?? {})) {
      result[String(name).toLowerCase()] = Array.isArray(value) ? value.map(String) : [String(value)];
    }
  }
  return result;
}

function formatHostHeader(hostname, port, defaultPort) {
  let value = String(hostname || "localhost");
  if (value.includes(":") && !value.startsWith("[")) value = `[${value}]`;
  if (Number(port) !== Number(defaultPort)) value += `:${port}`;
  return value;
}

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
  if (options?.path != null) return String(options.path);
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

export function _httpListeningCallbackArgs(server, options = {}) {
  const address = server.address?.();
  if (typeof address === "string") return [null, address, undefined];
  let host = options.host ?? address?.address ?? "localhost";
  if (options.host == null && (host === "::" || host === "0.0.0.0")) host = "localhost";
  else if (String(host).includes(":") && !String(host).startsWith("[")) host = `[${host}]`;
  return [null, host, address?.port];
}

function normalizeRequestOptions(input, options = undefined, defaultProtocol = "http:") {
  let url = null;
  let merged;
  if (input instanceof URL) {
    url = input;
    merged = { ...input, ...(options ?? {}) };
  } else if (typeof input === "string") {
    try {
      url = new URL(String(input));
    } catch {
      throw nodeError(TypeError, "ERR_INVALID_URL", `Invalid URL: ${String(input)}`);
    }
    merged = { ...(options ?? {}) };
  } else {
    merged = { ...(input ?? {}) };
    if (options && typeof options === "object") merged = { ...merged, ...options };
  }

  const protocol = String(merged.protocol ?? url?.protocol ?? defaultProtocol);
  let hostname = merged.hostname;
  if (hostname != null && typeof hostname !== "string") {
    throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "options.hostname" property must be of type string.');
  }
  if (merged.host != null && typeof merged.host !== "string") {
    throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "options.host" property must be of type string.');
  }

  if (url == null) {
    let authority = String(hostname ?? merged.host ?? "localhost");
    if (authority.includes(":") && !authority.startsWith("[") && !/:[0-9]+$/.test(authority)) authority = `[${authority}]`;
    try {
      url = new URL(`${protocol}//${authority}`);
    } catch {
      throw nodeError(TypeError, "ERR_INVALID_URL", `Invalid URL: ${protocol}//${authority}`);
    }
  }

  if (hostname != null) url.hostname = hostname;
  else if (merged.host != null) url.host = merged.host;
  if (merged.port != null) url.port = String(merged.port);
  hostname = url.hostname.replace(/^\[|\]$/g, "");
  const defaultPort = protocol === "https:" ? 443 : 80;
  const port = Number((merged.port ?? url.port) || defaultPort);
  const auth = merged.auth ?? (url.username || url.password
    ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
    : undefined);

  merged.protocol = protocol;
  merged._hostname = hostname;
  merged._port = port;
  merged._defaultPort = defaultPort;
  merged._auth = auth;
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

const joinableIncomingHeaders = new Set([
  "accept", "accept-encoding", "accept-language", "cache-control", "connection",
  "date", "expect", "if-match", "if-none-match", "origin", "transfer-encoding",
  "upgrade", "vary", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
]);

const singleValueIncomingHeaders = new Set([
  "age", "authorization", "content-length", "content-type", "etag", "expires",
  "from", "host", "if-modified-since", "if-unmodified-since", "last-modified",
  "location", "max-forwards", "proxy-authorization", "referer", "retry-after",
  "server", "user-agent",
]);

function materializeIncomingHeaders(rawHeaders, joinDuplicateHeaders = false, maxHeadersCount = 0) {
  const count = Number(maxHeadersCount);
  const limit = Number.isInteger(count) && count > 0
    ? Math.min(rawHeaders.length, count * 2)
    : rawHeaders.length;
  const raw = rawHeaders.slice(0, limit);
  const headers = Object.create(null);

  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = String(raw[index]).toLowerCase();
    const value = String(raw[index + 1]);
    const current = headers[name];
    if (name === "set-cookie") {
      if (current === undefined) headers[name] = [value];
      else current.push(value);
    } else if (name === "cookie") {
      headers[name] = current === undefined ? value : `${current}; ${value}`;
    } else if (current === undefined) {
      headers[name] = value;
    } else if (joinDuplicateHeaders || joinableIncomingHeaders.has(name) || !singleValueIncomingHeaders.has(name)) {
      headers[name] = `${current}, ${value}`;
    }
  }

  return { headers, rawHeaders: raw };
}

const kParserOnMessageBegin = BindingHTTPParser.kOnMessageBegin | 0;
const kParserOnHeaders = BindingHTTPParser.kOnHeaders | 0;
const kParserOnHeadersComplete = BindingHTTPParser.kOnHeadersComplete | 0;
const kParserOnBody = BindingHTTPParser.kOnBody | 0;
const kParserOnMessageComplete = BindingHTTPParser.kOnMessageComplete | 0;

function throwParserResult(result, rawPacket) {
  if (!(result instanceof Error) && (result == null || typeof result !== "object" || typeof result.code !== "string")) {
    return result;
  }
  const error = result instanceof Error ? result : Object.assign(new Error("Parse Error"), result);
  if (typeof error.reason === "string") error.message = `Parse Error: ${error.reason}`;
  if (error.rawPacket == null) error.rawPacket = Buffer.from(rawPacket ?? kEmptyBuffer);
  throw error;
}

// The stock-JSC runtime cannot use Bun's uWS/fetch parser callbacks directly,
// but it exposes the same process.binding("http_parser") contract. Keep one
// adapter around that parser for both sides of the socket transport so framing,
// upgrades, trailers, leniency, and pause/resume share a single state machine.
class SocketHTTPParser {
  constructor(type, options = {}) {
    this.handlers = options;
    this.pendingHeaders = [];
    this.pendingUrl = "";
    this.current = null;
    this.pendingUpgrade = null;
    this.paused = false;
    this.closed = false;
    this.parser = new BindingHTTPParser();
    this.parser.initialize(
      type,
      options.resource ?? {},
      Number(options.maxHeaderSize) || getCurrentMaxHeaderSize(),
      options.insecureHTTPParser ? BindingHTTPParser.kLenientAll : BindingHTTPParser.kLenientNone,
    );
    this.parser[kParserOnMessageBegin] = () => this.handlers.onMessageBegin?.();
    this.parser[kParserOnHeaders] = (headers, url) => {
      if (Array.isArray(headers) && headers.length > 0) this.pendingHeaders.push(...headers);
      if (url != null) this.pendingUrl += String(url);
    };
    this.parser[kParserOnHeadersComplete] = (
      major,
      minor,
      headers,
      method,
      url,
      statusCode,
      statusMessage,
      upgrade,
      shouldKeepAlive,
    ) => {
      if (Array.isArray(headers) && headers.length > 0) this.pendingHeaders.push(...headers);
      if (url != null) this.pendingUrl += String(url);
      const rawHeaders = this.pendingHeaders;
      const requestUrl = this.pendingUrl;
      this.pendingHeaders = [];
      this.pendingUrl = "";
      let parsedMethod = typeof method === "number" ? bindingHTTPMethods[method] : undefined;
      if (parsedMethod === "M - SEARCH") parsedMethod = "M-SEARCH";
      const result = this.handlers.onHeaders?.({
        major: Number(major),
        minor: Number(minor),
        method: parsedMethod,
        url: requestUrl,
        statusCode: statusCode == null ? undefined : Number(statusCode),
        statusMessage: statusMessage == null ? "" : String(statusMessage),
        rawHeaders,
        upgrade: Boolean(upgrade),
        shouldKeepAlive: Boolean(shouldKeepAlive),
      }) ?? {};
      this.current = result.state ?? result;
      const action = Number(result.action ?? 0) | 0;
      if (Boolean(result.upgrade) || Boolean(upgrade) || action === 2) this.pendingUpgrade = this.current;
      return action;
    };
    this.parser[kParserOnBody] = (chunk) => {
      if (this.handlers.onBody?.(this.current, chunk) === false) {
        this.paused = true;
        this.parser.pause();
      }
    };
    this.parser[kParserOnMessageComplete] = () => {
      const state = this.current;
      const rawTrailers = this.pendingHeaders;
      this.pendingHeaders = [];
      this.pendingUrl = "";
      this.current = null;
      this.handlers.onComplete?.(state, rawTrailers);
    };
  }

  execute(value) {
    if (this.closed) return 0;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value ?? kEmptyBuffer);
    const result = throwParserResult(this.parser.execute(chunk), chunk);
    if (this.pendingUpgrade != null) {
      const state = this.pendingUpgrade;
      this.pendingUpgrade = null;
      const consumed = Math.max(0, Math.min(chunk.byteLength, Number(result) || 0));
      this.handlers.onUpgrade?.(state, Buffer.from(chunk.subarray(consumed)));
    }
    return result;
  }

  finish() {
    if (this.closed) return;
    return throwParserResult(this.parser.finish(), kEmptyBuffer);
  }

  resume() {
    if (this.closed) return false;
    if (!this.paused) return true;
    this.paused = false;
    this.parser.resume();
    this.execute(kEmptyBuffer);
    return !this.paused;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.parser.close();
    this.current = null;
    this.pendingHeaders = [];
    this.pendingUpgrade = null;
  }
}

function socketError(value, socket = undefined) {
  if (value instanceof Error) return value;
  const message = value == null
    ? String(socket?.authorizationError ?? "socket error")
    : String(value);
  return new Error(message);
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
  constructor(onChunk = null) {
    this.chunks = [];
    this.onChunk = typeof onChunk === "function" ? onChunk : null;
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
        const chunk = buffer.subarray(offset, offset + take);
        if (this.onChunk) this.onChunk(chunk);
        else this.chunks.push(chunk);
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
      statusMessage: match[4],
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

export function websocketAcceptKey(key) {
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

export function websocketFrame(opcode, payload = Buffer.alloc(0), masked = true, rsv1 = false) {
  const body = Buffer.from(bytesFromBody(payload));
  const header = [];
  header.push(0x80 | (rsv1 ? 0x40 : 0) | (opcode & 0x0f));
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

export function parseWebSocketFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.byteLength - offset >= 2) {
    const frameStart = offset;
    const first = buffer[offset++];
    const second = buffer[offset++];
    const fin = (first & 0x80) !== 0;
    const rsv1 = (first & 0x40) !== 0;
    const rsv2 = (first & 0x20) !== 0;
    const rsv3 = (first & 0x10) !== 0;
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
    frames.push({ fin, rsv1, rsv2, rsv3, opcode, masked, payload });
  }
  return { frames, remaining: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// RFC 7692 permessage-deflate helpers (shared by the WebSocket client, the
// Bun.serve websocket backend, and the "ws" shim).
// ---------------------------------------------------------------------------

const WEBSOCKET_DEFLATE_TRAILER = [0x00, 0x00, 0xff, 0xff];
export const WEBSOCKET_MAX_DECOMPRESSED_LENGTH = 128 * 1024 * 1024;

export function websocketDeflateCompress(payload, windowBits = 15) {
  const bits = Math.max(9, Math.min(15, Number(windowBits) || 15));
  let output = deflateRawSync(payload, {
    finishFlush: zlibConstants.Z_SYNC_FLUSH,
    windowBits: bits,
  });
  // RFC 7692 7.2.1: strip the trailing 0x00 0x00 0xff 0xff emitted by an
  // ending Z_SYNC_FLUSH; the receiver appends it back before inflating.
  if (
    output.byteLength >= 4 &&
    output[output.byteLength - 4] === 0x00 &&
    output[output.byteLength - 3] === 0x00 &&
    output[output.byteLength - 2] === 0xff &&
    output[output.byteLength - 1] === 0xff
  ) {
    output = output.subarray(0, output.byteLength - 4);
  }
  if (output.byteLength === 0) output = Buffer.from([0x00]);
  return output;
}

export function websocketDeflateDecompress(payload, maxLength = WEBSOCKET_MAX_DECOMPRESSED_LENGTH) {
  const input = Buffer.concat([Buffer.from(payload), Buffer.from(WEBSOCKET_DEFLATE_TRAILER)]);
  let output;
  try {
    output = inflateRawSync(input, {
      finishFlush: zlibConstants.Z_SYNC_FLUSH,
      maxOutputLength: maxLength,
      windowBits: 15,
    });
  } catch (error) {
    if (error?.code !== "ERR_BUFFER_TOO_LARGE") throw error;
    const tooLarge = new RangeError("Message too big");
    tooLarge.code = "WS_MESSAGE_TOO_BIG";
    throw tooLarge;
  }
  if (maxLength != null && output.byteLength > maxLength) {
    const error = new RangeError("Message too big");
    error.code = "WS_MESSAGE_TOO_BIG";
    throw error;
  }
  return output;
}

// Parses a Sec-WebSocket-Extensions header value into
// [{ name, params: { [name]: value | true } }] entries.
export function parseWebSocketExtensions(value) {
  const extensions = [];
  for (const part of String(value ?? "").split(",")) {
    const tokens = part.split(";").map((token) => token.trim()).filter((token) => token.length > 0);
    if (tokens.length === 0) continue;
    const params = {};
    for (const token of tokens.slice(1)) {
      const eq = token.indexOf("=");
      if (eq < 0) {
        params[token.toLowerCase()] = true;
      } else {
        let paramValue = token.slice(eq + 1).trim();
        if (paramValue.startsWith('"') && paramValue.endsWith('"')) paramValue = paramValue.slice(1, -1);
        params[token.slice(0, eq).trim().toLowerCase()] = paramValue;
      }
    }
    extensions.push({ name: tokens[0].toLowerCase(), params });
  }
  return extensions;
}

export function validateHeaderName(name, label = "Header name") {
  const value = String(name);
  if (!tokenPattern.test(value)) throw nodeError(TypeError, "ERR_INVALID_HTTP_TOKEN", `${label} must be a valid HTTP token ["${value}"]`);
}

export function validateHeaderValue(name, value) {
  validateHeaderName(name);
  if (value == null) throw nodeError(TypeError, "ERR_HTTP_INVALID_HEADER_VALUE", `Invalid value "${value}" for header "${name}"`);
  if (/[^\u0009\u0020-\u007e\u0080-\u00ff]/.test(String(value))) {
    throw nodeError(TypeError, "ERR_INVALID_CHAR", `Invalid value for header ${name}: invalid character`);
  }
}

export class IncomingMessage extends Readable {
  constructor(init = {}) {
    if (init && typeof init.on === "function" && init.headers === undefined && init.deferBody === undefined) {
      init = { socket: init, deferBody: true };
    }
    super({ captureRejections: true, highWaterMark: init.highWaterMark });
    this.aborted = false;
    this.complete = init.deferBody !== true;
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
    this._headersDistinct = null;
    this._trailersDistinct = null;
    this._dumped = false;
    this[incomingParserResumeSymbol] = null;
    this._incomingBody = bytesFromBody(init.body);
    this._incomingBodyChunks = this._incomingBody.byteLength > 0 ? [Buffer.from(this._incomingBody)] : [];
    if (init.deferBody !== true) {
      queueMicrotask(() => {
        if (this._incomingBody.byteLength > 0) this.push(Buffer.from(this._incomingBody));
        this.push(null);
      });
    }
  }

  _pushIncomingChunk(chunk) {
    if (this.complete || this.aborted || chunk == null || chunk.byteLength === 0) return true;
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    return this._dumped ? true : this.push(body);
  }

  _completeIncoming(trailers = {}, rawTrailers = [], preserveParserResume = false) {
    if (this.complete || this.aborted) return;
    this.complete = true;
    this.trailers = trailers;
    this.rawTrailers = rawTrailers;
    this._trailersDistinct = null;
    this._incomingBody = kEmptyBuffer;
    this._incomingBodyChunks = [];
    if (!preserveParserResume) this[incomingParserResumeSymbol] = null;
    this.push(null);
  }

  _abortIncoming(destroySocket = true) {
    if (this.complete || this.aborted) return;
    this.aborted = true;
    this.complete = false;
    this[incomingParserResumeSymbol] = null;
    this.emit("aborted");
    if (destroySocket) this.destroy();
    else this.push(null);
  }

  _read() {
    const resumeParser = this[incomingParserResumeSymbol];
    if (typeof resumeParser !== "function" || resumeParser() !== false) this.socket?.resume?.();
  }

  _dump() {
    if (this._dumped) return;
    this._dumped = true;
    this.removeAllListeners("data");
    this.resume();
  }

  _destroy(error, callback) {
    this[incomingParserResumeSymbol] = null;
    if (!this.complete && !this.aborted) {
      this.aborted = true;
      this.emit("aborted");
    }
    if (!this.complete && this.socket && !this.socket.destroyed) this.socket.destroy?.(error);
    callback?.(error);
  }

  get headersDistinct() {
    return (this._headersDistinct ??= distinctHeaders(this.rawHeaders, this.headers));
  }

  get trailersDistinct() {
    return (this._trailersDistinct ??= distinctHeaders(this.rawTrailers, this.trailers));
  }

  [captureRejectionSymbol](error) {
    // Stream listeners are user callbacks. A rejected async listener must
    // remain observable through the process unhandled-rejection machinery.
    Promise.reject(error);
  }

  setTimeout(_timeout, callback = undefined) {
    const timeout = Number(_timeout);
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw nodeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "msecs" is out of range. It must be >= 0. Received ${_timeout}`);
    }
    if (typeof callback === "function") this.once("timeout", callback);
    this.socket?.setTimeout?.(timeout, () => this.emit("timeout"));
    return this;
  }
}

export class OutgoingMessage extends Writable {
  constructor() {
    super();
    this.headersSent = false;
    this.finished = false;
    this.destroyed = false;
    this._socket = null;
    this._closed = false;
    this._errored = null;
    this._bytesWritten = 0;
    this._corked = 0;
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
    this.shouldKeepAlive = true;
    this.strictContentLength = false;
    this._sent100 = false;
    this._rejectNonStandardBodyWrites = false;
    this._contentLength = null;
    this._responseBytesWritten = 0;
    this._server = null;
    this._requestCount = 0;
    this.outputData = [];
    this.outputSize = 0;
    this._headerMap = new Map();
    this._chunks = [];
    this._trailers = [];
  }

  setHeader(name, value) {
    if (this.headersSent) throw nodeError(Error, "ERR_HTTP_HEADERS_SENT", "Cannot set headers after they are sent to the client");
    if (Array.isArray(value)) {
      validateHeaderName(name);
      for (const item of value) validateHeaderValue(name, item);
    } else {
      validateHeaderValue(name, value);
    }
    this._headerMap.set(String(name).toLowerCase(), { name: String(name), value });
    return this;
  }

  appendHeader(name, value) {
    validateHeaderName(name);
    if (this.headersSent) throw nodeError(Error, "ERR_HTTP_HEADERS_SENT", "Cannot append headers after they are sent to the client");
    const key = String(name).toLowerCase();
    const entry = this._headerMap.get(key);
    if (entry == null) return this.setHeader(name, value);
    if (Array.isArray(value)) {
      for (const item of value) validateHeaderValue(name, item);
    } else {
      validateHeaderValue(name, value);
    }
    const appended = Array.isArray(value) ? value : [value];
    entry.value = Array.isArray(entry.value) ? [...entry.value, ...appended] : [entry.value, ...appended];
    return this;
  }

  setHeaders(headers) {
    if (this.headersSent) {
      const error = new Error("Cannot set headers after they are sent to the client");
      error.code = "ERR_HTTP_HEADERS_SENT";
      throw error;
    }
    if (!headers || Array.isArray(headers) || typeof headers.keys !== "function" || typeof headers.get !== "function") {
      const error = new TypeError(
        'The "headers" argument must be an instance of Headers or Map. Received ' + (headers === null ? "null" : typeof headers),
      );
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    for (const key of headers.keys()) this.setHeader(key, headers.get(key));
    return this;
  }

  getHeader(name) {
    return this._headerMap.get(String(name).toLowerCase())?.value;
  }

  getHeaderNames() {
    return Array.from(this._headerMap.keys());
  }

  getRawHeaderNames() {
    return Array.from(this._headerMap.values(), (entry) => entry.name);
  }

  getHeaders() {
    const out = Object.create(null);
    for (const [name, entry] of this._headerMap) out[name] = entry.value;
    return out;
  }

  get headers() {
    return this.getHeaders();
  }

  set headers(value) {
    if (this.headersSent) throw nodeError(Error, "ERR_HTTP_HEADERS_SENT", "Cannot set headers after they are sent to the client");
    this._headerMap.clear();
    for (const [name, item] of Object.entries(value ?? {})) this.setHeader(name, item);
  }

  hasHeader(name) {
    return this._headerMap.has(String(name).toLowerCase());
  }

  removeHeader(name) {
    if (this.headersSent) throw nodeError(Error, "ERR_HTTP_HEADERS_SENT", "Cannot remove headers after they are sent to the client");
    this._headerMap.delete(String(name).toLowerCase());
  }

  addTrailers(headers = {}) {
    const entries = Array.isArray(headers)
      ? (Array.isArray(headers[0]) ? headers : Array.from({ length: Math.floor(headers.length / 2) }, (_, index) => [headers[index * 2], headers[index * 2 + 1]]))
      : Object.entries(headers ?? {});
    for (const [name, value] of entries) {
      validateHeaderName(name);
      if (Array.isArray(value)) {
        for (const item of value) validateHeaderValue(name, item);
      } else {
        validateHeaderValue(name, value);
      }
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
    if (chunk == null) throw nodeError(TypeError, "ERR_STREAM_NULL_VALUES", "May not write null values to stream");
    if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk)) {
      throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "chunk" argument must be of type string or an instance of Buffer or Uint8Array.');
    }
    const body = typeof chunk === "string" ? Buffer.from(chunk, encoding ?? "utf8") : Buffer.from(bytesFromBody(chunk));
    this._chunks.push(body);
    this.outputData.push({ data: body, encoding: null, callback });
    this.outputSize += body.byteLength;
    this._bytesWritten += body.byteLength;
    this.headersSent = true;
    return this.outputSize < this.writableHighWaterMark;
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
    queueMicrotask(() => {
      this.emit("prefinish");
      this.emit("finish");
      if (typeof callback === "function") callback();
    });
    return this;
  }

  flushHeaders() {
    this.headersSent = true;
  }

  setTimeout(timeout, callback = undefined) {
    const value = Number(timeout);
    if (!Number.isFinite(value) || value < 0) {
      throw nodeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "msecs" is out of range. It must be >= 0. Received ${timeout}`);
    }
    if (typeof callback === "function") this.once("timeout", callback);
    if (this.socket) this.socket.setTimeout?.(value, () => this.emit("timeout"));
    else this.once("socket", (socket) => socket.setTimeout?.(value, () => this.emit("timeout")));
    return this;
  }

  cork() {
    this._corked += 1;
    this.socket?.cork?.();
  }

  uncork() {
    if (this._corked > 0) this._corked -= 1;
    this.socket?.uncork?.();
  }

  pipe() {
    const error = nodeError(Error, "ERR_STREAM_CANNOT_PIPE", "Cannot pipe, not readable");
    this.emit("error", error);
  }

  destroy(error = undefined) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this._errored = error ?? null;
    this.socket?.destroy?.(error);
    return this;
  }

  get connection() { return this.socket; }
  set connection(value) { this.socket = value; }
  get socket() { return this._socket; }
  set socket(value) { this._socket = value; }
  get writableHighWaterMark() {
    return Number(this.socket?.writableHighWaterMark ?? this._writableState?.highWaterMark ?? 16 * 1024);
  }
  get writableLength() {
    return Number(this.outputSize || 0) + Number(this._requestPendingBytes || 0) +
      Number(this._pendingResponseBytes || 0) + Number(this.socket?.writableLength || 0);
  }

  _headersForFetch() {
    const headers = createWebHeaders();
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
    Object.defineProperty(this, "errored", {
      get: () => this._errored ?? undefined,
      configurable: true,
    });
    this._keepAlive = true;
    this._suppressBody = this.req ? String(this.req.method ?? "").toUpperCase() === "HEAD" : false;
    this._chunkedWire = false;
    this._headerSent = false;
    this._bodyWritten = false;
    this._pendingResponseBytes = 0;
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

  addTrailers(headers = {}) {
    if (this._headerSent && (!this._chunkedWire || this.hasHeader("content-length"))) {
      throw nodeError(Error, "ERR_HTTP_TRAILER_INVALID", "Trailers are invalid with this transfer encoding");
    }
    return super.addTrailers(headers);
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
    const originalStatusCode = statusCode;
    statusCode = Number(statusCode);
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 999) {
      throw nodeError(RangeError, "ERR_HTTP_INVALID_STATUS_CODE", `Invalid status code: ${originalStatusCode}`);
    }
    this.statusCode = statusCode;
    if (statusMessage != null) this.statusMessage = String(statusMessage);
    if (headers) {
      if (Array.isArray(headers)) {
        if (Array.isArray(headers[0])) {
          for (const entry of headers) {
            if (!Array.isArray(entry) || entry.length !== 2) throw nodeError(TypeError, "ERR_INVALID_ARG_VALUE", "Invalid headers array");
            this.appendHeader(entry[0], entry[1]);
          }
        } else {
          if (headers.length % 2 !== 0) throw nodeError(TypeError, "ERR_INVALID_ARG_VALUE", "Invalid headers array");
          for (let index = 0; index < headers.length; index += 2) this.appendHeader(headers[index], headers[index + 1]);
        }
      } else {
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      }
    }
    this._flushHead();
    return this;
  }

  writeContinue(callback = undefined) {
    this._sent100 = true;
    const socket = this.socket;
    if (socket && !socket.destroyed && socket.writable) socket.write("HTTP/1.1 100 Continue\r\n\r\n", callback);
    else if (typeof callback === "function") queueMicrotask(callback);
  }

  writeProcessing(callback = undefined) {
    const socket = this.socket;
    if (socket && !socket.destroyed && socket.writable) socket.write("HTTP/1.1 102 Processing\r\n\r\n", callback);
    else if (typeof callback === "function") queueMicrotask(callback);
  }

  writeEarlyHints(hints, callback = undefined) {
    if (hints == null || typeof hints !== "object" || Array.isArray(hints)) {
      throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "hints" argument must be of type object.');
    }
    if (hints.link == null) return;
    const links = Array.isArray(hints.link) ? hints.link : [hints.link];
    for (const link of links) validateHeaderValue("link", link);
    if (links.length === 0) return;
    const lines = ["HTTP/1.1 103 Early Hints", `Link: ${links.join(", ")}`];
    for (const [name, value] of Object.entries(hints)) {
      if (name.toLowerCase() === "link") continue;
      validateHeaderValue(name, value);
      lines.push(`${name}: ${value}`);
    }
    lines.push("", "");
    const socket = this.socket;
    if (socket && !socket.destroyed && socket.writable) socket.write(lines.join("\r\n"), callback);
    else if (typeof callback === "function") queueMicrotask(callback);
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
    const originalStatus = this.statusCode;
    const status = Number(originalStatus);
    if (!Number.isInteger(status) || status < 100 || status > 999) {
      throw nodeError(RangeError, "ERR_HTTP_INVALID_STATUS_CODE", `Invalid status code: ${originalStatus}`);
    }
    const statusText = this.statusMessage != null ? String(this.statusMessage) : (STATUS_CODES[status] ?? "unknown");
    if (/[\r\n]/.test(statusText)) {
      const error = new Error("Invalid character in statusMessage.");
      error.code = "ERR_INVALID_CHAR";
      throw error;
    }
    const omitImplicitConnectionHeader = this._omitImplicitConnectionHeader ||
      this.hasHeader("x-cottontail-omit-implicit-connection");
    if (this.hasHeader("x-cottontail-omit-implicit-connection")) {
      this.removeHeader("x-cottontail-omit-implicit-connection");
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
    } else if (singleShotLength != null && !this._suppressBody) {
      lines.push(`Content-Length: ${singleShotLength}`);
      this._contentLength = singleShotLength;
    } else if (oldHttp) {
      // HTTP/1.0 cannot use chunked encoding; stream identity and close.
      this._keepAlive = false;
    } else {
      chunked = true;
      lines.push("Transfer-Encoding: chunked");
    }
    this._chunkedWire = chunked;
    if (this._trailers.length > 0 && !chunked) {
      this._headerSent = false;
      this.headersSent = false;
      throw nodeError(Error, "ERR_HTTP_TRAILER_INVALID", "Trailers are invalid with this transfer encoding");
    }
    if (lowerNames.has("content-length")) this._contentLength = contentLengthFromHeaders(this.getHeaders());
    if (this._trailers.length > 0 && chunked && !lowerNames.has("trailer")) {
      lines.push(`Trailer: ${this._trailers.map(([name]) => name).join(", ")}`);
    }
    if (lowerNames.has("connection")) {
      const value = String(this.getHeader("connection")).toLowerCase();
      if (value.split(",").some((item) => item.trim() === "close")) this._keepAlive = false;
    } else if (!omitImplicitConnectionHeader || !this._keepAlive) {
      lines.push(this._keepAlive ? "Connection: keep-alive" : "Connection: close");
    }
    if (this._keepAlive && !omitImplicitConnectionHeader && !lowerNames.has("keep-alive") && this._server?.keepAliveTimeout > 0) {
      const timeout = Math.max(1, Math.floor(this._server.keepAliveTimeout / 1000));
      const max = Number(this._server.maxRequestsPerSocket) > 0 ? `, max=${this._server.maxRequestsPerSocket}` : "";
      lines.push(`Keep-Alive: timeout=${timeout}${max}`);
    }
    if (this.sendDate && !lowerNames.has("date")) lines.push(`Date: ${new Date().toUTCString()}`);
    lines.push("", "");
    const block = lines.join("\r\n");
    this._header = block;
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
      if (this._rejectNonStandardBodyWrites && buf.byteLength > 0) {
        throw nodeError(Error, "ERR_HTTP_BODY_NOT_ALLOWED", "Adding content for this request method or response status is not allowed.");
      }
      if (typeof callback === "function") queueMicrotask(callback);
      return true;
    }
    this._validateContentLength(buf.byteLength, false);
    return this._writeBody(buf, callback);
  }

  _validateContentLength(length, ending) {
    const next = this._responseBytesWritten + Number(length || 0);
    if (this.strictContentLength && this._contentLength != null && (next > this._contentLength || (ending && next !== this._contentLength))) {
      throw nodeError(Error, "ERR_HTTP_CONTENT_LENGTH_MISMATCH", `Response body's content-length of ${next} byte(s) does not match the content-length of ${this._contentLength} byte(s) set in header`);
    }
    this._responseBytesWritten = next;
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
      const head = `${buf.byteLength.toString(16)}\r\n`;
      const wireLength = Buffer.byteLength(head) + buf.byteLength + 2;
      this._pendingResponseBytes += wireLength;
      const done = (error) => {
        this._pendingResponseBytes = Math.max(0, this._pendingResponseBytes - wireLength);
        if (typeof callback === "function") callback(error);
      };
      const okHead = socket.write(head);
      const okBody = socket.write(buf);
      const okTail = socket.write("\r\n", done);
      return okHead && okBody && okTail;
    }
    this._pendingResponseBytes += buf.byteLength;
    return socket.write(buf, (error) => {
      this._pendingResponseBytes = Math.max(0, this._pendingResponseBytes - buf.byteLength);
      if (typeof callback === "function") callback(error);
    });
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
      if (this._suppressBody) {
        if (this._rejectNonStandardBodyWrites) {
          throw nodeError(Error, "ERR_HTTP_BODY_NOT_ALLOWED", "Adding content for this request method or response status is not allowed.");
        }
      } else {
        this._validateContentLength(buf.byteLength, true);
        this._writeBody(buf);
      }
    } else if (!this._suppressBody) {
      this._validateContentLength(0, true);
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
    this._errored = error ?? null;
    if (error != null && this._writableState) this._writableState.errored = error;
    this.detachSocket(socket ?? undefined);
    if (socket) queueMicrotask(() => socket.destroy?.(error));
    this.finished = true;
    this.writableEnded = true;
    this._emitCloseOnce();
    return this;
  }

  _emitCloseOnce() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.destroyed = true;
    this._closed = true;
    if (this._writableState) {
      this._writableState.closed = true;
      this._writableState.closeEmitted = true;
    }
    this.emit("close");
  }

  writeHeader(statusCode, statusMessage = undefined, headers = undefined) {
    return this.writeHead(statusCode, statusMessage, headers);
  }
}

function validateAgentSocketLimit(value) {
  if (typeof value !== "number") {
    const received = typeof value === "string" ? `'${value.replaceAll("'", "\\'")}'` : String(value);
    throw nodeError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "maxTotalSockets" argument must be of type number. Received type ${typeof value} (${received})`,
    );
  }
  if (Number.isNaN(value) || value < 1) {
    throw nodeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "maxTotalSockets" is out of range. It must be >= 1. Received ${value}`);
  }
  return value;
}

class AgentImpl extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = Object.assign(Object.create(null), options);
    if (this.options.noDelay === undefined) this.options.noDelay = true;
    this.options.path = null;
    this.defaultPort = this.options.defaultPort || 80;
    this.protocol = this.options.protocol || "http:";
    this.requests = Object.create(null);
    this.sockets = Object.create(null);
    this.freeSockets = Object.create(null);
    this.keepAliveMsecs = this.options.keepAliveMsecs || 1000;
    this.keepAlive = this.options.keepAlive || false;
    this.maxSockets = this.options.maxSockets || Infinity;
    this.maxFreeSockets = this.options.maxFreeSockets || 256;
    this.maxTotalSockets = this.options.maxTotalSockets === undefined
      ? Infinity
      : validateAgentSocketLimit(this.options.maxTotalSockets);
    this.totalSocketCount = 0;
    this.scheduling = this.options.scheduling || "lifo";
    if (this.scheduling !== "fifo" && this.scheduling !== "lifo") {
      throw nodeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'scheduling' must be one of: 'fifo', 'lifo'. Received '${this.scheduling}'`);
    }
    this.agentKeepAliveTimeoutBuffer = Number.isFinite(this.options.agentKeepAliveTimeoutBuffer) && this.options.agentKeepAliveTimeoutBuffer >= 0
      ? Number(this.options.agentKeepAliveTimeoutBuffer)
      : 1000;
    this._trackedSockets = new Set();
    this._pendingSocketCount = 0;
    this._pendingSockets = Object.create(null);
  }

  createConnection(options, callback = undefined) {
    if (arguments.length === 0 || options == null) {
      throw nodeError(TypeError, "ERR_MISSING_ARGS", 'The "options" or "port" or "path" argument must be specified');
    }
    const connectOptions = { ...this.options, ...options };
    if (connectOptions.socketPath != null) connectOptions.path = connectOptions.socketPath;
    else delete connectOptions.path;
    return netConnect(connectOptions, callback);
  }

  createSocket(request, options, callback = undefined) {
    if (request == null || options == null) {
      throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "request" and "options" arguments are required.');
    }
    const connectOptions = Object.assign(Object.create(null), options, this.options);
    if (connectOptions.socketPath) connectOptions.path = connectOptions.socketPath;
    else delete connectOptions.path;
    const timeout = Number(request?._timeout || request?.timeout || this.options.timeout || 0);
    if (timeout > 0) connectOptions.timeout = timeout;
    connectOptions.encoding = null;
    if (this.keepAlive) {
      connectOptions.keepAlive = true;
      connectOptions.keepAliveInitialDelay = this.keepAliveMsecs;
    }

    let called = false;
    let socket;
    const done = (error, connectedSocket) => {
      if (called) return;
      const created = connectedSocket ?? socket;
      if (error == null && created == null) return;
      called = true;
      if (typeof callback === "function") callback(error ?? null, created);
    };
    try {
      socket = this.createConnection(connectOptions, (error, connectedSocket) => done(error, connectedSocket));
    } catch (error) {
      done(error);
      return undefined;
    }
    if (socket != null) done(null, socket);
    return socket;
  }

  getName(options = {}) {
    let name = options.host || "localhost";
    name += ":";
    if (options.port) name += options.port;
    name += ":";
    if (options.localAddress) name += options.localAddress;
    if (options.family === 4 || options.family === 6) name += `:${options.family}`;
    if (options.socketPath) name += `:${options.socketPath}`;
    return name;
  }

  _activeCount(name) {
    return (this.sockets[name] ?? []).filter((socket) => !socket.destroyed).length;
  }

  _reserveSocket(name) {
    this._pendingSocketCount += 1;
    this._pendingSockets[name] = (this._pendingSockets[name] ?? 0) + 1;
  }

  _releaseReservation(name) {
    this._pendingSocketCount = Math.max(0, this._pendingSocketCount - 1);
    const count = Math.max(0, Number(this._pendingSockets[name] ?? 0) - 1);
    if (count === 0) delete this._pendingSockets[name];
    else this._pendingSockets[name] = count;
  }

  _rememberSocket(name, socket, options = {}) {
    const list = this.sockets[name] ?? [];
    if (!list.includes(socket)) list.push(socket);
    this.sockets[name] = list;
    if (!this._trackedSockets.has(socket)) {
      this._trackedSockets.add(socket);
      this.totalSocketCount += 1;
    }

    const socketOptions = Object.assign(Object.create(null), options, { _agentName: name });
    const existing = socket[agentSocketStateSymbol];
    if (existing?.agent === this && !existing.detached) {
      existing.name = name;
      existing.options = socketOptions;
      existing.free = false;
      return;
    }

    const state = {
      agent: this,
      name,
      options: socketOptions,
      free: false,
      detached: false,
      onFree: null,
      onClose: null,
      onTimeout: null,
      onRemove: null,
    };
    const removeListeners = () => {
      socket.off?.("free", state.onFree);
      socket.off?.("close", state.onClose);
      socket.off?.("timeout", state.onTimeout);
      socket.off?.("agentRemove", state.onRemove);
    };
    state.onFree = () => {
      if (!state.detached) this._releaseSocket(socket, state.options);
    };
    state.onClose = () => {
      if (state.detached) return;
      state.detached = true;
      state.free = false;
      removeListeners();
      if (socket[freeSocketErrorSymbol]) {
        socket.off?.("error", socket[freeSocketErrorSymbol]);
        socket[freeSocketErrorSymbol] = null;
      }
      this.removeSocket(socket, state.options, true, true);
    };
    state.onTimeout = () => {
      if (state.free && this.freeSockets[state.name]?.includes(socket)) socket.destroy?.();
    };
    state.onRemove = () => {
      if (state.detached) return;
      state.detached = true;
      state.free = false;
      removeListeners();
      if (socket[freeSocketErrorSymbol]) {
        socket.off?.("error", socket[freeSocketErrorSymbol]);
        socket[freeSocketErrorSymbol] = null;
      }
      this.removeSocket(socket, state.options, true, true);
    };
    Object.defineProperty(socket, agentSocketStateSymbol, {
      value: state,
      configurable: true,
    });
    socket.on?.("free", state.onFree);
    socket.on?.("close", state.onClose);
    socket.on?.("timeout", state.onTimeout);
    socket.on?.("agentRemove", state.onRemove);
  }

  _takeSocket(options = {}) {
    const name = options._agentName ?? this.getName(options);
    const free = this.freeSockets[name] ?? [];
    while (free.length > 0) {
      const socket = this.scheduling === "fifo" ? free.shift() : free.pop();
      const state = socket?.[agentSocketStateSymbol];
      if (socket && !socket.destroyed && socket.writable !== false && !state?.detached) {
        if (free.length === 0) delete this.freeSockets[name];
        this._rememberSocket(name, socket, options);
        return socket;
      }
      socket?.destroy?.();
    }
    delete this.freeSockets[name];
    return null;
  }

  _takeQueuedRequest(preferredName = undefined, allowOtherNames = false) {
    const names = preferredName == null ? Object.keys(this.requests) : [preferredName];
    if (allowOtherNames) {
      for (const name of Object.keys(this.requests)) {
        if (name !== preferredName) names.push(name);
      }
    }
    for (const name of names) {
      const queue = this.requests[name];
      while (queue?.length) {
        const request = queue.shift();
        if (queue.length === 0) delete this.requests[name];
        const queued = {
          request,
          options: request?.[agentRequestOptionsSymbol],
          resource: request?.[agentRequestResourceSymbol],
        };
        if (request) {
          request[agentRequestOptionsSymbol] = undefined;
          request[agentRequestResourceSymbol] = undefined;
        }
        if (request?.destroyed || request?.aborted) {
          queued.resource?.emitDestroy?.();
          continue;
        }
        return queued;
      }
    }
    return null;
  }

  _runQueued(queued, callback) {
    const run = () => callback(queued.request, queued.options);
    try {
      if (queued.resource) queued.resource.runInAsyncScope(run, queued.request);
      else run();
    } finally {
      queued.resource?.emitDestroy?.();
    }
  }

  _queueRequest(name, request, options) {
    const queue = this.requests[name] ?? [];
    request[agentRequestOptionsSymbol] = Object.assign(Object.create(null), options);
    request[agentRequestResourceSymbol] = new AsyncResource("QueuedRequest");
    queue.push(request);
    this.requests[name] = queue;
  }

  _scheduleQueued(preferredName, allowOtherNames) {
    const queued = this._takeQueuedRequest(preferredName, allowOtherNames);
    if (!queued) return false;
    queueMicrotask(() => this._runQueued(queued, (request, options) => this.addRequest(request, options)));
    return true;
  }

  _assignQueuedSocket(queued, socket, name) {
    this._runQueued(queued, (request, options) => {
      this._rememberSocket(name, socket, options);
      this.reuseSocket(socket, request);
      request._agentOptions = options;
      request.onSocket(socket, true);
    });
  }

  addRequest(request, options = {}, port = undefined, localAddress = undefined) {
    if (request == null || typeof request.emit !== "function" || typeof request.onSocket !== "function") {
      throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "request" argument must be an instance of ClientRequest.');
    }
    if (typeof options === "string") {
      options = { host: options, port, localAddress };
    }
    options = Object.assign(Object.create(null), options, this.options);
    if (options.socketPath) options.path = options.socketPath;
    const name = this.getName(options);
    options._agentName = name;
    request._agentOptions = options;

    const socket = this._takeSocket(options);
    if (socket) {
      this.reuseSocket(socket, request);
      request.onSocket(socket, true);
      return;
    }

    const originCount = this._activeCount(name) + Number(this._pendingSockets[name] ?? 0);
    const totalCount = this.totalSocketCount + this._pendingSocketCount;
    if (originCount >= Number(this.maxSockets) || totalCount >= Number(this.maxTotalSockets)) {
      this._queueRequest(name, request, options);
      return;
    }

    this._reserveSocket(name);
    let settled = false;
    const onSocket = (error, created) => {
      if (settled) return;
      settled = true;
      this._releaseReservation(name);
      if (error || created == null) {
        const failure = error instanceof Error ? error : new Error("Agent failed to create a socket");
        queueMicrotask(() => request.destroy?.(failure));
        this._scheduleQueued(name, true);
        return;
      }
      assignSocketAsyncId(created);
      this._rememberSocket(name, created, options);
      request.onSocket(created, false);
    };
    try {
      this.createSocket(request, options, onSocket);
    } catch (error) {
      onSocket(error);
    }
  }

  removeSocket(socket, options = {}, removeTracking = socket?.destroyed === true, schedule = true) {
    const state = socket?.[agentSocketStateSymbol];
    const name = options._agentName ?? state?.name ?? this.getName(options);
    const active = this.sockets[name] ?? [];
    const nextActive = active.filter((item) => item !== socket);
    if (nextActive.length > 0) this.sockets[name] = nextActive;
    else delete this.sockets[name];
    const free = this.freeSockets[name] ?? [];
    const nextFree = free.filter((item) => item !== socket);
    if (nextFree.length > 0) this.freeSockets[name] = nextFree;
    else delete this.freeSockets[name];
    if (removeTracking && this._trackedSockets.delete(socket)) {
      this.totalSocketCount = Math.max(0, this.totalSocketCount - 1);
    }
    if (schedule) this._scheduleQueued(name, true);
  }

  keepSocketAlive(socket) {
    socket.setKeepAlive?.(true, this.keepAliveMsecs);
    socket.unref?.();
    let timeout = Number(this.options.timeout) || 0;
    const keepAlive = String(socket?._httpMessage?.res?.headers?.["keep-alive"] ?? "");
    const hint = /^timeout=(\d+)/.exec(keepAlive)?.[1];
    if (hint != null) {
      const hintedTimeout = Math.max(0, Number.parseInt(hint, 10) * 1000 - this.agentKeepAliveTimeoutBuffer);
      if (hintedTimeout === 0) return false;
      if (hintedTimeout < timeout) timeout = hintedTimeout;
    }
    if (socket.timeout !== timeout) socket.setTimeout?.(timeout);
    return true;
  }

  reuseSocket(socket, request) {
    const state = socket[agentSocketStateSymbol];
    if (state?.agent === this) state.free = false;
    if (socket[freeSocketErrorSymbol]) {
      socket.off?.("error", socket[freeSocketErrorSymbol]);
      socket[freeSocketErrorSymbol] = null;
    }
    socket.ref?.();
    assignSocketAsyncId(socket);
    request.reusedSocket = true;
  }

  _releaseSocket(socket, options = {}) {
    const state = socket?.[agentSocketStateSymbol];
    if (state?.detached || state?.free) return;
    const name = options._agentName ?? state?.name ?? this.getName(options);
    const socketOptions = Object.assign(Object.create(null), state?.options, options, { _agentName: name });
    if (socket.destroyed || socket.writable === false) {
      socket.destroy?.();
      return;
    }

    this.removeSocket(socket, socketOptions, false, false);
    socket.resume?.();
    markSocketAsyncFree(socket);

    const queued = this._takeQueuedRequest(name, false);
    if (queued) {
      this._assignQueuedSocket(queued, socket, name);
      return;
    }

    if (Number.isFinite(this.maxTotalSockets) &&
        this.totalSocketCount >= Number(this.maxTotalSockets) &&
        Object.keys(this.requests).length > 0) {
      socket.destroy?.();
      return;
    }
    if (!this.keepAlive || this.keepSocketAlive(socket) === false) {
      socket.destroy?.();
      return;
    }

    const free = this.freeSockets[name] ?? [];
    const activeCount = this._activeCount(name);
    if (this.totalSocketCount > Number(this.maxTotalSockets) ||
        activeCount + free.length >= Number(this.maxSockets) ||
        free.length >= Number(this.maxFreeSockets)) {
      socket.destroy?.();
      return;
    }

    socket._httpMessage = null;
    free.push(socket);
    this.freeSockets[name] = free;
    if (state?.agent === this) {
      state.name = name;
      state.options = socketOptions;
      state.free = true;
    }
    const onFreeError = () => {
      socket[freeSocketErrorSymbol] = null;
      socket.destroy?.();
      socket.emit?.("agentRemove");
    };
    socket[freeSocketErrorSymbol] = onFreeError;
    socket.once?.("error", onFreeError);
    this.emit("free", socket, socketOptions);
  }

  destroy() {
    for (const socket of Object.values(this.freeSockets).flat()) socket.destroy?.();
    for (const socket of Object.values(this.sockets).flat()) socket.destroy?.();
  }
}

// Node's http.Agent is callable without `new` (e.g. Agent.apply({})).
export const Agent = new Proxy(AgentImpl, {
  apply(target, _thisArg, args) {
    return new target(...args);
  },
});
Agent.defaultMaxSockets = Infinity;

export const globalAgent = new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000 });

export class ClientRequest extends OutgoingMessage {
  constructor(input, options = undefined, callback = undefined, defaultProtocol = "http:") {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    super();
    const normalized = normalizeRequestOptions(input, options, defaultProtocol);
    const requestOptions = normalized.options;
    const defaultAgent = requestOptions._defaultAgent ?? globalAgent;
    let agent = requestOptions.agent;
    if (agent === false) {
      agent = new defaultAgent.constructor({
        defaultPort: defaultAgent.defaultPort,
        protocol: defaultAgent.protocol,
      });
    } else if (agent == null) {
      agent = defaultAgent;
    } else if (typeof agent.addRequest !== "function") {
      throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "options.agent" property must be an Agent-like object, undefined, or false.');
    }

    const expectedProtocol = typeof agent.isSecureEndpoint === "function"
      ? (agent.isSecureEndpoint(requestOptions) ? "https:" : "http:")
      : String(agent.protocol ?? defaultProtocol);
    if (requestOptions.protocol !== expectedProtocol) {
      throw nodeError(TypeError, "ERR_INVALID_PROTOCOL", `Protocol "${requestOptions.protocol}" not supported. Expected "${expectedProtocol}"`);
    }
    if (requestOptions.method != null && typeof requestOptions.method !== "string") {
      throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "options.method" property must be of type string.');
    }
    const method = String(requestOptions.method || "GET").toUpperCase();
    if (!tokenPattern.test(method)) {
      throw nodeError(TypeError, "ERR_INVALID_HTTP_TOKEN", `Method must be a valid HTTP token ["${requestOptions.method}"]`);
    }
    const path = requestPath(normalized.url, requestOptions);
    if (invalidPathPattern.test(path)) {
      throw nodeError(TypeError, "ERR_UNESCAPED_CHARACTERS", "Request path contains unescaped characters");
    }

    this.url = normalized.url;
    this.method = method;
    this.path = path;
    this.host = requestOptions._hostname;
    this.port = requestOptions._port;
    this.protocol = requestOptions.protocol;
    this.aborted = false;
    this.destroyed = false;
    this._options = requestOptions;
    this._socket = null;
    this.socket = null;
    this[clientSocketCleanupSymbol] = null;
    this._agentOptions = null;
    this.agent = agent;
    this.reusedSocket = false;
    this._dispatched = false;
    this._responseEmitted = false;
    this._closeEmitted = false;
    this._requestConnected = false;
    this._requestHeadSent = false;
    this._headerSent = false;
    this._requestTerminated = false;
    this._requestChunked = false;
    this._requestFinishedEmitted = false;
    this._requestWriteStarted = false;
    this._requestEndOnly = false;
    this._requestPending = [];
    this._requestPendingBytes = 0;
    this._deferredResponseRelease = null;
    this._waitingForContinue = false;
    this._continueTimer = null;
    this._setNoDelay = requestOptions.noDelay !== false;
    this._keepAliveSetting = null;
    this.res = null;
    this.maxHeadersCount = null;
    this.maxHeaderSize = requestOptions.maxHeaderSize;
    if (this.maxHeaderSize !== undefined) validateIntegerOption(this.maxHeaderSize, "maxHeaderSize", 0);
    this.insecureHTTPParser = requestOptions.insecureHTTPParser;
    if (this.insecureHTTPParser !== undefined) validateBooleanOption(this.insecureHTTPParser, "options.insecureHTTPParser");
    this.joinDuplicateHeaders = requestOptions.joinDuplicateHeaders;
    if (this.joinDuplicateHeaders !== undefined) validateBooleanOption(this.joinDuplicateHeaders, "options.joinDuplicateHeaders");
    this._timeout = requestOptions.timeout == null ? 0 : Number(requestOptions.timeout);
    if (!Number.isFinite(this._timeout) || this._timeout < 0) {
      throw nodeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "timeout" is out of range. It must be >= 0. Received ${requestOptions.timeout}`);
    }
    this._timeoutAutoDestroy = this._timeout > 0;
    this._timeoutTimer = null;

    const requestHeaders = requestOptions.headers;
    if (Array.isArray(requestHeaders)) {
      if (Array.isArray(requestHeaders[0])) {
        for (const entry of requestHeaders) {
          if (!Array.isArray(entry) || entry.length !== 2) {
            throw nodeError(TypeError, "ERR_INVALID_ARG_VALUE", "options.headers must contain [name, value] entries");
          }
          this.appendHeader(entry[0], entry[1]);
        }
      } else {
        if (requestHeaders.length % 2 !== 0) {
          throw nodeError(TypeError, "ERR_INVALID_ARG_VALUE", "options.headers must contain alternating name and value entries");
        }
        for (let index = 0; index < requestHeaders.length; index += 2) {
          this.appendHeader(requestHeaders[index], requestHeaders[index + 1]);
        }
      }
    } else if (requestHeaders) {
      for (const [name, value] of Object.entries(requestHeaders)) this.setHeader(name, value);
    }
    if (requestOptions._auth != null && !this.hasHeader("authorization")) {
      this.setHeader("Authorization", `Basic ${Buffer.from(String(requestOptions._auth)).toString("base64")}`);
    }

    const signal = requestOptions.signal;
    if (signal && typeof signal.addEventListener === "function") {
      const onAbort = () => this.abort();
      if (signal.aborted) queueMicrotask(onAbort);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (typeof callback === "function") this.once("response", callback);
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this.writableEnded) {
      if (typeof callback === "function") queueMicrotask(() => callback(nodeError(Error, "ERR_STREAM_ALREADY_FINISHED", "Calling end on an already finished stream")));
      return this;
    }
    this._requestEndOnly = !this._requestWriteStarted && !this._dispatched;
    if (chunk != null) this._queueRequestChunk(chunk, encoding, undefined);
    this.finished = true;
    this.writableEnded = true;
    if (typeof callback === "function") this.once("finish", callback);
    this._dispatch();
    this._flushRequestBody();
    return this;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this.writableEnded) {
      const error = nodeError(Error, "ERR_STREAM_WRITE_AFTER_END", "write after end");
      queueMicrotask(() => {
        callback?.(error);
        if (this.listenerCount("error") > 0) this.emit("error", error);
      });
      return false;
    }
    this._requestWriteStarted = true;
    this._queueRequestChunk(chunk, encoding, callback);
    this._dispatch();
    return this._flushRequestBody();
  }

  _queueRequestChunk(chunk, encoding, callback) {
    if (chunk == null) throw nodeError(TypeError, "ERR_STREAM_NULL_VALUES", "May not write null values to stream");
    if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk)) {
      throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "chunk" argument must be of type string or an instance of Buffer or Uint8Array.');
    }
    const body = bodyBufferFrom(chunk, encoding);
    this._requestPending.push({ body: Buffer.from(body), callback });
    this._requestPendingBytes += body.byteLength;
    this._bytesWritten += body.byteLength;
  }

  _finishRequest() {
    if (this._requestFinishedEmitted) return;
    this._requestFinishedEmitted = true;
    queueMicrotask(() => {
      this.emit("prefinish");
      this.emit("finish");
      const release = this._deferredResponseRelease;
      this._deferredResponseRelease = null;
      release?.();
    });
  }

  _flushRequestBody() {
    if (!this._requestConnected || !this._requestHeadSent || this._waitingForContinue || this.destroyed) {
      return this._requestPendingBytes < Number(this.writableHighWaterMark ?? 16 * 1024);
    }
    let writable = true;
    while (this._requestPending.length > 0) {
      const { body, callback } = this._requestPending.shift();
      this._requestPendingBytes -= body.byteLength;
      if (this._requestChunked) {
        if (body.byteLength === 0) {
          if (typeof callback === "function") queueMicrotask(callback);
          continue;
        }
        writable = this._socket.write(`${body.byteLength.toString(16)}\r\n`) && writable;
        writable = this._socket.write(body) && writable;
        writable = this._socket.write("\r\n", callback) && writable;
      } else {
        writable = this._socket.write(body, callback) && writable;
      }
    }
    if (this.writableEnded && !this._requestTerminated) {
      this._requestTerminated = true;
      if (this._requestChunked) writable = this._socket.write("0\r\n\r\n", () => this._finishRequest()) && writable;
      else this._socket.write(kEmptyBuffer, () => this._finishRequest());
    }
    return writable;
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    queueMicrotask(() => this.emit("abort"));
    this.destroy();
  }

  destroy(error = undefined) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this._clearTimeoutTimer();
    if (this._continueTimer != null) clearTimeout(this._continueTimer);
    this._continueTimer = null;
    this.res?._dump?.();
    if (this._socket) {
      const absorbLateSocketError = () => {};
      this._socket.on?.("error", absorbLateSocketError);
      this._socket.once?.("close", () => this._socket?.off?.("error", absorbLateSocketError));
    }
    this[clientSocketCleanupSymbol]?.();
    if (this._socket) this._socket.destroy();
    if (error) this.emit("error", error);
    this._emitClose();
    return this;
  }

  flushHeaders() {
    this._requestWriteStarted = true;
    this._dispatch();
    this._flushRequestBody();
  }

  setNoDelay(noDelay = true) {
    this._setNoDelay = Boolean(noDelay);
    this._socket?.setNoDelay?.(this._setNoDelay);
    return this;
  }

  setSocketKeepAlive(enable = true, initialDelay = 0) {
    this._keepAliveSetting = [Boolean(enable), Number(initialDelay) || 0];
    this._socket?.setKeepAlive?.(...this._keepAliveSetting);
    return this;
  }

  setTimeout(timeout, callback = undefined) {
    const value = Number(timeout);
    if (!Number.isFinite(value) || value < 0) {
      throw nodeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "msecs" is out of range. It must be >= 0. Received ${timeout}`);
    }
    this._timeout = value;
    this._timeoutAutoDestroy = false;
    if (typeof callback === "function") {
      if (value === 0) this.removeListener("timeout", callback);
      else this.once("timeout", callback);
    }
    if (this._socket || this._timeout === 0) this._installTimeout();
    return this;
  }

  clearTimeout(callback = undefined) {
    return this.setTimeout(0, callback);
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
    this.res = parsed.message;
    this._socket._httpMessage = this;
    if (!this.emit("response", parsed.message)) parsed.message._dump?.();
  }

  _dispatch() {
    if (this.aborted || this._dispatched) return;
    this._dispatched = true;
    const secure = this.protocol === "https:";
    const defaultPort = secure ? 443 : 80;
    const requestOptions = {
      ...this._options,
      protocol: this.protocol,
      secureEndpoint: secure,
      host: this.host || "localhost",
      hostname: this.host || "localhost",
      port: Number(this._options._port || defaultPort),
      _agentName: this.agent?.getName?.({
        ...this._options,
        host: this.host || "localhost",
        hostname: this.host || "localhost",
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
    socket._httpMessage = this;
    socket.setNoDelay?.(this._setNoDelay);
    if (this._keepAliveSetting) socket.setKeepAlive?.(...this._keepAliveSetting);
    const runInSocketScope = (callback, ...args) => {
      const resource = socket[socketAsyncResourceSymbol];
      if (resource && typeof resource.runInAsyncScope === "function") {
        return resource.runInAsyncScope(callback, this, ...args);
      }
      return callback(...args);
    };
    const onDrain = () => runInSocketScope(() => this.emit("drain"));
    socket.on?.("drain", onDrain);
    queueMicrotask(() => this.emit("socket", socket));
    let completed = false;
    let connected = false;
    let responseMessage = null;
    let responseShouldKeepAlive = false;
    let processingResponseData = false;
    let pendingSocketEnd = false;
    let wireParser = null;
    const sendContinueBody = () => {
      if (!this._waitingForContinue) return;
      this._waitingForContinue = false;
      if (this._continueTimer != null) {
        clearTimeout(this._continueTimer);
        this._continueTimer = null;
      }
      this._flushRequestBody();
    };
    const cleanup = () => {
      this._clearTimeoutTimer();
      if (this._continueTimer != null) {
        clearTimeout(this._continueTimer);
        this._continueTimer = null;
      }
      socket.off?.("connect", onSocketConnect);
      socket.off?.("data", onSocketData);
      socket.off?.("end", onSocketEnd);
      socket.off?.("error", onSocketError);
      socket.off?.("drain", onDrain);
      if (responseMessage) responseMessage[incomingParserResumeSymbol] = null;
      wireParser?.close();
      if (this[clientSocketCleanupSymbol] === cleanup) this[clientSocketCleanupSymbol] = null;
    };
    this[clientSocketCleanupSymbol] = cleanup;
    const releaseOrClose = (message, isTunnel = false) => {
      if (completed) return;
      if (!isTunnel && !this._requestFinishedEmitted) {
        this._deferredResponseRelease = () => releaseOrClose(message, false);
        return;
      }
      completed = true;
      cleanup();
      const canKeepAlive = this.agent?.keepAlive && responseShouldKeepAlive && !isTunnel;
      if (!isTunnel) {
        if (canKeepAlive) this.agent._releaseSocket?.(socket, this._agentOptions ?? this._options);
        else {
          // The parser no longer owns a completed one-shot socket, but FIN and
          // peer RST delivery can race after cleanup. Keep an error owner until
          // close so a late transport error does not become an uncaught event.
          const absorbLateSocketError = () => {};
          socket.on?.("error", absorbLateSocketError);
          socket.once?.("close", () => socket.off?.("error", absorbLateSocketError));
          socket.end?.();
        }
      }
      if (socket._httpMessage === this) socket._httpMessage = null;
      this._emitClose();
    };
    const failResponse = (error, fromSocket = false) => {
      if (this.destroyed) return;
      this.destroyed = true;
      cleanup();
      const failure = fromSocket ? socketError(error, socket) : error;
      if (responseMessage && !responseMessage.complete) {
        const absorbTerminalResponseError = () => {};
        responseMessage.on?.("error", absorbTerminalResponseError);
        responseMessage.once?.("close", () => responseMessage?.off?.("error", absorbTerminalResponseError));
        responseMessage.destroy?.(failure);
      }
      socket.destroy?.();
      this.emit("error", failure);
      this._emitClose();
    };
    const onConnect = () => {
      if (connected || this.aborted || this.destroyed) return;
      connected = true;
      this._requestConnected = true;
      this._installTimeout();
      if (!this.hasHeader("host") && this._options.setHost !== false) {
        this.setHeader("Host", formatHostHeader(this.host, this.port, this._options._defaultPort));
      }
      let usesChunkedEncoding = String(this.getHeader("transfer-encoding") ?? "")
        .toLowerCase()
        .split(",")
        .some((value) => value.trim() === "chunked");
      if (usesChunkedEncoding) {
        this.removeHeader("content-length");
      } else if (!this.hasHeader("content-length")) {
        if (this._requestEndOnly) {
          if (this._requestPendingBytes > 0 || !bodylessRequestMethods.has(this.method)) {
            this.setHeader("Content-Length", String(this._requestPendingBytes));
          }
        } else if (this._requestPendingBytes > 0 || (!this.writableEnded && !bodylessRequestMethods.has(this.method))) {
          this.setHeader("Transfer-Encoding", "chunked");
          usesChunkedEncoding = true;
        }
      }
      if (!this.hasHeader("connection")) this.setHeader("Connection", this.agent?.keepAlive ? "keep-alive" : "close");
      const lines = [`${this.method} ${this.path} HTTP/1.1`];
      for (const [name, value] of headerEntries(this)) {
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${name}: ${item}`);
        } else {
          lines.push(`${name}: ${value}`);
        }
      }
      lines.push("", "");
      this._requestChunked = usesChunkedEncoding;
      this._requestHeadSent = true;
      this._headerSent = true;
      this.headersSent = true;
      this._header = lines.join("\r\n");
      socket.write(Buffer.from(this._header));
      this._waitingForContinue = String(this.getHeader("expect") ?? "").toLowerCase() === "100-continue" && this._requestPendingBytes > 0;
      if (this._waitingForContinue) {
        this._continueTimer = setTimeout(sendContinueBody, 1000);
        this._continueTimer.unref?.();
      } else {
        this._flushRequestBody();
      }
    };
    wireParser = new SocketHTTPParser(BindingHTTPParser.RESPONSE, {
      maxHeaderSize: this.maxHeaderSize ?? getCurrentMaxHeaderSize(),
      insecureHTTPParser: this.insecureHTTPParser === true,
      onHeaders: (info) => {
        const block = materializeIncomingHeaders(info.rawHeaders, this.joinDuplicateHeaders === true, this.maxHeadersCount);
        if (info.statusCode >= 100 && info.statusCode < 200 && info.statusCode !== 101) {
          const information = {
            statusCode: info.statusCode,
            statusMessage: info.statusMessage,
            headers: block.headers,
            rawHeaders: block.rawHeaders,
            httpVersion: `${info.major}.${info.minor}`,
            httpVersionMajor: info.major,
            httpVersionMinor: info.minor,
          };
          if (info.statusCode === 100) {
            this.emit("continue");
            sendContinueBody();
          }
          this.emit("information", information);
          return { state: { informational: true } };
        }

        if (this._waitingForContinue) {
          this._waitingForContinue = false;
          if (this._continueTimer != null) clearTimeout(this._continueTimer);
          this._continueTimer = null;
          for (const pending of this._requestPending.splice(0)) pending.callback?.();
          this._requestPendingBytes = 0;
          this._finishRequest();
        }

        const message = new IncomingMessage({
          httpVersion: `${info.major}.${info.minor}`,
          statusCode: info.statusCode,
          statusMessage: info.statusMessage,
          headers: block.headers,
          rawHeaders: block.rawHeaders,
          socket,
          deferBody: true,
        });
        message.joinDuplicateHeaders = this.joinDuplicateHeaders;
        message.req = this;
        responseMessage = message;
        responseShouldKeepAlive = info.shouldKeepAlive;
        message[incomingParserResumeSymbol] = () => {
          try {
            return runInSocketScope(() => wireParser.resume());
          } catch (error) {
            queueMicrotask(() => failResponse(error));
            return false;
          }
        };

        const isTunnel = (this.method === "CONNECT" && info.statusCode >= 200 && info.statusCode < 300) || info.statusCode === 101;
        if (!isTunnel) this._emitParsedResponse({ message, head: kEmptyBuffer, consumed: 0 });
        return {
          state: { message, isTunnel, informational: false },
          action: this.method === "HEAD" ? 1 : isTunnel ? 2 : 0,
          upgrade: isTunnel,
        };
      },
      onBody: (state, bodyChunk) => {
        if (!state?.message) return true;
        const accepted = state.message._pushIncomingChunk(bodyChunk);
        if (!accepted) socket.pause?.();
        return accepted;
      },
      onComplete: (state, rawTrailers) => {
        if (!state || state.informational || !state.message) return;
        const trailers = materializeIncomingHeaders(rawTrailers, this.joinDuplicateHeaders === true, this.maxHeadersCount);
        state.message._completeIncoming(trailers.headers, trailers.rawHeaders);
        if (!state.isTunnel) {
          wireParser.paused = true;
          wireParser.parser.pause();
          socket.pause?.();
          releaseOrClose(state.message, false);
        }
      },
      onUpgrade: (state, head) => {
        if (!state?.message) return;
        state.message[incomingParserResumeSymbol] = null;
        socket.emit?.("agentRemove");
        this._emitParsedResponse({ message: state.message, head, consumed: 0 });
        releaseOrClose(state.message, true);
      },
    });
    const onData = (chunk) => {
      if (completed) return;
      processingResponseData = true;
      this._installTimeout();
      try {
        wireParser.execute(chunk);
      } catch (error) {
        failResponse(error);
      } finally {
        processingResponseData = false;
        if (pendingSocketEnd) {
          pendingSocketEnd = false;
          onEnd();
        }
      }
    };
    const onEnd = () => {
      if (processingResponseData) {
        pendingSocketEnd = true;
        return;
      }
      if (!completed && !this.destroyed && !this.aborted) {
        try {
          wireParser.finish();
        } catch {
          const error = nodeError(Error, "ECONNRESET", this._responseEmitted ? "aborted" : "socket hang up");
          failResponse(error);
          return;
        }
        if (!completed && !this._responseEmitted) {
          failResponse(nodeError(Error, "ECONNRESET", "socket hang up"));
          return;
        }
      }
      if (!completed) {
        cleanup();
        this._emitClose();
      }
    };
    const onError = (error) => {
      failResponse(error, true);
    };
    const onSocketConnect = () => runInSocketScope(onConnect);
    const onSocketData = (chunk) => runInSocketScope(onData, chunk);
    const onSocketEnd = () => runInSocketScope(onEnd);
    const onSocketError = (error) => runInSocketScope(onError, error);
    socket.once("connect", onSocketConnect);
    socket.on("data", onSocketData);
    socket.on("end", onSocketEnd);
    socket.on("error", onSocketError);
    if (reused || socket.readyState === "open") queueMicrotask(onSocketConnect);
  }
}

function createServerIncomingMessage(server, socket, init) {
  const Incoming = server._IncomingMessage ?? IncomingMessage;
  const message = Incoming === IncomingMessage
    ? new Incoming({ ...init, socket, deferBody: true })
    : new Incoming(socket);
  message.aborted = false;
  message.complete = false;
  message.headers = init.headers ?? {};
  message.rawHeaders = init.rawHeaders ?? [];
  message.httpVersion = String(init.httpVersion ?? "1.1");
  const [major = "1", minor = "1"] = message.httpVersion.split(".");
  message.httpVersionMajor = Number(major) || 1;
  message.httpVersionMinor = Number(minor) || 0;
  message.method = init.method;
  message.url = init.url;
  message.joinDuplicateHeaders = server.joinDuplicateHeaders;
  message.socket = socket;
  message.connection = socket;
  message.trailers = {};
  message.rawTrailers = [];
  message._headersDistinct = null;
  message._trailersDistinct = null;
  message._incomingBody = kEmptyBuffer;
  message._incomingBodyChunks = [];
  return message;
}

export function _configureHttpServer(server, options = {}, requestListener = undefined) {
  if (options == null) options = {};
  if (typeof options !== "object" || Array.isArray(options)) {
    throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "options" argument must be of type object.');
  }
  server._options = { ...options };
  server._IncomingMessage = options.IncomingMessage ?? IncomingMessage;
  server._ServerResponse = options.ServerResponse ?? ServerResponse;
  if (typeof server._IncomingMessage !== "function") {
    throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "options.IncomingMessage" property must be a constructor.');
  }
  if (typeof server._ServerResponse !== "function") {
    throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "options.ServerResponse" property must be a constructor.');
  }

  server.timeout = options.timeout == null ? 0 : validateIntegerOption(options.timeout, "timeout", 0);
  server.requestTimeout = options.requestTimeout == null ? 300000 : validateIntegerOption(options.requestTimeout, "requestTimeout", 0);
  server.headersTimeout = options.headersTimeout == null
    ? Math.min(60000, server.requestTimeout || 60000)
    : validateIntegerOption(options.headersTimeout, "headersTimeout", 0);
  if (server.requestTimeout > 0 && server.headersTimeout > server.requestTimeout) {
    throw nodeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "headersTimeout" is out of range. It must be <= requestTimeout. Received ${server.headersTimeout}`);
  }
  server.keepAliveTimeout = options.keepAliveTimeout == null ? 5000 : validateIntegerOption(options.keepAliveTimeout, "keepAliveTimeout", 0);
  server.connectionsCheckingInterval = options.connectionsCheckingInterval == null
    ? 30000
    : validateIntegerOption(options.connectionsCheckingInterval, "connectionsCheckingInterval", 0);
  server.maxHeaderSize = options.maxHeaderSize;
  if (server.maxHeaderSize !== undefined) validateIntegerOption(server.maxHeaderSize, "maxHeaderSize", 0);
  server.insecureHTTPParser = options.insecureHTTPParser;
  if (server.insecureHTTPParser !== undefined) {
    validateBooleanOption(server.insecureHTTPParser, "options.insecureHTTPParser");
  }
  server.requireHostHeader = options.requireHostHeader == null ? true : validateBooleanOption(options.requireHostHeader, "options.requireHostHeader");
  server.joinDuplicateHeaders = options.joinDuplicateHeaders;
  if (server.joinDuplicateHeaders !== undefined) validateBooleanOption(server.joinDuplicateHeaders, "options.joinDuplicateHeaders");
  server.rejectNonStandardBodyWrites = options.rejectNonStandardBodyWrites == null
    ? false
    : validateBooleanOption(options.rejectNonStandardBodyWrites, "options.rejectNonStandardBodyWrites");
  server.noDelay = options.noDelay !== false;
  server.keepAlive = options.keepAlive !== false;
  server.keepAliveInitialDelay = Number(options.keepAliveInitialDelay ?? 0) || 0;
  server.highWaterMark = options.highWaterMark;
  server.uniqueHeaders = options.uniqueHeaders;
  if (typeof requestListener === "function") server.on("request", requestListener);
  return server;
}

export function _attachHttpConnection(server, socket) {
  socket.setNoDelay?.(server.noDelay !== false);
  if (server.keepAlive !== false) socket.setKeepAlive?.(true, server.keepAliveInitialDelay ?? 0);
  socket._cottontailHttpRequestCount = Number(socket._cottontailHttpRequestCount ?? 0);
  let currentMessage = null;
  let wireParser = null;
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
    if (currentMessage) currentMessage[incomingParserResumeSymbol] = null;
    wireParser?.close();
    clearParserTimers();
    clearKeepAliveTimer();
  };

  const fail = (error, statusLine = error?.statusLine ?? (error?.code === "HPE_HEADER_OVERFLOW"
    ? "431 Request Header Fields Too Large"
    : error?.code === "HPE_INVALID_VERSION" ? "505 HTTP Version Not Supported" : "400 Bad Request")) => {
    detachParser();
    // Parser failures must abort the request body without closing the
    // transport before a clientError listener or the fallback response runs.
    currentMessage?._abortIncoming?.(false);
    if (error && error.code == null) error.code = "HPE_INTERNAL";
    if (server.listenerCount("clientError") > 0) {
      server.emit("clientError", error, socket);
      if (socket.destroyed || socket.writableEnded || socket.writable === false) return;
    }
    socket.on?.("error", () => {});
    try { socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
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
    const keepAlive = message._parserShouldKeepAlive !== false;
    const Response = server._ServerResponse ?? ServerResponse;
    const response = new Response(message);
    response._server = server;
    response._requestCount = message._requestCount ?? 0;
    response._rejectNonStandardBodyWrites = server.rejectNonStandardBodyWrites === true;
    response._keepAlive = keepAlive && !(server.maxRequestsPerSocket > 0 && response._requestCount >= server.maxRequestsPerSocket);
    response.shouldKeepAlive = response._keepAlive;
    response.assignSocket(socket);
    refHttpResponseTask(response);
    active = response;
    response._onFinishFlushed = () => {
      if (active !== response) return;
      unrefHttpResponseTask(response);
      active = null;
      response.detachSocket(socket);
      queueMicrotask(() => {
        if (!message.readableEnded && !message.destroyed) message._dump?.();
      });
      if (server._closing || !response._keepAlive) {
        if (socket._cottontailHttpDropPending !== true) socket.destroy?.();
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
      const expect = String(message.headers.expect ?? "").toLowerCase();
      if (expect === "100-continue") {
        if (server.listenerCount("checkContinue") > 0) {
          requestResource.runInAsyncScope(() => server.emit("checkContinue", message, response), server);
        } else {
          response.writeContinue();
          requestResource.runInAsyncScope(() => server.emit("request", message, response), server);
        }
      } else if (expect !== "") {
        if (server.listenerCount("checkExpectation") > 0) {
          requestResource.runInAsyncScope(() => server.emit("checkExpectation", message, response), server);
        } else {
          response.writeHead(417);
          response.end();
        }
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

  wireParser = new SocketHTTPParser(BindingHTTPParser.REQUEST, {
    maxHeaderSize: server.maxHeaderSize ?? getCurrentMaxHeaderSize(),
    insecureHTTPParser: server.insecureHTTPParser === true,
    onMessageBegin: () => {
      clearKeepAliveTimer();
      refreshHeadersTimer();
    },
    onHeaders: (info) => {
      if (headersTimer != null) {
        clearTimeout(headersTimer);
        headersTimer = null;
      }
      if (info.major !== 1 || info.minor > 1) {
        const error = new Error("Unsupported HTTP version");
        error.code = "HPE_INVALID_VERSION";
        error.statusLine = "505 HTTP Version Not Supported";
        throw error;
      }
      const block = materializeIncomingHeaders(info.rawHeaders, server.joinDuplicateHeaders === true);
      if (server.requireHostHeader !== false && info.minor >= 1 && block.headers.host == null) {
        const error = new Error("Missing Host header");
        error.code = "HPE_INTERNAL";
        throw error;
      }

      const message = createServerIncomingMessage(server, socket, {
        httpVersion: `${info.major}.${info.minor}`,
        method: info.method,
        url: info.url,
        headers: block.headers,
        rawHeaders: block.rawHeaders,
        highWaterMark: server.highWaterMark,
      });
      message._parserShouldKeepAlive = info.shouldKeepAlive;
      message.upgrade = info.upgrade;
      currentMessage = message;
      message[incomingParserResumeSymbol] = () => {
        try {
          const resumed = wireParser.resume();
          if (message.complete) message[incomingParserResumeSymbol] = null;
          return resumed;
        } catch (error) {
          queueMicrotask(() => fail(error));
          return false;
        }
      };

      socket._cottontailHttpRequestCount += 1;
      message._requestCount = socket._cottontailHttpRequestCount;
      if (server.maxRequestsPerSocket > 0 && socket._cottontailHttpRequestCount > server.maxRequestsPerSocket) {
        server.emit("dropRequest", message, socket);
        socket._cottontailHttpDropPending = true;
        return { state: { message, dropped: true }, action: 2, upgrade: true };
      }

      const tunnelType = String(info.method).toUpperCase() === "CONNECT"
        ? "connect"
        : info.upgrade ? "upgrade" : null;
      const state = { message, tunnelType, dropped: false };
      refreshRequestTimer();
      if (tunnelType == null) {
        queue.push(message);
        processNext();
      }
      return { state, action: tunnelType == null ? 0 : 2, upgrade: tunnelType != null };
    },
    onBody: (state, bodyChunk) => {
      if (!state?.message || state.dropped) return true;
      refreshRequestTimer();
      const accepted = state.message._pushIncomingChunk(bodyChunk);
      if (!accepted) socket.pause?.();
      return accepted;
    },
    onComplete: (state, rawTrailers) => {
      if (requestTimer != null) {
        clearTimeout(requestTimer);
        requestTimer = null;
      }
      if (!state?.message || state.dropped) return;
      const trailers = materializeIncomingHeaders(rawTrailers, server.joinDuplicateHeaders === true);
      state.message._completeIncoming(trailers.headers, trailers.rawHeaders, wireParser.paused);
      if (currentMessage === state.message) currentMessage = null;
      if (state.tunnelType != null) tunnel = { type: state.tunnelType, message: state.message };
    },
    onUpgrade: (state, head) => {
      if (!state?.message) return;
      if (state.dropped) {
        currentMessage = null;
        detachParser();
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (tunnel == null) tunnel = { type: state.tunnelType, message: state.message };
      if (head.byteLength > 0) tunnelChunks.push(head);
      processNext();
    },
  });

  const onData = (chunk) => {
    clearKeepAliveTimer();
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (tunnel != null || stopped) {
      if (tunnel != null && buf.byteLength > 0) tunnelChunks.push(buf);
      return;
    }
    try {
      wireParser.execute(buf);
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
  socket.on("end", () => {
    if (stopped) return;
    try {
      wireParser.finish();
    } catch (error) {
      fail(error);
      return;
    }
    if (currentMessage && !currentMessage.complete) {
      const message = currentMessage;
      detachParser();
      message._abortIncoming();
    }
  });
  socket.on("close", () => {
    if (active) {
      unrefHttpResponseTask(active);
      active = null;
    }
    currentMessage?._abortIncoming?.();
    currentMessage = null;
    wireParser?.close();
    clearParserTimers();
    clearKeepAliveTimer();
  });
}

class ServerImpl extends EventEmitter {
  constructor(options = {}, requestListener = undefined) {
    if (typeof options === "function") {
      requestListener = options;
      options = {};
    }
    super({ captureRejections: true });
    this.listening = false;
    this._native = null;
    this._handle = null;
    this._connections = new Set();
    this._closing = false;
    this.maxRequestsPerSocket = 0;
    _configureHttpServer(this, options, requestListener);
  }

  listen(...args) {
    this._closing = false;
    ensureActiveFetchHeaderLimit();
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
    this._native.listen(options, (error) => {
      if (error) {
        this.emit("error", error);
        return;
      }
      this.listening = true;
      this.emit("listening", ..._httpListeningCallbackArgs(this, options));
    });
    return this;
  }

  close(callback = undefined) {
    this._closing = true;
    this.closeIdleConnections();
    if (!this._native) {
      if (typeof callback === "function") {
        const error = nodeError(Error, "ERR_SERVER_NOT_RUNNING", "Server is not running.");
        queueMicrotask(() => callback(error));
      }
      return this;
    }
    if (typeof callback === "function") this.once("close", callback);
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
      if (socket._httpMessage == null && socket._cottontailBunServeUpgradeActive !== true) socket.destroy?.();
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
    this.timeout = validateIntegerOption(Number(timeout), "msecs", 0);
    if (typeof callback === "function") this.on("timeout", callback);
    return this;
  }

  [captureRejectionSymbol](error, event, ...args) {
    if (event === "request" || event === "checkContinue" || event === "checkExpectation") {
      const response = args[1];
      if (response && !response.headersSent && !response.writableEnded) {
        for (const name of response.getHeaderNames()) response.removeHeader(name);
        response.statusCode = 500;
        response.end(STATUS_CODES[500]);
        return;
      }
      response?.destroy?.(error);
      return;
    }
    this.emit("error", error);
  }

  [ensureAsyncDisposeSymbol()]() {
    return new Promise((resolve) => this.close(() => resolve()));
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
  return new ClientRequest(input, options, callback, "http:");
}

export function get(input, options = undefined, callback = undefined) {
  const req = request(input, options, callback);
  req.end();
  return req;
}

export function setMaxIdleHTTPParsers(value) {
  setMaxIdleHTTPParsers.value = validateIntegerOption(value, "max", 1);
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

const WEBSOCKET_KEY_PATTERN = /^[+/0-9A-Za-z]{22}==$/;
const WEBSOCKET_COMPRESS_THRESHOLD = 860;

function normalizeWebSocketProxyOption(proxy) {
  if (proxy == null) return null;
  let urlValue = proxy;
  const headers = [];
  if (typeof proxy === "object") {
    urlValue = proxy.url;
    const rawHeaders = proxy.headers;
    if (rawHeaders != null) {
      const entries = typeof rawHeaders.entries === "function" ? rawHeaders.entries() : Object.entries(rawHeaders);
      for (const [name, value] of entries) headers.push([String(name), String(value)]);
    }
  }
  let parsed;
  try {
    parsed = new URL(String(urlValue));
  } catch {
    throw new SyntaxError(`Invalid proxy URL: ${String(urlValue)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SyntaxError(`Unsupported proxy protocol: ${parsed.protocol}`);
  }
  return { url: parsed, headers };
}

function websocketNoProxyMatches(hostname, port) {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy;
  if (!raw) return false;
  const target = String(hostname).toLowerCase();
  for (const rawEntry of String(raw).split(",")) {
    let entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    let entryPort = null;
    const colon = entry.lastIndexOf(":");
    if (colon > 0 && !entry.slice(colon).includes("]")) {
      const maybePort = entry.slice(colon + 1);
      if (/^\d+$/.test(maybePort)) {
        entryPort = maybePort;
        entry = entry.slice(0, colon);
      }
    }
    if (entryPort != null && String(port) !== entryPort) continue;
    if (entry.startsWith(".")) entry = entry.slice(1);
    if (target === entry || target.endsWith(`.${entry}`)) return true;
  }
  return false;
}

function websocketTlsServername(hostname) {
  const value = String(hostname);
  const address = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return isIP(address) ? undefined : value;
}

// Wraps an established byte stream (e.g. an HTTP CONNECT tunnel) in a TLS
// client session using the shared memory-BIO Duplex transport.
function websocketTlsOverStream(stream, options, callback, onError) {
  try {
    const tlsSocket = tlsConnect({
      socket: stream,
      servername: options.servername,
      rejectUnauthorized: options.rejectUnauthorized,
      ca: options.ca,
    });
    callback(tlsSocket);
  } catch (error) {
    onError(error);
  }
}

function isWebSocketTlsHandshakeError(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? error ?? "");
  return /(?:CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|WRONG_VERSION|UNKNOWN_CA)/i.test(code) ||
    /(?:certificate|self[- ]signed|tls handshake|ssl routines|unknown ca)/i.test(message);
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
    this._messageCompressed = false;
    this._deflate = null;
    this._aborted = false;
    this._pendingWriteFrames = [];
    this._pendingWriteBytes = 0;
    this._writeFlushScheduled = false;
    // Bun accepts an options object ({ headers, protocols, protocol, proxy,
    // tls, perMessageDeflate }) in place of the protocols argument.
    let options = null;
    if (protocols != null && typeof protocols === "object" && !Array.isArray(protocols) &&
        typeof protocols[Symbol.iterator] !== "function") {
      options = protocols;
      protocols = options.protocols ?? options.protocol ?? undefined;
    }
    this._customHeaders = [];
    const rawHeaders = options?.headers;
    if (rawHeaders != null) {
      const entries = typeof rawHeaders.entries === "function" ? rawHeaders.entries() : Object.entries(rawHeaders);
      for (const [name, value] of entries) {
        const headerName = String(name);
        const headerValue = String(value);
        if (!tokenPattern.test(headerName)) {
          throw new SyntaxError(`Header '${headerName}' has invalid name`);
        }
        if (/[\r\n\0]/.test(headerValue)) {
          throw new SyntaxError(`Header '${headerName}' has invalid value`);
        }
        this._customHeaders.push([headerName, headerValue]);
      }
    }
    this._protocols = Array.isArray(protocols) ? protocols.map(String) : protocols == null ? [] : [String(protocols)];
    this._tlsOptions = options?.tls != null && typeof options.tls === "object" ? options.tls : null;
    this._deflateOffered = !(options != null && "perMessageDeflate" in options && !options.perMessageDeflate);
    this._proxy = normalizeWebSocketProxyOption(options?.proxy);
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
    // EventEmitter throws for unhandled "error" events; WebSocket error
    // events are droppable notifications, so only emit when listened for.
    if (event.type === "error" && this.listenerCount("error") === 0) return true;
    this.emit(event.type, event);
    return true;
  }

  _customHeader(name) {
    const wanted = String(name).toLowerCase();
    for (const [headerName, headerValue] of this._customHeaders) {
      if (headerName.toLowerCase() === wanted) return headerValue;
    }
    return null;
  }

  _connect(parsed) {
    const secure = parsed.protocol === "wss:";
    const explicitPort = parsed.port ?? String(parsed.href).match(/^wss?:\/\/[^/:]+:(\d+)/)?.[1];
    const port = Number(explicitPort || (secure ? 443 : 80));
    const host = parsed.hostname || "localhost";

    const customKey = this._customHeader("sec-websocket-key");
    this._key = customKey != null && WEBSOCKET_KEY_PATTERN.test(customKey)
      ? customKey
      : randomBytes(16).toString("base64");

    this._target = { parsed, secure, host, port, explicitPort };

    const tlsOptions = this._tlsOptions ?? {};
    const proxy = this._proxy != null && !websocketNoProxyMatches(host, port) ? this._proxy : null;

    if (!proxy) {
      let socket;
      try {
        socket = secure
          ? tlsConnect({
              host,
              port,
              servername: websocketTlsServername(host),
              rejectUnauthorized: tlsOptions.rejectUnauthorized !== false,
              ca: tlsOptions.ca,
            })
          : netConnect(port, host);
      } catch (error) {
        queueMicrotask(() => this._fail(error));
        return;
      }
      this._socket = socket;
      const readyEvent = secure ? "secureConnect" : "connect";
      socket.on(readyEvent, () => this._startHandshake(socket));
      this._attachTransportGuards(socket);
      return;
    }

    this._connectViaProxy(proxy, tlsOptions);
  }

  _attachTransportGuards(socket) {
    socket.on("error", (error) => this._fail(error));
    socket.on("close", () => {
      if (this.readyState !== WebSocket.CLOSED) {
        if (this.readyState === WebSocket.CONNECTING) this._fail(new Error("Connection closed before handshake completed"));
        else this._close(1006, "", false);
      }
    });
  }

  _connectViaProxy(proxy, tlsOptions) {
    const { secure, host, port } = this._target;
    const proxyUrl = proxy.url;
    const proxySecure = proxyUrl.protocol === "https:";
    const proxyPort = Number(proxyUrl.port || (proxySecure ? 443 : 80));
    const proxyHost = proxyUrl.hostname || "localhost";

    let socket;
    try {
      socket = proxySecure
        ? tlsConnect({
            host: proxyHost,
            port: proxyPort,
            servername: websocketTlsServername(proxyHost),
            rejectUnauthorized: tlsOptions.rejectUnauthorized !== false,
            ca: tlsOptions.ca,
          })
        : netConnect(proxyPort, proxyHost);
    } catch (error) {
      queueMicrotask(() => this._fail(error));
      return;
    }
    this._socket = socket;

    let connectBuffer = Buffer.alloc(0);
    let established = false;
    const onData = (chunk) => {
      if (established) return;
      connectBuffer = Buffer.concat([connectBuffer, Buffer.from(chunk)]);
      const text = connectBuffer.toString("latin1");
      const headerEnd = text.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      established = true;
      socket.off("data", onData);
      const statusLine = text.slice(0, text.indexOf("\r\n"));
      const status = Number(statusLine.split(/\s+/)[1]);
      if (status < 200 || status >= 300) {
        this._fail(new Error(`Proxy CONNECT failed with status ${status}`));
        try { socket.destroy(); } catch {}
        return;
      }
      if (this._aborted || this.readyState !== WebSocket.CONNECTING) {
        try { socket.destroy(); } catch {}
        return;
      }
      const leftover = connectBuffer.subarray(headerEnd + 4);
      if (!secure) {
        this._startHandshake(socket);
        if (leftover.byteLength > 0) this._handleData(Buffer.from(leftover));
        return;
      }
      // wss:// target: negotiate TLS inside the tunnel.
      websocketTlsOverStream(
        socket,
        {
          servername: websocketTlsServername(host),
          rejectUnauthorized: tlsOptions.rejectUnauthorized !== false,
          ca: tlsOptions.ca,
        },
        (tlsSocket) => {
          this._socket = tlsSocket;
          tlsSocket.on("secureConnect", () => this._startHandshake(tlsSocket));
          this._attachTransportGuards(tlsSocket);
        },
        (error) => this._fail(error),
      );
    };
    socket.on("data", onData);
    socket.on("error", (error) => {
      if (this.readyState !== WebSocket.CLOSED && this._socket === socket) this._fail(error);
    });
    socket.on("close", () => {
      if (this._socket === socket && this.readyState === WebSocket.CONNECTING) {
        this._fail(new Error("Proxy connection closed"));
      }
    });

    const sendConnect = () => {
      const lines = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Proxy-Connection: keep-alive",
      ];
      const decode = (part) => { try { return decodeURIComponent(part); } catch { return part; } };
      if (proxyUrl.username !== "" || proxyUrl.password !== "") {
        const credentials = `${decode(proxyUrl.username)}:${decode(proxyUrl.password)}`;
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString("base64")}`);
      }
      for (const [name, value] of proxy.headers) lines.push(`${name}: ${value}`);
      lines.push("", "");
      socket.write(lines.join("\r\n"));
    };
    socket.on(proxySecure ? "secureConnect" : "connect", sendConnect);
  }

  _startHandshake(socket) {
    if (this._aborted || this.readyState !== WebSocket.CONNECTING) {
      try { socket.destroy(); } catch {}
      return;
    }
    this._socket = socket;
    socket.on("data", (chunk) => this._handleData(Buffer.from(chunk)));
    if (!socket.listenerCount || socket.listenerCount("error") === 0) {
      socket.on("error", (error) => this._fail(error));
    }
    socket.on("close", () => {
      if (this._socket !== socket) return;
      if (this.readyState === WebSocket.CONNECTING) this._fail(new Error("Connection closed before handshake completed"));
      else if (this.readyState !== WebSocket.CLOSED) this._close(1006, "", false);
    });

    const { parsed, host, explicitPort } = this._target;
    const path = `${parsed.pathname || "/"}${parsed.search || ""}`;
    const hostHeader = this._customHeader("host") ?? `${host}${explicitPort ? `:${explicitPort}` : ""}`;
    const customProtocolHeader = this._customHeader("sec-websocket-protocol");
    const protocolHeader = customProtocolHeader ?? (this._protocols.length > 0 ? this._protocols.join(", ") : null);
    this._offeredProtocols = customProtocolHeader != null
      ? customProtocolHeader.split(",").map((token) => token.trim()).filter((token) => token.length > 0)
      : this._protocols;
    const customExtensionsHeader = this._customHeader("sec-websocket-extensions");
    const extensionsHeader = customExtensionsHeader ??
      (this._deflateOffered
        ? "permessage-deflate; client_no_context_takeover; server_no_context_takeover; client_max_window_bits"
        : null);

    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${hostHeader}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${this._key}`,
      "Sec-WebSocket-Version: 13",
    ];
    if (protocolHeader != null && protocolHeader.length > 0) lines.push(`Sec-WebSocket-Protocol: ${protocolHeader}`);
    if (extensionsHeader != null) lines.push(`Sec-WebSocket-Extensions: ${extensionsHeader}`);
    const managed = new Set([
      "host", "upgrade", "connection", "sec-websocket-key", "sec-websocket-version",
      "sec-websocket-protocol", "sec-websocket-extensions",
    ]);
    for (const [name, value] of this._customHeaders) {
      if (managed.has(name.toLowerCase())) continue;
      lines.push(`${name}: ${value}`);
    }
    // URL-embedded credentials become a Basic Authorization header unless
    // the caller supplied an explicit Authorization header (Bun semantics).
    const hasAuthHeader = this._customHeaders.some(([name]) => name.toLowerCase() === "authorization");
    if (!hasAuthHeader && (parsed.username !== "" || parsed.password !== "")) {
      const decode = (part) => { try { return decodeURIComponent(part); } catch { return part; } };
      const credentials = `${decode(parsed.username)}:${decode(parsed.password)}`;
      lines.push(`Authorization: Basic ${Buffer.from(credentials).toString("base64")}`);
    }
    lines.push("", "");
    socket.write(lines.join("\r\n"));
  }

  _handleData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    if (this.readyState === WebSocket.CONNECTING) {
      const text = this._buffer.toString("latin1");
      const headerEnd = text.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = text.slice(0, headerEnd);
      const [statusLine, ...headerLines] = headerText.split("\r\n");
      const status = Number(statusLine.split(/\s+/)[1]);
      let parsedHeaders;
      try {
        parsedHeaders = parseHeaderLines(headerLines.join("\r\n"));
      } catch (error) {
        this._fail(error);
        return;
      }
      const headers = parsedHeaders.headers;
      if (status !== 101) {
        this._failWithClose(new Error("Expected 101 status code"), 1002, "Expected 101 status code");
        return;
      }
      const upgradeHeader = headers.upgrade;
      if (upgradeHeader == null) {
        this._failWithClose(new Error("Missing upgrade header"), 1002, "Missing upgrade header");
        return;
      }
      if (String(upgradeHeader).toLowerCase() !== "websocket") {
        this._failWithClose(new Error("Invalid upgrade header"), 1002, "Invalid upgrade header");
        return;
      }
      const connectionHeader = headers.connection;
      if (connectionHeader == null) {
        this._failWithClose(new Error("Missing connection header"), 1002, "Missing connection header");
        return;
      }
      const connectionTokens = String(connectionHeader).split(",").map((token) => token.trim().toLowerCase());
      if (!connectionTokens.includes("upgrade")) {
        this._failWithClose(new Error("Invalid connection header"), 1002, "Invalid connection header");
        return;
      }
      const acceptHeader = headers["sec-websocket-accept"];
      if (acceptHeader == null) {
        this._failWithClose(
          new Error("Missing websocket accept header"),
          1002,
          "Missing websocket accept header",
        );
        return;
      }
      if (String(acceptHeader) !== websocketAcceptKey(this._key)) {
        this._failWithClose(
          new Error("Mismatch websocket accept header"),
          1002,
          "Mismatch websocket accept header",
        );
        return;
      }

      // RFC 6455 4.1: the server may select at most one of the offered
      // subprotocols; anything else is a handshake failure.
      let protocolHeaderCount = 0;
      for (let index = 0; index + 1 < parsedHeaders.rawHeaders.length; index += 2) {
        if (parsedHeaders.rawHeaders[index].toLowerCase() === "sec-websocket-protocol") protocolHeaderCount += 1;
      }
      let selectedProtocol = "";
      if (protocolHeaderCount > 0) {
        const value = protocolHeaderCount === 1 ? String(headers["sec-websocket-protocol"] ?? "").trim() : null;
        const offered = this._offeredProtocols ?? this._protocols;
        const valid = value != null && value.length > 0 && !value.includes(",") &&
          tokenPattern.test(value) && offered.includes(value);
        if (!valid) {
          this._abortHandshake(1002, "Mismatch client protocol");
          return;
        }
        selectedProtocol = value;
      }
      this.protocol = selectedProtocol;

      // RFC 7692 extension negotiation.
      this._deflate = null;
      const extensionsValue = headers["sec-websocket-extensions"];
      if (extensionsValue != null && String(extensionsValue).trim() !== "") {
        this.extensions = String(extensionsValue);
        const extensions = parseWebSocketExtensions(extensionsValue);
        const pmd = extensions.find((extension) => extension.name === "permessage-deflate");
        if (pmd != null) {
          let clientWindowBits = 15;
          const rawBits = pmd.params["client_max_window_bits"];
          if (rawBits != null && rawBits !== true) {
            const bits = Number(rawBits);
            if (Number.isInteger(bits) && bits >= 8 && bits <= 15) clientWindowBits = bits;
          }
          this._deflate = { clientWindowBits };
        }
      } else {
        this.extensions = "";
      }

      this.readyState = WebSocket.OPEN;
      this._buffer = this._buffer.subarray(headerEnd + 4);
      this.dispatchEvent({ type: "open", target: this });
    }

    if (this.readyState === WebSocket.CLOSED) return;
    let parsed;
    try {
      parsed = parseWebSocketFrames(this._buffer);
    } catch (error) {
      this._fail(error);
      return;
    }
    this._buffer = parsed.remaining;
    for (const frame of parsed.frames) {
      if (this.readyState === WebSocket.CLOSED) return;
      this._handleFrame(frame);
    }
  }

  _protocolError(reason = "Protocol error") {
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(1002, 0);
    payload.set(Buffer.from(reason), 2);
    this._flushWriteFrames();
    try { this._socket?.write?.(websocketFrame(0x8, payload)); } catch {}
    this._close(1002, reason, false);
  }

  _abortHandshake(code, reason) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    try { this._socket?.destroy?.(); } catch {}
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: false }));
  }

  _handleFrame(frame) {
    if (frame.opcode >= 0x8) {
      if (!frame.fin || frame.payload.byteLength > 125 || frame.rsv1 || frame.rsv2 || frame.rsv3) {
        this._protocolError("Invalid control frame");
        return;
      }
      if (frame.opcode === 0x8) {
        const code = frame.payload.byteLength >= 2 ? readUInt16BE(frame.payload, 0) : 1000;
        const reason = frame.payload.byteLength > 2 ? frame.payload.subarray(2).toString("utf8") : "";
        if (this.readyState === WebSocket.OPEN) {
          this._flushWriteFrames();
          this._socket?.write?.(websocketFrame(0x8, frame.payload));
        }
        this._close(code, reason, true);
        return;
      }
      if (frame.opcode === 0x9) {
        if (this.readyState === WebSocket.OPEN) {
          this._flushWriteFrames();
          this._socket?.write?.(websocketFrame(0xA, frame.payload));
        }
        const data = this.binaryType === "arraybuffer"
          ? frame.payload.buffer.slice(frame.payload.byteOffset, frame.payload.byteOffset + frame.payload.byteLength)
          : frame.payload;
        this.dispatchEvent(new MessageEvent("ping", { data, origin: this.url, source: this }));
        return;
      }
      if (frame.opcode === 0xA) {
        const data = this.binaryType === "arraybuffer"
          ? frame.payload.buffer.slice(frame.payload.byteOffset, frame.payload.byteOffset + frame.payload.byteLength)
          : frame.payload;
        this.dispatchEvent(new MessageEvent("pong", { data, origin: this.url, source: this }));
        return;
      }
      return;
    }

    if (frame.rsv2 || frame.rsv3) {
      this._protocolError("Invalid RSV bits");
      return;
    }
    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      if (frame.rsv1 && this._deflate == null) {
        this._protocolError("Unexpected compressed frame");
        return;
      }
      this._fragmentOpcode = frame.opcode;
      this._fragments = [frame.payload];
      this._messageCompressed = frame.rsv1 === true;
    } else if (frame.opcode === 0x0 && this._fragmentOpcode) {
      if (frame.rsv1) {
        this._protocolError("Invalid RSV bits");
        return;
      }
      this._fragments.push(frame.payload);
    } else {
      return;
    }
    if (!frame.fin) return;

    let payload = Buffer.concat(this._fragments);
    const opcode = this._fragmentOpcode;
    const compressed = this._messageCompressed;
    this._fragments = [];
    this._fragmentOpcode = 0;
    this._messageCompressed = false;
    if (compressed) {
      try {
        payload = websocketDeflateDecompress(payload);
      } catch (error) {
        if (error?.code === "WS_MESSAGE_TOO_BIG") {
          const reason = "Message too big";
          this._close(1009, reason, false);
        } else {
          this._protocolError("Invalid compressed data");
        }
        return;
      }
    }
    this._deliverMessage(opcode, payload);
  }

  _deliverMessage(opcode, payload) {
    const data = opcode === 0x1
      ? payload.toString("utf8")
      : this.binaryType === "arraybuffer"
        ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
        : payload;
    this.dispatchEvent(new MessageEvent("message", { data, origin: this.url, source: this }));
  }

  _fail(error) {
    if (this.readyState === WebSocket.CLOSED) return;
    if (this.readyState === WebSocket.CONNECTING && isWebSocketTlsHandshakeError(error)) {
      this._failWithClose(error, 1015, "TLS handshake failed");
      return;
    }
    this._failWithClose(error, 1006, "");
  }

  _failWithClose(error, code, reason, wasClean = false) {
    if (this.readyState === WebSocket.CLOSED) return;
    const connectFailure = this.readyState === WebSocket.CONNECTING;
    const cause = error?.message ?? String(error);
    const message = connectFailure
      ? `WebSocket connection to '${this.url}' failed: Failed to connect`
      : `WebSocket connection to '${this.url}' failed: ${cause}`;
    const failure = new Error(message);
    const event = typeof globalThis.ErrorEvent === "function"
      ? new globalThis.ErrorEvent("error", { message, error: failure })
      : { type: "error", message, error: failure, target: this };
    this.dispatchEvent(event);
    this._close(code, reason, wasClean);
  }

  _close(code = 1000, reason = "", wasClean = true) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    if (this._closeTimer != null) clearTimeout(this._closeTimer);
    this._closeTimer = null;
    try { this._socket?.destroy?.(); } catch {}
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
  }

  _queueWriteFrame(frame) {
    this._pendingWriteFrames.push(frame);
    this._pendingWriteBytes += frame.byteLength;
    this.bufferedAmount += frame.byteLength;
    if (!this._writeFlushScheduled) {
      this._writeFlushScheduled = true;
      queueMicrotask(() => this._flushWriteFrames());
    }
    const socket = this._socket;
    return Boolean(socket && !socket.destroyed &&
      socket.writableLength + this._pendingWriteBytes < socket.writableHighWaterMark);
  }

  _flushWriteFrames() {
    this._writeFlushScheduled = false;
    if (this._pendingWriteFrames.length === 0) return;
    const frames = this._pendingWriteFrames;
    const byteLength = this._pendingWriteBytes;
    this._pendingWriteFrames = [];
    this._pendingWriteBytes = 0;
    const socket = this._socket;
    if (!socket || socket.destroyed || !socket.writable) {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLength);
      return;
    }
    const output = frames.length === 1 ? frames[0] : Buffer.concat(frames, byteLength);
    socket.write(output, () => {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLength);
    });
  }

  send(data) {
    if (this.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
    const opcode = typeof data === "string" ? 0x1 : 0x2;
    let payload = data;
    let rsv1 = false;
    if (this._deflate != null) {
      const bytes = Buffer.from(bytesFromBody(data));
      if (bytes.byteLength >= WEBSOCKET_COMPRESS_THRESHOLD) {
        payload = websocketDeflateCompress(bytes, this._deflate.clientWindowBits);
        rsv1 = true;
      } else {
        payload = bytes;
      }
    }
    const frame = websocketFrame(opcode, payload, true, rsv1);
    return this._queueWriteFrame(frame);
  }

  ping(data = undefined) {
    if (this.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
    let payload = data == null ? Buffer.alloc(0) : Buffer.from(bytesFromBody(data));
    if (payload.byteLength > 125) payload = payload.subarray(0, 125);
    return this._queueWriteFrame(websocketFrame(0x9, payload));
  }

  pong(data = undefined) {
    if (this.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
    let payload = data == null ? Buffer.alloc(0) : Buffer.from(bytesFromBody(data));
    if (payload.byteLength > 125) payload = payload.subarray(0, 125);
    return this._queueWriteFrame(websocketFrame(0xA, payload));
  }

  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    this._aborted = true;
    this._close(1006, "", false);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === WebSocket.CLOSED || this.readyState === WebSocket.CLOSING) return;
    if (this.readyState === WebSocket.CONNECTING) {
      this._aborted = true;
      this._abortHandshake(1006, "");
      return;
    }
    this.readyState = WebSocket.CLOSING;
    const payload = Buffer.alloc(2 + Buffer.byteLength(String(reason)));
    const closeCode = Number(code) || 1000;
    payload[0] = (closeCode >> 8) & 0xff;
    payload[1] = closeCode & 0xff;
    payload.set(Buffer.from(String(reason)), 2);
    this._flushWriteFrames();
    this._socket?.write?.(websocketFrame(0x8, payload));
    this._closeTimer = setTimeout(() => this._close(1006, "", false), 30_000);
    this._closeTimer?.unref?.();
  }
};

// Bun exposes the WebSocket client as a global.
globalThis.WebSocket ??= WebSocket;

const httpDefault = {
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
  request,
  setMaxIdleHTTPParsers,
  validateHeaderName,
  validateHeaderValue,
};

Object.defineProperty(httpDefault, "maxHeaderSize", {
  enumerable: true,
  configurable: true,
  get: () => getCurrentMaxHeaderSize(),
  set: (value) => { setCurrentMaxHeaderSize(value); },
});

export default httpDefault;
