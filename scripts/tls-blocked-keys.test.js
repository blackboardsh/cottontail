import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = resolve(process.env.COTTONTAIL_TEST_BINARY || join(root, "zig-out", "bin", process.platform === "win32" ? "cottontail.exe" : "cottontail"));
const directory = join(root, "tests/js/fixtures/emsign");
const fixture = name => readFileSync(join(directory, name), "utf8");
const key = fixture("tls-test-key.pem");
const cleanEnvironment = { ...process.env };
for (const name of ["COTTONTAIL_RUNTIME_MODULES_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete cleanEnvironment[name];

async function runProbe(name, config, environment = {}) {
  const child = spawn(binary, [join(root, "tests/js/fixtures", name), JSON.stringify(config)], {
    cwd: root, env: { ...cleanEnvironment, ...environment }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", value => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
  const timeout = setTimeout(() => child.kill(), 45_000);
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 0, `Native TLS security probe failed: ${stdout}\n${stderr}`);
    return JSON.parse(stdout.trim().split("\n").at(-1));
  } finally { clearTimeout(timeout); }
}

async function withServer(cert, action) {
  const server = https.createServer({ key, cert }, (_request, response) => {
    response.setHeader("Connection", "close");
    response.end("verified");
  });
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await action(`https://127.0.0.1:${server.address().port}/`); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

function expectConnections(result, allowed) {
  for (const realm of ["main", "worker"]) {
    for (const name of ["tls", "https", "fetch"]) {
      const outcome = result[realm][name];
      assert.equal(outcome.ok, allowed, `${realm} ${name}: ${JSON.stringify(outcome)}`);
      if (allowed) assert.equal(outcome.value, name === "tls" ? "verified" : 200);
      else assert.equal(outcome.code, "CERT_REVOKED", `${realm} ${name}: ${JSON.stringify(outcome)}`);
    }
  }
}

test("native TLS distrust follows compromised keys across certificates and trust stores", async t => {
  const original = new X509Certificate(fixture("emsign-blocked-intermediate.pem"));
  const crossSigned = new X509Certificate(fixture("native-emsign-crosssigned-intermediate.pem"));
  const selfSigned = new X509Certificate(fixture("native-emsign-selfsigned-root.pem"));
  for (const certificate of [original, crossSigned, selfSigned]) {
    assert.equal(createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("hex"),
      "49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f");
  }
  assert.notEqual(original.fingerprint256, crossSigned.fingerprint256);
  assert.notEqual(original.issuer, crossSigned.issuer);
  const caFile = join(directory, "native-tls-test-ca.pem");
  await t.test("ordinary explicitly trusted TLS, HTTPS and fetch still work in main and worker", async () => {
    await withServer(fixture("native-tls-control-leaf.pem"), async url => {
      expectConnections(await runProbe("tls-ca-probe.mjs", { url, caFile }), true);
    });
  });
  await t.test("a cross-signed blocked key is revoked even beneath an explicitly trusted unrelated root", async () => {
    await withServer(fixture("native-emsign-crosssigned-leaf.pem") + fixture("native-emsign-crosssigned-intermediate.pem"), async url => {
      expectConnections(await runProbe("tls-ca-probe.mjs", { url, caFile }), false);
      expectConnections(await runProbe("tls-ca-probe.mjs", { url }, { NODE_EXTRA_CA_CERTS: caFile }), false);
      if (process.platform !== "win32") {
        expectConnections(await runProbe("tls-ca-probe.mjs", { url }, { SSL_CERT_FILE: caFile, SSL_CERT_DIR: join(directory, "missing") }), false);
      }
    });
  });
  await t.test("explicitly trusting the compromised key as a root cannot restore trust", async () => {
    await withServer(fixture("native-emsign-test-leaf.pem") + fixture("native-emsign-selfsigned-root.pem"), async url => {
      expectConnections(await runProbe("tls-ca-probe.mjs", { url, caFile: join(directory, "native-emsign-selfsigned-root.pem") }), false);
    });
  });
  await t.test("an incomplete untrusted chain still reports the revoked issuer", async () => {
    await withServer(fixture("native-emsign-test-leaf.pem") + fixture("emsign-blocked-intermediate.pem"), async url => {
      expectConnections(await runProbe("tls-ca-probe.mjs", { url, caFile: join(directory, "emsign-blocked-intermediate.pem") }), false);
    });
  });
  await t.test("native servers reject blocked client chains and preserve explicit insecure authorization state", async () => {
    assert.deepEqual(await runProbe("tls-blocked-auth-probe.mjs", {}), { mutualTLS: "CERT_REVOKED", insecureClient: "CERT_REVOKED", insecureServer: "CERT_REVOKED", strictResumption: "CERT_REVOKED" });
  });
});
