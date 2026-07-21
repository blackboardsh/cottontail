import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bun test supports top-level await in CommonJS test files", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-test-cjs-await-"));
  try {
    writeFileSync(
      join(directory, "top-level.test.cjs"),
      `const { test, expect } = await import("bun:test");
test("top-level await", () => expect().pass());
`,
    );
    writeFileSync(
      join(directory, "nested.test.cjs"),
      `const { test, expect } = require("bun:test");
async function nested() { await Promise.resolve(); }
module.exports = { nested };
test("nested await remains CommonJS", () => expect(module.exports.nested).toBe(nested));
`,
    );

    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", "."],
      cwd: directory,
      env: { ...process.env, CI: "false" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stderr).toContain("2 pass");
    expect(stderr).toContain("0 fail");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
