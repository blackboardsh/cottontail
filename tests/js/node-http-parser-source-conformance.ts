function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function equalArray(actual: unknown[], expected: unknown[], message: string) {
  equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

const binding = process.binding("http_parser") as any;
const { HTTPParser, ConnectionsList, methods, allMethods } = binding;
const kOnMessageBegin = HTTPParser.kOnMessageBegin;
const kOnHeaders = HTTPParser.kOnHeaders;
const kOnHeadersComplete = HTTPParser.kOnHeadersComplete;
const kOnBody = HTTPParser.kOnBody;
const kOnMessageComplete = HTTPParser.kOnMessageComplete;
const kOnExecute = HTTPParser.kOnExecute;

assert(process.binding("http_parser") === binding, "process.binding should cache http_parser");
equal(methods[3], "POST", "HTTP method ordering");
equal(methods[24], "M - SEARCH", "Bun HTTP extension method stringification");
equal(allMethods[34], "PRI", "allMethods should include HTTP/2 PRI");
equal(allMethods[46], "QUERY", "allMethods should preserve llhttp enum indexes");
equal(HTTPParser.REQUEST, 1, "REQUEST constant");
equal(HTTPParser.RESPONSE, 2, "RESPONSE constant");
equal(typeof HTTPParser.kLenientAll, "number", "lenient constants");
equal(HTTPParser.length, 0, "HTTPParser constructor arity");
equal(ConnectionsList.length, 2, "ConnectionsList constructor arity");
equal(HTTPParser.prototype.initialize.length, 0, "initialize arity");
equal(HTTPParser.prototype.execute.length, 0, "execute arity");
equal(HTTPParser.prototype.consume.length, 0, "consume arity");
equalArray(Object.getOwnPropertyNames(HTTPParser.prototype), [
  "close", "free", "remove", "execute", "finish", "initialize", "pause", "resume",
  "consume", "unconsume", "getCurrentBuffer", "duration", "headersCompleted", "constructor",
], "HTTPParser prototype shape");
equalArray(Object.getOwnPropertyNames(ConnectionsList.prototype), [
  "all", "idle", "active", "expired", "constructor",
], "ConnectionsList prototype shape");
equalArray(Object.getOwnPropertyNames(new HTTPParser()), [], "HTTPParser native-state shape");
equalArray(Object.getOwnPropertyNames(new ConnectionsList()), [], "ConnectionsList native-state shape");

{
  const parser = new HTTPParser();
  parser._headers = ["caller-owned"];
  parser._url = "caller-owned";
  parser.initialize(HTTPParser.REQUEST, {});
  parser.execute(Buffer.from("GET /internal-state HTTP/1.1\r\n\r\n"));
  equalArray(parser._headers, ["caller-owned"], "caller _headers must not collide with parser state");
  equal(parser._url, "caller-owned", "caller _url must not collide with parser state");
}

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.REQUEST, {});
  const bodies: string[] = [];
  let began = 0;
  let completed = 0;
  parser[kOnMessageBegin] = () => { began += 1; };
  parser[kOnHeadersComplete] = (
    major: number,
    minor: number,
    headers: string[],
    method: number,
    url: string,
    status: undefined,
    message: undefined,
    upgrade: boolean,
    keepAlive: boolean,
  ) => {
    equal(major, 1, "request major version");
    equal(minor, 1, "request minor version");
    equal(method, allMethods.indexOf("POST"), "request method enum");
    equal(url, "/fragmented", "request URL");
    equal(status, undefined, "request status");
    equal(message, undefined, "request status message");
    equal(upgrade, false, "request upgrade");
    equal(keepAlive, true, "request keep-alive");
    equalArray(headers, ["Host", "example.test", "Content-Length", "4"], "request headers");
  };
  parser[kOnBody] = (body: Buffer) => bodies.push(body.toString());
  parser[kOnMessageComplete] = () => { completed += 1; };

  const wire = Buffer.from(
    "POST /fragmented HTTP/1.1\r\n" +
    "Host: example.test\r\n" +
    "Content-Length: 4\r\n\r\npong",
  );
  for (let index = 0; index < wire.length; index += 1) {
    equal(parser.execute(wire.subarray(index, index + 1)), 1, `byte ${index} consumed`);
  }
  equal(began, 1, "message-begin callback count");
  equal(completed, 1, "message-complete callback count");
  equal(bodies.join(""), "pong", "fragmented fixed body");
  equal(parser.headersCompleted(), true, "headersCompleted after request");
  equal(parser.finish(), undefined, "finish after complete request");
}

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.RESPONSE, {});
  const bodies: string[] = [];
  let trailers: string[] = [];
  let completed = 0;
  parser[kOnHeaders] = (headers: string[]) => { trailers = headers; };
  parser[kOnHeadersComplete] = (
    major: number,
    minor: number,
    headers: string[],
    method: undefined,
    url: undefined,
    status: number,
    message: string,
    upgrade: boolean,
    keepAlive: boolean,
  ) => {
    equal(major, 1, "response major version");
    equal(minor, 1, "response minor version");
    equal(method, undefined, "response method");
    equal(url, undefined, "response URL");
    equal(status, 200, "response status");
    equal(message, "Everything Fine", "response status message");
    equal(upgrade, false, "response upgrade");
    equal(keepAlive, true, "response keep-alive");
    equalArray(headers, ["Transfer-Encoding", "chunked"], "response headers");
  };
  parser[kOnBody] = (body: Buffer) => bodies.push(body.toString());
  parser[kOnMessageComplete] = () => { completed += 1; };
  const parts = [
    "HTTP/1.1 200 Everything Fine\r\nTransfer-Encoding: chunked\r\n\r\n4\r\np",
    "ing\r\n3;foo=bar\r\n123\r\n0\r\nVary: *\r\n\r\n",
  ];
  for (const part of parts) equal(parser.execute(Buffer.from(part)), part.length, "chunked response consumed");
  equal(bodies.join(""), "ping123", "chunked response body");
  equalArray(trailers, ["Vary", "*"], "chunked trailers");
  equal(completed, 1, "chunked message complete");
}

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.REQUEST, {});
  const urls: string[] = [];
  let completed = 0;
  parser[kOnHeadersComplete] = (_major: number, _minor: number, _headers: string[], _method: number, url: string) => {
    urls.push(url);
  };
  parser[kOnMessageComplete] = () => { completed += 1; };
  const pipeline = Buffer.from("GET /one HTTP/1.1\r\n\r\nGET /two HTTP/1.0\r\nConnection: keep-alive\r\n\r\n");
  equal(parser.execute(pipeline), pipeline.length, "pipeline consumed");
  equalArray(urls, ["/one", "/two"], "pipelined URLs");
  equal(completed, 2, "pipelined complete count");
}

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.REQUEST, {});
  let sawUpgrade = false;
  let completed = 0;
  parser[kOnHeadersComplete] = (
    _major: number,
    _minor: number,
    _headers: string[],
    _method: number,
    _url: string,
    _status: undefined,
    _message: undefined,
    upgrade: boolean,
  ) => { sawUpgrade = upgrade; };
  parser[kOnMessageComplete] = () => { completed += 1; };
  const head = "GET /chat HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";
  const wire = Buffer.from(`${head}opaque-protocol-data`);
  equal(parser.execute(wire), Buffer.byteLength(head), "upgrade should stop at HTTP boundary");
  equal(sawUpgrade, true, "upgrade callback flag");
  equal(completed, 1, "upgrade message complete");
}

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.REQUEST, {});
  const bodies: string[] = [];
  parser[kOnHeadersComplete] = function () { this.pause(); };
  parser[kOnBody] = (body: Buffer) => bodies.push(body.toString());
  const wire = Buffer.from("POST / HTTP/1.1\r\nContent-Length: 4\r\n\r\ndata");
  parser.execute(wire);
  equal(bodies.length, 0, "pause from headers callback");
  equal(parser.execute(Buffer.alloc(0)).code, "HPE_PAUSED", "execute while paused");
  parser.resume();
  equal(parser.execute(Buffer.alloc(0)), 0, "resume buffered parse");
  equal(bodies.join(""), "data", "body after resume");
}

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.REQUEST, {});
  const incompleteWire = Buffer.from("POST / HTTP/1.1\r\nContent-Length: 4\r\n\r\nxy");
  const incomplete = parser.execute(incompleteWire);
  equal(incomplete, incompleteWire.length, "incomplete body bytes consumed");
  const eof = parser.finish();
  equal(eof.code, "HPE_INVALID_EOF_STATE", "incomplete finish code");
  equal(eof.reason, "Invalid EOF state", "incomplete finish reason");
  equal(eof.bytesParsed, 0, "incomplete finish bytesParsed");

  const invalid = new HTTPParser();
  invalid.initialize(HTTPParser.REQUEST, {});
  const error = invalid.execute(Buffer.from(
    "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\n",
  ));
  equal(error.code, "HPE_INVALID_CONTENT_LENGTH", "framing conflict error code");
  equal(error.reason, "Content-Length can't be present with Transfer-Encoding", "framing conflict reason");
  assert(error.bytesParsed > 0, "framing conflict bytesParsed");
}

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.REQUEST, {});
  let current = "";
  parser[kOnHeaders] = function () { current = this.getCurrentBuffer().toString(); };
  const input = Buffer.from("GET / HTTP/1.1\r\nHost: example.test\r\n\r\n");
  parser.execute(input);
  equal(current, input.toString(), "current execution buffer");
  equal(parser.getCurrentBuffer().length, 0, "current buffer outside execute");
  assert(parser.duration() === 0, "completed parser duration should reset");
}

{
  const listeners = new Map<string, Function[]>();
  const source = {
    on(name: string, callback: Function) {
      listeners.set(name, [...(listeners.get(name) ?? []), callback]);
    },
    off(name: string, callback: Function) {
      listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== callback));
    },
    emit(name: string, value?: unknown) {
      for (const callback of listeners.get(name) ?? []) callback(value);
    },
  };
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.REQUEST, {});
  let completed = 0;
  const executeResults: unknown[] = [];
  parser[kOnMessageComplete] = () => { completed += 1; };
  parser[kOnExecute] = (result: unknown) => executeResults.push(result);
  parser.consume(source);
  source.emit("data", Buffer.from("GET /stream HTTP/1.1\r\n\r\n"));
  equal(completed, 1, "consume data parsing");
  equal(executeResults[0], 24, "consume execute callback");
  parser.unconsume();
  source.emit("data", Buffer.from("GET /ignored HTTP/1.1\r\n\r\n"));
  equal(completed, 1, "unconsume detaches source");
}

{
  const list = new ConnectionsList();
  const first = new HTTPParser();
  const second = new HTTPParser();
  first.initialize(HTTPParser.REQUEST, {}, 0, 0, list);
  second.initialize(HTTPParser.REQUEST, {}, 0, 0, list);
  equalArray(list.all(), [first, second], "initial connection order");
  equalArray(list.active(), [first, second], "initial active connections");
  first.execute(Buffer.from("GET / HTTP/1.1\r\n\r\n"));
  equalArray(list.all(), [second, first], "completed connection moves to end");
  equalArray(list.idle(), [first], "idle connection list");
  second.execute(Buffer.from("GET /slow HTTP/1.1\r\nHost:"));
  await Bun.sleep(4);
  equalArray(list.expired(1, 1000), [second], "header timeout expiration");
  equalArray(list.active(), [], "expired connection removed from active list");
  first.remove();
  equalArray(list.all(), [second], "remove connection");
}

{
  const parser = new HTTPParser();
  parser.close();
  equal(parser.close(), undefined, "double close");
  equal(parser.free(), undefined, "free after close");
  equal(parser.remove(), undefined, "remove after close");
  equal(parser.execute(), undefined, "execute after close");
  equal(parser.finish(), undefined, "finish after close");
  equal(parser.initialize(), undefined, "initialize after close");
  equal(parser.pause(), undefined, "pause after close");
  equal(parser.resume(), undefined, "resume after close");
  equal(parser.consume(), undefined, "consume after close");
  equal(parser.unconsume(), undefined, "unconsume after close");
  equal(parser.getCurrentBuffer(), undefined, "getCurrentBuffer after close");
  equal(parser.duration(), undefined, "duration after close");
  equal(parser.headersCompleted(), undefined, "headersCompleted after close");
  let wrongThis = false;
  try {
    HTTPParser.prototype.execute.call({}, Buffer.alloc(0));
  } catch (error) {
    wrongThis = error instanceof TypeError;
  }
  assert(wrongThis, "HTTPParser methods should validate this");
}

console.log("node http_parser source conformance passed");
