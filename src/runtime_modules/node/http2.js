import { Buffer } from "./buffer.js";
import { EventEmitter } from "./events.js";
import { IncomingMessage, ServerResponse } from "./http.js";

export class Http2ServerRequest extends IncomingMessage {}
export class Http2ServerResponse extends ServerResponse {}

export const sensitiveHeaders = Symbol("sensitiveHeaders");

export const constants = {
  NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1,
  NGHTTP2_SETTINGS_ENABLE_PUSH: 2,
  NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3,
  NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4,
  NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5,
  NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6,
  NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL: 8,
  HTTP2_HEADER_AUTHORITY: ":authority",
  HTTP2_HEADER_METHOD: ":method",
  HTTP2_HEADER_PATH: ":path",
  HTTP2_HEADER_SCHEME: ":scheme",
  HTTP2_HEADER_STATUS: ":status",
  HTTP2_METHOD_CONNECT: "CONNECT",
  HTTP2_METHOD_DELETE: "DELETE",
  HTTP2_METHOD_GET: "GET",
  HTTP2_METHOD_HEAD: "HEAD",
  HTTP2_METHOD_OPTIONS: "OPTIONS",
  HTTP2_METHOD_PATCH: "PATCH",
  HTTP2_METHOD_POST: "POST",
  HTTP2_METHOD_PUT: "PUT",
  HTTP2_METHOD_TRACE: "TRACE",
};

const settingsFields = [
  ["headerTableSize", 1],
  ["enablePush", 2],
  ["maxConcurrentStreams", 3],
  ["initialWindowSize", 4],
  ["maxFrameSize", 5],
  ["maxHeaderListSize", 6],
  ["enableConnectProtocol", 8],
];

function unsupportedHttp2(name) {
  return new Error(`${name} requires native HTTP/2 session bindings that are not implemented in Cottontail yet`);
}

function defaultSettingsObject() {
  return {
    headerTableSize: 4096,
    enablePush: true,
    initialWindowSize: 65535,
    maxFrameSize: 16384,
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

export function getDefaultSettings() {
  return defaultSettingsObject();
}

export function getPackedSettings(settings = {}) {
  const fields = [];
  const normalized = { ...settings };
  if (normalized.maxHeaderListSize == null && normalized.maxHeaderSize != null) {
    normalized.maxHeaderListSize = normalized.maxHeaderSize;
  }
  for (const [name, id] of settingsFields) {
    if (normalized[name] == null) continue;
    const value = typeof normalized[name] === "boolean" ? (normalized[name] ? 1 : 0) : Number(normalized[name]);
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`Invalid HTTP/2 setting value for ${name}`);
    fields.push([id, value]);
  }
  const out = Buffer.alloc(fields.length * 6);
  fields.forEach(([id, value], index) => {
    const offset = index * 6;
    writeUint16BE(out, offset, id);
    writeUint32BE(out, offset + 2, value);
  });
  return out;
}

export function getUnpackedSettings(buffer) {
  const bytes = Buffer.from(buffer);
  if (bytes.byteLength % 6 !== 0) throw new RangeError("Packed HTTP/2 settings length must be a multiple of 6");
  const out = {};
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
    }
  }
  return out;
}

class Http2UnavailableSession extends EventEmitter {
  constructor(name) {
    super();
    this.closed = false;
    this.destroyed = false;
    queueMicrotask(() => this.emit("error", unsupportedHttp2(name)));
  }

  close(callback = undefined) {
    if (typeof callback === "function") this.once("close", callback);
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
  }

  destroy(error = undefined) {
    this.destroyed = true;
    if (error) this.emit("error", error);
    this.emit("close");
  }

  request() {
    throw unsupportedHttp2("http2.ClientHttp2Session.request");
  }

  ref() { return this; }
  unref() { return this; }
}

class Http2UnavailableServer extends EventEmitter {
  constructor(name, options = {}, listener = undefined) {
    super();
    this.listening = false;
    this._name = name;
    this._options = options ?? {};
    if (typeof listener === "function") this.on("stream", listener);
  }

  listen(...args) {
    const callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
    if (callback) this.once("listening", callback);
    queueMicrotask(() => this.emit("error", unsupportedHttp2(`${this._name}.listen`)));
    return this;
  }

  close(callback = undefined) {
    if (callback) this.once("close", callback);
    this.listening = false;
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  address() { return null; }
  ref() { return this; }
  unref() { return this; }
}

export function connect(authority, options = undefined, listener = undefined) {
  if (typeof options === "function") {
    listener = options;
    options = undefined;
  }
  const session = new Http2UnavailableSession("http2.connect");
  session.authority = authority;
  session.options = options ?? {};
  if (typeof listener === "function") session.once("connect", listener);
  return session;
}

export function createServer(options = {}, onRequestHandler = undefined) {
  if (typeof options === "function") {
    onRequestHandler = options;
    options = {};
  }
  return new Http2UnavailableServer("http2.createServer", options, onRequestHandler);
}

export function createSecureServer(options = {}, onRequestHandler = undefined) {
  if (typeof options === "function") {
    onRequestHandler = options;
    options = {};
  }
  return new Http2UnavailableServer("http2.createSecureServer", options, onRequestHandler);
}

export function performServerHandshake() {
  throw unsupportedHttp2("http2.performServerHandshake");
}

// COTTONTAIL-COMPAT: node:http2 sessions - constants, settings packing, and HTTP/1-compatible request/response classes are implemented; exported HTTP/2 client/server/session entry points fail loudly until native nghttp2-style bindings land.

export default {
  Http2ServerRequest,
  Http2ServerResponse,
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
