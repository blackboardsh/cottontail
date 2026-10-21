import {
  fullGC,
  gcAndSweep,
  generateHeapSnapshotForDebugging,
  getProtectedObjects,
  heapSize,
  setTimeZone,
} from "bun:jsc";
import { isAscii, transcode } from "node:buffer";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

// JSC invokes these three callbacks with its host-call convention, which is
// SysV rather than the default C convention on Windows x64. Exercise argument,
// result, and exception propagation even when coverage profiling is disabled.
assert(isAscii(Buffer.from("abc")), "native ASCII callback lost its argument");
assert(!isAscii(new Uint8Array([0xff])), "native ASCII callback lost its result");
assert(transcode(Buffer.from("hello"), "utf8", "utf16le").toString("utf16le") === "hello", "native transcode callback lost its arguments");
let coverageError: unknown;
try {
  cottontail.collectTestCoverage();
} catch (error) {
  coverageError = error;
}
assert(coverageError instanceof Error && coverageError.message === "Control-flow coverage profiler is not enabled", "native coverage callback must propagate its exception");

// These calls cross Cottontail's private JSC ABI adapters. In particular,
// JSC execution modes change the VM layout, and Windows ARM64 requires GCRequest to retain
// its non-trivial copy/move constructors to pass the argument indirectly.
const retained = Array.from({ length: 513 }, (_, index) => ({ index }));
for (let pass = 0; pass < 3; pass++) {
  assert(fullGC() > 0, "full collection must report live heap memory");
  assert(gcAndSweep() > 0, "sweeping collection must report live heap memory");
  assert(retained.every((value, index) => value.index === index), "GC lost live objects");
  assert(getProtectedObjects().includes(cottontail), "protected roots must include the host object");
}
assert(heapSize() > 0, "heap size must remain positive after collection");

const originalZone = process.env.TZ || "UTC";
try {
  setTimeZone("UTC");
  const utc = new Date(0).toString();
  assert(Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC", "ICU time zone must be UTC");
  setTimeZone("America/Anchorage");
  assert(new Date(0).toString() !== utc, "changing time zone must invalidate JSC's Date cache");
  assert(Intl.DateTimeFormat().resolvedOptions().timeZone === "America/Anchorage", "ICU time zone must change");
} finally {
  setTimeZone(originalZone);
}

const snapshot = generateHeapSnapshotForDebugging();
assert(snapshot.type === "GCDebugging", "native heap snapshot type mismatch");
assert(Array.isArray(snapshot.nodes) && snapshot.nodes.length > 0, "native heap snapshot must contain live objects");
console.log("native JSC heap, GC, roots, snapshot, and time-zone ABI passed");
