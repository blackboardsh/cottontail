#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const outputPath = process.argv[2];
const sourceDir = resolve(process.argv[3] ?? join(rootDir, 'src', 'runtime_modules'));

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

const files = collectFiles(sourceDir).sort((a, b) => a.localeCompare(b));
const header = Buffer.allocUnsafe(8);
header.write('CTRM', 0, 4, 'ascii');
header.writeUInt32LE(files.length, 4);
const chunks = [header];

for (const file of files) {
  const path = Buffer.from(relative(sourceDir, file).split(sep).join('/'));
  const contents = readFileSync(file);
  const record = Buffer.allocUnsafe(8);
  record.writeUInt32LE(path.length, 0);
  record.writeUInt32LE(contents.length, 4);
  chunks.push(record, path, contents);
}

writeFileSync(outputPath, Buffer.concat(chunks));
