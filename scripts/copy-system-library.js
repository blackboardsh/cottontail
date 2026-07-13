import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

const [outputPath, compiler, library] = process.argv.slice(2);

if (!outputPath || !compiler || !library) {
  console.error('usage: node scripts/copy-system-library.js <output> <compiler> <library>');
  process.exit(2);
}

const result = spawnSync(compiler, [`-print-file-name=${library}`], {
  encoding: 'utf8',
});

if (result.error) {
  console.error(`failed to start ${compiler}: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const libraryPath = result.stdout.trim();
if (!isAbsolute(libraryPath) || !existsSync(libraryPath)) {
  console.error(`${compiler} could not resolve ${library}: ${libraryPath || '<empty output>'}`);
  process.exit(1);
}

mkdirSync(dirname(outputPath), { recursive: true });
copyFileSync(libraryPath, outputPath);
