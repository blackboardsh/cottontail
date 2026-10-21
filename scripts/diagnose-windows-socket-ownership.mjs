// Transient diagnostic only: execute unchanged assertions against a published
// baseline archive, collect every case failure, and retain a failing exit code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.cwd();
const logs = join(root, 'diagnostic-logs');
mkdirSync(logs, { recursive: true });
const fixtureRevision = '0022f241351e9deb665d4a5485ee38e37b3f32b8';
const artifactRevision = '602571becff4bd997fe64d08c7a5f396dba1b489';
const version = '0.7.3-canary.0';
const platform = `windows-${process.arch}`;
const checksums = {
  'windows-x64': '62685a6b61670b26bd3c9a75fa25aeb8d10bd8499cff0654f364a4a6cc03a3a6',
  'windows-arm64': '5581864a39388c4a0a7994932505a5592a1d908749ace7660c93e0709fb6bf20',
};
assert.equal(process.platform, 'win32');
assert.ok(checksums[platform]);
assert.equal(JSON.parse(readFileSync('package.json')).version, version);
execFileSync('git', ['diff', '--exit-code', fixtureRevision, '--', 'scripts/test-js.js', 'tests/js', 'package.json'], { stdio: 'inherit' });
const manifestUrl = `https://electrobun-artifacts.blackboard.sh/cottontail/releases/${version}/manifest.json`;
const manifestResponse = await fetch(manifestUrl);
assert.ok(manifestResponse.ok, `Manifest HTTP ${manifestResponse.status}`);
const manifest = await manifestResponse.json();
assert.equal(manifest.revision, artifactRevision);
assert.equal(manifest.version, version);
const archive = manifest.platforms[platform].archive;
assert.equal(archive.sha256, checksums[platform]);
const archiveResponse = await fetch(archive.url);
assert.ok(archiveResponse.ok, `Archive HTTP ${archiveResponse.status}`);
const bytes = Buffer.from(await archiveResponse.arrayBuffer());
assert.equal(bytes.length, archive.size);
assert.equal(createHash('sha256').update(bytes).digest('hex'), archive.sha256);
const scratch = mkdtempSync(join(tmpdir(), 'cottontail-baseline-diagnostic-'));
const archivePath = join(scratch, 'cottontail.tar.gz');
writeFileSync(archivePath, bytes);
mkdirSync('zig-out', { recursive: true });
execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xzf', archivePath, '--strip-components=1', '-C', 'zig-out'], { stdio: 'inherit' });
const binary = resolve('zig-out/bin/cottontail.exe');
const actualVersion = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.equal(actualVersion, version);

const original = readFileSync('scripts/test-js.js', 'utf8');
const provenance = {
  purpose: 'Published .0 baseline discovery only; final corrected-source acceptance requires GITHUB_ACTIONS=true.',
  fixtureRevision, artifactRevision, version, platform, manifestUrl, archive,
  actualVersion, fixtureHarnessSha256: createHash('sha256').update(original).digest('hex'),
  diagnosticRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  environment: { CI: 'true', GITHUB_ACTIONS: '', AGENT: '0' },
  rationale: 'The .0 GitHub aggregate runner can skip test bodies. Clearing only its reporter flag executes real baseline bodies; all assertions remain unchanged.',
};
console.log(JSON.stringify(provenance, null, 2));
writeFileSync(join(logs, 'provenance.json'), JSON.stringify(provenance, null, 2));
writeFileSync(join(logs, 'published-manifest.json'), JSON.stringify(manifest, null, 2));


const environment = { ...process.env, CI: 'true', GITHUB_ACTIONS: '', AGENT: '0' };
for (const name of ['COTTONTAIL_RUNTIME_MODULES_DIR', 'COTTONTAIL_TEST_CLI_HEADER_PRINTED', 'COTTONTAIL_TEST_FILE_COUNT', 'COTTONTAIL_TEST_AGGREGATE_FILE', 'COTTONTAIL_TEST_REPORTER_AGGREGATE_FILE', 'COTTONTAIL_TEST_GITHUB_CAPTURE']) delete environment[name];
const fixture = resolve('tests/js/node-net-duplex.test.ts');
const overlayRoot = resolve('diagnostics/socket-overlay');
const overlayNet = join(overlayRoot, 'node/net.js');
const modes = [{ name: 'published-baseline', overlay: null }];
if (existsSync(overlayNet)) modes.push({ name: 'net-source-overlay', overlay: overlayRoot });
const plans = [
  { name: 'ownership-transfer', pattern: '^Socket transfers ownership of an existing Socket handle$', expectedPass: 1, repetitions: 20 },
  { name: 'raw-tcp-adoption', pattern: '^Socket adopts a raw TCP client handle$', expectedPass: 1, repetitions: 20 },
  { name: 'all-seven-socket-contracts', pattern: null, expectedPass: 7, repetitions: 3 },
];
const socketProvenance = {
  ...provenance,
  purpose: 'Repeated unchanged socket ownership, half-close, data/FIN ordering and lifetime assertions against published .0, with optional explicitly hashed source overlay. Not final embedded-source acceptance.',
  fixturePath: fixture,
  fixtureSha256: createHash('sha256').update(readFileSync(fixture)).digest('hex'),
  overlay: existsSync(overlayNet) ? { path: overlayNet, sha256: createHash('sha256').update(readFileSync(overlayNet)).digest('hex') } : null,
  plans,
};
writeFileSync(join(logs, 'socket-provenance.json'), JSON.stringify(socketProvenance, null, 2));
const results = [];
for (const mode of modes) {
  const tempRoot = join(scratch, mode.name);
  mkdirSync(tempRoot, { recursive: true });
  const env = { ...environment, COTTONTAIL_TMP_DIR: tempRoot };
  if (mode.overlay) env.COTTONTAIL_RUNTIME_MODULES_DIR = mode.overlay;
  for (const plan of plans) {
    for (let iteration = 1; iteration <= plan.repetitions; iteration++) {
      const args = ['test', fixture, ...(plan.pattern ? ['--test-name-pattern', plan.pattern] : [])];
      const startedAt = Date.now();
      const result = spawnSync(binary, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      const countedBodies = new RegExp(`\\b${plan.expectedPass} pass\\b`).test(output) && /\b0 fail\b/.test(output);
      const passed = result.status === 0 && !result.error && countedBodies;
      const evidence = { mode: mode.name, name: plan.name, iteration, expectedPass: plan.expectedPass, passed, durationMs: Date.now() - startedAt, argv: [binary, ...args], environment: { CI: env.CI, GITHUB_ACTIONS: env.GITHUB_ACTIONS, AGENT: env.AGENT, COTTONTAIL_TMP_DIR: env.COTTONTAIL_TMP_DIR, COTTONTAIL_RUNTIME_MODULES_DIR: env.COTTONTAIL_RUNTIME_MODULES_DIR ?? null }, status: result.status, unsignedStatus: result.status === null ? null : result.status >>> 0, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr };
      results.push(evidence);
      console.log('SOCKET RESULT ' + JSON.stringify(evidence));
      writeFileSync(join(logs, 'socket-results.json'), JSON.stringify(results, null, 2));
    }
  }
}
const summary = modes.map(mode => ({ mode: mode.name, plans: plans.map(plan => ({ name: plan.name, passed: results.filter(result => result.mode === mode.name && result.name === plan.name && result.passed).length, total: plan.repetitions })) }));
writeFileSync(join(logs, 'socket-summary.json'), JSON.stringify(summary, null, 2));
console.log('SOCKET SUMMARY ' + JSON.stringify(summary));
process.exitCode = results.every(result => result.passed) ? 0 : 1;
