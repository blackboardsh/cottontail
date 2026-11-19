#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArchitecture, windowsTarget } from './build-target.js';

// Zig 0.16 embeds Clang 21. VS 2026's default STL requires Clang 22,
// while the installed VS 2022 17.14 (MSVC 14.44) STL supports Clang 19+.
// Zig discovers Visual Studio independently of vcvars/VCToolsInstallDir.
export function windowsLibcArgs(platform = process.platform, config = process.env.COTTONTAIL_ZIG_LIBC) {
  return platform === 'win32' && config ? ['--libc', config] : [];
}

export function configureLibc(nativeLibc, arch, fs = { existsSync, readdirSync }) {
  windowsTarget(arch); // Reject unsupported target architectures before selecting libraries.
  const fields = new Map(nativeLibc.replace(/\r\n/g, '\n').split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  for (const field of ['include_dir', 'sys_include_dir', 'crt_dir', 'msvc_lib_dir', 'kernel32_lib_dir']) {
    if (!fields.get(field)) throw new Error(`Zig did not detect Windows libc field ${field}`);
  }
  const msvcRoot = win32.dirname(win32.dirname(win32.dirname(fields.get('msvc_lib_dir'))));
  const versions = fs.readdirSync(msvcRoot)
    .filter(version => /^14\.44\.\d+$/.test(version))
    .sort((a, b) => Number(b.split('.')[2]) - Number(a.split('.')[2]));
  const version = versions.find(candidate => {
    const root = win32.join(msvcRoot, candidate);
    return fs.existsSync(win32.join(root, 'include', 'vcruntime.h')) &&
      fs.existsSync(win32.join(root, 'include', 'yvals_core.h')) &&
      fs.existsSync(win32.join(root, 'lib', arch, 'vcruntime.lib'));
  });
  if (!version) {
    throw new Error(`MSVC 14.44 ${arch} is required by Zig's C++ compiler. Install the VS 2022 17.14 C++ tools; searched ${msvcRoot}`);
  }
  const toolsetRoot = win32.join(msvcRoot, version);
  fields.set('sys_include_dir', win32.join(toolsetRoot, 'include'));
  fields.set('msvc_lib_dir', win32.join(toolsetRoot, 'lib', arch));
  return {
    version,
    config: [...fields].map(([name, value]) => `${name}=${value}`).join('\n') + '\n',
  };
}

function main() {
  if (process.platform !== 'win32') throw new Error('This setup step runs only on Windows');
  if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required to configure subsequent build steps');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const zig = join(root, 'vendors', 'zig', 'zig.exe');
  const arch = buildArchitecture();
  const target = windowsTarget(arch).zig;
  const env = { ...process.env };
  delete env.ZIG_LIBC;
  const nativeLibc = execFileSync(zig, ['libc', '-target', target], { encoding: 'utf8', env });
  const { version, config } = configureLibc(nativeLibc, arch);
  const directory = join(root, '.zig-cache', 'msvc');
  mkdirSync(directory, { recursive: true });
  const configPath = join(directory, `${arch}-libc.txt`);
  writeFileSync(configPath, config, 'utf8');
  execFileSync(zig, ['libc', configPath, '-target', target], { stdio: 'inherit', env });
  env.ZIG_LIBC = configPath;
  // Check the actual embedded C++ compiler against this STL before lengthy builds.
  const probePath = join(directory, 'stl-probe.cpp');
  writeFileSync(probePath, '#include <string>\nint main() { return std::string("MSVC").size() == 4 ? 0 : 1; }\n');
  execFileSync(zig, ['c++', '-target', target, '-std=c++20', '-fsyntax-only', probePath], { stdio: 'inherit', env });
  // Only explicit target builds consume this. A global ZIG_LIBC would also
  // affect the x64 compiler host/build runner on ARM Windows and GNU probes.
  appendFileSync(process.env.GITHUB_ENV, `COTTONTAIL_ZIG_LIBC=${configPath}\n`);
  console.log(`Selected MSVC ${version} for ${target}; Windows SDK paths retained from Zig discovery.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
