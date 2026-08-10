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

test("nested dynamic imports run after the importing module settles", () => {
  const shared = join(root, "nested-dynamic-shared.js");
  const level2 = join(root, "nested-dynamic-level2.js");
  const level1 = join(root, "nested-dynamic-level1.js");
  const entry = join(root, "nested-dynamic-entry.js");
  writeFileSync(shared, "export const shared = true;\n");
  writeFileSync(level2, 'console.log("level2 evaluated");\n');
  writeFileSync(level1, [
    'import { shared } from "./nested-dynamic-shared.js";',
    "var __ctEvaluationCompleted = 1;",
    'console.log("level1 evaluated");',
    'import("./nested-dynamic-level2.js").then(() => console.log("level2 loaded"));',
    "void shared;",
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'import { shared } from "./nested-dynamic-shared.js";',
    'import("./nested-dynamic-level1.js").then(() => console.log("level1 loaded"));',
    "void shared;",
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe([
    "level1 evaluated",
    "level1 loaded",
    "level2 evaluated",
    "level2 loaded",
    "",
  ].join("\n"));
  expect(child.stderr.toString()).toBe("");
});

test("nested builtin imports run after the importing module settles", () => {
  const shared = join(root, "nested-builtin-shared.mjs");
  const level1 = join(root, "nested-builtin-level1.mjs");
  const entry = join(root, "nested-builtin-entry.mjs");
  writeFileSync(shared, "export const shared = true;\n");
  writeFileSync(level1, [
    'import { shared } from "./nested-builtin-shared.mjs";',
    'console.log("level1 evaluated");',
    'import("node:path").then(() => console.log("builtin loaded"));',
    "void shared;",
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'import("./nested-builtin-level1.mjs").then(() => console.log("level1 loaded"));',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe([
    "level1 evaluated",
    "level1 loaded",
    "builtin loaded",
    "",
  ].join("\n"));
  expect(child.stderr.toString()).toBe("");
});

test("an earlier awaited child does not release later detached imports", () => {
  const first = join(root, "checkpoint-first.mjs");
  const second = join(root, "checkpoint-second.mjs");
  const parent = join(root, "checkpoint-parent.mjs");
  const entry = join(root, "checkpoint-entry.mjs");
  writeFileSync(first, 'console.log("first evaluated");\n');
  writeFileSync(second, 'console.log("second evaluated");\n');
  writeFileSync(parent, [
    'await import("./checkpoint-first.mjs");',
    'console.log("parent evaluated");',
    'import("./checkpoint-second.mjs").then(() => console.log("second loaded"));',
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'import("./checkpoint-parent.mjs").then(() => console.log("parent loaded"));',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe([
    "first evaluated",
    "parent evaluated",
    "parent loaded",
    "second evaluated",
    "second loaded",
    "",
  ].join("\n"));
  expect(child.stderr.toString()).toBe("");
});

test("parenthesized top-level await and a lexical require stay async", () => {
  const target = join(root, "parenthesized-tla-require.mjs");
  const entry = join(root, "parenthesized-tla-require-entry.mjs");
  writeFileSync(target, [
    'const require = value => `local:${value}`;',
    'export const value = await (Promise.resolve(require("ok")));',
    "",
  ].join("\n"));
  writeFileSync(entry, [
    `const target = ${JSON.stringify(target)};`,
    "let rejected = false;",
    "try { require(target); } catch (error) {",
    '  rejected = String(error?.message).includes("require() async module");',
    "}",
    'if (!rejected) throw new Error("require accepted parenthesized TLA");',
    "const namespace = await globalThis.__cottontailImportModule(target, import.meta.path, undefined, true);",
    'if (namespace.value !== "local:ok") throw new Error(String(namespace.value));',
    'console.log("parenthesized-tla-ok");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("parenthesized-tla-ok\n");
  expect(child.stderr.toString()).toBe("");
});

test("detached sibling imports do not create false wait cycles", () => {
  const moduleA = join(root, "false-cycle-a.mjs");
  const moduleB = join(root, "false-cycle-b.mjs");
  const moduleC = join(root, "false-cycle-c.mjs");
  const entry = join(root, "false-cycle-entry.mjs");
  writeFileSync(moduleA, [
    "export const done = Promise.all([",
    '  import("./false-cycle-c.mjs"),',
    '  import("./false-cycle-b.mjs"),',
    "]);",
    "",
  ].join("\n"));
  writeFileSync(moduleC, [
    'void import("./false-cycle-b.mjs");',
    'await new Promise(resolve => setTimeout(resolve, 20));',
    "export const ready = true;",
    'console.log("c-done");',
    "",
  ].join("\n"));
  writeFileSync(moduleB, [
    'const namespace = await import("./false-cycle-c.mjs");',
    'if (namespace.ready !== true) throw new Error("partial C namespace");',
    'console.log("b-done");',
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'const { done } = await import("./false-cycle-a.mjs");',
    "await Promise.race([",
    "  done,",
    '  new Promise((_, reject) => setTimeout(() => reject(new Error("false-cycle timeout")), 1000)),',
    "]);",
    'console.log("false-cycle-settled");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("c-done\nb-done\nfalse-cycle-settled\n");
  expect(child.stderr.toString()).toBe("");
});

test("concurrent runtime imports expose distinct promises for one namespace", () => {
  const target = join(root, "import-promise-identity.mjs");
  const entry = join(root, "import-promise-identity-entry.mjs");
  writeFileSync(target, "await 0;\nexport const value = 42;\n");
  writeFileSync(entry, [
    `const target = ${JSON.stringify(target)};`,
    'require("node:module");',
    "const first = globalThis.__cottontailImportModule(target, import.meta.path, undefined, true);",
    "const second = globalThis.__cottontailImportModule(target, import.meta.path, undefined, true);",
    'if (first === second) throw new Error("shared import promise");',
    "const [one, two] = await Promise.all([first, second]);",
    'if (one !== two || one.value !== 42) throw new Error("namespace identity");',
    'console.log("promise-identity-ok");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("promise-identity-ok\n");
  expect(child.stderr.toString()).toBe("");
});

test("generated async loading ignores replaced Promise and Set globals", () => {
  const shared = join(root, "intrinsic-globals-shared.mjs");
  const target = join(root, "intrinsic-globals-target.mjs");
  const entry = join(root, "intrinsic-globals-entry.mjs");
  writeFileSync(shared, "export const value = 41;\n");
  writeFileSync(target, [
    'import { value } from "./intrinsic-globals-shared.mjs";',
    "await 0;",
    "export const result = value + 1;",
    "",
  ].join("\n"));
  writeFileSync(entry, [
    `const target = ${JSON.stringify(target)};`,
    'require("node:module");',
    "const NativePromise = globalThis.Promise;",
    "const NativeSet = globalThis.Set;",
    "let pending;",
    "let namespace;",
    "try {",
    '  globalThis.Promise = class PoisonPromise { static resolve() { throw new Error("poison Promise"); } };',
    '  globalThis.Set = class PoisonSet { constructor() { throw new Error("poison Set"); } };',
    "  pending = globalThis.__cottontailImportModule(target, import.meta.path, undefined, true);",
    "} finally {",
    "  globalThis.Promise = NativePromise;",
    "  globalThis.Set = NativeSet;",
    "}",
    "namespace = await pending;",
    'if (namespace.result !== 42) throw new Error(String(namespace.result));',
    'console.log("intrinsic-globals-ok");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("intrinsic-globals-ok\n");
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

test("deferred sibling imports share cycle ancestry", () => {
  const moduleA = join(root, "sibling-cycle-a.mjs");
  const moduleB = join(root, "sibling-cycle-b.mjs");
  const moduleC = join(root, "sibling-cycle-c.mjs");
  const entry = join(root, "sibling-cycle-entry.mjs");
  writeFileSync(moduleA, [
    "export const done = Promise.all([",
    '  import("./sibling-cycle-b.mjs"),',
    '  import("./sibling-cycle-c.mjs"),',
    "]);",
    'console.log("a-done");',
    "",
  ].join("\n"));
  writeFileSync(moduleB, [
    'await import("./sibling-cycle-c.mjs");',
    'console.log("b-done");',
    "",
  ].join("\n"));
  writeFileSync(moduleC, [
    'await import("./sibling-cycle-b.mjs");',
    'console.log("c-done");',
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'const { done } = await import("./sibling-cycle-a.mjs");',
    "await Promise.race([",
    "  done,",
    '  new Promise((_, reject) => setTimeout(() => reject(new Error("cycle timeout")), 1000)),',
    "]);",
    'console.log("siblings settled");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("a-done\nc-done\nb-done\nsiblings settled\n");
  expect(child.stderr.toString()).toBe("");
});

test("dynamic ESM static imports use package import conditions", () => {
  const packageRoot = join(root, "node_modules", "import-only-subpath");
  const dependency = join(root, "import-condition-dependency.mjs");
  const entry = join(root, "import-condition-entry.js");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "import-only-subpath",
    exports: {
      "./node": { import: "./node.cjs" },
    },
  }));
  writeFileSync(join(packageRoot, "node.cjs"), "exports.value = 'import-condition-ok';\n");
  writeFileSync(dependency, [
    'import { value } from "import-only-subpath/node";',
    "export { value };",
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'const namespace = await import("./import-condition-dependency.mjs");',
    "console.log(namespace.value);",
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("import-condition-ok\n");
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

test("commented destructuring declarations retain their named ESM exports", () => {
  const dependency = join(root, "commented-destructuring-exports.mjs");
  const entry = join(root, "commented-destructuring-entry.mjs");
  writeFileSync(dependency, [
    'const api = { launch: () => "launch-ok", connect: () => "connect-ok" };',
    "export const {",
    "  /** Launch a browser. */",
    "  launch,",
    "  /** Connect to a browser. */",
    "  connect: renamedConnect,",
    "} = api;",
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'import { launch, renamedConnect } from "./commented-destructuring-exports.mjs";',
    'if (launch() !== "launch-ok") throw new Error("missing shorthand export");',
    'if (renamedConnect() !== "connect-ok") throw new Error("missing aliased export");',
    'console.log("commented-exports-ok");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("commented-exports-ok\n");
  expect(child.stderr.toString()).toBe("");
});

test("async generated-module errors retain the evaluated source line", () => {
  const target = join(root, "async-error-source.mjs");
  const entry = join(root, "async-error-entry.mjs");
  writeFileSync(target, [
    "const missing = undefined;",
    "missing();",
    "export default 1;",
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'require("node:path");',
    `const target = ${JSON.stringify(target)};`,
    "await globalThis.__cottontailImportModule(target, import.meta.path, undefined, true);",
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry], env: { ...process.env, FORCE_COLOR: "0" } });
  const stderr = child.stderr.toString();
  const firstFrame = stderr.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith("at "));
  expect(child.exitCode).not.toBe(0);
  expect(stderr).toContain("2 | missing();");
  const normalizedFirstFrame = firstFrame?.replaceAll("\\", "/");
  expect(normalizedFirstFrame).toContain(`/${basename(target)}:2:`);
  expect(normalizedFirstFrame).not.toContain(".cottontail-embedded-runtime/node/module.js");
});

test("sync generated wrappers define the direct-await dynamic import helper", () => {
  const dependency = join(root, "sync-wrapper-awaited-dependency.mjs");
  const target = join(root, "sync-wrapper-awaited-target.mjs");
  const entry = join(root, "sync-wrapper-awaited-entry.mjs");
  writeFileSync(dependency, 'export const value = "awaited-helper-ok";\n');
  writeFileSync(target, [
    "export const done = (async () => {",
    '  return (await import(`./${globalThis.__ctAwaitedDependency}`)).value;',
    "})();",
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'globalThis.__ctAwaitedDependency = "sync-wrapper-awaited-dependency.mjs";',
    'const { done } = await import("./sync-wrapper-awaited-target.mjs");',
    'if (await done !== "awaited-helper-ok") throw new Error("missing awaited helper");',
    'console.log("awaited-helper-ok");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("awaited-helper-ok\n");
  expect(child.stderr.toString()).toBe("");
});

test("conditional parenthesized top-level await uses module grammar", () => {
  const dependency = join(root, "conditional-tla-dependency.mjs");
  const target = join(root, "conditional-tla-target.js");
  const entry = join(root, "conditional-tla-entry.mjs");
  writeFileSync(dependency, 'export const value = "conditional-tla-ok";\n');
  writeFileSync(target, [
    "globalThis.__ctConditionalTlaResult = (await (globalThis.__ctUseDynamicImport",
    '  ? import("./conditional-tla-dependency.mjs")',
    '  : Promise.resolve({ value: "wrong-branch" }))).value;',
    "",
  ].join("\n"));
  writeFileSync(entry, [
    "globalThis.__ctUseDynamicImport = true;",
    'await import("./conditional-tla-target.js");',
    'if (globalThis.__ctConditionalTlaResult !== "conditional-tla-ok") throw new Error(String(globalThis.__ctConditionalTlaResult));',
    'console.log("conditional-tla-ok");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("conditional-tla-ok\n");
  expect(child.stderr.toString()).toBe("");
});

test("CommonJS artifacts can own a leading lexical require binding", () => {
  const target = join(root, "lexical-require-target.cjs");
  const entry = join(root, "lexical-require-entry.mjs");
  writeFileSync(target, [
    'const require = { cache: { fs: "hello" }, extensions: { ".json": "json" } };',
    'console.log(Object.keys(require.cache).join(","));',
    'console.log(Object.keys(require.extensions).join(","));',
    'delete require.cache["fs"];',
    'delete require.extensions[".json"];',
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'import { createRequire } from "node:module";',
    "const require = createRequire(import.meta.url);",
    'require("./lexical-require-target.cjs");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("fs\n.json\n");
  expect(child.stderr.toString()).toBe("");
});
