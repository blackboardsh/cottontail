import * as FFI from "./ffi.js";
import * as nodeDns from "../node/dns.js";
import * as nodeHttp from "../node/http.js";
import * as nodeNet from "../node/net.js";
import * as zlib from "../node/zlib.js";
import { CryptoKey, createHash, createHmac, randomBytes, randomUUID, webcrypto as nodeWebcrypto } from "../node/crypto.js";
import { __setBuiltinModules as nodeSetBuiltinModules, createRequire as nodeCreateRequire } from "../node/module.js";
import { resolve as nodePathResolve } from "../node/path.js";
import * as streamWeb from "../node/stream/web.js";
import { fileURLToPath as nodeFileURLToPath, pathToFileURL as nodePathToFileURL } from "../node/url.js";
import { inspect as nodeInspect, isDeepStrictEqual, stripVTControlCharacters } from "../node/util.js";
import { Database as SQLiteDatabase } from "./sqlite.js";
import { parse as parseJSON5, stringify as stringifyJSON5 } from "./json5.js";
import { parse as parseTOML, stringify as stringifyTOML } from "./toml.js";
import { parse as parseYAML, stringify as stringifyYAML } from "./yaml.js";
import picomatch from "../vendor/picomatch.js";
import { remapPosition as remapBundlePosition, remapStackString as remapBundleStack } from "../vendor/sourcemap.js";
import { URL, URLSearchParams } from "../vendor/whatwg-url.js";
import * as bunTestModule from "./test.js";
import { jest as bunJest } from "./test.js";

if (typeof globalThis.Performance !== "function") {
  globalThis.Performance = class Performance {};
  if (globalThis.performance && typeof globalThis.performance === "object") {
    Object.setPrototypeOf(globalThis.performance, globalThis.Performance.prototype);
  }
}

const nativeCaptureStackTrace = Error.captureStackTrace;
if (typeof nativeCaptureStackTrace === "function" && !Error.captureStackTrace.__cottontailStructuredCallSites) {
  class CottontailCallSite {
    constructor(frame) {
      this.functionName = frame.functionName || null;
      this.fileName = frame.fileName || null;
      this.lineNumber = frame.lineNumber || null;
      this.columnNumber = frame.columnNumber || null;
    }
    getThis() { return undefined; }
    getTypeName() { return null; }
    getFunction() { return undefined; }
    getFunctionName() { return this.functionName; }
    getMethodName() { return this.functionName; }
    getFileName() { return this.fileName; }
    getLineNumber() { return this.lineNumber; }
    getColumnNumber() { return this.columnNumber; }
    getEvalOrigin() { return undefined; }
    isToplevel() { return true; }
    isEval() { return false; }
    isNative() { return false; }
    isConstructor() { return false; }
    isAsync() { return false; }
    isPromiseAll() { return false; }
    getPromiseIndex() { return null; }
    toString() {
      const location = this.fileName
        ? `${this.fileName}${this.lineNumber == null ? "" : `:${this.lineNumber}${this.columnNumber == null ? "" : `:${this.columnNumber}`}`}`
        : "<anonymous>";
      return this.functionName ? `${this.functionName} (${location})` : location;
    }
  }

  const parseCallSites = (stack) => String(stack ?? "").split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^(.*?)@(.+):(\d+):(\d+)$/);
    if (!match) {
      const locationOnly = line.match(/^(.*?)@(.+)$/);
      return new CottontailCallSite(locationOnly
        ? { functionName: locationOnly[1] || null, fileName: locationOnly[2] }
        : { functionName: line });
    }
    return new CottontailCallSite({
      functionName: match[1] || null,
      fileName: match[2] || null,
      lineNumber: match[3] == null ? null : Number(match[3]),
      columnNumber: match[4] == null ? null : Number(match[4]),
    });
  });

  const captureStackTrace = function(target, constructorOpt = undefined) {
    const prepare = Error.prepareStackTrace;
    Error.prepareStackTrace = undefined;
    try {
      nativeCaptureStackTrace(target, constructorOpt);
      const rawStack = remapBundleStack(target.stack);
      const callSites = parseCallSites(rawStack);
      if (typeof prepare === "function") {
        target.stack = prepare(target, callSites);
      } else {
        const name = String(target.name || target.constructor?.name || "Error");
        const message = target.message == null || target.message === "" ? "" : `: ${String(target.message)}`;
        const frames = callSites.map((site) => `    at ${site.toString()}`).join("\n");
        target.stack = `${name}${message}${frames ? `\n${frames}` : ""}`;
      }
    } finally {
      Error.prepareStackTrace = prepare;
    }
  };
  Object.defineProperty(captureStackTrace, "__cottontailStructuredCallSites", { value: true });
  Error.captureStackTrace = captureStackTrace;
}

function installNodeStyleErrorConstructor(name) {
  const NativeError = globalThis[name];
  if (typeof NativeError !== "function" || NativeError.__cottontailStackHeader) return;
  const CottontailError = function(...args) {
    const error = Reflect.construct(NativeError, args, new.target || CottontailError);
    if (typeof error.stack === "string") {
      let stack = remapBundleStack(error.stack);
      if (!stack.includes(String(error.message ?? ""))) {
        const message = error.message == null || error.message === "" ? "" : `: ${String(error.message)}`;
        stack = `${error.name || name}${message}\n${stack}`;
      }
      if (stack !== error.stack) error.stack = stack;
    }
    return error;
  };
  Object.defineProperty(CottontailError, "name", { value: name });
  Object.defineProperty(CottontailError, "__cottontailStackHeader", { value: true });
  Object.setPrototypeOf(CottontailError, NativeError);
  CottontailError.prototype = NativeError.prototype;
  globalThis[name] = CottontailError;
}

for (const errorName of ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError"]) {
  installNodeStyleErrorConstructor(errorName);
}

// Shared hooks so other runtime modules (uncaught-error printing, test
// reporters) can remap bundle stack positions without importing this module.
globalThis.__cottontailRemapStackString ??= remapBundleStack;
globalThis.__cottontailRemapPosition ??= remapBundlePosition;

if (typeof JSON.parse === "function" && !JSON.parse.__cottontailStackHeader) {
  const nativeJSONParse = JSON.parse;
  const parse = function(text, reviver = undefined) {
    try {
      return nativeJSONParse(text, reviver);
    } catch (error) {
      if (error && typeof error.stack === "string") {
        let stack = remapBundleStack(error.stack);
        if (error.message && !stack.includes(String(error.message))) {
          stack = `${error.name || "SyntaxError"}: ${error.message}\n${stack}`;
        }
        if (stack !== error.stack) error.stack = stack;
      }
      throw error;
    }
  };
  Object.defineProperty(parse, "__cottontailStackHeader", { value: true });
  JSON.parse = parse;
}

if (Symbol.dispose == null) {
  Object.defineProperty(Symbol, "dispose", {
    value: Symbol.for("Symbol.dispose"),
    configurable: true,
  });
}

if (Symbol.asyncDispose == null) {
  Object.defineProperty(Symbol, "asyncDispose", {
    value: Symbol.for("Symbol.asyncDispose"),
    configurable: true,
  });
}

function shellEscape(value) {
  if (value && typeof value === "object" && "raw" in value) value = value.raw;
  if (isBunFileLike(value) && value.name != null) value = value.name;
  const text = String(value);
  validateNoNullByte(text, "shell argument");
  if (/^[A-Za-z0-9_/:.,=+@%-]+$/.test(text)) return text;
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function invalidNullByteError(name, value) {
  const error = new TypeError(`The argument '${name}' must be a string without null bytes. Received ${JSON.stringify(String(value))}`);
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

function validateNoNullByte(value, name) {
  if (String(value).includes("\0")) throw invalidNullByteError(name, value);
}

function validateSpawnInput(file, args = [], options = {}) {
  validateNoNullByte(file, "args[0]");
  for (let index = 0; index < args.length; index += 1) validateNoNullByte(args[index], `args[${index + 1}]`);
  if (options.env && typeof options.env === "object") {
    for (const [key, value] of Object.entries(options.env)) {
      validateNoNullByte(key, `env.${key}`);
      validateNoNullByte(value, `env.${key}`);
    }
  }
}

if (globalThis.console) {
  const nativeConsoleTable = typeof globalThis.console.table === "function" ? globalThis.console.table.bind(globalThis.console) : null;
  const renderConsoleTable = (value, properties = undefined) => {
    if (properties !== undefined && !Array.isArray(properties)) {
      throw new TypeError("console.table properties must be an array");
    }
    if (Array.isArray(value) && value.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      const keys = properties?.length ? properties.map(String) : [...new Set(value.flatMap((item) => Object.keys(item)))];
      const rows = value.map((item, index) => [String(index), ...keys.map((key) => String(item[key] ?? ""))]);
      const headers = ["", ...keys];
      const widths = headers.map((header, index) => Math.max(String(header).length, ...rows.map((row) => row[index].length)));
      const border = (left, mid, right) => `${left}${widths.map((width) => "─".repeat(width + 2)).join(mid)}${right}`;
      const rowLine = (row) => `│${row.map((cell, index) => ` ${String(cell).padEnd(widths[index])} `).join("│")}│`;
      globalThis.console.log([
        border("┌", "┬", "┐"),
        rowLine(headers),
        border("├", "┼", "┤"),
        ...rows.map(rowLine),
        border("└", "┴", "┘"),
      ].join("\n"));
      return;
    }
    if (nativeConsoleTable) return nativeConsoleTable(value, properties);
    globalThis.console.log(nodeInspect(value, { colors: false }));
  };
  globalThis.console.table = renderConsoleTable;
}

if (globalThis.console) {
  const consoleTimers = globalThis.console.__cottontailTimers ??= new Map();
  globalThis.console.time ??= (label = "default") => {
    consoleTimers.set(String(label), performance?.now?.() ?? Date.now());
  };
  globalThis.console.timeLog ??= (label = "default", ...args) => {
    const key = String(label);
    const started = consoleTimers.get(key) ?? (performance?.now?.() ?? Date.now());
    globalThis.console.log(`${key}: ${((performance?.now?.() ?? Date.now()) - started).toFixed(3)}ms`, ...args);
  };
  globalThis.console.timeEnd ??= (label = "default") => {
    const key = String(label);
    const started = consoleTimers.get(key) ?? (performance?.now?.() ?? Date.now());
    globalThis.console.log(`${key}: ${((performance?.now?.() ?? Date.now()) - started).toFixed(3)}ms`);
    consoleTimers.delete(key);
  };
  globalThis.console.trace ??= (...args) => {
    const label = args.length > 0 ? `Trace: ${args.map((arg) => typeof arg === "string" ? arg : nodeInspect(arg, { colors: false })).join(" ")}` : "Trace";
    const stack = new Error(label).stack;
    globalThis.console.error(stack || label);
  };
}

const promisePeekStates = globalThis.__cottontailPromisePeekStates ??= new WeakMap();

if (typeof Promise === "function" && !Promise.__cottontailPatchedPeek) {
  const originalResolve = Promise.resolve.bind(Promise);
  const originalReject = Promise.reject.bind(Promise);
  Promise.resolve = function(value) {
    const promise = originalResolve(value);
    promisePeekStates.set(promise, { status: "fulfilled", value });
    return promise;
  };
  Promise.reject = function(reason) {
    const promise = originalReject(reason);
    promisePeekStates.set(promise, { status: "rejected", value: reason });
    return promise;
  };
  Promise.__cottontailPatchedPeek = true;
}

if (typeof Promise === "function") {
  for (const name of ["all", "allSettled", "any", "race", "reject", "resolve", "withResolvers"]) {
    if (typeof Promise[name] !== "function") continue;
    Object.defineProperty(Promise, name, {
      value: Promise[name],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

function handledRejectedPromise(reason) {
  const promise = Promise.reject(reason);
  promise.catch(() => {});
  return promise;
}

if (!Object.__cottontailGlobalPrototypePatched) {
  const originalGetPrototypeOf = Object.getPrototypeOf;
  const originalSetPrototypeOf = Object.setPrototypeOf;
  let globalPrototype = originalGetPrototypeOf(globalThis);
  const globalPrototypeKeys = new Set();

  function clearMaterializedGlobalPrototype() {
    for (const key of globalPrototypeKeys) {
      try {
        delete globalThis[key];
      } catch {}
    }
    globalPrototypeKeys.clear();
  }

  function materializeGlobalPrototype(proto) {
    for (let cursor = proto; cursor; cursor = originalGetPrototypeOf(cursor)) {
      for (const key of Reflect.ownKeys(cursor)) {
        if (key in globalThis) continue;
        const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
        if (!descriptor) continue;
        try {
          Object.defineProperty(globalThis, key, { ...descriptor, configurable: true });
          globalPrototypeKeys.add(key);
        } catch {}
      }
    }
  }

  Object.getPrototypeOf = function getPrototypeOf(target) {
    if (target === globalThis) return globalPrototype;
    return originalGetPrototypeOf(target);
  };

  Object.setPrototypeOf = function setPrototypeOf(target, proto) {
    if (target === globalThis) {
      clearMaterializedGlobalPrototype();
      globalPrototype = proto;
      materializeGlobalPrototype(proto);
      return target;
    }
    return originalSetPrototypeOf(target, proto);
  };

  Object.defineProperty(Object, "__cottontailGlobalPrototypePatched", { value: true });
}

const internalPromiseThen = Promise.prototype.then;

function internalThen(promise, onFulfilled, onRejected) {
  return internalPromiseThen.call(promise, onFulfilled, onRejected);
}

function newInternalPromise(executor) {
  return new Promise(executor);
}

function suppressUserPromiseThenForInternalAwait() {
  const userThen = Promise.prototype.then;
  if (userThen === internalPromiseThen || userThen?.__cottontailInternalPromiseThen === true) return;
  function cottontailInternalPromiseThen(onFulfilled, onRejected) {
    return internalPromiseThen.call(this, onFulfilled, onRejected);
  }
  Object.defineProperty(cottontailInternalPromiseThen, "__cottontailInternalPromiseThen", { value: true });
  Promise.prototype.then = cottontailInternalPromiseThen;
  setTimeout(() => {
    if (Promise.prototype.then === cottontailInternalPromiseThen) Promise.prototype.then = userThen;
  }, 0);
}

for (const name of [
  "ReadableStream",
  "ReadableStreamBYOBReader",
  "ReadableStreamBYOBRequest",
  "ReadableStreamDefaultController",
  "ReadableStreamDefaultReader",
  "ReadableByteStreamController",
  "TransformStream",
  "TransformStreamDefaultController",
  "WritableStream",
  "WritableStreamDefaultController",
  "WritableStreamDefaultWriter",
  "ByteLengthQueuingStrategy",
  "CountQueuingStrategy",
  "CompressionStream",
  "DecompressionStream",
  "TextEncoderStream",
  "TextDecoderStream",
]) {
  if (typeof globalThis[name] !== "function" && typeof streamWeb[name] === "function") {
    globalThis[name] = streamWeb[name];
  }
}
installReadableStreamConversionHelpers();

function consoleInputState() {
  const state = globalThis.console.__cottontailInput ??= {
    buffer: "",
    ended: false,
    error: null,
    started: false,
    waiters: [],
  };
  if (!state.started) {
    state.started = true;
    const stdin = globalThis.process?.stdin;
    stdin?.setEncoding?.("utf8");
    const wake = () => {
      for (const waiter of state.waiters.splice(0)) waiter();
    };
    stdin?.on?.("data", (chunk) => {
      state.buffer += String(chunk);
      wake();
    });
    stdin?.on?.("end", () => {
      state.ended = true;
      wake();
    });
    stdin?.on?.("error", (error) => {
      state.error = error;
      state.ended = true;
      wake();
    });
    stdin?.resume?.();
  }
  return state;
}

async function consoleReadLine() {
  const state = consoleInputState();
  for (;;) {
    if (state.error) throw state.error;
    const newline = state.buffer.indexOf("\n");
    if (newline >= 0) {
      let line = state.buffer.slice(0, newline);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      state.buffer = state.buffer.slice(newline + 1);
      return { value: line, done: false };
    }
    if (state.ended) {
      if (state.buffer.length > 0) {
        const value = state.buffer;
        state.buffer = "";
        return { value, done: false };
      }
      return { value: undefined, done: true };
    }
    await new Promise((resolve) => state.waiters.push(resolve));
  }
}

if (globalThis.console && typeof globalThis.console.write !== "function") {
  globalThis.console.write = (chunk = "") => {
    globalThis.process?.stdout?.write?.(String(chunk));
  };
}

if (globalThis.console && typeof globalThis.console[Symbol.asyncIterator] !== "function") {
  globalThis.console[Symbol.asyncIterator] = async function* consoleAsyncIterator() {
    for (;;) {
      const next = await consoleReadLine();
      if (next.done) return;
      yield next.value;
    }
  };
}

function interpolate(strings, values) {
  let out = "";
  const parts = Array.isArray(strings?.raw) ? strings.raw : strings;
  for (let index = 0; index < strings.length; index += 1) {
    out += parts[index];
    if (index < values.length) {
      const value = values[index];
      out += Array.isArray(value) ? value.map(shellEscape).join(" ") : shellEscape(value);
    }
  }
  return out;
}

function binaryOutputView(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function interpolateShellCommand(strings, values) {
  const parts = Array.isArray(strings?.raw) ? strings.raw : strings;
  let out = "";
  let outputBuffer = undefined;
  let inputBody = undefined;
  for (let index = 0; index < strings.length; index += 1) {
    let part = parts[index];
    if (index < values.length && binaryOutputView(values[index]) && />\s*$/.test(part) && parts.slice(index + 1).every((item) => String(item).trim() === "")) {
      part = part.replace(/>\s*$/, "");
      out += part;
      outputBuffer = values[index];
      continue;
    }
    if (index < values.length && values[index] != null && typeof values[index] === "object" &&
        /<\s*$/.test(part) && parts.slice(index + 1).every((item) => String(item).trim() === "")) {
      part = part.replace(/<\s*$/, "");
      out += part;
      inputBody = values[index];
      continue;
    }
    out += part;
    if (index < values.length) {
      const value = values[index];
      out += Array.isArray(value) ? value.map(shellEscape).join(" ") : shellEscape(value);
    }
  }
  return { command: out.trimEnd(), outputBuffer, inputBody };
}

const shellDefaults = {
  cwd: undefined,
  env: undefined,
  throws: true,
  quiet: false,
};

export class ShellOutput {
  constructor(result = {}) {
    this.stdout = asBuffer(result.stdout ?? "");
    this.stderr = asBuffer(result.stderr ?? "");
    this.exitCode = Number(result.exitCode ?? result.status ?? 0);
    this.status = this.exitCode;
    this.success = this.exitCode === 0;
  }
  text(encoding = "utf-8") {
    return this.stdout.toString(encoding);
  }
  json() {
    return JSON.parse(this.text());
  }
  bytes() {
    return asBuffer(this.stdout);
  }
  arrayBuffer() {
    const bytes = this.bytes();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  blob() {
    let bytes = this.bytes();
    if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 10) bytes = bytes.subarray(0, bytes.byteLength - 1);
    return new Blob([bytes]);
  }
}

export class ShellError extends Error {
  constructor(command = "", result = {}) {
    super(`Shell command failed${command ? `: ${command}` : ""}`);
    const output = result instanceof ShellOutput ? result : new ShellOutput(result);
    this.name = "ShellError";
    this.command = command;
    this.exitCode = output.exitCode || 1;
    this.status = this.exitCode;
    this.stdout = output.stdout;
    this.stderr = output.stderr;
  }
  text(encoding = "utf-8") {
    return this.stdout.toString(encoding);
  }
  json() {
    return JSON.parse(this.text());
  }
  bytes() {
    return asBuffer(this.stdout);
  }
  arrayBuffer() {
    const bytes = this.bytes();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  blob() {
    let bytes = this.bytes();
    if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 10) bytes = bytes.subarray(0, bytes.byteLength - 1);
    return new Blob([bytes]);
  }
}

export class ShellExpression {}

function shellEnv(options) {
  if (options.env == null) return undefined;
  return { ...currentProcessEnv(), ...options.env };
}

function splitShellWords(command) {
  const words = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of String(command)) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && !quote) {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (current) words.push(current);
  return words;
}

function shellBasename(path) {
  let text = String(path);
  if (/^[\\/]+$/.test(text)) return "/";
  text = text.replace(/[\\/]+$/g, "");
  const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return index >= 0 ? text.slice(index + 1) : text;
}

function shellPath(path, cwd = undefined) {
  const text = String(path);
  if (/^(?:[A-Za-z]:)?[\\/]/.test(text)) return text;
  return cwd ? pathJoin(String(cwd), text) : text;
}

function shellStat(path, cwd = undefined) {
  try {
    return cottontail.statSync(shellPath(path, cwd), true);
  } catch {
    return null;
  }
}

function runShellMv(words, options = {}) {
  if (words.length < 3) return { exitCode: 1, stdout: "", stderr: "mv: missing file operand\n" };
  const cwd = options.cwd;
  const sources = words.slice(1, -1);
  const destination = words[words.length - 1];
  const destinationStat = shellStat(destination, cwd);
  const destinationMustBeDirectory = sources.length > 1 || /[\\/]$/.test(destination);
  if (destinationMustBeDirectory && !destinationStat?.isDirectory) {
    const reason = destinationStat ? "Not a directory" : "No such file or directory";
    return { exitCode: destinationStat ? 20 : 1, stdout: "", stderr: `mv: ${destination}: ${reason}\n` };
  }

  for (const source of sources) {
    const sourceStat = shellStat(source, cwd);
    if (!sourceStat) return { exitCode: 1, stdout: "", stderr: `mv: ${source}: No such file or directory\n` };
    if (sourceStat.isDirectory && destinationStat && !destinationStat.isDirectory) {
      return { exitCode: 20, stdout: "", stderr: `mv: ${destination}: Not a directory\n` };
    }
    const target = destinationStat?.isDirectory ? pathJoin(destination, shellBasename(source)) : destination;
    try {
      cottontail.renameSync(shellPath(source, cwd), shellPath(target, cwd));
    } catch (error) {
      const message = String(error?.message || error || "rename failed");
      const notDir = message.includes("Not a directory") || message.includes("ENOTDIR");
      return { exitCode: notDir ? 20 : 1, stdout: "", stderr: `mv: ${target}: ${notDir ? "Not a directory" : message}\n` };
    }
  }
  return { exitCode: 0, stdout: "", stderr: "" };
}

function normalizeShellStderr(command, stderr) {
  let text = String(stderr ?? "");
  if (String(command).includes("mv ")) {
    text = text.replace(/^mv: rename .*? to ([^:]+): Not a directory$/gm, "mv: $1: Not a directory");
    text = text.replace(/^mv: ([^:]+) is not a directory$/gm, "mv: $1: No such file or directory");
  }
  if (/\bbasename\s*(?:[|;&]|$)/.test(String(command))) {
    text = text.replace(
      /^usage: basename string \[suffix\]\n\s*basename \[-a\] \[-s suffix\] string \[\.\.\.\]\n$/,
      "usage: basename string\n",
    );
  }
  return text;
}

function assignmentOnlyPipelineStage(value) {
  const assignment = String(value).trim();
  if (!assignment) return false;
  return /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|\\.|[^\s|])*(?:\s+|$))+$/.test(assignment);
}

function normalizeAssignmentPipelines(command) {
  const source = String(command);
  const parts = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let parentheses = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") parentheses += 1;
    else if (char === ")" && parentheses > 0) parentheses -= 1;
    else if (char === "|" && parentheses === 0 && source[index - 1] !== "|" && source[index + 1] !== "|") {
      parts.push(source.slice(start, index), "|");
      start = index + 1;
    }
  }
  if (parts.length === 0) return source;
  parts.push(source.slice(start));
  for (let index = 0; index < parts.length; index += 2) {
    if (assignmentOnlyPipelineStage(parts[index])) parts[index] = `${parts[index].trimEnd()} cat `;
  }
  return parts.join("");
}

function writeOutputBuffer(buffer, data) {
  const view = binaryOutputView(buffer);
  if (!view) return;
  const bytes = asBuffer(data);
  view.set(bytes.subarray(0, view.byteLength));
}

function fillOutputBuffer(buffer, pattern) {
  const view = binaryOutputView(buffer);
  if (!view) return;
  const bytes = asBuffer(pattern);
  if (bytes.byteLength === 0) return;
  for (let offset = 0; offset < view.byteLength; offset += bytes.byteLength) {
    view.set(bytes.subarray(0, Math.min(bytes.byteLength, view.byteLength - offset)), offset);
  }
}

function runShellBuiltin(command, options = {}) {
  if (/[|&;<>()$`>]/.test(String(command))) return null;
  const words = splitShellWords(command);
  if (words[0] === "yes" && options.outputBuffer != null) {
    const text = words.length > 1 ? words.slice(1).join(" ") : "y";
    fillOutputBuffer(options.outputBuffer, `${text}\n`);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  if (words[0] === "echo") {
    let index = 1;
    let newline = true;
    while (words[index] === "-n") {
      newline = false;
      index += 1;
    }
    return {
      exitCode: 0,
      stdout: `${words.slice(index).join(" ")}${newline ? "\n" : ""}`,
      stderr: "",
    };
  }
  if (words[0] === "basename") {
    if (words.length === 1) return { exitCode: 1, stdout: "", stderr: "usage: basename string\n" };
    return {
      exitCode: 0,
      stdout: `${words.slice(1).map(shellBasename).join("\n")}\n`,
      stderr: "",
    };
  }
  if (words[0] === "seq") {
    const invalid = words.slice(1).find((word) => word !== "--" && /^(?:[+-]?(?:inf(?:inity)?|nan))$/i.test(word));
    if (invalid) return { exitCode: 1, stdout: "", stderr: `seq: invalid argument '${invalid}'\n` };
  }
  if (words[0] === "mv") return runShellMv(words, options);
  return null;
}

function runShell(command, options = {}) {
  validateNoNullByte(command, "command");
  command = normalizeAssignmentPipelines(command);
  const builtin = runShellBuiltin(command, options);
  if (builtin) {
    const output = new ShellOutput(builtin);
    if (output.exitCode !== 0 && options.throws !== false) throw new ShellError(command, output);
    return output;
  }
  const isWin = cottontail.platform() === "win32";
  const shellExecutable = isWin ? "cmd" : cottontail.platform() === "darwin" ? "/bin/bash" : "sh";
  const shellArgs = isWin
    ? ["/d", "/s", "/c", command]
    : ["-c", command, ...(globalThis.process?.argv ?? [])];
  const result = cottontail.spawnSync(shellExecutable, shellArgs, {
    stdio: "pipe",
    cwd: options.cwd,
    env: shellEnv(options),
    input: options.input,
  });
  if (options.outputBuffer != null) writeOutputBuffer(options.outputBuffer, result.stdout ?? "");
  const stderr = normalizeShellStderr(command, result.stderr || "");
  const exitCode = String(command).includes("mv ") && stderr.includes("Not a directory") ? 20 : result.status;
  const output = new ShellOutput({
    exitCode,
    stdout: options.outputBuffer != null ? "" : result.stdout || "",
    stderr,
  });
  if (output.exitCode !== 0 && options.throws !== false) {
    throw new ShellError(command, output);
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

class ShellCommand extends ShellExpression {
  constructor(command, options = {}) {
    super();
    this.command = command;
    this.options = { ...shellDefaults, ...options };
    this.promise = null;
  }
  quiet(_value = true) {
    this.options.quiet = Boolean(_value);
    return this;
  }
  throws(value = true) {
    this.options.throws = Boolean(value);
    this.promise = null;
    return this;
  }
  nothrow() {
    return this.throws(false);
  }
  cwd(value) {
    this.options.cwd = String(value);
    this.promise = null;
    return this;
  }
  env(value) {
    this.options.env = { ...(value ?? {}) };
    this.promise = null;
    return this;
  }
  run() {
    if (!this.promise) {
      this.promise = Promise.resolve().then(async () => {
        if (this.options.inputBody !== undefined) {
          this.options.input = await bytesFromBody(this.options.inputBody);
        }
        const result = runShell(this.command, this.options);
        if (!this.options.quiet) {
          if (result.stdout.byteLength > 0) globalThis.process?.stdout?.write?.(result.stdout);
          if (result.stderr.byteLength > 0) globalThis.process?.stderr?.write?.(result.stderr);
        }
        return result;
      });
    }
    return this.promise;
  }
  text() {
    this.options.quiet = true;
    return this.run().then((result) => result.text());
  }
  json() {
    this.options.quiet = true;
    return this.run().then((result) => result.json());
  }
  lines() {
    this.options.quiet = true;
    const command = this;
    return (async function* iterateLines() {
      for (const line of (await command.text()).split("\n")) yield line;
    })();
  }
  bytes() {
    this.options.quiet = true;
    return this.run().then((result) => new Uint8Array(result.bytes()));
  }
  arrayBuffer() {
    this.options.quiet = true;
    return this.run().then((result) => result.arrayBuffer());
  }
  blob() {
    this.options.quiet = true;
    return this.run().then((result) => new Blob([result.bytes()]));
  }
  then(resolve, reject) {
    return this.run().then(resolve, reject);
  }
  catch(reject) {
    return this.run().catch(reject);
  }
}

export function $(strings, ...values) {
  const interpolation = interpolateShellCommand(strings, values);
  return new ShellCommand(interpolation.command, {
    ...shellDefaults,
    outputBuffer: interpolation.outputBuffer,
    inputBody: interpolation.inputBody,
  });
}

function expandBraces(input, output, depth = 0) {
  if (depth > 64 || output.length >= 32768) throw new RangeError("Brace expansion is too large");
  let open = -1;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "{") {
      open = index;
      break;
    }
  }
  if (open < 0) {
    output.push(input);
    return;
  }

  let nesting = 0;
  let close = -1;
  escaped = false;
  for (let index = open; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "{") nesting += 1;
    if (char === "}" && --nesting === 0) {
      close = index;
      break;
    }
  }
  if (close < 0) {
    output.push(input);
    return;
  }

  const body = input.slice(open + 1, close);
  const variants = [];
  let start = 0;
  nesting = 0;
  escaped = false;
  for (let index = 0; index <= body.length; index += 1) {
    const char = body[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "{") nesting += 1;
    else if (char === "}") nesting -= 1;
    if (index === body.length || (char === "," && nesting === 0)) {
      variants.push(body.slice(start, index));
      start = index + 1;
    }
  }

  const prefix = input.slice(0, open);
  const suffix = input.slice(close + 1);
  for (const variant of variants) expandBraces(prefix + variant + suffix, output, depth + 1);
}

$.braces = (value) => {
  const output = [];
  expandBraces(String(value), output);
  return output;
};
$.ShellError = ShellError;
$.ShellExpression = ShellExpression;
$.ShellOutput = ShellOutput;
$.escape = shellEscape;
$.throws = (value = true) => {
  shellDefaults.throws = Boolean(value);
  return $;
};
$.nothrow = () => $.throws(false);
$.cwd = (value) => {
  shellDefaults.cwd = String(value);
  return $;
};
$.env = (value) => {
  shellDefaults.env = { ...(value ?? {}) };
  return $;
};

function pathJoin(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

function tmpRoot(kind) {
  const env = BunObject.env ?? cottontail.env();
  const base = String(env.COTTONTAIL_TMP_DIR || env.TMPDIR || env.TEMP || env.TMP || "/tmp");
  return pathJoin(base, "cottontail", kind);
}

function isExecutableFile(path) {
  try {
    const stat = cottontail.statSync(String(path), true);
    if (!stat?.isFile) return false;
    if (cottontail.platform() === "win32") return true;
    return (Number(stat.mode) & 0o111) !== 0;
  } catch {
    return false;
  }
}

function which(command, options = undefined) {
  const value = String(command || "");
  if (!value) return null;
  if (value.length > 4096) throw new Error("bin path is too long");
  if (value.includes("/") || value.includes("\\")) {
    const candidate = nodePathResolve(value);
    return isExecutableFile(candidate) ? candidate : null;
  }

  const env = BunObject.env ?? cottontail.env();
  const pathValue = String(options?.PATH ?? options?.Path ?? options?.path ?? env.PATH ?? env.Path ?? env.path ?? "");
  const extensions = cottontail.platform() === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const dir of pathValue.split(cottontail.platform() === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = pathJoin(dir, `${value}${ext}`);
      if (isExecutableFile(candidate)) {
        try { return cottontail.realpathSync(candidate); } catch { return candidate; }
      }
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
  for (const entrypoint of options?.entrypoints ?? []) {
    let source;
    try { source = cottontail.readFile(String(entrypoint)); } catch { continue; }
    const imports = new Transpiler().scanImports(source);
    for (const imported of imports) {
      const specifier = String(imported.path).split(/[?#]/, 1)[0];
      if (!specifier.startsWith(".") || !specifier.endsWith(".json")) continue;
      const basename = specifier.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
      if (basename === "tsconfig.json" || basename === "package.json") continue;
      if (/\btype\s*:\s*["']jsonc["']/.test(source)) continue;
      const target = pathJoin(pathDirname(String(entrypoint)), specifier);
      try {
        JSON.parse(cottontail.readFile(target));
      } catch (error) {
        const buildError = new SyntaxError(`Invalid JSON in ${target}: ${error?.message ?? error}`);
        if (options?.throw === false) return { success: false, logs: [buildError], outputs: [] };
        throw buildError;
      }
    }
  }
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
    if (command.cmd.length > 0xfffffffd) throw new TypeError("cmd array is too large");
    return [String(command.cmd[0]), command.cmd.slice(1).map(String), { ...command, cmd: undefined, ...(maybeArgs || {}) }];
  }
  if (Array.isArray(command)) {
    if (command.length === 0) throw new TypeError("Bun.spawn requires a non-empty command array");
    if (command.length > 0xfffffffd) throw new TypeError("cmd array is too large");
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
    killSignal: options.killSignal,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    ipc: typeof options.ipc === "function" || options.ipc === true,
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
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (globalThis.Buffer?.from) return globalThis.Buffer.from(value ?? "");
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
  if (signal == null || signal === "") return 15;
  if (typeof signal === "number") {
    if (Number.isNaN(signal)) return 15;
    if (!Number.isFinite(signal)) throw new TypeError("Invalid signal");
    return signal;
  }
  if (typeof signal !== "string") throw new TypeError("Invalid signal");
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
  if (signals[name] == null) throw new TypeError("Invalid signal");
  return signals[name];
}

export function spawnSync(command, maybeArgsOrOptions = {}, maybeOptions = undefined) {
  const [file, args, options] = normalizeCommand(command, maybeArgsOrOptions, maybeOptions);
  validateSpawnInput(file, args, options);
  const nativeOptions = prepareNativeSpawnOptions(file, normalizeSpawnOptions(options, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
  const captureOutput = nativeOptions.stdout !== "inherit" || nativeOptions.stderr !== "inherit";
  const result = cottontail.spawnSync(file, args, {
    cwd: nativeOptions.cwd,
    env: nativeOptions.env,
    clearEnv: nativeOptions.clearEnv,
    stdio: captureOutput ? "pipe" : "inherit",
    input: nativeOptions.input,
  });
  if (captureOutput && nativeOptions.stdout === "inherit" && result.stdout != null) {
    globalThis.process?.stdout?.write?.(result.stdout);
  }
  if (captureOutput && nativeOptions.stderr === "inherit" && result.stderr != null) {
    globalThis.process?.stderr?.write?.(result.stderr);
  }
  const exitCode = Number(result.status ?? result.exitCode ?? 0);
  const stdout = nativeOptions.stdout === "pipe" ? asBuffer(result.stdout ?? "") : asBuffer("");
  let stderr = nativeOptions.stderr === "pipe" ? asBuffer(result.stderr ?? "") : asBuffer("");
  if (exitCode !== 0 && isCurrentCottontailExecutable(file) && stderr.byteLength > 0) {
    stderr = augmentCottontailErrorSource(stderr, nativeOptions.cwd);
  }
  if (exitCode !== 0 && isCurrentCottontailExecutable(file) && args[0] === "test") {
    stderr = formatCottontailTestStderr(stderr);
  }
  return {
    stdout,
    stderr,
    exitCode,
    signalCode: null,
    success: exitCode === 0,
    status: exitCode,
  };
}

function augmentCottontailErrorSource(stderr, cwd = undefined) {
  const text = String(stderr ?? "");
  const framePattern = /^([^\n@]+\.(?:[cm]?[jt]sx?))@[^\n]+:\d+:\d+$/gm;
  const seen = new Set();
  const excerpts = [];
  let match;
  while ((match = framePattern.exec(text)) !== null) {
    const label = match[1];
    const path = nodePathResolve(String(cwd || cottontail.cwd()), label);
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      const source = cottontail.readFile(path);
      if (source && !text.includes(source)) excerpts.push(source.slice(0, 8192));
    } catch {}
  }
  return excerpts.length > 0 ? asBuffer(`${text}\n${excerpts.join("\n")}\n`) : stderr;
}

function formatCottontailTestStderr(stderr) {
  const text = String(stderr ?? "");
  if (text.includes("error: ")) return stderr;
  const exception = /^(?:Error|TypeError|ReferenceError|AssertionError): ([^\n]+)/.exec(text);
  const report = /\(fail\)[^\n]*\n\s*(?:\^\s*)?([^\n]+)/.exec(text);
  const message = exception?.[1] ?? report?.[1];
  return message ? asBuffer(`error: ${message}\n${text}`) : stderr;
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
  async blob() {
    return new Blob([await this.bytes()]);
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
        if (this._chunks.length > 0) {
          const chunks = this._chunks.splice(0);
          return { done: false, value: concatManyBuffers(chunks) };
        }
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
  flush() {
    return undefined;
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
  validateSpawnInput(file, args, options);
  const nativeOptions = prepareNativeSpawnOptions(file, normalizeSpawnOptions(options, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
  const listeners = new Map();
  let killed = false;
  let exitCode = null;
  let signalCode = null;
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutLength = 0;
  let stderrLength = 0;
  let unregisterSpawnListener = null;
  let timeoutTimer = null;
  let exceededMaxBuffer = false;
  let ipcBuffer = "";
  let resourceUsage = undefined;

  const child = {
    pid: 0,
    stdin: null,
    stdout: nativeOptions.stdout === "pipe" ? new ProcessReadable(() => child.exited.then(() => concatManyBuffers(stdoutChunks))) : null,
    stderr: nativeOptions.stderr === "pipe" ? new ProcessReadable(() => child.exited.then(() => concatManyBuffers(stderrChunks))) : null,
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
      return resourceUsage;
    },
    [Symbol.dispose]() {
      if (exitCode == null && !killed) child.kill();
    },
    async [Symbol.asyncDispose]() {
      if (exitCode == null && !killed) child.kill();
      try {
        await child.exited;
      } catch {}
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
  if (nativeOptions.input !== undefined) {
    const input = nativeOptions.input;
    const iterable = typeof input === "function" ? input() : input;
    const isStreaming = typeof input?.getReader === "function" || typeof iterable?.[Symbol.asyncIterator] === "function";
    const writeInput = async () => {
      try {
        if (isStreaming) {
          await consumeStreamingBody(input, (chunk) => {
            const bytes = asBuffer(chunk);
            if (bytes.byteLength > 0 && cottontail.spawnWrite?.(native.id, bytes) !== true) {
              throw new Error("Failed to write subprocess stdin");
            }
          });
        } else {
          const bytes = await bytesFromBody(input);
          if (bytes.byteLength > 0) cottontail.spawnWrite?.(native.id, bytes);
        }
        return null;
      } catch (error) {
        return error;
      }
    };
    void writeInput().then((error) => {
      cottontail.spawnCloseStdin?.(native.id);
      if (error != null && (listeners.get("error")?.length ?? 0) > 0) emit("error", error);
    });
  }

  const maxBuffer = nativeOptions.maxBuffer == null ? Infinity : Number(nativeOptions.maxBuffer);
  const killSignal = nativeOptions.killSignal ?? "SIGTERM";
  const enforceMaxBuffer = () => {
    if (exceededMaxBuffer || !Number.isFinite(maxBuffer) || maxBuffer < 0) return;
    if ((child.stdout && stdoutLength > maxBuffer) || (child.stderr && stderrLength > maxBuffer)) {
      exceededMaxBuffer = true;
      child.kill(killSignal);
    }
  };

  const timeout = nativeOptions.timeout == null ? 0 : Number(nativeOptions.timeout);
  if (Number.isFinite(timeout) && timeout > 0) {
    timeoutTimer = setTimeout(() => child.kill(killSignal), timeout);
  }

  child.exited = new Promise((resolve, reject) => {
    const complete = async (result) => {
      if (unregisterSpawnListener != null) {
        unregisterSpawnListener();
        unregisterSpawnListener = null;
      }
      if (timeoutTimer != null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      exitCode = result.exitCode == null ? null : Number(result.exitCode);
      signalCode = result.signalCode == null ? null : signalName(result.signalCode) ?? String(result.signalCode);
      killed = killed || result.killed === true;
      if (result.resourceUsage) {
        const user = BigInt(Math.max(0, Math.trunc(Number(result.resourceUsage.userCPUTime) || 0)));
        const system = BigInt(Math.max(0, Math.trunc(Number(result.resourceUsage.systemCPUTime) || 0)));
        resourceUsage = {
          maxRSS: Number(result.resourceUsage.maxRSS) || 0,
          shmSize: Number(result.resourceUsage.sharedMemorySize) || 0,
          swapCount: Number(result.resourceUsage.swappedOut) || 0,
          messages: {
            sent: Number(result.resourceUsage.ipcSent) || 0,
            received: Number(result.resourceUsage.ipcReceived) || 0,
          },
          signalCount: Number(result.resourceUsage.signalsCount) || 0,
          contextSwitches: {
            voluntary: Number(result.resourceUsage.voluntaryContextSwitches) || 0,
            involuntary: Number(result.resourceUsage.involuntaryContextSwitches) || 0,
          },
          cpuTime: { user, system, total: user + system },
          ops: {
            in: Number(result.resourceUsage.fsRead) || 0,
            out: Number(result.resourceUsage.fsWrite) || 0,
          },
        };
      }
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
        resolve(exitCode ?? (result.signalCode == null ? null : 128 + Number(result.signalCode)));
      } catch (error) {
        reject(error);
      }
    };

    unregisterSpawnListener = globalThis.__cottontailRegisterSpawnListener?.(native.id, (event) => {
      if (!event) return;
      if (event.type === "stdout") {
        const chunk = asBuffer(event.data ?? new ArrayBuffer(0));
        if (chunk.length > 0) {
          stdoutChunks.push(chunk);
          stdoutLength += chunk.byteLength;
          child.stdout?.emit("data", chunk);
          enforceMaxBuffer();
        }
        return;
      }
      if (event.type === "stderr") {
        const chunk = asBuffer(event.data ?? new ArrayBuffer(0));
        if (chunk.length > 0) {
          stderrChunks.push(chunk);
          stderrLength += chunk.byteLength;
          child.stderr?.emit("data", chunk);
          enforceMaxBuffer();
        }
        return;
      }
      if (event.type === "ipc") {
        ipcBuffer += new TextDecoder().decode(event.data ?? new ArrayBuffer(0));
        for (;;) {
          const newlineIndex = ipcBuffer.indexOf("\n");
          if (newlineIndex < 0) break;
          const line = ipcBuffer.slice(0, newlineIndex).replace(/\r$/, "");
          ipcBuffer = ipcBuffer.slice(newlineIndex + 1);
          if (!line.startsWith("__COTTONTAIL_IPC__")) continue;
          try {
            options.ipc?.(JSON.parse(line.slice("__COTTONTAIL_IPC__".length)), child);
          } catch (error) {
            emit("error", error);
          }
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
  if (body instanceof FormData) return (await encodeMultipartFormData(body)).bytes;
  if (typeof body.bytes === "function") return asBuffer(await body.bytes());
  if (typeof body.arrayBuffer === "function") return new Uint8Array(await body.arrayBuffer());
  const iterable = typeof body === "function" ? body() : body;
  if (typeof body.getReader === "function" || (iterable && typeof iterable[Symbol.asyncIterator] === "function")) {
    const chunks = [];
    await consumeStreamingBody(body, (chunk) => chunks.push(asBuffer(chunk)));
    return concatManyBuffers(chunks);
  }
  if (typeof body.text === "function") return new TextEncoder().encode(await body.text());
  return bytesFromData(body);
}

let nextBodySinkId = 1;

async function consumeStreamingBody(body, onChunk) {
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      for (;;) {
        const settled = await reader.read().then(
          (item) => ({ item, error: null }),
          (error) => ({ item: null, error }),
        );
        if (settled.error != null) throw settled.error;
        const item = settled.item;
        if (item.done) return;
        await onChunk(item.value);
      }
    } finally {
      reader.releaseLock?.();
    }
  }

  const iterable = typeof body === "function" ? body() : body;
  if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") {
    throw new TypeError("Expected a streaming response body");
  }
  const iterator = iterable[Symbol.asyncIterator]();
  const controller = {
    sinkId: nextBodySinkId++,
    async write(chunk) {
      await onChunk(chunk);
      return chunk?.byteLength ?? chunk?.length ?? String(chunk ?? "").length;
    },
    flush() {
      return 0;
    },
    async end(chunk = undefined) {
      if (chunk !== undefined) await onChunk(chunk);
    },
  };
  for (;;) {
    const item = await iterator.next(controller);
    if (item.value !== undefined && item.value !== null) await onChunk(item.value);
    if (item.done) return;
  }
}

function bodyReadableStream(body) {
  if (body == null) return null;
  if (typeof body.getReader === "function") return body;
  const iterable = typeof body === "function" ? body() : body;
  if (iterable && typeof iterable[Symbol.asyncIterator] === "function") {
    const iterator = iterable[Symbol.asyncIterator]();
    let pending = null;
    let closed = false;
    let activeChunks = null;
    const queuedChunks = [];
    const sink = {
      sinkId: nextBodySinkId++,
      write(chunk) {
        const target = activeChunks ?? queuedChunks;
        target.push(chunk);
        return chunk?.byteLength ?? chunk?.length ?? String(chunk ?? "").length;
      },
      flush() {
        return 0;
      },
      end(chunk = undefined) {
        if (chunk !== undefined) this.write(chunk);
        closed = true;
        return Promise.resolve();
      },
    };

    const nextItem = async (wait) => {
      if (!pending) pending = iterator.next(sink);
      if (wait) {
        const item = await pending;
        pending = null;
        return { settled: true, item };
      }
      let settled = false;
      let item;
      let error;
      pending.then(
        (value) => {
          settled = true;
          item = value;
        },
        (reason) => {
          settled = true;
          error = reason;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!settled) return { settled: false };
      pending = null;
      if (error) throw error;
      return { settled: true, item };
    };

    return new globalThis.ReadableStream({
      async pull(controller) {
        if (closed) {
          controller.close();
          return;
        }
        const chunks = queuedChunks.splice(0);
        activeChunks = chunks;
        try {
          for (;;) {
            const result = await nextItem(chunks.length === 0);
            if (!result.settled) break;
            const item = result.item;
            if (item.value !== undefined && item.value !== null) chunks.push(item.value);
            if (item.done) {
              closed = true;
              break;
            }
          }
        } finally {
          activeChunks = null;
        }
        if (chunks.length > 0) controller.enqueue(concatManyBuffers(chunks));
        if (closed) controller.close();
      },
      cancel(reason = undefined) {
        closed = true;
        return iterator.return?.(reason);
      },
    });
  }
  return new globalThis.ReadableStream({
    async start(controller) {
      try {
        const bytes = await bytesFromBody(body);
        if (bytes.byteLength > 0) controller.enqueue(bytes);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function arrayBufferFromBytes(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const blobBodyCache = new WeakMap();
const textBodyCache = new WeakMap();

function cachedBlobForBytes(bytes, type = "") {
  let typedCache = blobBodyCache.get(bytes);
  if (!typedCache) {
    typedCache = new Map();
    blobBodyCache.set(bytes, typedCache);
  }
  const key = String(type || "");
  let blob = typedCache.get(key);
  if (!blob) {
    blob = new Blob([arrayBufferFromBytes(bytes)], { type: key });
    typedCache.set(key, blob);
  }
  return blob;
}

function cachedTextForBytes(bytes) {
  let text = textBodyCache.get(bytes);
  if (text === undefined) {
    text = new TextDecoder().decode(bytes);
    textBodyCache.set(bytes, text);
  }
  return text;
}

export { URL, URLSearchParams };

export class Headers {
  constructor(init = undefined) {
    this._values = new Map();
    this._allValues = new Map();
    if (init instanceof Headers) {
      init.forEach((value, key) => this.append(key, value));
    } else if (Array.isArray(init)) {
      for (const [key, value] of init) this.append(key, value);
    } else if (init && typeof init === "object") {
      for (const key of Object.keys(init)) this.set(key, init[key]);
    }
  }
  append(key, value) {
    const normalized = String(key).toLowerCase();
    const existing = this._values.get(normalized);
    const stringValue = String(value);
    const allValues = this._allValues.get(normalized) ?? [];
    allValues.push(stringValue);
    this._allValues.set(normalized, allValues);
    // Per the fetch spec, cookie is the only header whose values combine with
    // "; " instead of ", " when appended.
    const separator = normalized === "cookie" ? "; " : ", ";
    this._values.set(normalized, {
      key: existing?.key ?? String(key),
      value: existing ? `${existing.value}${separator}${stringValue}` : stringValue,
    });
  }
  set(key, value) {
    const normalized = String(key).toLowerCase();
    const stringValue = String(value);
    this._allValues.set(normalized, [stringValue]);
    this._values.set(normalized, { key: String(key), value: stringValue });
  }
  get(key) {
    return this._values.get(String(key).toLowerCase())?.value ?? null;
  }
  getAll(key) {
    const normalized = String(key).toLowerCase();
    const allValues = this._allValues.get(normalized);
    if (allValues) return [...allValues];
    return headersGetAll.call(this, key);
  }
  has(key) {
    return this._values.has(String(key).toLowerCase());
  }
  delete(key) {
    const normalized = String(key).toLowerCase();
    this._allValues.delete(normalized);
    this._values.delete(normalized);
  }
  forEach(callback, thisArg = undefined) {
    for (const { key, value } of this._values.values()) callback.call(thisArg, value, key, this);
  }
  toJSON() {
    const result = {};
    const entries = [...this._values.values()]
      .map(({ key, value }) => [String(key).toLowerCase(), value])
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [key, value] of entries) result[key] = value;
    return result;
  }
  *entries() {
    for (const { key, value } of this._values.values()) yield [key, value];
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}

function headersGetAll(name) {
  const normalized = String(name).toLowerCase();
  if (normalized === "set-cookie" && typeof this.getSetCookie === "function") return this.getSetCookie();
  const value = this.get?.(name);
  return value == null ? [] : [String(value)];
}

export class FormData {
  constructor() {
    this._entries = [];
  }
  append(name, value, filename = undefined) {
    this._entries.push([String(name), filename === undefined ? value : { value, filename: String(filename) }]);
  }
  set(name, value, filename = undefined) {
    this.delete(name);
    this.append(name, value, filename);
  }
  get(name) {
    const key = String(name);
    const found = this._entries.find((entry) => entry[0] === key);
    return found ? formDataEntryValue(found[1]) : null;
  }
  getAll(name) {
    const key = String(name);
    return this._entries.filter((entry) => entry[0] === key).map((entry) => formDataEntryValue(entry[1]));
  }
  has(name) {
    const key = String(name);
    return this._entries.some((entry) => entry[0] === key);
  }
  delete(name) {
    const key = String(name);
    this._entries = this._entries.filter((entry) => entry[0] !== key);
  }
  *entries() {
    yield* this._entries;
  }
  *keys() {
    for (const [key] of this._entries) yield key;
  }
  *values() {
    for (const [, value] of this._entries) yield formDataEntryValue(value);
  }
  forEach(callback, thisArg = undefined) {
    for (const [key, value] of this._entries) callback.call(thisArg, formDataEntryValue(value), key, this);
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  toJSON() {
    const result = {};
    for (const [key, raw] of this._entries) {
      const value = formDataEntryValue(raw);
      const serialized = typeof value === "string"
        ? value
        : { name: raw?.filename ?? value?.name ?? "", size: value?.size ?? 0, type: value?.type ?? "" };
      if (Object.hasOwn(result, key)) {
        if (!Array.isArray(result[key])) result[key] = [result[key]];
        result[key].push(serialized);
      } else {
        result[key] = serialized;
      }
    }
    return result;
  }
  static from(data, boundary = undefined) {
    let text;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = stringLatin1FromBytes(new Uint8Array(data));
    else if (ArrayBuffer.isView(data)) text = stringLatin1FromBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    else if (data?._bytes instanceof Uint8Array) text = stringLatin1FromBytes(data._bytes);
    else text = String(data);
    if (boundary != null) return parseMultipartFormDataText(text, String(boundary));
    const result = new FormData();
    for (const [key, value] of new URLSearchParams(text)) result.append(key, value);
    return result;
  }
}

function stringLatin1FromBytes(bytes) {
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return output;
}

function formDataEntryValue(entry) {
  return entry && typeof entry === "object" && Object.hasOwn(entry, "value") && Object.hasOwn(entry, "filename")
    ? entry.value
    : entry;
}

function formDataBoundary(formData) {
  return formData._boundary ??= `----CottontailFormBoundary${randomBytes(12).toString("hex")}`;
}

function escapeMultipartHeader(value) {
  return String(value).replace(/\r|\n/g, " ").replace(/"/g, "%22");
}

async function encodeMultipartFormData(formData) {
  const boundary = formDataBoundary(formData);
  const chunks = [];
  for (const [name, rawEntry] of formData._entries) {
    const wrapped = rawEntry && typeof rawEntry === "object" && Object.hasOwn(rawEntry, "filename");
    const value = wrapped ? rawEntry.value : rawEntry;
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartHeader(name)}"`;
    if (wrapped) header += `; filename="${escapeMultipartHeader(rawEntry.filename)}"`;
    header += "\r\n";
    if (wrapped && value?.type) header += `Content-Type: ${value.type}\r\n`;
    chunks.push(new TextEncoder().encode(`${header}\r\n`));
    chunks.push(await bytesFromBody(value));
    chunks.push(new TextEncoder().encode("\r\n"));
  }
  chunks.push(new TextEncoder().encode(`--${boundary}--\r\n`));
  return { boundary, bytes: concatManyBuffers(chunks) };
}

async function parseMultipartFormData(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType))?.slice(1).find(Boolean);
  if (!boundary) return new FormData();
  const source = new TextDecoder("latin1").decode(await bytesFromBody(body));
  return parseMultipartFormDataText(source, boundary);
}

function parseMultipartFormDataText(source, boundary) {
  const result = new FormData();
  for (const rawPart of source.split(`--${boundary}`).slice(1, -1)) {
    const part = rawPart.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const separator = part.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const headers = part.slice(0, separator);
    const value = part.slice(separator + 4);
    const disposition = /content-disposition:[^\r\n]*?\bname="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
    if (!disposition) continue;
    if (disposition[2] !== undefined) {
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] ?? "application/octet-stream";
      result.append(disposition[1], new Blob([new TextEncoder().encode(value)], { type }), disposition[2]);
    } else {
      result.append(disposition[1], value);
    }
  }
  return result;
}

export class Request {
  constructor(input, init = {}) {
    this.url = normalizeRequestUrl(typeof input === "string" ? input : String(input?.url ?? input ?? ""));
    this.method = String(init.method ?? input?.method ?? "GET").toUpperCase();
    this.headers = new Headers(init.headers ?? input?.headers);
    this._body = init.body ?? input?._body ?? input?.body ?? null;
    this._bodyStream = undefined;
    this._bodyUsed = false;
    const standardRequestInput = typeof input === "string" || input instanceof Request || input instanceof globalThis.URL;
    if (standardRequestInput && (this.method === "GET" || this.method === "HEAD") && this._body != null) {
      throw new TypeError("Request with GET/HEAD method cannot have body");
    }
    this.params = init.params ?? input?.params ?? {};
    this.signal = init.signal ?? input?.signal ?? null;
    this.redirect = init.redirect ?? input?.redirect ?? "follow";
  }
  get body() {
    if (!this._bodyStream) {
      this._bodyStream = bodyReadableStream(this._body);
      const getReader = this._bodyStream?.getReader?.bind(this._bodyStream);
      if (getReader) this._bodyStream.getReader = (...args) => {
        const reader = getReader(...args);
        const read = reader.read.bind(reader);
        reader.read = (...readArgs) => { this._bodyUsed = true; return read(...readArgs); };
        return reader;
      };
    }
    return this._bodyStream;
  }
  get cookies() {
    return this._cookies ??= new CookieMap(this.headers.get("cookie") ?? "", { preserveFirst: true });
  }
  set cookies(_) {
    throw new TypeError("Request.cookies is readonly");
  }
  get bodyUsed() {
    return this._bodyUsed;
  }
  clone() {
    if (this._bodyUsed) throw new TypeError("Body already used");
    const cloned = new Request(this.url, {
      method: this.method,
      headers: new Headers(this.headers),
      params: this.params,
      signal: this.signal,
      redirect: this.redirect,
    });
    cloned._body = teeClonedBody(this);
    if (this._cookies) cloned._cookies = cloneCookieMap(this._cookies);
    return cloned;
  }
  async arrayBuffer() {
    return arrayBufferFromBytes(await bytesFromBody(this._body));
  }
  async bytes() {
    return asBuffer(await bytesFromBody(this._body));
  }
  async blob() {
    const type = this.headers.get("content-type") ?? "";
    if (this._body instanceof Blob && (!type || this._body.type === type)) return this._body;
    return cachedBlobForBytes(await bytesFromBody(this._body), type);
  }
  async text() {
    if (typeof this._body === "string") return this._body;
    return cachedTextForBytes(await bytesFromBody(this._body));
  }
  async json() {
    return JSON.parse(await this.text());
  }
  formData() {
    if (!(this instanceof Request)) {
      let message = "Expected this to be instanceof Request";
      if (this === null) message += ", but received null";
      else if (this !== undefined && typeof this === "object") message += `, but received an instance of ${this.constructor?.name ?? "Object"}`;
      else if (typeof this === "string") message += `, but received type string ('${this}')`;
      else if (this !== undefined) message += `, but received type ${typeof this} (${nodeInspect(this)})`;
      const error = new TypeError(message);
      error.code = "ERR_INVALID_THIS";
      throw error;
    }
    if (this._bodyUsed) return handledRejectedPromise(new TypeError("Body already used"));
    this._bodyUsed = true;
    if (this._body instanceof FormData || (this._body && typeof this._body.get === "function" && typeof this._body.append === "function")) {
      return Promise.resolve(this._body);
    }
    return parseMultipartFormData(this._body, this.headers.get("content-type"));
  }
}

function cloneCookieMap(map) {
  const cloned = new CookieMap();
  for (const [name, value] of Map.prototype.entries.call(map)) {
    Map.prototype.set.call(cloned, name, value);
  }
  cloned._changes = map._changes.map((change) => ({ ...change }));
  cloned._initialKeys = [...map._initialKeys];
  cloned._dynamicKeys = [...map._dynamicKeys];
  return cloned;
}

function teeClonedBody(source) {
  const body = source._body;
  if (body && typeof body.tee === "function" && typeof body.getReader === "function") {
    const [original, cloned] = body.tee();
    source._body = original;
    source._bodyStream = undefined;
    return cloned;
  }
  return body;
}

function normalizeRequestUrl(value) {
  const text = String(value);
  try {
    const url = new URL(text);
    const pathname = String(url.pathname || "/").replace(/^\/+/, "/") || "/";
    if (pathname === url.pathname) return text;
    return `${url.origin}${pathname}${url.search}${url.hash}`;
  } catch {
    return text;
  }
}

export class Response {
  constructor(body = null, init = {}) {
    this.status = Number(init.status ?? 200);
    this.statusText = String(init.statusText ?? "");
    this.headers = new Headers(init.headers);
    if (body instanceof FormData && !this.headers.has("content-type")) {
      this.headers.set("Content-Type", `multipart/form-data; boundary=${formDataBoundary(body)}`);
    }
    this._body = body;
    this._bodyStream = undefined;
    this.url = String(init.url ?? "");
    this.redirected = Boolean(init.redirected);
  }
  static json(value, init = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(JSON.stringify(value), { ...init, headers });
  }
  static redirect(url, status = 302) {
    return new Response(null, { status, headers: { location: String(url) } });
  }
  clone() {
    return new Response(teeClonedBody(this), {
      status: this.status,
      statusText: this.statusText,
      headers: new Headers(this.headers),
      url: this.url,
      redirected: this.redirected,
    });
  }
  async arrayBuffer() {
    return arrayBufferFromBytes(await bytesFromBody(this._body));
  }
  async bytes() {
    return asBuffer(await bytesFromBody(this._body));
  }
  async blob() {
    const type = this.headers.get("content-type") ?? "";
    if (this._body instanceof Blob && (!type || this._body.type === type)) return this._body;
    return cachedBlobForBytes(await bytesFromBody(this._body), type);
  }
  async text() {
    if (typeof this._body === "string") return this._body;
    return cachedTextForBytes(await bytesFromBody(this._body));
  }
  async json() {
    return JSON.parse(await this.text());
  }
  formData() {
    if (this._body instanceof FormData) return Promise.resolve(this._body);
    return parseMultipartFormData(this._body, this.headers.get("content-type"));
  }
  get body() {
    return this._bodyStream ??= bodyReadableStream(this._body);
  }
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
}

const activeServeOrigins = globalThis.__cottontailActiveServeOrigins ??= new Map();

function activeServerForFetchUrl(urlText) {
  try {
    const url = new URL(urlText);
    const rawHostname = String(url.hostname).slice(String(url.hostname).lastIndexOf("@") + 1);
    const hostname = rawHostname.includes(":") && !rawHostname.startsWith("[") ? `[${rawHostname}]` : rawHostname;
    const authority = `${hostname}${url.port ? `:${url.port}` : ""}`;
    const direct = activeServeOrigins.get(`${url.protocol}//${authority}`);
    if (direct) return direct;
    if (url.hostname === "localhost") return activeServeOrigins.get(`${url.protocol}//127.0.0.1:${url.port}`);
  } catch {}
  return null;
}

function fetchProxyConfiguration(urlText, init = {}) {
  const explicit = init?.proxy;
  if (explicit != null && String(explicit).trim() !== "") {
    let value = String(explicit).trim();
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) value = `http://${value}`;
    return { active: true, explicit: value, environment: null, disabled: false };
  }

  let protocol = "http:";
  try { protocol = new URL(urlText).protocol; } catch {}
  const env = globalThis.process?.env ?? {};
  const names = protocol === "https:"
    ? ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"]
    : ["http_proxy", "HTTP_PROXY"];
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(env, name)) continue;
    const value = String(env[name] ?? "").trim();
    if (value === "" || value === "undefined" || value === "''" || value === '\"\"') {
      return { active: false, explicit: null, environment: null, disabled: true };
    }
    const bypass = noProxyMatches(urlText, env.NO_PROXY ?? env.no_proxy ?? "");
    return {
      active: !bypass,
      explicit: null,
      environment: bypass ? null : value,
      disabled: bypass,
    };
  }
  return { active: false, explicit: null, environment: null, disabled: false };
}

function noProxyMatches(urlText, noProxy) {
  let url;
  try { url = new URL(urlText); } catch { return false; }
  const host = String(url.hostname).slice(String(url.hostname).lastIndexOf("@") + 1).replace(/^\[|\]$/g, "").toLowerCase();
  const port = String(url.port || (url.protocol === "https:" ? "443" : "80"));
  for (const rawEntry of String(noProxy).split(",")) {
    let entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    let entryHost = entry;
    let entryPort = "";
    if (entry.startsWith("[")) {
      const end = entry.indexOf("]");
      if (end >= 0) {
        entryHost = entry.slice(1, end);
        if (entry[end + 1] === ":") entryPort = entry.slice(end + 2);
      }
    } else {
      const colon = entry.lastIndexOf(":");
      if (colon > 0 && entry.indexOf(":") === colon && /^\d+$/.test(entry.slice(colon + 1))) {
        entryHost = entry.slice(0, colon);
        entryPort = entry.slice(colon + 1);
      }
    }
    if (entryPort && entryPort !== port) continue;
    const normalized = entryHost.replace(/^\./, "");
    if (host === normalized || host.endsWith(`.${normalized}`)) return true;
  }
  return false;
}

async function fetchFromActiveProxy(activeProxy, proxyUrl, request) {
  const headers = new Headers(request.headers);
  headers.set("proxy-connection", "Keep-Alive");
  try {
    const authority = String(proxyUrl).match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/)?.[1] ?? "";
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
      const userInfo = authority.slice(0, at);
      const colon = userInfo.indexOf(":");
      const username = colon >= 0 ? userInfo.slice(0, colon) : userInfo;
      const password = colon >= 0 ? userInfo.slice(colon + 1) : "";
      const credentials = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
      headers.set("proxy-authorization", `Basic ${Buffer.from(credentials).toString("base64")}`);
    }
  } catch {}
  const proxyRequest = new Request(request.url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request._body,
    redirect: request.redirect,
    signal: request.signal,
  });
  const response = await activeProxy.fetch(proxyRequest);
  response.url = request.url;
  return response;
}

function isLoopbackHttpUrl(urlText) {
  try {
    const url = new URL(urlText);
    const hostname = String(url.hostname).replace(/^\[|\]$/g, "").toLowerCase();
    return url.protocol === "http:" && (hostname === "localhost" || hostname === "::1" || hostname.startsWith("127."));
  } catch {
    return false;
  }
}

async function fetchFromNodeHttp(request, redirectMode = "follow", depth = 0, redirected = false) {
  if (depth > 20) throw new TypeError("redirect count exceeded");
  const response = await fetchOnceFromNodeHttp(request, redirected);
  if (redirectMode === "manual" || !isRedirectStatus(response.status)) return response;
  if (redirectMode === "error") throw new TypeError("fetch failed");
  const location = response.headers.get("location");
  if (!location) return response;
  const nextUrl = String(new URL(redirectLocationText(location), request.url));
  const dropBody = response.status === 303 ||
    ((response.status === 301 || response.status === 302) && request.method === "POST");
  const nextRequest = new Request(nextUrl, {
    method: dropBody ? "GET" : request.method,
    headers: new Headers(request.headers),
    signal: request.signal,
    redirect: request.redirect,
  });
  if (!dropBody) nextRequest._body = request._body;
  return fetchFromNodeHttp(nextRequest, redirectMode, depth + 1, true);
}

// Location header bytes reach JS as latin1 code units; the fetch spec treats
// them as UTF-8, so reinterpret before URL resolution when that produces
// valid UTF-8 text. Reinterpret repeatedly (bounded) because the node/http.js
// server currently serializes header values as UTF-8 instead of latin1, which
// adds a second mojibake layer when both ends run in this process; each loop
// iteration strictly requires a clean UTF-8 round-trip, so an extra pass never
// fires on already-correct text.
function redirectLocationText(location) {
  let text = String(location);
  for (let pass = 0; pass < 3; pass += 1) {
    if (!/[\x80-\xff]/.test(text) || /[Ā-￿]/.test(text)) return text;
    const bytes = Buffer.from(text, "latin1");
    const decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(bytes) || decoded === text) return text;
    text = decoded;
  }
  return text;
}

async function fetchOnceFromNodeHttp(request, redirected = false) {
  const body = request.method === "GET" || request.method === "HEAD"
    ? Buffer.alloc(0)
    : Buffer.from(await bytesFromBody(request._body));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      request.signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const clientRequest = nodeHttp.request(request.url, {
      agent: false,
      headers: Object.fromEntries(request.headers),
      method: request.method,
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("error", (error) => finish(reject, error));
      incoming.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers ?? {})) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value != null) headers.set(name, value);
        }
        finish(resolve, new Response(Buffer.concat(chunks), {
          headers,
          status: incoming.statusCode ?? 200,
          statusText: incoming.statusMessage ?? "",
          url: request.url,
          redirected,
        }));
      });
    });
    const onAbort = () => {
      clientRequest.destroy?.();
      finish(reject, request.signal?.reason ?? abortError());
    };
    clientRequest.on("error", (error) => finish(reject, error));
    request.signal?.addEventListener?.("abort", onAbort, { once: true });
    if (request.signal?.aborted) return onAbort();
    if (body.byteLength > 0) clientRequest.write(body);
    clientRequest.end();
  });
}

async function fetchImpl(input, init = {}) {
  let requestInit = init;
  if (!(input instanceof Request) && init?.body === "") {
    const method = String(init.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") requestInit = { ...init, body: undefined };
  }
  const request = input instanceof Request ? input : new Request(input, requestInit);
  throwIfAborted(request.signal);
  const proxy = fetchProxyConfiguration(request.url, init);
  const activeServer = activeServerForFetchUrl(request.url);
  const redirectMode = String(init.redirect ?? input?.redirect ?? request.redirect ?? "follow");
  if (proxy.explicit) {
    const activeProxy = activeServerForFetchUrl(proxy.explicit);
    if (activeProxy) return await fetchFromActiveProxy(activeProxy, proxy.explicit, request);
  }
  if (activeServer && !proxy.active) return await fetchFromActiveServer(activeServer, request, redirectMode, 0, false);
  if (!proxy.active && isLoopbackHttpUrl(request.url)) return await fetchFromNodeHttp(request, redirectMode);

  const args = ["-L", "-sS", "-D", "-", "-X", request.method];
  const timeoutState = abortSignalState.get(request.signal);
  const timeoutRemaining = timeoutState?.timeoutDeadline == null
    ? null
    : Math.max(1, timeoutState.timeoutDeadline - Date.now());
  if (timeoutRemaining != null) {
    const seconds = String(timeoutRemaining / 1000);
    args.push("--connect-timeout", seconds, "--max-time", seconds);
  }
  if (proxy.explicit) args.push("--proxy", proxy.explicit);
  else if (proxy.environment) args.push("--proxy", proxy.environment, "--noproxy", "");
  else if (proxy.disabled) args.push("--proxy", "", "--noproxy", "*");
  if (proxy.active) args.push("-H", "Proxy-Connection: Keep-Alive");
  request.headers.forEach((value, key) => {
    args.push("-H", `${key}: ${value}`);
  });
  const body = await request.text();
  if (body.length > 0 && request.method !== "GET" && request.method !== "HEAD") {
    args.push("--data-binary", body);
  }
  try {
    const url = new URL(request.url);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const records = typeof cottontail.dnsLookup === "function" ? cottontail.dnsLookup(url.hostname, 0) : [];
    const record = Array.from(records ?? []).find((item) => Number(item.family) === 4 && item.address)
      ?? Array.from(records ?? []).find((item) => item.address);
    if (record?.address) args.push("--resolve", `${url.hostname}:${port}:${record.address}`);
  } catch {}
  args.push("-w", "\n__COTTONTAIL_HTTP_STATUS__:%{http_code}", request.url);

  const result = cottontail.spawnSync("curl", args, { stdio: "pipe" });
  const stdout = String(result.stdout ?? "");
  const marker = "\n__COTTONTAIL_HTTP_STATUS__:";
  const markerIndex = stdout.lastIndexOf(marker);
  const payload = markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout;
  const status = markerIndex >= 0 ? Number(stdout.slice(markerIndex + marker.length).trim()) || 0 : Number(result.status) || 0;

  if (result.status !== 0 && status === 0) {
    if (timeoutRemaining != null) throw makeTimeoutError();
    throw new Error(String(result.stderr || result.stdout || "fetch failed"));
  }

  let responseHeaders = new Headers();
  let bodyOffset = 0;
  while (payload.startsWith("HTTP/", bodyOffset)) {
    const headerEnd = payload.indexOf("\r\n\r\n", bodyOffset);
    const separatorLength = headerEnd >= 0 ? 4 : 2;
    const effectiveEnd = headerEnd >= 0 ? headerEnd : payload.indexOf("\n\n", bodyOffset);
    if (effectiveEnd < 0) break;
    const block = payload.slice(bodyOffset, effectiveEnd);
    const firstNewline = block.indexOf("\n");
    responseHeaders = parseHeadersText(firstNewline >= 0 ? block.slice(firstNewline + 1) : "");
    bodyOffset = effectiveEnd + separatorLength;
    if (!payload.startsWith("HTTP/", bodyOffset)) break;
  }

  return new Response(payload.slice(bodyOffset), { status: status || 200, headers: responseHeaders });
}

export function fetch(input, init = {}) {
  const body = input instanceof Request ? input._body : init?.body;
  if (isBunFileLike(body) && body._bunFilePath && !cottontail.existsSync(body._bunFilePath)) {
    const error = new Error(`ENOENT: no such file or directory, open '${body._bunFilePath}'`);
    error.code = "ENOENT";
    return handledRejectedPromise(error);
  }
  return fetchImpl(input, init);
}

function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function decodeFetchResponse(response) {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding !== "zstd") return response;
  const decoded = zlib.zstdDecompressSync(await response.bytes());
  return new Response(decoded, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
    url: response.url,
    redirected: response.redirected,
  });
}

async function fetchFromActiveServer(activeServer, request, redirectMode, depth, redirected) {
  throwIfAborted(request.signal);
  if (depth > 20) throw new TypeError("redirect count exceeded");
  const response = await activeServer.fetch(request);
  throwIfAborted(request.signal);
  response.url = request.url;
  response.redirected = Boolean(redirected || response.redirected);
  if (redirectMode === "manual" || !isRedirectStatus(response.status)) return decodeFetchResponse(response);
  if (redirectMode === "error") throw new TypeError("fetch failed");

  const location = response.headers.get("location");
  if (!location) return response;
  const nextUrl = String(new URL(location, request.url));
  const nextInit = {
    method: request.method,
    headers: new Headers(request.headers),
    signal: request.signal,
    redirect: request.redirect,
  };
  if (response.status === 303 && nextInit.method !== "GET" && nextInit.method !== "HEAD") {
    nextInit.method = "GET";
  } else if (nextInit.method !== "GET" && nextInit.method !== "HEAD") {
    nextInit.body = request._body;
  }
  const nextRequest = new Request(nextUrl, nextInit);
  const nextActiveServer = activeServerForFetchUrl(nextUrl) ?? activeServer;
  return fetchFromActiveServer(nextActiveServer, nextRequest, redirectMode, depth + 1, true);
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

function appendRequestCookieHeaders(response, request) {
  const cookies = request?._cookies;
  if (!cookies || response.__cottontailCookieChangesApplied) return;
  for (const header of cookies.toSetCookieHeaders()) response.headers.append("Set-Cookie", header);
  Object.defineProperty(response, "__cottontailCookieChangesApplied", {
    value: true,
    configurable: true,
  });
}

function normalizeResponse(value, request = undefined) {
  const response = value instanceof Response ? value : new Response(value);
  if (!response.headers.has("date")) response.headers.set("Date", cachedServeDateHeader());
  appendRequestCookieHeaders(response, request);
  return response;
}

function normalizeResponseResult(value) {
  return isPromiseLike(value) ? value.then(normalizeResponse) : normalizeResponse(value);
}

let cachedServeDateSecond = -1;
let cachedServeDateValue = "";

function cachedServeDateHeader() {
  const second = Math.floor(Date.now() / 1000);
  if (second !== cachedServeDateSecond) {
    cachedServeDateSecond = second;
    cachedServeDateValue = new Date(second * 1000).toUTCString();
  }
  return cachedServeDateValue;
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
  const normalize = (value) => String(value || "/").replace(/^\/+/, "/") || "/";
  try {
    return normalize(new URL(request.url).pathname);
  } catch {
    return normalize(String(request.url).replace(/^https?:\/\/[^/]+/, "").split(/[?#]/, 1)[0] || "/");
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

function routeSpecificity(pattern) {
  const parts = String(pattern).split("/").filter(Boolean);
  let literalCount = 0;
  let paramCount = 0;
  let wildcardCount = 0;
  for (const part of parts) {
    if (part === "*" || part.endsWith("*")) wildcardCount += 1;
    else if (part.startsWith(":")) paramCount += 1;
    else literalCount += 1;
  }
  return [
    wildcardCount === 0 ? 1 : 0,
    literalCount,
    parts.length,
    -paramCount,
  ];
}

function compareRouteSpecificity(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return 0;
}

function selectRoute(routes, request) {
  if (!routes || typeof routes !== "object") return null;
  const pathname = requestPathname(request);
  let best = null;
  let order = 0;
  for (const [pattern, route] of Object.entries(routes)) {
    const params = matchRoutePattern(pattern, pathname);
    const currentOrder = order;
    order += 1;
    if (!params) continue;
    if (route === false) continue;

    let handler = route;
    if (handler && typeof handler === "object" && !(handler instanceof Response) && typeof handler.arrayBuffer !== "function") {
      handler = handler[request.method] ?? handler[request.method.toLowerCase()] ?? handler.ALL ?? handler.all;
      if (handler == null || handler === false) continue;
    }
    const specificity = routeSpecificity(pattern);
    const candidate = { handler, params, specificity, order: currentOrder };
    if (!best) {
      best = candidate;
      continue;
    }
    const comparison = compareRouteSpecificity(candidate.specificity, best.specificity);
    if (comparison < 0 || (comparison === 0 && candidate.order < best.order)) {
      best = candidate;
    }
  }
  if (!best) return null;
  request.params = best.params;
  return best.handler;
}

function selectStaticRoute(staticRoutes, request) {
  if (!staticRoutes || typeof staticRoutes !== "object") return null;
  const pathname = requestPathname(request);
  if (!Object.prototype.hasOwnProperty.call(staticRoutes, pathname)) return null;
  return staticRoutes[pathname];
}

function bodyType(body) {
  if (body instanceof FormData) return `multipart/form-data; boundary=${formDataBoundary(body)}`;
  if (body && typeof body === "object" && typeof body.type === "string" && body.type !== "") return body.type;
  return "";
}

function bodyLastModified(body) {
  if (body && typeof body === "object" && typeof body._bunFilePath === "string") {
    try {
      const stat = cottontail.statSync(body._bunFilePath, true);
      const mtime = Number(stat?.mtimeMs ?? 0);
      if (mtime > 0) return new Date(mtime).toUTCString();
    } catch {}
  }
  if (body && typeof body === "object" && Number.isFinite(Number(body.lastModified)) && Number(body.lastModified) > 0) {
    return new Date(Number(body.lastModified)).toUTCString();
  }
  return "";
}

function entityTagForBytes(bytes) {
  return `"${createHash("sha1").update(bytes).digest("hex")}"`;
}

function normalizedEntityTag(value) {
  let text = String(value ?? "").trim();
  if (text.startsWith("W/")) text = text.slice(2).trim();
  if (text.length < 2 || !text.startsWith("\"") || !text.endsWith("\"")) return null;
  return text.slice(1, -1);
}

function ifNoneMatchMatches(headerValue, etag) {
  if (!headerValue || !etag) return false;
  const expected = normalizedEntityTag(etag);
  if (expected == null) return false;
  for (const rawPart of String(headerValue).split(",")) {
    const part = rawPart.trim();
    if (part === "*") return true;
    const actual = normalizedEntityTag(part);
    if (actual != null && actual === expected) return true;
  }
  return false;
}

function statusAllowsBody(status) {
  return status !== 101 && status !== 204 && status !== 205 && status !== 304;
}

function isStreamingBody(body) {
  if (typeof body === "function") return true;
  return body != null && (
    typeof body.getReader === "function" ||
    typeof body[Symbol.asyncIterator] === "function"
  );
}

const serveResponseCache = new WeakMap();

function ifModifiedSinceNotModified(headerValue, lastModified) {
  if (!headerValue || !lastModified) return false;
  const requestTime = Date.parse(String(headerValue));
  const modifiedTime = Date.parse(String(lastModified));
  if (!Number.isFinite(requestTime) || !Number.isFinite(modifiedTime)) return false;
  return requestTime >= Math.floor(modifiedTime / 1000) * 1000;
}

function isMissingFileError(error) {
  const text = String(error?.message ?? error ?? "");
  return text.includes("ENOENT") || text.includes("No such file or directory") || text.includes("FileNotFound");
}

async function prepareServeResponse(value, request, options = {}) {
  const cached = options.cacheKey && typeof options.cacheKey === "object"
    ? serveResponseCache.get(options.cacheKey)
    : null;
  const sourceResponse = cached
    ? cached.response.clone()
    : normalizeResponse(value instanceof Response ? value : new Response(value));
  const headers = new Headers(sourceResponse.headers);
  const body = cached ? cached.body : sourceResponse._body;
  const method = String(request.method || "GET").toUpperCase();
  const isFile = isBunFileLike(body);
  const streaming = !cached && method !== "HEAD" && isStreamingBody(body);

  if (options.allowFileFallback && isFile && typeof body.exists === "function" && !(await body.exists())) {
    return null;
  }

  let status = sourceResponse.status;
  let bytes = cached?.bytes ?? new Uint8Array(0);
  if (statusAllowsBody(status)) {
    if (!cached && method === "HEAD" && isFile && Number.isFinite(Number(body.size))) {
      bytes = { byteLength: Number(body.size) };
    } else if (!cached && !streaming) {
      try {
        bytes = await bytesFromBody(body);
      } catch (error) {
        if (options.allowFileFallback && isFile && isMissingFileError(error)) return null;
        throw error;
      }
    }
  }

  if (!headers.has("content-type")) {
    const type = bodyType(body);
    if (type) headers.set("Content-Type", type);
  }
  if (!headers.has("last-modified")) {
    const lastModified = bodyLastModified(body);
    if (lastModified) headers.set("Last-Modified", lastModified);
  }
  if (isFile && status === 200 && bytes.byteLength === 0) status = 204;

  if ((method === "GET" || method === "HEAD") && status === 200 && ifModifiedSinceNotModified(request.headers.get("if-modified-since"), headers.get("last-modified"))) {
    headers.delete("content-length");
    return normalizeResponse(new Response(null, {
      status: 304,
      statusText: sourceResponse.statusText,
      headers,
    }), request);
  }

  if (statusAllowsBody(status) && !streaming) {
    if (!headers.has("content-length")) headers.set("Content-Length", String(bytes.byteLength));
  } else {
    headers.delete("content-length");
  }
  if (options.addEtag && status === 200 && !streaming && !headers.has("etag")) {
    headers.set("ETag", entityTagForBytes(bytes));
  }

  if (!streaming && !cached && options.cacheKey && typeof options.cacheKey === "object" && bytes instanceof Uint8Array) {
    serveResponseCache.set(options.cacheKey, {
      response: new Response(bytes, {
        status,
        statusText: sourceResponse.statusText,
        headers: new Headers(headers),
      }),
      body,
      bytes,
    });
  }

  if ((method === "GET" || method === "HEAD") && status === 200 && ifNoneMatchMatches(request.headers.get("if-none-match"), headers.get("etag"))) {
    headers.delete("content-length");
    return normalizeResponse(new Response(null, {
      status: 304,
      statusText: sourceResponse.statusText,
      headers,
    }), request);
  }

  return normalizeResponse(new Response(method === "HEAD" ? null : (streaming ? body : bytes), {
    status,
    statusText: sourceResponse.statusText,
    headers,
  }), request);
}

function prepareServeResponseSync(value, request, options = {}) {
  if (options.cacheKey || options.allowFileFallback || options.addEtag) return null;
  const sourceResponse = normalizeResponse(value instanceof Response ? value : new Response(value));
  const body = sourceResponse._body;
  if (!(body == null || typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body))) return null;
  const method = String(request.method || "GET").toUpperCase();
  if (sourceResponse.status === 200 && (request.headers.get("if-modified-since") || request.headers.get("if-none-match"))) return null;
  const headers = new Headers(sourceResponse.headers);
  let status = sourceResponse.status;
  const bytes = statusAllowsBody(status) && method !== "HEAD" ? bytesFromData(body) : new Uint8Array(0);
  if (!headers.has("content-type")) {
    const type = bodyType(body);
    if (type) headers.set("Content-Type", type);
  }
  if (statusAllowsBody(status)) {
    if (!headers.has("content-length")) headers.set("Content-Length", String(bytes.byteLength));
  } else {
    headers.delete("content-length");
  }
  return normalizeResponse(new Response(method === "HEAD" ? null : bytes, {
    status,
    statusText: sourceResponse.statusText,
    headers,
  }), request);
}

function prepareServeResponseResult(value, request, options = {}) {
  if (isPromiseLike(value)) {
    return value.then((resolved) => prepareServeResponseResult(resolved, request, options));
  }
  return prepareServeResponseSync(value, request, options) ?? prepareServeResponse(value, request, options);
}

function runFetchFallback(options, request, server) {
  if (typeof options.fetch === "function") {
    return prepareServeResponseResult(options.fetch(request, server), request);
  }
  return prepareServeResponse(new Response("Not Found", { status: 404 }), request);
}

function serveErrorResponse(options, error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  let response;
  if (typeof options.error === "function") {
    try {
      return normalizeResponseResult(options.error(error));
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
  return normalizeResponseResult(response);
}

function runServeHandler(options, request, server) {
  if (options.static && typeof options.static === "object") {
    const staticRoute = selectStaticRoute(options.static, request);
    if (staticRoute != null) {
      return prepareServeResponseResult(staticRoute, request, {
        addEtag: true,
        cacheKey: staticRoute && typeof staticRoute === "object" ? staticRoute : null,
      });
    }
  }

  const route = selectRoute(options.routes, request);
  if (route != null) {
    const response = typeof route === "function" ? route(request, server) : route;
    const prepared = prepareServeResponseResult(response, request, { allowFileFallback: true });
    return isPromiseLike(prepared)
      ? prepared.then((resolved) => resolved ?? runFetchFallback(options, request, server))
      : (prepared ?? runFetchFallback(options, request, server));
  }
  return runFetchFallback(options, request, server);
}

function bunServeNeedsHandlerMessage() {
  return `Bun.serve() needs either:

  - A routes object:
     routes: {
       "/path": {
         GET: (req) => new Response("Hello")
       }
     }

  - Or a fetch handler:
     fetch: (req) => {
       return new Response("Hello")
     }

Learn more at https://bun.com/docs/api/http`;
}

function invalidRoutesMessage() {
  return `'routes' expects a Record<string, Response | HTMLBundle | {[method: string]: (req: BunRequest) => Response|Promise<Response>}>

To bundle frontend apps on-demand with Bun.serve(), import HTML files.

Example:

\`\`\`js
import { serve } from "bun";
import app from "./app.html";

serve({
  routes: {
    "/index.json": Response.json({ message: "Hello World" }),
    "/app": app,
    "/path/:param": (req) => {
      const param = req.params.param;
      return Response.json({ message: \`Hello \${param}\` });
    },
    "/path": {
      GET(req) {
        return Response.json({ message: "Hello World" });
      },
      POST(req) {
        return Response.json({ message: "Hello World" });
      },
    },
  },

  fetch(request) {
    return new Response("fallback response");
  },
});
\`\`\`

See https://bun.com/docs/api/http for more information.`;
}

function isValidRouteHandler(value) {
  return value === false ||
    typeof value === "function" ||
    value instanceof Response ||
    (value && typeof value === "object" && typeof value.arrayBuffer === "function");
}

function validateRoutePattern(pattern) {
  const seen = new Set();
  for (const part of String(pattern).split("/").filter(Boolean)) {
    if (!part.startsWith(":")) continue;
    const name = part.slice(1);
    if (/^\d/.test(name)) throw new TypeError("Route parameter names cannot start with a number.");
    if (seen.has(name)) throw new TypeError("Support for duplicate route parameter names is not yet implemented.");
    seen.add(name);
  }
}

function validateServeRoutes(routes) {
  if (routes == null) return false;
  if (typeof routes !== "object") throw new TypeError(invalidRoutesMessage());
  const entries = Object.entries(routes);
  for (const [pattern, route] of entries) {
    validateRoutePattern(pattern);
    if (isValidRouteHandler(route)) continue;
    if (route && typeof route === "object") {
      let validMethodObject = true;
      for (const value of Object.values(route)) {
        if (!isValidRouteHandler(value)) {
          validMethodObject = false;
          break;
        }
      }
      if (validMethodObject) continue;
    }
    throw new TypeError(invalidRoutesMessage());
  }
  return entries.length > 0;
}

function coerceServeOptionString(value, name) {
  if (typeof value === "symbol") throw new TypeError(`${name} must be coercible to a string`);
  if (value === null || value === undefined) return "";
  if (typeof value !== "object" && typeof value !== "function") return String(value);

  for (const methodName of ["toString", "valueOf"]) {
    const method = value[methodName];
    if (typeof method !== "function") continue;
    const result = method.call(value);
    if (result === null || result === undefined || typeof result === "symbol") {
      throw new TypeError(`${name} must be coercible to a string`);
    }
    if (typeof result !== "object" && typeof result !== "function") return String(result);
  }
  throw new TypeError(`${name} must be coercible to a string`);
}

function normalizeServeHostname(value) {
  const hostname = value === null || value === undefined
    ? ""
    : coerceServeOptionString(value, "hostname");
  if (hostname.length === 0) return "localhost";
  if (hostname.length > 253 || hostname.includes("\0") || hostname.includes(":")) {
    throw new TypeError(`Invalid hostname: ${hostname}`);
  }
  const labels = hostname.split(".");
  if (labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    throw new TypeError(`Invalid hostname: ${hostname}`);
  }
  return hostname;
}

function normalizeServeUnixPath(value) {
  if (value === null || value === undefined) return "";
  const path = coerceServeOptionString(value, "unix");
  if (path.includes("\0")) throw new TypeError("unix must not contain NUL bytes");
  return path;
}

export function serve(options = {}) {
  const hasRoutes = validateServeRoutes(options.routes);
  const hasStaticRoutes = options.static != null && typeof options.static === "object" && Object.keys(options.static).length > 0;
  if (typeof options.fetch !== "function" && !hasRoutes && !hasStaticRoutes) {
    throw new TypeError(bunServeNeedsHandlerMessage());
  }

  const unixPath = normalizeServeUnixPath(options.unix);
  const suppliedHostname = options.hostname === null || options.hostname === undefined
    ? ""
    : coerceServeOptionString(options.hostname, "hostname");
  if (unixPath && suppliedHostname) {
    throw new TypeError("Bun.serve cannot use hostname with unix");
  }
  const hostname = normalizeServeHostname(options.hostname);
  const native = cottontail.httpServerStart(hostname, defaultServePort(options), unixPath || undefined);
  const isUnix = unixPath.length > 0;
  const requestOrigin = isUnix ? "http://localhost" : `http://${native.hostname}:${native.port}`;
  let activeOptions = options;
  let stopped = false;
  let pumping = false;
  let interval = null;
  let publicUrl = null;
  const originKeys = isUnix ? [] : [
    requestOrigin,
    ...(native.hostname === "0.0.0.0" ? [`http://127.0.0.1:${native.port}`, `http://localhost:${native.port}`] : []),
  ];

  const server = {
    id: options.id ?? native.id,
    hostname: isUnix ? undefined : native.hostname,
    port: isUnix ? undefined : native.port,
    address: isUnix ? native.address : undefined,
    development: activeOptions.development ?? false,
    pendingRequests: 0,
    pendingWebSockets: 0,
    get url() {
      publicUrl ??= new globalThis.URL(`${requestOrigin}/`);
      return publicUrl;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (interval != null) clearInterval(interval);
      for (const origin of originKeys) activeServeOrigins.delete(origin);
      cottontail.httpServerStop(native.id);
      return Promise.resolve();
    },
    [Symbol.dispose]() {
      server.stop();
    },
    [Symbol.asyncDispose]() {
      return server.stop();
    },
    reload(nextOptions = {}) {
      activeOptions = { ...activeOptions, ...nextOptions };
    },
    async fetch(input, init = {}) {
      const request = input instanceof Request ? input : new Request(String(input), init);
      let response;
      try {
        response = await runServeHandler(activeOptions, request, server);
      } catch (error) {
        if (typeof activeOptions.error !== "function") throw error;
        response = await serveErrorResponse(activeOptions, error);
      }
      response.url = request.url;
      return response;
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

  for (const origin of originKeys) activeServeOrigins.set(origin, server);

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
    if (!response.headers.has("date")) response.headers.set("Date", cachedServeDateHeader());
    const body = responseBody(response);
    const status = statusOverride ?? response.status;
    const headers = headersToText(response.headers);
    if (isPromiseLike(body)) {
      return body.then(
        (resolvedBody) => respond(item, status, headers, resolvedBody),
        (error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`error: ${message}`);
          respond(item, status, headers, arrayBufferFromBytes(new Uint8Array(0)));
        },
      );
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
    const requestInit = {
      method: item.method,
      headers: parseHeadersText(item.headersText),
    };
    if (String(item.method).toUpperCase() !== "GET" && String(item.method).toUpperCase() !== "HEAD") {
      requestInit.body = item.body;
    }
    const requestUrl = /^https?:\/\//i.test(String(item.url)) ? String(item.url) : `${requestOrigin}${item.url}`;
    const request = new Request(requestUrl, requestInit);
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

function tarOctalField(value, length) {
  const text = Math.max(0, Number(value) || 0).toString(8).slice(-(length - 1));
  return `${text.padStart(length - 1, "0")}\0`;
}

function tarChecksumField(value) {
  return `${Math.max(0, Number(value) || 0).toString(8).slice(-6).padStart(6, "0")}\0 `;
}

function safeArchivePath(path) {
  const parts = [];
  for (const part of String(path).replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error(`Unsafe archive path: ${path}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const normalized = parts.join("/");
  if (!normalized) {
    throw new Error(`Unsafe archive path: ${path}`);
  }
  return normalized;
}

async function archiveEntryBytes(value) {
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return bytesFromData(value);
}

function snapshotArchiveEntryValue(value) {
  if (value instanceof Blob) return value;
  return new Uint8Array(bytesFromData(value));
}

async function tarBytesFromEntries(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  for (const [entryName, entryValue] of entries) {
    const name = safeArchivePath(entryName);
    const data = await archiveEntryBytes(entryValue);
    const header = new Uint8Array(512);
    const nameBytes = encoder.encode(name);
    if (nameBytes.byteLength > 100) throw new Error(`Archive path is too long: ${name}`);
    header.set(nameBytes, 0);
    header.set(encoder.encode(tarOctalField(0o644, 8)), 100);
    header.set(encoder.encode(tarOctalField(0, 8)), 108);
    header.set(encoder.encode(tarOctalField(0, 8)), 116);
    header.set(encoder.encode(tarOctalField(data.byteLength, 12)), 124);
    header.set(encoder.encode(tarOctalField(Math.floor(Date.now() / 1000), 12)), 136);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.set(encoder.encode(tarChecksumField(checksum)), 148);
    chunks.push(header, data);
    const padding = (512 - (data.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return concatManyBuffers(chunks);
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

function isTarZeroBlock(bytes, offset) {
  for (let index = 0; index < 512; index += 1) {
    if (bytes[offset + index] !== 0) return false;
  }
  return true;
}

function archivePayloadBytes(bytes) {
  const data = asBuffer(bytes);
  if (data.byteLength >= 2 && data[0] === 0x1f && data[1] === 0x8b) return asBuffer(zlib.gunzipSync(data));
  return data;
}

function archiveGlobRegExp(pattern) {
  const text = String(pattern).replace(/\\/g, "/");
  if (text === "**") return /^.*$/;
  let source = "^";
  for (let index = 0; index < text.length;) {
    if (text.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (text.startsWith("**", index)) {
      source += ".*";
      index += 2;
      continue;
    }
    const char = text[index++];
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function archiveGlobFilter(glob = undefined) {
  if (glob === undefined) return () => true;
  const patterns = Array.isArray(glob) ? glob : [glob];
  if (patterns.some((pattern) => typeof pattern !== "string")) throw new TypeError("Archive glob patterns must be strings");
  const positive = patterns.filter((pattern) => !pattern.startsWith("!")).map(archiveGlobRegExp);
  const negative = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => archiveGlobRegExp(pattern.slice(1)));
  return (path) => {
    const included = positive.length === 0 || positive.some((pattern) => pattern.test(path));
    return included && !negative.some((pattern) => pattern.test(path));
  };
}

export class Archive {
  constructor(input, options = {}) {
    if (arguments.length === 0 || input == null) throw new TypeError("Bun.Archive requires input");
    if (typeof input !== "object" && typeof input !== "string") throw new TypeError("Bun.Archive input must be an object, Blob, ArrayBuffer, or Uint8Array");
    if (options?.compress === "gzip" && options.level != null) {
      const level = Number(options.level);
      if (!Number.isInteger(level) || level < 1 || level > 12) throw new RangeError("gzip level must be between 1 and 12");
    }
    this._blob = input instanceof Blob ? input : null;
    this._entries = input && typeof input === "object" && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer) && !(input instanceof Blob)
      ? Object.entries(input).map(([name, value]) => [name, snapshotArchiveEntryValue(value)])
      : null;
    this._bytes = this._entries || this._blob ? null : new Uint8Array(bytesFromData(input));
    this._options = options ?? {};
    this._files = null;
  }
  static async write(destination, input, options = undefined) {
    if (arguments.length < 2) throw new TypeError("Bun.Archive.write requires a destination and input");
    const archive = input instanceof Archive ? input : new Archive(input, options ?? {});
    return write(destination, await archive.bytes(), { createPath: true });
  }
  async _ensureBytes() {
    if (this._bytes != null) return this._bytes;
    if (this._blob) {
      this._bytes = new Uint8Array(await this._blob.arrayBuffer());
      return this._bytes;
    }
    let bytes = await tarBytesFromEntries(this._entries ?? []);
    if (this._options.compress === "gzip") {
      bytes = zlib.gzipSync(bytes, { level: Math.max(1, Math.min(9, Number(this._options.level ?? 6))) });
    }
    this._bytes = bytes;
    return bytes;
  }
  _parseFiles() {
    if (this._files) return this._files;
    const files = new Map();
    const bytes = archivePayloadBytes(this._bytes);
    if (bytes.length > 0 && bytes.length % 512 !== 0) throw new Error("Invalid tar archive");
    for (let offset = 0; offset + 512 <= bytes.length;) {
      if (isTarZeroBlock(bytes, offset)) break;
      const name = tarString(bytes, offset, 100);
      const prefix = tarString(bytes, offset + 345, 155);
      const size = tarOctal(bytes, offset + 124, 12);
      const mtime = tarOctal(bytes, offset + 136, 12);
      const typeflag = String.fromCharCode(bytes[offset + 156] || 0);
      if (!name && size === 0) break;
      const magic = tarString(bytes, offset + 257, 6);
      if (magic && magic !== "ustar") throw new Error("Invalid tar archive");
      let path;
      try {
        path = safeArchivePath(prefix ? `${prefix}/${name}` : name);
      } catch {
        offset += 512 + Math.ceil(size / 512) * 512;
        continue;
      }
      const dataOffset = offset + 512;
      if (dataOffset + size > bytes.length) throw new Error("Invalid tar archive");
      if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
        const fileBytes = bytes.slice(dataOffset, dataOffset + size);
        const FileCtor = globalThis.File;
        files.set(path, typeof FileCtor === "function"
          ? new FileCtor([fileBytes], path, { lastModified: mtime > 0 ? mtime * 1000 : Date.now(), type: guessMimeType(path) })
          : new ArchiveFile(path, fileBytes));
      }
      offset = dataOffset + Math.ceil(size / 512) * 512;
    }
    this._files = files;
    return files;
  }
  async files(glob = undefined) {
    if (glob !== undefined && typeof glob !== "string" && !Array.isArray(glob)) throw new TypeError("Archive.files glob must be a string or array");
    await this._ensureBytes();
    const filter = archiveGlobFilter(glob);
    return new Map([...this._parseFiles()].filter(([path]) => filter(path)));
  }
  async extract(destination, options = undefined) {
    if (arguments.length === 0 || destination == null) throw new TypeError("Archive.extract requires a destination path");
    if (typeof destination !== "string") throw new TypeError("Archive.extract destination must be a string");
    const bytes = await this._ensureBytes();
    const dest = String(destination);
    cottontail.mkdirSync(dest, true);
    const extractWithParser = async () => {
      const files = await this.files(options?.glob);
      for (const [path, file] of files) {
        const outPath = pathJoin(dest, path);
        cottontail.mkdirSync(pathDirname(outPath), true);
        cottontail.writeFile(outPath, asBuffer(await file.arrayBuffer()));
      }
      return files.size;
    };
    if (options?.glob !== undefined) return extractWithParser();
    const archiveTmpRoot = tmpRoot("archive");
    cottontail.mkdirSync(archiveTmpRoot, true);
    const tarPath = pathJoin(archiveTmpRoot, `archive-${Date.now()}-${Math.floor(Math.random() * 1000000)}.tar`);
    cottontail.writeFile(tarPath, bytes);
    const result = cottontail.spawnSync("tar", ["-xf", tarPath, "-C", dest], { stdio: "pipe" });
    cottontail.unlinkSync(tarPath);
    if (result.status !== 0) {
      return extractWithParser();
    }
    try {
      return this._parseFiles().size;
    } catch {
      return 0;
    }
  }
  async bytes() {
    return new Uint8Array(await this._ensureBytes());
  }
  async blob() {
    return new Blob([await this.bytes()], { type: this._options.compress === "gzip" ? "application/gzip" : "application/x-tar" });
  }
}

function guessMimeType(path) {
  const lower = String(path).toLowerCase();
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".txt")) return "text/plain;charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
  if (lower.endsWith(".css")) return "text/css;charset=utf-8";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

export function file(path, options = undefined) {
  const isFd = typeof path === "number";
  const filePath = isFd ? Number(path) : String(path);
  let cachedBytes = null;
  let cachedMtime = -1;
  let cachedSize = -1;
  const currentStat = () => isFd ? cottontail.fstatSync(filePath) : cottontail.statSync(filePath, true);
  const invalidateCache = () => {
    cachedBytes = null;
    cachedMtime = -1;
    cachedSize = -1;
  };
  const readBytes = () => {
    const stat = currentStat();
    const mtime = Number(stat?.mtimeMs ?? 0);
    const size = Number(stat?.size ?? 0);
    if (cachedBytes && cachedMtime === mtime && cachedSize === size) return cachedBytes;
    cachedBytes = new Uint8Array(cottontail.readFileBuffer(String(filePath)));
    cachedMtime = mtime;
    cachedSize = size;
    return cachedBytes;
  };
  const result = {
    name: isFd ? "" : String(filePath),
    fd: isFd ? filePath : undefined,
    type: options?.type != null ? String(options.type) : (isFd ? "" : guessMimeType(filePath)),
    [Symbol.for("nodejs.util.inspect.custom")]() {
      return isFd ? `FileRef (fd: ${filePath}) {}` : `FileRef ("${String(filePath)}") {}`;
    },
    get size() {
      if (isFd) {
        try { return Number(cottontail.fstatSync(filePath)?.size ?? 0); } catch { return 0; }
      }
      try { return Number(cottontail.statSync(filePath, true)?.size ?? 0); } catch { return 0; }
    },
    get lastModified() {
      try {
        const result = currentStat();
        return Number(result?.mtimeMs ?? 0);
      } catch {
        return 0;
      }
    },
    async exists() {
      if (isFd) {
        try { return cottontail.fstatSync(filePath)?.isFile === true; } catch { return false; }
      }
      try {
        return cottontail.statSync(filePath, true)?.isFile === true;
      } catch {
        return false;
      }
    },
    async stat() {
      try {
        return currentStat();
      } catch (error) {
        throw makeBunWriteError(error, filePath, "stat");
      }
    },
    async delete() {
      if (isFd) throw new TypeError("Cannot delete a file descriptor");
      try {
        cottontail.unlinkSync(filePath);
      } catch (error) {
        throw makeBunWriteError(error, filePath, "unlink");
      }
    },
    async text() {
      if (isFd) throw new TypeError("Cannot read Bun.file(fd) as text");
      try {
        return new TextDecoder().decode(readBytes());
      } catch (error) {
        throw makeBunWriteError(error, filePath, "open");
      }
    },
    async json() {
      if (isFd) throw new TypeError("Cannot read Bun.file(fd) as JSON");
      try {
        return JSON.parse(new TextDecoder().decode(readBytes()));
      } catch (error) {
        if (error instanceof SyntaxError) throw error;
        throw makeBunWriteError(error, filePath, "open");
      }
    },
    async bytes() {
      if (isFd) throw new TypeError("Cannot read Bun.file(fd) as bytes");
      try {
        return readBytes();
      } catch (error) {
        throw makeBunWriteError(error, filePath, "open");
      }
    },
    async arrayBuffer() {
      if (isFd) throw new TypeError("Cannot read Bun.file(fd) as an ArrayBuffer");
      try {
        return arrayBufferFromBytes(readBytes());
      } catch (error) {
        throw makeBunWriteError(error, filePath, "open");
      }
    },
    stream(chunkSize = 64 * 1024) {
      const size = Math.max(1, Number(chunkSize) || 64 * 1024);
      let stat = null;
      try { stat = currentStat(); } catch {}
      const isFifo = stat?.isFIFO === true || (Number(stat?.mode ?? 0) & 0o170000) === 0o010000;
      if (!isFd && isFifo && cottontail.platform() !== "win32") {
        return spawn(["cat", String(filePath)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }).stdout;
      }
      if (isFd) {
        return bodyReadableStream((async function* () {
          for (;;) {
            const result = cottontail.readFd(filePath, size);
            if (result == null) {
              await new Promise((resolve) => setTimeout(resolve, 1));
              continue;
            }
            const chunk = asBuffer(result);
            if (chunk.byteLength === 0) return;
            yield chunk;
          }
        })());
      }
      let bytes;
      try {
        bytes = readBytes();
      } catch (error) {
        throw makeBunWriteError(error, filePath, "open");
      }
      return bodyReadableStream((async function* () {
        for (let offset = 0; offset < bytes.byteLength; offset += size) {
          yield bytes.slice(offset, Math.min(bytes.byteLength, offset + size));
        }
      })());
    },
    slice(start = 0, end = this.size, type = "") {
      if (isFd) throw new TypeError("Cannot slice Bun.file(fd)");
      const bytes = readBytes();
      const rangeStart = Math.max(0, Number(start) || 0);
      const rangeEnd = Math.max(rangeStart, Number(end) || 0);
      const blob = new Blob([bytes.slice(rangeStart, rangeEnd)], { type: String(type || this.type || "") });
      Object.defineProperties(blob, {
        _bunFilePath: { value: String(filePath), configurable: true },
        _bunFileStart: { value: rangeStart, configurable: true },
        _bunFileEnd: { value: rangeEnd, configurable: true },
      });
      return blob;
    },
    writer(writerOptions = {}) {
      const chunks = [];
      let ended = false;
      let ownedFd = null;
      let totalWritten = 0;
      let pendingBytes = 0;
      const highWaterMark = Math.max(1, Number(writerOptions?.highWaterMark) || 64 * 1024);
      const flushPending = () => {
        if (chunks.length === 0) return 0;
        const bytes = concatManyBuffers(chunks.splice(0));
        pendingBytes = 0;
        const fd = isFd ? filePath : (ownedFd ??= cottontail.openFd(filePath, "w"));
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = Number(cottontail.fdWriteAt(fd, bytes, offset, bytes.byteLength - offset, null));
          if (written <= 0) throw new Error("FileSink write failed");
          offset += written;
        }
        totalWritten += offset;
        invalidateCache();
        return offset;
      };
      return {
        write(chunk) {
          if (ended) throw new Error("FileSink is closed");
          const bytes = asBuffer(chunk);
          chunks.push(bytes);
          pendingBytes += bytes.byteLength;
          if (pendingBytes >= highWaterMark) flushPending();
          return bytes.byteLength;
        },
        flush() {
          if (ended) return Promise.resolve(0);
          return Promise.resolve(flushPending());
        },
        end(chunk) {
          if (ended) return Promise.resolve(0);
          if (chunk != null) this.write(chunk);
          ended = true;
          try {
            flushPending();
          } finally {
            if (ownedFd != null) {
              cottontail.closeFd(ownedFd);
              ownedFd = null;
            }
          }
          return Promise.resolve(totalWritten);
        },
      };
    },
  };
  if (!isFd) {
    Object.defineProperty(result, "_bunFilePath", {
      value: String(filePath),
      configurable: true,
    });
  }
  return result;
}

function pathDirname(path) {
  const text = String(path);
  const slash = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (slash < 0) return ".";
  if (slash === 0) return text.slice(0, 1);
  return text.slice(0, slash);
}

function makeBunWriteError(error, path, syscall = "open") {
  const normalizedPath = String(path);
  const source = String(error?.message ?? error ?? "");
  const isNoEntry = source.includes("No such file or directory") || source.includes("ENOENT") || source.includes("FileNotFound");
  const code = isNoEntry ? "ENOENT" : String(error?.code ?? "EIO");
  const reason = isNoEntry ? "no such file or directory" : source || code;
  const out = new Error(`${code}: ${reason}, ${syscall} '${normalizedPath}'`);
  out.code = code;
  out.errno = code === "ENOENT" ? -2 : -5;
  out.syscall = syscall;
  out.path = normalizedPath;
  return out;
}

function pathFromBunWriteDestination(destination) {
  if (typeof destination === "string") return destination;
  if (destination && typeof destination === "object" && destination.protocol === "file:" && typeof destination.pathname === "string") {
    return decodeURIComponent(destination.pathname);
  }
  if (destination instanceof ArrayBuffer || ArrayBuffer.isView(destination)) {
    return new TextDecoder().decode(asBuffer(destination));
  }
  if (isBunFileLike(destination) && typeof destination.name === "string") return destination.name;
  return String(destination);
}

async function bytesFromBunWriteSource(data) {
  if (data == null) return asBuffer("");
  if (data instanceof Archive) return asBuffer(await data.bytes());
  if (typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return asBuffer(data);
  if (isBunFileLike(data) || data instanceof Blob || data instanceof Response) {
    return asBuffer(await data.arrayBuffer());
  }
  if (data && typeof data.arrayBuffer === "function") return asBuffer(await data.arrayBuffer());
  if (data && typeof data.getReader === "function") return readableStreamToArrayBuffer(data).then(asBuffer);
  return asBuffer(String(data));
}

function writeBytesToProcessStream(stream, bytes) {
  if (stream && typeof stream.write === "function") {
    stream.write(bytes);
    return bytes.byteLength;
  }
  if (stream && typeof stream.fd === "number") {
    return cottontail.fdWrite(stream.fd, bytes);
  }
  return null;
}

function writeBytesToFileRange(destination, bytes) {
  if (!destination || typeof destination !== "object" ||
      typeof destination._bunFilePath !== "string" ||
      typeof destination._bunFileStart !== "number" ||
      typeof destination._bunFileEnd !== "number") return null;
  const start = Math.max(0, Number(destination._bunFileStart) || 0);
  const end = Math.max(start, Number(destination._bunFileEnd) || start);
  const limited = bytes.subarray(0, Math.max(0, end - start));
  if (start === 0) {
    cottontail.writeFile(destination._bunFilePath, limited);
    return limited.byteLength;
  }

  const existing = asBuffer(cottontail.readFileBuffer(destination._bunFilePath));
  const nextLength = Math.max(existing.byteLength, start + limited.byteLength);
  const next = new Uint8Array(nextLength);
  next.set(existing.subarray(0, Math.min(existing.byteLength, nextLength)), 0);
  next.set(limited, start);
  cottontail.writeFile(destination._bunFilePath, next);
  return limited.byteLength;
}

export async function write(destination, data, options = undefined) {
  const bytes = await bytesFromBunWriteSource(data);
  const streamWritten = writeBytesToProcessStream(destination, bytes);
  if (streamWritten != null) return streamWritten;
  const rangeWritten = writeBytesToFileRange(destination, bytes);
  if (rangeWritten != null) return rangeWritten;

  if (typeof destination === "number") {
    return cottontail.fdWrite(destination, bytes);
  }
  if (isBunFileLike(destination) && typeof destination.fd === "number") {
    if (options?.createPath === true) throw new Error("Cannot create a directory for a file descriptor");
    return cottontail.fdWrite(destination.fd, bytes);
  }

  const path = pathFromBunWriteDestination(destination);
  if (options?.createPath !== false) {
    try {
      cottontail.mkdirSync(pathDirname(path), true);
    } catch {}
  }

  try {
    cottontail.writeFile(path, bytes);
    return bytes.byteLength;
  } catch (error) {
    throw makeBunWriteError(error, path, "open");
  }
}

export class ArrayBufferSink {
  constructor() {
    this._chunks = [];
    this._ended = false;
    this._asUint8Array = false;
    this._streaming = false;
  }

  start(options = {}) {
    this._chunks = [];
    this._ended = false;
    this._asUint8Array = Boolean(options.asUint8Array);
    this._streaming = Boolean(options.stream);
    return this;
  }

  write(chunk) {
    if (this._ended) throw new Error("ArrayBufferSink is closed");
    const bytes = typeof chunk === "string" ? asBuffer(chunk) : asBuffer(chunk);
    this._chunks.push(bytes);
    return bytes.byteLength;
  }

  flush() {
    if (!this._streaming) return 0;
    const bytes = concatManyBuffers(this._chunks.splice(0));
    return this._asUint8Array ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  end(chunk = undefined) {
    if (chunk != null) this.write(chunk);
    this._ended = true;
    const bytes = concatManyBuffers(this._chunks);
    if (this._asUint8Array) return bytes;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
}

function isBunFileLike(value) {
  return value && typeof value === "object" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.text === "function" &&
    typeof value.exists === "function" &&
    typeof value.writer === "function";
}

function normalizeCryptoHasherAlgorithm(algorithm) {
  const normalized = String(algorithm).toLowerCase().replace(/[_/]/g, "-");
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (compact === "sha128" || compact === "sha1") return "sha1";
  if (compact === "sha224") return "sha224";
  if (compact === "sha256") return "sha256";
  if (compact === "sha384") return "sha384";
  if (compact === "sha512") return "sha512";
  if (compact === "sha512224") return "sha512-224";
  if (compact === "sha512256") return "sha512-256";
  if (compact === "ripemd160" || compact === "rmd160") return "ripemd160";
  if (compact === "blake2b256") return "blake2b256";
  if (compact === "blake2b512") return "blake2b512";
  if (compact === "blake2s256") return "blake2s256";
  if (compact === "md4") return "md4";
  if (compact === "md5") return "md5";
  if (compact.startsWith("sha3")) return `sha3-${compact.slice(4)}`;
  if (compact === "shake128" || compact === "shake256") return compact;
  return normalized;
}

function bunHashName(algorithm) {
  if (algorithm === "blake2b256") return "blake2b512";
  return algorithm;
}

function cryptoHasherBytes(data, encoding = undefined) {
  if (arguments.length === 0 || data == null) throw new TypeError("CryptoHasher update requires data");
  if (isBunFileLike(data)) throw new TypeError("Bun.file is not supported by CryptoHasher");
  return encoding ? globalThis.Buffer.from(String(data), encoding) : asBuffer(data);
}

function encodeCryptoDigest(bytes, encoding) {
  if (encoding == null || encoding === "buffer") return globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : bytes;
  if (encoding === "base64url") {
    const base64 = globalThis.Buffer?.from ? globalThis.Buffer.from(bytes).toString("base64") : btoa(String.fromCharCode(...bytes));
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  return (globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : asBuffer(bytes)).toString(encoding);
}

function nodeDigest(algorithm, chunks, encoding = undefined, key = undefined) {
  const hash = key === undefined ? createHash(bunHashName(algorithm)) : createHmac(bunHashName(algorithm), key);
  for (const chunk of chunks) hash.update(chunk);
  let output = hash.digest();
  if (algorithm === "blake2b256") output = output.subarray(0, 32);
  return encodeCryptoDigest(output, encoding);
}

export class CryptoHasher {
  constructor(algorithm, key = undefined) {
    if (algorithm == null) throw new TypeError("Expected an algorithm name as an argument");
    this.algorithm = normalizeCryptoHasherAlgorithm(algorithm);
    this._key = key === undefined ? undefined : cryptoHasherBytes(key);
    if (this._key !== undefined && !["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-224", "sha512-256", "blake2b512"].includes(this.algorithm)) {
      throw new Error(`${this.algorithm} is not supported`);
    }
    this._chunks = [];
    this._finished = false;
  }

  get byteLength() {
    if (this._finished) throw new Error("CryptoHasher hasher already digested");
    return {
      md4: 16,
      md5: 16,
      ripemd160: 20,
      sha1: 20,
      sha224: 28,
      sha256: 32,
      sha384: 48,
      sha512: 64,
      "sha512-224": 28,
      "sha512-256": 32,
      "sha3-224": 28,
      "sha3-256": 32,
      "sha3-384": 48,
      "sha3-512": 64,
      shake128: 16,
      shake256: 32,
      blake2b256: 32,
      blake2b512: 64,
      blake2s256: 32,
    }[this.algorithm] ?? 0;
  }

  update(data, encoding = undefined) {
    if (this._finished) throw new Error("Digest already called");
    this._chunks.push(cryptoHasherBytes(data, encoding));
    return this;
  }

  digest(encoding = undefined) {
    if (this._finished) throw new Error("Digest already called");
    this._finished = true;
    return nodeDigest(this.algorithm, this._chunks, encoding, this._key);
  }

  copy() {
    if (this._finished) throw new Error("CryptoHasher hasher already digested");
    const next = new CryptoHasher(this.algorithm);
    next._chunks = this._chunks.map((chunk) => asBuffer(chunk));
    next._key = this._key == null ? undefined : asBuffer(this._key);
    return next;
  }

  static hash(algorithm, data, encoding = undefined) {
    const hasher = new CryptoHasher(algorithm);
    return hasher.update(data).digest(encoding);
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
      if (this._hasher._finished) throw new Error(`${this.constructor.name} hasher already digested, create a new instance to update`);
      this._hasher.update(data, encoding);
      return this;
    }
    digest(encoding = undefined) {
      if (this._hasher._finished) throw new Error(`${this.constructor.name} hasher already digested, create a new instance to digest again`);
      return this._hasher.digest(encoding);
    }
    static hash(data, encoding = undefined) {
      return CryptoHasher.hash(algorithm, data, encoding);
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

export function concatArrayBuffers(buffers, maxLength = Infinity, asUint8Array = false) {
  if (typeof maxLength === "function") {
    const bytes = concatManyBuffers(Array.from(buffers ?? []));
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return maxLength === ArrayBuffer ? arrayBuffer : new maxLength(arrayBuffer);
  }
  const chunks = Array.from(buffers ?? []).map(asBuffer);
  const limit = Math.max(0, Math.min(Number(maxLength), chunks.reduce((total, chunk) => total + chunk.byteLength, 0)));
  const size = Number.isFinite(limit) ? limit : chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  let out;
  try {
    out = new Uint8Array(size);
  } catch {
    throw new RangeError(`Failed to allocate ${size} bytes`);
  }
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.byteLength) break;
    const next = chunk.subarray(0, out.byteLength - offset);
    out.set(next, offset);
    offset += next.byteLength;
  }
  return asUint8Array ? out : out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
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
export function jest(_source = undefined) {
  return bunTestModule.default ?? bunTestModule;
}
Object.assign(jest, bunJest);

export function sleep(ms) {
  const duration = Number(ms);
  if (!(duration > 0)) return Promise.resolve();
  const maxTimeout = 2 ** 31 - 1;
  return new Promise((resolve) => setTimeout(resolve, Number.isFinite(duration) ? Math.min(duration, maxTimeout) : maxTimeout));
}

export function sleepSync(ms) {
  if (arguments.length === 0 || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    throw new TypeError("Bun.sleepSync expects a non-negative finite number");
  }
  cottontail.sleep(ms);
}

export function nanoseconds() {
  return globalThis.process?.hrtime?.bigint?.() ?? BigInt(Math.floor((performance?.now?.() ?? Date.now()) * 1_000_000));
}

export function gc() {
  cottontail.gc?.();
  cottontail.drainJobs?.();
}

export function inspect(value, options = undefined) {
  return nodeInspect(value, options);
}

inspect.table = function table(value, properties = undefined, options = undefined) {
  if (arguments.length === 0 || value == null) return "";
  if (typeof value !== "object" && typeof value !== "function") return "";
  const selected = Array.isArray(properties)
    ? Object.fromEntries(Array.from(properties).map((key) => [key, value?.[key]]))
    : value;
  const tableOptions = Array.isArray(properties) ? options : properties;
  return nodeInspect(selected, tableOptions);
};

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
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
  return escaped;
}

export function stripANSI(value) {
  const text = String(value);
  if (text.indexOf("\x1b") === -1 && text.indexOf("\x9b") === -1) return text;
  return stripVTControlCharacters(text);
}

function isCombiningCodePoint(codePoint) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x0483 && codePoint <= 0x0489) ||
    (codePoint >= 0x0591 && codePoint <= 0x05bd) ||
    codePoint === 0x05bf ||
    (codePoint >= 0x05c1 && codePoint <= 0x05c2) ||
    (codePoint >= 0x05c4 && codePoint <= 0x05c5) ||
    codePoint === 0x05c7 ||
    (codePoint >= 0x0610 && codePoint <= 0x061a) ||
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    codePoint === 0x0670 ||
    (codePoint >= 0x06d6 && codePoint <= 0x06dc) ||
    (codePoint >= 0x06df && codePoint <= 0x06e4) ||
    (codePoint >= 0x06e7 && codePoint <= 0x06e8) ||
    (codePoint >= 0x06ea && codePoint <= 0x06ed) ||
    codePoint === 0x0711 ||
    (codePoint >= 0x0730 && codePoint <= 0x074a) ||
    (codePoint >= 0x07a6 && codePoint <= 0x07b0) ||
    (codePoint >= 0x07eb && codePoint <= 0x07f3) ||
    codePoint === 0x07fd ||
    (codePoint >= 0x0816 && codePoint <= 0x0819) ||
    (codePoint >= 0x081b && codePoint <= 0x0823) ||
    (codePoint >= 0x0825 && codePoint <= 0x0827) ||
    (codePoint >= 0x0829 && codePoint <= 0x082d) ||
    (codePoint >= 0x0859 && codePoint <= 0x085b) ||
    (codePoint >= 0x0898 && codePoint <= 0x089f) ||
    (codePoint >= 0x08ca && codePoint <= 0x0902) ||
    codePoint === 0x093c ||
    codePoint === 0x093f ||
    (codePoint >= 0x0941 && codePoint <= 0x0948) ||
    codePoint === 0x094d ||
    (codePoint >= 0x0951 && codePoint <= 0x0957) ||
    (codePoint >= 0x0962 && codePoint <= 0x0963) ||
    codePoint === 0x09bc ||
    (codePoint >= 0x09c1 && codePoint <= 0x09c4) ||
    codePoint === 0x09cd ||
    codePoint === 0x0bcd ||
    (codePoint >= 0x0c3e && codePoint <= 0x0c40) ||
    (codePoint >= 0x0c46 && codePoint <= 0x0c48) ||
    (codePoint >= 0x0c4a && codePoint <= 0x0c4d) ||
    (codePoint >= 0x0d41 && codePoint <= 0x0d44) ||
    codePoint === 0x0d4d ||
    codePoint === 0x0e31 ||
    (codePoint >= 0x0e34 && codePoint <= 0x0e3a) ||
    (codePoint >= 0x0e47 && codePoint <= 0x0e4e) ||
    codePoint === 0x0eb1 ||
    (codePoint >= 0x0eb4 && codePoint <= 0x0ebc) ||
    (codePoint >= 0x0ec8 && codePoint <= 0x0ecd) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isZeroWidthCodePoint(codePoint) {
  return (
    codePoint === 0x00ad ||
    codePoint === 0x034f ||
    codePoint === 0x061c ||
    (codePoint >= 0x0600 && codePoint <= 0x0605) ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    codePoint === 0x08e2 ||
    (codePoint >= 0x180b && codePoint <= 0x180f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) ||
    (codePoint >= 0x2066 && codePoint <= 0x206f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
    isCombiningCodePoint(codePoint)
  );
}

function isFullwidthCodePoint(codePoint) {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

function isRegionalIndicator(codePoint) {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isEmojiModifier(codePoint) {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isEmojiCodePoint(codePoint) {
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    codePoint === 0x231a ||
    codePoint === 0x231b ||
    codePoint === 0x2328 ||
    codePoint === 0x23cf
  );
}

function isEmojiVariationBase(codePoint) {
  return (
    codePoint === 0x00a9 ||
    codePoint === 0x00ae ||
    codePoint === 0x203c ||
    codePoint === 0x2049 ||
    codePoint === 0x2122 ||
    codePoint === 0x2139 ||
    (codePoint >= 0x2194 && codePoint <= 0x21aa) ||
    (codePoint >= 0x231a && codePoint <= 0x231b) ||
    codePoint === 0x2328 ||
    codePoint === 0x23cf ||
    (codePoint >= 0x23e9 && codePoint <= 0x23f3) ||
    (codePoint >= 0x23f8 && codePoint <= 0x23fa) ||
    codePoint === 0x24c2 ||
    (codePoint >= 0x25aa && codePoint <= 0x25ab) ||
    codePoint === 0x25b6 ||
    codePoint === 0x25c0 ||
    (codePoint >= 0x25fb && codePoint <= 0x25fe) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2934 && codePoint <= 0x2935) ||
    (codePoint >= 0x2b05 && codePoint <= 0x2b55) ||
    codePoint === 0x3030 ||
    codePoint === 0x303d ||
    codePoint === 0x3297 ||
    codePoint === 0x3299
  );
}

function isAmbiguousWideCodePoint(codePoint) {
  return codePoint === 0x00b1 || codePoint === 0x201c || codePoint === 0x2605 || codePoint === 0x26e3;
}

function codePointLength(codePoint) {
  return codePoint > 0xffff ? 2 : 1;
}

function skipAnsiSequence(text, index) {
  if (text.charCodeAt(index) !== 0x1b) return index;
  const next = text.charCodeAt(index + 1);
  if (next === 0x5b) {
    let cursor = index + 2;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) return cursor + 1;
      cursor += 1;
    }
    return text.length;
  }
  if (next === 0x5d) {
    let cursor = index + 2;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code === 0x07) return cursor + 1;
      if (code === 0x1b && text.charCodeAt(cursor + 1) === 0x5c) return cursor + 2;
      cursor += 1;
    }
    return text.length;
  }
  return index + 1;
}

function consumeEmojiSequence(text, index) {
  let cursor = index + codePointLength(text.codePointAt(index));
  for (;;) {
    let next = text.codePointAt(cursor);
    while (next === 0xfe0f || next === 0xfe0e || isEmojiModifier(next) || (next >= 0xe0000 && next <= 0xe007f)) {
      cursor += codePointLength(next);
      next = text.codePointAt(cursor);
    }
    if (next !== 0x200d) return cursor;
    const afterJoiner = text.codePointAt(cursor + 1);
    if (afterJoiner == null) return cursor + 1;
    cursor += 1 + codePointLength(afterJoiner);
  }
}

export function stringWidth(value, options = undefined) {
  const text = String(value ?? "");
  const countAnsiEscapeCodes = options?.countAnsiEscapeCodes === true;
  const ambiguousIsNarrow = options?.ambiguousIsNarrow !== false;
  let width = 0;
  for (let index = 0; index < text.length;) {
    const ansiEnd = countAnsiEscapeCodes ? index : skipAnsiSequence(text, index);
    if (ansiEnd !== index) {
      index = ansiEnd;
      continue;
    }

    const codePoint = text.codePointAt(index);
    const length = codePointLength(codePoint);
    const next = text.codePointAt(index + length);
    const afterNext = text.codePointAt(index + length + codePointLength(next ?? 0));

    if (codePoint === 0x1b || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || isZeroWidthCodePoint(codePoint)) {
      index += length;
      continue;
    }

    if ((codePoint >= 0x30 && codePoint <= 0x39) || codePoint === 0x23 || codePoint === 0x2a) {
      if ((next === 0xfe0f && afterNext === 0x20e3) || next === 0x20e3) {
        width += 2;
        index += length + (next === 0xfe0f ? 2 : 1);
        continue;
      }
    }

    if (isRegionalIndicator(codePoint)) {
      let count = 0;
      while (isRegionalIndicator(text.codePointAt(index))) {
        count += 1;
        index += 2;
      }
      width += Math.floor(count / 2) * 2 + (count % 2);
      continue;
    }

    if (next === 0xfe0e && isEmojiVariationBase(codePoint)) {
      width += isFullwidthCodePoint(codePoint) ? 2 : 1;
      index += length + 1;
      continue;
    }

    if (isEmojiCodePoint(codePoint)) {
      width += 2;
      index = consumeEmojiSequence(text, index);
      continue;
    }

    if (next === 0xfe0f && isEmojiVariationBase(codePoint)) {
      width += 2;
      index += length + 1;
      continue;
    }

    width += isFullwidthCodePoint(codePoint) || (!ambiguousIsNarrow && isAmbiguousWideCodePoint(codePoint)) ? 2 : 1;
    index += length;
  }
  return width;
}

export function wrapAnsi(value, columns = 80, options = {}) {
  const input = String(value);
  const columnNumber = Number(columns);
  if (!Number.isFinite(columnNumber) || columnNumber <= 0 || input.length === 0) return input;
  const widthLimit = Math.max(1, Math.floor(columnNumber));
  const hard = options?.hard === true;
  const wordWrap = options?.wordWrap !== false;
  const trim = options?.trim !== false;
  const ambiguousIsNarrow = options?.ambiguousIsNarrow !== false;

  let output = "";
  let rowWidth = 0;
  let simpleForeground = null;
  let simpleBackground = null;
  let activeHyperlink = null;
  let rowForeground = null;
  let rowBackground = null;
  let rowHyperlink = null;
  let trailingAnsi = "";

  const trackSgr = (text) => {
    for (const match of text.matchAll(/\x1b\[([0-9;]*)m/g)) {
      const codes = (match[1] || "0").split(";").map(Number);
      for (const code of codes) {
        if (code === 0) {
          simpleForeground = null;
          simpleBackground = null;
        } else if (code === 39) simpleForeground = null;
        else if (code === 49) simpleBackground = null;
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) simpleForeground = code;
        else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) simpleBackground = code;
      }
    }
    for (const match of text.matchAll(/\x1b\]8;;([^\x07]*)\x07/g)) {
      activeHyperlink = match[1] ? `\x1b]8;;${match[1]}\x07` : null;
    }
  };
  const append = (text) => {
    for (const unit of units(text)) {
      output += unit;
      trackSgr(unit);
      const unitWidth = stringWidth(unit, { ambiguousIsNarrow });
      rowWidth += unitWidth;
      if (unitWidth > 0) {
        rowForeground = simpleForeground;
        rowBackground = simpleBackground;
        rowHyperlink = activeHyperlink;
        trailingAnsi = "";
      } else {
        trailingAnsi += unit;
      }
    }
  };
  const units = (text) => {
    const result = [];
    for (let index = 0; index < text.length;) {
      const ansiEnd = skipAnsiSequence(text, index);
      if (ansiEnd !== index) {
        result.push(text.slice(index, ansiEnd));
        index = ansiEnd;
        continue;
      }
      const codePoint = text.codePointAt(index);
      const length = codePointLength(codePoint);
      result.push(text.slice(index, index + length));
      index += length;
    }
    return result;
  };
  const trimUnits = (text, leading, trailing) => {
    const list = units(text);
    if (leading) {
      let sawContent = false;
      for (let index = 0; index < list.length; index += 1) {
        const unit = list[index];
        if (stringWidth(unit, { ambiguousIsNarrow }) === 0) continue;
        if (!sawContent && /^[ \t]$/.test(unit)) {
          list[index] = "";
          continue;
        }
        sawContent = true;
      }
    }
    if (trailing) {
      let sawContent = false;
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const unit = list[index];
        if (stringWidth(unit, { ambiguousIsNarrow }) === 0) continue;
        if (!sawContent && /^[ \t]$/.test(unit)) {
          list[index] = "";
          continue;
        }
        sawContent = true;
      }
    }
    return list.join("");
  };
  const trimCurrentRowEnd = () => {
    const rowStart = output.lastIndexOf("\n") + 1;
    output = output.slice(0, rowStart) + trimUnits(output.slice(rowStart), false, true);
  };
  const breakLine = () => {
    if (trim) trimCurrentRowEnd();
    const preserveTrailingState = !wordWrap && trailingAnsi.length > 0;
    const breakForeground = preserveTrailingState ? rowForeground : simpleForeground;
    const breakBackground = preserveTrailingState ? rowBackground : simpleBackground;
    const breakHyperlink = preserveTrailingState ? rowHyperlink : activeHyperlink;
    const closeLink = activeHyperlink ? "\x1b]8;;\x07" : "";
    const closeForeground = simpleForeground == null ? "" : "\x1b[39m";
    const closeBackground = simpleBackground == null ? "" : "\x1b[49m";
    const reopenBackground = breakBackground == null ? "" : `\x1b[${breakBackground}m`;
    const reopenForeground = breakForeground == null ? "" : `\x1b[${breakForeground}m`;
    const reopenLink = breakHyperlink ?? "";
    const repeatTrailing = preserveTrailingState && (breakForeground !== simpleForeground || breakBackground !== simpleBackground || breakHyperlink !== activeHyperlink)
      ? trailingAnsi
      : "";
    output += `${closeLink}${closeForeground}${closeBackground}\n${reopenBackground}${reopenForeground}${reopenLink}${repeatTrailing}`;
    rowWidth = 0;
    rowForeground = simpleForeground;
    rowBackground = simpleBackground;
    rowHyperlink = activeHyperlink;
    trailingAnsi = repeatTrailing;
  };
  const appendHard = (word) => {
    for (const unit of units(word)) {
      const unitWidth = stringWidth(unit, { ambiguousIsNarrow });
      if (unitWidth > 0 && rowWidth > 0 && rowWidth + unitWidth > widthLimit) breakLine();
      append(unit);
    }
  };
  const appendCharacterWrapped = (line) => {
    const source = trim ? trimUnits(line, true, true) : line;
    for (const unit of units(source)) {
      const unitWidth = stringWidth(unit, { ambiguousIsNarrow });
      if (unitWidth > 0 && rowWidth > 0 && rowWidth + unitWidth > widthLimit) breakLine();
      if (trim && rowWidth === 0 && /^[ \t]$/.test(unit)) continue;
      append(unit);
    }
    if (trim) trimCurrentRowEnd();
  };
  const appendLine = (line) => {
    const source = trim ? trimUnits(line, true, true) : line;
    if (stringWidth(source, { ambiguousIsNarrow }) <= widthLimit) {
      append(source);
      return;
    }
    const pieces = source.split(/([ \t]+)/);
    let pendingSpace = "";
    for (const piece of pieces) {
      if (!piece) continue;
      if (/^[ \t]+$/.test(piece)) {
        pendingSpace += piece;
        continue;
      }
      const wordWidth = stringWidth(piece, { ambiguousIsNarrow });
      const space = pendingSpace;
      const spaceWidth = stringWidth(space, { ambiguousIsNarrow });
      pendingSpace = "";

      if (rowWidth > 0 && rowWidth + spaceWidth + wordWidth > widthLimit) {
        if (hard && wordWidth > widthLimit && !/\x1b/.test(piece)) {
          if (space && rowWidth + spaceWidth <= widthLimit) append(space);
          appendHard(piece);
          continue;
        }
        if (!trim && space && rowWidth + spaceWidth <= widthLimit) {
          append(space);
          breakLine();
        } else {
          breakLine();
          if (!trim && space) {
            appendHard(space);
            if (rowWidth > 0 && rowWidth + wordWidth > widthLimit) breakLine();
          }
        }
      } else if (space) {
        append(space);
      }

      if (hard && wordWidth > widthLimit - rowWidth) appendHard(piece);
      else append(piece);
    }
    if (!trim && pendingSpace) appendHard(pendingSpace);
  };

  const lines = input.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) breakLine();
    if (wordWrap) appendLine(lines[index]);
    else appendCharacterWrapped(lines[index]);
  }
  return output;
}

export function indexOfLine(value, offset = 0) {
  const bytes = asBuffer(value);
  const startNumber = Number(offset);
  const start = Number.isFinite(startNumber) ? Math.max(0, Math.trunc(startNumber)) : 0;
  for (let index = start; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 10) return index;
  }
  return -1;
}

export function fileURLToPath(value) {
  let href;
  if (typeof value === "string") {
    href = value;
  } else if (value && typeof value.href === "string") {
    href = value.href;
  } else {
    throw new TypeError("The URL must be of scheme file");
  }
  if (!String(href).startsWith("file:")) throw new TypeError("The URL must be of scheme file");
  let pathPart = String(href).slice("file:".length);
  if (pathPart.startsWith("//")) {
    pathPart = pathPart.slice(2);
    const slash = pathPart.indexOf("/");
    const host = slash === -1 ? pathPart : pathPart.slice(0, slash);
    if (host && host !== "localhost") throw new TypeError("File URL host must be localhost or empty");
    pathPart = slash === -1 ? "" : pathPart.slice(slash);
  }
  pathPart = pathPart.split("?")[0].split("#")[0];
  if (!pathPart.startsWith("/")) throw new TypeError("File URL path must be an absolute path");
  return decodeURIComponent(pathPart);
}

export function pathToFileURL(value) {
  const absolute = nodePathResolve(String(value));
  const encoded = absolute.split("/").map((part) => encodeURIComponent(part)).join("/");
  return new URL(`file://${encoded.startsWith("/") ? "" : "/"}${encoded}`);
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

function bunHashValue(algorithm, value, seed = 0n) {
  return BigInt(cottontail.hashValue(algorithm, asBuffer(value), String(seed ?? 0)));
}

const hash64Function = (algorithm) => function (value = "", seed = 0n) {
  if (new.target) throw new TypeError("species is not a constructor");
  return bunHashValue(algorithm, value, seed);
};
const hash32Function = (algorithm) => function (value = "", seed = 0) {
  if (new.target) throw new TypeError("species is not a constructor");
  return Number(bunHashValue(algorithm, value, seed)) >>> 0;
};

export const hash = Object.assign(hash64Function(0), {
  wyhash: hash64Function(0),
  adler32: hash32Function(1),
  crc32: hash32Function(2),
  cityHash32: hash32Function(3),
  cityHash64: hash64Function(4),
  xxHash32: hash32Function(5),
  xxHash64: hash64Function(6),
  xxHash3: hash64Function(7),
  murmur32v3: hash32Function(8),
  murmur32v2: hash32Function(9),
  murmur64v2: hash64Function(10),
  rapidhash: hash64Function(11),
});

function uuidBytesToString(bytes) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let uuidv7LastTimestamp = -1;
let uuidv7Sequence = 0n;

function randomUUIDv7SequenceStart() {
  let value = 0n;
  for (const byte of randomBytes(10)) value = (value << 8n) | BigInt(byte);
  return value & ((1n << 74n) - 1n);
}

export function randomUUIDv7(encoding = "hex", timestampInput = Date.now()) {
  const bytes = new Uint8Array(16);
  const timestamp = timestampInput instanceof Date ? timestampInput.getTime() : Number(timestampInput ?? Date.now());
  if (timestamp === uuidv7LastTimestamp) {
    uuidv7Sequence = (uuidv7Sequence + 1n) & ((1n << 74n) - 1n);
  } else {
    uuidv7LastTimestamp = timestamp;
    uuidv7Sequence = randomUUIDv7SequenceStart();
  }
  bytes[0] = (timestamp / 0x10000000000) & 0xff;
  bytes[1] = (timestamp / 0x100000000) & 0xff;
  bytes[2] = (timestamp / 0x1000000) & 0xff;
  bytes[3] = (timestamp / 0x10000) & 0xff;
  bytes[4] = (timestamp / 0x100) & 0xff;
  bytes[5] = timestamp & 0xff;
  let sequence = uuidv7Sequence;
  for (let index = 15; index >= 6; index -= 1) {
    bytes[index] = Number(sequence & 0xffn);
    sequence >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const format = encoding == null ? "hex" : String(encoding).toLowerCase();
  if (format === "buffer") return globalThis.Buffer.from(bytes);
  if (format === "base64") return globalThis.Buffer.from(bytes).toString("base64");
  if (format === "base64url") return globalThis.Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return uuidBytesToString(bytes);
}

const uuidv5Namespaces = {
  dns: "6ba7b8109dad11d180b400c04fd430c8",
  url: "6ba7b8119dad11d180b400c04fd430c8",
  oid: "6ba7b8129dad11d180b400c04fd430c8",
  x500: "6ba7b8149dad11d180b400c04fd430c8",
};

function uuidv5NamespaceBytes(namespace) {
  if (namespace instanceof ArrayBuffer || ArrayBuffer.isView(namespace)) {
    const bytes = asBuffer(namespace);
    if (bytes.byteLength !== 16) throw new TypeError("Namespace must be exactly 16 bytes");
    return bytes;
  }
  if (typeof namespace !== "string") throw new TypeError("The namespace argument must be a string or BufferSource");
  const alias = uuidv5Namespaces[namespace.toLowerCase()];
  const compact = alias ?? namespace.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact) || (!alias && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(namespace))) {
    throw new TypeError("Invalid UUID format for namespace");
  }
  return new Uint8Array(compact.match(/../g).map((part) => parseInt(part, 16)));
}

export function randomUUIDv5(name, namespace, encoding = "hex") {
  if (arguments.length === 0 || name == null) throw new TypeError("The name argument must be specified");
  if (arguments.length < 2 || namespace == null) throw new TypeError("The namespace argument must be specified");
  const nameBytes = typeof name === "string"
    ? new TextEncoder().encode(name)
    : name instanceof ArrayBuffer || ArrayBuffer.isView(name)
      ? asBuffer(name)
      : null;
  if (nameBytes == null) throw new TypeError("The name argument must be a string or BufferSource");
  const nsBytes = uuidv5NamespaceBytes(namespace);
  const digest = createHash("sha1").update(nsBytes).update(nameBytes).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const bytes = digest.subarray(0, 16);
  const format = String(encoding ?? "hex").toLowerCase();
  if (format === "buffer") return globalThis.Buffer.from(bytes);
  if (format === "base64") return globalThis.Buffer.from(bytes).toString("base64");
  if (format === "base64url") return globalThis.Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  if (format !== "hex") throw new TypeError("Encoding must be one of base64, base64url, hex, or buffer");
  return uuidBytesToString(bytes);
}

export function readableStreamToArray(stream) {
  return newInternalPromise((resolve, reject) => {
    const chunks = [];
    const reader = typeof stream?.getReader === "function" ? stream.getReader() : null;
    if (reader) {
      const finish = (value, error = undefined) => {
        try {
          reader.releaseLock?.();
        } catch {}
        if (error) reject(error);
        else resolve(value);
      };
      const pump = () => {
        let readResult;
        try {
          readResult = reader.read();
        } catch (error) {
          finish(undefined, error);
          return;
        }
        internalThen(readResult, (item) => {
          try {
            if (item.done) {
              finish(chunks);
              return;
            }
            chunks.push(item.value);
            pump();
          } catch (error) {
            finish(undefined, error);
          }
        }, (error) => finish(undefined, error));
      };
      pump();
      return;
    }

    if (typeof stream?.[Symbol.asyncIterator] === "function") {
      const iterator = stream[Symbol.asyncIterator]();
      const pump = () => {
        let nextResult;
        try {
          nextResult = iterator.next();
        } catch (error) {
          reject(error);
          return;
        }
        internalThen(nextResult, (item) => {
          try {
            if (item.done) {
              resolve(chunks);
              return;
            }
            chunks.push(item.value);
            pump();
          } catch (error) {
            reject(error);
          }
        }, reject);
      };
      pump();
      return;
    }

    resolve(chunks);
  });
}

export function readableStreamToBytes(stream) {
  return internalThen(readableStreamToArray(stream), (chunks) => concatManyBuffers(chunks));
}

export function readableStreamToArrayBuffer(stream) {
  suppressUserPromiseThenForInternalAwait();
  return internalThen(readableStreamToBytes(stream), (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function readableStreamToText(stream) {
  return internalThen(readableStreamToBytes(stream), (bytes) => new TextDecoder().decode(bytes));
}

export function readableStreamToJSON(stream) {
  return internalThen(readableStreamToText(stream), (text) => JSON.parse(text));
}

export function readableStreamToBlob(stream) {
  return internalThen(readableStreamToArrayBuffer(stream), (buffer) => new Blob([buffer]));
}

function invalidReadableStreamThis(method) {
  const error = new TypeError(`ReadableStream.prototype.${method} called on incompatible receiver`);
  error.code = "ERR_INVALID_THIS";
  return error;
}

function assertReadableStreamThis(stream, method) {
  if (!stream || typeof stream.getReader !== "function") throw invalidReadableStreamThis(method);
}

function installReadableStreamConversionHelpers() {
  const prototype = globalThis.ReadableStream?.prototype;
  if (!prototype) return;
  Object.defineProperties(prototype, {
    bytes: {
      value: function bytes() {
        assertReadableStreamThis(this, "bytes");
        return readableStreamToBytes(this);
      },
      writable: true,
      configurable: true,
    },
    blob: {
      value: function blob() {
        assertReadableStreamThis(this, "blob");
        return readableStreamToBlob(this);
      },
      writable: true,
      configurable: true,
    },
    text: {
      value: function text() {
        assertReadableStreamThis(this, "text");
        return readableStreamToText(this);
      },
      writable: true,
      configurable: true,
    },
    json: {
      value: function json() {
        assertReadableStreamThis(this, "json");
        return readableStreamToJSON(this);
      },
      writable: true,
      configurable: true,
    },
  });
}

export function readableStreamToFormData(stream, formData = new FormData()) {
  return internalThen(readableStreamToText(stream), (text) => {
    for (const pair of text.split("&")) {
      if (!pair) continue;
      const [key, value = ""] = pair.split("=");
      formData.append(decodeURIComponent(key), decodeURIComponent(value));
    }
    return formData;
  });
}

function bunDnsFamily(family) {
  if (family == null || family === "any") return 0;
  if (family === "IPv4") return 4;
  if (family === "IPv6") return 6;
  return Number(family) || 0;
}

function bunDnsError(error, hostname = undefined) {
  const out = new Error(error?.message || "DNS lookup failed");
  out.name = "DNSException";
  const rawCode = String(error?.code || "ENOTFOUND");
  out.code = rawCode.startsWith("DNS_") ? rawCode : `DNS_${rawCode}`;
  out.errno = out.code;
  if (hostname != null) out.hostname = String(hostname);
  return out;
}

function bunDnsLookup(hostname, options = {}) {
  const lookupOptions = typeof options === "object" && options !== null
    ? { ...options, family: bunDnsFamily(options.family), all: true }
    : { family: bunDnsFamily(options), all: true };
  return new Promise((resolve, reject) => {
    nodeDns.lookup(hostname, lookupOptions, (error, records) => {
      if (error) {
        reject(bunDnsError(error, hostname));
        return;
      }
      resolve(Array.from(records ?? []).map((record) => ({
        address: String(record.address),
        family: Number(record.family),
        ttl: Number(record.ttl ?? 0),
      })));
    });
  });
}

export const dns = {
  ...nodeDns,
  lookup: bunDnsLookup,
};

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

function isPromiseForPeek(value) {
  return value != null && typeof value === "object" && Promise.prototype.isPrototypeOf(value);
}

export function peek(value) {
  if (!isPromiseForPeek(value)) return value;
  const state = promisePeekStates.get(value);
  if (!state) return value;
  return state.value;
}

peek.status = function(value) {
  if (!isPromiseForPeek(value)) return "fulfilled";
  return promisePeekStates.get(value)?.status ?? "pending";
};

export function mmap(path, options = undefined) {
  if (typeof path !== "string") throw new TypeError("Expected a path");
  if (options != null && typeof options !== "object") throw new TypeError("Expected options to be an object");
  const offset = options?.offset === undefined ? 0 : Math.trunc(Number(options.offset));
  if (!Number.isFinite(offset) || offset < 0) throw new TypeError("offset must be a non-negative integer");
  const hasSize = options != null && options.size !== undefined;
  const size = hasSize ? Math.trunc(Number(options.size)) : -1;
  if (!Number.isFinite(size) || (hasSize && size < 0)) throw new TypeError("size must be a non-negative integer");
  try {
    return new Uint8Array(cottontail.mmapFile(path, offset, size, options?.shared !== false));
  } catch (error) {
    if (hasSize && size === 0) throw new Error("EINVAL: Invalid argument");
    throw error;
  }
}

export function openInEditor(path) {
  return spawn(["open", String(path)], { stdout: "ignore", stderr: "ignore" });
}

const bunSocketCallbackError = Symbol("cottontail.bunSocketCallbackError");

function attachBunSocketHandlers(socket, handlers = {}, data = undefined, connectionState = undefined) {
  socket.data = data;
  if (!socket.__cottontailBunSocketMethods) {
    const nodeWrite = socket.write.bind(socket);
    const nodeSetTimeout = socket.setTimeout.bind(socket);
    Object.defineProperty(socket, "__cottontailBunSocketMethods", { value: true });
    socket.write = (chunk, encoding = undefined, callback = undefined) => {
      if (socket.destroyed || !socket.writable) return 0;
      const length = bytesFromData(chunk).byteLength;
      const before = Number(socket.bytesWritten) || 0;
      const acceptedWithoutBackpressure = nodeWrite(chunk, encoding, callback);
      const written = Math.max(0, Math.min(length, (Number(socket.bytesWritten) || 0) - before));
      if (!acceptedWithoutBackpressure) socket.__cottontailScheduleBunDrain?.();
      return acceptedWithoutBackpressure ? length : written;
    };
    socket.flush = () => 0;
    socket.shutdown = () => socket.end();
    const timeout = (milliseconds) => {
      nodeSetTimeout(milliseconds);
      socket.timeout = timeout;
      return socket;
    };
    socket.timeout = timeout;
  }
  const call = (name, ...args) => {
    const callback = handlers?.[name];
    if (typeof callback !== "function") return undefined;
    try {
      return callback(...args);
    } catch (error) {
      if (name !== "error" && typeof handlers?.error === "function") {
        handlers.error(socket, error);
        return { [bunSocketCallbackError]: true, error };
      }
      throw error;
    }
  };

  socket.on("data", (chunk) => {
    let value = chunk;
    if (handlers.binaryType === "arraybuffer") {
      const bytes = asBuffer(chunk);
      value = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } else if (handlers.binaryType === "uint8array") {
      const bytes = asBuffer(chunk);
      value = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    call("data", socket, value);
  });
  let drainGeneration = 0;
  socket.__cottontailScheduleBunDrain = () => {
    const generation = ++drainGeneration;
    setTimeout(() => {
      if (generation !== drainGeneration || socket.destroyed) return;
      drainGeneration += 1;
      call("drain", socket);
    }, 1);
  };
  socket.on("drain", () => {
    drainGeneration += 1;
    call("drain", socket);
  });
  socket.on("end", () => call("end", socket));
  socket.on("timeout", () => call("timeout", socket));
  socket.on("error", (error) => {
    if (connectionState?.connecting) {
      connectionState.connecting = false;
      connectionState.failed = true;
      const connectError = new Error("Failed to connect");
      connectError.code = error?.code ?? "ECONNREFUSED";
      connectError.errno = error?.errno ?? connectError.code;
      call("connectError", socket, connectError);
      connectionState.reject?.(connectError);
      return;
    }
    call("error", socket, error);
  });
  socket.on("close", (hadError) => {
    if (connectionState?.failed && !connectionState.opened) return;
    call("close", socket, hadError ? new Error("Socket closed with an error") : null);
  });
  Object.defineProperty(socket, Symbol.dispose, {
    value() {
      socket.end();
      socket.destroy();
    },
    configurable: true,
  });
  Object.defineProperty(socket, Symbol.asyncDispose, {
    value() {
      socket[Symbol.dispose]();
      return Promise.resolve();
    },
    configurable: true,
  });
  return { socket, call };
}

function normalizeBunSocketOptions(options) {
  if (options === null || typeof options !== "object") throw new TypeError("Bun socket options must be an object");
  const unix = options.unix ? coerceServeOptionString(options.unix, "unix") : "";
  if (unix.includes("\0")) throw new TypeError("unix must not contain NUL bytes");
  const suppliedHostname = options.hostname ? coerceServeOptionString(options.hostname, "hostname") : "";
  if (unix && suppliedHostname) throw new TypeError("Cannot specify both unix and hostname");
  const hostname = suppliedHostname || "127.0.0.1";
  const port = Number(options.port ?? 0);
  if (!unix && (!Number.isFinite(port) || port < 0 || port > 65535)) {
    throw new RangeError("port must be in the range [0, 65535]");
  }
  if (options.tls != null && options.tls !== false && options.tls !== true && typeof options.tls !== "object") {
    throw new TypeError("TLSOptions must be an object");
  }
  return { unix, hostname, port };
}

export function connect(options = {}) {
  const normalized = normalizeBunSocketOptions(options);
  const handlers = options.socket ?? {};
  if (handlers === null || typeof handlers !== "object") throw new TypeError("socket must be an object");
  return new Promise((resolve, reject) => {
    const state = { connecting: true, opened: false, failed: false, reject };
    let socket;
    let attached;
    if (options.fd != null) {
      socket = new nodeNet.Socket();
      attached = attachBunSocketHandlers(socket, handlers, options.data, state);
      try {
        const fd = Number(options.fd);
        if (!Number.isInteger(fd) || fd < 0) throw new Error("Bad file descriptor");
        cottontail.fstatSync(fd);
        socket._attachFd(fd, undefined, undefined, true);
      } catch (error) {
        state.connecting = false;
        state.failed = true;
        const connectError = new Error("Failed to connect");
        connectError.code = error?.code ?? "EBADF";
        connectError.errno = error?.errno ?? connectError.code;
        attached.call("connectError", socket, connectError);
        reject(connectError);
      }
    } else {
      socket = nodeNet.connect(normalized.unix
        ? { path: normalized.unix }
        : { host: normalized.hostname, port: normalized.port });
      attached = attachBunSocketHandlers(socket, handlers, options.data, state);
    }
    socket.once("connect", () => {
      if (state.failed) return;
      state.connecting = false;
      state.opened = true;
      const result = attached.call("open", socket);
      if (result instanceof Error) {
        attached.call("error", socket, result);
      }
      resolve(socket);
    });
  });
}

export function listen(options = {}) {
  const normalized = normalizeBunSocketOptions(options);
  const handlers = options.socket ?? {};
  if (handlers === null || typeof handlers !== "object") throw new TypeError("socket must be an object");

  const native = normalized.unix
    ? cottontail.unixServerListen(normalized.unix, Number(options.backlog ?? 128))
    : cottontail.tcpServerListen(normalized.port, normalized.hostname, normalized.hostname.includes(":") ? 6 : 4);
  const address = normalized.unix ? { path: String(native.path ?? normalized.unix), family: "Unix" } : native.address;
  const server = nodeNet.Server._fromFd(native.fd, {
    pipe: Boolean(normalized.unix),
    path: normalized.unix || undefined,
  });
  let stopped = false;
  let activeOptions = options;

  server.on("connection", (socket) => {
    const attached = attachBunSocketHandlers(socket, activeOptions.socket ?? handlers, activeOptions.data);
    attached.call("open", socket);
  });

  const listener = {
    data: options.data,
    hostname: normalized.unix ? undefined : String(address?.address ?? normalized.hostname),
    port: normalized.unix ? undefined : Number(address?.port ?? normalized.port),
    unix: normalized.unix || undefined,
    stop() {
      if (stopped) return;
      stopped = true;
      server.close();
    },
    ref() {
      server.ref();
      return listener;
    },
    unref() {
      server.unref();
      return listener;
    },
    reload(nextOptions = {}) {
      activeOptions = { ...activeOptions, ...nextOptions };
      listener.data = activeOptions.data;
      return listener;
    },
    getsockname(out) {
      if (out === null || typeof out !== "object") throw new TypeError("getsockname requires an object");
      if (normalized.unix) {
        out.family = "Unix";
        out.address = String(address?.path ?? normalized.unix);
      } else {
        out.family = String(address?.family ?? (listener.hostname.includes(":") ? "IPv6" : "IPv4"));
        out.address = listener.hostname;
        out.port = listener.port;
      }
      return undefined;
    },
    [Symbol.dispose]() {
      listener.stop();
    },
    [Symbol.asyncDispose]() {
      listener.stop();
      return Promise.resolve();
    },
  };
  return listener;
}

export async function udpSocket(options = {}) {
  if (options == null || typeof options !== "object") throw new TypeError("udpSocket options must be an object");
  const dgram = await import("../node/dgram.js");
  const requestedHostname = String(options.hostname ?? (String(options.connect?.hostname ?? "").includes(":") ? "::" : "0.0.0.0"));
  const type = options.type ?? (requestedHostname.includes(":") ? "udp6" : "udp4");
  const socket = dgram.createSocket(type);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      socket.removeListener("error", onError);
      resolve();
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind({ port: Number(options.port ?? 0), address: requestedHostname });
  });

  if (options.connect != null) {
    if (typeof options.connect !== "object") {
      socket.close();
      throw new TypeError("connect must be an object");
    }
    try {
      socket.connect(Number(options.connect.port), String(options.connect.hostname ?? (type === "udp6" ? "::1" : "127.0.0.1")));
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  const nativeAddress = socket.address();
  const binaryType = options.binaryType ?? "buffer";
  if (!["buffer", "uint8array", "arraybuffer"].includes(binaryType)) {
    socket.close();
    throw new TypeError("binaryType must be buffer, uint8array, or arraybuffer");
  }
  const address = Object.freeze({
    address: requestedHostname,
    family: type === "udp6" ? "IPv6" : "IPv4",
    port: Number(nativeAddress.port),
  });
  const result = {
    hostname: requestedHostname,
    port: address.port,
    address,
    binaryType,
    get closed() { return socket.closed; },
    ref() {
      socket.ref();
      return result;
    },
    unref() {
      socket.unref();
      return result;
    },
    send(data, port = undefined, hostname = undefined) {
      if (socket.closed) return false;
      if (socket.remote) socket.send(data);
      else socket.send(data, Number(port), String(hostname ?? "127.0.0.1"));
      return true;
    },
    sendMany(payloads) {
      if (!Array.isArray(payloads)) throw new TypeError("sendMany expects an array");
      let count = 0;
      if (socket.remote) {
        for (const data of payloads) {
          if (!result.send(data)) break;
          count += 1;
        }
      } else {
        if (payloads.length % 3 !== 0) throw new TypeError("Unconnected sendMany expects data, port, hostname triples");
        for (let index = 0; index < payloads.length; index += 3) {
          if (!result.send(payloads[index], payloads[index + 1], payloads[index + 2])) break;
          count += 1;
        }
      }
      return count;
    },
    close() {
      socket.close();
    },
    [Symbol.dispose]() {
      socket.close();
    },
    [Symbol.asyncDispose]() {
      socket.close();
      return Promise.resolve();
    },
  };

  if (typeof options.socket?.data === "function") {
    socket.on("message", (data, rinfo) => {
      let converted = data;
      if (binaryType === "uint8array") converted = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (binaryType === "arraybuffer") converted = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      options.socket.data(result, converted, Number(rinfo.port), String(rinfo.address));
    });
  }
  if (typeof options.socket?.error === "function") socket.on("error", (error) => options.socket.error(result, error));
  return result;
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
export const zstdCompressSync = zlib.zstdCompressSync;
export const zstdDecompressSync = zlib.zstdDecompressSync;
export function zstdCompress(data, options = undefined) {
  return Promise.resolve(zstdCompressSync(data, options));
}
export function zstdDecompress(data, options = undefined) {
  return Promise.resolve(zstdDecompressSync(data, options));
}
export { FFI };

export const TOML = {
  parse(text) {
    return parseTOML(text);
  },
  stringify: stringifyTOML,
};

function jsonTextInput(value) {
  if (value == null) throw new TypeError("Expected a string or typed array");
  if (typeof value === "string") return value;
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > 512 * 1024 * 1024) throw new RangeError("Input is too large");
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > 512 * 1024 * 1024) throw new RangeError("Input is too large");
    return new TextDecoder().decode(new Uint8Array(value));
  }
  return String(value);
}

function stripJSONCCommentsAndTrailingCommas(source) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      index -= 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      if (index < source.length) index += 1;
      continue;
    }
    out += char;
  }

  source = out;
  out = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let cursor = index + 1;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      if (source[cursor] === "}" || source[cursor] === "]") continue;
    }
    out += char;
  }
  return out;
}

function assertJSONNestingWithinLimit(source, limit) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{" || char === "[") {
      depth += 1;
      if (depth > limit) throw new RangeError("Maximum JSON nesting depth exceeded");
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
  }
}

function isJSONWhitespace(char) {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function isJSONDelimiter(char) {
  return char === undefined || isJSONWhitespace(char);
}

function scanJSONString(source, start) {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") return { status: "complete", end: index + 1 };
    if (char < " ") return { status: "invalid" };
  }
  return { status: "incomplete" };
}

function scanJSONComposite(source, start) {
  const stack = [source[start]];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      else if (char < " ") return { status: "invalid" };
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "\n" || char === "\r") return { status: "invalid" };
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const open = stack.pop();
      if ((char === "}" && open !== "{") || (char === "]" && open !== "[")) return { status: "invalid" };
      if (stack.length === 0) return { status: "complete", end: index + 1 };
    }
  }
  return { status: "incomplete" };
}

function scanJSONLiteral(source, start, literal) {
  const remaining = source.length - start;
  if (remaining < literal.length && literal.startsWith(source.slice(start))) return { status: "incomplete" };
  if (source.slice(start, start + literal.length) !== literal) return { status: "invalid" };
  const end = start + literal.length;
  if (!isJSONDelimiter(source[end])) return { status: "invalid" };
  return { status: "complete", end };
}

function scanJSONNumber(source, start) {
  let end = start;
  while (end < source.length && !isJSONWhitespace(source[end])) end += 1;
  const token = source.slice(start, end);
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return { status: "complete", end };
  if (end === source.length && /^-?(?:0|[1-9]\d*)?(?:\.\d*)?(?:[eE][+-]?)?$/.test(token)) return { status: "incomplete" };
  return { status: "invalid" };
}

function scanJSONValue(source, start) {
  const char = source[start];
  if (char === undefined) return { status: "incomplete" };
  if (char === "\"") return scanJSONString(source, start);
  if (char === "{" || char === "[") return scanJSONComposite(source, start);
  if (char === "t") return scanJSONLiteral(source, start, "true");
  if (char === "f") return scanJSONLiteral(source, start, "false");
  if (char === "n") return scanJSONLiteral(source, start, "null");
  if (char === "-" || (char >= "0" && char <= "9")) return scanJSONNumber(source, start);
  return { status: "invalid" };
}

function parseJSONLString(source) {
  const values = [];
  let position = 0;
  let read = 0;
  if (source.charCodeAt(0) === 0xfeff) position = 1;
  for (;;) {
    while (position < source.length && isJSONWhitespace(source[position])) position += 1;
    if (position >= source.length) return { values, read, done: true, error: null };

    const scan = scanJSONValue(source, position);
    if (scan.status === "incomplete") return { values, read, done: false, error: null };
    if (scan.status === "invalid") return { values, read, done: false, error: new SyntaxError("Invalid JSONL input") };

    const raw = source.slice(position, scan.end);
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { values, read, done: false, error };
    }

    values.push(value);
    read = scan.end;

    let cursor = scan.end;
    while (cursor < source.length && (source[cursor] === " " || source[cursor] === "\t")) cursor += 1;
    if (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") {
      return { values, read, done: false, error: new SyntaxError("Invalid JSONL input") };
    }

    position = cursor;
    while (position < source.length && (source[position] === "\n" || source[position] === "\r")) position += 1;
  }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;

function appendCodePoint(out, codePoint) {
  if (codePoint <= 0xffff) return out + String.fromCharCode(codePoint);
  codePoint -= 0x10000;
  return out + String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
}

function decodeJSONLUtf8(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    if (first < 0x80) {
      out += String.fromCharCode(first);
      index += 1;
      continue;
    }

    let codePoint = 0xfffd;
    let width = 1;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const fourth = bytes[index + 3];
    if (first >= 0xc2 && first <= 0xdf && second >= 0x80 && second <= 0xbf) {
      codePoint = ((first & 0x1f) << 6) | (second & 0x3f);
      width = 2;
    } else if (
      first === 0xe0 && second >= 0xa0 && second <= 0xbf && third >= 0x80 && third <= 0xbf
    ) {
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = 3;
    } else if (
      first >= 0xe1 && first <= 0xec && second >= 0x80 && second <= 0xbf && third >= 0x80 && third <= 0xbf
    ) {
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = 3;
    } else if (
      first === 0xed && second >= 0x80 && second <= 0x9f && third >= 0x80 && third <= 0xbf
    ) {
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = 3;
    } else if (
      first >= 0xee && first <= 0xef && second >= 0x80 && second <= 0xbf && third >= 0x80 && third <= 0xbf
    ) {
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = 3;
    } else if (
      first === 0xf0 && second >= 0x90 && second <= 0xbf && third >= 0x80 && third <= 0xbf &&
      fourth >= 0x80 && fourth <= 0xbf
    ) {
      codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      width = 4;
    } else if (
      first >= 0xf1 && first <= 0xf3 && second >= 0x80 && second <= 0xbf && third >= 0x80 && third <= 0xbf &&
      fourth >= 0x80 && fourth <= 0xbf
    ) {
      codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      width = 4;
    } else if (
      first === 0xf4 && second >= 0x80 && second <= 0x8f && third >= 0x80 && third <= 0xbf &&
      fourth >= 0x80 && fourth <= 0xbf
    ) {
      codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      width = 4;
    }

    out = appendCodePoint(out, codePoint);
    index += width;
  }
  return out;
}

function jsonlTypedArrayView(input, start, end) {
  if (input == null) throw new TypeError("Expected a string or typed array");
  if (!ArrayBuffer.isView(input) || input instanceof DataView) return null;

  const byteLength = typedArrayByteLength.call(input);
  const byteOffset = typedArrayByteOffset.call(input);
  if (byteLength > 512 * 1024 * 1024) throw new RangeError("Input is too large");
  let byteStart = Math.min(Math.max(Number(start) || 0, 0), byteLength);
  const byteEnd = end === undefined ? byteLength : Math.min(Math.max(Number(end) || 0, 0), byteLength);
  if (byteEnd < byteStart) byteStart = byteEnd;
  const viewEnd = byteEnd;
  let view = new Uint8Array(input.buffer, byteOffset + byteStart, viewEnd - byteStart);
  let bomLength = 0;
  if (byteStart === 0 && view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
    view = view.subarray(3);
    bomLength = 3;
  }
  return { view, byteStart, bomLength };
}

function parseJSONLChunk(input, start = 0, end = undefined) {
  const typed = jsonlTypedArrayView(input, start, end);
  if (typed) {
    const source = decodeJSONLUtf8(typed.view);
    const result = parseJSONLString(source);
    const readBytes = new TextEncoder().encode(source.slice(0, result.read)).byteLength;
    return {
      values: result.values,
      read: typed.byteStart + typed.bomLength + readBytes,
      done: result.done,
      error: result.error,
    };
  }
  const result = parseJSONLString(jsonTextInput(input));
  return {
    values: result.values,
    read: result.read,
    done: result.done,
    error: result.error,
  };
}

export const JSONC = {
  parse(text) {
    const source = stripJSONCCommentsAndTrailingCommas(jsonTextInput(text));
    assertJSONNestingWithinLimit(source, 10_000);
    return JSON.parse(source);
  },
};

export const JSON5 = {
  parse(text) {
    return parseJSON5(jsonTextInput(text));
  },
  stringify: stringifyJSON5,
};

export const JSONL = {
  [Symbol.toStringTag]: "JSONL",
  parse(input) {
    const result = parseJSONLChunk(input);
    if (result.error && result.values.length === 0) throw result.error;
    return result.values;
  },
  parseChunk(input, start = 0, end = undefined) {
    return parseJSONLChunk(input, start, end);
  },
};

export const YAML = {
  parse: parseYAML,
  stringify: stringifyYAML,
};

function normalizeCookieText(value) {
  const text = String(value ?? "");
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += text[index] + text[index + 1];
        index += 1;
      } else {
        output += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\ufffd";
    } else {
      output += text[index];
    }
  }
  return output;
}

function encodeCookieText(value) {
  return encodeURIComponent(normalizeCookieText(value));
}

function decodeCookieText(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value).replace(/%(?![0-9a-fA-F]{2})/g, "\ufffd");
  }
}

function isInvalidCookieName(value) {
  const text = String(value);
  return text.length === 0 || /[\x00-\x20\x7f;=]/.test(text) || /[^\x00-\x7f]/.test(text);
}

function isInvalidCookieDomain(value) {
  return /[^A-Za-z0-9.-]/.test(String(value));
}

function isInvalidCookiePath(value) {
  return /[\x00-\x1f\x7f;]/.test(String(value));
}

export class Cookie {
  constructor(name, value = undefined, options = {}) {
    if (name && typeof name === "object" && !(name instanceof String)) {
      options = name;
      name = options.name;
      value = options.value;
    }
    const initialName = String(name);
    if (isInvalidCookieName(initialName)) throw new TypeError("Invalid cookie name: contains invalid characters");
    this._name = initialName;
    this._value = "";
    this.value = value ?? "";
    this._path = "/";
    this._domain = null;
    this.path = options.path == null ? "/" : String(options.path);
    this.domain = options.domain == null || options.domain === "" ? null : String(options.domain);
    this.secure = Boolean(options.secure);
    this.httpOnly = Boolean(options.httpOnly);
    this.partitioned = Boolean(options.partitioned);
    this.sameSite = String(options.sameSite ?? "lax");
    if (!["strict", "lax", "none"].includes(this.sameSite)) {
      throw new TypeError("Invalid sameSite value. Must be 'strict', 'lax', or 'none'");
    }
    if (options.maxAge != null) this.maxAge = Number(options.maxAge);
    const expires = normalizeCookieExpires(options.expires);
    if (expires !== undefined) this.expires = expires;
  }
  static parse(text) {
    const parts = String(text).split(";");
    const first = parts.shift() ?? "";
    const eq = first.indexOf("=");
    const name = eq >= 0 ? first.slice(0, eq) : first;
    const value = eq >= 0 ? first.slice(eq + 1) : "";
    const options = {};
    for (const raw of parts) {
      const part = raw.trim();
      if (!part) continue;
      const attrEq = part.indexOf("=");
      const key = (attrEq >= 0 ? part.slice(0, attrEq) : part).trim().toLowerCase();
      const attrValue = attrEq >= 0 ? part.slice(attrEq + 1).trim().replace(/^"|"$/g, "") : "";
      if (key === "domain") options.domain = attrValue;
      else if (key === "path") options.path = attrValue;
      else if (key === "max-age") options.maxAge = Number(attrValue);
      else if (key === "expires") options.expires = new Date(attrValue);
      else if (key === "secure") options.secure = true;
      else if (key === "httponly") options.httpOnly = true;
      else if (key === "partitioned") options.partitioned = true;
      else if (key === "samesite") options.sameSite = attrValue.toLowerCase();
    }
    return new Cookie(name.trim(), decodeCookieText(value.trim()), options);
  }
  static from(name, value = undefined, options = {}) {
    if (name instanceof Cookie) return name;
    if (value === undefined && typeof name === "string" && String(name).includes("=")) return Cookie.parse(name);
    return new Cookie(name, value, options);
  }
  isExpired() {
    if (this.maxAge != null) return Number(this.maxAge) <= 0;
    return this.expires instanceof Date && this.expires.getTime() <= Date.now();
  }
  serialize() {
    const parts = [`${this.name}=${encodeCookieText(this.value)}`];
    if (this.domain) parts.push(`Domain=${this.domain}`);
    if (this.path != null) parts.push(`Path=${this.path}`);
    if (this.expires instanceof Date) parts.push(`Expires=${formatCookieDate(this.expires)}`);
    if (this.maxAge != null) parts.push(`Max-Age=${Math.trunc(Number(this.maxAge))}`);
    if (this.secure) parts.push("Secure");
    if (this.httpOnly) parts.push("HttpOnly");
    if (this.partitioned) parts.push("Partitioned");
    if (this.sameSite) parts.push(`SameSite=${this.sameSite[0].toUpperCase()}${this.sameSite.slice(1).toLowerCase()}`);
    return parts.join("; ");
  }
  toString() {
    return this.serialize();
  }
  get value() {
    return this._value;
  }
  set value(next) {
    this._value = normalizeCookieText(next);
  }
  get name() {
    return this._name;
  }
  set name(_next) {
  }
  get domain() {
    return this._domain;
  }
  set domain(next) {
    if (next == null || next === "") {
      this._domain = null;
      return;
    }
    const value = String(next);
    if (isInvalidCookieDomain(value)) throw new TypeError("Invalid cookie domain: contains invalid characters");
    this._domain = value;
  }
  get path() {
    return this._path;
  }
  set path(next) {
    if (next === "") {
      this._path = null;
      return;
    }
    const value = next == null ? "/" : String(next);
    if (isInvalidCookiePath(value)) throw new TypeError("Invalid cookie path: contains invalid characters");
    this._path = value;
  }
  toJSON() {
    const result = {
      name: this.name,
      value: this.value,
      domain: this.domain,
      path: this.path,
      secure: this.secure,
      sameSite: this.sameSite,
      httpOnly: this.httpOnly,
      partitioned: this.partitioned,
    };
    if (this.expires !== undefined) result.expires = this.expires;
    if (this.maxAge !== undefined) result.maxAge = this.maxAge;
    return result;
  }
}

function normalizeCookieExpires(value) {
  if (value == null) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("expires must be a valid Date (or Number)");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("expires must be a valid Number");
    return new Date(value * 1000);
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("Invalid cookie expiration date");
    return date;
  }
  throw new TypeError(`The argument 'expires' Invalid expires value. Must be a Date or a number. Received ${nodeInspect(value)}`);
}

function formatCookieDate(date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = days[(date.getUTCDay() + 1) % 7];
  const dd = String(date.getUTCDate());
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${day}, ${dd} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${hh}:${mm}:${ss} -0000`;
}

export class CookieMap extends Map {
  constructor(init = undefined, options = undefined) {
    super();
    this._changes = [];
    this._initialKeys = [];
    this._dynamicKeys = [];
    const preserveFirst = Boolean(options?.preserveFirst);
    if (typeof init === "string") {
      const parts = init.split(";");
      for (let index = 0; index < parts.length; index += 1) {
        const raw = index === 0 ? parts[index].trimEnd() : parts[index].trim();
        const eq = raw.indexOf("=");
        if (eq < 0) continue;
        const name = eq >= 0 ? raw.slice(0, eq).trimEnd() : raw.trimEnd();
        const value = eq >= 0 ? raw.slice(eq + 1).trim() : "";
        if (!name) continue;
        if (preserveFirst && Map.prototype.has.call(this, name)) continue;
        if (!Map.prototype.has.call(this, name)) this._initialKeys.push(name);
        Map.prototype.set.call(this, name, decodeCookieText(value));
      }
    } else if (Array.isArray(init) || (init && typeof init[Symbol.iterator] === "function")) {
      for (const [key, value] of init) {
        const name = String(key);
        if (!Map.prototype.has.call(this, name)) this._initialKeys.push(name);
        if (!preserveFirst || !Map.prototype.has.call(this, name)) {
          Map.prototype.set.call(this, name, String(value));
        }
      }
    } else if (init && typeof init === "object") {
      for (const [key, value] of Object.entries(init)) {
        Map.prototype.set.call(this, key, String(value));
        this._initialKeys.push(key);
      }
    }
  }
  set(name, value = undefined, options = {}) {
    const cookie = name instanceof Cookie ? name : new Cookie(name, value, options);
    if (!this._dynamicKeys.includes(cookie.name)) this._dynamicKeys.push(cookie.name);
    Map.prototype.set.call(this, cookie.name, cookie);
    this._changes = this._changes.filter((item) =>
      item.name !== cookie.name ||
      item.domain !== cookie.domain ||
      item.path !== cookie.path
    );
    this._changes.push(cookie);
    return this;
  }
  get(name) {
    if (!super.has(name)) return null;
    const value = super.get(name);
    return value instanceof Cookie ? value.value : value;
  }
  delete(name, options = {}) {
    let cookie;
    if (name instanceof Cookie) {
      cookie = new Cookie(name.name, "", {
        domain: name.domain,
        path: name.path,
        secure: name.secure,
        httpOnly: name.httpOnly,
        partitioned: name.partitioned,
        sameSite: name.sameSite,
        expires: 0,
      });
    } else if (name && typeof name === "object") {
      if (name.name == null) throw new TypeError("Cookie name is required");
      cookie = new Cookie({
        ...name,
        value: "",
        expires: 0,
      });
    } else {
      cookie = new Cookie(name, "", { ...options, expires: 0 });
    }
    const existed = super.delete(cookie.name);
    const dynamicIndex = this._dynamicKeys.indexOf(cookie.name);
    if (dynamicIndex >= 0) this._dynamicKeys.splice(dynamicIndex, 1);
    this._changes = this._changes.filter((item) =>
      item.name !== cookie.name ||
      item.domain !== cookie.domain ||
      item.path !== cookie.path
    );
    this._changes.push(cookie);
    return existed;
  }
  toSetCookieHeaders() {
    return this._changes.map((cookie) => cookie.serialize());
  }
  toString() {
    return [...this].map(([key, value]) => `${key}=${value}`).join("; ");
  }
  toJSON() {
    return Object.fromEntries(this);
  }
  *keys() {
    const yielded = new Set();
    if (this._dynamicKeys.length > 0) {
      for (let index = 0; index < this._dynamicKeys.length; index += 1) {
        const key = this._dynamicKeys[index];
        if (!super.has(key)) continue;
        yielded.add(key);
        yield key;
      }
      const initialKeys = [...this._initialKeys].reverse();
      for (const key of initialKeys) {
        if (yielded.has(key) || !super.has(key)) continue;
        yield key;
      }
      return;
    }
    const initialKeys = [...this._initialKeys];
    for (const key of initialKeys) {
      if (!super.has(key)) continue;
      yield key;
    }
  }
  *entries() {
    for (const key of this.keys()) {
      const value = Map.prototype.get.call(this, key);
      yield [key, value instanceof Cookie ? value.value : value];
    }
  }
  *values() {
    for (const [, value] of this.entries()) yield value;
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  forEach(callback, thisArg = undefined) {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
}

export class Glob {
  constructor(pattern) {
    this.pattern = String(pattern);
    const compiledPattern = normalizeGlobCharacterClasses(normalizeGlobSeparators(this.pattern));
    const patterns = expandBunGlobBraces(compiledPattern);
    this._matchesEmpty = patterns.some((expanded) => expanded === "*" || expanded === "**");
    this._matchers = patterns.map((expanded) => ({
      pattern: expanded,
      matcher: expanded === "" ? (text) => text === "" : picomatch(expanded, { dot: true }),
      trailingGlobstarBase: trailingGlobstarBase(expanded),
    }));
  }
  match(value) {
    if (typeof value !== "string") throw new TypeError("Glob.match expects a string");
    const text = normalizeGlobSeparators(value);
    if (text === "" && this._matchesEmpty) return true;
    for (const { matcher, trailingGlobstarBase } of this._matchers) {
      if (trailingGlobstarBase !== null && text === trailingGlobstarBase && trailingGlobstarBase !== "") continue;
      if (matcher(text)) return true;
      if (trailingGlobstarBase !== null && !hasGlobMeta(trailingGlobstarBase)) {
        const prefix = `${trailingGlobstarBase}/`;
        if (text === prefix || text.startsWith(prefix)) return true;
      }
    }
    return false;
  }
  scanSync(options = {}) {
    options = normalizeGlobScanOptions(options);
    const cwd = nodePathResolve(String(options.cwd ?? options.root ?? cottontail.cwd()));
    const patternIsAbsolute = isAbsoluteGlobPath(normalizeGlobSeparators(this.pattern));
    const compiledPattern = normalizeGlobSeparators(this.pattern);
    const root = patternIsAbsolute ? absoluteGlobScanRoot(compiledPattern, cwd) : cwd;
    if (patternIsAbsolute && root === "/" && absoluteRootGlobShouldNotScan(compiledPattern)) return [];
    const absolute = Boolean(options.absolute);
    const onlyFiles = options.onlyFiles !== false;
    const dot = Boolean(options.dot);
    const followSymlinks = Object.prototype.hasOwnProperty.call(options, "followSymlinks") && Boolean(options.followSymlinks);
    const results = [];
    for (const entry of walkFiles(root, { dot, onlyFiles, followSymlinks, throwErrorOnBrokenSymlink: Boolean(options.throwErrorOnBrokenSymlink) })) {
      const matchTarget = patternIsAbsolute ? entry.absolute : entry.relative;
      if (!this.match(matchTarget) && !(entry.isDirectory && this.match(`${matchTarget}/`))) continue;
      results.push(absolute || patternIsAbsolute ? entry.absolute : entry.relative);
    }
    return results;
  }
  scan(options = {}) {
    const entries = this.scanSync(options);
    return (async function*() {
      yield* entries;
    })();
  }
}

function normalizeGlobScanOptions(options) {
  if (options === undefined) return {};
  if (typeof options === "string") return { cwd: options };
  if (options === null || typeof options !== "object") throw new TypeError("Glob.scan options must be an object or string");
  if (options.cwd !== undefined && typeof options.cwd !== "string") throw new TypeError("Glob.scan cwd must be a string");
  if (options.root !== undefined && typeof options.root !== "string") throw new TypeError("Glob.scan root must be a string");
  return options;
}

function normalizeGlobSeparators(value) {
  const text = String(value);
  return globalThis.process?.platform === "win32" ? text.replace(/\\/g, "/") : text;
}

function normalizeGlobCharacterClasses(pattern) {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      output += char + pattern[index + 1];
      index += 1;
      continue;
    }
    if (char === "[" && pattern[index + 1] === "!") {
      output += "[^";
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function trailingGlobstarBase(pattern) {
  let base = pattern;
  let matched = false;
  while (base.endsWith("/**")) {
    base = base.slice(0, -3);
    matched = true;
  }
  return matched ? base : null;
}

function isAbsoluteGlobPath(pattern) {
  return pattern.startsWith("/") || /^[A-Za-z]:\//.test(pattern);
}

function absoluteGlobScanRoot(pattern, cwd) {
  const prefix = literalGlobPrefix(pattern);
  if (prefix === "" || prefix === "/") return "/";
  if (prefix.endsWith("/") && prefix.length > 1) return nodePathResolve(cwd, prefix.slice(0, -1));
  const trimmed = prefix;
  if (trimmed === "") return "/";
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0) return "/";
  return nodePathResolve(cwd, trimmed.slice(0, slash));
}

function absoluteRootGlobShouldNotScan(pattern) {
  const rest = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const slash = rest.indexOf("/");
  const first = slash === -1 ? rest : rest.slice(0, slash);
  if (first === "" || first === "*" || first === "**") return false;
  return /[*?[\]{}]/.test(first);
}

function literalGlobPrefix(pattern) {
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      continue;
    }
    if (char === "[" && !inClass) {
      return pattern.slice(0, index);
    }
    if (char === "{" || char === "*" || char === "?") return pattern.slice(0, index);
  }
  return pattern;
}

function hasGlobMeta(pattern) {
  return /[*?[\]()!+@]/.test(pattern);
}

function expandBunGlobBraces(pattern) {
  const results = [];
  const limit = 4096;
  const visit = (text) => {
    if (results.length >= limit) {
      results.push(text);
      return;
    }
    const open = findGlobBraceOpen(text);
    if (open === -1) {
      results.push(text);
      return;
    }
    const close = findGlobBraceClose(text, open);
    if (close === -1) {
      results.push(text);
      return;
    }
    const prefix = text.slice(0, open);
    const suffix = text.slice(close + 1);
    for (const alternative of splitGlobBraceAlternatives(text.slice(open + 1, close))) {
      visit(`${prefix}${alternative}${suffix}`);
    }
  };
  visit(pattern);
  return results.length === 0 ? [pattern] : results;
}

function findGlobBraceOpen(text) {
  let inClass = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (char === "{" && !inClass) return index;
  }
  return -1;
}

function findGlobBraceClose(text, open) {
  let depth = 0;
  let inClass = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitGlobBraceAlternatives(text) {
  const alternatives = [];
  let start = 0;
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      alternatives.push(text.slice(start, index));
      start = index + 1;
    }
  }
  alternatives.push(text.slice(start));
  return alternatives;
}

function walkFiles(root, options = {}, prefix = "", seen = new Set()) {
  const entries = [];
  for (const entry of cottontail.readDirSync(root)) {
    if (!options.dot && entry.name.startsWith(".")) continue;
    const absolute = pathJoin(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    let stat = entry;
    if (entry.isSymbolicLink === true && options.followSymlinks) {
      try {
        stat = cottontail.statSync(absolute, true);
        if (!stat) throw new Error(`Broken symbolic link: ${absolute}`);
      } catch (error) {
        if (options.throwErrorOnBrokenSymlink) throw error;
        stat = entry;
      }
    }
    const isDirectory = stat.kind === "directory" || stat.type === "directory" || stat.isDirectory === true;
    if (isDirectory) {
      if (options.onlyFiles === false) entries.push({ absolute, relative, isDirectory: true });
      const key = stat.dev != null && stat.ino != null ? `${stat.dev}:${stat.ino}` : absolute;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(...walkFiles(absolute, options, relative, seen));
    } else if (options.onlyFiles !== false) {
      entries.push({ absolute, relative, isDirectory: false });
    } else {
      entries.push({ absolute, relative, isDirectory: false });
    }
  }
  return entries;
}

function splitReplStatements(source) {
  const statements = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let braces = 0;
  let brackets = 0;
  let parens = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
    else if (char === ";" && braces === 0 && brackets === 0 && parens === 0) {
      statements.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) statements.push(tail);
  return statements.filter(Boolean);
}

function replBindingNames(pattern) {
  const text = pattern.replace(/:\s*[^,}=\]]+/g, "");
  if (/^[A-Za-z_$][\w$]*$/.test(text.trim())) return [text.trim()];
  return [...text.matchAll(/[A-Za-z_$][\w$]*/g)]
    .map((match) => match[0])
    .filter((name) => !["var", "let", "const"].includes(name));
}

function hasReplTopLevelAwait(source) {
  if (!/\bawait\b/.test(source)) return false;
  if (/^\s*async\s+function\b/.test(source)) return false;
  if (/^\s*(?:const|let|var)\s+\w+(?:\s*:[^=]+)?\s*=\s*async\b[\s\S]*=>[\s\S]*\bawait\b/.test(source)) return false;
  return true;
}

function transformReplSource(source) {
  const text = String(source);
  const trimmed = text.trim();
  if (!trimmed || /^\/\//.test(trimmed)) return "";
  if (/^\{[\s\S]*\};$/.test(trimmed)) return text;

  const statements = splitReplStatements(trimmed);
  const hasAwait = hasReplTopLevelAwait(trimmed);
  if (!hasAwait) {
    const last = statements.at(-1);
    const declaration = /^(?:var|let|const)\s+([\s\S]+?)\s*=\s*([\s\S]+)$/.exec(last ?? "");
    if (declaration) {
      const pattern = declaration[1].trim().replace(/:\s*[^=,}\]]+/g, "");
      const names = replBindingNames(pattern);
      const persist = names.length === 1
        ? `globalThis.${names[0]} = ${names[0]};`
        : `Object.assign(globalThis, { ${names.join(", ")} });`;
      return `var ${pattern} = ${declaration[2]};\n${persist}`;
    }
    if (!last || /^(?:function|class|async\s+function)\b/.test(last)) return text;
    const prefix = statements.slice(0, -1).map((statement) => `${statement};`).join("\n");
    return `${prefix}${prefix ? "\n" : ""}({ value: (${last}) })`;
  }

  const hoisted = [];
  const body = [];
  let result = "undefined";
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    const isLast = index === statements.length - 1;
    const declaration = /^(?:var|let|const)\s+([\s\S]+?)\s*=\s*([\s\S]+)$/.exec(statement);
    if (declaration) {
      const pattern = declaration[1].trim().replace(/:\s*[^=,}\]]+/g, "");
      const names = replBindingNames(pattern);
      hoisted.push(...names);
      body.push(`(${pattern} = ${declaration[2]});`);
      body.push(names.length === 1
        ? `globalThis.${names[0]} = ${names[0]};`
        : `Object.assign(globalThis, { ${names.join(", ")} });`);
      if (isLast) result = names.length === 1 ? names[0] : "undefined";
      continue;
    }
    const functionDeclaration = /^function\s+([A-Za-z_$][\w$]*)\s*(\([\s\S]*)$/.exec(statement);
    if (functionDeclaration) {
      hoisted.push(functionDeclaration[1]);
      body.push(`globalThis.${functionDeclaration[1]} = ${functionDeclaration[1]} = function ${functionDeclaration[1]}${functionDeclaration[2]};`);
      if (isLast) result = functionDeclaration[1];
      continue;
    }
    const classDeclaration = /^class\s+([A-Za-z_$][\w$]*)\s*([\s\S]*)$/.exec(statement);
    if (classDeclaration) {
      hoisted.push(classDeclaration[1]);
      body.push(`globalThis.${classDeclaration[1]} = ${classDeclaration[1]} = class ${classDeclaration[1]} ${classDeclaration[2]};`);
      if (isLast) result = classDeclaration[1];
      continue;
    }
    if (isLast) result = statement;
    else body.push(`${statement};`);
  }
  const declarations = [...new Set(hoisted)];
  return `${declarations.length ? `var ${declarations.join(", ")};\n` : ""}(async () => {\n${body.join("\n")}\nreturn { value: (${result}) };\n})()`;
}

export class Transpiler {
  constructor(options = {}) {
    this.options = options;
  }
  transformSync(source, loader = this.options.loader ?? "tsx") {
    if (this.options.replMode) return transformReplSource(source);
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

export class HTMLRewriter {
  constructor() {
    this._elementHandlers = [];
    this._documentHandlers = [];
  }
  on(selector, handlers = {}) {
    this._elementHandlers.push({ selector: String(selector), handlers });
    return this;
  }
  onDocument() { return this; }
  transform(response) {
    const source = response instanceof Response || response instanceof Blob || response?.text
      ? response
      : new Response(response);
    const rewriter = this;
    return new Response({
      async text() {
        return rewriter._transformText(await source.text());
      },
      async arrayBuffer() {
        return new TextEncoder().encode(await this.text()).buffer;
      },
    }, {
      status: response?.status ?? 200,
      headers: response?.headers,
    });
  }
  _transformText(input) {
    let html = String(input);
    for (const { selector, handlers } of this._elementHandlers) {
      if (!/^[A-Za-z][\w:-]*$/.test(selector) || typeof handlers?.element !== "function") continue;
      const tag = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`<(${tag})(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
      html = html.replace(pattern, (match, name, attrs = "", inner = "") => {
        const state = { inner, replaceInner: false, html: false };
        const element = {
          tagName: String(name).toLowerCase(),
          setInnerContent(value, options = {}) {
            state.inner = String(value);
            state.replaceInner = true;
            state.html = Boolean(options?.html);
          },
        };
        handlers.element(element);
        if (!state.replaceInner) return match;
        const nextInner = state.html ? state.inner : escapeHTML(state.inner);
        return `<${name}${attrs ?? ""}>${nextInner}</${name}>`;
      });
    }
    return html;
  }
}

export class FileSystemRouter {
  constructor(options) {
    if (options == null || typeof options !== "object") throw new TypeError("Expected object");
    if (options.style !== "nextjs") throw new TypeError("Only 'nextjs' style is currently implemented");
    if (typeof options.dir !== "string") throw new TypeError("Expected dir to be a string");
    if (options.origin !== undefined && typeof options.origin !== "string") throw new TypeError("Expected origin to be a string");
    if (options.assetPrefix !== undefined && typeof options.assetPrefix !== "string") throw new TypeError("Expected assetPrefix to be a string");
    if (options.fileExtensions !== undefined && (!Array.isArray(options.fileExtensions) || options.fileExtensions.some((value) => typeof value !== "string"))) {
      throw new TypeError("Expected fileExtensions to be an Array of strings");
    }
    this.options = { ...options };
    this.style = "nextjs";
    this.origin = options.origin ?? "";
    this.assetPrefix = options.assetPrefix ?? "";
    this._dir = options.dir;
    this._extensions = (options.fileExtensions ?? [".tsx", ".jsx", ".ts", ".mjs", ".cjs", ".js"])
      .filter(Boolean)
      .map((value) => value.startsWith(".") ? value : `.${value}`);
    this._records = [];
    this.routes = Object.create(null);
    this.reload();
  }

  match(input) {
    const { pathname, query } = normalizeRouterInput(input);
    const normalized = normalizeRoutePath(pathname);
    let best = null;
    for (const record of this._records) {
      const params = matchFileSystemRoute(record, normalized);
      if (params == null) continue;
      if (best == null || compareFileSystemRoutes(record, best.record) < 0) best = { record, params };
    }
    if (best == null) return null;
    const { record, params } = best;
    const resultQuery = { ...params, ...query };
    let src = record.relative;
    if (this.assetPrefix) src = `${this.assetPrefix.replace(/\/+$/, "")}/${src.replace(/^\/+/, "")}`;
    if (this.origin) src = `${this.origin.replace(/\/+$/, "")}/${src.replace(/^\/+/, "")}`;
    return {
      filePath: record.filePath,
      kind: record.kind,
      name: record.name,
      pathname: normalized,
      src,
      params,
      query: resultQuery,
    };
  }

  reload() {
    const routes = Object.create(null);
    const records = [];
    if (cottontail.existsSync(this._dir)) {
      for (const entry of walkFiles(this._dir, { dot: false, onlyFiles: true })) {
        const relative = String(entry.relative).replace(/\\/g, "/");
        const extension = this._extensions.find((candidate) => relative.endsWith(candidate));
        if (!extension) continue;
        const name = routePathFromFile(relative, extension);
        const record = makeFileSystemRouteRecord(name, entry.absolute, relative);
        routes[name] = entry.absolute;
        records.push(record);
      }
    }
    this.routes = routes;
    this._records = records;
    return this;
  }
}

function normalizeRoutePath(value) {
  let pathname = String(value || "/").split(/[?#]/, 1)[0] || "/";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  pathname = pathname.replace(/\/+/g, "/");
  if (pathname === "/index") pathname = "/";
  else if (pathname.endsWith("/index")) pathname = pathname.slice(0, -6) || "/";
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  return pathname || "/";
}

function normalizeRouterInput(input) {
  if (input == null) throw new TypeError("Expected string, Request or Response");
  let raw;
  if (typeof input === "string") raw = input;
  else if (typeof input.url === "string") raw = input.url;
  else if (typeof input.href === "string") raw = input.href;
  else if (typeof input.pathname === "string") raw = `${input.pathname}${input.search ?? ""}`;
  else throw new TypeError("Expected string, Request or Response");
  const query = {};
  const queryStart = raw.indexOf("?");
  if (queryStart !== -1) {
    const hashStart = raw.indexOf("#", queryStart);
    const queryText = raw.slice(queryStart + 1, hashStart === -1 ? raw.length : hashStart);
    for (const part of queryText.split("&")) {
      if (!part) continue;
      const separator = part.indexOf("=");
      const decode = (value) => decodeURIComponent(value.replace(/\+/g, " "));
      const key = decode(separator === -1 ? part : part.slice(0, separator));
      query[key] = decode(separator === -1 ? "" : part.slice(separator + 1));
    }
  }
  let url;
  try {
    url = new URL(raw, "http://cottontail.invalid");
  } catch {
    return { pathname: queryStart === -1 ? raw : raw.slice(0, queryStart), query };
  }
  return { pathname: url.pathname, query };
}

function routePathFromFile(file, extension) {
  let route = String(file).replace(/\\/g, "/").slice(0, -extension.length);
  route = route.replace(/\/index$/, "").replace(/^index$/, "");
  return `/${route}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function makeFileSystemRouteRecord(name, filePath, relative) {
  const segments = name === "/" ? [] : name.slice(1).split("/");
  let kind = "exact";
  let rank = 0;
  if (segments.some((segment) => /^\[\[\.\.\.[^\]]+\]\]$/.test(segment))) {
    kind = "catch-all-optional";
    rank = 3;
  } else if (segments.some((segment) => /^\[\.\.\.[^\]]+\]$/.test(segment))) {
    kind = "catch-all";
    rank = 2;
  } else if (segments.some((segment) => /^\[[^\]]+\]$/.test(segment))) {
    kind = "dynamic";
    rank = 1;
  }
  return { name, filePath, relative, segments, kind, rank };
}

function compareFileSystemRoutes(left, right) {
  if (left.rank !== right.rank) return left.rank - right.rank;
  const leftStatic = left.segments.filter((segment) => !segment.startsWith("[")).length;
  const rightStatic = right.segments.filter((segment) => !segment.startsWith("[")).length;
  if (leftStatic !== rightStatic) return rightStatic - leftStatic;
  return right.segments.length - left.segments.length;
}

function matchFileSystemRoute(record, pathname) {
  const inputSegments = pathname === "/" ? [] : pathname.slice(1).split("/").map((value) => decodeURIComponent(value));
  const params = {};
  let inputIndex = 0;
  for (let routeIndex = 0; routeIndex < record.segments.length; routeIndex += 1) {
    const segment = record.segments[routeIndex];
    const optionalCatchAll = segment.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
    if (optionalCatchAll) {
      params[optionalCatchAll[1]] = inputSegments.slice(inputIndex).join("/");
      inputIndex = inputSegments.length;
      continue;
    }
    const catchAll = segment.match(/^\[\.\.\.([^\]]+)\]$/);
    if (catchAll) {
      if (inputIndex >= inputSegments.length) return null;
      params[catchAll[1]] = inputSegments.slice(inputIndex).join("/");
      inputIndex = inputSegments.length;
      continue;
    }
    const dynamic = segment.match(/^\[([^\]]+)\]$/);
    if (dynamic) {
      if (inputIndex >= inputSegments.length) return null;
      params[dynamic[1]] = inputSegments[inputIndex++];
      continue;
    }
    if (inputSegments[inputIndex++] !== segment) return null;
  }
  return inputIndex === inputSegments.length ? params : null;
}

export class Terminal {}
export class RedisClient {}
export class S3Client {}
export const redis = null;
export const postgres = null;
export const s3 = null;
function secretsError(message, code = "ERR_INVALID_ARG_TYPE") {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function validateSecretOptions(method, options, needsValue = false) {
  if (options == null) throw secretsError(`secrets.${method} requires an options object`);
  if (typeof options !== "object" || Array.isArray(options)) throw secretsError("Expected options to be an object");
  if (typeof options.service !== "string" || typeof options.name !== "string") {
    throw secretsError("Expected service and name to be strings");
  }
  if (!options.service || !options.name) throw secretsError("Expected service and name to not be empty");
  if (needsValue && typeof options.value !== "string") throw secretsError("Expected 'value' to be a string");
  return options;
}

function secretCommand(args, input = undefined) {
  return spawnSync(args, { input, stdin: input == null ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
}

function secretCommandError(result, operation) {
  const message = String(result.stderr || result.stdout || `Unable to ${operation} secret`).trim();
  const error = new Error(message);
  error.code = "ERR_SECRETS";
  throw error;
}

export const secrets = {
  async get(rawOptions) {
    const options = validateSecretOptions("get", rawOptions);
    if (process.platform === "darwin") {
      const result = secretCommand(["security", "find-generic-password", "-s", options.service, "-a", options.name, "-g"]);
      if (result.exitCode === 44) return null;
      if (result.exitCode !== 0) secretCommandError(result, "read");
      const output = String(result.stderr || result.stdout);
      const hex = /^password:\s+0x([0-9a-f]+)/im.exec(output);
      if (hex) return Buffer.from(hex[1], "hex").toString("utf8");
      const quoted = /^password:\s+"(.*)"\s*$/m.exec(output);
      if (quoted) return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      secretCommandError(result, "read");
    }
    if (process.platform === "linux") {
      const result = secretCommand(["secret-tool", "lookup", "service", options.service, "name", options.name]);
      if (result.exitCode !== 0 || String(result.stdout).length === 0) return null;
      return String(result.stdout).replace(/\r?\n$/, "");
    }
    throw secretsError(`Bun.secrets is not supported on ${process.platform}`, "ERR_NOT_SUPPORTED");
  },
  async set(rawOptions) {
    const options = validateSecretOptions("set", rawOptions, true);
    if (options.value === "") {
      await this.delete(options);
      return;
    }
    if (process.platform === "darwin") {
      const args = ["security", "add-generic-password", "-U", "-s", options.service, "-a", options.name, "-w", options.value];
      if (options.allowUnrestrictedAccess === true) args.push("-A");
      const result = secretCommand(args);
      if (result.exitCode !== 0) secretCommandError(result, "store");
      return;
    }
    if (process.platform === "linux") {
      const result = secretCommand(
        ["secret-tool", "store", `--label=${options.service}`, "service", options.service, "name", options.name],
        `${options.value}\n`,
      );
      if (result.exitCode !== 0) secretCommandError(result, "store");
      return;
    }
    throw secretsError(`Bun.secrets is not supported on ${process.platform}`, "ERR_NOT_SUPPORTED");
  },
  async delete(rawOptions) {
    const options = validateSecretOptions("delete", rawOptions);
    if (process.platform === "darwin") {
      const result = secretCommand(["security", "delete-generic-password", "-s", options.service, "-a", options.name]);
      if (result.exitCode === 44) return false;
      if (result.exitCode !== 0) secretCommandError(result, "delete");
      return true;
    }
    if (process.platform === "linux") {
      const existing = await this.get(options);
      if (existing == null) return false;
      const result = secretCommand(["secret-tool", "clear", "service", options.service, "name", options.name]);
      if (result.exitCode !== 0) secretCommandError(result, "delete");
      return true;
    }
    throw secretsError(`Bun.secrets is not supported on ${process.platform}`, "ERR_NOT_SUPPORTED");
  },
};
const passwordAlgorithmIds = { argon2id: 0, argon2i: 1, argon2d: 2, bcrypt: 3 };

function passwordBytes(value, name) {
  if (typeof value === "symbol") throw new TypeError(`${name} must be a string or BufferSource`);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return asBuffer(value);
  return new TextEncoder().encode(String(value));
}

function passwordAlgorithm(value = undefined) {
  let label = "argon2id";
  let timeCost = 2;
  let memoryCost = 65536;
  let cost = 10;
  if (value !== undefined) {
    if (typeof value === "string") {
      label = value;
    } else if (value && typeof value === "object") {
      if (typeof value.algorithm !== "string") throw new TypeError("options.algorithm must be a string");
      label = value.algorithm;
      if (label === "bcrypt" && value.cost !== undefined) cost = Number(value.cost);
      if (label !== "bcrypt") {
        if (value.timeCost !== undefined) timeCost = Number(value.timeCost);
        if (value.memoryCost !== undefined) memoryCost = Number(value.memoryCost);
      }
    } else {
      throw new TypeError("algorithm must be a string or options object");
    }
  }
  if (!(label in passwordAlgorithmIds)) throw new TypeError("Unsupported password algorithm");
  if (label === "bcrypt") {
    if (!Number.isInteger(cost) || cost < 4 || cost > 31) throw new RangeError("Rounds must be between 4 and 31");
  } else {
    if (!Number.isInteger(timeCost) || timeCost < 1) throw new RangeError("Time cost must be greater than 0");
    if (!Number.isInteger(memoryCost) || memoryCost < 1) throw new RangeError("Memory cost must be greater than 0");
  }
  return { id: passwordAlgorithmIds[label], label, timeCost, memoryCost, cost };
}

function passwordHashSync(value, algorithm = undefined) {
  if (arguments.length === 0) throw new TypeError("password is required");
  const bytes = passwordBytes(value, "password");
  if (bytes.byteLength === 0) throw new TypeError("password must not be empty");
  const options = passwordAlgorithm(algorithm);
  return cottontail.passwordHashSync(options.id, bytes, options.timeCost, options.memoryCost, options.cost);
}

function passwordHash(value, algorithm = undefined) {
  if (arguments.length === 0) throw new TypeError("password is required");
  const bytes = passwordBytes(value, "password");
  if (bytes.byteLength === 0) throw new TypeError("password must not be empty");
  const options = passwordAlgorithm(algorithm);
  return Promise.resolve().then(() => cottontail.passwordHashSync(options.id, bytes, options.timeCost, options.memoryCost, options.cost));
}

function inferPasswordAlgorithm(hash) {
  if (hash.startsWith("$argon2id$")) return "argon2id";
  if (hash.startsWith("$argon2i$")) return "argon2i";
  if (hash.startsWith("$argon2d$")) return "argon2d";
  if (hash.startsWith("$2") || hash.startsWith("$bcrypt$")) return "bcrypt";
  throw new TypeError("Unsupported password algorithm");
}

function passwordVerifySync(value, hashValue, algorithm = undefined) {
  if (arguments.length < 2) throw new TypeError("password and hash are required");
  const bytes = passwordBytes(value, "password");
  const hashBytes = passwordBytes(hashValue, "hash");
  if (bytes.byteLength === 0 || hashBytes.byteLength === 0) return false;
  const hash = new TextDecoder().decode(hashBytes);
  const options = passwordAlgorithm(algorithm === undefined ? inferPasswordAlgorithm(hash) : algorithm);
  return cottontail.passwordVerifySync(options.id, bytes, hashBytes);
}

function passwordVerify(value, hashValue, algorithm = undefined) {
  if (arguments.length < 2) throw new TypeError("password and hash are required");
  const bytes = passwordBytes(value, "password");
  const hashBytes = passwordBytes(hashValue, "hash");
  if (bytes.byteLength === 0 || hashBytes.byteLength === 0) return Promise.resolve(false);
  const hash = new TextDecoder().decode(hashBytes);
  const options = passwordAlgorithm(algorithm === undefined ? inferPasswordAlgorithm(hash) : algorithm);
  return Promise.resolve().then(() => cottontail.passwordVerifySync(options.id, bytes, hashBytes));
}

export const password = {
  hash: passwordHash,
  hashSync: passwordHashSync,
  verify: passwordVerify,
  verifySync: passwordVerifySync,
};

function parseSemverParts(value) {
  return String(value)
    .trim()
    .replace(/^[^\d]*/, "")
    .split(/[+-]/, 1)[0]
    .split(".")
    .map((part) => {
      const match = String(part).match(/^\d+/);
      return match ? Number(match[0]) : 0;
    });
}

function compareSemver(left, right) {
  const a = parseSemverParts(left);
  const b = parseSemverParts(right);
  for (let index = 0; index < Math.max(a.length, b.length, 3); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

function semverComparatorSatisfies(version, comparator) {
  const text = String(comparator).trim();
  if (!text || text === "*" || text.toLowerCase() === "x") return true;
  const match = text.match(/^(<=|>=|<|>|=|==|!=|~\s*|\^\s*)?\s*([^\s]+)$/);
  if (!match) return false;
  const operator = (match[1] || "=").trim();
  const target = match[2];
  const order = compareSemver(version, target);
  if (operator === "<") return order < 0;
  if (operator === "<=") return order <= 0;
  if (operator === ">") return order > 0;
  if (operator === ">=") return order >= 0;
  if (operator === "!=") return order !== 0;
  if (operator === "^") {
    const current = parseSemverParts(version);
    const base = parseSemverParts(target);
    const upper = [...base];
    const majorIndex = base.findIndex((part) => part > 0);
    const bumpIndex = majorIndex < 0 ? 0 : majorIndex;
    upper[bumpIndex] = (upper[bumpIndex] || 0) + 1;
    for (let index = bumpIndex + 1; index < Math.max(upper.length, 3); index += 1) upper[index] = 0;
    return compareSemver(current.join("."), base.join(".")) >= 0 && compareSemver(current.join("."), upper.join(".")) < 0;
  }
  if (operator === "~") {
    const base = parseSemverParts(target);
    const upper = [...base];
    const bumpIndex = base.length > 1 ? 1 : 0;
    upper[bumpIndex] = (upper[bumpIndex] || 0) + 1;
    for (let index = bumpIndex + 1; index < Math.max(upper.length, 3); index += 1) upper[index] = 0;
    return compareSemver(version, base.join(".")) >= 0 && compareSemver(version, upper.join(".")) < 0;
  }
  return order === 0;
}

function semverComparators(range) {
  const tokens = String(range).trim().split(/\s+/).filter(Boolean);
  const comparators = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (/^(?:<=|>=|<|>|=|==|!=|\^|~)$/.test(tokens[index]) && index + 1 < tokens.length) {
      comparators.push(`${tokens[index]}${tokens[index + 1]}`);
      index += 1;
    } else {
      comparators.push(tokens[index]);
    }
  }
  return comparators;
}

export const semver = {
  order(left, right) {
    return compareSemver(left, right);
  },
  satisfies(version, range) {
    return String(range)
      .split("||")
      .some((part) => semverComparators(part).every((comparator) => semverComparatorSatisfies(version, comparator)));
  },
};
const markdownBooleanOptions = [
  "tables",
  "strikethrough",
  "tasklists",
  "permissiveAutolinks",
  "permissiveUrlAutolinks",
  "permissiveWwwAutolinks",
  "permissiveEmailAutolinks",
  "hardSoftBreaks",
  "wikiLinks",
  "underline",
  "latexMath",
  "collapseWhitespace",
  "permissiveAtxHeaders",
  "noIndentedCodeBlocks",
  "noHtmlBlocks",
  "noHtmlSpans",
  "tagFilter",
  "headingIds",
  "autolinkHeadings",
];

function markdownFlags(options = {}) {
  let flags = 0;
  const values = { tables: true, strikethrough: true, tasklists: true };
  if (options && typeof options === "object") Object.assign(values, options);
  if (values.autolinks === true) values.permissiveAutolinks = true;
  else if (values.autolinks && typeof values.autolinks === "object") {
    values.permissiveUrlAutolinks = values.autolinks.url === true;
    values.permissiveWwwAutolinks = values.autolinks.www === true;
    values.permissiveEmailAutolinks = values.autolinks.email === true;
  }
  if (values.headings === true) {
    values.headingIds = true;
    values.autolinkHeadings = true;
  } else if (values.headings && typeof values.headings === "object") {
    values.headingIds = values.headings.ids === true;
    values.autolinkHeadings = values.headings.autolink === true;
  }
  for (let index = 0; index < markdownBooleanOptions.length; index += 1) {
    const camel = markdownBooleanOptions[index];
    const snake = camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if (values[camel] === true || values[snake] === true) flags += 2 ** index;
  }
  return flags;
}

function markdownInput(value) {
  if (value == null) throw new TypeError("Expected a string or buffer to render");
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return new TextDecoder().decode(asBuffer(value));
  throw new TypeError("Expected a string or buffer to render");
}

const markdownBlockCallbacks = [
  null, "blockquote", "list", "list", "listItem", "hr", "heading", "code", "html", "paragraph",
  "table", "thead", "tbody", "tr", "th", "td",
];
const markdownSpanCallbacks = ["emphasis", "strong", "link", "image", "codespan", "strikethrough"];

function markdownBlockMeta(entry, stack, source, slug) {
  switch (entry.type) {
    case 2: return { ordered: false, depth: stack.filter((item) => item.type === 2 || item.type === 3).length };
    case 3: return { ordered: true, start: entry.data, depth: stack.filter((item) => item.type === 2 || item.type === 3).length };
    case 4: {
      const parent = stack[stack.length - 1];
      const ordered = parent?.type === 3;
      const depth = Math.max(0, stack.filter((item) => item.type === 2 || item.type === 3).length - 1);
      const meta = { index: entry.childIndex, depth, ordered };
      if (ordered) meta.start = parent.data;
      const taskMark = entry.data & 0xff;
      if (taskMark !== 0) meta.checked = taskMark !== 32;
      return meta;
    }
    case 6: return slug == null ? { level: entry.data } : { level: entry.data, id: slug };
    case 7: {
      if ((entry.flags & 0x10) === 0) return undefined;
      let end = entry.data;
      while (end < source.length && !/[\s]/.test(source[end])) end += 1;
      const language = source.slice(entry.data, end);
      return language ? { language } : undefined;
    }
    case 14:
    case 15: {
      const align = [undefined, "left", "center", "right"][entry.data & 3];
      return { align };
    }
    default: return undefined;
  }
}

function renderMarkdownCallbacks(source, callbacks = {}, options = {}) {
  const events = JSON.parse(cottontail.markdownEvents(source, markdownFlags(options)));
  const stack = [{ type: 0, children: "", childIndex: 0 }];
  const appendResult = (result) => {
    if (result != null) stack[stack.length - 1].children += String(result);
  };
  for (const event of events) {
    const [kind, type, first, second] = event;
    if (kind === "b") {
      if (type === 0) continue;
      let childIndex = 0;
      if (type === 4) {
        const parent = stack[stack.length - 1];
        childIndex = parent.childIndex++;
      }
      stack.push({ type, data: first, flags: second, children: "", childIndex });
      continue;
    }
    if (kind === "s") {
      stack.push({ type, detail: { href: first, title: second }, children: "", childIndex: 0 });
      continue;
    }
    if (kind === "t") {
      const content = first;
      if (type === 1 || type === 2 || type === 3 || typeof callbacks.text !== "function") appendResult(content);
      else appendResult(callbacks.text(content));
      continue;
    }
    if (kind === "S") {
      const entry = stack.pop();
      const name = markdownSpanCallbacks[type];
      const callback = callbacks?.[name];
      if (typeof callback !== "function") appendResult(entry.children);
      else {
        let meta;
        if (type === 2) meta = entry.detail.title ? entry.detail : { href: entry.detail.href };
        else if (type === 3) meta = entry.detail.title
          ? { src: entry.detail.href, title: entry.detail.title }
          : { src: entry.detail.href };
        appendResult(meta === undefined ? callback(entry.children) : callback(entry.children, meta));
      }
      continue;
    }
    if (kind === "B") {
      if (type === 0) continue;
      const entry = stack.pop();
      const callback = callbacks?.[markdownBlockCallbacks[type]];
      if (typeof callback !== "function") appendResult(entry.children);
      else {
        const meta = markdownBlockMeta(entry, stack, source, first);
        appendResult(meta === undefined ? callback(entry.children) : callback(entry.children, meta));
      }
    }
  }
  return stack[0].children;
}

const markdownBlockTags = [
  null, "blockquote", "ul", "ol", "li", "hr", null, "pre", "html", "p",
  "table", "thead", "tbody", "tr", "th", "td",
];
const markdownSpanTags = ["em", "strong", "a", "img", "code", "del", "math", "math", "a", "u"];

function renderMarkdownReact(source, components = {}, options = {}) {
  const events = JSON.parse(cottontail.markdownEvents(source, markdownFlags(options)));
  const elementSymbol = Symbol.for(Number(options?.reactVersion) <= 18 ? "react.element" : "react.transitional.element");
  const createElement = (tag, props) => ({
    $$typeof: elementSymbol,
    type: components?.[tag] && typeof components[tag] !== "boolean" ? components[tag] : tag,
    key: null,
    ref: null,
    props,
  });
  const stack = [{ type: 0, children: [] }];
  for (const event of events) {
    const [kind, type, first, second] = event;
    if (kind === "b") {
      if (type !== 0) stack.push({ type, data: first, flags: second, children: [] });
      continue;
    }
    if (kind === "s") {
      stack.push({ type, detail: { href: first, title: second }, children: [] });
      continue;
    }
    if (kind === "t") {
      if (type === 2) stack[stack.length - 1].children.push(createElement("br", {}));
      else stack[stack.length - 1].children.push(first);
      continue;
    }
    if (kind === "S") {
      const entry = stack.pop();
      const tag = markdownSpanTags[type];
      const props = {};
      if (type === 2) {
        props.href = entry.detail.href;
        if (entry.detail.title) props.title = entry.detail.title;
      } else if (type === 3) {
        props.src = entry.detail.href;
        if (entry.detail.title) props.title = entry.detail.title;
        const alt = entry.children.filter((child) => typeof child === "string").join("");
        if (alt) props.alt = alt;
      } else if (type === 8) {
        props.target = entry.detail.href;
      } else if (type === 7) {
        props.display = true;
        props.children = entry.children;
      }
      if (type !== 3 && props.children === undefined) props.children = entry.children;
      stack[stack.length - 1].children.push(createElement(tag, props));
      continue;
    }
    if (kind === "B") {
      if (type === 0) continue;
      const entry = stack.pop();
      const tag = type === 6 ? `h${Math.min(6, Math.max(1, entry.data))}` : markdownBlockTags[type];
      const props = {};
      if (type === 6 && first != null) props.id = first;
      else if (type === 3) props.start = entry.data;
      else if (type === 4) {
        const taskMark = entry.data & 0xff;
        if (taskMark !== 0) props.checked = taskMark !== 32;
      } else if (type === 7 && (entry.flags & 0x10) !== 0) {
        let end = entry.data;
        while (end < source.length && !/[\s]/.test(source[end])) end += 1;
        const language = source.slice(entry.data, end);
        if (language) props.language = language;
      } else if (type === 14 || type === 15) {
        const align = [undefined, "left", "center", "right"][entry.data & 3];
        if (align) props.align = align;
      }
      if (type !== 5) props.children = entry.children;
      stack[stack.length - 1].children.push(createElement(tag, props));
    }
  }
  return {
    $$typeof: elementSymbol,
    type: Symbol.for("react.fragment"),
    key: null,
    ref: null,
    props: { children: stack[0].children },
  };
}

export const markdown = {
  html(input, options = {}) {
    return cottontail.markdownHtml(markdownInput(input), markdownFlags(options));
  },
  render(input, callbacks = {}, options = {}) {
    return renderMarkdownCallbacks(markdownInput(input), callbacks, options);
  },
  react(input, components = {}, options = {}) {
    return renderMarkdownReact(markdownInput(input), components, options);
  },
};
export const embeddedFiles = [];
let gcAggressionLevelValue = 0;
export const unsafe = {
  arrayBufferToString(value) {
    if (value instanceof Uint16Array) {
      let output = "";
      for (let index = 0; index < value.length; index += 0x8000) {
        output += String.fromCharCode(...value.subarray(index, index + 0x8000));
      }
      return output;
    }
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : asBuffer(value);
    return new TextDecoder().decode(bytes);
  },
  gcAggressionLevel(value = undefined) {
    const previous = gcAggressionLevelValue;
    if (value !== undefined) gcAggressionLevelValue = Number(value) || 0;
    return previous;
  },
};

const defaultCSRFSecret = "cottontail-default-csrf-secret";
const defaultCSRFMaxAgeMs = 24 * 60 * 60 * 1000;
const csrfHeaderLength = 32;

function csrfAlgorithm(algorithm = "sha256") {
  const normalized = String(algorithm ?? "sha256").toLowerCase().replace(/_/g, "-");
  if (normalized === "blake2b256") return { name: "blake2b512", length: 32 };
  if (normalized === "blake2b512") return { name: "blake2b512", length: 64 };
  if (normalized === "sha512-256") return { name: "sha512", length: 32 };
  if (normalized === "sha256" || normalized === "sha384" || normalized === "sha512") return { name: normalized };
  return { name: normalized };
}

function csrfWriteU64(bytes, offset, value) {
  let current = BigInt(Math.max(0, Math.trunc(Number(value))));
  for (let index = offset + 7; index >= offset; index -= 1) {
    bytes[index] = Number(current & 0xffn);
    current >>= 8n;
  }
}

function csrfReadU64(bytes, offset) {
  let value = 0n;
  for (let index = offset; index < offset + 8; index += 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  return Number(value);
}

function csrfMac(secret, algorithm, payload) {
  const spec = csrfAlgorithm(algorithm);
  let digest = asBuffer(createHmac(spec.name, secret).update(payload).digest());
  if (spec.length != null) digest = digest.subarray(0, spec.length);
  return digest;
}

function csrfEncode(bytes, encoding = "base64url") {
  const buffer = globalThis.Buffer.from(bytes);
  if (encoding === "hex") return buffer.toString("hex");
  if (encoding === "base64") return buffer.toString("base64");
  if (encoding === "base64url" || encoding == null) {
    return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  throw new TypeError(`Unsupported CSRF token encoding: ${encoding}`);
}

function csrfDecode(token, encoding = "base64url") {
  const text = String(token);
  if (encoding === "hex") {
    if (text.length % 2 !== 0 || /[^0-9a-f]/i.test(text)) return null;
    return asBuffer(globalThis.Buffer.from(text, "hex"));
  }
  if (encoding === "base64") return asBuffer(globalThis.Buffer.from(text, "base64"));
  if (encoding === "base64url" || encoding == null) {
    if (/[^A-Za-z0-9_-]/.test(text)) return null;
    const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
    if (base64.length % 4 === 1) return null;
    return asBuffer(globalThis.Buffer.from(base64 + "=".repeat((4 - (base64.length % 4)) % 4), "base64"));
  }
  throw new TypeError(`Unsupported CSRF token encoding: ${encoding}`);
}

function csrfSecret(value) {
  const secret = value ?? defaultCSRFSecret;
  if (String(secret).length === 0) throw new TypeError("CSRF secret must not be empty");
  return secret;
}

export const CSRF = {
  generate(secret = defaultCSRFSecret, options = {}) {
    const actualSecret = csrfSecret(secret);
    const now = Date.now();
    const expiresIn = options.expiresIn == null ? defaultCSRFMaxAgeMs : Number(options.expiresIn);
    const header = new Uint8Array(csrfHeaderLength);
    csrfWriteU64(header, 0, now);
    csrfWriteU64(header, 8, now + Math.max(0, expiresIn));
    header.set(randomBytes(16), 16);
    const mac = csrfMac(actualSecret, options.algorithm, header);
    return csrfEncode(concatManyBuffers([header, mac]), options.encoding ?? "base64url");
  },
  verify(token, options = {}) {
    if (String(token ?? "").length === 0) throw new TypeError("CSRF token must not be empty");
    const actualSecret = csrfSecret(options.secret);
    const bytes = csrfDecode(token, options.encoding ?? "base64url");
    if (!bytes || bytes.byteLength <= csrfHeaderLength) return false;
    const header = bytes.subarray(0, csrfHeaderLength);
    const mac = bytes.subarray(csrfHeaderLength);
    const expected = csrfMac(actualSecret, options.algorithm, header);
    if (mac.byteLength !== expected.byteLength) return false;
    let diff = 0;
    for (let index = 0; index < mac.byteLength; index += 1) diff |= mac[index] ^ expected[index];
    if (diff !== 0) return false;
    const issuedAt = csrfReadU64(header, 0);
    const expiresAt = csrfReadU64(header, 8);
    const now = Date.now();
    if (expiresAt <= now) return false;
    if (options.maxAge != null && now - issuedAt > Number(options.maxAge)) return false;
    return true;
  },
};

const inspectCustomSymbol = Symbol.for("nodejs.util.inspect.custom");
const domExceptionCodes = {
  IndexSizeError: 1,
  DOMStringSizeError: 2,
  HierarchyRequestError: 3,
  WrongDocumentError: 4,
  InvalidCharacterError: 5,
  NoDataAllowedError: 6,
  NoModificationAllowedError: 7,
  NotFoundError: 8,
  NotSupportedError: 9,
  InUseAttributeError: 10,
  InvalidStateError: 11,
  SyntaxError: 12,
  InvalidModificationError: 13,
  NamespaceError: 14,
  InvalidAccessError: 15,
  ValidationError: 16,
  TypeMismatchError: 17,
  SecurityError: 18,
  NetworkError: 19,
  AbortError: 20,
  URLMismatchError: 21,
  QuotaExceededError: 22,
  TimeoutError: 23,
  InvalidNodeTypeError: 24,
  DataCloneError: 25,
};

class CottontailDOMException extends Error {
  constructor(message = "", name = "Error") {
    super(String(message));
    this.name = String(name);
  }

  get code() {
    return domExceptionCodes[this.name] ?? 0;
  }

  get [Symbol.toStringTag]() {
    return "DOMException";
  }
}

const eventState = new WeakMap();
const eventTargetWeakHandler = Symbol.for("nodejs.internal.event_target.kWeakHandler");
const NativeWeakRef = globalThis.WeakRef;
const forcedCollectedWeakTargets = new WeakSet();
const cottontailWeakRefs = new Set();

function isForcedCollectableAbortSignal(target) {
  const state = abortSignalState?.get?.(target);
  if (!state) return false;
  return !(state.timeoutTimer != null && activeTimeoutSignals.has(target));
}

class CottontailWeakRef {
  constructor(target, options = undefined) {
    if (target == null || (typeof target !== "object" && typeof target !== "function")) {
      throw new TypeError("WeakRef target must be an object");
    }
    this._native = NativeWeakRef ? new NativeWeakRef(target) : { deref: () => target };
    this._target = options?.internal === true ? undefined : target;
    this._collected = false;
    cottontailWeakRefs.add(this);
  }

  deref() {
    if (this._collected) return undefined;
    const target = this._native.deref();
    if (target && forcedCollectedWeakTargets.has(target)) return undefined;
    return target;
  }
}

function internalWeakRef(target) {
  return new CottontailWeakRef(target, { internal: true });
}

function runForcedWeakRefGc() {
  for (const ref of cottontailWeakRefs) {
    const target = ref._target;
    if (!target) continue;
    if (isForcedCollectableAbortSignal(target)) {
      forcedCollectedWeakTargets.add(target);
      ref._target = undefined;
      ref._collected = true;
    }
  }
}

if (NativeWeakRef) {
  Object.defineProperty(globalThis, "WeakRef", {
    value: CottontailWeakRef,
    configurable: true,
    writable: true,
  });
}

Object.defineProperty(globalThis, "__cottontailForcedWeakRefGc", {
  value: runForcedWeakRefGc,
  configurable: true,
  writable: true,
});

function eventStateFor(event) {
  const state = eventState.get(event);
  if (!state) throw new TypeError("Illegal invocation");
  return state;
}

function setEventTarget(event, target, currentTarget) {
  const state = eventState.get(event);
  if (state) {
    if (state.target == null) state.target = target;
    state.currentTarget = currentTarget;
    return true;
  }
  return false;
}

function markEventTrusted(event) {
  const state = eventState.get(event);
  if (state) {
    state.isTrusted = true;
    return;
  }
  try {
    Object.defineProperty(event, "isTrusted", { value: true, configurable: true });
  } catch {}
}

class CottontailEvent {
  constructor(type, init = {}) {
    eventState.set(this, {
      type: String(type),
      bubbles: Boolean(init.bubbles),
      cancelable: Boolean(init.cancelable),
      composed: Boolean(init.composed),
      defaultPrevented: false,
      target: null,
      currentTarget: null,
      isTrusted: false,
    });
  }

  get type() {
    return eventStateFor(this).type;
  }

  get bubbles() {
    return eventStateFor(this).bubbles;
  }

  get cancelable() {
    return eventStateFor(this).cancelable;
  }

  get composed() {
    return eventStateFor(this).composed;
  }

  get defaultPrevented() {
    return eventStateFor(this).defaultPrevented;
  }

  get target() {
    return eventStateFor(this).target;
  }

  get currentTarget() {
    return eventStateFor(this).currentTarget;
  }

  get isTrusted() {
    return eventStateFor(this).isTrusted;
  }

  preventDefault() {
    const state = eventStateFor(this);
    if (state.cancelable) state.defaultPrevented = true;
  }

  get [Symbol.toStringTag]() {
    return "Event";
  }
}

class CottontailCustomEvent extends CottontailEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.detail = init.detail ?? null;
  }
}

class CottontailErrorEvent extends CottontailEvent {
  constructor(type = "error", init = {}) {
    super(type, init);
    this.message = String(init.message ?? "");
    this.filename = String(init.filename ?? "");
    this.lineno = Number(init.lineno ?? 0);
    this.colno = Number(init.colno ?? 0);
    this.error = init.error ?? null;
  }

  [inspectCustomSymbol]() {
    let errorText;
    if (this.error == null) {
      errorText = this.error === undefined ? "undefined" : "null";
    } else if (this.error instanceof globalThis.Error) {
      errorText = `error: ${String(this.error.message ?? "")}\n`;
    } else {
      errorText = nodeInspect(this.error);
    }
    return `ErrorEvent {\n  type: ${JSON.stringify(String(this.type))},\n  message: ${JSON.stringify(String(this.message))},\n  error: ${errorText},\n}`;
  }
}

class CottontailCloseEvent extends CottontailEvent {
  constructor(type = "close", init = {}) {
    super(type, init);
    this.wasClean = Boolean(init.wasClean);
    this.code = Number(init.code ?? 0);
    this.reason = String(init.reason ?? "");
  }
}

class CottontailFile extends Blob {
  constructor(parts, name, options = {}) {
    if (arguments.length < 2) throw new TypeError("File constructor requires file bits and name");
    if (parts == null || typeof parts[Symbol.iterator] !== "function") throw new TypeError("File bits must be iterable");
    super(parts, options);
    this.name = String(name);
    this.lastModified = Number(options.lastModified ?? Date.now());
  }
}

function BunFile(parts, name, options = {}) {
  if (!new.target) throw new TypeError("Class constructor File cannot be invoked without 'new'");
  return Reflect.construct(CottontailFile, [parts, name, options], new.target);
}
BunFile.prototype = CottontailFile.prototype;

Object.defineProperty(CottontailCustomEvent, "name", { value: "CustomEvent", configurable: true });
Object.defineProperty(CottontailErrorEvent, "name", { value: "ErrorEvent", configurable: true });
Object.defineProperty(CottontailCloseEvent, "name", { value: "CloseEvent", configurable: true });
Object.defineProperty(CottontailFile, "name", { value: "File", configurable: true });
Object.defineProperty(BunFile, "name", { value: "File", configurable: true });

class CottontailEventTarget {
  constructor() {
    this.__ctEventListeners = new Map();
  }

  addEventListener(type, listener, options = undefined) {
    if (listener == null) return;
    const name = String(type);
    const listeners = this.__ctEventListeners.get(name) ?? [];
    if (!listeners.some((entry) => entry.listener === listener)) {
      listeners.push({
        listener,
        once: Boolean(options && typeof options === "object" && options.once),
        weak: Boolean(options && typeof options === "object" && options[eventTargetWeakHandler]),
      });
    }
    this.__ctEventListeners.set(name, listeners);
  }

  removeEventListener(type, listener) {
    const name = String(type);
    const listeners = this.__ctEventListeners.get(name);
    if (!listeners) return;
    this.__ctEventListeners.set(name, listeners.filter((entry) => entry.listener !== listener));
    refreshAbortSignalRetention(this);
  }

  dispatchEvent(event) {
    const dispatched = event && typeof event === "object" ? event : new CottontailEvent(String(event));
    if (!setEventTarget(dispatched, this, this)) {
      if (!dispatched.target) dispatched.target = this;
      dispatched.currentTarget = this;
    }
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

function makeTimeoutError() {
  const DOMExceptionClass = globalThis.DOMException ?? CottontailDOMException;
  return new DOMExceptionClass("The operation was aborted due to timeout", "TimeoutError");
}

function nodeTypeError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function invalidAbortSignalArgument(name, value) {
  const received = value === null ? "null" : value === undefined ? "undefined" : typeof value;
  return nodeTypeError(
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be an instance of AbortSignal. Received ${received}`,
  );
}

const abortSignalConstructToken = Symbol("CottontailAbortSignalConstruct");
const abortSignalState = new WeakMap();
const abortControllerState = new WeakMap();
const abortDependantSignals = Symbol("kDependantSignals");
const activeTimeoutSignals = new Set();
const abortQueue = [];
let drainingAbortQueue = false;

class WeakDependantSignalSet {
  constructor() {
    this.refs = new Set();
  }

  add(ref) {
    this.refs.add(ref);
    return this;
  }

  delete(ref) {
    return this.refs.delete(ref);
  }

  prune() {
    for (const ref of [...this.refs]) {
      if (!ref.deref()) this.refs.delete(ref);
    }
  }

  get size() {
    this.prune();
    return this.refs.size;
  }

  [Symbol.iterator]() {
    this.prune();
    return this.refs[Symbol.iterator]();
  }
}

const dependantFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry((held) => {
      const source = held?.source?.deref?.();
      if (!source) return;
      const state = abortSignalState.get(source);
      state?.dependants?.delete(held.ref);
    })
  : null;

function abortSignalStateFor(signal) {
  const state = abortSignalState.get(signal);
  if (!state) throw new TypeError("Value is not an AbortSignal");
  return state;
}

function abortControllerStateFor(controller) {
  const state = abortControllerState.get(controller);
  if (!state) throw new TypeError("Value is not an AbortController");
  return state;
}

function isAbortSignal(value) {
  return abortSignalState.has(value);
}

function cleanupDependants(state) {
  state.dependants.prune();
}

function addDependantSignal(source, dependant) {
  const state = abortSignalStateFor(source);
  const ref = internalWeakRef(dependant);
  state.dependants.add(ref);
  dependantFinalizer?.register(dependant, { source: internalWeakRef(source), ref }, ref);
}

function enqueueDependants(state) {
  cleanupDependants(state);
  for (const ref of state.dependants) {
    const dependant = ref.deref();
    if (dependant) abortQueue.push([dependant, state.reason]);
  }
}

function drainAbortQueue() {
  if (drainingAbortQueue) return;
  drainingAbortQueue = true;
  try {
    while (abortQueue.length > 0) {
      const [signal, reason] = abortQueue.shift();
      abortSignal(signal, reason);
    }
  } finally {
    drainingAbortQueue = false;
  }
}

function abortSignal(signal, reason) {
  const state = abortSignalStateFor(signal);
  if (state.aborted) return;
  state.aborted = true;
  state.reason = reason;
  if (state.timeoutTimer != null) {
    clearTimeout(state.timeoutTimer);
    state.timeoutTimer = null;
  }
  activeTimeoutSignals.delete(signal);
  const EventClass = globalThis.Event ?? CottontailEvent;
  const event = new EventClass("abort");
  markEventTrusted(event);
  signal.dispatchEvent(event);
  enqueueDependants(state);
  drainAbortQueue();
}

function refreshAbortSignalRetention(target) {
  const state = abortSignalState.get(target);
  if (!state?.timeoutTimer || state.aborted) return;
  const listeners = (target.__ctEventListeners?.get?.("abort") ?? []).filter((entry) => !entry.weak);
  if (listeners.length > 0 || typeof state.onabort === "function") {
    activeTimeoutSignals.add(target);
  } else {
    activeTimeoutSignals.delete(target);
  }
}

class CottontailAbortSignal extends CottontailEventTarget {
  constructor(token) {
    if (token !== abortSignalConstructToken) {
      throw nodeTypeError("ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
    }
    super();
    const dependants = new WeakDependantSignalSet();
    abortSignalState.set(this, {
      aborted: false,
      reason: undefined,
      onabort: null,
      timeoutTimer: null,
      timeoutDeadline: null,
      dependants,
    });
    Object.defineProperty(this, abortDependantSignals, {
      value: dependants,
      enumerable: false,
      configurable: true,
    });
  }

  get aborted() {
    return abortSignalStateFor(this).aborted;
  }

  get reason() {
    return abortSignalStateFor(this).reason;
  }

  get onabort() {
    return abortSignalStateFor(this).onabort;
  }

  set onabort(handler) {
    const state = abortSignalStateFor(this);
    state.onabort = typeof handler === "function" ? handler : null;
    refreshAbortSignalRetention(this);
  }

  addEventListener(type, listener, options = undefined) {
    super.addEventListener(type, listener, options);
    refreshAbortSignalRetention(this);
  }

  throwIfAborted() {
    const state = abortSignalStateFor(this);
    if (state.aborted) throw state.reason;
  }

  static abort(reason = makeAbortError()) {
    const signal = new CottontailAbortSignal(abortSignalConstructToken);
    abortSignal(signal, reason);
    return signal;
  }

  static timeout(delay) {
    const controller = new CottontailAbortController();
    const signal = controller.signal;
    const signalRef = internalWeakRef(signal);
    const normalizedDelay = Math.max(0, Number(delay) || 0);
    const timer = setTimeout(() => {
      const liveSignal = signalRef.deref();
      if (liveSignal) abortSignal(liveSignal, makeTimeoutError());
    }, normalizedDelay);
    timer?.unref?.();
    const state = abortSignalStateFor(signal);
    state.timeoutTimer = timer;
    state.timeoutDeadline = Date.now() + normalizedDelay;
    return signal;
  }

  static any(signals) {
    if (signals == null || typeof signals[Symbol.iterator] !== "function") {
      throw nodeTypeError("ERR_INVALID_ARG_TYPE", "The \"signals\" argument must be an iterable of AbortSignal instances");
    }
    const list = Array.from(signals);
    for (let index = 0; index < list.length; index += 1) {
      if (!isAbortSignal(list[index])) throw invalidAbortSignalArgument(`signals[${index}]`, list[index]);
    }
    const controller = new CottontailAbortController();
    for (const signal of list) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        return controller.signal;
      }
    }
    for (const signal of list) {
      addDependantSignal(signal, controller.signal);
    }
    return controller.signal;
  }

  [inspectCustomSymbol]() {
    return `AbortSignal { aborted: ${this.aborted ? "true" : "false"} }`;
  }

  get [Symbol.toStringTag]() {
    return "AbortSignal";
  }
}

class CottontailAbortController {
  constructor() {
    abortControllerState.set(this, {
      signal: new CottontailAbortSignal(abortSignalConstructToken),
    });
  }

  get signal() {
    return abortControllerStateFor(this).signal;
  }

  abort(reason = makeAbortError()) {
    abortSignal(abortControllerStateFor(this).signal, reason);
  }

  [inspectCustomSymbol](_depth, options) {
    return options?.depth === null
      ? `AbortController { signal: ${this.signal[inspectCustomSymbol]()} }`
      : "AbortController { signal: [AbortSignal] }";
  }

  get [Symbol.toStringTag]() {
    return "AbortController";
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

const BunObjectTarget = globalThis.Bun ?? {};
let bunObjectReified = Boolean(globalThis.__cottontailBunReified);
const BunObject = new Proxy(BunObjectTarget, {
  ownKeys(target) {
    bunObjectReified = true;
    globalThis.__cottontailBunReified = true;
    return Reflect.ownKeys(target);
  },
});
globalThis.__cottontailBunHasNonReifiedStatic = (value) => value === BunObject && !bunObjectReified;
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
BunObject.HTMLRewriter = HTMLRewriter;
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
BunObject.ShellError = ShellError;
BunObject.ShellOutput = ShellOutput;
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
CryptoObject.subtle ??= nodeWebcrypto.subtle;
globalThis.crypto = CryptoObject;
globalThis.CryptoKey ??= CryptoKey;
globalThis.DOMException ??= CottontailDOMException;
globalThis.Event ??= CottontailEvent;
globalThis.EventTarget ??= CottontailEventTarget;
globalThis.CustomEvent ??= CottontailCustomEvent;
globalThis.ErrorEvent ??= CottontailErrorEvent;
globalThis.CloseEvent ??= CottontailCloseEvent;

// Web Performance surface: illegal-constructor classes over the basic clock
// installed by ffi.js, plus mark/measure entries and PerformanceObserver.
{
  const allowConstruct = Symbol("cottontail.performance.construct");
  const perfEntries = [];
  const perfObservers = new Set();
  const clock = globalThis.performance ?? {};
  const perfNow = typeof clock.now === "function" ? clock.now.bind(clock) : () => Date.now();
  const perfTimeOrigin = Number(clock.timeOrigin ?? Date.now());

  class PerformanceEntry {
    constructor(...args) {
      if (args[0] !== allowConstruct) throw new TypeError("Illegal constructor");
    }
    toJSON() {
      return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration };
    }
  }
  const makeEntry = (Ctor, name, entryType, startTime, duration, detail = null) => {
    const entry = new Ctor(allowConstruct);
    entry.name = String(name);
    entry.entryType = entryType;
    entry.startTime = startTime;
    entry.duration = duration;
    if (Ctor !== PerformanceEntry) entry.detail = detail == null ? null : (typeof structuredClone === "function" ? structuredClone(detail) : detail);
    return entry;
  };
  class PerformanceMark extends PerformanceEntry {}
  class PerformanceMeasure extends PerformanceEntry {}

  const notifyObservers = (entry) => {
    for (const observer of [...perfObservers]) {
      if (!observer._types.has(entry.entryType)) continue;
      observer._buffer.push(entry);
      if (observer._pending) continue;
      observer._pending = true;
      queueMicrotask(() => {
        observer._pending = false;
        const records = observer._buffer.splice(0);
        if (records.length === 0) return;
        const list = {
          getEntries: () => [...records],
          getEntriesByName: (name, type) => records.filter((item) => item.name === String(name) && (type == null || item.entryType === type)),
          getEntriesByType: (type) => records.filter((item) => item.entryType === String(type)),
        };
        observer._callback(list, observer);
      });
    }
  };
  const entryStart = (reference) => {
    if (reference == null) return 0;
    if (typeof reference === "number") return reference;
    const named = perfEntries.filter((entry) => entry.name === String(reference));
    if (named.length === 0) throw new TypeError(`No mark named '${reference}' exists`);
    return named[named.length - 1].startTime;
  };

  class Performance extends (globalThis.EventTarget ?? CottontailEventTarget) {
    constructor(...args) {
      super();
      if (args[0] !== allowConstruct) throw new TypeError("Illegal constructor");
    }
    get timeOrigin() {
      return perfTimeOrigin;
    }
    now() {
      return perfNow();
    }
    mark(name, options = undefined) {
      const mark = makeEntry(PerformanceMark, name, "mark", options?.startTime ?? perfNow(), 0, options?.detail);
      perfEntries.push(mark);
      notifyObservers(mark);
      return mark;
    }
    measure(name, startOrOptions = undefined, endMark = undefined) {
      let start = 0;
      let end = perfNow();
      let detail = null;
      if (startOrOptions != null && typeof startOrOptions === "object") {
        detail = startOrOptions.detail ?? null;
        if (startOrOptions.start != null) start = entryStart(startOrOptions.start);
        if (startOrOptions.end != null) end = entryStart(startOrOptions.end);
        if (startOrOptions.duration != null) {
          if (startOrOptions.end == null) end = start + Number(startOrOptions.duration);
          else if (startOrOptions.start == null) start = end - Number(startOrOptions.duration);
        }
      } else {
        if (startOrOptions != null) start = entryStart(startOrOptions);
        if (endMark != null) end = entryStart(endMark);
      }
      const measure = makeEntry(PerformanceMeasure, name, "measure", start, end - start, detail);
      perfEntries.push(measure);
      notifyObservers(measure);
      return measure;
    }
    getEntries() {
      return [...perfEntries];
    }
    getEntriesByName(name, type = undefined) {
      return perfEntries.filter((entry) => entry.name === String(name) && (type == null || entry.entryType === type));
    }
    getEntriesByType(type) {
      return perfEntries.filter((entry) => entry.entryType === String(type));
    }
    clearMarks(name = undefined) {
      for (let index = perfEntries.length - 1; index >= 0; index -= 1) {
        if (perfEntries[index].entryType === "mark" && (name == null || perfEntries[index].name === String(name))) perfEntries.splice(index, 1);
      }
    }
    clearMeasures(name = undefined) {
      for (let index = perfEntries.length - 1; index >= 0; index -= 1) {
        if (perfEntries[index].entryType === "measure" && (name == null || perfEntries[index].name === String(name))) perfEntries.splice(index, 1);
      }
    }
    toJSON() {
      return { timeOrigin: perfTimeOrigin, eventCounts: {} };
    }
  }

  class PerformanceObserver {
    constructor(callback) {
      if (typeof callback !== "function") throw new TypeError("The callback argument must be a function");
      this._callback = callback;
      this._types = new Set();
      this._buffer = [];
      this._pending = false;
    }
    static get supportedEntryTypes() {
      return ["mark", "measure"];
    }
    observe(options = {}) {
      if (Array.isArray(options.entryTypes)) this._types = new Set(options.entryTypes.map(String));
      else if (options.type != null) this._types = new Set([String(options.type)]);
      else throw new TypeError("Either entryTypes or type must be specified");
      perfObservers.add(this);
    }
    disconnect() {
      perfObservers.delete(this);
    }
    takeRecords() {
      return this._buffer.splice(0);
    }
  }

  const perfInstance = new Performance(allowConstruct);
  // preserve any extra host-provided members (e.g. eventLoopUtilization from node:perf_hooks)
  for (const key of Object.keys(clock)) {
    if (!(key in Performance.prototype) && key !== "timeOrigin") perfInstance[key] = clock[key];
  }
  globalThis.performance = perfInstance;
  globalThis.Performance = Performance;
  globalThis.PerformanceEntry = PerformanceEntry;
  globalThis.PerformanceMark = PerformanceMark;
  globalThis.PerformanceMeasure = PerformanceMeasure;
  globalThis.PerformanceObserver ??= PerformanceObserver;
}

// The WebSocket client in node/http.js is backed by EventEmitter, and
// EventEmitter.emit("error", ...) throws when no "error" listeners exist. A
// browser-style dispatchEvent must never throw for unhandled error events
// (e.g. connection refused with only ws.onerror set). Remove this wrapper
// once node/http.js's dispatchEvent guards the unhandled "error" emit itself.
{
  const wsPrototype = nodeHttp.WebSocket?.prototype;
  const originalDispatch = wsPrototype?.dispatchEvent;
  if (typeof originalDispatch === "function" && !originalDispatch.__cottontailSafeErrorDispatch) {
    const dispatchEvent = function dispatchEvent(event) {
      try {
        return originalDispatch.call(this, event);
      } catch (error) {
        if (event?.type === "error") return true;
        throw error;
      }
    };
    Object.defineProperty(dispatchEvent, "__cottontailSafeErrorDispatch", { value: true });
    wsPrototype.dispatchEvent = dispatchEvent;
  }
}
globalThis.File = BunFile;
globalThis.AbortSignal ??= CottontailAbortSignal;
globalThis.AbortController ??= CottontailAbortController;
globalThis.structuredClone ??= cottontailStructuredClone;
globalThis.fetch ??= fetch;
Object.defineProperty(globalThis, "self", {
  get() {
    return globalThis;
  },
  set(_value) {},
  enumerable: true,
  configurable: true,
});
for (const [ctor, name] of [
  [globalThis.Blob, "Blob"],
  [globalThis.TextDecoder, "TextDecoder"],
  [globalThis.TextEncoder, "TextEncoder"],
  [Request, "Request"],
  [Response, "Response"],
  [Headers, "Headers"],
  [HTMLRewriter, "HTMLRewriter"],
  [Transpiler, "Transpiler"],
  [globalThis.Buffer, "Buffer"],
  [globalThis.File, "File"],
]) {
  if (typeof ctor === "function") Object.defineProperty(ctor, "name", { value: name, configurable: true });
}
globalThis.Bun = BunObject;
if (typeof globalThis.TextEncoder === "function" && typeof globalThis.TextEncoder.prototype.encodeInto !== "function") {
  Object.defineProperty(globalThis.TextEncoder.prototype, "encodeInto", {
    value(source = "", destination) {
      if (!(destination instanceof Uint8Array)) throw new TypeError("TextEncoder.encodeInto requires a Uint8Array destination");
      const input = String(source);
      let read = 0;
      let written = 0;
      while (read < input.length) {
        const codePoint = input.codePointAt(read);
        const width = codePoint > 0xffff ? 2 : 1;
        const encoded = this.encode(input.slice(read, read + width));
        if (written + encoded.byteLength > destination.byteLength) break;
        destination.set(encoded, written);
        written += encoded.byteLength;
        read += width;
      }
      return { read, written };
    },
    configurable: true,
    writable: true,
  });
}
nodeSetBuiltinModules({
  bun: BunObject,
  "bun:test": bunTestModule.default ?? bunTestModule,
  "bun:ffi": FFI.default ?? FFI,
  "bun:sqlite": { Database: SQLiteDatabase, default: SQLiteDatabase },
});
globalThis.HTMLRewriter ??= HTMLRewriter;
globalThis.require ??= nodeCreateRequire(globalThis.process?.argv?.[1] ?? cottontail.cwd());
globalThis.__cottontailImportMetaResolveSync ??= (specifier, parent = globalThis.__cottontailImportMeta?.path ?? cottontail.cwd()) =>
  resolveSync(specifier, parent);
globalThis.__cottontailImportMetaResolve ??= (specifier, parent = globalThis.__cottontailImportMeta?.path ?? cottontail.cwd()) => {
  const resolved = resolveSync(specifier, parent);
  return String(resolved).startsWith("/") ? pathToFileURL(resolved).href : resolved;
};
globalThis.test ??= bunTestModule.test;
globalThis.it ??= bunTestModule.it;
globalThis.describe ??= bunTestModule.describe;
globalThis.expect ??= bunTestModule.expect;
globalThis.expectTypeOf ??= bunTestModule.expectTypeOf;
globalThis.beforeAll ??= bunTestModule.beforeAll;
globalThis.afterAll ??= bunTestModule.afterAll;
globalThis.beforeEach ??= bunTestModule.beforeEach;
globalThis.afterEach ??= bunTestModule.afterEach;
if (globalThis.Headers?.prototype && typeof globalThis.Headers.prototype.getAll !== "function") {
  Object.defineProperty(globalThis.Headers.prototype, "getAll", {
    value: headersGetAll,
    configurable: true,
    writable: true,
  });
}
globalThis.Headers ??= Headers;
globalThis.FormData ??= FormData;
globalThis.Request ??= Request;
globalThis.Response ??= Response;
{
  // The runtime owns the URL globals; any existing value is only the weaker
  // ffi.js bootstrap shim. Carry over the object-URL registry statics that
  // ffi.js may have installed on the shim before replacing it.
  const priorURL = globalThis.URL;
  if (priorURL && priorURL !== URL) {
    for (const key of ["createObjectURL", "revokeObjectURL", "__cottontailObjectURLRegistryInstalled"]) {
      const descriptor = Object.getOwnPropertyDescriptor(priorURL, key);
      if (descriptor && !Object.getOwnPropertyDescriptor(URL, key)) Object.defineProperty(URL, key, descriptor);
    }
  }
  globalThis.URL = URL;
  globalThis.URLSearchParams = URLSearchParams;
}

const argv = BunObject.argv;
const env = BunObject.env;

export { BunObject as Bun, argv, env, which };
export default BunObject;
