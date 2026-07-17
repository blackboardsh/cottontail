#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const outputPath = process.argv[2];
const sourceDir = resolve(process.argv[3] ?? join(rootDir, 'src', 'runtime_modules'));
const compilerRuntimePath = resolve(process.argv[4] ?? join(rootDir, 'src', 'compiler', 'src', 'runtime.js'));
const compilerBunRuntimePath = resolve(process.argv[5] ?? join(rootDir, 'src', 'compiler', 'src', 'runtime.bun.js'));
const bufferFallbackPath = resolve(process.argv[6] ?? join(rootDir, 'src', 'compiler', 'src', 'node-fallbacks', 'buffer.js'));
const base64FallbackPath = resolve(process.argv[7] ?? join(rootDir, 'src', 'compiler', 'src', 'node-fallbacks', 'vendor', 'base64-js.js'));
const ieee754FallbackPath = resolve(process.argv[8] ?? join(rootDir, 'src', 'compiler', 'src', 'node-fallbacks', 'vendor', 'ieee754.js'));

if (!outputPath) {
  console.error('usage: node scripts/embed-runtime-modules.js <output>');
  process.exit(2);
}

function collectFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(path, files);
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const files = collectFiles(sourceDir)
  .map(file => ({ file, path: relative(sourceDir, file).split(sep).join('/') }));
const compilerBunRuntime = readFileSync(compilerBunRuntimePath, 'utf8')
  .replace(/^export \* from ["']\.\/runtime["'];?\s*/, '');
files.push({
  contents: Buffer.concat([
    readFileSync(compilerRuntimePath),
    Buffer.from('\n'),
    Buffer.from(compilerBunRuntime),
  ]),
  path: 'bun/wrap.js',
});
files.push({ file: bufferFallbackPath, path: 'node/internal/buffer-polyfill.js' });
files.push({ file: base64FallbackPath, path: 'node/internal/vendor/base64-js.js' });
files.push({ file: ieee754FallbackPath, path: 'node/internal/vendor/ieee754.js' });
files.sort((a, b) => a.path.localeCompare(b.path));
const header = Buffer.allocUnsafe(8);
header.write('CTRM', 0, 4, 'ascii');
header.writeUInt32LE(files.length, 4);
const chunks = [header];

for (const entry of files) {
  const path = Buffer.from(entry.path);
  const contents = entry.contents ?? readFileSync(entry.file);
  const record = Buffer.allocUnsafe(8);
  record.writeUInt32LE(path.length, 0);
  record.writeUInt32LE(contents.length, 4);
  chunks.push(record, path, contents);
}

writeFileSync(outputPath, Buffer.concat(chunks));
