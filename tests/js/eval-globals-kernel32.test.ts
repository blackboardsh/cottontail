import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-eval-globals-"));
const missingRoot = join(root, "missing");
const existingRoot = join(root, "existing");
const runnerTemp = join(root, "runner-temp");
const missingWorkingDir = join(missingRoot, "a", "b");
const existingWorkingDir = join(existingRoot, "a", "b");

mkdirSync(missingWorkingDir, { recursive: true });
mkdirSync(existingWorkingDir, { recursive: true });
writeFileSync(join(missingWorkingDir, "config"), "true");
writeFileSync(join(existingWorkingDir, "hello"), "true");
writeFileSync(join(existingRoot, "config"), "true");

afterAll(() => rmSync(root, { recursive: true, force: true }));

function runEval(cwd: string, source: string) {
  const child = Bun.spawnSync([process.execPath, "-e", source], {
    cwd,
    env: { ...process.env, COTTONTAIL_TMP_DIR: runnerTemp },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const runRoot = join(runnerTemp, "cottontail", "run");
  expect(readdirSync(runRoot)).toEqual([]);
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

test("eval exposes Bun builtin module globals", () => {
  const result = runEval(existingWorkingDir, `
    const fsValue = fs;
    const assertValue = assert;
    const pathValue = path;
    const fsDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fs");
    const assertDescriptor = Object.getOwnPropertyDescriptor(globalThis, "assert");
    const values = {
      fs: fsValue === require("node:fs"),
      assert: assertValue === require("node:assert"),
      path: pathValue === require("node:path"),
      fsDescriptor: {
        writable: fsDescriptor.writable,
        enumerable: fsDescriptor.enumerable,
        configurable: fsDescriptor.configurable,
      },
      assertDescriptor: {
        writable: assertDescriptor.writable,
        enumerable: assertDescriptor.enumerable,
        configurable: assertDescriptor.configurable,
      },
    };
    console.log(JSON.stringify(values));
  `);
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toEqual({
    fs: true,
    assert: true,
    path: true,
    fsDescriptor: { writable: true, enumerable: true, configurable: true },
    assertDescriptor: { writable: true, enumerable: true, configurable: true },
  });
});

for (const [name, source] of [
  ["existsSync", 'assert.strictEqual(fs.existsSync("../../config"), false)'],
  ["accessSync", 'assert.throws(() => fs.accessSync("../../config"), { code: "ENOENT" })'],
]) {
  test(`${name} preserves a non-existing ../../ path`, () => {
    const result = runEval(missingWorkingDir, source);
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  });
}

for (const [name, source] of [
  ["existsSync", 'assert.strictEqual(fs.existsSync("../../config"), true)'],
  ["accessSync", 'assert.strictEqual(fs.accessSync("../../config"), null)'],
]) {
  test(`${name} preserves an existing ../../ path`, () => {
    const result = runEval(existingWorkingDir, source);
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  });
}
