#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import os from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = resolve(dirname(scriptPath), '..');
const targets = JSON.parse(readFileSync(join(rootDir, 'compat', 'upstream', 'targets.json'), 'utf8'));
let tempRoot = null;

export const allowBunReplacementFlag = '--allow-bun-replace';

export function parseImportArguments(argv) {
  let runtime = null;
  let allowBunReplace = false;
  let help = false;

  for (const argument of argv) {
    if (argument === allowBunReplacementFlag) allowBunReplace = true;
    else if (argument === '--help' || argument === '-h') help = true;
    else if (['node', 'bun', 'all'].includes(argument) && runtime == null) runtime = argument;
    else throw new Error(`Unknown upstream import argument: ${argument}`);
  }

  return { runtime: runtime ?? 'all', allowBunReplace, help };
}

function usage() {
  return [
    'Usage: node scripts/import-upstream-tests.js <node|bun|all> [options]',
    '',
    'Node snapshot importing remains available normally.',
    `Replacing the owned Bun-derived JavaScript tests requires ${allowBunReplacementFlag}.`,
  ].join('\n');
}

export function assertBunReplacementAllowed(runtime, allowBunReplace) {
  if ((runtime === 'bun' || runtime === 'all') && !allowBunReplace) {
    throw new Error([
      'Refusing to replace the owned Bun-derived JavaScript tests.',
      'The Bun importer reconstructs imported paths and can erase intentional Cottontail changes.',
      'Use the read-only Bun test review command for normal upstream review.',
      `For exceptional baseline reconstruction only, repeat with ${allowBunReplacementFlag}.`,
      'To refresh only the Node snapshot, select the node runtime.',
    ].join('\n'));
  }
}

export function assertCheckoutCommit(runtime, tag, expectedCommit, checkedOutCommit) {
  if (checkedOutCommit !== expectedCommit) {
    throw new Error(
      `${runtime} tag ${tag} resolved to ${checkedOutCommit}; expected ${expectedCommit}. ` +
      'No destination paths were changed.',
    );
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value != null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function snapshotLockCoordinates(snapshotRoot, lockDir) {
  const canonicalSnapshotRoot = realpathSync(snapshotRoot);
  const scope = { kind: 'snapshot', path: canonicalSnapshotRoot };
  const lockParent = resolve(
    lockDir ?? process.env.COTTONTAIL_BASELINE_LOCK_DIR ??
      join(os.tmpdir(), 'cottontail-javascript-baseline-locks'),
  );
  const fingerprint = createHash('sha256').update(canonicalJson(scope)).digest('hex');
  return {
    canonicalSnapshotRoot,
    lockParent,
    lockPath: join(lockParent, `${fingerprint}.lock`),
    scope,
  };
}

export function bunSnapshotLockPath(snapshotRoot, lockDir) {
  return snapshotLockCoordinates(snapshotRoot, lockDir).lockPath;
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function processGroupIsRunning(pid) {
  if (process.platform === 'win32') return processIsRunning(pid);
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function writeSnapshotLockOwner(lockPath, token, owner) {
  const temporaryPath = join(lockPath, `owner.${token}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(owner, null, 2)}\n`);
  renameSync(temporaryPath, join(lockPath, 'owner.json'));
}

export function acquireBunSnapshotMutationLock(snapshotRoot, options = {}) {
  const { canonicalSnapshotRoot, lockParent, lockPath, scope } =
    snapshotLockCoordinates(snapshotRoot, options.lockDir);
  mkdirSync(lockParent, { recursive: true });
  const token = randomUUID();
  const owner = {
    schema: 1,
    token,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rootDir: realpathSync(rootDir),
    runtime: 'bun-import',
    scope,
    selectedTargets: [{ name: 'bun', snapshot: canonicalSnapshotRoot }],
    activeChildren: [],
    synchronousPhase: null,
  };

  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      mkdirSync(lockPath);
      writeSnapshotLockOwner(lockPath, token, owner);
      acquired = true;
      continue;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    let existing;
    try {
      existing = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
    } catch {
      fail(
        `JavaScript baseline suite lock is malformed and was left untouched: ${lockPath}\n` +
        'Inspect the lock before removing it manually.',
      );
    }
    if (
      existing?.schema !== 1 ||
      typeof existing.token !== 'string' ||
      !Number.isInteger(existing.pid) ||
      !Array.isArray(existing.activeChildren)
    ) {
      fail(`JavaScript baseline suite lock has an unknown format and was left untouched: ${lockPath}`);
    }
    if (existing.hostname !== os.hostname()) {
      fail(`Bun snapshot is locked by JavaScript baseline suite PID ${existing.pid} on ${existing.hostname}: ${lockPath}`);
    }
    if (processIsRunning(existing.pid)) {
      fail(`Bun snapshot is in use by JavaScript baseline suite PID ${existing.pid}: ${lockPath}`);
    }
    if (existing.synchronousPhase != null) {
      fail(
        `A stale JavaScript baseline suite lock ended during synchronous phase ` +
        `${JSON.stringify(existing.synchronousPhase)} and was left untouched: ${lockPath}\n` +
        'Inspect child processes before removing it manually.',
      );
    }
    const liveChildren = existing.activeChildren.filter(processGroupIsRunning);
    if (liveChildren.length > 0) {
      fail(
        `A stale JavaScript baseline suite lock still owns live test processes ` +
        `${liveChildren.join(', ')}: ${lockPath}`,
      );
    }

    const stalePath = `${lockPath}.stale-${existing.token}`;
    try {
      renameSync(lockPath, stalePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      fail(`Could not safely reclaim stale JavaScript baseline suite lock: ${error.message}`);
    }
    let movedOwner;
    try {
      movedOwner = JSON.parse(readFileSync(join(stalePath, 'owner.json'), 'utf8'));
    } catch {}
    if (movedOwner?.token !== existing.token) {
      try {
        if (!existsSync(lockPath)) renameSync(stalePath, lockPath);
      } catch {}
      fail('JavaScript baseline suite lock changed while stale-lock recovery was in progress.');
    }
    rmSync(stalePath, { recursive: true, force: true });
  }
  if (!acquired) fail(`Could not acquire JavaScript baseline suite lock: ${lockPath}`);

  return {
    path: lockPath,
    release() {
      let current;
      try {
        current = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
      } catch {
        return;
      }
      if (current?.token === token) rmSync(lockPath, { recursive: true, force: true });
    },
  };
}

export function withBunSnapshotMutationLock(snapshotRoot, operation, options = {}) {
  const lock = acquireBunSnapshotMutationLock(snapshotRoot, options);
  try {
    return operation();
  } finally {
    lock.release();
  }
}

export const copySpecs = {
  node: {
    sparse: ['test/**', 'tools/**', 'LICENSE'],
    paths: ['test', 'tools', 'LICENSE'],
  },
  bun: {
    sparse: [
      'test/**',
      'packages/bun-native-bundler-plugin-api/bundler_plugin.h',
      'packages/bun-error/runtime-error.ts',
      'packages/bun-plugin-svelte/README.md',
      'packages/bun-plugin-svelte/bun.lock',
      'packages/bun-plugin-svelte/package.json',
      'packages/bun-plugin-svelte/src/**',
      'packages/bun-plugin-svelte/tsconfig.json',
      'packages/bun-types/package.json',
      'src/api/schema.js',
      'src/bake/client/data-view.ts',
      'src/bake/client/error-serialization.ts',
      'src/bake/enums.ts',
      'src/bake/shared.ts',
      'src/init/react-tailwind/build.ts',
      'src/init/react-tailwind/tsconfig.json',
      'src/js_parser.zig',
      'tsconfig.base.json',
      'LICENSE.md',
    ],
    paths: [
      'test',
      'packages/bun-native-bundler-plugin-api/bundler_plugin.h',
      'packages/bun-error/runtime-error.ts',
      'packages/bun-plugin-svelte/README.md',
      'packages/bun-plugin-svelte/bun.lock',
      'packages/bun-plugin-svelte/package.json',
      'packages/bun-plugin-svelte/src',
      'packages/bun-plugin-svelte/tsconfig.json',
      'packages/bun-types/package.json',
      'src/api/schema.js',
      'src/bake/client/data-view.ts',
      'src/bake/client/error-serialization.ts',
      'src/bake/enums.ts',
      'src/bake/shared.ts',
      'src/init/react-tailwind/build.ts',
      'src/init/react-tailwind/tsconfig.json',
      'src/js_parser.zig',
      'tsconfig.base.json',
      'LICENSE.md',
    ],
  },
};

function installCottontailBunPreload(snapshotRoot) {
  const bunfigPath = join(snapshotRoot, 'test', 'bunfig.toml');
  const source = readFileSync(bunfigPath, 'utf8');
  const upstreamSetting = 'preload = "./preload.ts"';
  if (!source.includes(upstreamSetting)) {
    fail(`Cannot install the Cottontail Bun test preload: ${bunfigPath} has an unexpected preload setting.`);
  }
  writeFileSync(
    bunfigPath,
    source.replace(
      upstreamSetting,
      'preload = ["../../../cottontail-bun-test-preload.ts", "./preload.ts"]',
    ),
  );
}

function fail(message) {
  throw new Error(message);
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
  const checkedOutCommit = run('git', ['rev-parse', 'HEAD'], { cwd: cloneDir }).stdout.trim();
  assertCheckoutCommit(runtime, target.tag, target.commit, checkedOutCommit);
  run('git', ['sparse-checkout', 'set', '--no-cone', ...spec.sparse], { cwd: cloneDir, stdio: 'inherit' });

  if (runtime === 'bun') {
    withBunSnapshotMutationLock(snapshotRoot, () => {
      replaceOwnedBunSnapshot({ cloneDir, snapshotRoot, spec });
    });
    console.log(`imported ${runtime} ${target.version} from ${target.tag} (${target.commit.slice(0, 12)})`);
    return;
  }

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

function replaceOwnedBunSnapshot({ cloneDir, snapshotRoot, spec }) {
  if (!existsSync(snapshotRoot)) fail(`Missing existing Bun snapshot: ${snapshotRoot}`);
  const snapshotParent = dirname(snapshotRoot);
  const stagingContainer = mkdtempSync(join(snapshotParent, '.bun-import-staging-'));
  const stagedSnapshot = join(stagingContainer, 'snapshot');
  const backupSnapshot = join(stagingContainer, 'backup');
  let originalMoved = false;
  let replacementInstalled = false;

  try {
    cpSync(snapshotRoot, stagedSnapshot, {
      recursive: true,
      dereference: false,
      force: true,
      verbatimSymlinks: true,
    });
    for (const path of spec.paths) {
      const sourcePath = join(cloneDir, path);
      const stagedPath = join(stagedSnapshot, path);
      if (!existsSync(sourcePath)) fail(`Missing copied upstream path: bun:${path}`);
      rmSync(stagedPath, { recursive: true, force: true });
      cpSync(sourcePath, stagedPath, {
        recursive: true,
        dereference: false,
        force: true,
        verbatimSymlinks: true,
      });
    }
    installCottontailBunPreload(stagedSnapshot);

    renameSync(snapshotRoot, backupSnapshot);
    originalMoved = true;
    renameSync(stagedSnapshot, snapshotRoot);
    replacementInstalled = true;
  } catch (error) {
    if (originalMoved && !replacementInstalled && !existsSync(snapshotRoot)) {
      try {
        renameSync(backupSnapshot, snapshotRoot);
        originalMoved = false;
      } catch (rollbackError) {
        throw new Error(
          `${error.message}\nRollback also failed: ${rollbackError.message}. ` +
          `The original snapshot remains at ${backupSnapshot}.`,
        );
      }
    }
    throw error;
  } finally {
    if (replacementInstalled) {
      rmSync(backupSnapshot, { recursive: true, force: true });
      rmSync(stagingContainer, { recursive: true, force: true });
    } else if (!originalMoved) {
      rmSync(stagingContainer, { recursive: true, force: true });
    }
  }
}

function main() {
  const options = parseImportArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  assertBunReplacementAllowed(options.runtime, options.allowBunReplace);

  tempRoot = mkdtempSync(join(os.tmpdir(), 'cottontail-import-upstream-'));
  try {
    const runtimes = options.runtime === 'all' ? ['node', 'bun'] : [options.runtime];
    for (const name of runtimes) importRuntime(name);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
