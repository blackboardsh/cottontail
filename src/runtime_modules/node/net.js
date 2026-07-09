import { EventEmitter } from "./events.js";

function unsupported(name) {
  return new Error(`${name} is not implemented in Cottontail yet`);
}

function installFdWatchDispatcher() {
  const listeners = globalThis.__cottontailFdWatchListeners ??= new Map();
  if (!globalThis.__cottontailFdWatchHandlerInstalled && typeof cottontail.fdSetEventHandler === "function") {
    globalThis.__cottontailFdWatchHandlerInstalled = true;
    cottontail.fdSetEventHandler((event) => {
      const listener = listeners.get(Number(event?.id));
      if (typeof listener === "function") listener(event);
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
    this.readable = true;
    this.writable = true;
    this.remoteAddress = undefined;
    this.remoteFamily = undefined;
    this.remotePort = undefined;
    this.localAddress = undefined;
    this.localPort = undefined;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this.allowHalfOpen = options.allowHalfOpen === true;
    this._encoding = null;
    this._watchId = 0;
    this._unregisterWatch = null;
    if (this.fd != null) this._attachFd(this.fd, options.local, options.remote, true);
  }

  _setAddressInfo(local = undefined, remote = undefined) {
    if (local) {
      this.localAddress = local.address;
      this.localPort = local.port;
      this.localFamily = local.family;
    }
    if (remote) {
      this.remoteAddress = remote.address;
      this.remotePort = remote.port;
      this.remoteFamily = remote.family;
    }
  }

  _attachFd(fd, local = undefined, remote = undefined, connected = false) {
    this.fd = Number(fd);
    this.destroyed = false;
    this.readable = true;
    this.writable = true;
    this._setAddressInfo(local, remote);
    if (connected) {
      this.connecting = false;
      queueMicrotask(() => this.emit("connect"));
    }
    this._startRead();
    return this;
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

  _startRead() {
    if (this.fd == null || this.destroyed || this._watchId || typeof cottontail.fdWatchStart !== "function") return this;
    const fdWatchListeners = installFdWatchDispatcher();
    const watch = cottontail.fdWatchStart(this.fd, 64 * 1024);
    this._watchId = Number(watch?.id || 0);
    if (!this._watchId) return this;
    fdWatchListeners.set(this._watchId, (event) => {
      if (this.destroyed) return;
      if (event.type === "data") {
        const chunk = chunkFromBytes(event.data ?? new ArrayBuffer(0), this._encoding);
        const length = Number(chunk?.byteLength ?? chunk?.length ?? 0);
        if (length > 0) {
          this.bytesRead += length;
          this.emit("data", chunk);
        }
        return;
      }
      if (event.type === "end") {
        this.readable = false;
        this._stopRead();
        this.emit("end");
        if (!this.allowHalfOpen) this.destroy();
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
        if (typeof cottontail.tcpSocketConnect !== "function") throw unsupported("net.Socket.connect");
        const result = cottontail.tcpSocketConnect(Number(options.port), options.host ?? "127.0.0.1", Number(options.family ?? 4));
        this._attachFd(result.fd, result.local, result.remote, true);
      } catch (error) {
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
    if (this.destroyed || this.fd == null || !this.writable) {
      const error = new Error("Socket is closed");
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      this.emit("error", error);
      return false;
    }
    const bytes = bytesFrom(chunk, encoding);
    const ok = cottontail.fdWrite?.(this.fd, bytes) === true;
    if (ok) this.bytesWritten += bytes.byteLength;
    if (typeof callback === "function") queueMicrotask(() => callback(ok ? undefined : new Error("socket write failed")));
    if (!ok) this.emit("error", new Error("socket write failed"));
    return ok;
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === "function") callback = chunk;
    else if (typeof encoding === "function") callback = encoding;
    if (chunk != null) this.write(chunk, encoding);
    this.writable = false;
    this.emit("finish");
    if (this.fd != null) {
      try { cottontail.tcpSocketShutdown?.(this.fd); } catch {}
    }
    if (typeof callback === "function") callback();
    return this;
  }

  destroy(error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable = false;
    this.writable = false;
    this._stopRead();
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
    try { return cottontail.tcpSocketAddress(this.fd, false); } catch { return {}; }
  }
  setEncoding(encoding = "utf8") {
    this._encoding = String(encoding || "utf8").toLowerCase();
    return this;
  }
  setKeepAlive() { return this; }
  setNoDelay() { return this; }
  setTimeout(_timeout, callback) {
    if (typeof callback === "function") this.once("timeout", callback);
    return this;
  }
  pause() { return this; }
  resume() { return this; }
  ref() { return this; }
  unref() { return this; }
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
    this._acceptTimer = null;
    if (typeof connectionListener === "function") this.on("connection", connectionListener);
  }

  listen(...args) {
    const [options, callback] = _normalizeArgs(args);
    if (callback) this.once("listening", callback);
    queueMicrotask(() => {
      try {
        if (typeof cottontail.tcpServerListen !== "function") throw unsupported("net.Server.listen");
        const result = cottontail.tcpServerListen(Number(options.port ?? 0), options.host ?? "127.0.0.1", Number(options.family ?? 4));
        this._fd = Number(result.fd);
        this._address = result.address ?? null;
        this.listening = true;
        this._acceptTimer = setInterval(() => this._acceptPending(), 1);
        this.emit("listening");
      } catch (error) {
        this.emit("error", error);
      }
    });
    return this;
  }

  _acceptPending() {
    if (!this.listening || this._fd == null) return;
    for (;;) {
      let accepted;
      try {
        accepted = cottontail.tcpServerAccept(this._fd);
      } catch (error) {
        this.emit("error", error);
        return;
      }
      if (accepted == null) return;
      const socket = new Socket({ fd: accepted.fd, local: accepted.local, remote: accepted.remote });
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
    this.listening = false;
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  address() { return this._address; }
  getConnections(callback) { callback(null, this.connections); }
  ref() { return this; }
  unref() { return this; }
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
  return new Socket().connect(...args);
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
  else {
    options.port = list[0];
    if (typeof list[1] === "string") options.host = list[1];
  }
  return [options, callback];
}

export function _createServerHandle() {
  throw unsupported("net._createServerHandle");
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

// COTTONTAIL-COMPAT: node:net sockets - address helpers, BlockList, and basic TCP connect/listen/read/write/end are implemented; advanced socket options, backpressure, IPC pipes, and handle sharing need deeper native socket bindings.
