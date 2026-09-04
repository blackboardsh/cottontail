#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executableName = process.platform === 'win32' ? 'cottontail.exe' : 'cottontail';
const sourceBinary = resolve(process.argv[2] ?? join(rootDir, 'zig-out', 'bin', executableName));
const sourceCore = join(dirname(sourceBinary), 'cottontail-core');
const fixture = join(rootDir, 'tests', 'js', 'bun-spawn-without-terminal-capability.ts');

for (const [label, path] of [
  ['Cottontail binary', sourceBinary],
  ['Cottontail core', sourceCore],
  ['capability-isolation fixture', fixture],
]) {
  if (!existsSync(path)) {
    console.error(`${label} not found at ${path}`);
    process.exit(1);
  }
}

const isolatedRoot = mkdtempSync(join(tmpdir(), 'cottontail-core-only-'));
const isolatedBinary = join(isolatedRoot, executableName);

try {
  try {
    linkSync(sourceBinary, isolatedBinary);
  } catch (error) {
    if (error?.code !== 'EXDEV' && error?.code !== 'EPERM') throw error;
    copyFileSync(sourceBinary, isolatedBinary);
  }
  if (process.platform !== 'win32') chmodSync(isolatedBinary, 0o755);
  symlinkSync(
    sourceCore,
    join(isolatedRoot, 'cottontail-core'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const env = { ...process.env };
  delete env.COTTONTAIL_RUNTIME_MODULES_DIR;
  const result = spawnSync(isolatedBinary, [fixture], {
    cwd: rootDir,
    env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.includes('bun spawn without terminal capability passed')) {
    throw new Error([
      `Core-only capability test exited with ${result.status ?? 1}.`,
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
    ].filter(Boolean).join('\n'));
  }
  process.stdout.write(result.stdout);
} finally {
  rmSync(isolatedRoot, { recursive: true, force: true });
}
