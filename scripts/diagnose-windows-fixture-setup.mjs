// Diagnostic helper only: no JSC or runtime build, and no vcpkg installation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

assert.equal(process.platform, 'win32');
mkdirSync('diagnostic-logs', { recursive: true });
const manifest = JSON.parse(readFileSync('scripts/zig-manifest.json'));
const asset = manifest.assets['win32-x64'];
mkdirSync('vendors', { recursive: true });
const scratch = mkdtempSync(resolve('vendors', '.baseline-zig-'));
const response = await fetch(`https://ziglang.org/download/${manifest.version}/${asset.folder}.zip`);
assert.ok(response.ok);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
const archivePath = join(scratch, 'zig.zip');
const unpacked = join(scratch, 'unpacked');
writeFileSync(archivePath, bytes);
mkdirSync(unpacked);
execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', archivePath, '-C', unpacked], { stdio: 'inherit' });
renameSync(join(unpacked, asset.folder), resolve('vendors/zig'));
const zig = resolve('vendors/zig/zig.exe');
assert.equal(execFileSync(zig, ['version'], { encoding: 'utf8' }).trim(), manifest.version);
mkdirSync('zig-out/bin', { recursive: true });
const helpers = [];
for (const [source, name] of [['tests/windows-job-launcher.zig', 'cottontail-bun-compat-job'], ['tests/upstream-command-adapter.zig', 'cottontail-upstream-command']]) {
  const target = process.arch === 'arm64' ? 'aarch64-windows-msvc' : 'x86_64-windows-msvc';
  const args = ['build-exe', source, '-O', 'ReleaseFast', '-target', target, `-femit-bin=${resolve('zig-out/bin', `${name}.exe`)}`];
  const result = spawnSync(zig, args, { encoding: 'utf8', timeout: 300_000, windowsHide: true });
  const evidence = { source, argv: [zig, ...args], status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr };
  helpers.push(evidence);
  console.log(JSON.stringify(evidence));
  writeFileSync(join('diagnostic-logs', `${name}-build.json`), JSON.stringify(evidence, null, 2));
}
writeFileSync('diagnostic-logs/fixture-setup.json', JSON.stringify({ zigVersion: manifest.version, zigArchive: asset, helpers }, null, 2));
// Keep collecting runtime evidence if an optional test helper cannot compile;
// the harness reports any actual missing-helper failures without hiding them.
