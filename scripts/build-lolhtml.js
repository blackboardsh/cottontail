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
const rustupCargo = join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'cargo.exe');
const cargo = process.env.CARGO ??
  (process.platform === 'win32' && existsSync(rustupCargo) ? rustupCargo : 'cargo');
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
  { cwd: rootDir, stdio: 'inherit' },
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
