import { EventEmitter } from "./events.js";
import { _wrapAsyncCallback } from "./async_hooks.js";

const kConnectionCount = Symbol("connectionCount");
const kSocketAddressState = new WeakMap();
const kBlockListState = new WeakMap();

function makeNodeError(ErrorType, message, code, details = undefined) {
  const error = new ErrorType(message);
  error.code = code;
  if (details) Object.assign(error, details);
  return error;
}

function invalidArgType(name, expected, value) {
  const received = value === null
    ? "null"
    : typeof value === "object"
      ? `an instance of ${value?.constructor?.name ?? "Object"}`
      : `type ${typeof value} (${String(value)})`;
  return makeNodeError(TypeError, `The "${name}" argument must be ${expected}. Received ${received}`, "ERR_INVALID_ARG_TYPE");
}

function invalidArgValue(name, value, reason = "is invalid") {
  let inspected;
  try { inspected = JSON.stringify(value); } catch { inspected = String(value); }
  return makeNodeError(TypeError, `The argument '${name}' ${reason}. Received ${inspected}`, "ERR_INVALID_ARG_VALUE");
}

function outOfRange(name, range, value) {
  return makeNodeError(RangeError, `The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`, "ERR_OUT_OF_RANGE");
}

function validatePort(value, name = "options.port", allowUndefined = false) {
  if (allowUndefined && value === undefined) return undefined;
  if (typeof value !== "number" && typeof value !== "string") throw invalidArgType(name, "of type number or string", value);
  if (typeof value === "string" && value.trim() === "") throw makeNodeError(RangeError, `${name} should be >= 0 and < 65536. Received type string (${JSON.stringify(value)}).`, "ERR_SOCKET_BAD_PORT");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw makeNodeError(RangeError, `${name} should be >= 0 and < 65536. Received type ${typeof value} (${String(value)}).`, "ERR_SOCKET_BAD_PORT");
  }
  return port;
}

function validateAbortSignal(signal, name = "options.signal") {
  if (signal == null || typeof signal !== "object" || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function") {
    throw invalidArgType(name, "an instance of AbortSignal", signal);
  }
}

function normalizeSocketFamily(family, name = "options.family") {
  if (family == null || family === 0) return 0;
  if (family === 4 || family === "4" || family === "IPv4" || family === "ipv4") return 4;
  if (family === 6 || family === "6" || family === "IPv6" || family === "ipv6") return 6;
  throw invalidArgValue(name, family, "must be 0, 4, 6, 'IPv4', or 'IPv6'");
}

function normalizeHighWaterMark(value, fallback = process.platform === "win32" ? 16 * 1024 : 64 * 1024) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw outOfRange("options.highWaterMark", ">= 0", value);
  return Math.min(Math.trunc(number), 1024 * 1024 * 1024);
}

// Module evaluation order can reach this file before bun/index.js installs the
// Symbol.dispose/asyncDispose polyfills, so ensure the shared symbol here.
function ensureAsyncDisposeSymbol() {
  if (Symbol.asyncDispose == null) {
    Object.defineProperty(Symbol, "asyncDispose", {
      value: Symbol.for("Symbol.asyncDispose"),
      configurable: true,
    });
  }
  return Symbol.asyncDispose;
}

function installFdWatchDispatcher() {
  const listeners = globalThis.__cottontailFdWatchListeners ??= new Map();
  if (!globalThis.__cottontailFdWatchHandlerInstalled && typeof cottontail.fdSetEventHandler === "function") {
    globalThis.__cottontailFdWatchHandlerInstalled = true;
    cottontail.fdSetEventHandler((event) => {
      const listener = listeners.get(Number(event?.id));
      if (typeof listener === "function") {
        listener(event);
        return;
      }
      const tlsListener = globalThis.__cottontailTlsListeners?.get?.(Number(event?.id));
      if (typeof tlsListener === "function") tlsListener(event);
    });
  }
  return listeners;
}

function bytesFrom(chunk, encoding = undefined) {
  if (chunk == null) return new Uint8Array(0);
  if (typeof chunk === "string") return globalThis.Buffer?.from ? globalThis.Buffer.from(chunk, encoding ?? "utf8") : new TextEncoder().encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return globalThis.Buffer?.from ? globalThis.Buffer.from(String(chunk)) : new TextEncoder().encode(String(chunk));
}

function chunkFromBytes(bytes, encoding = null) {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(0);
  if (globalThis.Buffer?.from) {
    const buffer = globalThis.Buffer.from(view);
    return encoding ? buffer.toString(encoding) : buffer;
  }
  if (encoding) return new TextDecoder(encoding).decode(view);
  return view;
}

function ipv4ToNumber(input) {
  if (!isIPv4(input)) return null;
  return String(input).split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function normalizeFamily(family = "ipv4") {
  const text = String(family).toLowerCase();
  return text === "ipv6" || text === "6" ? "ipv6" : "ipv4";
}

const connectErrnos = {
  ECONNREFUSED: -61,
  ECONNRESET: -54,
  EHOSTUNREACH: -65,
  ENETUNREACH: -51,
  ENOENT: -2,
  ETIMEDOUT: -60,
};

function connectionException(rawError, options, host, port) {
  const original = rawError instanceof Error ? rawError : new Error(String(rawError));
  const text = String(original.message);
  let code = original.code;
  if (code == null) {
    if (/refused|ECONNREFUSED/i.test(text)) code = "ECONNREFUSED";
    else if (/no such file|ENOENT/i.test(text)) code = "ENOENT";
    else if (/(not known|not found|ENOTFOUND|nodename|no address)/i.test(text)) code = "ENOTFOUND";
    else if (/timed? ?out|ETIMEDOUT/i.test(text)) code = "ETIMEDOUT";
    else if (/host.*unreachable|EHOSTUNREACH/i.test(text)) code = "EHOSTUNREACH";
    else if (/network.*unreachable|ENETUNREACH/i.test(text)) code = "ENETUNREACH";
    else if (/reset|ECONNRESET/i.test(text)) code = "ECONNRESET";
  }
  if (code === "ENOTFOUND") {
    const error = new Error(`getaddrinfo ENOTFOUND ${host}`);
    error.code = "ENOTFOUND";
    error.errno = -3008;
    error.syscall = "getaddrinfo";
    error.hostname = host;
    return error;
  }
  if (code == null) {
    original.syscall = "connect";
    return original;
  }
  const location = options.path != null ? String(options.path) : `${host}:${port}`;
  const error = new Error(`connect ${code} ${location}`);
  error.code = code;
  error.errno = connectErrnos[code];
  error.syscall = "connect";
  if (options.path != null) {
    error.address = String(options.path);
  } else {
    error.address = host;
    error.port = port;
  }
  return error;
}

class SocketImpl extends EventEmitter {
  constructor(options = {}) {
    super();
    if (options == null) options = {};
    if (typeof options !== "object") throw invalidArgType("options", "of type object", options);
    for (const name of ["objectMode", "readableObjectMode", "writableObjectMode"]) {
      if (options[name]) throw invalidArgValue(`options.${name}`, options[name], "is not supported");
    }
    if (options.fd !== undefined && (!Number.isInteger(options.fd) || options.fd < 0 || options.fd > 0x7fffffff)) {
      throw outOfRange("options.fd", ">= 0 && <= 2147483647", options.fd);
    }
    if (options.onread != null) {
      if (typeof options.onread !== "object") throw invalidArgType("options.onread", "of type object", options.onread);
      if (typeof options.onread.callback !== "function") throw invalidArgType("options.onread.callback", "of type function", options.onread.callback);
    }
    if (options.signal !== undefined) validateAbortSignal(options.signal);
    if (options.blockList !== undefined && !BlockList.isBlockList(options.blockList)) {
      throw invalidArgType("options.blockList", "an instance of net.BlockList", options.blockList);
    }
    this.fd = options.fd ?? null;
    this.connecting = false;
    this.destroyed = false;
    this.encrypted = false;
    this.readable = true;
    this.writable = true;
    this.remoteAddress = undefined;
    this.remoteFamily = undefined;
    this.remotePort = undefined;
    this.localAddress = undefined;
    this.localPort = undefined;
    this.localFamily = undefined;
    this.bytesRead = 0;
    this._bytesDispatchedValue = 0;
    this.timeout = 0;
    this._timeoutValue = 0;
    this.allowHalfOpen = options.allowHalfOpen === true;
    this.writableHighWaterMark = normalizeHighWaterMark(options.writableHighWaterMark ?? options.highWaterMark);
    this.readableHighWaterMark = normalizeHighWaterMark(options.readableHighWaterMark ?? options.highWaterMark);
    this.writableLength = 0;
    this.writableNeedDrain = false;
    this._encoding = null;
    this._timeoutTimer = null;
    this._watchId = 0;
    this._unregisterWatch = null;
    this._isPipe = options.pipe === true || options.path != null;
    this._path = options.path;
    this._paused = Boolean(options.pauseOnConnect);
    this._pendingData = [];
    this._pendingEnd = false;
    this._pendingWrites = [];
    this._outboundWrites = [];
    this._writeRetryTimer = null;
    this._drainQueued = false;
    this._ending = false;
    this._endEmitted = false;
    this._finishEmitted = false;
    this._closeEmitted = false;
    this._hadError = false;
    this._pipes = new Map();
    this._onread = options.onread && typeof options.onread === "object" && typeof options.onread.callback === "function"
      ? options.onread
      : null;
    this._abortSignal = null;
    this._abortReason = undefined;
    this._host = undefined;
    this._port = undefined;
    this._peername = null;
    this._sockname = null;
    this._defaultEncoding = "utf8";
    this._noDelay = Boolean(options.noDelay);
    this._keepAlive = Boolean(options.keepAlive);
    this._keepAliveInitialDelay = Math.max(0, Number(options.keepAliveInitialDelay) || 0);
    this._refed = true;
    this._readyEmitted = false;
    this.server = undefined;
    this.isServer = false;
    this.pauseOnConnect = Boolean(options.pauseOnConnect);
    this.blockList = options.blockList;
    if (options.signal) this._setupAbortSignal(options.signal);
    if (this.fd != null) this._attachFd(this.fd, options.local, options.remote, false);
  }

  // Node exposes the libuv wrap as socket._handle with an fd property; tools
  // and tests read socket._handle.fd. Surface a small stand-in over this.fd.
  get _handle() {
    if (this.__handleOverride !== undefined) return this.__handleOverride;
    if (this.fd == null) return null;
    if (this.__handleWrap == null) {
      const self = this;
      this.__handleWrap = {
        get fd() { return self.fd ?? -1; },
        get owner() { return self; },
        setNoDelay(value = true) { self.setNoDelay(value); return 0; },
        setKeepAlive(value = false, delay = 0) { self.setKeepAlive(value, Number(delay) * 1000); return 0; },
        close(callback) { self.destroy(); if (typeof callback === "function") queueMicrotask(callback); },
        ref() { self.ref(); },
        unref() { self.unref(); },
        hasRef() { return self._refed; },
      };
    }
    return this.__handleWrap;
  }

  set _handle(value) {
    this.__handleOverride = value;
  }

  _setAddressInfo(local = undefined, remote = undefined) {
    if (local) {
      if (local.path != null) {
        this.localAddress = local.path;
        this.localPort = undefined;
        this.localFamily = "Unix";
        this._path = local.path;
        this._isPipe = true;
      } else {
      this.localAddress = local.address;
      this.localPort = local.port;
      this.localFamily = local.family;
      }
    }
    if (remote) {
      if (remote.path != null) {
        this.remoteAddress = remote.path;
        this.remotePort = undefined;
        this.remoteFamily = "Unix";
        this._isPipe = true;
      } else {
      this.remoteAddress = remote.address;
      this.remotePort = remote.port;
      this.remoteFamily = remote.family;
      }
    }
  }

  _clearTimeoutTimer() {
    if (this._timeoutTimer != null) {
      globalThis.clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  }

  _refreshTimeout() {
    this._clearTimeoutTimer();
    const timeout = Number(this._timeoutValue);
    if (!this.destroyed && timeout > 0) {
      this._timeoutTimer = globalThis.setTimeout(() => {
        this._timeoutTimer = null;
        if (!this.destroyed && Number(this._timeoutValue) > 0) this.emit("timeout");
      }, timeout);
    }
    return this;
  }

  _applySocketOptions() {
    if (this.fd == null || this._isPipe) return;
    if (this._noDelay && typeof cottontail.tcpSocketSetNoDelay === "function") {
      cottontail.tcpSocketSetNoDelay(this.fd, true);
    }
    if (this._keepAlive && typeof cottontail.tcpSocketSetKeepAlive === "function") {
      cottontail.tcpSocketSetKeepAlive(this.fd, true, this._keepAliveInitialDelay);
    }
  }

  _attachFd(fd, local = undefined, remote = undefined, emitConnect = false) {
    this.fd = Number(fd);
    this.destroyed = false;
    this.readable = true;
    this.writable = !this._ending;
    this._setAddressInfo(local, remote);
    this._applySocketOptions();
    if (emitConnect) {
      this.connecting = false;
      queueMicrotask(() => {
        if (this.destroyed) return;
        this._flushPendingWrites();
        this.emit("connect");
        this._readyEmitted = true;
        this.emit("ready");
        this._startRead();
        this._refreshTimeout();
      });
      return this;
    }
    if (!this._paused) this._startRead();
    this._refreshTimeout();
    return this;
  }

  _flushPendingWrites(error = undefined) {
    const pending = this._pendingWrites.splice(0);
    for (const entry of pending) {
      if (error) {
        if (typeof entry.callback === "function") entry.callback(error);
        continue;
      }
      this._outboundWrites.push(entry);
    }
    if (!error) this._flushOutboundWrites();
  }

  _scheduleOutboundFlush() {
    if (this._writeRetryTimer != null || this.destroyed) return;
    this._writeRetryTimer = globalThis.setTimeout(() => {
      this._writeRetryTimer = null;
      this._flushOutboundWrites();
    }, 0);
  }

  _flushOutboundWrites() {
    if (this.destroyed || this.fd == null) return;
    try {
      while (this._outboundWrites.length > 0) {
        const entry = this._outboundWrites[0];
        let remaining = entry.bytes.subarray(entry.offset);
        // Native write bindings reject buffers >= 2 GiB; write in bounded slices.
        if (remaining.byteLength > 0x40000000) remaining = remaining.subarray(0, 0x40000000);
        if (remaining.byteLength === 0) {
          this._outboundWrites.shift();
          if (typeof entry.callback === "function") queueMicrotask(() => entry.callback());
          continue;
        }
        const written = typeof cottontail.fdWriteSome === "function"
          ? Number(cottontail.fdWriteSome(this.fd, remaining))
          : cottontail.fdWrite?.(this.fd, remaining) === true ? remaining.byteLength : 0;
        if (!Number.isFinite(written) || written < 0) throw new Error("socket write failed");
        if (written === 0) {
          this._scheduleOutboundFlush();
          return;
        }
        const count = Math.min(remaining.byteLength, Math.trunc(written));
        entry.offset += count;
        this._bytesDispatchedValue += count;
        this.writableLength = Math.max(0, this.writableLength - count);
        this._refreshTimeout();
        if (entry.offset < entry.bytes.byteLength) continue;
        this._outboundWrites.shift();
        if (typeof entry.callback === "function") queueMicrotask(() => entry.callback());
      }
    } catch (error) {
      this.destroy(error);
      return;
    }

    if (this.writableNeedDrain && this.writableLength === 0 && !this._drainQueued) {
      this._drainQueued = true;
      queueMicrotask(() => {
        this._drainQueued = false;
        if (this.destroyed || this.writableLength !== 0) return;
        this.writableNeedDrain = false;
        this.emit("drain");
      });
    }
    if (this._ending && this.fd != null) {
      try { cottontail.tcpSocketShutdown?.(this.fd); } catch {}
    }
    this._maybeEmitFinish();
  }

  _stopRead() {
    const watchId = this._watchId;
    this._watchId = 0;
    if (this._unregisterWatch) this._unregisterWatch();
    this._unregisterWatch = null;
    if (watchId) cottontail.fdWatchStop?.(watchId);
  }

  _detachFdForTls() {
    if (this.fd == null || this.destroyed || this.connecting) {
      const error = new Error("Socket is not connected");
      error.code = "ERR_SOCKET_CLOSED";
      throw error;
    }
    this._flushOutboundWrites();
    if (this._pendingWrites.length > 0 || this._outboundWrites.length > 0) {
      const error = new Error("Socket still has pending writes");
      error.code = "ERR_SOCKET_CLOSED";
      throw error;
    }
    if (this._pendingData.length > 0) {
      const error = new Error("Socket has unread data and cannot be upgraded to TLS");
      error.code = "ERR_SSL_INTERNAL_ERROR";
      throw error;
    }

    this._stopRead();
    this._clearTimeoutTimer();
    if (this._writeRetryTimer != null) {
      clearTimeout(this._writeRetryTimer);
      this._writeRetryTimer = null;
    }
    const fd = this.fd;
    this.fd = null;
    this.readable = false;
    this.writable = false;
    this.destroyed = true;
    this._tlsDetached = true;
    return fd;
  }

  _emitData(chunk) {
    if (this._paused || this._pendingData.length > 0 || this.listenerCount("readable") > 0) {
      this._pendingData.push(chunk);
      if (this.listenerCount("readable") > 0) this.emit("readable");
      if (!this._paused && this.listenerCount("data") > 0) queueMicrotask(() => this._flushPendingData());
      return;
    }
    this.emit("data", chunk);
  }

  unshift(chunk) {
    if (chunk == null) return this;
    const bytes = typeof chunk === "string" ? bytesFrom(chunk, this._encoding ?? undefined) : chunk;
    const wrapped = globalThis.Buffer?.isBuffer?.(bytes) ? bytes : chunkFromBytes(bytes, this._encoding);
    this._pendingData.unshift(wrapped);
    if (!this._paused) queueMicrotask(() => this._flushPendingData());
    return this;
  }

  read(_size = undefined) {
    if (this._pendingData.length === 0) return null;
    const chunks = this._pendingData.splice(0);
    if (this._encoding) return chunks.join("");
    const buffers = chunks.map((chunk) => (globalThis.Buffer?.isBuffer?.(chunk) ? chunk : globalThis.Buffer.from(chunk)));
    const merged = buffers.length === 1 ? buffers[0] : globalThis.Buffer.concat(buffers);
    if (this._pendingEnd) queueMicrotask(() => this._flushPendingData());
    return merged;
  }

  pipe(destination, options = {}) {
    const onData = (chunk) => {
      if (destination.destroyed || destination.writable === false) return;
      const ok = destination.write(chunk);
      if (ok === false) {
        this.pause();
        destination.once?.("drain", onDrain);
      }
    };
    const onDrain = () => this.resume();
    const onEnd = () => {
      if (options.end !== false) destination.end?.();
    };
    const onClose = () => this.unpipe(destination);
    this.on("data", onData);
    this.on("end", onEnd);
    destination.on?.("close", onClose);
    this._pipes.set(destination, { onData, onDrain, onEnd, onClose });
    destination.emit?.("pipe", this);
    this.resume();
    return destination;
  }

  unpipe(destination = undefined) {
    const targets = destination ? [destination] : Array.from(this._pipes.keys());
    for (const target of targets) {
      const handlers = this._pipes.get(target);
      if (!handlers) continue;
      this._pipes.delete(target);
      this.off("data", handlers.onData);
      this.off("end", handlers.onEnd);
      target.off?.("drain", handlers.onDrain);
      target.off?.("close", handlers.onClose);
      target.emit?.("unpipe", this);
    }
    return this;
  }

  cork() { return this; }
  uncork() { return this; }

  get bufferSize() {
    return this.writableLength;
  }

  get _readableState() {
    let length = 0;
    for (const chunk of this._pendingData) length += Number(chunk?.byteLength ?? chunk?.length ?? 0);
    return {
      endEmitted: this._endEmitted,
      ended: this._endEmitted || this._pendingEnd,
      flowing: this._paused ? false : true,
      length,
      destroyed: this.destroyed,
    };
  }

  get _writableState() {
    return {
      length: this.writableLength,
      needDrain: this.writableNeedDrain,
      corked: 0,
      ended: !this.writable,
      finished: this._finishEmitted,
      errorEmitted: false,
      destroyed: this.destroyed,
    };
  }

  _emitEnd() {
    if (this._paused || this._pendingData.length > 0) {
      this._pendingEnd = true;
      return;
    }
    if (this._endEmitted) return;
    this._endEmitted = true;
    this.emit("end");
    if (!this.allowHalfOpen && this.writable) this.end();
    this._maybeClose();
  }

  _maybeClose() {
    // Once both directions are done (FIN received and FIN sent) the socket
    // closes, even with allowHalfOpen.
    if (this._finishEmitted && this._endEmitted && !this.destroyed) {
      queueMicrotask(() => {
        if (this._finishEmitted && this._endEmitted && !this.destroyed) this.destroy();
      });
    }
  }

  _flushPendingData() {
    while (!this._paused && this._pendingData.length > 0) {
      this.emit("data", this._pendingData.shift());
    }
    if (!this._paused && this._pendingEnd) {
      this._pendingEnd = false;
      this._emitEnd();
    }
  }

  _deliverOnread(data) {
    const source = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(0);
    let offset = 0;
    while (offset < source.byteLength) {
      const target = typeof this._onread.buffer === "function" ? this._onread.buffer() : this._onread.buffer;
      const view = ArrayBuffer.isView(target)
        ? new Uint8Array(target.buffer, target.byteOffset, target.byteLength)
        : new Uint8Array(target);
      const count = Math.min(view.byteLength, source.byteLength - offset);
      if (count === 0) break;
      view.set(source.subarray(offset, offset + count));
      offset += count;
      this.bytesRead += count;
      try {
        const keepReading = this._onread.callback(count, target);
        if (keepReading === false) this.pause();
      } catch (error) {
        this.destroy(error);
        return;
      }
    }
    this._refreshTimeout();
  }

  _startRead() {
    if (this.fd == null || this.destroyed || this._watchId || typeof cottontail.fdWatchStart !== "function") return this;
    const fdWatchListeners = installFdWatchDispatcher();
    const watch = cottontail.fdWatchStart(this.fd, 1024 * 1024);
    this._watchId = Number(watch?.id || 0);
    if (!this._watchId) return this;
    const watchId = this._watchId;
    fdWatchListeners.set(watchId, _wrapAsyncCallback((event) => {
      if (this.destroyed) return;
      if (event.type === "data") {
        if (this._onread) {
          this._deliverOnread(event.data ?? new ArrayBuffer(0));
          return;
        }
        const chunk = chunkFromBytes(event.data ?? new ArrayBuffer(0), this._encoding);
        const length = Number(chunk?.byteLength ?? chunk?.length ?? 0);
        if (length > 0) {
          this.bytesRead += length;
          this._emitData(chunk);
          this._refreshTimeout();
        }
        return;
      }
      if (event.type === "end") {
        this.readable = false;
        this._stopRead();
        this._emitEnd();
        return;
      }
      if (event.type === "error") {
        this.destroy(new Error(event.message || "socket read failed"));
      }
    }));
    this._unregisterWatch = () => {
      fdWatchListeners.delete(watchId);
    };
    return this;
  }

  _setupAbortSignal(signal) {
    if (signal == null || typeof signal !== "object" || this._abortSignal === signal) return;
    if (typeof signal.addEventListener !== "function") return;
    this._abortSignal = signal;
    const abort = () => {
      const reason = signal.reason !== undefined ? signal.reason : (() => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        err.code = "ABORT_ERR";
        return err;
      })();
      this._abortReason = reason;
      if (!this.destroyed) this.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    };
    if (signal.aborted) {
      // Node destroys asynchronously so callers can attach "error" listeners.
      setTimeout(abort, 0);
      return;
    }
    const onAbort = () => abort();
    signal.addEventListener("abort", onAbort, { once: true });
    this.once("close", () => {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // ignore
      }
    });
  }

  _resolveConnectAddresses(host, options, callback) {
    const family = normalizeSocketFamily(options.family);
    const numericFamily = isIP(host);
    if (numericFamily) {
      if (family && family !== numericFamily) {
        callback(invalidArgValue("options.family", options.family, `does not match the IP address ${host}`));
      } else {
        callback(null, [{ address: host, family: numericFamily }]);
      }
      return;
    }

    const autoSelectFamily = options.autoSelectFamily == null ? defaultAutoSelectFamily : options.autoSelectFamily;
    if (typeof autoSelectFamily !== "boolean") {
      callback(invalidArgType("options.autoSelectFamily", "of type boolean", autoSelectFamily));
      return;
    }
    const all = autoSelectFamily && family === 0;
    const done = (error, result, resultFamily = undefined) => {
      if (error) {
        this.emit("lookup", error, undefined, undefined, host);
        callback(error);
        return;
      }
      let records;
      if (all) {
        records = Array.isArray(result) ? result : [];
      } else if (result && typeof result === "object" && !ArrayBuffer.isView(result)) {
        records = Array.isArray(result) ? result : [result];
      } else {
        records = [{ address: result, family: resultFamily }];
      }
      try {
        records = records.map((record) => ({
          address: String(record?.address ?? record ?? ""),
          family: normalizeSocketFamily(record?.family ?? resultFamily ?? family),
        }));
      } catch (lookupError) {
        callback(lookupError);
        return;
      }
      const valid = [];
      for (const record of records) {
        const actualFamily = isIP(record.address);
        this.emit("lookup", null, record.address || undefined, record.family || actualFamily || undefined, host);
        if (!actualFamily || (record.family && record.family !== actualFamily)) continue;
        if (family && actualFamily !== family) continue;
        if (!valid.some((candidate) => candidate.address === record.address && candidate.family === actualFamily)) {
          valid.push({ address: record.address, family: actualFamily });
        }
      }
      if (valid.length === 0) {
        callback(makeNodeError(TypeError, `Invalid IP address: ${String(records[0]?.address ?? result)}`, "ERR_INVALID_IP_ADDRESS"));
        return;
      }
      if (all && valid.length > 1) {
        const firstFamily = valid[0].family;
        const buckets = [valid.filter((entry) => entry.family === firstFamily), valid.filter((entry) => entry.family !== firstFamily)];
        const alternating = [];
        for (let index = 0; index < Math.max(buckets[0].length, buckets[1].length); index += 1) {
          if (buckets[0][index]) alternating.push(buckets[0][index]);
          if (buckets[1][index]) alternating.push(buckets[1][index]);
        }
        callback(null, alternating);
      } else {
        callback(null, [valid[0]]);
      }
    };

    if (options.lookup != null) {
      if (typeof options.lookup !== "function") {
        callback(invalidArgType("options.lookup", "of type function", options.lookup));
        return;
      }
      try {
        options.lookup(host, { family, hints: Number(options.hints) || 0, all }, done);
      } catch (error) {
        done(error);
      }
      return;
    }

    try {
      if (typeof cottontail.dnsLookup !== "function") throw new Error("native DNS lookup is unavailable");
      const records = Array.from(cottontail.dnsLookup(host, family) ?? []);
      done(null, all ? records : records[0]);
    } catch (rawError) {
      const error = rawError instanceof Error ? rawError : new Error(String(rawError));
      if (error.code == null) error.code = "ENOTFOUND";
      done(error);
    }
  }

  _attemptConnectAddresses(options, host, port, addresses) {
    if (this.destroyed || !this.connecting) return;
    const attempted = [];
    const errors = [];
    this.autoSelectFamilyAttemptedAddresses = addresses.length > 1 ? attempted : undefined;
    for (const candidate of addresses) {
      if (this.destroyed || !this.connecting) return;
      const { address, family } = candidate;
      attempted.push(`${address}:${port}`);
      this.emit("connectionAttempt", address, port, family);
      if (this.blockList?.check(address, `ipv${family}`)) {
        const blocked = makeNodeError(Error, `IP address is blocked by the supplied net.BlockList: ${address}`, "ERR_IP_BLOCKED", { address });
        errors.push(blocked);
        this.emit("connectionAttemptFailed", address, port, family, blocked);
        continue;
      }
      try {
        const result = cottontail.tcpSocketConnect(port, address, family);
        if (this.destroyed || !this.connecting) {
          try { cottontail.closeFd?.(result.fd); } catch {}
          return;
        }
        this._attachFd(result.fd, result.local, result.remote, true);
        return;
      } catch (rawError) {
        const error = connectionException(rawError, options, address, port);
        errors.push(error);
        this.emit("connectionAttemptFailed", address, port, family, error);
      }
    }
    if (errors.length > 1) {
      const error = new AggregateError(errors, "All connection attempts failed");
      error.code = errors[0]?.code;
      this.connecting = false;
      this.destroy(error);
    } else {
      this.connecting = false;
      this.destroy(errors[0] ?? connectionException(new Error("Failed to connect"), options, host, port));
    }
  }

  connect(...args) {
    const [options, callback] = _normalizeArgs(args);
    if (options.path == null && options.port === undefined && options.fd === undefined) {
      throw makeNodeError(TypeError, 'The "options", "port", or "path" argument must be specified', "ERR_MISSING_ARGS");
    }
    if (this.connecting) throw makeNodeError(Error, "Socket is already connecting", "ERR_SOCKET_CONNECTING");
    if (options.path != null && typeof options.path !== "string") throw invalidArgType("options.path", "of type string", options.path);
    if (options.host != null && typeof options.host !== "string") throw invalidArgType("options.host", "of type string", options.host);
    if (options.localAddress != null && !isIP(options.localAddress)) {
      throw makeNodeError(TypeError, `Invalid IP address: ${String(options.localAddress)}`, "ERR_INVALID_IP_ADDRESS");
    }
    if (options.localPort != null) validatePort(options.localPort, "options.localPort");
    if (options.autoSelectFamily != null && typeof options.autoSelectFamily !== "boolean") {
      throw invalidArgType("options.autoSelectFamily", "of type boolean", options.autoSelectFamily);
    }
    if (options.autoSelectFamilyAttemptTimeout != null) {
      if (!Number.isInteger(options.autoSelectFamilyAttemptTimeout) || options.autoSelectFamilyAttemptTimeout < 1) {
        throw outOfRange("options.autoSelectFamilyAttemptTimeout", ">= 1", options.autoSelectFamilyAttemptTimeout);
      }
    }
    const port = options.path == null && options.fd === undefined ? validatePort(options.port) : undefined;
    if (callback) this.once("connect", callback);
    if (options.onread && typeof options.onread === "object" && typeof options.onread.callback === "function") {
      this._onread = options.onread;
    }
    if (options.signal) this._setupAbortSignal(options.signal);
    if (options.blockList !== undefined) {
      if (!BlockList.isBlockList(options.blockList)) throw invalidArgType("options.blockList", "an instance of net.BlockList", options.blockList);
      this.blockList = options.blockList;
    }
    if (options.timeout != null) this.setTimeout(options.timeout);
    if (options.noDelay != null) this._noDelay = Boolean(options.noDelay);
    if (options.keepAlive != null) this._keepAlive = Boolean(options.keepAlive);
    if (options.keepAliveInitialDelay != null) this._keepAliveInitialDelay = Math.max(0, Number(options.keepAliveInitialDelay) || 0);
    this.connecting = true;
    // Node sockets support reconnecting after end()/destroy().
    if (this.destroyed && this._abortReason === undefined) {
      this.destroyed = false;
      this.readable = true;
      this.writable = true;
      this._ending = false;
      this._endEmitted = false;
      this._finishEmitted = false;
      this._pendingEnd = false;
      this._pendingData = [];
      this._outboundWrites = [];
      this._closeEmitted = false;
      this._hadError = false;
      this._readyEmitted = false;
    }
    // Use a macrotask: connect errors emitted from swallowed microtask
    // exceptions would not crash the process, and Node never connects
    // synchronously either.
    setTimeout(() => {
      if (this.destroyed) return;
      let host = options.host ?? "localhost";
      this._host = String(host);
      this._port = port;
      try {
        if (options.fd !== undefined) {
          this._attachFd(Number(options.fd), options.local, options.remote, true);
          return;
        }
        if (options.path != null) {
          const result = cottontail.unixSocketConnect(String(options.path));
          this._isPipe = true;
          this._path = options.path;
          this._attachFd(result.fd, result.local, result.remote, true);
          return;
        }
        // Connecting to a wildcard address targets the corresponding loopback.
        if (host === "0.0.0.0") host = "127.0.0.1";
        else if (host === "::") host = "::1";
        this._resolveConnectAddresses(String(host), options, (error, addresses) => {
          if (this.destroyed || !this.connecting) return;
          if (error) {
            this.connecting = false;
            this.destroy(connectionException(error, options, host, port));
            return;
          }
          this._attemptConnectAddresses(options, String(host), port, addresses);
        });
      } catch (rawError) {
        this.connecting = false;
        if (this.destroyed) return;
        if (this._abortReason !== undefined) return;
        this.destroy(connectionException(rawError, options, host, port));
      }
    }, 0);
    return this;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (callback !== undefined && typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    if (chunk === null) throw makeNodeError(TypeError, "May not write null values to stream", "ERR_STREAM_NULL_VALUES");
    if (typeof chunk !== "string" && !(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk)) {
      throw invalidArgType("chunk", "of type string or an instance of Buffer, TypedArray, or DataView", chunk);
    }
    if (this._ending || !this.writable) {
      const error = makeNodeError(Error, "write after end", "ERR_STREAM_WRITE_AFTER_END");
      queueMicrotask(() => {
        if (typeof callback === "function") callback(error);
        if (!this.destroyed) this.destroy(error);
      });
      return false;
    }
    const bytes = bytesFrom(chunk, encoding ?? this._defaultEncoding);
    this.writableLength += bytes.byteLength;
    const entry = { bytes, offset: 0, callback };
    const overHighWaterMark = this.writableLength >= this.writableHighWaterMark;
    if (overHighWaterMark) this.writableNeedDrain = true;
    if (this.connecting && this.fd == null && !this.destroyed && this.writable) {
      this._pendingWrites.push(entry);
      return !overHighWaterMark;
    }
    if (this.destroyed || this.fd == null || !this.writable) {
      this.writableLength = Math.max(0, this.writableLength - bytes.byteLength);
      const error = makeNodeError(Error, "Socket is closed", "ERR_SOCKET_CLOSED");
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      queueMicrotask(() => {
        if (!this.destroyed) this.destroy(error);
        else if (this.listenerCount("error") > 0) this.emit("error", error);
      });
      return false;
    }
    this._outboundWrites.push(entry);
    this._flushOutboundWrites();
    return !overHighWaterMark;
  }

  _maybeEmitFinish() {
    if (!this._ending || this._finishEmitted || this._outboundWrites.length > 0) return;
    this._finishEmitted = true;
    this.emit("finish");
    this._maybeClose();
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (typeof callback === "function") {
      if (this._finishEmitted) queueMicrotask(callback);
      else this.once("finish", callback);
    }
    if (this._ending) {
      if (chunk != null) this.write(chunk, encoding, callback);
      return this;
    }
    if (chunk != null) this.write(chunk, encoding);
    this._ending = true;
    this.writable = false;
    if (this.fd != null && this._outboundWrites.length === 0) {
      try { cottontail.tcpSocketShutdown?.(this.fd); } catch {}
    }
    if (this._outboundWrites.length === 0) this._maybeEmitFinish();
    return this;
  }

  destroy(error) {
    if (this._tlsOwner) {
      const tlsOwner = this._tlsOwner;
      this._tlsOwner = null;
      tlsOwner.destroy(error);
      if (!this._tlsCloseEmitted) {
        this._tlsCloseEmitted = true;
        this.emit("close", Boolean(error));
      }
      return this;
    }
    if (this.destroyed) return this;
    this.destroyed = true;
    this.connecting = false;
    this.readable = false;
    this.writable = false;
    this._hadError = Boolean(error);
    this._clearTimeoutTimer();
    this._stopRead();
    this._flushPendingWrites(error ?? new Error("Socket is closed"));
    if (this._writeRetryTimer != null) {
      clearTimeout(this._writeRetryTimer);
      this._writeRetryTimer = null;
    }
    const writeError = error ?? new Error("Socket is closed");
    for (const entry of this._outboundWrites.splice(0)) {
      if (typeof entry.callback === "function") queueMicrotask(() => entry.callback(writeError));
    }
    this.writableLength = 0;
    if (this.fd != null) {
      try { cottontail.closeFd?.(this.fd); } catch {}
      this.fd = null;
    }
    if (error) this.emit("error", error);
    if (!this._closeEmitted) {
      this._closeEmitted = true;
      this.emit("close", Boolean(error));
    }
    return this;
  }

  address() {
    if (this.fd == null) return {};
    if (this._isPipe) return { path: this._path ?? this.localAddress ?? "" };
    try { return cottontail.tcpSocketAddress(this.fd, false); } catch { return {}; }
  }
  setEncoding(encoding = "utf8") {
    this._encoding = String(encoding || "utf8").toLowerCase();
    return this;
  }
  setKeepAlive(enable = false, initialDelay = 0) {
    this._keepAlive = Boolean(enable);
    this._keepAliveInitialDelay = Math.max(0, Number(initialDelay) || 0);
    if (!this._isPipe && this.fd != null && typeof cottontail.tcpSocketSetKeepAlive === "function") {
      cottontail.tcpSocketSetKeepAlive(this.fd, this._keepAlive, this._keepAliveInitialDelay);
    }
    return this;
  }
  setNoDelay(noDelay = true) {
    this._noDelay = Boolean(noDelay);
    if (!this._isPipe && this.fd != null && typeof cottontail.tcpSocketSetNoDelay === "function") {
      cottontail.tcpSocketSetNoDelay(this.fd, this._noDelay);
    }
    return this;
  }
  setTimeout(timeout, callback) {
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0) throw outOfRange("msecs", "a non-negative finite number", timeout);
    if (callback !== undefined && typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    this._timeoutValue = Math.trunc(timeout);
    this.timeout = this._timeoutValue;
    if (this._timeoutValue === 0 && typeof callback === "function") this.removeListener("timeout", callback);
    else if (typeof callback === "function") this.once("timeout", callback);
    this._refreshTimeout();
    return this;
  }
  pause() {
    this._paused = true;
    if (!this.connecting && this.fd != null) this._stopRead();
    return this;
  }
  isPaused() {
    return this._paused;
  }
  resume() {
    this._paused = false;
    this._flushPendingData();
    if (!this.destroyed && this.fd != null) this._startRead();
    return this;
  }
  setDefaultEncoding(encoding = "utf8") {
    this._defaultEncoding = String(encoding || "utf8").toLowerCase();
    return this;
  }
  destroySoon() {
    if (this.writable) this.end();
    if (this._finishEmitted) this.destroy();
    else this.once("finish", () => this.destroy());
    return this;
  }
  resetAndDestroy() {
    if (this.fd == null && !this.connecting) {
      this.destroy(makeNodeError(Error, "Socket is closed", "ERR_SOCKET_CLOSED"));
      return this;
    }
    if (this.connecting) this.once("connect", () => this.destroy());
    else this.destroy();
    return this;
  }
  ref() { this._refed = true; return this; }
  unref() { this._refed = false; return this; }

  get bytesWritten() { return this._bytesDispatchedValue + this.writableLength; }
  get _bytesDispatched() { return this._bytesDispatchedValue; }
  get pending() { return this.fd == null || this.connecting; }
  get writableEnded() { return this._ending; }
  get writableFinished() { return this._finishEmitted; }
  get readableEnded() { return this._endEmitted; }
  get closed() { return this._closeEmitted; }
  get readyState() {
    if (this.connecting) return "opening";
    if (this.destroyed) return "closed";
    if (this.readable && this.writable) return "open";
    if (this.readable) return "readOnly";
    if (this.writable) return "writeOnly";
    return "closed";
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      const chunk = this.read();
      if (chunk !== null) {
        yield chunk;
        continue;
      }
      if (this._endEmitted || this.destroyed) return;
      const result = await new Promise((resolve, reject) => {
        const cleanup = () => {
          this.removeListener("readable", onReadable);
          this.removeListener("end", onEnd);
          this.removeListener("close", onEnd);
          this.removeListener("error", onError);
        };
        const onReadable = () => { cleanup(); resolve("readable"); };
        const onEnd = () => { cleanup(); resolve("end"); };
        const onError = (error) => { cleanup(); reject(error); };
        this.once("readable", onReadable);
        this.once("end", onEnd);
        this.once("close", onEnd);
        this.once("error", onError);
      });
      if (result === "end") return;
    }
  }
}

Object.defineProperty(SocketImpl, "name", { value: "Socket", configurable: true });
Object.defineProperty(SocketImpl, "length", { value: 1, configurable: true });
export const Socket = new Proxy(SocketImpl, {
  apply(target, _thisArg, args) {
    return Reflect.construct(target, args);
  },
});

class ServerImpl extends EventEmitter {
  constructor(options = {}, connectionListener = undefined) {
    super();
    if (typeof options === "function") {
      connectionListener = options;
      options = {};
    }
    if (options == null) options = {};
    else if (typeof options !== "object") throw invalidArgType("options", "of type Object or Function", options);
    options = { ...options };
    this.listening = false;
    this[kConnectionCount] = 0;
    this._connections = 0;
    this.maxConnections = undefined;
    this.dropMaxConnection = false;
    this._options = options;
    this._fd = null;
    this._address = null;
    this._path = null;
    this._isPipe = false;
    this._acceptTimer = null;
    this._unref = false;
    this._usingWorkers = false;
    this.workers = [];
    this.allowHalfOpen = options.allowHalfOpen === true;
    this.pauseOnConnect = options.pauseOnConnect === true;
    this.keepAlive = options.keepAlive === true;
    this.keepAliveInitialDelay = Math.max(0, Number(options.keepAliveInitialDelay) || 0);
    this.noDelay = options.noDelay === true;
    this.highWaterMark = normalizeHighWaterMark(options.highWaterMark);
    this.blockList = options.blockList;
    if (this.blockList !== undefined && !BlockList.isBlockList(this.blockList)) {
      throw invalidArgType("options.blockList", "an instance of net.BlockList", this.blockList);
    }
    this._closePending = false;
    this._closeEmitted = false;
    if (typeof connectionListener === "function") this.on("connection", connectionListener);
  }

  _setConnectionCount(value) {
    this[kConnectionCount] = Math.max(0, Number(value) || 0);
    if (typeof this._connections === "number") this._connections = this[kConnectionCount];
  }

  _incrementConnections() {
    this._setConnectionCount(this[kConnectionCount] + 1);
  }

  _decrementConnections() {
    this._setConnectionCount(this[kConnectionCount] - 1);
    this._emitCloseIfDrained();
  }

  _emitCloseIfDrained() {
    if (!this._closePending || this._fd != null || this[kConnectionCount] > 0 || this._closeEmitted) return;
    this._closeEmitted = true;
    queueMicrotask(() => this.emit("close"));
  }

  _createAcceptedSocket(_accepted, options) {
    return new Socket(options);
  }

  listen(...args) {
    const first = args?.[0];
    if (first !== null && typeof first === "object" && !Array.isArray(first)) {
      if (first.port === undefined && first.path == null && first.fd == null) {
        throw invalidArgValue("options", first, 'must have the property "port" or "path"');
      }
    }
    const [options, callback] = _normalizeArgs(args);
    if (this.listening || this._fd != null) throw makeNodeError(Error, "Listen method has been called more than once without closing.", "ERR_SERVER_ALREADY_LISTEN");
    if (options.path != null && typeof options.path !== "string") throw invalidArgType("options.path", "of type string", options.path);
    if (options.host != null && typeof options.host !== "string") throw invalidArgType("options.host", "of type string", options.host);
    if (options.port !== undefined && options.path == null && options.fd == null) validatePort(options.port);
    if (options.fd != null && (!Number.isInteger(options.fd) || options.fd < 0 || options.fd > 0x7fffffff)) {
      throw outOfRange("options.fd", ">= 0 && <= 2147483647", options.fd);
    }
    if (options.backlog != null && (!Number.isInteger(Number(options.backlog)) || Number(options.backlog) < 0)) {
      throw outOfRange("options.backlog", "a non-negative integer", options.backlog);
    }
    if (options.signal !== undefined) {
      validateAbortSignal(options.signal);
      const signal = options.signal;
      const onAbort = () => this.close();
      if (signal.aborted) setTimeout(onAbort, 0);
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        this.once("close", () => {
          try {
            signal.removeEventListener("abort", onAbort);
          } catch {
            // ignore
          }
        });
      }
    }
    if (callback !== undefined) this.once("listening", callback);
    this._closePending = false;
    this._closeEmitted = false;
    this._options = { ...this._options, ...options };
    try {
      let result;
      if (options.fd != null) {
        this._fd = Number(options.fd);
        this._isPipe = options.path != null || options.pipe === true;
        this._path = this._isPipe ? String(options.path ?? "") : null;
        try {
          this._address = this._isPipe ? this._path : cottontail.tcpSocketAddress?.(this._fd, false) ?? null;
        } catch {
          this._address = this._isPipe ? this._path : null;
        }
      } else if (options.path != null) {
        result = cottontail.unixServerListen(String(options.path), Number(options.backlog ?? 128));
      } else {
        const host = String(options.host ?? "::");
        const family = normalizeSocketFamily(options.family) || (isIPv6(host) ? 6 : isIPv4(host) ? 4 : (host === "::" ? 6 : 0));
        result = cottontail.tcpServerListen(validatePort(options.port ?? 0), host, family || 0);
      }
      if (result != null) {
        this._fd = Number(result.fd);
        this._isPipe = options.path != null;
        this._path = this._isPipe ? String(result.path ?? options.path) : null;
        this._address = this._isPipe ? this._path : result.address ?? null;
      }
      this.listening = true;
      this._acceptTimer = setInterval(() => this._acceptPending(), 1);
      if (this._unref) this._acceptTimer?.unref?.();
      queueMicrotask(() => {
        if (this.listening) this.emit("listening");
      });
    } catch (rawError) {
      this.listening = false;
      this._fd = null;
      const error = rawError instanceof Error ? rawError : new Error(String(rawError));
      if (error.code == null && /(in use|EADDRINUSE)/i.test(String(error.message))) {
        error.code = "EADDRINUSE";
        error.errno = -48;
        error.syscall = "listen";
        if (!this._isPipe) {
          error.address = options.host ?? "::";
          error.port = Number(options.port ?? 0);
        }
      }
      queueMicrotask(() => this.emit("error", error));
    }
    return this;
  }

  static _fromFd(fd, options = {}) {
    const server = new Server(options);
    server._fd = Number(fd);
    server._isPipe = options.pipe === true || options.path != null;
    server._path = options.path ?? null;
    try {
      server._address = server._isPipe ? server._path : cottontail.tcpSocketAddress?.(server._fd, false);
    } catch {
      server._address = server._isPipe ? server._path : null;
    }
    server.listening = true;
    server._acceptTimer = setInterval(() => server._acceptPending(), 1);
    queueMicrotask(() => server.emit("listening"));
    return server;
  }

  _acceptPending() {
    if (!this.listening || this._fd == null) return;
    for (;;) {
      if (!this.listening || this._fd == null) return;
      let accepted;
      try {
        accepted = this._isPipe ? cottontail.unixServerAccept(this._fd) : cottontail.tcpServerAccept(this._fd);
      } catch (error) {
        this.emit("error", error);
        return;
      }
      if (accepted == null) return;
      const remoteAddress = accepted.remote?.address;
      const remoteFamilyNumber = isIP(remoteAddress);
      const blocked = remoteFamilyNumber !== 0 && this.blockList?.check(remoteAddress, `ipv${remoteFamilyNumber}`);
      const overLimit = this.maxConnections != null && this[kConnectionCount] >= Number(this.maxConnections);
      if (blocked || overLimit) {
        try { cottontail.closeFd?.(accepted.fd); } catch {}
        const familyName = (value, address) => String(value ?? (String(address ?? "").includes(":") ? "IPv6" : "IPv4")).replace(/^ipv/i, "IPv");
        this.emit("drop", {
          localAddress: accepted.local?.address ?? this._address?.address,
          localPort: accepted.local?.port ?? this._address?.port,
          localFamily: familyName(accepted.local?.family, accepted.local?.address ?? this._address?.address),
          remoteAddress: accepted.remote?.address,
          remotePort: accepted.remote?.port,
          remoteFamily: familyName(accepted.remote?.family, accepted.remote?.address),
        });
        continue;
      }
      const socketOptions = {
        fd: accepted.fd,
        local: accepted.local,
        remote: accepted.remote,
        pipe: this._isPipe,
        path: this._path,
        allowHalfOpen: this.allowHalfOpen,
        pauseOnConnect: this.pauseOnConnect,
        keepAlive: this.keepAlive,
        keepAliveInitialDelay: this.keepAliveInitialDelay,
        noDelay: this.noDelay,
        highWaterMark: this.highWaterMark,
      };
      let socket;
      try {
        socket = this._createAcceptedSocket(accepted, socketOptions);
      } catch (error) {
        try { cottontail.closeFd?.(accepted.fd); } catch {}
        this.emit("error", error);
        continue;
      }
      if (socket == null) continue;
      socket.server = this;
      socket.isServer = true;
      this._incrementConnections();
      socket.once("close", () => this._decrementConnections());
      this.emit("connection", socket);
      if (!this.pauseOnConnect) socket.resume();
    }
  }

  close(callback = undefined) {
    if (callback !== undefined && typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    const wasRunning = this._fd != null || this.listening;
    if (callback) {
      if (wasRunning) this.once("close", callback);
      else if (this._closeEmitted) queueMicrotask(() => callback(makeNodeError(Error, "Server is not running.", "ERR_SERVER_NOT_RUNNING")));
      else this.once("close", () => callback(makeNodeError(Error, "Server is not running.", "ERR_SERVER_NOT_RUNNING")));
    }
    this._closePending = true;
    if (this._acceptTimer) {
      clearInterval(this._acceptTimer);
      this._acceptTimer = null;
    }
    if (this._fd != null) {
      try { cottontail.closeFd?.(this._fd); } catch {}
      this._fd = null;
    }
    if (this._isPipe && this._path) {
      try { cottontail.unlinkSync?.(this._path); } catch {}
    }
    this.listening = false;
    this._address = null;
    this._emitCloseIfDrained();
    return this;
  }

  address() {
    if (!this.listening || this._fd == null) return null;
    if (this._isPipe) return this._address;
    if (!this._address) return null;
    const address = this._address.address ?? "0.0.0.0";
    const rawFamily = this._address.family;
    const family = rawFamily != null
      ? String(rawFamily).replace(/^ipv/i, "IPv")
      : (String(address).includes(":") ? "IPv6" : "IPv4");
    return { address, family, port: Number(this._address.port ?? 0) };
  }
  getConnections(callback) {
    if (callback !== undefined && typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    if (callback) callback(null, this.listening ? this[kConnectionCount] : 0);
    return this;
  }
  ref() {
    this._unref = false;
    this._acceptTimer?.ref?.();
    return this;
  }
  unref() {
    this._unref = true;
    this._acceptTimer?.unref?.();
    return this;
  }

  [ensureAsyncDisposeSymbol()]() {
    return new Promise((resolve, reject) => this.close((error) => error ? reject(error) : resolve()));
  }
}

Object.defineProperty(ServerImpl, "name", { value: "Server", configurable: true });
Object.defineProperty(ServerImpl, "length", { value: 2, configurable: true });
export const Server = new Proxy(ServerImpl, {
  apply(target, _thisArg, args) {
    return Reflect.construct(target, args);
  },
});

export class TCP {
  constructor(native = {}) {
    this.fd = native.fd == null ? null : Number(native.fd);
    this.reading = false;
    this.onconnection = null;
    this.owner = null;
    this._address = native.address ?? native.local ?? null;
    this._remote = native.remote ?? null;
    this._acceptTimer = null;
  }

  bind(address = "0.0.0.0", port = 0) {
    if (this.fd != null) this.close();
    const native = cottontail.tcpServerListen(Number(port ?? 0), String(address || "0.0.0.0"), 4);
    this.fd = Number(native.fd);
    this._address = native.address ?? null;
    return 0;
  }

  bind6(address = "::", port = 0) {
    if (this.fd != null) this.close();
    const native = cottontail.tcpServerListen(Number(port ?? 0), String(address || "::"), 6);
    this.fd = Number(native.fd);
    this._address = native.address ?? null;
    return 0;
  }

  listen() {
    if (this.fd == null || this._acceptTimer != null) return 0;
    this.reading = true;
    this._acceptTimer = setInterval(() => this._acceptPending(), 1);
    return 0;
  }

  _acceptPending() {
    if (this.fd == null) return;
    for (;;) {
      let accepted;
      try {
        accepted = cottontail.tcpServerAccept(this.fd);
      } catch (error) {
        if (typeof this.onconnection === "function") this.onconnection(error);
        return;
      }
      if (accepted == null) return;
      const client = new TCP({ fd: accepted.fd, local: accepted.local, remote: accepted.remote });
      if (typeof this.onconnection === "function") this.onconnection(0, client);
      else cottontail.closeFd?.(accepted.fd);
    }
  }

  open(fd) {
    this.fd = Number(fd);
    return 0;
  }

  close(callback = undefined) {
    if (this._acceptTimer != null) {
      clearInterval(this._acceptTimer);
      this._acceptTimer = null;
    }
    this.reading = false;
    if (this.fd != null) {
      try { cottontail.closeFd?.(this.fd); } catch {}
      this.fd = null;
    }
    if (typeof callback === "function") queueMicrotask(callback);
  }

  ref() {
    this._acceptTimer?.ref?.();
    return this;
  }
  unref() {
    this._acceptTimer?.unref?.();
    return this;
  }
  hasRef() {
    return this._acceptTimer?.hasRef?.() ?? true;
  }

  getsockname(out = {}) {
    const address = this._address ?? (this.fd == null ? null : cottontail.tcpSocketAddress?.(this.fd, false));
    if (address) {
      out.address = address.address ?? "0.0.0.0";
      out.family = String(address.family ?? (String(out.address).includes(":") ? "IPv6" : "IPv4")).replace(/^ipv/i, "IPv");
      out.port = Number(address.port ?? 0);
    }
    return 0;
  }

  getpeername(out = {}) {
    const address = this._remote ?? (this.fd == null ? null : cottontail.tcpSocketAddress?.(this.fd, true));
    if (address) {
      out.address = address.address ?? "";
      out.family = String(address.family ?? (String(out.address).includes(":") ? "IPv6" : "IPv4")).replace(/^ipv/i, "IPv");
      out.port = Number(address.port ?? 0);
    }
    return 0;
  }

  setKeepAlive(enable = false, initialDelay = 0) {
    if (this.fd != null && typeof cottontail.tcpSocketSetKeepAlive === "function") {
      cottontail.tcpSocketSetKeepAlive(this.fd, Boolean(enable), Number(initialDelay) || 0);
    }
    return 0;
  }

  setNoDelay(noDelay = true) {
    if (this.fd != null && typeof cottontail.tcpSocketSetNoDelay === "function") {
      cottontail.tcpSocketSetNoDelay(this.fd, Boolean(noDelay));
    }
    return 0;
  }

  readStart() {
    this.reading = true;
    return 0;
  }

  readStop() {
    this.reading = false;
    return 0;
  }

  reset() {
    this.close();
    return 0;
  }
}

export const Stream = Socket;

function strictAddressFamily(value, name = "family") {
  if (typeof value !== "string") throw invalidArgType(name, "of type string", value);
  const family = value.toLowerCase();
  if (family !== "ipv4" && family !== "ipv6") throw invalidArgValue(name, value);
  return family;
}

function ipv6ToBigInt(input) {
  let text = String(input);
  if (text.length === 0 || text.includes("%")) return null;
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".") && lastColon >= 0) {
    const ipv4 = text.slice(lastColon + 1);
    const number = ipv4ToNumber(ipv4);
    if (number == null) return null;
    text = `${text.slice(0, lastColon)}:${((number >>> 16) & 0xffff).toString(16)}:${(number & 0xffff).toString(16)}`;
  }
  const compression = text.indexOf("::");
  if (compression !== -1 && text.indexOf("::", compression + 1) !== -1) return null;
  const head = (compression === -1 ? text : text.slice(0, compression)).split(":").filter(Boolean);
  const tail = (compression === -1 ? "" : text.slice(compression + 2)).split(":").filter(Boolean);
  if (head.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group)) || tail.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) return null;
  const missing = 8 - head.length - tail.length;
  if ((compression === -1 && missing !== 0) || (compression !== -1 && missing < 1)) return null;
  const groups = compression === -1 ? head : [...head, ...Array(missing).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const group of groups) result = (result << 16n) | BigInt(`0x${group}`);
  return result;
}

function bigIntToIPv6(value) {
  const groups = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(Number((value >> shift) & 0xffffn).toString(16));
  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== "0") { index += 1; continue; }
    let end = index + 1;
    while (end < groups.length && groups[end] === "0") end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart < 0) return groups.join(":");
  const before = groups.slice(0, bestStart).join(":");
  const after = groups.slice(bestStart + bestLength).join(":");
  return `${before}::${after}`;
}

function mappedIPv4(value) {
  return (value >> 32n) === 0xffffn ? Number(value & 0xffffffffn) >>> 0 : null;
}

function addressRecord(value, family = undefined, name = "address", throwOnInvalid = true) {
  if (SocketAddress.isSocketAddress(value)) return kSocketAddressState.get(value);
  if (typeof value !== "string") throw invalidArgType(name, "of type string", value);
  const normalizedFamily = strictAddressFamily(family === undefined ? "ipv4" : family, "family");
  if (normalizedFamily === "ipv4") {
    const number = ipv4ToNumber(value);
    if (number != null) return { address: value, canonical: value, family: "ipv4", value: BigInt(number), comparableFamily: "ipv4", comparableValue: BigInt(number), port: 0, flowlabel: 0 };
  } else {
    const number = ipv6ToBigInt(value);
    if (number != null) {
      const mapped = mappedIPv4(number);
      return {
        address: value,
        canonical: bigIntToIPv6(number),
        family: "ipv6",
        value: number,
        comparableFamily: mapped == null ? "ipv6" : "ipv4",
        comparableValue: mapped == null ? number : BigInt(mapped),
        port: 0,
        flowlabel: 0,
      };
    }
  }
  if (!throwOnInvalid) return null;
  throw invalidArgValue(`options.${name}`, value, "is not a valid IP address");
}

function compareAddressRecords(left, right) {
  if (left.comparableFamily !== right.comparableFamily) return null;
  return left.comparableValue < right.comparableValue ? -1 : left.comparableValue > right.comparableValue ? 1 : 0;
}

export class BlockList {
  constructor() {
    kBlockListState.set(this, []);
  }

  static isBlockList(value) {
    return kBlockListState.has(value);
  }

  get rules() {
    const rules = kBlockListState.get(this);
    if (rules == null) throw invalidArgType("this", "an instance of BlockList", this);
    return rules.map((rule) => {
      const family = rule.family === "ipv6" ? "IPv6" : "IPv4";
      if (rule.kind === "address") return `Address: ${family} ${rule.address.canonical}`;
      if (rule.kind === "range") return `Range: ${family} ${rule.start.canonical}-${rule.end.canonical}`;
      return `Subnet: ${family} ${rule.network.canonical}/${rule.prefix}`;
    });
  }

  addAddress(address, family = "ipv4") {
    const record = addressRecord(address, family, "address");
    kBlockListState.get(this).unshift({ kind: "address", family: record.family, address: record });
  }

  addRange(start, end, family = "ipv4") {
    const startRecord = addressRecord(start, family, "start");
    const endRecord = addressRecord(end, family, "end");
    const comparison = compareAddressRecords(startRecord, endRecord);
    if (comparison == null || comparison > 0) throw invalidArgValue("start", start, "must come before end");
    kBlockListState.get(this).unshift({ kind: "range", family: startRecord.family, start: startRecord, end: endRecord });
  }

  addSubnet(network, prefix, family = "ipv4") {
    const record = addressRecord(network, family, "network");
    if (typeof prefix !== "number") throw invalidArgType("prefix", "of type number", prefix);
    const maximum = record.family === "ipv6" ? 128 : 32;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximum) throw outOfRange("prefix", `>= 0 && <= ${maximum}`, prefix);
    kBlockListState.get(this).unshift({ kind: "subnet", family: record.family, network: record, prefix });
  }

  check(address, family = "ipv4") {
    const record = addressRecord(address, family, "address", false);
    if (record == null) return false;
    for (const rule of kBlockListState.get(this)) {
      if (rule.kind === "address" && compareAddressRecords(record, rule.address) === 0) return true;
      if (rule.kind === "range") {
        const start = compareAddressRecords(record, rule.start);
        const end = compareAddressRecords(record, rule.end);
        if (start != null && end != null && start >= 0 && end <= 0) return true;
      }
      if (rule.kind === "subnet" && record.comparableFamily === rule.network.comparableFamily) {
        const bits = record.comparableFamily === "ipv6" ? 128 : 32;
        const prefix = rule.network.comparableFamily === rule.family ? rule.prefix : Math.max(0, rule.prefix - 96);
        const shift = BigInt(bits - prefix);
        if ((record.comparableValue >> shift) === (rule.network.comparableValue >> shift)) return true;
      }
    }
    return false;
  }

  [Symbol.for("cottontail.structuredClone")]() {
    return this;
  }
}

export class SocketAddress {
  constructor(options = undefined) {
    if (options === undefined) options = {};
    if (options === null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
    const family = options.family === undefined ? "ipv4" : strictAddressFamily(options.family, "options.family");
    const address = options.address === undefined ? (family === "ipv6" ? "::" : "127.0.0.1") : options.address;
    if (typeof address !== "string") throw invalidArgType("options.address", "of type string", address);
    const record = addressRecord(address, family, "address");
    const port = options.port === undefined ? 0 : validatePort(options.port);
    const flowlabel = options.flowlabel === undefined ? 0 : options.flowlabel;
    if (typeof flowlabel !== "number") throw invalidArgType("options.flowlabel", "of type number", flowlabel);
    if (!Number.isInteger(flowlabel) || flowlabel < 0 || flowlabel > 0xffffffff) throw outOfRange("options.flowlabel", ">= 0 && <= 4294967295", flowlabel);
    kSocketAddressState.set(this, { ...record, address, port, flowlabel: family === "ipv6" ? flowlabel : 0 });
  }

  static isSocketAddress(value) {
    return kSocketAddressState.has(value) && Object.getPrototypeOf(value) === SocketAddress.prototype;
  }

  static parse(input) {
    if (typeof input !== "string") throw invalidArgType("input", "of type string", input);
    try {
      const url = new URL(`http://${input}`);
      let address = url.hostname;
      const port = url.port === "" ? 0 : Number(url.port);
      if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
      const family = isIPv6(address) ? "ipv6" : isIPv4(address) ? "ipv4" : null;
      if (family == null) return undefined;
      if (family === "ipv6") address = bigIntToIPv6(ipv6ToBigInt(address));
      return new SocketAddress({ address, port, family });
    } catch {
      return undefined;
    }
  }

  get address() { return kSocketAddressState.get(this).address; }
  get port() { return kSocketAddressState.get(this).port; }
  get family() { return kSocketAddressState.get(this).family; }
  get flowlabel() { return kSocketAddressState.get(this).flowlabel; }

  toJSON() {
    return { address: this.address, port: this.port, family: this.family, flowlabel: this.flowlabel };
  }
}

export function connect(...args) {
  const [options] = _normalizeArgs(args);
  return new Socket(options).connect(...args);
}

export const createConnection = connect;

export function createServer(options = {}, connectionListener = undefined) {
  return new Server(options, connectionListener);
}

export function _normalizeArgs(args) {
  const list = Array.from(args ?? []);
  let options = {};
  const callback = typeof list[list.length - 1] === "function" ? list.pop() : undefined;
  if (typeof list[0] === "object" && list[0] !== null) options = { ...list[0] };
  else if (typeof list[0] === "string") {
    const numeric = Number(list[0]);
    if (list[0].trim() !== "" && Number.isFinite(numeric) && numeric >= 0) {
      options.port = list[0];
      if (typeof list[1] === "string") options.host = list[1];
      else if (typeof list[1] === "number") options.backlog = list[1];
      if (typeof list[2] === "number") options.backlog = list[2];
    } else {
      options.path = list[0];
      if (typeof list[1] === "number") options.backlog = list[1];
    }
  }
  else {
    options.port = list[0];
    if (typeof list[1] === "string") options.host = list[1];
    else if (typeof list[1] === "number") options.backlog = list[1];
    if (typeof list[2] === "number") options.backlog = list[2];
  }
  return [options, callback];
}

export function _createServerHandle(address = "0.0.0.0", port = 0, addressType = 4, fd = -1, flags = 0) {
  void flags;
  const handle = new TCP();
  if (fd != null && Number(fd) >= 0) {
    handle.open(Number(fd));
    return handle;
  }
  const family = Number(addressType) === 6 ? 6 : 4;
  const bindAddress = address == null || address === "" ? (family === 6 ? "::" : "0.0.0.0") : String(address);
  try {
    if (family === 6) handle.bind6(bindAddress, port);
    else handle.bind(bindAddress, port);
    return handle;
  } catch (error) {
    return Number(error?.errno ?? error?.code) || -1;
  }
}

let defaultAutoSelectFamily = true;
let defaultAutoSelectFamilyAttemptTimeout = 250;

export function getDefaultAutoSelectFamily() {
  return defaultAutoSelectFamily;
}

export function setDefaultAutoSelectFamily(value) {
  if (typeof value !== "boolean") throw invalidArgType("value", "of type boolean", value);
  defaultAutoSelectFamily = value;
}

export function getDefaultAutoSelectFamilyAttemptTimeout() {
  return defaultAutoSelectFamilyAttemptTimeout;
}

export function setDefaultAutoSelectFamilyAttemptTimeout(value) {
  if (typeof value !== "number") throw invalidArgType("value", "of type number", value);
  if (!Number.isInteger(value) || value < 1) throw outOfRange("value", ">= 1", value);
  defaultAutoSelectFamilyAttemptTimeout = Math.max(10, value);
}

let warnedSimultaneousAccepts = false;
export function _setSimultaneousAccepts() {
  if (warnedSimultaneousAccepts) return;
  warnedSimultaneousAccepts = true;
  process.emitWarning?.(
    "net._setSimultaneousAccepts() is deprecated and will be removed.",
    "DeprecationWarning",
    "DEP0121",
  );
}

export function isIPv4(input) {
  const parts = String(input).split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    // No empty octets, no leading zeros, 0-255 only.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

function ipv6GroupCount(text, allowTrailingIPv4) {
  if (text === "") return 0;
  const groups = text.split(":");
  let count = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (/^[0-9a-fA-F]{1,4}$/.test(group)) {
      count += 1;
      continue;
    }
    if (allowTrailingIPv4 && index === groups.length - 1 && isIPv4(group)) {
      count += 2;
      continue;
    }
    return -1;
  }
  return count;
}

export function isIPv6(input) {
  const text = String(input);
  if (text.length === 0) return false;
  const compressionIndex = text.indexOf("::");
  if (compressionIndex !== -1 && text.indexOf("::", compressionIndex + 1) !== -1) return false;
  if (compressionIndex === -1) {
    return ipv6GroupCount(text, true) === 8;
  }
  const headCount = ipv6GroupCount(text.slice(0, compressionIndex), false);
  const tailCount = ipv6GroupCount(text.slice(compressionIndex + 2), true);
  if (headCount < 0 || tailCount < 0) return false;
  // "::" always stands in for at least one 16-bit group.
  return headCount + tailCount <= 7;
}

export function isIP(input) {
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
}

// COTTONTAIL-COMPAT: Native transport gaps are cancellable/asynchronous TCP connect attempts,
// local-address binding, listener backlog/ipv6Only/reusePort controls, watcher ref/unref, and TCP RST.

export default {
  BlockList,
  Server,
  Socket,
  SocketAddress,
  Stream,
  TCP,
  _createServerHandle,
  _normalizeArgs,
  _setSimultaneousAccepts,
  connect,
  createConnection,
  createServer,
  getDefaultAutoSelectFamily,
  getDefaultAutoSelectFamilyAttemptTimeout,
  isIP,
  isIPv4,
  isIPv6,
  setDefaultAutoSelectFamily,
  setDefaultAutoSelectFamilyAttemptTimeout,
};
