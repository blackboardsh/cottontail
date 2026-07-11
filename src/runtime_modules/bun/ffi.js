import { createReadableStdio, createWritableStdio } from "../node/stdio.js";

const g = globalThis;
const processStartMs = Date.now();

function platform() {
  return cottontail.platform();
}

function signalNumber(signal = "SIGTERM") {
  if (typeof signal === "number") return signal;
  const name = String(signal).toUpperCase();
  if (name === "0") return 0;
  const signals = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGALRM: 14,
    SIGTERM: 15,
  };
  if (signals[name] == null) throw new TypeError(`Unknown signal: ${signal}`);
  return signals[name];
}

function installProcessApi(processObject) {
  const listeners = processObject.__cottontailListeners ?? new Map();
  Object.defineProperty(processObject, "__cottontailListeners", {
    value: listeners,
    configurable: true,
  });

  processObject.pid ??= cottontail.pid?.() ?? 0;
  processObject.version ??= "v22.0.0-cottontail";
  processObject.title ??= "cottontail";
  processObject.browser ??= false;
  processObject.uptime ??= () => (Date.now() - processStartMs) / 1000;

  processObject.nextTick = (callback, ...args) => {
    if (typeof callback !== "function") {
      throw new TypeError("process.nextTick callback must be a function");
    }
    if (typeof queueMicrotask === "function") {
      queueMicrotask(() => callback(...args));
    } else {
      setTimeout(() => callback(...args), 0);
    }
  };

  processObject.hrtime = (previous) => {
    const now = BigInt(Math.floor((performance?.now?.() ?? Date.now()) * 1_000_000));
    let diff = now;
    if (Array.isArray(previous)) {
      diff -= BigInt(previous[0] || 0) * 1_000_000_000n + BigInt(previous[1] || 0);
    }
    return [Number(diff / 1_000_000_000n), Number(diff % 1_000_000_000n)];
  };
  processObject.hrtime.bigint = () => BigInt(Math.floor((performance?.now?.() ?? Date.now()) * 1_000_000));

  processObject.on = processObject.addListener = function on(name, handler) {
    if (typeof handler !== "function") return this;
    const key = String(name);
    const handlers = listeners.get(key) ?? [];
    handlers.push(handler);
    listeners.set(key, handlers);
    return this;
  };

  processObject.once = function once(name, handler) {
    if (typeof handler !== "function") return this;
    const wrapped = (...args) => {
      this.off(name, wrapped);
      handler(...args);
    };
    wrapped.listener = handler;
    return this.on(name, wrapped);
  };

  processObject.off = processObject.removeListener = function off(name, handler) {
    const key = String(name);
    const handlers = listeners.get(key) ?? [];
    listeners.set(key, handlers.filter((item) => item !== handler && item.listener !== handler));
    return this;
  };

  processObject.removeAllListeners = function removeAllListeners(name) {
    if (name == null) listeners.clear();
    else listeners.delete(String(name));
    return this;
  };

  processObject.listeners = function processListeners(name) {
    return [...(listeners.get(String(name)) ?? [])];
  };

  processObject.emit = function emit(name, ...args) {
    const handlers = [...(listeners.get(String(name)) ?? [])];
    for (const handler of handlers) {
      handler(...args);
    }
    return handlers.length > 0;
  };

  processObject.kill ??= (pid = processObject.pid, signal = "SIGTERM") => {
    const targetPid = Number(pid);
    const nativeSignal = signalNumber(signal);
    if (targetPid === processObject.pid && nativeSignal !== 0 && processObject.emit(String(signal))) {
      return true;
    }
    return cottontail.kill(targetPid, nativeSignal);
  };
}

const cottontailExecPath = cottontail.execPath?.() ?? "cottontail";
const processObject = g.process ?? {
  argv: cottontail.argv || ["cottontail", ...(cottontail.args || [])],
  argv0: cottontailExecPath,
  execPath: cottontailExecPath,
  env: cottontail.env(),
  platform: platform(),
  arch: cottontail.arch(),
  pid: cottontail.pid?.() ?? 0,
  versions: { node: "22.0.0", cottontail: "0.0.0-dev" },
  release: { name: "cottontail" },
  cwd: () => cottontail.cwd(),
  exit: (code = 0) => cottontail.exit(code),
  emitWarning: (message, type = "Warning") => console.warn(`${type}: ${message}`),
};
g.process = processObject;
installProcessApi(g.process);
g.process.execPath ??= cottontailExecPath;
g.process.argv0 ??= g.process.execPath;
g.process.execArgv ??= Array.from(cottontail.execArgv || []);
if (typeof cottontail.gc === "function" &&
    Array.prototype.some.call(g.process.execArgv, (arg) => arg === "--expose-gc" || arg === "--expose_gc")) {
  Object.defineProperty(g, "gc", {
    value: (options = undefined) => {
      const result = cottontail.gc();
      globalThis.__cottontailForcedWeakRefGc?.();
      globalThis.__cottontailAsyncHooksOnGc?.();
      if (options && typeof options === "object" && options.execution === "async") return Promise.resolve(result);
      return result;
    },
    configurable: true,
    writable: true,
  });
}
g.process.versions ??= { node: "22.0.0", cottontail: "0.0.0-dev" };
g.process.versions.node ??= "22.0.0";
g.process.release ??= { name: "cottontail" };
g.process.emitWarning ??= (message, type = "Warning") => console.warn(`${type}: ${message}`);
g.process.stdin ??= createReadableStdio(0);
g.process.stdout ??= createWritableStdio(1);
g.process.stderr ??= createWritableStdio(2);

const ipcPrefix = "__COTTONTAIL_IPC__";
if (g.process.env?.COTTONTAIL_IPC_STDIO === "1" &&
    g.process.env?.COTTONTAIL_IPC_BOOTSTRAP === "bun" &&
    typeof g.process.send !== "function") {
  g.process.connected = true;
  g.process.send = (message) => {
    if (!g.process.connected) return false;
    return g.process.stdout.write(`${ipcPrefix}${JSON.stringify(message)}\n`);
  };
  g.process.disconnect = () => {
    g.process.connected = false;
    g.process.emit("disconnect");
  };

  let ipcBuffer = "";
  g.process.stdin.setEncoding("utf8");
  g.process.stdin.on("data", (chunk) => {
    ipcBuffer += String(chunk);
    for (;;) {
      const newlineIndex = ipcBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = ipcBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      ipcBuffer = ipcBuffer.slice(newlineIndex + 1);
      if (!line.startsWith(ipcPrefix)) continue;
      try {
        g.process.emit("message", JSON.parse(line.slice(ipcPrefix.length)));
      } catch (error) {
        g.process.emit("error", error);
      }
    }
  });
  g.process.stdin.on("end", () => {
    if (g.process.connected) g.process.disconnect();
  });
  g.process.stdin.resume();
}

const formatConsoleArg = (value) => {
  if (value instanceof Error && value.stack) return value.stack;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object" || value === null) return value;

  const seen = new Set();
  try {
    return JSON.stringify(
      value,
      (_key, item) => {
        if (typeof item === "bigint") return `${item}n`;
        if (typeof item === "object" && item !== null) {
          if (seen.has(item)) return "[Circular]";
          seen.add(item);
        }
        return item;
      },
      2,
    );
  } catch {
    return String(value);
  }
};
const nativeConsoleLog = console.log?.bind(console);
const nativeConsoleError = console.error?.bind(console);
if (nativeConsoleLog) {
  console.log = (...args) => nativeConsoleLog(...args.map(formatConsoleArg));
}
if (nativeConsoleError) {
  console.error = (...args) => nativeConsoleError(...args.map(formatConsoleArg));
}
console.warn ||= console.error;
console.info ||= console.log;
console.debug ||= console.log;
g.global ??= g;
g.self ??= g;
g.performance ??= { now: () => Date.now() };
g.performance.now ??= () => Date.now();
g.setImmediate ??= (callback, ...args) => setTimeout(callback, 0, ...args);
g.clearImmediate ??= (handle) => clearTimeout(handle);

if (typeof g.URLSearchParams !== "function") {
  g.URLSearchParams = class URLSearchParams {
    constructor(init = "") {
      this._entries = [];
      if (typeof init === "string") {
        const source = init.startsWith("?") ? init.slice(1) : init;
        for (const part of source.split("&")) {
          if (!part) continue;
          const [rawKey, rawValue = ""] = part.split("=");
          this.append(decodeURIComponent(rawKey.replace(/\+/g, " ")), decodeURIComponent(rawValue.replace(/\+/g, " ")));
        }
      } else if (Array.isArray(init)) {
        for (const [key, value] of init) this.append(key, value);
      } else if (init && typeof init === "object") {
        for (const key of Object.keys(init)) this.append(key, init[key]);
      }
    }
    append(key, value) {
      this._entries.push([String(key), String(value)]);
    }
    set(key, value) {
      key = String(key);
      this.delete(key);
      this.append(key, value);
    }
    get(key) {
      key = String(key);
      const entry = this._entries.find((item) => item[0] === key);
      return entry ? entry[1] : null;
    }
    has(key) {
      key = String(key);
      return this._entries.some((item) => item[0] === key);
    }
    delete(key) {
      key = String(key);
      this._entries = this._entries.filter((item) => item[0] !== key);
    }
    toString() {
      return this._entries
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
    }
    [Symbol.iterator]() {
      return this._entries[Symbol.iterator]();
    }
  };
}

if (typeof g.URL !== "function" || !("searchParams" in new g.URL("http://example.test"))) {
  g.URL = class URL {
    constructor(input, base) {
      const source = String(input);
      const resolved = base && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)
        ? String(base).replace(/[^/]*$/, "") + source
        : source;
      const match = /^([A-Za-z][A-Za-z0-9+.-]*:)?(\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(resolved) || [];
      this.protocol = match[1] || "";
      this.host = match[3] || "";
      this.hostname = this.host.split(":")[0] || "";
      this.pathname = match[4] || "";
      this.hash = match[6] || "";
      this.searchParams = new g.URLSearchParams(match[5] || "");
    }
    get search() {
      const value = this.searchParams.toString();
      return value ? `?${value}` : "";
    }
    set search(value) {
      this.searchParams = new g.URLSearchParams(value);
    }
    get href() {
      return `${this.protocol}${this.host ? `//${this.host}` : ""}${this.pathname}${this.search}${this.hash}`;
    }
    set href(value) {
      const next = new g.URL(value);
      Object.assign(this, next);
    }
    get origin() {
      return this.host ? `${this.protocol}//${this.host}` : "null";
    }
    toString() {
      return this.href;
    }
    toJSON() {
      return this.href;
    }
  };
}

function encodeUtf8(input) {
  const out = [];
  for (let index = 0; index < input.length; index += 1) {
    let codePoint = input.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < input.length) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }
    if (codePoint <= 0x7f) out.push(codePoint);
    else if (codePoint <= 0x7ff) out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    else if (codePoint <= 0xffff) out.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    else out.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  }
  return new Uint8Array(out);
}

function decodeUtf8(input) {
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let output = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++] || 0;
    let codePoint = first;
    if ((first & 0xe0) === 0xc0) {
      codePoint = ((first & 0x1f) << 6) | ((bytes[index++] || 0) & 0x3f);
    } else if ((first & 0xf0) === 0xe0) {
      codePoint = ((first & 0x0f) << 12) | (((bytes[index++] || 0) & 0x3f) << 6) | ((bytes[index++] || 0) & 0x3f);
    } else if ((first & 0xf8) === 0xf0) {
      codePoint = ((first & 0x07) << 18) | (((bytes[index++] || 0) & 0x3f) << 12) | (((bytes[index++] || 0) & 0x3f) << 6) | ((bytes[index++] || 0) & 0x3f);
    }
    if (codePoint <= 0xffff) output += String.fromCharCode(codePoint);
    else {
      codePoint -= 0x10000;
      output += String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
    }
  }
  return output;
}

g.TextEncoder ??= class TextEncoder {
  encode(input = "") {
    return encodeUtf8(String(input));
  }
};

g.TextDecoder ??= class TextDecoder {
  decode(input = new ArrayBuffer(0)) {
    return decodeUtf8(input);
  }
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesFromString(input) {
  return textEncoder.encode(String(input));
}

function stringFromBytes(bytes) {
  return textDecoder.decode(bytes);
}

function normalizeBlobType(type = "") {
  const text = String(type).toLowerCase();
  return /[\x00-\x1f\x7f-\xff]/.test(text) ? "" : text;
}

function bytesFromBlobPart(part) {
  if (part == null) return new Uint8Array(0);
  if (typeof part === "string") return bytesFromString(part);
  if (part instanceof ArrayBuffer) return new Uint8Array(part);
  if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
  if (part?._bytes instanceof Uint8Array) return new Uint8Array(part._bytes);
  return bytesFromString(String(part));
}

function relativeBlobIndex(value, size, fallback) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number)) return number < 0 ? 0 : size;
  if (number < 0) return Math.max(size + number, 0);
  return Math.min(number, size);
}

function installBlobGlobals() {
  if (typeof g.Blob !== "function") {
    class CottontailBlob {
      constructor(parts = [], options = {}) {
        const chunks = Array.from(parts ?? [], bytesFromBlobPart);
        const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        this._bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          this._bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.type = normalizeBlobType(options?.type);
      }

      get size() {
        return this._bytes.byteLength;
      }

      async arrayBuffer() {
        return this._bytes.slice().buffer;
      }

      async bytes() {
        return this._bytes.slice();
      }

      async text() {
        return stringFromBytes(this._bytes);
      }

      slice(start = 0, end = this.size, type = "") {
        const relativeStart = relativeBlobIndex(start, this.size, 0);
        const relativeEnd = relativeBlobIndex(end, this.size, this.size);
        return new g.Blob([this._bytes.slice(relativeStart, Math.max(relativeStart, relativeEnd))], { type });
      }

      stream() {
        const bytes = this._bytes.slice();
        if (typeof g.ReadableStream === "function") {
          return new g.ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          });
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        };
      }
    }
    Object.defineProperty(g, "Blob", {
      configurable: true,
      writable: true,
      value: CottontailBlob,
    });
  }

  if (typeof g.File !== "function") {
    class CottontailFile extends g.Blob {
      constructor(parts, name, options = {}) {
        if (arguments.length < 2) throw new TypeError("File constructor requires file bits and name");
        if (parts == null || typeof parts[Symbol.iterator] !== "function") throw new TypeError("File bits must be iterable");
        super(parts, options);
        this.name = String(name);
        this.lastModified = Number(options?.lastModified ?? Date.now());
      }
    }
    Object.defineProperty(CottontailFile, "name", { value: "File", configurable: true });
    Object.defineProperty(g, "File", {
      configurable: true,
      writable: true,
      value: CottontailFile,
    });
  }
}

function installObjectURLRegistry() {
  if (!g.URL || g.URL.__cottontailObjectURLRegistryInstalled) return;

  const registry = g.__cottontailObjectURLRegistry ??= new Map();
  g.__cottontailObjectURLNextId ??= 1;
  const nativeCreateObjectURL = typeof g.URL.createObjectURL === "function" ? g.URL.createObjectURL.bind(g.URL) : null;
  const nativeRevokeObjectURL = typeof g.URL.revokeObjectURL === "function" ? g.URL.revokeObjectURL.bind(g.URL) : null;

  Object.defineProperty(g.URL, "__cottontailObjectURLRegistryInstalled", {
    value: true,
    configurable: true,
  });

  Object.defineProperty(g.URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value(object) {
      if (!(object instanceof g.Blob)) {
        if (nativeCreateObjectURL) return nativeCreateObjectURL(object);
        throw new TypeError("URL.createObjectURL requires a Blob");
      }
      const id = `blob:nodedata:${Date.now().toString(36)}-${g.__cottontailObjectURLNextId++}`;
      registry.set(id, object);
      return id;
    },
  });

  Object.defineProperty(g.URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value(id) {
      const key = String(id);
      if (!registry.delete(key) && nativeRevokeObjectURL) nativeRevokeObjectURL(id);
    },
  });

  if (typeof g.resolveObjectURL !== "function") {
    Object.defineProperty(g, "resolveObjectURL", {
      configurable: true,
      writable: true,
      value(id) {
        return registry.get(String(id));
      },
    });
  }
}

installBlobGlobals();
installObjectURLRegistry();

function normalizeBufferEncoding(encoding = "utf8") {
  const normalized = String(encoding || "utf8").toLowerCase().replace(/[-_]/g, "");
  if (normalized === "utf8" || normalized === "utf") return "utf8";
  if (normalized === "utf16le" || normalized === "ucs2") return "utf16le";
  if (normalized === "latin1" || normalized === "binary") return "latin1";
  if (normalized === "base64") return "base64";
  if (normalized === "hex") return "hex";
  return "utf8";
}

function hexDecode(input) {
  const text = String(input);
  const out = [];
  for (let index = 0; index + 1 < text.length; index += 2) {
    const high = hexNibble(text.charCodeAt(index));
    const low = hexNibble(text.charCodeAt(index + 1));
    if (high < 0 || low < 0) break;
    out.push((high << 4) | low);
  }
  return new Uint8Array(out);
}

function hexNibble(code) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function hexEncode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function base64Decode(input) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(input).replace(/[^A-Za-z0-9+/=]/g, "");
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    if (ch === "=") break;
    const value = chars.indexOf(ch);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function base64Encode(input) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    output += chars[(triple >> 18) & 0x3f];
    output += chars[(triple >> 12) & 0x3f];
    output += index + 1 < bytes.length ? chars[(triple >> 6) & 0x3f] : "=";
    output += index + 2 < bytes.length ? chars[triple & 0x3f] : "=";
  }
  return output;
}

function bytesFromStringWithEncoding(input, encoding = "utf8") {
  const normalized = normalizeBufferEncoding(encoding);
  const text = String(input);
  if (normalized === "base64") return base64Decode(text);
  if (normalized === "hex") return hexDecode(text);
  if (normalized === "latin1") {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
    return bytes;
  }
  if (normalized === "utf16le") {
    const bytes = new Uint8Array(text.length * 2);
    for (let index = 0; index < text.length; index += 1) {
      const value = text.charCodeAt(index);
      bytes[index * 2] = value & 0xff;
      bytes[index * 2 + 1] = (value >> 8) & 0xff;
    }
    return bytes;
  }
  return bytesFromString(text);
}

function stringFromBytesWithEncoding(bytes, encoding = "utf8", start = 0, end = bytes.length) {
  const normalized = normalizeBufferEncoding(encoding);
  const view = bytes.subarray(Math.max(0, Number(start) || 0), Math.min(bytes.length, end == null ? bytes.length : Number(end)));
  if (normalized === "base64") return base64Encode(view);
  if (normalized === "hex") return hexEncode(view);
  if (normalized === "latin1") {
    let output = "";
    for (const byte of view) output += String.fromCharCode(byte);
    return output;
  }
  if (normalized === "utf16le") {
    let output = "";
    for (let index = 0; index + 1 < view.length; index += 2) {
      output += String.fromCharCode(view[index] | (view[index + 1] << 8));
    }
    return output;
  }
  return stringFromBytes(view);
}

g.btoa ??= (input) => {
  const text = String(input);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return base64Encode(bytes);
};

g.atob ??= (input) => {
  const bytes = base64Decode(input);
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return output;
};

function CottontailBuffer(value, encoding = "utf8") {
  return CottontailBuffer.from(value, encoding);
}
CottontailBuffer.prototype = Object.create(Uint8Array.prototype);
CottontailBuffer.prototype.constructor = CottontailBuffer;

function normalizeSearchOffset(byteOffset, length) {
  let offset = Number(byteOffset ?? 0);
  if (!Number.isFinite(offset)) offset = 0;
  offset = Math.trunc(offset);
  if (offset < 0) offset = Math.max(length + offset, 0);
  if (offset > length) offset = length;
  return offset;
}

function bufferSearchBytes(value, encoding = "utf8") {
  if (typeof value === "number") return new Uint8Array([value & 0xff]);
  return CottontailBuffer.from(value, encoding);
}

function bufferIndexOf(buffer, value, byteOffset = 0, encoding = "utf8") {
  const needle = bufferSearchBytes(value, encoding);
  if (needle.length === 0) return normalizeSearchOffset(byteOffset, buffer.length);
  const start = normalizeSearchOffset(byteOffset, buffer.length);
  if (needle.length > buffer.length - start) return -1;
  outer: for (let index = start; index <= buffer.length - needle.length; index += 1) {
    for (let needleIndex = 0; needleIndex < needle.length; needleIndex += 1) {
      if (buffer[index + needleIndex] !== needle[needleIndex]) continue outer;
    }
    return index;
  }
  return -1;
}

function makeBufferView(bytes, start = 0, end = bytes.length) {
  const view = Uint8Array.prototype.subarray.call(bytes, start, end);
  Object.setPrototypeOf(view, CottontailBuffer.prototype);
  installBufferMethods(view);
  return view;
}

function installBufferMethods(bytes) {
  bytes.toString = function toString(encoding = "utf8", start = 0, end = this.length) {
    return stringFromBytesWithEncoding(this, encoding, start, end);
  };
  bytes.equals = function equals(other) {
    const rhs = CottontailBuffer.from(other);
    if (this.length !== rhs.length) return false;
    for (let index = 0; index < this.length; index += 1) {
      if (this[index] !== rhs[index]) return false;
    }
    return true;
  };
  bytes.indexOf = function indexOf(value, byteOffset = 0, encoding = "utf8") {
    return bufferIndexOf(this, value, byteOffset, encoding);
  };
  bytes.includes = function includes(value, byteOffset = 0, encoding = "utf8") {
    return this.indexOf(value, byteOffset, encoding) !== -1;
  };
  bytes.write = function write(string, offset = 0, length = undefined, encoding = "utf8") {
    if (typeof offset === "string") {
      encoding = offset;
      offset = 0;
      length = this.length;
    } else if (typeof length === "string") {
      encoding = length;
      length = undefined;
    }
    const start = Math.max(0, Math.min(this.length, Math.trunc(Number(offset) || 0)));
    const maxLength = length == null ? this.length - start : Math.max(0, Math.trunc(Number(length) || 0));
    const source = CottontailBuffer.from(String(string), encoding);
    const written = Math.min(source.length, maxLength, this.length - start);
    this.set(source.subarray(0, written), start);
    return written;
  };
  bytes.slice = function slice(start = 0, end = this.length) {
    return makeBufferView(this, start, end);
  };
  bytes.subarray = function subarray(start = 0, end = this.length) {
    return makeBufferView(this, start, end);
  };
  return bytes;
}

function makeBuffer(bytes) {
  Object.setPrototypeOf(bytes, CottontailBuffer.prototype);
  return installBufferMethods(bytes);
}

CottontailBuffer.from = function from(value = "", encoding = "utf8") {
  if (value instanceof ArrayBuffer) return makeBuffer(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return makeBuffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (Array.isArray(value)) return makeBuffer(new Uint8Array(value));
  return makeBuffer(bytesFromStringWithEncoding(value, encoding));
};
CottontailBuffer.alloc = function alloc(size, fill = 0, encoding = "utf8") {
  const bytes = makeBuffer(new Uint8Array(Number(size) || 0));
  if (fill != null && fill !== 0) {
    const fillBytes = typeof fill === "number" ? new Uint8Array([fill & 0xff]) : CottontailBuffer.from(fill, encoding);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = fillBytes[index % fillBytes.length] ?? 0;
  }
  return bytes;
};
CottontailBuffer.allocUnsafe = function allocUnsafe(size) {
  return makeBuffer(new Uint8Array(Number(size) || 0));
};
CottontailBuffer.concat = function concat(list, totalLength = undefined) {
  if (!Array.isArray(list)) throw new TypeError("Buffer.concat list must be an Array");
  const buffers = list.map((item) => CottontailBuffer.from(item));
  const length = totalLength == null ? buffers.reduce((sum, item) => sum + item.length, 0) : Number(totalLength) || 0;
  const output = makeBuffer(new Uint8Array(length));
  let offset = 0;
  for (const item of buffers) {
    output.set(item.subarray(0, Math.max(0, length - offset)), offset);
    offset += item.length;
    if (offset >= length) break;
  }
  return output;
};
CottontailBuffer.isBuffer = function isBuffer(value) {
  return value instanceof CottontailBuffer || (ArrayBuffer.isView(value) && typeof value.toString === "function" && typeof value.equals === "function");
};
CottontailBuffer.byteLength = function byteLength(value, encoding = "utf8") {
  return CottontailBuffer.from(value, encoding).length;
};

g.Buffer = typeof g.Buffer === "function" ? g.Buffer : CottontailBuffer;
g.Buffer.from ??= CottontailBuffer.from;
g.Buffer.alloc ??= CottontailBuffer.alloc;
g.Buffer.allocUnsafe ??= CottontailBuffer.allocUnsafe;
g.Buffer.concat ??= CottontailBuffer.concat;
g.Buffer.isBuffer ??= CottontailBuffer.isBuffer;
g.Buffer.byteLength ??= CottontailBuffer.byteLength;

function shellEscape(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_/:.,=+@%-]+$/.test(text)) return text;
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function guessMimeType(path) {
  const lower = String(path).toLowerCase();
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function bunFile(path) {
  const filePath = String(path);
  return {
    name: filePath.split("/").pop() || filePath,
    type: guessMimeType(filePath),
    get size() {
      const result = cottontail.spawnSync("sh", ["-c", `wc -c < ${shellEscape(filePath)}`], { stdio: "pipe" });
      return result.status === 0 ? Number(result.stdout.trim()) || 0 : 0;
    },
    async exists() {
      return cottontail.existsSync(filePath);
    },
    async text() {
      return cottontail.readFile(filePath);
    },
    async json() {
      return JSON.parse(cottontail.readFile(filePath));
    },
    async arrayBuffer() {
      return cottontail.readFileBuffer(filePath);
    },
    writer() {
      const chunks = [];
      return {
        write(chunk) { chunks.push(chunk); },
        end(chunk) {
          if (chunk != null) chunks.push(chunk);
          const text = chunks.map((item) => typeof item === "string" ? item : textDecoder.decode(item)).join("");
          cottontail.writeFile(filePath, text);
        },
      };
    },
  };
}

async function bunWrite(path, data) {
  cottontail.writeFile(String(path), data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : String(data));
}

g.Bun ??= {};
g.Bun.argv ??= cottontail.argv || ["cottontail", ...(cottontail.args || [])];
g.Bun.env ??= processObject.env;
g.Bun.file ??= bunFile;
g.Bun.write ??= bunWrite;

const timers = new Map();
const cancelledTimers = new Set();
let nextTimerId = 1;
const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");

function timerNow() {
  return Number(g.performance.now());
}

function makeTimerHandle(id) {
  return {
    [Symbol.toPrimitive]: () => id,
    valueOf: () => id,
    ref() {
      const timer = timers.get(id);
      if (timer) timer.ref = true;
      return this;
    },
    unref() {
      const timer = timers.get(id);
      if (timer) timer.ref = false;
      return this;
    },
    hasRef() {
      return timers.get(id)?.ref !== false;
    },
  };
}

function installTimers() {
  if (g.__cottontailTimersInstalled) return;
  g.__cottontailTimersInstalled = true;
  g.setTimeout = (callback, ms = 0, ...args) => {
    const id = nextTimerId++;
    cancelledTimers.delete(id);
    const handle = makeTimerHandle(id);
    timers.set(id, { id, deadline: timerNow() + Math.max(0, Number(ms) || 0), callback, args, interval: null, ref: true, handle });
    return handle;
  };
  g.clearTimeout = (id) => {
    const key = Number(id);
    cancelledTimers.add(key);
    timers.delete(key);
  };
  g.setInterval = (callback, ms = 0, ...args) => {
    const id = nextTimerId++;
    const interval = Math.max(1, Number(ms) || 0);
    cancelledTimers.delete(id);
    const handle = makeTimerHandle(id);
    timers.set(id, { id, deadline: timerNow() + interval, callback, args, interval, ref: true, handle });
    return handle;
  };
  g.clearInterval = g.clearTimeout;
  g.requestAnimationFrame ??= (callback) => g.setTimeout(() => callback(timerNow()), 16);
  g.cancelAnimationFrame ??= g.clearTimeout;
  Object.defineProperty(g.setTimeout, promisifyCustom, {
    value: (ms = 1, value = undefined, options = undefined) => new Promise((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(options.signal.reason ?? new Error("AbortError"));
        return;
      }
      const id = g.setTimeout(() => resolve(value), ms);
      options?.signal?.addEventListener?.("abort", () => {
        g.clearTimeout(id);
        reject(options.signal.reason ?? new Error("AbortError"));
      }, { once: true });
    }),
    configurable: true,
  });
  Object.defineProperty(g.setImmediate, promisifyCustom, {
    value: (value = undefined, options = undefined) => new Promise((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(options.signal.reason ?? new Error("AbortError"));
        return;
      }
      const id = g.setImmediate(() => resolve(value));
      options?.signal?.addEventListener?.("abort", () => {
        g.clearImmediate(id);
        reject(options.signal.reason ?? new Error("AbortError"));
      }, { once: true });
    }),
    configurable: true,
  });
}

installTimers();

const spawnEventListeners = new Map();
let spawnEventHandlerInstalled = false;

function installSpawnEventHandler() {
  if (spawnEventHandlerInstalled) return;
  spawnEventHandlerInstalled = true;
  cottontail.spawnSetEventHandler?.((event) => {
    const entry = spawnEventListeners.get(Number(event?.id));
    if (typeof entry?.listener === "function") entry.listener(event);
  });
}

g.__cottontailRegisterSpawnListener = (id, listener) => {
  installSpawnEventHandler();
  const key = Number(id);
  const entry = { listener, ref: true };
  spawnEventListeners.set(key, entry);
  const unregister = () => {
    if (spawnEventListeners.get(key) === entry) {
      spawnEventListeners.delete(key);
    }
  };
  unregister.ref = () => {
    entry.ref = true;
  };
  unregister.unref = () => {
    entry.ref = false;
  };
  return unregister;
};

const workerMessageListeners = new Map();
function addWorkerListener(target, name, handler) {
  if (typeof handler !== "function") return target;
  const key = String(name);
  const handlers = workerMessageListeners.get(key) ?? [];
  handlers.push(handler);
  workerMessageListeners.set(key, handlers);
  return target;
}

function removeWorkerListener(target, name, handler) {
  const key = String(name);
  const handlers = workerMessageListeners.get(key) ?? [];
  workerMessageListeners.set(key, handlers.filter((item) => item !== handler && item.listener !== handler));
  return target;
}

function emitWorkerEvent(target, name, event) {
  const handler = target[`on${name}`];
  if (typeof handler === "function") handler.call(target, event);
  for (const listener of workerMessageListeners.get(String(name)) ?? []) {
    listener.call(target, event);
  }
}

function hasWorkerMessageListener() {
  if (typeof g.onmessage === "function") return true;
  return (workerMessageListeners.get("message") ?? []).length > 0;
}

function serializeWorkerMessage(message) {
  const seen = new WeakSet();
  return JSON.stringify(message, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    if (value && typeof value === "object") {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  });
}

function installWorkerGlobal() {
  if (!cottontail.isWorker?.()) return;
  g.self = g;
  g.postMessage = g.self.postMessage = (message) => {
    cottontail.workerPostMessage(serializeWorkerMessage(message));
  };
  g.addEventListener = g.self.addEventListener = function addEventListener(name, handler) {
    return addWorkerListener(g, name, handler);
  };
  g.removeEventListener = g.self.removeEventListener = function removeEventListener(name, handler) {
    return removeWorkerListener(g, name, handler);
  };
}

function pollWorkerGlobalMessages() {
  if (!cottontail.isWorker?.()) return;
  if (!hasWorkerMessageListener()) return;
  for (const item of cottontail.workerPollIncomingMessages()) {
    let data = item;
    try {
      data = JSON.parse(item);
    } catch {}
    emitWorkerEvent(g, "message", { data });
  }
}

installWorkerGlobal();

const workerInstances = new Map();
let workerNativeEventHandlerInstalled = false;

function installWorkerNativeEventHandler() {
  if (typeof cottontail.workerSetEventHandler !== "function") return false;
  if (workerNativeEventHandlerInstalled) return true;
  workerNativeEventHandlerInstalled = true;
  cottontail.workerSetEventHandler((event) => {
    const worker = workerInstances.get(Number(event?.id));
    if (!worker) return;
    if (event?.type === "exit") {
      workerInstances.delete(worker.id);
      if (worker._pollTimer != null) clearInterval(worker._pollTimer);
      worker._emit("exit", { code: 0 });
      return;
    }
    worker._poll();
  });
  return true;
}

function nextRunLoopDelay(now = timerNow()) {
  let nextDelay = 16;
  for (const timer of timers.values()) {
    const delay = timer.deadline - now;
    if (delay <= 0) return 1;
    if (delay < nextDelay) nextDelay = delay;
  }
  return Math.max(1, Math.min(50, Math.ceil(nextDelay)));
}

g.__cottontailHasActiveHandles = () => {
  if (cottontail.isWorker?.()) {
    if (hasWorkerMessageListener()) return true;
  }
  if (workerInstances.size > 0) return true;
  for (const timer of timers.values()) {
    if (timer.ref !== false) return true;
  }
  for (const entry of spawnEventListeners.values()) {
    if (entry.ref !== false) return true;
  }
  return false;
};

g.__cottontailRunLoopTick = () => {
  pollWorkerGlobalMessages();
  const now = timerNow();
  const due = Array.from(timers.values())
    .filter((timer) => timer.deadline <= now)
    .sort((a, b) => a.deadline - b.deadline || a.id - b.id);
  for (const timer of due.slice(0, 1)) {
    if (!timers.has(timer.id)) continue;
    timers.delete(timer.id);
    timer.callback(...timer.args);
    if (timer.interval != null && !cancelledTimers.has(timer.id)) {
      timer.deadline = timerNow() + timer.interval;
      timers.set(timer.id, timer);
    } else {
      cancelledTimers.delete(timer.id);
    }
  }
  cottontail.drainJobs?.();
  return nextRunLoopDelay(timerNow());
};

g.Worker ??= class Worker {
  constructor(scriptPath) {
    this.scriptPath = String(scriptPath);
    this.handle = cottontail.spawnWorker(this.scriptPath);
    this.id = this.handle.id;
    this.onmessage = null;
    this.onerror = null;
    this._listeners = new Map();
    workerInstances.set(this.id, this);
    this._pollTimer = installWorkerNativeEventHandler() ? null : setInterval(() => this._poll(), 16);
  }
  _add(name, handler) {
    if (typeof handler !== "function") return this;
    const handlers = this._listeners.get(name) ?? [];
    handlers.push(handler);
    this._listeners.set(name, handlers);
    return this;
  }
  _emit(name, event) {
    const propertyHandler = this[`on${name}`];
    if (typeof propertyHandler === "function") propertyHandler.call(this, event);
    for (const handler of this._listeners.get(name) ?? []) handler.call(this, event);
  }
  _poll() {
    for (const item of cottontail.workerPollMessages(this.id)) {
      let data = item;
      try {
        data = JSON.parse(item);
      } catch {}
      this._emit("message", { data });
    }
  }
  postMessage(message) {
    cottontail.workerPostMessageTo(this.id, serializeWorkerMessage(message));
  }
  terminate() {
    if (this._pollTimer != null) clearInterval(this._pollTimer);
    workerInstances.delete(this.id);
    cottontail.workerTerminate(this.id);
  }
  addEventListener(name, handler) {
    return this._add(String(name), handler);
  }
  removeEventListener(name, handler) {
    const key = String(name);
    const handlers = this._listeners.get(key) ?? [];
    this._listeners.set(key, handlers.filter((item) => item !== handler && item.listener !== handler));
    return this;
  }
};

const pointerKeepalive = [];

export const FFIType = {
  void: "void",
  bool: "bool",
  u8: "u8",
  i8: "i8",
  u16: "u16",
  i16: "i16",
  int: "int",
  u32: "u32",
  i32: "i32",
  u64: "u64",
  i64: "i64",
  f32: "f32",
  f64: "f64",
  ptr: "ptr",
  pointer: "ptr",
  cstring: "cstring",
  function: "function",
};

export const suffix = platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";

function normalizeType(type) {
  if (type === FFIType.pointer) return FFIType.ptr;
  if (type === "callback") return FFIType.function;
  return String(type ?? FFIType.void);
}

function toNumber(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (value && typeof value.ptr === "number") return value.ptr;
  return Number(value || 0);
}

export function ptr(value) {
  if (value == null) return 0;
  if (value instanceof JSCallback) return value.ptr;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    pointerKeepalive.push(value);
    if (pointerKeepalive.length > 4096) pointerKeepalive.splice(0, 1024);
  }
  return toNumber(cottontail.memoryAddress(value));
}

export function toArrayBuffer(pointer, offset = 0, length = 0) {
  return cottontail.memoryView(pointer, offset, length);
}

export function toBuffer(pointer, offset = 0, length = 0) {
  return globalThis.Buffer.from(new Uint8Array(toArrayBuffer(pointer, offset, length)));
}

function dataView(pointer, byteLength, offset = 0) {
  return new DataView(toArrayBuffer(pointer, offset, byteLength));
}

export const read = {
  u8(pointer, offset = 0) { return dataView(pointer, 1, offset).getUint8(0); },
  i8(pointer, offset = 0) { return dataView(pointer, 1, offset).getInt8(0); },
  u16(pointer, offset = 0) { return dataView(pointer, 2, offset).getUint16(0, true); },
  i16(pointer, offset = 0) { return dataView(pointer, 2, offset).getInt16(0, true); },
  u32(pointer, offset = 0) { return dataView(pointer, 4, offset).getUint32(0, true); },
  i32(pointer, offset = 0) { return dataView(pointer, 4, offset).getInt32(0, true); },
  u64(pointer, offset = 0) { return dataView(pointer, 8, offset).getBigUint64(0, true); },
  i64(pointer, offset = 0) { return dataView(pointer, 8, offset).getBigInt64(0, true); },
  ptr(pointer, offset = 0) {
    const view = dataView(pointer, 8, offset);
    return Number(view.getBigUint64(0, true));
  },
  intptr(pointer, offset = 0) {
    const view = dataView(pointer, 8, offset);
    return Number(view.getBigInt64(0, true));
  },
  f32(pointer, offset = 0) { return dataView(pointer, 4, offset).getFloat32(0, true); },
  f64(pointer, offset = 0) { return dataView(pointer, 8, offset).getFloat64(0, true); },
  cstring(pointer, offset = 0) { return new CString(toNumber(pointer) + Number(offset)); },
};

function readCString(pointer) {
  if (typeof pointer === "string") return pointer;
  const address = toNumber(pointer);
  if (!address) return "";
  const chunks = [];
  const maxLength = 8 * 1024 * 1024;
  const chunkSize = 64 * 1024;
  let totalLength = 0;
  for (let offset = 0; offset < maxLength; offset += chunkSize) {
    const view = new Uint8Array(cottontail.memoryView(address, offset, Math.min(chunkSize, maxLength - offset)));
    const nulIndex = view.indexOf(0);
    if (nulIndex >= 0) {
      chunks.push(view.slice(0, nulIndex));
      totalLength += nulIndex;
      break;
    }
    chunks.push(view.slice());
    totalLength += view.length;
  }
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return stringFromBytes(bytes);
}

export class CString {
  constructor(value) {
    if (typeof value === "string") {
      this.text = value;
      this.buffer = bytesFromString(`${value}\0`);
      this.ptr = ptr(this.buffer);
    } else {
      this.ptr = toNumber(value);
      this.text = readCString(value);
    }
  }
  toString() {
    return this.text;
  }
  get length() {
    return this.text.length;
  }
}

export class JSCallback {
  constructor(fn, options = {}) {
    this.fn = fn;
    this.options = options;
    this.args = (options.args || []).map(normalizeType);
    this.returns = normalizeType(options.returns || FFIType.void);
    this.threadsafe = Boolean(options.threadsafe);
    this.ptr = cottontail.createCallback(fn, this.args, this.returns, this.threadsafe);
  }
  close() {
    if (this.ptr) {
      cottontail.closeCallback?.(this.ptr);
      this.ptr = 0;
    }
  }
}

function nativeArg(value, type) {
  if (type === FFIType.function && value instanceof JSCallback) return value.ptr;
  if (value instanceof JSCallback) return value.ptr;
  if (value instanceof CString) return value.ptr;
  if (typeof value === "string" && type === FFIType.cstring) return new CString(value).ptr;
  return value;
}

function returnForType(type, value) {
  switch (normalizeType(type)) {
    case FFIType.void:
      return undefined;
    case FFIType.bool:
      return Boolean(value);
    case FFIType.cstring:
      return value ? new CString(value) : null;
    case FFIType.u64:
    case FFIType.i64:
      return typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value || 0)));
    default:
      return value == null ? 0 : Number(value);
  }
}

export function dlopen(path, symbols) {
  const wrapped = {};
  for (const [name, spec] of Object.entries(symbols || {})) {
    const argTypes = (spec.args || []).map(normalizeType);
    const returns = normalizeType(spec.returns || FFIType.void);
    wrapped[name] = (...args) => {
      const nativeArgs = args.map((arg, index) => nativeArg(arg, argTypes[index] || FFIType.ptr));
      const result = cottontail.nativeCall(String(path), name, returns, argTypes, nativeArgs);
      return returnForType(returns, result);
    };
    wrapped[name].ptr = cottontail.nativeSymbol(String(path), name);
    wrapped[name].native = true;
  }
  return { symbols: wrapped, close() {} };
}

export class CFunction {
  constructor(pointerOrSpec, options = {}) {
    const spec = pointerOrSpec && typeof pointerOrSpec === "object" && !(pointerOrSpec instanceof ArrayBuffer) && !ArrayBuffer.isView(pointerOrSpec)
      ? pointerOrSpec
      : { ptr: pointerOrSpec, ...options };
    const pointerValue = ptr(spec.ptr ?? spec.pointer);
    const argTypes = (spec.args || []).map(normalizeType);
    const returns = normalizeType(spec.returns || FFIType.void);
    const callable = (...args) => {
      const nativeArgs = args.map((arg, index) => nativeArg(arg, argTypes[index] || FFIType.ptr));
      return returnForType(returns, cottontail.nativeCallPointer(pointerValue, returns, argTypes, nativeArgs));
    };
    Object.setPrototypeOf(callable, new.target.prototype);
    callable.ptr = pointerValue;
    callable.options = spec;
    callable.args = argTypes;
    callable.returns = returns;
    callable.native = true;
    return callable;
  }
}

export function linkSymbols(symbols = {}) {
  const wrapped = {};
  for (const [name, spec] of Object.entries(symbols)) {
    wrapped[name] = new CFunction(spec);
  }
  return { symbols: wrapped, close() {} };
}

function pathJoin(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

function tmpRoot() {
  const env = globalThis.process?.env ?? cottontail.env();
  const base = String(env.COTTONTAIL_TMP_DIR || env.TMPDIR || env.TEMP || env.TMP || "/tmp");
  const dir = pathJoin(base, "cottontail", "bun-ffi-cc");
  cottontail.mkdirSync(dir, true);
  return dir;
}

function compilerCommand() {
  const env = globalThis.process?.env ?? cottontail.env();
  if (env.CC) return { file: env.CC, prefix: [] };
  const zig = pathJoin(cottontail.cwd(), "vendors", "zig", "zig");
  if (cottontail.existsSync(zig)) return { file: zig, prefix: ["cc"] };
  return { file: "cc", prefix: [] };
}

function sourcePathForCc(source) {
  const text = String(source ?? "");
  if (cottontail.existsSync(text)) return text;
  const path = pathJoin(tmpRoot(), `source-${Date.now()}-${Math.floor(Math.random() * 1000000)}.c`);
  cottontail.writeFile(path, text);
  return path;
}

export function cc(options = {}) {
  const source = options.source ?? options.file ?? options.path;
  const symbols = options.symbols ?? options.exports;
  if (source == null) throw new TypeError('Bun.cc requires a "source" file path or source string');
  if (symbols == null || typeof symbols !== "object") throw new TypeError('Bun.cc requires a "symbols" object');

  const dir = tmpRoot();
  const output = pathJoin(dir, `libcc-${Date.now()}-${Math.floor(Math.random() * 1000000)}.${suffix}`);
  const sourcePath = sourcePathForCc(source);
  const compiler = compilerCommand();
  const platformName = platform();
  const sharedArgs = platformName === "darwin"
    ? ["-dynamiclib", "-undefined", "dynamic_lookup"]
    : platformName === "win32"
      ? ["-shared"]
      : ["-shared", "-fPIC"];
  const args = [...compiler.prefix, sourcePath, ...sharedArgs, "-o", output, ...(options.flags || []), ...(options.args || [])].map(String);
  const result = cottontail.spawnSync(compiler.file, args, { stdio: "pipe" });
  if (Number(result.status ?? 0) !== 0) {
    throw new Error(String(result.stderr || result.stdout || `Bun.cc failed with status ${result.status}`));
  }
  return dlopen(output, symbols);
}

export const native = {
  dlopen,
  callback: JSCallback,
};

export function viewSource(value) {
  return String(value);
}

export default {
  CFunction,
  CString,
  FFIType,
  JSCallback,
  cc,
  dlopen,
  linkSymbols,
  native,
  ptr,
  read,
  suffix,
  toArrayBuffer,
  toBuffer,
  viewSource,
};
