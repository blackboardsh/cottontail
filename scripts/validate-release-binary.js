#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertStrippedReleaseBinary } from './release-binary-contract.js';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const executableName = process.platform === 'win32' ? 'cottontail.exe' : 'cottontail';
const executablePath = process.argv[2]
  ? resolve(process.argv[2])
  : join(rootDir, 'zig-out', 'bin', executableName);

function fail(message) {
  console.error(`Cottontail release binary validation failed: ${message}`);
  process.exit(1);
}

let details;
try {
  details = assertStrippedReleaseBinary(readFileSync(executablePath));
} catch (error) {
  fail(`${executablePath}: ${error.message}`);
}

if (process.platform === 'darwin') {
  const signature = spawnSync('/usr/bin/codesign', ['--verify', '--strict', executablePath], {
    encoding: 'utf8',
  });
  if (signature.status !== 0) {
    fail(
      `macOS signature verification failed for ${executablePath}: ` +
        `${signature.stderr || signature.stdout || signature.error?.message || 'unknown error'}`,
    );
  }
}

const symbolSummary = details.format === 'mach-o'
  ? `${details.symbols} symbol-table entries, ${details.localSymbols} local symbols`
  : details.format === 'elf64'
    ? `${details.staticSymbolTables} static symbol tables`
    : `${details.symbols} COFF symbols`;
console.log(`Validated stripped ${details.format} release binary (${symbolSummary}): ${executablePath}`);
