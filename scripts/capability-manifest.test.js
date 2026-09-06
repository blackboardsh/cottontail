import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';

import { createCapabilityManifest } from './capability-manifest.js';

const stdlibRoot = new URL('../src/stdlib/', import.meta.url);
const shippedCapabilities = readdirSync(stdlibRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .filter(entry => {
    try {
      return readdirSync(new URL(`${entry.name}/`, stdlibRoot)).includes('main.js');
    } catch {
      return false;
    }
  })
  .map(entry => entry.name)
  .sort();

function entries(sources = {}) {
  return shippedCapabilities.map(name => ({ name, source: sources[name] ?? '' }));
}

test('the capability manifest includes the complete shipped catalog', () => {
  const manifest = createCapabilityManifest(entries());
  assert.equal(manifest.schema, 1);
  assert.deepEqual(Object.keys(manifest.capabilities), shippedCapabilities);
  for (const capability of Object.values(manifest.capabilities)) {
    assert.deepEqual(capability, { requires: [] });
  }
});

test('final bundle runtime accesses become capability dependency edges', () => {
  const manifest = createCapabilityManifest(entries({
    archive: 'globalThis.Cottontail.compression.gunzipSync(bytes)',
    bake: 'await globalThis.Bun.build(options); return Bun.hash(source)',
    'filesystem-router': 'globalThis.Cottontail.glob.walkFiles(root)',
    'html-rewriter': 'globalThis.Cottontail.text.escapeHTML(value)',
    repl: 'globalThis.Cottontail.terminal.setRawMode(0, true)',
    sql: 'const sqlite = require("bun:sqlite")',
    test: 'const aliases = ["bun:ffi"]; globalThis.Bun.Glob; globalThis.Bun?.$; globalThis.Cottontail.toml.parse(text)',
  }));

  assert.deepEqual(manifest.capabilities.archive.requires, ['compression']);
  assert.deepEqual(manifest.capabilities.bake.requires, ['build', 'hashing']);
  assert.deepEqual(manifest.capabilities['filesystem-router'].requires, ['glob']);
  assert.deepEqual(manifest.capabilities['html-rewriter'].requires, ['text']);
  assert.deepEqual(manifest.capabilities.repl.requires, ['terminal']);
  assert.deepEqual(manifest.capabilities.sql.requires, ['sqlite']);
  assert.deepEqual(manifest.capabilities.test.requires, ['glob', 'shell', 'toml']);
  assert.deepEqual(manifest.capabilities.ffi.requires, []);
});

test('explicit capability loads must name a shipped capability', () => {
  assert.throws(
    () => createCapabilityManifest(entries({
      archive: 'loadCottontailCapabilityModule("not-shipped", "bun/missing.js")',
    })),
    /archive requires unknown capability not-shipped/,
  );
});
