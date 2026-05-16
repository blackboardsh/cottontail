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
cottontail.writeFile(tempFilePath, 'host api roundtrip');
const roundtrip = cottontail.readFile(tempFilePath);
assert(roundtrip === 'host api roundtrip', 'writeFile/readFile roundtrip mismatch');

console.log('host api passed');
