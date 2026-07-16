import { EventEmitter } from "./events.js";
import { Buffer } from "./buffer.js";
import { deserialize, serialize } from "./v8.js";
import { Server as NetServer, Socket as NetSocket } from "./net.js";
import { Readable as ReadableStreamClass, Writable as WritableStreamClass } from "./stream.js";
import { accessSync, statSync, writeSync, constants as fsConstants } from "./fs.js";

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

  // Node-internal API used by tests: proc.spawn({ file, args }) where args[0] is argv0.
  spawn(options) {
    if (options == null || typeof options !== "object") {
      throw invalidArgTypeError("options", "object", options);
    }
    if (typeof options.file !== "string") {
      throw invalidArgTypeError("options.file", "string", options.file);
    }
    if (options.envPairs !== undefined && !Array.isArray(options.envPairs)) {
      throw invalidArgTypeError("options.envPairs", "Array", options.envPairs);
    }
    if (options.stdio !== undefined && !Array.isArray(options.stdio)) {
      throw invalidArgTypeError("options.stdio", "Array", options.stdio);
    }
    if (options.args !== undefined && !Array.isArray(options.args)) {
      throw invalidArgTypeError("options.args", "Array", options.args);
    }
    const file = String(options.file);
    const argv = Array.isArray(options?.args) ? Array.from(options.args, String) : [];
    const spawnOptions = { ...options, args: undefined, file: undefined, envPairs: undefined };
    if (options.envPairs !== undefined) spawnOptions.env = envPairsToObject(options.envPairs);
    return spawnInternal(file, argv.length > 0 ? argv.slice(1) : [], spawnOptions, this);
  }

  kill(signal = "SIGTERM") {
    normalizeKillSignal(signal); // validates; throws ERR_UNKNOWN_SIGNAL
    if (this._inner == null) return false;
    const killed = this._inner.kill(signal);
    this.killed = this._inner.killed;
    return killed;
  }
}

function receivedValueText(value) {
  const type = typeof value;
  if (type === "string") return `type string ('${value}')`;
  if (value === null) return "null";
  if (type === "symbol") return `type symbol (${String(value)})`;
  if (type === "function") return `function ${value.name || "(anonymous)"}`;
  if (type === "object") return `an instance of ${value.constructor?.name ?? "Object"}`;
  return `type ${type} (${String(value)})`;
}

function invalidArgTypeError(name, expected, value) {
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${receivedValueText(value)}`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function invalidFileArgError(file) {
  return invalidArgTypeError("file", "string", file);
}

function envPairsToObject(envPairs) {
  const env = Object.create(null);
  for (const pair of envPairs) {
    if (typeof pair !== "string") throw invalidArgTypeError("options.envPairs", "string[]", envPairs);
    const separator = pair.indexOf("=");
    const name = separator < 0 ? pair : pair.slice(0, separator);
    env[name] = separator < 0 ? "" : pair.slice(separator + 1);
  }
  return env;
}

const isDarwinPlatform = typeof cottontail?.platform === "function" ? cottontail.platform() === "darwin" : true;

const signalNumbersByName = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6,
  SIGFPE: 8, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  ...(isDarwinPlatform
    ? {
        SIGEMT: 7, SIGBUS: 10, SIGSYS: 12, SIGURG: 16, SIGSTOP: 17, SIGTSTP: 18, SIGCONT: 19,
        SIGCHLD: 20, SIGTTIN: 21, SIGTTOU: 22, SIGIO: 23, SIGXCPU: 24, SIGXFSZ: 25,
        SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGINFO: 29, SIGUSR1: 30, SIGUSR2: 31,
      }
    : {
        SIGBUS: 7, SIGUSR1: 10, SIGUSR2: 12, SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18,
        SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24,
        SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPWR: 30, SIGSYS: 31,
      }),
};

const signalNamesByNumber = {};
for (const [name, number] of Object.entries(signalNumbersByName)) {
  if (signalNamesByNumber[number] == null) signalNamesByNumber[number] = name;
}

function unknownSignalError(signal) {
  const error = new TypeError(`Unknown signal: ${String(signal)}`);
  error.code = "ERR_UNKNOWN_SIGNAL";
  return error;
}

function normalizeKillSignal(signal) {
  if (signal == null) return signalNumbersByName.SIGTERM;
  if (typeof signal === "number") {
    if (signal === 0 || signalNamesByNumber[signal] != null) return signal;
    throw unknownSignalError(signal);
  }
  if (typeof signal === "string") {
    const number = signalNumbersByName[signal.toUpperCase()];
    if (number != null) return number;
  }
  throw unknownSignalError(signal);
}

function signalNumberToName(signal) {
  if (signal == null) return null;
  if (typeof signal === "string") return signal;
  return signalNamesByNumber[signal] ?? null;
}

function prepareSyncInput(input, encoding = undefined) {
  if (input == null) return undefined;
  if (typeof input === "string") {
    return Buffer.from(input, encoding && encoding !== "buffer" ? encoding : "utf8");
  }
  return input;
}

function makeSpawnFailureResult(file, cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  const notFound = /filenotfound|enoent|no such file/i.test(message);
  const error = notFound ? new Error(`spawnSync ${file} ENOENT`) : new Error(message);
  error.code = notFound ? "ENOENT" : (cause?.code ?? "UNKNOWN");
  if (notFound) error.errno = -2;
  error.syscall = `spawnSync ${file}`;
  error.path = String(file);
  return {
    status: null,
    signal: null,
    error,
    output: [null, null, null],
    pid: 0,
    stdout: null,
    stderr: null,
  };
}

export function execSync(command, options = {}) {
  const isWin = cottontail.platform() === "win32";
  const shell = typeof options.shell === "string" && options.shell !== "" ? options.shell : (isWin ? "cmd" : "sh");
  const nativeOptions = prepareNativeOptions(shell, options);
  const result = normalizeSyncResult(cottontail.spawnSync(shell, isWin ? ["/d", "/s", "/c", String(command)] : ["-c", String(command)], {
    stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    cwd: normalizeCwdOption(options.cwd),
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
  if (typeof file !== "string") throw invalidFileArgError(file);
  const normalized = normalizeSpawnArgs(args, options);
  const command = normalizeSpawnCommand(file, normalized.args, normalized.options);
  const nativeOptions = prepareNativeOptions(command.file, normalized.options);
  let nativeResult;
  try {
    nativeResult = cottontail.spawnSync(command.file, command.args, {
      stdio: normalized.options.stdio === "inherit" ? "inherit" : "pipe",
      cwd: normalizeCwdOption(normalized.options.cwd),
      env: nativeOptions.env,
      clearEnv: nativeOptions.clearEnv,
      input: prepareSyncInput(normalized.options.input, normalized.options.encoding),
    });
  } catch (error) {
    throw makeSpawnFailureResult(file, error).error;
  }
  const result = normalizeSyncResult(nativeResult, normalized.options);
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

// Classify one spawnSync stdout/stderr stdio entry. The native spawner only
// supports whole-process capture, so redirect targets (fds, streams,
// "inherit") are serviced in JS: the captured bytes are forwarded to the
// target fd after the child exits and the result field is null (Node
// semantics: only "pipe" entries are captured).
function classifySyncOutputStdio(value, parentFd) {
  if (value === undefined || value === null || value === "pipe" || value === "overlapped") {
    return { capture: true };
  }
  if (value === "ignore") return { capture: false };
  if (value === "inherit") return { capture: false, targetFd: parentFd };
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { capture: false, targetFd: value };
  }
  if (typeof value === "object") {
    if (typeof value.fd === "number") return { capture: false, targetFd: value.fd };
    if (typeof value.write === "function") return { capture: false, targetStream: value };
  }
  return { capture: true };
}

function forwardSyncOutput(target, buffer) {
  if (!buffer || buffer.length === 0) return;
  try {
    if (target.targetStream) {
      target.targetStream.write(buffer);
    } else if (typeof target.targetFd === "number") {
      writeSync(target.targetFd, buffer);
    }
  } catch {}
}

export function spawnSync(file, args = [], options = {}) {
  if (typeof file !== "string") throw invalidFileArgError(file);
  const normalized = normalizeSpawnArgs(args, options);
  const command = normalizeSpawnCommand(file, normalized.args, normalized.options);
  const nativeOptions = prepareNativeOptions(command.file, normalized.options);
  const stdioOption = normalized.options.stdio;
  const stdioArray = Array.isArray(stdioOption)
    ? stdioOption
    : typeof stdioOption === "string"
      ? [stdioOption, stdioOption, stdioOption]
      : [];
  const stdoutTarget = classifySyncOutputStdio(stdioArray[1], 1);
  const stderrTarget = classifySyncOutputStdio(stdioArray[2], 2);
  const fullyInherited = stdioOption === "inherit";
  let result;
  try {
    result = cottontail.spawnSync(command.file, command.args, {
      stdio: fullyInherited ? "inherit" : "pipe",
      cwd: normalizeCwdOption(normalized.options.cwd),
      env: nativeOptions.env,
      clearEnv: nativeOptions.clearEnv,
      input: prepareSyncInput(normalized.options.input, normalized.options.encoding),
    });
  } catch (error) {
    return makeSpawnFailureResult(file, error);
  }
  const normalizedResult = normalizeSyncResult(result, normalized.options);
  if (!stdoutTarget.capture) {
    if (!fullyInherited) {
      forwardSyncOutput(stdoutTarget, Buffer.from(result.stdout || ""));
    }
    normalizedResult.stdout = null;
    normalizedResult.output[1] = null;
  }
  if (!stderrTarget.capture) {
    if (!fullyInherited) {
      forwardSyncOutput(stderrTarget, Buffer.from(result.stderr || ""));
    }
    normalizedResult.stderr = null;
    normalizedResult.output[2] = null;
  }
  return normalizedResult;
}

function withoutElectrobunHostEnv(env) {
  const next = { ...(env ?? {}) };
  for (const key of Object.keys(next)) {
    if (key.startsWith("COTTONTAIL_ELECTROBUN_")) delete next[key];
  }
  return next;
}

function sanitizeEnvObject(env) {
  if (env === undefined || env === null) return env;
  const sanitized = {};
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value === undefined) continue;
    sanitized[key] = String(value);
  }
  return sanitized;
}

function prepareNativeOptions(file, options = {}) {
  if (options.env == null) {
    // Node inherits the (possibly mutated) process.env object, not the raw environ.
    return {
      ...options,
      env: sanitizeEnvObject(withoutElectrobunHostEnv(process.env)),
      clearEnv: true,
    };
  }
  return {
    ...options,
    env: sanitizeEnvObject(options.env),
    clearEnv: true,
  };
}

function normalizeCwdOption(cwd) {
  if (cwd == null || cwd === "") return undefined;
  if (typeof cwd === "string") return cwd;
  // file:// URL support (Node accepts URL cwd)
  if (typeof cwd === "object" && cwd.protocol === "file:" && typeof cwd.pathname === "string") {
    return decodeURIComponent(cwd.pathname);
  }
  return String(cwd);
}

function normalizeSpawnArgs(args, options) {
  if (args == null) {
    args = [];
  } else if (!Array.isArray(args)) {
    if (typeof args !== "object") throw invalidArgTypeError("args", "Array", args);
    options = args;
    args = [];
  }
  options ??= {};
  if (typeof options !== "object") throw invalidArgTypeError("options", "object", options);
  return { args: Array.from(args, String), options };
}

function normalizeSpawnCommand(file, args = [], options = {}) {
  if (!options.shell) return { file: String(file), args: Array.from(args ?? [], String) };
  const argList = Array.from(args ?? [], String);
  // Node joins file and args verbatim (no quoting) when a shell is requested.
  const command = argList.length === 0
    ? String(file)
    : [String(file), ...argList].join(" ");
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
  const signal = result.signal ?? signalNumberToName(result.signalCode) ?? null;
  return {
    // Node reports status null when the child died from a signal.
    status: signal != null ? null : Number(result.status ?? 0),
    signal,
    error: result.error,
    output: [null, stdout, stderr],
    pid: Number(result.pid ?? 0),
    stdout,
    stderr,
  };
}

function makeAbortError(reason = undefined) {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  if (reason !== undefined) error.cause = reason;
  return error;
}

function normalizeStdio(value, fallback) {
  // Node treats both null and undefined stdio entries as the default (pipe
  // for fds 0-2).
  if (value === undefined || value === null) return fallback;
  if (value === "pipe" || value === "inherit" || value === "ignore") return value;
  if (value === "ipc") return "pipe";
  if (typeof value === "number") return "inherit";
  return fallback;
}

// Node surfaces exec failures (missing file, not executable) as an async
// 'error' event with ENOENT/EACCES rather than an exit code; approximate the
// spawn syscall's checks for direct paths before handing off to the native
// spawner.
function spawnPreflightError(resolvedFile, spawnargs, originalFile) {
  if (!String(resolvedFile).includes("/")) return null;
  const makeError = (code, errno) => {
    const error = new Error(`spawn ${originalFile} ${code}`);
    error.code = code;
    error.errno = errno;
    error.syscall = `spawn ${originalFile}`;
    error.path = String(originalFile);
    error.spawnargs = Array.from(spawnargs ?? [], String);
    return error;
  };
  let stats;
  try {
    stats = statSync(resolvedFile);
  } catch {
    return makeError("ENOENT", -2);
  }
  try {
    accessSync(resolvedFile, fsConstants.X_OK);
  } catch {
    return makeError("EACCES", -13);
  }
  if (stats.isDirectory()) return makeError("EACCES", -13);
  return null;
}

function normalizeSpawnError(file, spawnargs, cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  const causeCode = typeof cause?.code === "string" ? cause.code.toUpperCase() : "";
  let code;
  let errno;
  if (causeCode === "ENOENT" || /filenotfound|enoent|no such file/i.test(message)) {
    code = "ENOENT";
    errno = -2;
  } else if (causeCode === "EACCES" || /eacces|permission denied/i.test(message)) {
    code = "EACCES";
    errno = -13;
  } else {
    code = causeCode || "UNKNOWN";
    errno = cause?.errno;
  }
  const error = new Error(`spawn ${file} ${code}`);
  error.code = code;
  if (errno !== undefined) error.errno = errno;
  error.syscall = `spawn ${file}`;
  error.path = String(file);
  error.spawnargs = Array.from(spawnargs ?? [], String);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function spawnInternal(file, args = [], options = {}, target = undefined) {
  if (typeof file !== "string") throw invalidFileArgError(file);
  const normalized = normalizeSpawnArgs(args, options);
  args = normalized.args;
  options = normalized.options;
  const command = normalizeSpawnCommand(file, args, options);
  let preflightError = options.shell ? null : spawnPreflightError(command.file, args, file);
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
  const deferStart = command.file === globalThis.process?.execPath;
  let native = { id: -1, pid: 0, ipcFd: null };
  let startReleased = !deferStart;

  const releaseStart = () => {
    if (startReleased || preflightError != null || native.id < 0) return;
    startReleased = true;
    cottontail.spawnRelease?.(native.id);
  };

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

  // Writable.prototype.writable (and Readable.prototype.readable) are
  // accessor pairs whose setters no-op without _writableState/_readableState,
  // so Object.assign cannot install them; shadow with own data properties.
  // Node reports child.stdin.writable === true until end() is called (spawn
  // callers gate `stdin.end()` on it), and child.stdout.readable === true.
  const makeStreamShadowFlags = (fd, stream) => {
    for (const [name, value] of [["writable", fd === 0], ["readable", fd !== 0]]) {
      Object.defineProperty(stream, name, { value, writable: true, enumerable: true, configurable: true });
    }
    return stream;
  };

  // The prototype makes `child.stdout instanceof stream.Readable` (and stdin
  // instanceof stream.Writable) hold, matching Node; every method these pipe
  // objects actually support is an own property assigned below.
  const makeStream = (map, fd, writeImpl = null) => makeStreamShadowFlags(fd, Object.assign(Object.create(fd === 0 ? WritableStreamClass.prototype : ReadableStreamClass.prototype), {
    fd,
    _encoding: null,
    _readableBuffer: [],
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    read(size = undefined) {
      if (this._readableBuffer.length === 0) return null;
      const chunks = this._readableBuffer;
      this._readableBuffer = [];
      if (chunks.length === 1) return chunks[0];
      if (typeof chunks[0] === "string") return chunks.join("");
      return Buffer.concat(chunks);
    },
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
      this.writable = false;
      this.writableEnded = true;
      this.writableFinished = true;
      emitFrom(map, "finish");
      this.destroyed = true;
      emitFrom(map, "close");
      return this;
    },
    destroy(error = undefined) {
      if (writeImpl) cottontail.spawnCloseStdin(native.id);
      else cottontail.spawnCloseOutput?.(native.id, fd);
      this.writable = false;
      this.readable = false;
      this.destroyed = true;
      if (error != null) emitFrom(map, "error", error);
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
  }));

  const streamChunk = (stream, bytes) => {
    const buffer = Buffer.from(bytes);
    return stream?._encoding ? buffer.toString(stream._encoding) : buffer;
  };

  const deliverStreamData = (stream, map, chunk) => {
    const hasData = (map.get("data") ?? []).length > 0;
    const hasReadable = (map.get("readable") ?? []).length > 0;
    if (hasData) emitFrom(map, "data", chunk);
    if (hasReadable) {
      stream?._readableBuffer.push(chunk);
      emitFrom(map, "readable");
    } else if (!hasData) {
      // No consumer attached yet; keep the data for a later read().
      stream?._readableBuffer.push(chunk);
    }
  };

  const child = Object.assign(target ?? new ChildProcess(), {
    pid: 0,
    // Convert strings to bytes before crossing into native code: the native
    // string path measures with strlen and would truncate at embedded NULs.
    stdin: stdinMode === "pipe" ? makeStream(stdinListeners, 0, (chunk) => {
      // A synchronous write can fill the pipe before the normal release
      // microtask runs, so let the gated child start reading first.
      releaseStart();
      return cottontail.spawnWrite(native.id, Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk) ? chunk : Buffer.from(String(chunk)));
    }) : null,
    stdout: stdoutMode === "pipe" ? makeStream(stdoutListeners, 1) : null,
    stderr: stderrMode === "pipe" ? makeStream(stderrListeners, 2) : null,
    _nativeId: -1,
    _ipcFd: null,
    kill(signal = "SIGTERM") {
      const signalNumber = normalizeKillSignal(signal);
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

  // Node exposes stdio as an enumerable own property (libraries such as
  // tinyspawn rely on Object.assign copying stdin/stdout/stderr/stdio).
  child.stdio = [child.stdin, child.stdout, child.stderr];

  if (preflightError == null) {
    try {
      native = cottontail.spawnStart(command.file, command.args, {
        cwd: normalizeCwdOption(options.cwd),
        env: nativeOptions.env,
        clearEnv: nativeOptions.clearEnv,
        stdin: stdinMode,
        stdout: stdoutMode,
        stderr: stderrMode,
        ipc: ipcRequested,
        argv0: options.argv0 != null ? String(options.argv0) : undefined,
        deferStart,
      });
      child.pid = native.pid ?? 0;
      child._nativeId = native.id;
      child._ipcFd = native.ipcFd == null ? null : Number(native.ipcFd);
    } catch (error) {
      preflightError = normalizeSpawnError(file, args, error);
    }
  }

  if (options.timeout != null && Number(options.timeout) > 0) {
    child._timeoutTimer = setTimeout(() => {
      child.kill(options.killSignal ?? "SIGTERM");
    }, Number(options.timeout));
  }

  let abortHandler = null;
  if (options.signal) {
    abortHandler = () => {
      const error = makeAbortError(options.signal?.reason);
      child.kill(options.killSignal ?? "SIGTERM");
      child.emit("error", error);
    };
    if (options.signal.aborted) queueMicrotask(abortHandler);
    else options.signal.addEventListener?.("abort", abortHandler, { once: true });
  }

  const emitChild = (name, ...values) => child.emit(name, ...values);

  if (preflightError == null) unregisterSpawnListener = globalThis.__cottontailRegisterSpawnListener?.(native.id, (event) => {
    if (!event) return;
    if (event.type === "stdout") {
      const bytes = new Uint8Array(event.data ?? new ArrayBuffer(0));
      if (bytes.length > 0) deliverStreamData(child.stdout, stdoutListeners, streamChunk(child.stdout, bytes));
      return;
    }
    if (event.type === "stderr") {
      const bytes = new Uint8Array(event.data ?? new ArrayBuffer(0));
      if (bytes.length > 0) deliverStreamData(child.stderr, stderrListeners, streamChunk(child.stderr, bytes));
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
      // Node reports code null + signal name when the child died from a signal.
      const exitCode = event.exitCode == null ? (event.signalCode == null ? 0 : null) : Number(event.exitCode);
      const signalCode = signalNumberToName(event.signalCode);
      child.exitCode = exitCode;
      child.signalCode = signalCode;
      if (Array.isArray(child._pendingIpcEvents)) {
        for (const pendingEvent of child._pendingIpcEvents) {
          if (Number.isInteger(pendingEvent?.fd) && pendingEvent.fd >= 0) cottontail.closeFd?.(pendingEvent.fd);
        }
        child._pendingIpcEvents = [];
      }
      // Defer terminal events by one macrotask: the exit event can be
      // dispatched in the same pump as the JS continuation that attaches
      // 'exit'/'close' listeners right after spawn()/kill(), and emitting
      // synchronously here would fire before those listeners exist. The
      // (ref'd) timer also keeps the event loop alive now that the spawn
      // listener has been unregistered.
      setTimeout(() => {
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
        // The IPC channel dies with the child; Node marks it closed before
        // 'exit' listeners run, then emits 'disconnect'.
        const wasConnected = child.connected === true;
        child.connected = false;
        child._ipcOnExit?.();
        emitChild("exit", exitCode, signalCode);
        if (wasConnected) emitChild("disconnect");
        emitChild("close", exitCode, signalCode);
        cottontail.spawnDispose?.(native.id);
      }, 0);
    }
  });

  if (ipcRequested && Number.isInteger(child._ipcFd) && child._ipcFd >= 0) {
    installParentIpcChannel(child, options.serialization);
  }

  if (preflightError) {
    // Failed exec: 'error' fires asynchronously instead of 'spawn'.
    queueMicrotask(() => emitChild("error", preflightError));
    return child;
  }

  // The gate only protects native events until their listener is installed.
  // Release it before returning so a subsequent synchronous spawn cannot
  // inherit this child's still-open gate writer and keep the child blocked.
  releaseStart();

  // Node emits 'spawn' asynchronously once the process started successfully.
  queueMicrotask(() => {
    if (!closed) emitChild("spawn");
  });

  return child;
}

export function spawn(file, args = [], options = {}) {
  if (typeof file !== "string") throw invalidFileArgError(file);
  const normalized = normalizeSpawnArgs(args, options);
  const stdio = normalized.options.stdio == null
    ? undefined
    : typeof normalized.options.stdio === "string"
      ? [normalized.options.stdio, normalized.options.stdio, normalized.options.stdio]
      : normalized.options.stdio;
  const child = new ChildProcess();
  child.spawn({
    ...normalized.options,
    file,
    args: [normalized.options.argv0 != null ? String(normalized.options.argv0) : file, ...normalized.args],
    stdio,
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
  const handleChunk = (streamName, chunk) => {
    let next = (streamName === "stdout" ? stdout : stderr) + chunk.toString();
    let exceeded = false;
    if (maxBuffer >= 0 && Buffer.byteLength(next) > maxBuffer) {
      // Node truncates the collected output to exactly maxBuffer bytes.
      next = Buffer.from(next).subarray(0, maxBuffer).toString();
      exceeded = true;
    }
    if (streamName === "stdout") stdout = next;
    else stderr = next;
    if (exceeded) {
      const error = new RangeError(`${streamName} maxBuffer length exceeded`);
      error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      error.cmd = commandText;
      child.kill(options.killSignal ?? "SIGTERM");
      fail(error);
    }
  };
  child.stdout?.on("data", (chunk) => handleChunk("stdout", chunk));
  child.stderr?.on("data", (chunk) => handleChunk("stderr", chunk));
  child.on("error", fail);
  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    const stdoutValue = options.encoding === "buffer" || options.encoding === null ? Buffer.from(stdout) : stdout;
    const stderrValue = options.encoding === "buffer" || options.encoding === null ? Buffer.from(stderr) : stderr;
    if (code === 0 && signal == null) {
      callback?.(null, stdoutValue, stderrValue);
      return;
    }
    const error = new Error(`Command failed: ${commandText}`);
    error.code = code;
    error.signal = signal;
    error.killed = child.killed === true;
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
  const isWin = cottontail.platform() === "win32";
  const shell = typeof options.shell === "string" && options.shell !== "" ? options.shell : (isWin ? "cmd" : "sh");
  const args = isWin ? ["/d", "/s", "/c", String(command)] : ["-c", String(command)];
  const child = spawn(shell, args, {
    ...options,
    shell: false, // already wrapped in a shell here; don't re-wrap in spawn()
    stdio: ["ignore", "pipe", "pipe"],
  });
  return collectChild(child, options, callback, String(command));
}

// util.promisify(exec/execFile) resolves with { stdout, stderr } (Node behavior).
const kChildProcessPromisify = Symbol.for("nodejs.util.promisify.custom");
exec[kChildProcessPromisify] = (command, options = undefined) => new Promise((resolvePromise, reject) => {
  exec(command, options ?? {}, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    } else {
      resolvePromise({ stdout, stderr });
    }
  });
});
execFile[kChildProcessPromisify] = (file, args = undefined, options = undefined) => new Promise((resolvePromise, reject) => {
  execFile(file, args ?? [], options ?? {}, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    } else {
      resolvePromise({ stdout, stderr });
    }
  });
});

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

function validateIpcMessage(message, argumentCount) {
  if (argumentCount === 0 || message === undefined) {
    const error = new TypeError('The "message" argument must be specified');
    error.code = "ERR_MISSING_ARGS";
    throw error;
  }
  const type = typeof message;
  if (message === null || type === "string" || type === "object" || type === "number" || type === "boolean") return;
  const error = new TypeError(
    'The "message" argument must be one of type string, object, number, or boolean. ' +
      `Received ${receivedValueText(message)}`,
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  throw error;
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
  // Handle without an underlying descriptor yet (e.g. a net.Server that never
  // listened): Node still delivers the message; we just cannot pass the handle.
  return null;
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

function encodeNativeIpcPayload(message, mode, handleInfo, handleSeq = undefined) {
  const payload = handleInfo == null
    ? message
    : { [ipcEnvelopeKey]: 1, message, handleType: handleInfo.type, handleSeq };
  return `${ipcPrefix}${encodeIpcMessage(payload, mode)}\n`;
}

// Sockets adopted from a passed fd, keyed by the sender's handle sequence so a
// follow-up frame can replay bytes the sender's fd watcher had already consumed.
const adoptedIpcHandles = new Map();

function rememberAdoptedIpcHandle(handleSeq, handle) {
  if (handleSeq == null || handle == null) return;
  adoptedIpcHandles.set(handleSeq, handle);
  if (adoptedIpcHandles.size > 32) {
    const oldest = adoptedIpcHandles.keys().next().value;
    adoptedIpcHandles.delete(oldest);
  }
}

function deliverAdoptedHandleData(handleSeq, base64Data) {
  const socket = adoptedIpcHandles.get(handleSeq);
  adoptedIpcHandles.delete(handleSeq);
  if (socket == null || !base64Data) return;
  const bytes = Buffer.from(String(base64Data), "base64");
  if (bytes.length === 0) return;
  queueMicrotask(() => {
    try {
      const chunk = socket._encoding ? bytes.toString(socket._encoding) : bytes;
      if (typeof socket._emitData === "function") socket._emitData(chunk);
      else socket.emit?.("data", chunk);
    } catch {}
  });
}

// Returns null for internal frames that must not surface as 'message' events.
function decodeNativeIpcPayload(payload, receivedFd = undefined) {
  const decoded = decodeIpcMessage(payload);
  if (decoded && typeof decoded === "object" && decoded[ipcEnvelopeKey] === 1) {
    const handle = receivedIpcHandle(receivedFd, decoded.handleType);
    rememberAdoptedIpcHandle(decoded.handleSeq, handle);
    return { message: decoded.message, handle };
  }
  if (decoded && typeof decoded === "object" && decoded[ipcEnvelopeKey] === 3) {
    if (Number.isInteger(receivedFd) && receivedFd >= 0) cottontail.closeFd?.(receivedFd);
    deliverAdoptedHandleData(decoded.handleSeq, decoded.data);
    return null;
  }
  return {
    message: decoded,
    handle: receivedIpcHandle(receivedFd),
  };
}

let ipcHandleSeqCounter = 0;

// `finish` (when provided) is always invoked asynchronously: on the next
// microtask for plain messages, or after the handle-data flush for handle
// sends, so a callback that destroys the passed socket cannot drop bytes the
// parent's fd watcher had already consumed.
function writeNativeIpc(fd, message, mode, sendHandle = undefined, finish = undefined) {
  const handleInfo = ipcHandleInfo(sendHandle);
  let handleSeq;
  if (handleInfo != null) {
    handleSeq = ++ipcHandleSeqCounter;
    // Pause the socket being handed over: bytes its fd watcher already grabbed
    // then land in _pendingData (instead of being dropped by an unlistened
    // 'data' emit) and can be forwarded to the receiver below.
    try { sendHandle?.pause?.(); } catch {}
  }
  const ok = cottontail.ipcSend?.(Number(fd), encodeNativeIpcPayload(message, mode, handleInfo, handleSeq), handleInfo?.fd ?? -1) === true;
  if (handleInfo != null && ok) {
    setTimeout(() => {
      try {
        const pending = Array.isArray(sendHandle?._pendingData) ? sendHandle._pendingData.splice(0) : [];
        try { sendHandle?._stopRead?.(); } catch {}
        if (pending.length > 0) {
          const data = Buffer.concat(pending.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("base64");
          const payload = { [ipcEnvelopeKey]: 3, handleSeq, data };
          cottontail.ipcSend?.(Number(fd), `${ipcPrefix}J:${JSON.stringify(payload)}\n`, -1);
        }
      } catch {}
      finish?.();
    }, 5);
  } else if (finish != null) {
    queueMicrotask(finish);
  }
  return ok;
}

function installNativeIpcReader(fd, onFrame, onDisconnect, onError, closeFd = true) {
  if (!Number.isInteger(fd) || fd < 0 || typeof cottontail.ipcRecv !== "function") return null;
  let buffer = "";
  let closed = false;
  let timer = null;
  const poll = () => {
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
          if (frame != null) onFrame(frame.message, frame.handle);
        }
        if (Number.isInteger(pendingFd) && pendingFd >= 0) cottontail.closeFd?.(pendingFd);
      }
    } catch (error) {
      onError?.(error);
    }
  };
  const control = {
    // Node keeps the process alive only while the channel is ref'd; we model
    // ref/unref by starting/stopping the poll interval (no native timer unref).
    ref() {
      if (closed || timer != null) return;
      timer = setInterval(poll, 1);
    },
    unref() {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      control.unref();
      if (closeFd) {
        try { cottontail.closeFd?.(fd); } catch {}
      }
    },
  };
  control.ref();
  return control;
}

function makeChannelClosedError() {
  const error = new Error("Channel closed");
  error.code = "ERR_IPC_CHANNEL_CLOSED";
  return error;
}

function emitChildProcessError(child, error) {
  // Node emits 'error' asynchronously; without a listener the EventEmitter
  // throws, surfacing as an uncaughtException.
  queueMicrotask(() => {
    if (child.emit?.("error", error) === true) return;
    const handled = globalThis.process?.emit?.("uncaughtException", error) === true;
    if (!handled) throw error;
  });
}

function installParentIpcChannel(child, serialization = undefined) {
  child.connected = true;
  child.serialization = serialization === "advanced" ? "advanced" : "json";
  const channel = {
    ref() {
      child.ref();
      return channel;
    },
    unref() {
      child.unref();
      return channel;
    },
  };
  child.channel = channel;
  child._channel = channel;
  child._ipcBuffer = "";
  let nativeIpcPendingFd = undefined;

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
        if (frame != null) emitChildMessage(child, frame.message, "message", frame.handle);
      }
    } catch (error) {
      emitChildProcessError(child, error);
    }
  };

  const pendingEvents = Array.isArray(child._pendingIpcEvents) ? child._pendingIpcEvents : [];
  child._pendingIpcEvents = [];
  for (const event of pendingEvents) child._handleIpcEvent(event);

  child._ipcOnExit = () => {
    child._handleIpcEvent = null;
    child.channel = null;
    child._channel = null;
    if (Number.isInteger(nativeIpcPendingFd) && nativeIpcPendingFd >= 0) {
      cottontail.closeFd?.(nativeIpcPendingFd);
      nativeIpcPendingFd = undefined;
    }
  };

  child.send = function send(message, sendHandleOrCallback = undefined, optionsOrCallback = undefined, callback = undefined) {
    validateIpcMessage(message, arguments.length);
    const normalizedSend = normalizeSendArgs(sendHandleOrCallback, optionsOrCallback, callback);
    const sendCallback = typeof normalizedSend.callback === "function" ? normalizedSend.callback : null;
    if (!child.connected) {
      const error = makeChannelClosedError();
      if (sendCallback) queueMicrotask(() => sendCallback(error));
      else emitChildProcessError(child, error);
      return false;
    }
    let ok = false;
    try {
      ok = writeNativeIpc(child._ipcFd, message, child.serialization, normalizedSend.sendHandle,
        sendCallback ? () => sendCallback(ok ? null : new Error("write failed")) : undefined);
    } catch (error) {
      if (sendCallback) queueMicrotask(() => sendCallback(error));
      else emitChildProcessError(child, error);
      return false;
    }
    return ok;
  };

  child.disconnect = () => {
    if (!child.connected) return;
    child.connected = false;
    cottontail.spawnCloseIpc?.(child._nativeId);
    child.channel = null;
    child._channel = null;
    emitChildMessage(child, undefined, "disconnect");
  };
}

export function fork(modulePath, args = [], options = {}) {
  if (typeof modulePath !== "string" && !Buffer.isBuffer(modulePath) &&
      !(typeof URL === "function" && modulePath instanceof URL)) {
    const error = new TypeError(`The "modulePath" argument must be of type string, Buffer, or URL. Received ${receivedValueText(modulePath)}`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (args == null) {
    args = [];
  } else if (!Array.isArray(args)) {
    if (typeof args !== "object") throw invalidArgTypeError("args", "Array", args);
    options = args;
    args = [];
  }
  if (options == null) options = {};
  if (typeof options !== "object") {
    throw invalidArgTypeError("options", "object", options);
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

  if (typeof child.send === "function" && Number.isInteger(child._ipcFd) && child._ipcFd >= 0) {
    // spawn() already installed the native IPC channel; just forward child stdout.
    child.stdout?.on("data", (chunk) => {
      if (!options.silent) process.stdout.write(String(chunk));
    });
    return child;
  }

  // Fallback: no native IPC channel; multiplex IPC frames over stdio.
  child.connected = true;
  child.serialization = options.serialization === "advanced" ? "advanced" : "json";
  const channel = {
    ref() {
      child.ref();
      return channel;
    },
    unref() {
      child.unref();
      return channel;
    },
  };
  child.channel = channel;
  child._channel = channel;
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
          emitChildMessage(child, decodeIpcMessage(line.slice(ipcPrefix.length)));
        } catch (error) {
          emitChildProcessError(child, error);
        }
      } else if (!options.silent) {
        process.stdout.write(`${line}\n`);
      }
    }
  });

  child.send = function send(message, sendHandleOrCallback = undefined, optionsOrCallback = undefined, callback = undefined) {
    validateIpcMessage(message, arguments.length);
    const normalizedSend = normalizeSendArgs(sendHandleOrCallback, optionsOrCallback, callback);
    const sendCallback = typeof normalizedSend.callback === "function" ? normalizedSend.callback : null;
    if (!child.connected || !child.stdin) {
      const error = makeChannelClosedError();
      if (sendCallback) queueMicrotask(() => sendCallback(error));
      else emitChildProcessError(child, error);
      return false;
    }
    let ok = false;
    try {
      if (normalizedSend.sendHandle != null) throw new Error("IPC handle passing is only available on native IPC channels");
      ok = child.stdin.write(`${ipcPrefix}${encodeIpcMessage(message, child.serialization)}\n`);
    } catch (error) {
      // Node invokes the callback asynchronously with the error instead of emitting 'error'.
      if (sendCallback) queueMicrotask(() => sendCallback(error));
      else emitChildProcessError(child, error);
      return false;
    }
    if (sendCallback) queueMicrotask(() => sendCallback(ok ? null : new Error("write failed")));
    return ok;
  };
  child.disconnect = () => {
    if (!child.connected) return;
    child.connected = false;
    child.stdin?.end();
    child.channel = null;
    child._channel = null;
    emitChildMessage(child, undefined, "disconnect");
  };

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

  processObject.send = function send(message, sendHandleOrCallback = undefined, optionsOrCallback = undefined, callback = undefined) {
    validateIpcMessage(message, arguments.length);
    const normalizedSend = normalizeSendArgs(sendHandleOrCallback, optionsOrCallback, callback);
    const sendCallback = typeof normalizedSend.callback === "function" ? normalizedSend.callback : null;
    if (!processObject.connected) {
      const error = new Error("Channel closed");
      error.code = "ERR_IPC_CHANNEL_CLOSED";
      if (sendCallback) queueMicrotask(() => sendCallback(error));
      else processObject.emit?.("error", error);
      return false;
    }
    let ok = false;
    try {
      if (hasNativeIpc) {
        ok = writeNativeIpc(nativeFd, message, serializationMode, normalizedSend.sendHandle,
          sendCallback ? () => sendCallback(ok ? null : new Error("write failed")) : undefined);
        return ok;
      }
      if (normalizedSend.sendHandle != null) throw new Error("IPC handle passing is only available on native IPC channels");
      ok = processObject.stdout?.write?.(`${ipcPrefix}${encodeIpcMessage(message, serializationMode)}\n`) === true;
    } catch (error) {
      // Node invokes the callback asynchronously with the error instead of emitting 'error'.
      if (sendCallback) queueMicrotask(() => sendCallback(error));
      else processObject.emit?.("error", error);
      return false;
    }
    if (sendCallback) queueMicrotask(() => sendCallback(ok ? null : new Error("write failed")));
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
    const reader = installNativeIpcReader(
      nativeFd,
      (message, handle) => processObject.emit?.("message", message, handle),
      () => {
        if (processObject.connected) processObject.disconnect();
      },
      (error) => processObject.emit?.("error", error),
    );
    stopNativeIpc = reader == null ? null : () => reader.close();
    if (reader != null) {
      // Match Node: the IPC channel only keeps the child alive while there are
      // 'message'/'disconnect' listeners on process. The runtime's EventEmitter
      // never emits 'newListener', so wrap the registration methods instead.
      // node/process.js replaces process.on/off/... during module init (which can
      // run after this bootstrap), so defer the wrapping to a microtask: it runs
      // after all synchronous module init and the script's top-level code. Until
      // then the reader stays ref'd, so startup messages are never dropped.
      const channelEventNames = new Set(["message", "disconnect"]);
      const updateChannelRef = () => {
        const count = (processObject.listenerCount?.("message") ?? 0) +
          (processObject.listenerCount?.("disconnect") ?? 0);
        if (count > 0) reader.ref();
        else reader.unref();
      };
      queueMicrotask(() => {
        try {
          for (const methodName of ["on", "addListener", "once", "prependListener", "prependOnceListener"]) {
            const original = processObject[methodName];
            if (typeof original !== "function") continue;
            processObject[methodName] = function (name, ...rest) {
              const result = original.call(this, name, ...rest);
              if (channelEventNames.has(name)) reader.ref();
              return result;
            };
          }
          for (const methodName of ["off", "removeListener", "removeAllListeners"]) {
            const original = processObject[methodName];
            if (typeof original !== "function") continue;
            processObject[methodName] = function (name, ...rest) {
              const result = original.call(this, name, ...rest);
              if (name === undefined || channelEventNames.has(name)) updateChannelRef();
              return result;
            };
          }
        } catch {}
        updateChannelRef();
      });
    }
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

// COTTONTAIL-COMPAT: forked children are marked with COTTONTAIL_IPC_BOOTSTRAP=node but no
// startup hook calls _forkChild yet, so bootstrap process.send/disconnect when this module
// loads in such a child. Children that never require node:child_process still miss out;
// the process bootstrap (bun/ffi.js or node/process.js) should eventually call _forkChild.
if (globalThis.process?.env?.COTTONTAIL_IPC_BOOTSTRAP === "node" && typeof globalThis.process?.send !== "function") {
  try { _forkChild(); } catch {}
}

export default { ChildProcess, _forkChild, exec, execFile, execFileSync, execSync, fork, spawn, spawnSync };
