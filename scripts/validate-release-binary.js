#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertStrippedReleaseBinary,
  elfExportSymbolsFromVersionScript,
  listExportedSymbols,
  peExportSymbolsFromModuleDefinition,
} from './release-binary-contract.js';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const executableName = process.platform === 'win32' ? 'cottontail.exe' : 'cottontail';
const executablePath = process.argv[2]
  ? resolve(process.argv[2])
  : join(rootDir, 'zig-out', 'bin', executableName);
const linuxVersionScriptPath = join(rootDir, 'src', 'compiler', 'src', 'symbols.dyn');
const windowsModuleDefinitionPath = join(rootDir, 'src', 'compiler', 'src', 'symbols.def');

function fail(message) {
  console.error(`Cottontail release binary validation failed: ${message}`);
  process.exit(1);
}

let details;
let exportedSymbols;
try {
  const executable = readFileSync(executablePath);
  details = assertStrippedReleaseBinary(executable);
  exportedSymbols = listExportedSymbols(executable);
} catch (error) {
  fail(`${executablePath}: ${error.message}`);
}

const maximumExportedSymbols = 1024;
if (exportedSymbols.length > maximumExportedSymbols) {
  fail(
    `${executablePath} exports ${exportedSymbols.length} symbols; ` +
      `the native-addon ABI limit is ${maximumExportedSymbols}`,
  );
}

if (details.format === 'elf64' || details.format === 'pe') {
  const allowedExports = new Set(details.format === 'elf64'
    ? elfExportSymbolsFromVersionScript(readFileSync(linuxVersionScriptPath))
    : peExportSymbolsFromModuleDefinition(readFileSync(windowsModuleDefinitionPath)));
  const unexpectedExports = exportedSymbols.filter((symbol) => !allowedExports.has(symbol));
  if (unexpectedExports.length > 0) {
    fail(
      `${executablePath} exports symbols outside the native-addon ABI: ` +
        unexpectedExports.slice(0, 10).join(', '),
    );
  }
}

const symbolPrefix = details.format === 'mach-o' ? '_' : '';
const exportedSet = new Set(exportedSymbols);
for (const symbol of [
  'napi_create_object',
  'napi_create_threadsafe_function',
  'napi_get_version',
  'napi_module_register',
  'node_api_get_module_file_name',
  'node_module_register',
  'uv_dlopen',
  'uv_queue_work',
  'uv_thread_create',
]) {
  if (!exportedSet.has(`${symbolPrefix}${symbol}`)) {
    fail(`${executablePath} does not export required native-addon symbol ${symbol}`);
  }
}

if (details.format === 'mach-o') {
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
console.log(`Validated native-addon ABI (${exportedSymbols.length} exported symbols): ${executablePath}`);
