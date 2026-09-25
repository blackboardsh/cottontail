import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const hookName = "__cottontailHasActiveHandles";
function install(value) {
  Object.defineProperty(globalThis, hookName, { configurable: true, writable: true, value });
}

if (mode === "replace") {
  install(function () {
    assert.equal(this, globalThis, "active-handle hooks receive the global object");
    console.log("initial hook");
    install(function () {
      assert.equal(this, globalThis);
      console.log("replacement hook");
      return false;
    });
    return true;
  });
} else if (mode === "getter") {
  let reads = 0;
  Object.defineProperty(globalThis, hookName, {
    configurable: true,
    get() {
      reads += 1;
      if (reads % 2 === 1) return () => { throw new Error("conditional lookup was called"); };
      return function () {
        assert.equal(this, globalThis);
        console.log("accessor hook");
        return false;
      };
    },
  });
} else if (mode === "falsy") {
  install(false);
  console.log("falsy hook");
} else if (mode === "native-after-hook") {
  install(() => {
    install(false);
    queueMicrotask(() => setTimeout(() => console.log("native timer after hook"), 10));
    return false;
  });
} else if (mode === "throw-call") {
  install(() => { throw new Error("active hook call sentinel"); });
} else if (mode === "throw-get") {
  Object.defineProperty(globalThis, hookName, {
    configurable: true,
    get() { throw new Error("active hook getter sentinel"); },
  });
} else if (mode === "non-callable") {
  install({});
} else {
  for (const [childMode, expected, succeeds] of [
    ["replace", /initial hook\s+replacement hook/, true],
    ["getter", /accessor hook/, true],
    ["falsy", /falsy hook/, true],
    ["native-after-hook", /native timer after hook/, true],
    ["throw-call", /active hook call sentinel/, false],
    ["throw-get", /active hook getter sentinel/, false],
    ["non-callable", /TypeError/, false],
  ]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), childMode], {
      encoding: "utf8",
      timeout: process.platform === "win32" ? 30_000 : 10_000,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, `${childMode}: child must exit naturally`);
    if (succeeds) {
      assert.equal(child.status, 0, `${childMode}: ${child.stderr}`);
      assert.equal(child.stderr, "");
      assert.match(child.stdout, expected);
    } else {
      assert.notEqual(child.status, 0, `${childMode}: exception must fail the process`);
      assert.match(child.stderr, expected);
    }
  }
  console.log("runtime active handles passed");
}
