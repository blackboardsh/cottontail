import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cert, key } from "../tests/js/fixtures/tls-cert.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = process.env.COTTONTAIL_TEST_BINARY || join(root, "zig-out", "bin", process.platform === "win32" ? "cottontail.exe" : "cottontail");
const probe = join(root, "tests", "js", "fixtures", "tls-ca-probe.mjs");
const temporary = mkdtempSync(join(tmpdir(), "cottontail-tls-ca-"));
const trustedFile = join(temporary, "trusted.pem");
const unrelatedFile = join(root, "compat/upstream/node/v24.11.1/test/fixtures/keys/ca1-cert.pem");
const missing = join(temporary, "missing");
const certificates = join(temporary, "certificates");
mkdirSync(certificates);
writeFileSync(trustedFile, cert);
// OpenSSL's subject-name hash for the existing localhost test certificate.
writeFileSync(join(certificates, "ce275665.0"), cert);

const cleanEnvironment = { ...process.env };
for (const name of ["COTTONTAIL_RUNTIME_MODULES_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED"]) {
  delete cleanEnvironment[name];
}

async function runProbe(config, environment = {}, sandbox = false) {
  const args = [probe, JSON.stringify(config)];
  const profile = '(version 1)(allow default)(deny file-read* (subpath "/opt/homebrew/etc/openssl@3") (subpath "/opt/homebrew/etc/ca-certificates") (subpath "/usr/local/etc/openssl@3") (subpath "/usr/local/etc/ca-certificates"))';
  const child = spawn(sandbox ? "/usr/bin/sandbox-exec" : resolve(binary), sandbox ? ["-p", profile, resolve(binary), ...args] : args, {
    cwd: root,
    env: { ...cleanEnvironment, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", value => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
  const timeout = setTimeout(() => child.kill(), 60000);
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 0, `TLS probe failed: ${stdout}\n${stderr}`);
    const line = stdout.trim().split("\n").at(-1);
    return JSON.parse(line);
  } finally {
    clearTimeout(timeout);
  }
}

function expectConnections(result, expected, messagePattern) {
  for (const realm of ["main", "worker"]) {
    for (const name of ["tls", "https", "fetch"]) {
      const connection = result[realm][name];
      assert.equal(connection.ok, expected, `${realm} ${name}: ${JSON.stringify(connection)}`);
      if (expected) assert.equal(connection.value, name === "tls" ? "verified" : 200);
      else if (messagePattern) assert.match(connection.message, messagePattern, `${realm} ${name}`);
    }
  }
}

test("CA trust and overrides stay consistent for TLS, HTTPS, fetch and workers", async t => {
  const server = https.createServer({ key, cert }, (_request, response) => response.end("verified"));
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const config = { url: `https://127.0.0.1:${server.address().port}/` };
  const trustedEnvironment = process.platform === "win32"
    ? { NODE_EXTRA_CA_CERTS: trustedFile }
    : { SSL_CERT_FILE: trustedFile, SSL_CERT_DIR: missing };
  try {
    await t.test("default trust rejects an untrusted local certificate", async () => {
      expectConnections(await runProbe(config), false, /certificate/i);
    });
    await t.test("explicit CA authorizes the intended server", async () => {
      expectConnections(await runProbe({ ...config, caFile: trustedFile }), true);
    });
    await t.test("an empty explicit CA replaces otherwise trusted defaults", async () => {
      expectConnections(await runProbe({ ...config, emptyCA: true }, trustedEnvironment), false, /certificate/i);
    });
    await t.test("an unrelated explicit CA replaces otherwise trusted defaults", async () => {
      expectConnections(await runProbe({ ...config, caFile: unrelatedFile }, trustedEnvironment), false, /certificate/i);
    });
    await t.test("trusted certificates still require the correct hostname", async () => {
      expectConnections(await runProbe({ ...config, caFile: trustedFile, servername: "wrong-host.invalid" }), false, /hostname|altnames|IP does not match/i);
    });
    await t.test("extra CA configuration is honored in each realm", async () => {
      expectConnections(await runProbe(config, { NODE_EXTRA_CA_CERTS: trustedFile }), true);
    });
    await t.test("an explicit CA file works without a CA directory", { skip: process.platform === "win32" }, async () => {
      expectConnections(await runProbe(config, trustedEnvironment), true);
    });
    await t.test("a missing explicit CA file does not suppress a valid hashed directory", { skip: process.platform === "win32" }, async () => {
      expectConnections(await runProbe(config, { SSL_CERT_FILE: missing, SSL_CERT_DIR: certificates }), true);
    });
    await t.test("colon-separated CA directories are preserved", { skip: process.platform === "win32" }, async () => {
      expectConnections(await runProbe(config, { SSL_CERT_FILE: missing, SSL_CERT_DIR: `${missing}:${certificates}` }), true);
    });
    await t.test("invalid explicit CA locations fail closed", { skip: process.platform === "win32" }, async () => {
      expectConnections(await runProbe(config, { SSL_CERT_FILE: missing, SSL_CERT_DIR: missing }), false, /certificate/i);
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});

// Optional release smoke: the normal suite above is entirely local. This checks
// the real macOS system bundle against a public endpoint without Homebrew CA
// files, reproducing the clean-machine failure reported by Dash users.
test("macOS public HTTPS works with Homebrew CA files inaccessible", {
  skip: process.platform !== "darwin" || !process.env.COTTONTAIL_TLS_PUBLIC_URL,
}, async () => {
  const config = { url: process.env.COTTONTAIL_TLS_PUBLIC_URL };
  expectConnections(await runProbe(config, {}, true), true);
  expectConnections(await runProbe(config, { SSL_CERT_FILE: missing, SSL_CERT_DIR: missing }, true), false, /certificate/i);
  expectConnections(await runProbe(config, { SSL_CERT_FILE: "/etc/ssl/cert.pem", SSL_CERT_DIR: missing }, true), true);
});

process.on("exit", () => rmSync(temporary, { recursive: true, force: true }));
