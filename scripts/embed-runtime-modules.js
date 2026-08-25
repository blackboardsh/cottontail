#!/usr/bin/env node

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const outputPath = process.argv[2];
const sourceDir = resolve(process.argv[3] ?? join(rootDir, 'src', 'runtime_modules'));
const compilerRuntimePath = resolve(process.argv[4] ?? join(rootDir, 'src', 'compiler', 'src', 'runtime.js'));
const compilerBunRuntimePath = resolve(process.argv[5] ?? join(rootDir, 'src', 'compiler', 'src', 'runtime.bun.js'));
const bufferFallbackPath = resolve(process.argv[6] ?? join(rootDir, 'src', 'compiler', 'src', 'node-fallbacks', 'buffer.js'));
const base64FallbackPath = resolve(process.argv[7] ?? join(rootDir, 'src', 'compiler', 'src', 'node-fallbacks', 'vendor', 'base64-js.js'));
const ieee754FallbackPath = resolve(process.argv[8] ?? join(rootDir, 'src', 'compiler', 'src', 'node-fallbacks', 'vendor', 'ieee754.js'));
const builderRuntime = process.argv[9] === 'capability-builder';

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

const capabilityFiles = {
  // FFI is emitted as a capability from the outset. Its current implementation
  // also owns bootstrap side effects, so the core copy is retained until that
  // historical coupling is split; consumers never use this packed copy yet.
  ffi: ['bun/ffi-implementation.js'],
  sqlite: ['bun/sqlite.js', 'node/sqlite.js'],
  javascript: [
    'bun/redis.js',
    'bun/s3.js',
    'bun/json5.js',
    'bun/color.js',
    'bun/jsc.js',
    'bun/yaml.js',
    'vendor/yaml.js',
    'bun/sql.js',
    'bun/test.js',
    'node/test.js',
    'node/test/reporters.js',
    'bun/shell.js',
    'bun/build.js',
    'bun/cookie.js',
    'vendor/ws.js',
    'bun/websocket-native.js',
    'bun/bake-dev-server.js',
    'bun/bake-production.js',
    'bun/bake-framework.js',
    'bun/bake-framework-router.js',
    'bun/bake-error-report.js',
    'bun/bake-source-map.js',
    'node/inspector.js',
    'node/inspector/promises.js',
    'node/repl.js',
    'node/sea.js',
    'node/zlib.js',
    'bun/glob.js',
    'bun/text.js',
    'bun/uuid.js',
    'bun/password.js',
    'bun/hashing.js',
    'bun/data.js',
    'bun/markdown.js',
    'bun/archive.js',
    'bun/filesystem-router.js',
    'bun/html-rewriter.js',
    'bun/terminal.js',
    'bun/csrf.js',
    'bun/secrets.js',
  ],
};

for (const relativePath of capabilityFiles.ffi) {
  const index = files.findIndex(entry => entry.path === relativePath);
  if (index !== -1) files.splice(index, 1);
}
// This historical source is retained for review while the split settles, but
// no runtime path imports or embeds it.
const historicalFfiIndex = files.findIndex(entry => entry.path === 'bun/ffi.js');
if (historicalFfiIndex !== -1) files.splice(historicalFfiIndex, 1);

// SQLite has no core fallback. Its compatibility modules are small façades
// which enter the same filesystem-backed capability loader as Cottontail.sqlite.
for (const relativePath of capabilityFiles.sqlite) {
  const index = files.findIndex(entry => entry.path === relativePath);
  if (index !== -1) files.splice(index, 1);
}
for (const relativePath of capabilityFiles.javascript) {
  if (builderRuntime && (relativePath === 'bun/build.js' || relativePath === 'node/zlib.js')) continue;
  const index = files.findIndex(entry => entry.path === relativePath);
  if (index !== -1) files.splice(index, 1);
}
if (builderRuntime) {
  const index = files.findIndex(entry => entry.path === 'bun/index.js');
  if (index !== -1) {
    const source = readFileSync(files[index].file, 'utf8').replace(
      'loadCottontailCapabilityModule("build", "bun/build.js")',
      'loadEmbeddedRuntimeModule("bun/build.js")',
    ).replace(
      '// These compatibility aliases expose the canonical lazy facade',
      `// The capability builder creates the filesystem stdlib and therefore\n` +
      `// uses its embedded compression implementation while bundling.\n` +
      `Object.defineProperty(globalThis.Cottontail, "compression", {\n` +
      `  configurable: true,\n` +
      `  get() {\n` +
      `    const value = loadEmbeddedRuntimeModule("node/zlib.js");\n` +
      `    Object.defineProperty(globalThis.Cottontail, "compression", { value, configurable: true });\n` +
      `    return value;\n` +
      `  },\n` +
      `});\n\n` +
      `// These compatibility aliases expose the canonical lazy facade`,
    );
    files[index] = { contents: Buffer.from(source), path: 'bun/index.js' };
  }
}
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
if (!files.some(entry => entry.path === 'node/internal/buffer-polyfill.js')) {
  files.push({ file: bufferFallbackPath, path: 'node/internal/buffer-polyfill.js' });
}
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
