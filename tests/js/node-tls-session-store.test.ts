import assert from "node:assert/strict";
import { constants } from "node:crypto";
import { once } from "node:events";
import tls from "node:tls";
import { cert, key } from "./fixtures/tls-cert.js";

function connect(options: tls.ConnectionOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(options, () => resolve(socket));
    socket.once("error", reject);
  });
}

let storedSession: { id: Buffer; data: Buffer } | undefined;
let newSessionCalls = 0;
let resumeSessionCalls = 0;
const server = tls.createServer({
  cert,
  key,
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
  secureOptions: constants.SSL_OP_NO_TICKET,
}, socket => {
  socket.on("error", () => {});
  socket.end();
});
server.on("newSession", (id, data, done) => {
  newSessionCalls += 1;
  setTimeout(() => {
    storedSession = { id: Buffer.from(id), data: Buffer.from(data) };
    done();
  }, 5);
});
server.on("resumeSession", (id, callback) => {
  resumeSessionCalls += 1;
  assert.ok(storedSession);
  assert.deepEqual(id, storedSession.id);
  setTimeout(callback, 5, null, storedSession.data);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");

const first = tls.connect({
  host: "127.0.0.1",
  port: address.port,
  rejectUnauthorized: false,
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
  secureOptions: constants.SSL_OP_NO_TICKET,
});
const clientSession = once(first, "session");
await once(first, "secureConnect");
const serializedSession = (await clientSession)[0] as Buffer;
assert.ok(Buffer.isBuffer(serializedSession));
first.resume();
await once(first, "close");
assert.ok(storedSession);

const second = await connect({
  host: "127.0.0.1",
  port: address.port,
  rejectUnauthorized: false,
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
  secureOptions: constants.SSL_OP_NO_TICKET,
  session: serializedSession,
});
assert.equal(second.isSessionReused(), true);
second.resume();
await once(second, "close");
assert.equal(newSessionCalls, 1);
assert.equal(resumeSessionCalls, 1);
server.close();
await once(server, "close");

console.log("node tls session store passed");
