import * as FFI from "./ffi.js";
import * as dns from "../node/dns.js";
import * as zlib from "../node/zlib.js";
import { createHash, randomBytes, randomUUID } from "../node/crypto.js";
import { fileURLToPath as nodeFileURLToPath, pathToFileURL as nodePathToFileURL } from "../node/url.js";
import { inspect as nodeInspect, isDeepStrictEqual, stripVTControlCharacters } from "../node/util.js";
import { Database as SQLiteDatabase } from "./sqlite.js";
import { jest as bunJest } from "./test.js";

function shellEscape(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_/:.,=+@%-]+$/.test(text)) return text;
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function interpolate(strings, values) {
  let out = "";
  for (let index = 0; index < strings.length; index += 1) {
    out += strings[index];
    if (index < values.length) {
      const value = values[index];
      out += Array.isArray(value) ? value.map(shellEscape).join(" ") : shellEscape(value);
    }
  }
  return out;
}

function runShell(command, capture) {
  const isWin = cottontail.platform() === "win32";
  const result = cottontail.spawnSync(isWin ? "cmd" : "sh", isWin ? ["/d", "/s", "/c", command] : ["-c", command], {
    stdio: capture ? "pipe" : "inherit",
  });
  const output = { exitCode: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
  if (result.status !== 0) {
    const error = new Error(`Command failed (${result.status}): ${command}`);
    error.exitCode = result.status;
    error.stdout = output.stdout;
    error.stderr = output.stderr;
    throw error;
  }
  return output;
}

function getRandomValues(view) {
  if (!ArrayBuffer.isView(view) || view instanceof DataView) {
    throw new TypeError("crypto.getRandomValues requires an integer typed array");
  }
  if (view.byteLength > 65536) {
    throw new Error("crypto.getRandomValues quota exceeded");
  }

  new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(randomBytes(view.byteLength));
  return view;
}

class ShellCommand {
  constructor(command) {
    this.command = command;
    this.capture = false;
    this.promise = null;
  }
  quiet() {
    this.capture = true;
    return this;
  }
  run(capture = this.capture) {
    if (!this.promise || capture !== this.capture) {
      this.promise = Promise.resolve().then(() => runShell(this.command, capture));
    }
    return this.promise;
  }
  text() {
    return this.run(true).then((result) => result.stdout);
  }
  then(resolve, reject) {
    return this.run().then(resolve, reject);
  }
  catch(reject) {
    return this.run().catch(reject);
  }
}

export function $(strings, ...values) {
  return new ShellCommand(interpolate(strings, values));
}

function pathJoin(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

function tmpRoot(kind) {
  const env = BunObject.env ?? cottontail.env();
  const base = String(env.COTTONTAIL_TMP_DIR || env.TMPDIR || env.TEMP || env.TMP || "/tmp");
  return pathJoin(base, "cottontail", kind);
}

function which(command) {
  const value = String(command || "");
  if (!value) return null;
  if (value.includes("/") || value.includes("\\")) {
    return cottontail.existsSync(value) ? value : null;
  }

  const env = BunObject.env ?? cottontail.env();
  const pathValue = String(env.PATH ?? env.Path ?? env.path ?? "");
  const extensions = cottontail.platform() === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const dir of pathValue.split(cottontail.platform() === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = pathJoin(dir, `${value}${ext}`);
      if (cottontail.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function bunBinary() {
  const exe = cottontail.platform() === "win32" ? "bun.exe" : "bun";
  const candidate = pathJoin(cottontail.cwd(), "vendors", "bun", exe);
  return cottontail.existsSync(candidate) ? candidate : exe;
}

const bunBuildDriver = `
const spec = await Bun.file(process.argv[2]).json();
const result = await Bun.build(spec);
const outputs = [];
for (const output of result.outputs || []) {
  outputs.push({ path: output.path || "", text: await output.text() });
}
console.log(JSON.stringify({ success: result.success !== false, logs: result.logs || [], outputs }));
`;

export async function build(options) {
  const tmp = tmpRoot("bun-build");
  cottontail.mkdirSync(tmp, true);
  const id = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const specPath = pathJoin(tmp, `build-${id}.json`);
  const driverPath = pathJoin(tmp, "bun-build-driver.mjs");
  cottontail.writeFile(specPath, JSON.stringify(options));
  cottontail.writeFile(driverPath, bunBuildDriver);
  const result = cottontail.spawnSync(bunBinary(), [driverPath, specPath], { stdio: "pipe" });
  if (result.status !== 0) {
    const error = new Error(result.stderr || result.stdout || "Bun.build failed");
    error.exitCode = result.status;
    throw error;
  }
  const parsed = JSON.parse(result.stdout);
  return {
    success: parsed.success,
    logs: parsed.logs,
    outputs: (parsed.outputs || []).map((output) => ({
      path: output.path,
      text: async () => output.text,
    })),
  };
}

function normalizeCommand(command, maybeArgs = undefined, maybeOptions = undefined) {
  if (command && typeof command === "object" && !Array.isArray(command) && Array.isArray(command.cmd)) {
    if (command.cmd.length === 0) throw new TypeError("Bun.spawn requires a non-empty cmd array");
    return [String(command.cmd[0]), command.cmd.slice(1).map(String), { ...command, cmd: undefined, ...(maybeArgs || {}) }];
  }
  if (Array.isArray(command)) {
    if (command.length === 0) throw new TypeError("Bun.spawn requires a non-empty command array");
    return [String(command[0]), command.slice(1).map(String), maybeArgs || {}];
  }
  return [String(command), Array.from(maybeArgs ?? [], String), maybeOptions || {}];
}

function normalizeStdio(value, fallback) {
  if (value === undefined) return fallback;
  if (value === null) return "ignore";
  if (value === "pipe" || value === "inherit" || value === "ignore") return value;
  if (typeof value === "number") return "inherit";
  return "pipe";
}

function normalizeSpawnOptions(options = {}, defaults = {}) {
  let stdin = defaults.stdin ?? "ignore";
  let stdout = defaults.stdout ?? "pipe";
  let stderr = defaults.stderr ?? "inherit";

  if (Array.isArray(options.stdio)) {
    stdin = normalizeStdio(options.stdio[0], stdin);
    stdout = normalizeStdio(options.stdio[1], stdout);
    stderr = normalizeStdio(options.stdio[2], stderr);
  } else if (typeof options.stdio === "string") {
    stdin = stdout = stderr = normalizeStdio(options.stdio, stdout);
  }

  stdin = normalizeStdio(options.stdin, stdin);
  stdout = normalizeStdio(options.stdout, stdout);
  stderr = normalizeStdio(options.stderr, stderr);

  const input = options.input ?? options.stdin;
  if (input != null && input !== "pipe" && input !== "inherit" && input !== "ignore") {
    stdin = "pipe";
  }

  return {
    cwd: options.cwd,
    env: options.env,
    clearEnv: options.env !== undefined,
    stdin,
    stdout,
    stderr,
    input: input != null && input !== "pipe" && input !== "inherit" && input !== "ignore" ? input : undefined,
  };
}

function currentProcessEnv() {
  return { ...(globalThis.process?.env ?? BunObject.env ?? cottontail.env()) };
}

function withoutElectrobunHostEnv(env) {
  const next = { ...(env ?? {}) };
  for (const key of Object.keys(next)) {
    if (key.startsWith("COTTONTAIL_ELECTROBUN_")) delete next[key];
  }
  return next;
}

function isCurrentCottontailExecutable(file) {
  const execPath = String(globalThis.process?.execPath ?? cottontail.execPath?.() ?? "");
  return execPath.length > 0 && String(file) === execPath;
}

function prepareNativeSpawnOptions(file, nativeOptions) {
  if (isCurrentCottontailExecutable(file) && nativeOptions.env === undefined) {
    return {
      ...nativeOptions,
      env: withoutElectrobunHostEnv(currentProcessEnv()),
      clearEnv: true,
    };
  }
  if (nativeOptions.env !== undefined) {
    return {
      ...nativeOptions,
      clearEnv: true,
    };
  }
  return nativeOptions;
}

function asBuffer(value) {
  if (globalThis.Buffer?.from) return globalThis.Buffer.from(value ?? "");
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new TextEncoder().encode(String(value ?? ""));
}

function concatBuffers(left, right) {
  const lhs = asBuffer(left);
  const rhs = asBuffer(right);
  if (globalThis.Buffer?.concat) return globalThis.Buffer.concat([lhs, rhs]);
  const out = new Uint8Array(lhs.length + rhs.length);
  out.set(lhs, 0);
  out.set(rhs, lhs.length);
  return out;
}

function concatManyBuffers(chunks) {
  if (globalThis.Buffer?.concat) return globalThis.Buffer.concat(chunks.map(asBuffer));
  let length = 0;
  for (const chunk of chunks) length += asBuffer(chunk).length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const bytes = asBuffer(chunk);
    out.set(bytes, offset);
    offset += bytes.length;
  }
  return out;
}

function signalName(signalNumber) {
  const signals = {
    1: "SIGHUP",
    2: "SIGINT",
    3: "SIGQUIT",
    6: "SIGABRT",
    9: "SIGKILL",
    14: "SIGALRM",
    15: "SIGTERM",
  };
  return signals[Number(signalNumber)] ?? null;
}

function signalNumber(signal = "SIGTERM") {
  if (typeof signal === "number") return signal;
  const name = String(signal).toUpperCase();
  const signals = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGALRM: 14,
    SIGTERM: 15,
  };
  return signals[name] ?? 15;
}

export function spawnSync(command, maybeArgsOrOptions = {}, maybeOptions = undefined) {
  const [file, args, options] = normalizeCommand(command, maybeArgsOrOptions, maybeOptions);
  const nativeOptions = prepareNativeSpawnOptions(file, normalizeSpawnOptions(options, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
  const inherited = nativeOptions.stdin === "inherit" || nativeOptions.stdout === "inherit" || nativeOptions.stderr === "inherit";
  const result = cottontail.spawnSync(file, args, {
    cwd: nativeOptions.cwd,
    env: nativeOptions.env,
    clearEnv: nativeOptions.clearEnv,
    stdio: inherited ? "inherit" : "pipe",
  });
  const exitCode = Number(result.status ?? result.exitCode ?? 0);
  return {
    stdout: asBuffer(result.stdout ?? ""),
    stderr: asBuffer(result.stderr ?? ""),
    exitCode,
    signalCode: null,
    success: exitCode === 0,
    status: exitCode,
  };
}

class ProcessReadable {
  constructor(read) {
    this._read = read;
    this._listeners = new Map();
    this._chunks = [];
    this._readRequests = [];
    this._ended = false;
  }
  on(name, handler) {
    if (typeof handler !== "function") return this;
    const key = String(name);
    const handlers = this._listeners.get(key) ?? [];
    handlers.push(handler);
    this._listeners.set(key, handlers);
    return this;
  }
  once(name, handler) {
    const wrapped = (...args) => {
      this.off(name, wrapped);
      handler(...args);
    };
    wrapped.listener = handler;
    return this.on(name, wrapped);
  }
  off(name, handler) {
    const key = String(name);
    const handlers = this._listeners.get(key) ?? [];
    this._listeners.set(key, handlers.filter((item) => item !== handler && item.listener !== handler));
    return this;
  }
  removeListener(name, handler) {
    return this.off(name, handler);
  }
  emit(name, ...args) {
    if (name === "data") this._push(args[0]);
    if (name === "end" || name === "close") this._finish();
    for (const handler of this._listeners.get(String(name)) ?? []) handler(...args);
  }
  _push(chunk) {
    if (this._ended) return;
    if (this._readRequests.length > 0) {
      const resolve = this._readRequests.shift();
      resolve({ done: false, value: chunk });
      return;
    }
    this._chunks.push(chunk);
  }
  _finish() {
    if (this._ended) return;
    this._ended = true;
    while (this._readRequests.length > 0) {
      const resolve = this._readRequests.shift();
      resolve({ done: true, value: undefined });
    }
  }
  async arrayBuffer() {
    const bytes = asBuffer(await this._read());
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  async bytes() {
    return asBuffer(await this._read());
  }
  async text() {
    return new TextDecoder().decode(await this.bytes());
  }
  async json() {
    return JSON.parse(await this.text());
  }
  getReader() {
    let cancelled = false;
    return {
      read: async () => {
        if (cancelled) return { done: true, value: undefined };
        if (this._chunks.length > 0) return { done: false, value: this._chunks.shift() };
        if (this._ended) return { done: true, value: undefined };
        return new Promise((resolve) => this._readRequests.push(resolve));
      },
      releaseLock() {},
      cancel() {
        cancelled = true;
        return Promise.resolve();
      },
    };
  }
  async *[Symbol.asyncIterator]() {
    const reader = this.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  }
}

class ProcessWritable {
  constructor(processId) {
    this._processId = processId;
    this._listeners = new Map();
  }
  on(name, handler) {
    if (typeof handler !== "function") return this;
    const key = String(name);
    const handlers = this._listeners.get(key) ?? [];
    handlers.push(handler);
    this._listeners.set(key, handlers);
    return this;
  }
  once(name, handler) {
    const wrapped = (...args) => {
      this.off(name, wrapped);
      handler(...args);
    };
    wrapped.listener = handler;
    return this.on(name, wrapped);
  }
  off(name, handler) {
    const key = String(name);
    const handlers = this._listeners.get(key) ?? [];
    this._listeners.set(key, handlers.filter((item) => item !== handler && item.listener !== handler));
    return this;
  }
  removeListener(name, handler) {
    return this.off(name, handler);
  }
  emit(name, ...args) {
    for (const handler of this._listeners.get(String(name)) ?? []) handler(...args);
  }
  write(chunk, callback) {
    const ok = cottontail.spawnWrite?.(this._processId, chunk) === true;
    if (typeof callback === "function") callback(ok ? null : new Error("write failed"));
    return ok;
  }
  end(chunk) {
    if (chunk != null) this.write(chunk);
    cottontail.spawnCloseStdin?.(this._processId);
    this.emit("finish");
    this.emit("close");
  }
  destroy() {
    cottontail.spawnCloseStdin?.(this._processId);
    this.emit("close");
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

export function spawn(command, maybeArgsOrOptions = {}, maybeOptions = undefined) {
  const [file, args, options] = normalizeCommand(command, maybeArgsOrOptions, maybeOptions);
  const nativeOptions = prepareNativeSpawnOptions(file, normalizeSpawnOptions(options, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
  const listeners = new Map();
  let killed = false;
  let exitCode = null;
  let signalCode = null;
  let stdoutBuffer = asBuffer("");
  let stderrBuffer = asBuffer("");
  let unregisterSpawnListener = null;

  const child = {
    pid: 0,
    stdin: null,
    stdout: nativeOptions.stdout === "pipe" ? new ProcessReadable(() => child.exited.then(() => stdoutBuffer)) : null,
    stderr: nativeOptions.stderr === "pipe" ? new ProcessReadable(() => child.exited.then(() => stderrBuffer)) : null,
    get readable() {
      return child.stdout;
    },
    terminal: undefined,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    get killed() {
      return killed;
    },
    exited: null,
    on(name, handler) {
      const handlers = listeners.get(name) ?? [];
      handlers.push(handler);
      listeners.set(name, handlers);
      return child;
    },
    once(name, handler) {
      const wrapped = (...args) => {
        child.off(name, wrapped);
        handler(...args);
      };
      return child.on(name, wrapped);
    },
    off(name, handler) {
      const handlers = listeners.get(name) ?? [];
      listeners.set(name, handlers.filter((candidate) => candidate !== handler));
      return child;
    },
    kill(signal = "SIGTERM") {
      killed = cottontail.spawnKill?.(child._id, signalNumber(signal)) === true;
    },
    ref() {
      unregisterSpawnListener?.ref?.();
      return child;
    },
    unref() {
      unregisterSpawnListener?.unref?.();
      return child;
    },
    send() {
      return false;
    },
    disconnect() {},
    resourceUsage() {
      return undefined;
    },
  };

  function emit(name, ...args) {
    for (const handler of listeners.get(name) ?? []) handler(...args);
  }

  if (options.detached) {
    child.pid = cottontail.spawnDetached(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "ignore",
    });
    exitCode = 0;
    child.exited = Promise.resolve(0);
    return child;
  }

  const native = cottontail.spawnStart(file, args, nativeOptions);
  child._id = native.id;
  child.pid = native.pid;
  child.stdin = nativeOptions.stdin === "pipe" && nativeOptions.input === undefined ? new ProcessWritable(native.id) : null;

  child.exited = new Promise((resolve, reject) => {
    const complete = async (result) => {
      if (unregisterSpawnListener != null) {
        unregisterSpawnListener();
        unregisterSpawnListener = null;
      }
      exitCode = result.exitCode == null ? null : Number(result.exitCode);
      signalCode = result.signalCode == null ? null : signalName(result.signalCode) ?? String(result.signalCode);
      killed = killed || result.killed === true;
      try {
        if (child.stdout) {
          child.stdout.emit("end");
          child.stdout.emit("close");
        }
        if (child.stderr) {
          child.stderr.emit("end");
          child.stderr.emit("close");
        }
        if (typeof options.onExit === "function") {
          await options.onExit(child, exitCode, signalCode, undefined);
        }
        emit("exit", exitCode, signalCode);
        emit("close", exitCode, signalCode);
        cottontail.spawnDispose?.(native.id);
        resolve(exitCode);
      } catch (error) {
        reject(error);
      }
    };

    unregisterSpawnListener = globalThis.__cottontailRegisterSpawnListener?.(native.id, (event) => {
      if (!event) return;
      if (event.type === "stdout") {
        const chunk = asBuffer(event.data ?? new ArrayBuffer(0));
        if (chunk.length > 0) {
          stdoutBuffer = concatBuffers(stdoutBuffer, chunk);
          child.stdout?.emit("data", chunk);
        }
        return;
      }
      if (event.type === "stderr") {
        const chunk = asBuffer(event.data ?? new ArrayBuffer(0));
        if (chunk.length > 0) {
          stderrBuffer = concatBuffers(stderrBuffer, chunk);
          child.stderr?.emit("data", chunk);
        }
        return;
      }
      if (event.type === "exit") {
        complete(event);
      }
    });
  });

  return child;
}

function bytesFromData(data) {
  if (data == null) return new Uint8Array(0);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data));
}

async function bytesFromBody(body) {
  if (body == null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body.bytes === "function") return asBuffer(await body.bytes());
  if (typeof body.arrayBuffer === "function") return new Uint8Array(await body.arrayBuffer());
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(asBuffer(value));
    }
    return concatManyBuffers(chunks);
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of body) chunks.push(asBuffer(chunk));
    return concatManyBuffers(chunks);
  }
  if (typeof body.text === "function") return new TextEncoder().encode(await body.text());
  return bytesFromData(body);
}

function arrayBufferFromBytes(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export class URL {
  constructor(input, base = undefined) {
    const baseUrl = base == null ? null : base instanceof URL ? base : new URL(String(base));
    let text = String(input);
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) {
      if (!baseUrl && !text.startsWith("/")) throw new TypeError("Invalid URL");
      if (baseUrl) {
        if (text.startsWith("/")) {
          text = `${baseUrl.origin}${text}`;
        } else {
          const basePath = baseUrl.pathname.endsWith("/")
            ? baseUrl.pathname
            : baseUrl.pathname.slice(0, baseUrl.pathname.lastIndexOf("/") + 1);
          text = `${baseUrl.origin}${basePath}${text}`;
        }
      }
    }

    const match = /^([A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(text);
    if (!match) throw new TypeError("Invalid URL");

    this.protocol = match[1] || "http:";
    this.host = match[2];
    const colon = this.host.lastIndexOf(":");
    if (colon >= 0 && /^\d+$/.test(this.host.slice(colon + 1))) {
      this.hostname = this.host.slice(0, colon);
      this.port = this.host.slice(colon + 1);
    } else {
      this.hostname = this.host;
      this.port = "";
    }
    this.pathname = match[3] || "/";
    if (!this.pathname.startsWith("/")) this.pathname = `/${this.pathname}`;
    this.search = match[4] || "";
    this.hash = match[5] || "";
    this.origin = `${this.protocol}//${this.host}`;
    this.href = `${this.origin}${this.pathname}${this.search}${this.hash}`;
  }
  toString() {
    return this.href;
  }
  valueOf() {
    return this.href;
  }
  toJSON() {
    return this.href;
  }
}

export class Headers {
  constructor(init = undefined) {
    this._values = new Map();
    if (init instanceof Headers) {
      init.forEach((value, key) => this.set(key, value));
    } else if (Array.isArray(init)) {
      for (const [key, value] of init) this.append(key, value);
    } else if (init && typeof init === "object") {
      for (const key of Object.keys(init)) this.set(key, init[key]);
    }
  }
  append(key, value) {
    const normalized = String(key).toLowerCase();
    const existing = this._values.get(normalized);
    this._values.set(normalized, {
      key: existing?.key ?? String(key),
      value: existing ? `${existing.value}, ${String(value)}` : String(value),
    });
  }
  set(key, value) {
    this._values.set(String(key).toLowerCase(), { key: String(key), value: String(value) });
  }
  get(key) {
    return this._values.get(String(key).toLowerCase())?.value ?? null;
  }
  has(key) {
    return this._values.has(String(key).toLowerCase());
  }
  delete(key) {
    this._values.delete(String(key).toLowerCase());
  }
  forEach(callback, thisArg = undefined) {
    for (const { key, value } of this._values.values()) callback.call(thisArg, value, key, this);
  }
  *entries() {
    for (const { key, value } of this._values.values()) yield [key, value];
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}

export class Request {
  constructor(input, init = {}) {
    this.url = typeof input === "string" ? input : String(input?.url ?? "");
    this.method = String(init.method ?? input?.method ?? "GET").toUpperCase();
    this.headers = new Headers(init.headers ?? input?.headers);
    this._body = init.body ?? input?._body ?? null;
    this.params = init.params ?? input?.params ?? {};
  }
  async arrayBuffer() {
    return arrayBufferFromBytes(await bytesFromBody(this._body));
  }
  async text() {
    return new TextDecoder().decode(await bytesFromBody(this._body));
  }
  async json() {
    return JSON.parse(await this.text());
  }
}

export class Response {
  constructor(body = null, init = {}) {
    this.status = Number(init.status ?? 200);
    this.statusText = String(init.statusText ?? "");
    this.headers = new Headers(init.headers);
    this._body = body;
  }
  static json(value, init = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(JSON.stringify(value), { ...init, headers });
  }
  static redirect(url, status = 302) {
    return new Response(null, { status, headers: { location: String(url) } });
  }
  async arrayBuffer() {
    return arrayBufferFromBytes(await bytesFromBody(this._body));
  }
  async text() {
    return new TextDecoder().decode(await bytesFromBody(this._body));
  }
  async json() {
    return JSON.parse(await this.text());
  }
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
}

export async function fetch(input, init = {}) {
  const request = input instanceof Request ? input : new Request(input, init);
  const args = ["-L", "-sS", "-X", request.method];
  request.headers.forEach((value, key) => {
    args.push("-H", `${key}: ${value}`);
  });
  const body = await request.text();
  if (body.length > 0 && request.method !== "GET" && request.method !== "HEAD") {
    args.push("--data-binary", body);
  }
  args.push("-w", "\n__COTTONTAIL_HTTP_STATUS__:%{http_code}", request.url);

  const result = cottontail.spawnSync("curl", args, { stdio: "pipe" });
  const stdout = String(result.stdout ?? "");
  const marker = "\n__COTTONTAIL_HTTP_STATUS__:";
  const markerIndex = stdout.lastIndexOf(marker);
  const responseBody = markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout;
  const status = markerIndex >= 0 ? Number(stdout.slice(markerIndex + marker.length).trim()) || 0 : Number(result.status) || 0;

  if (result.status !== 0 && status === 0) {
    throw new Error(String(result.stderr || result.stdout || "fetch failed"));
  }

  return new Response(responseBody, { status: status || 200 });
}

function parseHeadersText(text) {
  const headers = new Headers();
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return headers;
}

function headersToText(headers) {
  let out = "";
  const normalized = new Headers(headers);
  normalized.delete("content-length");
  normalized.delete("connection");
  normalized.forEach((value, key) => {
    out += `${key}: ${String(value).replace(/[\r\n]+/g, " ")}\r\n`;
  });
  return out;
}

function isPromiseLike(value) {
  return value != null && typeof value.then === "function";
}

function normalizeResponse(value) {
  if (value instanceof Response) return value;
  return new Response(value);
}

function normalizeResponseResult(value) {
  return isPromiseLike(value) ? value.then(normalizeResponse) : normalizeResponse(value);
}

function defaultServePort(options) {
  if (options.port != null) return Number(options.port);
  for (const name of ["BUN_PORT", "PORT", "NODE_PORT"]) {
    const value = BunObject.env?.[name] ?? cottontail.env(name);
    if (value != null && value !== "") return Number(value);
  }
  return 3000;
}

function requestPathname(request) {
  try {
    return new URL(request.url).pathname;
  } catch {
    return String(request.url).replace(/^https?:\/\/[^/]+/, "").split(/[?#]/, 1)[0] || "/";
  }
}

function matchRoutePattern(pattern, pathname) {
  const normalizedPattern = String(pattern);
  if (normalizedPattern === pathname) return {};
  if (normalizedPattern.endsWith("*")) {
    const prefix = normalizedPattern.slice(0, -1);
    return pathname.startsWith(prefix) ? { "*": pathname.slice(prefix.length) } : null;
  }

  const patternParts = normalizedPattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathParts[index];
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

function selectRoute(routes, request) {
  if (!routes || typeof routes !== "object") return null;
  const pathname = requestPathname(request);
  for (const [pattern, route] of Object.entries(routes)) {
    const params = matchRoutePattern(pattern, pathname);
    if (!params) continue;

    let handler = route;
    if (handler && typeof handler === "object" && !(handler instanceof Response) && typeof handler.arrayBuffer !== "function") {
      handler = handler[request.method] ?? handler[request.method.toLowerCase()] ?? handler.ALL ?? handler.all;
      if (handler == null) return new Response("Method Not Allowed", { status: 405 });
    }
    request.params = params;
    return handler;
  }
  return null;
}

function runServeHandler(options, request, server) {
  const route = selectRoute(options.routes, request);
  if (route != null) {
    if (typeof route === "function") return normalizeResponseResult(route(request, server));
    return normalizeResponse(route);
  }
  if (typeof options.fetch === "function") return normalizeResponseResult(options.fetch(request, server));
  return new Response("Not Found", { status: 404 });
}

export function serve(options = {}) {
  if (typeof options.fetch !== "function" && (options.routes == null || typeof options.routes !== "object")) {
    throw new TypeError("Bun.serve requires a fetch(request, server) handler or routes");
  }

  const hostname = options.hostname ?? "0.0.0.0";
  const native = cottontail.httpServerStart(hostname, defaultServePort(options));
  let activeOptions = options;
  let stopped = false;
  let pumping = false;
  let interval = null;

  const server = {
    id: native.id,
    hostname: native.hostname,
    port: native.port,
    development: activeOptions.development ?? false,
    pendingRequests: 0,
    pendingWebSockets: 0,
    get url() {
      const url = new globalThis.URL(`http://${native.hostname}:${native.port}/`);
      url.pathname = "";
      return url;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (interval != null) clearInterval(interval);
      cottontail.httpServerStop(native.id);
      return Promise.resolve();
    },
    reload(nextOptions = {}) {
      activeOptions = { ...activeOptions, ...nextOptions };
    },
    async fetch(input, init = {}) {
      const request = input instanceof Request ? input : new Request(String(input), init);
      return runServeHandler(activeOptions, request, server);
    },
    ref() {
      return server;
    },
    unref() {
      return server;
    },
    requestIP() {
      return null;
    },
    timeout() {},
    upgrade() {
      return false;
    },
    publish() {
      return 0;
    },
    subscriberCount() {
      return 0;
    },
  };

  const respond = (item, status, headersText, body) => {
    if (stopped) return;
    try {
      cottontail.httpServerRespond(native.id, item.id, status, headersText, body);
    } catch (error) {
      if (stopped && String(error).includes("HTTP server not found")) return;
      throw error;
    }
  };

  const responseBody = (response) => {
    if (response instanceof Response) {
      const body = response._body;
      if (body == null || typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        return arrayBufferFromBytes(bytesFromData(body));
      }
      return response.arrayBuffer();
    }
    return response.arrayBuffer();
  };

  const sendResponse = (item, response, statusOverride = undefined) => {
    const body = responseBody(response);
    const status = statusOverride ?? response.status;
    const headers = headersToText(response.headers);
    if (isPromiseLike(body)) {
      return body.then((resolvedBody) => respond(item, status, headers, resolvedBody));
    }
    respond(item, status, headers, body);
    return undefined;
  };

  const handleError = (item, error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    let response;
    if (typeof activeOptions.error === "function") {
      try {
        response = normalizeResponseResult(activeOptions.error(error));
      } catch (nextError) {
        response = new Response(nextError instanceof Error ? nextError.stack || nextError.message : String(nextError), {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    } else {
      response = new Response(message, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (isPromiseLike(response)) {
      return response.then((resolvedResponse) => sendResponse(item, resolvedResponse, 500));
    }
    return sendResponse(item, response, 500);
  };

  const handle = (item) => {
    const request = new Request(`http://${native.hostname}:${native.port}${item.url}`, {
      method: item.method,
      headers: parseHeadersText(item.headersText),
      body: item.body,
    });
    try {
      const response = runServeHandler(activeOptions, request, server);
      if (isPromiseLike(response)) {
        return response
          .then((resolvedResponse) => sendResponse(item, resolvedResponse))
          .catch((error) => handleError(item, error));
      }
      return sendResponse(item, response);
    } catch (error) {
      return handleError(item, error);
    }
  };

  const pump = () => {
    if (stopped || pumping) return;
    pumping = true;
    while (!stopped) {
      const item = cottontail.httpServerPoll(native.id);
      if (!item) break;
      server.pendingRequests += 1;
      const handled = handle(item);
      if (isPromiseLike(handled)) {
        handled.then(
          () => {},
          (error) => console.error(error instanceof Error ? error.stack || error.message : error),
        ).then(() => {
          server.pendingRequests -= 1;
          pumping = false;
          pump();
        });
        return;
      } else {
        server.pendingRequests -= 1;
      }
    }
    pumping = false;
  };

  interval = setInterval(pump, 1);
  pump();
  return server;
}

function tarString(bytes, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && bytes[end] !== 0) end += 1;
  return new TextDecoder().decode(bytes.slice(offset, end));
}

function tarOctal(bytes, offset, length) {
  const raw = tarString(bytes, offset, length).trim();
  return raw ? parseInt(raw, 8) || 0 : 0;
}

function safeArchivePath(path) {
  const normalized = String(path).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Unsafe archive path: ${path}`);
  }
  return normalized;
}

class ArchiveFile {
  constructor(name, bytes, type = "file") {
    this.name = name;
    this.size = bytes.byteLength;
    this.type = type;
    this._bytes = bytes;
  }
  async arrayBuffer() {
    return arrayBufferFromBytes(this._bytes);
  }
  async text() {
    return new TextDecoder().decode(this._bytes);
  }
  async json() {
    return JSON.parse(await this.text());
  }
}

export class Archive {
  constructor(input) {
    this._bytes = bytesFromData(input);
    this._files = null;
  }
  _parseFiles() {
    if (this._files) return this._files;
    const files = new Map();
    const bytes = this._bytes;
    for (let offset = 0; offset + 512 <= bytes.length;) {
      const name = tarString(bytes, offset, 100);
      const prefix = tarString(bytes, offset + 345, 155);
      const size = tarOctal(bytes, offset + 124, 12);
      const typeflag = String.fromCharCode(bytes[offset + 156] || 0);
      if (!name && size === 0) break;
      const path = safeArchivePath(prefix ? `${prefix}/${name}` : name);
      const dataOffset = offset + 512;
      if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
        files.set(path, new ArchiveFile(path, bytes.slice(dataOffset, dataOffset + size)));
      }
      offset = dataOffset + Math.ceil(size / 512) * 512;
    }
    this._files = files;
    return files;
  }
  async files() {
    return this._parseFiles();
  }
  async extract(destination) {
    const dest = String(destination);
    cottontail.mkdirSync(dest, true);
    const archiveTmpRoot = tmpRoot("archive");
    cottontail.mkdirSync(archiveTmpRoot, true);
    const tarPath = pathJoin(archiveTmpRoot, `archive-${Date.now()}-${Math.floor(Math.random() * 1000000)}.tar`);
    cottontail.writeFile(tarPath, this._bytes);
    const result = cottontail.spawnSync("tar", ["-xf", tarPath, "-C", dest], { stdio: "pipe" });
    cottontail.unlinkSync(tarPath);
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `tar extraction failed with status ${result.status}`);
    }
  }
  async bytes() {
    return arrayBufferFromBytes(this._bytes);
  }
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

export function file(path) {
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
          const text = chunks.map((item) => typeof item === "string" ? item : new TextDecoder().decode(item)).join("");
          cottontail.writeFile(filePath, text);
        },
      };
    },
  };
}

export async function write(path, data) {
  cottontail.writeFile(String(path), data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : String(data));
}

export class ArrayBufferSink {
  constructor() {
    this._chunks = [];
    this._ended = false;
  }

  write(chunk) {
    if (this._ended) throw new Error("ArrayBufferSink is closed");
    this._chunks.push(asBuffer(chunk));
    return true;
  }

  flush() {
    return undefined;
  }

  end(chunk = undefined) {
    if (chunk != null) this.write(chunk);
    this._ended = true;
    const bytes = concatManyBuffers(this._chunks);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
}

function nodeDigest(algorithm, chunks, encoding = "hex") {
  const hash = createHash(algorithm);
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest(encoding);
}

export class CryptoHasher {
  constructor(algorithm) {
    if (algorithm == null) throw new TypeError("Expected an algorithm name as an argument");
    this.algorithm = String(algorithm).toLowerCase().replace(/_/g, "-");
    this._chunks = [];
    this._finished = false;
  }

  get byteLength() {
    return {
      md5: 16,
      sha1: 20,
      sha224: 28,
      sha256: 32,
      sha384: 48,
      sha512: 64,
      "sha512-256": 32,
    }[this.algorithm] ?? 0;
  }

  update(data, encoding = undefined) {
    if (this._finished) throw new Error("Digest already called");
    this._chunks.push(encoding ? globalThis.Buffer.from(String(data), encoding) : asBuffer(data));
    return this;
  }

  digest(encoding = "hex") {
    if (this._finished) throw new Error("Digest already called");
    this._finished = true;
    const algorithm = this.algorithm === "sha512-256" ? "sha512" : this.algorithm;
    const output = nodeDigest(algorithm, this._chunks, encoding === "buffer" ? undefined : encoding);
    if (this.algorithm === "sha512-256" && (encoding == null || encoding === "buffer")) return output.subarray(0, 32);
    if (this.algorithm === "sha512-256" && encoding === "hex") return output.slice(0, 64);
    return output;
  }

  copy() {
    const next = new CryptoHasher(this.algorithm);
    next._chunks = this._chunks.map((chunk) => asBuffer(chunk));
    return next;
  }
}

function hashClass(algorithm) {
  return class BunHash {
    constructor() {
      this._hasher = new CryptoHasher(algorithm);
    }
    get byteLength() {
      return this._hasher.byteLength;
    }
    update(data, encoding = undefined) {
      this._hasher.update(data, encoding);
      return this;
    }
    digest(encoding = "hex") {
      return this._hasher.digest(encoding);
    }
  };
}

export const MD4 = hashClass("md4");
export const MD5 = hashClass("md5");
export const SHA1 = hashClass("sha1");
export const SHA224 = hashClass("sha224");
export const SHA256 = hashClass("sha256");
export const SHA384 = hashClass("sha384");
export const SHA512 = hashClass("sha512");
export const SHA512_256 = hashClass("sha512-256");

export function allocUnsafe(size) {
  return globalThis.Buffer?.allocUnsafe ? globalThis.Buffer.allocUnsafe(Number(size)) : new Uint8Array(Number(size));
}

export function concatArrayBuffers(buffers, resultType = ArrayBuffer) {
  const bytes = concatManyBuffers(Array.from(buffers ?? []));
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (resultType === ArrayBuffer || resultType == null) return arrayBuffer;
  return new resultType(arrayBuffer);
}

export const cwd = cottontail.cwd();
export const main = globalThis.process?.argv?.[1] ?? "";
export const origin = "";
export const isMainThread = cottontail.isWorker?.() !== true;
export const version = "0.0.0-cottontail";
export const revision = "cottontail";
export const version_with_sha = `${version} (${revision})`;
export const stdin = globalThis.process?.stdin;
export const stdout = globalThis.process?.stdout;
export const stderr = globalThis.process?.stderr;
export const SQL = SQLiteDatabase;
export const sql = SQLiteDatabase;
export const jest = bunJest;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Number(ms)));
}

export function sleepSync(ms) {
  cottontail.sleep(Number(ms));
}

export function nanoseconds() {
  return globalThis.process?.hrtime?.bigint?.() ?? BigInt(Math.floor((performance?.now?.() ?? Date.now()) * 1_000_000));
}

export function gc() {
  globalThis.gc?.();
  cottontail.drainJobs?.();
}

export function inspect(value, options = undefined) {
  return nodeInspect(value, options);
}

export function deepEquals(left, right) {
  return isDeepStrictEqual(left, right);
}

export function deepMatch(left, right) {
  if (right == null || typeof right !== "object") return isDeepStrictEqual(left, right);
  if (left == null || typeof left !== "object") return false;
  for (const key of Object.keys(right)) {
    if (!deepMatch(left[key], right[key])) return false;
  }
  return true;
}

export function escapeHTML(value, attribute = false) {
  const text = String(value);
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return attribute ? escaped.replace(/"/g, "&quot;").replace(/'/g, "&#x27;") : escaped;
}

export function stripANSI(value) {
  return stripVTControlCharacters(String(value));
}

export function stringWidth(value, _options = undefined) {
  return Array.from(stripANSI(value)).length;
}

export function wrapAnsi(value, columns = 80) {
  const width = Math.max(1, Number(columns) || 80);
  const chars = Array.from(String(value));
  const lines = [];
  for (let index = 0; index < chars.length; index += width) lines.push(chars.slice(index, index + width).join(""));
  return lines.join("\n");
}

export function indexOfLine(value, line = 0) {
  const text = String(value);
  let offset = 0;
  for (let index = 0; index < Number(line); index += 1) {
    const next = text.indexOf("\n", offset);
    if (next === -1) return -1;
    offset = next + 1;
  }
  return offset;
}

export function fileURLToPath(value) {
  return nodeFileURLToPath(value);
}

export function pathToFileURL(value) {
  return nodePathToFileURL(value);
}

export function resolveSync(specifier, from = cottontail.cwd()) {
  if (String(specifier).startsWith("node:")) return String(specifier);
  if (["fs", "path", "crypto", "http", "https", "net", "tls", "zlib", "dns"].includes(String(specifier))) {
    return `node:${specifier}`;
  }
  if (String(specifier).startsWith(".") || String(specifier).startsWith("/")) {
    const base = String(from).replace(/\/[^/]*$/, "");
    return pathJoin(String(specifier).startsWith("/") ? "" : base, String(specifier));
  }
  return String(specifier);
}

export function resolve(specifier, from = cottontail.cwd()) {
  return Promise.resolve(resolveSync(specifier, from));
}

export function sha(value) {
  return createHash("sha256").update(asBuffer(value)).digest();
}

export function hash(value) {
  let out = 0xcbf29ce484222325n;
  for (const byte of asBuffer(value)) {
    out ^= BigInt(byte);
    out = BigInt.asUintN(64, out * 0x100000001b3n);
  }
  return out;
}

function uuidBytesToString(bytes) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomUUIDv7() {
  const bytes = randomBytes(16);
  const timestamp = Date.now();
  bytes[0] = (timestamp / 0x10000000000) & 0xff;
  bytes[1] = (timestamp / 0x100000000) & 0xff;
  bytes[2] = (timestamp / 0x1000000) & 0xff;
  bytes[3] = (timestamp / 0x10000) & 0xff;
  bytes[4] = (timestamp / 0x100) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return uuidBytesToString(bytes);
}

export function randomUUIDv5(name, namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8") {
  const ns = String(namespace).replace(/-/g, "");
  const nsBytes = new Uint8Array(ns.match(/../g).map((part) => parseInt(part, 16)));
  const digest = createHash("sha1").update(nsBytes).update(String(name)).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return uuidBytesToString(digest.subarray(0, 16));
}

export async function readableStreamToArray(stream) {
  const reader = typeof stream?.getReader === "function" ? stream.getReader() : null;
  const chunks = [];
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return chunks;
  }
  if (typeof stream?.[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream) chunks.push(chunk);
  }
  return chunks;
}

export async function readableStreamToBytes(stream) {
  return concatManyBuffers(await readableStreamToArray(stream));
}

export async function readableStreamToArrayBuffer(stream) {
  const bytes = await readableStreamToBytes(stream);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export async function readableStreamToText(stream) {
  return new TextDecoder().decode(await readableStreamToBytes(stream));
}

export async function readableStreamToJSON(stream) {
  return JSON.parse(await readableStreamToText(stream));
}

export async function readableStreamToBlob(stream) {
  return new Blob([await readableStreamToArrayBuffer(stream)]);
}

export async function readableStreamToFormData(stream, formData = new FormData()) {
  const text = await readableStreamToText(stream);
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const [key, value = ""] = pair.split("=");
    formData.append(decodeURIComponent(key), decodeURIComponent(value));
  }
  return formData;
}

export function generateHeapSnapshot() {
  return cottontail.writeHeapSnapshot?.() ?? "";
}

export function enableANSIColors(value = true) {
  return Boolean(value);
}

export function color(value, _name = undefined) {
  return String(value);
}

export function shrink() {
  gc();
}

export function peek(value) {
  return value;
}

export function mmap(path) {
  return cottontail.readFileBuffer(String(path));
}

export function openInEditor(path) {
  return spawn(["open", String(path)], { stdout: "ignore", stderr: "ignore" });
}

export async function connect(options = {}) {
  const net = await import("../node/net.js");
  return net.connect(options);
}

export async function listen(options = {}, handler = undefined) {
  const net = await import("../node/net.js");
  const server = net.createServer(typeof handler === "function" ? handler : options.socket);
  if (options.port != null || options.hostname != null) {
    server.listen(Number(options.port ?? 0), options.hostname ?? "127.0.0.1");
  }
  return server;
}

export async function udpSocket(options = {}) {
  const dgram = await import("../node/dgram.js");
  return dgram.createSocket(options.type ?? "udp4");
}

export function plugin(_plugin) {
  return undefined;
}

export function registerMacro(_name, _macro = undefined) {
  return undefined;
}

export const deflateSync = zlib.deflateSync;
export const gzipSync = zlib.gzipSync;
export const gunzipSync = zlib.gunzipSync;
export const inflateSync = zlib.inflateSync;
export const zstdCompress = zlib.zstdCompress;
export const zstdCompressSync = zlib.zstdCompressSync;
export const zstdDecompress = zlib.zstdDecompress;
export const zstdDecompressSync = zlib.zstdDecompressSync;
export { dns, FFI };

export const TOML = {
  parse(text) {
    const out = {};
    for (const line of String(text).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) out[trimmed.slice(0, eq).trim()] = JSON.parse(trimmed.slice(eq + 1).trim());
    }
    return out;
  },
  stringify(value) {
    return Object.entries(value ?? {}).map(([key, item]) => `${key} = ${JSON.stringify(item)}`).join("\n");
  },
};

export const JSONC = {
  parse(text) {
    return JSON.parse(String(text).replace(/\/\*[^]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"));
  },
};

export const JSON5 = {
  parse: JSONC.parse,
  stringify: JSON.stringify,
};

export const JSONL = {
  parse(text) {
    return String(text).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  },
  parseChunk(text) {
    return this.parse(text);
  },
};

export const YAML = {
  parse(text) {
    const out = {};
    for (const line of String(text).split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0) out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    return out;
  },
  stringify(value) {
    return Object.entries(value ?? {}).map(([key, item]) => `${key}: ${String(item)}`).join("\n");
  },
};

export class Cookie {
  constructor(name, value, options = {}) {
    this.name = String(name);
    this.value = String(value);
    Object.assign(this, options);
  }
  static parse(text) {
    const [pair] = String(text).split(";");
    const [name, value = ""] = pair.split("=");
    return new Cookie(name.trim(), value.trim());
  }
  static from(value) {
    return value instanceof Cookie ? value : Cookie.parse(value);
  }
  toString() {
    return `${this.name}=${this.value}`;
  }
}

export class CookieMap extends Map {
  constructor(init = undefined) {
    super();
    if (typeof init === "string") {
      for (const part of init.split(";")) {
        const [name, value = ""] = part.trim().split("=");
        if (name) this.set(name, value);
      }
    } else if (init) {
      for (const [key, value] of Object.entries(init)) this.set(key, value);
    }
  }
  toString() {
    return [...this].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}

export class Glob {
  constructor(pattern) {
    this.pattern = String(pattern);
    this._regexp = globToRegExp(this.pattern);
  }
  match(value) {
    return this._regexp.test(String(value).replace(/\\/g, "/"));
  }
  scanSync(options = {}) {
    const cwd = String(options.cwd ?? options.root ?? cottontail.cwd());
    const absolute = Boolean(options.absolute);
    const onlyFiles = options.onlyFiles !== false;
    const dot = Boolean(options.dot);
    const results = [];
    for (const entry of walkFiles(cwd, { dot, onlyFiles })) {
      if (!this.match(entry.relative)) continue;
      results.push(absolute ? entry.absolute : entry.relative);
    }
    return results;
  }
  async *scan(options = {}) {
    yield* this.scanSync(options);
  }
}

function globToRegExp(pattern) {
  const text = String(pattern).replace(/\\/g, "/");
  let source = "^";
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === "*") {
      if (text[index + 1] === "*") {
        index += 2;
        if (text[index] === "/") index += 1;
        source += "(?:.*\\/)?";
      } else {
        index += 1;
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`${source}$`);
}

function walkFiles(root, options = {}, prefix = "") {
  const entries = [];
  for (const entry of cottontail.readDirSync(root)) {
    if (!options.dot && entry.name.startsWith(".")) continue;
    const absolute = pathJoin(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const isDirectory = entry.kind === "directory" || entry.type === "directory" || entry.isDirectory === true;
    if (isDirectory) {
      entries.push(...walkFiles(absolute, options, relative));
    } else if (options.onlyFiles !== false) {
      entries.push({ absolute, relative });
    } else {
      entries.push({ absolute, relative });
    }
  }
  return entries;
}

export class Transpiler {
  constructor(options = {}) {
    this.options = options;
  }
  transformSync(source, loader = this.options.loader ?? "tsx") {
    const tmp = tmpRoot("bun-transpiler");
    cottontail.mkdirSync(tmp, true);
    const id = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const specPath = pathJoin(tmp, `transform-${id}.json`);
    const driverPath = pathJoin(tmp, "bun-transpiler-driver.mjs");
    const script = `
const spec = await Bun.file(process.argv[2]).json();
const source = spec.source;
const loader = spec.loader;
const transpiler = new Bun.Transpiler({ loader });
process.stdout.write(transpiler.transformSync(source));
`;
    cottontail.writeFile(specPath, JSON.stringify({ source: String(source), loader: String(loader) }));
    cottontail.writeFile(driverPath, script);
    const result = cottontail.spawnSync(bunBinary(), [driverPath, specPath], { stdio: "pipe" });
    if (Number(result.status ?? 0) !== 0) throw new Error(String(result.stderr || result.stdout || "Bun.Transpiler transform failed"));
    return String(result.stdout ?? "");
  }
  async transform(source) {
    return this.transformSync(source);
  }
  scan(source) {
    const text = String(source);
    const imports = [];
    const exports = [];
    for (const match of text.matchAll(/\bimport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g)) {
      imports.push({ kind: "import-statement", path: match[1] });
    }
    for (const match of text.matchAll(/\bexport\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
      exports.push(match[1]);
    }
    for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
      for (const part of match[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) exports.push(name);
      }
    }
    return { exports: [...new Set(exports)], imports };
  }
  scanImports(source) {
    return this.scan(source).imports;
  }
}

export class FileSystemRouter {
  constructor(options = {}) {
    this.options = options;
    this.style = options.style ?? "nextjs";
    this.origin = options.origin ?? "";
    this.routes = {};
    this.reload();
  }
  match(path) {
    return this.routes[normalizeRoutePath(path)] ?? {};
  }
  reload() {
    this.routes = {};
    const dir = String(this.options.dir ?? this.options.root ?? ".");
    if (!cottontail.existsSync(dir)) return undefined;
    for (const entry of walkFiles(dir, { dot: false, onlyFiles: true })) {
      if (!/\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(entry.relative)) continue;
      const route = routePathFromFile(entry.relative);
      this.routes[route] = {
        filePath: entry.absolute,
        kind: "exact",
        name: route,
        pathname: route,
        src: entry.relative,
      };
    }
    return undefined;
  }
}

function normalizeRoutePath(value) {
  const pathname = String(value?.pathname ?? value).split(/[?#]/, 1)[0] || "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function routePathFromFile(file) {
  let route = String(file).replace(/\\/g, "/").replace(/\.(?:js|jsx|ts|tsx|mjs|cjs)$/, "");
  route = route.replace(/\/index$/, "").replace(/^index$/, "");
  route = route.replace(/\[([^\]]+)\]/g, ":$1");
  return `/${route}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

export class Terminal {}
export class RedisClient {}
export class S3Client {}
export const redis = null;
export const postgres = null;
export const s3 = null;
export const secrets = {};
export const password = {};
export const semver = {
  order(left, right) {
    const a = String(left).split(".").map(Number);
    const b = String(right).split(".").map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const diff = (a[index] || 0) - (b[index] || 0);
      if (diff !== 0) return Math.sign(diff);
    }
    return 0;
  },
};
export const markdown = {};
export const embeddedFiles = [];
export const unsafe = {};
export const CSRF = {};

class CottontailDOMException extends Error {
  constructor(message = "", name = "Error") {
    super(String(message));
    this.name = String(name);
    this.code = 0;
  }
}

class CottontailEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.composed = Boolean(init.composed);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

class CottontailEventTarget {
  constructor() {
    this.__ctEventListeners = new Map();
  }

  addEventListener(type, listener, options = undefined) {
    if (listener == null) return;
    const name = String(type);
    const listeners = this.__ctEventListeners.get(name) ?? [];
    if (!listeners.some((entry) => entry.listener === listener)) {
      listeners.push({ listener, once: Boolean(options && typeof options === "object" && options.once) });
    }
    this.__ctEventListeners.set(name, listeners);
  }

  removeEventListener(type, listener) {
    const name = String(type);
    const listeners = this.__ctEventListeners.get(name);
    if (!listeners) return;
    this.__ctEventListeners.set(name, listeners.filter((entry) => entry.listener !== listener));
  }

  dispatchEvent(event) {
    const dispatched = event && typeof event === "object" ? event : new CottontailEvent(String(event));
    if (!dispatched.target) dispatched.target = this;
    dispatched.currentTarget = this;
    const listeners = [...(this.__ctEventListeners.get(String(dispatched.type)) ?? [])];
    for (const entry of listeners) {
      const listener = entry.listener;
      if (typeof listener === "function") listener.call(this, dispatched);
      else if (listener && typeof listener.handleEvent === "function") listener.handleEvent(dispatched);
      if (entry.once) this.removeEventListener(dispatched.type, listener);
    }
    const handler = this[`on${dispatched.type}`];
    if (typeof handler === "function") handler.call(this, dispatched);
    return !dispatched.defaultPrevented;
  }
}

function makeAbortError() {
  const DOMExceptionClass = globalThis.DOMException ?? CottontailDOMException;
  return new DOMExceptionClass("This operation was aborted", "AbortError");
}

class CottontailAbortSignal extends CottontailEventTarget {
  constructor() {
    super();
    this.aborted = false;
    this.reason = undefined;
    this.onabort = null;
  }

  throwIfAborted() {
    if (this.aborted) throw this.reason;
  }

  static abort(reason = makeAbortError()) {
    const controller = new CottontailAbortController();
    controller.abort(reason);
    return controller.signal;
  }

  static timeout(delay) {
    const controller = new CottontailAbortController();
    setTimeout(() => {
      const DOMExceptionClass = globalThis.DOMException ?? CottontailDOMException;
      controller.abort(new DOMExceptionClass("The operation timed out", "TimeoutError"));
    }, Math.max(0, Number(delay) || 0));
    return controller.signal;
  }

  static any(signals) {
    const controller = new CottontailAbortController();
    for (const signal of signals ?? []) {
      if (signal?.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal?.addEventListener?.("abort", () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
  }
}

class CottontailAbortController {
  constructor() {
    this.signal = new CottontailAbortSignal();
  }

  abort(reason = makeAbortError()) {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason;
    const EventClass = globalThis.Event ?? CottontailEvent;
    this.signal.dispatchEvent(new EventClass("abort"));
  }
}

function structuredCloneValue(value, seen) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    const clonedBuffer = structuredCloneValue(value.buffer, seen);
    if (value instanceof DataView) return new DataView(clonedBuffer, value.byteOffset, value.byteLength);
    return new value.constructor(clonedBuffer, value.byteOffset, value.length);
  }
  if (value instanceof Map) {
    const result = new Map();
    seen.set(value, result);
    for (const [key, item] of value) result.set(structuredCloneValue(key, seen), structuredCloneValue(item, seen));
    return result;
  }
  if (value instanceof Set) {
    const result = new Set();
    seen.set(value, result);
    for (const item of value) result.add(structuredCloneValue(item, seen));
    return result;
  }
  const result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, result);
  for (const key of Reflect.ownKeys(value)) {
    result[key] = structuredCloneValue(value[key], seen);
  }
  return result;
}

function cottontailStructuredClone(value) {
  return structuredCloneValue(value, new WeakMap());
}

const BunObject = globalThis.Bun ?? {};
BunObject.argv = cottontail.argv || ["cottontail", ...(cottontail.args || [])];
BunObject.env = globalThis.process?.env ?? cottontail.env();
BunObject.$ = $;
BunObject.ArrayBufferSink = ArrayBufferSink;
BunObject.CSRF = CSRF;
BunObject.Cookie = Cookie;
BunObject.CookieMap = CookieMap;
BunObject.CryptoHasher = CryptoHasher;
BunObject.FFI = FFI;
BunObject.FileSystemRouter = FileSystemRouter;
BunObject.Glob = Glob;
BunObject.JSON5 = JSON5;
BunObject.JSONC = JSONC;
BunObject.JSONL = JSONL;
BunObject.MD4 = MD4;
BunObject.MD5 = MD5;
BunObject.RedisClient = RedisClient;
BunObject.S3Client = S3Client;
BunObject.SHA1 = SHA1;
BunObject.SHA224 = SHA224;
BunObject.SHA256 = SHA256;
BunObject.SHA384 = SHA384;
BunObject.SHA512 = SHA512;
BunObject.SHA512_256 = SHA512_256;
BunObject.SQL = SQL;
BunObject.TOML = TOML;
BunObject.Terminal = Terminal;
BunObject.Transpiler = Transpiler;
BunObject.YAML = YAML;
BunObject.allocUnsafe = allocUnsafe;
BunObject.build = build;
BunObject.color = color;
BunObject.concatArrayBuffers = concatArrayBuffers;
BunObject.connect = connect;
BunObject.cwd = cwd;
BunObject.deepEquals = deepEquals;
BunObject.deepMatch = deepMatch;
BunObject.deflateSync = deflateSync;
BunObject.dns = dns;
BunObject.embeddedFiles = embeddedFiles;
BunObject.enableANSIColors = enableANSIColors;
BunObject.escapeHTML = escapeHTML;
BunObject.file = file;
BunObject.fileURLToPath = fileURLToPath;
BunObject.gc = gc;
BunObject.generateHeapSnapshot = generateHeapSnapshot;
BunObject.gunzipSync = gunzipSync;
BunObject.gzipSync = gzipSync;
BunObject.hash = hash;
BunObject.indexOfLine = indexOfLine;
BunObject.inflateSync = inflateSync;
BunObject.inspect = inspect;
BunObject.isMainThread = isMainThread;
BunObject.jest = jest;
BunObject.listen = listen;
BunObject.main = main;
BunObject.markdown = markdown;
BunObject.mmap = mmap;
BunObject.nanoseconds = nanoseconds;
BunObject.openInEditor = openInEditor;
BunObject.origin = origin;
BunObject.password = password;
BunObject.pathToFileURL = pathToFileURL;
BunObject.peek = peek;
BunObject.plugin = plugin;
BunObject.postgres = postgres;
BunObject.randomUUIDv5 = randomUUIDv5;
BunObject.randomUUIDv7 = randomUUIDv7;
BunObject.readableStreamToArray = readableStreamToArray;
BunObject.readableStreamToArrayBuffer = readableStreamToArrayBuffer;
BunObject.readableStreamToBlob = readableStreamToBlob;
BunObject.readableStreamToBytes = readableStreamToBytes;
BunObject.readableStreamToFormData = readableStreamToFormData;
BunObject.readableStreamToJSON = readableStreamToJSON;
BunObject.readableStreamToText = readableStreamToText;
BunObject.redis = redis;
BunObject.registerMacro = registerMacro;
BunObject.resolve = resolve;
BunObject.resolveSync = resolveSync;
BunObject.revision = revision;
BunObject.s3 = s3;
BunObject.secrets = secrets;
BunObject.semver = semver;
BunObject.write = write;
BunObject.which = which;
BunObject.sha = sha;
BunObject.shrink = shrink;
BunObject.sleep = sleep;
BunObject.sleepSync = sleepSync;
BunObject.sql = sql;
BunObject.stderr = stderr;
BunObject.stdin = stdin;
BunObject.stdout = stdout;
BunObject.stringWidth = stringWidth;
BunObject.stripANSI = stripANSI;
BunObject.spawn = spawn;
BunObject.spawnSync = spawnSync;
BunObject.serve = serve;
BunObject.fetch = fetch;
BunObject.Archive = Archive;
BunObject.udpSocket = udpSocket;
BunObject.unsafe = unsafe;
BunObject.version = version;
BunObject.version_with_sha = version_with_sha;
BunObject.wrapAnsi = wrapAnsi;
BunObject.zstdCompress = zstdCompress;
BunObject.zstdCompressSync = zstdCompressSync;
BunObject.zstdDecompress = zstdDecompress;
BunObject.zstdDecompressSync = zstdDecompressSync;
const CryptoObject = globalThis.crypto ?? {};
CryptoObject.randomUUID ??= randomUUID;
CryptoObject.getRandomValues ??= getRandomValues;
globalThis.crypto = CryptoObject;
globalThis.DOMException ??= CottontailDOMException;
globalThis.Event ??= CottontailEvent;
globalThis.EventTarget ??= CottontailEventTarget;
globalThis.AbortSignal ??= CottontailAbortSignal;
globalThis.AbortController ??= CottontailAbortController;
globalThis.structuredClone ??= cottontailStructuredClone;
globalThis.fetch ??= fetch;
globalThis.Bun = BunObject;
globalThis.Headers ??= Headers;
globalThis.Request ??= Request;
globalThis.Response ??= Response;
globalThis.URL ??= URL;

const argv = BunObject.argv;
const env = BunObject.env;

export { BunObject as Bun, argv, env, which };
export default BunObject;
