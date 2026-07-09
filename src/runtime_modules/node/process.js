import { createReadableStdio, createWritableStdio } from "./stdio.js";

const processStartMs = Date.now();

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
    SIGALRM: 14,
    SIGTERM: 15,
  };
  if (signals[name] == null) throw new TypeError(`Unknown signal: ${signal}`);
  return signals[name];
}

function installProcessApi(processObject) {
  const listeners = processObject.__cottontailListeners ?? new Map();
  Object.defineProperty(processObject, "__cottontailListeners", {
    value: listeners,
    configurable: true,
  });

  processObject.pid ??= cottontail.pid?.() ?? 0;
  processObject.version ??= "v22.0.0-cottontail";
  processObject.title ??= "cottontail";
  processObject.browser ??= false;
  processObject.uptime ??= () => (Date.now() - processStartMs) / 1000;

  processObject.nextTick = (callback, ...args) => {
    if (typeof callback !== "function") {
      throw new TypeError("process.nextTick callback must be a function");
    }
    if (typeof queueMicrotask === "function") {
      queueMicrotask(() => callback(...args));
    } else {
      setTimeout(() => callback(...args), 0);
    }
  };

  processObject.hrtime = (previous) => {
    const now = BigInt(Math.floor((performance?.now?.() ?? Date.now()) * 1_000_000));
    let diff = now;
    if (Array.isArray(previous)) {
      diff -= BigInt(previous[0] || 0) * 1_000_000_000n + BigInt(previous[1] || 0);
    }
    return [Number(diff / 1_000_000_000n), Number(diff % 1_000_000_000n)];
  };
  processObject.hrtime.bigint = () => BigInt(Math.floor((performance?.now?.() ?? Date.now()) * 1_000_000));

  processObject.on = processObject.addListener = function on(name, handler) {
    if (typeof handler !== "function") return this;
    const key = String(name);
    const handlers = listeners.get(key) ?? [];
    handlers.push(handler);
    listeners.set(key, handlers);
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
    return this;
  };

  processObject.removeAllListeners = function removeAllListeners(name) {
    if (name == null) listeners.clear();
    else listeners.delete(String(name));
    return this;
  };

  processObject.listeners = function processListeners(name) {
    return [...(listeners.get(String(name)) ?? [])];
  };

  processObject.emit = function emit(name, ...args) {
    const handlers = [...(listeners.get(String(name)) ?? [])];
    for (const handler of handlers) {
      handler(...args);
    }
    return handlers.length > 0;
  };

  processObject.kill ??= (pid = processObject.pid, signal = "SIGTERM") => {
    const targetPid = Number(pid);
    const nativeSignal = signalNumber(signal);
    if (targetPid === processObject.pid && nativeSignal !== 0 && processObject.emit(String(signal))) {
      return true;
    }
    return cottontail.kill(targetPid, nativeSignal);
  };
}

const cottontailExecPath = cottontail.execPath?.() ?? "cottontail";
const process = globalThis.process ?? {
  argv: cottontail.argv || ["cottontail", ...(cottontail.args || [])],
  argv0: cottontailExecPath,
  execPath: cottontailExecPath,
  env: cottontail.env(),
  platform: cottontail.platform(),
  arch: cottontail.arch(),
  pid: cottontail.pid?.() ?? 0,
  versions: { node: "22.0.0", cottontail: "0.0.0-dev" },
  release: { name: "cottontail" },
  cwd: () => cottontail.cwd(),
  exit: (code = 0) => cottontail.exit(code),
  emitWarning: (message, type = "Warning") => console.warn(`${type}: ${message}`),
};

globalThis.process = process;
installProcessApi(process);
process.execPath ??= cottontailExecPath;
process.argv0 ??= process.execPath;
process.execArgv ??= [];
process.versions ??= { node: "22.0.0", cottontail: "0.0.0-dev" };
process.versions.node ??= "22.0.0";
process.release ??= { name: "cottontail" };
process.emitWarning ??= (message, type = "Warning") => console.warn(`${type}: ${message}`);
process.stdin ??= createReadableStdio(0);
process.stdout ??= createWritableStdio(1);
process.stderr ??= createWritableStdio(2);

export const argv = process.argv;
export const argv0 = process.argv0;
export const execPath = process.execPath;
export const env = process.env;
export const platform = process.platform;
export const arch = process.arch;
export const versions = process.versions;
export const release = process.release;
export const pid = process.pid;
export const stdin = process.stdin;
export const stdout = process.stdout;
export const stderr = process.stderr;
export const cwd = process.cwd;
export const exit = process.exit;
export const nextTick = process.nextTick;
export const hrtime = process.hrtime;
export const uptime = process.uptime;
export const kill = process.kill;
export const on = process.on.bind(process);
export const once = process.once.bind(process);
export const off = process.off.bind(process);
export const emit = process.emit.bind(process);
export default process;
