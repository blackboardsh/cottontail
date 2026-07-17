import { Buffer } from "./buffer.js";
import { EventEmitter } from "./events.js";
import { IncomingMessage, ServerResponse } from "./http.js";
import { connect as netConnect, createServer as createNetServer, isIP } from "./net.js";
import { Duplex } from "./stream.js";
import { _upgradeServerSocket, connect as tlsConnect, createServer as createTlsServer } from "./tls.js";
import * as fs from "./fs.js";

let statusMessageWarned = false;
let connectionHeaderWarned = false;

function warnStatusMessage() {
  if (statusMessageWarned) return;
  statusMessageWarned = true;
  globalThis.process?.emitWarning?.(
    "Status message is not supported by HTTP/2",
    "UnsupportedWarning",
  );
}

function warnConnectionHeader() {
  if (connectionHeaderWarned) return;
  connectionHeaderWarned = true;
  globalThis.process?.emitWarning?.(
    "The provided connection header is not valid, the value will be dropped from the header and will never be in use.",
    "UnsupportedWarning",
  );
}

const compatSocketCache = new WeakMap();

function compatSocketForStream(stream) {
  const cached = compatSocketCache.get(stream);
  if (cached) return cached;
  const prohibited = new Set(["write", "read", "pause", "resume"]);
  const streamMethods = new Set(["on", "once", "end", "emit", "destroy"]);
  const proxy = new Proxy(stream, {
    has(target, property) {
      const socket = target.session?._socket;
      return property in target || (socket != null && property in socket);
    },
    get(target, property) {
      if (prohibited.has(property)) {
        throw codedError("ERR_HTTP2_NO_SOCKET_MANIPULATION", "HTTP/2 sockets should not be directly manipulated");
      }
      if (streamMethods.has(property)) return target[property].bind(target);
      if (property === "setTimeout") return target.setTimeout.bind(target);
      if (property === "writable" || property === "destroyed" || property === "readable") return target[property];
      const socket = target.session?._socket;
      const value = socket?.[property];
      return typeof value === "function" ? value.bind(socket) : value;
    },
    set(target, property, value) {
      if (prohibited.has(property)) {
        throw codedError("ERR_HTTP2_NO_SOCKET_MANIPULATION", "HTTP/2 sockets should not be directly manipulated");
      }
      if (streamMethods.has(property) || property === "setTimeout" || property === "writable" ||
          property === "destroyed" || property === "readable") {
        target[property] = value;
        return true;
      }
      const socket = target.session?._socket;
      if (socket) socket[property] = value;
      else target[property] = value;
      return true;
    },
    getPrototypeOf(target) {
      return Reflect.getPrototypeOf(target.session?._socket ?? target);
    },
  });
  compatSocketCache.set(stream, proxy);
  return proxy;
}

export class Http2ServerRequest extends IncomingMessage {
  constructor(stream, headers, options = undefined, rawHeaders = undefined) {
    if (Array.isArray(options) && rawHeaders === undefined) {
      rawHeaders = options;
      options = undefined;
    }
    rawHeaders ??= [];
    super({
      ...(options ?? {}),
      deferBody: true,
      headers,
      rawHeaders,
      httpVersion: "2.0",
      method: headers[":method"],
      url: headers[":path"],
      socket: compatSocketForStream(stream),
    });
    this.stream = stream;
    this.authority = headers[":authority"] ?? headers.host;
    this.scheme = headers[":scheme"];
    stream.on("data", chunk => this._pushIncomingChunk(chunk));
    stream.on("trailers", (trailers, _flags, rawTrailers) => {
      this.trailers = trailers;
      this.rawTrailers = rawTrailers ?? Object.entries(trailers).flat();
    });
    stream.on("end", () => this._completeIncoming());
    stream.on("aborted", () => this._abortIncoming());
    stream.on("timeout", () => this.emit("timeout"));
    stream.on("close", () => {
      if (!this.complete && !this.aborted) this._completeIncoming(this.trailers, this.rawTrailers);
      this.emit("close");
    });
    stream.on("error", error => {
      if (this.listenerCount("error") > 0) this.emit("error", error);
    });
  }

  setTimeout(msecs, callback = undefined) {
    this.stream?.setTimeout(msecs, callback);
    return this;
  }
}

export class Http2ServerResponse extends ServerResponse {
  constructor(stream, request) {
    super(request);
    this.stream = stream;
    this.socket = compatSocketForStream(stream);
    this.connection = this.socket;
    this._trailerHeaders = {};
    this._closed = false;
    stream.on("drain", () => this.emit("drain"));
    stream.on("timeout", () => this.emit("timeout"));
    stream.on("aborted", () => this.emit("aborted"));
    stream.on("wantTrailers", () => {
      if (!stream.sentTrailers && !stream.closed) stream.sendTrailers(this._trailerHeaders);
    });
    stream.on("finish", () => {
      if (!this._finishEmitted) {
        this._finishEmitted = true;
        this.emit("finish");
      }
    });
    stream.on("close", () => {
      this._closed = true;
      this.socket = undefined;
      this.connection = undefined;
      if (!this._closeEmitted) {
        this._closeEmitted = true;
        this.emit("close");
      }
    });
  }

  get _header() { return this.headersSent; }

  get statusCode() { return this._statusCode ?? 200; }
  set statusCode(value) {
    const status = Number(value);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw codedError("ERR_HTTP2_STATUS_INVALID", `Invalid status code: ${String(value)}`, RangeError);
    }
    if (status >= 100 && status < 200) {
      throw codedError("ERR_HTTP2_INFO_STATUS_NOT_ALLOWED", `Informational status code ${status} is not allowed here`);
    }
    this._statusCode = status;
  }

  get statusMessage() {
    warnStatusMessage();
    return "";
  }
  set statusMessage(value) {
    if (value === undefined || this._suppressStatusMessageWarning) return;
    warnStatusMessage();
  }

  _sendHead() {
    if (this.headersSent) return;
    const headers = { ":status": this.statusCode, ...this.getHeaders() };
    this.stream.respond(headers, { waitForTrailers: true, sendDate: this.sendDate });
    this.headersSent = true;
  }

  setHeader(name, value) {
    if (String(name).toLowerCase() === "connection") {
      warnConnectionHeader();
      return this;
    }
    return super.setHeader(name, value);
  }

  appendHeader(name, value) {
    if (String(name).toLowerCase() === "connection") {
      warnConnectionHeader();
      return this;
    }
    return super.appendHeader(name, value);
  }

  writeHead(statusCode, statusMessage = undefined, headers = undefined) {
    if (typeof statusMessage === "object" && statusMessage !== null) {
      headers = statusMessage;
      statusMessage = undefined;
    }
    this.statusCode = statusCode;
    if (headers) {
      if (Array.isArray(headers)) {
        const tuples = headers.length > 0 && Array.isArray(headers[0]);
        if (!tuples && headers.length % 2 !== 0) {
          throw codedError("ERR_INVALID_ARG_VALUE", "The headers array must contain name/value pairs", TypeError);
        }
        if (tuples) {
          for (const [name, value] of headers) this.appendHeader(name, value);
        } else {
          for (let index = 0; index < headers.length; index += 2) this.appendHeader(headers[index], headers[index + 1]);
        }
      } else {
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      }
    }
    this._sendHead();
    return this;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this.writableEnded) {
      const error = codedError("ERR_STREAM_WRITE_AFTER_END", "write after end");
      if (callback) queueMicrotask(() => callback(error));
      else this.destroy(error);
      return false;
    }
    this._sendHead();
    if (payloadForbidden(this.statusCode, this.req?.method === "HEAD")) {
      if (callback) queueMicrotask(callback);
      return true;
    }
    return this.stream.write(chunk, encoding, callback);
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
    if (chunk !== undefined && chunk !== null && !payloadForbidden(this.statusCode, this.req?.method === "HEAD")) {
      this.write(chunk, encoding);
    } else {
      this._sendHead();
    }
    this.writableEnded = true;
    this.finished = true;
    if (typeof callback === "function") this.once("finish", callback);
    this.stream.end();
    return this;
  }

  destroy(error = undefined) {
    this.stream.destroy(error);
    this.writableEnded = true;
    this.finished = true;
    return this;
  }

  setTrailer(name, value) {
    const normalized = normalizeHeaders({ [name]: value }, { allowPseudo: false, trailers: true });
    Object.assign(this._trailerHeaders, normalized);
  }

  addTrailers(headers = {}) {
    Object.assign(this._trailerHeaders, normalizeHeaders(headers, { allowPseudo: false, trailers: true }));
  }

  flushHeaders() {
    if (!this._closed) this._sendHead();
  }

  cork() { this.stream.cork(); }
  uncork() { this.stream.uncork(); }

  setTimeout(msecs, callback = undefined) {
    this.stream?.setTimeout(msecs, callback);
    return this;
  }

  createPushResponse(headers, callback) {
    if (typeof callback !== "function") {
      throw codedError("ERR_INVALID_ARG_TYPE", "The callback argument must be a function", TypeError);
    }
    if (this._closed) {
      queueMicrotask(() => callback(codedError("ERR_HTTP2_INVALID_STREAM", "The HTTP/2 stream has been destroyed")));
      return;
    }
    this.stream.pushStream(headers, {}, (error, pushStream) => {
      callback(error, error ? undefined : new Http2ServerResponse(pushStream, undefined));
    });
  }

  writeContinue(callback = undefined) {
    if (this.headersSent || this._closed) return false;
    this.stream.additionalHeaders({ ":status": 100 });
    if (typeof callback === "function") queueMicrotask(callback);
    return true;
  }

  writeEarlyHints(hints, callback = undefined) {
    validateObject(hints, "hints");
    const link = hints.link;
    if (link === undefined || link === null) return false;
    const values = Array.isArray(link) ? link : [link];
    if (values.some(value => typeof value !== "string")) {
      throw codedError("ERR_INVALID_ARG_VALUE", "The hints.link value must be a string or string array", TypeError);
    }
    if (this.headersSent || this._closed || values.length === 0) return false;
    const headers = { ...hints, link: values.join(", "), ":status": 103 };
    this.stream.additionalHeaders(headers);
    if (typeof callback === "function") queueMicrotask(callback);
    return true;
  }
}

export const sensitiveHeaders = Symbol.for("nodejs.http2.sensitiveHeaders");

export const constants = {
  NGHTTP2_ERR_FRAME_SIZE_ERROR: -522,
  NGHTTP2_SESSION_SERVER: 0,
  NGHTTP2_SESSION_CLIENT: 1,
  NGHTTP2_STREAM_STATE_IDLE: 1,
  NGHTTP2_STREAM_STATE_OPEN: 2,
  NGHTTP2_STREAM_STATE_RESERVED_LOCAL: 3,
  NGHTTP2_STREAM_STATE_RESERVED_REMOTE: 4,
  NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL: 5,
  NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6,
  NGHTTP2_STREAM_STATE_CLOSED: 7,
  NGHTTP2_NO_ERROR: 0,
  NGHTTP2_PROTOCOL_ERROR: 1,
  NGHTTP2_INTERNAL_ERROR: 2,
  NGHTTP2_FLOW_CONTROL_ERROR: 3,
  NGHTTP2_SETTINGS_TIMEOUT: 4,
  NGHTTP2_STREAM_CLOSED: 5,
  NGHTTP2_FRAME_SIZE_ERROR: 6,
  NGHTTP2_REFUSED_STREAM: 7,
  NGHTTP2_CANCEL: 8,
  NGHTTP2_COMPRESSION_ERROR: 9,
  NGHTTP2_CONNECT_ERROR: 10,
  NGHTTP2_ENHANCE_YOUR_CALM: 11,
  NGHTTP2_INADEQUATE_SECURITY: 12,
  NGHTTP2_HTTP_1_1_REQUIRED: 13,
  NGHTTP2_DEFAULT_WEIGHT: 16,
  NGHTTP2_FLAG_NONE: 0,
  NGHTTP2_FLAG_END_STREAM: 1,
  NGHTTP2_FLAG_END_HEADERS: 4,
  NGHTTP2_FLAG_ACK: 1,
  NGHTTP2_FLAG_PADDED: 8,
  NGHTTP2_FLAG_PRIORITY: 32,
  NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1,
  NGHTTP2_SETTINGS_ENABLE_PUSH: 2,
  NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3,
  NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4,
  NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5,
  NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6,
  NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL: 8,
  DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096,
  DEFAULT_SETTINGS_ENABLE_PUSH: 1,
  DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS: 0xffffffff,
  DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE: 65535,
  DEFAULT_SETTINGS_MAX_FRAME_SIZE: 16384,
  DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE: 65535,
  DEFAULT_SETTINGS_ENABLE_CONNECT_PROTOCOL: 0,
  MAX_MAX_FRAME_SIZE: 0xffffff,
  MIN_MAX_FRAME_SIZE: 16384,
  MAX_INITIAL_WINDOW_SIZE: 0x7fffffff,
  PADDING_STRATEGY_NONE: 0,
  PADDING_STRATEGY_ALIGNED: 1,
  PADDING_STRATEGY_MAX: 2,
  PADDING_STRATEGY_CALLBACK: 1,
};

const headerConstantNames = [
  "ACCEPT", "ACCEPT_CHARSET", "ACCEPT_ENCODING", "ACCEPT_LANGUAGE", "ACCEPT_RANGES",
  "ACCESS_CONTROL_ALLOW_CREDENTIALS", "ACCESS_CONTROL_ALLOW_HEADERS", "ACCESS_CONTROL_ALLOW_METHODS",
  "ACCESS_CONTROL_ALLOW_ORIGIN", "ACCESS_CONTROL_EXPOSE_HEADERS", "ACCESS_CONTROL_MAX_AGE",
  "ACCESS_CONTROL_REQUEST_HEADERS", "ACCESS_CONTROL_REQUEST_METHOD", "AGE", "ALLOW", "ALT_SVC",
  "AUTHORIZATION", "CACHE_CONTROL", "CONNECTION", "CONTENT_DISPOSITION", "CONTENT_ENCODING",
  "CONTENT_LANGUAGE", "CONTENT_LENGTH", "CONTENT_LOCATION", "CONTENT_MD5", "CONTENT_RANGE",
  "CONTENT_SECURITY_POLICY", "CONTENT_TYPE", "COOKIE", "DATE", "DNT", "EARLY_DATA", "ETAG",
  "EXPECT", "EXPECT_CT", "EXPIRES", "FORWARDED", "FROM", "HOST", "HTTP2_SETTINGS", "IF_MATCH",
  "IF_MODIFIED_SINCE", "IF_NONE_MATCH", "IF_RANGE", "IF_UNMODIFIED_SINCE", "KEEP_ALIVE",
  "LAST_MODIFIED", "LINK", "LOCATION", "MAX_FORWARDS", "ORIGIN", "PREFER", "PRIORITY",
  "PROXY_AUTHENTICATE", "PROXY_AUTHORIZATION", "PROXY_CONNECTION", "PURPOSE", "RANGE", "REFERER",
  "REFRESH", "RETRY_AFTER", "SERVER", "SET_COOKIE", "STRICT_TRANSPORT_SECURITY", "TE",
  "TIMING_ALLOW_ORIGIN", "TK", "TRAILER", "TRANSFER_ENCODING", "UPGRADE",
  "UPGRADE_INSECURE_REQUESTS", "USER_AGENT", "VARY", "VIA", "WARNING", "WWW_AUTHENTICATE",
  "X_CONTENT_TYPE_OPTIONS", "X_FORWARDED_FOR", "X_FRAME_OPTIONS", "X_XSS_PROTECTION",
];

Object.assign(constants, {
  HTTP2_HEADER_STATUS: ":status",
  HTTP2_HEADER_METHOD: ":method",
  HTTP2_HEADER_AUTHORITY: ":authority",
  HTTP2_HEADER_SCHEME: ":scheme",
  HTTP2_HEADER_PATH: ":path",
  HTTP2_HEADER_PROTOCOL: ":protocol",
});
for (const name of headerConstantNames) {
  constants[`HTTP2_HEADER_${name}`] = name.toLowerCase().replaceAll("_", "-");
}

const methodConstantNames = [
  "ACL", "BASELINE_CONTROL", "BIND", "CHECKIN", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET",
  "HEAD", "LABEL", "LINK", "LOCK", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MKREDIRECTREF",
  "MKWORKSPACE", "MOVE", "OPTIONS", "ORDERPATCH", "PATCH", "POST", "PRI", "PROPFIND", "PROPPATCH",
  "PUT", "REBIND", "REPORT", "SEARCH", "TRACE", "UNBIND", "UNCHECKOUT", "UNLINK", "UNLOCK",
  "UPDATE", "UPDATEREDIRECTREF", "VERSION_CONTROL",
];
for (const name of methodConstantNames) {
  constants[`HTTP2_METHOD_${name}`] = name.replaceAll("_", "-");
}

const statusConstants = {
  CONTINUE: 100, SWITCHING_PROTOCOLS: 101, PROCESSING: 102, EARLY_HINTS: 103,
  OK: 200, CREATED: 201, ACCEPTED: 202, NON_AUTHORITATIVE_INFORMATION: 203, NO_CONTENT: 204,
  RESET_CONTENT: 205, PARTIAL_CONTENT: 206, MULTI_STATUS: 207, ALREADY_REPORTED: 208, IM_USED: 226,
  MULTIPLE_CHOICES: 300, MOVED_PERMANENTLY: 301, FOUND: 302, SEE_OTHER: 303, NOT_MODIFIED: 304,
  USE_PROXY: 305, TEMPORARY_REDIRECT: 307, PERMANENT_REDIRECT: 308,
  BAD_REQUEST: 400, UNAUTHORIZED: 401, PAYMENT_REQUIRED: 402, FORBIDDEN: 403, NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405, NOT_ACCEPTABLE: 406, PROXY_AUTHENTICATION_REQUIRED: 407,
  REQUEST_TIMEOUT: 408, CONFLICT: 409, GONE: 410, LENGTH_REQUIRED: 411, PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413, URI_TOO_LONG: 414, UNSUPPORTED_MEDIA_TYPE: 415, RANGE_NOT_SATISFIABLE: 416,
  EXPECTATION_FAILED: 417, TEAPOT: 418, MISDIRECTED_REQUEST: 421, UNPROCESSABLE_ENTITY: 422,
  LOCKED: 423, FAILED_DEPENDENCY: 424, TOO_EARLY: 425, UPGRADE_REQUIRED: 426,
  PRECONDITION_REQUIRED: 428, TOO_MANY_REQUESTS: 429, REQUEST_HEADER_FIELDS_TOO_LARGE: 431,
  UNAVAILABLE_FOR_LEGAL_REASONS: 451,
  INTERNAL_SERVER_ERROR: 500, NOT_IMPLEMENTED: 501, BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504, HTTP_VERSION_NOT_SUPPORTED: 505, VARIANT_ALSO_NEGOTIATES: 506,
  INSUFFICIENT_STORAGE: 507, LOOP_DETECTED: 508, BANDWIDTH_LIMIT_EXCEEDED: 509, NOT_EXTENDED: 510,
  NETWORK_AUTHENTICATION_REQUIRED: 511,
};
for (const [name, code] of Object.entries(statusConstants)) constants[`HTTP_STATUS_${name}`] = code;

const settingsFields = [
  ["headerTableSize", 1],
  ["enablePush", 2],
  ["maxConcurrentStreams", 3],
  ["initialWindowSize", 4],
  ["maxFrameSize", 5],
  ["maxHeaderListSize", 6],
  ["enableConnectProtocol", 8],
];

const clientPreface = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
const frameTypes = {
  DATA: 0,
  HEADERS: 1,
  PRIORITY: 2,
  RST_STREAM: 3,
  SETTINGS: 4,
  PUSH_PROMISE: 5,
  PING: 6,
  GOAWAY: 7,
  WINDOW_UPDATE: 8,
  CONTINUATION: 9,
  ALTSVC: 10,
  ORIGIN: 12,
};
const flags = { END_STREAM: 0x1, END_HEADERS: 0x4, ACK: 0x1, PADDED: 0x8, PRIORITY: 0x20 };
const DEFAULT_MAX_FRAME_SIZE = 16384;

const hpackStaticTable = [
  [":authority", ""],
  [":method", "GET"],
  [":method", "POST"],
  [":path", "/"],
  [":path", "/index.html"],
  [":scheme", "http"],
  [":scheme", "https"],
  [":status", "200"],
  [":status", "204"],
  [":status", "206"],
  [":status", "304"],
  [":status", "400"],
  [":status", "404"],
  [":status", "500"],
  ["accept-charset", ""],
  ["accept-encoding", "gzip, deflate"],
  ["accept-language", ""],
  ["accept-ranges", ""],
  ["accept", ""],
  ["access-control-allow-origin", ""],
  ["age", ""],
  ["allow", ""],
  ["authorization", ""],
  ["cache-control", ""],
  ["content-disposition", ""],
  ["content-encoding", ""],
  ["content-language", ""],
  ["content-length", ""],
  ["content-location", ""],
  ["content-range", ""],
  ["content-type", ""],
  ["cookie", ""],
  ["date", ""],
  ["etag", ""],
  ["expect", ""],
  ["expires", ""],
  ["from", ""],
  ["host", ""],
  ["if-match", ""],
  ["if-modified-since", ""],
  ["if-none-match", ""],
  ["if-range", ""],
  ["if-unmodified-since", ""],
  ["last-modified", ""],
  ["link", ""],
  ["location", ""],
  ["max-forwards", ""],
  ["proxy-authenticate", ""],
  ["proxy-authorization", ""],
  ["range", ""],
  ["referer", ""],
  ["refresh", ""],
  ["retry-after", ""],
  ["server", ""],
  ["set-cookie", ""],
  ["strict-transport-security", ""],
  ["transfer-encoding", ""],
  ["user-agent", ""],
  ["vary", ""],
  ["via", ""],
  ["www-authenticate", ""]
];

const huffmanCodes = [0x1ff8, 0x7fffd8, 0xfffffe2, 0xfffffe3, 0xfffffe4, 0xfffffe5, 0xfffffe6, 0xfffffe7, 0xfffffe8, 0xffffea, 0x3ffffffc, 0xfffffe9, 0xfffffea, 0x3ffffffd, 0xfffffeb, 0xfffffec, 0xfffffed, 0xfffffee, 0xfffffef, 0xffffff0, 0xffffff1, 0xffffff2, 0x3ffffffe, 0xffffff3, 0xffffff4, 0xffffff5, 0xffffff6, 0xffffff7, 0xffffff8, 0xffffff9, 0xffffffa, 0xffffffb, 0x14, 0x3f8, 0x3f9, 0xffa, 0x1ff9, 0x15, 0xf8, 0x7fa, 0x3fa, 0x3fb, 0xf9, 0x7fb, 0xfa, 0x16, 0x17, 0x18, 0x0, 0x1, 0x2, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x5c, 0xfb, 0x7ffc, 0x20, 0xffb, 0x3fc, 0x1ffa, 0x21, 0x5d, 0x5e, 0x5f, 0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0x70, 0x71, 0x72, 0xfc, 0x73, 0xfd, 0x1ffb, 0x7fff0, 0x1ffc, 0x3ffc, 0x22, 0x7ffd, 0x3, 0x23, 0x4, 0x24, 0x5, 0x25, 0x26, 0x27, 0x6, 0x74, 0x75, 0x28, 0x29, 0x2a, 0x7, 0x2b, 0x76, 0x2c, 0x8, 0x9, 0x2d, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7ffe, 0x7fc, 0x3ffd, 0x1ffd, 0xffffffc, 0xfffe6, 0x3fffd2, 0xfffe7, 0xfffe8, 0x3fffd3, 0x3fffd4, 0x3fffd5, 0x7fffd9, 0x3fffd6, 0x7fffda, 0x7fffdb, 0x7fffdc, 0x7fffdd, 0x7fffde, 0xffffeb, 0x7fffdf, 0xffffec, 0xffffed, 0x3fffd7, 0x7fffe0, 0xffffee, 0x7fffe1, 0x7fffe2, 0x7fffe3, 0x7fffe4, 0x1fffdc, 0x3fffd8, 0x7fffe5, 0x3fffd9, 0x7fffe6, 0x7fffe7, 0xffffef, 0x3fffda, 0x1fffdd, 0xfffe9, 0x3fffdb, 0x3fffdc, 0x7fffe8, 0x7fffe9, 0x1fffde, 0x7fffea, 0x3fffdd, 0x3fffde, 0xfffff0, 0x1fffdf, 0x3fffdf, 0x7fffeb, 0x7fffec, 0x1fffe0, 0x1fffe1, 0x3fffe0, 0x1fffe2, 0x7fffed, 0x3fffe1, 0x7fffee, 0x7fffef, 0xfffea, 0x3fffe2, 0x3fffe3, 0x3fffe4, 0x7ffff0, 0x3fffe5, 0x3fffe6, 0x7ffff1, 0x3ffffe0, 0x3ffffe1, 0xfffeb, 0x7fff1, 0x3fffe7, 0x7ffff2, 0x3fffe8, 0x1ffffec, 0x3ffffe2, 0x3ffffe3, 0x3ffffe4, 0x7ffffde, 0x7ffffdf, 0x3ffffe5, 0xfffff1, 0x1ffffed, 0x7fff2, 0x1fffe3, 0x3ffffe6, 0x7ffffe0, 0x7ffffe1, 0x3ffffe7, 0x7ffffe2, 0xfffff2, 0x1fffe4, 0x1fffe5, 0x3ffffe8, 0x3ffffe9, 0xffffffd, 0x7ffffe3, 0x7ffffe4, 0x7ffffe5, 0xfffec, 0xfffff3, 0xfffed, 0x1fffe6, 0x3fffe9, 0x1fffe7, 0x1fffe8, 0x7ffff3, 0x3fffea, 0x3fffeb, 0x1ffffee, 0x1ffffef, 0xfffff4, 0xfffff5, 0x3ffffea, 0x7ffff4, 0x3ffffeb, 0x7ffffe6, 0x3ffffec, 0x3ffffed, 0x7ffffe7, 0x7ffffe8, 0x7ffffe9, 0x7ffffea, 0x7ffffeb, 0xffffffe, 0x7ffffec, 0x7ffffed, 0x7ffffee, 0x7ffffef, 0x7fffff0, 0x3ffffee, 0x3fffffff];
const huffmanLengths = [13, 23, 28, 28, 28, 28, 28, 28, 28, 24, 30, 28, 28, 30, 28, 28, 28, 28, 28, 28, 28, 28, 30, 28, 28, 28, 28, 28, 28, 28, 28, 28, 6, 10, 10, 12, 13, 6, 8, 11, 10, 10, 8, 11, 8, 6, 6, 6, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 7, 8, 15, 6, 12, 10, 13, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 7, 8, 13, 19, 13, 14, 6, 15, 5, 6, 5, 6, 5, 6, 6, 6, 5, 7, 7, 6, 6, 6, 5, 6, 7, 6, 5, 5, 6, 7, 7, 7, 7, 7, 15, 11, 14, 13, 28, 20, 22, 20, 20, 22, 22, 22, 23, 22, 23, 23, 23, 23, 23, 24, 23, 24, 24, 22, 23, 24, 23, 23, 23, 23, 21, 22, 23, 22, 23, 23, 24, 22, 21, 20, 22, 22, 23, 23, 21, 23, 22, 22, 24, 21, 22, 23, 23, 21, 21, 22, 21, 23, 22, 23, 23, 20, 22, 22, 22, 23, 22, 22, 23, 26, 26, 20, 19, 22, 23, 22, 25, 26, 26, 26, 27, 27, 26, 24, 25, 19, 21, 26, 27, 27, 26, 27, 24, 21, 21, 26, 26, 28, 27, 27, 27, 20, 24, 20, 21, 22, 21, 21, 23, 22, 22, 25, 25, 24, 24, 26, 23, 26, 27, 26, 26, 27, 27, 27, 27, 27, 28, 27, 27, 27, 27, 27, 26, 30];

// ---------------------------------------------------------------------------
// HPACK (RFC 7541): integer/string primitives, Huffman decoding, dynamic table
// ---------------------------------------------------------------------------

const hpackStaticFullIndex = new Map();
const hpackStaticNameIndex = new Map();
for (let i = 0; i < hpackStaticTable.length; i++) {
  const [name, value] = hpackStaticTable[i];
  const fullKey = `${name}\u0000${value}`;
  if (!hpackStaticFullIndex.has(fullKey)) hpackStaticFullIndex.set(fullKey, i + 1);
  if (!hpackStaticNameIndex.has(name)) hpackStaticNameIndex.set(name, i + 1);
}

let huffmanDecodeTree = null;
function getHuffmanTree() {
  if (huffmanDecodeTree) return huffmanDecodeTree;
  const root = [null, null];
  for (let sym = 0; sym <= 256; sym++) {
    const code = huffmanCodes[sym];
    const length = huffmanLengths[sym];
    let node = root;
    for (let bitIndex = length - 1; bitIndex >= 0; bitIndex--) {
      const bit = (code >>> bitIndex) & 1;
      if (bitIndex === 0) {
        node[bit] = sym;
      } else {
        if (node[bit] == null) node[bit] = [null, null];
        node = node[bit];
      }
    }
  }
  huffmanDecodeTree = root;
  return root;
}

function huffmanDecode(bytes) {
  const tree = getHuffmanTree();
  const out = [];
  let node = tree;
  for (let i = 0; i < bytes.byteLength; i++) {
    const byte = bytes[i];
    for (let bitIndex = 7; bitIndex >= 0; bitIndex--) {
      const bit = (byte >>> bitIndex) & 1;
      node = node[bit];
      if (node == null) throw new Error("Invalid HPACK Huffman sequence");
      if (typeof node === "number") {
        if (node === 256) throw new Error("Unexpected HPACK Huffman EOS symbol");
        out.push(node);
        node = tree;
      }
    }
  }
  // Remaining bits are EOS-prefix padding (all ones, at most 7 bits); accept.
  return Buffer.from(out).toString();
}

function hpackEncodeInt(value, prefixBits, firstByte, out) {
  const max = (1 << prefixBits) - 1;
  if (value < max) {
    out.push(firstByte | value);
    return;
  }
  out.push(firstByte | max);
  value -= max;
  while (value >= 128) {
    out.push((value & 127) | 128);
    value = Math.floor(value / 128);
  }
  out.push(value);
}

function hpackDecodeInt(buffer, offset, prefixBits) {
  const max = (1 << prefixBits) - 1;
  let value = buffer[offset++] & max;
  if (value === max) {
    let shift = 0;
    let byte;
    do {
      if (offset >= buffer.byteLength) throw new Error("Truncated HPACK integer");
      byte = buffer[offset++];
      value += (byte & 127) * (2 ** shift);
      shift += 7;
    } while ((byte & 128) !== 0);
  }
  return { value, offset };
}

function hpackEncodeString(value, out) {
  const bytes = Buffer.from(String(value));
  hpackEncodeInt(bytes.byteLength, 7, 0x00, out);
  for (let i = 0; i < bytes.byteLength; i++) out.push(bytes[i]);
}

function hpackDecodeString(buffer, offset) {
  if (offset >= buffer.byteLength) throw new Error("Truncated HPACK string");
  const huffman = (buffer[offset] & 0x80) !== 0;
  const decoded = hpackDecodeInt(buffer, offset, 7);
  const end = decoded.offset + decoded.value;
  if (end > buffer.byteLength) throw new Error("Truncated HPACK string literal");
  const bytes = buffer.subarray(decoded.offset, end);
  return { value: huffman ? huffmanDecode(bytes) : bytes.toString(), offset: end };
}

function hpackEntrySize(name, value) {
  return Buffer.byteLength(name) + Buffer.byteLength(value) + 32;
}

class HpackDecoder {
  constructor() {
    this.dynamic = [];
    this.maxSize = 4096;
    this.size = 0;
  }

  lookup(index) {
    if (index >= 1 && index <= hpackStaticTable.length) return hpackStaticTable[index - 1];
    const entry = this.dynamic[index - hpackStaticTable.length - 1];
    if (!entry) throw new Error(`Invalid HPACK header index ${index}`);
    return entry;
  }

  insert(name, value) {
    this.dynamic.unshift([name, value]);
    this.size += hpackEntrySize(name, value);
    this._evict();
  }

  _evict() {
    while (this.size > this.maxSize && this.dynamic.length > 0) {
      const [name, value] = this.dynamic.pop();
      this.size -= hpackEntrySize(name, value);
    }
  }

  decode(block) {
    const list = [];
    let offset = 0;
    while (offset < block.byteLength) {
      const first = block[offset];
      if ((first & 0x80) !== 0) {
        // Indexed header field
        const decoded = hpackDecodeInt(block, offset, 7);
        offset = decoded.offset;
        const [name, value] = this.lookup(decoded.value);
        list.push([name, value]);
      } else if ((first & 0x40) !== 0) {
        // Literal with incremental indexing
        const decoded = hpackDecodeInt(block, offset, 6);
        offset = decoded.offset;
        let name;
        if (decoded.value === 0) {
          const decodedName = hpackDecodeString(block, offset);
          name = decodedName.value;
          offset = decodedName.offset;
        } else {
          name = this.lookup(decoded.value)[0];
        }
        const decodedValue = hpackDecodeString(block, offset);
        offset = decodedValue.offset;
        this.insert(name, decodedValue.value);
        list.push([name, decodedValue.value]);
      } else if ((first & 0x20) !== 0) {
        // Dynamic table size update
        const decoded = hpackDecodeInt(block, offset, 5);
        offset = decoded.offset;
        this.maxSize = decoded.value;
        this._evict();
      } else {
        // Literal without indexing (0x00) or never indexed (0x10)
        const decoded = hpackDecodeInt(block, offset, 4);
        offset = decoded.offset;
        let name;
        if (decoded.value === 0) {
          const decodedName = hpackDecodeString(block, offset);
          name = decodedName.value;
          offset = decodedName.offset;
        } else {
          name = this.lookup(decoded.value)[0];
        }
        const decodedValue = hpackDecodeString(block, offset);
        offset = decodedValue.offset;
        list.push([name, decodedValue.value, (first & 0x10) !== 0]);
      }
    }
    return list;
  }
}

function headersToList(headers = {}) {
  const pseudo = [];
  const regular = [];
  const sensitive = new Set(Array.isArray(headers?.[sensitiveHeaders]) ? headers[sensitiveHeaders].map(String) : []);
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue == null) continue;
    const name = String(rawName).toLowerCase();
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const target = name.startsWith(":") ? pseudo : regular;
    for (const value of values) {
      if (value == null) continue;
      target.push([name, String(value), sensitive.has(name)]);
    }
  }
  return pseudo.concat(regular);
}

function headerListSize(headers = {}) {
  let size = 0;
  for (const [name, value] of headersToList(headers)) {
    size += Buffer.byteLength(String(name)) + Buffer.byteLength(String(value)) + 32;
  }
  return size;
}

// Stateless HPACK encoding: full static matches use the indexed form, all other
// headers are emitted as literals without indexing so no shared encoder state
// is required for interoperability.
function encodeHeaderList(list) {
  const out = [];
  for (const [name, value, isSensitive] of list) {
    const fullIndex = hpackStaticFullIndex.get(`${name}\u0000${value}`);
    if (fullIndex != null && !isSensitive) {
      hpackEncodeInt(fullIndex, 7, 0x80, out);
      continue;
    }
    const nameIndex = hpackStaticNameIndex.get(name) ?? 0;
    hpackEncodeInt(nameIndex, 4, isSensitive ? 0x10 : 0x00, out);
    if (nameIndex === 0) hpackEncodeString(name, out);
    hpackEncodeString(value, out);
  }
  return Buffer.from(out);
}

function encodeHeaders(headers = {}) {
  return encodeHeaderList(headersToList(headers));
}

function headerListToObject(list) {
  const headers = Object.create(null);
  const sensitive = [];
  for (const [name, value, isSensitive] of list) {
    if (isSensitive && !sensitive.includes(name)) sensitive.push(name);
    if (name === "set-cookie") {
      if (headers[name] === undefined) headers[name] = [];
      headers[name].push(value);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(headers, name)) {
      if (name.startsWith(":")) continue;
      headers[name] = name === "cookie" ? `${headers[name]}; ${value}` : `${headers[name]}, ${value}`;
    } else {
      headers[name] = value;
    }
  }
  if (headers[":status"] != null) headers[":status"] = Number(headers[":status"]);
  if (sensitive.length > 0) headers[sensitiveHeaders] = sensitive;
  return headers;
}

function decodeHeaders(block) {
  return headerListToObject(new HpackDecoder().decode(block));
}

// ---------------------------------------------------------------------------
// Frame primitives
// ---------------------------------------------------------------------------

function defaultSettingsObject() {
  return {
    headerTableSize: 4096,
    enablePush: false,
    initialWindowSize: 65535,
    maxFrameSize: DEFAULT_MAX_FRAME_SIZE,
    maxConcurrentStreams: 4294967295,
    maxHeaderSize: 65535,
    maxHeaderListSize: 65535,
    enableConnectProtocol: false,
  };
}

function writeUint16BE(buffer, offset, value) {
  buffer[offset] = (value >>> 8) & 0xff;
  buffer[offset + 1] = value & 0xff;
}

function writeUint32BE(buffer, offset, value) {
  buffer[offset] = (value >>> 24) & 0xff;
  buffer[offset + 1] = (value >>> 16) & 0xff;
  buffer[offset + 2] = (value >>> 8) & 0xff;
  buffer[offset + 3] = value & 0xff;
}

function readUint16BE(buffer, offset) {
  return (buffer[offset] << 8) | buffer[offset + 1];
}

function readUint32BE(buffer, offset) {
  return ((buffer[offset] * 0x1000000) + ((buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3])) >>> 0;
}

function normalizeCode(code, fallback = constants.NGHTTP2_NO_ERROR) {
  const value = Number(code ?? fallback);
  return Number.isFinite(value) ? (value >>> 0) : fallback;
}

function receivedType(value) {
  if (value === null) return " Received null";
  if (typeof value === "symbol") return " Received type symbol";
  if (typeof value === "string") return ` Received type string ('${value}')`;
  if (typeof value === "object") {
    const name = Object.prototype.toString.call(value).slice(8, -1);
    return ` Received an instance of ${name}`;
  }
  return ` Received type ${typeof value} (${String(value)})`;
}

function validateUint32(value, name) {
  if (typeof value !== "number") {
    const error = new TypeError(`The "${name}" argument must be of type number.${receivedType(value)}`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (!Number.isInteger(value)) {
    const error = new RangeError(`The value of "${name}" is out of range. It must be an integer. Received ${value}`);
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  if (value < 0 || value > 0xffffffff) {
    const error = new RangeError(`The value of "${name}" is out of range. It must be >= 0 and <= 4294967295. Received ${value}`);
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  return value;
}

function codedError(code, message, ErrorCtor = Error) {
  const error = new ErrorCtor(message);
  error.code = code;
  return error;
}

function validateObject(value, name, { optional = false } = {}) {
  if (optional && value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw codedError(
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be of type object.${receivedType(value)}`,
      TypeError,
    );
  }
}

function invalidSetting(name, value, type = false) {
  const message = `Invalid value for setting "${name}": ${String(value)}`;
  throw codedError("ERR_HTTP2_INVALID_SETTING_VALUE", message, type ? TypeError : RangeError);
}

const MAX_ADDITIONAL_SETTINGS = 10;

function validateSettings(settings, name = "settings") {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    const noun = name.includes(".") ? "property" : "argument";
    throw codedError(
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" ${noun} must be of type Object.${receivedType(settings)}`,
      TypeError,
    );
  }
  const uint32Settings = [
    "headerTableSize",
    "maxConcurrentStreams",
    "initialWindowSize",
    "maxHeaderListSize",
    "maxHeaderSize",
  ];
  for (const name of uint32Settings) {
    const value = settings[name];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      invalidSetting(name, value);
    }
  }
  for (const name of ["enablePush", "enableConnectProtocol"]) {
    const value = settings[name];
    if (value !== undefined && typeof value !== "boolean") invalidSetting(name, value, true);
  }
  if (settings.maxFrameSize !== undefined) {
    const value = settings.maxFrameSize;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 16384 || value > 16777215) {
      invalidSetting("maxFrameSize", value);
    }
  }
  if (settings.customSettings !== undefined) {
    validateObject(settings.customSettings, "settings.customSettings");
    const entries = Object.entries(settings.customSettings);
    if (entries.length > MAX_ADDITIONAL_SETTINGS) {
      throw codedError(
        "ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS",
        `The number of custom settings must not exceed ${MAX_ADDITIONAL_SETTINGS}`,
        RangeError,
      );
    }
    for (const [rawId, value] of entries) {
      const id = Number(rawId);
      if (!Number.isInteger(id) || id < 0 || id > 0xffff) invalidSetting(rawId, value);
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        invalidSetting(rawId, value);
      }
    }
  }
  return settings;
}

const validHeaderToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const invalidHeaderValue = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const validPseudoHeaders = new Set([":status", ":method", ":authority", ":scheme", ":path", ":protocol"]);
const connectionHeaders = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);
const singleValueHeaders = new Set([
  "age", "authorization", "content-length", "content-location", "content-md5", "content-range",
  "content-type", "date", "etag", "expires", "from", "host", "if-match", "if-modified-since",
  "if-none-match", "if-range", "if-unmodified-since", "last-modified", "location", "max-forwards",
  "proxy-authorization", "range", "referer", "retry-after", "server", "user-agent",
]);

function assertHeaderName(name, { allowPseudo = true } = {}) {
  if (typeof name !== "string" || name.length === 0) {
    throw codedError("ERR_INVALID_HTTP_TOKEN", `Header name must be a valid HTTP token [${String(name)}]`, TypeError);
  }
  if (name.startsWith(":")) {
    if (!allowPseudo) throw codedError("ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED", "HTTP/2 pseudo-headers are not allowed here");
    if (!validPseudoHeaders.has(name)) {
      throw codedError("ERR_HTTP2_INVALID_PSEUDOHEADER", `Invalid HTTP/2 pseudo-header "${name}"`);
    }
    return name;
  }
  if (!validHeaderToken.test(name)) {
    throw codedError("ERR_INVALID_HTTP_TOKEN", `Header name must be a valid HTTP token [${name}]`, TypeError);
  }
  return name;
}

function assertHeaderValue(name, value) {
  if (value === undefined || value === null) {
    throw codedError("ERR_HTTP2_INVALID_HEADER_VALUE", `Invalid value "${value}" for header "${name}"`, TypeError);
  }
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    if (invalidHeaderValue.test(String(entry))) {
      throw codedError("ERR_INVALID_CHAR", `Invalid character in header content ["${name}"]`, TypeError);
    }
  }
}

function normalizeHeaders(headers, { allowPseudo = true, trailers = false } = {}) {
  if (headers === undefined) return {};
  validateObject(headers, "headers");
  const normalized = {};
  const sensitive = headers[sensitiveHeaders];
  if (sensitive !== undefined && !Array.isArray(sensitive)) {
    throw codedError(
      "ERR_INVALID_ARG_VALUE",
      "The property 'headers[http2.sensitiveHeaders]' must be an array",
      TypeError,
    );
  }
  for (const [rawName, value] of Object.entries(headers)) {
    const name = String(rawName).toLowerCase();
    assertHeaderName(name, { allowPseudo: allowPseudo && !trailers });
    assertHeaderValue(name, value);
    if (connectionHeaders.has(name) || (name === "te" && String(value).toLowerCase() !== "trailers")) {
      throw codedError(
        "ERR_HTTP2_INVALID_CONNECTION_HEADERS",
        `HTTP/1 connection specific headers are forbidden: "${name}"`,
      );
    }
    if (singleValueHeaders.has(name) && Array.isArray(value) && value.length > 1) {
      throw codedError("ERR_HTTP2_HEADER_SINGLE_VALUE", `Header field "${name}" must only have a single value`);
    }
    normalized[name] = value;
  }
  if (sensitive !== undefined) normalized[sensitiveHeaders] = sensitive.map(name => String(name).toLowerCase());
  return normalized;
}

function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function errorCodeName(code) {
  return [
    "NGHTTP2_NO_ERROR", "NGHTTP2_PROTOCOL_ERROR", "NGHTTP2_INTERNAL_ERROR", "NGHTTP2_FLOW_CONTROL_ERROR",
    "NGHTTP2_SETTINGS_TIMEOUT", "NGHTTP2_STREAM_CLOSED", "NGHTTP2_FRAME_SIZE_ERROR", "NGHTTP2_REFUSED_STREAM",
    "NGHTTP2_CANCEL", "NGHTTP2_COMPRESSION_ERROR", "NGHTTP2_CONNECT_ERROR", "NGHTTP2_ENHANCE_YOUR_CALM",
    "NGHTTP2_INADEQUATE_SECURITY", "NGHTTP2_HTTP_1_1_REQUIRED",
  ][code] ?? `NGHTTP2_${code}`;
}

function streamError(code) {
  const error = new Error(`Stream closed with error code ${errorCodeName(code)}`);
  error.code = "ERR_HTTP2_STREAM_ERROR";
  error.errno = code;
  return error;
}

function normalizeStreamId(streamId) {
  const value = Number(streamId ?? 0);
  return Number.isFinite(value) ? (value >>> 0) & 0x7fffffff : 0;
}

function eightBytePayload(payload = undefined) {
  const out = Buffer.alloc(8);
  if (payload != null) {
    const bytes = Buffer.from(payload);
    if (bytes.byteLength !== 8) throw new RangeError("HTTP/2 ping payload must be exactly 8 bytes");
    out.set(bytes, 0);
  } else {
    writeUint32BE(out, 0, Math.floor(Date.now() / 1000));
    writeUint32BE(out, 4, Math.floor(Math.random() * 0xffffffff));
  }
  return out;
}

function frameBuffer(type, frameFlags, streamId, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(9);
  header[0] = (body.byteLength >>> 16) & 0xff;
  header[1] = (body.byteLength >>> 8) & 0xff;
  header[2] = body.byteLength & 0xff;
  header[3] = type;
  header[4] = frameFlags;
  writeUint32BE(header, 5, streamId & 0x7fffffff);
  return Buffer.concat([header, body]);
}

function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.byteLength - offset >= 9) {
    const length = (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
    if (buffer.byteLength - offset - 9 < length) break;
    const type = buffer[offset + 3];
    const frameFlags = buffer[offset + 4];
    const streamId = readUint32BE(buffer, offset + 5) & 0x7fffffff;
    const payload = buffer.subarray(offset + 9, offset + 9 + length);
    frames.push({ type, flags: frameFlags, streamId, payload });
    offset += 9 + length;
  }
  return { frames, remaining: buffer.subarray(offset) };
}

function toChunkBuffer(chunk, encoding = undefined) {
  if (chunk == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") {
    const normalized = typeof encoding === "string" && encoding !== "buffer" ? encoding : "utf8";
    return Buffer.from(chunk, normalized === "binary" ? "latin1" : normalized);
  }
  return Buffer.from(chunk);
}

function authorityPort(url, fallback) {
  return Number(url.port || String(url.href).match(/^https?:\/\/[^/:]+:(\d+)/)?.[1] || fallback);
}

function networkHostname(value) {
  const hostname = String(value ?? "");
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function getDefaultSettings() {
  return defaultSettingsObject();
}

export function getPackedSettings(settings = {}) {
  validateSettings(settings);
  const fields = [];
  const normalized = { ...settings };
  if (normalized.maxHeaderListSize == null && normalized.maxHeaderSize != null) {
    normalized.maxHeaderListSize = normalized.maxHeaderSize;
  }
  for (const [name, id] of settingsFields) {
    if (normalized[name] == null) continue;
    const value = typeof normalized[name] === "boolean" ? (normalized[name] ? 1 : 0) : Number(normalized[name]);
    if (name === "enableConnectProtocol" && value === 0) continue;
    fields.push([id, value]);
  }
  if (normalized.customSettings) {
    const custom = Object.entries(normalized.customSettings)
      .map(([id, value]) => [Number(id), value])
      .sort((a, b) => a[0] - b[0]);
    fields.push(...custom);
  }
  const out = Buffer.alloc(fields.length * 6);
  fields.forEach(([id, value], index) => {
    const offset = index * 6;
    writeUint16BE(out, offset, id);
    writeUint32BE(out, offset + 2, value);
  });
  return out;
}

export function getUnpackedSettings(buffer, options = undefined) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) {
    throw codedError(
      "ERR_INVALID_ARG_TYPE",
      "Expected buf to be a Buffer, TypedArray, DataView, or ArrayBuffer",
      TypeError,
    );
  }
  const bytes = Buffer.from(buffer);
  if (bytes.byteLength % 6 !== 0) {
    throw codedError(
      "ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH",
      "Expected buf to be a Buffer of at least 6 bytes and a multiple of 6 bytes",
      RangeError,
    );
  }
  const out = { enableConnectProtocol: false };
  const customSettings = {};
  for (let offset = 0; offset < bytes.byteLength; offset += 6) {
    const id = readUint16BE(bytes, offset);
    const value = readUint32BE(bytes, offset + 2);
    switch (id) {
      case 1: out.headerTableSize = value; break;
      case 2: out.enablePush = value !== 0; break;
      case 3: out.maxConcurrentStreams = value; break;
      case 4: out.initialWindowSize = value; break;
      case 5: out.maxFrameSize = value; break;
      case 6:
        out.maxHeaderSize = value;
        out.maxHeaderListSize = value;
        break;
      case 8: out.enableConnectProtocol = value !== 0; break;
      default: customSettings[id] = value; break;
    }
  }
  if (Object.keys(customSettings).length > 0) out.customSettings = customSettings;
  if (options?.validate === true) validateSettings(out);
  return out;
}

// ---------------------------------------------------------------------------
// Streams and sessions
// ---------------------------------------------------------------------------

function validateResponseStatus(status) {
  const code = Number(status);
  if (!Number.isInteger(code) || code < 100 || code > 599) {
    throw codedError("ERR_HTTP2_STATUS_INVALID", `Invalid status code: ${String(status)}`, RangeError);
  }
  return code;
}

function payloadForbidden(status, headRequest = false) {
  return headRequest || status === 204 || status === 205 || status === 304;
}

function validateFileOptions(options = undefined) {
  if (options === undefined) return {};
  validateObject(options, "options");
  const copy = { ...options };
  for (const name of ["offset", "length"]) {
    if (copy[name] !== undefined && (typeof copy[name] !== "number" || !Number.isFinite(copy[name]))) {
      throw codedError("ERR_INVALID_ARG_VALUE", `The property 'options.${name}' is invalid`, TypeError);
    }
  }
  if (copy.statCheck !== undefined && typeof copy.statCheck !== "function") {
    throw codedError("ERR_INVALID_ARG_VALUE", "The property 'options.statCheck' must be a function", TypeError);
  }
  if (copy.onError !== undefined && typeof copy.onError !== "function") {
    throw codedError("ERR_INVALID_ARG_VALUE", "The property 'options.onError' must be a function", TypeError);
  }
  return copy;
}

export class Http2Stream extends Duplex {
  constructor(session, id, headers = {}) {
    super({ decodeStrings: false, autoDestroy: false, emitClose: false, allowHalfOpen: true });
    this.session = session;
    this.id = id;
    this.headers = headers;
    this.closed = false;
    this.aborted = false;
    this.rstCode = constants.NGHTTP2_NO_ERROR;
    this.closeCode = constants.NGHTTP2_NO_ERROR;
    this.sentHeaders = undefined;
    this.sentTrailers = undefined;
    this.sentInfoHeaders = [];
    this.headersSent = false;
    this._headRequest = String(headers?.[":method"] ?? "").toUpperCase() === "HEAD";
    this._endStreamSent = false;
    this._endStreamReceived = false;
    this._responseEmitted = false;
    this._waitForTrailers = false;
    this._trailersReady = false;
    this._closeEmitted = false;
    this._abortCleanup = null;
    this._sendQueue = [];
    this._remoteWindowSize = Number(session.remoteSettings?.initialWindowSize ?? 65535);
    this.state = {
      state: constants.NGHTTP2_STREAM_STATE_OPEN,
      weight: constants.NGHTTP2_DEFAULT_WEIGHT,
      sumDependencyWeight: 0,
      localClose: 0,
      remoteClose: 0,
      localWindowSize: Number(session.localSettings?.initialWindowSize ?? 65535),
    };
  }

  get pending() { return !Number.isInteger(this.id) || this.id <= 0; }
  get bufferSize() {
    return this._sendQueue.reduce((size, item) => size + item.data.byteLength - item.offset, 0) +
      Number(this.session?._socket?.writableLength ?? 0);
  }
  get scheme() { return this.headers?.[":scheme"] ?? (this.session?.encrypted ? "https" : "http"); }
  get headRequest() { return this._headRequest; }
  get endAfterHeaders() { return this._endStreamSent && this.headersSent; }
  get pushAllowed() {
    return this.session?.isServer === true && this.session._remoteEnablePushExplicit !== false && !this.closed;
  }

  _assertUsable() {
    if (!this.session || this.destroyed || this.closed) {
      throw codedError("ERR_HTTP2_INVALID_STREAM", "The HTTP/2 stream has been destroyed");
    }
    return this.session;
  }

  respond(headers = {}, options = {}) {
    const session = this._assertUsable();
    if (!session.isServer) throw codedError("ERR_HTTP2_INVALID_STREAM", "Client streams cannot send response headers");
    if (this.headersSent) throw codedError("ERR_HTTP2_HEADERS_SENT", "Response has already been initiated");
    if (this.sentTrailers) throw codedError("ERR_HTTP2_TRAILERS_ALREADY_SENT", "Trailers have already been sent");
    validateObject(options ?? {}, "options");
    const normalized = normalizeHeaders(headers);
    for (const name of Object.keys(normalized)) {
      if (name.startsWith(":") && name !== ":status") {
        throw codedError("ERR_HTTP2_INVALID_PSEUDOHEADER", `Invalid response pseudo-header "${name}"`);
      }
    }
    const status = validateResponseStatus(normalized[":status"] ?? normalized.status ?? 200);
    if (status >= 100 && status < 200) {
      throw codedError("ERR_HTTP2_INFO_STATUS_NOT_ALLOWED", `Informational status code ${status} is not allowed here`);
    }
    delete normalized.status;
    normalized[":status"] = status;
    let endStream = options?.endStream === true || payloadForbidden(status, this.headRequest);
    if (options?.sendDate !== false && normalized.date == null) normalized.date = new Date().toUTCString();
    this._waitForTrailers = options?.waitForTrailers === true && !endStream;
    session._sendHeaders(this.id, normalized, endStream);
    this.sentHeaders = normalized;
    this.headersSent = true;
    if (endStream) {
      this._endStreamSent = true;
      this.state.localClose = 1;
      this.state.state = constants.NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL;
      this._maybeClose();
    }
    return this;
  }

  additionalHeaders(headers = {}) {
    const session = this._assertUsable();
    if (!session.isServer) throw codedError("ERR_HTTP2_INVALID_STREAM", "Informational headers require a server stream");
    if (this.headersSent) throw codedError("ERR_HTTP2_HEADERS_AFTER_RESPOND", "Cannot send informational headers after respond()");
    const normalized = normalizeHeaders(headers);
    const status = validateResponseStatus(normalized[":status"] ?? 200);
    if (status === 101) throw codedError("ERR_HTTP2_STATUS_101", "HTTP/2 does not support status code 101");
    if (status < 100 || status >= 200) {
      throw codedError("ERR_HTTP2_INVALID_INFO_STATUS", `Invalid informational status code: ${status}`, RangeError);
    }
    for (const name of Object.keys(normalized)) {
      if (name.startsWith(":") && name !== ":status") {
        throw codedError("ERR_HTTP2_INVALID_PSEUDOHEADER", `Invalid informational pseudo-header "${name}"`);
      }
    }
    normalized[":status"] = status;
    this.sentInfoHeaders.push(normalized);
    session._sendHeaders(this.id, normalized, false);
    return this;
  }

  _write(chunk, encoding, callback) {
    if (!this.session || this.closed || this._endStreamSent) {
      callback(this._endStreamSent
        ? codedError("ERR_STREAM_WRITE_AFTER_END", "write after end")
        : codedError("ERR_HTTP2_INVALID_STREAM", "The HTTP/2 stream has been destroyed"));
      return;
    }
    this.session._sendData(this.id, toChunkBuffer(chunk, encoding), false, callback);
  }

  _writev(chunks, callback) {
    const buffers = chunks.map(({ chunk, encoding }) => toChunkBuffer(chunk, encoding));
    this._write(Buffer.concat(buffers), undefined, callback);
  }

  _final(callback) {
    if (!this.session || this.closed) {
      callback();
      return;
    }
    if (this._endStreamSent) {
      callback();
      this._maybeClose();
      return;
    }
    if (this._waitForTrailers && !this.sentTrailers) {
      this._trailersReady = true;
      queueMicrotask(() => {
        if (!this.session || this.closed || this.sentTrailers) return;
        if (this.listenerCount("wantTrailers") === 0) this.sendTrailers({});
        else this.emit("wantTrailers");
      });
      callback();
      return;
    }
    this.session._sendData(this.id, Buffer.alloc(0), true, (error) => {
      if (!error) {
        this._endStreamSent = true;
        this.state.localClose = 1;
        this.state.state = this._endStreamReceived
          ? constants.NGHTTP2_STREAM_STATE_CLOSED
          : constants.NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL;
        this._maybeClose();
      }
      callback(error);
    });
  }

  _read() {}

  _destroy(error, callback) {
    const session = this.session;
    let code = this.rstCode;
    if (!code && error) code = error.code === "ABORT_ERR" ? constants.NGHTTP2_CANCEL : constants.NGHTTP2_INTERNAL_ERROR;
    code = normalizeCode(code);
    this.rstCode = code;
    this.closeCode = code;
    this.closed = true;
    this.state.localClose = 1;
    this.state.remoteClose = 1;
    this.state.state = constants.NGHTTP2_STREAM_STATE_CLOSED;
    if (!this._endStreamReceived) {
      this._endStreamReceived = true;
      this.push(null);
    }
    if (!this.writableEnded && !this.aborted) {
      this.aborted = true;
      this.emit("aborted");
    }
    this._abortCleanup?.();
    this._abortCleanup = null;
    if (session) {
      session._cancelStreamWrites(this, error ?? streamError(code));
      session._streamClosed(this);
      if (!session.destroyed) {
        try { session._sendRstStream(this.id, code); } catch {}
      }
    }
    this.session = null;
    callback(error ?? (code !== constants.NGHTTP2_NO_ERROR && code !== constants.NGHTTP2_CANCEL ? streamError(code) : null));
    process.nextTick(() => this._emitClose());
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit("close");
  }

  close(code = constants.NGHTTP2_NO_ERROR, callback = undefined) {
    code = validateUint32(code, "code");
    if (callback !== undefined && typeof callback !== "function") {
      throw codedError(
        "ERR_INVALID_ARG_TYPE",
        `The "callback" argument must be of type function.${receivedType(callback)}`,
        TypeError,
      );
    }
    if (callback) {
      if (this._closeEmitted) queueMicrotask(callback);
      else this.once("close", callback);
    }
    if (this.closed || this.destroyed) return this;
    this.rstCode = code;
    this.closeCode = code;
    this.closed = true;
    this.state.localClose = 1;
    if (!this.aborted && !this.writableEnded) {
      this.aborted = true;
      this.emit("aborted");
    }
    if (!this._endStreamReceived) {
      this._endStreamReceived = true;
      this.state.remoteClose = 1;
      this.push(null);
    }
    const error = code !== constants.NGHTTP2_NO_ERROR && code !== constants.NGHTTP2_CANCEL ? streamError(code) : undefined;
    queueMicrotask(() => {
      if (!this.destroyed) Duplex.prototype.destroy.call(this, error);
    });
    return this;
  }

  priority(options = {}, callback = undefined) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    validateObject(options ?? {}, "options");
    if (options.silent === true) return false;
    const session = this._assertUsable();
    const weight = Math.max(1, Math.min(256, Number(options.weight ?? constants.NGHTTP2_DEFAULT_WEIGHT)));
    const parent = normalizeStreamId(options.parent ?? options.streamDependency ?? 0);
    const exclusive = options.exclusive === true;
    this.state.weight = weight;
    this.state.sumDependencyWeight = weight;
    session._sendPriority(this.id, { parent, weight, exclusive });
    if (typeof callback === "function") queueMicrotask(callback);
    return this;
  }

  pushStream(headers = {}, options = {}, callback = undefined) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (callback !== undefined && typeof callback !== "function") {
      throw codedError("ERR_INVALID_ARG_TYPE", "The callback argument must be a function", TypeError);
    }
    const session = this._assertUsable();
    if (!this.pushAllowed) {
      const error = codedError("ERR_HTTP2_PUSH_DISABLED", "HTTP/2 server push is disabled");
      if (callback) queueMicrotask(() => callback(error));
      else throw error;
      return undefined;
    }
    const outgoing = normalizeHeaders(headers);
    outgoing[":method"] ??= "GET";
    outgoing[":path"] ??= "/";
    outgoing[":scheme"] ??= this.scheme;
    outgoing[":authority"] ??= this.headers?.[":authority"] ?? "";
    const promisedId = session._nextStreamId;
    session._nextStreamId += 2;
    const stream = new Http2Stream(session, promisedId, outgoing);
    stream.sentHeaders = outgoing;
    stream._endStreamReceived = true;
    stream.state.remoteClose = 1;
    stream.state.state = constants.NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE;
    session._streams.set(promisedId, stream);
    session._sendPushPromise(this.id, promisedId, outgoing);
    if (callback) queueMicrotask(() => callback(null, stream, outgoing, options));
    return stream;
  }

  setTimeout(msecs = 0, callback = undefined) {
    const timeout = Number(msecs);
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw codedError("ERR_OUT_OF_RANGE", `The value of "msecs" is out of range. Received ${msecs}`, RangeError);
    }
    if (typeof callback === "function") this.once("timeout", callback);
    this.session?._socket?.setTimeout?.(timeout, () => this.emit("timeout"));
    return this;
  }

  sendTrailers(headers = {}) {
    const session = this._assertUsable();
    if (this.sentTrailers) throw codedError("ERR_HTTP2_TRAILERS_ALREADY_SENT", "Trailers have already been sent");
    if (!this._trailersReady) throw codedError("ERR_HTTP2_TRAILERS_NOT_READY", "Trailing headers are not ready to be sent");
    const normalized = normalizeHeaders(headers, { allowPseudo: false, trailers: true });
    this.sentTrailers = normalized;
    if (Object.keys(normalized).length === 0) session._sendData(this.id, Buffer.alloc(0), true);
    else session._sendHeaders(this.id, normalized, true);
    this._endStreamSent = true;
    this.state.localClose = 1;
    this.state.state = this._endStreamReceived
      ? constants.NGHTTP2_STREAM_STATE_CLOSED
      : constants.NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL;
    this._maybeClose();
    return this;
  }

  respondWithFile(path, headers = {}, options = {}) {
    this._assertUsable();
    const responseHeaders = normalizeHeaders(headers);
    const responseOptions = validateFileOptions(options);
    const status = validateResponseStatus(responseHeaders[":status"] ?? 200);
    if (payloadForbidden(status, this.headRequest)) {
      throw codedError("ERR_HTTP2_PAYLOAD_FORBIDDEN", `Responses with status ${status} must not include a payload`);
    }
    fs.open(path, "r", (error, fd) => {
      if (error) {
        if (responseOptions.onError) responseOptions.onError(error);
        else this.destroy(error);
        return;
      }
      this._respondWithFD(fd, responseHeaders, responseOptions, true);
    });
  }

  respondWithFD(fd, headers = {}, options = {}) {
    this._assertUsable();
    const numericFd = typeof fd === "object" && fd !== null ? Number(fd.fd) : Number(fd);
    if (!Number.isInteger(numericFd) || numericFd < 0) {
      throw codedError("ERR_INVALID_ARG_TYPE", "The fd argument must be a valid file descriptor", TypeError);
    }
    this._respondWithFD(numericFd, normalizeHeaders(headers), validateFileOptions(options), false);
  }

  _respondWithFD(fd, headers, options, closeFd) {
    if (this.headersSent) throw codedError("ERR_HTTP2_HEADERS_SENT", "Response has already been initiated");
    const status = validateResponseStatus(headers[":status"] ?? 200);
    if (payloadForbidden(status, this.headRequest)) {
      throw codedError("ERR_HTTP2_PAYLOAD_FORBIDDEN", `Responses with status ${status} must not include a payload`);
    }
    fs.fstat(fd, (error, stat) => {
      const fail = (reason) => {
        if (closeFd) { try { fs.close(fd, () => {}); } catch {} }
        if (options.onError) options.onError(reason);
        else this.destroy(reason);
      };
      if (error) return fail(error);
      if (!stat?.isFile?.()) {
        return fail(codedError("ERR_HTTP2_SEND_FILE", "The supplied file descriptor does not refer to a regular file"));
      }
      if (!this.session || this.closed) return fail(codedError("ERR_HTTP2_INVALID_STREAM", "The HTTP/2 stream has been destroyed"));
      if (options.statCheck?.call(this, stat, headers, options) === false || this.headersSent) {
        if (closeFd) { try { fs.close(fd, () => {}); } catch {} }
        return;
      }
      const offset = Math.max(0, Number(options.offset ?? 0));
      const available = Math.max(0, Number(stat.size) - offset);
      const length = options.length == null || options.length < 0 ? available : Math.min(available, options.length);
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === "content-length") delete headers[name];
      }
      headers[":status"] = status;
      headers["content-length"] = length;
      this.respond(headers, options);
      if (length === 0) {
        this.end();
        if (closeFd) { try { fs.close(fd, () => {}); } catch {} }
        return;
      }
      const source = fs.createReadStream(null, {
        fd,
        autoClose: closeFd,
        start: offset,
        end: offset + length - 1,
        emitClose: false,
      });
      source.once("error", fail);
      source.pipe(this);
    });
  }

  _receiveData(payload, endStream) {
    if (payload.byteLength > 0) this.push(Buffer.from(payload));
    if (endStream && !this._endStreamReceived) {
      this._endStreamReceived = true;
      this.state.remoteClose = 1;
      this.state.state = this._endStreamSent
        ? constants.NGHTTP2_STREAM_STATE_CLOSED
        : constants.NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE;
      this.push(null);
      this._maybeClose();
    }
  }

  _closeFromPeer(code) {
    if (this.closed) return;
    this.rstCode = normalizeCode(code);
    this.closeCode = this.rstCode;
    this.closed = true;
    this.destroyed = true;
    this.state.localClose = 1;
    this.state.remoteClose = 1;
    this.state.state = constants.NGHTTP2_STREAM_STATE_CLOSED;
    const session = this.session;
    session?._cancelStreamWrites(this, streamError(this.rstCode));
    session?._streamClosed(this);
    this._abortCleanup?.();
    this._abortCleanup = null;
    if (!this._endStreamReceived) {
      this._endStreamReceived = true;
      this.push(null);
    }
    if (this.rstCode !== constants.NGHTTP2_NO_ERROR) {
      this.aborted = true;
      this.emit("aborted");
      if (this.rstCode !== constants.NGHTTP2_CANCEL && this.listenerCount("error") > 0) {
        this.emit("error", streamError(this.rstCode));
      }
    }
    this.session = null;
    queueMicrotask(() => this._emitClose());
  }

  _maybeClose() {
    if (this.closed || !this._endStreamSent || !this._endStreamReceived) return;
    this.closed = true;
    this.destroyed = true;
    this.state.state = constants.NGHTTP2_STREAM_STATE_CLOSED;
    const session = this.session;
    session?._streamClosed(this);
    queueMicrotask(() => this._emitClose());
  }
}

class Http2Session extends EventEmitter {
  constructor(socket, { isServer = false, settings = undefined, remoteCustomSettings = undefined } = {}) {
    super();
    if (!socket || typeof socket.on !== "function" || typeof socket.write !== "function") {
      throw codedError("ERR_INVALID_ARG_TYPE", "The socket argument must be a Duplex stream", TypeError);
    }
    if (settings !== undefined) validateSettings(settings);
    if (remoteCustomSettings !== undefined) {
      if (!Array.isArray(remoteCustomSettings)) {
        throw codedError("ERR_INVALID_ARG_TYPE", "The remoteCustomSettings option must be an array", TypeError);
      }
      if (remoteCustomSettings.length > MAX_ADDITIONAL_SETTINGS) {
        throw codedError("ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS", "Too many remote custom settings", RangeError);
      }
    }
    this._socket = socket;
    this._socketProxy = new Proxy(socket, {
      get(target, property) {
        if (["destroy", "emit", "end", "pause", "read", "resume", "write", "setEncoding", "setKeepAlive", "setNoDelay"].includes(property)) {
          return () => {
            const error = new Error("HTTP/2 sockets should not be directly manipulated");
            error.code = "ERR_HTTP2_NO_SOCKET_MANIPULATION";
            throw error;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, property, value) {
        if (["destroy", "emit", "end", "pause", "read", "resume", "write", "setEncoding", "setKeepAlive", "setNoDelay"].includes(property)) {
          throw codedError("ERR_HTTP2_NO_SOCKET_MANIPULATION", "HTTP/2 sockets should not be directly manipulated");
        }
        return Reflect.set(target, property, value, target);
      },
      has(target, property) { return Reflect.has(target, property); },
      getPrototypeOf(target) { return Reflect.getPrototypeOf(target); },
    });
    this.isServer = isServer;
    this.closed = false;
    this.destroyed = false;
    this._buffer = Buffer.alloc(0);
    this._prefaceSeen = !isServer;
    this._nextStreamId = isServer ? 2 : 1;
    this._streams = new Map();
    this._closeScheduled = false;
    this._closeEmitted = false;
    this._protocolReady = isServer;
    this._outboundFrames = [];
    this._pendingHeaderBlock = null;
    this._hpackDecoder = new HpackDecoder();
    this.localSettings = defaultSettingsObject();
    this.remoteSettings = null;
    this._pendingSettingsCallbacks = [];
    this._pendingSettingsAck = false;
    this._pendingSettingsCount = 0;
    this._pendingPings = new Map();
    this._remoteCustomSettings = remoteCustomSettings ? new Set(remoteCustomSettings.map(Number)) : null;
    this._remoteEnablePushExplicit = undefined;
    this._originSet = this.encrypted ? new Set() : null;
    this.localWindowSize = this.localSettings.initialWindowSize;
    this.remoteWindowSize = defaultSettingsObject().initialWindowSize;
    this.goawayCode = constants.NGHTTP2_NO_ERROR;
    this.state = {
      effectiveLocalWindowSize: this.localWindowSize,
      effectiveRecvDataLength: 0,
      nextStreamID: this._nextStreamId,
      localWindowSize: this.localWindowSize,
      lastProcStreamID: 0,
      remoteWindowSize: this.remoteWindowSize,
      outboundQueueSize: 0,
      deflateDynamicTableSize: this.localSettings.headerTableSize,
      inflateDynamicTableSize: defaultSettingsObject().headerTableSize,
    };
    socket.on("data", (chunk) => this._receive(chunk));
    socket.on("end", () => {
      this.closed = true;
      this._scheduleClose();
    });
    socket.on("close", () => this._emitClose());
    socket.on("drain", () => this._flushAllStreamData());
    socket.on("timeout", () => {
      for (const stream of this._streams.values()) stream.emit("timeout");
      this.emit("timeout");
    });
    socket.on("error", (error) => {
      const resetDuringShutdown = error?.code === "ECONNRESET" || error?.code === "EPIPE" ||
        /connection reset|broken pipe/i.test(String(error?.message ?? ""));
      if (this.closed || this.destroyed || (this._streams.size === 0 && resetDuringShutdown)) {
        this._emitClose();
        return;
      }
      this.emit("error", error);
    });
    if (!isServer) {
      const connectedEvent = socket.encrypted ? "secureConnect" : "connect";
      const activate = () => this._activateProtocol();
      if (socket.connecting) socket.once(connectedEvent, activate);
      else queueMicrotask(activate);
    }
    const initialSettings = isServer ? { ...(settings ?? {}), enablePush: false } : (settings ?? {});
    this._sendSettings(initialSettings);
  }

  get socket() { return this.destroyed ? null : this._socketProxy; }
  get connecting() { return this._socket?.connecting === true; }
  get connected() { return !this.destroyed && !this.connecting && this._protocolReady; }
  get encrypted() { return this._socket?.encrypted === true; }
  get type() { return this.isServer ? constants.NGHTTP2_SESSION_SERVER : constants.NGHTTP2_SESSION_CLIENT; }
  get originSet() { return this.encrypted ? Array.from(this._originSet ?? []) : undefined; }
  get bufferSize() {
    return this.state.outboundQueueSize + Number(this._socket?.writableLength ?? 0);
  }
  get alpnProtocol() {
    if (!this.encrypted) return "h2c";
    if (this.connecting) return undefined;
    return this._socket?.alpnProtocol || undefined;
  }
  get pendingSettingsAck() { return this._pendingSettingsAck; }

  _activateProtocol() {
    if (this._protocolReady || this.destroyed || this._closeScheduled) return;
    if (this.encrypted && this._socket?.alpnProtocol !== "h2") {
      const error = new Error("Protocol error: HTTP/2 was not negotiated by ALPN");
      error.code = "ERR_HTTP2_ERROR";
      for (const frame of this._outboundFrames.splice(0)) {
        if (typeof frame.callback === "function") queueMicrotask(() => frame.callback(error));
      }
      this.destroy(error);
      return;
    }
    this._protocolReady = true;
    try {
      this._socket.write(clientPreface);
      for (const frame of this._outboundFrames.splice(0)) this._writeBufferedFrame(frame.buffer, frame.callback);
    } catch (error) {
      this.destroy(error);
      return;
    }
    this.emit("connect", this, this._socket);
  }

  _writeBufferedFrame(buffer, callback = undefined) {
    try {
      if (typeof callback === "function") this._socket.write(buffer, callback);
      else this._socket.write(buffer);
    } catch (error) {
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      else this.emit("error", error);
    }
  }

  _writeFrame(type, frameFlags, streamId, payload = Buffer.alloc(0), callback = undefined) {
    const buffer = frameBuffer(type, frameFlags, streamId, payload);
    if (!this._protocolReady) {
      this._outboundFrames.push({ buffer, callback });
      return;
    }
    this._writeBufferedFrame(buffer, callback);
  }

  get _maxSendFrameSize() {
    const size = Number(this.remoteSettings?.maxFrameSize);
    return Number.isInteger(size) && size >= DEFAULT_MAX_FRAME_SIZE ? size : DEFAULT_MAX_FRAME_SIZE;
  }

  _sendSettings(settings = undefined, ack = false, callback = undefined) {
    const payload = ack ? Buffer.alloc(0) : getPackedSettings(settings ?? {});
    if (!ack) {
      this._pendingSettingsCount += 1;
      this._pendingSettingsAck = true;
      this._pendingSettingsCallbacks.push({ callback, start: Date.now() });
    }
    if (!ack && payload.byteLength > 0) {
      this.localSettings = { ...this.localSettings, ...getUnpackedSettings(payload) };
      this.localWindowSize = this.localSettings.initialWindowSize;
      this.state.localWindowSize = this.localWindowSize;
      this.state.effectiveLocalWindowSize = this.localWindowSize;
    }
    this._writeFrame(frameTypes.SETTINGS, ack ? flags.ACK : 0, 0, payload);
  }

  _sendHeaders(streamId, headers, endStream = false) {
    const block = encodeHeaders(headers);
    const max = this._maxSendFrameSize;
    const streamFlag = endStream ? flags.END_STREAM : 0;
    if (block.byteLength <= max) {
      this._writeFrame(frameTypes.HEADERS, flags.END_HEADERS | streamFlag, streamId, block);
      return;
    }
    // Split oversized header blocks into HEADERS + CONTINUATION frames.
    let offset = 0;
    let first = true;
    while (offset < block.byteLength) {
      const chunk = block.subarray(offset, offset + max);
      offset += chunk.byteLength;
      const last = offset >= block.byteLength;
      if (first) {
        this._writeFrame(frameTypes.HEADERS, (last ? flags.END_HEADERS : 0) | streamFlag, streamId, chunk);
        first = false;
      } else {
        this._writeFrame(frameTypes.CONTINUATION, last ? flags.END_HEADERS : 0, streamId, chunk);
      }
    }
  }

  _sendData(streamId, data, endStream = false, callback = undefined) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
    const stream = this._streams.get(streamId);
    if (!stream || stream.closed) {
      const error = codedError("ERR_HTTP2_INVALID_STREAM", "The HTTP/2 stream has been destroyed");
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      else this.emit("error", error);
      return false;
    }
    stream._sendQueue.push({ data: body, offset: 0, endStream: endStream === true, callback });
    this._updateOutboundQueueSize();
    this._flushStreamData(stream);
    return stream._sendQueue.length === 0;
  }

  _flushStreamData(stream) {
    if (!stream || stream.closed || this.destroyed) return;
    while (stream._sendQueue.length > 0) {
      const item = stream._sendQueue[0];
      const remaining = item.data.byteLength - item.offset;
      if (remaining === 0) {
        stream._sendQueue.shift();
        this._writeFrame(
          frameTypes.DATA,
          item.endStream ? flags.END_STREAM : 0,
          stream.id,
          Buffer.alloc(0),
          item.callback,
        );
        continue;
      }
      const available = Math.min(
        remaining,
        this._maxSendFrameSize,
        Math.max(0, this.remoteWindowSize),
        Math.max(0, stream._remoteWindowSize),
      );
      if (available <= 0) break;
      const chunk = item.data.subarray(item.offset, item.offset + available);
      item.offset += available;
      this.remoteWindowSize -= available;
      stream._remoteWindowSize -= available;
      this.state.remoteWindowSize = this.remoteWindowSize;
      const last = item.offset >= item.data.byteLength;
      if (last) stream._sendQueue.shift();
      this._writeFrame(
        frameTypes.DATA,
        last && item.endStream ? flags.END_STREAM : 0,
        stream.id,
        chunk,
        last ? item.callback : undefined,
      );
    }
    this._updateOutboundQueueSize();
  }

  _flushAllStreamData() {
    for (const stream of this._streams.values()) this._flushStreamData(stream);
  }

  _updateOutboundQueueSize() {
    let size = this._outboundFrames.reduce((total, frame) => total + frame.buffer.byteLength, 0);
    for (const stream of this._streams.values()) {
      for (const item of stream._sendQueue) size += item.data.byteLength - item.offset;
    }
    this.state.outboundQueueSize = size;
  }

  _cancelStreamWrites(stream, error = undefined) {
    const pending = stream?._sendQueue?.splice(0) ?? [];
    for (const item of pending) {
      if (typeof item.callback === "function") queueMicrotask(() => item.callback(error));
    }
    this._updateOutboundQueueSize();
  }

  _sendRstStream(streamId, code = constants.NGHTTP2_NO_ERROR) {
    const payload = Buffer.alloc(4);
    writeUint32BE(payload, 0, normalizeCode(code));
    this._writeFrame(frameTypes.RST_STREAM, 0, normalizeStreamId(streamId), payload);
  }

  _sendPriority(streamId, { parent = 0, weight = constants.NGHTTP2_DEFAULT_WEIGHT, exclusive = false } = {}) {
    const payload = Buffer.alloc(5);
    writeUint32BE(payload, 0, normalizeStreamId(parent) | (exclusive ? 0x80000000 : 0));
    payload[4] = Math.max(0, Math.min(255, Number(weight) - 1));
    this._writeFrame(frameTypes.PRIORITY, 0, normalizeStreamId(streamId), payload);
  }

  _sendPushPromise(streamId, promisedId, headers = {}) {
    const headerBlock = encodeHeaders(headers);
    const firstLength = Math.max(0, this._maxSendFrameSize - 4);
    const firstBlock = headerBlock.subarray(0, firstLength);
    const payload = Buffer.alloc(4 + firstBlock.byteLength);
    writeUint32BE(payload, 0, normalizeStreamId(promisedId));
    payload.set(firstBlock, 4);
    let offset = firstBlock.byteLength;
    this._writeFrame(
      frameTypes.PUSH_PROMISE,
      offset >= headerBlock.byteLength ? flags.END_HEADERS : 0,
      normalizeStreamId(streamId),
      payload,
    );
    while (offset < headerBlock.byteLength) {
      const chunk = headerBlock.subarray(offset, offset + this._maxSendFrameSize);
      offset += chunk.byteLength;
      this._writeFrame(
        frameTypes.CONTINUATION,
        offset >= headerBlock.byteLength ? flags.END_HEADERS : 0,
        normalizeStreamId(streamId),
        chunk,
      );
    }
  }

  _sendWindowUpdate(streamId, increment) {
    const amount = Number(increment);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 0x7fffffff) {
      throw new RangeError("HTTP/2 window update increment must be between 1 and 2147483647");
    }
    const payload = Buffer.alloc(4);
    writeUint32BE(payload, 0, amount & 0x7fffffff);
    this._writeFrame(frameTypes.WINDOW_UPDATE, 0, normalizeStreamId(streamId), payload);
  }

  _sendGoaway(code = constants.NGHTTP2_NO_ERROR, lastStreamID = 0, opaqueData = undefined) {
    const opaque = opaqueData == null ? Buffer.alloc(0) : Buffer.from(opaqueData);
    const payload = Buffer.alloc(8 + opaque.byteLength);
    writeUint32BE(payload, 0, normalizeStreamId(lastStreamID));
    writeUint32BE(payload, 4, normalizeCode(code));
    payload.set(opaque, 8);
    this._writeFrame(frameTypes.GOAWAY, 0, 0, payload);
  }

  _sendAltSvc(alt, originOrStream = undefined) {
    if (!this.isServer) throw codedError("ERR_HTTP2_ALTSVC_INVALID_ORIGIN", "Only server sessions may send ALTSVC frames");
    if (typeof alt !== "string" || /[\u0000\r\n]/.test(alt)) {
      throw codedError("ERR_INVALID_ARG_VALUE", "The alt argument must be a valid Alt-Svc field value", TypeError);
    }
    let streamId = 0;
    let origin = "";
    if (typeof originOrStream === "number") streamId = normalizeStreamId(originOrStream);
    else if (originOrStream instanceof Http2Stream) streamId = normalizeStreamId(originOrStream.id);
    else if (originOrStream !== undefined) origin = new URL(String(originOrStream)).origin;
    const originBytes = Buffer.from(origin);
    const altBytes = Buffer.from(alt);
    const payload = Buffer.alloc(2 + originBytes.byteLength + altBytes.byteLength);
    writeUint16BE(payload, 0, originBytes.byteLength);
    payload.set(originBytes, 2);
    payload.set(altBytes, 2 + originBytes.byteLength);
    this._writeFrame(frameTypes.ALTSVC, 0, streamId, payload);
  }

  _sendOrigin(origins) {
    if (!this.isServer || !this.encrypted) {
      throw codedError("ERR_HTTP2_ORIGIN_LENGTH", "ORIGIN frames require an encrypted server session");
    }
    const parts = [];
    for (const value of origins) {
      const origin = new URL(String(value)).origin;
      const bytes = Buffer.from(origin);
      if (bytes.byteLength > 0xffff) throw codedError("ERR_HTTP2_ORIGIN_LENGTH", "HTTP/2 origin is too long", RangeError);
      const part = Buffer.alloc(2 + bytes.byteLength);
      writeUint16BE(part, 0, bytes.byteLength);
      part.set(bytes, 2);
      parts.push(part);
    }
    this._writeFrame(frameTypes.ORIGIN, 0, 0, Buffer.concat(parts));
  }

  _receive(chunk) {
    this._buffer = Buffer.concat([this._buffer, Buffer.from(chunk)]);
    if (this.isServer && !this._prefaceSeen) {
      if (this._buffer.byteLength < clientPreface.byteLength) return;
      const preface = this._buffer.subarray(0, clientPreface.byteLength);
      if (!preface.equals(clientPreface)) {
        this.destroy(new Error("Invalid HTTP/2 client preface"));
        return;
      }
      this._buffer = this._buffer.subarray(clientPreface.byteLength);
      this._prefaceSeen = true;
    }
    const parsed = parseFrames(this._buffer);
    this._buffer = parsed.remaining;
    for (const frame of parsed.frames) this._handleFrame(frame);
  }

  _dispatchHeaders(streamId, block, endStream, frameFlags) {
    let list;
    try {
      list = this._hpackDecoder.decode(block);
    } catch (error) {
      this.destroy(error);
      return;
    }
    const headers = headerListToObject(list);
    const rawHeaders = list.flatMap(([name, value]) => [name, value]);
    let stream = this._streams.get(streamId);
    if (this.isServer) {
      if (!stream) {
        stream = new Http2Stream(this, streamId, headers);
        this._streams.set(streamId, stream);
        this.state.lastProcStreamID = streamId;
        this.emit("stream", stream, headers, frameFlags, rawHeaders);
      } else {
        stream.emit("trailers", headers, frameFlags, rawHeaders);
      }
    } else {
      if (!stream || stream.destroyed) return;
      const status = Number(headers[":status"] ?? 0);
      if (!stream._responseEmitted && status >= 100 && status < 200) {
        if (status === constants.HTTP_STATUS_CONTINUE) stream.emit("continue");
        stream.emit("headers", headers, frameFlags, rawHeaders);
      } else if (!stream._responseEmitted) {
        stream._responseEmitted = true;
        stream.emit("response", headers, frameFlags, rawHeaders);
        this.emit("stream", stream, headers, frameFlags, rawHeaders);
      } else {
        stream.emit("trailers", headers, frameFlags, rawHeaders);
      }
    }
    if (endStream && stream) stream._receiveData(Buffer.alloc(0), true);
  }

  _dispatchPushPromise(parentStreamId, promisedId, block, frameFlags) {
    if (this.isServer || this._streams.has(promisedId)) {
      this._sessionError(constants.NGHTTP2_PROTOCOL_ERROR);
      return;
    }
    let list;
    try {
      list = this._hpackDecoder.decode(block);
    } catch (error) {
      this.destroy(error);
      return;
    }
    const headers = headerListToObject(list);
    const rawHeaders = list.flatMap(([name, value]) => [name, value]);
    const stream = new Http2Stream(this, promisedId, headers);
    stream._endStreamSent = true;
    stream.state.localClose = 1;
    stream.state.state = constants.NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL;
    this._streams.set(promisedId, stream);
    this.emit("stream", stream, headers, frameFlags, rawHeaders);
  }

  _handleFrame(frame) {
    if (this._pendingHeaderBlock && frame.type !== frameTypes.CONTINUATION) {
      this._sessionError(constants.NGHTTP2_PROTOCOL_ERROR);
      return;
    }
    if (frame.payload.byteLength > Number(this.localSettings.maxFrameSize ?? DEFAULT_MAX_FRAME_SIZE)) {
      this._sessionError(constants.NGHTTP2_FRAME_SIZE_ERROR);
      return;
    }
    if (frame.type === frameTypes.SETTINGS) {
      if (frame.streamId !== 0) {
        this._sessionError(constants.NGHTTP2_PROTOCOL_ERROR);
        return;
      }
      if (((frame.flags & flags.ACK) !== 0 && frame.payload.byteLength !== 0) || frame.payload.byteLength % 6 !== 0) {
        this._sessionError(constants.NGHTTP2_FRAME_SIZE_ERROR);
        return;
      }
    } else if (frame.type === frameTypes.PING && (frame.streamId !== 0 || frame.payload.byteLength !== 8)) {
      this._sessionError(frame.streamId !== 0 ? constants.NGHTTP2_PROTOCOL_ERROR : constants.NGHTTP2_FRAME_SIZE_ERROR);
      return;
    } else if (frame.type === frameTypes.GOAWAY && (frame.streamId !== 0 || frame.payload.byteLength < 8)) {
      this._sessionError(frame.streamId !== 0 ? constants.NGHTTP2_PROTOCOL_ERROR : constants.NGHTTP2_FRAME_SIZE_ERROR);
      return;
    } else if (frame.type === frameTypes.RST_STREAM && (frame.streamId === 0 || frame.payload.byteLength !== 4)) {
      this._sessionError(frame.streamId === 0 ? constants.NGHTTP2_PROTOCOL_ERROR : constants.NGHTTP2_FRAME_SIZE_ERROR);
      return;
    } else if (frame.type === frameTypes.PRIORITY && (frame.streamId === 0 || frame.payload.byteLength !== 5)) {
      this._sessionError(frame.streamId === 0 ? constants.NGHTTP2_PROTOCOL_ERROR : constants.NGHTTP2_FRAME_SIZE_ERROR);
      return;
    } else if (frame.type === frameTypes.WINDOW_UPDATE && frame.payload.byteLength !== 4) {
      this._sessionError(constants.NGHTTP2_FRAME_SIZE_ERROR);
      return;
    } else if ((frame.type === frameTypes.DATA || frame.type === frameTypes.HEADERS) && frame.streamId === 0) {
      this._sessionError(constants.NGHTTP2_PROTOCOL_ERROR);
      return;
    } else if (frame.type === frameTypes.CONTINUATION &&
      (!this._pendingHeaderBlock || this._pendingHeaderBlock.streamId !== frame.streamId)) {
      this._sessionError(constants.NGHTTP2_PROTOCOL_ERROR);
      return;
    }

    if (frame.type === frameTypes.SETTINGS) {
      if ((frame.flags & flags.ACK) !== 0) {
        this._pendingSettingsCount = Math.max(0, this._pendingSettingsCount - 1);
        this._pendingSettingsAck = this._pendingSettingsCount > 0;
        const pending = this._pendingSettingsCallbacks.shift();
        if (typeof pending?.callback === "function") {
          queueMicrotask(() => pending.callback(null, this.localSettings, Date.now() - pending.start));
        }
        this.emit("localSettings", this.localSettings);
      } else {
        for (let offset = 0; offset < frame.payload.byteLength; offset += 6) {
          const id = readUint16BE(frame.payload, offset);
          const value = readUint32BE(frame.payload, offset + 2);
          if ((id === 2 && value > 1) || (id === 5 && (value < 16384 || value > 16777215))) {
            this._sessionError(constants.NGHTTP2_PROTOCOL_ERROR);
            return;
          }
          if (id === 4 && value > 0x7fffffff) {
            this._sessionError(constants.NGHTTP2_FLOW_CONTROL_ERROR);
            return;
          }
        }
        const settings = frame.payload.byteLength === 0 ? {} : getUnpackedSettings(frame.payload);
        if (!this.isServer && settings.enablePush === true) {
          this._sessionError(constants.NGHTTP2_PROTOCOL_ERROR);
          return;
        }
        if (settings.customSettings && this._remoteCustomSettings) {
          settings.customSettings = Object.fromEntries(
            Object.entries(settings.customSettings).filter(([id]) => this._remoteCustomSettings.has(Number(id))),
          );
          if (Object.keys(settings.customSettings).length === 0) delete settings.customSettings;
        }
        const previousInitialWindowSize = Number(this.remoteSettings?.initialWindowSize ?? 65535);
        if (Object.prototype.hasOwnProperty.call(settings, "enablePush")) {
          this._remoteEnablePushExplicit = settings.enablePush;
        }
        this.remoteSettings = { ...defaultSettingsObject(), ...(this.remoteSettings ?? {}), ...settings };
        const windowDelta = Number(this.remoteSettings.initialWindowSize) - previousInitialWindowSize;
        if (windowDelta !== 0) {
          for (const stream of this._streams.values()) stream._remoteWindowSize += windowDelta;
        }
        this.state.inflateDynamicTableSize = this.remoteSettings.headerTableSize;
        this._sendSettings(undefined, true);
        this.emit("remoteSettings", this.remoteSettings);
        this._flushAllStreamData();
      }
      return;
    }
    if (frame.type === frameTypes.HEADERS) {
      let payload = frame.payload;
      let offset = 0;
      if ((frame.flags & flags.PADDED) !== 0 && payload.byteLength > 0) {
        const padLength = payload[0];
        if (padLength >= payload.byteLength) {
          this._sessionError(constants.NGHTTP2_PROTOCOL_ERROR);
          return;
        }
        offset += 1;
        payload = payload.subarray(0, Math.max(offset, payload.byteLength - padLength));
      }
      if ((frame.flags & flags.PRIORITY) !== 0) {
        if (payload.byteLength - offset < 5) {
          this._sessionError(constants.NGHTTP2_FRAME_SIZE_ERROR);
          return;
        }
        offset += 5;
      }
      const block = payload.subarray(offset);
      const endStream = (frame.flags & flags.END_STREAM) !== 0;
      if ((frame.flags & flags.END_HEADERS) !== 0) {
        this._dispatchHeaders(frame.streamId, block, endStream, frame.flags);
      } else {
        this._pendingHeaderBlock = { streamId: frame.streamId, endStream, flags: frame.flags, chunks: [Buffer.from(block)] };
      }
      return;
    }
    if (frame.type === frameTypes.CONTINUATION) {
      const pending = this._pendingHeaderBlock;
      if (!pending || pending.streamId !== frame.streamId) return;
      pending.chunks.push(Buffer.from(frame.payload));
      if ((frame.flags & flags.END_HEADERS) !== 0) {
        this._pendingHeaderBlock = null;
        const block = Buffer.concat(pending.chunks);
        if (pending.kind === "push") {
          this._dispatchPushPromise(pending.parentStreamId, pending.promisedId, block, pending.flags);
        } else {
          this._dispatchHeaders(pending.streamId, block, pending.endStream, pending.flags);
        }
      }
      return;
    }
    if (frame.type === frameTypes.DATA) {
      let payload = frame.payload;
      if ((frame.flags & flags.PADDED) !== 0 && payload.byteLength > 0) {
        const padLength = payload[0];
        if (padLength >= payload.byteLength) {
          this._sessionError(constants.NGHTTP2_PROTOCOL_ERROR);
          return;
        }
        payload = payload.subarray(1, Math.max(1, payload.byteLength - padLength));
      }
      const endStream = (frame.flags & flags.END_STREAM) !== 0;
      const stream = this._streams.get(frame.streamId);
      if (payload.byteLength > 0) {
        // Replenish flow-control windows so peers that enforce them (for
        // example nghttp2) keep sending without stalling at 64KB.
        try {
          this._sendWindowUpdate(0, payload.byteLength);
          if (!endStream && stream) this._sendWindowUpdate(frame.streamId, payload.byteLength);
        } catch {}
      }
      if (stream) {
        stream.state.localWindowSize = Math.max(0, stream.state.localWindowSize - payload.byteLength);
        this.state.effectiveRecvDataLength += payload.byteLength;
        stream._receiveData(payload, endStream);
      }
      return;
    }
    if (frame.type === frameTypes.RST_STREAM) {
      if (frame.payload.byteLength < 4) return;
      const stream = this._streams.get(frame.streamId);
      if (!stream) return;
      const code = readUint32BE(frame.payload, 0);
      stream._closeFromPeer(code);
      return;
    }
    if (frame.type === frameTypes.PRIORITY) {
      if (frame.payload.byteLength < 5) return;
      const dependency = readUint32BE(frame.payload, 0);
      const priority = {
        parent: dependency & 0x7fffffff,
        exclusive: (dependency & 0x80000000) !== 0,
        weight: Number(frame.payload[4]) + 1,
      };
      const stream = this._streams.get(frame.streamId);
      if (stream) {
        stream.state.weight = priority.weight;
        stream.emit("priority", priority);
      }
      this.emit("priority", frame.streamId, priority);
      return;
    }
    if (frame.type === frameTypes.PUSH_PROMISE) {
      if (frame.payload.byteLength < 4) return;
      const promisedId = readUint32BE(frame.payload, 0) & 0x7fffffff;
      const block = frame.payload.subarray(4);
      if ((frame.flags & flags.END_HEADERS) !== 0) {
        this._dispatchPushPromise(frame.streamId, promisedId, block, frame.flags);
      } else {
        this._pendingHeaderBlock = {
          kind: "push",
          streamId: frame.streamId,
          parentStreamId: frame.streamId,
          promisedId,
          flags: frame.flags,
          chunks: [Buffer.from(block)],
        };
      }
      return;
    }
    if (frame.type === frameTypes.PING) {
      if (frame.payload.byteLength !== 8) return;
      const payload = Buffer.from(frame.payload);
      const key = payload.toString("hex");
      if ((frame.flags & flags.ACK) !== 0) {
        const pending = this._pendingPings.get(key);
        if (pending) {
          this._pendingPings.delete(key);
          queueMicrotask(() => pending.callback(null, Date.now() - pending.start, payload));
        }
        this.emit("ping", payload);
      } else {
        this.emit("ping", payload);
        this._writeFrame(frameTypes.PING, flags.ACK, 0, payload);
      }
      return;
    }
    if (frame.type === frameTypes.GOAWAY) {
      if (frame.payload.byteLength < 8) return;
      const lastStreamID = readUint32BE(frame.payload, 0) & 0x7fffffff;
      const errorCode = readUint32BE(frame.payload, 4);
      const opaqueData = Buffer.from(frame.payload.subarray(8));
      this.goawayCode = errorCode;
      this.closed = true;
      this.state.lastProcStreamID = lastStreamID;
      this.emit("goaway", errorCode, lastStreamID, opaqueData);
      if (this._streams.size === 0) this._scheduleClose();
      return;
    }
    if (frame.type === frameTypes.WINDOW_UPDATE) {
      if (frame.payload.byteLength < 4) return;
      const increment = readUint32BE(frame.payload, 0) & 0x7fffffff;
      if (increment === 0) {
        if (frame.streamId === 0) this._sessionError(constants.NGHTTP2_PROTOCOL_ERROR);
        else this._streams.get(frame.streamId)?._closeFromPeer(constants.NGHTTP2_PROTOCOL_ERROR);
        return;
      }
      if (frame.streamId === 0) {
        if (this.remoteWindowSize + increment > 0x7fffffff) {
          this._sessionError(constants.NGHTTP2_FLOW_CONTROL_ERROR);
          return;
        }
        this.remoteWindowSize += increment;
        this.state.remoteWindowSize = this.remoteWindowSize;
        this.emit("windowUpdate", increment);
        this._flushAllStreamData();
      } else {
        const stream = this._streams.get(frame.streamId);
        if (stream) {
          if (stream._remoteWindowSize + increment > 0x7fffffff) {
            stream._closeFromPeer(constants.NGHTTP2_FLOW_CONTROL_ERROR);
            return;
          }
          stream._remoteWindowSize += increment;
          stream.emit("windowUpdate", increment);
          this._flushStreamData(stream);
        }
      }
      return;
    }
    if (frame.type === frameTypes.ALTSVC) {
      if (frame.payload.byteLength < 2) return;
      const originLength = readUint16BE(frame.payload, 0);
      if (originLength > frame.payload.byteLength - 2) {
        this._sessionError(constants.NGHTTP2_FRAME_SIZE_ERROR);
        return;
      }
      const origin = frame.payload.subarray(2, 2 + originLength).toString();
      const value = frame.payload.subarray(2 + originLength).toString();
      this.emit("altsvc", value, origin, frame.streamId);
      return;
    }
    if (frame.type === frameTypes.ORIGIN) {
      if (!this.encrypted || frame.streamId !== 0) return;
      const origins = [];
      let offset = 0;
      while (offset + 2 <= frame.payload.byteLength) {
        const length = readUint16BE(frame.payload, offset);
        offset += 2;
        if (offset + length > frame.payload.byteLength) {
          this._sessionError(constants.NGHTTP2_FRAME_SIZE_ERROR);
          return;
        }
        const origin = frame.payload.subarray(offset, offset + length).toString();
        offset += length;
        origins.push(origin);
        this._originSet?.add(origin);
      }
      this.emit("origin", origins);
    }
  }

  _sessionError(code) {
    if (this._fatalError) return;
    this._fatalError = true;
    const error = new Error(`Session closed with error code ${errorCodeName(code)}`);
    error.code = "ERR_HTTP2_SESSION_ERROR";
    error.errno = code;
    this.goawayCode = code;
    try { this._sendGoaway(code, this.state.lastProcStreamID); } catch {}
    this.closed = true;
    this._scheduleClose(error);
  }

  _streamClosed(stream) {
    this._streams.delete(stream.id);
    if (this.closed && !this.destroyed && this._streams.size === 0) this._scheduleClose();
  }

  request(headers = {}, options = {}) {
    if (this.isServer || this.destroyed || this.closed) {
      throw codedError("ERR_HTTP2_INVALID_SESSION", "The HTTP/2 session has been destroyed");
    }
    if (headers === undefined) headers = {};
    const suppliedHeaders = normalizeHeaders(headers);
    if (Object.prototype.hasOwnProperty.call(suppliedHeaders, ":status")) {
      throw codedError("ERR_HTTP2_INVALID_PSEUDOHEADER", "The :status pseudo-header is not valid in a request");
    }
    if (options === undefined) options = {};
    validateObject(options, "options");
    if (this._nextStreamId <= 0 || this._nextStreamId > 0x7fffffff) {
      const stream = new Http2Stream(this, undefined, suppliedHeaders);
      queueMicrotask(() => stream.destroy(codedError("ERR_HTTP2_OUT_OF_STREAMS", "No stream IDs are available")));
      return stream;
    }
    const id = this._nextStreamId;
    this._nextStreamId += 2;
    this.state.nextStreamID = this._nextStreamId;
    const outgoing = {
      ":method": suppliedHeaders[":method"] ?? "GET",
      ":path": suppliedHeaders[":path"] ?? "/",
      ":scheme": suppliedHeaders[":scheme"] ?? (this._socket.encrypted ? "https" : "http"),
      ":authority": suppliedHeaders[":authority"] ?? suppliedHeaders.host ?? this._defaultAuthority ?? "",
      ...suppliedHeaders,
    };
    const stream = new Http2Stream(this, id, outgoing);
    this._streams.set(id, stream);
    stream.sentHeaders = outgoing;
    stream._waitForTrailers = options?.waitForTrailers === true;

    const signal = options?.signal;
    if (signal != null && typeof signal.addEventListener !== "function") {
      const error = new TypeError('The "options.signal" property must be an instance of AbortSignal');
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    if (signal?.aborted) {
      stream.aborted = true;
      stream.rstCode = constants.NGHTTP2_CANCEL;
      queueMicrotask(() => stream.destroy(abortError()));
      return stream;
    }

    const method = String(outgoing[":method"]).toUpperCase();
    const endStream = options?.endStream ?? (!stream._waitForTrailers && (method === "GET" || method === "HEAD"));
    const maxHeaderListSize = Number(this.remoteSettings?.maxHeaderListSize ?? defaultSettingsObject().maxHeaderListSize);
    if (Number.isFinite(maxHeaderListSize) && headerListSize(outgoing) > maxHeaderListSize) {
      queueMicrotask(() => {
        if (stream.destroyed) return;
        const code = constants.NGHTTP2_COMPRESSION_ERROR;
        stream.rstCode = code;
        stream.destroy(streamError(code));
      });
      return stream;
    }
    this._sendHeaders(id, outgoing, endStream === true);
    if (endStream) {
      stream._endStreamSent = true;
      stream.state.localClose = 1;
      stream.state.state = constants.NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL;
      queueMicrotask(() => {
        if (!stream.writableEnded && !stream.destroyed) stream.end();
      });
    }
    if (options.weight !== undefined || options.parent !== undefined || options.exclusive !== undefined) {
      stream.priority(options);
    }
    if (signal) {
      const onAbort = () => {
        if (stream.destroyed) return;
        stream.aborted = true;
        stream.emit("aborted");
        stream.rstCode = constants.NGHTTP2_CANCEL;
        stream.destroy(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      stream._abortCleanup = () => signal.removeEventListener("abort", onAbort);
    }
    queueMicrotask(() => {
      if (!stream.destroyed) stream.emit("ready");
    });
    return stream;
  }

  setNextStreamID(id) {
    if (this.isServer || this.destroyed) throw codedError("ERR_HTTP2_INVALID_SESSION", "The HTTP/2 session has been destroyed");
    if (typeof id !== "number") {
      const error = new TypeError(`The "id" argument must be of type number.${receivedType(id)}`);
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) {
      const error = new RangeError(`The value of "id" is out of range. It must be > 0 and <= 4294967295. Received ${id}`);
      error.code = "ERR_OUT_OF_RANGE";
      throw error;
    }
    this._nextStreamId = id;
    this.state.nextStreamID = id;
  }

  settings(settings = {}, callback = undefined) {
    if (typeof settings === "function") {
      callback = settings;
      settings = {};
    }
    if (this.destroyed) throw codedError("ERR_HTTP2_INVALID_SESSION", "The HTTP/2 session has been destroyed");
    validateSettings(settings);
    if (callback !== undefined && typeof callback !== "function") {
      throw codedError("ERR_INVALID_ARG_TYPE", "The callback argument must be a function", TypeError);
    }
    const outgoing = this.isServer ? { ...settings, enablePush: false } : settings;
    this._sendSettings(outgoing, false, callback);
    return this;
  }

  ping(payload = undefined, callback = undefined) {
    if (typeof payload === "function") {
      callback = payload;
      payload = undefined;
    }
    if (this.destroyed) return false;
    if (callback !== undefined && typeof callback !== "function") {
      throw codedError("ERR_INVALID_ARG_TYPE", "The callback argument must be a function", TypeError);
    }
    if (payload !== undefined && !Buffer.isBuffer(payload) && !ArrayBuffer.isView(payload)) {
      const error = new TypeError(`The "payload" argument must be of type Buffer or TypedArray.${receivedType(payload)}`);
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    let body;
    try {
      body = eightBytePayload(payload);
    } catch {
      const error = new RangeError("HTTP2 ping payload must be 8 bytes");
      error.code = "ERR_HTTP2_PING_LENGTH";
      if (typeof callback === "function") {
        queueMicrotask(() => callback(error));
        return false;
      }
      throw error;
    }
    if (typeof callback === "function") {
      this._pendingPings.set(body.toString("hex"), { callback, start: Date.now(), payload: body });
    }
    this._writeFrame(frameTypes.PING, 0, 0, body);
    return true;
  }

  goaway(code = constants.NGHTTP2_NO_ERROR, lastStreamID = 0, opaqueData = undefined) {
    if (this.destroyed) throw codedError("ERR_HTTP2_INVALID_SESSION", "The HTTP/2 session has been destroyed");
    code = validateUint32(code, "code");
    lastStreamID = validateUint32(lastStreamID, "lastStreamID");
    if (opaqueData !== undefined && !Buffer.isBuffer(opaqueData) && !ArrayBuffer.isView(opaqueData)) {
      const error = new TypeError(
        `The "opaqueData" argument must be of type Buffer, TypedArray, or DataView.${receivedType(opaqueData)}`,
      );
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    const effectiveLastStreamID = this.isServer && lastStreamID === 0 ? this.state.lastProcStreamID : lastStreamID;
    this._sendGoaway(code, effectiveLastStreamID, opaqueData);
    this.goawayCode = code;
    return this;
  }

  altsvc(alt, originOrStream = undefined) {
    this._sendAltSvc(alt, originOrStream);
  }

  origin(...origins) {
    if (origins.length === 0) throw codedError("ERR_MISSING_ARGS", "At least one origin is required", TypeError);
    this._sendOrigin(origins);
  }

  setLocalWindowSize(windowSize) {
    if (this.destroyed) throw codedError("ERR_HTTP2_INVALID_SESSION", "The HTTP/2 session has been destroyed");
    const size = Number(windowSize);
    if (!Number.isInteger(size) || size < 0 || size > 0x7fffffff) {
      throw codedError(
        "ERR_OUT_OF_RANGE",
        "HTTP/2 local window size must be between 0 and 2147483647",
        RangeError,
      );
    }
    const increment = size - this.localWindowSize;
    this.localWindowSize = size;
    this.state.localWindowSize = size;
    this.state.effectiveLocalWindowSize = size;
    if (increment > 0) this._sendWindowUpdate(0, increment);
    return this;
  }

  setTimeout(msecs = 0, callback = undefined) {
    if (callback !== undefined && typeof callback !== "function") {
      throw codedError("ERR_INVALID_ARG_TYPE", "The callback argument must be a function", TypeError);
    }
    if (typeof callback === "function") this.once("timeout", callback);
    this._socket?.setTimeout?.(Number(msecs));
    return this;
  }

  ref() {
    this._socket?.ref?.();
    return this;
  }

  unref() {
    this._socket?.unref?.();
    return this;
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.closed = true;
    this.destroyed = true;
    const closeError = codedError("ERR_HTTP2_INVALID_SESSION", "The HTTP/2 session has been destroyed");
    for (const frame of this._outboundFrames.splice(0)) {
      if (typeof frame.callback === "function") queueMicrotask(() => frame.callback(closeError));
    }
    for (const stream of [...this._streams.values()]) stream._closeFromPeer(constants.NGHTTP2_CANCEL);
    for (const pending of this._pendingPings.values()) {
      if (typeof pending.callback === "function") queueMicrotask(() => pending.callback(closeError, 0, pending.payload));
    }
    this._pendingPings.clear();
    for (const pending of this._pendingSettingsCallbacks.splice(0)) {
      if (typeof pending.callback === "function") queueMicrotask(() => pending.callback(closeError));
    }
    this._socket = null;
    this.emit("close");
  }

  _scheduleClose(error = undefined) {
    if (this._closeScheduled) return;
    this._closeScheduled = true;
    setTimeout(() => {
      try { this._socket.end?.(); } catch {}
      if (error) this.emit("error", error);
      this._emitClose();
    }, 0);
  }

  close(callback = undefined) {
    if (callback !== undefined && typeof callback !== "function") {
      throw codedError("ERR_INVALID_ARG_TYPE", "The callback argument must be a function", TypeError);
    }
    if (typeof callback === "function") {
      if (this._closeEmitted) queueMicrotask(callback);
      else this.once("close", callback);
    }
    this.closed = true;
    if (this._protocolReady) {
      try { this._sendGoaway(constants.NGHTTP2_NO_ERROR, this.state.lastProcStreamID); } catch {}
    }
    if (this._streams.size === 0) this._scheduleClose();
    return this;
  }

  destroy(error = undefined) {
    if (this.destroyed) return this;
    let code = constants.NGHTTP2_NO_ERROR;
    if (typeof error === "number") {
      code = normalizeCode(error);
      error = code === constants.NGHTTP2_NO_ERROR ? undefined : codedError(
        "ERR_HTTP2_SESSION_ERROR",
        `Session closed with error code ${errorCodeName(code)}`,
      );
    } else if (error) {
      code = normalizeCode(error.errno, constants.NGHTTP2_INTERNAL_ERROR);
    }
    this.destroyed = true;
    this.closed = true;
    if (this._protocolReady) {
      try { this._sendGoaway(code, this.state.lastProcStreamID); } catch {}
    }
    this._scheduleClose(error);
    return this;
  }

  [Symbol.asyncDispose]() {
    return new Promise((resolve) => this.close(resolve));
  }
}

export class ClientHttp2Session extends Http2Session {}

class ServerHttp2Session extends Http2Session {}

class Http2Server extends EventEmitter {
  constructor(options = {}, listener = undefined, secure = false) {
    super();
    this.listening = false;
    this.timeout = 0;
    this._options = options ?? {};
    this._secure = secure;
    this._server = null;
    this._sessions = new Set();
    this._closing = false;
    this._serverClosed = false;
    this._closeEmitted = false;
    if (typeof listener === "function") this.on("request", listener);
  }

  _acceptSocket(socket, alreadySecure = !this._secure) {
    if (this._secure && !alreadySecure && socket?.encrypted !== true) {
      let secureSocket;
      try {
        const tlsOptions = this._options.ALPNProtocols == null
          ? { ...this._options, ALPNProtocols: this._options.allowHTTP1 ? ["h2", "http/1.1"] : ["h2"] }
          : this._options;
        secureSocket = _upgradeServerSocket(socket, tlsOptions);
      } catch (error) {
        this.emit("tlsClientError", error, socket);
        socket?.destroy?.();
        return;
      }
      secureSocket.once("secureConnect", () => this._acceptSocket(secureSocket, true));
      secureSocket.once("error", (error) => this.emit("tlsClientError", error, secureSocket));
      return;
    }
    if (this._secure && socket?.alpnProtocol && socket.alpnProtocol !== "h2") {
      if (!this.emit("unknownProtocol", socket)) socket?.destroy?.();
      return;
    }
    const session = new ServerHttp2Session(socket, {
      isServer: true,
      settings: this._options.settings,
      remoteCustomSettings: this._options.remoteCustomSettings,
    });
    this._sessions.add(session);
    session.once("close", () => {
      this._sessions.delete(session);
      this._maybeEmitClose();
    });
    if (this.timeout > 0) {
      session.setTimeout(this.timeout, () => {
        if (!this.emit("timeout", session)) session.destroy();
      });
    }
    session.on("stream", (stream, headers, streamFlags, rawHeaders) => {
      this.emit("stream", stream, headers, streamFlags, rawHeaders);
      const RequestCtor = this._options.Http2ServerRequest ?? Http2ServerRequest;
      const ResponseCtor = this._options.Http2ServerResponse ?? Http2ServerResponse;
      const request = new RequestCtor(stream, headers, undefined, rawHeaders);
      const response = new ResponseCtor(stream, request);
      const method = String(headers[":method"] ?? "").toUpperCase();
      if (method === "CONNECT") {
        if (!this.emit("connect", request, response)) {
          response.statusCode = 405;
          response.end();
        }
        return;
      }
      if (headers.expect !== undefined) {
        if (String(headers.expect).toLowerCase() === "100-continue") {
          if (this.listenerCount("checkContinue") > 0) this.emit("checkContinue", request, response);
          else {
            response.writeContinue();
            this.emit("request", request, response);
          }
        } else if (this.listenerCount("checkExpectation") > 0) {
          this.emit("checkExpectation", request, response);
        } else {
          response.statusCode = 417;
          response.end();
        }
        return;
      }
      this.emit("request", request, response);
    });
    session.on("error", error => this.emit("sessionError", error, session));
    this.emit("session", session);
    if (Array.isArray(this._options.origins) && this._options.origins.length > 0 && session.encrypted) {
      session.origin(...this._options.origins);
    }
  }

  setTimeout(msecs = 0, callback = undefined) {
    const timeout = Number(msecs);
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw codedError("ERR_OUT_OF_RANGE", `The value of "msecs" is out of range. Received ${msecs}`, RangeError);
    }
    this.timeout = timeout;
    if (callback !== undefined) {
      if (typeof callback !== "function") {
        const error = new TypeError('The "callback" argument must be of type function');
        error.code = "ERR_INVALID_CALLBACK";
        throw error;
      }
      this.on("timeout", callback);
    }
    return this;
  }

  updateSettings(settings) {
    validateSettings(settings);
    this._options.settings = { ...(this._options.settings ?? {}), ...settings };
    return this;
  }

  listen(...args) {
    const callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
    if (callback) this.once("listening", callback);
    const connectionListener = (socket) => this._acceptSocket(socket, true);
    const tlsOptions = this._secure && this._options.ALPNProtocols == null
      ? {
          ...this._options,
          ALPNProtocols: this._options.allowHTTP1 ? ["h2", "http/1.1"] : ["h2"],
        }
      : this._options;
    this._server = this._secure
      ? createTlsServer(tlsOptions, connectionListener)
      : createNetServer(connectionListener);
    this._server.once("error", (error) => this.emit("error", error));
    this._server.on?.("connection", socket => this.emit("connection", socket));
    this._server.listen(...args, () => {
      this.listening = true;
      this.emit("listening");
    });
    return this;
  }

  close(callback = undefined) {
    if (callback !== undefined && typeof callback !== "function") {
      throw codedError("ERR_INVALID_ARG_TYPE", "The callback argument must be a function", TypeError);
    }
    if (callback) this.once("close", callback);
    if (this._closing) return this;
    this._closing = true;
    this.listening = false;
    for (const session of [...this._sessions]) session.close();
    if (this._server) {
      this._server.once("close", () => {
        this._serverClosed = true;
        this._maybeEmitClose();
      });
      this._server.close();
    } else {
      this._serverClosed = true;
      queueMicrotask(() => this._maybeEmitClose());
    }
    return this;
  }

  _maybeEmitClose() {
    if (!this._closing || !this._serverClosed || this._sessions.size > 0 || this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit("close");
  }

  closeAllConnections() {
    for (const session of [...this._sessions]) session.destroy();
  }

  closeIdleConnections() {
    for (const session of [...this._sessions]) {
      if (session._streams.size === 0) session.close();
    }
  }

  getConnections(callback) {
    return this._server?.getConnections?.(callback) ?? queueMicrotask(() => callback?.(null, this._sessions.size));
  }

  address() { return this._server?.address?.() ?? null; }
  ref() { this._server?.ref?.(); return this; }
  unref() { this._server?.unref?.(); return this; }
  [Symbol.asyncDispose]() { return new Promise(resolve => this.close(resolve)); }
}

function validateServerOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    const error = new TypeError(`The "options" argument must be of type Object.${receivedType(options)}`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  const normalized = { ...options };
  if (normalized.settings !== undefined) validateSettings(normalized.settings, "options.settings");
  if (normalized.remoteCustomSettings !== undefined) {
    if (!Array.isArray(normalized.remoteCustomSettings)) {
      throw codedError("ERR_INVALID_ARG_TYPE", "The options.remoteCustomSettings property must be an array", TypeError);
    }
    if (normalized.remoteCustomSettings.length > MAX_ADDITIONAL_SETTINGS) {
      throw codedError("ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS", "Too many remote custom settings", RangeError);
    }
    normalized.remoteCustomSettings = [...normalized.remoteCustomSettings];
  }
  for (const name of ["maxSessionInvalidFrames", "maxSessionRejectedStreams", "unknownProtocolTimeout"]) {
    if (normalized[name] === undefined) continue;
    const value = Number(normalized[name]);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      const error = new RangeError(`The value of "options.${name}" is out of range. It must be >= 0. Received ${normalized[name]}`);
      error.code = "ERR_OUT_OF_RANGE";
      throw error;
    }
  }
  normalized.unknownProtocolTimeout ??= 10000;
  return normalized;
}

export function connect(authority, options = undefined, listener = undefined) {
  if (typeof options === "function") {
    listener = options;
    options = undefined;
  }
  if (options === undefined) options = {};
  validateObject(options, "options");
  options = { ...options };
  if (options.settings !== undefined) validateSettings(options.settings, "options.settings");
  if (options.remoteCustomSettings !== undefined) {
    if (!Array.isArray(options.remoteCustomSettings)) {
      throw codedError("ERR_INVALID_ARG_TYPE", "The options.remoteCustomSettings property must be an array", TypeError);
    }
    if (options.remoteCustomSettings.length > MAX_ADDITIONAL_SETTINGS) {
      throw codedError("ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS", "Too many remote custom settings", RangeError);
    }
  }
  let url;
  if (authority instanceof URL) {
    url = authority;
  } else if (authority !== null && typeof authority === "object") {
    options = { ...authority, ...options };
    const protocol = options.protocol ?? "https:";
    const hostname = options.hostname ?? options.host ?? "localhost";
    const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
    const port = options.port == null ? "" : `:${options.port}`;
    url = new URL(`${protocol}//${host}${port}`);
  } else {
    try {
      url = new URL(String(authority));
    } catch {
      throw codedError("ERR_INVALID_URL", `Invalid URL: ${String(authority)}`, TypeError);
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw codedError("ERR_HTTP2_UNSUPPORTED_PROTOCOL", `Protocol "${url.protocol}" is not supported`);
  }
  const secure = url.protocol === "https:";
  const urlHostname = networkHostname(url.hostname);
  const host = networkHostname(options.host ?? options.hostname ?? urlHostname);
  const port = Number(options.port ?? authorityPort(url, secure ? 443 : 80));
  let socket;
  if (typeof options.createConnection === "function") {
    socket = options.createConnection(url, options);
  } else if (secure) {
    // grpc-js style callers provide a SecureContext rather than raw ca/cert
    // options; recover the captured CA bundle so verification can succeed.
    const contextOptions = options.secureContext?.context ?? {};
    socket = tlsConnect({
      ...options,
      host,
      port,
      servername: options.servername ?? (isIP(urlHostname) ? undefined : urlHostname),
      rejectUnauthorized: options.rejectUnauthorized,
      ca: options.ca ?? contextOptions.ca,
      ALPNProtocols: options.ALPNProtocols ?? ["h2"],
    });
  } else {
    socket = netConnect({ ...options, host, port });
  }
  const session = new ClientHttp2Session(socket, {
    isServer: false,
    settings: options.settings,
    remoteCustomSettings: options.remoteCustomSettings,
  });
  session.authority = url.href;
  session.options = options;
  if (secure) session._originSet = new Set([url.origin]);
  const defaultPort = (secure && port === 443) || (!secure && port === 80);
  const authorityHost = String(url.hostname || host).includes(":") ? `[${networkHostname(url.hostname || host)}]` : (url.hostname || host);
  session._defaultAuthority = defaultPort ? authorityHost : `${authorityHost}:${port}`;
  if (typeof listener === "function") session.once("connect", listener);
  return session;
}

export function createServer(options = undefined, onRequestHandler = undefined) {
  if (typeof options === "function") {
    onRequestHandler = options;
    options = {};
  }
  options = validateServerOptions(options);
  return new Http2Server(options, onRequestHandler, false);
}

export function createSecureServer(options = undefined, onRequestHandler = undefined) {
  if (typeof options === "function") {
    onRequestHandler = options;
    options = {};
  }
  options = validateServerOptions(options);
  return new Http2Server(options, onRequestHandler, true);
}

export function performServerHandshake(socket, options = {}) {
  options = validateServerOptions(options);
  return new ServerHttp2Session(socket, {
    isServer: true,
    settings: options.settings,
    remoteCustomSettings: options.remoteCustomSettings,
  });
}

Object.defineProperty(connect, Symbol.for("nodejs.util.promisify.custom"), {
  value(authority, options) {
    return new Promise((resolve, reject) => {
      const session = connect(authority, options, () => {
        session.removeListener("error", reject);
        resolve(session);
      });
      session.once("error", reject);
    });
  },
  configurable: true,
});

// COTTONTAIL-COMPAT: node:http2 native TLS boundary - h2c and TLS sessions, ALPN, HPACK decoding, CONTINUATION, settings, stream/session state, trailers, file responses, outbound flow control, and compatibility request/response APIs are implemented in the portable runtime. HTTP/1 fallback and native zero-copy sendfile remain transport-boundary work; HPACK encoding is deliberately interoperable but stateless.

export default {
  Http2Stream,
  Http2ServerRequest,
  Http2ServerResponse,
  ClientHttp2Session,
  connect,
  constants,
  createSecureServer,
  createServer,
  getDefaultSettings,
  getPackedSettings,
  getUnpackedSettings,
  performServerHandshake,
  sensitiveHeaders,
};
