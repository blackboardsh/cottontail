import { Buffer } from "./buffer.js";
import { EventEmitter } from "./events.js";
import { IncomingMessage, ServerResponse } from "./http.js";
import { connect as netConnect, createServer as createNetServer } from "./net.js";
import { connect as tlsConnect, createServer as createTlsServer } from "./tls.js";

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

const clientPreface = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
const frameTypes = { DATA: 0, HEADERS: 1, SETTINGS: 4, WINDOW_UPDATE: 8 };
const flags = { END_STREAM: 0x1, END_HEADERS: 0x4, ACK: 0x1 };
const staticTable = {
  1: [":authority", ""],
  2: [":method", "GET"],
  3: [":method", "POST"],
  4: [":path", "/"],
  5: [":path", "/index.html"],
  6: [":scheme", "http"],
  7: [":scheme", "https"],
  8: [":status", "200"],
  9: [":status", "204"],
  10: [":status", "206"],
  11: [":status", "304"],
  12: [":status", "400"],
  13: [":status", "404"],
  14: [":status", "500"],
};
const staticNameIndex = new Map(Object.entries(staticTable).map(([index, [name]]) => [name, Number(index)]));

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

function encodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x100) return Buffer.from([0x7f, length]);
  return Buffer.from([0x7f, (length >>> 8) & 0xff, length & 0xff]);
}

function decodeLength(buffer, offset) {
  const first = buffer[offset++];
  if ((first & 0x80) !== 0) throw new Error("HTTP/2 Huffman strings are not supported by Cottontail yet");
  if (first < 0x7f) return { length: first, offset };
  let value = 0;
  do {
    const byte = buffer[offset++];
    value = (value << 8) | byte;
    if (offset >= buffer.length || byte < 0x80) break;
  } while (true);
  return { length: value, offset };
}

function encodeHeaderString(value) {
  const bytes = Buffer.from(String(value));
  return Buffer.concat([encodeLength(bytes.byteLength), bytes]);
}

function decodeHeaderString(buffer, offset) {
  const decoded = decodeLength(buffer, offset);
  const end = decoded.offset + decoded.length;
  return { value: buffer.subarray(decoded.offset, end).toString(), offset: end };
}

function encodeHeaders(headers = {}) {
  const chunks = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName).toLowerCase();
    const value = String(rawValue);
    const indexed = Object.entries(staticTable).find(([, entry]) => entry[0] === name && entry[1] === value);
    if (indexed) {
      chunks.push(Buffer.from([0x80 | Number(indexed[0])]));
      continue;
    }
    const nameIndex = staticNameIndex.get(name);
    if (nameIndex != null && nameIndex < 0x40) {
      chunks.push(Buffer.from([nameIndex]));
      chunks.push(encodeHeaderString(value));
    } else {
      chunks.push(Buffer.from([0]));
      chunks.push(encodeHeaderString(name));
      chunks.push(encodeHeaderString(value));
    }
  }
  return Buffer.concat(chunks);
}

function decodeHeaders(block) {
  const headers = {};
  for (let offset = 0; offset < block.byteLength;) {
    const first = block[offset++];
    if ((first & 0x80) !== 0) {
      const entry = staticTable[first & 0x7f];
      if (entry) headers[entry[0]] = entry[1];
      continue;
    }
    if ((first & 0x40) !== 0) throw new Error("HTTP/2 indexed literal headers are not supported by this HPACK subset");
    let name;
    if (first === 0) {
      const decodedName = decodeHeaderString(block, offset);
      name = decodedName.value;
      offset = decodedName.offset;
    } else {
      const entry = staticTable[first];
      if (!entry) throw new Error("Invalid HTTP/2 static header index");
      name = entry[0];
    }
    const decodedValue = decodeHeaderString(block, offset);
    offset = decodedValue.offset;
    headers[name] = decodedValue.value;
  }
  return headers;
}

function writeFrame(socket, type, frameFlags, streamId, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(9);
  header[0] = (body.byteLength >>> 16) & 0xff;
  header[1] = (body.byteLength >>> 8) & 0xff;
  header[2] = body.byteLength & 0xff;
  header[3] = type;
  header[4] = frameFlags;
  writeUint32BE(header, 5, streamId & 0x7fffffff);
  socket.write(Buffer.concat([header, body]));
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

function authorityPort(url, fallback) {
  return Number(url.port || String(url.href).match(/^https?:\/\/[^/:]+:(\d+)/)?.[1] || fallback);
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

export class Http2Stream extends EventEmitter {
  constructor(session, id, headers = {}) {
    super();
    this.session = session;
    this.id = id;
    this.headers = headers;
    this.closed = false;
    this.destroyed = false;
  }

  respond(headers = {}, options = {}) {
    void options;
    this.session._sendHeaders(this.id, { ":status": headers[":status"] ?? headers.status ?? 200, ...headers }, false);
  }

  write(chunk) {
    this.session._sendData(this.id, chunk, false);
    return true;
  }

  end(chunk = undefined) {
    if (chunk != null) this.session._sendData(this.id, chunk, false);
    this.session._sendData(this.id, Buffer.alloc(0), true);
    this.closed = true;
    this.emit("close");
    return this;
  }

  destroy(error = undefined) {
    this.destroyed = true;
    if (error) this.emit("error", error);
    this.emit("close");
  }

  setEncoding(encoding = "utf8") {
    this._encoding = String(encoding || "utf8").toLowerCase();
    return this;
  }

  _receiveData(payload, endStream) {
    const chunk = this._encoding ? payload.toString(this._encoding) : Buffer.from(payload);
    if (payload.byteLength > 0) this.emit("data", chunk);
    if (endStream) {
      this.emit("end");
      this.emit("close");
    }
  }
}

class Http2Session extends EventEmitter {
  constructor(socket, { isServer = false } = {}) {
    super();
    this.socket = socket;
    this.isServer = isServer;
    this.closed = false;
    this.destroyed = false;
    this._buffer = Buffer.alloc(0);
    this._prefaceSeen = !isServer;
    this._nextStreamId = isServer ? 2 : 1;
    this._streams = new Map();
    this._closeScheduled = false;
    socket.on("data", (chunk) => this._receive(chunk));
    socket.on("end", () => this.close());
    socket.on("error", (error) => this.emit("error", error));
    if (!isServer) {
      socket.once(socket.encrypted ? "secureConnect" : "connect", () => {
        socket.write(clientPreface);
        this._sendSettings();
        this.emit("connect");
      });
    } else {
      this._sendSettings();
    }
  }

  _sendSettings(ack = false) {
    writeFrame(this.socket, frameTypes.SETTINGS, ack ? flags.ACK : 0, 0, Buffer.alloc(0));
  }

  _sendHeaders(streamId, headers, endStream = false) {
    writeFrame(this.socket, frameTypes.HEADERS, flags.END_HEADERS | (endStream ? flags.END_STREAM : 0), streamId, encodeHeaders(headers));
  }

  _sendData(streamId, data, endStream = false) {
    writeFrame(this.socket, frameTypes.DATA, endStream ? flags.END_STREAM : 0, streamId, Buffer.from(data ?? []));
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

  _handleFrame(frame) {
    if (frame.type === frameTypes.SETTINGS) {
      if ((frame.flags & flags.ACK) === 0) this._sendSettings(true);
      return;
    }
    if (frame.type === frameTypes.HEADERS) {
      const headers = decodeHeaders(frame.payload);
      let stream = this._streams.get(frame.streamId);
      if (!stream) {
        stream = new Http2Stream(this, frame.streamId, headers);
        this._streams.set(frame.streamId, stream);
        if (this.isServer) this.emit("stream", stream, headers);
      }
      if (!this.isServer) stream.emit("response", headers);
      if ((frame.flags & flags.END_STREAM) !== 0) stream._receiveData(Buffer.alloc(0), true);
      return;
    }
    if (frame.type === frameTypes.DATA) {
      const stream = this._streams.get(frame.streamId);
      if (stream) stream._receiveData(frame.payload, (frame.flags & flags.END_STREAM) !== 0);
    }
  }

  request(headers = {}, options = {}) {
    void options;
    const id = this._nextStreamId;
    this._nextStreamId += 2;
    const stream = new Http2Stream(this, id, headers);
    this._streams.set(id, stream);
    this._sendHeaders(id, {
      ":method": headers[":method"] ?? "GET",
      ":path": headers[":path"] ?? "/",
      ":scheme": headers[":scheme"] ?? (this.socket.encrypted ? "https" : "http"),
      ":authority": headers[":authority"] ?? "",
      ...headers,
    }, false);
    return stream;
  }

  ref() { return this; }
  unref() { return this; }

  _scheduleClose(error = undefined) {
    if (this._closeScheduled) return;
    this._closeScheduled = true;
    setTimeout(() => {
      this.socket.end?.();
      if (error) this.emit("error", error);
      this.emit("close");
    }, 0);
  }

  close(callback = undefined) {
    if (typeof callback === "function") this.once("close", callback);
    if (this.closed) return;
    this.closed = true;
    this._scheduleClose();
  }

  destroy(error = undefined) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closed = true;
    this._scheduleClose(error);
  }
}

class Http2Server extends EventEmitter {
  constructor(options = {}, listener = undefined, secure = false) {
    super();
    this.listening = false;
    this._options = options ?? {};
    this._secure = secure;
    this._server = null;
    this._sessions = new Set();
    if (typeof listener === "function") this.on("stream", listener);
  }

  listen(...args) {
    const callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
    if (callback) this.once("listening", callback);
    const connectionListener = (socket) => {
      const session = new Http2Session(socket, { isServer: true });
      this._sessions.add(session);
      session.once("close", () => this._sessions.delete(session));
      session.on("stream", (stream, headers) => this.emit("stream", stream, headers, 0));
      this.emit("session", session);
    };
    this._server = this._secure
      ? createTlsServer(this._options, connectionListener)
      : createNetServer(connectionListener);
    this._server.once("error", (error) => this.emit("error", error));
    this._server.listen(...args, () => {
      this.listening = true;
      this.emit("listening");
    });
    return this;
  }

  close(callback = undefined) {
    if (callback) this.once("close", callback);
    this.listening = false;
    for (const session of [...this._sessions]) session.destroy();
    if (this._server) this._server.close(() => this.emit("close"));
    else queueMicrotask(() => this.emit("close"));
    return this;
  }

  address() { return this._server?.address?.() ?? null; }
  ref() { return this; }
  unref() { return this; }
}

export function connect(authority, options = undefined, listener = undefined) {
  if (typeof options === "function") {
    listener = options;
    options = undefined;
  }
  const url = new URL(String(authority));
  const secure = url.protocol === "https:";
  const socket = secure
    ? tlsConnect({
      host: url.hostname,
      port: authorityPort(url, 443),
      servername: options?.servername ?? url.hostname,
      rejectUnauthorized: options?.rejectUnauthorized,
      ca: options?.ca,
    })
    : netConnect({ host: url.hostname, port: authorityPort(url, 80) });
  const session = new Http2Session(socket, { isServer: false });
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
  return new Http2Server(options, onRequestHandler, false);
}

export function createSecureServer(options = {}, onRequestHandler = undefined) {
  if (typeof options === "function") {
    onRequestHandler = options;
    options = {};
  }
  return new Http2Server(options, onRequestHandler, true);
}

export function performServerHandshake() {
  return undefined;
}

// COTTONTAIL-COMPAT: node:http2 sessions - basic socket-backed client/server sessions, SETTINGS, HEADERS, DATA, stream events, settings packing, and HTTP/1-compatible request/response classes are implemented; full HPACK/Huffman, flow control, priority, push, GOAWAY/RST_STREAM, and extended nghttp2 parity need deeper protocol work.

export default {
  Http2Stream,
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
