// Diagnostic only. All fixtures and mandatory gate scripts remain unchanged.
// The published .0 GHA reporter bug requires its flag cleared to execute bodies;
// this is baseline discovery, not acceptance of the corrected release source.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nativeBoundaryPlan } from './test-native-boundary-release.js';

assert.equal(process.platform, 'win32');
const group = process.argv[2];
assert.ok(['remaining', 'boundary'].includes(group));
const root = process.cwd();
const logs = resolve('diagnostic-logs');
mkdirSync(logs, { recursive: true });
const fixtureRevision = '1d6906cd1d9aa976f08de27035eb1453b7e41a4a';
const artifactRevision = '602571becff4bd997fe64d08c7a5f396dba1b489';
const version = '0.7.3-canary.0';
const platform = `windows-${process.arch}`;
const checksums = {
  'windows-x64': '62685a6b61670b26bd3c9a75fa25aeb8d10bd8499cff0654f364a4a6cc03a3a6',
  'windows-arm64': '5581864a39388c4a0a7994932505a5592a1d908749ace7660c93e0709fb6bf20',
};
assert.ok(checksums[platform]);
execFileSync('git', ['diff', '--exit-code', fixtureRevision, '--', 'tests/js', 'scripts/test-native-boundary-release.js', 'scripts/windows-job-child.js', 'scripts/worker-delayed-termination.test.js', 'scripts/test-hutch-private-file-release.js', 'scripts/test-icu-fallback-release.js', 'scripts/verify-windows-capability-dlls.js', 'scripts/compression-portability.test.js'], { stdio: 'inherit' });
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
const scratch = mkdtempSync(resolve('vendors', '.remaining-release-'));
const archivePath = join(scratch, 'cottontail.tar.gz');
writeFileSync(archivePath, bytes);
mkdirSync('zig-out', { recursive: true });
execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xzf', archivePath, '--strip-components=1', '-C', 'zig-out'], { stdio: 'inherit' });
const binary = resolve('zig-out/bin/cottontail.exe');
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), version);
const packageManifest = JSON.parse(readFileSync('zig-out/cottontail-release.json'));
const icuPath = resolve('zig-out', packageManifest.icu.fallbackData);
assert.equal(statSync(icuPath).size, packageManifest.icu.fallbackDataSize);
assert.equal(createHash('sha256').update(readFileSync(icuPath)).digest('hex'), packageManifest.icu.fallbackDataSha256);

const environment = { ...process.env, CI: 'true', GITHUB_ACTIONS: '', AGENT: '0' };
for (const key of Object.keys(environment)) {
  const name = key.toUpperCase();
  if (name === 'COTTONTAIL_RUNTIME_MODULES_DIR' || name.startsWith('COTTONTAIL_ELECTROBUN_') || ['ELECTROBUN_INSTALL_ROOT_NAME', 'ELECTROBUN_LAUNCHER_PID', 'COTTONTAIL_TEST_CLI_HEADER_PRINTED', 'COTTONTAIL_TEST_FILE_COUNT', 'COTTONTAIL_TEST_AGGREGATE_FILE', 'COTTONTAIL_TEST_REPORTER_AGGREGATE_FILE', 'COTTONTAIL_TEST_GITHUB_CAPTURE'].includes(name)) delete environment[key];
}
const fixtureHashes = {};
function hashFile(path) {
  const value = readFileSync(path);
  fixtureHashes[path] = { sha256: createHash('sha256').update(value).digest('hex'), normalizedSha256: createHash('sha256').update(value.toString('utf8').replaceAll('\r\n', '\n')).digest('hex') };
}
const provenance = {
  purpose: 'Discover later mandatory Windows release gate failures against exact published .0 runtime; corrected-source final acceptance must use GITHUB_ACTIONS=true.',
  fixtureRevision, artifactRevision, version, platform, group, manifestUrl, archive,
  diagnosticRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  nodeIdentity: { version: process.versions.node, arch: process.arch },
  environment: { CI: environment.CI, GITHUB_ACTIONS: environment.GITHUB_ACTIONS, AGENT: environment.AGENT },
  workaround: 'Only the old .0 GitHub reporter flag is cleared; unchanged assertions execute through its ordinary reporter.',
  checkoutPackageVersion: JSON.parse(readFileSync('package.json')).version,
  packageVersionAdjustment: 'None: selected gates do not compare the checkout package version with the runtime version.',
  packagedIcu: { path: packageManifest.icu.fallbackData, size: statSync(icuPath).size, sha256: packageManifest.icu.fallbackDataSha256 },
  limitations: ['Windows packaged ICU smoke forces fallback but does not sandbox network or cache access.', 'Native namespace factory fixture intentionally reads the unchanged current source file; other runtime gates consume the published embedded runtime.'],
  fixtureHashes,
};
const gates = [];
function runtime(name, fixture, args = [], checks = [], timeoutMs = 180_000) {
  hashFile(fixture);
  gates.push({ name, command: binary, args: [...args, resolve(fixture)], checks, timeoutMs });
}
function node(name, script, args = [], checks = [], timeoutMs = 180_000, env = {}) {
  hashFile(script);
  gates.push({ name, command: process.execPath, args: [...args, resolve(script)], checks, timeoutMs, env });
}
if (group === 'remaining') {
  runtime('windows-os-information', 'tests/js/node-os.ts', [], ['node os passed']);
  runtime('websocket-native-frame', 'tests/js/websocket-native-frame.test.ts', ['test'], ['5 pass', '0 fail', '1308 expect() calls'], 300_000);
  node('capability-dll-crt', 'scripts/verify-windows-capability-dlls.js', [], ['capability DLLs start through the MSVC CRT']);
  runtime('child-stdin-lifecycle', 'tests/js/node-child-process-stdin-lifecycle.mjs', [], ['node child_process stdin lifecycle passed'], 300_000);
  runtime('lazy-worker-messaging', 'tests/js/node-worker-lazy-web-messaging.mjs', [], ['node worker lazy web messaging passed'], 300_000);
  runtime('worker-process-bootstrap', 'tests/js/node-worker-process-bootstrap.mjs', [], ['node worker process bootstrap passed'], 300_000);
  node('delayed-worker-termination', 'scripts/worker-delayed-termination.test.js', ['--test'], ['tests 3', 'pass 3', 'fail 0'], 420_000);
  hashFile('tests/js/fixtures/worker-delayed-termination.mjs');
  runtime('inspector-nexttick-lifecycle', 'tests/js/node-inspector-nexttick-lifecycle.mjs', [], ['node inspector nextTick lifecycle passed']);
  runtime('response-subclass', 'tests/js/web-response-subclass.mjs', [], ['web response subclass passed']);
  runtime('fetch-zstd', 'tests/js/fetch-zstd-windows-regression.ts', [], ['zstd round trip passed', 'fetch zstd Windows regression passed']);
  runtime('filesystem-permissions', 'tests/js/node-fs-windows-permissions.test.ts', ['test'], ['5 pass', '0 fail', '58 expect() calls']);
  node('hutch-private-file', 'scripts/test-hutch-private-file-release.js', [], ['Hutch private file release smoke passed']);
  node('packaged-icu-fallback', 'scripts/test-icu-fallback-release.js', [], ['icu fallback passed']);
  gates.at(-1).args.push(binary);
  hashFile('tests/js/icu-fallback-smoke.js');
  node('packaged-compression', 'scripts/compression-portability.test.js', ['--test'], ['fail 0'], 300_000, { COTTONTAIL_TEST_BINARY: binary });
} else {
  const plan = nativeBoundaryPlan(root);
  assert.equal(plan.tests.length, 12);
  for (const file of ['scripts/test-native-boundary-release.js', 'scripts/windows-job-child.js', 'tests/windows-job-launcher.zig']) hashFile(file);
  hashFile('src/runtime_modules/internal/native-host-namespace.js');
  const sentinels = {
    'runtime-modular-startup.mjs': 'runtime modular startup passed',
    'stdlib-capability-entrypoints.mjs': 'stdlib capability entrypoints passed',
    'native-host-namespace-factory.mjs': 'native host namespace factory passed',
    'native-host-namespace.mjs': 'native host namespace passed',
    'node-worker-internal-loader.mjs': 'full worker bootstrap and lazy runtime loader passed',
    'node-dgram-peer-loss.mjs': 'node dgram peer loss passed',
    'fd-watch-runtime-ownership.mjs': 'fd watch runtime ownership passed',
    'node-dgram-lifecycle.mjs': 'node dgram lifecycle passed',
    'runtime-active-handles.mjs': 'runtime active handles passed',
    'bun-serve-idle-lifecycle.mjs': 'bun serve idle lifecycle passed',
  };
  for (const fixture of plan.tests) {
    hashFile(`tests/js/${fixture.name}`);
    const checks = [`DIAGNOSTIC BOUNDARY PASSED ${fixture.name}`];
    if (sentinels[fixture.name]) checks.push(sentinels[fixture.name]);
    if (fixture.name === 'idle-runtime.test.ts') checks.push('3 pass', '0 fail', '11 expect() calls');
    if (fixture.name === 'runtime-bootstrap-startup.test.ts') checks.push('1 pass', '19 filtered out', '0 fail', '13 expect() calls');
    gates.push({ name: fixture.name, command: process.execPath, args: [resolve('scripts/diagnose-windows-native-boundary-fixture.mjs'), fixture.name], checks, timeoutMs: fixture.timeoutMs + 20_000, fixtureArgv: [plan.binary, ...fixture.args], fixtureTimeoutMs: fixture.timeoutMs });
  }
}
writeFileSync(join(logs, 'provenance.json'), JSON.stringify(provenance, null, 2));
console.log(JSON.stringify(provenance, null, 2));
const results = [];
for (const gate of gates) {
  const startedAt = Date.now();
  const env = { ...environment, ...gate.env };
  console.log(`GATE START ${gate.name} ${new Date(startedAt).toISOString()}`);
  const result = spawnSync(gate.command, gate.args, { cwd: root, env, encoding: 'utf8', timeout: gate.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '').replaceAll('\r\n', '\n');
  const outputLines = output.split('\n').map(line => line.trim());
  const missingChecks = gate.checks.filter(check => /^\d+ /.test(check) ? !outputLines.includes(check) : !output.includes(check));
  const evidence = {
    name: gate.name, argv: [gate.command, ...gate.args], cwd: root,
    fixtureArgv: gate.fixtureArgv, fixtureTimeoutMs: gate.fixtureTimeoutMs,
    environment: { ...provenance.environment, ...gate.env }, timeoutMs: gate.timeoutMs,
    startedAt, durationMs: Date.now() - startedAt,
    status: result.status, unsignedStatus: result.status === null ? null : result.status >>> 0,
    signal: result.signal, error: result.error?.message,
    stdout: result.stdout, stderr: result.stderr, checks: gate.checks, missingChecks,
    passed: result.status === 0 && !result.error && missingChecks.length === 0,
  };
  results.push(evidence);
  console.log('GATE RESULT ' + JSON.stringify(evidence));
  writeFileSync(join(logs, `${gate.name}.json`), JSON.stringify(evidence, null, 2));
  writeFileSync(join(logs, 'results.json'), JSON.stringify(results, null, 2));
}
const failed = results.filter(result => !result.passed);
console.log('MANDATORY GATE DISCOVERY ' + JSON.stringify({ platform, group, total: results.length, failed: failed.map(result => result.name) }));
process.exitCode = failed.length ? 1 : 0;
