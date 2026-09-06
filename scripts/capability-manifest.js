#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const capabilityAliases = {
  colors: ['color'],
  compression: ['zlib'],
  cookies: ['cookie'],
  'filesystem-router': ['filesystemRouter'],
  'html-rewriter': ['htmlRewriter'],
  'jsc-tools': ['jsc', 'jscTools'],
};

// These are Bun's public, top-level lazy facades. A capability bundle that
// reaches one of them will activate the corresponding runtime component.
const bunMembers = {
  archive: ['Archive'],
  build: ['build', 'BuildMessage', 'ResolveMessage'],
  colors: ['color'],
  compression: [
    'deflateSync',
    'gzipSync',
    'gunzipSync',
    'inflateSync',
    'zstdCompress',
    'zstdCompressSync',
    'zstdDecompress',
    'zstdDecompressSync',
  ],
  cookies: ['Cookie', 'CookieMap'],
  csrf: ['CSRF'],
  data: ['JSONC', 'JSONL'],
  ffi: ['CFunction', 'FFI', 'JSCallback', 'cc', 'dlopen', 'linkSymbols'],
  'filesystem-router': ['FileSystemRouter'],
  glob: ['Glob'],
  hashing: ['CryptoHasher', 'MD4', 'MD5', 'SHA1', 'SHA224', 'SHA256', 'SHA384', 'SHA512', 'SHA512_256', 'hash'],
  'html-rewriter': ['HTMLRewriter'],
  json5: ['JSON5'],
  markdown: ['markdown'],
  password: ['password'],
  redis: ['RedisClient', 'redis'],
  s3: ['S3Client', 's3'],
  secrets: ['secrets'],
  shell: ['$', 'Shell', 'ShellError', 'ShellExpression', 'ShellOutput', 'ShellPromise'],
  sql: ['SQL', 'postgres', 'sql'],
  terminal: ['Terminal'],
  toml: ['TOML'],
  uuid: ['randomUUIDv5', 'randomUUIDv7'],
  yaml: ['YAML'],
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function capabilityNames(name) {
  return [...new Set([name, ...(capabilityAliases[name] ?? [])])];
}

function hasRuntimeNamespaceAccess(source, names) {
  return names.some(name => new RegExp(
    `\\bCottontail(?:\\.(?:bun|node))?\\.${escapeRegExp(name)}(?![A-Za-z0-9_$-])`,
  ).test(source));
}

function hasRuntimeModuleImport(source, names) {
  return names.some(name => {
    const specifier = `(?:bun|node):${escapeRegExp(name)}`;
    return new RegExp(
      `(?:\\brequire|\\bimport)\\(\\s*["']${specifier}["']\\s*\\)|` +
      `\\bfrom\\s*["']${specifier}["']|\\bimport\\s*["']${specifier}["']|` +
      `Symbol\\.for\\(\\s*["']cottontail\\.capabilityRequire["']\\s*\\)\\]\\(\\s*["']${specifier}["']`,
    ).test(source);
  });
}

function hasBunMemberAccess(source, members) {
  return (members ?? []).some(member => new RegExp(
    `\\bBun(?:\\.|\\?\\.)${escapeRegExp(member)}(?![A-Za-z0-9_$])`,
  ).test(source));
}

function explicitCapabilityLoads(source) {
  const dependencies = [];
  const pattern = /\bloadCottontailCapabilityModule\(\s*(["'])([a-z0-9-]+)\1\s*,/g;
  for (const match of source.matchAll(pattern)) dependencies.push(match[2]);
  return dependencies;
}

function assertCapabilityId(name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Invalid Cottontail capability name: ${JSON.stringify(name)}`);
  }
}

export function createCapabilityManifest(entries) {
  const sources = new Map();
  for (const { name, source } of entries) {
    assertCapabilityId(name);
    if (sources.has(name)) throw new Error(`Duplicate Cottontail capability: ${name}`);
    sources.set(name, source);
  }
  if (sources.size === 0) throw new Error('Cottontail capability manifest cannot be empty');

  const graph = new Map();
  const catalog = [...sources.keys()].sort();
  for (const name of catalog) {
    const source = sources.get(name);
    const requires = new Set(explicitCapabilityLoads(source));
    for (const dependency of catalog) {
      if (dependency === name) continue;
      const names = capabilityNames(dependency);
      if (
        hasRuntimeNamespaceAccess(source, names) ||
        hasRuntimeModuleImport(source, names) ||
        hasBunMemberAccess(source, bunMembers[dependency])
      ) {
        requires.add(dependency);
      }
    }
    for (const dependency of requires) {
      if (!sources.has(dependency)) {
        throw new Error(`Cottontail capability ${name} requires unknown capability ${dependency}`);
      }
      if (dependency === name) requires.delete(dependency);
    }
    graph.set(name, [...requires].sort());
  }
  return {
    schema: 1,
    capabilities: Object.fromEntries(
      catalog.map(name => [name, { requires: graph.get(name) }]),
    ),
  };
}

function main(argv) {
  const [outputPath, ...capabilityArgs] = argv;
  if (!outputPath || capabilityArgs.length === 0 || capabilityArgs.length % 2 !== 0) {
    throw new Error('usage: capability-manifest.js OUTPUT NAME BUNDLE [NAME BUNDLE ...]');
  }
  const entries = [];
  for (let index = 0; index < capabilityArgs.length; index += 2) {
    entries.push({
      name: capabilityArgs[index],
      source: readFileSync(capabilityArgs[index + 1], 'utf8'),
    });
  }
  const manifest = createCapabilityManifest(entries);
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
