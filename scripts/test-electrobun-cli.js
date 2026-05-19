#!/usr/bin/env node

import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const ROOT = process.cwd();
const FIXTURE_DIR = join(ROOT, 'fixtures', 'electrobun-cli');
const BINARY = process.platform === 'win32'
  ? join(ROOT, 'zig-out', 'bin', 'cottontail.exe')
  : join(ROOT, 'zig-out', 'bin', 'cottontail');

function fail(message, details) {
  console.error(message);
  if (details) {
    console.error(details);
  }
  process.exit(1);
}

function run(args) {
  const result = spawnSync(BINARY, args, {
    cwd: FIXTURE_DIR,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    fail(`Command failed: ${args.join(' ')}`, `${result.stdout}\n${result.stderr}`);
  }

  return result;
}

function getBuildPrefix() {
  const os = process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'win'
      : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `dev-${os}-${arch}`;
}

rmSync(join(FIXTURE_DIR, 'build'), { recursive: true, force: true });
rmSync(join(FIXTURE_DIR, '.cottontail-tmp'), { recursive: true, force: true });

const configResult = run(['electrobun', 'config']);
const config = JSON.parse(configResult.stdout.trim());

if (config.build.mainProcess !== 'cottontail') {
  fail(`Expected mainProcess to be cottontail, got ${config.build.mainProcess}`);
}

if (config.scripts.postBuild !== 'scripts/postBuild.ts') {
  fail(`Expected postBuild hook to be preserved, got ${config.scripts.postBuild}`);
}

run(['electrobun', 'build']);

const buildPrefix = getBuildPrefix();
const buildRoot = join(FIXTURE_DIR, 'build', buildPrefix);
const appRoot = join(buildRoot, 'app');

const expectedFiles = [
  join(appRoot, 'main.js'),
  join(appRoot, 'views', 'mainview', 'index.js'),
  join(appRoot, 'views', 'mainview', 'index.html'),
  join(buildRoot, 'post-build.txt'),
  join(ROOT, 'vendors', 'esbuild', '.esbuild-version'),
];

for (const filePath of expectedFiles) {
  if (!existsSync(filePath)) {
    fail(`Expected file to exist: ${filePath}`);
  }
}

const hookContents = readFileSync(join(buildRoot, 'post-build.txt'), 'utf8');
if (!hookContents.includes('post build hook ran')) {
  fail('Expected post-build hook marker file to contain hook output');
}

const runResult = run(['electrobun', 'run']);
if (!runResult.stdout.includes('fixture main starting')) {
  fail('Expected built app to print fixture startup output', runResult.stdout);
}

console.log('electrobun cli passed');
