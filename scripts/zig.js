#!/usr/bin/env node

import { execFileSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { buildArchitecture, windowsTarget, buildJobArgs } from './build-target.js';

const zigBinary = process.platform === 'win32' ? 'zig.exe' : 'zig';
const zigPath = join(process.cwd(), 'vendors', 'zig', zigBinary);
const nativeBindingsGenerator = join(process.cwd(), 'scripts', 'generate-native-bindings.js');

if (!existsSync(zigPath)) {
  console.error(`Vendored Zig compiler not found at ${zigPath}. Run the cottontail setup first.`);
  process.exit(1);
}

execFileSync(process.execPath, [nativeBindingsGenerator], { stdio: 'inherit' });

const args = process.argv.slice(2);
if (args[0] === 'build' && !args.some(arg => /^-j/.test(arg))) args.push(...buildJobArgs());
if (process.platform === 'win32' && args[0] === 'build' && !args.some(arg => arg.startsWith('-Dtarget='))) {
  args.push(`-Dtarget=${windowsTarget(buildArchitecture()).zig}`);
}
const result = spawnSync(zigPath, args, { stdio: 'inherit' });

if (result.error) {
  console.error('Failed to invoke the vendored Zig compiler.');
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
