import {
  MIMEParams,
  MIMEType,
  _errnoException,
  _exceptionWithHostPort,
  _extend,
  aborted,
  callbackify,
  debuglog,
  diff,
  format,
  getCallSites,
  getSystemErrorMap,
  getSystemErrorMessage,
  getSystemErrorName,
  inherits,
  isArray,
  parseEnv,
  stripVTControlCharacters,
  styleText,
  toUSVString,
  transferableAbortController,
  transferableAbortSignal,
} from "node:util";
import { EACCES } from "node:constants";
import { createSecretKey } from "node:crypto";
import sys from "node:sys";
import types from "node:util/types";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const mime = new MIMEType("Text/HTML; charset=utf-8");
assert(mime.essence === "text/html", "MIMEType essence mismatch");
mime.params.set("boundary", "abc");
assert(mime.toString().includes("boundary=abc"), "MIMEType params mismatch");

const params = new MIMEParams("a=1&b=2");
assert(params.get("a") === "1", "MIMEParams get mismatch");
params.set("c", "3");
assert([...params.keys()].includes("c"), "MIMEParams keys mismatch");

assert(format("%s:%d", "value", 7) === "value:7", "format mismatch");
assert(sys.format("%s", "ok") === "ok", "sys re-export mismatch");
assert(isArray([]), "isArray mismatch");
assert(types.isKeyObject(createSecretKey(Buffer.from("abc"))), "util.types.isKeyObject secret key mismatch");
assert(!types.isKeyObject({ type: "secret" }), "util.types.isKeyObject plain object mismatch");
assert(_extend({ a: 1 }, { b: 2 }).b === 2, "_extend mismatch");
assert(parseEnv("A=1\nB='two'\n# ignored").B === "two", "parseEnv mismatch");
assert(stripVTControlCharacters("\x1B[31mred\x1B[39m") === "red", "stripVTControlCharacters mismatch");
assert(styleText("red", "x").includes("\x1B[31m"), "styleText mismatch");
assert(toUSVString("\uD800") === "\uFFFD", "toUSVString mismatch");

assert(getSystemErrorName(-EACCES) === "EACCES", "getSystemErrorName mismatch");
assert(getSystemErrorMessage(-EACCES) === "EACCES", "getSystemErrorMessage mismatch");
assert(getSystemErrorMap().get(-EACCES)?.[0] === "EACCES", "getSystemErrorMap mismatch");
assert(_errnoException(-EACCES, "open").code === "EACCES", "_errnoException mismatch");
assert(_exceptionWithHostPort(-EACCES, "connect", "127.0.0.1", 80).port === 80, "_exceptionWithHostPort mismatch");

function Parent() {}
Parent.prototype.parentMethod = function parentMethod() { return true; };
function Child() {}
inherits(Child, Parent);
assert(new (Child as any)().parentMethod(), "inherits mismatch");

const callbackified = callbackify(async (value: number) => value + 1);
await new Promise<void>((resolve, reject) => {
  callbackified(1, (error, value) => {
    if (error) reject(error);
    else {
      try {
        assert(value === 2, "callbackify value mismatch");
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    }
  });
});

const controller = transferableAbortController();
const signal = transferableAbortSignal(controller.signal);
const abortedPromise = aborted(signal);
controller.abort();
await abortedPromise;

assert(Array.isArray(diff({ a: 1 }, { a: 2 })), "diff mismatch");
assert(Array.isArray(getCallSites(1)), "getCallSites mismatch");
assert(typeof debuglog("test") === "function", "debuglog mismatch");

console.log("node util sys surface passed");
