import "./ffi.js";
import { randomBytes, randomUUID } from "../node/crypto.js";

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
  const tmp = pathJoin(cottontail.cwd(), ".cottontail-tmp", "bun-build");
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
    stdin,
    stdout,
    stderr,
    input: input != null && input !== "pipe" && input !== "inherit" && input !== "ignore" ? input : undefined,
  };
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
  const nativeOptions = normalizeSpawnOptions(options, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const inherited = nativeOptions.stdin === "inherit" || nativeOptions.stdout === "inherit" || nativeOptions.stderr === "inherit";
  const result = cottontail.spawnSync(file, args, {
    cwd: nativeOptions.cwd,
    env: nativeOptions.env,
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
    let used = false;
    return {
      read: async () => {
        if (used) return { done: true, value: undefined };
        used = true;
        return { done: false, value: await this.bytes() };
      },
      releaseLock() {},
      cancel() {
        used = true;
        return Promise.resolve();
      },
    };
  }
  async *[Symbol.asyncIterator]() {
    yield await this.bytes();
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
  const nativeOptions = normalizeSpawnOptions(options, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
      throw new Error("Bun.spawn IPC is not implemented");
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
    this._body = bytesFromData(init.body ?? input?._body);
    this.params = init.params ?? input?.params ?? {};
  }
  async arrayBuffer() {
    return arrayBufferFromBytes(this._body);
  }
  async text() {
    return new TextDecoder().decode(this._body);
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
    this._body = bytesFromData(body);
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
    return arrayBufferFromBytes(this._body);
  }
  async text() {
    return new TextDecoder().decode(this._body);
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
    if (response instanceof Response) return arrayBufferFromBytes(response._body);
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
    const tmpRoot = pathJoin(cottontail.cwd(), ".cottontail-tmp", "archive");
    cottontail.mkdirSync(tmpRoot, true);
    const tarPath = pathJoin(tmpRoot, `archive-${Date.now()}-${Math.floor(Math.random() * 1000000)}.tar`);
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

const BunObject = globalThis.Bun ?? {};
BunObject.argv = cottontail.argv || ["cottontail", ...(cottontail.args || [])];
BunObject.env = globalThis.process?.env ?? cottontail.env();
BunObject.build = build;
BunObject.file = file;
BunObject.write = write;
BunObject.which = which;
BunObject.spawn = spawn;
BunObject.spawnSync = spawnSync;
BunObject.serve = serve;
BunObject.fetch = fetch;
BunObject.Archive = Archive;
const CryptoObject = globalThis.crypto ?? {};
CryptoObject.randomUUID ??= randomUUID;
CryptoObject.getRandomValues ??= getRandomValues;
globalThis.crypto = CryptoObject;
globalThis.fetch ??= fetch;
globalThis.Bun = BunObject;
globalThis.Headers ??= Headers;
globalThis.Request ??= Request;
globalThis.Response ??= Response;
globalThis.URL ??= URL;

export { BunObject as Bun };
export default BunObject;
