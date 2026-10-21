// Transient diagnostic only: execute unchanged assertions against a published
// baseline archive, collect every case failure, and retain a failing exit code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const logs = join(root, 'diagnostic-logs');
mkdirSync(logs, { recursive: true });
const fixtureRevision = '0022f241351e9deb665d4a5485ee38e37b3f32b8';
const artifactRevision = '602571becff4bd997fe64d08c7a5f396dba1b489';
const version = '0.7.3-canary.0';
const platform = `linux-${process.arch}`;
const checksums = {
  'linux-x64': '8c105d402cab5b7b40b3d81b68294a99994e14e14c0cf40b49c438ed7d70c286',
  'linux-arm64': 'b7d8bbd577b0c9a4f703d03801167ce1e8429121323bb8e5f2d0728317c3c41c',
};
assert.equal(process.platform, 'linux');
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
execFileSync('tar', ['-xzf', archivePath, '--strip-components=1', '-C', 'zig-out'], { stdio: 'inherit' });
const actualVersion = execFileSync('zig-out/bin/cottontail', ['--version'], { encoding: 'utf8' }).trim();
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

let diagnostic = original;
function replaceOnce(before, after) {
  assert.equal(diagnostic.split(before).length, 2, `Expected exactly one harness fragment: ${before.slice(0, 100)}`);
  diagnostic = diagnostic.replace(before, after);
}
replaceOnce('  process.exit(1);', '  throw new Error(message);');
replaceOnce('const rootDir = process.cwd();', `const diagnosticResults = [];
function runDiagnosticCase(name, callback) {
  const startedAt = Date.now();
  console.log('\\nDIAGNOSTIC START ' + name);
  try {
    callback();
    diagnosticResults.push({ name, status: 'passed', durationMs: Date.now() - startedAt });
  } catch (error) {
    const message = error.stack ?? String(error);
    console.error('DIAGNOSTIC FAIL ' + name + '\\n' + message);
    diagnosticResults.push({ name, status: 'failed', durationMs: Date.now() - startedAt, error: message });
  }
  writeFileSync(process.env.COTTONTAIL_DIAGNOSTIC_RESULTS, JSON.stringify(diagnosticResults, null, 2));
}
const rootDir = process.cwd();`);
replaceOnce("    encoding: 'utf8',\n  });\n\n  if (result.error)", "    encoding: 'utf8',\n    timeout: 600_000,\n    maxBuffer: 64 * 1024 * 1024,\n  });\n\n  console.log('DIAGNOSTIC STDOUT ' + testCase.name + '\\n' + (result.stdout ?? ''));\n  console.log('DIAGNOSTIC STDERR ' + testCase.name + '\\n' + (result.stderr ?? ''));\n  if (result.error)");
replaceOnce(`    runCase(testCase);
    assertRepositoryMetadataUnchanged(testCase.name);`, `    runDiagnosticCase(testCase.name, () => {
      try { runCase(testCase); }
      finally { assertRepositoryMetadataUnchanged(testCase.name); }
    });`);
replaceOnce('  const hotWatchResult = spawnSync(', "  runDiagnosticCase('hot/watch runtime integration', () => {\n  const hotWatchResult = spawnSync(");
replaceOnce("  assertRepositoryMetadataUnchanged('hot/watch runtime integration');", "  assertRepositoryMetadataUnchanged('hot/watch runtime integration');\n  });\n\n  runDiagnosticCase('eval entrypoint cleanup', () => {");
replaceOnce('} finally {\n  rmSync(tempDir,', '  });\n} finally {\n  rmSync(tempDir,');
diagnostic += `
const failedCases = diagnosticResults.filter(result => result.status === 'failed');
console.log('\\nDIAGNOSTIC COMPLETE: ' + diagnosticResults.length + ' cases, ' + failedCases.length + ' failures');
for (const failure of failedCases) console.log('DIAGNOSTIC FAILURE: ' + failure.name);
process.exitCode = failedCases.length === 0 ? 0 : 1;
`;
const harnessPath = join(scratch, 'test-js-continue-on-failure.mjs');
writeFileSync(harnessPath, diagnostic);
writeFileSync(join(logs, 'test-js-continue-on-failure.mjs'), diagnostic);
const environment = { ...process.env, CI: 'true', GITHUB_ACTIONS: '', AGENT: '0', COTTONTAIL_DIAGNOSTIC_RESULTS: join(logs, 'results.json') };
delete environment.COTTONTAIL_RUNTIME_MODULES_DIR;
const result = spawnSync(process.execPath, [harnessPath], { cwd: root, env: environment, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
