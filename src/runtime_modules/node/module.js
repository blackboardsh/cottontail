import { dirname, join, resolve } from "./path.js";
import { fileURLToPath } from "./url.js";
import * as assert from "./assert.js";
import * as assertStrict from "./assert/strict.js";
import * as buffer from "./buffer.js";
import * as childProcess from "./child_process.js";
import * as consoleModule from "./console.js";
import * as crypto from "./crypto.js";
import * as events from "./events.js";
import * as fs from "./fs.js";
import * as fsPromises from "./fs/promises.js";
import * as os from "./os.js";
import * as path from "./path.js";
import * as pathPosix from "./path/posix.js";
import * as pathWin32 from "./path/win32.js";
import * as perfHooks from "./perf_hooks.js";
import * as processModule from "./process.js";
import * as readline from "./readline.js";
import * as stream from "./stream.js";
import * as sys from "./sys.js";
import * as tty from "./tty.js";
import * as url from "./url.js";
import * as util from "./util.js";
import * as utilTypes from "./util/types.js";
import * as v8 from "./v8.js";
import * as vm from "./vm.js";
import * as zlib from "./zlib.js";

export const builtinModules = [
  "assert",
  "assert/strict",
  "buffer",
  "child_process",
  "console",
  "crypto",
  "events",
  "fs",
  "module",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "process",
  "perf_hooks",
  "readline",
  "stream",
  "sys",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "zlib",
];

const commonJsCache = new Map();
const builtinModuleMap = new Map();

export function __setBuiltinModules(modules) {
  for (const [name, value] of Object.entries(modules || {})) {
    builtinModuleMap.set(name, value);
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

const moduleBuiltin = { __runMain, __setBuiltinModules, builtinModules, createRequire };
const assertBuiltin = assert.default ?? assert;
const assertStrictBuiltin = assertStrict.default ?? assertStrict;
const consoleBuiltin = consoleModule.default ?? consoleModule;
const eventsBuiltin = events.default ?? events;
const processBuiltin = processModule.default ?? processModule;
const sysBuiltin = sys.default ?? sys;

__setBuiltinModules({
  assert: assertBuiltin,
  "node:assert": assertBuiltin,
  "assert/strict": assertStrictBuiltin,
  "node:assert/strict": assertStrictBuiltin,
  buffer,
  "node:buffer": buffer,
  child_process: childProcess,
  "node:child_process": childProcess,
  console: consoleBuiltin,
  "node:console": consoleBuiltin,
  crypto,
  "node:crypto": crypto,
  events: eventsBuiltin,
  "node:events": eventsBuiltin,
  fs,
  "node:fs": fs,
  "fs/promises": fsPromises,
  "node:fs/promises": fsPromises,
  module: moduleBuiltin,
  "node:module": moduleBuiltin,
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
  readline,
  "node:readline": readline,
  stream,
  "node:stream": stream,
  sys: sysBuiltin,
  "node:sys": sysBuiltin,
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
  zlib,
  "node:zlib": zlib,
});

export default moduleBuiltin;
