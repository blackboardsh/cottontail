#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  bunStatusPlatformKey,
  resolveBunStatusPlatform,
  validateBunStatusPlatformOverrides,
} from './bun-status-platform.js';

const rootDir = process.cwd();
const targetsPath = resolve(
  rootDir,
  process.env.COTTONTAIL_UPSTREAM_TARGETS_PATH ?? join('compat', 'upstream', 'targets.json'),
);
const targets = JSON.parse(readFileSync(targetsPath, 'utf8'));
const target = targets.bun;
if (!target) throw new Error(`Missing Bun target in ${targetsPath}`);
const snapshotRoot = resolve(rootDir, process.env.COTTONTAIL_UPSTREAM_BUN_SNAPSHOT ?? target.snapshot);
const rawStatus = JSON.parse(readFileSync(join(snapshotRoot, 'status.json'), 'utf8'));
const statusPlatform = process.env.COTTONTAIL_BUN_STATUS_PLATFORM ?? process.platform;
const statusArchitecture = process.env.COTTONTAIL_BUN_STATUS_ARCH ?? process.arch;
const status = resolveBunStatusPlatform(rawStatus, statusPlatform, statusArchitecture);
const knownStatuses = new Set(['enabled', 'expected-failure', 'disabled', 'skip']);
const knownExclusionClassifications = new Set([
  'environment',
  'performance',
  'runtime-gap',
  'upstream',
]);

function discoverRunnableFiles() {
  const testRoot = join(snapshotRoot, 'test');
  const nodeModules = join(testRoot, 'node_modules');
  const runnable = /\.test\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/i;
  const result = [];
  const stack = [testRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (path === nodeModules) continue;
      const fileStatus = lstatSync(path);
      if (fileStatus.isDirectory() && !fileStatus.isSymbolicLink()) stack.push(path);
      else if (fileStatus.isFile() && runnable.test(name)) {
        result.push(path.slice(snapshotRoot.length + 1).replaceAll('\\', '/'));
      }
    }
  }
  return result.sort();
}

function increment(record, key, amount = 1) {
  record[key] = (record[key] ?? 0) + amount;
}

function formatCounts(record) {
  return Object.entries(record)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}=${count}`)
    .join(', ') || 'none';
}

function validateExpectedCount(errors, expected, key, actual) {
  if (expected?.[key] == null) errors.push(`status.expectedCounts.${key} is required`);
  else if (expected[key] !== actual) {
    errors.push(`status.expectedCounts.${key} is ${expected[key]}, discovered ${actual}`);
  }
}

function sourceExclusionMarkers(entries) {
  const marker = /\b(?:test|it|describe)\.(todo|skip|todoIf|skipIf)\b|\b(xit|xtest|xdescribe)\s*\(/g;
  const groups = {};
  let sites = 0;
  let files = 0;
  for (const entry of entries) {
    const source = readFileSync(join(snapshotRoot, entry.path), 'utf8');
    const kinds = {};
    let fileSites = 0;
    for (const match of source.matchAll(marker)) {
      increment(kinds, match[1] ?? match[2]);
      fileSites += 1;
    }
    if (fileSites === 0) continue;
    sites += fileSites;
    files += 1;
    const owner = entry.owner ?? 'cottontail-runtime';
    const key = `${owner}/${entry.status}`;
    const group = groups[key] ?? { sites: 0, files: 0, kinds: {} };
    group.sites += fileSites;
    group.files += 1;
    for (const [kind, count] of Object.entries(kinds)) increment(group.kinds, kind, count);
    groups[key] = group;
  }
  return { sites, files, groups };
}

const errors = validateBunStatusPlatformOverrides(rawStatus);
const discoveredPaths = discoverRunnableFiles();
const discovered = new Set(discoveredPaths);
const exactEntries = status.tests ?? {};

if (status.schema !== 2) errors.push(`Bun status schema must be 2, received ${String(status.schema)}`);
if (status.defaultStatus !== 'not-enabled') {
  errors.push('Bun defaultStatus must be not-enabled so imports require an explicit classification');
}
if ((status.patterns ?? []).length > 0) {
  errors.push('Bun status patterns are forbidden because regex fallbacks classify future imports implicitly');
}
if ((status.classifications ?? []).length > 0) {
  errors.push('Bun status classifications must be exact entries in status.tests');
}

for (const path of Object.keys(exactEntries)) {
  if (!discovered.has(path)) errors.push(`status.tests contains a stale or non-runnable path: ${path}`);
}
const unclassified = discoveredPaths.filter((path) => exactEntries[path] == null);
if (unclassified.length > 0) {
  errors.push(
    `${unclassified.length} runnable Bun file(s) are unclassified: ${unclassified.slice(0, 8).join(', ')}`,
  );
}

const entries = discoveredPaths.map((path) => ({ path, ...(exactEntries[path] ?? { status: 'not-enabled' }) }));
const ownerCounts = {};
const statusCounts = {};
const fileExpectedFailures = {};
const testNameExclusionCounts = {};
const splitExpectedFailureCounts = {};
let testNameExclusionFiles = 0;
let testNameExclusionCases = 0;
let splitExpectedFailureCases = 0;

for (const entry of entries) {
  const owner = entry.owner ?? 'cottontail-runtime';
  increment(ownerCounts, owner);
  increment(statusCounts, entry.status);
  if (!knownStatuses.has(entry.status)) errors.push(`${entry.path} has invalid status ${String(entry.status)}`);
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
    errors.push(`${entry.path} requires a status reason`);
  }
  if (owner !== 'cottontail-runtime') {
    errors.push(`${entry.path} has unknown owner ${owner}`);
  }
  if (entry.status === 'expected-failure') {
    if (!knownExclusionClassifications.has(entry.classification)) {
      errors.push(`${entry.path} expected-failure requires an explicit classification`);
    } else {
      increment(fileExpectedFailures, entry.classification);
    }
  }

  const allNameFilterArgs = (entry.args ?? [])
    .map(String)
    .filter((arg) => arg.startsWith('--test-name-pattern'));
  const rawNameFilters = allNameFilterArgs.filter((arg) => arg.startsWith('--test-name-pattern='));
  const exclusion = entry.testNameExclusion;
  if (allNameFilterArgs.length > 0 && exclusion == null) {
    errors.push(`${entry.path} hides test names without testNameExclusion accounting`);
  }
  if (exclusion != null) {
    testNameExclusionFiles += 1;
    if (allNameFilterArgs.length !== 1 || rawNameFilters.length !== 1) {
      errors.push(`${entry.path} must use one accounted --test-name-pattern=<regexp> argument`);
    }
    if (typeof exclusion.pattern !== 'string' || exclusion.pattern === '') {
      errors.push(`${entry.path} testNameExclusion.pattern is required`);
    } else {
      try {
        new RegExp(exclusion.pattern);
      } catch (error) {
        errors.push(`${entry.path} testNameExclusion.pattern is invalid: ${error.message}`);
      }
      if (!rawNameFilters.includes(`--test-name-pattern=${exclusion.pattern}`)) {
        errors.push(`${entry.path} testNameExclusion does not match its runner argument`);
      }
    }
    if (!knownExclusionClassifications.has(exclusion.classification)) {
      errors.push(`${entry.path} testNameExclusion.classification is invalid`);
    }
    if (typeof exclusion.reason !== 'string' || exclusion.reason.trim() === '') {
      errors.push(`${entry.path} testNameExclusion.reason is required`);
    }
    if (!Array.isArray(exclusion.testNames) || exclusion.testNames.length === 0) {
      errors.push(`${entry.path} testNameExclusion.testNames must list every excluded case`);
    } else {
      if (new Set(exclusion.testNames).size !== exclusion.testNames.length) {
        errors.push(`${entry.path} testNameExclusion.testNames contains duplicates`);
      }
      testNameExclusionCases += exclusion.testNames.length;
      increment(testNameExclusionCounts, exclusion.classification, exclusion.testNames.length);
    }
  }

  const splitFailures = entry.expectedFailureBundlerTests ?? {};
  const splitClassifications = entry.expectedFailureBundlerTestClassifications ?? {};
  for (const [id, reason] of Object.entries(splitFailures)) {
    splitExpectedFailureCases += 1;
    const classification = splitClassifications[id];
    if (!knownExclusionClassifications.has(classification)) {
      errors.push(`${entry.path} split expected failure ${id} requires an explicit classification`);
    } else {
      increment(splitExpectedFailureCounts, classification);
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      errors.push(`${entry.path} split expected failure ${id} requires a reason`);
    }
  }
  for (const id of Object.keys(splitClassifications)) {
    if (splitFailures[id] == null) {
      errors.push(`${entry.path} has a stale split classification for ${id}`);
    }
  }
}

const markerAudit = sourceExclusionMarkers(entries);
const expected = status.expectedCounts;
validateExpectedCount(errors, expected, 'runnableFiles', entries.length);
validateExpectedCount(errors, expected, 'enabled', statusCounts.enabled ?? 0);
validateExpectedCount(errors, expected, 'expectedFailure', statusCounts['expected-failure'] ?? 0);
validateExpectedCount(errors, expected, 'skip', statusCounts.skip ?? 0);
validateExpectedCount(errors, expected, 'cottontailOwned', ownerCounts['cottontail-runtime'] ?? 0);
validateExpectedCount(errors, expected, 'upstreamTodoSkipSyntaxSites', markerAudit.sites);
validateExpectedCount(errors, expected, 'upstreamTodoSkipSyntaxFiles', markerAudit.files);

console.log(`bun ${target.version} (${target.commit.slice(0, 12)})`);
console.log(`  status platform: ${bunStatusPlatformKey(statusPlatform, statusArchitecture)}`);
console.log(`  discovered runnable files: ${entries.length}`);
console.log(`  explicit status.tests entries: ${Object.keys(exactEntries).length}`);
console.log(`  regex fallback patterns: ${(status.patterns ?? []).length}`);
console.log(`  statuses: ${formatCounts(statusCounts)}`);
console.log(`  owners: ${formatCounts(ownerCounts)}`);
console.log(
  `  whole-file expected failures: ${statusCounts['expected-failure'] ?? 0} (${formatCounts(fileExpectedFailures)})`,
);
console.log(
  `  test-name exclusions: ${testNameExclusionCases} case(s) in ${testNameExclusionFiles} file(s) ` +
  `(${formatCounts(testNameExclusionCounts)})`,
);
console.log(
  `  split expected failures: ${splitExpectedFailureCases} case(s) ` +
  `(${formatCounts(splitExpectedFailureCounts)})`,
);
console.log(
  `  upstream todo/skip syntax markers: ${markerAudit.sites} site(s) in ${markerAudit.files} runnable file(s)`,
);
for (const [key, group] of Object.entries(markerAudit.groups).sort(([left], [right]) => left.localeCompare(right))) {
  console.log(`    ${key}: ${group.sites} site(s) in ${group.files} file(s)`);
}
console.log('  upstream expectations.txt: retained as provenance; not applied by the Cottontail runner');

if (errors.length > 0) {
  console.error(`Bun status accounting check failed:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
  process.exit(1);
}
console.log('  accounting check: passed');
