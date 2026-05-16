#!/usr/bin/env node

import { execSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

const ZIG_VERSION = '0.16.0';
const ROOT = process.cwd();
const ZIG_DIR = join(ROOT, 'vendors', 'zig');
const ZIG_VERSION_STAMP = join(ZIG_DIR, '.zig-version');

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

function getHostArch() {
  if (process.arch === 'arm64') {
    return 'aarch64';
  }

  if (process.arch === 'x64') {
    return 'x86_64';
  }

  throw new Error(`Unsupported architecture: ${process.arch}`);
}

function getHostPlatform() {
  if (process.platform === 'darwin') {
    return { os: 'macos', archive: 'tar.xz' };
  }

  if (process.platform === 'linux') {
    return { os: 'linux', archive: 'tar.xz' };
  }

  if (process.platform === 'win32') {
    return { os: 'windows', archive: 'zip' };
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

function isCurrentZigVendored() {
  const zigBinaryPath = join(ZIG_DIR, getZigBinaryName());

  if (!existsSync(zigBinaryPath) || !existsSync(ZIG_VERSION_STAMP)) {
    return false;
  }

  return readFileSync(ZIG_VERSION_STAMP, 'utf8').trim() === ZIG_VERSION;
}

function resetVendorDir() {
  rmSync(ZIG_DIR, { recursive: true, force: true });
  mkdirSync(ZIG_DIR, { recursive: true });
}

function vendorZig() {
  if (isCurrentZigVendored()) {
    console.log(`✓ Zig ${ZIG_VERSION} already vendored`);
    return;
  }

  const zigBinaryName = getZigBinaryName();
  const arch = getHostArch();
  const { os, archive } = getHostPlatform();
  const folder = `zig-${arch}-${os}-${ZIG_VERSION}`;
  const zigBinaryPath = join(ZIG_DIR, zigBinaryName);

  console.log(`Vendoring Zig ${ZIG_VERSION}...`);
  resetVendorDir();

  try {
    if (archive === 'tar.xz') {
      const url = `https://ziglang.org/download/${ZIG_VERSION}/${folder}.tar.xz`;
      execSync(
        `curl -L ${url} | tar -xJ --strip-components=1 -C vendors/zig ${folder}/zig ${folder}/lib ${folder}/doc`,
        { stdio: 'inherit' }
      );
    } else {
      const zipPath = join(ROOT, 'vendors', 'zig.zip');
      const tempDir = join(ROOT, 'vendors', 'zig-temp');

      execSync(
        `curl -L https://ziglang.org/download/${ZIG_VERSION}/${folder}.zip -o vendors/zig.zip`,
        { stdio: 'inherit' }
      );
      execSync(
        `powershell -ExecutionPolicy Bypass -Command "Expand-Archive -Path 'vendors/zig.zip' -DestinationPath 'vendors/zig-temp' -Force"`,
        { stdio: 'inherit' }
      );
      execSync(
        `powershell -ExecutionPolicy Bypass -Command "Move-Item -Path 'vendors/zig-temp\\${folder}\\zig.exe' -Destination 'vendors\\zig' -Force; Move-Item -Path 'vendors/zig-temp\\${folder}\\lib' -Destination 'vendors\\zig' -Force; if (Test-Path 'vendors/zig-temp\\${folder}\\doc') { Move-Item -Path 'vendors/zig-temp\\${folder}\\doc' -Destination 'vendors\\zig' -Force }"`,
        { stdio: 'inherit' }
      );

      if (existsSync(zipPath)) {
        unlinkSync(zipPath);
      }

      rmSync(tempDir, { recursive: true, force: true });
    }

    if (!existsSync(zigBinaryPath)) {
      fail(`Vendored Zig binary not found at ${zigBinaryPath}`);
    }

    if (process.platform !== 'win32') {
      chmodSync(zigBinaryPath, 0o755);
    }

    writeFileSync(ZIG_VERSION_STAMP, `${ZIG_VERSION}\n`);
    console.log(`✓ Zig ${ZIG_VERSION} vendored for ${process.platform}/${process.arch}`);
  } catch (error) {
    fail('Failed to vendor Zig.', error);
  }
}

function setup() {
  vendorZig();
  console.log('\nSetup complete. You can now run: bun run build');
}

setup();
