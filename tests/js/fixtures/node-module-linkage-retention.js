import { writeFileSync } from "node:fs";
import { join } from "node:path";
import "node:module";

if (!process.versions.cottontail) throw new Error("This regression must execute Cottontail");
const directory = process.argv[2];
const target = join(directory, "entry.mjs");
const leaf = join(directory, "leaf.mjs");
const cycle = join(directory, "cycle.mjs");
const left = join(directory, "left.mjs");
const right = join(directory, "right.mjs");
const barrel = join(directory, "barrel.mjs");
const filenames = [target, leaf, cycle, left, right, barrel];
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const check = (value, message) => { if (!value) throw new Error(message); };

function leafSource(version) {
  return [
    `/* ${"retained-linkage-source-".repeat(16_384)} */`,
    'import { cycleValue } from "./cycle.mjs";',
    `export let value = ${version};`,
    'export const marker = {};',
    'export function bump() { return ++value; }',
    'export function lazy() { return "linkage-lazy-value"; }',
    'export function fail() { throw new Error("linkage-late-error"); }',
    'export function throughCycle() { return cycleValue(); }',
    '',
  ].join("\n");
}
writeFileSync(leaf, leafSource(1));
writeFileSync(cycle, 'import { value } from "./leaf.mjs"; export function cycleValue() { return value; }\n');
writeFileSync(left, 'export * from "./leaf.mjs";\n');
writeFileSync(right, 'export * from "./leaf.mjs";\n');
writeFileSync(barrel, 'export * from "./left.mjs"; export * from "./right.mjs";\n');
writeFileSync(target, [
  'import { value, marker, bump, lazy, fail, throughCycle } from "./barrel.mjs";',
  'globalThis.__linkageRetentionEvaluations = (globalThis.__linkageRetentionEvaluations ?? 0) + 1;',
  'await 0;',
  'export { value, marker, bump, lazy, fail, throughCycle };',
  '',
].join("\n"));

// Observe only the synthetic validation records, without exposing runtime
// internals or retaining their targets. Actual GC in a later job must collect
// these records while the exported namespace and functions remain live.
const NativeWeakRef = globalThis.WeakRef;
const nativeMapSet = Map.prototype.set;
const linkageRefs = [];
Map.prototype.set = function (key, value) {
  const record = value instanceof NativeWeakRef ? value.deref() : value;
  if (record !== null && typeof record === "object" &&
      Object.getOwnPropertyDescriptor(record, "filename")?.value === leaf &&
      record.localTokens instanceof Map && record.dependencyBySpecifier instanceof Map) {
    linkageRefs.push(new NativeWeakRef(record));
  }
  return Reflect.apply(nativeMapSet, this, [key, value]);
};
let first;
try {
  first = await globalThis.__cottontailImportModule(target, import.meta.path, undefined, true);
} finally {
  Map.prototype.set = nativeMapSet;
}
check(linkageRefs.length > 0, "the regression did not observe a linkage record");
let collected = false;
for (let attempt = 0; attempt < 8; attempt += 1) {
  await pause();
  Bun.gc(true);
  await pause();
  collected = linkageRefs.every(ref => ref.deref() === undefined);
  if (collected) break;
}
check(collected, "validated linkage records still retain their source graph after GC");
check(first.value === 1 && first.throughCycle() === 1, "cyclic diamond lost its live binding");
check(first.bump() === 2 && first.value === 2 && first.throughCycle() === 2, "exports no longer share a binding");
check(first.lazy() === "linkage-lazy-value", "lazy function failed after graph collection");
check(first.lazy.toString().includes("linkage-lazy-value"), "function source lost after graph collection");
let delayedError;
try { first.fail(); } catch (error) { delayedError = error; }
check(delayedError?.message === "linkage-late-error", "delayed error lost its message");
check(String(delayedError.stack).includes("leaf.mjs"), "delayed error lost its source location");

const second = await globalThis.__cottontailImportModule(target, import.meta.path, undefined, true);
check(second === first && second.marker === first.marker, "cached forced import lost namespace identity");
check(globalThis.__linkageRetentionEvaluations === 1, "cached forced import re-evaluated the module");

// Deleting evaluated records still allows changed source to invalidate the
// validation cache. Old namespaces must retain their own exported state.
for (const filename of filenames) delete require.cache[filename];
writeFileSync(leaf, leafSource(7));
const third = await globalThis.__cottontailImportModule(target, import.meta.path, undefined, true);
check(third !== first && third.marker !== first.marker, "explicit invalidation retained a stale namespace");
check(third.value === 7 && third.throughCycle() === 7 && first.value === 2, "changed source or old exports were lost");
check(globalThis.__linkageRetentionEvaluations === 2, "changed source did not re-evaluate once");

// Failed validation must still detect genuinely different star bindings.
for (const filename of filenames) delete require.cache[filename];
await pause();
Bun.gc(true);
await pause();
writeFileSync(right, 'export const value = 100;\n');
let ambiguous;
try { await globalThis.__cottontailImportModule(target, import.meta.path, undefined, true); }
catch (error) { ambiguous = error; }
check(String(ambiguous?.message).includes("ambiguous"), "changed graph failed to reject ambiguous exports");
console.log(JSON.stringify({
  cottontail: true, linkageCollected: true, cachedIdentity: true,
  cyclicDiamond: true, changedSource: true,
}));
