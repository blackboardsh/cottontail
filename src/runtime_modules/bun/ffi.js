const g = globalThis;
const processStartMs = Date.now();

function platform() {
  return cottontail.platform();
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
    if (pid === processObject.pid || pid === 0) {
      if (signal === 0 || signal === "0") return true;
      processObject.emit(String(signal));
      return true;
    }
    throw new Error("process.kill for other processes is not implemented");
  };
}

const processObject = g.process ?? {
  argv: ["cottontail", ...(cottontail.args || [])],
  argv0: "cottontail",
  execPath: cottontail.execPath?.() ?? "cottontail",
  env: cottontail.env(),
  platform: platform(),
  arch: cottontail.arch(),
  pid: cottontail.pid?.() ?? 0,
  versions: { node: "22.0.0", cottontail: "0.0.0-dev" },
  cwd: () => cottontail.cwd(),
  exit: (code = 0) => cottontail.exit(code),
  emitWarning: (message, type = "Warning") => console.warn(`${type}: ${message}`),
};
g.process = processObject;
installProcessApi(g.process);
g.process.execPath ??= cottontail.execPath?.() ?? "cottontail";
g.process.versions ??= { node: "22.0.0", cottontail: "0.0.0-dev" };
g.process.versions.node ??= "22.0.0";
g.process.emitWarning ??= (message, type = "Warning") => console.warn(`${type}: ${message}`);
g.process.stdin ??= { fd: 0, isTTY: false, on: () => g.process.stdin, resume: () => g.process.stdin, setEncoding: () => g.process.stdin };
g.process.stdout ??= { fd: 1, isTTY: false, write: (value) => { console.log(String(value).replace(/\n$/, "")); return true; } };
g.process.stderr ??= { fd: 2, isTTY: false, write: (value) => { console.error(String(value).replace(/\n$/, "")); return true; } };

const formatConsoleArg = (value) =>
  value instanceof Error && value.stack ? value.stack : value;
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

function makeBuffer(bytes) {
  Object.setPrototypeOf(bytes, CottontailBuffer.prototype);
  bytes.toString = function toString(encoding = "utf8") {
    if (encoding === "base64") return base64Encode(this);
    return stringFromBytes(this);
  };
  bytes.equals = function equals(other) {
    const rhs = CottontailBuffer.from(other);
    if (this.length !== rhs.length) return false;
    for (let index = 0; index < this.length; index += 1) {
      if (this[index] !== rhs[index]) return false;
    }
    return true;
  };
  return bytes;
}

CottontailBuffer.from = function from(value = "", encoding = "utf8") {
  if (value instanceof ArrayBuffer) return makeBuffer(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return makeBuffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (Array.isArray(value)) return makeBuffer(new Uint8Array(value));
  if (encoding === "base64") return makeBuffer(base64Decode(value));
  return makeBuffer(bytesFromString(value));
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
g.Bun.argv ??= ["cottontail", ...(cottontail.args || [])];
g.Bun.env ??= processObject.env;
g.Bun.file ??= bunFile;
g.Bun.write ??= bunWrite;

const timers = new Map();
const cancelledTimers = new Set();
let nextTimerId = 1;

function timerNow() {
  return Number(g.performance.now());
}

function installTimers() {
  if (g.__cottontailTimersInstalled) return;
  g.__cottontailTimersInstalled = true;
  g.setTimeout = (callback, ms = 0, ...args) => {
    const id = nextTimerId++;
    cancelledTimers.delete(id);
    timers.set(id, { id, deadline: timerNow() + Math.max(0, Number(ms) || 0), callback, args, interval: null });
    return id;
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
    timers.set(id, { id, deadline: timerNow() + interval, callback, args, interval });
    return id;
  };
  g.clearInterval = g.clearTimeout;
  g.requestAnimationFrame ??= (callback) => g.setTimeout(() => callback(timerNow()), 16);
  g.cancelAnimationFrame ??= g.clearTimeout;
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
  for (const item of cottontail.workerPollIncomingMessages()) {
    let data = item;
    try {
      data = JSON.parse(item);
    } catch {}
    emitWorkerEvent(g, "message", { data });
  }
}

installWorkerGlobal();

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
    if (typeof g.onmessage === "function") return true;
    if ((workerMessageListeners.get("message") ?? []).length > 0) return true;
  }
  if (timers.size > 0) return true;
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
  for (const timer of due) {
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
    this._pollTimer = setInterval(() => this._poll(), 16);
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
    clearInterval(this._pollTimer);
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
  close() {}
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
  }
  return { symbols: wrapped, close() {} };
}

export default {
  CString,
  FFIType,
  JSCallback,
  dlopen,
  ptr,
  suffix,
  toArrayBuffer,
};
