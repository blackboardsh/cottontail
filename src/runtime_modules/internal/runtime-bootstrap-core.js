import { bunCompatVersion, processObject as earlyProcessObject } from "./runtime-process-bootstrap.js";
import { createWritableStdio } from "../node/stdio.js";
import { installDotenvLoader } from "./dotenv.js";
import { renderTable } from "./console-table.js";

const bunSleepSetTimeout = globalThis.setTimeout.bind(globalThis);

// Stash the pristine Promise.prototype.then before any module (async_hooks,
// the test runner, or user code) can replace it. Internal machinery must
// never flow through a user-overridden `then`.
globalThis[Symbol.for("cottontail.nativePromiseThen")] ??= Promise.prototype.then;

function remapStackString(value) {
  const remap = globalThis.__cottontailRemapStackString;
  return typeof remap === "function" ? remap(value) : String(value);
}

function normalizeUncaughtReferenceError(error) {
  if (error?.name !== "ReferenceError" ||
      typeof error.message !== "string" ||
      !error.message.startsWith("Can't find variable: ")) {
    return undefined;
  }
  const normalizedMessage = `${error.message.slice("Can't find variable: ".length)} is not defined`;
  const headers = [`ReferenceError: ${error.message}`, `ReferenceError: ${normalizedMessage}`];
  try { error.message = normalizedMessage; } catch {}
  if (typeof error.stack === "string") {
    try { error.stack = error.stack.replace(headers[0], headers[1]); } catch {}
  }
  return headers;
}

globalThis.__cottontailNormalizeUncaughtException ??= error => {
  normalizeUncaughtReferenceError(error);
  return error;
};

globalThis.__cottontailFormatUncaughtException ??= (error) => {
  if (error?.__cottontailFormattedStack === true && typeof error.stack === "string") {
    return error.stack;
  }
  if (error?.name === "ResolveMessage" && typeof error.message === "string") {
    return `error: ${error.message}`;
  }
  const referenceErrorHeaders = normalizeUncaughtReferenceError(error);
  if (error && typeof error.stack === "string") {
    let stack = remapStackString(error.stack);
    if (referenceErrorHeaders) stack = stack.replace(referenceErrorHeaders[0], referenceErrorHeaders[1]);
    let header = "";
    try {
      header = Error.prototype.toString.call(error);
    } catch {}
    if (error?.name === "AssertionError" && error?.code === "ERR_ASSERTION") {
      header = `AssertionError [ERR_ASSERTION]: ${error.message}`;
    }
    if (referenceErrorHeaders) header = referenceErrorHeaders[1];
    return header && !stack.includes(header) ? `${header}\n${stack}` : stack;
  }
  if (referenceErrorHeaders) return referenceErrorHeaders[1];
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
try {
  __ctMetaEnv = processObject.env;
} catch {}
if (globalThis.console && typeof globalThis.console.write !== "function") {
  globalThis.console.write = (chunk = "") => {
    processObject.stdout?.write?.(String(chunk));
  };
}
if (globalThis.console && typeof globalThis.console.table !== "function") {
  globalThis.console.table = (value, properties = undefined) => {
    if (properties !== undefined && !Array.isArray(properties)) {
      throw new TypeError("console.table properties must be an array");
    }
    if (value !== null && typeof value === "object") {
      const rendered = renderTable(value, properties, { colors: false });
      if (rendered) {
        processObject.stdout?.write?.(rendered);
        return;
      }
    }
    globalThis.console.log(value);
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
  // Bun saturates oversized timeouts to the maximum 32-bit timer value instead
  // of clamping them to ~1ms the way DOM/Node timers do.
  const saturated = Number.isNaN(delay)
    ? 0
    : !Number.isFinite(delay)
      ? 2 ** 31 - 1
      : Math.min(Math.max(0, delay), 2 ** 31 - 1);
  return new Promise(resolve => bunSleepSetTimeout(resolve, saturated));
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
