import { basename, dirname, isAbsolute, join, resolve } from "./path.js";
import { fileURLToPath, pathToFileURL } from "./url.js";
import { parse as parseTOML } from "../bun/toml.js";
import { openRuntimeTranspilerCache } from "../internal/runtime-transpiler-cache.js";
import * as path from "./path.js";
import * as url from "./url.js";

// Runtime module loading must not depend on user-replaceable globals. Bun
// deliberately permits replacing Promise and Set, while import() continues to
// use the realm intrinsics captured before user code runs.
const IntrinsicPromise = globalThis.Promise;
const IntrinsicSet = globalThis.Set;
const intrinsicPromiseResolve = IntrinsicPromise.resolve.bind(IntrinsicPromise);
const intrinsicPromiseReject = IntrinsicPromise.reject.bind(IntrinsicPromise);
const intrinsicQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);

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

// Runtime builtins stay embedded in the executable, while their source and
// bytecode stay outside the startup graph. The module loader retrieves and
// compiles a source on first use, preserving synchronous require() semantics.
const assert = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/assert.js"));
const assertStrict = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/assert/strict.js"));
const asyncHooks = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/async_hooks.js"));
const buffer = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/buffer.js"));
const childProcess = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/child_process.js"));
const consoleModule = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/console.js"));
const nodeConstants = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/constants.js"));
const crypto = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/crypto.js"));
const diagnosticsChannel = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/diagnostics_channel.js"));
const dns = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/dns.js"));
const dnsPromises = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/dns/promises.js"));
const domain = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/domain.js"));
const events = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/events.js"));
const fs = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/fs.js"));
const fsPromises = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/fs/promises.js"));
const http = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/http.js"));
const https = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/https.js"));
const internalAssertMyersDiff = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/internal/assert/myers_diff.js"));
const internalAsyncHooks = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/internal/async_hooks.js"));
const internalEventTarget = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/internal/event_target.js"));
const httpCommon = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/internal/http_common.js"));
const permissions = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/internal/permissions.js"));
const internalTestBinding = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/internal/test/binding.js"));
const net = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/net.js"));
const os = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/os.js"));
const perfHooks = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/perf_hooks.js"));
const processModule = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/process.js"));
const punycode = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/punycode.js"));
const querystring = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/querystring.js"));
const stream = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/stream.js"));
const streamConsumers = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/stream/consumers.js"));
const streamPromises = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/stream/promises.js"));
const streamWeb = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/stream/web.js"));
const stringDecoder = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/string_decoder.js"));
const sys = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/sys.js"));
const timers = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/timers.js"));
const timersPromises = lazyBuiltin(() => {
  const namespace = loadEmbeddedRuntimeModule("node/timers/promises.js");
  return namespace.default ?? namespace;
});
const tls = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/tls.js"));
const tty = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/tty.js"));
const util = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/util.js"));
const utilTypes = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/util/types.js"));
const vm = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/vm.js"));
const zlib = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/zlib.js"));
const bunWrap = lazyBuiltin(() => loadEmbeddedRuntimeModule("bun/wrap.js"));

const assertFsRead = (...args) => unwrapBuiltin(permissions).assertFsRead(...args);
const assertFsWrite = (...args) => unwrapBuiltin(permissions).assertFsWrite(...args);
const cluster = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/cluster.js"));
const dgram = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/dgram.js"));
const http2 = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/http2.js"));
const inspector = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/inspector.js"));
const inspectorPromises = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/inspector/promises.js"));
const readline = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/readline.js"));
const readlinePromises = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/readline/promises.js"));
const repl = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/repl.js"));
const sea = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/sea.js"));
const sqlite = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/sqlite.js"));
const nodeTestBuiltin = lazyBuiltin(() => {
  const namespace = loadEmbeddedRuntimeModule("node/test.js");
  return namespace.default ?? namespace;
});
const testReporters = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/test/reporters.js"));
const traceEvents = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/trace_events.js"));
const v8 = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/v8.js"));
const wasi = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/wasi.js"));
const workerThreads = lazyBuiltin(() => loadEmbeddedRuntimeModule("node/worker_threads.js"));

const runtimePackageReplacements = new Map([
  ["abort-controller", lazyBuiltin(() => {
    const namespace = loadEmbeddedRuntimeModule("vendor/abort-controller.js");
    return namespace.default ?? namespace;
  })],
  ["node-fetch", lazyBuiltin(() => {
    const namespace = loadEmbeddedRuntimeModule("bun/node-fetch.js");
    return namespace.default ?? namespace;
  })],
  ["next/dist/compiled/node-fetch", lazyBuiltin(() => {
    const namespace = loadEmbeddedRuntimeModule("bun/node-fetch.js");
    return namespace.default ?? namespace;
  })],
  ["isomorphic-fetch", lazyBuiltin(() => {
    const namespace = loadEmbeddedRuntimeModule("vendor/isomorphic-fetch.js");
    return namespace.default ?? namespace;
  })],
  ["@vercel/fetch", lazyBuiltin(() => {
    const namespace = loadEmbeddedRuntimeModule("vendor/vercel-fetch.js");
    return namespace.default ?? namespace;
  })],
  ["utf-8-validate", lazyBuiltin(() => {
    const namespace = loadEmbeddedRuntimeModule("bun/utf-8-validate.js");
    return namespace.default ?? namespace;
  })],
  ["ws", lazyBuiltin(() => {
    const namespace = loadEmbeddedRuntimeModule("vendor/ws.js");
    return namespace.default ?? namespace;
  })],
  ["ws/lib/websocket", lazyBuiltin(() => {
    const namespace = loadEmbeddedRuntimeModule("vendor/ws.js");
    return namespace.default ?? namespace;
  })],
  ["next/dist/compiled/ws", lazyBuiltin(() => {
    const namespace = loadEmbeddedRuntimeModule("vendor/ws.js");
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
  if (text === "process" || text === "node:process") return loadFullProcessBuiltin();
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
const commonJsWrapperFactoryCache = new Map();
const bundledCommonJsFactoryCache = new Map();
const runtimeEsmWrapperCache = new Map();
const nodeModulePathsCache = new Map();
const nodeModulePathsCacheLimit = 256;
const smolModuleCacheGcInterval = 16;
const smolDynamicModuleCacheGcInterval = 1024;
const bundledAsyncEsmGraphCache = new Map();
const runtimeEsmLinkageRecords = new Map();
const nativeObjectDefineProperty = Object.defineProperty;
const builtinModuleMap = new Map();
const builtinNamespaceEntries = new IntrinsicSet();
const builtinImportNamespaces = new Map();
const kBuiltinImportNamespaces = Symbol.for("cottontail.node.builtinImportNamespaces");
let modulePathCache = Object.create(null);
const moduleHooks = [];
const moduleHookIdKey = Symbol("cottontail.moduleHooksId");
const moduleParentKey = Symbol("cottontail.moduleParent");
const modulePathsBaseKey = Symbol("cottontail.modulePathsBase");
const runtimeEsmSourceModuleKey = Symbol("cottontail.runtimeEsmSourceModule");
const dynamicImportModuleKey = Symbol("cottontail.dynamicImportModule");
const mainModuleStateKey = Symbol.for("cottontail.node.mainModuleState");
const mainModuleState = globalThis[mainModuleStateKey] ??= {
  current: null,
  hasOverride: false,
  override: undefined,
};
const hookResolvedFormats = new Map();
const sourceMapCache = new Map();
// Files already probed and found to carry no source map. Without this, every
// stack-string remap re-read every frame's file from disk.
const sourceMapMisses = new IntrinsicSet();
// Remapping a stack string is a pure function of the registered source maps,
// and the same stack recurs constantly (loops, repeated assertions).
const remappedStacks = new Map();
const nativeModuleResolveCacheGet = cottontail.moduleResolveCacheGet;
const nativeModuleResolveCachePut = cottontail.moduleResolveCachePut;
const nativeModuleResolveCacheClear = cottontail.moduleResolveCacheClear;
let nextModuleHookId = 0;
let mainModule = null;
let moduleParentWarningEmitted = false;
let activeResolverConditions = null;
let stripTypesWarningEmitted = false;
let runtimeEsmSourceExecutionDepth = 0;
let implicitDefaultExtensionContext = null;
let smolModuleCacheMode;
let smolModuleCacheEvictions = 0;
let smolDynamicModuleCacheEvictions = 0;

const runtimePluginOnResolve = [];
const runtimePluginOnLoad = [];
const runtimePluginVirtualModules = new Map();
const runtimePluginResolvedModules = new Map();
const runtimePluginPendingLoads = new Map();
const runtimePluginInvalidatableKeys = new IntrinsicSet();
const runtimePluginRevisions = new Map();
let runtimePluginGeneration = 0;
const runtimePluginNamespacePattern = /^[/@A-Za-z0-9_-]+$/;

const hotReloadHooks = globalThis.__cottontailHotReloadHooks ?? new IntrinsicSet();
if (globalThis.__cottontailHotReloadHooks == null) {
  Object.defineProperty(globalThis, "__cottontailHotReloadHooks", { value: hotReloadHooks, configurable: true });
}
hotReloadHooks.add(() => {
  commonJsCache.clear();
  commonJsWrapperFactoryCache.clear();
  bundledCommonJsFactoryCache.clear();
  runtimeEsmWrapperCache.clear();
  asyncEsmModuleCache.clear();
  registeredSelfEsmNamespaces.clear();
  nodeModulePathsCache.clear();
  bundledAsyncEsmGraphCache.clear();
  runtimeEsmLinkageRecords.clear();
  builtinModuleMap.clear();
  builtinNamespaceEntries.clear();
  builtinImportNamespaces.clear();
  clearModulePathCache();
  moduleHooks.length = 0;
  hookResolvedFormats.clear();
  sourceMapCache.clear();
  sourceMapMisses.clear();
  remappedStacks.clear();
  clearRuntimePlugins();
  mainModule = null;
  mainModuleState.current = null;
  mainModuleState.hasOverride = false;
  mainModuleState.override = undefined;
  smolModuleCacheEvictions = 0;
  smolDynamicModuleCacheEvictions = 0;
});

function runtimePluginFilterMatches(filter, path) {
  const lastIndex = filter.lastIndex;
  filter.lastIndex = 0;
  try {
    return filter.test(path);
  } finally {
    filter.lastIndex = lastIndex;
  }
}

function runtimePluginRegistrationNamespace(value) {
  if (typeof value !== "string") return "";
  const namespace = value;
  if (!runtimePluginNamespacePattern.test(namespace)) {
    throw new Error("namespace can only contain letters, numbers, dashes, or underscores");
  }
  return namespace === "file" ? "" : namespace;
}

function runtimePluginResultNamespace(value) {
  if (value == null || value === "") return "file";
  if (!runtimePluginNamespacePattern.test(value)) {
    throw new Error("namespace can only contain letters, numbers, dashes, or underscores");
  }
  return value;
}

function runtimePluginRegistration(kind, constraints, callback) {
  if (constraints == null || typeof constraints !== "object" || !(constraints.filter instanceof RegExp)) {
    throw new Error(`${kind}() expects first argument to be an object with a filter RegExp`);
  }
  if (typeof callback !== "function") {
    throw new Error(`${kind}() expects second argument to be a function`);
  }
  return {
    filter: new RegExp(constraints.filter.source, constraints.filter.flags),
    namespace: runtimePluginRegistrationNamespace(constraints.namespace),
    callback,
  };
}

function splitRuntimePluginSpecifier(specifier) {
  const text = String(specifier);
  const colon = text.indexOf(":");
  if (colon < 0 || (colon === 1 && /^[A-Za-z]:[\\/]/.test(text))) {
    return { namespace: "", path: text };
  }
  const namespace = text.slice(0, colon);
  return { namespace: namespace === "file" ? "" : namespace, path: text.slice(colon + 1) };
}

function runtimePluginCouldResolve(specifier) {
  const lastDot = specifier.lastIndexOf(".");
  if (lastDot >= 0 && lastDot + 1 < specifier.length) {
    const first = specifier.charCodeAt(lastDot + 1);
    if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first > 127) return true;
  }
  return !isAbsolute(specifier) && specifier.includes(":");
}

function runtimePluginKey(namespace, path) {
  return namespace === "file" ? String(path) : `${namespace}:${path}`;
}

function runtimePluginRuleFor(rules, namespace, path) {
  const group = namespace === "file" ? "" : namespace;
  for (const rule of rules) {
    if (rule.namespace !== group) continue;
    if (runtimePluginFilterMatches(rule.filter, path)) return rule;
  }
  return null;
}

function runtimePluginRevision(key) {
  return runtimePluginRevisions.get(key) ?? 0;
}

function invalidateRuntimePluginKey(key) {
  commonJsCache.delete(key);
  globalThis.Loader?.registry?.delete?.(key);
}

function trackRuntimePluginDescriptor(descriptor, requestKey, invalidatable) {
  descriptor.requestKey = String(requestKey ?? descriptor.key);
  descriptor.invalidatable = invalidatable;
  if (invalidatable) {
    runtimePluginInvalidatableKeys.add(descriptor.key);
    runtimePluginInvalidatableKeys.add(descriptor.requestKey);
  }
  return descriptor;
}

function runtimePluginLoadToken(descriptor) {
  return {
    generation: runtimePluginGeneration,
    revision: runtimePluginRevision(descriptor.key),
  };
}

function runtimePluginLoadIsCurrent(descriptor, token) {
  return (!descriptor.invalidatable || token.generation === runtimePluginGeneration) &&
    token.revision === runtimePluginRevision(descriptor.key);
}

function discardStaleRuntimePluginRegistryEntry(descriptor, token) {
  intrinsicQueueMicrotask(() => {
    if (runtimePluginLoadIsCurrent(descriptor, token)) return;
    if (runtimePluginRevision(descriptor.key) !== token.revision && commonJsCache.has(descriptor.key)) return;
    globalThis.Loader?.registry?.delete?.(descriptor.key);
    if (descriptor.requestKey !== descriptor.key) globalThis.Loader?.registry?.delete?.(descriptor.requestKey);
  });
}

function clearRuntimePlugins() {
  runtimePluginGeneration++;
  for (const key of runtimePluginInvalidatableKeys) invalidateRuntimePluginKey(key);
  runtimePluginInvalidatableKeys.clear();
  runtimePluginOnResolve.length = 0;
  runtimePluginOnLoad.length = 0;
  runtimePluginVirtualModules.clear();
  runtimePluginResolvedModules.clear();
  runtimePluginPendingLoads.clear();
}

function normalizeRuntimePluginThrownError(error) {
  if (error instanceof RangeError && error.message === "Maximum call stack size exceeded.") {
    for (const property of ["sourceURL", "fileName", "line", "lineNumber", "column", "columnNumber"]) {
      try { delete error[property]; } catch {}
    }
  }
  return error;
}

function runtimePluginPromiseStatus(value) {
  return typeof cottontail.promiseStatus === "function"
    ? cottontail.promiseStatus(value)
    : -1;
}

function unwrapRuntimePluginResolveResult(result) {
  const status = runtimePluginPromiseStatus(result);
  if (status < 0) return result;
  if (status === 0) throw new TypeError("onResolve() doesn't support pending promises yet");
  const settled = cottontail.promiseResult(result);
  if (status === 2) {
    intrinsicPromiseResolve(result).catch(() => {});
    throw settled;
  }
  return settled;
}

function normalizeRuntimePluginResolution(result, importer, requestKey, inputNamespace) {
  if (result == null) return null;
  if (typeof result !== "object") throw new TypeError("onResolve() expects an object returned");
  if (result.path == null) return null;
  if (typeof result.path !== "string") {
    throw new TypeError('Expected "path" to be a string in onResolve plugin');
  }
  if (result.path.length === 0) {
    throw new TypeError('Expected "path" to be a non-empty string in onResolve plugin');
  }
  if (result.path === "." || result.path === ".." || result.path === "..." || result.path === " ") {
    throw new TypeError('"path" is invalid in onResolve plugin');
  }
  if (result.namespace != null && typeof result.namespace !== "string") {
    throw new TypeError('Expected "namespace" to be a string');
  }
  const namespace = runtimePluginResultNamespace(result.namespace);
  let path = result.path;
  if (namespace === "file" && !isAbsolute(path) && !path.startsWith("file:")) {
    const base = importer && isAbsolute(importer) ? dirname(importer) : cottontail.cwd();
    path = resolve(base, path);
  }
  const descriptor = trackRuntimePluginDescriptor(
    { namespace, path, key: runtimePluginKey(namespace, path) },
    requestKey,
    inputNamespace !== "" || namespace !== "file",
  );
  runtimePluginResolvedModules.set(descriptor.key, descriptor);
  return descriptor;
}

function resolveWithRuntimePlugins(specifier, importer = "", kind = "import") {
  void kind;
  const text = String(specifier);
  if (runtimePluginVirtualModules.has(text)) {
    return trackRuntimePluginDescriptor(
      { namespace: "virtual", path: text, key: text, virtual: true },
      text,
      true,
    );
  }
  if (!runtimePluginCouldResolve(text)) return null;
  const initial = splitRuntimePluginSpecifier(text);
  for (const rule of runtimePluginOnResolve) {
    if (rule.namespace !== initial.namespace) continue;
    if (!runtimePluginFilterMatches(rule.filter, initial.path)) continue;
    let result;
    try {
      result = Reflect.apply(rule.callback, undefined, [{
        path: initial.path,
        importer: String(importer ?? ""),
      }]);
    } catch (error) {
      throw normalizeRuntimePluginThrownError(error);
    }
    result = unwrapRuntimePluginResolveResult(result);
    const descriptor = normalizeRuntimePluginResolution(result, importer, text, initial.namespace);
    if (descriptor) return descriptor;
  }
  if (initial.namespace !== "" && runtimePluginRuleFor(runtimePluginOnLoad, initial.namespace, initial.path)) {
    const descriptor = trackRuntimePluginDescriptor(
      { ...initial, key: runtimePluginKey(initial.namespace, initial.path) },
      text,
      true,
    );
    runtimePluginResolvedModules.set(descriptor.key, descriptor);
    return descriptor;
  }
  return null;
}

async function resolveRuntimePluginEntrypoint(specifier, importer = "") {
  const text = String(specifier);
  const base = String(importer || cottontail.cwd());
  let descriptor = null;
  if (runtimePluginVirtualModules.has(text)) {
    descriptor = trackRuntimePluginDescriptor(
      { namespace: "virtual", path: text, key: text, virtual: true },
      text,
      true,
    );
  } else if (runtimePluginCouldResolve(text)) {
    const initial = splitRuntimePluginSpecifier(text);
    for (const rule of runtimePluginOnResolve) {
      if (rule.namespace !== initial.namespace || !runtimePluginFilterMatches(rule.filter, initial.path)) continue;
      let result;
      try {
        result = await Reflect.apply(rule.callback, undefined, [{ path: initial.path, importer: base }]);
      } catch (error) {
        throw normalizeRuntimePluginThrownError(error);
      }
      descriptor = normalizeRuntimePluginResolution(result, base, text, initial.namespace);
      if (descriptor) break;
    }
    if (!descriptor && initial.namespace !== "" && runtimePluginRuleFor(runtimePluginOnLoad, initial.namespace, initial.path)) {
      descriptor = trackRuntimePluginDescriptor(
        { ...initial, key: runtimePluginKey(initial.namespace, initial.path) },
        text,
        true,
      );
      runtimePluginResolvedModules.set(descriptor.key, descriptor);
    }
  }
  if (!descriptor) {
    let resolved;
    try {
      resolved = resolveRequest(text, base, true, "import");
    } catch {
      return null;
    }
    const fileDescriptor = {
      namespace: "file",
      path: String(resolved),
      key: String(resolved),
      requestKey: text,
      invalidatable: false,
    };
    if (!runtimePluginCallback(fileDescriptor)) return null;
    descriptor = fileDescriptor;
  }

  const value = importRuntimePlugin(descriptor);
  if (value !== undefined) return { matched: true, value };
  if (descriptor.namespace === "file") {
    return { matched: true, value: importResolvedRuntimeModule(descriptor.path) };
  }
  throw moduleNotFoundError(descriptor.key, false);
}

function runtimePluginDefaultLoader(path) {
  const extension = String(path).replace(/[?#].*$/, "").toLowerCase().match(/\.[^.\\/]+$/)?.[0];
  if (extension === ".jsx") return "jsx";
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return "ts";
  if (extension === ".tsx") return "tsx";
  if (extension === ".json") return "json";
  if (extension === ".toml") return "toml";
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  if (extension === ".md") return "md";
  return "js";
}

function runtimePluginContents(value) {
  if (typeof value === "string") return value;
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new TypeError('Expected "contents" to be a string or an ArrayBufferView');
}

function normalizeRuntimePluginLoadResult(result, descriptor) {
  if (result == null || typeof result !== "object") {
    throw new TypeError(descriptor.virtual
      ? "virtual module expects an object returned"
      : "onLoad() expects an object returned");
  }
  const loader = result.loader == null ? runtimePluginDefaultLoader(descriptor.path) : String(result.loader);
  if (!new IntrinsicSet(["js", "jsx", "object", "ts", "tsx", "toml", "yaml", "json", "md"]).has(loader)) {
    throw new TypeError('Expected loader to be one of "js", "jsx", "object", "ts", "tsx", "toml", "yaml", "json", or "md"');
  }
  if (result.resolveDir != null && typeof result.resolveDir !== "string") {
    throw new TypeError('Expected "resolveDir" to be a string');
  }
  if (loader === "object") {
    if (!Object.hasOwn(result, "exports") || result.exports === null || typeof result.exports !== "object") {
      throw new TypeError('"object" loader must return an "exports" object');
    }
    return { loader, exports: result.exports, resolveDir: result.resolveDir };
  }
  return {
    loader,
    contents: runtimePluginContents(result.contents),
    resolveDir: result.resolveDir,
  };
}

function runtimePluginObjectValues(exportsObject) {
  const namespace = {};
  for (const key of Object.keys(exportsObject)) namespace[key] = exportsObject[key];
  if (!Object.hasOwn(namespace, "default")) namespace.default = exportsObject;
  const requireValue = exportsObject.__esModule && Object.hasOwn(exportsObject, "default")
    ? exportsObject.default
    : Object.fromEntries(Object.keys(exportsObject).map((key) => [key, exportsObject[key]]));
  return { namespace, requireValue };
}

function runtimePluginExecutionPath(descriptor, result) {
  if (descriptor.namespace === "file" && isAbsolute(descriptor.path)) {
    return splitSpecifierSuffix(descriptor.path).bare;
  }
  const root = result.resolveDir == null ? cottontail.cwd() : resolve(String(result.resolveDir));
  const name = `${descriptor.namespace}-${descriptor.path}`.replace(/[^A-Za-z0-9._-]+/g, "_") || "module";
  const extension = result.loader === "ts" ? ".ts"
    : result.loader === "tsx" ? ".tsx"
    : result.loader === "jsx" ? ".jsx"
    : ".js";
  return join(root, `__cottontail_plugin_${name}${extension}`);
}

function runtimePluginTranspile(contents, loader, path, specifier) {
  if (loader === "json") return `export default ${JSON.stringify(JSON.parse(contents))};`;
  if (loader === "toml") return `export default ${JSON.stringify(parseTOML(contents))};`;
  if (loader === "yaml") {
    const value = globalThis.Bun?.YAML?.parse?.(contents);
    return `export default ${JSON.stringify(value)};`;
  }
  if (loader === "md") return `export default ${JSON.stringify(contents)};`;
  if (typeof cottontail.transpilerTransform !== "function") {
    return maybeStripTypeScript(path, contents);
  }
  try {
    return String(cottontail.transpilerTransform(
      contents,
      JSON.stringify({
        target: "bun",
        deadCodeElimination: false,
        _cottontailStructuredErrors: true,
        // Inject the automatic JSX runtime import + honor the project's tsconfig.
        jsxAutoImport: true,
        ...tsconfigTransformOverrides(path),
      }),
      loader,
    ));
  } catch (error) {
    const message = error?.message ?? String(error ?? "JavaScript transform failed");
    const prefix = "COTTONTAIL_DIAGNOSTICS:";
    if (message.startsWith(prefix)) {
      try {
        const diagnostics = JSON.parse(message.slice(prefix.length)).errors ?? [];
        const errors = diagnostics.map((diagnostic) => {
          const item = new SyntaxError(String(diagnostic.message ?? "Syntax error"));
          if (diagnostic.position) item.position = diagnostic.position;
          return item;
        });
        throw new AggregateError(errors, `${errors.length} errors building "${specifier}"`);
      } catch (structuredError) {
        if (structuredError instanceof AggregateError) throw structuredError;
      }
    }
    if (error && (typeof error === "object" || typeof error === "function")) throw error;
    throw new SyntaxError(message);
  }
}

function cacheRuntimePluginModule(descriptor, requireValue, namespace) {
  const module = makeModule(descriptor.key);
  module.exports = requireValue;
  module.loaded = true;
  Object.defineProperty(module, "__cottontailPluginNamespace", {
    value: namespace,
    configurable: true,
  });
  commonJsCache.set(descriptor.key, module);
  return module;
}

function evaluateRuntimePluginResult(descriptor, rawResult) {
  const result = normalizeRuntimePluginLoadResult(rawResult, descriptor);
  if (result.loader === "object") {
    const values = runtimePluginObjectValues(result.exports);
    return { ...values, async: false };
  }
  const executionPath = runtimePluginExecutionPath(descriptor, result);
  const source = runtimePluginTranspile(result.contents, result.loader, executionPath, descriptor.key);
  const namespace = executeDynamicImportSource(executionPath, source, "module");
  if (namespace && typeof namespace.then === "function") {
    return {
      async: true,
      promise: intrinsicPromiseResolve(namespace).then((value) => {
        if (value && typeof value === "object" && !Object.hasOwn(value, "__esModule")) {
          Object.defineProperty(value, "__esModule", { value: true, configurable: true });
        }
        return { namespace: value, requireValue: value };
      }),
    };
  }
  if (namespace && typeof namespace === "object" && !Object.hasOwn(namespace, "__esModule")) {
    Object.defineProperty(namespace, "__esModule", { value: true, configurable: true });
  }
  return { namespace, requireValue: namespace, async: false };
}

function runtimePluginCallback(descriptor) {
  if (descriptor.virtual) return runtimePluginVirtualModules.get(descriptor.path);
  return runtimePluginRuleFor(runtimePluginOnLoad, descriptor.namespace, descriptor.path)?.callback ?? null;
}

function callRuntimePluginLoadCallback(callback, descriptor) {
  const args = descriptor.virtual ? [] : [{ path: descriptor.path }];
  return Reflect.apply(callback, undefined, args);
}

function loadRuntimePluginSync(descriptor) {
  const cached = commonJsCache.get(descriptor.key);
  if (cached) return cached.exports;
  const callback = runtimePluginCallback(descriptor);
  if (!callback) return undefined;
  const token = runtimePluginLoadToken(descriptor);
  let rawResult = callRuntimePluginLoadCallback(callback, descriptor);
  const status = runtimePluginPromiseStatus(rawResult);
  if (status === 1) {
    rawResult = cottontail.promiseResult(rawResult);
  } else if (status === 2) {
    const reason = cottontail.promiseResult(rawResult);
    intrinsicPromiseResolve(rawResult).catch(() => {});
    throw reason;
  } else if (status === 0) {
    intrinsicPromiseResolve(rawResult).catch(() => {});
    throw new TypeError(`require() async module "${descriptor.key}" is unsupported. use "await import()" instead.`);
  }
  const evaluated = evaluateRuntimePluginResult(descriptor, rawResult);
  if (evaluated.async) {
    evaluated.promise.catch(() => {});
    throw new TypeError(`require() async module "${descriptor.key}" is unsupported. use "await import()" instead.`);
  }
  if (runtimePluginLoadIsCurrent(descriptor, token)) {
    return cacheRuntimePluginModule(descriptor, evaluated.requireValue, evaluated.namespace).exports;
  }
  discardStaleRuntimePluginRegistryEntry(descriptor, token);
  return evaluated.requireValue;
}

function importRuntimePlugin(descriptor) {
  const cached = commonJsCache.get(descriptor.key);
  if (cached) return cached.__cottontailPluginNamespace ?? namespaceFromCommonJs(cached.exports);
  if (runtimePluginPendingLoads.has(descriptor.key)) return runtimePluginPendingLoads.get(descriptor.key);
  const callback = runtimePluginCallback(descriptor);
  if (!callback) return undefined;
  const token = runtimePluginLoadToken(descriptor);
  let rawResult;
  try {
    rawResult = callRuntimePluginLoadCallback(callback, descriptor);
  } catch (error) {
    throw error;
  }
  const cacheResolved = (requireValue, namespace) => {
    if (runtimePluginLoadIsCurrent(descriptor, token)) {
      cacheRuntimePluginModule(descriptor, requireValue, namespace);
    } else {
      discardStaleRuntimePluginRegistryEntry(descriptor, token);
    }
    return namespace;
  };
  const finish = (value) => {
    const evaluated = evaluateRuntimePluginResult(descriptor, value);
    if (evaluated.async) {
      return evaluated.promise.then(resolved => cacheResolved(resolved.requireValue, resolved.namespace));
    }
    return cacheResolved(evaluated.requireValue, evaluated.namespace);
  };
  const status = runtimePluginPromiseStatus(rawResult);
  if (status === 1) {
    rawResult = cottontail.promiseResult(rawResult);
  } else if (status === 2) {
    const reason = cottontail.promiseResult(rawResult);
    intrinsicPromiseResolve(rawResult).catch(() => {});
    throw reason;
  }
  const output = status === 0 ? intrinsicPromiseResolve(rawResult).then(finish) : finish(rawResult);
  if (runtimePluginPromiseStatus(output) < 0) return output;
  const pending = intrinsicPromiseResolve(output);
  runtimePluginPendingLoads.set(descriptor.key, pending);
  pending.then(
    () => {
      if (runtimePluginPendingLoads.get(descriptor.key) === pending) runtimePluginPendingLoads.delete(descriptor.key);
    },
    () => {
      if (runtimePluginPendingLoads.get(descriptor.key) === pending) runtimePluginPendingLoads.delete(descriptor.key);
    },
  );
  return pending;
}

function tryImportRuntimePlugin(specifier, referrer, options = undefined, resolvedPath = undefined) {
  void options;
  const text = String(specifier);
  const importer = referrer == null
    ? cottontail.cwd()
    : String(referrer).startsWith("file:") ? fileURLToPath(String(referrer)) : String(referrer);
  const descriptor = resolveWithRuntimePlugins(text, importer, "dynamic-import");
  if (descriptor) {
    const value = importRuntimePlugin(descriptor);
    if (value !== undefined) return { matched: true, value };
    if (descriptor.namespace === "file") return { matched: false, resolved: descriptor.path };
    throw moduleNotFoundError(descriptor.key, false);
  }

  let resolved = resolvedPath;
  if (resolved == null) {
    try {
      resolved = resolveRequest(text, importer, true, "import");
    } catch {
      return null;
    }
  }
  const fileDescriptor = {
    namespace: "file",
    path: String(resolved),
    key: String(resolved),
    requestKey: text,
    invalidatable: false,
  };
  if (!runtimePluginCallback(fileDescriptor)) return null;
  return { matched: true, value: importRuntimePlugin(fileDescriptor) };
}

export function _registerBunPlugin(pluginOptions) {
  if (arguments.length === 0) throw new TypeError("plugin needs at least one argument (an object)");
  if (pluginOptions == null || typeof pluginOptions !== "object") {
    throw new TypeError("plugin needs an object as first argument");
  }
  if (typeof pluginOptions.setup !== "function") throw new TypeError("plugin needs a setup() function");
  if ("target" in pluginOptions) {
    const target = String(pluginOptions.target);
    if (!["node", "bun", "browser"].includes(target)) {
      throw new TypeError("plugin target must be one of 'node', 'bun' or 'browser'");
    }
  }
  const builder = {
    target: "bun",
    onResolve(constraints, callback) {
      if (arguments.length < 2) throw new Error("onResolve() requires at least 2 arguments");
      runtimePluginOnResolve.push(runtimePluginRegistration("onResolve", constraints, callback));
      return this;
    },
    onLoad(constraints, callback) {
      if (arguments.length < 2) throw new Error("onLoad() requires at least 2 arguments");
      runtimePluginOnLoad.push(runtimePluginRegistration("onLoad", constraints, callback));
      return this;
    },
    module(id, callback) {
      if (arguments.length < 2) throw new Error("module() needs 2 arguments: a module ID and a function to call");
      if (typeof id !== "string") throw new Error("module() expects first argument to be a string for the module ID");
      if (typeof callback !== "function") throw new Error("module() expects second argument to be a function");
      if (id.length === 0) throw new Error("virtual module cannot be blank");
      if (isBuiltin(id)) throw new Error(`module() cannot be used to override builtin module "${id}"`);
      if (id.startsWith(".")) throw new Error('virtual module cannot start with "."');
      runtimePluginRevisions.set(id, runtimePluginRevision(id) + 1);
      runtimePluginVirtualModules.set(id, callback);
      runtimePluginInvalidatableKeys.add(id);
      runtimePluginPendingLoads.delete(id);
      runtimePluginResolvedModules.delete(id);
      invalidateRuntimePluginKey(id);
      return this;
    },
  };
  const result = Reflect.apply(pluginOptions.setup, undefined, [builder]);
  return runtimePluginPromiseStatus(result) >= 0 ? result : undefined;
}

export function _clearBunPlugins(_unused) {
  void _unused;
  clearRuntimePlugins();
}

globalThis.__cottontailImportPluginModule = (specifier, referrer, options, resolvedPath) => {
  try {
    return tryImportRuntimePlugin(specifier, referrer, options, resolvedPath);
  } catch (error) {
    return { matched: true, value: intrinsicPromiseReject(error) };
  }
};

globalThis.__cottontailResolvePluginEntrypoint = resolveRuntimePluginEntrypoint;

globalThis.__cottontailApplyCommonJSModuleMock = (specifier, value) => {
  let resolved = String(specifier);
  if (!isAbsolute(resolved) && !resolved.startsWith("file://")) {
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
// require("fs/promises") === require("fs").promises and
// require("dns/promises") === require("dns").promises; storing the raw
// namespace here would break those identities.
const kUnwrapDefaultBuiltins = new IntrinsicSet([
  // constants.js declares the union of platform-specific ESM names, while
  // CommonJS exposes only the host-filtered default object.
  "constants",
  "node:constants",
  // Buffer's CommonJS export is mutable; zlib and other Node APIs observe
  // changes to that shared object.
  "buffer",
  "node:buffer",
  "fs/promises",
  "node:fs/promises",
  "dns/promises",
  "node:dns/promises",
  "stream/promises",
  "node:stream/promises",
  // Node's HTTP interceptors replace methods on the mutable CommonJS export.
  // Keep require(), ESM default imports, and named wrappers on that one object.
  "http",
  "node:http",
  "https",
  "node:https",
  "stream",
  "node:stream",
]);
const kBuiltinSharedSyntheticNamespaceExports = new Map([
  // The CommonJS stream export is the Stream constructor. Keep the bare and
  // node: ESM aliases on one synthetic namespace with the documented binding.
  ["stream", ["promises"]],
  // Preserve the real ESM namespace while unwrapping require() to the exact
  // object exposed as require("stream").promises.
  ["stream/promises", ["finished", "pipeline"]],
]);
const bufferMaxLengthStateKey = Symbol.for("cottontail.node.buffer.kMaxLength");

// Node's `require('node:crypto')` exposes its exports as writable data
// properties, so consumers may replace them. Next.js's `experimental.dynamicIO`
// instrumentation relies on this: it runs `nodeCrypto.randomUUID = wrapped`
// (and the same for randomBytes/randomFillSync/randomInt/generate*Sync) inside a
// try/catch, logging "Failed to install `require('node:crypto').X` extension"
// when the assignment throws. Our crypto module is authored in ESM and handed to
// require() as a module namespace whose named exports are getter-only accessors,
// so the assignment throws in strict mode and the warning fires. Give each
// configurable getter-only export a self-redefining setter: reads stay lazy (we
// never invoke the getter here) and the first assignment replaces the accessor
// with the assigned value, matching Node's reassignable crypto exports.
//
// Scoped to crypto deliberately. Applying it to every builtin also makes
// Next.js's node:fs-namespace patches take effect; those are silent no-ops
// today, and once live they route webpack's PackFileCacheStrategy reads through
// Next's io()-tracking fs wrappers, which surfaces a separate cache-restore
// "buffer error". crypto is the only module whose failed patch is user-visible.
function makeBuiltinExportsReassignable(moduleExports) {
  if (moduleExports == null ||
      (typeof moduleExports !== "object" && typeof moduleExports !== "function")) return;
  for (const key of Object.keys(moduleExports)) {
    const descriptor = Object.getOwnPropertyDescriptor(moduleExports, key);
    if (descriptor === undefined || !descriptor.configurable) continue;
    if (typeof descriptor.get !== "function" || descriptor.set !== undefined) continue;
    const get = descriptor.get;
    const enumerable = descriptor.enumerable;
    Object.defineProperty(moduleExports, key, {
      configurable: true,
      enumerable,
      get,
      set(value) {
        Object.defineProperty(this, key, {
          value,
          writable: true,
          enumerable,
          configurable: true,
        });
      },
    });
  }
}

// Wrap a builtin registry value so its getter-only exports become reassignable
// on first materialization (see makeBuiltinExportsReassignable). Preserves the
// lazy-thunk shape so registration stays deferred.
function withReassignableExports(value) {
  if (typeof value === "function" && value[kLazyBuiltin] === true) {
    return lazyBuiltin(() => {
      const resolved = unwrapBuiltin(value);
      makeBuiltinExportsReassignable(resolved);
      return resolved;
    });
  }
  makeBuiltinExportsReassignable(value);
  return value;
}

function installMutableBufferMaxLength(moduleExports) {
  if (moduleExports == null ||
      (typeof moduleExports !== "object" && typeof moduleExports !== "function")) return;
  if (!Object.hasOwn(globalThis, bufferMaxLengthStateKey)) {
    globalThis[bufferMaxLengthStateKey] = moduleExports.kMaxLength;
  }
  Object.defineProperty(moduleExports, "kMaxLength", {
    configurable: true,
    enumerable: true,
    get() { return globalThis[bufferMaxLengthStateKey]; },
    set(value) { globalThis[bufferMaxLengthStateKey] = value; },
  });
}

export function __setBuiltinModules(modules) {
  const globalMap = globalThis.__cottontailBuiltinModules ??= new Map();
  Object.defineProperty(globalMap, kBuiltinImportNamespaces, {
    value: builtinImportNamespaces,
    configurable: true,
  });
  for (let [name, value] of Object.entries(modules || {})) {
    let isLazy = typeof value === "function" && value[kLazyBuiltin] === true;
    if (isLazy && kUnwrapDefaultBuiltins.has(name)) {
      const lazyNamespace = value;
      value = lazyBuiltin(() => {
        const namespace = unwrapBuiltin(lazyNamespace);
        return namespace != null &&
          (typeof namespace === "object" || typeof namespace === "function") &&
          namespace.default != null
          ? namespace.default
          : namespace;
      });
      isLazy = true;
    }
    if (!isLazy && name.replace(/^node:/, "") === "buffer") installMutableBufferMaxLength(value);
    let isNamespace = value != null &&
      (typeof value === "object" || typeof value === "function") &&
      Object.hasOwn(value, "default");
    let importNamespace;
    const canonicalName = name.replace(/^node:/, "");
    const additionalNamedExports = kBuiltinSharedSyntheticNamespaceExports.get(canonicalName);
    if (!isLazy && additionalNamedExports !== undefined) {
      if (isNamespace) {
        importNamespace = value;
      } else {
        const matchingAlias = [canonicalName, `node:${canonicalName}`].find(
          alias => builtinModuleMap.get(alias) === value && builtinImportNamespaces.has(alias),
        );
        importNamespace = matchingAlias === undefined
          ? undefined
          : builtinImportNamespaces.get(matchingAlias);
        importNamespace ??= namespaceFromCommonJs(value, false, additionalNamedExports);
      }
    }
    if (!isLazy && kUnwrapDefaultBuiltins.has(name) && value && typeof value === "object" && value.default) {
      value = value.default;
      isNamespace = false;
    }
    if (importNamespace === undefined) builtinImportNamespaces.delete(name);
    else builtinImportNamespaces.set(name, importNamespace);
    if (isNamespace) builtinNamespaceEntries.add(name);
    else builtinNamespaceEntries.delete(name);
    // node:crypto's exports must be reassignable so Next.js's dynamicIO
    // instrumentation can wrap them without erroring (see the helper above).
    if (canonicalName === "crypto") value = withReassignableExports(value);
    builtinModuleMap.set(name, value);
    globalMap.set(name, value);
  }
}

function normalizeStandaloneFilePath(path) {
  let text = String(path);
  if (text.startsWith("file:")) {
    try { text = fileURLToPath(text); } catch {}
  }
  text = text.replace(/\\/g, "/");
  const drive = text.match(/^([A-Za-z]):\//);
  const rooted = drive != null || text.startsWith("/");
  const prefix = drive ? `${drive[1].toUpperCase()}:/` : rooted ? "/" : "";
  const rest = drive ? text.slice(3) : rooted ? text.slice(1) : text;
  const parts = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!rooted) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  return `${prefix}${parts.join("/")}` || (rooted ? prefix : ".");
}

function isStandaloneVirtualPath(path) {
  const normalized = normalizeStandaloneFilePath(path);
  return normalized === "/$bunfs/root" ||
    normalized.startsWith("/$bunfs/root/") ||
    normalized === "B:/~BUN/root" ||
    normalized.startsWith("B:/~BUN/root/");
}

function standaloneFileEntry(path) {
  const files = globalThis.__cottontailStandaloneFiles;
  if (files == null) return { found: false, value: undefined };
  const text = String(path);
  const normalized = normalizeStandaloneFilePath(text);
  const candidates = normalized === text ? [text] : [text, normalized];
  if (typeof files.has === "function" && typeof files.get === "function") {
    for (const candidate of candidates) {
      if (files.has(candidate)) return { found: true, value: files.get(candidate) };
    }
    return { found: false, value: undefined };
  }
  if (typeof files === "object") {
    for (const candidate of candidates) {
      if (Object.prototype.hasOwnProperty.call(files, candidate)) {
        return { found: true, value: files[candidate] };
      }
    }
  }
  return { found: false, value: undefined };
}

function standaloneDirectoryExists(path) {
  const files = globalThis.__cottontailStandaloneFiles;
  if (files == null) return false;
  const normalized = normalizeStandaloneFilePath(path);
  const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
  const keys = typeof files.keys === "function"
    ? files.keys()
    : typeof files === "object" ? Object.keys(files) : [];
  for (const key of keys) {
    if (normalizeStandaloneFilePath(key).startsWith(prefix)) return true;
  }
  return false;
}

const embeddedRuntimeDirectoryName = ".cottontail-embedded-runtime";
const embeddedRuntimeSourceCache = new Map();
const embeddedRuntimePreloadedModules = new Map();

function embeddedRuntimeRelativePath(path) {
  const text = String(path).replace(/\\/g, "/");
  const marker = `/${embeddedRuntimeDirectoryName}/`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  return text.slice(markerIndex + marker.length);
}

function isEmbeddedRuntimePath(path) {
  return embeddedRuntimeRelativePath(path) !== null;
}

function embeddedRuntimeSourceEntry(path) {
  const relativePath = embeddedRuntimeRelativePath(path);
  if (relativePath == null) return { found: false, value: undefined };
  if (embeddedRuntimeSourceCache.has(relativePath)) {
    const value = embeddedRuntimeSourceCache.get(relativePath);
    return { found: value !== undefined, value };
  }

  const overrideRoot = globalThis.process?.env?.COTTONTAIL_RUNTIME_MODULES_DIR;
  if (typeof overrideRoot === "string" && overrideRoot.length > 0) {
    const overridePath = join(overrideRoot, ...relativePath.split("/"));
    try {
      if (cottontail.existsSync(overridePath)) {
        const source = cottontail.readFile(overridePath);
        embeddedRuntimeSourceCache.set(relativePath, source);
        return { found: true, value: source };
      }
    } catch {}
  }

  const source = cottontail.runtimeModuleSourceNative(relativePath);
  embeddedRuntimeSourceCache.set(relativePath, source);
  return { found: source !== undefined, value: source };
}

function embeddedRuntimePath(relativePath) {
  const root = cottontail.platform() === "win32" ? "C:\\" : "/";
  return resolve(root, embeddedRuntimeDirectoryName, ...String(relativePath).split("/"));
}

export function loadEmbeddedRuntimeModule(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, "/").replace(/^\/+/, "");
  if (embeddedRuntimePreloadedModules.has(normalized)) {
    return embeddedRuntimePreloadedModules.get(normalized);
  }
  return loadCommonJsModule(embeddedRuntimePath(relativePath));
}

export function registerEmbeddedRuntimeModules(modules) {
  if (modules == null || typeof modules !== "object") return;
  for (const [relativePath, namespace] of Object.entries(modules)) {
    embeddedRuntimePreloadedModules.set(
      String(relativePath).replace(/\\/g, "/").replace(/^\/+/, ""),
      namespace,
    );
  }
}

function readModuleFile(path) {
  const embedded = standaloneFileEntry(path);
  const runtimeEmbedded = embedded.found ? embedded : embeddedRuntimeSourceEntry(path);
  if (!runtimeEmbedded.found) {
    assertFsRead(String(path));
    return cottontail.readFile(path);
  }
  if (typeof runtimeEmbedded.value === "string") return runtimeEmbedded.value;
  if (runtimeEmbedded.value instanceof ArrayBuffer) return new TextDecoder().decode(runtimeEmbedded.value);
  if (ArrayBuffer.isView(runtimeEmbedded.value)) {
    return new TextDecoder().decode(
      new Uint8Array(runtimeEmbedded.value.buffer, runtimeEmbedded.value.byteOffset, runtimeEmbedded.value.byteLength),
    );
  }
  return String(runtimeEmbedded.value);
}

function standaloneFileBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new TextEncoder().encode(String(value));
}

function modulePathExists(path) {
  if (standaloneFileEntry(path).found || standaloneDirectoryExists(path) || embeddedRuntimeSourceEntry(path).found) return true;
  try {
    return cottontail.existsSync(String(path));
  } catch {
    return false;
  }
}

function stat(path) {
  if (standaloneFileEntry(path).found) {
    return { isFile: true, isDirectory: false, isSymbolicLink: false };
  }
  if (embeddedRuntimeSourceEntry(path).found) {
    return { isFile: true, isDirectory: false, isSymbolicLink: false };
  }
  if (standaloneDirectoryExists(path)) {
    return { isFile: false, isDirectory: true, isSymbolicLink: false };
  }
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
    return parseJSONC(String(readModuleFile(path)));
  } catch {
    return null;
  }
}

function packageJsonValue(packageJson, key) {
  return packageJson != null && Object.hasOwn(packageJson, key) ? packageJson[key] : undefined;
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

function standaloneAutoloadDisabled(flag) {
  return globalThis.__cottontailStandaloneFlags?.[flag] === true;
}

function loadTsconfigPaths(dir) {
  if (standaloneAutoloadDisabled("disableAutoloadTsconfig")) return null;
  if (tsconfigPathsCache.has(dir)) return tsconfigPathsCache.get(dir);
  let entry = null;
  try {
    const file = join(dir, "tsconfig.json");
    if (isFile(file)) {
      const parsed = parseJSONC(String(readModuleFile(file)));
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

// Resolved tsconfig compilerOptions that steer the module-load transpile
// (decorators + JSX). The standalone transpiler has no project resolver, so the
// bundler-equivalent flags are read here and forwarded through the transform
// options. `extends` chains are followed and results are cached per directory,
// walking toward the filesystem root like TypeScript/Bun.
const tsconfigCompilerOptionsCache = new Map();

function readTsconfigCompilerOptions(file, seen) {
  if (seen.has(file)) return {};
  seen.add(file);
  let parsed;
  try {
    if (!isFile(file)) return {};
    parsed = parseJSONC(String(readModuleFile(file)));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  let base = {};
  const extendsField = parsed.extends;
  const extendsList = typeof extendsField === "string"
    ? [extendsField]
    : Array.isArray(extendsField) ? extendsField : [];
  for (const specifier of extendsList) {
    if (typeof specifier !== "string" || specifier.length === 0) continue;
    // Only relative/absolute extends are resolved here; package extends would
    // require the full resolver the bundler owns.
    if (!specifier.startsWith(".") && !isAbsolute(specifier)) continue;
    let extendsPath = resolve(dirname(file), specifier);
    if (!/\.json$/i.test(extendsPath)) extendsPath += ".json";
    base = { ...base, ...readTsconfigCompilerOptions(extendsPath, seen) };
  }
  const own = parsed.compilerOptions && typeof parsed.compilerOptions === "object"
    ? parsed.compilerOptions
    : {};
  return { ...base, ...own };
}

function loadTsconfigCompilerOptions(dir) {
  if (standaloneAutoloadDisabled("disableAutoloadTsconfig")) return null;
  if (tsconfigCompilerOptionsCache.has(dir)) return tsconfigCompilerOptionsCache.get(dir);
  let entry = null;
  try {
    const file = join(dir, "tsconfig.json");
    if (isFile(file)) entry = readTsconfigCompilerOptions(file, new IntrinsicSet());
  } catch {}
  if (!entry) {
    const parent = dirname(dir);
    entry = parent && parent !== dir ? loadTsconfigCompilerOptions(parent) : null;
  }
  tsconfigCompilerOptionsCache.set(dir, entry);
  return entry;
}

// Map resolved tsconfig compilerOptions to the standalone transpiler's option
// keys. Returns only non-default overrides, or null when the project keeps the
// transpiler defaults (TC39 standard decorators + automatic JSX runtime).
function tsconfigTransformOverrides(filename) {
  const dir = dirname(String(filename));
  const compilerOptions = loadTsconfigCompilerOptions(dir);
  const overrides = {};
  let hasOverride = false;
  if (compilerOptions) {
    if (compilerOptions.experimentalDecorators === true) {
      overrides.experimentalDecorators = true;
      hasOverride = true;
    }
    if (compilerOptions.emitDecoratorMetadata === true) {
      overrides.emitDecoratorMetadata = true;
      hasOverride = true;
    }
    const jsx = typeof compilerOptions.jsx === "string" ? compilerOptions.jsx.toLowerCase() : null;
    if (jsx === "react") {
      overrides.jsxRuntime = "classic";
      hasOverride = true;
    } else if (jsx === "react-jsx") {
      overrides.jsxRuntime = "automatic";
      overrides.jsxDev = false;
      hasOverride = true;
    } else if (jsx === "react-jsxdev") {
      overrides.jsxRuntime = "automatic";
      overrides.jsxDev = true;
      hasOverride = true;
    }
    if (typeof compilerOptions.jsxImportSource === "string" && compilerOptions.jsxImportSource.length > 0) {
      overrides.jsxImportSource = compilerOptions.jsxImportSource;
      hasOverride = true;
    }
    if (typeof compilerOptions.jsxFactory === "string" && compilerOptions.jsxFactory.length > 0) {
      overrides.jsxFactory = compilerOptions.jsxFactory;
      hasOverride = true;
    }
    if (typeof compilerOptions.jsxFragmentFactory === "string" && compilerOptions.jsxFragmentFactory.length > 0) {
      overrides.jsxFragmentFactory = compilerOptions.jsxFragmentFactory;
      hasOverride = true;
    }
  }
  return hasOverride ? overrides : null;
}

// Loader for the standalone transpiler, keyed on the module's extension so JSX
// in `.tsx`/`.jsx` is actually parsed instead of reaching the compiler as raw
// `<` tokens.
function transpilerLoaderForFilename(filename) {
  const ext = String(filename).toLowerCase().match(/\.[^.]+$/)?.[0];
  if (ext === ".tsx") return "tsx";
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "ts";
  if (ext === ".jsx") return "jsx";
  return "js";
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
  if (standaloneDirectoryExists(candidate)) return candidate;
  const preserveSymlinks = (globalThis.process?.execArgv ?? []).includes("--preserve-symlinks") ||
    globalThis.process?.env?.NODE_PRESERVE_SYMLINKS === "1";
  if (preserveSymlinks) return candidate;
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

function packageNameForRequest(request) {
  const parts = request.startsWith("@") ? request.split("/").slice(0, 2) : [request.split("/")[0]];
  return parts.join("/");
}

function packageDirectoryExists(candidate) {
  return isDirectory(candidate) || modulePathExists(join(candidate, "package.json"));
}

function nodePathEntries() {
  const value = currentProcessBuiltin().env?.NODE_PATH;
  const delimiter = path.delimiter || (globalThis.process?.platform === "win32" ? ";" : ":");
  const dynamicEntries = typeof value === "string"
    ? value.split(delimiter).filter(Boolean).map((entry) => resolve(entry))
    : [];
  return [...new IntrinsicSet([...dynamicEntries, ...(Array.isArray(globalPaths) ? globalPaths : [])])];
}

function nodeModulesLookupDir(dir) {
  return basename(dir).toLowerCase() === "node_modules" ? null : join(dir, "node_modules");
}

function packageRootFor(request, startDir) {
  const packageName = packageNameForRequest(request);
  const loadPackageJson = !standaloneAutoloadDisabled("disableAutoloadPackageJson");
  let dir = startDir;
  while (true) {
    const selfManifest = join(dir, "package.json");
    if (loadPackageJson && modulePathExists(selfManifest)) {
      try {
        const packageJson = readPackageJson(selfManifest);
        if (packageJsonValue(packageJson, "name") === packageName && packageJsonValue(packageJson, "exports") != null) {
          return packageDirRealPath(dir);
        }
      } catch {}
    }

    const lookupDir = nodeModulesLookupDir(dir);
    if (lookupDir != null) {
      const nodeModulesCandidate = join(lookupDir, packageName);
      if (packageDirectoryExists(nodeModulesCandidate)) return packageDirRealPath(nodeModulesCandidate);
    }

    // A sibling directory that merely shares the package name is not a
    // package root (e.g. test fixtures at third_party/<name>/package.json);
    // only accept it when its package.json "name" actually matches.
    const directCandidate = join(dir, packageName);
    const directManifest = join(directCandidate, "package.json");
    if (loadPackageJson && modulePathExists(directManifest)) {
      let manifestName;
      try {
        manifestName = packageJsonValue(readPackageJson(directManifest), "name");
      } catch {
        manifestName = undefined;
      }
      if (manifestName === packageName) return packageDirRealPath(directCandidate);
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Bun follows Node's NODE_PATH lookup after ordinary ancestor
  // node_modules traversal. Entries point at node_modules directories, not
  // project roots, and retain their declared order.
  for (const entry of nodePathEntries()) {
    const candidate = join(entry, packageName);
    if (packageDirectoryExists(candidate)) return packageDirRealPath(candidate);
  }
  return null;
}

function bareModuleFileFor(request, startDir) {
  let dir = startDir;
  while (true) {
    const lookupDir = nodeModulesLookupDir(dir);
    if (lookupDir != null) {
      const resolved = resolveAsFile(join(lookupDir, request));
      if (resolved) return resolved;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const entry of nodePathEntries()) {
    const resolved = resolveAsFile(join(entry, request));
    if (resolved) return resolved;
  }
  return null;
}

// Bun rewrites TypeScript-style output extensions back to their source
// spellings when the literal file is missing: "./a.js" finds "./a.ts" or
// "./a.tsx", and "./a.mjs" finds "./a.mts". ".cjs" is deliberately absent —
// Bun does not map it to ".cts". Exports-map targets are excluded (they use
// isFile directly), matching Bun.
const typescriptExtensionRewrites = Object.freeze({
  ".js": [".ts", ".tsx"],
  ".jsx": [".ts", ".tsx"],
  ".mjs": [".mts"],
});

function resolveTypeScriptExtensionRewrite(candidate) {
  const dot = candidate.lastIndexOf(".");
  if (dot <= 0) return null;
  const rewrites = typescriptExtensionRewrites[candidate.slice(dot).toLowerCase()];
  if (!rewrites) return null;
  const stem = candidate.slice(0, dot);
  for (const ext of rewrites) {
    if (isFile(`${stem}${ext}`)) return `${stem}${ext}`;
  }
  return null;
}

function resolveAsFile(candidate) {
  if (isFile(candidate)) return candidate;
  const rewritten = resolveTypeScriptExtensionRewrite(candidate);
  if (rewritten) return rewritten;
  // Extensionless require() follows the live Module._extensions registry.
  // Keep JSX in the fallback list because Bun loads it without exposing a
  // public require.extensions entry.
  const extensions = [...Object.keys(_extensions), ".tsx", ".jsx"];
  for (const ext of new IntrinsicSet(extensions)) {
    if (isFile(`${candidate}${ext}`)) return `${candidate}${ext}`;
  }
  return null;
}

function directoryResolutionCycleKey(candidate) {
  try {
    const real = cottontail.realpathSync(candidate);
    if (typeof real === "string" && real.length > 0) return resolve(real);
  } catch {}
  return resolve(candidate);
}

function resolveAsDirectory(candidate, kind = "require", seenDirectories = undefined) {
  if (!isDirectory(candidate)) return null;
  const visited = seenDirectories ?? new IntrinsicSet();
  const cycleKey = directoryResolutionCycleKey(candidate);
  if (visited.has(cycleKey)) return null;
  visited.add(cycleKey);
  const packagePath = join(candidate, "package.json");
  const packageJson = !standaloneAutoloadDisabled("disableAutoloadPackageJson") && isFile(packagePath)
    ? readPackageJson(packagePath)
    : null;
  if (packageJsonValue(packageJson, "exports") != null) {
    const exported = resolvePackageTargetPath(candidate, resolvePackageExports(candidate, packageJson, "", kind), kind);
    if (exported) return exported;
  }
  const packageMain = packageJsonValue(packageJson, "main");
  const mainField = typeof packageMain === "string" ? packageMain : "";
  if (mainField) {
    const mainCandidate = resolve(candidate, mainField);
    const mainResolved = resolveAsFile(mainCandidate) || resolveAsDirectory(mainCandidate, kind, visited);
    if (mainResolved) return mainResolved;
  }
  const packageModule = packageJsonValue(packageJson, "module");
  const moduleField = typeof packageModule === "string" ? packageModule : "";
  const resolveModuleField = () => {
    if (!moduleField) return null;
    const moduleCandidate = resolve(candidate, moduleField);
    return resolveAsFile(moduleCandidate) || resolveAsDirectory(moduleCandidate, kind, visited);
  };
  // Bun's ESM runtime resolution gives `module` priority over the legacy
  // index candidate (but never over a valid `main`).
  if (kind === "import") {
    const moduleResolved = resolveModuleField();
    if (moduleResolved) return moduleResolved;
  }
  const indexResolved = resolveAsFile(join(candidate, "index"));
  if (indexResolved) {
    if (mainField) {
      currentProcessBuiltin().emitWarning?.(
        `Invalid 'main' field in '${packagePath}' of '${mainField}'. Please either fix that or report it to the module author`,
        "DeprecationWarning",
        "DEP0128",
      );
    }
    return indexResolved;
  }
  // CommonJS keeps legacy index precedence and uses `module` only as its final
  // package entry fallback. ESM already attempted the field above.
  if (kind !== "import") {
    const moduleResolved = resolveModuleField();
    if (moduleResolved) return moduleResolved;
  }
  return null;
}

function requestRequiresDirectory(request) {
  return /[\\/]$/.test(request) || /(?:^|[\\/])\.{1,2}$/.test(request);
}

const packageTargetStatus = Object.freeze({
  undefined: "undefined",
  null: "null",
  exact: "exact",
  inexact: "inexact",
  packageResolve: "package-resolve",
  invalidModuleSpecifier: "invalid-module-specifier",
  invalidPackageConfiguration: "invalid-package-configuration",
  invalidPackageTarget: "invalid-package-target",
  packagePathNotExported: "package-path-not-exported",
  packagePathDisabled: "package-path-disabled",
  packageImportNotDefined: "package-import-not-defined",
  unsupportedDirectoryImport: "unsupported-directory-import",
});

function packageTargetResult(status, path = "", trailingSlash = false) {
  return { status, path, trailingSlash };
}

let cachedCustomResolverConditions;
let cachedCustomResolverConditionsKey;
let cachedCustomResolverArguments;

function customResolverConditions() {
  const args = currentProcessBuiltin().execArgv ?? [];
  if (cachedCustomResolverArguments?.length === args.length) {
    let unchanged = true;
    for (let index = 0; index < args.length; index += 1) {
      if (cachedCustomResolverArguments[index] !== args[index]) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) return cachedCustomResolverConditions;
  }

  const conditions = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    let value;
    if (arg.startsWith("--conditions=")) value = arg.slice("--conditions=".length);
    else if (arg === "--conditions" && index + 1 < args.length) value = String(args[++index]);
    else continue;
    for (const condition of value.split(",")) {
      if (condition) conditions.push(condition);
    }
  }
  cachedCustomResolverArguments = Array.from(args);
  cachedCustomResolverConditions = conditions;
  cachedCustomResolverConditionsKey = conditions.join("\0");
  return cachedCustomResolverConditions;
}

function customResolverConditionsKey() {
  if (cachedCustomResolverConditionsKey === undefined) customResolverConditions();
  return cachedCustomResolverConditionsKey;
}

function resolverConditions(kind) {
  if (activeResolverConditions !== null) return activeResolverConditions;
  return new IntrinsicSet(["bun", "node", kind === "import" ? "import" : "require", ...customResolverConditions(), "default"]);
}

function conditionsFromHookContext(context, kind) {
  if (context?.conditions === undefined) {
    return new IntrinsicSet(["bun", "node", kind === "import" ? "import" : "require", ...customResolverConditions(), "default"]);
  }
  if (!Array.isArray(context.conditions) || context.conditions.some((condition) => typeof condition !== "string")) {
    const error = new TypeError(`The property 'conditions' is invalid. Received ${formatInvalidValue(context.conditions)}`);
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }
  return new IntrinsicSet([...context.conditions, "default"]);
}

// Bun resolves package targets against a logical "/" URL first. Keeping the
// package root out of this stage avoids decoding percent bytes in real paths.
function packageMapShape(map) {
  let keysStartWithDot;
  for (const key of Object.keys(map)) {
    const startsWithDot = key.startsWith(".");
    if (keysStartWithDot === undefined) keysStartWithDot = startsWithDot;
    else if (keysStartWithDot !== startsWithDot) return "invalid";
  }
  return keysStartWithDot ? "subpaths" : "conditions";
}

function findInvalidPackageSegment(value) {
  const firstSeparator = String(value).search(/[\\/]/);
  if (firstSeparator < 0) return "";
  for (const segment of String(value).slice(firstSeparator + 1).split(/[\\/]/)) {
    if (segment === "." || segment === ".." || segment.toLowerCase() === "node_modules") return segment;
  }
  return null;
}

function packageMapKeyCompare(left, right) {
  const leftStar = left.indexOf("*");
  const rightStar = right.indexOf("*");
  const leftBaseLength = leftStar < 0 ? left.length : leftStar;
  const rightBaseLength = rightStar < 0 ? right.length : rightStar;
  if (leftBaseLength !== rightBaseLength) return rightBaseLength - leftBaseLength;
  if (leftStar < 0 && rightStar >= 0) return 1;
  if (rightStar < 0 && leftStar >= 0) return -1;
  return right.length - left.length;
}

function packageMapExpansionKeys(map) {
  return Object.keys(map)
    .filter((key) => key.endsWith("/") || key.includes("*"))
    .sort(packageMapKeyCompare);
}

function resolvePackageTarget(target, subpath, conditions, internal, pattern) {
  if (typeof target === "string") {
    if (!pattern && subpath && !target.endsWith("/")) {
      return packageTargetResult(packageTargetStatus.invalidModuleSpecifier, target);
    }

    if (!target.startsWith("./")) {
      if (internal && !target.startsWith("../") && !target.startsWith("/")) {
        const packagePath = pattern
          ? target.replace(/\*/g, subpath)
          : path.posix.join(target, subpath);
        return packageTargetResult(packageTargetStatus.packageResolve, packagePath);
      }
      return packageTargetResult(packageTargetStatus.invalidPackageTarget, target);
    }

    if (findInvalidPackageSegment(target) != null) {
      return packageTargetResult(packageTargetStatus.invalidPackageTarget, target);
    }

    const resolvedTarget = path.posix.join("/", target);
    if (findInvalidPackageSegment(resolvedTarget) != null) {
      return packageTargetResult(packageTargetStatus.invalidModuleSpecifier, target);
    }

    if (pattern) {
      const path = resolvedTarget.replace(/\*/g, subpath);
      return packageTargetResult(packageTargetStatus.exact, path, /[\\/]$/.test(path));
    }

    const resolvedPath = path.posix.join(resolvedTarget, subpath);
    const trailingSlash = /[\\/]$/.test(subpath || target);
    return packageTargetResult(packageTargetStatus.exact, resolvedPath, trailingSlash);
  }

  if (target === null) return packageTargetResult(packageTargetStatus.null);

  if (Array.isArray(target)) {
    if (target.length === 0) return packageTargetResult(packageTargetStatus.null);
    let lastResult = packageTargetResult(packageTargetStatus.undefined);
    for (const value of target) {
      const result = resolvePackageTarget(value, subpath, conditions, internal, pattern);
      if (result.status !== packageTargetStatus.undefined) return result;
      lastResult = result;
    }
    return lastResult;
  }

  if (target && typeof target === "object") {
    if (packageMapShape(target) === "invalid") {
      return packageTargetResult(packageTargetStatus.invalidPackageTarget);
    }
    for (const [condition, value] of Object.entries(target)) {
      if (!conditions.has(condition)) continue;
      const result = resolvePackageTarget(value, subpath, conditions, internal, pattern);
      if (result.status !== packageTargetStatus.undefined) return result;
    }
    return packageTargetResult(packageTargetStatus.undefined);
  }

  return packageTargetResult(packageTargetStatus.invalidPackageTarget);
}

function resolvePackageImportsExports(matchKey, matchMap, conditions, internal) {
  if (!matchKey.endsWith("/") && !matchKey.includes("*") && Object.hasOwn(matchMap, matchKey)) {
    return resolvePackageTarget(matchMap[matchKey], "", conditions, internal, false);
  }

  for (const expansionKey of packageMapExpansionKeys(matchMap)) {
    const star = expansionKey.indexOf("*");
    if (star >= 0) {
      const patternBase = expansionKey.slice(0, star);
      const patternTrailer = expansionKey.slice(star + 1);
      if (!matchKey.startsWith(patternBase)) continue;
      if (patternTrailer && (!matchKey.endsWith(patternTrailer) || matchKey.length < expansionKey.length)) continue;
      const subpath = matchKey.slice(patternBase.length, matchKey.length - patternTrailer.length);
      return resolvePackageTarget(matchMap[expansionKey], subpath, conditions, internal, true);
    }

    if (matchKey.startsWith(expansionKey)) {
      const subpath = matchKey.slice(expansionKey.length);
      const result = resolvePackageTarget(matchMap[expansionKey], subpath, conditions, internal, false);
      if (result.status === packageTargetStatus.exact) result.status = packageTargetStatus.inexact;
      return result;
    }
  }

  return packageTargetResult(packageTargetStatus.null);
}

function finalizePackageTarget(result) {
  if (result.status !== packageTargetStatus.exact && result.status !== packageTargetStatus.inexact) return result;
  let path;
  try {
    path = decodeURIComponent(result.path);
  } catch {
    return packageTargetResult(packageTargetStatus.invalidModuleSpecifier, result.path);
  }
  if (result.trailingSlash || /[\\/]$/.test(path)) {
    return packageTargetResult(packageTargetStatus.unsupportedDirectoryImport, path);
  }
  return packageTargetResult(result.status, path);
}

function resolvePackageTargetPath(root, resolution, kind = "require") {
  if (resolution.status !== packageTargetStatus.exact && resolution.status !== packageTargetStatus.inexact) return null;
  const candidate = resolve(root, resolution.path.replace(/^[\\/]+/, ""));
  if (resolution.status === packageTargetStatus.exact) return isFile(candidate) ? candidate : null;
  return resolveAsFile(candidate) || resolveAsDirectory(candidate, kind);
}

function resolvePackageExports(root, packageJson, suffix = "", kind = "require") {
  void root;
  const exportsField = packageJsonValue(packageJson, "exports");
  const subpath = suffix ? `./${suffix}` : ".";
  const conditions = resolverConditions(kind);

  if (exportsField !== null && typeof exportsField !== "string" && !Array.isArray(exportsField) &&
      (typeof exportsField !== "object" || exportsField === null)) {
    return packageTargetResult(packageTargetStatus.invalidPackageConfiguration);
  }

  let shape = "conditions";
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    shape = packageMapShape(exportsField);
    if (shape === "invalid") return packageTargetResult(packageTargetStatus.invalidPackageConfiguration);
  }

  if (subpath === ".") {
    let mainExport;
    if (typeof exportsField === "string" || Array.isArray(exportsField) || shape === "conditions") {
      mainExport = exportsField;
    } else if (Object.hasOwn(exportsField, ".")) {
      mainExport = exportsField["."];
    }
    if (mainExport !== undefined && mainExport !== null) {
      const result = resolvePackageTarget(mainExport, "", conditions, false, false);
      if (result.status !== packageTargetStatus.null && result.status !== packageTargetStatus.undefined) {
        return finalizePackageTarget(result);
      }
    }
  } else if (shape === "subpaths") {
    const result = resolvePackageImportsExports(subpath, exportsField, conditions, false);
    if (result.status !== packageTargetStatus.null && result.status !== packageTargetStatus.undefined) {
      return finalizePackageTarget(result);
    }
    if (result.status === packageTargetStatus.null) {
      return packageTargetResult(packageTargetStatus.packagePathDisabled);
    }
  }

  return packageTargetResult(packageTargetStatus.packagePathNotExported);
}

function isPromiseLike(value) {
  return value != null && typeof value.then === "function";
}

function invalidArgType(name, expected, value) {
  const error = new TypeError(`The "${name}" property must be of type ${expected}. Received type ${typeof value}`);
  error.name = "TypeError [ERR_INVALID_ARG_TYPE]";
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function formatInvalidValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "object") {
    const constructorName = value?.constructor?.name;
    return `an instance of ${constructorName || "Object"}`;
  }
  return `type ${typeof value} (${String(value)})`;
}

function invalidRequestType(value) {
  const error = new TypeError(`The "request" argument must be of type string. Received ${formatInvalidValue(value)}`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function invalidModuleIdType(value) {
  const error = new TypeError(`The "id" argument must be of type string. Received ${formatInvalidValue(value)}`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function invalidEmptyModuleId() {
  const error = new TypeError("The argument 'id' must be a non-empty string. Received ''");
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

function maybeWarnModuleParent() {
  if (moduleParentWarningEmitted) return;
  const process = currentProcessBuiltin();
  const pending = (process.execArgv ?? []).includes("--pending-deprecation") ||
    process.env?.NODE_PENDING_DEPRECATION === "1";
  if (!pending) return;
  moduleParentWarningEmitted = true;
  process.emitWarning?.(
    "module.parent is deprecated due to accuracy issues. Please use require.main to find program entry point instead.",
    "DeprecationWarning",
    "DEP0144",
  );
}

function invalidResolvePaths(value) {
  let received = formatInvalidValue(value);
  if (value != null && typeof value === "object") {
    try { received = JSON.stringify(value); } catch {}
  }
  const error = new TypeError(`The property 'options.paths' is invalid. Received ${received}`);
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

function invalidResolvePathEntries() {
  const error = new TypeError('The "paths" argument must be array of strings. Received an instance of Array');
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function resolvedToUrl(resolved) {
  const { bare: text, suffix } = splitSpecifierSuffix(resolved);
  if (text.startsWith("node:")) return text;
  if (builtinModuleMap.has(text)) return `node:${text.replace(/^node:/, "")}`;
  if (hasRuntimePackageReplacement(text)) return text;
  if (isAbsolute(text)) return pathToFileURL(text).href + suffix;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return text;
  return pathToFileURL(text).href + suffix;
}

function sourceURLForResolved(resolved) {
  const { bare: text, suffix } = splitSpecifierSuffix(resolved);
  if (text.startsWith("file:")) return text + suffix;
  if (isAbsolute(text)) return pathToFileURL(text).href + suffix;
  return String(resolved);
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
  if (text.endsWith(".mjs") || text.endsWith(".mts")) return "module";
  if (text.endsWith(".cjs") || text.endsWith(".cts")) return "commonjs";
  if ((text.endsWith(".js") || text.endsWith(".ts")) && isAbsolute(text)) {
    const scope = nearestPackageScope(text);
    if (packageJsonValue(scope?.packageJson, "type") === "module") return "module";
  }
  return "commonjs";
}

function packageTypeIsModule(resolved) {
  const { bare } = splitSpecifierSuffix(resolved);
  if (!isAbsolute(bare)) return false;
  const scope = nearestPackageScope(bare);
  return packageJsonValue(scope?.packageJson, "type") === "module";
}

function parentURLForBase(basePath) {
  const text = String(basePath || cottontail.cwd());
  if (isAbsolute(text)) return pathToFileURL(text).href;
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
  if (index < lastSeparator && isAbsolute(text)) {
    try {
      if (modulePathExists(text)) return { bare: text, suffix: "" };
    } catch {}
  }
  return { bare: text.slice(0, index), suffix: text.slice(index) };
}

function withSpecifierSuffix(path, suffix) {
  return suffix ? `${path}${suffix}` : path;
}

function moduleNotFoundError(request, resolveMessage = false, basePath = undefined) {
  void resolveMessage;
  // Bun surfaces module resolution failures as ResolveMessage instances and
  // words them as "Cannot find package '<bare specifier>'" vs
  // "Cannot find module '<relative/absolute path>'".
  const isPathSpecifier =
    request.startsWith(".") || request.startsWith("/") || request.startsWith("file:");
  let message = `Cannot find ${isPathSpecifier ? "module" : "package"} '${request}'`;
  if (basePath != null) {
    let referrer = String(basePath);
    if (referrer.startsWith("file:")) {
      try { referrer = fileURLToPath(referrer); } catch {}
    }
    message += ` from '${referrer}'`;
  }
  const error = new ResolveMessage(message);
  error.name = "ResolveMessage";
  error.code = "MODULE_NOT_FOUND";
  return error;
}

class ResolveMessage extends Error {}
class BuildMessage extends SyntaxError {}

function makeResolveMessage(message, code = "ERR_MODULE_NOT_FOUND", referrer = undefined) {
  const Constructor = typeof globalThis.ResolveMessage === "function" ? globalThis.ResolveMessage : ResolveMessage;
  let error;
  try {
    error = new Constructor({ message, code, referrer });
    if (String(error?.message ?? "") !== message) throw new Error();
  } catch {
    error = new Constructor(message);
  }
  error.name = "ResolveMessage";
  error.code = code;
  if (referrer !== undefined) error.referrer = referrer;
  return error;
}

function dynamicResolveMessage(message) {
  const error = makeResolveMessage(message);
  error.line = 0;
  error.column = 0;
  error.position = null;
  return error;
}

function packageNotFoundError(request, basePath, resolveMessage = false) {
  if (!resolveMessage) return moduleNotFoundError(request, false, basePath);
  let referrer = String(basePath || cottontail.cwd());
  if (referrer.startsWith("file:")) {
    try { referrer = fileURLToPath(referrer); } catch {}
  }
  return makeResolveMessage(`Cannot find package '${request}' from '${referrer}'`, "MODULE_NOT_FOUND", referrer);
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
    main: mainModule?.filename === filename,
  };
  meta.require = createRequire(filename);
  meta.resolveSync = (specifier, parent = filename) => resolveRequest(specifier, parent, true, "import");
  meta.resolve = (specifier, parent = filename) => {
    const resolved = meta.resolveSync(specifier, parent);
    return resolvedToUrl(resolved);
  };
  Object.defineProperty(meta, "env", {
    configurable: true,
    enumerable: true,
    get: () => globalThis.process?.env,
  });
  return meta;
}

function resolutionStartDir(basePath) {
  let text = String(basePath || cottontail.cwd());
  if (text.startsWith("file:")) text = fileURLToPath(text);
  return text.endsWith("/") || text.endsWith("\\") ? resolve(text) : dirname(text);
}

function nearestPackageScope(basePath) {
  if (standaloneAutoloadDisabled("disableAutoloadPackageJson")) return null;
  let dir = resolutionStartDir(basePath);
  while (true) {
    const packageJsonPath = join(dir, "package.json");
    if (modulePathExists(packageJsonPath)) {
      return { dir, packageJsonPath, packageJson: readPackageJson(packageJsonPath) };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function packageImportNotDefinedError(specifier, basePath) {
  let referrer = String(basePath || cottontail.cwd());
  if (referrer.startsWith("file:")) {
    try { referrer = fileURLToPath(referrer); } catch {}
  }
  return makeResolveMessage(
    `Package import specifier '${specifier}' is not defined from '${referrer}'`,
    "ERR_PACKAGE_IMPORT_NOT_DEFINED",
    referrer,
  );
}

function resolvePackageImports(specifier, basePath, kind, seen = new IntrinsicSet()) {
  if (specifier === "#" || specifier.startsWith("#/")) throw packageImportNotDefinedError(specifier, basePath);
  const scope = nearestPackageScope(basePath);
  const imports = packageJsonValue(scope?.packageJson, "imports");
  if (!imports || typeof imports !== "object" || Array.isArray(imports)) {
    throw packageImportNotDefinedError(specifier, basePath);
  }

  const cycleKey = `${scope.packageJsonPath}\0${specifier}\0${kind}`;
  if (seen.has(cycleKey)) throw packageImportNotDefinedError(specifier, basePath);
  seen.add(cycleKey);

  let resolution = packageMapShape(imports) === "invalid"
    ? packageTargetResult(packageTargetStatus.invalidPackageConfiguration)
    : resolvePackageImportsExports(specifier, imports, resolverConditions(kind), true);
  if (resolution.status === packageTargetStatus.null || resolution.status === packageTargetStatus.undefined) {
    resolution = packageTargetResult(packageTargetStatus.packageImportNotDefined);
  } else {
    resolution = finalizePackageTarget(resolution);
  }

  if (resolution.status === packageTargetStatus.packageResolve) {
    return resolveRequestCore(resolution.path, scope.packageJsonPath, kind, seen);
  }
  const resolved = resolvePackageTargetPath(scope.dir, resolution, kind);
  if (resolved) return resolved;
  if (resolution.status === packageTargetStatus.exact || resolution.status === packageTargetStatus.inexact) {
    throw moduleNotFoundError(specifier, kind === "import", basePath);
  }
  throw packageImportNotDefinedError(specifier, basePath);
}

function invalidHookReturnProperty(property, hook, value) {
  const error = new TypeError(
    `Expected a valid value to be returned for the "${property}" from the "${hook}" hook but got ${formatInvalidValue(value)}.`,
  );
  error.code = "ERR_INVALID_RETURN_PROPERTY_VALUE";
  return error;
}

function normalizeResolveHookResult(result, calledNext) {
  if (isPromiseLike(result)) throw new TypeError("module.registerHooks resolve hooks must return synchronously");
  if (result == null || typeof result !== "object" || typeof result.url !== "string") {
    throw invalidHookReturnProperty("url", "resolve", result?.url);
  }
  if (!calledNext && result.shortCircuit !== true) throw invalidHookReturnProperty("shortCircuit", "resolve", result.shortCircuit);
  return result;
}

function normalizeLoadHookResult(result, calledNext) {
  if (isPromiseLike(result)) throw new TypeError("module.registerHooks load hooks must return synchronously");
  if (result == null || typeof result !== "object") {
    throw invalidHookReturnProperty("source", "load", undefined);
  }
  if (!calledNext && result.shortCircuit !== true) throw invalidHookReturnProperty("shortCircuit", "load", result.shortCircuit);
  const source = result.source;
  const validSource = typeof source === "string" || source instanceof ArrayBuffer || ArrayBuffer.isView(source) ||
    (source === null && result.format === "builtin");
  if (!validSource) throw invalidHookReturnProperty("source", "load", source);
  if (result.format !== undefined && typeof result.format !== "string") {
    throw invalidHookReturnProperty("format", "load", result.format);
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
function isBunCompatProfile() {
  try {
    return globalThis.process?.env?.COTTONTAIL_UPSTREAM_RUNTIME === "bun";
  } catch {
    return false;
  }
}

function isBuiltinHiddenByCompatProfile(id) {
  if (String(id).replace(/^node:/, "") !== "sqlite") return false;
  return isBunCompatProfile();
}

function resolveRequestCore(request, basePath, kind = "require", packageImportSeen = undefined) {
  const originalText = String(request);
  if (originalText.includes("\0")) throw moduleNotFoundError(originalText, true, basePath);
  // Virtual modules registered through Bun.plugin's `build.module(id, ...)` are
  // addressed by their bare id and have no on-disk path; resolve them to that id
  // so the loader (loadCommonJsModule / the import path) dispatches to the
  // registered factory instead of failing package resolution.
  if (runtimePluginVirtualModules.has(originalText) || runtimePluginResolvedModules.has(originalText)) {
    return originalText;
  }
  if (originalText.startsWith("#")) {
    return resolvePackageImports(originalText, basePath, kind, packageImportSeen ?? new IntrinsicSet());
  }
  if (originalText.startsWith("file:")) {
    const { bare: fileUrl, suffix } = splitSpecifierSuffix(originalText);
    let candidate;
    try {
      candidate = fileURLToPath(fileUrl);
    } catch {
      throw moduleNotFoundError(originalText, true);
    }
    const resolved = resolveAsFile(candidate) || resolveAsDirectory(candidate, kind);
    if (resolved) return withSpecifierSuffix(resolved, suffix);
    throw moduleNotFoundError(originalText, Boolean(suffix), basePath);
  }
  const suffixIndex = specifierSuffixIndex(originalText);
  const lastSeparator = Math.max(originalText.lastIndexOf("/"), originalText.lastIndexOf("\\"));
  if (suffixIndex >= 0 && suffixIndex < lastSeparator && (
    originalText.startsWith(".") ||
    isAbsolute(originalText)
  )) {
    const exactStartDir = resolutionStartDir(basePath);
    const exactCandidate = isAbsolute(originalText)
      ? resolve(originalText)
      : resolve(exactStartDir, originalText);
    const exact = resolveAsFile(exactCandidate) || resolveAsDirectory(exactCandidate, kind);
    if (exact) return exact;
  }
  const { bare: text, suffix } = splitSpecifierSuffix(originalText);
  if (text.startsWith("node:")) {
    const builtinName = text.slice(5);
    if (builtinName.startsWith("internal/") || !isBuiltin(text)) {
      throw unknownBuiltinError(text);
    }
    if (isBuiltinHiddenByCompatProfile(text)) throw unknownBuiltinError(text);
    return text;
  }
  if (text.startsWith("bun:")) {
    if (builtinModuleMap.has(text)) {
      if (isBuiltinHiddenByCompatProfile(text)) throw unknownBuiltinError(text);
      return text;
    }
    // Ensure lazy bun: modules are registered before resolution fails.
    // bun/index.js registers most bun: modules, but it may not have loaded yet.
    if (typeof globalThis.Bun !== "undefined" || text === "bun:wrap") {
      // Known bun: modules that should be resolvable via require().
      const knownBunModules = [
        "bun:test", "bun:jsc", "bun:ffi", "bun:sqlite", "bun:yaml",
        "bun:dns", "bun:json5", "bun:toml", "bun:s3", "bun:redis",
        "bun:sql", "bun:color", "bun:socket", "bun:internal-for-testing",
        "bun:wrap",
      ];
      if (knownBunModules.includes(text)) {
        return text;
      }
    }
    throw unknownBuiltinError(text);
  }
  if (builtinModuleMap.has(text)) {
    if (isBuiltinHiddenByCompatProfile(text)) throw unknownBuiltinError(text);
    return text;
  }
  if (hasRuntimePackageReplacement(text)) return text;

  const startDir = resolutionStartDir(basePath);
  if (text.startsWith(".") || isAbsolute(text)) {
    const candidate = isAbsolute(text) ? resolve(text) : resolve(startDir, text);
    const resolved = requestRequiresDirectory(text)
      ? resolveAsDirectory(candidate, kind)
      : resolveAsFile(candidate) || resolveAsDirectory(candidate, kind);
    if (resolved) return withSpecifierSuffix(resolved, suffix);
    throw moduleNotFoundError(originalText, Boolean(suffix), basePath);
  }

  const tsMapped = resolveTsconfigPathsMapping(text, startDir);
  if (tsMapped) return withSpecifierSuffix(tsMapped, suffix);

  let root = packageRootFor(text, startDir);
  const runtimeStartDir = isStandaloneVirtualPath(startDir) ? cottontail.cwd() : null;
  if (!root && runtimeStartDir != null) root = packageRootFor(text, runtimeStartDir);
  if (!root) {
    const directFile = bareModuleFileFor(text, startDir) ??
      (runtimeStartDir == null ? null : bareModuleFileFor(text, runtimeStartDir));
    if (directFile) return withSpecifierSuffix(directFile, suffix);
    throw packageNotFoundError(originalText, basePath, kind === "import");
  }
  const packageSuffix = text.startsWith("@") ? text.split("/").slice(2).join("/") : text.split("/").slice(1).join("/");
  const packageJsonPath = join(root, "package.json");
  const packageJson = !standaloneAutoloadDisabled("disableAutoloadPackageJson") && modulePathExists(packageJsonPath)
    ? readPackageJson(packageJsonPath)
    : null;
  if (packageJsonValue(packageJson, "exports") != null) {
    let exported = resolvePackageTargetPath(root, resolvePackageExports(root, packageJson, packageSuffix, kind), kind);
    // Bun permits package.json reads and TypeScript-style redundant .js
    // suffixes even when the exports map omits those spellings.
    if (!exported && packageSuffix === "package.json" && isFile(packageJsonPath)) exported = packageJsonPath;
    if (!exported && packageSuffix.endsWith(".js")) {
      exported = resolvePackageTargetPath(
        root,
        resolvePackageExports(root, packageJson, packageSuffix.slice(0, -3), kind),
        kind,
      );
    }
    if (exported) return withSpecifierSuffix(exported, suffix);
    const error = new Error(`Package subpath '${packageSuffix ? `./${packageSuffix}` : "."}' is not defined by "exports" in ${join(root, "package.json")}`);
    error.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
    throw error;
  }
  if (packageSuffix) {
    const candidate = join(root, packageSuffix);
    const resolved = resolveAsFile(candidate) || resolveAsDirectory(candidate, kind);
    if (resolved) return withSpecifierSuffix(resolved, suffix);
  }
  const resolved = resolveAsDirectory(root, kind);
  if (resolved) return withSpecifierSuffix(resolved, suffix);
  throw moduleNotFoundError(originalText, Boolean(suffix), basePath);
}

function resolveRequest(request, basePath, useHooks = true, kind = "require") {
  if (bunModuleMockFor(request).found) {
    const text = String(request).replace(/^file:(?=\.\/)/, "");
    if (text.startsWith(".") || isAbsolute(text)) {
      const startDir = resolutionStartDir(basePath);
      const absoluteStartDir = isAbsolute(startDir) ? startDir : resolve(cottontail.cwd(), startDir);
      return isAbsolute(text) ? text : resolve(absoluteStartDir, text);
    }
    return text;
  }
  if (!useHooks || !moduleHooks.some((hook) => typeof hook.resolve === "function")) {
    const requestText = String(request);
    const baseText = String(basePath || cottontail.cwd());
    const conditionKey = customResolverConditionsKey();
    const importKind = kind === "import";
    const nativeCached = nativeModuleResolveCacheGet(requestText, baseText, importKind, conditionKey);
    if (nativeCached !== undefined) return nativeCached;

    const startDir = resolutionStartDir(baseText);
    const cacheKey = `${kind}\0${conditionKey}\0${requestText}\0${startDir}`;
    if (Object.prototype.hasOwnProperty.call(modulePathCache, cacheKey)) {
      return nativeModuleResolveCachePut(requestText, baseText, importKind, conditionKey, modulePathCache[cacheKey]);
    }
    const resolved = resolveRequestCore(requestText, baseText, kind);
    modulePathCache[cacheKey] = resolved;
    return nativeModuleResolveCachePut(requestText, baseText, importKind, conditionKey, resolved);
  }

  const baseContext = {
    conditions: [...resolverConditions(kind)],
    importAttributes: {},
    parentURL: parentURLForBase(basePath),
  };
  const dispatchResolve = (index, specifier, context) => {
    while (index >= 0) {
      const hook = moduleHooks[index];
      if (typeof hook.resolve === "function") {
        let calledNext = false;
        const nextResolve = (nextSpecifier = specifier, nextContext = undefined) => {
          calledNext = true;
          const mergedContext = nextContext === undefined
            ? context
            : { ...context, ...(nextContext ?? {}) };
          return dispatchResolve(index - 1, String(nextSpecifier), mergedContext);
        };
        const result = hook.resolve(String(specifier), context, nextResolve);
        return normalizeResolveHookResult(result, calledNext);
      }
      index -= 1;
    }

    const parent = context?.parentURL ? fileURLToPath(context.parentURL) : basePath;
    const previousConditions = activeResolverConditions;
    activeResolverConditions = conditionsFromHookContext(context, kind);
    try {
      const resolved = resolveRequestCore(specifier, parent, kind);
      return { url: resolvedToUrl(resolved), format: formatForResolved(resolved), shortCircuit: true };
    } finally {
      activeResolverConditions = previousConditions;
    }
  };

  const result = dispatchResolve(moduleHooks.length - 1, request, baseContext);
  const resolved = urlToResolved(result.url);
  hookResolvedFormats.set(resolved, typeof result.format === "string" ? result.format : undefined);
  return resolved;
}

function makeModule(filename, parent = null, isMain = false) {
  const module = new Module(filename, parent);
  if (isMain) module.id = ".";
  module.filename = filename;
  if (isMain) refreshModuleRequire(module);
  return module;
}

function invokeModuleRequire(module, request) {
  return Module.prototype.require.call(module, request);
}

function refreshModuleRequire(module) {
  const require = invokeModuleRequire.bind(undefined, module);
  nativeObjectDefineProperty(require, "name", { value: "require", configurable: true });
  const moduleBase = module.filename || (isAbsolute(module.id) ? module.id : cottontail.cwd());
  configureRequireProperties(require, moduleBase, () => module, true);
  // Node reaches module.require through Module.prototype, so it is never an
  // enumerable own property. Keeping it hidden matters for inspection: an
  // enumerable require drags require.cache — the whole module graph — into
  // every Bun.inspect() of a Module.
  nativeObjectDefineProperty(module, "require", {
    value: require,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return require;
}

// Detects top-level ESM declarations (static import / export statements) and
// import.meta expressions. Bun parses import.meta as module syntax even when
// it is the only module-specific construct in a .js file.
// Files reaching the CommonJS executor with ESM syntax must be transformed
// first: `import x from "y"` inside new Function() is a parse error.
const esmSyntaxPattern = /(?:\bimport\b\s*(?:\.\s*meta\b|[\w$*{]|["'])|\bexport\b\s*(?:default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*))/m;

function codePositionMask(source) {
  const text = String(source);
  const mask = new Uint8Array(text.length);
  mask.fill(1);
  const clear = (start, end) => mask.fill(0, start, Math.min(end, text.length));

  const scanQuoted = (start, quote) => {
    let cursor = start + 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") cursor += 2;
      else if (text[cursor++] === quote) break;
    }
    clear(start, cursor);
    return cursor;
  };

  const scanLineComment = (start) => {
    const end = text.indexOf("\n", start + 2);
    const cursor = end < 0 ? text.length : end;
    clear(start, cursor);
    return cursor;
  };

  const scanBlockComment = (start) => {
    const end = text.indexOf("*/", start + 2);
    const cursor = end < 0 ? text.length : end + 2;
    clear(start, cursor);
    return cursor;
  };

  const isRegexStart = (start) => {
    let cursor = start - 1;
    while (cursor >= 0 && /\s/.test(text[cursor])) cursor -= 1;
    if (cursor < 0 || /[({[=,:;!&|?+\-*%^~<>]/.test(text[cursor])) return true;
    if (!/[A-Za-z_$]/.test(text[cursor])) return false;
    const end = cursor + 1;
    while (cursor >= 0 && /[\w$]/.test(text[cursor])) cursor -= 1;
    return /^(?:await|case|delete|do|else|in|instanceof|of|return|throw|typeof|void|yield)$/.test(
      text.slice(cursor + 1, end),
    );
  };

  const scanRegex = (start) => {
    let cursor = start + 1;
    let inCharacterClass = false;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === "\\") {
        cursor += 2;
        continue;
      }
      if (char === "[") inCharacterClass = true;
      else if (char === "]") inCharacterClass = false;
      else if (char === "/" && !inCharacterClass) {
        cursor += 1;
        while (cursor < text.length && /[A-Za-z]/.test(text[cursor])) cursor += 1;
        break;
      } else if (char === "\n" || char === "\r") {
        break;
      }
      cursor += 1;
    }
    clear(start, cursor);
    return cursor;
  };

  let scanCode;
  const scanTemplate = (start) => {
    let rawStart = start;
    let cursor = start + 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (text[cursor] === "`") {
        clear(rawStart, cursor + 1);
        return cursor + 1;
      }
      if (text[cursor] === "$" && text[cursor + 1] === "{") {
        clear(rawStart, cursor + 2);
        const expressionEnd = scanCode(cursor + 2, true);
        if (expressionEnd >= text.length) return text.length;
        mask[expressionEnd] = 0;
        rawStart = expressionEnd;
        cursor = expressionEnd + 1;
        continue;
      }
      cursor += 1;
    }
    clear(rawStart, text.length);
    return text.length;
  };

  scanCode = (start, stopAtTemplateEnd = false) => {
    let braces = 0;
    let cursor = start;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === "\"" || char === "'") {
        cursor = scanQuoted(cursor, char);
        continue;
      }
      if (char === "`") {
        cursor = scanTemplate(cursor);
        continue;
      }
      if (char === "/" && text[cursor + 1] === "/") {
        cursor = scanLineComment(cursor);
        continue;
      }
      if (char === "/" && text[cursor + 1] === "*") {
        cursor = scanBlockComment(cursor);
        continue;
      }
      if (char === "/" && isRegexStart(cursor)) {
        cursor = scanRegex(cursor);
        continue;
      }
      if (stopAtTemplateEnd) {
        if (char === "{") braces += 1;
        else if (char === "}") {
          if (braces === 0) return cursor;
          braces -= 1;
        }
      }
      cursor += 1;
    }
    return cursor;
  };

  scanCode(0);
  return mask;
}

function replaceCodePattern(source, pattern, replacer) {
  const text = String(source);
  const mask = codePositionMask(text);
  return text.replace(pattern, (...args) => {
    const offset = args[args.length - 2];
    if (mask[offset] !== 1) return args[0];
    return typeof replacer === "function" ? replacer(...args) : replacer;
  });
}

function replaceDynamicImportExpressions(source) {
  const text = String(source);
  const mask = codePositionMask(text);
  return text.replace(/\bimport\s*\(/g, (match, offset) => {
    const previous = text[offset - 1];
    if (mask[offset] !== 1 || (previous && /[\w$#.]/.test(previous))) return match;

    const open = offset + match.lastIndexOf("(");
    let depth = 1;
    let close = open + 1;
    while (close < text.length && depth > 0) {
      if (mask[close] === 1) {
        if (text[close] === "(") depth += 1;
        else if (text[close] === ")") depth -= 1;
      }
      close += 1;
    }
    if (depth !== 0) return match;
    close -= 1;

    let after = close + 1;
    while (after < text.length) {
      if (/\s/.test(text[after])) {
        after += 1;
        continue;
      }
      if (text.startsWith("//", after)) {
        const newline = text.indexOf("\n", after + 2);
        after = newline < 0 ? text.length : newline + 1;
        continue;
      }
      if (text.startsWith("/*", after)) {
        const commentEnd = text.indexOf("*/", after + 2);
        after = commentEnd < 0 ? text.length : commentEnd + 2;
        continue;
      }
      break;
    }
    if (text[after] === "{") return '["import"](';
    // Wait-cycle ancestry is meaningful only when this import's promise is a
    // direct await operand. Plain dynamic imports are reachability edges, not
    // wait edges; treating them alike creates false cycles between siblings.
    let before = offset - 1;
    const skipTriviaBackwards = () => {
      while (before >= 0 && (mask[before] !== 1 || /\s/.test(text[before]))) before -= 1;
    };
    skipTriviaBackwards();
    // Also recognize `await (import(...))` and redundant nested parentheses.
    while (text[before] === "(") {
      before -= 1;
      skipTriviaBackwards();
    }
    const wordEnd = before + 1;
    while (before >= 0 && /[\w$\u0080-\uffff]/.test(text[before])) before -= 1;
    const word = text.slice(before + 1, wordEnd);
    skipTriviaBackwards();
    const directlyAwaited = word === "await" &&
      (before < 0 || !/[\w$#.\u0080-\uffff]/.test(text[before]));
    return directlyAwaited ? "__ctAwaitedDynamicImport(" : "__ctDynamicImport(";
  });
}

function codeOnlyText(source) {
  const text = String(source);
  const mask = codePositionMask(text);
  const characters = text.split("");
  for (let index = 0; index < characters.length; index += 1) {
    if (mask[index] !== 1 && characters[index] !== "\n" && characters[index] !== "\r") {
      characters[index] = " ";
    }
  }
  return characters.join("");
}

function hasEsmSyntax(source) {
  const text = String(source);
  if (!esmSyntaxPattern.test(text)) return false;
  const mask = codePositionMask(text);
  const matcher = new RegExp(esmSyntaxPattern.source, "gm");
  let match;
  while ((match = matcher.exec(text)) != null) {
    if (mask[match.index] === 1 && text[match.index - 1] !== ".") return true;
  }
  return false;
}

function hasCommonJsSyntax(source) {
  const text = String(source);
  const mask = codePositionMask(text);
  const matcher = /\b(?:module\s*\.\s*exports|exports\s*(?:\.|\[))/g;
  let match;
  while ((match = matcher.exec(text)) != null) {
    if (mask[match.index] === 1) return true;
  }
  return false;
}

const runtimeDecoratorSyntaxPattern = /(?:^|[\n;{}])\s*@[A-Za-z_$(\[]/;
const runtimeUsingSyntaxPattern =
  /\b(?:await\s+)?using\s+[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*\s*=/gu;

function hasRuntimeDecoratorSyntax(source) {
  const text = String(source);
  if (!runtimeDecoratorSyntaxPattern.test(text)) return false;
  const mask = codePositionMask(text);
  const matcher = new RegExp(runtimeDecoratorSyntaxPattern.source, "g");
  let match;
  while ((match = matcher.exec(text)) != null) {
    const decorator = match.index + match[0].lastIndexOf("@");
    if (mask[decorator] === 1) return true;
  }
  return false;
}

function hasRuntimeUsingSyntax(source) {
  const text = String(source);
  if (!/\busing\b/.test(text)) return false;
  const matcher = new RegExp(runtimeUsingSyntaxPattern.source, runtimeUsingSyntaxPattern.flags);
  // Blanking string/regexp/template trivia prevents false positives while
  // turning comments between declaration tokens into ordinary whitespace.
  return matcher.test(codeOnlyText(text));
}

function hasRuntimeTransformSyntax(source) {
  return hasRuntimeDecoratorSyntax(source) || hasRuntimeUsingSyntax(source);
}

function formatForHookSource(resolved, source) {
  if (hasEsmSyntax(source)) return "module";
  if (hasCommonJsSyntax(source)) return "commonjs";
  return formatForResolved(resolved);
}

// TypeScript sources loaded through the JS module executor must have their
// type syntax removed first; new Function() only parses JavaScript.
const typeScriptExtensionPattern = /\.(?:ts|mts|cts|tsx)$/i;

function hasBunTranspiledPragma(source) {
  const firstLine = String(source).split("\n", 1)[0].trimEnd();
  return /^\/\/\s*@bun(?:\s|$)/.test(firstLine);
}

function bunCommonJsArtifactFactory(source) {
  const text = String(source);
  const lineEnd = text.indexOf("\n");
  if (lineEnd < 0 || !/^\/\/\s*@bun\b.*@bun-cjs\b/.test(text.slice(0, lineEnd).trimEnd())) return null;
  const factorySource = text.slice(lineEnd + 1).trim();
  return factorySource.startsWith("(function") ? factorySource : null;
}

function maybeStripTypeScript(filename, source) {
  if (!typeScriptExtensionPattern.test(String(filename))) return source;
  // `// @bun` declares already-transpiled output. Parsing TypeScript below it
  // must fail instead of silently stripping types from an invalid artifact.
  if (hasBunTranspiledPragma(source)) return source;
  const loader = transpilerLoaderForFilename(filename);
  const overrides = tsconfigTransformOverrides(filename);
  // `.tsx` sources carry JSX that the plain type-stripper (fixed to a "ts"
  // loader) would leave as raw `<` tokens, and a project that opts into legacy
  // (experimental) decorators or a specific JSX runtime must be honored. Route
  // those through the full transform with the resolved loader + tsconfig
  // options. Plain `.ts` with the default tsconfig keeps the cheaper strip,
  // which already lowers TC39 standard decorators by default.
  if ((loader === "tsx" || overrides !== null) && typeof cottontail.transpilerTransform === "function") {
    try {
      return String(cottontail.transpilerTransform(
        String(source),
        JSON.stringify({ jsxAutoImport: true, ...(overrides ?? {}) }),
        loader,
      ));
    } catch (error) {
      throw markModuleCompileError(error, filename, source, 0);
    }
  }
  if (typeof cottontail.stripTypeScriptTypes !== "function") return source;
  try {
    return String(cottontail.stripTypeScriptTypes(String(source), 1));
  } catch {
    return source;
  }
}

function maybeTransformRuntimeSyntax(filename, source) {
  const path = String(filename);
  const needsTransform = hasRuntimeTransformSyntax(source);
  if (!needsTransform || typeof cottontail.transpilerTransform !== "function") return source;
  const extension = path.toLowerCase().match(/\.([^.]+)$/)?.[1];
  const loader = extension === "tsx" ? "tsx"
    : extension === "ts" || extension === "mts" || extension === "cts" ? "ts"
    : extension === "jsx" ? "jsx"
    : "js";
  return String(cottontail.transpilerTransform(
    String(source),
    JSON.stringify({ target: "bun", deadCodeElimination: false, jsxAutoImport: true, ...tsconfigTransformOverrides(path) }),
    loader,
  ));
}

// new Function("a", "b", body) prepends "function anonymous(a,b\n) {\n"
// before the body, so JSC parse-error line numbers are offset by 2.
const FUNCTION_WRAPPER_LINE_OFFSET = 2;
const CJS_FILENAME_BINDING = "__cottontailCjsFilename_4b86f6";
const CJS_DIRNAME_BINDING = "__cottontailCjsDirname_4b86f6";
const CJS_DYNAMIC_IMPORT_BINDING = "__cottontailCjsDynamicImport_4b86f6";
const CJS_REQUIRE_BINDING = "__cottontailCjsRequire_4b86f6";
const ESM_EXPORTS_BINDING = "__cottontailEsmNamespace_4b86f6";
const ESM_EVALUATION_COMPLETED_BINDING = "__cottontailEsmEvaluationCompleted_4b86f6";
const ESM_REQUIRE_BINDING = "__cottontailEsmRequire_4b86f6";
const ESM_PROMISE_RESOLVE_BINDING = "__cottontailPromiseResolve_4b86f6";
const ESM_SET_BINDING = "__cottontailSet_4b86f6";

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

// cottontail.compileFunction marshals its source as a NUL-terminated string,
// so an embedded U+0000 truncates the program and surfaces as a bogus
// "Unexpected EOF". JSC's own Function constructor is UTF-16 clean, so route
// those (rare) sources through it instead.
function nativeCompilerUsable(source) {
  return typeof cottontail.compileFunction === "function" && !String(source).includes("\0");
}

function compileModuleWrapper(args, source, filename, diagnosticSource = source) {
  const useNativeCompiler = nativeCompilerUsable(source);
  try {
    if (useNativeCompiler) {
      return cottontail.compileFunction(`(function(${args.join(",")}) {\n${source}\n})`, filename);
    }
    return new Function(...args, `${source}\n//# sourceURL=${sourceURLForResolved(filename)}`);
  } catch (error) {
    throw markModuleCompileError(error, filename, diagnosticSource, useNativeCompiler ? 1 : FUNCTION_WRAPPER_LINE_OFFSET);
  }
}

function compileAsyncModuleWrapper(args, source, filename, diagnosticSource = source) {
  const useNativeCompiler = nativeCompilerUsable(source);
  try {
    if (useNativeCompiler) {
      return {
        run: cottontail.compileFunction(`(async function(${args.join(",")}) {\n${source}\n})`, filename),
        wrapperLineOffset: 1,
      };
    }
    const AsyncFunction = (async () => {}).constructor;
    return {
      run: new AsyncFunction(...args, `${source}\n//# sourceURL=${sourceURLForResolved(filename)}`),
      wrapperLineOffset: FUNCTION_WRAPPER_LINE_OFFSET,
    };
  } catch (error) {
    throw markModuleCompileError(error, filename, diagnosticSource, useNativeCompiler ? 1 : FUNCTION_WRAPPER_LINE_OFFSET);
  }
}

function compilePublicCommonJsWrapper(source, filename) {
  const activeWrapper = Module.wrapper ?? wrapper;
  const prefix = String(activeWrapper?.[0]);
  const suffix = String(activeWrapper?.[1]);
  const internalArgs = [CJS_FILENAME_BINDING, CJS_DIRNAME_BINDING, CJS_DYNAMIC_IMPORT_BINDING];
  const cacheKey = String(filename);
  const cached = commonJsWrapperFactoryCache.get(cacheKey);
  let createWrapper;
  let moduleDirname;
  let dynamicImport;
  if (cached?.source === source
    && cached.moduleWrapper === activeWrapper
    && cached.prefix === prefix
    && cached.suffix === suffix) {
    createWrapper = cached.createWrapper;
    moduleDirname = cached.moduleDirname;
    dynamicImport = cached.dynamicImport;
  } else {
    // Bun permits a CommonJS artifact to install its own leading lexical
    // `require` binding. The Node-style wrapper's `require` formal would make
    // that source fail to parse before its local binding can shadow anything.
    // Rename only the wrapper formal for this shape; the source owns every
    // reference to `require`, so no injected alias (and no extra scope) is
    // needed.
    const code = codeOnlyText(source);
    const hasLeadingLexicalRequire = /^(?:\s*;\s*)*(?:const|let|class)\s+require\b/.test(code);
    const compilePrefix = hasLeadingLexicalRequire
      ? prefix.replace(/\brequire\b(?=\s*,\s*module\b)/, CJS_REQUIRE_BINDING)
      : prefix;
    const factorySource = `(function(${internalArgs.join(",")}) { return ${compilePrefix}${source}${suffix}\n})`;
    try {
      createWrapper = typeof cottontail.compileFunction === "function"
        ? cottontail.compileFunction(factorySource, filename)
        : new Function(...internalArgs, `return ${prefix}${source}${suffix}`);
    } catch (error) {
      throw markModuleCompileError(error, filename, source, 1);
    }
    moduleDirname = dirname(filename);
    dynamicImport = async (specifier, options) => globalThis.__cottontailImportModule(String(specifier), filename, options);
  }
  const compiledWrapper = createWrapper(filename, moduleDirname, dynamicImport);
  if (isSmolModuleCacheMode()) cottontail.jscSetNeverOptimize?.(compiledWrapper);
  commonJsWrapperFactoryCache.set(cacheKey, {
    source,
    moduleWrapper: activeWrapper,
    prefix,
    suffix,
    createWrapper,
    moduleDirname,
    dynamicImport,
  });
  return compiledWrapper;
}

function cachedPublicCommonJsWrapper(source, filename) {
  const activeWrapper = Module.wrapper ?? wrapper;
  const cached = commonJsWrapperFactoryCache.get(String(filename));
  if (cached?.source !== source
    || cached.moduleWrapper !== activeWrapper
    || cached.prefix !== String(activeWrapper?.[0])
    || cached.suffix !== String(activeWrapper?.[1])) {
    return null;
  }
  return cached.createWrapper(filename, cached.moduleDirname, cached.dynamicImport);
}

function compiledRuntimeEsmWrapper(source, filename, diagnosticSource) {
  const cacheKey = String(filename);
  const cached = runtimeEsmWrapperCache.get(cacheKey);
  if (cached?.source === source && cached.inputSource === diagnosticSource) return cached.run;
  const run = compileModuleWrapper(
    [ESM_EXPORTS_BINDING, "require", "module", "__filename", "__dirname", "__ctImportMeta"],
    source,
    filename,
    diagnosticSource,
  );
  runtimeEsmWrapperCache.set(cacheKey, { inputSource: diagnosticSource, source, run });
  return run;
}

function runPublicCommonJsWrapper(module, filename, compiledWrapper) {
  try {
    compiledWrapper.call(
      module.exports,
      module.exports,
      module.require,
      module,
      filename,
      dirname(filename),
    );
  } catch (error) {
    throw remapThrownModuleError(error, filename, FUNCTION_WRAPPER_LINE_OFFSET);
  }
  module.loaded = true;
  return module.exports;
}

function executeCommonJsSource(module, filename, source, requireOverride = undefined, sourceIsEsm = undefined) {
  if (sourceIsEsm ?? hasEsmSyntax(source)) {
    const cached = runtimeEsmWrapperCache.get(String(filename));
    let run;
    if (cached?.inputSource === source) {
      run = cached.run;
    } else {
      const transformed = transformEsmSourceForDynamicImport(source);
      maybeRegisterSourceMap(filename, transformed);
      recordCompileCache(filename, transformed);
      run = compiledRuntimeEsmWrapper(transformed, filename, source);
    }
    try {
      run(
        module.exports,
        requireOverride ?? module.require,
        module,
        filename,
        dirname(filename),
        importMetaForModule(filename),
      );
    } catch (error) {
      throw remapThrownModuleError(error, filename, FUNCTION_WRAPPER_LINE_OFFSET);
    }
    if (module.exports != null &&
        (typeof module.exports === "object" || typeof module.exports === "function") &&
        Object.hasOwn(module.exports, "module.exports")) {
      module.exports = module.exports["module.exports"];
    }
    finalizeEsmNamespaceOrder(module.exports);
    module.loaded = true;
    return module.exports;
  }
  // Route dynamic import() in plain CJS through the runtime module loader so
  // it resolves like Bun/Node (e.g. unknown node: builtins reject with
  // ERR_UNKNOWN_BUILTIN_MODULE instead of an opaque engine error). Pass the
  // helper as a wrapper binding so an explicit strict-mode directive remains
  // the first statement in the CommonJS function body.
  let effectiveSource = source;
  if (/(?<![.\w$])import\s*\((?!\s*\))/.test(effectiveSource)) {
    effectiveSource = replaceCodePattern(
      effectiveSource,
      /(?<![.\w$])import\s*\((?!\s*\))/g,
      `${CJS_DYNAMIC_IMPORT_BINDING}(`,
    );
  }
  maybeRegisterSourceMap(filename, effectiveSource);
  recordCompileCache(filename, effectiveSource);
  return runPublicCommonJsWrapper(
    module,
    filename,
    compilePublicCommonJsWrapper(effectiveSource, filename),
  );
}

function transpileExtensionSource(filename, loader, forceTransform = false, inputSource = undefined) {
  const source = (inputSource ?? readModuleFile(filename)).replace(/^#![^\n]*(\n|$)/, "");
  const cache = openRuntimeTranspilerCache(source, `${loader}:${forceTransform ? 1 : 0}`);
  if (cache?.hit) return cache.output;
  const finish = output => {
    cache?.store(output);
    return output;
  };
  if (loader === "ts" && hasBunTranspiledPragma(source)) return finish(source);
  const extension = String(filename).toLowerCase().match(/\.[^.]+$/)?.[0];
  const needsRuntimeTransform = hasRuntimeTransformSyntax(source);
  // Plain CommonJS JavaScript is already valid input for JSC. Keeping its
  // source layout intact preserves Node-compatible stack and source-map
  // coordinates instead of rewriting every require() through the transpiler.
  // The generic vendored JSC ports do not parse explicit-resource-management
  // declarations, so `using` and `await using` take the same narrow transform
  // path as decorators.
  if (!forceTransform && loader === "js" && (extension == null || extension === ".js" || extension === ".cjs") && !needsRuntimeTransform) {
    return finish(source);
  }
  if (typeof cottontail.transpilerTransform !== "function") {
    return finish(maybeTransformRuntimeSyntax(filename, maybeStripTypeScript(filename, source)));
  }
  try {
    // Bun's parser canonicalizes `module === require.main` through its
    // import.meta.main AST node. CJS modules must be printed with Node target
    // semantics so that node remains the original entry Module instead of
    // emitting import.meta into the CommonJS function wrapper.
    const target = /\brequire\.main\b/.test(source) ? "node" : "bun";
    return finish(String(cottontail.transpilerTransform(
      source,
      JSON.stringify({
        target,
        deadCodeElimination: false,
        minify: { syntax: true },
        _cottontailInitialIndent: 1,
        _cottontailPreserveUseStrict: true,
        // Keep CommonJS wrapper bindings live. The standalone transpiler would
        // otherwise fold them relative to its synthetic input filename.
        define: {
          __filename: CJS_FILENAME_BINDING,
          __dirname: CJS_DIRNAME_BINDING,
        },
        // Inject the automatic JSX runtime import so the compiled module can
        // execute standalone, and honor the project's tsconfig for decorator +
        // JSX lowering.
        jsxAutoImport: true,
        ...tsconfigTransformOverrides(filename),
      }),
      loader,
    )));
  } catch (error) {
    throw markModuleCompileError(error, filename, source, 0);
  }
}

function formatExtensionCompileSource(source, leadingNewline = false) {
  const body = String(source).trimEnd();
  if (!body) return leadingNewline ? "\n" : "";
  return leadingNewline ? `\n${body}\n` : `${body}\n`;
}

function sourceRequiresAsyncModuleExecution(filename, source) {
  // This native scan uses the same module grammar as the linker. In
  // particular, it distinguishes top-level `await (conditional)` from a
  // script-goal call to an identifier named `await`, which Function-based
  // probes cannot do reliably in JSC.
  if (typeof cottontail.transpilerScanModuleSyntax === "function") {
    try {
      const syntax = JSON.parse(cottontail.transpilerScanModuleSyntax(
        String(source),
        "{}",
        runtimeEsmGraphLoader(filename),
      ));
      return syntax?.hasTopLevelAwait === true;
    } catch {}
  }
  let probeSource = maybeStripTypeScript(filename, source);
  // Function constructors parse `await(value)` as a call to an identifier in
  // script grammar. Ask Bun's parser to print only this ambiguous shape first;
  // it canonicalizes a real top-level await while preserving a legal nested
  // binding such as `function call(await) { return await(value); }`.
  if (typeof cottontail.transpilerTransform === "function" &&
      /(?<![.\w$])await\s*\(/.test(codeOnlyText(probeSource))) {
    try {
      probeSource = String(cottontail.transpilerTransform(
        probeSource,
        JSON.stringify({ target: "bun", deadCodeElimination: false }),
        runtimeEsmGraphLoader(filename),
      ));
    } catch {}
  }
  let transformed;
  try {
    transformed = transformEsmSourceForDynamicImport(probeSource);
  } catch {
    return false;
  }
  // JSC's Function constructors cannot parse `using` declarations (the native
  // transpiler lowers them before evaluation), which would make both probes
  // below throw and misreport an async module as sync-invalid. Rewrite them
  // to `const` for the parse probe only; `await using` keeps its await so
  // top-level-await detection still fires.
  transformed = transformed
    .replace(
      /\bawait\s+using\s+([$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*)\s*=/gu,
      "const $1 = await ",
    )
    .replace(
      /\busing\s+([$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*)\s*=/gu,
      "const $1 =",
    );
  try {
    new Function(transformed);
    return false;
  } catch (syncError) {
    if (!(syncError instanceof SyntaxError)) return false;
  }

  try {
    const AsyncFunction = (async () => {}).constructor;
    new AsyncFunction(transformed);
    return true;
  } catch {
    return false;
  }
}

function isAsyncModuleBundleFailure(error, filename, source) {
  const message = String(error?.message ?? error);
  if (/top-level await/i.test(message)) return true;
  if (!/["']await["'] can only be used inside an ["']async["'] function/i.test(message)) return false;
  return sourceRequiresAsyncModuleExecution(filename, source);
}

const runtimeEsmGraphExternalPatterns = Object.freeze([
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.cts",
]);

function runtimeEsmGraphPathKey(filename) {
  const path = splitSpecifierSuffix(String(filename)).bare;
  let absolute = isAbsolute(path) ? path : resolve(cottontail.cwd(), path);
  try { absolute = cottontail.realpathSync(absolute); } catch {}
  return String(absolute).replace(/\\/g, "/");
}

function runtimeEsmSourceFingerprint(source) {
  const text = String(source);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
  }
  return `${text.length.toString(36)}-${hash.toString(16)}`;
}

function runtimeEsmGraphLoader(filename) {
  const extension = String(filename).toLowerCase().match(/\.([^.\\/]+)$/)?.[1];
  if (extension === "tsx") return "tsx";
  if (extension === "ts" || extension === "mts" || extension === "cts") return "ts";
  if (extension === "jsx") return "jsx";
  return "js";
}

const runtimeEsmExportNotFound = Symbol("cottontail.runtimeEsmExportNotFound");
const runtimeEsmExportAmbiguous = Symbol("cottontail.runtimeEsmExportAmbiguous");
const runtimeEsmExportUnknown = Symbol("cottontail.runtimeEsmExportUnknown");
const runtimeEsmIdentifierPattern = /^[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*$/;

function collectRuntimeEsmCodeMatches(source, pattern, visit) {
  replaceCodePattern(source, pattern, (...args) => {
    visit(...args);
    return args[0];
  });
}

function runtimeEsmSpecifierText(literal) {
  const text = String(literal);
  return text.length >= 2 ? text.slice(1, -1) : text;
}

function runtimeEsmLocalToken(record, name) {
  let token = record.localTokens.get(name);
  if (token === undefined) {
    token = { record, name };
    record.localTokens.set(name, token);
  }
  return token;
}

function addRuntimeEsmLinkageSpecifier(record, specifier) {
  const text = String(specifier);
  if (!record.specifierSet.has(text)) {
    record.specifierSet.add(text);
    record.specifiers.push(text);
  }
}

function runtimeEsmLinkageRecord(filename, source, loader) {
  const key = String(filename);
  const text = String(source);
  const cached = runtimeEsmLinkageRecords.get(key);
  if (cached?.source === text && cached.loader === loader) return cached;

  const record = {
    key,
    filename: splitSpecifierSuffix(key).bare,
    source: text,
    loader,
    scanError: null,
    explicit: new Map(),
    localTokens: new Map(),
    namedImports: [],
    reexports: [],
    stars: [],
    specifiers: [],
    specifierSet: new IntrinsicSet(),
    dependencyBySpecifier: new Map(),
    dependencies: [],
    building: false,
    built: false,
    validated: false,
  };
  runtimeEsmLinkageRecords.set(key, record);

  let scan;
  try {
    scan = JSON.parse(cottontail.transpilerScan(text, "{}", loader));
  } catch (error) {
    record.scanError = error;
    return record;
  }
  for (const name of Array.isArray(scan?.exports) ? scan.exports : []) {
    const exported = String(name);
    record.explicit.set(exported, { kind: "local", token: runtimeEsmLocalToken(record, exported) });
  }
  for (const item of Array.isArray(scan?.imports) ? scan.imports : []) {
    if (item?.kind === "import-statement") addRuntimeEsmLinkageSpecifier(record, item.path);
  }

  const addNamedImports = (names, literal) => {
    const specifier = runtimeEsmSpecifierText(literal);
    addRuntimeEsmLinkageSpecifier(record, specifier);
    for (const binding of importedBindingEntries(names)) {
      if (!runtimeEsmIdentifierPattern.test(binding.imported) ||
          !runtimeEsmIdentifierPattern.test(binding.local)) continue;
      record.namedImports.push({
        specifier,
        imported: binding.imported,
        local: binding.local,
      });
    }
  };
  collectRuntimeEsmCodeMatches(
    text,
    /\bimport\s+[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*\s*,\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"])(?:\s+(?:with|assert)\s*\{[^}]*\})?\s*;?/g,
    (_all, names, literal) => addNamedImports(names, literal),
  );
  collectRuntimeEsmCodeMatches(
    text,
    /\bimport\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"])(?:\s+(?:with|assert)\s*\{[^}]*\})?\s*;?/g,
    (_all, names, literal) => addNamedImports(names, literal),
  );

  const importedByLocal = new Map();
  for (const imported of record.namedImports) importedByLocal.set(imported.local, imported);
  collectRuntimeEsmCodeMatches(
    text,
    /\bexport\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"])(?:\s+(?:with|assert)\s*\{[^}]*\})?\s*;?/g,
    (_all, names, literal) => {
      const specifier = runtimeEsmSpecifierText(literal);
      addRuntimeEsmLinkageSpecifier(record, specifier);
      for (const part of String(names).split(",")) {
        const pieces = part.trim().split(/\s+as\s+/);
        const imported = pieces[0]?.trim();
        const exported = (pieces[1] ?? pieces[0])?.trim();
        if (!runtimeEsmIdentifierPattern.test(imported ?? "") ||
            !runtimeEsmIdentifierPattern.test(exported ?? "") ||
            !record.explicit.has(exported)) continue;
        const edge = { specifier, imported, exported };
        record.reexports.push(edge);
        record.explicit.set(exported, { kind: "indirect", edge });
      }
    },
  );
  collectRuntimeEsmCodeMatches(
    text,
    /\bexport\s*\{([^}]*)\}\s*(?:from\s*(['"][^'"]+['"]))?(?:\s+(?:with|assert)\s*\{[^}]*\})?\s*;?/g,
    (_all, names, literal) => {
      if (literal !== undefined) return;
      for (const part of String(names).split(",")) {
        const pieces = part.trim().split(/\s+as\s+/);
        const local = pieces[0]?.trim();
        const exported = (pieces[1] ?? pieces[0])?.trim();
        if (!runtimeEsmIdentifierPattern.test(local ?? "") ||
            !runtimeEsmIdentifierPattern.test(exported ?? "") ||
            !record.explicit.has(exported)) continue;
        const imported = importedByLocal.get(local);
        if (imported !== undefined) {
          const edge = { ...imported, exported };
          record.reexports.push(edge);
          record.explicit.set(exported, { kind: "indirect", edge });
        } else {
          record.explicit.set(exported, { kind: "local", token: runtimeEsmLocalToken(record, local) });
        }
      }
    },
  );
  collectRuntimeEsmCodeMatches(
    text,
    /\bexport\s+default\s+(?:(?:async\s+)?function\s*\*?|class\s+)([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)/g,
    (_all, local) => {
      if (record.explicit.has("default")) {
        record.explicit.set("default", { kind: "local", token: runtimeEsmLocalToken(record, local) });
      }
    },
  );
  collectRuntimeEsmCodeMatches(
    text,
    /\bexport\s*\*\s*from\s*(['"][^'"]+['"])(?:\s+(?:with|assert)\s*\{[^}]*\})?\s*;?/g,
    (_all, literal) => {
      const specifier = runtimeEsmSpecifierText(literal);
      addRuntimeEsmLinkageSpecifier(record, specifier);
      record.stars.push({ specifier });
    },
  );
  return record;
}

function runtimeEsmLinkageDependency(record, specifier) {
  if (record.dependencyBySpecifier.has(specifier)) {
    return record.dependencyBySpecifier.get(specifier);
  }
  let dependency = null;
  const local = specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:");
  if (local && moduleHooks.length === 0 && runtimePluginOnResolve.length === 0 && runtimePluginOnLoad.length === 0) {
    try {
      const resolved = resolveRequest(specifier, record.filename, false, "import");
      const { bare: resolvedPath, suffix } = splitSpecifierSuffix(resolved);
      const extension = String(resolvedPath).toLowerCase().match(/\.[^.\\/]+$/)?.[0];
      const linkageLoader = extension === ".tsx" ? "tsx"
        : extension === ".ts" || extension === ".mts" ? "ts"
        : extension === ".jsx" ? "jsx"
        : extension === ".js" || extension === ".mjs" ? "js"
        : null;
      if (!suffix && linkageLoader !== null && modulePathExists(resolvedPath)) {
        const source = readModuleFile(resolvedPath).replace(/^#![^\n]*(\n|$)/, "");
        if (hasEsmSyntax(source) || !hasCommonJsSyntax(source)) {
          dependency = runtimeEsmLinkageRecord(resolved, source, linkageLoader);
        }
      }
    } catch {}
  }
  record.dependencyBySpecifier.set(specifier, dependency);
  if (dependency !== null && !record.dependencies.includes(dependency)) record.dependencies.push(dependency);
  return dependency;
}

function buildRuntimeEsmLinkageGraph(record) {
  if (record.built || record.building || record.scanError !== null) return;
  record.building = true;
  for (const specifier of record.specifiers) {
    const dependency = runtimeEsmLinkageDependency(record, specifier);
    if (dependency !== null) buildRuntimeEsmLinkageGraph(dependency);
  }
  for (const edge of record.reexports) {
    edge.dependency = runtimeEsmLinkageDependency(record, edge.specifier);
  }
  for (const edge of record.stars) {
    edge.dependency = runtimeEsmLinkageDependency(record, edge.specifier);
  }
  for (const edge of record.namedImports) {
    edge.dependency = runtimeEsmLinkageDependency(record, edge.specifier);
  }
  record.building = false;
  record.built = true;
}

function resolveRuntimeEsmExport(record, name, resolveSet = new IntrinsicSet()) {
  if (record === null) return runtimeEsmExportUnknown;
  const marker = `${record.key}\0${name}`;
  if (resolveSet.has(marker)) return runtimeEsmExportNotFound;
  resolveSet.add(marker);
  try {
    const explicit = record.explicit.get(name);
    if (explicit?.kind === "local") return explicit.token;
    if (explicit?.kind === "indirect") {
      return resolveRuntimeEsmExport(explicit.edge.dependency ?? null, explicit.edge.imported, resolveSet);
    }
    if (name === "default") return runtimeEsmExportNotFound;
    let found = runtimeEsmExportNotFound;
    let sawUnknown = false;
    for (const edge of record.stars) {
      const resolved = resolveRuntimeEsmExport(edge.dependency ?? null, name, resolveSet);
      if (resolved === runtimeEsmExportAmbiguous) return resolved;
      if (resolved === runtimeEsmExportUnknown) {
        sawUnknown = true;
      } else if (resolved !== runtimeEsmExportNotFound) {
        if (found !== runtimeEsmExportNotFound && found !== resolved) return runtimeEsmExportAmbiguous;
        found = resolved;
      }
    }
    return sawUnknown ? runtimeEsmExportUnknown : found;
  } finally {
    resolveSet.delete(marker);
  }
}

function runtimeEsmUsageSource(record) {
  let source = record.source;
  if (record.loader === "ts" || record.loader === "tsx") {
    source = maybeStripTypeScript(record.filename, source);
  }
  source = replaceCodePattern(
    source,
    /\bimport\s+[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*\s*,\s*\{[^}]*\}\s*from\s*['"][^'"]+['"](?:\s+(?:with|assert)\s*\{[^}]*\})?\s*;?/g,
    ";",
  );
  source = replaceCodePattern(
    source,
    /\bimport\s*\{[^}]*\}\s*from\s*['"][^'"]+['"](?:\s+(?:with|assert)\s*\{[^}]*\})?\s*;?/g,
    ";",
  );
  return replaceCodePattern(
    source,
    /\bexport\s*\{[^}]*\}(?:\s*from\s*['"][^'"]+['"])?(?:\s+(?:with|assert)\s*\{[^}]*\})?\s*;?/g,
    ";",
  );
}

function runtimeEsmIdentifierIsUsed(source, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`(^|[^\\w$\\u0080-\\uffff])${escaped}(?![\\w$\\u0080-\\uffff])`, "g");
  const mask = codePositionMask(source);
  let match;
  while ((match = matcher.exec(source)) !== null) {
    const offset = match.index + match[1].length;
    if (mask[offset] === 1) return true;
  }
  return false;
}

function runtimeEsmAmbiguousExportError(name) {
  return new SyntaxError(
    `Export named '${name}' cannot be resolved due to ambiguous multiple bindings in module`,
  );
}

function throwRuntimeEsmScanError(record, directEntry) {
  const diagnostic = String(record.scanError?.message ?? record.scanError);
  if (directEntry) throw record.scanError;
  const duplicate = diagnostic.match(/Multiple exports with the same name "([^"]+)"/);
  if (duplicate) throw new SyntaxError(`Cannot export a duplicate name '${duplicate[1]}'.`);
  throw new SyntaxError(diagnostic);
}

function validateRuntimeEsmLinkageRecord(record, root, directEntry, visited) {
  if (record.scanError !== null) throwRuntimeEsmScanError(record, directEntry && record === root);
  if (record.validated || visited.has(record)) return;
  visited.add(record);
  for (const dependency of record.dependencies) {
    validateRuntimeEsmLinkageRecord(dependency, root, directEntry, visited);
  }

  const isTypeScript = record.loader === "ts" || record.loader === "tsx";
  for (const edge of record.reexports) {
    const resolved = resolveRuntimeEsmExport(edge.dependency ?? null, edge.imported);
    if (resolved === runtimeEsmExportAmbiguous) throw runtimeEsmAmbiguousExportError(edge.imported);
    if (resolved === runtimeEsmExportNotFound && !isTypeScript) {
      throw new SyntaxError(`export '${edge.imported}' not found in '${edge.specifier}'`);
    }
  }

  const usageSource = isTypeScript ? runtimeEsmUsageSource(record) : record.source;
  for (const edge of record.namedImports) {
    if (isTypeScript && !runtimeEsmIdentifierIsUsed(usageSource, edge.local)) continue;
    const resolved = resolveRuntimeEsmExport(edge.dependency ?? null, edge.imported);
    if (resolved === runtimeEsmExportAmbiguous) throw runtimeEsmAmbiguousExportError(edge.imported);
    if (resolved !== runtimeEsmExportNotFound) continue;
    const defaultResolution = resolveRuntimeEsmExport(edge.dependency ?? null, "default");
    const namedLocalToken = edge.dependency?.localTokens.get(edge.imported);
    const suggestion = namedLocalToken !== undefined && defaultResolution === namedLocalToken
      ? " Did you mean to import default?"
      : "";
    const target = edge.dependency?.filename ?? edge.specifier;
    throw new SyntaxError(
      `Export named '${edge.imported}' not found in module '${target}'.${suggestion}`,
    );
  }
  record.validated = true;
}

function validateRuntimeEsmLinkage(filename, source, loader, directEntry) {
  if (typeof cottontail.transpilerScan !== "function") return;
  const root = runtimeEsmLinkageRecord(filename, source, loader);
  buildRuntimeEsmLinkageGraph(root);
  validateRuntimeEsmLinkageRecord(root, root, directEntry, new IntrinsicSet());
}

function runtimeEsmRootHasBarePackageEdges(entryPath, entrySource) {
  if (typeof cottontail.transpilerScanImports !== "function") return false;
  try {
    const imports = JSON.parse(cottontail.transpilerScanImports(
      String(entrySource),
      "{}",
      runtimeEsmGraphLoader(entryPath),
    ));
    return Array.isArray(imports) && imports.some(item => {
      if (item?.kind !== "import-statement" && item?.kind !== "require-call") return false;
      const specifier = String(item?.path ?? "");
      return specifier.length > 0 &&
        !specifier.startsWith(".") &&
        !specifier.startsWith("/") &&
        !specifier.startsWith("file:") &&
        !isBuiltin(specifier) &&
        !hasRuntimePackageReplacement(specifier);
    });
  } catch {
    return false;
  }
}

function runtimeEsmRootHasStaticImportEdges(entryPath, entrySource) {
  if (typeof cottontail.transpilerScanImports !== "function") return true;
  try {
    const imports = JSON.parse(cottontail.transpilerScanImports(
      String(entrySource),
      "{}",
      runtimeEsmGraphLoader(entryPath),
    ));
    return !Array.isArray(imports) || imports.some(item => item?.kind === "import-statement");
  } catch {
    return true;
  }
}

function runtimeAsyncEsmGraph(entryPath, entrySource) {
  if (typeof cottontail.bundleNative !== "function" ||
      !runtimeEsmRootHasBarePackageEdges(entryPath, entrySource)) {
    return null;
  }
  const sourceFingerprint = runtimeEsmSourceFingerprint(entrySource);
  const cacheKey = `${runtimeEsmGraphPathKey(entryPath)}\0${sourceFingerprint}`;
  const memoryCached = bundledAsyncEsmGraphCache.get(cacheKey);
  if (memoryCached !== undefined) return memoryCached;

  let bundled;
  try {
    bundled = String(cottontail.bundleNative(
      splitSpecifierSuffix(String(entryPath)).bare,
      dirname(entryPath),
      JSON.stringify({
        format: "esm",
        target: "bun",
        packages: "external",
        external: ["*.node"],
        inlineImportMetaProperties: true,
      }),
    ));
  } catch {
    bundledAsyncEsmGraphCache.set(cacheKey, null);
    return null;
  }
  const record = {
    sourceFingerprint,
    source: bundled,
    async: sourceRequiresAsyncModuleExecution(entryPath, bundled),
  };
  bundledAsyncEsmGraphCache.set(cacheKey, record);
  return record;
}

function rewriteBundledEsmDynamicImports(source) {
  if (!/(?<![.\w$])import\s*\((?!\s*\))/.test(source)) return source;
  return replaceCodePattern(
    source,
    /(?<![.\w$])import\s*\((?!\s*\))/g,
    `${CJS_DYNAMIC_IMPORT_BINDING}(`,
  );
}

function executeBundledCommonJsModule(module, filename, source, loader) {
  const cacheKey = String(filename);
  let factoryEntry = bundledCommonJsFactoryCache.get(cacheKey);
  if (factoryEntry?.source !== source || factoryEntry.loader !== loader) {
    let buildFactory;
    let bundled;
    try {
      bundled = String(cottontail.bundleNative(
        filename,
        dirname(filename),
        JSON.stringify({
          format: "cjs",
          target: "bun",
          // The live Module._extensions function selects the grammar. Bun's
          // native bundler otherwise treats a .js entry as JSX-capable, which
          // lets wrapping the original `.js` loader silently widen its syntax.
          loader,
          preserveExternalRequireName: true,
          runtimeFileLoaderPaths: true,
          ignoreDCEAnnotations: true,
          treeShaking: false,
          // Keep packages and JavaScript dependencies in createRequire()'s
          // shared module cache. Inlining a package while externalizing its
          // relative files also moves those require() calls under the entry's
          // directory and gives them the wrong referrer.
          packages: "external",
          external: runtimeEsmGraphExternalPatterns,
          define: {
            "import.meta": "__ctImportMeta",
          },
        }),
      ));
    } catch (error) {
      if (isAsyncModuleBundleFailure(error, filename, source)) {
        throw new TypeError(`require() async module "${filename}" is unsupported. use "await import()" instead.`);
      }
      throw error;
    }
    bundled = rewriteBundledEsmDynamicImports(bundled);
    maybeRegisterSourceMap(filename, bundled);
    recordCompileCache(filename, bundled);
    buildFactory = cottontail.compileFunction(
      `(function(__ctImportMeta, ${CJS_DYNAMIC_IMPORT_BINDING}) { return (\n${bundled}\n); })`,
      filename,
    );
    factoryEntry = {
      source,
      loader,
      buildFactory,
      sourceExportsEsmMarker: undefined,
      namespaceOrder: null,
    };
    bundledCommonJsFactoryCache.set(cacheKey, factoryEntry);
  }
  const factory = factoryEntry.buildFactory(
    importMetaForModule(filename),
    async (specifier, options) => globalThis.__cottontailImportModule(String(specifier), filename, options),
  );
  if (typeof factory !== "function") {
    throw new TypeError(`Runtime bundle for '${filename}' did not produce a CommonJS wrapper`);
  }
  if (isSmolModuleCacheMode()) cottontail.jscSetNeverOptimize?.(factory);
  // The bundler lowers this ESM file's static imports to require() calls. They
  // still resolve with ESM conditions: using the module's ordinary CommonJS
  // require here can select a package's `require` export (or reject an
  // import-only package) even though the original edge was an import.
  factory(module.exports, createEsmRequire(filename, module), module, filename, dirname(filename));
  let namespaceAlreadyOrdered = false;
  if (module.exports != null &&
      (typeof module.exports === "object" || typeof module.exports === "function") &&
      Object.hasOwn(module.exports, "module.exports")) {
    module.exports = module.exports["module.exports"];
  } else {
    const required = requiredBundledEsmNamespace(module.exports, source, loader, factoryEntry);
    module.exports = required.value;
    namespaceAlreadyOrdered = required.ordered;
  }
  if (!namespaceAlreadyOrdered) finalizeEsmNamespaceOrder(module.exports);
  module.loaded = true;
  return module.exports;
}

function createEsmRequire(basePath, parentModule) {
  const require = request => {
    if (typeof request !== "string") throw invalidModuleIdType(request);
    if (request.length === 0) throw invalidEmptyModuleId();
    const directMock = bunModuleMockFor(request);
    if (directMock.found) return directMock.value;
    const resolved = resolveRequest(request, basePath, true, "import");
    const resolvedMock = bunModuleMockFor(resolved);
    if (resolvedMock.found) return resolvedMock.value;
    return loadCommonJsModule(resolved, parentModule);
  };
  require.resolve = request => {
    if (typeof request !== "string") throw invalidRequestType(request);
    return resolveRequest(request, basePath, true, "import");
  };
  require.resolve.paths = request => {
    if (typeof request !== "string") throw invalidRequestType(request);
    const text = request;
    if (isBuiltin(text)) return null;
    if (text === "." || text === ".." || text.startsWith("./") || text.startsWith("../")) {
      return [dirname(basePath)];
    }
    return _nodeModulePaths(dirname(basePath));
  };
  require.cache = commonJsCacheObject;
  require.extensions = extensionsForRequire(basePath);
  Object.defineProperty(require, "main", {
    configurable: true,
    enumerable: true,
    get() { return mainModule; },
  });
  return require;
}

function executeRuntimeEsmSourceModule(module, filename, originalSource, loader) {
  if (sourceRequiresAsyncModuleExecution(filename, originalSource)) {
    throw new TypeError(`require() async module "${filename}" is unsupported. use "await import()" instead.`);
  }
  const source = transpileExtensionSource(filename, loader, true, originalSource);
  module.exports = createModuleNamespace();
  module[runtimeEsmSourceModuleKey] = true;
  return executeCommonJsSource(module, filename, source, createEsmRequire(filename, module), true);
}

function executeDefaultExtension(module, filename, loader) {
  const originalSource = readModuleFile(filename).replace(/^#![^\n]*(\n|$)/, "");
  const bundledCommonJsFactory = bunCommonJsArtifactFactory(originalSource);
  if (bundledCommonJsFactory != null) {
    // COTTONTAIL-COMPAT: Bun-targeted CJS build output is already a complete
    // module factory. Invoking it directly avoids wrapping the factory expression
    // as inert source when it is launched or loaded through node:module.
    const factory = cottontail.compileFunction(bundledCommonJsFactory, filename);
    factory(module.exports, module.require, module, filename, dirname(filename));
    module.loaded = true;
    return module.exports;
  }
  const compileOverridden = module._compile !== defaultModuleCompile;
  if (!compileOverridden) {
    const cachedWrapper = cachedPublicCommonJsWrapper(originalSource, filename);
    if (cachedWrapper !== null) return runPublicCommonJsWrapper(module, filename, cachedWrapper);
  }
  // COTTONTAIL-COMPAT: Bun module-detects every source. Top-level await (and
  // await using) without any import/export syntax must still take the ESM
  // lane: the sync CJS wrapper cannot parse it. Entry points then execute
  // through the async module graph and require() throws Bun's async-module
  // TypeError. The bare-await regex is only a cheap gate; the compile probe in
  // sourceRequiresAsyncModuleExecution is scope-aware and rejects await that
  // is inside functions.
  const originalIsEsm = hasEsmSyntax(originalSource) ||
    (/(?<![.\w$])await\b/.test(originalSource) &&
      sourceRequiresAsyncModuleExecution(filename, originalSource));
  const isEmbeddedRuntimeSource = embeddedRuntimeSourceEntry(filename).found;
  if (originalIsEsm && !isEmbeddedRuntimePath(filename) && !isGeneratedRuntimeBundlePath(filename)) {
    validateRuntimeEsmLinkage(filename, originalSource, loader, module === mainModule);
  }
  if (originalIsEsm && sourceRequiresAsyncModuleExecution(filename, originalSource)) {
    throw new TypeError(`require() async module "${filename}" is unsupported. use "await import()" instead.`);
  }
  const useRuntimeEsmSource = isEmbeddedRuntimeSource ||
    (runtimeEsmSourceExecutionDepth > 0 &&
      (originalSource.length < 256 * 1024 || runtimeEsmRootHasStaticImportEdges(filename, originalSource)));
  if (originalIsEsm && useRuntimeEsmSource) {
    return executeRuntimeEsmSourceModule(module, filename, originalSource, loader);
  }
  if (originalIsEsm &&
      !standaloneFileEntry(filename).found &&
      typeof cottontail.bundleNative === "function") {
    return executeBundledCommonJsModule(module, filename, originalSource, loader);
  }
  const source = transpileExtensionSource(filename, loader, compileOverridden, originalSource);
  // Bun's synchronous ESM path does not call an overridden module._compile.
  const sourceIsEsm = source === originalSource ? originalIsEsm : hasEsmSyntax(source);
  if (sourceIsEsm) return executeCommonJsSource(module, filename, source, undefined, true);
  const compileSource = formatExtensionCompileSource(source, compileOverridden);
  if (compileOverridden) return module._compile(compileSource, filename);
  return executeCommonJsSource(module, filename, compileSource, undefined, false);
}

function loaderExtensionFor(filename) {
  const name = basename(String(filename));
  let longest = "";
  for (const extension of Object.keys(_extensions)) {
    if (name !== extension && name.endsWith(extension) && extension.length > longest.length) {
      longest = extension;
    }
  }
  if (longest) return longest;
  const lexical = name.match(/\.[^./\\]+$/)?.[0];
  return lexical && lexical !== name ? lexical : ".js";
}

function executeCommonJsModule(module, filename) {
  const extension = loaderExtensionFor(filename);
  if (extension === ".mjs" && (globalThis.process?.execArgv ?? []).includes("--no-experimental-require-module")) {
    const parent = module[moduleParentKey]?.filename;
    const from = parent ? ` from ${parent}` : "";
    const error = new Error(
      `require() of ES Module ${filename}${from} not supported.\n` +
      `Instead change the require of ${filename} to a dynamic import() which is available in all CommonJS modules.`,
    );
    error.code = "ERR_REQUIRE_ESM";
    throw error;
  }
  const registeredLoader = _extensions[extension];
  const usesDefaultFallback = registeredLoader == null;
  const loader = registeredLoader ?? _extensions[".js"];
  if (typeof loader !== "function") {
    const error = new TypeError(`Module._extensions['${extension}'] is not a function`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  // Bun accepts JSX/TSX without publishing those suffixes in
  // Module._extensions. Preserve that implicit filename grammar even when a
  // user wraps the original `.js` handler, while explicit/cross-assigned
  // handlers keep the grammar selected by the handler itself.
  const previousContext = implicitDefaultExtensionContext;
  implicitDefaultExtensionContext = usesDefaultFallback && (extension === ".jsx" || extension === ".tsx")
    ? { filename: String(filename), loader: extension.slice(1) }
    : null;
  try {
    loader(module, filename);
  } finally {
    implicitDefaultExtensionContext = previousContext;
  }
  return module.exports;
}

function hookSourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(source));
  if (ArrayBuffer.isView(source)) {
    return new TextDecoder().decode(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  }
  return String(source ?? "");
}

function hookRequireBase(resolved) {
  const text = String(resolved);
  if (text.startsWith("file:")) return fileURLToPath(text);
  if (isAbsolute(text)) return text;
  return join(cottontail.cwd(), "__cottontail-module-hook__.js");
}

function importMetaForHookModule(resolved, suffix = "") {
  const text = String(resolved);
  const requireBase = hookRequireBase(text);
  const meta = importMetaForModule(requireBase, suffix);
  if (requireBase !== text) meta.url = text + suffix;
  return meta;
}

function executeHookSource(resolved, source, format) {
  const sourceText = hookSourceText(source);
  const effectiveFormat = format ?? (hasEsmSyntax(sourceText) ? "module" : formatForResolved(resolved));
  if (effectiveFormat === "builtin") return loadBuiltinOrReplacement(resolved);
  if (effectiveFormat === "json" || String(resolved).endsWith(".json")) return JSON.parse(sourceText);
  if (commonJsCache.has(resolved)) return commonJsCache.get(resolved).exports;
  const module = makeModule(resolved);
  commonJsCache.set(resolved, module);
  const executableSource = effectiveFormat === "module"
    ? transformEsmSourceForDynamicImport(sourceText)
    : replaceCodePattern(sourceText, /\bimport\.meta\b/g, "__ctImportMeta");
  maybeRegisterSourceMap(resolved, executableSource);
  recordCompileCache(resolved, executableSource);
  const wrapper = new Function(
    effectiveFormat === "module" ? ESM_EXPORTS_BINDING : "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    "__ctImportMeta",
    `${executableSource}\n//# sourceURL=${sourceURLForResolved(resolved)}`,
  );
  const args = [
    module.exports,
    createRequire(hookRequireBase(resolved)),
    module,
    resolved,
    dirname(resolved),
    importMetaForHookModule(resolved),
  ];
  if (effectiveFormat === "module") wrapper(...args);
  else wrapper.call(module.exports, ...args);
  if (module.exports != null &&
      (typeof module.exports === "object" || typeof module.exports === "function") &&
      Object.hasOwn(module.exports, "module.exports")) {
    module.exports = module.exports["module.exports"];
  }
  module.loaded = true;
  return module.exports;
}

function defaultLoadForHooks(url) {
  const resolved = urlToResolved(url);
  const hookedFormat = hookResolvedFormats.get(resolved);
  const format = hookedFormat ?? formatForResolved(resolved);
  if (format === "builtin") return { format, source: null, shortCircuit: true };
  const explicitFormat = hookedFormat === undefined && String(resolved).endsWith(".js") && format === "commonjs"
    ? undefined
    : format;
  return { format: explicitFormat, source: readModuleFile(resolved), shortCircuit: true };
}

function runLoadHooks(resolved) {
  if (!moduleHooks.some((hook) => typeof hook.load === "function")) return undefined;
  const url = resolvedToUrl(resolved);
  const baseContext = { format: hookResolvedFormats.get(resolved) ?? formatForResolved(resolved), importAttributes: {} };
  const dispatchLoad = (index, nextUrl, context) => {
    while (index >= 0) {
      const hook = moduleHooks[index];
      if (typeof hook.load === "function") {
        let calledNext = false;
        const nextLoad = (forwardedUrl = nextUrl, nextContext = undefined) => {
          calledNext = true;
          const mergedContext = nextContext === undefined
            ? context
            : { ...context, ...(nextContext ?? {}) };
          return dispatchLoad(index - 1, String(forwardedUrl), mergedContext);
        };
        const result = hook.load(String(nextUrl), context, nextLoad);
        return normalizeLoadHookResult(result, calledNext);
      }
      index -= 1;
    }
    return defaultLoadForHooks(nextUrl);
  };

  return dispatchLoad(moduleHooks.length - 1, url, baseContext);
}

function applyLoadHooks(resolved) {
  const result = runLoadHooks(resolved);
  if (result === undefined) return null;
  if (result.source == null) return null;
  return executeHookSource(resolved, result.source, result.format);
}

const moduleNamespaceEsmMarkers = new WeakMap();
const moduleNamespacePrototype = Object.create(null);
Object.defineProperty(moduleNamespacePrototype, "__esModule", {
  enumerable: false,
  configurable: false,
  get() {
    return moduleNamespaceEsmMarkers.get(this);
  },
  set(value) {
    if (value === true) moduleNamespaceEsmMarkers.set(this, true);
    else moduleNamespaceEsmMarkers.delete(this);
  },
});

function createModuleNamespace() {
  const namespace = Object.create(moduleNamespacePrototype);
  Object.defineProperty(namespace, Symbol.toStringTag, { value: "Module" });
  return namespace;
}
globalThis.__cottontailCreateRegisteredSelfModuleNamespace = () => createModuleNamespace();

// An ES module namespace exposes its own string keys in ascending code-unit
// order ([[OwnPropertyKeys]] sorts the exported names). Cottontail populates
// the namespace as an ordinary object in source order, so once evaluation
// (including any runtime `export *` population) has finished, reorder its own
// enumerable string keys to match. The keys are re-inserted on the *same*
// object so the namespace's identity survives — cyclic imports that already
// captured the reference keep observing it, now in spec order.
function finalizeEsmNamespaceOrder(namespace) {
  if (namespace == null || (typeof namespace !== "object" && typeof namespace !== "function")) return namespace;
  if (namespace[Symbol.toStringTag] !== "Module") return namespace;
  const keys = Object.keys(namespace);
  if (keys.length < 2) return namespace;
  let ordered = true;
  for (let i = 1; i < keys.length; i += 1) {
    if (keys[i - 1] > keys[i]) { ordered = false; break; }
  }
  if (ordered) return namespace;
  const descriptors = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(namespace, key);
    // Reordering means deleting and re-adding; bail if any key is locked down.
    if (!descriptor || descriptor.configurable !== true) return namespace;
    descriptors.push([key, descriptor]);
  }
  descriptors.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [key] of descriptors) delete namespace[key];
  for (const [key, descriptor] of descriptors) Object.defineProperty(namespace, key, descriptor);
  return namespace;
}

function sourceExportsEsmMarker(source, loader, factoryEntry = undefined) {
  if (factoryEntry?.sourceExportsEsmMarker !== undefined) {
    return factoryEntry.sourceExportsEsmMarker;
  }
  let result = false;
  if (typeof cottontail.transpilerScan !== "function") return false;
  try {
    const scan = JSON.parse(cottontail.transpilerScan(String(source), "{}", loader));
    result = Array.isArray(scan?.exports) && scan.exports.includes("__esModule");
  } catch {}
  if (factoryEntry) factoryEntry.sourceExportsEsmMarker = result;
  return result;
}

function sameOwnKeyShape(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isArrayIndexString(key) {
  const index = key >>> 0;
  return index !== 0xffffffff && String(index) === key;
}

function requiredBundledEsmNamespace(value, source, loader, factoryEntry = undefined) {
  if (value == null || (typeof value !== "object" && typeof value !== "function")) {
    return { value, ordered: false };
  }
  const marker = Object.getOwnPropertyDescriptor(value, "__esModule");
  if (marker?.value !== true || marker.enumerable || marker.configurable || marker.writable ||
      sourceExportsEsmMarker(source, loader, factoryEntry)) {
    return { value, ordered: false };
  }

  const inputKeys = Reflect.ownKeys(value);
  const entries = [];
  let canConstructInOrder = true;
  for (const key of inputKeys) {
    if (key === "__esModule" || key === Symbol.toStringTag) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    entries.push([key, descriptor]);
    if (!descriptor || descriptor.enumerable !== true || typeof key !== "string" || isArrayIndexString(key)) {
      canConstructInOrder = false;
    }
  }

  let order = null;
  if (canConstructInOrder) {
    const cachedOrder = factoryEntry?.namespaceOrder;
    if (cachedOrder && sameOwnKeyShape(cachedOrder.inputKeys, inputKeys)) {
      order = cachedOrder.order;
    } else {
      order = entries.map((_entry, index) => index);
      order.sort((left, right) => {
        const leftKey = entries[left][0];
        const rightKey = entries[right][0];
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
      if (factoryEntry) factoryEntry.namespaceOrder = { inputKeys, order };
    }
  } else if (factoryEntry) {
    // Integer-index names need a true namespace exotic object (or a stable
    // Proxy created before cycles can observe it). Preserve the existing
    // finalization path for those and for other unusual generated surfaces.
    factoryEntry.namespaceOrder = null;
  }

  const namespace = createModuleNamespace();
  const defineOrder = order ?? entries.map((_entry, index) => index);
  for (const index of defineOrder) {
    const [key, descriptor] = entries[index];
    if (descriptor) Object.defineProperty(namespace, key, descriptor);
  }
  moduleNamespaceEsmMarkers.set(namespace, true);
  return { value: namespace, ordered: order !== null };
}

function namespaceFromCommonJs(value, packageTypeModule = false, additionalNames = []) {
  const namespace = createModuleNamespace();
  Object.defineProperty(namespace, "default", {
    configurable: true,
    enumerable: true,
    get: () => (
      !packageTypeModule &&
      value &&
      (typeof value === "object" || typeof value === "function") &&
      value.__esModule === true &&
      Object.hasOwn(value, "default")
    ) ? value.default : value,
  });
  if (value && (typeof value === "object" || typeof value === "function")) {
    for (const key of new IntrinsicSet([...Object.keys(value), ...additionalNames])) {
      if (key !== "default" && (packageTypeModule || key !== "__esModule")) {
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

function namespaceFromBuiltin(name, value) {
  const registeredNamespace = builtinImportNamespaces.get(String(name));
  if (registeredNamespace !== undefined) return registeredNamespace;
  const unwrapped = unwrapBuiltin(value);
  // Namespace identity is fixed when a builtin is registered. Inspecting the
  // live value here would misclassify CommonJS-style builtins after user code
  // assigns an ordinary `.default` property to them.
  if (builtinNamespaceEntries.has(String(name))) return unwrapped;
  // ESM runtime modules (e.g. node/tls.js) are loaded as real module
  // namespaces whose property descriptors must be preserved (non-configurable
  // getters, throwing setters, etc.).  Wrapping them in namespaceFromCommonJs
  // would flatten every descriptor to a configurable getter, breaking
  // immutability contracts like tls.rootCertificates.
  if (unwrapped != null &&
      (typeof unwrapped === "object" || typeof unwrapped === "function") &&
      unwrapped[Symbol.toStringTag] === "Module") {
    return unwrapped;
  }
  const namespace = namespaceFromCommonJs(unwrapped);
  // bun/index.js exports the global Bun object both as its default and as the
  // named `Bun` binding. The builtin registry intentionally stores the plain
  // object so require("bun") retains Bun's identity; restore the ESM-only
  // alias on the synthetic namespace without adding a Bun.Bun property.
  if (String(name) === "bun") {
    Object.defineProperty(namespace, "Bun", {
      configurable: true,
      enumerable: true,
      get: () => unwrapped,
    });
  }
  return namespace;
}

function importedBindingEntries(names) {
  return String(names)
    .split(",")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const pieces = part.split(/\s+as\s+/);
      return {
        imported: pieces[0].trim(),
        local: (pieces[1] ?? pieces[0]).trim(),
      };
    });
}

function rewriteImportedExportClauses(source, importedBindings) {
  if (Object.keys(importedBindings).length === 0) return source;
  return replaceCodePattern(
    source,
    /\bexport\s*\{([^}]*)\}\s*(from\s*['"][^'"]+['"])?\s*;?/g,
    (statement, names, fromClause) => {
      if (fromClause) return statement;
      const retained = [];
      const liveExports = [];
      for (const part of String(names).split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const pieces = trimmed.split(/\s+as\s+/);
        const local = pieces[0].trim();
        const exported = (pieces[1] ?? pieces[0]).trim();
        const expression = importedBindings[local];
        if (expression === undefined) {
          retained.push(trimmed);
          continue;
        }
        liveExports.push(
          `Object.defineProperty(${ESM_EXPORTS_BINDING}, ${JSON.stringify(exported)}, ` +
          `{ configurable: true, enumerable: true, get: () => ${expression} });`,
        );
      }
      if (retained.length > 0) liveExports.push(`export { ${retained.join(", ")} };`);
      return liveExports.join(" ");
    },
  );
}

function staticImportCall(specifier, asyncStaticImports, attributeKeyword, attributes) {
  const options = attributeKeyword && attributes ? `, { ${attributeKeyword}: ${attributes} }` : "";
  return `${asyncStaticImports ? "await " : ""}__ctStaticImport(${specifier}${options})`;
}

// Single line (no trailing newline) so prepending it does not shift line
// numbers of the transformed module source.
const staticImportHelperSource = `const __ctStaticImport = (spec) => { const value = require(spec); const builtinMap = globalThis.__cottontailBuiltinModules; const registeredNamespace = builtinMap?.[Symbol.for("cottontail.node.builtinImportNamespaces")]?.get(String(spec)); if (registeredNamespace !== undefined && builtinMap.get(String(spec)) === value) return registeredNamespace; if (value && (typeof value === "object" || typeof value === "function") && value[Symbol.toStringTag] === "Module") return value; const ns = { default: value }; if (value && (typeof value === "object" || typeof value === "function")) { for (const key of Object.keys(value)) { if (key !== "default") ns[key] = value[key]; } if (value.__esModule && Object.hasOwn(value, "default")) ns.default = value.default; } return ns; }; const __ctDynamicImport = async (spec, options) => globalThis.__cottontailImportModule(String(spec), (typeof __ctImportMeta === "object" && __ctImportMeta && __ctImportMeta.path) || undefined, options); const __ctAwaitedDynamicImport = __ctDynamicImport; `;
const asyncStaticImportHelperSource = `const __ctDynamicImport = (spec, options) => ${ESM_PROMISE_RESOLVE_BINDING}(globalThis.__cottontailImportModule(String(spec), (typeof __ctImportMeta === "object" && __ctImportMeta && __ctImportMeta.path) || undefined, options, true, __ctModuleAncestors, false)); const __ctAwaitedDynamicImport = (spec, options) => ${ESM_PROMISE_RESOLVE_BINDING}(globalThis.__cottontailImportModule(String(spec), (typeof __ctImportMeta === "object" && __ctImportMeta && __ctImportMeta.path) || undefined, options, true, __ctModuleAncestors, true)); const __ctStaticImport = (spec, options) => globalThis.__cottontailImportModule(String(spec), (typeof __ctImportMeta === "object" && __ctImportMeta && __ctImportMeta.path) || undefined, options, true, new ${ESM_SET_BINDING}(__ctModuleAncestors), true); `;
const esmExportDeclarationTrivia = String.raw`((?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\r\n]*(?:\r?\n|$))*)`;

function esmExportDeclarationPattern(declaration) {
  return new RegExp(String.raw`\bexport\b${esmExportDeclarationTrivia}${declaration}`, "g");
}

function liveExportStatement(exported, expression) {
  return `Object.defineProperty(${ESM_EXPORTS_BINDING}, ${JSON.stringify(exported)}, ` +
    `{ configurable: true, enumerable: true, get: () => ${expression} });`;
}

// The `export const/let/var` handlers below match a single declarator with a
// regex, which only sees the first binding of a multi-declarator statement
// (`export const a = 1, b = 2`). Given the index just past the first
// declarator's `=`, scan the remaining comma-separated declarators and return
// every additional bound name (simple identifiers and destructuring patterns).
// The scan biases toward stopping (ASI at a top-level newline, or a top-level
// `;`) so declarators that belong to a following statement are never captured.
function collectTrailingExportBindingNames(text, start) {
  const names = [];
  const len = text.length;
  const mask = codePositionMask(text);
  const identStart = /[A-Za-z_$-￿]/;
  const identPart = /[\w$-￿]/;
  const identRe = /^[A-Za-z_$-￿][\w$-￿]*$/;
  const isCode = (i) => mask[i] === 1;
  const skipTrivia = (i) => {
    while (i < len && (!isCode(i) || /\s/.test(text[i]))) i += 1;
    return i;
  };
  const addPatternNames = (patternText) => {
    for (const part of codeOnlyText(patternText).split(",")) {
      const name = part.trim().replace(/^\.\.\./, "").split(/\s*:\s*|\s*=\s*/).at(-1)?.trim();
      if (identRe.test(name ?? "")) names.push(name);
    }
  };
  // Skip an initializer until the next top-level `,` (another declarator) or a
  // statement boundary (`;`, an unbalanced closer, a top-level newline, EOF).
  const skipInitializer = (i) => {
    let depth = 0;
    while (i < len) {
      const c = text[i];
      if (isCode(i)) {
        if (c === "(" || c === "[" || c === "{") depth += 1;
        else if (c === ")" || c === "]" || c === "}") { if (depth === 0) return { i, more: false }; depth -= 1; }
        else if (depth === 0 && c === ",") return { i, more: true };
        else if (depth === 0 && c === ";") return { i, more: false };
        else if (depth === 0 && (c === "\n" || c === "\r")) return { i, more: false };
      } else if (depth === 0 && (c === "\n" || c === "\r")) {
        return { i, more: false };
      }
      i += 1;
    }
    return { i, more: false };
  };
  let i = start;
  while (true) {
    const boundary = skipInitializer(i);
    if (!boundary.more) break;
    i = skipTrivia(boundary.i + 1);
    if (i >= len) break;
    const ch = text[i];
    if (isCode(i) && (ch === "{" || ch === "[")) {
      let depth = 0;
      let j = i;
      for (; j < len; j += 1) {
        if (!isCode(j)) continue;
        const c = text[j];
        if (c === "{" || c === "[" || c === "(") depth += 1;
        else if (c === "}" || c === "]" || c === ")") { depth -= 1; if (depth === 0) { j += 1; break; } }
      }
      addPatternNames(text.slice(i + 1, j - 1));
      i = skipTrivia(j);
    } else if (isCode(i) && identStart.test(ch)) {
      let j = i;
      while (j < len && identPart.test(text[j])) j += 1;
      names.push(text.slice(i, j));
      i = skipTrivia(j);
    } else {
      break;
    }
    if (i < len && isCode(i) && text[i] === "=") {
      i += 1; // consume `=`; the next iteration skips its initializer
      continue;
    }
    // A declarator without an initializer: continue past the comma (if any).
    if (i < len && isCode(i) && text[i] === ",") continue;
    break;
  }
  return names;
}

function transformEsmSourceForDynamicImport(source, asyncStaticImports = false) {
  const liveExportDeclarations = [];
  // Import declarations are hoisted to the top of the transformed output
  // (matching ESM semantics, where imports are initialized before any module
  // code runs, even when the import statement appears at the bottom).
  // Entries are {offset, text}; offset is the match's position in the source
  // string *as it stood when that entry's regex pass ran*. Each pass below
  // handles a different import syntax shape (default+namespace, namespace,
  // default+named, named, default, side-effect-only) and runs in that fixed
  // order regardless of where those shapes actually appear in the source, so
  // pushing plain strings here would order declarations by *syntax kind*
  // instead of source position (e.g. a later `import {a} from "b"` would be
  // hoisted ahead of an earlier `import "c"` side-effect import, running "b"
  // before "c" even though ESM must evaluate them in source order). A pass
  // only ever removes text it matches, which shifts later offsets down but
  // never earlier ones, so comparing these offsets after every pass has run
  // still recovers the true source order. Sorting by offset before emitting
  // restores that order.
  const importDeclarations = [];
  const importedBindings = Object.create(null);
  let importNamespaceIndex = 0;
  const importNamespace = (spec, attributeKeyword, attributes, offset) => {
    const name = `__cottontailImportNamespace${importNamespaceIndex++}`;
    importDeclarations.push({
      offset,
      text: `const ${name} = ${staticImportCall(spec, asyncStaticImports, attributeKeyword, attributes)};`,
    });
    return name;
  };
  const liveImportedBinding = (namespace, imported) => {
    const name = String(imported).replace(/^(['"])(.*)\1$/, "$2");
    return `${namespace}[${JSON.stringify(name)}]`;
  };
  let output = replaceCodePattern(source, /\bimport\.meta\b/g, "__ctImportMeta");
  // Keep imported bindings live across cyclic ESM graphs. Capturing them with
  // destructuring snapshots an incompletely initialized namespace; Svelte's
  // compiler graph, for example, intentionally closes a cycle between its
  // node constructors and map_children module.
  output = replaceCodePattern(output,
    /\bimport\s+([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*,\s*\*\s*as\s+([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s+from\s*(['"][^'"]+['"])(?:\s+(with|assert)\s*(\{[^}]*\}))?\s*;?/g,
    (_all, def, name, spec, attributeKeyword, attributes, offset) => {
      const namespace = importNamespace(spec, attributeKeyword, attributes, offset);
      importedBindings[def] = liveImportedBinding(namespace, "default");
      importedBindings[name] = namespace;
      return ";";
    },
  );
  output = replaceCodePattern(output,
    /\bimport\s*\*\s*as\s+([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s+from\s*(['"][^'"]+['"])(?:\s+(with|assert)\s*(\{[^}]*\}))?\s*;?/g,
    (_all, name, spec, attributeKeyword, attributes, offset) => {
      importedBindings[name] = importNamespace(spec, attributeKeyword, attributes, offset);
      return ";";
    },
  );
  output = replaceCodePattern(output,
    /\bimport\s+([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*,\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"])(?:\s+(with|assert)\s*(\{[^}]*\}))?\s*;?/g,
    (_all, def, names, spec, attributeKeyword, attributes, offset) => {
      const namespace = importNamespace(spec, attributeKeyword, attributes, offset);
      importedBindings[def] = liveImportedBinding(namespace, "default");
      for (const binding of importedBindingEntries(names)) {
        importedBindings[binding.local] = liveImportedBinding(namespace, binding.imported);
      }
      return ";";
    },
  );
  output = replaceCodePattern(output,
    /\bimport\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"])(?:\s+(with|assert)\s*(\{[^}]*\}))?\s*;?/g,
    (_all, names, spec, attributeKeyword, attributes, offset) => {
      const namespace = importNamespace(spec, attributeKeyword, attributes, offset);
      for (const binding of importedBindingEntries(names)) {
        importedBindings[binding.local] = liveImportedBinding(namespace, binding.imported);
      }
      return ";";
    },
  );
  output = replaceCodePattern(output,
    /\bimport\s+([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s+from\s*(['"][^'"]+['"])(?:\s+(with|assert)\s*(\{[^}]*\}))?\s*;?/g,
    (_all, def, spec, attributeKeyword, attributes, offset) => {
      const namespace = importNamespace(spec, attributeKeyword, attributes, offset);
      importedBindings[def] = liveImportedBinding(namespace, "default");
      return ";";
    },
  );
  output = replaceCodePattern(output, /\bimport\s*(['"][^'"]+['"])(?:\s+(with|assert)\s*(\{[^}]*\}))?\s*;?/g, (_all, spec, attributeKeyword, attributes, offset) => {
    importDeclarations.push({
      offset,
      text: `${staticImportCall(spec, asyncStaticImports, attributeKeyword, attributes)};`,
    });
    return ";";
  });
  output = rewriteImportedExportClauses(output, importedBindings);
  // Dynamic import() cannot execute inside new Function()-compiled code for
  // formats JSC's own loader cannot parse (e.g. TypeScript); route it through
  // the runtime module loader, which also consults the CommonJS cache.
  output = replaceDynamicImportExpressions(output);
  // Re-exports must be rewritten before the plain `export { ... }` handler
  // below, which would otherwise leave a dangling `from "..."` clause behind.
  output = replaceCodePattern(output,
    /\bexport\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"])(?:\s+(with|assert)\s*(\{[^}]*\}))?\s*;?/g,
    (_all, names, spec, attributeKeyword, attributes) => {
      const statements = [];
      const namespace = `__cottontailReExportNamespace${importNamespaceIndex++}`;
      statements.push(`{ const ${namespace} = ${staticImportCall(spec, asyncStaticImports, attributeKeyword, attributes)};`);
      for (const part of String(names).split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const pieces = trimmed.split(/\s+as\s+/);
        const local = pieces[0].trim();
        const exported = (pieces[1] ?? pieces[0]).trim();
        statements.push(liveExportStatement(exported, `${namespace}[${JSON.stringify(local)}]`));
      }
      statements.push("}");
      return statements.join(" ");
    },
  );
  output = replaceCodePattern(output,
    /\bexport\s*\*\s*as\s+([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s+from\s*(['"][^'"]+['"])(?:\s+(with|assert)\s*(\{[^}]*\}))?\s*;?/g,
    (_all, name, spec, attributeKeyword, attributes) => {
      const namespace = `__cottontailReExportNamespace${importNamespaceIndex++}`;
      return `{ const ${namespace} = ${staticImportCall(spec, asyncStaticImports, attributeKeyword, attributes)}; ${liveExportStatement(name, namespace)} }`;
    },
  );
  output = replaceCodePattern(output,
    /\bexport\s*\*\s*from\s*(['"][^'"]+['"])(?:\s+(with|assert)\s*(\{[^}]*\}))?\s*;?/g,
    (_all, spec, attributeKeyword, attributes) => `{ const __ctNs = ${staticImportCall(spec, asyncStaticImports, attributeKeyword, attributes)}; for (const __ctKey of Object.keys(__ctNs)) { if (__ctKey !== "default") Object.defineProperty(${ESM_EXPORTS_BINDING}, __ctKey, { configurable: true, enumerable: true, get: () => __ctNs[__ctKey] }); } }`,
  );
  output = replaceCodePattern(output, esmExportDeclarationPattern(String.raw`default\s+async\s+function\s*(\*?)\s*([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*\(`), (_all, trivia, star, name) => {
    liveExportDeclarations.push(liveExportStatement("default", name));
    return `${trivia}async function ${star}${name}(`;
  });
  output = replaceCodePattern(output, esmExportDeclarationPattern(String.raw`default\s+function\s*(\*?)\s*([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*\(`), (_all, trivia, star, name) => {
    liveExportDeclarations.push(liveExportStatement("default", name));
    return `${trivia}function ${star}${name}(`;
  });
  output = replaceCodePattern(output, esmExportDeclarationPattern(String.raw`default\s+class\s+([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*`), (_all, trivia, name) => {
    liveExportDeclarations.push(liveExportStatement("default", name));
    return `${trivia}class ${name} `;
  });
  output = replaceCodePattern(output, esmExportDeclarationPattern(String.raw`default\b`), (_all, trivia) => {
    return `${trivia}${ESM_EXPORTS_BINDING}.default =`;
  });
  output = replaceCodePattern(output, esmExportDeclarationPattern(String.raw`(const|let|var)\s+\{([^}]*)\}\s*=`), (_all, trivia, kind, bindings, offset, string) => {
    for (const part of codeOnlyText(bindings).split(",")) {
      const name = part.trim().replace(/^\.\.\./, "").split(/\s*:\s*|\s*=\s*/, 2).at(-1)?.trim();
      if (/^[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*$/.test(name ?? "")) {
        liveExportDeclarations.push(liveExportStatement(name, name));
      }
    }
    for (const name of collectTrailingExportBindingNames(string, offset + _all.length)) {
      liveExportDeclarations.push(liveExportStatement(name, name));
    }
    return `${trivia}${kind} {${bindings}} =`;
  });
  output = replaceCodePattern(output, esmExportDeclarationPattern(String.raw`(const|let|var)\s+([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*=`), (_all, trivia, kind, name, offset, string) => {
    liveExportDeclarations.push(liveExportStatement(name, name));
    for (const trailing of collectTrailingExportBindingNames(string, offset + _all.length)) {
      liveExportDeclarations.push(liveExportStatement(trailing, trailing));
    }
    return `${trivia}${kind} ${name} =`;
  });
  // Declarations without initializer (e.g. the `export var ns;` emitted for
  // TypeScript namespaces by the type stripper).
  output = replaceCodePattern(output, esmExportDeclarationPattern(String.raw`(let|var)\s+([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*;`), (_all, trivia, kind, name) => {
    liveExportDeclarations.push(liveExportStatement(name, name));
    return `${trivia}${kind} ${name};`;
  });
  output = replaceCodePattern(output, esmExportDeclarationPattern(String.raw`async\s+function\s*(\*?)\s*([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*\(`), (_all, trivia, star, name) => {
    liveExportDeclarations.push(liveExportStatement(name, name));
    return `${trivia}async function ${star}${name}(`;
  });
  output = replaceCodePattern(output, esmExportDeclarationPattern(String.raw`function\s*(\*?)\s*([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*\(`), (_all, trivia, star, name) => {
    liveExportDeclarations.push(liveExportStatement(name, name));
    return `${trivia}function ${star}${name}(`;
  });
  output = replaceCodePattern(output, esmExportDeclarationPattern(String.raw`class\s+([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*`), (_all, trivia, name) => {
    liveExportDeclarations.push(liveExportStatement(name, name));
    return `${trivia}class ${name} `;
  });
  output = replaceCodePattern(output, /\bexport\s*\{([^}]*)\}\s*;?/g, (_all, names) => {
    for (const part of String(names).split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const pieces = trimmed.split(/\s+as\s+/);
      const local = pieces[0].trim();
      const exported = (pieces[1] ?? pieces[0]).trim();
      if (exported === '"module.exports"' || exported === "'module.exports'") {
        if (/^[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*$/.test(local)) {
          liveExportDeclarations.push(liveExportStatement("module.exports", local));
        }
        continue;
      }
      if (/^[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*$/.test(local) && /^[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*$/.test(exported)) {
        liveExportDeclarations.push(liveExportStatement(exported, local));
      }
    }
    return "";
  });
  const helperSource = asyncStaticImports ? asyncStaticImportHelperSource : staticImportHelperSource;
  const exportDeclarations = liveExportDeclarations.join(" ");
  // Restore true source order (see the comment on importDeclarations above)
  // before emitting: each regex pass above records the offset it observed at
  // the time it matched, and an earlier pass's offset is always <= a later
  // pass's offset for content that was earlier in the original source.
  const orderedImportDeclarations = importDeclarations
    .slice()
    .sort((a, b) => a.offset - b.offset)
    .map((entry) => entry.text);
  const bindingEntries = Object.entries(importedBindings);
  if (bindingEntries.length === 0) {
    return `${helperSource}${orderedImportDeclarations.join(" ")}${exportDeclarations}${output}`;
  }
  const bindingScope = "__cottontailImportedBindings";
  const bindingDeclarations = bindingEntries.map(([local, expression]) =>
    `Object.defineProperty(${bindingScope}, ${JSON.stringify(local)}, { ` +
    `enumerable: true, get: () => ${expression}, ` +
    `set() { throw new TypeError(${JSON.stringify(`Cannot assign to import '${local}'`)}); } });`
  );
  // A with-environment gives imported names live reads without compiling every
  // dependency a second time. Lexical declarations and function parameters
  // inside the module remain inner scopes and therefore shadow imports exactly
  // where ordinary ESM bindings do.
  //
  // The module body is followed by the `with` block's closing brace. Modules
  // whose last line is a `//` line comment with no trailing newline (e.g. a
  // `//# sourceMappingURL=` pragma) would otherwise swallow that brace into the
  // comment, unbalancing the wrapper; a newline before the brace keeps it on
  // its own line.
  return `${helperSource}const ${bindingScope} = Object.create(null);` +
    `${orderedImportDeclarations.join(" ")}${bindingDeclarations.join(" ")}` +
    `with (${bindingScope}) { ${exportDeclarations}${output}\n}`;
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

function isAsyncModuleRequireError(error) {
  return /^require\(\) async module .* is unsupported\. use "await import\(\)" instead\.$/
    .test(String(error?.message ?? error));
}

const asyncEsmModuleCache = new Map();
const dynamicEsmFactoryCache = new Map();
const asyncDynamicEsmFactoryCache = new Map();
const registeredSelfEsmNamespacesKey = Symbol.for("cottontail.registeredSelfEsmNamespaces");
const registeredSelfEsmNamespaces = globalThis[registeredSelfEsmNamespacesKey] ??= new Map();
const asyncEsmEvaluationContextKey = Symbol("cottontail.asyncEsmEvaluationContext");
const asyncEsmEvaluationContexts = new WeakMap();

function drainAsyncEsmEvaluationChildren(context) {
  const pending = context.pending;
  context.pending = [];
  for (const start of pending) start();
}

function releaseAsyncEsmEvaluationChildren(context) {
  if (context.released) return;
  context.released = true;
  drainAsyncEsmEvaluationChildren(context);
}

function scheduleAsyncEsmEvaluationRelease(context) {
  if (context.released || context.releaseScheduled) return;
  context.releaseScheduled = true;
  intrinsicQueueMicrotask(() => {
    // The public normalization facade settles in the first reaction. Give
    // the import expression's own async adoption job one checkpoint to settle
    // its visible promise before releasing nested children.
    intrinsicQueueMicrotask(() => {
      context.releaseScheduled = false;
      if (context.settled && context.publicConsumers === 0) {
        releaseAsyncEsmEvaluationChildren(context);
      }
    });
  });
}

function scheduleAsyncEsmEvaluation(parentAncestors, start) {
  const parentContext = parentAncestors?.[asyncEsmEvaluationContextKey];
  if (parentContext != null && !parentContext.released) {
    parentContext.pending.push(start);
    if (!parentContext.checkpointScheduled) {
      parentContext.checkpointScheduled = true;
      intrinsicQueueMicrotask(() => {
        parentContext.checkpointScheduled = false;
        // The importing module suspended after requesting this child. Start
        // it now so top-level `await import()` can make progress. If the
        // parent completed in the same job, its evaluation reaction releases
        // the child after settling the parent's public promise instead.
        if (!parentContext.completed) drainAsyncEsmEvaluationChildren(parentContext);
      });
    }
    return;
  }
  start();
}

function scheduleAsyncModuleImport(parentAncestors, load) {
  const parentContext = parentAncestors?.[asyncEsmEvaluationContextKey];
  if (parentContext == null || parentContext.released) return load();

  let resolveImport;
  let rejectImport;
  const promise = new IntrinsicPromise((resolve, reject) => {
    resolveImport = resolve;
    rejectImport = reject;
  });
  scheduleAsyncEsmEvaluation(parentAncestors, () => {
    try {
      resolveImport(load());
    } catch (error) {
      rejectImport(safelyNormalizeDynamicImportError(error));
    }
  });
  return promise;
}

function normalizedDynamicImportPromise(result) {
  const promise = intrinsicPromiseResolve(result);
  const context = asyncEsmEvaluationContexts.get(promise);
  let resolvePublic;
  let rejectPublic;
  const publicPromise = new IntrinsicPromise((resolve, reject) => {
    resolvePublic = resolve;
    rejectPublic = reject;
  });
  if (context != null) context.publicConsumers += 1;
  promise.then(
    value => {
      resolvePublic(value);
      if (context != null) {
        context.publicConsumers -= 1;
        scheduleAsyncEsmEvaluationRelease(context);
      }
    },
    error => {
      rejectPublic(safelyNormalizeDynamicImportError(error));
      if (context != null) {
        context.publicConsumers -= 1;
        scheduleAsyncEsmEvaluationRelease(context);
      }
    },
  );
  return publicPromise;
}

function settleAsyncEsmRecord(record) {
  record.settled = true;
  const ancestors = record.moduleAncestors;
  if (ancestors != null) {
    try { delete ancestors[asyncEsmEvaluationContextKey]; } catch {}
  }
  record.moduleAncestors = null;
}

// User code (bun:test fixtures in particular) can invalidate the dynamic
// import() cache directly via `Loader.registry.delete(key)`. That native Map
// is the source of truth for import() dedup, but this runtime also keeps its
// own evaluated-module caches (commonJsCache and asyncEsmModuleCache)
// populated by the fast paths in executeDynamicImportSource/loadCommonJsModule.
// Deleting only from Loader.registry left those stale, so re-importing the same
// resolved path (e.g. the bare specifier after previously importing it with a
// `?query` suffix, or vice versa) served an already-evaluated module instead of
// re-executing it. Keep the compiled factory caches: their entries compare the
// complete current source before reuse, and throwing them away makes cache
// churn re-transform and recompile unchanged modules. `globalThis.Loader` does
// not exist yet while this module evaluates (it's installed later by the native
// bootstrap), so the patch is applied lazily and idempotently the first time
// it's needed.
let loaderRegistryPatched = false;
function ensureLoaderRegistryPatched() {
  if (loaderRegistryPatched) return;
  const nativeRegistry = globalThis.Loader?.registry;
  if (!nativeRegistry || typeof nativeRegistry.delete !== "function") return;
  loaderRegistryPatched = true;
  const nativeDelete = nativeRegistry.delete.bind(nativeRegistry);
  const nativeClear = typeof nativeRegistry.clear === "function"
    ? nativeRegistry.clear.bind(nativeRegistry)
    : null;
  nativeRegistry.delete = function cottontailLoaderRegistryDelete(key) {
    commonJsCache.delete(key);
    asyncEsmModuleCache.delete(key);
    registeredSelfEsmNamespaces.delete(key);
    return nativeDelete(key);
  };
  if (nativeClear != null) {
    nativeRegistry.clear = function cottontailLoaderRegistryClear() {
      // Retain source-validated compiled factories, but discard every
      // evaluated import record represented by the native registry.
      if (typeof nativeRegistry.keys === "function") {
        for (const key of nativeRegistry.keys()) {
          commonJsCache.delete(key);
          asyncEsmModuleCache.delete(key);
        }
      }
      for (const [key, module] of commonJsCache) {
        if (module?.[dynamicImportModuleKey] === true) commonJsCache.delete(key);
      }
      asyncEsmModuleCache.clear();
      registeredSelfEsmNamespaces.clear();
      return nativeClear();
    };
  }
}

// Entrypoints and test files execute from a generated .cottontail-compat-*
// sibling whose import.meta still reports the original path (via the
// base64 original-path marker). A dynamic self-import therefore resolves the
// original path, which is not the cache key the module is evaluating under —
// without this alias the self-import re-evaluates the module instead of
// returning the in-flight namespace (ESM cyclic semantics). The generated
// wrapper calls this once, at the top of its own evaluation, with a
// getter-backed namespace over its exported bindings.
globalThis.__cottontailRegisterSelfModuleNamespace = (resolvedPath, namespace) => {
  const key = String(resolvedPath);
  const keys = new IntrinsicSet([key]);
  try {
    const real = cottontail.realpathSync(key);
    if (typeof real === "string" && real.length > 0) keys.add(real);
  } catch {}
  const promise = intrinsicPromiseResolve(namespace);
  for (const alias of keys) {
    registeredSelfEsmNamespaces.set(alias, namespace);
    const existing = asyncEsmModuleCache.get(alias);
    if (existing != null) {
      // The native linker's getter-backed namespace is authoritative for the
      // entry alias even if the launcher installed a provisional record.
      existing.namespace = namespace;
      existing.allowSynchronousRequire = true;
    } else {
      asyncEsmModuleCache.set(alias, {
        namespace,
        promise,
        // The generated entry is already executing under the native linker.
        // A same-file require() must share that live namespace rather than try
        // to synchronously evaluate its top-level-await source a second time.
        allowSynchronousRequire: true,
      });
    }
  }
  const registry = globalThis.Loader?.registry;
  // Overwrite, don't set-if-absent: the bundled dynamic-import helper
  // (`__esmDyn` in the bundler runtime) registers the entry's key with a
  // promise that only resolves once the entry finishes evaluating. A dynamic
  // self-import during evaluation must get this in-flight namespace instead,
  // or it deadlocks awaiting its own completion. This runs at the top of the
  // module's own evaluation, so it is the authoritative entry for the key.
  if (registry != null) {
    for (const alias of keys) registry.set(alias, promise);
  }
};
globalThis.__cottontailGetRegisteredSelfModuleNamespace = resolvedPath =>
  registeredSelfEsmNamespaces.get(String(resolvedPath));
globalThis.__cottontailImportRegisteredSelfModule = resolvedPath =>
  intrinsicPromiseResolve(registeredSelfEsmNamespaces.get(String(resolvedPath)));

function executeAsyncDynamicImportSource(
  resolved,
  resolvedPath,
  suffix,
  originalSource,
  ancestors = undefined,
  waitEdge = false,
) {
  const cacheKey = String(resolved);
  const sourceName = `${resolvedPath}${suffix}`;
  const cached = asyncEsmModuleCache.get(cacheKey);
  if (cached !== undefined) {
    // Deferred siblings can become cyclic before either begins evaluation.
    // If an evaluating cached module is newly reached from this import chain,
    // merge that chain into the Set its transformed helpers will carry. A
    // later back-edge can then observe the in-flight namespace instead of two
    // sibling promises waiting on one another forever.
    if (waitEdge && ancestors != null && cached.moduleAncestors != null && cached.settled === false) {
      for (const ancestor of ancestors) cached.moduleAncestors.add(ancestor);
    }
    // A module in this import chain's ancestry (across static AND dynamic
    // import edges — the transformed helpers thread __ctModuleAncestors
    // through both) is still evaluating; awaiting its completion promise
    // would deadlock, since it cannot finish until this import settles. Bun
    // resolves such cycles with the in-flight namespace (live partial
    // exports), so do the same. The fallback also covers legacy or externally
    // registered in-flight records whose completion promise is not installed.
    return waitEdge && ancestors?.has(cacheKey)
      ? cached.namespace
      : (cached.promise ?? cached.namespace);
  }
  const namespace = createModuleNamespace();
  let moduleAncestors = new IntrinsicSet(waitEdge ? (ancestors ?? []) : []);
  moduleAncestors.add(cacheKey);
  const evaluationContext = {
    pending: [],
    released: false,
    completed: false,
    checkpointScheduled: false,
    releaseScheduled: false,
    publicConsumers: 0,
    settled: false,
  };
  Object.defineProperty(moduleAncestors, asyncEsmEvaluationContextKey, {
    value: evaluationContext,
    configurable: true,
  });
  const record = {
    namespace,
    promise: null,
    moduleAncestors,
    evaluationContext,
    settled: false,
  };
  asyncEsmModuleCache.set(cacheKey, record);
  let run;
  let wrapperLineOffset;
  const cachedFactory = asyncDynamicEsmFactoryCache.get(cacheKey);
  if (cachedFactory?.source === originalSource) {
    run = cachedFactory.run;
    wrapperLineOffset = cachedFactory.wrapperLineOffset;
  } else {
    const transformed = transformEsmSourceForDynamicImport(
      maybeTransformRuntimeSyntax(resolvedPath, maybeStripTypeScript(resolvedPath, originalSource)),
      true,
    );
    maybeRegisterSourceMap(resolvedPath, transformed);
    recordCompileCache(resolvedPath, transformed);
    try {
      const evaluationSource = `with ({ require: ${ESM_REQUIRE_BINDING} }) { try { ${transformed}\n} finally { ${ESM_EVALUATION_COMPLETED_BINDING}(); } }`;
      ({ run, wrapperLineOffset } = compileAsyncModuleWrapper(
        [
          ESM_EXPORTS_BINDING,
          ESM_REQUIRE_BINDING,
          "__filename",
          "__dirname",
          "__ctImportMeta",
          "__ctModuleAncestors",
          "Error",
          ESM_EVALUATION_COMPLETED_BINDING,
          ESM_PROMISE_RESOLVE_BINDING,
          ESM_SET_BINDING,
        ],
        evaluationSource,
        sourceName,
        originalSource,
      ));
    } catch (error) {
      asyncEsmModuleCache.delete(cacheKey);
      throw error;
    }
    asyncDynamicEsmFactoryCache.set(cacheKey, { source: originalSource, run, wrapperLineOffset });
  }
  const normalizeEvaluationError = error => safelyNormalizeDynamicImportError(
    remapThrownModuleError(error, resolvedPath, wrapperLineOffset),
  );
  let resolveEvaluation;
  let rejectEvaluation;
  record.promise = new IntrinsicPromise((resolve, reject) => {
    resolveEvaluation = resolve;
    rejectEvaluation = reject;
  });
  asyncEsmEvaluationContexts.set(record.promise, evaluationContext);
  let started = false;
  const start = () => {
    if (started) return;
    started = true;

    let execution;
    try {
      execution = run(
        namespace,
        // An ES module's `require` resolves against its own path. Without this
        // binding the module falls through to the global require installed by the
        // generated launcher, whose base is the launcher artifact directory.
        createEsmRequire(hookRequireBase(resolvedPath), { exports: namespace }),
        resolvedPath,
        dirname(resolvedPath),
        importMetaForHookModule(resolvedPath, suffix),
        moduleAncestors,
        dynamicModuleErrorConstructor(sourceName, originalSource),
        () => { evaluationContext.completed = true; },
        intrinsicPromiseResolve,
        IntrinsicSet,
      );
    } catch (error) {
      settleAsyncEsmRecord(record);
      moduleAncestors = null;
      evaluationContext.settled = true;
      if (asyncEsmModuleCache.get(cacheKey) === record) asyncEsmModuleCache.delete(cacheKey);
      rejectEvaluation(normalizeEvaluationError(error));
      scheduleAsyncEsmEvaluationRelease(evaluationContext);
      return;
    }

    intrinsicPromiseResolve(execution).then(
      () => {
        try {
          const finalized = finalizeEsmNamespaceOrder(namespace);
          settleAsyncEsmRecord(record);
          moduleAncestors = null;
          evaluationContext.settled = true;
          resolveEvaluation(finalized);
        } catch (error) {
          settleAsyncEsmRecord(record);
          moduleAncestors = null;
          evaluationContext.settled = true;
          if (asyncEsmModuleCache.get(cacheKey) === record) asyncEsmModuleCache.delete(cacheKey);
          rejectEvaluation(safelyNormalizeDynamicImportError(error));
        }
        // Resolving the public evaluation promise enqueues all handlers that
        // were attached by the importing module. Queue child evaluation after
        // those handlers instead of guessing at a fixed number of Promise
        // reactions between the module record and import().
        scheduleAsyncEsmEvaluationRelease(evaluationContext);
      },
      error => {
        settleAsyncEsmRecord(record);
        moduleAncestors = null;
        evaluationContext.settled = true;
        if (asyncEsmModuleCache.get(cacheKey) === record) asyncEsmModuleCache.delete(cacheKey);
        rejectEvaluation(normalizeEvaluationError(error));
        scheduleAsyncEsmEvaluationRelease(evaluationContext);
      },
    );
  };

  scheduleAsyncEsmEvaluation(ancestors, start);
  return record.promise;
}

function executeDynamicImportSource(
  resolved,
  source,
  format,
  forceAsync = false,
  asyncAncestors = undefined,
  asyncWaitEdge = false,
) {
  const { bare: resolvedPath, suffix } = splitSpecifierSuffix(resolved);
  const sourceName = `${resolvedPath}${suffix}`;
  const sourceText = String(source ?? "").replace(/^#!/, "//");
  const effectiveFormat = format ?? formatForHookSource(resolvedPath, sourceText);
  const synchronousResult = load => forceAsync
    ? scheduleAsyncModuleImport(asyncAncestors, load)
    : load();
  if (effectiveFormat === "builtin") {
    return synchronousResult(() => namespaceFromBuiltin(resolvedPath, loadBuiltinOrReplacement(resolvedPath)));
  }
  if (effectiveFormat === "json" || String(resolvedPath).endsWith(".json")) {
    return synchronousResult(() => {
      const jsonSource = sourceText;
      try {
        return { default: JSON.parse(jsonSource) };
      } catch (error) {
        if (/(^|[\\/])package\.json$/.test(String(resolvedPath))) return { default: parseJSONC(jsonSource) };
        throw error;
      }
    });
  }
  if (effectiveFormat === "commonjs" || String(resolvedPath).endsWith(".cjs")) {
    return synchronousResult(() => namespaceFromCommonJs(executeHookSource(
      resolvedPath,
      replaceCodePattern(source, /\bimport\.meta\b/g, "__ctImportMeta"),
      "commonjs",
    ), packageTypeIsModule(resolvedPath)));
  }
  if (!suffix && isAbsolute(resolvedPath) && !isEmbeddedRuntimePath(resolvedPath) &&
      !isGeneratedRuntimeBundlePath(resolvedPath) && /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(resolvedPath) &&
      modulePathExists(resolvedPath) && hasEsmSyntax(sourceText)) {
    let fileSource;
    try { fileSource = readModuleFile(resolvedPath).replace(/^#!/, "//"); } catch {}
    // Hooks, plugins, and generated Bake/build inputs can deliberately reuse
    // an existing filename while supplying contents with a different loader.
    // Link only the actual file bytes here; scanning those virtual contents
    // with the filename-derived loader turns HTML or TypeScript into bogus JS
    // parse errors before their owning loader sees them.
    if (fileSource === sourceText) {
      const entryPath = globalThis.process?.argv?.[1];
      const directEntry = typeof entryPath === "string" && entryPath.length > 0 &&
        runtimeEsmGraphPathKey(resolvedPath) === runtimeEsmGraphPathKey(entryPath);
      validateRuntimeEsmLinkage(resolved, sourceText, runtimeEsmGraphLoader(resolvedPath), directEntry);
    }
  }
  if (!forceAsync &&
      isAbsolute(resolvedPath) &&
      modulePathExists(resolvedPath) &&
      !standaloneFileEntry(resolvedPath).found &&
      moduleHooks.length === 0 &&
      runtimePluginOnResolve.length === 0 &&
      runtimePluginOnLoad.length === 0) {
    const asyncGraph = runtimeAsyncEsmGraph(resolvedPath, sourceText);
    if (asyncGraph !== null) {
      return executeAsyncDynamicImportSource(
        resolved,
        resolvedPath,
        suffix,
        asyncGraph.source,
        asyncAncestors,
        asyncWaitEdge,
      );
    }
    runtimeEsmSourceExecutionDepth += 1;
    try {
      return loadCommonJsModule(resolved);
    } catch (error) {
      if (!isAsyncModuleRequireError(error)) throw error;
    } finally {
      runtimeEsmSourceExecutionDepth -= 1;
    }
    return executeAsyncDynamicImportSource(
      resolved,
      resolvedPath,
      suffix,
      sourceText,
      asyncAncestors,
      asyncWaitEdge,
    );
  }
  if (forceAsync) {
    return executeAsyncDynamicImportSource(
      resolved,
      resolvedPath,
      suffix,
      sourceText,
      asyncAncestors,
      asyncWaitEdge,
    );
  }
  const namespace = createModuleNamespace();
  const originalSource = sourceText;
  let run;
  const factoryCacheKey = String(resolved);
  const cachedFactory = dynamicEsmFactoryCache.get(factoryCacheKey);
  if (cachedFactory?.source === originalSource) {
    run = cachedFactory.run;
  } else {
    const transformed = transformEsmSourceForDynamicImport(maybeStripTypeScript(resolvedPath, originalSource));
    maybeRegisterSourceMap(resolvedPath, transformed);
    recordCompileCache(resolvedPath, transformed);
    try {
      run = compileModuleWrapper(
        [
          ESM_EXPORTS_BINDING,
          "require",
          "__ctModuleRecord",
          "__filename",
          "__dirname",
          "__ctImportMeta",
          "Error",
        ],
        transformed,
        sourceName,
        originalSource,
      );
    } catch (error) {
      // Dynamically imported ES modules may use top-level await (e.g. Bun.build
      // outputs re-imported via blob: URLs). Preserve synchronous evaluation for
      // ordinary modules and only retry syntax containing await asynchronously.
      if (!(error instanceof SyntaxError) || !/(?<![.\w$])await\b/.test(transformed)) throw error;
      return executeAsyncDynamicImportSource(
        resolved,
        resolvedPath,
        suffix,
        originalSource,
        asyncAncestors,
        asyncWaitEdge,
      );
    }
    dynamicEsmFactoryCache.set(factoryCacheKey, { source: originalSource, run });
  }
  try {
    const moduleRecord = { exports: namespace };
    run(
      namespace,
      createEsmRequire(hookRequireBase(resolvedPath), moduleRecord),
      moduleRecord,
      resolvedPath,
      dirname(resolvedPath),
      importMetaForHookModule(resolvedPath, suffix),
      dynamicModuleErrorConstructor(sourceName, originalSource),
    );
  } catch (error) {
    if (!isAsyncModuleRequireError(error)) throw error;
    return executeAsyncDynamicImportSource(
      resolved,
      resolvedPath,
      suffix,
      originalSource,
      asyncAncestors,
      asyncWaitEdge,
    );
  }
  return finalizeEsmNamespaceOrder(namespace);
}

function importResolvedRuntimeModule(
  resolved,
  options = undefined,
  forceAsync = false,
  asyncAncestors = undefined,
  asyncWaitEdge = false,
) {
  const synchronousResult = load => forceAsync
    ? scheduleAsyncModuleImport(asyncAncestors, load)
    : load();
  const cachedPluginModule = commonJsCache.get(resolved);
  if (cachedPluginModule && Object.hasOwn(cachedPluginModule, "__cottontailPluginNamespace")) {
    return synchronousResult(() => cachedPluginModule.__cottontailPluginNamespace);
  }
  if (cachedPluginModule?.[runtimeEsmSourceModuleKey] === true) {
    return synchronousResult(() => cachedPluginModule.exports);
  }
  const loader = options?.with?.type ?? options?.assert?.type ?? options?.type;
  const resolvedPath = splitSpecifierSuffix(resolved).bare;
  if (loader === "text") {
    return synchronousResult(() => ({ default: readModuleFile(resolvedPath) }));
  }
  if (loader === "file") {
    return synchronousResult(() => ({ default: resolvedPath }));
  }
  if (loader === "sqlite" || loader === "sqlite_embedded") {
    return synchronousResult(() => {
      const sqliteModule = loadBuiltinOrReplacement("bun:sqlite");
      const Database = sqliteModule?.Database ?? sqliteModule?.default;
      const embedded = standaloneFileEntry(resolvedPath);
      const db = new Database(embedded.found ? standaloneFileBytes(embedded.value) : resolvedPath);
      return { db, default: db, __esModule: true };
    });
  }
  const resolvedMock = bunModuleMockFor(resolved);
  if (resolvedMock.found) return synchronousResult(() => namespaceFromCommonJs(resolvedMock.value));
  const resolvedByHook = hookResolvedFormats.has(resolved);
  const loadResult = runLoadHooks(resolved);
  if (loadResult !== undefined) {
    return executeDynamicImportSource(
      resolved,
      loadResult.source,
      loadResult.format,
      forceAsync,
      asyncAncestors,
      asyncWaitEdge,
    );
  }
  if (builtinModuleMap.has(resolved) || hasRuntimePackageReplacement(resolved)) {
    return synchronousResult(() => namespaceFromBuiltin(resolved, loadBuiltinOrReplacement(resolved)));
  }
  if (/\.html?$/i.test(resolvedPath)) {
    return synchronousResult(() => ({ default: { index: resolvedPath, files: null } }));
  }
  const embedded = standaloneFileEntry(resolvedPath);
  if (embedded.found && hasEsmSyntax(embedded.value)) {
    return executeDynamicImportSource(
      resolved,
      embedded.value,
      "module",
      forceAsync,
      asyncAncestors,
      asyncWaitEdge,
    );
  }
  const resolvedFormat = resolvedByHook ? hookResolvedFormats.get(resolved) : formatForResolved(resolved);
  if (resolvedFormat === "commonjs") {
    let source;
    if (/\.(?:js|jsx|ts|tsx)$/i.test(resolvedPath)) {
      source = embedded.found ? embedded.value : readModuleFile(resolvedPath);
      if (hasEsmSyntax(source)) {
        return executeDynamicImportSource(
          resolved,
          source,
          "module",
          forceAsync,
          asyncAncestors,
          asyncWaitEdge,
        );
      }
    }
    if (forceAsync && source !== undefined && sourceRequiresAsyncModuleExecution(resolvedPath, source)) {
      return executeDynamicImportSource(
        resolved,
        source,
        "module",
        true,
        asyncAncestors,
        asyncWaitEdge,
      );
    }
    const load = () => {
      const value = loadCommonJsModule(resolved);
      const loadedModule = commonJsCache.get(resolved);
      if (loadedModule) loadedModule[dynamicImportModuleKey] = true;
      return namespaceFromCommonJs(value, packageTypeIsModule(resolvedPath));
    };
    // A dynamic import of a source file without ESM syntax takes this
    // synchronous CommonJS path. Defer its evaluation with the same parent
    // context used by async ESM records so its side effects do not overtake
    // completion handlers for the importing module.
    return synchronousResult(load);
  }
  return executeDynamicImportSource(
    resolved,
    readModuleFile(resolvedPath),
    resolvedFormat,
    forceAsync,
    asyncAncestors,
    asyncWaitEdge,
  );
}

export function __importModule(
  specifier,
  referrer = undefined,
  options = undefined,
  forceAsync = false,
  asyncAncestors = undefined,
  asyncWaitEdge = false,
) {
  ensureLoaderRegistryPatched();
  const directMock = bunModuleMockFor(specifier);
  if (directMock.found) {
    if (directMock.value && typeof directMock.value.then === "function") {
      return intrinsicPromiseResolve(directMock.value).then(namespaceFromCommonJs);
    }
    const load = () => namespaceFromCommonJs(directMock.value);
    return forceAsync ? scheduleAsyncModuleImport(asyncAncestors, load) : load();
  }
  // `import(URL.createObjectURL(blob))`: Bun evaluates the Blob's contents as
  // an ES module (e.g. re-importing a Bun.build output). The object-URL
  // registry lives on globalThis (installed by the Blob shim).
  const specifierText = String(specifier);
  const virtualNamespace = globalThis.__cottontailVirtualModuleNamespaces?.get(specifierText);
  if (virtualNamespace !== undefined) {
    const load = () => virtualNamespace;
    return forceAsync ? scheduleAsyncModuleImport(asyncAncestors, load) : load();
  }
  let parent = referrer == null
    ? cottontail.cwd()
    : (String(referrer).startsWith("file:") ? fileURLToPath(String(referrer)) : String(referrer));
  // Generated entry launchers inject bunfig/CLI preloads into their own
  // module body. Those imports still belong to the user's entrypoint;
  // resolving beside the temporary launcher loses the project context.
  if (isGeneratedRuntimeBundlePath(parent)) {
    const mainPath = currentProcessBuiltin().argv?.[1];
    if (typeof mainPath === "string" && mainPath.length > 0) {
      parent = isAbsolute(mainPath) ? mainPath : resolve(cottontail.cwd(), mainPath);
    }
  }
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
    return executeDynamicImportSource(
      `${cottontail.cwd()}/__cottontail-data-module.mjs`,
      source,
      "module",
      forceAsync,
      asyncAncestors,
      asyncWaitEdge,
    );
  }
  if (specifierText.startsWith("blob:")) {
    const blob = globalThis.__cottontailObjectURLRegistry?.get(specifierText);
    if (blob && typeof blob.text === "function") {
      const extension = /typescript/i.test(String(blob.type ?? "")) ? "ts" : "mjs";
      const virtualPath = join(cottontail.cwd(), `__cottontail-blob-${specifierText.replace(/[^a-zA-Z0-9._-]/g, "_")}.${extension}`);
      return intrinsicPromiseResolve(blob.text()).then((source) =>
        executeDynamicImportSource(
          virtualPath,
          source,
          "module",
          forceAsync,
          asyncAncestors,
          asyncWaitEdge,
        ));
    }
    throw moduleNotFoundError(specifierText, false);
  }
  const pluginAttempt = tryImportRuntimePlugin(specifierText, parent, options);
  if (pluginAttempt?.matched) {
    if (!forceAsync || isPromiseLike(pluginAttempt.value)) return pluginAttempt.value;
    return scheduleAsyncModuleImport(asyncAncestors, () => pluginAttempt.value);
  }
  if (specifierText.includes("://") && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(specifierText)) {
    throw dynamicResolveMessage(`Cannot find module '${specifierText}' from '${parent}'`);
  }
  const resolved = pluginAttempt?.resolved ?? resolveRequest(String(specifier), parent, true, "import");
  const registeredSelfNamespace = registeredSelfEsmNamespaces.get(resolved);
  if (registeredSelfNamespace !== undefined) {
    const load = () => registeredSelfNamespace;
    return forceAsync ? scheduleAsyncModuleImport(asyncAncestors, load) : load();
  }
  if (forceAsync) {
    return importResolvedRuntimeModule(resolved, options, true, asyncAncestors, asyncWaitEdge);
  }

  const loader = options?.with?.type ?? options?.assert?.type ?? options?.type;
  const cacheKey = loader == null ? String(resolved) : `${resolved}\0${loader}`;
  const registry = globalThis.Loader?.registry;
  if (registry?.has?.(cacheKey)) return registry.get(cacheKey);

  const result = importResolvedRuntimeModule(resolved, options, false, asyncAncestors, asyncWaitEdge);
  if (!isPromiseLike(result)) {
    // Rewritten import() call sites are async functions already. Preserve the
    // evaluated namespace directly so synchronous modules do not allocate two
    // additional Promise reactions for every cache reload.
    const loadedModule = commonJsCache.get(resolved);
    if (loadedModule) loadedModule[dynamicImportModuleKey] = true;
    registry?.set?.(cacheKey, result);
    return result;
  }
  const promise = intrinsicPromiseResolve(result);
  registry?.set?.(cacheKey, promise);
  promise.catch(() => {
    if (registry?.get?.(cacheKey) === promise) registry.delete(cacheKey);
  });
  return promise;
}

function normalizeDynamicImportError(error) {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return error;
  if (error.__ctModuleCompileError) {
    error.name = "BuildMessage";
    error.level ??= "error";
    return error;
  }
  if (error.code === "MODULE_NOT_FOUND") {
    error.name = "ResolveMessage";
    error.code = "ERR_MODULE_NOT_FOUND";
    error.line = Number.isFinite(Number(error.line)) ? Number(error.line) : 0;
    error.column = Number.isFinite(Number(error.column)) ? Number(error.column) : 0;
    error.position ??= { line: error.line, column: error.column };
  }
  return error;
}

function safelyNormalizeDynamicImportError(error) {
  try {
    return normalizeDynamicImportError(error);
  } catch {
    return error;
  }
}

// The native dynamic-import shim (cottontail.importModule) stringifies any
// exception thrown synchronously by this hook, losing error identity (e.g.
// error.code). Return a rejected promise instead so the original Error object
// reaches the awaiting caller intact.
globalThis.__cottontailImportModule = (
  specifier,
  referrer,
  options,
  forceAsync = false,
  asyncAncestors = undefined,
  asyncWaitEdge = false,
) => {
  try {
    const result = __importModule(
      specifier,
      referrer,
      options,
      forceAsync,
      asyncAncestors,
      asyncWaitEdge,
    );
    if (result && typeof result.then === "function") {
      // Every import expression gets a fresh public promise even when it
      // observes a shared in-flight module record. The facade also gives the
      // scheduler a precise boundary after the importer's reactions have been
      // enqueued, without pre-handling rejection on the public promise.
      return normalizedDynamicImportPromise(result);
    }
    return result;
  } catch (error) {
    return intrinsicPromiseReject(safelyNormalizeDynamicImportError(error));
  }
};

function executeQueriedModule(module, filename, suffix) {
  // Handle ?raw query parameter - return file contents as raw text
  if (suffix === "?raw") {
    const rawContents = readModuleFile(filename);
    module.exports = { default: rawContents };
    module.loaded = true;
    return module.exports;
  }
  const originalSource = readModuleFile(filename).replace(/^#![^\n]*(\n|$)/, "");
  if (sourceRequiresAsyncModuleExecution(filename, originalSource)) {
    throw new TypeError(`require() async module "${filename}" is unsupported. use "await import()" instead.`);
  }
  const source = transpileExtensionSource(
    filename,
    runtimeEsmGraphLoader(filename),
    true,
    originalSource,
  );
  const transformed = transformEsmSourceForDynamicImport(source);
  maybeRegisterSourceMap(filename, transformed);
  recordCompileCache(filename, transformed);
  const wrapper = new Function(
    ESM_EXPORTS_BINDING,
    "require",
    "module",
    "__filename",
    "__dirname",
    "__ctImportMeta",
    `${transformed}\n//# sourceURL=${sourceURLForResolved(withSpecifierSuffix(filename, suffix))}`,
  );
  module.exports = createModuleNamespace();
  module[runtimeEsmSourceModuleKey] = true;
  wrapper(
    module.exports,
    createEsmRequire(filename, module),
    module,
    filename,
    dirname(filename),
    importMetaForModule(filename, suffix),
  );
  finalizeEsmNamespaceOrder(module.exports);
  module.loaded = true;
  return module.exports;
}

function attachModuleChild(parent, child) {
  if (!parent || !child || !Array.isArray(parent.children)) return;
  if (!parent.children.includes(child)) parent.children.push(child);
  if (child[moduleParentKey] == null) child[moduleParentKey] = parent;
}

function detachModuleChild(parent, child) {
  if (!parent || !child || !Array.isArray(parent.children)) return;
  const index = parent.children.indexOf(child);
  if (index !== -1) parent.children.splice(index, 1);
}

function circularRequireExports(module) {
  const exports = module.exports;
  if (exports === null || typeof exports !== "object") return exports;
  if (Object.getPrototypeOf(exports) !== Object.prototype || Object.hasOwn(exports, "__esModule")) return exports;
  if (globalThis.__cottontailProxyRegistry?.has(exports)) return exports;
  return new Proxy(exports, {
    get(target, property, receiver) {
      if (property !== "__esModule" && !Reflect.has(target, property)) {
        const name = `'${String(property)}'`;
        currentProcessBuiltin().emitWarning?.(
          `Accessing non-existent property ${name} of module exports inside circular dependency`,
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function loadCommonJsModule(resolved, parent = null, isMain = false) {
  const { bare: resolvedPath, suffix } = splitSpecifierSuffix(resolved);
  const embeddedRelativePath = embeddedRuntimeRelativePath(resolvedPath);
  if (embeddedRelativePath != null && embeddedRuntimePreloadedModules.has(embeddedRelativePath)) {
    return embeddedRuntimePreloadedModules.get(embeddedRelativePath);
  }
  const pendingImport = globalThis.Loader?.registry?.get(resolved);
  if (pendingImport && typeof pendingImport.catch === "function") {
    pendingImport.catch(() => {});
  }
  const mocked = bunModuleMockFor(resolved);
  if (mocked.found) return mocked.value;
  const pathMock = suffix ? bunModuleMockFor(resolvedPath) : { found: false, value: undefined };
  if (pathMock.found) return pathMock.value;
  const registeredSelfNamespace = registeredSelfEsmNamespaces.get(resolved);
  if (registeredSelfNamespace !== undefined) {
    // Bun's require(ESM) view exposes the virtual interop marker on the same
    // live namespace object; the marker remains inherited/non-exported.
    try { registeredSelfNamespace.__esModule = true; } catch {}
    return registeredSelfNamespace;
  }
  const registeredEsm = asyncEsmModuleCache.get(resolved);
  if (registeredEsm?.allowSynchronousRequire === true) return registeredEsm.namespace;
  if (commonJsCache.has(resolved)) {
    const cached = commonJsCache.get(resolved);
    attachModuleChild(parent, cached);
    return cached.loaded === false ? circularRequireExports(cached) : cached.exports;
  }
  const pluginDescriptor = runtimePluginResolvedModules.get(resolved)
    ?? (runtimePluginVirtualModules.has(resolved)
      ? trackRuntimePluginDescriptor(
          { namespace: "virtual", path: resolved, key: resolved, virtual: true },
          resolved,
          true,
        )
      : { namespace: "file", path: resolvedPath, key: resolved });
  if (runtimePluginCallback(pluginDescriptor)) {
    return loadRuntimePluginSync(pluginDescriptor);
  }
  if (runtimePluginResolvedModules.has(resolved) && pluginDescriptor.namespace !== "file") {
    throw moduleNotFoundError(pluginDescriptor.key);
  }
  const hooked = applyLoadHooks(resolvedPath);
  if (hooked !== null) return hooked;
  if (builtinModuleMap.has(resolvedPath)) {
    return loadBuiltinOrReplacement(resolvedPath);
  }
  if (resolvedPath.startsWith("bun:")) {
    // Map bun: specifiers to their embedded runtime module paths.
    // This mirrors the Zig bundler's runtime aliases for the CJS require() path.
    const bunModuleFileMap = {
      "bun:ffi": "bun/ffi.js",
      "bun:jsc": "bun/jsc.js",
      "bun:sqlite": "bun/sqlite.js",
      "bun:test": "bun/test.js",
      "bun:internal-for-testing": "bun/internal-for-testing.js",
      "bun:wrap": "bun/wrap.js",
      "bun:yaml": "bun/yaml.js",
      "bun:dns": "bun/dns.js",
      "bun:json5": "bun/json5.js",
      "bun:toml": "bun/toml.js",
      "bun:s3": "bun/s3.js",
      "bun:redis": "bun/redis.js",
      "bun:sql": "bun/sql.js",
      "bun:color": "bun/color.js",
      "bun:socket": "bun/socket.js",
    };
    const embeddedPath = bunModuleFileMap[resolvedPath];
    if (embeddedPath) {
      const loaded = loadEmbeddedRuntimeModule(embeddedPath);
      // For bun: modules that export a default, unwrap appropriately.
      const exports = loaded?.default ?? loaded;
      // Register in the map so subsequent require() calls find it.
      builtinModuleMap.set(resolvedPath, loaded);
      return exports;
    }
  }
  if (hasRuntimePackageReplacement(resolvedPath)) {
    return loadRuntimePackageReplacement(resolvedPath);
  }
  if (resolvedPath.endsWith(".jsonc")) return parseJSONC(readModuleFile(resolvedPath));
  if (resolvedPath.endsWith(".toml")) return parseTOML(readModuleFile(resolvedPath));
  if (resolvedPath.endsWith(".txt")) return { default: readModuleFile(resolvedPath) };

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

function invalidCreateRequireFilename(value) {
  let received;
  if (typeof value === "string") received = `'${value}'`;
  else if (value === undefined) received = "undefined";
  else {
    try { received = JSON.stringify(value); } catch {}
    received ??= String(value);
  }
  const error = new TypeError(
    "The argument 'filename' must be a file URL object, file URL string, or absolute path string. " +
    `Received ${received}`,
  );
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

function configureRequireProperties(require, normalizedBasePath, resolutionParentForCall, dynamicMain = false) {
  require.resolve = (request, options = undefined) => {
    if (typeof request !== "string") throw invalidRequestType(request);
    const activeParent = resolutionParentForCall();
    if (options !== undefined && options !== null && options.paths !== undefined) {
      // Route through Module._resolveFilename so user overrides and the
      // options.paths semantics both apply (matches Node).
      return Module._resolveFilename(request, activeParent, false, options);
    }
    const text = request;
    if (text.startsWith("node:") && !builtinModuleMap.has(text) && !builtinModuleMap.has(text.slice(5))) {
      throw packageNotFoundError(text, normalizedBasePath);
    }
    return Module._resolveFilename(text, activeParent, false);
  };
  require.resolve.paths = (request) => {
    if (typeof request !== "string") throw invalidRequestType(request);
    const text = request;
    if (isBuiltin(text)) return null;
    const activeBasePath = resolutionParentForCall().filename ?? normalizedBasePath;
    if (text === "." || text === ".." || text.startsWith("./") || text.startsWith("../") || isAbsolute(text)) {
      return [activeBasePath.endsWith("/") ? activeBasePath.slice(0, -1) : dirname(activeBasePath)];
    }
    return _nodeModulePaths(activeBasePath.endsWith("/") ? activeBasePath : dirname(activeBasePath));
  };
  require.cache = commonJsCacheObject;
  require.extensions = extensionsForRequire(normalizedBasePath);
  Object.defineProperty(require, "main", dynamicMain ? {
    configurable: true,
    enumerable: true,
    get() { return mainModule; },
  } : {
    configurable: true,
    enumerable: true,
    writable: true,
    value: mainModule,
  });
  return require;
}

function createRequireImpl(basePath, parentModule, resolveBundledCallerAtCallTime) {
  let normalizedBasePath;
  if (typeof basePath === "string") {
    if (/^file:/i.test(basePath)) {
      try {
        normalizedBasePath = fileURLToPath(basePath);
      } catch {
        throw invalidCreateRequireFilename(basePath);
      }
    } else if (isAbsolute(basePath)) {
      normalizedBasePath = basePath;
    } else if (parentModule != null) {
      // Module#_compile accepts synthetic relative filenames. Its private
      // parent argument distinguishes this from public createRequire().
      normalizedBasePath = basePath;
    } else {
      throw invalidCreateRequireFilename(basePath);
    }
  } else if (basePath != null && typeof basePath === "object" && typeof basePath.href === "string") {
    try {
      normalizedBasePath = fileURLToPath(basePath);
    } catch {
      throw invalidCreateRequireFilename(basePath);
    }
  } else {
    throw invalidCreateRequireFilename(basePath);
  }
  // Public createRequire(import.meta.url) may receive the synthetic bundle
  // URL. Recover its source caller once; only the generated shared require
  // needs a fresh caller for every invocation.
  let resolveCallerPerCall = resolveBundledCallerAtCallTime;
  if (!resolveBundledCallerAtCallTime && parentModule == null && isBundledImportMetaBase(normalizedBasePath)) {
    const callerPath = bundledCallerPathFromStack();
    if (callerPath != null) normalizedBasePath = callerPath;
    // A generated bundle is never a useful resolution base, so when the caller
    // cannot be recovered here (this require is built while the bundle itself
    // is still being set up), recover it on every call instead.
    else if (isGeneratedRuntimeBundlePath(normalizedBasePath)) resolveCallerPerCall = true;
  }
  const resolutionParent = parentModule ?? { filename: normalizedBasePath };
  const resolutionParentForCall = () => {
    if (!resolveCallerPerCall) return resolutionParent;
    const callerPath = bundledCallerPathFromStack();
    return callerPath == null ? resolutionParent : { filename: callerPath };
  };
  const require = (request) => {
    if (typeof request !== "string") throw invalidModuleIdType(request);
    if (request.length === 0) throw invalidEmptyModuleId();
    const directMock = bunModuleMockFor(request);
    if (directMock.found) return directMock.value;
    const requestText = String(request);
    if (requestText.startsWith("blob:")) {
      const blob = globalThis.__cottontailObjectURLRegistry?.get(requestText);
      const bytes = blob?._bytes instanceof Uint8Array
        ? blob._bytes
        : typeof blob?._getBytes === "function" ? blob._getBytes() : null;
      if (bytes instanceof Uint8Array) {
        try {
          return executeDynamicImportSource(requestText, Buffer.from(bytes).toString("utf8"), "module");
        } catch (error) {
          const buildError = new BuildMessage(error?.message ?? String(error));
          buildError.cause = error;
          throw buildError;
        }
      }
    }
    const resolved = Module._resolveFilename(request, resolutionParentForCall(), false);
    const resolvedMock = bunModuleMockFor(resolved);
    if (resolvedMock.found) return resolvedMock.value;
    return loadCommonJsModule(resolved, parentModule);
  };
  return configureRequireProperties(require, normalizedBasePath, resolutionParentForCall);
}

export function createRequire(basePath, parentModule = null) {
  return createRequireImpl(basePath, parentModule, false);
}

export function __createBundledRequire(basePath) {
  return createRequireImpl(basePath, null, true);
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
const commonJsCacheTarget = Object.create(null);
Object.defineProperty(commonJsCacheTarget, Symbol.toStringTag, {
  value: "Module",
  configurable: true,
});
const commonJsCacheObject = new Proxy(commonJsCacheTarget, {
  get(target, property) {
    if (typeof property !== "string") return Reflect.get(target, property);
    return commonJsCache.get(property);
  },
  set(target, property, value) {
    if (typeof property !== "string") return Reflect.set(target, property, value);
    if (typeof property === "string") commonJsCache.set(property, value);
    return true;
  },
  has(target, property) {
    return typeof property === "string" ? commonJsCache.has(property) : Reflect.has(target, property);
  },
  deleteProperty(target, property) {
    if (typeof property !== "string") return Reflect.deleteProperty(target, property);
    const cached = commonJsCache.get(property);
    const registry = globalThis.Loader?.registry;
    const dynamicImport = cached?.[dynamicImportModuleKey] === true ||
      asyncEsmModuleCache.has(property) || registry?.has?.(property) === true;
    if (cached) detachModuleChild(cached[moduleParentKey], cached);
    commonJsCache.delete(property);
    asyncEsmModuleCache.delete(property);
    registry?.delete?.(property);
    if (cached) maybeCollectSmolModuleCacheChurn(dynamicImport);
    return true;
  },
  ownKeys(target) {
    return [...commonJsCache.keys(), ...Reflect.ownKeys(target)];
  },
  getOwnPropertyDescriptor(target, property) {
    if (typeof property !== "string") return Reflect.getOwnPropertyDescriptor(target, property);
    if (!commonJsCache.has(property)) return undefined;
    return { value: commonJsCache.get(property), writable: true, enumerable: true, configurable: true };
  },
});

function isSmolModuleCacheMode() {
  smolModuleCacheMode ??= (currentProcessBuiltin().execArgv ?? []).includes("--smol");
  return smolModuleCacheMode;
}

function maybeCollectSmolModuleCacheChurn(dynamicImport = false) {
  if (!isSmolModuleCacheMode()) return;
  if (dynamicImport) {
    smolDynamicModuleCacheEvictions += 1;
    if (smolDynamicModuleCacheEvictions % smolDynamicModuleCacheGcInterval !== 0) return;
  } else {
    smolModuleCacheEvictions += 1;
    if (smolModuleCacheEvictions % smolModuleCacheGcInterval !== 0) return;
  }
  // Cache deletion happens after module evaluation has returned. Collect at
  // that boundary so a synchronous require() churn loop cannot defer every
  // queued collection until after it has retained hundreds of dead modules.
  cottontail.gc?.(true);
}

// Generated launcher artifacts (the cached entry bundles and the per-run
// bundle) stand in for the entry the user actually ran. Resolving against one
// of them would look for modules next to the cache directory.
function isGeneratedRuntimeBundlePath(path) {
  const normalized = String(path).replaceAll("\\", "/");
  return /\/cottontail\/cache\/(?:esm-entry-|module-runtime-|commonjs-runtime-)/.test(normalized) ||
    /\/cottontail\/run\/[^/]+\/script[.\-][^/]*\.mjs$/.test(normalized) ||
    /\/script-entry-[^/]*\.mjs$/.test(normalized);
}

function isBundledImportMetaBase(path) {
  if (isGeneratedRuntimeBundlePath(path)) return true;
  const mainPath = currentProcessBuiltin().argv?.[1];
  if (typeof mainPath !== "string" || mainPath.length === 0) return false;
  const resolvedMainPath = isAbsolute(mainPath) ? mainPath : resolve(cottontail.cwd(), mainPath);
  return path === resolvedMainPath;
}

let generatedBundlePathsKey;
let generatedBundlePaths;

// The generated entry bundle is a real file on disk, so a stack frame that
// still carries its path (runtime-module frames and bundler helpers have no
// mapping back to a source that exists) must never be mistaken for the
// requiring module. Its own path is advertised directly or as the adjacent
// external source map.
function isGeneratedBundlePath(path) {
  const bundlePath = globalThis.__cottontailBundlePath;
  const mapPath = globalThis.__cottontailBundleSourceMap;
  const key = `${typeof bundlePath === "string" ? bundlePath : ""} ${typeof mapPath === "string" ? mapPath : ""}`;
  if (generatedBundlePathsKey !== key) {
    generatedBundlePathsKey = key;
    generatedBundlePaths = new IntrinsicSet();
    if (typeof bundlePath === "string" && bundlePath !== "") generatedBundlePaths.add(bundlePath);
    if (typeof mapPath === "string" && mapPath.endsWith(".map")) {
      generatedBundlePaths.add(mapPath.slice(0, -".map".length));
    }
  }
  return generatedBundlePaths.has(path);
}

// A generated bundle carries its own path in every frame it did not remap.
// The runtime modules are bundled next to the entry unless
// COTTONTAIL_RUNTIME_MODULES_DIR loads them from disk, so this helper's own
// frames arrive as "<cache>/esm-entry-*.mjs" and would otherwise be taken for
// the caller — resolving the caller's require() against the cache directory.
const generatedBundleArtifactPattern =
  /(?:^|[\\/])(?:script\.bundle\.mjs|(?:script|esm)-entry-[^\\/]*\.mjs|\.cottontail-compat-[0-9a-f]+(?:\.[A-Za-z0-9]+)?)$/;

function bundledCallerPathFromStack() {
  // Errors constructed inside the runtime never reach the Bun-compatible
  // `Error.prototype.stack` formatting, so in a bundled run every frame here
  // still names the generated bundle. Remap through the bundle's source map
  // to recover the module that actually called require(), and ignore whatever
  // is left pointing at the bundle: those frames are the generated wrappers,
  // not a caller, and resolving against them would send bare specifiers to the
  // cache directory instead of the requiring module's node_modules.
  let stack = String(new Error().stack || "");
  const remap = globalThis.__cottontailRemapStackString;
  if (typeof remap === "function") {
    try {
      stack = String(remap(stack) ?? stack);
    } catch {}
  }
  const bundlePath = typeof globalThis.__cottontailBundlePath === "string"
    ? globalThis.__cottontailBundlePath
    : null;
  for (const line of stack.split("\n").slice(2)) {
    const trimmed = line.trim();
    const match = trimmed.match(/\((.*):\d+:\d+\)$/) ??
      trimmed.match(/(?:^|\s)at\s+(.*):\d+:\d+$/) ??
      trimmed.match(/@(.*):\d+:\d+$/);
    let frame = match?.[1];
    if (!frame || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(frame)) continue;
    if (frame.startsWith("file://")) {
      try {
        frame = fileURLToPath(frame);
      } catch {
        continue;
      }
    }
    const candidate = isAbsolute(frame) ? frame : resolve(cottontail.cwd(), frame);
    if (/[\\/]node[\\/]module\.js$/.test(candidate)) continue;
    if (isGeneratedBundlePath(candidate) || generatedBundleArtifactPattern.test(candidate) || isGeneratedRuntimeBundlePath(candidate)) continue;
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

let implicitRunMainUsed = false;

export function __runMain(filename) {
  let resolved = _resolveFilename(resolve(String(filename)), null, true);
  // --preserve-symlinks applies to dependencies, not the entry point. Node
  // only keeps the main module's symlink identity with its separate flag.
  if (!(globalThis.process?.execArgv ?? []).includes("--preserve-symlinks-main")) {
    try {
      const real = cottontail.realpathSync(resolved);
      if (typeof real === "string" && real.length > 0) resolved = real;
    } catch {}
  }
  const module = makeModule(resolved, null, true);
  mainModule = module;
  mainModuleState.current = module;
  refreshModuleRequire(module);
  commonJsCache.set(resolved, module);
  const processObject = currentProcessBuiltin();
  if (!Object.hasOwn(processObject, "mainModule")) {
    Object.defineProperty(processObject, "mainModule", {
      get() {
        return mainModuleState.hasOverride ? mainModuleState.override : mainModuleState.current;
      },
      set(value) {
        if (!mainModuleState.hasOverride && value === mainModuleState.current) return;
        mainModuleState.hasOverride = true;
        mainModuleState.override = value;
      },
      enumerable: true,
      configurable: true,
    });
  }
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

function getModuleParent() {
  maybeWarnModuleParent();
  return this[moduleParentKey];
}

function setModuleParent(value) {
  maybeWarnModuleParent();
  const previous = this[moduleParentKey];
  if (previous !== value) {
    detachModuleChild(previous, this);
    attachModuleChild(value, this);
  }
  this[moduleParentKey] = value;
}

const moduleParentDescriptor = {
  configurable: true,
  enumerable: true,
  get: getModuleParent,
  set: setModuleParent,
};

function getModulePaths() {
  const base = this[modulePathsBaseKey];
  const paths = base == null ? [] : _nodeModulePaths(base);
  nativeObjectDefineProperty(this, "paths", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: paths,
  });
  return paths;
}

function setModulePaths(value) {
  nativeObjectDefineProperty(this, "paths", {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

const modulePathsDescriptor = {
  configurable: true,
  enumerable: true,
  get: getModulePaths,
  set: setModulePaths,
};

function setModulePathsBase(module, base) {
  module[modulePathsBaseKey] = base;
  const descriptor = Object.getOwnPropertyDescriptor(module, "paths");
  if (descriptor && Object.hasOwn(descriptor, "value")) {
    module.paths = base == null ? [] : _nodeModulePaths(base);
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
    this[modulePathsBaseKey] = id ? this.path : null;
    nativeObjectDefineProperty(this, "paths", modulePathsDescriptor);
    this[moduleParentKey] = parent;
    nativeObjectDefineProperty(this, "parent", moduleParentDescriptor);
    refreshModuleRequire(this);
  }

  load(filename) {
    this.filename = String(filename);
    this.path = dirname(this.filename);
    setModulePathsBase(this, this.path);
    refreshModuleRequire(this);
    return executeCommonJsModule(this, this.filename);
  }

  require(request) {
    if (typeof request !== "string") throw invalidModuleIdType(request);
    if (request.length === 0) throw invalidEmptyModuleId();
    return Module._load(request, this, false);
  }

  _compile(source, filename) {
    this.filename = String(filename);
    this.path = dirname(this.filename);
    setModulePathsBase(this, this.path);
    refreshModuleRequire(this);
    executeCommonJsSource(this, this.filename, String(source));
    return undefined;
  }
}

const defaultModuleCompile = Module.prototype._compile;

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
  if (Array.isArray(payload.sections)) {
    const entries = [];
    for (const section of payload.sections) {
      if (section == null || typeof section !== "object" || section.map == null) continue;
      const lineOffset = Number(section.offset?.line) || 0;
      const columnOffset = Number(section.offset?.column) || 0;
      for (const entry of decodeSourceMapEntries(section.map)) {
        entries.push({
          ...entry,
          generatedLine: entry.generatedLine + lineOffset,
          generatedColumn: entry.generatedColumn + (entry.generatedLine === 0 ? columnOffset : 0),
        });
      }
    }
    return entries.sort((left, right) =>
      left.generatedLine - right.generatedLine || left.generatedColumn - right.generatedColumn);
  }
  const mappings = String(payload.mappings ?? "");
  const sources = Array.from(payload.sources ?? [], (source) => source === null ? null : String(source));
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
        originalSource: source == null ? source : `${sourceRoot}${source}`,
        originalLine,
        originalColumn,
        name,
      });
    }
  }
  return entries.sort((left, right) =>
    left.generatedLine - right.generatedLine || left.generatedColumn - right.generatedColumn);
}

function cloneSourceMapPayload(payload) {
  if (Array.isArray(payload)) return payload.map(cloneSourceMapPayload);
  if (payload == null || typeof payload !== "object") return payload;
  const clone = {};
  for (const key of Object.keys(payload)) clone[key] = cloneSourceMapPayload(payload[key]);
  return clone;
}

export class SourceMap {
  #payload;
  #lineLengths;
  #entries;
  #bunSemantics;

  constructor(payload, options = undefined) {
    if (payload === null || typeof payload !== "object") {
      const error = new TypeError(`The "payload" argument must be of type object. Received ${sourceMapPayloadTypeText(payload)}`);
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    this.#bunSemantics = isBunCompatProfile();
    this.#payload = this.#bunSemantics ? payload : cloneSourceMapPayload(payload);
    this.#lineLengths = this.#bunSemantics
      ? options?.lineLengths
      : options?.lineLengths == null ? undefined : Array.from(options.lineLengths, Number);
    this.#entries = decodeSourceMapEntries(this.#payload);
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
    if (entry === undefined) return {};
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
    const line = Number(lineNumber) - (this.#bunSemantics ? 0 : 1);
    const column = Number(columnNumber) - (this.#bunSemantics ? 0 : 1);
    const entry = this.#findNearestEntry(line, column);
    if (entry === undefined || entry.originalSource === undefined) return {};
    if (this.#bunSemantics) {
      return {
        name: entry.name,
        fileName: entry.originalSource,
        line: entry.originalLine + (line - entry.generatedLine),
        column: entry.originalColumn + (column - entry.generatedColumn),
      };
    }
    return {
      name: entry.name,
      fileName: entry.originalSource,
      lineNumber: entry.originalLine + (line - entry.generatedLine) + 1,
      columnNumber: entry.originalColumn + (column - entry.generatedColumn) + 1,
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
    value += (digit & 31) * (2 ** shift);
    if (continuation) {
      shift += 5;
      continue;
    }
    const negative = value % 2 === 1;
    const magnitude = Math.floor(value / 2);
    values.push(negative ? (magnitude === 0 ? -2147483648 : -magnitude) : magnitude);
    value = 0;
    shift = 0;
  }
  return values;
}

function decodeSourceMapMappings(payload = {}) {
  const mappings = String(payload.mappings ?? "");
  const sources = Array.from(payload.sources ?? [], (source) => source === null ? null : String(source));
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
      ? unwrapBuiltin(buffer).Buffer.from(body, "base64").toString("utf8")
      : decodeURIComponent(body);
    return JSON.parse(text);
  }
  const mapPath = sourceMapUrl.startsWith("file:")
    ? fileURLToPath(sourceMapUrl)
    : resolve(dirname(String(filename)), sourceMapUrl);
  return JSON.parse(readModuleFile(mapPath));
}

function maybeRegisterSourceMap(filename, source) {
  try {
    const payload = readSourceMapPayload(filename, source);
    if (payload) {
      const lineLengths = String(source).replace(/\n$/, "").split("\n").map((line) => line.length);
      sourceMapCache.set(String(filename), new SourceMap(payload, { lineLengths }));
      sourceMapMisses.delete(String(filename));
      remappedStacks.clear();
    }
  } catch {}
}

function remapRegisteredSourceMapStack(stack, wrappedFilename = undefined, wrapperLineOffset = 0) {
  const stackText = String(stack ?? "");
  const offset = Number(wrapperLineOffset) || 0;
  const offsetFilename = offset && wrappedFilename != null ? String(wrappedFilename) : "";
  const key = offsetFilename
    ? `${offset}:${offsetFilename.length}:${offsetFilename}${stackText}`
    : stackText;
  const memoized = remappedStacks.get(key);
  if (memoized !== undefined) return memoized;
  const result = remapRegisteredSourceMapStackUncached(stackText, offsetFilename, offset);
  if (remappedStacks.size >= 512) remappedStacks.clear();
  remappedStacks.set(key, result);
  return result;
}

function remapRegisteredSourceMapStackUncached(stack, wrappedFilename = "", wrapperLineOffset = 0) {
  return String(stack ?? "").replace(/(^|[\s(@])([^\s()@]+):(\d+):(\d+)/gm, (frame, prefix, file, lineText, columnText) => {
    let sourceMap = sourceMapCache.get(file);
    if (!sourceMap && !sourceMapMisses.has(file)) {
      try {
        maybeRegisterSourceMap(file, readModuleFile(file));
        sourceMap = sourceMapCache.get(file);
      } catch {}
      if (!sourceMap) sourceMapMisses.add(file);
    }
    if (!sourceMap) return frame;
    const generatedLine = Number(lineText) - (file === wrappedFilename ? wrapperLineOffset : 0);
    if (!Number.isFinite(generatedLine) || generatedLine < 1) return frame;
    const entry = sourceMap.findEntry(generatedLine - 1, Number(columnText) - 1);
    if (entry?.originalSource == null || entry.originalLine == null || entry.originalColumn == null) return frame;
    const source = String(entry.originalSource);
    const resolvedSource = isAbsolute(source) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)
      ? source
      : resolve(dirname(file), source);
    return `${prefix}${resolvedSource}:${entry.originalLine + 1}:${entry.originalColumn + 1}`;
  });
}

function remapThrownModuleError(error, fallbackFilename = undefined, wrapperLineOffset = 0) {
  try {
    const filename = typeof error?.sourceURL === "string" ? error.sourceURL : fallbackFilename;
    if (filename) {
      const generatedSource = readModuleFile(filename);
      let sourceMap = sourceMapCache.get(filename);
      if (!sourceMap) {
        maybeRegisterSourceMap(filename, generatedSource);
        sourceMap = sourceMapCache.get(filename);
      }
      Object.defineProperty(error, "__ctModuleErrorMetadata", {
        value: { filename, generatedSource, sourceMap, wrapperLineOffset },
        configurable: true,
      });
    }
    if (error && typeof error.stack === "string") {
      error.stack = remapRegisteredSourceMapStack(error.stack, filename, wrapperLineOffset);
    }
  } catch {}
  return error;
}

globalThis.__cottontailRemapModuleStackString ??= remapRegisteredSourceMapStack;

function originalErrorLocation(error, metadata) {
  const sourceMap = metadata?.sourceMap;
  const generatedLine = Number(error?.line);
  const generatedColumn = Number(error?.column);
  if (!sourceMap) {
    if (typeof metadata?.generatedSource !== "string" || typeof metadata?.filename !== "string") return null;
    const escapedFilename = metadata.filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const frame = String(error?.stack ?? "").match(new RegExp(`${escapedFilename}:(\\d+):(\\d+)`));
    const stackLine = Number(frame?.[1] ?? generatedLine);
    const stackColumn = Number(frame?.[2] ?? generatedColumn);
    if (!Number.isFinite(stackLine) || !Number.isFinite(stackColumn)) return null;
    return {
      filename: metadata.filename,
      line: Math.max(1, stackLine - Number(metadata.wrapperLineOffset || 0)),
      column: Math.max(1, stackColumn),
      source: metadata.generatedSource,
    };
  }
  // Source maps describe the generated file, not the function wrapper used to
  // execute it. Normalize JSC's wrapped runtime line before looking it up.
  const sourceMapLine = generatedLine - Number(metadata?.wrapperLineOffset || 0);
  if (!Number.isFinite(sourceMapLine) || !Number.isFinite(generatedColumn)) return null;

  let mapColumn = Math.max(0, generatedColumn - 1);
  const generatedLineText = String(metadata.generatedSource).split(/\r?\n/)[sourceMapLine - 1] ?? "";
  const constructorName = String(error?.name || "Error").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const constructorPattern = new RegExp(`\\bnew\\s+${constructorName}\\b`, "g");
  for (const match of generatedLineText.matchAll(constructorPattern)) {
    if (match.index <= mapColumn && match.index + match[0].length >= mapColumn) {
      mapColumn = match.index;
      break;
    }
  }

  const entry = sourceMap.findEntry(sourceMapLine - 1, mapColumn);
  if (entry?.originalSource == null || entry.originalLine == null || entry.originalColumn == null) return null;
  const source = String(entry.originalSource);
  const filename = isAbsolute(source) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)
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

function bunUncaughtCodeFrame(location, error) {
  if (typeof location?.source !== "string") return null;
  const lines = location.source.split(/\r?\n/);
  const start = Math.max(1, location.line - 5);
  const frame = [];
  for (let line = start; line <= location.line && line <= lines.length; line += 1) {
    frame.push(`${line} | ${lines[line - 1]}`);
  }
  frame.push(`${" ".repeat(String(location.line).length + 3 + Math.max(0, location.column - 1))}^`);
  const errorName = String(error?.name ?? "Error");
  const label = errorName === "Error"
    ? "error"
    : errorName === "AssertionError" && error?.code === "ERR_ASSERTION"
      ? "AssertionError [ERR_ASSERTION]"
      : errorName;
  frame.push(`${label}: ${String(error?.message ?? "")}`);
  return frame.join("\n");
}

const previousUncaughtModuleErrorFormatter = globalThis.__cottontailFormatUncaughtModuleError;
function formatUncaughtBundleError(error) {
  const formatter = previousUncaughtModuleErrorFormatter ??
    globalThis.__cottontailFormatUncaughtBundleError;
  return formatter?.(error);
}
globalThis.__cottontailFormatUncaughtModuleError = error => {
  try {
    if (error?.__cottontailSkipUncaughtModuleFormatting === true) return false;
    const metadata = error?.__ctModuleErrorMetadata;
    if (!metadata) return formatUncaughtBundleError(error);
    const missingSourceMapNotes = !metadata.sourceMap && String(metadata.generatedSource).startsWith("// @bun")
      ? `\nnote: missing sourcemaps for ${metadata.filename}\nnote: consider bundling with '--sourcemap' to get unminified traces`
      : "";
    const location = originalErrorLocation(error, metadata);
    const codeFrame = bunUncaughtCodeFrame(location, error);
    if (codeFrame && location) {
      const frames = String(error.stack ?? "").split(/\r?\n/).slice(1).map(frameLine => {
        const trailing = frameLine.trim();
        if (/^at\b/.test(trailing)) return `    ${trailing}`;
        const jscFrame = /^(.*?)@(.+:\d+:\d+)$/.exec(trailing);
        if (!jscFrame) return trailing;
        return jscFrame[1]
          ? `    at ${jscFrame[1]} (${jscFrame[2]})`
          : `    at ${jscFrame[2]}`;
      }).join("\n");
      error.stack = `${codeFrame}\n    at ${location.filename}:${location.line}:${location.column}${frames ? `\n${frames}` : ""}${missingSourceMapNotes}`;
      Object.defineProperty(error, "__cottontailFormattedStack", { value: true, configurable: true });
      return;
    }
    if (missingSourceMapNotes) {
      error.stack = `${String(error.stack ?? error)}${missingSourceMapNotes}`;
      return;
    }
  } catch {}
  return formatUncaughtBundleError(error);
};

export const _cache = commonJsCacheObject;
export let _pathCache = modulePathCache;
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
let sourceMapsSupport = { enabled: false, nodeModules: false, generatedCode: false };

function compileCacheKey(filename, source) {
  return unwrapBuiltin(crypto).createHash("sha256").update(`${filename}\0${source}`).digest("hex");
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
    const cachePath = join(compileCacheDir, `${key}.json`);
    assertFsWrite(cachePath);
    cottontail.writeFile(cachePath, JSON.stringify(entry));
  } catch {}
}

const moduleExtensionsTarget = {
  ".js"(module, filename) {
    const implicitLoader = implicitDefaultExtensionContext?.filename === String(filename)
      ? implicitDefaultExtensionContext.loader
      : "js";
    return executeDefaultExtension(module, filename, implicitLoader);
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
    unwrapBuiltin(processModule).dlopen(module, filename);
    module.loaded = true;
  },
  ".json"(module, filename) {
    const source = readModuleFile(filename);
    try {
      module.exports = JSON.parse(source);
    } catch (error) {
      if (/(^|[\\/])package\.json$/.test(String(filename))) module.exports = parseJSONC(source);
      else {
        if (error && (typeof error === "object" || typeof error === "function")) {
          error.message = `${filename}: ${error.message ?? error}`;
        }
        throw error;
      }
    }
    module.loaded = true;
  },
};

function clearModulePathCache() {
  nativeModuleResolveCacheClear();
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
  const normalizedFrom = resolve(String(from || "."));
  const cached = nodeModulePathsCache.get(normalizedFrom);
  if (cached !== undefined) return cached.slice();

  const paths = [];
  let current = normalizedFrom;
  while (true) {
    if (basename(current).toLowerCase() !== "node_modules") {
      paths.push(join(current, "node_modules"));
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (nodeModulePathsCache.size >= nodeModulePathsCacheLimit) {
    nodeModulePathsCache.delete(nodeModulePathsCache.keys().next().value);
  }
  nodeModulePathsCache.set(normalizedFrom, paths);
  return paths.slice();
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
  if (isAbsolute(text) || text.startsWith(".")) {
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
  if (typeof request !== "string") throw invalidRequestType(request);
  const text = request;
  if (options !== undefined && options !== null && options.paths !== undefined && !Array.isArray(options.paths)) {
    throw invalidResolvePaths(options.paths);
  }
  const base = parent?.filename || parent?.path || cottontail.cwd();
  const pluginDescriptor = resolveWithRuntimePlugins(text, base, "require-call");
  if (pluginDescriptor) return pluginDescriptor.key;
  if (options !== undefined && options !== null && Array.isArray(options.paths)) {
    if (options.paths.some((searchPath) => typeof searchPath !== "string")) {
      throw invalidResolvePathEntries();
    }
    // Node semantics: options.paths replaces the default lookup locations.
    // Relative requests resolve against each entry; bare specifiers search
    // node_modules starting from each entry.
    let lastError;
    for (const searchPath of options.paths) {
      const baseDir = searchPath;
      try {
        return resolveRequest(text, baseDir.endsWith("/") ? baseDir : `${baseDir}/`);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? moduleNotFoundError(text);
  }
  return resolveRequest(text, base);
}

// Shared Bun/import-meta resolver entrypoint. Keep this separate from
// Module._resolveFilename because package condition maps distinguish ESM
// imports from CommonJS require/require.resolve calls.
export function _resolveForImport(request, basePath = cottontail.cwd()) {
  return resolveRequest(String(request), basePath, true, "import");
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
  const delimiter = path.delimiter || (globalThis.process?.platform === "win32" ? ";" : ":");
  const nodePath = typeof env.NODE_PATH === "string"
    ? env.NODE_PATH.split(delimiter).filter(Boolean).map((entry) => resolve(entry))
    : [];
  globalPaths = [
    ...nodePath,
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
  return {
    exists: true,
    pjsonPath,
    main: packageJsonValue(packageJson, "main"),
    name: packageJsonValue(packageJson, "name"),
    type: packageJsonValue(packageJson, "type") ?? "none",
  };
}

export function runMain(main) {
  // Node loads the entry point through the CommonJS cache, so an implicit
  // Module.runMain() after the entry already ran resolves from cache and never
  // re-executes it; Bun likewise never re-runs the entry for a bare call. The
  // process bootstrap performs the single implicit call that starts the entry,
  // so every later implicit call is a no-op. Neither runtime returns exports.
  if (main === undefined || main === null || main === "") {
    if (implicitRunMainUsed) return undefined;
    implicitRunMainUsed = true;
    const entry = globalThis.process?.argv?.[1];
    if (!entry) return undefined;
    __runMain(entry);
    return undefined;
  }
  __runMain(main);
  return undefined;
}

export function syncBuiltinESMExports() {
  return undefined;
}

export function enableCompileCache(cacheDir = undefined) {
  if (compileCacheDir != null) {
    return { status: constants.compileCacheStatus.ALREADY_ENABLED, directory: compileCacheDir };
  }
  const target = cacheDir ?? join(cottontail.cwd(), ".cottontail-compile-cache");
  try {
    assertFsRead(target);
    assertFsWrite(target);
    cottontail.mkdirSync(target, true);
    compileCacheDir = target;
    return { status: constants.compileCacheStatus.ENABLED, directory: target };
  } catch (error) {
    return { status: constants.compileCacheStatus.FAILED, message: String(error?.message ?? error), directory: target };
  }
}

export function flushCompileCache() {
  if (compileCacheDir != null) {
    try {
      const manifestPath = join(compileCacheDir, "manifest.json");
      assertFsWrite(manifestPath);
      cottontail.writeFile(manifestPath, JSON.stringify({
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
  return Object.assign(Object.create(null), sourceMapsSupport);
}

export function setSourceMapsSupport(enabled, options = undefined) {
  if (typeof enabled !== "boolean") throw invalidArgType("enabled", "boolean", enabled);
  if (options !== undefined && (options === null || typeof options !== "object")) {
    throw invalidArgType("options", "object", options);
  }
  const nodeModules = options?.nodeModules;
  const generatedCode = options?.generatedCode;
  if (nodeModules !== undefined && typeof nodeModules !== "boolean") {
    throw invalidArgType("options.nodeModules", "boolean", nodeModules);
  }
  if (generatedCode !== undefined && typeof generatedCode !== "boolean") {
    throw invalidArgType("options.generatedCode", "boolean", generatedCode);
  }
  sourceMapsSupport = {
    enabled,
    nodeModules: nodeModules ?? false,
    generatedCode: generatedCode ?? false,
  };
}

export function findSourceMap(path, error = undefined) {
  void error;
  const key = String(path);
  if (sourceMapCache.has(key)) return sourceMapCache.get(key);
  try {
    maybeRegisterSourceMap(key, readModuleFile(key));
  } catch {}
  return sourceMapCache.get(key);
}

function packageJsonPathFromFile(filename) {
  let current = isDirectory(filename) ? filename : dirname(filename);
  while (true) {
    const packageJsonPath = join(current, "package.json");
    if (isFile(packageJsonPath)) return path.toNamespacedPath?.(packageJsonPath) ?? packageJsonPath;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function findPackageLocation(value, name) {
  if (typeof value === "string") return value;
  if (value != null && typeof value === "object" && typeof value.href === "string") return value.href;
  const error = new TypeError(
    `The "${name}" argument must be of type string or an instance of URL. Received ${formatInvalidValue(value)}`,
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  throw error;
}

export function findPackageJSON(specifier, base = undefined) {
  if (arguments.length === 0) {
    const error = new TypeError('The "specifier" argument must be specified');
    error.code = "ERR_MISSING_ARGS";
    throw error;
  }
  const specifierText = findPackageLocation(specifier, "specifier");
  const baseText = arguments.length < 2 || base === undefined
    ? join(cottontail.cwd(), "__cottontail-find-package-json__.js")
    : findPackageLocation(base, "base");
  let basePath = baseText;
  if (basePath.startsWith("file:")) basePath = fileURLToPath(basePath);

  const isUrl = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifierText);
  const isBare = !isUrl && !isAbsolute(specifierText) &&
    specifierText !== "." && specifierText !== ".." &&
    !specifierText.startsWith("./") && !specifierText.startsWith("../") &&
    !specifierText.startsWith("#");
  if (isBare) {
    if (isBuiltin(specifierText)) return undefined;
    const root = packageRootFor(specifierText, basePath);
    const packageJsonPath = root == null ? undefined : join(root, "package.json");
    return packageJsonPath && isFile(packageJsonPath)
      ? (path.toNamespacedPath?.(packageJsonPath) ?? packageJsonPath)
      : undefined;
  }

  let target;
  if (specifierText.startsWith("file:")) {
    target = fileURLToPath(splitSpecifierSuffix(specifierText).bare);
  } else if (isUrl) {
    return undefined;
  } else {
    target = isAbsolute(specifierText)
      ? splitSpecifierSuffix(specifierText).bare
      : resolve(resolutionStartDir(basePath), splitSpecifierSuffix(specifierText).bare);
  }
  return packageJsonPathFromFile(target);
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
    if (index >= 0) {
      moduleHooks.splice(index, 1);
      hookResolvedFormats.clear();
    }
  }
}

export function register(specifier, parentURL = undefined, options = undefined) {
  let resolvedParentURL = parentURL;
  let resolvedOptions = options;
  if (parentURL != null && typeof parentURL === "object" && typeof parentURL.href !== "string") {
    resolvedOptions = parentURL;
    resolvedParentURL = parentURL.parentURL;
  }
  const parent = resolvedParentURL == null
    ? join(cottontail.cwd(), "__cottontail-register__.js")
    : fileURLToPath(String(resolvedParentURL));
  const isHooksObject = typeof specifier === "object" && specifier !== null &&
    typeof specifier.href !== "string" &&
    (typeof specifier.resolve === "function" || typeof specifier.load === "function" ||
      typeof specifier.initialize === "function");
  let hooksModule;
  if (isHooksObject) {
    hooksModule = specifier;
  } else {
    const specifierText = String(specifier);
    hooksModule = specifierText.startsWith("data:")
      ? __importModule(specifierText, parent)
      : createRequire(parent)(specifierText);
    if (isPromiseLike(hooksModule)) {
      throw new TypeError("Asynchronous module.register() hook modules require native loader support");
    }
  }
  const hooks = hooksModule?.resolve || hooksModule?.load ? hooksModule : hooksModule?.default;
  const registered = registerHooks(hooks ?? {});
  try {
    if (typeof hooksModule?.initialize === "function") hooksModule.initialize(resolvedOptions?.data);
    else if (typeof hooks?.initialize === "function") hooks.initialize(resolvedOptions?.data);
  } catch (error) {
    registered.deregister();
    throw error;
  }
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

function moduleBindingAliasPositions(source) {
  const positions = new IntrinsicSet();
  const code = codeOnlyText(source);
  const declarations = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*\s*,\s*)?\{[^{}]*\}/g,
    /\b(?:import|export)\s+(?:type\s+)?(?:[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*\s*,\s*)?\*\s+as\s+[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*/g,
  ];
  for (const declaration of declarations) {
    let match;
    while ((match = declaration.exec(code)) != null) {
      const aliasPattern = /\bas\b/g;
      let alias;
      while ((alias = aliasPattern.exec(match[0])) != null) {
        positions.add(match.index + alias.index);
      }
    }
  }
  return positions;
}

function stripTypeScriptTypesPreserveWhitespace(source) {
  const ranges = [];
  const moduleBindingAliases = moduleBindingAliasPositions(source);
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
      addMaskRange(ranges, cursor, findTypeEnd(source, cursor + "implements".length, new IntrinsicSet(["{", "\n"])));
      continue;
    }
    if (wordAt(source, cursor, "as")) {
      if (moduleBindingAliases.has(cursor)) continue;
      addMaskRange(ranges, cursor, findTypeEnd(source, cursor + 2, new IntrinsicSet([";", ",", ")", "]", "}", "\n"])));
      continue;
    }
    if (wordAt(source, cursor, "satisfies")) {
      addMaskRange(ranges, cursor, findTypeEnd(source, cursor + 9, new IntrinsicSet([";", ",", ")", "]", "}", "\n"])));
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
      const end = findTypeEnd(source, cursor + 1, new IntrinsicSet(["=", ",", ")", ";", "{", "}", "\n"]));
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
    const specifier = /(?:^|,)\s*type\s+[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*(?:\s+as\s+[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)?\s*,?\s*/g;
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
    const error = new TypeError(`The "code" argument must be of type string. Received ${formatInvalidValue(source)}`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }

  let mode = "strip";
  let sourceMap = false;
  let sourceUrl = undefined;
  if (options !== undefined) {
    if (options === null || typeof options !== "object") {
      const error = new TypeError(`The "options" argument must be of type object. Received ${formatInvalidValue(options)}`);
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    if (options.mode !== undefined) mode = options.mode;
    if (options.sourceMap !== undefined && typeof options.sourceMap !== "boolean") {
      const error = new TypeError(`The "options.sourceMap" property must be of type boolean. Received ${formatInvalidValue(options.sourceMap)}`);
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    if (options.sourceUrl !== undefined && typeof options.sourceUrl !== "string") {
      const error = new TypeError(`The "options.sourceUrl" property must be of type string. Received ${formatInvalidValue(options.sourceUrl)}`);
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    sourceMap = options.sourceMap ?? false;
    sourceUrl = options.sourceUrl;
  }

  if (mode !== "strip" && mode !== "transform") {
    const error = new TypeError(`The property 'options.mode' must be one of: 'strip', 'transform'. Received ${formatInvalidValue(mode)}`);
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }
  if (sourceMap && mode === "strip") {
    const error = new TypeError("The property 'options.sourceMap' must be one of: false, undefined. Received true");
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }
  if (typeof cottontail.stripTypeScriptTypes !== "function") {
    throw new Error("module.stripTypeScriptTypes native parser is unavailable");
  }

  if (!stripTypesWarningEmitted) {
    stripTypesWarningEmitted = true;
    currentProcessBuiltin().emitWarning?.(
      "stripTypeScriptTypes is an experimental feature and might change at any time",
      "ExperimentalWarning",
    );
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
Object.defineProperty(Module, "_pathCache", {
  configurable: true,
  enumerable: true,
  get() { return modulePathCache; },
  set(value) {
    nativeModuleResolveCacheClear();
    modulePathCache = value && typeof value === "object" ? value : Object.create(null);
    _pathCache = modulePathCache;
  },
});
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
const lazyDefault = moduleValue => lazyBuiltin(() => {
  const namespace = unwrapBuiltin(moduleValue);
  return namespace.default ?? namespace;
});
const assertBuiltin = lazyDefault(assert);
const assertStrictBuiltin = lazyDefault(assertStrict);
const consoleBuiltin = lazyDefault(consoleModule);
const eventsBuiltin = lazyDefault(events);
function currentProcessBuiltin() {
  return globalThis.process ?? loadFullProcessBuiltin();
}
function loadFullProcessBuiltin() {
  const current = globalThis.process;
  if (current != null && typeof current.binding === "function") return current;
  const namespace = unwrapBuiltin(processModule);
  const process = namespace.default ?? namespace;
  if (process != null) {
    globalThis.process = process;
    globalThis.__cottontailProcessObject = process;
  }
  return process ?? current;
}
const processBuiltin = lazyBuiltin(loadFullProcessBuiltin);
const streamBuiltin = lazyDefault(stream);
const sysBuiltin = lazyDefault(sys);
const pathBuiltin = path.default ?? path;
const internalTestBindingBuiltin = lazyBuiltin(() => {
  const namespace = unwrapBuiltin(internalTestBinding);
  return {
    ...namespace,
    internalBinding(name) {
      if (String(name) === "http_parser") return loadFullProcessBuiltin().binding("http_parser");
      return namespace.internalBinding(name);
    },
  };
});
// require("path/posix") must be the same object as require("path").posix.
const pathPosixBuiltin = pathBuiltin.posix;
const pathWin32Builtin = pathBuiltin.win32;
// require("fs/promises") must be the same object as require("fs").promises
// (Node exposes fs.promises as the exact fs/promises module object).
const fsBuiltin = lazyDefault(fs);
const fsPromisesBuiltin = lazyBuiltin(() => {
  const fsValue = unwrapBuiltin(fsBuiltin);
  const namespace = unwrapBuiltin(fsPromises);
  return fsValue.promises ?? namespace.default ?? namespace;
});
const constantsBuiltin = lazyDefault(nodeConstants);
// CommonJS exposes a mutable object for node:buffer. Some Node APIs, including
// zlib's global output limit, intentionally observe mutations to that object.
const bufferBuiltin = lazyBuiltin(() => {
  const namespace = unwrapBuiltin(buffer);
  const value = namespace.default ?? namespace;
  installMutableBufferMaxLength(value);
  return value;
});
const httpAgentBuiltin = lazyBuiltin(() => {
  const namespace = unwrapBuiltin(http);
  return { Agent: namespace.Agent, globalAgent: namespace.globalAgent };
});
const httpClientBuiltin = lazyBuiltin(() => ({ ClientRequest: unwrapBuiltin(http).ClientRequest }));
const httpIncomingBuiltin = lazyBuiltin(() => ({
  IncomingMessage: unwrapBuiltin(http).IncomingMessage,
  readStart(socket) { if (socket?.readable && !socket._paused) socket.resume?.(); },
  readStop(socket) { socket?.pause?.(); },
}));
const httpOutgoingBuiltin = lazyBuiltin(() => {
  const namespace = unwrapBuiltin(http);
  return {
    OutgoingMessage: namespace.OutgoingMessage,
    validateHeaderName: namespace.validateHeaderName,
    validateHeaderValue: namespace.validateHeaderValue,
  };
});
const httpServerBuiltin = lazyBuiltin(() => {
  const namespace = unwrapBuiltin(http);
  return {
    STATUS_CODES: namespace.STATUS_CODES,
    Server: namespace.Server,
    ServerResponse: namespace.ServerResponse,
    _connectionListener: namespace._connectionListener,
  };
});
const httpCommonBuiltin = lazyBuiltin(() => unwrapBuiltin(httpCommon).createHttpCommonBuiltin({
  http: unwrapBuiltin(http),
  incoming: unwrapBuiltin(httpIncomingBuiltin),
  processObject: currentProcessBuiltin(),
}));
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
const tlsCommonBuiltin = lazyBuiltin(() => {
  const namespace = unwrapBuiltin(tls);
  return {
    SecureContext: namespace.SecureContext,
    createSecureContext: namespace.createSecureContext,
    translatePeerCertificate,
  };
});
const tlsWrapBuiltin = lazyBuiltin(() => {
  const namespace = unwrapBuiltin(tls);
  return {
    TLSSocket: namespace.TLSSocket,
    Server: namespace.Server,
    createServer: namespace.createServer,
    connect: namespace.connect,
  };
});
const streamDuplexBuiltin = lazyBuiltin(() => unwrapBuiltin(stream).Duplex);
const streamPassThroughBuiltin = lazyBuiltin(() => unwrapBuiltin(stream).PassThrough);
const streamReadableBuiltin = lazyBuiltin(() => unwrapBuiltin(stream).Readable);
const streamTransformBuiltin = lazyBuiltin(() => unwrapBuiltin(stream).Transform);
const streamWritableBuiltin = lazyBuiltin(() => unwrapBuiltin(stream).Writable);

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
  _stream_duplex: streamDuplexBuiltin,
  "node:_stream_duplex": streamDuplexBuiltin,
  _stream_passthrough: streamPassThroughBuiltin,
  "node:_stream_passthrough": streamPassThroughBuiltin,
  _stream_readable: streamReadableBuiltin,
  "node:_stream_readable": streamReadableBuiltin,
  _stream_transform: streamTransformBuiltin,
  "node:_stream_transform": streamTransformBuiltin,
  _stream_wrap: streamBuiltin,
  "node:_stream_wrap": streamBuiltin,
  _stream_writable: streamWritableBuiltin,
  "node:_stream_writable": streamWritableBuiltin,
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
  constants: constantsBuiltin,
  "node:constants": constantsBuiltin,
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
  "internal/test/binding": internalTestBindingBuiltin,
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
  "bun:wrap": bunWrap,
});

// Node's `module` builtin IS the Module class (module.exports = Module), so
// mirror every namespace property onto the class and export it as default.
for (const [propertyName, propertyValue] of Object.entries(moduleBuiltin)) {
  if (!(propertyName in Module)) Module[propertyName] = propertyValue;
}

export default Module;
