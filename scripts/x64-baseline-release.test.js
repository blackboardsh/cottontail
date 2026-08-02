import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASELINE_CPU_ARG,
  WINDOWS_X64_TARGET_ARG,
  releaseTargetArgs,
} from './release-target.js';

test('every Cottontail release platform targets a baseline CPU', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const args = releaseTargetArgs(platform);
    assert.equal(args.filter((arg) => arg === BASELINE_CPU_ARG).length, 1);
    assert.ok(!args.includes('-Dcpu=native'));
  }
});

test('the Windows release fixes both its x64 ABI and baseline CPU', () => {
  assert.deepEqual(releaseTargetArgs('win32'), [
    WINDOWS_X64_TARGET_ARG,
    BASELINE_CPU_ARG,
  ]);
});

test('unsupported release hosts fail instead of inheriting a native CPU', () => {
  assert.throws(() => releaseTargetArgs('freebsd'), /Unsupported Cottontail release platform/);
});
