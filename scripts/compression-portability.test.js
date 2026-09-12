import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync, deflateSync, brotliCompressSync, zstdCompressSync } from 'node:zlib';
import { macosWithoutHomebrewProfile } from './macos-clean-runtime.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = resolve(process.env.COTTONTAIL_TEST_BINARY || join(root, 'zig-out/bin', process.platform === 'win32' ? 'cottontail.exe' : 'cottontail'));
const probe = join(root, 'tests/js/fixtures/compression-probe.mjs');
const content = JSON.stringify({ version: '1.2.3', artifact: 'update.app.tar.zst', resources: 'compressed response\n'.repeat(128) });
const frames = Object.fromEntries(Object.entries({ gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync, zstd: zstdCompressSync }).map(([name, compress]) => [name, compress(Buffer.from(content))]));

async function exerciseRuntime(sandbox) {
  const advertised = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const encoding = url.pathname.slice(1);
    const frame = url.searchParams.has('invalid') ? Buffer.from([1, 2, 3, 4]) : frames[encoding];
    if (!frame) { response.writeHead(404).end(); return; }
    advertised.push({ encoding, header: request.headers['accept-encoding'] });
    response.writeHead(200, { 'content-encoding': encoding, 'content-type': 'application/json' });
    response.write(frame.subarray(0, 1));
    setImmediate(() => response.end(frame.subarray(1)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const environment = { ...process.env };
  for (const name of ['COTTONTAIL_RUNTIME_MODULES_DIR', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH']) delete environment[name];
  const args = [probe, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, content })];
  const child = spawn(sandbox ? '/usr/bin/sandbox-exec' : binary, sandbox ? ['-p', macosWithoutHomebrewProfile, binary, ...args] : args, {
    cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  const timeout = setTimeout(() => child.kill(), 60000);
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 0, `Compression probe failed:\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    for (const realm of ['main', 'worker']) {
      assert.deepEqual(result[realm], { codecs: ['gzip', 'deflate', 'br', 'zstd'], responses: 8, corruptResponsesRejected: 4 });
    }
    assert.equal(advertised.length, 24);
    for (const { encoding, header } of advertised) assert(header?.split(/,\s*/).includes(encoding), `fetch did not advertise ${encoding}: ${header}`);
  } finally {
    clearTimeout(timeout);
    child.kill();
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  }
}

test('bundled codecs decode compressed HTTP in the main thread and workers', { timeout: 70000 }, () => exerciseRuntime(false));
test('macOS compressed HTTP works with Homebrew entirely inaccessible', { skip: process.platform !== 'darwin', timeout: 70000 }, () => exerciseRuntime(true));
