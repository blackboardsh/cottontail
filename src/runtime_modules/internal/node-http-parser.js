import { Buffer } from "../node/buffer.js";

// Portable port of Bun's llhttp-backed process.binding("http_parser") surface.
// Keep the state transitions aligned with llhttp so this can later become a
// thin adapter around the vendored C parser without changing the JS contract.

export const methods = [
  "DELETE", "GET", "HEAD", "POST", "PUT", "CONNECT", "OPTIONS", "TRACE",
  "COPY", "LOCK", "MKCOL", "MOVE", "PROPFIND", "PROPPATCH", "SEARCH",
  "UNLOCK", "BIND", "REBIND", "UNBIND", "ACL", "REPORT", "MKACTIVITY",
  "CHECKOUT", "MERGE", "M - SEARCH", "NOTIFY", "SUBSCRIBE", "UNSUBSCRIBE",
  "PATCH", "PURGE", "MKCALENDAR", "LINK", "UNLINK", "SOURCE", "QUERY",
];

export const allMethods = [
  "DELETE", "GET", "HEAD", "POST", "PUT", "CONNECT", "OPTIONS", "TRACE",
  "COPY", "LOCK", "MKCOL", "MOVE", "PROPFIND", "PROPPATCH", "SEARCH",
  "UNLOCK", "BIND", "REBIND", "UNBIND", "ACL", "REPORT", "MKACTIVITY",
  "CHECKOUT", "MERGE", "M - SEARCH", "NOTIFY", "SUBSCRIBE", "UNSUBSCRIBE",
  "PATCH", "PURGE", "MKCALENDAR", "LINK", "UNLINK", "SOURCE", "PRI",
  "DESCRIBE", "ANNOUNCE", "SETUP", "PLAY", "PAUSE", "TEARDOWN",
  "GET_PARAMETER", "SET_PARAMETER", "REDIRECT", "RECORD", "FLUSH", "QUERY",
];

const HTTP_BOTH = 0;
const HTTP_REQUEST = 1;
const HTTP_RESPONSE = 2;

const kOnMessageBegin = 0;
const kOnHeaders = 1;
const kOnHeadersComplete = 2;
const kOnBody = 3;
const kOnMessageComplete = 4;
const kOnExecute = 5;
const kOnTimeout = 6;

const kLenientNone = 0;
const kLenientHeaders = 1 << 0;
const kLenientChunkedLength = 1 << 1;
const kLenientKeepAlive = 1 << 2;
const kLenientTransferEncoding = 1 << 3;
const kLenientVersion = 1 << 4;
const kLenientDataAfterClose = 1 << 5;
const kLenientOptionalLFAfterCR = 1 << 6;
const kLenientOptionalCRLFAfterChunk = 1 << 7;
const kLenientOptionalCRBeforeLF = 1 << 8;
const kLenientSpacesAfterChunkSize = 1 << 9;
const kLenientAll = (1 << 10) - 1;

const DEFAULT_MAX_HEADER_SIZE = 16 * 1024;
const MAX_BUFFERED_HEADER_FIELDS = 32;
const MAX_CHUNK_EXTENSIONS_SIZE = 16 * 1024;
const EMPTY_BUFFER = Buffer.alloc(0);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DECIMAL = /^[0-9]+$/;
const HEX = /^[0-9A-Fa-f]+$/;
const METHOD_ENUM = new Map(allMethods.map((name, index) => [name, index]));
METHOD_ENUM.set("M-SEARCH", 24);
const parserStates = new WeakMap();
const connectionsListStates = new WeakMap();

function nowMilliseconds() {
  if (typeof globalThis.cottontail?.nanotime === "function") {
    return Number(globalThis.cottontail.nanotime()) / 1e6;
  }
  if (typeof globalThis.performance?.now === "function") return globalThis.performance.now();
  return Date.now();
}

function copyBuffer(value) {
  if (!value || value.byteLength === 0) return Buffer.alloc(0);
  return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

function concatBuffers(left, right) {
  if (left.length === 0) return copyBuffer(right);
  if (right.length === 0) return left;
  const result = Buffer.alloc(left.length + right.length);
  result.set(left, 0);
  result.set(right, left.length);
  return result;
}

function latin1(bytes) {
  let result = "";
  const chunkSize = 4096;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    let chunk = "";
    for (let index = offset; index < end; index += 1) chunk += String.fromCharCode(bytes[index]);
    result += chunk;
  }
  return result;
}

function findLineEnd(bytes) {
  for (let index = 0; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) return index;
  }
  return -1;
}

function toUint32(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.trunc(number) >>> 0;
}

function parserError(code, reason, bytesParsed = 0) {
  const error = new Error("Parse Error");
  error.code = code;
  error.reason = reason;
  error.bytesParsed = Math.max(0, Math.trunc(Number(bytesParsed) || 0));
  return error;
}

function pausedError() {
  return parserError("HPE_PAUSED", "Paused", 0);
}

function normalizeInput(value) {
  if (!ArrayBuffer.isView(value)) return null;
  return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

function requireParser(value, method) {
  const parser = parserStates.get(value);
  if (!parser) {
    throw new TypeError(`HTTPParser.prototype.${method} called on incompatible receiver`);
  }
  return parser;
}

function splitTokens(value) {
  return String(value)
    .split(",")
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
}

function isNoBodyResponse(statusCode) {
  return (statusCode >= 100 && statusCode < 200) || statusCode === 204 || statusCode === 304;
}

function shouldKeepAlive(parser, framed) {
  const connection = splitTokens(parser._connectionValue);
  if (connection.includes("close")) return false;
  if (parser._versionMajor > 1 || (parser._versionMajor === 1 && parser._versionMinor >= 1)) {
    return framed || Boolean(parser._upgrade);
  }
  return connection.includes("keep-alive") && (framed || Boolean(parser._upgrade));
}

function HTTPParser() {
  if (!new.target) return undefined;
  parserStates.set(this, new HTTPParserState(this));
}

function HTTPParserState(owner) {
  this.owner = owner;
  this._closed = false;
  this._initialized = false;
  this._type = HTTP_BOTH;
  this._maxHeaderSize = DEFAULT_MAX_HEADER_SIZE;
  this._lenientFlags = kLenientNone;
  this._connectionsList = null;
  this._currentBuffer = EMPTY_BUFFER;
  this._pending = EMPTY_BUFFER;
  this._latchedError = null;
  this._paused = false;
  this._consumed = null;
  this._lastMessageStart = 0;
  this._headersCompleted = false;
  this._state = "start-line";
  this._resetMessageFields();
}

HTTPParserState.prototype._resetMessageFields = function _resetMessageFields() {
  this._messageStarted = false;
  this._headerBytes = 0;
  this._headers = [];
  this._haveFlushed = false;
  this._url = "";
  this._method = undefined;
  this._statusCode = undefined;
  this._statusMessage = "";
  this._versionMajor = 0;
  this._versionMinor = 0;
  this._contentLength = null;
  this._transferEncodingValue = "";
  this._connectionValue = "";
  this._upgradeValue = "";
  this._upgrade = false;
  this._bodyRemaining = 0;
  this._chunkRemaining = 0;
};

HTTPParserState.prototype._shift = function _shift(length) {
  if (length <= 0) return EMPTY_BUFFER;
  const result = this._pending.subarray(0, length);
  this._pending = this._pending.subarray(length);
  this._shifted += length;
  return result;
};

HTTPParserState.prototype._bytesParsed = function _bytesParsed() {
  return Math.min(this._inputLength, Math.max(0, this._shifted - this._pendingBeforeExecute));
};

HTTPParserState.prototype._fail = function _fail(code, reason) {
  const error = parserError(code, reason, this._bytesParsed());
  this._latchedError = error;
  return error;
};

HTTPParserState.prototype._beginMessage = function _beginMessage() {
  this._messageStarted = true;
  this._headersCompleted = false;
  this._headerBytes = 0;
  this._headers = [];
  this._haveFlushed = false;
  this._url = "";
  this._contentLength = null;
  this._transferEncodingValue = "";
  this._connectionValue = "";
  this._upgradeValue = "";
  this._lastMessageStart = nowMilliseconds();
  activateConnection(this._connectionsList, this.owner);
  const callback = this.owner[kOnMessageBegin];
  if (typeof callback === "function") callback.call(this.owner);
};

HTTPParserState.prototype._parseStartLine = function _parseStartLine(line) {
  let type = this._type;
  if (type === HTTP_BOTH) type = line.startsWith("HTTP/") ? HTTP_RESPONSE : HTTP_REQUEST;

  if (type === HTTP_REQUEST) {
    const match = /^([^ ]+) ([^ ]+) HTTP\/([0-9]+)\.([0-9]+)$/.exec(line);
    if (!match) {
      if (!line.includes(" ")) return this._fail("HPE_INVALID_METHOD", "Invalid method encountered");
      if (!line.includes("HTTP/")) return this._fail("HPE_INVALID_CONSTANT", "Expected HTTP/");
      return this._fail("HPE_INVALID_URL", "Invalid URL");
    }
    const method = METHOD_ENUM.get(match[1]);
    if (method === undefined) return this._fail("HPE_INVALID_METHOD", "Invalid method encountered");
    if (/[^\x21-\x7e]/.test(match[2])) return this._fail("HPE_INVALID_URL", "Invalid URL");
    this._method = method;
    this._url = match[2];
    this._versionMajor = Number(match[3]);
    this._versionMinor = Number(match[4]);
    this._versionMajorText = match[3];
    this._versionMinorText = match[4];
  } else if (type === HTTP_RESPONSE) {
    const match = /^HTTP\/([0-9]+)\.([0-9]+) ([0-9]{3})(?: (.*))?$/.exec(line);
    if (!match) {
      if (!line.startsWith("HTTP/")) return this._fail("HPE_INVALID_CONSTANT", "Expected HTTP/");
      return this._fail("HPE_INVALID_STATUS", "Invalid response status");
    }
    this._versionMajor = Number(match[1]);
    this._versionMinor = Number(match[2]);
    this._statusCode = Number(match[3]);
    this._statusMessage = match[4] ?? "";
    this._versionMajorText = match[1];
    this._versionMinorText = match[2];
    if (/[^\t\x20-\x7e\x80-\xff]/.test(this._statusMessage)) {
      return this._fail("HPE_INVALID_STATUS", "Invalid response status");
    }
  } else {
    return this._fail("HPE_INVALID_INTERNAL_STATE", "Invalid parser type");
  }

  if (!(this._lenientFlags & kLenientVersion)) {
    if (this._versionMajorText.length !== 1 || this._versionMinorText.length !== 1) {
      return this._fail("HPE_INVALID_VERSION", "Invalid HTTP version");
    }
  }
  this._typeForMessage = type;
  return null;
};

HTTPParserState.prototype._flushHeaders = function _flushHeaders() {
  if (this._headers.length === 0) return false;
  const callback = this.owner[kOnHeaders];
  if (typeof callback !== "function") return false;
  const headers = this._headers;
  const url = this._typeForMessage === HTTP_REQUEST ? this._url : "";
  this._headers = [];
  this._url = "";
  this._haveFlushed = true;
  callback.call(this.owner, headers, url);
  return true;
};

HTTPParserState.prototype._appendHeader = function _appendHeader(name, value) {
  this._headers.push(name, value);
  const lower = name.toLowerCase();
  if (lower === "content-length") {
    if (!DECIMAL.test(value)) return this._fail("HPE_INVALID_CONTENT_LENGTH", "Invalid character in Content-Length");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) return this._fail("HPE_INVALID_CONTENT_LENGTH", "Content-Length overflow");
    if (this._contentLength !== null) return this._fail("HPE_UNEXPECTED_CONTENT_LENGTH", "Duplicate Content-Length");
    this._contentLength = parsed;
  } else if (lower === "transfer-encoding") {
    this._transferEncodingValue += `${this._transferEncodingValue ? "," : ""}${value}`;
  } else if (lower === "connection" || lower === "proxy-connection") {
    this._connectionValue += `${this._connectionValue ? "," : ""}${value}`;
  } else if (lower === "upgrade") {
    this._upgradeValue = value;
  }

  if (this._headers.length / 2 >= MAX_BUFFERED_HEADER_FIELDS) this._flushHeaders();
  return null;
};

HTTPParserState.prototype._parseHeaderLine = function _parseHeaderLine(line) {
  if ((line.startsWith(" ") || line.startsWith("\t")) && this._headers.length > 0) {
    if (!(this._lenientFlags & kLenientHeaders)) {
      return this._fail("HPE_INVALID_HEADER_TOKEN", "Unexpected whitespace after header value");
    }
    this._headers[this._headers.length - 1] += ` ${line.trim()}`;
    return null;
  }

  const colon = line.indexOf(":");
  if (colon <= 0) return this._fail("HPE_INVALID_HEADER_TOKEN", "Invalid header token");
  const name = line.slice(0, colon);
  if (!TOKEN.test(name)) return this._fail("HPE_INVALID_HEADER_TOKEN", "Invalid header token");
  let value = line.slice(colon + 1).replace(/^[\t ]+|[\t ]+$/g, "");
  if (!(this._lenientFlags & kLenientHeaders) && /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
    return this._fail("HPE_INVALID_HEADER_TOKEN", "Invalid header value char");
  }
  return this._appendHeader(name, value);
};

HTTPParserState.prototype._completeMessage = function _completeMessage() {
  if (this._headers.length > 0) this._flushHeaders();
  completeConnection(this._connectionsList, this.owner);
  this._lastMessageStart = 0;
  const callback = this.owner[kOnMessageComplete];
  if (typeof callback === "function") callback.call(this.owner);
  if (this._closed) return;
  this._state = "start-line";
  this._resetMessageFields();
};

HTTPParserState.prototype._completeHeaders = function _completeHeaders() {
  this._headersCompleted = true;
  const transferCodings = splitTokens(this._transferEncodingValue);
  const chunkedIndex = transferCodings.lastIndexOf("chunked");
  const hasTransferEncoding = transferCodings.length > 0;
  const isChunked = chunkedIndex === transferCodings.length - 1 && chunkedIndex >= 0;

  if (chunkedIndex >= 0 && !isChunked && !(this._lenientFlags & kLenientTransferEncoding)) {
    return this._fail("HPE_INVALID_TRANSFER_ENCODING", "Invalid Transfer-Encoding header value");
  }
  if (hasTransferEncoding && this._contentLength !== null && !(this._lenientFlags & kLenientChunkedLength)) {
    return this._fail("HPE_INVALID_CONTENT_LENGTH", "Content-Length can't be present with Transfer-Encoding");
  }
  if (hasTransferEncoding && !isChunked && this._typeForMessage === HTTP_REQUEST &&
      !(this._lenientFlags & kLenientTransferEncoding)) {
    return this._fail("HPE_INVALID_TRANSFER_ENCODING", "Invalid Transfer-Encoding header value");
  }

  const connection = splitTokens(this._connectionValue);
  this._upgrade = (this._typeForMessage === HTTP_REQUEST && this._method === allMethods.indexOf("CONNECT")) ||
    (Boolean(this._upgradeValue) && connection.includes("upgrade") &&
      (this._typeForMessage === HTTP_REQUEST || this._statusCode === 101));

  const callback = this.owner[kOnHeadersComplete];
  let callbackResult = 0;
  if (typeof callback === "function") {
    let headers;
    let url;
    if (this._haveFlushed) {
      this._flushHeaders();
    } else {
      headers = this._headers.slice();
      if (this._typeForMessage === HTTP_REQUEST) url = this._url;
      this._headers = [];
      this._url = "";
    }

    const noBodyByStatus = this._typeForMessage === HTTP_RESPONSE && isNoBodyResponse(this._statusCode);
    const framed = isChunked || this._contentLength !== null || noBodyByStatus || this._typeForMessage === HTTP_REQUEST;
    const keepAlive = shouldKeepAlive(this, framed);
    const result = callback.call(
      this.owner,
      this._versionMajor,
      this._versionMinor,
      headers,
      this._typeForMessage === HTTP_REQUEST ? this._method : undefined,
      this._typeForMessage === HTTP_REQUEST ? url : undefined,
      this._typeForMessage === HTTP_RESPONSE ? this._statusCode : undefined,
      this._typeForMessage === HTTP_RESPONSE ? this._statusMessage : undefined,
      this._upgrade,
      keepAlive,
    );
    callbackResult = Number(result) | 0;
    if (callbackResult !== 0 && callbackResult !== 1 && callbackResult !== 2) {
      return this._fail("HPE_USER", "User callback error");
    }
  }

  if (this._closed) return null;
  if (callbackResult === 2) this._upgrade = true;
  this._headerBytes = 0;

  const noBody = callbackResult === 1 ||
    (this._typeForMessage === HTTP_RESPONSE && isNoBodyResponse(this._statusCode));

  if (this._upgrade) {
    this._completeMessage();
    if (!this._closed) this._state = "upgrade";
  } else if (noBody) {
    this._completeMessage();
  } else if (isChunked) {
    this._state = "chunk-size";
  } else if (this._contentLength !== null) {
    this._bodyRemaining = this._contentLength;
    if (this._bodyRemaining === 0) this._completeMessage();
    else this._state = "fixed-body";
  } else if (this._typeForMessage === HTTP_RESPONSE) {
    this._state = "eof-body";
  } else {
    this._completeMessage();
  }
  return null;
};

HTTPParserState.prototype._emitBody = function _emitBody(bytes) {
  if (bytes.length === 0) return;
  const callback = this.owner[kOnBody];
  if (typeof callback === "function") callback.call(this.owner, copyBuffer(bytes));
};

HTTPParserState.prototype._parsePending = function _parsePending() {
  while (!this._paused && !this._closed) {
    if (this._state === "upgrade") return null;

    if (this._state === "start-line") {
      if (this._pending.length === 0) return null;
      if (!this._messageStarted) this._beginMessage();
      const lineEnd = findLineEnd(this._pending);
      if (lineEnd < 0) {
        if (this._pending.length >= this._maxHeaderSize) return this._fail("HPE_HEADER_OVERFLOW", "Header overflow");
        return null;
      }
      const line = latin1(this._shift(lineEnd));
      this._shift(2);
      this._headerBytes += lineEnd + 2;
      if (this._headerBytes >= this._maxHeaderSize) return this._fail("HPE_HEADER_OVERFLOW", "Header overflow");
      const error = this._parseStartLine(line);
      if (error) return error;
      this._state = "headers";
      continue;
    }

    if (this._state === "headers" || this._state === "trailers") {
      const lineEnd = findLineEnd(this._pending);
      if (lineEnd < 0) {
        if (this._headerBytes + this._pending.length >= this._maxHeaderSize) {
          return this._fail("HPE_HEADER_OVERFLOW", "Header overflow");
        }
        return null;
      }
      const line = latin1(this._shift(lineEnd));
      this._shift(2);
      this._headerBytes += lineEnd + 2;
      if (this._headerBytes >= this._maxHeaderSize) return this._fail("HPE_HEADER_OVERFLOW", "Header overflow");
      if (line.length === 0) {
        if (this._state === "trailers") this._completeMessage();
        else {
          const error = this._completeHeaders();
          if (error) return error;
        }
      } else {
        const error = this._parseHeaderLine(line);
        if (error) return error;
      }
      continue;
    }

    if (this._state === "fixed-body") {
      if (this._pending.length === 0) return null;
      const length = Math.min(this._bodyRemaining, this._pending.length);
      const body = this._shift(length);
      this._bodyRemaining -= length;
      this._emitBody(body);
      if (this._bodyRemaining === 0) this._completeMessage();
      continue;
    }

    if (this._state === "eof-body") {
      if (this._pending.length === 0) return null;
      this._emitBody(this._shift(this._pending.length));
      continue;
    }

    if (this._state === "chunk-size") {
      const lineEnd = findLineEnd(this._pending);
      if (lineEnd < 0) return null;
      const line = latin1(this._shift(lineEnd));
      this._shift(2);
      const semicolon = line.indexOf(";");
      let sizeText = semicolon < 0 ? line : line.slice(0, semicolon);
      if (this._lenientFlags & kLenientSpacesAfterChunkSize) sizeText = sizeText.trim();
      const extension = semicolon < 0 ? "" : line.slice(semicolon + 1);
      if (extension.length > MAX_CHUNK_EXTENSIONS_SIZE) {
        return this._fail("HPE_CHUNK_EXTENSIONS_OVERFLOW", "Chunk extensions overflow");
      }
      if (!HEX.test(sizeText)) return this._fail("HPE_INVALID_CHUNK_SIZE", "Invalid character in chunk size");
      const size = Number.parseInt(sizeText, 16);
      if (!Number.isSafeInteger(size)) return this._fail("HPE_INVALID_CHUNK_SIZE", "Chunk size overflow");
      this._chunkRemaining = size;
      if (size === 0) {
        this._headers = [];
        this._state = "trailers";
      } else {
        this._state = "chunk-data";
      }
      continue;
    }

    if (this._state === "chunk-data") {
      if (this._pending.length === 0) return null;
      const length = Math.min(this._chunkRemaining, this._pending.length);
      const body = this._shift(length);
      this._chunkRemaining -= length;
      this._emitBody(body);
      if (this._chunkRemaining === 0) this._state = "chunk-data-crlf";
      continue;
    }

    if (this._state === "chunk-data-crlf") {
      if (this._pending.length < 2) {
        if ((this._lenientFlags & kLenientOptionalCRLFAfterChunk) && this._pending.length > 0) {
          this._shift(this._pending.length);
          this._state = "chunk-size";
          continue;
        }
        return null;
      }
      if (this._pending[0] !== 13 || this._pending[1] !== 10) {
        if (this._lenientFlags & kLenientOptionalCRLFAfterChunk) {
          this._state = "chunk-size";
          continue;
        }
        return this._fail("HPE_CR_EXPECTED", "Expected CRLF after chunk data");
      }
      this._shift(2);
      this._state = "chunk-size";
      continue;
    }

    return this._fail("HPE_INVALID_INTERNAL_STATE", "Invalid parser state");
  }
  return null;
};

function initialize() {
  const parser = requireParser(this, "initialize");
  if (parser._closed) return undefined;
  const [type, resource, maxHeaderSize, lenientFlags, connectionsList] = arguments;
  parser._type = Number(type) | 0;
  const requestedMax = Math.trunc(Number(maxHeaderSize) || 0);
  parser._maxHeaderSize = requestedMax > 0 ? requestedMax : DEFAULT_MAX_HEADER_SIZE;
  parser._lenientFlags = Number(lenientFlags) | 0;
  parser._pending = EMPTY_BUFFER;
  parser._latchedError = null;
  parser._paused = false;
  parser._headersCompleted = false;
  parser._lastMessageStart = 0;
  parser._state = "start-line";
  parser._resetMessageFields();
  parser._connectionsList = connectionsListStates.has(connectionsList) ? connectionsList : null;
  parser._initialized = true;
  if (parser._connectionsList) {
    parser._lastMessageStart = nowMilliseconds();
    initializeConnection(parser._connectionsList, parser.owner);
  }
  void resource;
  return undefined;
}

function execute() {
  const parser = requireParser(this, "execute");
  if (parser._closed || !parser._initialized) return undefined;
  const input = normalizeInput(arguments[0]);
  if (input === null) return undefined;
  if (parser._latchedError) return parser._latchedError;
  if (parser._paused) return pausedError();
  if (parser._state === "upgrade") return 0;

  parser._currentBuffer = input;
  parser._inputLength = input.length;
  parser._pendingBeforeExecute = parser._pending.length;
  parser._shifted = 0;
  parser._pending = concatBuffers(parser._pending, input);
  try {
    const error = parser._parsePending();
    if (error) return error;
    if (parser._state === "upgrade") return parser._bytesParsed();
    return input.length;
  } finally {
    parser._currentBuffer = EMPTY_BUFFER;
  }
}

function finish() {
  const parser = requireParser(this, "finish");
  if (parser._closed || !parser._initialized) return undefined;
  if (parser._latchedError) return parser._latchedError;
  parser._currentBuffer = EMPTY_BUFFER;
  if (parser._state === "eof-body") {
    if (parser._pending.length > 0) parser._emitBody(parser._shift(parser._pending.length));
    parser._completeMessage();
    return undefined;
  }
  if (parser._state === "start-line" && !parser._messageStarted && parser._pending.length === 0) return undefined;
  if (parser._state === "upgrade") return undefined;
  return parserError("HPE_INVALID_EOF_STATE", "Invalid EOF state", 0);
}

function pause() {
  const parser = requireParser(this, "pause");
  if (parser._closed || !parser._initialized) return undefined;
  parser._paused = true;
  return undefined;
}

function resume() {
  const parser = requireParser(this, "resume");
  if (parser._closed || !parser._initialized) return undefined;
  parser._paused = false;
  return undefined;
}

function close() {
  const parser = requireParser(this, "close");
  if (parser._closed) return undefined;
  parser._detachConsumedSource();
  parser._closed = true;
  parser._initialized = false;
  parser._pending = EMPTY_BUFFER;
  parser._currentBuffer = EMPTY_BUFFER;
  return undefined;
}

function free() {
  const parser = requireParser(this, "free");
  if (parser._closed) return undefined;
  return undefined;
}

function remove() {
  const parser = requireParser(this, "remove");
  if (parser._closed || !parser._initialized) return undefined;
  removeConnection(parser._connectionsList, parser.owner);
  return undefined;
}

HTTPParserState.prototype._notifyExecute = function _notifyExecute(result) {
  const callback = this.owner[kOnExecute];
  if (typeof callback === "function") callback.call(this.owner, result);
};

HTTPParserState.prototype._detachConsumedSource = function _detachConsumedSource() {
  const consumed = this._consumed;
  if (!consumed) return;
  const { source, onData, onEnd, onError, previousOnRead, usedOnRead } = consumed;
  if (usedOnRead) {
    source.onread = previousOnRead;
    source.readStop?.();
  } else {
    const off = typeof source.off === "function" ? source.off.bind(source) : source.removeListener?.bind(source);
    off?.("data", onData);
    off?.("end", onEnd);
    off?.("error", onError);
  }
  this._consumed = null;
};

function consume() {
  const parser = requireParser(this, "consume");
  if (parser._closed || !parser._initialized) return undefined;
  let source = arguments[0];
  parser._detachConsumedSource();
  if (source == null || (typeof source !== "object" && typeof source !== "function")) return undefined;
  if (typeof source.on !== "function") {
    const owner = source.owner;
    if (owner && typeof owner.on === "function") source = owner;
  }

  const onData = chunk => {
    const result = execute.call(parser.owner, chunk);
    parser._notifyExecute(result);
  };
  const onEnd = () => {
    const result = finish.call(parser.owner);
    parser._notifyExecute(result);
  };
  const onError = error => parser._notifyExecute(error);
  const consumed = { source, onData, onEnd, onError, previousOnRead: null, usedOnRead: false };

  if (typeof source.on === "function") {
    source.on("data", onData);
    source.on("end", onEnd);
    source.on("error", onError);
  } else if ("onread" in source || typeof source.readStart === "function") {
    consumed.usedOnRead = true;
    consumed.previousOnRead = source.onread;
    source.onread = chunk => {
      if (chunk == null) onEnd();
      else onData(chunk);
    };
    source.readStart?.();
  } else {
    return undefined;
  }
  parser._consumed = consumed;
  return undefined;
}

function unconsume() {
  const parser = requireParser(this, "unconsume");
  if (parser._closed || !parser._initialized) return undefined;
  parser._detachConsumedSource();
  return undefined;
}

function getCurrentBuffer() {
  const parser = requireParser(this, "getCurrentBuffer");
  if (parser._closed || !parser._initialized) return undefined;
  return copyBuffer(parser._currentBuffer);
}

function duration() {
  const parser = requireParser(this, "duration");
  if (parser._closed || !parser._initialized) return undefined;
  if (parser._lastMessageStart === 0) return 0;
  return Math.max(0.001, nowMilliseconds() - parser._lastMessageStart);
}

function headersCompleted() {
  const parser = requireParser(this, "headersCompleted");
  if (parser._closed || !parser._initialized) return undefined;
  return parser._headersCompleted;
}

delete HTTPParser.prototype.constructor;
Object.defineProperties(HTTPParser.prototype, {
  close: { value: close, writable: true, configurable: true },
  free: { value: free, writable: true, configurable: true },
  remove: { value: remove, writable: true, configurable: true },
  execute: { value: execute, writable: true, configurable: true },
  finish: { value: finish, writable: true, configurable: true },
  initialize: { value: initialize, writable: true, configurable: true },
  pause: { value: pause, writable: true, configurable: true },
  resume: { value: resume, writable: true, configurable: true },
  consume: { value: consume, writable: true, configurable: true },
  unconsume: { value: unconsume, writable: true, configurable: true },
  getCurrentBuffer: { value: getCurrentBuffer, writable: true, configurable: true },
  duration: { value: duration, writable: true, configurable: true },
  headersCompleted: { value: headersCompleted, writable: true, configurable: true },
  constructor: { value: HTTPParser, writable: true, configurable: true },
  [Symbol.toStringTag]: { value: "HTTPParser", configurable: true },
});

Object.assign(HTTPParser, {
  REQUEST: HTTP_REQUEST,
  RESPONSE: HTTP_RESPONSE,
  kOnMessageBegin,
  kOnHeaders,
  kOnHeadersComplete,
  kOnBody,
  kOnMessageComplete,
  kOnExecute,
  kOnTimeout,
  kLenientNone,
  kLenientHeaders,
  kLenientChunkedLength,
  kLenientKeepAlive,
  kLenientTransferEncoding,
  kLenientVersion,
  kLenientDataAfterClose,
  kLenientOptionalLFAfterCR,
  kLenientOptionalCRLFAfterChunk,
  kLenientOptionalCRBeforeLF,
  kLenientSpacesAfterChunkSize,
  kLenientAll,
});

function ConnectionsList(_headersTimeout, _requestTimeout) {
  if (!new.target) return undefined;
  connectionsListStates.set(this, {
    allConnections: new Set(),
    activeConnections: new Set(),
  });
}

function initializeConnection(list, parser) {
  const state = connectionsListStates.get(list);
  if (!state) return;
  state.allConnections.add(parser);
  state.activeConnections.add(parser);
}

function activateConnection(list, parser) {
  const state = connectionsListStates.get(list);
  if (!state) return;
  state.allConnections.delete(parser);
  state.activeConnections.delete(parser);
  state.allConnections.add(parser);
  state.activeConnections.add(parser);
}

function completeConnection(list, parser) {
  const state = connectionsListStates.get(list);
  if (!state) return;
  state.allConnections.delete(parser);
  state.activeConnections.delete(parser);
  state.allConnections.add(parser);
}

function removeConnection(list, parser) {
  const state = connectionsListStates.get(list);
  if (!state) return;
  state.allConnections.delete(parser);
  state.activeConnections.delete(parser);
}

function requireConnectionsList(value) {
  return connectionsListStates.get(value) ?? null;
}

function all() {
  const list = requireConnectionsList(this);
  return list ? Array.from(list.allConnections) : undefined;
}

function idle() {
  const list = requireConnectionsList(this);
  if (!list) return undefined;
  return Array.from(list.allConnections).filter(parser => parserStates.get(parser)?._lastMessageStart === 0);
}

function active() {
  const list = requireConnectionsList(this);
  return list ? Array.from(list.activeConnections) : undefined;
}

function expired(headersTimeout, requestTimeout) {
  const list = requireConnectionsList(this);
  if (!list) return undefined;
  let headers = toUint32(headersTimeout);
  let request = toUint32(requestTimeout);
  if (headers === 0 && request === 0) return [];
  if (request > 0 && headers > request) [headers, request] = [request, headers];
  const now = nowMilliseconds();
  const result = [];
  for (const parser of list.activeConnections) {
    const parserState = parserStates.get(parser);
    if (!parserState) continue;
    const elapsed = parserState._lastMessageStart === 0 ? 0 : now - parserState._lastMessageStart;
    if ((!parserState._headersCompleted && headers > 0 && elapsed >= headers) ||
        (request > 0 && elapsed >= request)) {
      result.push(parser);
      list.activeConnections.delete(parser);
    }
  }
  return result;
}

delete ConnectionsList.prototype.constructor;
Object.defineProperties(ConnectionsList.prototype, {
  all: { value: all, writable: true, configurable: true },
  idle: { value: idle, writable: true, configurable: true },
  active: { value: active, writable: true, configurable: true },
  expired: { value: expired, writable: true, configurable: true },
  constructor: { value: ConnectionsList, writable: true, configurable: true },
  [Symbol.toStringTag]: { value: "ConnectionsList", configurable: true },
});

export { HTTPParser, ConnectionsList };

export function makeHttpParserBinding() {
  return { methods: methods.slice(), allMethods: allMethods.slice(), HTTPParser, ConnectionsList };
}
