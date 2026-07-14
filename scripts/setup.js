#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const MANIFEST_PATH = join(ROOT, 'scripts', 'zig-manifest.json');
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const ZIG_VERSION = MANIFEST.version;
const ZIG_DIR = join(ROOT, 'vendors', 'zig');
const ZIG_VERSION_STAMP = join(ZIG_DIR, '.zig-version');
const ZIG_VENDOR_STAMP = join(ZIG_DIR, '.zig-vendored');

function fail(message, error) {
  console.error(message);
  if (error) {
    console.error(error.message);
  }
  process.exit(1);
}

function getZigBinaryName() {
  return process.platform === 'win32' ? 'zig.exe' : 'zig';
}

function getPlatformKey() {
  return `${process.platform}-${process.arch}`;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hasExpectedZigVersion(zigBinaryPath) {
  try {
    return execFileSync(zigBinaryPath, ['version'], { encoding: 'utf8' }).trim() === ZIG_VERSION;
  } catch {
    return false;
  }
}

function isCurrentZigVendored(expectedVendorStamp) {
  const zigBinaryPath = join(ZIG_DIR, getZigBinaryName());

  if (
    !existsSync(zigBinaryPath) ||
    !existsSync(ZIG_VERSION_STAMP) ||
    !existsSync(ZIG_VENDOR_STAMP)
  ) {
    return false;
  }

  return readFileSync(ZIG_VERSION_STAMP, 'utf8').trim() === ZIG_VERSION &&
    readFileSync(ZIG_VENDOR_STAMP, 'utf8').trim() === expectedVendorStamp &&
    hasExpectedZigVersion(zigBinaryPath);
}

function resetVendorDir() {
  rmSync(ZIG_DIR, { recursive: true, force: true });
  mkdirSync(ZIG_DIR, { recursive: true });
}

function vendorZig() {
  const platformKey = getPlatformKey();
  const asset = MANIFEST.assets[platformKey];
  if (!asset) {
    if (process.platform === 'win32' && process.arch === 'arm64') {
      fail('No Windows ARM64 Zig is pinned. Install and run x64 Node so setup selects the x86-64 toolchain.');
    }
    fail(`No Zig ${ZIG_VERSION} asset is pinned for ${platformKey}`);
  }

  const expectedVendorStamp = `${ZIG_VERSION} ${platformKey} ${asset.sha256}`;
  if (isCurrentZigVendored(expectedVendorStamp)) {
    console.log(`✓ Zig ${ZIG_VERSION} already vendored`);
    return;
  }

  const zigBinaryName = getZigBinaryName();
  const { folder, archive } = asset;
  const zigBinaryPath = join(ZIG_DIR, zigBinaryName);
  const archivePath = join(ROOT, 'vendors', archive === 'zip' ? 'zig.zip' : 'zig.tar.xz');
  const tempDir = join(ROOT, 'vendors', 'zig-temp');
  const url = `https://ziglang.org/download/${ZIG_VERSION}/${folder}.${archive}`;

  console.log(`Vendoring Zig ${ZIG_VERSION} for ${platformKey}...`);
  mkdirSync(join(ROOT, 'vendors'), { recursive: true });

  try {
    execFileSync('curl', ['-fL', url, '-o', archivePath], { stdio: 'inherit' });

    const actualSha256 = sha256File(archivePath);
    if (actualSha256 !== asset.sha256) {
      throw new Error(
        `The Zig archive checksum does not match scripts/zig-manifest.json.\n` +
          `Asset:    ${url}\n` +
          `Expected: ${asset.sha256}\n` +
          `Actual:   ${actualSha256}`
      );
    }

    resetVendorDir();

    if (archive === 'tar.xz') {
      execFileSync('tar', [
        '-xJf',
        archivePath,
        '--strip-components=1',
        '-C',
        ZIG_DIR,
        `${folder}/zig`,
        `${folder}/lib`,
        `${folder}/doc`,
      ], { stdio: 'inherit' });
    } else {
      rmSync(tempDir, { recursive: true, force: true });
      execFileSync('powershell', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Expand-Archive -LiteralPath $env:COTTONTAIL_ZIG_ARCHIVE -DestinationPath $env:COTTONTAIL_ZIG_TEMP -Force',
      ], {
        stdio: 'inherit',
        env: {
          ...process.env,
          COTTONTAIL_ZIG_ARCHIVE: archivePath,
          COTTONTAIL_ZIG_TEMP: tempDir,
        },
      });
      const extractedDir = join(tempDir, folder);
      renameSync(join(extractedDir, 'zig.exe'), join(ZIG_DIR, 'zig.exe'));
      renameSync(join(extractedDir, 'lib'), join(ZIG_DIR, 'lib'));
      const docDir = join(extractedDir, 'doc');
      if (existsSync(docDir)) renameSync(docDir, join(ZIG_DIR, 'doc'));
    }

    if (!existsSync(zigBinaryPath)) {
      throw new Error(`Vendored Zig binary not found at ${zigBinaryPath}`);
    }

    if (process.platform !== 'win32') {
      chmodSync(zigBinaryPath, 0o755);
    }

    if (!hasExpectedZigVersion(zigBinaryPath)) {
      throw new Error(`Vendored Zig binary does not report version ${ZIG_VERSION}`);
    }

    writeFileSync(ZIG_VERSION_STAMP, `${ZIG_VERSION}\n`);
    writeFileSync(ZIG_VENDOR_STAMP, `${expectedVendorStamp}\n`);
    console.log(`✓ Zig ${ZIG_VERSION} vendored for ${process.platform}/${process.arch}`);
  } finally {
    if (existsSync(archivePath)) unlinkSync(archivePath);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function setup() {
  try {
    vendorZig();
  } catch (error) {
    fail('Failed to vendor Zig.', error);
  }
  console.log(`\nSetup complete. Vendored Zig is ready at vendors/zig/${getZigBinaryName()}`);
}

setup();
