import { EventEmitter } from "./events.js";
import { Buffer } from "./buffer.js";

function familyFromType(type = "udp4") {
  return String(type).toLowerCase() === "udp6" ? 6 : 4;
}

function defaultAddress(family) {
  return family === 6 ? "::" : "0.0.0.0";
}

function bytesFromMessage(message, offset = 0, length = undefined) {
  const bytes = Array.isArray(message)
    ? Buffer.concat(message.map((item) => Buffer.from(item)))
    : Buffer.from(message);
  const start = Number(offset) || 0;
  const end = length == null ? bytes.byteLength : start + Number(length);
  return bytes.subarray(start, end);
}

function normalizeCreateOptions(options = "udp4") {
  if (typeof options === "string") return { type: options };
  return { ...(options ?? {}), type: options?.type ?? "udp4" };
}

function normalizeBindArgs(args) {
  const list = Array.from(args);
  const callback = typeof list[list.length - 1] === "function" ? list.pop() : undefined;
  if (typeof list[0] === "object" && list[0] !== null) {
    return [{ ...list[0] }, callback];
  }
  const options = {
    port: list[0] ?? 0,
    address: typeof list[1] === "string" ? list[1] : undefined,
  };
  return [options, callback];
}

function normalizeSendArgs(args, remote) {
  const list = Array.from(args);
  const callback = typeof list[list.length - 1] === "function" ? list.pop() : undefined;
  const message = list[0];
  let offset = 0;
  let length;
  let port;
  let address;
  if (typeof list[1] === "number" && typeof list[2] === "number" && typeof list[3] === "number") {
    offset = list[1];
    length = list[2];
    port = list[3];
    address = list[4];
  } else {
    port = list[1];
    address = list[2];
  }
  if (port == null && remote) port = remote.port;
  if (address == null && remote) address = remote.address;
  return {
    message,
    offset,
    length,
    port: Number(port),
    address,
    callback,
  };
}

export function _createSocketHandle(type = "udp4") {
  if (typeof cottontail.udpSocketCreate !== "function") {
    throw new Error("native UDP sockets are unavailable");
  }
  return cottontail.udpSocketCreate(familyFromType(type));
}

export class Socket extends EventEmitter {
  constructor(options = "udp4", messageListener = undefined) {
    super();
    const normalized = normalizeCreateOptions(options);
    this.type = normalized.type;
    this.family = familyFromType(this.type);
    this.fd = _createSocketHandle(this.type).fd;
    this.bound = false;
    this.closed = false;
    this.remote = null;
    this._pollTimer = null;
    if (typeof messageListener === "function") this.on("message", messageListener);
  }

  bind(...args) {
    const [options, callback] = normalizeBindArgs(args);
    if (typeof callback === "function") this.once("listening", callback);
    const address = options.address ?? defaultAddress(this.family);
    const port = Number(options.port ?? 0);
    queueMicrotask(() => {
      try {
        cottontail.udpSocketBind(this.fd, port, address, this.family);
        this.bound = true;
        this._startPolling();
        this.emit("listening");
      } catch (error) {
        this.emit("error", error);
      }
    });
    return this;
  }

  connect(port, address = undefined, callback = undefined) {
    if (typeof address === "function") {
      callback = address;
      address = undefined;
    }
    this.remote = { port: Number(port), address: address ?? (this.family === 6 ? "::1" : "127.0.0.1") };
    if (typeof callback === "function") queueMicrotask(callback);
    this.emit("connect");
  }

  disconnect() {
    this.remote = null;
  }

  send(...args) {
    const { message, offset, length, port, address, callback } = normalizeSendArgs(args, this.remote);
    const targetAddress = address ?? (this.family === 6 ? "::1" : "127.0.0.1");
    if (!Number.isFinite(port)) {
      const error = new RangeError("UDP send requires a target port");
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      else throw error;
      return;
    }
    try {
      const bytes = bytesFromMessage(message, offset, length);
      const sent = cottontail.udpSocketSend(this.fd, bytes, port, targetAddress, this.family);
      if (typeof callback === "function") queueMicrotask(() => callback(null, sent));
    } catch (error) {
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      else throw error;
    }
  }

  close(callback = undefined) {
    if (typeof callback === "function") this.once("close", callback);
    if (this.closed) return this;
    this.closed = true;
    if (this._pollTimer != null) clearInterval(this._pollTimer);
    this._pollTimer = null;
    try {
      cottontail.udpSocketClose(this.fd);
    } finally {
      queueMicrotask(() => this.emit("close"));
    }
    return this;
  }

  address() {
    if (this.closed) throw new Error("Socket is closed");
    return cottontail.udpSocketAddress(this.fd);
  }

  remoteAddress() {
    if (!this.remote) throw new Error("UDP socket is not connected");
    return { ...this.remote, family: this.family === 6 ? "IPv6" : "IPv4" };
  }

  ref() { return this; }
  unref() { return this; }

  _startPolling() {
    if (this._pollTimer != null || this.closed) return;
    this._pollTimer = setInterval(() => this._poll(), 1);
  }

  _poll() {
    if (this.closed) return;
    try {
      for (;;) {
        const packet = cottontail.udpSocketReceive(this.fd, 65536);
        if (!packet) break;
        this.emit("message", Buffer.from(packet.data), packet.rinfo);
      }
    } catch (error) {
      if (!this.closed) this.emit("error", error);
    }
  }
}

export function createSocket(options, callback = undefined) {
  if (typeof options === "string") return new Socket(options, callback);
  return new Socket(options, callback);
}

// COTTONTAIL-COMPAT: node:dgram multicast/options - UDP bind/send/receive/close are backed by native datagram sockets; multicast membership, broadcast/TTL tuning, and platform-specific socket options need additional native setsockopt bindings.

export default {
  Socket,
  _createSocketHandle,
  createSocket,
};
