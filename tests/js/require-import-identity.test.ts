import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("require shares statically imported ESM bindings and reactive scope", () => {
  const root = mkdtempSync(join(tmpdir(), "cottontail-import-require-"));
  try {
    writeFileSync(join(root, "state.ts"), `
      export const identity = {};
      export default identity;
      export let value = 0;
      export function increment() { value++; }
      let scope;
      export function createRoot(fn) {
        scope = {};
        try { fn(); } finally { scope = undefined; }
      }
      export function live() {
        if (!scope) throw new Error("missing root scope");
        return scope;
      }
    `);
    writeFileSync(join(root, "reexport.ts"), `export * from "./state";`);
    writeFileSync(join(root, "consumer.cjs"), `module.exports = require("./state.ts");`);
    writeFileSync(join(root, "entry.ts"), `
      import { identity, createRoot, live } from "./state";
      import { value } from "./reexport";
      import { createRequire } from "node:module";
      const required = require("./state");
      const nativeRequire = createRequire(import.meta.url);
      if (required.identity !== identity || required.live !== live) throw new Error("duplicate exports");
      if (required.default !== identity) throw new Error("duplicate default");
      if (Object.getOwnPropertyNames(required).includes("__esModule")) throw new Error("interop marker became an export");
      if (nativeRequire("./state.ts") !== required) throw new Error("different require namespace");
      if (require("./consumer.cjs") !== required) throw new Error("transitive duplicate");
      createRoot(() => {
        if (required.live() !== live()) throw new Error("duplicate scope");
      });
      required.increment();
      if (value !== 1 || required.value !== 1) throw new Error("stale live binding");
      const key = require.resolve("./state");
      if (require.cache[key]?.exports !== required) throw new Error("missing require cache record");
      delete require.cache[key];
      const reloaded = require("./state");
      if (reloaded === required || reloaded.value !== 0) throw new Error("cache eviction ignored");
      console.log("identity-pass");
    `);
    const child = Bun.spawnSync({ cmd: [process.execPath, "run", join(root, "entry.ts")] });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("identity-pass\n");
    const testEntry = join(root, "identity.test.ts");
    writeFileSync(testEntry, `import { test } from "bun:test";\n` +
      readFileSync(join(root, "entry.ts"), "utf8") + `\ntest("shared ESM state", () => {});`);
    const testChild = Bun.spawnSync({ cmd: [process.execPath, "test", testEntry] });
    expect(testChild.exitCode).toBe(0);
    expect(testChild.stdout.toString()).toContain("identity-pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundled dynamic imports register their namespace only after initialization", () => {
  const root = mkdtempSync(join(tmpdir(), "cottontail-lazy-require-"));
  try {
    writeFileSync(join(root, "lazy.ts"), `
      globalThis.__lazyEvaluations = (globalThis.__lazyEvaluations ?? 0) + 1;
      export const identity = {};
    `);
    writeFileSync(join(root, "entry.ts"), `
      const load = () => import("./lazy");
      if (globalThis.__lazyEvaluations !== undefined) throw new Error("eager evaluation");
      const imported = await load();
      const required = require("./lazy");
      if (imported !== required) throw new Error("duplicate namespace");
      if (globalThis.__lazyEvaluations !== 1) throw new Error("duplicate evaluation");
      console.log("lazy-identity-pass");
    `);
    const child = Bun.spawnSync({ cmd: [process.execPath, "run", join(root, "entry.ts")] });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("lazy-identity-pass\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("require shares an in-flight async module without evaluating another copy", () => {
  const root = mkdtempSync(join(tmpdir(), "cottontail-pending-require-"));
  try {
    writeFileSync(join(root, "async.ts"), `
      globalThis.__asyncEvaluations = (globalThis.__asyncEvaluations ?? 0) + 1;
      await new Promise(resolve => { globalThis.__releaseAsyncModule = resolve; });
      export const identity = {};
    `);
    writeFileSync(join(root, "entry.ts"), `
      const pending = import("./async");
      while (!globalThis.__releaseAsyncModule) await new Promise(resolve => setTimeout(resolve, 1));
      const required = require("./async");
      globalThis.__releaseAsyncModule();
      const imported = await pending;
      if (required !== imported || require("./async") !== imported) throw new Error("duplicate completed async namespace");
      if (globalThis.__asyncEvaluations !== 1) throw new Error("duplicate async evaluation");
      console.log("async-identity-pass");
    `);
    const child = Bun.spawnSync({ cmd: [process.execPath, "run", join(root, "entry.ts")], timeout: 10_000 });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("async-identity-pass\n");
    const testEntry = join(root, "async-identity.test.ts");
    writeFileSync(testEntry, `import { test } from "bun:test";\n` +
      readFileSync(join(root, "entry.ts"), "utf8") + `\ntest("shared async ESM state", () => {});`);
    const testChild = Bun.spawnSync({ cmd: [process.execPath, "test", testEntry], timeout: 10_000 });
    expect(testChild.exitCode).toBe(0);
    expect(testChild.stdout.toString()).toContain("async-identity-pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
