import * as constants from "./constants.js";
import * as types from "./util/types.js";

const inspectCustomSymbol = Symbol.for("nodejs.util.inspect.custom");
const errorEntries = Object.entries(constants)
  .filter(([name, value]) => /^E[A-Z0-9]+$/.test(name) && Number.isInteger(value))
  .map(([name, value]) => [Number(value), name]);
const errorByCode = new Map(errorEntries);

export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;

export function parseArgs(options = {}) {
  const input = options.args || [];
  const values = {};
  const positionals = [];
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(2, eq === -1 ? undefined : eq);
      const spec = options.options?.[name] || {};
      if (spec.type === "boolean") {
        values[name] = eq === -1 ? true : arg.slice(eq + 1) !== "false";
      } else if (eq !== -1) {
        values[name] = arg.slice(eq + 1);
      } else {
        values[name] = input[++index];
      }
    } else if (options.allowPositionals) {
      positionals.push(arg);
    }
  }
  return { values, positionals };
}

export function inspect(value, options = undefined) {
  if (value && typeof value[inspectCustomSymbol] === "function") return value[inspectCustomSymbol](0, options, inspect);
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") return `[Function${value.name ? `: ${value.name}` : ""}]`;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

inspect.custom = inspectCustomSymbol;

export function format(...args) {
  if (args.length === 0) return "";
  const first = args[0];
  if (typeof first !== "string") {
    return args.map((value) => inspect(value)).join(" ");
  }

  let index = 1;
  const output = first.replace(/%[sdifjoO%]/g, (token) => {
    if (token === "%%") return "%";
    if (index >= args.length) return token;
    const value = args[index++];
    switch (token) {
      case "%s":
        return String(value);
      case "%d":
      case "%f":
        return String(Number(value));
      case "%i":
        return String(Number.parseInt(value, 10));
      case "%j":
        try {
          return JSON.stringify(value);
        } catch {
          return "[Circular]";
        }
      case "%o":
      case "%O":
      default:
        return inspect(value);
    }
  });

  const rest = args.slice(index).map((value) => inspect(value));
  return rest.length === 0 ? output : `${output} ${rest.join(" ")}`;
}

export function formatWithOptions(_options, ...args) {
  return format(...args);
}

export function deprecate(fn, message, code = undefined) {
  let warned = false;
  return function deprecated(...args) {
    if (!warned) {
      warned = true;
      globalThis.process?.emitWarning?.(message, "DeprecationWarning", code);
    }
    return fn.apply(this, args);
  };
}

export function promisify(fn) {
  if (typeof fn !== "function") {
    throw new TypeError("The original argument must be of type function");
  }
  if (typeof fn[promisify.custom] === "function") return fn[promisify.custom];
  return (...args) =>
    new Promise((resolve, reject) => {
      fn(...args, (error, ...values) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(values.length > 1 ? values : values[0]);
      });
    });
}

promisify.custom = Symbol.for("nodejs.util.promisify.custom");

export function callbackify(fn) {
  if (typeof fn !== "function") throw new TypeError("The original argument must be of type function");
  return function callbackified(...args) {
    const callback = args.pop();
    if (typeof callback !== "function") throw new TypeError("The last argument must be of type function");
    Promise.resolve()
      .then(() => fn.apply(this, args))
      .then((value) => callback(null, value), (error) => callback(error));
  };
}

export function isDeepStrictEqual(left, right) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left, Object.keys(Object(left)).sort()) ===
      JSON.stringify(right, Object.keys(Object(right)).sort());
  } catch {
    return false;
  }
}

export function inherits(ctor, superCtor) {
  if (typeof ctor !== "function" || typeof superCtor !== "function") {
    throw new TypeError("ctor and superCtor must be functions");
  }
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  Object.defineProperty(ctor.prototype, "constructor", {
    value: ctor,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  Object.setPrototypeOf(ctor, superCtor);
}

export function _extend(target, source) {
  if (source == null) return target;
  for (const key of Object.keys(source)) target[key] = source[key];
  return target;
}

export const isArray = Array.isArray;

export function getSystemErrorName(err) {
  const code = Math.abs(Number(err));
  const name = errorByCode.get(code);
  if (!name) throw new RangeError(`Unknown system error ${err}`);
  return name;
}

export function getSystemErrorMessage(err) {
  return getSystemErrorName(err);
}

export function getSystemErrorMap() {
  return new Map([...errorByCode.entries()].map(([code, name]) => [-code, [name, name]]));
}

export function _errnoException(err, syscall = undefined, original = undefined) {
  const error = new Error(`${syscall ? `${syscall} ` : ""}${getSystemErrorName(err)}${original ? ` ${original}` : ""}`);
  error.errno = err;
  error.code = getSystemErrorName(err);
  if (syscall) error.syscall = syscall;
  return error;
}

export function _exceptionWithHostPort(err, syscall, address, port, additional = undefined) {
  const error = _errnoException(err, syscall, additional);
  error.address = address;
  error.port = port;
  return error;
}

export function parseEnv(content) {
  const result = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

export function stripVTControlCharacters(str) {
  return String(str).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

const styleCodes = {
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
  hidden: [8, 28],
  strikethrough: [9, 29],
  black: [30, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  gray: [90, 39],
  grey: [90, 39],
};

export function styleText(formatName, text, options = {}) {
  void options;
  const formats = Array.isArray(formatName) ? formatName : [formatName];
  let output = String(text);
  for (const name of formats.reverse()) {
    const pair = styleCodes[String(name)];
    if (pair) output = `\x1B[${pair[0]}m${output}\x1B[${pair[1]}m`;
  }
  return output;
}

export function toUSVString(input) {
  const value = String(input);
  if (typeof value.toWellFormed === "function") return value.toWellFormed();
  return value.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

export function debuglog(section, callback = undefined) {
  const set = String(section).toUpperCase();
  const enabled = String(globalThis.process?.env?.NODE_DEBUG ?? "")
    .split(/[,\s]+/)
    .some((entry) => entry.toUpperCase() === set || entry === "*");
  const logger = enabled
    ? (...args) => cottontail.fdWrite?.(2, `${set} ${globalThis.process?.pid ?? 0}: ${format(...args)}\n`)
    : () => {};
  if (typeof callback === "function") callback(logger);
  return logger;
}

export const debug = debuglog;

export function diff(actual, expected) {
  if (isDeepStrictEqual(actual, expected)) return [];
  return [
    { type: "remove", value: actual },
    { type: "add", value: expected },
  ];
}

export function getCallSites(frameCount = 10) {
  const stack = String(new Error().stack || "").split("\n").slice(1, Number(frameCount) + 1);
  return stack.map((line) => ({ scriptName: line.trim(), lineNumber: 0, columnNumber: 0, functionName: "" }));
}

let traceSigInt = false;

export function setTraceSigInt(enabled = true) {
  traceSigInt = Boolean(enabled);
}

class SimpleAbortSignal {
  constructor() {
    this.aborted = false;
    this.reason = undefined;
    this._listeners = new Set();
  }

  addEventListener(name, listener) {
    if (name === "abort" && typeof listener === "function") this._listeners.add(listener);
  }

  removeEventListener(name, listener) {
    if (name === "abort") this._listeners.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of [...this._listeners]) listener(event);
  }
}

class SimpleAbortController {
  constructor() {
    this.signal = new SimpleAbortSignal();
  }

  abort(reason = undefined) {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason;
    this.signal.dispatchEvent({ type: "abort" });
  }
}

export function transferableAbortController() {
  const Controller = globalThis.AbortController ?? SimpleAbortController;
  return new Controller();
}

export function transferableAbortSignal(signal) {
  return signal;
}

export function aborted(signal, resource = undefined) {
  void resource;
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal?.addEventListener?.("abort", resolve, { once: true });
  });
}

export class MIMEParams {
  constructor(init = undefined) {
    this._params = [];
    if (init != null) {
      const source = typeof init === "string" ? init : String(init);
      for (const part of source.split(/[&;]/)) {
        if (!part.trim()) continue;
        const eq = part.indexOf("=");
        const name = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).trim());
        const value = decodeURIComponent(eq < 0 ? "" : part.slice(eq + 1).trim());
        this.set(name, value);
      }
    }
  }

  delete(name) {
    const key = String(name).toLowerCase();
    this._params = this._params.filter(([candidate]) => candidate.toLowerCase() !== key);
  }
  get(name) {
    const key = String(name).toLowerCase();
    const entry = this._params.find(([candidate]) => candidate.toLowerCase() === key);
    return entry ? entry[1] : null;
  }
  has(name) {
    return this.get(name) != null;
  }
  set(name, value) {
    this.delete(name);
    this._params.push([String(name), String(value)]);
  }
  *entries() { yield* this._params; }
  *keys() { for (const [name] of this._params) yield name; }
  *values() { for (const [, value] of this._params) yield value; }
  [Symbol.iterator]() { return this.entries(); }
  toString() {
    return this._params
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join(";");
  }
  toJSON() { return this.toString(); }
}

export class MIMEType {
  constructor(input) {
    const text = String(input);
    const [essence, ...paramParts] = text.split(";");
    const slash = essence.indexOf("/");
    if (slash <= 0) throw new TypeError("Invalid MIME type");
    this.type = essence.slice(0, slash).trim().toLowerCase();
    this.subtype = essence.slice(slash + 1).trim().toLowerCase();
    this.params = new MIMEParams(paramParts.join("&").replace(/;\s*/g, "&"));
  }

  get essence() {
    return `${this.type}/${this.subtype}`;
  }

  toString() {
    const params = this.params.toString();
    return params ? `${this.essence};${params}` : this.essence;
  }

  toJSON() {
    return this.toString();
  }
}

// COTTONTAIL-COMPAT: node:util diagnostics - diff/getCallSites/debug output is simplified; replace with richer inspector-backed data later.

export { types };

export default {
  MIMEParams,
  MIMEType,
  TextDecoder,
  TextEncoder,
  _errnoException,
  _exceptionWithHostPort,
  _extend,
  aborted,
  callbackify,
  debug,
  debuglog,
  deprecate,
  diff,
  format,
  formatWithOptions,
  getCallSites,
  getSystemErrorMap,
  getSystemErrorMessage,
  getSystemErrorName,
  inherits,
  inspect,
  isArray,
  isDeepStrictEqual,
  parseArgs,
  parseEnv,
  promisify,
  setTraceSigInt,
  stripVTControlCharacters,
  styleText,
  toUSVString,
  transferableAbortController,
  transferableAbortSignal,
  types,
};
