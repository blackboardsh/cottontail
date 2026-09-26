import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("node:test imports work without first loading node:module", () => {
  const root = mkdtempSync(join(tmpdir(), "cottontail-node-test-"));
  try {
    const entry = join(root, "direct.test.mjs");
    writeFileSync(entry, `
      import test from "node:test";
      import assert from "node:assert/strict";
      test("direct node test", () => {
        assert.equal(1 + 1, 2);
        console.log("node-test-entry-pass");
      });
    `);
    for (const args of [["test", entry], ["test", root]]) {
      const child = Bun.spawnSync({ cmd: [process.execPath, ...args] });
      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString()).toContain("node-test-entry-pass");
    }
    writeFileSync(entry, `import test from "node:test"; test("failure", () => { throw new Error("intentional failure"); });`);
    const failure = Bun.spawnSync({ cmd: [process.execPath, "test", entry] });
    expect(failure.exitCode).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
