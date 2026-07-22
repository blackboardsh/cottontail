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

function expectThrows(callback: () => unknown, code: string | undefined, label: string) {
  try {
    callback();
  } catch (error) {
    const actual = (error as { code?: string }).code;
    if (code !== undefined) assert(actual === code, `${label} error code mismatch: ${actual}`);
    return error;
  }
  throw new Error(`${label} did not throw`);
}

const tmpDir = process.env.COTTONTAIL_TMP_DIR;
assert(tmpDir, "COTTONTAIL_TMP_DIR missing");

const backing = new ArrayBuffer(16);
const bytes = new Uint8Array(backing, 2, 4);
const words = new Uint16Array(backing, 4, 2);
bytes.set([1, 2, 3, 4]);
const invalidDate = new Date(NaN);
const payload = {
  text: "hello\ud800",
  count: 2,
  negativeZero: -0,
  big: 10n,
  invalidDate,
  map: new Map([["a", 1]]),
  set: new Set(["x"]),
  backing,
  bytes,
  words,
};

const serialized = serialize(payload);
assert(Buffer.isBuffer(serialized), "serialize should return Buffer");
assert(serialized.toString("ascii", 0, 4) === "CTV8", "serialize should use Cottontail wire header");
const roundTrip = deserialize(serialized);
assert(roundTrip.text === payload.text, "deserialize UTF-16 string mismatch");
assert(Object.is(roundTrip.negativeZero, -0), "deserialize negative zero mismatch");
assert(roundTrip.big === 10n, "deserialize bigint mismatch");
assert(roundTrip.invalidDate instanceof Date && Number.isNaN(roundTrip.invalidDate.getTime()), "invalid Date mismatch");
assert(roundTrip.map.get("a") === 1, "deserialize map mismatch");
assert(roundTrip.set.has("x"), "deserialize set mismatch");
assert(roundTrip.bytes instanceof Uint8Array && !Buffer.isBuffer(roundTrip.bytes), "Uint8Array type mismatch");
assert(roundTrip.words instanceof Uint16Array, "Uint16Array type mismatch");
assert(roundTrip.bytes.buffer === roundTrip.backing, "typed array backing identity mismatch");
assert(roundTrip.words.buffer === roundTrip.backing, "shared typed array backing mismatch");
assert(roundTrip.bytes.byteOffset === 2 && roundTrip.bytes.byteLength === 4, "typed array bounds mismatch");

const bufferRoundTrip = deserialize(serialize(Buffer.from([4, 5, 6])));
assert(Buffer.isBuffer(bufferRoundTrip), "deserialize Buffer type mismatch");
assert(bufferRoundTrip[2] === 6, "deserialize Buffer content mismatch");

const sparse: unknown[] & { label?: string } = [];
sparse.length = 4;
sparse[3] = "last";
sparse.label = "sparse";
const sparseRoundTrip = deserialize(serialize(sparse));
assert(!(0 in sparseRoundTrip) && sparseRoundTrip.length === 4, "sparse array holes mismatch");
assert(sparseRoundTrip[3] === "last" && sparseRoundTrip.label === "sparse", "sparse array properties mismatch");

const cyclicObject: Record<string, unknown> = { name: "root" };
cyclicObject.self = cyclicObject;
cyclicObject.child = { parent: cyclicObject };
const cyclicRoundTrip = deserialize(serialize(cyclicObject));
assert(cyclicRoundTrip.self === cyclicRoundTrip, "deserialize object cycle mismatch");
assert(cyclicRoundTrip.child.parent === cyclicRoundTrip, "deserialize nested object cycle mismatch");

const cyclicMap = new Map<unknown, unknown>();
cyclicMap.set("self", cyclicMap);
const cyclicMapRoundTrip = deserialize(serialize(cyclicMap));
assert(cyclicMapRoundTrip.get("self") === cyclicMapRoundTrip, "deserialize map cycle mismatch");

const sourceError = new TypeError("boom") as TypeError & { cause?: unknown };
sourceError.cause = sourceError;
const errorRoundTrip = deserialize(serialize(sourceError));
assert(errorRoundTrip instanceof TypeError && errorRoundTrip.message === "boom", "Error type mismatch");
assert(errorRoundTrip.cause === errorRoundTrip, "Error cause cycle mismatch");

const boxedRoundTrip = deserialize(serialize([new Number(-0), new String("x"), new Boolean(false), Object(12n)]));
assert(Object.is(boxedRoundTrip[0].valueOf(), -0), "boxed Number mismatch");
assert(boxedRoundTrip[1].valueOf() === "x", "boxed String mismatch");
assert(boxedRoundTrip[2].valueOf() === false, "boxed Boolean mismatch");
assert(boxedRoundTrip[3].valueOf() === 12n, "boxed BigInt mismatch");

expectThrows(() => serialize(() => {}), undefined, "serialize function");
expectThrows(() => serialize(Symbol("x")), undefined, "serialize symbol");
if (typeof SharedArrayBuffer === "function") {
  expectThrows(() => serialize(new SharedArrayBuffer(1)), undefined, "serialize SharedArrayBuffer");
  expectThrows(
    () => serialize(new Uint8Array(new SharedArrayBuffer(1))),
    undefined,
    "serialize SharedArrayBuffer view",
  );
}
expectThrows(() => deserialize(new ArrayBuffer(4) as never), "ERR_INVALID_ARG_TYPE", "deserialize ArrayBuffer");
expectThrows(() => deserialize(Buffer.from("not-a-clone")), undefined, "deserialize malformed input");

const serializer = new Serializer();
serializer.writeHeader();
serializer.writeUint32(300);
serializer.writeUint64(0x12345678, 0x9abcdef0);
serializer.writeDouble(-0.25);
serializer.writeRawBytes(Buffer.from([7, 8, 9]));
const shared = { value: 42 };
assert(serializer.writeValue(shared), "Serializer.writeValue first mismatch");
assert(serializer.writeValue(shared), "Serializer.writeValue second mismatch");
const serializerBuffer = serializer.releaseBuffer();
assert(serializer.releaseBuffer().byteLength === 0, "Serializer.releaseBuffer should drain the writer");

const deserializer = new Deserializer(serializerBuffer);
assert(deserializer.getWireFormatVersion() === 0, "wire format should be unknown before header");
assert(deserializer.readHeader(), "Deserializer.readHeader mismatch");
assert(deserializer.getWireFormatVersion() === 1, "Deserializer wire format mismatch");
assert(deserializer.readUint32() === 300, "Serializer uint32 mismatch");
const uint64 = deserializer.readUint64();
assert(uint64[0] === 0x12345678 && uint64[1] === 0x9abcdef0, "Serializer uint64 mismatch");
assert(deserializer.readDouble() === -0.25, "Serializer double mismatch");
assert(deserializer.readRawBytes(3).equals(Buffer.from([7, 8, 9])), "Serializer raw bytes mismatch");
const firstShared = deserializer.readValue();
assert(deserializer.readValue() === firstShared, "Serializer cross-value reference mismatch");
expectThrows(() => deserializer.readValue(), undefined, "Deserializer end of input");

const transferredSource = new ArrayBuffer(4);
const transferredTarget = new ArrayBuffer(4);
const transferSerializer = new Serializer();
transferSerializer.writeHeader();
transferSerializer.transferArrayBuffer(7, transferredSource);
transferSerializer.writeValue(transferredSource);
const transferDeserializer = new Deserializer(transferSerializer.releaseBuffer());
transferDeserializer.transferArrayBuffer(7, transferredTarget);
transferDeserializer.readHeader();
assert(transferDeserializer.readValue() === transferredTarget, "transferArrayBuffer identity mismatch");
expectThrows(() => new Serializer().transferArrayBuffer(1, {} as never), "ERR_INVALID_ARG_TYPE", "transfer validation");

class HostValue {
  constructor(readonly value: number) {}
}
class HostSerializer extends Serializer {
  _writeHostObject(value: HostValue) {
    if (!(value instanceof HostValue)) return false;
    this.writeUint32(value.value);
    return true;
  }
}
class HostDeserializer extends Deserializer {
  _readHostObject() {
    return new HostValue(this.readUint32());
  }
}
const hostSerializer = new HostSerializer();
hostSerializer.writeHeader();
hostSerializer.writeValue(new HostValue(99));
hostSerializer.writeValue({ plain: true });
const hostDeserializer = new HostDeserializer(hostSerializer.releaseBuffer());
hostDeserializer.readHeader();
const hostValue = hostDeserializer.readValue();
assert(hostValue instanceof HostValue && hostValue.value === 99, "custom host object mismatch");
assert(hostDeserializer.readValue().plain === true, "custom serializer plain object mismatch");

const defaultSerializer = new DefaultSerializer();
defaultSerializer.writeHeader();
defaultSerializer.writeValue({ ok: true });
const defaultDeserializer = new DefaultDeserializer(defaultSerializer.releaseBuffer());
defaultDeserializer.readHeader();
assert(defaultDeserializer.readValue().ok === true, "DefaultSerializer/DefaultDeserializer mismatch");

expectThrows(() => cachedDataVersionTag(), "ERR_NOT_SUPPORTED", "cachedDataVersionTag");
const heapStats = getHeapStatistics();
assert(typeof heapStats.total_heap_size === "number" && heapStats.total_heap_size >= heapStats.used_heap_size,
  "getHeapStatistics mismatch");
assert(heapStats.total_heap_size_executable === 0, "JSC executable heap accounting should be explicit");
const heapSpaces = getHeapSpaceStatistics();
assert(heapSpaces.length === 1 && heapSpaces[0].space_name === "jsc_heap", "getHeapSpaceStatistics mismatch");
assert(heapSpaces[0].space_used_size >= 0 && heapSpaces[0].space_used_size <= heapSpaces[0].space_size,
  "heap space usage mismatch");
expectThrows(() => getHeapCodeStatistics(), "ERR_NOT_SUPPORTED", "getHeapCodeStatistics");
expectThrows(() => getCppHeapStatistics("brief"), "ERR_NOT_SUPPORTED", "getCppHeapStatistics");
expectThrows(() => getCppHeapStatistics("invalid" as never), "ERR_INVALID_ARG_VALUE", "getCppHeapStatistics validation");

function assertHeapSnapshotContents(source: string, label: string) {
  const snapshot = JSON.parse(source);
  assert(snapshot.snapshot?.meta && Array.isArray(snapshot.nodes), `${label} metadata mismatch`);
  assert(Array.isArray(snapshot.edges) && Array.isArray(snapshot.strings), `${label} graph mismatch`);
}

const snapshotText = await text(getHeapSnapshot({ exposeInternals: true }));
assertHeapSnapshotContents(snapshotText, "getHeapSnapshot");
expectThrows(
  () => getHeapSnapshot({ exposeNumericValues: true }),
  "ERR_NOT_SUPPORTED",
  "getHeapSnapshot numeric values",
);
const snapshotPath = `${tmpDir}/cottontail.heapsnapshot`;
rmSync(snapshotPath, { force: true });
assert(writeHeapSnapshot(snapshotPath) === snapshotPath, "writeHeapSnapshot path mismatch");
assert(existsSync(snapshotPath), "writeHeapSnapshot file missing");
assertHeapSnapshotContents(readFileSync(snapshotPath, "utf8"), "writeHeapSnapshot");
expectThrows(() => writeHeapSnapshot(""), "ERR_INVALID_ARG_VALUE", "writeHeapSnapshot empty path");

assert(isStringOneByteRepresentation("e"), "one-byte ASCII string mismatch");
assert(isStringOneByteRepresentation("\u00e9"), "one-byte latin1 string mismatch");
assert(!isStringOneByteRepresentation("\u20ac"), "two-byte string mismatch");
expectThrows(() => isStringOneByteRepresentation(1 as never), "ERR_INVALID_ARG_TYPE", "one-byte validation");

const promiseEvents = { init: 0, before: 0, after: 0, settled: 0, parent: false };
let parentPromise: Promise<number> | undefined;
const disposePromiseHook = promiseHooks.createHook({
  init(promise, parent) {
    assert(promise instanceof Promise, "promiseHooks init resource mismatch");
    if (parent === parentPromise) promiseEvents.parent = true;
    promiseEvents.init += 1;
  },
  before() { promiseEvents.before += 1; },
  after() { promiseEvents.after += 1; },
  settled() { promiseEvents.settled += 1; },
});
parentPromise = Promise.resolve(1);
await parentPromise.then((value) => value + 1);
disposePromiseHook();
assert(promiseEvents.init >= 2, "promiseHooks init was not observed");
assert(promiseEvents.before >= 1 && promiseEvents.after >= 1, "promiseHooks callback lifecycle mismatch");
assert(promiseEvents.settled >= 1, "promiseHooks settled was not observed");
assert(promiseEvents.parent, "promiseHooks init parent was not observed");
expectThrows(() => promiseHooks.onInit(undefined as never), "ERR_INVALID_ARG_TYPE", "promiseHooks validation");

const profiler = new GCProfiler();
expectThrows(() => profiler.start(), "ERR_NOT_SUPPORTED", "GCProfiler.start");
assert(profiler.stop() === undefined, "GCProfiler.stop without start mismatch");

setFlagsFromString("--expose-gc");
assert(typeof (globalThis as { gc?: unknown }).gc === "function", "setFlagsFromString --expose-gc mismatch");
expectThrows(() => setFlagsFromString("--trace-gc"), "ERR_NOT_SUPPORTED", "setFlagsFromString unsupported flag");
expectThrows(() => setFlagsFromString(1 as never), "ERR_INVALID_ARG_TYPE", "setFlagsFromString validation");
expectThrows(() => setHeapSnapshotNearHeapLimit(2), "ERR_NOT_SUPPORTED", "setHeapSnapshotNearHeapLimit");
expectThrows(() => setHeapSnapshotNearHeapLimit(0), "ERR_OUT_OF_RANGE", "setHeapSnapshotNearHeapLimit validation");
expectThrows(() => queryObjects(Object), "ERR_NOT_SUPPORTED", "queryObjects");
expectThrows(() => queryObjects(null as never), "ERR_INVALID_ARG_TYPE", "queryObjects validation");
expectThrows(() => takeCoverage(), "ERR_NOT_SUPPORTED", "takeCoverage");
expectThrows(() => stopCoverage(), "ERR_NOT_SUPPORTED", "stopCoverage");
assert(startupSnapshot.isBuildingSnapshot() === false, "startupSnapshot mismatch");
expectThrows(() => startupSnapshot.addSerializeCallback(() => {}), "ERR_NOT_BUILDING_SNAPSHOT", "startup serialize");
expectThrows(() => startupSnapshot.addDeserializeCallback(() => {}), "ERR_NOT_BUILDING_SNAPSHOT", "startup deserialize");
expectThrows(() => startupSnapshot.setDeserializeMainFunction(() => {}), "ERR_NOT_BUILDING_SNAPSHOT", "startup main");

console.log("node v8 surface passed");
