import { EventEmitter } from "./events.js";
import { Buffer } from "./buffer.js";
import { deserialize, serialize } from "./v8.js";
import { Server as NetServer, Socket as NetSocket } from "./net.js";

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
  const result = normalizeSyncResult(cottontail.spawnSync(cottontail.platform() === "win32" ? "cmd" : "sh", cottontail.platform() === "win32" ? ["/d", "/s", "/c", String(command)] : ["-c", String(command)], {
    stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    cwd: options.cwd,
    env: nativeOptions.env,
    clearEnv: nativeOptions.clearEnv,
  }), options);
  if (result.status !== 0) {
    const error = new Error(result.stderr?.toString?.() || result.stdout?.toString?.() || `Command failed: ${command}`);
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return options.encoding ? result.stdout : result.stdout;
}

export function execFileSync(file, args = [], options = {}) {
  const normalized = normalizeSpawnArgs(args, options);
  const command = normalizeSpawnCommand(file, normalized.args, normalized.options);
  const nativeOptions = prepareNativeOptions(command.file, normalized.options);
  const result = normalizeSyncResult(cottontail.spawnSync(command.file, command.args, {
    stdio: normalized.options.stdio === "inherit" ? "inherit" : "pipe",
    cwd: normalized.options.cwd,
    env: nativeOptions.env,
    clearEnv: nativeOptions.clearEnv,
    input: normalized.options.input,
  }), normalized.options);
  if (result.status !== 0) {
    const error = new Error(result.stderr?.toString?.() || result.stdout?.toString?.() || `Command failed: ${file}`);
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  if (normalized.options.stdio === "inherit") return null;
  return result.stdout;
}

export function spawnSync(file, args = [], options = {}) {
  const normalized = normalizeSpawnArgs(args, options);
  const command = normalizeSpawnCommand(file, normalized.args, normalized.options);
  const nativeOptions = prepareNativeOptions(command.file, normalized.options);
  return normalizeSyncResult(cottontail.spawnSync(command.file, command.args, {
    stdio: normalized.options.stdio === "inherit" ? "inherit" : "pipe",
    cwd: normalized.options.cwd,
    env: nativeOptions.env,
    clearEnv: nativeOptions.clearEnv,
    input: normalized.options.input,
  }), normalized.options);
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

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_\/:=-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function normalizeSpawnArgs(args, options) {
  if (!Array.isArray(args)) {
    options = args ?? {};
    args = [];
  }
  return { args: Array.from(args ?? [], String), options: options ?? {} };
}

function normalizeSpawnCommand(file, args = [], options = {}) {
  if (!options.shell) return { file: String(file), args: Array.from(args ?? [], String) };
  const argList = Array.from(args ?? [], String);
  const command = argList.length === 0
    ? String(file)
    : [String(file), ...argList.map(shellQuote)].join(" ");
  if (cottontail.platform() === "win32") {
    const shell = typeof options.shell === "string" ? options.shell : "cmd";
    return { file: shell, args: ["/d", "/s", "/c", command] };
  }
  const shell = typeof options.shell === "string" ? options.shell : "sh";
  return { file: shell, args: ["-c", command] };
}

function normalizeSyncResult(result, options = {}) {
  const encoding = options.encoding === "buffer" ? null : options.encoding;
  const stdoutBuffer = Buffer.from(result.stdout || "");
  const stderrBuffer = Buffer.from(result.stderr || "");
  const stdout = encoding ? stdoutBuffer.toString(encoding) : stdoutBuffer;
  const stderr = encoding ? stderrBuffer.toString(encoding) : stderrBuffer;
  return {
    status: Number(result.status ?? 0),
    signal: result.signal ?? null,
    error: result.error,
    output: [null, stdout, stderr],
    pid: Number(result.pid ?? 0),
    stdout,
    stderr,
  };
}

function makeAbortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function normalizeStdio(value, fallback) {
  if (value === undefined) return fallback;
  if (value === null) return "ignore";
  if (value === "pipe" || value === "inherit" || value === "ignore") return value;
  if (value === "ipc") return "pipe";
  if (typeof value === "number") return "inherit";
  return fallback;
}

export function spawn(file, args = [], options = {}) {
  const normalized = normalizeSpawnArgs(args, options);
  args = normalized.args;
  options = normalized.options;
  const command = normalizeSpawnCommand(file, args, options);
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
  const ipcRequested = options.ipc === true || (Array.isArray(options.stdio) && options.stdio.some((item) => item === "ipc"));

  const nativeOptions = prepareNativeOptions(command.file, options);
  const native = cottontail.spawnStart(command.file, command.args, {
    cwd: options.cwd,
    env: nativeOptions.env,
    clearEnv: nativeOptions.clearEnv,
    stdin: stdinMode,
    stdout: stdoutMode,
    stderr: stderrMode,
    ipc: ipcRequested,
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
    _encoding: null,
    destroyed: false,
    writableHighWaterMark: Number(options.highWaterMark || 16 * 1024),
    writableLength: 0,
    writableNeedDrain: false,
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
    emit(name, ...values) {
      emitFrom(map, name, ...values);
      return (map.get(name) ?? []).length > 0;
    },
    write(chunk, callback) {
      if (!writeImpl) return false;
      const length = Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : String(chunk));
      this.writableLength += length;
      const ok = writeImpl(chunk);
      const overHighWaterMark = this.writableLength >= this.writableHighWaterMark;
      if (ok && overHighWaterMark) this.writableNeedDrain = true;
      queueMicrotask(() => {
        this.writableLength = Math.max(0, this.writableLength - length);
        if (this.writableNeedDrain && this.writableLength === 0) {
          this.writableNeedDrain = false;
          emitFrom(map, "drain");
        }
        if (typeof callback === "function") callback(ok ? null : new Error("write failed"));
      });
      return ok && !overHighWaterMark;
    },
    end(chunk) {
      if (chunk != null && writeImpl) writeImpl(chunk);
      if (writeImpl) cottontail.spawnCloseStdin(native.id);
      emitFrom(map, "finish");
      this.destroyed = true;
      emitFrom(map, "close");
      return this;
    },
    destroy() {
      if (writeImpl) cottontail.spawnCloseStdin(native.id);
      this.destroyed = true;
      emitFrom(map, "close");
      return this;
    },
    setEncoding(encoding = "utf8") {
      this._encoding = String(encoding || "utf8").toLowerCase();
      return this;
    },
    pipe(destination, pipeOptions = {}) {
      this.on("data", (chunk) => destination.write?.(chunk));
      if (pipeOptions.end !== false) this.on("end", () => destination.end?.());
      return destination;
    },
    pause() { return this; },
    resume() { return this; },
    ref() { return this; },
    unref() { return this; },
  });

  const streamChunk = (stream, bytes) => {
    const buffer = Buffer.from(bytes);
    return stream?._encoding ? buffer.toString(stream._encoding) : buffer;
  };

  const child = Object.assign(new ChildProcess(), {
    pid: native.pid ?? 0,
    stdin: stdinMode === "pipe" ? makeStream(stdinListeners, 0, (chunk) => cottontail.spawnWrite(native.id, chunk)) : null,
    stdout: stdoutMode === "pipe" ? makeStream(stdoutListeners, 1) : null,
    stderr: stderrMode === "pipe" ? makeStream(stderrListeners, 2) : null,
    _nativeId: native.id,
    _ipcFd: native.ipcFd == null ? null : Number(native.ipcFd),
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

  if (options.timeout != null && Number(options.timeout) > 0) {
    child._timeoutTimer = setTimeout(() => {
      child.kill(options.killSignal ?? "SIGTERM");
    }, Number(options.timeout));
  }

  let abortHandler = null;
  if (options.signal) {
    abortHandler = () => {
      const error = makeAbortError();
      child.kill(options.killSignal ?? "SIGTERM");
      child.emit("error", error);
    };
    if (options.signal.aborted) queueMicrotask(abortHandler);
    else options.signal.addEventListener?.("abort", abortHandler, { once: true });
  }

  const emitChild = (name, ...values) => {
    for (const handler of listeners.get(name) ?? []) handler(...values);
  };

  unregisterSpawnListener = globalThis.__cottontailRegisterSpawnListener?.(native.id, (event) => {
    if (!event) return;
    if (event.type === "stdout") {
      const bytes = new Uint8Array(event.data ?? new ArrayBuffer(0));
      if (bytes.length > 0) emitFrom(stdoutListeners, "data", streamChunk(child.stdout, bytes));
      return;
    }
    if (event.type === "stderr") {
      const bytes = new Uint8Array(event.data ?? new ArrayBuffer(0));
      if (bytes.length > 0) emitFrom(stderrListeners, "data", streamChunk(child.stderr, bytes));
      return;
    }
    if (event.type === "ipc") {
      if (typeof child._handleIpcEvent === "function") {
        child._handleIpcEvent(event);
      } else {
        child._pendingIpcEvents ??= [];
        child._pendingIpcEvents.push(event);
      }
      return;
    }
    if (event.type === "exit" && !closed) {
      closed = true;
      if (child._timeoutTimer != null) {
        clearTimeout(child._timeoutTimer);
        child._timeoutTimer = null;
      }
      if (abortHandler != null) options.signal?.removeEventListener?.("abort", abortHandler);
      if (unregisterSpawnListener != null) {
        unregisterSpawnListener();
        unregisterSpawnListener = null;
      }
      const exitCode = event.exitCode ?? 0;
      const signalCode = event.signalCode == null ? null : event.signalCode;
      child.exitCode = exitCode;
      child.signalCode = signalCode;
      if (Array.isArray(child._pendingIpcEvents)) {
        for (const pendingEvent of child._pendingIpcEvents) {
          if (Number.isInteger(pendingEvent?.fd) && pendingEvent.fd >= 0) cottontail.closeFd?.(pendingEvent.fd);
        }
        child._pendingIpcEvents = [];
      }
      if (child.stdout) {
        child.stdout.destroyed = true;
        emitFrom(stdoutListeners, "end");
        emitFrom(stdoutListeners, "close");
      }
      if (child.stderr) {
        child.stderr.destroyed = true;
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
  let settled = false;
  const maxBuffer = options.maxBuffer == null ? 1024 * 1024 : Number(options.maxBuffer);
  const fail = (error) => {
    if (settled) return;
    settled = true;
    const stdoutValue = options.encoding === "buffer" || options.encoding === null ? Buffer.from(stdout) : stdout;
    const stderrValue = options.encoding === "buffer" || options.encoding === null ? Buffer.from(stderr) : stderr;
    error.stdout = stdoutValue;
    error.stderr = stderrValue;
    callback?.(error, stdoutValue, stderrValue);
  };
  const append = (target, chunk) => {
    const next = target + chunk.toString();
    if (maxBuffer >= 0 && Buffer.byteLength(next) > maxBuffer) {
      const error = new RangeError(`${commandText} stdout maxBuffer length exceeded`);
      error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      child.kill(options.killSignal ?? "SIGTERM");
      fail(error);
    }
    return next;
  };
  child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
  child.on("error", fail);
  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
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
const ipcEnvelopeKey = "__cottontailIpcEnvelope";

function encodeIpcMessage(message, mode = "json") {
  if (mode === "advanced") return `A:${serialize(message).toString("base64")}`;
  return `J:${JSON.stringify(message)}`;
}

function decodeIpcMessage(payload) {
  const text = String(payload);
  if (text.startsWith("A:")) return deserialize(Buffer.from(text.slice(2), "base64"));
  if (text.startsWith("J:")) return JSON.parse(text.slice(2));
  return JSON.parse(text);
}

function normalizeSendArgs(sendHandleOrCallback = undefined, optionsOrCallback = undefined, callback = undefined) {
  let sendHandle = sendHandleOrCallback;
  let options = optionsOrCallback;
  if (typeof sendHandleOrCallback === "function") {
    callback = sendHandleOrCallback;
    sendHandle = undefined;
    options = undefined;
  } else if (typeof optionsOrCallback === "function") {
    callback = optionsOrCallback;
    options = undefined;
  }
  return { sendHandle, options, callback };
}

function ipcHandleInfo(sendHandle = undefined) {
  if (sendHandle == null) return null;
  if (Number.isInteger(sendHandle.fd) && sendHandle.fd >= 0) {
    return {
      fd: Number(sendHandle.fd),
      type: sendHandle instanceof NetSocket ? "net.Socket" : "net.Handle",
    };
  }
  if (Number.isInteger(sendHandle._fd) && sendHandle._fd >= 0) {
    return {
      fd: Number(sendHandle._fd),
      type: sendHandle instanceof NetServer ? "net.Server" : "net.Handle",
    };
  }
  if (Number.isInteger(sendHandle._handle?.fd) && sendHandle._handle.fd >= 0) {
    return { fd: Number(sendHandle._handle.fd), type: "net.Handle" };
  }
  throw new TypeError("child_process IPC sendHandle must expose a native file descriptor");
}

function receivedIpcHandle(fd = undefined, type = "net.Socket") {
  if (!Number.isInteger(fd) || fd < 0) return undefined;
  if (type === "net.Server" && typeof NetServer._fromFd === "function") return NetServer._fromFd(fd);
  let local;
  let remote;
  try { local = cottontail.tcpSocketAddress?.(fd, false); } catch {}
  try { remote = cottontail.tcpSocketAddress?.(fd, true); } catch {}
  return new NetSocket({ fd, local, remote, pipe: local?.path != null || remote?.path != null, path: local?.path ?? remote?.path });
}

function encodeNativeIpcPayload(message, mode, handleInfo) {
  const payload = handleInfo == null
    ? message
    : { [ipcEnvelopeKey]: 1, message, handleType: handleInfo.type };
  return `${ipcPrefix}${encodeIpcMessage(payload, mode)}\n`;
}

function decodeNativeIpcPayload(payload, receivedFd = undefined) {
  const decoded = decodeIpcMessage(payload);
  if (decoded && typeof decoded === "object" && decoded[ipcEnvelopeKey] === 1) {
    return {
      message: decoded.message,
      handle: receivedIpcHandle(receivedFd, decoded.handleType),
    };
  }
  return {
    message: decoded,
    handle: receivedIpcHandle(receivedFd),
  };
}

function writeNativeIpc(fd, message, mode, sendHandle = undefined) {
  const handleInfo = ipcHandleInfo(sendHandle);
  return cottontail.ipcSend?.(Number(fd), encodeNativeIpcPayload(message, mode, handleInfo), handleInfo?.fd ?? -1) === true;
}

function installNativeIpcReader(fd, onFrame, onDisconnect, onError, closeFd = true) {
  if (!Number.isInteger(fd) || fd < 0 || typeof cottontail.ipcRecv !== "function") return null;
  let buffer = "";
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (closeFd) {
      try { cottontail.closeFd?.(fd); } catch {}
    }
  };
  const timer = setInterval(() => {
    if (closed) return;
    try {
      for (;;) {
        const event = cottontail.ipcRecv(fd, 64 * 1024);
        if (event == null) return;
        if (event.end) {
          close();
          onDisconnect?.();
          return;
        }
        const chunk = Buffer.from(event.data ?? new ArrayBuffer(0)).toString("utf8");
        let pendingFd = Number.isInteger(event.fd) ? Number(event.fd) : undefined;
        buffer += chunk;
        for (;;) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex < 0) break;
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
          buffer = buffer.slice(newlineIndex + 1);
          const frameFd = pendingFd;
          pendingFd = undefined;
          if (!line.startsWith(ipcPrefix)) {
            if (Number.isInteger(frameFd) && frameFd >= 0) cottontail.closeFd?.(frameFd);
            continue;
          }
          const frame = decodeNativeIpcPayload(line.slice(ipcPrefix.length), frameFd);
          onFrame(frame.message, frame.handle);
        }
        if (Number.isInteger(pendingFd) && pendingFd >= 0) cottontail.closeFd?.(pendingFd);
      }
    } catch (error) {
      onError?.(error);
    }
  }, 1);
  return close;
}

export function fork(modulePath, args = [], options = {}) {
  if (!Array.isArray(args)) {
    options = args ?? {};
    args = [];
  }

  const env = withoutElectrobunHostEnv({
    ...process.env,
    ...(options.env ?? {}),
    COTTONTAIL_IPC_STDIO: "1",
    COTTONTAIL_IPC_BOOTSTRAP: "node",
    COTTONTAIL_IPC_SERIALIZATION: options.serialization === "advanced" ? "advanced" : "json",
  });
  const execArgv = Array.from(options.execArgv ?? process.execArgv ?? [], String);
  const child = spawn(process.execPath, [...execArgv, String(modulePath), ...Array.from(args ?? [], String)], {
    ...options,
    env,
    ipc: true,
    stdio: ["pipe", "pipe", options.silent ? "pipe" : "inherit"],
  });

  child.connected = true;
  child.serialization = options.serialization === "advanced" ? "advanced" : "json";
  let stdoutBuffer = "";
  let nativeIpcPendingFd = undefined;

  if (Number.isInteger(child._ipcFd) && child._ipcFd >= 0) {
    child._ipcBuffer = "";
    child._handleIpcEvent = (event) => {
      try {
        const eventFd = Number.isInteger(event.fd) ? Number(event.fd) : undefined;
        if (Number.isInteger(eventFd) && eventFd >= 0) {
          if (Number.isInteger(nativeIpcPendingFd) && nativeIpcPendingFd >= 0) cottontail.closeFd?.(nativeIpcPendingFd);
          nativeIpcPendingFd = eventFd;
        }
        child._ipcBuffer += Buffer.from(event.data ?? new ArrayBuffer(0)).toString("utf8");
        for (;;) {
          const newlineIndex = child._ipcBuffer.indexOf("\n");
          if (newlineIndex < 0) break;
          const line = child._ipcBuffer.slice(0, newlineIndex).replace(/\r$/, "");
          child._ipcBuffer = child._ipcBuffer.slice(newlineIndex + 1);
          const frameFd = nativeIpcPendingFd;
          nativeIpcPendingFd = undefined;
          if (!line.startsWith(ipcPrefix)) {
            if (Number.isInteger(frameFd) && frameFd >= 0) cottontail.closeFd?.(frameFd);
            continue;
          }
          const frame = decodeNativeIpcPayload(line.slice(ipcPrefix.length), frameFd);
          emitChildMessage(child, frame.message, "message", frame.handle);
        }
      } catch (error) {
        child.emit?.("error", error);
      }
    };
    const pendingEvents = Array.isArray(child._pendingIpcEvents) ? child._pendingIpcEvents : [];
    child._pendingIpcEvents = [];
    for (const event of pendingEvents) child._handleIpcEvent(event);
    child.stdout?.on("data", (chunk) => {
      if (!options.silent) process.stdout.write(String(chunk));
    });
  } else {
    child.stdout?.on("data", (chunk) => {
      stdoutBuffer += String(chunk);
      for (;;) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.startsWith(ipcPrefix)) {
          try {
            emitChildMessage(child, decodeIpcMessage(line.slice(ipcPrefix.length)));
          } catch (error) {
            child.emit?.("error", error);
          }
        } else if (!options.silent) {
          process.stdout.write(`${line}\n`);
        }
      }
    });
  }

  child.send = (message, sendHandleOrCallback = undefined, optionsOrCallback = undefined, callback = undefined) => {
    const normalizedSend = normalizeSendArgs(sendHandleOrCallback, optionsOrCallback, callback);
    if (!child.connected || (!child.stdin && !Number.isInteger(child._ipcFd))) {
      if (typeof normalizedSend.callback === "function") normalizedSend.callback(new Error("IPC channel is closed"));
      return false;
    }
    let ok = false;
    try {
      if (Number.isInteger(child._ipcFd) && child._ipcFd >= 0 && typeof cottontail.ipcSend === "function") {
        ok = writeNativeIpc(child._ipcFd, message, child.serialization, normalizedSend.sendHandle);
      } else {
        if (normalizedSend.sendHandle != null) throw new Error("IPC handle passing is only available on native IPC channels");
        ok = child.stdin.write(`${ipcPrefix}${encodeIpcMessage(message, child.serialization)}\n`);
      }
    } catch (error) {
      if (typeof normalizedSend.callback === "function") normalizedSend.callback(error);
      child.emit?.("error", error);
      return false;
    }
    if (typeof normalizedSend.callback === "function") normalizedSend.callback(ok ? null : new Error("write failed"));
    return ok;
  };
  child.disconnect = () => {
    if (!child.connected) return;
    child.connected = false;
    if (Number.isInteger(child._ipcFd) && child._ipcFd >= 0) {
      cottontail.spawnCloseIpc?.(child._nativeId);
    } else {
      child.stdin?.end();
    }
    emitChildMessage(child, undefined, "disconnect");
  };

  child.on("close", () => {
    child.connected = false;
    child._handleIpcEvent = null;
    if (Number.isInteger(nativeIpcPendingFd) && nativeIpcPendingFd >= 0) {
      cottontail.closeFd?.(nativeIpcPendingFd);
      nativeIpcPendingFd = undefined;
    }
  });

  return child;
}

function emitChildMessage(child, message, eventName = "message", handle = undefined) {
  if (typeof child.emit === "function") {
    if (handle !== undefined) child.emit(eventName, message, handle);
    else child.emit(eventName, message);
    return;
  }
  const listeners = child.__cottontailForkListeners?.get(eventName) ?? [];
  for (const listener of listeners) {
    if (handle !== undefined) listener(message, handle);
    else listener(message);
  }
}

export function _forkChild(fd = 0, serializationMode = undefined) {
  serializationMode ??= globalThis.process?.env?.COTTONTAIL_IPC_SERIALIZATION ?? "json";
  if (serializationMode !== "json" && serializationMode !== "advanced") {
    throw new TypeError(`Unknown child_process serialization mode: ${serializationMode}`);
  }
  const processObject = globalThis.process;
  if (!processObject || typeof processObject.send === "function") return;
  const nativeFd = Number(processObject.env?.COTTONTAIL_IPC_FD ?? fd);
  const hasNativeIpc = Number.isInteger(nativeFd) && nativeFd > 2 && typeof cottontail.ipcSend === "function" && typeof cottontail.ipcRecv === "function";

  processObject.connected = true;
  let stopNativeIpc = null;

  processObject.send = (message, sendHandleOrCallback = undefined, optionsOrCallback = undefined, callback = undefined) => {
    const normalizedSend = normalizeSendArgs(sendHandleOrCallback, optionsOrCallback, callback);
    if (!processObject.connected) {
      if (typeof normalizedSend.callback === "function") normalizedSend.callback(new Error("IPC channel is closed"));
      return false;
    }
    let ok = false;
    try {
      if (hasNativeIpc) {
        ok = writeNativeIpc(nativeFd, message, serializationMode, normalizedSend.sendHandle);
      } else {
        if (normalizedSend.sendHandle != null) throw new Error("IPC handle passing is only available on native IPC channels");
        ok = processObject.stdout?.write?.(`${ipcPrefix}${encodeIpcMessage(message, serializationMode)}\n`) === true;
      }
    } catch (error) {
      if (typeof normalizedSend.callback === "function") normalizedSend.callback(error);
      processObject.emit?.("error", error);
      return false;
    }
    if (typeof normalizedSend.callback === "function") normalizedSend.callback(ok ? null : new Error("write failed"));
    return ok;
  };
  processObject.disconnect = () => {
    if (!processObject.connected) return;
    processObject.connected = false;
    if (stopNativeIpc != null) {
      stopNativeIpc();
      stopNativeIpc = null;
    }
    processObject.emit?.("disconnect");
  };

  if (hasNativeIpc) {
    stopNativeIpc = installNativeIpcReader(
      nativeFd,
      (message, handle) => processObject.emit?.("message", message, handle),
      () => {
        if (processObject.connected) processObject.disconnect();
      },
      (error) => processObject.emit?.("error", error),
    );
  } else {
    let ipcBuffer = "";
    processObject.stdin?.setEncoding?.("utf8");
    processObject.stdin?.on?.("data", (chunk) => {
      ipcBuffer += String(chunk);
      for (;;) {
        const newlineIndex = ipcBuffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = ipcBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        ipcBuffer = ipcBuffer.slice(newlineIndex + 1);
        if (!line.startsWith(ipcPrefix)) continue;
        try {
          processObject.emit?.("message", decodeIpcMessage(line.slice(ipcPrefix.length)));
        } catch (error) {
          processObject.emit?.("error", error);
        }
      }
    });
    processObject.stdin?.on?.("end", () => {
      if (processObject.connected) processObject.disconnect();
    });
    processObject.stdin?.resume?.();
  }
}

export default { ChildProcess, _forkChild, exec, execFile, execFileSync, execSync, fork, spawn, spawnSync };
