import fs from "fs";
import { join } from "path";
import { tmpdirSync } from "harness";
import { heapStats } from "bun:jsc";

const tmpdir = tmpdirSync();
const MAX_ALLOWED_MEMORY_USAGE = 200;
const MAX_ALLOWED_MEMORY_GROWTH = 128;

const baselineRss = (process.memoryUsage().rss / 1024 / 1024) | 0;

for (let i = 0; i < 100_000; i++) {
  try {
    const signal = AbortSignal.abort();
    await fs.promises.readFile("blah", { signal });
  } catch (e) {}
  try {
    const signal = AbortSignal.abort();
    await fs.promises.writeFile("blah", "blah", { signal });
  } catch (e) {}

  // aborting later does not leak in writeFile
  const controller = new AbortController();
  const signal = controller.signal;
  const prom = fs.promises.writeFile(join(tmpdir, "blah"), "blah", { signal });
  process.nextTick(() => controller.abort());
  try {
    await prom;
  } catch (e) {}
}

Bun.gc(true);

const numAbortSignalObjects = heapStats().objectTypeCounts.AbortSignal;
if (numAbortSignalObjects > 10) {
  throw new Error(`AbortSignal objects > 10, received ${numAbortSignalObjects}`);
}

const rss = (process.memoryUsage().rss / 1024 / 1024) | 0;
const maxAllowedRss = process.env.COTTONTAIL_STOCK_JSC_RSS_BASELINE === "1"
  ? Math.max(MAX_ALLOWED_MEMORY_USAGE, baselineRss + MAX_ALLOWED_MEMORY_GROWTH)
  : MAX_ALLOWED_MEMORY_USAGE;
if (rss > maxAllowedRss) {
  throw new Error(`Memory leak detected: ${rss} MB (baseline ${baselineRss} MB, limit ${maxAllowedRss} MB)`);
}
