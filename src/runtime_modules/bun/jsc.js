import {
  deserialize as v8Deserialize,
  getHeapSnapshot,
  getHeapStatistics,
  serialize as v8Serialize,
  writeHeapSnapshot,
} from "../node/v8.js";
import { inspect } from "../node/util.js";

let randomSeed = 0;
let timezone = "";
let samplingProfilerActive = false;
let samplingProfilerStartedAt = 0;

function gc() {
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
  if (typeof value === "object") return Object.keys(value).length * 16;
  return 0;
}

export function serialize(value) {
  return v8Serialize(value);
}

export function deserialize(value) {
  return v8Deserialize(value);
}

export function memoryUsage() {
  return globalThis.process?.memoryUsage?.() ?? {};
}

export function heapStats() {
  const stats = getHeapStatistics();
  stats.objectTypeCounts ??= { string: 0 };
  stats.objectTypeCounts.string ??= 0;
  stats.protectedObjectTypeCounts ??= {};
  return stats;
}

export function heapSize() {
  return heapStats().used_heap_size;
}

export function edenGC() {
  gc();
}

export function fullGC() {
  gc();
}

export function gcAndSweep() {
  gc();
}

export function drainMicrotasks() {
  cottontail.drainJobs?.();
}

export function generateHeapSnapshotForDebugging(filename = undefined) {
  return filename == null ? getHeapSnapshot() : writeHeapSnapshot(filename);
}

export function estimateShallowMemoryUsageOf(value) {
  return shallowSize(value);
}

export function describe(value) {
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

export function isRope(_value) {
  return false;
}

export function getRandomSeed() {
  return randomSeed;
}

export function setRandomSeed(value) {
  randomSeed = Number(value) || 0;
}

export function setTimeZone(value) {
  timezone = String(value ?? "");
  if (globalThis.process?.env) globalThis.process.env.TZ = timezone;
}

export function setTimezone(value) {
  return setTimeZone(value);
}

export function callerSourceOrigin() {
  return "";
}

export function codeCoverageForFile(_path = undefined) {
  return null;
}

export function getProtectedObjects() {
  return [];
}

export function noFTL(fn = undefined) {
  return fn;
}

export function noInline(fn = undefined) {
  return fn;
}

export function noOSRExitFuzzing(fn = undefined) {
  return fn;
}

export function optimizeNextInvocation(fn = undefined) {
  return fn;
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
  const total = Number(stats.total_available_size || stats.heap_size_limit || stats.total_heap_size || 0);
  return total > 0 ? Number(stats.used_heap_size || 0) / total : 0;
}

export function releaseWeakRefs() {
  gc();
}

export function startSamplingProfiler() {
  samplingProfilerActive = true;
  samplingProfilerStartedAt = Date.now();
}

export function samplingProfilerStackTraces() {
  return samplingProfilerActive ? [] : [];
}

export function profile(callback = undefined) {
  if (typeof callback !== "function") return { samples: [], stacks: [] };
  const started = Date.now();
  const result = callback();
  return {
    result,
    duration: Date.now() - started,
    samples: [],
    stacks: [],
  };
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
