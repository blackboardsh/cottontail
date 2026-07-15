import { Buffer } from "./buffer.js";
import { Readable } from "./stream.js";

const formatVersion = 1;
let flags = "";
let heapSnapshotNearHeapLimit = 0;
const promiseHookSets = {
  init: new Set(),
  before: new Set(),
  after: new Set(),
  settled: new Set(),
};

function encodeBytes(bytes) {
  return Array.from(bytes);
}

function bytesFromArray(values) {
  return new Uint8Array(values);
}

const typedArrayTypes = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "DataView",
]);

function viewTypeName(value) {
  if (Buffer.isBuffer?.(value)) return "Buffer";
  const name = value?.constructor?.name;
  return typedArrayTypes.has(name) ? name : "Uint8Array";
}

function encodeValue(value, state = { ids: new WeakMap(), nextId: 1 }) {
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "null" };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { type: "number", value: "NaN" };
    if (value === Infinity) return { type: "number", value: "Infinity" };
    if (value === -Infinity) return { type: "number", value: "-Infinity" };
    if (Object.is(value, -0)) return { type: "number", value: "-0" };
    return { type: "number", value };
  }
  if (typeof value === "boolean" || typeof value === "string") return { type: typeof value, value };
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (typeof value === "symbol" || typeof value === "function") throw new Error("Unserializable value");
  const existingId = state.ids.get(value);
  if (existingId != null) return { type: "Ref", id: existingId };
  const id = state.nextId++;
  state.ids.set(value, id);

  if (value instanceof Date) return { type: "Date", id, value: value.toISOString() };
  if (value instanceof RegExp) return { type: "RegExp", id, source: value.source, flags: value.flags };
  if (value instanceof ArrayBuffer) return { type: "ArrayBuffer", id, bytes: encodeBytes(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    return {
      type: viewTypeName(value),
      id,
      bytes: encodeBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    };
  }
  if (value instanceof Map) return { type: "Map", id, value: [...value].map(([key, item]) => [encodeValue(key, state), encodeValue(item, state)]) };
  if (value instanceof Set) return { type: "Set", id, value: [...value].map((item) => encodeValue(item, state)) };
  if (Array.isArray(value)) return { type: "Array", id, value: value.map((item) => encodeValue(item, state)) };
  if (value instanceof Error) return { type: "Error", id, name: value.name, message: value.message, stack: value.stack };
  const isBunFile = typeof value?.exists === "function" && typeof value?.writer === "function";
  if (isBunFile) {
    let bytes = new Uint8Array(Math.max(0, Number(value.size) || 0));
    if (typeof value._bunFilePath === "string") {
      try { bytes = new Uint8Array(cottontail.readFileBuffer(value._bunFilePath)); } catch {}
    }
    return {
      type: "File",
      id,
      bytes: encodeBytes(bytes),
      mime: String(value.type ?? ""),
      name: String(value.name ?? ""),
      lastModified: Number(value.lastModified ?? 0),
    };
  }
  if (typeof globalThis.Blob === "function" && value instanceof globalThis.Blob) {
    const bytes = value._bytes instanceof Uint8Array ? value._bytes : new Uint8Array(0);
    if (typeof globalThis.File === "function" && value instanceof globalThis.File) {
      return {
        type: "File",
        id,
        bytes: encodeBytes(bytes),
        mime: String(value.type ?? ""),
        name: String(value.name ?? ""),
        lastModified: Number(value.lastModified ?? 0),
      };
    }
    return { type: "Blob", id, bytes: encodeBytes(bytes), mime: String(value.type ?? "") };
  }
  return { type: "Object", id, value: Object.entries(value).map(([key, item]) => [key, encodeValue(item, state)]) };
}

function remember(refs, encoded, value) {
  if (encoded?.id != null) refs.set(encoded.id, value);
  return value;
}

function decodeTypedArray(encoded, constructor) {
  return new constructor(bytesFromArray(encoded.bytes).buffer);
}

function decodeValue(encoded, refs = new Map()) {
  switch (encoded?.type) {
    case "Ref": {
      if (!refs.has(encoded.id)) throw new Error("Invalid serialized Cottontail v8 reference");
      return refs.get(encoded.id);
    }
    case "undefined": return undefined;
    case "null": return null;
    case "boolean":
    case "string": return encoded.value;
    case "number": {
      if (encoded.value === "NaN") return NaN;
      if (encoded.value === "Infinity") return Infinity;
      if (encoded.value === "-Infinity") return -Infinity;
      if (encoded.value === "-0") return -0;
      return Number(encoded.value);
    }
    case "bigint": return BigInt(encoded.value);
    case "Date": return remember(refs, encoded, new Date(encoded.value));
    case "RegExp": return remember(refs, encoded, new RegExp(encoded.source, encoded.flags));
    case "ArrayBuffer": return remember(refs, encoded, bytesFromArray(encoded.bytes).buffer);
    case "Uint8Array": return remember(refs, encoded, bytesFromArray(encoded.bytes));
    case "Buffer": return remember(refs, encoded, Buffer.from(bytesFromArray(encoded.bytes)));
    case "Int8Array": return remember(refs, encoded, decodeTypedArray(encoded, Int8Array));
    case "Uint8ClampedArray": return remember(refs, encoded, decodeTypedArray(encoded, Uint8ClampedArray));
    case "Int16Array": return remember(refs, encoded, decodeTypedArray(encoded, Int16Array));
    case "Uint16Array": return remember(refs, encoded, decodeTypedArray(encoded, Uint16Array));
    case "Int32Array": return remember(refs, encoded, decodeTypedArray(encoded, Int32Array));
    case "Uint32Array": return remember(refs, encoded, decodeTypedArray(encoded, Uint32Array));
    case "Float32Array": return remember(refs, encoded, decodeTypedArray(encoded, Float32Array));
    case "Float64Array": return remember(refs, encoded, decodeTypedArray(encoded, Float64Array));
    case "BigInt64Array": return remember(refs, encoded, decodeTypedArray(encoded, BigInt64Array));
    case "BigUint64Array": return remember(refs, encoded, decodeTypedArray(encoded, BigUint64Array));
    case "DataView": return remember(refs, encoded, new DataView(bytesFromArray(encoded.bytes).buffer));
    case "Map": {
      const map = remember(refs, encoded, new Map());
      for (const [key, value] of encoded.value) map.set(decodeValue(key, refs), decodeValue(value, refs));
      return map;
    }
    case "Set": {
      const set = remember(refs, encoded, new Set());
      for (const value of encoded.value) set.add(decodeValue(value, refs));
      return set;
    }
    case "Array": {
      const array = remember(refs, encoded, []);
      for (let index = 0; index < encoded.value.length; index += 1) array[index] = decodeValue(encoded.value[index], refs);
      return array;
    }
    case "Error": {
      const error = new Error(encoded.message);
      error.name = encoded.name;
      error.stack = encoded.stack;
      return remember(refs, encoded, error);
    }
    case "Blob":
      return remember(refs, encoded, new globalThis.Blob([bytesFromArray(encoded.bytes)], { type: encoded.mime ?? "" }));
    case "File":
      return remember(refs, encoded, new globalThis.File([bytesFromArray(encoded.bytes)], encoded.name ?? "", {
        type: encoded.mime ?? "",
        lastModified: Number(encoded.lastModified ?? 0),
      }));
    case "Object": {
      const object = remember(refs, encoded, {});
      for (const [key, value] of encoded.value) object[key] = decodeValue(value, refs);
      return object;
    }
    default: throw new Error("Invalid serialized Cottontail v8 payload");
  }
}

function payloadBuffer(value) {
  return Buffer.from(JSON.stringify({ cottontailV8: formatVersion, value: encodeValue(value) }));
}

function parsePayload(buffer) {
  const bytes = buffer instanceof Uint8Array || buffer instanceof ArrayBuffer ? Buffer.from(buffer) : Buffer.from(String(buffer));
  const payload = JSON.parse(bytes.toString());
  if (payload.cottontailV8 !== formatVersion) throw new Error("Unsupported Cottontail v8 serialization format");
  return decodeValue(payload.value);
}

export class Serializer {
  constructor() {
    this._headerWritten = false;
    this._value = undefined;
    this._raw = [];
    this._arrayBuffers = new Map();
  }

  writeHeader() {
    this._headerWritten = true;
  }

  writeValue(value) {
    this._value = value;
    return true;
  }

  releaseBuffer() {
    return payloadBuffer(this._value);
  }

  transferArrayBuffer(id, arrayBuffer) {
    this._arrayBuffers.set(Number(id), arrayBuffer);
  }

  writeUint32(value) {
    this._raw.push(Number(value) >>> 0);
  }

  writeUint64(hi, lo) {
    this._raw.push(Number(hi) >>> 0, Number(lo) >>> 0);
  }

  writeDouble(value) {
    this._raw.push(Number(value));
  }

  writeRawBytes(buffer) {
    this._raw.push(...Buffer.from(buffer));
  }

  _setTreatArrayBufferViewsAsHostObjects() {}
  _getDataCloneError(message) { return new Error(message); }
}

export class DefaultSerializer extends Serializer {
  _writeHostObject(object) {
    return this.writeValue(object);
  }
}

export class Deserializer {
  constructor(buffer) {
    this._buffer = Buffer.from(buffer ?? []);
    this._valueRead = false;
    this._arrayBuffers = new Map();
  }

  readHeader() {
    return true;
  }

  readValue() {
    if (this._valueRead) return undefined;
    this._valueRead = true;
    return parsePayload(this._buffer);
  }

  getWireFormatVersion() {
    return formatVersion;
  }

  transferArrayBuffer(id, arrayBuffer) {
    this._arrayBuffers.set(Number(id), arrayBuffer);
  }

  readUint32() { return 0; }
  readUint64() { return [0, 0]; }
  readDouble() { return 0; }
  readRawBytes(length) { return this._buffer.subarray(0, Number(length)); }
  _readRawBytes(length) { return this.readRawBytes(length); }
}

export class DefaultDeserializer extends Deserializer {
  _readHostObject() {
    return this.readValue();
  }
}

export function serialize(value) {
  return payloadBuffer(value);
}

export function deserialize(buffer) {
  return parsePayload(buffer);
}

export function cachedDataVersionTag() {
  let hash = 2166136261;
  for (const char of `cottontail-v8-${formatVersion}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function memoryUsage() {
  return globalThis.process?.memoryUsage?.() ?? {};
}

export function getHeapStatistics() {
  const usage = memoryUsage();
  const rss = Number(usage.rss ?? 0);
  const heapTotal = Number(usage.heapTotal ?? rss);
  const heapUsed = Number(usage.heapUsed ?? rss);
  const external = Number(usage.external ?? 0);
  return {
    total_heap_size: heapTotal,
    total_heap_size_executable: 0,
    total_physical_size: rss,
    total_available_size: Number(globalThis.process?.availableMemory?.() ?? 0),
    used_heap_size: heapUsed,
    heap_size_limit: Number(globalThis.process?.constrainedMemory?.() ?? heapTotal),
    malloced_memory: external,
    peak_malloced_memory: external,
    does_zap_garbage: 0,
    number_of_native_contexts: 1,
    number_of_detached_contexts: 0,
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: external,
  };
}

export function getHeapSpaceStatistics() {
  const stats = getHeapStatistics();
  return [
    {
      space_name: "jsc_heap",
      space_size: stats.total_heap_size,
      space_used_size: stats.used_heap_size,
      space_available_size: Math.max(0, stats.total_heap_size - stats.used_heap_size),
      physical_space_size: stats.total_physical_size,
    },
  ];
}

export function getHeapCodeStatistics() {
  return {
    code_and_metadata_size: 0,
    bytecode_and_metadata_size: 0,
    external_script_source_size: 0,
    cpu_profiler_metadata_size: 0,
  };
}

export function getCppHeapStatistics(detailLevel = "brief") {
  const stats = getHeapStatistics();
  return {
    committed_size_bytes: stats.total_physical_size,
    resident_size_bytes: stats.total_physical_size,
    used_size_bytes: stats.used_heap_size,
    space_statistics: [],
    type_names: [],
    detail_level: String(detailLevel),
  };
}

function heapSnapshotPayload() {
  return JSON.stringify({
    snapshot: {
      meta: { node_fields: [], node_types: [], edge_fields: [], edge_types: [], trace_function_info_fields: [], trace_node_fields: [], sample_fields: [], location_fields: [] },
      node_count: 0,
      edge_count: 0,
      trace_function_count: 0,
    },
    nodes: [],
    edges: [],
    strings: [],
    cottontail: {
      heapStatistics: getHeapStatistics(),
      flags,
      heapSnapshotNearHeapLimit,
    },
  });
}

export function getHeapSnapshot(_options = {}) {
  return Readable.from([heapSnapshotPayload()]);
}

export function writeHeapSnapshot(filename = undefined, options = {}) {
  void options;
  const path = filename ?? `${globalThis.process?.cwd?.() ?? cottontail.cwd?.() ?? "."}/Heap.${Date.now()}.heapsnapshot`;
  cottontail.writeFile(String(path), heapSnapshotPayload());
  return String(path);
}

export function isStringOneByteRepresentation(value) {
  for (const char of String(value)) {
    if (char.codePointAt(0) > 0xff) return false;
  }
  return true;
}

function registerHook(type, callback) {
  if (typeof callback !== "function") return () => {};
  promiseHookSets[type].add(callback);
  return () => promiseHookSets[type].delete(callback);
}

export const promiseHooks = {
  createHook(callbacks = {}) {
    const disposers = [
      registerHook("init", callbacks.init),
      registerHook("before", callbacks.before),
      registerHook("after", callbacks.after),
      registerHook("settled", callbacks.settled),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  },
  onInit(callback) { return registerHook("init", callback); },
  onBefore(callback) { return registerHook("before", callback); },
  onAfter(callback) { return registerHook("after", callback); },
  onSettled(callback) { return registerHook("settled", callback); },
};

export class GCProfiler {
  start() {
    this._started = Date.now();
    this._startUsage = getHeapStatistics();
  }

  stop() {
    return {
      version: 1,
      startTime: this._started ?? Date.now(),
      endTime: Date.now(),
      statistics: [
        {
          gcType: "unknown",
          beforeGC: this._startUsage ?? getHeapStatistics(),
          afterGC: getHeapStatistics(),
          cost: 0,
        },
      ],
    };
  }
}

export function setFlagsFromString(value) {
  flags = String(value ?? "");
}

export function setHeapSnapshotNearHeapLimit(limit) {
  heapSnapshotNearHeapLimit = Number(limit) || 0;
}

export function takeCoverage() {
  return { result: [] };
}

export function stopCoverage() {
  return { result: [] };
}

export function queryObjects(constructor, options = {}) {
  void options;
  if (typeof constructor !== "function") throw new TypeError("queryObjects requires a constructor");
  return [];
}

export const startupSnapshot = {
  isBuildingSnapshot() { return false; },
  addSerializeCallback() {},
  addDeserializeCallback() {},
  setDeserializeMainFunction() {},
};

// COTTONTAIL-COMPAT: node:v8 engine internals - serialization and heap snapshots use Cottontail/JSC data; V8 heap object queries, coverage, and promise hooks need engine instrumentation for full parity.

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
