import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Exercise the exact bootstrap expression embedded in the executable, without
// requiring a native rebuild for the object-semantics portion of this test.
const source = readFileSync(new URL("../../src/runtime_modules/internal/native-host-namespace.js", import.meta.url), "utf8");
const create = (0, eval)(source);
function fixture() {
  const calls = [];
  const host = create(index => {
    calls.push(index);
    return function nativeFixture() { return index; };
  }, ["first", null, "second"]);
  return { calls, host };
}

{
  const { host, calls } = fixture();
  assert.equal(Object.getPrototypeOf(host), Object.prototype);
  assert.deepEqual(Object.keys(host), ["first", "second"]);
  assert.deepEqual(Reflect.ownKeys(host), ["first", "second"]);
  assert.equal("first" in host, true);
  assert.equal(Object.hasOwn(host, "second"), true);
  const descriptors = Object.getOwnPropertyDescriptors(host);
  assert.equal(typeof descriptors.first.get, "function");
  assert.equal(descriptors.first.enumerable, true);
  assert.equal(descriptors.first.configurable, true);
  assert.deepEqual(calls, []);
  const first = host.first;
  assert.equal(first(), 0);
  assert.equal(host.first, first);
  assert.deepEqual(calls, [0]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(host, "first"), {
    value: first, writable: true, enumerable: true, configurable: true,
  });
  assert.equal(host.second(), 2);
  assert.deepEqual(calls, [0, 2]);
}
{
  const { host, calls } = fixture();
  host.first = "override";
  Object.defineProperty(host, "second", { value: 42 });
  assert.equal(host.first, "override");
  assert.equal(host.second, 42);
  assert.deepEqual(calls, []);
}
{
  const { host, calls } = fixture();
  const oldGetter = Object.getOwnPropertyDescriptor(host, "first").get;
  assert.equal(delete host.first, true);
  assert.equal(host.first, undefined);
  assert.equal("first" in host, false);
  assert.equal(oldGetter()(), 0);
  assert.equal(Object.hasOwn(host, "first"), false);
  host.first = "replacement";
  assert.equal(oldGetter()(), 0);
  assert.equal(host.first, "replacement");
  assert.deepEqual(calls, [0]);
}
{
  const { host, calls } = fixture();
  const child = Object.create(host);
  child.first = 19;
  assert.equal(Object.hasOwn(child, "first"), true);
  assert.equal(child.first, 19);
  assert.deepEqual(calls, []);
  assert.equal(host.first(), 0);
  assert.equal(child.second, host.second);
  assert.deepEqual(calls, [0, 2]);
}
for (const lock of [Object.preventExtensions, Object.seal, Object.freeze]) {
  const { host, calls } = fixture();
  lock(host);
  const first = host.first;
  assert.equal(first(), 0);
  assert.equal(host.first, first);
  assert.deepEqual(calls, [0]);
  if (lock === Object.preventExtensions) {
    assert.equal(Object.getOwnPropertyDescriptor(host, "first").value, first);
    host.second = 5;
    assert.equal(host.second, 5);
  } else {
    // Locking an unresolved accessor retains its stable cached function; no
    // redefinition or mutation of that non-configurable property is attempted.
    assert.equal(typeof Object.getOwnPropertyDescriptor(host, "first").get, "function");
    assert.throws(() => { host.first = 5; }, TypeError);
    assert.equal(host.first, first);
  }
}
{
  const { host } = fixture();
  const first = host.first;
  Object.seal(host);
  host.first = 7;
  assert.equal(host.first, 7);
  assert.equal(first(), 0);
}
{
  let attempts = 0;
  const host = create(() => {
    if (++attempts === 1) throw new Error("retry materialization");
    return 12;
  }, ["retry"]);
  assert.throws(() => host.retry, /retry materialization/);
  assert.equal(host.retry, 12);
  assert.equal(attempts, 2);
}
{
  const { host, calls } = fixture();
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  try {
    Object.defineProperty = Object.getOwnPropertyDescriptor = () => { throw new Error("replaced intrinsic"); };
    host.first;
    host.second = 9;
  } finally {
    Object.defineProperty = defineProperty;
    Object.getOwnPropertyDescriptor = getOwnPropertyDescriptor;
  }
  assert.equal(host.first(), 0);
  assert.equal(host.second, 9);
  assert.deepEqual(calls, [0]);
}
{
  const { host, calls } = fixture();
  assert.equal(runInNewContext("const fn = host.first; fn()", { host }), 0);
  assert.equal(runInNewContext("host.second = 23; host.second", { host }), 23);
  assert.equal(host.second, 23);
  assert.deepEqual(calls, [0]);
}
console.log("native host namespace factory passed");
