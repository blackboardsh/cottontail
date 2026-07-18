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
const executablePath = join(rootDir, 'zig-out', 'bin', executableName);

for (const [label, path] of [['release executable', executablePath]]) {
  if (!existsSync(path)) fail(`Missing ${label}: ${path}`);
}

const releaseRoot = join(rootDir, 'release');
const artifactBase = `cottontail-v${packageJson.version}-${platform}`;
const packageRoot = join(releaseRoot, artifactBase);
const archivePath = join(releaseRoot, `${artifactBase}.tar.gz`);

rmSync(packageRoot, { recursive: true, force: true });
mkdirSync(join(packageRoot, 'bin'), { recursive: true });

cpSync(executablePath, join(packageRoot, 'bin', executableName));
cpSync(join(rootDir, 'src', 'runtime_modules'), join(packageRoot, 'runtime_modules'), {
  recursive: true,
});
if (process.platform !== 'win32') {
  chmodSync(join(packageRoot, 'bin', executableName), 0o755);
}

const manifest = {
  schema: 2,
  name: packageJson.name,
  version: packageJson.version,
  platform,
  revision: gitRevision(),
  executable: `bin/${executableName}`,
  runtimeModules: 'runtime_modules',
  icu: {
    policy: 'system-first-global-data',
    minimumSystemAbi: 70,
    fallbackAbi: 70,
    fallbackDataVersion: '70.1',
  },
};
writeFileSync(join(packageRoot, 'cottontail-release.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const packagedExecutable = join(packageRoot, 'bin', executableName);
const smoke = spawnSync(packagedExecutable, ['-p', '6 * 7'], {
  cwd: packageRoot,
  encoding: 'utf8',
});
if (smoke.status !== 0 || smoke.stdout.trim() !== '42') {
  fail(`Packaged runtime smoke test failed:\n${smoke.stderr || smoke.stdout}`);
}
rmSync(join(packageRoot, '.cottontail-tmp'), { recursive: true, force: true });

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
