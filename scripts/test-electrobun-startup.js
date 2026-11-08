#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log('Electrobun native startup ordering applies to macOS.');
  process.exit(0);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = resolve(process.argv[2] || join(root, 'zig-out/bin/cottontail'));
assert.ok(existsSync(binary), `Cottontail binary is missing: ${binary}`);
const directory = mkdtempSync(join(tmpdir(), 'cottontail-electrobun-startup-'));
const wrapper = join(directory, 'libNativeWrapper.dylib');
const core = join(directory, 'libElectrobunCore.dylib');
const fixture = join(root, 'tests/native/electrobun_startup.c');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', timeout: 30_000, ...options });
  assert.ifError(result.error);
  return result;
}

function requireStatus(result, status) {
  assert.equal(result.status, status, `signal=${result.signal}\n${result.stdout}\n${result.stderr}`);
}

function environment(name, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('COTTONTAIL_ELECTROBUN_')) delete env[key];
  return {
    ...env,
    COTTONTAIL_ELECTROBUN_DIST: directory,
    COTTONTAIL_TEST_STARTUP_TRACE: join(directory, `${name}.trace`),
    COTTONTAIL_TEST_SCRIPT_DONE: join(directory, `${name}.done`),
    ...extra,
  };
}

try {
  requireStatus(run('xcrun', ['clang', '-dynamiclib', fixture, '-o', wrapper]), 0);
  requireStatus(run('xcrun', ['clang', '-dynamiclib', '-DFIXTURE_CORE', fixture, '-o', core]), 0);
  const script = join(directory, 'startup.js');
  writeFileSync(script, `
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    try {
      const trace = readFileSync(process.env.COTTONTAIL_TEST_STARTUP_TRACE, 'utf8');
      if (trace !== 'native-loaded\\n') throw new Error('Native initialization did not precede the script worker');
      new Intl.DateTimeFormat('en-US').format(new Date());
      appendFileSync(process.env.COTTONTAIL_TEST_STARTUP_TRACE, 'script\\n');
      console.log('Electrobun native startup order passed');
    } finally {
      writeFileSync(process.env.COTTONTAIL_TEST_SCRIPT_DONE, 'done');
    }
  `);

  for (const status of [0, 9]) {
    const env = environment(`ordered-${status}`, { COTTONTAIL_TEST_CORE_STATUS: String(status) });
    const result = run(binary, [script], { env });
    requireStatus(result, status);
    assert.match(result.stdout, /Electrobun native startup order passed/);
    assert.equal(readFileSync(env.COTTONTAIL_TEST_STARTUP_TRACE, 'utf8'),
      'native-loaded\nscript\nmain-loop\nnative-unloaded\n');
  }

  // A missing library must stop startup before any user script executes.
  renameSync(wrapper, `${wrapper}.saved`);
  const missingEnv = environment('missing');
  const missing = run(binary, [script], { env: missingEnv });
  requireStatus(missing, 1);
  assert.match(missing.stderr, /failed to preload Electrobun native wrapper/);
  assert.equal(existsSync(missingEnv.COTTONTAIL_TEST_SCRIPT_DONE), false);
  assert.equal(existsSync(missingEnv.COTTONTAIL_TEST_STARTUP_TRACE), false);

  // Ordinary CLI execution must not require or load Electrobun libraries.
  const plain = join(directory, 'plain.js');
  writeFileSync(plain, `console.log(new Intl.DateTimeFormat('en-US').format(new Date(0)));`);
  const plainEnv = environment('plain');
  delete plainEnv.COTTONTAIL_ELECTROBUN_DIST;
  requireStatus(run(binary, [plain], { env: plainEnv }), 0);
  assert.equal(existsSync(plainEnv.COTTONTAIL_TEST_STARTUP_TRACE), false);
  console.log('Electrobun macOS native initialization precedes JS, retains library lifetime, and preserves exit status.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
