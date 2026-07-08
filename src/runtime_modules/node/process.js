const processStartMs = Date.now();

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
    if (pid === processObject.pid || pid === 0) {
      if (signal === 0 || signal === "0") return true;
      processObject.emit(String(signal));
      return true;
    }
    throw new Error("process.kill for other processes is not implemented");
  };
}

const process = globalThis.process ?? {
  argv: ["cottontail", ...(cottontail.args || [])],
  argv0: "cottontail",
  execPath: cottontail.execPath?.() ?? "cottontail",
  env: cottontail.env(),
  platform: cottontail.platform(),
  arch: cottontail.arch(),
  pid: cottontail.pid?.() ?? 0,
  versions: { node: "22.0.0", cottontail: "0.0.0-dev" },
  cwd: () => cottontail.cwd(),
  exit: (code = 0) => cottontail.exit(code),
  emitWarning: (message, type = "Warning") => console.warn(`${type}: ${message}`),
};

globalThis.process = process;
installProcessApi(process);
process.versions ??= { node: "22.0.0", cottontail: "0.0.0-dev" };
process.versions.node ??= "22.0.0";
process.emitWarning ??= (message, type = "Warning") => console.warn(`${type}: ${message}`);
process.stdin ??= { fd: 0, isTTY: false, on: () => process.stdin, resume: () => process.stdin, setEncoding: () => process.stdin };
process.stdout ??= { fd: 1, isTTY: false, write: (value) => { console.log(String(value).replace(/\n$/, "")); return true; } };
process.stderr ??= { fd: 2, isTTY: false, write: (value) => { console.error(String(value).replace(/\n$/, "")); return true; } };

export const argv = process.argv;
export const argv0 = process.argv0;
export const execPath = process.execPath;
export const env = process.env;
export const platform = process.platform;
export const arch = process.arch;
export const versions = process.versions;
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
