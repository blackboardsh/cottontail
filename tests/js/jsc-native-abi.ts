import {
  fullGC,
  gcAndSweep,
  generateHeapSnapshotForDebugging,
  getProtectedObjects,
  heapSize,
  setTimeZone,
} from "bun:jsc";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

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
