import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflowPath = new URL('../.github/workflows/bun-compat.yml', import.meta.url);
const statusPath = new URL('../compat/upstream/bun/v1.3.10/status.json', import.meta.url);
const workflow = readFileSync(workflowPath, 'utf8');
const status = JSON.parse(readFileSync(statusPath, 'utf8'));

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
  assert.match(
    workflow,
    /run: node scripts\/run-upstream-tests\.js bun --include-expected-failures/,
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
