import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = resolve(process.env.COTTONTAIL_TEST_BINARY || join(root, "zig-out/bin", process.platform === "win32" ? "cottontail.exe" : "cottontail"));
const env = { ...process.env };
delete env.COTTONTAIL_RUNTIME_MODULES_DIR;

for (const { name, args, stream, status, marker } of [
  { name: "native CLI stdout", args: ["--version"], stream: 1, status: 0, marker: /\d+\.\d+\.\d+/ },
  { name: "native CLI stderr", args: ["--eval"], stream: 2, status: 1, marker: /requires a script argument/ },
]) {
  test(`${name} preserves inherited regular-file offsets`, () => {
    const directory = mkdtempSync(join(tmpdir(), "cottontail-stdio-"));
    try {
      const piped = spawnSync(binary, args, { cwd: directory, env, encoding: "utf8", timeout: 30_000 });
      assert.ifError(piped.error);
      assert.equal(piped.status, status, piped.stderr || piped.stdout);
      const expected = stream === 1 ? piped.stdout : piped.stderr;
      assert.match(expected, marker);
      const output = join(directory, "redirected.log");
      const fd = openSync(output, "w", 0o600);
      let redirected;
      try {
        writeSync(fd, "parent-before\n");
        const stdio = ["ignore", "pipe", "pipe"];
        stdio[stream] = fd;
        redirected = spawnSync(binary, args, { cwd: directory, env, stdio, encoding: "utf8", timeout: 30_000 });
        writeSync(fd, "parent-after\n");
      } finally {
        closeSync(fd);
      }
      assert.ifError(redirected.error);
      assert.equal(redirected.status, status);
      assert.equal(readFileSync(output, "utf8"), `parent-before\n${expected}parent-after\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
