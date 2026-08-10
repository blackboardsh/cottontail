#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { releaseTargetArgs } from './release-target.js';

const rootDir = process.cwd();
const executableName = process.platform === 'win32' ? 'cottontail.exe' : 'cottontail';
const zigName = process.platform === 'win32' ? 'zig.exe' : 'zig';
const zigPath = join(rootDir, 'vendors', 'zig', zigName);
const executablePath = join(rootDir, 'zig-out', 'bin', executableName);
const pluginPath = join(rootDir, 'zig-out', 'lib', 'native-bundler-plugin.node');
const testPath = join(rootDir, 'tests', 'js', 'bun-native-plugin.ts');
const validatorPath = join(rootDir, 'scripts', 'validate-release-binary.js');

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (result.status === 0) return result;
  const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n');
  throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}:\n${output}`);
}

if (!existsSync(executablePath)) {
  throw new Error(`Release executable is missing: ${executablePath}`);
}

const buildArgs = [
  'build',
  'build-native-plugin',
  '-Doptimize=ReleaseSmall',
  ...releaseTargetArgs(process.platform),
];
run(zigPath, buildArgs, 'Native plugin fixture build');

if (!existsSync(pluginPath)) {
  throw new Error(`Native plugin fixture is missing: ${pluginPath}`);
}
run(
  process.execPath,
  [validatorPath, executablePath],
  'Release executable native-addon ABI validation',
);
const smoke = run(
  executablePath,
  ['run', testPath, pluginPath],
  'Stripped release native plugin smoke test',
);
process.stdout.write(smoke.stdout);
