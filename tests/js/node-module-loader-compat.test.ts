import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-module-loader-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("bundled test modules resolve global require from their source file", () => {
  const target = join(import.meta.dir, "fixtures", "require-resolve-target.js");

  expect(require("./fixtures/require-resolve-target.js")).toBe("ok");
  expect(require.resolve("./fixtures/require-resolve-target.js")).toBe(target);
  expect(require.resolve.paths("./fixtures/require-resolve-target.js")).toEqual([import.meta.dir]);
});

test("CommonJS top-level this is the initial exports object", () => {
  const target = join(root, "commonjs-top-level-this.cjs");
  writeFileSync(target, [
    "module.exports.sameAsExports = this === exports;",
    "module.exports.sameAsModuleExports = this === module.exports;",
    "module.exports.sameAsGlobal = this === globalThis;",
    "",
  ].join("\n"));

  expect(require(target)).toEqual({
    sameAsExports: true,
    sameAsModuleExports: true,
    sameAsGlobal: false,
  });
});

test("require uses an ESM module.exports export as its direct result", () => {
  const interop = join(root, "interop.mjs");
  const namespace = join(root, "namespace.mjs");
  writeFileSync(interop, 'const value = Symbol.for("loader-interop"); export { value as "module.exports" };\n');
  writeFileSync(namespace, "export const value = 42;\n");

  expect(require(interop)).toBe(Symbol.for("loader-interop"));
  expect(require(namespace).value).toBe(42);
});

test("require detects transpiled ESM exports after preceding statements", () => {
  const target = join(root, "single-line-export.mjs");
  writeFileSync(target, "const config = { output: 'server' }; export { config as default };\n");

  expect(require(target).default).toEqual({ output: "server" });
});

test("synchronous ESM entries preserve package-relative import referrers", () => {
  const { createRequire } = require("node:module");
  const packageDir = join(root, "node_modules", "loader-referrer-package");
  const entry = join(root, "package-referrer-entry.mjs");
  require("node:fs").mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: "loader-referrer-package",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(join(packageDir, "index.js"), 'export { encode } from "./hex.js";\n');
  writeFileSync(join(packageDir, "hex.js"), [
    "export function encode(value) {",
    '  return Array.from(value, character => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");',
    "}",
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'import { encode } from "loader-referrer-package";',
    'export const encoded = encode("ok");',
    "",
  ].join("\n"));

  const localRequire = createRequire(join(root, "package-referrer-require.cjs"));
  expect(localRequire(entry).encoded).toBe("6f6b");
});

test("a failed synchronous TLA require is evicted before dynamic import", async () => {
  const { createRequire } = require("node:module");
  const { pathToFileURL } = require("node:url");
  const target = join(root, "require-tla-cache.js");
  writeFileSync(target, [
    "await new Promise(resolve => setTimeout(resolve, 1));",
    "export const foo = 67;",
    "",
  ].join("\n"));
  const localRequire = createRequire(join(root, "entry.js"));

  expect(() => localRequire(target)).toThrow(
    `require() async module "${target}" is unsupported. use "await import()" instead.`,
  );
  expect(localRequire.cache[target]).toBeUndefined();
  const namespace = await import(pathToFileURL(target).href);
  expect(namespace.foo).toBe(67);
  expect(Object.prototype.toString.call(namespace)).toBe("[object Module]");
});

test("dynamic ESM accepts comments before export declarations", async () => {
  const { pathToFileURL } = require("node:url");
  const target = join(root, "commented-export-declarations.mjs");
  writeFileSync(target, [
    "export /*@__NO_SIDE_EFFECTS__*/ function construct(value) { return value; }",
    "export /* generated */ const marker = 42;",
    "export /* generated */ class Box { value = 73; }",
    "",
  ].join("\n"));

  const namespace = await import(pathToFileURL(target).href);
  expect(namespace.construct("ok")).toBe("ok");
  expect(namespace.marker).toBe(42);
  expect(new namespace.Box().value).toBe(73);
});

test("TypeScript CommonJS entries receive the main module", () => {
  const target = join(root, "typescript-commonjs-main.ts");
  writeFileSync(target, [
    "exports.forceCommonJS = true;",
    "async function nested() { await Promise.resolve(); }",
    "if (require.main !== module) process.exit(91);",
    "console.log('typescript-commonjs-main');",
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, target] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("typescript-commonjs-main\n");
  expect(child.stderr.toString()).toBe("");
});

test("bundled ESM entries expose a bound import.meta.require", () => {
  const dependency = join(root, "import-meta-require-dependency.cjs");
  const target = join(root, "import-meta-require-entry.js");
  writeFileSync(dependency, "module.exports = 42;\n");
  writeFileSync(target, [
    "const { require: localRequire } = import.meta;",
    `console.log(localRequire(${JSON.stringify(dependency)}));`,
    "export {};",
    "",
  ].join("\n"));

  const child = Bun.spawnSync({ cmd: [process.execPath, target] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("42\n");
  expect(child.stderr.toString()).toBe("");
});

test("createRequire validates its filename like Node", () => {
  const { createRequire } = require("node:module");

  expect(() => createRequire()).toThrow("absolute path string");
  expect(() => createRequire("../relative.js")).toThrow("absolute path string");
  expect(() => createRequire("https://example.com/app.js")).toThrow("absolute path string");
  expect(() => createRequire({})).toThrow("Received {}");
  expect(createRequire(new URL(`file://${join(root, "entry.js")}`))("node:path")).toBe(require("node:path"));
});

test("node module lookup paths skip duplicate node_modules segments", () => {
  const { _nodeModulePaths } = require("node:module");
  const paths = _nodeModulePaths("/workspace/node_modules/pkg/node_modules/dep");

  expect(paths).toContain("/workspace/node_modules/pkg/node_modules/dep/node_modules");
  expect(paths).toContain("/workspace/node_modules/pkg/node_modules");
  expect(paths).not.toContain("/workspace/node_modules/pkg/node_modules/node_modules");
});

test("source-map support validates and resets Node options", () => {
  const { getSourceMapsSupport, setSourceMapsSupport } = require("node:module");

  expect(() => setSourceMapsSupport()).toThrow();
  expect(() => setSourceMapsSupport(true, { nodeModules: 1 })).toThrow();
  setSourceMapsSupport(true, { nodeModules: true });
  expect(getSourceMapsSupport()).toEqual({ enabled: true, nodeModules: true, generatedCode: false });
  setSourceMapsSupport(false, { generatedCode: true });
  expect(getSourceMapsSupport()).toEqual({ enabled: false, nodeModules: false, generatedCode: true });
});

test("CommonJS compilation honors Module.wrapper mutations", () => {
  const Module = require("node:module");
  const originalWrapper = Module.wrapper;
  const target = join(root, "wrapped.cjs");
  writeFileSync(target, "module.exports = globalThis.__loaderWrapperCount;\n");
  globalThis.__loaderWrapperCount = 0;

  try {
    Module.wrapper = { ...originalWrapper };
    Module.wrapper[0] += "globalThis.__loaderWrapperCount += 1;";
    expect(require(target)).toBe(1);
  } finally {
    Module.wrapper = originalWrapper;
    delete globalThis.__loaderWrapperCount;
    delete require.cache[target];
  }
});

test("CommonJS wrapper compilation preserves reload semantics", async () => {
  const Module = require("node:module");
  const originalWrapper = Module.wrapper;
  const host = (globalThis as any).cottontail;
  const originalCompileFunction = host.compileFunction;
  const target = join(root, "wrapper-reload.cjs");
  let compileCount = 0;
  const source = version => [
    `module.exports = { version: ${version}, evaluation: ++globalThis.__loaderEvaluationCount,`,
    '  basename: async () => (await import("node:path")).basename("/tmp/reloaded") };',
    "",
  ].join("\n");
  const loadFresh = () => {
    const value = require(target);
    delete require.cache[target];
    return value;
  };
  globalThis.__loaderEvaluationCount = 0;
  globalThis.__loaderWrapperMarks = [];
  host.compileFunction = (...args) => {
    compileCount++;
    return originalCompileFunction(...args);
  };

  try {
    const activeWrapper = { ...originalWrapper };
    activeWrapper[0] += 'globalThis.__loaderWrapperMarks.push("initial");';
    Module.wrapper = activeWrapper;
    writeFileSync(target, source(1));

    const first = loadFresh();
    const second = loadFresh();
    expect(second).not.toBe(first);
    expect([first.evaluation, second.evaluation]).toEqual([1, 2]);
    expect(await second.basename()).toBe("reloaded");

    writeFileSync(target, source(2));
    expect(loadFresh()).toMatchObject({ version: 2, evaluation: 3 });

    activeWrapper[0] = `${originalWrapper[0]}globalThis.__loaderWrapperMarks.push("mutated");`;
    expect(loadFresh()).toMatchObject({ version: 2, evaluation: 4 });

    Module.wrapper = { ...originalWrapper };
    Module.wrapper[0] += 'globalThis.__loaderWrapperMarks.push("replacement");';
    expect(loadFresh()).toMatchObject({ version: 2, evaluation: 5 });
    expect(globalThis.__loaderWrapperMarks).toEqual([
      "initial",
      "initial",
      "initial",
      "mutated",
      "replacement",
    ]);
    expect(compileCount).toBe(4);
  } finally {
    host.compileFunction = originalCompileFunction;
    Module.wrapper = originalWrapper;
    delete globalThis.__loaderEvaluationCount;
    delete globalThis.__loaderWrapperMarks;
    delete require.cache[target];
  }
});

test("resolver handles bare files, NUL requests, and private node prefixes", () => {
  const modules = join(root, "node_modules");
  const entry = join(root, "entry.cjs");
  require("node:fs").mkdirSync(modules, { recursive: true });
  writeFileSync(entry, "");
  writeFileSync(join(modules, "bare-file.js"), "module.exports = 42;\n");
  const localRequire = require("node:module").createRequire(entry);

  expect(localRequire("bare-file")).toBe(42);
  expect(() => localRequire("a\0b")).toThrow("Cannot find module 'a\0b'");
  expect(() => localRequire("node:internal/test/binding")).toThrow("No such built-in module");
  expect(() => localRequire(1 as any)).toThrow('The "id" argument');
  expect(() => localRequire("")).toThrow("must be a non-empty string");
  expect(() => localRequire.resolve(1)).toThrow("request");
  expect(() => localRequire.resolve.paths({})).toThrow("request");
  expect(() => localRequire.resolve("bare-file", { paths: "invalid" })).toThrow("options.paths");
  expect(() => localRequire.resolve("bare-file", { paths: [1] })).toThrow("array of strings");
  expect(localRequire("process")).toBe(process);
  expect(localRequire("node:process")).toBe(process);
});

test("NODE_PATH participates in global CommonJS resolution", () => {
  const Module = require("node:module");
  const globalModules = join(root, "global-modules");
  const packageDir = join(globalModules, "loader-global-fixture");
  require("node:fs").mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "index.js"), 'module.exports = "global";\n');
  const previous = process.env.NODE_PATH;

  try {
    process.env.NODE_PATH = globalModules;
    Module._initPaths();
    expect(Module.globalPaths[0]).toBe(globalModules);
    expect(Module.createRequire(join(root, "global-entry.cjs"))("loader-global-fixture")).toBe("global");
  } finally {
    if (previous === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = previous;
    Module._initPaths();
  }
});

test("JSON loader syntax errors include the source filename", () => {
  const target = join(root, "invalid.json");
  writeFileSync(target, '{ "value": 1, }\n');

  expect(() => require(target)).toThrow(target);
});

test("directory-intent requests do not select sibling extension files", () => {
  const choice = join(root, "choice");
  require("node:fs").mkdirSync(choice, { recursive: true });
  writeFileSync(join(choice, "package.json"), JSON.stringify({ main: "index.js" }));
  writeFileSync(join(choice, "index.js"), 'module.exports = "directory";\n');
  writeFileSync(`${choice}.json`, JSON.stringify({ value: "sibling" }));
  const localRequire = require("node:module").createRequire(join(root, "entry.cjs"));

  expect(localRequire("./choice/")).toBe("directory");
  expect(localRequire("./choice/fake/..")).toBe("directory");
  expect(localRequire(`${choice}/fake/..`)).toBe("directory");
});

test("the Node require-ESM opt-out restores ERR_REQUIRE_ESM", () => {
  const target = join(root, "disabled-require.mjs");
  writeFileSync(target, "export const value = 1;\n");
  process.execArgv.push("--no-experimental-require-module");
  try {
    expect(() => require(target)).toThrow("dynamic import() which is available in all CommonJS modules");
  } finally {
    process.execArgv.splice(process.execArgv.lastIndexOf("--no-experimental-require-module"), 1);
    delete require.cache[target];
  }
});

test("SourceMap decodes, clones, indexes, and rejects malformed mappings like Node", () => {
  const { SourceMap } = require("node:module");
  const fixtures = join(
    import.meta.dir,
    "..",
    "..",
    "compat",
    "upstream",
    "node",
    "v24.11.1",
    "test",
    "fixtures",
    "source-map",
  );
  const payload = JSON.parse(readFileSync(join(fixtures, "disk.map"), "utf8"));
  const sourceMap = new SourceMap(payload, { lineLengths: [10, 20] });

  expect(sourceMap.findEntry(0, 29)).toMatchObject({
    originalLine: 2,
    originalColumn: 4,
    originalSource: "./disk.js",
  });
  expect(sourceMap.findOrigin(1, 30)).toMatchObject({
    fileName: "./disk.js",
    lineNumber: 3,
    columnNumber: 6,
  });
  expect(sourceMap.payload).not.toBe(payload);
  expect(sourceMap.payload.sources).not.toBe(payload.sources);
  expect(sourceMap.lineLengths).toEqual([10, 20]);

  const malformed = new SourceMap({ sources: ["test.js"], mappings: ";;;;;" });
  expect(malformed.findEntry(0, 5)).toEqual({});
  expect(malformed.findOrigin(1, 6)).toEqual({});

  const indexedPayload = JSON.parse(readFileSync(join(fixtures, "disk-index.map"), "utf8"));
  expect(new SourceMap(indexedPayload).findEntry(0, 29)).toMatchObject({
    originalLine: 2,
    originalColumn: 4,
    originalSource: "./section.js",
  });

  expect(new SourceMap({ sources: ["test.js"], mappings: "AAAC" }).findEntry(0, 0).originalColumn).toBe(1);
  expect(new SourceMap({ sources: ["test.js"], mappings: "AAAB" }).findEntry(0, 0).originalColumn).toBe(-2147483648);
  const unsorted = new SourceMap({ sources: ["test.js"], mappings: "UAAA,FAAE,FAAE" });
  expect(unsorted.findEntry(0, 6).originalColumn).toBe(4);
  expect(unsorted.findEntry(0, 8).originalColumn).toBe(2);
  expect(unsorted.findEntry(0, 10).originalColumn).toBe(0);
});

test("stripTypeScriptTypes preserves strip layout and validates Node options", () => {
  const { stripTypeScriptTypes } = require("node:module");
  const errorFrom = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error as { code?: string };
    }
    throw new Error("expected stripTypeScriptTypes to throw");
  };

  expect(stripTypeScriptTypes("const x: number = 1;")).toBe("const x         = 1;");
  expect(stripTypeScriptTypes("const x: number = 1;", { sourceUrl: "foo.ts" }))
    .toBe("const x         = 1;\n\n//# sourceURL=foo.ts");
  expect(stripTypeScriptTypes("enum E { A = 1, B }", { mode: "transform" })).toContain("var E");
  expect(errorFrom(() => stripTypeScriptTypes({} as any)).code).toBe("ERR_INVALID_ARG_TYPE");
  expect(errorFrom(() => stripTypeScriptTypes("", null as any)).code).toBe("ERR_INVALID_ARG_TYPE");
  expect(errorFrom(() => stripTypeScriptTypes("", { mode: "invalid" })).code).toBe("ERR_INVALID_ARG_VALUE");
  expect(errorFrom(() => stripTypeScriptTypes("", { sourceMap: true })).code).toBe("ERR_INVALID_ARG_VALUE");
  expect(errorFrom(() => stripTypeScriptTypes("", { mode: "transform", sourceMap: 1 as any })).code)
    .toBe("ERR_INVALID_ARG_TYPE");
});

test("node-prefixed builtins bypass schemeless require.cache entries", () => {
  const localRequire = require("node:module").createRequire(import.meta.url);
  const real = localRequire("node:fs");
  expect(localRequire("fs")).toBe(real);
  const fake = { default: "fake-fs" };
  localRequire.cache.fs = { exports: fake };
  try {
    expect(localRequire.resolve("node:fs")).toBe("node:fs");
    expect(localRequire.cache["node:fs"]).toBeUndefined();
    expect(localRequire("fs")).toBe(fake);
    expect(localRequire("node:fs")).toBe(real);
  } finally {
    delete localRequire.cache.fs;
  }
});

test("load hooks preserve forwarded URLs and detect package ESM", async () => {
  const { pathToFileURL } = require("node:url");
  const { registerHooks } = require("node:module");
  const packageDir = join(root, "hook-esm-package");
  const target = join(packageDir, "target.js");
  require("node:fs").mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(target, 'export const value = "before";\n');

  let forwardedFormat: string | undefined;
  const hook = registerHooks({
    resolve(specifier: string, context: object, nextResolve: Function) {
      if (specifier === "loader-hook:redirect") return { url: specifier, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url: string, context: object, nextLoad: Function) {
      if (url !== "loader-hook:redirect") return nextLoad(url, context);
      const result = nextLoad(pathToFileURL(target).href, context);
      forwardedFormat = result.format;
      return { ...result, source: String(result.source).replace("before", "after") };
    },
  });

  try {
    (globalThis as any).__loaderHookSpecifier = "loader-hook:redirect";
    const namespace = await import((globalThis as any).__loaderHookSpecifier);
    expect(namespace.value).toBe("after");
    expect(forwardedFormat).toBe("module");
  } finally {
    hook.deregister();
    delete (globalThis as any).__loaderHookSpecifier;
  }
});

test("hook-provided ESM can declare exports and expose module.exports", async () => {
  const { createRequire, registerHooks } = require("node:module");
  const target = join(root, "hook-module.custom");
  writeFileSync(target, "");
  const source = [
    "const exports = { value: 42 };",
    "export default exports;",
    'export { exports as "module.exports" };',
  ].join("\n");
  const hook = registerHooks({
    load(url: string, context: object, nextLoad: Function) {
      if (url.includes("hook-module.custom")) return { format: "module", source, shortCircuit: true };
      return nextLoad(url, context);
    },
  });

  try {
    const localRequire = createRequire(import.meta.url);
    expect(localRequire(target)).toEqual({ value: 42 });
    (globalThis as any).__loaderHookSpecifier = `${target}?dynamic`;
    const namespace = await import((globalThis as any).__loaderHookSpecifier);
    expect(namespace.default).toEqual({ value: 42 });
  } finally {
    hook.deregister();
    delete require.cache[target];
    delete (globalThis as any).__loaderHookSpecifier;
  }
});

test("register accepts parentURL and initialization data in an options object", async () => {
  const { register } = require("node:module");
  const { pathToFileURL } = require("node:url");
  const hooksPath = join(root, "registered-hooks.cjs");
  const entryPath = join(root, "registered-entry.mjs");
  writeFileSync(hooksPath, [
    "exports.initialize = data => { globalThis.__loaderRegisterData = data; };",
    "exports.resolve = (specifier, context, nextResolve) => specifier === 'registered:target'",
    "  ? { url: specifier, shortCircuit: true } : nextResolve(specifier, context);",
    "exports.load = (url, context, nextLoad) => url === 'registered:target'",
    "  ? { format: 'module', source: 'export default 73', shortCircuit: true } : nextLoad(url, context);",
  ].join("\n"));

  register("./registered-hooks.cjs", {
    parentURL: pathToFileURL(entryPath).href,
    data: { initialized: true },
  });
  expect((globalThis as any).__loaderRegisterData).toEqual({ initialized: true });
  (globalThis as any).__loaderHookSpecifier = "registered:target";
  const namespace = await import((globalThis as any).__loaderHookSpecifier);
  expect(namespace.default).toBe(73);
  delete (globalThis as any).__loaderRegisterData;
  delete (globalThis as any).__loaderHookSpecifier;
});

test("register loads synchronous hooks from data URL objects", async () => {
  const { register } = require("node:module");
  const source = [
    "const pattern = /export const hidden = 1/;",
    "const template = `export default hidden ${1}`;",
    "// export const commentOnly = 1;",
    "/* export default 2; */",
    "export function initialize(data) { globalThis.__loaderDataRegisterValue = data.value; }",
    "export function resolve(specifier, context, nextResolve) {",
    "  return specifier === 'data-register:target'",
    "    ? { url: specifier, shortCircuit: true } : nextResolve(specifier, context);",
    "}",
    "export function load(url, context, nextLoad) {",
    "  return url === 'data-register:target'",
    "    ? { format: 'module', source: 'export const value = 91', shortCircuit: true } : nextLoad(url, context);",
    "}",
  ].join("\n");

  register(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { data: { value: 81 } });
  expect((globalThis as any).__loaderDataRegisterValue).toBe(81);
  (globalThis as any).__loaderHookSpecifier = "data-register:target";
  const namespace = await import((globalThis as any).__loaderHookSpecifier);
  expect(namespace.value).toBe(91);
  delete (globalThis as any).__loaderDataRegisterValue;
  delete (globalThis as any).__loaderHookSpecifier;
});

test("findPackageJSON validates locations and distinguishes package roots", () => {
  const { findPackageJSON } = require("node:module");
  const { pathToFileURL } = require("node:url");
  const packageDir = join(root, "find-package");
  const dependencyDir = join(root, "node_modules", "find-package-dependency");
  require("node:fs").mkdirSync(join(packageDir, "src"), { recursive: true });
  require("node:fs").mkdirSync(dependencyDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "find-package" }));
  writeFileSync(join(packageDir, "src", "index.js"), "");
  writeFileSync(join(dependencyDir, "package.json"), JSON.stringify({ name: "find-package-dependency" }));

  let missingError: { code?: string } | undefined;
  try {
    findPackageJSON();
  } catch (error) {
    missingError = error as { code?: string };
  }
  expect(missingError?.code).toBe("ERR_MISSING_ARGS");
  expect(() => findPackageJSON("", null)).toThrow();
  expect(findPackageJSON(pathToFileURL(join(packageDir, "src", "index.js")))).toBe(join(packageDir, "package.json"));
  expect(findPackageJSON("find-package-dependency", pathToFileURL(join(root, "entry.mjs")))).toBe(
    join(dependencyDir, "package.json"),
  );
});
