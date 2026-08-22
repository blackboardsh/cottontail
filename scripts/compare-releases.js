#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, release as osRelease } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { arch, platform, versions } from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  RELEASE_BENCHMARK_PLATFORMS,
  RELEASE_BENCHMARK_SCHEMA,
  bunAssetName,
  comparisonRatio,
  hostPlatformKey,
  parsePeakRss,
  parseReleaseBenchmarkArgs,
  renderReleaseBenchmarkMarkdown,
  renderReleaseBenchmarkTerminal,
  summarizeNumbers,
} from "./release-benchmark.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const packageBunVersion = packageJson.packageManager?.match(/^bun@(.+)$/)?.[1];
const defaultCacheDir = join(rootDir, ".cottontail-tmp", "release-benchmarks", "cache");
const artifactsBaseUrl = (
  process.env.COTTONTAIL_ARTIFACTS_BASE_URL ??
  "https://electrobun-artifacts.blackboard.sh"
).replace(/\/+$/, "");

function usage() {
  return `Usage: node scripts/compare-releases.js [options]

Compare immutable Cottontail and Bun releases.

Options:
  --cottontail VERSION   Cottontail release version (default: ${packageJson.version})
  --bun VERSION          Bun release version (default: ${packageBunVersion ?? "required"})
  --cache-dir PATH       Download/extraction cache (default: .cottontail-tmp/release-benchmarks/cache)
  --output PATH          JSON result path; a Markdown report is written beside it
  --quick                Reduced samples and filesystem fixtures for harness validation
  --skip-performance     Download all targets and compare executable sizes only
  --skip-sizes           Download the host target and run performance only
  --help                 Show this help

Example:
  node scripts/compare-releases.js --cottontail 0.2.3 --bun 1.3.10
`;
}

function log(message) {
  process.stderr.write(`[release-benchmark] ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function safeVersion(version, label) {
  const normalized = String(version).replace(/^bun-v/, "").replace(/^v/, "");
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(normalized)) {
    fail(`Invalid ${label} version: ${JSON.stringify(version)}`);
  }
  return normalized;
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cottontail-release-benchmark",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) fail(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const input = createReadStream(path);
    input.on("data", chunk => hash.update(chunk));
    input.on("error", rejectHash);
    input.on("end", resolveHash);
  });
  return hash.digest("hex");
}

async function downloadFile({ url, path, sha256, size, label }) {
  if (existsSync(path)) {
    const currentSize = statSync(path).size;
    if ((!size || currentSize === size) && (!sha256 || await sha256File(path) === sha256)) {
      log(`cached ${label}`);
      return;
    }
    rmSync(path, { force: true });
  }

  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.part-${process.pid}`;
  rmSync(temporaryPath, { force: true });
  log(`downloading ${label}`);
  const response = await fetch(url, { headers: { "User-Agent": "cottontail-release-benchmark" } });
  if (!response.ok || !response.body) {
    fail(`Download ${url} failed: ${response.status} ${response.statusText}`);
  }
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath));
    const actualSize = statSync(temporaryPath).size;
    if (size && actualSize !== size) {
      fail(`${label} size mismatch: expected ${size}, received ${actualSize}`);
    }
    const actualSha256 = await sha256File(temporaryPath);
    if (sha256 && actualSha256 !== sha256) {
      fail(`${label} checksum mismatch: expected ${sha256}, received ${actualSha256}`);
    }
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

async function mapLimit(items, limit, operation) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 10 * 60 * 1000,
  });
  if (result.error) fail(`${options.label ?? command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail([
      `${options.label ?? command} exited with status ${result.status}`,
      result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : null,
      result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : null,
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function findBinary(directory, names) {
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && names.includes(entry.name)) return join(directory, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findBinary(join(directory, entry.name), names);
    if (found) return found;
  }
  return null;
}

function extractArtifact(record, cacheDir) {
  const extractionKey = `${record.platform}-${record.sha256.slice(0, 16)}`;
  const extractionDir = join(cacheDir, "extracted", record.runtime, record.version, extractionKey);
  const stampPath = join(extractionDir, ".complete");
  const names = record.platform === "windows-x64"
    ? [record.runtime === "cottontail" ? "cottontail.exe" : "bun.exe"]
    : [record.runtime === "cottontail" ? "cottontail" : "bun"];

  if (existsSync(stampPath) && readFileSync(stampPath, "utf8").trim() === record.sha256) {
    const cached = findBinary(extractionDir, names);
    if (cached) return cached;
  }

  rmSync(extractionDir, { recursive: true, force: true });
  mkdirSync(extractionDir, { recursive: true });
  log(`extracting ${record.runtime} ${record.version} ${record.platform}`);
  runChecked("tar", ["-xf", record.archivePath, "-C", extractionDir], {
    label: `extract ${basename(record.archivePath)}`,
  });
  const binary = findBinary(extractionDir, names);
  if (!binary) fail(`Could not find ${names.join(" or ")} in ${record.archivePath}`);
  if (record.platform !== "windows-x64") chmodSync(binary, 0o755);
  writeFileSync(stampPath, `${record.sha256}\n`);
  return binary;
}

function validateCottontailManifest(manifest, version) {
  if (manifest.schema !== 1 || manifest.kind !== "release" || manifest.product !== "cottontail") {
    fail(`Cottontail ${version} returned an invalid release manifest`);
  }
  if (manifest.version !== version) {
    fail(`Cottontail manifest version mismatch: expected ${version}, received ${manifest.version}`);
  }
  for (const platformName of RELEASE_BENCHMARK_PLATFORMS) {
    const archive = manifest.platforms?.[platformName]?.archive;
    if (!archive?.url || !/^[0-9a-f]{64}$/.test(archive.sha256) || !archive.size) {
      fail(`Cottontail ${version} manifest is missing ${platformName}`);
    }
  }
}

async function acquireReleases(options, currentPlatform) {
  const cottontailManifestUrl = `${artifactsBaseUrl}/cottontail/releases/${options.cottontailVersion}/manifest.json`;
  const [cottontailManifest, bunRelease] = await Promise.all([
    fetchJson(cottontailManifestUrl),
    fetchJson(
      `https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v${options.bunVersion}`,
      githubHeaders(),
    ),
  ]);
  validateCottontailManifest(cottontailManifest, options.cottontailVersion);
  if (bunRelease.tag_name !== `bun-v${options.bunVersion}`) {
    fail(`Bun release tag mismatch for ${options.bunVersion}`);
  }

  const platforms = options.skipSizes ? [currentPlatform] : RELEASE_BENCHMARK_PLATFORMS;
  const records = [];
  for (const platformName of platforms) {
    const cottontailArchive = cottontailManifest.platforms[platformName].archive;
    records.push({
      runtime: "cottontail",
      version: options.cottontailVersion,
      platform: platformName,
      url: cottontailArchive.url,
      sha256: cottontailArchive.sha256,
      archiveBytes: cottontailArchive.size,
      archivePath: join(
        options.cacheDir,
        "archives",
        "cottontail",
        options.cottontailVersion,
        `${platformName}.tar.gz`,
      ),
    });

    const assetName = bunAssetName(platformName);
    const bunAsset = bunRelease.assets?.find(asset => asset.name === assetName);
    if (!bunAsset?.browser_download_url || !bunAsset.size) {
      fail(`Bun ${options.bunVersion} is missing ${assetName}`);
    }
    const digest = bunAsset.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
    if (!digest) fail(`Bun ${options.bunVersion} asset ${assetName} has no SHA-256 digest`);
    records.push({
      runtime: "bun",
      version: options.bunVersion,
      platform: platformName,
      url: bunAsset.browser_download_url,
      sha256: digest,
      archiveBytes: bunAsset.size,
      archivePath: join(options.cacheDir, "archives", "bun", options.bunVersion, assetName),
    });
  }

  await mapLimit(records, 4, record => downloadFile({
    url: record.url,
    path: record.archivePath,
    sha256: record.sha256,
    size: record.archiveBytes,
    label: `${record.runtime} ${record.version} ${record.platform}`,
  }));

  for (const record of records) {
    record.binaryPath = extractArtifact(record, options.cacheDir);
    record.binaryBytes = statSync(record.binaryPath).size;
  }

  return { cottontailManifest, bunRelease, records };
}

function benchmarkEnvironment(extra = {}) {
  return {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...extra,
  };
}

function runScript(runtime, scriptPath, expectInternalMetric = false, env = {}) {
  const started = process.hrtime.bigint();
  const result = runChecked(runtime.binaryPath, [scriptPath], {
    cwd: rootDir,
    env: benchmarkEnvironment(env),
    label: `${runtime.label} ${basename(scriptPath)}`,
  });
  const wallNs = Number(process.hrtime.bigint() - started);
  const internalMatch = result.stdout.match(/__bench_internal_ns__=(\d+)/);
  if (expectInternalMetric && !internalMatch) {
    fail(`${runtime.label} ${basename(scriptPath)} did not emit an internal timing`);
  }
  return {
    wallNs,
    internalNs: internalMatch ? Number(internalMatch[1]) : null,
  };
}

function pairedSamples(runtimes, count, operation) {
  const samples = { cottontail: [], bun: [] };
  for (let index = 0; index < count; index += 1) {
    const order = index % 2 === 0 ? runtimes : [...runtimes].reverse();
    for (const runtime of order) samples[runtime.name].push(operation(runtime));
  }
  return samples;
}

function runProcessBenchmarks(runtimes, quick) {
  const definitions = [
    ["startup-empty", "empty.js", quick ? 5 : 20, false],
    ["startup-full-runtime", "full-runtime.js", quick ? 3 : 12, false],
    ["module-resolve", "module-resolve.js", quick ? 3 : 8, true],
    ["loop", "loop.js", quick ? 3 : 12, true],
    ["json", "json.js", quick ? 3 : 8, true],
    ["async", "async.js", quick ? 3 : 8, true],
  ];
  const output = {};
  for (const [name, file, count, internal] of definitions) {
    const scriptPath = join(rootDir, "bench", file);
    log(`performance ${name} (${count} paired samples)`);
    for (const runtime of runtimes) runScript(runtime, scriptPath, internal);
    const samples = pairedSamples(runtimes, count, runtime => runScript(runtime, scriptPath, internal));
    output[name] = Object.fromEntries(runtimes.map(runtime => {
      const runtimeSamples = samples[runtime.name];
      return [runtime.name, {
        wallNs: summarizeNumbers(runtimeSamples.map(sample => sample.wallNs)),
        internalNs: internal
          ? summarizeNumbers(runtimeSamples.map(sample => sample.internalNs))
          : null,
      }];
    }));
  }
  return output;
}

function runPeakRss(runtime, scriptPath) {
  const args = platform === "darwin"
    ? ["-l", runtime.binaryPath, scriptPath]
    : ["-v", runtime.binaryPath, scriptPath];
  const result = runChecked("/usr/bin/time", args, {
    cwd: rootDir,
    env: benchmarkEnvironment(),
    label: `${runtime.label} peak RSS`,
  });
  const bytes = parsePeakRss(result.stderr, platform);
  if (bytes == null) fail(`Could not parse ${runtime.label} peak RSS from /usr/bin/time`);
  return bytes;
}

function runRssBenchmarks(runtimes, quick) {
  if (platform !== "darwin" && platform !== "linux") return null;
  const output = {};
  for (const [name, file] of [["empty", "empty.js"], ["full-runtime", "full-runtime.js"]]) {
    const scriptPath = join(rootDir, "bench", file);
    const count = quick ? 2 : 7;
    log(`peak RSS ${name} (${count} paired samples)`);
    const samples = pairedSamples(runtimes, count, runtime => runPeakRss(runtime, scriptPath));
    output[name] = Object.fromEntries(
      runtimes.map(runtime => [runtime.name, summarizeNumbers(samples[runtime.name])]),
    );
  }
  return output;
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    fail(`${label} did not emit valid JSON: ${error.message}\n${result.stdout}`);
  }
}

function runJsonScript(runtime, scriptPath, env = {}) {
  return parseJsonOutput(runChecked(runtime.binaryPath, [scriptPath], {
    cwd: rootDir,
    env: benchmarkEnvironment(env),
    label: `${runtime.label} ${basename(scriptPath)}`,
    timeout: 20 * 60 * 1000,
  }), `${runtime.label} ${basename(scriptPath)}`);
}

function runFfiBenchmarks(runtimes, quick) {
  const scriptPath = join(rootDir, "scripts", "bench-ffi-calls.js");
  const count = quick ? 1 : 3;
  log(`prepared FFI (${count} paired process samples)`);
  const samples = pairedSamples(runtimes, count, runtime => runJsonScript(runtime, scriptPath, quick ? {
    COTTONTAIL_FFI_BENCH_ITERATIONS: "100000",
    COTTONTAIL_FFI_BENCH_ROUNDS: "3",
  } : {}));
  return Object.fromEntries(runtimes.map(runtime => [runtime.name, {
    nanosecondsPerCall: summarizeNumbers(
      samples[runtime.name].map(sample => sample.nanosecondsPerCall),
    ),
    runs: samples[runtime.name],
  }]));
}

function runFilesystemBenchmarks(runtimes, quick) {
  const scriptPath = join(rootDir, "bench", "fs-bulk.js");
  const count = quick ? 1 : 3;
  const env = quick ? {
    COTTONTAIL_FS_BENCH_TREE_FILES: "300",
    COTTONTAIL_FS_BENCH_LARGE_BYTES: String(8 * 1024 * 1024),
    COTTONTAIL_FS_BENCH_ITERATIONS: "2",
  } : {};
  log(`filesystem bulk operations (${count} paired process samples)`);
  const samples = pairedSamples(runtimes, count, runtime => runJsonScript(runtime, scriptPath, env));
  return Object.fromEntries(runtimes.map(runtime => {
    const runs = samples[runtime.name];
    const metrics = {};
    for (const metric of Object.keys(runs[0].medianMs)) {
      metrics[metric] = summarizeNumbers(runs.map(run => run.medianMs[metric]));
    }
    return [runtime.name, {
      fixture: {
        treeFiles: runs[0].treeFiles,
        largeFileBytes: runs[0].largeFileBytes,
        iterations: runs[0].iterations,
      },
      metrics,
      runs,
    }];
  }));
}

function metric(name, unit, cottontail, bun) {
  return { name, unit, cottontail, bun, ratio: comparisonRatio(cottontail, bun) };
}

function createPerformanceResult(runtimes, platformName, quick) {
  const processResults = runProcessBenchmarks(runtimes, quick);
  const rssResults = runRssBenchmarks(runtimes, quick);
  const ffiResults = runFfiBenchmarks(runtimes, quick);
  const filesystemResults = runFilesystemBenchmarks(runtimes, quick);
  const metrics = [
    metric(
      "empty process startup",
      "ms",
      processResults["startup-empty"].cottontail.wallNs.p50 / 1e6,
      processResults["startup-empty"].bun.wallNs.p50 / 1e6,
    ),
    metric(
      "full Bun surface startup",
      "ms",
      processResults["startup-full-runtime"].cottontail.wallNs.p50 / 1e6,
      processResults["startup-full-runtime"].bun.wallNs.p50 / 1e6,
    ),
    metric(
      "module resolution (2,000)",
      "ms",
      processResults["module-resolve"].cottontail.internalNs.p50 / 1e6,
      processResults["module-resolve"].bun.internalNs.p50 / 1e6,
    ),
    metric(
      "JS loop (200,000)",
      "ms",
      processResults.loop.cottontail.internalNs.p50 / 1e6,
      processResults.loop.bun.internalNs.p50 / 1e6,
    ),
    metric(
      "JSON round trip (4,000 rows)",
      "ms",
      processResults.json.cottontail.internalNs.p50 / 1e6,
      processResults.json.bun.internalNs.p50 / 1e6,
    ),
    metric(
      "Promise chain (5,000)",
      "ms",
      processResults.async.cottontail.internalNs.p50 / 1e6,
      processResults.async.bun.internalNs.p50 / 1e6,
    ),
  ];
  if (rssResults) {
    metrics.push(
      metric(
        "empty process peak RSS",
        "MiB",
        rssResults.empty.cottontail.p50 / 1024 ** 2,
        rssResults.empty.bun.p50 / 1024 ** 2,
      ),
      metric(
        "full Bun surface peak RSS",
        "MiB",
        rssResults["full-runtime"].cottontail.p50 / 1024 ** 2,
        rssResults["full-runtime"].bun.p50 / 1024 ** 2,
      ),
    );
  }
  metrics.push(
    metric(
      "prepared FFI integer call",
      "ns/call",
      ffiResults.cottontail.nanosecondsPerCall.p50,
      ffiResults.bun.nanosecondsPerCall.p50,
    ),
  );
  const largeFileMiB = filesystemResults.cottontail.fixture.largeFileBytes / 1024 ** 2;
  const fsNames = [
    ["filesystem tree copy", "treeCopy"],
    ["filesystem tree remove", "treeRemove"],
    ["filesystem async tree remove", "asyncTreeRemove"],
    ["filesystem async timer delay", "asyncTreeRemoveTimerDelay"],
    [`filesystem ${largeFileMiB} MiB file copy`, "largeFileCopy"],
  ];
  for (const [name, key] of fsNames) {
    metrics.push(metric(
      name,
      "ms",
      filesystemResults.cottontail.metrics[key].p50,
      filesystemResults.bun.metrics[key].p50,
    ));
  }
  return {
    platform: platformName,
    quick,
    metrics,
    raw: {
      process: processResults,
      rss: rssResults,
      ffi: ffiResults,
      filesystem: filesystemResults,
    },
  };
}

function resolveOutputPath(options) {
  const fallback = join(
    rootDir,
    ".cottontail-tmp",
    "release-benchmarks",
    "results",
    `cottontail-${options.cottontailVersion}-vs-bun-${options.bunVersion}.json`,
  );
  const requested = options.outputPath ? resolve(rootDir, options.outputPath) : fallback;
  const extension = extname(requested);
  if (extension && extension !== ".json") fail("--output must name a .json file");
  return extension ? requested : `${requested}.json`;
}

async function main() {
  const parsed = parseReleaseBenchmarkArgs(process.argv.slice(2), {
    bunVersion: packageBunVersion,
    cacheDir: defaultCacheDir,
    cottontailVersion: packageJson.version,
  });
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  const options = {
    ...parsed,
    bunVersion: safeVersion(parsed.bunVersion, "Bun"),
    cacheDir: resolve(rootDir, parsed.cacheDir),
    cottontailVersion: safeVersion(parsed.cottontailVersion, "Cottontail"),
  };
  const currentPlatform = hostPlatformKey();
  if (!currentPlatform && !options.skipPerformance) {
    fail(`Performance comparison is not supported on ${platform}-${arch}; use --skip-performance`);
  }

  log(`Cottontail ${options.cottontailVersion} vs Bun ${options.bunVersion}`);
  const acquired = await acquireReleases(options, currentPlatform);
  const byRuntimePlatform = new Map(
    acquired.records.map(record => [`${record.runtime}:${record.platform}`, record]),
  );
  const sizes = options.skipSizes ? null : RELEASE_BENCHMARK_PLATFORMS.map(platformName => {
    const cottontail = byRuntimePlatform.get(`cottontail:${platformName}`);
    const bun = byRuntimePlatform.get(`bun:${platformName}`);
    return {
      platform: platformName,
      cottontail: {
        archiveBytes: cottontail.archiveBytes,
        archiveSha256: cottontail.sha256,
        binaryBytes: cottontail.binaryBytes,
      },
      bun: {
        archiveBytes: bun.archiveBytes,
        archiveSha256: bun.sha256,
        binaryBytes: bun.binaryBytes,
      },
      ratio: comparisonRatio(cottontail.binaryBytes, bun.binaryBytes),
    };
  });

  let performance = null;
  const cottontailHost = byRuntimePlatform.get(`cottontail:${currentPlatform}`);
  const bunHost = byRuntimePlatform.get(`bun:${currentPlatform}`);
  if (!options.skipPerformance) {
    const cottontailVersionOutput = runChecked(cottontailHost.binaryPath, ["--version"], {
      label: "Cottontail version check",
    }).stdout.trim();
    const bunVersionOutput = runChecked(bunHost.binaryPath, ["--version"], {
      label: "Bun version check",
    }).stdout.trim();
    if (!cottontailVersionOutput.includes(options.cottontailVersion)) {
      fail(`Cottontail binary reported ${JSON.stringify(cottontailVersionOutput)}`);
    }
    if (bunVersionOutput !== options.bunVersion) {
      fail(`Bun binary reported ${JSON.stringify(bunVersionOutput)}`);
    }
    performance = createPerformanceResult([
      { name: "cottontail", label: `Cottontail ${options.cottontailVersion}`, binaryPath: cottontailHost.binaryPath },
      { name: "bun", label: `Bun ${options.bunVersion}`, binaryPath: bunHost.binaryPath },
    ], currentPlatform, options.quick);
  }

  const result = {
    schema: RELEASE_BENCHMARK_SCHEMA,
    generatedAt: new Date().toISOString(),
    host: {
      platform,
      arch,
      platformKey: currentPlatform,
      osRelease: osRelease(),
      cpu: cpus()[0]?.model ?? "unknown",
      node: versions.node,
    },
    cottontail: {
      version: options.cottontailVersion,
      revision: acquired.cottontailManifest.revision,
      manifestUrl: `${artifactsBaseUrl}/cottontail/releases/${options.cottontailVersion}/manifest.json`,
    },
    bun: {
      version: options.bunVersion,
      tag: acquired.bunRelease.tag_name,
      releaseUrl: acquired.bunRelease.html_url,
    },
    methodology: {
      artifacts: "immutable release artifacts with SHA-256 verification",
      headlineStatistic: "p50 (lower median for even sample counts)",
      runtimeOrder: "alternated for each paired sample",
      size: "extracted executable bytes",
      quick: options.quick,
    },
    sizes,
    performance,
  };
  const outputPath = resolveOutputPath(options);
  const markdownPath = outputPath.replace(/\.[^.]+$/, ".md");
  const markdown = renderReleaseBenchmarkMarkdown(result);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(markdownPath, markdown);
  const terminalReport = renderReleaseBenchmarkTerminal(result);
  process.stdout.write(`\n${process.stdout.isTTY ? terminalReport : markdown}`);
  log(`JSON: ${outputPath}`);
  log(`Markdown: ${markdownPath}`);
}

main().catch(error => {
  console.error(`release benchmark failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
