// Diagnostic only. All fixtures and mandatory gate scripts remain unchanged.
// The published .0 GHA reporter bug requires its flag cleared to execute bodies;
// this is baseline discovery, not acceptance of the corrected release source.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

assert.equal(process.platform, 'win32');
const repeatCount = 20;
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
const scratch = mkdtempSync(resolve('vendors', '.stdin-repeat-'));
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

const fixturePath = 'tests/js/node-child-process-stdin-lifecycle.mjs';
const fixtureBytes = readFileSync(fixturePath);
const provenance = {
  purpose: 'One bounded informational repeat of a known mandatory stdin gate; does not hold or change the .4 release and does not authorize runtime fixes.',
  fixtureRevision, artifactRevision, version, platform, repeatCount, manifestUrl, archive,
  diagnosticRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  fixturePath, fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
  normalizedFixtureSha256: createHash('sha256').update(fixtureBytes.toString('utf8').replaceAll('\r\n', '\n')).digest('hex'),
  nodeIdentity: { version: process.versions.node, arch: process.arch },
  environment: { CI: environment.CI, GITHUB_ACTIONS: environment.GITHUB_ACTIONS, AGENT: environment.AGENT },
  workaround: 'Published .0 reporter flag cleared to execute real bodies; this fixture is a standalone script. No runtime module overlay.',
  runtimeArgv: [binary, resolve(fixturePath)],
  timeoutMs: 90_000,
  note: 'Each repetition uses an independent owned native Windows Job with strict unchanged fixture assertions and complete descendant cleanup.',
};
writeFileSync(join(logs, 'provenance.json'), JSON.stringify(provenance, null, 2));
writeFileSync(join(logs, 'node-child-process-stdin-lifecycle.mjs'), fixtureBytes);
console.log(JSON.stringify(provenance, null, 2));
const results = [];
for (let iteration = 1; iteration <= repeatCount; iteration++) {
  const args = [resolve('scripts/diagnose-windows-stdin-owned-child.mjs')];
  const startedAt = Date.now();
  console.log(`STDIN REPEAT START ${iteration} ${new Date(startedAt).toISOString()}`);
  const result = spawnSync(process.execPath, args, { cwd: root, env: environment, encoding: 'utf8', timeout: 110_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const passedCases = (result.stdout?.match(/^ok /gm) ?? []).length;
  const evidence = {
    iteration, argv: [process.execPath, ...args], runtimeArgv: provenance.runtimeArgv, cwd: root,
    environment: provenance.environment, timeoutMs: 110_000,
    startedAt, durationMs: Date.now() - startedAt,
    status: result.status, unsignedStatus: result.status === null ? null : result.status >>> 0,
    signal: result.signal, error: result.error?.message,
    stdout: result.stdout, stderr: result.stderr, passedCases,
    passed: result.status === 0 && !result.error && passedCases === 6 && result.stdout.includes('node child_process stdin lifecycle passed') && result.stdout.includes('DIAGNOSTIC OWNED STDIN PASSED'),
  };
  results.push(evidence);
  console.log('STDIN REPEAT RESULT ' + JSON.stringify(evidence));
  writeFileSync(join(logs, `stdin-${iteration}.json`), JSON.stringify(evidence, null, 2));
  writeFileSync(join(logs, 'results.json'), JSON.stringify(results, null, 2));
  if (!evidence.passed) {
    const detail = JSON.stringify({ iteration, status: evidence.status, passedCases, stderr: evidence.stderr }).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.log(`::error title=Published baseline stdin recurrence::${detail}`);
  }
}
const failed = results.filter(result => !result.passed);
console.log('STDIN REPEAT COMPLETE ' + JSON.stringify({ platform, total: results.length, passed: results.length - failed.length, failedIterations: failed.map(result => result.iteration) }));
process.exitCode = failed.length ? 1 : 0;
