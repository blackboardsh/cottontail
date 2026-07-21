// Loader for vendored Node.js internal modules (see ./vendor/).
//
// The files in ./vendor/ are verbatim copies of Node.js built-in module
// sources (extracted from a Node binary via process.binding('natives')),
// each wrapped in an exported factory(module, exports, require,
// internalBinding, primordials) function. This file provides the pieces
// Node's loader would normally supply: the `primordials` object, a CommonJS
// style require() over the vendored registry, JS implementations of the
// native internalBinding() surfaces the vendored modules touch, and bridges
// to cottontail's own runtime modules for `require('events')` and friends.
import buildPrimordials from "./vendor/per_context__primordials.js";
import { vendored } from "./vendor/registry.js";
import * as typesModule from "../types.js";
import * as bufferModule from "../../buffer.js";
import * as eventsModule from "../../events.js";
import * as stringDecoderModule from "../../string_decoder.js";
import * as pathModule from "../../path.js";
import * as urlModule from "../../url.js";
import * as osModule from "../../os.js";
import * as fsModule from "../../fs.js";
import * as timersModule from "../../timers.js";
import * as streamModule from "../../stream.js";

// Pre-seed entries that Node v24's per-context primordials script does not
// define but the vendored modules can reach (e.g. reconstructing a
// prototype-less Float16Array); extra keys survive the script's freeze.
const primordialsSeed = {};
if (typeof globalThis.Float16Array === "function") {
  primordialsSeed.Float16Array = globalThis.Float16Array;
}
export const primordials = buildPrimordials(primordialsSeed);

// ---------------------------------------------------------------------------
// internalBinding('uv') data: [errno, code, message] triples matching libuv.
// (Extracted from Node.js v24.11.1 on darwin; the negative-4xxx entries are
// platform-independent libuv codes.)
const uvEntries = [
  [-7, "E2BIG", "argument list too long"],
  [-13, "EACCES", "permission denied"],
  [-48, "EADDRINUSE", "address already in use"],
  [-49, "EADDRNOTAVAIL", "address not available"],
  [-47, "EAFNOSUPPORT", "address family not supported"],
  [-35, "EAGAIN", "resource temporarily unavailable"],
  [-3000, "EAI_ADDRFAMILY", "address family not supported"],
  [-3001, "EAI_AGAIN", "temporary failure"],
  [-3002, "EAI_BADFLAGS", "bad ai_flags value"],
  [-3013, "EAI_BADHINTS", "invalid value for hints"],
  [-3003, "EAI_CANCELED", "request canceled"],
  [-3004, "EAI_FAIL", "permanent failure"],
  [-3005, "EAI_FAMILY", "ai_family not supported"],
  [-3006, "EAI_MEMORY", "out of memory"],
  [-3007, "EAI_NODATA", "no address"],
  [-3008, "EAI_NONAME", "unknown node or service"],
  [-3009, "EAI_OVERFLOW", "argument buffer overflow"],
  [-3014, "EAI_PROTOCOL", "resolved protocol is unknown"],
  [-3010, "EAI_SERVICE", "service not available for socket type"],
  [-3011, "EAI_SOCKTYPE", "socket type not supported"],
  [-37, "EALREADY", "connection already in progress"],
  [-9, "EBADF", "bad file descriptor"],
  [-16, "EBUSY", "resource busy or locked"],
  [-89, "ECANCELED", "operation canceled"],
  [-4080, "ECHARSET", "invalid Unicode character"],
  [-53, "ECONNABORTED", "software caused connection abort"],
  [-61, "ECONNREFUSED", "connection refused"],
  [-54, "ECONNRESET", "connection reset by peer"],
  [-39, "EDESTADDRREQ", "destination address required"],
  [-17, "EEXIST", "file already exists"],
  [-14, "EFAULT", "bad address in system call argument"],
  [-27, "EFBIG", "file too large"],
  [-65, "EHOSTUNREACH", "host is unreachable"],
  [-4, "EINTR", "interrupted system call"],
  [-22, "EINVAL", "invalid argument"],
  [-5, "EIO", "i/o error"],
  [-56, "EISCONN", "socket is already connected"],
  [-21, "EISDIR", "illegal operation on a directory"],
  [-62, "ELOOP", "too many symbolic links encountered"],
  [-24, "EMFILE", "too many open files"],
  [-40, "EMSGSIZE", "message too long"],
  [-63, "ENAMETOOLONG", "name too long"],
  [-50, "ENETDOWN", "network is down"],
  [-51, "ENETUNREACH", "network is unreachable"],
  [-23, "ENFILE", "file table overflow"],
  [-55, "ENOBUFS", "no buffer space available"],
  [-19, "ENODEV", "no such device"],
  [-2, "ENOENT", "no such file or directory"],
  [-12, "ENOMEM", "not enough memory"],
  [-4056, "ENONET", "machine is not on the network"],
  [-42, "ENOPROTOOPT", "protocol not available"],
  [-28, "ENOSPC", "no space left on device"],
  [-78, "ENOSYS", "function not implemented"],
  [-57, "ENOTCONN", "socket is not connected"],
  [-20, "ENOTDIR", "not a directory"],
  [-66, "ENOTEMPTY", "directory not empty"],
  [-38, "ENOTSOCK", "socket operation on non-socket"],
  [-45, "ENOTSUP", "operation not supported on socket"],
  [-84, "EOVERFLOW", "value too large for defined data type"],
  [-1, "EPERM", "operation not permitted"],
  [-32, "EPIPE", "broken pipe"],
  [-100, "EPROTO", "protocol error"],
  [-43, "EPROTONOSUPPORT", "protocol not supported"],
  [-41, "EPROTOTYPE", "protocol wrong type for socket"],
  [-34, "ERANGE", "result too large"],
  [-30, "EROFS", "read-only file system"],
  [-58, "ESHUTDOWN", "cannot send after transport endpoint shutdown"],
  [-29, "ESPIPE", "invalid seek"],
  [-3, "ESRCH", "no such process"],
  [-60, "ETIMEDOUT", "connection timed out"],
  [-26, "ETXTBSY", "text file is busy"],
  [-18, "EXDEV", "cross-device link not permitted"],
  [-4094, "UNKNOWN", "unknown error"],
  [-4095, "EOF", "end of file"],
  [-6, "ENXIO", "no such device or address"],
  [-31, "EMLINK", "too many links"],
  [-64, "EHOSTDOWN", "host is down"],
  [-4030, "EREMOTEIO", "remote I/O error"],
  [-25, "ENOTTY", "inappropriate ioctl for device"],
  [-79, "EFTYPE", "inappropriate file type or format"],
  [-92, "EILSEQ", "illegal byte sequence"],
  [-44, "ESOCKTNOSUPPORT", "socket type not supported"],
  [-96, "ENODATA", "no data available"],
  [-4023, "EUNATCH", "protocol driver not attached"],
  [-8, "ENOEXEC", "exec format error"],
];
export const uvErrorMap = new Map(uvEntries.map(([errno, code, message]) => [errno, [code, message]]));

const signalsDarwin = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
  SIGIOT: 6, SIGBUS: 10, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 30, SIGSEGV: 11,
  SIGUSR2: 31, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 20,
  SIGCONT: 19, SIGSTOP: 17, SIGTSTP: 18, SIGTTIN: 21, SIGTTOU: 22,
  SIGURG: 16, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27,
  SIGWINCH: 28, SIGIO: 23, SIGINFO: 29, SIGSYS: 12,
};
const signalsLinux = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
  SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11,
  SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16,
  SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21,
  SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26,
  SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31,
};
const osSignals = (globalThis.cottontail?.platform ?? "darwin") === "linux" ? signalsLinux : signalsDarwin;

// ---------------------------------------------------------------------------
// internalBinding('util') implemented in JS.
const promisePeekStates = globalThis.__cottontailPromisePeekStates ??= new WeakMap();
const proxyDetails = globalThis.__cottontailProxyDetails ??= new WeakMap();

const utilBindingConstants = {
  kPending: 0, kFulfilled: 1, kRejected: 2,
  kExiting: 0, kExitCode: 1, kHasExitCode: 2,
  ALL_PROPERTIES: 0, ONLY_WRITABLE: 1, ONLY_ENUMERABLE: 2, ONLY_CONFIGURABLE: 4,
  SKIP_STRINGS: 8, SKIP_SYMBOLS: 16,
  kDisallowCloneAndTransfer: 0, kTransferable: 1, kCloneable: 2,
};

function isArrayIndexKey(key) {
  if (typeof key !== "string") return false;
  if (key === "0") return true;
  if (!/^[1-9][0-9]*$/.test(key)) return false;
  const asNumber = Number(key);
  return asNumber < 2 ** 32 - 1;
}

function getOwnNonIndexProperties(object, filter) {
  const result = [];
  const descriptors = Object.getOwnPropertyDescriptors(object);
  const onlyEnumerable = (filter & utilBindingConstants.ONLY_ENUMERABLE) !== 0;
  const skipStrings = (filter & utilBindingConstants.SKIP_STRINGS) !== 0;
  const skipSymbols = (filter & utilBindingConstants.SKIP_SYMBOLS) !== 0;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "string") {
      if (skipStrings || isArrayIndexKey(key)) continue;
    } else if (skipSymbols) {
      continue;
    }
    const descriptor = descriptors[key];
    if (onlyEnumerable && !descriptor.enumerable) continue;
    if ((filter & utilBindingConstants.ONLY_WRITABLE) !== 0 && !descriptor.writable) continue;
    if ((filter & utilBindingConstants.ONLY_CONFIGURABLE) !== 0 && !descriptor.configurable) continue;
    result.push(key);
  }
  return result;
}

function getPromiseDetails(promise) {
  if (!typesModule.isPromise(promise)) return undefined;
  // Promise state/result tracking remains best effort. The Bun global patches
  // Promise.resolve/reject to record states here.
  const state = promisePeekStates.get(promise);
  if (state === undefined) return [utilBindingConstants.kPending];
  if (state.status === "fulfilled") return [utilBindingConstants.kFulfilled, state.value];
  if (state.status === "rejected") return [utilBindingConstants.kRejected, state.value];
  return [utilBindingConstants.kPending];
}

function getProxyDetails(proxy, fullProxy = true) {
  const details = proxyDetails.get(proxy);
  if (details === undefined) return undefined;
  // The runtime installs a Proxy around Date to provide V8-compatible date
  // parsing. It is an implementation detail, not a user-observable proxy.
  if (proxy === globalThis.Date &&
      typeof details.target === "function" &&
      details.target.name === "Date") {
    return undefined;
  }
  if (details.revoked) return fullProxy !== false ? [null, null] : null;
  return fullProxy !== false ? [details.target, details.handler] : details.target;
}

function getConstructorName(object) {
  let current = object;
  while (current !== null && current !== undefined) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "constructor");
    if (descriptor !== undefined && typeof descriptor.value === "function" && descriptor.value.name !== "") {
      return String(descriptor.value.name);
    }
    current = Object.getPrototypeOf(current);
  }
  const tag = Object.prototype.toString.call(object);
  return tag.slice(8, -1);
}

function previewEntries(value, isIterator = false) {
  // Map/Set iterators are tracked by node/util/types.js (which wraps the
  // iterator factory methods), so their remaining entries can be
  // reconstructed without consuming them. WeakMap/WeakSet contents are not
  // observable without native engine support.
  // getTrackedIteratorInfo lives non-enumerably on the default export (the
  // named-export surface must stay identical to Node's util/types).
  const iteratorInfo = (typesModule.default ?? typesModule).getTrackedIteratorInfo?.(value);
  if (iteratorInfo !== undefined && !iteratorInfo.returned) {
    const { source, kind, consumed, isMap } = iteratorInfo;
    const entries = [];
    let index = 0;
    try {
      for (const entry of isMap ? Map.prototype.entries.call(source) : Set.prototype.values.call(source)) {
        if (index++ < consumed) continue;
        if (isMap) {
          if (kind === "entries") entries.push(entry[0], entry[1]);
          else if (kind === "keys") entries.push(entry[0]);
          else entries.push(entry[1]);
        } else if (kind === "entries") {
          entries.push(entry, entry);
        } else {
          entries.push(entry);
        }
      }
    } catch {
      // source mutated concurrently; fall through with what we have
    }
    return isIterator ? [entries, kind === "entries"] : entries;
  }
  if (isIterator) return [[], false];
  return [];
}

const privateSymbolCache = new Map();
const privateSymbols = new Proxy({}, {
  get(_target, name) {
    if (typeof name !== "string") return undefined;
    let symbol = privateSymbolCache.get(name);
    if (symbol === undefined) {
      symbol = Symbol(name);
      privateSymbolCache.set(name, symbol);
    }
    return symbol;
  },
});

function parseEnvNative(content) {
  const result = {};
  const lines = String(content).split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^export\s/.test(line)) line = line.replace(/^export\s+/, "");
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith("\"") || value.startsWith("'") || value.startsWith("`")) {
      const quote = value[0];
      const sameLineEnd = value.indexOf(quote, 1);
      let closed = false;
      if (sameLineEnd !== -1) {
        value = value.slice(1, sameLineEnd);
        closed = true;
      } else {
        const parts = [value.slice(1)];
        let closingLine = -1;
        for (let next = index + 1; next < lines.length; next += 1) {
          const end = lines[next].indexOf(quote);
          if (end !== -1) {
            parts.push(lines[next].slice(0, end));
            closingLine = next;
            break;
          }
          parts.push(lines[next]);
        }
        if (closingLine !== -1) {
          value = parts.join("\n");
          index = closingLine;
          closed = true;
        }
      }
      if (quote === "\"" && closed) value = value.replace(/\\n/g, "\n");
    } else {
      const hash = value.indexOf("#");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (key) result[key] = value;
  }
  return result;
}

function nativeGetCallSites(frameCount = 10) {
  const limitBefore = Error.stackTraceLimit;
  let stack;
  try {
    Error.stackTraceLimit = frameCount + 16;
    stack = String(new Error().stack ?? "");
  } finally {
    Error.stackTraceLimit = limitBefore;
  }
  const lines = stack.split("\n").filter((line) => /:\d+:\d+\)?$|native code/.test(line));
  const sites = [];
  for (const line of lines) {
    const text = line.trim().replace(/^at\s+/, "");
    let match = text.match(/^(.*?)\s*\((.*):(\d+):(\d+)\)$/) || text.match(/^()(.+):(\d+):(\d+)$/);
    if (!match) match = text.match(/^(?:(.*?)@)?(.*):(\d+):(\d+)$/);
    if (!match) continue;
    let scriptName = match[2] ?? "";
    const functionName = match[1] ?? "";
    if (functionName === "nativeGetCallSites" || functionName === "getCallSites" ||
        /[/\\]node[/\\]util[/\\]internal[/\\](?:loader\.js|vendor[/\\]util\.js)$/.test(scriptName)) {
      continue;
    }
    if (/(?:^|[/\\])\[eval\]$/.test(scriptName)) scriptName = "[eval]";
    sites.push(Object.assign(Object.create(null), {
      functionName,
      scriptId: "0",
      scriptName,
      lineNumber: Number(match[3] ?? 0),
      column: Number(match[4] ?? 0),
      columnNumber: Number(match[4] ?? 0),
    }));
  }
  return sites.slice(0, frameCount);
}

function guessHandleType(fd) {
  try {
    const stats = globalThis.cottontail?.fstatSync?.(fd);
    if (stats) {
      const mode = stats.mode ?? 0;
      const type = mode & 0o170000;
      if (type === 0o020000) return "TTY";
      if (type === 0o010000) return "PIPE";
      if (type === 0o100000) return "FILE";
      if (type === 0o140000) return "PIPE";
    }
  } catch {
    // fall through
  }
  return "PIPE";
}

const utilBinding = {
  constants: utilBindingConstants,
  getOwnNonIndexProperties,
  getPromiseDetails,
  getProxyDetails,
  previewEntries,
  getConstructorName,
  getExternalValue: () => 0n,
  getCallerLocation: () => undefined,
  privateSymbols,
  sleep: (ms) => globalThis.cottontail?.sleep?.(ms),
  arrayBufferViewHasBuffer: () => true,
  isInsideNodeModules: () => false,
  parseEnv: parseEnvNative,
  getCallSites: nativeGetCallSites,
  guessHandleType,
  defineLazyProperties: (target, id, keys, enumerable = true) => {
    for (const key of keys) {
      let set;
      Object.defineProperty(target, key, {
        get() {
          const value = internalRequire(id)[key];
          if (set !== undefined) return set;
          Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable });
          return value;
        },
        set(value) {
          set = value;
          Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable });
        },
        configurable: true,
        enumerable,
      });
    }
    return target;
  },
  shouldAbortOnUncaughtToggle: [true],
  WeakReference: WeakRef,
};

// ---------------------------------------------------------------------------
// internalBinding()
const stringDecoderEncodings = ["ascii", "utf8", "base64", "ucs2", "hex", "buffer", "base64url", "latin1", "utf16le"];

const bindings = {
  util: utilBinding,
  uv: {
    getErrorMap: () => new Map(uvErrorMap),
    errname(errno) {
      const entry = uvErrorMap.get(errno);
      return entry ? entry[0] : `Unknown system error ${errno}`;
    },
    getErrorMessage(errno) {
      const entry = uvErrorMap.get(errno);
      return entry ? entry[1] : `Unknown system error ${errno}`;
    },
    ...Object.fromEntries(uvEntries.map(([errno, code]) => [`UV_${code}`, errno])),
  },
  constants: {
    os: {
      signals: osSignals,
      errno: {},
      dlopen: {},
      priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 },
    },
    fs: {},
    crypto: {},
    trace: { CHAR: "" },
  },
  types: {
    isNativeError: (value) => typesModule.isNativeError(value),
    isPromise: (value) => typesModule.isPromise(value),
  },
  string_decoder: { encodings: stringDecoderEncodings },
  trace_events: {
    getCategoryEnabledBuffer: () => new Uint8Array(1),
    trace() {},
    isTraceCategoryEnabled: () => false,
  },
  buffer: {
    compare: (a, b) => {
      const BufferCtor = globalThis.Buffer ?? bufferModule.Buffer ?? bufferModule.default?.Buffer;
      return BufferCtor.compare(a, b);
    },
    kMaxLength: 4294967296,
    kStringMaxLength: 536870888,
  },
  os: {
    getOSInformation: () => ["Darwin", "0.0.0", "cottontail"],
  },
  config: { hasIntl: false, hasSmallICU: false, hasOpenSSL: true },
  messaging: {
    get DOMException() { return globalThis.DOMException; },
  },
  errors: { setPrepareStackTraceCallback() {} },
  options: {
    getCLIOptionsValues: () => ({ options: new Map() }),
    getCLIOptionsInfo: () => ({ options: new Map(), aliases: new Map() }),
    getEmbedderOptions: () => ({ hasEmbedderPreload: false, shouldNotRegisterESMLoader: false, noGlobalSearchPaths: false }),
  },
};

function internalBinding(name) {
  const binding = bindings[name];
  if (binding === undefined) {
    throw new Error(`cottontail loader: internalBinding('${name}') is not implemented`);
  }
  return binding;
}

// ---------------------------------------------------------------------------
// CommonJS view over an ES module namespace.
function cjsView(namespace) {
  const def = namespace.default;
  if (typeof def === "function") return def;
  if (def !== null && typeof def === "object") {
    if (Object.keys(namespace).length <= 1) return def;
    const merged = { ...def };
    for (const key of Object.keys(namespace)) {
      if (key !== "default") merged[key] = namespace[key];
    }
    return merged;
  }
  const plain = {};
  for (const key of Object.keys(namespace)) {
    if (key !== "default") plain[key] = namespace[key];
  }
  return plain;
}

// ---------------------------------------------------------------------------
// Option defaults for internal/options.getOptionValue().
const optionDefaults = new Map(Object.entries({
  "--no-deprecation": false,
  "--throw-deprecation": false,
  "--trace-deprecation": false,
  "--pending-deprecation": false,
  "--no-warnings": false,
  "--trace-warnings": false,
  "--stack-trace-limit": 10,
  "--enable-source-maps": false,
  "--experimental-transform-types": false,
  "--experimental-strip-types": false,
  "--disable-proto": "",
  "--frozen-intrinsics": false,
  "--expose-internals": false,
  "--preserve-symlinks": false,
  "--preserve-symlinks-main": false,
  "--conditions": [],
  "--experimental-require-module": true,
  "--report-on-fatalerror": false,
  "--report-uncaught-exception": false,
  "--test-udp-no-try-send": false,
  "--network-family-autoselection": true,
  "--network-family-autoselection-attempt-timeout": 250,
  "--max-http-header-size": 16384,
  "--insecure-http-parser": false,
  "--experimental-repl-await": false,
  "--experimental-vm-modules": true,
  "--force-node-api-uncaught-exceptions-policy": false,
  "--trace-sigint": false,
}));

function getOptionValue(name) {
  if (name === "--no-deprecation") return Boolean(globalThis.process?.noDeprecation);
  if (name === "--throw-deprecation") return Boolean(globalThis.process?.throwDeprecation);
  if (name === "--trace-deprecation") return Boolean(globalThis.process?.traceDeprecation);
  if (optionDefaults.has(name)) return optionDefaults.get(name);
  if (name.startsWith("--no-")) return false;
  return undefined;
}

// ---------------------------------------------------------------------------
// Hand-written stand-ins for internal modules we do not vendor.
function addAbortListener(signal, listener) {
  if (signal === undefined) {
    const { codes } = internalRequire("internal/errors");
    throw new codes.ERR_INVALID_ARG_TYPE("signal", "AbortSignal", signal);
  }
  let removeEventListener;
  if (signal.aborted) {
    queueMicrotask(() => listener());
  } else {
    signal.addEventListener("abort", listener, { once: true });
    removeEventListener = () => signal.removeEventListener("abort", listener);
  }
  return {
    __proto__: null,
    [Symbol.dispose]() {
      removeEventListener?.();
    },
  };
}

function makeAbortControllerModule() {
  const { codes } = internalRequire("internal/errors");
  function validateAbortSignal(signal) {
    if (signal === null || typeof signal !== "object" || !("aborted" in signal)) {
      throw new codes.ERR_INVALID_ARG_TYPE("signal", "AbortSignal", signal);
    }
  }
  return {
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    kAborted: Symbol("kAborted"),
    transferableAbortController() {
      return new AbortController();
    },
    transferableAbortSignal(signal) {
      validateAbortSignal(signal);
      return signal;
    },
    async aborted(signal, resource) {
      validateAbortSignal(signal);
      const { validateObject, kValidateObjectAllowObjects } = internalRequire("internal/validators");
      validateObject(resource, "resource", kValidateObjectAllowObjects ?? 0);
      if (signal.aborted) return Promise.resolve();
      const resourceRef = new WeakRef(resource);
      return new Promise((resolve) => {
        signal.addEventListener("abort", function onAbort() {
          if (resourceRef.deref() === undefined) return;
          resolve();
        }, { once: true });
      });
    },
  };
}

const stubFactories = {
  "internal/bootstrap/realm": () => ({
    BuiltinModule: {
      exists: (id) => Object.prototype.hasOwnProperty.call(vendored, id) ||
        String(id).replace(/^node:/, "").startsWith("internal/") ||
        ["fs", "path", "os", "events", "buffer", "util", "url", "http", "https", "net", "tls", "dns", "zlib", "stream", "crypto", "child_process", "cluster", "console", "assert", "vm", "module", "readline", "repl", "tty", "dgram", "process", "timers", "querystring", "string_decoder", "worker_threads", "perf_hooks", "async_hooks", "v8", "diagnostics_channel"].includes(String(id).replace(/^node:/, "")),
      normalizeRequirableId: (id) => id,
      canBeRequiredByUsers: () => true,
      canBeRequiredWithoutScheme: () => true,
    },
  }),
  "internal/v8/startup_snapshot": () => ({
    namespace: {
      isBuildingSnapshot: () => false,
      addSerializeCallback() {},
      addDeserializeCallback() {},
      setDeserializeMainFunction() {},
    },
  }),
  "internal/options": () => ({
    getOptionValue,
    getAllowUnauthorized: () => false,
    options: new Map(),
    aliases: new Map(),
  }),
  "internal/process/warning": () => ({
    emitWarningSync: (warning) => globalThis.process?.emitWarning?.(warning),
  }),
  "internal/process/execution": () => ({
    tryGetCwd: () => {
      try {
        return globalThis.process.cwd();
      } catch {
        return undefined;
      }
    },
    evalModuleEntryPoint() {},
  }),
  "internal/process/permission": () => ({
    isEnabled: () => false,
    has: () => true,
  }),
  "internal/source_map/source_map_cache": () => ({
    findSourceMap: () => undefined,
  }),
  "internal/tty": () => ({
    getColorDepth() {
      const env = globalThis.process?.env ?? {};
      if (env.FORCE_COLOR !== undefined) {
        switch (env.FORCE_COLOR) {
          case "0": return 1;
          case "2": return 8;
          case "3": return 24;
          default: return 4;
        }
      }
      if (env.NO_COLOR !== undefined || env.NODE_DISABLE_COLORS !== undefined) return 1;
      return 1;
    },
    hasColors: () => false,
  }),
  "internal/url": () => ({
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    isURL: (value) => value instanceof URL,
    pathToFileURL: cjsView(urlModule).pathToFileURL,
    fileURLToPath: cjsView(urlModule).fileURLToPath,
    domainToASCII: cjsView(urlModule).domainToASCII,
    domainToUnicode: cjsView(urlModule).domainToUnicode,
  }),
  "internal/abort_controller": makeAbortControllerModule,
  "internal/events/abort_listener": () => ({ addAbortListener }),
  "internal/events/symbols": () => ({
    kFirstEventParam: Symbol("nodejs.kFirstEventParam"),
    kResistStopPropagation: Symbol("kResistStopPropagation"),
  }),
  "internal/crypto/util": () => ({ kKeyObject: Symbol("kKeyObject") }),
  "internal/crypto/keys": () => ({
    kExtractable: Symbol("kExtractable"),
    kAlgorithm: Symbol("kAlgorithm"),
    kKeyUsages: Symbol("kKeyUsages"),
  }),
  "internal/util/types": () => cjsView(typesModule),
  "internal/promise_hooks": () => ({ setPromiseHooks() {} }),
  "internal/encoding": () => ({
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
  }),
  "internal/util/trace_sigint": () => ({ setTraceSigInt() {} }),
};

// The runtime's EventEmitter is an ES class, but Node's vendored code invokes
// it function-style (`EventEmitter.call(this)`), which throws for classes.
// Bridge with a callable function that reproduces the class constructor's
// field initialization and shares its prototype.
// node/events.js (owned elsewhere) does not emit the standard Node
// 'newListener'/'removeListener' meta events, which readline's keypress
// wiring requires. Add them here until events.js implements them natively.
function installMetaListenerEvents(RealEmitter) {
  const proto = RealEmitter.prototype;
  if (proto.__cottontailMetaListenerEvents) return;
  Object.defineProperty(proto, "__cottontailMetaListenerEvents", { value: true, configurable: true });
  const wrapAdd = (methodName) => {
    const original = proto[methodName];
    if (typeof original !== "function") return;
    Object.defineProperty(proto, methodName, {
      value: function (name, handler) {
        if (name !== "newListener" && typeof this.listenerCount === "function" && this.listenerCount("newListener") > 0) {
          this.emit("newListener", name, handler?.listener ?? handler);
        }
        return original.call(this, name, handler);
      },
      writable: true,
      configurable: true,
    });
  };
  wrapAdd("on");
  wrapAdd("prependListener");
  // `addListener`/`once` in node/events.js delegate to on(); wrapping `on`
  // covers them, but wrap addListener too in case it stops delegating.
  if (proto.addListener !== proto.on) wrapAdd("addListener");
  const originalRemove = proto.removeListener;
  if (typeof originalRemove === "function") {
    Object.defineProperty(proto, "removeListener", {
      value: function (name, handler) {
        const before = typeof this.listenerCount === "function" ? this.listenerCount(name) : 0;
        const result = originalRemove.call(this, name, handler);
        const after = typeof this.listenerCount === "function" ? this.listenerCount(name) : 0;
        if (before > after && this.listenerCount("removeListener") > 0) {
          this.emit("removeListener", name, handler?.listener ?? handler);
        }
        return result;
      },
      writable: true,
      configurable: true,
    });
    if (proto.off === originalRemove) {
      Object.defineProperty(proto, "off", { value: proto.removeListener, writable: true, configurable: true });
    }
  }
}

let callableEventEmitter;
function makeCallableEventEmitter() {
  if (callableEventEmitter !== undefined) return callableEventEmitter;
  const RealEmitter = eventsModule.default;
  installMetaListenerEvents(RealEmitter);
  function EventEmitter(options) {
    if (new.target !== undefined) return Reflect.construct(RealEmitter, [options], new.target);
    // Mirrors node/events.js's constructor body.
    this._events = new Map();
    this._maxListeners = undefined;
    this.captureRejections = options?.captureRejections ?? false;
    return this;
  }
  EventEmitter.prototype = RealEmitter.prototype;
  Object.setPrototypeOf(EventEmitter, RealEmitter);
  for (const key of Object.keys(eventsModule)) {
    if (key === "default" || key in EventEmitter) continue;
    try {
      EventEmitter[key] = eventsModule[key];
    } catch {
      // read-only; skip
    }
  }
  EventEmitter.EventEmitter = EventEmitter;
  // node/events.js's static on() ignores the `close`, `highWaterMark` and
  // kFirstEventParam options that Node's readline async iterator relies on;
  // give the vendored modules a faithful implementation.
  EventEmitter.on = staticEventsOn;
  callableEventEmitter = EventEmitter;
  return EventEmitter;
}

function staticEventsOn(emitter, event, options = {}) {
  if (options === null || typeof options !== "object") {
    const { codes } = internalRequire("internal/errors");
    throw new codes.ERR_INVALID_ARG_TYPE("options", "Object", options);
  }
  const signal = options?.signal;
  const { AbortError, codes } = internalRequire("internal/errors");
  if (signal !== undefined && (signal === null || typeof signal !== "object" || !("aborted" in signal))) {
    throw new codes.ERR_INVALID_ARG_TYPE("options.signal", "AbortSignal", signal);
  }
  if (signal?.aborted) throw new AbortError(undefined, { cause: signal.reason });
  const kFirstEventParam = internalRequire("internal/events/symbols").kFirstEventParam;
  const firstParamOnly = Boolean(options?.[kFirstEventParam]);
  const closeEvents = options?.close ?? [];
  const highWaterMark = options?.highWaterMark ?? options?.highWatermark ?? Number.MAX_SAFE_INTEGER;
  const lowWaterMark = options?.lowWaterMark ?? options?.lowWatermark ?? 1;
  if (!Number.isInteger(highWaterMark) || highWaterMark < 1) {
    throw new codes.ERR_OUT_OF_RANGE("options.highWaterMark", ">= 1", highWaterMark);
  }
  if (!Number.isInteger(lowWaterMark) || lowWaterMark < 1) {
    throw new codes.ERR_OUT_OF_RANGE("options.lowWaterMark", ">= 1", lowWaterMark);
  }

  const unconsumed = [];
  const pending = [];
  let finished = false;
  let failure = null;
  let paused = false;

  const settleDone = () => {
    while (pending.length > 0) {
      const promise = pending.shift();
      if (failure !== null) promise.reject(failure);
      else promise.resolve({ value: undefined, done: true });
    }
  };
  const eventHandler = (...args) => {
    const value = firstParamOnly ? args[0] : args;
    if (pending.length > 0) pending.shift().resolve({ value, done: false });
    else {
      unconsumed.push(value);
      if (!paused && unconsumed.length > highWaterMark) {
        paused = true;
        emitter.pause();
      }
    }
  };
  const errorHandler = (err) => {
    if (pending.length > 0) pending.shift().reject(err);
    else failure = err;
    finished = true;
    cleanup();
    settleDone();
  };
  const closeHandler = () => {
    finished = true;
    cleanup();
    settleDone();
  };
  const abortHandler = () => {
    errorHandler(new AbortError(undefined, { cause: signal.reason }));
  };

  function cleanup() {
    emitter.off?.(event, eventHandler);
    if (event !== "error") emitter.off?.("error", errorHandler);
    for (const closeEvent of closeEvents) emitter.off?.(closeEvent, closeHandler);
    signal?.removeEventListener?.("abort", abortHandler);
  }

  emitter.on(event, eventHandler);
  if (event !== "error") emitter.on("error", errorHandler);
  for (const closeEvent of closeEvents) emitter.on(closeEvent, closeHandler);
  signal?.addEventListener?.("abort", abortHandler, { once: true });

  return {
    next() {
      if (unconsumed.length > 0) {
        const value = unconsumed.shift();
        if (paused && unconsumed.length < lowWaterMark) {
          paused = false;
          emitter.resume();
        }
        return Promise.resolve({ value, done: false });
      }
      if (failure !== null) {
        const err = failure;
        failure = null;
        return Promise.reject(err);
      }
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    return() {
      finished = true;
      cleanup();
      settleDone();
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err) {
      if (!(err instanceof Error)) {
        throw new codes.ERR_INVALID_ARG_TYPE("EventEmitter.AsyncIterator", "Error", err);
      }
      errorHandler(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    [Symbol.for("nodejs.watermarkData")]: {
      get size() { return unconsumed.length; },
      get low() { return lowWaterMark; },
      get high() { return highWaterMark; },
      get isPaused() { return paused; },
    },
  };
}

const externalFactories = {
  "buffer": () => cjsView(bufferModule),
  "events": () => makeCallableEventEmitter(),
  "string_decoder": () => cjsView(stringDecoderModule),
  "path": () => cjsView(pathModule),
  "os": () => cjsView(osModule),
  "fs": () => cjsView(fsModule),
  "timers": () => cjsView(timersModule),
  "stream": () => cjsView(streamModule),
};

// ---------------------------------------------------------------------------
// The require() implementation shared by all vendored modules.
const moduleCache = new Map();

// Bootstrap steps Node's loader performs right after a vendored module's
// factory runs. Without these the module-level state stays uninitialized
// (e.g. debuglog's `testEnabled` is undefined until initializeDebugEnv runs,
// making util.debuglog() throw "testEnabled is not a function").
const postInitHooks = {
  "internal/util/debuglog": (exports) => {
    if (typeof exports.initializeDebugEnv === "function") {
      exports.initializeDebugEnv(globalThis.process?.env?.NODE_DEBUG ?? "");
    }
  },
};

export function internalRequire(rawId) {
  const id = String(rawId).replace(/^node:/, "");
  const cached = moduleCache.get(id);
  if (cached !== undefined) return cached.exports;

  const factory = vendored[id];
  if (factory !== undefined) {
    const module = { id, exports: {} };
    moduleCache.set(id, module);
    try {
      factory(module, module.exports, internalRequire, internalBinding, primordials);
      postInitHooks[id]?.(module.exports);
    } catch (error) {
      moduleCache.delete(id);
      throw error;
    }
    return module.exports;
  }

  const stub = stubFactories[id];
  if (stub !== undefined) {
    const module = { id, exports: stub() };
    moduleCache.set(id, module);
    return module.exports;
  }

  const external = externalFactories[id];
  if (external !== undefined) {
    const module = { id, exports: external() };
    moduleCache.set(id, module);
    return module.exports;
  }

  throw new Error(`cottontail loader: require('${id}') is not mapped`);
}
