import { basename, dirname, join, resolve } from "./path.js";
import { fileURLToPath, pathToFileURL } from "./url.js";
import { parse as parseTOML } from "../bun/toml.js";
import * as assert from "./assert.js";
import * as assertStrict from "./assert/strict.js";
import * as asyncHooks from "./async_hooks.js";
import * as buffer from "./buffer.js";
import * as childProcess from "./child_process.js";
import * as consoleModule from "./console.js";
import * as nodeConstants from "./constants.js";
import * as crypto from "./crypto.js";
import * as diagnosticsChannel from "./diagnostics_channel.js";
import * as dns from "./dns.js";
import * as dnsPromises from "./dns/promises.js";
import * as domain from "./domain.js";
import * as events from "./events.js";
import * as fs from "./fs.js";
import * as fsPromises from "./fs/promises.js";
import * as http from "./http.js";
import * as https from "./https.js";
import * as internalAssertMyersDiff from "./internal/assert/myers_diff.js";
import * as internalAsyncHooks from "./internal/async_hooks.js";
import * as internalEventTarget from "./internal/event_target.js";
import * as internalTestBinding from "./internal/test/binding.js";
import * as net from "./net.js";
import * as os from "./os.js";
import * as path from "./path.js";
import * as pathPosix from "./path/posix.js";
import * as pathWin32 from "./path/win32.js";
import * as perfHooks from "./perf_hooks.js";
import * as processModule from "./process.js";
import * as punycode from "./punycode.js";
import * as querystring from "./querystring.js";
import * as stream from "./stream.js";
import * as streamConsumers from "./stream/consumers.js";
import * as streamPromises from "./stream/promises.js";
import * as streamWeb from "./stream/web.js";
import * as stringDecoder from "./string_decoder.js";
import * as sys from "./sys.js";
import * as timers from "./timers.js";
import * as timersPromises from "./timers/promises.js";
import * as tls from "./tls.js";
import * as tty from "./tty.js";
import * as url from "./url.js";
import * as util from "./util.js";
import * as utilTypes from "./util/types.js";
import * as vm from "./vm.js";
import * as zlib from "./zlib.js";

// Heavy builtins that no startup path touches are pulled in through lazy
// require() thunks instead of static imports. The native compiler still bundles the
// modules (require of an internal path becomes a synchronous init call), but
// their top-level code no longer executes during process startup, which
// matters because every spawned cottontail process re-evaluates this graph.
const kLazyBuiltin = Symbol.for("cottontail.lazyBuiltin");
function lazyBuiltin(load) {
  let cached;
  let loaded = false;
  const thunk = () => {
    if (!loaded) {
      cached = load();
      loaded = true;
    }
    return cached;
  };
  thunk[kLazyBuiltin] = true;
  return thunk;
}
function unwrapBuiltin(value) {
  return typeof value === "function" && value[kLazyBuiltin] === true ? value() : value;
}
const cluster = lazyBuiltin(() => require("./cluster.js"));
const dgram = lazyBuiltin(() => require("./dgram.js"));
const http2 = lazyBuiltin(() => require("./http2.js"));
const inspector = lazyBuiltin(() => require("./inspector.js"));
const inspectorPromises = lazyBuiltin(() => require("./inspector/promises.js"));
const readline = lazyBuiltin(() => require("./readline.js"));
const readlinePromises = lazyBuiltin(() => require("./readline/promises.js"));
const repl = lazyBuiltin(() => require("./repl.js"));
const sea = lazyBuiltin(() => require("./sea.js"));
const sqlite = lazyBuiltin(() => require("./sqlite.js"));
const nodeTestBuiltin = lazyBuiltin(() => {
  const namespace = require("./test.js");
  return namespace.default ?? namespace;
});
const testReporters = lazyBuiltin(() => require("./test/reporters.js"));
const traceEvents = lazyBuiltin(() => require("./trace_events.js"));
const v8 = lazyBuiltin(() => require("./v8.js"));
const wasi = lazyBuiltin(() => require("./wasi.js"));
const workerThreads = lazyBuiltin(() => require("./worker_threads.js"));

const runtimePackageReplacements = new Map([
  ["abort-controller", lazyBuiltin(() => {
    const namespace = require("../vendor/abort-controller.js");
    return namespace.default ?? namespace;
  })],
  ["node-fetch", lazyBuiltin(() => {
    const namespace = require("../bun/node-fetch.js");
    return namespace.default ?? namespace;
  })],
  ["next/dist/compiled/node-fetch", lazyBuiltin(() => {
    const namespace = require("../bun/node-fetch.js");
    return namespace.default ?? namespace;
  })],
  ["isomorphic-fetch", lazyBuiltin(() => {
    const namespace = require("../vendor/isomorphic-fetch.js");
    return namespace.default ?? namespace;
  })],
  ["@vercel/fetch", lazyBuiltin(() => {
    const namespace = require("../vendor/vercel-fetch.js");
    return namespace.default ?? namespace;
  })],
]);

function hasRuntimePackageReplacement(name) {
  return runtimePackageReplacements.has(String(name));
}

function loadRuntimePackageReplacement(name) {
  return unwrapBuiltin(runtimePackageReplacements.get(String(name)));
}

function loadBuiltinOrReplacement(name) {
  const text = String(name);
  if (hasRuntimePackageReplacement(text)) return loadRuntimePackageReplacement(text);
  return unwrapBuiltin(builtinModuleMap.get(text) ?? builtinModuleMap.get(text.replace(/^node:/, "")));
}

export const builtinModules = [
  "_http_agent",
  "_http_client",
  "_http_common",
  "_http_incoming",
  "_http_outgoing",
  "_http_server",
  "_stream_duplex",
  "_stream_passthrough",
  "_stream_readable",
  "_stream_transform",
  "_stream_wrap",
  "_stream_writable",
  "_tls_common",
  "_tls_wrap",
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "bun:ffi",
  "bun:jsc",
  "bun:sqlite",
  "bun:test",
  "bun:wrap",
  "bun",
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
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "inspector/promises",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
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
  "undici",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "ws",
  "zlib",
];

const commonJsCache = new Map();
const builtinModuleMap = new Map();
const modulePathCache = Object.create(null);
const moduleHooks = [];
const moduleHookIdKey = Symbol("cottontail.moduleHooksId");
const sourceMapCache = new Map();
let nextModuleHookId = 0;
let mainModule = null;

globalThis.__cottontailApplyCommonJSModuleMock = (specifier, value) => {
  let resolved = String(specifier);
  if (!resolved.startsWith("/") && !resolved.startsWith("file://")) {
    try { resolved = resolveRequestCore(resolved, cottontail.cwd()); } catch {}
  }
  if (resolved.startsWith("file://")) resolved = fileURLToPath(resolved);
  const cached = commonJsCache.get(resolved)?.exports;
  if (cached && value && (typeof cached === "object" || typeof cached === "function") && typeof value === "object") {
    const descriptors = new Map(Object.keys(value).map((name) => [name, Object.getOwnPropertyDescriptor(cached, name)]));
    Object.assign(cached, value);
    return () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(cached, name, descriptor);
        else delete cached[name];
      }
    };
  }
  return undefined;
};

function bunModuleMockFor(...keys) {
  const registry = globalThis.__cottontailBunModuleMocks;
  if (!registry || typeof registry.has !== "function" || typeof registry.get !== "function") {
    return { found: false, value: undefined };
  }
  for (const key of keys) {
    if (key == null) continue;
    const text = String(key);
    const candidates = [text];
    if (text.startsWith("node:")) candidates.push(text.slice(5));
    else candidates.push(`node:${text}`);
    if (text.startsWith("file:./")) candidates.push(text.slice(5));
    else if (text.startsWith("./")) candidates.push(`file:${text}`);
    for (const candidate of candidates) {
      if (registry.has(candidate)) return { found: true, value: registry.get(candidate) };
    }
  }
  return { found: false, value: undefined };
}

// Builtins whose require() result must be the module's default-export object
// rather than the namespace wrapper. Node guarantees identities like
// require("fs/promises") === require("fs").promises, and fs.js exports its
// `promises` property as the fs/promises default object; storing the raw
// namespace here would break that identity (upstream fs tests assert it).
const kUnwrapDefaultBuiltins = new Set(["fs/promises", "node:fs/promises"]);

export function __setBuiltinModules(modules) {
  const globalMap = globalThis.__cottontailBuiltinModules ??= new Map();
  for (let [name, value] of Object.entries(modules || {})) {
    if (kUnwrapDefaultBuiltins.has(name) && value && typeof value === "object" && value.default) {
      value = value.default;
    }
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

function parseJSONC(source) {
  let output = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"') {
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += char;
  }
  output = output.replace(/,\s*([}\]])/g, "$1");
  // Tolerate a trailing comma after the root value (bun's package.json parser does).
  output = output.replace(/[,\s]+$/, "");
  return JSON.parse(output);
}

// ---------------------------------------------------------------------------
// tsconfig.json "paths" mapping (Bun honors these at runtime, e.g. the
// upstream test suite maps "harness" -> test/harness.ts).
// ---------------------------------------------------------------------------
const tsconfigPathsCache = new Map();

function loadTsconfigPaths(dir) {
  if (tsconfigPathsCache.has(dir)) return tsconfigPathsCache.get(dir);
  let entry = null;
  try {
    const file = join(dir, "tsconfig.json");
    if (isFile(file)) {
      const parsed = parseJSONC(String(cottontail.readFile(file)));
      const paths = parsed?.compilerOptions?.paths;
      const explicitBaseUrl = typeof parsed?.compilerOptions?.baseUrl === "string";
      if ((paths && typeof paths === "object") || explicitBaseUrl) {
        entry = {
          baseUrl: resolve(dir, String(parsed?.compilerOptions?.baseUrl ?? ".")),
          paths: paths && typeof paths === "object" ? paths : {},
          explicitBaseUrl,
        };
      }
    }
  } catch {}
  if (!entry) {
    const parent = dirname(dir);
    entry = parent && parent !== dir ? loadTsconfigPaths(parent) : null;
  }
  tsconfigPathsCache.set(dir, entry);
  return entry;
}

function resolveTsconfigPathsMapping(request, startDir) {
  const config = loadTsconfigPaths(startDir);
  if (!config) return null;
  const tryTargets = (targets, starMatch) => {
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      if (typeof target !== "string") continue;
      const substituted = starMatch == null ? target : target.replace("*", starMatch);
      const candidate = resolve(config.baseUrl, substituted);
      const resolved = resolveAsFile(candidate) || resolveAsDirectory(candidate);
      if (resolved) return resolved;
    }
    return null;
  };
  if (Object.prototype.hasOwnProperty.call(config.paths, request)) {
    const resolved = tryTargets(config.paths[request], null);
    if (resolved) return resolved;
  }
  let best = null;
  for (const key of Object.keys(config.paths)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const keySuffix = key.slice(star + 1);
    if (!request.startsWith(prefix) || !request.endsWith(keySuffix)) continue;
    if (request.length < prefix.length + keySuffix.length) continue;
    if (best == null || prefix.length > best.prefixLength) {
      best = {
        key,
        prefixLength: prefix.length,
        match: request.slice(prefix.length, request.length - keySuffix.length),
      };
    }
  }
  if (best) {
    const resolved = tryTargets(config.paths[best.key], best.match);
    if (resolved) return resolved;
  }
  // With an explicit baseUrl, TypeScript (and Bun) also resolve bare
  // specifiers relative to it (e.g. "_util/numeric.ts" from test/).
  if (config.explicitBaseUrl) {
    const candidate = resolve(config.baseUrl, request);
    const resolved = resolveAsFile(candidate) || resolveAsDirectory(candidate);
    if (resolved) return resolved;
  }
  return null;
}

function packageDirRealPath(candidate) {
  try {
    // Store-based installs expose packages through node_modules symlinks. Do
    // not canonicalize ordinary package paths: on macOS that would also turn
    // /var into /private/var even though the package itself is not symlinked.
    if (!cottontail.statSync(candidate, false)?.isSymbolicLink) return candidate;
    const real = cottontail.realpathSync(candidate);
    if (typeof real === "string" && real.length > 0) return real;
  } catch {}
  return candidate;
}

function packageRootFor(request, startDir) {
  const parts = request.startsWith("@") ? request.split("/").slice(0, 2) : [request.split("/")[0]];
  const packageName = parts.join("/");
  let dir = startDir;
  while (true) {
    const selfManifest = join(dir, "package.json");
    if (cottontail.existsSync(selfManifest)) {
      try {
        const packageJson = readPackageJson(selfManifest);
        if (packageJson?.name === packageName && packageJson.exports != null) {
          return packageDirRealPath(dir);
        }
      } catch {}
    }

    const nodeModulesCandidate = join(dir, "node_modules", packageName);
    if (cottontail.existsSync(join(nodeModulesCandidate, "package.json"))) return packageDirRealPath(nodeModulesCandidate);

    // A sibling directory that merely shares the package name is not a
    // package root (e.g. test fixtures at third_party/<name>/package.json);
    // only accept it when its package.json "name" actually matches.
    const directCandidate = join(dir, packageName);
    const directManifest = join(directCandidate, "package.json");
    if (cottontail.existsSync(directManifest)) {
      let manifestName;
      try {
        manifestName = readPackageJson(directManifest)?.name;
      } catch {
        manifestName = undefined;
      }
      if (manifestName === packageName) return packageDirRealPath(directCandidate);
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveAsFile(candidate) {
  if (isFile(candidate)) return candidate;
  // Extensionless require() follows the live Module._extensions registry.
  // Keep JSX in the fallback list because Bun loads it without exposing a
  // public require.extensions entry.
  const extensions = [...Object.keys(_extensions), ".tsx", ".jsx"];
  for (const ext of new Set(extensions)) {
    if (isFile(`${candidate}${ext}`)) return `${candidate}${ext}`;
  }
  return null;
}

function resolveAsDirectory(candidate) {
  if (!isDirectory(candidate)) return null;
  const packagePath = join(candidate, "package.json");
  const packageJson = isFile(packagePath) ? readPackageJson(packagePath) : null;
  if (packageJson?.exports != null) {
    const exported = resolvePackageExports(candidate, packageJson, "");
    if (exported) return exported;
  }
  const mainField = packageJson && typeof packageJson.main === "string" ? packageJson.main : "";
  if (mainField) {
    const mainCandidate = resolve(candidate, mainField);
    const mainResolved = resolveAsFile(mainCandidate) || resolveAsDirectory(mainCandidate);
    if (mainResolved) return mainResolved;
  }
  return resolveAsFile(join(candidate, "index"));
}

function packageTargetForConditions(target) {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = packageTargetForConditions(item);
      if (resolved) return resolved;
    }
    return null;
  }
  if (target && typeof target === "object") {
    const activeConditions = new Set(["node", "require", "default"]);
    for (const [condition, value] of Object.entries(target)) {
      if (activeConditions.has(condition)) {
        const resolved = packageTargetForConditions(value);
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

function applyExportPattern(pattern, target, subpath) {
  const starIndex = pattern.indexOf("*");
  if (starIndex < 0) return target;
  const before = pattern.slice(0, starIndex);
  const after = pattern.slice(starIndex + 1);
  if (!subpath.startsWith(before) || !subpath.endsWith(after)) return null;
  const matched = subpath.slice(before.length, subpath.length - after.length);
  return String(target).replace(/\*/g, matched);
}

function resolvePackageTarget(root, target) {
  if (typeof target !== "string" || !target.startsWith("./")) return null;
  const candidate = resolve(root, target);
  return resolveAsFile(candidate) || resolveAsDirectory(candidate);
}

function resolvePackageExports(root, packageJson, suffix = "") {
  const exportsField = packageJson?.exports;
  if (exportsField == null) return null;
  const subpath = suffix ? `./${suffix}` : ".";
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    if (subpath !== ".") return null;
    return resolvePackageTarget(root, packageTargetForConditions(exportsField));
  }
  if (typeof exportsField !== "object") return null;
  // "exports" sugar: an object whose keys are all conditions (none start
  // with ".") is the conditions target for the root subpath, e.g.
  // { "require": "./index.js", "import": "./esm/wrapper.js" }.
  if (!Object.keys(exportsField).some((key) => key.startsWith("."))) {
    if (subpath !== ".") return null;
    return resolvePackageTarget(root, packageTargetForConditions(exportsField));
  }
  if (Object.prototype.hasOwnProperty.call(exportsField, subpath)) {
    return resolvePackageTarget(root, packageTargetForConditions(exportsField[subpath]));
  }
  for (const [pattern, target] of Object.entries(exportsField)) {
    if (!pattern.includes("*")) continue;
    const resolvedTarget = packageTargetForConditions(target);
    const mapped = resolvedTarget == null ? null : applyExportPattern(pattern, resolvedTarget, subpath);
    const resolved = mapped == null ? null : resolvePackageTarget(root, mapped);
    if (resolved) return resolved;
  }
  return null;
}

function isPromiseLike(value) {
  return value != null && typeof value.then === "function";
}

function invalidArgType(name, expected, value) {
  const error = new TypeError(`The "${name}" property must be of type ${expected}. Received type ${typeof value}`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function resolvedToUrl(resolved) {
  const { bare: text, suffix } = splitSpecifierSuffix(resolved);
  if (text.startsWith("node:")) return text;
  if (builtinModuleMap.has(text)) return `node:${text.replace(/^node:/, "")}`;
  if (hasRuntimePackageReplacement(text)) return text;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return text;
  return pathToFileURL(text).href + suffix;
}

function urlToResolved(url) {
  const text = String(url);
  if (text.startsWith("node:")) return text;
  if (text.startsWith("file:")) return fileURLToPath(text);
  return text;
}

function formatForResolved(resolved) {
  const { bare: text } = splitSpecifierSuffix(resolved);
  if (text.startsWith("node:") || builtinModuleMap.has(text) || hasRuntimePackageReplacement(text)) return "builtin";
  if (text.endsWith(".json")) return "json";
  if (text.endsWith(".mjs")) return "module";
  return "commonjs";
}

function parentURLForBase(basePath) {
  const text = String(basePath || cottontail.cwd());
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return text;
  return pathToFileURL(text).href;
}

function specifierSuffixIndex(value) {
  const text = String(value);
  const query = text.indexOf("?");
  const fragment = text.indexOf("#");
  if (query < 0) return fragment;
  if (fragment < 0) return query;
  return Math.min(query, fragment);
}

function splitSpecifierSuffix(value) {
  const text = String(value);
  const index = specifierSuffixIndex(text);
  if (index < 0) return { bare: text, suffix: "" };
  const lastSeparator = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (index < lastSeparator && (text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text))) {
    try {
      if (cottontail.existsSync(text)) return { bare: text, suffix: "" };
    } catch {}
  }
  return { bare: text.slice(0, index), suffix: text.slice(index) };
}

function withSpecifierSuffix(path, suffix) {
  return suffix ? `${path}${suffix}` : path;
}

function moduleNotFoundError(request, resolveMessage = false) {
  const error = new Error(`Cannot find module '${request}'`);
  error.code = "MODULE_NOT_FOUND";
  if (resolveMessage) error.name = "ResolveMessage";
  return error;
}

class ResolveMessage extends Error {}
class BuildMessage extends SyntaxError {}

function dynamicResolveMessage(message) {
  const error = new ResolveMessage(message);
  error.code = "ERR_MODULE_NOT_FOUND";
  error.line = 0;
  error.column = 0;
  error.position = null;
  return error;
}

function packageNotFoundError(request, basePath) {
  const startDir = basePath && !String(basePath).endsWith("/") ? dirname(basePath) : resolve(basePath || ".");
  const error = new ResolveMessage(`Cannot find package '${request}' from '${startDir}'`);
  error.code = "MODULE_NOT_FOUND";
  return error;
}

function importMetaForModule(filename, suffix = "") {
  const dir = dirname(filename);
  const meta = {
    url: pathToFileURL(filename).href + suffix,
    dir,
    dirname: dir,
    file: basename(filename),
    path: filename,
    filename,
    main: false,
  };
  meta.require = createRequire(filename);
  meta.resolveSync = (specifier, parent = filename) => resolveRequest(specifier, parent);
  return meta;
}

function normalizeResolveHookResult(result) {
  if (isPromiseLike(result)) throw new TypeError("module.registerHooks resolve hooks must return synchronously");
  if (typeof result === "string") return { url: result };
  if (result == null || typeof result !== "object" || typeof result.url !== "string") {
    throw new TypeError("module.registerHooks resolve hooks must return an object with a string url");
  }
  return result;
}

function normalizeLoadHookResult(result) {
  if (isPromiseLike(result)) throw new TypeError("module.registerHooks load hooks must return synchronously");
  if (result == null || typeof result !== "object") {
    throw new TypeError("module.registerHooks load hooks must return an object");
  }
  return result;
}

function unknownBuiltinError(request) {
  const error = new Error(`No such built-in module: ${request}`);
  error.code = "ERR_UNKNOWN_BUILTIN_MODULE";
  return error;
}

// Bun does not implement node:sqlite (bun:sqlite is its API); when running
// the Bun compat profile, treat it as an unknown builtin so dynamic import
// rejects with ERR_UNKNOWN_BUILTIN_MODULE like Bun does.
function isBuiltinHiddenByCompatProfile(id) {
  if (String(id).replace(/^node:/, "") !== "sqlite") return false;
  try {
    return globalThis.process?.env?.COTTONTAIL_UPSTREAM_RUNTIME === "bun";
  } catch {
    return false;
  }
}

function resolveRequestCore(request, basePath) {
  const originalText = String(request);
  const suffixIndex = specifierSuffixIndex(originalText);
  const lastSeparator = Math.max(originalText.lastIndexOf("/"), originalText.lastIndexOf("\\"));
  if (suffixIndex >= 0 && suffixIndex < lastSeparator && (
    originalText.startsWith(".") ||
    originalText.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(originalText)
  )) {
    const exactStartDir = basePath && !String(basePath).endsWith("/") ? dirname(basePath) : resolve(basePath || ".");
    const exactCandidate = originalText.startsWith("/") || /^[A-Za-z]:[\\/]/.test(originalText)
      ? originalText
      : resolve(exactStartDir, originalText);
    const exact = resolveAsFile(exactCandidate) || resolveAsDirectory(exactCandidate);
    if (exact) return exact;
  }
  const { bare: text, suffix } = splitSpecifierSuffix(originalText);
  if (builtinModuleMap.has(text)) {
    if (isBuiltinHiddenByCompatProfile(text)) throw unknownBuiltinError(text);
    return text;
  }
  if (text.startsWith("node:") && builtinModuleMap.has(text.slice(5))) return text.slice(5);
  // Unknown "node:" specifiers can never resolve to files; both Node and Bun
  // reject them with ERR_UNKNOWN_BUILTIN_MODULE.
  if (text.startsWith("node:")) throw unknownBuiltinError(text);
  if (hasRuntimePackageReplacement(text)) return text;

  const startDir = basePath && !String(basePath).endsWith("/") ? dirname(basePath) : resolve(basePath || ".");
  if (text.startsWith(".") || text.startsWith("/")) {
    const candidate = text.startsWith("/") ? text : resolve(startDir, text);
    const resolved = resolveAsFile(candidate) || resolveAsDirectory(candidate);
    if (resolved) return withSpecifierSuffix(resolved, suffix);
    throw moduleNotFoundError(originalText, Boolean(suffix));
  }

  const tsMapped = resolveTsconfigPathsMapping(text, startDir);
  if (tsMapped) return withSpecifierSuffix(tsMapped, suffix);

  const root = packageRootFor(text, startDir);
  if (!root) throw packageNotFoundError(originalText, basePath);
  const packageSuffix = text.startsWith("@") ? text.split("/").slice(2).join("/") : text.split("/").slice(1).join("/");
  const packageJson = readPackageJson(join(root, "package.json"));
  if (packageJson?.exports != null) {
    const exported = resolvePackageExports(root, packageJson, packageSuffix);
    if (exported) return withSpecifierSuffix(exported, suffix);
    const error = new Error(`Package subpath '${packageSuffix ? `./${packageSuffix}` : "."}' is not defined by "exports" in ${join(root, "package.json")}`);
    error.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
    throw error;
  }
  if (packageSuffix) {
    const candidate = join(root, packageSuffix);
    const resolved = resolveAsFile(candidate) || resolveAsDirectory(candidate);
    if (resolved) return withSpecifierSuffix(resolved, suffix);
  }
  const resolved = resolveAsDirectory(root);
  if (resolved) return withSpecifierSuffix(resolved, suffix);
  throw moduleNotFoundError(originalText, Boolean(suffix));
}

function resolveRequest(request, basePath, useHooks = true) {
  if (bunModuleMockFor(request).found) {
    const text = String(request).replace(/^file:(?=\.\/)/, "");
    if (text.startsWith(".") || text.startsWith("/")) {
      const startDir = basePath && !String(basePath).endsWith("/") ? dirname(basePath) : resolve(basePath || ".");
      const absoluteStartDir = startDir.startsWith("/") ? startDir : resolve(cottontail.cwd(), startDir);
      return text.startsWith("/") ? text : `${absoluteStartDir}/${text}`;
    }
    return text;
  }
  if (!useHooks || !moduleHooks.some((hook) => typeof hook.resolve === "function")) {
    const startDir = basePath && !String(basePath).endsWith("/") ? dirname(basePath) : resolve(basePath || ".");
    const cacheKey = `${String(request)}\0${startDir}`;
    if (Object.prototype.hasOwnProperty.call(modulePathCache, cacheKey)) return modulePathCache[cacheKey];
    const resolved = resolveRequestCore(request, basePath);
    modulePathCache[cacheKey] = resolved;
    return resolved;
  }

  const baseContext = {
    conditions: ["node", "require"],
    importAttributes: {},
    parentURL: parentURLForBase(basePath),
  };
  let index = -1;
  const nextResolve = (specifier, context = baseContext) => {
    index += 1;
    while (index < moduleHooks.length) {
      const hook = moduleHooks[index];
      if (typeof hook.resolve === "function") {
        return normalizeResolveHookResult(hook.resolve(String(specifier), context ?? baseContext, nextResolve));
      }
      index += 1;
    }

    const parent = context?.parentURL ? fileURLToPath(context.parentURL) : basePath;
    const resolved = resolveRequestCore(specifier, parent);
    return { url: resolvedToUrl(resolved), format: formatForResolved(resolved), shortCircuit: true };
  };

  return urlToResolved(nextResolve(request, baseContext).url);
}

function makeModule(filename, parent = null, isMain = false) {
  const module = new Module(isMain ? "." : filename, parent);
  module.filename = filename;
  module.path = dirname(filename);
  module.paths = _nodeModulePaths(module.path);
  refreshModuleRequire(module);
  return module;
}

function refreshModuleRequire(module) {
  const require = function require(request) {
    return Module.prototype.require.call(module, request);
  };
  const helper = createRequire(module.filename || module.id || cottontail.cwd(), module);
  require.resolve = helper.resolve;
  require.cache = helper.cache;
  require.extensions = helper.extensions;
  Object.defineProperty(require, "main", {
    configurable: true,
    enumerable: true,
    get() { return mainModule; },
  });
  module.require = require;
  return require;
}

// Detects top-level ESM declarations (static import / export statements).
// Files reaching the CommonJS executor with ESM syntax must be transformed
// first: `import x from "y"` inside new Function() is a parse error.
const esmSyntaxPattern = /^[ \t]*(?:import\s+(?:[\w$*{]|["'])|export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*))/m;

// TypeScript sources loaded through the JS module executor must have their
// type syntax removed first; new Function() only parses JavaScript.
const typeScriptExtensionPattern = /\.(?:ts|mts|cts|tsx)$/i;

function hasBunTranspiledPragma(source) {
  const firstLine = String(source).split("\n", 1)[0].trimEnd();
  return /^\/\/\s*@bun(?:\s|$)/.test(firstLine);
}

function maybeStripTypeScript(filename, source) {
  if (!typeScriptExtensionPattern.test(String(filename))) return source;
  // `// @bun` declares already-transpiled output. Parsing TypeScript below it
  // must fail instead of silently stripping types from an invalid artifact.
  if (hasBunTranspiledPragma(source)) return source;
  if (typeof cottontail.stripTypeScriptTypes !== "function") return source;
  try {
    return String(cottontail.stripTypeScriptTypes(String(source), 1));
  } catch {
    return source;
  }
}

function maybeTransformRuntimeSyntax(filename, source) {
  const path = String(filename);
  const needsTransform = /(?:^|[\n;{}])\s*@[A-Za-z_$([]/m.test(source);
  if (!needsTransform || typeof cottontail.transpilerTransform !== "function") return source;
  const extension = path.toLowerCase().match(/\.([^.]+)$/)?.[1];
  const loader = extension === "tsx" ? "tsx"
    : extension === "ts" || extension === "mts" || extension === "cts" ? "ts"
    : extension === "jsx" ? "jsx"
    : "js";
  return String(cottontail.transpilerTransform(
    String(source),
    '{"target":"bun","deadCodeElimination":false}',
    loader,
  ));
}

// new Function("a", "b", body) prepends "function anonymous(a,b\n) {\n"
// before the body, so JSC parse-error line numbers are offset by 2.
const FUNCTION_WRAPPER_LINE_OFFSET = 2;
const CJS_FILENAME_BINDING = "__cottontailCjsFilename_4b86f6";
const CJS_DIRNAME_BINDING = "__cottontailCjsDirname_4b86f6";

function markModuleCompileError(error, filename, source, lineOffset = FUNCTION_WRAPPER_LINE_OFFSET) {
  if (error instanceof SyntaxError || /syntax error/i.test(String(error?.message ?? error))) {
    if ((typeof error !== "object" && typeof error !== "function") || error === null) {
      error = new SyntaxError(String(error));
    }
    const line = Number(error.line);
    error.__ctModuleCompileError = {
      filename,
      source: String(source),
      line: Number.isFinite(line) ? line - lineOffset : 1,
    };
  }
  return error;
}

function compileModuleWrapper(args, source, filename) {
  const useNativeCompiler = typeof cottontail.compileFunction === "function";
  try {
    if (useNativeCompiler) {
      return cottontail.compileFunction(`(function(${args.join(",")}) {\n${source}\n})`, filename);
    }
    return new Function(...args, `${source}\n//# sourceURL=${filename}`);
  } catch (error) {
    throw markModuleCompileError(error, filename, source, useNativeCompiler ? 1 : FUNCTION_WRAPPER_LINE_OFFSET);
  }
}

function executeCommonJsSource(module, filename, source) {
  if (esmSyntaxPattern.test(source)) {
    const transformed = transformEsmSourceForDynamicImport(source);
    maybeRegisterSourceMap(filename, transformed);
    recordCompileCache(filename, transformed);
    const run = compileModuleWrapper(["exports", "require", "module", "__ctImportMeta"], transformed, filename);
    try {
      run(module.exports, module.require, module, importMetaForModule(filename));
    } catch (error) {
      throw remapThrownModuleError(error);
    }
    module.loaded = true;
    return module.exports;
  }
  // Route dynamic import() in plain CJS through the runtime module loader so
  // it resolves like Bun/Node (e.g. unknown node: builtins reject with
  // ERR_UNKNOWN_BUILTIN_MODULE instead of an opaque engine error). The helper
  // is prepended on the same line to keep line numbers stable.
  let effectiveSource = source;
  if (/(?<![.\w$])import\s*\(/.test(effectiveSource)) {
    effectiveSource =
      "const __ctDynamicImport = async (spec, options) => globalThis.__cottontailImportModule(String(spec), __filename, options); " +
      effectiveSource.replace(/(?<![.\w$])import\s*\(/g, "__ctDynamicImport(");
  }
  maybeRegisterSourceMap(filename, effectiveSource);
  recordCompileCache(filename, effectiveSource);
  const wrapper = compileModuleWrapper(
    ["exports", "require", "module", "__filename", "__dirname", CJS_FILENAME_BINDING, CJS_DIRNAME_BINDING],
    effectiveSource,
    filename,
  );
  const moduleDirname = dirname(filename);
  try {
    wrapper(module.exports, module.require, module, filename, moduleDirname, filename, moduleDirname);
  } catch (error) {
    throw remapThrownModuleError(error);
  }
  module.loaded = true;
  return module.exports;
}

function transpileExtensionSource(filename, loader) {
  const source = cottontail.readFile(filename).replace(/^#![^\n]*(\n|$)/, "");
  if (loader === "ts" && hasBunTranspiledPragma(source)) return source;
  if (typeof cottontail.transpilerTransform !== "function") {
    return maybeTransformRuntimeSyntax(filename, maybeStripTypeScript(filename, source));
  }
  try {
    return String(cottontail.transpilerTransform(
      source,
      JSON.stringify({
        target: "bun",
        deadCodeElimination: false,
        minify: { syntax: true },
        _cottontailInitialIndent: 1,
        // Keep CommonJS wrapper bindings live. The standalone transpiler would
        // otherwise fold them relative to its synthetic input filename.
        define: {
          __filename: CJS_FILENAME_BINDING,
          __dirname: CJS_DIRNAME_BINDING,
        },
      }),
      loader,
    ));
  } catch (error) {
    throw markModuleCompileError(error, filename, source, 0);
  }
}

function formatExtensionCompileSource(source) {
  const body = String(source).trimEnd();
  return body ? `\n${body}\n` : "\n";
}

function executeDefaultExtension(module, filename, loader) {
  const source = transpileExtensionSource(filename, loader);
  // Bun's synchronous ESM path does not call an overridden module._compile.
  if (esmSyntaxPattern.test(source)) return executeCommonJsSource(module, filename, source);
  return module._compile(formatExtensionCompileSource(source), filename);
}

function executeCommonJsModule(module, filename) {
  const extension = String(filename).toLowerCase().match(/\.[^./\\]+$/)?.[0] ?? ".js";
  const loader = _extensions[extension] ?? _extensions[".js"];
  if (typeof loader !== "function") {
    const error = new TypeError(`Module._extensions['${extension}'] is not a function`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  loader(module, filename);
  return module.exports;
}

function executeHookSource(resolved, source, format) {
  const effectiveFormat = format ?? formatForResolved(resolved);
  if (effectiveFormat === "builtin") return loadBuiltinOrReplacement(resolved);
  if (effectiveFormat === "json" || String(resolved).endsWith(".json")) return JSON.parse(String(source ?? ""));
  if (effectiveFormat === "module" || String(resolved).endsWith(".mjs")) {
    throw new Error(`Cannot require ES module '${resolved}' from CommonJS`);
  }
  if (commonJsCache.has(resolved)) return commonJsCache.get(resolved).exports;
  const module = makeModule(resolved);
  commonJsCache.set(resolved, module);
  maybeRegisterSourceMap(resolved, String(source ?? ""));
  recordCompileCache(resolved, String(source ?? ""));
  const wrapper = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    `${String(source ?? "")}\n//# sourceURL=${resolved}`,
  );
  wrapper(module.exports, createRequire(resolved), module, resolved, dirname(resolved));
  module.loaded = true;
  return module.exports;
}

function defaultLoadForHooks(url) {
  const resolved = urlToResolved(url);
  const format = formatForResolved(resolved);
  if (format === "builtin") return { format, source: null, shortCircuit: true };
  return { format, source: cottontail.readFile(resolved), shortCircuit: true };
}

function runLoadHooks(resolved) {
  if (!moduleHooks.some((hook) => typeof hook.load === "function")) return undefined;
  const url = resolvedToUrl(resolved);
  const baseContext = { format: formatForResolved(resolved), importAttributes: {} };
  let index = -1;
  const nextLoad = (nextUrl, context = baseContext) => {
    index += 1;
    while (index < moduleHooks.length) {
      const hook = moduleHooks[index];
      if (typeof hook.load === "function") {
        return normalizeLoadHookResult(hook.load(String(nextUrl), context ?? baseContext, nextLoad));
      }
      index += 1;
    }
    return defaultLoadForHooks(nextUrl);
  };

  return nextLoad(url, baseContext);
}

function applyLoadHooks(resolved) {
  const result = runLoadHooks(resolved);
  if (result === undefined) return null;
  if (result.source == null) return null;
  return executeHookSource(resolved, result.source, result.format ?? formatForResolved(resolved));
}

function namespaceFromCommonJs(value) {
  const namespace = {};
  Object.defineProperty(namespace, "default", {
    configurable: true,
    enumerable: true,
    get: () => value,
  });
  if (value && (typeof value === "object" || typeof value === "function")) {
    for (const key of Object.keys(value)) {
      if (key !== "default") {
        Object.defineProperty(namespace, key, {
          configurable: true,
          enumerable: true,
          get: () => value[key],
        });
      }
    }
  }
  return namespace;
}

function namespaceFromBuiltin(value) {
  const unwrapped = unwrapBuiltin(value);
  // Builtins registered from ESM sources are already namespace objects. Do
  // not apply CommonJS's extra default layer to dynamic import() results.
  if (unwrapped && typeof unwrapped === "object" && Object.hasOwn(unwrapped, "default")) return unwrapped;
  return namespaceFromCommonJs(unwrapped);
}

function rewriteImportBindings(names) {
  return String(names)
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return "";
      const pieces = trimmed.split(/\s+as\s+/);
      return pieces.length === 2 ? `${pieces[0].trim()}: ${pieces[1].trim()}` : trimmed;
    })
    .filter(Boolean)
    .join(", ");
}

// Single line (no trailing newline) so prepending it does not shift line
// numbers of the transformed module source.
const staticImportHelperSource = `const __ctStaticImport = (spec) => { const value = require(spec); const ns = { default: value }; if (value && (typeof value === "object" || typeof value === "function")) { for (const key of Object.keys(value)) { if (key !== "default") ns[key] = value[key]; } if (value.__esModule && Object.hasOwn(value, "default")) ns.default = value.default; } return ns; }; const __ctDynamicImport = async (spec, options) => globalThis.__cottontailImportModule(String(spec), (typeof __ctImportMeta === "object" && __ctImportMeta && __ctImportMeta.path) || undefined, options); `;

function transformEsmSourceForDynamicImport(source) {
  const exportAssignments = [];
  // Import declarations are hoisted to the top of the transformed output
  // (matching ESM semantics, where imports are initialized before any module
  // code runs, even when the import statement appears at the bottom).
  const importDeclarations = [];
  let output = String(source).replace(/\bimport\.meta\b/g, "__ctImportMeta");
  // Static import declarations are rewritten to synchronous requires so the
  // source can run inside new Function() (where `import x from "..."` would
  // otherwise parse as a malformed dynamic import call).
  output = output.replace(
    /\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*(['"][^'"]+['"])\s*;?/g,
    (_all, name, spec) => {
      importDeclarations.push(`const ${name} = __ctStaticImport(${spec});`);
      return ";";
    },
  );
  output = output.replace(
    /\bimport\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"])\s*;?/g,
    (_all, def, names, spec) => {
      importDeclarations.push(`const { default: ${def}, ${rewriteImportBindings(names)} } = __ctStaticImport(${spec});`);
      return ";";
    },
  );
  output = output.replace(
    /\bimport\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"])\s*;?/g,
    (_all, names, spec) => {
      importDeclarations.push(`const { ${rewriteImportBindings(names)} } = __ctStaticImport(${spec});`);
      return ";";
    },
  );
  output = output.replace(
    /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*(['"][^'"]+['"])\s*;?/g,
    (_all, def, spec) => {
      importDeclarations.push(`const { default: ${def} } = __ctStaticImport(${spec});`);
      return ";";
    },
  );
  output = output.replace(/\bimport\s*(['"][^'"]+['"])\s*;?/g, (_all, spec) => {
    importDeclarations.push(`__ctStaticImport(${spec});`);
    return ";";
  });
  // Dynamic import() cannot execute inside new Function()-compiled code for
  // formats JSC's own loader cannot parse (e.g. TypeScript); route it through
  // the runtime module loader, which also consults the CommonJS cache.
  output = output.replace(/\bimport\s*\(/g, "__ctDynamicImport(");
  // Re-exports must be rewritten before the plain `export { ... }` handler
  // below, which would otherwise leave a dangling `from "..."` clause behind.
  output = output.replace(
    /\bexport\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"])\s*;?/g,
    (_all, names, spec) => {
      const statements = [];
      for (const part of String(names).split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const pieces = trimmed.split(/\s+as\s+/);
        const local = pieces[0].trim();
        const exported = (pieces[1] ?? pieces[0]).trim();
        statements.push(`exports.${exported} = __ctStaticImport(${spec}).${local};`);
      }
      return statements.join(" ");
    },
  );
  output = output.replace(
    /\bexport\s*\*\s*from\s*(['"][^'"]+['"])\s*;?/g,
    (_all, spec) => `{ const __ctNs = __ctStaticImport(${spec}); for (const __ctKey of Object.keys(__ctNs)) { if (__ctKey !== "default") exports[__ctKey] = __ctNs[__ctKey]; } }`,
  );
  output = output.replace(/\bexport\s+default\s+/g, "exports.default = ");
  output = output.replace(/\bexport\s+(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, (_all, kind, name) => {
    exportAssignments.push(`exports.${name} = ${name};`);
    return `${kind} ${name} =`;
  });
  // Declarations without initializer (e.g. the `export var ns;` emitted for
  // TypeScript namespaces by the type stripper).
  output = output.replace(/\bexport\s+(let|var)\s+([A-Za-z_$][\w$]*)\s*;/g, (_all, kind, name) => {
    exportAssignments.push(`exports.${name} = ${name};`);
    return `${kind} ${name};`;
  });
  output = output.replace(/\bexport\s+async\s+function\s*(\*?)\s*([A-Za-z_$][\w$]*)\s*\(/g, (_all, star, name) => {
    exportAssignments.push(`exports.${name} = ${name};`);
    return `async function ${star}${name}(`;
  });
  output = output.replace(/\bexport\s+function\s*(\*?)\s*([A-Za-z_$][\w$]*)\s*\(/g, (_all, star, name) => {
    exportAssignments.push(`exports.${name} = ${name};`);
    return `function ${star}${name}(`;
  });
  output = output.replace(/\bexport\s+class\s+([A-Za-z_$][\w$]*)\s*/g, (_all, name) => {
    exportAssignments.push(`exports.${name} = ${name};`);
    return `class ${name} `;
  });
  output = output.replace(/\bexport\s*\{([^}]*)\}\s*;?/g, (_all, names) => {
    for (const part of String(names).split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const pieces = trimmed.split(/\s+as\s+/);
      const local = pieces[0].trim();
      const exported = (pieces[1] ?? pieces[0]).trim();
      if (exported === '"module.exports"' || exported === "'module.exports'") {
        if (/^[A-Za-z_$][\w$]*$/.test(local)) exportAssignments.push(`module.exports = ${local};`);
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(local) && /^[A-Za-z_$][\w$]*$/.test(exported)) {
        exportAssignments.push(`exports.${exported} = ${local};`);
      }
    }
    return "";
  });
  return `${staticImportHelperSource}${importDeclarations.join(" ")}${output}\n${exportAssignments.join("\n")}`;
}

const dynamicErrorSourceSymbol = Symbol.for("cottontail.dynamicErrorSource");

function dynamicModuleErrorConstructor(filename, source) {
  const NativeError = globalThis.Error;
  const annotate = (error) => {
    try {
      if (typeof error.stack === "string") {
        error.stack = error.stack.replace(/@(?=\n|$)/g, `@${filename}`);
      }
      Object.defineProperty(error, dynamicErrorSourceSymbol, {
        value: { filename, source: String(source) },
        configurable: true,
      });
    } catch {}
    return error;
  };
  return new Proxy(NativeError, {
    construct(target, args, newTarget) {
      return annotate(Reflect.construct(target, args, newTarget ?? target));
    },
    apply(target, thisArg, args) {
      return annotate(Reflect.apply(target, thisArg, args));
    },
  });
}

function executeDynamicImportSource(resolved, source, format) {
  const { bare: resolvedPath, suffix } = splitSpecifierSuffix(resolved);
  const effectiveFormat = format ?? formatForResolved(resolvedPath);
  if (effectiveFormat === "builtin") {
    return namespaceFromBuiltin(loadBuiltinOrReplacement(resolvedPath));
  }
  if (effectiveFormat === "json" || String(resolvedPath).endsWith(".json")) {
    const jsonSource = String(source ?? "");
    try {
      return { default: JSON.parse(jsonSource) };
    } catch (error) {
      if (/(^|[\\/])package\.json$/.test(String(resolvedPath))) return { default: parseJSONC(jsonSource) };
      throw error;
    }
  }
  if (effectiveFormat === "commonjs" || String(resolvedPath).endsWith(".cjs")) {
    return namespaceFromCommonJs(executeHookSource(resolvedPath, String(source ?? "").replace(/\bimport\.meta\b/g, "__ctImportMeta"), "commonjs"));
  }
  const namespace = {};
  const originalSource = String(source ?? "");
  const transformed = transformEsmSourceForDynamicImport(maybeStripTypeScript(resolvedPath, originalSource));
  maybeRegisterSourceMap(resolvedPath, transformed);
  recordCompileCache(resolvedPath, transformed);
  const body = `${transformed}\n//# sourceURL=${resolvedPath}${suffix}`;
  let run;
  try {
    run = new Function("exports", "require", "__ctImportMeta", "Error", body);
  } catch (error) {
    // Dynamically imported ES modules may use top-level await (e.g. Bun.build
    // outputs re-imported via blob: URLs). Preserve synchronous evaluation for
    // ordinary modules and only retry syntax containing await asynchronously.
    if (!(error instanceof SyntaxError) || !/(?<![.\w$])await\b/.test(transformed)) throw error;
    const AsyncFunction = (async () => {}).constructor;
    const run = new AsyncFunction("exports", "require", "__ctImportMeta", "Error", body);
    return run(
      namespace,
      createRequire(resolvedPath),
      importMetaForModule(resolvedPath, suffix),
      dynamicModuleErrorConstructor(resolvedPath, originalSource),
    ).then(() => namespace);
  }
  run(
    namespace,
    createRequire(resolvedPath),
    importMetaForModule(resolvedPath, suffix),
    dynamicModuleErrorConstructor(resolvedPath, originalSource),
  );
  return namespace;
}

export function __importModule(specifier, referrer = undefined, options = undefined) {
  const directMock = bunModuleMockFor(specifier);
  if (directMock.found) {
    if (directMock.value && typeof directMock.value.then === "function") {
      return Promise.resolve(directMock.value).then(namespaceFromCommonJs);
    }
    return namespaceFromCommonJs(directMock.value);
  }
  // `import(URL.createObjectURL(blob))`: Bun evaluates the Blob's contents as
  // an ES module (e.g. re-importing a Bun.build output). The object-URL
  // registry lives on globalThis (installed by the Blob shim).
  const specifierText = String(specifier);
  const parent = referrer == null
    ? cottontail.cwd()
    : (String(referrer).startsWith("file:") ? fileURLToPath(String(referrer)) : String(referrer));
  if (specifierText.startsWith("data:")) {
    const comma = specifierText.indexOf(",");
    const metadata = comma < 0 ? "" : specifierText.slice(5, comma);
    if (comma < 0 || !/(?:^|;)text\/javascript(?:;|$)|^(?:application\/javascript)(?:;|$)/i.test(metadata)) {
      throw dynamicResolveMessage(`Cannot resolve invalid data URL '${specifierText}' from '${parent}'`);
    }
    const payload = specifierText.slice(comma + 1);
    let source;
    if (/(?:^|;)base64(?:;|$)/i.test(metadata)) {
      try {
        if (payload.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw new Error();
        source = atob(payload);
      } catch {
        throw new Error("Base64DecodeError");
      }
    } else {
      try {
        source = decodeURIComponent(payload);
      } catch {
        throw new SyntaxError("Invalid percent-encoding in data URL");
      }
    }
    return executeDynamicImportSource(`${cottontail.cwd()}/__cottontail-data-module.mjs`, source, "module");
  }
  if (specifierText.startsWith("blob:")) {
    const blob = globalThis.__cottontailObjectURLRegistry?.get(specifierText);
    if (blob && typeof blob.text === "function") {
      const extension = /typescript/i.test(String(blob.type ?? "")) ? "ts" : "mjs";
      const virtualPath = join(cottontail.cwd(), `__cottontail-blob-${specifierText.replace(/[^a-zA-Z0-9._-]/g, "_")}.${extension}`);
      return Promise.resolve(blob.text()).then((source) =>
        executeDynamicImportSource(virtualPath, source, "module"));
    }
    throw moduleNotFoundError(specifierText, false);
  }
  if (specifierText.includes("://") && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(specifierText)) {
    throw dynamicResolveMessage(`Cannot find module '${specifierText}' from '${parent}'`);
  }
  const resolved = resolveRequest(String(specifier), parent);
  const loader = options?.with?.type ?? options?.assert?.type ?? options?.type;
  if (loader === "text") {
    return { default: cottontail.readFile(splitSpecifierSuffix(resolved).bare) };
  }
  if (loader === "file") {
    return { default: splitSpecifierSuffix(resolved).bare };
  }
  const resolvedMock = bunModuleMockFor(resolved);
  if (resolvedMock.found) return namespaceFromCommonJs(resolvedMock.value);
  const loadResult = runLoadHooks(resolved);
  if (loadResult !== undefined) {
    return executeDynamicImportSource(resolved, loadResult.source, loadResult.format ?? formatForResolved(resolved));
  }
  if (builtinModuleMap.has(resolved) || hasRuntimePackageReplacement(resolved)) {
    return namespaceFromBuiltin(loadBuiltinOrReplacement(resolved));
  }
  if (formatForResolved(resolved) === "commonjs") return namespaceFromCommonJs(loadCommonJsModule(resolved));
  return executeDynamicImportSource(resolved, cottontail.readFile(splitSpecifierSuffix(resolved).bare), formatForResolved(resolved));
}

// The native dynamic-import shim (cottontail.importModule) stringifies any
// exception thrown synchronously by this hook, losing error identity (e.g.
// error.code). Return a rejected promise instead so the original Error object
// reaches the awaiting caller intact.
globalThis.__cottontailImportModule = (specifier, referrer, options) => {
  try {
    return __importModule(specifier, referrer, options);
  } catch (error) {
    const rejected = Promise.reject(error);
    // Pre-attach a no-op handler so the runtime's unhandled-rejection tracker
    // does not flag it before the awaiting caller attaches its own handler.
    rejected.catch(() => {});
    return rejected;
  }
};

function executeQueriedModule(module, filename, suffix) {
  const source = maybeStripTypeScript(filename, cottontail.readFile(filename).replace(/^#![^\n]*(\n|$)/, ""));
  const transformed = transformEsmSourceForDynamicImport(source);
  maybeRegisterSourceMap(filename, transformed);
  recordCompileCache(filename, transformed);
  const wrapper = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    "__ctImportMeta",
    `${transformed}\n//# sourceURL=${filename}${suffix}`,
  );
  wrapper(module.exports, createRequire(filename), module, filename, dirname(filename), importMetaForModule(filename, suffix));
  module.loaded = true;
  return module.exports;
}

function attachModuleChild(parent, child) {
  if (!parent || !child || !Array.isArray(parent.children)) return;
  if (!parent.children.includes(child)) parent.children.push(child);
  if (child.parent == null) child.parent = parent;
}

function loadCommonJsModule(resolved, parent = null, isMain = false) {
  const { bare: resolvedPath, suffix } = splitSpecifierSuffix(resolved);
  const pendingImport = globalThis.Loader?.registry?.get(resolved);
  if (pendingImport && typeof pendingImport.catch === "function") {
    pendingImport.catch(() => {});
  }
  const mocked = bunModuleMockFor(resolved);
  if (mocked.found) return mocked.value;
  const pathMock = suffix ? bunModuleMockFor(resolvedPath) : { found: false, value: undefined };
  if (pathMock.found) return pathMock.value;
  if (commonJsCache.has(resolved)) {
    const cached = commonJsCache.get(resolved);
    attachModuleChild(parent, cached);
    return cached.exports;
  }
  const hooked = applyLoadHooks(resolvedPath);
  if (hooked !== null) return hooked;
  if (builtinModuleMap.has(resolvedPath)) {
    if (globalThis.__CT_DEBUG_FSP && resolvedPath === "fs/promises") {
      const v = unwrapBuiltin(builtinModuleMap.get(resolvedPath));
      console.log("[dbg] loadCommonJsModule fs/promises ownDefault:", Object.hasOwn(v, "default"));
    }
    return unwrapBuiltin(builtinModuleMap.get(resolvedPath));
  }
  if (hasRuntimePackageReplacement(resolvedPath)) {
    return loadRuntimePackageReplacement(resolvedPath);
  }
  if (resolvedPath.endsWith(".jsonc")) return parseJSONC(cottontail.readFile(resolvedPath));
  if (resolvedPath.endsWith(".toml")) return parseTOML(cottontail.readFile(resolvedPath));
  if (resolvedPath.endsWith(".txt")) return { default: cottontail.readFile(resolvedPath) };

  const module = makeModule(resolvedPath, parent, isMain);
  attachModuleChild(parent, module);
  commonJsCache.set(resolved, module);
  try {
    return suffix ? executeQueriedModule(module, resolvedPath, suffix) : executeCommonJsModule(module, resolvedPath);
  } catch (error) {
    if (commonJsCache.get(resolved) === module) commonJsCache.delete(resolved);
    throw error;
  }
}

export function createRequire(basePath = cottontail.cwd(), parentModule = null) {
  let normalizedBasePath = String(basePath).startsWith("file://")
    ? fileURLToPath(basePath)
    : String(basePath);
  // Only inspect the stack when the caller heuristic can actually apply
  // (basePath is the bundled main-script path). Reading `new Error().stack`
  // goes through the lazily-remapping stack getter, and the first remap
  // decodes the multi-megabyte bundle source map (~200ms) — that cost must
  // not be paid by every createRequire() call in spawned processes.
  const callerPath = isBundledImportMetaBase(normalizedBasePath) ? bundledCallerPathFromStack() : null;
  if (callerPath && callerPath !== normalizedBasePath) {
    normalizedBasePath = callerPath;
  }
  const resolutionParent = parentModule ?? { filename: normalizedBasePath };
  const require = (request) => {
    const directMock = bunModuleMockFor(request);
    if (directMock.found) return directMock.value;
    const requestText = String(request);
    if (requestText.startsWith("blob:")) {
      const blob = globalThis.__cottontailObjectURLRegistry?.get(requestText);
      if (blob?._bytes instanceof Uint8Array) {
        try {
          return executeDynamicImportSource(requestText, Buffer.from(blob._bytes).toString("utf8"), "module");
        } catch (error) {
          const buildError = new BuildMessage(error?.message ?? String(error));
          buildError.cause = error;
          throw buildError;
        }
      }
    }
    const resolved = Module._resolveFilename(request, resolutionParent, false);
    const resolvedMock = bunModuleMockFor(resolved);
    if (resolvedMock.found) return resolvedMock.value;
    return loadCommonJsModule(resolved, parentModule);
  };
  require.resolve = (request, options = undefined) => {
    if (options !== undefined && options !== null && options.paths !== undefined) {
      // Route through Module._resolveFilename so user overrides and the
      // options.paths semantics both apply (matches Node).
      return Module._resolveFilename(String(request), resolutionParent, false, options);
    }
    const text = String(request);
    if (text.startsWith("node:") && !builtinModuleMap.has(text) && !builtinModuleMap.has(text.slice(5))) {
      throw packageNotFoundError(text, normalizedBasePath);
    }
    return Module._resolveFilename(text, resolutionParent, false);
  };
  require.resolve.paths = (request) => {
    const text = String(request);
    if (builtinModuleMap.has(text) || (text.startsWith("node:") && builtinModuleMap.has(text.slice(5)))) return null;
    if (text.startsWith("./") || text.startsWith("../") || text.startsWith("/")) {
      return [normalizedBasePath.endsWith("/") ? normalizedBasePath.slice(0, -1) : dirname(normalizedBasePath)];
    }
    return _nodeModulePaths(normalizedBasePath.endsWith("/") ? normalizedBasePath : dirname(normalizedBasePath));
  };
  require.cache = commonJsCacheObject;
  require.extensions = extensionsForRequire(normalizedBasePath);
  require.main = mainModule;
  return require;
}

const blockedExtensionMutationPattern = /(?:^|[\\/])node_modules[\\/](?:next[\\/]dist[\\/]build[\\/]next-config-ts[\\/]index\.js|@meteorjs[\\/]babel[\\/]index\.js)$/;
const readOnlyExtensions = new Proxy(Object.create(null), {
  get(_target, property) {
    return _extensions[property];
  },
  has(_target, property) {
    return property in _extensions;
  },
  ownKeys() {
    return Reflect.ownKeys(_extensions);
  },
  getOwnPropertyDescriptor(_target, property) {
    const descriptor = Object.getOwnPropertyDescriptor(_extensions, property);
    return descriptor ? { ...descriptor, configurable: true } : undefined;
  },
  set() {
    return true;
  },
  deleteProperty() {
    return true;
  },
  defineProperty() {
    return true;
  },
});

function extensionsForRequire(filename) {
  return blockedExtensionMutationPattern.test(String(filename)) ? readOnlyExtensions : _extensions;
}

// Node exposes require.cache as a plain object keyed by resolved path;
// mirror the internal Map through a Proxy so `delete require.cache[path]`
// really evicts entries.
const commonJsCacheObject = new Proxy(Object.create(null), {
  get(_target, property) {
    if (typeof property !== "string") return undefined;
    return commonJsCache.get(property);
  },
  set(_target, property, value) {
    if (typeof property === "string") commonJsCache.set(property, value);
    return true;
  },
  has(_target, property) {
    return typeof property === "string" && commonJsCache.has(property);
  },
  deleteProperty(_target, property) {
    if (typeof property === "string") commonJsCache.delete(property);
    return true;
  },
  ownKeys() {
    return [...commonJsCache.keys()];
  },
  getOwnPropertyDescriptor(_target, property) {
    if (typeof property !== "string" || !commonJsCache.has(property)) return undefined;
    return { value: commonJsCache.get(property), writable: true, enumerable: true, configurable: true };
  },
});

function isBundledImportMetaBase(path) {
  const mainPath = globalThis.process?.argv?.[1] ?? processModule.argv?.[1];
  if (typeof mainPath !== "string" || mainPath.length === 0) return false;
  const resolvedMainPath = mainPath.startsWith("/") ? mainPath : resolve(cottontail.cwd(), mainPath);
  return path === resolvedMainPath;
}

function bundledCallerPathFromStack() {
  const stack = String(new Error().stack || "");
  for (const line of stack.split("\n").slice(2)) {
    const atIndex = line.indexOf("@");
    if (atIndex <= 0) continue;
    let frame = line.slice(0, atIndex).trim();
    if (!/\.(?:cjs|mjs|js)$/.test(frame)) continue;
    if (frame.startsWith("file://")) {
      try {
        frame = fileURLToPath(frame);
      } catch {
        continue;
      }
    }
    const candidate = frame.startsWith("/") ? frame : resolve(cottontail.cwd(), frame);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

// A parse error in the entry module is a startup failure: print a
// Bun-style parse diagnostic (code frame + "error: Syntax Error") and
// exit 1, matching how `bun <file>` reports transpiler errors. Nested
// require() of invalid files keeps throwing a catchable SyntaxError.
function reportMainCompileError(error, info) {
  const lines = String(info.source).split("\n");
  const line = Math.min(Math.max(Number(info.line) || 1, 1), lines.length || 1);
  const text = lines[line - 1] ?? "";
  const columnIndex = Math.max(text.length - text.trimStart().length, 0);
  const gutter = `${line} | `;
  const output = [
    `${gutter}${text}`,
    `${" ".repeat(gutter.length + columnIndex)}^`,
    `error: Syntax Error: ${error?.message ?? error}`,
    `    at ${info.filename}:${line}:${columnIndex + 1}`,
    "",
    `${error?.name ?? "SyntaxError"}: ${error?.message ?? error}`,
    "",
  ].join("\n");
  try {
    globalThis.process?.stderr?.write?.(output);
  } catch {
    console.error(output);
  }
  cottontail.exit(1);
}

export function __runMain(filename) {
  const resolved = _resolveFilename(resolve(String(filename)), null, true);
  const module = makeModule(resolved, null, true);
  mainModule = module;
  refreshModuleRequire(module);
  commonJsCache.set(resolved, module);
  const require = createRequire(resolved, module);
  require.main = module;
  try {
    return executeCommonJsModule(module, resolved);
  } catch (error) {
    const info = error?.__ctModuleCompileError;
    if (info) reportMainCompileError(error, info);
    throw error;
  }
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
    refreshModuleRequire(this);
  }

  load(filename) {
    this.filename = String(filename);
    this.path = dirname(this.filename);
    this.paths = _nodeModulePaths(this.path);
    refreshModuleRequire(this);
    return executeCommonJsModule(this, this.filename);
  }

  require(request) {
    return Module._load(request, this, false);
  }

  _compile(source, filename) {
    this.filename = String(filename);
    this.path = dirname(this.filename);
    this.paths = _nodeModulePaths(this.path);
    refreshModuleRequire(this);
    executeCommonJsSource(this, this.filename, String(source));
    return undefined;
  }
}

function sourceMapPayloadTypeText(payload) {
  if (payload === undefined) return "undefined";
  if (payload === null) return "null";
  if (typeof payload === "string") return `type string ('${payload}')`;
  if (typeof payload === "number" || typeof payload === "boolean" || typeof payload === "bigint") {
    return `type ${typeof payload} (${payload})`;
  }
  return `type ${typeof payload}`;
}

function decodeSourceMapEntries(payload) {
  // 0-based entries in generated order (the format Node's SourceMap exposes).
  const mappings = String(payload.mappings ?? "");
  const sources = Array.from(payload.sources ?? [], String);
  const names = Array.from(payload.names ?? [], String);
  const sourceRoot = payload.sourceRoot ? String(payload.sourceRoot) : "";
  const entries = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;
  const lines = mappings.split(";");
  for (let generatedLine = 0; generatedLine < lines.length; generatedLine += 1) {
    let generatedColumn = 0;
    const line = lines[generatedLine];
    if (!line) continue;
    for (const segment of line.split(",")) {
      if (!segment) continue;
      const fields = decodeVlq(segment);
      generatedColumn += fields[0] ?? 0;
      if (fields.length < 4) continue;
      sourceIndex += fields[1];
      originalLine += fields[2];
      originalColumn += fields[3];
      let name;
      if (fields.length >= 5) {
        nameIndex += fields[4];
        name = names[nameIndex];
      }
      const source = sources[sourceIndex];
      entries.push({
        generatedLine,
        generatedColumn,
        originalSource: source === undefined ? undefined : `${sourceRoot}${source}`,
        originalLine,
        originalColumn,
        name,
      });
    }
  }
  return entries;
}

export class SourceMap {
  #payload;
  #lineLengths;
  #entries;

  constructor(payload, options = undefined) {
    if (payload === null || typeof payload !== "object") {
      const error = new TypeError(`The "payload" argument must be of type object. Received ${sourceMapPayloadTypeText(payload)}`);
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    this.#payload = payload;
    this.#lineLengths = options?.lineLengths;
    this.#entries = decodeSourceMapEntries(payload);
  }

  get payload() {
    return this.#payload;
  }

  get lineLengths() {
    return this.#lineLengths;
  }

  #findNearestEntry(line, column) {
    // Entries are in generated order; find the last entry at or before the
    // requested generated position (matching Node's binary search).
    let low = 0;
    let high = this.#entries.length - 1;
    let best = -1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const entry = this.#entries[middle];
      if (entry.generatedLine < line || (entry.generatedLine === line && entry.generatedColumn <= column)) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best === -1 ? undefined : this.#entries[best];
  }

  findEntry(lineNumber, columnNumber) {
    const entry = this.#findNearestEntry(Number(lineNumber), Number(columnNumber));
    if (entry === undefined) {
      return {
        generatedLine: Number(lineNumber),
        generatedColumn: Number(columnNumber),
        originalSource: undefined,
        originalLine: undefined,
        originalColumn: undefined,
        name: undefined,
      };
    }
    return {
      generatedLine: entry.generatedLine,
      generatedColumn: entry.generatedColumn,
      originalSource: entry.originalSource,
      originalLine: entry.originalLine,
      originalColumn: entry.originalColumn,
      name: entry.name,
    };
  }

  findOrigin(lineNumber, columnNumber) {
    const line = Number(lineNumber);
    const column = Number(columnNumber);
    const entry = this.#findNearestEntry(line, column);
    if (entry === undefined || entry.originalSource === undefined) {
      return { fileName: this.#payload.sources?.[0], lineNumber: line, columnNumber: column };
    }
    return {
      fileName: entry.originalSource,
      line: entry.originalLine + (line - entry.generatedLine),
      column: entry.originalColumn + (column - entry.generatedColumn),
      name: entry.name,
    };
  }
}

const sourceMapBase64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const sourceMapBase64Values = new Map(Array.from(sourceMapBase64Chars, (char, index) => [char, index]));

function decodeVlq(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = sourceMapBase64Values.get(char);
    if (digit == null) throw new Error("Invalid source map VLQ digit");
    const continuation = (digit & 32) !== 0;
    value += (digit & 31) << shift;
    if (continuation) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) === 1;
    values.push(negative ? -(value >> 1) : value >> 1);
    value = 0;
    shift = 0;
  }
  return values;
}

function decodeSourceMapMappings(payload = {}) {
  const mappings = String(payload.mappings ?? "");
  const sources = Array.from(payload.sources ?? [], String);
  const names = Array.from(payload.names ?? [], String);
  const entries = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;
  const lines = mappings.split(";");
  for (let generatedLineIndex = 0; generatedLineIndex < lines.length; generatedLineIndex += 1) {
    let generatedColumn = 0;
    const line = lines[generatedLineIndex];
    if (!line) continue;
    for (const segment of line.split(",")) {
      if (!segment) continue;
      const fields = decodeVlq(segment);
      generatedColumn += fields[0] ?? 0;
      if (fields.length >= 4) {
        sourceIndex += fields[1];
        originalLine += fields[2];
        originalColumn += fields[3];
        if (fields.length >= 5) nameIndex += fields[4];
        entries.push({
          generatedLine: generatedLineIndex + 1,
          generatedColumn,
          originalSource: sources[sourceIndex] ?? null,
          originalLine: originalLine + 1,
          originalColumn,
          name: fields.length >= 5 ? names[nameIndex] ?? null : null,
        });
      }
    }
  }
  return entries;
}

function sourceMapUrlFromSource(source) {
  const pattern = /(?:\/\/[#@]\s*sourceMappingURL=([^\r\n]+)|\/\*[#@]\s*sourceMappingURL=([^*]+)\*\/)/g;
  let match = null;
  for (;;) {
    const next = pattern.exec(String(source));
    if (!next) break;
    match = next;
  }
  return match ? String(match[1] ?? match[2]).trim() : null;
}

function readSourceMapPayload(filename, source) {
  const sourceMapUrl = sourceMapUrlFromSource(source);
  if (!sourceMapUrl) return null;
  if (sourceMapUrl.startsWith("data:")) {
    const comma = sourceMapUrl.indexOf(",");
    if (comma < 0) return null;
    const meta = sourceMapUrl.slice(5, comma);
    const body = sourceMapUrl.slice(comma + 1);
    const text = meta.includes(";base64")
      ? buffer.Buffer.from(body, "base64").toString("utf8")
      : decodeURIComponent(body);
    return JSON.parse(text);
  }
  const mapPath = sourceMapUrl.startsWith("file:")
    ? fileURLToPath(sourceMapUrl)
    : resolve(dirname(String(filename)), sourceMapUrl);
  return JSON.parse(cottontail.readFile(mapPath));
}

function maybeRegisterSourceMap(filename, source) {
  try {
    const payload = readSourceMapPayload(filename, source);
    if (payload) sourceMapCache.set(String(filename), new SourceMap(payload));
  } catch {}
}

function remapRegisteredSourceMapStack(stack) {
  return String(stack ?? "").replace(/([^\s()]+):(\d+):(\d+)/g, (frame, file, lineText, columnText) => {
    let sourceMap = sourceMapCache.get(file);
    if (!sourceMap) {
      try {
        maybeRegisterSourceMap(file, cottontail.readFile(file));
        sourceMap = sourceMapCache.get(file);
      } catch {}
    }
    if (!sourceMap) return frame;
    const entry = sourceMap.findEntry(Number(lineText) - 1, Number(columnText) - 1);
    if (entry?.originalSource == null || entry.originalLine == null || entry.originalColumn == null) return frame;
    const source = String(entry.originalSource);
    const resolvedSource = source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)
      ? source
      : resolve(dirname(file), source);
    return `${resolvedSource}:${entry.originalLine + 1}:${entry.originalColumn + 1}`;
  });
}

function remapThrownModuleError(error) {
  try {
    const filename = typeof error?.sourceURL === "string" ? error.sourceURL : undefined;
    if (filename) {
      const generatedSource = cottontail.readFile(filename);
      let sourceMap = sourceMapCache.get(filename);
      if (!sourceMap) {
        maybeRegisterSourceMap(filename, generatedSource);
        sourceMap = sourceMapCache.get(filename);
      }
      Object.defineProperty(error, "__ctModuleErrorMetadata", {
        value: { filename, generatedSource, sourceMap },
        configurable: true,
      });
    }
    if (error && typeof error.stack === "string") {
      error.stack = remapRegisteredSourceMapStack(error.stack);
    }
  } catch {}
  return error;
}

globalThis.__cottontailRemapModuleStackString ??= remapRegisteredSourceMapStack;

function originalErrorLocation(error, metadata) {
  const sourceMap = metadata?.sourceMap;
  const generatedLine = Number(error?.line);
  const generatedColumn = Number(error?.column);
  if (!sourceMap || !Number.isFinite(generatedLine) || !Number.isFinite(generatedColumn)) return null;

  let mapColumn = Math.max(0, generatedColumn - 1);
  const generatedLineText = String(metadata.generatedSource).split(/\r?\n/)[generatedLine - 1] ?? "";
  const constructorName = String(error?.name || "Error").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const constructorPattern = new RegExp(`\\bnew\\s+${constructorName}\\b`, "g");
  for (const match of generatedLineText.matchAll(constructorPattern)) {
    if (match.index <= mapColumn && match.index + match[0].length >= mapColumn) {
      mapColumn = match.index;
      break;
    }
  }

  const entry = sourceMap.findEntry(generatedLine - 1, mapColumn);
  if (entry?.originalSource == null || entry.originalLine == null || entry.originalColumn == null) return null;
  const source = String(entry.originalSource);
  const filename = source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)
    ? source
    : resolve(dirname(metadata.filename), source);
  const payload = sourceMap.payload;
  const sourceRoot = payload?.sourceRoot ? String(payload.sourceRoot) : "";
  const sourceIndex = Array.from(payload?.sources ?? [], String)
    .findIndex(candidate => `${sourceRoot}${candidate}` === source);
  return {
    filename,
    line: entry.originalLine + 1,
    column: entry.originalColumn + 1,
    source: sourceIndex >= 0 ? payload?.sourcesContent?.[sourceIndex] : undefined,
  };
}

function bunUncaughtCodeFrame(location, message) {
  if (typeof location?.source !== "string") return null;
  const lines = location.source.split(/\r?\n/);
  const start = Math.max(1, location.line - 5);
  const frame = [];
  for (let line = start; line <= location.line && line <= lines.length; line += 1) {
    frame.push(`${line} | ${lines[line - 1]}`);
  }
  frame.push(`${" ".repeat(String(location.line).length + 3 + Math.max(0, location.column - 1))}^`);
  frame.push(`error: ${String(message ?? "")}`);
  return frame.join("\n");
}

globalThis.__cottontailFormatUncaughtModuleError ??= error => {
  try {
    const metadata = error?.__ctModuleErrorMetadata;
    if (!metadata) return;
    const location = originalErrorLocation(error, metadata);
    const codeFrame = bunUncaughtCodeFrame(location, error?.message);
    if (codeFrame && location) {
      const frames = String(error.stack ?? "").split(/\r?\n/).slice(1).join("\n");
      error.stack = `${codeFrame}\n    at ${location.filename}:${location.line}:${location.column}${frames ? `\n${frames}` : ""}`;
      Object.defineProperty(error, "__cottontailFormattedStack", { value: true, configurable: true });
      return;
    }
    if (!metadata.sourceMap && String(metadata.generatedSource).startsWith("// @bun")) {
      error.stack = `${String(error.stack ?? error)}\nnote: missing sourcemaps for ${metadata.filename}\nnote: consider bundling with '--sourcemap' to get unminified traces`;
    }
  } catch {}
};

export const _cache = commonJsCacheObject;
export const _pathCache = modulePathCache;
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
const compileCacheEntries = new Map();
let sourceMapsSupport = { nodeModules: false, generatedCode: false };

function compileCacheKey(filename, source) {
  return crypto.createHash("sha256").update(`${filename}\0${source}`).digest("hex");
}

function recordCompileCache(filename, source) {
  if (compileCacheDir == null) return;
  try {
    const key = compileCacheKey(String(filename), String(source));
    const entry = {
      filename: String(filename),
      sourceHash: key,
      sourceLength: String(source).length,
      cachedAt: Date.now(),
    };
    compileCacheEntries.set(String(filename), entry);
    cottontail.writeFile(join(compileCacheDir, `${key}.json`), JSON.stringify(entry));
  } catch {}
}

const moduleExtensionsTarget = {
  ".js"(module, filename) {
    return executeDefaultExtension(module, filename, "js");
  },
  ".cjs"(module, filename) {
    return executeDefaultExtension(module, filename, "js");
  },
  ".mjs"(module, filename) {
    return executeDefaultExtension(module, filename, "js");
  },
  ".ts"(module, filename) {
    return executeDefaultExtension(module, filename, "ts");
  },
  ".cts"(module, filename) {
    return executeDefaultExtension(module, filename, "ts");
  },
  ".mts"(module, filename) {
    return executeDefaultExtension(module, filename, "ts");
  },
  ".node"(module, filename) {
    processModule.dlopen(module, filename);
    module.loaded = true;
  },
  ".json"(module, filename) {
    const source = cottontail.readFile(filename);
    try {
      module.exports = JSON.parse(source);
    } catch (error) {
      if (/(^|[\\/])package\.json$/.test(String(filename))) module.exports = parseJSONC(source);
      else throw error;
    }
    module.loaded = true;
  },
};

function clearModulePathCache() {
  for (const key of Object.keys(modulePathCache)) delete modulePathCache[key];
}

export const _extensions = new Proxy(moduleExtensionsTarget, {
  set(target, property, value) {
    target[property] = value;
    clearModulePathCache();
    return true;
  },
  deleteProperty(target, property) {
    const deleted = delete target[property];
    clearModulePathCache();
    return deleted;
  },
  defineProperty(target, property, descriptor) {
    Object.defineProperty(target, property, descriptor);
    clearModulePathCache();
    return true;
  },
});

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
  if (arguments.length === 0) throw new TypeError('The "from" argument must be a string');
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
  const text = String(request);
  if (text.startsWith("./") || text.startsWith("../") || text === "." || text === "..") {
    return [parent?.filename ? dirname(parent.filename) : "."];
  }
  return Array.isArray(parent?.paths) ? parent.paths : [];
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
  const text = String(request);
  if (options !== undefined && options !== null && options.paths !== undefined && !Array.isArray(options.paths)) {
    const error = new TypeError('The "options.paths" property must be an instance of Array.' +
      ` Received ${options.paths === null ? "null" : `type ${typeof options.paths}`}`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (options !== undefined && options !== null && Array.isArray(options.paths)) {
    // Node semantics: options.paths replaces the default lookup locations.
    // Relative requests resolve against each entry; bare specifiers search
    // node_modules starting from each entry.
    let lastError;
    for (const searchPath of options.paths) {
      const baseDir = String(searchPath);
      try {
        return resolveRequest(text, baseDir.endsWith("/") ? baseDir : `${baseDir}/`);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? moduleNotFoundError(text);
  }
  const base = parent?.filename || parent?.path || cottontail.cwd();
  return resolveRequest(text, base);
}

export function _load(request, parent = undefined, isMain = false) {
  const directMock = bunModuleMockFor(request);
  if (directMock.found) return directMock.value;
  const resolved = Module._resolveFilename(request, parent, isMain);
  const resolvedMock = bunModuleMockFor(resolved);
  if (resolvedMock.found) return resolvedMock.value;
  return loadCommonJsModule(resolved, parent, isMain);
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
  if (compileCacheDir != null) {
    try {
      cottontail.writeFile(join(compileCacheDir, "manifest.json"), JSON.stringify({
        version: 1,
        entries: Array.from(compileCacheEntries.values()),
      }));
    } catch {}
  }
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
  void error;
  const key = String(path);
  if (sourceMapCache.has(key)) return sourceMapCache.get(key);
  try {
    maybeRegisterSourceMap(key, cottontail.readFile(key));
  } catch {}
  return sourceMapCache.get(key);
}

export function findPackageJSON(specifier, base = cottontail.cwd()) {
  const root = packageRootFor(String(specifier), String(base));
  return root ? join(root, "package.json") : undefined;
}

class ModuleHooks {
  constructor(resolveHook, loadHook) {
    this.resolve = resolveHook;
    this.load = loadHook;
    Object.defineProperty(this, moduleHookIdKey, {
      value: Symbol(`module-hook-${nextModuleHookId++}`),
      configurable: false,
    });
  }

  deregister() {
    const index = moduleHooks.indexOf(this);
    if (index >= 0) moduleHooks.splice(index, 1);
  }
}

export function register(specifier, parentURL = undefined, options = undefined) {
  const parent = parentURL == null ? cottontail.cwd() : fileURLToPath(String(parentURL));
  const hooksModule = typeof specifier === "object" && specifier !== null
    ? specifier
    : createRequire(parent)(String(specifier));
  const hooks = hooksModule?.resolve || hooksModule?.load ? hooksModule : hooksModule?.default;
  const registered = registerHooks(hooks ?? {});
  if (typeof hooksModule?.initialize === "function") hooksModule.initialize(options?.data);
  else if (typeof hooks?.initialize === "function") hooks.initialize(options?.data);
  void registered;
}

export function registerHooks(hooks = undefined) {
  const { resolve: resolveHook, load: loadHook } = hooks;
  if (resolveHook !== undefined && typeof resolveHook !== "function") {
    throw invalidArgType("hooks.resolve", "function", resolveHook);
  }
  if (loadHook !== undefined && typeof loadHook !== "function") {
    throw invalidArgType("hooks.load", "function", loadHook);
  }
  const registered = new ModuleHooks(resolveHook, loadHook);
  moduleHooks.push(registered);
  return registered;
}

function isIdentifierStart(char) {
  return /[A-Za-z_$]/.test(char ?? "");
}

function isIdentifierPart(char) {
  return /[0-9A-Za-z_$]/.test(char ?? "");
}

function previousNonSpace(source, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(source[cursor])) return cursor;
  }
  return -1;
}

function nextNonSpace(source, index) {
  for (let cursor = index; cursor < source.length; cursor += 1) {
    if (!/\s/.test(source[cursor])) return cursor;
  }
  return -1;
}

function wordAt(source, index, word) {
  return source.slice(index, index + word.length) === word &&
    !isIdentifierPart(source[index - 1]) &&
    !isIdentifierPart(source[index + word.length]);
}

function skipStringLike(source, index) {
  const quote = source[index];
  if (quote === "/" && source[index + 1] === "/") {
    const newline = source.indexOf("\n", index + 2);
    return newline < 0 ? source.length : newline + 1;
  }
  if (quote === "/" && source[index + 1] === "*") {
    const end = source.indexOf("*/", index + 2);
    return end < 0 ? source.length : end + 2;
  }
  if (quote !== "\"" && quote !== "'" && quote !== "`") return index + 1;
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
  }
  return source.length;
}

function addMaskRange(ranges, start, end) {
  if (end > start) ranges.push([start, end]);
}

function findStatementEnd(source, start) {
  let curly = 0;
  let paren = 0;
  let square = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === "\"" || char === "'" || char === "`" || (char === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*"))) {
      cursor = skipStringLike(source, cursor) - 1;
      continue;
    }
    if (char === "{") curly += 1;
    else if (char === "}") {
      if (curly === 0) return cursor;
      curly -= 1;
      if (curly === 0 && paren === 0 && square === 0) return cursor + 1;
    } else if (char === "(") paren += 1;
    else if (char === ")") paren = Math.max(0, paren - 1);
    else if (char === "[") square += 1;
    else if (char === "]") square = Math.max(0, square - 1);
    else if ((char === ";" || char === "\n") && curly === 0 && paren === 0 && square === 0) return cursor + (char === ";" ? 1 : 0);
  }
  return source.length;
}

function findBalancedAngleEnd(source, start) {
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === "\"" || char === "'" || char === "`" || (char === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*"))) {
      cursor = skipStringLike(source, cursor) - 1;
      continue;
    }
    if (char === "<") depth += 1;
    else if (char === ">") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    } else if (depth === 0 || char === "\n" || char === ";" || char === "{") {
      return -1;
    }
  }
  return -1;
}

function findTypeEnd(source, start, terminators) {
  let angle = 0;
  let curly = 0;
  let paren = 0;
  let square = 0;
  let sawToken = false;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === "\"" || char === "'" || char === "`" || (char === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*"))) {
      cursor = skipStringLike(source, cursor) - 1;
      sawToken = true;
      continue;
    }
    if (angle === 0 && curly === 0 && paren === 0 && square === 0 && sawToken && terminators.has(char)) return cursor;
    if (char === "<") angle += 1;
    else if (char === ">") angle = Math.max(0, angle - 1);
    else if (char === "{") curly += 1;
    else if (char === "}") {
      if (curly === 0 && sawToken && terminators.has(char)) return cursor;
      curly = Math.max(0, curly - 1);
    } else if (char === "(") paren += 1;
    else if (char === ")") {
      if (paren === 0 && sawToken && terminators.has(char)) return cursor;
      paren = Math.max(0, paren - 1);
    } else if (char === "[") square += 1;
    else if (char === "]") {
      if (square === 0 && sawToken && terminators.has(char)) return cursor;
      square = Math.max(0, square - 1);
    } else if (char === "\n" && angle === 0 && curly === 0 && paren === 0 && square === 0) {
      return cursor;
    } else if (!/\s/.test(char)) {
      sawToken = true;
    }
  }
  return source.length;
}

function linePrefix(source, index) {
  const lineStart = Math.max(source.lastIndexOf("\n", index - 1) + 1, 0);
  return source.slice(lineStart, index);
}

function shouldMaskTypeColon(source, index) {
  const previous = previousNonSpace(source, index);
  const next = nextNonSpace(source, index + 1);
  if (previous < 0 || next < 0) return false;
  if (!isIdentifierPart(source[previous]) && source[previous] !== ")" && source[previous] !== "]" && source[previous] !== "?") return false;
  if (/['"`0-9]/.test(source[next])) return false;
  const prefix = linePrefix(source, index);
  if (/\bcase\s*$/.test(prefix)) return false;
  return true;
}

function applyMaskRanges(source, ranges) {
  if (ranges.length === 0) return source;
  const chars = Array.from(source);
  ranges.sort((left, right) => left[0] - right[0]);
  for (const [start, end] of ranges) {
    for (let index = start; index < end && index < chars.length; index += 1) {
      if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
    }
  }
  return chars.join("");
}

function stripTypeScriptTypesPreserveWhitespace(source) {
  const ranges = [];
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === "\"" || char === "'" || char === "`" || (char === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*"))) {
      cursor = skipStringLike(source, cursor) - 1;
      continue;
    }
    if (wordAt(source, cursor, "interface") ||
        (wordAt(source, cursor, "type") && !/import\s*\{[^}\n]*$/.test(linePrefix(source, cursor)))) {
      const prefixWindow = source.slice(Math.max(0, cursor - 24), cursor);
      const start = prefixWindow.match(/\b(?:export\s+)?(?:declare\s+)?$/)?.index;
      const maskStart = start == null ? cursor : Math.max(0, cursor - 24) + start;
      let statementEnd = findStatementEnd(source, cursor);
      const after = nextNonSpace(source, statementEnd);
      if (after >= 0 && source[after] === ";") statementEnd = after + 1;
      addMaskRange(ranges, maskStart, statementEnd);
      continue;
    }
    if (wordAt(source, cursor, "import") && /^\s*type\b/.test(source.slice(cursor + "import".length))) {
      addMaskRange(ranges, cursor, findStatementEnd(source, cursor));
      continue;
    }
    if (wordAt(source, cursor, "implements")) {
      addMaskRange(ranges, cursor, findTypeEnd(source, cursor + "implements".length, new Set(["{", "\n"])));
      continue;
    }
    if (wordAt(source, cursor, "as")) {
      addMaskRange(ranges, cursor, findTypeEnd(source, cursor + 2, new Set([";", ",", ")", "]", "}", "\n"])));
      continue;
    }
    if (wordAt(source, cursor, "satisfies")) {
      addMaskRange(ranges, cursor, findTypeEnd(source, cursor + 9, new Set([";", ",", ")", "]", "}", "\n"])));
      continue;
    }
    if (char === "<") {
      const previous = previousNonSpace(source, cursor);
      const end = findBalancedAngleEnd(source, cursor);
      const next = end >= 0 ? nextNonSpace(source, end) : -1;
      if (previous >= 0 && isIdentifierPart(source[previous]) && next >= 0 && source[next] === "(") addMaskRange(ranges, cursor, end);
      continue;
    }
    if (char === "?") {
      const next = nextNonSpace(source, cursor + 1);
      if (next >= 0 && (source[next] === ":" || source[next] === "," || source[next] === ")" || source[next] === ";")) {
        addMaskRange(ranges, cursor, cursor + 1);
      }
      continue;
    }
    if (char === ":" && shouldMaskTypeColon(source, cursor)) {
      const end = findTypeEnd(source, cursor + 1, new Set(["=", ",", ")", ";", "{", "}", "\n"]));
      if (end > cursor + 1) addMaskRange(ranges, cursor, end);
      continue;
    }
    if (char === "!" && source[cursor + 1] !== "=") {
      const previous = previousNonSpace(source, cursor);
      const next = nextNonSpace(source, cursor + 1);
      if (previous >= 0 && isIdentifierPart(source[previous]) && next >= 0 && /[;,.()[\]}\n]/.test(source[next])) {
        addMaskRange(ranges, cursor, cursor + 1);
      }
    }
  }

  source.replace(/import\s*\{([^}]*)\}\s*from/g, (match, names, offset) => {
    const namesStart = offset + match.indexOf("{") + 1;
    const specifier = /(?:^|,)\s*type\s+[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*,?\s*/g;
    let item;
    while ((item = specifier.exec(names)) != null) {
      addMaskRange(ranges, namesStart + item.index, namesStart + item.index + item[0].length);
    }
    return match;
  });

  return applyMaskRanges(source, ranges);
}

export function stripTypeScriptTypes(source, options = undefined) {
  if (typeof source !== "string") {
    throw new TypeError("module.stripTypeScriptTypes source must be a string");
  }

  let mode = "strip";
  let sourceMap = false;
  let sourceUrl = undefined;
  if (options != null) {
    if (typeof options !== "object") throw new TypeError("module.stripTypeScriptTypes options must be an object");
    if (options.mode != null) mode = String(options.mode);
    if (options.sourceMap != null) sourceMap = Boolean(options.sourceMap);
    if (options.sourceUrl != null) sourceUrl = String(options.sourceUrl);
  }

  if (mode !== "strip" && mode !== "transform") {
    throw new RangeError("module.stripTypeScriptTypes mode must be 'strip' or 'transform'");
  }
  if (sourceMap && mode === "strip") {
    throw new Error("module.stripTypeScriptTypes sourceMap cannot be used with mode 'strip'");
  }
  if (typeof cottontail.stripTypeScriptTypes !== "function") {
    throw new Error("module.stripTypeScriptTypes native parser is unavailable");
  }

  let output = mode === "strip"
    ? stripTypeScriptTypesPreserveWhitespace(source)
    : cottontail.stripTypeScriptTypes(source, 1);
  if (sourceUrl !== undefined) output += `\n\n//# sourceURL=${sourceUrl}`;
  return output;
}

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
const pathBuiltin = path.default ?? path;
// require("path/posix") must be the same object as require("path").posix.
const pathPosixBuiltin = pathBuiltin.posix ?? (pathPosix.default ?? pathPosix);
const pathWin32Builtin = pathBuiltin.win32 ?? (pathWin32.default ?? pathWin32);
// require("fs/promises") must be the same object as require("fs").promises
// (Node exposes fs.promises as the exact fs/promises module object).
const fsBuiltin = fs.default ?? fs;
const fsPromisesBuiltin = fsBuiltin.promises ?? (fsPromises.default ?? fsPromises);
// CommonJS exposes a mutable object for node:buffer. Some Node APIs, including
// zlib's global output limit, intentionally observe mutations to that object.
const bufferBuiltin = buffer.default ?? buffer;
const httpAgentBuiltin = { Agent: http.Agent, globalAgent: http.globalAgent };
const httpClientBuiltin = { ClientRequest: http.ClientRequest };
const httpIncomingBuiltin = {
  IncomingMessage: http.IncomingMessage,
  readStart(socket) { if (socket?.readable && !socket._paused) socket.resume?.(); },
  readStop(socket) { socket?.pause?.(); },
};
const httpOutgoingBuiltin = {
  OutgoingMessage: http.OutgoingMessage,
  validateHeaderName: http.validateHeaderName,
  validateHeaderValue: http.validateHeaderValue,
};
const httpServerBuiltin = {
  STATUS_CODES: http.STATUS_CODES,
  Server: http.Server,
  ServerResponse: http.ServerResponse,
  _connectionListener: http._connectionListener,
};
const httpTokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const invalidHeaderValuePattern = /[\0-\x08\x0A-\x1F\x7F]/;
const httpCommonBuiltin = {
  validateHeaderName: http.validateHeaderName,
  validateHeaderValue: http.validateHeaderValue,
  _checkIsHttpToken(value) { return httpTokenPattern.test(String(value)); },
  _checkInvalidHeaderChar(value) { return invalidHeaderValuePattern.test(String(value)); },
  chunkExpression: /(?:^|\W)chunked(?:$|\W)/i,
  continueExpression: /(?:^|\W)100-continue(?:$|\W)/i,
  CRLF: "\r\n",
  methods: http.METHODS,
};
function translatePeerCertificate(certificate) {
  if (!certificate) return null;
  if (certificate.issuerCertificate != null && certificate.issuerCertificate !== certificate) {
    certificate.issuerCertificate = translatePeerCertificate(certificate.issuerCertificate);
  }
  if (certificate.infoAccess != null && typeof certificate.infoAccess === "string") {
    const infoAccess = certificate.infoAccess;
    certificate.infoAccess = Object.create(null);
    infoAccess.replace(/([^\n:]*):([^\n]*)(?:\n|$)/g, (_all, key, rawValue) => {
      let value = rawValue;
      if (value.charCodeAt(0) === 0x22) value = JSON.parse(value);
      if (key in certificate.infoAccess) certificate.infoAccess[key].push(value);
      else certificate.infoAccess[key] = [value];
      return "";
    });
  }
  return certificate;
}
const tlsCommonBuiltin = {
  SecureContext: tls.SecureContext,
  createSecureContext: tls.createSecureContext,
  translatePeerCertificate,
};
const tlsWrapBuiltin = {
  TLSSocket: tls.TLSSocket,
  Server: tls.Server,
  createServer: tls.createServer,
  connect: tls.connect,
};

__setBuiltinModules({
  _http_agent: httpAgentBuiltin,
  "node:_http_agent": httpAgentBuiltin,
  _http_client: httpClientBuiltin,
  "node:_http_client": httpClientBuiltin,
  _http_common: httpCommonBuiltin,
  "node:_http_common": httpCommonBuiltin,
  _http_incoming: httpIncomingBuiltin,
  "node:_http_incoming": httpIncomingBuiltin,
  _http_outgoing: httpOutgoingBuiltin,
  "node:_http_outgoing": httpOutgoingBuiltin,
  _http_server: httpServerBuiltin,
  "node:_http_server": httpServerBuiltin,
  _stream_duplex: stream.Duplex,
  "node:_stream_duplex": stream.Duplex,
  _stream_passthrough: stream.PassThrough,
  "node:_stream_passthrough": stream.PassThrough,
  _stream_readable: stream.Readable,
  "node:_stream_readable": stream.Readable,
  _stream_transform: stream.Transform,
  "node:_stream_transform": stream.Transform,
  _stream_wrap: streamBuiltin,
  "node:_stream_wrap": streamBuiltin,
  _stream_writable: stream.Writable,
  "node:_stream_writable": stream.Writable,
  _tls_common: tlsCommonBuiltin,
  "node:_tls_common": tlsCommonBuiltin,
  _tls_wrap: tlsWrapBuiltin,
  "node:_tls_wrap": tlsWrapBuiltin,
  assert: assertBuiltin,
  "node:assert": assertBuiltin,
  "assert/strict": assertStrictBuiltin,
  "node:assert/strict": assertStrictBuiltin,
  async_hooks: asyncHooks,
  "node:async_hooks": asyncHooks,
  buffer: bufferBuiltin,
  "node:buffer": bufferBuiltin,
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
  "fs/promises": fsPromisesBuiltin,
  "node:fs/promises": fsPromisesBuiltin,
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
  "internal/assert/myers_diff": internalAssertMyersDiff,
  "internal/async_hooks": internalAsyncHooks,
  "internal/event_target": internalEventTarget,
  "internal/test/binding": internalTestBinding,
  module: Module,
  "node:module": Module,
  net,
  "node:net": net,
  "node:sea": sea,
  "node:sqlite": sqlite,
  "node:test": nodeTestBuiltin,
  "node:test/reporters": testReporters,
  os,
  "node:os": os,
  path: pathBuiltin,
  "node:path": pathBuiltin,
  "path/posix": pathPosixBuiltin,
  "node:path/posix": pathPosixBuiltin,
  "path/win32": pathWin32Builtin,
  "node:path/win32": pathWin32Builtin,
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

// Node's `module` builtin IS the Module class (module.exports = Module), so
// mirror every namespace property onto the class and export it as default.
for (const [propertyName, propertyValue] of Object.entries(moduleBuiltin)) {
  if (!(propertyName in Module)) Module[propertyName] = propertyValue;
}

export default Module;
