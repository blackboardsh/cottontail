#!/usr/bin/env node

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';

const rootDir = process.cwd();
const binaryPath = join(
  rootDir,
  'zig-out',
  'bin',
  process.platform === 'win32' ? 'cottontail.exe' : 'cottontail'
);
const scriptPath = join(rootDir, 'tests', 'js', 'electrobun-smoke.js');

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(binaryPath)) {
  fail(`Built cottontail binary not found at ${binaryPath}. Run "bun run build" first.`);
}

const result = spawnSync(binaryPath, ['electrobun', scriptPath], {
  cwd: rootDir,
  env: {
    ...process.env,
  },
  encoding: 'utf8',
  timeout: 20000,
});

if (result.error) {
  fail(`Failed to execute electrobun smoke test: ${result.error.message}`);
}

const exitCode = result.status ?? 1;
if (exitCode !== 0) {
  fail(
    [
      `Electrobun smoke test exited with ${exitCode}.`,
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  );
}

if (!result.stdout.includes('electrobun smoke passed')) {
  fail(`Electrobun smoke test stdout did not include the success marker.\nstdout:\n${result.stdout}`);
}

console.log('ok electrobun-smoke');
