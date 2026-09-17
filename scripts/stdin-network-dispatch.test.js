import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = resolve(process.env.COTTONTAIL_TEST_BINARY || join(root, "zig-out/bin", process.platform === "win32" ? "cottontail.exe" : "cottontail"));

// The server must live outside the runtime under test. Initializing networking
// in that process first would mask a stdin-installed fd dispatcher's omissions.
async function fetchAfterStdin(setup, closeInput) {
  const server = createServer((_request, response) => response.end("network-after-stdio"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "cottontail-stdin-network-"));
  const entrypoint = join(directory, "child.ts");
  writeFileSync(entrypoint, `
    const timeout = setTimeout(() => {
      console.error("network stalled after stdio initialization");
      process.exit(1);
    }, 3000);
    ${setup}
    const response = await fetch("http://127.0.0.1:${server.address().port}/");
    console.log(await response.text());
    clearTimeout(timeout);
    // This regression tests dispatch while stdin is live, not stdin shutdown.
    process.exit(0);
  `);
  const child = spawn(binary, [entrypoint], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    // Leave stdin open until the HTTP response arrives.
    child.stdin.end();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    child.stdin.write("start\n");
    if (closeInput) child.stdin.end();
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual({ ...result, stdout, stderr }, {
      code: 0, signal: null, stdout: "network-after-stdio\n", stderr: "",
    });
  } finally {
    clearTimeout(timer);
    child.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const closeInput of [false, true]) {
  const lifetime = closeInput ? "with stdin EOF" : "while stdin stays open";
  test(`Bun.stdin read preserves later TCP connect events ${lifetime}`, async () => {
    await fetchAfterStdin(`
      const input = Bun.stdin.stream().getReader();
      await input.read();
    `, closeInput);
  });

  test(`process.stdin read preserves later TCP connect events ${lifetime}`, async () => {
    await fetchAfterStdin(`
      await new Promise((resolve, reject) => {
        process.stdin.once("data", resolve);
        process.stdin.once("error", reject);
      });
    `, closeInput);
  });
}
