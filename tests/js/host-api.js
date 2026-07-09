function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(Array.isArray(cottontail.args), 'cottontail.args should be an array');
assert(cottontail.args.length === 2, `expected 2 args, got ${cottontail.args.length}`);
assert(cottontail.args[0] === 'alpha', 'first arg mismatch');
assert(cottontail.args[1] === 'beta', 'second arg mismatch');

const cwd = cottontail.cwd();
assert(cwd === cottontail.env('COTTONTAIL_EXPECT_CWD'), 'cwd mismatch');

const fixture = cottontail.readFile('tests/js/fixtures/sample.txt');
assert(fixture.trim() === 'fixture text from cottontail', 'fixture read mismatch');

const envValue = cottontail.env('COTTONTAIL_TEST_ENV');
assert(envValue === 'present', 'env(name) mismatch');

const envMap = cottontail.env();
assert(envMap.COTTONTAIL_TEST_ENV === 'present', 'env() object mismatch');

const tempFilePath = cottontail.env('COTTONTAIL_TMP_FILE');
const tempDirPath = cottontail.env('COTTONTAIL_TMP_DIR');
cottontail.writeFile(tempFilePath, 'host api roundtrip');
const roundtrip = cottontail.readFile(tempFilePath);
assert(roundtrip === 'host api roundtrip', 'writeFile/readFile roundtrip mismatch');

assert(typeof cottontail.platform === 'function', 'platform() missing');
assert(typeof cottontail.arch === 'function', 'arch() missing');
assert(cottontail.platform().length > 0, 'platform() empty');
assert(cottontail.arch().length > 0, 'arch() empty');
assert(process.argv0 === process.execPath, 'process.argv0 should default to process.execPath');
assert(process.argv0.endsWith(cottontail.platform() === 'win32' ? 'cottontail.exe' : 'cottontail'), 'process.argv0 should point at cottontail');

assert(cottontail.existsSync('tests/js/fixtures/sample.txt'), 'existsSync fixture mismatch');
assert(!cottontail.existsSync('tests/js/fixtures/missing.txt'), 'existsSync missing mismatch');

cottontail.mkdirSync(tempDirPath, true);
assert(cottontail.existsSync(tempDirPath), 'mkdirSync failed');
cottontail.rmSync(tempDirPath, true, true);
assert(!cottontail.existsSync(tempDirPath), 'rmSync failed');

const cwdPath = cottontail.cwd();
const childBinary = cottontail.platform() === 'win32'
  ? `${cwdPath}/zig-out/bin/cottontail.exe`
  : `${cwdPath}/zig-out/bin/cottontail`;
const childScript = `${cwdPath}/tests/js/spawn-child.js`;
const childCwd = `${cwdPath}/tests/js/fixtures`;
const childResult = cottontail.spawnSync(childBinary, [childScript], {
  cwd: childCwd,
  env: {
    COTTONTAIL_SPAWN_TOKEN: 'spawned',
  },
  stdio: 'pipe',
});

assert(childResult.status === 0, `spawnSync status mismatch: ${childResult.status}`);
assert(childResult.stdout.includes(`spawn cwd = ${childCwd}`), 'spawnSync cwd mismatch');
assert(childResult.stdout.includes('spawn token = spawned'), 'spawnSync env mismatch');

console.log('host api passed');
