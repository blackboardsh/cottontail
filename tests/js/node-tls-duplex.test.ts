import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { cert, key } from "./fixtures/tls-cert.js";

const rawSockets = new WeakMap<Duplex, net.Socket>();

assert.doesNotThrow(() => tls.createSecureContext({ ciphers: "HIGH:!aNULL" }));
assert.throws(
  () => tls.createSecureContext({ ciphers: "aes256-sha" }),
  (error: Error & { code?: string }) => error.code === "ERR_SSL_NO_CIPHER_MATCH",
);
const fragmentProbe = new tls.TLSSocket();
assert.equal(fragmentProbe.setMaxSendFragment(511), false, "small fragment should be rejected");
assert.equal(fragmentProbe.setMaxSendFragment(512), true, "minimum fragment should be accepted");
assert.throws(() => fragmentProbe.setServername(42 as never), { code: "ERR_INVALID_ARG_TYPE" });

class OpaqueSocket extends Duplex {
  constructor(socket: net.Socket) {
    super();
    rawSockets.set(this, socket);
    socket.on("data", (chunk) => {
      if (!this.push(chunk)) socket.pause();
    });
    socket.on("end", () => this.push(null));
    socket.on("close", () => this.push(null));
    socket.on("error", (error) => this.destroy(error));
    socket.on("drain", () => this.emit("drain"));
  }

  _read() {
    rawSockets.get(this)?.resume();
  }

  _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    rawSockets.get(this)?.write(chunk, encoding, callback);
  }

  _final(callback: (error?: Error | null) => void) {
    rawSockets.get(this)?.end(callback);
  }
}

const server = tls.createServer({ cert, key, ALPNProtocols: ["cottontail-test"] }, (socket) => {
  assert.equal(socket.getX509Certificate()?.subject, "CN=localhost", "server local X509 certificate");
  socket.once("data", (data) => {
    assert.equal(data.toString(), "duplex-ping");
    socket.end("duplex-pong");
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

const address = server.address();
assert.ok(address && typeof address === "object");
const transport = new OpaqueSocket(net.connect(address.port, "127.0.0.1"));
const socket = tls.connect({
  socket: transport,
  host: "127.0.0.1",
  servername: "localhost",
  rejectUnauthorized: false,
  ALPNProtocols: ["cottontail-test"],
});
let response = "";
socket.setEncoding("utf8");
socket.on("data", (chunk) => { response += chunk; });
socket.write("duplex-ping");

await once(socket, "secureConnect");
assert.equal(socket.alpnProtocol, "cottontail-test", "ALPN protocol");
assert.equal(socket[Symbol.for("::buntlsconnectoptions::")].serverName, "localhost", "Bun TLS metadata");
assert.equal((transport as Duplex & { _parentWrap?: unknown })._parentWrap, socket, "Duplex parent wrapper");
assert.equal(socket.getPeerCertificate().subject?.CN, "localhost", "legacy peer certificate");
assert.equal(socket.getPeerX509Certificate()?.subject, "CN=localhost", "peer X509 certificate");
assert.equal(socket.getX509Certificate(), undefined, "client local X509 certificate");
assert.equal(socket.setMaxSendFragment(1024), true, "negotiated max fragment");
assert.equal(socket.exportKeyingMaterial(32, "cottontail-duplex-test").byteLength, 32, "exported key material");

await once(socket, "end");
assert.equal(response, "duplex-pong");

server.close();
await once(server, "close");
console.log("node tls arbitrary Duplex transport passed");
