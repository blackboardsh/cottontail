import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as http from "node:http";

const common = require("_http_common");
const nodeCommon = require("node:_http_common");
const binding = process.binding("http_parser") as any;
const { internalBinding } = require("internal/test/binding");

assert.strictEqual(common, nodeCommon);
assert.strictEqual(common.HTTPParser, binding.HTTPParser);
assert.strictEqual(common.methods, binding.methods);
assert.strictEqual(internalBinding("http_parser"), binding);
assert.deepStrictEqual(Object.keys(common), [
  "validateHeaderName",
  "validateHeaderValue",
  "_checkIsHttpToken",
  "_checkInvalidHeaderChar",
  "chunkExpression",
  "continueExpression",
  "CRLF",
  "freeParser",
  "methods",
  "parsers",
  "kIncomingMessage",
  "HTTPParser",
  "isLenient",
  "prepareError",
  "kSkipPendingData",
]);
assert.strictEqual(common.methods[24], "M - SEARCH");
assert.strictEqual(common._checkIsHttpToken("x-custom^header"), true);
assert.strictEqual(common._checkIsHttpToken("bad header"), false);
assert.strictEqual(common._checkInvalidHeaderChar("value\twith obs-text \xff"), false);
assert.strictEqual(common._checkInvalidHeaderChar("value\r\n"), true);
assert.strictEqual(common.isLenient(), false);

http.setMaxIdleHTTPParsers(7);
assert.strictEqual(common.parsers.max, 7);
http.setMaxIdleHTTPParsers(1000);
assert.strictEqual(common.parsers.max, 1000);

function socket() {
  return {
    readable: true,
    _paused: false,
    parser: null as any,
    server: { joinDuplicateHeaders: true },
    resumeCalls: 0,
    pauseCalls: 0,
    on() {},
    resume() { this.resumeCalls += 1; },
    pause() { this.pauseCalls += 1; },
  };
}

const requestParser = common.parsers.alloc();
const requestSocket = socket();
const request = { parser: requestParser };
requestSocket.parser = requestParser;
let incomingRequest: any;
let requestKeepAlive: boolean | undefined;

requestParser.initialize(common.HTTPParser.REQUEST, {});
requestParser.socket = requestSocket;
requestParser.onIncoming = (message: any, keepAlive: boolean) => {
  incomingRequest = message;
  requestKeepAlive = keepAlive;
  return 0;
};

const requestWire = Buffer.from(
  "POST /fragmented HTTP/1.1\r\n" +
  "Host: example.test\r\n" +
  "X-Trace: one\r\n" +
  "X-Trace: two\r\n" +
  "Cookie: a=1\r\n" +
  "Cookie: b=2\r\n" +
  "Set-Cookie: c=3\r\n" +
  "Set-Cookie: d=4\r\n" +
  "Transfer-Encoding: chunked\r\n\r\n" +
  "4\r\npong\r\n" +
  "0\r\nX-Trailer: done\r\n\r\n",
);
for (let offset = 0; offset < requestWire.length; offset += 3) {
  const chunk = requestWire.subarray(offset, Math.min(offset + 3, requestWire.length));
  assert.strictEqual(requestParser.execute(chunk), chunk.length);
}

assert.ok(incomingRequest instanceof http.IncomingMessage);
assert.strictEqual(incomingRequest.method, "POST");
assert.strictEqual(incomingRequest.url, "/fragmented");
assert.strictEqual(incomingRequest.httpVersion, "1.1");
assert.strictEqual(incomingRequest.headers.host, "example.test");
assert.strictEqual(incomingRequest.headers["x-trace"], "one, two");
assert.strictEqual(incomingRequest.headers.cookie, "a=1; b=2");
assert.deepStrictEqual(incomingRequest.headers["set-cookie"], ["c=3", "d=4"]);
assert.strictEqual(incomingRequest.trailers["x-trailer"], "done");
assert.deepStrictEqual(incomingRequest.rawTrailers, ["X-Trailer", "done"]);
assert.strictEqual(incomingRequest._incomingBody.toString(), "pong");
assert.strictEqual(incomingRequest.complete, true);
assert.strictEqual(requestKeepAlive, true);
assert.ok(requestSocket.resumeCalls > 0);

common.freeParser(requestParser, request, requestSocket);
assert.strictEqual(request.parser, null);
assert.strictEqual(requestSocket.parser, null);
assert.strictEqual(requestParser.socket, null);
assert.strictEqual(requestParser.incoming, null);
assert.strictEqual(requestParser.onIncoming, null);
assert.strictEqual(requestParser.joinDuplicateHeaders, null);
assert.strictEqual(common.parsers.list.at(-1), requestParser);

const responseParser = common.parsers.alloc();
assert.strictEqual(responseParser, requestParser);
const responseSocket = socket();
let incomingResponse: any;
let responseKeepAlive: boolean | undefined;
responseParser.initialize(common.HTTPParser.RESPONSE, {});
responseParser.socket = responseSocket;
responseParser.onIncoming = (message: any, keepAlive: boolean) => {
  incomingResponse = message;
  responseKeepAlive = keepAlive;
  return 0;
};
const responseWire = Buffer.from(
  "HTTP/1.0 206 Partial Content\r\n" +
  "Content-Length: 5\r\n" +
  "Connection: keep-alive\r\n\r\nhello",
);
assert.strictEqual(responseParser.execute(responseWire), responseWire.length);
assert.strictEqual(incomingResponse.statusCode, 206);
assert.strictEqual(incomingResponse.statusMessage, "Partial Content");
assert.strictEqual(incomingResponse.url, "");
assert.strictEqual(incomingResponse._incomingBody.toString(), "hello");
assert.strictEqual(responseKeepAlive, true);

const parseError = new Error("Parse Error") as Error & { reason?: string; rawPacket?: Buffer };
parseError.reason = "Invalid header token";
const rawPacket = Buffer.from("bad request");
common.prepareError(parseError, responseParser, rawPacket);
assert.strictEqual(parseError.message, "Parse Error: Invalid header token");
assert.strictEqual(parseError.rawPacket, rawPacket);

common.freeParser(responseParser);

class SkippedIncoming {
  socket: unknown;
  complete = false;
  _dumped = false;
  pushed: unknown[] = [];

  constructor(value: unknown) {
    this.socket = value;
  }

  push(value: unknown) {
    this.pushed.push(value);
    return true;
  }
}

const skippedParser = common.parsers.alloc();
const skippedSocket = socket();
(skippedSocket.server as any)[common.kIncomingMessage] = SkippedIncoming;
let skippedIncoming: any;
skippedParser.initialize(common.HTTPParser.REQUEST, {});
skippedParser.socket = skippedSocket;
skippedParser.onIncoming = (message: any) => {
  skippedIncoming = message;
  message[common.kSkipPendingData] = true;
  return 0;
};
const skippedWire = Buffer.from("POST /skip HTTP/1.1\r\nContent-Length: 4\r\n\r\ndata");
assert.strictEqual(skippedParser.execute(skippedWire), skippedWire.length);
assert.ok(skippedIncoming instanceof SkippedIncoming);
assert.strictEqual(skippedIncoming.method, "POST");
assert.strictEqual(skippedIncoming.headers["content-length"], "4");
assert.deepStrictEqual(skippedIncoming.pushed, []);
assert.strictEqual(skippedIncoming.complete, false);
assert.ok(skippedSocket.resumeCalls > 0);
common.freeParser(skippedParser);

const consumedParser = new common.HTTPParser();
const consumedSource = new EventEmitter();
const consumedHandle = { owner: consumedSource };
const executeResults: unknown[] = [];
let consumedMessages = 0;
consumedParser.initialize(common.HTTPParser.REQUEST, {});
consumedParser[common.HTTPParser.kOnExecute] = (result: unknown) => executeResults.push(result);
consumedParser[common.HTTPParser.kOnMessageComplete] = () => { consumedMessages += 1; };
consumedParser.consume(consumedHandle);
consumedSource.emit("data", Buffer.from("GET /handle HTTP/1.1\r\n\r\n"));
assert.strictEqual(consumedMessages, 1);
assert.deepStrictEqual(executeResults, [24]);
consumedParser.unconsume();
consumedSource.emit("data", Buffer.from("GET /ignored HTTP/1.1\r\n\r\n"));
assert.strictEqual(consumedMessages, 1);

console.log("node _http_common source conformance passed");
