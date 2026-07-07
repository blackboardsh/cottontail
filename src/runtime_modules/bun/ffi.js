const g = globalThis;

function platform() {
  return cottontail.platform();
}

const processObject = g.process ?? {
  argv: ["cottontail", ...(cottontail.args || [])],
  argv0: "cottontail",
  env: cottontail.env(),
  platform: platform(),
  arch: cottontail.arch(),
  cwd: () => cottontail.cwd(),
  exit: (code = 0) => cottontail.exit(code),
  on: () => processObject,
};
g.process = processObject;

console.warn ||= console.error;
console.info ||= console.log;
console.debug ||= console.log;
g.self ??= g;
g.performance ??= { now: () => Date.now() };
g.performance.now ??= () => Date.now();

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

function makeBuffer(bytes) {
  bytes.toString = function toString(encoding = "utf8") {
    if (encoding === "base64") return base64Encode(this);
    return stringFromBytes(this);
  };
  return bytes;
}

g.Buffer ??= {
  from(value, encoding = "utf8") {
    if (value instanceof ArrayBuffer) return makeBuffer(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return makeBuffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    if (encoding === "base64") return makeBuffer(base64Decode(value));
    return makeBuffer(bytesFromString(value));
  },
};

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
let nextTimerId = 1;

function timerNow() {
  return Number(g.performance.now());
}

function installTimers() {
  if (g.__cottontailTimersInstalled) return;
  g.__cottontailTimersInstalled = true;
  g.setTimeout = (callback, ms = 0, ...args) => {
    const id = nextTimerId++;
    timers.set(id, { id, deadline: timerNow() + Math.max(0, Number(ms) || 0), callback, args, interval: null });
    return id;
  };
  g.clearTimeout = (id) => timers.delete(Number(id));
  g.setInterval = (callback, ms = 0, ...args) => {
    const id = nextTimerId++;
    const interval = Math.max(1, Number(ms) || 0);
    timers.set(id, { id, deadline: timerNow() + interval, callback, args, interval });
    return id;
  };
  g.clearInterval = g.clearTimeout;
  g.requestAnimationFrame ??= (callback) => g.setTimeout(() => callback(timerNow()), 16);
  g.cancelAnimationFrame ??= g.clearTimeout;
}

installTimers();

g.__cottontailRunLoopTick = () => {
  const now = timerNow();
  const due = Array.from(timers.values())
    .filter((timer) => timer.deadline <= now)
    .sort((a, b) => a.deadline - b.deadline || a.id - b.id);
  for (const timer of due) {
    if (!timers.has(timer.id)) continue;
    timers.delete(timer.id);
    timer.callback(...timer.args);
    if (timer.interval != null) {
      timer.deadline = timerNow() + timer.interval;
      timers.set(timer.id, timer);
    }
  }
  cottontail.drainJobs?.();
};

g.Worker ??= class Worker {
  constructor(scriptPath) {
    this.scriptPath = String(scriptPath);
    this.handle = cottontail.spawnWorker(this.scriptPath);
  }
  postMessage() {}
  terminate() {}
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
