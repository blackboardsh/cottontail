import {
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
} from "node:v8";
import { Buffer } from "node:buffer";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { text } from "node:stream/consumers";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const tmpDir = process.env.COTTONTAIL_TMP_DIR;
assert(tmpDir, "COTTONTAIL_TMP_DIR missing");

const payload = {
  text: "hello",
  count: 2,
  big: 10n,
  date: new Date("2024-01-01T00:00:00Z"),
  map: new Map([["a", 1]]),
  set: new Set(["x"]),
  bytes: new Uint8Array([1, 2, 3]),
};

const serialized = serialize(payload);
assert(serialized.length > 0, "serialize returned empty buffer");
const roundTrip = deserialize(serialized);
assert(roundTrip.text === "hello", "deserialize object mismatch");
assert(roundTrip.big === 10n, "deserialize bigint mismatch");
assert(roundTrip.date instanceof Date && roundTrip.date.getUTCFullYear() === 2024, "deserialize date mismatch");
assert(roundTrip.map.get("a") === 1, "deserialize map mismatch");
assert(roundTrip.set.has("x"), "deserialize set mismatch");
assert(roundTrip.bytes[2] === 3, "deserialize typed array mismatch");
assert(roundTrip.bytes instanceof Uint8Array && !Buffer.isBuffer(roundTrip.bytes), "deserialize Uint8Array type mismatch");

const nestedTypedRoundTrip = deserialize(serialize({ echo: roundTrip.bytes }));
assert(nestedTypedRoundTrip.echo instanceof Uint8Array, "reserialize Uint8Array type mismatch");
assert(nestedTypedRoundTrip.echo[2] === 3, "reserialize Uint8Array content mismatch");

const bufferRoundTrip = deserialize(serialize(Buffer.from([4, 5, 6])));
assert(Buffer.isBuffer(bufferRoundTrip), "deserialize Buffer type mismatch");
assert(bufferRoundTrip[2] === 6, "deserialize Buffer content mismatch");

const cyclicObject: Record<string, unknown> = { name: "root" };
cyclicObject.self = cyclicObject;
cyclicObject.child = { parent: cyclicObject };
const cyclicRoundTrip = deserialize(serialize(cyclicObject));
assert(cyclicRoundTrip.self === cyclicRoundTrip, "deserialize object cycle mismatch");
assert(cyclicRoundTrip.child.parent === cyclicRoundTrip, "deserialize nested object cycle mismatch");

const cyclicArray: unknown[] = [];
cyclicArray.push(cyclicArray);
const cyclicArrayRoundTrip = deserialize(serialize(cyclicArray));
assert(Array.isArray(cyclicArrayRoundTrip), "deserialize cyclic array should return array");
assert(cyclicArrayRoundTrip[0] === cyclicArrayRoundTrip, "deserialize array cycle mismatch");

const shared = { value: 42 };
const sharedRoundTrip = deserialize(serialize({ a: shared, b: shared }));
assert(sharedRoundTrip.a === sharedRoundTrip.b, "deserialize shared reference mismatch");

const cyclicMap = new Map<unknown, unknown>();
cyclicMap.set("self", cyclicMap);
const cyclicMapRoundTrip = deserialize(serialize(cyclicMap));
assert(cyclicMapRoundTrip.get("self") === cyclicMapRoundTrip, "deserialize map cycle mismatch");

const cyclicSet = new Set<unknown>();
cyclicSet.add(cyclicSet);
const cyclicSetRoundTrip = deserialize(serialize(cyclicSet));
assert(cyclicSetRoundTrip.has(cyclicSetRoundTrip), "deserialize set cycle mismatch");

const serializer = new Serializer();
serializer.writeHeader();
assert(serializer.writeValue(["serializer", 7]), "Serializer.writeValue mismatch");
const serializerBuffer = serializer.releaseBuffer();
const deserializer = new Deserializer(serializerBuffer);
assert(deserializer.readHeader(), "Deserializer.readHeader mismatch");
assert(deserializer.readValue()[1] === 7, "Deserializer.readValue mismatch");
assert(deserializer.getWireFormatVersion() >= 1, "Deserializer wire format mismatch");

const defaultSerializer = new DefaultSerializer();
defaultSerializer.writeValue({ ok: true });
const defaultDeserializer = new DefaultDeserializer(defaultSerializer.releaseBuffer());
assert(defaultDeserializer.readValue().ok === true, "DefaultSerializer/DefaultDeserializer mismatch");

assert(typeof cachedDataVersionTag() === "number", "cachedDataVersionTag mismatch");
const heapStats = getHeapStatistics();
assert(typeof heapStats.total_heap_size === "number", "getHeapStatistics mismatch");
assert(getHeapSpaceStatistics()[0].space_name === "jsc_heap", "getHeapSpaceStatistics mismatch");
assert(typeof getHeapCodeStatistics().code_and_metadata_size === "number", "getHeapCodeStatistics mismatch");
assert(typeof getCppHeapStatistics().used_size_bytes === "number", "getCppHeapStatistics mismatch");

const snapshotText = await text(getHeapSnapshot());
assert(snapshotText.includes("heapStatistics"), "getHeapSnapshot content mismatch");
const snapshotPath = `${tmpDir}/cottontail.heapsnapshot`;
rmSync(snapshotPath, { force: true });
assert(writeHeapSnapshot(snapshotPath) === snapshotPath, "writeHeapSnapshot path mismatch");
assert(existsSync(snapshotPath), "writeHeapSnapshot file missing");
assert(readFileSync(snapshotPath, "utf8").includes("heapStatistics"), "writeHeapSnapshot content mismatch");

assert(isStringOneByteRepresentation("é"), "one-byte latin1 string mismatch");
assert(!isStringOneByteRepresentation("€"), "two-byte string mismatch");

let disposed = false;
const dispose = promiseHooks.onInit(() => {});
assert(typeof dispose === "function", "promiseHooks.onInit mismatch");
dispose();
const disposeHook = promiseHooks.createHook({ init() {}, before() {}, after() {}, settled() {} });
assert(typeof disposeHook === "function", "promiseHooks.createHook mismatch");
disposeHook();
disposed = true;
assert(disposed, "promiseHooks dispose mismatch");

const profiler = new GCProfiler();
profiler.start();
assert(profiler.stop().statistics.length === 1, "GCProfiler stop mismatch");

setFlagsFromString("--trace-gc");
setHeapSnapshotNearHeapLimit(2);
assert(Array.isArray(queryObjects(Object)), "queryObjects mismatch");
assert(takeCoverage().result.length === 0, "takeCoverage mismatch");
assert(stopCoverage().result.length === 0, "stopCoverage mismatch");
assert(startupSnapshot.isBuildingSnapshot() === false, "startupSnapshot mismatch");
startupSnapshot.addSerializeCallback(() => {});
startupSnapshot.addDeserializeCallback(() => {});
startupSnapshot.setDeserializeMainFunction(() => {});

console.log("node v8 surface passed");
