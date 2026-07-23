#!/usr/bin/env node

import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import os from 'os';
import { delimiter, join, relative, resolve, sep } from 'path';

const rootDir = process.cwd();
const targetsPath = resolve(
  rootDir,
  process.env.COTTONTAIL_UPSTREAM_TARGETS_PATH ?? join('compat', 'upstream', 'targets.json'),
);
let binaryPath = resolve(
  rootDir,
  process.env.COTTONTAIL_UPSTREAM_BINARY ??
    join('zig-out', 'bin', process.platform === 'win32' ? 'cottontail.exe' : 'cottontail'),
);
const pythonPath = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const tempBase = process.env.COTTONTAIL_UPSTREAM_TMPDIR ?? (process.platform === 'darwin' ? '/tmp' : os.tmpdir());
const tempRoot = mkdtempSync(join(tempBase, 'cottontail-upstream-tests-'));
const disabledStatuses = new Set(['disabled', 'skip']);
const directTestTimeoutMs = Number(process.env.COTTONTAIL_UPSTREAM_TEST_TIMEOUT_MS ?? 30000);
const directTestMaxBuffer = Number(process.env.COTTONTAIL_UPSTREAM_TEST_MAX_BUFFER ?? 64 * 1024 * 1024);
const defaultBunJobs = Math.max(1, Math.min(4, os.availableParallelism?.() ?? os.cpus().length));
const binaryPreflightPrefix = 'COTTONTAIL_UPSTREAM_BINARY_PREFLIGHT:';
const binaryPreflightTimeoutMs = 15000;
const defaultNodeSelectorChunkChars = 16 * 1024;
const nodeHarnessInventoryPrefix = 'COTTONTAIL_NODE_HARNESS_INVENTORY:';
const bundlerTestDiscoveryPrefix = 'COTTONTAIL_BUNDLER_TEST_ID:';
const duckDBUpstreamTest = 'test/js/third_party/duckdb/duckdb-basic-usage.test.ts';
const svelteUpstreamTest = 'test/integration/svelte/client-side.test.ts';
const activeChildren = new Set();
const snapshotArtifactRoots = new Map();
const externallyManagedSnapshotRoots = new Set();
const nodeHarnessInventoryCache = new Map();
const bunSnapshotSourceNames = new Set([
  'LICENSE.md',
  'manifest.json',
  'package.json',
  'packages',
  'src',
  'status.json',
  'test',
  'tsconfig.base.json',
]);

function shouldKeepTemp() {
  return process.env.COTTONTAIL_UPSTREAM_KEEP_TEMP === '1' ||
    process.env.COTTONTAIL_KEEP_TEMP !== undefined ||
    process.env.DEBUG === '1';
}

function removeTemp(path) {
  if (shouldKeepTemp()) return;
  try { rmSync(path, { recursive: true, force: true }); } catch {}
}

function removeSnapshotArtifacts(snapshotRoot, runtime) {
  if (externallyManagedSnapshotRoots.has(snapshotRoot)) return;
  const installedDependencies = join(snapshotRoot, 'test', 'node_modules');
  const stack = [snapshotRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    let names;
    try { names = readdirSync(current); } catch { continue; }
    for (const name of names) {
      const path = join(current, name);
      const generated = name === '.cottontail-tmp' ||
        name === '.cottontail-compile-cache' ||
        name.startsWith('.cottontail-eval-') ||
        name.startsWith('.cottontail-compat-') ||
        name === '.verdaccio-db.json' ||
        name.startsWith('fstest') ||
        /^Heap\.\d+\.heapsnapshot$/.test(name) ||
        (current === snapshotRoot && runtime === 'bun' && !bunSnapshotSourceNames.has(name));
      if (generated) {
        try { rmSync(path, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (path === installedDependencies) continue;
      try {
        const stat = lstatSync(path);
        if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(path);
      } catch {}
    }
  }
}

function removeAllSnapshotArtifacts() {
  for (const [snapshotRoot, runtime] of snapshotArtifactRoots) {
    removeSnapshotArtifacts(snapshotRoot, runtime);
  }
}

process.on('exit', () => {
  removeAllSnapshotArtifacts();
  if (shouldKeepTemp()) {
    console.error(`kept upstream temp root: ${tempRoot}`);
    return;
  }
  removeTemp(tempRoot);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of activeChildren) killProcessTree(child);
    removeAllSnapshotArtifacts();
    removeTemp(tempRoot);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function binaryPreflightDetails(result) {
  return [result.stdout, result.stderr]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join('\n');
}

function immutableBinaryEnvironment(overrides = undefined, allowTestPreflightShim = false) {
  const env = { ...process.env };
  // Authoritative upstream runs validate the executable selected by --binary,
  // never preloads, module paths, or a development-only source overlay from
  // the invoking shell.
  delete env.COTTONTAIL_RUNTIME_MODULES_DIR;
  delete env.NODE_OPTIONS;
  delete env.BUN_OPTIONS;
  delete env.NODE_PATH;
  const testPreflightShim = env.COTTONTAIL_UPSTREAM_RUNNER_TEST_NODE_OPTIONS;
  delete env.COTTONTAIL_UPSTREAM_RUNNER_TEST_NODE_OPTIONS;
  if (
    allowTestPreflightShim &&
    env.COTTONTAIL_RUNNER_TEST_CAPTURE &&
    testPreflightShim
  ) {
    env.NODE_OPTIONS = testPreflightShim;
  }
  return { ...env, ...(overrides ?? {}) };
}

function preflightBinary() {
  const source = `
const record = {
  answer: 6 * 7,
  releaseName: globalThis.process?.release?.name,
  cottontailVersion: globalThis.process?.versions?.cottontail,
  productVersion: typeof globalThis.cottontail?.processInfo === "function"
    ? String(globalThis.cottontail.processInfo("version"))
    : null,
  bunVersion: globalThis.Bun?.version,
  processBunVersion: globalThis.process?.versions?.bun,
  bunType: typeof globalThis.Bun,
  cottontailType: typeof globalThis.cottontail,
  revision: globalThis.process?.revision,
  isBun: globalThis.process?.isBun,
  platform: globalThis.process?.platform,
  arch: globalThis.process?.arch,
  runtimeModulesOverride: globalThis.process?.env?.COTTONTAIL_RUNTIME_MODULES_DIR ?? null,
};
console.log(${JSON.stringify(binaryPreflightPrefix)} + JSON.stringify(record));
`;
  const result = spawnSync(binaryPath, ['--eval', source], {
    cwd: rootDir,
    env: {
      ...immutableBinaryEnvironment(undefined, true),
      COTTONTAIL_UPSTREAM_PREFLIGHT: '1',
    },
    encoding: 'utf8',
    timeout: binaryPreflightTimeoutMs,
    maxBuffer: 1024 * 1024,
  });
  const details = binaryPreflightDetails(result);
  if (result.error?.code === 'ETIMEDOUT') {
    fail(`Cottontail binary preflight timed out after ${binaryPreflightTimeoutMs}ms: ${binaryPath}`);
  }
  if (result.error) {
    fail(`Cottontail binary preflight failed to start ${binaryPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail([
      `Cottontail binary preflight exited ${result.status ?? 1}: ${binaryPath}`,
      details,
    ].filter(Boolean).join('\n'));
  }

  const line = String(result.stdout ?? '')
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(binaryPreflightPrefix));
  if (!line) {
    fail([
      `Binary is not a working Cottontail runtime (missing identity record): ${binaryPath}`,
      details,
    ].filter(Boolean).join('\n'));
  }

  let record;
  try {
    record = JSON.parse(line.slice(binaryPreflightPrefix.length));
  } catch (error) {
    fail(`Cottontail binary preflight emitted invalid identity JSON: ${error.message}`);
  }
  const valid = record?.answer === 42 &&
    record.releaseName === 'node' &&
    typeof record.cottontailVersion === 'string' &&
    record.cottontailVersion.length > 0 &&
    record.cottontailVersion === record.productVersion &&
    typeof record.bunVersion === 'string' &&
    record.bunVersion.length > 0 &&
    record.bunVersion === record.processBunVersion &&
    record.bunType === 'object' &&
    record.cottontailType === 'object' &&
    record.revision === 'cottontail' &&
    record.isBun === true &&
    typeof record.platform === 'string' &&
    record.platform.length > 0 &&
    typeof record.arch === 'string' &&
    record.arch.length > 0 &&
    record.runtimeModulesOverride === null;
  if (!valid) {
    fail(
      `Binary is not a working Cottontail runtime (identity mismatch): ${binaryPath}\n` +
      `received: ${JSON.stringify(record)}`
    );
  }
}

function targetSnapshotRoot(runtime, target) {
  const override = process.env[`COTTONTAIL_UPSTREAM_${runtime.toUpperCase()}_SNAPSHOT`];
  const snapshotRoot = resolve(rootDir, override ?? target.snapshot);
  if (override != null) externallyManagedSnapshotRoots.add(snapshotRoot);
  return snapshotRoot;
}

function usage() {
  console.log([
    'Usage: node scripts/run-upstream-tests.js [node|bun|all] [options]',
    '',
    'Options:',
    '  --binary <path>              Use an immutable Cottontail executable for this run.',
    '  --include-expected-failures  Run tests marked expected-failure and require them to fail.',
    '  --case <regexp>              Select generated itBundled case IDs within a split file.',
    '  --jobs <n>                   Bound Bun file, split-case, and in-file test concurrency (default: up to 4).',
    '  --list                       Print status counts and any filtered selection without running tests.',
    '  --max-failures <n>           Stop after this many unexpected results.',
    '  --max-tests <n>              Run at most this many selected tests.',
    '  --match <regexp>             Select tests whose relative path matches.',
    '  --no-serial-retry            Do not retry parallel failures serially (useful for discovery).',
    '  --only-status <status>       Select enabled, expected-failure, or not-enabled tests.',
    '  --test <relative-path>        Run one copied upstream test path.',
    '  --timeout-scale <n>           Scale in-file Bun test deadlines without skipping cases.',
    '',
    'Snapshot overrides:',
    '  COTTONTAIL_UPSTREAM_TARGETS_PATH   Read target metadata from this JSON file.',
    '  COTTONTAIL_UPSTREAM_BUN_SNAPSHOT   Run against an externally managed Bun snapshot.',
    '  COTTONTAIL_UPSTREAM_NODE_SNAPSHOT  Run against an externally managed Node snapshot.',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = [...argv];
  let runtime = 'all';
  if (args[0] && !args[0].startsWith('-')) {
    runtime = args.shift();
  }
  const options = {
    includeExpectedFailures: false,
    list: false,
    maxFailures: Infinity,
    jobs: defaultBunJobs,
    fastXfail: false,
    maxTests: Infinity,
    match: null,
    caseMatch: null,
    binary: null,
    serialRetry: true,
    onlyStatus: null,
    test: null,
    timeoutScale: 1,
  };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--include-expected-failures') {
      options.includeExpectedFailures = true;
    } else if (arg === '--binary') {
      options.binary = args.shift() ?? fail('--binary requires a path');
    } else if (arg === '--case') {
      const value = args.shift() ?? fail('--case requires a regular expression');
      try {
        options.caseMatch = new RegExp(value);
      } catch (error) {
        fail(`invalid --case regular expression: ${error.message}`);
      }
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--max-failures') {
      const value = Number(args.shift() ?? fail('--max-failures requires a number'));
      if (!Number.isFinite(value) || value < 1) fail('--max-failures requires a positive number');
      options.maxFailures = value;
    } else if (arg === '--jobs') {
      const value = Number(args.shift() ?? fail('--jobs requires a number'));
      if (!Number.isFinite(value) || value < 1) fail('--jobs requires a positive number');
      options.jobs = Math.trunc(value);
    } else if (arg === '--fast-xfail') {
      options.fastXfail = true;
    } else if (arg === '--max-tests') {
      const value = Number(args.shift() ?? fail('--max-tests requires a number'));
      if (!Number.isFinite(value) || value < 1) fail('--max-tests requires a positive number');
      options.maxTests = value;
    } else if (arg === '--match') {
      const value = args.shift() ?? fail('--match requires a regular expression');
      try {
        options.match = new RegExp(value);
      } catch (error) {
        fail(`invalid --match regular expression: ${error.message}`);
      }
    } else if (arg === '--no-serial-retry') {
      options.serialRetry = false;
    } else if (arg === '--only-status') {
      const value = args.shift() ?? fail('--only-status requires a status');
      if (!['enabled', 'expected-failure', 'not-enabled'].includes(value)) {
        fail('--only-status must be enabled, expected-failure, or not-enabled');
      }
      options.onlyStatus = value;
    } else if (arg === '--test') {
      options.test = args.shift() ?? fail('--test requires a relative path');
    } else if (arg === '--timeout-scale') {
      const value = Number(args.shift() ?? fail('--timeout-scale requires a number'));
      if (!Number.isFinite(value) || value < 1) fail('--timeout-scale requires a number greater than or equal to 1');
      options.timeoutScale = value;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      fail(`Unknown option: ${arg}`);
    }
  }
  if (!['node', 'bun', 'all'].includes(runtime)) fail(`Unknown upstream runtime: ${runtime}`);
  return { runtime, options };
}

function countFiles(dir) {
  const trackedPath = relative(rootDir, dir);
  if (trackedPath !== '..' && !trackedPath.startsWith(`..${sep}`)) {
    const tracked = spawnSync('git', ['ls-files', '-z', '--', trackedPath], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    if (tracked.status === 0) {
      return tracked.stdout.split('\0').filter(Boolean).length;
    }
  }

  let count = 0;
  const stack = [dir];
  const installedDependencies = join(dir, 'test', 'node_modules');
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (path === installedDependencies) continue;
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(path);
      else count += 1;
    }
  }
  return count;
}

function nodeHarnessInventory(snapshotRoot) {
  const cached = nodeHarnessInventoryCache.get(snapshotRoot);
  if (cached) return cached;

  const source = `
import importlib.util
import json
import os
import sys

snapshot_root = os.path.abspath(sys.argv[1])
tools_root = os.path.join(snapshot_root, "tools")
test_root = os.path.join(snapshot_root, "test")
sys.path.insert(0, tools_root)

spec = importlib.util.spec_from_file_location(
    "cottontail_node_test_tool",
    os.path.join(tools_root, "test.py"),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

suites = sorted(module.GetSuites(test_root))
repositories = [
    module.TestRepository(os.path.join(test_root, suite))
    for suite in suites
]
root = module.LiteralTestSuite(repositories, test_root)
context = module.Context(
    snapshot_root,
    False,
    sys.executable,
    [],
    False,
    120,
    lambda args: args,
    True,
    False,
    1,
    False,
)

records = []
seen = set()
for suite in suites:
    path = module.SplitPath(suite)
    for case in root.ListTests([], path, context, "none", "release"):
        file_path = os.path.abspath(case.file)
        relative_path = os.path.relpath(file_path, snapshot_root).replace(os.sep, "/")
        selector = "/".join(str(part) for part in case.path)
        key = (relative_path, selector)
        if key in seen:
            continue
        seen.add(key)
        records.append({"path": relative_path, "selector": selector})

records.sort(key=lambda record: (record["path"], record["selector"]))
print(${JSON.stringify(nodeHarnessInventoryPrefix)} + json.dumps(records, separators=(",", ":")))
`;
  const result = spawnSync(pythonPath, ['-c', source, snapshotRoot], {
    cwd: snapshotRoot,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
    },
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: directTestMaxBuffer,
  });
  const details = binaryPreflightDetails(result);
  if (result.error?.code === 'ETIMEDOUT') {
    fail(`Node harness inventory timed out after 30000ms: ${snapshotRoot}`);
  }
  if (result.error) {
    fail(`Node harness inventory failed to start ${pythonPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail([
      `Node harness inventory exited ${result.status ?? 1}: ${snapshotRoot}`,
      details,
    ].filter(Boolean).join('\n'));
  }
  const line = String(result.stdout ?? '')
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(nodeHarnessInventoryPrefix));
  if (!line) {
    fail([
      `Node harness inventory did not emit a machine-readable record: ${snapshotRoot}`,
      details,
    ].filter(Boolean).join('\n'));
  }

  let rawRecords;
  try {
    rawRecords = JSON.parse(line.slice(nodeHarnessInventoryPrefix.length));
  } catch (error) {
    fail(`Node harness inventory emitted invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(rawRecords)) {
    fail('Node harness inventory record must be an array.');
  }

  const records = [];
  const selectorByPath = new Map();
  const pathsBySelector = new Map();
  for (const rawRecord of rawRecords) {
    const path = String(rawRecord?.path ?? '').replace(/\\/g, '/');
    const selector = String(rawRecord?.selector ?? '').replace(/\\/g, '/');
    const absolutePath = resolve(snapshotRoot, path);
    const relativePath = relative(snapshotRoot, absolutePath);
    if (!path.startsWith('test/') ||
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`) ||
        !existsSync(absolutePath) ||
        !statSync(absolutePath).isFile() ||
        selector.length === 0) {
      fail(`Node harness inventory emitted an invalid test record: ${JSON.stringify(rawRecord)}`);
    }
    const previousSelector = selectorByPath.get(path);
    if (previousSelector != null && previousSelector !== selector) {
      fail(`Node harness maps ${path} to multiple selectors: ${previousSelector}, ${selector}`);
    }
    if (previousSelector != null) continue;
    selectorByPath.set(path, selector);
    const selectorPaths = pathsBySelector.get(selector) ?? [];
    selectorPaths.push(path);
    pathsBySelector.set(selector, selectorPaths);
    records.push({ path, selector });
  }
  if (records.length === 0) {
    fail(`Node harness inventory is empty: ${snapshotRoot}`);
  }

  const inventory = { records, selectorByPath, pathsBySelector };
  nodeHarnessInventoryCache.set(snapshotRoot, inventory);
  return inventory;
}

function discoverRunnableFiles(snapshotRoot, runtime = 'node') {
  if (runtime === 'node') {
    return nodeHarnessInventory(snapshotRoot).records.map((record) => record.path);
  }
  const testRoot = join(snapshotRoot, 'test');
  const installedDependencies = join(testRoot, 'node_modules');
  if (!existsSync(testRoot)) return [];
  const result = [];
  const stack = [testRoot];
  const runnablePattern = /\.test\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/i;
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (path === installedDependencies) continue;
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        stack.push(path);
      } else if (stat.isFile() && runnablePattern.test(name)) {
        result.push(path.slice(snapshotRoot.length + 1).replace(/\\/g, '/'));
      }
    }
  }
  result.sort();
  return result;
}

function patternEntries(status) {
  return Array.isArray(status.patterns) ? status.patterns : [];
}

function patternStatusForPath(status, path) {
  let matched = null;
  for (const pattern of patternEntries(status)) {
    if (!pattern?.pattern || !pattern?.status) continue;
    if (new RegExp(pattern.pattern).test(path)) matched = pattern;
  }
  return matched;
}

function statusEntryForPath(status, path, defaultStatus = status.defaultStatus ?? 'not-enabled') {
  const patternEntry = patternStatusForPath(status, path);
  return {
    path,
    status: defaultStatus,
    reason: undefined,
    ...(patternEntry ?? {}),
    ...(status.tests?.[path] ?? {}),
  };
}

function assertRunnableStatusSummary(summary) {
  const classifiedTests = summary.enabled + summary.expectedFailure + summary.disabled;
  if (summary.classifiedTests !== classifiedTests) {
    throw new Error(`classified upstream count mismatch: ${summary.classifiedTests} !== ${classifiedTests}`);
  }
  if (summary.discoveredRunnableFiles !== classifiedTests + summary.notEnabled) {
    throw new Error(
      `discovered upstream count mismatch: ${summary.discoveredRunnableFiles} !== ` +
      `${classifiedTests} classified + ${summary.notEnabled} not-enabled`
    );
  }
}

function summarizeRunnableStatuses(entries) {
  const summary = {
    discoveredRunnableFiles: entries.length,
    enabled: 0,
    expectedFailure: 0,
    disabled: 0,
    notEnabled: 0,
    classifiedTests: 0,
  };
  const unknown = [];

  for (const entry of entries) {
    if (entry.status === 'enabled') summary.enabled += 1;
    else if (entry.status === 'expected-failure') summary.expectedFailure += 1;
    else if (disabledStatuses.has(entry.status)) summary.disabled += 1;
    else if (entry.status === 'not-enabled') summary.notEnabled += 1;
    else unknown.push(`${entry.path}: ${String(entry.status)}`);
  }

  if (unknown.length > 0) {
    throw new Error(`unknown upstream test status(es): ${unknown.join(', ')}`);
  }

  summary.classifiedTests = summary.enabled + summary.expectedFailure + summary.disabled;
  assertRunnableStatusSummary(summary);
  return summary;
}

function statusCounts(snapshotRoot, status, runtime = 'node') {
  const entries = discoverRunnableFiles(snapshotRoot, runtime)
    .map((path) => statusEntryForPath(status, path));
  return {
    copiedFiles: existsSync(snapshotRoot) ? countFiles(snapshotRoot) : 0,
    ...summarizeRunnableStatuses(entries),
  };
}

function selectedTests(status, options, snapshotRoot, runtime = 'node') {
  if (options.test) {
    return [{
      ...statusEntryForPath(status, options.test, 'enabled'),
      status: 'enabled',
      reason: status.tests?.[options.test]?.reason ?? 'selected from CLI',
    }];
  }
  let entries;
  const includeExpectedFailures = options.includeExpectedFailures || options.onlyStatus === 'expected-failure';
  const hasEnabledBundlerCases = (entry) =>
    entry.splitBundlerTests === true && Object.keys(entry.enabledBundlerTests ?? {}).length > 0;
  if (status.defaultStatus === 'enabled' || patternEntries(status).length > 0) {
    entries = discoverRunnableFiles(snapshotRoot, runtime)
      .map((path) => statusEntryForPath(status, path, status.defaultStatus === 'enabled' ? 'enabled' : 'not-enabled'))
      .filter((entry) =>
        entry.status === 'enabled' ||
        hasEnabledBundlerCases(entry) ||
        (includeExpectedFailures && entry.status === 'expected-failure') ||
        (options.onlyStatus === 'not-enabled' && entry.status === 'not-enabled')
      );
  } else {
    entries = Object.entries(status.tests ?? {})
      .map(([path, entry]) => ({ path, ...entry }))
      .filter((entry) =>
        entry.status === 'enabled' ||
        hasEnabledBundlerCases(entry) ||
        (includeExpectedFailures && entry.status === 'expected-failure') ||
        (options.onlyStatus === 'not-enabled' && entry.status === 'not-enabled')
      );
  }
  if (options.onlyStatus) {
    entries = entries.filter((entry) =>
      entry.status === options.onlyStatus ||
      (options.onlyStatus === 'enabled' && hasEnabledBundlerCases(entry))
    );
  }
  if (options.match) entries = entries.filter((entry) => options.match.test(entry.path));
  return entries;
}

function makeEnv(runtime, target, runTemp = tempRoot, overrides = undefined) {
  const upstreamNodeModules = runtime === 'bun'
    ? join(targetSnapshotRoot(runtime, target), 'test', 'node_modules')
    : null;
  return {
    ...immutableBinaryEnvironment(),
    ...(runtime === 'bun' ? { TZ: process.env.COTTONTAIL_UPSTREAM_TZ ?? 'Etc/UTC' } : {}),
    ...(upstreamNodeModules ? {
      NODE_PATH: upstreamNodeModules,
    } : {}),
    COTTONTAIL_TMP_DIR: runTemp,
    COTTONTAIL_UPSTREAM_TEMP_OWNER: 'launcher',
    BUN_TMPDIR: runTemp,
    TEST_TMPDIR: runTemp,
    TMPDIR: runTemp,
    TMP: runTemp,
    TEMP: runTemp,
    COTTONTAIL_UPSTREAM_RUNTIME: runtime,
    COTTONTAIL_UPSTREAM_VERSION: target.version,
    COTTONTAIL_REPO_ROOT: rootDir,
    ...(overrides ?? {}),
  };
}

function prepareBunTestDependencies(entries, snapshotRoot) {
  const selected = new Set(entries.map((entry) => entry.path));
  const fixtures = [
    [duckDBUpstreamTest, 'DuckDB', 'setup-upstream-duckdb.js'],
    [svelteUpstreamTest, 'Svelte', 'setup-upstream-svelte.js'],
  ];
  for (const [testPath, name, scriptName] of fixtures) {
    if (!selected.has(testPath)) continue;
    if (externallyManagedSnapshotRoots.has(snapshotRoot)) {
      fail(
        `${name} fixture preparation mutates its Bun snapshot. ` +
        `Copy the snapshot to a writable location and use the configured target instead of ` +
        `COTTONTAIL_UPSTREAM_BUN_SNAPSHOT for ${testPath}.`
      );
    }
    const setupScript = join(rootDir, 'scripts', scriptName);
    const result = spawnSync(process.execPath, [setupScript, '--snapshot', snapshotRoot], {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) fail(`Failed to prepare the ${name} upstream fixture: ${result.error.message}`);
    if (result.status !== 0) fail(`${name} upstream fixture setup exited ${result.status ?? 1}.`);
  }
}

function entryLabel(entry) {
  return entry.variant ? `${entry.path} [${entry.variant}]` : entry.path;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function discoverBundlerTestIds(entry, snapshotRoot, target) {
  const timeout = Number(entry.timeoutMs ?? directTestTimeoutMs);
  const result = spawnSync(binaryPath, [entry.path, ...entryArgs(entry)], {
    cwd: snapshotRoot,
    env: makeEnv('bun', target, tempRoot, {
      ...(entry.env ?? {}),
      BUN_BUNDLER_TEST_FILTER: '',
      COTTONTAIL_BUNDLER_TEST_DISCOVER: '1',
    }),
    encoding: 'utf8',
    timeout,
    maxBuffer: directTestMaxBuffer,
  });
  const ids = [];
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    if (!line.startsWith(bundlerTestDiscoveryPrefix)) continue;
    try {
      const id = JSON.parse(line.slice(bundlerTestDiscoveryPrefix.length));
      if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
    } catch {
      fail(`Invalid itBundled discovery record in ${entry.path}: ${line}`);
    }
  }
  // Mixed files can contain ordinary bun:test cases that fail while the
  // lightweight registration pass still discovers every itBundled ID. Keep
  // those ordinary cases as a separate owned variant instead of making their
  // current result block generated-case isolation.
  if (ids.length === 0) {
    const details = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
    fail(`No itBundled cases discovered in ${entry.path}${details ? `:\n${details}` : ''}`);
  }
  return ids;
}

function expandBunEntries(entries, snapshotRoot, target, options) {
  const expanded = [];
  for (const entry of entries) {
    if (entry.splitBundlerTests !== true) {
      if (options.caseMatch) continue;
      expanded.push(entry);
      continue;
    }
    const ids = discoverBundlerTestIds(entry, snapshotRoot, target)
      .filter(id => !options.caseMatch || options.caseMatch.test(id));
    for (const id of ids) {
      const enabledReason = entry.enabledBundlerTests?.[id];
      const expectedFailureReason = entry.expectedFailureBundlerTests?.[id];
      if (entry.status === 'expected-failure' && entry.enabledBundlerTests != null) {
        if (options.onlyStatus === 'expected-failure' && enabledReason) continue;
        if (!options.includeExpectedFailures && options.onlyStatus !== 'expected-failure' && !enabledReason) continue;
      }
      expanded.push({
        ...entry,
        variant: id,
        args: [
          ...(entry.args ?? []),
          `--test-name-pattern=(?:^| > )${escapeRegExp(id)}$`,
        ],
        ...(enabledReason ? {
          status: 'enabled',
          reason: String(enabledReason),
        } : expectedFailureReason ? {
          status: 'expected-failure',
          reason: String(expectedFailureReason),
        } : {}),
        env: {
          ...(entry.env ?? {}),
          BUN_BUNDLER_TEST_FILTER: id,
          BUN_BUNDLER_TEST_HIDE_SKIP: '1',
        },
      });
    }
    const directId = '$file';
    if (entry.includeBundlerFileTests === true && (!options.caseMatch || options.caseMatch.test(directId))) {
      const enabledReason = entry.enabledBundlerTests?.[directId];
      const expectedFailureReason = entry.expectedFailureBundlerTests?.[directId];
      if (entry.status === 'expected-failure' && entry.enabledBundlerTests != null) {
        if (options.onlyStatus === 'expected-failure' && enabledReason) continue;
        if (!options.includeExpectedFailures && options.onlyStatus !== 'expected-failure' && !enabledReason) continue;
      }
      expanded.push({
        ...entry,
        variant: directId,
        ...(enabledReason ? {
          status: 'enabled',
          reason: String(enabledReason),
        } : expectedFailureReason ? {
          status: 'expected-failure',
          reason: String(expectedFailureReason),
        } : {}),
        env: {
          ...(entry.env ?? {}),
          BUN_BUNDLER_TEST_FILTER: '__cottontail_no_generated_case__',
          BUN_BUNDLER_TEST_HIDE_SKIP: '1',
        },
      });
    }
  }
  if (options.caseMatch && expanded.length === 0) {
    fail(`No generated itBundled case IDs matched ${options.caseMatch}`);
  }
  return expanded;
}

function normalizeNodeEntryPath(entryPath) {
  return String(entryPath).replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function nodeTestSelector(entryPath, snapshotRoot) {
  const path = normalizeNodeEntryPath(entryPath);
  const selector = nodeHarnessInventory(snapshotRoot).selectorByPath.get(path);
  if (selector == null) {
    fail(`Node upstream path is not recognized by tools/test.py: ${entryPath}`);
  }
  return selector;
}

function nodeSelectorsForEntries(entries, snapshotRoot) {
  const inventory = nodeHarnessInventory(snapshotRoot);
  const selectedPaths = new Set(entries.map((entry) => normalizeNodeEntryPath(entry.path)));
  const selectors = [];
  const seenSelectors = new Set();
  for (const entry of entries) {
    const selector = nodeTestSelector(entry.path, snapshotRoot);
    if (seenSelectors.has(selector)) continue;
    seenSelectors.add(selector);
    const missingPaths = inventory.pathsBySelector.get(selector)
      .filter((path) => !selectedPaths.has(path));
    if (missingPaths.length > 0) {
      fail(
        `Node harness selector ${selector} also selects: ${missingPaths.join(', ')}. ` +
        'Select every colliding path together.'
      );
    }
    selectors.push(selector);
  }
  return selectors;
}

function nodeSelectorChunkChars() {
  const value = Number(
    process.env.COTTONTAIL_UPSTREAM_NODE_SELECTOR_CHUNK_CHARS ??
      defaultNodeSelectorChunkChars
  );
  if (!Number.isFinite(value) || value < 1) {
    fail('COTTONTAIL_UPSTREAM_NODE_SELECTOR_CHUNK_CHARS must be a positive number');
  }
  return Math.trunc(value);
}

function chunkNodeSelectors(selectors) {
  const maxChars = nodeSelectorChunkChars();
  const chunks = [];
  let chunk = [];
  let chars = 0;
  for (const selector of selectors) {
    // The payload limit deliberately leaves ample room below Windows'
    // CreateProcess command-line limit for Python, fixed harness arguments,
    // quoting, and absolute executable paths.
    const selectorChars = selector.length + 1;
    if (selectorChars > maxChars) {
      fail(`Node upstream test selector exceeds the safe command-line chunk size: ${selector}`);
    }
    if (chunk.length > 0 && chars + selectorChars > maxChars) {
      chunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push(selector);
    chars += selectorChars;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function runNodeHarness(target, entries, snapshotRoot, expectedFailure = false) {
  const inventory = nodeHarnessInventory(snapshotRoot);
  const selectors = nodeSelectorsForEntries(entries, snapshotRoot);
  const chunks = chunkNodeSelectors(selectors);
  return chunks.map((chunk, index) => {
    const expectedTests = chunk.reduce(
      (total, selector) => total + inventory.pathsBySelector.get(selector).length,
      0,
    );
    const args = ['tools/test.py', '--shell', binaryPath, '-j4', '--report', ...chunk];
    const result = spawnSync(pythonPath, args, {
      cwd: snapshotRoot,
      env: {
        ...makeEnv('node', target),
        PYTHONDONTWRITEBYTECODE: '1',
      },
      encoding: 'utf8',
      maxBuffer: directTestMaxBuffer,
    });
    return { index, selectors: chunk, expectedTests, result, expectedFailure };
  });
}

function runDirect(runtime, target, entry, snapshotRoot) {
  const timeout = Number(entry.timeoutMs ?? directTestTimeoutMs);
  return spawnSync(binaryPath, [entry.path, ...entryArgs(entry)], {
    cwd: snapshotRoot,
    env: makeEnv(runtime, target, tempRoot, entry.env),
    encoding: 'utf8',
    timeout,
    maxBuffer: directTestMaxBuffer,
  });
}

function entryArgs(entry, options = null) {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  if (options?.jobs === 1 && !args.some((arg) => arg === '--max-concurrency' || arg.startsWith('--max-concurrency='))) {
    args.push('--max-concurrency', '1');
  }
  return args;
}


function entryTimeout(entry, options) {
  const base = Number(entry.timeoutMs ?? directTestTimeoutMs);
  if (options?.fastXfail && entry.status === 'expected-failure' && entry.timeoutMs == null) {
    // Confirming a known failure does not need the full budget; a kill still
    // counts as failing. Full budgets remain available without --fast-xfail.
    return Math.min(base, 8000);
  }
  return base;
}

function killProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function runDirectAsync(runtime, target, entry, snapshotRoot, options) {
  const timeout = entryTimeout(entry, options);
  const runTemp = mkdtempSync(join(tempRoot, 'run-'));
  return new Promise((resolveResult) => {
    const child = spawn(binaryPath, [entry.path, ...entryArgs(entry, options)], {
      cwd: snapshotRoot,
      env: makeEnv(runtime, target, runTemp, {
        ...(entry.env ?? {}),
        ...(options.timeoutScale !== 1
          ? { COTTONTAIL_TEST_TIMEOUT_SCALE: String(options.timeoutScale) }
          : {}),
      }),
      detached: process.platform !== 'win32',
    });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeout);
    child.stdout.on('data', (d) => { if (stdout.length < directTestMaxBuffer) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < directTestMaxBuffer) stderr += d; });
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A test owns its process group. Remove any grandchildren it left
      // behind after either a timeout or a normal/failed test exit.
      killProcessTree(child);
      activeChildren.delete(child);
      removeTemp(runTemp);
      resolveResult({
        status: code,
        signal,
        stdout,
        stderr,
        error: timedOut ? Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) : undefined,
      });
    };
    // 'exit' plus a grace beat: orphaned grandchildren can hold stdio pipes
    // open forever, so never wait solely on 'close'.
    child.on('exit', (code, signal) => setTimeout(() => settle(code, signal), 250));
    child.on('close', (code, signal) => settle(code, signal));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      removeTemp(runTemp);
      resolveResult({ status: null, signal: null, stdout: '', stderr: '', error });
    });
  });
}

function classifyResult(runtime, entry, result, options) {
  if (result.error?.code === 'ETIMEDOUT') {
    const shouldFail = entry.status === 'expected-failure';
    const timeout = entryTimeout(entry, options);
    return {
      runtime,
      entry,
      ok: shouldFail,
      unexpected: !shouldFail,
      message: `${shouldFail ? 'xfail' : 'FAIL'} ${runtime} ${entryLabel(entry)} timed out after ${timeout}ms`,
    };
  }
  const spawnError = formatSpawnError(runtime, entry, result);
  if (spawnError) {
    return { runtime, entry, ok: false, unexpected: true, message: spawnError };
  }
  const exitCode = result.status ?? 1;
  const shouldFail = entry.status === 'expected-failure';
  const ok = shouldFail ? exitCode !== 0 : exitCode === 0;
  const execution = runtime === 'bun' ? parseBunTestExecution(result.stderr) : null;
  const executionLabel = execution
    ? ` (${execution.tests} tests, ${execution.assertions} assertions)`
    : '';
  const message = ok
      ? `${shouldFail ? 'xfail' : 'ok'} ${runtime} ${entryLabel(entry)}${executionLabel}`
      : [
        `${shouldFail ? 'XPASS' : 'FAIL'} ${runtime} ${entryLabel(entry)} exited ${exitCode}`,
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
      ].filter(Boolean).join('\n');
  return { runtime, entry, ok, unexpected: !ok, message, execution };
}

async function runBunEntries(runtime, target, entries, options) {
  const snapshotRoot = targetSnapshotRoot(runtime, target);
  entries = expandBunEntries(entries, snapshotRoot, target, options);
  if (options.jobs <= 1) {
    const results = [];
    for (const entry of entries) results.push(await runOneAsync(runtime, target, entry, snapshotRoot, options));
    return results;
  }
  // Load-sensitive files (anything with a timeout override or an explicit
  // serial flag) run alone after the parallel phase.
  const serialIndexes = new Set();
  entries.forEach((entry, index) => {
    if (entry.timeoutMs != null || entry.serial === true) serialIndexes.add(index);
  });
  const results = new Array(entries.length);
  const queue = entries.map((entry, index) => ({ entry, index })).filter(({ index }) => !serialIndexes.has(index));
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const item = queue[cursor++];
      if (!item) return;
      const scriptPath = join(snapshotRoot, item.entry.path);
      if (!existsSync(scriptPath)) {
        results[item.index] = { runtime, entry: item.entry, ok: false, unexpected: true, message: `missing copied upstream test: ${item.entry.path}` };
        continue;
      }
      const raw = await runDirectAsync(runtime, target, item.entry, snapshotRoot, options);
      results[item.index] = classifyResult(runtime, item.entry, raw, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.jobs, queue.length) || 1 }, worker));
  // Anything unexpected in the parallel phase gets one serial retry so load
  // artifacts can never masquerade as real failures.
  if (options.serialRetry) {
    for (let index = 0; index < entries.length; index += 1) {
      if (serialIndexes.has(index)) continue;
      if (results[index]?.unexpected) {
        results[index] = await runOneAsync(runtime, target, entries[index], snapshotRoot, options);
      }
    }
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (serialIndexes.has(index)) {
      results[index] = await runOneAsync(runtime, target, entries[index], snapshotRoot, options);
    }
  }
  return results;
}

async function runOneAsync(runtime, target, entry, snapshotRoot, options) {
  const scriptPath = join(snapshotRoot, entry.path);
  if (!existsSync(scriptPath)) {
    return { runtime, entry, ok: false, unexpected: true, message: `missing copied upstream test: ${entry.path}` };
  }
  const stat = statSync(scriptPath);
  if (!stat.isFile()) {
    return { runtime, entry, ok: false, unexpected: true, message: `not a file: ${entry.path}` };
  }
  const result = await runDirectAsync(runtime, target, entry, snapshotRoot, options);
  return classifyResult(runtime, entry, result, options);
}

function formatSpawnError(runtime, entry, result) {
  if (!result.error) return null;
  return `${runtime} ${entryLabel(entry)} failed to start: ${result.error.message}`;
}

function parseBunTestExecution(stderr) {
  const text = String(stderr ?? '');
  const pattern = /(?:^|\n)\s*(\d+) pass\s*\n(?:\s*\d+ (?:todo|skip)(?:ped)?\s*\n)*\s*(\d+) fail\s*\n(?:\s*\d+ error\s*\n)?(?:\s*(?:\d+ snapshots?, )?(\d+) expect\(\) calls\s*\n)?Ran (\d+) tests? across (\d+) file(?:s)?\./g;
  let execution = null;
  for (const match of text.matchAll(pattern)) {
    execution = {
      passed: Number(match[1]),
      failed: Number(match[2]),
      assertions: Number(match[3] ?? 0),
      tests: Number(match[4]),
      files: Number(match[5]),
    };
  }
  return execution;
}

function parseNodeHarnessReport(stdout) {
  const text = String(stdout ?? '');
  const totalMatches = [...text.matchAll(/^Total:\s+(\d+)\s+tests\s*$/gm)];
  const skippedMatches = [...text.matchAll(/^\s*\*\s+(\d+)\s+tests will be skipped\s*$/gm)];
  if (totalMatches.length !== 1 || skippedMatches.length !== 1) return null;
  return {
    total: Number(totalMatches[0][1]),
    skipped: Number(skippedMatches[0][1]),
  };
}

function runNode(runtime, target, entries, snapshotRoot, options) {
  const enabledEntries = entries.filter((entry) => entry.status !== 'expected-failure');
  const expectedFailureEntries = entries.filter((entry) => entry.status === 'expected-failure');
  const chunks = [
    ...runNodeHarness(target, enabledEntries, snapshotRoot),
    ...expectedFailureEntries.flatMap((entry) =>
      runNodeHarness(target, [entry], snapshotRoot, true)
    ),
  ].map((chunk, index) => ({ ...chunk, index }));
  const unexpectedChunks = [];
  for (const chunk of chunks) {
    const spawnError = formatSpawnError(runtime, { path: 'tools/test.py' }, chunk.result);
    if (spawnError) {
      unexpectedChunks.push({ ...chunk, spawnError });
      continue;
    }
    const report = parseNodeHarnessReport(chunk.result.stdout);
    if (!report) {
      unexpectedChunks.push({
        ...chunk,
        reportError: 'tools/test.py did not emit exactly one parseable --report summary',
      });
      continue;
    }
    if (report.total !== chunk.expectedTests) {
      unexpectedChunks.push({
        ...chunk,
        reportError:
          `tools/test.py matched ${report.total} test(s), expected ${chunk.expectedTests}`,
      });
      continue;
    }
    const exitCode = chunk.result.status ?? 1;
    const allSkipped = report.total > 0 &&
      report.skipped === report.total &&
      /(?:^|\n)No tests to run\.\s*(?:\n|$)/.test(String(chunk.result.stdout ?? ''));
    if (allSkipped && chunk.expectedFailure) {
      unexpectedChunks.push({
        ...chunk,
        reportError: 'expected-failure selector was skipped by tools/test.py',
      });
      continue;
    }
    const chunkOk = allSkipped ||
      (chunk.expectedFailure ? exitCode !== 0 : exitCode === 0);
    if (!chunkOk) unexpectedChunks.push(chunk);
  }
  const ok = unexpectedChunks.length === 0;
  const focused = options.test ||
    options.match ||
    options.onlyStatus ||
    Number.isFinite(options.maxTests);
  const label = options.test
    ? entries[0]?.path ?? 'selected tests'
    : focused
      ? `${entries.length} selected harness path(s) in ${chunks.length} chunk(s)`
      : `${entries.length} enabled harness path(s) in ${chunks.length} chunk(s)`;
  const allExpectedFailure = expectedFailureEntries.length === entries.length;
  const expectationLabel = expectedFailureEntries.length > 0 && !allExpectedFailure
    ? ` (${expectedFailureEntries.length} expected failure(s))`
    : '';
  const failureDetails = unexpectedChunks.map((chunk) => {
    const result = chunk.result;
    const heading =
      `Node harness chunk ${chunk.index + 1}/${chunks.length} ` +
      `(${chunk.selectors.length} selector(s)` +
      `${chunk.expectedFailure ? ', expected failure' : ''})`;
    return [
      heading,
      chunk.spawnError ??
        chunk.reportError ??
        `exited ${result.status ?? 1}${result.signal ? ` (${result.signal})` : ''}`,
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
    ].filter(Boolean).join('\n');
  });
  const message = ok
    ? `${allExpectedFailure ? 'xfail' : 'ok'} ${runtime} ${label}${expectationLabel}`
    : [
        `${allExpectedFailure ? 'XPASS' : 'FAIL'} ${runtime} ${label}${expectationLabel}`,
        ...failureDetails,
      ].filter(Boolean).join('\n');
  return [{ runtime, ok, unexpected: !ok, message }];
}

function runOne(runtime, target, entry) {
  const snapshotRoot = targetSnapshotRoot(runtime, target);
  const scriptPath = join(snapshotRoot, entry.path);
  if (!existsSync(scriptPath)) {
    return { runtime, entry, ok: false, unexpected: true, message: `missing copied upstream test: ${entry.path}` };
  }
  const stat = statSync(scriptPath);
  if (!stat.isFile()) {
    return { runtime, entry, ok: false, unexpected: true, message: `not a file: ${entry.path}` };
  }
  const result = runDirect(runtime, target, entry, snapshotRoot);
  if (result.error?.code === 'ETIMEDOUT') {
    const shouldFail = entry.status === 'expected-failure';
    const timeout = Number(entry.timeoutMs ?? directTestTimeoutMs);
    return {
      runtime,
      entry,
      ok: shouldFail,
      unexpected: !shouldFail,
      message: `${shouldFail ? 'xfail' : 'FAIL'} ${runtime} ${entry.path} timed out after ${timeout}ms`,
    };
  }
  const spawnError = formatSpawnError(runtime, entry, result);
  if (spawnError) {
    return { runtime, entry, ok: false, unexpected: true, message: spawnError };
  }
  const exitCode = result.status ?? 1;
  const shouldFail = entry.status === 'expected-failure';
  const ok = shouldFail ? exitCode !== 0 : exitCode === 0;
  const execution = runtime === 'bun' ? parseBunTestExecution(result.stderr) : null;
  const executionLabel = execution
    ? ` (${execution.tests} tests, ${execution.assertions} assertions)`
    : '';
  const message = ok
    ? `${shouldFail ? 'xfail' : 'ok'} ${runtime} ${entry.path}${executionLabel}`
    : [
        `${shouldFail ? 'XPASS' : 'FAIL'} ${runtime} ${entry.path} exited ${exitCode}`,
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
      ].filter(Boolean).join('\n');
  return { runtime, entry, ok, unexpected: !ok, message, execution };
}

function runtimeTargets(runtime, targets) {
  return runtime === 'all' ? ['node', 'bun'] : [runtime];
}

const { runtime, options } = parseArgs(process.argv.slice(2));
if (options.binary != null) binaryPath = resolve(rootDir, options.binary);
if (!existsSync(targetsPath)) fail(`Missing ${targetsPath}`);
if (!options.list) {
  if (!existsSync(binaryPath)) fail(`Built cottontail binary not found at ${binaryPath}. Run "bun run build" first.`);
  if (statSync(binaryPath).size === 0) fail(`Built cottontail binary is empty at ${binaryPath}. Rebuild after clearing the Zig cache.`);
  preflightBinary();
}

const targets = readJson(targetsPath);
let unexpected = 0;
for (const name of runtimeTargets(runtime, targets)) {
  const target = targets[name];
  if (!target) fail(`Missing upstream target: ${name}`);
  const snapshotRoot = targetSnapshotRoot(name, target);
  snapshotArtifactRoots.set(snapshotRoot, name);
  removeSnapshotArtifacts(snapshotRoot, name);
  const statusPath = join(snapshotRoot, 'status.json');
  const status = readJson(statusPath);
  const counts = statusCounts(snapshotRoot, status, name);
  console.log(`${name} ${target.version} (${target.commit.slice(0, 12)})`);
  console.log(`  copied files: ${counts.copiedFiles}`);
  console.log(`  discovered runnable files: ${counts.discoveredRunnableFiles}`);
  console.log(`  current classified tier: ${counts.enabled}/${counts.classifiedTests} enabled`);
  console.log(`  enabled: ${counts.enabled}`);
  console.log(`  expected-failure: ${counts.expectedFailure}`);
  console.log(`  disabled: ${counts.disabled}`);
  console.log(`  not-enabled: ${counts.notEnabled} (unclassified runnable files)`);
  if (options.list) {
    if (options.test || options.match || options.onlyStatus) {
      const entries = selectedTests(status, options, snapshotRoot, name).slice(0, options.maxTests);
      if (name === 'node' && entries.length > 0) {
        nodeSelectorsForEntries(entries, snapshotRoot);
      }
      console.log(`  selected: ${entries.length}`);
      for (const entry of entries) console.log(`    ${entry.status}\t${entry.path}`);
    }
    continue;
  }

  const entries = selectedTests(status, options, snapshotRoot, name).slice(0, options.maxTests);
  if (entries.length === 0) {
    fail(`No ${name} upstream tests matched the requested selection.`);
  }
  if (name === 'bun') prepareBunTestDependencies(entries, snapshotRoot);
  const results = name === 'node'
    ? runNode(name, target, entries, snapshotRoot, options)
    : await runBunEntries(name, target, entries, options);
  const executionTotals = { tests: 0, assertions: 0, files: 0, filesWithoutSummary: 0 };
  for (const result of results) {
    console.log(result.message);
    if (name === 'bun' && result.ok && result.entry?.status === 'enabled') {
      if (result.execution) {
        executionTotals.tests += result.execution.tests;
        executionTotals.assertions += result.execution.assertions;
        executionTotals.files += 1;
      } else {
        executionTotals.filesWithoutSummary += 1;
      }
    }
    if (result.unexpected) unexpected += 1;
    if (unexpected >= options.maxFailures) break;
  }
  if (name === 'bun' && results.length > 0) {
    console.log(
      `  executed bun:test cases: ${executionTotals.tests}; assertions: ${executionTotals.assertions}; ` +
      `files with summaries: ${executionTotals.files}; files without summaries: ${executionTotals.filesWithoutSummary}`
    );
  }
  if (unexpected >= options.maxFailures) break;
}

if (unexpected > 0) fail(`${unexpected} upstream test result(s) were unexpected.`);
