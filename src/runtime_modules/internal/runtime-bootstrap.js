import { createWritableStdio } from "../node/stdio.js";
import { remapStackString } from "../vendor/sourcemap.js";

const nodeCompatVersion = "24.11.1";
const bunCompatVersion = "1.3.10";
const processStartNs = BigInt(Math.floor(cottontail.nanotime?.() ?? Date.now() * 1_000_000));
const bunSleepSetTimeout = globalThis.setTimeout.bind(globalThis);

globalThis.__cottontailRemapStackString ??= remapStackString;
globalThis.__cottontailFormatUncaughtException ??= (error) => {
  if (error && typeof error.stack === "string") {
    const stack = remapStackString(error.stack);
    let header = "";
    try {
      header = Error.prototype.toString.call(error);
    } catch {}
    return header && !stack.includes(header) ? `${header}\n${stack}` : stack;
  }
  if (error?.message) return `${error.name || "Error"}: ${error.message}`;
  return String(error);
};

function installEmitter(target) {
  if (typeof target.on === "function" && typeof target.emit === "function") return;
  const listeners = target.__cottontailListeners ?? new Map();
  Object.defineProperty(target, "__cottontailListeners", {
    value: listeners,
    configurable: true,
  });
  target.on = function on(name, callback) {
    if (typeof callback !== "function") throw new TypeError("The listener must be a function");
    const callbacks = listeners.get(name) ?? [];
    callbacks.push(callback);
    listeners.set(name, callbacks);
    return this;
  };
  target.addListener = target.on;
  target.once = function once(name, callback) {
    const wrapped = (...args) => {
      this.off(name, wrapped);
      return callback.apply(this, args);
    };
    wrapped.listener = callback;
    return this.on(name, wrapped);
  };
  target.off = function off(name, callback) {
    const callbacks = listeners.get(name);
    if (!callbacks) return this;
    const filtered = callbacks.filter(item => item !== callback && item.listener !== callback);
    if (filtered.length === 0) listeners.delete(name);
    else listeners.set(name, filtered);
    return this;
  };
  target.removeListener = target.off;
  target.removeAllListeners = function removeAllListeners(name) {
    if (arguments.length === 0) listeners.clear();
    else listeners.delete(name);
    return this;
  };
  target.listeners = function listenersFor(name) {
    return (listeners.get(name) ?? []).map(callback => callback.listener ?? callback);
  };
  target.rawListeners = function rawListeners(name) {
    return [...(listeners.get(name) ?? [])];
  };
  target.listenerCount = function listenerCount(name) {
    return listeners.get(name)?.length ?? 0;
  };
  target.emit = function emit(name, ...args) {
    const callbacks = [...(listeners.get(name) ?? [])];
    if (callbacks.length === 0) return false;
    for (const callback of callbacks) callback.apply(this, args);
    return true;
  };
}

function installProcess() {
  const execPath = String(cottontail.execPath?.() ?? "cottontail");
  const argv = Array.isArray(cottontail.argv)
    ? [...cottontail.argv]
    : [execPath, ...(cottontail.args ?? [])];
  if (argv.length === 0) argv.push(execPath);
  if (argv[0] === "cottontail") argv[0] = execPath;

  const target = globalThis.process ?? {};
  target.argv ??= argv;
  target.argv0 ??= execPath;
  target.execPath ??= execPath;
  target.execArgv ??= Array.from(cottontail.execArgv ?? [], String);
  target.env ??= cottontail.env();
  const inheritedSpawnArgv0 = target.env.COTTONTAIL_SPAWN_ARGV0;
  if (inheritedSpawnArgv0 != null) {
    Object.defineProperty(target, "argv0", {
      value: String(inheritedSpawnArgv0),
      writable: true,
      enumerable: true,
      configurable: true,
    });
    try { delete target.env.COTTONTAIL_SPAWN_ARGV0; } catch {}
  }
  const inheritedSpawnExecPath = target.env.COTTONTAIL_SPAWN_EXEC_PATH;
  if (inheritedSpawnExecPath != null) {
    Object.defineProperty(target, "execPath", {
      value: String(inheritedSpawnExecPath),
      writable: true,
      enumerable: true,
      configurable: true,
    });
    try { delete target.env.COTTONTAIL_SPAWN_EXEC_PATH; } catch {}
  }
  target.platform ??= cottontail.platform();
  target.arch ??= cottontail.arch();
  target.pid ??= Number(cottontail.pid?.() ?? 0);
  target.ppid ??= Number(cottontail.processInfo?.("ppid") ?? 0);
  target.version ??= `v${nodeCompatVersion}`;
  target.versions ??= {};
  target.versions.node ??= nodeCompatVersion;
  target.versions.bun ??= bunCompatVersion;
  target.versions.cottontail ??= String(cottontail.processInfo?.("version") ?? "0.0.0-dev");
  target.revision ??= "cottontail";
  target.release ??= { name: "node" };
  target.title ??= "bun";
  target.isBun ??= true;
  target.browser ??= false;
  target.exitCode ??= undefined;
  target.cwd ??= () => cottontail.cwd();
  target.chdir ??= directory => cottontail.chdir(directory);
  target.memoryUsage ??= function memoryUsage() {
    return cottontail.processInfo("memoryUsage");
  };
  target.memoryUsage.rss ??= () => Number(cottontail.processInfo("memoryUsage").rss) || 0;
  target.uptime ??= () => Number(BigInt(Math.floor(cottontail.nanotime?.() ?? Date.now() * 1_000_000)) - processStartNs) / 1e9;
  target.hrtime ??= function hrtime(previous) {
    let value = BigInt(Math.floor(cottontail.nanotime?.() ?? Date.now() * 1_000_000));
    if (previous !== undefined) value -= BigInt(previous[0] ?? 0) * 1_000_000_000n + BigInt(previous[1] ?? 0);
    return [Number(value / 1_000_000_000n), Number(value % 1_000_000_000n)];
  };
  target.hrtime.bigint ??= () => BigInt(Math.floor(cottontail.nanotime?.() ?? Date.now() * 1_000_000));
  target.nextTick ??= (callback, ...args) => queueMicrotask(() => callback(...args));
  target.stdout ??= createWritableStdio(1);
  target.stderr ??= createWritableStdio(2);
  target.exit ??= function exit(code = this.exitCode ?? 0) {
    this.exitCode = Number(code) || 0;
    cottontail.exit(this.exitCode);
  };
  target.reallyExit ??= target.exit;
  installEmitter(target);
  globalThis.process = target;
  return target;
}

const processObject = installProcess();
const bunObject = globalThis.Bun ?? {};
Object.defineProperty(bunObject, Symbol.toStringTag, { value: "Bun", configurable: true });
bunObject.argv ??= processObject.argv;
bunObject.env ??= processObject.env;
bunObject.cwd ??= cottontail.cwd();
bunObject.main ??= processObject.argv[1] ?? "";
bunObject.isMainThread ??= cottontail.isWorker?.() !== true;
bunObject.version ??= bunCompatVersion;
bunObject.revision ??= "cottontail";
bunObject.version_with_sha ??= `v${bunCompatVersion} (cottontail)`;
bunObject.gc ??= function gc(force = false) {
  cottontail.gc?.(Boolean(force));
  cottontail.drainJobs?.();
};
bunObject.sleep ??= function sleep(value) {
  const delay = value instanceof Date ? value.getTime() - Date.now() : Number(value);
  return new Promise(resolve => bunSleepSetTimeout(resolve, Math.max(0, Number.isFinite(delay) ? delay : 2 ** 31 - 1)));
};
bunObject.sleepSync ??= function sleepSync(value) {
  const delay = Number(value);
  if (!Number.isFinite(delay) || delay < 0) throw new TypeError("Bun.sleepSync expects a non-negative finite number");
  cottontail.sleep(delay);
};
bunObject.nanoseconds ??= () => Number(cottontail.nanotime?.() ?? Date.now() * 1_000_000);
globalThis.Bun = bunObject;

export function installRuntimeBootstrap({ pathToFileURL, fileURLToPath } = {}) {
  if (typeof pathToFileURL === "function") bunObject.pathToFileURL ??= pathToFileURL;
  if (typeof fileURLToPath === "function") bunObject.fileURLToPath ??= fileURLToPath;
  return bunObject;
}

export { bunObject as Bun, processObject as process };
export default bunObject;
