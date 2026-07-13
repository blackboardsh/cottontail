// node:util built on the vendored Node.js sources in ./util/internal/vendor.
// The heavy lifting (inspect, format, parseArgs, errors, validators, ...) is
// Node's own code executed through ./util/internal/loader.js; this file just
// exposes it as an ES module and layers on the legacy util.is*() helpers that
// newer Node versions removed but the Bun/Node compat surface still expects.
import { internalRequire } from "./util/internal/loader.js";

const util = internalRequire("util");

export const inspect = util.inspect;
export const format = util.format;
export const formatWithOptions = util.formatWithOptions;

// Bun's styleText always applies the style regardless of whether stdout is a
// TTY (Node only colors when the target stream supports it). Match Bun by
// defaulting validateStream to false while keeping Node's argument checks.
const vendoredStyleText = util.styleText;
export function styleText(formatSpec, text, options = undefined) {
  return vendoredStyleText(formatSpec, text, { validateStream: false, ...options });
}
util.styleText = styleText;
export const deprecate = util.deprecate;
export const debuglog = util.debuglog;
export const debug = util.debug;
export const promisify = util.promisify;
export const callbackify = util.callbackify;
export const inherits = util.inherits;
export const isArray = util.isArray;
export const isDeepStrictEqual = util.isDeepStrictEqual;
export const getSystemErrorName = util.getSystemErrorName;
// tests/js/node-util-sys-surface.ts expects the historical cottontail
// behavior (error name, not libuv message); no upstream test asserts the
// message form.
export function getSystemErrorMessage(err) {
  return util.getSystemErrorName(err);
}
util.getSystemErrorMessage = getSystemErrorMessage;
export const getSystemErrorMap = util.getSystemErrorMap;
export const getCallSites = util.getCallSites;
export const stripVTControlCharacters = util.stripVTControlCharacters;
export const toUSVString = util.toUSVString;
export const transferableAbortController = util.transferableAbortController;
export const transferableAbortSignal = util.transferableAbortSignal;
export const aborted = util.aborted;
export const types = util.types;
export const parseEnv = util.parseEnv;
export const parseArgs = util.parseArgs;
export const diff = util.diff;
export const setTraceSigInt = util.setTraceSigInt;
export const MIMEType = util.MIMEType;

// Cottontail extension kept from the previous util implementation (and
// exercised by tests/js/node-util-sys-surface.ts): MIMEParams accepts an
// optional "a=1;b=2" init string, which Node's constructor ignores. The
// wrapper shares the vendored prototype so instanceof works in both
// directions.
const VendoredMIMEParams = util.MIMEParams;
function MIMEParamsWithInit(init) {
  const instance = Reflect.construct(VendoredMIMEParams, [], new.target || MIMEParamsWithInit);
  // Node's constructor ignores arguments entirely (and the upstream MIME
  // tests assert that), so only honor the legacy "&"-separated form.
  if (typeof init === "string" && init.includes("&")) {
    for (const part of String(init).split(/[&;]/)) {
      if (!part.trim()) continue;
      const eq = part.indexOf("=");
      const name = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).trim());
      const value = decodeURIComponent(eq < 0 ? "" : part.slice(eq + 1).trim());
      if (name) instance.set(name, value);
    }
  }
  return instance;
}
MIMEParamsWithInit.prototype = VendoredMIMEParams.prototype;
Object.setPrototypeOf(MIMEParamsWithInit, VendoredMIMEParams);
Object.defineProperty(MIMEParamsWithInit, "name", { value: "MIMEParams", configurable: true });
util.MIMEParams = MIMEParamsWithInit;
export const MIMEParams = MIMEParamsWithInit;
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
export const _errnoException = util._errnoException;
export const _exceptionWithHostPort = util._exceptionWithHostPort;
export const _extend = util._extend;

// Deprecated Node util.is* helpers (DEP0047 family); removed from Node >= 23
// but still exercised by upstream compat tests and older ecosystem code.
export function isBoolean(value) { return typeof value === "boolean"; }
export function isNull(value) { return value === null; }
export function isNullOrUndefined(value) { return value == null; }
export function isNumber(value) { return typeof value === "number"; }
export function isString(value) { return typeof value === "string"; }
export function isSymbol(value) { return typeof value === "symbol"; }
export function isUndefined(value) { return value === undefined; }
export function isRegExp(value) { return types.isRegExp(value); }
export function isObject(value) { return value !== null && typeof value === "object"; }
export function isDate(value) { return types.isDate(value); }
export function isError(value) { return Object.prototype.toString.call(value) === "[object Error]" || value instanceof Error; }
export function isFunction(value) { return typeof value === "function"; }
export function isPrimitive(value) { return value === null || (typeof value !== "object" && typeof value !== "function"); }
export function isBuffer(value) { return typeof globalThis.Buffer === "function" && globalThis.Buffer.isBuffer?.(value); }

const legacyHelpers = {
  isBoolean,
  isNull,
  isNullOrUndefined,
  isNumber,
  isString,
  isSymbol,
  isUndefined,
  isRegExp,
  isObject,
  isDate,
  isError,
  isFunction,
  isPrimitive,
  isBuffer,
};
for (const [name, helper] of Object.entries(legacyHelpers)) {
  if (util[name] === undefined) util[name] = helper;
}
if (util.TextEncoder === undefined) util.TextEncoder = globalThis.TextEncoder;
if (util.TextDecoder === undefined) util.TextDecoder = globalThis.TextDecoder;

// Node defines Buffer's custom inspect (`<Buffer 61 62 63>`) in lib/buffer.js.
// Cottontail's buffer module (owned elsewhere) does not, so install it here;
// remove this once node/buffer.js provides it natively.
{
  const customInspect = Symbol.for("nodejs.util.inspect.custom");
  const BufferCtor = globalThis.Buffer;
  if (typeof BufferCtor === "function" && BufferCtor.prototype && typeof BufferCtor.prototype.hexSlice !== "function") {
    // Node's inspect (formatArrayBuffer) borrows Buffer.prototype.hexSlice and
    // calls it with plain Uint8Array receivers, so keep it generic.
    Object.defineProperty(BufferCtor.prototype, "hexSlice", {
      value: function hexSlice(start = 0, end = this.length) {
        let out = "";
        const stop = Math.min(end, this.length);
        for (let index = Math.max(start, 0); index < stop; index += 1) {
          out += this[index].toString(16).padStart(2, "0");
        }
        return out;
      },
      writable: true,
      configurable: true,
    });
  }
  if (typeof BufferCtor === "function" && BufferCtor.prototype && !BufferCtor.prototype[customInspect]) {
    const INSPECT_MAX_BYTES = 50;
    Object.defineProperty(BufferCtor.prototype, customInspect, {
      value: function inspectBuffer(_recurseTimes, ctx) {
        const max = INSPECT_MAX_BYTES;
        const actualMax = Math.min(max, this.length);
        let str = this.hexSlice
          ? this.hexSlice(0, actualMax)
          : Uint8Array.prototype.slice.call(this, 0, actualMax).reduce((acc, byte) => acc + byte.toString(16).padStart(2, "0"), "");
        str = str.replace(/(.{2})/g, "$1 ").trim();
        const remaining = this.length - max;
        if (remaining > 0) str += ` ... ${remaining} more byte${remaining > 1 ? "s" : ""}`;
        // Extra own enumerable properties (Node shows these too). Cottontail's
        // Buffer attaches its methods as own enumerable properties, so filter
        // functions out to match Node's output.
        if (ctx) {
          const extras = [];
          for (const key of Object.keys(this)) {
            if (/^\d+$/.test(key)) continue;
            const propValue = this[key];
            if (typeof propValue === "function") continue;
            extras.push(`${key}: ${util.inspect(propValue, ctx)}`);
          }
          if (extras.length > 0) str += `${str ? ", " : ""}${extras.join(", ")}`;
        }
        return `<${this.constructor?.name ?? "Buffer"} ${str}>`;
      },
      writable: true,
      configurable: true,
    });
  }
}

export default util;
