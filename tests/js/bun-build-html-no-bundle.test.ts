import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("build rejects an HTML entrypoint with --no-bundle", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-html-no-bundle-"));
  const entrypoint = join(directory, "index.html");
  writeFileSync(entrypoint, "<!doctype html><script src='./index.js'></script>");
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "build", entrypoint, "--no-bundle"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("HTML imports are only supported when bundling");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
