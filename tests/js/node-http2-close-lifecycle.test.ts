import assert from "node:assert/strict";
import { once } from "node:events";
import http2 from "node:http2";

const observed: string[] = [];
const server = http2.createServer();
server.on("sessionError", error => observed.push(`server-session:${error.code}`));
server.on("stream", stream => {
  stream.on("error", error => observed.push(`server-stream:${error.code}`));
  stream.respond();
  stream.end("ok");
});
server.listen(0);
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");

const client = http2.connect(`http://localhost:${address.port}`);
client.on("error", error => observed.push(`client-session:${error.code}`));
const request = client.request();
request.on("error", error => observed.push(`client-stream:${error.code}`));
const closed = new Promise<void>(resolve => request.once("close", () => resolve()));
request.close(http2.constants.NGHTTP2_PROTOCOL_ERROR);
request.resume();
request.end();
await closed;

assert.equal(request.destroyed, true);
assert.equal(request.rstCode, http2.constants.NGHTTP2_PROTOCOL_ERROR);
assert.ok(observed.includes("client-stream:ERR_HTTP2_STREAM_ERROR"));

client.close();
server.close();
await once(server, "close");
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(observed.some(item => item.includes("ECONNRESET")), false, observed.join(", "));
console.log("node http2 close lifecycle passed");
