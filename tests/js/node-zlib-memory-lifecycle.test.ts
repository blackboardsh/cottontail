import { describe, expect, test } from "bun:test";
import { promisify } from "node:util";
import zlib from "node:zlib";

const input = Buffer.alloc(50_000);
let randomState = 0x6d2b79f5;
for (let index = 0; index < input.length; index += 1) {
  randomState = Math.imul(randomState, 1_664_525) + 1_013_904_223;
  input[index] = randomState >>> 24;
}

const maxGrowth = 10 * 1024 * 1024;

function expectBoundedSyncGrowth(run: () => unknown) {
  for (let index = 0; index < 1_000; index += 1) run();
  Bun.gc(true);
  const baseline = process.memoryUsage.rss();

  for (let index = 0; index < 1_000; index += 1) run();
  Bun.gc(true);
  expect(process.memoryUsage.rss() - baseline).toBeLessThan(maxGrowth);
}

async function expectBoundedAsyncGrowth(run: () => Promise<unknown>) {
  for (let index = 0; index < 1_000; index += 1) await run();
  Bun.gc(true);
  const baseline = process.memoryUsage.rss();

  for (let index = 0; index < 1_000; index += 1) await run();
  Bun.gc(true);
  expect(process.memoryUsage.rss() - baseline).toBeLessThan(maxGrowth);
}

describe("zlib one-shot native output lifecycle", () => {
  test("Brotli sync output remains bounded", () => {
    expect(zlib.brotliDecompressSync(zlib.brotliCompressSync(input)).equals(input)).toBe(true);
    expectBoundedSyncGrowth(() => zlib.brotliCompressSync(input));
  }, 0);

  test("Brotli callback output remains bounded", async () => {
    const compress = promisify(zlib.brotliCompress);
    expect(zlib.brotliDecompressSync(await compress(input)).equals(input)).toBe(true);
    await expectBoundedAsyncGrowth(() => compress(input));
  }, 0);

  test("Zstd sync output remains bounded", () => {
    expect(zlib.zstdDecompressSync(zlib.zstdCompressSync(input)).equals(input)).toBe(true);
    expectBoundedSyncGrowth(() => zlib.zstdCompressSync(input));
  }, 0);

  test("Zstd callback output remains bounded", async () => {
    const compress = promisify(zlib.zstdCompress);
    expect(zlib.zstdDecompressSync(await compress(input)).equals(input)).toBe(true);
    await expectBoundedAsyncGrowth(() => compress(input));
  }, 0);
});
