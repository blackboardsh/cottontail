import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-module-cache-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a direct CommonJS entry owns process.mainModule", () => {
  const target = join(root, "main-module.cjs");
  writeFileSync(target, [
    "if (require.main !== module) throw new Error('require.main identity');",
    "if (process.mainModule !== module) throw new Error('process.mainModule identity');",
    "const nodeProcess = require('node:process');",
    "if (nodeProcess !== process) throw new Error('node:process singleton identity');",
    "if (nodeProcess.mainModule !== module) throw new Error('node:process mainModule identity');",
    "if (typeof nodeProcess.binding !== 'function') throw new Error('node:process binding');",
    "if (typeof nodeProcess.report !== 'object') throw new Error('node:process report');",
    "if (module.parent !== null) throw new Error('main module parent');",
    "console.log('main-module-pass');",
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, "run", target] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("main-module-pass\n");
  expect(child.stderr.toString()).toBe("");
});

test("require.cache hides unevaluated loader records", () => {
  const registry = (globalThis as any).Loader.registry as Map<string, unknown>;
  const key = join(root, "unevaluated-loader-record.cjs");
  registry.set(key, { evaluated: false });

  try {
    expect(require.cache[key]).toBeUndefined();
    expect(key in require.cache).toBe(false);
    expect(Reflect.ownKeys(require.cache)).not.toContain(key);
    expect(Object.getOwnPropertyDescriptor(require.cache, key)).toBeUndefined();
  } finally {
    registry.delete(key);
  }
});

test("assert loads diagnostic dependencies only when a failure needs them", () => {
  const target = join(root, "lazy-assert.cjs");
  writeFileSync(target, [
    "const assert = require('node:assert');",
    "assert.ok(true);",
    "assert.strictEqual(1, 1);",
    "let failure;",
    "try { assert.deepStrictEqual({ value: 1 }, { value: 2 }); } catch (error) { failure = error; }",
    "if (!(failure instanceof assert.AssertionError)) throw new Error('missing AssertionError');",
    "if (failure.code !== 'ERR_ASSERTION') throw new Error('missing assertion code');",
    "console.log('lazy-assert-pass');",
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, "run", target] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("lazy-assert-pass\n");
  expect(child.stderr.toString()).toBe("");
});

test("CommonJS reloads create fresh wrappers from one cached factory", () => {
  const target = join(root, "fresh-wrapper.cjs");
  const host = (globalThis as any).cottontail;
  const originalCompileFunction = host.compileFunction;
  let compileCount = 0;
  writeFileSync(target, [
    "globalThis.__moduleCacheEvaluation = (globalThis.__moduleCacheEvaluation ?? 0) + 1;",
    "module.exports = { evaluation: globalThis.__moduleCacheEvaluation, wrapper: arguments.callee };",
    "",
  ].join("\n"));
  host.compileFunction = (...args: unknown[]) => {
    compileCount += 1;
    return originalCompileFunction(...args);
  };

  try {
    const first = require(target);
    delete require.cache[target];
    const second = require(target);
    delete require.cache[target];

    expect([first.evaluation, second.evaluation]).toEqual([1, 2]);
    expect(first.wrapper).not.toBe(second.wrapper);
    expect(compileCount).toBe(1);
  } finally {
    host.compileFunction = originalCompileFunction;
    delete (globalThis as any).__moduleCacheEvaluation;
    delete require.cache[target];
  }
});

test("large acyclic ESM reloads preserve fresh namespaces", async () => {
  const target = join(root, "large-esm-reload.mjs");
  let source = "globalThis.__largeEsmEvaluation = (globalThis.__largeEsmEvaluation ?? 0) + 1;\n";
  source += "export const evaluation = globalThis.__largeEsmEvaluation;\n";
  for (let index = 0; index < 5_000; index += 1) {
    source += `export const deliberatelyLongCacheLifecycleExportName${index} = ${index};\n`;
  }
  writeFileSync(target, source);

  try {
    const first = await import(target);
    delete require.cache[target];
    const second = await import(target);
    delete require.cache[target];
    const third = await import(target);
    delete require.cache[target];

    expect([first.evaluation, second.evaluation, third.evaluation]).toEqual([1, 2, 3]);
    expect(first).not.toBe(second);
    expect(second).not.toBe(third);
    for (const namespace of [first, second, third]) {
      const keys = Object.keys(namespace);
      expect(keys.every((key, index) => index === 0 || keys[index - 1] < key)).toBe(true);
    }
    expect(third.deliberatelyLongCacheLifecycleExportName4999).toBe(4999);
    expect(Reflect.ownKeys(third)).not.toContain("__esModule");
    expect(third[Symbol.toStringTag]).toBe("Module");
    const evaluationDescriptor = Object.getOwnPropertyDescriptor(third, "evaluation")!;
    expect(evaluationDescriptor).toMatchObject({
      configurable: true,
      enumerable: true,
    });
    expect(typeof evaluationDescriptor.get).toBe("function");
  } finally {
    delete (globalThis as any).__largeEsmEvaluation;
    delete require.cache[target];
  }
});

test("module lookup path caches preserve independently mutable arrays", () => {
  const { Module } = require("node:module");
  const filename = join(root, "lookup-paths.cjs");
  const first = new Module(filename);
  const second = new Module(filename);

  expect(first.paths).toEqual(second.paths);
  expect(first.paths).not.toBe(second.paths);
  first.paths.push(join(root, "custom-node-modules"));
  expect(second.paths).not.toContain(join(root, "custom-node-modules"));
});

test("smol mode bounds CommonJS cache-churn RSS", () => {
  const target = join(root, "cache-churn-target.cjs");
  const entry = join(root, "cache-churn.cjs");
  writeFileSync(target, "module.exports = {};\n");
  writeFileSync(entry, [
    `const target = ${JSON.stringify(target)};`,
    "for (let i = 0; i < 5; i++) { delete require.cache[target]; require(target); }",
    "Bun.gc(true);",
    "const baseline = process.memoryUsage.rss();",
    "for (let i = 0; i < 10000; i++) { delete require.cache[target]; require(target); }",
    "Bun.gc(true);",
    "setTimeout(() => {",
    "  const growth = process.memoryUsage.rss() - baseline;",
    "  if (growth > 48 * 1024 * 1024) throw new Error(`cache churn grew RSS by ${growth}`);",
    "  console.log('cache-churn-pass');",
    "}, 16);",
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, "--smol", "run", entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toContain("cache-churn-pass");
  expect(child.stderr.toString()).toBe("");
}, 20_000);

test("smol mode batches dynamic-import cache collection", () => {
  const target = join(root, "dynamic-cache-churn-target.cjs");
  const entry = join(root, "dynamic-cache-churn.mjs");
  writeFileSync(target, [
    "globalThis.__dynamicCacheEvaluation = (globalThis.__dynamicCacheEvaluation ?? 0) + 1;",
    "module.exports = { evaluation: globalThis.__dynamicCacheEvaluation };",
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'import { createRequire } from "node:module";',
    "const require = createRequire(import.meta.url);",
    `const target = ${JSON.stringify(target)};`,
    "let collections = 0;",
    "const collect = cottontail.gc;",
    "cottontail.gc = (...args) => { collections += 1; return collect(...args); };",
    "for (let index = 0; index < 2048; index += 1) {",
    "  delete require.cache[target];",
    "  await import(target);",
    "}",
    "if (globalThis.__dynamicCacheEvaluation !== 2048) throw new Error('module was not re-evaluated');",
    "if (collections > 4) throw new Error(`dynamic cache churn forced ${collections} collections`);",
    "console.log('dynamic-cache-churn-pass');",
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, "--smol", "run", entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toContain("dynamic-cache-churn-pass");
  expect(child.stderr.toString()).toBe("");
}, 10_000);
