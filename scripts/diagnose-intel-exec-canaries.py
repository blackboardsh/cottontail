import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time


root = Path(__file__).resolve().parent.parent
output = Path('/tmp/cottontail-intel-exec-evidence')
output.mkdir(parents=True, exist_ok=True)
env = {**os.environ, 'AGENT': '0', 'CI': 'true', 'GITHUB_ACTIONS': 'true'}
for name in list(env):
    if name.startswith('COTTONTAIL_TEST_') or name == 'COTTONTAIL_RUNTIME_MODULES_DIR':
        del env[name]

evidence = {'packages': {}, 'fixtures': {}, 'runs': []}
binaries = {}
for version in (3, 4):
    directory = Path(f'/tmp/cottontail-css-canary{version}')
    name = f'cottontail-v0.7.3-canary.{version}-macos-x64'
    archive = directory / f'{name}.tar.gz'
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    expected = Path(str(archive) + '.sha256').read_text().split()[0]
    assert digest == expected, f'Archive checksum mismatch: {archive}'
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
    (output / fixture).write_bytes(path.read_bytes())


def run_case(version, label, trace, full=False):
    fixture = 'hutch-shell-cli.test.ts'
    timeout = 240 if full else 45
    argv = [binaries[version], 'test']
    if trace:
        argv += ['--preload', str(root / 'scripts' / 'diagnose-hutch-child-result.mjs')]
    argv += [str(root / 'tests' / 'js' / fixture)]
    if not full:
        argv += ['-t', '^keeps exec and bun exec targets as opaque argv$']
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


# The old archive is preserved as a stock ownership baseline; its known
# private-file rejection prevents it reaching opaque argv execution.
for repetition in range(1, 4):
    for version in (3, 4):
        run_case(version, f'opaque-canary{version}-run{repetition}', trace=repetition > 1)

new_isolated = [run for run in evidence['runs'] if run['version'] == 4]
if all(run['exit_code'] == 0 for run in new_isolated):
    run_case(4, 'hutch-canary4-full-traced', trace=True, full=True)
