import { expect, test } from "bun:test";

test("uncaught AssertionError from an exit handler keeps its Node error name", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `process.on("exit", () => {
        require("node:assert").fail("Unexpected global(s) found: gc");
      });`,
    ],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stderr = String(result.stderr);
  expect(result.exitCode).not.toBe(0);
  expect(stderr).toContain("AssertionError [ERR_ASSERTION]: Unexpected global(s) found: gc");
  expect(stderr).toMatch(/\bAssertionError\b.*\bUnexpected global\b.*\bgc\b/);
});
