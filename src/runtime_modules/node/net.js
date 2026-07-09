import { EventEmitter } from "./events.js";

function unsupported(name) {
  return new Error(`${name} is not implemented in Cottontail yet`);
}

export class Socket extends EventEmitter {
  constructor(options = {}) {
    super();
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
  }

  connect(...args) {
    const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
    if (callback) this.once("connect", callback);
    this.connecting = true;
    queueMicrotask(() => {
      this.connecting = false;
      const error = unsupported("net.Socket.connect");
      this.destroy(error);
    });
    return this;
  }

  write(_chunk, _encoding, callback) {
    if (typeof _encoding === "function") callback = _encoding;
    if (typeof callback === "function") callback(unsupported("net.Socket.write"));
    return false;
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === "function") callback = chunk;
    else if (typeof encoding === "function") callback = encoding;
    if (chunk != null) this.write(chunk, encoding);
    this.writable = false;
    this.emit("finish");
    this.emit("end");
    if (typeof callback === "function") callback();
    return this;
  }

  destroy(error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable = false;
    this.writable = false;
    if (error) this.emit("error", error);
    this.emit("close", Boolean(error));
    return this;
  }

  setEncoding() { return this; }
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

export function connect(...args) {
  return new Socket().connect(...args);
}

export const createConnection = connect;

export function createServer() {
  throw unsupported("net.createServer");
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
  Socket,
  connect,
  createConnection,
  createServer,
  isIP,
  isIPv4,
  isIPv6,
};
