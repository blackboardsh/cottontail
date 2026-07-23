#!/usr/bin/env node

import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

const rootDir = process.cwd();
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const jscManifest = JSON.parse(readFileSync(join(rootDir, 'scripts', 'jsc-manifest.json'), 'utf8'));

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
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  if (process.env.CIRCLE_SHA1) return process.env.CIRCLE_SHA1;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const platform = platformKey();
const jscPlatform = {
  'macos-arm64': 'macos-arm64',
  'linux-x64': 'linux-amd64',
  'linux-arm64': 'linux-arm64',
  'windows-x64': 'windows-amd64',
}[platform];
const executableName = process.platform === 'win32' ? 'cottontail.exe' : 'cottontail';
const executablePath = join(rootDir, 'zig-out', 'bin', executableName);
const icuData = jscManifest.icuFallback;
const icuLicenseName = 'LICENSE';
const icuDataSource = join(
  rootDir,
  'vendors',
  'jsc',
  jscManifest.tag,
  jscPlatform,
  'lib',
  'cottontail-icu',
  icuData.dataFile,
);
const icuLicenseSource = join(
  rootDir,
  'vendors',
  'jsc',
  jscManifest.tag,
  jscPlatform,
  'lib',
  'cottontail-icu',
  icuLicenseName,
);

for (const [label, path] of [
  ['release executable', executablePath],
  ['pinned ICU fallback data', icuDataSource],
  ['ICU fallback license', icuLicenseSource],
]) {
  if (!existsSync(path)) fail(`Missing ${label}: ${path}`);
}
if (statSync(icuDataSource).size !== icuData.dataSize || sha256(icuDataSource) !== icuData.dataSha256) {
  fail(`Pinned ICU fallback data failed verification: ${icuDataSource}`);
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
const packagedIcuRelativePath = `share/cottontail/icu/${icuData.version}/${icuData.dataFile}`;
const packagedIcuLicenseRelativePath = `share/cottontail/icu/${icuData.version}/${icuLicenseName}`;
const packagedIcuPath = join(packageRoot, ...packagedIcuRelativePath.split('/'));
mkdirSync(join(packageRoot, 'share', 'cottontail', 'icu', icuData.version), { recursive: true });
cpSync(icuDataSource, packagedIcuPath);
cpSync(
  icuLicenseSource,
  join(packageRoot, ...packagedIcuLicenseRelativePath.split('/')),
);
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
    policy: 'system-first-packaged-data',
    minimumSystemAbi: icuData.abi,
    fallbackAbi: icuData.abi,
    fallbackDataVersion: icuData.version,
    fallbackData: packagedIcuRelativePath,
    fallbackLicense: packagedIcuLicenseRelativePath,
    fallbackDataSha256: icuData.dataSha256,
    fallbackDataSize: icuData.dataSize,
  },
};
writeFileSync(join(packageRoot, 'cottontail-release.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const packagedExecutable = join(packageRoot, 'bin', executableName);
if (sha256(packagedExecutable) !== sha256(executablePath)) {
  fail('Packaged executable differs from the release executable after copying.');
}

const smokeCommand = process.platform === 'win32' ? 'powershell.exe' : packagedExecutable;
const smokeArgs = process.platform === 'win32'
  ? [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "& $env:COTTONTAIL_PACKAGED_EXECUTABLE -p '6 * 7'; exit $LASTEXITCODE",
    ]
  : ['-p', '6 * 7'];
const smoke = spawnSync(smokeCommand, smokeArgs, {
  cwd: packageRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    COTTONTAIL_PACKAGED_EXECUTABLE: packagedExecutable,
  },
});
if (smoke.status !== 0 || smoke.stdout.trim() !== '42') {
  const status = smoke.status == null
    ? 'none'
    : `${smoke.status} (0x${(smoke.status >>> 0).toString(16).padStart(8, '0')})`;
  fail([
    'Packaged runtime smoke test failed.',
    `command: ${smokeCommand}`,
    `status: ${status}`,
    `signal: ${smoke.signal ?? 'none'}`,
    `error: ${smoke.error?.stack ?? 'none'}`,
    `stdout: ${JSON.stringify(smoke.stdout ?? '')}`,
    `stderr: ${JSON.stringify(smoke.stderr ?? '')}`,
  ].join('\n'));
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
