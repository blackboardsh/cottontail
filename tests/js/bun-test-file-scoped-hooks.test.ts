import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("top-level per-test hooks stay scoped to their registering file", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-file-scoped-hooks-"));
  try {
    writeFileSync(join(directory, "a.test.ts"), `
import { afterEach, beforeEach, expect, test } from "bun:test";

(globalThis as any).__fileBeforeEvents = [];
(globalThis as any).__fileAfterEvents = [];
beforeEach(() => (globalThis as any).__fileBeforeEvents.push("a"));
afterEach(() => (globalThis as any).__fileAfterEvents.push("a"));

test("file a", () => {
  expect((globalThis as any).__fileBeforeEvents).toEqual(["a"]);
  (globalThis as any).__fileBeforeEvents = [];
  (globalThis as any).__fileAfterEvents = [];
});
`);
    writeFileSync(join(directory, "b.test.ts"), `
import { afterEach, beforeEach, expect, test } from "bun:test";

beforeEach(() => (globalThis as any).__fileBeforeEvents.push("b"));
afterEach(() => (globalThis as any).__fileAfterEvents.push("b"));

test("file b", () => {
  expect((globalThis as any).__fileBeforeEvents).toEqual(["b"]);
  expect((globalThis as any).__fileAfterEvents).toEqual(["a"]);
});
`);

    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", "a.test.ts", "b.test.ts"],
      cwd: directory,
      env: { ...process.env, CI: "false" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode, stderr).toBe(0);
    expect(stderr).toContain("2 pass");
    expect(stderr).toContain("0 fail");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("top-level lifecycle hooks use per-file suite boundaries", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-file-lifecycle-hooks-"));
  try {
    writeFileSync(join(directory, "a.test.ts"), `
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

(globalThis as any).__fileLifecycle = [];
beforeAll(() => (globalThis as any).__fileLifecycle.push("a:beforeAll"));
beforeEach(() => (globalThis as any).__fileLifecycle.push("a:beforeEach"));
afterEach(() => (globalThis as any).__fileLifecycle.push("a:afterEach"));
afterAll(() => (globalThis as any).__fileLifecycle.push("a:afterAll"));

test("file a", () => {
  expect((globalThis as any).__fileLifecycle).toEqual(["a:beforeAll", "a:beforeEach"]);
});
`);
    writeFileSync(join(directory, "b.test.ts"), `
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

beforeAll(() => (globalThis as any).__fileLifecycle.push("b:beforeAll"));
beforeEach(() => (globalThis as any).__fileLifecycle.push("b:beforeEach"));
afterEach(() => (globalThis as any).__fileLifecycle.push("b:afterEach"));
afterAll(() => (globalThis as any).__fileLifecycle.push("b:afterAll"));

test("file b", () => {
  expect((globalThis as any).__fileLifecycle).toEqual([
    "a:beforeAll",
    "a:beforeEach",
    "a:afterEach",
    "a:afterAll",
    "b:beforeAll",
    "b:beforeEach",
  ]);
});
`);

    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", "a.test.ts", "b.test.ts"],
      cwd: directory,
      env: { ...process.env, CI: "false" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode, stderr).toBe(0);
    expect(stderr).toContain("2 pass");
    expect(stderr).toContain("0 fail");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preload per-test hooks remain global across test files", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-global-preload-hooks-"));
  try {
    writeFileSync(join(directory, "preload.ts"), `
import { beforeEach } from "bun:test";

(globalThis as any).__preloadHookCalls = 0;
beforeEach(() => (globalThis as any).__preloadHookCalls++);
`);
    writeFileSync(join(directory, "a.test.ts"), `
import { expect, test } from "bun:test";
test("file a", () => expect((globalThis as any).__preloadHookCalls).toBe(1));
`);
    writeFileSync(join(directory, "b.test.ts"), `
import { expect, test } from "bun:test";
test("file b", () => expect((globalThis as any).__preloadHookCalls).toBe(2));
`);

    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", "--preload=./preload.ts", "a.test.ts", "b.test.ts"],
      cwd: directory,
      env: { ...process.env, CI: "false" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode, stderr).toBe(0);
    expect(stderr).toContain("2 pass");
    expect(stderr).toContain("0 fail");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CommonJS require resolves from each test file in an aggregate", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-file-require-"));
  try {
    writeFileSync(join(directory, "a-dep.cjs"), 'module.exports = "a";\n');
    writeFileSync(join(directory, "b-dep.cjs"), 'module.exports = "b";\n');
    writeFileSync(join(directory, "a.test.ts"), `
import { expect, test } from "bun:test";
test("file a require", () => expect(require("./a-dep.cjs")).toBe("a"));
`);
    writeFileSync(join(directory, "b.test.ts"), `
import { expect, test } from "bun:test";
test("file b require", () => expect(require("./b-dep.cjs")).toBe("b"));
`);

    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", "a.test.ts", "b.test.ts"],
      cwd: directory,
      env: { ...process.env, CI: "false" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode, stderr).toBe(0);
    expect(stderr).toContain("2 pass");
    expect(stderr).toContain("0 fail");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
