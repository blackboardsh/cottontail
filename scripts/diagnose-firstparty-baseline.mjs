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

// Capture every minimal reproduction independently before the long suite.
const environment = { ...process.env, CI: 'true', GITHUB_ACTIONS: '', AGENT: '0', COTTONTAIL_DIAGNOSTIC_RESULTS: join(logs, 'results.json') };
for (const name of ['COTTONTAIL_RUNTIME_MODULES_DIR', 'COTTONTAIL_TEST_CLI_HEADER_PRINTED', 'COTTONTAIL_TEST_FILE_COUNT', 'COTTONTAIL_TEST_AGGREGATE_FILE', 'COTTONTAIL_TEST_REPORTER_AGGREGATE_FILE', 'COTTONTAIL_TEST_GITHUB_CAPTURE']) delete environment[name];
const debuggerRoots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean);
const debuggerCandidates = debuggerRoots.flatMap(base => ['arm64', 'x64', 'x86'].map(arch => join(base, 'Windows Kits', '10', 'Debuggers', arch, 'cdb.exe')));
const debuggerPath = debuggerCandidates.find(existsSync);
writeFileSync(join(logs, 'debugger-discovery.json'), JSON.stringify({ debuggerCandidates, debuggerPath: debuggerPath ?? null }, null, 2));
const minimalDirectory = join(scratch, 'minimal');
mkdirSync(minimalDirectory);
const minimalResults = [];
let debugged = false;
for (const [name, expression] of Object.entries({
  'coverage-callback-without-profiler': 'try { cottontail.collectTestCoverage() } catch (e) { console.log(e.message) }',
  'buffer-ascii-callback': 'console.log(require("node:buffer").isAscii(Buffer.from("abc")))',
})) {
  const args = ['-e', expression];
  const result = spawnSync(binary, args, { cwd: minimalDirectory, env: environment, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const evidence = { name, argv: [binary, ...args], status: result.status, unsignedStatus: result.status === null ? null : result.status >>> 0, statusHex: result.status === null ? null : `0x${(result.status >>> 0).toString(16)}`, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr };
  minimalResults.push(evidence);
  console.log('MINIMAL EVIDENCE ' + JSON.stringify(evidence));
  writeFileSync(join(logs, 'minimal-results.json'), JSON.stringify(minimalResults, null, 2));
}
for (const [name, source] of Object.entries({
  'private-class.test.ts': 'class Example { #value = 1; }\n',
  'console-only.test.ts': 'console.log("empty file evaluated");\n',
  'barethrow.test.ts': 'throw new Error("bare entry failure sentinel");\n',
  'passing.test.ts': 'import { expect, test } from "bun:test"; test("before await", () => { console.log("first body executed"); expect(1).toBe(1); }); await Promise.resolve(); test("after await", () => { console.log("second body executed"); expect(2).toBe(2); });\n',
})) {
  writeFileSync(join(minimalDirectory, name), source);
  for (const githubActions of ['', 'true']) {
    for (const coverage of [false, true]) {
      const args = ['test', ...(coverage ? ['--coverage'] : []), `./${name}`];
      const env = { ...environment, GITHUB_ACTIONS: githubActions, GITHUB_WORKSPACE: minimalDirectory };
      const result = spawnSync(binary, args, { cwd: minimalDirectory, env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
      const evidence = { name, source, argv: [binary, ...args], cwd: minimalDirectory, environment: { CI: env.CI, GITHUB_ACTIONS: env.GITHUB_ACTIONS, AGENT: env.AGENT }, status: result.status, unsignedStatus: result.status === null ? null : result.status >>> 0, statusHex: result.status === null ? null : `0x${(result.status >>> 0).toString(16)}`, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr };
      minimalResults.push(evidence);
      console.log('MINIMAL EVIDENCE ' + JSON.stringify(evidence));
      writeFileSync(join(logs, 'minimal-results.json'), JSON.stringify(minimalResults, null, 2));
      if (!debugged && debuggerPath && (result.status >>> 0) === 0xc0000005) {
        debugged = true;
        const dump = join(logs, 'baseline-access-violation.dmp');
        const command = `sxe -c ".exr -1; .ecxr; r; k; .dump /ma ${dump}; q" av; g`;
        const debugArgs = ['-o', '-G', '-c', command, binary, ...args];
        const debug = spawnSync(debuggerPath, debugArgs, { cwd: minimalDirectory, env, encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
        writeFileSync(join(logs, 'debugger-access-violation.json'), JSON.stringify({ argv: [debuggerPath, ...debugArgs], status: debug.status, signal: debug.signal, error: debug.error?.message, stdout: debug.stdout, stderr: debug.stderr }, null, 2));
        console.log('DEBUGGER EVIDENCE ' + JSON.stringify({ status: debug.status, stdout: debug.stdout, stderr: debug.stderr }));
      }
    }
  }
}

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
replaceOnce("    encoding: 'utf8',\n  });\n\n  if (result.error)", "    encoding: 'utf8',\n    timeout: 600_000,\n    maxBuffer: 64 * 1024 * 1024,\n  });\n\n  console.log('DIAGNOSTIC INVOCATION ' + JSON.stringify({ name: testCase.name, argv: [testCase.executablePath ?? binaryPath, ...argv], status: result.status, unsignedStatus: result.status === null ? null : result.status >>> 0, signal: result.signal, error: result.error?.message }));\n  console.log('DIAGNOSTIC STDOUT ' + testCase.name + '\\n' + (result.stdout ?? ''));\n  console.log('DIAGNOSTIC STDERR ' + testCase.name + '\\n' + (result.stderr ?? ''));\n  if (result.error)");
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
const result = spawnSync(process.execPath, [harnessPath], { cwd: root, env: environment, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status === 0 && !minimalResults.some(result => result.error || result.unsignedStatus === 0xc0000005) ? 0 : 1;
