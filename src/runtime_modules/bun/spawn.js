import {
  bunSignalName,
  bunSignalNumber,
} from "../internal/bun-spawn-contract.js";
import {
  adoptBunSpawnIpcHandle,
  bunSpawnIpcHandleInfo,
  decodeBunSpawnIpc,
  encodeBunSpawnIpc,
  isCottontailIpcFrame,
} from "../internal/bun-spawn-ipc.js";

const Promise = globalThis.Promise;
const queueMicrotask = globalThis.queueMicrotask.bind(globalThis);

function normalizeResourceUsage(usage) {
  if (usage == null) return undefined;
  if (usage.cpuTime?.user != null && usage.cpuTime?.system != null) return usage;
  const user = BigInt(Math.max(0, Math.trunc(Number(usage.userCPUTime) || 0)));
  const system = BigInt(Math.max(0, Math.trunc(Number(usage.systemCPUTime) || 0)));
  return {
    maxRSS: Number(usage.maxRSS) || 0,
    shmSize: Number(usage.sharedMemorySize) || 0,
    swapCount: Number(usage.swappedOut) || 0,
    messages: {
      sent: Number(usage.ipcSent) || 0,
      received: Number(usage.ipcReceived) || 0,
    },
    signalCount: Number(usage.signalsCount) || 0,
    contextSwitches: {
      voluntary: Number(usage.voluntaryContextSwitches) || 0,
      involuntary: Number(usage.involuntaryContextSwitches) || 0,
    },
    cpuTime: { user, system, total: user + system },
    ops: {
      in: Number(usage.fsRead) || 0,
      out: Number(usage.fsWrite) || 0,
    },
  };
}

function normalizeSpawnError(error, file, cwd = undefined) {
  const source = String(error?.message ?? error ?? "");
  if (!source.includes("FileNotFound") && !source.includes("ENOENT") &&
      !source.includes("No such file or directory")) {
    return error;
  }
  const out = new Error(cwd != null
    ? `ENOENT: no such file or directory, posix_spawn '${file}'`
    : `Executable not found in $PATH: ${JSON.stringify(String(file))}`);
  out.code = "ENOENT";
  out.errno = -2;
  out.path = String(file);
  if (cwd != null) out.syscall = "posix_spawn";
  return out;
}

class ProcessReadable {
  constructor(concatChunks, cancel = undefined) {
    this._concatChunks = concatChunks;
    this._cancel = cancel;
    this._listeners = new Map();
    this._chunks = [];
    this._readRequests = [];
    this._ended = false;
    this._locked = false;
    this._emptyReadClaimed = false;
  }

  get locked() { return this._locked; }
  get readable() { return !this._ended; }

  on(name, handler) {
    if (typeof handler !== "function") return this;
    const key = String(name);
    const handlers = this._listeners.get(key) ?? [];
    handlers.push(handler);
    this._listeners.set(key, handlers);
    return this;
  }

  addListener(name, handler) { return this.on(name, handler); }

  once(name, handler) {
    const wrapped = (...args) => {
      this.off(name, wrapped);
      handler(...args);
    };
    wrapped.listener = handler;
    return this.on(name, wrapped);
  }

  off(name, handler) {
    const key = String(name);
    const handlers = this._listeners.get(key) ?? [];
    this._listeners.set(key, handlers.filter(item => item !== handler && item.listener !== handler));
    return this;
  }

  removeListener(name, handler) { return this.off(name, handler); }

  removeAllListeners(name = undefined) {
    if (name === undefined) this._listeners.clear();
    else this._listeners.delete(String(name));
    return this;
  }

  listenerCount(name) { return (this._listeners.get(String(name)) ?? []).length; }

  emit(name, ...args) {
    for (const handler of [...(this._listeners.get(String(name)) ?? [])]) handler(...args);
    return this.listenerCount(name) > 0;
  }

  _push(chunk) {
    if (this._ended) return;
    if (this._readRequests.length > 0) {
      const resolve = this._readRequests.shift();
      resolve({ done: false, value: chunk });
    } else if (this.listenerCount("data") === 0) {
      // A flowing consumer owns the chunk. Retaining another copy here made
      // long-lived subprocess streams grow with every data event.
      this._chunks.push(chunk);
    }
    this.emit("data", chunk);
  }

  _finish() {
    if (this._ended) return;
    this._ended = true;
    while (this._readRequests.length > 0) {
      this._readRequests.shift()({ done: true, value: undefined });
    }
    this.emit("end");
    this.emit("close");
  }

  async arrayBuffer() {
    const bytes = await this.bytes();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  async bytes() {
    if (this._locked && this._ended && this._chunks.length === 0 && !this._emptyReadClaimed) {
      this._emptyReadClaimed = true;
      return new Uint8Array(0);
    }
    const reader = this.getReader();
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      if (chunks.length === 0 && this._ended) this._emptyReadClaimed = true;
      else reader.releaseLock();
    }
    return this._concatChunks(chunks);
  }

  async blob() { return new Blob([await this.bytes()]); }
  async text() { return new TextDecoder().decode(await this.bytes()); }

  async json() {
    const wasBufferedAtCall = this._ended;
    try {
      return JSON.parse(await this.text());
    } catch (error) {
      if (!wasBufferedAtCall) throw error;
      throw new SyntaxError("Failed to parse JSON");
    }
  }

  getReader() {
    if (this._locked) throw new TypeError("ReadableStream is locked");
    this._locked = true;
    let cancelled = false;
    let released = false;
    const owner = this;
    return {
      read() {
        if (cancelled || released) return Promise.resolve({ done: true, value: undefined });
        if (owner._chunks.length > 0) {
          return Promise.resolve({ done: false, value: owner._chunks.shift() });
        }
        if (owner._ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise(resolve => owner._readRequests.push(resolve));
      },
      releaseLock() {
        if (released) return;
        released = true;
        owner._locked = false;
      },
      cancel(reason = undefined) {
        cancelled = true;
        owner._locked = false;
        return owner.cancel(reason);
      },
    };
  }

  cancel(reason = undefined) {
    this._chunks.length = 0;
    this._finish();
    try {
      return Promise.resolve(this._cancel?.(reason));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  _asReadableStream() {
    const reader = this.getReader();
    return new globalThis.ReadableStream({
      async pull(controller) {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      },
      cancel(reason) { return reader.cancel(reason); },
    });
  }

  pipeTo(destination, options = undefined) { return this._asReadableStream().pipeTo(destination, options); }
  pipeThrough(transform, options = undefined) { return this._asReadableStream().pipeThrough(transform, options); }
  tee() { return this._asReadableStream().tee(); }

  async *[Symbol.asyncIterator]() {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

class ProcessWritable {
  constructor(host, processId, asBuffer) {
    this._host = host;
    this._processId = processId;
    this._asBuffer = asBuffer;
    this._listeners = new Map();
    this._queue = [];
    this._draining = false;
    this._endRequested = false;
    this._endWaiters = [];
    this._flushWaiters = [];
    this._queuedBytes = 0;
    this._unflushedBytes = 0;
    this._syncBytes = 0;
    this._syncResetTimer = null;
    this.writable = true;
    this.writableEnded = false;
    this.writableFinished = false;
    this.destroyed = false;
  }

  on(name, handler) {
    if (typeof handler !== "function") return this;
    const key = String(name);
    const handlers = this._listeners.get(key) ?? [];
    handlers.push(handler);
    this._listeners.set(key, handlers);
    return this;
  }

  addListener(name, handler) { return this.on(name, handler); }

  once(name, handler) {
    const wrapped = (...args) => {
      this.off(name, wrapped);
      handler(...args);
    };
    wrapped.listener = handler;
    return this.on(name, wrapped);
  }

  off(name, handler) {
    const key = String(name);
    const handlers = this._listeners.get(key) ?? [];
    this._listeners.set(key, handlers.filter(item => item !== handler && item.listener !== handler));
    return this;
  }

  removeListener(name, handler) { return this.off(name, handler); }
  removeAllListeners(name = undefined) {
    if (name === undefined) this._listeners.clear();
    else this._listeners.delete(String(name));
    return this;
  }
  listenerCount(name) { return (this._listeners.get(String(name)) ?? []).length; }
  emit(name, ...args) {
    for (const handler of [...(this._listeners.get(String(name)) ?? [])]) handler(...args);
    return this.listenerCount(name) > 0;
  }

  _scheduleSyncReset() {
    if (this._syncResetTimer != null) return;
    this._syncResetTimer = setTimeout(() => {
      this._syncResetTimer = null;
      this._syncBytes = 0;
    }, 0);
  }

  _closeAfterDrain() {
    if (!this._endRequested || this._draining || this._queue.length > 0 || this.destroyed) return;
    this._host.spawnCloseStdin?.(this._processId);
    this.writableFinished = true;
    this.destroyed = true;
    this.emit("finish");
    this.emit("close");
    for (const { resolve, callback, flushed } of this._endWaiters.splice(0)) {
      resolve(flushed);
      callback?.();
    }
  }

  _settleFlushWaiters() {
    if (this._draining || this._queue.length > 0) return;
    for (const { resolve, flushed } of this._flushWaiters.splice(0)) resolve(flushed);
  }

  _failWrites(error) {
    this._queuedBytes = 0;
    for (const item of this._queue.splice(0)) {
      item.bytes = null;
      item.reject(error);
      item.callback?.(error);
    }
    for (const waiter of this._flushWaiters.splice(0)) waiter.reject(error);
    for (const waiter of this._endWaiters.splice(0)) {
      waiter.reject(error);
      waiter.callback?.(error);
    }
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }

  _startDrain() {
    if (this._draining || this.destroyed) return;
    this._draining = true;
    void (async () => {
      let bytesSinceYield = 0;
      try {
        while (this._queue.length > 0) {
          const item = this._queue[0];
          while (item.offset < item.bytes.byteLength) {
            const end = Math.min(item.offset + 1024 * 1024, item.bytes.byteLength);
            const chunk = item.offset === 0 && end === item.bytes.byteLength
              ? item.bytes
              : item.bytes.subarray(item.offset, end);
            if (this._host.spawnWrite?.(this._processId, chunk) !== true) {
              throw new Error("write failed");
            }
            const count = end - item.offset;
            item.offset = end;
            this._queuedBytes -= count;
            bytesSinceYield += count;
            if (bytesSinceYield >= 1024 * 1024 &&
                (item.offset < item.bytes.byteLength || this._queue.length > 1)) {
              bytesSinceYield = 0;
              await new Promise(resolve => setTimeout(resolve, 0));
            }
          }
          this._queue.shift();
          const written = item.bytes.byteLength;
          item.bytes = null;
          item.resolve(written);
          item.callback?.(null);
        }
      } catch (error) {
        this._failWrites(error);
      } finally {
        this._draining = false;
        this._settleFlushWaiters();
        this._closeAfterDrain();
      }
    })();
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (!this.writable || this.destroyed) {
      const error = new Error("write after end");
      if (typeof callback === "function") callback(error);
      else if (this.listenerCount("error") > 0) this.emit("error", error);
      return false;
    }
    const bytes = typeof chunk === "string" && typeof encoding === "string" && globalThis.Buffer?.from
      ? globalThis.Buffer.from(chunk, encoding)
      : this._asBuffer(chunk);
    if (!this._draining && this._queue.length === 0 && bytes.byteLength <= 16 * 1024 &&
        this._syncBytes + bytes.byteLength <= 64 * 1024) {
      const ok = this._host.spawnWrite?.(this._processId, bytes) === true;
      if (ok) {
        this._syncBytes += bytes.byteLength;
        this._unflushedBytes += bytes.byteLength;
        this._scheduleSyncReset();
      }
      callback?.(ok ? null : new Error("write failed"));
      return ok ? bytes.byteLength : 0;
    }
    const promise = new Promise((resolve, reject) => {
      this._queue.push({ bytes, offset: 0, resolve, reject, callback });
      this._queuedBytes += bytes.byteLength;
    });
    this._startDrain();
    return promise;
  }

  flush() {
    const flushed = this._unflushedBytes + this._queuedBytes;
    this._unflushedBytes = 0;
    if (!this._draining && this._queue.length === 0) return flushed;
    return new Promise((resolve, reject) => this._flushWaiters.push({ resolve, reject, flushed }));
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
    }
    if (chunk != null) this.write(chunk, encoding);
    this.writable = false;
    this.writableEnded = true;
    this._endRequested = true;
    const flushed = this._unflushedBytes + this._queuedBytes;
    this._unflushedBytes = 0;
    if (!this._draining && this._queue.length === 0) {
      this._closeAfterDrain();
      callback?.();
      return flushed;
    }
    return new Promise((resolve, reject) => {
      this._endWaiters.push({ resolve, reject, callback, flushed });
      this._closeAfterDrain();
    });
  }

  _processExited() {
    if (this._syncResetTimer != null) {
      clearTimeout(this._syncResetTimer);
      this._syncResetTimer = null;
    }
    if (this._queue.length > 0 || this._flushWaiters.length > 0 || this._endWaiters.length > 0) {
      this._failWrites(new Error("Subprocess exited"));
    }
    this.writable = false;
    this.writableEnded = true;
    this.writableFinished = true;
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
  }

  destroy(error = undefined) {
    if (this.destroyed) return this;
    this._endRequested = false;
    if (this._syncResetTimer != null) clearTimeout(this._syncResetTimer);
    if (this._queue.length > 0 || this._flushWaiters.length > 0 || this._endWaiters.length > 0) {
      this._failWrites(error ?? new Error("Subprocess stdin destroyed"));
    }
    this._host.spawnCloseStdin?.(this._processId);
    this.writable = false;
    this.writableEnded = true;
    this.destroyed = true;
    if (error != null) this.emit("error", error);
    this.emit("close");
    return this;
  }

  ref() { return this; }
  unref() { return this; }
}

export function createBunSpawnRuntime(deps) {
  const {
    abortSignalState,
    asBuffer,
    bytesFromBody,
    concatChunks,
    isCurrentExecutable,
    normalizeCommand,
    normalizeOptions,
    prepareNativeOptions,
    resolvePath,
    terminalProcessExited,
    terminalSpawnFd,
    validateInput,
    writeOutputBuffer,
  } = deps;
  const host = globalThis.cottontail;
  const extraFdFinalizer = typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry(fds => {
        for (const fd of fds) {
          try { host.closeFd?.(fd); } catch {}
        }
      })
    : null;

  function augmentErrorSource(stderr, cwd = undefined) {
    const text = String(stderr ?? "");
    const framePattern = /^([^\n@]+\.(?:[cm]?[jt]sx?))@[^\n]+:\d+:\d+$/gm;
    const seen = new Set();
    const excerpts = [];
    let match;
    while ((match = framePattern.exec(text)) !== null) {
      const path = resolvePath(String(cwd || host.cwd()), match[1]);
      if (seen.has(path)) continue;
      seen.add(path);
      try {
        const source = host.readFile(path);
        if (source && !text.includes(source)) excerpts.push(source.slice(0, 8192));
      } catch {}
    }
    return excerpts.length > 0 ? asBuffer(`${text}\n${excerpts.join("\n")}\n`) : stderr;
  }

  function formatTestStderr(stderr) {
    const text = String(stderr ?? "");
    if (text.includes("error: ")) return stderr;
    const exception = /^(?:Error|TypeError|ReferenceError|AssertionError): ([^\n]+)/.exec(text);
    const report = /\(fail\)[^\n]*\n\s*(?:\^\s*)?([^\n]+)/.exec(text);
    const message = exception?.[1] ?? report?.[1];
    return message ? asBuffer(`error: ${message}\n${text}`) : stderr;
  }

  function spawnSync(command, maybeArgsOrOptions = {}, maybeOptions = undefined) {
    const [file, args, options] = normalizeCommand(command, maybeArgsOrOptions, maybeOptions);
    validateInput(file, args, options);
    const nativeOptions = prepareNativeOptions(
      file,
      normalizeOptions(options, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }, true),
      args,
    );
    const signalState = abortSignalState.get(nativeOptions.signal);
    if (!nativeOptions.signal?.aborted && signalState?.timeoutDeadline != null) {
      const signalTimeout = Math.max(1, Math.ceil(signalState.timeoutDeadline - Date.now()));
      if (nativeOptions.timeout == null || signalTimeout < nativeOptions.timeout) nativeOptions.timeout = signalTimeout;
    }
    let result;
    try {
      result = host.spawnSync(file, args, {
        cwd: nativeOptions.cwd,
        env: nativeOptions.env,
        clearEnv: nativeOptions.clearEnv,
        stdout: nativeOptions.stdoutFd ?? nativeOptions.stdout,
        stderr: nativeOptions.stderrFd ?? nativeOptions.stderr,
        stdin: nativeOptions.stdinFd ?? nativeOptions.stdin,
        input: nativeOptions.input,
        signal: nativeOptions.signal,
        timeout: nativeOptions.timeout,
        maxBuffer: nativeOptions.maxBuffer,
        killSignal: nativeOptions.killSignal,
        argv0: nativeOptions.argv0,
        windowsHide: nativeOptions.windowsHide,
        windowsVerbatimArguments: nativeOptions.windowsVerbatimArguments,
      });
    } catch (error) {
      throw normalizeSpawnError(error, file, nativeOptions.cwd);
    }
    const rawSignalCode = Number(result.signalCode ?? result.signal ?? 0);
    const exitCode = rawSignalCode > 0 ? null : Number(result.status ?? result.exitCode ?? 0);
    const rawStdout = asBuffer(result.stdout ?? "");
    let rawStderr = asBuffer(result.stderr ?? "");
    if (nativeOptions.stdoutFilePath != null) {
      try { host.writeFile(nativeOptions.stdoutFilePath, rawStdout); } catch {}
    }
    if (nativeOptions.stderrFilePath != null) {
      try { host.writeFile(nativeOptions.stderrFilePath, rawStderr); } catch {}
    }
    if (nativeOptions.stdoutBuffer != null) writeOutputBuffer(nativeOptions.stdoutBuffer, rawStdout);
    if (nativeOptions.stderrBuffer != null) writeOutputBuffer(nativeOptions.stderrBuffer, rawStderr);
    if (exitCode !== 0 && isCurrentExecutable(file) && rawStderr.byteLength > 0) {
      rawStderr = augmentErrorSource(rawStderr, nativeOptions.cwd);
    }
    if (exitCode !== 0 && isCurrentExecutable(file) && args[0] === "test") rawStderr = formatTestStderr(rawStderr);
    const resultSignal = result.signalCode ?? result.signal;
    const response = {
      exitCode,
      stdout: nativeOptions.stdoutFd != null && nativeOptions.stdoutFd !== 1
        ? nativeOptions.stdoutFd
        : nativeOptions.stdout === "pipe" && nativeOptions.stdoutFilePath == null && nativeOptions.stdoutBuffer == null
          ? rawStdout
          : undefined,
      stderr: nativeOptions.stderrFd != null && nativeOptions.stderrFd !== 2
        ? nativeOptions.stderrFd
        : nativeOptions.stderr === "pipe" && nativeOptions.stderrFilePath == null && nativeOptions.stderrBuffer == null
          ? rawStderr
          : undefined,
      success: exitCode === 0,
      resourceUsage: normalizeResourceUsage(result.resourceUsage),
      pid: result.pid,
    };
    if (resultSignal != null) response.signalCode = bunSignalName(resultSignal) ?? String(resultSignal);
    if (nativeOptions.timeout != null) response.exitedDueToTimeout = result.exitedDueToTimeout === true;
    if (nativeOptions.maxBuffer != null) response.exitedDueToMaxBuffer = result.exitedDueToMaxBuffer === true;
    return response;
  }

  function prepareReadableInput(input) {
    if (input == null || typeof input !== "object" || typeof input.getReader !== "function") return null;
    if (input.locked || input._disturbed === true) throw new TypeError("'stdin' ReadableStream has already been used");
    const reader = input.getReader();
    let finished = false;
    let cancelled = false;
    return {
      get finished() { return finished; },
      async pump(write) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              finished = true;
              return null;
            }
            const bytes = asBuffer(value);
            for (let offset = 0; offset < bytes.byteLength; offset += 16 * 1024) {
              if (write(bytes.subarray(offset, Math.min(offset + 16 * 1024, bytes.byteLength))) !== true) {
                await this.cancel(new Error("Subprocess stdin closed"));
                return null;
              }
              if (offset + 16 * 1024 < bytes.byteLength) await new Promise(resolve => setTimeout(resolve, 0));
            }
          }
        } catch (error) {
          finished = true;
          return error;
        }
      },
      async cancel(reason = undefined) {
        if (finished || cancelled) return;
        cancelled = true;
        finished = true;
        try { await reader.cancel(reason); } catch {}
      },
    };
  }

  function spawn(command, maybeArgsOrOptions = {}, maybeOptions = undefined) {
    const [file, args, options] = normalizeCommand(command, maybeArgsOrOptions, maybeOptions);
    validateInput(file, args, options);
    const deferStart = isCurrentExecutable(file);
    const nativeOptions = prepareNativeOptions(
      file,
      normalizeOptions(options, { stdin: "ignore", stdout: "pipe", stderr: "inherit" }, false),
      args,
    );
    const readableInput = prepareReadableInput(nativeOptions.input);
    const listeners = new Map();
    let killed = false;
    let killRequested = false;
    let processExited = false;
    let nativeClosed = false;
    let exitCode = null;
    let signalCode = null;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let unregisterSpawnListener = null;
    let timeoutTimer = null;
    let exceededMaxBuffer = false;
    let ipcBuffer = "";
    const ipcDecoder = new TextDecoder();
    let ipcPendingFd = undefined;
    let resourceUsage = undefined;
    let abortHandler = null;
    let disconnected = false;
    let disconnectNotified = false;
    let extraFds = [];
    const terminal = nativeOptions.terminal;

    const child = {
      pid: 0,
      stdin: terminal ? null : nativeOptions.stdinFd != null && nativeOptions.stdinFd !== 0
        ? nativeOptions.stdinFd
        : undefined,
      stdout: terminal ? null : nativeOptions.stdoutFd != null && nativeOptions.stdoutFd !== 1
        ? nativeOptions.stdoutFd
        : nativeOptions.stdout === "pipe" && nativeOptions.stdoutFilePath == null && nativeOptions.stdoutBuffer == null
          ? new ProcessReadable(concatChunks, () => host.spawnCloseOutput?.(child._id, 1))
          : undefined,
      stderr: terminal ? null : nativeOptions.stderrFd != null && nativeOptions.stderrFd !== 2
        ? nativeOptions.stderrFd
        : nativeOptions.stderr === "pipe" && nativeOptions.stderrFilePath == null && nativeOptions.stderrBuffer == null
          ? new ProcessReadable(concatChunks, () => host.spawnCloseOutput?.(child._id, 2))
          : undefined,
      get readable() { return child.stdout; },
      get writable() { return child.stdin; },
      get stdio() { return [null, null, null, ...extraFds]; },
      terminal,
      get exitCode() { return exitCode; },
      get signalCode() { return signalCode; },
      get killed() { return killed; },
      get connected() { return nativeOptions.ipc && !disconnected; },
      exited: null,
      on(name, handler) {
        const handlers = listeners.get(name) ?? [];
        handlers.push(handler);
        listeners.set(name, handlers);
        return child;
      },
      once(name, handler) {
        const wrapped = (...args) => {
          child.off(name, wrapped);
          handler(...args);
        };
        wrapped.listener = handler;
        return child.on(name, wrapped);
      },
      off(name, handler) {
        const handlers = listeners.get(name) ?? [];
        listeners.set(name, handlers.filter(candidate => candidate !== handler && candidate.listener !== handler));
        return child;
      },
      kill(signal = "SIGTERM") {
        const code = bunSignalNumber(signal);
        const sent = host.spawnKill?.(child._id, code) === true;
        if (sent && code !== 0) {
          killRequested = true;
        }
      },
      ref() { unregisterSpawnListener?.ref?.(); },
      unref() { unregisterSpawnListener?.unref?.(); },
      send(message) {
        let sendHandleOrCallback = arguments[1];
        let optionsOrCallback = arguments[2];
        let callback = arguments[3];
        let sendHandle = sendHandleOrCallback;
        let sendOptions = optionsOrCallback;
        if (typeof sendHandleOrCallback === "function") {
          callback = sendHandleOrCallback;
          sendHandle = undefined;
          sendOptions = undefined;
        } else if (typeof optionsOrCallback === "function") {
          callback = optionsOrCallback;
          sendOptions = undefined;
        } else if (sendOptions !== undefined && (sendOptions === null || typeof sendOptions !== "object")) {
          throw new TypeError('The "options" argument must be of type object.');
        }
        if (!nativeOptions.ipc || disconnected || !Number.isInteger(child._ipcFd) || child._ipcFd < 0) {
          const error = new Error("Channel closed");
          error.code = "ERR_IPC_CHANNEL_CLOSED";
          if (typeof callback === "function") queueMicrotask(() => callback(error));
          else emit("error", error);
          return false;
        }
        let ok = false;
        try {
          const handleInfo = bunSpawnIpcHandleInfo(sendHandle);
          if (sendHandle != null && handleInfo == null) {
            const error = new TypeError("This handle type cannot be sent");
            error.code = "ERR_INVALID_HANDLE_TYPE";
            throw error;
          }
          ok = host.ipcSend?.(
            child._ipcFd,
            encodeBunSpawnIpc(message, child._nodeIpcProtocol, nativeOptions.serialization),
            handleInfo?.fd ?? -1,
          ) === true;
        } catch (error) {
          if (typeof callback === "function") queueMicrotask(() => callback(error));
          else emit("error", error);
          return false;
        }
        if (typeof callback === "function") queueMicrotask(() => callback(ok ? null : new Error("write failed")));
        return ok;
      },
      disconnect() {
        if (!nativeOptions.ipc || disconnected) return;
        disconnected = true;
        host.spawnCloseIpc?.(child._id);
      },
      resourceUsage() { return resourceUsage; },
      [Symbol.dispose]() {
        if (!processExited && !killRequested) child.kill(nativeOptions.killSignal);
      },
      async [Symbol.asyncDispose]() {
        if (!processExited && !killRequested) child.kill(nativeOptions.killSignal);
        try { await child.exited; } catch {}
      },
    };

    function emit(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(...args);
    }

    function notifyDisconnect() {
      if (disconnectNotified || !nativeOptions.ipc) return;
      disconnectNotified = true;
      disconnected = true;
      if (typeof nativeOptions.onDisconnect === "function") {
        try { nativeOptions.onDisconnect.call(child, true); }
        catch (error) { queueMicrotask(() => { throw error; }); }
      }
    }

    child._nodeIpcProtocol = nativeOptions.ipc && !isCurrentExecutable(file);
    let native;
    const redirectFds = [];
    let stdoutRedirectFd;
    let stderrRedirectFd;
    try {
      if (nativeOptions.stdoutFilePath != null) {
        stdoutRedirectFd = host.openFd(nativeOptions.stdoutFilePath, "w", 0o666);
        redirectFds.push(stdoutRedirectFd);
      }
      if (nativeOptions.stderrFilePath != null) {
        stderrRedirectFd = host.openFd(nativeOptions.stderrFilePath, "w", 0o666);
        redirectFds.push(stderrRedirectFd);
      }
      native = host.spawnStart(file, args, {
        ...nativeOptions,
        stdin: nativeOptions.stdinFd ?? nativeOptions.stdin,
        stdout: nativeOptions.stdoutFd ?? stdoutRedirectFd ?? nativeOptions.stdout,
        stderr: nativeOptions.stderrFd ?? stderrRedirectFd ?? nativeOptions.stderr,
        extraStdio: nativeOptions.extraStdio,
        nodeIpc: child._nodeIpcProtocol,
        argv0: nativeOptions.argv0,
        detached: nativeOptions.detached,
        terminalFd: terminalSpawnFd(terminal),
        deferStart,
      });
    } catch (error) {
      if (readableInput != null && !readableInput.finished) void readableInput.cancel(error);
      throw normalizeSpawnError(error, file, nativeOptions.cwd);
    } finally {
      for (const fd of redirectFds) {
        try { host.closeFd?.(fd); } catch {}
      }
    }
    child._id = native.id;
    child._ipcFd = native.ipcFd == null ? -1 : Number(native.ipcFd);
    extraFds = Array.isArray(native.extraFds) ? native.extraFds : [];
    while (extraFds.length > 0 && extraFds.at(-1) == null) extraFds.pop();
    const ownedExtraFds = extraFds.filter((fd, index) =>
      Number.isInteger(fd) && fd >= 0 && nativeOptions.extraStdio?.[index] === "pipe"
    );
    if (ownedExtraFds.length > 0) extraFdFinalizer?.register(child, ownedExtraFds);
    child.pid = native.pid;
    child.stdin = terminal
      ? null
      : nativeOptions.stdinFd != null && nativeOptions.stdinFd !== 0
        ? nativeOptions.stdinFd
        : readableInput != null
          ? nativeOptions.input
          : nativeOptions.stdin === "pipe" && nativeOptions.input === undefined
            ? new ProcessWritable(host, native.id, asBuffer)
            : undefined;

    if (nativeOptions.input !== undefined) {
      void (async () => {
        try {
          if (readableInput != null) return await readableInput.pump(bytes => host.spawnWrite?.(native.id, bytes));
          const bytes = await bytesFromBody(nativeOptions.input);
          if (bytes.byteLength > 0 && host.spawnWrite?.(native.id, bytes) !== true) return new Error("write failed");
          return null;
        } catch (error) {
          return error;
        }
      })().then(error => {
        host.spawnCloseStdin?.(native.id);
        if (error != null && (listeners.get("error")?.length ?? 0) > 0) emit("error", error);
      });
    }

    const maxBuffer = nativeOptions.maxBuffer == null ? Infinity : nativeOptions.maxBuffer;
    const killSignal = nativeOptions.killSignal;
    const enforceMaxBuffer = () => {
      if (exceededMaxBuffer || !Number.isFinite(maxBuffer)) return;
      if ((nativeOptions.stdout === "pipe" && stdoutLength > maxBuffer) ||
          (nativeOptions.stderr === "pipe" && stderrLength > maxBuffer)) {
        exceededMaxBuffer = true;
        child.kill(killSignal);
      }
    };
    if (Number(nativeOptions.timeout) > 0) timeoutTimer = setTimeout(() => child.kill(killSignal), nativeOptions.timeout);

    child.exited = new Promise((resolve, reject) => {
      const completeExit = result => {
        if (processExited) return;
        processExited = true;
        if (timeoutTimer != null) clearTimeout(timeoutTimer);
        timeoutTimer = null;
        if (abortHandler != null) nativeOptions.signal?.removeEventListener?.("abort", abortHandler);
        abortHandler = null;
        const signalNumber = Number(result.signalCode ?? 0);
        signalCode = signalNumber > 0 ? bunSignalName(signalNumber) ?? String(signalNumber) : null;
        exitCode = signalNumber > 0 || result.exitCode == null ? null : Number(result.exitCode);
        // Bun's `killed` getter means the subprocess has reached any terminal
        // status, not only that Subprocess.kill() sent the terminating signal.
        killed = true;
        resourceUsage = normalizeResourceUsage(result.resourceUsage);
        try {
          terminalProcessExited(terminal, exitCode, signalCode);
          if (readableInput != null && !readableInput.finished) void readableInput.cancel(new Error("Subprocess exited"));
          child.stdin?._processExited?.();
          resolve(exitCode ?? (signalNumber > 0 ? 128 + signalNumber : null));
          if (typeof nativeOptions.onExit === "function") {
            try { nativeOptions.onExit.call(child, child, exitCode, signalCode, undefined); }
            catch (error) { queueMicrotask(() => { throw error; }); }
          }
          emit("exit", exitCode, signalCode);
        } catch (error) {
          reject(error);
        }
      };

      const completeClose = () => {
        if (nativeClosed) return;
        nativeClosed = true;
        unregisterSpawnListener?.();
        unregisterSpawnListener = null;
        if (timeoutTimer != null) clearTimeout(timeoutTimer);
        timeoutTimer = null;
        if (abortHandler != null) nativeOptions.signal?.removeEventListener?.("abort", abortHandler);
        abortHandler = null;
        if (Number.isInteger(ipcPendingFd) && ipcPendingFd >= 0) {
          try { host.closeFd?.(ipcPendingFd); } catch {}
          ipcPendingFd = undefined;
        }
        if (nativeOptions.stdoutBuffer != null) writeOutputBuffer(nativeOptions.stdoutBuffer, concatChunks(stdoutChunks));
        if (nativeOptions.stderrBuffer != null) writeOutputBuffer(nativeOptions.stderrBuffer, concatChunks(stderrChunks));
        child.stdout?._finish?.();
        child.stderr?._finish?.();
        notifyDisconnect();
        emit("close", exitCode, signalCode);
        host.spawnDispose?.(native.id);
      };

      unregisterSpawnListener = globalThis.__cottontailRegisterSpawnListener?.(native.id, event => {
        if (!event) return;
        if (event.type === "stdout" || event.type === "stderr") {
          const chunk = asBuffer(event.data ?? new ArrayBuffer(0));
          if (chunk.byteLength === 0) return;
          const isStdout = event.type === "stdout";
          if (isStdout) {
            if (nativeOptions.stdoutBuffer != null) stdoutChunks.push(chunk);
            stdoutLength += chunk.byteLength;
            child.stdout?._push?.(chunk);
          } else {
            if (nativeOptions.stderrBuffer != null) stderrChunks.push(chunk);
            stderrLength += chunk.byteLength;
            child.stderr?._push?.(chunk);
          }
          enforceMaxBuffer();
          return;
        }
        if (event.type === "stdout_end") {
          child.stdout?._finish?.();
          return;
        }
        if (event.type === "stderr_end") {
          child.stderr?._finish?.();
          return;
        }
        if (event.type === "ipc") {
          if (Number.isInteger(event.fd) && event.fd >= 0) {
            if (Number.isInteger(ipcPendingFd) && ipcPendingFd >= 0) {
              try { host.closeFd?.(ipcPendingFd); } catch {}
            }
            ipcPendingFd = Number(event.fd);
          }
          ipcBuffer += ipcDecoder.decode(event.data ?? new ArrayBuffer(0), { stream: true });
          for (;;) {
            const newline = ipcBuffer.indexOf("\n");
            if (newline < 0) break;
            const line = ipcBuffer.slice(0, newline).replace(/\r$/, "");
            ipcBuffer = ipcBuffer.slice(newline + 1);
            if (line.trim() === "") continue;
            const frameFd = ipcPendingFd;
            ipcPendingFd = undefined;
            let message;
            try { message = decodeBunSpawnIpc(line); }
            catch (error) {
              if (Number.isInteger(frameFd) && frameFd >= 0) {
                try { host.closeFd?.(frameFd); } catch {}
              }
              if (!isCottontailIpcFrame(line)) continue;
              emit("error", error);
              continue;
            }
            const handle = adoptBunSpawnIpcHandle(host, frameFd);
            if (typeof nativeOptions.ipcCallback !== "function") {
              handle?.destroy?.();
              continue;
            }
            try { nativeOptions.ipcCallback.call(child, message, child, handle); }
            catch (error) { queueMicrotask(() => { throw error; }); }
          }
          return;
        }
        if (event.type === "ipc_end") {
          ipcBuffer += ipcDecoder.decode();
          if (Number.isInteger(ipcPendingFd) && ipcPendingFd >= 0) {
            try { host.closeFd?.(ipcPendingFd); } catch {}
            ipcPendingFd = undefined;
          }
          notifyDisconnect();
          return;
        }
        if (event.type === "exit") {
          completeExit(event);
          return;
        }
        if (event.type === "close") completeClose();
      });
    });

    // A Cottontail child can publish IPC or exit before the host listener is
    // registered. Release it only after this listener owns every process event.
    if (deferStart) host.spawnRelease?.(native.id);

    if (nativeOptions.signal != null) {
      abortHandler = () => {
        if (readableInput != null && !readableInput.finished) void readableInput.cancel(nativeOptions.signal.reason);
        child.kill(killSignal);
      };
      if (nativeOptions.signal.aborted) abortHandler();
      else nativeOptions.signal.addEventListener("abort", abortHandler, { once: true });
    }
    return child;
  }

  return { spawn, spawnSync };
}
