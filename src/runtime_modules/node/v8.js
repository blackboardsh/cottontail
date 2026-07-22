import { Buffer } from "./buffer.js";
import { Readable } from "./stream.js";
import { createHook as createAsyncHook } from "./async_hooks.js";
import { captureV8HeapSnapshot } from "./internal/heap_snapshot.js";
import {
  DefaultDeserializer,
  DefaultSerializer,
  Deserializer,
  Serializer,
  deserialize,
  serialize,
} from "./internal/v8_serializer.js";

const maxUint32 = 0xffffffff;

export {
  DefaultDeserializer,
  DefaultSerializer,
  Deserializer,
  Serializer,
  deserialize,
  serialize,
};

function received(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return `type string ('${value}')`;
  if (typeof value !== "object") return `type ${typeof value} (${String(value)})`;
  return `an instance of ${value?.constructor?.name || "Object"}`;
}

function invalidArgType(name, expected, value) {
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received(value)}`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function invalidArgValue(name, value, detail = "is invalid") {
  const error = new TypeError(`The ${name} ${detail}. Received ${String(value)}`);
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

function outOfRange(name, value, range) {
  const error = new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`);
  error.code = "ERR_OUT_OF_RANGE";
  return error;
}

function unsupported(feature, reason) {
  const error = new Error(
    `node:v8 ${feature} is not supported by Cottontail's stock JavaScriptCore runtime${reason ? `: ${reason}` : ""}`,
  );
  error.code = "ERR_NOT_SUPPORTED";
  return error;
}

function notBuildingSnapshot() {
  const error = new Error("Operation cannot be invoked when not building startup snapshot");
  error.code = "ERR_NOT_BUILDING_SNAPSHOT";
  return error;
}

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function memoryUsage() {
  return globalThis.process?.memoryUsage?.() ?? {};
}

function jscMemoryUsage() {
  if (typeof cottontail.jscMemoryUsage !== "function") {
    throw unsupported("heap statistics", "the JSC memory statistics bridge is unavailable");
  }
  return cottontail.jscMemoryUsage();
}

export function getHeapStatistics() {
  const usage = memoryUsage();
  const stats = jscMemoryUsage();
  const used = finiteNonNegative(stats.heapSize, finiteNonNegative(usage.heapUsed));
  const capacity = Math.max(used, finiteNonNegative(stats.heapCapacity, finiteNonNegative(usage.heapTotal, used)));
  const external = finiteNonNegative(stats.extraMemorySize, finiteNonNegative(usage.external));
  const constrained = finiteNonNegative(globalThis.process?.constrainedMemory?.());
  const available = finiteNonNegative(globalThis.process?.availableMemory?.());
  const heapLimit = Math.max(capacity, constrained || used + available);

  return {
    total_heap_size: capacity,
    // Stock JSC does not expose a split between executable and data pages.
    total_heap_size_executable: 0,
    total_physical_size: used,
    total_available_size: Math.max(0, heapLimit - used),
    used_heap_size: used,
    heap_size_limit: heapLimit,
    // JSC does not expose V8's malloc accounting or its historical peak.
    malloced_memory: 0,
    peak_malloced_memory: 0,
    does_zap_garbage: 0,
    number_of_native_contexts: finiteNonNegative(stats.globalObjectCount, 1),
    number_of_detached_contexts: 0,
    // JSC exposes a protected-cell count, but not handle-table byte usage.
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: external,
  };
}

export function getHeapSpaceStatistics() {
  const stats = getHeapStatistics();
  return [{
    space_name: "jsc_heap",
    space_size: stats.total_heap_size,
    space_used_size: stats.used_heap_size,
    space_available_size: Math.max(0, stats.total_heap_size - stats.used_heap_size),
    physical_space_size: stats.total_physical_size,
  }];
}

export function getHeapCodeStatistics() {
  throw unsupported("getHeapCodeStatistics()", "JSC does not publish code-page accounting through its embedding API");
}

export function getCppHeapStatistics(detailLevel = "detailed") {
  if (detailLevel !== "brief" && detailLevel !== "detailed") {
    throw invalidArgValue("argument 'type'", detailLevel, "must be one of: 'brief', 'detailed'");
  }
  throw unsupported("getCppHeapStatistics()", "cppgc is a V8 subsystem and has no JSC equivalent");
}

function validateSnapshotOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object") throw invalidArgType("options", "object", options);
  for (const property of ["exposeInternals", "exposeNumericValues"]) {
    if (options[property] !== undefined && typeof options[property] !== "boolean") {
      throw invalidArgType(`options.${property}`, "boolean", options[property]);
    }
  }
  if (options.exposeNumericValues === true) {
    throw unsupported(
      "heap snapshot numeric values",
      "JSC's heap snapshot API does not expose primitive payloads",
    );
  }
  return options;
}

export function getHeapSnapshot(options = undefined) {
  validateSnapshotOptions(options);
  return Readable.from([Buffer.from(captureV8HeapSnapshot())]);
}

function defaultHeapSnapshotPath() {
  const date = new Date();
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `Heap-${yyyy}${mm}${dd}-${hh}${minutes}${ss}-${globalThis.process?.pid ?? 0}-0.heapsnapshot`;
}

export function writeHeapSnapshot(filename = undefined, options = undefined) {
  if (filename !== undefined) {
    if (typeof filename !== "string") throw invalidArgType("path", "string", filename);
    if (filename.length === 0) throw invalidArgValue("argument 'path'", filename, "must be a non-empty string");
  }
  validateSnapshotOptions(options);
  const path = filename ?? defaultHeapSnapshotPath();
  cottontail.writeFile(path, captureV8HeapSnapshot());
  return path;
}

export function isStringOneByteRepresentation(value) {
  if (typeof value !== "string") throw invalidArgType("content", "string", value);
  if (typeof cottontail.jscStringIs8Bit !== "function") {
    throw unsupported("isStringOneByteRepresentation()", "the JSC string representation bridge is unavailable");
  }
  return cottontail.jscStringIs8Bit(value);
}

export function cachedDataVersionTag() {
  throw unsupported("cachedDataVersionTag()", "stock JSC has no cached-bytecode embedding API");
}

function exposeGc() {
  if (typeof globalThis.gc === "function") return;
  if (typeof cottontail.gc !== "function") {
    throw unsupported("--expose-gc", "the JSC garbage collector bridge is unavailable");
  }
  Object.defineProperty(globalThis, "gc", {
    configurable: true,
    value: (options = undefined) => {
      const result = cottontail.gc(true);
      globalThis.__cottontailAsyncHooksOnGc?.();
      if (options && typeof options === "object" && options.execution === "async") return Promise.resolve(result);
      return result;
    },
    writable: true,
  });
}

export function setFlagsFromString(value) {
  if (typeof value !== "string") throw invalidArgType("flags", "string", value);
  const flags = value.trim() === "" ? [] : value.trim().split(/\s+/);
  const unsupportedFlags = flags.filter((flag) => flag !== "--expose-gc" && flag !== "--expose_gc");
  if (unsupportedFlags.length > 0) {
    throw unsupported(
      `setFlagsFromString(${JSON.stringify(value)})`,
      `V8 flags do not configure JSC; unsupported flag${unsupportedFlags.length === 1 ? "" : "s"}: ${unsupportedFlags.join(", ")}`,
    );
  }
  if (flags.length > 0) exposeGc();
}

export function setHeapSnapshotNearHeapLimit(limit) {
  if (typeof limit !== "number") throw invalidArgType("limit", "number", limit);
  if (!Number.isInteger(limit)) throw outOfRange("limit", limit, "an integer");
  if (limit < 1 || limit > maxUint32) throw outOfRange("limit", limit, ">= 1 && <= 4294967295");
  throw unsupported(
    "setHeapSnapshotNearHeapLimit()",
    "stock JSC does not expose a near-heap-limit callback",
  );
}

function validatePromiseHook(name, callback) {
  if (typeof callback !== "function") throw invalidArgType(name, "function", callback);
}

function installPromiseHooks(callbacks) {
  const promises = new Map();
  const finalizer = typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry((asyncId) => promises.delete(asyncId))
    : null;
  const dereference = (asyncId) => {
    const reference = promises.get(asyncId);
    const promise = reference?.deref();
    if (reference !== undefined && promise === undefined) promises.delete(asyncId);
    return promise;
  };
  const hook = createAsyncHook({
    init(asyncId, type, triggerAsyncId, resource) {
      if (type !== "PROMISE") return;
      promises.set(asyncId, new WeakRef(resource));
      finalizer?.register(resource, asyncId);
      callbacks.init?.(resource, dereference(triggerAsyncId));
    },
    before(asyncId) {
      const promise = dereference(asyncId);
      if (promise !== undefined) callbacks.before?.(promise);
    },
    after(asyncId) {
      const promise = dereference(asyncId);
      if (promise !== undefined) callbacks.after?.(promise);
    },
    promiseResolve(asyncId) {
      const promise = dereference(asyncId);
      if (promise !== undefined) callbacks.settled?.(promise);
    },
    destroy(asyncId) {
      promises.delete(asyncId);
    },
  }).enable();
  let enabled = true;
  return () => {
    if (!enabled) return;
    enabled = false;
    hook.disable();
    promises.clear();
  };
}

export const promiseHooks = {
  createHook(callbacks = {}) {
    if (callbacks === null) throw new TypeError("Cannot create promise hooks from null");
    const values = Object(callbacks);
    for (const [property, argument] of [
      ["init", "initHook"],
      ["before", "beforeHook"],
      ["after", "afterHook"],
      ["settled", "settledHook"],
    ]) {
      if (values[property] !== undefined) validatePromiseHook(argument, values[property]);
    }
    return installPromiseHooks(values);
  },
  onInit(callback) {
    validatePromiseHook("initHook", callback);
    return installPromiseHooks({ init: callback });
  },
  onBefore(callback) {
    validatePromiseHook("beforeHook", callback);
    return installPromiseHooks({ before: callback });
  },
  onAfter(callback) {
    validatePromiseHook("afterHook", callback);
    return installPromiseHooks({ after: callback });
  },
  onSettled(callback) {
    validatePromiseHook("settledHook", callback);
    return installPromiseHooks({ settled: callback });
  },
};

export class GCProfiler {
  start() {
    throw unsupported("GCProfiler.start()", "stock JSC exposes no garbage-collection event observer");
  }

  stop() {
    return undefined;
  }
}

export function takeCoverage() {
  throw unsupported("takeCoverage()", "JSC control-flow coverage is not available through the stock embedding API");
}

export function stopCoverage() {
  throw unsupported("stopCoverage()", "JSC control-flow coverage is not available through the stock embedding API");
}

export function queryObjects(constructor, options = undefined) {
  if (typeof constructor !== "function") throw invalidArgType("constructor", "function", constructor);
  if (options === undefined) options = {};
  if (options === null || typeof options !== "object") throw invalidArgType("options", "object", options);
  const format = options.format;
  if (format !== undefined && format !== "count" && format !== "summary") {
    throw invalidArgValue("property 'options.format'", format);
  }
  throw unsupported(
    "queryObjects()",
    "stock JSC can snapshot heap identities but cannot return live cells through its embedding API",
  );
}

export const startupSnapshot = {
  isBuildingSnapshot() {
    return false;
  },
  addSerializeCallback() {
    throw notBuildingSnapshot();
  },
  addDeserializeCallback() {
    throw notBuildingSnapshot();
  },
  setDeserializeMainFunction() {
    throw notBuildingSnapshot();
  },
};

// COTTONTAIL-COMPAT: This module exposes Cottontail's versioned clone format
// and stock-JSC measurements. APIs that require V8 heap cells, V8 cached data,
// or patched engine instrumentation fail with ERR_NOT_SUPPORTED.

export default {
  DefaultDeserializer,
  DefaultSerializer,
  Deserializer,
  GCProfiler,
  Serializer,
  cachedDataVersionTag,
  deserialize,
  getCppHeapStatistics,
  getHeapCodeStatistics,
  getHeapSnapshot,
  getHeapSpaceStatistics,
  getHeapStatistics,
  isStringOneByteRepresentation,
  promiseHooks,
  queryObjects,
  serialize,
  setFlagsFromString,
  setHeapSnapshotNearHeapLimit,
  startupSnapshot,
  stopCoverage,
  takeCoverage,
  writeHeapSnapshot,
};
