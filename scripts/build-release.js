#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  elfExportSymbolsFromVersionScript,
  peExportSymbolsFromModuleDefinition,
  restrictElfDynamicExports,
  restrictPortableExecutableExports,
} from './release-binary-contract.js';
import { releaseTargetArgs } from './release-target.js';

const rootDir = process.cwd();
const zigName = process.platform === 'win32' ? 'zig.exe' : 'zig';
const executableName = process.platform === 'win32' ? 'cottontail.exe' : 'cottontail';
const zigPath = join(rootDir, 'vendors', 'zig', zigName);
const executablePath = join(rootDir, 'zig-out', 'bin', executableName);
const stdlibPath = join(rootDir, 'zig-out', 'bin', 'cottontail-stdlib');
const corePath = join(rootDir, 'zig-out', 'bin', 'cottontail-core');
const validatorPath = join(rootDir, 'scripts', 'validate-release-binary.js');
const macosExportListPath = join(rootDir, 'src', 'compiler', 'src', 'symbols.txt');
const linuxVersionScriptPath = join(rootDir, 'src', 'compiler', 'src', 'symbols.dyn');
const windowsModuleDefinitionPath = join(rootDir, 'src', 'compiler', 'src', 'symbols.def');
const nativeBindingsGenerator = join(rootDir, 'scripts', 'generate-native-bindings.js');

if (!existsSync(zigPath)) {
  console.error(`Vendored Zig compiler not found at ${zigPath}. Run the cottontail setup first.`);
  process.exit(1);
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const error = new Error(`${label} failed with exit code ${result.status ?? 'unknown'}.`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

const stagingRoot = mkdtempSync(join(tmpdir(), 'cottontail-release-'));
const stagedExecutable = join(stagingRoot, 'bin', executableName);
const stagedStdlib = join(stagingRoot, 'bin', 'cottontail-stdlib');
const stagedCore = join(stagingRoot, 'bin', 'cottontail-core');

try {
  run(process.execPath, [nativeBindingsGenerator], 'Native binding generation');
  const args = [
    'build',
    '-Doptimize=ReleaseFast',
    ...releaseTargetArgs(process.platform),
    '--prefix',
    stagingRoot,
  ];

  run(zigPath, args, 'Cottontail release build');
  if (process.platform === 'darwin') {
    // Keep only the host ABI consumed by N-API and native Bun/Node addons.
    run(
      '/usr/bin/strip',
      ['-i', '-s', macosExportListPath, stagedExecutable],
      'Cottontail release strip',
    );
    run(
      '/usr/bin/codesign',
      ['--force', '--sign', '-', '--pagesize', '16384', stagedExecutable],
      'Cottontail release ad-hoc signing',
    );
  } else if (process.platform === 'linux') {
    const linuxExportSymbols = elfExportSymbolsFromVersionScript(
      readFileSync(linuxVersionScriptPath),
    );
    run(process.env.STRIP ?? 'strip', [stagedExecutable], 'Cottontail release strip');

    // Zig 0.16 accepts --version-script but its built-in ELF linker omits the
    // script from the final link. Restrict the final .dynsym visibility until
    // the linker applies the manifest itself.
    const restricted = restrictElfDynamicExports(
      readFileSync(stagedExecutable),
      linuxExportSymbols,
    );
    writeFileSync(stagedExecutable, restricted.buffer);
    console.log(
      `Restricted Linux native-addon ABI: ${restricted.retainedSymbols} retained, ` +
        `${restricted.exposedSymbols} exposed, ${restricted.hiddenSymbols} hidden`,
    );
  } else if (process.platform === 'win32') {
    const windowsExportSymbols = peExportSymbolsFromModuleDefinition(
      readFileSync(windowsModuleDefinitionPath),
    );
    const restricted = restrictPortableExecutableExports(
      readFileSync(stagedExecutable),
      windowsExportSymbols,
    );
    writeFileSync(stagedExecutable, restricted.buffer);
    console.log(
      `Restricted Windows native-addon ABI: ${restricted.retainedSymbols} retained, ` +
        `${restricted.hiddenSymbols} hidden`,
    );
  }
  run(
    process.execPath,
    [validatorPath, stagedExecutable],
    'Cottontail staged release validation',
  );

  mkdirSync(dirname(executablePath), { recursive: true });
  copyFileSync(stagedExecutable, executablePath);
  if (!existsSync(stagedStdlib)) {
    throw new Error(`Cottontail release build did not stage its stdlib at ${stagedStdlib}.`);
  }
  if (!existsSync(stagedCore)) {
    throw new Error(`Cottontail release build did not stage its core bytecode at ${stagedCore}.`);
  }
  rmSync(stdlibPath, { recursive: true, force: true });
  cpSync(stagedStdlib, stdlibPath, { recursive: true });
  rmSync(corePath, { recursive: true, force: true });
  cpSync(stagedCore, corePath, { recursive: true });
  if (process.platform !== 'win32') chmodSync(executablePath, 0o755);
  run(
    process.execPath,
    [validatorPath, executablePath],
    'Cottontail installed release validation',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
