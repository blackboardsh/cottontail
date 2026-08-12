#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const executablePath = resolve(process.argv[2] ?? join(
  'zig-out',
  'bin',
  process.platform === 'win32' ? 'cottontail.exe' : 'cottontail',
));

function runPrivateFile(mode) {
  const privateRoot = mkdtempSync(join(tmpdir(), `cottontail-hutch-${mode}-smoke-`));
  const privateFile = join(privateRoot, `hutch-${mode}-smoke.mjs`);
  writeFileSync(
    privateFile,
    'process.stdout.write(globalThis.__cottontailHutchPrivateFileMode);\n',
  );
  if (process.platform !== 'win32') {
    chmodSync(privateRoot, 0o700);
    chmodSync(privateFile, 0o600);
  }

  try {
    const args = [
      `--hutch-${mode}-file`,
      privateFile,
      '--hutch-private-root',
      privateRoot,
    ];
    if (mode === 'shell') args.push('smoke-command');
    const result = spawnSync(executablePath, args, {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    assert.deepEqual({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message,
    }, {
      status: 0,
      signal: null,
      stdout: mode,
      stderr: '',
      error: undefined,
    }, `${basename(executablePath)} failed the Hutch private ${mode} file smoke`);
  } finally {
    rmSync(privateRoot, { recursive: true, force: true });
  }
}

runPrivateFile('config');
runPrivateFile('shell');
process.stdout.write('Hutch private file release smoke passed\n');
