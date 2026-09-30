import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../src/runtime_modules/bun/index.js", import.meta.url), "utf8");
const functions = source.slice(source.indexOf("function dynamicFunctionRenameCallSite("), source.indexOf("// The generated __toESM helper"));
function fixture() {
  const context = vm.createContext({ stack: "", pending: new Map() });
  vm.runInContext(`const ctPendingDynamicFunctionNames = pending;
    const nativeCaptureStackTrace = holder => { holder.stack = stack; };
    ${functions}`, context);
  return context;
}

test("generated runtime microtasks do not retain pending rename records on any platform", () => {
  for (const file of [
    "/home/user/.cache/cottontail/cache/module-runtime-abcd.mjs",
    "C:/Users/user/AppData/Local/cottontail/cache/module-runtime-abcd.mjs",
    "C:\\Users\\user\\cache\\module-runtime-abcd.mjs",
    "/tmp/cache/commonjs-runtime-abcd.mjs", "node:async_hooks", "bun:internal", "internal:timer",
  ]) {
    for (const stack of [`__name@${file}:1:1\nqueueMicrotask@${file}:828:5`, `Error\n    at __name (${file}:1:1)\n    at queueMicrotask (${file}:828:5)`]) {
      const context = fixture();
      context.stack = stack;
      vm.runInContext('for (let i = 0; i < 10000; i++) captureDynamicFunctionRename("wrapper", "runQueuedMicrotask");', context);
      assert.equal(context.pending.size, 0, stack);
    }
  }
});

test("user function renames are still retained, including similarly named user files", () => {
  const context = fixture();
  for (const file of ["/project/index.js", "/project/module-runtime-user.mjs", "/project/cache/user.mjs"]) {
    context.stack = `__name@${file}:1:1\nrename@${file}:24:7`;
    vm.runInContext('captureDynamicFunctionRename("original", "renamed");', context);
  }
  assert.equal(context.pending.get("original").length, 3);
  assert.equal(context.pending.get("original")[0].replacement, "renamed");
});
