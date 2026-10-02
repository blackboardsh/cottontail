import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("stack memo survives GC while bounding retained strings and invalidating changed maps", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-sourcemap-memo-"));
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(JSC_|COTTONTAIL_|DASH_|ELECTROBUN_)/.test(key)) delete env[key];
    }
    env.COTTONTAIL_TMP_DIR = directory;
    const child = Bun.spawnSync({
      cmd: [process.execPath, "--smol",
        join(import.meta.dir, "fixtures/runtime-sourcemap-retention.js"),
        resolve(import.meta.dir, "../../src/runtime_modules/vendor/sourcemap.js")],
      cwd: directory,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    const stderr = new TextDecoder().decode(child.stderr);
    if (child.exitCode !== 0) throw new Error(`Cottontail source-map memo regression failed: ${stderr}`);
    expect(stderr).toBe("");
    expect(JSON.parse(new TextDecoder().decode(child.stdout).trim())).toEqual({
      cottontail: true, repeatedStackReads: 1, boundsAndInvalidation: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 65_000);
