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
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const packageDir = join(root, "package-a");
mkdirSync(packageDir, { recursive: true });
writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "package-a", main: "index.js", type: "module" }));
const packageInfo = _readPackage(packageDir);
assert(packageInfo.exists === true && packageInfo.name === "package-a", "_readPackage mismatch");
assert(findPackageJSON("package-a", root)?.endsWith("/package-a/package.json"), "findPackageJSON mismatch");

const cacheResult = enableCompileCache(join(root, "compile-cache"));
assert(
  cacheResult.status === constants.compileCacheStatus.ENABLED ||
    cacheResult.status === constants.compileCacheStatus.ALREADY_ENABLED,
  "enableCompileCache status mismatch",
);
assert(getCompileCacheDir()?.endsWith("/compile-cache"), "getCompileCacheDir mismatch");
assert(statSync(getCompileCacheDir()).isDirectory(), "compile cache directory missing");

setSourceMapsSupport({ nodeModules: true, generatedCode: true });
const support = getSourceMapsSupport();
assert(support.nodeModules === true && support.generatedCode === true, "source maps support mismatch");
assert(globalPaths.length > 0, "globalPaths missing");

for (const fn of [register, registerHooks, stripTypeScriptTypes]) {
  let threw = false;
  try {
    fn("x" as never);
  } catch {
    threw = true;
  }
  assert(threw, "unsupported module hook should throw");
}

rmSync(root, { recursive: true, force: true });
console.log("node module surface passed");
