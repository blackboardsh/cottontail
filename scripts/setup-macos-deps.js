#!/usr/bin/env node

// Build static archives with the same macOS deployment floor as Cottontail.
// Homebrew bottles may require a newer OS even when the final binary targets 14.
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildArchitecture } from './build-target.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');
const MANIFEST_PATH = join(SCRIPT_DIR, 'macos-deps-manifest.json');
const MANIFEST_TEXT = readFileSync(MANIFEST_PATH, 'utf8');
const MANIFEST = JSON.parse(MANIFEST_TEXT);
const SCRIPT_HASH = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const DEPS_ROOT = join(ROOT, 'vendors', 'macos-deps');
const MAX_OUTPUT = 128 * 1024 * 1024;

function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT,
    ...options,
  }).trim();
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function requireFile(path) {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`Missing or empty macOS dependency file: ${path}`);
  }
}

function downloadSource(name, dependency) {
  const downloads = join(DEPS_ROOT, '.downloads');
  mkdirSync(downloads, { recursive: true });
  const archive = join(downloads, `${name}-${dependency.version}.tar.gz`);
  if (existsSync(archive) && sha256File(archive) === dependency.sha256) return archive;

  const temporary = `${archive}.${process.pid}.tmp`;
  try {
    run('curl', [
      '--fail', '--location', '--retry', '5', '--retry-all-errors',
      '--connect-timeout', '30', '--max-time', '600',
      '--output', temporary, dependency.url,
    ]);
    const actual = sha256File(temporary);
    if (actual !== dependency.sha256) {
      throw new Error(`${name} source checksum mismatch: expected ${dependency.sha256}, got ${actual}`);
    }
    renameSync(temporary, archive);
  } finally {
    rmSync(temporary, { force: true });
  }
  return archive;
}

function extractSource(archive, dependency, destination) {
  const entries = capture('/usr/bin/tar', ['-tzf', archive]).split('\n');
  for (const entry of entries) {
    const components = entry.split('/');
    if (components[0] !== dependency.sourceDirectory || components.includes('..')) {
      throw new Error(`Unexpected source archive member: ${entry}`);
    }
  }
  mkdirSync(destination, { recursive: true });
  run('/usr/bin/tar', ['-xzf', archive, '--no-same-owner', '--strip-components=1', '-C', destination]);
}

function versionNumber(version) {
  const [major, minor = 0, patch = 0] = version.split('.').map(Number);
  return major * 10000 + minor * 100 + patch;
}

function verifyArchive(path, arch, deploymentTarget) {
  requireFile(path);
  const members = capture('/usr/bin/ar', ['-t', path]).split('\n')
    .filter((name) => name && !name.startsWith('__.SYMDEF'));
  const headers = capture('/usr/bin/otool', ['-hv', path]);
  const objects = [...headers.matchAll(/^\s*MH_MAGIC_64\s+(\S+)\s+(\S+)\s+\S+\s+(\S+)/gm)];
  const cpu = arch === 'arm64' ? 'ARM64' : 'X86_64';
  if (objects.length === 0 || objects.length !== members.length) {
    throw new Error(`${path} contains unrecognized or non-Mach-O archive members`);
  }
  for (const [, objectCpu, subtype, filetype] of objects) {
    if (objectCpu !== cpu || subtype !== 'ALL' || filetype !== 'OBJECT') {
      throw new Error(`${path} contains ${objectCpu}/${subtype}/${filetype}; expected baseline ${cpu}/ALL/OBJECT`);
    }
  }

  // Read load commands for every member, rather than only the first object.
  // Assembly-only objects may omit a deployment command entirely.
  const commands = capture('/usr/bin/otool', ['-l', path]);
  const versions = [];
  for (const block of commands.split(/Load command \d+\n/)) {
    if (/\bcmd LC_BUILD_VERSION\b/.test(block)) {
      const platform = block.match(/^\s*platform\s+(\S+)/m)?.[1];
      const version = block.match(/^\s*minos\s+([\d.]+)/m)?.[1];
      if (!['1', 'MACOS', 'macos'].includes(platform) || !version) {
        throw new Error(`${path} contains an invalid or non-macOS build version`);
      }
      versions.push(version);
    } else if (/\bcmd LC_VERSION_MIN_MACOSX\b/.test(block)) {
      const version = block.match(/^\s*version\s+([\d.]+)/m)?.[1];
      if (!version) throw new Error(`${path} contains an invalid macOS minimum version`);
      versions.push(version);
    } else if (/\bcmd LC_VERSION_MIN_(?:IPHONEOS|TVOS|WATCHOS)\b/.test(block)) {
      throw new Error(`${path} contains an object for another Apple platform`);
    }
  }
  if (versions.length === 0 || versions.some((version) => versionNumber(version) > versionNumber(deploymentTarget))) {
    throw new Error(`${path} does not satisfy the macOS ${deploymentTarget} deployment floor: ${[...new Set(versions)].join(', ')}`);
  }
  console.log(`Verified ${path}: ${objects.length} ${cpu} objects, maximum minOS ${versions.sort((a, b) => versionNumber(b) - versionNumber(a))[0]}`);
}

function verifyPrefix(prefix, arch, deploymentTarget) {
  for (const [name, dependency] of Object.entries(MANIFEST.dependencies)) {
    for (const library of dependency.libraries) verifyArchive(join(prefix, 'lib', library), arch, deploymentTarget);
    for (const header of dependency.headers) requireFile(join(prefix, 'include', header));
    for (const license of dependency.licenses) requireFile(join(prefix, 'share', 'licenses', name, license));
  }
}

function buildDependency(name, source, build, prefix, installEnv, env, jobs, arch, sdk, deploymentTarget) {
  mkdirSync(build, { recursive: true });
  const options = { cwd: build, env };
  if (name === 'libffi') {
    run(join(source, 'configure'), [
      `--prefix=${prefix}`, '--libdir=' + join(prefix, 'lib'),
      '--disable-shared', '--enable-static', '--with-pic',
      '--disable-docs', '--disable-dependency-tracking', '--disable-multi-os-directory',
    ], options);
    run('/usr/bin/make', [`-j${jobs}`], options);
    run('/usr/bin/make', ['install'], { ...options, env: installEnv });
    return;
  }

  if (name === 'openssl') {
    run('/usr/bin/perl', [
      join(source, 'Configure'), arch === 'arm64' ? 'darwin64-arm64-cc' : 'darwin64-x86_64-cc',
      `--prefix=${prefix}`, '--libdir=lib', '--openssldir=/etc/ssl',
      'no-shared', 'no-module', 'no-tests', 'no-apps',
    ], options);
    run('/usr/bin/make', [`-j${jobs}`, 'build_sw'], options);
    // OpenSSL's generated Makefile assigns DESTDIR, overriding the environment.
    run('/usr/bin/make', ['install_sw', `DESTDIR=${installEnv.DESTDIR}`], { ...options, env: installEnv });
    return;
  }

  const cmakeSource = name === 'zstd' ? join(source, 'build', 'cmake') : source;
  const dependencyFlags = name === 'zstd' ? [
    '-DZSTD_BUILD_STATIC=ON', '-DZSTD_BUILD_SHARED=OFF', '-DZSTD_BUILD_PROGRAMS=OFF',
    '-DZSTD_BUILD_TESTS=OFF', '-DZSTD_BUILD_CONTRIB=OFF',
  ] : ['-DBROTLI_BUILD_TOOLS=OFF', '-DBROTLI_BUILD_FOR_PACKAGE=OFF', '-DBROTLI_DISABLE_TESTS=ON'];
  run('cmake', [
    '-S', cmakeSource, '-B', build, '-G', 'Unix Makefiles',
    '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DBUILD_TESTING=OFF',
    '-DCMAKE_POSITION_INDEPENDENT_CODE=ON', '-DCMAKE_INSTALL_LIBDIR=lib',
    `-DCMAKE_INSTALL_PREFIX=${prefix}`, `-DCMAKE_C_COMPILER=${env.CC}`,
    `-DCMAKE_CXX_COMPILER=${env.CXX}`, `-DCMAKE_ASM_COMPILER=${env.CC}`,
    `-DCMAKE_C_FLAGS=${env.CFLAGS}`, `-DCMAKE_CXX_FLAGS=${env.CXXFLAGS}`,
    `-DCMAKE_ASM_FLAGS=${env.CFLAGS}`, `-DCMAKE_OSX_SYSROOT=${sdk}`,
    `-DCMAKE_OSX_ARCHITECTURES=${arch === 'arm64' ? 'arm64' : 'x86_64'}`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${deploymentTarget}`, ...dependencyFlags,
  ], options);
  run('cmake', ['--build', build, '--parallel', String(jobs)], options);
  run('cmake', ['--install', build], { ...options, env: installEnv });
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('macOS source dependencies are not needed on this platform.');
    return;
  }
  const arch = buildArchitecture();
  const jobs = process.env.COTTONTAIL_BUILD_JOBS || '2';
  if (!/^[1-9]\d*$/.test(jobs)) throw new Error('COTTONTAIL_BUILD_JOBS must be a positive integer');
  const deploymentTarget = MANIFEST.deploymentTarget;
  if (MANIFEST.schemaVersion !== 1 || deploymentTarget !== '14.0') {
    throw new Error('Unsupported macOS dependency manifest or deployment target');
  }
  const prefix = join(DEPS_ROOT, `macos-${arch}`);
  const stamp = createHash('sha256').update(`${MANIFEST_TEXT}\0${SCRIPT_HASH}\0${arch}\0${deploymentTarget}`).digest('hex');
  const stampPath = join(prefix, '.stamp');
  if (existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === stamp) {
    try {
      verifyPrefix(prefix, arch, deploymentTarget);
      console.log(`Pinned macOS ${arch} dependencies are current.`);
      return;
    } catch (error) {
      console.warn(`Rebuilding invalid cached macOS dependencies: ${error.message}`);
      rmSync(stampPath, { force: true });
    }
  }

  const sdk = capture('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
  const clang = capture('xcrun', ['--sdk', 'macosx', '--find', 'clang']);
  const clangxx = capture('xcrun', ['--sdk', 'macosx', '--find', 'clang++']);
  const baseline = arch === 'arm64' ? '-march=armv8-a -mtune=generic' : '-march=x86-64 -mtune=generic';
  const flags = `-O2 -fPIC -arch ${arch === 'arm64' ? 'arm64' : 'x86_64'} -mmacosx-version-min=${deploymentTarget} ${baseline}`;
  const env = {
    ...process.env,
    CC: clang, CXX: clangxx, CCAS: clang,
    AR: capture('xcrun', ['--find', 'ar']), RANLIB: capture('xcrun', ['--find', 'ranlib']),
    CFLAGS: flags, CXXFLAGS: flags, ASFLAGS: flags, CCASFLAGS: flags, CPPFLAGS: '',
    LDFLAGS: `-arch ${arch === 'arm64' ? 'arm64' : 'x86_64'} -mmacosx-version-min=${deploymentTarget}`,
    SDKROOT: sdk, MACOSX_DEPLOYMENT_TARGET: deploymentTarget,
    ZERO_AR_DATE: '1', MAKEFLAGS: '', MFLAGS: '',
  };
  // Prevent local toolchain additions from introducing Homebrew libraries,
  // host-specific flags, or OpenSSL configuration into these static archives.
  for (const key of [
    'CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH', 'LIBS',
    'OPENSSL_LOCAL_CONFIG_DIR', 'CONFIG_SITE', 'DESTDIR', 'CPP', 'AS',
    'CROSS_COMPILE', 'CPPDEFINES', 'CPPINCLUDES', 'LDLIBS',
    'PKG_CONFIG', 'PKG_CONFIG_PATH', 'PKG_CONFIG_LIBDIR', 'PKG_CONFIG_SYSROOT_DIR',
    'CMAKE_PREFIX_PATH', 'CMAKE_LIBRARY_PATH', 'CMAKE_INCLUDE_PATH', 'CMAKE_TOOLCHAIN_FILE',
    'CMAKE_C_COMPILER_LAUNCHER', 'CMAKE_CXX_COMPILER_LAUNCHER', 'CMAKE_ASM_COMPILER_LAUNCHER',
    ...Object.keys(env).filter((key) => key.startsWith('__CNF_')),
  ]) {
    delete env[key];
  }

  mkdirSync(DEPS_ROOT, { recursive: true });
  const work = mkdtempSync(join(DEPS_ROOT, `.build-${arch}-`));
  const destdir = join(work, 'install');
  const stagedPrefix = join(destdir, prefix);
  const installEnv = { ...env, DESTDIR: destdir };
  try {
    for (const [name, dependency] of Object.entries(MANIFEST.dependencies)) {
      console.log(`Building ${name} ${dependency.version} for macOS ${arch} >= ${deploymentTarget} (${jobs} jobs)...`);
      const archive = downloadSource(name, dependency);
      const source = join(work, 'sources', name);
      extractSource(archive, dependency, source);
      buildDependency(name, source, join(work, 'build', name), prefix, installEnv, env, jobs, arch, sdk, deploymentTarget);
      const licenses = join(stagedPrefix, 'share', 'licenses', name);
      mkdirSync(licenses, { recursive: true });
      for (const license of dependency.licenses) copyFileSync(join(source, license), join(licenses, license));
    }
    verifyPrefix(stagedPrefix, arch, deploymentTarget);
    copyFileSync(MANIFEST_PATH, join(stagedPrefix, 'share', 'macos-deps-manifest.json'));
    // Only a fully built and verified prefix is ever eligible for a cache hit.
    writeFileSync(join(stagedPrefix, '.stamp'), `${stamp}\n`);
    rmSync(prefix, { recursive: true, force: true });
    renameSync(stagedPrefix, prefix);
    console.log(`Installed pinned macOS dependencies to ${prefix}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`macOS dependency setup failed: ${error.message}`);
  process.exitCode = 1;
}
