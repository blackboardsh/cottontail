import "../internal/v8-date-parser.js";
import { processObject as earlyProcessObject } from "../internal/runtime-process-bootstrap.js";
import * as FFI from "./ffi.js";
import * as NodeBufferNamespace from "../node/buffer.js";
import * as NodeAsyncHooksNamespace from "../node/async_hooks.js";
import * as NodePathNamespace from "../node/path.js";
import * as NodeUrlNamespace from "../node/url.js";
import * as NodeModuleNamespace from "../node/module.js";
import * as WhatwgUrlNamespace from "../vendor/whatwg-url.js";
import * as BunEncodingNamespace from "./encoding.js";
import * as NodeStdioNamespace from "../node/stdio.js";
import * as BunSpawnIpcNamespace from "../internal/bun-spawn-ipc.js";
import { plugin } from "./plugin.js";
export { plugin };
import {
  _resolveForImport as nodeResolveForImport,
  __setBuiltinModules as nodeSetBuiltinModules,
  createRequire as nodeCreateRequire,
  isBuiltin as nodeIsBuiltin,
  loadEmbeddedRuntimeModule,
  registerEmbeddedRuntimeModules,
} from "../node/module.js";
import {
  basename as nodePathBasename,
  dirname as nodePathDirname,
  isAbsolute as nodePathIsAbsolute,
  join as nodePathJoin,
  relative as nodePathRelative,
  resolve as nodePathResolve,
} from "../node/path.js";
import { fileURLToPath as nodeFileURLToPath, pathToFileURL as nodePathToFileURL } from "../node/url.js";
import { _patchAsyncContextGlobals, _wrapAsyncCallback } from "../node/async_hooks.js";
import { URL, URLSearchParams } from "../vendor/whatwg-url.js";
import {
  bunJSCBuiltin,
  bunSQLiteBuiltin,
  bunTestBuiltin,
  color,
  connect,
  dns,
  JSON5,
  listen,
  loadBunJSCModule,
  loadBunTestModule,
  loadTOMLModule,
  postgres,
  redis,
  RedisClient,
  s3,
  S3Client,
  sql,
  SQL,
  TOML,
  webSocketBuiltin,
  YAML,
} from "./lazy-subsystems.js";
export {
  color,
  connect,
  dns,
  JSON5,
  listen,
  postgres,
  redis,
  RedisClient,
  s3,
  S3Client,
  sql,
  SQL,
  TOML,
  YAML,
};
import {
  createLazyBuiltin,
  createLazyFunction,
  createLazyObject,
  createLazyModule,
  installLazyGlobal,
} from "./lazy-runtime.js";
import {
  assertBunAbortSignal,
  bunSignalNumber,
  isEmptyBunSpawnOption,
  isReadableStreamLike,
  normalizeBunSpawnCommand,
  normalizeBunSpawnMaxBuffer,
  normalizeBunSpawnTimeout,
  validateBunSpawnCallbacks,
} from "../internal/bun-spawn-contract.js";
import {
  installInheritedBunIpcCodec,
  installInheritedNodeIpc,
} from "../internal/bun-spawn-ipc.js";
import {
  bodyStreamFor as lifecycleBodyStreamFor,
  bodyStreamIsDisturbed,
  bodyValueForConsumption as lifecycleBodyValueForConsumption,
  bodyWasUsed,
  markFetchBodyConsumed,
  registerFetchBodyFinalizer,
  takeBody as lifecycleTakeBody,
} from "./web-body-lifecycle.js";
import { createRequestResponseRuntime } from "./web-request-response.js";
import { startNativeServe } from "./native-serve.js";
import { createCookieRuntime } from "./cookie.js";
import { asBuffer, concatBuffers, concatManyBuffers } from "./web-buffer-utils.js";
import { createWebPrimitives } from "./web-primitives.js";
import { installStandaloneRuntimeLoaders } from "../internal/standalone-runtime.js";
import { runtimeDefaultUserAgent } from "../internal/runtime-options.js";
import { renderTable } from "../internal/console-table.js";
import {
  file as createBunFile,
  guessMimeType,
  isBunFileLike,
  pathDirname,
  write,
} from "./file-io.js";

registerEmbeddedRuntimeModules({
  "bun/encoding.js": BunEncodingNamespace,
  "bun/ffi.js": FFI,
  "internal/bun-spawn-ipc.js": BunSpawnIpcNamespace,
  "node/async_hooks.js": NodeAsyncHooksNamespace,
  "node/buffer.js": NodeBufferNamespace,
  "node/module.js": NodeModuleNamespace,
  "node/path.js": NodePathNamespace,
  "node/stdio.js": NodeStdioNamespace,
  "node/url.js": NodeUrlNamespace,
  "vendor/whatwg-url.js": WhatwgUrlNamespace,
});

function lazyModuleObject(loadModule) {
  return createLazyObject(() => ({ namespace: loadModule() }), "namespace");
}

function initializeNodeHttp() {
  // Public require("node:http") returns the CommonJS default object. Bun's
  // WebSocket implementation also needs Cottontail's internal named helpers.
  const namespace = loadEmbeddedRuntimeModule("node/http.js");
  const incomingPrototype = namespace.IncomingMessage?.prototype;
  if (incomingPrototype && !Object.prototype.hasOwnProperty.call(incomingPrototype, "_read")) {
    Object.defineProperty(incomingPrototype, "_read", {
      value: function _read() {},
      writable: true,
      configurable: true,
    });
  }
  const wsPrototype = namespace.WebSocket?.prototype;
  const originalDispatch = wsPrototype?.dispatchEvent;
  if (typeof originalDispatch === "function" && !originalDispatch.__cottontailSafeErrorDispatch) {
    const dispatchEvent = function dispatchEvent(event) {
      try {
        return originalDispatch.call(this, event);
      } catch (error) {
        if (event?.type === "error") return true;
        throw error;
      }
    };
    Object.defineProperty(dispatchEvent, "__cottontailSafeErrorDispatch", { value: true });
    wsPrototype.dispatchEvent = dispatchEvent;
  }
  return namespace;
}

const loadNodeHttpModule = createLazyModule("node:http", initializeNodeHttp);
const loadNodeHttpsModule = createLazyModule("node:https", () => loadEmbeddedRuntimeModule("node/https.js"));
const loadNodeNetModule = createLazyModule("node:net", () => loadEmbeddedRuntimeModule("node/net.js"));
const loadNodeStreamModule = createLazyModule("node:stream", () => loadEmbeddedRuntimeModule("node/stream.js"));
const loadNodeStreamWebModule = createLazyModule("node:stream/web", () => loadEmbeddedRuntimeModule("node/stream/web.js"));
const loadNodeTlsModule = createLazyModule("node:tls", () => loadEmbeddedRuntimeModule("node/tls.js"));
const loadNodeZlibModule = createLazyModule("node:zlib", () => loadEmbeddedRuntimeModule("node/zlib.js"));
const loadNodeCryptoModule = createLazyModule("node:crypto", () => loadEmbeddedRuntimeModule("node/crypto.js"));
const nodeHttp = lazyModuleObject(loadNodeHttpModule);
const nodeHttps = lazyModuleObject(loadNodeHttpsModule);
const nodeNet = lazyModuleObject(loadNodeNetModule);
const streamWeb = lazyModuleObject(loadNodeStreamWebModule);
const zlib = lazyModuleObject(loadNodeZlibModule);
const nodeTlsConnect = (...args) => loadNodeTlsModule().connect(...args);
const nodeCpSync = (...args) => loadEmbeddedRuntimeModule("node/fs.js").cpSync(...args);
const createHash = (...args) => loadNodeCryptoModule().createHash(...args);
const createHmac = (...args) => loadNodeCryptoModule().createHmac(...args);
const randomBytes = (...args) => loadNodeCryptoModule().randomBytes(...args);
const randomUUID = (...args) => loadNodeCryptoModule().randomUUID(...args);
const loadNodeUtilModule = createLazyModule("node:util", () => loadEmbeddedRuntimeModule("node/util.js"));
const loadSourceMapModule = createLazyModule("vendor:sourcemap", () => loadEmbeddedRuntimeModule("vendor/sourcemap.js"));
const loadBunHttpServerModule = createLazyModule("internal:bun-http-server", () => loadEmbeddedRuntimeModule("internal/bun-http-server.js"));
const nodeInspect = (...args) => loadNodeUtilModule().inspect(...args);
const isDeepStrictEqual = (...args) => loadNodeUtilModule().isDeepStrictEqual(...args);
export const stripVTControlCharacters = (...args) => loadNodeUtilModule().stripVTControlCharacters(...args);
const remapBundleErrorPosition = (...args) => loadSourceMapModule().remapErrorPosition(...args);
const remapBundlePosition = (...args) => loadSourceMapModule().remapPosition(...args);
const remapBundleStack = (...args) => loadSourceMapModule().remapStackString(...args);
const bundleSourceContextForLocation = (...args) => loadSourceMapModule().sourceContextForLocation(...args);
const captureV8HeapSnapshot = (...args) => loadEmbeddedRuntimeModule("node/internal/heap_snapshot.js").captureV8HeapSnapshot(...args);
const parseBunShellSource = (...args) => loadEmbeddedRuntimeModule("internal/bun-shell-runtime.js").parseBunShellSource(...args);
const createNativeServeRequestOperation = (...args) => loadBunHttpServerModule().createNativeServeRequestOperation(...args);
const createNativeServeRequestState = (...args) => loadBunHttpServerModule().createNativeServeRequestState(...args);
const createServeLifecycle = (...args) => loadBunHttpServerModule().createServeLifecycle(...args);
const incomingRequestURLFactory = (...args) => loadBunHttpServerModule().incomingRequestURLFactory(...args);
const trackServeReadableStream = (...args) => loadBunHttpServerModule().trackServeReadableStream(...args);
const createBunSpawnRuntime = (...args) => loadEmbeddedRuntimeModule("bun/spawn.js").createBunSpawnRuntime(...args);
const loadBunInternalForTestingModule = createLazyModule(
  "bun:internal-for-testing",
  () => loadEmbeddedRuntimeModule("bun/internal-for-testing.js"),
);
const bunInternalForTestingModule = createLazyBuiltin(loadBunInternalForTestingModule);

const loadPicomatchModule = createLazyModule(
  "vendor:picomatch",
  () => loadEmbeddedRuntimeModule("vendor/picomatch.js"),
);

function lazyPicomatch(...args) {
  const module = loadPicomatchModule();
  return (module.default ?? module)(...args);
}

const bunFileServeEmptySlices = new WeakSet();
const wrappedBunFileSlices = new WeakSet();

function wrapBunFileSlices(value) {
  if (!isBunFileLike(value) || wrappedBunFileSlices.has(value)) return value;
  const originalSlice = value.slice;
  if (typeof originalSlice !== "function") return value;
  wrappedBunFileSlices.add(value);
  Object.defineProperty(value, "slice", {
    value: function slice(start = 0, end = undefined, type = "") {
      const normalizedEnd = typeof end === "number" && Number.isNaN(end) ? 0 : end;
      const sliced = wrapBunFileSlices(originalSlice.call(this, start, normalizedEnd, type));
      if (typeof start === "number" && start < 0 && end === Infinity) {
        bunFileServeEmptySlices.add(sliced);
      }
      return sliced;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return value;
}

export function file(path, options = undefined) {
  return wrapBunFileSlices(createBunFile(path, options));
}

export { write };

const estimatedMemoryCostSymbol = Symbol.for("cottontail.estimatedMemoryCost");
const stackFunctionRegistrySymbol = Symbol.for("cottontail.stackFunctionRegistry");

globalThis.process ??= earlyProcessObject;
installStandaloneRuntimeLoaders(globalThis.process);

if (globalThis.process && Object.prototype.toString.call(globalThis.process) !== "[object process]") {
  Object.defineProperty(globalThis.process, Symbol.toStringTag, {
    value: "process",
    writable: true,
    enumerable: false,
    configurable: false,
  });
}

installInheritedBunIpcCodec(cottontail);
installInheritedNodeIpc(cottontail);

const inheritedSpawnArgv0 = globalThis.process?.env?.COTTONTAIL_SPAWN_ARGV0;
if (inheritedSpawnArgv0 != null) {
  Object.defineProperty(globalThis.process, "argv0", {
    value: String(inheritedSpawnArgv0),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  try { delete globalThis.process.env.COTTONTAIL_SPAWN_ARGV0; } catch {}
}
const inheritedSpawnExecPath = globalThis.process?.env?.COTTONTAIL_SPAWN_EXEC_PATH;
if (inheritedSpawnExecPath != null) {
  Object.defineProperty(globalThis.process, "execPath", {
    value: String(inheritedSpawnExecPath),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  try { delete globalThis.process.env.COTTONTAIL_SPAWN_EXEC_PATH; } catch {}
}
const inheritedFileBackedStdin = globalThis.process?.env?.COTTONTAIL_SPAWN_STDIN_FILE === "1";
if (inheritedFileBackedStdin) {
  // Recorded for whenever the stdin stream is actually constructed — at this
  // point process.stdin may not exist yet.
  globalThis.__cottontailFileBackedStdin = true;
  const stream = globalThis.process?.stdin;
  for (const method of ["ref", "unref"]) {
    try {
      delete stream?.[method];
      if (typeof stream?.[method] === "function") {
        Object.defineProperty(stream, method, { value: undefined, configurable: true });
      }
    } catch {}
  }
  try { delete globalThis.process.env.COTTONTAIL_SPAWN_STDIN_FILE; } catch {}
}

let ctEvalOffsetMap;
let ctEvalLineOffset;
const ctDynamicFunctionNames = [];
const ctPendingDynamicFunctionNames = new Map();

function evalBootstrapLineOffset() {
  const map = globalThis.__cottontailBundleSourceMap ?? globalThis.__cottontailBundleSourceMapData;
  if (map == null) return 0;
  if (ctEvalOffsetMap === map && (ctEvalLineOffset ?? 0) > 0) return ctEvalLineOffset;
  if (ctEvalOffsetMap !== map) {
    ctEvalOffsetMap = map;
    ctEvalLineOffset = 0;
  }
  const cwd = globalThis.process?.cwd?.();
  if (typeof cwd !== "string") return 0;
  const source = nodePathResolve(cwd, "[eval]").replaceAll("\\", "/");
  const context = bundleSourceContextForLocation(source, 1, 1);
  const lines = context?.lines;
  if (!Array.isArray(lines)) return 0;
  const boundary = lines.findIndex((line, index) =>
    index > 0 &&
    line.startsWith("}") &&
    lines.slice(Math.max(0, index - 4), index)
      .some(previous => previous.includes("__cottontailVirtualModuleNamespaces.set("))
  );
  if (boundary >= 0) ctEvalLineOffset = boundary;
  return ctEvalLineOffset;
}

function remapEvalStackLines(stack) {
  if (typeof stack !== "string" || !stack.includes("[eval]:")) return stack;
  const offset = evalBootstrapLineOffset();
  if (offset <= 0) return stack;
  return stack.replace(/\[eval\]:(\d+):(\d+)/g, (match, lineText, columnText) => {
    const line = Number(lineText);
    return line > offset ? `[eval]:${line - offset}:${columnText}` : match;
  });
}

function remapStackLocations(stack) {
  let remapped = remapBundleStack(stack);
  const moduleRemapper = globalThis.__cottontailRemapModuleStackString;
  if (typeof moduleRemapper === "function") remapped = moduleRemapper(remapped);
  return normalizeCottontailStackFrames(remapEvalStackLines(remapped));
}

function ctRemapStackString(stack) {
  return remapDynamicFunctionNames(remapStackLocations(stack));
}

function normalizeCottontailStackFrames(stack) {
  if (typeof stack !== "string") return stack;
  let sawAsyncFrame = false;
  return stack.split("\n").flatMap((line) => {
    const isFrame = /^\s*at\b/.test(line) || /^[^@]*@.+:\d+:\d+$/.test(line);
    if (isFrame && (line.includes("/.cottontail-embedded-runtime/") || line.includes("/src/runtime_modules/"))) {
      const nodeFrame = /^(.*?)@.*?\/(?:\.cottontail-embedded-runtime|src\/runtime_modules)\/node\/(.+?)\.js:(\d+):(\d+)$/.exec(line);
      if (nodeFrame) return [`${nodeFrame[1]}@node:${nodeFrame[2]}:${nodeFrame[3]}:${nodeFrame[4]}`];
      return [];
    }
    if (isFrame && (line.includes("/.cottontail-tmp/") || line.includes("/script.bundle.mjs:"))) return [];
    const jscFrame = /^([^@]*)@(.+):([0-9]+):([0-9]+)$/.exec(line);
    if (jscFrame) {
      if (jscFrame[1].startsWith("async ")) sawAsyncFrame = true;
      else if (sawAsyncFrame && jscFrame[1] === "") {
        sawAsyncFrame = false;
        return [`async <anonymous>@${jscFrame[2]}:${jscFrame[3]}:${jscFrame[4]}`];
      }
    }
    return [line];
  }).join("\n");
}

function dynamicFunctionNameAtLocation(name, file, line, column) {
  const asyncPrefix = name.startsWith("async ") ? "async " : "";
  const originalName = asyncPrefix ? name.slice(6) : name;
  const context = bundleSourceContextForLocation(file, Number(line), Number(column));
  const frameLine = Number(line);
  if (!context || !Number.isFinite(frameLine)) return name;
  for (let index = ctDynamicFunctionNames.length - 1; index >= 0; index -= 1) {
    const entry = ctDynamicFunctionNames[index];
    if (entry.originalName === originalName && entry.source === context.source &&
        frameLine >= entry.declarationLine && frameLine <= entry.renameLine) {
      return `${asyncPrefix}${entry.replacement}`;
    }
  }
  return name;
}

function remapDynamicFunctionNames(stack) {
  if (typeof stack !== "string") return stack;
  const names = new Set();
  for (const line of stack.split("\n")) {
    const jscFrame = /^([^@]*)@.+:[0-9]+:[0-9]+$/.exec(line);
    const v8Frame = /^\s*at\s+(.*?)\s+\(.+:[0-9]+:[0-9]+\)$/.exec(line);
    const name = String(jscFrame?.[1] ?? v8Frame?.[1] ?? "").replace(/^async\s+/, "");
    if (name) names.add(name);
  }
  for (const name of names) resolvePendingDynamicFunctionNames(name);
  if (ctDynamicFunctionNames.length === 0) return stack;
  return stack.split("\n").map((line) => {
    const jscFrame = /^([^@]*)@(.+):([0-9]+):([0-9]+)$/.exec(line);
    if (jscFrame) {
      const name = dynamicFunctionNameAtLocation(jscFrame[1], jscFrame[2], jscFrame[3], jscFrame[4]);
      return `${name}@${jscFrame[2]}:${jscFrame[3]}:${jscFrame[4]}`;
    }
    const v8Frame = /^(\s*at\s+)(.*?)\s+\((.+):([0-9]+):([0-9]+)\)$/.exec(line);
    if (!v8Frame) return line;
    const name = dynamicFunctionNameAtLocation(v8Frame[2], v8Frame[3], v8Frame[4], v8Frame[5]);
    return `${v8Frame[1]}${name} (${v8Frame[3]}:${v8Frame[4]}:${v8Frame[5]})`;
  }).join("\n");
}

function registerDynamicFunctionRename(originalName, replacement, callSite) {
  const stack = remapStackLocations(`@${callSite.file}:${callSite.line}:${callSite.column}`);
  for (const line of String(stack ?? "").split("\n")) {
    const jscFrame = /^([^@]*)@(.+):([0-9]+):([0-9]+)$/.exec(line);
    const v8Frame = /^\s*at(?:\s+.*?)?\s*\(?(.+):([0-9]+):([0-9]+)\)?$/.exec(line);
    const file = jscFrame?.[2] ?? v8Frame?.[1];
    const lineNumber = Number(jscFrame?.[3] ?? v8Frame?.[2]);
    const columnNumber = Number(jscFrame?.[4] ?? v8Frame?.[3]);
    if (!file || !Number.isFinite(lineNumber)) continue;
    const context = bundleSourceContextForLocation(file, lineNumber, columnNumber);
    const lines = context?.lines;
    if (!Array.isArray(lines)) continue;
    const escaped = originalName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declaration = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`);
    for (let index = Math.min(lines.length - 1, lineNumber - 1); index >= Math.max(0, lineNumber - 200); index -= 1) {
      if (!declaration.test(lines[index])) continue;
      ctDynamicFunctionNames.push({
        originalName,
        replacement,
        source: context.source,
        declarationLine: index + 1,
        renameLine: lineNumber,
      });
      return;
    }
  }
}

function dynamicFunctionRenameCallSite(stack) {
  for (const line of String(stack ?? "").split("\n")) {
    const jscFrame = /^([^@]*)@(.+):([0-9]+):([0-9]+)$/.exec(line);
    const v8Frame = /^\s*at\s+(?:(.*?)\s+\()?(.+):([0-9]+):([0-9]+)\)?$/.exec(line);
    const name = jscFrame?.[1] ?? v8Frame?.[1] ?? "";
    if (name === "__name") continue;
    const file = jscFrame?.[2] ?? v8Frame?.[2];
    // Runtime modules are bundled through the same __name helper as user
    // code. Recording those internal renames (for example require3 ->
    // require in node:module) leaves one unresolved call-site record behind
    // every time a CommonJS module is reloaded.
    if (/^(?:bun|node|internal):/.test(String(file ?? "")) ||
        /[\\/]cache[\\/]commonjs-runtime-[^\\/]+\.mjs$/.test(String(file ?? ""))) {
      return null;
    }
    const frameLine = Number(jscFrame?.[3] ?? v8Frame?.[3]);
    const column = Number(jscFrame?.[4] ?? v8Frame?.[4]);
    if (file && Number.isFinite(frameLine) && Number.isFinite(column)) {
      return { file, line: frameLine, column };
    }
  }
  return null;
}

function resolvePendingDynamicFunctionNames(originalName) {
  const pending = ctPendingDynamicFunctionNames.get(originalName);
  if (!pending) return;
  ctPendingDynamicFunctionNames.delete(originalName);
  for (const entry of pending) {
    registerDynamicFunctionRename(originalName, entry.replacement, entry.callSite);
  }
}

function captureDynamicFunctionRename(originalName, replacement) {
  if (typeof nativeCaptureStackTrace !== "function") return;
  const holder = {};
  try {
    nativeCaptureStackTrace(holder, Object.defineProperty);
  } catch {
    return;
  }
  const callSite = dynamicFunctionRenameCallSite(holder.stack);
  if (!callSite) return;
  const pending = ctPendingDynamicFunctionNames.get(originalName) ?? [];
  pending.push({ replacement, callSite });
  ctPendingDynamicFunctionNames.set(originalName, pending);
}

// The generated __toESM helper strictly honors the __esModule marker:
// `import x from "cjs"`
// yields x === undefined for CJS modules that set __esModule without an
// exports.default (e.g. @grpc/grpc-js, TS-compiled CJS). Bun/Node semantics:
// default falls back to module.exports in that case. The runtime modules are
// bundled into the same top-level scope as the helper, so rewrap it here
// (before any user code evaluates) to apply the fallback.
// The helper must be reached via direct eval: a bare `__toESM` identifier can
// be renamed during bundling, while the eval string remains opaque and finds
// the canonical helper through the scope chain.
try {
  const ctOriginalToESM = eval('typeof __toESM === "function" ? __toESM : undefined');
  if (ctOriginalToESM && !ctOriginalToESM.__cottontailDefaultInterop) {
    const ctPatchedToESM = (mod, isNodeMode, target) => {
      const honorMarker = !isNodeMode && mod && mod.__esModule &&
        Object.prototype.hasOwnProperty.call(mod, "default");
      return ctOriginalToESM(mod, honorMarker ? 0 : 1, target);
    };
    ctPatchedToESM.__cottontailDefaultInterop = true;
    eval("__toESM = ctPatchedToESM");
  }
} catch {}

// The native SharedArrayBuffer shim reprototypes real ArrayBuffers, so
// instances read byteLength through ArrayBuffer.prototype, but libraries
// (e.g. mongodb's BSON) probe the getter descriptor on
// SharedArrayBuffer.prototype itself. Mirror the ArrayBuffer getter there.
if (typeof globalThis.SharedArrayBuffer === "function" && globalThis.SharedArrayBuffer !== ArrayBuffer) {
  const ctSabProto = globalThis.SharedArrayBuffer.prototype;
  if (ctSabProto && !Object.getOwnPropertyDescriptor(ctSabProto, "byteLength")) {
    const ctAbByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
    if (ctAbByteLength) {
      Object.defineProperty(ctSabProto, "byteLength", {
        get: function byteLength() { return ctAbByteLength.call(this); },
        enumerable: false,
        configurable: true,
      });
    }
  }
}

if (typeof globalThis.Performance !== "function") {
  globalThis.Performance = class Performance {};
  if (globalThis.performance && typeof globalThis.performance === "object") {
    Object.setPrototypeOf(globalThis.performance, globalThis.Performance.prototype);
  }
}

if (typeof globalThis.ShadowRealm !== "function" &&
    typeof cottontail.vmCreateContext === "function" &&
    typeof cottontail.vmRunInContext === "function") {
  const shadowRealmState = new WeakMap();
  const shadowRealmFinalizer = typeof FinalizationRegistry === "function" &&
    typeof cottontail.vmReleaseContext === "function"
    ? new FinalizationRegistry((handle) => cottontail.vmReleaseContext(handle))
    : null;

  const importShadowRealmValue = (value) => {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
    if (typeof value !== "function") {
      throw new TypeError("ShadowRealm evaluated code must return a primitive value or a callable");
    }
    return function shadowRealmCallable(...args) {
      return importShadowRealmValue(Reflect.apply(value, undefined, args));
    };
  };

  globalThis.ShadowRealm = class ShadowRealm {
    constructor() {
      const handle = cottontail.vmCreateContext("ShadowRealm", true);
      shadowRealmState.set(this, { handle, global: {} });
      shadowRealmFinalizer?.register(this, handle);
    }

    evaluate(sourceText) {
      const state = shadowRealmState.get(this);
      if (!state) throw new TypeError("ShadowRealm.prototype.evaluate called on incompatible receiver");
      const result = cottontail.vmRunInContext(
        state.handle,
        state.global,
        String(sourceText),
        "shadowrealm.<anonymous>",
      );
      return importShadowRealmValue(result);
    }
  };
  Object.defineProperty(globalThis.ShadowRealm.prototype, Symbol.toStringTag, {
    value: "ShadowRealm",
    configurable: true,
  });
}

const nativeCaptureStackTrace = Error.captureStackTrace;
class CottontailCallSite {
    constructor(frame) {
      this.functionName = frame.functionName || null;
      this.fileName = frame.fileName || null;
      this.lineNumber = frame.lineNumber || null;
      this.columnNumber = frame.columnNumber || null;
      this.functionValue = frame.functionValue;
      this.evalFrame = frame.evalFrame === true;
      this.nativeFrame = frame.nativeFrame === true;
      this.constructorFrame = frame.constructorFrame === true;
      this.asyncFrame = frame.asyncFrame === true;
    }
    getThis() { return undefined; }
    getTypeName() { return "undefined"; }
    getFunction() { return this.functionValue; }
    getFunctionName() { return this.functionName; }
    getMethodName() { return this.functionName; }
    getFileName() { return this.fileName; }
    getScriptNameOrSourceURL() { return this.fileName; }
    getLineNumber() { return this.lineNumber; }
    getColumnNumber() { return this.columnNumber; }
    getEvalOrigin() { return undefined; }
    isToplevel() { return this.constructorFrame || this.functionValue === undefined; }
    isEval() { return this.evalFrame; }
    isNative() { return this.nativeFrame; }
    isConstructor() { return this.constructorFrame; }
    isAsync() { return this.asyncFrame; }
    isPromiseAll() { return false; }
    getPromiseIndex() { return null; }
    toString() {
      const location = this.fileName
        ? `${this.fileName}${this.lineNumber == null ? "" : `:${this.lineNumber}${this.columnNumber == null ? "" : `:${this.columnNumber}`}`}`
        : "<anonymous>";
      const name = this.functionName
        ? `${this.constructorFrame ? "new " : ""}${this.functionName}`
        : "unknown";
      return `${name} (${location})`;
    }
    get [Symbol.toStringTag]() { return "CallSite"; }
  }

function registeredStackFunction(name) {
  const reference = globalThis[stackFunctionRegistrySymbol]?.get?.(name);
  return typeof reference?.deref === "function" ? reference.deref() :
    typeof reference === "function" ? reference : undefined;
}

function constructorNameAtCallSite(fileName, lineNumber, columnNumber) {
  if (!fileName || !Number.isFinite(lineNumber)) return null;
  const context = bundleSourceContextForLocation(fileName, lineNumber, columnNumber);
  if (!Array.isArray(context?.lines)) return null;
  const target = Math.max(0, Math.min(context.lines.length - 1, Number(context.line ?? lineNumber) - 1));
  let insideConstructor = false;
  for (let index = target; index >= Math.max(0, target - 80); index -= 1) {
    const sourceLine = context.lines[index];
    if (!insideConstructor && /^\s*(?:async\s+)?function\b/.test(sourceLine)) return null;
    const method = /^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(sourceLine);
    if (method && !insideConstructor) {
      if (method[1] !== "constructor") return null;
      insideConstructor = true;
    }
    const declaration = /\bclass\s+([A-Za-z_$][\w$]*)\b/.exec(sourceLine);
    if (!declaration) continue;
    if (insideConstructor || /\bconstructor\s*\(/.test(sourceLine.slice(declaration.index))) {
      return declaration[1];
    }
    return null;
  }
  return null;
}

function correctCallerLocations(sites) {
  for (let index = 1; index < sites.length; index += 1) {
    const callee = sites[index - 1].functionName;
    const caller = sites[index];
    if (!callee || !caller.fileName || !Number.isFinite(caller.lineNumber)) continue;
    const context = bundleSourceContextForLocation(caller.fileName, caller.lineNumber, caller.columnNumber);
    if (!Array.isArray(context?.lines)) continue;
    const target = Math.max(0, Math.min(context.lines.length - 1, Number(context.line ?? caller.lineNumber) - 1));
    const escaped = callee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const invocation = new RegExp(`\\b${escaped}\\s*\\(`);
    for (let sourceIndex = target; sourceIndex >= Math.max(0, target - 12); sourceIndex -= 1) {
      const sourceLine = context.lines[sourceIndex];
      const match = invocation.exec(sourceLine);
      if (!match || new RegExp(`\\b(?:function|class)\\s+${escaped}\\b`).test(sourceLine)) continue;
      caller.lineNumber = sourceIndex + 1;
      caller.columnNumber = match.index + 1;
      break;
    }
  }
}

function evalSourceURLFromCallSites(sites) {
  if (!sites.slice(0, 3).some(site => site.evalFrame || site.nativeFrame)) return null;
  for (const site of sites.slice(2)) {
    if (!site.fileName || site.nativeFrame || !Number.isFinite(site.lineNumber)) continue;
    const context = bundleSourceContextForLocation(site.fileName, site.lineNumber, site.columnNumber);
    if (!Array.isArray(context?.lines)) continue;
    const target = Math.max(0, Math.min(context.lines.length - 1, Number(context.line ?? site.lineNumber) - 1));
    for (let sourceIndex = target; sourceIndex >= Math.max(0, target - 200); sourceIndex -= 1) {
      const directive = /(?:\/\/|\/\*)[#@]\s*sourceURL\s*=\s*([^\s*`'"}]+)/.exec(context.lines[sourceIndex]);
      if (directive?.[1]) return directive[1];
    }
  }
  return null;
}

const parseCallSites = (stack, fallbackSourceURL = undefined) => {
  const sites = String(stack ?? "").split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("@");
    let functionName = separator < 0 ? line : line.slice(0, separator);
    const location = separator < 0 ? "" : line.slice(separator + 1);
    const locationMatch = /^(.*):(\d+):(\d+)$/.exec(location);
    let fileName = locationMatch?.[1] || location || null;
    // Bun reports plain filesystem paths in stack frames, not file: URLs.
    if (typeof fileName === "string" && fileName.startsWith("file://")) {
      try { fileName = nodeFileURLToPath(fileName); } catch {}
    }
    const lineNumber = locationMatch ? Number(locationMatch[2]) : null;
    const columnNumber = locationMatch ? Number(locationMatch[3]) : null;
    functionName ||= null;
    const asyncFrame = String(functionName ?? "").startsWith("async ");
    if (asyncFrame) functionName = functionName.slice("async ".length);
    const nativeFrame = fileName === "[native code]";
    const evalFrame = String(functionName ?? "").includes("eval") || String(fileName ?? "").includes("eval code");
    const constructorName = constructorNameAtCallSite(fileName, lineNumber, columnNumber);
    if (constructorName) functionName = constructorName;
    return new CottontailCallSite({
      functionName,
      functionValue: functionName ? registeredStackFunction(functionName) : undefined,
      fileName,
      lineNumber,
      columnNumber,
      evalFrame,
      nativeFrame,
      asyncFrame,
      constructorFrame: constructorName !== null,
    });
  });
  correctCallerLocations(sites);
  const hasEvalFrames = sites.slice(0, 3).some(site => site.evalFrame || site.nativeFrame);
  const evalSourceURL = evalSourceURLFromCallSites(sites);
  const firstFrameSource = evalSourceURL ||
    (typeof fallbackSourceURL === "string" && fallbackSourceURL ? fallbackSourceURL : null);
  if (firstFrameSource) {
    for (const site of sites.slice(0, 2)) {
      if (hasEvalFrames || !site.fileName || site.fileName === fallbackSourceURL) {
        site.fileName = firstFrameSource;
      }
    }
  }
  return sites;
};

function limitedCallSites(stack, fallbackSourceURL = undefined, configuredLimit = Error.stackTraceLimit) {
  const sites = parseCallSites(stack, fallbackSourceURL);
  const limit = Number(configuredLimit);
  return Number.isFinite(limit) && limit >= 0 ? sites.slice(0, Math.floor(limit)) : sites;
}

const bunAccessedErrorStacks = new WeakSet();

if (typeof nativeCaptureStackTrace === "function" && !Error.captureStackTrace.__cottontailStructuredCallSites) {
  const captureStackTrace = function(target, constructorOpt = undefined) {
    const prepare = Error.prepareStackTrace;
    const requestedLimit = Error.stackTraceLimit;
    Error.prepareStackTrace = undefined;
    if (Number.isFinite(Number(requestedLimit)) && Number(requestedLimit) < 100) Error.stackTraceLimit = 100;
    try {
      const holder = {};
      nativeCaptureStackTrace(holder, constructorOpt);
      if (globalThis.process?.env?.CT_DEBUG_STACK === "1") {
        console.log("=== RAW HOLDER STACK ===\n" + holder.stack + "\n=== END RAW ===");
      }
      const rawStack = ctRemapStackString(holder.stack);
      const callSites = limitedCallSites(rawStack, undefined, requestedLimit);
      Object.defineProperty(target, "stack", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: rawStack,
      });
      if (typeof prepare === "function") {
        target.stack = prepare(target, callSites);
      } else {
        const name = String(target.name || target.constructor?.name || "Error");
        const message = target.message == null || target.message === "" ? "" : `: ${String(target.message)}`;
        const frames = callSites.map((site) => `    at ${site.toString()}`).join("\n");
        target.stack = `${name}${message}${frames ? `\n${frames}` : ""}`;
      }
    } finally {
      Error.stackTraceLimit = requestedLimit;
      Error.prepareStackTrace = prepare;
    }
  };
  Object.defineProperty(captureStackTrace, "__cottontailStructuredCallSites", { value: true });
  Error.captureStackTrace = captureStackTrace;
}

function installNodeStyleErrorConstructor(name) {
  const NativeError = globalThis[name];
  if (typeof NativeError !== "function" || NativeError.__cottontailStackHeader) return;
  const CottontailError = function(...args) {
    const requestedLimit = NativeError.stackTraceLimit;
    if (Number.isFinite(Number(requestedLimit)) && Number(requestedLimit) < 100) NativeError.stackTraceLimit = 100;
    const StackError = globalThis.Error;
    const nativePrepare = StackError?.prepareStackTrace;
    const underlyingPrepare = NativeError.prepareStackTrace;
    let error;
    let rawStack;
    try {
      if (StackError) Reflect.set(StackError, "prepareStackTrace", undefined);
      Reflect.set(NativeError, "prepareStackTrace", undefined);
      error = Reflect.construct(NativeError, args, new.target || CottontailError);
      rawStack = error.stack;
    } finally {
      NativeError.stackTraceLimit = requestedLimit;
      Reflect.set(NativeError, "prepareStackTrace", underlyingPrepare);
      if (StackError) Reflect.set(StackError, "prepareStackTrace", nativePrepare);
    }
    const generatedPosition = {
      line: Number(error.line),
      column: Number(error.column),
      sourceURL: error.sourceURL,
    };
    let positionComputed = false;
    const applyMappedPosition = () => {
      if (positionComputed) return;
      positionComputed = true;
      const mappedPosition = remapBundleErrorPosition(generatedPosition.line, generatedPosition.column);
      Object.defineProperties(error, {
        line: { configurable: true, writable: true, value: mappedPosition?.line ?? generatedPosition.line },
        column: { configurable: true, writable: true, value: mappedPosition?.column ?? generatedPosition.column },
        ...(mappedPosition ? {
          originalLine: { configurable: true, writable: true, value: mappedPosition.originalLine },
          originalColumn: { configurable: true, writable: true, value: mappedPosition.originalColumn },
        } : {}),
        sourceURL: { configurable: true, writable: true, value: mappedPosition?.source ?? generatedPosition.sourceURL },
      });
    };
    for (const property of ["line", "column", "originalLine", "originalColumn", "sourceURL"]) {
      Object.defineProperty(error, property, {
        configurable: true,
        enumerable: false,
        get() {
          applyMappedPosition();
          return error[property];
        },
        set(value) {
          applyMappedPosition();
          error[property] = value;
        },
      });
    }
    if (typeof rawStack === "string") {
      // Remap lazily: parsing the bundle source map costs ~200ms on first use,
      // which must not be paid at Error construction time.
      let cached;
      let computed = false;
      Object.defineProperty(error, "stack", {
        configurable: true,
        enumerable: false,
        get() {
          bunAccessedErrorStacks.add(error);
          if (!computed) {
            computed = true;
            applyMappedPosition();
            // V8/bun semantics: Error.prepareStackTrace (checked lazily at
            // first .stack access) receives (error, callSites) and its return
            // value becomes the stack (pino et al. rely on this to collect
            // caller file names).
            const prepare = Error.prepareStackTrace;
            const remappedStack = ctRemapStackString(rawStack);
            const callSites = limitedCallSites(remappedStack, generatedPosition.sourceURL);
            if (typeof prepare === "function") {
              cached = prepare(error, callSites);
              return cached;
            }
            const errorName = error.name === undefined ? name : String(error.name);
            const errorMessage = error.message == null ? "" : String(error.message);
            const header = errorName === ""
              ? errorMessage
              : errorMessage === "" ? errorName : `${errorName}: ${errorMessage}`;
            const frames = callSites.map((site) => `    at ${site.toString()}`).join("\n");
            cached = `${header}${frames ? `\n${frames}` : ""}`;
          }
          return cached;
        },
        set(value) {
          computed = true;
          cached = value;
        },
      });
    }
    return error;
  };
  Object.defineProperty(CottontailError, "name", { value: name });
  Object.defineProperty(CottontailError, "__cottontailStackHeader", { value: true });
  Object.setPrototypeOf(CottontailError, NativeError);
  const stackTraceLimit = Object.getOwnPropertyDescriptor(NativeError, "stackTraceLimit");
  if (stackTraceLimit) {
    Object.defineProperty(CottontailError, "stackTraceLimit", {
      configurable: stackTraceLimit.configurable,
      enumerable: stackTraceLimit.enumerable,
      get() {
        return NativeError.stackTraceLimit;
      },
      set(value) {
        NativeError.stackTraceLimit = value;
      },
    });
  }
  CottontailError.prototype = NativeError.prototype;
  globalThis[name] = CottontailError;
}

for (const errorName of ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError"]) {
  installNodeStyleErrorConstructor(errorName);
}

// JavaScriptCore defaults to 100 frames; Bun and V8 default to 10.
if (Error.stackTraceLimit === 100) Error.stackTraceLimit = 10;

if (!Object.defineProperty.__cottontailDynamicFunctionNames) {
  const nativeDefineProperty = Object.defineProperty;
  const defineProperty = function defineProperty(target, property, descriptor) {
    const previousName = typeof target === "function" && property === "name" ? target.name : undefined;
    const result = Reflect.apply(nativeDefineProperty, Object, [target, property, descriptor]);
    if (typeof previousName === "string" && previousName &&
        typeof descriptor?.value === "string" && descriptor.value !== previousName) {
      captureDynamicFunctionRename(previousName, descriptor.value);
    }
    return result;
  };
  nativeDefineProperty(defineProperty, "__cottontailDynamicFunctionNames", { value: true });
  Object.defineProperty = defineProperty;
}

// Bun ships a default Error.prepareStackTrace (unlike Node, where it is
// undefined). It formats "Name: message" plus V8-style "    at " frames and
// tolerates non-array traces. The __cottontailDefaultPrepare marker lets the
// stack machinery above treat it as "not user-installed".
if (Error.prepareStackTrace === undefined) {
  const defaultPrepareStackTrace = function prepareStackTrace(error, trace) {
    let header;
    try {
      header = error == null ? String(error) : Error.prototype.toString.call(error);
    } catch {
      header = "<error>";
    }
    if (!Array.isArray(trace)) {
      if (trace == null) return header;
      trace = [""];
    }
    if (trace.length === 0) return header;
    return `${header}\n    at ${trace.map((site) => String(site)).join("\n    at ")}`;
  };
  Object.defineProperty(defaultPrepareStackTrace, "__cottontailDefaultPrepare", { value: true });
  Error.prepareStackTrace = defaultPrepareStackTrace;
}

// Shared hooks so other runtime modules (uncaught-error printing, test
// reporters) can remap bundle stack positions without importing this module.
globalThis.__cottontailRemapStackString ??= ctRemapStackString;
globalThis.__cottontailRemapPosition ??= remapBundlePosition;
globalThis.__cottontailSourceContextForLocation ??= bundleSourceContextForLocation;

if (typeof JSON.parse === "function" && !JSON.parse.__cottontailStackHeader) {
  const nativeJSONParse = JSON.parse;
  const parse = function(text, reviver = undefined) {
    try {
      return nativeJSONParse(text, reviver);
    } catch (error) {
      if (error && typeof error.stack === "string") {
        let stack = ctRemapStackString(error.stack);
        if (error.message && !stack.includes(String(error.message))) {
          stack = `${error.name || "SyntaxError"}: ${error.message}\n${stack}`;
        }
        if (stack !== error.stack) error.stack = stack;
      }
      throw error;
    }
  };
  Object.defineProperty(parse, "__cottontailStackHeader", { value: true });
  JSON.parse = parse;
}

if (Symbol.dispose == null) {
  Object.defineProperty(Symbol, "dispose", {
    value: Symbol.for("Symbol.dispose"),
    configurable: true,
  });
}

if (Symbol.asyncDispose == null) {
  Object.defineProperty(Symbol, "asyncDispose", {
    value: Symbol.for("Symbol.asyncDispose"),
    configurable: true,
  });
}

function shellEscape(value) {
  if (isBunFileLike(value) && value.name != null) value = value.name;
  const text = String(value);
  validateNoNullByte(text, "shell argument");
  // Ported from Bun's shell.escapeBunStr/needsEscapeBunstr. Bun deliberately
  // quotes digits and assignment punctuation because the same escaped value is
  // also consumed by its lexer, not only by a platform shell.
  if (!/[~[\]#;\n*{,}`$=()0-9|><&'" \\]/.test(text)) return text;
  return `"${text.replace(/[$`"\\]/g, "\\$&")}"`;
}

function invalidNullByteError(name, value) {
  const error = new TypeError(`The argument '${name}' must be a string without null bytes. Received ${JSON.stringify(String(value))}`);
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

function validateNoNullByte(value, name) {
  if (String(value).includes("\0")) throw invalidNullByteError(name, value);
}

function validateSpawnInput(file, args = [], options = {}) {
  validateNoNullByte(file, "args[0]");
  for (let index = 0; index < args.length; index += 1) validateNoNullByte(args[index], `args[${index + 1}]`);
  if (options.env && typeof options.env === "object") {
    for (const [key, value] of Object.entries(options.env)) {
      validateNoNullByte(key, `env.${key}`);
      validateNoNullByte(value, `env.${key}`);
    }
  }
}

if (globalThis.console) {
  const renderConsoleTable = (value, properties = undefined) => {
    if (properties !== undefined && !Array.isArray(properties)) {
      throw new TypeError("console.table properties must be an array");
    }
    if (value !== null && typeof value === "object") {
      const rendered = renderTable(value, properties, { colors: false });
      if (rendered) {
        earlyProcessObject.stdout?.write?.(rendered);
        return;
      }
    }
    globalThis.console.log(value);
  };
  globalThis.console.table = renderConsoleTable;
}

if (globalThis.console) {
  const consoleTimers = globalThis.console.__cottontailTimers ??= new Map();
  globalThis.console.time ??= (label = "default") => {
    consoleTimers.set(String(label), performance?.now?.() ?? Date.now());
  };
  globalThis.console.timeLog ??= (label = "default", ...args) => {
    const key = String(label);
    const started = consoleTimers.get(key) ?? (performance?.now?.() ?? Date.now());
    globalThis.console.log(`${key}: ${((performance?.now?.() ?? Date.now()) - started).toFixed(3)}ms`, ...args);
  };
  globalThis.console.timeEnd ??= (label = "default") => {
    const key = String(label);
    const started = consoleTimers.get(key) ?? (performance?.now?.() ?? Date.now());
    globalThis.console.log(`${key}: ${((performance?.now?.() ?? Date.now()) - started).toFixed(3)}ms`);
    consoleTimers.delete(key);
  };
  globalThis.console.trace ??= (...args) => {
    const label = args.length > 0 ? `Trace: ${args.map((arg) => typeof arg === "string" ? arg : nodeInspect(arg, { colors: false })).join(" ")}` : "Trace";
    const stack = new Error(label).stack;
    globalThis.console.error(stack || label);
  };
}

const promisePeekStates = globalThis.__cottontailPromisePeekStates ??= new WeakMap();

if (typeof Promise === "function" && !Promise.__cottontailPatchedPeek) {
  const originalResolve = Promise.resolve.bind(Promise);
  const originalReject = Promise.reject.bind(Promise);
  Promise.resolve = function(value) {
    const promise = originalResolve(value);
    promisePeekStates.set(promise, { status: "fulfilled", value });
    return promise;
  };
  Promise.reject = function(reason) {
    const promise = originalReject(reason);
    promisePeekStates.set(promise, { status: "rejected", value: reason });
    return promise;
  };
  Promise.__cottontailPatchedPeek = true;
}

if (typeof Promise === "function") {
  for (const name of ["all", "allSettled", "any", "race", "reject", "resolve", "withResolvers"]) {
    if (typeof Promise[name] !== "function") continue;
    Object.defineProperty(Promise, name, {
      value: Promise[name],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

function handledRejectedPromise(reason) {
  const promise = Promise.reject(reason);
  promise.catch(() => {});
  return promise;
}

if (!Object.__cottontailGlobalPrototypePatched) {
  const originalGetPrototypeOf = Object.getPrototypeOf;
  const originalSetPrototypeOf = Object.setPrototypeOf;
  let globalPrototype = originalGetPrototypeOf(globalThis);
  const globalPrototypeKeys = new Set();

  function clearMaterializedGlobalPrototype() {
    for (const key of globalPrototypeKeys) {
      try {
        delete globalThis[key];
      } catch {}
    }
    globalPrototypeKeys.clear();
  }

  function materializeGlobalPrototype(proto) {
    for (let cursor = proto; cursor; cursor = originalGetPrototypeOf(cursor)) {
      for (const key of Reflect.ownKeys(cursor)) {
        if (key in globalThis) continue;
        const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
        if (!descriptor) continue;
        try {
          Object.defineProperty(globalThis, key, { ...descriptor, configurable: true });
          globalPrototypeKeys.add(key);
        } catch {}
      }
    }
  }

  Object.getPrototypeOf = function getPrototypeOf(target) {
    if (target === globalThis) return globalPrototype;
    return originalGetPrototypeOf(target);
  };

  Object.setPrototypeOf = function setPrototypeOf(target, proto) {
    if (target === globalThis) {
      clearMaterializedGlobalPrototype();
      globalPrototype = proto;
      materializeGlobalPrototype(proto);
      return target;
    }
    return originalSetPrototypeOf(target, proto);
  };

  Object.defineProperty(Object, "__cottontailGlobalPrototypePatched", { value: true });
}

const internalPromiseThen = globalThis[Symbol.for("cottontail.nativePromiseThen")] ?? Promise.prototype.then;

function internalThen(promise, onFulfilled, onRejected) {
  return internalPromiseThen.call(promise, onFulfilled, onRejected);
}

function newInternalPromise(executor) {
  return new Promise(executor);
}

function suppressUserPromiseThenForInternalAwait() {
  const userThen = Promise.prototype.then;
  if (userThen === internalPromiseThen || userThen?.__cottontailInternalPromiseThen === true) return;
  function cottontailInternalPromiseThen(onFulfilled, onRejected) {
    return internalPromiseThen.call(this, onFulfilled, onRejected);
  }
  Object.defineProperty(cottontailInternalPromiseThen, "__cottontailInternalPromiseThen", { value: true });
  Promise.prototype.then = cottontailInternalPromiseThen;
  setTimeout(() => {
    if (Promise.prototype.then === cottontailInternalPromiseThen) Promise.prototype.then = userThen;
  }, 0);
}

for (const name of [
  "ReadableStream",
  "ReadableStreamBYOBReader",
  "ReadableStreamBYOBRequest",
  "ReadableStreamDefaultController",
  "ReadableStreamDefaultReader",
  "ReadableByteStreamController",
  "TransformStream",
  "TransformStreamDefaultController",
  "WritableStream",
  "WritableStreamDefaultController",
  "WritableStreamDefaultWriter",
  "ByteLengthQueuingStrategy",
  "CountQueuingStrategy",
  "CompressionStream",
  "DecompressionStream",
  "TextEncoderStream",
  "TextDecoderStream",
]) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && (typeof descriptor.value === "function" || typeof descriptor.get === "function")) continue;
  if (descriptor) delete globalThis[name];
  installLazyGlobal(name, () => streamWeb[name], () => {
    _patchAsyncContextGlobals();
    installReadableStreamConversionHelpers();
  });
}
_patchAsyncContextGlobals();
installReadableStreamConversionHelpers();

function consoleInputState() {
  const state = globalThis.console.__cottontailInput ??= {
    buffer: "",
    ended: false,
    error: null,
    started: false,
    waiters: [],
  };
  if (!state.started) {
    state.started = true;
    const stdin = globalThis.process?.stdin;
    stdin?.setEncoding?.("utf8");
    const wake = () => {
      for (const waiter of state.waiters.splice(0)) waiter();
    };
    stdin?.on?.("data", (chunk) => {
      state.buffer += String(chunk);
      wake();
    });
    stdin?.on?.("end", () => {
      state.ended = true;
      wake();
    });
    stdin?.on?.("error", (error) => {
      state.error = error;
      state.ended = true;
      wake();
    });
    stdin?.resume?.();
  }
  return state;
}

async function consoleReadLine() {
  const state = consoleInputState();
  for (;;) {
    if (state.error) throw state.error;
    const newline = state.buffer.indexOf("\n");
    if (newline >= 0) {
      let line = state.buffer.slice(0, newline);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      state.buffer = state.buffer.slice(newline + 1);
      return { value: line, done: false };
    }
    if (state.ended) {
      if (state.buffer.length > 0) {
        const value = state.buffer;
        state.buffer = "";
        return { value, done: false };
      }
      return { value: undefined, done: true };
    }
    await new Promise((resolve) => state.waiters.push(resolve));
  }
}

if (globalThis.console && typeof globalThis.console.write !== "function") {
  globalThis.console.write = (chunk = "") => {
    globalThis.process?.stdout?.write?.(String(chunk));
  };
}

if (globalThis.console && typeof globalThis.console[Symbol.asyncIterator] !== "function") {
  globalThis.console[Symbol.asyncIterator] = async function* consoleAsyncIterator() {
    for (;;) {
      const next = await consoleReadLine();
      if (next.done) return;
      yield next.value;
    }
  };
}

function writeOutputBuffer(buffer, data) {
  const view = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : null;
  if (!view) return;
  const bytes = asBuffer(data);
  view.set(bytes.subarray(0, view.byteLength));
}

const loadBunShellModule = createLazyModule("bun:shell", () => {
  const { createBunShellFacade } = loadEmbeddedRuntimeModule("bun/shell.js");
  const facade = createBunShellFacade({
    asBuffer,
    bytesFromBody,
    concatManyBuffers,
    cottontail,
    ctRemapStackString,
    currentProcessEnv,
    isBunFileLike,
    loadEmbeddedRuntimeModule,
    nodeCpSync,
    nodePathBasename,
    nodePathJoin,
    nodePathResolve,
    parseBunShellSource,
    pathJoin,
    randomUUID,
    shellEscape,
    spawn,
    tmpRoot,
    validateNoNullByte,
    which,
  });
  Object.assign(facade.$, {
    Shell,
    ShellError,
    ShellExpression,
    ShellOutput,
    ShellPromise,
  });
  return facade;
});
export const $ = createLazyFunction(loadBunShellModule, "$", "$");
export const Shell = createLazyFunction(loadBunShellModule, "Shell");
export const ShellError = createLazyFunction(loadBunShellModule, "ShellError");
export const ShellExpression = createLazyFunction(loadBunShellModule, "ShellExpression");
export const ShellOutput = createLazyFunction(loadBunShellModule, "ShellOutput");
export const ShellPromise = createLazyFunction(loadBunShellModule, "ShellPromise");


function getRandomValues(view) {
  if (!ArrayBuffer.isView(view) || view instanceof DataView) {
    throw new TypeError("crypto.getRandomValues requires an integer typed array");
  }
  if (view.byteLength > 65536) {
    throw new Error("crypto.getRandomValues quota exceeded");
  }

  new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(randomBytes(view.byteLength));
  return view;
}


function pathJoin(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

function tmpRoot(kind) {
  const env = BunObject.env ?? cottontail.env();
  const base = String(env.COTTONTAIL_TMP_DIR || env.TMPDIR || env.TEMP || env.TMP || "/tmp");
  return pathJoin(base, "cottontail", kind);
}

function isExecutableFile(path) {
  try {
    const stat = cottontail.statSync(String(path), true);
    if (!stat?.isFile) return false;
    if (cottontail.platform() === "win32") return true;
    return (Number(stat.mode) & 0o111) !== 0;
  } catch {
    return false;
  }
}

const windowsExecutableExtensions = [".exe", ".cmd", ".bat"];
const canonicalWindowsSystemRoots = new Map();

function executableCandidates(path, isWindows) {
  const lowerPath = path.toLowerCase();
  if (!isWindows || windowsExecutableExtensions.some(extension => lowerPath.endsWith(extension))) {
    return [path];
  }
  return windowsExecutableExtensions.map(extension => `${path}${extension}`);
}

function windowsSystemRootInfo(env) {
  const systemRootValue = env.SystemRoot ?? env.SYSTEMROOT ?? env.systemroot;
  if (systemRootValue == null) return ["", ""];
  const systemRoot = String(systemRootValue).replace(/[\\/]+$/, "");
  if (!systemRoot) return ["", ""];
  const comparableRoot = systemRoot.replaceAll("/", "\\").toLowerCase();
  let canonicalRoot = canonicalWindowsSystemRoots.get(comparableRoot);
  if (canonicalRoot === undefined) {
    try { canonicalRoot = cottontail.realpathSync(systemRoot); } catch { canonicalRoot = null; }
    canonicalWindowsSystemRoots.set(comparableRoot, canonicalRoot);
  }
  return [systemRoot, canonicalRoot ?? ""];
}

function which(command, options = undefined) {
  const value = String(command || "");
  if (!value) return null;
  if (value.length > 4096) throw new Error("bin path is too long");
  const isWindows = cottontail.platform() === "win32";
  const lookupCwd = String(options?.cwd ?? cottontail.cwd());
  if (value.includes("/") || value.includes("\\")) {
    const candidate = nodePathResolve(lookupCwd, value);
    let displayedCandidate = candidate;
    if (isWindows && nodePathIsAbsolute(value)) {
      displayedCandidate = value;
    } else if (isWindows && value.startsWith(".\\")) {
      displayedCandidate = `${nodePathResolve(lookupCwd)}\\${value}`;
    }
    const resolvedCandidates = executableCandidates(candidate, isWindows);
    const displayedCandidates = executableCandidates(displayedCandidate, isWindows);
    for (let index = 0; index < resolvedCandidates.length; index += 1) {
      if (isExecutableFile(resolvedCandidates[index])) return displayedCandidates[index];
    }
    return null;
  }

  const env = BunObject.env ?? cottontail.env();
  const pathValue = String(options?.PATH ?? options?.Path ?? options?.path ?? env.PATH ?? env.Path ?? env.path ?? "");
  const [systemRoot, canonicalSystemRoot] = isWindows
    ? windowsSystemRootInfo(env)
    : ["", ""];
  return cottontail.whichPathNative(
    pathValue,
    lookupCwd,
    value,
    systemRoot,
    canonicalSystemRoot,
  );
}

const ctInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
const ctBuildArtifactContentHashSymbol = Symbol.for("cottontail.buildArtifactContentHash");
const loadBunBuildModule = createLazyModule("bun:build", () => {
  const { createBunBuildFacade } = loadEmbeddedRuntimeModule("bun/build.js");
  return createBunBuildFacade({
    Transpiler,
    cottontail,
    file,
    hash,
    nodeIsBuiltin,
    nodePathBasename,
    nodePathIsAbsolute,
    nodePathRelative,
    nodePathResolve,
    pathDirname,
    pathJoin,
    resolveSync,
    tmpRoot,
  });
});
const CTBuildMessage = createLazyFunction(loadBunBuildModule, "CTBuildMessage", "BuildMessage");
const CTResolveMessage = createLazyFunction(loadBunBuildModule, "CTResolveMessage", "ResolveMessage");
export const build = createLazyFunction(loadBunBuildModule, "build");
if (typeof globalThis.BuildMessage !== "function") globalThis.BuildMessage = CTBuildMessage;
if (typeof globalThis.ResolveMessage !== "function") globalThis.ResolveMessage = CTResolveMessage;
globalThis.BuildError = globalThis.BuildMessage;
globalThis.ResolveError = globalThis.ResolveMessage;


function normalizeCommand(command, maybeArgs = undefined, maybeOptions = undefined) {
  return normalizeBunSpawnCommand(command, maybeArgs, maybeOptions);
}

function stdioFileDescriptor(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (value != null && typeof value === "object" && typeof value.fd === "number" && Number.isInteger(value.fd)) {
    return value.fd;
  }
  return null;
}

function normalizeStdio(value, fallback, index, details) {
  const recordExtra = normalized => {
    if (index <= 2) return;
    details.extraStdio ??= [];
    details.extraStdio[index - 3] = normalized;
  };
  if (value === undefined) {
    recordExtra(fallback);
    return fallback;
  }
  if (value === null) {
    recordExtra("ignore");
    return "ignore";
  }
  if (typeof value === "string") {
    if (value === "overlapped") {
      recordExtra("pipe");
      return "pipe";
    }
    if (value === "pipe" || value === "inherit" || value === "ignore") {
      recordExtra(value);
      return value;
    }
    if (value === "ipc" && index > 2) {
      if (details.ipcIndex != null) throw new TypeError("Child process can have only one IPC pipe");
      details.ipcIndex = index;
      recordExtra("ipc");
      return "ipc";
    }
    throw new TypeError("stdio must be an array of 'inherit', 'pipe', 'ignore', Bun.file(pathOrFd), number, or null");
  }

  const fd = stdioFileDescriptor(value);
  if (fd != null) {
    if (fd < 0) throw new TypeError("file descriptor must be a positive integer");
    if (index === 0 && (fd === 1 || fd === 2)) {
      throw new TypeError("stdout and stderr cannot be used for stdin");
    }
    if ((index === 1 || index === 2) && fd === 0) {
      throw new TypeError("stdin cannot be used for stdout or stderr");
    }
    if (index > 2) recordExtra(fd);
    else details[`${index === 0 ? "stdin" : index === 1 ? "stdout" : "stderr"}Fd`] = fd;
    return "inherit";
  }

  const isSharedBuffer = typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer;
  if (index === 0) {
    if ((value instanceof ArrayBuffer || isSharedBuffer || ArrayBuffer.isView(value)) && value.byteLength === 0) return "ignore";
    if (typeof globalThis.Blob === "function" && value instanceof globalThis.Blob && value.size === 0) return "ignore";
    if (isBunFileLike(value) || isReadableStreamLike(value) || value instanceof ArrayBuffer || isSharedBuffer ||
        ArrayBuffer.isView(value) || (typeof globalThis.Blob === "function" && value instanceof globalThis.Blob) ||
        typeof value?.arrayBuffer === "function" || typeof value?.bytes === "function") {
      details.input = value;
      return "pipe";
    }
  } else {
    const outputName = index === 1 ? "stdout" : "stderr";
    if (isBunFileLike(value) && typeof value._bunFilePath === "string") {
      details[`${outputName}FilePath`] = value._bunFilePath;
      return "pipe";
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      if (value.byteLength === 0) return "ignore";
      details[`${outputName}Buffer`] = value;
      return "pipe";
    }
    if (isReadableStreamLike(value)) {
      throw new TypeError(`ReadableStream cannot be used for ${outputName} yet. For now, do .${outputName}`);
    }
    if (typeof globalThis.Blob === "function" && value instanceof globalThis.Blob) {
      throw new TypeError("Blobs are immutable, and cannot be used for stdout/stderr");
    }
  }

  throw new TypeError("stdio must be an array of 'inherit', 'pipe', 'ignore', Bun.file(pathOrFd), number, or null");
}

function normalizeSpawnOptions(options = {}, defaults = {}, sync = false) {
  if (options == null || typeof options !== "object") options = {};
  validateBunSpawnCallbacks(options, sync);
  assertBunAbortSignal(options.signal);
  let terminal;
  if (!sync && !isEmptyBunSpawnOption(options.terminal)) {
    if (typeof options.terminal !== "object") {
      throw new TypeError("terminal must be a Terminal object or options object");
    }
    terminal = options.terminal instanceof Terminal
      ? options.terminal
      : new Terminal(options.terminal);
    if (terminal.closed) throw new Error("terminal is closed");
  }

  const details = {};
  let stdin = defaults.stdin ?? "ignore";
  let stdout = defaults.stdout ?? "pipe";
  let stderr = defaults.stderr ?? "inherit";

  if (options.stdio !== undefined) {
    if (Array.isArray(options.stdio)) {
      stdin = normalizeStdio(options.stdio[0], stdin, 0, details);
      stdout = normalizeStdio(options.stdio[1], stdout, 1, details);
      stderr = normalizeStdio(options.stdio[2], stderr, 2, details);
      for (let index = 3; index < options.stdio.length; index += 1) {
        normalizeStdio(options.stdio[index], "ignore", index, details);
      }
      while (details.extraStdio?.length > 0 && details.extraStdio[details.extraStdio.length - 1] === "ignore") {
        details.extraStdio.pop();
      }
    } else if (options.stdio !== null) {
      throw new TypeError("stdio must be an array");
    }
  } else {
    stdin = normalizeStdio(options.stdin, stdin, 0, details);
    stdout = normalizeStdio(options.stdout, stdout, 1, details);
    stderr = normalizeStdio(options.stderr, stderr, 2, details);
  }

  let input = options.input ?? details.input;
  if (typeof SharedArrayBuffer === "function" && input instanceof SharedArrayBuffer) {
    input = sharedArrayBufferBytes(input);
  }
  const stdinFileBacked = input != null && isBunFileLike(input) && typeof input._bunFilePath === "string";
  // Bun.file(...) as stdin: read the file contents and feed them as input,
  // matching bun's behavior of wiring the file to the child's stdin.
  if (stdinFileBacked) {
    try {
      input = asBuffer(cottontail.readFileBuffer ? cottontail.readFileBuffer(input._bunFilePath) : cottontail.readFile(input._bunFilePath));
    } catch {
      input = asBuffer("");
    }
  }
  if (sync && isReadableStreamLike(input)) {
    throw new TypeError("'stdin' ReadableStream cannot be used in sync mode");
  }
  if (sync && typeof globalThis.Blob === "function" && input instanceof globalThis.Blob) {
    input = blobBytesSync(input);
  }
  if (input != null && input !== "pipe" && input !== "inherit" && input !== "ignore") {
    stdin = "pipe";
  }
  // Bun.file(...) as stdout/stderr: capture the stream and persist it to the
  // target file once the process finishes.
  const timeout = normalizeBunSpawnTimeout(options.timeout);
  const parsedMaxBuffer = normalizeBunSpawnMaxBuffer(options.maxBuffer);
  const maxBuffer = parsedMaxBuffer != null && (stdin === "pipe" || stdout === "pipe" || stderr === "pipe")
    ? parsedMaxBuffer
    : undefined;
  const killSignalNumber = bunSignalNumber(options.killSignal);
  let env;
  let clearEnv = false;
  if (!isEmptyBunSpawnOption(options.env)) {
    if (typeof options.env !== "object") throw new TypeError("env must be an object");
    env = sanitizeSpawnEnv(options.env);
    clearEnv = true;
  }

  return {
    cwd: isEmptyBunSpawnOption(options.cwd) ? undefined : String(options.cwd),
    env,
    clearEnv,
    stdin,
    stdout,
    stderr,
    stdoutFilePath: details.stdoutFilePath,
    stderrFilePath: details.stderrFilePath,
    stdoutBuffer: details.stdoutBuffer,
    stderrBuffer: details.stderrBuffer,
    stdinFd: details.stdinFd,
    stdoutFd: details.stdoutFd,
    stderrFd: details.stderrFd,
    extraStdio: details.extraStdio,
    stdinFileBacked,
    input: input != null && input !== "pipe" && input !== "inherit" && input !== "ignore" ? input : undefined,
    killSignal: killSignalNumber,
    maxBuffer,
    timeout,
    ipc: !sync && (typeof options.ipc === "function" || details.ipcIndex != null),
    signal: isEmptyBunSpawnOption(options.signal) ? undefined : options.signal,
    argv0: isEmptyBunSpawnOption(options.argv0) ? undefined : String(options.argv0),
    detached: options.detached === true,
    windowsHide: typeof options.windowsHide === "boolean" ? options.windowsHide : false,
    windowsVerbatimArguments: typeof options.windowsVerbatimArguments === "boolean"
      ? options.windowsVerbatimArguments
      : false,
    lazy: options.lazy === true,
    serialization: options.serialization === "json" ? "json" : "advanced",
    onExit: isEmptyBunSpawnOption(options.onExit) ? undefined : _wrapAsyncCallback(options.onExit),
    onDisconnect: isEmptyBunSpawnOption(options.onDisconnect) ? undefined : _wrapAsyncCallback(options.onDisconnect),
    ipcCallback: typeof options.ipc === "function" ? _wrapAsyncCallback(options.ipc) : undefined,
    terminal,
  };
}

function sanitizeSpawnEnv(env) {
  if (env === undefined || env === null) return env;
  const sanitized = {};
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value === undefined) continue;
    sanitized[key] = String(value);
  }
  return sanitized;
}

function currentProcessEnv() {
  return { ...(globalThis.process?.env ?? BunObject.env ?? cottontail.env()) };
}

function withoutElectrobunHostEnv(env) {
  const next = { ...(env ?? {}) };
  for (const key of Object.keys(next)) {
    if (key.startsWith("COTTONTAIL_ELECTROBUN_")) delete next[key];
  }
  return next;
}

function isCurrentCottontailExecutable(file) {
  const execPath = String(cottontail.execPath?.() ?? globalThis.process?.execPath ?? "");
  return execPath.length > 0 && String(file) === execPath;
}

// Facade mode: process.execPath displays the wrapper (hutch) path while the
// native execPath is the real runtime. Spawning the facade path must NOT be
// treated as spawning the runtime itself — the deferred-start spawn gate
// would inject a --cottontail-spawn-gate argv the wrapper cannot parse — but
// the child still needs the facade routing vars to find the runtime.
function isFacadeDisplayExecutable(file) {
  const display = String(globalThis.process?.execPath ?? "");
  const native = String(cottontail.execPath?.() ?? "");
  return display.length > 0 && display !== native && String(file) === display;
}

function prepareNativeSpawnOptions(file, nativeOptions, args = []) {
  if (isCurrentCottontailExecutable(file)) {
    // COTTONTAIL-COMPAT: spawn argv0 - Cottontail children use this internal
    // override; arbitrary executables still need the native hooks to set
    // argv[0] before exec.
    const env = nativeOptions.env === undefined
      ? withoutElectrobunHostEnv(currentProcessEnv())
      : { ...nativeOptions.env };
    env.COTTONTAIL_SPAWN_EXEC_PATH = nodePathResolve(String(file));
    if (nativeOptions.argv0 !== undefined) env.COTTONTAIL_SPAWN_ARGV0 = nativeOptions.argv0;
    if (nativeOptions.stdinFileBacked) env.COTTONTAIL_SPAWN_STDIN_FILE = "1";
    return {
      ...nativeOptions,
      env,
      clearEnv: true,
    };
  }
  if (isFacadeDisplayExecutable(file)) {
    // Facade routing must survive an explicit spawn env (e.g. `env: {}`):
    // without it the child wrapper cannot locate the runtime at all.
    const env = nativeOptions.env === undefined
      ? withoutElectrobunHostEnv(currentProcessEnv())
      : { ...nativeOptions.env };
    for (const key of ["DASH_COTTONTAIL", "COTTONTAIL_BINARY"]) {
      if (env[key] === undefined) {
        const inherited = currentProcessEnv()[key];
        if (inherited !== undefined) env[key] = String(inherited);
      }
    }
    return {
      ...nativeOptions,
      env,
      clearEnv: true,
    };
  }
  if (nativeOptions.env !== undefined) {
    return {
      ...nativeOptions,
      clearEnv: true,
    };
  }
  return nativeOptions;
}

// ---------------------------------------------------------------------------
// The host-provided Buffer lacks the numeric read/write API (readUInt16BE,
// writeUInt32LE, swap16, ...). Fill in the missing prototype methods here so
// Buffer behaves like node's for the ecosystem (ws, etc.).
// ---------------------------------------------------------------------------
(function patchBufferNumericMethods() {
  const BufferCtor = globalThis.Buffer;
  const proto = BufferCtor?.prototype;
  if (!proto || typeof proto.readUInt16BE === "function") return;

  const outOfRange = (name, value, min, max) => {
    const error = new RangeError(
      `The value of "${name}" is out of range. It must be >= ${min} and <= ${max}. Received ${value}`,
    );
    error.code = "ERR_OUT_OF_RANGE";
    return error;
  };

  const checkOffset = (buffer, offset, size) => {
    const numeric = offset === undefined ? 0 : Number(offset);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric + size > buffer.length) {
      throw outOfRange("offset", offset, 0, Math.max(0, buffer.length - size));
    }
    return numeric;
  };

  const checkValue = (value, min, max) => {
    const numeric = typeof value === "bigint" ? value : Number(value);
    if (typeof numeric !== "bigint" && !Number.isFinite(numeric)) {
      throw outOfRange("value", value, min, max);
    }
    if (numeric < min || numeric > max) throw outOfRange("value", value, min, max);
    return numeric;
  };

  const view = (buffer) => new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const define = (name, fn) => {
    if (typeof proto[name] === "function") return;
    Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true });
  };

  const fixed = [
    ["UInt8", 1, "getUint8", "setUint8", 0, 0xff],
    ["UInt16", 2, "getUint16", "setUint16", 0, 0xffff],
    ["UInt32", 4, "getUint32", "setUint32", 0, 0xffffffff],
    ["Int8", 1, "getInt8", "setInt8", -0x80, 0x7f],
    ["Int16", 2, "getInt16", "setInt16", -0x8000, 0x7fff],
    ["Int32", 4, "getInt32", "setInt32", -0x80000000, 0x7fffffff],
  ];
  for (const [label, size, getter, setter, min, max] of fixed) {
    const suffixes = size === 1 ? [["", true]] : [["BE", false], ["LE", true]];
    for (const [suffix, littleEndian] of suffixes) {
      const endianArgs = size === 1 ? [] : [littleEndian];
      define(`read${label}${suffix}`, function (offset = 0) {
        const at = checkOffset(this, offset, size);
        return view(this)[getter](at, ...endianArgs);
      });
      define(`write${label}${suffix}`, function (value, offset = 0) {
        const at = checkOffset(this, offset, size);
        view(this)[setter](at, checkValue(value, min, max), ...endianArgs);
        return at + size;
      });
      // node also exposes readUint*/writeUint* aliases.
      if (label.startsWith("UInt")) {
        define(`read${label.replace("UInt", "Uint")}${suffix}`, proto[`read${label}${suffix}`]);
        define(`write${label.replace("UInt", "Uint")}${suffix}`, proto[`write${label}${suffix}`]);
      }
    }
  }

  const bigFixed = [
    ["BigUInt64", "getBigUint64", "setBigUint64", 0n, 0xffffffffffffffffn],
    ["BigInt64", "getBigInt64", "setBigInt64", -0x8000000000000000n, 0x7fffffffffffffffn],
  ];
  for (const [label, getter, setter, min, max] of bigFixed) {
    for (const [suffix, littleEndian] of [["BE", false], ["LE", true]]) {
      define(`read${label}${suffix}`, function (offset = 0) {
        const at = checkOffset(this, offset, 8);
        return view(this)[getter](at, littleEndian);
      });
      define(`write${label}${suffix}`, function (value, offset = 0) {
        const at = checkOffset(this, offset, 8);
        const bigValue = typeof value === "bigint" ? value : BigInt(value);
        if (bigValue < min || bigValue > max) throw outOfRange("value", value, min, max);
        view(this)[setter](at, bigValue, littleEndian);
        return at + 8;
      });
      if (label === "BigUInt64") {
        define(`readBigUint64${suffix}`, proto[`read${label}${suffix}`]);
        define(`writeBigUint64${suffix}`, proto[`write${label}${suffix}`]);
      }
    }
  }

  for (const [label, size, getter, setter] of [
    ["Float", 4, "getFloat32", "setFloat32"],
    ["Double", 8, "getFloat64", "setFloat64"],
  ]) {
    for (const [suffix, littleEndian] of [["BE", false], ["LE", true]]) {
      define(`read${label}${suffix}`, function (offset = 0) {
        const at = checkOffset(this, offset, size);
        return view(this)[getter](at, littleEndian);
      });
      define(`write${label}${suffix}`, function (value, offset = 0) {
        const at = checkOffset(this, offset, size);
        view(this)[setter](at, Number(value), littleEndian);
        return at + size;
      });
    }
  }
  const checkByteLength = (byteLength) => {
    const size = Number(byteLength);
    if (!Number.isInteger(size) || size < 1 || size > 6) {
      throw outOfRange("byteLength", byteLength, 1, 6);
    }
    return size;
  };

  define("readUIntBE", function (offset, byteLength) {
    const size = checkByteLength(byteLength);
    const at = checkOffset(this, offset, size);
    let value = 0;
    for (let index = 0; index < size; index += 1) value = value * 0x100 + this[at + index];
    return value;
  });
  define("readUIntLE", function (offset, byteLength) {
    const size = checkByteLength(byteLength);
    const at = checkOffset(this, offset, size);
    let value = 0;
    for (let index = size - 1; index >= 0; index -= 1) value = value * 0x100 + this[at + index];
    return value;
  });
  define("readIntBE", function (offset, byteLength) {
    const size = checkByteLength(byteLength);
    const unsigned = this.readUIntBE(offset, size);
    const limit = 2 ** (size * 8 - 1);
    return unsigned >= limit ? unsigned - 2 ** (size * 8) : unsigned;
  });
  define("readIntLE", function (offset, byteLength) {
    const size = checkByteLength(byteLength);
    const unsigned = this.readUIntLE(offset, size);
    const limit = 2 ** (size * 8 - 1);
    return unsigned >= limit ? unsigned - 2 ** (size * 8) : unsigned;
  });
  define("writeUIntBE", function (value, offset, byteLength) {
    const size = checkByteLength(byteLength);
    const at = checkOffset(this, offset, size);
    let remaining = checkValue(value, 0, 2 ** (size * 8) - 1);
    for (let index = size - 1; index >= 0; index -= 1) {
      this[at + index] = remaining & 0xff;
      remaining = Math.floor(remaining / 0x100);
    }
    return at + size;
  });
  define("writeUIntLE", function (value, offset, byteLength) {
    const size = checkByteLength(byteLength);
    const at = checkOffset(this, offset, size);
    let remaining = checkValue(value, 0, 2 ** (size * 8) - 1);
    for (let index = 0; index < size; index += 1) {
      this[at + index] = remaining & 0xff;
      remaining = Math.floor(remaining / 0x100);
    }
    return at + size;
  });
  define("writeIntBE", function (value, offset, byteLength) {
    const size = checkByteLength(byteLength);
    const limit = 2 ** (size * 8 - 1);
    const numeric = checkValue(value, -limit, limit - 1);
    return this.writeUIntBE(numeric < 0 ? numeric + 2 ** (size * 8) : numeric, offset, size);
  });
  define("writeIntLE", function (value, offset, byteLength) {
    const size = checkByteLength(byteLength);
    const limit = 2 ** (size * 8 - 1);
    const numeric = checkValue(value, -limit, limit - 1);
    return this.writeUIntLE(numeric < 0 ? numeric + 2 ** (size * 8) : numeric, offset, size);
  });

  const defineSwap = (name, width) => {
    define(name, function () {
      if (this.length % width !== 0) {
        const error = new RangeError(`Buffer size must be a multiple of ${width * 8}-bit${width > 2 ? "s" : ""}`);
        error.code = "ERR_INVALID_BUFFER_SIZE";
        throw error;
      }
      for (let index = 0; index < this.length; index += width) {
        for (let step = 0; step < width / 2; step += 1) {
          const left = this[index + step];
          this[index + step] = this[index + width - 1 - step];
          this[index + width - 1 - step] = left;
        }
      }
      return this;
    });
  };
  defineSwap("swap16", 2);
  defineSwap("swap32", 4);
  defineSwap("swap64", 8);

  define("compare", function (target, targetStart = 0, targetEnd = undefined, sourceStart = 0, sourceEnd = undefined) {
    const other = asBuffer(target);
    const a = this.subarray(sourceStart, sourceEnd ?? this.length);
    const b = other.subarray(targetStart, targetEnd ?? other.length);
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    }
    if (a.length === b.length) return 0;
    return a.length < b.length ? -1 : 1;
  });

  define("toJSON", function () {
    return { type: "Buffer", data: Array.from(this) };
  });
})();

let bunSpawnRuntime;

function getBunSpawnRuntime() {
  return bunSpawnRuntime ??= createBunSpawnRuntime({
    abortSignalState,
    asBuffer,
    bytesFromBody,
    concatChunks: concatManyBuffers,
    isCurrentExecutable: isCurrentCottontailExecutable,
    normalizeCommand,
    normalizeOptions: normalizeSpawnOptions,
    prepareNativeOptions: prepareNativeSpawnOptions,
    resolvePath: nodePathResolve,
    terminalProcessExited,
    terminalSpawnFd,
    validateInput: validateSpawnInput,
    writeOutputBuffer,
  });
}

export function spawnSync(...args) {
  return getBunSpawnRuntime().spawnSync(...args);
}

export function spawn(...args) {
  return getBunSpawnRuntime().spawn(...args);
}
let arrayBufferFromBytes;
let bodyBlobSourceSymbol;
let bodyReadableStream;
let bodyValueForConsumption;
let bunString;
let bytesFromBody;
let bytesFromData;
let consumeStreamingBody;
let encodeMultipartFormData;
let externallyOwnedBodyBytes;
let fetchBodyStartSymbol;
let FormData;
let formDataBoundary;
let Headers;
let headersGetAll;
let inspectBodyByteSize;
let invalidHeaderErrorSymbol;
let isObjectLike;
let isURLSearchParamsLike;
let normalizeRequestUrl;
let normalizeServeDispatchUrl;
let parseMultipartFormData;
let parseMultipartFormDataText;
let Request;
let requestState;
let requestWithLazyURL;
let Response;
let responseWithMetadata;
let sharedArrayBufferBytes;
let stringLatin1FromBytes;
let stripUtf8BOMText;

export { FormData, Headers, Request, Response, URL, URLSearchParams };

const activeServeOrigins = globalThis.__cottontailActiveServeOrigins ??= new Map();
const activeServeDispatches = globalThis.__cottontailActiveServeDispatches ??= new WeakMap();
const activeServeAbortControllers = globalThis.__cottontailActiveServeAbortControllers ??= new WeakMap();
const activeServeLifecycles = globalThis.__cottontailActiveServeLifecycles ??= new WeakMap();
const activeServeRequestBodyStateSymbol = Symbol("cottontail.activeServeRequestBodyState");

function setServeRequestIdleTimeout(request, seconds, isUnix, argumentCount) {
  if (argumentCount < 2 || request == null) {
    throw new TypeError(`timeout() requires 2 arguments, got ${argumentCount}`);
  }
  if (isUnix) return null;
  if (typeof seconds !== "number") throw new TypeError("timeout() requires a number");
  const integer = Number.isFinite(seconds) ? Math.trunc(seconds) : 0;
  const value = Math.min(255, integer >>> 0);
  if (request instanceof Request) {
    const state = requestState.get(request);
    if (state == null) throw new TypeError("timeout() requires a Request object");
    state.serveIdleTimeout = value;
  } else if (request instanceof nodeHttp.ServerResponse) {
    request.setTimeout(value * 1000);
  } else {
    throw new TypeError("timeout() requires a Request object");
  }
  return undefined;
}

function requestIdleTimeout(request, fallback) {
  return requestState.get(request)?.serveIdleTimeout ?? fallback;
}

function abortActiveServeRequests(server) {
  const controllers = activeServeAbortControllers.get(server);
  if (controllers == null) return;
  const error = new Error("The socket connection was closed unexpectedly.");
  error.code = "ECONNRESET";
  for (const controller of controllers) controller.abort(error);
  controllers.clear();
}

function activeServerForFetchUrl(urlText) {
  if (activeServeOrigins.size === 0) return null;
  try {
    const url = new URL(urlText);
    const rawHostname = String(url.hostname).slice(String(url.hostname).lastIndexOf("@") + 1);
    const hostname = rawHostname.includes(":") && !rawHostname.startsWith("[") ? `[${rawHostname}]` : rawHostname;
    const authority = `${hostname}${url.port ? `:${url.port}` : ""}`;
    const direct = activeServeOrigins.get(`${url.protocol}//${authority}`);
    if (direct) return direct;
    if (url.hostname === "localhost") return activeServeOrigins.get(`${url.protocol}//127.0.0.1:${url.port}`);
    if (hostname === "0.0.0.0" || hostname === "[::]" || hostname === "[::1]") {
      return activeServeOrigins.get(`${url.protocol}//127.0.0.1:${url.port}`)
        ?? activeServeOrigins.get(`${url.protocol}//localhost:${url.port}`);
    }
  } catch {}
  return null;
}

function fetchProxyConfiguration(urlText, init = {}, parsedUrl = null) {
  const explicit = init?.proxy;
  if (explicit != null) {
    const rawValue = typeof explicit === "object" && !Array.isArray(explicit)
      ? explicit.url
      : explicit;
    if (rawValue == null && typeof explicit === "object") {
      return { active: false, explicit: null, environment: null, disabled: false, headers: null };
    }
    let value = String(rawValue ?? "").trim();
    if (value === "") {
      if (typeof explicit === "object") throw new TypeError("fetch() proxy.url must be a non-empty string");
      return { active: false, explicit: null, environment: null, disabled: true, headers: null };
    }
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) value = `http://${value}`;
    let parsedProxy;
    try { parsedProxy = new URL(value); } catch { throw new TypeError("fetch() proxy URL is invalid"); }
    if (parsedProxy.protocol !== "http:" && parsedProxy.protocol !== "https:") {
      const error = new Error(
        `UnsupportedProxyProtocol fetching "${urlText}". For more information, pass \`verbose: true\` in the second argument to fetch()`,
      );
      error.code = "UnsupportedProxyProtocol";
      error.path = urlText;
      error.errno = 0;
      throw error;
    }
    const env = globalThis.process?.env ?? {};
    if (noProxyMatches(urlText, env.NO_PROXY ?? env.no_proxy ?? "")) {
      return { active: false, explicit: null, environment: null, disabled: true, headers: null };
    }
    value = parsedProxy.href;
    return {
      active: true,
      explicit: value,
      environment: null,
      disabled: false,
      headers: typeof explicit === "object" ? new Headers(explicit.headers) : null,
    };
  }

  let protocol = parsedUrl?.protocol ?? "http:";
  if (parsedUrl == null) {
    try { protocol = new URL(urlText).protocol; } catch {}
  }
  const env = globalThis.process?.env ?? {};
  const names = protocol === "https:"
    ? ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"]
    : ["http_proxy", "HTTP_PROXY"];
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(env, name)) continue;
    const value = String(env[name] ?? "").trim();
    if (value === "" || value === "undefined" || value === "''" || value === '\"\"') {
      return { active: false, explicit: null, environment: null, disabled: true, headers: null };
    }
    const bypass = noProxyMatches(urlText, env.NO_PROXY ?? env.no_proxy ?? "");
    return {
      active: !bypass,
      explicit: null,
      environment: bypass ? null : value,
      disabled: bypass,
      headers: null,
    };
  }
  return { active: false, explicit: null, environment: null, disabled: false, headers: null };
}

function noProxyMatches(urlText, noProxy) {
  let url;
  try { url = new URL(urlText); } catch { return false; }
  const host = String(url.hostname).slice(String(url.hostname).lastIndexOf("@") + 1).replace(/^\[|\]$/g, "").toLowerCase();
  const port = String(url.port || (url.protocol === "https:" ? "443" : "80"));
  for (const rawEntry of String(noProxy).split(",")) {
    let entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    let entryHost = entry;
    let entryPort = "";
    if (entry.startsWith("[")) {
      const end = entry.indexOf("]");
      if (end >= 0) {
        entryHost = entry.slice(1, end);
        if (entry[end + 1] === ":") entryPort = entry.slice(end + 2);
      }
    } else {
      const colon = entry.lastIndexOf(":");
      if (colon > 0 && entry.indexOf(":") === colon && /^\d+$/.test(entry.slice(colon + 1))) {
        entryHost = entry.slice(0, colon);
        entryPort = entry.slice(colon + 1);
      }
    }
    if (entryPort && entryPort !== port) continue;
    const normalized = entryHost.replace(/^\./, "");
    if (host === normalized || host.endsWith(`.${normalized}`)) return true;
  }
  return false;
}

async function fetchFromActiveProxy(activeProxy, proxyUrl, request) {
  const headers = new Headers(request.headers);
  headers.set("proxy-connection", "Keep-Alive");
  try {
    const authority = String(proxyUrl).match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/)?.[1] ?? "";
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
      const userInfo = authority.slice(0, at);
      const colon = userInfo.indexOf(":");
      const username = colon >= 0 ? userInfo.slice(0, colon) : userInfo;
      const password = colon >= 0 ? userInfo.slice(colon + 1) : "";
      const credentials = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
      headers.set("proxy-authorization", `Basic ${Buffer.from(credentials).toString("base64")}`);
    }
  } catch {}
  const proxyRequest = new Request(request.url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request._body,
    redirect: request.redirect,
    signal: request.signal,
  });
  const response = await activeProxy.fetch(proxyRequest);
  response.url = request.url;
  return response;
}

function percentDecodeDataUrlPayload(payload) {
  const bytes = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < payload.length;) {
    if (payload[index] === "%" && /^[0-9A-Fa-f]{2}$/.test(payload.slice(index + 1, index + 3))) {
      bytes.push(parseInt(payload.slice(index + 1, index + 3), 16));
      index += 3;
      continue;
    }
    const codePoint = payload.codePointAt(index);
    const character = String.fromCodePoint(codePoint);
    bytes.push(...encoder.encode(character));
    index += character.length;
  }
  return Buffer.from(bytes);
}

function responseFromDataUrl(urlText) {
  const match = /^data:([^,]*),([\s\S]*)$/.exec(urlText);
  if (!match) throw new TypeError("failed to fetch the data URL");
  const meta = match[1] ?? "";
  const isBase64 = /;base64$/i.test(meta);
  let type = meta.replace(/;base64$/i, "") || "text/plain;charset=utf-8";
  if (/^text\/plain$/i.test(type)) type = "text/plain;charset=utf-8";
  let bytes;
  if (isBase64) {
    const encoded = percentDecodeDataUrlPayload(match[2]).toString("latin1").replace(/\s+/g, "");
    if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new TypeError("failed to fetch the data URL");
    }
    bytes = Buffer.from(encoded, "base64");
  } else {
    bytes = percentDecodeDataUrlPayload(match[2]);
  }
  return responseWithMetadata(bytes, {
    status: 200,
    statusText: "OK",
    headers: { "content-type": type },
  }, {
    url: urlText,
  });
}

// fetch.preconnect keeps an opened socket per origin that the raw-socket
// client will consume for its next request to that origin. Keepalive fetch
// requests also return their sockets here; custom TLS configs get their own
// pool key so different SSL configs never share a connection (#27358).
const preconnectedFetchSockets = new Map();

function fetchTlsSessionKey(tlsConfig) {
  const parts = [];
  for (const name of Object.keys(tlsConfig).sort()) {
    const value = tlsConfig[name];
    if (value == null) continue;
    parts.push(`${name}=${typeof value === "function" ? `fn:${value.name ?? ""}` : String(value)}`);
  }
  return parts.join(";");
}

function takePreconnectedSocket(originKey) {
  const list = preconnectedFetchSockets.get(originKey);
  while (list && list.length > 0) {
    const socket = list.shift();
    if (!socket.destroyed && socket.writable !== false) return socket;
  }
  return null;
}

function fetchPreconnect(url) {
  const parsed = new URL(String(url));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("preconnect requires an http: or https: URL");
  }
  if (!parsed.hostname) throw new TypeError("preconnect requires a hostname");
  const isHttps = parsed.protocol === "https:";
  const port = Number(parsed.port || (isHttps ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new TypeError("preconnect requires a valid port");
  }
  let hostname = String(parsed.hostname).replace(/^\[|\]$/g, "");
  if (hostname === "0.0.0.0") hostname = "127.0.0.1";
  const key = `${parsed.protocol}//${hostname}:${port}`;
  const socket = isHttps
    ? nodeTlsConnect({ host: hostname, port, servername: hostname, rejectUnauthorized: false })
    : nodeNet.connect(port, hostname);
  socket.on("error", () => {});
  socket.once("close", () => {
    const list = preconnectedFetchSockets.get(key);
    if (list) {
      const index = list.indexOf(socket);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) preconnectedFetchSockets.delete(key);
    }
  });
  const list = preconnectedFetchSockets.get(key) ?? [];
  list.push(socket);
  preconnectedFetchSockets.set(key, list);
  return undefined;
}

function fetchUsesKeepalive(request) {
  const state = requestState.get(request);
  return state?.keepaliveExplicit === true ? request.keepalive : true;
}

function applyDefaultFetchHeaders(request, keepalive = fetchUsesKeepalive(request), parsedUrl = null) {
  const headers = request.headers;
  if (!headers.has("user-agent")) {
    headers.set(
      "User-Agent",
      runtimeDefaultUserAgent(globalThis.navigator?.userAgent ?? `Bun/${BunObject.version ?? "1.0.0"}`),
    );
  }
  if (!headers.has("accept")) headers.set("Accept", "*/*");
  if (keepalive && !headers.has("connection")) headers.set("Connection", "keep-alive");
  if (!headers.has("accept-encoding")) headers.set("Accept-Encoding", "gzip, deflate, br, zstd");
  if (!headers.has("host")) {
    try {
      const url = parsedUrl ?? new URL(request.url);
      headers.set("Host", `${url.hostname}${url.port ? `:${url.port}` : ""}`);
    } catch {}
  }
  if (!headers.has("content-length") && !headers.has("transfer-encoding") &&
      request._body != null && request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
    const body = request._body;
    let length = null;
    if (typeof body === "string" || isURLSearchParamsLike(body)) length = Buffer.byteLength(String(body));
    else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) length = body.byteLength;
    else if (typeof body?.size === "number" && Number.isFinite(body.size)) length = Number(body.size);
    if (length != null) headers.set("Content-Length", String(length));
  }
}

function fetchPoolKey(urlText, tlsConfig = undefined) {
  const url = new URL(urlText);
  let hostname = String(url.hostname).replace(/^\[|\]$/g, "");
  if (hostname === "0.0.0.0") hostname = "127.0.0.1";
  else if (hostname === "::") hostname = "::1";
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return `${url.protocol}//${hostname}:${port}` +
    (tlsConfig ? `|tls:${fetchTlsSessionKey(tlsConfig)}` : "");
}

let lastParsedFetchUrlText = null;
let lastParsedFetchUrl = null;

function parsedFetchUrl(urlText) {
  const text = String(urlText);
  if (text === lastParsedFetchUrlText) return lastParsedFetchUrl;
  const parsed = new URL(text);
  lastParsedFetchUrlText = text;
  lastParsedFetchUrl = parsed;
  return parsed;
}

function hasPreconnectedFetchSocket(urlText, tlsConfig = undefined) {
  if (preconnectedFetchSockets.size === 0) return false;
  try {
    const list = preconnectedFetchSockets.get(fetchPoolKey(urlText, tlsConfig));
    return list?.some(socket => !socket.destroyed && socket.writable !== false) === true;
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname) {
  const name = String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name === "::1" || name === "::" || name === "0.0.0.0" || name.startsWith("127.");
}

function isLoopbackHttpUrl(urlText) {
  try {
    const url = new URL(urlText);
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHttpsUrl(urlText) {
  try {
    const url = new URL(urlText);
    return url.protocol === "https:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

async function fetchFromNodeHttp(request, redirectMode = "follow", depth = 0, redirected = false, transport = {}) {
  if (depth > 20) throw new TypeError("redirect count exceeded");
  const response = await fetchOnceFromNodeHttp(request, redirected, transport);
  if (redirectMode === "manual" || !isRedirectStatus(response.status)) return response;
  if (redirectMode === "error") throw unexpectedRedirectError();
  const location = response.headers.get("location");
  if (!location) return response;
  try { response._body?.cancel?.(); } catch {}
  const nextRequest = redirectedFetchRequest(request, response, location);
  const nextUrl = nextRequest.url;
  let nextTransport = transport;
  if (transport.socketPath) {
    try {
      if (new URL(nextUrl).origin !== new URL(request.url).origin) {
        nextTransport = { ...transport, socketPath: undefined };
      }
    } catch {
      nextTransport = { ...transport, socketPath: undefined };
    }
  }
  if (!nextTransport.socketPath) {
    // Redirect targets that are not loopback/unix should fall back to the
    // regular fetch dispatch (active-server fast path or node:http/https).
    const nextIsLocal = isLoopbackHttpUrl(nextUrl) || isLoopbackHttpsUrl(nextUrl) || activeServerForFetchUrl(nextUrl);
    if (!nextIsLocal) return fetchImpl(nextRequest, { redirect: redirectMode });
    const nextActive = new URL(nextUrl).protocol === "http:" ? activeServerForFetchUrl(nextUrl) : null;
    if (nextActive) {
      return fetchFromActiveServer(
        nextActive,
        nextRequest,
        redirectMode,
        depth + 1,
        true,
        nextTransport.decompress !== false,
        "http",
        nextTransport,
      );
    }
  }
  return fetchFromNodeHttp(nextRequest, redirectMode, depth + 1, true, nextTransport);
}

// Location header bytes reach JS as latin1 code units; the fetch spec treats
// them as UTF-8, so reinterpret before URL resolution when that produces
// valid UTF-8 text. Reinterpret repeatedly (bounded) because the node/http.js
// server currently serializes header values as UTF-8 instead of latin1, which
// adds a second mojibake layer when both ends run in this process; each loop
// iteration strictly requires a clean UTF-8 round-trip, so an extra pass never
// fires on already-correct text.
function redirectLocationText(location) {
  let text = String(location);
  // Bun's redirect resolver treats a leading "://" as scheme-relative
  // ("//host/path"); the WHATWG parser would keep it as a path segment.
  if (text.startsWith("://")) text = text.slice(1);
  for (let pass = 0; pass < 3; pass += 1) {
    if (!/[\x80-\xff]/.test(text) || /[Ā-￿]/.test(text)) return text;
    const bytes = Buffer.from(text, "latin1");
    const decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(bytes) || decoded === text) return text;
    text = decoded;
  }
  return text;
}

function decompressFetchBytes(bytes, encoding) {
  if (encoding === "gzip" || encoding === "x-gzip") return zlib.gunzipSync(bytes);
  if (encoding === "deflate") {
    try {
      return zlib.inflateSync(bytes);
    } catch {
      return zlib.inflateRawSync(bytes);
    }
  }
  if (encoding === "br") return zlib.brotliDecompressSync(bytes);
  if (encoding === "zstd") return zlib.zstdDecompressSync(bytes);
  return bytes;
}

function isCompressedFetchEncoding(encoding) {
  return encoding === "gzip" || encoding === "x-gzip" || encoding === "deflate" || encoding === "br" || encoding === "zstd";
}

function normalizedFetchAbortReason(signal) {
  const reason = signal?.reason;
  const DOMExceptionClass = globalThis.DOMException ?? Error;
  if (reason?.name === "TimeoutError") return new DOMExceptionClass("The operation timed out.", "TimeoutError");
  if (reason?.name === "AbortError" || reason == null) return new DOMExceptionClass("The operation was aborted.", "AbortError");
  return reason;
}

function normalizeFetchNetworkError(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return error;
  if (typeof error?.message === "string" && /^self-signed certificate\b/i.test(error.message)) {
    error.message = error.message.replace(/^self-signed certificate/i, "self signed certificate");
    return error;
  }
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(error?.code)) {
    const normalized = new Error("Unable to connect. Is the computer able to access the url?");
    normalized.code = "ConnectionRefused";
    normalized.cause = error;
    return normalized;
  }
  return error;
}

function nodeFetchHeaders(headers) {
  const values = [];
  if (headers?._values instanceof Map) {
    for (const [normalized, entry] of headers._values) {
      const all = normalized === "set-cookie" ? headers._allValues.get(normalized) ?? [] : [entry.value];
      for (const value of all) values.push(entry.key, value);
    }
    return values;
  }
  headers?.forEach?.((value, name) => values.push(name, value));
  return values;
}

function decodeInboundFetchHeader(value) {
  const text = String(value ?? "");
  if (!/[\x80-\xff]/.test(text) || /[Ā-￿]/.test(text)) return text;
  const bytes = Buffer.from(text, "latin1");
  const decoded = bytes.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : text;
}

function headersFromIncomingMessage(message) {
  const headers = new Headers();
  const raw = Array.isArray(message.rawHeaders) ? message.rawHeaders : [];
  if (raw.length > 0) {
    for (let index = 0; index + 1 < raw.length; index += 2) {
      headers.append(raw[index], decodeInboundFetchHeader(raw[index + 1]));
    }
  } else {
    for (const [name, value] of Object.entries(message.headers ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, decodeInboundFetchHeader(item));
    }
  }
  return headers;
}

const abandonedFetchBodyCleanupSymbol = Symbol("cottontail.abandonedFetchBodyCleanup");

function registerFetchResponseBodyFinalizer(response, body) {
  registerFetchBodyFinalizer(response, body, abandonedFetchBodyCleanupSymbol);
}

function markFetchResponseBodyConsumed(body) {
  markFetchBodyConsumed(body);
}

function createIncomingMessageBodyTransport(message, signal, expectedBytes) {
  let done = false;
  let streamState = null;
  const cleanup = () => {
    message.off?.("data", onData);
    message.off?.("end", onEnd);
    message.off?.("error", onError);
    message.off?.("aborted", onAborted);
    signal?.removeEventListener?.("abort", onAbort);
  };
  const finish = callback => {
    if (done) return;
    done = true;
    cleanup();
    const state = streamState;
    if (state) {
      state.done = true;
      callback(state);
    }
    streamState = null;
  };
  const onData = chunk => {
    if (done) return;
    const state = streamState;
    if (!state) {
      abandon();
      return;
    }
    state.receivedBytes += Number(chunk?.byteLength ?? chunk?.length ?? 0);
    state.controller.enqueue(Buffer.from(chunk));
    if (state.controller.desiredSize <= 0) {
      state.paused = true;
      message.pause?.();
    }
  };
  const onEnd = () => finish(state => state.controller.close());
  const onError = error => finish(state => state.controller.error(normalizeFetchNetworkError(error)));
  const onAborted = () => {
    const state = streamState;
    if (expectedBytes != null && state && state.receivedBytes >= expectedBytes) {
      onEnd();
      return;
    }
    const error = new Error("The socket connection was closed unexpectedly.");
    error.code = "ECONNRESET";
    onError(error);
  };
  const onAbort = () => {
    const reason = normalizedFetchAbortReason(signal);
    finish(state => state.controller.error(reason));
    message.on?.("error", () => {});
    message.destroy?.(reason);
  };
  const abandon = (reason = undefined) => {
    if (done) return;
    done = true;
    streamState = null;
    cleanup();
    const request = message.req;
    const socket = message.socket;
    // COTTONTAIL-COMPAT: A completed response can outlive its agent lease.
    // Only destroy the transport while this response still owns the socket.
    if (!message.complete && request?.res === message && socket?._httpMessage === request) {
      socket._destroyImmediately?.();
    }
    request?._destroyForFetchAbandon?.();
    message.req = null;
    message.socket = null;
    message.connection = null;
  };
  return {
    abandon,
    start(state) {
      if (done) return;
      streamState = state;
      message.on?.("data", onData);
      message.once?.("end", onEnd);
      message.once?.("error", onError);
      message.once?.("aborted", onAborted);
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else if (message.aborted || (message.destroyed && !message.complete)) onAborted();
      else message.resume?.();
    },
  };
}

function incomingMessageBodyStream(message, signal) {
  const contentLengthText = message.headers?.["content-length"];
  const expectedBytes = contentLengthText != null && /^\d+$/.test(String(contentLengthText))
    ? Number(contentLengthText)
    : null;
  const status = Number(message.statusCode ?? 200);
  const hasNoMessageBody = expectedBytes === 0 ||
    String(message.req?.method ?? "").toUpperCase() === "HEAD" ||
    status === 204 || status === 304 || status >= 100 && status < 200;
  const state = { controller: null, done: false, paused: false, receivedBytes: 0, started: false };
  const transport = createIncomingMessageBodyTransport(message, signal, expectedBytes);
  const startTransport = () => {
    if (state.started || state.done) return;
    state.started = true;
    transport.start(state);
  };
  const startBodyConsumption = () => {
    markFetchResponseBodyConsumed(stream);
    startTransport();
  };
  const stream = new globalThis.ReadableStream({
    start(streamController) {
      state.controller = streamController;
    },
    pull() {
      if (!state.started) return startTransport();
      if (!state.done && state.paused) {
        state.paused = false;
        message.resume?.();
      }
    },
    cancel(reason) {
      state.done = true;
      transport.abandon(reason);
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 0 }));
  Object.defineProperty(stream, fetchBodyStartSymbol, { value: startBodyConsumption });
  Object.defineProperty(stream, abandonedFetchBodyCleanupSymbol, { value: transport.abandon });
  // Empty responses must release their socket even when the caller never
  // reads body. Bun drains these at the transport layer without disturbing
  // the exposed ReadableStream.
  if (hasNoMessageBody) startTransport();
  return stream;
}

const preparedNodeFetchBlobBodies = new WeakMap();

function prepareImmutableBlobFetchBody(body) {
  let prepared = preparedNodeFetchBlobBodies.get(body);
  if (prepared == null) {
    prepared = Promise.resolve(body.arrayBuffer()).then(arrayBuffer => {
      const bytes = Buffer.from(arrayBuffer);
      return { bytes, stream: null, length: bytes.byteLength };
    });
    preparedNodeFetchBlobBodies.set(body, prepared);
  }
  return prepared;
}

function prepareNodeFetchBody(request) {
  const body = request._body;
  if (body == null || request.method === "GET" || request.method === "HEAD") return { bytes: null, stream: null, length: null };
  if (request._bodyStream?.locked || body?.locked) throw new TypeError("ReadableStream is locked");
  request._bodyUsed = true;
  if (body instanceof FormData) {
    return encodeMultipartFormData(body).then(encoded => ({
      bytes: Buffer.from(encoded.bytes),
      stream: null,
      length: encoded.bytes.byteLength,
    }));
  }
  if (typeof body === "string" || isURLSearchParamsLike(body) || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes = Buffer.from(bytesFromData(body));
    return { bytes, stream: null, length: bytes.byteLength };
  }
  const shared = sharedArrayBufferBytes(body);
  if (shared) return { bytes: Buffer.from(shared), stream: null, length: shared.byteLength };
  // Native Blob snapshots are immutable. Reusing their prepared bytes avoids
  // rebuilding an identical ReadableStream for every request while retaining
  // live reads for Bun.file and other Blob-like objects.
  if (body instanceof Blob && Object.getPrototypeOf(body) === Blob.prototype) {
    return prepareImmutableBlobFetchBody(body);
  }
  if (typeof body?.stream === "function" && typeof body?.size === "number") {
    return { bytes: null, stream: body.stream(), length: Number(body.size) };
  }
  if (typeof body?.getReader === "function" || typeof body?.[Symbol.asyncIterator] === "function" || typeof body === "function") {
    return { bytes: null, stream: body, length: null };
  }
  return bytesFromBody(body).then(value => {
    const bytes = Buffer.from(value);
    return { bytes, stream: null, length: bytes.byteLength };
  });
}

function waitForFetchRequestDrain(request) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      request.off?.("drain", onDrain);
      request.off?.("error", onError);
      request.off?.("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("The socket connection was closed unexpectedly.")); };
    request.once("drain", onDrain);
    request.once("error", onError);
    request.once("close", onClose);
  });
}

function writeNodeFetchBody(clientRequest, body) {
  if (body.bytes) {
    clientRequest.end(body.bytes);
    return null;
  }
  if (!body.stream) {
    clientRequest.end();
    return null;
  }
  clientRequest.flushHeaders?.();
  return consumeStreamingBody(body.stream, async chunk => {
    if (clientRequest.destroyed) throw new Error("The socket connection was closed unexpectedly.");
    if (!clientRequest.write(Buffer.from(asBuffer(chunk)))) await waitForFetchRequestDrain(clientRequest);
  }).then(() => clientRequest.end());
}

function proxyAuthorization(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) return null;
  const credentials = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

function normalizedProxyUrl(value) {
  let text = String(value ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) text = `http://${text}`;
  return new URL(text);
}

function fetchTlsOptions(url, config = null) {
  const hostname = String(url.hostname).replace(/^\[|\]$/g, "");
  const options = { ...(config ?? {}) };
  if (options.rejectUnauthorized == null) {
    options.rejectUnauthorized = String(globalThis.process?.env?.NODE_TLS_REJECT_UNAUTHORIZED ?? "1") !== "0";
  }
  const configuredServername = config?.serverName ?? config?.servername ?? hostname;
  options.servername = nodeNet.isIP(String(configuredServername).replace(/^\[|\]$/g, ""))
    ? ""
    : String(configuredServername);
  delete options.serverName;
  if (options.rejectUnauthorized === false) delete options.checkServerIdentity;
  return options;
}

const reusableFetchHttpsAgents = new Map();
const reusableCustomFetchHttpsAgents = new Map();
const MAX_REUSABLE_CUSTOM_FETCH_HTTPS_AGENTS = 64;
const proxyTunnelAgentSymbol = Symbol("cottontail.fetchProxyTunnelAgent");
let reusableFetchHttpAgent;

function defaultFetchHttpAgent() {
  return reusableFetchHttpAgent ??= new nodeHttp.Agent({
    keepAlive: true,
    scheduling: "lifo",
    timeout: 5000,
    maxSockets: 16,
    maxTotalSockets: 256,
  });
}

function defaultFetchHttpsAgent(tlsOptions, keepalive) {
  if (!keepalive) return new nodeHttps.Agent({ ...tlsOptions, keepAlive: false });
  const key = tlsOptions.rejectUnauthorized === false ? "insecure" : "verified";
  let agent = reusableFetchHttpsAgents.get(key);
  if (!agent) {
    agent = new nodeHttps.Agent({ keepAlive: true, rejectUnauthorized: tlsOptions.rejectUnauthorized !== false });
    reusableFetchHttpsAgents.set(key, agent);
  }
  return agent;
}

function customFetchHttpsAgent(tlsOptions, tlsConfig, keepalive) {
  if (!keepalive) return new nodeHttps.Agent({ ...tlsOptions, keepAlive: false });
  const key = fetchTlsSessionKey(tlsConfig);
  let agent = reusableCustomFetchHttpsAgents.get(key);
  if (agent) {
    reusableCustomFetchHttpsAgents.delete(key);
    reusableCustomFetchHttpsAgents.set(key, agent);
    return agent;
  }

  agent = new nodeHttps.Agent({ ...tlsOptions, keepAlive: true });
  reusableCustomFetchHttpsAgents.set(key, agent);
  if (reusableCustomFetchHttpsAgents.size > MAX_REUSABLE_CUSTOM_FETCH_HTTPS_AGENTS) {
    const oldestKey = reusableCustomFetchHttpsAgents.keys().next().value;
    const oldestAgent = reusableCustomFetchHttpsAgents.get(oldestKey);
    reusableCustomFetchHttpsAgents.delete(oldestKey);
    oldestAgent?.destroy?.();
  }
  return agent;
}

function httpsProxyTunnelAgent(target, proxy, proxyHeaders, tlsOptions, keepalive) {
  const agent = new nodeHttps.Agent({ ...tlsOptions, keepAlive: keepalive });
  Object.defineProperty(agent, proxyTunnelAgentSymbol, { value: true });
  agent.createConnection = function createConnection(options, callback) {
    const proxyClient = proxy.protocol === "https:" ? nodeHttps : nodeHttp;
    const headers = new Headers(proxyHeaders ?? undefined);
    headers.set("Host", `${target.hostname}:${target.port || 443}`);
    headers.set("Proxy-Connection", keepalive ? "Keep-Alive" : "close");
    const authorization = proxyAuthorization(proxy);
    if (authorization && !headers.has("proxy-authorization")) headers.set("Proxy-Authorization", authorization);
    let completed = false;
    const done = (error, socket) => {
      if (completed) return;
      completed = true;
      callback(error ?? null, socket);
    };
    const tunnel = proxyClient.request({
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: nodeFetchHeaders(headers),
      agent: keepalive ? undefined : false,
      ...(proxy.protocol === "https:" ? {
        ...tlsOptions,
        servername: nodeNet.isIP(String(proxy.hostname).replace(/^\[|\]$/g, "")) ? "" : proxy.hostname,
      } : {}),
    });
    tunnel.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy?.();
        const error = new Error(`Proxy response (${response.statusCode}) !== 200 when HTTP Tunneling`);
        error.code = "ERR_HTTP_PROXY_CONNECT";
        done(error);
        return;
      }
      if (head?.byteLength) socket.unshift?.(head);
      let secureSocket;
      try {
        secureSocket = nodeTlsConnect({ ...tlsOptions, socket, host: target.hostname, port: Number(target.port || 443) });
        secureSocket.once("secureConnect", () => done(null, secureSocket));
        secureSocket.once("error", done);
      } catch (error) {
        done(error);
      }
    });
    tunnel.once("error", done);
    tunnel.end();
    return undefined;
  };
  return agent;
}

function destroyOneShotProxyTunnelAgent(agent) {
  const sockets = new Set([
    ...Object.values(agent?.sockets ?? {}).flat(),
    ...Object.values(agent?.freeSockets ?? {}).flat(),
    ...(agent?._trackedSockets ?? []),
  ]);
  agent?.destroy?.();
  // CONNECT agents are not reused. Finalize their native TLS handles before
  // stock JSC can recycle an identifier still owned by a deferred destroy.
  for (const socket of sockets) socket?._destroyImmediately?.();
}

function fetchOnceUsingNodeClient(request, redirected = false, transport = {}, onResponse = null, parsedUrl = null) {
  // COTTONTAIL-COMPAT: Async body preparation can precede creation of the
  // request socket, so keep only that interval referenced. Once dispatched,
  // node:net owns a live handle and no synthetic timer is needed.
  let livenessTimer = null;
  const release = value => {
    if (livenessTimer != null) clearTimeout(livenessTimer);
    return value;
  };
  try {
    const url = parsedUrl ?? new URL(request.url);
    const keepalive = fetchUsesKeepalive(request);
    applyDefaultFetchHeaders(request, keepalive, url);
    const preparedBody = prepareNodeFetchBody(request);
    if (preparedBody && typeof preparedBody.then === "function") {
      livenessTimer = setTimeout(() => {}, 0x7fffffff);
      return preparedBody
        .then(body => dispatchNodeFetchRequest(request, redirected, transport, onResponse, url, keepalive, body))
        .then(release, error => {
          clearTimeout(livenessTimer);
          throw error;
        });
    }
    return dispatchNodeFetchRequest(request, redirected, transport, onResponse, url, keepalive, preparedBody);
  } catch (error) {
    if (livenessTimer != null) clearTimeout(livenessTimer);
    throw error;
  }
}

function dispatchNodeFetchRequest(request, redirected, transport, onResponse, url, keepalive, body) {
  if (body.length != null && !request.headers.has("content-length") && !request.headers.has("transfer-encoding")) {
    request.headers.set("Content-Length", String(body.length));
  }

  let client = url.protocol === "https:" ? nodeHttps : nodeHttp;
  let hostname = String(url.hostname).replace(/^\[|\]$/g, "");
  let port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  let path = `${url.pathname || "/"}${url.search || ""}`;
  let tlsOptions = null;
  const getTlsOptions = () => tlsOptions ??= fetchTlsOptions(url, transport.tlsConfig);
  let agent = keepalive ? defaultFetchHttpAgent() : false;
  const proxyValue = transport.proxy?.explicit ?? transport.proxy?.environment;
  if (proxyValue) {
    const proxy = normalizedProxyUrl(proxyValue);
    if (url.protocol === "https:") {
      agent = httpsProxyTunnelAgent(url, proxy, transport.proxy.headers, getTlsOptions(), false);
    } else {
      client = proxy.protocol === "https:" ? nodeHttps : nodeHttp;
      hostname = proxy.hostname;
      port = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
      path = request.url;
      agent = false;
      const authorization = proxyAuthorization(proxy);
      if (authorization && !request.headers.has("proxy-authorization")) request.headers.set("Proxy-Authorization", authorization);
      for (const [name, value] of transport.proxy.headers ?? []) request.headers.set(name, value);
      if (!request.headers.has("proxy-connection")) request.headers.set("Proxy-Connection", "close");
    }
  } else if (url.protocol === "https:") {
    agent = transport.tlsConfig
      ? customFetchHttpsAgent(getTlsOptions(), transport.tlsConfig, keepalive)
      : defaultFetchHttpsAgent(getTlsOptions(), keepalive);
  }

  return new Promise((resolve, reject) => {
    let responseReceived = false;
    let clientRequest;
    const signal = request.signal;
    const absorbResponseTransportError = () => {};
    const onRequestError = error => {
      signal?.removeEventListener?.("abort", onAbort);
      if (!responseReceived) reject?.(normalizeFetchNetworkError(error));
    };
    const onAbort = () => {
      const reason = normalizedFetchAbortReason(signal);
      clientRequest?.destroy?.(reason);
      if (!responseReceived) reject?.(reason);
    };
    if (signal?.aborted) {
      reject(normalizedFetchAbortReason(signal));
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      clientRequest = client.request({
        protocol: client === nodeHttps ? "https:" : "http:",
        hostname,
        port,
        path,
        method: request.method,
        headers: nodeFetchHeaders(request.headers),
        agent,
        socketPath: transport.socketPath,
        ...((client === nodeHttps || url.protocol === "https:") ? getTlsOptions() : {}),
      }, incoming => {
        responseReceived = true;
        const resolveResponse = resolve;
        const rejectResponse = reject;
        resolve = null;
        reject = null;
        signal?.removeEventListener?.("abort", onAbort);
        clientRequest.off?.("error", onRequestError);
        clientRequest.once?.("error", absorbResponseTransportError);
        if (agent?.[proxyTunnelAgentSymbol]) {
          incoming.once?.("end", () => destroyOneShotProxyTunnelAgent(agent));
        }
        const headers = headersFromIncomingMessage(incoming);
        const stream = incomingMessageBodyStream(incoming, signal);
        const response = responseWithMetadata(stream, {
          status: Number(incoming.statusCode ?? 200),
          statusText: incoming.statusMessage ?? "",
          headers,
        }, {
          url: request.url,
          redirected,
        });
        registerFetchResponseBodyFinalizer(response, stream);
        Object.defineProperty(response, "trailers", {
          get: () => incoming.complete ? incoming.trailers : {},
          configurable: true,
        });
        try {
          resolveResponse(typeof onResponse === "function" ? onResponse(response) : response);
        } catch (error) {
          rejectResponse(error);
        }
      });
      clientRequest.once("error", onRequestError);
      const bodyWrite = writeNodeFetchBody(clientRequest, body);
      bodyWrite?.catch?.(error => {
        if (!clientRequest.destroyed) clientRequest.destroy(error);
        if (!responseReceived) reject?.(normalizeFetchNetworkError(error));
      });
    } catch (error) {
      signal?.removeEventListener?.("abort", onAbort);
      reject?.(normalizeFetchNetworkError(error));
    }
  });
}

function settleNodeFetchResponse(request, response, redirectMode, depth, transport) {
  if (redirectMode === "manual" || !isRedirectStatus(response.status)) {
    return decodeFetchResponse(response, transport.decompress !== false);
  }
  const cancelBody = () => {
    try {
      return Promise.resolve(response.body?.cancel?.()).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  };
  if (redirectMode === "error") {
    return cancelBody().then(() => { throw unexpectedRedirectError(); });
  }
  const location = response.headers.get("location");
  if (!location) return decodeFetchResponse(response, transport.decompress !== false);
  return cancelBody().then(() => {
    const nextRequest = redirectedFetchRequest(request, response, location);
    let nextTransport = transport;
    if (transport.socketPath) {
      try {
        if (new URL(nextRequest.url).origin !== new URL(request.url).origin) nextTransport = { ...transport, socketPath: undefined };
      } catch {
        nextTransport = { ...transport, socketPath: undefined };
      }
    }
    const nextUrl = new URL(nextRequest.url);
    const activeServer = nextUrl.protocol === "http:" && !nextTransport.proxy?.active && activeServerForFetchUrl(nextRequest.url);
    if (activeServer) {
      return fetchFromActiveServer(
        activeServer,
        nextRequest,
        redirectMode,
        depth + 1,
        true,
        nextTransport.decompress !== false,
        "http",
        nextTransport,
      );
    }
    return fetchFromNodeClient(nextRequest, redirectMode, depth + 1, true, nextTransport);
  });
}

function fetchFromNodeClient(request, redirectMode = "follow", depth = 0, redirected = false, transport = {}, parsedUrl = null) {
  throwIfAborted(request.signal);
  if (depth > 20) throw new TypeError("redirect count exceeded");
  return fetchOnceUsingNodeClient(
    request,
    redirected,
    transport,
    response => settleNodeFetchResponse(request, response, redirectMode, depth, transport),
    parsedUrl,
  );
}

// Minimal streaming HTTP/1.1 client used for loopback and unix-socket fetch.
// Unlike node/http.js's client (which buffers whole responses before emitting
// them), this resolves the fetch promise as soon as response headers arrive
// and streams the body, which SSE/flushHeaders semantics require.
async function fetchOnceFromNodeHttp(request, redirected = false, transport = {}) {
  try {
    return await fetchSocketAttempt(request, redirected, transport, true);
  } catch (error) {
    // A pooled (preconnected) socket that died before delivering headers is
    // retried once on a fresh connection.
    if (error && error.__cottontailPooledRetry) {
      return fetchSocketAttempt(request, redirected, transport, false);
    }
    throw error;
  }
}

const EMPTY_BUFFER = new Uint8Array(0);

async function fetchSocketAttempt(request, redirected, transport, usePool) {
  const body = request.method === "GET" || request.method === "HEAD"
    ? Buffer.alloc(0)
    : Buffer.from(await bytesFromBody(request._body));
  return new Promise((resolve, reject) => {
    const suppliedUrl = transport.parsedUrl;
    const url = suppliedUrl?.href === request.url ? suppliedUrl : parsedFetchUrl(request.url);
    const isHttps = url.protocol === "https:";
    let hostname = String(url.hostname).replace(/^\[|\]$/g, "");
    if (hostname === "0.0.0.0") hostname = "127.0.0.1";
    else if (hostname === "::") hostname = "::1";
    const port = Number(url.port || (isHttps ? 443 : 80));

    let settled = false;
    let streamController = null;
    let streamDone = false;
    let finished = false;

    const failure = (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
        // Same retain-cycle break as the success path: once settled, the
        // settler bindings must not keep transport closures alive.
        resolve = null;
        reject = null;
        return;
      }
      if (!streamDone && streamController) {
        streamDone = true;
        try { streamController.error(error); } catch {}
      }
      cleanup();
    };

    const poolKey = `${url.protocol}//${hostname}:${port}` +
      (transport.tlsConfig ? `|tls:${fetchTlsSessionKey(transport.tlsConfig)}` : "");
    const pooledSocket = transport.socketPath || !usePool
      ? null
      : takePreconnectedSocket(poolKey);
    if (pooledSocket) pooledSocket.ref?.();
    const socket = pooledSocket ?? (transport.socketPath
      ? nodeNet.connect({ path: transport.socketPath })
      : isHttps
        ? nodeTlsConnect({
            host: hostname,
            port,
            servername: transport.tlsConfig?.serverName ?? url.hostname.replace(/^\[|\]$/g, ""),
            rejectUnauthorized: transport.rejectUnauthorized !== false,
            ca: transport.tlsConfig?.ca,
          })
        : nodeNet.connect(port, hostname));

    const cleanup = () => {
      try { socket.destroy?.(); } catch {}
    };

    // Keepalive: after a fully-delimited response body, the socket can serve
    // the next request to the same origin (and same TLS config).
    let socketGone = false;
    let responseConnectionClose = false;
    const repoolSocket = () => {
      for (const name of ["data", "error", "end", "close", "connect", "secureConnect"]) {
        socket.removeAllListeners?.(name);
      }
      socket.on("error", () => {});
      socket.once("close", () => {
        const list = preconnectedFetchSockets.get(poolKey);
        if (list) {
          const index = list.indexOf(socket);
          if (index >= 0) list.splice(index, 1);
          if (list.length === 0) preconnectedFetchSockets.delete(poolKey);
        }
      });
      socket.unref?.();
      const list = preconnectedFetchSockets.get(poolKey) ?? [];
      list.push(socket);
      preconnectedFetchSockets.set(poolKey, list);
    };
    const canRepoolSocket = () =>
      transport.pooled === true &&
      !transport.socketPath &&
      !socketGone &&
      !socket.destroyed && socket.writable !== false &&
      !responseConnectionClose &&
      (bodyMode === "length" || bodyMode === "chunked" || bodyMode === "none");

    const onAbort = () => {
      request.signal?.removeEventListener?.("abort", onAbort);
      failure(request.signal?.reason ?? abortError());
    };
    request.signal?.addEventListener?.("abort", onAbort);
    if (request.signal?.aborted) return onAbort();

    // ---- request serialization ----------------------------------------
    // Iterate the internal map (when available) so original header casing is
    // preserved on the wire; Headers iteration is normalized/sorted.
    const headerNames = new Set();
    const headerLines = [];
    if (request.headers?._values instanceof Map) {
      for (const [normalized, entry] of request.headers._values) {
        headerNames.add(normalized);
        if (normalized === "set-cookie") {
          for (const value of request.headers._allValues.get(normalized) ?? []) {
            headerLines.push(`${entry.key}: ${value}`);
          }
        } else {
          headerLines.push(`${entry.key}: ${entry.value}`);
        }
      }
    } else {
      request.headers.forEach((value, name) => {
        headerNames.add(String(name).toLowerCase());
        headerLines.push(`${name}: ${value}`);
      });
    }
    if (!headerNames.has("host")) {
      headerLines.push(`Host: ${url.hostname}${url.port ? `:${url.port}` : ""}`);
    }
    if (!headerNames.has("connection")) headerLines.push("Connection: keep-alive");
    if (!headerNames.has("accept")) headerLines.push("Accept: */*");
    if (!headerNames.has("accept-encoding")) headerLines.push("Accept-Encoding: gzip, deflate, br, zstd");
    if (!headerNames.has("user-agent")) {
      headerLines.push(`User-Agent: ${globalThis.__cottontailDefaultUserAgent ?? globalThis.navigator?.userAgent ?? `Bun/${BunObject.version ?? "1.0.0"}`}`);
    }
    if (body.byteLength > 0 && !headerNames.has("content-length") && !headerNames.has("transfer-encoding")) {
      headerLines.push(`Content-Length: ${body.byteLength}`);
    } else if (
      body.byteLength === 0 &&
      !headerNames.has("content-length") &&
      !headerNames.has("transfer-encoding") &&
      request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS"
    ) {
      headerLines.push("Content-Length: 0");
    }
    const path = `${url.pathname || "/"}${url.search || ""}`;
    const head = `${request.method} ${path} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`;

    let requestSent = false;
    const sendRequestHead = () => {
      if (requestSent || socket.destroyed) return;
      requestSent = true;
      socket.write(head);
      if (body.byteLength > 0) socket.write(body);
      if (transport.streamBody) {
        (async () => {
          try {
            await consumeStreamingBody(transport.streamBody, (chunk) => {
              if (!socket.destroyed && socket.writable) socket.write(asBuffer(chunk));
            });
          } catch {}
        })();
      }
    };
    socket.on("connect", sendRequestHead);
    socket.on("secureConnect", sendRequestHead);
    if (socket.readyState === "open" || (pooledSocket && !socket.connecting && !socket.destroyed)) {
      sendRequestHead();
    }

    // ---- response parsing ----------------------------------------------
    let phase = "head";
    let headBuffer = Buffer.alloc(0);
    let bodyMode = "eof"; // "length" | "chunked" | "eof" | "none"
    let bodyRemaining = 0;
    let chunkState = null;

    // COTTONTAIL-COMPAT: the body stream below uses a zero highWaterMark so
    // desiredSize stays <= 0, which keeps ReadableStreamDefaultController's
    // post-enqueue callPullIfNeeded from invoking the pull algorithm (and
    // allocating its promise bookkeeping) while nobody reads. Pulls still
    // fire for pending read requests, so consumers drive delivery normally.
    // desiredSize therefore cannot provide backpressure; track buffered
    // bytes ourselves and pause the socket past the same 4 MiB budget.
    let bufferedBodyBytes = 0;
    const enqueueBody = (chunk) => {
      if (chunk.byteLength === 0) return;
      if (streamDone || !streamController) return;
      try {
        streamController.enqueue(Buffer.from(chunk));
        // Backpressure: stop reading from the socket once the consumer's
        // queue is full; pull() resumes it.
        bufferedBodyBytes += chunk.byteLength;
        if (bufferedBodyBytes > 4 * 1024 * 1024 && !socket.destroyed) socket.pause?.();
      } catch {}
    };

    const finishBody = () => {
      if (finished) return;
      finished = true;
      request.signal?.removeEventListener?.("abort", onAbort);
      if (!streamDone && streamController) {
        streamDone = true;
        try { streamController.close(); } catch {}
      }
      if (canRepoolSocket()) repoolSocket();
      else cleanup();
    };

    const startBody = (headers, status, statusText, initialChunk) => {
      responseConnectionClose = String(headers.get("connection") ?? "")
        .toLowerCase()
        .split(",")
        .some((token) => token.trim() === "close");
      const transferEncoding = String(headers.get("transfer-encoding") ?? "").toLowerCase();
      const method = String(request.method).toUpperCase();
      if (status === 101) {
        // Upgraded connection: expose the raw byte stream until close.
        bodyMode = "eof";
      } else if (method === "HEAD" || status === 204 || status === 304) {
        bodyMode = "none";
      } else if (transferEncoding.split(",").some((item) => item.trim() === "chunked")) {
        bodyMode = "chunked";
        chunkState = { buffer: EMPTY_BUFFER, size: null, remaining: 0, trailer: false };
      } else if (headers.get("content-length") != null) {
        bodyMode = "length";
        bodyRemaining = Number(headers.get("content-length")) || 0;
      } else {
        bodyMode = "eof";
      }
      // The stream constructor may run jobs while an already-queued EOF is
      // waiting. Mark the header phase complete before that reentrant turn.
      phase = "body";
      const stream = new globalThis.ReadableStream({
        start(controller) {
          streamController = controller;
          if (finished && !streamDone) {
            streamDone = true;
            controller.close();
          }
        },
        pull() {
          // A reader is draining the queue; reopen the delivery budget.
          bufferedBodyBytes = 0;
          if (!finished && !socket.destroyed) socket.resume?.();
        },
        cancel() {
          streamDone = true;
          cleanup();
        },
      }, new ByteLengthQueuingStrategy({ highWaterMark: 0 }));
      Object.defineProperty(stream, abandonedFetchBodyCleanupSymbol, {
        value() {
          if (streamDone) return;
          streamDone = true;
          cleanup();
        },
      });
      Object.defineProperty(stream, fetchBodyStartSymbol, {
        value() {
          markFetchResponseBodyConsumed(stream);
        },
      });
      const response = responseWithMetadata(stream, {
        headers,
        status,
        statusText,
      }, {
        url: request.url,
        redirected,
      });
      registerFetchResponseBodyFinalizer(response, stream);
      const decodedResponse = decodeFetchResponse(response, transport.decompress !== false);
      settled = true;
      resolve(decodedResponse);
      // Break the retain cycle: the fetch-body FinalizationRegistry pins the
      // transport closures (unregister token + held cleanup value) until the
      // response is collected, and a settled promise pins its result — a
      // reachable `resolve` binding would pin the response forever.
      resolve = null;
      reject = null;
      if (bodyMode === "none" || (bodyMode === "length" && bodyRemaining === 0)) {
        if (initialChunk.byteLength > 0) {
          // Ignore pipelined data.
        }
        finishBody();
        return;
      }
      if (initialChunk.byteLength > 0) consumeBody(initialChunk);
    };

    const consumeChunked = (chunk) => {
      // Stream chunk payload bytes through as they arrive. Only chunk-size
      // lines, terminators, and trailers are ever buffered, so a single huge
      // chunk (e.g. one 2GiB res.write) is O(n) instead of O(n^2) rebuffering.
      let buffer = chunkState.buffer.byteLength === 0
        ? asBuffer(chunk)
        : Buffer.concat([chunkState.buffer, asBuffer(chunk)]);
      chunkState.buffer = EMPTY_BUFFER;
      const invalid = () => {
        const error = new Error("Invalid HTTP response");
        error.code = "InvalidHTTPResponse";
        failure(error);
      };
      for (;;) {
        if (chunkState.trailer) {
          // Consume trailers until a blank line.
          if (buffer.byteLength >= 2 && buffer[0] === 0x0d && buffer[1] === 0x0a) {
            finishBody();
            return;
          }
          if (buffer.indexOf("\r\n\r\n") < 0) {
            chunkState.buffer = buffer;
            return;
          }
          finishBody();
          return;
        }
        if (chunkState.size == null) {
          const lineEnd = buffer.indexOf("\r\n");
          if (lineEnd < 0) {
            chunkState.buffer = buffer;
            return;
          }
          const sizeText = buffer.subarray(0, lineEnd).toString("latin1").split(";")[0].trim();
          const size = /^[0-9A-Fa-f]+$/.test(sizeText) ? parseInt(sizeText, 16) : NaN;
          if (!Number.isFinite(size) || size < 0) {
            invalid();
            return;
          }
          chunkState.size = size;
          chunkState.remaining = size;
          buffer = buffer.subarray(lineEnd + 2);
          if (size === 0) {
            chunkState.trailer = true;
            continue;
          }
        }
        if (chunkState.remaining > 0) {
          const take = Math.min(chunkState.remaining, buffer.byteLength);
          if (take > 0) {
            enqueueBody(buffer.subarray(0, take));
            buffer = buffer.subarray(take);
            chunkState.remaining -= take;
          }
          if (chunkState.remaining > 0) return;
        }
        // Validate the CRLF terminator as soon as its bytes are visible so a
        // malformed chunk surfaces as InvalidHTTPResponse even when the peer
        // closes the connection right after it.
        if (buffer.byteLength === 0) {
          chunkState.buffer = buffer;
          return;
        }
        if (buffer[0] !== 0x0d) {
          invalid();
          return;
        }
        if (buffer.byteLength < 2) {
          chunkState.buffer = buffer;
          return;
        }
        if (buffer[1] !== 0x0a) {
          invalid();
          return;
        }
        buffer = buffer.subarray(2);
        chunkState.size = null;
      }
    };

    const consumeBody = (chunk) => {
      if (bodyMode === "length") {
        const take = Math.min(bodyRemaining, chunk.byteLength);
        enqueueBody(chunk.subarray(0, take));
        bodyRemaining -= take;
        if (bodyRemaining <= 0) finishBody();
        return;
      }
      if (bodyMode === "chunked") {
        consumeChunked(chunk);
        return;
      }
      enqueueBody(chunk);
    };

    socket.on("data", (data) => {
      let chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (finished) return;
      if (phase === "head") {
        headBuffer = headBuffer.byteLength === 0 ? chunk : Buffer.concat([headBuffer, chunk]);
        const headerEnd = headBuffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const headText = headBuffer.subarray(0, headerEnd).toString("latin1");
        const rest = headBuffer.subarray(headerEnd + 4);
        const [statusLine, ...headerTextLines] = headText.split("\r\n");
        const match = /^HTTP\/\d+\.\d+\s+(\d{3})\s*(.*)$/.exec(statusLine);
        if (!match) {
          failure(new Error("Invalid HTTP response"));
          return;
        }
        const status = Number(match[1]);
        if (status >= 100 && status < 200 && status !== 101) {
          // Informational response: skip it and keep parsing.
          headBuffer = Buffer.from(rest);
          if (headBuffer.byteLength > 0) {
            const again = headBuffer;
            headBuffer = Buffer.alloc(0);
            socket.emit("data", again);
          }
          return;
        }
        const headers = parseHeadersText(headerTextLines.join("\n"));
        headBuffer = Buffer.alloc(0);
        try {
          startBody(headers, status, match[2] ?? "", rest);
        } catch (error) {
          failure(error);
        }
        return;
      }
      consumeBody(chunk);
    });

    const connectionLost = (rawError) => {
      if (finished) return;
      if (phase === "body" && (
        bodyMode === "eof" ||
        bodyMode === "none" ||
        (bodyMode === "length" && bodyRemaining === 0) ||
        (bodyMode === "chunked" && chunkState?.trailer)
      )) {
        finishBody();
        return;
      }
      let error = rawError;
      if (error == null) {
        error = new Error("The socket connection was closed unexpectedly.");
        error.code = "ECONNRESET";
      }
      if (pooledSocket && !settled) error.__cottontailPooledRetry = true;
      failure(error);
    };
    socket.on("error", (error) => { socketGone = true; connectionLost(error); });
    socket.on("end", () => { socketGone = true; connectionLost(null); });
    socket.on("close", () => { socketGone = true; connectionLost(null); });
  });
}

function prepareFetchRequest(input, init = {}, initWasProvided = true) {
  let requestInit = init;
  if (!(input instanceof Request) && init?.body === "") {
    const method = String(init.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") requestInit = { ...init, body: undefined };
  }
  // Bun allows a streaming function body on GET requests for protocol
  // upgrades (e.g. speaking websocket bytes over the raw connection).
  let upgradeStreamBody = null;
  if (!(input instanceof Request) && typeof requestInit?.body === "function") {
    const method = String(requestInit.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") {
      upgradeStreamBody = requestInit.body;
      requestInit = { ...requestInit, body: undefined };
    }
  }
  const hasOverrides = requestInit != null && typeof requestInit === "object" && Object.keys(requestInit).length > 0;
  const request = input instanceof Request && !hasOverrides
    ? input
    : new Request(input, initWasProvided ? requestInit : undefined);
  return { request, upgradeStreamBody };
}

function beginFetchBodyConsumption(request) {
  if (request._body == null || request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return;
  }
  if (request._bodyStream?.locked || request._body?.locked) throw new TypeError("ReadableStream is locked");
  if (bodyWasUsed(request)) throw new TypeError("Body already used");
  request._body = bodyValueForConsumption(request);
  request._bodyUsed = true;
}

function fetchVerboseMode(init) {
  const configured = init?.verbose ?? globalThis.process?.env?.BUN_CONFIG_VERBOSE_FETCH ?? cottontail.env?.()?.BUN_CONFIG_VERBOSE_FETCH;
  if (configured === true) return "curl";
  return configured == null ? "" : String(configured).toLowerCase();
}

function curlQuote(value) {
  return JSON.stringify(String(value));
}

function logVerboseFetchRequest(request, mode) {
  if (mode !== "curl") return;
  const command = [`curl --http1.1 ${curlQuote(request.url)}`];
  if (request.method !== "GET") command.push(`-X ${request.method}`);
  for (const [name, value] of request.headers) {
    command.push(`-H ${curlQuote(`${name}: ${value}`)}`);
  }
  if (request.headers.has("accept-encoding")) command.push("--compressed");
  if (typeof request._body === "string") command.push(`--data-raw ${curlQuote(request._body)}`);
  const line = `${command.join(" ")}\n`;
  if (typeof globalThis.process?.stderr?.write === "function") globalThis.process.stderr.write(line);
  else console.error(line.trimEnd());
}

function fetchImpl(request, init = {}, upgradeStreamBody = null) {
  if (
    upgradeStreamBody == null &&
    (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") &&
    request._body != null
  ) {
    throw new TypeError("fetch() request with GET/HEAD/OPTIONS method cannot have body.");
  }
  if (request.signal?.aborted) {
    const reason = normalizedFetchAbortReason(request.signal);
    if (typeof request._body?.cancel === "function" && !request._body.locked) {
      try {
        return Promise.resolve(request._body.cancel(reason)).then(
          () => { throw reason; },
          () => { throw reason; },
        );
      } catch {}
    }
    throw reason;
  }
  const redirectMode = String(init.redirect ?? request.redirect ?? "follow");
  if (redirectMode !== "follow" && redirectMode !== "manual" && redirectMode !== "error") {
    throw new TypeError(`Invalid redirect mode: ${redirectMode}`);
  }
  const timeout = init?.timeout;
  const verboseMode = fetchVerboseMode(init);
  if (timeout != null) {
    const delay = Number(timeout);
    if (!Number.isFinite(delay) || delay < 0) throw new TypeError("fetch() timeout must be a non-negative number");
    if (delay > 0) {
      const timeoutSignal = globalThis.AbortSignal.timeout(delay);
      const state = requestState.get(request);
      if (state) state.signal = globalThis.AbortSignal.any([request.signal, timeoutSignal]);
    }
  }
  // When the request body is a stream, aborting the fetch must stop pulling
  // from it; cancel any reader created for it once the signal fires.
  if (request.signal && typeof request._body?.getReader === "function") {
    const signal = request.signal;
    const stream = request._body;
    const originalGetReader = stream.getReader.bind(stream);
    stream.getReader = (...args) => {
      const reader = originalGetReader(...args);
      const onAbort = () => {
        try { reader.cancel(signal.reason); } catch {}
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener?.("abort", onAbort, { once: true });
      return reader;
    };
  }
  if (request.url.startsWith("data:")) return Promise.resolve(responseFromDataUrl(request.url));
  if (request.url.startsWith("blob:")) {
    const blob = globalThis.__cottontailObjectURLRegistry?.get(request.url);
    if (!blob) throw new TypeError("fetch failed: unknown blob URL");
    return Promise.resolve(responseWithMetadata(blob, {
      status: 200,
      headers: blob.type ? { "content-type": blob.type } : {},
    }, {
      url: request.url,
    }));
  }
  if (request.url.startsWith("file:")) {
    const body = file(nodeFileURLToPath(request.url));
    return Promise.resolve(responseWithMetadata(body, {
      status: 200,
      headers: body.type ? { "content-type": body.type } : {},
    }, {
      url: request.url,
    }));
  }
  const parsedUrl = parsedFetchUrl(request.url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new TypeError(`Unsupported URL scheme: ${parsedUrl.protocol}`);
  }
  const unixSocketPath = init?.unix != null && init.unix !== false ? String(init.unix) : null;
  const unixTransportPath = unixSocketPath == null ? null : windowsUnixTransportPath(unixSocketPath);
  const customTlsConfig = init?.tls != null && typeof init.tls === "object" && !Array.isArray(init.tls) ? init.tls : null;
  const proxy = fetchProxyConfiguration(request.url, init, parsedUrl);
  if (unixSocketPath && proxy.active) throw new TypeError("fetch() proxy and unix options cannot be used together");
  if (customTlsConfig) {
    for (const name of ["ca", "cert", "key", "pfx", "crl"]) {
      const value = customTlsConfig[name];
      const valid = value == null || typeof value === "string" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer ||
        Array.isArray(value) && value.every(item => typeof item === "string" || ArrayBuffer.isView(item) || item instanceof ArrayBuffer);
      if (!valid) throw new TypeError(`fetch() tls.${name} must be a string, buffer, or array of strings/buffers`);
    }
    if (customTlsConfig.checkServerIdentity != null && typeof customTlsConfig.checkServerIdentity !== "function") {
      throw new TypeError("fetch() tls.checkServerIdentity must be a function");
    }
  }
  if (verboseMode === "curl") {
    applyDefaultFetchHeaders(request, fetchUsesKeepalive(request));
    logVerboseFetchRequest(request, verboseMode);
  }
  beginFetchBodyConsumption(request);
  const activeServer = activeServerForFetchUrl(request.url);
  const decompress = (init?.decompression ?? init?.decompress) !== false;
  if (proxy.explicit) {
    const activeProxy = activeServerForFetchUrl(proxy.explicit);
    if (activeProxy) return fetchFromActiveProxy(activeProxy, proxy.explicit, request);
  }
  // Requests that want a protocol upgrade must use a real socket so the
  // 101 handshake and post-upgrade byte stream work; skip the in-process
  // fast path for them.
  const wantsUpgrade = upgradeStreamBody != null ||
    String(request.headers.get("connection") ?? "").toLowerCase().split(",").some((token) => token.trim() === "upgrade");
  const usesKeepalive = fetchUsesKeepalive(request);
  // Explicitly insecure loopback TLS requests can use the in-process dispatch.
  // A logical peer per TLS config preserves observable connection separation.
  const localTlsKeepalivePath = activeServer != null && parsedUrl.protocol === "https:" &&
    customTlsConfig?.rejectUnauthorized === false && usesKeepalive && !proxy.active && !wantsUpgrade;
  const customTlsSocketPath = customTlsConfig != null && isLoopbackHttpsUrl(request.url);
  const localHttpPath = activeServer != null && parsedUrl.protocol === "http:" &&
    !proxy.active && !wantsUpgrade && !customTlsSocketPath;
  if (localHttpPath || localTlsKeepalivePath) {
    applyDefaultFetchHeaders(request, usesKeepalive, parsedUrl);
    const peerKey = localTlsKeepalivePath ? `tls:${fetchTlsSessionKey(customTlsConfig)}` : "http";
    return fetchFromActiveServer(activeServer, request, redirectMode, 0, false, decompress, peerKey, {
      tlsConfig: customTlsConfig ?? undefined,
      proxy,
      decompress,
    });
  }
  if (wantsUpgrade) {
    return fetchFromNodeHttp(request, redirectMode, 0, false, {
      streamBody: upgradeStreamBody,
      rejectUnauthorized: customTlsConfig?.rejectUnauthorized,
      tlsConfig: customTlsConfig ?? undefined,
    });
  }
  if (!proxy.active && unixSocketPath == null && parsedUrl.protocol === "http:" && isLoopbackHostname(parsedUrl.hostname)) {
    return fetchFromNodeHttp(request, redirectMode, 0, false, {
      pooled: usesKeepalive,
      tlsConfig: customTlsConfig ?? undefined,
    });
  }
  if (!proxy.active && hasPreconnectedFetchSocket(request.url, customTlsConfig ?? undefined)) {
    return fetchFromNodeHttp(request, redirectMode, 0, false, {
      tlsConfig: customTlsConfig ?? undefined,
      rejectUnauthorized: customTlsConfig?.rejectUnauthorized,
      pooled: fetchUsesKeepalive(request),
    });
  }
  return fetchFromNodeClient(request, redirectMode, 0, false, {
    socketPath: unixTransportPath ?? undefined,
    tlsConfig: customTlsConfig ?? undefined,
    proxy,
    decompress,
  }, parsedUrl);
}

export function fetch(input, init = {}) {
  try {
    const initWasProvided = arguments.length > 1;
    let preparedInput = input;
    let preparedInit = init;
    if (!(input instanceof Request) && !(input instanceof URL) && isObjectLike(input) && !("url" in input)) {
      // Fetch resolves a string-like first argument before reading its init;
      // Request construction itself processes object init fields first.
      preparedInput = bunString(input);
    }
    if (input instanceof Request && Object.getPrototypeOf(input) !== Request.prototype) {
      // Fetch snapshots Request subclasses through their public getters before
      // starting I/O, then reports conversion failures through its promise.
      preparedInput = new Request(input, init);
      preparedInit = {};
    }
    const prepared = prepareFetchRequest(preparedInput, preparedInit, initWasProvided);
    const body = prepared.request._body;
    if (isBunFileLike(body) && body._bunFilePath && !cottontail.existsSync(body._bunFilePath)) {
      const error = new Error(`ENOENT: no such file or directory, open '${body._bunFilePath}'`);
      error.code = "ENOENT";
      return handledRejectedPromise(error);
    }
    return fetchImpl(prepared.request, preparedInit, prepared.upgradeStreamBody);
  } catch (error) {
    if (error?.[invalidHeaderErrorSymbol]) throw error;
    return handledRejectedPromise(error);
  }
}

fetch.preconnect = fetchPreconnect;

function abortError() {
  return normalizedFetchAbortReason(null);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw normalizedFetchAbortReason(signal);
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function unexpectedRedirectError() {
  const error = new TypeError("UnexpectedRedirect: redirect mode is set to error");
  error.code = "UnexpectedRedirect";
  return error;
}

const redirectBodyHeaderNames = [
  "content-encoding", "content-language", "content-location", "content-type", "content-length", "transfer-encoding",
];
const crossOriginRedirectHeaderNames = ["authorization", "proxy-authorization", "cookie", "host"];

function redirectedFetchRequest(request, response, location) {
  const nextUrl = String(new URL(redirectLocationText(location), request.url));
  let method = request.method;
  let body = request._body;
  const dropBody = response.status === 303 && method !== "GET" && method !== "HEAD" ||
    (response.status === 301 || response.status === 302) && method === "POST";
  const headers = new Headers(request.headers);
  if (dropBody) {
    method = "GET";
    body = undefined;
    for (const name of redirectBodyHeaderNames) headers.delete(name);
  }
  try {
    if (new URL(nextUrl).origin !== new URL(request.url).origin) {
      for (const name of crossOriginRedirectHeaderNames) headers.delete(name);
    }
  } catch {}
  const state = requestState.get(request);
  const init = {
    method,
    headers,
    signal: request.signal,
    redirect: request.redirect,
  };
  if (state?.keepaliveExplicit) init.keepalive = request.keepalive;
  if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = body;
  const redirected = new Request(nextUrl, init);
  const redirectedState = requestState.get(redirected);
  if (redirectedState) redirectedState.signalExplicit = state?.signalExplicit === true;
  return redirected;
}

function decompressionError(encoding, cause) {
  const kind = encoding === "br"
    ? "BrotliDecompressionError"
    : encoding === "zstd"
      ? "ZstdDecompressionError"
      : "ZlibError";
  const error = new Error(`Decompression error: ${kind}`);
  error.code = kind;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function fetchDeflateHasZlibWrapper(bytes) {
  if (bytes.byteLength < 2) return false;
  const cmf = bytes[0];
  const flags = bytes[1];
  return (cmf & 0x0f) === 8 && (cmf >>> 4) <= 7 && (((cmf << 8) | flags) % 31) === 0;
}

function createFetchDecompressor(encoding, firstBytes) {
  const options = { chunkSize: 256 * 1024 };
  if (encoding === "gzip" || encoding === "x-gzip") return zlib.createGunzip(options);
  if (encoding === "deflate") {
    return fetchDeflateHasZlibWrapper(firstBytes) ? zlib.createInflate(options) : zlib.createInflateRaw(options);
  }
  if (encoding === "br") return zlib.createBrotliDecompress(options);
  if (encoding === "zstd") return zlib.createZstdDecompress(options);
  return null;
}

// COTTONTAIL-COMPAT: Fetch uses Node Transform decoder output and propagates
// decoded-body backpressure. Compressed input is retained per member/frame
// because the host exposes only one-shot decode calls; native zlib/Brotli/Zstd
// decoder create/write/end handles are required to produce decoded bytes and
// apply transport backpressure before member/frame EOF.
function decodedFetchBodyStream(body, encoding) {
  let reader;
  let decoder;
  let controller;
  let done = false;
  let sourceEnded = false;
  let decoderEnded = false;
  let wantsOutput = false;

  const closeIfComplete = () => {
    if (done || !sourceEnded || !decoderEnded) return;
    done = true;
    controller.close();
  };

  const fail = cause => {
    if (done) return;
    done = true;
    controller.error(cause?.name === "AbortError" || cause?.name === "TimeoutError" || cause?.code === "ECONNRESET"
      ? cause
      : decompressionError(encoding, cause));
  };

  const attachDecoder = firstBytes => {
    decoder = createFetchDecompressor(encoding, firstBytes);
    decoder.pause?.();
    decoder.on("data", chunk => {
      if (done) return;
      controller.enqueue(asBuffer(chunk));
      if (controller.desiredSize <= 0) {
        wantsOutput = false;
        decoder.pause?.();
      }
    });
    decoder.once("end", () => {
      decoderEnded = true;
      closeIfComplete();
    });
    decoder.once("error", fail);
    if (wantsOutput) decoder.resume?.();
  };

  const pump = async () => {
    reader = body.getReader();
    const chunks = [];
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = Buffer.from(result.value);
        if (chunk.byteLength > 0) chunks.push(chunk);
      }
      sourceEnded = true;
      if (chunks.length === 0) {
        decoderEnded = true;
        done = true;
        controller.close();
      } else {
        const input = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
        attachDecoder(input);
        decoder.end(input);
      }
      closeIfComplete();
    } catch (cause) {
      try { decoder?.destroy?.(); } catch {}
      fail(cause);
    }
  };

  return new globalThis.ReadableStream({
    start(streamController) {
      controller = streamController;
      void pump();
    },
    pull() {
      wantsOutput = true;
      decoder?.resume?.();
    },
    cancel(reason) {
      done = true;
      try { decoder?.destroy?.(); } catch {}
      return reader?.cancel?.(reason);
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }));
}

function decodeFetchResponse(response, decompress = true) {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (!decompress || !isCompressedFetchEncoding(encoding) || !response.body) return response;
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  };
  const metadata = {
    url: response.url,
    redirected: response.redirected,
    type: response.type,
  };
  return responseWithMetadata(decodedFetchBodyStream(response.body, encoding), init, metadata);
}

function activeServeRequestBody(body) {
  let controller;
  let bodyReader = null;
  let bodyIterator = null;
  const state = {
    byteSize: requestBodyByteSize(body),
    settled: false,
    started: false,
    pending: null,
    stream: null,
    abort(reason) {
      if (state.settled) return;
      state.settled = true;
      try { controller.error(reason); } catch {}
      if (typeof body?.cancel === "function") {
        try { Promise.resolve(body.cancel(reason)).catch(() => {}); } catch {}
      }
    },
  };
  // Open-ended bodies (streams, async iterables, node Readables) must feed
  // the handler incrementally: one chunk per pull, so a server reading the
  // request body sees data as the client produces it (node-fetch "request
  // body streams properly"). Buffered bodies keep the single-shot path.
  const isOpenEndedBody = body != null && typeof body !== "string" &&
    !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) &&
    !(typeof globalThis.Blob === "function" && body instanceof globalThis.Blob) &&
    (typeof body?.getReader === "function" || typeof body?.[Symbol.asyncIterator] === "function" ||
     typeof body?.pipe === "function" || typeof body?.read === "function");
  const stream = new globalThis.ReadableStream({
    start(value) {
      controller = value;
    },
    pull() {
      if (state.settled) return state.pending;
      if (isOpenEndedBody) {
        state.pending = (async () => {
          if (!bodyReader && !bodyIterator) {
            if (typeof body.getReader === "function") bodyReader = body.getReader();
            else if (typeof body[Symbol.asyncIterator] === "function") bodyIterator = body[Symbol.asyncIterator]();
          }
          if (!bodyReader && !bodyIterator) throw new TypeError("Expected a streaming request body");
          const { done, value } = bodyReader ? await bodyReader.read() : await bodyIterator.next();
          if (state.settled) return;
          if (done) {
            state.settled = true;
            controller.close();
            return;
          }
          controller.enqueue(typeof value === "string" ? new TextEncoder().encode(value) : asBuffer(value));
        })().catch((error) => {
          if (state.settled) return;
          state.settled = true;
          try { controller.error(error); } catch {}
        });
        return state.pending;
      }
      if (state.started) return state.pending;
      state.started = true;
      state.pending = new Promise((resolve) => setTimeout(resolve, 0))
        .then(() => bytesFromBody(body))
        .then(
          (bytes) => {
            if (state.settled) return;
            if (bytes.byteLength > 0) controller.enqueue(bytes);
            state.settled = true;
            controller.close();
          },
          (error) => {
            if (state.settled) return;
            state.settled = true;
            controller.error(error);
          },
        );
      return state.pending;
    },
    cancel(reason) {
      state.settled = true;
      if (typeof body?.cancel !== "function") return undefined;
      try { return body.cancel(reason); } catch { return undefined; }
    },
  });
  state.stream = stream;
  Object.defineProperty(stream, activeServeRequestBodyStateSymbol, { value: state });
  return stream;
}

let activeServeUnreadBodyAbortError;

function finishActiveServeRequestBody(request, response) {
  const body = request?._body;
  const state = body?.[activeServeRequestBodyStateSymbol];
  if (!state || state.settled || response?._body === body) return;
  // The handler may have attached a reader intending to consume the body
  // while the response streams back; only abort a body never exposed for
  // reading. Anything left unread is still force-aborted on disposal.
  if (body != null && (body.locked === true || bodyStreamIsDisturbed(body))) return;
  state.abort(activeServeUnreadBodyAbortError);
}

async function armActiveFetchResponseAbort(response, signal) {
  const body = response?._body;
  if (!signal || !isStreamingBody(body)) return;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    if (typeof body?.cancel === "function") {
      try { Promise.resolve(body.cancel(normalizedFetchAbortReason(signal))).catch(() => {}); } catch {}
    }
  };
  signal.addEventListener?.("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  // A real HTTP client does not resolve fetch before the server has had a
  // chance to start the response stream. This task boundary also lets an
  // abort issued by the handler's first timer reject fetch and cancel it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (aborted || signal.aborted) throw normalizedFetchAbortReason(signal);
}

function raceWithAbortSignal(promise, signal) {
  if (!signal || typeof signal.addEventListener !== "function") return promise;
  if (signal.aborted) return Promise.reject(normalizedFetchAbortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(normalizedFetchAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener?.("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener?.("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function fetchFromActiveServer(
  activeServer,
  request,
  redirectMode,
  depth,
  redirected,
  decompress = true,
  logicalPeerKey = "http",
  transport = {},
) {
  throwIfAborted(request.signal);
  if (depth > 20) throw new TypeError("redirect count exceeded");
  // Bun's HTTP server normalizes duplicate leading slashes in the request
  // path before routing, while the client-visible response.url keeps the raw
  // request URL text.
  const forceStopController = new AbortController();
  const dispatchSignal = requestState.get(request)?.signalExplicit === true
    ? globalThis.AbortSignal.any([request.signal, forceStopController.signal])
    : forceStopController.signal;
  let dispatchRequest;
  let normalizedDispatchUrl = normalizeServeDispatchUrl(request.url);
  const host = request.headers.get("host");
  if (host) {
    try {
      const parsed = new URL(normalizedDispatchUrl);
      normalizedDispatchUrl = normalizeServeDispatchUrl(`${parsed.protocol}//${host}${parsed.pathname}${parsed.search}${parsed.hash}`);
    } catch {}
  }
  dispatchRequest = new Request(normalizedDispatchUrl, {
    method: request.method,
    headers: new Headers(request.headers),
    signal: dispatchSignal,
    redirect: request.redirect,
  });
  dispatchRequest._body = request._body == null || request.method === "GET" || request.method === "HEAD"
    ? request._body
    : activeServeRequestBody(request._body);
  const peer = activeServeLogicalPeer(activeServer, logicalPeerKey);
  // COTTONTAIL-COMPAT: The in-process fetch fast path has no OS client fd;
  // retain the stable loopback peer identity that its keepalive connection represents.
  serveRequestPeers.set(dispatchRequest, peer);
  const dispatch = activeServeDispatches.get(activeServer);
  const lifecycle = activeServeLifecycles.get(activeServer);
  const lifecycleRequest = lifecycle?.beginRequest(() => forceStopController.abort());
  let controllers = activeServeAbortControllers.get(activeServer);
  if (controllers == null) activeServeAbortControllers.set(activeServer, controllers = new Set());
  controllers.add(forceStopController);
  let response;
  try {
    response = await raceWithAbortSignal(
      dispatch ? dispatch(dispatchRequest) : activeServer.fetch(dispatchRequest),
      dispatchSignal,
    );
    await armActiveFetchResponseAbort(response, dispatchSignal);
  } finally {
    controllers.delete(forceStopController);
    lifecycle?.finishRequest(lifecycleRequest);
  }
  throwIfAborted(request.signal);
  response.url = request.url;
  response.redirected = Boolean(redirected || response.redirected);
  if (!response.statusText) response.statusText = nodeHttp.STATUS_CODES[response.status] ?? "";
  if (redirectMode === "manual" || !isRedirectStatus(response.status)) return decodeFetchResponse(response, decompress);
  if (redirectMode === "error") throw unexpectedRedirectError();

  const location = response.headers.get("location");
  if (!location) return decodeFetchResponse(response, decompress);
  try { await response.body?.cancel?.(); } catch {}
  const nextRequest = redirectedFetchRequest(request, response, location);
  const nextActiveServer = new URL(nextRequest.url).protocol === "http:"
    ? activeServerForFetchUrl(nextRequest.url)
    : null;
  if (nextActiveServer) {
    return fetchFromActiveServer(
      nextActiveServer,
      nextRequest,
      redirectMode,
      depth + 1,
      true,
      decompress,
      logicalPeerKey,
      transport,
    );
  }
  return fetchFromNodeClient(nextRequest, redirectMode, depth + 1, true, { ...transport, decompress });
}

function parseHeadersText(text) {
  const headers = new Headers();
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return headers;
}

function headersToText(headers, preserveFraming = false) {
  let out = "";
  const normalized = new Headers(headers);
  if (!preserveFraming) {
    normalized.delete("content-length");
    normalized.delete("transfer-encoding");
  }
  normalized.delete("connection");
  for (const key of [...normalized._values.keys()].sort()) {
    const entry = normalized._values.get(key);
    const values = key === "set-cookie" ? normalized._allValues.get(key) ?? [] : [entry.value];
    for (const value of values) {
      out += `${entry.key}: ${String(value).replace(/[\r\n]+/g, " ")}\r\n`;
    }
  }
  return out;
}

function isPromiseLike(value) {
  return value != null && typeof value.then === "function";
}

function appendRequestCookieHeaders(response, request) {
  const cookies = request?._cookies;
  if (!cookies || response.__cottontailCookieChangesApplied) return;
  for (const header of cookies.toSetCookieHeaders()) response.headers.append("Set-Cookie", header);
  Object.defineProperty(response, "__cottontailCookieChangesApplied", {
    value: true,
    configurable: true,
  });
}

function normalizeResponse(value, request = undefined) {
  const response = value instanceof Response ? value : new Response(value);
  normalizeServeDateHeader(response.headers);
  appendRequestCookieHeaders(response, request);
  return response;
}

function normalizeResponseResult(value) {
  return isPromiseLike(value) ? value.then(normalizeResponse) : normalizeResponse(value);
}

let cachedServeDateSecond = -1;
let cachedServeDateValue = "";

function cachedServeDateHeader() {
  const second = Math.floor(Date.now() / 1000);
  if (second !== cachedServeDateSecond) {
    cachedServeDateSecond = second;
    cachedServeDateValue = new Date(second * 1000).toUTCString();
  }
  return cachedServeDateValue;
}

function normalizeServeDateHeader(headers) {
  const existing = headers.get("date");
  // `set` collapses duplicates and preserves canonical raw HTTP casing while
  // Headers iteration remains lowercase per the Fetch API.
  headers.set("Date", existing ?? cachedServeDateHeader());
}

function defaultServePort(options) {
  if (options.port != null) return Number(options.port);
  for (const name of ["BUN_PORT", "PORT", "NODE_PORT"]) {
    const value = BunObject.env?.[name] ?? cottontail.env(name);
    if (value != null && value !== "") return Number(value);
  }
  return 3000;
}

function requestPathname(request) {
  const normalize = (value) => String(value || "/").replace(/^\/+/, "/") || "/";
  try {
    return normalize(new URL(request.url).pathname);
  } catch {
    return normalize(String(request.url).replace(/^https?:\/\/[^/]+/, "").split(/[?#]/, 1)[0] || "/");
  }
}

function matchRoutePattern(pattern, pathname) {
  const normalizedPattern = String(pattern);
  if (normalizedPattern === pathname) return {};
  if (normalizedPattern.endsWith("*")) {
    const prefix = normalizedPattern.slice(0, -1);
    return pathname.startsWith(prefix) ? { "*": pathname.slice(prefix.length) } : null;
  }

  const patternParts = normalizedPattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathParts[index];
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

function routeSpecificity(pattern) {
  const parts = String(pattern).split("/").filter(Boolean);
  let literalCount = 0;
  let paramCount = 0;
  let wildcardCount = 0;
  for (const part of parts) {
    if (part === "*" || part.endsWith("*")) wildcardCount += 1;
    else if (part.startsWith(":")) paramCount += 1;
    else literalCount += 1;
  }
  return [
    wildcardCount === 0 ? 1 : 0,
    literalCount,
    parts.length,
    -paramCount,
  ];
}

function compareRouteSpecificity(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return 0;
}

function selectRoute(routes, request) {
  if (!routes || typeof routes !== "object") return null;
  const pathname = requestPathname(request);
  let best = null;
  let order = 0;
  for (const [pattern, route] of Object.entries(routes)) {
    const params = matchRoutePattern(pattern, pathname);
    const currentOrder = order;
    order += 1;
    if (!params) continue;

    let handler = route;
    if (handler && typeof handler === "object" && !isDirectServeRoute(handler)) {
      handler = handler[request.method] ?? handler[request.method.toLowerCase()] ?? handler.ALL ?? handler.all;
      if (handler == null) continue;
    }
    const specificity = routeSpecificity(pattern);
    const candidate = { handler, params, specificity, order: currentOrder };
    if (!best) {
      best = candidate;
      continue;
    }
    const comparison = compareRouteSpecificity(candidate.specificity, best.specificity);
    if (comparison < 0 || (comparison === 0 && candidate.order < best.order)) {
      best = candidate;
    }
  }
  if (!best) return null;
  request.params = best.params;
  return best.handler;
}

function selectStaticRoute(staticRoutes, request) {
  return selectRoute(staticRoutes, request);
}

function bodyType(body) {
  if (body instanceof FormData) return `multipart/form-data; boundary=${formDataBoundary(body)}`;
  if (body && typeof body === "object" && typeof body.type === "string" && body.type !== "") return body.type;
  return "";
}

function bodyLastModified(body) {
  if (body && typeof body === "object" && typeof body._bunFilePath === "string") {
    try {
      const stat = cottontail.statSync(body._bunFilePath, true);
      const mtime = Number(stat?.mtimeMs ?? 0);
      if (mtime > 0) return new Date(mtime).toUTCString();
    } catch {}
  }
  if (body && typeof body === "object" && Number.isFinite(Number(body.lastModified)) && Number(body.lastModified) > 0) {
    return new Date(Number(body.lastModified)).toUTCString();
  }
  return "";
}

function entityTagForBytes(bytes) {
  return `"${createHash("sha1").update(bytes).digest("hex")}"`;
}

function normalizedEntityTag(value) {
  let text = String(value ?? "").trim();
  if (text.startsWith("W/")) text = text.slice(2).trim();
  if (text.length < 2 || !text.startsWith("\"") || !text.endsWith("\"")) return null;
  return text.slice(1, -1);
}

function ifNoneMatchMatches(headerValue, etag) {
  if (!headerValue || !etag) return false;
  const expected = normalizedEntityTag(etag);
  if (expected == null) return false;
  for (const rawPart of String(headerValue).split(",")) {
    const part = rawPart.trim();
    if (part === "*") return true;
    const actual = normalizedEntityTag(part);
    if (actual != null && actual === expected) return true;
  }
  return false;
}

function statusAllowsBody(status) {
  return status !== 101 && status !== 204 && status !== 205 && status !== 304;
}

function isStreamingBody(body) {
  if (typeof body === "function") return true;
  return body != null && (
    typeof body.getReader === "function" ||
    typeof body[Symbol.asyncIterator] === "function"
  );
}

const serveResponseCache = new WeakMap();

function bunFileSliceMetadata(body) {
  if (!body || typeof body !== "object" || typeof body._bunFilePath !== "string") return null;
  const start = Number(body._bunFileStart);
  const end = Number(body._bunFileEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  try {
    const size = Number(cottontail.statSync(body._bunFilePath, true)?.size ?? 0);
    if (!Number.isFinite(size) || size < 0) return null;
    return { start, end, size };
  } catch {
    return null;
  }
}

function bunFileServeSliceIsEmpty(body) {
  let source = body;
  const seen = new Set();
  while (source != null && typeof source === "object" && !seen.has(source)) {
    if (bunFileServeEmptySlices.has(source)) return true;
    seen.add(source);
    source = source[bodyBlobSourceSymbol] ?? source._source;
  }
  return false;
}

function ifModifiedSinceNotModified(headerValue, lastModified) {
  if (!headerValue || !lastModified) return false;
  const requestTime = Date.parse(String(headerValue));
  const modifiedTime = Date.parse(String(lastModified));
  if (!Number.isFinite(requestTime) || !Number.isFinite(modifiedTime)) return false;
  return requestTime >= Math.floor(modifiedTime / 1000) * 1000;
}

function isMissingFileError(error) {
  const text = String(error?.message ?? error ?? "");
  return text.includes("ENOENT") || text.includes("No such file or directory") || text.includes("FileNotFound");
}

async function prepareServeResponse(value, request, options = {}) {
  const cached = options.cacheKey && typeof options.cacheKey === "object"
    ? serveResponseCache.get(options.cacheKey)
    : null;
  const sourceResponse = cached
    ? cached.response.clone()
    : normalizeResponse(value instanceof Response
      // Static routes share one Response object across requests; take the body
      // from a clone so the original is never consumed, even on paths that do
      // not populate the response cache (HEAD, missing files).
      ? (options.cacheKey != null ? value.clone() : value)
      : new Response(value));
  const headers = new Headers(sourceResponse.headers);
  const body = cached ? cached.body : sourceResponse._takeBody();
  const method = String(request.method || "GET").toUpperCase();
  const isFile = isBunFileLike(body);
  const fileSlice = bunFileSliceMetadata(body);
  const emptyFileSlice = isFile && bunFileServeSliceIsEmpty(body);
  const sourceStreaming = !cached && isStreamingBody(body);
  if (sourceStreaming) trackServeReadableStream(body);
  const streaming = method !== "HEAD" && sourceStreaming;

  if (options.allowFileFallback && isFile && typeof body.exists === "function" && !(await body.exists())) {
    return null;
  }

  let status = sourceResponse.status;
  let bytes = cached?.bytes ?? new Uint8Array(0);
  if (statusAllowsBody(status)) {
    if (!cached && method === "HEAD" && isFile && Number.isFinite(Number(body.size))) {
      bytes = { byteLength: Number(body.size) };
    } else if (!cached && method === "HEAD" && sourceStreaming) {
      bytes = { byteLength: 0 };
    } else if (!cached && !streaming && emptyFileSlice) {
      bytes = new Uint8Array(0);
    } else if (!cached && !streaming) {
      try {
        bytes = await bytesFromBody(body);
      } catch (error) {
        if (options.allowFileFallback && isFile && isMissingFileError(error)) return null;
        throw error;
      }
    }
  }

  if (!headers.has("content-type")) {
    const type = bodyType(body);
    if (type) headers.set("Content-Type", type);
    // Bun's static routes tag textual bodies as UTF-8 text.
    else if (options.staticTextContentType && typeof body === "string") {
      headers.set("Content-Type", "text/plain; charset=utf-8");
    }
  }
  if (!headers.has("last-modified")) {
    const lastModified = bodyLastModified(body);
    if (lastModified) headers.set("Last-Modified", lastModified);
  }
  if (fileSlice && status === 200 && !options.preserveFileSliceStatus && (fileSlice.start > 0 || fileSlice.end < fileSlice.size)) {
    status = 206;
    if (!headers.has("content-range")) {
      const rangeEnd = Math.max(fileSlice.start, fileSlice.end) - 1;
      headers.set("Content-Range", `bytes ${fileSlice.start}-${rangeEnd}/${fileSlice.size}`);
    }
  }
  if (isFile && status === 200 && bytes.byteLength === 0) status = 204;

  if ((method === "GET" || method === "HEAD") && status === 200 && ifModifiedSinceNotModified(request.headers.get("if-modified-since"), headers.get("last-modified"))) {
    headers.delete("content-length");
    return normalizeResponse(new Response(null, {
      status: 304,
      statusText: sourceResponse.statusText,
      headers,
    }), request);
  }

  if (statusAllowsBody(status) && sourceStreaming) {
    if (!headers.has("content-length") && !headers.has("transfer-encoding")) {
      headers.set("Transfer-Encoding", "chunked");
    }
  } else if (statusAllowsBody(status)) {
    if (!headers.has("content-length")) headers.set("Content-Length", String(bytes.byteLength));
  } else {
    headers.delete("content-length");
  }
  if (options.addEtag && status === 200 && !streaming && !headers.has("etag")) {
    headers.set("ETag", entityTagForBytes(bytes));
  }

  if (!streaming && !cached && options.cacheKey && typeof options.cacheKey === "object" && bytes instanceof Uint8Array) {
    serveResponseCache.set(options.cacheKey, {
      response: new Response(bytes, {
        status,
        statusText: sourceResponse.statusText,
        headers: new Headers(headers),
      }),
      body,
      bytes,
    });
  }

  if ((method === "GET" || method === "HEAD") && status === 200 && ifNoneMatchMatches(request.headers.get("if-none-match"), headers.get("etag"))) {
    headers.delete("content-length");
    return normalizeResponse(new Response(null, {
      status: 304,
      statusText: sourceResponse.statusText,
      headers,
    }), request);
  }

  return normalizeResponse(new Response(method === "HEAD" ? null : (streaming ? body : bytes), {
    status,
    statusText: sourceResponse.statusText,
    headers,
  }), request);
}

function prepareServeResponseSync(value, request, options = {}) {
  if (options.cacheKey || options.allowFileFallback || options.addEtag) return null;
  const sourceResponse = normalizeResponse(value instanceof Response ? value : new Response(value));
  const rawBody = sourceResponse._body;
  if (!(rawBody == null || typeof rawBody === "string" || rawBody instanceof ArrayBuffer || ArrayBuffer.isView(rawBody))) {
    return null;
  }
  const method = String(request.method || "GET").toUpperCase();
  if (sourceResponse.status === 200 && (request.headers.get("if-modified-since") || request.headers.get("if-none-match"))) return null;
  const body = sourceResponse._takeBody();
  const headers = new Headers(sourceResponse.headers);
  let status = sourceResponse.status;
  const bytes = statusAllowsBody(status) ? bytesFromData(body) : new Uint8Array(0);
  if (!headers.has("content-type")) {
    const type = bodyType(body);
    if (type) headers.set("Content-Type", type);
  }
  if (statusAllowsBody(status)) {
    if (!headers.has("content-length")) headers.set("Content-Length", String(bytes.byteLength));
  } else {
    headers.delete("content-length");
  }
  return normalizeResponse(new Response(method === "HEAD" ? null : bytes, {
    status,
    statusText: sourceResponse.statusText,
    headers,
  }), request);
}

function prepareServeResponseResult(value, request, options = {}) {
  if (isPromiseLike(value)) {
    return value.then((resolved) => prepareServeResponseResult(resolved, request, options));
  }
  return prepareServeResponseSync(value, request, options) ?? prepareServeResponse(value, request, options);
}

function runFetchFallback(options, request, server) {
  if (typeof options.fetch === "function") {
    const value = options.fetch.call(server, request, server);
    const prepare = (resolved) => prepareServeResponseResult(
      resolved instanceof Response
        ? resolved
        : new Response("Welcome to Bun! To get started, return a Response object.", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      request,
    );
    return isPromiseLike(value) ? value.then(prepare) : prepare(value);
  }
  return prepareServeResponse(new Response("Not Found", { status: 404 }), request);
}

function normalizedServeDispatchRequest(request) {
  const url = normalizeRequestUrl(request.url);
  if (url === request.url) return request;
  const normalized = new Request(url, {
    method: request.method,
    headers: new Headers(request.headers),
    signal: request.signal,
    redirect: request.redirect,
  });
  normalized._body = request._body;
  return normalized;
}

function serveResponseWithIdleTimeout(response, idleTimeoutSeconds) {
  const timeoutMs = Number(idleTimeoutSeconds) * 1000;
  const body = response?._body;
  if (!(timeoutMs > 0) || !isStreamingBody(body) || typeof body?.getReader !== "function") return response;

  const reader = body.getReader();
  let controller;
  let timer = null;
  let settled = false;
  let pendingRead = null;
  const clearTimer = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  const fail = () => {
    if (settled) return;
    settled = true;
    timer = null;
    const error = new Error("The socket connection was closed unexpectedly.");
    error.code = "ECONNRESET";
    try { controller.error(error); } catch {}
    try { Promise.resolve(reader.cancel(error)).catch(() => {}); } catch {}
  };
  const armTimer = () => {
    clearTimer();
    timer = setTimeout(fail, timeoutMs);
  };
  const stream = new globalThis.ReadableStream({
    start(value) {
      controller = value;
      armTimer();
    },
    pull() {
      if (settled) return undefined;
      if (pendingRead != null) return pendingRead;
      pendingRead = Promise.resolve(reader.read()).then(
        (result) => {
          if (settled) return;
          if (result.done) {
            settled = true;
            clearTimer();
            controller.close();
            return;
          }
          controller.enqueue(result.value);
          armTimer();
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimer();
          controller.error(error);
        },
      ).finally(() => {
        pendingRead = null;
      });
      return pendingRead;
    },
    cancel(reason) {
      if (settled) return undefined;
      settled = true;
      clearTimer();
      return reader.cancel(reason);
    },
  });
  const timedResponse = responseWithMetadata(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  }, {
    url: response.url,
    redirected: response.redirected,
    type: response.type,
  });
  return timedResponse;
}

async function dispatchServeFetch(options, server, input, init = {}) {
  const request = input instanceof Request ? input : new Request(String(input), init);
  const dispatchRequest = normalizedServeDispatchRequest(request);
  let response;
  try {
    response = await runServeHandler(options, dispatchRequest, server);
  } catch (error) {
    if (typeof options.error !== "function") {
      finishActiveServeRequestBody(dispatchRequest, null);
      reportServeHandlerError(error);
      response = serveErrorResponse(options, error);
    } else {
      response = await serveErrorResponse(options, error);
    }
  }
  finishActiveServeRequestBody(dispatchRequest, response);
  response = serveResponseWithIdleTimeout(response, requestIdleTimeout(dispatchRequest, options.idleTimeout));
  response.url = request.url;
  return response;
}

function serveErrorResponse(options, error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  let response;
  if (typeof options.error === "function") {
    try {
      return normalizeResponseResult(options.error(error));
    } catch (nextError) {
      response = new Response(nextError instanceof Error ? nextError.stack || nextError.message : String(nextError), {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  } else {
    response = new Response(message, {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return normalizeResponseResult(response);
}

function requestBodyByteSize(body) {
  if (body == null) return 0;
  const activeState = body?.[activeServeRequestBodyStateSymbol];
  if (activeState?.byteSize != null) return activeState.byteSize;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  return null;
}

function runServeHandler(options, request, server) {
  // Bun rejects oversized bodies with an empty 413 before the handler runs.
  const maxRequestBodySize = Number(options.maxRequestBodySize ?? 128 * 1024 * 1024);
  if (Number.isFinite(maxRequestBodySize) && maxRequestBodySize > 0) {
    const bodySize = requestBodyByteSize(request._body);
    if (bodySize != null && bodySize > maxRequestBodySize) {
      return new Response(null, { status: 413, statusText: "Payload Too Large" });
    }
  }
  const htmlState = options[serveHtmlStateSymbol];
  if (htmlState && (request.method === "GET" || request.method === "HEAD")) {
    const asset = htmlState.assets.get(requestPathname(request));
    if (asset) return prepareServeHtmlDescriptor(asset, request);
  }
  if (options.static && typeof options.static === "object") {
    const staticRoute = selectStaticRoute(options.static, request);
    if (staticRoute != null) {
      if (staticRoute === false) return runFetchFallback(options, request, server);
      if (isHtmlAssetRoute(staticRoute) || isHtmlSourceRoute(staticRoute) || isHtmlManifestRoute(staticRoute)) {
        return prepareServeHtmlRoute(htmlState, options, staticRoute, request);
      }
      const response = typeof staticRoute === "function" ? staticRoute(request, server) : staticRoute;
      return prepareServeResponseResult(response, request, {
        addEtag: true,
        cacheKey: typeof staticRoute === "function"
          ? null
          : staticRoute && typeof staticRoute === "object" ? staticRoute : null,
      });
    }
  }

  const route = selectRoute(options.routes, request);
  if (route != null) {
    if (route === false) return runFetchFallback(options, request, server);
    if (isHtmlAssetRoute(route) || isHtmlSourceRoute(route) || isHtmlManifestRoute(route)) {
      return prepareServeHtmlRoute(htmlState, options, route, request);
    }
    let response = typeof route === "function" ? route(request, server) : route;
    const prepared = prepareServeResponseResult(response, request, {
      allowFileFallback: true,
      preserveFileSliceStatus: typeof route !== "function",
      staticTextContentType: typeof route !== "function",
      // A static route Response object is shared by every request; serve each
      // one from a cached snapshot instead of consuming the original body.
      cacheKey: typeof route !== "function" && route && typeof route === "object" ? route : null,
    });
    return isPromiseLike(prepared)
      ? prepared.then((resolved) => resolved ?? runFetchFallback(options, request, server))
      : (prepared ?? runFetchFallback(options, request, server));
  }
  return runFetchFallback(options, request, server);
}

function bunServeNeedsHandlerMessage() {
  return `Bun.serve() needs either:

  - A routes object:
     routes: {
       "/path": {
         GET: (req) => new Response("Hello")
       }
     }

  - Or a fetch handler:
     fetch: (req) => {
       return new Response("Hello")
     }

Learn more at https://bun.com/docs/api/http`;
}

function invalidRoutesMessage() {
  return `'routes' expects a Record<string, Response | HTMLBundle | {[method: string]: (req: BunRequest) => Response|Promise<Response>}>

To bundle frontend apps on-demand with Bun.serve(), import HTML files.

Example:

\`\`\`js
import { serve } from "bun";
import app from "./app.html";

serve({
  routes: {
    "/index.json": Response.json({ message: "Hello World" }),
    "/app": app,
    "/path/:param": (req) => {
      const param = req.params.param;
      return Response.json({ message: \`Hello \${param}\` });
    },
    "/path": {
      GET(req) {
        return Response.json({ message: "Hello World" });
      },
      POST(req) {
        return Response.json({ message: "Hello World" });
      },
    },
  },

  fetch(request) {
    return new Response("fallback response");
  },
});
\`\`\`

See https://bun.com/docs/api/http for more information.`;
}

const serveHtmlStateSymbol = Symbol("cottontail.serveHtmlState");
const prepareServeHtmlSymbol = Symbol.for("cottontail.prepareHtmlServe");
const serveInspectorOriginalRoutesSymbol = Symbol("cottontail.serveInspectorOriginalRoutes");
const serveInspectorDevServerSymbol = Symbol("cottontail.serveInspectorDevServer");
const serveInspectorRuntimeSymbol = Symbol.for("cottontail.serveInspectorRuntime");
const serveInspectorRuntime = globalThis[serveInspectorRuntimeSymbol] ?? {
  nextServerId: 1,
  nextConnectionId: 0,
  pendingReloads: [],
};
if (globalThis[serveInspectorRuntimeSymbol] == null) {
  Object.defineProperty(globalThis, serveInspectorRuntimeSymbol, {
    value: serveInspectorRuntime,
    configurable: true,
  });
}

function inspectorEmit(method, params) {
  try {
    return cottontail.inspectorEvent?.(method, JSON.stringify(params)) === true;
  } catch {
    return false;
  }
}

function inspectorSetModuleGraph(state) {
  const cwd = globalThis.process?.cwd?.() ?? cottontail.cwd();
  const argv = Array.from(globalThis.process?.argv ?? [], String);
  const main = nodePathResolve(argv[1] ?? globalThis.__filename ?? "");
  const esm = ["bun:main", main, ...state.sources];
  const seen = new Set();
  const graph = {
    esm: esm.filter(value => value && !seen.has(value) && seen.add(value)),
    cjs: [],
    cwd,
    main,
    argv,
  };
  try { cottontail.inspectorSetModuleGraph?.(JSON.stringify(graph)); } catch {}
}

function inspectorRouteList(options) {
  const routes = options[serveInspectorOriginalRoutesSymbol] ?? options.routes;
  const api = [];
  const html = [];
  for (const [routePath, route] of Object.entries(routes ?? {})) {
    if (isHtmlAssetRoute(route) || isHtmlSourceRoute(route) || isHtmlManifestRoute(route)) {
      const source = isHtmlSourceRoute(route) || isHtmlManifestRoute(route) ? route.index : route;
      html.push({
        path: routePath,
        type: "html",
        scriptLine: -1,
        filePath: nodePathResolve(String(source)),
      });
    } else {
      api.push({ path: routePath, type: "api", scriptLine: -1 });
    }
  }
  return [...api, ...html].map((route, routeId) => ({ routeId, ...route }));
}

function finalizeServeInspector(server, options, reloadState = null) {
  const htmlState = options[serveHtmlStateSymbol];
  const inspectorState = {
    id: reloadState?.serverId ?? serveInspectorRuntime.nextServerId++,
    hotReloadId: reloadState?.hotReloadId ?? 0,
    suppressClose: false,
    closed: false,
    server,
    sources: [...(htmlState?.sources ?? [])],
  };
  if (htmlState) htmlState.inspectorState = inspectorState;
  const devState = options[serveInspectorDevServerSymbol];
  if (devState) {
    devState.inspectorState = inspectorState;
    devState.server = server;
  }

  if (!reloadState) {
    inspectorEmit("HTTPServer.listen", {
      serverId: inspectorState.id,
      url: String(server.url),
      startTime: Date.now(),
    });
  }
  inspectorEmit("HTTPServer.serverRoutesUpdated", {
    serverId: inspectorState.id,
    hotReloadId: inspectorState.hotReloadId,
    routes: inspectorRouteList(options),
  });
  inspectorSetModuleGraph(inspectorState);

  const originalStop = server.stop;
  server.stop = function inspectorServerStop(force = false) {
    if (!inspectorState.suppressClose && !inspectorState.closed) {
      inspectorState.closed = true;
      inspectorEmit("HTTPServer.close", { serverId: inspectorState.id, timestamp: Date.now() });
    }
    return Reflect.apply(originalStop, this, [force]);
  };

  globalThis.__cottontailHotReloadHooks?.add?.(() => {
    inspectorState.suppressClose = true;
    serveInspectorRuntime.pendingReloads.push({
      serverId: inspectorState.id,
      hotReloadId: inspectorState.hotReloadId + 1,
      port: server.port,
    });
    server.stop(true);
  });
  return server;
}

function installInspectorDevServer(options) {
  const htmlState = options[serveHtmlStateSymbol];
  if (!serveIsDevelopment(options) || htmlState?.sources?.size === 0 || options.websocket != null) return options;
  const htmlRoutes = Object.entries(options.routes ?? {})
    .filter(([, route]) => isHtmlAssetRoute(route) || isHtmlSourceRoute(route) || isHtmlManifestRoute(route))
    .map(([routePath]) => routePath);
  const state = { server: null, inspectorState: null, htmlRoutes };
  const hmrRoute = (request, server) => {
    server.upgrade(request, { data: { inspectorHmr: true } });
  };
  const websocket = {
    open(socket) {
      const connectionId = serveInspectorRuntime.nextConnectionId++;
      socket.data.connectionId = connectionId;
      inspectorEmit("BunFrontendDevServer.clientConnected", {
        serverId: state.inspectorState?.id ?? 0,
        connectionId,
      });
    },
    message(socket, rawMessage) {
      const message = typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
      const connectionId = Number(socket.data?.connectionId ?? -1);
      if (message.startsWith("n")) {
        const destination = message.slice(1) || "/";
        inspectorEmit("BunFrontendDevServer.clientNavigated", {
          serverId: state.inspectorState?.id ?? 0,
          connectionId,
          url: new URL(destination, String(state.server.url)).href,
          routeBundleId: Math.max(0, state.htmlRoutes.indexOf(destination)),
        });
      } else if (message.startsWith("l") && message.length >= 2) {
        inspectorEmit("BunFrontendDevServer.consoleLog", {
          serverId: state.inspectorState?.id ?? 0,
          kind: message.charCodeAt(1),
          message: message.slice(2),
        });
      }
    },
    close(socket) {
      inspectorEmit("BunFrontendDevServer.clientDisconnected", {
        serverId: state.inspectorState?.id ?? 0,
        connectionId: Number(socket.data?.connectionId ?? -1),
      });
    },
  };
  return {
    ...options,
    [serveInspectorOriginalRoutesSymbol]: options.routes,
    [serveInspectorDevServerSymbol]: state,
    routes: { ...(options.routes ?? {}), "/_bun/hmr": hmrRoute },
    websocket,
  };
}

function isHtmlManifestRoute(value) {
  return value != null && typeof value === "object" &&
    typeof value.index === "string" && Array.isArray(value.files);
}

function isHtmlSourceRoute(value) {
  return value != null && typeof value === "object" &&
    typeof value.index === "string" && value.files == null && /\.html?$/i.test(value.index);
}

function isHtmlAssetRoute(value) {
  // HTML imports resolve to their on-disk asset path (cottontail's
  // representation of Bun's HTMLBundle), e.g. `import app from "./app.html"`.
  return typeof value === "string" && /\.html?$/i.test(value);
}

function isDirectServeRoute(value) {
  return value instanceof Response || isHtmlManifestRoute(value) || isHtmlSourceRoute(value) || isHtmlAssetRoute(value) ||
    (value && typeof value === "object" && typeof value.arrayBuffer === "function");
}

function manifestPublicRoute(path) {
  const cwd = globalThis.process?.cwd?.() ?? cottontail.cwd();
  const raw = String(path).replace(/\\/g, "/");
  let relative = raw;
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    relative = nodePathRelative(cwd, raw).replace(/\\/g, "/");
  }
  while (relative.startsWith("./")) relative = relative.slice(2);
  while (relative.startsWith("../")) relative = relative.slice(3);
  return `/${relative.replace(/^\/+/, "")}`;
}

function serveHtmlFileDescriptor(path, headers, loader = "file", kind = "entry-point", hash = null, sourcemap = null) {
  return { path, headers: new Headers(headers), loader, kind, hash, sourcemap, cacheKey: {} };
}

function registerServeHtmlManifest(state, manifest) {
  const existing = state.manifests.get(manifest);
  if (existing) return existing;
  const cwd = globalThis.process?.cwd?.() ?? cottontail.cwd();
  let indexDescriptor = null;
  for (const item of manifest.files) {
    if (item == null || typeof item !== "object" || typeof item.path !== "string") continue;
    const absolutePath = nodePathResolve(cwd, item.path);
    let stat;
    try { stat = cottontail.statSync(absolutePath, true); } catch {}
    if (!stat?.isFile) {
      throw new TypeError(`Bundled file ${item.path} not found. You may want to configure --asset-naming or \`naming\` when bundling.`);
    }
    const descriptor = serveHtmlFileDescriptor(
      absolutePath,
      item.headers ?? {},
      String(item.loader ?? "file"),
      item.isEntry ? "entry-point" : "asset",
      item.headers?.etag ?? null,
    );
    if (item.path === manifest.index) indexDescriptor = descriptor;
    else state.assets.set(manifestPublicRoute(item.path), descriptor);
  }
  if (!indexDescriptor) throw new TypeError(`Bundled HTML entry ${manifest.index} not found in manifest.`);
  state.manifests.set(manifest, indexDescriptor);
  return indexDescriptor;
}

function visitServeHtmlRouteValues(state, routes) {
  if (routes == null || typeof routes !== "object") return;
  for (const value of Object.values(routes)) {
    if (isHtmlAssetRoute(value) || isHtmlSourceRoute(value)) {
      state.sources.add(nodePathResolve(isHtmlSourceRoute(value) ? value.index : value));
    } else if (isHtmlManifestRoute(value)) {
      registerServeHtmlManifest(state, value);
    } else if (value && typeof value === "object" && !isDirectServeRoute(value)) {
      visitServeHtmlRouteValues(state, value);
    }
  }
}

function registerServeHtmlOptions(state, options) {
  visitServeHtmlRouteValues(state, options?.routes);
  visitServeHtmlRouteValues(state, options?.static);
}

function createServeHtmlState(options) {
  const state = {
    assets: new Map(),
    manifests: new WeakMap(),
    sources: new Set(),
    htmlBySource: new Map(),
    builtSources: new Set(),
    buildPromise: null,
    configPromise: null,
    preparedBuildReady: false,
  };
  registerServeHtmlOptions(state, options);
  return state;
}

function serveIsDevelopment(options) {
  return options?.development === true ||
    (options?.development != null && typeof options.development === "object");
}

function commonHtmlBuildRoot(paths) {
  let root = pathDirname(paths[0]);
  for (const path of paths.slice(1)) {
    while (root !== pathDirname(root)) {
      const relative = nodePathRelative(root, path).replace(/\\/g, "/");
      if (relative !== ".." && !relative.startsWith("../")) break;
      root = pathDirname(root);
    }
  }
  return root;
}

async function loadServeHtmlStaticConfig() {
  const cwd = globalThis.process?.cwd?.() ?? cottontail.cwd();
  const bunfigPath = nodePathResolve(cwd, "bunfig.toml");
  let staticConfig = {};
  try {
    staticConfig = TOML.parse(cottontail.readFile(bunfigPath))?.serve?.static ?? {};
  } catch {}
  const pluginSpecifiers = [];
  for (const pluginPath of Array.isArray(staticConfig.plugins) ? staticConfig.plugins : []) {
    const resolvedPath = await resolve(String(pluginPath), pathDirname(bunfigPath));
    pluginSpecifiers.push(nodePathToFileURL(resolvedPath).href);
  }
  return { env: staticConfig.env, pluginSpecifiers };
}

function normalizeServeHtmlPlugin(namespace) {
  let plugin = namespace;
  while (plugin != null && typeof plugin === "object" && typeof plugin.setup !== "function" &&
    plugin.default != null && plugin.default !== plugin) {
    plugin = plugin.default;
  }
  return plugin;
}

async function serveHtmlBuildConfig(state) {
  if (state.configPromise) return state.configPromise;
  state.configPromise = (async () => {
    const staticConfig = await loadServeHtmlStaticConfig();
    const plugins = [];
    for (const specifier of staticConfig.pluginSpecifiers) {
      const plugin = normalizeServeHtmlPlugin(await import(specifier));
      if (plugin != null) plugins.push(plugin);
    }
    return { env: staticConfig.env, plugins };
  })();
  return state.configPromise;
}

function generatedArtifactRoute(path) {
  let relative = String(path ?? "").replace(/\\/g, "/");
  while (relative.startsWith("./")) relative = relative.slice(2);
  while (relative.startsWith("../")) relative = relative.slice(3);
  return `/${relative.replace(/^\/+/, "")}`;
}

function serializeServeBuildErrors(owner, root, logs) {
  const bytes = [];
  const encoder = new TextEncoder();
  const u8 = value => bytes.push(Number(value) & 0xff);
  const u32 = value => {
    const number = Number(value) >>> 0;
    bytes.push(number & 0xff, (number >>> 8) & 0xff, (number >>> 16) & 0xff, (number >>> 24) & 0xff);
  };
  const string32 = value => {
    const encoded = encoder.encode(String(value ?? ""));
    u32(encoded.byteLength);
    bytes.push(...encoded);
  };
  const location = position => {
    if (!position || Number(position.line) <= 0) {
      u32(0);
      return;
    }
    u32(position.line);
    u32(position.column);
    u32(position.length ?? 0);
    string32(position.lineText ?? "");
  };
  const level = value => ({ error: 0, warning: 1, warn: 1, note: 2, debug: 3, verbose: 4 })[value] ?? 0;
  const normalizedLogs = Array.from(logs ?? []);
  const sourcePath = normalizedLogs.find(log => log?.position?.file)?.position?.file ?? "";
  const relativeSource = sourcePath ? nodePathRelative(root, String(sourcePath)).replace(/\\/g, "/") : "";
  u32(owner);
  string32(relativeSource);
  u32(normalizedLogs.length);
  for (const log of normalizedLogs) {
    u8(level(log?.level));
    string32(log?.message ?? String(log));
    location(log?.position);
    const notes = Array.isArray(log?.notes) ? log.notes : [];
    u32(notes.length);
    for (const note of notes) {
      string32(note?.message ?? String(note));
      location(note?.position);
    }
  }
  return globalThis.Buffer.from(new Uint8Array(bytes)).toString("base64");
}

async function buildServeHtmlBatch(state, options, batch) {
  const development = serveIsDevelopment(options);
  const root = commonHtmlBuildRoot(batch);
  const inspectorState = state.inspectorState;
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  if (inspectorState) {
    inspectorEmit("BunFrontendDevServer.bundleStart", {
      serverId: inspectorState.id,
      triggerFiles: batch,
    });
  }
  const config = await serveHtmlBuildConfig(state);
  const buildOptions = {
    entrypoints: batch,
    target: "browser",
    root,
    __cottontailWorkingDirectory: root,
    publicPath: "/",
    sourcemap: "linked",
    minify: !development,
    production: !development,
    define: {
      "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production"),
    },
    jsx: { development },
    throw: false,
    ...(config.env != null ? { env: config.env } : {}),
    ...(config.plugins.length > 0 ? { plugins: config.plugins } : {}),
  };
  let result;
  try {
    result = await build(buildOptions);
  } catch (error) {
    const logs = error instanceof AggregateError ? error.errors : [error];
    if (inspectorState) {
      inspectorEmit("BunFrontendDevServer.bundleFailed", {
        serverId: inspectorState.id,
        buildErrorsPayloadBase64: serializeServeBuildErrors(inspectorState.id, root, logs),
      });
    }
    throw error;
  }
  if (!result.success) {
    if (inspectorState) {
      inspectorEmit("BunFrontendDevServer.bundleFailed", {
        serverId: inspectorState.id,
        buildErrorsPayloadBase64: serializeServeBuildErrors(inspectorState.id, root, result.logs),
      });
    }
    throw new AggregateError(result.logs ?? [], "Bundle failed");
  }

  const htmlOutputs = [];
  const outputDescriptors = [];
  for (const artifact of result.outputs) {
    const route = generatedArtifactRoute(artifact.path);
    const headers = new Headers();
    const contentType = artifact.type || guessMimeType(artifact.path);
    if (contentType) headers.set("Content-Type", contentType);
    if (artifact.loader !== "html" && artifact[ctBuildArtifactContentHashSymbol] != null) {
      headers.set("ETag", String(artifact[ctBuildArtifactContentHashSymbol]));
    }
    if (!development && artifact.kind === "chunk") {
      headers.set("Cache-Control", "public, max-age=31536000");
    }
    if (development && artifact.sourcemap?.path) {
      headers.set("SourceMap", generatedArtifactRoute(artifact.sourcemap.path));
    }
    const descriptor = {
      artifact,
      headers,
      loader: artifact.loader,
      kind: artifact.kind,
      hash: artifact.hash,
      sourcemap: artifact.sourcemap,
      cacheKey: {},
    };
    state.assets.set(route, descriptor);
    outputDescriptors.push({ route, descriptor });
    if (artifact.loader === "html" && artifact.kind === "entry-point") {
      htmlOutputs.push({ route: route.slice(1), descriptor });
    }
  }

  const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const { descriptor } of outputDescriptors) {
    if (!new Set(["html", "css", "js"]).has(descriptor.loader)) continue;
    let contents = await descriptor.artifact.text();
    if (!contents.includes("/../")) continue;
    for (const { route } of outputDescriptors) {
      const basename = nodePathBasename(route);
      const quotedUrl = new RegExp(`(["'])/[^"'\\s<>]*${escapeRegExp(basename)}\\1`, "g");
      contents = contents.replace(quotedUrl, (_, quote) => `${quote}${route}${quote}`);
    }
    descriptor.body = contents;
  }

  const unmatched = [...htmlOutputs];
  for (const source of batch) {
    const relative = nodePathRelative(root, source).replace(/\\/g, "/").replace(/^\.\//, "");
    let index = unmatched.findIndex(output => output.route === relative);
    if (index < 0) {
      const basename = nodePathBasename(source);
      index = unmatched.findIndex(output => nodePathBasename(output.route) === basename);
    }
    if (index < 0) throw new Error(`HTML entry point not found in bundle output: ${source}`);
    const [{ descriptor }] = unmatched.splice(index, 1);
    state.htmlBySource.set(source, descriptor);
    state.builtSources.add(source);
  }
  if (inspectorState) {
    inspectorEmit("BunFrontendDevServer.bundleComplete", {
      serverId: inspectorState.id,
      durationMs: (globalThis.performance?.now?.() ?? Date.now()) - startedAt,
    });
  }
}

function ensureServeHtmlSource(state, options, source) {
  const absoluteSource = nodePathResolve(source);
  state.sources.add(absoluteSource);
  const ready = state.htmlBySource.get(absoluteSource);
  const development = serveIsDevelopment(options);
  if (ready && (!development || state.preparedBuildReady)) {
    state.preparedBuildReady = false;
    return Promise.resolve(ready);
  }
  if (!state.buildPromise) {
    if (development) {
      state.assets.clear();
      state.htmlBySource.clear();
      state.builtSources.clear();
    }
    const batch = development
      ? [...state.sources]
      : [...state.sources].filter(path => !state.builtSources.has(path));
    state.buildPromise = buildServeHtmlBatch(state, options, batch).finally(() => {
      state.buildPromise = null;
    });
  }
  return state.buildPromise.then(() => {
    const descriptor = state.htmlBySource.get(absoluteSource);
    if (descriptor) return descriptor;
    return ensureServeHtmlSource(state, options, absoluteSource);
  });
}

async function prepareServeHtml(options, config) {
  if (options == null || typeof options !== "object") return;
  const state = options[serveHtmlStateSymbol] ?? createServeHtmlState(options);
  options[serveHtmlStateSymbol] = state;
  state.configPromise = Promise.resolve(config);
  const batch = [...state.sources];
  if (batch.length === 0 || state.buildPromise) return state.buildPromise;
  state.buildPromise = buildServeHtmlBatch(state, options, batch);
  try {
    await state.buildPromise;
    state.preparedBuildReady = true;
  } finally {
    state.buildPromise = null;
  }
}

Object.defineProperty(globalThis, prepareServeHtmlSymbol, {
  value: {
    loadConfig: loadServeHtmlStaticConfig,
    normalizePlugin: normalizeServeHtmlPlugin,
    build: prepareServeHtml,
  },
  configurable: true,
});

function responseForServeHtmlDescriptor(descriptor) {
  const body = descriptor.body ?? descriptor.artifact ?? file(descriptor.path);
  return new Response(body, { headers: new Headers(descriptor.headers) });
}

function prepareServeHtmlDescriptor(descriptor, request) {
  return prepareServeResponseResult(responseForServeHtmlDescriptor(descriptor), request, {
    cacheKey: descriptor.cacheKey,
  });
}

function prepareServeHtmlRoute(state, options, route, request) {
  if (isHtmlManifestRoute(route)) {
    return prepareServeHtmlDescriptor(registerServeHtmlManifest(state, route), request);
  }
  return ensureServeHtmlSource(state, options, isHtmlSourceRoute(route) ? route.index : route).then(
    descriptor => prepareServeHtmlDescriptor(descriptor, request),
    error => prepareServeResponseResult(new Response(error instanceof Error ? error.stack || error.message : String(error), {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }), request),
  );
}

function isValidRouteHandler(value) {
  return value === false ||
    typeof value === "function" ||
    value instanceof Response ||
    isHtmlManifestRoute(value) ||
    isHtmlSourceRoute(value) ||
    isHtmlAssetRoute(value) ||
    (value && typeof value === "object" && typeof value.arrayBuffer === "function");
}

function validateRoutePattern(pattern) {
  const seen = new Set();
  for (const part of String(pattern).split("/").filter(Boolean)) {
    if (!part.startsWith(":")) continue;
    const name = part.slice(1);
    if (/^\d/.test(name)) throw new TypeError("Route parameter names cannot start with a number.");
    if (seen.has(name)) throw new TypeError("Support for duplicate route parameter names is not yet implemented.");
    seen.add(name);
  }
}

function validateServeRoutes(routes) {
  if (routes == null) return false;
  if (typeof routes !== "object") throw new TypeError(invalidRoutesMessage());
  const entries = Object.entries(routes);
  for (const [pattern, route] of entries) {
    validateRoutePattern(pattern);
    if (isValidRouteHandler(route)) continue;
    if (route && typeof route === "object") {
      let validMethodObject = true;
      for (const value of Object.values(route)) {
        if (!isValidRouteHandler(value)) {
          validMethodObject = false;
          break;
        }
      }
      if (validMethodObject) continue;
    }
    throw new TypeError(invalidRoutesMessage());
  }
  return entries.length > 0;
}

function coerceServeOptionString(value, name) {
  if (typeof value === "symbol") throw new TypeError(`${name} must be coercible to a string`);
  if (value === null || value === undefined) return "";
  if (typeof value !== "object" && typeof value !== "function") return String(value);

  for (const methodName of ["toString", "valueOf"]) {
    const method = value[methodName];
    if (typeof method !== "function") continue;
    const result = method.call(value);
    if (result === null || result === undefined || typeof result === "symbol") {
      throw new TypeError(`${name} must be coercible to a string`);
    }
    if (typeof result !== "object" && typeof result !== "function") return String(result);
  }
  throw new TypeError(`${name} must be coercible to a string`);
}

function normalizeServeHostname(value) {
  const hostname = value === null || value === undefined
    ? ""
    : coerceServeOptionString(value, "hostname");
  if (hostname.length === 0) return "localhost";
  const bareIpv6 = hostname.replace(/^\[|\]$/g, "");
  if (bareIpv6.includes(":")) {
    if (!/^[0-9A-Fa-f:.%]+$/.test(bareIpv6)) {
      throw new TypeError(`Invalid hostname: ${hostname}`);
    }
    return bareIpv6;
  }
  if (hostname.length > 253 || hostname.includes("\0")) {
    throw new TypeError(`Invalid hostname: ${hostname}`);
  }
  const labels = hostname.split(".");
  if (labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    throw new TypeError(`Invalid hostname: ${hostname}`);
  }
  return hostname;
}

function normalizeServeUnixPath(value) {
  if (value === null || value === undefined) return "";
  const path = coerceServeOptionString(value, "unix");
  if (path.includes("\0")) throw new TypeError("unix must not contain NUL bytes");
  return path;
}

function isWindowsNamedPipePath(path) {
  return /^(?:\\\\[.?]\\pipe\\|\/\/[.?]\/pipe\/)/i.test(String(path));
}

function windowsUnixPathKey(path) {
  const value = String(path);
  if (isWindowsNamedPipePath(value)) {
    return `pipe:${value.replaceAll("/", "\\").toLowerCase()}`;
  }
  let resolved = value;
  try { resolved = nodePathResolve(value); } catch {}
  return `unix:${resolved.replaceAll("/", "\\").toLowerCase()}`;
}

function windowsUnixTransportPath(path) {
  const value = String(path);
  if (process.platform !== "win32") return value;
  if (isWindowsNamedPipePath(value)) return value.replaceAll("/", "\\");
  const digest = createHash("sha256").update(windowsUnixPathKey(value)).digest("hex").slice(0, 40);
  return `\\\\.\\pipe\\cottontail-unix-${digest}`;
}

const windowsUnixSocketAliases = globalThis.__cottontailWindowsUnixSocketAliases ??= new Map();
globalThis.__cottontailResolveWindowsUnixSocketAlias ??= (path) => {
  const value = String(path);
  if (process.platform !== "win32") return value;
  return windowsUnixSocketAliases.get(windowsUnixPathKey(value)) ?? value;
};

function registerWindowsUnixSocketAlias(publicPath, transportPath) {
  if (process.platform !== "win32") return () => {};
  const key = windowsUnixPathKey(publicPath);
  windowsUnixSocketAliases.set(key, transportPath);
  return () => {
    if (windowsUnixSocketAliases.get(key) === transportPath) windowsUnixSocketAliases.delete(key);
  };
}

// ---------------------------------------------------------------------------
// Bun.serve websocket + TLS backend (built on node/http.js + node/https.js)
// ---------------------------------------------------------------------------

const WEBSOCKET_HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const webSocketSentBytesSymbol = Symbol("cottontail.webSocketSentBytes");
const serveUpgradeContexts = new WeakMap();
const serveRequestSockets = new WeakMap();
const serveRequestPeers = new WeakMap();
const activeServeLogicalPeers = new WeakMap();
let nextActiveServeClientPort = 49152;

function activeServeLogicalPeer(server, key = "http") {
  let peers = activeServeLogicalPeers.get(server);
  if (!peers) {
    peers = new Map();
    activeServeLogicalPeers.set(server, peers);
  }
  const normalizedKey = String(key);
  let peer = peers.get(normalizedKey);
  if (peer) return peer;

  let address = String(server.hostname ?? "127.0.0.1").replace(/^\[|\]$/g, "");
  if (address === "localhost" || address === "0.0.0.0") address = "127.0.0.1";
  else if (address === "::") address = "::1";
  peer = {
    address,
    family: address.includes(":") ? "IPv6" : "IPv4",
    port: nextActiveServeClientPort,
  };
  nextActiveServeClientPort = nextActiveServeClientPort >= 65535 ? 49152 : nextActiveServeClientPort + 1;
  peers.set(normalizedKey, peer);
  if (peers.size > MAX_REUSABLE_CUSTOM_FETCH_HTTPS_AGENTS) {
    peers.delete(peers.keys().next().value);
  }
  return peer;
}

function websocketAcceptKeyForServe(key) {
  return createHash("sha1").update(`${key}${WEBSOCKET_HANDSHAKE_GUID}`).digest("base64");
}

function websocketPayloadBytes(data) {
  if (typeof data === "string") return Buffer.from(data);
  if (data == null) return Buffer.alloc(0);
  return asBuffer(data);
}

function encodeServerWebSocketFrame(opcode, payload, rsv1 = false) {
  const body = websocketPayloadBytes(payload);
  const length = body.byteLength;
  const first = 0x80 | (rsv1 ? 0x40 : 0) | (opcode & 0x0f);
  let header;
  if (length < 126) {
    header = Buffer.from([first, length]);
  } else if (length <= 0xffff) {
    header = Buffer.from([first, 126, (length >> 8) & 0xff, length & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    let big = BigInt(length);
    for (let index = 9; index >= 2; index -= 1) {
      header[index] = Number(big & 0xffn);
      big >>= 8n;
    }
  }
  return Buffer.concat([header, body]);
}

function serveHandlerErrorDiagnostic(error) {
  if (!(error instanceof Error) || typeof error.stack !== "string") return null;
  const frame = error.stack.match(/(?:^|\n)\s*at [^\n]*?\(?([^()\n]+):(\d+):(\d+)\)?/);
  if (!frame) return null;
  let sourcePath = frame[1].trim();
  if (sourcePath.startsWith("file://")) {
    try { sourcePath = nodeFileURLToPath(sourcePath); } catch {}
  }
  const lineNumber = Number(frame[2]);
  if (!Number.isInteger(lineNumber) || lineNumber < 1) return null;
  let sourceLine;
  try { sourceLine = String(cottontail.readFile(sourcePath)).split(/\r?\n/)[lineNumber - 1]; } catch { return null; }
  if (sourceLine == null) return null;
  const column = Math.max(1, Number(frame[3]) || 1);
  return `${lineNumber} | ${sourceLine}\n${" ".repeat(String(lineNumber).length + 3 + column - 1)}^`;
}

function reportServeHandlerError(error) {
  const diagnostic = serveHandlerErrorDiagnostic(error);
  if (diagnostic != null) console.error(diagnostic);
  process.nextTick(() => { throw error; });
}

function invokeWebSocketHandler(state, name, ...args) {
  const handlers = state.getHandlers();
  const handler = handlers?.[name];
  if (typeof handler !== "function") return undefined;
  try {
    const result = handler(...args);
    if (isPromiseLike(result)) {
      result.then(undefined, (error) => reportWebSocketHandlerError(state, error, name));
    }
    return result;
  } catch (error) {
    reportWebSocketHandlerError(state, error, name);
    return undefined;
  }
}

function reportWebSocketHandlerError(state, error, sourceName) {
  const onError = state.getHandlers()?.error;
  if (sourceName !== "error" && typeof onError === "function") {
    try {
      const result = onError(error);
      if (isPromiseLike(result)) result.then(undefined, reportServeHandlerError);
      return;
    } catch (handlerError) {
      reportServeHandlerError(handlerError);
      return;
    }
  }
  reportServeHandlerError(error);
}

function assertWebSocketCompressFlag(compress, name) {
  if (compress !== undefined && typeof compress !== "boolean") {
    throw new TypeError(`${name} expects compress to be a boolean`);
  }
}

function flushServerWebSocketFrames(state) {
  state.frameFlushScheduled = false;
  if (state.pendingFrames.length === 0) return;
  const frames = state.pendingFrames;
  const byteLength = state.pendingFrameBytes;
  state.pendingFrames = [];
  state.pendingFrameBytes = 0;
  const socket = state.socket;
  if (!socket || socket.destroyed || !socket.writable || state.finalized) return;
  const output = frames.length === 1 ? frames[0] : Buffer.concat(frames, byteLength);
  const ok = socket.write(output, () => {
    if (state.wantDrain && socket.writableLength === 0) scheduleServerWebSocketDrain(state);
  });
  if (!ok || socket.writableLength > state.config.backpressureLimit) {
    state.wantDrain = true;
    if (state.config.closeOnBackpressureLimit) terminateServerWebSocket(state);
  }
}

function sendServerWebSocketFrame(state, opcode, data, compress = false) {
  if (state.readyState !== 1) return 0;
  const socket = state.socket;
  if (!socket || socket.destroyed || !socket.writable) return 0;
  let payload = websocketPayloadBytes(data);
  // RFC 6455 5.5: control frame payloads are limited to 125 bytes. Bun's
  // native server truncates instead of erroring.
  if (opcode >= 0x8 && payload.byteLength > 125) payload = payload.subarray(0, 125);
  const originalLength = payload.byteLength;
  let rsv1 = false;
  if (compress === true && state.deflate != null && opcode <= 0x2 && payload.byteLength > 0) {
    payload = nodeHttp.websocketDeflateCompress(payload, state.deflate.serverWindowBits);
    rsv1 = true;
  }
  const limit = state.config.backpressureLimit;
  if (state.wantDrain) return 0;
  if (socket.writableLength + state.pendingFrameBytes > limit) {
    state.wantDrain = true;
    if (state.config.closeOnBackpressureLimit) terminateServerWebSocket(state);
    return -1;
  }
  const frame = encodeServerWebSocketFrame(opcode, payload, rsv1);
  state.pendingFrames.push(frame);
  state.pendingFrameBytes += frame.byteLength;
  if (!state.frameFlushScheduled) {
    state.frameFlushScheduled = true;
    queueMicrotask(() => flushServerWebSocketFrames(state));
  }
  if (socket.writableLength + state.pendingFrameBytes > limit) {
    state.wantDrain = true;
    if (state.config.closeOnBackpressureLimit) terminateServerWebSocket(state);
    return -1;
  }
  return originalLength;
}

function scheduleServerWebSocketDrain(state) {
  if (!state.wantDrain) return;
  state.wantDrain = false;
  queueMicrotask(() => {
    if (state.readyState === 1) invokeWebSocketHandler(state, "drain", state.ws);
  });
}

function convertWebSocketBinary(state, payload) {
  if (state.binaryType === "arraybuffer") {
    return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  }
  if (state.binaryType === "uint8array") {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}

function unsubscribeServerWebSocketAll(state) {
  for (const topic of state.topics) {
    const set = state.serverState.topics.get(topic);
    if (set) {
      set.delete(state);
      if (set.size === 0) state.serverState.topics.delete(topic);
    }
  }
  state.topics.clear();
}

function finalizeServerWebSocket(state, code, reason) {
  if (state.finalized) return;
  state.finalized = true;
  state.readyState = 3;
  if (state.closeTimer != null) clearTimeout(state.closeTimer);
  state.closeTimer = null;
  state.serverState.websockets.delete(state);
  nodeHttp.resetWebSocketMessageState(state.messageState);
  unsubscribeServerWebSocketAll(state);
  const server = state.serverState.server;
  if (server && server.pendingWebSockets > 0) server.pendingWebSockets -= 1;
  state.serverState.lifecycle?.notifyWebSocketsChanged();
  invokeWebSocketHandler(state, "close", state.ws, code, reason);
}

function beginServerWebSocketClose(state, code, reason, payload) {
  if (state.finalized || state.readyState !== 1) return;
  state.readyState = 3;
  state.pendingClose = { code, reason: String(reason ?? "") };
  const socket = state.socket;
  if (socket && !socket.destroyed && socket.writable) {
    flushServerWebSocketFrames(state);
    try {
      socket.end(encodeServerWebSocketFrame(0x8, payload), () => {
        // uWS/Bun invoke the close handler once the close echo is flushed,
        // not when the peer finishes the TCP close handshake.
        finalizeServerWebSocket(state, code, String(reason ?? ""));
      });
      state.closeTimer = setTimeout(() => terminateServerWebSocket(state), 30_000);
      state.closeTimer?.unref?.();
      return;
    } catch {}
  }
  finalizeServerWebSocket(state, code, String(reason ?? ""));
}

function closeServerWebSocket(state, code, reason) {
  if (state.readyState !== 1) return;
  const payload = nodeHttp.createWebSocketClosePayload(code, reason);
  beginServerWebSocketClose(state, code, reason, payload);
}

function failServerWebSocket(state, code, reason) {
  if (state.readyState !== 1) return;
  const payload = nodeHttp.createWebSocketClosePayload(code, reason, { truncateReason: true });
  beginServerWebSocketClose(state, code, reason, payload);
}

function terminateServerWebSocket(state) {
  if (state.readyState === 3 && state.finalized) return;
  state.readyState = 3;
  state.pendingClose = { code: 1006, reason: "" };
  state.pendingFrames = [];
  state.pendingFrameBytes = 0;
  try { state.socket?.destroy?.(); } catch {}
  queueMicrotask(() => {
    if (!state.finalized && state.socket?.destroyed) finalizeServerWebSocket(state, 1006, "");
  });
}

function publishToWebSocketTopic(serverState, topic, data, opcode, excludeState, compress = false) {
  const topicName = String(topic ?? "");
  if (topicName.length === 0) return 0;
  const subscribers = serverState.topics.get(topicName);
  if (!subscribers || subscribers.size === 0) return 0;
  const payload = websocketPayloadBytes(data);
  const resolvedOpcode = opcode ?? (typeof data === "string" ? 0x1 : 0x2);
  let delivered = false;
  for (const subscriber of Array.from(subscribers)) {
    if (subscriber === excludeState) continue;
    const result = sendServerWebSocketFrame(subscriber, resolvedOpcode, payload, compress);
    if (result !== 0) delivered = true;
  }
  if (!delivered) return 0;
  return payload.byteLength > 0 ? payload.byteLength : 1;
}

class ServerWebSocket {
  constructor(state) {
    this._state = state;
    this.data = state.data;
  }

  get readyState() {
    return this._state.readyState;
  }

  get remoteAddress() {
    if (this._state.readyState !== 1) return undefined;
    return this._state.remoteAddress ?? this._state.socket?.remoteAddress ?? "";
  }

  get binaryType() {
    return this._state.binaryType;
  }

  set binaryType(value) {
    if (value !== "nodebuffer" && value !== "arraybuffer" && value !== "uint8array") {
      throw new TypeError("binaryType must be 'nodebuffer', 'arraybuffer', or 'uint8array'");
    }
    this._state.binaryType = value;
  }

  get subscriptions() {
    return Array.from(this._state.topics);
  }

  getBufferedAmount() {
    const socket = this._state.socket;
    return socket && !socket.destroyed ? socket.writableLength + this._state.pendingFrameBytes : 0;
  }

  get [estimatedMemoryCostSymbol]() {
    const socket = this._state.socket;
    const buffered = socket && !socket.destroyed ? socket.writableLength : 0;
    return 256 + buffered + this._state.pendingFrameBytes + this._state.pendingFrames.length * 64;
  }

  send(data, compress = undefined) {
    assertWebSocketCompressFlag(compress, "send");
    return sendServerWebSocketFrame(this._state, typeof data === "string" ? 0x1 : 0x2, data, compress);
  }

  sendText(data, compress = undefined) {
    assertWebSocketCompressFlag(compress, "sendText");
    return sendServerWebSocketFrame(this._state, 0x1, String(data), compress);
  }

  sendBinary(data, compress = undefined) {
    assertWebSocketCompressFlag(compress, "sendBinary");
    return sendServerWebSocketFrame(this._state, 0x2, data, compress);
  }

  ping(data = undefined) {
    return sendServerWebSocketFrame(this._state, 0x9, data);
  }

  pong(data = undefined) {
    return sendServerWebSocketFrame(this._state, 0xA, data);
  }

  subscribe(topic) {
    const name = String(topic ?? "");
    if (name.length === 0) throw new TypeError("subscribe requires a non-empty topic name");
    if (this._state.readyState !== 1) return true;
    this._state.topics.add(name);
    let set = this._state.serverState.topics.get(name);
    if (!set) {
      set = new Set();
      this._state.serverState.topics.set(name, set);
    }
    set.add(this._state);
    return true;
  }

  unsubscribe(topic) {
    const name = String(topic ?? "");
    if (name.length === 0) throw new TypeError("unsubscribe requires a non-empty topic name");
    this._state.topics.delete(name);
    const set = this._state.serverState.topics.get(name);
    if (set) {
      set.delete(this._state);
      if (set.size === 0) this._state.serverState.topics.delete(name);
    }
    return true;
  }

  isSubscribed(topic) {
    return this._state.topics.has(String(topic ?? ""));
  }

  publish(topic, data, compress = undefined) {
    assertWebSocketCompressFlag(compress, "publish");
    const excludeSelf = !this._state.config.publishToSelf;
    return publishToWebSocketTopic(this._state.serverState, topic, data, undefined, excludeSelf ? this._state : null, compress === true);
  }

  publishText(topic, data, compress = undefined) {
    assertWebSocketCompressFlag(compress, "publishText");
    const excludeSelf = !this._state.config.publishToSelf;
    return publishToWebSocketTopic(this._state.serverState, topic, String(data), 0x1, excludeSelf ? this._state : null, compress === true);
  }

  publishBinary(topic, data, compress = undefined) {
    assertWebSocketCompressFlag(compress, "publishBinary");
    const excludeSelf = !this._state.config.publishToSelf;
    return publishToWebSocketTopic(this._state.serverState, topic, data, 0x2, excludeSelf ? this._state : null, compress === true);
  }

  cork(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("cork requires a function");
    }
    return callback(this);
  }

  close(code = 1000, reason = "") {
    closeServerWebSocket(this._state, Number(code) || 1000, String(reason ?? ""));
  }

  terminate() {
    terminateServerWebSocket(this._state);
  }

  ref() {}
  unref() {}
}

function attachServerWebSocket(serverState, socket, head, data, deflate = null) {
  const websocketOptions = serverState.getWebSocketOptions() ?? {};
  const state = {
    serverState,
    socket,
    data,
    deflate,
    readyState: 1,
    binaryType: "nodebuffer",
    topics: new Set(),
    buffer: Buffer.alloc(0),
    messageState: nodeHttp.createWebSocketMessageState(),
    wantDrain: false,
    pendingFrames: [],
    pendingFrameBytes: 0,
    frameFlushScheduled: false,
    finalized: false,
    opened: false,
    pendingClose: null,
    closeTimer: null,
    remoteAddress: socket.remoteAddress,
    config: {
      maxPayloadLength: Number(websocketOptions.maxPayloadLength ?? 16 * 1024 * 1024),
      backpressureLimit: Number(websocketOptions.backpressureLimit ?? 16 * 1024 * 1024),
      closeOnBackpressureLimit: Boolean(websocketOptions.closeOnBackpressureLimit),
      publishToSelf: Boolean(websocketOptions.publishToSelf),
    },
    getHandlers: () => serverState.getWebSocketOptions() ?? {},
  };
  const ws = new ServerWebSocket(state);
  state.ws = ws;
  serverState.websockets.add(state);
  serverState.server.pendingWebSockets += 1;
  serverState.lifecycle?.notifyWebSocketsChanged();

  const invokeOpen = () => {
    if (state.opened || state.finalized) return;
    state.opened = true;
    invokeWebSocketHandler(state, "open", ws);
  };

  const handleFrame = (frame) => {
    if (frame.opcode === 0x8) {
      let close;
      try {
        close = nodeHttp.parseWebSocketClosePayload(frame.payload, { emptyCode: 1000 });
      } catch (error) {
        failServerWebSocket(state, error?.closeCode ?? 1002, error?.message ?? "Invalid close frame");
        return;
      }
      beginServerWebSocketClose(state, close.code, close.reason, frame.payload);
      return;
    }
    if (frame.opcode === 0x9) {
      if (state.readyState === 1) {
        flushServerWebSocketFrames(state);
        try { socket.write(encodeServerWebSocketFrame(0xA, frame.payload)); } catch {}
      }
      invokeWebSocketHandler(state, "ping", ws, convertWebSocketBinary(state, frame.payload));
      return;
    }
    if (frame.opcode === 0xA) {
      invokeWebSocketHandler(state, "pong", ws, convertWebSocketBinary(state, frame.payload));
      return;
    }
    let message;
    try {
      message = nodeHttp.consumeWebSocketDataFrame(state.messageState, frame, {
        maxPayloadLength: state.config.maxPayloadLength,
      });
    } catch (error) {
      if (error?.closeCode === 1009) terminateServerWebSocket(state);
      else failServerWebSocket(state, error?.closeCode ?? 1002, error?.message ?? "Invalid WebSocket message");
      return;
    }
    if (message == null) return;
    let payload = message.payload;
    if (message.compressed) {
      try {
        payload = nodeHttp.websocketDeflateDecompress(payload, state.config.maxPayloadLength);
      } catch (error) {
        if (error?.code === "WS_MESSAGE_TOO_BIG") terminateServerWebSocket(state);
        else failServerWebSocket(state, 1007, "Invalid compressed data");
        return;
      }
    }
    let value;
    try {
      value = message.opcode === 0x1
        ? nodeHttp.decodeWebSocketText(payload)
        : convertWebSocketBinary(state, payload);
    } catch (error) {
      failServerWebSocket(state, error?.closeCode ?? 1007, error?.message ?? "Invalid UTF-8 in text frame");
      return;
    }
    invokeWebSocketHandler(state, "message", ws, value);
  };

  const handleData = (chunk) => {
    if (state.finalized || state.readyState !== 1) return;
    invokeOpen();
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    state.buffer = state.buffer.byteLength === 0 ? incoming : Buffer.concat([state.buffer, incoming]);
    let parsed;
    try {
      parsed = nodeHttp.parseWebSocketFrames(state.buffer, {
        allowCompression: state.deflate != null,
        expectMasked: true,
        maxFramePayloadLength: state.config.maxPayloadLength,
      });
    } catch (error) {
      if (error?.closeCode === 1009) terminateServerWebSocket(state);
      else failServerWebSocket(state, error?.closeCode ?? 1002, error?.message ?? "Invalid WebSocket frame");
      return;
    }
    state.buffer = parsed.remaining;
    for (const frame of parsed.frames) {
      if (state.finalized || state.readyState !== 1) return;
      handleFrame(frame);
      if (state.readyState !== 1) return;
    }
  };

  socket.on("data", handleData);
  socket.on("error", () => {});
  socket.on("close", () => {
    if (!state.finalized) {
      const close = state.pendingClose;
      finalizeServerWebSocket(state, close?.code ?? 1006, close?.reason ?? "");
    }
  });
  socket.on("drain", () => scheduleServerWebSocketDrain(state));

  queueMicrotask(() => {
    invokeOpen();
    if (head != null && head.byteLength > 0) handleData(head);
  });
  return ws;
}

function encodeMaskedWebSocketFrame(opcode, data) {
  const payload = websocketPayloadBytes(data);
  const length = payload.byteLength;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | (opcode & 0x0f), 0x80 | length]);
  } else if (length <= 0xffff) {
    header = Buffer.from([0x80 | (opcode & 0x0f), 0x80 | 126, (length >> 8) & 0xff, length & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 127;
    let big = BigInt(length);
    for (let index = 9; index >= 2; index -= 1) {
      header[index] = Number(big & 0xffn);
      big >>= 8n;
    }
  }
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.byteLength; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

// Bun extends the standard WebSocket client with terminate()/ping()/pong(),
// a "nodebuffer" binaryType (the default), ping/pong events, and Blob
// payload support. The base client lives in node/http.js; add the Bun
// surface here.
function patchWebSocketClientForBun() {
  const WS = globalThis.WebSocket;
  const proto = WS?.prototype;
  if (!proto || typeof proto.terminate === "function" || typeof proto._handleFrame !== "function") return;

  const convertClientBinary = (ws, payload) => {
    const binaryType = ws.binaryType;
    if (binaryType === "arraybuffer") {
      return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    }
    if (binaryType === "uint8array") {
      return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    }
    if (binaryType === "blob") {
      return new Blob([payload]);
    }
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  };

  Object.defineProperty(proto, "binaryType", {
    configurable: true,
    get() {
      return this._bunBinaryType ?? "nodebuffer";
    },
    set(value) {
      if (value !== "nodebuffer" && value !== "arraybuffer" && value !== "blob" && value !== "uint8array") {
        throw new TypeError("binaryType must be 'nodebuffer', 'blob', 'arraybuffer', or 'uint8array'");
      }
      // The base constructor assigns "blob" once; Bun's default is
      // "nodebuffer", so ignore that initial assignment.
      if (this._bunBinaryType === undefined && value === "blob" && !this._bunBinaryTypeTouched) {
        this._bunBinaryTypeTouched = true;
        return;
      }
      this._bunBinaryTypeTouched = true;
      this._bunBinaryType = value;
    },
  });

  proto.terminate = function terminate() {
    try { this._socket?.destroy?.(); } catch {}
    this._close?.(1006, "", false);
  };

  const sendControlFrame = (ws, opcode, data) => {
    if (ws.readyState !== 1) return;
    const write = (payload) => {
      let bytes = websocketPayloadBytes(payload);
      if (bytes.byteLength > 125) bytes = bytes.subarray(0, 125);
      try { ws._socket?.write?.(encodeMaskedWebSocketFrame(opcode, bytes)); } catch {}
    };
    if (data != null && typeof data === "object" && typeof data.arrayBuffer === "function") {
      data.arrayBuffer().then((buffer) => write(new Uint8Array(buffer)), () => {});
      return;
    }
    write(data);
  };

  proto.ping = function ping(data = undefined) {
    sendControlFrame(this, 0x9, data);
  };
  proto.pong = function pong(data = undefined) {
    sendControlFrame(this, 0xA, data);
  };

  const originalSend = proto.send;
  proto.send = function send(data, ...args) {
    if (data != null && typeof data === "object" && typeof data.arrayBuffer === "function" &&
        !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      // Blob-like payloads are read asynchronously and sent as binary frames.
      data.arrayBuffer().then(
        (buffer) => {
          try { Reflect.apply(originalSend, this, [new Uint8Array(buffer), ...args]); } catch {}
        },
        () => {},
      );
      return;
    }
    return Reflect.apply(originalSend, this, [data, ...args]);
  };

  const originalHandleFrame = proto._handleFrame;
  proto._handleFrame = function (frame) {
    const validControl = frame.fin && frame.payload.byteLength <= 125 && !frame.rsv1 && !frame.rsv2 && !frame.rsv3;
    // The base implementation performs reassembly, permessage-deflate
    // inflation, control-frame validation, and the pong reply for pings.
    const result = originalHandleFrame.call(this, frame);
    if (frame.opcode === 0x9 && validControl) {
      this.dispatchEvent?.({ type: "ping", data: convertClientBinary(this, frame.payload), target: this });
    } else if (frame.opcode === 0xA && validControl) {
      this.dispatchEvent?.({ type: "pong", data: convertClientBinary(this, frame.payload), target: this });
    }
    return result;
  };

  // Deliver messages per Bun's binaryType semantics (the base implementation
  // only understands "arraybuffer" vs Buffer).
  proto._deliverMessage = function (opcode, payload) {
    const MessageEventClass = globalThis.MessageEvent ?? nodeHttp.MessageEvent;
    const data = opcode === 0x1 ? nodeHttp.decodeWebSocketText(payload) : convertClientBinary(this, payload);
    this.dispatchEvent(new MessageEventClass("message", {
      data,
      origin: this.url,
      source: this,
    }));
  };
}

function installWebSocketMemoryAccounting() {
  const proto = globalThis.WebSocket?.prototype;
  if (!proto || typeof proto.send !== "function" ||
      Object.getOwnPropertyDescriptor(proto, estimatedMemoryCostSymbol)) return;
  const send = proto.send;
  proto.send = function sendWithMemoryAccounting(data, ...args) {
    this[webSocketSentBytesSymbol] = (this[webSocketSentBytesSymbol] ?? 0) + externallyOwnedBodyBytes(data) + 64;
    return Reflect.apply(send, this, [data, ...args]);
  };
  Object.defineProperty(proto, estimatedMemoryCostSymbol, {
    configurable: true,
    get() {
      return 256 + (this[webSocketSentBytesSymbol] ?? 0) + Math.max(0, Number(this.bufferedAmount) || 0);
    },
  });
}

function serveTlsMaterialText(value, name) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const parts = value.map((item) => serveTlsMaterialText(item, name)).filter((item) => item != null);
    return parts.length === 0 ? null : parts.join("\n");
  }
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(asBuffer(value));
  }
  if (isBunFileLike(value) && typeof value._bunFilePath === "string") {
    return String(cottontail.readFile(value._bunFilePath));
  }
  throw new TypeError(`Expected ${name} to be a string, Buffer, TypedArray, or BunFile`);
}

function assertValidServePem(text, name) {
  const value = String(text ?? "");
  if (!value.includes("-----BEGIN ")) {
    // BoringSSL reports PEM material without a BEGIN line as NO_START_LINE;
    // Bun surfaces that reason string directly.
    throw new TypeError(
      `Invalid ${name} in Bun.serve() TLS options: BoringSSL error:0900006e:PEM routines:OPENSSL_internal:NO_START_LINE`,
    );
  }
  const pattern = /-----BEGIN [A-Z0-9 ]+-----[A-Za-z0-9+/=\r\n]+-----END [A-Z0-9 ]+-----/;
  if (!pattern.test(value)) {
    throw new TypeError(`Invalid ${name} in Bun.serve() TLS options`);
  }
}

function validateServeTls(tls) {
  if (tls == null || tls === false) return null;
  if (typeof tls !== "object") throw new TypeError("TLSOptions must be an object");
  const isArray = Array.isArray(tls);
  const list = isArray ? tls : [tls];
  if (list.length === 0) return null;
  if (isArray) {
    for (let index = 1; index < list.length; index += 1) {
      const entry = list[index];
      if (entry == null || typeof entry !== "object") throw new TypeError("TLSOptions must be an object");
      if (typeof entry.serverName !== "string" || entry.serverName.length === 0) {
        throw new TypeError("SNI tls object must have a serverName");
      }
    }
  }
  const configs = [];
  for (const entry of list) {
    if (entry == null || typeof entry !== "object") {
      throw new TypeError("TLSOptions must be an object");
    }
    for (const name of ["requestCert", "rejectUnauthorized", "lowMemoryMode"]) {
      if (entry[name] != null && typeof entry[name] !== "boolean") {
        throw new TypeError(`TLSOptions.${name} must be a boolean`);
      }
    }
    const key = serveTlsMaterialText(entry.key, "key");
    const cert = serveTlsMaterialText(entry.cert, "cert");
    if (key != null) assertValidServePem(key, "key");
    if (cert != null) assertValidServePem(cert, "cert");
    configs.push({
      key,
      cert,
      ca: entry.ca == null ? null : serveTlsMaterialText(entry.ca, "ca"),
      serverName: entry.serverName,
      passphrase: entry.passphrase,
      requestCert: entry.requestCert === true,
      rejectUnauthorized: entry.rejectUnauthorized !== false,
      lowMemoryMode: entry.lowMemoryMode === true,
      ciphers: entry.ciphers,
    });
  }
  if (!configs.some((config) => config.key != null || config.cert != null)) return null;
  return configs;
}

function serveUnixUrlText(unixPath) {
  if (unixPath.startsWith("\0")) return `abstract://${unixPath.slice(1)}/`;
  if (process.platform === "win32") return `unix://${unixPath.replaceAll("\\", "/")}`;
  let resolved = unixPath;
  try { resolved = nodePathResolve(unixPath); } catch {}
  return `unix://${resolved.startsWith("/") ? "" : "/"}${resolved}`;
}

function validateServeUnixPathTarget(unixPath) {
  if (!unixPath || unixPath.startsWith("\0")) return;
  if (process.platform === "win32") {
    const limit = isWindowsNamedPipePath(unixPath) ? 256 : 260;
    if (unixPath.length >= limit) {
      const error = new Error(`ENAMETOOLONG: File name too long, listen '${unixPath}'`);
      error.code = "ENAMETOOLONG";
      throw error;
    }
    if (!isWindowsNamedPipePath(unixPath)) {
      let directory = "";
      try { directory = nodePathDirname(nodePathResolve(unixPath)); } catch {}
      if (directory && !cottontail.existsSync(directory)) {
        const error = new Error(`ENOENT: no such file or directory, listen '${unixPath}'`);
        error.code = "ENOENT";
        throw error;
      }
    }
    return;
  }
  const limit = process.platform === "linux" ? 108 : 104;
  if (Buffer.byteLength(unixPath) >= limit) {
    const error = new Error(`ENAMETOOLONG: File name too long, listen '${unixPath}'`);
    error.code = "ENAMETOOLONG";
    throw error;
  }
  const slash = unixPath.lastIndexOf("/");
  if (slash > 0) {
    const dir = unixPath.slice(0, slash);
    if (!cottontail.existsSync(dir)) {
      const error = new Error(`ENOENT: no such file or directory, listen '${unixPath}'`);
      error.code = "ENOENT";
      throw error;
    }
  }
}

function requestFromNodeIncoming(message, protocol, fallbackHost, tunnelRequest = false) {
  const headers = new Headers();
  const raw = message.rawHeaders ?? [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    headers.append(raw[index], raw[index + 1]);
  }
  if (tunnelRequest) {
    // Bun exposes connection/upgrade header values lowercased for upgrade requests.
    for (const name of ["connection", "upgrade"]) {
      const value = headers.get(name);
      if (value != null) headers.set(name, value.toLowerCase());
    }
  }
  const host = message.headers?.host ?? fallbackHost;
  const controller = new CottontailAbortController();
  const init = {
    method: message.method,
    headers,
    signal: controller.signal,
  };
  const method = String(message.method ?? "GET").toUpperCase();
  const request = requestWithLazyURL(
    incomingRequestURLFactory(protocol, host, message.url, `${protocol}//${fallbackHost}`, normalizeRequestUrl),
    init,
  );
  if (method !== "GET" && method !== "HEAD") {
    const body = message._incomingBody;
    if (message.complete && body != null && body.byteLength > 0) {
      request._body = asBuffer(body);
    } else {
      const contentLength = Number(message.headers?.["content-length"] ?? 0);
      const hasStreamingBody = message.headers?.["transfer-encoding"] != null || contentLength > 0;
      if (hasStreamingBody) request._body = trackServeReadableStream(loadNodeStreamModule().Readable.toWeb(message));
    }
  }
  return { request, controller };
}

const bunTlsServerEventIdBase = 0x80000000;

function installBunTlsServerEvent(serverId, callback) {
  const listeners = globalThis.__cottontailFdWatchListeners ??= new Map();
  if (!globalThis.__cottontailFdWatchHandlerInstalled && typeof cottontail.fdSetEventHandler === "function") {
    globalThis.__cottontailFdWatchHandlerInstalled = true;
    cottontail.fdSetEventHandler((event) => {
      const id = Number(event?.id);
      const connectListener = globalThis.__cottontailTcpConnectListeners?.get?.(id);
      if (typeof connectListener === "function") {
        connectListener(event);
        return;
      }
      const fdListener = globalThis.__cottontailFdWatchListeners?.get?.(id);
      if (typeof fdListener === "function") {
        fdListener(event);
        return;
      }
      const tlsListener = globalThis.__cottontailTlsListeners?.get?.(id);
      if (typeof tlsListener === "function") tlsListener(event);
    });
  }
  const eventId = (bunTlsServerEventIdBase | (Number(serverId) & 0x7fffffff)) >>> 0;
  listeners.set(eventId, (event) => {
    if (event?.type === "tlsAccept") callback();
  });
  return eventId;
}

function normalizeServeListenErrorCode(error, reason = error?.message) {
  if (error?.code != null) return error;
  const text = String(reason ?? "");
  if (/(?:EADDRNOTAVAIL|cannot assign requested address|requested address is not valid)/i.test(text)) {
    error.code = "EADDRNOTAVAIL";
  } else if (/(?:EADDRINUSE|address (?:already )?in use|only one usage of each socket address)/i.test(text)) {
    error.code = "EADDRINUSE";
  }
  return error;
}

function serveNodeBacked(options, context) {
  const { hostname, unixPath, tlsConfigs, inspectorReload } = context;
  const isUnix = unixPath.length > 0;
  const unixTransportPath = isUnix ? windowsUnixTransportPath(unixPath) : "";
  const useTls = tlsConfigs != null;
  const protocol = useTls ? "https:" : "http:";
  let activeOptions = options;
  let publicUrl = null;

  let nodeServer;
  let tlsAcceptEventId = 0;
  let boundHostname = hostname;
  let boundPort = 0;
  if (useTls) {
    if (isUnix) throw new TypeError("Bun.serve does not support tls with unix sockets yet");
    const primary = tlsConfigs[0];
    nodeServer = new nodeHttps.Server({});
    const listenHost = hostname === "localhost" ? "127.0.0.1" : hostname;
    let native;
    try {
      native = cottontail.tlsServerListen(
        defaultServePort(options),
        listenHost,
        String(primary.cert ?? ""),
        String(primary.key ?? ""),
        primary.passphrase,
        undefined,
        primary.ca,
        primary.requestCert,
        primary.rejectUnauthorized,
        primary.ciphers,
      );
      for (let index = 1; index < tlsConfigs.length; index += 1) {
        const config = tlsConfigs[index];
        cottontail.tlsServerAddContext(
          native.id,
          config.serverName,
          String(config.cert ?? ""),
          String(config.key ?? ""),
          config.ca,
          config.passphrase,
          config.requestCert,
          config.rejectUnauthorized,
          config.ciphers,
        );
      }
    } catch (rawError) {
      if (native != null) {
        try { cottontail.tlsServerClose(native.id); } catch {}
      }
      const error = rawError instanceof Error ? rawError : new Error(String(rawError));
      throw normalizeServeListenErrorCode(error);
    }
    // node/tls.js Server.listen() binds asynchronously, but Bun.serve must
    // expose the bound port synchronously; graft the native listener onto the
    // https server the same way tls.Server.listen() does.
    nodeServer._tlsServerId = Number(native.id);
    nodeServer._tlsAddress = native.address ?? null;
    nodeServer.listening = true;
    tlsAcceptEventId = installBunTlsServerEvent(native.id, () => nodeServer._acceptTls());
    nodeServer._tlsAcceptTimer = setInterval(() => nodeServer._acceptTls(), 1000);
    boundPort = Number(native.address?.port ?? 0);
  } else {
    nodeServer = new nodeHttp.Server();
    nodeServer.on("error", () => {});
    const listenHost = hostname === "localhost" ? "127.0.0.1" : hostname;
    const preboundKey = Symbol.for("cottontail.preboundHttpServer");
    const prebound = globalThis[preboundKey];
    const requestedPort = defaultServePort(options);
    const preboundFd = Number(prebound?.fd);
    const canAdoptPrebound =
      Number.isInteger(preboundFd) &&
      preboundFd >= 0 &&
      !isUnix &&
      listenHost === "127.0.0.1" &&
      Number(prebound.requestedPort) === requestedPort;
    try {
      if (canAdoptPrebound) {
        nodeServer.listen({ fd: preboundFd });
        delete globalThis[preboundKey];
      } else {
        if (Number.isInteger(preboundFd) && preboundFd >= 0) {
          try { cottontail.closeFd(preboundFd); } catch {}
        }
        if (prebound?.native != null) {
          try { cottontail.httpServerStop(prebound.native.id, true); } catch {}
        }
        if (prebound != null) delete globalThis[preboundKey];
        nodeServer.listen(isUnix
          ? { path: unixTransportPath }
          : { host: listenHost, port: requestedPort, family: listenHost.includes(":") ? 6 : 4 });
      }
    } catch (rawError) {
      const reason = rawError instanceof Error ? rawError.message : String(rawError);
      const error = rawError instanceof Error
        ? rawError
        : new Error(
            isUnix
              ? `Failed to listen on unix socket ${unixPath}: ${reason}`
              : `Failed to start server. ${reason}`,
          );
      throw normalizeServeListenErrorCode(error, reason);
    }
    if (!nodeServer._native?.listening) {
      const error = new Error(
        isUnix
          ? `Failed to listen on unix socket ${unixPath}`
          : `Failed to start server. Is port ${requestedPort} in use?`,
      );
      error.code = "EADDRINUSE";
      throw error;
    }
    if (!isUnix) boundPort = Number(nodeServer.address()?.port ?? 0);
  }

  const displayHostname = boundHostname.includes(":") ? `[${boundHostname}]` : boundHostname;
  const fallbackHost = isUnix ? "localhost" : `${displayHostname}:${boundPort}`;
  const requestOrigin = isUnix ? `${protocol}//localhost` : `${protocol}//${displayHostname}:${boundPort}`;
  const listenerAddress = isUnix
    ? unixPath
    : (useTls ? nodeServer._tlsAddress : nodeServer.address()) ?? {
        address: boundHostname,
        family: boundHostname.includes(":") ? "IPv6" : "IPv4",
        port: boundPort,
      };
  const originKeys = isUnix ? [] : [
    requestOrigin,
    ...(boundHostname === "0.0.0.0" || boundHostname === "::"
      ? [`${protocol}//127.0.0.1:${boundPort}`, `${protocol}//localhost:${boundPort}`]
      : []),
    ...(boundHostname === "localhost" ? [`${protocol}//127.0.0.1:${boundPort}`] : []),
  ];

  const serverState = {
    topics: new Map(),
    websockets: new Set(),
    getWebSocketOptions: () => (activeOptions.websocket && typeof activeOptions.websocket === "object" ? activeOptions.websocket : null),
    lifecycle: null,
    server: null,
  };

  let server;
  const lifecycle = createServeLifecycle(() => Number(server?.pendingWebSockets ?? 0));
  server = {
    id: options.id ?? `bun-serve-${boundPort || unixPath}`,
    hostname: isUnix ? undefined : boundHostname,
    port: isUnix ? undefined : boundPort,
    address: listenerAddress,
    development: options.development ?? false,
    get pendingRequests() {
      return lifecycle.pendingRequests;
    },
    pendingWebSockets: 0,
    protocol: useTls ? "https" : "http",
    get url() {
      publicUrl ??= new globalThis.URL(isUnix ? serveUnixUrlText(unixPath) : `${requestOrigin}/`);
      return publicUrl;
    },
    stop(force = false) {
      return lifecycle.stop(force);
    },
    [Symbol.dispose]() {
      server.stop(true);
    },
    [Symbol.asyncDispose]() {
      return server.stop(true);
    },
    reload(nextOptions = {}) {
      registerServeHtmlOptions(activeOptions[serveHtmlStateSymbol], nextOptions);
      activeOptions = { ...activeOptions, ...nextOptions };
      server.development = activeOptions.development ?? false;
      return server;
    },
    async fetch(input, init = {}) {
      if (typeof activeOptions.fetch !== "function") {
        throw new Error("fetch() requires the server to have a fetch handler");
      }
      return dispatchServeFetch(activeOptions, server, input, init);
    },
    ref() {
      nodeServer.ref?.();
      return server;
    },
    unref() {
      nodeServer.unref?.();
      return server;
    },
    requestIP(request) {
      const peer = serveRequestPeers.get(request);
      if (peer) return { ...peer };
      const socket = serveRequestSockets.get(request);
      if (!socket || socket.destroyed) return null;
      const address = socket.remoteAddress;
      if (!address) return null;
      return {
        address,
        port: Number(socket.remotePort ?? 0),
        family: String(address).includes(":") ? "IPv6" : "IPv4",
      };
    },
    closeIdleConnections() {
      for (const socket of Array.from(nodeServer._connections ?? [])) {
        if (socket._httpMessage == null && socket._cottontailBunServeUpgradeActive !== true) {
          socket.destroy?.();
        }
      }
    },
    timeout(request, seconds) {
      return setServeRequestIdleTimeout(request, seconds, isUnix, arguments.length);
    },
    upgrade(request, upgradeOptions = {}) {
      if (!(request instanceof Request)) {
        throw new TypeError("upgrade requires a Request object");
      }
      const ctx = serveUpgradeContexts.get(request);
      if (!ctx || ctx.used || ctx.socket.destroyed) return false;
      const key = request.headers.get("sec-websocket-key");
      const upgradeName = String(request.headers.get("upgrade") ?? "").toLowerCase();
      if (!key || upgradeName !== "websocket") return false;
      const websocketOptions = serverState.getWebSocketOptions();
      if (websocketOptions == null) return false;
      ctx.used = true;
      const lines = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${websocketAcceptKeyForServe(key)}`,
      ];
      const extraHeaders = upgradeOptions?.headers;
      const seen = new Set();
      for (const cookie of request._cookies?.toSetCookieHeaders?.() ?? []) {
        lines.push(`Set-Cookie: ${cookie}`);
      }
      if (extraHeaders != null) {
        const entries = typeof extraHeaders.entries === "function"
          ? extraHeaders.entries()
          : Object.entries(extraHeaders);
        for (const [name, value] of entries) {
          seen.add(String(name).toLowerCase());
          const values = Array.isArray(value) ? value : [value];
          for (const entry of values) lines.push(`${name}: ${entry}`);
        }
      }
      if (!seen.has("sec-websocket-protocol")) {
        const requestedProtocol = request.headers.get("sec-websocket-protocol");
        if (requestedProtocol) lines.push(`Sec-WebSocket-Protocol: ${requestedProtocol.split(",")[0].trim()}`);
      }
      // RFC 7692: negotiate permessage-deflate when enabled on the server
      // and offered by the client. Compression state is stateless per
      // message, so both no-context-takeover parameters are selected.
      let deflate = null;
      const offeredExtensions = nodeHttp.parseWebSocketExtensions(request.headers.get("sec-websocket-extensions") ?? "");
      const clientOffer = offeredExtensions.find((extension) => extension.name === "permessage-deflate");
      if (websocketOptions.perMessageDeflate && clientOffer != null) {
        if (seen.has("sec-websocket-extensions")) {
          // The caller supplied an explicit extensions response header; honor
          // it and enable compression if it accepts permessage-deflate.
          const explicit = [];
          if (extraHeaders != null) {
            const entries = typeof extraHeaders.entries === "function"
              ? extraHeaders.entries()
              : Object.entries(extraHeaders);
            for (const [name, value] of entries) {
              if (String(name).toLowerCase() === "sec-websocket-extensions") explicit.push(String(value));
            }
          }
          const accepted = nodeHttp.parseWebSocketExtensions(explicit.join(", "))
            .find((extension) => extension.name === "permessage-deflate");
          if (accepted != null) deflate = { serverWindowBits: 15 };
        } else {
          const params = ["permessage-deflate", "client_no_context_takeover", "server_no_context_takeover"];
          let serverWindowBits = 15;
          const requestedServerBits = clientOffer.params["server_max_window_bits"];
          if (requestedServerBits != null && requestedServerBits !== true) {
            const bits = Number(requestedServerBits);
            if (Number.isInteger(bits) && bits >= 8 && bits <= 15) {
              serverWindowBits = bits;
              params.push(`server_max_window_bits=${bits}`);
            }
          }
          lines.push(`Sec-WebSocket-Extensions: ${params.join("; ")}`);
          deflate = { serverWindowBits };
        }
      }
      lines.push("", "");
      try {
        ctx.socket.write(lines.join("\r\n"));
      } catch {
        return false;
      }
      attachServerWebSocket(serverState, ctx.socket, ctx.head, upgradeOptions?.data, deflate);
      return true;
    },
    publish(topic, data, compress = undefined) {
      assertWebSocketCompressFlag(compress, "publish");
      return publishToWebSocketTopic(serverState, topic, data, undefined, null, compress ?? true);
    },
    subscriberCount(topic) {
      const set = serverState.topics.get(String(topic ?? ""));
      return set ? set.size : 0;
    },
  };
  serverState.server = server;
  serverState.lifecycle = lifecycle;
  activeServeDispatches.set(server, (input, init) => dispatchServeFetch(activeOptions, server, input, init));
  activeServeLifecycles.set(server, lifecycle);

  for (const origin of originKeys) activeServeOrigins.set(origin, server);

  const writeNodeResponse = (nodeResponse, response, request) => {
    response = serveResponseWithIdleTimeout(response, requestIdleTimeout(request, activeOptions.idleTimeout));
    const method = String(request.method ?? "GET").toUpperCase();
    nodeResponse._omitImplicitConnectionHeader = true;
    nodeResponse.setHeader("X-Cottontail-Omit-Implicit-Connection", "1");
    nodeResponse.statusCode = response.status;
    if (response.statusText) nodeResponse.statusMessage = response.statusText;
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    response.headers.forEach((value, name) => {
      const lowerName = String(name).toLowerCase();
      if (lowerName === "set-cookie") return;
      const outputName = lowerName === "content-length"
        ? "Content-Length"
        : lowerName === "content-type"
          ? "Content-Type"
          : name;
      try { nodeResponse.setHeader(outputName, value); } catch {}
    });
    if (setCookies.length > 0) {
      try { nodeResponse.setHeader("Set-Cookie", setCookies); } catch {}
    }
    const body = response._takeBody();
    if (method !== "HEAD" && statusAllowsBody(response.status) && isStreamingBody(body)) {
      nodeResponse.removeHeader("content-length");
      nodeResponse.writeHead(nodeResponse.statusCode);
      return consumeStreamingBody(body, (chunk) => {
        if (nodeResponse.socket == null || nodeResponse.socket.destroyed) {
          const error = new Error("Socket closed");
          error.code = "ECONNRESET";
          throw error;
        }
        nodeResponse.write(asBuffer(chunk));
      }).then(
        () => { nodeResponse.end(); },
        () => {
          try { nodeResponse.socket?.destroy?.(); } catch {}
          try { nodeResponse.destroy(); } catch {}
        },
      );
    }
    const finishWithBytes = (bytes) => {
      if (method === "HEAD" || !statusAllowsBody(response.status)) {
        nodeResponse.end();
        return;
      }
      nodeResponse.end(Buffer.from(bytes));
    };
    if (body == null || typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      finishWithBytes(bytesFromData(body));
      return undefined;
    }
    return Promise.resolve(bytesFromBody(body)).then(finishWithBytes, () => {
      try { nodeResponse.socket?.destroy?.(); } catch {}
    });
  };

  nodeServer.on("request", (message, nodeResponse) => {
    const { request, controller } = requestFromNodeIncoming(message, protocol, fallbackHost);
    const lifecycleRequest = lifecycle.beginRequest(() => {
      try { controller.abort(); } catch {}
      try { message.socket?.destroy?.(); } catch {}
    });
    const finalize = () => {
      lifecycle.finishRequest(lifecycleRequest);
    };
    const prepareResponse = (response) => {
      const requestBody = request._body;
      // COTTONTAIL-COMPAT: Bun.serve drains an unread upload after the handler
      // returns so request backpressure cannot stall or reset the response.
      if (!message.complete && response?._body !== requestBody && requestBody?.locked !== true) {
        return new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            message.off?.("end", finish);
            message.off?.("aborted", finish);
            message.off?.("close", finish);
            message.off?.("error", finish);
            resolve(response);
          };
          message.once?.("end", finish);
          message.once?.("aborted", finish);
          message.once?.("close", finish);
          message.once?.("error", finish);
          message._dump?.();
          message.socket?.resume?.();
          if (message.complete || message.aborted) finish();
        });
      }
      return response;
    };
    const socket = message.socket;
    if (socket) {
      serveRequestSockets.set(request, socket);
      const onSocketClose = () => {
        if (!nodeResponse.writableEnded) {
          try { controller.abort(); } catch {}
        }
        finalize();
      };
      socket.once("close", onSocketClose);
      nodeResponse.once("finish", () => socket.off?.("close", onSocketClose));
    }
    let handled;
    try {
      handled = runServeHandler(activeOptions, request, server);
    } catch (error) {
      handled = serveErrorResponse(activeOptions, error);
    }
    Promise.resolve(handled)
      .then(
        (response) => Promise.resolve(prepareResponse(response))
          .then((prepared) => writeNodeResponse(nodeResponse, prepared, request)),
        (error) => Promise.resolve(serveErrorResponse(activeOptions, error))
          .then(prepareResponse)
          .then((response) => writeNodeResponse(nodeResponse, response, request)),
      )
      .then(finalize, (error) => {
        finalize();
        reportServeHandlerError(error);
      });
  });

  nodeServer.on("upgrade", (message, socket, head) => {
    // Bun.stop() closes the listener without cutting off an upgrade request
    // whose fetch handler still needs to write its response.
    socket._cottontailBunServeUpgradeActive = true;
    const { request } = requestFromNodeIncoming(message, protocol, fallbackHost, true);
    const lifecycleRequest = lifecycle.beginRequest(() => {
      try { socket.destroy?.(); } catch {}
    });
    const finalize = () => lifecycle.finishRequest(lifecycleRequest);
    serveUpgradeContexts.set(request, { socket, head, used: false });
    serveRequestSockets.set(request, socket);
    socket.on("error", () => {});
    socket.once("close", finalize);
    let result;
    try {
      result = runServeHandler(activeOptions, request, server);
    } catch (error) {
      reportServeHandlerError(error);
      socket.destroy?.();
      finalize();
      return;
    }
    Promise.resolve(result).then(
      (value) => {
        const ctx = serveUpgradeContexts.get(request);
        if (ctx?.used) return;
        if (value == null) {
          socket.destroy?.();
          return;
        }
        return Promise.resolve(prepareServeResponseResult(value, request)).then((response) => {
          const bodyBytes = Promise.resolve(bytesFromBody(response._body));
          return bodyBytes.then((bytes) => {
            const lines = [`HTTP/1.1 ${response.status} ${response.statusText || nodeHttp.STATUS_CODES[response.status] || ""}`];
            response.headers.forEach((value2, name) => {
              if (String(name).toLowerCase() === "content-length") return;
              lines.push(`${name}: ${value2}`);
            });
            lines.push(`Content-Length: ${bytes.byteLength}`, "Connection: close", "", "");
            try {
              socket.write(Buffer.concat([Buffer.from(lines.join("\r\n")), Buffer.from(bytes)]));
              socket.end();
            } catch {}
          });
        });
      },
      (error) => {
        reportServeHandlerError(error);
        socket.destroy?.();
      },
    ).then(finalize, finalize);
  });

  let nodeTransportClosing = false;
  let unregisterWindowsUnixSocketAlias = () => {};
  const stopNodeTransport = (force) => {
    unregisterWindowsUnixSocketAlias();
    unregisterWindowsUnixSocketAlias = () => {};
    for (const origin of originKeys) activeServeOrigins.delete(origin);
    if (force) {
      abortActiveServeRequests(server);
      for (const state of Array.from(serverState.websockets)) {
        terminateServerWebSocket(state);
        serverState.websockets.delete(state);
      }
    }
    if (tlsAcceptEventId !== 0) {
      globalThis.__cottontailFdWatchListeners?.delete?.(tlsAcceptEventId);
      tlsAcceptEventId = 0;
    }
    if (!nodeTransportClosing) {
      nodeTransportClosing = true;
      // https.Server.close() only recognizes an HTTP message as active. Keep
      // upgraded Bun sockets out of its idle-connection sweep while stopping.
      for (const socket of Array.from(nodeServer._connections ?? [])) {
        if (socket._cottontailBunServeUpgradeActive === true && socket._httpMessage == null) {
          socket._httpMessage = serverState;
        }
      }
      nodeServer.once("close", () => lifecycle.markTransportDrained());
      nodeServer.close();
    }
    if (force) nodeServer.closeAllConnections?.();
  };
  lifecycle.configure(stopNodeTransport, () => stopNodeTransport(true));
  if (isUnix) {
    unregisterWindowsUnixSocketAlias = registerWindowsUnixSocketAlias(unixPath, unixTransportPath);
  }

  return finalizeServeInspector(server, activeOptions, inspectorReload);
}

export function serve(options) {
  if (options === undefined || options === null || typeof options !== "object") {
    throw new TypeError("Bun.serve expects an object");
  }
  const inspectorReload = serveInspectorRuntime.pendingReloads.shift() ?? null;
  if (inspectorReload?.port != null && Number(options.port ?? 0) === 0) {
    options = { ...options, port: inspectorReload.port };
  }
  const wrappedWebSocket = options.websocket && typeof options.websocket === "object"
    ? { ...options.websocket }
    : options.websocket;
  if (wrappedWebSocket && typeof wrappedWebSocket === "object") {
    for (const name of ["open", "message", "close", "drain", "error", "ping", "pong"]) {
      if (typeof wrappedWebSocket[name] === "function") {
        wrappedWebSocket[name] = _wrapAsyncCallback(wrappedWebSocket[name]);
      }
    }
  }
  options = {
    ...options,
    ...(typeof options.fetch === "function" ? { fetch: _wrapAsyncCallback(options.fetch) } : {}),
    ...(typeof options.error === "function" ? { error: _wrapAsyncCallback(options.error) } : {}),
    ...(wrappedWebSocket !== undefined ? { websocket: wrappedWebSocket } : {}),
  };
  globalThis.__cottontailServeEverCalled = true;
  const hasRoutes = validateServeRoutes(options.routes);
  const hasStaticRoutes = options.static != null && typeof options.static === "object" && Object.keys(options.static).length > 0;
  if (typeof options.fetch !== "function" && !hasRoutes && !hasStaticRoutes) {
    throw new TypeError(bunServeNeedsHandlerMessage());
  }
  options[serveHtmlStateSymbol] ??= createServeHtmlState(options);
  options = installInspectorDevServer(options);

  const unixPath = normalizeServeUnixPath(options.unix);
  const suppliedHostname = options.hostname === null || options.hostname === undefined
    ? ""
    : coerceServeOptionString(options.hostname, "hostname");
  if (unixPath && suppliedHostname) {
    throw new TypeError("Bun.serve cannot use hostname with unix");
  }
  const hostname = normalizeServeHostname(options.hostname);
  if (unixPath) validateServeUnixPathTarget(unixPath);

  const websocketHandlers = options.websocket ?? null;
  if (websocketHandlers != null && typeof websocketHandlers !== "object") {
    throw new TypeError("Expected websocket to be an object");
  }
  const legacyTls = options.cert != null || options.key != null ? options : null;
  const tlsConfigs = validateServeTls(options.tls ?? legacyTls);
  const configuredMaxRequestBodySize = Number(options.maxRequestBodySize ?? 128 * 1024 * 1024);
  if (websocketHandlers != null || tlsConfigs != null || hostname.includes(":") ||
      (process.platform === "win32" && unixPath)) {
    return serveNodeBacked(options, { hostname, unixPath, tlsConfigs, inspectorReload });
  }

  return startNativeServe(options, {
    CottontailAbortController,
    Response,
    abortActiveServeRequests,
    activeServeDispatches,
    activeServeLifecycles,
    activeServeOrigins,
    activeServeRequestBodyStateSymbol,
    activeServeUnreadBodyAbortError,
    arrayBufferFromBytes,
    binding: cottontail,
    bytesFromBody,
    bytesFromData,
    configuredMaxRequestBodySize,
    consumeStreamingBody,
    createNativeServeRequestOperation,
    createNativeServeRequestState,
    createServeLifecycle,
    defaultServePort,
    dispatchServeFetch,
    finalizeServeInspector,
    finishActiveServeRequestBody,
    headersToText,
    hostname,
    incomingRequestURLFactory,
    inspectorReload,
    isPromiseLike,
    isStreamingBody,
    normalizeRequestUrl,
    normalizeResponseResult,
    normalizeServeDateHeader,
    normalizeServeListenErrorCode,
    parseHeadersText,
    registerServeHtmlOptions,
    requestIdleTimeout,
    requestWithLazyURL,
    runServeHandler,
    serveHtmlStateSymbol,
    serveRequestPeers,
    serveResponseWithIdleTimeout,
    serveUnixUrlText,
    setServeRequestIdleTimeout,
    unixPath,
  });
}

function tarString(bytes, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && bytes[end] !== 0) end += 1;
  return new TextDecoder().decode(bytes.slice(offset, end));
}

function tarOctal(bytes, offset, length) {
  const raw = tarString(bytes, offset, length).trim();
  return raw ? parseInt(raw, 8) || 0 : 0;
}

function tarOctalField(value, length) {
  const text = Math.max(0, Number(value) || 0).toString(8).slice(-(length - 1));
  return `${text.padStart(length - 1, "0")}\0`;
}

function tarChecksumField(value) {
  return `${Math.max(0, Number(value) || 0).toString(8).slice(-6).padStart(6, "0")}\0 `;
}

function safeArchivePath(path) {
  const parts = [];
  for (const part of String(path).replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error(`Unsafe archive path: ${path}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const normalized = parts.join("/");
  if (!normalized) {
    throw new Error(`Unsafe archive path: ${path}`);
  }
  return normalized;
}

async function archiveEntryBytes(value) {
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return bytesFromData(value);
}

function snapshotArchiveEntryValue(value) {
  if (value instanceof Blob) return value;
  return new Uint8Array(bytesFromData(value));
}

async function tarBytesFromEntries(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  for (const [entryName, entryValue] of entries) {
    const name = safeArchivePath(entryName);
    const data = await archiveEntryBytes(entryValue);
    const header = new Uint8Array(512);
    const nameBytes = encoder.encode(name);
    if (nameBytes.byteLength > 100) throw new Error(`Archive path is too long: ${name}`);
    header.set(nameBytes, 0);
    header.set(encoder.encode(tarOctalField(0o644, 8)), 100);
    header.set(encoder.encode(tarOctalField(0, 8)), 108);
    header.set(encoder.encode(tarOctalField(0, 8)), 116);
    header.set(encoder.encode(tarOctalField(data.byteLength, 12)), 124);
    header.set(encoder.encode(tarOctalField(Math.floor(Date.now() / 1000), 12)), 136);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.set(encoder.encode(tarChecksumField(checksum)), 148);
    chunks.push(header, data);
    const padding = (512 - (data.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return concatManyBuffers(chunks);
}

class ArchiveFile {
  constructor(name, bytes, type = "file") {
    this.name = name;
    this.size = bytes.byteLength;
    this.type = type;
    this._bytes = bytes;
  }
  async arrayBuffer() {
    return arrayBufferFromBytes(this._bytes);
  }
  async text() {
    return new TextDecoder().decode(this._bytes);
  }
  async json() {
    return JSON.parse(await this.text());
  }
}

function isTarZeroBlock(bytes, offset) {
  for (let index = 0; index < 512; index += 1) {
    if (bytes[offset + index] !== 0) return false;
  }
  return true;
}

function archivePayloadBytes(bytes) {
  const data = asBuffer(bytes);
  if (data.byteLength >= 2 && data[0] === 0x1f && data[1] === 0x8b) return asBuffer(zlib.gunzipSync(data));
  return data;
}

function archiveGlobRegExp(pattern) {
  const text = String(pattern).replace(/\\/g, "/");
  if (text === "**") return /^.*$/;
  let source = "^";
  for (let index = 0; index < text.length;) {
    if (text.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (text.startsWith("**", index)) {
      source += ".*";
      index += 2;
      continue;
    }
    const char = text[index++];
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function archiveGlobFilter(glob = undefined) {
  if (glob === undefined) return () => true;
  const patterns = Array.isArray(glob) ? glob : [glob];
  if (patterns.some((pattern) => typeof pattern !== "string")) throw new TypeError("Archive glob patterns must be strings");
  const positive = patterns.filter((pattern) => !pattern.startsWith("!")).map(archiveGlobRegExp);
  const negative = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => archiveGlobRegExp(pattern.slice(1)));
  return (path) => {
    const included = positive.length === 0 || positive.some((pattern) => pattern.test(path));
    return included && !negative.some((pattern) => pattern.test(path));
  };
}

export class Archive {
  constructor(input, options = {}) {
    if (arguments.length === 0 || input == null) throw new TypeError("Bun.Archive requires input");
    if (typeof input !== "object" && typeof input !== "string") throw new TypeError("Bun.Archive input must be an object, Blob, ArrayBuffer, or Uint8Array");
    if (options?.compress === "gzip" && options.level != null) {
      const level = Number(options.level);
      if (!Number.isInteger(level) || level < 1 || level > 12) throw new RangeError("gzip level must be between 1 and 12");
    }
    this._blob = input instanceof Blob ? input : null;
    this._entries = input && typeof input === "object" && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer) && !(input instanceof Blob)
      ? Object.entries(input).map(([name, value]) => [name, snapshotArchiveEntryValue(value)])
      : null;
    this._bytes = this._entries || this._blob ? null : new Uint8Array(bytesFromData(input));
    this._options = options ?? {};
    this._files = null;
  }
  static async write(destination, input, options = undefined) {
    if (arguments.length < 2) throw new TypeError("Bun.Archive.write requires a destination and input");
    const archive = input instanceof Archive ? input : new Archive(input, options ?? {});
    return write(destination, await archive.bytes(), { createPath: true });
  }
  async _ensureBytes() {
    if (this._bytes != null) return this._bytes;
    if (this._blob) {
      this._bytes = new Uint8Array(await this._blob.arrayBuffer());
      return this._bytes;
    }
    let bytes = await tarBytesFromEntries(this._entries ?? []);
    if (this._options.compress === "gzip") {
      bytes = zlib.gzipSync(bytes, { level: Math.max(1, Math.min(9, Number(this._options.level ?? 6))) });
    }
    this._bytes = bytes;
    return bytes;
  }
  _parseFiles() {
    if (this._files) return this._files;
    const files = new Map();
    const bytes = archivePayloadBytes(this._bytes);
    if (bytes.length > 0 && bytes.length % 512 !== 0) throw new Error("Invalid tar archive");
    for (let offset = 0; offset + 512 <= bytes.length;) {
      if (isTarZeroBlock(bytes, offset)) break;
      const name = tarString(bytes, offset, 100);
      const prefix = tarString(bytes, offset + 345, 155);
      const size = tarOctal(bytes, offset + 124, 12);
      const mtime = tarOctal(bytes, offset + 136, 12);
      const typeflag = String.fromCharCode(bytes[offset + 156] || 0);
      if (!name && size === 0) break;
      // POSIX writes "ustar\0"; GNU tar writes "ustar " in the same field.
      const magic = tarString(bytes, offset + 257, 6);
      if (magic && magic !== "ustar" && magic !== "ustar ") {
        throw new Error("Invalid tar archive");
      }
      let path;
      try {
        path = safeArchivePath(prefix ? `${prefix}/${name}` : name);
      } catch {
        offset += 512 + Math.ceil(size / 512) * 512;
        continue;
      }
      const dataOffset = offset + 512;
      if (dataOffset + size > bytes.length) throw new Error("Invalid tar archive");
      if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
        const fileBytes = bytes.slice(dataOffset, dataOffset + size);
        const FileCtor = globalThis.File;
        files.set(path, typeof FileCtor === "function"
          ? new FileCtor([fileBytes], path, { lastModified: mtime > 0 ? mtime * 1000 : Date.now(), type: guessMimeType(path) })
          : new ArchiveFile(path, fileBytes));
      }
      offset = dataOffset + Math.ceil(size / 512) * 512;
    }
    this._files = files;
    return files;
  }
  async files(glob = undefined) {
    if (glob !== undefined && typeof glob !== "string" && !Array.isArray(glob)) throw new TypeError("Archive.files glob must be a string or array");
    await this._ensureBytes();
    const filter = archiveGlobFilter(glob);
    return new Map([...this._parseFiles()].filter(([path]) => filter(path)));
  }
  async extract(destination, options = undefined) {
    if (arguments.length === 0 || destination == null) throw new TypeError("Archive.extract requires a destination path");
    if (typeof destination !== "string") throw new TypeError("Archive.extract destination must be a string");
    const bytes = await this._ensureBytes();
    const dest = String(destination);
    cottontail.mkdirSync(dest, true);
    const extractWithParser = async () => {
      const files = await this.files(options?.glob);
      for (const [path, file] of files) {
        const outPath = pathJoin(dest, path);
        cottontail.mkdirSync(pathDirname(outPath), true);
        cottontail.writeFile(outPath, asBuffer(await file.arrayBuffer()));
      }
      return files.size;
    };
    if (options?.glob !== undefined) return extractWithParser();
    const archiveTmpRoot = tmpRoot("archive");
    cottontail.mkdirSync(archiveTmpRoot, true);
    const tarPath = pathJoin(archiveTmpRoot, `archive-${Date.now()}-${Math.floor(Math.random() * 1000000)}.tar`);
    cottontail.writeFile(tarPath, bytes);
    const result = cottontail.spawnSync("tar", ["-xf", tarPath, "-C", dest], { stdio: "pipe" });
    cottontail.unlinkSync(tarPath);
    if (result.status !== 0) {
      return extractWithParser();
    }
    try {
      return this._parseFiles().size;
    } catch {
      return 0;
    }
  }
  async bytes() {
    return new Uint8Array(await this._ensureBytes());
  }
  async blob() {
    return new Blob([await this.bytes()], { type: this._options.compress === "gzip" ? "application/gzip" : "application/x-tar" });
  }
}

export class ArrayBufferSink {
  constructor() {
    this._chunks = [];
    this._ended = false;
    this._asUint8Array = false;
    this._streaming = false;
  }

  start(options = {}) {
    this._chunks = [];
    this._ended = false;
    this._asUint8Array = Boolean(options.asUint8Array);
    this._streaming = Boolean(options.stream);
    return this;
  }

  write(chunk) {
    if (this._ended) throw new Error("ArrayBufferSink is closed");
    const bytes = typeof chunk === "string" ? asBuffer(chunk) : asBuffer(chunk);
    this._chunks.push(bytes);
    return bytes.byteLength;
  }

  flush() {
    if (!this._streaming) return 0;
    const bytes = concatManyBuffers(this._chunks.splice(0));
    return this._asUint8Array ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  end(chunk = undefined) {
    if (chunk != null) this.write(chunk);
    this._ended = true;
    const bytes = concatManyBuffers(this._chunks);
    if (this._asUint8Array) return bytes;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
}

function normalizeCryptoHasherAlgorithm(algorithm) {
  const normalized = String(algorithm).toLowerCase().replace(/[_/]/g, "-");
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (compact === "sha128" || compact === "sha1") return "sha1";
  if (compact === "sha224") return "sha224";
  if (compact === "sha256") return "sha256";
  if (compact === "sha384") return "sha384";
  if (compact === "sha512") return "sha512";
  if (compact === "sha512224") return "sha512-224";
  if (compact === "sha512256") return "sha512-256";
  if (compact === "ripemd160" || compact === "rmd160") return "ripemd160";
  if (compact === "blake2b256") return "blake2b256";
  if (compact === "blake2b512") return "blake2b512";
  if (compact === "blake2s256") return "blake2s256";
  if (compact === "md4") return "md4";
  if (compact === "md5") return "md5";
  if (compact.startsWith("sha3")) return `sha3-${compact.slice(4)}`;
  if (compact === "shake128" || compact === "shake256") return compact;
  return normalized;
}


function cryptoHasherBytes(data, encoding = undefined) {
  if (arguments.length === 0 || data == null) throw new TypeError("CryptoHasher update requires data");
  if (isBunFileLike(data)) throw new TypeError("Bun.file is not supported by CryptoHasher");
  if (typeof globalThis.Blob === "function" && data instanceof globalThis.Blob) {
    const bytes = blobBytesSync(data);
    if (bytes.byteLength !== Number(data.size)) throw new TypeError("Unable to read Blob bytes synchronously");
    return bytes;
  }
  if (typeof data === "string") return globalThis.Buffer.from(data, encoding);
  return asBuffer(data);
}

function encodeCryptoDigest(bytes, encoding) {
  if (encoding != null && typeof encoding === "object" && (ArrayBuffer.isView(encoding) || encoding instanceof ArrayBuffer)) {
    const target = encoding instanceof ArrayBuffer
      ? new Uint8Array(encoding)
      : new Uint8Array(encoding.buffer, encoding.byteOffset, encoding.byteLength);
    if (target.byteLength < bytes.length) {
      throw new TypeError(`TypedArray must be at least ${bytes.length} bytes`);
    }
    target.set(bytes);
    return encoding;
  }
  if (encoding == null || encoding === "buffer") return globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : bytes;
  if (encoding === "base64url") {
    const base64 = globalThis.Buffer?.from ? globalThis.Buffer.from(bytes).toString("base64") : btoa(String.fromCharCode(...bytes));
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  return (globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : asBuffer(bytes)).toString(encoding);
}

function nodeDigest(algorithm, chunks, encoding = undefined, key = undefined) {
  const hash = key === undefined ? createHash(algorithm) : createHmac(algorithm, key);
  for (const chunk of chunks) hash.update(chunk);
  const output = hash.digest();
  return encodeCryptoDigest(output, encoding);
}

const cryptoHasherNativeHandle = Symbol("CryptoHasher.nativeHandle");
const cryptoHasherNativeKeyed = Symbol("CryptoHasher.nativeKeyed");

function cryptoHasherNativeOutput(encoding) {
  if (encoding != null && typeof encoding === "object" && (ArrayBuffer.isView(encoding) || encoding instanceof ArrayBuffer)) {
    const target = encoding instanceof ArrayBuffer
      ? new Uint8Array(encoding)
      : new Uint8Array(encoding.buffer, encoding.byteOffset, encoding.byteLength);
    return [8, target, encoding];
  }
  if (encoding == null || encoding === "buffer") return [0];

  switch (String(encoding).toLowerCase()) {
    case "hex":
      return [1];
    case "base64":
      return [2];
    case "base64url":
      return [3];
    case "latin1":
    case "binary":
      return [4];
    case "ascii":
      return [5];
    case "utf8":
    case "utf-8":
      return [6];
    case "ucs2":
    case "ucs-2":
    case "utf16le":
    case "utf-16le":
      return [7];
    default:
      // Delegate invalid-encoding validation to Buffer before finalizing the
      // native state so a generic CryptoHasher remains retryable.
      encodeCryptoDigest(new Uint8Array(0), encoding);
      return [0];
  }
}

function nativeCryptoHasherDigest(handle, encoding) {
  const output = cryptoHasherNativeOutput(encoding);
  const result = output.length === 3
    ? globalThis.cottontail.cryptoHasherDigest(handle, output[0], output[1])
    : globalThis.cottontail.cryptoHasherDigest(handle, output[0]);
  if (output.length === 3) return output[2];
  if (output[0] === 0) {
    return globalThis.Buffer?.from ? globalThis.Buffer.from(result) : new Uint8Array(result);
  }
  return result;
}

export class CryptoHasher {
  constructor(algorithm, key = undefined) {
    if (algorithm == null) throw new TypeError("Expected an algorithm name as an argument");
    this.algorithm = normalizeCryptoHasherAlgorithm(algorithm);
    const keyBytes = key === undefined ? undefined : cryptoHasherBytes(key);
    if (keyBytes !== undefined && !["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-224", "sha512-256", "blake2b512"].includes(this.algorithm)) {
      throw new Error(`${this.algorithm} is not supported`);
    }
    const nativeCreate = globalThis.cottontail?.cryptoHasherCreate;
    const nativeHandle = typeof nativeCreate === "function"
      ? keyBytes === undefined
        ? nativeCreate(this.algorithm)
        : nativeCreate(this.algorithm, keyBytes)
      : null;
    this[cryptoHasherNativeHandle] = nativeHandle;
    this[cryptoHasherNativeKeyed] = keyBytes !== undefined;
    this._key = nativeHandle == null ? keyBytes : undefined;
    this._chunks = nativeHandle == null ? [] : undefined;
    this._finished = false;
  }

  get byteLength() {
    if (this._finished) throw new Error("CryptoHasher hasher already digested");
    return {
      md4: 16,
      md5: 16,
      ripemd160: 20,
      sha1: 20,
      sha224: 28,
      sha256: 32,
      sha384: 48,
      sha512: 64,
      "sha512-224": 28,
      "sha512-256": 32,
      "sha3-224": 28,
      "sha3-256": 32,
      "sha3-384": 48,
      "sha3-512": 64,
      shake128: 16,
      shake256: 32,
      blake2b256: 32,
      blake2b512: 64,
      blake2s256: 32,
    }[this.algorithm] ?? 0;
  }

  update(data, encoding = undefined) {
    if (this._finished) throw new Error("Digest already called");
    const bytes = cryptoHasherBytes(data, encoding);
    const handle = this[cryptoHasherNativeHandle];
    if (handle == null) {
      this._chunks.push(bytes);
    } else {
      globalThis.cottontail.cryptoHasherUpdate(handle, bytes);
    }
    return this;
  }

  digest(encoding = undefined) {
    if (this._finished) throw new Error("Digest already called");
    const handle = this[cryptoHasherNativeHandle];
    const output = handle == null
      ? nodeDigest(this.algorithm, this._chunks, encoding, this._key)
      : nativeCryptoHasherDigest(handle, encoding);
    if (!this[cryptoHasherNativeKeyed]) {
      if (handle == null) this._chunks = [];
    } else {
      this._key = undefined;
      this._chunks = [];
      this._finished = true;
    }
    return output;
  }

  copy() {
    if (this._finished) throw new Error("CryptoHasher hasher already digested");
    const handle = this[cryptoHasherNativeHandle];
    if (handle != null) {
      const next = Object.create(CryptoHasher.prototype);
      next.algorithm = this.algorithm;
      next[cryptoHasherNativeHandle] = globalThis.cottontail.cryptoHasherCopy(handle);
      next[cryptoHasherNativeKeyed] = this[cryptoHasherNativeKeyed];
      next._key = undefined;
      next._chunks = undefined;
      next._finished = false;
      return next;
    }
    const next = new CryptoHasher(this.algorithm);
    next._chunks = this._chunks.map((chunk) => asBuffer(chunk));
    next._key = this._key == null ? undefined : asBuffer(this._key);
    next[cryptoHasherNativeKeyed] = this[cryptoHasherNativeKeyed];
    return next;
  }

  static hash(algorithm, data, encoding = undefined) {
    const hasher = new CryptoHasher(algorithm);
    return hasher.update(data).digest(encoding);
  }
}

Object.defineProperty(CryptoHasher, "algorithms", {
  value: Object.freeze([
    "blake2b256",
    "blake2b512",
    "blake2s256",
    "md4",
    "md5",
    "ripemd160",
    "sha1",
    "sha224",
    "sha256",
    "sha384",
    "sha512",
    "sha512-224",
    "sha512-256",
    "sha3-224",
    "sha3-256",
    "sha3-384",
    "sha3-512",
    "shake128",
    "shake256",
  ]),
  writable: false,
  enumerable: true,
  configurable: true,
});

function hashClass(algorithm) {
  return class BunHash {
    constructor() {
      this._hasher = new CryptoHasher(algorithm);
    }
    get byteLength() {
      return this._hasher.byteLength;
    }
    update(data, encoding = undefined) {
      if (this._finished) throw new Error(`${this.constructor.name} hasher already digested, create a new instance to update`);
      this._hasher.update(data, encoding);
      return this;
    }
    digest(encoding = undefined) {
      if (this._finished) throw new Error(`${this.constructor.name} hasher already digested, create a new instance to digest again`);
      this._finished = true;
      return this._hasher.digest(encoding);
    }
    static hash(data, encoding = undefined) {
      // Fast path for the overwhelmingly common one-shot case: hash a
      // string/typed-array directly through the native digest without
      // building CryptoHasher/node Hash instances.
      if (
        typeof cottontail?.cryptoHashSync === "function" &&
        (typeof data === "string" || ArrayBuffer.isView(data) || data instanceof ArrayBuffer) &&
        (encoding === undefined || encoding === "hex" || encoding === "base64")
      ) {
        try {
          const bytes = typeof data === "string" ? asBuffer(data) : data;
          if (encoding === "hex") {
            const hex = cottontail.cryptoHashSync(algorithm, bytes, undefined, "hex");
            if (typeof hex === "string") return hex;
            return globalThis.Buffer.from(hex).toString("hex");
          }
          const digest = globalThis.Buffer.from(cottontail.cryptoHashSync(algorithm, bytes));
          if (encoding === undefined) return digest;
          return digest.toString(encoding);
        } catch {
          // fall through to the generic implementation
        }
      }
      return CryptoHasher.hash(algorithm, data, encoding);
    }
  };
}

export const MD4 = hashClass("md4");
export const MD5 = hashClass("md5");
export const SHA1 = hashClass("sha1");
export const SHA224 = hashClass("sha224");
export const SHA256 = hashClass("sha256");
export const SHA384 = hashClass("sha384");
export const SHA512 = hashClass("sha512");
export const SHA512_256 = hashClass("sha512-256");

export function allocUnsafe(size) {
  return globalThis.Buffer?.allocUnsafe ? globalThis.Buffer.allocUnsafe(Number(size)) : new Uint8Array(Number(size));
}

export function concatArrayBuffers(buffers, maxLength = Infinity, asUint8Array = false) {
  if (typeof maxLength === "function") {
    const bytes = concatManyBuffers(Array.from(buffers ?? []));
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return maxLength === ArrayBuffer ? arrayBuffer : new maxLength(arrayBuffer);
  }
  const chunks = Array.from(buffers ?? []).map(asBuffer);
  const limit = Math.max(0, Math.min(Number(maxLength), chunks.reduce((total, chunk) => total + chunk.byteLength, 0)));
  const size = Number.isFinite(limit) ? limit : chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  let out;
  try {
    out = new Uint8Array(size);
  } catch {
    throw new RangeError(`Failed to allocate ${size} bytes`);
  }
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.byteLength) break;
    const next = chunk.subarray(0, out.byteLength - offset);
    out.set(next, offset);
    offset += next.byteLength;
  }
  return asUint8Array ? out : out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

export const cwd = cottontail.cwd();
export const main = globalThis.process?.argv?.[1] ?? "";
export const origin = "";
export const isMainThread = cottontail.isWorker?.() !== true;
export const version = "1.3.10";
export const revision = "cottontail";
export const version_with_sha = `v${version} (${revision})`;
if (globalThis.process) {
  globalThis.process.versions ??= {};
  globalThis.process.versions.cottontail = String(cottontail.processInfo("version"));
  globalThis.process.versions.bun = version;
  globalThis.process.revision = revision;
}
// Bun.stdin is a BunFile-like object (upstream: a lazy Blob over fd 0) with
// stream()/text()/json()/bytes()/arrayBuffer(). process.stdin is a real node
// Readable now, so wrap it rather than exposing it directly.
async function* iterateStdinChunks(source) {
  if (!source) return;
  if (typeof source[Symbol.asyncIterator] === "function") {
    for await (const chunk of source) yield asBuffer(chunk);
    return;
  }

  const chunks = [];
  let ended = source.readableEnded === true;
  let failure;
  let wake;
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const onData = (chunk) => {
    chunks.push(asBuffer(chunk));
    notify();
  };
  const onEnd = () => {
    ended = true;
    notify();
  };
  const onError = (error) => {
    failure = error;
    ended = true;
    notify();
  };
  source.on?.("data", onData);
  source.once?.("end", onEnd);
  source.once?.("error", onError);
  try {
    while (!ended || chunks.length > 0) {
      if (chunks.length > 0) {
        yield chunks.shift();
        continue;
      }
      await new Promise((resolve) => { wake = resolve; });
    }
    if (failure) throw failure;
  } finally {
    source.off?.("data", onData);
    source.off?.("end", onEnd);
    source.off?.("error", onError);
  }
}

function collectStdinBytes() {
  const source = globalThis.process?.stdin;
  if (!source) return Promise.resolve(new Uint8Array(0));
  return (async () => {
    const chunks = [];
    for await (const chunk of iterateStdinChunks(source)) chunks.push(chunk);
    return concatManyBuffers(chunks);
  })();
}
export const stdin = {
  name: "",
  fd: 0,
  type: "application/octet-stream",
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "FileRef (stdin) {}";
  },
  get size() {
    try { return Number(cottontail.fstatSync(0)?.size ?? 0); } catch { return 0; }
  },
  get readable() {
    return this.stream();
  },
  stream() {
    const source = globalThis.process?.stdin;
    return bodyReadableStream((async function* () {
      yield* iterateStdinChunks(source);
    })());
  },
  async text() {
    return new TextDecoder().decode(await collectStdinBytes());
  },
  async json() {
    return JSON.parse(new TextDecoder().decode(await collectStdinBytes()));
  },
  async bytes() {
    return collectStdinBytes();
  },
  async arrayBuffer() {
    const bytes = await collectStdinBytes();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
  async exists() {
    return true;
  },
  // Delegate event-emitter style access so legacy callers treating Bun.stdin
  // as process.stdin keep working.
  on(...args) { globalThis.process?.stdin?.on?.(...args); return this; },
  once(...args) { globalThis.process?.stdin?.once?.(...args); return this; },
  off(...args) { globalThis.process?.stdin?.off?.(...args); return this; },
  resume() { globalThis.process?.stdin?.resume?.(); return this; },
  pause() { globalThis.process?.stdin?.pause?.(); return this; },
  setEncoding(value) { globalThis.process?.stdin?.setEncoding?.(value); return this; },
  ref() { globalThis.process?.stdin?.ref?.(); return this; },
  unref() { globalThis.process?.stdin?.unref?.(); return this; },
};
export const stdout = globalThis.process?.stdout;
export const stderr = globalThis.process?.stderr;
export function jest(_source = undefined) {
  const inTestRunner = globalThis.__cottontailRegisteringTestFile != null ||
    globalThis.__cottontailCurrentTestFile?.() != null ||
    globalThis.__cottontailCurrentTestToken?.() != null;
  if (inTestRunner && typeof _source !== "string") {
    throw new Error("Bun.jest() expects a string filename");
  }
  const sharedModule = globalThis[Symbol.for("cottontail.internal.bunTestModule")];
  if (sharedModule != null) return sharedModule;
  const module = loadBunTestModule();
  return module.default ?? module;
}

const bunSleepSetTimeout = globalThis.setTimeout.bind(globalThis);

export function sleep(ms) {
  const duration = ms instanceof Date ? ms.getTime() - Date.now() : Number(ms);
  const maxTimeout = 2 ** 31 - 1;
  // Real bun schedules a timer even for sleep(0): resolution is a macrotask
  // that runs after pending microtasks (tests depend on this ordering).
  const delay = !(duration > 0) ? 0 : (Number.isFinite(duration) ? Math.min(duration, maxTimeout) : maxTimeout);
  // Bun.sleep is a runtime timer, so bun:test fake timers must not intercept it.
  return new Promise((resolve) => bunSleepSetTimeout(resolve, delay));
}

export function sleepSync(ms) {
  if (arguments.length === 0 || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    throw new TypeError("Bun.sleepSync expects a non-negative finite number");
  }
  cottontail.sleep(ms);
}

export function nanoseconds() {
  // Bun.nanoseconds() returns a number (not a bigint): ns since process start.
  const bigintNs = globalThis.process?.hrtime?.bigint?.();
  return bigintNs != null ? Number(bigintNs) : Math.floor((performance?.now?.() ?? Date.now()) * 1_000_000);
}

function bunForceGc(force = undefined) {
  // Bun.gc() with no argument must collect fully and synchronously: the
  // non-force path (JSGarbageCollect) neither shrinks heap capacity nor
  // returns pages, so tight alloc/gc loops balloon the RSS high-water mark
  // (~100 MB per 1M small objects) and request-clone-leak tests fail.
  cottontail.gc?.(force === undefined ? true : Boolean(force));
  cottontail.drainJobs?.();
}
export { bunForceGc as gc };

const bunInspectQuote = (text) => JSON.stringify(String(text));

function bunInspectPropertyDescriptor(value, key) {
  for (let current = value; current != null; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
  }
  return undefined;
}

function bunInspectIsPrototypeObject(value) {
  const descriptor = Object.getOwnPropertyDescriptor(value, "constructor");
  return typeof descriptor?.value === "function" && descriptor.value.prototype === value;
}

function bunInspectIsPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  for (let proto = Object.getPrototypeOf(value); proto != null; proto = Object.getPrototypeOf(proto)) {
    if (proto === Object.prototype) return true;
    const constructor = Object.getOwnPropertyDescriptor(proto, "constructor");
    if (constructor && constructor.value !== Object) return false;
  }
  return Object.getPrototypeOf(value) === null;
}

function bunInspectFunction(value) {
  let source = "";
  try { source = Function.prototype.toString.call(value); } catch {}
  if (/^\s*class(?:\s|{)/.test(source)) {
    const name = value.name || "(anonymous)";
    const parent = Object.getPrototypeOf(value);
    const extendsName = typeof parent === "function" && parent !== Function.prototype && parent.name
      ? ` extends ${parent.name}`
      : "";
    return `[class ${name}${extendsName}]`;
  }
  let kind = "Function";
  if (/^\s*async\s+function\*/.test(source)) kind = "AsyncGeneratorFunction";
  else if (/^\s*async(?:\s+function|\s*\()/.test(source) || value.constructor?.name === "AsyncFunction") kind = "AsyncFunction";
  else if (/^\s*function\*/.test(source) || value.constructor?.name === "GeneratorFunction") kind = "GeneratorFunction";
  else if (value.constructor?.name === "AsyncGeneratorFunction") kind = "AsyncGeneratorFunction";
  const parent = Object.getPrototypeOf(value);
  if (typeof parent === "function" && parent !== Function.prototype && parent.name) kind = parent.name;
  return value.name ? `[${kind}: ${value.name}]` : `[${kind}]`;
}

// Bun's inspect style: objects/Sets/Maps print one entry per line with
// two-space indent, trailing commas, and double-quoted strings; arrays of
// short simple values stay inline. Values outside these shapes fall back to
// util.inspect.
//
// Signature (matches real bun): Bun.inspect(value, optionsOrDepth?, colors?)
// - a non-null object 2nd arg is an options bag ({ colors, depth, compact,
//   sorted, ... }); the 3rd arg is ignored in that case.
// - a numeric 2nd arg is a depth; the truthiness of the 3rd arg enables colors.
// Depth defaults to 8; objects nested deeper print as "[Object ...]" while
// arrays/Sets/Maps keep printing at any depth (matching real bun).
const bunInspectIdentifierRe = /^[A-Za-z_$][\w$]*$/;

function bunInspectValidateDepth(depth) {
  if (typeof depth !== "number") return 8;
  if (!Number.isInteger(depth) && depth !== Infinity) {
    throw new TypeError(`expected depth to be an integer, got ${depth}`);
  }
  if (depth < 0) {
    throw new TypeError(`expected depth to be greater than or equal to 0, got ${depth}`);
  }
  return depth;
}

function bunInspectNormalizeOptions(arg2, arg3) {
  const ctx = { colors: false, compact: false, maxDepth: 8, userOptions: null };
  if (arg2 !== null && typeof arg2 === "object") {
    ctx.userOptions = arg2;
    ctx.colors = !!arg2.colors;
    ctx.compact = arg2.compact === true;
    ctx.maxDepth = bunInspectValidateDepth(arg2.depth);
  } else {
    if (typeof arg2 === "number") ctx.maxDepth = bunInspectValidateDepth(arg2);
    ctx.colors = !!arg3;
  }
  return ctx;
}

function bunInspectNodeOptions(ctx, depth) {
  const remaining = ctx.maxDepth === Infinity ? Infinity : ctx.maxDepth - depth;
  const nodeOptions = ctx.userOptions ? { ...ctx.userOptions } : {};
  delete nodeOptions.compact;
  nodeOptions.colors = ctx.colors;
  nodeOptions.depth = remaining;
  return nodeOptions;
}

// Colors mirror real bun's escape sequences closely enough that stripping the
// ANSI codes yields exactly the colorless output.
function bunInspectStyle(text, code, ctx) {
  if (!ctx.colors) return text;
  return `[0m[${code}m${text}[0m`;
}

function bunInspectKeyPrefix(printedKey, ctx) {
  if (!ctx.colors) return `${printedKey}: `;
  return `[0m${printedKey}[2m:[0m `;
}

function bunInspectComma(ctx) {
  return ctx.colors ? `[0m[2m,[0m` : ",";
}

function bunInspectCustomOptions(ctx) {
  const options = ctx.userOptions ? { ...ctx.userOptions } : {};
  options.colors = ctx.colors;
  options.depth = ctx.maxDepth;
  options.stylize = (text, style) => {
    if (!ctx.colors) return String(text);
    const colors = { boolean: 33, number: 33, bigint: 33, string: 32, symbol: 32 };
    const code = colors[style];
    return code == null ? String(text) : `[${code}m${text}[39m`;
  };
  return options;
}

const dynamicErrorSourceSymbol = Symbol.for("cottontail.dynamicErrorSource");
const bunInspectSetSizeGetter = Object.getOwnPropertyDescriptor(Set.prototype, "size")?.get;
const bunInspectMapSizeGetter = Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get;

function bunInspectCollectionSize(value, getter) {
  try {
    return Reflect.apply(getter, value, []);
  } catch {
    return null;
  }
}

function bunInspectArrayIndexKey(key) {
  if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return index >= 0 && index < 0xffffffff && Number.isInteger(index);
}

function bunInspectArrayTokens(tokens, indent) {
  const pad = `${indent}  `;
  const lines = [];
  let line = "";
  let width = pad.length;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const separator = line ? ", " : "";
    if (line && width + separator.length + token.length >= 80) {
      lines.push(`${line},`);
      line = `${pad}${token}`;
      width = pad.length + token.length;
    } else {
      line += `${separator}${line ? "" : pad}${token}`;
      width += separator.length + token.length;
    }
  }
  if (line) lines.push(line);
  return `[\n${lines.join("\n")}\n${indent}]`;
}

function bunInspectFunctionNamespace(value, ctx, indent, seen, depth) {
  if (value === null || typeof value !== "object") return null;
  const prototype = Object.getPrototypeOf(value);
  if (typeof prototype !== "function") return null;

  const entries = [];
  const included = new Set();
  const addDescriptor = (owner, key, inherited) => {
    if (included.has(key) || key === ctInspectSymbol || key === "arguments" || key === "caller") return;
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (!descriptor) return;
    if (inherited && !descriptor.enumerable && key !== "length" && key !== "name" && key !== "prototype") return;
    if (!inherited && !descriptor.enumerable) return;
    included.add(key);
    entries.push([key, descriptor]);
  };

  for (const key of Reflect.ownKeys(value)) addDescriptor(value, key, false);
  for (const key of Reflect.ownKeys(prototype)) addDescriptor(prototype, key, true);
  if (entries.length === 0) return "Function {}";

  const comma = bunInspectComma(ctx);
  const nested = `${indent}  `;
  seen.add(value);
  try {
    const rendered = entries.map(([key, descriptor]) => {
      const printedKey = typeof key === "symbol"
        ? `[${String(key)}]`
        : (bunInspectIdentifierRe.test(key) ? key : bunInspectQuote(key));
      const inspected = "value" in descriptor
        ? bunStyleInspect(descriptor.value, ctx, nested, seen, depth + 1)
        : (descriptor.get && descriptor.set ? "[Getter/Setter]" : descriptor.get ? "[Getter]" : "[Setter]");
      return `${nested}${bunInspectKeyPrefix(printedKey, ctx)}${inspected}${comma}`;
    });
    return `Function {\n${rendered.join("\n")}\n${indent}}`;
  } finally {
    seen.delete(value);
  }
}

function bunInspectJsxKind(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "$$typeof");
  if (!(descriptor && "value" in descriptor)) return false;
  return descriptor.value === Symbol.for("react.element") ||
    descriptor.value === Symbol.for("react.transitional.element") ||
    descriptor.value === Symbol.for("react.fragment");
}

function bunInspectJsx(value, ctx, indent, seen, depth) {
  const type = value.type;
  const isFragment = type === Symbol.for("react.fragment");
  let tagName = "";
  if (!isFragment) {
    if (typeof type === "string") tagName = type;
    else if (typeof type === "function") {
      let source = "";
      try { source = Function.prototype.toString.call(type); } catch {}
      tagName = source.includes("=>") ? "NoName" : (type.name || "NoName");
    } else if (type != null && typeof type !== "symbol") {
      tagName = type.name || String(type) || "NoName";
    }
  }

  let opening = `<${tagName}`;
  if (value.key != null) opening += ` key=${bunStyleInspect(value.key, ctx, `${indent}  `, seen, depth + 1)}`;
  const props = value.props && typeof value.props === "object" ? value.props : {};
  for (const key of Object.keys(props)) {
    if (key === "children") continue;
    opening += ` ${key}=${bunStyleInspect(props[key], ctx, `${indent}  `, seen, depth + 1)}`;
  }

  const children = props.children;
  const close = `</${tagName}>`;
  if (typeof children === "string" && children.length > 0) {
    if (children.length < 128) return `${opening}>${children}${close}`;
    return `${opening}>\n${indent}  ${children}\n${indent}${close}`;
  }
  if (bunInspectJsxKind(children)) {
    return `${opening}>\n${indent}  ${bunInspectJsx(children, ctx, `${indent}  `, seen, depth + 1)}\n${indent}${close}`;
  }
  if (Array.isArray(children) && children.length > 0) {
    const rendered = children.map((child) => {
      if (typeof child === "string") return child;
      if (bunInspectJsxKind(child)) return bunInspectJsx(child, ctx, `${indent}  `, seen, depth + 1);
      return bunStyleInspect(child, ctx, `${indent}  `, seen, depth + 1);
    });
    return `${opening}>\n${rendered.map((child) => `${indent}  ${child}`).join("\n")}\n${indent}${close}`;
  }
  return `${opening} />`;
}

function bunInspectEventEntries(name, entries, ctx, indent, seen, depth) {
  const nested = `${indent}  `;
  const comma = bunInspectComma(ctx);
  const rendered = entries.map(([key, entry, preRendered]) => {
    const inspected = preRendered === undefined
      ? bunStyleInspect(entry, ctx, nested, seen, depth + 1)
      : preRendered;
    return `${nested}${bunInspectKeyPrefix(key, ctx)}${inspected}${comma}`;
  });
  return `${name} {\n${rendered.join("\n")}\n${indent}}`;
}

function bunInspectDecodeOriginalPath(lines) {
  const marker = lines[0]?.match(/^\/\*@cottontail-original-path-base64:([A-Za-z0-9+/=]+)\*\//);
  if (!marker) return null;
  try {
    if (typeof globalThis.Buffer?.from === "function") return globalThis.Buffer.from(marker[1], "base64").toString("utf8");
    const binary = globalThis.atob(marker[1]);
    return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
  } catch {
    return null;
  }
}

function bunInspectBuildMessageDiagnostic(error) {
  if (error?.name !== "BuildMessage") return null;
  const message = String(error.message ?? "");
  const headline = message.split("\n", 1)[0];
  const location = message.match(/(?:^|\n)\s*at\s+(.+):(\d+):(\d+)\s*$/m) ??
    String(error.stack ?? "").match(/(?:^|\n)\s*at\s+[^\n]*?\(?([^()\n]+):(\d+):(\d+)\)?/);
  if (!location) return null;
  const sourcePath = location[1].trim();
  const lineNumber = Number(location[2]);
  const columnNumber = Number(location[3]);
  let lines;
  try { lines = String(cottontail.readFile(sourcePath)).split(/\r?\n/); } catch { return null; }
  const sourceLine = lines[lineNumber - 1];
  if (sourceLine == null) return null;

  const caret = " ".repeat(String(lineNumber).length + 3 + Math.max(0, columnNumber - 1)) + "^";
  let output = `${lineNumber} | ${sourceLine}\n${caret}\nerror: ${headline}\n    at ${sourcePath}:${lineNumber}:${columnNumber}`;
  const identifier = /^"([^"]+)" has already been declared/.exec(headline)?.[1];
  if (!identifier) return output;
  for (let index = lineNumber - 2; index >= 0; index -= 1) {
    const originalColumn = lines[index].indexOf(identifier);
    if (originalColumn < 0) continue;
    const originalLine = index + 1;
    const originalCaret = " ".repeat(String(originalLine).length + 3 + originalColumn) + "^";
    output += `\n\n${originalLine} | ${lines[index]}\n${originalCaret}\nnote: ${JSON.stringify(identifier)} was originally declared here\n` +
      `   at ${sourcePath}:${originalLine}:${originalColumn + 1}`;
    break;
  }
  return output;
}

function bunInspectErrorDiagnostic(error, ctx = undefined) {
  const stackWasAccessed = bunAccessedErrorStacks.has(error);
  let stack;
  try { stack = error instanceof Error ? error.stack : null; } catch { return null; }
  if (typeof stack !== "string") return null;
  stack = ctRemapStackString(stack);
  const frame = stack.match(/(?:^|\n)\s*at [^\n]*?\(?([^()\n]+):(\d+):(\d+)\)?/);
  if (!frame) return null;
  let context = bundleSourceContextForLocation(frame[1].trim(), Number(frame[2]), Number(frame[3]));
  if (!context) {
    let source = frame[1].trim();
    if (source.startsWith("file://")) {
      try { source = nodeFileURLToPath(source); } catch {}
    }
    try {
      context = {
        source,
        line: Number(frame[2]),
        column: Number(frame[3]),
        lines: String(cottontail.readFile(source)).split(/\r?\n/),
      };
    } catch {
      return null;
    }
  }

  let sourcePath = bunInspectDecodeOriginalPath(context.lines) ?? context.source;
  let sourceLines = context.lines;
  if (sourcePath !== context.source) {
    try { sourceLines = String(cottontail.readFile(sourcePath)).split(/\r?\n/); } catch { sourcePath = context.source; }
  }

  const constructorName = error.constructor?.name || "Error";
  const constructorText = `new ${constructorName}`;
  const message = String(error.message ?? "");
  const reported = Math.max(0, context.line - 1);
  const nearby = context.lines.slice(Math.max(0, reported - 3), reported + 2);
  const generatedLine = nearby.find(line => line.includes(constructorText) && (!message || line.includes(message)));
  let target = generatedLine == null ? -1 : sourceLines.findIndex(line => line.trim() === generatedLine.trim());
  if (target < 0) {
    target = sourceLines.findIndex(line => line.includes(constructorText) && (!message || line.includes(message)));
  }
  if (target < 0 && reported < sourceLines.length) target = reported;
  if (target < 0) return null;

  const start = Math.max(0, target - 5);
  const longLine = sourceLines[target].length > 1024;
  const excerpt = sourceLines.slice(start, target + 1).map((line, offset) => {
    if (start + offset !== target || line.length <= 1024) return `${start + offset + 1} | ${line}`;
    return `${start + offset + 1} | ${line.slice(0, 1024)}${ctx?.colors ? " | ... truncated " : ""}`;
  }).join("\n");
  if (longLine) {
    const errorColumn = sourceLines[target].indexOf(`${constructorName}(`);
    const closingColumn = errorColumn < 0 ? -1 : sourceLines[target].indexOf(")", errorColumn);
    let sameSourceFrame = 0;
    const frames = stack.split("\n").filter(line => /^\s*at\s+/.test(line)).map((line) => {
      const parsed = line.match(/^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/);
      if (!parsed) return `      ${line.trimStart()}`;
      let [, functionName, fileName, lineText, columnText] = parsed;
      if (fileName === sourcePath && Number(lineText) === target + 1) {
        if (sameSourceFrame === 0 && errorColumn >= 0) columnText = String(errorColumn + 1);
        else if (sameSourceFrame === 1 && closingColumn >= 0) columnText = String(closingColumn + 1);
        sameSourceFrame += 1;
      } else {
        try {
          const callerLines = String(cottontail.readFile(fileName)).split(/\r?\n/);
          let callerIndex = Number(lineText) - 1;
          if (callerLines[callerIndex]?.includes("expect.unreachable")) {
            for (let index = callerIndex - 1; index >= Math.max(0, callerIndex - 5); index -= 1) {
              if (!/\btry\s*\{/.test(callerLines[index])) continue;
              callerIndex = index;
              lineText = String(index + 1);
              columnText = String(callerLines[index].length);
              break;
            }
          }
        } catch {}
      }
      return `      at ${functionName} (${fileName}:${lineText}:${columnText})`;
    }).join("\n");
    return `${excerpt}\n\nerror: ${message}${frames ? `\n${frames}` : ""}`;
  }
  const constructorColumn = sourceLines[target].indexOf(constructorText);
  const diagnosticColumn = constructorColumn >= 0
    ? constructorColumn + "new ".length
    : Math.max(0, Number(frame[3]) - 1);
  const caret = " ".repeat(String(target + 1).length + 3 + diagnosticColumn) + "^";
  const label = constructorName === "Error" ? "error" : constructorName;
  const sourceFrames = stack.split("\n")
    .filter(line => /^\s*at\s+/.test(line) && line.includes(sourcePath))
    .filter(line => !line.includes("IGNORE_ME_AFTER_THIS_LINE"))
    .map(line => {
      let frame = line.trimStart();
      frame = frame.replace(/^at ([A-Za-z_$][\w$]*?)(\d+) \(/, (match, name) =>
        sourceLines.some(sourceLine => new RegExp(`\\bfunction\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`).test(sourceLine))
          ? `at ${name} (`
          : match);
      if (frame.startsWith("at unknown (")) {
        frame = stackWasAccessed
          ? `at ${frame.slice("at unknown (".length, -1)}`
          : `at <anonymous> (${frame.slice("at unknown (".length)}`;
      }
      return `      ${frame}`;
    })
    .join("\n");
  const frames = sourceFrames || `      at <anonymous> (${sourcePath}:${target + 1}:${diagnosticColumn + 1})`;
  return `${excerpt}\n${caret}\n${label}: ${message}\n${frames}\n`;
}

function bunInspectEvent(value, objectTag, ctx, indent, seen, depth) {
  if (objectTag === "[object MessageEvent]") {
    return bunInspectEventEntries("MessageEvent", [
      ["type", value.type],
      ["data", value.data],
    ], ctx, indent, seen, depth);
  }
  if (objectTag === "[object ErrorEvent]") {
    const errorDiagnostic = bunInspectErrorDiagnostic(value.error);
    return bunInspectEventEntries("ErrorEvent", [
      ["type", value.type],
      ["message", value.message],
      ["error", value.error, errorDiagnostic ?? (
        value.error instanceof Error
          ? `error: ${String(value.error.message ?? "")}\n`
          : undefined
      )],
    ], ctx, indent, seen, depth);
  }
  const commonEntries = [
    ["type", value.type],
    ["target", value.target],
    ["currentTarget", value.currentTarget],
    ["eventPhase", value.eventPhase],
    ["cancelBubble", value.cancelBubble],
    ["bubbles", value.bubbles],
    ["cancelable", value.cancelable],
    ["defaultPrevented", value.defaultPrevented],
    ["composed", value.composed],
    ["timeStamp", 0],
    ["srcElement", value.srcElement],
    ["returnValue", value.returnValue],
    ["composedPath", value.composedPath],
    ["stopPropagation", value.stopPropagation],
    ["stopImmediatePropagation", value.stopImmediatePropagation],
    ["preventDefault", value.preventDefault],
    ["initEvent", value.initEvent],
    ["NONE", value.NONE],
    ["CAPTURING_PHASE", value.CAPTURING_PHASE],
    ["AT_TARGET", value.AT_TARGET],
    ["BUBBLING_PHASE", value.BUBBLING_PHASE],
  ];
  if (objectTag === "[object CloseEvent]") {
    return bunInspectEventEntries("CloseEvent", [
      ["isTrusted", value.isTrusted],
      ["wasClean", value.wasClean],
      ["code", value.code],
      ["reason", value.reason],
      ...commonEntries,
    ], ctx, indent, seen, depth);
  }
  if (objectTag === "[object CustomEvent]") {
    return bunInspectEventEntries("CustomEvent", [
      ["isTrusted", value.isTrusted],
      ["detail", value.detail],
      ["initCustomEvent", value.initCustomEvent],
      ...commonEntries,
    ], ctx, indent, seen, depth);
  }
  return null;
}

function bunInspectDynamicErrorSource(error, rendered) {
  const metadata = error?.[dynamicErrorSourceSymbol];
  if (!metadata || typeof metadata.source !== "string") return rendered;
  const stack = String(error.stack ?? "");
  const functionName = stack.match(/(?:^|\n)\s*(?:at\s+)?([^@\n]+)@/)?.[1]?.trim() ??
    stack.match(/(?:^|\n)\s*at\s+([^\s(]+)\s*(?:\(|$)/)?.[1]?.trim();
  if (!functionName) return rendered;
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = metadata.source.split(/\r?\n/);
  const lineIndex = lines.findIndex((line) => new RegExp(`\\bfunction\\s+${escapedName}\\s*\\(`).test(line));
  if (lineIndex < 0) return rendered;
  return `${lineIndex + 1} | ${lines[lineIndex].trimEnd()}\n${rendered}`;
}

function bunStyleInspect(value, ctx, indent, seen, depth) {
  if (typeof value === "string") return bunInspectStyle(bunInspectQuote(value), 32, ctx);
  if (typeof value === "bigint") return bunInspectStyle(`${value}n`, 33, ctx);
  if (typeof value === "number" || typeof value === "boolean") {
    return bunInspectStyle(String(value), 33, ctx);
  }
  if (value === null) return bunInspectStyle("null", 33, ctx);
  if (value === undefined) return bunInspectStyle("undefined", 2, ctx);
  if (typeof value === "symbol") return bunInspectStyle(String(value), 34, ctx);
  if (typeof value === "function") {
    return bunInspectFunction(value);
  }
  if (seen.has(value)) return "[Circular]";
  const objectTag = Object.prototype.toString.call(value);
  const eventInspection = bunInspectIsPrototypeObject(value)
    ? null
    : bunInspectEvent(value, objectTag, ctx, indent, seen, depth);
  if (eventInspection !== null) return eventInspection;
  const customDescriptor = bunInspectIsPrototypeObject(value)
    ? undefined
    : bunInspectPropertyDescriptor(value, ctInspectSymbol);
  const custom = customDescriptor && "value" in customDescriptor ? customDescriptor.value : undefined;
  if (typeof custom === "function" && custom !== nodeInspect) {
    const remaining = ctx.maxDepth === Infinity ? Infinity : ctx.maxDepth - depth;
    // Bun passes util.inspect itself as the inspect argument, not a wrapper.
    const result = custom.call(value, remaining, bunInspectCustomOptions(ctx), loadNodeUtilModule().inspect);
    if (result !== value) {
      return typeof result === "string" ? result : bunStyleInspect(result, ctx, indent, seen, depth);
    }
  }
  const functionNamespace = bunInspectFunctionNamespace(value, ctx, indent, seen, depth);
  if (functionNamespace !== null) return functionNamespace;
  const comma = bunInspectComma(ctx);
  const nested = `${indent}  `;
  if (bunInspectJsxKind(value)) {
    seen.add(value);
    try {
      return bunInspectJsx(value, ctx, indent, seen, depth);
    } finally {
      seen.delete(value);
    }
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    seen.add(value);
    try {
      const hasHoles = Object.keys(value).filter(bunInspectArrayIndexKey).length < value.length;
      const extraKeys = Reflect.ownKeys(value).filter((key) => {
        if (key === "length" || bunInspectArrayIndexKey(key)) return false;
        return Object.getOwnPropertyDescriptor(value, key)?.enumerable === true;
      });
      if (hasHoles || extraKeys.length > 0) {
        const tokens = [];
        for (let index = 0; index < value.length;) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor) {
            const start = index;
            do { index += 1; } while (index < value.length && !Object.getOwnPropertyDescriptor(value, String(index)));
            const count = index - start;
            tokens.push(count === 1 ? "empty item" : `${count} x empty items`);
            continue;
          }
          const rendered = "value" in descriptor
            ? bunStyleInspect(descriptor.value, ctx, nested, seen, depth + 1)
            : (descriptor.get && descriptor.set ? "[Getter/Setter]" : descriptor.get ? "[Getter]" : "[Setter]");
          tokens.push(rendered);
          index += 1;
        }
        for (const key of extraKeys) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          const printedKey = typeof key === "symbol"
            ? `[${String(key)}]`
            : (bunInspectIdentifierRe.test(key) ? key : bunInspectQuote(key));
          const rendered = descriptor && "value" in descriptor
            ? bunStyleInspect(descriptor.value, ctx, nested, seen, depth + 1)
            : (descriptor?.get && descriptor?.set ? "[Getter/Setter]" : descriptor?.get ? "[Getter]" : "[Setter]");
          tokens.push(`${bunInspectKeyPrefix(printedKey, ctx)}${rendered}`);
        }
        return bunInspectArrayTokens(tokens, indent);
      }
      const items = value.map((item) => bunStyleInspect(item, ctx, nested, seen, depth + 1));
      const inline = `[ ${items.join(`${comma} `)} ]`;
      if (ctx.compact) return inline;
      if (!inline.includes("\n") && inline.length <= 72) return inline;
      return `[\n${items.map((item) => `${nested}${item}${comma}`).join("\n")}\n${indent}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const items = Array.from(value, (item) => bunStyleInspect(item, ctx, nested, seen, depth + 1));
    const name = value.constructor?.name || "TypedArray";
    return `${name}(${value.length}) [${items.length === 0 ? "" : ` ${items.join(`${comma} `)} `}]`;
  }
  if (objectTag === "[object Arguments]") {
    const items = Array.from(value, (item) => bunStyleInspect(item, ctx, nested, seen, depth + 1));
    return `[${items.length === 0 ? "" : ` ${items.join(`${comma} `)} `}]`;
  }
  if (objectTag === "[object Blob]" || (typeof globalThis.Blob === "function" && value instanceof globalThis.Blob)) {
    const size = inspectBodyByteSize(value) ?? "0 KB";
    if (value.constructor?.name === "File" || (typeof globalThis.File === "function" && value instanceof globalThis.File)) {
      return `File (${size}) {\n${nested}name: ${bunInspectQuote(value.name)},\n${nested}type: ${bunInspectQuote(value.type)},\n${nested}lastModified: ${Number(value.lastModified)}\n${indent}}`;
    }
    const prefix = `Blob (${size})`;
    const name = typeof value.name === "string" ? value.name : null;
    if (name !== null) {
      return `${prefix} {\n${nested}name: ${bunInspectQuote(name)},\n${nested}type: ${bunInspectQuote(value.type)}\n${indent}}`;
    }
    return value.type ? `${prefix} {\n${nested}type: ${bunInspectQuote(value.type)}\n${indent}}` : prefix;
  }
  if (value instanceof Set || objectTag === "[object Set]") {
    const size = bunInspectCollectionSize(value, bunInspectSetSizeGetter);
    if (size === 0) return "Set {}";
    seen.add(value);
    try {
      const items = [...value].map((item) => bunStyleInspect(item, ctx, nested, seen, depth + 1));
      if (ctx.compact) return `Set(${size}) { ${items.join(`${comma} `)} }`;
      return `Set(${size}) {\n${items.map((item) => `${nested}${item}${comma}`).join("\n")}\n${indent}}`;
    } finally {
      seen.delete(value);
    }
  }
  if (value instanceof Map || objectTag === "[object Map]") {
    const size = bunInspectCollectionSize(value, bunInspectMapSizeGetter);
    if (size === 0) return "Map {}";
    seen.add(value);
    try {
      const items = [...value].map(([key, item]) => {
        const renderedKey = bunStyleInspect(key, ctx, nested, seen, depth + 1);
        const renderedValue = bunStyleInspect(item, ctx, nested, seen, depth + 1);
        return `${renderedKey}: ${renderedValue}`;
      });
      if (ctx.compact) return `Map(${size}) { ${items.join(`${comma} `)} }`;
      return `Map(${size}) {\n${items.map((item) => `${nested}${item}${comma}`).join("\n")}\n${indent}}`;
    } finally {
      seen.delete(value);
    }
  }
  if (value instanceof Error && value.__cottontailBunExpectation &&
      typeof globalThis.__cottontailInspectBunExpectationError === "function") {
    return globalThis.__cottontailInspectBunExpectationError(value, ctx.colors);
  }
  if (value instanceof Error && typeof custom !== "function") {
    if (value?.[dynamicErrorSourceSymbol]?.source != null) {
      return bunInspectDynamicErrorSource(value, nodeInspect(value, bunInspectNodeOptions(ctx, depth)));
    }
    const diagnostic = bunInspectBuildMessageDiagnostic(value) ?? bunInspectErrorDiagnostic(value, ctx);
    if (diagnostic !== null) {
      const causeDescriptor = Object.getOwnPropertyDescriptor(value, "cause");
      const cause = causeDescriptor && "value" in causeDescriptor ? causeDescriptor.value : undefined;
      const causeDiagnostic = cause instanceof Error
        ? (bunInspectBuildMessageDiagnostic(cause) ?? bunInspectErrorDiagnostic(cause, ctx))
        : null;
      return causeDiagnostic === null
        ? diagnostic
        : `${diagnostic.trimEnd()}\n\n${causeDiagnostic}`;
    }
    const errorKeys = Object.keys(value).filter((key) => key !== "stack" && key !== "message");
    if (errorKeys.length === 0) {
      return bunInspectDynamicErrorSource(value, nodeInspect(value, bunInspectNodeOptions(ctx, depth)));
    }
    seen.add(value);
    try {
      const header =
        typeof value.stack === "string" && value.stack.length > 0
          ? value.stack
          : `${value.name || "Error"}: ${value.message}`;
      const entries = errorKeys.map((key) => {
        const printedKey = bunInspectIdentifierRe.test(key) ? key : bunInspectQuote(key);
        const rendered = bunStyleInspect(value[key], ctx, nested, seen, depth + 1);
        return `${nested}${bunInspectKeyPrefix(printedKey, ctx)}${rendered}${comma}`;
      });
      return `${header} {\n${entries.join("\n")}\n${indent}}`;
    } finally {
      seen.delete(value);
    }
  }
  const ownTag = Object.getOwnPropertyDescriptor(value, Symbol.toStringTag)?.value;
  const showCommonJsDescriptors = Object.getOwnPropertyDescriptor(
    value,
    Symbol.for("cottontail.commonjsExports"),
  )?.value === true;
  if (bunInspectIsPlainObject(value) || ownTag === "Module") {
    if (depth > ctx.maxDepth) return "[Object ...]";
    const keys = Reflect.ownKeys(value).filter((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable && !(showCommonJsDescriptors && typeof key === "string")) return false;
      return key !== ctInspectSymbol || !("value" in descriptor && typeof descriptor.value === "function");
    });
    const objectPrefix = ownTag === "Module"
      ? "Module "
      : (Object.getPrototypeOf(value) === null ? "[Object: null prototype] " : "");
    if (keys.length === 0) return `${objectPrefix}{}`;
    seen.add(value);
    try {
      const entries = keys.map((key) => {
        const printedKey = typeof key === "symbol"
          ? `[${String(key)}]`
          : (bunInspectIdentifierRe.test(key) ? key : bunInspectQuote(key));
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const rendered = descriptor && !("value" in descriptor)
          ? (ownTag === "Module" && typeof descriptor.get === "function"
            ? (() => {
              try { return bunStyleInspect(Reflect.get(value, key), ctx, nested, seen, depth + 1); }
              catch { return descriptor.set ? "[Getter/Setter]" : "[Getter]"; }
            })()
            : (descriptor.get && descriptor.set ? "[Getter/Setter]" : descriptor.get ? "[Getter]" : "[Setter]"))
          : bunStyleInspect(descriptor?.value, ctx, nested, seen, depth + 1);
        return `${bunInspectKeyPrefix(printedKey, ctx)}${rendered}`;
      });
      if (ctx.compact) return `${objectPrefix}{ ${entries.join(`${comma} `)} }`;
      return `${objectPrefix}{\n${entries.map((entry) => `${nested}${entry}${comma}`).join("\n")}\n${indent}}`;
    } finally {
      seen.delete(value);
    }
  }
  return nodeInspect(value, bunInspectNodeOptions(ctx, depth));
}

export function inspect(value, options = undefined, colorsArg = undefined) {
  const ctx = bunInspectNormalizeOptions(options, colorsArg);
  return bunStyleInspect(value, ctx, "", new Set(), 0);
}

inspect.table = function table(value, properties = undefined, options = undefined) {
  if (arguments.length === 0 || value == null) return "";
  if (typeof value !== "object" && typeof value !== "function") return "";
  const selectedProperties = Array.isArray(properties) ? properties : undefined;
  const tableOptions = (Array.isArray(properties) ? options : properties) ?? undefined;
  return renderTable(value, selectedProperties, tableOptions);
};

export function deepEquals(left, right) {
  return isDeepStrictEqual(left, right);
}

function deepMatchSubset(object, subset, objectSeen, subsetSeen) {
  if (Object.is(object, subset)) return true;
  if (object == null || subset == null || typeof object !== "object" || typeof subset !== "object") return false;
  if (objectSeen.has(object) || subsetSeen.has(subset)) return objectSeen.has(object) && subsetSeen.has(subset);
  objectSeen.add(object);
  subsetSeen.add(subset);
  if (Array.isArray(object) && Array.isArray(subset) && object.length !== subset.length) return false;
  for (const key of Reflect.ownKeys(subset)) {
    if (!Object.prototype.propertyIsEnumerable.call(subset, key)) continue;
    if (!(key in object) || !deepMatchSubset(object[key], subset[key], objectSeen, subsetSeen)) return false;
  }
  return true;
}

export function deepMatch(subset, object) {
  if (subset == null || object == null || typeof subset !== "object" || typeof object !== "object") {
    throw new TypeError("Expected 2 objects to match");
  }
  return deepMatchSubset(object, subset, new WeakSet(), new WeakSet());
}

export function escapeHTML(value, attribute = false) {
  const text = String(value);
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
  return escaped;
}

const stripANSIControlPattern = /[\x1b\x90\x98\x9b-\x9f]/;

export function stripANSI(value) {
  const text = String(value);
  const nativeStrip = globalThis.cottontail?.stripANSINative;
  if (typeof nativeStrip === "function") return nativeStrip(text);
  if (text.indexOf("\x1b") === -1 && text.indexOf("\x9b") === -1) {
    if (!stripANSIControlPattern.test(text)) return text;
  }
  const length = text.length;
  let out = "";
  let plainStart = 0;
  let index = 0;
  while (index < length) {
    const code = text.charCodeAt(index);
    if (!stripANSIIsControl(code)) {
      index += 1;
      continue;
    }
    out += text.slice(plainStart, index);
    const next = stripANSIConsume(text, index);
    if (next === index) {
      out += text[index];
      index += 1;
    } else index = next;
    plainStart = index;
  }
  return out + text.slice(plainStart);
}

function stripANSIIsControl(code) {
  return code === 0x1b ||
    code === 0x90 ||
    code === 0x98 ||
    (code >= 0x9b && code <= 0x9f);
}

function stripANSIConsume(text, start) {
  let state = 0;
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    switch (state) {
      case 0:
        if (code === 0x1b) state = 1;
        else if (code === 0x9b) state = 3;
        else if (code === 0x9d) state = 4;
        else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) state = 6;
        else return index;
        break;
      case 1:
        if (code === 0x5b) state = 3;
        else if (
          code === 0x20 || code === 0x23 || code === 0x25 ||
          code === 0x28 || code === 0x29 || code === 0x2a ||
          code === 0x2b || code === 0x2e || code === 0x2f
        ) state = 2;
        else if (code === 0x5d) state = 4;
        else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) state = 6;
        else state = 0;
        break;
      case 2:
        state = 0;
        break;
      case 3:
        if (code >= 0x40 && code <= 0x7e) state = 0;
        break;
      case 4:
        if (code === 0x07 || code === 0x9c) state = 0;
        else if (code === 0x1b) state = 5;
        break;
      case 5:
        state = code === 0x5c ? 0 : 4;
        break;
      case 6:
        if (code === 0x9c) state = 0;
        else if (code === 0x1b) state = 7;
        break;
      case 7:
        state = code === 0x5c ? 0 : 6;
        break;
    }
  }
  return text.length;
}

function isCombiningCodePoint(codePoint) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x0483 && codePoint <= 0x0489) ||
    (codePoint >= 0x0591 && codePoint <= 0x05bd) ||
    codePoint === 0x05bf ||
    (codePoint >= 0x05c1 && codePoint <= 0x05c2) ||
    (codePoint >= 0x05c4 && codePoint <= 0x05c5) ||
    codePoint === 0x05c7 ||
    (codePoint >= 0x0610 && codePoint <= 0x061a) ||
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    codePoint === 0x0670 ||
    (codePoint >= 0x06d6 && codePoint <= 0x06dc) ||
    (codePoint >= 0x06df && codePoint <= 0x06e4) ||
    (codePoint >= 0x06e7 && codePoint <= 0x06e8) ||
    (codePoint >= 0x06ea && codePoint <= 0x06ed) ||
    codePoint === 0x0711 ||
    (codePoint >= 0x0730 && codePoint <= 0x074a) ||
    (codePoint >= 0x07a6 && codePoint <= 0x07b0) ||
    (codePoint >= 0x07eb && codePoint <= 0x07f3) ||
    codePoint === 0x07fd ||
    (codePoint >= 0x0816 && codePoint <= 0x0819) ||
    (codePoint >= 0x081b && codePoint <= 0x0823) ||
    (codePoint >= 0x0825 && codePoint <= 0x0827) ||
    (codePoint >= 0x0829 && codePoint <= 0x082d) ||
    (codePoint >= 0x0859 && codePoint <= 0x085b) ||
    (codePoint >= 0x0898 && codePoint <= 0x089f) ||
    (codePoint >= 0x08ca && codePoint <= 0x0902) ||
    codePoint === 0x093c ||
    codePoint === 0x093f ||
    (codePoint >= 0x0941 && codePoint <= 0x0948) ||
    codePoint === 0x094d ||
    (codePoint >= 0x0951 && codePoint <= 0x0957) ||
    (codePoint >= 0x0962 && codePoint <= 0x0963) ||
    codePoint === 0x09bc ||
    (codePoint >= 0x09c1 && codePoint <= 0x09c4) ||
    codePoint === 0x09cd ||
    codePoint === 0x0bcd ||
    (codePoint >= 0x0c3e && codePoint <= 0x0c40) ||
    (codePoint >= 0x0c46 && codePoint <= 0x0c48) ||
    (codePoint >= 0x0c4a && codePoint <= 0x0c4d) ||
    (codePoint >= 0x0d41 && codePoint <= 0x0d44) ||
    codePoint === 0x0d4d ||
    codePoint === 0x0e31 ||
    (codePoint >= 0x0e34 && codePoint <= 0x0e3a) ||
    (codePoint >= 0x0e47 && codePoint <= 0x0e4e) ||
    codePoint === 0x0eb1 ||
    (codePoint >= 0x0eb4 && codePoint <= 0x0ebc) ||
    (codePoint >= 0x0ec8 && codePoint <= 0x0ecd) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isZeroWidthCodePoint(codePoint) {
  return (
    codePoint === 0x00ad ||
    codePoint === 0x034f ||
    codePoint === 0x061c ||
    (codePoint >= 0x0600 && codePoint <= 0x0605) ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    codePoint === 0x08e2 ||
    (codePoint >= 0x180b && codePoint <= 0x180f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) ||
    (codePoint >= 0x2066 && codePoint <= 0x206f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
    isCombiningCodePoint(codePoint)
  );
}

function isFullwidthCodePoint(codePoint) {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

function isRegionalIndicator(codePoint) {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isEmojiModifier(codePoint) {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isEmojiCodePoint(codePoint) {
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    codePoint === 0x231a ||
    codePoint === 0x231b ||
    codePoint === 0x2328 ||
    codePoint === 0x23cf
  );
}

function isEmojiVariationBase(codePoint) {
  return (
    codePoint === 0x00a9 ||
    codePoint === 0x00ae ||
    codePoint === 0x203c ||
    codePoint === 0x2049 ||
    codePoint === 0x2122 ||
    codePoint === 0x2139 ||
    (codePoint >= 0x2194 && codePoint <= 0x21aa) ||
    (codePoint >= 0x231a && codePoint <= 0x231b) ||
    codePoint === 0x2328 ||
    codePoint === 0x23cf ||
    (codePoint >= 0x23e9 && codePoint <= 0x23f3) ||
    (codePoint >= 0x23f8 && codePoint <= 0x23fa) ||
    codePoint === 0x24c2 ||
    (codePoint >= 0x25aa && codePoint <= 0x25ab) ||
    codePoint === 0x25b6 ||
    codePoint === 0x25c0 ||
    (codePoint >= 0x25fb && codePoint <= 0x25fe) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2934 && codePoint <= 0x2935) ||
    (codePoint >= 0x2b05 && codePoint <= 0x2b55) ||
    codePoint === 0x3030 ||
    codePoint === 0x303d ||
    codePoint === 0x3297 ||
    codePoint === 0x3299
  );
}

function isAmbiguousWideCodePoint(codePoint) {
  return codePoint === 0x00b1 || codePoint === 0x201c || codePoint === 0x2605 || codePoint === 0x26e3;
}

function codePointLength(codePoint) {
  return codePoint > 0xffff ? 2 : 1;
}

function skipAnsiSequence(text, index) {
  if (text.charCodeAt(index) !== 0x1b) return index;
  const next = text.charCodeAt(index + 1);
  if (next === 0x5b) {
    let cursor = index + 2;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) return cursor + 1;
      cursor += 1;
    }
    return text.length;
  }
  if (next === 0x5d) {
    let cursor = index + 2;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code === 0x07) return cursor + 1;
      if (code === 0x1b && text.charCodeAt(cursor + 1) === 0x5c) return cursor + 2;
      cursor += 1;
    }
    return text.length;
  }
  return index + 1;
}

function consumeEmojiSequence(text, index) {
  let cursor = index + codePointLength(text.codePointAt(index));
  for (;;) {
    let next = text.codePointAt(cursor);
    while (next === 0xfe0f || next === 0xfe0e || isEmojiModifier(next) || (next >= 0xe0000 && next <= 0xe007f)) {
      cursor += codePointLength(next);
      next = text.codePointAt(cursor);
    }
    if (next !== 0x200d) return cursor;
    const afterJoiner = text.codePointAt(cursor + 1);
    if (afterJoiner == null) return cursor + 1;
    cursor += 1 + codePointLength(afterJoiner);
  }
}

const STRING_WIDTH_NATIVE_MIN_LENGTH = 16;

export function stringWidth(value, options = undefined) {
  const text = String(value ?? "");
  const countAnsiEscapeCodes = options?.countAnsiEscapeCodes === true;
  const ambiguousIsNarrow = options?.ambiguousIsNarrow !== false;
  if (text.length >= STRING_WIDTH_NATIVE_MIN_LENGTH) {
    const nativeWidth = cottontail.stringWidthNative(text, countAnsiEscapeCodes, ambiguousIsNarrow);
    if (nativeWidth >= 0) return nativeWidth;
  }

  let width = 0;
  for (let index = 0; index < text.length;) {
    const ansiEnd = countAnsiEscapeCodes ? index : skipAnsiSequence(text, index);
    if (ansiEnd !== index) {
      index = ansiEnd;
      continue;
    }

    const codePoint = text.codePointAt(index);
    const length = codePointLength(codePoint);
    const next = text.codePointAt(index + length);
    const afterNext = text.codePointAt(index + length + codePointLength(next ?? 0));

    if (codePoint === 0x1b || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || isZeroWidthCodePoint(codePoint)) {
      index += length;
      continue;
    }

    if ((codePoint >= 0x30 && codePoint <= 0x39) || codePoint === 0x23 || codePoint === 0x2a) {
      if ((next === 0xfe0f && afterNext === 0x20e3) || next === 0x20e3) {
        width += 2;
        index += length + (next === 0xfe0f ? 2 : 1);
        continue;
      }
    }

    if (isRegionalIndicator(codePoint)) {
      let count = 0;
      while (isRegionalIndicator(text.codePointAt(index))) {
        count += 1;
        index += 2;
      }
      width += Math.floor(count / 2) * 2 + (count % 2);
      continue;
    }

    if (next === 0xfe0e && isEmojiVariationBase(codePoint)) {
      width += isFullwidthCodePoint(codePoint) ? 2 : 1;
      index += length + 1;
      continue;
    }

    if (isEmojiCodePoint(codePoint)) {
      width += 2;
      index = consumeEmojiSequence(text, index);
      continue;
    }

    if (next === 0xfe0f && isEmojiVariationBase(codePoint)) {
      width += 2;
      index += length + 1;
      continue;
    }

    width += isFullwidthCodePoint(codePoint) || (!ambiguousIsNarrow && isAmbiguousWideCodePoint(codePoint)) ? 2 : 1;
    index += length;
  }
  return width;
}

export function wrapAnsi(value, columns = 80, options = {}) {
  const input = String(value);
  const columnNumber = Number(columns);
  if (!Number.isFinite(columnNumber) || columnNumber <= 0 || input.length === 0) return input;
  const widthLimit = Math.max(1, Math.floor(columnNumber));
  const hard = options?.hard === true;
  const wordWrap = options?.wordWrap !== false;
  const trim = options?.trim !== false;
  const ambiguousIsNarrow = options?.ambiguousIsNarrow !== false;

  let output = "";
  let rowWidth = 0;
  let simpleForeground = null;
  let simpleBackground = null;
  let activeHyperlink = null;
  let rowForeground = null;
  let rowBackground = null;
  let rowHyperlink = null;
  let trailingAnsi = "";

  const trackSgr = (text) => {
    for (const match of text.matchAll(/\x1b\[([0-9;]*)m/g)) {
      const codes = (match[1] || "0").split(";").map(Number);
      for (const code of codes) {
        if (code === 0) {
          simpleForeground = null;
          simpleBackground = null;
        } else if (code === 39) simpleForeground = null;
        else if (code === 49) simpleBackground = null;
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) simpleForeground = code;
        else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) simpleBackground = code;
      }
    }
    for (const match of text.matchAll(/\x1b\]8;;([^\x07]*)\x07/g)) {
      activeHyperlink = match[1] ? `\x1b]8;;${match[1]}\x07` : null;
    }
  };
  const append = (text) => {
    for (const unit of units(text)) {
      output += unit;
      trackSgr(unit);
      const unitWidth = stringWidth(unit, { ambiguousIsNarrow });
      rowWidth += unitWidth;
      if (unitWidth > 0) {
        rowForeground = simpleForeground;
        rowBackground = simpleBackground;
        rowHyperlink = activeHyperlink;
        trailingAnsi = "";
      } else {
        trailingAnsi += unit;
      }
    }
  };
  const units = (text) => {
    const result = [];
    for (let index = 0; index < text.length;) {
      const ansiEnd = skipAnsiSequence(text, index);
      if (ansiEnd !== index) {
        result.push(text.slice(index, ansiEnd));
        index = ansiEnd;
        continue;
      }
      const codePoint = text.codePointAt(index);
      const length = codePointLength(codePoint);
      result.push(text.slice(index, index + length));
      index += length;
    }
    return result;
  };
  const trimUnits = (text, leading, trailing) => {
    const list = units(text);
    if (leading) {
      let sawContent = false;
      for (let index = 0; index < list.length; index += 1) {
        const unit = list[index];
        if (stringWidth(unit, { ambiguousIsNarrow }) === 0) continue;
        if (!sawContent && /^[ \t]$/.test(unit)) {
          list[index] = "";
          continue;
        }
        sawContent = true;
      }
    }
    if (trailing) {
      let sawContent = false;
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const unit = list[index];
        if (stringWidth(unit, { ambiguousIsNarrow }) === 0) continue;
        if (!sawContent && /^[ \t]$/.test(unit)) {
          list[index] = "";
          continue;
        }
        sawContent = true;
      }
    }
    return list.join("");
  };
  const trimCurrentRowEnd = () => {
    const rowStart = output.lastIndexOf("\n") + 1;
    output = output.slice(0, rowStart) + trimUnits(output.slice(rowStart), false, true);
  };
  const breakLine = () => {
    if (trim) trimCurrentRowEnd();
    const preserveTrailingState = !wordWrap && trailingAnsi.length > 0;
    const breakForeground = preserveTrailingState ? rowForeground : simpleForeground;
    const breakBackground = preserveTrailingState ? rowBackground : simpleBackground;
    const breakHyperlink = preserveTrailingState ? rowHyperlink : activeHyperlink;
    const closeLink = activeHyperlink ? "\x1b]8;;\x07" : "";
    const closeForeground = simpleForeground == null ? "" : "\x1b[39m";
    const closeBackground = simpleBackground == null ? "" : "\x1b[49m";
    const reopenBackground = breakBackground == null ? "" : `\x1b[${breakBackground}m`;
    const reopenForeground = breakForeground == null ? "" : `\x1b[${breakForeground}m`;
    const reopenLink = breakHyperlink ?? "";
    const repeatTrailing = preserveTrailingState && (breakForeground !== simpleForeground || breakBackground !== simpleBackground || breakHyperlink !== activeHyperlink)
      ? trailingAnsi
      : "";
    output += `${closeLink}${closeForeground}${closeBackground}\n${reopenBackground}${reopenForeground}${reopenLink}${repeatTrailing}`;
    rowWidth = 0;
    rowForeground = simpleForeground;
    rowBackground = simpleBackground;
    rowHyperlink = activeHyperlink;
    trailingAnsi = repeatTrailing;
  };
  const appendHard = (word) => {
    for (const unit of units(word)) {
      const unitWidth = stringWidth(unit, { ambiguousIsNarrow });
      if (unitWidth > 0 && rowWidth > 0 && rowWidth + unitWidth > widthLimit) breakLine();
      append(unit);
    }
  };
  const appendCharacterWrapped = (line) => {
    const source = trim ? trimUnits(line, true, true) : line;
    for (const unit of units(source)) {
      const unitWidth = stringWidth(unit, { ambiguousIsNarrow });
      if (unitWidth > 0 && rowWidth > 0 && rowWidth + unitWidth > widthLimit) breakLine();
      if (trim && rowWidth === 0 && /^[ \t]$/.test(unit)) continue;
      append(unit);
    }
    if (trim) trimCurrentRowEnd();
  };
  const appendLine = (line) => {
    const source = trim ? trimUnits(line, true, true) : line;
    if (stringWidth(source, { ambiguousIsNarrow }) <= widthLimit) {
      append(source);
      return;
    }
    const pieces = source.split(/([ \t]+)/);
    let pendingSpace = "";
    for (const piece of pieces) {
      if (!piece) continue;
      if (/^[ \t]+$/.test(piece)) {
        pendingSpace += piece;
        continue;
      }
      const wordWidth = stringWidth(piece, { ambiguousIsNarrow });
      const space = pendingSpace;
      const spaceWidth = stringWidth(space, { ambiguousIsNarrow });
      pendingSpace = "";

      if (rowWidth > 0 && rowWidth + spaceWidth + wordWidth > widthLimit) {
        if (hard && wordWidth > widthLimit && !/\x1b/.test(piece)) {
          if (space && rowWidth + spaceWidth <= widthLimit) append(space);
          appendHard(piece);
          continue;
        }
        if (!trim && space && rowWidth + spaceWidth <= widthLimit) {
          append(space);
          breakLine();
        } else {
          breakLine();
          if (!trim && space) {
            appendHard(space);
            if (rowWidth > 0 && rowWidth + wordWidth > widthLimit) breakLine();
          }
        }
      } else if (space) {
        append(space);
      }

      if (hard && wordWidth > widthLimit - rowWidth) appendHard(piece);
      else append(piece);
    }
    if (!trim && pendingSpace) appendHard(pendingSpace);
  };

  const lines = input.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) breakLine();
    if (wordWrap) appendLine(lines[index]);
    else appendCharacterWrapped(lines[index]);
  }
  return output;
}

const nativeIndexOfLine = globalThis.cottontail?.bufferIndexOfLine;
const nativeIndexOfLineThreshold = 256 * 1_024;
const jscIndexOfLineThreshold = 128;
const typedArrayIndexOf = Uint8Array.prototype.indexOf;
const indexOfLineTypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const indexOfLineTypedArrayBufferGetter = Object.getOwnPropertyDescriptor(
  indexOfLineTypedArrayPrototype,
  "buffer",
)?.get;
const indexOfLineTypedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  indexOfLineTypedArrayPrototype,
  "byteLength",
)?.get;

function indexOfLineJSTail(bytes, index) {
  for (; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 10) return index;
  }
  return -1;
}

function indexOfLineTail(bytes, index, byteLength) {
  if (
    !ArrayBuffer.isView(bytes) ||
    typeof indexOfLineTypedArrayByteLengthGetter !== "function"
  ) {
    return indexOfLineJSTail(bytes, index);
  }

  let actualByteLength;
  try {
    actualByteLength = indexOfLineTypedArrayByteLengthGetter.call(bytes);
  } catch {
    return indexOfLineJSTail(bytes, index);
  }

  // An own byteLength getter can detach the view after reporting a length.
  if (actualByteLength === 0 && byteLength > 0) return -1;

  // An overridden shorter byteLength is observable in the original loop.
  if (byteLength < actualByteLength) return indexOfLineJSTail(bytes, index);

  const scanEnd = Math.min(byteLength, actualByteLength);
  const hasSharedStorage =
    typeof SharedArrayBuffer === "function" &&
    typeof indexOfLineTypedArrayBufferGetter === "function" &&
    indexOfLineTypedArrayBufferGetter.call(bytes) instanceof SharedArrayBuffer;
  if (
    !hasSharedStorage &&
    typeof nativeIndexOfLine === "function" &&
    scanEnd - index >= nativeIndexOfLineThreshold
  ) {
    return nativeIndexOfLine(bytes, index, byteLength);
  }
  return typedArrayIndexOf.call(bytes, 10, index);
}

export function indexOfLine(value, offset = 0) {
  const bytes = asBuffer(value);
  const startNumber = Number(offset);
  const start = Number.isFinite(startNumber) ? Math.max(0, Math.trunc(startNumber)) : 0;
  let index = start;
  const byteLength = bytes.byteLength;
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength - start < jscIndexOfLineThreshold
  ) {
    return indexOfLineJSTail(bytes, index);
  }

  const earlyEnd = Math.min(byteLength, start + 2);
  for (; index < earlyEnd; index += 1) {
    if (bytes[index] === 10) return index;
  }
  return indexOfLineTail(bytes, index, byteLength);
}

export function fileURLToPath(value) {
  return nodeFileURLToPath(value);
}

export function pathToFileURL(value) {
  return nodePathToFileURL(String(value));
}

function missingResolveArguments() {
  const error = new TypeError("Expected a specifier and a from path");
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

export function resolveSync(specifier, from = cottontail.cwd()) {
  if (arguments.length === 0) throw missingResolveArguments();
  const text = String(specifier);

  let base = String(from ?? cottontail.cwd());
  if (base.startsWith("file:")) base = nodeFileURLToPath(base);
  try {
    if (cottontail.statSync(base, true)?.isDirectory) base = pathJoin(base, "package.json");
  } catch {}

  const resolved = nodeResolveForImport(text, base);
  if (resolved.startsWith("node:") || resolved.startsWith("bun:")) return resolved;
  if (nodeIsBuiltin(resolved)) return resolved === "bun" ? resolved : `node:${resolved}`;
  return resolved;
}

export function resolve(specifier, from = cottontail.cwd()) {
  if (arguments.length === 0) return Promise.reject(missingResolveArguments());
  return Promise.resolve(resolveSync(specifier, from));
}

export function sha(value) {
  return createHash("sha256").update(asBuffer(value)).digest();
}

function bunHashValue(algorithm, value, seed = 0n) {
  return BigInt(cottontail.hashValue(algorithm, asBuffer(value), String(seed ?? 0)));
}

const hash64Function = (algorithm) => function (value = "", seed = 0n) {
  if (new.target) throw new TypeError("species is not a constructor");
  return bunHashValue(algorithm, value, seed);
};
const hash32Function = (algorithm) => function (value = "", seed = 0) {
  if (new.target) throw new TypeError("species is not a constructor");
  return Number(bunHashValue(algorithm, value, seed)) >>> 0;
};

export const hash = Object.assign(hash64Function(0), {
  wyhash: hash64Function(0),
  adler32: hash32Function(1),
  crc32: hash32Function(2),
  cityHash32: hash32Function(3),
  cityHash64: hash64Function(4),
  xxHash32: hash32Function(5),
  xxHash64: hash64Function(6),
  xxHash3: hash64Function(7),
  murmur32v3: hash32Function(8),
  murmur32v2: hash32Function(9),
  murmur64v2: hash64Function(10),
  rapidhash: hash64Function(11),
});

const uuidEncodingCodes = {
  hex: 0,
  buffer: 1,
  base64: 2,
  base64url: 3,
};

const uuidv5Namespaces = {
  dns: new Uint8Array([0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]),
  url: new Uint8Array([0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]),
  oid: new Uint8Array([0x6b, 0xa7, 0xb8, 0x12, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]),
  x500: new Uint8Array([0x6b, 0xa7, 0xb8, 0x14, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]),
};

function uuidError(ErrorType, code, message) {
  const error = new ErrorType(message);
  error.code = code;
  return error;
}

function uuidString(value) {
  if (typeof value === "string") return value;
  if (value == null || typeof value !== "object") return null;
  try {
    return String.prototype.valueOf.call(value);
  } catch {
    return null;
  }
}

function uuidEncoding(value) {
  const string = uuidString(value);
  if (string == null) return uuidEncodingCodes.hex;
  const encoding = uuidEncodingCodes[string.toLowerCase()];
  if (encoding === undefined) {
    throw uuidError(
      TypeError,
      "ERR_UNKNOWN_ENCODING",
      "Encoding must be one of base64, base64url, hex, or buffer",
    );
  }
  return encoding;
}

function uuidNativeResult(result, encoding) {
  return encoding === uuidEncodingCodes.buffer
    ? globalThis.Buffer.from(result)
    : result;
}

function uuidBufferSource(value) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return asBuffer(value);
  if (typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer) {
    return asBuffer(value);
  }
  return null;
}

function uuidv7Timestamp(value) {
  if (value != null && typeof value === "object") {
    try {
      const timestamp = Date.prototype.getTime.call(value);
      return Number.isNaN(timestamp) ? 0 : Math.max(0, timestamp);
    } catch {}
  }
  if (typeof value !== "number") {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "timestamp" property must be of type number. Received ${typeof value}`,
    );
  }
  if (Number.isNaN(value)) return 0;
  if (value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw uuidError(
      RangeError,
      "ERR_OUT_OF_RANGE",
      `The value of "timestamp" is out of range. It must be >= 0 and <= 9007199254740991. Received ${String(value)}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      'The "timestamp" property must be of type integer. Received number',
    );
  }
  return value;
}

export function randomUUIDv7(encodingOrTimestamp = undefined, timestampInput = undefined) {
  const encodingString = uuidString(encodingOrTimestamp);
  const encoding = encodingString == null
    ? uuidEncodingCodes.hex
    : uuidEncoding(encodingString);
  const timestampValue = encodingString != null && arguments.length > 1
    ? timestampInput
    : arguments.length === 1 && encodingString == null
      ? encodingOrTimestamp
      : undefined;
  const timestamp = timestampValue === undefined
    ? Date.now()
    : uuidv7Timestamp(timestampValue);
  return uuidNativeResult(
    cottontail.randomUUIDv7Native(timestamp, encoding),
    encoding,
  );
}

function uuidv5NamespaceBytes(namespace) {
  const bufferSource = uuidBufferSource(namespace);
  if (bufferSource != null) {
    const bytes = bufferSource;
    if (bytes.byteLength !== 16) {
      throw uuidError(
        TypeError,
        "ERR_INVALID_ARG_VALUE",
        "Namespace must be exactly 16 bytes",
      );
    }
    return bytes;
  }

  const string = uuidString(namespace);
  if (string == null) {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      'The "namespace" argument must be a string or buffer',
    );
  }
  const alias = uuidv5Namespaces[string.toLowerCase()];
  if (alias) return alias;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(string)) {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_VALUE",
      "Invalid UUID format for namespace",
    );
  }
  const compact = string.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function randomUUIDv5(name, namespace, encodingValue = undefined) {
  if (arguments.length === 0 || name == null) {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      'The "name" argument must be specified',
    );
  }
  if (arguments.length < 2 || namespace == null) {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      'The "namespace" argument must be specified',
    );
  }

  const nameString = uuidString(name);
  const nameValue = nameString ?? uuidBufferSource(name);
  if (nameValue == null) {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      'The "name" argument must be of type string or BufferSource',
    );
  }

  const encoding = uuidEncoding(encodingValue);
  const result = cottontail.randomUUIDv5Native(
    nameValue,
    uuidv5NamespaceBytes(namespace),
    encoding,
  );
  return uuidNativeResult(result, encoding);
}

export function readableStreamToArray(stream) {
  return newInternalPromise((resolve, reject) => {
    const chunks = [];
    const reader = typeof stream?.getReader === "function" ? stream.getReader() : null;
    if (reader) {
      const finish = (value, error = undefined) => {
        try {
          reader.releaseLock?.();
        } catch {}
        if (error) reject(error);
        else resolve(value);
      };
      const pump = () => {
        let readResult;
        try {
          readResult = reader.read();
        } catch (error) {
          finish(undefined, error);
          return;
        }
        internalThen(readResult, (item) => {
          try {
            if (item.done) {
              finish(chunks);
              return;
            }
            chunks.push(item.value);
            pump();
          } catch (error) {
            finish(undefined, error);
          }
        }, (error) => finish(undefined, error));
      };
      pump();
      return;
    }

    if (typeof stream?.[Symbol.asyncIterator] === "function") {
      const iterator = stream[Symbol.asyncIterator]();
      const pump = () => {
        let nextResult;
        try {
          nextResult = iterator.next();
        } catch (error) {
          reject(error);
          return;
        }
        internalThen(nextResult, (item) => {
          try {
            if (item.done) {
              resolve(chunks);
              return;
            }
            chunks.push(item.value);
            pump();
          } catch (error) {
            reject(error);
          }
        }, reject);
      };
      pump();
      return;
    }

    resolve(chunks);
  });
}

const blobStreamSources = globalThis.__cottontailBlobStreamSources;

function consumeBlobStreamFastPath(stream) {
  const source = blobStreamSources?.get(stream);
  if (!source || source.bytes.byteLength === 0 || stream.locked || stream._disturbed === true) return null;

  blobStreamSources.delete(stream);
  const reader = stream.getReader();
  reader.read();
  reader.read();
  reader.releaseLock();
  return source;
}

export function readableStreamToBytes(stream) {
  const source = consumeBlobStreamFastPath(stream);
  if (source) return Promise.resolve(source.bytes.slice());
  return internalThen(readableStreamToArray(stream), (chunks) => concatManyBuffers(chunks));
}

export function readableStreamToArrayBuffer(stream) {
  const source = consumeBlobStreamFastPath(stream);
  if (source) return Promise.resolve(source.bytes.slice().buffer);
  suppressUserPromiseThenForInternalAwait();
  return internalThen(readableStreamToBytes(stream), (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function readableStreamToText(stream) {
  const source = consumeBlobStreamFastPath(stream);
  if (source) return Promise.resolve(stripUtf8BOMText(new TextDecoder().decode(source.bytes)));
  return internalThen(readableStreamToBytes(stream), (bytes) => stripUtf8BOMText(new TextDecoder().decode(bytes)));
}

export function readableStreamToJSON(stream) {
  return internalThen(readableStreamToText(stream), (text) => JSON.parse(text));
}

export function readableStreamToBlob(stream) {
  const source = consumeBlobStreamFastPath(stream);
  if (source) return Promise.resolve(new Blob([source.bytes], { type: source.type }));
  return internalThen(readableStreamToArrayBuffer(stream), (buffer) => new Blob([buffer]));
}

function invalidReadableStreamThis(method) {
  const error = new TypeError(`ReadableStream.prototype.${method} called on incompatible receiver`);
  error.code = "ERR_INVALID_THIS";
  return error;
}

function assertReadableStreamThis(stream, method) {
  if (!stream || typeof stream.getReader !== "function") throw invalidReadableStreamThis(method);
}

function installReadableStreamConversionHelpers() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "ReadableStream");
  if (descriptor && typeof descriptor.get === "function" && !("value" in descriptor)) return;
  const prototype = (descriptor && "value" in descriptor ? descriptor.value : globalThis.ReadableStream)?.prototype;
  if (!prototype) return;
  Object.defineProperties(prototype, {
    bytes: {
      value: function bytes() {
        assertReadableStreamThis(this, "bytes");
        return readableStreamToBytes(this);
      },
      writable: true,
      configurable: true,
    },
    blob: {
      value: function blob() {
        assertReadableStreamThis(this, "blob");
        return readableStreamToBlob(this);
      },
      writable: true,
      configurable: true,
    },
    text: {
      value: function text() {
        assertReadableStreamThis(this, "text");
        return readableStreamToText(this);
      },
      writable: true,
      configurable: true,
    },
    json: {
      value: function json() {
        assertReadableStreamThis(this, "json");
        return readableStreamToJSON(this);
      },
      writable: true,
      configurable: true,
    },
  });
}

export function readableStreamToFormData(stream, boundaryOrFormData = undefined) {
  if (typeof boundaryOrFormData === "string" || boundaryOrFormData instanceof ArrayBuffer || ArrayBuffer.isView(boundaryOrFormData)) {
    const boundary = typeof boundaryOrFormData === "string"
      ? boundaryOrFormData
      : new TextDecoder().decode(asBuffer(boundaryOrFormData));
    return internalThen(readableStreamToBytes(stream), (bytes) =>
      parseMultipartFormDataText(stringLatin1FromBytes(bytes), boundary));
  }
  const formData = boundaryOrFormData ?? new FormData();
  return internalThen(readableStreamToText(stream), (text) => {
    for (const [key, value] of new URLSearchParams(stripUtf8BOMText(text))) {
      formData.append(key, value);
    }
    return formData;
  });
}

export function generateHeapSnapshot(format = undefined, output = undefined) {
  let useV8 = false;
  if (typeof format === "string") {
    if (format === "v8") useV8 = true;
    else if (format !== "jsc") throw new TypeError("Expected 'v8' or 'jsc' or undefined");
  }

  if (useV8 && typeof output === "string" && output !== "arraybuffer") {
    throw new TypeError("Expected 'arraybuffer' or undefined as second argument");
  }

  const snapshot = useV8
    ? captureV8HeapSnapshot()
    : cottontail.jscHeapSnapshot?.() ?? "";

  if (useV8 && output === "arraybuffer") {
    const bytes = new TextEncoder().encode(snapshot);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  if (useV8) return snapshot;
  return loadBunJSCModule().accountForExternallyAllocatedMemory(JSON.parse(snapshot));
}

function outputAnsiColorsEnabled() {
  const env = globalThis.process?.env;
  if (env?.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  if (env?.NO_COLOR !== undefined || env?.NODE_DISABLE_COLORS !== undefined) return false;
  return Boolean(globalThis.process?.stderr?.isTTY);
}

export const enableANSIColors = outputAnsiColorsEnabled();

export function shrink() {
  bunForceGc();
}

function isPromiseForPeek(value) {
  return value != null && typeof value === "object" && Promise.prototype.isPrototypeOf(value);
}

export function peek(value) {
  if (!isPromiseForPeek(value)) return value;
  const nativeStatus = cottontail.promiseStatus?.(value);
  if (nativeStatus === 1 || nativeStatus === 2) return cottontail.promiseResult(value);
  const state = promisePeekStates.get(value);
  if (!state) return value;
  return state.value;
}

peek.status = function(value) {
  if (!isPromiseForPeek(value)) return "fulfilled";
  const nativeStatus = cottontail.promiseStatus?.(value);
  if (nativeStatus === 1) return "fulfilled";
  if (nativeStatus === 2) return "rejected";
  return promisePeekStates.get(value)?.status ?? "pending";
};

export function mmap(path, options = undefined) {
  if (typeof path !== "string") throw new TypeError("Expected a path");
  if (options != null && typeof options !== "object") throw new TypeError("Expected options to be an object");
  const offset = options?.offset === undefined ? 0 : Math.trunc(Number(options.offset));
  if (!Number.isFinite(offset) || offset < 0) throw new TypeError("offset must be a non-negative integer");
  const hasSize = options != null && options.size !== undefined;
  const size = hasSize ? Math.trunc(Number(options.size)) : -1;
  if (!Number.isFinite(size) || (hasSize && size < 0)) throw new TypeError("size must be a non-negative integer");
  try {
    return new Uint8Array(cottontail.mmapFile(path, offset, size, options?.shared !== false));
  } catch (error) {
    if (hasSize && size === 0) throw new Error("EINVAL: Invalid argument");
    throw error;
  }
}

export function openInEditor(path) {
  if (arguments.length === 0 || path === undefined || path === null || String(path).length === 0) {
    throw new Error("No file path specified");
  }
  return spawn(["open", String(path)], { stdout: "ignore", stderr: "ignore" });
}

export function udpSocket(options) {
  if (arguments.length === 0) throw new TypeError("Missing argument");
  if (options == null || typeof options !== "object") throw new TypeError("udpSocket options must be an object");
  return createUdpSocket(options);
}

async function createUdpSocket(options) {
  const dgram = await import("../node/dgram.js");
  const requestedHostname = String(options.hostname ?? (String(options.connect?.hostname ?? "").includes(":") ? "::" : "0.0.0.0"));
  const type = options.type ?? (requestedHostname.includes(":") ? "udp6" : "udp4");
  const socket = dgram.createSocket(type);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      socket.removeListener("error", onError);
      resolve();
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind({ port: Number(options.port ?? 0), address: requestedHostname });
  });

  if (options.connect != null) {
    if (typeof options.connect !== "object") {
      socket.close();
      throw new TypeError("connect must be an object");
    }
    // dgram connect is asynchronous (DNS lookup): a failure arrives as an
    // 'error' event, which must reject this promise instead of going
    // unhandled (udp_socket "connect with invalid hostname rejects").
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        socket.removeListener("connect", onConnect);
        socket.close();
        reject(error);
      };
      const onConnect = () => {
        socket.removeListener("error", onError);
        resolve();
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
      try {
        socket.connect(Number(options.connect.port), String(options.connect.hostname ?? (type === "udp6" ? "::1" : "127.0.0.1")));
      } catch (error) {
        socket.removeListener("error", onError);
        socket.removeListener("connect", onConnect);
        socket.close();
        reject(error);
      }
    });
  }

  const nativeAddress = socket.address();
  const binaryType = options.binaryType ?? "buffer";
  if (!["buffer", "uint8array", "arraybuffer"].includes(binaryType)) {
    socket.close();
    throw new TypeError("binaryType must be buffer, uint8array, or arraybuffer");
  }
  const address = Object.freeze({
    address: requestedHostname,
    family: type === "udp6" ? "IPv6" : "IPv4",
    port: Number(nativeAddress.port),
  });
  const result = {
    hostname: requestedHostname,
    port: address.port,
    address,
    binaryType,
    get closed() { return socket.closed; },
    ref() {
      socket.ref();
      return result;
    },
    unref() {
      socket.unref();
      return result;
    },
    send(data, port = undefined, hostname = undefined) {
      if (socket.closed) return false;
      if (socket.remote) socket.send(data);
      else socket.send(data, Number(port), String(hostname ?? "127.0.0.1"));
      return true;
    },
    sendMany(payloads) {
      if (!Array.isArray(payloads)) throw new TypeError("sendMany expects an array");
      let count = 0;
      if (socket.remote) {
        for (const data of payloads) {
          if (!result.send(data)) break;
          count += 1;
        }
      } else {
        if (payloads.length % 3 !== 0) throw new TypeError("Unconnected sendMany expects data, port, hostname triples");
        for (let index = 0; index < payloads.length; index += 3) {
          if (!result.send(payloads[index], payloads[index + 1], payloads[index + 2])) break;
          count += 1;
        }
      }
      return count;
    },
    close() {
      socket.close();
    },
    [Symbol.dispose]() {
      socket.close();
    },
    [Symbol.asyncDispose]() {
      socket.close();
      return Promise.resolve();
    },
  };

  if (typeof options.socket?.data === "function") {
    socket.on("message", (data, rinfo) => {
      let converted = data;
      if (binaryType === "uint8array") converted = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (binaryType === "arraybuffer") converted = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      options.socket.data(result, converted, Number(rinfo.port), String(rinfo.address));
    });
  }
  if (typeof options.socket?.error === "function") socket.on("error", (error) => options.socket.error(result, error));
  return result;
}

export function registerMacro(_name, _macro = undefined) {
  return undefined;
}

export const deflateSync = (...args) => zlib.deflateSync(...args);
export const gzipSync = (...args) => zlib.gzipSync(...args);
export const gunzipSync = (...args) => zlib.gunzipSync(...args);
export const inflateSync = (...args) => zlib.inflateSync(...args);
export const zstdCompressSync = (...args) => zlib.zstdCompressSync(...args);
export const zstdDecompressSync = (...args) => zlib.zstdDecompressSync(...args);
export function zstdCompress(data, options = undefined) {
  return Promise.resolve(zstdCompressSync(data, options));
}
export function zstdDecompress(data, options = undefined) {
  return Promise.resolve(zstdDecompressSync(data, options));
}
export { FFI };

function jsonTextInput(value) {
  if (value == null) throw new TypeError("Expected a string or typed array");
  if (typeof value === "string") return value;
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > 512 * 1024 * 1024) throw new RangeError("Input is too large");
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > 512 * 1024 * 1024) throw new RangeError("Input is too large");
    return new TextDecoder().decode(new Uint8Array(value));
  }
  return String(value);
}

function stripJSONCCommentsAndTrailingCommas(source) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      index -= 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      if (index < source.length) index += 1;
      continue;
    }
    out += char;
  }

  source = out;
  out = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let cursor = index + 1;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      if (source[cursor] === "}" || source[cursor] === "]") continue;
    }
    out += char;
  }
  return out;
}

function assertJSONNestingWithinLimit(source, limit) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{" || char === "[") {
      depth += 1;
      if (depth > limit) throw new RangeError("Maximum JSON nesting depth exceeded");
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
  }
}

function isJSONWhitespace(char) {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function isJSONDelimiter(char) {
  return char === undefined || isJSONWhitespace(char);
}

function scanJSONString(source, start) {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") return { status: "complete", end: index + 1 };
    if (char < " ") return { status: "invalid" };
  }
  return { status: "incomplete" };
}

function scanJSONComposite(source, start) {
  const stack = [source[start]];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      else if (char < " ") return { status: "invalid" };
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "\n" || char === "\r") return { status: "invalid" };
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const open = stack.pop();
      if ((char === "}" && open !== "{") || (char === "]" && open !== "[")) return { status: "invalid" };
      if (stack.length === 0) return { status: "complete", end: index + 1 };
    }
  }
  return { status: "incomplete" };
}

function scanJSONLiteral(source, start, literal) {
  const remaining = source.length - start;
  if (remaining < literal.length && literal.startsWith(source.slice(start))) return { status: "incomplete" };
  if (source.slice(start, start + literal.length) !== literal) return { status: "invalid" };
  const end = start + literal.length;
  if (!isJSONDelimiter(source[end])) return { status: "invalid" };
  return { status: "complete", end };
}

function scanJSONNumber(source, start) {
  let end = start;
  while (end < source.length && !isJSONWhitespace(source[end])) end += 1;
  const token = source.slice(start, end);
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return { status: "complete", end };
  if (end === source.length && /^-?(?:0|[1-9]\d*)?(?:\.\d*)?(?:[eE][+-]?)?$/.test(token)) return { status: "incomplete" };
  return { status: "invalid" };
}

function scanJSONValue(source, start) {
  const char = source[start];
  if (char === undefined) return { status: "incomplete" };
  if (char === "\"") return scanJSONString(source, start);
  if (char === "{" || char === "[") return scanJSONComposite(source, start);
  if (char === "t") return scanJSONLiteral(source, start, "true");
  if (char === "f") return scanJSONLiteral(source, start, "false");
  if (char === "n") return scanJSONLiteral(source, start, "null");
  if (char === "-" || (char >= "0" && char <= "9")) return scanJSONNumber(source, start);
  return { status: "invalid" };
}

function parseJSONLString(source) {
  const values = [];
  let position = 0;
  let read = 0;
  if (source.charCodeAt(0) === 0xfeff) position = 1;
  for (;;) {
    while (position < source.length && isJSONWhitespace(source[position])) position += 1;
    if (position >= source.length) return { values, read, done: true, error: null };

    const scan = scanJSONValue(source, position);
    if (scan.status === "incomplete") return { values, read, done: false, error: null };
    if (scan.status === "invalid") return { values, read, done: false, error: new SyntaxError("Invalid JSONL input") };

    const raw = source.slice(position, scan.end);
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { values, read, done: false, error };
    }

    values.push(value);
    read = scan.end;

    let cursor = scan.end;
    while (cursor < source.length && (source[cursor] === " " || source[cursor] === "\t")) cursor += 1;
    if (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") {
      return { values, read, done: false, error: new SyntaxError("Invalid JSONL input") };
    }

    position = cursor;
    while (position < source.length && (source[position] === "\n" || source[position] === "\r")) position += 1;
  }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;

function appendCodePoint(out, codePoint) {
  if (codePoint <= 0xffff) return out + String.fromCharCode(codePoint);
  codePoint -= 0x10000;
  return out + String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
}

function decodeJSONLUtf8(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    if (first < 0x80) {
      out += String.fromCharCode(first);
      index += 1;
      continue;
    }

    let codePoint = 0xfffd;
    let width = 1;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const fourth = bytes[index + 3];
    if (first >= 0xc2 && first <= 0xdf && second >= 0x80 && second <= 0xbf) {
      codePoint = ((first & 0x1f) << 6) | (second & 0x3f);
      width = 2;
    } else if (
      first === 0xe0 && second >= 0xa0 && second <= 0xbf && third >= 0x80 && third <= 0xbf
    ) {
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = 3;
    } else if (
      first >= 0xe1 && first <= 0xec && second >= 0x80 && second <= 0xbf && third >= 0x80 && third <= 0xbf
    ) {
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = 3;
    } else if (
      first === 0xed && second >= 0x80 && second <= 0x9f && third >= 0x80 && third <= 0xbf
    ) {
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = 3;
    } else if (
      first >= 0xee && first <= 0xef && second >= 0x80 && second <= 0xbf && third >= 0x80 && third <= 0xbf
    ) {
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = 3;
    } else if (
      first === 0xf0 && second >= 0x90 && second <= 0xbf && third >= 0x80 && third <= 0xbf &&
      fourth >= 0x80 && fourth <= 0xbf
    ) {
      codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      width = 4;
    } else if (
      first >= 0xf1 && first <= 0xf3 && second >= 0x80 && second <= 0xbf && third >= 0x80 && third <= 0xbf &&
      fourth >= 0x80 && fourth <= 0xbf
    ) {
      codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      width = 4;
    } else if (
      first === 0xf4 && second >= 0x80 && second <= 0x8f && third >= 0x80 && third <= 0xbf &&
      fourth >= 0x80 && fourth <= 0xbf
    ) {
      codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      width = 4;
    }

    out = appendCodePoint(out, codePoint);
    index += width;
  }
  return out;
}

function jsonlTypedArrayView(input, start, end) {
  if (input == null) throw new TypeError("Expected a string or typed array");
  if (!ArrayBuffer.isView(input) || input instanceof DataView) return null;
  if (input.buffer?.detached === true) {
    throw new TypeError("Cannot parse a detached ArrayBuffer");
  }

  const byteLength = typedArrayByteLength.call(input);
  const byteOffset = typedArrayByteOffset.call(input);
  if (byteLength > 512 * 1024 * 1024) throw new RangeError("Input is too large");
  let byteStart = Math.min(Math.max(Number(start) || 0, 0), byteLength);
  const byteEnd = end === undefined ? byteLength : Math.min(Math.max(Number(end) || 0, 0), byteLength);
  if (byteEnd < byteStart) byteStart = byteEnd;
  const viewEnd = byteEnd;
  let view = new Uint8Array(input.buffer, byteOffset + byteStart, viewEnd - byteStart);
  let bomLength = 0;
  if (byteStart === 0 && view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
    view = view.subarray(3);
    bomLength = 3;
  }
  return { view, byteStart, bomLength };
}

function parseJSONLChunk(input, start = 0, end = undefined) {
  const typed = jsonlTypedArrayView(input, start, end);
  if (typed) {
    const source = decodeJSONLUtf8(typed.view);
    const result = parseJSONLString(source);
    const readBytes = new TextEncoder().encode(source.slice(0, result.read)).byteLength;
    return {
      values: result.values,
      read: typed.byteStart + typed.bomLength + readBytes,
      done: result.done,
      error: result.error,
    };
  }
  const result = parseJSONLString(jsonTextInput(input));
  return {
    values: result.values,
    read: result.read,
    done: result.done,
    error: result.error,
  };
}

export const JSONC = {
  parse(text) {
    const source = stripJSONCCommentsAndTrailingCommas(jsonTextInput(text));
    assertJSONNestingWithinLimit(source, 10_000);
    return JSON.parse(source);
  },
};

export const JSONL = {
  [Symbol.toStringTag]: "JSONL",
  parse(input) {
    const result = parseJSONLChunk(input);
    if (result.error && result.values.length === 0) throw result.error;
    return result.values;
  },
  parseChunk(input, start = 0, end = undefined) {
    return parseJSONLChunk(input, start, end);
  },
};

let Cookie;
let CookieMap;
({ Cookie, CookieMap } = createCookieRuntime(nodeInspect));
export { Cookie, CookieMap };

export class Glob {
  constructor(pattern) {
    this.pattern = String(pattern);
    const compiledPattern = normalizeGlobCharacterClasses(normalizeGlobSeparators(this.pattern));
    const nativeCompile = globalThis.cottontail?.globCompileNative;
    this._nativeMatcher =
      typeof nativeCompile === "function" && shouldUseNativeGlobMatcher(compiledPattern)
        ? nativeCompile(compiledPattern)
        : null;
    if (this._nativeMatcher) return;
    installGlobJsMatchers(this, compiledPattern);
  }
  match(value) {
    if (typeof value !== "string") throw new TypeError("Glob.match expects a string");
    const text = normalizeGlobSeparators(value);
    if (this._nativeMatcher) return this._nativeMatcher(text);
    if (text === "" && this._matchesEmpty) return true;
    for (const { matcher, trailingGlobstarBase } of this._matchers) {
      if (trailingGlobstarBase !== null && text === trailingGlobstarBase && trailingGlobstarBase !== "") continue;
      if (matcher(text)) return true;
      if (trailingGlobstarBase !== null && !hasGlobMeta(trailingGlobstarBase)) {
        const prefix = `${trailingGlobstarBase}/`;
        if (text === prefix || text.startsWith(prefix)) return true;
      }
    }
    return false;
  }
  scanSync(options = {}) {
    options = normalizeGlobScanOptions(options);
    const cwd = nodePathResolve(String(options.cwd ?? options.root ?? cottontail.cwd()));
    const patternIsAbsolute = isAbsoluteGlobPath(normalizeGlobSeparators(this.pattern));
    const compiledPattern = normalizeGlobSeparators(this.pattern);
    const root = patternIsAbsolute ? absoluteGlobScanRoot(compiledPattern, cwd) : cwd;
    if (patternIsAbsolute && root === "/" && absoluteRootGlobShouldNotScan(compiledPattern)) return [];
    const absolute = Boolean(options.absolute);
    const onlyFiles = options.onlyFiles !== false;
    const dot = Boolean(options.dot);
    const followSymlinks = Object.prototype.hasOwnProperty.call(options, "followSymlinks") && Boolean(options.followSymlinks);
    const results = [];
    for (const entry of walkFiles(root, { dot, onlyFiles, followSymlinks, throwErrorOnBrokenSymlink: Boolean(options.throwErrorOnBrokenSymlink) })) {
      const matchTarget = patternIsAbsolute ? entry.absolute : entry.relative;
      if (!this.match(matchTarget) && !(entry.isDirectory && this.match(`${matchTarget}/`))) continue;
      results.push(absolute || patternIsAbsolute ? entry.absolute : entry.relative);
    }
    return results;
  }
  scan(options = {}) {
    const entries = this.scanSync(options);
    return (async function*() {
      yield* entries;
    })();
  }
}

function installGlobJsMatchers(glob, compiledPattern) {
  const patterns = expandBunGlobBraces(compiledPattern);
  glob._matchesEmpty = patterns.some((expanded) => expanded === "*" || expanded === "**");
  glob._matchers = patterns.map((expanded) => ({
    pattern: expanded,
    matcher: expanded === "" ? (text) => text === "" : lazyPicomatch(expanded, { dot: true }),
    trailingGlobstarBase: trailingGlobstarBase(expanded),
  }));
}

// Measured by scripts/bench-glob.js. JSC regex wins for compact, reused
// patterns; native matching wins once brace expansion creates a large matcher set.
function shouldUseNativeGlobMatcher(pattern) {
  if (pattern.startsWith("!")) return false;
  let escaped = false;
  let inClass = false;
  let braceDepth = 0;
  let braceGroups = 0;
  let braceCommas = 0;
  let validBraces = true;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (
      pattern[index + 1] === "(" &&
      (char === "?" || char === "*" || char === "+" || char === "@" || char === "!")
    ) {
      return false;
    }
    if (char === "{") {
      braceDepth += 1;
      braceGroups += 1;
    } else if (char === "}") {
      if (braceDepth === 0) validBraces = false;
      else braceDepth -= 1;
    } else if (char === "," && braceDepth > 0) {
      braceCommas += 1;
    }
  }
  return validBraces && braceDepth === 0 && braceGroups * braceCommas >= 24;
}

function normalizeGlobScanOptions(options) {
  if (options === undefined) return {};
  if (typeof options === "string") return { cwd: options };
  if (options === null || typeof options !== "object") throw new TypeError("Glob.scan options must be an object or string");
  if (options.cwd !== undefined && typeof options.cwd !== "string") throw new TypeError("Glob.scan cwd must be a string");
  if (options.root !== undefined && typeof options.root !== "string") throw new TypeError("Glob.scan root must be a string");
  return options;
}

function normalizeGlobSeparators(value) {
  const text = String(value);
  return globalThis.process?.platform === "win32" ? text.replace(/\\/g, "/") : text;
}

function normalizeGlobCharacterClasses(pattern) {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      output += char + pattern[index + 1];
      index += 1;
      continue;
    }
    if (char === "[" && pattern[index + 1] === "!") {
      output += "[^";
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function trailingGlobstarBase(pattern) {
  let base = pattern;
  let matched = false;
  while (base.endsWith("/**")) {
    base = base.slice(0, -3);
    matched = true;
  }
  return matched ? base : null;
}

function isAbsoluteGlobPath(pattern) {
  return pattern.startsWith("/") || /^[A-Za-z]:\//.test(pattern);
}

function absoluteGlobScanRoot(pattern, cwd) {
  const prefix = literalGlobPrefix(pattern);
  if (prefix === "" || prefix === "/") return "/";
  if (prefix.endsWith("/") && prefix.length > 1) return nodePathResolve(cwd, prefix.slice(0, -1));
  const trimmed = prefix;
  if (trimmed === "") return "/";
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0) return "/";
  return nodePathResolve(cwd, trimmed.slice(0, slash));
}

function absoluteRootGlobShouldNotScan(pattern) {
  const rest = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const slash = rest.indexOf("/");
  const first = slash === -1 ? rest : rest.slice(0, slash);
  if (first === "" || first === "*" || first === "**") return false;
  return /[*?[\]{}]/.test(first);
}

function literalGlobPrefix(pattern) {
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      continue;
    }
    if (char === "[" && !inClass) {
      return pattern.slice(0, index);
    }
    if (char === "{" || char === "*" || char === "?") return pattern.slice(0, index);
  }
  return pattern;
}

function hasGlobMeta(pattern) {
  return /[*?[\]()!+@]/.test(pattern);
}

function expandBunGlobBraces(pattern) {
  const results = [];
  const limit = 4096;
  const visit = (text) => {
    if (results.length >= limit) {
      results.push(text);
      return;
    }
    const open = findGlobBraceOpen(text);
    if (open === -1) {
      results.push(text);
      return;
    }
    const close = findGlobBraceClose(text, open);
    if (close === -1) {
      results.push(text);
      return;
    }
    const prefix = text.slice(0, open);
    const suffix = text.slice(close + 1);
    for (const alternative of splitGlobBraceAlternatives(text.slice(open + 1, close))) {
      visit(`${prefix}${alternative}${suffix}`);
    }
  };
  visit(pattern);
  return results.length === 0 ? [pattern] : results;
}

function findGlobBraceOpen(text) {
  let inClass = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (char === "{" && !inClass) return index;
  }
  return -1;
}

function findGlobBraceClose(text, open) {
  let depth = 0;
  let inClass = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitGlobBraceAlternatives(text) {
  const alternatives = [];
  let start = 0;
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      alternatives.push(text.slice(start, index));
      start = index + 1;
    }
  }
  alternatives.push(text.slice(start));
  return alternatives;
}

function walkFiles(root, options = {}, prefix = "", seen = new Set()) {
  const entries = [];
  for (const entry of cottontail.readDirSync(root)) {
    if (!options.dot && entry.name.startsWith(".")) continue;
    const absolute = pathJoin(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    let stat = entry;
    const entryMode = Number(entry.mode) || 0;
    const isSymbolicLink =
      entry.isSymbolicLink === true ||
      entry.kind === "symlink" ||
      entry.type === "symlink" ||
      (entryMode & 0o170000) === 0o120000;
    if (isSymbolicLink && options.followSymlinks) {
      try {
        stat = cottontail.statSync(absolute, true);
        if (!stat) throw new Error(`Broken symbolic link: ${absolute}`);
      } catch (error) {
        if (options.throwErrorOnBrokenSymlink) throw error;
        stat = entry;
      }
    }
    const statMode = Number(stat.mode) || 0;
    const isDirectory =
      stat.kind === "directory" ||
      stat.type === "directory" ||
      stat.isDirectory === true ||
      (statMode & 0o170000) === 0o040000;
    if (isDirectory) {
      if (options.onlyFiles === false) entries.push({ absolute, relative, isDirectory: true });
      const key = stat.dev != null && stat.ino != null ? `${stat.dev}:${stat.ino}` : absolute;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(...walkFiles(absolute, options, relative, seen));
    } else if (options.onlyFiles !== false) {
      entries.push({ absolute, relative, isDirectory: false });
    } else {
      entries.push({ absolute, relative, isDirectory: false });
    }
  }
  return entries;
}

function splitReplStatements(source) {
  const statements = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let braces = 0;
  let brackets = 0;
  let parens = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
    else if (char === ";" && braces === 0 && brackets === 0 && parens === 0) {
      statements.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) statements.push(tail);
  return statements.filter(Boolean);
}

function replBindingNames(pattern) {
  const text = pattern.replace(/:\s*[^,}=\]]+/g, "");
  if (/^[A-Za-z_$][\w$]*$/.test(text.trim())) return [text.trim()];
  return [...text.matchAll(/[A-Za-z_$][\w$]*/g)]
    .map((match) => match[0])
    .filter((name) => !["var", "let", "const"].includes(name));
}

function hasReplTopLevelAwait(source) {
  if (!/\bawait\b/.test(source)) return false;
  if (/^\s*async\s+function\b/.test(source)) return false;
  if (/^\s*(?:const|let|var)\s+\w+(?:\s*:[^=]+)?\s*=\s*async\b[\s\S]*=>[\s\S]*\bawait\b/.test(source)) return false;
  return true;
}

function transformReplSource(source) {
  const text = String(source);
  const trimmed = text.trim();
  if (!trimmed || /^\/\//.test(trimmed)) return "";
  if (/^\{[\s\S]*\};$/.test(trimmed)) return text;

  const statements = splitReplStatements(trimmed);
  const hasAwait = hasReplTopLevelAwait(trimmed);
  if (!hasAwait) {
    const last = statements.at(-1);
    const declaration = /^(?:var|let|const)\s+([\s\S]+?)\s*=\s*([\s\S]+)$/.exec(last ?? "");
    if (declaration) {
      const pattern = declaration[1].trim().replace(/:\s*[^=,}\]]+/g, "");
      const names = replBindingNames(pattern);
      const persist = names.length === 1
        ? `globalThis.${names[0]} = ${names[0]};`
        : `Object.assign(globalThis, { ${names.join(", ")} });`;
      return `var ${pattern} = ${declaration[2]};\n${persist}`;
    }
    if (!last || /^(?:function|class|async\s+function)\b/.test(last)) return text;
    const prefix = statements.slice(0, -1).map((statement) => `${statement};`).join("\n");
    return `${prefix}${prefix ? "\n" : ""}({ value: (${last}) })`;
  }

  const hoisted = [];
  const body = [];
  let result = "undefined";
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    const isLast = index === statements.length - 1;
    const declaration = /^(?:var|let|const)\s+([\s\S]+?)\s*=\s*([\s\S]+)$/.exec(statement);
    if (declaration) {
      const pattern = declaration[1].trim().replace(/:\s*[^=,}\]]+/g, "");
      const names = replBindingNames(pattern);
      hoisted.push(...names);
      body.push(`(${pattern} = ${declaration[2]});`);
      body.push(names.length === 1
        ? `globalThis.${names[0]} = ${names[0]};`
        : `Object.assign(globalThis, { ${names.join(", ")} });`);
      if (isLast) result = names.length === 1 ? names[0] : "undefined";
      continue;
    }
    const functionDeclaration = /^function\s+([A-Za-z_$][\w$]*)\s*(\([\s\S]*)$/.exec(statement);
    if (functionDeclaration) {
      hoisted.push(functionDeclaration[1]);
      body.push(`globalThis.${functionDeclaration[1]} = ${functionDeclaration[1]} = function ${functionDeclaration[1]}${functionDeclaration[2]};`);
      if (isLast) result = functionDeclaration[1];
      continue;
    }
    const classDeclaration = /^class\s+([A-Za-z_$][\w$]*)\s*([\s\S]*)$/.exec(statement);
    if (classDeclaration) {
      hoisted.push(classDeclaration[1]);
      body.push(`globalThis.${classDeclaration[1]} = ${classDeclaration[1]} = class ${classDeclaration[1]} ${classDeclaration[2]};`);
      if (isLast) result = classDeclaration[1];
      continue;
    }
    if (isLast) result = statement;
    else body.push(`${statement};`);
  }
  const declarations = [...new Set(hoisted)];
  return `${declarations.length ? `var ${declarations.join(", ")};\n` : ""}(async () => {\n${body.join("\n")}\nreturn { value: (${result}) };\n})()`;
}


function transpilerSourceText(source) {
  if (typeof source === "string") return source;
  if (ArrayBuffer.isView(source)) {
    return new TextDecoder().decode(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  }
  if (source instanceof ArrayBuffer) return new TextDecoder().decode(source);
  return String(source);
}

function callNativeTranspiler(callback) {
  try {
    return callback();
  } catch (error) {
    if (typeof error === "string") {
      const prefix = "COTTONTAIL_DIAGNOSTICS:";
      if (error.startsWith(prefix)) {
        try {
          const envelope = JSON.parse(error.slice(prefix.length));
          if (Array.isArray(envelope?.errors) && envelope.errors.length > 0) {
            const Message = typeof globalThis.BuildMessage === "function" ? globalThis.BuildMessage : CTBuildMessage;
            const errors = envelope.errors.map(diagnostic => new Message({
              name: "BuildMessage",
              message: diagnostic.message,
              position: diagnostic.position ?? null,
              notes: Array.isArray(diagnostic.notes)
                ? diagnostic.notes.map(note => ({ message: note.message, position: note.position ?? null }))
                : [],
              level: diagnostic.level ?? "error",
            }));
            if (errors.length === 1) throw errors[0];
            throw new AggregateError(errors, "Parse error");
          }
        } catch (diagnosticError) {
          if (diagnosticError instanceof AggregateError || diagnosticError?.name === "BuildMessage") throw diagnosticError;
        }
      }
      throw new Error(error);
    }
    throw error;
  }
}

const transpilerLogLevels = new Set(["verbose", "debug", "info", "warn", "error"]);
const transpilerTransformCache = new Map();
const transpilerTransformCacheMaxBytes = 8 * 1024 * 1024;
const transpilerTransformCacheMaxEntries = 32;
const transpilerTransformCacheMaxSourceBytes = 512 * 1024;
let transpilerTransformCacheBytes = 0;

function transformWithCache(source, optionsJson, loader, cacheable) {
  const sourceText = transpilerSourceText(source);
  if (!cacheable || sourceText.length > transpilerTransformCacheMaxSourceBytes) {
    return callNativeTranspiler(() => cottontail.transpilerTransform(sourceText, optionsJson, loader));
  }
  const key = `${optionsJson.length}:${optionsJson}${loader.length}:${loader}${sourceText}`;
  if (transpilerTransformCache.has(key)) {
    const cached = transpilerTransformCache.get(key);
    transpilerTransformCache.delete(key);
    transpilerTransformCache.set(key, cached);
    return cached.value;
  }
  const value = callNativeTranspiler(() => cottontail.transpilerTransform(sourceText, optionsJson, loader));
  const bytes = (key.length + value.length) * 2;
  if (bytes <= transpilerTransformCacheMaxBytes) {
    transpilerTransformCache.set(key, { value, bytes });
    transpilerTransformCacheBytes += bytes;
    while (transpilerTransformCache.size > transpilerTransformCacheMaxEntries ||
        transpilerTransformCacheBytes > transpilerTransformCacheMaxBytes) {
      const oldestKey = transpilerTransformCache.keys().next().value;
      const oldest = transpilerTransformCache.get(oldestKey);
      transpilerTransformCache.delete(oldestKey);
      transpilerTransformCacheBytes -= oldest.bytes;
    }
  }
  return value;
}

export class Transpiler {
  constructor(options = {}) {
    if (options == null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Expected an object");
    }
    if (options.logLevel !== undefined && !transpilerLogLevels.has(options.logLevel)) {
      throw new TypeError(`Invalid logLevel: ${String(options.logLevel)}`);
    }
    if (options.macro !== undefined && typeof options.macro !== "boolean" && (options.macro === null || typeof options.macro !== "object")) {
      throw new TypeError(`Unexpected ${String(options.macro)}`);
    }
    this.options = options;
    this.optionsJson = JSON.stringify({ ...options, _cottontailStructuredErrors: true });
    this.cacheableTransform = options.macro == null;
  }
  transformSync(source, loader = undefined) {
    if (this.options.replMode) return transformReplSource(source);
    return transformWithCache(
      source,
      this.optionsJson,
      typeof loader === "string" ? loader : "",
      this.cacheableTransform,
    );
  }
  async transform(source, loader = undefined) {
    if (this.options.replMode) return transformReplSource(source);
    return transformWithCache(
      source,
      this.optionsJson,
      typeof loader === "string" ? loader : "",
      this.cacheableTransform,
    );
  }
  scan(source) {
    return JSON.parse(callNativeTranspiler(() => cottontail.transpilerScan(transpilerSourceText(source), this.optionsJson, "")));
  }
  scanImports(source) {
    return JSON.parse(callNativeTranspiler(() => cottontail.transpilerScanImports(transpilerSourceText(source), this.optionsJson, "")));
  }
}

const HTML_REWRITER_SELECTOR_PATTERN = (() => {
  const ident = String.raw`(?:\\.|[A-Za-z0-9_\u00A0-\uFFFF-])+`;
  const quoted = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
  const attr = String.raw`\[\s*${ident}\s*(?:[~^$*|]?=\s*(?:${quoted}|${ident})\s*(?:[iIsS]\s*)?)?\]`;
  const pseudo = String.raw`::?${ident}(?:\((?:${quoted}|[^()"'])*\))?`;
  const part = String.raw`(?:[.#]${ident}|${attr}|${pseudo})`;
  const compound = String.raw`(?:(?:\*|${ident})${part}*|${part}+)`;
  const complex = String.raw`${compound}(?:(?:\s*[>+~]\s*|\s+)${compound})*`;
  return new RegExp(String.raw`^\s*${complex}\s*(?:,\s*${complex}\s*)*$`);
})();

function validateHTMLRewriterSelector(selector) {
  const text = String(selector);
  if (!HTML_REWRITER_SELECTOR_PATTERN.test(text)) {
    throw new TypeError(`Invalid selector: '${text}'`);
  }
  return text;
}

function runHTMLRewriterHandler(handler, ...args) {
  const result = handler(...args);
  if (result == null || typeof result.then !== "function") return result;
  let status = cottontail.promiseStatus(result);
  if (status === 0) {
    // COTTONTAIL-COMPAT: Attach the rejection observer before pumping the
    // event loop so a synchronously rethrown handler error is not also
    // reported as an unhandled rejection by bun:test.
    result.catch(() => {});
    status = cottontail.waitForPromise(result);
  }
  if (status === 2) {
    const reason = cottontail.promiseResult(result);
    result.catch(() => {});
    throw reason;
  }
  return status === 1 ? cottontail.promiseResult(result) : result;
}

class HTMLRewriterTextChunk {
  constructor(state) {
    this._state = state;
  }
  get text() {
    const state = this._state;
    return state.valid ? state.text : undefined;
  }
  get removed() {
    const state = this._state;
    return state.valid ? state.removed : undefined;
  }
  get lastInTextNode() {
    const state = this._state;
    return state.valid ? state.last : undefined;
  }
  before(content, options = undefined) {
    const state = this._state;
    if (state.valid) state.before += options?.html ? String(content) : escapeHTML(String(content));
    return this;
  }
  after(content, options = undefined) {
    const state = this._state;
    if (state.valid) state.after = (options?.html ? String(content) : escapeHTML(String(content))) + state.after;
    return this;
  }
  replace(content, options = undefined) {
    const state = this._state;
    if (state.valid) {
      state.text = String(content);
      state.html = Boolean(options?.html);
      state.replaced = true;
      state.removed = false;
    }
    return this;
  }
  remove() {
    const state = this._state;
    if (state.valid) {
      state.removed = true;
      state.replaced = false;
      state.text = "";
    }
    return this;
  }
}

function rewriteTextChunks(inner, handler, liveStates) {
  const emitTextNode = (text) => {
    let result = "";
    const emit = (chunkText, last) => {
      const state = {
        valid: true,
        text: chunkText,
        removed: false,
        replaced: false,
        html: false,
        last,
        before: "",
        after: "",
      };
      liveStates.push(state);
      runHTMLRewriterHandler(handler, new HTMLRewriterTextChunk(state));
      const body = state.removed ? "" : state.replaced ? (state.html ? state.text : escapeHTML(state.text)) : chunkText;
      return state.before + body + state.after;
    };
    result += emit(text, false);
    result += emit("", true);
    return result;
  };

  let output = "";
  let index = 0;
  const tagPattern = /<[^>]*>/g;
  let match;
  while ((match = tagPattern.exec(inner))) {
    const text = inner.slice(index, match.index);
    if (text) output += emitTextNode(text);
    output += match[0];
    index = match.index + match[0].length;
  }
  const tail = inner.slice(index);
  if (tail) output += emitTextNode(tail);
  return output;
}

const HTML_REWRITER_VOID_ELEMENTS = new Set([
  "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame",
  "hr", "img", "input", "keygen", "link", "meta", "param", "source",
  "track", "wbr",
]);

function findHTMLRewriterTagEnd(html, start) {
  let quote = "";
  for (let index = start + 1; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === ">") return index;
  }
  return -1;
}

function parseHTMLRewriterAttributes(source) {
  const attributes = [];
  let index = 0;
  while (index < source.length) {
    const rawStart = index;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length || source[index] === "/") break;
    const nameStart = index;
    while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1;
    if (index === nameStart) {
      index += 1;
      continue;
    }
    const name = source.slice(nameStart, index);
    while (index < source.length && /\s/.test(source[index])) index += 1;
    let value = "";
    let hadValue = false;
    if (source[index] === "=") {
      hadValue = true;
      index += 1;
      while (index < source.length && /\s/.test(source[index])) index += 1;
      const quote = source[index] === "\"" || source[index] === "'" ? source[index++] : "";
      const valueStart = index;
      if (quote) {
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index += 1;
      } else {
        while (index < source.length && !/[\s>]/.test(source[index])) index += 1;
        value = source.slice(valueStart, index);
      }
    }
    attributes.push({
      name,
      normalizedName: name.toLowerCase(),
      value,
      hadValue,
      raw: source.slice(rawStart, index),
      changed: false,
      removed: false,
    });
  }
  return attributes;
}

function parseHTMLRewriterTree(html) {
  const root = { type: "root", children: [], parent: null };
  const stack = [root];
  let index = 0;
  const append = (node) => {
    const parent = stack[stack.length - 1];
    node.parent = parent;
    parent.children.push(node);
  };

  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      const stop = end < 0 ? html.length : end + 3;
      append({
        type: "comment",
        text: html.slice(index + 4, end < 0 ? html.length : end),
        raw: html.slice(index, stop),
        before: [],
        after: [],
        replacement: null,
        removed: false,
      });
      index = stop;
      continue;
    }
    if (html[index] !== "<") {
      const next = html.indexOf("<", index);
      const stop = next < 0 ? html.length : next;
      append({ type: "text", raw: html.slice(index, stop) });
      index = stop;
      continue;
    }

    const end = findHTMLRewriterTagEnd(html, index);
    if (end < 0) {
      append({ type: "text", raw: html.slice(index) });
      break;
    }
    const raw = html.slice(index, end + 1);
    const closing = /^<\s*\/\s*([^\s>]+)/.exec(raw);
    if (closing) {
      const tagName = closing[1].toLowerCase();
      let matchIndex = stack.length - 1;
      while (matchIndex > 0 && stack[matchIndex].tagName !== tagName) matchIndex -= 1;
      if (matchIndex > 0) {
        stack[matchIndex].closeRaw = raw;
        stack.length = matchIndex;
      } else {
        append({ type: "raw", raw });
      }
      index = end + 1;
      continue;
    }
    if (/^<\s*!|^<\s*\?/.test(raw)) {
      append({ type: "raw", raw });
      index = end + 1;
      continue;
    }

    const opening = /^<\s*([^\s/>]+)/.exec(raw);
    if (!opening) {
      append({ type: "raw", raw });
      index = end + 1;
      continue;
    }
    const originalTagName = opening[1];
    const tagName = originalTagName.toLowerCase();
    const explicitSelfClosing = /\/\s*>$/.test(raw);
    const parent = stack[stack.length - 1];
    const parentNamespace = parent.type === "element" ? parent.namespace : "html";
    const namespace = tagName === "svg" || (parentNamespace === "svg" && tagName !== "foreignobject")
      ? "svg"
      : "html";
    const attributeEnd = raw.length - 1 - (explicitSelfClosing ? raw.slice(0, -1).match(/\/\s*$/)?.[0].length ?? 0 : 0);
    const attributeSource = raw.slice(opening[0].length, attributeEnd);
    const node = {
      type: "element",
      tagName,
      originalTagName,
      namespace,
      startRaw: raw,
      closeRaw: "",
      attributes: parseHTMLRewriterAttributes(attributeSource),
      attrsChanged: false,
      tagChanged: false,
      selfClosing: explicitSelfClosing,
      isVoid: HTML_REWRITER_VOID_ELEMENTS.has(tagName),
      children: [],
      before: [],
      after: [],
      prepend: [],
      append: [],
      innerOverride: null,
      replacement: null,
      removed: false,
      keepContent: false,
    };
    append(node);
    if (!node.isVoid && !node.selfClosing) stack.push(node);
    index = end + 1;
  }
  return root;
}

function splitHTMLRewriterSelectorList(selector) {
  const selectors = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote) {
      if (char === quote && selector[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      selectors.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(selector.slice(start).trim());
  return selectors.filter(Boolean);
}

function parseHTMLRewriterSelectorChain(selector) {
  const compounds = [];
  const combinators = [];
  let buffer = "";
  let depth = 0;
  let quote = "";
  let pendingSpace = false;
  const flush = () => {
    const value = buffer.trim();
    if (value) compounds.push(value);
    buffer = "";
  };
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote) {
      buffer += char;
      if (char === quote && selector[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      if (pendingSpace && compounds.length > combinators.length) combinators.push(" ");
      pendingSpace = false;
      quote = char;
      buffer += char;
      continue;
    }
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    if (depth === 0 && char === ">") {
      flush();
      if (combinators.length === compounds.length) combinators[combinators.length - 1] = ">";
      else combinators.push(">");
      pendingSpace = false;
      continue;
    }
    if (depth === 0 && /\s/.test(char)) {
      flush();
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      if (compounds.length > combinators.length) combinators.push(" ");
      pendingSpace = false;
    }
    buffer += char;
  }
  flush();
  return { compounds, combinators };
}

function HTMLRewriterElementSiblings(node) {
  return node.parent?.children?.filter((child) => child.type === "element") ?? [];
}

function matchesHTMLRewriterAttribute(node, source) {
  const match = /^\s*([^\s~|^$*=\]]+)\s*(?:(~=|\|=|\^=|\$=|\*=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))\s*([iIsS])?)?\s*$/.exec(source);
  if (!match) return false;
  const name = match[1].toLowerCase();
  const operation = match[2];
  const expectedRaw = match[3] ?? match[4] ?? match[5] ?? "";
  const insensitive = String(match[6] ?? "").toLowerCase() === "i";
  const attributes = node.attributes.filter((attribute) => !attribute.removed && attribute.normalizedName === name);
  if (!operation) return attributes.length > 0;
  return attributes.some((attribute) => {
    let actual = attribute.value;
    let expected = expectedRaw;
    if (insensitive) {
      actual = actual.toLowerCase();
      expected = expected.toLowerCase();
    }
    if (operation === "=") return actual === expected;
    if (operation === "~=") return actual.split(/\s+/).includes(expected);
    if (operation === "|=") return actual === expected || actual.startsWith(`${expected}-`);
    if (operation === "^=") return actual.startsWith(expected);
    if (operation === "$=") return actual.endsWith(expected);
    return actual.includes(expected);
  });
}

function matchesHTMLRewriterCompound(node, compound) {
  const notSelectors = [];
  let source = compound.replace(/:not\(([^()]*)\)/g, (_match, selector) => {
    notSelectors.push(selector);
    return "";
  });
  const attributes = [];
  source = source.replace(/\[([^\]]*)\]/g, (_match, attribute) => {
    attributes.push(attribute);
    return "";
  });
  const pseudos = [];
  source = source.replace(/:(first-child|first-of-type|nth-child\(\s*\d+\s*\)|nth-of-type\(\s*\d+\s*\))/g, (_match, pseudo) => {
    pseudos.push(pseudo);
    return "";
  });
  const tag = /^(\*|[A-Za-z][\w:-]*)/.exec(source)?.[1];
  if (tag && tag !== "*" && node.tagName !== tag.toLowerCase()) return false;
  for (const id of source.matchAll(/#([\w-]+)/g)) {
    if (!node.attributes.some((attribute) => !attribute.removed && attribute.normalizedName === "id" && attribute.value === id[1])) return false;
  }
  for (const className of source.matchAll(/\.([\w-]+)/g)) {
    const matched = node.attributes.some((attribute) =>
      !attribute.removed && attribute.normalizedName === "class" && attribute.value.split(/\s+/).includes(className[1]));
    if (!matched) return false;
  }
  for (const attribute of attributes) {
    if (!matchesHTMLRewriterAttribute(node, attribute)) return false;
  }
  const siblings = HTMLRewriterElementSiblings(node);
  const childIndex = siblings.indexOf(node);
  const sameType = siblings.filter((sibling) => sibling.tagName === node.tagName);
  const typeIndex = sameType.indexOf(node);
  for (const pseudo of pseudos) {
    if (pseudo === "first-child" && childIndex !== 0) return false;
    if (pseudo === "first-of-type" && typeIndex !== 0) return false;
    const nthChild = /^nth-child\(\s*(\d+)\s*\)$/.exec(pseudo);
    if (nthChild && childIndex + 1 !== Number(nthChild[1])) return false;
    const nthType = /^nth-of-type\(\s*(\d+)\s*\)$/.exec(pseudo);
    if (nthType && typeIndex + 1 !== Number(nthType[1])) return false;
  }
  for (const notSelector of notSelectors) {
    if (matchesHTMLRewriterCompound(node, notSelector)) return false;
  }
  return true;
}

function matchesHTMLRewriterSelectorChain(node, chain, compoundIndex = chain.compounds.length - 1) {
  if (compoundIndex < 0 || !matchesHTMLRewriterCompound(node, chain.compounds[compoundIndex])) return false;
  if (compoundIndex === 0) return true;
  const combinator = chain.combinators[compoundIndex - 1] ?? " ";
  if (combinator === ">") {
    return node.parent?.type === "element" && matchesHTMLRewriterSelectorChain(node.parent, chain, compoundIndex - 1);
  }
  let parent = node.parent;
  while (parent?.type === "element") {
    if (matchesHTMLRewriterSelectorChain(parent, chain, compoundIndex - 1)) return true;
    parent = parent.parent;
  }
  return false;
}

function parseHTMLRewriterSelector(selector) {
  return splitHTMLRewriterSelectorList(selector).map(parseHTMLRewriterSelectorChain);
}

function matchesHTMLRewriterSelector(node, selector) {
  return selector.some((chain) => matchesHTMLRewriterSelectorChain(node, chain));
}

function HTMLRewriterContent(content, options) {
  const text = String(content);
  return options?.html ? text : escapeHTML(text);
}

function makeHTMLRewriterElement(node) {
  const element = {
    get tagName() { return node.tagName; },
    set tagName(value) {
      node.tagName = String(value).toLowerCase();
      node.tagChanged = true;
    },
    get namespaceURI() {
      return node.namespace === "svg" ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml";
    },
    get attributes() {
      return node.attributes.filter((attribute) => !attribute.removed).map((attribute) => [attribute.name, attribute.value]);
    },
    get removed() { return node.removed; },
    get selfClosing() { return node.selfClosing; },
    get canHaveContent() { return !node.isVoid && !(node.namespace !== "html" && node.selfClosing); },
    getAttribute(name) {
      const normalized = String(name).toLowerCase();
      return node.attributes.find((attribute) => !attribute.removed && attribute.normalizedName === normalized)?.value ?? null;
    },
    hasAttribute(name) {
      const normalized = String(name).toLowerCase();
      return node.attributes.some((attribute) => !attribute.removed && attribute.normalizedName === normalized);
    },
    setAttribute(name, value) {
      const nameText = String(name);
      const normalized = nameText.toLowerCase();
      const existing = node.attributes.find((attribute) => !attribute.removed && attribute.normalizedName === normalized);
      if (existing) {
        existing.value = String(value);
        existing.hadValue = true;
        existing.changed = true;
      } else {
        node.attributes.push({ name: nameText, normalizedName: normalized, value: String(value), hadValue: true, raw: "", changed: true, removed: false });
      }
      node.attrsChanged = true;
      return element;
    },
    removeAttribute(name) {
      const normalized = String(name).toLowerCase();
      for (const attribute of node.attributes) {
        if (attribute.normalizedName === normalized) attribute.removed = true;
      }
      node.attrsChanged = true;
      return element;
    },
    before(content, options) {
      node.before.push(HTMLRewriterContent(content, options));
      return element;
    },
    after(content, options) {
      node.after.unshift(HTMLRewriterContent(content, options));
      return element;
    },
    prepend(content, options) {
      node.prepend.unshift(HTMLRewriterContent(content, options));
      return element;
    },
    append(content, options) {
      node.append.push(HTMLRewriterContent(content, options));
      return element;
    },
    replace(content, options) {
      node.replacement = HTMLRewriterContent(content, options);
      node.removed = false;
      return element;
    },
    setInnerContent(content, options) {
      node.innerOverride = HTMLRewriterContent(content, options);
      return element;
    },
    remove() {
      node.removed = true;
      node.keepContent = false;
      return element;
    },
    removeAndKeepContent() {
      node.removed = true;
      node.keepContent = true;
      return element;
    },
  };
  return element;
}

function runHTMLRewriterCommentHandler(node, handler) {
  const comment = {
    get text() { return node.text; },
    set text(value) { node.text = String(value); },
    get removed() { return node.removed; },
    before(content, options) { node.before.push(HTMLRewriterContent(content, options)); return comment; },
    after(content, options) { node.after.unshift(HTMLRewriterContent(content, options)); return comment; },
    replace(content, options) { node.replacement = HTMLRewriterContent(content, options); node.removed = false; return comment; },
    remove() { node.removed = true; return comment; },
  };
  runHTMLRewriterHandler(handler, comment);
}

function serializeHTMLRewriterStartTag(node) {
  if (!node.attrsChanged && !node.tagChanged) return node.startRaw;
  let output = `<${node.tagName}`;
  for (const attribute of node.attributes) {
    if (attribute.removed) continue;
    if (!attribute.changed && attribute.raw) output += attribute.raw;
    else output += ` ${attribute.name}="${escapeHTML(attribute.value)}"`;
  }
  return `${output}${node.selfClosing ? " /" : ""}>`;
}

function serializeHTMLRewriterNode(node) {
  if (node.type === "text" || node.type === "raw") return node.raw;
  if (node.type === "comment") {
    const body = node.removed ? "" : node.replacement ?? `<!--${node.text}-->`;
    return node.before.join("") + body + node.after.join("");
  }
  if (node.type === "root") return node.children.map(serializeHTMLRewriterNode).join("");
  const content = node.innerOverride ?? node.children.map(serializeHTMLRewriterNode).join("");
  const inner = node.prepend.join("") + content + node.append.join("");
  let body;
  if (node.replacement != null) body = node.replacement;
  else if (node.removed) body = node.keepContent ? inner : "";
  else body = serializeHTMLRewriterStartTag(node) + (node.isVoid || node.selfClosing ? "" : inner + node.closeRaw);
  return node.before.join("") + body + node.after.join("");
}

function rewriteHTMLRewriterElements(html, registrations, documentHandlers, liveTextStates) {
  if (registrations.length === 0 && documentHandlers.length === 0) return html;
  const parsedRegistrations = registrations.map((registration) => ({
    ...registration,
    parsedSelector: parseHTMLRewriterSelector(registration.selector),
  }));
  const root = parseHTMLRewriterTree(html);
  const documentCommentHandlers = documentHandlers.flatMap((handlers) =>
    typeof handlers.comments === "function" ? [handlers.comments.bind(handlers)] : []);
  const documentTextHandlers = documentHandlers.flatMap((handlers) =>
    typeof handlers.text === "function" ? [handlers.text.bind(handlers)] : []);

  const visit = (node, commentHandlers, textHandlers) => {
    if (node.type === "comment") {
      for (const handler of commentHandlers) runHTMLRewriterCommentHandler(node, handler);
      return;
    }
    if (node.type === "text") {
      for (const handler of textHandlers) node.raw = rewriteTextChunks(node.raw, handler, liveTextStates);
      return;
    }
    if (node.type !== "element" && node.type !== "root") return;
    let childCommentHandlers = commentHandlers;
    let childTextHandlers = textHandlers;
    if (node.type === "element") {
      const matches = parsedRegistrations.filter((registration) => matchesHTMLRewriterSelector(node, registration.parsedSelector));
      for (const registration of matches) {
        if (typeof registration.handlers?.element === "function") {
          runHTMLRewriterHandler(registration.handlers.element.bind(registration.handlers), makeHTMLRewriterElement(node));
        }
      }
      const scopedComments = matches.flatMap((registration) =>
        typeof registration.handlers?.comments === "function" ? [registration.handlers.comments.bind(registration.handlers)] : []);
      const scopedText = matches.flatMap((registration) =>
        typeof registration.handlers?.text === "function" ? [registration.handlers.text.bind(registration.handlers)] : []);
      if (scopedComments.length > 0) childCommentHandlers = [...commentHandlers, ...scopedComments];
      if (scopedText.length > 0) childTextHandlers = [...textHandlers, ...scopedText];
      if (node.innerOverride != null) return;
    }
    for (const child of node.children) visit(child, childCommentHandlers, childTextHandlers);
  };
  visit(root, documentCommentHandlers, documentTextHandlers);
  let output = serializeHTMLRewriterNode(root);
  for (const handlers of documentHandlers) {
    if (typeof handlers.end !== "function") continue;
    const additions = [];
    const end = { append(content, options) { additions.push(HTMLRewriterContent(content, options)); return end; } };
    runHTMLRewriterHandler(handlers.end.bind(handlers), end);
    output += additions.join("");
  }
  return output;
}

export class HTMLRewriter {
  constructor() {
    this._elementHandlers = [];
    this._documentHandlers = [];
  }
  on(selector, handlers) {
    validateHTMLRewriterSelector(selector);
    if (handlers === null || typeof handlers !== "object") {
      throw new TypeError("Expected object");
    }
    this._elementHandlers.push({ selector: String(selector), handlers });
    return this;
  }
  onDocument(handlers) {
    if (handlers === null || typeof handlers !== "object") {
      throw new TypeError("Expected object");
    }
    for (const name of ["doctype", "comments", "text", "end"]) {
      if (handlers[name] != null && typeof handlers[name] !== "function") {
        throw new TypeError(`${name} must be a function`);
      }
    }
    this._documentHandlers.push(handlers);
    return this;
  }
  transform(response) {
    if (response === null || response === undefined) {
      throw new TypeError("Expected Response or Body");
    }
    if (typeof response === "symbol" || (response instanceof Response && typeof response._body === "symbol")) {
      throw new TypeError("Expected Response or Body");
    }
    if (typeof response === "string") return this._transformText(response);
    if (response instanceof ArrayBuffer || ArrayBuffer.isView(response)) {
      const bytes = response instanceof ArrayBuffer
        ? new Uint8Array(response)
        : new Uint8Array(response.buffer, response.byteOffset, response.byteLength);
      return new TextEncoder().encode(this._transformText(new TextDecoder().decode(bytes))).buffer;
    }
    const source = response instanceof Response || response instanceof Blob || response?.text
      ? response
      : new Response(response);
    // Buffered string/byte bodies are rewritten eagerly (lol-html runs the
    // handlers during transform(), not when the result is consumed).
    const direct = source instanceof Response ? source._body : null;
    if (typeof direct === "string" || direct instanceof ArrayBuffer || ArrayBuffer.isView(direct)) {
      source._bodyUsed = true;
      const text = typeof direct === "string"
        ? direct
        : new TextDecoder().decode(direct instanceof ArrayBuffer ? new Uint8Array(direct) : new Uint8Array(direct.buffer, direct.byteOffset, direct.byteLength));
      return new Response(this._transformText(text), {
        status: response?.status ?? 200,
        headers: response?.headers,
      });
    }
    const rewriter = this;
    const transformedBody = (async function* () {
      yield new TextEncoder().encode(rewriter._transformText(await source.text()));
    })();
    return new Response(transformedBody, {
      status: response?.status ?? 200,
      headers: response?.headers,
    });
  }
  _transformText(input) {
    let html = String(input);
    const liveTextStates = [];
    for (const handlers of this._documentHandlers) {
      if (typeof handlers.doctype === "function") {
        html = html.replace(/<!DOCTYPE\s+([^>]+)>/i, (source, declaration) => {
          const name = /^\s*([^\s]+)/.exec(declaration)?.[1] ?? null;
          const publicMatch = /^\s*[^\s]+\s+PUBLIC\s+["']([^"']*)["'](?:\s+["']([^"']*)["'])?/i.exec(declaration);
          const systemMatch = /^\s*[^\s]+\s+SYSTEM\s+["']([^"']*)["']/i.exec(declaration);
          const state = { valid: true, removed: false };
          const doctype = {
            get name() { return state.valid ? name : undefined; },
            get publicId() { return state.valid ? (publicMatch?.[1] ?? null) : undefined; },
            get systemId() { return state.valid ? (publicMatch?.[2] ?? systemMatch?.[1] ?? null) : undefined; },
            get removed() { return state.valid ? state.removed : undefined; },
            remove() {
              if (state.valid) state.removed = true;
              return this;
            },
          };
          runHTMLRewriterHandler(handlers.doctype.bind(handlers), doctype);
          state.valid = false;
          return state.removed ? "" : source;
        });
      }
    }
    html = rewriteHTMLRewriterElements(html, this._elementHandlers, this._documentHandlers, liveTextStates);
    for (const state of liveTextStates) state.valid = false;
    return html;
  }
}

export class FileSystemRouter {
  constructor(options) {
    if (options == null || typeof options !== "object") throw new TypeError("Expected object");
    if (options.style !== "nextjs") throw new TypeError("Only 'nextjs' style is currently implemented");
    if (typeof options.dir !== "string") throw new TypeError("Expected dir to be a string");
    if (options.origin !== undefined && typeof options.origin !== "string") throw new TypeError("Expected origin to be a string");
    if (options.assetPrefix !== undefined && typeof options.assetPrefix !== "string") throw new TypeError("Expected assetPrefix to be a string");
    if (options.fileExtensions !== undefined && (!Array.isArray(options.fileExtensions) || options.fileExtensions.some((value) => typeof value !== "string"))) {
      throw new TypeError("Expected fileExtensions to be an Array of strings");
    }
    this.options = { ...options };
    this.style = "nextjs";
    this.origin = options.origin ?? "";
    this.assetPrefix = options.assetPrefix ?? "";
    this._dir = options.dir;
    this._extensions = (options.fileExtensions ?? [".tsx", ".jsx", ".ts", ".mjs", ".cjs", ".js"])
      .filter(Boolean)
      .map((value) => value.startsWith(".") ? value : `.${value}`);
    this._records = [];
    this.routes = Object.create(null);
    this.reload();
  }

  match(input) {
    const { pathname, query } = normalizeRouterInput(input);
    const normalized = normalizeRoutePath(pathname);
    let best = null;
    for (const record of this._records) {
      const params = matchFileSystemRoute(record, normalized);
      if (params == null) continue;
      if (best == null || compareFileSystemRoutes(record, best.record) < 0) best = { record, params };
    }
    if (best == null) return null;
    const { record, params } = best;
    const resultQuery = { ...params, ...query };
    let src = record.relative;
    if (this.assetPrefix) src = `${this.assetPrefix.replace(/\/+$/, "")}/${src.replace(/^\/+/, "")}`;
    if (this.origin) src = `${this.origin.replace(/\/+$/, "")}/${src.replace(/^\/+/, "")}`;
    return {
      filePath: record.filePath,
      kind: record.kind,
      name: record.name,
      pathname: normalized,
      src,
      params,
      query: resultQuery,
    };
  }

  reload() {
    const routes = Object.create(null);
    const records = [];
    if (cottontail.existsSync(this._dir)) {
      for (const entry of walkFiles(this._dir, { dot: false, onlyFiles: true })) {
        const relative = String(entry.relative).replace(/\\/g, "/");
        const extension = this._extensions.find((candidate) => relative.endsWith(candidate));
        if (!extension) continue;
        const name = routePathFromFile(relative, extension);
        const record = makeFileSystemRouteRecord(name, entry.absolute, relative);
        routes[name] = entry.absolute;
        records.push(record);
      }
    }
    this.routes = routes;
    this._records = records;
    return this;
  }
}

function normalizeRoutePath(value) {
  let pathname = String(value || "/").split(/[?#]/, 1)[0] || "/";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  pathname = pathname.replace(/\/+/g, "/");
  if (pathname === "/index") pathname = "/";
  else if (pathname.endsWith("/index")) pathname = pathname.slice(0, -6) || "/";
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  return pathname || "/";
}

function normalizeRouterInput(input) {
  if (input == null) throw new TypeError("Expected string, Request or Response");
  let raw;
  if (typeof input === "string") raw = input;
  else if (typeof input.url === "string") raw = input.url;
  else if (typeof input.href === "string") raw = input.href;
  else if (typeof input.pathname === "string") raw = `${input.pathname}${input.search ?? ""}`;
  else throw new TypeError("Expected string, Request or Response");
  const query = {};
  const queryStart = raw.indexOf("?");
  if (queryStart !== -1) {
    const hashStart = raw.indexOf("#", queryStart);
    const queryText = raw.slice(queryStart + 1, hashStart === -1 ? raw.length : hashStart);
    for (const part of queryText.split("&")) {
      if (!part) continue;
      const separator = part.indexOf("=");
      const decode = (value) => decodeURIComponent(value.replace(/\+/g, " "));
      const key = decode(separator === -1 ? part : part.slice(0, separator));
      query[key] = decode(separator === -1 ? "" : part.slice(separator + 1));
    }
  }
  let url;
  try {
    url = new URL(raw, "http://cottontail.invalid");
  } catch {
    return { pathname: queryStart === -1 ? raw : raw.slice(0, queryStart), query };
  }
  return { pathname: url.pathname, query };
}

function routePathFromFile(file, extension) {
  let route = String(file).replace(/\\/g, "/").slice(0, -extension.length);
  route = route.replace(/\/index$/, "").replace(/^index$/, "");
  return `/${route}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function makeFileSystemRouteRecord(name, filePath, relative) {
  const segments = name === "/" ? [] : name.slice(1).split("/");
  let kind = "exact";
  let rank = 0;
  if (segments.some((segment) => /^\[\[\.\.\.[^\]]+\]\]$/.test(segment))) {
    kind = "catch-all-optional";
    rank = 3;
  } else if (segments.some((segment) => /^\[\.\.\.[^\]]+\]$/.test(segment))) {
    kind = "catch-all";
    rank = 2;
  } else if (segments.some((segment) => /^\[[^\]]+\]$/.test(segment))) {
    kind = "dynamic";
    rank = 1;
  }
  return { name, filePath, relative, segments, kind, rank };
}

function compareFileSystemRoutes(left, right) {
  if (left.rank !== right.rank) return left.rank - right.rank;
  const leftStatic = left.segments.filter((segment) => !segment.startsWith("[")).length;
  const rightStatic = right.segments.filter((segment) => !segment.startsWith("[")).length;
  if (leftStatic !== rightStatic) return rightStatic - leftStatic;
  return right.segments.length - left.segments.length;
}

function matchFileSystemRoute(record, pathname) {
  const inputSegments = pathname === "/" ? [] : pathname.slice(1).split("/").map((value) => decodeURIComponent(value));
  const params = {};
  let inputIndex = 0;
  for (let routeIndex = 0; routeIndex < record.segments.length; routeIndex += 1) {
    const segment = record.segments[routeIndex];
    const optionalCatchAll = segment.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
    if (optionalCatchAll) {
      params[optionalCatchAll[1]] = inputSegments.slice(inputIndex).join("/");
      inputIndex = inputSegments.length;
      continue;
    }
    const catchAll = segment.match(/^\[\.\.\.([^\]]+)\]$/);
    if (catchAll) {
      if (inputIndex >= inputSegments.length) return null;
      params[catchAll[1]] = inputSegments.slice(inputIndex).join("/");
      inputIndex = inputSegments.length;
      continue;
    }
    const dynamic = segment.match(/^\[([^\]]+)\]$/);
    if (dynamic) {
      if (inputIndex >= inputSegments.length) return null;
      params[dynamic[1]] = inputSegments[inputIndex++];
      continue;
    }
    if (inputSegments[inputIndex++] !== segment) return null;
  }
  return inputIndex === inputSegments.length ? params : null;
}

const terminalStates = new WeakMap();

function terminalFdListeners() {
  const listeners = globalThis.__cottontailFdWatchListeners ??= new Map();
  if (!globalThis.__cottontailFdWatchHandlerInstalled && typeof cottontail.fdSetEventHandler === "function") {
    globalThis.__cottontailFdWatchHandlerInstalled = true;
    cottontail.fdSetEventHandler((event) => {
      const listener = listeners.get(Number(event?.id));
      if (typeof listener === "function") listener(event);
    });
  }
  return listeners;
}

function closeTerminalResource(resource) {
  if (!resource || resource.closed) return;
  resource.closed = true;
  if (resource.watchId) {
    terminalFdListeners().delete(resource.watchId);
    cottontail.fdWatchStop?.(resource.watchId);
    resource.watchId = 0;
  }
  const descriptors = new Set([resource.masterFd, resource.readFd, resource.writeFd, resource.slaveFd]);
  for (const fd of descriptors) {
    if (Number.isInteger(fd) && fd >= 0) {
      try { cottontail.closeFd?.(fd); } catch {}
    }
  }
  resource.masterFd = -1;
  resource.readFd = -1;
  resource.writeFd = -1;
  resource.slaveFd = -1;
}

const terminalFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(closeTerminalResource)
  : null;

function terminalState(value) {
  const state = terminalStates.get(value);
  if (!state) throw new TypeError("Expected a Terminal object");
  return state;
}

function notifyTerminalExit(terminal, code = 0, signal = null) {
  if (!terminal) return;
  const state = terminalStates.get(terminal);
  if (!state || state.exitNotified) return;
  state.exitNotified = true;
  if (typeof state.exit !== "function") return;
  queueMicrotask(() => {
    try {
      state.exit(terminal, code, signal);
    } catch (error) {
      queueMicrotask(() => { throw error; });
    }
  });
}

function terminalSpawnFd(terminal) {
  if (!terminal) return undefined;
  const state = terminalState(terminal);
  if (state.closed || state.resource.slaveFd < 0) throw new Error("terminal is closed");
  return state.resource.slaveFd;
}

function terminalProcessExited(terminal, code, signal) {
  notifyTerminalExit(terminal, code ?? 0, signal ?? null);
}

export class Terminal {
  constructor(options) {
    if (options == null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Terminal constructor requires an options object");
    }
    if (typeof cottontail.terminalCreate !== "function") {
      throw new Error("PTY not supported on this platform");
    }

    const cols = typeof options.cols === "number" && Number.isInteger(options.cols) && options.cols > 0 && options.cols <= 0xffff
      ? options.cols
      : 80;
    const rows = typeof options.rows === "number" && Number.isInteger(options.rows) && options.rows > 0 && options.rows <= 0xffff
      ? options.rows
      : 24;
    const name = typeof options.name === "string" && options.name.length > 0 ? options.name : "xterm-256color";
    if (name.length > 128) throw new TypeError("Terminal name too long (max 128 characters)");

    const native = cottontail.terminalCreate(cols, rows);
    const resource = {
      closed: false,
      watchId: 0,
      masterFd: Number(native?.masterFd ?? -1),
      readFd: Number(native?.readFd ?? -1),
      writeFd: Number(native?.writeFd ?? -1),
      slaveFd: Number(native?.slaveFd ?? -1),
    };
    if ([resource.masterFd, resource.readFd, resource.writeFd, resource.slaveFd].some((fd) => !Number.isInteger(fd) || fd < 0)) {
      closeTerminalResource(resource);
      throw new Error("Failed to open PTY");
    }

    const state = {
      resource,
      closed: false,
      referenced: true,
      exitNotified: false,
      name,
      data: typeof options.data === "function" ? _wrapAsyncCallback(options.data) : undefined,
      exit: typeof options.exit === "function" ? _wrapAsyncCallback(options.exit) : undefined,
      drain: typeof options.drain === "function" ? _wrapAsyncCallback(options.drain) : undefined,
    };
    terminalStates.set(this, state);

    try {
      const watch = cottontail.fdWatchStart(resource.readFd, 64 * 1024, true, false);
      resource.watchId = Number(watch?.id ?? 0);
      if (!resource.watchId) throw new Error("Failed to start terminal reader");
      terminalFdListeners().set(resource.watchId, (event) => {
        if (state.closed) return;
        if (event?.type === "data") {
          if (typeof state.data !== "function") return;
          const bytes = asBuffer(event.data ?? new ArrayBuffer(0));
          if (bytes.byteLength === 0) return;
          try {
            state.data(this, bytes);
          } catch (error) {
            queueMicrotask(() => { throw error; });
          }
          return;
        }
        if (event?.type === "end" || event?.type === "error") {
          terminalFdListeners().delete(resource.watchId);
          resource.watchId = 0;
          notifyTerminalExit(this, 0, null);
        }
      });
      terminalFinalizer?.register(this, resource, resource);
    } catch (error) {
      terminalStates.delete(this);
      closeTerminalResource(resource);
      throw error;
    }
  }

  get closed() {
    return terminalState(this).closed;
  }

  set closed(_) {
    throw new TypeError("Terminal.closed is read-only");
  }

  get inputFlags() {
    const state = terminalState(this);
    return state.closed ? 0 : Number(cottontail.terminalGetFlags?.(state.resource.masterFd, 0) ?? 0);
  }

  set inputFlags(value) {
    this.#setFlags(0, value);
  }

  get outputFlags() {
    const state = terminalState(this);
    return state.closed ? 0 : Number(cottontail.terminalGetFlags?.(state.resource.masterFd, 1) ?? 0);
  }

  set outputFlags(value) {
    this.#setFlags(1, value);
  }

  get localFlags() {
    const state = terminalState(this);
    return state.closed ? 0 : Number(cottontail.terminalGetFlags?.(state.resource.masterFd, 2) ?? 0);
  }

  set localFlags(value) {
    this.#setFlags(2, value);
  }

  get controlFlags() {
    const state = terminalState(this);
    return state.closed ? 0 : Number(cottontail.terminalGetFlags?.(state.resource.masterFd, 3) ?? 0);
  }

  set controlFlags(value) {
    this.#setFlags(3, value);
  }

  #setFlags(kind, value) {
    const state = terminalState(this);
    if (state.closed) return;
    cottontail.terminalSetFlags?.(state.resource.masterFd, kind, Number(value));
  }

  write(data) {
    const state = terminalState(this);
    if (state.closed) throw new Error("Terminal is closed");
    if (data == null || (typeof data !== "string" && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data))) {
      throw new TypeError("write() argument must be a string or ArrayBuffer");
    }
    const bytes = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.byteLength === 0) return 0;
    const written = Number(cottontail.terminalWrite?.(state.resource.writeFd, bytes) ?? -1);
    if (!Number.isInteger(written) || written < 0) throw new Error("Failed to write to terminal");
    if (typeof state.drain === "function") {
      queueMicrotask(() => {
        try { state.drain(this); } catch (error) { queueMicrotask(() => { throw error; }); }
      });
    }
    return written;
  }

  resize(cols, rows) {
    const state = terminalState(this);
    if (state.closed) throw new Error("Terminal is closed");
    if (typeof cols !== "number" || !Number.isFinite(cols) || cols <= 0 || cols > 0xffff) {
      throw new TypeError("resize() requires valid cols argument");
    }
    if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0 || rows > 0xffff) {
      throw new TypeError("resize() requires valid rows argument");
    }
    cottontail.terminalResize?.(state.resource.masterFd, Math.trunc(cols), Math.trunc(rows));
  }

  setRawMode(enabled) {
    const state = terminalState(this);
    if (state.closed) throw new Error("Terminal is closed");
    cottontail.terminalSetRawMode?.(state.resource.masterFd, Boolean(enabled));
  }

  ref() {
    const state = terminalState(this);
    state.referenced = true;
    if (state.resource.watchId) cottontail.fdWatchSetRef?.(state.resource.watchId, true);
  }

  unref() {
    const state = terminalState(this);
    state.referenced = false;
    if (state.resource.watchId) cottontail.fdWatchSetRef?.(state.resource.watchId, false);
  }

  close() {
    const state = terminalState(this);
    if (state.closed) return;
    state.closed = true;
    closeTerminalResource(state.resource);
    terminalFinalizer?.unregister(state.resource);
    notifyTerminalExit(this, 0, null);
  }

  [Symbol.dispose]() {
    this.close();
  }

  async [Symbol.asyncDispose]() {
    this.close();
  }
}
function secretsError(message, code = "ERR_INVALID_ARG_TYPE") {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function validateSecretOptions(method, options, needsValue = false) {
  if (options == null) throw secretsError(`secrets.${method} requires an options object`);
  if (typeof options !== "object" || Array.isArray(options)) throw secretsError("Expected options to be an object");
  if (typeof options.service !== "string" || typeof options.name !== "string") {
    throw secretsError("Expected service and name to be strings");
  }
  if (!options.service || !options.name) throw secretsError("Expected service and name to not be empty");
  if (needsValue && typeof options.value !== "string") throw secretsError("Expected 'value' to be a string");
  return options;
}

function secretCommand(args, input = undefined) {
  return spawnSync(args, { input, stdin: input == null ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
}

function secretCommandError(result, operation) {
  const message = String(result.stderr || result.stdout || `Unable to ${operation} secret`).trim();
  const error = new Error(message);
  error.code = "ERR_SECRETS";
  throw error;
}

export const secrets = {
  async get(rawOptions) {
    const options = validateSecretOptions("get", rawOptions);
    if (process.platform === "win32") {
      return cottontail.secretGet(options.service, options.name);
    }
    if (process.platform === "darwin") {
      const result = secretCommand(["security", "find-generic-password", "-s", options.service, "-a", options.name, "-g"]);
      if (result.exitCode === 44) return null;
      if (result.exitCode !== 0) secretCommandError(result, "read");
      const output = String(result.stderr || result.stdout);
      const hex = /^password:\s+0x([0-9a-f]+)/im.exec(output);
      if (hex) return Buffer.from(hex[1], "hex").toString("utf8");
      const quoted = /^password:\s+"(.*)"\s*$/m.exec(output);
      if (quoted) return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      secretCommandError(result, "read");
    }
    if (process.platform === "linux") {
      const result = secretCommand(["secret-tool", "lookup", "service", options.service, "name", options.name]);
      if (result.exitCode !== 0 || String(result.stdout).length === 0) return null;
      return String(result.stdout).replace(/\r?\n$/, "");
    }
    throw secretsError(`Bun.secrets is not supported on ${process.platform}`, "ERR_NOT_SUPPORTED");
  },
  async set(rawOptions) {
    const options = validateSecretOptions("set", rawOptions, true);
    if (options.value === "") {
      await this.delete(options);
      return;
    }
    if (process.platform === "win32") {
      cottontail.secretSet(options.service, options.name, options.value);
      return;
    }
    if (process.platform === "darwin") {
      const args = ["security", "add-generic-password", "-U", "-s", options.service, "-a", options.name, "-w", options.value];
      if (options.allowUnrestrictedAccess === true) args.push("-A");
      const result = secretCommand(args);
      if (result.exitCode !== 0) secretCommandError(result, "store");
      return;
    }
    if (process.platform === "linux") {
      const result = secretCommand(
        ["secret-tool", "store", `--label=${options.service}`, "service", options.service, "name", options.name],
        `${options.value}\n`,
      );
      if (result.exitCode !== 0) secretCommandError(result, "store");
      return;
    }
    throw secretsError(`Bun.secrets is not supported on ${process.platform}`, "ERR_NOT_SUPPORTED");
  },
  async delete(rawOptions) {
    const options = validateSecretOptions("delete", rawOptions);
    if (process.platform === "win32") {
      return cottontail.secretDelete(options.service, options.name);
    }
    if (process.platform === "darwin") {
      const result = secretCommand(["security", "delete-generic-password", "-s", options.service, "-a", options.name]);
      if (result.exitCode === 44) return false;
      if (result.exitCode !== 0) secretCommandError(result, "delete");
      return true;
    }
    if (process.platform === "linux") {
      const existing = await this.get(options);
      if (existing == null) return false;
      const result = secretCommand(["secret-tool", "clear", "service", options.service, "name", options.name]);
      if (result.exitCode !== 0) secretCommandError(result, "delete");
      return true;
    }
    throw secretsError(`Bun.secrets is not supported on ${process.platform}`, "ERR_NOT_SUPPORTED");
  },
};
const passwordAlgorithmIds = { argon2id: 0, argon2i: 1, argon2d: 2, bcrypt: 3 };

function passwordBytes(value, name) {
  if (typeof value === "symbol") throw new TypeError(`${name} must be a string or BufferSource`);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return asBuffer(value);
  return new TextEncoder().encode(String(value));
}

function passwordAlgorithm(value = undefined) {
  let label = "argon2id";
  let timeCost = 2;
  let memoryCost = 65536;
  let cost = 10;
  if (value !== undefined) {
    if (typeof value === "string") {
      label = value;
    } else if (value && typeof value === "object") {
      if (typeof value.algorithm !== "string") throw new TypeError("options.algorithm must be a string");
      label = value.algorithm;
      if (label === "bcrypt" && value.cost !== undefined) cost = Number(value.cost);
      if (label !== "bcrypt") {
        if (value.timeCost !== undefined) timeCost = Number(value.timeCost);
        if (value.memoryCost !== undefined) memoryCost = Number(value.memoryCost);
      }
    } else {
      throw new TypeError("algorithm must be a string or options object");
    }
  }
  if (!(label in passwordAlgorithmIds)) throw new TypeError("Unsupported password algorithm");
  if (label === "bcrypt") {
    if (!Number.isInteger(cost) || cost < 4 || cost > 31) throw new RangeError("Rounds must be between 4 and 31");
  } else {
    if (!Number.isInteger(timeCost) || timeCost < 1) throw new RangeError("Time cost must be greater than 0");
    if (!Number.isInteger(memoryCost) || memoryCost < 1) throw new RangeError("Memory cost must be greater than 0");
  }
  return { id: passwordAlgorithmIds[label], label, timeCost, memoryCost, cost };
}

function passwordHashSync(value, algorithm = undefined) {
  if (arguments.length === 0) throw new TypeError("password is required");
  const bytes = passwordBytes(value, "password");
  if (bytes.byteLength === 0) throw new TypeError("password must not be empty");
  const options = passwordAlgorithm(algorithm);
  return passwordNativeCall(() => cottontail.passwordHashSync(options.id, bytes, options.timeCost, options.memoryCost, options.cost));
}

function passwordHash(value, algorithm = undefined) {
  if (arguments.length === 0) throw new TypeError("password is required");
  const bytes = passwordBytes(value, "password");
  if (bytes.byteLength === 0) throw new TypeError("password must not be empty");
  const options = passwordAlgorithm(algorithm);
  return Promise.resolve().then(() => passwordNativeCall(() => cottontail.passwordHashSync(options.id, bytes, options.timeCost, options.memoryCost, options.cost)));
}

function inferPasswordAlgorithm(hash) {
  if (hash.startsWith("$argon2id$")) return "argon2id";
  if (hash.startsWith("$argon2i$")) return "argon2i";
  if (hash.startsWith("$argon2d$")) return "argon2d";
  if (hash.startsWith("$2") || hash.startsWith("$bcrypt$")) return "bcrypt";
  throw new TypeError("Unsupported password algorithm");
}

const passwordHashPatterns = {
  argon2id: /^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
  argon2i: /^\$argon2i\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
  argon2d: /^\$argon2d\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
  bcrypt: /^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$/,
};

function passwordNativeCall(operation) {
  try {
    return operation();
  } catch (thrown) {
    if (thrown instanceof Error) throw thrown;
    throw new Error(typeof thrown === "string" ? thrown : "Password operation failed");
  }
}

function assertPasswordHashFormat(label, hash) {
  if (!passwordHashPatterns[label].test(hash)) {
    throw new Error("Password operation failed: InvalidEncoding");
  }
}

function passwordVerifySync(value, hashValue, algorithm = undefined) {
  if (arguments.length < 2) throw new TypeError("password and hash are required");
  const bytes = passwordBytes(value, "password");
  const hashBytes = passwordBytes(hashValue, "hash");
  if (bytes.byteLength === 0 || hashBytes.byteLength === 0) return false;
  const hash = new TextDecoder().decode(hashBytes);
  const options = passwordAlgorithm(algorithm === undefined ? inferPasswordAlgorithm(hash) : algorithm);
  assertPasswordHashFormat(options.label, hash);
  return passwordNativeCall(() => cottontail.passwordVerifySync(options.id, bytes, hashBytes));
}

function passwordVerify(value, hashValue, algorithm = undefined) {
  if (arguments.length < 2) throw new TypeError("password and hash are required");
  const bytes = passwordBytes(value, "password");
  const hashBytes = passwordBytes(hashValue, "hash");
  if (bytes.byteLength === 0 || hashBytes.byteLength === 0) return Promise.resolve(false);
  const hash = new TextDecoder().decode(hashBytes);
  const options = passwordAlgorithm(algorithm === undefined ? inferPasswordAlgorithm(hash) : algorithm);
  assertPasswordHashFormat(options.label, hash);
  return Promise.resolve().then(() => passwordNativeCall(() => cottontail.passwordVerifySync(options.id, bytes, hashBytes)));
}

export const password = {
  hash: passwordHash,
  hashSync: passwordHashSync,
  verify: passwordVerify,
  verifySync: passwordVerifySync,
};

export const semver = {
  order(left, right) {
    if (arguments.length < 2) throw new TypeError("Expected two arguments");
    return cottontail.semverOrder(left, right);
  },
  satisfies(version, range) {
    if (arguments.length < 2) throw new TypeError("Expected two arguments");
    return cottontail.semverSatisfies(version, range);
  },
};
const markdownBooleanOptions = [
  "tables",
  "strikethrough",
  "tasklists",
  "permissiveAutolinks",
  "permissiveUrlAutolinks",
  "permissiveWwwAutolinks",
  "permissiveEmailAutolinks",
  "hardSoftBreaks",
  "wikiLinks",
  "underline",
  "latexMath",
  "collapseWhitespace",
  "permissiveAtxHeaders",
  "noIndentedCodeBlocks",
  "noHtmlBlocks",
  "noHtmlSpans",
  "tagFilter",
  "headingIds",
  "autolinkHeadings",
];

function markdownFlags(options = {}) {
  let flags = 0;
  const values = { tables: true, strikethrough: true, tasklists: true };
  if (options && typeof options === "object") Object.assign(values, options);
  if (values.autolinks === true) values.permissiveAutolinks = true;
  else if (values.autolinks && typeof values.autolinks === "object") {
    values.permissiveUrlAutolinks = values.autolinks.url === true;
    values.permissiveWwwAutolinks = values.autolinks.www === true;
    values.permissiveEmailAutolinks = values.autolinks.email === true;
  }
  if (values.headings === true) {
    values.headingIds = true;
    values.autolinkHeadings = true;
  } else if (values.headings && typeof values.headings === "object") {
    values.headingIds = values.headings.ids === true;
    values.autolinkHeadings = values.headings.autolink === true;
  }
  for (let index = 0; index < markdownBooleanOptions.length; index += 1) {
    const camel = markdownBooleanOptions[index];
    const snake = camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if (values[camel] === true || values[snake] === true) flags += 2 ** index;
  }
  return flags;
}

function markdownInput(value) {
  if (value == null) throw new TypeError("Expected a string or buffer to render");
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return new TextDecoder().decode(asBuffer(value));
  throw new TypeError("Expected a string or buffer to render");
}

const markdownBlockCallbacks = [
  null, "blockquote", "list", "list", "listItem", "hr", "heading", "code", "html", "paragraph",
  "table", "thead", "tbody", "tr", "th", "td",
];
const markdownSpanCallbacks = ["emphasis", "strong", "link", "image", "codespan", "strikethrough"];

function markdownBlockMeta(entry, stack, source, slug) {
  switch (entry.type) {
    case 2: return { ordered: false, depth: stack.filter((item) => item.type === 2 || item.type === 3).length };
    case 3: return { ordered: true, start: entry.data, depth: stack.filter((item) => item.type === 2 || item.type === 3).length };
    case 4: {
      const parent = stack[stack.length - 1];
      const ordered = parent?.type === 3;
      const depth = Math.max(0, stack.filter((item) => item.type === 2 || item.type === 3).length - 1);
      const meta = { index: entry.childIndex, depth, ordered };
      if (ordered) meta.start = parent.data;
      const taskMark = entry.data & 0xff;
      if (taskMark !== 0) meta.checked = taskMark !== 32;
      return meta;
    }
    case 6: return slug == null ? { level: entry.data } : { level: entry.data, id: slug };
    case 7: {
      if ((entry.flags & 0x10) === 0) return undefined;
      let end = entry.data;
      while (end < source.length && !/[\s]/.test(source[end])) end += 1;
      const language = source.slice(entry.data, end);
      return language ? { language } : undefined;
    }
    case 14:
    case 15: {
      const align = [undefined, "left", "center", "right"][entry.data & 3];
      return { align };
    }
    default: return undefined;
  }
}

function renderMarkdownCallbacks(source, callbacks = {}, options = {}) {
  const events = JSON.parse(cottontail.markdownEvents(source, markdownFlags(options)));
  const stack = [{ type: 0, children: "", childIndex: 0 }];
  const appendResult = (result) => {
    if (result != null) stack[stack.length - 1].children += String(result);
  };
  for (const event of events) {
    const [kind, type, first, second] = event;
    if (kind === "b") {
      if (type === 0) continue;
      let childIndex = 0;
      if (type === 4) {
        const parent = stack[stack.length - 1];
        childIndex = parent.childIndex++;
      }
      stack.push({ type, data: first, flags: second, children: "", childIndex });
      continue;
    }
    if (kind === "s") {
      stack.push({ type, detail: { href: first, title: second }, children: "", childIndex: 0 });
      continue;
    }
    if (kind === "t") {
      const content = first;
      if (type === 1 || type === 2 || type === 3 || typeof callbacks.text !== "function") appendResult(content);
      else appendResult(callbacks.text(content));
      continue;
    }
    if (kind === "S") {
      const entry = stack.pop();
      const name = markdownSpanCallbacks[type];
      const callback = callbacks?.[name];
      if (typeof callback !== "function") appendResult(entry.children);
      else {
        let meta;
        if (type === 2) meta = entry.detail.title ? entry.detail : { href: entry.detail.href };
        else if (type === 3) meta = entry.detail.title
          ? { src: entry.detail.href, title: entry.detail.title }
          : { src: entry.detail.href };
        appendResult(meta === undefined ? callback(entry.children) : callback(entry.children, meta));
      }
      continue;
    }
    if (kind === "B") {
      if (type === 0) continue;
      const entry = stack.pop();
      const callback = callbacks?.[markdownBlockCallbacks[type]];
      if (typeof callback !== "function") appendResult(entry.children);
      else {
        const meta = markdownBlockMeta(entry, stack, source, first);
        appendResult(meta === undefined ? callback(entry.children) : callback(entry.children, meta));
      }
    }
  }
  return stack[0].children;
}

const markdownBlockTags = [
  null, "blockquote", "ul", "ol", "li", "hr", null, "pre", "html", "p",
  "table", "thead", "tbody", "tr", "th", "td",
];
const markdownSpanTags = ["em", "strong", "a", "img", "code", "del", "math", "math", "a", "u"];

function renderMarkdownReact(source, components = {}, options = {}) {
  const events = JSON.parse(cottontail.markdownEvents(source, markdownFlags(options)));
  const elementSymbol = Symbol.for(Number(options?.reactVersion) <= 18 ? "react.element" : "react.transitional.element");
  const createElement = (tag, props) => ({
    $$typeof: elementSymbol,
    type: components?.[tag] && typeof components[tag] !== "boolean" ? components[tag] : tag,
    key: null,
    ref: null,
    props,
  });
  const stack = [{ type: 0, children: [] }];
  for (const event of events) {
    const [kind, type, first, second] = event;
    if (kind === "b") {
      if (type !== 0) stack.push({ type, data: first, flags: second, children: [] });
      continue;
    }
    if (kind === "s") {
      stack.push({ type, detail: { href: first, title: second }, children: [] });
      continue;
    }
    if (kind === "t") {
      if (type === 2) stack[stack.length - 1].children.push(createElement("br", {}));
      else stack[stack.length - 1].children.push(first);
      continue;
    }
    if (kind === "S") {
      const entry = stack.pop();
      const tag = markdownSpanTags[type];
      const props = {};
      if (type === 2) {
        props.href = entry.detail.href;
        if (entry.detail.title) props.title = entry.detail.title;
      } else if (type === 3) {
        props.src = entry.detail.href;
        if (entry.detail.title) props.title = entry.detail.title;
        const alt = entry.children.filter((child) => typeof child === "string").join("");
        if (alt) props.alt = alt;
      } else if (type === 8) {
        props.target = entry.detail.href;
      } else if (type === 7) {
        props.display = true;
        props.children = entry.children;
      }
      if (type !== 3 && props.children === undefined) props.children = entry.children;
      stack[stack.length - 1].children.push(createElement(tag, props));
      continue;
    }
    if (kind === "B") {
      if (type === 0) continue;
      const entry = stack.pop();
      const tag = type === 6 ? `h${Math.min(6, Math.max(1, entry.data))}` : markdownBlockTags[type];
      const props = {};
      if (type === 6 && first != null) props.id = first;
      else if (type === 3) props.start = entry.data;
      else if (type === 4) {
        const taskMark = entry.data & 0xff;
        if (taskMark !== 0) props.checked = taskMark !== 32;
      } else if (type === 7 && (entry.flags & 0x10) !== 0) {
        let end = entry.data;
        while (end < source.length && !/[\s]/.test(source[end])) end += 1;
        const language = source.slice(entry.data, end);
        if (language) props.language = language;
      } else if (type === 14 || type === 15) {
        const align = [undefined, "left", "center", "right"][entry.data & 3];
        if (align) props.align = align;
      }
      if (type !== 5) props.children = entry.children;
      stack[stack.length - 1].children.push(createElement(tag, props));
    }
  }
  return {
    $$typeof: elementSymbol,
    type: Symbol.for("react.fragment"),
    key: null,
    ref: null,
    props: { children: stack[0].children },
  };
}

export const markdown = {
  html(input, options = {}) {
    return cottontail.markdownHtml(markdownInput(input), markdownFlags(options));
  },
  render(input, callbacks = {}, options = {}) {
    return renderMarkdownCallbacks(markdownInput(input), callbacks, options);
  },
  react(input, components = {}, options = {}) {
    return renderMarkdownReact(markdownInput(input), components, options);
  },
};
function standaloneEmbeddedFileName(path) {
  const normalized = String(path).replace(/\\/g, "/");
  for (const prefix of ["/$bunfs/root/", "B:/~BUN/root/"]) {
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  }
  const separator = normalized.lastIndexOf("/");
  return separator >= 0 ? normalized.slice(separator + 1) : normalized;
}

export const embeddedFiles = Array.from(
  globalThis.__cottontailStandaloneEmbeddedFilePaths ?? [],
  path => String(path),
).sort().map(path => {
  const embedded = file(path);
  Object.defineProperty(embedded, "name", {
    value: standaloneEmbeddedFileName(path),
    configurable: true,
    enumerable: true,
  });
  return embedded;
});
let gcAggressionLevelValue = 0;
export const unsafe = {
  arrayBufferToString(value) {
    if (value instanceof Uint16Array) {
      let output = "";
      for (let index = 0; index < value.length; index += 0x8000) {
        output += String.fromCharCode(...value.subarray(index, index + 0x8000));
      }
      return output;
    }
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : asBuffer(value);
    return new TextDecoder().decode(bytes);
  },
  gcAggressionLevel(value = undefined) {
    const previous = gcAggressionLevelValue;
    if (value !== undefined) gcAggressionLevelValue = Number(value) || 0;
    return previous;
  },
};

const defaultCSRFSecret = "cottontail-default-csrf-secret";
const defaultCSRFMaxAgeMs = 24 * 60 * 60 * 1000;
const csrfHeaderLength = 32;

function csrfAlgorithm(algorithm = "sha256") {
  const normalized = String(algorithm ?? "sha256").toLowerCase().replace(/_/g, "-");
  if (normalized === "blake2b256") return { name: "blake2b512", length: 32 };
  if (normalized === "blake2b512") return { name: "blake2b512", length: 64 };
  if (normalized === "sha512-256") return { name: "sha512", length: 32 };
  if (normalized === "sha256" || normalized === "sha384" || normalized === "sha512") return { name: normalized };
  return { name: normalized };
}

function csrfWriteU64(bytes, offset, value) {
  let current = BigInt(Math.max(0, Math.trunc(Number(value))));
  for (let index = offset + 7; index >= offset; index -= 1) {
    bytes[index] = Number(current & 0xffn);
    current >>= 8n;
  }
}

function csrfReadU64(bytes, offset) {
  let value = 0n;
  for (let index = offset; index < offset + 8; index += 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  return Number(value);
}

function csrfMac(secret, algorithm, payload) {
  const spec = csrfAlgorithm(algorithm);
  let digest = asBuffer(createHmac(spec.name, secret).update(payload).digest());
  if (spec.length != null) digest = digest.subarray(0, spec.length);
  return digest;
}

function csrfEncode(bytes, encoding = "base64url") {
  const buffer = globalThis.Buffer.from(bytes);
  if (encoding === "hex") return buffer.toString("hex");
  if (encoding === "base64") return buffer.toString("base64");
  if (encoding === "base64url" || encoding == null) {
    return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  throw new TypeError(`Unsupported CSRF token encoding: ${encoding}`);
}

function csrfDecode(token, encoding = "base64url") {
  const text = String(token);
  if (encoding === "hex") {
    if (text.length % 2 !== 0 || /[^0-9a-f]/i.test(text)) return null;
    return asBuffer(globalThis.Buffer.from(text, "hex"));
  }
  if (encoding === "base64") return asBuffer(globalThis.Buffer.from(text, "base64"));
  if (encoding === "base64url" || encoding == null) {
    if (/[^A-Za-z0-9_-]/.test(text)) return null;
    const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
    if (base64.length % 4 === 1) return null;
    return asBuffer(globalThis.Buffer.from(base64 + "=".repeat((4 - (base64.length % 4)) % 4), "base64"));
  }
  throw new TypeError(`Unsupported CSRF token encoding: ${encoding}`);
}

function csrfSecret(value) {
  const secret = value ?? defaultCSRFSecret;
  if (String(secret).length === 0) throw new TypeError("CSRF secret must not be empty");
  return secret;
}

export const CSRF = {
  generate(secret = defaultCSRFSecret, options = {}) {
    const actualSecret = csrfSecret(secret);
    const now = Date.now();
    const expiresIn = options.expiresIn == null ? defaultCSRFMaxAgeMs : Number(options.expiresIn);
    const header = new Uint8Array(csrfHeaderLength);
    csrfWriteU64(header, 0, now);
    csrfWriteU64(header, 8, now + Math.max(0, expiresIn));
    header.set(randomBytes(16), 16);
    const mac = csrfMac(actualSecret, options.algorithm, header);
    return csrfEncode(concatManyBuffers([header, mac]), options.encoding ?? "base64url");
  },
  verify(token, options = {}) {
    if (String(token ?? "").length === 0) throw new TypeError("CSRF token must not be empty");
    const actualSecret = csrfSecret(options.secret);
    const bytes = csrfDecode(token, options.encoding ?? "base64url");
    if (!bytes || bytes.byteLength <= csrfHeaderLength) return false;
    const header = bytes.subarray(0, csrfHeaderLength);
    const mac = bytes.subarray(csrfHeaderLength);
    const expected = csrfMac(actualSecret, options.algorithm, header);
    if (mac.byteLength !== expected.byteLength) return false;
    let diff = 0;
    for (let index = 0; index < mac.byteLength; index += 1) diff |= mac[index] ^ expected[index];
    if (diff !== 0) return false;
    const issuedAt = csrfReadU64(header, 0);
    const expiresAt = csrfReadU64(header, 8);
    const now = Date.now();
    if (expiresAt <= now) return false;
    if (options.maxAge != null && now - issuedAt > Number(options.maxAge)) return false;
    return true;
  },
};

let BunFile;
let CottontailAbortController;
let CottontailAbortSignal;
let CottontailCloseEvent;
let CottontailCustomEvent;
let CottontailDOMException;
let CottontailErrorEvent;
let CottontailEvent;
let CottontailEventTarget;
let abortSignalState;
let eventState;
let eventStateFor;
let inspectCustomSymbol;
let isAbortSignal;
let markEventTrusted;
let nodeTypeError;
let setEventHandlerAttributeOrder;

({
  BunFile,
  CottontailAbortController,
  CottontailAbortSignal,
  CottontailCloseEvent,
  CottontailCustomEvent,
  CottontailDOMException,
  CottontailErrorEvent,
  CottontailEvent,
  CottontailEventTarget,
  abortSignalState,
  eventState,
  eventStateFor,
  inspectCustomSymbol,
  isAbortSignal,
  markEventTrusted,
  nodeTypeError,
  setEventHandlerAttributeOrder,
} = createWebPrimitives(nodeInspect));

function makeDataCloneError(message) {
  const DOMExceptionClass = globalThis.DOMException ?? CottontailDOMException;
  return new DOMExceptionClass(message ?? "The object can not be cloned.", "DataCloneError");
}

function blobBytesSync(value) {
  if (value?._bytes instanceof Uint8Array) return value._bytes.slice();
  if (typeof value?._getBytes === "function") return value._getBytes();
  return new Uint8Array(0);
}

function cloneNativeError(value, seen) {
  let Ctor = Error;
  for (const candidate of [TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError]) {
    if (value instanceof candidate) {
      Ctor = candidate;
      break;
    }
  }
  const isAggregate = typeof AggregateError === "function" && value instanceof AggregateError;
  if (isAggregate) Ctor = AggregateError;
  const cloned = isAggregate ? new Ctor([], value.message) : new Ctor(value.message);
  seen.set(value, cloned);
  if (typeof value.name === "string" && value.name !== cloned.name) cloned.name = value.name;
  if (typeof value.stack === "string") cloned.stack = value.stack;
  if (Object.prototype.hasOwnProperty.call(value, "cause")) cloned.cause = structuredCloneValue(value.cause, seen);
  if (isAggregate) cloned.errors = structuredCloneValue(value.errors ?? [], seen);
  return cloned;
}

function structuredCloneValue(value, seen) {
  if (typeof value === "function") throw makeDataCloneError(`${value.name || "Function"}() could not be cloned.`);
  if (typeof value === "symbol") throw makeDataCloneError("Symbol values could not be cloned.");
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  const remember = (cloned) => {
    seen.set(value, cloned);
    return cloned;
  };
  if (value instanceof Date) return remember(new Date(value.getTime()));
  if (value instanceof RegExp) return remember(new RegExp(value.source, value.flags));
  if (value instanceof Boolean || value instanceof Number || value instanceof String) {
    return remember(Object(value.valueOf()));
  }
  if (typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer) return remember(value);
  if (value instanceof ArrayBuffer) {
    if (value.detached === true) throw makeDataCloneError("Cannot clone a detached ArrayBuffer");
    return remember(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    const clonedBuffer = structuredCloneValue(value.buffer, seen);
    if (value instanceof DataView) return remember(new DataView(clonedBuffer, value.byteOffset, value.byteLength));
    if (typeof globalThis.Buffer === "function" && globalThis.Buffer.isBuffer?.(value)) {
      return remember(new Uint8Array(clonedBuffer, value.byteOffset, value.length));
    }
    return remember(new value.constructor(clonedBuffer, value.byteOffset, value.length));
  }
  if (value instanceof Map) {
    const result = new Map();
    seen.set(value, result);
    for (const [key, item] of value) result.set(structuredCloneValue(key, seen), structuredCloneValue(item, seen));
    return result;
  }
  if (value instanceof Set) {
    const result = new Set();
    seen.set(value, result);
    for (const item of value) result.add(structuredCloneValue(item, seen));
    return result;
  }
  if (value instanceof Error) return cloneNativeError(value, seen);
  if (isBunFileLike(value)) {
    const source = value._bunFilePath ?? (typeof value.fd === "number" ? value.fd : value.name);
    return remember(file(source, { type: value.type }));
  }
  if (typeof globalThis.Blob === "function" && value instanceof globalThis.Blob) {
    const bytes = blobBytesSync(value);
    if (typeof globalThis.File === "function" && value instanceof globalThis.File) {
      return remember(new globalThis.File([bytes], value.name, { type: value.type, lastModified: value.lastModified }));
    }
    return remember(new globalThis.Blob([bytes], { type: value.type }));
  }
  if (value instanceof CottontailMessagePort) {
    throw makeDataCloneError("MessagePort could not be cloned; add it to the transfer list.");
  }
  if (value instanceof CottontailMessageChannel) throw makeDataCloneError("The object can not be cloned.");
  if (value instanceof Promise || value instanceof WeakMap || value instanceof WeakSet) {
    throw makeDataCloneError("The object can not be cloned.");
  }
  const cloneHook = value[Symbol.for("cottontail.structuredClone")];
  if (typeof cloneHook === "function") return remember(cloneHook.call(value));
  if (Array.isArray(value)) {
    const result = [];
    seen.set(value, result);
    for (const key of Object.keys(value)) result[key] = structuredCloneValue(value[key], seen);
    if (result.length !== value.length) result.length = value.length;
    return result;
  }
  const result = {};
  seen.set(value, result);
  for (const key of Object.keys(value)) result[key] = structuredCloneValue(value[key], seen);
  return result;
}

({
  arrayBufferFromBytes,
  bodyBlobSourceSymbol,
  bodyReadableStream,
  bodyValueForConsumption,
  bunString,
  bytesFromBody,
  bytesFromData,
  consumeStreamingBody,
  encodeMultipartFormData,
  externallyOwnedBodyBytes,
  fetchBodyStartSymbol,
  FormData,
  formDataBoundary,
  Headers,
  headersGetAll,
  inspectBodyByteSize,
  invalidHeaderErrorSymbol,
  isObjectLike,
  isURLSearchParamsLike,
  normalizeRequestUrl,
  normalizeServeDispatchUrl,
  parseMultipartFormData,
  parseMultipartFormDataText,
  Request,
  requestState,
  requestWithLazyURL,
  Response,
  responseWithMetadata,
  sharedArrayBufferBytes,
  stringLatin1FromBytes,
  stripUtf8BOMText,
} = createRequestResponseRuntime({
  activeServeRequestBodyStateSymbol,
  asBuffer,
  bodyStreamIsDisturbed,
  bodyWasUsed,
  bunInspectPropertyDescriptor,
  concatManyBuffers,
  CookieMap,
  ctInspectSymbol,
  estimatedMemoryCostSymbol,
  handledRejectedPromise,
  isAbortSignal,
  isBunFileLike,
  isStreamingBody,
  lifecycleBodyStreamFor,
  lifecycleBodyValueForConsumption,
  lifecycleTakeBody,
  nodeInspect,
  randomBytes,
  serveUpgradeContexts,
  URL,
  URLSearchParams,
}));

const BunObjectTarget = globalThis.Bun ?? {};
let bunObjectReified = Boolean(globalThis.__cottontailBunReified);
const BunObject = new Proxy(BunObjectTarget, {
  ownKeys(target) {
    bunObjectReified = true;
    globalThis.__cottontailBunReified = true;
    return Reflect.ownKeys(target);
  },
});
globalThis.__cottontailBunHasNonReifiedStatic = (value) => value === BunObject && !bunObjectReified;
// String(Bun) must be "[object Bun]".
Object.defineProperty(BunObjectTarget, Symbol.toStringTag, { value: "Bun", configurable: true });
BunObject.argv = cottontail.argv || ["cottontail", ...(cottontail.args || [])];
BunObject.env = globalThis.process?.env ?? cottontail.env();
BunObject.$ = $;
BunObject.ArrayBufferSink = ArrayBufferSink;
BunObject.CSRF = CSRF;
BunObject.Cookie = Cookie;
BunObject.CookieMap = CookieMap;
BunObject.CryptoHasher = CryptoHasher;
BunObject.FFI = FFI;
BunObject.FileSystemRouter = FileSystemRouter;
BunObject.Glob = Glob;
BunObject.HTMLRewriter = HTMLRewriter;
BunObject.JSON5 = JSON5;
BunObject.JSONC = JSONC;
BunObject.JSONL = JSONL;
BunObject.MD4 = MD4;
BunObject.MD5 = MD5;
BunObject.RedisClient = RedisClient;
BunObject.S3Client = S3Client;
BunObject.SHA1 = SHA1;
BunObject.SHA224 = SHA224;
BunObject.SHA256 = SHA256;
BunObject.SHA384 = SHA384;
BunObject.SHA512 = SHA512;
BunObject.SHA512_256 = SHA512_256;
BunObject.ShellError = ShellError;
BunObject.ShellOutput = ShellOutput;
BunObject.ShellPromise = ShellPromise;
BunObject.SQL = SQL;
BunObject.TOML = TOML;
BunObject.Terminal = Terminal;
BunObject.Transpiler = Transpiler;
BunObject.YAML = YAML;
BunObject.allocUnsafe = allocUnsafe;
BunObject.build = build;
BunObject.color = color;
BunObject.concatArrayBuffers = concatArrayBuffers;
BunObject.connect = connect;
BunObject.cwd = cwd;
BunObject.deepEquals = deepEquals;
BunObject.deepMatch = deepMatch;
BunObject.deflateSync = deflateSync;
BunObject.dns = dns;
BunObject.embeddedFiles = embeddedFiles;
BunObject.enableANSIColors = enableANSIColors;
BunObject.escapeHTML = escapeHTML;
BunObject.file = file;
BunObject.fileURLToPath = fileURLToPath;
BunObject.gc = bunForceGc;
BunObject.generateHeapSnapshot = generateHeapSnapshot;
BunObject.gunzipSync = gunzipSync;
BunObject.gzipSync = gzipSync;
BunObject.hash = hash;
BunObject.indexOfLine = indexOfLine;
BunObject.inflateSync = inflateSync;
BunObject.inspect = inspect;
BunObject.isMainThread = isMainThread;
BunObject.jest = jest;
BunObject.listen = listen;
BunObject.main = main;
BunObject.markdown = markdown;
BunObject.mmap = mmap;
BunObject.nanoseconds = nanoseconds;
BunObject.openInEditor = openInEditor;
BunObject.origin = origin;
BunObject.password = password;
BunObject.pathToFileURL = pathToFileURL;
BunObject.peek = peek;
BunObject.plugin = plugin;
BunObject.postgres = postgres;
BunObject.randomUUIDv5 = randomUUIDv5;
BunObject.randomUUIDv7 = randomUUIDv7;
BunObject.readableStreamToArray = readableStreamToArray;
BunObject.readableStreamToArrayBuffer = readableStreamToArrayBuffer;
BunObject.readableStreamToBlob = readableStreamToBlob;
BunObject.readableStreamToBytes = readableStreamToBytes;
BunObject.readableStreamToFormData = readableStreamToFormData;
BunObject.readableStreamToJSON = readableStreamToJSON;
BunObject.readableStreamToText = readableStreamToText;
BunObject.redis = redis;
BunObject.registerMacro = registerMacro;
BunObject.resolve = resolve;
BunObject.resolveSync = resolveSync;
BunObject.revision = revision;
BunObject.s3 = s3;
BunObject.secrets = secrets;
BunObject.semver = semver;
BunObject.write = write;
BunObject.which = which;
BunObject.sha = sha;
BunObject.shrink = shrink;
BunObject.sleep = sleep;
BunObject.sleepSync = sleepSync;
BunObject.sql = sql;
BunObject.stderr = stderr;
BunObject.stdin = stdin;
BunObject.stdout = stdout;
BunObject.stringWidth = stringWidth;
BunObject.stripANSI = stripANSI;
BunObject.spawn = spawn;
BunObject.spawnSync = spawnSync;
BunObject.serve = serve;
BunObject.fetch = fetch;
BunObject.Archive = Archive;
BunObject.udpSocket = udpSocket;
BunObject.unsafe = unsafe;
BunObject.version = version;
BunObject.version_with_sha = version_with_sha;
BunObject.wrapAnsi = wrapAnsi;
BunObject.zstdCompress = zstdCompress;
BunObject.zstdCompressSync = zstdCompressSync;
BunObject.zstdDecompress = zstdDecompress;
BunObject.zstdDecompressSync = zstdDecompressSync;
const bunRuntimeBridgeKey = Symbol.for("cottontail.internal.bunRuntimeBridge");
if (globalThis[bunRuntimeBridgeKey] == null) {
  Object.defineProperty(globalThis, bunRuntimeBridgeKey, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      abiVersion: 1,
      Bun: BunObject,
      fetch,
      FormData,
      Headers,
      HTMLRewriter,
      Request,
      Response,
      serve,
      stringWidth,
      stripANSI,
    }),
  });
}
if (typeof globalThis.WebAssembly === "object" && typeof globalThis.WebAssembly.compileStreaming !== "function") {
  const invalidWasmStreamingSource = (source) => {
    let received;
    if (source !== null && (typeof source === "object" || typeof source === "function")) {
      received = `an instance of ${source.constructor?.name ?? "Object"}`;
    } else if (source === null) {
      received = "null";
    } else {
      received = `type ${typeof source} (${String(source)})`;
    }
    return new TypeError(
      `The "source" argument must be an instance of Response or an Promise resolving to Response. Received ${received}`,
    );
  };

  const invalidWasmStreamingChunk = new TypeError("chunk must be an ArrayBufferView or an ArrayBuffer");
  const detachedWasmStreamingChunk = new TypeError(
    "Underlying ArrayBuffer has been detached from the view or out-of-bounds",
  );

  const wasmBytesFromBodyStream = async (response) => {
    const body = response.body;
    if (body == null) return new ArrayBuffer(0);
    const reader = body.getReader();
    const chunks = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;

        let bytes;
        if (value instanceof ArrayBuffer) {
          if (value.detached === true) {
            try { await reader.cancel(detachedWasmStreamingChunk); } catch {}
            throw detachedWasmStreamingChunk;
          }
          bytes = new Uint8Array(value);
        } else if (ArrayBuffer.isView(value)) {
          if (value.buffer?.detached === true) {
            try { await reader.cancel(detachedWasmStreamingChunk); } catch {}
            throw detachedWasmStreamingChunk;
          }
          bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        } else {
          try { await reader.cancel(invalidWasmStreamingChunk); } catch {}
          throw invalidWasmStreamingChunk;
        }
        chunks.push(bytes);
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    return arrayBufferFromBytes(concatManyBuffers(chunks));
  };

  const wasmBytesFromResponseSource = async (source) => {
    const response = await source;
    if (!(response instanceof Response)) throw invalidWasmStreamingSource(response);
    const type = String(response.headers?.get?.("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/wasm") {
      throw new TypeError(`WebAssembly response has unsupported MIME type '${type}'`);
    }
    if (response.status != null && (response.status < 200 || response.status >= 300)) {
      throw new TypeError(`WebAssembly response has status code ${response.status}`);
    }
    if (response.bodyUsed) throw new TypeError("WebAssembly response body has already been used");
    return await wasmBytesFromBodyStream(response);
  };
  // The host's async WebAssembly.compile/instantiate promises never settle;
  // back all of these with the synchronous Module/Instance constructors.
  globalThis.WebAssembly.compile = async function compile(bytes) {
    return new globalThis.WebAssembly.Module(asBuffer(bytes));
  };
  globalThis.WebAssembly.instantiate = async function instantiate(source, importObject = undefined) {
    if (source instanceof globalThis.WebAssembly.Module) {
      return new globalThis.WebAssembly.Instance(source, importObject);
    }
    const module = new globalThis.WebAssembly.Module(asBuffer(source));
    return { module, instance: new globalThis.WebAssembly.Instance(module, importObject) };
  };
  globalThis.WebAssembly.compileStreaming = async function compileStreaming(source) {
    return globalThis.WebAssembly.compile(await wasmBytesFromResponseSource(source));
  };
  globalThis.WebAssembly.instantiateStreaming = async function instantiateStreaming(source, importObject = undefined) {
    const module = await globalThis.WebAssembly.compileStreaming(source);
    return { module, instance: new globalThis.WebAssembly.Instance(module, importObject) };
  };
}

if (globalThis.navigator == null) {
  const navigatorPlatform = cottontail.platform?.() === "darwin" ? "MacIntel" :
    cottontail.platform?.() === "win32" ? "Win32" :
    `Linux ${cottontail.arch?.() === "arm64" ? "aarch64" : "x86_64"}`;
  globalThis.navigator = {
    userAgent: `Bun/${version}`,
    platform: navigatorPlatform,
    hardwareConcurrency: Number(cottontail.cpuCount?.() ?? 1) || 1,
  };
}
const initialCryptoObject = globalThis.crypto;
let initializedCryptoObject;
function initializeCryptoGlobals() {
  if (initializedCryptoObject !== undefined) return initializedCryptoObject;
  let cryptoObject = initialCryptoObject ?? {};
  // node:crypto adopts an existing global crypto object while it initializes.
  // Publish the placeholder first to avoid re-entering this lazy accessor.
  if (initialCryptoObject == null) {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      enumerable: true,
      value: cryptoObject,
      writable: true,
    });
  }
  const nodeCrypto = loadNodeCryptoModule();
  if (nodeCrypto.webcrypto !== cryptoObject) {
    cryptoObject = nodeCrypto.webcrypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      enumerable: true,
      value: cryptoObject,
      writable: true,
    });
  }
  cryptoObject.randomUUID ??= nodeCrypto.randomUUID;
  // Bun accepts ArrayBuffer/SharedArrayBuffer and does not impose WebCrypto's
  // 65536-byte quota on this convenience API.
  cryptoObject.getRandomValues = function getRandomValuesCompat(view) {
    let bytes;
    if (view instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && view instanceof SharedArrayBuffer)) {
      bytes = new Uint8Array(view);
    } else if (ArrayBuffer.isView(view)) {
      bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    } else {
      throw new TypeError("crypto.getRandomValues requires an ArrayBuffer or ArrayBuffer view");
    }
    for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
      const chunk = Math.min(65536, bytes.byteLength - offset);
      bytes.set(nodeCrypto.randomBytes(chunk), offset);
    }
    return view;
  };
  const subtleInstance = cryptoObject.subtle ?? nodeCrypto.webcrypto.subtle;
  Object.defineProperty(cryptoObject, "subtle", {
    get() { return subtleInstance; },
    set(_value) {},
    enumerable: true,
    configurable: true,
  });
  initializedCryptoObject = cryptoObject;
  return cryptoObject;
}
if (initialCryptoObject == null) {
  installLazyGlobal("crypto", initializeCryptoGlobals);
} else {
  globalThis.crypto = initializeCryptoGlobals();
}
installLazyGlobal("Crypto", () => loadNodeCryptoModule().webcrypto.constructor);
installLazyGlobal("CryptoKey", () => loadNodeCryptoModule().CryptoKey);
installLazyGlobal("SubtleCrypto", () => loadNodeCryptoModule().SubtleCrypto);
// URLPattern is uncommon and the polyfill is sizeable, so materialize it on
// first observation while preserving the ordinary writable global afterward.
installLazyGlobal("URLPattern", () => {
  const { URLPattern } = loadEmbeddedRuntimeModule("vendor/urlpattern.js");
  Object.defineProperty(URLPattern, "name", { value: "URLPattern", configurable: true });
  return URLPattern;
});
globalThis.DOMException ??= CottontailDOMException;
activeServeUnreadBodyAbortError = new globalThis.DOMException("The operation was aborted.", "AbortError");
globalThis.Event ??= CottontailEvent;
globalThis.EventTarget ??= CottontailEventTarget;
globalThis.CustomEvent ??= CottontailCustomEvent;
globalThis.ErrorEvent ??= CottontailErrorEvent;
globalThis.CloseEvent ??= CottontailCloseEvent;
if (typeof globalThis.CustomEvent?.prototype?.initCustomEvent !== "function") {
  Object.defineProperty(globalThis.CustomEvent.prototype, "initCustomEvent", {
    value: function initCustomEvent(type, bubbles = false, cancelable = false, detail = null) {
      this.initEvent(type, bubbles, cancelable);
      this.detail = detail;
    },
    writable: true,
    configurable: true,
  });
}
Object.defineProperty(CottontailEvent, "name", { value: "Event", configurable: true });

// ---------------------------------------------------------------------------
// Web messaging: MessageEvent, MessagePort/MessageChannel, BroadcastChannel,
// plus cross-thread routing over the native worker message pipe.
// ---------------------------------------------------------------------------

const messagePortConstructToken = Symbol("cottontail.MessagePort.construct");
const webPortStates = new WeakMap();
const webPortRegistry = new Map(); // portId -> MessagePort with cross-thread routing
const broadcastChannelRegistry = new Map(); // name -> channels in creation order
const broadcastChannelStates = new WeakMap();
const WEB_WIRE_KEY = "__cottontailWebWire";
const WEB_PORT_ENVELOPE = "__cottontailWebPortMessage";
const WEB_BROADCAST_ENVELOPE = "__cottontailWebBroadcast";
let webPortIdCounter = 0;
const webContextNonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffff).toString(36)}`;

function allocateWebPortId() {
  webPortIdCounter += 1;
  return `${webContextNonce}-${webPortIdCounter}`;
}

function webPortStateFor(port) {
  const state = webPortStates.get(port);
  if (!state) throw new TypeError("Can only call this method on instances of MessagePort");
  return state;
}

function collectWebTransferables(arg, senderPort) {
  let list;
  if (arg == null) {
    list = [];
  } else if (Array.isArray(arg)) {
    list = arg;
  } else if (typeof arg === "object") {
    if (arg.transfer == null) {
      list = typeof arg[Symbol.iterator] === "function" ? [...arg] : [];
    } else if (Array.isArray(arg.transfer)) {
      list = arg.transfer;
    } else if (typeof arg.transfer === "object" && typeof arg.transfer[Symbol.iterator] === "function") {
      list = [...arg.transfer];
    } else {
      throw new TypeError("Transfer list must be a sequence of transferable objects");
    }
  } else {
    throw new TypeError("Transfer list must be a sequence of transferable objects");
  }
  const seenItems = new Set();
  const transfers = [];
  const senderState = senderPort ? webPortStates.get(senderPort) : null;
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (item instanceof ArrayBuffer) {
      if (item.detached === true) throw makeDataCloneError("Cannot transfer a detached ArrayBuffer");
    } else if (item instanceof CottontailMessagePort) {
      if (item === senderPort) throw makeDataCloneError("The source port cannot be transferred");
      if (senderState && senderState.peer === item) throw makeDataCloneError("The target port cannot be transferred");
      const itemState = webPortStates.get(item);
      if (itemState?.detached) throw makeDataCloneError("MessagePort is already neutered");
    } else {
      throw makeDataCloneError("Value in the transfer list is not a transferable object");
    }
    if (seenItems.has(item)) throw makeDataCloneError("Transfer list contains a duplicate transferable");
    seenItems.add(item);
    transfers.push(item);
  }
  return transfers;
}

function buildWebTransferMap(transfers) {
  const seen = new WeakMap();
  const ports = [];
  const buffers = [];
  for (const item of transfers) {
    if (item instanceof ArrayBuffer) {
      const snapshot = item.slice(0);
      seen.set(item, snapshot);
      buffers.push(item);
    } else {
      const replacement = new CottontailMessagePort(messagePortConstructToken);
      seen.set(item, replacement);
      ports.push({ original: item, replacement });
    }
  }
  return { seen, ports, buffers };
}

function commitWebTransfer(prepared) {
  for (const buffer of prepared.buffers) {
    try {
      if (typeof buffer.transfer === "function") buffer.transfer();
    } catch {}
  }
  for (const { original, replacement } of prepared.ports) {
    const originalState = webPortStates.get(original);
    const replacementState = webPortStates.get(replacement);
    replacementState.queue = originalState.queue;
    replacementState.peer = originalState.peer;
    replacementState.remote = originalState.remote;
    if (originalState.peer) {
      const peerState = webPortStates.get(originalState.peer);
      if (peerState) peerState.peer = replacement;
    }
    if (originalState.id != null) {
      replacementState.id = originalState.id;
      if (webPortRegistry.get(originalState.id) === original) webPortRegistry.set(originalState.id, replacement);
    }
    originalState.peer = null;
    originalState.remote = null;
    originalState.queue = [];
    originalState.detached = true;
    originalState.closed = true;
  }
}

const structuredCloneFastPathMiss = Symbol("structuredCloneFastPathMiss");

function structuredCloneFlatRecord(value) {
  if (value === null || Object.getPrototypeOf(value) !== Object.prototype) return structuredCloneFastPathMiss;
  const result = {};
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (Object.prototype.__lookupGetter__.call(value, key) || Object.prototype.__lookupSetter__.call(value, key)) {
      return structuredCloneFastPathMiss;
    }
    const item = value[key];
    const type = typeof item;
    if (item !== null && (type === "object" || type === "function" || type === "symbol")) {
      return structuredCloneFastPathMiss;
    }
    if (key === "__proto__") {
      Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true });
    } else {
      result[key] = item;
    }
  }
  return result;
}

function cottontailStructuredClone(value, options = undefined) {
  if (options == null || options.transfer == null) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      if (typeof value === "symbol") throw makeDataCloneError("Symbol values could not be cloned.");
      return value;
    }
    const fastResult = structuredCloneFlatRecord(value);
    if (fastResult !== structuredCloneFastPathMiss) return fastResult;
  }
  const transfers = collectWebTransferables(options?.transfer, null);
  const prepared = buildWebTransferMap(transfers);
  const result = structuredCloneValue(value, prepared.seen);
  commitWebTransfer(prepared);
  return result;
}

function deliverToWebPort(port, data, ports) {
  const state = webPortStates.get(port);
  if (!state || state.closed || state.detached) return;
  state.queue.push({ data, ports: ports ?? [] });
  scheduleWebPortDrain(port);
}

function scheduleWebPortDrain(port) {
  const state = webPortStates.get(port);
  if (!state || state.draining) return;
  state.draining = true;
  queueMicrotask(() => {
    state.draining = false;
    if (!state.started || state.closed || state.detached) return;
    while (state.queue.length > 0 && state.started && !state.closed && !state.detached) {
      const { data, ports } = state.queue.shift();
      let event;
      try {
        event = new CottontailMessageEvent("message", { data, ports });
      } catch {
        event = new CottontailMessageEvent("message", { data });
      }
      markEventTrusted(event);
      port.dispatchEvent(event);
    }
  });
}

function sendToWebRoute(route, payload) {
  const json = JSON.stringify(payload);
  if (route?.parent) {
    cottontail.workerPostMessage?.(json);
    return;
  }
  if (route?.workerId != null) {
    cottontail.workerPostMessageTo?.(route.workerId, json);
  }
}

// -- Cross-thread wire codec (JSON-safe) ------------------------------------

function wireEncodePort(port, context) {
  const existing = context.portEncodings.get(port);
  if (existing) return existing;
  const state = webPortStates.get(port);
  if (state.id == null) state.id = allocateWebPortId();
  let peerId = null;
  if (state.peer) {
    const peerState = webPortStates.get(state.peer);
    if (peerState.id == null) peerState.id = allocateWebPortId();
    peerId = peerState.id;
    peerState.remote = { route: context.route, peerId: state.id };
    webPortRegistry.set(peerState.id, state.peer);
    peerState.peer = null;
  } else if (state.remote) {
    peerId = state.remote.peerId;
  }
  const encoded = {
    t: "Port",
    portId: state.id,
    peerId,
    pending: state.queue.map((entry) => ({
      data: wireEncodeValue(entry.data, context),
      ports: (entry.ports ?? []).map((item) => wireEncodePort(item, context)),
    })),
  };
  context.portEncodings.set(port, encoded);
  webPortRegistry.delete(state.id);
  state.detached = true;
  state.closed = true;
  state.queue = [];
  return encoded;
}

function wireDecodePort(encoded, route) {
  let port = webPortRegistry.get(encoded.portId);
  if (!port) {
    port = new CottontailMessagePort(messagePortConstructToken);
    const state = webPortStates.get(port);
    state.id = encoded.portId;
    if (encoded.peerId != null) state.remote = { route, peerId: encoded.peerId };
    webPortRegistry.set(state.id, port);
  }
  for (const entry of encoded.pending ?? []) {
    deliverToWebPort(port, wireDecodeValue(entry.data, route), (entry.ports ?? []).map((item) => wireDecodePort(item, route)));
  }
  return port;
}

function wireEncodeValue(value, context) {
  if (value === undefined) return { t: "undefined" };
  if (value === null) return { t: "null" };
  const type = typeof value;
  if (type === "boolean" || type === "string") return { t: type, v: value };
  if (type === "number") {
    if (Number.isNaN(value)) return { t: "number", v: "NaN" };
    if (value === Infinity) return { t: "number", v: "Infinity" };
    if (value === -Infinity) return { t: "number", v: "-Infinity" };
    if (Object.is(value, -0)) return { t: "number", v: "-0" };
    return { t: "number", v: value };
  }
  if (type === "bigint") return { t: "bigint", v: value.toString() };
  if (type === "function" || type === "symbol") throw makeDataCloneError("The value can not be sent to another thread.");
  const existingId = context.ids.get(value);
  if (existingId != null) return { t: "Ref", id: existingId };
  const id = (context.nextId += 1);
  context.ids.set(value, id);
  if (value instanceof CottontailMessagePort) {
    const encoded = wireEncodePort(value, context);
    return { ...encoded, id };
  }
  if (value instanceof Date) return { t: "Date", id, v: value.getTime() };
  if (value instanceof RegExp) return { t: "RegExp", id, source: value.source, flags: value.flags };
  if (value instanceof ArrayBuffer) return { t: "ArrayBuffer", id, bytes: Array.from(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    const name = typeof globalThis.Buffer === "function" && globalThis.Buffer.isBuffer?.(value)
      ? "Buffer"
      : value instanceof DataView ? "DataView" : value.constructor?.name ?? "Uint8Array";
    return { t: "View", id, name, bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  }
  if (value instanceof Map) {
    return { t: "Map", id, v: [...value].map(([key, item]) => [wireEncodeValue(key, context), wireEncodeValue(item, context)]) };
  }
  if (value instanceof Set) return { t: "Set", id, v: [...value].map((item) => wireEncodeValue(item, context)) };
  if (Array.isArray(value)) return { t: "Array", id, length: value.length, v: value.map((item) => wireEncodeValue(item, context)) };
  if (value instanceof Error) return { t: "Error", id, name: value.name, message: value.message, stack: value.stack };
  if (typeof globalThis.Blob === "function" && value instanceof globalThis.Blob) {
    const bytes = Array.from(blobBytesSync(value));
    if (typeof globalThis.File === "function" && value instanceof globalThis.File) {
      return { t: "File", id, bytes, type: value.type, name: value.name, lastModified: value.lastModified };
    }
    return { t: "Blob", id, bytes, type: value.type };
  }
  return { t: "Object", id, v: Object.keys(value).map((key) => [key, wireEncodeValue(value[key], context)]) };
}

const wireTypedArrayConstructors = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
};

function wireDecodeValue(encoded, route, refs = new Map()) {
  const remember = (value) => {
    if (encoded?.id != null) refs.set(encoded.id, value);
    return value;
  };
  switch (encoded?.t) {
    case "Ref":
      return refs.get(encoded.id);
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "boolean":
    case "string":
      return encoded.v;
    case "number":
      if (encoded.v === "NaN") return NaN;
      if (encoded.v === "Infinity") return Infinity;
      if (encoded.v === "-Infinity") return -Infinity;
      if (encoded.v === "-0") return -0;
      return Number(encoded.v);
    case "bigint":
      return BigInt(encoded.v);
    case "Port":
      return remember(wireDecodePort(encoded, route));
    case "Date":
      return remember(new Date(Number(encoded.v)));
    case "RegExp":
      return remember(new RegExp(encoded.source, encoded.flags));
    case "ArrayBuffer":
      return remember(new Uint8Array(encoded.bytes ?? []).buffer);
    case "View": {
      const bytes = new Uint8Array(encoded.bytes ?? []);
      if (encoded.name === "Buffer" && typeof globalThis.Buffer === "function") return remember(globalThis.Buffer.from(bytes));
      if (encoded.name === "DataView") return remember(new DataView(bytes.buffer));
      const Ctor = wireTypedArrayConstructors[encoded.name] ?? Uint8Array;
      return remember(new Ctor(bytes.buffer));
    }
    case "Map": {
      const map = remember(new Map());
      for (const [key, item] of encoded.v ?? []) map.set(wireDecodeValue(key, route, refs), wireDecodeValue(item, route, refs));
      return map;
    }
    case "Set": {
      const set = remember(new Set());
      for (const item of encoded.v ?? []) set.add(wireDecodeValue(item, route, refs));
      return set;
    }
    case "Array": {
      const array = remember([]);
      for (let index = 0; index < (encoded.v ?? []).length; index += 1) array[index] = wireDecodeValue(encoded.v[index], route, refs);
      if (encoded.length != null && array.length !== encoded.length) array.length = encoded.length;
      return array;
    }
    case "Error": {
      const error = new Error(encoded.message);
      if (encoded.name) error.name = encoded.name;
      if (encoded.stack) error.stack = encoded.stack;
      return remember(error);
    }
    case "Blob":
      return remember(new globalThis.Blob([new Uint8Array(encoded.bytes ?? [])], { type: encoded.type ?? "" }));
    case "File":
      return remember(new globalThis.File([new Uint8Array(encoded.bytes ?? [])], encoded.name ?? "", {
        type: encoded.type ?? "",
        lastModified: encoded.lastModified,
      }));
    case "Object": {
      const object = remember({});
      for (const [key, item] of encoded.v ?? []) object[key] = wireDecodeValue(item, route, refs);
      return object;
    }
    default:
      return undefined;
  }
}

function makeWireContext(route) {
  return { route, portEncodings: new Map(), ids: new WeakMap(), nextId: 0 };
}

function encodeWorkerWebMessage(message, transferOrOptions, route) {
  const transfers = collectWebTransferables(transferOrOptions, null);
  const prepared = buildWebTransferMap(transfers);
  const data = structuredCloneValue(message, prepared.seen);
  commitWebTransfer(prepared);
  const context = makeWireContext(route);
  const ports = prepared.ports.map((entry) => wireEncodePort(entry.replacement, context));
  return JSON.stringify({ [WEB_WIRE_KEY]: 1, data: wireEncodeValue(data, context), ports });
}

function handleWebPortEnvelope(packet, route) {
  const ports = (packet.ports ?? []).map((item) => wireDecodePort(item, route));
  const data = wireDecodeValue(packet.data, route);
  const target = webPortRegistry.get(packet.targetPortId);
  if (!target) return;
  deliverToWebPort(target, data, ports);
}

function handleWebBroadcastEnvelope(packet, fromWorker) {
  const route = fromWorker ? { workerId: fromWorker.id } : { parent: true };
  const data = wireDecodeValue(packet.data, route);
  const recipients = [...(broadcastChannelRegistry.get(packet.name) ?? [])];
  queueMicrotask(() => {
    for (const channel of recipients) {
      const state = broadcastChannelStates.get(channel);
      if (!state || state.closed) continue;
      const event = new CottontailMessageEvent("message", { data });
      markEventTrusted(event);
      channel.dispatchEvent(event);
    }
  });
  if (!cottontail.isWorker?.()) {
    broadcastToOtherThreads({ [WEB_BROADCAST_ENVELOPE]: packet }, fromWorker?.id);
  }
}

function broadcastToOtherThreads(payload, excludeWorkerId) {
  if (cottontail.isWorker?.()) {
    if (typeof cottontail.workerPostMessage === "function") cottontail.workerPostMessage(JSON.stringify(payload));
    return;
  }
  const workerIds = globalThis.__cottontailActiveWorkerIds?.() ?? [];
  if (workerIds.length === 0) return;
  const json = JSON.stringify(payload);
  for (const workerId of workerIds) {
    if (workerId === excludeWorkerId) continue;
    cottontail.workerPostMessageTo?.(workerId, json);
  }
}

// -- MessageEvent ------------------------------------------------------------

function describeMessageEventSource(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "object") return `an instance of ${value.constructor?.name ?? "Object"}`;
  if (type === "string") return `type string ('${value}')`;
  if (type === "function") return `type function (${value.name || "anonymous"})`;
  return `type ${type} (${String(value)})`;
}

class CottontailMessageEvent extends CottontailEvent {
  constructor(type, init = undefined) {
    if (arguments.length === 0) throw new TypeError("Not enough arguments");
    if (init != null && typeof init !== "object") throw new TypeError("MessageEvent constructor: eventInitDict could not be converted to a dictionary");
    const options = init ?? {};
    super(type, options);
    const state = eventState.get(this);
    state.data = options.data === undefined ? null : options.data;
    state.origin = options.origin === undefined ? "" : String(options.origin);
    state.lastEventId = options.lastEventId === undefined ? "" : String(options.lastEventId);
    const source = options.source === undefined || options.source === null ? null : options.source;
    if (source !== null) {
      const isPortLike = source instanceof CottontailMessagePort
        || (typeof source === "object" && Object.getPrototypeOf(source) !== Object.prototype && Object.getPrototypeOf(source) !== null);
      if (!isPortLike) {
        throw new TypeError(`The "eventInitDict.source" property must be of type MessagePort. Received ${describeMessageEventSource(source)}`);
      }
    }
    state.source = source;
    if (options.ports === undefined) {
      state.ports = Object.freeze([]);
    } else {
      const ports = options.ports;
      if (ports === null || typeof ports !== "object" || typeof ports[Symbol.iterator] !== "function") {
        throw new TypeError("MessageEvent constructor: eventInitDict.ports is not iterable.");
      }
      const list = [...ports];
      for (const item of list) {
        if (!(item instanceof CottontailMessagePort)) {
          throw new TypeError("MessageEvent constructor: Expected every item of eventInitDict.ports to be an instance of MessagePort.");
        }
      }
      state.ports = Object.freeze(list);
    }
  }

  get data() {
    return eventStateFor(this).data;
  }

  get origin() {
    return eventStateFor(this).origin;
  }

  get lastEventId() {
    return eventStateFor(this).lastEventId;
  }

  get source() {
    return eventStateFor(this).source;
  }

  get ports() {
    return eventStateFor(this).ports;
  }

  initMessageEvent(type, bubbles = false, cancelable = false, data = null, origin = "", lastEventId = "", source = null, ports = []) {
    const state = eventStateFor(this);
    this.initEvent(type, bubbles, cancelable);
    state.data = data;
    state.origin = String(origin ?? "");
    state.lastEventId = String(lastEventId ?? "");
    state.source = source ?? null;
    state.ports = Object.freeze([...(ports ?? [])]);
  }
}
Object.defineProperty(CottontailMessageEvent, "name", { value: "MessageEvent", configurable: true });
Object.defineProperty(CottontailMessageEvent.prototype, Symbol.toStringTag, { value: "MessageEvent", configurable: true });

// -- MessagePort / MessageChannel ---------------------------------------------

class CottontailMessagePort extends CottontailEventTarget {
  constructor(token) {
    if (token !== messagePortConstructToken) throw nodeTypeError("ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
    super();
    webPortStates.set(this, {
      id: null,
      peer: null,
      remote: null,
      queue: [],
      started: false,
      closed: false,
      detached: false,
      draining: false,
      onmessage: null,
      onmessageerror: null,
    });
  }

  get onmessage() {
    return webPortStateFor(this).onmessage;
  }

  set onmessage(handler) {
    const state = webPortStateFor(this);
    state.onmessage = typeof handler === "function" ? handler : null;
    setEventHandlerAttributeOrder(this, "message", state.onmessage);
    if (state.onmessage) this.start();
  }

  get onmessageerror() {
    return webPortStateFor(this).onmessageerror;
  }

  set onmessageerror(handler) {
    const state = webPortStateFor(this);
    state.onmessageerror = typeof handler === "function" ? handler : null;
    setEventHandlerAttributeOrder(this, "messageerror", state.onmessageerror);
  }

  postMessage(message, transferOrOptions = undefined) {
    const state = webPortStateFor(this);
    const transfers = collectWebTransferables(transferOrOptions, this);
    const prepared = buildWebTransferMap(transfers);
    const data = structuredCloneValue(message, prepared.seen);
    commitWebTransfer(prepared);
    if (state.closed || state.detached) return;
    const transferredPorts = prepared.ports.map((entry) => entry.replacement);
    if (state.remote) {
      const context = makeWireContext(state.remote.route);
      const encodedPorts = transferredPorts.map((port) => wireEncodePort(port, context));
      sendToWebRoute(state.remote.route, {
        [WEB_PORT_ENVELOPE]: {
          targetPortId: state.remote.peerId,
          data: wireEncodeValue(data, context),
          ports: encodedPorts,
        },
      });
      return;
    }
    if (!state.peer) return;
    deliverToWebPort(state.peer, data, transferredPorts);
  }

  start() {
    const state = webPortStateFor(this);
    if (state.started) return;
    state.started = true;
    scheduleWebPortDrain(this);
  }

  close() {
    const state = webPortStateFor(this);
    if (state.closed) return;
    state.closed = true;
    if (state.id != null && webPortRegistry.get(state.id) === this) webPortRegistry.delete(state.id);
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }

  get [Symbol.toStringTag]() {
    return "MessagePort";
  }
}
Object.defineProperty(CottontailMessagePort, "name", { value: "MessagePort", configurable: true });

class CottontailMessageChannel {
  constructor() {
    const port1 = new CottontailMessagePort(messagePortConstructToken);
    const port2 = new CottontailMessagePort(messagePortConstructToken);
    webPortStates.get(port1).peer = port2;
    webPortStates.get(port2).peer = port1;
    Object.defineProperty(this, "port1", { value: port1, enumerable: true });
    Object.defineProperty(this, "port2", { value: port2, enumerable: true });
  }

  get [Symbol.toStringTag]() {
    return "MessageChannel";
  }
}
Object.defineProperty(CottontailMessageChannel, "name", { value: "MessageChannel", configurable: true });

// -- BroadcastChannel ---------------------------------------------------------

function broadcastChannelStateFor(channel) {
  const state = broadcastChannelStates.get(channel);
  if (!state) throw new TypeError("Can only call this method on instances of BroadcastChannel");
  return state;
}

class CottontailBroadcastChannel extends CottontailEventTarget {
  constructor(name) {
    if (arguments.length === 0) throw new TypeError("BroadcastChannel constructor requires a name argument");
    super();
    const channelName = String(name);
    broadcastChannelStates.set(this, {
      name: channelName,
      closed: false,
      onmessage: null,
      onmessageerror: null,
    });
    const channels = broadcastChannelRegistry.get(channelName) ?? [];
    channels.push(this);
    broadcastChannelRegistry.set(channelName, channels);
  }

  get name() {
    return broadcastChannelStateFor(this).name;
  }

  get onmessage() {
    return broadcastChannelStateFor(this).onmessage;
  }

  set onmessage(handler) {
    const state = broadcastChannelStateFor(this);
    state.onmessage = typeof handler === "function" ? handler : null;
    setEventHandlerAttributeOrder(this, "message", state.onmessage);
  }

  get onmessageerror() {
    return broadcastChannelStateFor(this).onmessageerror;
  }

  set onmessageerror(handler) {
    const state = broadcastChannelStateFor(this);
    state.onmessageerror = typeof handler === "function" ? handler : null;
    setEventHandlerAttributeOrder(this, "messageerror", state.onmessageerror);
  }

  postMessage(message) {
    const state = broadcastChannelStateFor(this);
    if (arguments.length === 0) throw new TypeError("BroadcastChannel.postMessage requires a message argument");
    if (state.closed) {
      const DOMExceptionClass = globalThis.DOMException ?? CottontailDOMException;
      throw new DOMExceptionClass("BroadcastChannel is closed", "InvalidStateError");
    }
    const data = structuredCloneValue(message, new WeakMap());
    const recipients = (broadcastChannelRegistry.get(state.name) ?? []).filter((channel) => channel !== this);
    queueMicrotask(() => {
      for (const channel of recipients) {
        const channelState = broadcastChannelStates.get(channel);
        if (!channelState || channelState.closed) continue;
        const event = new CottontailMessageEvent("message", { data });
        markEventTrusted(event);
        channel.dispatchEvent(event);
      }
    });
    broadcastToOtherThreads({
      [WEB_BROADCAST_ENVELOPE]: { name: state.name, data: wireEncodeValue(data, makeWireContext(null)) },
    }, undefined);
  }

  close() {
    const state = broadcastChannelStateFor(this);
    if (state.closed) return;
    state.closed = true;
    const channels = broadcastChannelRegistry.get(state.name);
    if (channels) {
      const index = channels.indexOf(this);
      if (index >= 0) channels.splice(index, 1);
      if (channels.length === 0) broadcastChannelRegistry.delete(state.name);
    }
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }

  [inspectCustomSymbol](depth, options, inspect) {
    const state = broadcastChannelStates.get(this);
    const fields = { name: state?.name, active: !(state?.closed ?? true) };
    const render = typeof inspect === "function" ? inspect : nodeInspect;
    return `BroadcastChannel ${render(fields, options)}`;
  }

  get [Symbol.toStringTag]() {
    return "BroadcastChannel";
  }
}
Object.defineProperty(CottontailBroadcastChannel, "name", { value: "BroadcastChannel", configurable: true });

// -- Worker integration hooks --------------------------------------------------

globalThis.__cottontailWebInterceptWorkerMessage = (data, worker) => {
  if (data == null || typeof data !== "object") return false;
  if (data[WEB_PORT_ENVELOPE]) {
    handleWebPortEnvelope(data[WEB_PORT_ENVELOPE], worker ? { workerId: worker.id } : { parent: true });
    return true;
  }
  if (data[WEB_BROADCAST_ENVELOPE]) {
    handleWebBroadcastEnvelope(data[WEB_BROADCAST_ENVELOPE], worker);
    return true;
  }
  return false;
};

globalThis.__cottontailWebDecodeIncoming = (data, worker) => {
  if (data != null && typeof data === "object" && data[WEB_WIRE_KEY] === 1) {
    const route = worker ? { workerId: worker.id } : { parent: true };
    for (const encodedPort of data.ports ?? []) wireDecodePort(encodedPort, route);
    return wireDecodeValue(data.data, route);
  }
  return data;
};

globalThis.__cottontailMakeMessageEvent = (type, data) => {
  try {
    const event = new CottontailMessageEvent(String(type), { data });
    markEventTrusted(event);
    return event;
  } catch {
    return { type: String(type), data };
  }
};

function webMessagingHasActiveHandles() {
  if (broadcastChannelRegistry.size > 0) return true;
  for (const port of webPortRegistry.values()) {
    const state = webPortStates.get(port);
    if (state && !state.closed && !state.detached && state.remote) return true;
  }
  return false;
}

if (cottontail.isWorker?.()) {
  globalThis.__cottontailWebPollAlways = webMessagingHasActiveHandles;
  globalThis.__cottontailWebHasActiveHandles = webMessagingHasActiveHandles;
  globalThis.postMessage = (message, transferOrOptions = undefined) => {
    cottontail.workerPostMessage(encodeWorkerWebMessage(message, transferOrOptions, { parent: true }));
  };
}

if (typeof globalThis.Worker === "function" && globalThis.Worker.prototype && typeof cottontail.workerPostMessageTo === "function") {
  const workerPrototype = globalThis.Worker.prototype;
  workerPrototype.postMessage = function postMessage(message, transferOrOptions = undefined) {
    const encoded = encodeWorkerWebMessage(message, transferOrOptions, { workerId: this.id });
    if (typeof this._postSerialized === "function") return this._postSerialized(encoded);
    return cottontail.workerPostMessageTo(this.id, encoded);
  };
  workerPrototype.ref ??= function ref() { return this; };
  workerPrototype.unref ??= function unref() { return this; };
}

// -- Global installs ------------------------------------------------------------

globalThis.MessageEvent ??= CottontailMessageEvent;
globalThis.MessagePort ??= CottontailMessagePort;
globalThis.MessageChannel ??= CottontailMessageChannel;
globalThis.BroadcastChannel ??= CottontailBroadcastChannel;

if (typeof globalThis.SuppressedError !== "function") {
  const SuppressedErrorPolyfill = class SuppressedError extends Error {
    constructor(error, suppressed, message = undefined, options = undefined) {
      super(message, options);
      Object.defineProperty(this, "error", { value: error, writable: true, configurable: true });
      Object.defineProperty(this, "suppressed", { value: suppressed, writable: true, configurable: true });
    }
  };
  Object.defineProperty(SuppressedErrorPolyfill.prototype, "name", {
    value: "SuppressedError",
    writable: true,
    configurable: true,
  });
  globalThis.SuppressedError = SuppressedErrorPolyfill;
}

if (typeof globalThis.addEventListener !== "function") {
  const globalEventTargetInstance = new CottontailEventTarget();
  globalThis.addEventListener = (type, listener, options = undefined) =>
    globalEventTargetInstance.addEventListener(type, listener, options);
  globalThis.removeEventListener = (type, listener, options = undefined) =>
    globalEventTargetInstance.removeEventListener(type, listener, options);
  globalThis.dispatchEvent = (event) => globalEventTargetInstance.dispatchEvent(event);
}
globalThis.MessageEvent ??= CottontailMessageEvent;

// The global scope is itself an EventTarget (addEventListener/dispatchEvent on
// globalThis) with on<event> handler attributes like onerror/onmessage.
{
  const globalEventTarget = new (globalThis.EventTarget ?? CottontailEventTarget)();
  globalThis.addEventListener ??= (...args) => globalEventTarget.addEventListener(...args);
  globalThis.removeEventListener ??= (...args) => globalEventTarget.removeEventListener(...args);
  globalThis.dispatchEvent ??= (...args) => globalEventTarget.dispatchEvent(...args);
  for (const [attribute, eventName] of [["onerror", "error"], ["onmessage", "message"], ["onmessageerror", "messageerror"]]) {
    if (Object.getOwnPropertyDescriptor(globalThis, attribute)) continue;
    let handler = null;
    let listener = null;
    Object.defineProperty(globalThis, attribute, {
      get() {
        return handler;
      },
      set(value) {
        if (listener !== null) {
          globalThis.removeEventListener(eventName, listener);
          listener = null;
        }
        handler = typeof value === "function" ? value : null;
        if (handler !== null) {
          listener = (event) => handler.call(globalThis, event);
          globalThis.addEventListener(eventName, listener);
        }
      },
      enumerable: true,
      configurable: true,
    });
  }
  let reportErrorFooterRegistered = false;
  const reportErrorPlatformName = () => ({
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
  })[globalThis.process?.platform] ?? String(globalThis.process?.platform ?? "unknown");
  globalThis.reportError ??= function reportError(error) {
    if (globalThis.__cottontailCurrentTestToken?.() != null) return;
    const event = new CottontailErrorEvent("error", {
      message: error instanceof globalThis.Error ? String(error.message ?? "") : String(error),
      error,
      cancelable: true,
    });
    globalThis.dispatchEvent(event);
    if (event.defaultPrevented) return;

    if (!(error instanceof globalThis.Error)) {
      const primitive = error === null || (typeof error !== "object" && typeof error !== "function");
      const text = primitive ? String(error ?? "null") : "";
      globalThis.process?.stderr?.write?.(`${text ? `error: ${text}` : "error"}\n`);
    }
    const reportErrorConsole = console?.[Symbol.for("cottontail.reportError.console")];
    if (error instanceof globalThis.Error && typeof reportErrorConsole === "function") reportErrorConsole(error);
    else console.error(error);
    if (globalThis.process) globalThis.process.exitCode = 1;
    if (!reportErrorFooterRegistered && typeof globalThis.process?.once === "function") {
      reportErrorFooterRegistered = true;
      globalThis.process.once("exit", () => {
        const version = globalThis.Bun?.version ?? "0.0.0-cottontail";
        const arch = globalThis.process?.arch ?? "unknown";
        globalThis.process?.stderr?.write?.(`\nBun v${version} (${reportErrorPlatformName()} ${arch})\n`);
      });
    }
  };
}

// Web Performance surface: illegal-constructor classes over the basic clock
// installed by ffi.js, plus mark/measure entries and PerformanceObserver.
{
  const allowConstruct = Symbol("cottontail.performance.construct");
  const perfEntries = [];
  const perfObservers = new Set();
  const clock = globalThis.performance ?? {};
  const perfNow = typeof clock.now === "function" ? clock.now.bind(clock) : () => Date.now();
  const perfTimeOrigin = Number(clock.timeOrigin ?? Date.now());

  class PerformanceEntry {
    constructor(...args) {
      if (args[0] !== allowConstruct) throw new TypeError("Illegal constructor");
    }
    toJSON() {
      return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration };
    }
  }
  const makeEntry = (Ctor, name, entryType, startTime, duration, detail = null) => {
    const entry = new Ctor(allowConstruct);
    entry.name = String(name);
    entry.entryType = entryType;
    entry.startTime = startTime;
    entry.duration = duration;
    if (Ctor !== PerformanceEntry) entry.detail = detail == null ? null : (typeof structuredClone === "function" ? structuredClone(detail) : detail);
    return entry;
  };
  class PerformanceMark extends PerformanceEntry {}
  class PerformanceMeasure extends PerformanceEntry {}
  class PerformanceResourceTiming extends PerformanceEntry {}
  class PerformanceServerTiming {
    constructor() {
      throw new TypeError("Illegal constructor");
    }
  }
  class PerformanceTiming {
    constructor() {
      throw new TypeError("Illegal constructor");
    }
  }

  const entryListRecords = new WeakMap();
  class PerformanceObserverEntryList {
    constructor(...args) {
      if (args[0] !== allowConstruct) throw new TypeError("Illegal constructor");
      entryListRecords.set(this, args[1] ?? []);
    }
    getEntries() {
      return [...entryListRecords.get(this)];
    }
    getEntriesByName(name, type = undefined) {
      return entryListRecords.get(this).filter((item) => item.name === String(name) && (type == null || item.entryType === type));
    }
    getEntriesByType(type) {
      return entryListRecords.get(this).filter((item) => item.entryType === String(type));
    }
  }

  const notifyObservers = (entry) => {
    for (const observer of [...perfObservers]) {
      if (!observer._types.has(entry.entryType)) continue;
      observer._buffer.push(entry);
      if (observer._pending) continue;
      observer._pending = true;
      queueMicrotask(() => {
        observer._pending = false;
        const records = observer._buffer.splice(0);
        if (records.length === 0) return;
        observer._callback(new PerformanceObserverEntryList(allowConstruct, records), observer);
      });
    }
  };
  const entryStart = (reference) => {
    if (reference == null) return 0;
    if (typeof reference === "number") return reference;
    const named = perfEntries.filter((entry) => entry.name === String(reference));
    if (named.length === 0) throw new TypeError(`No mark named '${reference}' exists`);
    return named[named.length - 1].startTime;
  };

  class Performance extends (globalThis.EventTarget ?? CottontailEventTarget) {
    constructor(...args) {
      super();
      if (args[0] !== allowConstruct) throw new TypeError("Illegal constructor");
    }
    get timeOrigin() {
      return perfTimeOrigin;
    }
    now() {
      return perfNow();
    }
    mark(name, options = undefined) {
      const mark = makeEntry(PerformanceMark, name, "mark", options?.startTime ?? perfNow(), 0, options?.detail);
      perfEntries.push(mark);
      notifyObservers(mark);
      return mark;
    }
    measure(name, startOrOptions = undefined, endMark = undefined) {
      let start = 0;
      let end = perfNow();
      let detail = null;
      if (startOrOptions != null && typeof startOrOptions === "object") {
        detail = startOrOptions.detail ?? null;
        if (startOrOptions.start != null) start = entryStart(startOrOptions.start);
        if (startOrOptions.end != null) end = entryStart(startOrOptions.end);
        if (startOrOptions.duration != null) {
          if (startOrOptions.end == null) end = start + Number(startOrOptions.duration);
          else if (startOrOptions.start == null) start = end - Number(startOrOptions.duration);
        }
      } else {
        if (startOrOptions != null) start = entryStart(startOrOptions);
        if (endMark != null) end = entryStart(endMark);
      }
      const measure = makeEntry(PerformanceMeasure, name, "measure", start, end - start, detail);
      perfEntries.push(measure);
      notifyObservers(measure);
      return measure;
    }
    getEntries() {
      return [...perfEntries];
    }
    getEntriesByName(name, type = undefined) {
      return perfEntries.filter((entry) => entry.name === String(name) && (type == null || entry.entryType === type));
    }
    getEntriesByType(type) {
      return perfEntries.filter((entry) => entry.entryType === String(type));
    }
    clearMarks(name = undefined) {
      for (let index = perfEntries.length - 1; index >= 0; index -= 1) {
        if (perfEntries[index].entryType === "mark" && (name == null || perfEntries[index].name === String(name))) perfEntries.splice(index, 1);
      }
    }
    clearMeasures(name = undefined) {
      for (let index = perfEntries.length - 1; index >= 0; index -= 1) {
        if (perfEntries[index].entryType === "measure" && (name == null || perfEntries[index].name === String(name))) perfEntries.splice(index, 1);
      }
    }
    clearResourceTimings() {
      for (let index = perfEntries.length - 1; index >= 0; index -= 1) {
        if (perfEntries[index].entryType === "resource") perfEntries.splice(index, 1);
      }
    }
    setResourceTimingBufferSize(maxSize) {
      resourceTimingBufferSize = Math.max(0, Number(maxSize) || 0);
    }
    toJSON() {
      return { timeOrigin: perfTimeOrigin, eventCounts: {} };
    }
    // Estimated retained bytes for bun:jsc's estimateShallowMemoryUsageOf():
    // the buffered entries are owned by this object, so the shallow cost must
    // grow as marks/measures accumulate (mirrors WebCore's memoryCost()).
    get [Symbol.for("cottontail.estimatedMemoryCost")]() {
      let cost = 256;
      for (const entry of perfEntries) cost += 64 + entry.name.length * 2;
      return cost;
    }
  }
  let resourceTimingBufferSize = 250;
  Performance.prototype.onresourcetimingbufferfull = null;

  class PerformanceObserver {
    constructor(callback) {
      if (typeof callback !== "function") throw new TypeError("The callback argument must be a function");
      this._callback = callback;
      this._types = new Set();
      this._buffer = [];
      this._pending = false;
    }
    static get supportedEntryTypes() {
      return ["mark", "measure"];
    }
    observe(options = {}) {
      if (Array.isArray(options.entryTypes)) this._types = new Set(options.entryTypes.map(String));
      else if (options.type != null) this._types = new Set([String(options.type)]);
      else throw new TypeError("Either entryTypes or type must be specified");
      perfObservers.add(this);
    }
    disconnect() {
      perfObservers.delete(this);
    }
    takeRecords() {
      return this._buffer.splice(0);
    }
  }

  const perfInstance = new Performance(allowConstruct);
  // preserve any extra host-provided members (e.g. eventLoopUtilization from node:perf_hooks)
  for (const key of Object.keys(clock)) {
    if (!(key in Performance.prototype) && key !== "timeOrigin") perfInstance[key] = clock[key];
  }
  globalThis.performance = perfInstance;
  globalThis.Performance = Performance;
  globalThis.PerformanceEntry = PerformanceEntry;
  globalThis.PerformanceMark = PerformanceMark;
  globalThis.PerformanceMeasure = PerformanceMeasure;
  globalThis.PerformanceObserver ??= PerformanceObserver;
  globalThis.PerformanceObserverEntryList ??= PerformanceObserverEntryList;
  globalThis.PerformanceResourceTiming ??= PerformanceResourceTiming;
  globalThis.PerformanceServerTiming ??= PerformanceServerTiming;
  globalThis.PerformanceTiming ??= PerformanceTiming;
}

const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
if (!webSocketDescriptor || typeof webSocketDescriptor.value !== "function") {
  if (!webSocketDescriptor || webSocketDescriptor.configurable) {
    if (webSocketDescriptor) delete globalThis.WebSocket;
    installLazyGlobal("WebSocket", () => {
      const WebSocket = initializeNodeHttp().WebSocket;
      if (typeof WebSocket !== "function") {
        throw new TypeError("node:http did not expose WebSocket");
      }
      return WebSocket;
    }, () => {
      patchWebSocketClientForBun();
      installWebSocketMemoryAccounting();
    });
  }
}
// ffi.js installs the same public File contract early enough for node:buffer
// to capture it. Preserve that constructor identity across both APIs.
globalThis.File ??= BunFile;
globalThis.AbortSignal ??= CottontailAbortSignal;
globalThis.AbortController ??= CottontailAbortController;
globalThis.structuredClone ??= cottontailStructuredClone;
if (
  typeof globalThis.SharedArrayBuffer === "function" &&
  new globalThis.SharedArrayBuffer(0) instanceof globalThis.ArrayBuffer
) {
  const nativeHasInstance = globalThis.Function.prototype[Symbol.hasInstance];
  Object.defineProperty(globalThis.ArrayBuffer, Symbol.hasInstance, {
    configurable: true,
    writable: true,
    value(value) {
      if (nativeHasInstance.call(globalThis.SharedArrayBuffer, value)) return false;
      return nativeHasInstance.call(globalThis.ArrayBuffer, value);
    },
  });
}
if (globalThis.fetch == null) {
  Object.defineProperty(fetch, "name", { value: "fetch", configurable: true });
  globalThis.fetch = fetch;
}
{
  // self defaults to globalThis but stays a plain assignable property
  // (globalThis.self = 123 must stick), exposed as a get/set accessor pair.
  let selfValue = globalThis;
  Object.defineProperty(globalThis, "self", {
    get() {
      return selfValue;
    },
    set(value) {
      selfValue = value;
    },
    enumerable: true,
    configurable: true,
  });
}
for (const [ctor, name] of [
  [globalThis.Blob, "Blob"],
  [globalThis.TextDecoder, "TextDecoder"],
  [globalThis.TextEncoder, "TextEncoder"],
  [Request, "Request"],
  [Response, "Response"],
  [Headers, "Headers"],
  [HTMLRewriter, "HTMLRewriter"],
  [Transpiler, "Transpiler"],
  [globalThis.Buffer, "Buffer"],
  [globalThis.File, "File"],
]) {
  if (typeof ctor === "function") Object.defineProperty(ctor, "name", { value: name, configurable: true });
}
globalThis.Bun = BunObject;
if (typeof globalThis.TextEncoder === "function" && typeof globalThis.TextEncoder.prototype.encodeInto !== "function") {
  Object.defineProperty(globalThis.TextEncoder.prototype, "encodeInto", {
    value(source = "", destination) {
      if (!(destination instanceof Uint8Array) && destination?.[Symbol.toStringTag] !== "Uint8Array") throw new TypeError("TextEncoder.encodeInto requires a Uint8Array destination");
      const input = String(source);
      let read = 0;
      let written = 0;
      while (read < input.length) {
        const codePoint = input.codePointAt(read);
        const width = codePoint > 0xffff ? 2 : 1;
        const encoded = this.encode(input.slice(read, read + width));
        if (written + encoded.byteLength > destination.byteLength) break;
        destination.set(encoded, written);
        written += encoded.byteLength;
        read += width;
      }
      return { read, written };
    },
    configurable: true,
    writable: true,
  });
}
// Capture the pristine web globals at runtime evaluation: Bun's undici
// builtin binds the originals even if user code later replaces the globals
// (undici-primordials test sets them all to 42 before requiring undici).
const undiciPrimordialGlobals = {
  fetch,
  Response,
  Request,
  Headers,
  FormData,
  File: globalThis.File,
  Blob: globalThis.Blob,
  URL,
  URLSearchParams,
  AbortSignal: globalThis.AbortSignal,
  AbortController: globalThis.AbortController,
  WebSocket: globalThis.WebSocket,
  CloseEvent: globalThis.CloseEvent,
  ErrorEvent: globalThis.ErrorEvent,
  MessageEvent: globalThis.MessageEvent,
  EventTarget: globalThis.EventTarget,
};
const loadUndiciBuiltin = createLazyModule("node:undici", () => {
  const { createUndiciModule } = loadEmbeddedRuntimeModule("node/undici.js");
  return createUndiciModule(undiciPrimordialGlobals);
});
const undiciBuiltin = createLazyBuiltin(loadUndiciBuiltin);
nodeSetBuiltinModules({
  bun: BunObject,
  "bun:test": bunTestBuiltin,
  "bun:jsc": bunJSCBuiltin,
  "bun:ffi": FFI.default ?? FFI,
  "bun:sqlite": bunSQLiteBuiltin,
  "bun:internal-for-testing": bunInternalForTestingModule,
  ws: webSocketBuiltin,
  "ws/lib/websocket": webSocketBuiltin,
  "next/dist/compiled/ws": webSocketBuiltin,
  undici: undiciBuiltin,
  "node:undici": undiciBuiltin,
});
globalThis.HTMLRewriter ??= HTMLRewriter;
globalThis.require ??= nodeCreateRequire(globalThis.process?.argv?.[1] ?? cottontail.cwd());
globalThis.__cottontailImportMetaResolveSync ??= (specifier, parent = globalThis.__cottontailImportMeta?.path ?? cottontail.cwd()) =>
  resolveSync(specifier, parent);
globalThis.__cottontailImportMetaResolve ??= (specifier, parent = globalThis.__cottontailImportMeta?.path ?? cottontail.cwd()) => {
  const text = String(specifier);
  if (text.startsWith("node:") || text.startsWith("bun:") || text.startsWith("file:")) return text;
  if (text.startsWith(".") || text.startsWith("/")) return new URL(text, pathToFileURL(parent).href).href;
  const resolved = resolveSync(text, parent);
  return String(resolved).startsWith("/") ? pathToFileURL(resolved).href : resolved;
};
for (const name of [
  "test",
  "it",
  "describe",
  "expect",
  "expectTypeOf",
  "beforeAll",
  "afterAll",
  "beforeEach",
  "afterEach",
  "xit",
  "xtest",
  "xdescribe",
]) {
  // Resolve to the already-shared bun:test instance when one exists: the
  // bunfig preload path evaluates the module through the ESM loader, and a
  // second lazy evaluation would swallow global hook registrations
  // (beforeEach never firing in describe-scoped suites).
  installLazyGlobal(name, () => (globalThis[Symbol.for("cottontail.internal.bunTestModule")] ?? loadBunTestModule())[name]);
}
if (globalThis.Headers?.prototype && typeof globalThis.Headers.prototype.getAll !== "function") {
  Object.defineProperty(globalThis.Headers.prototype, "getAll", {
    value: headersGetAll,
    configurable: true,
    writable: true,
  });
}
globalThis.Headers ??= Headers;
globalThis.FormData ??= FormData;
globalThis.Request ??= Request;
globalThis.Response ??= Response;
{
  // The runtime owns the URL globals; any existing value is only the weaker
  // ffi.js bootstrap shim. Carry over the object-URL registry statics that
  // ffi.js may have installed on the shim before replacing it.
  const priorURL = globalThis.URL;
  if (priorURL && priorURL !== URL) {
    for (const key of ["createObjectURL", "revokeObjectURL", "__cottontailObjectURLRegistryInstalled"]) {
      const descriptor = Object.getOwnPropertyDescriptor(priorURL, key);
      if (descriptor && !Object.getOwnPropertyDescriptor(URL, key)) Object.defineProperty(URL, key, descriptor);
    }
  }
  globalThis.URL = URL;
  globalThis.URLSearchParams = URLSearchParams;
}

// Bun auto-starts an HTTP server when the entry module's default export is a
// serve()-style config object with a fetch handler (`bun server.js` where
// server.js only exports the config). The bundled entry namespace is not
// reachable from this module, so approximate Bun's entry-point wrapper: when
// the process is about to exit without ever starting a server, re-import
// entries that statically look like pure serve-config modules and serve their
// default export. The static gate (export default + fetch, no serve()/test
// calls) keeps the re-evaluation limited to side-effect-free config modules.
(function scheduleEntryAutoServe() {
  if (globalThis.__cottontailAutoServeInstalled) return;
  globalThis.__cottontailAutoServeInstalled = true;
  const processObject = globalThis.process;
  const entryPath = String(processObject?.argv?.[1] ?? "");
  if (!entryPath || typeof processObject?.on !== "function") return;
  let source = "";
  try { source = String(cottontail.readFile(entryPath)); } catch { return; }
  if (!/\bexport\s+default\b/.test(source)) return;
  if (!/\bfetch\b/.test(source) || /\bserve\s*\(/i.test(source) || /\bbun:test\b/.test(source) || /\blisten\s*\(/.test(source)) return;
  let fired = false;
  processObject.on("beforeExit", () => {
    if (fired) return;
    fired = true;
    if (activeServeOrigins.size > 0 || globalThis.__cottontailServeEverCalled) return;
    const entryAbs = entryPath.startsWith("/") ? entryPath : `${processObject.cwd()}/${entryPath}`;
    // The bundler lowers dynamic import() to a host hook that may resolve
    // synchronously; normalize through Promise.resolve.
    let imported;
    try { imported = import(entryAbs); } catch { return; }
    Promise.resolve(imported).then((ns) => {
      let config = ns == null ? null : ns.default;
      // Runtime dynamic import interop can nest the namespace default.
      for (let depth = 0; depth < 3 && config != null && typeof config === "object" &&
        typeof config.fetch !== "function" && config.default != null && config.default !== config; depth += 1) {
        config = config.default;
      }
      if (config == null || typeof config !== "object") return;
      if (typeof config.fetch !== "function" || typeof config.stop === "function") return;
      const server = serve(config);
      console.log(`Started development server: http://localhost:${server.port}`);
    }).catch(() => {});
  });
})();

const argv = BunObject.argv;
const env = BunObject.env;

export { BunObject as Bun, argv, env, which };
export default BunObject;
