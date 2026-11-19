import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import test from 'node:test';
import { configureLibc, windowsLibcArgs, windowsLibcCommands } from './configure-windows-msvc.js';

const msvcRoot = String.raw`C:\Program Files\Microsoft Visual Studio\18\Enterprise\VC\Tools\MSVC`;
const nativeLibc = [
  '# Detected by Zig',
  String.raw`include_dir=C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\ucrt`,
  `sys_include_dir=${msvcRoot}\\14.52.37025\\include`,
  String.raw`crt_dir=C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\arm64`,
  `msvc_lib_dir=${msvcRoot}\\14.52.37025\\lib\\arm64`,
  String.raw`kernel32_lib_dir=C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\arm64`,
  'gcc_dir=',
  '',
].join('\r\n');

function filesystem(versions, arch = 'arm64') {
  const paths = new Set(versions.flatMap(version => [
    win32.join(msvcRoot, version, 'include', 'vcruntime.h'),
    win32.join(msvcRoot, version, 'include', 'yvals_core.h'),
    win32.join(msvcRoot, version, 'lib', arch, 'vcruntime.lib'),
  ]));
  for (const [field, name] of [['include_dir', 'stdlib.h'], ['crt_dir', 'ucrt.lib'], ['kernel32_lib_dir', 'kernel32.lib']]) {
    const line = nativeLibc.replaceAll('arm64', arch).split('\r\n').find(line => line.startsWith(`${field}=`));
    paths.add(win32.join(line.slice(field.length + 1), name));
  }
  return {
    readdirSync(directory) { assert.equal(directory, msvcRoot); return versions; },
    existsSync(path) { return paths.has(path); },
  };
}

test('selects compatible installed STL and libraries, preserving Windows SDK paths', () => {
  const result = configureLibc(nativeLibc, 'arm64', filesystem(['14.52.37025', '14.44.35207', '14.44.35211']));
  assert.equal(result.version, '14.44.35211');
  assert.ok(result.config.includes(`sys_include_dir=${msvcRoot}\\14.44.35211\\include\n`));
  assert.ok(result.config.includes(`msvc_lib_dir=${msvcRoot}\\14.44.35211\\lib\\arm64\n`));
  for (const line of nativeLibc.split('\r\n').filter(line => /^(include_dir|crt_dir|kernel32_lib_dir|gcc_dir)=/.test(line))) {
    assert.ok(result.config.includes(`${line}\n`));
  }
  assert.doesNotMatch(result.config, /\r|14\.52|^\uFEFF/);
});

test('selects x64 libraries for x64 builds', () => {
  const result = configureLibc(nativeLibc.replaceAll('arm64', 'x64'), 'x64', filesystem(['14.44.35211'], 'x64'));
  assert.ok(result.config.includes(`msvc_lib_dir=${msvcRoot}\\14.44.35211\\lib\\x64\n`));
});

test('fails clearly instead of falling back to incompatible or wrong-architecture tools', () => {
  assert.throws(() => configureLibc(nativeLibc, 'arm64', filesystem(['14.52.37025'])), /MSVC 14\.44 arm64 is required/);
  const wrongArchitecture = filesystem(['14.44.35211']);
  const exists = wrongArchitecture.existsSync;
  wrongArchitecture.existsSync = path => !path.endsWith('arm64\\vcruntime.lib') && exists(path);
  assert.throws(() => configureLibc(nativeLibc, 'arm64', wrongArchitecture), /MSVC 14\.44 arm64 is required/);
  assert.throws(() => configureLibc(nativeLibc, 'x86', filesystem([])), /Unsupported Windows architecture/);
  assert.throws(() => configureLibc('msvc_lib_dir=x', 'arm64', filesystem([])), /did not detect Windows libc field include_dir/);
});

test('detects SDK paths for the requested CPU using the native OS, then validates the supplied config separately', () => {
  for (const [arch, cpu] of [['arm64', 'aarch64'], ['x64', 'x86_64']]) {
    const commands = windowsLibcCommands(arch, 'C:\\toolset path\\libc.txt');
    assert.deepEqual(commands.discover, ['libc', '-target', `${cpu}-native-msvc`]);
    assert.ok(!commands.discover.some(value => value.includes('-windows-')), 'explicit Windows OS disables native SDK discovery');
    assert.deepEqual(commands.validate, ['libc', 'C:\\toolset path\\libc.txt', '-target', `${cpu}-windows-msvc`]);
  }
});

test('rejects missing SDK libraries rather than relying on libc config parsing', () => {
  const fs = filesystem(['14.44.35211']);
  const exists = fs.existsSync;
  fs.existsSync = path => !path.endsWith('kernel32.lib') && exists(path);
  assert.throws(() => configureLibc(nativeLibc, 'arm64', fs), /Windows SDK file is missing: .*kernel32\.lib/);
});

test('explicit Windows builds consume the config without changing compiler-host environment', () => {
  assert.deepEqual(windowsLibcArgs('win32', 'C:\\toolset path\\libc.txt'), ['--libc', 'C:\\toolset path\\libc.txt']);
  assert.deepEqual(windowsLibcArgs('win32', ''), []);
  assert.deepEqual(windowsLibcArgs('darwin', 'C:\\libc.txt'), []);
  assert.deepEqual(windowsLibcArgs('linux', 'C:\\libc.txt'), []);
});
