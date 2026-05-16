import { binaryName, fail, fs, path, proc } from './ct-runtime.js';

const rootDir = proc.cwd();
const binaryPath = path.join(rootDir, 'zig-out', 'bin', binaryName('cottontail'));

const benches = [
  {
    name: 'startup-empty',
    scriptPath: path.join(rootDir, 'bench', 'empty.js'),
    iterations: 20,
    warmupRuns: 1,
  },
  {
    name: 'loop',
    scriptPath: path.join(rootDir, 'bench', 'loop.js'),
    iterations: 12,
    warmupRuns: 1,
    expectInternalMetric: true,
  },
  {
    name: 'json',
    scriptPath: path.join(rootDir, 'bench', 'json.js'),
    iterations: 8,
    warmupRuns: 1,
    expectInternalMetric: true,
  },
  {
    name: 'async',
    scriptPath: path.join(rootDir, 'bench', 'async.js'),
    iterations: 8,
    warmupRuns: 1,
    expectInternalMetric: true,
  },
];

function formatNsAsMs(ns) {
  const wholeMs = ns / 1_000_000n;
  const fractionalNs = (ns % 1_000_000n).toString().padStart(6, '0');
  return `${wholeMs}.${fractionalNs}`;
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

function runBenchScript(scriptPath, benchName, expectInternalMetric) {
  const startedAt = cottontail.nanotime();
  const result = proc.spawnSync(binaryPath, [scriptPath], {
    cwd: rootDir,
    stdio: 'pipe',
  });
  const finishedAt = cottontail.nanotime();

  if (result.status !== 0) {
    fail(
      [
        `Benchmark "${benchName}" failed with exit code ${result.status}.`,
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  return {
    wallNs: finishedAt - startedAt,
    internalNs: expectInternalMetric ? parseInternalMetric(result.stdout, benchName) : null,
  };
}

function printSummaryLine(label, values) {
  const summary = summarize(values);
  console.log(
    `${label}: avg ${formatNsAsMs(summary.avg)} ms | p50 ${formatNsAsMs(summary.p50)} ms | min ${formatNsAsMs(summary.min)} ms | max ${formatNsAsMs(summary.max)} ms`
  );
}

if (!fs.existsSync(binaryPath)) {
  fail(`Release binary not found at ${binaryPath}. Run the release build command first.`);
}

console.log('cottontail benchmarks (ReleaseSmall)');
console.log('startup-empty wall time approximates process startup + runtime init + empty script eval');

for (const bench of benches) {
  for (let index = 0; index < bench.warmupRuns; index += 1) {
    runBenchScript(bench.scriptPath, bench.name, !!bench.expectInternalMetric);
  }

  const wallSamples = [];
  const internalSamples = [];

  for (let index = 0; index < bench.iterations; index += 1) {
    const sample = runBenchScript(bench.scriptPath, bench.name, !!bench.expectInternalMetric);
    wallSamples.push(sample.wallNs);

    if (sample.internalNs != null) {
      internalSamples.push(sample.internalNs);
    }
  }

  printSummaryLine(`${bench.name} wall`, wallSamples);

  if (internalSamples.length > 0) {
    printSummaryLine(`${bench.name} internal`, internalSamples);
    const overheadSamples = wallSamples.map((wallNs, index) => wallNs - internalSamples[index]);
    printSummaryLine(`${bench.name} overhead`, overheadSamples);
  }
}
