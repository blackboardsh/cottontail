#!/usr/bin/env node

import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

const rootDir = process.cwd();
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function platformKey() {
  const key = `${process.platform}-${process.arch}`;
  const keys = {
    'darwin-arm64': 'macos-arm64',
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
    'win32-x64': 'windows-x64',
  };
  return keys[key] ?? fail(`Unsupported release platform: ${key}`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitRevision() {
  if (process.env.CIRCLE_SHA1) return process.env.CIRCLE_SHA1;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const platform = platformKey();
const executableName = process.platform === 'win32' ? 'cottontail.exe' : 'cottontail';
const esbuildName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
const executablePath = join(rootDir, 'zig-out', 'bin', executableName);
const esbuildPath = join(rootDir, 'vendors', 'esbuild', esbuildName);
const runtimeModulesPath = join(rootDir, 'src', 'runtime_modules');

for (const [label, path] of [
  ['release executable', executablePath],
  ['runtime modules', runtimeModulesPath],
]) {
  if (!existsSync(path)) fail(`Missing ${label}: ${path}`);
}

if (!existsSync(esbuildPath)) {
  const smokePath = join(rootDir, '.zig-cache', 'release-esbuild-smoke.ts');
  mkdirSync(join(rootDir, '.zig-cache'), { recursive: true });
  writeFileSync(smokePath, 'const value: number = 42; console.log(value);\n');
  const provision = spawnSync(executablePath, [smokePath], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  rmSync(smokePath, { force: true });
  if (provision.status !== 0 || provision.stdout.trim() !== '42' || !existsSync(esbuildPath)) {
    fail(`Failed to provision esbuild with the release executable:\n${provision.stderr || provision.stdout}`);
  }
}

const releaseRoot = join(rootDir, 'release');
const artifactBase = `cottontail-v${packageJson.version}-${platform}`;
const packageRoot = join(releaseRoot, artifactBase);
const archivePath = join(releaseRoot, `${artifactBase}.tar.gz`);

rmSync(packageRoot, { recursive: true, force: true });
mkdirSync(join(packageRoot, 'bin'), { recursive: true });
mkdirSync(join(packageRoot, 'src'), { recursive: true });
mkdirSync(join(packageRoot, 'vendors', 'esbuild'), { recursive: true });

cpSync(executablePath, join(packageRoot, 'bin', executableName));
cpSync(runtimeModulesPath, join(packageRoot, 'src', 'runtime_modules'), { recursive: true });
cpSync(join(rootDir, 'vendors', 'esbuild'), join(packageRoot, 'vendors', 'esbuild'), {
  recursive: true,
});
if (process.platform !== 'win32') {
  chmodSync(join(packageRoot, 'bin', executableName), 0o755);
  chmodSync(join(packageRoot, 'vendors', 'esbuild', esbuildName), 0o755);
}

const manifest = {
  schema: 1,
  name: packageJson.name,
  version: packageJson.version,
  platform,
  revision: gitRevision(),
  executable: `bin/${executableName}`,
  runtimeModules: 'src/runtime_modules',
  esbuild: `vendors/esbuild/${esbuildName}`,
};
writeFileSync(join(packageRoot, 'cottontail-release.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const packagedExecutable = join(packageRoot, 'bin', executableName);
const smoke = spawnSync(packagedExecutable, ['-p', '6 * 7'], {
  cwd: packageRoot,
  env: { ...process.env, COTTONTAIL_HOME: packageRoot },
  encoding: 'utf8',
});
if (smoke.status !== 0 || smoke.stdout.trim() !== '42') {
  fail(`Packaged runtime smoke test failed:\n${smoke.stderr || smoke.stdout}`);
}

rmSync(archivePath, { force: true });
const tar = spawnSync('tar', ['-czf', archivePath, '-C', releaseRoot, basename(packageRoot)], {
  cwd: rootDir,
  encoding: 'utf8',
});
if (tar.status !== 0) fail(`Failed to create ${archivePath}:\n${tar.stderr || tar.stdout}`);

const digest = sha256(archivePath);
writeFileSync(`${archivePath}.sha256`, `${digest}  ${basename(archivePath)}\n`);
rmSync(packageRoot, { recursive: true, force: true });

console.log(JSON.stringify({ archive: archivePath, sha256: digest }, null, 2));
