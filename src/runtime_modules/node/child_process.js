import { EventEmitter } from "./events.js";
import { Buffer } from "./buffer.js";

export class ChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = null;
    this.stdout = null;
    this.stderr = null;
    this.pid = 0;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
  }
}

export function execSync(command, options = {}) {
  const nativeOptions = prepareNativeOptions(cottontail.platform() === "win32" ? "cmd" : "sh", options);
  const result = cottontail.spawnSync(cottontail.platform() === "win32" ? "cmd" : "sh", cottontail.platform() === "win32" ? ["/d", "/s", "/c", String(command)] : ["-c", String(command)], {
    stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    cwd: options.cwd,
    env: nativeOptions.env,
    clearEnv: nativeOptions.clearEnv,
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr || result.stdout || `Command failed: ${command}`);
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return options.encoding ? result.stdout : { toString: () => result.stdout };
}

export function execFileSync(file, args = [], options = {}) {
  const nativeOptions = prepareNativeOptions(file, options);
  const result = cottontail.spawnSync(String(file), Array.from(args ?? [], String), {
    stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    cwd: options.cwd,
    env: nativeOptions.env,
    clearEnv: nativeOptions.clearEnv,
    input: options.input,
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr || result.stdout || `Command failed: ${file}`);
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  if (options.stdio === "inherit") return null;
  return options.encoding ? result.stdout : globalThis.Buffer?.from ? globalThis.Buffer.from(result.stdout || "") : { toString: () => result.stdout || "" };
}

export function spawnSync(file, args = [], options = {}) {
  const nativeOptions = prepareNativeOptions(file, options);
  return cottontail.spawnSync(String(file), Array.from(args, String), {
    stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    cwd: options.cwd,
    env: nativeOptions.env,
    clearEnv: nativeOptions.clearEnv,
  });
}

function withoutElectrobunHostEnv(env) {
  const next = { ...(env ?? {}) };
  for (const key of Object.keys(next)) {
    if (key.startsWith("COTTONTAIL_ELECTROBUN_")) delete next[key];
  }
  return next;
}

function prepareNativeOptions(file, options = {}) {
  if (String(file) === String(process.execPath) && options.env === undefined) {
    return {
      ...options,
      env: withoutElectrobunHostEnv(process.env),
      clearEnv: true,
    };
  }
  if (options.env !== undefined) {
    return {
      ...options,
      clearEnv: true,
    };
  }
  return options;
}

function normalizeStdio(value, fallback) {
  if (value === undefined) return fallback;
  if (value === null) return "ignore";
  if (value === "pipe" || value === "inherit" || value === "ignore") return value;
  if (typeof value === "number") return "inherit";
  return fallback;
}

export function spawn(file, args = [], options = {}) {
  const listeners = new Map();
  const stdoutListeners = new Map();
  const stderrListeners = new Map();
  const stdinListeners = new Map();
  let closed = false;
  let unregisterSpawnListener = null;

  let stdinMode = "pipe";
  let stdoutMode = "pipe";
  let stderrMode = "pipe";
  if (Array.isArray(options.stdio)) {
    stdinMode = normalizeStdio(options.stdio[0], stdinMode);
    stdoutMode = normalizeStdio(options.stdio[1], stdoutMode);
    stderrMode = normalizeStdio(options.stdio[2], stderrMode);
  } else if (typeof options.stdio === "string") {
    stdinMode = stdoutMode = stderrMode = normalizeStdio(options.stdio, "pipe");
  }
  stdinMode = normalizeStdio(options.stdin, stdinMode);
  stdoutMode = normalizeStdio(options.stdout, stdoutMode);
  stderrMode = normalizeStdio(options.stderr, stderrMode);

  const nativeOptions = prepareNativeOptions(file, options);
  const native = cottontail.spawnStart(String(file), Array.from(args ?? [], String), {
    cwd: options.cwd,
    env: nativeOptions.env,
    clearEnv: nativeOptions.clearEnv,
    stdin: stdinMode,
    stdout: stdoutMode,
    stderr: stderrMode,
  });

  const emitFrom = (map, name, ...values) => {
    for (const handler of map.get(name) ?? []) handler(...values);
  };
  const addTo = (map, name, handler) => {
    const handlers = map.get(name) ?? [];
    handlers.push(handler);
    map.set(name, handlers);
  };
  const removeFrom = (map, name, handler) => {
    const handlers = map.get(name) ?? [];
    map.set(name, handlers.filter((item) => item !== handler));
  };

  const makeStream = (map, fd, writeImpl = null) => ({
    fd,
    on(name, handler) {
      addTo(map, name, handler);
      return this;
    },
    once(name, handler) {
      const wrapped = (...values) => {
        this.off(name, wrapped);
        handler(...values);
      };
      return this.on(name, wrapped);
    },
    off(name, handler) {
      removeFrom(map, name, handler);
      return this;
    },
    removeListener(name, handler) {
      return this.off(name, handler);
    },
    write(chunk, callback) {
      if (!writeImpl) return false;
      const ok = writeImpl(chunk);
      if (typeof callback === "function") callback(ok ? null : new Error("write failed"));
      return ok;
    },
    end(chunk) {
      if (chunk != null && writeImpl) writeImpl(chunk);
      if (writeImpl) cottontail.spawnCloseStdin(native.id);
      emitFrom(map, "finish");
    },
    destroy() {
      if (writeImpl) cottontail.spawnCloseStdin(native.id);
      emitFrom(map, "close");
    },
    ref() { return this; },
    unref() { return this; },
  });

  const child = Object.assign(new ChildProcess(), {
    pid: native.pid ?? 0,
    stdin: stdinMode === "pipe" ? makeStream(stdinListeners, 0, (chunk) => cottontail.spawnWrite(native.id, chunk)) : null,
    stdout: stdoutMode === "pipe" ? makeStream(stdoutListeners, 1) : null,
    stderr: stderrMode === "pipe" ? makeStream(stderrListeners, 2) : null,
    on(name, handler) {
      const handlers = listeners.get(name) ?? [];
      handlers.push(handler);
      listeners.set(name, handlers);
      return child;
    },
    once(name, handler) {
      const wrapped = (...values) => {
        child.off(name, wrapped);
        handler(...values);
      };
      return child.on(name, wrapped);
    },
    off(name, handler) {
      const handlers = listeners.get(name) ?? [];
      listeners.set(name, handlers.filter((item) => item !== handler));
      return child;
    },
    emit(name, ...values) {
      emitChild(name, ...values);
      return (listeners.get(name) ?? []).length > 0;
    },
    kill(signal = "SIGTERM") {
      const signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGALRM: 14, SIGTERM: 15 };
      const signalNumber = typeof signal === "number" ? signal : signals[String(signal).toUpperCase()] ?? 15;
      const killed = cottontail.spawnKill?.(native.id, signalNumber) === true;
      child.killed = child.killed || killed;
      return killed;
    },
    ref() {
      unregisterSpawnListener?.ref?.();
      return child;
    },
    unref() {
      unregisterSpawnListener?.unref?.();
      return child;
    },
  });

  const emitChild = (name, ...values) => {
    for (const handler of listeners.get(name) ?? []) handler(...values);
  };

  unregisterSpawnListener = globalThis.__cottontailRegisterSpawnListener?.(native.id, (event) => {
    if (!event) return;
    if (event.type === "stdout") {
      const bytes = new Uint8Array(event.data ?? new ArrayBuffer(0));
      if (bytes.length > 0) emitFrom(stdoutListeners, "data", globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : bytes);
      return;
    }
    if (event.type === "stderr") {
      const bytes = new Uint8Array(event.data ?? new ArrayBuffer(0));
      if (bytes.length > 0) emitFrom(stderrListeners, "data", globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : bytes);
      return;
    }
    if (event.type === "exit" && !closed) {
      closed = true;
      if (unregisterSpawnListener != null) {
        unregisterSpawnListener();
        unregisterSpawnListener = null;
      }
      const exitCode = event.exitCode ?? 0;
      const signalCode = event.signalCode == null ? null : event.signalCode;
      child.exitCode = exitCode;
      child.signalCode = signalCode;
      if (child.stdout) {
        emitFrom(stdoutListeners, "end");
        emitFrom(stdoutListeners, "close");
      }
      if (child.stderr) {
        emitFrom(stderrListeners, "end");
        emitFrom(stderrListeners, "close");
      }
      emitChild("exit", exitCode, signalCode);
      emitChild("close", exitCode, signalCode);
      cottontail.spawnDispose?.(native.id);
    }
  });

  return child;
}

function normalizeExecFileArgs(args, options, callback) {
  if (typeof args === "function") {
    callback = args;
    args = [];
    options = {};
  } else if (!Array.isArray(args)) {
    callback = typeof options === "function" ? options : callback;
    options = args ?? {};
    args = [];
  } else if (typeof options === "function") {
    callback = options;
    options = {};
  }
  return { args, options: options ?? {}, callback };
}

function collectChild(child, options, callback, commandText) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("close", (code, signal) => {
    const stdoutValue = options.encoding === "buffer" || options.encoding === null ? Buffer.from(stdout) : stdout;
    const stderrValue = options.encoding === "buffer" || options.encoding === null ? Buffer.from(stderr) : stderr;
    if (code === 0) {
      callback?.(null, stdoutValue, stderrValue);
      return;
    }
    const error = new Error(`Command failed: ${commandText}`);
    error.code = code;
    error.signal = signal;
    error.stdout = stdoutValue;
    error.stderr = stderrValue;
    callback?.(error, stdoutValue, stderrValue);
  });
  return child;
}

export function execFile(file, args = [], options = {}, callback = undefined) {
  const normalized = normalizeExecFileArgs(args, options, callback);
  const child = spawn(file, normalized.args, {
    ...normalized.options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return collectChild(child, normalized.options, normalized.callback, String(file));
}

export function exec(command, options = {}, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const shell = cottontail.platform() === "win32" ? "cmd" : "sh";
  const args = cottontail.platform() === "win32" ? ["/d", "/s", "/c", String(command)] : ["-c", String(command)];
  const child = spawn(shell, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return collectChild(child, options, callback, String(command));
}

const ipcPrefix = "__COTTONTAIL_IPC__";

export function fork(modulePath, args = [], options = {}) {
  if (!Array.isArray(args)) {
    options = args ?? {};
    args = [];
  }

  const env = withoutElectrobunHostEnv({
    ...process.env,
    ...(options.env ?? {}),
    COTTONTAIL_IPC_STDIO: "1",
  });
  const execArgv = Array.from(options.execArgv ?? process.execArgv ?? [], String);
  const child = spawn(process.execPath, [...execArgv, String(modulePath), ...Array.from(args ?? [], String)], {
    ...options,
    env,
    stdio: ["pipe", "pipe", options.silent ? "pipe" : "inherit"],
  });

  child.connected = true;
  let stdoutBuffer = "";

  child.stdout?.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    for (;;) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.startsWith(ipcPrefix)) {
        try {
          emitChildMessage(child, JSON.parse(line.slice(ipcPrefix.length)));
        } catch (error) {
          child.emit?.("error", error);
        }
      } else if (!options.silent) {
        process.stdout.write(`${line}\n`);
      }
    }
  });

  child.send = (message, callback = undefined) => {
    if (!child.connected || !child.stdin) {
      if (typeof callback === "function") callback(new Error("IPC channel is closed"));
      return false;
    }
    const ok = child.stdin.write(`${ipcPrefix}${JSON.stringify(message)}\n`);
    if (typeof callback === "function") callback(ok ? null : new Error("write failed"));
    return ok;
  };
  child.disconnect = () => {
    if (!child.connected) return;
    child.connected = false;
    child.stdin?.end();
    emitChildMessage(child, undefined, "disconnect");
  };

  child.on("close", () => {
    child.connected = false;
  });

  return child;
}

function emitChildMessage(child, message, eventName = "message") {
  if (typeof child.emit === "function") {
    child.emit(eventName, message);
    return;
  }
  const listeners = child.__cottontailForkListeners?.get(eventName) ?? [];
  for (const listener of listeners) listener(message);
}

export function _forkChild() {
  throw new Error("child_process._forkChild is an internal Node bootstrap hook and is not available in Cottontail");
}

// COTTONTAIL-COMPAT: node:child_process internals - public spawn/exec/fork paths are implemented; _forkChild remains an internal bootstrap hook.

export default { ChildProcess, _forkChild, exec, execFile, execFileSync, execSync, fork, spawn, spawnSync };
