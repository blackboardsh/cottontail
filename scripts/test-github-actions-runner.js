import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(process.argv[2] ?? process.env.COTTONTAIL_TEST_BINARY ?? join(root, 'zig-out', 'bin', process.platform === 'win32' ? 'cottontail.exe' : 'cottontail'));

function fixture(t, files) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cottontail-github-tests-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  return (args, overrides = {}) => {
    const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: directory, CI: 'true', AGENT: '0', ...overrides };
    for (const name of [
      'COTTONTAIL_RUNTIME_MODULES_DIR', 'COTTONTAIL_TEST_CLI_HEADER_PRINTED',
      'COTTONTAIL_TEST_FILE_COUNT', 'COTTONTAIL_TEST_AGGREGATE_FILE', 'COTTONTAIL_TEST_REPORTER_AGGREGATE_FILE',
      'COTTONTAIL_TEST_GITHUB_CAPTURE',
    ]) delete env[name];
    const result = spawnSync(binary, ['test', ...args], {
      cwd: directory, env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const detail = JSON.stringify({ args, githubActions: env.GITHUB_ACTIONS, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2);
    assert.ifError(result.error);
    assert.equal(result.signal, null, detail);
    return { ...result, detail };
  };
}

test('GitHub Actions runs a single explicit file through completed Bun test registration', (t) => {
  const run = fixture(t, { 'passing.test.ts': `
    import { expect, test } from 'bun:test';
    test('before await', () => { console.log('first body executed'); expect(1).toBe(1); });
    await Promise.resolve();
    test('after await', () => { console.log('second body executed'); expect(2).toBe(2); });
  ` });
  for (const args of [['./passing.test.ts'], ['--coverage', './passing.test.ts']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.detail);
    assert.match(result.stdout, /first body executed/, result.detail);
    assert.match(result.stdout, /second body executed/, result.detail);
    assert.match(result.stderr, /::group::passing\.test\.ts:/, result.detail);
    assert.match(result.stderr, /\b2 pass\b/, result.detail);
    assert.match(result.stderr, /\b0 fail\b/, result.detail);
    assert.match(result.stderr, /\b2 expect\(\) calls\b/, result.detail);
  }
});

test('GitHub Actions returns failure when an explicit test assertion fails', (t) => {
  const run = fixture(t, { 'failing.test.ts': `
    import { expect, test } from 'bun:test';
    test('passing body', () => { console.log('passing body executed'); expect(1).toBe(1); });
    test('failing body', () => { console.log('failing body executed'); expect(1).toBe(2); });
  ` });
  const result = run(['./failing.test.ts']);
  assert.equal(result.status, 1, result.detail);
  assert.match(result.stdout, /passing body executed/, result.detail);
  assert.match(result.stdout, /failing body executed/, result.detail);
  assert.match(result.stderr, /\b1 pass\b/, result.detail);
  assert.match(result.stderr, /\b1 fail\b/, result.detail);
  assert.match(result.stderr, /::error /, result.detail);
});

test('GitHub Actions drains test registrations across multiple files', (t) => {
  const run = fixture(t, {
    'one.test.ts': `import { expect, test } from 'bun:test'; test('first file', () => { console.log('first file executed'); expect(1).toBe(1); });`,
    'two.test.ts': `import { expect, test } from 'bun:test'; test('second file', () => { console.log('second file executed'); expect(2).toBe(2); });`,
  });
  const result = run(['./one.test.ts', './two.test.ts']);
  assert.equal(result.status, 0, result.detail);
  assert.match(result.stdout, /first file executed/, result.detail);
  assert.match(result.stdout, /second file executed/, result.detail);
  assert.match(result.stderr, /::group::one\.test\.ts:/, result.detail);
  assert.match(result.stderr, /::group::two\.test\.ts:/, result.detail);
  assert.match(result.stderr, /\b2 pass\b/, result.detail);
  assert.match(result.stderr, /Ran 2 tests across 2 files/, result.detail);
});

test('GitHub Actions still finalizes truly empty files, including coverage mode', (t) => {
  const run = fixture(t, { 'empty.test.ts': 'console.log("empty file evaluated");\n' });
  for (const args of [['./empty.test.ts'], ['--coverage', './empty.test.ts']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.detail);
    assert.match(result.stdout, /empty file evaluated/, result.detail);
    assert.match(result.stderr, /::group::empty\.test\.ts:/, result.detail);
    assert.match(result.stderr, /\b0 pass\b/, result.detail);
    assert.match(result.stderr, /\b0 fail\b/, result.detail);
    assert.match(result.stderr, /Ran 0 tests across 1 file/, result.detail);
    if (args.includes('--coverage')) assert.match(result.stderr, /All files/, result.detail);
  }
});

test('Coverage finalizes bare files without GitHub Actions or test imports', (t) => {
  const run = fixture(t, { 'empty.test.ts': 'class Example { #value = 1; }\n' });
  const result = run(['--coverage', './empty.test.ts'], { GITHUB_ACTIONS: '' });
  assert.equal(result.status, 0, result.detail);
  assert.match(result.stderr, /All files/, result.detail);
  assert.match(result.stderr, /\b0 pass\b/, result.detail);
  assert.match(result.stderr, /\b0 fail\b/, result.detail);
});

test('Bare test-module errors retain failing exit statuses through finalization', (t) => {
  const run = fixture(t, { 'throws.test.ts': 'throw new Error("bare entry failure sentinel");\n' });
  for (const GITHUB_ACTIONS of ['', 'true']) {
    for (const args of [['./throws.test.ts'], ['--coverage', './throws.test.ts']]) {
      const result = run(args, { GITHUB_ACTIONS });
      assert.equal(result.status, 1, result.detail);
      assert.match(result.stderr, /bare entry failure sentinel/, result.detail);
      assert.match(result.stderr, /\b0 pass\b/, result.detail);
      assert.match(result.stderr, /\b1 fail\b/, result.detail);
      assert.match(result.stderr, /\b1 error\b/, result.detail);
      if (args.includes('--coverage')) assert.match(result.stderr, /All files/, result.detail);
    }
  }
});
