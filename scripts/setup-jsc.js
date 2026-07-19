#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { cpus } from 'os';
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

  if (platform === 'win32' && arch === 'x64') {
    return 'windows-amd64';
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

function exec(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
}

function downloadFile(url, destination) {
  exec('curl', [
    '--fail',
    '--location',
    '--retry',
    '3',
    '--output',
    destination,
    url,
  ]);
}

function fallbackLibraryNames(platformKey) {
  if (platformKey.startsWith('windows-')) {
    return ['icudata.lib', 'icuuc.lib', 'icui18n.lib'];
  }
  return ['libicudata.a', 'libicuuc.a', 'libicui18n.a'];
}

function validFallbackDirectory(fallbackDir, platformKey) {
  return fallbackLibraryNames(platformKey).every((name) => {
    const path = join(fallbackDir, name);
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  });
}

function validIcuHeaders(vendorDir) {
  const unicodeDir = join(vendorDir, 'include', 'unicode');
  return ['uchar.h', 'ucol.h', 'utypes.h'].every((name) => {
    const path = join(unicodeDir, name);
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  });
}

function ensureIcuHeaders(vendorDir) {
  if (validIcuHeaders(vendorDir)) return;

  const fallback = MANIFEST.icuFallback;
  const workDir = join(JSC_ROOT, `.icu-headers-${fallback.version}`);
  const archivePath = join(workDir, `icu4c-${fallback.version}-src.tgz`);
  const includeDir = join(vendorDir, 'include');

  console.log(`Vendoring pinned ICU ${fallback.version} headers...`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(includeDir, { recursive: true });

  try {
    downloadFile(fallback.source, archivePath);
    const actualSha256 = sha256File(archivePath);
    if (actualSha256 !== fallback.sha256) {
      fail(
        `The pinned ICU source archive failed verification.\n` +
          `Expected: ${fallback.sha256}\n` +
          `Actual:   ${actualSha256}`
      );
    }
    exec('tar', [
      '-xzf',
      archivePath,
      '-C',
      includeDir,
      '--strip-components=3',
      'icu/source/common/unicode',
      'icu/source/i18n/unicode',
    ]);
    if (!validIcuHeaders(vendorDir)) {
      fail(`Pinned ICU headers are incomplete under ${join(includeDir, 'unicode')}`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function verifyJscIcuContract(vendorDir) {
  const publishedSymbols = join(vendorDir, 'share', 'cottontail-jsc', 'icu-symbols.inc');
  const publishedAbi = join(vendorDir, 'share', 'cottontail-jsc', 'ICU_ABI');

  if (existsSync(publishedAbi)) {
    const expected = `ICU_ABI_FLOOR=${MANIFEST.icuFallback.abi}`;
    if (readFileSync(publishedAbi, 'utf8').trim() !== expected) {
      fail(`The pinned JSC artifact does not use the expected ${expected} contract.`);
    }
  }

  if (!existsSync(publishedSymbols)) return;

  const localSymbols = join(ROOT, 'src', 'icu_bridge', 'icu-symbols.inc');
  const parseSymbols = (path) => new Set(
    [...readFileSync(path, 'utf8').matchAll(/^ICU_SYMBOL\(([A-Za-z_][A-Za-z0-9_]*)\)\s*$/gm)]
      .map((match) => match[1])
  );
  const published = parseSymbols(publishedSymbols);
  const local = parseSymbols(localSymbols);
  const missing = [...published].filter((symbol) => !local.has(symbol)).sort();
  if (missing.length > 0) {
    fail(
      'Cottontail\'s ICU bridge is missing symbols required by the pinned JSC artifact:\n' +
        missing.map((symbol) => `  ICU_SYMBOL(${symbol})`).join('\n')
    );
  }
}

function verifyPublishedFallbackMetadata(fallbackDir, platformKey) {
  const metadataPath = join(fallbackDir, 'ICU_FALLBACK.json');
  if (!existsSync(metadataPath)) return;

  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const expected = MANIFEST.icuFallback;
  if (
    metadata.version !== expected.version ||
    metadata.abi !== expected.abi ||
    (platformKey.startsWith('windows-') && metadata.msvcRuntime !== 'MT') ||
    (metadata.dataSha256 && metadata.dataSha256 !== expected.dataSha256) ||
    metadata.sourceSha256 !== expected.sha256
  ) {
    fail(`The JSC artifact's pinned ICU metadata does not match scripts/jsc-manifest.json.`);
  }
}

function globalIcuDataDirectory() {
  if (process.platform === 'darwin' && process.env.HOME) {
    return join(process.env.HOME, 'Library', 'Application Support', 'Cottontail', 'icu', MANIFEST.icuFallback.version);
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'Cottontail', 'icu', MANIFEST.icuFallback.version);
  }
  const dataHome = process.env.XDG_DATA_HOME || (process.env.HOME && join(process.env.HOME, '.local', 'share'));
  return dataHome ? join(dataHome, 'cottontail', 'icu', MANIFEST.icuFallback.version) : null;
}

function seedGlobalIcuData(fallbackDir) {
  const root = globalIcuDataDirectory();
  if (!root) return;
  const source = join(fallbackDir, MANIFEST.icuFallback.dataFile);
  if (!existsSync(source)) return;
  const actual = sha256File(source);
  if (actual !== MANIFEST.icuFallback.dataSha256) {
    fail(`Pinned ICU data checksum mismatch: expected ${MANIFEST.icuFallback.dataSha256}, got ${actual}`);
  }
  mkdirSync(root, { recursive: true });
  const destination = join(root, MANIFEST.icuFallback.dataFile);
  copyFileSync(source, destination);
  writeFileSync(`${destination}.verified`, `${actual}\n`);
}

function buildPinnedIcuFallback(vendorDir, platformKey) {
  const fallback = MANIFEST.icuFallback;
  const fallbackDir = join(vendorDir, 'lib', 'cottontail-icu');
  verifyJscIcuContract(vendorDir);

  if (validFallbackDirectory(fallbackDir, platformKey)) {
    verifyPublishedFallbackMetadata(fallbackDir, platformKey);
    seedGlobalIcuData(fallbackDir);
    console.log(`✓ Pinned ICU ${fallback.version} fallback already vendored`);
    return;
  }

  if (platformKey.startsWith('windows-')) {
    fail(
      'The pinned Windows JSC artifact has no static ICU fallback. ' +
        'Publish and pin a current blackboardsh/jsc CircleCI artifact.'
    );
  }

  const workDir = join(JSC_ROOT, `.icu-${fallback.version}-${platformKey}`);
  const sourceDir = join(workDir, 'source');
  const buildDir = join(workDir, 'build');
  const installDir = join(workDir, 'install');
  const archivePath = join(workDir, `icu4c-${fallback.version}-src.tgz`);

  console.log(`Building pinned ICU ${fallback.version} fallback (${platformKey})...`);
  rmSync(workDir, { recursive: true, force: true });
  rmSync(fallbackDir, { recursive: true, force: true });
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(buildDir, { recursive: true });

  try {
    downloadFile(fallback.source, archivePath);
    const actualSha256 = sha256File(archivePath);
    if (actualSha256 !== fallback.sha256) {
      fail(
        `The pinned ICU source archive failed verification.\n` +
          `Expected: ${fallback.sha256}\n` +
          `Actual:   ${actualSha256}`
      );
    }

    exec('tar', ['-xzf', archivePath, '-C', sourceDir, '--strip-components=1']);
    const configurePlatform = platformKey.startsWith('macos-') ? 'MacOSX' : 'Linux';
    exec(
      join(sourceDir, 'source', 'runConfigureICU'),
      [
        configurePlatform,
        `--prefix=${installDir}`,
        '--enable-static',
        '--disable-shared',
        '--with-data-packaging=archive',
        '--disable-tests',
        '--disable-samples',
        '--disable-extras',
        '--disable-icuio',
      ],
      {
        cwd: buildDir,
        env: {
          ...process.env,
          CC: process.env.CC || 'cc',
          CXX: process.env.CXX || 'c++',
        },
      }
    );
    exec('make', [`-j${Math.max(1, Math.min(8, cpus().length))}`], { cwd: buildDir });
    exec('make', ['install'], { cwd: buildDir });

    mkdirSync(fallbackDir, { recursive: true });
    for (const name of fallbackLibraryNames(platformKey)) {
      copyFileSync(join(installDir, 'lib', name), join(fallbackDir, name));
    }
    copyFileSync(
      join(installDir, 'share', 'icu', fallback.version, fallback.dataFile),
      join(fallbackDir, fallback.dataFile)
    );
    copyFileSync(join(sourceDir, 'LICENSE'), join(fallbackDir, 'LICENSE'));
    writeFileSync(
      join(fallbackDir, 'ICU_FALLBACK.json'),
      `${JSON.stringify({
        version: fallback.version,
        abi: fallback.abi,
        dataFile: fallback.dataFile,
        dataSha256: fallback.dataSha256,
        source: fallback.source,
        sourceSha256: fallback.sha256,
      }, null, 2)}\n`
    );

    if (!validFallbackDirectory(fallbackDir, platformKey)) {
      fail(`Pinned ICU installation is incomplete under ${fallbackDir}`);
    }
    seedGlobalIcuData(fallbackDir);
    console.log(`✓ Pinned ICU ${fallback.version} fallback vendored`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function ensureIcuFallback(vendorDir, platformKey) {
  if (!platformKey.startsWith('linux-') && !platformKey.startsWith('macos-') && !platformKey.startsWith('windows-')) return;
  buildPinnedIcuFallback(vendorDir, platformKey);
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
  const expectedStamp = platformKey.startsWith('linux-') || platformKey.startsWith('macos-') || platformKey.startsWith('windows-')
    ? `${MANIFEST.tag} ${asset.sha256} icu-${MANIFEST.icuFallback.version} ${MANIFEST.icuFallback.sha256}`
    : `${MANIFEST.tag} ${asset.sha256}`;

  if (isCurrentJscVendored(vendorDir, stampPath, expectedStamp)) {
    ensureIcuHeaders(vendorDir);
    ensureIcuFallback(vendorDir, platformKey);
    console.log(`✓ JavaScriptCore ${MANIFEST.tag} (${platformKey}) already vendored`);
    return;
  }

  const url = asset.url ??
    `https://github.com/${MANIFEST.repo}/releases/download/${MANIFEST.tag}/${asset.name}`;
  const archivePath = join(JSC_ROOT, asset.name);
  const stagingDir = `${vendorDir}.staging`;

  console.log(`Vendoring JavaScriptCore ${MANIFEST.tag} (${platformKey})...`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  try {
    downloadFile(url, archivePath);

    const actualSha256 = sha256File(archivePath);
    if (actualSha256 !== asset.sha256) {
      unlinkSync(archivePath);
      fail(
        `The published JSC asset changed after it was pinned in scripts/jsc-manifest.json.\n` +
          `Asset:    ${url}\n` +
          `Expected: ${asset.sha256}\n` +
          `Actual:   ${actualSha256}`
      );
    }

    exec('tar', ['-xzf', archivePath, '--strip-components=1', '-C', stagingDir]);
    unlinkSync(archivePath);

    const libDir = join(stagingDir, 'lib');
    const includeDir = join(stagingDir, 'include', 'JavaScriptCore');
    if (!existsSync(libDir) || !existsSync(includeDir)) {
      fail(`Vendored JavaScriptCore layout is incomplete under ${vendorDir}`);
    }

    ensureIcuHeaders(stagingDir);
    ensureIcuFallback(stagingDir, platformKey);
    writeFileSync(join(stagingDir, '.jsc-vendored'), `${expectedStamp}\n`);
    rmSync(vendorDir, { recursive: true, force: true });
    renameSync(stagingDir, vendorDir);
    console.log(`✓ JavaScriptCore ${MANIFEST.tag} vendored at vendors/jsc/${MANIFEST.tag}/${platformKey}`);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    fail('Failed to vendor JavaScriptCore.', error);
  }
}

vendorJsc();
