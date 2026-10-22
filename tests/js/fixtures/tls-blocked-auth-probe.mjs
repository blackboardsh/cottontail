import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import tls from "node:tls";
const fixture = name => readFileSync(new URL(`emsign/${name}`, import.meta.url), "utf8");
const key = fixture("tls-test-key.pem");
const ca = fixture("native-tls-test-ca.pem");
const blocked = fixture("native-emsign-crosssigned-leaf.pem") + fixture("native-emsign-crosssigned-intermediate.pem");
const control = fixture("native-tls-control-leaf.pem");

async function run({ serverCertificate = control, clientCertificate, rejectServer = true, rejectClient = true }) {
  const sockets = new Set();
  const server = tls.createServer({ key, cert: serverCertificate, ca, requestCert: !!clientCertificate, rejectUnauthorized: rejectClient }, socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.end(JSON.stringify({ authorized: socket.authorized, error: socket.authorizationError }));
  });
  let serverError;
  server.on("tlsClientError", error => { serverError = error; });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = tls.connect({ host: "127.0.0.1", port: server.address().port, ca,
    cert: clientCertificate, key: clientCertificate ? key : undefined,
    rejectUnauthorized: rejectServer, maxVersion: "TLSv1.2" });
  socket.setTimeout(8000, () => socket.destroy(new Error("TLS authentication timed out")));
  let clientError;
  let data = "";
  socket.on("error", error => { clientError = error; });
  socket.setEncoding("utf8").on("data", value => { data += value; });
  try {
    await new Promise(resolve => socket.once("close", resolve));
    return { serverError, clientError, data, authorized: socket.authorized, error: socket.authorizationError };
  } finally {
    socket.destroy();
    for (const peer of sockets) peer.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

const mutual = await run({ clientCertificate: blocked });
assert.equal(mutual.serverError?.code, "CERT_REVOKED");
assert.equal(mutual.data, "");
const insecureClient = await run({ serverCertificate: blocked, rejectServer: false });
assert.equal(insecureClient.clientError, undefined);
assert.equal(insecureClient.authorized, false);
assert.equal(insecureClient.error, "CERT_REVOKED");
const insecureServer = await run({ clientCertificate: blocked, rejectClient: false });
assert.equal(insecureServer.serverError, undefined);
const peer = JSON.parse(insecureServer.data);
assert.equal(peer.authorized, false);
assert.equal(peer.error, "CERT_REVOKED");
// A session obtained through explicit insecure mode must not carry a revoked
// issuer into a later strict connection without a fresh certificate check.
const resumeServer = tls.createServer({ key, cert: blocked, maxVersion: "TLSv1.2" }, socket => {
  socket.on("error", () => {});
  socket.end("session");
});
resumeServer.on("tlsClientError", () => {});
resumeServer.listen(0, "127.0.0.1");
await once(resumeServer, "listening");
const options = { host: "127.0.0.1", port: resumeServer.address().port, ca, maxVersion: "TLSv1.2" };
let session;
try {
  const first = tls.connect({ ...options, rejectUnauthorized: false });
  first.on("error", () => {});
  first.once("secureConnect", () => { session = first.getSession(); });
  first.resume();
  first.setTimeout(8000, () => first.destroy(new Error("Session setup timed out")));
  await new Promise(resolve => first.once("close", resolve));
  assert.ok(session?.length, "The insecure connection must produce a resumable session");
  const strict = tls.connect({ ...options, session });
  strict.setTimeout(8000, () => strict.destroy(new Error("Strict session probe timed out")));
  let outcome;
  strict.once("secureConnect", () => { outcome = "accepted"; strict.destroy(); });
  strict.once("error", error => { outcome = error.code; });
  await new Promise(resolve => strict.once("close", resolve));
  assert.equal(outcome, "CERT_REVOKED", "Resuming an insecure session must not bypass the blocked issuer");
} finally { await new Promise(resolve => resumeServer.close(resolve)); }
console.log(JSON.stringify({ mutualTLS: mutual.serverError.code, insecureClient: insecureClient.error, insecureServer: peer.error, strictResumption: "CERT_REVOKED" }));
