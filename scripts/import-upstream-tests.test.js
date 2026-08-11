import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  allowBunReplacementFlag,
  assertBunReplacementAllowed,
  assertCheckoutCommit,
  bunSnapshotLockPath,
  copySpecs,
  parseImportArguments,
  withBunSnapshotMutationLock,
} from './import-upstream-tests.js';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptsDir, '..');
const importerPath = resolve(scriptsDir, 'import-upstream-tests.js');
const bunRuntimeErrorFixture = 'packages/bun-error/runtime-error.ts';

test('the Bun import preserves the RuntimeError fixture required by the owned test snapshot', () => {
  const targets = JSON.parse(
    readFileSync(join(rootDir, 'compat', 'upstream', 'targets.json'), 'utf8'),
  );
  const snapshotRoot = resolve(rootDir, targets.bun.snapshot);
  const fixturePath = join(snapshotRoot, bunRuntimeErrorFixture);
  assert.equal(copySpecs.bun.sparse.includes(bunRuntimeErrorFixture), true);
  assert.equal(copySpecs.bun.paths.includes(bunRuntimeErrorFixture), true);
  assert.equal(existsSync(fixturePath), true);
  const ignored = spawnSync(
    'git',
    ['check-ignore', '--quiet', '--no-index', join(targets.bun.snapshot, bunRuntimeErrorFixture)],
    { cwd: rootDir },
  );
  assert.equal(ignored.status, 1, ignored.stderr?.toString());
  const manifest = JSON.parse(
    readFileSync(join(snapshotRoot, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.copiedPaths.includes(bunRuntimeErrorFixture), true);
});

test('the exceptional replacement flag applies only to Bun imports', () => {
  assert.deepEqual(parseImportArguments(['node']), {
    runtime: 'node',
    allowBunReplace: false,
    help: false,
  });
  assert.doesNotThrow(() => assertBunReplacementAllowed('node', false));
  assert.throws(
    () => assertBunReplacementAllowed('bun', false),
    /Refusing to replace the owned Bun-derived JavaScript tests/,
  );
  assert.throws(() => assertBunReplacementAllowed('all', false), /Bun importer reconstructs/);
  assert.doesNotThrow(() => assertBunReplacementAllowed('bun', true));
  assert.deepEqual(parseImportArguments(['bun', allowBunReplacementFlag]), {
    runtime: 'bun',
    allowBunReplace: true,
    help: false,
  });
});

test('a moved upstream tag is rejected before replacement', () => {
  assert.doesNotThrow(() => assertCheckoutCommit('bun', 'bun-v1', 'a'.repeat(40), 'a'.repeat(40)));
  assert.throws(
    () => assertCheckoutCommit('bun', 'bun-v1', 'a'.repeat(40), 'b'.repeat(40)),
    /No destination paths were changed/,
  );
});

test('a default Bun import stops before making a temporary clone', (t) => {
  const temporaryDirectory = mkdtempSync(resolve(os.tmpdir(), 'cottontail-import-guard-test-'));
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [importerPath, 'bun'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to replace the owned Bun-derived JavaScript tests/);
  assert.match(result.stderr, /read-only Bun test review command/);
  assert.deepEqual(readdirSync(temporaryDirectory), []);
});

test('Bun replacement refuses an active JavaScript baseline snapshot lock', (t) => {
  const temporaryDirectory = mkdtempSync(resolve(os.tmpdir(), 'cottontail-import-lock-test-'));
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
  const snapshotRoot = join(temporaryDirectory, 'snapshot');
  const lockRoot = join(temporaryDirectory, 'locks');
  mkdirSync(snapshotRoot);

  const scope = { kind: 'snapshot', path: realpathSync(snapshotRoot) };
  const canonicalScope = JSON.stringify(scope);
  const expectedLockPath = join(
    lockRoot,
    `${createHash('sha256').update(canonicalScope).digest('hex')}.lock`,
  );
  assert.equal(bunSnapshotLockPath(snapshotRoot, lockRoot), expectedLockPath);

  mkdirSync(expectedLockPath, { recursive: true });
  const owner = {
    schema: 1,
    token: 'active-runner-token',
    pid: process.pid,
    hostname: os.hostname(),
    activeChildren: [],
  };
  writeFileSync(join(expectedLockPath, 'owner.json'), `${JSON.stringify(owner)}\n`);

  let mutationAttempted = false;
  assert.throws(
    () => withBunSnapshotMutationLock(snapshotRoot, () => {
      mutationAttempted = true;
    }, { lockDir: lockRoot }),
    /Bun snapshot is in use by JavaScript baseline suite PID/,
  );
  assert.equal(mutationAttempted, false);
  assert.equal(existsSync(expectedLockPath), true);
  assert.equal(
    JSON.parse(readFileSync(join(expectedLockPath, 'owner.json'), 'utf8')).token,
    owner.token,
  );

  rmSync(expectedLockPath, { recursive: true, force: true });
  withBunSnapshotMutationLock(snapshotRoot, () => {
    assert.equal(existsSync(expectedLockPath), true);
    assert.equal(
      JSON.parse(readFileSync(join(expectedLockPath, 'owner.json'), 'utf8')).runtime,
      'bun-import',
    );
  }, { lockDir: lockRoot });
  assert.equal(existsSync(expectedLockPath), false);
});

test('Bun replacement leaves a stale synchronous-phase runner lock untouched', (t) => {
  const temporaryDirectory = mkdtempSync(resolve(os.tmpdir(), 'cottontail-import-sync-lock-test-'));
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
  const snapshotRoot = join(temporaryDirectory, 'snapshot');
  const lockRoot = join(temporaryDirectory, 'locks');
  mkdirSync(snapshotRoot);
  const lockPath = bunSnapshotLockPath(snapshotRoot, lockRoot);
  mkdirSync(lockPath, { recursive: true });
  const owner = {
    schema: 1,
    token: 'stale-sync-runner-token',
    pid: 2_147_483_647,
    hostname: os.hostname(),
    activeChildren: [],
    synchronousPhase: { label: 'command adapter preflight', startedAt: '2026-08-08T00:00:00.000Z' },
  };
  writeFileSync(join(lockPath, 'owner.json'), `${JSON.stringify(owner)}\n`);

  let mutationAttempted = false;
  assert.throws(
    () => withBunSnapshotMutationLock(snapshotRoot, () => {
      mutationAttempted = true;
    }, { lockDir: lockRoot }),
    /stale JavaScript baseline suite lock ended during synchronous phase.*command adapter preflight/s,
  );
  assert.equal(mutationAttempted, false);
  assert.equal(
    JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')).token,
    owner.token,
  );
});
