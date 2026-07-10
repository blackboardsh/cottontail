import {
  describe as jscDescribe,
  describeArray,
  drainMicrotasks,
  estimateShallowMemoryUsageOf,
  fullGC,
  gcAndSweep,
  getRandomSeed,
  heapSize,
  heapStats,
  memoryUsage,
  noFTL,
  noInline,
  optimizeNextInvocation,
  percentAvailableMemoryInUse,
  profile,
  samplingProfilerStackTraces,
  serialize,
  deserialize,
  setRandomSeed,
  setTimeZone,
  startRemoteDebugger,
  startSamplingProfiler,
} from "bun:jsc";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const payload = { name: "cottontail", values: [1, 2, 3] };
const encoded = serialize(payload);
assert(encoded instanceof Uint8Array, "bun:jsc serialize should return bytes");
assert(JSON.stringify(deserialize(encoded)) === JSON.stringify(payload), "bun:jsc deserialize mismatch");
assert(typeof heapSize() === "number", "bun:jsc heapSize mismatch");
assert(typeof heapStats().used_heap_size === "number", "bun:jsc heapStats mismatch");
assert(typeof memoryUsage() === "object", "bun:jsc memoryUsage mismatch");
assert(percentAvailableMemoryInUse() >= 0, "bun:jsc percentAvailableMemoryInUse mismatch");
assert(estimateShallowMemoryUsageOf(new Uint8Array(4)) === 4, "bun:jsc shallow size mismatch");
assert(jscDescribe({ a: 1 }).includes("a"), "bun:jsc describe mismatch");
assert(describeArray([1, "a"]).length === 2, "bun:jsc describeArray mismatch");
setRandomSeed(123);
assert(getRandomSeed() === 123, "bun:jsc random seed mismatch");
setTimeZone("UTC");
assert(process.env.TZ === "UTC", "bun:jsc timezone mismatch");
const passthrough = () => 7;
assert(noInline(passthrough)() === 7, "bun:jsc noInline mismatch");
assert(noFTL(passthrough)() === 7, "bun:jsc noFTL mismatch");
assert(optimizeNextInvocation(passthrough)() === 7, "bun:jsc optimizeNextInvocation mismatch");
assert(profile(() => 9).result === 9, "bun:jsc profile mismatch");
startSamplingProfiler();
assert(Array.isArray(samplingProfilerStackTraces()), "bun:jsc sampling profiler mismatch");
assert(startRemoteDebugger() === false, "bun:jsc remote debugger mismatch");
drainMicrotasks();
fullGC();
gcAndSweep();

assert(Bun.cwd === process.cwd(), "Bun.cwd mismatch");
assert(Bun.isMainThread === true, "Bun.isMainThread mismatch");
assert(Bun.deepEquals({ a: 1 }, { a: 1 }), "Bun.deepEquals mismatch");
assert(Bun.deepMatch({ a: { b: 1, c: 2 } }, { a: { b: 1 } }), "Bun.deepMatch mismatch");
assert(Bun.escapeHTML("<>&") === "&lt;&gt;&amp;", "Bun.escapeHTML mismatch");
assert(Bun.stripANSI("\u001b[31mred\u001b[0m") === "red", "Bun.stripANSI mismatch");
assert(Bun.stringWidth("abc") === 3, "Bun.stringWidth mismatch");

const compressed = Bun.gzipSync("hello");
assert(Bun.gunzipSync(compressed).toString() === "hello", "Bun gzip/gunzip mismatch");
assert(Buffer.from(Bun.sha("abc")).toString("hex") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "Bun.sha mismatch");
assert(new Bun.SHA256().update("abc").digest("hex") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "Bun.SHA256 digest mismatch");
assert(Bun.randomUUIDv7().includes("-"), "Bun.randomUUIDv7 mismatch");

const sink = new Bun.ArrayBufferSink();
sink.write("ab");
sink.write(new Uint8Array([99]));
assert(new TextDecoder().decode(sink.end()) === "abc", "Bun.ArrayBufferSink mismatch");

const chunks = await Bun.readableStreamToText((async function* streamChunks() {
  yield new TextEncoder().encode("stream");
})());
assert(chunks === "stream", "Bun readableStreamToText mismatch");

const glob = new Bun.Glob("bun-*.ts");
assert(glob.match("bun-sqlite.ts"), "Bun.Glob match mismatch");
assert(glob.scanSync({ cwd: "tests/js" }).includes("bun-sqlite.ts"), "Bun.Glob scanSync mismatch");

const router = new Bun.FileSystemRouter({ style: "nextjs", dir: "tests/js" });
assert(router.routes["/bun-sqlite"]?.filePath.endsWith("bun-sqlite.ts"), "Bun.FileSystemRouter routes mismatch");
assert(router.match("/bun-sqlite").pathname === "/bun-sqlite", "Bun.FileSystemRouter match mismatch");

const transpiler = new Bun.Transpiler({ loader: "ts" });
const transformed = transpiler.transformSync("export const value: number = 1;");
assert(transformed.includes("export const value = 1"), "Bun.Transpiler transformSync mismatch");
const scan = transpiler.scan('import x from "pkg"; export const value = 1;');
assert(scan.imports[0].path === "pkg" && scan.exports.includes("value"), "Bun.Transpiler scan mismatch");

console.log("bun jsc and global passed");
