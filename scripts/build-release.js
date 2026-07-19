#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const zigName = process.platform === 'win32' ? 'zig.exe' : 'zig';
const zigPath = join(process.cwd(), 'vendors', 'zig', zigName);

if (!existsSync(zigPath)) {
  console.error(`Vendored Zig compiler not found at ${zigPath}. Run the cottontail setup first.`);
  process.exit(1);
}

const args = ['build', '-Doptimize=ReleaseSmall'];
if (process.platform === 'win32') {
  args.push('-Dtarget=x86_64-windows-msvc');
}
args.push('-Dcpu=baseline');

const result = spawnSync(zigPath, args, { stdio: 'inherit' });

if (result.error) {
  console.error('Failed to build the Cottontail release binary.');
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
