#!/usr/bin/env node

import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'fs';
import { spawn, spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import os from 'os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

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
let hutchPath = null;
let binarySourcePath = null;
let binarySourceHash = null;
let hutchSourcePath = null;
let hutchSourceHash = null;
const pythonPath = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const tempBase = process.env.COTTONTAIL_UPSTREAM_TMPDIR ?? (process.platform === 'darwin' ? '/tmp' : os.tmpdir());
const tempRoot = mkdtempSync(join(tempBase, 'cottontail-upstream-tests-'));
let shortTempRoot = null;
const baselineStateRoot = resolve(
  rootDir,
  process.env.COTTONTAIL_BASELINE_STATE_DIR ??
    join('.cottontail-local-tools', 'javascript-baseline')
);
const disabledStatuses = new Set(['disabled', 'skip']);
const directTestTimeoutMs = Number(process.env.COTTONTAIL_UPSTREAM_TEST_TIMEOUT_MS ?? 30000);
const directTestMaxBuffer = Number(process.env.COTTONTAIL_UPSTREAM_TEST_MAX_BUFFER ?? 64 * 1024 * 1024);
const processTerminationGraceMs = 5000;
const defaultBunJobs = Math.max(1, Math.min(4, os.availableParallelism?.() ?? os.cpus().length));
const binaryPreflightPrefix = 'COTTONTAIL_UPSTREAM_BINARY_PREFLIGHT:';
const hutchPreflightPrefix = 'COTTONTAIL_HUTCH_ENGINE_PREFLIGHT:';
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
const snapshotFileBaselines = new Map();
let exclusiveRunLock = null;
let preserveRunLockOnExit = false;
let skipSnapshotCleanupOnExit = false;
let skipTempCleanupOnExit = false;
let signalShutdownStarted = false;
const bunMutableSnapshotFiles = [
  'packages/bun-plugin-svelte/bun.lock',
  'test/napi/napi-app/bun.lock',
];
const bunGeneratedSnapshotPaths = [
  'test/js/third_party/astro/fixtures/.astro',
  'test/js/third_party/astro/fixtures/dist',
];

function shouldKeepTemp() {
  return process.env.COTTONTAIL_UPSTREAM_KEEP_TEMP === '1' ||
    process.env.COTTONTAIL_KEEP_TEMP !== undefined ||
    process.env.DEBUG === '1';
}

function removeTemp(path) {
  if (shouldKeepTemp()) return;
  try { rmSync(path, { recursive: true, force: true }); } catch {}
}

function createShortTempRoot() {
  const bases = process.platform === 'win32'
    ? [
        process.env.SystemRoot && isAbsolute(process.env.SystemRoot)
          ? join(process.env.SystemRoot, 'Temp')
          : null,
        join(parse(resolve(os.tmpdir())).root, 'Temp'),
      ]
    : ['/tmp'];
  let lastError = null;
  for (const base of [...new Set(bases.filter(Boolean))]) {
    try {
      mkdirSync(base, { recursive: true });
      return mkdtempSync(join(base, 'ct-'));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('No short platform temporary directory is available.');
}

function captureSnapshotFileBaselines(snapshotRoot, runtime) {
  if (runtime !== 'bun' || snapshotFileBaselines.has(snapshotRoot)) return;
  const baselines = new Map();
  for (const relativePath of bunMutableSnapshotFiles) {
    const path = join(snapshotRoot, relativePath);
    baselines.set(relativePath, existsSync(path) ? readFileSync(path) : null);
  }
  snapshotFileBaselines.set(snapshotRoot, baselines);
}

function restoreSnapshotFileBaselines(snapshotRoot, runtime) {
  if (runtime !== 'bun') return;
  const baselines = snapshotFileBaselines.get(snapshotRoot);
  if (!baselines) return;
  for (const [relativePath, contents] of baselines) {
    const path = join(snapshotRoot, relativePath);
    if (contents == null) rmSync(path, { force: true });
    else writeFileSync(path, contents);
  }
}

function removeSnapshotArtifacts(snapshotRoot, runtime) {
  if (externallyManagedSnapshotRoots.has(snapshotRoot)) return;
  restoreSnapshotFileBaselines(snapshotRoot, runtime);
  if (runtime === 'bun') {
    for (const relativePath of bunGeneratedSnapshotPaths) {
      try { rmSync(join(snapshotRoot, relativePath), { recursive: true, force: true }); } catch {}
    }
  }
  const testRoot = join(snapshotRoot, 'test');
  const installedDependencies = join(snapshotRoot, 'test', 'node_modules');
  const stack = [snapshotRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    let names;
    try { names = readdirSync(current); } catch { continue; }
    for (const name of names) {
      const path = join(current, name);
      // Node's own tests use .tmp.<thread-id> directories, and the copied
      // snapshot contains tracked fixtures under that naming scheme. They are
      // neither source tests nor safe cleanup targets.
      if (runtime === 'node' && current === testRoot && /^\.tmp\.\d+$/.test(name)) continue;
      const generated = name === '.cottontail-tmp' ||
        name === '.cottontail-compile-cache' ||
        name.startsWith('.cottontail-eval-') ||
        name.startsWith('.cottontail-compat-') ||
        name === '.verdaccio-db.json' ||
        name.startsWith('fstest') ||
        /^Heap\.\d+\.heapsnapshot$/.test(name);
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

function validateSnapshotRoot(runtime, target, snapshotRoot) {
  if (!existsSync(snapshotRoot)) {
    fail(`Missing ${runtime} JavaScript baseline snapshot: ${snapshotRoot}`);
  }
  const rootStat = lstatSync(snapshotRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(`JavaScript baseline snapshot must be a real directory, not a symlink: ${snapshotRoot}`);
  }
  const canonicalRoot = realpathSync(snapshotRoot);
  const canonicalRepo = realpathSync(rootDir);
  if (canonicalRoot === canonicalRepo || dirname(canonicalRoot) === canonicalRoot) {
    fail(`Refusing unsafe JavaScript baseline snapshot root: ${snapshotRoot}`);
  }

  const manifestPath = join(canonicalRoot, 'manifest.json');
  const statusPath = join(canonicalRoot, 'status.json');
  const testPath = join(canonicalRoot, 'test');
  for (const [label, path, directory] of [
    ['manifest', manifestPath, false],
    ['status', statusPath, false],
    ['test directory', testPath, true],
  ]) {
    if (!existsSync(path)) fail(`JavaScript baseline snapshot is missing ${label}: ${path}`);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
      fail(`JavaScript baseline snapshot has an invalid ${label}: ${path}`);
    }
  }
  const manifest = readJson(manifestPath);
  if (
    manifest?.runtime !== runtime ||
    manifest?.version !== target.version ||
    manifest?.commit !== target.commit
  ) {
    fail(
      `JavaScript baseline snapshot manifest does not match ${runtime} ` +
      `${target.version} (${target.commit}): ${manifestPath}`
    );
  }
  if (runtime === 'node') {
    const harnessPath = join(canonicalRoot, 'tools', 'test.py');
    if (!existsSync(harnessPath) || !statSync(harnessPath).isFile()) {
      fail(`Node JavaScript baseline snapshot is missing tools/test.py: ${harnessPath}`);
    }
  }
  return canonicalRoot;
}

function removeAllSnapshotArtifacts() {
  for (const [snapshotRoot, runtime] of snapshotArtifactRoots) {
    removeSnapshotArtifacts(snapshotRoot, runtime);
  }
}

process.on('exit', () => {
  const liveChildren = [...activeChildren]
    .map((child) => child.pid)
    .filter(processGroupIsRunning);
  if (liveChildren.length > 0) {
    skipSnapshotCleanupOnExit = true;
    skipTempCleanupOnExit = true;
    preserveRunLockOnExit = true;
    console.error(
      `Test process group(s) ${liveChildren.join(', ')} were still live at runner exit; ` +
      'snapshot cleanup was skipped and the recoverable lock was retained.'
    );
  }
  if (exclusiveRunLock != null && !skipSnapshotCleanupOnExit) removeAllSnapshotArtifacts();
  if (shouldKeepTemp() || skipTempCleanupOnExit) {
    console.error(`kept JavaScript baseline suite temp root: ${tempRoot}`);
    if (shortTempRoot != null) {
      console.error(`kept JavaScript baseline suite short temp root: ${shortTempRoot}`);
    }
  } else {
    removeTemp(tempRoot);
    if (shortTempRoot != null) removeTemp(shortTempRoot);
  }
  if (!preserveRunLockOnExit) releaseExclusiveRunLock();
});

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (signalShutdownStarted) return;
    signalShutdownStarted = true;
    const children = [...activeChildren];
    for (const child of children) killProcessTree(child);
    const deadline = Date.now() + 5000;
    while (
      children.some((child) => processGroupIsRunning(child.pid)) &&
      Date.now() < deadline
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    const liveGroups = children
      .map((child) => child.pid)
      .filter(processGroupIsRunning);
    if (liveGroups.length > 0) {
      skipSnapshotCleanupOnExit = true;
      skipTempCleanupOnExit = true;
      preserveRunLockOnExit = true;
      console.error(
        `Could not prove test process group(s) ${liveGroups.join(', ')} stopped; ` +
        'snapshot cleanup was skipped and the recoverable lock was retained.'
      );
    }
    process.exit(signal === 'SIGHUP' ? 129 : signal === 'SIGINT' ? 130 : 143);
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

const scrubbedEnvironmentKeys = new Set([
    'BUN_OPTIONS',
    'COTTONTAIL_BINARY',
    'COTTONTAIL_RUNTIME_MODULES_DIR',
    'COTTONTAIL_SPAWN_ARGV0',
    'COTTONTAIL_SPAWN_EXEC_PATH',
    'COTTONTAIL_UPSTREAM_RUNNER_TEST_NODE_OPTIONS',
    'DASH_COTTONTAIL',
    'DYLD_FALLBACK_FRAMEWORK_PATH',
    'DYLD_FALLBACK_LIBRARY_PATH',
    'DYLD_FRAMEWORK_PATH',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'HUTCH_ACTIVE_CHANNEL',
    'HUTCH_LAUNCHER_PATH',
    'HUTCH_LAUNCHER_VERSION',
    'LD_LIBRARY_PATH',
    'LD_PRELOAD',
    'NODE_OPTIONS',
    'NODE_PATH',
    'PYTHONHOME',
    'PYTHONPATH',
  ]);

function scrubEnvironment(environment) {
  const env = environment;
  for (const key of Object.keys(env)) {
    if (isUnsafeEnvironmentKey(key)) delete env[key];
  }
  return env;
}

function isUnsafeEnvironmentKey(key) {
  const upper = key.toUpperCase();
  return scrubbedEnvironmentKeys.has(upper) ||
    upper.startsWith('DYLD_') ||
    upper.startsWith('LD_');
}

function safeEnvironmentOverrides(overrides) {
  const safe = { ...(overrides ?? {}) };
  const unsafe = Object.keys(safe).filter(isUnsafeEnvironmentKey);
  if (unsafe.length > 0) {
    fail(
      `JavaScript baseline test metadata cannot override loader or runtime routing ` +
      `environment variable(s): ${unsafe.join(', ')}`
    );
  }
  return safe;
}

function immutableBinaryEnvironment(overrides = undefined) {
  // Authoritative upstream runs validate the executable selected by --binary,
  // never preloads, module paths, or a development-only source overlay from
  // the invoking shell. Explicit per-test metadata cannot reintroduce these
  // code-selection variables either.
  return {
    ...scrubEnvironment({ ...process.env }),
    ...safeEnvironmentOverrides(overrides),
  };
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashFile(path) {
  return hashBytes(readFileSync(path));
}

function snapshotSourceHash(snapshotRoot) {
  const canonicalRoot = realpathSync(snapshotRoot);
  const relativeRoot = relative(rootDir, canonicalRoot);
  let relativePaths = null;
  if (relativeRoot !== '..' && !relativeRoot.startsWith(`..${sep}`)) {
    const listed = spawnSync(
      'git',
      ['ls-files', '-z', '--cached', '--', relativeRoot],
      { cwd: rootDir, encoding: 'utf8', maxBuffer: directTestMaxBuffer },
    );
    if (listed.status === 0) {
      relativePaths = listed.stdout
        .split('\0')
        .filter(Boolean)
        .map((path) => relative(relativeRoot, path).replace(/\\/g, '/'));
    }
  }

  if (relativePaths == null) {
    relativePaths = [];
    const installedDependencies = join(canonicalRoot, 'test', 'node_modules');
    const stack = [canonicalRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const name of readdirSync(current)) {
        const path = join(current, name);
        if (path === installedDependencies || name === '.git') continue;
        const stat = lstatSync(path);
        if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(path);
        else relativePaths.push(relative(canonicalRoot, path).replace(/\\/g, '/'));
      }
    }
  }

  relativePaths.sort();
  const hash = createHash('sha256');
  for (const relativePath of relativePaths) {
    const path = join(canonicalRoot, relativePath);
    const stat = lstatSync(path);
    hash.update(relativePath);
    hash.update('\0');
    if (stat.isSymbolicLink()) {
      hash.update('symlink\0');
      hash.update(readlinkSync(path));
    } else if (stat.isFile()) {
      hash.update(`file:${stat.mode & 0o777}\0`);
      hash.update(readFileSync(path));
    } else {
      hash.update('other\0');
    }
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), files: relativePaths.length };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value != null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return hashBytes(canonicalJson(value));
}

function pinExecutable(sourcePath, label) {
  const canonicalSource = realpathSync(sourcePath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sourceHash = hashFile(canonicalSource);
    const pinDir = join(baselineStateRoot, 'tools', sourceHash);
    const pinnedPath = join(pinDir, basename(canonicalSource));
    mkdirSync(pinDir, { recursive: true });
    if (!existsSync(pinnedPath)) {
      const temporaryPath = join(pinDir, `${basename(canonicalSource)}.${randomUUID()}.tmp`);
      copyFileSync(canonicalSource, temporaryPath);
      chmodSync(temporaryPath, statSync(canonicalSource).mode & 0o777);
      const copiedHash = hashFile(temporaryPath);
      const stableSourceHash = hashFile(canonicalSource);
      if (copiedHash !== sourceHash || stableSourceHash !== sourceHash) {
        rmSync(temporaryPath, { force: true });
        continue;
      }
      try {
        renameSync(temporaryPath, pinnedPath);
      } catch (error) {
        rmSync(temporaryPath, { force: true });
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    if (hashFile(pinnedPath) !== sourceHash) {
      fail(`Pinned ${label} hash mismatch: ${pinnedPath}`);
    }
    return { sourcePath: canonicalSource, sourceHash, pinnedPath };
  }
  fail(`${label} changed while it was being pinned; rebuilds must not overlap a baseline run.`);
}

function pinSelectedExecutables() {
  const binary = pinExecutable(binaryPath, 'Cottontail binary');
  binarySourcePath = binary.sourcePath;
  binarySourceHash = binary.sourceHash;
  binaryPath = binary.pinnedPath;
  if (hutchPath != null) {
    const hutch = pinExecutable(hutchPath, 'Hutch engine');
    hutchSourcePath = hutch.sourcePath;
    hutchSourceHash = hutch.sourceHash;
    hutchPath = hutch.pinnedPath;
  }
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function processGroupIsRunning(pid) {
  if (process.platform === 'win32') return processIsRunning(pid);
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function terminateTrackedChild(child) {
  killProcessTree(child);
  const deadline = Date.now() + processTerminationGraceMs;
  while (processGroupIsRunning(child.pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  if (processGroupIsRunning(child.pid)) {
    skipSnapshotCleanupOnExit = true;
    skipTempCleanupOnExit = true;
    preserveRunLockOnExit = true;
    return false;
  }
  activeChildren.delete(child);
  updateExclusiveRunLockChildren();
  return true;
}

function writeLockOwner(lockPath, token, owner) {
  const temporaryPath = join(lockPath, `owner.${token}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(owner, null, 2)}\n`);
  renameSync(temporaryPath, join(lockPath, 'owner.json'));
}

function updateExclusiveRunLockChildren() {
  if (exclusiveRunLock == null) return;
  const activeChildPids = [...activeChildren]
    .map((child) => child.pid)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  for (const lockPath of exclusiveRunLock.paths) {
    const ownerPath = join(lockPath, 'owner.json');
    let current;
    try { current = readJson(ownerPath); } catch { continue; }
    if (current?.token !== exclusiveRunLock.token) continue;
    writeLockOwner(lockPath, exclusiveRunLock.token, {
      ...current,
      activeChildren: activeChildPids,
      updatedAt: new Date().toISOString(),
    });
  }
}

function acquireExclusiveRunLock(runtime, targets) {
  const selectedTargets = runtimeTargets(runtime, targets).map((name) => {
    const target = targets[name];
    if (!target) fail(`Missing upstream target: ${name}`);
    return { name, snapshot: realpathSync(targetSnapshotRoot(name, target)) };
  });
  const lockParent = resolve(
    process.env.COTTONTAIL_BASELINE_LOCK_DIR ??
      join(os.tmpdir(), 'cottontail-javascript-baseline-locks')
  );
  mkdirSync(lockParent, { recursive: true });
  const token = randomUUID();
  exclusiveRunLock = { token, paths: [] };
  const scopes = [
    { kind: 'repository', path: realpathSync(rootDir) },
    ...selectedTargets.map((target) => ({ kind: 'snapshot', path: target.snapshot })),
  ].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));

  for (const scope of scopes) {
    const lockPath = join(lockParent, `${fingerprint(scope)}.lock`);
    const owner = {
      schema: 1,
      token,
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rootDir: realpathSync(rootDir),
      runtime,
      scope,
      selectedTargets,
      activeChildren: [],
    };

    let acquired = false;
    for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
      try {
        mkdirSync(lockPath);
        exclusiveRunLock.paths.push(lockPath);
        writeLockOwner(lockPath, token, owner);
        acquired = true;
        continue;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }

      let existing;
      try {
        existing = readJson(join(lockPath, 'owner.json'));
      } catch {
        fail(
          `JavaScript baseline suite lock is malformed and was left untouched: ${lockPath}\n` +
          'Inspect the lock before removing it manually.'
        );
      }
      if (
        existing?.schema !== 1 ||
        typeof existing.token !== 'string' ||
        !Number.isInteger(existing.pid) ||
        !Array.isArray(existing.activeChildren)
      ) {
        fail(`JavaScript baseline suite lock has an unknown format and was left untouched: ${lockPath}`);
      }
      if (existing.hostname !== os.hostname()) {
        fail(`JavaScript baseline suite is locked by PID ${existing.pid} on ${existing.hostname}: ${lockPath}`);
      }
      if (processIsRunning(existing.pid)) {
        fail(`JavaScript baseline suite is already running as PID ${existing.pid}: ${lockPath}`);
      }
      const liveChildren = existing.activeChildren.filter(processGroupIsRunning);
      if (liveChildren.length > 0) {
        fail(
          `A stale JavaScript baseline suite lock still owns live test processes ` +
          `${liveChildren.join(', ')}: ${lockPath}`
        );
      }

      const stalePath = `${lockPath}.stale-${existing.token}`;
      try {
        renameSync(lockPath, stalePath);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        fail(`Could not safely reclaim stale JavaScript baseline suite lock: ${error.message}`);
      }
      let movedOwner;
      try { movedOwner = readJson(join(stalePath, 'owner.json')); } catch {}
      if (movedOwner?.token !== existing.token) {
        try { if (!existsSync(lockPath)) renameSync(stalePath, lockPath); } catch {}
        fail('JavaScript baseline suite lock changed while stale-lock recovery was in progress.');
      }
      rmSync(stalePath, { recursive: true, force: true });
    }
    if (!acquired) fail(`Could not acquire JavaScript baseline suite lock: ${lockPath}`);
  }
}

function releaseExclusiveRunLock() {
  if (exclusiveRunLock == null) return;
  const lock = exclusiveRunLock;
  exclusiveRunLock = null;
  for (const lockPath of lock.paths) {
    let owner;
    try { owner = readJson(join(lockPath, 'owner.json')); } catch { continue; }
    if (owner?.token !== lock.token) continue;
    try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
  }
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  const source = readFileSync(path, 'utf8');
  const lines = source.split('\n');
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      const trailingIncomplete = index === lines.length - 1 && !source.endsWith('\n');
      if (trailingIncomplete) break;
      fail(`Invalid JSONL record ${index + 1} in ${path}: ${error.message}`);
    }
  }
  return records;
}

function repairTrailingJsonLine(path) {
  if (!existsSync(path)) return;
  const source = readFileSync(path, 'utf8');
  if (!source || source.endsWith('\n')) return;
  const lastNewline = source.lastIndexOf('\n');
  const trailing = source.slice(lastNewline + 1).trim();
  try {
    JSON.parse(trailing);
    appendFileSync(path, '\n');
  } catch {
    // A killed process can leave only its final append incomplete. Preserve
    // every complete append-only event and discard only that invalid suffix
    // before continuing in the same report.
    truncateSync(path, lastNewline + 1);
  }
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}h ${minutes}m ${rest}s`
    : minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function regexIdentity(value) {
  return value instanceof RegExp ? { source: value.source, flags: value.flags } : null;
}

function repositoryCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function makeRunIdentity(runtime, targets, options) {
  const selectedTargets = runtimeTargets(runtime, targets).map((name) => ({
    name,
    version: targets[name]?.version,
    commit: targets[name]?.commit,
    snapshot: targets[name] ? targetSnapshotRoot(name, targets[name]) : null,
  }));
  return {
    schema: 1,
    suite: 'cottontail-javascript-baseline',
    rootDir: realpathSync(rootDir),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: typeof os.version === 'function' ? os.version() : null,
    hostname: os.hostname(),
    runnerNodeVersion: process.version,
    repositoryCommit: repositoryCommit(),
    runtime,
    targetsPath,
    targetsHash: hashFile(targetsPath),
    selectedTargets,
    toolHash: hashFile(fileURLToPath(import.meta.url)),
    binaryPath: realpathSync(binaryPath),
    binaryHash: hashFile(binaryPath),
    binarySourcePath,
    binarySourceHash,
    hutchPath: hutchPath == null ? null : realpathSync(hutchPath),
    hutchHash: hutchPath == null ? null : hashFile(hutchPath),
    hutchSourcePath,
    hutchSourceHash,
    selection: {
      includeExpectedFailures: options.includeExpectedFailures,
      expectPass: options.expectPass,
      caseMatch: regexIdentity(options.caseMatch),
      match: regexIdentity(options.match),
      maxTests: Number.isFinite(options.maxTests) ? options.maxTests : null,
      onlyStatus: options.onlyStatus,
      test: options.test,
      testList: options.testList?.paths ?? null,
    },
  };
}

class JavaScriptBaselineReporter {
  constructor(identity, options) {
    this.startedAtMs = Date.now();
    this.planned = 0;
    this.completed = 0;
    this.resumed = 0;
    this.unexpected = 0;
    this.durationTotalMs = 0;
    this.running = new Map();
    this.options = options;
    this.isResume = options.resumeDir != null;

    if (this.isResume) {
      this.reportDir = resolve(rootDir, options.resumeDir);
      if (!existsSync(this.reportDir) || !lstatSync(this.reportDir).isDirectory()) {
        fail(`Resume report directory not found: ${this.reportDir}`);
      }
      if (lstatSync(this.reportDir).isSymbolicLink()) {
        fail(`Cannot resume through a symlinked report directory: ${this.reportDir}`);
      }
    } else if (options.reportDir != null) {
      this.reportDir = resolve(rootDir, options.reportDir);
      if (existsSync(this.reportDir)) {
        fail(`New report directory already exists; use --resume to continue it: ${this.reportDir}`);
      }
      mkdirSync(dirname(this.reportDir), { recursive: true });
      mkdirSync(this.reportDir);
    } else {
      const reportsParent = resolve(
        process.env.COTTONTAIL_BASELINE_REPORTS_DIR ??
          join(baselineStateRoot, 'runs')
      );
      mkdirSync(reportsParent, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.reportDir = mkdtempSync(join(reportsParent, `${stamp}-`));
    }
    this.eventsPath = join(this.reportDir, 'events.jsonl');
    this.logsDir = join(this.reportDir, 'logs');
    this.plansDir = join(this.reportDir, 'plans');
    const runPath = join(this.reportDir, 'run.json');
    const identityFingerprint = fingerprint(identity);
    if (this.isResume) {
      for (const [path, expectedDirectory] of [
        [runPath, false],
        [this.eventsPath, false],
        [this.logsDir, true],
        [this.plansDir, true],
      ]) {
        const stat = existsSync(path) ? lstatSync(path) : null;
        if (
          stat == null ||
          stat.isSymbolicLink() ||
          (expectedDirectory ? !stat.isDirectory() : !stat.isFile())
        ) {
          fail(`Cannot resume with a missing or symlinked report path: ${path}`);
        }
      }
      let previous;
      try { previous = readJson(runPath); } catch (error) {
        fail(`Cannot resume: invalid or missing ${runPath}: ${error.message}`);
      }
      const { fingerprint: storedFingerprint, createdAt: _createdAt, ...storedIdentity } = previous;
      if (storedFingerprint !== fingerprint(storedIdentity)) {
        fail(`Cannot resume: run metadata fingerprint is invalid: ${runPath}`);
      }
      if (storedFingerprint !== identityFingerprint) {
        fail(
          'Cannot resume JavaScript baseline suite: tool, binary, target, or selection fingerprint changed.'
        );
      }
      this.previousEvents = readJsonLines(this.eventsPath);
      for (const event of this.previousEvents) {
        const { checksum, ...payload } = event;
        if (typeof checksum !== 'string' || checksum !== fingerprint(payload)) {
          fail(`Cannot resume: invalid event checksum in ${this.eventsPath}`);
        }
      }
      // Validate all durable metadata before changing even an incomplete
      // suffix left by an interrupted append.
      repairTrailingJsonLine(this.eventsPath);
    } else {
      mkdirSync(this.logsDir, { recursive: true });
      mkdirSync(this.plansDir, { recursive: true });
      writeFileSync(runPath, `${JSON.stringify({
        ...identity,
        fingerprint: identityFingerprint,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`);
      this.previousEvents = [];
    }
    this.resumeTerminals = new Map();
    for (const event of this.previousEvents) {
      if (event?.kind === 'terminal' && event.ok === true && event.unexpected === false) {
        this.resumeTerminals.set(event.unitId, event);
      }
    }
    this.appendEvent({ kind: this.isResume ? 'resume-start' : 'run-start', identityFingerprint });
    console.log(`JavaScript baseline suite report: ${this.reportDir}`);

    const heartbeatMs = Number(process.env.COTTONTAIL_BASELINE_HEARTBEAT_MS ?? 30000);
    if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1) {
      fail('COTTONTAIL_BASELINE_HEARTBEAT_MS must be a positive number');
    }
    this.heartbeatTimer = setInterval(() => this.heartbeat(), heartbeatMs);
    this.heartbeatTimer.unref();
  }

  appendEvent(event) {
    const record = JSON.parse(JSON.stringify({
      schema: 1,
      at: new Date().toISOString(),
      ...event,
    }));
    appendFileSync(this.eventsPath, `${JSON.stringify({
      ...record,
      checksum: fingerprint(record),
    })}\n`);
  }

  addUnits(count) {
    this.planned += count;
  }

  registerPlan(runtime, plan) {
    const planPath = join(this.plansDir, `${runtime}.json`);
    const planFingerprint = fingerprint(plan);
    const record = { ...plan, fingerprint: planFingerprint };
    if (this.isResume) {
      if (!existsSync(planPath) || lstatSync(planPath).isSymbolicLink()) {
        fail(`Cannot resume with a missing or symlinked plan: ${planPath}`);
      }
      let previous;
      try { previous = readJson(planPath); } catch (error) {
        fail(`Cannot resume: invalid or missing ${planPath}: ${error.message}`);
      }
      const { fingerprint: storedFingerprint, ...storedPlan } = previous;
      if (storedFingerprint !== fingerprint(storedPlan)) {
        fail(`Cannot resume: stored ${runtime} plan fingerprint is invalid.`);
      }
      if (storedFingerprint !== planFingerprint) {
        fail(`Cannot resume JavaScript baseline suite: ${runtime} plan or test hashes changed.`);
      }
    } else {
      writeFileSync(planPath, `${JSON.stringify(record, null, 2)}\n`);
    }
    return planFingerprint;
  }

  resumeResult(unitId, planHash, testHash) {
    if (!this.isResume) return null;
    const event = this.resumeTerminals.get(unitId);
    if (event?.planHash !== planHash || event?.testHash !== testHash) return null;
    const result = { ...event.result, resumed: true };
    this.completed += 1;
    this.resumed += 1;
    this.appendEvent({ kind: 'resume-skip', unitId, planHash, testHash });
    console.log(`[${this.completed}/${this.planned}] resume ok ${unitId}`);
    return result;
  }

  attemptStarted(unitId, label, attempt, mode) {
    this.firstAttemptAtMs ??= Date.now();
    const key = `${unitId}:${attempt}`;
    const logName = `${hashBytes(unitId).slice(0, 16)}-${label.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-100)}.log`;
    const logPath = join(this.logsDir, logName);
    const item = {
      unitId,
      label,
      attempt,
      mode,
      startedAtMs: Date.now(),
      logPath,
      logBytes: 0,
      logTruncated: false,
      lastStream: null,
    };
    appendFileSync(logPath, `=== attempt ${attempt} (${mode}) ${new Date().toISOString()} ===\n`);
    this.running.set(key, item);
    this.appendEvent({ kind: 'attempt-start', unitId, label, attempt, mode });
    console.log(`[start] ${label} (attempt ${attempt}, ${mode})`);
    return {
      write: (stream, data) => this.appendAttemptOutput(item, stream, data),
    };
  }

  appendAttemptOutput(item, stream, data) {
    if (item.logTruncated) return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const remaining = Math.max(0, directTestMaxBuffer - item.logBytes);
    if (remaining === 0) {
      appendFileSync(item.logPath, '\n--- output truncated at configured log limit ---\n');
      item.logTruncated = true;
      return;
    }
    if (item.lastStream !== stream) {
      appendFileSync(item.logPath, `--- ${stream} ---\n`);
      item.lastStream = stream;
    }
    const written = chunk.subarray(0, remaining);
    appendFileSync(item.logPath, written);
    item.logBytes += written.length;
    if (written.length < chunk.length) {
      appendFileSync(item.logPath, '\n--- output truncated at configured log limit ---\n');
      item.logTruncated = true;
    }
  }

  attemptCompleted(unitId, label, attempt, mode, result, terminal) {
    const key = `${unitId}:${attempt}`;
    const started = this.running.get(key);
    this.running.delete(key);
    const durationMs = Math.max(0, Date.now() - (started?.startedAtMs ?? Date.now()));
    const logPath = started?.logPath ?? join(this.logsDir, `${hashBytes(unitId).slice(0, 16)}.log`);
    const raw = result.raw ?? {};
    appendFileSync(logPath, [
      '',
      '--- result ---',
      `durationMs: ${durationMs}`,
      `status: ${raw.status ?? ''}`,
      `signal: ${raw.signal ?? ''}`,
      raw.error ? `error: ${raw.error.message ?? String(raw.error)}` : '',
      '',
    ].filter(Boolean).join('\n') + '\n');
    result.reportLog = relative(this.reportDir, logPath).replace(/\\/g, '/');
    this.appendEvent({
      kind: 'attempt-end',
      unitId,
      label,
      attempt,
      mode,
      durationMs,
      ok: result.ok,
      unexpected: result.unexpected,
      terminal,
      log: result.reportLog,
    });
    if (!terminal) {
      const disposition = result.unexpected ? 'unexpected; awaiting serial confirmation' : 'complete';
      console.log(`[attempt ${attempt} done] ${label}: ${disposition}`);
    }
    return durationMs;
  }

  terminal(unitId, label, result, planHash, testHash, durationMs = 0) {
    this.completed += 1;
    this.durationTotalMs += durationMs;
    if (result.unexpected) this.unexpected += 1;
    const storedResult = {
      runtime: result.runtime,
      entry: result.entry == null ? undefined : {
        path: result.entry.path,
        variant: result.entry.variant,
        status: result.entry.status,
      },
      ok: result.ok,
      unexpected: result.unexpected,
      message: result.message,
      execution: result.execution,
      reportLog: result.reportLog,
    };
    this.appendEvent({
      kind: 'terminal',
      unitId,
      label,
      planHash,
      testHash,
      ok: result.ok,
      unexpected: result.unexpected,
      result: storedResult,
    });
    console.log(
      `[${this.completed}/${this.planned}] ${result.message}` +
      (result.reportLog ? `\n  log: ${join(this.reportDir, result.reportLog)}` : '')
    );
  }

  heartbeat() {
    const elapsedMs = Date.now() - this.startedAtMs;
    const remaining = Math.max(0, this.planned - this.completed);
    const freshCompleted = this.completed - this.resumed;
    const throughputElapsedMs = this.firstAttemptAtMs == null
      ? 0
      : Date.now() - this.firstAttemptAtMs;
    const averageMs = freshCompleted > 0
      ? throughputElapsedMs / freshCompleted
      : null;
    const eta = averageMs == null ? 'unknown' : formatElapsed(averageMs * remaining);
    const running = [...this.running.values()]
      .map((item) => `${item.label} (${formatElapsed(Date.now() - item.startedAtMs)})`)
      .join(', ') || 'none';
    const message =
      `heartbeat JavaScript baseline suite: ${this.completed}/${this.planned} complete, ` +
      `${this.unexpected} unexpected, elapsed ${formatElapsed(elapsedMs)}, ETA ${eta}; ` +
      `running: ${running}`;
    console.log(message);
    this.appendEvent({
      kind: 'heartbeat',
      completed: this.completed,
      planned: this.planned,
      unexpected: this.unexpected,
      elapsedMs,
      running: [...this.running.values()].map(({ unitId, label, attempt, mode, startedAtMs }) => ({
        unitId,
        label,
        attempt,
        mode,
        elapsedMs: Date.now() - startedAtMs,
      })),
    });
  }

  finish(extra = {}) {
    clearInterval(this.heartbeatTimer);
    const summary = {
      schema: 1,
      suite: 'cottontail-javascript-baseline',
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAtMs,
      planned: this.planned,
      completed: this.completed,
      resumed: this.resumed,
      unexpected: this.unexpected,
      ...extra,
    };
    this.appendEvent({ kind: 'run-end', ...summary });
    writeFileSync(join(this.reportDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }
}

function validateHutchEnginePath(path) {
  if (!existsSync(path)) fail(`Hutch engine not found at ${path}.`);
  if (!statSync(path).isFile()) fail(`Hutch engine is not a file: ${path}.`);
  const requestedName = basename(path).toLowerCase();
  const resolvedName = basename(realpathSync(path)).toLowerCase();
  const outerName = process.platform === 'win32' ? 'hutch.exe' : 'hutch';
  if (requestedName === outerName || resolvedName === outerName) {
    fail(
      `--hutch must point directly to a Hutch engine, not the outer Hutch launcher: ${path}`
    );
  }
}

function preflightHutchEngine() {
  if (hutchPath == null) return;
  const source = `
const record = {
  answer: 6 * 7,
  cottontailVersion: globalThis.process?.versions?.cottontail,
  productVersion: typeof globalThis.cottontail?.processInfo === "function"
    ? String(globalThis.cottontail.processInfo("version"))
    : null,
  launcherPath: globalThis.process?.env?.HUTCH_LAUNCHER_PATH ?? null,
  launcherVersion: globalThis.process?.env?.HUTCH_LAUNCHER_VERSION ?? null,
  activeChannel: globalThis.process?.env?.HUTCH_ACTIVE_CHANNEL ?? null,
  cottontailBinary: globalThis.process?.env?.COTTONTAIL_BINARY ?? null,
  dashCottontail: globalThis.process?.env?.DASH_COTTONTAIL ?? null,
};
console.log(${JSON.stringify(hutchPreflightPrefix)} + JSON.stringify(record));
`;
  const result = spawnSync(hutchPath, ['--eval', source], {
    cwd: rootDir,
    env: {
      ...immutableBinaryEnvironment(),
      COTTONTAIL_BINARY: binaryPath,
      DASH_COTTONTAIL: binaryPath,
      COTTONTAIL_UPSTREAM_PREFLIGHT: '1',
    },
    encoding: 'utf8',
    timeout: binaryPreflightTimeoutMs,
    maxBuffer: 1024 * 1024,
  });
  const details = binaryPreflightDetails(result);
  if (result.error?.code === 'ETIMEDOUT') {
    fail(`Hutch engine preflight timed out after ${binaryPreflightTimeoutMs}ms: ${hutchPath}`);
  }
  if (result.error) fail(`Hutch engine preflight failed to start ${hutchPath}: ${result.error.message}`);
  if (result.status !== 0) {
    fail([
      `Hutch engine preflight exited ${result.status ?? 1}: ${hutchPath}`,
      details,
    ].filter(Boolean).join('\n'));
  }
  const line = String(result.stdout ?? '')
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(hutchPreflightPrefix));
  if (!line) {
    fail([
      `--hutch is not a working Hutch engine (missing routed identity record): ${hutchPath}`,
      details,
    ].filter(Boolean).join('\n'));
  }
  let record;
  try {
    record = JSON.parse(line.slice(hutchPreflightPrefix.length));
  } catch (error) {
    fail(`Hutch engine preflight emitted invalid identity JSON: ${error.message}`);
  }
  const valid = record?.answer === 42 &&
    typeof record.cottontailVersion === 'string' &&
    record.cottontailVersion.length > 0 &&
    record.cottontailVersion === record.productVersion &&
    record.launcherPath === null &&
    record.launcherVersion === null &&
    record.activeChannel === null &&
    record.cottontailBinary === binaryPath &&
    record.dashCottontail === binaryPath;
  if (!valid) {
    const launcherHint = record?.launcherPath != null
      ? ' The outer Hutch launcher was selected; pass hutch-engine instead.'
      : '';
    fail(
      `--hutch is not a working direct Hutch engine: ${hutchPath}.${launcherHint}\n` +
      `received: ${JSON.stringify(record)}`
    );
  }
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
      ...immutableBinaryEnvironment(),
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
    '  --expect-pass                Require a focused selection to pass, including recorded xfails.',
    '  --hutch <path>               Use a pinned hutch-engine for the optional composed baseline.',
    '  --include-expected-failures  Run tests marked expected-failure and require them to fail.',
    '  --case <regexp>              Select generated itBundled case IDs within a split file.',
    '  --jobs <n>                   Bound Bun file, split-case, and in-file test concurrency (default: up to 4).',
    '  --list                       Print status counts and any filtered selection without running tests.',
    '  --max-failures <n>           Stop after this many unexpected results.',
    '  --max-tests <n>              Run at most this many selected tests.',
    '  --match <regexp>             Select tests whose relative path matches.',
    '  --no-serial-retry            Do not retry parallel failures serially (useful for discovery).',
    '  --only-status <status>       Select enabled, expected-failure, or not-enabled tests.',
    '  --report-dir <path>          Store a new durable JavaScript baseline suite report here.',
    '  --resume <report-dir>        Resume passed tests from a matching interrupted report.',
    '  --test <relative-path>        Run one JavaScript baseline test path.',
    '  --test-list <file>           Run paths listed one per line (# comments are allowed).',
    '  --timeout-scale <n>           Scale in-file Bun test deadlines without skipping cases.',
    '',
    'Snapshot overrides:',
    '  COTTONTAIL_UPSTREAM_TARGETS_PATH   Read target metadata from this JSON file.',
    '  COTTONTAIL_UPSTREAM_BUN_SNAPSHOT   Run against an externally managed Bun snapshot.',
    '  COTTONTAIL_UPSTREAM_HUTCH_BINARY   Optional composed-baseline hutch-engine.',
    '  COTTONTAIL_BASELINE_REPORTS_DIR    Default parent for durable baseline suite reports.',
    '  COTTONTAIL_BASELINE_HEARTBEAT_MS   Live heartbeat interval (default: 30000).',
    '  COTTONTAIL_BASELINE_LOCK_DIR       Parent for the exclusive suite lock.',
    '  COTTONTAIL_BASELINE_STATE_DIR      Parent for immutable pinned executables.',
    '  COTTONTAIL_UPSTREAM_NODE_SNAPSHOT  Run against an externally managed Node snapshot.',
  ].join('\n'));
}

function readTestList(path) {
  const listPath = resolve(rootDir, path);
  if (!existsSync(listPath)) fail(`Test list not found at ${listPath}.`);
  if (!statSync(listPath).isFile()) fail(`Test list is not a file: ${listPath}.`);
  const paths = [];
  const seen = new Set();
  for (const [index, sourceLine] of readFileSync(listPath, 'utf8').split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (isAbsolute(line) || normalized === '..' || normalized.startsWith('../')) {
      fail(`Invalid relative test path on line ${index + 1} of ${listPath}: ${line}`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      paths.push(normalized);
    }
  }
  if (paths.length === 0) fail(`Test list has no paths: ${listPath}`);
  return { path: listPath, paths };
}

function parseArgs(argv) {
  const args = [...argv];
  let runtime = 'all';
  if (args[0] && !args[0].startsWith('-')) {
    runtime = args.shift();
  }
  const options = {
    includeExpectedFailures: false,
    expectPass: false,
    hutch: null,
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
    reportDir: null,
    resumeDir: null,
    test: null,
    testList: null,
    timeoutScale: 1,
  };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--include-expected-failures') {
      options.includeExpectedFailures = true;
    } else if (arg === '--expect-pass') {
      options.expectPass = true;
    } else if (arg === '--hutch') {
      options.hutch = args.shift() ?? fail('--hutch requires a path');
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
    } else if (arg === '--report-dir') {
      options.reportDir = args.shift() ?? fail('--report-dir requires a path');
    } else if (arg === '--resume') {
      options.resumeDir = args.shift() ?? fail('--resume requires a report directory');
    } else if (arg === '--test') {
      options.test = args.shift() ?? fail('--test requires a relative path');
    } else if (arg === '--test-list') {
      options.testList = readTestList(args.shift() ?? fail('--test-list requires a file'));
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
  if (options.reportDir && options.resumeDir) fail('--report-dir and --resume cannot be used together');
  if (options.test && options.testList) fail('--test and --test-list cannot be used together');
  if (
    options.expectPass &&
    !options.test &&
    !options.testList &&
    !options.match &&
    !options.caseMatch &&
    !options.onlyStatus &&
    !Number.isFinite(options.maxTests)
  ) {
    fail('--expect-pass requires a focused test selection');
  }
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
      ...immutableBinaryEnvironment(),
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
      if (current === testRoot && /^\.tmp\.\d+$/.test(name)) continue;
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
  const focusedEntry = (path, selectedReason) => {
    const entry = statusEntryForPath(status, path);
    const owner = entry.owner ?? 'cottontail-runtime';
    if (owner !== 'cottontail-runtime') {
      fail(
        `Focused JavaScript baseline path ${path} is owned by ${owner}, not Cottontail; ` +
        'run it from its owning repository.'
      );
    }
    if (disabledStatuses.has(entry.status)) {
      fail(`Focused JavaScript baseline path ${path} is ${entry.status} and cannot be executed here.`);
    }
    if (entry.status === 'not-enabled' && options.onlyStatus !== 'not-enabled') {
      fail(
        `Focused JavaScript baseline path ${path} is not-enabled; ` +
        'pass --only-status not-enabled to opt into that diagnostic tier.'
      );
    }
    if (
      options.onlyStatus != null &&
      entry.status !== options.onlyStatus &&
      !(options.onlyStatus === 'enabled' && hasEnabledBundlerCases(entry))
    ) {
      fail(
        `Focused JavaScript baseline path ${path} has status ${entry.status}, ` +
        `not ${options.onlyStatus}.`
      );
    }
    return { ...entry, owner, reason: entry.reason ?? selectedReason };
  };
  const hasEnabledBundlerCases = (entry) =>
    entry.splitBundlerTests === true && Object.keys(entry.enabledBundlerTests ?? {}).length > 0;
  if (options.test) {
    return [focusedEntry(options.test, 'selected from CLI')];
  }
  if (options.testList) {
    return options.testList.paths.map((path) =>
      focusedEntry(path, `selected from ${options.testList.path}`)
    );
  }
  let entries;
  const includeExpectedFailures = options.includeExpectedFailures || options.onlyStatus === 'expected-failure';
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
  const safeOverrides = safeEnvironmentOverrides(overrides);
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
    ...safeOverrides,
    ...(hutchPath ? {
      // The test itself remains a direct Cottontail process. Present Hutch's
      // command engine as Bun's CLI executable so package setup stays on the
      // build-tool side while runtime children route back to Cottontail. The
      // outer Hutch version/pragma launcher is deliberately not involved.
      COTTONTAIL_SPAWN_EXEC_PATH: hutchPath,
      COTTONTAIL_SPAWN_ARGV0: hutchPath,
      COTTONTAIL_BINARY: binaryPath,
      DASH_COTTONTAIL: binaryPath,
    } : {}),
  };
}

function expectPassEntries(entries, options) {
  if (!options.expectPass) return entries;
  return entries.map((entry) => ({
    ...entry,
    status: 'enabled',
    reason: 'focused run requires this selection to pass',
  }));
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
      env: immutableBinaryEnvironment(),
      stdio: 'inherit',
    });
    if (result.error) fail(`Failed to prepare the ${name} upstream fixture: ${result.error.message}`);
    if (result.status !== 0) fail(`${name} upstream fixture setup exited ${result.status ?? 1}.`);
  }
}

function entryLabel(entry) {
  return entry.variant ? `${entry.path} [${entry.variant}]` : entry.path;
}

function entryUnitId(runtime, entry) {
  return `${runtime}:${entry.path}${entry.variant ? `#${entry.variant}` : ''}`;
}

function entryPlanRecord(entry, snapshotRoot, options) {
  safeEnvironmentOverrides(entry.env);
  const testPath = join(snapshotRoot, entry.path);
  return {
    unitId: entryUnitId('bun', entry),
    path: entry.path,
    variant: entry.variant ?? null,
    status: entry.status,
    owner: entry.owner ?? 'cottontail-runtime',
    reason: entry.reason ?? null,
    args: entryArgs(entry, options),
    env: entry.env ?? null,
    timeoutMs: entryTimeout(entry, options),
    serial: entry.serial === true,
    testHash: existsSync(testPath) && statSync(testPath).isFile()
      ? hashFile(testPath)
      : 'missing',
  };
}

function makeRuntimePlan(runtime, target, statusPath, entries, snapshotRoot, options, source) {
  const tests = entries.map((entry) => runtime === 'bun'
    ? entryPlanRecord(entry, snapshotRoot, options)
    : {
        unitId: entryUnitId(runtime, entry),
        path: entry.path,
        status: entry.status,
        owner: entry.owner ?? 'cottontail-runtime',
        testHash: existsSync(join(snapshotRoot, entry.path))
          ? hashFile(join(snapshotRoot, entry.path))
          : 'missing',
      }
  );
  return {
    schema: 1,
    runtime,
    target: { version: target.version, commit: target.commit, snapshotRoot },
    snapshotSourceHash: source.hash,
    snapshotSourceFiles: source.files,
    snapshotSourceScope: 'tracked source plus explicitly selected test hashes',
    statusHash: hashFile(statusPath),
    execution: {
      jobs: options.jobs,
      serialRetry: options.serialRetry,
      timeoutScale: options.timeoutScale,
      fastXfail: options.fastXfail,
    },
    tests,
  };
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
  if (result.error || result.status !== 0 || result.signal != null) {
    const details = [
      result.error?.message,
      result.signal ? `signal: ${result.signal}` : null,
      result.status != null ? `exit status: ${result.status}` : null,
      result.stderr,
    ].filter(Boolean).join('\n');
    fail(
      `Incomplete itBundled discovery in ${entry.path}; discovery must exit cleanly` +
      `${details ? `:\n${details}` : '.'}`
    );
  }
  const stdout = String(result.stdout ?? '');
  if (stdout.length > 0 && !/\r?\n$/.test(stdout)) {
    fail(`Incomplete itBundled discovery output in ${entry.path}: final record was truncated.`);
  }
  const ids = [];
  const seen = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(bundlerTestDiscoveryPrefix)) continue;
    try {
      const id = JSON.parse(line.slice(bundlerTestDiscoveryPrefix.length));
      if (typeof id !== 'string' || id.length === 0) {
        fail(`Invalid itBundled discovery ID in ${entry.path}: ${line}`);
      }
      // Bun permits the same leaf test name in separate describe scopes. The
      // exact BUN_BUNDLER_TEST_FILTER intentionally selects all registrations
      // sharing that leaf ID, so represent them with one grouped runner unit.
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    } catch {
      fail(`Invalid itBundled discovery record in ${entry.path}: ${line}`);
    }
  }
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
  return expectPassEntries(expanded, options);
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

function nodeHarnessChunks(target, entries, snapshotRoot, expectedFailure = false) {
  const inventory = nodeHarnessInventory(snapshotRoot);
  const selectors = nodeSelectorsForEntries(entries, snapshotRoot);
  const chunks = chunkNodeSelectors(selectors);
  return chunks.map((chunk, index) => {
    const expectedTests = chunk.reduce(
      (total, selector) => total + inventory.pathsBySelector.get(selector).length,
      0,
    );
    const pythonBootstrap = [
      'import os,runpy,sys',
      'root=os.getcwd()',
      "script=os.path.join('tools','test.py')",
      "sys.path[:0]=[os.path.join(root,'tools'),root]",
      'sys.argv[0]=script',
      "runpy.run_path(script,run_name='__main__')",
    ].join(';');
    const harnessArgs = ['--shell', binaryPath, '-j4', '--report', ...chunk];
    const args = process.platform === 'win32'
      ? ['-c', pythonBootstrap, ...harnessArgs]
      : ['tools/test.py', ...harnessArgs];
    return {
      index,
      selectors: chunk,
      expectedTests,
      expectedFailure,
      command: pythonPath,
      args,
      spawnOptions: {
        cwd: snapshotRoot,
        env: {
          ...makeEnv('node', target),
          PYTHONDONTWRITEBYTECODE: '1',
        },
      },
    };
  });
}

function entryArgs(entry, options = null, serialAttempt = false) {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  if (
    (options?.jobs === 1 || entry.serial === true || serialAttempt) &&
    !args.some((arg) => arg === '--max-concurrency' || arg.startsWith('--max-concurrency='))
  ) {
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

function spawnCapturedAsync(command, args, spawnOptions, attemptOutput = null) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: process.platform !== 'win32',
    });
    activeChildren.add(child);
    updateExclusiveRunLockChildren();
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (data) => {
      attemptOutput?.write('stdout', data);
      if (stdout.length < directTestMaxBuffer) stdout += data;
    });
    child.stderr.on('data', (data) => {
      attemptOutput?.write('stderr', data);
      if (stderr.length < directTestMaxBuffer) stderr += data;
    });
    const settle = async (status, signal, error = undefined) => {
      if (settled) return;
      settled = true;
      const stopped = await terminateTrackedChild(child);
      if (!stopped) {
        error = Object.assign(
          new Error(`could not prove process group ${child.pid} stopped; owned temporary files were retained`),
          { code: 'EPROCESSGROUP' },
        );
      }
      resolveResult({ status, signal, stdout, stderr, error });
    };
    child.on('exit', (status, signal) => setTimeout(() => settle(status, signal), 250));
    child.on('close', (status, signal) => settle(status, signal));
    child.on('error', (error) => settle(null, null, error));
  });
}

function runDirectAsync(runtime, target, entry, snapshotRoot, options, attemptOutput = null, serialAttempt = false) {
  const timeout = entryTimeout(entry, options);
  const useShortTemp = entry.env?.COTTONTAIL_UPSTREAM_SHORT_TEMP === '1';
  // A few Unix-domain-socket fixtures must stay below macOS's 104-byte
  // sockaddr_un limit. Keep those attempts isolated and runner-owned while
  // placing their root under a genuinely short platform directory. This is
  // deliberately independent of the launcher's containment override, which
  // can itself be an absolute path deep inside an attested run directory.
  if (useShortTemp && shortTempRoot == null) {
    shortTempRoot = createShortTempRoot();
  }
  const runTemp = mkdtempSync(join(
    useShortTemp ? shortTempRoot : tempRoot,
    'run-',
  ));
  return new Promise((resolveResult) => {
    const child = spawn(binaryPath, [entry.path, ...entryArgs(entry, options, serialAttempt)], {
      cwd: snapshotRoot,
      env: makeEnv(runtime, target, runTemp, {
        // Spawning with `cwd` changes the child's working directory but not the
        // inherited PWD env var. Keep PWD consistent with the launch directory
        // so tests that snapshot `process.env` (e.g. shell variable expansion)
        // do not observe a stale PWD from the runner's own shell.
        PWD: snapshotRoot,
        ...(entry.env ?? {}),
        ...(options.timeoutScale !== 1
          ? { COTTONTAIL_TEST_TIMEOUT_SCALE: String(options.timeoutScale) }
          : {}),
      }),
      detached: process.platform !== 'win32',
    });
    activeChildren.add(child);
    updateExclusiveRunLockChildren();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      settle(null, null);
    }, timeout);
    child.stdout.on('data', (data) => {
      attemptOutput?.write('stdout', data);
      if (stdout.length < directTestMaxBuffer) stdout += data;
    });
    child.stderr.on('data', (data) => {
      attemptOutput?.write('stderr', data);
      if (stderr.length < directTestMaxBuffer) stderr += data;
    });
    const settle = async (code, signal, spawnError = undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A test owns its process group. Remove any grandchildren it left
      // behind after either a timeout or a normal/failed test exit.
      const stopped = await terminateTrackedChild(child);
      if (stopped) removeTemp(runTemp);
      else {
        spawnError = Object.assign(
          new Error(`could not prove process group ${child.pid} stopped; ${runTemp} was retained`),
          { code: 'EPROCESSGROUP' },
        );
      }
      resolveResult({
        status: code,
        signal,
        stdout,
        stderr,
        error: spawnError ?? (timedOut
          ? Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
          : undefined),
      });
    };
    // 'exit' plus a grace beat: orphaned grandchildren can hold stdio pipes
    // open forever, so never wait solely on 'close'.
    child.on('exit', (code, signal) => setTimeout(() => settle(code, signal), 250));
    child.on('close', (code, signal) => settle(code, signal));
    child.on('error', (error) => settle(null, null, error));
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
      raw: result,
    };
  }
  const spawnError = formatSpawnError(runtime, entry, result);
  if (spawnError) {
    return { runtime, entry, ok: false, unexpected: true, message: spawnError, raw: result };
  }
  const exitCode = result.status ?? 1;
  const shouldFail = entry.status === 'expected-failure';
  const execution = runtime === 'bun' ? parseBunTestExecution(result.stderr) : null;
  const allNotExecuted = exitCode === 0 && execution != null &&
    execution.tests > 0 &&
    execution.passed === 0 &&
    execution.failed === 0 &&
    execution.skipped + execution.todo === execution.tests;
  const ok = allNotExecuted || (shouldFail ? exitCode !== 0 : exitCode === 0);
  const executionLabel = execution
    ? ` (${execution.tests} tests, ${execution.assertions} assertions)`
    : '';
  const message = ok
      ? `${allNotExecuted ? 'skip' : shouldFail ? 'xfail' : 'ok'} ${runtime} ${entryLabel(entry)}${executionLabel}`
      : `${shouldFail ? 'XPASS' : 'FAIL'} ${runtime} ${entryLabel(entry)} exited ${exitCode}`;
  return { runtime, entry, ok, unexpected: !ok, message, execution, allNotExecuted, raw: result };
}

async function runBunEntries(
  runtime,
  target,
  entries,
  options,
  reporter,
  plan,
  planHash,
  failureBudget,
) {
  const snapshotRoot = targetSnapshotRoot(runtime, target);
  const planByUnit = new Map(plan.tests.map((test) => [test.unitId, test]));
  const results = new Array(entries.length);
  let finalUnexpected = 0;
  let stoppedEarly = false;

  const finalize = (index, result, durationMs) => {
    results[index] = result;
    const entry = entries[index];
    const unitId = entryUnitId(runtime, entry);
    const testHash = planByUnit.get(unitId)?.testHash;
    reporter.terminal(unitId, entryLabel(entry), result, planHash, testHash, durationMs);
    if (result.unexpected) finalUnexpected += 1;
    if (finalUnexpected >= failureBudget) stoppedEarly = true;
  };

  const runAttempt = async (index, attempt, mode) => {
    const entry = entries[index];
    const unitId = entryUnitId(runtime, entry);
    const label = `${runtime} ${entryLabel(entry)}`;
    const attemptOutput = reporter.attemptStarted(unitId, label, attempt, mode);
    const result = await runOneAsync(
      runtime,
      target,
      entry,
      snapshotRoot,
      options,
      attemptOutput,
      mode !== 'parallel',
    );
    return { result, unitId, label, attempt, mode };
  };

  const completeAttempt = (outcome, terminal) => reporter.attemptCompleted(
      outcome.unitId,
      outcome.label,
      outcome.attempt,
      outcome.mode,
      outcome.result,
      terminal,
    );

  const shouldConfirmSerially = (index, result) =>
    result.unexpected &&
    options.serialRetry &&
    entries[index].status === 'enabled';

  const pendingIndexes = [];
  entries.forEach((entry, index) => {
    const unitId = entryUnitId(runtime, entry);
    const testHash = planByUnit.get(unitId)?.testHash;
    const resumed = reporter.resumeResult(unitId, planHash, testHash);
    if (resumed != null) results[index] = resumed;
    else pendingIndexes.push(index);
  });

  if (options.jobs <= 1) {
    for (const index of pendingIndexes) {
      if (stoppedEarly) break;
      const outcome = await runAttempt(index, 1, 'serial');
      const durationMs = completeAttempt(outcome, true);
      finalize(index, outcome.result, durationMs);
    }
    const pending = results.filter(Boolean).length < entries.length;
    if (stoppedEarly && pending) {
      console.log(
        `Stopped scheduling JavaScript baseline tests at --max-failures=${failureBudget}.`
      );
    }
    return {
      results: results.filter(Boolean),
      stoppedEarly: stoppedEarly && pending,
      unexpected: finalUnexpected,
    };
  }

  // Only explicit serial:true entries are forced into the serial phase.
  // A larger timeout budget says nothing about whether a test is safe to run
  // concurrently.
  const serialIndexes = new Set();
  entries.forEach((entry, index) => {
    if (entry.serial === true && results[index] == null) serialIndexes.add(index);
  });

  const queue = pendingIndexes.filter((index) => !serialIndexes.has(index));
  let cursor = 0;
  const active = new Map();
  const confirmations = [];
  let pauseForConfirmation = false;

  const launch = (index) => {
    const promise = runAttempt(index, 1, 'parallel')
      .then((outcome) => ({ index, ...outcome }));
    active.set(index, promise);
  };

  while ((cursor < queue.length || active.size > 0 || confirmations.length > 0) && !stoppedEarly) {
    while (!pauseForConfirmation && active.size < options.jobs && cursor < queue.length) {
      launch(queue[cursor++]);
    }

    if (active.size > 0) {
      const outcome = await Promise.race(active.values());
      active.delete(outcome.index);
      if (shouldConfirmSerially(outcome.index, outcome.result)) {
        completeAttempt(outcome, false);
        confirmations.push(outcome.index);
        pauseForConfirmation = true;
      } else {
        const durationMs = completeAttempt(outcome, true);
        finalize(outcome.index, outcome.result, durationMs);
        if (stoppedEarly) pauseForConfirmation = true;
      }
      continue;
    }

    while (confirmations.length > 0 && !stoppedEarly) {
      const index = confirmations.shift();
      const outcome = await runAttempt(index, 2, 'serial confirmation');
      const durationMs = completeAttempt(outcome, true);
      finalize(index, outcome.result, durationMs);
    }
    pauseForConfirmation = false;
  }

  if (stoppedEarly && active.size > 0) {
    for (const child of [...activeChildren]) killProcessTree(child);
    const canceled = await Promise.allSettled(active.values());
    for (const outcome of canceled) {
      if (outcome.status === 'fulfilled') completeAttempt(outcome.value, false);
    }
    active.clear();
  }

  for (const index of serialIndexes) {
    if (stoppedEarly) break;
    const outcome = await runAttempt(index, 1, 'explicit serial');
    const durationMs = completeAttempt(outcome, true);
    finalize(index, outcome.result, durationMs);
  }

  if (stoppedEarly && results.filter(Boolean).length < entries.length) {
    const notStarted = entries.length - results.filter(Boolean).length;
    console.log(
      `Stopped scheduling JavaScript baseline tests at --max-failures=${failureBudget}; ` +
      `${notStarted} planned result(s) remain pending.`
    );
  }
  const pending = results.filter(Boolean).length < entries.length;
  return {
    results: results.filter(Boolean),
    stoppedEarly: stoppedEarly && pending,
    unexpected: finalUnexpected,
  };
}

async function runOneAsync(
  runtime,
  target,
  entry,
  snapshotRoot,
  options,
  attemptOutput = null,
  serialAttempt = false,
) {
  const scriptPath = join(snapshotRoot, entry.path);
  if (!existsSync(scriptPath)) {
    return {
      runtime,
      entry,
      ok: false,
      unexpected: true,
      message: `missing Bun-derived JavaScript test: ${entry.path}`,
      raw: {},
    };
  }
  const stat = statSync(scriptPath);
  if (!stat.isFile()) {
    return { runtime, entry, ok: false, unexpected: true, message: `not a file: ${entry.path}`, raw: {} };
  }
  const result = await runDirectAsync(
    runtime,
    target,
    entry,
    snapshotRoot,
    options,
    attemptOutput,
    serialAttempt,
  );
  return classifyResult(runtime, entry, result, options);
}

function formatSpawnError(runtime, entry, result) {
  if (!result.error) return null;
  return `${runtime} ${entryLabel(entry)} failed to start: ${result.error.message}`;
}

function parseBunTestExecution(stderr) {
  const text = String(stderr ?? '');
  const pattern = /(?:^|\n)\s*(\d+) pass\s*\n((?:\s*\d+ (?:todo|skip)(?:ped)?\s*\n)*)\s*(\d+) fail\s*\n(?:\s*\d+ error\s*\n)?(?:\s*(?:\d+ snapshots?, )?(\d+) expect\(\) calls\s*\n)?Ran (\d+) tests? across (\d+) file(?:s)?\./g;
  let execution = null;
  for (const match of text.matchAll(pattern)) {
    let skipped = 0;
    let todo = 0;
    for (const count of match[2].matchAll(/(\d+) (todo|skip(?:ped)?)/g)) {
      if (count[2] === 'todo') todo += Number(count[1]);
      else skipped += Number(count[1]);
    }
    execution = {
      passed: Number(match[1]),
      skipped,
      todo,
      failed: Number(match[3]),
      assertions: Number(match[4] ?? 0),
      tests: Number(match[5]),
      files: Number(match[6]),
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

async function runNode(runtime, target, entries, snapshotRoot, options, reporter, plan, planHash) {
  const enabledEntries = entries.filter((entry) => entry.status !== 'expected-failure');
  const expectedFailureEntries = entries.filter((entry) => entry.status === 'expected-failure');
  const chunks = [
    ...nodeHarnessChunks(target, enabledEntries, snapshotRoot),
    ...expectedFailureEntries.flatMap((entry) =>
      nodeHarnessChunks(target, [entry], snapshotRoot, true)
    ),
  ].map((chunk, index) => ({ ...chunk, index }));
  const unitId = `${runtime}:test-suite`;
  const testHash = fingerprint(plan.tests.map(({ path, testHash }) => ({ path, testHash })));
  const resumed = reporter.resumeResult(unitId, planHash, testHash);
  if (resumed != null) return [resumed];
  const attemptOutput = reporter.attemptStarted(
    unitId,
    `${runtime} JavaScript baseline suite`,
    1,
    'harness',
  );
  for (const chunk of chunks) {
    reporter.appendEvent({
      kind: 'harness-chunk-start',
      unitId,
      index: chunk.index,
      chunks: chunks.length,
      selectors: chunk.selectors,
    });
    chunk.result = await spawnCapturedAsync(
      chunk.command,
      chunk.args,
      chunk.spawnOptions,
      attemptOutput,
    );
  }
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
    chunk.allSkipped = allSkipped;
    const chunkOk = allSkipped ||
      (chunk.expectedFailure ? exitCode !== 0 : exitCode === 0);
    if (!chunkOk) {
      unexpectedChunks.push({
        ...chunk,
        xpass: chunk.expectedFailure && exitCode === 0,
      });
    }
  }
  const ok = unexpectedChunks.length === 0;
  const focused = options.test ||
    options.testList ||
    options.match ||
    options.onlyStatus ||
    Number.isFinite(options.maxTests);
  const label = options.test
    ? entries[0]?.path ?? 'selected tests'
    : focused
      ? `${entries.length} selected harness path(s) in ${chunks.length} chunk(s)`
      : `${entries.length} enabled harness path(s) in ${chunks.length} chunk(s)`;
  const allExpectedFailure = expectedFailureEntries.length === entries.length;
  const allExpectedFailureSkipped = allExpectedFailure && chunks.every((chunk) => chunk.allSkipped);
  const onlyXpass = unexpectedChunks.length > 0 &&
    unexpectedChunks.every((chunk) => chunk.xpass === true);
  const expectationLabel = expectedFailureEntries.length > 0 && !allExpectedFailure
    ? ` (${expectedFailureEntries.length} expected failure(s))`
    : '';
  const failureDetails = unexpectedChunks.map((chunk) => {
    const result = chunk.result;
    const heading =
      `${chunk.xpass ? 'XPASS ' : ''}Node harness chunk ${chunk.index + 1}/${chunks.length} ` +
      `(${chunk.selectors.length} selector(s)` +
      `${chunk.expectedFailure ? ', expected failure' : ''})`;
    return [
      heading,
      chunk.spawnError ??
        chunk.reportError ??
        `exited ${result.status ?? 1}${result.signal ? ` (${result.signal})` : ''}`,
    ].filter(Boolean).join('\n');
  });
  const message = ok
    ? `${allExpectedFailureSkipped ? 'skip' : allExpectedFailure ? 'xfail' : 'ok'} ${runtime} ${label}${expectationLabel}`
    : [
        `${onlyXpass ? 'XPASS' : 'FAIL'} ${runtime} ${label}${expectationLabel}`,
        ...failureDetails,
      ].filter(Boolean).join('\n');
  const raw = {
    status: ok ? 0 : 1,
    signal: null,
    stdout: chunks.map((chunk) => chunk.result.stdout ?? '').filter(Boolean).join('\n'),
    stderr: chunks.map((chunk) => chunk.result.stderr ?? '').filter(Boolean).join('\n'),
  };
  const result = { runtime, ok, unexpected: !ok, message, raw };
  const durationMs = reporter.attemptCompleted(
    unitId,
    `${runtime} JavaScript baseline suite`,
    1,
    'harness',
    result,
    true,
  );
  reporter.terminal(unitId, `${runtime} JavaScript baseline suite`, result, planHash, testHash, durationMs);
  return [result];
}

function runtimeTargets(runtime, targets) {
  return runtime === 'all' ? ['node', 'bun'] : [runtime];
}

const { runtime, options } = parseArgs(process.argv.slice(2));
if (options.binary != null) binaryPath = resolve(rootDir, options.binary);
const configuredHutchPath = options.hutch ?? process.env.COTTONTAIL_UPSTREAM_HUTCH_BINARY;
if (configuredHutchPath != null) {
  hutchPath = resolve(rootDir, configuredHutchPath);
  validateHutchEnginePath(hutchPath);
}
if (!existsSync(targetsPath)) fail(`Missing ${targetsPath}`);
const targets = readJson(targetsPath);
for (const name of runtimeTargets(runtime, targets)) {
  if (!targets[name]) fail(`Missing upstream target: ${name}`);
  validateSnapshotRoot(name, targets[name], targetSnapshotRoot(name, targets[name]));
}
let reporter = null;
if (!options.list) {
  acquireExclusiveRunLock(runtime, targets);
  for (const name of runtimeTargets(runtime, targets)) {
    validateSnapshotRoot(name, targets[name], targetSnapshotRoot(name, targets[name]));
  }
  if (!existsSync(binaryPath)) fail(`Built cottontail binary not found at ${binaryPath}. Run "bun run build" first.`);
  if (statSync(binaryPath).size === 0) fail(`Built cottontail binary is empty at ${binaryPath}. Rebuild after clearing the Zig cache.`);
  pinSelectedExecutables();
  preflightBinary();
  preflightHutchEngine();
  reporter = new JavaScriptBaselineReporter(makeRunIdentity(runtime, targets, options), options);
}

let unexpected = 0;
let stoppedEarly = false;
const runtimeSummaries = {};
const runtimePlanRecords = [];
const selectedRuntimeNames = runtimeTargets(runtime, targets);
for (const [runtimeIndex, name] of selectedRuntimeNames.entries()) {
  const target = targets[name];
  const snapshotRoot = targetSnapshotRoot(name, target);
  if (!options.list) {
    snapshotArtifactRoots.set(snapshotRoot, name);
    captureSnapshotFileBaselines(snapshotRoot, name);
    removeSnapshotArtifacts(snapshotRoot, name);
  }
  const sourceIdentity = options.list ? null : snapshotSourceHash(snapshotRoot);
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
    if (options.test || options.testList || options.match || options.onlyStatus) {
      const entries = selectedTests(status, options, snapshotRoot, name).slice(0, options.maxTests);
      if (name === 'node' && entries.length > 0) {
        nodeSelectorsForEntries(entries, snapshotRoot);
      }
      console.log(`  selected: ${entries.length}`);
      for (const entry of entries) console.log(`    ${entry.status}\t${entry.path}`);
    }
    continue;
  }

  let entries = selectedTests(status, options, snapshotRoot, name).slice(0, options.maxTests);
  if (entries.length === 0) {
    fail(`No ${name} JavaScript baseline tests matched the requested selection.`);
  }
  if (name === 'node') entries = expectPassEntries(entries, options);
  if (name === 'bun') {
    prepareBunTestDependencies(entries, snapshotRoot);
    entries = expandBunEntries(entries, snapshotRoot, target, options);
  }
  const plan = makeRuntimePlan(
    name,
    target,
    statusPath,
    entries,
    snapshotRoot,
    options,
    sourceIdentity,
  );
  runtimePlanRecords.push({ name, snapshotRoot, sourceIdentity });
  const planHash = reporter.registerPlan(name, plan);
  reporter.addUnits(name === 'node' ? 1 : entries.length);
  let results;
  if (name === 'node') {
    results = await runNode(name, target, entries, snapshotRoot, options, reporter, plan, planHash);
  } else {
    const outcome = await runBunEntries(
      name,
      target,
      entries,
      options,
      reporter,
      plan,
      planHash,
      options.maxFailures - unexpected,
    );
    results = outcome.results;
    stoppedEarly ||= outcome.stoppedEarly;
  }
  const executionTotals = { tests: 0, assertions: 0, files: 0, filesWithoutSummary: 0 };
  for (const result of results) {
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
  }
  if (name === 'bun' && results.length > 0) {
    console.log(
      `  executed bun:test cases: ${executionTotals.tests}; assertions: ${executionTotals.assertions}; ` +
      `files with summaries: ${executionTotals.files}; files without summaries: ${executionTotals.filesWithoutSummary}`
    );
  }
  runtimeSummaries[name] = {
    planned: name === 'node' ? 1 : entries.length,
    completed: results.length,
    unexpected: results.filter((result) => result.unexpected).length,
    ...(name === 'bun' ? { executionTotals } : {}),
  };
  if (unexpected >= options.maxFailures) {
    stoppedEarly ||= runtimeIndex + 1 < selectedRuntimeNames.length;
    break;
  }
}

const sourceIntegrityErrors = [];
if (reporter != null) {
  const liveGroups = [...activeChildren]
    .map((child) => child.pid)
    .filter(processGroupIsRunning);
  if (liveGroups.length > 0) {
    skipSnapshotCleanupOnExit = true;
    skipTempCleanupOnExit = true;
    preserveRunLockOnExit = true;
    sourceIntegrityErrors.push(
      `Could not prove test process group(s) ${liveGroups.join(', ')} stopped; ` +
      'snapshot and temporary cleanup were skipped and the recoverable lock was retained.'
    );
  } else {
    removeAllSnapshotArtifacts();
    for (const record of runtimePlanRecords) {
      const current = snapshotSourceHash(record.snapshotRoot);
      if (current.hash !== record.sourceIdentity.hash || current.files !== record.sourceIdentity.files) {
        sourceIntegrityErrors.push(
          `${record.name} snapshot source changed during the run: ${record.snapshotRoot}`
        );
      }
    }
  }
  reporter.finish({ runtimeSummaries, stoppedEarly, sourceIntegrityErrors });
}
if (sourceIntegrityErrors.length > 0) fail(sourceIntegrityErrors.join('\n'));
if (unexpected > 0) fail(`${unexpected} JavaScript baseline test result(s) were unexpected.`);
