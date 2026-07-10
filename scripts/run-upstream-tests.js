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

process.on('exit', () => {
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
    test: null,
  };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--include-expected-failures') {
      options.includeExpectedFailures = true;
    } else if (arg === '--list') {
      options.list = true;
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

function statusCounts(snapshotRoot, status) {
  const tests = Object.values(status.tests ?? {});
  const counts = {
    copiedFiles: existsSync(snapshotRoot) ? countFiles(snapshotRoot) : 0,
    enabled: tests.filter((item) => item.status === 'enabled').length,
    expectedFailure: tests.filter((item) => item.status === 'expected-failure').length,
    skipped: tests.filter((item) => item.status === 'skip').length,
  };
  return counts;
}

function selectedTests(status, options) {
  if (options.test) {
    return [{ path: options.test, status: 'enabled', reason: 'selected from CLI' }];
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

function runNodeHarness(target, entry, snapshotRoot) {
  const result = spawnSync(
    pythonPath,
    ['tools/test.py', '--shell', binaryPath, '-j1', nodeTestSelector(entry.path)],
    {
      cwd: snapshotRoot,
      env: makeEnv('node', target),
      encoding: 'utf8',
    }
  );
  return result;
}

function runDirect(runtime, target, entry, snapshotRoot) {
  return spawnSync(binaryPath, [entry.path], {
    cwd: snapshotRoot,
    env: makeEnv(runtime, target),
    encoding: 'utf8',
  });
}

function formatSpawnError(runtime, entry, result) {
  if (!result.error) return null;
  return `${runtime} ${entry.path} failed to start: ${result.error.message}`;
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
  const result = runtime === 'node'
    ? runNodeHarness(target, entry, snapshotRoot)
    : runDirect(runtime, target, entry, snapshotRoot);
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
  const counts = statusCounts(snapshotRoot, status);
  console.log(`${name} ${target.version} (${target.commit.slice(0, 12)})`);
  console.log(`  copied files: ${counts.copiedFiles}`);
  console.log(`  enabled: ${counts.enabled}`);
  console.log(`  expected-failure: ${counts.expectedFailure}`);
  console.log(`  skipped: ${counts.skipped}`);
  if (options.list) continue;

  for (const entry of selectedTests(status, options)) {
    const result = runOne(name, target, entry);
    console.log(result.message);
    if (result.unexpected) unexpected += 1;
  }
}

if (unexpected > 0) fail(`${unexpected} upstream test result(s) were unexpected.`);
