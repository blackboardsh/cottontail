import {
  Performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
  PerformanceObserverEntryList,
  PerformanceResourceTiming,
  constants as perfConstants,
  createHistogram,
  monitorEventLoopDelay,
  performance,
} from "node:perf_hooks";
import DomainDefault, {
  Domain,
  _stack,
  active,
  create as createDomain,
  createDomain as createDomainAlias,
} from "node:domain";
import { createTracing, getEnabledCategories } from "node:trace_events";
import {
  getAsset,
  getAssetAsBlob,
  getAssetKeys,
  getRawAsset,
  isSea,
} from "node:sea";
import {
  REPLServer,
  REPL_MODE_SLOPPY,
  REPL_MODE_STRICT,
  Recoverable,
  _builtinLibs,
  builtinModules,
  isValidSyntax,
  start as startRepl,
  writer,
} from "node:repl";
import {
  dot,
  junit,
  lcov,
  spec,
  tap,
} from "node:test/reporters";
import { WASI } from "node:wasi";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createRequire } from "node:module";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const require = createRequire(import.meta.url);
assert(require("node:perf_hooks").performance === performance, "require perf_hooks mismatch");
assert(require("node:domain").Domain === Domain, "require domain mismatch");
assert(require("trace_events").createTracing === createTracing, "require trace_events mismatch");
assert(require("node:sea").isSea === isSea, "require node:sea mismatch");
assert(require("node:test/reporters").tap === tap, "require node:test/reporters mismatch");

const observed = new Promise<string>((resolve) => {
  const observer = new PerformanceObserver((list, obs) => {
    assert(list instanceof PerformanceObserverEntryList, "observer list class mismatch");
    obs.disconnect();
    resolve(list.getEntriesByType("measure")[0]?.name ?? "");
  });
  observer.observe({ entryTypes: ["measure"] });
});
performance.mark("start");
performance.mark("end");
const measure = performance.measure("duration", "start", "end");
assert(measure instanceof PerformanceMeasure, "performance.measure class mismatch");
assert(await observed === "duration", "PerformanceObserver measure mismatch");
assert(performance.getEntriesByName("duration", "measure").length === 1, "getEntriesByName mismatch");
performance.clearMarks();
performance.clearMeasures();
assert(performance.getEntries().length === 0, "performance clear mismatch");
assert(new Performance().now() >= 0, "Performance now mismatch");
assert(new PerformanceEntry("entry", "mark", 1, 2).toJSON().duration === 2, "PerformanceEntry toJSON mismatch");
assert(new PerformanceMark("mark") instanceof PerformanceEntry, "PerformanceMark mismatch");
assert(new PerformanceResourceTiming("resource") instanceof PerformanceEntry, "PerformanceResourceTiming mismatch");
assert(perfConstants.NODE_PERFORMANCE_GC_MAJOR === 4, "perf constants mismatch");

const histogram = createHistogram();
histogram.record(10);
histogram.record(20);
assert(histogram.min === 10 && histogram.max === 20 && histogram.count === 2, "histogram stats mismatch");
assert(histogram.percentile(50) === 10, "histogram percentile mismatch");
const delay = monitorEventLoopDelay({ resolution: 1 });
assert(delay.enable() === true, "monitorEventLoopDelay enable mismatch");
assert(delay.disable() === true, "monitorEventLoopDelay disable mismatch");

const domain = createDomain();
assert(domain instanceof Domain, "domain create mismatch");
assert(createDomainAlias() instanceof Domain, "createDomain alias mismatch");
assert(DomainDefault.Domain === Domain, "domain default mismatch");
let domainError = "";
domain.on("error", (error) => { domainError = error.message; });
domain.run(() => {
  assert(active === domain, "domain active mismatch");
  throw new Error("domain-boom");
});
assert(domainError === "domain-boom", "domain error capture mismatch");
assert(active === null && _stack.length === 0, "domain active cleanup mismatch");
const emitter = new EventEmitter();
domain.add(emitter);
emitter.emit("error", new Error("member-boom"));
assert(domainError === "member-boom", "domain member error mismatch");
domain.remove(emitter);

const tracing = createTracing({ categories: ["node", "cottontail"] });
assert(tracing.enabled === false, "trace initial enabled mismatch");
tracing.enable();
assert(tracing.enabled === true && getEnabledCategories().includes("cottontail"), "trace enable mismatch");
tracing.disable();
assert(tracing.enabled === false, "trace disable mismatch");

assert(isSea() === false, "isSea mismatch");
for (const fn of [getAsset, getAssetAsBlob, getAssetKeys, getRawAsset]) {
  let threw = false;
  try {
    fn("asset" as never);
  } catch (error) {
    threw = error?.code === "ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION";
  }
  assert(threw, "node:sea non-SEA error mismatch");
}

assert(typeof REPL_MODE_SLOPPY === "symbol" && typeof REPL_MODE_STRICT === "symbol", "REPL mode symbols mismatch");
assert(isValidSyntax("const value = 1;"), "isValidSyntax true mismatch");
assert(!isValidSyntax("const ="), "isValidSyntax false mismatch");
assert(writer({ a: 1 }).includes("a"), "repl writer mismatch");
assert(builtinModules.includes("fs") && _builtinLibs.includes("fs"), "repl builtin modules mismatch");
assert(new Recoverable(new SyntaxError("more")).message === "more", "Recoverable mismatch");

let replOutput = "";
const replInput = new PassThrough();
const replOutputStream = new Writable({
  write(chunk, _encoding, callback) {
    replOutput += String(chunk);
    callback();
  },
});
const repl = startRepl({ input: replInput, output: replOutputStream, terminal: false });
assert(repl instanceof REPLServer, "start should return REPLServer");
replInput.write("1 + 2\n");
await new Promise((resolve) => setTimeout(resolve, 1));
repl.close();
assert(replOutput.includes("3"), "REPL evaluation mismatch");

async function *testEvents() {
  yield { type: "test:pass", data: { name: "ok-test" } };
  yield { type: "test:fail", data: { name: "bad-test" } };
}

async function collect(source) {
  let output = "";
  for await (const chunk of source) output += String(chunk);
  return output;
}

assert((await collect(tap(testEvents()))).includes("ok 1 ok-test"), "tap reporter mismatch");
assert((await collect(dot(testEvents()))).includes("X"), "dot reporter mismatch");
assert((await collect(junit(testEvents()))).includes("<testsuite"), "junit reporter mismatch");
assert((await collect(spec(testEvents()))).includes("TAP version"), "spec reporter mismatch");
assert((await collect(lcov(testEvents()))) === "", "lcov reporter mismatch");

const wasi = new WASI({ returnOnExit: true, args: ["a"], env: { A: "1" } });
assert(typeof wasi.getImportObject().wasi_snapshot_preview1.fd_write === "function", "WASI import object mismatch");
assert(wasi.start({ exports: { _start: () => 7 } }) === 7, "WASI start mismatch");
let wasiImportThrew = false;
try {
  wasi.getImportObject().wasi_snapshot_preview1.fd_write();
} catch {
  wasiImportThrew = true;
}
assert(wasiImportThrew, "WASI unsupported syscall should throw");

console.log("node instrumentation surface passed");
