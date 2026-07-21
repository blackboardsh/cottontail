import { EventEmitter } from "./events.js";
import { Buffer } from "./buffer.js";
import { isIP } from "./net.js";

function makeNodeError(ErrorType, message, code) {
  const error = new ErrorType(message);
  error.code = code;
  return error;
}

function describeReceived(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return `type string ('${value}')`;
  if (typeof value === "bigint") return `type bigint (${value}n)`;
  if (typeof value === "object") return `an instance of ${value?.constructor?.name ?? "Object"}`;
  return `type ${typeof value} (${String(value)})`;
}

function invalidArgType(name, expected, value) {
  return makeNodeError(
    TypeError,
    `The "${name}" argument must be ${expected}. Received ${describeReceived(value)}`,
    "ERR_INVALID_ARG_TYPE",
  );
}

function outOfRange(name, range, value) {
  return makeNodeError(
    RangeError,
    `The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`,
    "ERR_OUT_OF_RANGE",
  );
}

function badSocketType() {
  return makeNodeError(
    TypeError,
    "Bad socket type specified. Valid types are: udp4, udp6",
    "ERR_SOCKET_BAD_TYPE",
  );
}

function socketNotRunning() {
  return makeNodeError(Error, "Not running", "ERR_SOCKET_DGRAM_NOT_RUNNING");
}

function socketNotConnected() {
  return makeNodeError(Error, "Not connected", "ERR_SOCKET_DGRAM_NOT_CONNECTED");
}

function socketAlreadyConnected() {
  return makeNodeError(Error, "Already connected", "ERR_SOCKET_DGRAM_IS_CONNECTED");
}

function socketAlreadyBound() {
  return makeNodeError(Error, "Socket is already bound", "ERR_SOCKET_ALREADY_BOUND");
}

function validateCallback(callback) {
  if (callback !== undefined && callback !== null && typeof callback !== "function") {
    throw invalidArgType("callback", "of type function", callback);
  }
}

function validatePort(value, allowZero = false) {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && value.trim() === "")) {
    const error = makeNodeError(RangeError, `Port should be ${allowZero ? ">= 0" : "> 0"} and < 65536. Received ${describeReceived(value)}.`, "ERR_SOCKET_BAD_PORT");
    throw error;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < (allowZero ? 0 : 1) || port > 65535) {
    throw makeNodeError(
      RangeError,
      `Port should be ${allowZero ? ">= 0" : "> 0"} and < 65536. Received ${describeReceived(value)}.`,
      "ERR_SOCKET_BAD_PORT",
    );
  }
  return port;
}

function validateNumber(value, name) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  return value;
}

function validateTTL(value) {
  const ttl = validateNumber(value, "ttl");
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 255) {
    throw makeNodeError(Error, "EINVAL: invalid argument, setsockopt", "EINVAL");
  }
  return Math.trunc(ttl);
}

function validateBufferSize(value) {
  validateNumber(value, "size");
  if (!Number.isInteger(value) || value <= 0 || value > 0x7fffffff) {
    throw makeNodeError(TypeError, "Buffer size must be a positive integer", "ERR_SOCKET_BAD_BUFFER_SIZE");
  }
  return value;
}

function validateInitialBufferSize(value, name) {
  if (typeof value !== "number") throw invalidArgType(`options.${name}`, "of type number", value);
  if (!Number.isInteger(value)) throw outOfRange(`options.${name}`, "an integer", value);
  if (value < 0 || value > 0xffffffff) throw outOfRange(`options.${name}`, ">= 0 && <= 4294967295", value);
  return value;
}

function normalizeCreateOptions(options) {
  if (typeof options === "string") options = { type: options };
  if (options === null || typeof options !== "object") throw badSocketType();
  if (options.type !== "udp4" && options.type !== "udp6") throw badSocketType();
  if (options.lookup !== undefined && typeof options.lookup !== "function") {
    throw invalidArgType("lookup", "of type function", options.lookup);
  }
  if (options.signal !== undefined) {
    const signal = options.signal;
    if (signal === null || typeof signal !== "object" || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function") {
      throw invalidArgType("options.signal", "an instance of AbortSignal", signal);
    }
  }
  if (options.recvBufferSize !== undefined) validateInitialBufferSize(options.recvBufferSize, "recvBufferSize");
  if (options.sendBufferSize !== undefined) validateInitialBufferSize(options.sendBufferSize, "sendBufferSize");
  return { ...options };
}

function familyFromType(type) {
  if (type === "udp4") return 4;
  if (type === "udp6") return 6;
  throw badSocketType();
}

function defaultAddress(family, loopback = false) {
  if (family === 6) return loopback ? "::1" : "::";
  return loopback ? "127.0.0.1" : "0.0.0.0";
}

function normalizeBindArgs(args) {
  const list = Array.from(args);
  const callback = typeof list[list.length - 1] === "function" ? list.pop() : undefined;
  if (list.length > 0 && list[list.length - 1] !== undefined && typeof list[list.length - 1] !== "string" && typeof list[list.length - 1] !== "number" && typeof list[list.length - 1] !== "object") {
    validateCallback(list[list.length - 1]);
  }
  if (list[0] !== null && typeof list[0] === "object") return [{ ...list[0] }, callback];
  return [{ port: list[0] ?? 0, address: list[1] }, callback];
}

function messageBytes(message) {
  const convert = (value) => {
    if (typeof value === "string") return Buffer.from(value);
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return Buffer.from(value);
    throw invalidArgType("buffer", "of type string or an instance of Buffer, TypedArray, or DataView", value);
  };
  if (!Array.isArray(message)) return convert(message);
  return Buffer.concat(message.map(convert));
}

function sliceMessage(bytes, offset, length) {
  if (offset === undefined && length === undefined) return bytes;
  if (!Number.isInteger(offset) || offset < 0) throw outOfRange("offset", ">= 0", offset);
  if (!Number.isInteger(length) || length < 0) throw outOfRange("length", ">= 0", length);
  if (offset > bytes.byteLength || offset + length > bytes.byteLength) {
    throw makeNodeError(RangeError, "Offset is outside the bounds of the buffer", "ERR_BUFFER_OUT_OF_BOUNDS");
  }
  return bytes.subarray(offset, offset + length);
}

function normalizeSendArgs(args, connected) {
  const list = Array.from(args);
  const callback = typeof list[list.length - 1] === "function" ? list.pop() : undefined;
  const bytes = messageBytes(list.shift());
  let offset;
  let length;
  let port;
  let address;

  if (connected) {
    if (list.length >= 2 && typeof list[0] === "number" && typeof list[1] === "number") {
      offset = list.shift();
      length = list.shift();
    }
    if (list.length > 0) throw socketAlreadyConnected();
  } else {
    if (list.length >= 3 && typeof list[0] === "number" && typeof list[1] === "number") {
      offset = list.shift();
      length = list.shift();
    }
    port = validatePort(list.shift());
    address = list.shift();
    if (address !== undefined && typeof address !== "string") throw invalidArgType("address", "of type string", address);
    if (list.length > 0) validateCallback(list.shift());
  }

  return { bytes: sliceMessage(bytes, offset, length), port, address, callback };
}

function ensureAsyncDisposeSymbol() {
  if (Symbol.asyncDispose == null) {
    Object.defineProperty(Symbol, "asyncDispose", {
      value: Symbol.for("Symbol.asyncDispose"),
      configurable: true,
    });
  }
  return Symbol.asyncDispose;
}

export function _createSocketHandle(type = "udp4", options = undefined) {
  if (typeof cottontail.udpSocketCreate !== "function") throw new Error("native UDP sockets are unavailable");
  const normalized = options && typeof options === "object" ? options : {};
  return cottontail.udpSocketCreate(
    familyFromType(type),
    normalized.reuseAddr === true,
    normalized.reusePort === true,
    normalized.ipv6Only === true,
  );
}

export class Socket extends EventEmitter {
  constructor(options, messageListener = undefined) {
    super();
    const normalized = normalizeCreateOptions(options);
    this.type = normalized.type;
    this.family = familyFromType(this.type);
    this.fd = _createSocketHandle(this.type, normalized).fd;
    this.bound = false;
    this.closed = false;
    this.remote = null;
    this._address = null;
    this._bindState = "unbound";
    this._connectState = "disconnected";
    this._bindQueue = [];
    this._pollTimer = null;
    this._refed = true;
    this._lookup = normalized.lookup;
    this._initialRecvBufferSize = normalized.recvBufferSize;
    this._initialSendBufferSize = normalized.sendBufferSize;
    this._abortSignal = null;
    this._abortListener = null;
    if (typeof messageListener === "function") this.on("message", messageListener);
    if (normalized.signal) this._setupAbortSignal(normalized.signal);
  }

  _healthCheck() {
    if (this.closed || this.fd == null) throw socketNotRunning();
  }

  _setupAbortSignal(signal) {
    this._abortSignal = signal;
    const abort = () => {
      if (this.closed) return;
      const error = makeNodeError(Error, "The operation was aborted", "ABORT_ERR");
      error.name = "AbortError";
      this.emit("error", error);
      if (!this.closed) this.close();
    };
    this._abortListener = abort;
    if (signal.aborted) queueMicrotask(abort);
    else signal.addEventListener("abort", abort, { once: true });
  }

  _removeAbortSignal() {
    if (this._abortSignal && this._abortListener) {
      try { this._abortSignal.removeEventListener("abort", this._abortListener); } catch {}
    }
    this._abortSignal = null;
    this._abortListener = null;
  }

  _lookupAddress(address, callback) {
    if (this._lookup == null || isIP(address)) {
      callback(null, address);
      return;
    }
    let called = false;
    const done = (error, result) => {
      if (called) return;
      called = true;
      queueMicrotask(() => {
        if (error) {
          callback(error);
          return;
        }
        const resolved = typeof result === "object" && result !== null ? result.address : result;
        if (typeof resolved !== "string" || isIP(resolved) !== this.family) {
          callback(makeNodeError(TypeError, `Invalid IP address: ${String(resolved)}`, "ERR_INVALID_IP_ADDRESS"));
          return;
        }
        callback(null, resolved);
      });
    };
    try {
      this._lookup(address, { family: this.family, all: false }, done);
    } catch (error) {
      done(error);
    }
  }

  _drainBindQueue(error = undefined) {
    const pending = this._bindQueue.splice(0);
    for (const operation of pending) operation(error);
  }

  _queueAfterBind(operation) {
    this._healthCheck();
    if (this._bindState === "bound") {
      queueMicrotask(() => operation());
      return;
    }
    this._bindQueue.push(operation);
    if (this._bindState === "unbound") this.bind(0);
  }

  bind(...args) {
    const [options, callback] = normalizeBindArgs(args);
    validateCallback(callback);
    this._healthCheck();
    if (this._bindState !== "unbound") throw socketAlreadyBound();
    const port = validatePort(options.port ?? 0, true);
    const address = options.address ?? defaultAddress(this.family);
    if (typeof address !== "string") throw invalidArgType("address", "of type string", address);
    if (typeof callback === "function") this.once("listening", callback);
    this._bindState = "binding";
    queueMicrotask(() => {
      if (this.closed || this._bindState !== "binding") return;
      this._lookupAddress(address, (lookupError, resolvedAddress) => {
        if (this.closed || this._bindState !== "binding") return;
        try {
          if (lookupError) throw lookupError;
          this._address = cottontail.udpSocketBind(this.fd, port, resolvedAddress, this.family);
          if (this._initialRecvBufferSize > 0) cottontail.udpSocketSetBufferSize(this.fd, false, this._initialRecvBufferSize);
          if (this._initialSendBufferSize > 0) cottontail.udpSocketSetBufferSize(this.fd, true, this._initialSendBufferSize);
          this.bound = true;
          this._bindState = "bound";
          this._startPolling();
          this.emit("listening");
          this._drainBindQueue();
        } catch (error) {
          this._bindState = "unbound";
          this._drainBindQueue(error);
          this.emit("error", error);
        }
      });
    });
    return this;
  }

  connect(port, address = undefined, callback = undefined) {
    if (typeof address === "function") {
      callback = address;
      address = undefined;
    }
    validateCallback(callback);
    this._healthCheck();
    if (this._connectState !== "disconnected") throw socketAlreadyConnected();
    const normalizedPort = validatePort(port);
    const normalizedAddress = address ?? defaultAddress(this.family, true);
    if (typeof normalizedAddress !== "string") throw invalidArgType("address", "of type string", normalizedAddress);
    if (typeof callback === "function") this.once("connect", callback);
    this._connectState = "connecting";
    this._queueAfterBind((bindError) => {
      if (bindError || this.closed) {
        this._connectState = "disconnected";
        return;
      }
      this._lookupAddress(normalizedAddress, (lookupError, resolvedAddress) => {
        if (this.closed) return;
        try {
          if (lookupError) throw lookupError;
          cottontail.udpSocketConnect(this.fd, normalizedPort, resolvedAddress, this.family);
          this.remote = { address: resolvedAddress, port: normalizedPort };
          this._connectState = "connected";
          this.emit("connect");
        } catch (error) {
          this._connectState = "disconnected";
          this.emit("error", error);
        }
      });
    });
  }

  disconnect() {
    this._healthCheck();
    if (this._connectState !== "connected" || this.remote == null) throw socketNotConnected();
    if (typeof cottontail.udpSocketDisconnect !== "function") throw new Error("native UDP disconnect is unavailable");
    cottontail.udpSocketDisconnect(this.fd);
    this.remote = null;
    this._connectState = "disconnected";
  }

  send(...args) {
    this._healthCheck();
    const connected = this._connectState === "connected";
    const { bytes, port, address, callback } = normalizeSendArgs(args, connected);
    this._queueAfterBind((bindError) => {
      if (bindError || this.closed) {
        if (typeof callback === "function") callback(bindError ?? socketNotRunning());
        return;
      }
      const targetPort = connected ? this.remote.port : port;
      const targetAddress = connected ? this.remote.address : (address ?? defaultAddress(this.family, true));
      this._lookupAddress(targetAddress, (lookupError, resolvedAddress) => {
        if (this.closed) {
          if (typeof callback === "function") callback(socketNotRunning());
          return;
        }
        try {
          if (lookupError) throw lookupError;
          const sent = cottontail.udpSocketSend(this.fd, bytes, targetPort, resolvedAddress, this.family);
          if (typeof callback === "function") callback(null, sent);
        } catch (error) {
          if (typeof callback === "function") callback(error);
          else this.emit("error", error);
        }
      });
    });
  }

  close(callback = undefined) {
    validateCallback(callback);
    this._healthCheck();
    if (typeof callback === "function") this.once("close", callback);
    this.closed = true;
    this.bound = false;
    this._bindState = "closed";
    this._connectState = "disconnected";
    this.remote = null;
    this._removeAbortSignal();
    if (this._pollTimer != null) clearInterval(this._pollTimer);
    this._pollTimer = null;
    this._drainBindQueue(socketNotRunning());
    const fd = this.fd;
    this.fd = null;
    try {
      if (fd != null) cottontail.udpSocketClose(fd);
    } finally {
      queueMicrotask(() => this.emit("close"));
    }
    return this;
  }

  address() {
    this._healthCheck();
    if (this._bindState !== "bound") throw socketNotRunning();
    return { ...(this._address ?? cottontail.udpSocketAddress(this.fd)) };
  }

  remoteAddress() {
    this._healthCheck();
    if (this.remote == null || this._connectState !== "connected") throw socketNotConnected();
    return { ...this.remote, family: this.family === 6 ? "IPv6" : "IPv4" };
  }

  _normalizeMulticastInterface(multicastInterface) {
    if (multicastInterface == null) return "";
    if (typeof multicastInterface !== "string") throw invalidArgType("multicastInterface", "of type string", multicastInterface);
    if (this.family === 6 && multicastInterface.includes("%")) return multicastInterface.slice(multicastInterface.indexOf("%") + 1);
    return multicastInterface;
  }

  addMembership(multicastAddress, multicastInterface = undefined) {
    this._healthCheck();
    if (typeof multicastAddress !== "string") throw invalidArgType("multicastAddress", "of type string", multicastAddress);
    return cottontail.udpSocketMembership(this.fd, multicastAddress, this._normalizeMulticastInterface(multicastInterface), this.family, true);
  }

  dropMembership(multicastAddress, multicastInterface = undefined) {
    this._healthCheck();
    if (typeof multicastAddress !== "string") throw invalidArgType("multicastAddress", "of type string", multicastAddress);
    return cottontail.udpSocketMembership(this.fd, multicastAddress, this._normalizeMulticastInterface(multicastInterface), this.family, false);
  }

  setBroadcast(flag) {
    this._healthCheck();
    return cottontail.udpSocketSetBroadcast(this.fd, Boolean(flag));
  }

  setTTL(ttl) {
    this._healthCheck();
    return cottontail.udpSocketSetTTL(this.fd, validateTTL(ttl), this.family);
  }

  setMulticastTTL(ttl) {
    this._healthCheck();
    return cottontail.udpSocketSetMulticastTTL(this.fd, validateTTL(ttl), this.family);
  }

  setMulticastLoopback(flag) {
    this._healthCheck();
    return cottontail.udpSocketSetMulticastLoopback(this.fd, Boolean(flag), this.family);
  }

  setRecvBufferSize(size) {
    this._healthCheck();
    cottontail.udpSocketSetBufferSize(this.fd, false, validateBufferSize(size));
  }

  setSendBufferSize(size) {
    this._healthCheck();
    cottontail.udpSocketSetBufferSize(this.fd, true, validateBufferSize(size));
  }

  getRecvBufferSize() {
    this._healthCheck();
    return Number(cottontail.udpSocketGetBufferSize(this.fd, false));
  }

  getSendBufferSize() {
    this._healthCheck();
    return Number(cottontail.udpSocketGetBufferSize(this.fd, true));
  }

  ref() {
    this._refed = true;
    this._pollTimer?.ref?.();
    return this;
  }

  unref() {
    this._refed = false;
    this._pollTimer?.unref?.();
    return this;
  }

  [ensureAsyncDisposeSymbol()]() {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => this.close(resolve));
  }

  _startPolling() {
    if (this._pollTimer != null || this.closed) return;
    this._pollTimer = setInterval(() => this._poll(), 1);
    if (!this._refed) this._pollTimer.unref?.();
  }

  _poll() {
    if (this.closed) return;
    for (;;) {
      let packet;
      try {
        packet = cottontail.udpSocketReceive(this.fd, 65536);
      } catch (error) {
        if (!this.closed) this.emit("error", error);
        return;
      }
      if (!packet) break;
      this.emit("message", Buffer.from(packet.data), packet.rinfo);
    }
  }
}

Object.defineProperty(Socket.prototype.bind, "length", { value: 2, configurable: true });
Object.defineProperty(Socket.prototype.connect, "length", { value: 3, configurable: true });
Object.defineProperty(Socket.prototype.send, "length", { value: 6, configurable: true });
Object.defineProperty(Socket.prototype.close, "length", { value: 1, configurable: true });

export function createSocket(options, callback) {
  return new Socket(options, callback);
}

export default {
  Socket,
  _createSocketHandle,
  createSocket,
};
