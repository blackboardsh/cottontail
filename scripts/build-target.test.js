import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArchitecture, windowsTarget, buildJobArgs } from './build-target.js';

test('Windows builds separate host and target architectures', () => {
  assert.equal(buildArchitecture('win32', 'x64', 'arm64'), 'arm64');
  assert.equal(buildArchitecture('win32', 'arm64', undefined), 'arm64');
  assert.deepEqual(windowsTarget('arm64'), { zig: 'aarch64-windows-msvc', triplet: 'arm64-windows-static', jsc: 'windows-arm64' });
  assert.equal(windowsTarget('x64').jsc, 'windows-amd64');
});

test('rejects unsupported and non-Windows cross targets', () => {
  assert.throws(() => buildArchitecture('win32', 'x64', 'ia32'), /Unsupported target/);
  assert.throws(() => buildArchitecture('linux', 'x64', 'arm64'), /Cross-compilation/);
  assert.throws(() => windowsTarget('ia32'), /Unsupported Windows/);
});

test('build concurrency can be limited on memory-constrained runners', () => {
  assert.deepEqual(buildJobArgs(''), []);
  assert.deepEqual(buildJobArgs('2'), ['-j2']);
  for (const value of ['0', '-1', '1.5', 'many']) {
    assert.throws(() => buildJobArgs(value), /positive integer/);
  }
});
