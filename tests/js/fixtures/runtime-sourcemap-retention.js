import { pathToFileURL } from "node:url";

if (!process.versions.cottontail) throw new Error("This regression must run in Cottontail");
const originalHooks = new Set(globalThis.__cottontailHotReloadHooks ?? []);
const { remapStackString } = await import(pathToFileURL(process.argv[2]).href);
const reloadHooks = [...globalThis.__cottontailHotReloadHooks].filter(hook => !originalHooks.has(hook));
const host = globalThis.cottontail;
const originalReadFile = host.readFile;
const mapPath = "/cottontail-sourcemap-memo/map.json.map";
const bundlePath = "/cottontail-sourcemap-memo/app.js";
const sourceRoot = "/cottontail-sourcemap-memo";
const adjacentBundlePath = sourceRoot + "/adjacent/script.bundle.mjs";
let adjacentMap = JSON.stringify({
  version: 3, sources: ["/independent/first.js"], sourcesContent: ["const first = true;"], mappings: "AAAA",
});
const originalEntryFilename = globalThis.__filename;
let sourceMap = JSON.stringify({
  version: 3,
  sources: ["src/\u4e2d.js", "src/unrelated.js"],
  sourcesContent: ["const value = 1;\n", "\u00e9".repeat(512 * 1024)],
  names: [],
  mappings: "AAAA",
});
let mapReads = 0;
host.readFile = function (path, ...args) {
  if (path === adjacentBundlePath + ".map") return adjacentMap;
  if (path === mapPath || path === mapPath + ".next") {
    mapReads += 1;
    return sourceMap;
  }
  return Reflect.apply(originalReadFile, this, [path, ...args]);
};
globalThis.__cottontailBundleSourceMap = mapPath;
globalThis.__cottontailBundleSourceMapData = undefined;
globalThis.__cottontailBundlePath = bundlePath;
globalThis.__cottontailBundleSourceRoot = sourceRoot;
const stack = `frame@${bundlePath}:1:1`;
const expected = `frame@${sourceRoot}/src/\u4e2d.js:1:1`;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const collect = async () => {
  // WeakRef targets are kept alive until the current JavaScript job finishes.
  await new Promise(resolve => setTimeout(resolve, 5));
  Bun.gc(true);
  await new Promise(resolve => setTimeout(resolve, 5));
};

try {
  check(remapStackString(stack) === expected, "Initial Unicode remapping failed");
  for (let index = 0; index < 4; index += 1) {
    await collect();
    check(remapStackString(stack) === expected, "Post-GC remapping changed");
  }
  check(mapReads === 1, `Repeated stack reread the source map ${mapReads} times`);

  // Context changes must not return results from another map or source root.
  globalThis.__cottontailBundleSourceRoot = sourceRoot + "/other";
  check(remapStackString(stack).includes("/other/src/\u4e2d.js:1:1"), "Source-root change returned stale result");
  globalThis.__cottontailBundleSourceRoot = sourceRoot;
  globalThis.__cottontailBundleSourceMap = mapPath + ".next";
  check(remapStackString(stack) === expected, "Map-path context change failed");
  globalThis.__cottontailBundleSourceMapData = JSON.stringify({
    version: 3, sources: ["changed.js"], sourcesContent: ["const changed = true;"], mappings: "AAAA",
  });
  check(remapStackString(stack).includes("/changed.js:1:1"), "Embedded-map change returned stale result");
  globalThis.__cottontailBundleSourceMapData = undefined;
  globalThis.__cottontailBundleSourceMap = mapPath;
  check(remapStackString(stack) === expected, "Restoring external map failed");
  globalThis.__cottontailBundlePath = sourceRoot + "/alternate.js";
  check(remapStackString(`frame@${globalThis.__cottontailBundlePath}:1:1`) === expected, "Bundle-path change failed");
  globalThis.__cottontailBundlePath = bundlePath;
  check(remapStackString(stack) === expected, "Restoring bundle path failed");
  await collect();
  const beforeFilenameChange = mapReads;
  globalThis.__filename = sourceRoot + "/other-entry.js";
  check(remapStackString(stack) === expected, "Entry filename change failed");
  check(mapReads > beforeFilenameChange, "Entry filename did not invalidate the result memo");
  globalThis.__filename = originalEntryFilename;

  // Reload updates a map in place without changing its path or bundle context.
  check(reloadHooks.length > 0, "No source-map hot reload invalidation hook");
  sourceMap = sourceMap.replace('src/\u4e2d.js', 'src/reloaded.js');
  for (const hook of reloadHooks) hook();
  check(remapStackString(stack).includes("/src/reloaded.js:1:1"), "Same-path map reload returned stale result");

  // A different adjacent bundle may rewrite its map without changing the
  // active bundle's context. It must keep its independent weak lookup path.
  const adjacentStack = `foreign@${adjacentBundlePath}:1:1`;
  check(remapStackString(adjacentStack).includes("/independent/first.js:1:1"), "Initial adjacent map failed");
  adjacentMap = adjacentMap.replace("first.js", "second.js");
  await collect();
  check(remapStackString(adjacentStack).includes("/independent/second.js:1:1"), "Adjacent map was pinned by unrelated result memo");

  // The active map can also reveal an adjacent bundle that was not present in
  // the original stack. Its independent map must remain fresh across GC.
  const previousMap = sourceMap;
  sourceMap = JSON.stringify({
    version: 3, sources: [adjacentBundlePath], sourcesContent: ["const adjacent = true;"], mappings: "AAAA",
  });
  for (const hook of reloadHooks) hook();
  check(remapStackString(stack).includes("/independent/second.js:1:1"), "Indirect adjacent mapping failed");
  adjacentMap = adjacentMap.replace("second.js", "third.js");
  await collect();
  check(remapStackString(stack).includes("/independent/third.js:1:1"), "Indirect adjacent map was cached with the active result");
  sourceMap = previousMap;
  for (const hook of reloadHooks) hook();

  // More distinct small results than the entry limit must evict old results.
  for (let index = 0; index < 140; index += 1) remapStackString(`${index}:${stack}`);
  const beforeEntryEviction = mapReads;
  await collect();
  remapStackString(`139:${stack}`);
  check(mapReads === beforeEntryEviction, "Newest result was not cached across GC");
  remapStackString(`0:${stack}`);
  check(mapReads > beforeEntryEviction, "Old result was not evicted by entry bound");

  // A few larger results exceed the byte bound without reaching 128 entries.
  for (let index = 0; index < 12; index += 1) remapStackString(`${index}:${"x".repeat(12_000)}:${stack}`);
  const beforeByteEviction = mapReads;
  await collect();
  remapStackString(`11:${"x".repeat(12_000)}:${stack}`);
  check(mapReads === beforeByteEviction, "Newest bounded large result was not cached");
  remapStackString(`0:${"x".repeat(12_000)}:${stack}`);
  check(mapReads > beforeByteEviction, "Old result was not evicted by byte bound");

  // Oversized individual stacks must never become strongly retained results.
  const oversized = "x".repeat(140_000) + stack;
  remapStackString(oversized);
  const beforeOversized = mapReads;
  await collect();
  remapStackString(oversized);
  check(mapReads > beforeOversized, "Oversized stack was cached");
  console.log(JSON.stringify({ cottontail: true, repeatedStackReads: 1, boundsAndInvalidation: true }));
} finally {
  host.readFile = originalReadFile;
  globalThis.__cottontailBundleSourceMap = undefined;
  globalThis.__cottontailBundleSourceMapData = undefined;
  globalThis.__filename = originalEntryFilename;
}
