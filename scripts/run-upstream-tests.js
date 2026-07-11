#!/usr/bin/env node

import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import { join, resolve } from 'path';

const rootDir = process.cwd();
const targetsPath = join(rootDir, 'compat', 'upstream', 'targets.json');
const binaryPath = join(rootDir, 'zig-out', 'bin', process.platform === 'win32' ? 'cottontail.exe' : 'cottontail');
const pythonPath = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const tempRoot = mkdtempSync(join(os.tmpdir(), 'cottontail-upstream-tests-'));
const disabledStatuses = new Set(['disabled', 'skip']);
const directTestTimeoutMs = Number(process.env.COTTONTAIL_UPSTREAM_TEST_TIMEOUT_MS ?? 30000);
const directTestMaxBuffer = Number(process.env.COTTONTAIL_UPSTREAM_TEST_MAX_BUFFER ?? 64 * 1024 * 1024);

process.on('exit', () => {
  if (process.env.COTTONTAIL_UPSTREAM_KEEP_TEMP === '1') {
    console.error(`kept upstream temp root: ${tempRoot}`);
    return;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function usage() {
  console.log([
    'Usage: node scripts/run-upstream-tests.js [node|bun|all] [options]',
    '',
    'Options:',
    '  --include-expected-failures  Run tests marked expected-failure and require them to fail.',
    '  --list                       Print status counts without running tests.',
    '  --max-failures <n>           Stop after this many unexpected results.',
    '  --max-tests <n>              Run at most this many selected tests.',
    '  --test <relative-path>        Run one copied upstream test path.',
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
    maxTests: Infinity,
    test: null,
  };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--include-expected-failures') {
      options.includeExpectedFailures = true;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--max-failures') {
      const value = Number(args.shift() ?? fail('--max-failures requires a number'));
      if (!Number.isFinite(value) || value < 1) fail('--max-failures requires a positive number');
      options.maxFailures = value;
    } else if (arg === '--max-tests') {
      const value = Number(args.shift() ?? fail('--max-tests requires a number'));
      if (!Number.isFinite(value) || value < 1) fail('--max-tests requires a positive number');
      options.maxTests = value;
    } else if (arg === '--test') {
      options.test = args.shift() ?? fail('--test requires a relative path');
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
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(path);
      else count += 1;
    }
  }
  return count;
}

function discoverRunnableFiles(snapshotRoot, runtime = 'node') {
  const testRoot = join(snapshotRoot, 'test');
  if (!existsSync(testRoot)) return [];
  const result = [];
  const stack = [testRoot];
  const runnablePattern = runtime === 'bun'
    ? /\.test\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/i
    : /\.(?:js|mjs|cjs)$/i;
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const path = join(current, name);
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

function statusCounts(snapshotRoot, status, runtime = 'node') {
  const tests = Object.entries(status.tests ?? {});
  const hasPatterns = patternEntries(status).length > 0;
  const discovered = status.defaultStatus === 'enabled' || hasPatterns ? discoverRunnableFiles(snapshotRoot, runtime) : [];
  const discoveredPaths = new Set(discovered);
  const discoveredEntries = discovered.map((path) => statusEntryForPath(status, path));
  const explicitOnlyEntries = tests
    .filter(([path]) => !discoveredPaths.has(path))
    .map(([path, entry]) => ({ path, ...entry }));
  const entries = [...discoveredEntries, ...explicitOnlyEntries];
  const disabled = entries.filter((item) => disabledStatuses.has(item.status)).length;
  const explicitEnabled = entries.filter((item) => item.status === 'enabled').length;
  const counts = {
    copiedFiles: existsSync(snapshotRoot) ? countFiles(snapshotRoot) : 0,
    enabled: explicitEnabled,
    expectedFailure: entries.filter((item) => item.status === 'expected-failure').length,
    disabled,
  };
  return counts;
}

function selectedTests(status, options, snapshotRoot, runtime = 'node') {
  if (options.test) {
    return [{ path: options.test, status: 'enabled', reason: 'selected from CLI' }];
  }
  if (status.defaultStatus === 'enabled' || patternEntries(status).length > 0) {
    return discoverRunnableFiles(snapshotRoot, runtime)
      .map((path) => statusEntryForPath(status, path, status.defaultStatus === 'enabled' ? 'enabled' : 'not-enabled'))
      .filter((entry) =>
        entry.status === 'enabled' ||
        (options.includeExpectedFailures && entry.status === 'expected-failure')
      );
  }
  return Object.entries(status.tests ?? {})
    .map(([path, entry]) => ({ path, ...entry }))
    .filter((entry) =>
      entry.status === 'enabled' ||
      (options.includeExpectedFailures && entry.status === 'expected-failure')
    );
}

function makeEnv(runtime, target) {
  return {
    ...process.env,
    COTTONTAIL_TMP_DIR: tempRoot,
    COTTONTAIL_UPSTREAM_RUNTIME: runtime,
    COTTONTAIL_UPSTREAM_VERSION: target.version,
  };
}

function nodeTestSelector(entryPath) {
  let selector = entryPath.replace(/\\/g, '/');
  if (selector.startsWith('test/')) selector = selector.slice('test/'.length);
  selector = selector.replace(/\.(?:mjs|cjs|js)$/i, '');
  return selector;
}

function nodeSkipSelectors(status) {
  return Object.entries(status.tests ?? {})
    .filter(([, entry]) => disabledStatuses.has(entry.status))
    .map(([path]) => nodeTestSelector(path));
}

function runNodeHarness(target, entries, snapshotRoot, status, options) {
  const selectors = options.test || status.defaultStatus !== 'enabled'
    ? entries.map((entry) => nodeTestSelector(entry.path))
    : [];
  const skipSelectors = options.test ? [] : nodeSkipSelectors(status);
  const args = ['tools/test.py', '--shell', binaryPath, '-j4'];
  if (skipSelectors.length > 0) args.push('--skip-tests', skipSelectors.join(','));
  args.push(...selectors);
  const result = spawnSync(
    pythonPath,
    args,
    {
      cwd: snapshotRoot,
      env: makeEnv('node', target),
      encoding: 'utf8',
      maxBuffer: directTestMaxBuffer,
    }
  );
  return result;
}

function runDirect(runtime, target, entry, snapshotRoot) {
  return spawnSync(binaryPath, [entry.path], {
    cwd: snapshotRoot,
    env: makeEnv(runtime, target),
    encoding: 'utf8',
    timeout: directTestTimeoutMs,
    maxBuffer: directTestMaxBuffer,
  });
}

function formatSpawnError(runtime, entry, result) {
  if (!result.error) return null;
  return `${runtime} ${entry.path} failed to start: ${result.error.message}`;
}

function runNode(runtime, target, status, entries, snapshotRoot, options) {
  const result = runNodeHarness(target, entries, snapshotRoot, status, options);
  const spawnError = formatSpawnError(runtime, { path: 'tools/test.py' }, result);
  if (spawnError) {
    return [{ runtime, ok: false, unexpected: true, message: spawnError }];
  }

  const exitCode = result.status ?? 1;
  const shouldFail = entries.length > 0 && entries.every((entry) => entry.status === 'expected-failure');
  const ok = shouldFail ? exitCode !== 0 : exitCode === 0;
  const label = options.test
    ? entries[0]?.path ?? 'selected tests'
    : status.defaultStatus === 'enabled'
      ? 'all enabled harness tests'
      : `${entries.length} enabled harness test(s)`;
  const message = ok
    ? `${shouldFail ? 'xfail' : 'ok'} ${runtime} ${label}`
    : [
        `${shouldFail ? 'XPASS' : 'FAIL'} ${runtime} ${label} exited ${exitCode}`,
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
      ].filter(Boolean).join('\n');
  return [{ runtime, ok, unexpected: !ok, message }];
}

function runOne(runtime, target, entry) {
  const snapshotRoot = resolve(rootDir, target.snapshot);
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
    return {
      runtime,
      entry,
      ok: shouldFail,
      unexpected: !shouldFail,
      message: `${shouldFail ? 'xfail' : 'FAIL'} ${runtime} ${entry.path} timed out after ${directTestTimeoutMs}ms`,
    };
  }
  const spawnError = formatSpawnError(runtime, entry, result);
  if (spawnError) {
    return { runtime, entry, ok: false, unexpected: true, message: spawnError };
  }
  const exitCode = result.status ?? 1;
  const shouldFail = entry.status === 'expected-failure';
  const ok = shouldFail ? exitCode !== 0 : exitCode === 0;
  const message = ok
    ? `${shouldFail ? 'xfail' : 'ok'} ${runtime} ${entry.path}`
    : [
        `${shouldFail ? 'XPASS' : 'FAIL'} ${runtime} ${entry.path} exited ${exitCode}`,
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
      ].filter(Boolean).join('\n');
  return { runtime, entry, ok, unexpected: !ok, message };
}

function runtimeTargets(runtime, targets) {
  return runtime === 'all' ? ['node', 'bun'] : [runtime];
}

const { runtime, options } = parseArgs(process.argv.slice(2));
if (!existsSync(targetsPath)) fail(`Missing ${targetsPath}`);
if (!options.list && !existsSync(binaryPath)) fail(`Built cottontail binary not found at ${binaryPath}. Run "bun run build" first.`);

const targets = readJson(targetsPath);
let unexpected = 0;
for (const name of runtimeTargets(runtime, targets)) {
  const target = targets[name];
  if (!target) fail(`Missing upstream target: ${name}`);
  const snapshotRoot = resolve(rootDir, target.snapshot);
  const statusPath = join(snapshotRoot, 'status.json');
  const status = readJson(statusPath);
  const counts = statusCounts(snapshotRoot, status, name);
  console.log(`${name} ${target.version} (${target.commit.slice(0, 12)})`);
  console.log(`  copied files: ${counts.copiedFiles}`);
  console.log(`  enabled: ${counts.enabled}`);
  console.log(`  expected-failure: ${counts.expectedFailure}`);
  console.log(`  disabled: ${counts.disabled}`);
  if (options.list) continue;

  const entries = selectedTests(status, options, snapshotRoot, name).slice(0, options.maxTests);
  const results = name === 'node'
    ? runNode(name, target, status, entries, snapshotRoot, options)
    : entries.map((entry) => runOne(name, target, entry));
  for (const result of results) {
    console.log(result.message);
    if (result.unexpected) unexpected += 1;
    if (unexpected >= options.maxFailures) break;
  }
  if (unexpected >= options.maxFailures) break;
}

if (unexpected > 0) fail(`${unexpected} upstream test result(s) were unexpected.`);
