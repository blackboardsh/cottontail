#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const binary = resolve(process.argv[2] ?? `zig-out/bin/cottontail${process.platform === 'win32' ? '.exe' : ''}`);
const fixture = fileURLToPath(new URL('../tests/js/fixtures/jsc-jit-release.js', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.toUpperCase().startsWith('JSC_') && key.toUpperCase() !== 'COTTONTAIL_RUNTIME_MODULES_DIR'));
Object.assign(env, {
  JSC_useJIT: 'true', JSC_useDFGJIT: 'true', JSC_useFTLJIT: 'true',
  JSC_useConcurrentJIT: 'false', JSC_maximumInliningDepth: '1',
  JSC_reportCompileTimes: 'true',
  JSC_thresholdForJITAfterWarmUp: '10',
  JSC_thresholdForOptimizeAfterWarmUp: '100',
  JSC_thresholdForOptimizeAfterLongWarmUp: '100',
  JSC_thresholdForOptimizeSoon: '100',
  JSC_thresholdForFTLOptimizeAfterWarmUp: '1000',
  JSC_thresholdForFTLOptimizeSoon: '100',
});
const result = spawnSync(binary, [fixture], { env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
assert.ifError(result.error);
assert.equal(result.status, 0, `JIT runtime regression failed:\n${result.stdout}\n${result.stderr}`);
assert(result.stdout.includes('Cottontail JIT, GC, deoptimization, exceptions, and WebAssembly passed'));
for (const tier of ['Baseline', 'DFG', 'FTL']) {
  const evidence = result.stderr.split(/\r?\n/).find(line => line.includes('cottontailJitProbe') && line.includes(`using ${tier}`));
  assert(evidence, `The runtime did not compile the hot fixture with ${tier}:\n${result.stderr}`);
  console.log(evidence);
}
process.stdout.write(result.stdout);
