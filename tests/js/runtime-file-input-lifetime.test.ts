import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-file-input-lifetime-"));
const lazyDirectory = join(root, "lazy");
const errorDirectory = join(root, "error");
const lazyEntry = join(lazyDirectory, "lazy-input.mjs");
const errorEntry = join(errorDirectory, "failure-input.mjs");
for (const directory of [lazyDirectory, errorDirectory]) {
  mkdirSync(directory);
  mkdirSync(join(directory, "cache"));
}

const literal = "retained-source-payload-0123456789".repeat(16_384);
writeFileSync(lazyEntry, [
  `function lazyValue() { return ${JSON.stringify(literal)}; }`,
  "await new Promise(resolve => setTimeout(resolve, 10));",
  "Bun.gc(true);",
  // First execution and source inspection happen after the native evaluator
  // has released its original file inputs and after a full collection.
  "const value = lazyValue();",
  `if (value.length !== ${literal.length}) throw new Error('lazy literal length changed');`,
  "if (!value.startsWith('retained-source-payload-0123456789') || !value.endsWith('0123456789')) throw new Error('lazy literal contents changed');",
  "if (!lazyValue.toString().includes(value)) throw new Error('lazy function source was lost');",
  "console.log('file-input-lifetime-ok');",
].join("\n"));
writeFileSync(errorEntry, [
  "function failAfterEvaluation() { throw new Error('file-input-cleanup-error'); }",
  "failAfterEvaluation();",
].join("\n"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(entry: string, directory: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("JSC_") || key.startsWith("COTTONTAIL_")) delete env[key];
  }
  env.COTTONTAIL_TMP_DIR = join(directory, "cache");
  env.BUN_JSC_verboseDiskCache = "1";
  const child = Bun.spawnSync({
    cmd: [process.execPath, "--smol", entry],
    cwd: directory,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  return {
    exitCode: child.exitCode,
    stdout: new TextDecoder().decode(child.stdout),
    stderr: new TextDecoder().decode(child.stderr),
  };
}

test("file inputs can be released before TLA, GC, and lazy function execution", () => {
  // Do not create files between these runs: the cache tracks directory names.
  for (const temperature of ["cold", "warm"]) {
    const child = run(lazyEntry, lazyDirectory);
    if (child.exitCode !== 0) throw new Error(`${temperature} lazy input probe failed: ${child.stderr}`);
    expect(child.stdout.trim()).toBe("file-input-lifetime-ok");
    if (temperature === "warm") {
      expect(child.stderr).toContain("[Disk Cache] Cache hit for sourceCode");
    }
    expect(child.stderr.replace(/^\[Disk Cache\] Cache (?:hit|miss) for sourceCode\r?\n/gm, "")).toBe("");
  }
}, 120_000);

test("synchronous exceptions preserve their source after input cleanup", () => {
  for (const temperature of ["cold", "warm"]) {
    const child = run(errorEntry, errorDirectory);
    if (child.exitCode !== 1) throw new Error(`${temperature} error probe returned ${child.exitCode}: ${child.stderr}`);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("file-input-cleanup-error");
    expect(child.stderr).toContain("failure-input.mjs");
    if (temperature === "warm") {
      expect(child.stderr).toContain("[Disk Cache] Cache hit for sourceCode");
    }
  }
}, 120_000);
