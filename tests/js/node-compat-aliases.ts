import strictAssert, { match, rejects, strictEqual, throws } from "node:assert/strict";
import sys, { format } from "node:sys";
import consoleModule, { Console } from "node:console";
import posix from "node:path/posix";
import win32 from "node:path/win32";
import types from "node:util/types";

strictEqual(strictAssert, strictAssert.strict, "assert/strict default should be strict assert");
strictEqual(format("%s-%d", "value", 7), "value-7", "sys format should alias util format");
strictEqual(sys.format("ok %s", "sys"), "ok sys", "sys default should expose util methods");

throws(() => {
  throw new TypeError("strict boom");
}, TypeError);
throws(() => {
  throw new TypeError("verify must be function");
}, /TypeError: verify must be function/);
await rejects(async () => {
  throw new Error("async boom");
}, /async boom/);
match("cottontail", /tail/);

strictEqual(posix.join("/tmp", "a", "..", "b"), "/tmp/b", "path/posix join mismatch");
strictEqual(posix.basename("/tmp/file.txt", ".txt"), "file", "path/posix basename suffix mismatch");
strictEqual(win32.join("C:\\tmp", "a", "..", "b"), "C:\\tmp\\b", "path/win32 join mismatch");
strictEqual(win32.basename("C:\\tmp\\file.txt", ".txt"), "file", "path/win32 basename suffix mismatch");

let stdout = "";
let stderr = "";
const localConsole = new Console(
  { write(chunk: string) { stdout += chunk; } },
  { write(chunk: string) { stderr += chunk; } },
);
localConsole.log("hello %s", "console");
localConsole.error("bad %d", 3);
strictEqual(stdout, "hello console\n", "Console stdout mismatch");
strictEqual(stderr, "bad 3\n", "Console stderr mismatch");
strictEqual(typeof consoleModule.log, "function", "console default log missing");
strictEqual(types.isDate(new Date()), true, "util/types isDate mismatch");
strictEqual(types.isRegExp(/x/), true, "util/types isRegExp mismatch");
strictEqual(types.isTypedArray(new Uint8Array()), true, "util/types isTypedArray mismatch");
strictEqual(types.isArrayBuffer(new ArrayBuffer(1)), true, "util/types isArrayBuffer mismatch");
strictEqual(types.isMap(new Map()), true, "util/types isMap mismatch");

console.log("node compat aliases passed");
