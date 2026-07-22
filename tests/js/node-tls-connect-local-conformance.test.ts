import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import tls from "node:tls";
import { cert, key } from "./fixtures/tls-cert.js";

function connect(options: tls.ConnectionOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(options, () => resolve(socket));
    socket.once("error", reject);
  });
}

const server = tls.createServer({ cert, key, ALPNProtocols: ["http/1.1"] }, socket => {
  socket.on("error", () => {});
  socket.once("data", chunk => socket.end(`echo:${chunk}`));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");

const socket = await connect({
  host: "127.0.0.1",
  port: address.port,
  servername: "localhost",
  ALPNProtocols: ["http/1.1"],
  rejectUnauthorized: false,
});
assert.equal(socket.alpnProtocol, "http/1.1");
assert.equal(socket[Symbol.for("::buntlsconnectoptions::")].serverName, "localhost");
assert.equal(socket.getPeerCertificate().subject?.CN, "localhost");
const peerX509 = socket.getPeerX509Certificate();
assert.ok(peerX509 instanceof X509Certificate);
assert.equal(peerX509.checkHost("localhost"), "localhost");
assert.ok(socket.getCipher()?.name);
assert.match(String(socket.getProtocol()), /^TLSv1\.[23]$/);
assert.equal(typeof socket.getEphemeralKeyInfo(), "object");
assert.ok(Array.isArray(socket.getSharedSigalgs()));
assert.ok(Buffer.isBuffer(socket.getSession()));
assert.equal(socket.exportKeyingMaterial(32, "cottontail-local-conformance").byteLength, 32);
assert.equal(socket.isSessionReused(), false);

socket.write("ping");
const [echo] = await once(socket, "data");
assert.equal(echo.toString(), "echo:ping");
await once(socket, "end");

const callbackSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
  const connected = tls.connect(address.port, "127.0.0.1", {
    servername: "localhost",
    rejectUnauthorized: false,
  }, () => resolve(connected));
  connected.once("error", reject);
});
assert.equal(callbackSocket.remotePort, address.port);
assert.equal(callbackSocket[Symbol.for("::buntlsconnectoptions::")].serverName, "localhost");
callbackSocket.end();

const optionalCallbackSocket = tls.connect(address.port, "127.0.0.1", {
  servername: "localhost",
  rejectUnauthorized: false,
});
await once(optionalCallbackSocket, "secureConnect");
assert.equal(optionalCallbackSocket.remotePort, address.port);
optionalCallbackSocket.end();

const timeoutSocket = await connect({
  host: "127.0.0.1",
  port: address.port,
  servername: "localhost",
  rejectUnauthorized: false,
});
timeoutSocket.setTimeout(30);
await once(timeoutSocket, "timeout");
timeoutSocket.destroy();

server.close();
await once(server, "close");

const accepted = Promise.withResolvers<Bun.Socket>();
const connected = Promise.withResolvers<Bun.Socket>();
const listener = await Bun.listen({
  hostname: "localhost",
  port: 0,
  tls: { cert, key },
  socket: {
    handshake(socket) { accepted.resolve(socket); },
    data() {},
    close() {},
    error(_socket, error) { accepted.reject(error); },
  },
});
await Bun.connect({
  hostname: listener.hostname,
  port: listener.port,
  tls: { ca: cert, rejectUnauthorized: false },
  socket: {
    handshake(socket) { connected.resolve(socket); },
    data() {},
    close() {},
    error(_socket, error) { connected.reject(error); },
  },
});

const serverSocket = await accepted.promise;
const clientSocket = await connected.promise;
try {
  const localX509 = serverSocket.getX509Certificate();
  const remoteX509 = clientSocket.getPeerX509Certificate();
  assert.ok(localX509 instanceof X509Certificate);
  assert.ok(remoteX509 instanceof X509Certificate);
  assert.equal(localX509.checkHost("localhost"), "localhost");
  assert.equal(remoteX509.checkHost("localhost"), "localhost");
} finally {
  serverSocket.end();
  clientSocket.end();
  listener.stop();
}

console.log("node tls connect local conformance passed");
