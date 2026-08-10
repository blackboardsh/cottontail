import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyBunStatusEntryOverride,
  bunStatusPlatformKey,
  resolveBunStatusPlatform,
  validateBunStatusPlatformOverrides,
} from './bun-status-platform.js';

test('resolves only the exact platform-architecture status override', () => {
  const status = {
    tests: {
      'test/example.test.ts': {
        status: 'enabled',
        reason: 'portable baseline',
        args: ['--timeout=1000'],
      },
    },
    platformOverrides: {
      'linux-arm64': {
        tests: {
          'test/example.test.ts': {
            reason: 'Linux ARM64 timing budget',
            args: ['--timeout=2000'],
          },
        },
      },
    },
  };

  const linuxArm64 = resolveBunStatusPlatform(status, 'linux', 'arm64');
  assert.equal(linuxArm64.tests['test/example.test.ts'].status, 'enabled');
  assert.equal(linuxArm64.tests['test/example.test.ts'].reason, 'Linux ARM64 timing budget');
  assert.deepEqual(linuxArm64.tests['test/example.test.ts'].args, ['--timeout=2000']);

  const linuxX64 = resolveBunStatusPlatform(status, 'linux', 'x64');
  assert.strictEqual(linuxX64, status);
  assert.equal(linuxX64.tests['test/example.test.ts'].reason, 'portable baseline');
});

test('null removes a baseline field without mutating the source entry', () => {
  const entry = { status: 'enabled', args: ['--timeout=1000'] };
  const resolved = applyBunStatusEntryOverride(entry, { args: null, serial: true });
  assert.deepEqual(resolved, { status: 'enabled', serial: true });
  assert.deepEqual(entry, { status: 'enabled', args: ['--timeout=1000'] });
});

test('validates exact platform keys and known status paths', () => {
  const status = {
    tests: { 'test/example.test.ts': { status: 'enabled' } },
    platformOverrides: {
      [bunStatusPlatformKey('linux', 'x64')]: {
        tests: { 'test/example.test.ts': { timeoutMs: 2000 } },
      },
    },
  };
  assert.deepEqual(validateBunStatusPlatformOverrides(status), []);

  status.platformOverrides['linux-amd64'] = {
    tests: { 'test/stale.test.ts': { timeoutMs: 2000 } },
  };
  assert.deepEqual(validateBunStatusPlatformOverrides(status), [
    'status.platformOverrides has invalid platform key linux-amd64',
    'status.platformOverrides.linux-amd64.tests contains an unknown path: test/stale.test.ts',
  ]);
});
