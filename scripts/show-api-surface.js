#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const rootDir = process.cwd();
const manifestPath = join(rootDir, 'compat', 'api-surface.json');
const args = new Set(process.argv.slice(2));
const useColor = process.stdout.isTTY && !args.has('--no-color') && process.env.NO_COLOR == null;
const topArg = process.argv.slice(2).find((arg) => arg.startsWith('--top='));
const topCount = topArg ? Math.max(1, Number(topArg.slice('--top='.length)) || 12) : 12;
const terminalWidth = Math.max(80, Math.min(process.stdout.columns || 100, 140));

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  fail('compat/api-surface.json was not found. Run: bun run compat:surface');
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const color = {
  reset: useColor ? '\x1b[0m' : '',
  dim: useColor ? '\x1b[2m' : '',
  bold: useColor ? '\x1b[1m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  red: useColor ? '\x1b[31m' : '',
  magenta: useColor ? '\x1b[35m' : '',
  gray: useColor ? '\x1b[90m' : '',
};

function paint(value, style) {
  return `${color[style] || ''}${value}${color.reset}`;
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function pad(value, width) {
  const text = String(value);
  const length = visibleLength(text);
  return length >= width ? text : `${text}${' '.repeat(width - length)}`;
}

function truncate(value, width) {
  const text = String(value);
  const plain = stripAnsi(text);
  if (plain.length <= width) return text;
  if (text !== plain) return `${plain.slice(0, Math.max(0, width - 1))}...`;
  return `${text.slice(0, Math.max(0, width - 1))}...`;
}

function percent(part, total) {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function ratioLabel(part, total) {
  return `${part}/${total} ${String(percent(part, total)).padStart(3)}%`;
}

function bar(part, total, width = 26) {
  const pct = total <= 0 ? 0 : part / total;
  const filled = Math.round(width * pct);
  const empty = Math.max(0, width - filled);
  const glyph = useColor ? ['█', '░'] : ['#', '-'];
  const style = pct >= 0.75 ? 'green' : pct >= 0.35 ? 'yellow' : 'red';
  return `${paint(glyph[0].repeat(filled), style)}${paint(glyph[1].repeat(empty), 'gray')}`;
}

function section(title) {
  console.log('');
  console.log(paint(title, 'bold'));
  console.log(paint('─'.repeat(Math.min(terminalWidth, title.length + 24)), 'gray'));
}

function sum(items, selector) {
  return items.reduce((total, item) => total + selector(item), 0);
}

function moduleRows(coverage) {
  return Object.entries(coverage).map(([name, value]) => {
    const implemented = value.implemented?.length || 0;
    const missing = value.missing?.length || 0;
    const total = implemented + missing;
    return {
      name,
      status: value.module,
      implemented,
      missing,
      total,
      pct: percent(implemented, total),
    };
  });
}

function printMetric(label, implemented, total, detail = '') {
  const nameWidth = 22;
  console.log(`${pad(label, nameWidth)} ${bar(implemented, total)}  ${pad(ratioLabel(implemented, total), 12)} ${paint(detail, 'dim')}`);
}

function printRows(rows, options = {}) {
  const columns = [
    { name: 'surface', width: options.nameWidth || 24, value: (row) => row.name },
    { name: 'status', width: 8, value: (row) => row.status },
    { name: 'coverage', width: 10, value: (row) => `${row.implemented}/${row.total}` },
    { name: 'bar', width: 18, value: (row) => bar(row.implemented, row.total, 16) },
    { name: 'missing', width: 8, value: (row) => String(row.missing) },
  ];

  console.log(columns.map((column) => paint(pad(column.name, column.width), 'gray')).join('  '));
  for (const row of rows) {
    const statusStyle = row.status === 'present' ? 'green' : 'red';
    console.log(columns.map((column) => {
      const raw = column.value(row);
      const value = column.name === 'status' ? paint(raw, statusStyle) : raw;
      return pad(truncate(value, column.width), column.width);
    }).join('  '));
  }
}

function printList(label, items, limit = topCount) {
  const visible = items.slice(0, limit);
  if (visible.length === 0) {
    console.log(`${label}: ${paint('none', 'green')}`);
    return;
  }

  console.log(`${label}:`);
  const linePrefix = '  ';
  let line = linePrefix;
  for (const item of visible) {
    const next = line === linePrefix ? item : `, ${item}`;
    if (visibleLength(line) + next.length > terminalWidth - 2) {
      console.log(line);
      line = `${linePrefix}${item}`;
    } else {
      line += next;
    }
  }
  if (line.trim()) console.log(line);
  if (items.length > limit) {
    console.log(paint(`  ... ${items.length - limit} more`, 'dim'));
  }
}

const nodeRows = moduleRows(manifest.coverage.node);
const nodePresent = nodeRows.filter((row) => row.status === 'present');
const nodeMissing = nodeRows.filter((row) => row.status === 'missing');
const nodeExportsImplemented = sum(nodeRows, (row) => row.implemented);
const nodeExportsTotal = sum(nodeRows, (row) => row.total);

const bunModuleRows = moduleRows(manifest.coverage.bun.modules);
const bunModulePresent = bunModuleRows.filter((row) => row.status === 'present');
const bunModuleExportsImplemented = sum(bunModuleRows, (row) => row.implemented);
const bunModuleExportsTotal = sum(bunModuleRows, (row) => row.total);
const bunObjectImplemented = manifest.coverage.bun.Bun.implemented.length;
const bunObjectTotal = bunObjectImplemented + manifest.coverage.bun.Bun.missing.length;

console.log(paint('Cottontail API Surface', 'bold'));
console.log(paint(`Node ${manifest.targets.node.version}  ·  Bun ${manifest.targets.bun.version}  ·  ${manifest.note}`, 'dim'));

section('Overview');
printMetric('Node modules', nodePresent.length, nodeRows.length, `${nodeMissing.length} missing modules`);
printMetric('Node exports', nodeExportsImplemented, nodeExportsTotal, `${nodeExportsTotal - nodeExportsImplemented} missing names`);
printMetric('Bun object', bunObjectImplemented, bunObjectTotal, `${bunObjectTotal - bunObjectImplemented} missing properties`);
printMetric('Bun modules', bunModulePresent.length, bunModuleRows.length, `${bunModuleRows.length - bunModulePresent.length} missing modules`);
printMetric('Bun module exports', bunModuleExportsImplemented, bunModuleExportsTotal, `${bunModuleExportsTotal - bunModuleExportsImplemented} missing names`);

section(`Node Modules With Largest Gaps (top ${topCount})`);
printRows(
  [...nodeRows]
    .sort((left, right) => right.missing - left.missing || left.name.localeCompare(right.name))
    .slice(0, topCount),
  { nameWidth: 26 },
);
printList('Missing Node modules', nodeMissing.map((row) => row.name), topCount);

section('Bun Surface');
printRows(
  [...bunModuleRows]
    .sort((left, right) => right.missing - left.missing || left.name.localeCompare(right.name)),
  { nameWidth: 16 },
);
printList('Missing Bun properties', manifest.coverage.bun.Bun.missing, topCount * 2);

section('Useful Next Targets');
const nextTargets = [
  ...nodeRows
    .filter((row) => row.status === 'present' && row.missing > 0)
    .sort((left, right) => right.missing - left.missing)
    .slice(0, 5)
    .map((row) => `${row.name} (${row.missing} missing exports)`),
  ...bunModuleRows
    .filter((row) => row.status === 'present' && row.missing > 0)
    .sort((left, right) => right.missing - left.missing)
    .slice(0, 3)
    .map((row) => `${row.name} (${row.missing} missing exports)`),
];
for (const target of nextTargets) {
  console.log(`  ${paint('•', 'cyan')} ${target}`);
}

console.log('');
console.log(paint('Regenerate: bun run compat:surface     View: bun run compat:surface:view', 'dim'));
