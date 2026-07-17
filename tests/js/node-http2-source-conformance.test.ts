import assert from "node:assert/strict";
import fs from "node:fs";
import http2 from "node:http2";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Duplex } from "node:stream";

function withTimeout<T>(promise: Promise<T>, label: string, timeout = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let body = "";
  stream.setEncoding?.("utf8");
  stream.on("data", chunk => { body += chunk; });
  await once(stream, "end");
  return body;
}

assert.equal(http2.sensitiveHeaders, Symbol.for("nodejs.http2.sensitiveHeaders"));
assert.equal(typeof http2.ClientHttp2Session, "function");
assert.throws(
  () => http2.getPackedSettings({ maxFrameSize: 1 }),
  { code: "ERR_HTTP2_INVALID_SETTING_VALUE" },
);
assert.throws(
  () => http2.getPackedSettings({ customSettings: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 20, i])) }),
  { code: "ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS" },
);
const customPacked = http2.getPackedSettings({ headerTableSize: 128, customSettings: { 240: 42 } });
assert.deepEqual(http2.getUnpackedSettings(customPacked), {
  enableConnectProtocol: false,
  headerTableSize: 128,
  customSettings: { 240: 42 },
});

const fixturePath = path.join(os.tmpdir(), `cottontail-http2-${process.pid}.txt`);
const fixtureBody = "source-first-http2-file\n".repeat(256);
fs.writeFileSync(fixturePath, fixtureBody);

const largeBody = "h".repeat(192 * 1024);
const server = http2.createServer();
server.updateSettings({ maxConcurrentStreams: 64 });

let serverSettingsAck: Promise<void> | undefined;
server.on("session", session => {
  assert.equal(session.type, http2.constants.NGHTTP2_SESSION_SERVER);
  assert.equal(session.connected, true);
  serverSettingsAck = new Promise((resolve, reject) => {
    session.settings({ maxConcurrentStreams: 64 }, (error, settings, duration) => {
      if (error) return reject(error);
      assert.equal(settings.maxConcurrentStreams, 64);
      assert.equal(typeof duration, "number");
      resolve();
    });
  });
});

server.on("stream", (stream, headers) => {
  assert.ok(stream instanceof Duplex);
  const requestPath = headers[":path"];
  if (requestPath === "/large") {
    stream.additionalHeaders({ ":status": 103, link: "</asset>; rel=preload" });
    stream.respond({
      ":status": 200,
      "content-type": "text/plain",
      "x-sensitive": "secret",
      [http2.sensitiveHeaders]: ["x-sensitive"],
    }, { waitForTrailers: true });
    stream.once("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.end(largeBody);
    return;
  }
  if (requestPath === "/upload") {
    let size = 0;
    stream.on("data", chunk => { size += chunk.byteLength; });
    stream.on("end", () => {
      stream.respond({ ":status": 200 });
      stream.end(String(size));
    });
    return;
  }
  if (requestPath === "/file") {
    stream.respondWithFile(fixturePath, { "content-type": "text/plain" });
    return;
  }
  if (requestPath === "/push") {
    stream.pushStream({ ":path": "/pushed" }, (error, pushStream) => {
      assert.ifError(error);
      pushStream.respond({ ":status": 200 });
      pushStream.end("pushed-body");
    });
    stream.respond({ ":status": 200 });
    stream.end("parent-body");
  }
});

server.on("request", (request, response) => {
  if (request.url !== "/compat") return;
  assert.equal(request.httpVersion, "2.0");
  assert.equal(request.authority, request.headers[":authority"]);
  assert.equal(typeof request.socket.destroy, "function");
  response.writeEarlyHints({ link: ["</one>; rel=preload", "</two>; rel=preload"] });
  response.setHeader("x-compat", "yes");
  response.appendHeader("set-cookie", "a=1");
  response.appendHeader("set-cookie", "b=2");
  response.addTrailers({ "grpc-status": "0", "grpc-message": "ok" });
  response.end("compat-body");
});

server.listen(0, "127.0.0.1");
await withTimeout(once(server, "listening"), "server listening");
const address = server.address();
assert.ok(address && typeof address === "object");

const client = http2.connect(`http://127.0.0.1:${address.port}`);
assert.ok(client instanceof http2.ClientHttp2Session);
await withTimeout(once(client, "connect"), "client connect");
assert.equal(client.type, http2.constants.NGHTTP2_SESSION_CLIENT);
assert.equal(client.connected, true);
assert.equal(client.alpnProtocol, "h2c");
assert.throws(() => client.socket.write("forbidden"), { code: "ERR_HTTP2_NO_SOCKET_MANIPULATION" });

const clientSettingsAck = new Promise<void>((resolve, reject) => {
  client.settings({ initialWindowSize: 128 * 1024, customSettings: { 241: 7 } }, (error, settings, duration) => {
    if (error) return reject(error);
    assert.equal(settings.initialWindowSize, 128 * 1024);
    assert.equal(settings.customSettings[241], 7);
    assert.equal(typeof duration, "number");
    resolve();
  });
});

const information: number[] = [];
let largeHeaders: http2.IncomingHttpHeaders | undefined;
let largeTrailers: http2.IncomingHttpHeaders | undefined;
const largeRequest = client.request({ ":path": "/large" });
largeRequest.on("headers", headers => information.push(Number(headers[":status"])));
largeRequest.on("response", headers => { largeHeaders = headers; });
largeRequest.on("trailers", headers => { largeTrailers = headers; });
const receivedLargeBody = await withTimeout(collect(largeRequest), "large response");
assert.equal(receivedLargeBody, largeBody);
assert.deepEqual(information, [103]);
assert.equal(largeHeaders?.[http2.sensitiveHeaders]?.[0], "x-sensitive");
assert.equal(largeTrailers?.["grpc-status"], "0");

const upload = client.request({ ":method": "POST", ":path": "/upload" });
upload.end(Buffer.alloc(160 * 1024, 1));
assert.equal(await withTimeout(collect(upload), "large upload"), String(160 * 1024));

const compat = client.request({ ":path": "/compat" });
const compatInfo: number[] = [];
let compatHeaders: http2.IncomingHttpHeaders | undefined;
let compatTrailers: http2.IncomingHttpHeaders | undefined;
compat.on("headers", headers => compatInfo.push(Number(headers[":status"])));
compat.on("response", headers => { compatHeaders = headers; });
compat.on("trailers", headers => { compatTrailers = headers; });
assert.equal(await withTimeout(collect(compat), "compat response"), "compat-body");
assert.deepEqual(compatInfo, [103]);
assert.equal(compatHeaders?.["x-compat"], "yes");
assert.deepEqual(compatHeaders?.["set-cookie"], ["a=1", "b=2"]);
assert.equal(compatTrailers?.["grpc-status"], "0");
assert.equal(compatTrailers?.["grpc-message"], "ok");

const fileRequest = client.request({ ":path": "/file" });
assert.equal(await withTimeout(collect(fileRequest), "file response"), fixtureBody);

const pushed = new Promise<string>((resolve, reject) => {
  client.once("stream", stream => {
    collect(stream).then(resolve, reject);
  });
});
const parent = client.request({ ":path": "/push" });
assert.equal(await withTimeout(collect(parent), "push parent"), "parent-body");
assert.equal(await withTimeout(pushed, "push stream"), "pushed-body");

await withTimeout(Promise.all([clientSettingsAck, serverSettingsAck]), "settings acknowledgements");
client.close();
await withTimeout(once(client, "close"), "client close");
server.close();
await withTimeout(once(server, "close"), "server close");

const handshakeServer = net.createServer(socket => {
  const session = http2.performServerHandshake(socket, { settings: { maxConcurrentStreams: 2 } });
  session.on("stream", stream => {
    stream.respond({ ":status": 200 });
    stream.end("handshake-ok");
  });
});
handshakeServer.listen(0, "127.0.0.1");
await withTimeout(once(handshakeServer, "listening"), "handshake server listening");
const handshakeAddress = handshakeServer.address();
assert.ok(handshakeAddress && typeof handshakeAddress === "object");
const handshakeClient = http2.connect(`http://127.0.0.1:${handshakeAddress.port}`);
const handshakeRequest = handshakeClient.request();
assert.equal(await withTimeout(collect(handshakeRequest), "performServerHandshake"), "handshake-ok");
handshakeClient.close();
handshakeServer.close();
await withTimeout(once(handshakeServer, "close"), "handshake server close");

fs.unlinkSync(fixturePath);
console.log("node http2 source conformance passed");
