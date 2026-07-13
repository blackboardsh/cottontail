#!/usr/bin/env node

import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.cwd();
const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), 'jsc-manifest.json');
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const JSC_ROOT = join(ROOT, 'vendors', 'jsc');

function fail(message, error) {
  console.error(message);
  if (error) {
    console.error(error.message);
  }
  process.exit(1);
}

function getPlatformKey() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin' && arch === 'arm64') {
    return 'macos-arm64';
  }

  if (platform === 'linux' && arch === 'x64') {
    return 'linux-amd64';
  }

  if (platform === 'linux' && arch === 'arm64') {
    return 'linux-arm64';
  }

  if (platform === 'win32' && arch === 'arm64') {
    return 'windows-arm64';
  }

  return null;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isCurrentJscVendored(vendorDir, stampPath, expectedStamp) {
  if (!existsSync(vendorDir) || !existsSync(stampPath)) {
    return false;
  }

  return readFileSync(stampPath, 'utf8').trim() === expectedStamp;
}

function vendorJsc() {
  const platformKey = getPlatformKey();

  if (!platformKey) {
    console.log(
      `- Skipping JavaScriptCore vendoring: no prebuilt asset for ${process.platform}/${process.arch}`
    );
    return;
  }

  const asset = MANIFEST.assets[platformKey];

  if (!asset) {
    console.log(`- Skipping JavaScriptCore vendoring: no manifest entry for ${platformKey}`);
    return;
  }

  const vendorDir = join(JSC_ROOT, MANIFEST.tag, platformKey);
  const stampPath = join(vendorDir, '.jsc-vendored');
  const expectedStamp = `${MANIFEST.tag} ${asset.sha256}`;

  if (isCurrentJscVendored(vendorDir, stampPath, expectedStamp)) {
    console.log(`✓ JavaScriptCore ${MANIFEST.tag} (${platformKey}) already vendored`);
    return;
  }

  const url = `https://github.com/${MANIFEST.repo}/releases/download/${MANIFEST.tag}/${asset.name}`;
  const archivePath = join(JSC_ROOT, asset.name);

  console.log(`Vendoring JavaScriptCore ${MANIFEST.tag} (${platformKey})...`);
  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });

  try {
    execSync(`curl -fL "${url}" -o "${archivePath}"`, { stdio: 'inherit' });

    const actualSha256 = sha256File(archivePath);
    if (actualSha256 !== asset.sha256) {
      unlinkSync(archivePath);
      fail(
        `Checksum mismatch for ${asset.name}:\n  expected ${asset.sha256}\n  actual   ${actualSha256}`
      );
    }

    execSync(`tar -xzf "${archivePath}" --strip-components=1 -C "${vendorDir}"`, {
      stdio: 'inherit',
    });
    unlinkSync(archivePath);

    const libDir = join(vendorDir, 'lib');
    const includeDir = join(vendorDir, 'include', 'JavaScriptCore');
    if (!existsSync(libDir) || !existsSync(includeDir)) {
      fail(`Vendored JavaScriptCore layout is incomplete under ${vendorDir}`);
    }

    writeFileSync(stampPath, `${expectedStamp}\n`);
    console.log(`✓ JavaScriptCore ${MANIFEST.tag} vendored at vendors/jsc/${MANIFEST.tag}/${platformKey}`);
  } catch (error) {
    fail('Failed to vendor JavaScriptCore.', error);
  }
}

vendorJsc();
