#!/usr/bin/env node

import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function defaultSnapshotRoot() {
  const targets = readJson(join(rootDir, 'compat', 'upstream', 'targets.json'));
  if (!targets.bun?.snapshot) fail('The Bun upstream snapshot is not configured.');
  return resolve(rootDir, targets.bun.snapshot);
}

function parseArgs(argv) {
  let snapshotRoot = defaultSnapshotRoot();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--snapshot') {
      const value = argv[++index];
      if (!value) fail('--snapshot requires a path');
      snapshotRoot = resolve(rootDir, value);
    } else {
      fail(`Unknown option: ${arg}`);
    }
  }
  return { snapshotRoot };
}

function statOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function ensureDirectoryLink(link, target) {
  const existing = statOrNull(link);
  if (existing?.isSymbolicLink()) {
    try {
      const linkedTarget = resolve(dirname(link), readlinkSync(link));
      if (linkedTarget === resolve(target)) return link;
    } catch {}
  }
  if (existing) rmSync(link, { recursive: true, force: true });
  mkdirSync(dirname(link), { recursive: true });
  const linkTarget = process.platform === 'win32' ? target : relative(dirname(link), target);
  symlinkSync(linkTarget, link, process.platform === 'win32' ? 'junction' : 'dir');
  return link;
}

export function setupSvelteFixture(snapshotRoot = defaultSnapshotRoot()) {
  const snapshot = resolve(snapshotRoot);
  const pluginRoot = join(snapshot, 'packages', 'bun-plugin-svelte');
  const bunTypesRoot = join(snapshot, 'packages', 'bun-types');
  const pluginPackage = readJson(join(pluginRoot, 'package.json'));
  const bunTypesPackage = readJson(join(bunTypesRoot, 'package.json'));
  if (pluginPackage.name !== 'bun-plugin-svelte' || pluginPackage.version !== '0.0.6') {
    fail(`Unexpected bun-plugin-svelte package at ${pluginRoot}.`);
  }
  if (bunTypesPackage.name !== 'bun-types') {
    fail(`Unexpected bun-types package at ${bunTypesRoot}.`);
  }

  // Every run must exercise the plugin's unchanged upstream install hook.
  rmSync(join(pluginRoot, 'node_modules'), { recursive: true, force: true });

  const testNodeModules = join(snapshot, 'test', 'node_modules');
  const pluginLink = join(testNodeModules, 'bun-plugin-svelte');
  ensureDirectoryLink(pluginLink, pluginRoot);

  // Bun's source checkout installs workspace dependencies at an ancestor of
  // the test fixture. Mirror that resolution point without copying Svelte;
  // the unchanged upstream beforeAll install populates this target.
  const svelteLink = join(testNodeModules, 'svelte');
  ensureDirectoryLink(svelteLink, join(pluginRoot, 'node_modules', 'svelte'));
  console.log(`Prepared bun-plugin-svelte fixture at ${pluginLink}.`);
  return pluginLink;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { snapshotRoot } = parseArgs(process.argv.slice(2));
  setupSvelteFixture(snapshotRoot);
}
