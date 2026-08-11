#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = resolve(dirname(scriptPath), '..');
const defaultMetadataPath = join(rootDir, 'tests', 'upstream-review.json');

function usage() {
  return [
    'Review Bun-derived JavaScript test changes without modifying local tests.',
    '',
    'Usage:',
    '  node scripts/review-bun-test-changes.js --to <tag-or-commit> [options]',
    '',
    'Options:',
    '  --from <tag-or-commit>  Override the last reviewed Bun commit.',
    '  --to <tag-or-commit>    Candidate Bun release tag or commit (required).',
    '  --source <url-or-path>  Override the Bun Git repository.',
    '  --format <text|json>    Output format (default: text).',
    '  --metadata <path>       Override tests/upstream-review.json.',
    '  --help                  Show this help.',
  ].join('\n');
}

function takeValue(args, option) {
  const value = args.shift();
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

export function parseArguments(argv) {
  const args = [...argv];
  const options = {
    from: null,
    to: null,
    source: null,
    format: 'text',
    metadataPath: defaultMetadataPath,
    help: false,
  };

  while (args.length > 0) {
    const argument = args.shift();
    if (argument === '--from') options.from = takeValue(args, argument);
    else if (argument === '--to') options.to = takeValue(args, argument);
    else if (argument === '--source') options.source = takeValue(args, argument);
    else if (argument === '--format') options.format = takeValue(args, argument);
    else if (argument === '--metadata') options.metadataPath = resolve(takeValue(args, argument));
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!['text', 'json'].includes(options.format)) {
    throw new Error(`Unsupported format: ${options.format}. Use text or json.`);
  }
  if (!options.help && !options.to) throw new Error('--to is required.');
  return options;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${path}: ${error.message}`);
  }
}

export function validateMetadata(metadata) {
  if (metadata?.schema !== 1 || metadata.runtime !== 'bun') {
    throw new Error('Upstream review metadata must use schema 1 for the Bun runtime.');
  }
  if (typeof metadata.source !== 'string' || metadata.source.length === 0) {
    throw new Error('Upstream review metadata requires a Bun source repository.');
  }
  if (!Array.isArray(metadata.comparisonPaths) || metadata.comparisonPaths.length === 0) {
    throw new Error('Upstream review metadata requires at least one comparison path.');
  }
  if (!/^[0-9a-f]{40}$/.test(metadata.lastReviewed?.commit ?? '')) {
    throw new Error('Upstream review metadata requires a full lastReviewed commit.');
  }
  const allowed = metadata.routing?.allowedDestinations;
  for (const destination of ['cottontail', 'external', 'out-of-scope']) {
    if (!Array.isArray(allowed) || !allowed.includes(destination)) {
      throw new Error(`Upstream review routing must allow ${destination}.`);
    }
  }
  if (!allowed.includes(metadata.routing.defaultDestination)) {
    throw new Error('The default upstream review destination must be allowed.');
  }
  for (const rule of metadata.routing.rules ?? []) {
    if (!allowed.includes(rule.destination)) {
      throw new Error(`Upstream review rule has unsupported destination: ${rule.destination}.`);
    }
  }
  const relationships = metadata.mappingPolicy?.relationships ?? [];
  for (const mapping of metadata.mappings ?? []) {
    if (!Array.isArray(mapping.originPaths) || mapping.originPaths.length === 0) {
      throw new Error('Every upstream review mapping requires originPaths.');
    }
    if (!allowed.includes(mapping.destination)) {
      throw new Error(`Upstream review mapping has unsupported destination: ${mapping.destination}.`);
    }
    if (!relationships.includes(mapping.relationship)) {
      throw new Error(`Upstream review mapping has unsupported relationship: ${mapping.relationship}.`);
    }
  }
}

function validateRef(ref, label) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.startsWith('-') || /[\0\r\n]/.test(ref)) {
    throw new Error(`Invalid ${label} Git ref.`);
  }
}

function runGit(args, cwd = rootDir) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  if ((result.status ?? 1) !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} exited ${result.status ?? 1}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function matchingKnownRef(metadata, ref) {
  for (const key of ['baseline', 'lastReviewed']) {
    const known = metadata[key];
    if ((known?.commit === ref || known?.tag === ref) && known.tag) return known;
  }
  return null;
}

function fetchCommit(cloneDir, ref, knownRef = null) {
  const fetchedRef = ref === knownRef?.commit ? knownRef.tag : ref;
  runGit(['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', fetchedRef], cloneDir);
  const commit = runGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], cloneDir).trim();
  if (knownRef && commit !== knownRef.commit) {
    throw new Error(
      `Tag ${knownRef.tag} resolved to ${commit}, not the recorded commit ${knownRef.commit}.`,
    );
  }
  return commit;
}

export function parseNameStatus(output) {
  if (!output) return [];
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes = [];

  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++];
    const status = rawStatus[0];
    if (!status) throw new Error('Git returned an empty change status.');
    if (status === 'R' || status === 'C') {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (!previousPath || !path) throw new Error(`Git returned an incomplete ${rawStatus} change.`);
      changes.push({ status, score: Number(rawStatus.slice(1)), previousPath, path });
    } else {
      const path = fields[index++];
      if (!path) throw new Error(`Git returned an incomplete ${rawStatus} change.`);
      changes.push({ status, path });
    }
  }
  return changes;
}

function loadBaselineStatus(metadata, metadataPath) {
  const relativePath = metadata.routing?.baselineStatusPath;
  if (!relativePath) return null;
  const metadataRoot = resolve(dirname(metadataPath), '..');
  return readJson(resolve(metadataRoot, relativePath), 'baseline status index');
}

function resolveRouteForPath(path, metadata, baselineStatus) {
  const routing = metadata.routing;
  const rules = routing.rules ?? [];
  const exactRule = rules.find((rule) => rule.path && path === rule.path);
  const prefixRule = rules
    .filter((rule) => rule.pathPrefix && path.startsWith(rule.pathPrefix))
    .sort((left, right) => right.pathPrefix.length - left.pathPrefix.length)[0];
  const currentRule = exactRule ?? prefixRule;
  if (currentRule) {
    return { destination: currentRule.destination, basis: 'routing-rule' };
  }

  const baselineEntry = baselineStatus?.tests?.[path];
  if (baselineEntry) {
    const baselineOwner = baselineEntry.owner ?? 'cottontail-runtime';
    const mapped = routing.baselineOwnerMap?.[baselineOwner];
    if (mapped) {
      return {
        destination: mapped === 'cottontail' && baselineEntry.status === 'skip'
          ? 'out-of-scope'
          : mapped,
        basis: 'baseline-status',
      };
    }
  }
  return { destination: routing.defaultDestination, basis: 'default' };
}

export function addRouting(changes, metadata, baselineStatus) {
  return changes.map((change) => {
    const mapping = (metadata.mappings ?? []).find((candidate) =>
      candidate.originPaths.includes(change.path) ||
      (change.previousPath && candidate.originPaths.includes(change.previousPath)));
    let route = mapping
      ? { destination: mapping.destination, basis: 'mapping' }
      : resolveRouteForPath(change.path, metadata, baselineStatus);
    if (route.basis === 'default' && change.previousPath) {
      const previousRoute = resolveRouteForPath(change.previousPath, metadata, baselineStatus);
      if (previousRoute.basis !== 'default') route = previousRoute;
    }
    return {
      ...change,
      suggestedDestination: route.destination,
      routingBasis: route.basis,
      ...(mapping ? { mapping } : {}),
    };
  });
}

function isWithinComparisonPath(path, comparisonPath) {
  const normalized = comparisonPath.replace(/\/+$/, '');
  return path === normalized || path.startsWith(`${normalized}/`);
}

export function filterComparisonChanges(changes, comparisonPaths) {
  return changes.filter((change) => comparisonPaths.some((comparisonPath) =>
    isWithinComparisonPath(change.path, comparisonPath) ||
    (change.previousPath && isWithinComparisonPath(change.previousPath, comparisonPath))));
}

function summarize(changes) {
  const summary = {};
  for (const change of changes) summary[change.status] = (summary[change.status] ?? 0) + 1;
  return summary;
}

function formatText(report) {
  const lines = [
    'Bun-derived JavaScript test review',
    `  source: ${report.source}`,
    `  from: ${report.from.ref} (${report.from.commit})`,
    `  to: ${report.to.ref} (${report.to.commit})`,
    `  paths: ${report.comparisonPaths.join(', ')}`,
    `  changes: ${report.changes.length}`,
  ];
  const counts = Object.entries(report.summary)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join(' ');
  if (counts) lines.push(`  status: ${counts}`);
  lines.push('');

  for (const change of report.changes) {
    const path = change.previousPath ? `${change.previousPath} -> ${change.path}` : change.path;
    lines.push(`${change.status}\t${change.suggestedDestination}\t${path}`);
  }
  if (report.changes.length === 0) lines.push('No Bun test-tree changes found.');
  return lines.join('\n');
}

export function createReport({ metadata, metadataPath, source, fromRef, toRef }) {
  validateRef(fromRef, 'from');
  validateRef(toRef, 'to');
  if (typeof source !== 'string' || source.length === 0 || source.startsWith('-') || /[\0\r\n]/.test(source)) {
    throw new Error('Invalid Bun source repository.');
  }
  const temporaryRoot = mkdtempSync(join(os.tmpdir(), 'cottontail-bun-review-'));
  const cloneDir = join(temporaryRoot, 'bun.git');

  try {
    runGit([
      'clone',
      '--quiet',
      '--filter=blob:none',
      '--no-checkout',
      '--no-tags',
      '--depth=1',
      source,
      cloneDir,
    ]);
    const fromCommit = fetchCommit(cloneDir, fromRef, matchingKnownRef(metadata, fromRef));
    const toCommit = fetchCommit(cloneDir, toRef, matchingKnownRef(metadata, toRef));
    const output = runGit([
      '-c',
      'diff.renameLimit=20000',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--name-status',
      '-z',
      '--find-renames=50%',
      fromCommit,
      toCommit,
      '--',
    ], cloneDir);
    const baselineStatus = loadBaselineStatus(metadata, metadataPath);
    const relevantChanges = filterComparisonChanges(
      parseNameStatus(output),
      metadata.comparisonPaths,
    );
    const changes = addRouting(relevantChanges, metadata, baselineStatus);
    return {
      schema: 1,
      source,
      from: { ref: fromRef, commit: fromCommit },
      to: { ref: toRef, commit: toCommit },
      comparisonPaths: metadata.comparisonPaths,
      summary: summarize(changes),
      changes,
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const metadata = readJson(options.metadataPath, 'upstream review metadata');
  validateMetadata(metadata);
  const source = options.source ?? metadata.source;
  const fromRef = options.from ?? metadata.lastReviewed.commit;
  const report = createReport({
    metadata,
    metadataPath: options.metadataPath,
    source,
    fromRef,
    toRef: options.to,
  });
  console.log(options.format === 'json' ? JSON.stringify(report, null, 2) : formatText(report));
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`Bun test review failed: ${error.message}`);
    process.exitCode = 1;
  }
}
