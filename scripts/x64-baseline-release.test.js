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
  assert.deepEqual(releaseTargetArgs('win32', 'x64'), [
    WINDOWS_X64_TARGET_ARG,
    BASELINE_CPU_ARG,
  ]);
});

test('the Windows ARM64 release selects its MSVC ABI and baseline CPU', () => {
  assert.deepEqual(releaseTargetArgs('win32', 'arm64'), ['-Dtarget=aarch64-windows-msvc', BASELINE_CPU_ARG]);
});

test('unsupported release hosts fail instead of inheriting a native CPU', () => {
  assert.throws(() => releaseTargetArgs('freebsd'), /Unsupported Cottontail release platform/);
});


test('both macOS releases fix their architecture and macOS 14 deployment baseline', () => {
  for (const [arch, cpu] of [['x64', 'x86_64'], ['arm64', 'aarch64']]) {
    assert.deepEqual(releaseTargetArgs('darwin', arch), [`-Dtarget=${cpu}-macos.14.0`, BASELINE_CPU_ARG]);
  }
  assert.throws(() => releaseTargetArgs('darwin', 'ia32'), /Unsupported macOS architecture/);
});
