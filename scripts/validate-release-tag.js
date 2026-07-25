#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateReleaseTag, validateRevision } from './release-contract.js';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const versionZig = readFileSync(join(rootDir, 'src', 'version.zig'), 'utf8');

function fail(message) {
  console.error(`cottontail release: ${message}`);
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const tag = process.env.GITHUB_REF_TYPE === 'tag'
  ? process.env.GITHUB_REF_NAME
  : process.argv.find((argument) => argument.startsWith('--tag='))?.slice('--tag='.length);
if (!tag) fail('a release tag is required');

const revision = process.env.GITHUB_SHA || git(['rev-parse', 'HEAD']);
let release;
try {
  release = validateReleaseTag(tag, packageJson.version);
  validateRevision(revision);
} catch (error) {
  fail(error.message);
}

const versionMatch = versionZig.match(/pub const version = "([^"]+)";/);
if (!versionMatch) fail('src/version.zig does not declare pub const version');
if (versionMatch[1] !== packageJson.version) {
  fail(`src/version.zig version ${versionMatch[1]} does not match package.json ${packageJson.version}`);
}

const metadata = { ...release, revision };
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(metadata).map(([key, value]) => `${key}=${value}\n`).join(''),
  );
}
console.log(JSON.stringify(metadata, null, 2));
