#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const zigBinary = process.platform === 'win32' ? 'zig.exe' : 'zig';
const zigPath = join(process.cwd(), 'vendors', 'zig', zigBinary);

if (!existsSync(zigPath)) {
  console.error(`Vendored Zig compiler not found at ${zigPath}. Run the cottontail setup first.`);
  process.exit(1);
}

const result = spawnSync(zigPath, process.argv.slice(2), { stdio: 'inherit' });

if (result.error) {
  console.error('Failed to invoke the vendored Zig compiler.');
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
