import { Buffer } from "../node/buffer.js";
import { createConnection as createNetConnection, isIP } from "../node/net.js";
import { connect as createTlsConnection } from "../node/tls.js";

const redisProtocols = new Set([
  "redis:",
  "rediss:",
  "redis+tls:",
  "redis+unix:",
  "redis+tls+unix:",
  "valkey:",
  "valkeys:",
  "valkey+tls:",
  "valkey+unix:",
  "valkey+tls+unix:",
]);

const incompleteReply = Symbol("incomplete Redis reply");

class RESPBlob {
  constructor(bytes) {
    this.bytes = bytes;
  }
}

class RESPMap {
  constructor(entries) {
    this.entries = entries;
  }
}

class RESPPush {
  constructor(value) {
    this.value = value;
  }
}

function redisError(message) {
  return new Error(String(message));
}

function invalidURL(message = "Invalid URL format") {
  return new TypeError(message);
}

function parsePortFromAuthority(urlText) {
  const schemeEnd = urlText.indexOf("://");
  if (schemeEnd < 0) return undefined;
  let authority = urlText.slice(schemeEnd + 3).split(/[/?#]/, 1)[0];
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) throw invalidURL();
    const suffix = authority.slice(close + 1);
    if (suffix === "") return undefined;
    if (!/^:\d+$/.test(suffix)) throw invalidURL("Invalid port number in URL");
    return Number(suffix.slice(1));
  }
  const colon = authority.lastIndexOf(":");
  if (colon < 0) return undefined;
  const portText = authority.slice(colon + 1);
  if (!/^\d+$/.test(portText)) throw invalidURL("Invalid port number in URL");
  return Number(portText);
}

function normalizeClientOptions(options) {
  if (options == null) options = {};
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("RedisClient options must be an object");
  }

  const numberOption = (name, fallback) => {
    if (options[name] == null) return fallback;
    const value = Number(options[name]);
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`${name} must be an unsigned 32-bit integer`);
    }
    return value;
  };

  if (options.tls != null && typeof options.tls !== "boolean" && typeof options.tls !== "object") {
    throw new TypeError("tls must be a boolean or object");
  }

  return {
    autoReconnect: options.autoReconnect == null ? true : Boolean(options.autoReconnect),
    connectionTimeout: numberOption("connectionTimeout", 10_000),
    db: options.db == null ? undefined : numberOption("db", 0),
    enableAutoPipelining: options.enableAutoPipelining == null ? true : Boolean(options.enableAutoPipelining),
    enableOfflineQueue: options.enableOfflineQueue == null ? true : Boolean(options.enableOfflineQueue),
    idleTimeout: numberOption("idleTimeout", 0),
    maxRetries: numberOption("maxRetries", 20),
    password: options.password == null ? undefined : String(options.password),
    tls: options.tls,
    username: options.username == null ? undefined : String(options.username),
  };
}

function parseRedisURL(input, options) {
  let source;
  if (input == null) {
    source = globalThis.process?.env?.REDIS_URL ?? globalThis.process?.env?.VALKEY_URL ?? "valkey://localhost:6379";
  } else {
    source = String(input);
  }
  if (source.length === 0 || /[\u0000\s]/.test(source)) throw invalidURL();

  let normalized = source;
  if (!normalized.includes("://")) {
    if (!/^(?:\[[0-9a-f:.]+\]|[^/:]+)(?::\d+)?(?:\/\d+)?$/i.test(normalized)) throw invalidURL();
    normalized = `valkey://${normalized}`;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) throw invalidURL();

  const protocolText = normalized.slice(0, normalized.indexOf("://") + 1).toLowerCase();
  if (!redisProtocols.has(protocolText)) {
    throw new TypeError(
      "Expected url protocol to be one of redis, valkey, rediss, valkeys, redis+tls, redis+unix, redis+tls+unix",
    );
  }

  const isUnix = protocolText.includes("+unix:");
  const explicitPort = isUnix ? undefined : parsePortFromAuthority(normalized);
  if (explicitPort === 0) throw invalidURL("Port 0 is not valid for TCP connections");
  if (explicitPort != null && explicitPort > 65535) {
    throw invalidURL("Invalid port number in URL. Port must be a number between 0 and 65535");
  }

  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw invalidURL();
  }

  const isTLS = protocolText === "rediss:" || protocolText === "valkeys:" || protocolText.includes("+tls:");
  let path;
  let host;
  let port;
  if (isUnix) {
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      throw invalidURL();
    }
    if (!path) throw invalidURL("Expected unix socket path after valkey+unix:// or valkey+tls+unix://");
  } else {
    host = url.hostname;
    if (!host) throw invalidURL();
    port = explicitPort ?? 6379;
  }

  let username;
  let password;
  try {
    username = options.username ?? decodeURIComponent(url.username);
    password = options.password ?? decodeURIComponent(url.password);
  } catch {
    throw invalidURL();
  }

  let database = options.db;
  if (database == null && !isUnix && url.pathname.length > 1) {
    const databaseText = url.pathname.slice(1);
    database = /^\d+$/.test(databaseText) ? Number(databaseText) : 0;
  }
  database ??= 0;
  if (!Number.isSafeInteger(database) || database < 0) throw new RangeError("db must be a non-negative integer");

  return {
    database,
    host,
    isTLS: isTLS || options.tls === true || (options.tls != null && typeof options.tls === "object"),
    isUnix,
    normalized,
    password,
    path,
    port,
    protocol: protocolText,
    username,
  };
}

function commandBytes(value, fieldName = "argument") {
  if (typeof value === "string") return Buffer.from(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${fieldName} must be a finite number`);
    return Buffer.from(String(value));
  }
  if (typeof value === "bigint") return Buffer.from(String(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new TypeError(`${fieldName} must be a string, number, ArrayBuffer, or buffer view`);
}

function encodeCommand(command, args) {
  const values = [commandBytes(command, "command"), ...args.map((value) => commandBytes(value))];
  const chunks = [Buffer.from(`*${values.length}\r\n`)];
  for (const value of values) {
    chunks.push(Buffer.from(`$${value.byteLength}\r\n`), value, Buffer.from("\r\n"));
  }
  return Buffer.concat(chunks);
}

function lineAt(buffer, offset) {
  const end = buffer.indexOf("\r\n", offset);
  if (end < 0) throw incompleteReply;
  return { end, next: end + 2, text: buffer.toString("utf8", offset, end) };
}

function parseInteger(text) {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    try {
      return BigInt(text);
    } catch {
      throw redisError("Invalid integer response");
    }
  }
  return value;
}

function parseRESP(buffer, offset = 0) {
  if (offset >= buffer.length) throw incompleteReply;
  const type = String.fromCharCode(buffer[offset]);
  let line;
  let count;
  let cursor;

  switch (type) {
    case "+":
      line = lineAt(buffer, offset + 1);
      return { next: line.next, value: line.text };
    case "-":
      line = lineAt(buffer, offset + 1);
      return { next: line.next, value: redisError(line.text) };
    case ":":
      line = lineAt(buffer, offset + 1);
      return { next: line.next, value: parseInteger(line.text) };
    case ",":
      line = lineAt(buffer, offset + 1);
      return { next: line.next, value: Number(line.text) };
    case "(":
      line = lineAt(buffer, offset + 1);
      try {
        return { next: line.next, value: BigInt(line.text) };
      } catch {
        throw redisError("Invalid big number response");
      }
    case "#":
      line = lineAt(buffer, offset + 1);
      if (line.text !== "t" && line.text !== "f") throw redisError("Invalid boolean response");
      return { next: line.next, value: line.text === "t" };
    case "_":
      line = lineAt(buffer, offset + 1);
      if (line.text !== "") throw redisError("Invalid null response");
      return { next: line.next, value: null };
    case "$":
    case "!":
    case "=": {
      line = lineAt(buffer, offset + 1);
      if (line.text === "?") return parseStreamedBlob(buffer, line.next, type);
      const length = Number(line.text);
      if (!Number.isInteger(length) || length < -1) throw redisError("Invalid bulk string length");
      if (length === -1) return { next: line.next, value: null };
      const end = line.next + length;
      if (end + 2 > buffer.length) throw incompleteReply;
      if (buffer[end] !== 13 || buffer[end + 1] !== 10) throw redisError("Invalid bulk string terminator");
      let bytes = Buffer.from(buffer.subarray(line.next, end));
      if (type === "=") {
        const colon = bytes.indexOf(58);
        if (colon >= 0) bytes = Buffer.from(bytes.subarray(colon + 1));
      }
      if (type === "!") return { next: end + 2, value: redisError(bytes.toString()) };
      return { next: end + 2, value: new RESPBlob(bytes) };
    }
    case "*":
    case "~":
    case ">":
    case "%": {
      line = lineAt(buffer, offset + 1);
      if (line.text === "?") return parseStreamedAggregate(buffer, line.next, type);
      count = Number(line.text);
      if (!Number.isInteger(count) || count < -1) throw redisError("Invalid aggregate length");
      if (count === -1) return { next: line.next, value: null };
      cursor = line.next;
      const values = [];
      const entries = type === "%" ? count * 2 : count;
      for (let index = 0; index < entries; index += 1) {
        const parsed = parseRESP(buffer, cursor);
        cursor = parsed.next;
        values.push(parsed.value);
      }
      if (type === "%") {
        const pairs = [];
        for (let index = 0; index < values.length; index += 2) pairs.push([values[index], values[index + 1]]);
        return { next: cursor, value: new RESPMap(pairs) };
      }
      if (type === ">") return { next: cursor, value: new RESPPush(values) };
      return { next: cursor, value: values };
    }
    case "|": {
      line = lineAt(buffer, offset + 1);
      count = Number(line.text);
      if (!Number.isInteger(count) || count < 0) throw redisError("Invalid attribute length");
      cursor = line.next;
      for (let index = 0; index < count * 2; index += 1) cursor = parseRESP(buffer, cursor).next;
      return parseRESP(buffer, cursor);
    }
    default:
      throw redisError(`Invalid RESP response type ${JSON.stringify(type)}`);
  }
}

function parseStreamedBlob(buffer, offset, type) {
  const chunks = [];
  let cursor = offset;
  while (true) {
    if (cursor >= buffer.length) throw incompleteReply;
    if (buffer[cursor] !== 59) throw redisError("Invalid streamed bulk string chunk");
    const line = lineAt(buffer, cursor + 1);
    const length = Number(line.text);
    if (!Number.isInteger(length) || length < 0) throw redisError("Invalid streamed bulk string length");
    cursor = line.next;
    if (length === 0) break;
    if (cursor + length + 2 > buffer.length) throw incompleteReply;
    chunks.push(Buffer.from(buffer.subarray(cursor, cursor + length)));
    cursor += length;
    if (buffer[cursor] !== 13 || buffer[cursor + 1] !== 10) throw redisError("Invalid streamed bulk string terminator");
    cursor += 2;
  }
  const bytes = Buffer.concat(chunks);
  if (type === "!") return { next: cursor, value: redisError(bytes.toString()) };
  return { next: cursor, value: new RESPBlob(bytes) };
}

function parseStreamedAggregate(buffer, offset, type) {
  const values = [];
  let cursor = offset;
  while (true) {
    if (cursor + 3 > buffer.length) throw incompleteReply;
    if (buffer[cursor] === 46 && buffer[cursor + 1] === 13 && buffer[cursor + 2] === 10) {
      cursor += 3;
      break;
    }
    const parsed = parseRESP(buffer, cursor);
    cursor = parsed.next;
    values.push(parsed.value);
  }
  if (type === "%") {
    if (values.length % 2 !== 0) throw redisError("Invalid streamed map response");
    const pairs = [];
    for (let index = 0; index < values.length; index += 2) pairs.push([values[index], values[index + 1]]);
    return { next: cursor, value: new RESPMap(pairs) };
  }
  if (type === ">") return { next: cursor, value: new RESPPush(values) };
  return { next: cursor, value: values };
}

function decodeReply(value, returnBuffers = false) {
  if (value instanceof RESPBlob) return returnBuffers ? Buffer.from(value.bytes) : value.bytes.toString("utf8");
  if (value instanceof RESPMap) {
    const object = {};
    for (const [rawKey, rawValue] of value.entries) {
      const key = decodeReply(rawKey, false);
      object[String(key)] = decodeReply(rawValue, returnBuffers);
    }
    return object;
  }
  if (Array.isArray(value)) return value.map((entry) => decodeReply(entry, returnBuffers));
  return value;
}

async function materializeTLSValue(value) {
  if (Array.isArray(value)) return Promise.all(value.map(materializeTLSValue));
  if (value && typeof value.arrayBuffer === "function" && !ArrayBuffer.isView(value)) {
    return Buffer.from(await value.arrayBuffer());
  }
  return value;
}

async function materializeTLSOptions(options) {
  if (!options || typeof options !== "object") return {};
  const result = { ...options };
  for (const key of ["ca", "cert", "key", "pfx"]) {
    if (key in result) result[key] = await materializeTLSValue(result[key]);
  }
  return result;
}

class RedisClientImplementation {
  constructor(url, rawOptions) {
    this._options = normalizeClientOptions(rawOptions);
    this._address = parseRedisURL(url, this._options);
    this._sourceURL = this._address.normalized;
    this._rawOptions = rawOptions == null ? {} : { ...rawOptions };
    this._socket = null;
    this._readBuffer = Buffer.alloc(0);
    this._pending = [];
    this._offline = [];
    this._connectPromise = null;
    this._connectResolve = null;
    this._connectReject = null;
    this._connectionTimer = null;
    this._reconnectTimer = null;
    this._retryCount = 0;
    this._connected = false;
    this._connecting = false;
    this._failed = false;
    this._manualClosed = false;
    this._referenced = true;
    this._hello = undefined;
    this._lastSocketError = null;
    this._handledSocketClose = false;
    this._subscriptions = new Map();
    this._patternSubscriptions = new Map();
    this._onconnect = undefined;
    this._onclose = undefined;
  }

  get connected() {
    return this._connected;
  }

  get bufferedAmount() {
    let amount = this._readBuffer.length + Number(this._socket?.writableLength ?? 0);
    for (const entry of this._offline) amount += entry.data.length;
    return amount;
  }

  get onconnect() {
    return this._onconnect;
  }

  set onconnect(value) {
    this._onconnect = value;
  }

  get onclose() {
    return this._onclose;
  }

  set onclose(value) {
    this._onclose = value;
  }

  connect() {
    if (this._connected) return Promise.resolve(this._hello);
    if (this._connectPromise) return this._connectPromise;
    this._manualClosed = false;
    this._failed = false;
    this._retryCount = 0;
    this._connectPromise = new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;
    });
    this._openConnection();
    return this._connectPromise;
  }

  async _openConnection() {
    if (this._manualClosed || this._connecting || this._connected) return;
    this._connecting = true;
    this._handledSocketClose = false;
    this._lastSocketError = null;

    try {
      const address = this._address;
      let socket;
      if (address.isTLS) {
        const customTLS = typeof this._options.tls === "object" ? await materializeTLSOptions(this._options.tls) : {};
        if (this._manualClosed || !this._connecting) return;
        const socketOptions = address.isUnix
          ? { ...customTLS, path: address.path }
          : { ...customTLS, host: address.host, port: address.port };
        if (!address.isUnix && customTLS.servername == null && isIP(address.host) === 0) socketOptions.servername = address.host;
        socket = createTlsConnection(socketOptions);
        socket.once("secureConnect", () => this._onTransportConnected(socket));
      } else {
        socket = createNetConnection(address.isUnix ? { path: address.path } : { host: address.host, port: address.port });
        socket.once("connect", () => this._onTransportConnected(socket));
      }
      this._socket = socket;
      if (!this._referenced) socket.unref?.();
      socket.on("data", (chunk) => this._onData(socket, chunk));
      socket.on("error", (error) => {
        if (socket !== this._socket) return;
        this._lastSocketError = error;
      });
      socket.once("close", () => this._onSocketClose(socket));
      if (this._options.idleTimeout > 0) {
        socket.setTimeout?.(this._options.idleTimeout, () => socket.destroy(redisError("Connection idle timeout reached")));
      }
      this._connectionTimer = setTimeout(() => {
        if (socket !== this._socket || this._connected) return;
        socket.destroy(redisError(`Connection timeout reached after ${this._options.connectionTimeout}ms`));
      }, this._options.connectionTimeout);
      if (!this._referenced) this._connectionTimer.unref?.();
    } catch (error) {
      this._connecting = false;
      this._handleConnectionFailure(error instanceof Error ? error : redisError(error));
    }
  }

  async _onTransportConnected(socket) {
    if (socket !== this._socket || this._manualClosed) return;
    try {
      const helloArgs = ["3"];
      if (this._address.username || this._address.password) {
        helloArgs.push("AUTH", this._address.username || "default", this._address.password || "");
      }
      this._hello = await this._requestNow("HELLO", helloArgs, { internal: true });
      if (this._address.database > 0) await this._requestNow("SELECT", [this._address.database], { internal: true });
      if (socket !== this._socket || this._manualClosed) return;
      clearTimeout(this._connectionTimer);
      this._connectionTimer = null;
      this._connecting = false;
      this._connected = true;
      this._failed = false;
      this._retryCount = 0;
      const resolve = this._connectResolve;
      this._connectPromise = null;
      this._connectResolve = null;
      this._connectReject = null;
      resolve?.(this._hello);
      if (typeof this.onconnect === "function") queueMicrotask(() => this.onconnect?.(this._hello));
      this._flushOffline();
    } catch (error) {
      if (socket === this._socket) socket.destroy(error instanceof Error ? error : redisError(error));
    }
  }

  _onData(socket, chunk) {
    if (socket !== this._socket) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this._readBuffer = this._readBuffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([this._readBuffer, bytes]);
    let offset = 0;
    try {
      while (offset < this._readBuffer.length) {
        let parsed;
        try {
          parsed = parseRESP(this._readBuffer, offset);
        } catch (error) {
          if (error === incompleteReply) break;
          throw error;
        }
        offset = parsed.next;
        if (parsed.value instanceof RESPPush) this._handlePush(parsed.value.value);
        else this._handleReply(parsed.value);
      }
    } catch (error) {
      socket.destroy(error instanceof Error ? error : redisError(error));
    }
    if (offset > 0) this._readBuffer = Buffer.from(this._readBuffer.subarray(offset));
  }

  _handleReply(value) {
    const entry = this._pending.shift();
    if (!entry) return;
    if (value instanceof Error) entry.reject(value);
    else entry.resolve(decodeReply(value, entry.returnBuffers));
  }

  _handlePush(rawValues) {
    const values = decodeReply(rawValues, false);
    const kind = String(values[0] ?? "").toLowerCase();
    if (kind === "subscribe" || kind === "psubscribe" || kind === "unsubscribe" || kind === "punsubscribe") {
      const entry = this._pending[0];
      if (entry?.subscriptionKind === kind) {
        this._pending.shift();
        entry.resolve(values[2]);
      }
      return;
    }
    if (kind === "message") {
      const listeners = this._subscriptions.get(String(values[1]));
      if (listeners) for (const listener of [...listeners]) queueMicrotask(() => listener(values[2], values[1]));
      return;
    }
    if (kind === "pmessage") {
      const listeners = this._patternSubscriptions.get(String(values[1]));
      if (listeners) for (const listener of [...listeners]) queueMicrotask(() => listener(values[3], values[2], values[1]));
      return;
    }
    const entry = this._pending.shift();
    if (entry) entry.resolve(values);
  }

  _requestNow(command, args, metadata = {}) {
    const data = encodeCommand(command, args);
    return new Promise((resolve, reject) => {
      const entry = { ...metadata, command, data, reject, resolve, returnBuffers: Boolean(metadata.returnBuffers) };
      this._pending.push(entry);
      try {
        this._socket.write(data);
      } catch (error) {
        const index = this._pending.indexOf(entry);
        if (index >= 0) this._pending.splice(index, 1);
        reject(error);
      }
    });
  }

  _flushOffline() {
    if (!this._connected || !this._socket || this._offline.length === 0) return;
    const entries = this._offline.splice(0);
    for (const entry of entries) {
      this._pending.push(entry);
      try {
        this._socket.write(entry.data);
      } catch (error) {
        const index = this._pending.indexOf(entry);
        if (index >= 0) this._pending.splice(index, 1);
        entry.reject(error);
      }
    }
  }

  _queueCommand(command, args, metadata = {}) {
    if (this._manualClosed || this._failed) return Promise.reject(redisError("Connection has failed"));
    const data = encodeCommand(command, args);
    return new Promise((resolve, reject) => {
      const entry = { ...metadata, command, data, reject, resolve, returnBuffers: Boolean(metadata.returnBuffers) };
      if (this._connected && this._socket) {
        this._pending.push(entry);
        try {
          this._socket.write(data);
        } catch (error) {
          const index = this._pending.indexOf(entry);
          if (index >= 0) this._pending.splice(index, 1);
          reject(error);
        }
        return;
      }

      this.connect().catch(() => {});
      if (!this._options.enableOfflineQueue) {
        reject(redisError("Connection is closed and offline queue is disabled"));
        return;
      }
      this._offline.push(entry);
    });
  }

  _onSocketClose(socket) {
    if (socket !== this._socket || this._handledSocketClose) return;
    this._handledSocketClose = true;
    const wasConnected = this._connected;
    const error = this._lastSocketError ?? redisError("Connection closed");
    this._socket = null;
    this._connected = false;
    this._connecting = false;
    clearTimeout(this._connectionTimer);
    this._connectionTimer = null;
    this._readBuffer = Buffer.alloc(0);

    const pending = this._pending.splice(0);
    for (const entry of pending) entry.reject(error);
    if (!this._manualClosed && this._options.autoReconnect && this._retryCount < this._options.maxRetries) {
      if (typeof this.onclose === "function") queueMicrotask(() => this.onclose?.(error));
      this._retryCount += 1;
      const delay = Math.min(50 * 2 ** (this._retryCount - 1), 1_000);
      this._reconnectTimer = setTimeout(() => this._openConnection(), delay);
      if (!this._referenced) this._reconnectTimer.unref?.();
      return;
    }

    if (!wasConnected) this._handleConnectionFailure(error);
    else {
      this._failed = true;
      const offline = this._offline.splice(0);
      for (const entry of offline) entry.reject(error);
      if (typeof this.onclose === "function") queueMicrotask(() => this.onclose?.(error));
    }
  }

  _handleConnectionFailure(error) {
    this._failed = true;
    const reject = this._connectReject;
    this._connectPromise = null;
    this._connectResolve = null;
    this._connectReject = null;
    reject?.(error);
    const offline = this._offline.splice(0);
    for (const entry of offline) entry.reject(error);
    if (typeof this.onclose === "function") queueMicrotask(() => this.onclose?.(error));
  }

  close() {
    const wasActive = this._connected || this._connecting || this._socket != null;
    this._manualClosed = true;
    this._failed = true;
    this._connected = false;
    this._connecting = false;
    clearTimeout(this._connectionTimer);
    clearTimeout(this._reconnectTimer);
    this._connectionTimer = null;
    this._reconnectTimer = null;
    const error = redisError("Connection has failed");
    const reject = this._connectReject;
    this._connectPromise = null;
    this._connectResolve = null;
    this._connectReject = null;
    reject?.(error);
    for (const entry of this._pending.splice(0)) entry.reject(error);
    for (const entry of this._offline.splice(0)) entry.reject(error);
    const socket = this._socket;
    this._socket = null;
    if (socket) socket.destroy();
    if (wasActive && typeof this.onclose === "function") queueMicrotask(() => this.onclose?.(error));
  }

  ref() {
    this._referenced = true;
    this._socket?.ref?.();
    this._connectionTimer?.ref?.();
    this._reconnectTimer?.ref?.();
    return this;
  }

  unref() {
    this._referenced = false;
    this._socket?.unref?.();
    this._connectionTimer?.unref?.();
    this._reconnectTimer?.unref?.();
    return this;
  }

  send(command, args) {
    if (!Array.isArray(args)) throw new TypeError("Arguments must be an array");
    return this._queueCommand(String(command), args);
  }

  getBuffer(key) {
    this._requireNotSubscriber("getBuffer");
    return this._queueCommand("GET", [key], { returnBuffers: true });
  }

  exists(key) {
    this._requireNotSubscriber("exists");
    return this._queueCommand("EXISTS", [key]).then(Boolean);
  }

  sismember(key, member) {
    this._requireNotSubscriber("sismember");
    return this._queueCommand("SISMEMBER", [key, member]).then(Boolean);
  }

  hexists(key, field) {
    this._requireNotSubscriber("hexists");
    return this._queueCommand("HEXISTS", [key, field]).then(Boolean);
  }

  hsetnx(key, field, value) {
    this._requireNotSubscriber("hsetnx");
    return this._queueCommand("HSETNX", [key, field, value]).then(Boolean);
  }

  smove(source, destination, member) {
    this._requireNotSubscriber("smove");
    return this._queueCommand("SMOVE", [source, destination, member]).then(Boolean);
  }

  set(key, value, ...options) {
    this._requireNotSubscriber("set");
    const args = [key, value];
    for (const option of options) {
      if (option == null) break;
      args.push(option);
    }
    return this._queueCommand("SET", args);
  }

  ping(message) {
    return this._queueCommand("PING", message == null ? [] : [message]);
  }

  hmget(key, fields, ...rest) {
    this._requireNotSubscriber("hmget");
    const values = Array.isArray(fields) ? fields : [fields, ...rest.filter((value) => value != null)];
    if (values.length === 0 || values[0] == null) throw new TypeError("HMGET requires at least a key and one field");
    return this._queueCommand("HMGET", [key, ...values]);
  }

  hset(key, fields, ...rest) {
    return this._hashSet("HSET", key, fields, rest);
  }

  hmset(key, fields, ...rest) {
    return this._hashSet("HMSET", key, fields, rest);
  }

  _hashSet(command, key, fields, rest) {
    this._requireNotSubscriber(command.toLowerCase());
    let pairs;
    if (Array.isArray(fields)) pairs = fields;
    else if (fields && typeof fields === "object" && !ArrayBuffer.isView(fields) && !(fields instanceof ArrayBuffer)) {
      pairs = [];
      for (const [field, value] of Object.entries(fields)) pairs.push(field, value);
    } else pairs = [fields, ...rest];
    if (pairs.length === 0 || pairs.length % 2 !== 0) throw new TypeError(`${command} requires field-value pairs`);
    return this._queueCommand(command, [key, ...pairs]);
  }

  async duplicate() {
    const duplicate = new RedisClient(this._sourceURL, this._rawOptions);
    if (this._connected && !this._manualClosed) await duplicate.connect();
    return duplicate;
  }

  subscribe(channelOrChannels, listener) {
    return this._subscribe(false, channelOrChannels, listener);
  }

  psubscribe(channelOrChannels, listener) {
    return this._subscribe(true, channelOrChannels, listener);
  }

  _subscribe(pattern, channelOrChannels, listener) {
    if (typeof listener !== "function") throw new TypeError("subscribe listener must be a function");
    const channels = Array.isArray(channelOrChannels) ? channelOrChannels : [channelOrChannels];
    if (channels.length === 0 || channels.some((channel) => typeof channel !== "string")) {
      throw new TypeError("subscribe channel must be a string or non-empty array of strings");
    }
    const subscriptions = pattern ? this._patternSubscriptions : this._subscriptions;
    for (const channel of channels) {
      let listeners = subscriptions.get(channel);
      if (!listeners) subscriptions.set(channel, listeners = new Set());
      listeners.add(listener);
    }
    const kind = pattern ? "psubscribe" : "subscribe";
    return this._queueCommand(kind.toUpperCase(), channels, { subscriptionKind: kind });
  }

  unsubscribe(channelOrChannels, listener) {
    return this._unsubscribe(false, channelOrChannels, listener);
  }

  punsubscribe(channelOrChannels, listener) {
    return this._unsubscribe(true, channelOrChannels, listener);
  }

  _unsubscribe(pattern, channelOrChannels, listener) {
    const subscriptions = pattern ? this._patternSubscriptions : this._subscriptions;
    if (subscriptions.size === 0) {
      throw redisError(`RedisClient.prototype.${pattern ? "punsubscribe" : "unsubscribe"} can only be called while in subscriber mode.`);
    }
    const channels = channelOrChannels == null
      ? [...subscriptions.keys()]
      : Array.isArray(channelOrChannels) ? channelOrChannels : [channelOrChannels];
    const sent = [];
    for (const channel of channels) {
      const listeners = subscriptions.get(channel);
      if (!listeners) continue;
      if (listener != null) {
        if (typeof listener !== "function") throw new TypeError("unsubscribe listener must be a function");
        listeners.delete(listener);
      } else listeners.clear();
      if (listeners.size === 0) {
        subscriptions.delete(channel);
        sent.push(channel);
      }
    }
    if (sent.length === 0) return Promise.resolve(undefined);
    const kind = pattern ? "punsubscribe" : "unsubscribe";
    return this._queueCommand(kind.toUpperCase(), sent, { subscriptionKind: kind });
  }

  _requireNotSubscriber(method) {
    if (this._subscriptions.size > 0 || this._patternSubscriptions.size > 0) {
      throw redisError(`RedisClient.prototype.${method} cannot be called while in subscriber mode.`);
    }
  }
}

const genericCommands = [
  "append", "bitcount", "blmove", "blmpop", "blpop", "brpop", "brpoplpush", "bzmpop", "bzpopmax", "bzpopmin",
  "copy", "decr", "decrby", "del", "dump", "expire", "expireat", "expiretime", "get", "getbit", "getdel", "getex",
  "getrange", "getset", "hdel", "hexpire", "hexpireat", "hexpiretime", "hget", "hgetall", "hgetdel", "hgetex",
  "hincrby", "hincrbyfloat", "hkeys", "hlen", "hpersist", "hpexpire", "hpexpireat", "hpexpiretime", "hpttl",
  "hrandfield", "hscan", "hsetex", "hstrlen", "httl", "hvals", "incr", "incrby", "incrbyfloat", "keys", "lindex",
  "linsert", "llen", "lmove", "lmpop", "lpop", "lpos", "lpush", "lpushx", "lrange", "lrem", "lset", "ltrim", "mget",
  "mset", "msetnx", "persist", "pexpire", "pexpireat", "pexpiretime", "pfadd", "psetex", "pttl", "publish", "pubsub", "randomkey",
  "rename", "renamenx", "rpop", "rpoplpush", "rpush", "rpushx", "sadd", "scan", "scard", "script", "sdiff",
  "sdiffstore", "select", "setbit", "setex", "setnx", "setrange", "sinter", "sintercard", "sinterstore", "smembers",
  "smismember", "spop", "spublish", "srandmember", "srem", "sscan", "strlen", "substr", "sunion", "sunionstore", "touch",
  "ttl", "type", "unlink", "zadd", "zcard", "zcount", "zdiff", "zdiffstore", "zincrby", "zinter", "zintercard", "zinterstore",
  "zlexcount", "zmpop", "zmscore", "zpopmax", "zpopmin", "zrandmember", "zrange", "zrangebylex", "zrangebyscore",
  "zrangestore", "zrem", "zremrangebylex", "zremrangebyrank", "zremrangebyscore", "zrevrange", "zrevrangebylex",
  "zrevrangebyscore", "zrevrank", "zscore", "zscan", "zunion", "zunionstore", "zrank",
];

for (const method of genericCommands) {
  if (method in RedisClientImplementation.prototype) continue;
  Object.defineProperty(RedisClientImplementation.prototype, method, {
    configurable: true,
    value: function (...args) {
      this._requireNotSubscriber(method);
      return this._queueCommand(method.toUpperCase(), args);
    },
    writable: true,
  });
}

export function RedisClient(...args) {
  if (!new.target) throw new TypeError("RedisClient constructor cannot be invoked without 'new'");
  return Reflect.construct(RedisClientImplementation, args, new.target);
}

Object.setPrototypeOf(RedisClient, RedisClientImplementation);
const redisClientPublicPrototype = Object.create(RedisClientImplementation.prototype);
for (const name of Object.getOwnPropertyNames(RedisClientImplementation.prototype)) {
  if (name === "constructor" || name.startsWith("_")) continue;
  Object.defineProperty(redisClientPublicPrototype, name, Object.getOwnPropertyDescriptor(RedisClientImplementation.prototype, name));
}
RedisClient.prototype = redisClientPublicPrototype;
Object.defineProperty(RedisClient.prototype, "constructor", { configurable: true, value: RedisClient, writable: true });

let defaultClient;
const lazyRedisTarget = Object.create(RedisClient.prototype);
export const redis = new Proxy(lazyRedisTarget, {
  get(_target, property) {
    defaultClient ??= new RedisClient();
    const value = Reflect.get(defaultClient, property, defaultClient);
    return typeof value === "function" ? value.bind(defaultClient) : value;
  },
  set(_target, property, value) {
    defaultClient ??= new RedisClient();
    return Reflect.set(defaultClient, property, value, defaultClient);
  },
});
