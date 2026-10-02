import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-runtime-options-"));
const source = 'import { basename } from "node:path"; console.log("runtime-options", basename("/a/b"));';
const cases = Object.fromEntries(["file", "eval", "stdin", "explicit", "explicit-smol"].map(name => {
  const directory = join(root, name);
  mkdirSync(directory);
  const entry = join(directory, "entry.mjs");
  writeFileSync(entry, source);
  const cache = join(directory, "cache");
  mkdirSync(cache);
  return [name, { directory, entry, cache }];
}));

afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(name: keyof typeof cases, args: string[], input?: string) {
  // Run the test runtime itself. Inherited policy/test flags could otherwise
  // hide an initialization-order bug or disable the launcher cache entirely.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("JSC_") || key.startsWith("COTTONTAIL_")) delete env[key];
  }
  env.JSC_dumpOptions = "2";
  env.COTTONTAIL_TMP_DIR = cases[name].cache;
  const child = Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd: cases[name].directory,
    env,
    stdout: "pipe",
    stderr: "pipe",
    ...(input === undefined ? {} : { stdin: new TextEncoder().encode(input) }),
    timeout: 60_000,
  });
  const stdout = new TextDecoder().decode(child.stdout);
  const stderr = new TextDecoder().decode(child.stderr);
  if (child.exitCode !== 0) throw new Error(`Cottontail option probe failed (${child.exitCode}): ${stderr}`);
  expect(stdout.trim()).toBe("runtime-options b");
  const mini = /^\s*forceMiniVMMode=(true|false)(?:\s|$)/m.exec(stderr)?.[1];
  const allocationLimit = /^\s*gcMaxHeapSize=(\d+)(?:\s|$)/m.exec(stderr)?.[1];
  // Inspect JSC's latched values, not process.env, which can change too late.
  return { mini, allocationLimit: allocationLimit === undefined ? undefined : Number(allocationLimit) };
}

test("smol policy reaches the first JSC VM with both cold and warm launcher caches", () => {
  // Keep the entry directory listing unchanged between runs: it participates
  // in cache validation. Probe output stays in memory rather than new files.
  const args = ["--smol", cases.file.entry];
  const cold = run("file", args);
  const warm = run("file", args);
  expect(cold).toEqual({ mini: "true", allocationLimit: 32 * 1024 * 1024 });
  expect(warm).toEqual(cold);
}, 120_000);

test("smol policy precedes eval bytecode generation", () => {
  expect(run("eval", ["--smol", "-e", source])).toEqual({
    mini: "true", allocationLimit: 32 * 1024 * 1024,
  });
}, 60_000);

test("smol policy precedes stdin bytecode generation", () => {
  expect(run("stdin", ["--smol", "-"], source)).toEqual({
    mini: "true", allocationLimit: 32 * 1024 * 1024,
  });
}, 60_000);

test("explicit allocation limit reaches the first JSC VM", () => {
  expect(run("explicit", ["--max-old-space-size=64", cases.explicit.entry])).toEqual({
    mini: "false", allocationLimit: 64 * 1024 * 1024,
  });
}, 60_000);

test("explicit allocation limit overrides the smol default", () => {
  expect(run("explicit-smol", ["--max-old-space-size=64", "--smol", cases["explicit-smol"].entry])).toEqual({
    mini: "true", allocationLimit: 64 * 1024 * 1024,
  });
}, 60_000);
