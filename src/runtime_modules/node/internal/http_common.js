const tokenRegExp = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const tokenCharacterRegExp = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]$/;
const headerCharRegExp = /[^\t\x20-\x7e\x80-\xff]/;
const MAX_HEADER_PAIRS = 2000;

class FreeList {
  constructor(name, max, ctor) {
    this.name = name;
    this.ctor = ctor;
    this.max = max;
    this.list = [];
  }

  alloc() {
    return this.list.length > 0 ? this.list.pop() : new this.ctor(...arguments);
  }

  free(value) {
    if (this.list.length < this.max) {
      this.list.push(value);
      return true;
    }
    return false;
  }
}

function checkIsHttpToken(value) {
  if (value.length >= 10) return tokenRegExp.test(value);
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!tokenCharacterRegExp.test(value[index])) return false;
  }
  return true;
}

function checkInvalidHeaderChar(value) {
  return headerCharRegExp.test(value);
}

const joinableHeaderNames = new Set([
  "accept", "accept-encoding", "accept-language", "cache-control", "connection",
  "date", "expect", "if-match", "if-none-match", "origin", "transfer-encoding",
  "upgrade", "vary", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
]);

const singleValueHeaderNames = new Set([
  "age", "authorization", "content-length", "content-type", "etag", "expires",
  "from", "host", "if-modified-since", "if-unmodified-since", "last-modified",
  "location", "max-forwards", "proxy-authorization", "referer", "retry-after",
  "server", "user-agent",
]);

function addHeaderLine(message, destination, field, value) {
  const name = String(field).toLowerCase();
  const text = String(value);
  if (name === "set-cookie") {
    if (destination[name] === undefined) destination[name] = [text];
    else destination[name].push(text);
    return;
  }
  if (name === "cookie") {
    destination[name] = destination[name] === undefined ? text : `${destination[name]}; ${text}`;
    return;
  }
  if (joinableHeaderNames.has(name) || !singleValueHeaderNames.has(name)) {
    destination[name] = destination[name] === undefined ? text : `${destination[name]}, ${text}`;
    return;
  }
  if (message.joinDuplicateHeaders && destination[name] !== undefined) {
    destination[name] += `, ${text}`;
    return;
  }
  if (destination[name] === undefined) destination[name] = text;
}

function addHeaderLines(message, headers, count) {
  if (!headers?.length) return;
  if (typeof message._addHeaderLines === "function") {
    message._addHeaderLines(headers, count);
    return;
  }

  const raw = headers.slice(0, count);
  const trailers = message.complete === true;
  const destination = {};
  for (let index = 0; index + 1 < raw.length; index += 2) {
    addHeaderLine(message, destination, raw[index], raw[index + 1]);
  }
  if (trailers) {
    message.rawTrailers = raw;
    message.trailers = destination;
    message._trailersDistinct = null;
  } else {
    message.rawHeaders = raw;
    message.headers = destination;
    message._headersDistinct = null;
  }
}

function closeParserInstance(parser) {
  parser.close();
}

export function createHttpCommonBuiltin({ http, incoming, processObject }) {
  const binding = processObject.binding("http_parser");
  const { methods, allMethods, HTTPParser } = binding;
  const { IncomingMessage, readStart, readStop } = incoming;
  const insecureHTTPParser = processObject.execArgv?.includes("--insecure-http-parser") ?? false;

  const kIncomingMessage = Symbol("IncomingMessage");
  const kSkipPendingData = Symbol("SkipPendingData");
  const kOnMessageBegin = HTTPParser.kOnMessageBegin | 0;
  const kOnHeaders = HTTPParser.kOnHeaders | 0;
  const kOnHeadersComplete = HTTPParser.kOnHeadersComplete | 0;
  const kOnBody = HTTPParser.kOnBody | 0;
  const kOnMessageComplete = HTTPParser.kOnMessageComplete | 0;
  const kOnExecute = HTTPParser.kOnExecute | 0;
  const kOnTimeout = HTTPParser.kOnTimeout | 0;

  function parserOnHeaders(headers, url) {
    if (this.maxHeaderPairs <= 0 || this._headers.length < this.maxHeaderPairs) {
      this._headers.push(...headers);
    }
    this._url += url;
  }

  function parserOnHeadersComplete(
    versionMajor,
    versionMinor,
    headers,
    method,
    url,
    statusCode,
    statusMessage,
    upgrade,
    shouldKeepAlive,
  ) {
    const parser = this;
    const { socket } = parser;

    if (headers === undefined) {
      headers = parser._headers;
      parser._headers = [];
    }
    if (url === undefined) {
      url = parser._url;
      parser._url = "";
    }

    const ParserIncomingMessage = socket?.server?.[kIncomingMessage] || IncomingMessage;
    const stream = parser.incoming = new ParserIncomingMessage(socket);
    stream.httpVersionMajor = versionMajor;
    stream.httpVersionMinor = versionMinor;
    stream.httpVersion = versionMajor === 1 && versionMinor === 1 ? "1.1" : `${versionMajor}.${versionMinor}`;
    stream.joinDuplicateHeaders = socket?.server?.joinDuplicateHeaders || parser.joinDuplicateHeaders;
    stream.url = url;
    stream.upgrade = upgrade;

    let count = headers.length;
    if (parser.maxHeaderPairs > 0) count = Math.min(count, parser.maxHeaderPairs);
    addHeaderLines(stream, headers, count);

    if (typeof method === "number") stream.method = allMethods[method];
    else {
      stream.statusCode = statusCode;
      stream.statusMessage = statusMessage;
    }
    return parser.onIncoming(stream, shouldKeepAlive);
  }

  function parserOnBody(buffer) {
    const stream = this.incoming;
    if (stream === null || stream[kSkipPendingData]) return;
    if (!stream._dumped) {
      const accepted = typeof stream._pushIncomingChunk === "function"
        ? stream._pushIncomingChunk(buffer)
        : stream.push(buffer);
      if (!accepted) readStop(this.socket);
    }
  }

  function parserOnMessageComplete() {
    const parser = this;
    const stream = parser.incoming;
    if (stream !== null && !stream[kSkipPendingData]) {
      stream.complete = true;
      const headers = parser._headers;
      if (headers.length) {
        addHeaderLines(stream, headers, headers.length);
        parser._headers = [];
        parser._url = "";
      }

      if (typeof stream._completeIncoming === "function") {
        const trailers = stream.trailers;
        const rawTrailers = stream.rawTrailers;
        stream.complete = false;
        stream._completeIncoming(trailers, rawTrailers);
      } else {
        stream.push(null);
      }
    }
    readStart(parser.socket);
  }

  function cleanParser(parser) {
    parser._headers = [];
    parser._url = "";
    parser.socket = null;
    parser.incoming = null;
    parser.outgoing = null;
    parser.maxHeaderPairs = MAX_HEADER_PAIRS;
    parser[kOnMessageBegin] = null;
    parser[kOnExecute] = null;
    parser[kOnTimeout] = null;
    parser._consumed = false;
    parser.onIncoming = null;
    parser.joinDuplicateHeaders = null;
  }

  const parsers = new FreeList("parsers", 1000, function parsersCb() {
    const parser = new HTTPParser();
    cleanParser(parser);
    parser[kOnHeaders] = parserOnHeaders;
    parser[kOnHeadersComplete] = parserOnHeadersComplete;
    parser[kOnBody] = parserOnBody;
    parser[kOnMessageComplete] = parserOnMessageComplete;
    return parser;
  });

  const setMaxIdleHTTPParsers = http.setMaxIdleHTTPParsers;
  if (typeof setMaxIdleHTTPParsers === "function") {
    const initialMax = Number(setMaxIdleHTTPParsers.value);
    if (Number.isInteger(initialMax) && initialMax > 0) parsers.max = initialMax;
    Object.defineProperty(setMaxIdleHTTPParsers, "value", {
      configurable: true,
      enumerable: true,
      get: () => parsers.max,
      set: value => { parsers.max = value; },
    });
  }

  function freeParser(parser, request, socket) {
    if (parser) {
      if (parser._consumed) parser.unconsume();
      cleanParser(parser);
      parser.remove();
      if (parsers.free(parser) === false) setImmediate(closeParserInstance, parser);
      else parser.free();
    }
    if (request) request.parser = null;
    if (socket) socket.parser = null;
  }

  function prepareError(error, parser, rawPacket) {
    error.rawPacket = rawPacket || parser.getCurrentBuffer();
    if (typeof error.reason === "string") error.message = `Parse Error: ${error.reason}`;
  }

  let warnedLenient = false;
  function isLenient() {
    if (insecureHTTPParser && !warnedLenient) {
      warnedLenient = true;
      processObject.emitWarning("Using insecure HTTP parsing");
    }
    return insecureHTTPParser;
  }

  return {
    validateHeaderName: http.validateHeaderName,
    validateHeaderValue: http.validateHeaderValue,
    _checkIsHttpToken: checkIsHttpToken,
    _checkInvalidHeaderChar: checkInvalidHeaderChar,
    chunkExpression: /(?:^|\W)chunked(?:$|\W)/i,
    continueExpression: /(?:^|\W)100-continue(?:$|\W)/i,
    CRLF: "\r\n",
    freeParser,
    methods,
    parsers,
    kIncomingMessage,
    HTTPParser,
    isLenient,
    prepareError,
    kSkipPendingData,
  };
}

export default createHttpCommonBuiltin;
