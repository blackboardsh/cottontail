#!/usr/bin/env node

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import { join, resolve } from 'path';

const rootDir = process.cwd();
const targets = JSON.parse(readFileSync(join(rootDir, 'compat', 'upstream', 'targets.json'), 'utf8'));
const tempRoot = mkdtempSync(join(os.tmpdir(), 'cottontail-import-upstream-'));

const copySpecs = {
  node: {
    sparse: ['test/**', 'tools/**', 'LICENSE'],
    paths: ['test', 'tools', 'LICENSE'],
  },
  bun: {
    sparse: ['test/**', 'tsconfig.base.json', 'LICENSE.md'],
    paths: ['test', 'tsconfig.base.json', 'LICENSE.md'],
  },
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if ((result.status ?? 1) !== 0) {
    fail([
      `${command} ${args.join(' ')} exited ${result.status ?? 1}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

function importRuntime(runtime) {
  const target = targets[runtime];
  const spec = copySpecs[runtime];
  if (!target || !spec) fail(`Unknown upstream runtime: ${runtime}`);

  const cloneDir = join(tempRoot, runtime);
  const snapshotRoot = resolve(rootDir, target.snapshot);
  run('git', [
    'clone',
    '--depth',
    '1',
    '--filter=blob:none',
    '--sparse',
    '--branch',
    target.tag,
    target.source,
    cloneDir,
  ], { stdio: 'inherit' });
  run('git', ['sparse-checkout', 'set', '--no-cone', ...spec.sparse], { cwd: cloneDir, stdio: 'inherit' });

  for (const path of spec.paths) {
    const sourcePath = join(cloneDir, path);
    const destinationPath = join(snapshotRoot, path);
    if (!existsSync(sourcePath)) fail(`Missing copied upstream path: ${runtime}:${path}`);
    rmSync(destinationPath, { recursive: true, force: true });
    cpSync(sourcePath, destinationPath, {
      recursive: true,
      dereference: false,
      force: true,
      verbatimSymlinks: true,
    });
  }
  console.log(`imported ${runtime} ${target.version} from ${target.tag} (${target.commit.slice(0, 12)})`);
}

const runtime = process.argv[2] ?? 'all';
if (!['node', 'bun', 'all'].includes(runtime)) fail(`Unknown upstream runtime: ${runtime}`);

try {
  for (const name of runtime === 'all' ? ['node', 'bun'] : [runtime]) importRuntime(name);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
