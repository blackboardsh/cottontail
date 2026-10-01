import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/runtime_modules/vendor/sourcemap.js', import.meta.url), 'utf8')
  .replace(/^export function /gm, 'function ')
  .replace('export default {', 'globalThis.remapper = {');

function fixture() {
  let reads = 0;
  const references = [];
  const context = vm.createContext({
    WeakRef: class extends WeakRef {
      constructor(value) { super(value); references.push(this); }
    },
    cottontail: { readFile(path) {
      if (path !== '/tmp/app.js.map') return null;
      reads++;
      return JSON.stringify({ version: 3, sources: ['original.js'],
        sourcesContent: ['throw new Error("example");'], names: [], mappings: 'AAAA' });
    } },
    __cottontailBundlePath: '/tmp/app.js',
    __cottontailBundleSourceMap: '/tmp/app.js.map',
  });
  vm.runInContext(source, context);
  return { context, references, reads: () => reads };
}

async function collect() {
  // WeakRef targets survive their creation job. Collect only after yielding.
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setImmediate(resolve));
    globalThis.gc();
  }
}

test('incidental map cache can be collected and stack locations still remap', async () => {
  assert.equal(typeof globalThis.gc, 'function', 'run with node --expose-gc scripts/sourcemap-cache-retention.test.js');
  const f = fixture();
  assert.equal(f.context.remapper.remapStackString('example@/tmp/app.js:1:1'), 'example@/tmp/original.js:1:1');
  const firstReads = f.reads();
  await collect();
  assert.equal(f.references[0].deref(), undefined, 'stack formatting must not pin the decoded map');
  assert.equal(f.context.remapper.remapStackString('example@/tmp/app.js:1:1'), 'example@/tmp/original.js:1:1');
  assert.ok(f.reads() > firstReads, 'collected maps reload on demand');
});

test('an explicit consumer retains its map across collection', async () => {
  const f = fixture();
  const consumer = f.context.remapper.createSourceMapConsumer(JSON.stringify({ version: 3,
    sources: ['original.js'], sourcesContent: ['const example = 1;'], names: [], mappings: 'AAAA' }),
    { mapPath: '/tmp/app.js.map', bundlePath: '/tmp/app.js' });
  await collect();
  assert.equal(consumer.originalPositionFor(1, 1).source, '/tmp/original.js');
  assert.equal(consumer.originalPositionFor(1, 1).lines[0], 'const example = 1;');
});
