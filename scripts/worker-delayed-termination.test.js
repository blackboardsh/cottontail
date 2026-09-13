import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = resolve(process.env.COTTONTAIL_TEST_BINARY || join(root, "zig-out/bin", process.platform === "win32" ? "cottontail.exe" : "cottontail"));
const env = { ...process.env };
delete env.COTTONTAIL_RUNTIME_MODULES_DIR;
const binarySha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");

for (const mode of ["top-level", "message-handler", "web-message-handler"]) {
  test(`delayed hard termination interrupts a continuous ${mode} worker invocation`, (t) => {
    t.diagnostic(`runtime ${binary}; sha256 ${binarySha256}`);
    // The fixture only creates worker threads, so killing this exact owned
    // process also stops all tested workers on POSIX and Windows. SIGKILL makes
    // a broken shutdown path unable to extend the driver's deadline.
    const result = spawnSync(binary, [join(root, "tests/js/fixtures/worker-delayed-termination.mjs"), mode], {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.ifError(result.error && new Error(`${result.error.message}\n${output}`));
    assert.equal(result.signal, null, output);
    assert.equal(result.status, 0, output);
    const events = result.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => [event.stage, event.mode]), [["terminate-requested", mode], ["passed", mode]]);
    assert.equal(events[1].exitEvents, 1);
    t.diagnostic(JSON.stringify(events[1]));
  });
}
