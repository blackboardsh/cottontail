import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scripts, "..");
const temporary = mkdtempSync(path.join(tmpdir(), "cottontail-native-tls-"));
const fixturePath = name => path.join(root, "tests/js/fixtures/emsign", name);
const fixture = name => readFileSync(fixturePath(name), "utf8");
const zig = process.env.COTTONTAIL_TLS_TEST_ZIG || path.join(root, "vendors/zig", process.platform === "win32" ? "zig.exe" : "zig");
const probe = path.join(temporary, process.platform === "win32" ? "tls-probe.exe" : "tls-probe");
const zigLibrary = process.env.COTTONTAIL_TLS_TEST_ZIG_LIB_DIR;
const zigLibraryArgs = zigLibrary ? ["--zig-lib-dir", zigLibrary] : [];
const compile = spawnSync(zig, ["build-exe", ...zigLibraryArgs, path.join(scripts, "native-tls-probe.zig"), "-lc", "-OReleaseSmall", "-mcpu=baseline", `-femit-bin=${probe}`], {
  cwd: root, encoding: "utf8", timeout: 600_000,
});
assert.equal(compile.status, 0, compile.stderr || String(compile.error));

const cases = [
  { name: "benign CA", cert: ["native-tls-control-leaf.pem"], ca: "native-tls-test-ca.pem", accept: true },
  { name: "self-signed control", cert: ["native-tls-selfsigned-control.pem"], ca: "native-tls-selfsigned-control.pem", accept: true },
  { name: "explicit compromised intermediate", cert: ["native-emsign-test-leaf.pem", "emsign-blocked-intermediate.pem"], ca: "emsign-blocked-intermediate.pem" },
  { name: "compromised root omitted by peer", cert: ["native-emsign-test-leaf.pem"], ca: "native-emsign-selfsigned-root.pem" },
  { name: "cross-signed compromised intermediate", cert: ["native-emsign-crosssigned-leaf.pem", "native-emsign-crosssigned-intermediate.pem"], ca: "native-tls-test-ca.pem" },
];
let checks = 0;
async function run(mode, port, ca, expected, hostname = "localhost") {
  const child = spawn(probe, [mode, String(port), fixturePath(ca), expected, hostname], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, signal] = await once(child, "exit");
    assert.equal(code, 0, `${mode}: ${expected} (${signal || ""})\n${output}`);
    checks++;
  } finally { clearTimeout(timer); }
}
try {
  if (process.platform === "win32") {
    await run("windows-chain", 0, "native-emsign-selfsigned-root.pem", "CertificateRevoked");
    await run("windows-chain", 0, "native-emsign-crosssigned-intermediate.pem", "CertificateRevoked");
  }
  for (const tlsVersion of ["TLSv1.2", "TLSv1.3"]) {
    for (const scenario of cases) {
      const server = createServer({ key: fixture("tls-test-key.pem"), cert: scenario.cert.map(fixture).join("\n"), minVersion: tlsVersion, maxVersion: tlsVersion }, (_request, response) => {
        response.setHeader("Connection", "close");
        response.end("verified");
      });
      server.on("tlsClientError", () => {});
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const port = server.address().port;
      try {
        await run("tls", port, scenario.ca, scenario.accept ? "accept" : "CertificateRevoked");
        await run("http", port, scenario.ca, scenario.accept ? "accept" : "TlsInitializationFailed");
        if (!scenario.accept && scenario.cert.length > 1) {
          // Compromised keys are always refused, even for an explicitly
          // insecure low-level caller. This never weakens normal verification.
          await run("insecure", port, scenario.ca, "CertificateRevoked");
        }
        if (scenario.name === "benign CA") {
          await run("tls", port, scenario.ca, "CertificateHostMismatch", "wrong.invalid");
          await run("tls", port, "native-tls-selfsigned-control.pem", "TlsCertificateNotVerified");
        }
      } catch (error) {
        error.message = `${tlsVersion} ${scenario.name}: ${error.message}`;
        throw error;
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }
  }
  console.log(`OK native Zig TLS: ${checks} transport checks, including cross-signed and explicitly trusted compromised keys`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
