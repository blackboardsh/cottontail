import assert from "node:assert/strict";
import test from "node:test";

import {
  bunAssetName,
  comparisonRatio,
  formatBytes,
  hostPlatformKey,
  parsePeakRss,
  parseReleaseBenchmarkArgs,
  renderReleaseBenchmarkMarkdown,
  renderReleaseBenchmarkTerminal,
  summarizeNumbers,
} from "./release-benchmark.js";

const defaults = {
  bunVersion: "1.3.10",
  cacheDir: "/tmp/cache",
  cottontailVersion: "0.2.3",
};

test("maps the Cottontail release matrix to standard Bun assets", () => {
  assert.equal(bunAssetName("macos-arm64"), "bun-darwin-aarch64.zip");
  assert.equal(bunAssetName("linux-x64"), "bun-linux-x64.zip");
  assert.equal(bunAssetName("linux-arm64"), "bun-linux-aarch64.zip");
  assert.equal(bunAssetName("windows-x64"), "bun-windows-x64.zip");
  assert.throws(() => bunAssetName("macos-x64"), /Unsupported/);
});

test("maps supported hosts and Windows ARM emulation", () => {
  assert.equal(hostPlatformKey("darwin", "arm64"), "macos-arm64");
  assert.equal(hostPlatformKey("linux", "x64"), "linux-x64");
  assert.equal(hostPlatformKey("linux", "arm64"), "linux-arm64");
  assert.equal(hostPlatformKey("win32", "arm64"), "windows-x64");
  assert.equal(hostPlatformKey("darwin", "x64"), null);
});

test("parses explicit versions and comparison modes", () => {
  assert.deepEqual(
    parseReleaseBenchmarkArgs([
      "--cottontail=1.2.3",
      "--bun",
      "1.4.0",
      "--quick",
      "--output",
      "result.json",
    ], defaults),
    {
      bunVersion: "1.4.0",
      cacheDir: "/tmp/cache",
      cottontailVersion: "1.2.3",
      outputPath: "result.json",
      quick: true,
      skipPerformance: false,
      skipSizes: false,
      help: false,
    },
  );
  assert.throws(
    () => parseReleaseBenchmarkArgs(["--skip-performance", "--skip-sizes"], defaults),
    /Cannot skip both/,
  );
  assert.throws(() => parseReleaseBenchmarkArgs(["--unknown"], defaults), /Unknown/);
});

test("summarizes samples and parses macOS and Linux peak RSS", () => {
  assert.deepEqual(summarizeNumbers([9, 1, 5]), {
    min: 1,
    p50: 5,
    average: 5,
    max: 9,
    samples: [9, 1, 5],
  });
  assert.equal(parsePeakRss("  123456  maximum resident set size\n", "darwin"), 123456);
  assert.equal(
    parsePeakRss("Maximum resident set size (kbytes): 2048\n", "linux"),
    2 * 1024 * 1024,
  );
  assert.equal(parsePeakRss("unrelated output", "darwin"), null);
});

test("formats ratios, sizes, and a stable Markdown report", () => {
  assert.equal(comparisonRatio(50, 100), 0.5);
  assert.equal(formatBytes(1024 ** 2), "1.00 MiB");
  assert.equal(formatBytes(-10 * 1024 ** 2), "-10.00 MiB");
  const markdown = renderReleaseBenchmarkMarkdown({
    host: { platform: "darwin", arch: "arm64", cpu: "Example CPU" },
    cottontail: { version: "0.2.3", revision: "a".repeat(40) },
    bun: { version: "1.3.10" },
    sizes: [{
      platform: "macos-arm64",
      cottontail: { binaryBytes: 50 * 1024 ** 2 },
      bun: { binaryBytes: 60 * 1024 ** 2 },
      ratio: 5 / 6,
    }],
    performance: {
      platform: "macos-arm64",
      metrics: [{ name: "empty startup", unit: "ms", cottontail: 15, bun: 10, ratio: 1.5 }],
    },
  });
  assert.match(markdown, /Cottontail 0\.2\.3 vs Bun 1\.3\.10/);
  assert.match(markdown, /\| macos-arm64 \| 50\.00 MiB \| 60\.00 MiB \| 0\.83x \| -10\.00 MiB \|/);
  assert.match(markdown, /\| empty startup \| 15\.000 ms \| 10\.000 ms \| 1\.50x \|/);
});

test("renders aligned terminal tables for interactive comparisons", () => {
  const terminal = renderReleaseBenchmarkTerminal({
    host: { platform: "darwin", arch: "arm64", cpu: "Example CPU" },
    cottontail: { version: "0.2.3", revision: "a".repeat(40) },
    bun: { version: "1.3.10" },
    sizes: [{
      platform: "macos-arm64",
      cottontail: { binaryBytes: 50 * 1024 ** 2 },
      bun: { binaryBytes: 60 * 1024 ** 2 },
      ratio: 5 / 6,
    }],
    performance: {
      platform: "macos-arm64",
      metrics: [{ name: "empty startup", unit: "ms", cottontail: 15, bun: 10, ratio: 1.5 }],
    },
  });
  assert.match(terminal, /^┌[─┬]+┐$/m);
  assert.match(terminal, /│ macos-arm64 │\s+50\.00 MiB │\s+60\.00 MiB │\s+0\.83x │\s+-10\.00 MiB │/);
  assert.match(terminal, /│ empty startup │\s+15\.000 ms │\s+10\.000 ms │\s+1\.50x │/);
  assert.doesNotMatch(terminal, /^\| ---/m);
});
