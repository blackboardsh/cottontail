import assert from "node:assert/strict";
import { once } from "node:events";
import http2 from "node:http2";

assert.equal(Object.keys(http2.constants).length, 240);
assert.equal(http2.constants.HTTP2_HEADER_CONTENT_SECURITY_POLICY, "content-security-policy");
assert.equal(http2.constants.HTTP2_METHOD_VERSION_CONTROL, "VERSION-CONTROL");
assert.equal(http2.constants.HTTP_STATUS_NETWORK_AUTHENTICATION_REQUIRED, 511);
assert.deepEqual(http2.getDefaultSettings(), {
  headerTableSize: 4096,
  enablePush: false,
  initialWindowSize: 65535,
  maxFrameSize: 16384,
  maxConcurrentStreams: 0xffffffff,
  maxHeaderSize: 65535,
  maxHeaderListSize: 65535,
  enableConnectProtocol: false,
}, "default settings");

const packed = http2.getPackedSettings({
  headerTableSize: 1,
  enablePush: false,
  initialWindowSize: 2,
  maxFrameSize: 32768,
  maxConcurrentStreams: 4,
  maxHeaderListSize: 5,
  enableConnectProtocol: false,
});
assert.equal(packed.byteLength, 36);
assert.deepEqual(http2.getUnpackedSettings(packed), {
  headerTableSize: 1,
  enablePush: false,
  initialWindowSize: 2,
  maxFrameSize: 32768,
  maxConcurrentStreams: 4,
  maxHeaderSize: 5,
  maxHeaderListSize: 5,
  enableConnectProtocol: false,
}, "packed settings round trip");

const server = http2.createServer();
server.on("stream", (stream, headers) => {
  if (headers[":path"] === "/client-trailers") {
    stream.once("trailers", trailers => {
      stream.respond({ ":status": 200 });
      stream.end(JSON.stringify(trailers));
    });
    return;
  }
  assert.equal(Object.keys(headers).filter(name => name.startsWith("x-request-")).length, 220);
  const responseHeaders: http2.OutgoingHttpHeaders = {
    ":status": 200,
    "x-sensitive": "secret",
    [http2.sensitiveHeaders]: ["x-sensitive"],
  };
  for (let index = 0; index < 180; index++) responseHeaders[`x-response-${index}`] = "r".repeat(120);
  stream.respond(responseHeaders, { waitForTrailers: true });
  stream.once("wantTrailers", () => {
    const trailers: http2.OutgoingHttpHeaders = {};
    for (let index = 0; index < 100; index++) trailers[`x-trailer-${index}`] = "t".repeat(120);
    stream.sendTrailers(trailers);
  });
  stream.end("ok");
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");

const client = http2.connect(`http://127.0.0.1:${address.port}`);
const requestHeaders: http2.OutgoingHttpHeaders = {};
for (let index = 0; index < 220; index++) requestHeaders[`x-request-${index}`] = "q".repeat(120);
const request = client.request(requestHeaders);
let responseHeaders: http2.IncomingHttpHeaders | undefined;
let responseTrailers: http2.IncomingHttpHeaders | undefined;
let body = "";
request.setEncoding("utf8");
request.on("response", headers => { responseHeaders = headers; });
request.on("trailers", headers => { responseTrailers = headers; });
request.on("data", chunk => { body += chunk; });
await once(request, "end");

assert.equal(body, "ok");
assert.equal(Object.keys(responseHeaders ?? {}).filter(name => name.startsWith("x-response-")).length, 180);
assert.deepEqual(responseHeaders?.[http2.sensitiveHeaders], ["x-sensitive"], "sensitive header metadata");
assert.equal(Object.keys(responseTrailers ?? {}).filter(name => name.startsWith("x-trailer-")).length, 100);

const trailerRequest = client.request(
  { ":method": "POST", ":path": "/client-trailers" },
  { waitForTrailers: true },
);
let trailerResponse = "";
trailerRequest.setEncoding("utf8");
trailerRequest.on("wantTrailers", () => trailerRequest.sendTrailers({ "x-client-trailer": "present" }));
trailerRequest.on("data", chunk => { trailerResponse += chunk; });
trailerRequest.end("body");
await once(trailerRequest, "end");
assert.deepEqual(JSON.parse(trailerResponse), { "x-client-trailer": "present" });

client.close();
server.close();
await once(server, "close");
console.log("node http2 core passed");
