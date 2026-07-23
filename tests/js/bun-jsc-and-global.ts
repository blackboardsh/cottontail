import {
  callerSourceOrigin,
  describe as jscDescribe,
  jscDescribe as describeJscValue,
  describeArray,
  drainMicrotasks,
  estimateShallowMemoryUsageOf,
  fullGC,
  gcAndSweep,
  generateHeapSnapshotForDebugging,
  getProtectedObjects,
  getRandomSeed,
  heapSize,
  heapStats,
  isRope,
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
import vm from "node:vm";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const payload = { name: "cottontail", values: [1, 2, 3] };
const encoded = serialize(payload);
assert(encoded instanceof SharedArrayBuffer, "bun:jsc serialize should return shared bytes");
assert(JSON.stringify(deserialize(encoded)) === JSON.stringify(payload), "bun:jsc deserialize mismatch");
assert(heapSize() > 0, "bun:jsc heapSize mismatch");
assert(heapStats().heapCapacity > 0 && heapStats().objectCount > 0, "bun:jsc heapStats mismatch");
assert(memoryUsage().current > 0 && memoryUsage().peak > 0, "bun:jsc memoryUsage mismatch");
const debuggingSnapshot = generateHeapSnapshotForDebugging();
assert(debuggingSnapshot.type === "GCDebugging", "bun:jsc debugging heap snapshot type mismatch");
assert(Array.isArray(debuggingSnapshot.nodes) && debuggingSnapshot.nodes.length > 0, "bun:jsc debugging heap snapshot nodes mismatch");
assert(Array.isArray(debuggingSnapshot.labels), "bun:jsc debugging heap snapshot labels mismatch");
assert(percentAvailableMemoryInUse() >= 0, "bun:jsc percentAvailableMemoryInUse mismatch");
assert(estimateShallowMemoryUsageOf(new Uint8Array(4)) === 4, "bun:jsc shallow size mismatch");
assert(jscDescribe({ a: 1 }).includes("a"), "bun:jsc describe mismatch");
const utf16Data = new DataView(new ArrayBuffer(6));
utf16Data.setUint16(0, 49, true);
utf16Data.setUint16(2, 50, true);
utf16Data.setUint16(4, 51, true);
const utf16String = new TextDecoder("utf-16le").decode(utf16Data);
assert(describeJscValue("123").includes("8Bit:(1)"), "bun:jsc 8-bit string description mismatch");
assert(describeJscValue(utf16String).includes("8Bit:(0)"), "bun:jsc 16-bit string description mismatch");
assert(describeArray([1, "a"]).length === 2, "bun:jsc describeArray mismatch");
const sourceOrigin = callerSourceOrigin();
assert(
  sourceOrigin === import.meta.url,
  `bun:jsc callerSourceOrigin mismatch: expected ${import.meta.url}, received ${sourceOrigin}`,
);
const syncOriginModule = await import(new URL("./modules/jsc-caller-origin-sync.js?origin=sync", import.meta.url).href);
assert(
  syncOriginModule.sourceOrigin === syncOriginModule.metaUrl,
  `bun:jsc sync child callerSourceOrigin mismatch: expected ${syncOriginModule.metaUrl}, received ${syncOriginModule.sourceOrigin}`,
);
const asyncOriginModule = await import(new URL("./modules/jsc-caller-origin-async.js#origin=async", import.meta.url).href);
assert(
  asyncOriginModule.sourceOrigin === asyncOriginModule.metaUrl,
  `bun:jsc async child callerSourceOrigin mismatch: expected ${asyncOriginModule.metaUrl}, received ${asyncOriginModule.sourceOrigin}`,
);
let ropeValuePart: number | undefined = 123;
assert(isRope("a" + ropeValuePart + "b"), "bun:jsc isRope should detect a deferred string");
assert(!isRope("abcdefgh"), "bun:jsc isRope should reject a flat string");
const protectedObjects = getProtectedObjects();
assert(protectedObjects.length > 0, "bun:jsc getProtectedObjects should expose JSC roots");
assert(protectedObjects.includes(cottontail), "bun:jsc getProtectedObjects should include the protected host object");
setRandomSeed(123);
assert(getRandomSeed() === 123, "bun:jsc random seed mismatch");
assert(setTimeZone("UTC") === "UTC", "bun:jsc setTimeZone result mismatch");
assert(process.env.TZ === "UTC", "bun:jsc timezone mismatch");
assert(Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC", "bun:jsc Intl timezone mismatch");
const utcDateString = new Date(0).toString();
assert(setTimeZone("America/Anchorage") === "America/Anchorage", "bun:jsc alternate timezone result mismatch");
assert(new Date(0).toString() !== utcDateString, "bun:jsc setTimeZone should reset JSC's Date cache");
setTimeZone("UTC");
const passthrough = () => 7;
assert(noInline(passthrough)() === 7, "bun:jsc noInline mismatch");
assert(noFTL(passthrough)() === 7, "bun:jsc noFTL mismatch");
assert(optimizeNextInvocation(passthrough) === undefined && passthrough() === 7, "bun:jsc optimizeNextInvocation mismatch");
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
assert(Bun.deepMatch({ a: { b: 1 } }, { a: { b: 1, c: 2 } }), "Bun.deepMatch mismatch");
assert(Bun.escapeHTML("<>&") === "&lt;&gt;&amp;", "Bun.escapeHTML mismatch");
assert(Bun.stripANSI("\u001b[31mred\u001b[0m") === "red", "Bun.stripANSI mismatch");
assert(Bun.stringWidth("abc") === 3, "Bun.stringWidth mismatch");

function InspectBase() {}
function InspectChild() {}
Object.setPrototypeOf(InspectChild, InspectBase);
Object.defineProperties(InspectChild, {
  inherited: { value: function inherited() {}, enumerable: true },
  shadowed: { value: function shadowed() {}, enumerable: true },
  inheritedGetter: { get() { return 1; }, enumerable: true },
});
const inspectNamespace = Object.create(InspectChild);
Object.defineProperties(inspectNamespace, {
  default: { value: InspectChild, enumerable: true },
  length: { get() { return 0; }, enumerable: true },
  name: { get() { return "InspectChild"; }, enumerable: true },
  prototype: { get() { return InspectChild.prototype; }, enumerable: true },
  shadowed: { get() { return InspectChild.shadowed; }, enumerable: true },
});
assert(
  Bun.inspect(inspectNamespace) ===
    "Function {\n" +
    `  default: [${Object.getPrototypeOf(InspectChild).name}: ${InspectChild.name}],\n` +
    "  length: [Getter],\n" +
    "  name: [Getter],\n" +
    "  prototype: [Getter],\n" +
    "  shadowed: [Getter],\n" +
    "  inherited: [Function: inherited],\n" +
    "  inheritedGetter: [Getter],\n" +
    "}",
  "Bun.inspect function namespace mismatch",
);

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
assert(router.routes["/bun-sqlite"]?.endsWith("bun-sqlite.ts"), "Bun.FileSystemRouter routes mismatch");
assert(router.match("/bun-sqlite").pathname === "/bun-sqlite", "Bun.FileSystemRouter match mismatch");
const routerTmpDir = cottontail.env("COTTONTAIL_TMP_DIR");
assert(routerTmpDir, "COTTONTAIL_TMP_DIR missing");
const routerDir = `${routerTmpDir}/filesystem-router`;
cottontail.mkdirSync(`${routerDir}/posts`, true);
cottontail.writeFile(`${routerDir}/posts/[id].tsx`, "export default null;");
const dynamicRouter = new Bun.FileSystemRouter({ style: "nextjs", dir: routerDir, origin: "https://example.test", assetPrefix: "/assets" });
const dynamicRoute = dynamicRouter.match("/posts/42?view=full");
assert(dynamicRoute.name === "/posts/[id]" && dynamicRoute.params.id === "42", "Bun.FileSystemRouter dynamic route mismatch");
assert(dynamicRoute.query.view === "full" && dynamicRoute.src === "https://example.test/assets/posts/[id].tsx", "Bun.FileSystemRouter route metadata mismatch");

const transpiler = new Bun.Transpiler({ loader: "ts" });
const transformed = transpiler.transformSync("export const value: number = 1;");
assert(transformed.includes("export const value = 1"), "Bun.Transpiler transformSync mismatch");
const scan = transpiler.scan('import x from "pkg"; export const value = 1;');
assert(scan.imports[0].path === "pkg" && scan.exports.includes("value"), "Bun.Transpiler scan mismatch");
const imports = transpiler.scanImports('import "side-effect"; const lazy = import("dynamic"); const common = require("common");');
assert(imports.some((item) => item.path === "side-effect" && item.kind === "import-statement"), "Bun.Transpiler static import scan mismatch");
assert(imports.some((item) => item.path === "dynamic" && item.kind === "dynamic-import"), "Bun.Transpiler dynamic import scan mismatch");
assert(imports.some((item) => item.path === "common" && item.kind === "require-call"), "Bun.Transpiler require scan mismatch");
const configuredTranspiler = new Bun.Transpiler({
  loader: "js",
  target: "bun",
  define: { "process.env.RUNTIME": '"cottontail"' },
  minify: { syntax: true, whitespace: true },
});
const configuredOutput = configuredTranspiler.transformSync(
  new TextEncoder().encode('const runtime = process.env.RUNTIME; export { runtime };'),
);
assert(configuredOutput.includes('"cottontail"'), "Bun.Transpiler define mismatch");
assert(!configuredOutput.includes("process.env.RUNTIME"), "Bun.Transpiler define should replace source expression");
const loaderOverride = new Bun.Transpiler({ loader: "js" }).transformSync("const count: number = 2;", "ts");
assert(loaderOverride.includes("const count = 2"), "Bun.Transpiler loader override mismatch");
let malformedTransformError: unknown;
try {
  new Bun.Transpiler().transformSync("const =");
} catch (error) {
  malformedTransformError = error;
}
assert(malformedTransformError != null, "Bun.Transpiler should throw malformed-source diagnostics");
let nestedTransformError: unknown;
try {
  new Bun.Transpiler().transformSync(`${"for (;;) ".repeat(1500)};`);
} catch (error) {
  nestedTransformError = error;
}
assert(
  String((nestedTransformError as any)?.message ?? nestedTransformError).includes("Maximum call stack size exceeded"),
  "Bun.Transpiler should report parser recursion limits without crashing",
);
const replTranspiler = new Bun.Transpiler({ loader: "tsx", replMode: true });
const replContext = vm.createContext({ Promise });
await vm.runInContext(replTranspiler.transformSync("const replValue = await Promise.resolve(21)"), replContext);
const replResult = await vm.runInContext(replTranspiler.transformSync("replValue * 2"), replContext);
assert(replContext.replValue === 21 && replResult.value === 42, "Bun.Transpiler replMode persistence mismatch");

// Cottontail keeps JSC's unsafe C-API ShadowRealm constructor disabled and
// installs a sibling-context implementation through the node:vm bridge.
assert((globalThis as any).cottontail.jscVendored === true, "cottontail should run on the vendored JSC build");
const ShadowRealmConstructor = (globalThis as any).ShadowRealm;
assert(typeof ShadowRealmConstructor === "function", "ShadowRealm compatibility constructor mismatch");
const shadowRealm = new ShadowRealmConstructor();
assert(shadowRealm.evaluate("21 * 2") === 42, "ShadowRealm primitive evaluation mismatch");
const shadowRealmFunction = shadowRealm.evaluate("(value) => value + 1");
assert(shadowRealmFunction(41) === 42, "ShadowRealm callable transfer mismatch");
let shadowRealmObjectError: unknown;
try {
  shadowRealm.evaluate("({ value: 42 })");
} catch (error) {
  shadowRealmObjectError = error;
}
assert(shadowRealmObjectError instanceof TypeError, "ShadowRealm should reject object transfer");

console.log("bun jsc and global passed");
