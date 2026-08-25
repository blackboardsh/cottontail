import { createLazyFunction as makeLazyFunction } from "./lazy-runtime.js";
import { loadCottontailCapabilityModule } from "../node/module.js";

const state = globalThis[Symbol.for("cottontail.capabilityFacade.jscTools.bunJsc")] ??= {
  namespace: undefined,
  exports: Object.create(null),
};
const load = () => state.namespace ??= loadCottontailCapabilityModule("jsc-tools", "bun/jsc.js");
const lazy = name => state.exports[name] ??= makeLazyFunction(load, name);

export const accountForExternallyAllocatedMemory = lazy("accountForExternallyAllocatedMemory");
export const callerSourceOrigin = lazy("callerSourceOrigin");
export const codeCoverageForFile = lazy("codeCoverageForFile");
export const describe = lazy("describe");
export const describeArray = lazy("describeArray");
export const deserialize = lazy("deserialize");
export const drainMicrotasks = lazy("drainMicrotasks");
export const edenGC = lazy("edenGC");
export const estimateShallowMemoryUsageOf = lazy("estimateShallowMemoryUsageOf");
export const fullGC = lazy("fullGC");
export const gcAndSweep = lazy("gcAndSweep");
export const generateHeapSnapshotForDebugging = lazy("generateHeapSnapshotForDebugging");
export const getProtectedObjects = lazy("getProtectedObjects");
export const getRandomSeed = lazy("getRandomSeed");
export const heapSize = lazy("heapSize");
export const heapStats = lazy("heapStats");
export const isRope = lazy("isRope");
export const jscDescribe = lazy("jscDescribe");
export const jscDescribeArray = lazy("jscDescribeArray");
export const memoryUsage = lazy("memoryUsage");
export const noFTL = lazy("noFTL");
export const noInline = lazy("noInline");
export const noOSRExitFuzzing = lazy("noOSRExitFuzzing");
export const numberOfDFGCompiles = lazy("numberOfDFGCompiles");
export const optimizeNextInvocation = lazy("optimizeNextInvocation");
export const percentAvailableMemoryInUse = lazy("percentAvailableMemoryInUse");
export const profile = lazy("profile");
export const releaseWeakRefs = lazy("releaseWeakRefs");
export const reoptimizationRetryCount = lazy("reoptimizationRetryCount");
export const samplingProfilerStackTraces = lazy("samplingProfilerStackTraces");
export const serialize = lazy("serialize");
export const setRandomSeed = lazy("setRandomSeed");
export const setTimeZone = lazy("setTimeZone");
export const setTimezone = lazy("setTimezone");
export const startRemoteDebugger = lazy("startRemoteDebugger");
export const startSamplingProfiler = lazy("startSamplingProfiler");
export const totalCompileTime = lazy("totalCompileTime");

const defaultExport = state.module ??= {
  callerSourceOrigin, codeCoverageForFile, describe, describeArray, deserialize,
  drainMicrotasks, edenGC, estimateShallowMemoryUsageOf, fullGC, gcAndSweep,
  generateHeapSnapshotForDebugging, getProtectedObjects, getRandomSeed, heapSize,
  heapStats, isRope, jscDescribe, jscDescribeArray, memoryUsage, noFTL, noInline,
  noOSRExitFuzzing, numberOfDFGCompiles, optimizeNextInvocation,
  percentAvailableMemoryInUse, profile, releaseWeakRefs, reoptimizationRetryCount,
  samplingProfilerStackTraces, serialize, setRandomSeed, setTimeZone, setTimezone,
  startRemoteDebugger, startSamplingProfiler, totalCompileTime,
};
export default defaultExport;
