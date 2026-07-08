#!/usr/bin/env node

import { copyFileSync, existsSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';

const rootDir = process.cwd();
const zigBinaryName = process.platform === 'win32' ? 'zig.exe' : 'zig';
const cottontailBinaryName = process.platform === 'win32' ? 'cottontail.exe' : 'cottontail';
const zigPath = join(rootDir, 'vendors', 'zig', zigBinaryName);
const buildBinaryPath = join(rootDir, 'zig-out', 'bin', cottontailBinaryName);

const engines = ['quickjs', 'jsc'];
const benches = [
  {
    name: 'startup-empty',
    scriptPath: join(rootDir, 'bench', 'empty.js'),
    iterations: 20,
    warmupRuns: 2,
  },
  {
    name: 'loop',
    scriptPath: join(rootDir, 'bench', 'loop.js'),
    iterations: 16,
    warmupRuns: 2,
    expectInternalMetric: true,
  },
  {
    name: 'json',
    scriptPath: join(rootDir, 'bench', 'json.js'),
    iterations: 12,
    warmupRuns: 2,
    expectInternalMetric: true,
  },
  {
    name: 'async',
    scriptPath: join(rootDir, 'bench', 'async.js'),
    iterations: 12,
    warmupRuns: 2,
    expectInternalMetric: true,
  },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    ...options,
  });

  if (result.error) {
    fail(`Failed to run ${command} ${args.join(' ')}: ${result.error.message}`);
  }

  if ((result.status ?? 1) !== 0) {
    fail(
      [
        `Command failed: ${command} ${args.join(' ')}`,
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  return result;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatNsAsMs(ns) {
  const wholeMs = ns / 1_000_000n;
  const fractionalNs = (ns % 1_000_000n).toString().padStart(6, '0');
  return `${wholeMs}.${fractionalNs}`;
}

function formatRatio(numerator, denominator) {
  if (denominator === 0n) return 'n/a';
  return `${(Number(numerator) / Number(denominator)).toFixed(2)}x`;
}

function sum(values) {
  let total = 0n;
  for (const value of values) {
    total += value;
  }
  return total;
}

function percentile(sortedValues, fraction) {
  const index = Math.floor((sortedValues.length - 1) * fraction);
  return sortedValues[index];
}

function summarize(values) {
  const sortedValues = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    min: sortedValues[0],
    p50: percentile(sortedValues, 0.5),
    avg: sum(sortedValues) / BigInt(sortedValues.length),
    max: sortedValues[sortedValues.length - 1],
  };
}

function parseInternalMetric(stdout, benchName) {
  const match = stdout.match(/__bench_internal_ns__=(\d+)/);
  if (!match) {
    fail(`Benchmark "${benchName}" did not emit __bench_internal_ns__ output.`);
  }
  return BigInt(match[1]);
}

function buildEngine(engine) {
  console.log(`building ${engine} ReleaseSmall...`);
  run(zigPath, ['build', '-Doptimize=ReleaseSmall', `-Dengine=${engine}`], { stdio: 'inherit' });

  if (!existsSync(buildBinaryPath)) {
    fail(`Build did not produce ${buildBinaryPath}`);
  }

  const outputPath = join(
    rootDir,
    'zig-out',
    'bin',
    process.platform === 'win32' ? `cottontail-${engine}.exe` : `cottontail-${engine}`
  );
  copyFileSync(buildBinaryPath, outputPath);
  return {
    engine,
    path: outputPath,
    sizeBytes: statSync(outputPath).size,
  };
}

function runBenchScript(binaryPath, bench) {
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(binaryPath, [bench.scriptPath], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 30000,
  });
  const finishedAt = process.hrtime.bigint();

  if (result.error) {
    fail(`Failed to execute ${bench.name} with ${binaryPath}: ${result.error.message}`);
  }

  if ((result.status ?? 1) !== 0) {
    fail(
      [
        `Benchmark "${bench.name}" failed for ${binaryPath} with exit code ${result.status ?? 1}.`,
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  return {
    wallNs: finishedAt - startedAt,
    internalNs: bench.expectInternalMetric ? parseInternalMetric(result.stdout, bench.name) : null,
  };
}

function runBenchmarks(binary) {
  const results = new Map();

  for (const bench of benches) {
    for (let index = 0; index < bench.warmupRuns; index += 1) {
      runBenchScript(binary.path, bench);
    }

    const wallSamples = [];
    const internalSamples = [];
    for (let index = 0; index < bench.iterations; index += 1) {
      const sample = runBenchScript(binary.path, bench);
      wallSamples.push(sample.wallNs);
      if (sample.internalNs != null) internalSamples.push(sample.internalNs);
    }

    const wall = summarize(wallSamples);
    const internal = internalSamples.length > 0 ? summarize(internalSamples) : null;
    const overhead = internal
      ? summarize(wallSamples.map((wallNs, index) => wallNs - internalSamples[index]))
      : null;

    results.set(bench.name, { wall, internal, overhead });
  }

  return results;
}

function printTable(rows, columns) {
  const widths = columns.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => String(column.value(row)).length))
  );
  console.log(columns.map((column, index) => column.header.padEnd(widths[index])).join('  '));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(columns.map((column, index) => String(column.value(row)).padEnd(widths[index])).join('  '));
  }
}

if (process.platform !== 'darwin') {
  fail('The JSC backend is currently wired for macOS only, so engine comparison must run on macOS.');
}

if (!existsSync(zigPath)) {
  fail(`Vendored Zig compiler not found at ${zigPath}. Run setup first.`);
}

const binaries = engines.map(buildEngine);
const benchmarkResults = new Map();
for (const binary of binaries) {
  console.log(`benchmarking ${binary.engine}...`);
  benchmarkResults.set(binary.engine, runBenchmarks(binary));
}

console.log('\nBinary size (ReleaseSmall)');
printTable(
  binaries,
  [
    { header: 'engine', value: (row) => row.engine },
    { header: 'size', value: (row) => formatBytes(row.sizeBytes) },
    { header: 'bytes', value: (row) => String(row.sizeBytes) },
    { header: 'binary', value: (row) => row.path.replace(`${rootDir}/`, '') },
  ]
);

console.log('\nPerformance (avg ms; quickjs/jsc > 1 means JSC is faster)');
const rows = benches.map((bench) => {
  const quickjs = benchmarkResults.get('quickjs').get(bench.name);
  const jsc = benchmarkResults.get('jsc').get(bench.name);
  return {
    name: bench.name,
    quickjsWall: quickjs.wall.avg,
    jscWall: jsc.wall.avg,
    wallRatio: formatRatio(quickjs.wall.avg, jsc.wall.avg),
    quickjsInternal: quickjs.internal?.avg ?? null,
    jscInternal: jsc.internal?.avg ?? null,
    internalRatio: quickjs.internal && jsc.internal ? formatRatio(quickjs.internal.avg, jsc.internal.avg) : 'n/a',
  };
});

printTable(
  rows,
  [
    { header: 'bench', value: (row) => row.name },
    { header: 'quickjs wall', value: (row) => formatNsAsMs(row.quickjsWall) },
    { header: 'jsc wall', value: (row) => formatNsAsMs(row.jscWall) },
    { header: 'wall speedup', value: (row) => row.wallRatio },
    { header: 'quickjs internal', value: (row) => (row.quickjsInternal == null ? '-' : formatNsAsMs(row.quickjsInternal)) },
    { header: 'jsc internal', value: (row) => (row.jscInternal == null ? '-' : formatNsAsMs(row.jscInternal)) },
    { header: 'internal speedup', value: (row) => row.internalRatio },
  ]
);

console.log('\nNote: JSC binary size excludes the macOS JavaScriptCore framework it dynamically links.');
