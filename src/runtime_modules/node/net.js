import { EventEmitter } from "./events.js";
import { _wrapAsyncCallback } from "./async_hooks.js";
import { Duplex } from "./stream.js";
import * as nodeConstants from "./constants.js";

const kConnectionCount = Symbol("connectionCount");
// Allow a stock-JSC host-loop turn for bytes racing a graceful destroy to
// be consumed before close(2), which otherwise converts the FIN into a reset.
const gracefulDestroyDrainMilliseconds = 16;
const kSocketAddressState = new WeakMap();
const kSocketAddressReadonlyProperties = new Set(["address", "port", "family", "flowlabel"]);
const kBlockListState = new WeakMap();

class TCPConnectWrap {}

const heapObjectRefs = globalThis.__cottontailHeapObjectRefs ??= new Map();
const heapObjectCountProviders = globalThis.__cottontailHeapObjectCountProviders ??= new Map();
const heapObjectFinalizer = globalThis.__cottontailHeapObjectFinalizer ??= typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ refs, ref }) => refs.delete(ref))
  : null;

function trackedHeapObjectCount(type) {
  const refs = heapObjectRefs.get(type);
  if (refs == null) return 0;
  let count = 0;
  for (const ref of refs) {
    const value = ref.deref();
    if (value == null) {
      refs.delete(ref);
      continue;
    }
    const active = type === "Listener"
      ? value.listening === true || value._fd != null
      : value.connecting === true || value.fd != null || value._tlsId != null || value._watchId !== 0;
    if (active) count += 1;
  }
  return count;
}

function trackHeapObject(type, value) {
  if (typeof WeakRef !== "function") return;
  let refs = heapObjectRefs.get(type);
  if (refs == null) heapObjectRefs.set(type, refs = new Set());
  const ref = new WeakRef(value);
  refs.add(ref);
  heapObjectFinalizer?.register(value, { refs, ref }, ref);
}

for (const type of ["Listener", "TCPSocket", "TLSSocket"]) {
  if (!heapObjectCountProviders.has(type)) {
    heapObjectCountProviders.set(type, () => trackedHeapObjectCount(type));
  }
}

function makeNodeError(ErrorType, message, code, details = undefined) {
  const error = new ErrorType(message);
  error.code = code;
  if (details) Object.assign(error, details);
  Object.defineProperty(error, "toString", {
    configurable: true,
    writable: true,
    value() {
      return `${this.name} [${this.code}]: ${this.message}`;
    },
  });
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
      const connectListener = globalThis.__cottontailTcpConnectListeners?.get?.(Number(event?.id));
      if (typeof connectListener === "function") {
        connectListener(event);
        return;
      }
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

function pendingConnectIdForAcceptedSocket(socket) {
  const localPort = Number(socket?.localPort);
  const localAddress = socket?.localAddress;
  if (!Number.isInteger(localPort) || typeof localAddress !== "string") return null;

  for (const listener of globalThis.__cottontailTcpConnectListeners?.values?.() ?? []) {
    const target = listener?.__cottontailConnectTarget;
    if (Number(target?.port) !== localPort || typeof target?.address !== "string") continue;
    if (target.address === localAddress) return target.id;

    const targetFamily = isIP(target.address);
    const localFamily = isIP(localAddress);
    if (targetFamily === 0 || localFamily === 0) continue;
    const targetRecord = addressRecord(target.address, `ipv${targetFamily}`, "address", false);
    const localRecord = addressRecord(localAddress, `ipv${localFamily}`, "address", false);
    if (targetRecord != null && localRecord != null && compareAddressRecords(targetRecord, localRecord) === 0) return target.id;
  }
  return null;
}

function startAcceptWatch(target, fd, referenced, onReadable, onError = (error) => target.emit("error", error)) {
  if (typeof cottontail.fdWatchStart !== "function" || typeof cottontail.fdWatchSetPaused !== "function") {
    return false;
  }

  const listeners = installFdWatchDispatcher();
  let watch;
  try {
    watch = cottontail.fdWatchStart(fd, 1, referenced, false, true);
  } catch {
    return false;
  }
  const watchId = Number(watch?.id || 0);
  if (!watchId) return false;

  target._acceptWatchId = watchId;
  listeners.set(watchId, _wrapAsyncCallback((event) => {
    if (target._acceptWatchId !== watchId) return;
    if (event.type === "readable") {
      try {
        onReadable();
      } finally {
        if (target._acceptWatchId === watchId) cottontail.fdWatchSetPaused(watchId, false);
      }
      return;
    }
    if (event.type === "error") {
      target._acceptWatchId = 0;
      target._unregisterAcceptWatch?.();
      target._unregisterAcceptWatch = null;
      const error = new Error(event.message || "socket listener failed");
      if (event.code != null) error.code = String(event.code);
      if (event.errno != null) error.errno = Number(event.errno);
      onError(error);
    }
  }));
  target._unregisterAcceptWatch = () => listeners.delete(watchId);
  return true;
}

function stopAcceptWatch(target) {
  const watchId = target._acceptWatchId;
  target._acceptWatchId = 0;
  target._unregisterAcceptWatch?.();
  target._unregisterAcceptWatch = null;
  if (watchId) cottontail.fdWatchStop?.(watchId);
  if (target._acceptTimer != null) {
    clearInterval(target._acceptTimer);
    target._acceptTimer = null;
  }
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
  ECONNREFUSED: -nodeConstants.ECONNREFUSED,
  ECONNRESET: -nodeConstants.ECONNRESET,
  EHOSTUNREACH: -nodeConstants.EHOSTUNREACH,
  ENETUNREACH: -nodeConstants.ENETUNREACH,
  ENOENT: -nodeConstants.ENOENT,
  ETIMEDOUT: -nodeConstants.ETIMEDOUT,
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
  if (typeof code === "string" && code.startsWith("ERR_")) return original;
  if (original.syscall === "getaddrinfo") {
    if (original.code == null && code != null) original.code = code;
    if (original.errno == null && code != null) original.errno = code;
    if (original.hostname == null) original.hostname = host;
    return original;
  }
  if (code === "ENOTFOUND") {
    const error = new Error(`getaddrinfo ENOTFOUND ${host}`);
    error.code = "ENOTFOUND";
    error.errno = original.errno ?? -3008;
    error.syscall = "getaddrinfo";
    error.hostname = original.hostname ?? host;
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

function errnoException(errno, syscall) {
  const normalized = Number(errno);
  let code;
  try {
    code = process.binding?.("uv")?.errname?.(normalized);
  } catch {}
  code ??= `Unknown system error ${normalized}`;
  const error = new Error(`${syscall} ${code}`);
  error.errno = normalized;
  error.code = code;
  error.syscall = syscall;
  return error;
}

class SocketImpl extends Duplex {
  constructor(options = {}) {
    if (options == null) options = {};
    if (typeof options !== "object") throw invalidArgType("options", "of type object", options);
    for (const name of ["objectMode", "readableObjectMode", "writableObjectMode"]) {
      if (options[name]) throw invalidArgValue(`options.${name}`, options[name], "is not supported");
    }
    if (options.fd !== undefined) {
      if (typeof options.fd !== "number") throw invalidArgType("options.fd", "of type number", options.fd);
      if (!Number.isInteger(options.fd) || options.fd < 0 || options.fd > 0x7fffffff) {
        throw outOfRange("options.fd", ">= 0 && <= 2147483647", options.fd);
      }
    }
    if (options.onread != null) {
      if (typeof options.onread !== "object") throw invalidArgType("options.onread", "of type object", options.onread);
      if (typeof options.onread.callback !== "function") throw invalidArgType("options.onread.callback", "of type function", options.onread.callback);
    }
    if (options.signal !== undefined) validateAbortSignal(options.signal);
    if (options.blockList !== undefined && !BlockList.isBlockList(options.blockList)) {
      throw invalidArgType("options.blockList", "an instance of net.BlockList", options.blockList);
    }
    const allowHalfOpen = options.allowHalfOpen === true;
    const writableHighWaterMark = normalizeHighWaterMark(options.writableHighWaterMark ?? options.highWaterMark);
    const readableHighWaterMark = normalizeHighWaterMark(options.readableHighWaterMark ?? options.highWaterMark);
    super({
      allowHalfOpen,
      readable: options.readable !== false,
      writable: options.writable !== false,
      readableHighWaterMark,
      writableHighWaterMark,
      emitClose: false,
      autoDestroy: true,
      decodeStrings: false,
    });
    trackHeapObject(new.target?.name === "TLSSocket" ? "TLSSocket" : "TCPSocket", this);
    this.fd = null;
    this.connecting = false;
    this.encrypted = false;
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
    this.allowHalfOpen = allowHalfOpen;
    this._encoding = null;
    this._timeoutTimer = null;
    this._watchId = 0;
    this._unregisterWatch = null;
    this._isPipe = options.pipe === true || options.path != null;
    this._path = options.path;
    this._paused = Boolean(options.pauseOnConnect || options.readable === false);
    this._pendingData = [];
    this._pendingEnd = false;
    this._pendingWrites = [];
    this._outboundWrites = [];
    this._writeRetryTimer = null;
    this._watchWriteOnly = false;
    this._nativeReadPaused = false;
    this._nativeShutdownSent = false;
    this._destroyImmediateRequested = false;
    this._readEndSignaled = false;
    this._nativeHandleTransferred = false;
    this._adoptedRawHandle = null;
    this._pendingFinalCallback = null;
    this._pendingFinalCleanup = null;
    this._destroyCloseTimer = null;
    this._destroyFinalize = null;
    this._ending = false;
    this._endEmitted = false;
    this._finishEmitted = false;
    this._closeEmitted = false;
    this._hadError = false;
    this._onread = options.onread && typeof options.onread === "object" && typeof options.onread.callback === "function"
      ? options.onread
      : null;
    this._abortSignal = null;
    this._abortListener = null;
    this._abortReason = undefined;
    this._connectAttemptIds = new Set();
    this._connectAttemptTimers = new Set();
    this._connectFailureTimer = null;
    this._connectGeneration = 0;
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
    this.on("end", () => {
      if (!this.allowHalfOpen && this.writable && !this.destroyed) this.end();
    });
    if (options.signal) this._setupAbortSignal(options.signal);
    if (options.handle != null) this._adoptHandle(options.handle, options);
    else if (options.fd != null) this._attachFd(options.fd, options.local, options.remote, false);
    if (this._paused) this.pause();
  }

  // Bun creates a detached socket handle as soon as connect() starts, before
  // DNS and the native connection attempt have produced an fd. Keep the
  // facade stable across that transition so internal consumers can attach to
  // the socket owner while the connection is still pending.
  get _handle() {
    if (this.__handleOverride !== undefined) return this.__handleOverride;
    if (this.fd == null && !this.connecting) return null;
    if (this.__handleWrap == null) {
      this.__handleWrap = {
        _owner: this,
        get fd() { return this._owner?.fd ?? -1; },
        get owner() { return this._owner; },
        set owner(value) { this._owner = value; },
        setNoDelay(value = true) { this._owner?.setNoDelay(value); return 0; },
        setKeepAlive(value = false, delay = 0) { this._owner?.setKeepAlive(value, Number(delay) * 1000); return 0; },
        close(callback) { this._owner?.destroy(); if (typeof callback === "function") queueMicrotask(callback); },
        ref() { this._owner?.ref(); },
        unref() { this._owner?.unref(); },
        hasRef() { return this._owner?._refed !== false; },
      };
    }
    return this.__handleWrap;
  }

  set _handle(value) {
    this.__handleOverride = value;
  }

  _adoptHandle(handle, options = {}) {
    if (handle == null || typeof handle !== "object") {
      throw invalidArgType("options.handle", "an object with a file descriptor", handle);
    }

    let fd = Number(handle.fd);
    let local = options.local;
    let remote = options.remote;
    const previousOwner = handle.owner;
    if (previousOwner instanceof SocketImpl && previousOwner !== this) {
      fd = previousOwner._releaseHandleForAdoption(handle);
      local ??= previousOwner._sockname ?? (previousOwner.localAddress == null ? undefined : {
        address: previousOwner.localAddress,
        port: previousOwner.localPort,
        family: previousOwner.localFamily,
      });
      remote ??= previousOwner._peername ?? (previousOwner.remoteAddress == null ? undefined : {
        address: previousOwner.remoteAddress,
        port: previousOwner.remotePort,
        family: previousOwner.remoteFamily,
      });
    }
    local ??= handle._address ?? handle.local;
    remote ??= handle._remote ?? handle.remote;
    if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) {
      throw invalidArgValue("options.handle", handle, "does not reference an open socket");
    }

    this.__handleWrap = handle;
    this.__handleOverride = undefined;
    try { handle.owner = this; } catch {}
    this._adoptedRawHandle = handle;
    this._attachFd(fd, local, remote, false);
  }

  _releaseHandleForAdoption(handle) {
    if (this.fd == null || (this.__handleWrap != null && this.__handleWrap !== handle)) {
      throw invalidArgValue("options.handle", handle, "does not reference this socket's open handle");
    }
    const fd = this.fd;
    this._stopRead();
    this._clearTimeoutTimer();
    this.fd = null;
    this._nativeHandleTransferred = true;
    this._destroyImmediateRequested = true;
    Duplex.prototype.destroy.call(this);
    return fd;
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
      // Node and Bun do not let an inactivity timeout keep the event loop alive.
      this._timeoutTimer.unref?.();
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
    this._nativeShutdownSent = false;
    this._nativeReadPaused = false;
    if (this._adoptedRawHandle && "fd" in this._adoptedRawHandle) {
      try { this._adoptedRawHandle.fd = this.fd; } catch {}
    }
    this._setAddressInfo(local, remote);
    this._applySocketOptions();
    if (emitConnect) {
      this.connecting = false;
      if (this.destroyed) return this;
      this._startRead();
      this._flushOutboundWrites();
      this.emit("connect");
      this._readyEmitted = true;
      this.emit("ready");
      this._refreshTimeout();
      return this;
    }
    if (!this._paused) this._startRead();
    this._refreshTimeout();
    return this;
  }

  _startWriteWatch() {
    if (this._watchId || this.fd == null || this.destroyed || typeof cottontail.fdWatchStart !== "function") return false;
    const fdWatchListeners = installFdWatchDispatcher();
    let watch;
    try {
      watch = cottontail.fdWatchStart(this.fd, 1, this._refed, true, true);
    } catch {
      return false;
    }
    const watchId = Number(watch?.id || 0);
    if (!watchId) return false;
    this._watchId = watchId;
    this._watchWriteOnly = true;
    fdWatchListeners.set(watchId, _wrapAsyncCallback((event) => {
      if (this._watchId !== watchId || this.destroyed) return;
      if (event.type === "writable") {
        this._flushOutboundWrites();
        return;
      }
      if (event.type === "error") {
        const error = new Error(event.message || "socket write failed");
        if (event.code != null) error.code = String(event.code);
        if (event.errno != null) error.errno = Number(event.errno);
        this._failOutboundWrites(error);
      }
    }));
    this._unregisterWatch = () => fdWatchListeners.delete(watchId);
    return true;
  }

  _scheduleOutboundFlush() {
    if (this.destroyed) return;
    if (!this._watchId) this._startWriteWatch();
    if (this._watchId && typeof cottontail.fdWatchSetWritable === "function") {
      if (cottontail.fdWatchSetWritable(this._watchId, true) === true) {
        if (this._writeRetryTimer != null) {
          clearTimeout(this._writeRetryTimer);
          this._writeRetryTimer = null;
        }
        return;
      }
    }
    if (this._writeRetryTimer != null) return;
    this._writeRetryTimer = globalThis.setTimeout(() => {
      this._writeRetryTimer = null;
      this._flushOutboundWrites();
    }, 0);
    if (!this._refed) this._writeRetryTimer.unref?.();
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
        this._refreshTimeout();
        if (entry.offset < entry.bytes.byteLength) continue;
        this._outboundWrites.shift();
        if (typeof entry.callback === "function") queueMicrotask(() => entry.callback());
      }
    } catch (error) {
      this._failOutboundWrites(error);
      return;
    }

    if (this._watchWriteOnly) {
      this._stopRead();
    } else if (this._watchId) {
      cottontail.fdWatchSetWritable?.(this._watchId, false);
    }
  }

  _failOutboundWrites(error) {
    const pending = this._outboundWrites.splice(0);
    for (const entry of pending) {
      if (typeof entry.callback === "function") queueMicrotask(() => entry.callback(error));
    }
    if (pending.length === 0 && !this.destroyed) this.destroy(error);
  }

  _stopRead() {
    const watchId = this._watchId;
    this._watchId = 0;
    if (this._unregisterWatch) this._unregisterWatch();
    this._unregisterWatch = null;
    this._watchWriteOnly = false;
    this._nativeReadPaused = false;
    if (watchId) cottontail.fdWatchStop?.(watchId);
  }

  _finishDeferredDestroy() {
    const finalize = this._destroyFinalize;
    if (finalize == null) return;
    this._destroyFinalize = null;
    if (this._destroyCloseTimer != null) {
      clearTimeout(this._destroyCloseTimer);
      this._destroyCloseTimer = null;
    }
    finalize();
  }

  _detachFdForTls() {
    if (this.fd == null || this.destroyed || this.connecting) {
      const error = new Error("Socket is not connected");
      error.code = "ERR_SOCKET_CLOSED";
      throw error;
    }
    this._flushOutboundWrites();
    if (this.writableLength > 0 || this._outboundWrites.length > 0) {
      const error = new Error("Socket still has pending writes");
      error.code = "ERR_SOCKET_CLOSED";
      throw error;
    }
    if (this.readableLength > 0 || this._pendingData.length > 0) {
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
    if (!this.encrypted) {
      if (this.push(chunk) === false && this._watchId && !this._watchWriteOnly) {
        this._nativeReadPaused = true;
        cottontail.fdWatchSetPaused?.(this._watchId, true);
      }
      return;
    }
    if (this._paused || this._pendingData.length > 0 || this.listenerCount("readable") > 0) {
      this._pendingData.push(chunk);
      if (this.listenerCount("readable") > 0) this.emit("readable");
      if (!this._paused && this.listenerCount("data") > 0) queueMicrotask(() => this._flushPendingData());
      return;
    }
    this.emit("data", chunk);
  }

  unshift(chunk) {
    if (!this.encrypted) return super.unshift(chunk);
    if (chunk == null) return this;
    const bytes = typeof chunk === "string" ? bytesFrom(chunk, this._encoding ?? undefined) : chunk;
    const wrapped = globalThis.Buffer?.isBuffer?.(bytes) ? bytes : chunkFromBytes(bytes, this._encoding);
    this._pendingData.unshift(wrapped);
    if (!this._paused) queueMicrotask(() => this._flushPendingData());
    return this;
  }

  read(size = undefined) {
    if (!this.encrypted) return super.read(size);
    if (this._pendingData.length === 0) return null;
    const chunks = this._pendingData.splice(0);
    if (this._encoding) return chunks.join("");
    const buffers = chunks.map((chunk) => (globalThis.Buffer?.isBuffer?.(chunk) ? chunk : globalThis.Buffer.from(chunk)));
    const merged = buffers.length === 1 ? buffers[0] : globalThis.Buffer.concat(buffers);
    if (this._pendingEnd) queueMicrotask(() => this._flushPendingData());
    return merged;
  }

  get bufferSize() {
    return this.writableLength;
  }

  _emitEnd() {
    if (!this.encrypted) {
      if (!this.readableEnded && !this._readEndSignaled) {
        this._readEndSignaled = true;
        this.push(null);
        if (this.readableLength === 0) this.read(0);
      }
      return;
    }
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
    if (!this.encrypted) return;
    // Once both directions are done (FIN received and FIN sent) the socket
    // closes, even with allowHalfOpen.
    if (this._finishEmitted && this._endEmitted && !this.destroyed) {
      queueMicrotask(() => {
        if (this._finishEmitted && this._endEmitted && !this.destroyed) this.destroy();
      });
    }
  }

  _flushPendingData() {
    if (!this.encrypted) return;
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
    if (this.fd == null || this.destroyed || typeof cottontail.fdWatchStart !== "function") return this;
    if (this._watchId) {
      cottontail.fdWatchSetPaused?.(this._watchId, this._paused || this._nativeReadPaused);
      cottontail.fdWatchSetRef?.(this._watchId, this._refed);
      return this;
    }
    const fdWatchListeners = installFdWatchDispatcher();
    const readSize = Math.max(1, Math.min(this.readableHighWaterMark, 1024 * 1024));
    const watch = cottontail.fdWatchStart(this.fd, readSize, this._refed, this._paused);
    this._watchId = Number(watch?.id || 0);
    if (!this._watchId) return this;
    const watchId = this._watchId;
    fdWatchListeners.set(watchId, _wrapAsyncCallback((event) => {
      if (this.destroyed) {
        if (this._destroyFinalize != null && event.type !== "data" && event.type !== "writable") {
          this._finishDeferredDestroy();
        }
        return;
      }
      if (event.type === "writable") {
        this._flushOutboundWrites();
        this.__cottontailBunWritable?.();
        return;
      }
      if (event.type === "data") {
        if (this._onread) {
          this._deliverOnread(event.data ?? new ArrayBuffer(0));
          return;
        }
        const chunk = chunkFromBytes(event.data ?? new ArrayBuffer(0), this.encrypted ? this._encoding : null);
        const length = Number(chunk?.byteLength ?? chunk?.length ?? 0);
        if (length > 0) {
          this.bytesRead += length;
          this._emitData(chunk);
          this._refreshTimeout();
        }
        return;
      }
      if (event.type === "end") {
        this._stopRead();
        this._emitEnd();
        if (this._outboundWrites.length > 0) this._scheduleOutboundFlush();
        return;
      }
      if (event.type === "error") {
        const error = new Error(event.message || "socket read failed");
        if (event.code != null) error.code = String(event.code);
        else if (/connection reset/i.test(error.message)) error.code = "ECONNRESET";
        else if (/broken pipe/i.test(error.message)) error.code = "EPIPE";
        if (event.errno != null) error.errno = Number(event.errno);
        this.destroy(error);
      }
    }));
    this._unregisterWatch = () => {
      fdWatchListeners.delete(watchId);
    };
    if (this._outboundWrites.length > 0) this._scheduleOutboundFlush();
    return this;
  }

  _read() {
    if (this.destroyed || this.fd == null || this.encrypted) return;
    this._nativeReadPaused = false;
    this._paused = false;
    if (this._watchId && !this._watchWriteOnly) cottontail.fdWatchSetPaused?.(this._watchId, false);
    else this._startRead();
  }

  _cancelConnectAttempts() {
    this._connectGeneration += 1;
    for (const timer of this._connectAttemptTimers) clearTimeout(timer);
    this._connectAttemptTimers.clear();
    this._connectFailureTimer = null;
    const listeners = globalThis.__cottontailTcpConnectListeners;
    for (const id of this._connectAttemptIds) {
      listeners?.delete?.(id);
      try { cottontail.tcpSocketConnectCancel?.(id); } catch {}
    }
    this._connectAttemptIds.clear();
  }

  _resetCompletedConnection() {
    const completed = this.destroyed || this.writableEnded || this.readableEnded || this._closeEmitted;
    if (!completed) return;

    // A finish callback can run before the peer FIN has driven the socket
    // through destroy(). Reconnecting at that point must not orphan the old fd.
    if (!this.destroyed && (this.fd != null || this._watchId)) this._destroyImmediately();
    this._finishDeferredDestroy();

    this._undestroy();
    this.connecting = false;
    this.fd = null;
    this.remoteAddress = undefined;
    this.remoteFamily = undefined;
    this.remotePort = undefined;
    this.localAddress = undefined;
    this.localPort = undefined;
    this.localFamily = undefined;
    this.bytesRead = 0;
    this._bytesDispatchedValue = 0;
    this._pendingData = [];
    this._pendingEnd = false;
    this._pendingWrites = [];
    this._outboundWrites = [];
    this._ending = false;
    this._endEmitted = false;
    this._finishEmitted = false;
    this._closeEmitted = false;
    this._hadError = false;
    this._readyEmitted = false;
    this._readEndSignaled = false;
    this._nativeReadPaused = false;
    this._nativeShutdownSent = false;
    this._destroyImmediateRequested = false;
    this._nativeHandleTransferred = false;
    this.autoSelectFamilyAttemptedAddresses = undefined;
    this._peername = null;
    this._sockname = null;
  }

  _setupAbortSignal(signal) {
    if (signal == null || typeof signal !== "object" || this._abortSignal === signal) return;
    if (typeof signal.addEventListener !== "function") return;
    if (this._abortSignal != null && this._abortListener != null) {
      try { this._abortSignal.removeEventListener("abort", this._abortListener); } catch {}
    }
    this._abortSignal = signal;
    this._abortListener = null;
    const abortReason = () => signal.reason !== undefined ? signal.reason : (() => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      err.code = "ABORT_ERR";
      return err;
    })();
    const abort = () => {
      const reason = abortReason();
      this._abortReason = reason;
      if (!this.destroyed) {
        this.destroy(reason != null && typeof reason === "object" ? reason : new Error(String(reason)));
      }
    };
    if (signal.aborted) {
      // Node destroys asynchronously so callers can attach "error" listeners.
      this._abortReason = abortReason();
      setTimeout(() => {
        if (!this.destroyed) {
          const reason = this._abortReason;
          this.destroy(reason != null && typeof reason === "object" ? reason : new Error(String(reason)));
        }
      }, 10);
      return;
    }
    const onAbort = () => abort();
    this._abortListener = onAbort;
    signal.addEventListener("abort", onAbort, { once: true });
    this.once("close", () => {
      if (this._abortSignal !== signal) return;
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // ignore
      }
      this._abortListener = null;
    });
  }

  _scheduleConnectFailure(error, options = {}) {
    if (this.destroyed || !this.connecting || this._connectFailureTimer != null) return;
    const signalPending = this._abortSignal != null && !this._abortSignal.aborted;
    const delay = signalPending
      ? Math.max(10, Number(options.autoSelectFamilyAttemptTimeout ?? defaultAutoSelectFamilyAttemptTimeout))
      : 10;
    const timer = setTimeout(() => {
      this._connectAttemptTimers.delete(timer);
      if (this._connectFailureTimer === timer) this._connectFailureTimer = null;
      if (this.destroyed || !this.connecting || this._abortReason !== undefined) return;
      this.connecting = false;
      this.destroy(error);
    }, delay);
    this._connectFailureTimer = timer;
    this._connectAttemptTimers.add(timer);
    if (!this._refed) timer.unref?.();
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
    const invalidIpAddress = (value) => makeNodeError(TypeError, `Invalid IP address: ${String(value)}`, "ERR_INVALID_IP_ADDRESS");
    const invalidAddressFamily = (value) => makeNodeError(
      TypeError,
      `Invalid address family: ${String(value)} ${host}:${String(options.port ?? 0)}`,
      "ERR_INVALID_ADDRESS_FAMILY",
      { host, port: Number(options.port ?? 0) },
    );
    const done = (error, result, resultFamily = undefined) => {
      if (error) {
        this.emit("lookup", error, undefined, undefined, host);
        callback(error);
        return;
      }
      if (!all) {
        this.emit("lookup", null, result, resultFamily, host);
        if (typeof result !== "string" || isIP(result) === 0) {
          callback(invalidIpAddress(result));
          return;
        }
        if (resultFamily !== 4 && resultFamily !== 6) {
          callback(invalidAddressFamily(resultFamily));
          return;
        }
        const actualFamily = isIP(result);
        if (family && actualFamily !== family) {
          callback(invalidIpAddress(result));
          return;
        }
        callback(null, [{ address: result, family: actualFamily }]);
        return;
      }

      const records = Array.isArray(result) ? result : [];
      const valid = [];
      let firstError = records.length === 0 ? invalidIpAddress(undefined) : null;
      for (const record of records) {
        const address = record?.address;
        const recordFamily = record?.family;
        this.emit("lookup", null, address, recordFamily, host);
        if (typeof address !== "string" || isIP(address) === 0) {
          firstError ??= invalidIpAddress(address);
          continue;
        }
        if (recordFamily !== 4 && recordFamily !== 6) {
          firstError ??= invalidAddressFamily(recordFamily);
          continue;
        }
        const actualFamily = isIP(address);
        if (recordFamily !== actualFamily) continue;
        if (family && actualFamily !== family) continue;
        if (!valid.some((candidate) => candidate.address === address && candidate.family === actualFamily)) {
          valid.push({ address, family: actualFamily });
        }
      }
      if (valid.length === 0) {
        callback(firstError ?? invalidIpAddress(records[0]?.address));
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
      try {
        options.lookup(host, { family, hints: Number(options.hints) || 0, all }, done);
      } catch (error) {
        done(error);
      }
      return;
    }

    const onNativeRecords = (records) => {
      const normalized = Array.from(records ?? []);
      if (all) done(null, normalized);
      else done(null, normalized[0]?.address, normalized[0]?.family);
    };
    if (typeof cottontail.dnsLookupAsync === "function") {
      try {
        cottontail.dnsLookupAsync(host, family, Number(options.hints) || 0, (code, records) => {
          if (code != null) {
            const error = new Error(`getaddrinfo ${String(code)} ${host}`);
            error.code = String(code);
            error.errno = code === "ENOTFOUND" ? -3008 : code;
            error.syscall = "getaddrinfo";
            error.hostname = host;
            done(error);
            return;
          }
          onNativeRecords(records);
        });
      } catch (rawError) {
        queueMicrotask(() => done(rawError instanceof Error ? rawError : new Error(String(rawError))));
      }
      return;
    }
    queueMicrotask(() => {
      try {
        if (typeof cottontail.dnsLookup !== "function") throw new Error("native DNS lookup is unavailable");
        onNativeRecords(cottontail.dnsLookup(host, family));
      } catch (rawError) {
        const error = rawError instanceof Error ? rawError : new Error(String(rawError));
        if (error.code == null) error.code = "ENOTFOUND";
        done(error);
      }
    });
  }

  _attemptConnectAddresses(options, host, port, addresses) {
    if (this.destroyed || !this.connecting) return;
    const attempted = [];
    const errors = [];
    this.autoSelectFamilyAttemptedAddresses = addresses.length > 1 ? attempted : undefined;
    const generation = this._connectGeneration;
    const listeners = globalThis.__cottontailTcpConnectListeners ??= new Map();
    installFdWatchDispatcher();
    const attemptTimeout = Math.max(10, Number(options.autoSelectFamilyAttemptTimeout ?? defaultAutoSelectFamilyAttemptTimeout));
    let index = 0;

    const fail = () => {
      if (this.destroyed || !this.connecting || generation !== this._connectGeneration) return;
      let error;
      if (errors.length > 1) {
        error = new AggregateError(errors, "All connection attempts failed");
        error.code = errors[0]?.code;
      } else {
        error = errors[0] ?? connectionException(new Error("Failed to connect"), options, host, port);
      }
      this._scheduleConnectFailure(error, options);
    };

    const startNext = () => {
      if (this.destroyed || !this.connecting || generation !== this._connectGeneration) return;
      if (index >= addresses.length) {
        fail();
        return;
      }
      const { address, family } = addresses[index++];
      attempted.push(`${address}:${port}`);
      this.emit("connectionAttempt", address, port, family);
      if (this.blockList?.check(address, `ipv${family}`)) {
        const blocked = makeNodeError(Error, `IP address is blocked by the supplied net.BlockList: ${address}`, "ERR_IP_BLOCKED", { address });
        errors.push(blocked);
        this.emit("connectionAttemptFailed", address, port, family, blocked);
        startNext();
        return;
      }

      let nativeAttempt;
      try {
        if (typeof cottontail.tcpSocketConnectStart !== "function") {
          const result = cottontail.tcpSocketConnect(port, address, family);
          this._attachFd(result.fd, result.local, result.remote, true);
          return;
        }
        nativeAttempt = cottontail.tcpSocketConnectStart(
          port,
          address,
          family,
          options.localAddress,
          options.localPort,
          this._refed,
        );
        if (nativeAttempt && typeof nativeAttempt === "object") {
          Object.setPrototypeOf(nativeAttempt, TCPConnectWrap.prototype);
        }
      } catch (rawError) {
        const error = connectionException(rawError, options, address, port);
        errors.push(error);
        this.emit("connectionAttemptFailed", address, port, family, error);
        startNext();
        return;
      }
      const attemptId = Number(nativeAttempt?.id ?? 0);
      if (!attemptId) {
        const error = connectionException(new Error("Failed to start connection attempt"), options, address, port);
        errors.push(error);
        this.emit("connectionAttemptFailed", address, port, family, error);
        startNext();
        return;
      }
      this._connectAttemptIds.add(attemptId);

      let timeoutTimer = null;
      const clearAttempt = () => {
        listeners.delete(attemptId);
        this._connectAttemptIds.delete(attemptId);
        if (timeoutTimer != null) {
          clearTimeout(timeoutTimer);
          this._connectAttemptTimers.delete(timeoutTimer);
          timeoutTimer = null;
        }
      };
      const connectListener = _wrapAsyncCallback((event) => {
        if (event?.type !== "connect") return;
        clearAttempt();
        let result;
        try {
          result = cottontail.tcpSocketConnectTake(attemptId);
        } catch (rawError) {
          result = { ok: false, message: rawError?.message ?? String(rawError), code: rawError?.code };
        }
        if (this.destroyed || !this.connecting || generation !== this._connectGeneration) {
          if (result?.ok && result.fd != null) try { cottontail.closeFd?.(result.fd); } catch {}
          return;
        }
        if (result?.ok) {
          this._attachFd(result.fd, result.local, result.remote, true);
          return;
        }
        const nativeError = Object.assign(new Error(result?.message || "Failed to connect"), {
          code: result?.code,
          errno: result?.errno,
        });
        const error = connectionException(nativeError, options, address, port);
        errors.push(error);
        this.emit("connectionAttemptFailed", address, port, family, error);
        startNext();
      });
      connectListener.__cottontailConnectTarget = { id: attemptId, address, port };
      listeners.set(attemptId, connectListener);

      if (index < addresses.length) {
        timeoutTimer = setTimeout(() => {
          this._connectAttemptTimers.delete(timeoutTimer);
          timeoutTimer = null;
          if (this.destroyed || !this.connecting || generation !== this._connectGeneration) return;
          listeners.delete(attemptId);
          this._connectAttemptIds.delete(attemptId);
          try { cottontail.tcpSocketConnectCancel(attemptId); } catch {}
          const error = connectionException(Object.assign(new Error("Connection attempt timed out"), { code: "ETIMEDOUT" }), options, address, port);
          errors.push(error);
          this.emit("connectionAttemptTimeout", address, port, family);
          startNext();
        }, attemptTimeout);
        if (!this._refed) timeoutTimer.unref?.();
        this._connectAttemptTimers.add(timeoutTimer);
      }
    };

    startNext();
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
    if (options.family != null) normalizeSocketFamily(options.family);
    if (options.lookup != null && typeof options.lookup !== "function") {
      throw invalidArgType("options.lookup", "of type function", options.lookup);
    }
    if (options.signal !== undefined) validateAbortSignal(options.signal);
    if (options.autoSelectFamily != null && typeof options.autoSelectFamily !== "boolean") {
      throw invalidArgType("options.autoSelectFamily", "of type boolean", options.autoSelectFamily);
    }
    if (options.autoSelectFamilyAttemptTimeout != null) {
      if (!Number.isInteger(options.autoSelectFamilyAttemptTimeout) || options.autoSelectFamilyAttemptTimeout < 1) {
        throw outOfRange("options.autoSelectFamilyAttemptTimeout", ">= 1", options.autoSelectFamilyAttemptTimeout);
      }
    }
    this._finishDeferredDestroy();
    this._cancelConnectAttempts();
    this._resetCompletedConnection();
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
    this._isPipe = options.path != null || options.pipe === true;
    this._path = this._isPipe ? options.path : undefined;
    this.connecting = true;
    if (this._abortReason !== undefined) return this;
    let host = options.host ?? "localhost";
    this._host = String(host);
    this._port = port;
    const failConnect = (rawError) => {
      const error = connectionException(rawError, options, host, port);
      this._scheduleConnectFailure(error, options);
    };
    const attachConnected = (result) => {
      queueMicrotask(() => {
        if (this.destroyed || !this.connecting) {
          if (result?.fd != null && options.fd === undefined) {
            try { cottontail.closeFd?.(result.fd); } catch {}
          }
          return;
        }
        this._attachFd(result.fd, result.local, result.remote, true);
      });
    };
    try {
      if (options.fd !== undefined) {
        attachConnected({ fd: Number(options.fd), local: options.local, remote: options.remote });
        return this;
      }
      if (options.path != null) {
        const result = cottontail.unixSocketConnect(String(options.path));
        attachConnected(result);
        return this;
      }
      // Connecting to a wildcard address targets the corresponding loopback.
      if (host === "0.0.0.0") host = "127.0.0.1";
      else if (host === "::") host = "::1";
      this._resolveConnectAddresses(String(host), options, (error, addresses) => {
        if (this.destroyed || !this.connecting) return;
        if (error) {
          failConnect(error);
          return;
        }
        this._attemptConnectAddresses(options, String(host), port, addresses);
      });
    } catch (rawError) {
      failConnect(rawError);
    }
    return this;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (chunk === null) {
      throw makeNodeError(TypeError, "May not write null values to stream", "ERR_STREAM_NULL_VALUES");
    }
    if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk)) {
      throw invalidArgType("chunk", "of type string, Buffer, TypedArray, or DataView", chunk);
    }
    return super.write(chunk, encoding, callback);
  }

  _write(chunk, encoding = undefined, callback = undefined) {
    const bytes = bytesFrom(chunk, encoding ?? this._defaultEncoding);
    const entry = { bytes, offset: 0, callback };
    if (this.connecting && this.fd == null && !this.destroyed) {
      this._outboundWrites.push(entry);
      return;
    }
    if (this.destroyed || this.fd == null) {
      const error = makeNodeError(Error, "Socket is closed", "ERR_SOCKET_CLOSED");
      queueMicrotask(() => callback(error));
      return;
    }
    this._outboundWrites.push(entry);
    this._flushOutboundWrites();
  }

  _writev(chunks, callback) {
    if (chunks.length === 1) {
      const { chunk, encoding } = chunks[0];
      this._write(chunk, encoding, callback);
      return;
    }
    const parts = chunks.map(({ chunk, encoding }) => bytesFrom(chunk, encoding ?? this._defaultEncoding));
    const total = parts.reduce((length, part) => length + part.byteLength, 0);
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.byteLength;
    }
    this._write(combined, "buffer", callback);
  }

  _final(callback) {
    this._ending = true;
    if (this.connecting) {
      let settled = false;
      const cleanup = () => {
        this.removeListener("connect", onConnect);
        this.removeListener("close", onClose);
      };
      const onConnect = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this._shutdownNativeWrite(callback);
      };
      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(makeNodeError(Error, "Socket closed before the connection was established", "ERR_SOCKET_CLOSED_BEFORE_CONNECTION"));
      };
      this.once("connect", onConnect);
      this.once("close", onClose);
      this._pendingFinalCleanup = cleanup;
      this._pendingFinalCallback = callback;
      return;
    }
    this._shutdownNativeWrite(callback);
  }

  _shutdownNativeWrite(callback) {
    this._pendingFinalCleanup?.();
    this._pendingFinalCleanup = null;
    this._pendingFinalCallback = null;
    if (!this._nativeShutdownSent && this.fd != null) {
      this._nativeShutdownSent = true;
      try {
        cottontail.tcpSocketShutdown?.(this.fd);
      } catch (error) {
        queueMicrotask(() => callback(error));
        return;
      }
    }
    queueMicrotask(callback);
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
    return super.destroy(error);
  }

  _destroyImmediately(error) {
    this._destroyImmediateRequested = true;
    return super.destroy(error);
  }

  _destroy(error, callback) {
    const immediate = this._destroyImmediateRequested;
    this._destroyImmediateRequested = false;
    const wasConnecting = this.connecting;
    this._cancelConnectAttempts();
    this.connecting = false;
    this._hadError = Boolean(error);
    this._clearTimeoutTimer();
    if (this._writeRetryTimer != null) {
      clearTimeout(this._writeRetryTimer);
      this._writeRetryTimer = null;
    }
    const writeError = error ?? (wasConnecting
      ? makeNodeError(Error, "Socket closed before the connection was established", "ERR_SOCKET_CLOSED_BEFORE_CONNECTION")
      : makeNodeError(Error, "Cannot call write after a stream was destroyed", "ERR_STREAM_DESTROYED"));
    this._failOutboundWrites(writeError);
    if (this._pendingFinalCallback != null) {
      const finalCallback = this._pendingFinalCallback;
      this._pendingFinalCleanup?.();
      this._pendingFinalCleanup = null;
      this._pendingFinalCallback = null;
      queueMicrotask(() => finalCallback(error));
    }
    const fd = this.fd;
    this.fd = null;
    if (this._adoptedRawHandle && "fd" in this._adoptedRawHandle) {
      try { this._adoptedRawHandle.fd = null; } catch {}
    }
    const closeHandle = () => {
      this._stopRead();
      if (fd != null && !this._nativeHandleTransferred) {
        try { cottontail.closeFd?.(fd); } catch {}
      }
      this._nativeHandleTransferred = false;
      if (!this._closeEmitted) {
        this._closeEmitted = true;
        const closeTimer = setTimeout(() => this.emit("close", Boolean(error)), 0);
        if (!this._refed) closeTimer.unref?.();
      }
    };
    callback(error);
    if (!error && !immediate && fd != null && this._watchId && !this.readableEnded) {
      // Match Bun's deferred handle close: let one poll turn drain bytes that
      // raced with destroy(), then close even if the peer stays open.
      try { cottontail.tcpSocketShutdown?.(fd); } catch {}
      this._destroyFinalize = closeHandle;
      this._destroyCloseTimer = setTimeout(() => {
        this._destroyCloseTimer = null;
        const finalize = this._destroyFinalize;
        this._destroyFinalize = null;
        finalize?.();
      }, gracefulDestroyDrainMilliseconds);
      if (!this._refed) this._destroyCloseTimer.unref?.();
    } else {
      closeHandle();
    }
  }

  address() {
    if (this.fd == null) return {};
    if (this._isPipe) return { path: this._path ?? this.localAddress ?? "" };
    try { return cottontail.tcpSocketAddress(this.fd, false); } catch { return {}; }
  }
  setEncoding(encoding = "utf8") {
    this._encoding = String(encoding || "utf8").toLowerCase();
    return super.setEncoding(this._encoding);
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
    if (typeof timeout !== "number") throw invalidArgType("msecs", "of type number", timeout);
    if (!Number.isFinite(timeout) || timeout < 0) throw outOfRange("msecs", "a non-negative finite number", timeout);
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
    super.pause();
    if (this._watchId) cottontail.fdWatchSetPaused?.(this._watchId, true);
    return this;
  }
  isPaused() {
    return super.isPaused();
  }
  resume() {
    this._paused = false;
    super.resume();
    if (!this.destroyed && this.fd != null) {
      if (this._watchId && !this._watchWriteOnly) cottontail.fdWatchSetPaused?.(this._watchId, false);
      else this._startRead();
    }
    return this;
  }
  setDefaultEncoding(encoding = "utf8") {
    this._defaultEncoding = String(encoding || "utf8").toLowerCase();
    return super.setDefaultEncoding(this._defaultEncoding);
  }
  destroySoon() {
    if (this.writable) this.end();
    if (this.writableFinished) this.destroy();
    else this.once("finish", () => this.destroy());
    return this;
  }
  resetAndDestroy() {
    if (this.fd == null && !this.connecting) {
      this.destroy(makeNodeError(Error, "Socket is closed", "ERR_SOCKET_CLOSED"));
      return this;
    }
    if (this.connecting) {
      this.once("connect", () => this.resetAndDestroy());
      return this;
    }
    const fd = this.fd;
    this._stopRead();
    this.fd = null;
    this._destroyImmediateRequested = true;
    if (fd != null) {
      try { cottontail.tcpSocketReset?.(fd); } catch (error) {
        this.destroy(error);
        return this;
      }
    }
    this.destroy();
    return this;
  }
  ref() {
    this._refed = true;
    this._writeRetryTimer?.ref?.();
    this._destroyCloseTimer?.ref?.();
    for (const timer of this._connectAttemptTimers) timer.ref?.();
    if (this._watchId) cottontail.fdWatchSetRef?.(this._watchId, true);
    for (const id of this._connectAttemptIds) cottontail.tcpSocketConnectSetRef?.(id, true);
    return this;
  }
  unref() {
    this._refed = false;
    this._timeoutTimer?.unref?.();
    this._writeRetryTimer?.unref?.();
    this._destroyCloseTimer?.unref?.();
    for (const timer of this._connectAttemptTimers) timer.unref?.();
    if (this._watchId) cottontail.fdWatchSetRef?.(this._watchId, false);
    for (const id of this._connectAttemptIds) cottontail.tcpSocketConnectSetRef?.(id, false);
    return this;
  }

  get bytesWritten() {
    if (this._bytesDispatchedValue === undefined || !Array.isArray(this._outboundWrites)) return undefined;
    if (this.encrypted) return this._bytesDispatchedValue + this.writableLength;
    let pending = 0;
    for (const entry of this._outboundWrites) pending += Math.max(0, entry.bytes.byteLength - entry.offset);
    const buffered = this._writableState?.getBuffer?.() ?? [];
    for (const entry of buffered) pending += bytesFrom(entry.chunk, entry.encoding ?? this._defaultEncoding).byteLength;
    return this._bytesDispatchedValue + pending;
  }
  get _bytesDispatched() { return this._bytesDispatchedValue; }
  get pending() { return this.fd == null || this.connecting; }
  get closed() { return this._closeEmitted; }
  get readyState() {
    if (this.connecting) return "opening";
    if (this.destroyed) return "closed";
    if (this.readable && this.writable) return "open";
    if (this.readable) return "readOnly";
    if (this.writable) return "writeOnly";
    return "closed";
  }

  [ensureAsyncDisposeSymbol()]() {
    if (this._closeEmitted) return Promise.resolve();
    return new Promise((resolve) => {
      this.once("close", resolve);
      this.destroy();
    });
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
    trackHeapObject("Listener", this);
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
    this._ownsPipePath = false;
    this._acceptTimer = null;
    this._acceptWatchId = 0;
    this._unregisterAcceptWatch = null;
    this._acceptDispatchTimer = null;
    this._pendingAcceptEvents = [];
    this.__handleWrap = null;
    this.__handleOverride = undefined;
    this._activeSockets = new Set();
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

  get _handle() {
    if (this.__handleOverride !== undefined) return this.__handleOverride;
    if (!this.listening || this._fd == null) return null;
    if (this.__handleWrap == null) {
      const owner = this;
      this.__handleWrap = {
        get fd() { return owner._fd ?? -1; },
        getsockname(out = {}) { return owner._getsockname(out); },
        close(callback) { owner.close(callback); },
        ref() { owner.ref(); },
        unref() { owner.unref(); },
        hasRef() { return !owner._unref; },
      };
    }
    return this.__handleWrap;
  }

  set _handle(value) {
    this.__handleOverride = value;
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
    if (
      !this._closePending ||
      this._fd != null ||
      this[kConnectionCount] > 0 ||
      this._pendingAcceptEvents.length > 0 ||
      this._acceptDispatchTimer != null ||
      this._closeEmitted
    ) return;
    this._closeEmitted = true;
    queueMicrotask(() => this.emit("close"));
  }

  _createAcceptedSocket(_accepted, options) {
    return new Socket(options);
  }

  _queueAcceptEvent(type, value, connectAttemptId = null) {
    this._pendingAcceptEvents.push({ type, value, connectAttemptId });
    if (this._acceptDispatchTimer != null) return;
    this._scheduleAcceptDispatch();
  }

  _scheduleAcceptDispatch(waitForConnect = false) {
    const dispatch = () => {
      this._acceptDispatchTimer = null;
      const connectListeners = globalThis.__cottontailTcpConnectListeners;
      if (this._pendingAcceptEvents.some(event => event.connectAttemptId != null && connectListeners?.has?.(event.connectAttemptId))) {
        this._scheduleAcceptDispatch(true);
        return;
      }
      const events = this._pendingAcceptEvents.splice(0);
      for (const event of events) {
        if (event.type === "drop") {
          this.emit("drop", event.value);
          continue;
        }
        const socket = event.value;
        this.emit("connection", socket);
        if (!this.pauseOnConnect && !socket.isPaused()) socket.resume();
      }
      this._emitCloseIfDrained();
    };
    this._acceptDispatchTimer = waitForConnect ? setTimeout(dispatch, 1) : setImmediate(dispatch);
    if (this._unref) this._acceptDispatchTimer.unref?.();
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
    for (const optionName of ["ipv6Only", "reusePort", "exclusive"]) {
      if (options[optionName] != null && typeof options[optionName] !== "boolean") {
        throw invalidArgType(`options.${optionName}`, "of type boolean", options[optionName]);
      }
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
    this.__handleWrap = null;
    this.__handleOverride = undefined;
    this._options = { ...this._options, ...options };
    try {
      let result;
      if (options.fd != null) {
        this._fd = Number(options.fd);
        this._isPipe = options.path != null || options.pipe === true;
        this._ownsPipePath = false;
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
        result = cottontail.tcpServerListen(
          validatePort(options.port ?? 0),
          host,
          family || 0,
          Number(options.backlog ?? 511),
          options.ipv6Only === true,
          options.reusePort === true,
          options.exclusive === true,
        );
      }
      if (result != null) {
        this._fd = Number(result.fd);
        this._isPipe = options.path != null;
        this._ownsPipePath = this._isPipe;
        this._path = this._isPipe ? String(result.path ?? options.path) : null;
        this._address = this._isPipe ? this._path : result.address ?? null;
      }
      this.listening = true;
      if (!startAcceptWatch(this, this._fd, !this._unref, () => this._acceptPending())) {
        this._acceptTimer = setInterval(() => this._acceptPending(), 1);
        if (this._unref) this._acceptTimer?.unref?.();
      }
      queueMicrotask(() => {
        if (this.listening) this.emit("listening");
      });
    } catch (rawError) {
      this.listening = false;
      this._fd = null;
      const error = rawError instanceof Error ? rawError : new Error(String(rawError));
      if (/(in use|EADDRINUSE)/i.test(String(error.message))) {
        if (error.code == null) error.code = "EADDRINUSE";
        if (error.code === "EADDRINUSE" && error.errno == null) error.errno = -nodeConstants.EADDRINUSE;
        if (error.syscall == null) error.syscall = "listen";
        if (!this._isPipe) {
          if (error.address == null) error.address = options.host ?? "::";
          if (error.port == null) error.port = Number(options.port ?? 0);
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
    server._ownsPipePath = options.ownsPipePath === true;
    server._path = options.path ?? null;
    try {
      server._address = server._isPipe ? server._path : cottontail.tcpSocketAddress?.(server._fd, false);
    } catch {
      server._address = server._isPipe ? server._path : null;
    }
    server.listening = true;
    if (!startAcceptWatch(server, server._fd, true, () => server._acceptPending())) {
      server._acceptTimer = setInterval(() => server._acceptPending(), 1);
    }
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
        const data = {
          localAddress: accepted.local?.address ?? this._address?.address,
          localPort: accepted.local?.port ?? this._address?.port,
          localFamily: familyName(accepted.local?.family, accepted.local?.address ?? this._address?.address),
          remoteAddress: accepted.remote?.address,
          remotePort: accepted.remote?.port,
          remoteFamily: familyName(accepted.remote?.family, accepted.remote?.address),
        };
        if (this._pendingAcceptEvents.length > 0) this._queueAcceptEvent("drop", data);
        else this.emit("drop", data);
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
      this._activeSockets.add(socket);
      socket.once("close", () => {
        this._activeSockets.delete(socket);
        this._decrementConnections();
      });
      // libuv can report listener readability before the matching local client
      // connect completion. Deliver plain accepted sockets in the next check
      // phase, preserving Node/Bun's client-connect-before-server-connection order.
      if (socket.encrypted) {
        this.emit("connection", socket);
        if (!this.pauseOnConnect && !socket.isPaused()) socket.resume();
      } else {
        const connectAttemptId = pendingConnectIdForAcceptedSocket(socket);
        if (connectAttemptId != null || this._pendingAcceptEvents.length > 0) {
          this._queueAcceptEvent("connection", socket, connectAttemptId);
        } else {
          this.emit("connection", socket);
          if (!this.pauseOnConnect && !socket.isPaused()) socket.resume();
        }
      }
    }
  }

  close(callback = undefined) {
    if (callback !== undefined && typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    const wasRunning = this._fd != null || this.listening;
    const ownedPipePath = this._ownsPipePath && this._path ? this._path : null;
    if (callback) {
      if (wasRunning) this.once("close", callback);
      else if (this._closeEmitted) queueMicrotask(() => callback(makeNodeError(Error, "Server is not running.", "ERR_SERVER_NOT_RUNNING")));
      else this.once("close", () => callback(makeNodeError(Error, "Server is not running.", "ERR_SERVER_NOT_RUNNING")));
    }
    this._closePending = true;
    stopAcceptWatch(this);
    if (this._fd != null) {
      try { cottontail.closeFd?.(this._fd); } catch {}
      this._fd = null;
    }
    if (ownedPipePath != null) {
      try { cottontail.unlinkSync?.(ownedPipePath); } catch {}
    }
    this._ownsPipePath = false;
    this.listening = false;
    this._address = null;
    this.__handleWrap = null;
    this.__handleOverride = undefined;
    this._emitCloseIfDrained();
    return this;
  }

  _closeActiveConnections() {
    for (const socket of Array.from(this._activeSockets)) socket.destroy();
  }

  address() {
    if (!this.listening || this._fd == null) return null;
    if (this._isPipe) return this._address;
    const out = {};
    const result = this._handle?.getsockname?.(out);
    if (result) throw errnoException(result, "address");
    const address = out.address ?? "0.0.0.0";
    const rawFamily = out.family;
    const family = rawFamily != null
      ? String(rawFamily).replace(/^ipv/i, "IPv")
      : (String(address).includes(":") ? "IPv6" : "IPv4");
    return { address, family, port: Number(out.port ?? 0) };
  }

  _getsockname(out = {}) {
    if (!this.listening || this._fd == null) return -9;
    let address = this._address;
    if (address == null) {
      try { address = cottontail.tcpSocketAddress?.(this._fd, false) ?? null; } catch { return -9; }
    }
    if (address == null) return -9;
    out.address = address.address ?? "0.0.0.0";
    out.family = String(address.family ?? (String(out.address).includes(":") ? "IPv6" : "IPv4")).replace(/^ipv/i, "IPv");
    out.port = Number(address.port ?? 0);
    return 0;
  }
  getConnections(callback) {
    if (callback !== undefined && typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    if (callback) callback(null, this.listening ? this[kConnectionCount] : 0);
    return this;
  }
  ref() {
    this._unref = false;
    this._acceptTimer?.ref?.();
    this._acceptDispatchTimer?.ref?.();
    if (this._acceptWatchId) cottontail.fdWatchSetRef?.(this._acceptWatchId, true);
    return this;
  }
  unref() {
    this._unref = true;
    this._acceptTimer?.unref?.();
    this._acceptDispatchTimer?.unref?.();
    if (this._acceptWatchId) cottontail.fdWatchSetRef?.(this._acceptWatchId, false);
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
    this._acceptWatchId = 0;
    this._unregisterAcceptWatch = null;
    this._refed = true;
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
    if (this.fd == null || this._acceptTimer != null || this._acceptWatchId) return 0;
    this.reading = true;
    if (!startAcceptWatch(
      this,
      this.fd,
      this._refed,
      () => this._acceptPending(),
      (error) => {
        if (typeof this.onconnection === "function") this.onconnection(error);
      },
    )) {
      this._acceptTimer = setInterval(() => this._acceptPending(), 1);
      if (!this._refed) this._acceptTimer.unref?.();
    }
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
    if (this.owner instanceof SocketImpl) throw invalidArgValue("fd", fd, "cannot replace an adopted socket handle");
    this.fd = Number(fd);
    return 0;
  }

  close(callback = undefined) {
    if (this.owner instanceof SocketImpl && this.owner._adoptedRawHandle === this) {
      const owner = this.owner;
      if (typeof callback === "function") owner.once("close", callback);
      owner.destroy();
      return;
    }
    stopAcceptWatch(this);
    this.reading = false;
    if (this.fd != null) {
      try { cottontail.closeFd?.(this.fd); } catch {}
      this.fd = null;
    }
    if (typeof callback === "function") queueMicrotask(callback);
  }

  ref() {
    if (this.owner instanceof SocketImpl && this.owner._adoptedRawHandle === this) {
      this.owner.ref();
      return this;
    }
    this._refed = true;
    this._acceptTimer?.ref?.();
    if (this._acceptWatchId) cottontail.fdWatchSetRef?.(this._acceptWatchId, true);
    return this;
  }
  unref() {
    if (this.owner instanceof SocketImpl && this.owner._adoptedRawHandle === this) {
      this.owner.unref();
      return this;
    }
    this._refed = false;
    this._acceptTimer?.unref?.();
    if (this._acceptWatchId) cottontail.fdWatchSetRef?.(this._acceptWatchId, false);
    return this;
  }
  hasRef() {
    if (this.owner instanceof SocketImpl && this.owner._adoptedRawHandle === this) return this.owner._refed;
    return this._refed;
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
    if (this.owner instanceof SocketImpl && this.owner._adoptedRawHandle === this) {
      this.owner.setKeepAlive(enable, Number(initialDelay) * 1000);
      return 0;
    }
    if (this.fd != null && typeof cottontail.tcpSocketSetKeepAlive === "function") {
      cottontail.tcpSocketSetKeepAlive(this.fd, Boolean(enable), Number(initialDelay) || 0);
    }
    return 0;
  }

  setNoDelay(noDelay = true) {
    if (this.owner instanceof SocketImpl && this.owner._adoptedRawHandle === this) {
      this.owner.setNoDelay(noDelay);
      return 0;
    }
    if (this.fd != null && typeof cottontail.tcpSocketSetNoDelay === "function") {
      cottontail.tcpSocketSetNoDelay(this.fd, Boolean(noDelay));
    }
    return 0;
  }

  readStart() {
    if (this.owner instanceof SocketImpl && this.owner._adoptedRawHandle === this) {
      this.owner.resume();
      return 0;
    }
    this.reading = true;
    return 0;
  }

  readStop() {
    if (this.owner instanceof SocketImpl && this.owner._adoptedRawHandle === this) {
      this.owner.pause();
      return 0;
    }
    this.reading = false;
    return 0;
  }

  reset() {
    if (this.owner instanceof SocketImpl && this.owner._adoptedRawHandle === this) {
      this.owner.resetAndDestroy();
      return 0;
    }
    this.close();
    return 0;
  }
}

export const Stream = Socket;

function strictAddressFamily(value, name = "family", invalidTypeIsValue = false) {
  if (typeof value !== "string") {
    if (invalidTypeIsValue) throw invalidArgValue(name, value);
    throw invalidArgType(name, "of type string", value);
  }
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
    const family = options.family === undefined ? "ipv4" : strictAddressFamily(options.family, "options.family", true);
    const address = options.address === undefined ? (family === "ipv6" ? "::" : "127.0.0.1") : options.address;
    if (typeof address !== "string") throw invalidArgType("options.address", "of type string", address);
    const record = addressRecord(address, family, "address");
    const port = options.port === undefined ? 0 : validatePort(options.port);
    const flowlabel = options.flowlabel === undefined ? 0 : options.flowlabel;
    if (typeof flowlabel !== "number") throw invalidArgType("options.flowlabel", "of type number", flowlabel);
    if (!Number.isInteger(flowlabel) || flowlabel < 0 || flowlabel > 0xffffffff) throw outOfRange("options.flowlabel", ">= 0 && <= 4294967295", flowlabel);
    const state = { ...record, address, port, flowlabel: family === "ipv6" ? flowlabel : 0 };
    const socketAddress = new Proxy(this, {
      set(target, property, value, receiver) {
        if (kSocketAddressReadonlyProperties.has(property)) throw new TypeError(`Cannot assign to read only property '${String(property)}'`);
        return Reflect.set(target, property, value, receiver);
      },
    });
    kSocketAddressState.set(socketAddress, state);
    return socketAddress;
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

// COTTONTAIL-COMPAT: Dynamic platform interface enumeration and libuv-specific handle internals
// remain outside this source port; socket I/O, connect cancellation/fallback, listener options,
// watcher lifecycle, local binding, Unix ownership, and TCP reset are backed by native handles.

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
