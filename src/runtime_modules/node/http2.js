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
  HTTP2_HEADER_AUTHORITY: ":authority",
  HTTP2_HEADER_METHOD: ":method",
  HTTP2_HEADER_PATH: ":path",
  HTTP2_HEADER_SCHEME: ":scheme",
  HTTP2_HEADER_STATUS: ":status",
  HTTP2_HEADER_CONTENT_TYPE: "content-type",
  HTTP2_HEADER_CONTENT_LENGTH: "content-length",
  HTTP2_HEADER_CONTENT_ENCODING: "content-encoding",
  HTTP2_HEADER_ACCEPT: "accept",
  HTTP2_HEADER_ACCEPT_ENCODING: "accept-encoding",
  HTTP2_HEADER_TE: "te",
  HTTP2_HEADER_USER_AGENT: "user-agent",
  HTTP2_HEADER_COOKIE: "cookie",
  HTTP2_HEADER_SET_COOKIE: "set-cookie",
  HTTP2_HEADER_DATE: "date",
  HTTP2_HEADER_LOCATION: "location",
  HTTP2_HEADER_HOST: "host",
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
  CONTINUATION: 9,
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
  const fullKey = `${name} ${value}`;
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
        list.push([name, decodedValue.value]);
      }
    }
    return list;
  }
}

function headersToList(headers = {}) {
  const pseudo = [];
  const regular = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue == null) continue;
    const name = String(rawName).toLowerCase();
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const target = name.startsWith(":") ? pseudo : regular;
    for (const value of values) {
      if (value == null) continue;
      target.push([name, String(value)]);
    }
  }
  return pseudo.concat(regular);
}

// Stateless HPACK encoding: full static matches use the indexed form, all other
// headers are emitted as literals without indexing so no shared encoder state
// is required for interoperability.
function encodeHeaderList(list) {
  const out = [];
  for (const [name, value] of list) {
    const fullIndex = hpackStaticFullIndex.get(`${name} ${value}`);
    if (fullIndex != null) {
      hpackEncodeInt(fullIndex, 7, 0x80, out);
      continue;
    }
    const nameIndex = hpackStaticNameIndex.get(name) ?? 0;
    hpackEncodeInt(nameIndex, 4, 0x00, out);
    if (nameIndex === 0) hpackEncodeString(name, out);
    hpackEncodeString(value, out);
  }
  return Buffer.from(out);
}

function encodeHeaders(headers = {}) {
  return encodeHeaderList(headersToList(headers));
}

function headerListToObject(list) {
  const headers = {};
  for (const [name, value] of list) {
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
    enablePush: true,
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

// ---------------------------------------------------------------------------
// Streams and sessions
// ---------------------------------------------------------------------------

export class Http2Stream extends EventEmitter {
  constructor(session, id, headers = {}) {
    super();
    this.session = session;
    this.id = id;
    this.headers = headers;
    this.closed = false;
    this.destroyed = false;
    this.aborted = false;
    this.rstCode = constants.NGHTTP2_NO_ERROR;
    this.closeCode = constants.NGHTTP2_NO_ERROR;
    this.sentHeaders = false;
    this.sentTrailers = false;
    this.pending = false;
    this._encoding = null;
    this._paused = false;
    this._recvQueue = [];
    this._endStreamSent = false;
    this._endStreamReceived = false;
    this._responseEmitted = false;
    this.state = {
      state: 0,
      weight: constants.NGHTTP2_DEFAULT_WEIGHT,
      sumDependencyWeight: 0,
      localClose: 0,
      remoteClose: 0,
      localWindowSize: 65535,
    };
  }

  get writableEnded() { return this._endStreamSent; }
  get readableEnded() { return this._endStreamReceived; }

  respond(headers = {}, options = {}) {
    const endStream = options?.endStream === true;
    this.session._sendHeaders(this.id, { ":status": headers[":status"] ?? headers.status ?? 200, ...headers }, endStream);
    this.sentHeaders = true;
    if (endStream) {
      this._endStreamSent = true;
      this.state.localClose = 1;
      this._maybeClose();
    }
    return this;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this._endStreamSent || this.destroyed) {
      const error = new Error("write after end");
      error.code = "ERR_STREAM_WRITE_AFTER_END";
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      else this.emit("error", error);
      return false;
    }
    this.session._sendData(this.id, toChunkBuffer(chunk, encoding), false, callback);
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
    if (this._endStreamSent) {
      if (typeof callback === "function") queueMicrotask(callback);
      return this;
    }
    this._endStreamSent = true;
    this.state.localClose = 1;
    this.session._sendData(this.id, toChunkBuffer(chunk, encoding), true, callback);
    this.emit("finish");
    this._maybeClose();
    return this;
  }

  pause() {
    this._paused = true;
    return this;
  }

  resume() {
    this._paused = false;
    this._drainRecvQueue();
    return this;
  }

  destroy(error = undefined) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (error) this.emit("error", error);
    if (!this.closed) this.close(constants.NGHTTP2_CANCEL);
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

  setTimeout(msecs = 0, callback = undefined) {
    this.timeout = msecs;
    if (typeof callback === "function") this.once("timeout", callback);
    return this;
  }

  sendTrailers(headers = {}) {
    this.sentTrailers = true;
    this.session._sendHeaders(this.id, headers, true);
    this._endStreamSent = true;
    this.state.localClose = 1;
    this._maybeClose();
    return this;
  }

  _receiveData(payload, endStream) {
    this._recvQueue.push({ payload: Buffer.from(payload), endStream });
    this._drainRecvQueue();
  }

  _drainRecvQueue() {
    while (!this._paused && this._recvQueue.length > 0) {
      const { payload, endStream } = this._recvQueue.shift();
      if (payload.byteLength > 0) {
        this.emit("data", this._encoding ? payload.toString(this._encoding) : payload);
      }
      if (endStream) {
        this._endStreamReceived = true;
        this.state.remoteClose = 1;
        this.emit("end");
        this._maybeClose();
      }
    }
  }

  _maybeClose() {
    if (this.closed || !this._endStreamSent || !this._endStreamReceived) return;
    this.closed = true;
    this.session._streams.delete(this.id);
    this.emit("close");
  }
}

class Http2Session extends EventEmitter {
  constructor(socket, { isServer = false, settings = undefined } = {}) {
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
    this._closeEmitted = false;
    this._pendingHeaderBlock = null;
    this._hpackDecoder = new HpackDecoder();
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
    socket.on("close", () => this._emitClose());
    socket.on("error", (error) => this.emit("error", error));
    // The connection preface and initial SETTINGS frame are written
    // immediately; net/tls sockets buffer pre-connect writes in order, which
    // guarantees the preface precedes any frames queued by early request()
    // calls made before the socket finishes connecting.
    if (!isServer) socket.write(clientPreface);
    this._sendSettings(settings ?? {});
    if (!isServer) {
      const connectedEvent = socket.encrypted ? "secureConnect" : "connect";
      if (socket.connecting) {
        socket.once(connectedEvent, () => this.emit("connect", this, socket));
      } else {
        queueMicrotask(() => this.emit("connect", this, socket));
      }
    }
  }

  get encrypted() { return this.socket?.encrypted === true; }
  get alpnProtocol() { return this.socket?.alpnProtocol; }
  get pendingSettingsAck() { return this._pendingSettingsCallbacks.length > 0; }

  _writeFrame(type, frameFlags, streamId, payload = Buffer.alloc(0), callback = undefined) {
    const buffer = frameBuffer(type, frameFlags, streamId, payload);
    try {
      this.socket.write(buffer);
      if (typeof callback === "function") queueMicrotask(callback);
    } catch (error) {
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      else this.emit("error", error);
    }
  }

  get _maxSendFrameSize() {
    const size = Number(this.remoteSettings?.maxFrameSize);
    return Number.isInteger(size) && size >= DEFAULT_MAX_FRAME_SIZE ? size : DEFAULT_MAX_FRAME_SIZE;
  }

  _sendSettings(settings = undefined, ack = false) {
    const payload = ack ? Buffer.alloc(0) : getPackedSettings(settings ?? {});
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
    const max = this._maxSendFrameSize;
    if (body.byteLength <= max) {
      this._writeFrame(frameTypes.DATA, endStream ? flags.END_STREAM : 0, streamId, body, callback);
      return;
    }
    // Split payloads larger than the peer's SETTINGS_MAX_FRAME_SIZE.
    let offset = 0;
    while (offset < body.byteLength) {
      const chunk = body.subarray(offset, offset + max);
      offset += chunk.byteLength;
      const last = offset >= body.byteLength;
      this._writeFrame(
        frameTypes.DATA,
        last && endStream ? flags.END_STREAM : 0,
        streamId,
        chunk,
        last ? callback : undefined,
      );
    }
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
    const payload = Buffer.alloc(4 + headerBlock.byteLength);
    writeUint32BE(payload, 0, normalizeStreamId(promisedId));
    payload.set(headerBlock, 4);
    this._writeFrame(frameTypes.PUSH_PROMISE, flags.END_HEADERS, normalizeStreamId(streamId), payload);
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
    const rawHeaders = list.flat();
    let stream = this._streams.get(streamId);
    if (this.isServer) {
      if (!stream) {
        stream = new Http2Stream(this, streamId, headers);
        this._streams.set(streamId, stream);
        this.state.lastProcStreamID = streamId;
        this.emit("stream", stream, headers, frameFlags, rawHeaders);
      } else {
        stream.emit("trailers", headers, frameFlags);
      }
    } else {
      if (!stream) return;
      if (!stream._responseEmitted) {
        stream._responseEmitted = true;
        stream.emit("response", headers, frameFlags);
      } else {
        stream.emit("trailers", headers, frameFlags);
      }
    }
    if (endStream && stream) stream._receiveData(Buffer.alloc(0), true);
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
        this._sendSettings(undefined, true);
        this.emit("remoteSettings", this.remoteSettings);
      }
      return;
    }
    if (frame.type === frameTypes.HEADERS) {
      let payload = frame.payload;
      let offset = 0;
      if ((frame.flags & flags.PADDED) !== 0 && payload.byteLength > 0) {
        const padLength = payload[0];
        offset += 1;
        payload = payload.subarray(0, Math.max(offset, payload.byteLength - padLength));
      }
      if ((frame.flags & flags.PRIORITY) !== 0) offset += 5;
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
        this._dispatchHeaders(pending.streamId, Buffer.concat(pending.chunks), pending.endStream, pending.flags);
      }
      return;
    }
    if (frame.type === frameTypes.DATA) {
      let payload = frame.payload;
      if ((frame.flags & flags.PADDED) !== 0 && payload.byteLength > 0) {
        const padLength = payload[0];
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
      stream.rstCode = code;
      stream.closeCode = code;
      stream.closed = true;
      stream.destroyed = true;
      stream.state.remoteClose = 1;
      this._streams.delete(frame.streamId);
      if (code !== constants.NGHTTP2_NO_ERROR) {
        stream.aborted = true;
        stream.emit("aborted");
      }
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
      let headers;
      try {
        headers = headerListToObject(this._hpackDecoder.decode(frame.payload.subarray(4)));
      } catch (error) {
        this.destroy(error);
        return;
      }
      const stream = new Http2Stream(this, promisedId, headers);
      this._streams.set(promisedId, stream);
      this.emit("stream", stream, headers, frame.flags, []);
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
    const id = this._nextStreamId;
    this._nextStreamId += 2;
    this.state.nextStreamID = this._nextStreamId;
    const stream = new Http2Stream(this, id, headers);
    this._streams.set(id, stream);
    const endStream = options?.endStream === true;
    this._sendHeaders(id, {
      ":method": headers[":method"] ?? "GET",
      ":path": headers[":path"] ?? "/",
      ":scheme": headers[":scheme"] ?? (this.socket.encrypted ? "https" : "http"),
      ":authority": headers[":authority"] ?? this._defaultAuthority ?? "",
      ...headers,
    }, endStream);
    if (endStream) {
      stream._endStreamSent = true;
      stream.state.localClose = 1;
    }
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
    this._writeFrame(frameTypes.PING, 0, 0, body);
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

  setTimeout(msecs = 0, callback = undefined) {
    if (typeof callback === "function") this.once("timeout", callback);
    this.socket?.setTimeout?.(msecs);
    return this;
  }

  ref() {
    this.socket?.ref?.();
    return this;
  }

  unref() {
    this.socket?.unref?.();
    return this;
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.closed = true;
    this.emit("close");
  }

  _scheduleClose(error = undefined) {
    if (this._closeScheduled) return;
    this._closeScheduled = true;
    setTimeout(() => {
      try { this.socket.end?.(); } catch {}
      if (error) this.emit("error", error);
      this._emitClose();
    }, 0);
  }

  close(callback = undefined) {
    if (typeof callback === "function") {
      if (this._closeEmitted) queueMicrotask(callback);
      else this.once("close", callback);
    }
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
    this.timeout = 0;
    this._options = options ?? {};
    this._secure = secure;
    this._server = null;
    this._sessions = new Set();
    if (typeof listener === "function") this.on("stream", listener);
  }

  setTimeout(msecs = 0, callback = undefined) {
    this.timeout = msecs;
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

  listen(...args) {
    const callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
    if (callback) this.once("listening", callback);
    const connectionListener = (socket) => {
      const session = new Http2Session(socket, { isServer: true, settings: this._options.settings });
      this._sessions.add(session);
      session.once("close", () => this._sessions.delete(session));
      session.on("stream", (stream, headers, streamFlags, rawHeaders) =>
        this.emit("stream", stream, headers, streamFlags, rawHeaders));
      session.on("error", () => {});
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
    if (this._server) {
      this._server.once("close", () => this.emit("close"));
      this._server.close();
    } else {
      queueMicrotask(() => this.emit("close"));
    }
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
  options = options ?? {};
  const url = new URL(String(authority));
  const secure = url.protocol === "https:";
  const host = options.host ?? url.hostname;
  const port = Number(options.port ?? authorityPort(url, secure ? 443 : 80));
  let socket;
  if (typeof options.createConnection === "function") {
    socket = options.createConnection(url, options);
  } else if (secure) {
    // grpc-js style callers provide a SecureContext rather than raw ca/cert
    // options; recover the captured CA bundle so verification can succeed.
    const contextOptions = options.secureContext?.context ?? {};
    socket = tlsConnect({
      host,
      port,
      servername: options.servername ?? url.hostname,
      rejectUnauthorized: options.rejectUnauthorized,
      ca: options.ca ?? contextOptions.ca,
      ALPNProtocols: options.ALPNProtocols ?? ["h2"],
    });
  } else {
    socket = netConnect({ host, port });
  }
  const session = new Http2Session(socket, { isServer: false, settings: options.settings });
  session.authority = authority;
  session.options = options;
  session._defaultAuthority = url.host || `${host}:${port}`;
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

// COTTONTAIL-COMPAT: node:http2 sessions - socket-backed client/server sessions with RFC 7541 HPACK (full static table, dynamic table, Huffman decoding, proper integer coding), SETTINGS negotiation (including custom client/server settings options), DATA frame splitting at the peer's SETTINGS_MAX_FRAME_SIZE, HEADERS+CONTINUATION reassembly and splitting, padding handling, automatic WINDOW_UPDATE replenishment, write/end callbacks with encodings, server setTimeout, PING, GOAWAY, RST_STREAM, PRIORITY, PUSH_PROMISE, and stream pause/resume are implemented; outbound flow-control enforcement, Huffman encoding, trailers via waitForTrailers, ALTSVC/ORIGIN, and HTTP/1-compat request/response bridging need deeper protocol work. TLS ALPN negotiation ("h2") requires native support in ct_tls_client_connect and is passed through but currently unavailable.

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
