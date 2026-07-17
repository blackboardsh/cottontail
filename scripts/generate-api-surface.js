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
    /\bexport\s+(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/g,
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
  if (withoutExt === 'bun/jsc') return ['bun:jsc'];
  if (withoutExt === 'bun/sqlite') return ['bun:sqlite'];
  if (withoutExt === 'bun/test') return ['bun:test'];
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

const upstreamDisabledStatuses = new Set(['disabled', 'skip']);

function countAllFiles(dir) {
  if (!existsSync(dir)) return 0;
  const tracked = spawnSync('git', ['ls-files', '-z', '--', relative(rootDir, dir)], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (tracked.status === 0) {
    return tracked.stdout.split('\0').filter(Boolean).length;
  }

  let count = 0;
  const stack = [dir];
  const installedDependencies = join(dir, 'test', 'node_modules');
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (path === installedDependencies) continue;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(path);
      } else {
        count += 1;
      }
    }
  }
  return count;
}

function discoverUpstreamRunnableFiles(snapshotRoot, runtime) {
  const testRoot = join(snapshotRoot, 'test');
  const installedDependencies = join(testRoot, 'node_modules');
  if (!existsSync(testRoot)) return [];
  const runnablePattern = runtime === 'bun'
    ? /\.test\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/i
    : /\.(?:js|mjs|cjs)$/i;
  const result = [];
  const stack = [testRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (path === installedDependencies) continue;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(path);
      } else if (entry.isFile() && runnablePattern.test(entry.name)) {
        result.push(relative(snapshotRoot, path).split(sep).join('/'));
      }
    }
  }
  return result.sort();
}

function upstreamPatternEntries(status) {
  return Array.isArray(status.patterns) ? status.patterns : [];
}

function upstreamPatternStatusForPath(status, path) {
  let matched = null;
  for (const pattern of upstreamPatternEntries(status)) {
    if (!pattern?.pattern || !pattern?.status) continue;
    if (new RegExp(pattern.pattern).test(path)) matched = pattern;
  }
  return matched;
}

function upstreamStatusEntryForPath(status, path, defaultStatus = status.defaultStatus ?? 'not-enabled') {
  const patternEntry = upstreamPatternStatusForPath(status, path);
  return {
    path,
    status: defaultStatus,
    reason: undefined,
    ...(patternEntry ?? {}),
    ...(status.tests?.[path] ?? {}),
  };
}

function assertUpstreamStatusSummary(summary) {
  const classifiedTests = summary.enabled + summary.expectedFailure + summary.disabled;
  if (summary.classifiedTests !== classifiedTests) {
    throw new Error(`classified upstream count mismatch: ${summary.classifiedTests} !== ${classifiedTests}`);
  }
  if (summary.discoveredRunnableFiles !== classifiedTests + summary.notEnabled) {
    throw new Error(
      `discovered upstream count mismatch: ${summary.discoveredRunnableFiles} !== ` +
      `${classifiedTests} classified + ${summary.notEnabled} not-enabled`
    );
  }
}

function summarizeUpstreamRunnableStatuses(entries) {
  const summary = {
    discoveredRunnableFiles: entries.length,
    enabled: 0,
    expectedFailure: 0,
    disabled: 0,
    notEnabled: 0,
    classifiedTests: 0,
  };
  const unknown = [];

  for (const entry of entries) {
    if (entry.status === 'enabled') summary.enabled += 1;
    else if (entry.status === 'expected-failure') summary.expectedFailure += 1;
    else if (upstreamDisabledStatuses.has(entry.status)) summary.disabled += 1;
    else if (entry.status === 'not-enabled') summary.notEnabled += 1;
    else unknown.push(`${entry.path}: ${String(entry.status)}`);
  }

  if (unknown.length > 0) {
    throw new Error(`unknown upstream test status(es): ${unknown.join(', ')}`);
  }

  summary.classifiedTests = summary.enabled + summary.expectedFailure + summary.disabled;
  assertUpstreamStatusSummary(summary);
  return summary;
}

function collectUpstreamStatus() {
  const targetsPath = join(rootDir, 'compat', 'upstream', 'targets.json');
  if (!existsSync(targetsPath)) return {};
  const targets = JSON.parse(readFileSync(targetsPath, 'utf8'));
  const result = {};

  for (const runtime of ['node', 'bun']) {
    const target = targets[runtime];
    if (!target) continue;
    const snapshotRoot = join(rootDir, target.snapshot);
    const statusPath = join(snapshotRoot, 'status.json');
    if (!existsSync(statusPath)) continue;
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    const entries = discoverUpstreamRunnableFiles(snapshotRoot, runtime)
      .map((path) => upstreamStatusEntryForPath(status, path));
    const summary = summarizeUpstreamRunnableStatuses(entries);

    result[runtime] = {
      version: target.version,
      commit: target.commit,
      snapshot: target.snapshot,
      copiedFiles: countAllFiles(snapshotRoot),
      ...summary,
      trackedTests: summary.classifiedTests,
    };
  }

  return result;
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nodeModuleNameForFile(filePath) {
  return relative(join(rootDir, 'src', 'runtime_modules', 'node'), filePath)
    .split(sep)
    .join('/')
    .replace(/\.(?:cjs|js)$/, '');
}

function collectNodeTestFiles() {
  const testsDir = join(rootDir, 'tests', 'js');
  if (!existsSync(testsDir)) return [];
  return readdirSync(testsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith('node-') && /\.(?:js|ts)$/.test(entry.name))
    .map((entry) => `tests/js/${entry.name}`)
    .sort();
}

function collectBunTestFiles() {
  const testsDir = join(rootDir, 'tests', 'js');
  if (!existsSync(testsDir)) return [];
  return readdirSync(testsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith('bun-') && /\.(?:js|ts)$/.test(entry.name))
    .map((entry) => `tests/js/${entry.name}`)
    .sort();
}

const nodeBehaviorTestAliases = {
  async_hooks: ['node-misc-modules-surface', 'node-stream-surface'],
  perf_hooks: ['node-instrumentation-surface'],
  repl: ['node-instrumentation-surface'],
  url: ['node-small-surface'],
  vm: ['node-small-surface'],
  wasi: ['node-instrumentation-surface'],
};

function testFilesForModule(testFiles, moduleName) {
  const normalized = moduleName.replace(/^node:/, '').replace(/[_/]/g, '-');
  const root = normalized.split('-')[0];
  const aliases = nodeBehaviorTestAliases[moduleName] || [];
  return testFiles.filter((file) => {
    const name = file.slice('tests/js/'.length).replace(/\.(?:js|ts)$/, '');
    return name === `node-${normalized}` ||
      name.startsWith(`node-${normalized}-`) ||
      name === `node-${root}` ||
      name.startsWith(`node-${root}-`) ||
      aliases.includes(name) ||
      name.includes(`-${normalized}`) ||
      name.includes(`-${root}-`);
  });
}

function bunModuleNameForFile(filePath) {
  return runtimeModuleSpecifiers(filePath).find((specifier) => specifier === 'bun' || specifier.startsWith('bun:')) ||
    relative(join(rootDir, 'src', 'runtime_modules', 'bun'), filePath)
      .split(sep)
      .join('/')
      .replace(/\.(?:cjs|js)$/, '');
}

function testFilesForBunModule(testFiles, moduleName) {
  const normalized = moduleName === 'bun' ? 'bun' : moduleName.replace(/^bun:/, 'bun-').replace(/[_/]/g, '-');
  return testFiles.filter((file) => {
    const name = file.slice('tests/js/'.length).replace(/\.(?:js|ts)$/, '');
    return name === normalized ||
      name.startsWith(`${normalized}-`) ||
      name.includes(normalized) ||
      (moduleName === 'bun' && ['bun-apis', 'bun-global', 'bun-jsc-and-global'].includes(name));
  });
}

function collectSourceBehaviorMarkers(source, options = {}) {
  const compatMarkers = [];
  const unsupportedMarkers = [];
  const nativeAvailabilityGuards = [];

  for (const match of source.matchAll(/\/\/\s*COTTONTAIL-COMPAT:\s*([^\n]+)/g)) {
    compatMarkers.push(match[1].trim());
  }

  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lower = line.toLowerCase();
    const previousLine = lines[index - 1] ?? '';
    const unsupportedHelperCall =
      /\bunsupported(?:crypto|tls|http2)?\s*\(/i.test(line) &&
      !/\bfunction\s+unsupported/i.test(line);
    const unsupportedTextPattern = options.extendedUnsupportedText
      ? /(not implemented|requires native|not available in cottontail|requires .*bindings|requires .*support|unsupported|fail loudly|throw until|unavailable in this cottontail build)/i
      : /(not implemented|requires native|not available in cottontail|requires .*bindings|unsupported|fail loudly|throw until)/i;
    const throwingUnsupported =
      /\bthrow\b/.test(line) &&
      unsupportedTextPattern.test(lower);
    const unsupportedHelperBody =
      /\bfunction\s+unsupported(?:crypto|tls|http2)?\s*\(/i.test(previousLine) &&
      /\bthrow\b/.test(line);
    const nativeAvailabilityGuard =
      /\btypeof\s+cottontail\.[A-Za-z_$][\w$]*\s*!==\s*["']function["']/.test(line) &&
      (unsupportedHelperCall || throwingUnsupported);
    const validationOnlyUnsupported =
      /Unsupported Cottontail v8 serialization format/.test(line);
    if (validationOnlyUnsupported || unsupportedHelperBody) {
      continue;
    }
    if (nativeAvailabilityGuard) {
      nativeAvailabilityGuards.push({
        line: index + 1,
        text: line.trim(),
      });
    } else if (unsupportedHelperCall || throwingUnsupported) {
      unsupportedMarkers.push({
        line: index + 1,
        text: line.trim(),
      });
    }
  }

  return { compatMarkers, unsupportedMarkers, nativeAvailabilityGuards };
}

function collectNodeBehavioralSignals(nodeSurface) {
  const runtimeNodeRoot = join(rootDir, 'src', 'runtime_modules', 'node');
  const files = existsSync(runtimeNodeRoot) ? collectFiles(runtimeNodeRoot) : [];
  const testFiles = collectNodeTestFiles();
  const modules = {};
  let compatMarkerCount = 0;
  let explicitUnsupportedCount = 0;
  let nativeAvailabilityGuardCount = 0;

  for (const filePath of files) {
    const source = readFileSync(filePath, 'utf8');
    const moduleName = nodeModuleNameForFile(filePath);
    const { compatMarkers, unsupportedMarkers, nativeAvailabilityGuards } = collectSourceBehaviorMarkers(source);

    if (compatMarkers.length > 0 || unsupportedMarkers.length > 0 || nativeAvailabilityGuards.length > 0) {
      modules[moduleName] = {
        file: relative(rootDir, filePath).split(sep).join('/'),
        compatMarkers,
        unsupportedMarkers,
        nativeAvailabilityGuards,
        tests: testFilesForModule(testFiles, moduleName),
      };
      compatMarkerCount += compatMarkers.length;
      explicitUnsupportedCount += unsupportedMarkers.length;
      nativeAvailabilityGuardCount += nativeAvailabilityGuards.length;
    }
  }

  const publicModuleCount = nodeSurface.publicBuiltinModules.length;
  const modulesWithCompatMarkers = Object.values(modules).filter((entry) => entry.compatMarkers.length > 0).length;
  const modulesWithUnsupportedMarkers = Object.values(modules).filter((entry) => entry.unsupportedMarkers.length > 0).length;
  const caveatModuleShare = publicModuleCount > 0 ? modulesWithCompatMarkers / publicModuleCount : 0;
  const penalty =
    caveatModuleShare * 40 +
    Math.min(30, explicitUnsupportedCount * 0.25) +
    Math.min(10, compatMarkerCount * 0.1);
  const midpoint = Math.round(clamp(100 - penalty, 0, 100));
  const hasBehaviorSignals = compatMarkerCount > 0 || explicitUnsupportedCount > 0 || nativeAvailabilityGuardCount > 0;
  const lower = hasBehaviorSignals ? clamp(midpoint - 5, 0, 100) : 100;
  const upper = hasBehaviorSignals ? clamp(midpoint + 5, 0, 100) : 100;

  const largestGaps = Object.entries(modules)
    .map(([name, entry]) => ({
      name,
      file: entry.file,
      compatMarkers: entry.compatMarkers.length,
      unsupportedMarkers: entry.unsupportedMarkers.length,
      nativeAvailabilityGuards: entry.nativeAvailabilityGuards.length,
      tests: entry.tests.length,
      gapScore: entry.compatMarkers.length * 3 + entry.unsupportedMarkers.length * 2 + (entry.tests.length === 0 ? 1 : 0),
    }))
    .sort((left, right) => right.gapScore - left.gapScore || left.name.localeCompare(right.name));

  return {
    note: 'Heuristic behavioral-readiness signal from inline COTTONTAIL-COMPAT comments, explicit unsupported/native markers, and Node-focused test files. This is not a conformance result.',
    estimate: {
      implementedPercentLower: lower,
      implementedPercentUpper: upper,
      gapPercentLower: 100 - upper,
      gapPercentUpper: 100 - lower,
    },
    signals: {
      publicNodeModules: publicModuleCount,
      nodeTestFiles: testFiles.length,
      compatMarkers: compatMarkerCount,
      modulesWithCompatMarkers,
      explicitUnsupportedMarkers: explicitUnsupportedCount,
      nativeAvailabilityGuards: nativeAvailabilityGuardCount,
      modulesWithUnsupportedMarkers,
    },
    largestGaps,
    modules,
  };
}

function collectBunBehavioralSignals(bunSurface) {
  const runtimeBunRoot = join(rootDir, 'src', 'runtime_modules', 'bun');
  const files = existsSync(runtimeBunRoot) ? collectFiles(runtimeBunRoot) : [];
  const testFiles = collectBunTestFiles();
  const modules = {};
  let compatMarkerCount = 0;
  let explicitUnsupportedCount = 0;
  let nativeAvailabilityGuardCount = 0;

  for (const filePath of files) {
    const source = readFileSync(filePath, 'utf8');
    const moduleName = bunModuleNameForFile(filePath);
    const { compatMarkers, unsupportedMarkers, nativeAvailabilityGuards } = collectSourceBehaviorMarkers(source, { extendedUnsupportedText: true });

    if (compatMarkers.length > 0 || unsupportedMarkers.length > 0 || nativeAvailabilityGuards.length > 0) {
      modules[moduleName] = {
        file: relative(rootDir, filePath).split(sep).join('/'),
        compatMarkers,
        unsupportedMarkers,
        nativeAvailabilityGuards,
        tests: testFilesForBunModule(testFiles, moduleName),
      };
      compatMarkerCount += compatMarkers.length;
      explicitUnsupportedCount += unsupportedMarkers.length;
      nativeAvailabilityGuardCount += nativeAvailabilityGuards.length;
    }
  }

  const publicModuleCount = Math.max(1, Object.keys(bunSurface.modules || {}).length);
  const modulesWithCompatMarkers = Object.values(modules).filter((entry) => entry.compatMarkers.length > 0).length;
  const modulesWithUnsupportedMarkers = Object.values(modules).filter((entry) => entry.unsupportedMarkers.length > 0).length;

  const largestGaps = Object.entries(modules)
    .map(([name, entry]) => ({
      name,
      file: entry.file,
      compatMarkers: entry.compatMarkers.length,
      unsupportedMarkers: entry.unsupportedMarkers.length,
      nativeAvailabilityGuards: entry.nativeAvailabilityGuards.length,
      tests: entry.tests.length,
      gapScore: entry.compatMarkers.length * 3 + entry.unsupportedMarkers.length * 2 + (entry.tests.length === 0 ? 1 : 0),
    }))
    .sort((left, right) => right.gapScore - left.gapScore || left.name.localeCompare(right.name));

  return {
    note: 'Source caveat and local test-inventory signals only. These are not conformance results and do not support a Bun compatibility percentage.',
    signals: {
      publicBunModules: publicModuleCount,
      bunTestFiles: testFiles.length,
      compatMarkers: compatMarkerCount,
      modulesWithCompatMarkers,
      explicitUnsupportedMarkers: explicitUnsupportedCount,
      nativeAvailabilityGuards: nativeAvailabilityGuardCount,
      modulesWithUnsupportedMarkers,
    },
    largestGaps,
    modules,
  };
}

const nodeSurface = collectNodeSurface();
const bunSurface = runBunCollector();
const cottontailSurface = collectCottontailSurface();
const manifest = {
  schemaVersion: 1,
  generatedBy: 'scripts/generate-api-surface.js',
  note: 'API coverage is a name inventory; upstream test tiers are the conformance evidence, and heuristic signals are not conformance results.',
  targets: {
    node: nodeSurface,
    bun: bunSurface,
  },
  cottontail: cottontailSurface,
  coverage: buildCoverage(nodeSurface, bunSurface, cottontailSurface),
  upstream: collectUpstreamStatus(),
  behavioral: {
    node: collectNodeBehavioralSignals(nodeSurface),
    bun: collectBunBehavioralSignals(bunSurface),
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${relative(rootDir, outPath)}`);
