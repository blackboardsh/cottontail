import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

test("readline async iterators expose and apply watermark backpressure", async () => {
  const input = new Readable({ read() {} });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const iterator = rl[Symbol.asyncIterator]();
  const watermark = iterator[Symbol.for("nodejs.watermarkData")];

  expect(watermark.high).toBe(1024);
  expect(watermark.low).toBe(1);

  input.push("line\n".repeat(1026));
  await new Promise((resolve) => setImmediate(resolve));
  expect(watermark.size).toBe(1026);
  expect(watermark.isPaused).toBe(true);
  expect(input.isPaused()).toBe(true);

  while (watermark.size > 0) await iterator.next();
  expect(watermark.isPaused).toBe(false);
  expect(input.isPaused()).toBe(false);
  await iterator.return?.();
});
