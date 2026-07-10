import { Buffer } from "./buffer.js";
import { EventEmitter } from "./events.js";
import { IncomingMessage, ServerResponse } from "./http.js";
import { connect as netConnect, createServer as createNetServer } from "./net.js";
import { connect as tlsConnect, createServer as createTlsServer } from "./tls.js";

export class Http2ServerRequest extends IncomingMessage {}
export class Http2ServerResponse extends ServerResponse {}

export const sensitiveHeaders = Symbol("sensitiveHeaders");

export const constants = {
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
};
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

function normalizeCode(code, fallback = constants.NGHTTP2_NO_ERROR) {
  const value = Number(code ?? fallback);
  return Number.isFinite(value) ? (value >>> 0) : fallback;
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
    this.rstCode = constants.NGHTTP2_NO_ERROR;
    this.closeCode = constants.NGHTTP2_NO_ERROR;
    this.sentHeaders = false;
    this.sentTrailers = false;
    this.state = {
      state: 0,
      weight: constants.NGHTTP2_DEFAULT_WEIGHT,
      sumDependencyWeight: 0,
      localClose: 0,
      remoteClose: 0,
      localWindowSize: 65535,
    };
  }

  respond(headers = {}, options = {}) {
    void options;
    this.session._sendHeaders(this.id, { ":status": headers[":status"] ?? headers.status ?? 200, ...headers }, false);
    this.sentHeaders = true;
    return this;
  }

  write(chunk) {
    this.session._sendData(this.id, chunk, false);
    return true;
  }

  end(chunk = undefined) {
    if (chunk != null) this.session._sendData(this.id, chunk, false);
    this.session._sendData(this.id, Buffer.alloc(0), true);
    this.closed = true;
    this.closeCode = constants.NGHTTP2_NO_ERROR;
    this.state.localClose = 1;
    this.emit("close");
    return this;
  }

  destroy(error = undefined) {
    this.destroyed = true;
    if (error) this.emit("error", error);
    this.close(constants.NGHTTP2_CANCEL);
    return this;
  }

  close(code = constants.NGHTTP2_NO_ERROR, callback = undefined) {
    if (typeof callback === "function") this.once("close", callback);
    if (this.closed) return this;
    const closeCode = normalizeCode(code);
    this.closed = true;
    this.destroyed = true;
    this.rstCode = closeCode;
    this.closeCode = closeCode;
    this.state.localClose = 1;
    this.session._streams.delete(this.id);
    this.session._sendRstStream(this.id, closeCode);
    this.emit("close");
    return this;
  }

  priority(options = {}, callback = undefined) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const weight = Math.max(1, Math.min(256, Number(options?.weight ?? constants.NGHTTP2_DEFAULT_WEIGHT)));
    const parent = normalizeStreamId(options?.parent ?? options?.streamDependency ?? 0);
    const exclusive = options?.exclusive === true;
    this.state.weight = weight;
    this.state.sumDependencyWeight = weight;
    this.session._sendPriority(this.id, { parent, weight, exclusive });
    if (typeof callback === "function") queueMicrotask(callback);
    return this;
  }

  pushStream(headers = {}, callback = undefined) {
    if (!this.session.isServer) {
      const error = new Error("HTTP/2 push streams can only be created by a server session");
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      else throw error;
      return undefined;
    }
    const promisedId = this.session._nextStreamId;
    this.session._nextStreamId += 2;
    const stream = new Http2Stream(this.session, promisedId, headers);
    this.session._streams.set(promisedId, stream);
    this.session._sendPushPromise(this.id, promisedId, headers);
    if (typeof callback === "function") queueMicrotask(() => callback(null, stream, headers));
    return stream;
  }

  setEncoding(encoding = "utf8") {
    this._encoding = String(encoding || "utf8").toLowerCase();
    return this;
  }

  _receiveData(payload, endStream) {
    const chunk = this._encoding ? payload.toString(this._encoding) : Buffer.from(payload);
    if (payload.byteLength > 0) this.emit("data", chunk);
    if (endStream) {
      this.state.remoteClose = 1;
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
    this.localSettings = defaultSettingsObject();
    this.remoteSettings = defaultSettingsObject();
    this._pendingSettingsCallbacks = [];
    this._pendingPings = new Map();
    this.localWindowSize = this.localSettings.initialWindowSize;
    this.remoteWindowSize = this.remoteSettings.initialWindowSize;
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
      inflateDynamicTableSize: this.remoteSettings.headerTableSize,
    };
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

  _sendSettings(settings = undefined, ack = false) {
    const payload = ack ? Buffer.alloc(0) : getPackedSettings(settings ?? {});
    if (!ack && payload.byteLength > 0) {
      this.localSettings = { ...this.localSettings, ...getUnpackedSettings(payload) };
      this.localWindowSize = this.localSettings.initialWindowSize;
      this.state.localWindowSize = this.localWindowSize;
      this.state.effectiveLocalWindowSize = this.localWindowSize;
    }
    writeFrame(this.socket, frameTypes.SETTINGS, ack ? flags.ACK : 0, 0, payload);
  }

  _sendHeaders(streamId, headers, endStream = false) {
    writeFrame(this.socket, frameTypes.HEADERS, flags.END_HEADERS | (endStream ? flags.END_STREAM : 0), streamId, encodeHeaders(headers));
  }

  _sendData(streamId, data, endStream = false) {
    writeFrame(this.socket, frameTypes.DATA, endStream ? flags.END_STREAM : 0, streamId, Buffer.from(data ?? []));
  }

  _sendRstStream(streamId, code = constants.NGHTTP2_NO_ERROR) {
    const payload = Buffer.alloc(4);
    writeUint32BE(payload, 0, normalizeCode(code));
    writeFrame(this.socket, frameTypes.RST_STREAM, 0, normalizeStreamId(streamId), payload);
  }

  _sendPriority(streamId, { parent = 0, weight = constants.NGHTTP2_DEFAULT_WEIGHT, exclusive = false } = {}) {
    const payload = Buffer.alloc(5);
    writeUint32BE(payload, 0, normalizeStreamId(parent) | (exclusive ? 0x80000000 : 0));
    payload[4] = Math.max(0, Math.min(255, Number(weight) - 1));
    writeFrame(this.socket, frameTypes.PRIORITY, 0, normalizeStreamId(streamId), payload);
  }

  _sendPushPromise(streamId, promisedId, headers = {}) {
    const headerBlock = encodeHeaders(headers);
    const payload = Buffer.alloc(4 + headerBlock.byteLength);
    writeUint32BE(payload, 0, normalizeStreamId(promisedId));
    payload.set(headerBlock, 4);
    writeFrame(this.socket, frameTypes.PUSH_PROMISE, flags.END_HEADERS, normalizeStreamId(streamId), payload);
  }

  _sendWindowUpdate(streamId, increment) {
    const amount = Number(increment);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 0x7fffffff) {
      throw new RangeError("HTTP/2 window update increment must be between 1 and 2147483647");
    }
    const payload = Buffer.alloc(4);
    writeUint32BE(payload, 0, amount & 0x7fffffff);
    writeFrame(this.socket, frameTypes.WINDOW_UPDATE, 0, normalizeStreamId(streamId), payload);
  }

  _sendGoaway(code = constants.NGHTTP2_NO_ERROR, lastStreamID = 0, opaqueData = undefined) {
    const opaque = opaqueData == null ? Buffer.alloc(0) : Buffer.from(opaqueData);
    const payload = Buffer.alloc(8 + opaque.byteLength);
    writeUint32BE(payload, 0, normalizeStreamId(lastStreamID));
    writeUint32BE(payload, 4, normalizeCode(code));
    payload.set(opaque, 8);
    writeFrame(this.socket, frameTypes.GOAWAY, 0, 0, payload);
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
      if ((frame.flags & flags.ACK) !== 0) {
        const callback = this._pendingSettingsCallbacks.shift();
        if (typeof callback === "function") queueMicrotask(() => callback(null, this.localSettings));
        this.emit("localSettings", this.localSettings);
      } else {
        const settings = getUnpackedSettings(frame.payload);
        this.remoteSettings = { ...this.remoteSettings, ...settings };
        this.remoteWindowSize = this.remoteSettings.initialWindowSize;
        this.state.remoteWindowSize = this.remoteWindowSize;
        this.state.inflateDynamicTableSize = this.remoteSettings.headerTableSize;
        this.emit("remoteSettings", this.remoteSettings);
        this._sendSettings(undefined, true);
      }
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
      if (stream) {
        stream.state.localWindowSize = Math.max(0, stream.state.localWindowSize - frame.payload.byteLength);
        this.state.effectiveRecvDataLength += frame.payload.byteLength;
        stream._receiveData(frame.payload, (frame.flags & flags.END_STREAM) !== 0);
      }
      return;
    }
    if (frame.type === frameTypes.RST_STREAM) {
      if (frame.payload.byteLength < 4) return;
      const stream = this._streams.get(frame.streamId);
      if (!stream) return;
      const code = readUint32BE(frame.payload, 0);
      stream.rstCode = code;
      stream.closeCode = code;
      stream.closed = true;
      stream.destroyed = true;
      stream.state.remoteClose = 1;
      this._streams.delete(frame.streamId);
      if (code !== constants.NGHTTP2_NO_ERROR) stream.emit("aborted");
      stream.emit("close");
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
      const headers = decodeHeaders(frame.payload.subarray(4));
      const stream = new Http2Stream(this, promisedId, headers);
      this._streams.set(promisedId, stream);
      this.emit("stream", stream, headers, frame.streamId);
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
      } else {
        this.emit("ping", payload);
        writeFrame(this.socket, frameTypes.PING, flags.ACK, 0, payload);
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
      return;
    }
    if (frame.type === frameTypes.WINDOW_UPDATE) {
      if (frame.payload.byteLength < 4) return;
      const increment = readUint32BE(frame.payload, 0) & 0x7fffffff;
      if (frame.streamId === 0) {
        this.remoteWindowSize += increment;
        this.state.remoteWindowSize = this.remoteWindowSize;
        this.emit("windowUpdate", increment);
      } else {
        const stream = this._streams.get(frame.streamId);
        if (stream) {
          stream.state.localWindowSize += increment;
          stream.emit("windowUpdate", increment);
        }
      }
    }
  }

  request(headers = {}, options = {}) {
    void options;
    const id = this._nextStreamId;
    this._nextStreamId += 2;
    this.state.nextStreamID = this._nextStreamId;
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

  settings(settings = {}, callback = undefined) {
    if (typeof settings === "function") {
      callback = settings;
      settings = {};
    }
    if (typeof callback === "function") this._pendingSettingsCallbacks.push(callback);
    this._sendSettings(settings ?? {}, false);
    return this;
  }

  ping(payload = undefined, callback = undefined) {
    if (typeof payload === "function") {
      callback = payload;
      payload = undefined;
    }
    const body = eightBytePayload(payload);
    if (typeof callback === "function") {
      this._pendingPings.set(body.toString("hex"), { callback, start: Date.now() });
    }
    writeFrame(this.socket, frameTypes.PING, 0, 0, body);
    return true;
  }

  goaway(code = constants.NGHTTP2_NO_ERROR, lastStreamID = 0, opaqueData = undefined) {
    this._sendGoaway(code, lastStreamID, opaqueData);
    this.goawayCode = normalizeCode(code);
    return this;
  }

  setLocalWindowSize(windowSize) {
    const size = Number(windowSize);
    if (!Number.isInteger(size) || size < 0 || size > 0x7fffffff) {
      throw new RangeError("HTTP/2 local window size must be between 0 and 2147483647");
    }
    const increment = size - this.localWindowSize;
    this.localWindowSize = size;
    this.state.localWindowSize = size;
    this.state.effectiveLocalWindowSize = size;
    if (increment > 0) this._sendWindowUpdate(0, increment);
    return this;
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

// COTTONTAIL-COMPAT: node:http2 sessions - socket-backed client/server sessions, SETTINGS/ACK callbacks, HEADERS, DATA, PING, GOAWAY, RST_STREAM, PRIORITY, PUSH_PROMISE, WINDOW_UPDATE, stream events, settings packing, and HTTP/1-compatible request/response classes are implemented; full HPACK/Huffman dynamic tables, enforced flow-control backpressure, trailers, ALTSVC/ORIGIN, and extended nghttp2 parity need deeper protocol work.

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
