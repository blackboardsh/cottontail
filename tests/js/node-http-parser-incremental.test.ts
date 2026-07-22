function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

const { HTTPParser, methods, allMethods } = process.binding("http_parser") as any;
const kOnHeaders = HTTPParser.kOnHeaders;
const kOnHeadersComplete = HTTPParser.kOnHeadersComplete;
const kOnBody = HTTPParser.kOnBody;
const kOnMessageComplete = HTTPParser.kOnMessageComplete;

function parseAtEverySplit(wire: Buffer, expectedBody: string) {
  for (let split = 0; split <= wire.length; split += 1) {
    const parser = new HTTPParser();
    parser.initialize(HTTPParser.REQUEST, {});
    const bodies: string[] = [];
    let completed = 0;
    parser[kOnHeadersComplete] = (
      major: number,
      minor: number,
      headers: string[],
      method: number,
      url: string,
    ) => {
      equal(major, 1, `split ${split} major`);
      equal(minor, 1, `split ${split} minor`);
      equal(method, allMethods.indexOf("POST"), `split ${split} method`);
      equal(url, "/chunks", `split ${split} URL`);
      equal(headers.length, 4, `split ${split} header count`);
    };
    parser[kOnBody] = (body: Buffer) => bodies.push(body.toString());
    parser[kOnMessageComplete] = () => { completed += 1; };
    equal(parser.execute(wire.subarray(0, split)), split, `split ${split} first execute`);
    equal(parser.execute(wire.subarray(split)), wire.length - split, `split ${split} second execute`);
    equal(bodies.join(""), expectedBody, `split ${split} body`);
    equal(completed, 1, `split ${split} completion`);
  }
}

const chunked = Buffer.from(
  "POST /chunks HTTP/1.1\r\n" +
  "Content-Type: text/plain\r\n" +
  "Transfer-Encoding: chunked\r\n\r\n" +
  "3\r\n123\r\n" +
  "6\r\n123456\r\n" +
  "9\r\n123456789\r\n" +
  "0\r\n\r\n",
);
parseAtEverySplit(chunked, "123123456123456789");

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.REQUEST, {});
  const collectedHeaders: string[] = [];
  let collectedUrl = "";
  let directHeaders: string[] | undefined;
  let directUrl: string | undefined;
  parser[kOnHeaders] = (headers: string[], url: string) => {
    collectedHeaders.push(...headers);
    collectedUrl += url;
  };
  parser[kOnHeadersComplete] = (
    _major: number,
    _minor: number,
    headers: string[] | undefined,
    _method: number,
    url: string | undefined,
  ) => {
    directHeaders = headers;
    directUrl = url;
  };
  const headers = Array.from({ length: 256 }, (_, index) => `X-Filler-${index}: ${index}\r\n`).join("");
  parser.execute(Buffer.from(`GET /many HTTP/1.1\r\n${headers}\r\n`));
  equal(directHeaders, undefined, "large header block should use kOnHeaders");
  equal(directUrl, undefined, "flushed URL should not be repeated");
  equal(collectedHeaders.length, 512, "large header pair count");
  equal(collectedHeaders[0], "X-Filler-0", "first large header");
  equal(collectedHeaders[511], "255", "last large header value");
  equal(collectedUrl, "/many", "fragmented URL aggregation");
}

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.REQUEST, {});
  parser[kOnHeadersComplete] = () => { throw new Error("callback sentinel"); };
  let callbackError: unknown;
  try {
    parser.execute(Buffer.from("GET /throw HTTP/1.1\r\n\r\n"));
  } catch (error) {
    callbackError = error;
  }
  equal((callbackError as Error)?.message, "callback sentinel", "callback exception propagation");

  let reinitialized = 0;
  parser.initialize(HTTPParser.REQUEST, {});
  parser[kOnHeadersComplete] = () => { reinitialized += 1; };
  parser.execute(Buffer.from("GET /again HTTP/1.1\r\n\r\n"));
  equal(reinitialized, 1, "parser reinitialize after callback exception");
}

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.RESPONSE, {});
  const bodies: string[] = [];
  let keepAlive: boolean | undefined;
  let completed = 0;
  parser[kOnHeadersComplete] = (
    _major: number,
    _minor: number,
    _headers: string[],
    _method: undefined,
    _url: undefined,
    status: number,
    _message: string,
    _upgrade: boolean,
    shouldKeepAlive: boolean,
  ) => {
    equal(status, 200, "EOF response status");
    keepAlive = shouldKeepAlive;
  };
  parser[kOnBody] = (body: Buffer) => bodies.push(body.toString());
  parser[kOnMessageComplete] = () => { completed += 1; };
  const wire = Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nbody-until-eof");
  parser.execute(wire.subarray(0, wire.length - 3));
  parser.execute(wire.subarray(wire.length - 3));
  equal(bodies.join(""), "body-until-eof", "EOF-delimited response body");
  equal(keepAlive, false, "EOF-delimited response keep-alive");
  equal(completed, 0, "EOF response incomplete before finish");
  equal(parser.finish(), undefined, "EOF response finish");
  equal(completed, 1, "EOF response completion");
}

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.RESPONSE, {});
  const statuses: number[] = [];
  let completed = 0;
  parser[kOnHeadersComplete] = (
    _major: number,
    _minor: number,
    _headers: string[],
    _method: undefined,
    _url: undefined,
    status: number,
  ) => { statuses.push(status); };
  parser[kOnMessageComplete] = () => { completed += 1; };
  const responses = Buffer.from(
    "HTTP/1.1 100 Continue\r\n\r\n" +
    "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
  );
  parser.execute(responses);
  equal(JSON.stringify(statuses), JSON.stringify([100, 200]), "multiple response statuses");
  equal(completed, 2, "multiple response completion");
}

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.RESPONSE, {});
  let completed = 0;
  let bodyCalls = 0;
  parser[kOnHeadersComplete] = () => 1;
  parser[kOnBody] = () => { bodyCalls += 1; };
  parser[kOnMessageComplete] = () => { completed += 1; };
  parser.execute(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n"));
  equal(bodyCalls, 0, "skip-body callback result");
  equal(completed, 1, "skip-body completion");
}

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.REQUEST, {}, 48);
  const overflow = parser.execute(Buffer.from(
    "GET / HTTP/1.1\r\nX-Header-That-Is-Too-Large: some-value\r\n\r\n",
  ));
  equal(overflow.code, "HPE_HEADER_OVERFLOW", "header overflow code");
  equal(overflow.reason, "Header overflow", "header overflow reason");
  assert(overflow.bytesParsed > 0, "header overflow bytesParsed");

  const chunk = new HTTPParser();
  chunk.initialize(HTTPParser.REQUEST, {});
  const invalidChunk = chunk.execute(Buffer.from(
    "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nnot-hex\r\n",
  ));
  equal(invalidChunk.code, "HPE_INVALID_CHUNK_SIZE", "invalid chunk size code");

  const invalidMethod = new HTTPParser();
  invalidMethod.initialize(HTTPParser.REQUEST, {});
  const invalidPrefix = invalidMethod.execute(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x00]));
  equal(invalidPrefix.code, "HPE_INVALID_METHOD", "invalid method prefix code");
  equal(invalidPrefix.reason, "Invalid method encountered", "invalid method prefix reason");
}

{
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.REQUEST, {});
  let method: number | undefined;
  parser[kOnHeadersComplete] = (
    _major: number,
    _minor: number,
    _headers: string[],
    parsedMethod: number,
  ) => { method = parsedMethod; };
  const wire = Buffer.from("M-SEARCH * HTTP/1.1\r\n\r\n");
  equal(parser.execute(wire, 5, 1), wire.length, "execute ignores legacy offset arguments");
  equal(method, 24, "M-SEARCH llhttp method enum");
  equal(methods[method!], "M - SEARCH", "Bun method table spelling");
}

console.log("node http_parser incremental stress passed");
