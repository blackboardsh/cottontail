#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, 'scripts', 'zig-html-rewriter-manifest.json'), 'utf8'),
);
const VENDOR_ROOT = join(ROOT, 'vendors', 'zig-html-rewriter');
const STAMP = join(VENDOR_ROOT, '.vendor-revision');
const EXPECTED_STAMP = `${MANIFEST.revision} ${MANIFEST.sha256}`;

function fail(message, error) {
  console.error(message);
  if (error) console.error(error.message);
  process.exit(1);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isCurrent() {
  return existsSync(join(VENDOR_ROOT, 'src', 'root.zig')) &&
    existsSync(join(VENDOR_ROOT, 'LICENSE')) &&
    existsSync(STAMP) &&
    readFileSync(STAMP, 'utf8').trim() === EXPECTED_STAMP;
}

function setup() {
  if (isCurrent()) {
    console.log(`✓ zig-html-rewriter ${MANIFEST.revision.slice(0, 12)} already vendored`);
    return;
  }

  const workRoot = join(ROOT, 'vendors', `.zig-html-rewriter-${process.pid}`);
  const archivePath = join(workRoot, 'source.tar.gz');
  const extracted = join(workRoot, 'extracted');
  const prefix = `zig-html-rewriter-${MANIFEST.revision}`;

  console.log(`Vendoring ${MANIFEST.repo}@${MANIFEST.revision.slice(0, 12)}...`);
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(extracted, { recursive: true });

  try {
    execFileSync('curl', [
      '--fail',
      '--location',
      '--retry',
      '3',
      '--output',
      archivePath,
      MANIFEST.archive,
    ], { stdio: 'inherit' });

    const actual = sha256File(archivePath);
    if (actual !== MANIFEST.sha256) {
      throw new Error(
        `Archive checksum mismatch for ${MANIFEST.repo}.\n` +
        `Expected: ${MANIFEST.sha256}\n` +
        `Actual:   ${actual}`,
      );
    }

    execFileSync('tar', [
      '-xzf',
      archivePath,
      '--strip-components=1',
      '-C',
      extracted,
      `${prefix}/src`,
      `${prefix}/LICENSE`,
      `${prefix}/THIRD_PARTY_NOTICES`,
      `${prefix}/README.md`,
      `${prefix}/COMPAT.md`,
    ], { stdio: 'inherit' });

    if (!existsSync(join(extracted, 'src', 'root.zig')) || existsSync(join(extracted, 'tests'))) {
      throw new Error('The extracted zig-html-rewriter payload is invalid.');
    }
    writeFileSync(join(extracted, '.vendor-revision'), `${EXPECTED_STAMP}\n`);

    rmSync(VENDOR_ROOT, { recursive: true, force: true });
    renameSync(extracted, VENDOR_ROOT);
    console.log('✓ zig-html-rewriter vendored without its upstream test corpus');
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

try {
  setup();
} catch (error) {
  fail('Failed to vendor zig-html-rewriter.', error);
}
