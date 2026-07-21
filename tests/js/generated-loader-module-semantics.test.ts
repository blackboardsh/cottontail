import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-loader-semantics-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("Bun's linker owns ordinary dynamic module graphs with top-level await", () => {
  const dependency = join(root, "tla-dependency.js");
  const entry = join(root, "tla-entry.js");
  writeFileSync(dependency, [
    'const fs = require("node:fs");',
    "await Promise.resolve();",
    'export const value = fs.Dirent ? "tla-ok" : "missing-dirent";',
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'const namespace = await import("./tla-dependency.js");',
    'if (namespace.value !== "tla-ok") throw new Error(String(namespace.value));',
    'console.log("tla-ok");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("tla-ok\n");
  expect(child.stderr.toString()).toBe("");
});

test("async module self-imports observe the compiler's live namespace", () => {
  const entry = join(root, "tla-self-import.js");
  writeFileSync(entry, [
    "export let ready = false;",
    'const namespace = await import("./tla-self-import.js");',
    'if (namespace.ready !== false) throw new Error("early namespace value");',
    "ready = true;",
    'if (namespace.ready !== true) throw new Error("stale namespace value");',
    'console.log("self-import-ok");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("self-import-ok\n");
  expect(child.stderr.toString()).toBe("");
});

test("a dynamically imported module can statically import its awaiting parent", () => {
  const entry = join(root, "dynamic-back-edge-entry.js");
  const dependency = join(root, "dynamic-back-edge-dependency.js");
  writeFileSync(entry, [
    'export function parentValue() { return "back-edge-ok"; }',
    'const namespace = await import("./dynamic-back-edge-dependency.js");',
    "console.log(namespace.value);",
    "",
  ].join("\n"));
  writeFileSync(dependency, [
    'import { parentValue } from "./dynamic-back-edge-entry.js";',
    "export const value = parentValue();",
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("back-edge-ok\n");
  expect(child.stderr.toString()).toBe("");
});

test("self-import and self-require share Bun's virtual ESM marker", () => {
  const entry = join(root, "esm-marker-self-import.js");
  writeFileSync(entry, [
    "export const value = 1;",
    'const namespace = await import("./esm-marker-self-import.js");',
    "namespace.__esModule = true;",
    'if (namespace.__esModule !== true) throw new Error("marker was not set");',
    "namespace.__esModule = false;",
    'if (namespace.__esModule !== undefined) throw new Error("marker was not cleared");',
    "namespace.__esModule = true;",
    "namespace.__esModule = undefined;",
    'if (namespace.__esModule !== undefined) throw new Error("undefined did not clear marker");',
    'const required = require("./esm-marker-self-import.js");',
    'if (required.__esModule !== true || namespace.__esModule !== true) throw new Error("require marker was not shared");',
    'if (Object.getOwnPropertyNames(namespace).includes("__esModule")) throw new Error("marker became an export");',
    'console.log("esm-marker-ok");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("esm-marker-ok\n");
  expect(child.stderr.toString()).toBe("");
});

test('dynamic import("bun") preserves the native Bun object identity', async () => {
  expect(await import("bun")).toBe(Bun);
});

test("generated import-meta helpers distinguish file referrers from directories", () => {
  const parent = join(import.meta.path, "../");
  const specifier = `./js/${basename(import.meta.path)}`;
  expect(globalThis.__cottontailImportMetaResolveSync(specifier, parent)).toBe(import.meta.path);
  expect(import.meta.resolveSync(specifier, parent)).toBe(import.meta.path);
});

test("static-import diagnostics preserve embedded NUL bytes", () => {
  const entry = join(root, "nul-import.js");
  const specifier = "file://\0invalid url";
  writeFileSync(entry, `import value from '${specifier}';\nconsole.log(value);\n`);

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr.toString()).toContain(specifier);
});

test("package subpaths ending in condition names remain JavaScript modules", () => {
  const packageRoot = join(root, "node_modules", "condition-package");
  const entry = join(root, "condition-package-entry.js");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "condition-package",
    exports: { "./server.browser": "./server.browser.js" },
  }));
  writeFileSync(join(packageRoot, "server.browser.js"), "exports.render = () => 'browser-module';\n");
  writeFileSync(entry, [
    'import { render } from "condition-package/server.browser";',
    'if (render() !== "browser-module") throw new Error("package subpath was loaded as an asset");',
    'console.log("browser-module");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("browser-module\n");
  expect(child.stderr.toString()).toBe("");
});
