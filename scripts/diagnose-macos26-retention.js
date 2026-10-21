import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Transient diagnostic workflow: published binaries only, no runtime rebuild,
// changed retention threshold, or release acceptance claim.
const outputDir = resolve('retention-diagnostics');
mkdirSync(outputDir, { recursive: true });
const versions = [
  {
    version: '0.7.2',
    revision: '873c890ce57d8a8f011731776bca478453db8e76',
    sha256: 'a07cb2b24aabe2389e9e8484c2cd824fe7176df82f601daa06f0f8f9a0d1b2c2',
    size: 46439086,
  },
  {
    version: '0.7.3-canary.0',
    revision: '602571becff4bd997fe64d08c7a5f396dba1b489',
    sha256: 'c512412d4ea98146c99b32c13fd8e98b239c36ce944dda8a32ed29a353f7f1d2',
    size: 46852311,
  },
];
const threshold = 48 * 1024 * 1024;
const evidencePath = resolve(outputDir, 'measurements.jsonl');
function record(value) {
  const line = JSON.stringify(value);
  console.log(line);
  appendFileSync(evidencePath, `${line}\n`);
}
function command(binary, args, options = {}) {
  return spawnSync(binary, args, {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024, ...options,
  });
}
function provenanceCommand(binary, args) {
  const result = command(binary, args);
  return { command: [binary, ...args], status: result.status, stdout: result.stdout, stderr: result.stderr };
}
async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
record({
  kind: 'runner', platform: process.platform, arch: process.arch,
  osRelease: release(), cpus: cpus().length, totalMemory: totalmem(),
  imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion,
  sourceRevision: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  fixtureSha256: createHash('sha256').update(readFileSync('tests/js/fixtures/bundler-retention.js')).digest('hex'),
  commands: [
    provenanceCommand('sw_vers', []),
    provenanceCommand('xcrun', ['--show-sdk-version']),
    provenanceCommand('xcrun', ['--find', 'clang']),
    provenanceCommand('sysctl', ['hw.logicalcpu', 'hw.memsize', 'hw.pagesize']),
  ],
});
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This diagnostic requires native macOS ARM.');
const runtimes = [];
for (const item of versions) {
  const manifestUrl = `https://electrobun-artifacts.blackboard.sh/cottontail/releases/${item.version}/manifest.json`;
  const manifestBytes = await download(manifestUrl);
  writeFileSync(resolve(outputDir, `manifest-${item.version}.json`), manifestBytes);
  const manifest = JSON.parse(manifestBytes);
  const archive = manifest.platforms?.['macos-arm64']?.archive;
  const archiveUrl = `https://electrobun-artifacts.blackboard.sh/cottontail/builds/${item.revision}/macos-arm64/cottontail.tar.gz`;
  if (manifest.version !== item.version || manifest.revision !== item.revision ||
      archive?.sha256 !== item.sha256 || archive?.size !== item.size || archive?.url !== archiveUrl) {
    throw new Error(`Published manifest provenance mismatch for ${item.version}`);
  }
  const archiveBytes = await download(archiveUrl);
  const actualSha256 = createHash('sha256').update(archiveBytes).digest('hex');
  if (actualSha256 !== item.sha256 || archiveBytes.length !== item.size) {
    throw new Error(`Archive checksum/size mismatch for ${item.version}`);
  }
  const packageDir = resolve(process.env.RUNNER_TEMP ?? outputDir, `retention-runtime-${item.version}`);
  mkdirSync(packageDir, { recursive: true });
  const archivePath = resolve(packageDir, 'cottontail.tar.gz');
  writeFileSync(archivePath, archiveBytes);
  const extraction = command('tar', ['-xf', archivePath, '-C', packageDir]);
  if (extraction.status !== 0) throw new Error(`Archive extraction failed: ${extraction.stderr}`);
  const binary = resolve(packageDir, `cottontail-v${item.version}-macos-arm64/bin/cottontail`);
  record({ kind: 'runtime', ...item, archiveUrl, actualSha256, binary,
    commands: [provenanceCommand(binary, ['--version']), provenanceCommand('file', [binary])],
  });
  runtimes.push({ ...item, binary });
}
let failed = false;
// Interleave versions to expose shared runner pressure equally.
for (let iteration = 0; iteration < 10; iteration++) {
  for (const item of runtimes) {
    const result = command(item.binary, ['tests/js/fixtures/bundler-retention.js'], {
      env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true', AGENT: '0' },
    });
    let measurement;
    try { measurement = JSON.parse(result.stdout); } catch {}
    const passed = result.status === 0 && result.stderr === '' &&
      measurement?.outputBytes > 1_000_000 && measurement?.growth < threshold;
    record({ kind: 'fixture', version: item.version, iteration, passed,
      thresholdBytes: threshold, status: result.status, signal: result.signal,
      measurement, stdout: result.stdout, stderr: result.stderr, error: result.error?.message,
    });
    failed ||= !passed;
  }
}
for (const item of runtimes) {
  // Both historical binaries predate the GitHub reporter registration fix.
  // Execute their actual test CLI with that reporter disabled and demand the
  // expected test/assertion counts; the direct workloads above retain GHA=true.
  const result = command(item.binary, ['test', 'tests/js/bun-bundler-retention.test.ts'], {
    env: { ...process.env, CI: 'true', GITHUB_ACTIONS: '', AGENT: '0' },
  });
  const passed = result.status === 0 && /\b2 pass\b/.test(result.stderr) &&
    /\b0 fail\b/.test(result.stderr) && /\b5 expect\(\) calls\b/.test(result.stderr);
  record({ kind: 'test-cli', version: item.version, passed, status: result.status,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message,
  });
  failed ||= !passed;
}
record({ kind: 'summary', passed: !failed, releaseAcceptance: false });
if (failed) process.exitCode = 1;
