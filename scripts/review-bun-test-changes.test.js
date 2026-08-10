import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  addRouting,
  filterComparisonChanges,
  parseNameStatus,
  validateMetadata,
} from './review-bun-test-changes.js';
import { resolveBunStatusPlatform } from './bun-status-platform.js';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptsDir, '..');
const reviewToolPath = resolve(scriptsDir, 'review-bun-test-changes.js');
const metadataPath = resolve(rootDir, 'tests', 'upstream-review.json');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

test('review metadata freezes the Bun baseline and all routing destinations', () => {
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const snapshotRoot = resolve(rootDir, 'compat/upstream/bun/v1.3.10');
  const manifest = JSON.parse(readFileSync(resolve(snapshotRoot, 'manifest.json'), 'utf8'));
  assert.doesNotThrow(() => validateMetadata(metadata));
  assert.equal(metadata.baseline.tag, 'bun-v1.3.10');
  assert.equal(metadata.baseline.commit, '30e609e08073cf7114bfb278506962a5b19d0677');
  assert.match(metadata.lastReviewed.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(metadata.routing.allowedDestinations, [
    'cottontail',
    'hutch',
    'external',
    'out-of-scope',
  ]);
  assert.equal(metadata.routing.destinationSemantics.hutch, 'handoff-to-hutch-repository');
  for (const path of manifest.copiedPaths) {
    assert.equal(existsSync(resolve(snapshotRoot, path)), true, `missing copied path: ${path}`);
    if (path === 'LICENSE.md') continue;
    assert.equal(
      metadata.comparisonPaths.some((comparisonPath) =>
        comparisonPath === path ||
        comparisonPath.startsWith(`${path}/`) ||
        path.startsWith(`${comparisonPath}/`)),
      true,
      `copied path is outside the review closure: ${path}`,
    );
  }

  const status = JSON.parse(readFileSync(
    resolve(rootDir, metadata.routing.baselineStatusPath),
    'utf8',
  ));
  assert.equal(status.expectedCounts.runnableFiles, 1445);
  assert.equal(status.expectedCounts.enabled, 1318);
  assert.equal(status.expectedCounts.expectedFailure, 20);
  assert.equal(status.expectedCounts.skip, 107);
  assert.equal(status.expectedCounts.cottontailOwned, 1342);
  assert.equal(status.expectedCounts.hutchOwned, 103);

  const entries = Object.values(status.tests);
  assert.equal(entries.filter((entry) => entry.owner === 'hutch-package-manager').length, 103);
  assert.equal(entries.filter(
    (entry) => entry.status === 'skip' && entry.owner !== 'hutch-package-manager',
  ).length, 4);
  assert.equal(entries.reduce(
    (count, entry) => count + (entry.testNameExclusion?.testNames.length ?? 0),
    0,
  ), 31);
  const platformExclusionCases = (platform, arch) => Object.values(
    resolveBunStatusPlatform(status, platform, arch).tests,
  ).reduce(
    (count, entry) => count + (entry.testNameExclusion?.testNames.length ?? 0),
    0,
  );
  assert.equal(platformExclusionCases('linux', 'x64'), 39);
  assert.equal(platformExclusionCases('linux', 'arm64'), 45);
  assert.equal(entries.reduce(
    (count, entry) => count + Object.keys(entry.expectedFailureBundlerTests ?? {}).length,
    0,
  ), 5);

  const [newNextPagesTest] = addRouting([
    { status: 'A', path: 'test/integration/next-pages/test/new-upstream.test.ts' },
  ], metadata, status);
  assert.equal(newNextPagesTest.suggestedDestination, 'hutch');
  assert.equal(newNextPagesTest.routingBasis, 'routing-rule');
});

test('name-status parsing preserves renames and unusual paths', () => {
  assert.deepEqual(
    parseNameStatus('R091\0test/old name.ts\0test/new name.ts\0M\0test/a\tname.ts\0'),
    [
      {
        status: 'R',
        score: 91,
        previousPath: 'test/old name.ts',
        path: 'test/new name.ts',
      },
      { status: 'M', path: 'test/a\tname.ts' },
    ],
  );
});

test('current routing and mappings override frozen baseline ownership', () => {
  const baselineStatus = {
    tests: {
      'test/owned.test.ts': { status: 'enabled' },
      'test/mapped.test.ts': { status: 'enabled' },
    },
  };
  const metadata = {
    routing: {
      baselineOwnerMap: { 'cottontail-runtime': 'cottontail' },
      defaultDestination: 'cottontail',
      rules: [{ path: 'test/owned.test.ts', destination: 'external' }],
    },
    mappings: [{
      originPaths: ['test/mapped.test.ts'],
      localPaths: ['tests/js/mapped.test.ts'],
      relationship: 'externalized',
      destination: 'external',
    }],
  };
  const routed = addRouting([
    { status: 'M', path: 'test/owned.test.ts' },
    { status: 'M', path: 'test/mapped.test.ts' },
  ], metadata, baselineStatus);
  assert.equal(routed[0].suggestedDestination, 'external');
  assert.equal(routed[0].routingBasis, 'routing-rule');
  assert.equal(routed[1].suggestedDestination, 'external');
  assert.equal(routed[1].routingBasis, 'mapping');
});

test('comparison filtering retains renames that cross the recorded boundary', () => {
  assert.deepEqual(filterComparisonChanges([
    { status: 'R', previousPath: 'test/old.test.ts', path: 'src/old.test.ts' },
    { status: 'R', previousPath: 'docs/new.test.ts', path: 'test/new.test.ts' },
    { status: 'M', path: 'docs/unrelated.md' },
  ], ['test']), [
    { status: 'R', previousPath: 'test/old.test.ts', path: 'src/old.test.ts' },
    { status: 'R', previousPath: 'docs/new.test.ts', path: 'test/new.test.ts' },
  ]);
});

test('tag comparison uses a disposable no-checkout clone and leaves tests untouched', (t) => {
  const fixtureRoot = mkdtempSync(resolve(os.tmpdir(), 'cottontail-review-tool-test-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const sourceRepository = join(fixtureRoot, 'upstream');
  const temporaryCheckoutRoot = join(fixtureRoot, 'temporary-checkouts');
  mkdirSync(sourceRepository);
  mkdirSync(temporaryCheckoutRoot);

  git(sourceRepository, ['init', '--initial-branch=main']);
  git(sourceRepository, ['config', 'user.email', 'tests@cottontail.invalid']);
  git(sourceRepository, ['config', 'user.name', 'Cottontail Tests']);
  write(join(sourceRepository, 'test/js/kept.test.ts'), 'export const value = 1;\n');
  write(join(sourceRepository, 'test/js/deleted.test.ts'), 'export const removed = true;\n');
  write(join(sourceRepository, 'docs/outside.md'), 'old\n');
  git(sourceRepository, ['add', '.']);
  git(sourceRepository, ['commit', '-m', 'base']);
  git(sourceRepository, ['tag', 'base']);
  const baseCommit = git(sourceRepository, ['rev-parse', 'HEAD']);

  write(join(sourceRepository, 'test/js/kept.test.ts'), 'export const value = 2;\n');
  rmSync(join(sourceRepository, 'test/js/deleted.test.ts'));
  write(
    join(sourceRepository, 'test/cli/install/new-from-upstream.test.ts'),
    'export const packageManagerCoverage = true;\n',
  );
  write(join(sourceRepository, 'docs/outside.md'), 'new\n');
  git(sourceRepository, ['add', '--all']);
  git(sourceRepository, ['commit', '-m', 'candidate']);
  git(sourceRepository, ['tag', 'candidate']);

  const fixtureMetadataPath = join(fixtureRoot, 'upstream-review.json');
  writeFileSync(fixtureMetadataPath, JSON.stringify({
    schema: 1,
    runtime: 'bun',
    source: sourceRepository,
    comparisonPaths: ['test'],
    baseline: { version: '0.0.1', tag: 'base', commit: baseCommit },
    lastReviewed: {
      version: '0.0.1',
      tag: 'base',
      commit: baseCommit,
      reviewedAt: '2026-08-08',
    },
    routing: {
      allowedDestinations: ['cottontail', 'hutch', 'external', 'out-of-scope'],
      defaultDestination: 'cottontail',
      baselineOwnerMap: {},
      rules: [{ pathPrefix: 'test/cli/install/', destination: 'hutch' }],
      history: [],
    },
    mappings: [],
  }));

  const sourceStatusBefore = git(sourceRepository, ['status', '--short']);
  const result = spawnSync(process.execPath, [
    reviewToolPath,
    '--metadata', fixtureMetadataPath,
    '--to', 'candidate',
    '--format', 'json',
  ], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: temporaryCheckoutRoot,
      TMP: temporaryCheckoutRoot,
      TEMP: temporaryCheckoutRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.summary, { D: 1, M: 1, A: 1 });
  assert.deepEqual(
    report.changes.map(({ status, path, suggestedDestination }) => ({
      status,
      path,
      suggestedDestination,
    })),
    [
      {
        status: 'A',
        path: 'test/cli/install/new-from-upstream.test.ts',
        suggestedDestination: 'hutch',
      },
      {
        status: 'D',
        path: 'test/js/deleted.test.ts',
        suggestedDestination: 'cottontail',
      },
      {
        status: 'M',
        path: 'test/js/kept.test.ts',
        suggestedDestination: 'cottontail',
      },
    ],
  );
  assert.equal(report.changes.some((change) => change.path === 'docs/outside.md'), false);
  assert.equal(git(sourceRepository, ['status', '--short']), sourceStatusBefore);
  assert.deepEqual(readdirSync(temporaryCheckoutRoot), []);
});
