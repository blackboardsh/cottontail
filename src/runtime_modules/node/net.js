import { EventEmitter } from "./events.js";

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
  if (encoding) return new TextDecoder().decode(view);
  return globalThis.Buffer?.from ? globalThis.Buffer.from(view) : view;
}

function ipv4ToNumber(input) {
  if (!isIPv4(input)) return null;
  return String(input).split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function normalizeFamily(family = "ipv4") {
  const text = String(family).toLowerCase();
  return text === "ipv6" || text === "6" ? "ipv6" : "ipv4";
}

export class Socket extends EventEmitter {
  constructor(options = {}) {
    super();
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
    this.bytesWritten = 0;
    this.timeout = undefined;
    this._timeoutValue = 0;
    this.allowHalfOpen = options.allowHalfOpen === true;
    this.writableHighWaterMark = Math.max(1, Math.min(Number(options.highWaterMark || 16 * 1024), 1024 * 1024));
    this.writableLength = 0;
    this.writableNeedDrain = false;
    this._encoding = null;
    this._timeoutTimer = null;
    this._watchId = 0;
    this._unregisterWatch = null;
    this._isPipe = options.pipe === true || options.path != null;
    this._path = options.path;
    this._paused = false;
    this._pendingData = [];
    this._pendingEnd = false;
    this._pendingWrites = [];
    this._outboundWrites = [];
    this._writeRetryTimer = null;
    this._drainQueued = false;
    this._ending = false;
    this._endEmitted = false;
    this._finishEmitted = false;
    this._pipes = new Map();
    if (this.fd != null) this._attachFd(this.fd, options.local, options.remote, true);
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

  _attachFd(fd, local = undefined, remote = undefined, connected = false) {
    this.fd = Number(fd);
    this.destroyed = false;
    this.readable = true;
    this.writable = true;
    this._setAddressInfo(local, remote);
    if (connected) {
      this.connecting = false;
      queueMicrotask(() => {
        this._flushPendingWrites();
        this.emit("connect");
        this._startRead();
        this._refreshTimeout();
      });
      return this;
    }
    this._startRead();
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
      this.write(entry.chunk, entry.encoding, entry.callback);
    }
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
        this.bytesWritten += count;
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
    if (this._unregisterWatch) {
      this._unregisterWatch();
      this._unregisterWatch = null;
    }
    if (this._watchId) {
      cottontail.fdWatchStop?.(this._watchId);
      this._watchId = 0;
    }
  }

  _emitData(chunk) {
    if (this._paused || this._pendingData.length > 0) {
      this._pendingData.push(chunk);
      if (!this._paused) queueMicrotask(() => this._flushPendingData());
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
    if (!this.allowHalfOpen) this.destroy();
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

  _startRead() {
    if (this.fd == null || this.destroyed || this._watchId || typeof cottontail.fdWatchStart !== "function") return this;
    const fdWatchListeners = installFdWatchDispatcher();
    const watch = cottontail.fdWatchStart(this.fd, 1024 * 1024);
    this._watchId = Number(watch?.id || 0);
    if (!this._watchId) return this;
    fdWatchListeners.set(this._watchId, (event) => {
      if (this.destroyed) return;
      if (event.type === "data") {
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
    });
    this._unregisterWatch = () => {
      if (fdWatchListeners.get(this._watchId)) fdWatchListeners.delete(this._watchId);
    };
    return this;
  }

  connect(...args) {
    const [options, callback] = _normalizeArgs(args);
    if (callback) this.once("connect", callback);
    this.connecting = true;
    queueMicrotask(() => {
      try {
        let host = options.host ?? "127.0.0.1";
        // Connecting to a wildcard address targets the local host.
        if (host === "0.0.0.0") host = "127.0.0.1";
        else if (host === "::") host = "::1";
        const result = options.path != null
          ? cottontail.unixSocketConnect(String(options.path))
          : cottontail.tcpSocketConnect(Number(options.port), host, Number(options.family ?? 4));
        this._isPipe = options.path != null;
        this._path = options.path;
        this._attachFd(result.fd, result.local, result.remote, true);
      } catch (rawError) {
        const error = rawError instanceof Error ? rawError : new Error(String(rawError));
        if (error.code == null) {
          const text = String(error.message);
          if (/refused|ECONNREFUSED/i.test(text)) error.code = "ECONNREFUSED";
          else if (/(not known|not found|ENOTFOUND|nodename|no address)/i.test(text)) error.code = "ENOTFOUND";
          else if (/timed? ?out|ETIMEDOUT/i.test(text)) error.code = "ETIMEDOUT";
        }
        this.connecting = false;
        this.destroy(error);
      }
    });
    return this;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this.connecting && this.fd == null && !this.destroyed && this.writable) {
      this._pendingWrites.push({ chunk, encoding, callback });
      return true;
    }
    if (this.destroyed || this.fd == null || !this.writable) {
      const error = new Error("Socket is closed");
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      this.emit("error", error);
      return false;
    }
    const bytes = bytesFrom(chunk, encoding);
    this.writableLength += bytes.byteLength;
    this._outboundWrites.push({ bytes, offset: 0, callback });
    const overHighWaterMark = this.writableLength >= this.writableHighWaterMark;
    if (overHighWaterMark) this.writableNeedDrain = true;
    this._flushOutboundWrites();
    return !overHighWaterMark;
  }

  _maybeEmitFinish() {
    if (!this._ending || this._finishEmitted || this._outboundWrites.length > 0) return;
    this._finishEmitted = true;
    this.emit("finish");
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
    if (this._ending) return this;
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
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable = false;
    this.writable = false;
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
    this.emit("close", Boolean(error));
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
    if (!this._isPipe && this.fd != null && typeof cottontail.tcpSocketSetKeepAlive === "function") {
      cottontail.tcpSocketSetKeepAlive(this.fd, Boolean(enable), Number(initialDelay) || 0);
    }
    return this;
  }
  setNoDelay(noDelay = true) {
    if (!this._isPipe && this.fd != null && typeof cottontail.tcpSocketSetNoDelay === "function") {
      cottontail.tcpSocketSetNoDelay(this.fd, Boolean(noDelay));
    }
    return this;
  }
  setTimeout(timeout, callback) {
    this._timeoutValue = Number(timeout) || 0;
    this.timeout = this._timeoutValue;
    if (typeof callback === "function") this.once("timeout", callback);
    this._refreshTimeout();
    return this;
  }
  pause() {
    this._paused = true;
    return this;
  }
  resume() {
    this._paused = false;
    this._flushPendingData();
    return this;
  }
  setDefaultEncoding(encoding = "utf8") { return this.setEncoding(encoding); }
  destroySoon() { return this.end(); }
  resetAndDestroy() { return this.destroy(); }
  ref() { return this; }
  unref() { return this; }

  get pending() { return this.connecting; }
  get readyState() {
    if (this.connecting) return "opening";
    if (this.destroyed) return "closed";
    if (this.readable && this.writable) return "open";
    if (this.readable) return "readOnly";
    if (this.writable) return "writeOnly";
    return "closed";
  }
}

export class Server extends EventEmitter {
  constructor(options = {}, connectionListener = undefined) {
    super();
    if (typeof options === "function") {
      connectionListener = options;
      options = {};
    }
    this.listening = false;
    this.connections = 0;
    this.maxConnections = undefined;
    this._options = options ?? {};
    this._fd = null;
    this._address = null;
    this._path = null;
    this._isPipe = false;
    this._acceptTimer = null;
    if (typeof connectionListener === "function") this.on("connection", connectionListener);
  }

  listen(...args) {
    const [options, callback] = _normalizeArgs(args);
    if (callback) this.once("listening", callback);
    try {
      const result = options.path != null
        ? cottontail.unixServerListen(String(options.path), Number(options.backlog ?? 128))
        : cottontail.tcpServerListen(Number(options.port ?? 0), options.host ?? "0.0.0.0", Number(options.family ?? 4));
      this._fd = Number(result.fd);
      this._isPipe = options.path != null;
      this._path = this._isPipe ? String(result.path ?? options.path) : null;
      this._address = this._isPipe ? this._path : result.address ?? null;
      this.listening = true;
      this._acceptTimer = setInterval(() => this._acceptPending(), 1);
      queueMicrotask(() => {
        let host = this._isPipe ? this._path : this._address?.address;
        // Report a connectable hostname for wildcard binds; server.address()
        // still exposes the real bound address.
        if (host === "0.0.0.0") host = "127.0.0.1";
        else if (host === "::") host = "::1";
        this.emit("listening", undefined, host, this._isPipe ? undefined : this._address?.port);
      });
    } catch (rawError) {
      const error = rawError instanceof Error ? rawError : new Error(String(rawError));
      if (error.code == null && /(in use|EADDRINUSE)/i.test(String(error.message))) {
        error.code = "EADDRINUSE";
        error.errno = -48;
        error.syscall = "listen";
        if (!this._isPipe) {
          error.address = options.host ?? "0.0.0.0";
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
      let accepted;
      try {
        accepted = this._isPipe ? cottontail.unixServerAccept(this._fd) : cottontail.tcpServerAccept(this._fd);
      } catch (error) {
        this.emit("error", error);
        return;
      }
      if (accepted == null) return;
      if (this.maxConnections != null && this.connections >= Number(this.maxConnections)) {
        try { cottontail.closeFd?.(accepted.fd); } catch {}
        this.emit("drop", accepted);
        continue;
      }
      const socket = new Socket({ fd: accepted.fd, local: accepted.local, remote: accepted.remote, pipe: this._isPipe, path: this._path });
      this.connections += 1;
      socket.once("close", () => {
        if (this.connections > 0) this.connections -= 1;
      });
      this.emit("connection", socket);
    }
  }

  close(callback = undefined) {
    if (callback) this.once("close", callback);
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
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  address() {
    if (this._isPipe) return this._address;
    if (!this._address) return null;
    const address = this._address.address ?? "0.0.0.0";
    const rawFamily = this._address.family;
    const family = rawFamily != null
      ? String(rawFamily).replace(/^ipv/i, "IPv")
      : (String(address).includes(":") ? "IPv6" : "IPv4");
    return { address, family, port: Number(this._address.port ?? 0) };
  }
  getConnections(callback) { callback(null, this.connections); }
  ref() {
    this._acceptTimer?.ref?.();
    return this;
  }
  unref() {
    this._acceptTimer?.unref?.();
    return this;
  }

  [ensureAsyncDisposeSymbol()]() {
    return new Promise((resolve) => this.close(() => resolve()));
  }
}

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

export class BlockList {
  constructor() {
    this.rules = [];
  }

  addAddress(address, type = "ipv4") {
    this.rules.push(`Address: ${String(address)}/${normalizeFamily(type)}`);
  }

  addRange(start, end, type = "ipv4") {
    this.rules.push(`Range: ${String(start)}-${String(end)}/${normalizeFamily(type)}`);
  }

  addSubnet(net, prefix, type = "ipv4") {
    this.rules.push(`Subnet: ${String(net)}/${Number(prefix)}/${normalizeFamily(type)}`);
  }

  check(address, type = "ipv4") {
    const family = normalizeFamily(type);
    const value = family === "ipv4" ? ipv4ToNumber(address) : String(address);
    for (const rule of this.rules) {
      if (!rule.endsWith(`/${family}`) && !rule.includes(`/${family}`)) continue;
      if (rule.startsWith("Address: ")) {
        const target = rule.slice("Address: ".length).split("/")[0];
        if (String(address) === target) return true;
      } else if (family === "ipv4" && rule.startsWith("Range: ") && value != null) {
        const [start, end] = rule.slice("Range: ".length).split("/")[0].split("-");
        const startValue = ipv4ToNumber(start);
        const endValue = ipv4ToNumber(end);
        if (startValue != null && endValue != null && value >= startValue && value <= endValue) return true;
      } else if (family === "ipv4" && rule.startsWith("Subnet: ") && value != null) {
        const [net, prefixText] = rule.slice("Subnet: ".length).split("/");
        const netValue = ipv4ToNumber(net);
        const prefix = Number(prefixText);
        const mask = prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        if (netValue != null && (value & mask) === (netValue & mask)) return true;
      }
    }
    return false;
  }
}

export class SocketAddress {
  constructor(options = {}) {
    this.address = String(options.address ?? (options.family === "ipv6" || options.family === 6 ? "::" : "127.0.0.1"));
    this.port = Number(options.port ?? 0);
    this.family = normalizeFamily(options.family ?? (this.address.includes(":") ? "ipv6" : "ipv4"));
    this.flowlabel = Number(options.flowlabel ?? 0);
  }

  static parse(input) {
    const text = String(input);
    const ipv6 = text.match(/^\[([^\]]+)\]:(\d+)$/);
    if (ipv6) return new SocketAddress({ address: ipv6[1], port: Number(ipv6[2]), family: "ipv6" });
    const ipv4 = text.match(/^([^:]+):(\d+)$/);
    if (ipv4) return new SocketAddress({ address: ipv4[1], port: Number(ipv4[2]), family: ipv4[1].includes(":") ? "ipv6" : "ipv4" });
    return undefined;
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
    options.path = list[0];
    if (typeof list[1] === "number") options.backlog = list[1];
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

let defaultAutoSelectFamily = false;
let defaultAutoSelectFamilyAttemptTimeout = 250;

export function getDefaultAutoSelectFamily() {
  return defaultAutoSelectFamily;
}

export function setDefaultAutoSelectFamily(value) {
  defaultAutoSelectFamily = Boolean(value);
}

export function getDefaultAutoSelectFamilyAttemptTimeout() {
  return defaultAutoSelectFamilyAttemptTimeout;
}

export function setDefaultAutoSelectFamilyAttemptTimeout(value) {
  defaultAutoSelectFamilyAttemptTimeout = Number(value);
}

export function isIPv4(input) {
  const parts = String(input).split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

export function isIPv6(input) {
  return String(input).includes(":");
}

export function isIP(input) {
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
}

export default {
  BlockList,
  Server,
  Socket,
  SocketAddress,
  Stream,
  TCP,
  _createServerHandle,
  _normalizeArgs,
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
