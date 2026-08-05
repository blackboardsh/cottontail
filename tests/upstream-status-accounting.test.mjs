import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkerPath = join(rootDir, 'scripts', 'check-bun-status.js');

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function baseStatus() {
  return {
    schema: 2,
    defaultStatus: 'not-enabled',
    expectedCounts: {
      runnableFiles: 3,
      enabled: 1,
      expectedFailure: 1,
      skip: 1,
      cottontailOwned: 2,
      hutchOwned: 1,
      upstreamTodoSkipSyntaxSites: 0,
      upstreamTodoSkipSyntaxFiles: 0,
    },
    tests: {
      'test/alpha.test.ts': {
        status: 'enabled',
        reason: 'fixture pass',
      },
      'test/beta.test.ts': {
        status: 'expected-failure',
        classification: 'performance',
        reason: 'fixture expected failure',
      },
      'test/gamma.test.ts': {
        status: 'skip',
        owner: 'hutch-package-manager',
        reason: 'fixture delegation',
      },
    },
  };
}

function createFixture(t) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'cottontail-status-accounting-'));
  const snapshotRoot = join(fixtureRoot, 'bun-snapshot');
  const targetsPath = join(fixtureRoot, 'targets.json');
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  for (const name of ['alpha', 'beta', 'gamma']) {
    const path = join(snapshotRoot, 'test', `${name}.test.ts`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '// accounting fixture\n');
  }
  writeJson(join(snapshotRoot, 'status.json'), baseStatus());
  writeJson(targetsPath, {
    schema: 1,
    bun: {
      version: '1.3.10-test',
      commit: '0123456789abcdef0123456789abcdef01234567',
      snapshot: snapshotRoot,
    },
  });
  return { snapshotRoot, targetsPath };
}

function runCheck(fixture) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: rootDir,
    env: {
      ...process.env,
      COTTONTAIL_UPSTREAM_TARGETS_PATH: fixture.targetsPath,
    },
    encoding: 'utf8',
  });
}

test('Bun accounting check accepts exact classifications and delegated ownership', (t) => {
  const fixture = createFixture(t);
  const result = runCheck(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /explicit status\.tests entries: 3/);
  assert.match(result.stdout, /regex fallback patterns: 0/);
  assert.match(result.stdout, /cottontail-runtime=2, hutch-package-manager=1/);
  assert.match(result.stdout, /accounting check: passed/);
});

test('newly imported Bun files remain unclassified and fail the accounting check', (t) => {
  const fixture = createFixture(t);
  writeFileSync(join(fixture.snapshotRoot, 'test', 'new-import.test.ts'), '// new import\n');
  const result = runCheck(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 runnable Bun file\(s\) are unclassified: test\/new-import\.test\.ts/);
});

test('Bun accounting rejects regex fallbacks and opaque test-name filters', (t) => {
  const fixture = createFixture(t);
  const status = baseStatus();
  status.patterns = [{
    pattern: '^test/',
    status: 'expected-failure',
    reason: 'hidden fallback',
  }];
  status.tests['test/beta.test.ts'].args = ['--test-name-pattern=^(?!hidden).*'];
  writeJson(join(fixture.snapshotRoot, 'status.json'), status);

  const result = runCheck(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /regex fallbacks classify future imports implicitly/);
  assert.match(result.stderr, /hides test names without testNameExclusion accounting/);
});
