import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time


root = Path(__file__).resolve().parent.parent
output = Path('/tmp/cottontail-intel-compound-order-evidence')
output.mkdir(parents=True, exist_ok=True)
env = {**os.environ, 'AGENT': '0', 'CI': 'true', 'GITHUB_ACTIONS': 'true'}
for name in list(env):
    if name.startswith('COTTONTAIL_TEST_') or name == 'COTTONTAIL_RUNTIME_MODULES_DIR':
        del env[name]

evidence = {'packages': {}, 'fixtures': {}, 'runs': []}
binaries = {}
for version in (4,):
    directory = Path(f'/tmp/cottontail-css-canary{version}')
    name = f'cottontail-v0.7.3-canary.{version}-macos-x64'
    archive = directory / f'{name}.tar.gz'
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    expected = Path(str(archive) + '.sha256').read_text().split()[0]
    assert digest == expected, f'Archive checksum mismatch: {archive}'
    assert digest == '152553064b9b1b799fe7e2da294f3a61e7eed5367c5a22e5866525c59c3031ac'
    subprocess.run(['tar', '-xzf', str(archive), '-C', str(directory)], check=True)
    package = directory / name
    binary = package / 'bin' / 'cottontail'
    binaries[version] = str(binary)
    evidence['packages'][str(version)] = {
        'archive_sha256': digest,
        'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
        'manifest': json.loads((package / 'cottontail-release.json').read_text()),
    }

for fixture in ('hutch-shell-cli.test.ts',):
    path = root / 'tests' / 'js' / fixture
    evidence['fixtures'][fixture] = hashlib.sha256(path.read_bytes()).hexdigest()
    assert evidence['fixtures'][fixture] == 'bfca894d54872e3c9cf4c1ee28721c6f2292b2df67250964ebe2278a63d4a918'
    (output / fixture).write_bytes(path.read_bytes())


def run_case(version, label, trace, full=False):
    fixture = 'hutch-shell-cli.test.ts'
    timeout = 240 if full else 45
    argv = [binaries[version], 'test']
    if trace:
        argv += ['--preload', str(root / 'scripts' / 'diagnose-hutch-child-result.mjs')]
    argv += [str(root / 'tests' / 'js' / fixture)]
    if not full:
        argv += ['-t', '^preserves merged descriptor order inside a compound command$']
    start = time.monotonic()
    try:
        result = subprocess.run(argv, cwd=root, env=env, capture_output=True, timeout=timeout)
        status, stdout, stderr = result.returncode, result.stdout, result.stderr
        outer_timeout = False
    except subprocess.TimeoutExpired as error:
        status, stdout, stderr = None, error.stdout or b'', error.stderr or b''
        outer_timeout = True
    elapsed = time.monotonic() - start
    (output / f'{label}.stdout').write_bytes(stdout)
    (output / f'{label}.stderr').write_bytes(stderr)
    text = stderr.decode('utf-8', errors='replace')
    record = {
        'label': label, 'version': version, 'argv': argv,
        'exit_code': status, 'elapsed_seconds': elapsed,
        'outer_timeout': outer_timeout, 'trace': trace, 'full_fixture': full,
        'child_results': [json.loads(line[len('HUTCH_CHILD_RESULT '):])
                          for line in text.splitlines() if line.startswith('HUTCH_CHILD_RESULT ')],
        'counts': {kind: re.findall(r'(?m)^\s*(\d+) ' + kind + r'\s*$', text)
                   for kind in ('pass', 'fail', 'skip', 'error')},
        'test_timeouts': re.findall(r'timed out after (\d+)ms', text),
        'summary': re.findall(r'(?m)^Ran .*$', text),
    }
    evidence['runs'].append(record)
    (output / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(record), flush=True)
    print(stdout.decode('utf-8', errors='replace'), flush=True)
    print(text, flush=True)
    return record


isolated = run_case(4, 'compound-isolated-traced', trace=True)
full = run_case(4, 'compound-full-traced', trace=True, full=True)
for result, expected_pass, expected_skip, expected_assertions in (
    (isolated, '1', None, '2'), (full, '72', '2', '312'),
):
    assert result['exit_code'] == 0, result
    assert result['counts']['pass'] == [expected_pass], result
    assert result['counts']['fail'] == ['0'], result
    assert result['counts']['skip'] == ([expected_skip] if expected_skip else []), result
    stderr = (output / (result['label'] + '.stderr')).read_text()
    assert re.findall(r'(?m)^\s*(\d+) expect\(\) calls\s*$', stderr) == [expected_assertions], stderr
    assert '(pass) preserves merged descriptor order inside a compound command' in stderr, stderr
print('Exact canary.4 compound descriptor classification passed', flush=True)
