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
import { readFileSync, rmSync } from "node:fs";

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
const resourceTiming = performance.markResourceTiming(
  { startTime: 1, responseEnd: 5, transferSize: 10 },
  "https://example.test/asset.js",
  "script",
  globalThis,
  "",
  { encodedBodySize: 4, decodedBodySize: 6 },
  200,
  "cache",
);
assert(resourceTiming instanceof PerformanceResourceTiming, "markResourceTiming class mismatch");
assert(resourceTiming.duration === 4 && resourceTiming.initiatorType === "script", "markResourceTiming timing mismatch");
assert(resourceTiming.responseStatus === 200 && resourceTiming.encodedBodySize === 4, "markResourceTiming metadata mismatch");
assert(performance.getEntriesByType("resource").some((entry) => entry.name === "https://example.test/asset.js"), "resource timing entry missing");
performance.clearResourceTimings();
assert(performance.getEntriesByType("resource").length === 0, "clearResourceTimings mismatch");
assert(perfConstants.NODE_PERFORMANCE_GC_MAJOR === 4, "perf constants mismatch");

const histogram = createHistogram();
histogram.record(10);
histogram.record(20);
assert(histogram.min === 10 && histogram.max === 20 && histogram.count === 2, "histogram stats mismatch");
assert(histogram.percentile(50) === 10, "histogram percentile mismatch");
assert(histogram.minBigInt === 10n && histogram.countBigInt === 2n, "histogram bigint stats mismatch");
assert(histogram.percentiles instanceof Map && histogram.percentiles.has(100), "histogram percentiles map mismatch");
const boundedHistogram = createHistogram({ lowest: 1, highest: 10, figures: 1 });
boundedHistogram.record(5);
boundedHistogram.record(100);
assert(boundedHistogram.count === 1 && boundedHistogram.exceeds === 1, "histogram exceeds mismatch");
histogram.add(boundedHistogram);
assert(histogram.count === 3 && histogram.min === 5, "histogram add mismatch");
histogram.reset();
assert(histogram.count === 0 && Number.isNaN(histogram.mean), "histogram reset mismatch");
assert(histogram.minBigInt === 9223372036854775807n, "empty histogram minimum mismatch");
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
const replHistoryPath = `/tmp/cottontail-repl-${Date.now()}.history`;
rmSync(replHistoryPath, { force: true });
let historyReady = false;
repl.setupHistory(replHistoryPath, (error: Error | null) => {
  if (error) throw error;
  historyReady = true;
});
assert(historyReady, "REPL setupHistory callback mismatch");
repl.defineCommand("ping", {
  action(input: string) {
    this.output.write(`pong:${input}\n`);
  },
});
replInput.write("1 + 2\n");
replInput.write(".ping ok\n");
await new Promise((resolve) => setTimeout(resolve, 1));
repl.close();
assert(replOutput.includes("3"), "REPL evaluation mismatch");
assert(replOutput.includes("pong:ok"), "REPL custom command mismatch");
assert(readFileSync(replHistoryPath, "utf8").includes("1 + 2"), "REPL history persistence mismatch");
rmSync(replHistoryPath, { force: true });

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

const wasi = new WASI({ version: "preview1", returnOnExit: true, args: ["a"], env: { A: "1" }, preopens: { "/sandbox": "/tmp" } });
const wasiMemory = new WebAssembly.Memory({ initial: 1 });
const wasiInstance = {
  exports: {
    memory: wasiMemory,
    _initialize() {},
    _start: () => wasi.getImportObject().wasi_snapshot_preview1.proc_exit(7),
  },
};
wasi.initialize(wasiInstance);
const wasiImport = wasi.getImportObject().wasi_snapshot_preview1;
const wasiView = new DataView(wasiMemory.buffer);
assert(typeof wasiImport.fd_write === "function", "WASI import object mismatch");
assert(wasiImport.args_sizes_get(0, 4) === 0, "WASI args_sizes_get errno mismatch");
assert(wasiView.getUint32(0, true) === 1 && wasiView.getUint32(4, true) === 2, "WASI args_sizes_get memory mismatch");
assert(wasiImport.args_get(8, 16) === 0, "WASI args_get errno mismatch");
assert(Buffer.from(new Uint8Array(wasiMemory.buffer, 16, 2)).toString() === "a\0", "WASI args_get memory mismatch");
assert(wasiImport.environ_sizes_get(32, 36) === 0, "WASI environ_sizes_get errno mismatch");
assert(wasiView.getUint32(32, true) === 1 && wasiView.getUint32(36, true) === 4, "WASI environ_sizes_get memory mismatch");
assert(wasiImport.random_get(48, 8) === 0, "WASI random_get errno mismatch");
assert(wasiImport.clock_time_get(1, 0, 64) === 0 && wasiView.getBigUint64(64, true) > 0n, "WASI clock_time_get mismatch");
new Uint8Array(wasiMemory.buffer, 96, 2).set(Buffer.from("ok"));
wasiView.setUint32(80, 96, true);
wasiView.setUint32(84, 2, true);
assert(wasiImport.fd_write(1, 80, 1, 88) === 0 && wasiView.getUint32(88, true) === 2, "WASI fd_write mismatch");
assert(wasiImport.fd_fdstat_get(1, 104) === 0, "WASI fd_fdstat_get stdio mismatch");
assert(wasiImport.fd_prestat_get(3, 128) === 0 && wasiView.getUint32(132, true) === "/sandbox".length, "WASI fd_prestat_get mismatch");
assert(wasiImport.fd_prestat_dir_name(3, 144, 16) === 0, "WASI fd_prestat_dir_name errno mismatch");
assert(Buffer.from(new Uint8Array(wasiMemory.buffer, 144, "/sandbox".length)).toString() === "/sandbox", "WASI preopen name mismatch");
const wasiFileName = `cottontail-wasi-${Date.now()}.txt`;
const wasiFileNameBytes = Buffer.from(wasiFileName);
new Uint8Array(wasiMemory.buffer, 1024, wasiFileNameBytes.byteLength).set(wasiFileNameBytes);
assert(wasiImport.path_open(3, 0, 1024, wasiFileNameBytes.byteLength, 1 | 8, 0n, 0n, 0, 480) === 0, "WASI path_open create mismatch");
const wasiFd = wasiView.getUint32(480, true);
const wasiWriteBytes = Buffer.from("wasi-file-ok");
new Uint8Array(wasiMemory.buffer, 560, wasiWriteBytes.byteLength).set(wasiWriteBytes);
wasiView.setUint32(544, 560, true);
wasiView.setUint32(548, wasiWriteBytes.byteLength, true);
assert(wasiImport.fd_write(wasiFd, 544, 1, 536) === 0, "WASI fd_write file mismatch");
assert(wasiView.getUint32(536, true) === wasiWriteBytes.byteLength, "WASI fd_write byte count mismatch");
assert(wasiImport.fd_seek(wasiFd, 0n, 0, 584) === 0 && wasiView.getBigUint64(584, true) === 0n, "WASI fd_seek mismatch");
wasiView.setUint32(592, 608, true);
wasiView.setUint32(596, wasiWriteBytes.byteLength, true);
assert(wasiImport.fd_read(wasiFd, 592, 1, 600) === 0, "WASI fd_read file mismatch");
assert(wasiView.getUint32(600, true) === wasiWriteBytes.byteLength, "WASI fd_read byte count mismatch");
assert(Buffer.from(new Uint8Array(wasiMemory.buffer, 608, wasiWriteBytes.byteLength)).toString() === "wasi-file-ok", "WASI fd_read content mismatch");
assert(wasiImport.fd_filestat_get(wasiFd, 640) === 0, "WASI fd_filestat_get mismatch");
assert(wasiView.getUint8(656) === 4 && wasiView.getBigUint64(672, true) === BigInt(wasiWriteBytes.byteLength), "WASI fd_filestat_get content mismatch");
assert(wasiImport.fd_close(wasiFd) === 0, "WASI fd_close mismatch");
assert(wasiImport.path_filestat_get(3, 1, 1024, wasiFileNameBytes.byteLength, 704) === 0, "WASI path_filestat_get mismatch");
assert(wasiView.getUint8(720) === 4, "WASI path_filestat_get filetype mismatch");
assert(wasiImport.path_unlink_file(3, 1024, wasiFileNameBytes.byteLength) === 0, "WASI path_unlink_file mismatch");
const wasiDirName = `cottontail-wasi-dir-${Date.now()}`;
const wasiDirNameBytes = Buffer.from(wasiDirName);
new Uint8Array(wasiMemory.buffer, 2048, wasiDirNameBytes.byteLength).set(wasiDirNameBytes);
assert(wasiImport.path_create_directory(3, 2048, wasiDirNameBytes.byteLength) === 0, "WASI path_create_directory mismatch");
const wasiNestedName = `${wasiDirName}/entry.txt`;
const wasiNestedNameBytes = Buffer.from(wasiNestedName);
new Uint8Array(wasiMemory.buffer, 2112, wasiNestedNameBytes.byteLength).set(wasiNestedNameBytes);
assert(wasiImport.path_open(3, 0, 2112, wasiNestedNameBytes.byteLength, 1 | 8, 0n, 0n, 0, 2200) === 0, "WASI nested path_open mismatch");
const wasiNestedFd = wasiView.getUint32(2200, true);
assert(wasiImport.fd_close(wasiNestedFd) === 0, "WASI nested fd_close mismatch");
assert(wasiImport.path_open(3, 0, 2048, wasiDirNameBytes.byteLength, 2, 0n, 0n, 0, 2208) === 0, "WASI directory path_open mismatch");
const wasiDirFd = wasiView.getUint32(2208, true);
assert(wasiImport.fd_readdir(wasiDirFd, 2300, 256, 0n, 2280) === 0, "WASI fd_readdir mismatch");
const readdirBytes = wasiView.getUint32(2280, true);
const readdirNames: string[] = [];
let readdirOffset = 2300;
while (readdirOffset < 2300 + readdirBytes) {
  const nameLength = wasiView.getUint32(readdirOffset + 16, true);
  const filetype = wasiView.getUint8(readdirOffset + 20);
  const name = Buffer.from(new Uint8Array(wasiMemory.buffer, readdirOffset + 24, nameLength)).toString();
  readdirNames.push(`${filetype}:${name}`);
  readdirOffset += 24 + nameLength;
}
assert(readdirNames.includes("4:entry.txt"), "WASI fd_readdir content mismatch");
assert(wasiImport.fd_close(wasiDirFd) === 0, "WASI directory fd_close mismatch");
assert(wasiImport.path_unlink_file(3, 2112, wasiNestedNameBytes.byteLength) === 0, "WASI nested unlink mismatch");
assert(wasiImport.path_remove_directory(3, 2048, wasiDirNameBytes.byteLength) === 0, "WASI path_remove_directory mismatch");
assert(wasiImport.poll_oneoff(0, 0, 0, 768) === 0 && wasiView.getUint32(768, true) === 0, "WASI empty poll_oneoff mismatch");
wasiView.setBigUint64(1500, 123n, true);
wasiView.setUint8(1508, 0);
wasiView.setUint32(1516, 1, true);
wasiView.setBigUint64(1524, 0n, true);
wasiView.setBigUint64(1532, 0n, true);
wasiView.setUint16(1540, 0, true);
assert(wasiImport.poll_oneoff(1500, 1560, 1, 1596) === 0, "WASI clock poll_oneoff mismatch");
assert(wasiView.getUint32(1596, true) === 1 && wasiView.getBigUint64(1560, true) === 123n && wasiView.getUint8(1570) === 0, "WASI clock poll_oneoff event mismatch");
wasiView.setBigUint64(1600, 456n, true);
wasiView.setUint8(1608, 2);
wasiView.setUint32(1616, 1, true);
assert(wasiImport.poll_oneoff(1600, 1660, 1, 1696) === 0, "WASI fd poll_oneoff mismatch");
assert(wasiView.getUint32(1696, true) === 1 && wasiView.getBigUint64(1660, true) === 456n && wasiView.getUint8(1670) === 2, "WASI fd poll_oneoff event mismatch");
assert(wasi.start(wasiInstance) === 7, "WASI start/proc_exit mismatch");

console.log("node instrumentation surface passed");
