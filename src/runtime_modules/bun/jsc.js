import {
  deserialize as v8Deserialize,
  getHeapStatistics,
  serialize as v8Serialize,
} from "../node/v8.js";
import { inspect } from "../node/util.js";

let randomSeed = 0;
let timezone = "";
let samplingProfilerActive = false;
let samplingProfilerStartedAt = 0;
const nativeHeapStats = cottontail.jscMemoryUsage;
const estimatedMemoryCostSymbol = Symbol.for("cottontail.estimatedMemoryCost");
const estimatedValues = new Set();
const estimatedValueSet = new WeakSet();
const stackFunctionRegistrySymbol = Symbol.for("cottontail.stackFunctionRegistry");

function normalizeHeapStats(stats) {
  stats.objectTypeCounts ??= {};
  stats.protectedObjectTypeCounts ??= {};
  const providers = globalThis.__cottontailHeapObjectCountProviders;
  if (providers instanceof Map) {
    for (const [type, count] of providers) {
      try {
        stats.objectTypeCounts[type] = Math.max(
          Number(stats.objectTypeCounts[type]) || 0,
          Math.max(0, Number(count()) || 0),
        );
      } catch {}
    }
  }
  return stats;
}

// JSC interns its statistics property names on the first call. Warm the API so
// heapStats() does not report allocations caused by initializing itself.
if (nativeHeapStats) normalizeHeapStats(nativeHeapStats());

function runInternalGc() {
  globalThis.gc?.();
  cottontail.drainJobs?.();
}

function shallowSize(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value === "boolean") return 4;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (Array.isArray(value)) return value.length * 8;
  if (typeof value === "object") {
    // Objects that own out-of-line storage (e.g. Performance's entry buffer)
    // report it through this hook, mirroring JSC's Structure::estimatedSize.
    const reported = value[estimatedMemoryCostSymbol];
    if (typeof reported === "number") return reported + Object.keys(value).length * 16;
    return Object.keys(value).length * 16;
  }
  return 0;
}

function trackEstimatedValue(value) {
  if (value == null || (typeof value !== "object" && typeof value !== "function") ||
      estimatedValueSet.has(value) || typeof WeakRef !== "function") return;
  estimatedValueSet.add(value);
  estimatedValues.add(new WeakRef(value));
}

function externalMemoryCost(value) {
  if (value == null || (typeof value !== "object" && typeof value !== "function")) return 0;
  try {
    const cost = Number(value[estimatedMemoryCostSymbol]);
    return Number.isFinite(cost) && cost > 0 ? cost : 0;
  } catch {
    return 0;
  }
}

function heapSnapshotClassName(value) {
  try {
    const name = value?.constructor?.name;
    if (typeof name === "string" && name) return name;
    return Object.prototype.toString.call(value).slice(8, -1);
  } catch {
    return "";
  }
}

// JSC's C API heap snapshot does not know about storage owned by host-backed
// JavaScript wrappers. Fold those wrappers' reported external bytes into the
// matching cells, as native Bun does through its cell estimatedSize hooks.
export function accountForExternallyAllocatedMemory(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.nodeClassNames)) return snapshot;

  const costs = new Map();
  const seen = new Set();
  const collect = (value) => {
    if (value == null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return;
    seen.add(value);
    const cost = externalMemoryCost(value);
    const name = cost > 0 ? heapSnapshotClassName(value) : "";
    if (name) costs.set(name, (costs.get(name) ?? 0) + cost);
  };

  for (const reference of Array.from(estimatedValues)) {
    const value = reference.deref();
    if (value === undefined) estimatedValues.delete(reference);
    else collect(value);
  }
  for (const key of Reflect.ownKeys(globalThis)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    if (descriptor && "value" in descriptor) collect(descriptor.value);
  }

  if (costs.size === 0) return snapshot;
  const stride = snapshot.type === "GCDebugging" ? 7 : 4;
  const canonicalClassIndexes = new Map();
  for (const className of costs.keys()) {
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const aliasPattern = new RegExp(`^${escaped}\\d+$`);
    const aliases = [];
    for (let index = 0; index < snapshot.nodeClassNames.length; index += 1) {
      const candidate = snapshot.nodeClassNames[index];
      if (candidate === className || aliasPattern.test(candidate)) aliases.push(index);
    }
    if (aliases.length === 0) continue;
    const canonical = aliases.find(index => snapshot.nodeClassNames[index] === className) ?? aliases[0];
    const aliasSet = new Set(aliases);
    snapshot.nodeClassNames[canonical] = className;
    for (let offset = 0; offset + 2 < snapshot.nodes.length; offset += stride) {
      if (aliasSet.has(snapshot.nodes[offset + 2])) snapshot.nodes[offset + 2] = canonical;
    }
    canonicalClassIndexes.set(className, canonical);
  }
  const firstNodeByClass = new Map();
  for (let offset = 0; offset + 2 < snapshot.nodes.length; offset += stride) {
    const className = snapshot.nodeClassNames[snapshot.nodes[offset + 2]];
    if (!firstNodeByClass.has(className)) firstNodeByClass.set(className, offset);
  }
  for (const [className, cost] of costs) {
    const canonical = canonicalClassIndexes.get(className);
    const offset = canonical === undefined ? firstNodeByClass.get(className) :
      firstNodeByClass.get(snapshot.nodeClassNames[canonical]);
    if (offset !== undefined) snapshot.nodes[offset + 1] += cost;
  }
  return snapshot;
}

export function serialize(value, options = undefined) {
  const bytes = v8Serialize(value, { forStorage: true });
  const shared = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(shared).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return options?.binaryType === "nodebuffer" ? Buffer.from(shared) : shared;
}

export function deserialize(value) {
  // bun:jsc returns its storage payload in a SharedArrayBuffer. node:v8 keeps
  // Node's stricter TypedArray/DataView input contract, so use the internal
  // ArrayBuffer path only for this Bun-facing API.
  return v8Deserialize(value, { allowArrayBuffer: true });
}

export function memoryUsage() {
  const usage = globalThis.process?.memoryUsage?.() ?? {};
  const current = Number(usage.rss ?? 0);
  const maxRss = Number(globalThis.process?.resourceUsage?.().maxRSS ?? 0);
  return {
    current,
    peak: Math.max(current, maxRss * 1024),
    currentCommit: Number(usage.heapTotal ?? current),
    peakCommit: Math.max(Number(usage.heapTotal ?? current), maxRss * 1024),
    pageFaults: 0,
  };
}

export function heapStats() {
  return normalizeHeapStats(nativeHeapStats?.() ?? getHeapStatistics());
}

export function heapSize() {
  const stats = heapStats();
  return Number(stats.heapSize ?? stats.used_heap_size ?? 0);
}

export function edenGC() {
  runInternalGc();
  return heapSize();
}

export function fullGC() {
  runInternalGc();
  return heapSize();
}

export function gcAndSweep() {
  runInternalGc();
  return heapSize();
}

export function drainMicrotasks() {
  cottontail.drainJobs?.();
}

export function generateHeapSnapshotForDebugging() {
  if (typeof cottontail.jscHeapSnapshotForDebugging !== "function") {
    throw new Error("JavaScriptCore debugging heap snapshots are unavailable in this build");
  }
  return accountForExternallyAllocatedMemory(JSON.parse(cottontail.jscHeapSnapshotForDebugging()));
}

export function estimateShallowMemoryUsageOf(value) {
  trackEstimatedValue(value);
  return shallowSize(value);
}

export function describe(value) {
  if (typeof value === "number" && typeof cottontail.jscDescribeNumber === "function") {
    return cottontail.jscDescribeNumber(value);
  }
  if (typeof value === "string" && typeof cottontail.jscStringIs8Bit === "function") {
    const is8Bit = cottontail.jscStringIs8Bit(value);
    return `String,8Bit:(${is8Bit ? 1 : 0}),length:(${value.length}): ${value}`;
  }
  return inspect(value);
}

export function jscDescribe(value) {
  return describe(value);
}

export function describeArray(value) {
  return Array.from(value ?? []).map((item) => describe(item));
}

export function jscDescribeArray(value) {
  return describeArray(value);
}

export function isRope(value) {
  return typeof value === "string" && Boolean(cottontail.jscValueIsRope(value));
}

export function getRandomSeed() {
  return randomSeed;
}

export function setRandomSeed(value) {
  randomSeed = Number(value) || 0;
}

export function setTimeZone(value) {
  if (typeof value !== "string") throw new TypeError("setTimeZone requires a timezone string");
  timezone = cottontail.jscSetTimeZone(value);
  if (globalThis.process?.env) globalThis.process.env.TZ = timezone;
  return timezone;
}

export function setTimezone(value) {
  return setTimeZone(value);
}

export function callerSourceOrigin() {
  const stack = String(new Error().stack ?? "");
  for (const line of stack.split("\n").slice(1)) {
    const match = line.match(/(?:\(|@|\s)((?:file:\/\/)?\/.*\.[cm]?[jt]sx?):\d+:\d+\)?$/);
    if (
      !match ||
      match[1].includes("runtime_modules/bun/jsc") ||
      match[1].includes(".cottontail-embedded-runtime/bun/jsc.js")
    ) {
      continue;
    }
    const sourcePath = match[1];
    return sourcePath.startsWith("file://") ? sourcePath : `file://${sourcePath}`;
  }
  return "";
}

export function codeCoverageForFile(_path = undefined) {
  return null;
}

export function getProtectedObjects() {
  return cottontail.jscProtectedObjects();
}

export function noFTL(fn = undefined) {
  return fn;
}

export function noInline(fn = undefined) {
  if (typeof fn === "function") {
    const name = typeof fn.displayName === "string" && fn.displayName ? fn.displayName : fn.name;
    if (name) {
      const registry = globalThis[stackFunctionRegistrySymbol] ??= new Map();
      registry.set(name, typeof WeakRef === "function" ? new WeakRef(fn) : fn);
    }
  }
  return fn;
}

export function noOSRExitFuzzing(fn = undefined) {
  return fn;
}

export function optimizeNextInvocation(fn = undefined) {
  void fn;
  return undefined;
}

export function numberOfDFGCompiles() {
  return 0;
}

export function reoptimizationRetryCount() {
  return 0;
}

export function totalCompileTime() {
  return 0;
}

export function percentAvailableMemoryInUse() {
  const stats = heapStats();
  const total = Number(stats.heapCapacity || stats.total_available_size || stats.heap_size_limit || stats.total_heap_size || 0);
  return total > 0 ? Number(stats.heapSize || stats.used_heap_size || 0) / total : 0;
}

export function releaseWeakRefs() {
  runInternalGc();
}

export function startSamplingProfiler() {
  samplingProfilerActive = true;
  samplingProfilerStartedAt = Date.now();
}

export function samplingProfilerStackTraces() {
  return samplingProfilerActive ? [] : [];
}

export function profile(callback = undefined, _sampleInterval = undefined, ...args) {
  if (typeof callback !== "function") return { functions: [], stackTraces: { traces: [] } };
  const started = Date.now();
  const finish = (result) => ({
    result,
    duration: Date.now() - started,
    functions: [{ name: callback.name || "<anonymous>" }],
    stackTraces: { traces: [String(new Error().stack ?? "")] },
  });
  const result = callback(...args);
  return result && typeof result.then === "function" ? Promise.resolve(result).then(finish) : finish(result);
}

export function startRemoteDebugger(_host = "127.0.0.1", _port = 0) {
  return false;
}

const defaultExport = {
  callerSourceOrigin,
  codeCoverageForFile,
  describe,
  describeArray,
  deserialize,
  drainMicrotasks,
  edenGC,
  estimateShallowMemoryUsageOf,
  fullGC,
  gcAndSweep,
  generateHeapSnapshotForDebugging,
  getProtectedObjects,
  getRandomSeed,
  heapSize,
  heapStats,
  isRope,
  jscDescribe,
  jscDescribeArray,
  memoryUsage,
  noFTL,
  noInline,
  noOSRExitFuzzing,
  numberOfDFGCompiles,
  optimizeNextInvocation,
  percentAvailableMemoryInUse,
  profile,
  releaseWeakRefs,
  reoptimizationRetryCount,
  samplingProfilerStackTraces,
  serialize,
  setRandomSeed,
  setTimeZone,
  setTimezone,
  startRemoteDebugger,
  startSamplingProfiler,
  totalCompileTime,
};

export default defaultExport;
