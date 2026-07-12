import ModuleDefault, {
  Module,
  SourceMap,
  _cache,
  _findPath,
  _load,
  _nodeModulePaths,
  _readPackage,
  _resolveFilename,
  _resolveLookupPaths,
  _stat,
  builtinModules,
  constants,
  createRequire,
  enableCompileCache,
  findPackageJSON,
  findSourceMap,
  flushCompileCache,
  getCompileCacheDir,
  getSourceMapsSupport,
  globalPaths,
  isBuiltin,
  register,
  registerHooks,
  setSourceMapsSupport,
  stripTypeScriptTypes,
  syncBuiltinESMExports,
  wrap,
  wrapper,
} from "node:module";
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const tmpDir = process.env.COTTONTAIL_TMP_DIR;
assert(tmpDir, "COTTONTAIL_TMP_DIR missing");

const root = `${tmpDir}/node-module-surface`;
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

assert(ModuleDefault.Module === Module, "default Module mismatch");
assert(builtinModules.includes("fs"), "builtinModules should include fs");
assert(isBuiltin("node:fs"), "isBuiltin node:fs mismatch");
assert(isBuiltin("fs"), "isBuiltin fs mismatch");
assert(!isBuiltin("definitely-not-a-builtin"), "isBuiltin false mismatch");

const requiredFs = createRequire(`${root}/entry.js`)("node:fs");
assert(typeof requiredFs.readFileSync === "function", "createRequire builtin mismatch");
assert(_resolveFilename("node:fs", { filename: `${root}/entry.js` }) === "node:fs", "_resolveFilename builtin mismatch");
assert(_load("node:fs", { filename: `${root}/entry.js` }) === requiredFs, "_load builtin mismatch");

const modulePath = join(root, "sample.cjs");
writeFileSync(modulePath, "module.exports = { value: 42 };\n");
const localRequire = createRequire(`${root}/entry.js`);
assert(localRequire("./sample.cjs").value === 42, "createRequire local module mismatch");
assert(_cache.has(modulePath), "_cache should contain required module");

writeFileSync(join(root, "data.jsonc"), "{ // comment\n  \"items\": [1, 2,],\n}\n");
writeFileSync(join(root, "data.toml"), "[owner]\nname = \"cottontail\"\n");
writeFileSync(join(root, "data.txt"), "plain text\n");
assert(localRequire("./data.jsonc").items.join(",") === "1,2", "createRequire JSONC loader mismatch");
assert(localRequire("./data.toml").owner.name === "cottontail", "createRequire TOML loader mismatch");
assert(localRequire("./data.txt").default === "plain text\n", "createRequire text loader mismatch");

const paths = _nodeModulePaths(root);
assert(paths[0].endsWith("/node_modules"), "_nodeModulePaths first entry mismatch");
assert(Array.isArray(_resolveLookupPaths("left-pad", { filename: `${root}/entry.js` })), "_resolveLookupPaths package mismatch");
assert(_findPath("sample.cjs", [root]) === modulePath, "_findPath mismatch");
assert(_stat(modulePath) === 0, "_stat file mismatch");
assert(_stat(root) === 1, "_stat directory mismatch");
assert(_stat(`${root}/missing`) === -2, "_stat missing mismatch");

assert(wrapper.length === 2, "wrapper shape mismatch");
assert(wrap("return 1;").startsWith(wrapper[0]), "wrap prefix mismatch");
assert(syncBuiltinESMExports() === undefined, "syncBuiltinESMExports mismatch");

const constructed = new Module(modulePath);
constructed._compile("module.exports = { compiled: true };", modulePath);
assert(constructed.exports.compiled === true, "Module#_compile mismatch");

const sourceMap = new SourceMap({ version: 3, sources: [], mappings: "" });
assert(sourceMap.findEntry(1, 2).generatedLine === 1, "SourceMap findEntry mismatch");
assert(findSourceMap(modulePath) === undefined, "findSourceMap should be undefined without maps");
const mappedPath = join(root, "mapped.cjs");
const inlineMap = Buffer.from(JSON.stringify({ version: 3, sources: ["original.ts"], names: [], mappings: "AAAA" })).toString("base64");
writeFileSync(mappedPath, `module.exports = 1;\n//# sourceMappingURL=data:application/json;base64,${inlineMap}\n`);
assert(localRequire("./mapped.cjs") === 1, "mapped module require mismatch");
const foundSourceMap = findSourceMap(mappedPath);
assert(foundSourceMap?.findEntry(1, 0).originalSource === "original.ts", "findSourceMap decoded entry mismatch");

const packageDir = join(root, "package-a");
mkdirSync(packageDir, { recursive: true });
writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "package-a", main: "index.js", type: "module" }));
const packageInfo = _readPackage(packageDir);
assert(packageInfo.exists === true && packageInfo.name === "package-a", "_readPackage mismatch");
assert(findPackageJSON("package-a", root)?.endsWith("/package-a/package.json"), "findPackageJSON mismatch");

const exportsPackageDir = join(root, "exports-pkg");
mkdirSync(join(exportsPackageDir, "features"), { recursive: true });
writeFileSync(join(exportsPackageDir, "package.json"), JSON.stringify({
  name: "exports-pkg",
  exports: {
    ".": {
      require: "./main.cjs",
      default: "./default.cjs",
    },
    "./feature": "./features/feature.cjs",
    "./patterns/*": "./features/*.cjs",
  },
}));
writeFileSync(join(exportsPackageDir, "main.cjs"), "module.exports = { value: 'main' };\n");
writeFileSync(join(exportsPackageDir, "default.cjs"), "module.exports = { value: 'default' };\n");
writeFileSync(join(exportsPackageDir, "features/feature.cjs"), "module.exports = { value: 'feature' };\n");
writeFileSync(join(exportsPackageDir, "features/extra.cjs"), "module.exports = { value: 'extra' };\n");
assert(localRequire("exports-pkg").value === "main", "package exports root mismatch");
assert(localRequire("exports-pkg/feature").value === "feature", "package exports subpath mismatch");
assert(localRequire("exports-pkg/patterns/extra").value === "extra", "package exports pattern mismatch");
let privateExportThrew = false;
try {
  localRequire("exports-pkg/features/feature.cjs");
} catch (error) {
  privateExportThrew = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}
assert(privateExportThrew, "package exports should block private subpaths");

const cacheResult = enableCompileCache(join(root, "compile-cache"));
assert(
  cacheResult.status === constants.compileCacheStatus.ENABLED ||
    cacheResult.status === constants.compileCacheStatus.ALREADY_ENABLED,
  "enableCompileCache status mismatch",
);
assert(getCompileCacheDir()?.endsWith("/compile-cache"), "getCompileCacheDir mismatch");
assert(statSync(getCompileCacheDir()).isDirectory(), "compile cache directory missing");
const cachedModulePath = join(root, "cached.cjs");
writeFileSync(cachedModulePath, "module.exports = { cached: true };\n");
assert(localRequire("./cached.cjs").cached === true, "compile cache module load mismatch");
flushCompileCache();
const cacheManifest = JSON.parse(readFileSync(join(getCompileCacheDir(), "manifest.json"), "utf8"));
assert(cacheManifest.entries.some((entry: any) => entry.filename === cachedModulePath), "compile cache manifest missing module");

setSourceMapsSupport({ nodeModules: true, generatedCode: true });
const support = getSourceMapsSupport();
assert(support.nodeModules === true && support.generatedCode === true, "source maps support mismatch");
assert(globalPaths.length > 0, "globalPaths missing");

const stripSource = "const x: number = 1;\nexport type Foo = { value: string };\n";
const stripped = stripTypeScriptTypes(stripSource);
assert(stripped === `const x${" ".repeat(": number".length)} = 1;\n${" ".repeat("export type Foo = { value: string };".length)}\n`, "stripTypeScriptTypes should preserve strip-mode whitespace");
assert(stripped.length === stripSource.length, "stripTypeScriptTypes strip mode should preserve source length");
assert(!stripped.includes(": number"), "stripTypeScriptTypes should remove annotations");
assert(!stripped.includes("export type"), "stripTypeScriptTypes should remove type-only exports");
assert(stripTypeScriptTypes("import { type Foo, Bar } from \"x\";\n") === "import {           Bar } from \"x\";\n", "stripTypeScriptTypes should erase named type imports");
const genericStripSource = "function f<T extends string>(x: T): T { return x }\n";
const genericStripped = stripTypeScriptTypes(genericStripSource);
assert(genericStripped.length === genericStripSource.length, "stripTypeScriptTypes generic strip length mismatch");
assert(genericStripped.includes("function f") && genericStripped.includes("{ return x }"), "stripTypeScriptTypes should preserve generic function runtime code");
assert(!genericStripped.includes("extends string") && !genericStripped.includes(": T"), "stripTypeScriptTypes should erase generic function types");

const transformed = stripTypeScriptTypes("enum E { A = 1, B }\nconsole.log(E.B);\n", { mode: "transform" });
assert(transformed.includes("var E"), "stripTypeScriptTypes transform should lower enums");
assert(transformed.includes("console.log"), "stripTypeScriptTypes transform should preserve runtime code");

const hookTarget = join(root, "hooked.cjs");
writeFileSync(hookTarget, "module.exports = { value: 'hooked-resolve' };\n");
const resolveHook = registerHooks({
  resolve(specifier: string, context: unknown, nextResolve: (specifier: string, context: unknown) => { url: string }) {
    if (specifier === "hook-target") return { url: `file://${hookTarget}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
assert(localRequire("hook-target").value === "hooked-resolve", "registerHooks resolve hook mismatch");
assert(typeof resolveHook.deregister === "function", "registerHooks should return a deregisterable hook object");
resolveHook.deregister();

const loadHook = registerHooks({
  resolve(specifier: string, context: unknown, nextResolve: (specifier: string, context: unknown) => { url: string }) {
    if (specifier === "virtual-hook") return { url: `file://${join(root, "virtual-hook.cjs")}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url: string, context: unknown, nextLoad: (url: string, context: unknown) => { format?: string; source?: string | null }) {
    if (url.endsWith("/virtual-hook.cjs")) {
      return { format: "commonjs", source: "module.exports = { value: 'hooked-load' };\n", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
assert(localRequire("virtual-hook").value === "hooked-load", "registerHooks load hook mismatch");
loadHook.deregister();

const dynamicHook = registerHooks({
  resolve(specifier: string, context: unknown, nextResolve: (specifier: string, context: unknown) => { url: string }) {
    if (specifier === "dynamic-hook") {
      return { url: `file://${join(root, "dynamic-hook.mjs")}`, format: "module", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url: string, context: unknown, nextLoad: (url: string, context: unknown) => { format?: string; source?: string | null }) {
    if (url.endsWith("/dynamic-hook.mjs")) {
      return {
        format: "module",
        source: "export const value = 'dynamic-hooked';\nexport default { value };\n",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
const dynamicImported = (globalThis as any).cottontail.importModule("dynamic-hook", `file://${join(root, "entry.js")}`);
assert(dynamicImported.value === "dynamic-hooked", "dynamic import hook named export mismatch");
assert(dynamicImported.default.value === "dynamic-hooked", "dynamic import hook default export mismatch");
dynamicHook.deregister();

const registeredTarget = join(root, "registered-hook.cjs");
const registeredHooks = join(root, "registered-hooks.cjs");
writeFileSync(registeredTarget, "module.exports = { value: 'registered' };\n");
writeFileSync(registeredHooks, `exports.resolve = (specifier, context, nextResolve) => {
  if (specifier === "registered-hook") return { url: "file://${registeredTarget}", shortCircuit: true };
  return nextResolve(specifier, context);
};\n`);
assert(register(`./${registeredHooks.slice(root.length + 1)}`, `file://${join(root, "entry.js")}`) === undefined, "register should return undefined");
assert(localRequire("registered-hook").value === "registered", "register hook module mismatch");

for (const badHooks of [{ resolve: 1 }, { load: 1 }] as never[]) {
  let threw = false;
  try {
    registerHooks(badHooks);
  } catch {
    threw = true;
  }
  assert(threw, "registerHooks should validate hook functions");
}

rmSync(root, { recursive: true, force: true });
console.log("node module surface passed");
