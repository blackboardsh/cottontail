import { createRequire } from "node:module";
import { setImmediate as setImmediateTimer, clearImmediate } from "node:timers";
import { setTimeout as sleep, setImmediate as immediate, scheduler } from "node:timers/promises";
import querystring from "node:querystring";
import { StringDecoder } from "node:string_decoder";
import punycode from "node:punycode";
import {
  AsyncLocalStorage,
  AsyncResource,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
} from "node:async_hooks";
import {
  channel,
  hasSubscribers,
  subscribe,
  tracingChannel,
  unsubscribe,
} from "node:diagnostics_channel";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const require = createRequire(import.meta.url);

const parsed = querystring.parse("a=1&a=2&b=hello+world");
assert(Array.isArray(parsed.a) && parsed.a[1] === "2", "querystring repeated key mismatch");
assert(parsed.b === "hello world", "querystring plus decode mismatch");
assert(querystring.stringify({ a: ["1", "2"], b: "x y" }) === "a=1&a=2&b=x%20y", "querystring stringify mismatch");
assert(querystring.unescapeBuffer("a%20b").toString() === "a b", "querystring unescapeBuffer mismatch");

const decoder = new StringDecoder("utf8");
const euro = new Uint8Array([0xe2, 0x82, 0xac]);
assert(decoder.write(euro.subarray(0, 2)) === "", "StringDecoder should buffer incomplete UTF-8");
assert(decoder.write(euro.subarray(2)) === "€", "StringDecoder should complete UTF-8");
assert(decoder.end() === "", "StringDecoder end mismatch");

assert(punycode.encode("mañana") === "maana-pta", "punycode encode mismatch");
assert(punycode.decode("maana-pta") === "mañana", "punycode decode mismatch");
assert(punycode.toASCII("mañana.com") === "xn--maana-pta.com", "punycode toASCII mismatch");
assert(punycode.toUnicode("xn--maana-pta.com") === "mañana.com", "punycode toUnicode mismatch");
assert(punycode.ucs2.decode("😀").length === 1, "punycode ucs2 decode mismatch");
assert(require("punycode").decode("maana-pta") === "mañana", "require punycode mismatch");

let diagnosticsMessage = "";
function diagnosticsListener(message, name) {
  diagnosticsMessage = `${name}:${message.value}`;
}
subscribe("cottontail:test", diagnosticsListener);
assert(hasSubscribers("cottontail:test"), "diagnostics_channel hasSubscribers mismatch");
channel("cottontail:test").publish({ value: "ok" });
unsubscribe("cottontail:test", diagnosticsListener);
assert(diagnosticsMessage === "cottontail:test:ok", "diagnostics_channel publish mismatch");

const trace = tracingChannel("cottontail:trace");
let traceStart = false;
trace.start.subscribe(() => { traceStart = true; });
assert(trace.traceSync(() => 42) === 42, "tracingChannel traceSync result mismatch");
assert(traceStart, "tracingChannel start mismatch");

let hookInit = false;
const hook = createHook({ init() { hookInit = true; } }).enable();
const resource = new AsyncResource("COTTONTAIL_TEST");
assert(resource.asyncId() > 0, "AsyncResource asyncId mismatch");
let scoped = false;
resource.runInAsyncScope(() => {
  scoped = executionAsyncId() === resource.asyncId() && executionAsyncResource() === resource;
});
resource.emitDestroy();
hook.disable();
assert(hookInit, "async_hooks init mismatch");
assert(scoped, "AsyncResource scope mismatch");
assert(triggerAsyncId() >= 0, "triggerAsyncId mismatch");

const storage = new AsyncLocalStorage();
assert(storage.run({ value: 7 }, () => storage.getStore()?.value) === 7, "AsyncLocalStorage run mismatch");
let timerStoreValue = 0;
await new Promise<void>((resolve) => {
  storage.run({ value: 10 }, () => {
    globalThis.setTimeout(() => {
      timerStoreValue = storage.getStore()?.value ?? 0;
      resolve();
    }, 0);
  });
});
assert(timerStoreValue === 10, "AsyncLocalStorage timer propagation mismatch");
let microtaskStoreValue = 0;
await new Promise<void>((resolve) => {
  storage.run({ value: 11 }, () => {
    queueMicrotask(() => {
      microtaskStoreValue = storage.getStore()?.value ?? 0;
      resolve();
    });
  });
});
assert(microtaskStoreValue === 11, "AsyncLocalStorage microtask propagation mismatch");
let promiseThenStoreValue = 0;
await storage.run({ value: 14 }, () => {
  return Promise.resolve("ok").then(() => {
    promiseThenStoreValue = storage.getStore()?.value ?? 0;
  });
});
assert(promiseThenStoreValue === 14, "AsyncLocalStorage promise then propagation mismatch");
let promiseCatchStoreValue = 0;
await storage.run({ value: 15 }, () => {
  return Promise.resolve().then(() => {
    throw new Error("expected");
  }).catch(() => {
    promiseCatchStoreValue = storage.getStore()?.value ?? 0;
  });
});
assert(promiseCatchStoreValue === 15, "AsyncLocalStorage promise catch propagation mismatch");
let promiseFinallyStoreValue = 0;
await storage.run({ value: 16 }, () => {
  return Promise.resolve().finally(() => {
    promiseFinallyStoreValue = storage.getStore()?.value ?? 0;
  });
});
assert(promiseFinallyStoreValue === 16, "AsyncLocalStorage promise finally propagation mismatch");
let immediateStoreValue = 0;
await new Promise<void>((resolve) => {
  storage.run({ value: 12 }, () => {
    setImmediateTimer(() => {
      immediateStoreValue = storage.getStore()?.value ?? 0;
      resolve();
    });
  });
});
assert(immediateStoreValue === 12, "AsyncLocalStorage timers module propagation mismatch");
let boundStore = () => 0;
let snapshotStore = (fn: () => number) => fn();
storage.run({ value: 13 }, () => {
  boundStore = AsyncLocalStorage.bind(() => storage.getStore()?.value ?? 0);
  snapshotStore = AsyncLocalStorage.snapshot();
});
assert(boundStore() === 13, "AsyncLocalStorage static bind mismatch");
assert(snapshotStore(() => storage.getStore()?.value ?? 0) === 13, "AsyncLocalStorage static snapshot mismatch");
storage.enterWith({ value: 9 });
assert(storage.getStore()?.value === 9, "AsyncLocalStorage enterWith mismatch");
storage.disable();
assert(storage.getStore() === undefined, "AsyncLocalStorage disable mismatch");

await sleep(1);
assert(await immediate("immediate-value") === "immediate-value", "timers/promises setImmediate mismatch");
await scheduler.yield();
const handle = setImmediateTimer(() => {});
clearImmediate(handle);

console.log("node misc modules surface passed");
