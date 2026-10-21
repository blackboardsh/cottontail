import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = resolve(process.env.COTTONTAIL_TEST_BINARY || join(root, 'zig-out/bin', process.platform === 'win32' ? 'cottontail.exe' : 'cottontail'));
const probe = join(root, 'tests/js/fixtures/hashing-probe.mjs');
// Spans several reused 4 KiB update chunks and a partial final block.
const config = { algorithms: ['blake2b256', 'md5', 'sha1', 'sha256', 'sha512'], hmacAlgorithms: ['sha256', 'sha512'], key: 'cottontail-hmac-key', length: 1 << 17 | 13 };

function expected() {
  const input = Buffer.alloc(config.length);
  for (let index = 0; index < config.length; index++) input[index] = (index * 31 + 7) & 0xff;
  const digests = Object.fromEntries(config.algorithms.map(algorithm => [algorithm, algorithm === 'blake2b256'
    // Python hashlib.blake2b(input, digest_size=32), independent of the
    // runtime and available even when host Node links OpenSSL 3.0.
    ? 'a349afe07ec31c9f70ec9c30de5f30fc0961a94b7c6020354f15e48bba1a26d2'
    : createHash(algorithm).update(input).digest('hex')]));
  const hmacs = Object.fromEntries(config.hmacAlgorithms.map(algorithm => [algorithm, createHmac(algorithm, config.key).update(input).digest('hex')]));
  return { cryptoHasher: digests, cryptoHasherCopy: digests, hmac: hmacs, nodeHash: digests, nodeHmac: hmacs, unsupported: 'not-a-digest is not supported' };
}

// Bun.CryptoHasher lives in the separately linked hashing capability. A
// linking fault there (e.g. unresolved OpenSSL system imports on Windows)
// kills the whole process on first use, so exercise the released binary.
test('bundled hashing capability streams digests in the main thread and workers', { timeout: 70000 }, async () => {
  const environment = { ...process.env };
  for (const name of ['COTTONTAIL_RUNTIME_MODULES_DIR', 'COTTONTAIL_KEEP_TEMP']) delete environment[name];
  const child = spawn(binary, [probe, JSON.stringify(config)], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(code, 0, `Hashing probe failed (code ${code}, signal ${signal}):\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    const want = expected();
    for (const realm of ['main', 'worker']) assert.deepEqual(result[realm], want, `${realm} digests`);
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
});
