import { createReadableStdio, createWritableStdio } from "./stdio.js";

const processStartNs = typeof cottontail.nanotime === "function" ? BigInt(Math.floor(cottontail.nanotime())) : 0n;
const processStartMs = Date.now();
let sourceMapsState = false;
let uncaughtExceptionCaptureCallback = null;

function signalNumber(signal = "SIGTERM") {
  if (typeof signal === "number") return signal;
  const name = String(signal).toUpperCase();
  if (name === "0") return 0;
  const signals = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGUSR1: cottontail.platform?.() === "linux" ? 10 : 30,
    SIGUSR2: cottontail.platform?.() === "linux" ? 12 : 31,
    SIGALRM: 14,
    SIGTERM: 15,
  };
  if (signals[name] == null) throw new TypeError(`Unknown signal: ${signal}`);
  return signals[name];
}

function processInfo(kind, ...args) {
  if (typeof cottontail.processInfo !== "function") {
    throw new Error("native processInfo support is unavailable");
  }
  return cottontail.processInfo(kind, ...args);
}

function createEventApi(processObject) {
  const listeners = processObject.__cottontailListeners ?? new Map();
  Object.defineProperty(processObject, "__cottontailListeners", {
    value: listeners,
    configurable: true,
  });

  processObject._events ??= Object.create(null);
  processObject._eventsCount ??= 0;
  processObject._maxListeners ??= undefined;

  function syncEventsObject() {
    const object = Object.create(null);
    for (const [name, handlers] of listeners) {
      if (handlers.length === 1) object[name] = handlers[0];
      else if (handlers.length > 1) object[name] = [...handlers];
    }
    processObject._events = object;
    processObject._eventsCount = Object.keys(object).length;
  }

  processObject.on = processObject.addListener = function on(name, handler) {
    if (typeof handler !== "function") return this;
    const key = String(name);
    const handlers = listeners.get(key) ?? [];
    handlers.push(handler);
    listeners.set(key, handlers);
    syncEventsObject();
    return this;
  };

  processObject.once = function once(name, handler) {
    if (typeof handler !== "function") return this;
    const wrapped = (...args) => {
      this.off(name, wrapped);
      handler(...args);
    };
    wrapped.listener = handler;
    return this.on(name, wrapped);
  };

  processObject.off = processObject.removeListener = function off(name, handler) {
    const key = String(name);
    const handlers = listeners.get(key) ?? [];
    listeners.set(key, handlers.filter((item) => item !== handler && item.listener !== handler));
    if ((listeners.get(key) ?? []).length === 0) listeners.delete(key);
    syncEventsObject();
    return this;
  };

  processObject.removeAllListeners = function removeAllListeners(name = undefined) {
    if (name == null) listeners.clear();
    else listeners.delete(String(name));
    syncEventsObject();
    return this;
  };

  processObject.listeners = function processListeners(name) {
    return [...(listeners.get(String(name)) ?? [])];
  };

  processObject.listenerCount = function listenerCount(name) {
    return listeners.get(String(name))?.length ?? 0;
  };

  processObject.emit = function emit(name, ...args) {
    const handlers = [...(listeners.get(String(name)) ?? [])];
    for (const handler of handlers) handler(...args);
    return handlers.length > 0;
  };

  syncEventsObject();
}

function nowNs() {
  return typeof cottontail.nanotime === "function"
    ? BigInt(Math.floor(cottontail.nanotime()))
    : BigInt(Date.now()) * 1000000n;
}

function makeHrtime(previous = undefined) {
  let diff = nowNs() - processStartNs;
  if (Array.isArray(previous)) {
    diff -= BigInt(previous[0] || 0) * 1000000000n + BigInt(previous[1] || 0);
  }
  return [Number(diff / 1000000000n), Number(diff % 1000000000n)];
}

makeHrtime.bigint = () => nowNs() - processStartNs;

function makeCpuUsage(kind = "resourceUsage", previous = undefined) {
  const usage = processInfo(kind);
  let user = Number(usage.userCPUTime) || 0;
  let system = Number(usage.systemCPUTime) || 0;
  if (previous) {
    user -= Number(previous.user) || 0;
    system -= Number(previous.system) || 0;
  }
  return { user, system };
}

function makeMemoryUsage() {
  return processInfo("memoryUsage");
}

makeMemoryUsage.rss = () => Number(processInfo("memoryUsage").rss) || 0;

function unsupported(name) {
  throw new Error(`${name} is not available in Cottontail's embedded Node compatibility layer`);
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const equals = trimmed.indexOf("=");
  if (equals < 0) return null;
  const key = trimmed.slice(0, equals).trim();
  let value = trimmed.slice(equals + 1).trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return key ? [key, value] : null;
}

function makeReport() {
  const reportObject = {
    directory: "",
    filename: "report.json",
    compact: false,
    excludeNetwork: false,
    signal: "SIGUSR2",
    reportOnFatalError: false,
    reportOnSignal: false,
    reportOnUncaughtException: false,
    excludeEnv: false,
    getReport(error = undefined) {
      return {
        header: {
          event: error ? "Exception" : "JavaScript API",
          trigger: "GetReport",
          filename: this.filename,
          dumpEventTime: new Date().toISOString(),
          processId: pid,
          cwd: cwd(),
          commandLine: [...argv],
          nodejsVersion: version,
          cottontailVersion: versions.cottontail,
        },
        javascriptStack: error ? { message: String(error?.message ?? error), stack: String(error?.stack ?? "") } : {},
        resourceUsage: resourceUsage(),
        environmentVariables: this.excludeEnv ? {} : { ...env },
      };
    },
    writeReport(filename = undefined, error = undefined) {
      const output = filename || this.filename || "report.json";
      const data = JSON.stringify(this.getReport(error), null, this.compact ? 0 : 2);
      cottontail.writeFile(output, data);
      return output;
    },
  };
  return reportObject;
}

const cottontailExecPath = cottontail.execPath?.() ?? "cottontail";
const processObject = globalThis.process ?? {
  argv: cottontail.argv || [cottontailExecPath, ...(cottontail.args || [])],
  argv0: cottontailExecPath,
  execPath: cottontailExecPath,
  env: cottontail.env(),
  platform: cottontail.platform(),
  arch: cottontail.arch(),
  pid: cottontail.pid?.() ?? 0,
  versions: { node: "24.0.0", cottontail: "0.0.0-dev" },
  release: { name: "cottontail" },
};

globalThis.process = processObject;
createEventApi(processObject);

processObject.argv ??= cottontail.argv || [cottontailExecPath, ...(cottontail.args || [])];
processObject.argv0 ??= cottontailExecPath;
processObject.execPath ??= cottontailExecPath;
processObject.env ??= cottontail.env();
processObject.platform ??= cottontail.platform();
processObject.arch ??= cottontail.arch();
processObject.pid ??= cottontail.pid?.() ?? 0;
processObject.ppid = processInfo("ppid");
processObject.version ??= "v24.0.0-cottontail";
processObject.versions ??= { node: "24.0.0", cottontail: "0.0.0-dev" };
processObject.versions.node ??= "24.0.0";
processObject.versions.cottontail ??= "0.0.0-dev";
processObject.release ??= { name: "cottontail" };
processObject.title ??= "cottontail";
processObject.browser ??= false;
processObject.execArgv ??= [];
processObject._preload_modules ??= [];
processObject.moduleLoadList ??= [];
processObject.debugPort ??= 9229;
processObject.domain ??= null;
processObject._exiting ??= false;
processObject.exitCode ??= undefined;
processObject.stdin ??= createReadableStdio(0);
processObject.stdout ??= createWritableStdio(1);
processObject.stderr ??= createWritableStdio(2);
processObject.config ??= {
  target_defaults: {
    cflags: [],
    default_configuration: "Release",
    defines: [],
    include_dirs: [],
    libraries: [],
  },
  variables: {
    host_arch: processObject.arch,
    target_arch: processObject.arch,
    node_target_type: "executable",
    node_use_openssl: true,
    node_shared_zlib: false,
  },
};
processObject.features ??= {
  inspector: false,
  debug: false,
  uv: false,
  ipv6: true,
  tls_alpn: false,
  tls_sni: false,
  tls_ocsp: false,
  tls: false,
  cached_builtins: false,
  require_module: true,
  typescript: true,
};

export const argv = processObject.argv;
export const argv0 = processObject.argv0;
export const execPath = processObject.execPath;
export const env = processObject.env;
export const platform = processObject.platform;
export const arch = processObject.arch;
export const versions = processObject.versions;
export const release = processObject.release;
export const pid = processObject.pid;
export const ppid = processObject.ppid;
export const stdin = processObject.stdin;
export const stdout = processObject.stdout;
export const stderr = processObject.stderr;
export const version = processObject.version;
export const title = processObject.title;
export const browser = processObject.browser;
export const execArgv = processObject.execArgv;
export const _preload_modules = processObject._preload_modules;
export const moduleLoadList = processObject.moduleLoadList;
export const debugPort = processObject.debugPort;
export const domain = processObject.domain;
export const config = processObject.config;
export const features = processObject.features;
export const _events = processObject._events;
export const _eventsCount = processObject._eventsCount;
export const _maxListeners = processObject._maxListeners;
export let _exiting = processObject._exiting;
export let exitCode = processObject.exitCode;
export let sourceMapsEnabled = sourceMapsState;
export const allowedNodeEnvironmentFlags = new Set([
  "--conditions",
  "--enable-source-maps",
  "--experimental-modules",
  "--inspect",
  "--inspect-brk",
  "--loader",
  "--max-old-space-size",
  "--no-deprecation",
  "--preserve-symlinks",
  "--require",
  "--throw-deprecation",
  "--trace-deprecation",
  "--trace-warnings",
  "--unhandled-rejections",
]);

export const cwd = processObject.cwd = () => cottontail.cwd();

export const chdir = processObject.chdir = (directory) => {
  processInfo("chdir", String(directory));
};

export const exit = processObject.exit = (code = processObject.exitCode ?? 0) => {
  processObject._exiting = true;
  _exiting = true;
  cottontail.exit(Number(code ?? 0));
};

export const reallyExit = processObject.reallyExit = (code = processObject.exitCode ?? 0) => {
  cottontail.exit(Number(code ?? 0));
};

export const abort = processObject.abort = () => {
  cottontail.kill(processObject.pid, signalNumber("SIGABRT"));
};

export const nextTick = processObject.nextTick = (callback, ...args) => {
  if (typeof callback !== "function") throw new TypeError("process.nextTick callback must be a function");
  queueMicrotask(() => callback(...args));
};

export const hrtime = processObject.hrtime = makeHrtime;
export const uptime = processObject.uptime = () => (Date.now() - processStartMs) / 1000;

export const kill = processObject.kill = (targetPid = processObject.pid, signal = "SIGTERM") =>
  cottontail.kill(Number(targetPid), signalNumber(signal));

export const _kill = processObject._kill = kill;

export const cpuUsage = processObject.cpuUsage = (previous = undefined) => makeCpuUsage("resourceUsage", previous);
export const threadCpuUsage = processObject.threadCpuUsage = (previous = undefined) => makeCpuUsage("threadResourceUsage", previous);
export const resourceUsage = processObject.resourceUsage = () => processInfo("resourceUsage");
export const memoryUsage = processObject.memoryUsage = makeMemoryUsage;
export const availableMemory = processObject.availableMemory = () => Number(processInfo("availableMemory")) || 0;
export const constrainedMemory = processObject.constrainedMemory = () => Number(processInfo("constrainedMemory")) || 0;

export const getuid = processObject.getuid = () => Number(processInfo("getuid"));
export const geteuid = processObject.geteuid = () => Number(processInfo("geteuid"));
export const getgid = processObject.getgid = () => Number(processInfo("getgid"));
export const getegid = processObject.getegid = () => Number(processInfo("getegid"));
export const getgroups = processObject.getgroups = () => Array.from(processInfo("getgroups") ?? [], Number);
export const setuid = processObject.setuid = (id) => processInfo("setuid", Number(id));
export const seteuid = processObject.seteuid = (id) => processInfo("seteuid", Number(id));
export const setgid = processObject.setgid = (id) => processInfo("setgid", Number(id));
export const setegid = processObject.setegid = (id) => processInfo("setegid", Number(id));
export const setgroups = processObject.setgroups = (groups) => processInfo("setgroups", Array.from(groups ?? [], Number));
export const initgroups = processObject.initgroups = (user, extraGroup) => processInfo("initgroups", String(user), Number(extraGroup));
export const umask = processObject.umask = (mask = undefined) => processInfo("umask", mask == null ? undefined : Number(mask));

export const openStdin = processObject.openStdin = () => {
  processObject.stdin.resume?.();
  return processObject.stdin;
};

export const ref = processObject.ref = (maybeRefable = undefined) => {
  maybeRefable?.ref?.();
};

export const unref = processObject.unref = (maybeRefable = undefined) => {
  maybeRefable?.unref?.();
};

export const _getActiveHandles = processObject._getActiveHandles = () =>
  [processObject.stdin, processObject.stdout, processObject.stderr].filter(Boolean);

export const _getActiveRequests = processObject._getActiveRequests = () => [];
export const getActiveResourcesInfo = processObject.getActiveResourcesInfo = () => [];

export const emitWarning = processObject.emitWarning = (warning, type = "Warning", code = undefined, ctor = undefined) => {
  const error = warning instanceof Error ? warning : new Error(String(warning));
  error.name = type || error.name || "Warning";
  if (code != null) error.code = String(code);
  if (typeof ctor === "function" && Error.captureStackTrace) Error.captureStackTrace(error, ctor);
  if (!processObject.emit("warning", error)) {
    const line = `${error.name}${error.code ? ` [${error.code}]` : ""}: ${error.message}\n`;
    cottontail.fdWrite?.(2, line);
  }
};

export const _rawDebug = processObject._rawDebug = (...args) => {
  cottontail.fdWrite?.(2, `${args.map(String).join(" ")}\n`);
};

export const _fatalException = processObject._fatalException = (error) => {
  if (typeof uncaughtExceptionCaptureCallback === "function") {
    uncaughtExceptionCaptureCallback(error);
    return true;
  }
  return processObject.emit("uncaughtException", error);
};

export const setUncaughtExceptionCaptureCallback = processObject.setUncaughtExceptionCaptureCallback = (callback) => {
  if (callback != null && typeof callback !== "function") {
    throw new TypeError("callback must be a function or null");
  }
  uncaughtExceptionCaptureCallback = callback;
};

export const hasUncaughtExceptionCaptureCallback = processObject.hasUncaughtExceptionCaptureCallback = () =>
  typeof uncaughtExceptionCaptureCallback === "function";

export const setSourceMapsEnabled = processObject.setSourceMapsEnabled = (enabled) => {
  sourceMapsState = Boolean(enabled);
  sourceMapsEnabled = sourceMapsState;
};

export const _tickCallback = processObject._tickCallback = () => cottontail.drainJobs?.();
export const _debugEnd = processObject._debugEnd = () => {};
export const _debugProcess = processObject._debugProcess = (targetPid) => cottontail.kill(Number(targetPid), signalNumber("SIGUSR1"));
export const _startProfilerIdleNotifier = processObject._startProfilerIdleNotifier = () => {};
export const _stopProfilerIdleNotifier = processObject._stopProfilerIdleNotifier = () => {};

export const binding = processObject.binding = (name) => {
  unsupported(`process.binding(${String(name)})`);
};

export const _linkedBinding = processObject._linkedBinding = (name) => {
  unsupported(`process._linkedBinding(${String(name)})`);
};

export const dlopen = processObject.dlopen = () => {
  unsupported("process.dlopen");
};

export const execve = processObject.execve = () => {
  unsupported("process.execve");
};

export const getBuiltinModule = processObject.getBuiltinModule = (specifier) => {
  const text = String(specifier);
  const map = globalThis.__cottontailBuiltinModules;
  if (map?.has(text)) return map.get(text);
  if (text.startsWith("node:") && map?.has(text.slice(5))) return map.get(text.slice(5));
  if (text === "process" || text === "node:process") return processObject;
  return undefined;
};

export const loadEnvFile = processObject.loadEnvFile = (path = ".env") => {
  const source = cottontail.readFile(String(path));
  for (const line of source.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) processObject.env[parsed[0]] = parsed[1];
  }
};

export const finalization = processObject.finalization = (() => {
  const registry = typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry((callback) => {
      if (typeof callback === "function") callback();
    })
    : null;
  const callbacks = new WeakMap();
  return {
    register(refValue, callback) {
      if (registry && refValue && typeof refValue === "object") {
        callbacks.set(refValue, callback);
        registry.register(refValue, callback, refValue);
      }
    },
    registerBeforeExit(refValue, callback) {
      this.register(refValue, callback);
    },
    unregister(refValue) {
      callbacks.delete(refValue);
      registry?.unregister?.(refValue);
    },
  };
})();

export const report = processObject.report = makeReport();

// COTTONTAIL-COMPAT: node:process internals/addon hooks - unsupported Node internals throw instead of pretending to expose V8/libuv/N-API state.

export const on = processObject.on.bind(processObject);
export const once = processObject.once.bind(processObject);
export const off = processObject.off.bind(processObject);
export const emit = processObject.emit.bind(processObject);

export default processObject;
