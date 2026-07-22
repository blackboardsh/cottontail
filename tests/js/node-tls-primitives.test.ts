import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import tls from "node:tls";
import { cert, key } from "./fixtures/tls-cert.js";

function connect(options: tls.ConnectionOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(options, () => resolve(socket));
    socket.once("error", reject);
  });
}

assert.throws(() => tls.createServer({ cert, key, sessionTimeout: -1 }), { code: "ERR_OUT_OF_RANGE" });
assert.throws(() => tls.createServer({ cert, key, ticketKeys: "invalid" as any }), { code: "ERR_INVALID_ARG_TYPE" });
assert.throws(() => tls.createServer({ cert, key, ticketKeys: Buffer.alloc(47) }), { code: "ERR_INVALID_ARG_VALUE" });
assert.throws(() => tls.createSecureContext({ sessionIdContext: Buffer.alloc(1) as any }), { code: "ERR_INVALID_ARG_TYPE" });
assert.throws(() => tls.createServer({ cert, key, ALPNProtocols: ["h2"], ALPNCallback: () => "h2" }), {
  code: "ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS",
});
assert.throws(() => tls.createSecureContext({ cert: "not a certificate", key }), Error);

const initialTicketKeys = randomBytes(48);
const selectedContext = tls.createSecureContext({ cert, key, minVersion: "TLSv1.2", maxVersion: "TLSv1.2" });
let sniCalls = 0;
let alpnCalls = 0;
const server = tls.createServer({
  cert,
  key,
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
  ticketKeys: initialTicketKeys,
  sessionTimeout: 60,
  SNICallback(servername, callback) {
    sniCalls += 1;
    assert.equal(servername, "dynamic.local");
    setTimeout(() => callback(null, selectedContext), 2);
  },
  ALPNCallback({ servername, protocols }) {
    alpnCalls += 1;
    assert.equal(servername, "dynamic.local");
    assert.deepEqual(protocols, ["h2", "http/1.1"]);
    return protocols[1];
  },
}, socket => {
  socket.on("error", () => {});
  socket.once("data", () => socket.end("ok"));
});

const exposedKeys = server.getTicketKeys();
assert.deepEqual(exposedKeys, initialTicketKeys);
exposedKeys.fill(0);
assert.deepEqual(server.getTicketKeys(), initialTicketKeys);

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");

const firstSession = Promise.withResolvers<Buffer>();
const first = tls.connect({
  host: "127.0.0.1",
  port: address.port,
  servername: "dynamic.local",
  rejectUnauthorized: false,
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
  ALPNProtocols: ["h2", "http/1.1"],
});
first.once("error", firstSession.reject);
first.once("session", firstSession.resolve);
await once(first, "secureConnect");
assert.equal(first.alpnProtocol, "http/1.1");
const session = await firstSession.promise;
assert.ok(Buffer.isBuffer(session));
assert.deepEqual(session, first.getSession());
const firstClosed = once(first, "close");
first.resume();
first.write("close");
await firstClosed;

const resumed = await connect({
  host: "127.0.0.1",
  port: address.port,
  servername: "dynamic.local",
  rejectUnauthorized: false,
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
  ALPNProtocols: ["h2", "http/1.1"],
  session,
});
assert.equal(resumed.isSessionReused(), true);
const renegotiated = Promise.withResolvers<void>();
assert.equal(resumed.renegotiate({}, error => error ? renegotiated.reject(error) : renegotiated.resolve()), true);
await renegotiated.promise;
const resumedClosed = once(resumed, "close");
resumed.resume();
resumed.write("close");
await resumedClosed;

server.setTicketKeys(randomBytes(48));
assert.notDeepEqual(server.getTicketKeys(), initialTicketKeys);
const rotated = await connect({
  host: "127.0.0.1",
  port: address.port,
  servername: "dynamic.local",
  rejectUnauthorized: false,
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
  ALPNProtocols: ["h2", "http/1.1"],
  session,
});
assert.equal(rotated.isSessionReused(), false);
const rotatedClosed = once(rotated, "close");
rotated.resume();
rotated.write("close");
await rotatedClosed;

assert.equal(sniCalls, 3);
assert.equal(alpnCalls, 3);
server.close();
await once(server, "close");

console.log("node tls primitives passed");
