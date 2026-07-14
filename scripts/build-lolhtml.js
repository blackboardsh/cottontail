import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [outputPath, targetTriple] = process.argv.slice(2);

if (!outputPath || !targetTriple) {
  console.error('usage: node scripts/build-lolhtml.js <output> <rust-target>');
  process.exit(2);
}

const targetDir = join(rootDir, '.zig-cache', 'lolhtml', targetTriple);
const rustup = join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'rustup.exe');
const useRustup = process.platform === 'win32' && targetTriple.includes('windows');
let cargo = process.env.CARGO ?? 'cargo';
let cargoEnv = process.env;

function runRustup(args, options = {}) {
  const result = spawnSync(rustup, args, { cwd: rootDir, ...options });
  if (result.error || result.status !== 0) {
    console.error(result.error?.message ?? result.stderr ?? `rustup ${args.join(' ')} failed`);
    process.exit(result.status ?? 1);
  }
  return result;
}

if (useRustup) {
  if (!existsSync(rustup)) {
    console.error(`rustup was not found at ${rustup}`);
    process.exit(1);
  }

  runRustup(['target', 'add', '--toolchain', 'stable', targetTriple], { stdio: 'inherit' });
  cargo = runRustup(['which', '--toolchain', 'stable', 'cargo'], { encoding: 'utf8' }).stdout.trim();
  const rustc = runRustup(['which', '--toolchain', 'stable', 'rustc'], { encoding: 'utf8' }).stdout.trim();
  cargoEnv = {
    ...process.env,
    CARGO: cargo,
    RUSTC: rustc,
    RUSTUP_TOOLCHAIN: 'stable',
  };
  delete cargoEnv.RUSTC_WRAPPER;
  delete cargoEnv.RUSTC_WORKSPACE_WRAPPER;
  delete cargoEnv.CARGO_BUILD_RUSTC;
  console.error(`[lolhtml] cargo: ${cargo}`);
  console.error(`[lolhtml] rustc: ${rustc}`);
}

const result = spawnSync(
  cargo,
  [
    'build',
    '--manifest-path',
    join(rootDir, 'vendors', 'lol-html', 'c-api', 'Cargo.toml'),
    '--locked',
    '--release',
    '--target',
    targetTriple,
    '--target-dir',
    targetDir,
  ],
  { cwd: rootDir, env: cargoEnv, stdio: 'inherit' },
);

if (result.error) {
  console.error(`failed to start Cargo: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const libraryName = targetTriple.includes('windows') ? 'lolhtml.lib' : 'liblolhtml.a';
const libraryPath = join(targetDir, targetTriple, 'release', libraryName);
mkdirSync(dirname(outputPath), { recursive: true });
copyFileSync(libraryPath, outputPath);

if (targetTriple.includes('windows')) {
  // Rust staticlibs bundle compiler_builtins, while Zig always links its own
  // compiler runtime. Keep one authoritative implementation so MSVC/LLD does
  // not reject duplicate arithmetic helper symbols.
  const zig = join(rootDir, 'vendors', 'zig', 'zig.exe');
  const list = spawnSync(zig, ['ar', 't', outputPath], { encoding: 'utf8' });
  if (list.error || list.status !== 0) {
    console.error(list.error?.message ?? list.stderr ?? 'failed to inspect LOLHTML archive');
    process.exit(list.status ?? 1);
  }
  const compilerBuiltins = list.stdout
    .split(/\r?\n/)
    .filter((member) => member.startsWith('compiler_builtins-'));
  for (let index = 0; index < compilerBuiltins.length; index += 40) {
    const remove = spawnSync(
      zig,
      ['ar', 'd', outputPath, ...compilerBuiltins.slice(index, index + 40)],
      { stdio: 'inherit' },
    );
    if (remove.error || remove.status !== 0) {
      console.error(remove.error?.message ?? 'failed to remove Rust compiler builtins');
      process.exit(remove.status ?? 1);
    }
  }
}
