import assert from "node:assert/strict";
import { once } from "node:events";
import http2 from "node:http2";

const server = http2.createServer();
server.on("stream", (stream, headers) => {
  stream.on("error", () => {});
  if (headers[":path"] === "/hold") return;
  stream.respond({ ":status": 200 });
  stream.end("ok");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");

const client = http2.connect(`http://127.0.0.1:${address.port}`);
await once(client, "connect");
assert.equal(client.alpnProtocol, "h2c");
assert.throws(() => client.socket.write("invalid"), { code: "ERR_HTTP2_NO_SOCKET_MANIPULATION" });

const pingEvent = once(client, "ping");
const pingResult = new Promise<{ duration: number; payload: Buffer }>((resolve, reject) => {
  client.ping(Buffer.from("12345678"), (error, duration, payload) => {
    if (error) reject(error);
    else resolve({ duration, payload });
  });
});
const [{ duration, payload }, [eventPayload]] = await Promise.all([pingResult, pingEvent]);
assert.equal(typeof duration, "number");
assert.deepEqual(payload, Buffer.from("12345678"));
assert.deepEqual(eventPayload, payload);

const controller = new AbortController();
const request = client.request(
  { ":method": "POST", ":path": "/hold" },
  { signal: controller.signal },
);
const aborted = new Promise<void>(resolve => request.once("aborted", () => resolve()));
const requestError = new Promise<Error>(resolve => request.once("error", resolve));
controller.abort();
await aborted;
const error = await requestError;
assert.equal(error.name, "AbortError");
assert.equal(error.code, "ABORT_ERR");
assert.equal(request.aborted, true);
assert.equal(request.rstCode, http2.constants.NGHTTP2_CANCEL);

client.close();
server.close();
await once(server, "close");
console.log("node http2 session passed");
