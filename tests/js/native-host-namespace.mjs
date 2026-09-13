import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { isMainThread, parentPort, Worker } from "node:worker_threads";

const host = globalThis.cottontail;
assert.equal(Object.getPrototypeOf(host), Object.prototype);
const descriptors = Object.getOwnPropertyDescriptors(host);
const lazyNames = Object.keys(descriptors).filter(name => typeof descriptors[name].get === "function");
assert.ok(lazyNames.length > 2, "unused native functions must remain lazy");
assert.deepEqual(Object.keys(host).sort(), Object.keys(descriptors).sort());
for (const name of lazyNames) assert.equal(Object.getOwnPropertyDescriptor(host, name).get, descriptors[name].get);

const [readName, overrideName, deleteName] = lazyNames;
const native = host[readName];
assert.equal(typeof native, "function");
assert.equal(host[readName], native);
assert.deepEqual(Object.getOwnPropertyDescriptor(host, readName), {
  value: native, writable: true, enumerable: true, configurable: true,
});
try {
  host[overrideName] = "user override";
  assert.equal(host[overrideName], "user override");
  assert.equal(delete host[deleteName], true);
  assert.equal(host[deleteName], undefined);
  assert.equal(Object.hasOwn(host, deleteName), false);
} finally {
  Object.defineProperty(host, overrideName, descriptors[overrideName]);
  Object.defineProperty(host, deleteName, descriptors[deleteName]);
}

// Legacy callbacks must keep their original opaque runtime context even when
// detached or called from another VM context. Do not invoke arbitrary names.
const nanotime = host.nanotime;
const now = nanotime();
assert.ok(Number.isFinite(now));
assert.ok(runInNewContext("const fn = host.nanotime; fn()", { host }) >= now);
const nextTick = host.nextTickState;
assert.equal(nextTick(false, true), undefined);
host.gc(true);
assert.ok(nanotime() >= now);
assert.equal(nextTick(false, true), undefined);
// A direct binding that also has a legacy definition must retain its direct
// implementation and arity, rather than being registered twice or downgraded.
assert.equal(host.textEncode.length, 1);
assert.equal(host.bufferCompare.length, 6);
assert.equal(new TextDecoder().decode(host.textEncode("native namespace")), "native namespace");

// Record controls, not a noisy wall-clock pass/fail threshold. The structural
// assertions above guarantee that hot property access is now a data lookup.
const timings = [];
function measure(label, call) {
  const start = nanotime();
  for (let index = 0; index < 1000; index++) call();
  timings.push({ label, count: 1000, ms: (nanotime() - start) / 1e6 });
}
measure("property-only", () => host.nanotime);
measure("namespace-call", () => host.nanotime());
measure("cached-call", () => nanotime());
assert.equal(Object.getOwnPropertyDescriptor(host, "nanotime").value, nanotime);
if (isMainThread) {
  await new Promise((resolve, reject) => {
    let received = false;
    const worker = new Worker(new URL(import.meta.url));
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("native namespace worker timed out")); }, 30_000);
    worker.once("message", message => {
      received = message?.ok === true;
      if (!received) reject(new Error("invalid native namespace worker response"));
    });
    worker.once("error", error => { clearTimeout(timer); reject(error); });
    worker.once("exit", code => {
      clearTimeout(timer);
      if (code !== 0 || !received) reject(new Error(`native namespace worker exited ${code} before success`));
      else resolve();
    });
  });
  console.log(JSON.stringify({ runtime: process.versions.cottontail, timings }));
  console.log("native host namespace passed");
} else {
  parentPort.postMessage({ ok: true, timings });
  parentPort.close();
}
