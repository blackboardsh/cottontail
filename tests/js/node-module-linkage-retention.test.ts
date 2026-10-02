import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("collected ESM linkage graphs preserve cached, cyclic and reloaded module behavior", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-linkage-retention-"));
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(JSC_|COTTONTAIL_|DASH_|ELECTROBUN_)/.test(key)) delete env[key];
    }
    if (process.env.COTTONTAIL_RUNTIME_MODULES_DIR) {
      env.COTTONTAIL_RUNTIME_MODULES_DIR = process.env.COTTONTAIL_RUNTIME_MODULES_DIR;
    }
    env.COTTONTAIL_TMP_DIR = join(directory, "runtime-cache");
    const child = Bun.spawnSync({
      cmd: [process.execPath, "--smol", join(import.meta.dir, "fixtures/node-module-linkage-retention.js"), directory],
      cwd: directory,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    const stderr = new TextDecoder().decode(child.stderr);
    if (child.exitCode !== 0) throw new Error(`Cottontail linkage retention regression failed: ${stderr}`);
    expect(stderr).toBe("");
    expect(JSON.parse(new TextDecoder().decode(child.stdout).trim())).toEqual({
      cottontail: true, linkageCollected: true, cachedIdentity: true,
      cyclicDiamond: true, changedSource: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 65_000);
