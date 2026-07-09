#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { builtinModules, createRequire } from 'module';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, '..');
const outPath = join(rootDir, 'compat', 'api-surface.json');

process.emitWarning = () => {};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function valueKind(value) {
  if (value === null) return 'null';
  if (typeof value !== 'function') return typeof value;
  const source = Function.prototype.toString.call(value);
  return source.startsWith('class ') ? 'class' : 'function';
}

function describeObjectExports(value) {
  const names = Object.getOwnPropertyNames(Object(value));
  const filtered = typeof value === 'function'
    ? names.filter((name) => !['arguments', 'caller', 'length', 'name', 'prototype'].includes(name))
    : names;

  return sortedUnique(filtered).map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(Object(value), name);
    return {
      name,
      kind: descriptor && 'value' in descriptor ? valueKind(descriptor.value) : 'accessor',
    };
  });
}

function collectNodeSurface() {
  const allModules = sortedUnique(builtinModules);
  const publicModules = allModules.filter((name) => !name.startsWith('_'));
  const modules = {};

  for (const specifier of publicModules) {
    try {
      const value = require(specifier);
      modules[specifier] = {
        kind: valueKind(value),
        exports: describeObjectExports(value),
      };
    } catch (error) {
      modules[specifier] = {
        error: error.message,
        exports: [],
      };
    }
  }

  return {
    source: 'local node runtime',
    version: process.version,
    allBuiltinModules: allModules,
    publicBuiltinModules: publicModules,
    modules,
  };
}

function runBunCollector() {
  const source = String.raw`
const candidateModules = ["bun", "bun:ffi", "bun:jsc", "bun:sqlite", "bun:test"];

function kind(value) {
  if (value === null) return "null";
  if (typeof value !== "function") return typeof value;
  return Function.prototype.toString.call(value).startsWith("class ") ? "class" : "function";
}

function describe(value) {
  return Object.getOwnPropertyNames(Object(value)).sort().map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(Object(value), name);
    return {
      name,
      kind: descriptor && "value" in descriptor ? kind(descriptor.value) : "accessor",
    };
  });
}

const modules = {};
for (const specifier of candidateModules) {
  try {
    const namespace = await import(specifier);
    modules[specifier] = {
      kind: kind(namespace),
      exports: describe(namespace).filter((entry) => entry.name !== Symbol.toStringTag.toString()),
    };
  } catch (error) {
    modules[specifier] = {
      error: error.message,
      exports: [],
    };
  }
}

console.log(JSON.stringify({
  source: "local bun runtime",
  version: Bun.version,
  revision: Bun.revision,
  processVersion: process.version,
  bunObjectProperties: describe(Bun),
  globalProperties: Object.getOwnPropertyNames(globalThis).sort(),
  modules,
}));
`;

  const result = spawnSync(process.env.BUN_BIN || 'bun', ['--eval', source], {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    return {
      source: 'local bun runtime',
      error: result.error.message,
      modules: {},
    };
  }

  if (result.status !== 0) {
    return {
      source: 'local bun runtime',
      error: result.stderr || result.stdout || `bun exited with ${result.status}`,
      modules: {},
    };
  }

  return JSON.parse(result.stdout);
}

function collectFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(path));
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.cjs'))) {
      files.push(path);
    }
  }
  return files;
}

function parseExportList(text) {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const aliasMatch = part.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      if (aliasMatch) return aliasMatch[1];
      const nameMatch = part.match(/^([A-Za-z_$][\w$]*)/);
      return nameMatch ? nameMatch[1] : null;
    })
    .filter(Boolean);
}

function parseRuntimeModule(filePath) {
  const source = readFileSync(filePath, 'utf8');
  const namedExports = [];
  const bunObjectProperties = [];
  const globalProperties = [];

  const patterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+const\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+let\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+var\s+([A-Za-z_$][\w$]*)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      namedExports.push(match[1]);
    }
  }

  for (const match of source.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    namedExports.push(...parseExportList(match[1]));
  }

  for (const match of source.matchAll(/\bBunObject\.([A-Za-z_$][\w$]*)\s*=/g)) {
    bunObjectProperties.push(match[1]);
  }

  for (const match of source.matchAll(/\bglobalThis\.([A-Za-z_$][\w$]*)\s*(?:=|\?\?=)/g)) {
    globalProperties.push(match[1]);
  }

  return {
    file: relative(rootDir, filePath).split(sep).join('/'),
    hasDefaultExport: /\bexport\s+default\b/.test(source) || /\bmodule\.exports\s*=/.test(source),
    namedExports: sortedUnique(namedExports),
    bunObjectProperties: sortedUnique(bunObjectProperties),
    globalProperties: sortedUnique(globalProperties),
  };
}

function runtimeModuleSpecifiers(filePath) {
  const relativePath = relative(join(rootDir, 'src', 'runtime_modules'), filePath).split(sep).join('/');
  const withoutExt = relativePath.replace(/\.(?:cjs|js)$/, '');

  if (withoutExt === 'bun/index') return ['bun'];
  if (withoutExt === 'bun/ffi') return ['bun:ffi'];
  if (withoutExt.startsWith('node/')) {
    const specifier = withoutExt.slice('node/'.length);
    return specifier === 'assert'
      ? ['assert', 'node:assert']
      : [specifier, `node:${specifier}`];
  }

  return [withoutExt];
}

function collectCottontailSurface() {
  const runtimeRoot = join(rootDir, 'src', 'runtime_modules');
  const files = existsSync(runtimeRoot) ? collectFiles(runtimeRoot) : [];
  const modules = {};
  const filesByPath = {};
  const bunObjectProperties = [];
  const globalProperties = [];

  for (const filePath of files) {
    const parsed = parseRuntimeModule(filePath);
    filesByPath[parsed.file] = parsed;
    bunObjectProperties.push(...parsed.bunObjectProperties);
    globalProperties.push(...parsed.globalProperties);

    for (const specifier of runtimeModuleSpecifiers(filePath)) {
      modules[specifier] = {
        file: parsed.file,
        exports: parsed.namedExports,
        hasDefaultExport: parsed.hasDefaultExport,
      };
    }
  }

  return {
    source: 'src/runtime_modules static parse',
    modules,
    files: filesByPath,
    bunObjectProperties: sortedUnique(bunObjectProperties),
    globalProperties: sortedUnique(globalProperties),
  };
}

function exportNames(entries) {
  return sortedUnique((entries || []).map((entry) => entry.name ?? entry));
}

function compareExports(targetNames, currentNames) {
  const target = new Set(targetNames);
  const current = new Set(currentNames);
  return {
    implemented: [...target].filter((name) => current.has(name)).sort(),
    missing: [...target].filter((name) => !current.has(name)).sort(),
    extra: [...current].filter((name) => !target.has(name)).sort(),
  };
}

function currentExportsForTarget(current, targetNames) {
  const names = [...(current?.exports || [])];
  if (current?.hasDefaultExport && targetNames.includes('default')) {
    names.push('default');
  }
  return names;
}

function buildCoverage(nodeSurface, bunSurface, cottontailSurface) {
  const node = {};
  for (const specifier of nodeSurface.publicBuiltinModules) {
    const current = cottontailSurface.modules[specifier] || cottontailSurface.modules[`node:${specifier}`];
    const targetNames = exportNames(nodeSurface.modules[specifier]?.exports);
    const currentNames = currentExportsForTarget(current, targetNames);
    node[specifier] = {
      module: current ? 'present' : 'missing',
      ...compareExports(targetNames, currentNames),
    };
  }

  const bunObjectTarget = exportNames(bunSurface.bunObjectProperties);
  const bunObjectCurrent = cottontailSurface.bunObjectProperties;

  const bunModules = {};
  for (const [specifier, target] of Object.entries(bunSurface.modules || {})) {
    const current = cottontailSurface.modules[specifier];
    const targetNames = exportNames(target.exports);
    bunModules[specifier] = {
      module: current ? 'present' : 'missing',
      ...compareExports(targetNames, currentExportsForTarget(current, targetNames)),
    };
  }

  return {
    node,
    bun: {
      Bun: compareExports(bunObjectTarget, bunObjectCurrent),
      modules: bunModules,
    },
  };
}

const nodeSurface = collectNodeSurface();
const bunSurface = runBunCollector();
const cottontailSurface = collectCottontailSurface();
const manifest = {
  schemaVersion: 1,
  generatedBy: 'scripts/generate-api-surface.js',
  note: 'This is an API-name inventory, not a behavioral compatibility result.',
  targets: {
    node: nodeSurface,
    bun: bunSurface,
  },
  cottontail: cottontailSurface,
  coverage: buildCoverage(nodeSurface, bunSurface, cottontailSurface),
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${relative(rootDir, outPath)}`);
