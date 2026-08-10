#!/usr/bin/env node

import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import {
  elfExportSymbolsFromVersionScript,
  restrictElfDynamicExports,
} from './release-binary-contract.js';

const executablePath = process.argv[2] ? resolve(process.argv[2]) : null;
const versionScriptPath = process.argv[3] ? resolve(process.argv[3]) : null;

if (!executablePath || !versionScriptPath) {
  console.error(
    'Usage: node scripts/restrict-linux-release-exports.js <executable> <version-script>',
  );
  process.exit(1);
}

const allowedSymbols = elfExportSymbolsFromVersionScript(readFileSync(versionScriptPath));
const restricted = restrictElfDynamicExports(readFileSync(executablePath), allowedSymbols);
const temporaryPath = join(
  dirname(executablePath),
  `.${process.pid}-${Date.now()}-${basename(executablePath)}.tmp`,
);

try {
  const mode = statSync(executablePath).mode;
  writeFileSync(temporaryPath, restricted.buffer, { mode });
  chmodSync(temporaryPath, mode);
  renameSync(temporaryPath, executablePath);
} finally {
  rmSync(temporaryPath, { force: true });
}

console.log(
  `Restricted Linux native-addon ABI: ${restricted.retainedSymbols} retained, ` +
    `${restricted.exposedSymbols} exposed, ${restricted.hiddenSymbols} hidden`,
);
