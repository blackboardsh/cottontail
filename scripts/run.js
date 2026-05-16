#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const zigBinary = process.platform === 'win32' ? 'zig.exe' : 'zig';
const zigPath = join(process.cwd(), 'vendors', 'zig', zigBinary);

if (!existsSync(zigPath)) {
  console.error(`Vendored Zig compiler not found at ${zigPath}. Run "bun run setup" first.`);
  process.exit(1);
}

const args = ['build', 'run'];

if (process.argv.length > 2) {
  args.push('--', ...process.argv.slice(2));
}

const result = spawnSync(zigPath, args, { stdio: 'inherit' });

if (result.error) {
  console.error('Failed to run cottontail.');
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
