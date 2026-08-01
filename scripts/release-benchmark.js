import { arch as hostArch, platform as hostOs } from "node:process";

export const RELEASE_BENCHMARK_SCHEMA = 1;

export const RELEASE_BENCHMARK_PLATFORMS = Object.freeze([
  "macos-arm64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
]);

const bunAssets = Object.freeze({
  "macos-arm64": "bun-darwin-aarch64.zip",
  "linux-x64": "bun-linux-x64.zip",
  "linux-arm64": "bun-linux-aarch64.zip",
  "windows-x64": "bun-windows-x64.zip",
});

export function bunAssetName(platform) {
  const asset = bunAssets[platform];
  if (!asset) throw new Error(`Unsupported release benchmark platform: ${platform}`);
  return asset;
}

export function hostPlatformKey(platform = hostOs, arch = hostArch) {
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return "windows-x64";
  return null;
}

export function parseReleaseBenchmarkArgs(argv, defaults) {
  const options = {
    bunVersion: defaults.bunVersion,
    cacheDir: defaults.cacheDir,
    cottontailVersion: defaults.cottontailVersion,
    outputPath: defaults.outputPath ?? null,
    quick: false,
    skipPerformance: false,
    skipSizes: false,
    help: false,
  };

  const valueOptions = new Map([
    ["--bun", "bunVersion"],
    ["--cache-dir", "cacheDir"],
    ["--cottontail", "cottontailVersion"],
    ["--output", "outputPath"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--quick") {
      options.quick = true;
      continue;
    }
    if (argument === "--skip-performance") {
      options.skipPerformance = true;
      continue;
    }
    if (argument === "--skip-sizes") {
      options.skipSizes = true;
      continue;
    }

    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const field = valueOptions.get(name);
    if (!field) throw new Error(`Unknown release benchmark option: ${argument}`);
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    options[field] = value;
  }

  if (!options.cottontailVersion) throw new Error("A Cottontail version is required");
  if (!options.bunVersion) throw new Error("A Bun version is required");
  if (options.skipPerformance && options.skipSizes) {
    throw new Error("Cannot skip both performance and size comparisons");
  }
  return options;
}

export function summarizeNumbers(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Cannot summarize an empty sample set");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    min: sorted[0],
    p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
    average: total / sorted.length,
    max: sorted[sorted.length - 1],
    samples: values,
  };
}

export function parsePeakRss(stderr, platform = hostOs) {
  if (platform === "darwin") {
    const match = stderr.match(/(?:^|\n)\s*(\d+)\s+maximum resident set size\b/i);
    return match ? Number(match[1]) : null;
  }
  if (platform === "linux") {
    const match = stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/i);
    return match ? Number(match[1]) * 1024 : null;
  }
  return null;
}

export function comparisonRatio(cottontail, bun) {
  if (!Number.isFinite(cottontail) || !Number.isFinite(bun) || bun === 0) return null;
  return cottontail / bun;
}

export function formatBytes(bytes) {
  const sign = bytes < 0 ? "-" : "";
  const magnitude = Math.abs(bytes);
  if (magnitude < 1024) return `${sign}${magnitude} B`;
  if (magnitude < 1024 ** 2) return `${sign}${(magnitude / 1024).toFixed(2)} KiB`;
  return `${sign}${(magnitude / 1024 ** 2).toFixed(2)} MiB`;
}

function formatMetricValue(value, unit) {
  if (unit === "ms") return `${value.toFixed(3)} ms`;
  if (unit === "ns/call") return `${value.toFixed(2)} ns`;
  if (unit === "MiB") return `${value.toFixed(2)} MiB`;
  return `${value.toFixed(3)} ${unit}`;
}

function formatRatio(value) {
  return value == null ? "n/a" : `${value.toFixed(2)}x`;
}

export function renderReleaseBenchmarkMarkdown(result) {
  const lines = [
    `# Cottontail ${result.cottontail.version} vs Bun ${result.bun.version}`,
    "",
    `Host: ${result.host.platform} ${result.host.arch}, ${result.host.cpu}`,
    `Cottontail revision: ${result.cottontail.revision}`,
    "",
  ];

  if (result.sizes?.length) {
    lines.push(
      "## Executable size",
      "",
      "| Platform | Cottontail | Bun | Cottontail / Bun | Difference |",
      "| --- | ---: | ---: | ---: | ---: |",
    );
    for (const row of result.sizes) {
      const difference = row.cottontail.binaryBytes - row.bun.binaryBytes;
      const sign = difference > 0 ? "+" : "";
      lines.push(
        `| ${row.platform} | ${formatBytes(row.cottontail.binaryBytes)} | ` +
          `${formatBytes(row.bun.binaryBytes)} | ${formatRatio(row.ratio)} | ` +
          `${sign}${formatBytes(difference)} |`,
      );
    }
    lines.push("", "Sizes are extracted executable bytes. Archive sizes remain in the JSON result.", "");
  }

  if (result.performance?.metrics?.length) {
    lines.push(
      `## Performance (${result.performance.platform})`,
      "",
      "| Metric | Cottontail | Bun | Cottontail / Bun |",
      "| --- | ---: | ---: | ---: |",
    );
    for (const metric of result.performance.metrics) {
      lines.push(
        `| ${metric.name} | ${formatMetricValue(metric.cottontail, metric.unit)} | ` +
          `${formatMetricValue(metric.bun, metric.unit)} | ${formatRatio(metric.ratio)} |`,
      );
    }
    lines.push("", "Lower is better for every reported metric. Headline values are medians.", "");
  }

  return `${lines.join("\n").trim()}\n`;
}
