#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'fs';
import { createRequire } from 'module';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(rootDir, 'compat', 'upstream', 'fixtures', 'duckdb-1.3.1.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function defaultSnapshotRoot() {
  const targets = readJson(join(rootDir, 'compat', 'upstream', 'targets.json'));
  if (!targets.bun?.snapshot) fail('The Bun upstream snapshot is not configured.');
  return resolve(rootDir, targets.bun.snapshot);
}

function parseArgs(argv) {
  let snapshotRoot = defaultSnapshotRoot();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--snapshot') {
      const value = argv[++index];
      if (!value) fail('--snapshot requires a path');
      snapshotRoot = resolve(rootDir, value);
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node scripts/setup-upstream-duckdb.js [--snapshot <path>]',
        '',
        'Installs the verified DuckDB native addon required by the Bun 1.3.10 upstream test.',
        'The duckdb JavaScript package must already be installed from the snapshot lockfile.',
      ].join('\n'));
      process.exit(0);
    } else {
      fail(`Unknown option: ${arg}`);
    }
  }
  return { snapshotRoot };
}

function isMusl() {
  if (process.platform !== 'linux') return false;
  return !process.report?.getReport()?.header?.glibcVersionRuntime;
}

function skippedPlatformReason() {
  if (isMusl()) return 'DuckDB 1.3.1 does not publish musl addons';
  if (process.platform === 'win32' && process.arch === 'arm64') {
    return 'DuckDB 1.3.1 does not publish a Windows ARM64 addon';
  }
  return null;
}

function resolveDuckDBPackage(snapshotRoot) {
  const testRoot = join(snapshotRoot, 'test');
  const testPackagePath = join(testRoot, 'package.json');
  if (!existsSync(testPackagePath)) {
    fail(`Bun upstream test package not found at ${testPackagePath}`);
  }

  let packagePath;
  try {
    packagePath = createRequire(testPackagePath).resolve('duckdb/package.json');
  } catch {
    fail(
      `duckdb@${manifest.version} is not installed under ${testRoot}. ` +
      'Restore the snapshot dependencies from its frozen bun.lock first.'
    );
  }

  const packageJson = readJson(packagePath);
  const expectedBinary = packageJson.binary?.module_name === 'duckdb' &&
    packageJson.binary?.module_path === './lib/binding/' &&
    packageJson.binary?.host === manifest.host;
  if (packageJson.name !== manifest.package || packageJson.version !== manifest.version || !expectedBinary) {
    fail(
      `Unexpected DuckDB package at ${packagePath}; expected duckdb@${manifest.version} ` +
      `with the published ${manifest.host} binary layout.`
    );
  }

  return { packagePath, packageRoot: dirname(packagePath) };
}

function verifiedArchive(artifact) {
  const cacheRoot = resolve(
    process.env.COTTONTAIL_UPSTREAM_FIXTURE_CACHE ??
      join(rootDir, 'node_modules', '.cache', 'cottontail-upstream-fixtures')
  );
  const archivePath = join(cacheRoot, artifact.archive);
  if (existsSync(archivePath) && sha256File(archivePath) === artifact.sha256) return archivePath;

  mkdirSync(cacheRoot, { recursive: true });
  rmSync(archivePath, { force: true });
  const temporaryPath = `${archivePath}.${process.pid}.tmp`;
  rmSync(temporaryPath, { force: true });
  const url = `${manifest.host}/${artifact.archive}`;

  console.log(`Downloading ${url}`);
  try {
    execFileSync('curl', [
      '--fail',
      '--location',
      '--retry',
      '3',
      '--output',
      temporaryPath,
      url,
    ], { stdio: 'inherit' });
    const actualSha256 = sha256File(temporaryPath);
    if (actualSha256 !== artifact.sha256) {
      fail(
        `DuckDB archive checksum mismatch for ${artifact.archive}.\n` +
        `Expected: ${artifact.sha256}\n` +
        `Actual:   ${actualSha256}`
      );
    }
    renameSync(temporaryPath, archivePath);
    return archivePath;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

async function extractModule(packagePath, packageRoot, artifact, archivePath) {
  const nodePreGypPackage = createRequire(packagePath).resolve('@mapbox/node-pre-gyp/package.json');
  const tar = createRequire(nodePreGypPackage)('tar');
  const modulePath = join(packageRoot, ...manifest.modulePath.split('/'));
  const moduleDir = dirname(modulePath);
  mkdirSync(moduleDir, { recursive: true });
  const stagingDir = mkdtempSync(join(moduleDir, '.cottontail-duckdb-'));
  const stagedModule = join(stagingDir, basename(manifest.archiveEntry));
  let matchedEntries = 0;

  try {
    await tar.x({
      cwd: stagingDir,
      file: archivePath,
      preserveOwner: false,
      strip: 1,
      filter(path) {
        const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
        if (normalized !== manifest.archiveEntry) return false;
        matchedEntries += 1;
        return true;
      },
    });
    if (matchedEntries !== 1 || !existsSync(stagedModule)) {
      fail(`Expected exactly ${manifest.archiveEntry} in ${artifact.archive}.`);
    }
    const actualModuleSha256 = sha256File(stagedModule);
    if (actualModuleSha256 !== artifact.moduleSha256) {
      fail(
        `DuckDB native addon checksum mismatch after extracting ${artifact.archive}.\n` +
        `Expected: ${artifact.moduleSha256}\n` +
        `Actual:   ${actualModuleSha256}`
      );
    }

    rmSync(modulePath, { force: true });
    renameSync(stagedModule, modulePath);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  return modulePath;
}

export async function setupDuckDBFixture(snapshotRoot = defaultSnapshotRoot()) {
  const skipReason = skippedPlatformReason();
  if (skipReason) {
    console.log(`Skipping DuckDB native fixture: ${skipReason}.`);
    return null;
  }

  const platformKey = `${process.platform}-${process.arch}`;
  const artifact = manifest.artifacts[platformKey];
  if (!artifact) {
    fail(`No DuckDB ${manifest.version} native fixture is pinned for ${platformKey}.`);
  }
  const expectedArchive =
    `${manifest.package}-v${manifest.version}-node-v${manifest.nodeAbi}-${platformKey}.tar.gz`;
  if (artifact.archive !== expectedArchive) {
    fail(`DuckDB fixture manifest archive mismatch: expected ${expectedArchive}.`);
  }

  const { packagePath, packageRoot } = resolveDuckDBPackage(resolve(snapshotRoot));
  const modulePath = join(packageRoot, ...manifest.modulePath.split('/'));
  if (existsSync(modulePath) && sha256File(modulePath) === artifact.moduleSha256) {
    console.log(`DuckDB ${manifest.version} native fixture already verified for ${platformKey}.`);
    return modulePath;
  }

  const archivePath = verifiedArchive(artifact);
  const installedPath = await extractModule(packagePath, packageRoot, artifact, archivePath);
  console.log(`Installed verified DuckDB ${manifest.version} native fixture for ${platformKey}.`);
  return installedPath;
}

async function main() {
  const { snapshotRoot } = parseArgs(process.argv.slice(2));
  await setupDuckDBFixture(snapshotRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
