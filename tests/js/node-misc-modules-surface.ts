import { createRequire } from "node:module";
import { EventEmitter, on as eventsOn } from "node:events";
import { setImmediate as setImmediateTimer, clearImmediate, promises as timerPromises } from "node:timers";
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

const {
  file: importMetaFile,
  path: importMetaPath,
  dir: importMetaDir,
  url: importMetaURL,
} = import.meta;
const normalizedImportMetaPath = importMetaPath.replaceAll("\\", "/");
assert(importMetaFile === "node-misc-modules-surface.ts", "destructured import.meta.file mismatch");
assert(normalizedImportMetaPath.endsWith("/tests/js/node-misc-modules-surface.ts"), "destructured import.meta.path mismatch");
assert(importMetaDir.replaceAll("\\", "/").endsWith("/tests/js"), "destructured import.meta.dir mismatch");
assert(importMetaURL.endsWith("/tests/js/node-misc-modules-surface.ts"), "destructured import.meta.url mismatch");

class AsyncPrivateMethod {
  async #import() { return 42; }
  read() { return this.#import(); }
}
assert(await new AsyncPrivateMethod().read() === 42, "async private method output mismatch");

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
const calledDecoder: { encoding?: string } = {};
StringDecoder.call(calledDecoder, "utf8");
assert(calledDecoder.encoding === "utf8", "StringDecoder.call should initialize its receiver");

const stackError = new TypeError("stack header");
assert(stackError.stack?.startsWith("TypeError: stack header\n"), "Error stack should include Node-style name and message");
assert(stackError instanceof TypeError && stackError instanceof Error, "wrapped Error constructors should preserve instanceof");

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

const emissionOrder: string[] = [];
const orderingEmitter = new EventEmitter();
orderingEmitter.on("ordered", () => {
  emissionOrder.push("first");
  queueMicrotask(() => emissionOrder.push("microtask"));
});
orderingEmitter.on("ordered", () => emissionOrder.push("second"));
orderingEmitter.emit("ordered");
assert(emissionOrder.join(",") === "first,second", "EventEmitter drained jobs between listeners");
await Promise.resolve();
assert(emissionOrder.join(",") === "first,second,microtask", "EventEmitter microtask order mismatch");

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
let awaitedStoreValue = 0;
const awaitedScope = storage.run({ value: 17 }, async () => {
  await Promise.resolve();
  awaitedStoreValue = storage.getStore()?.value ?? 0;
});
assert(storage.getStore() === undefined, "AsyncLocalStorage async run parent restoration mismatch");
await awaitedScope;
assert(awaitedStoreValue === 17, "AsyncLocalStorage await propagation mismatch");
let streamStoreValue = 0;
const contextualStream = storage.run({ value: 18 }, () => new ReadableStream({
  pull(controller) {
    streamStoreValue = storage.getStore()?.value ?? 0;
    controller.close();
  },
}));
await contextualStream.getReader().read();
assert(streamStoreValue === 18, "AsyncLocalStorage ReadableStream propagation mismatch");
let eventStoreValue = 0;
const eventStorage = new AsyncLocalStorage();
await new Promise<void>((resolve) => {
  eventStorage.run({ value: 19 }, () => {
    const emitter = new EventEmitter();
    emitter.once("async", async () => {
      await immediate();
      eventStoreValue = eventStorage.getStore()?.value ?? 0;
      resolve();
    });
    emitter.emit("async");
  });
});
await immediate();
assert(eventStoreValue === 19, "AsyncLocalStorage async EventEmitter propagation mismatch");
assert(eventStorage.getStore() === undefined, "AsyncLocalStorage EventEmitter restoration mismatch");
let iteratorStoreValue = 0;
const iteratorStorage = new AsyncLocalStorage();
const iteratorEmitter = new EventEmitter();
await iteratorStorage.run({ value: 20 }, async () => {
  const values = eventsOn(iteratorEmitter, "data");
  setImmediateTimer(() => iteratorEmitter.emit("data", "done"));
  for await (const [value] of values) {
    iteratorStoreValue = iteratorStorage.getStore()?.value ?? 0;
    if (value === "done") break;
  }
});
assert(iteratorStoreValue === 20, "AsyncLocalStorage events.on propagation mismatch");
assert(iteratorStorage.getStore() === undefined, "AsyncLocalStorage events.on restoration mismatch");
let repeatedPulls = 0;
const repeatedStreamStorage = new AsyncLocalStorage();
const repeatedStream = repeatedStreamStorage.run({ value: 21 }, () => new ReadableStream({
  async pull(controller) {
    controller.enqueue(repeatedStreamStorage.getStore()?.value);
    repeatedPulls += 1;
    if (repeatedPulls === 3) controller.close();
    else await sleep(1);
  },
}));
assert(repeatedStreamStorage.getStore() === undefined, "AsyncLocalStorage repeated stream parent restoration mismatch");
const repeatedReader = repeatedStream.getReader();
while (!(await repeatedReader.read()).done) {}
assert(repeatedStreamStorage.getStore() === undefined, "AsyncLocalStorage repeated stream final restoration mismatch");
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
const dynamicTimerPromises = await import("node:timers/promises");
assert(dynamicTimerPromises.default === timerPromises, "dynamic timers/promises default identity mismatch");
const handle = setImmediateTimer(() => {});
clearImmediate(handle);

try {
  require("cottontail-package-that-does-not-exist");
  throw new Error("missing package require should throw");
} catch (error) {
  assert((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND", "missing package error type mismatch");
}

const malformedModuleURL = URL.createObjectURL(new Blob(["export const = 1"]));
try {
  require(malformedModuleURL);
  throw new Error("malformed blob module require should throw");
} catch (error) {
  assert((error as Error).constructor.name === "BuildMessage", "malformed blob module error type mismatch");
} finally {
  URL.revokeObjectURL(malformedModuleURL);
}

console.log("node misc modules surface passed");
