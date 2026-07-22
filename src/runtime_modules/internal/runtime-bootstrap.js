import { bunCompatVersion, processObject as earlyProcessObject } from "./runtime-process-bootstrap.js";
import { createWritableStdio } from "../node/stdio.js";
import { remapStackString, sourceContextForLocation } from "../vendor/sourcemap.js";
import { installDotenvLoader } from "./dotenv.js";
import { installStandaloneRuntimeLoaders } from "./standalone-runtime.js";

const bunSleepSetTimeout = globalThis.setTimeout.bind(globalThis);

globalThis.__cottontailRemapStackString ??= remapStackString;
globalThis.__cottontailSourceContextForLocation ??= sourceContextForLocation;
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
  const target = earlyProcessObject;
  target.stdout ??= createWritableStdio(1);
  target.stderr ??= createWritableStdio(2);
  installEmitter(target);
  return target;
}

const processObject = installProcess();
installDotenvLoader(processObject);
installStandaloneRuntimeLoaders(processObject);
try {
  __ctMetaEnv = processObject.env;
} catch {}
if (globalThis.console && typeof globalThis.console.write !== "function") {
  globalThis.console.write = (chunk = "") => {
    processObject.stdout?.write?.(String(chunk));
  };
}
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
