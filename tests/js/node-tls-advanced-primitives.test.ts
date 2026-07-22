import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import tls from "node:tls";

const keys = join(
  import.meta.dir,
  "../../compat/upstream/bun/v1.3.10/test/js/node/test/fixtures/keys",
);
const read = (name: string) => readFileSync(join(keys, name));
const pfx = read("agent1.pfx");
const key = read("agent1-key.pem");
const cert = read("agent1-cert.pem");
const ca = read("ca1-cert.pem");

tls.createSecureContext({
  cert,
  key,
  ca,
  crl: read("ca2-crl.pem"),
  dhparam: read("dh2048.pem"),
  ecdhCurve: "prime256v1",
  sigalgs: "rsa_pss_rsae_sha256:rsa_pkcs1_sha256",
});
tls.createSecureContext({ pfx, passphrase: "sample" });
assert.throws(() => tls.createSecureContext({ pfx, passphrase: "wrong" }), { code: "ERR_SSL_PKCS12_PARSE_ERROR" });
assert.throws(() => tls.createSecureContext({ crl: Buffer.from("invalid") }), { code: "ERR_CRYPTO_OPERATION_FAILED" });
assert.throws(() => tls.createSecureContext({ dhparam: read("dh512.pem") }), { code: "ERR_INVALID_ARG_VALUE" });
assert.throws(() => tls.createSecureContext({ sigalgs: "not-a-signature-algorithm" }), { code: "ERR_SSL_INVALID_SIGALGS" });

let ocspCalls = 0;
// OCSPResponse { responseStatus: unauthorized } with no responseBytes.
const stapledResponse = Buffer.from("30030a0106", "hex");
const ocspServer = tls.createServer({ pfx, passphrase: "sample", ca }, socket => {
  socket.on("error", () => {});
  socket.end();
});
ocspServer.on("OCSPRequest", (certificate, issuer, callback) => {
  ocspCalls += 1;
  assert.ok(Buffer.isBuffer(certificate));
  assert.ok(certificate.byteLength > 0);
  assert.ok(Buffer.isBuffer(issuer));
  assert.ok(issuer.byteLength > 0);
  setTimeout(callback, 5, null, stapledResponse);
});
ocspServer.listen(0, "127.0.0.1");
await once(ocspServer, "listening");
const ocspAddress = ocspServer.address();
assert.ok(ocspAddress && typeof ocspAddress === "object");
const ocspClient = tls.connect({
  host: "127.0.0.1",
  port: ocspAddress.port,
  requestOCSP: true,
  rejectUnauthorized: false,
});
const ocspResponse = once(ocspClient, "OCSPResponse");
await once(ocspClient, "secureConnect");
assert.deepEqual((await ocspResponse)[0], stapledResponse);
ocspClient.resume();
await once(ocspClient, "close");
assert.equal(ocspCalls, 1);
ocspServer.close();
await once(ocspServer, "close");

console.log("node tls advanced primitives passed");
