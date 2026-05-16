#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const zigBinary = process.platform === 'win32' ? 'zig.exe' : 'zig';
const zigPath = join(process.cwd(), 'vendors', 'zig', zigBinary);
const cottontailBinary = join(
  process.cwd(),
  'zig-out',
  'bin',
  process.platform === 'win32' ? 'cottontail.exe' : 'cottontail'
);

if (!existsSync(zigPath)) {
  console.error(`Vendored Zig compiler not found at ${zigPath}. Run "bun run setup" first.`);
  process.exit(1);
}

const buildResult = spawnSync(zigPath, ['build'], { stdio: 'inherit' });

if (buildResult.error) {
  console.error('Failed to build cottontail.');
  console.error(buildResult.error.message);
  process.exit(1);
}

if ((buildResult.status ?? 1) !== 0) {
  process.exit(buildResult.status ?? 1);
}

if (!existsSync(cottontailBinary)) {
  console.error(`Built cottontail binary not found at ${cottontailBinary}.`);
  process.exit(1);
}

const result = spawnSync(cottontailBinary, process.argv.slice(2), { stdio: 'inherit' });

if (result.error) {
  console.error('Failed to run cottontail.');
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
