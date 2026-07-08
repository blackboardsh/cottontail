export function execSync(command, options = {}) {
  const result = cottontail.spawnSync(cottontail.platform() === "win32" ? "cmd" : "sh", cottontail.platform() === "win32" ? ["/d", "/s", "/c", String(command)] : ["-c", String(command)], {
    stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    cwd: options.cwd,
    env: options.env,
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
  const result = cottontail.spawnSync(String(file), Array.from(args ?? [], String), {
    stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    cwd: options.cwd,
    env: options.env,
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
  return cottontail.spawnSync(String(file), Array.from(args, String), {
    stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    cwd: options.cwd,
    env: options.env,
  });
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

  const native = cottontail.spawnStart(String(file), Array.from(args ?? [], String), {
    cwd: options.cwd,
    env: options.env,
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

  const child = {
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
    kill(signal = "SIGTERM") {
      const signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGALRM: 14, SIGTERM: 15 };
      const signalNumber = typeof signal === "number" ? signal : signals[String(signal).toUpperCase()] ?? 15;
      return cottontail.spawnKill?.(native.id, signalNumber) === true;
    },
    ref() {
      unregisterSpawnListener?.ref?.();
      return child;
    },
    unref() {
      unregisterSpawnListener?.unref?.();
      return child;
    },
  };

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

export default { execFileSync, execSync, spawn, spawnSync };
