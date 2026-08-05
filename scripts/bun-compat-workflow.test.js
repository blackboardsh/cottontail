import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflowPath = new URL('../.github/workflows/bun-compat.yml', import.meta.url);
const hutchManifestPath = new URL('../compat/upstream/hutch.json', import.meta.url);
const hutchSetupPath = new URL('./setup-upstream-hutch.js', import.meta.url);
const statusPath = new URL('../compat/upstream/bun/v1.3.10/status.json', import.meta.url);
// Windows runners may check the repository out with CRLF line endings;
// normalize so the contract regexes match regardless of checkout config.
const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const workflow = readText(workflowPath);
const hutchManifest = JSON.parse(readText(hutchManifestPath));
const hutchSetup = readText(hutchSetupPath);
const status = JSON.parse(readText(statusPath));

function workflowTriggers(source) {
  const end = source.indexOf('\npermissions:');
  assert.notEqual(end, -1, 'workflow must declare permissions after its triggers');
  return source.slice(0, end);
}

function countFromList(output, label) {
  const match = output.match(new RegExp(`^  ${label}: (\\d+)`, 'm'));
  assert.ok(match, `missing ${label} count in upstream runner output`);
  return Number(match[1]);
}

test('runs only for compat branches and manual dispatch', () => {
  const triggers = workflowTriggers(workflow);
  assert.match(triggers, /^on:\n  push:\n    branches:\n      - "compat\/\*\*"\n  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(triggers, /\btags:|\bpull_request:|\bschedule:/);
});

test('runs the strict complete Cottontail-owned Bun tier without publishing', () => {
  for (const platform of ['macos-arm64', 'linux-x64', 'linux-arm64', 'windows-x64']) {
    assert.match(workflow, new RegExp(`platform: ${platform}`));
  }
  assert.match(workflow, /runner: macos-26/);
  assert.match(workflow, /runner: ubuntu-24\.04/);
  assert.match(workflow, /runner: ubuntu-24\.04-arm/);
  assert.match(workflow, /runner: windows-2025/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(
    workflow,
    /node scripts\/zig\.js build -Doptimize=ReleaseSmall -Dcpu=baseline/,
  );
  assert.match(
    workflow,
    /node scripts\/zig\.js build -Doptimize=ReleaseSmall -Dtarget=x86_64-windows-msvc -Dcpu=baseline/,
  );
  assert.match(workflow, /run: node scripts\/zig\.js build test/);
  assert.match(workflow, /run: node scripts\/test-js\.js/);
  assert.match(
    workflow,
    /run: node scripts\/run-upstream-tests\.js bun --hutch "\$HUTCH_ENGINE"/,
  );
  assert.doesNotMatch(workflow, /continue-on-error:|upload-release-r2|publish|secrets\./i);

  const hutchOwned = Object.values(status.tests ?? {}).filter(
    (entry) => entry.owner === 'hutch-package-manager',
  );
  assert.ok(hutchOwned.length > 0, 'expected an explicit Hutch-owned tier');
  assert.ok(
    hutchOwned.every((entry) => entry.status === 'skip' || entry.status === 'disabled'),
    'Hutch-owned files must remain excluded from Cottontail execution',
  );

  const output = execFileSync(
    process.execPath,
    ['scripts/run-upstream-tests.js', 'bun', '--list'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  const discovered = countFromList(output, 'discovered runnable files');
  const enabled = countFromList(output, 'enabled');
  const expectedFailures = countFromList(output, 'expected-failure');
  const disabled = countFromList(output, 'disabled');
  const notEnabled = countFromList(output, 'not-enabled');

  assert.equal(disabled, hutchOwned.length);
  assert.equal(notEnabled, 0);
  assert.equal(discovered - disabled, enabled + expectedFailures);
});

test('builds and passes the pinned Hutch engine to split package fixtures', () => {
  assert.match(hutchManifest.repository, /^https:\/\/github\.com\/[^/]+\/hutch\.git$/);
  assert.match(hutchManifest.commit, /^[0-9a-f]{40}$/);
  assert.match(hutchSetup, /process\.platform === 'win32' \? 'hutch-engine\.exe' : 'hutch-engine'/);
  assert.doesNotMatch(hutchSetup, /command -v|which\(|["']PATH["']/);

  assert.match(workflow, /shell: bash\s+run: \|\s+hutch_engine="\$\(node scripts\/setup-upstream-hutch\.js\)"/);
  assert.match(workflow, /hutch_engine="\$\(node scripts\/setup-upstream-hutch\.js\)"/);
  assert.equal(
    workflow.match(/HUTCH_ENGINE: \$\{\{ steps\.hutch-engine\.outputs\.binary \}\}/g)?.length,
    2,
    'both the complete tier and focused package cases must use the pinned Hutch engine',
  );
  assert.match(
    workflow,
    /--hutch "\$HUTCH_ENGINE" --test test\/bundler\/bundler_defer\.test\.ts --case '\^\\\$file\$' --expect-pass --jobs 1/,
  );
  assert.match(
    workflow,
    /--hutch "\$HUTCH_ENGINE" --test test\/bundler\/bundler_npm\.test\.ts --case '\^npm\/ReactSSR\$' --expect-pass --jobs 1/,
  );
  assert.match(
    workflow,
    /--hutch "\$HUTCH_ENGINE" --test test\/bundler\/bundler_npm\.test\.ts --case '\^npm\/LodashES\$' --expect-pass --jobs 1/,
  );
});
