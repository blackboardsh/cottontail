import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  compareVersions,
  glibcRequirements,
  verifyLinuxGlibc,
} from './verify-linux-glibc.js';

function fixture(t, contents) {
  const directory = mkdtempSync(join(tmpdir(), 'cottontail-glibc-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binaryPath = join(directory, 'cottontail');
  writeFileSync(binaryPath, Buffer.from(contents, 'latin1'));
  return binaryPath;
}

test('glibc requirements are extracted, deduplicated, and numerically sorted', () => {
  const requirements = glibcRequirements(Buffer.from(
    'GLIBC_2.9\0GLIBC_2.26\0GLIBC_2.10\0GLIBC_2.9\0GLIBC_ABI_DT_RELR',
    'latin1',
  ));
  assert.deepEqual(requirements, {
    versions: ['2.9', '2.10', '2.26'],
    privateAbi: false,
  });
  assert.equal(compareVersions('2.26', '2.9'), 1);
  assert.equal(compareVersions('2.26.0', '2.26'), 0);
});

test('the verifier accepts the intended GLIBC 2.26 ceiling', (t) => {
  const binaryPath = fixture(t, 'GLIBC_2.2.5\0GLIBC_2.17\0GLIBC_2.26');
  assert.equal(verifyLinuxGlibc(binaryPath, '2.26'), '2.26');
});

test('the verifier rejects an ELF above the configured glibc ceiling', (t) => {
  const binaryPath = fixture(t, 'GLIBC_2.26\0GLIBC_2.38');
  assert.throws(
    () => verifyLinuxGlibc(binaryPath, '2.26'),
    /requires GLIBC_2\.38, above GLIBC_2\.26/,
  );
});

test('the verifier rejects private glibc imports', (t) => {
  const binaryPath = fixture(t, 'GLIBC_2.17\0GLIBC_PRIVATE');
  assert.throws(
    () => verifyLinuxGlibc(binaryPath, '2.26'),
    /requires the unstable GLIBC_PRIVATE ABI/,
  );
});
