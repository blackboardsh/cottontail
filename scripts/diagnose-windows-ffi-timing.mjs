// Diagnostic only: no runtime build or changes to production test deadlines.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

assert.equal(process.platform, 'win32');
const root = process.cwd();
const logs = resolve('diagnostic-logs');
mkdirSync(logs, { recursive: true });
const artifactRevision = '602571becff4bd997fe64d08c7a5f396dba1b489';
const version = '0.7.3-canary.0';
const platform = `windows-${process.arch}`;
const checksums = {
  'windows-x64': '62685a6b61670b26bd3c9a75fa25aeb8d10bd8499cff0654f364a4a6cc03a3a6',
  'windows-arm64': '5581864a39388c4a0a7994932505a5592a1d908749ace7660c93e0709fb6bf20',
};
assert.ok(checksums[platform]);
const fixturePath = 'tests/js/bun-ffi-calling-convention.test.ts';
execFileSync('git', ['diff', '--exit-code', artifactRevision, '--', fixturePath], { stdio: 'inherit' });
const originalBytes = readFileSync(fixturePath);
const original = originalBytes.toString('utf8').replaceAll('\r\n', '\n');
writeFileSync(join(logs, 'original-bun-ffi-calling-convention.test.ts'), originalBytes);
const manifestUrl = `https://electrobun-artifacts.blackboard.sh/cottontail/releases/${version}/manifest.json`;
const manifestResponse = await fetch(manifestUrl);
assert.ok(manifestResponse.ok, `Manifest HTTP ${manifestResponse.status}`);
const manifest = await manifestResponse.json();
assert.equal(manifest.revision, artifactRevision);
assert.equal(manifest.version, version);
writeFileSync(join(logs, 'published-manifest.json'), JSON.stringify(manifest, null, 2));
const archive = manifest.platforms[platform].archive;
assert.equal(archive.sha256, checksums[platform]);
const archiveResponse = await fetch(archive.url);
assert.ok(archiveResponse.ok, `Archive HTTP ${archiveResponse.status}`);
const bytes = Buffer.from(await archiveResponse.arrayBuffer());
assert.equal(bytes.length, archive.size);
assert.equal(createHash('sha256').update(bytes).digest('hex'), archive.sha256);
mkdirSync('vendors', { recursive: true });
const scratch = mkdtempSync(resolve('vendors', '.ffi-timing-'));
const archivePath = join(scratch, 'cottontail.tar.gz');
writeFileSync(archivePath, bytes);
mkdirSync('zig-out', { recursive: true });
execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xzf', archivePath, '--strip-components=1', '-C', 'zig-out'], { stdio: 'inherit' });
const binary = resolve('zig-out/bin/cottontail.exe');
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), version);
const cacheRoot = join(scratch, 'isolated-caches');
const globalCache = join(cacheRoot, 'global');
const localCache = join(cacheRoot, 'local');
mkdirSync(globalCache, { recursive: true });
mkdirSync(localCache);
assert.deepEqual(readdirSync(globalCache), []);
assert.deepEqual(readdirSync(localCache), []);

const environment = {
  ...process.env, CI: 'true', GITHUB_ACTIONS: 'true', AGENT: '0',
  COTTONTAIL_REPO_ROOT: root,
  ZIG_GLOBAL_CACHE_DIR: globalCache, ZIG_LOCAL_CACHE_DIR: localCache,
};
for (const name of ['CC', 'COTTONTAIL_RUNTIME_MODULES_DIR', 'COTTONTAIL_TEST_CLI_HEADER_PRINTED', 'COTTONTAIL_TEST_FILE_COUNT', 'COTTONTAIL_TEST_AGGREGATE_FILE', 'COTTONTAIL_TEST_REPORTER_AGGREGATE_FILE', 'COTTONTAIL_TEST_GITHUB_CAPTURE']) delete environment[name];
const cSource = original.match(/source: `([\s\S]*?)`,\n    symbols:/)?.[1];
assert.ok(cSource);
const provenance = {
  purpose: 'Time exact FFI fixture workload against the published .0 runtime with fresh isolated Zig caches, followed by the same workload with warm caches. No test-runner wrapper.',
  artifactRevision, version, platform, manifestUrl, archive,
  diagnosticRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  fixturePath, fixtureSha256: createHash('sha256').update(originalBytes).digest('hex'),
  normalizedFixtureSha256: createHash('sha256').update(original).digest('hex'),
  cSourceSha256: createHash('sha256').update(cSource).digest('hex'),
  compiler: resolve('vendors/zig/zig.exe'), compilerHost: 'x86_64-windows',
  compilerVersion: execFileSync(resolve('vendors/zig/zig.exe'), ['version'], { encoding: 'utf8' }).trim(),
  compilerTarget: process.arch === 'arm64' ? 'aarch64-windows-gnu' : 'x86_64-windows-gnu',
  environment: Object.fromEntries(['CI', 'GITHUB_ACTIONS', 'AGENT', 'COTTONTAIL_REPO_ROOT', 'ZIG_GLOBAL_CACHE_DIR', 'ZIG_LOCAL_CACHE_DIR'].map(name => [name, environment[name]])),
  ccEnvironmentOverride: null,
  initialCacheEntries: { global: readdirSync(globalCache), local: readdirSync(localCache) },
};
console.log(JSON.stringify(provenance, null, 2));
writeFileSync(join(logs, 'provenance.json'), JSON.stringify(provenance, null, 2));

let standalone = original;
function replaceOnce(before, after) {
  assert.equal(standalone.split(before).length, 2, `Expected one fixture fragment: ${before}`);
  standalone = standalone.replace(before, after);
}
replaceOnce('import { expect, test } from "bun:test";', `import assert from "node:assert/strict";
const iteration = process.argv[2];
const timings = {};
function measure(name, body) {
  console.log(JSON.stringify({ iteration, phase: name, event: "start", at: Date.now() }));
  const start = Date.now();
  try { return body(); }
  finally {
    timings[name] = Date.now() - start;
    console.log(JSON.stringify({ iteration, phase: name, event: "end", elapsedMs: timings[name], at: Date.now() }));
  }
}
const totalStart = Date.now();`);
replaceOnce('test("FFI preserves register and stack arguments across native calls and callbacks", () => {', '{');
replaceOnce('  const library = cc({', '  const library = measure("cc", () => cc({');
replaceOnce('  });\n  const callback = new JSCallback(', '  }));\n  const callback = measure("callback-create", () => new JSCallback(');
replaceOnce('  );\n  try {', '  ));\n  try {\n    measure("native-calls-and-three-assertions", () => {');
replaceOnce('    expect(library.symbols.weighted_ints(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)).toBe(385);', '    assert.equal(library.symbols.weighted_ints(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), 385);');
replaceOnce('    expect(library.symbols.weighted_doubles(0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5)).toBe(192.5);', '    assert.equal(library.symbols.weighted_doubles(0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5), 192.5);');
replaceOnce('    expect(library.symbols.call_callback(callback.ptr)).toBe(385);', '    assert.equal(library.symbols.call_callback(callback.ptr), 385);\n    });');
replaceOnce('    callback.close();\n    library.close();', '    measure("callback-close", () => callback.close());\n    measure("library-close", () => library.close());');
replaceOnce('}, 120_000);', '}\nconsole.log(JSON.stringify({ iteration, completed: true, assertions: 3, timings, totalMs: Date.now() - totalStart }));');
const standalonePath = join(scratch, 'ffi-timing.ts');
writeFileSync(standalonePath, standalone);
writeFileSync(join(logs, 'ffi-timing.ts'), standalone);
const results = [];
for (const iteration of ['cold', 'warm']) {
  const args = ['run', standalonePath, iteration];
  const startedAt = Date.now();
  console.log(`START ${iteration} ${new Date(startedAt).toISOString()}`);
  const result = spawnSync(binary, args, { cwd: root, env: environment, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const evidence = {
    iteration, argv: [binary, ...args], cwd: root,
    environment: provenance.environment, startedAt, durationMs: Date.now() - startedAt,
    status: result.status, unsignedStatus: result.status === null ? null : result.status >>> 0,
    signal: result.signal, error: result.error?.message,
    stdout: result.stdout, stderr: result.stderr,
    cacheEntriesAfter: { global: readdirSync(globalCache), local: readdirSync(localCache) },
  };
  results.push(evidence);
  console.log(JSON.stringify(evidence));
  writeFileSync(join(logs, 'results.json'), JSON.stringify(results, null, 2));
}
process.exitCode = results.every(result => result.status === 0 && result.stdout.includes('"completed":true') && result.stdout.includes('"assertions":3')) ? 0 : 1;
