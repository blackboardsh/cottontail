import { dirname, join, resolve } from "./path.js";
import { fileURLToPath } from "./url.js";
import * as assert from "./assert.js";
import * as assertStrict from "./assert/strict.js";
import * as asyncHooks from "./async_hooks.js";
import * as buffer from "./buffer.js";
import * as childProcess from "./child_process.js";
import * as cluster from "./cluster.js";
import * as consoleModule from "./console.js";
import * as nodeConstants from "./constants.js";
import * as crypto from "./crypto.js";
import * as diagnosticsChannel from "./diagnostics_channel.js";
import * as dgram from "./dgram.js";
import * as dns from "./dns.js";
import * as dnsPromises from "./dns/promises.js";
import * as domain from "./domain.js";
import * as events from "./events.js";
import * as fs from "./fs.js";
import * as fsPromises from "./fs/promises.js";
import * as http from "./http.js";
import * as https from "./https.js";
import * as http2 from "./http2.js";
import * as inspector from "./inspector.js";
import * as inspectorPromises from "./inspector/promises.js";
import * as os from "./os.js";
import * as path from "./path.js";
import * as pathPosix from "./path/posix.js";
import * as pathWin32 from "./path/win32.js";
import * as perfHooks from "./perf_hooks.js";
import * as processModule from "./process.js";
import * as punycode from "./punycode.js";
import * as querystring from "./querystring.js";
import * as readline from "./readline.js";
import * as readlinePromises from "./readline/promises.js";
import * as repl from "./repl.js";
import * as sea from "./sea.js";
import * as sqlite from "./sqlite.js";
import * as stream from "./stream.js";
import * as streamConsumers from "./stream/consumers.js";
import * as streamPromises from "./stream/promises.js";
import * as streamWeb from "./stream/web.js";
import * as stringDecoder from "./string_decoder.js";
import * as sys from "./sys.js";
import * as nodeTest from "./test.js";
import * as testReporters from "./test/reporters.js";
import * as timers from "./timers.js";
import * as timersPromises from "./timers/promises.js";
import * as tls from "./tls.js";
import * as traceEvents from "./trace_events.js";
import * as tty from "./tty.js";
import * as url from "./url.js";
import * as util from "./util.js";
import * as utilTypes from "./util/types.js";
import * as v8 from "./v8.js";
import * as vm from "./vm.js";
import * as wasi from "./wasi.js";
import * as workerThreads from "./worker_threads.js";
import * as zlib from "./zlib.js";

export const builtinModules = [
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "diagnostics_channel",
  "dgram",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "http",
  "https",
  "http2",
  "inspector",
  "inspector/promises",
  "module",
  "node:sea",
  "node:sqlite",
  "node:test",
  "node:test/reporters",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "process",
  "perf_hooks",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
];

const commonJsCache = new Map();
const builtinModuleMap = new Map();

export function __setBuiltinModules(modules) {
  const globalMap = globalThis.__cottontailBuiltinModules ??= new Map();
  for (const [name, value] of Object.entries(modules || {})) {
    builtinModuleMap.set(name, value);
    globalMap.set(name, value);
  }
}

function stat(path) {
  try {
    return cottontail.statSync(String(path), true);
  } catch {
    return null;
  }
}

function isFile(path) {
  return Boolean(stat(path)?.isFile);
}

function isDirectory(path) {
  return Boolean(stat(path)?.isDirectory);
}

function readPackageJson(path) {
  try {
    return JSON.parse(cottontail.readFile(path));
  } catch {
    return null;
  }
}

function packageRootFor(request, startDir) {
  const parts = request.startsWith("@") ? request.split("/").slice(0, 2) : [request.split("/")[0]];
  const packageName = parts.join("/");
  let dir = startDir;
  while (true) {
    const nodeModulesCandidate = join(dir, "node_modules", packageName);
    if (cottontail.existsSync(join(nodeModulesCandidate, "package.json"))) return nodeModulesCandidate;

    const directCandidate = join(dir, packageName);
    if (cottontail.existsSync(join(directCandidate, "package.json"))) return directCandidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveAsFile(candidate) {
  if (isFile(candidate)) return candidate;
  for (const ext of [".js", ".json", ".cjs", ".mjs"]) {
    if (isFile(`${candidate}${ext}`)) return `${candidate}${ext}`;
  }
  return null;
}

function resolveAsDirectory(candidate) {
  if (!isDirectory(candidate)) return null;
  const packagePath = join(candidate, "package.json");
  const packageJson = isFile(packagePath) ? readPackageJson(packagePath) : null;
  const mainField = packageJson && typeof packageJson.main === "string" ? packageJson.main : "";
  if (mainField) {
    const mainCandidate = resolve(candidate, mainField);
    const mainResolved = resolveAsFile(mainCandidate) || resolveAsDirectory(mainCandidate);
    if (mainResolved) return mainResolved;
  }
  return resolveAsFile(join(candidate, "index"));
}

function resolveRequest(request, basePath) {
  const text = String(request);
  if (builtinModuleMap.has(text)) return text;
  if (text.startsWith("node:") && builtinModuleMap.has(text.slice(5))) return text.slice(5);

  const startDir = basePath && !String(basePath).endsWith("/") ? dirname(basePath) : resolve(basePath || ".");
  if (text.startsWith(".") || text.startsWith("/")) {
    const candidate = text.startsWith("/") ? text : resolve(startDir, text);
    const resolved = resolveAsFile(candidate) || resolveAsDirectory(candidate);
    if (resolved) return resolved;
    throw new Error(`Cannot find module '${text}'`);
  }

  const root = packageRootFor(text, startDir);
  if (!root) throw new Error(`Cannot find module '${text}'`);
  const suffix = text.startsWith("@") ? text.split("/").slice(2).join("/") : text.split("/").slice(1).join("/");
  if (suffix) {
    const candidate = join(root, suffix);
    const resolved = resolveAsFile(candidate) || resolveAsDirectory(candidate);
    if (resolved) return resolved;
  }
  const resolved = resolveAsDirectory(root);
  if (resolved) return resolved;
  throw new Error(`Cannot find module '${text}'`);
}

function makeModule(filename) {
  return {
    id: filename,
    filename,
    path: dirname(filename),
    exports: {},
    loaded: false,
    children: [],
    parent: null,
    paths: [],
  };
}

function executeCommonJsModule(module, filename) {
  const source = cottontail.readFile(filename).replace(/^#![^\n]*(\n|$)/, "");
  const wrapper = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    `${source}\n//# sourceURL=${filename}`,
  );
  wrapper(module.exports, createRequire(filename), module, filename, dirname(filename));
  module.loaded = true;
  return module.exports;
}

function loadCommonJsModule(resolved) {
  if (builtinModuleMap.has(resolved)) return builtinModuleMap.get(resolved);
  if (commonJsCache.has(resolved)) return commonJsCache.get(resolved).exports;
  if (resolved.endsWith(".json")) return JSON.parse(cottontail.readFile(resolved));
  if (resolved.endsWith(".mjs")) {
    throw new Error(`Cannot require ES module '${resolved}' from CommonJS`);
  }

  const module = makeModule(resolved);
  commonJsCache.set(resolved, module);
  return executeCommonJsModule(module, resolved);
}

export function createRequire(basePath = cottontail.cwd()) {
  const normalizedBasePath = String(basePath).startsWith("file://")
    ? fileURLToPath(basePath)
    : String(basePath);
  const require = (request) => {
    const resolved = resolveRequest(request, normalizedBasePath);
    return loadCommonJsModule(resolved);
  };
  require.resolve = (request) => resolveRequest(request, normalizedBasePath);
  require.cache = commonJsCache;
  require.main = null;
  return require;
}

export function __runMain(filename) {
  const resolved = resolve(String(filename));
  const module = makeModule(resolved);
  commonJsCache.set(resolved, module);
  const require = createRequire(resolved);
  require.main = module;
  return executeCommonJsModule(module, resolved);
}

export class Module {
  constructor(id = "", parent = null) {
    this.id = id;
    this.path = id ? dirname(id) : "";
    this.exports = {};
    this.filename = null;
    this.loaded = false;
    this.children = [];
    this.parent = parent;
    this.paths = this.path ? _nodeModulePaths(this.path) : [];
  }

  load(filename) {
    this.filename = String(filename);
    this.path = dirname(this.filename);
    this.paths = _nodeModulePaths(this.path);
    executeCommonJsModule(this, this.filename);
  }

  require(request) {
    return createRequire(this.filename || cottontail.cwd())(request);
  }

  _compile(source, filename) {
    const wrapper = new Function(
      "exports",
      "require",
      "module",
      "__filename",
      "__dirname",
      `${String(source)}\n//# sourceURL=${filename}`,
    );
    this.filename = String(filename);
    this.path = dirname(this.filename);
    wrapper(this.exports, createRequire(this.filename), this, this.filename, this.path);
    this.loaded = true;
    return this.exports;
  }
}

export class SourceMap {
  constructor(payload = {}) {
    this.payload = payload;
    this.lineLengths = [];
  }

  findEntry(lineNumber = 0, columnNumber = 0) {
    return {
      generatedLine: Number(lineNumber),
      generatedColumn: Number(columnNumber),
      originalSource: null,
      originalLine: null,
      originalColumn: null,
      name: null,
    };
  }

  findOrigin(lineNumber = 0, columnNumber = 0) {
    return this.findEntry(lineNumber, columnNumber);
  }
}

export const _cache = commonJsCache;
export const _pathCache = Object.create(null);
export const wrapper = [
  "(function (exports, require, module, __filename, __dirname) { ",
  "\n});",
];
export const constants = {
  compileCacheStatus: {
    FAILED: 0,
    ENABLED: 1,
    ALREADY_ENABLED: 2,
    DISABLED: 3,
  },
};

export let globalPaths = [];
let compileCacheDir = undefined;
let sourceMapsSupport = { nodeModules: false, generatedCode: false };

export const _extensions = {
  ".js"(module, filename) {
    return executeCommonJsModule(module, filename);
  },
  ".cjs"(module, filename) {
    return executeCommonJsModule(module, filename);
  },
  ".json"(module, filename) {
    module.exports = JSON.parse(cottontail.readFile(filename));
    module.loaded = true;
  },
};

export function wrap(script) {
  return `${wrapper[0]}${script}${wrapper[1]}`;
}

export function isBuiltin(name) {
  const text = String(name);
  return builtinModuleMap.has(text) ||
    (text.startsWith("node:") && builtinModuleMap.has(text.slice(5))) ||
    builtinModules.includes(text) ||
    (text.startsWith("node:") && builtinModules.includes(text.slice(5)));
}

export function _nodeModulePaths(from) {
  const paths = [];
  let current = resolve(String(from || "."));
  while (true) {
    paths.push(join(current, "node_modules"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

export function _resolveLookupPaths(request, parent = undefined) {
  if (isBuiltin(request)) return null;
  const base = parent?.filename ? dirname(parent.filename) : parent?.path || cottontail.cwd();
  return _nodeModulePaths(base);
}

export function _findPath(request, paths = [], isMain = false) {
  void isMain;
  const text = String(request);
  if (text.startsWith("/") || text.startsWith(".")) {
    try {
      return resolveRequest(text, cottontail.cwd());
    } catch {
      return false;
    }
  }
  for (const base of paths || []) {
    const candidate = join(String(base), text);
    const resolved = resolveAsFile(candidate) || resolveAsDirectory(candidate);
    if (resolved) return resolved;
  }
  return false;
}

export function _resolveFilename(request, parent = undefined, isMain = false, options = undefined) {
  void isMain;
  const base = parent?.filename || parent?.path || options?.paths?.[0] || cottontail.cwd();
  return resolveRequest(String(request), base);
}

export function _load(request, parent = undefined, isMain = false) {
  const resolved = _resolveFilename(request, parent, isMain);
  return loadCommonJsModule(resolved);
}

export function _initPaths() {
  const env = globalThis.process?.env ?? cottontail.env();
  const home = env.HOME || env.USERPROFILE;
  const prefix = dirname(dirname(cottontail.execPath?.() ?? ""));
  globalPaths = [
    ...(home ? [join(home, ".node_modules"), join(home, ".node_libraries")] : []),
    join(prefix, "lib", "node"),
  ];
  Module.globalPaths = globalPaths;
}

export function _preloadModules(requests = []) {
  for (const request of requests) createRequire(cottontail.cwd())(request);
}

export function _debug(message) {
  if (globalThis.process?.env?.NODE_DEBUG?.includes("module")) {
    cottontail.fdWrite?.(2, `MODULE ${message}\n`);
  }
}

export function _stat(path) {
  const result = stat(path);
  if (!result) return -2;
  if (result.isFile) return 0;
  if (result.isDirectory) return 1;
  return 2;
}

export function _readPackage(requestPath) {
  const pjsonPath = String(requestPath).endsWith("package.json")
    ? String(requestPath)
    : join(String(requestPath), "package.json");
  const packageJson = readPackageJson(pjsonPath);
  if (!packageJson) return { exists: false, type: "none", pjsonPath };
  return { exists: true, pjsonPath, main: packageJson.main, name: packageJson.name, type: packageJson.type ?? "none" };
}

export function runMain(main = globalThis.process?.argv?.[1]) {
  if (!main) return undefined;
  return __runMain(main);
}

export function syncBuiltinESMExports() {
  return undefined;
}

export function enableCompileCache(cacheDir = undefined) {
  if (compileCacheDir != null) {
    return { status: constants.compileCacheStatus.ALREADY_ENABLED, directory: compileCacheDir };
  }
  compileCacheDir = cacheDir ?? join(cottontail.cwd(), ".cottontail-compile-cache");
  try {
    cottontail.mkdirSync(compileCacheDir, true);
    return { status: constants.compileCacheStatus.ENABLED, directory: compileCacheDir };
  } catch (error) {
    return { status: constants.compileCacheStatus.FAILED, message: String(error?.message ?? error), directory: compileCacheDir };
  }
}

export function flushCompileCache() {
  return undefined;
}

export function getCompileCacheDir() {
  return compileCacheDir;
}

export function getSourceMapsSupport() {
  return { ...sourceMapsSupport };
}

export function setSourceMapsSupport(enabled = true) {
  if (typeof enabled === "object") {
    sourceMapsSupport = { ...sourceMapsSupport, ...enabled };
  } else {
    sourceMapsSupport = { nodeModules: Boolean(enabled), generatedCode: Boolean(enabled) };
  }
}

export function findSourceMap(path, error = undefined) {
  void path;
  void error;
  return undefined;
}

export function findPackageJSON(specifier, base = cottontail.cwd()) {
  const root = packageRootFor(String(specifier), String(base));
  return root ? join(root, "package.json") : undefined;
}

export function register(specifier, parentURL = undefined, options = undefined) {
  void specifier;
  void parentURL;
  void options;
  throw new Error("module.register loader hooks are not available in Cottontail yet");
}

export function registerHooks(options = undefined) {
  void options;
  throw new Error("module.registerHooks loader hooks are not available in Cottontail yet");
}

export function stripTypeScriptTypes(source, options = undefined) {
  void options;
  throw new Error("module.stripTypeScriptTypes is not available until the TypeScript parser is exposed as a runtime API");
}

// COTTONTAIL-COMPAT: node:module loader hooks/source maps/compile cache - exported with real resolver/cache state where available; loader-hook and TS-strip APIs require dedicated parser/loader support.

_initPaths();

Module.Module = Module;
Module.builtinModules = builtinModules;
Module.createRequire = createRequire;
Module._cache = _cache;
Module._pathCache = _pathCache;
Module._extensions = _extensions;
Module.globalPaths = globalPaths;
Module.wrapper = wrapper;
Module.wrap = wrap;
Module.isBuiltin = isBuiltin;
Module._load = _load;
Module._resolveFilename = _resolveFilename;
Module._resolveLookupPaths = _resolveLookupPaths;
Module._findPath = _findPath;
Module._nodeModulePaths = _nodeModulePaths;
Module._initPaths = _initPaths;
Module._preloadModules = _preloadModules;
Module._debug = _debug;
Module._stat = _stat;
Module._readPackage = _readPackage;
Module.runMain = runMain;

const moduleBuiltin = {
  Module,
  SourceMap,
  __runMain,
  __setBuiltinModules,
  _cache,
  _debug,
  _extensions,
  _findPath,
  _initPaths,
  _load,
  _nodeModulePaths,
  _pathCache,
  _preloadModules,
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
  runMain,
  setSourceMapsSupport,
  stripTypeScriptTypes,
  syncBuiltinESMExports,
  wrap,
  wrapper,
};
const assertBuiltin = assert.default ?? assert;
const assertStrictBuiltin = assertStrict.default ?? assertStrict;
const consoleBuiltin = consoleModule.default ?? consoleModule;
const eventsBuiltin = events.default ?? events;
const processBuiltin = processModule.default ?? processModule;
const streamBuiltin = stream.default ?? stream;
const sysBuiltin = sys.default ?? sys;
const nodeTestBuiltin = nodeTest.default ?? nodeTest;

__setBuiltinModules({
  assert: assertBuiltin,
  "node:assert": assertBuiltin,
  "assert/strict": assertStrictBuiltin,
  "node:assert/strict": assertStrictBuiltin,
  async_hooks: asyncHooks,
  "node:async_hooks": asyncHooks,
  buffer,
  "node:buffer": buffer,
  child_process: childProcess,
  "node:child_process": childProcess,
  cluster,
  "node:cluster": cluster,
  console: consoleBuiltin,
  "node:console": consoleBuiltin,
  constants: nodeConstants,
  "node:constants": nodeConstants,
  crypto,
  "node:crypto": crypto,
  diagnostics_channel: diagnosticsChannel,
  "node:diagnostics_channel": diagnosticsChannel,
  dgram,
  "node:dgram": dgram,
  dns,
  "node:dns": dns,
  "dns/promises": dnsPromises,
  "node:dns/promises": dnsPromises,
  domain,
  "node:domain": domain,
  events: eventsBuiltin,
  "node:events": eventsBuiltin,
  fs,
  "node:fs": fs,
  "fs/promises": fsPromises,
  "node:fs/promises": fsPromises,
  http,
  "node:http": http,
  https,
  "node:https": https,
  http2,
  "node:http2": http2,
  inspector,
  "node:inspector": inspector,
  "inspector/promises": inspectorPromises,
  "node:inspector/promises": inspectorPromises,
  module: moduleBuiltin,
  "node:module": moduleBuiltin,
  "node:sea": sea,
  "node:sqlite": sqlite,
  "node:test": nodeTestBuiltin,
  "node:test/reporters": testReporters,
  os,
  "node:os": os,
  path,
  "node:path": path,
  "path/posix": pathPosix,
  "node:path/posix": pathPosix,
  "path/win32": pathWin32,
  "node:path/win32": pathWin32,
  perf_hooks: perfHooks,
  "node:perf_hooks": perfHooks,
  process: processBuiltin,
  "node:process": processBuiltin,
  punycode,
  "node:punycode": punycode,
  querystring,
  "node:querystring": querystring,
  readline,
  "node:readline": readline,
  "readline/promises": readlinePromises,
  "node:readline/promises": readlinePromises,
  repl,
  "node:repl": repl,
  stream: streamBuiltin,
  "node:stream": streamBuiltin,
  "stream/consumers": streamConsumers,
  "node:stream/consumers": streamConsumers,
  "stream/promises": streamPromises,
  "node:stream/promises": streamPromises,
  "stream/web": streamWeb,
  "node:stream/web": streamWeb,
  string_decoder: stringDecoder,
  "node:string_decoder": stringDecoder,
  sys: sysBuiltin,
  "node:sys": sysBuiltin,
  "test/reporters": testReporters,
  timers,
  "node:timers": timers,
  "timers/promises": timersPromises,
  "node:timers/promises": timersPromises,
  tls,
  "node:tls": tls,
  trace_events: traceEvents,
  "node:trace_events": traceEvents,
  tty,
  "node:tty": tty,
  url,
  "node:url": url,
  util,
  "node:util": util,
  "util/types": utilTypes,
  "node:util/types": utilTypes,
  v8,
  "node:v8": v8,
  vm,
  "node:vm": vm,
  wasi,
  "node:wasi": wasi,
  worker_threads: workerThreads,
  "node:worker_threads": workerThreads,
  zlib,
  "node:zlib": zlib,
});

export default moduleBuiltin;
