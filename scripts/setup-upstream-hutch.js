#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(rootDir, 'compat', 'upstream', 'hutch.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.schema !== 1) throw new Error(`Unsupported Hutch manifest schema: ${manifest.schema}`);
if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(manifest.repository)) {
  throw new Error(`Hutch repository must be an explicit HTTPS GitHub URL: ${manifest.repository}`);
}
if (!/^[0-9a-f]{40}$/.test(manifest.commit)) {
  throw new Error(`Hutch commit must be a full Git commit: ${manifest.commit}`);
}

const checkoutBase = resolve(
  process.env.COTTONTAIL_UPSTREAM_HUTCH_ROOT ??
    join(rootDir, '.cottontail-local-tools', 'upstream-hutch'),
);
const checkoutRoot = join(checkoutBase, manifest.commit);
// Compatibility fixtures need Hutch's command implementation, not its outer
// version/pragma launcher. Generated bundles can have a very long first line,
// which is intentionally outside the launcher's config-file contract.
const executableName = process.platform === 'win32' ? 'hutch-engine.exe' : 'hutch-engine';
const binaryPath = join(checkoutRoot, 'zig-out', 'bin', executableName);
const zigName = process.platform === 'win32' ? 'zig.exe' : 'zig';
const zigPath = join(rootDir, 'vendors', 'zig', zigName);

function run(command, args, cwd = rootDir) {
  execFileSync(command, args, {
    cwd,
    // Keep stdout reserved for the final machine-readable binary path.
    stdio: ['inherit', process.stderr, process.stderr],
  });
}

function output(command, args, cwd = rootDir) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

if (!existsSync(zigPath)) {
  throw new Error(`Vendored Zig not found at ${zigPath}. Run node scripts/setup.js first.`);
}

if (!existsSync(join(checkoutRoot, '.git'))) {
  if (existsSync(checkoutRoot)) {
    throw new Error(`Refusing to replace non-Git Hutch checkout at ${checkoutRoot}`);
  }
  mkdirSync(checkoutRoot, { recursive: true });
  run('git', ['init', '--quiet'], checkoutRoot);
  run('git', ['remote', 'add', 'origin', manifest.repository], checkoutRoot);
  run('git', ['fetch', '--quiet', '--depth', '1', 'origin', manifest.commit], checkoutRoot);
  run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], checkoutRoot);
}

const checkedOutCommit = output('git', ['rev-parse', 'HEAD'], checkoutRoot);
if (checkedOutCommit !== manifest.commit) {
  throw new Error(`Pinned Hutch checkout mismatch: expected ${manifest.commit}, received ${checkedOutCommit}`);
}

if (!existsSync(binaryPath) || statSync(binaryPath).size === 0) {
  run(zigPath, ['build', '-Doptimize=ReleaseSmall', '-Dcpu=baseline'], checkoutRoot);
}
if (!existsSync(binaryPath) || !statSync(binaryPath).isFile() || statSync(binaryPath).size === 0) {
  throw new Error(`Pinned Hutch build did not produce ${binaryPath}`);
}

console.log(binaryPath);
