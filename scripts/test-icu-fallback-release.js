#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const binary = resolve(process.argv[2]);
const fixture = fileURLToPath(new URL('../tests/js/icu-fallback-smoke.js', import.meta.url));
const env = { ...process.env, COTTONTAIL_ICU_FORCE_FALLBACK: '1' };
delete env.COTTONTAIL_RUNTIME_MODULES_DIR;
const args = [fixture];
// Prevent the macOS check from downloading ICU or using a developer's cached
// copy. The archive's immutable data file must satisfy fallback startup.
const profile = '(version 1)(allow default)(deny network*)(deny file-read* (subpath "/opt/homebrew") (subpath "/usr/local") (regex #"/Cottontail/icu/") (regex #"/[.]local/share/cottontail/icu/"))';
const command = process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : binary;
const commandArgs = process.platform === 'darwin' ? ['-p', profile, binary, ...args] : args;
const result = spawnSync(command, commandArgs, {
  env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
});
assert.ifError(result.error);
assert.equal(result.status, 0, `Packaged ICU fallback failed:\n${result.stdout}\n${result.stderr}`);
assert.equal(result.stdout.trim(), 'icu fallback passed');
process.stdout.write(result.stdout);
