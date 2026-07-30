#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const rootDir = process.cwd();
const zigName = process.platform === 'win32' ? 'zig.exe' : 'zig';
const executableName = process.platform === 'win32' ? 'cottontail.exe' : 'cottontail';
const zigPath = join(rootDir, 'vendors', 'zig', zigName);
const executablePath = join(rootDir, 'zig-out', 'bin', executableName);
const validatorPath = join(rootDir, 'scripts', 'validate-release-binary.js');

if (!existsSync(zigPath)) {
  console.error(`Vendored Zig compiler not found at ${zigPath}. Run the cottontail setup first.`);
  process.exit(1);
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const error = new Error(`${label} failed with exit code ${result.status ?? 'unknown'}.`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

const stagingRoot = mkdtempSync(join(tmpdir(), 'cottontail-release-'));
const stagedExecutable = join(stagingRoot, 'bin', executableName);

try {
  const args = ['build', '-Doptimize=ReleaseSmall'];
  if (process.platform === 'win32') {
    args.push('-Dtarget=x86_64-windows-msvc');
  }
  args.push('-Dcpu=baseline', '--prefix', stagingRoot);

  run(zigPath, args, 'Cottontail release build');
  if (process.platform === 'darwin') {
    // Keep external host symbols used by N-API, FFI, and native bundler plugins.
    run('/usr/bin/strip', ['-x', stagedExecutable], 'Cottontail release strip');
    run(
      '/usr/bin/codesign',
      ['--force', '--sign', '-', stagedExecutable],
      'Cottontail release ad-hoc signing',
    );
  } else if (process.platform === 'linux') {
    run(process.env.STRIP ?? 'strip', [stagedExecutable], 'Cottontail release strip');
  }
  run(
    process.execPath,
    [validatorPath, stagedExecutable],
    'Cottontail staged release validation',
  );

  mkdirSync(dirname(executablePath), { recursive: true });
  copyFileSync(stagedExecutable, executablePath);
  if (process.platform !== 'win32') chmodSync(executablePath, 0o755);
  run(
    process.execPath,
    [validatorPath, executablePath],
    'Cottontail installed release validation',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
