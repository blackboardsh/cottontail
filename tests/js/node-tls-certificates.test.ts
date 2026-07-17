import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import tls from "node:tls";

const keysDirectory = join(
  import.meta.dir,
  "../../compat/upstream/node/v24.11.1/test/fixtures/keys",
);
const readKey = (name: string) => readFileSync(join(keysDirectory, name), "utf8");
const key = readKey("agent6-key.pem");
const cert = readKey("agent6-cert.pem");
const ca = readKey("ca1-cert.pem");
const clientUsageCertificate = new X509Certificate(readKey("agent4-cert.pem"));
assert.deepEqual(clientUsageCertificate.keyUsage, ["1.3.6.1.5.5.7.3.2"]);
assert.deepEqual(clientUsageCertificate.toLegacyObject().ext_key_usage, ["1.3.6.1.5.5.7.3.2"]);

const repeatedNameCertificate = new X509Certificate(readFileSync(join(
  import.meta.dir,
  "../../compat/upstream/node/v24.11.1/test/fixtures/x509-escaping/subj-8-cert.pem",
)));
assert.deepEqual(repeatedNameCertificate.toLegacyObject().subject.L, ["L1", "L2", "L3"]);

const originalDefaultCAs = tls.getCACertificates("default");
assert.strictEqual(tls.getCACertificates("bundled"), tls.rootCertificates);
assert.strictEqual(tls.getCACertificates("bundled"), tls.getCACertificates("bundled"));
assert.strictEqual(tls.getCACertificates("system"), tls.getCACertificates("system"));
assert.strictEqual(tls.getCACertificates("extra"), tls.getCACertificates("extra"));
assert.strictEqual(originalDefaultCAs, tls.getCACertificates());
assert.ok(Object.isFrozen(tls.rootCertificates));
assert.ok(Object.isFrozen(originalDefaultCAs));
assert.equal(tls.rootCertificates.length, new Set(tls.rootCertificates).size);
assert.ok(tls.rootCertificates.every((value) => value.startsWith("-----BEGIN CERTIFICATE-----\n")));
assert.ok(tls.rootCertificates.every((value) => value.endsWith("\n-----END CERTIFICATE-----")));

const originalRootCount = tls.rootCertificates.length;
assert.throws(() => tls.rootCertificates.push(ca), TypeError);
assert.throws(() => { tls.rootCertificates[0] = ca; }, TypeError);
assert.throws(() => { (tls as any).rootCertificates = [ca]; }, TypeError);
assert.equal(tls.rootCertificates.length, originalRootCount);

const extraCAProbe = spawnSync(process.execPath, ["-e", `
  const fs = require("fs");
  const tls = require("tls");
  const expected = fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8");
  const extra = tls.getCACertificates("extra");
  const defaults = tls.getCACertificates("default");
  if (extra.length !== 1 || extra[0] !== expected || !defaults.includes(expected)) process.exit(2);
  if (!Object.isFrozen(extra) || extra !== tls.getCACertificates("extra")) process.exit(3);
  console.log("extra-ca-ok");
`], {
  env: { ...process.env, NODE_EXTRA_CA_CERTS: join(keysDirectory, "ca1-cert.pem") },
  encoding: "utf8",
});
assert.equal(extraCAProbe.status, 0, extraCAProbe.stderr);
assert.match(extraCAProbe.stdout, /extra-ca-ok/);

tls.setDefaultCACertificates([ca]);
const configuredDefaultCAs = tls.getCACertificates();
assert.deepEqual(configuredDefaultCAs, [ca]);
assert.strictEqual(configuredDefaultCAs, tls.getCACertificates("default"));
assert.ok(Object.isFrozen(configuredDefaultCAs));

let serverCertificate: ReturnType<tls.TLSSocket["getX509Certificate"]>;
let resolveServerCertificate: () => void;
const serverCertificateReady = new Promise<void>((resolve) => { resolveServerCertificate = resolve; });
const server = tls.createServer({ cert, key }, (socket) => {
  serverCertificate = socket.getX509Certificate();
  resolveServerCertificate();
  socket.end("certificate-chain");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

const address = server.address();
assert.ok(address && typeof address === "object");
const socket = tls.connect({
  port: address.port,
  host: "127.0.0.1",
  checkServerIdentity: () => undefined,
});
await once(socket, "secureConnect");

const brief = socket.getPeerCertificate();
assert.equal(brief.subject.CN, "\u00c1d\u00e1m Lippai");
assert.equal(brief.issuer.CN, "ca3");
assert.match(brief.serialNumber, /5B75D77EDC7FB5B7FA9F1424DA4C64FB815DCBDE/i);

const detailed = socket.getPeerCertificate(true);
const intermediate = detailed.issuerCertificate;
const root = intermediate.issuerCertificate;
assert.equal(intermediate.subject.CN, "ca3");
assert.equal(intermediate.issuer.CN, "ca1");
assert.match(intermediate.serialNumber, /147D36C1C2F74206DE9FAB5F2226D78ADB00A425/i);
assert.equal(root.subject.CN, "ca1");
assert.equal(root.issuer.CN, "ca1");
assert.match(root.serialNumber, /4AB16C8DFD6A7D0D2DFCABDF9C4B0E92C6AD0229/i);
assert.strictEqual(root.issuerCertificate, root);

const peerX509 = socket.getPeerX509Certificate();
assert.ok(peerX509 instanceof X509Certificate);
assert.ok(peerX509.issuerCertificate instanceof X509Certificate);
assert.match(peerX509.issuerCertificate.serialNumber, /147D36C1C2F74206DE9FAB5F2226D78ADB00A425/i);
assert.equal(peerX509.issuerCertificate.issuerCertificate, undefined);
await serverCertificateReady;
assert.ok(serverCertificate instanceof X509Certificate);
assert.match(serverCertificate.serialNumber, /5B75D77EDC7FB5B7FA9F1424DA4C64FB815DCBDE/i);

socket.destroy();
server.close();
await once(server, "close");
tls.setDefaultCACertificates(originalDefaultCAs);

console.log("node tls certificate semantics passed");
