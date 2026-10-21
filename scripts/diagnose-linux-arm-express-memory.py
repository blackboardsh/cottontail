#!/usr/bin/env python3
"""One unchanged owned-runner invocation per exact Linux ARM runtime archive."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time

ROOT = Path.cwd()
OUT = Path('/tmp/cottontail-express-evidence')
OUT.mkdir(exist_ok=True)
SNAPSHOT = Path('compat/upstream/bun/v1.3.10')
TEST = 'test/js/third_party/body-parser/express-memory-leak.test.ts'
FROZEN = {
    TEST: '3a215d3896de255e6d1cd66d52f3a505148da01817c8fa4402a415dc4b9ca4f8',
    'test/js/third_party/body-parser/express-memory-leak-fixture.mjs': '144017a1023e88bb2854577b574c02f006ac7e8dc2fd00341ebadecb302f49bf',
    'test/bun.lock': 'fce5ee045d6bac327fca321bf8b9dc5af1f3c6b86cd6c12110dda9a01d128df1',
    'test/package.json': '5b092dcb20a983739239070b2d6255368a8166b774bbf02e446e5933232a09d3',
    'status.json': '26ea0cdd51e599d0194df79119d35d4e508ef9eb9b403991a1984c9843e40d67',
}
ARCHIVE3_HASH = 'b23c1ee498b4fd44d5fcf0c82a3f799e046019e5d06c5d0f3054b8e4d784460e'
ARCHIVE4_HASH = '10f45e24b1d5b284a24e37ca343ab836db3041e501458e92cd3858ca42376a8e'
MANIFEST4 = 'https://electrobun-artifacts.blackboard.sh/cottontail/releases/0.7.3-canary.4/manifest.json'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fetch(url, path):
    subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error', url, '--output', str(path)], check=True)


def save():
    (OUT / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')


evidence = {
    'platform': platform.platform(),
    'machine': platform.machine(),
    'workflow_sha': os.environ.get('GITHUB_SHA'),
    'source_base': '4724d357b64cc9fe0da87c656d2b4cdaae68f740',
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'package_manager': subprocess.check_output(['bun', '--version'], text=True).strip(),
    'frozen_sha256': {},
    'results': [],
    'order': ['canary.3', 'canary.4'],
    'repetitions': 1,
}
save()
assert platform.machine() == 'aarch64', platform.machine()
assert evidence['node'] == 'v24.18.0'
assert evidence['package_manager'] == '1.3.10'
for rel, expected in FROZEN.items():
    actual = sha(SNAPSHOT / rel)
    assert actual == expected, (rel, expected, actual)
    evidence['frozen_sha256'][str(SNAPSHOT / rel)] = actual
for rel in ['scripts/run-upstream-tests.js', 'scripts/pin-runtime-bundle.js', 'tests/upstream-command-adapter.zig']:
    evidence['frozen_sha256'][rel] = sha(rel)
status = json.loads((SNAPSHOT / 'status.json').read_text())['tests'][TEST]
assert status['status'] == 'enabled' and status['serial'] is True
assert status['env'] == {'COTTONTAIL_TEST_TIMEOUT_SCALE': '8'}
assert status['timeoutMs'] == 600000
evidence['status_entry'] = status
evidence['adapter_sha256'] = sha('/tmp/cottontail-express-command')
save()

archive3 = next(Path('/tmp/cottontail-express-canary3').rglob('*.tar.gz'))
assert sha(archive3) == ARCHIVE3_HASH
assert next(archive3.parent.glob('*.sha256')).read_text().split()[0] == ARCHIVE3_HASH
shutil.copy2(archive3, OUT / archive3.name)
shutil.copy2(next(archive3.parent.glob('*.sha256')), OUT)
manifest_path = OUT / 'canary4-public-manifest.json'
fetch(MANIFEST4, manifest_path)
manifest = json.loads(manifest_path.read_text())
assert manifest['version'] == '0.7.3-canary.4'
assert manifest['revision'] == '4724d357b64cc9fe0da87c656d2b4cdaae68f740'
archive_info = manifest['platforms']['linux-arm64']['archive']
assert archive_info['sha256'] == ARCHIVE4_HASH
archive4 = OUT / 'cottontail-v0.7.3-canary.4-linux-arm64.tar.gz'
fetch(archive_info['url'], archive4)
assert sha(archive4) == ARCHIVE4_HASH
assert archive4.stat().st_size == archive_info['size']
evidence['archives'] = {
    'canary.3': {
        'source': 'GitHub Actions immutable CI artifact; never publicly published',
        'run': 39615900708,
        'artifact_id': 12353812197,
        'artifact_name': 'cottontail-release-linux-arm64',
        'revision': '1d6906cd1d9aa976f08de27035eb1453b7e41a4a',
        'archive_sha256': ARCHIVE3_HASH,
        'bytes': archive3.stat().st_size,
    },
    'canary.4': {
        'source': MANIFEST4,
        'revision': manifest['revision'],
        'archive': archive_info,
    },
}
save()

for label, archive in [('canary.3', archive3), ('canary.4', archive4)]:
    extracted = Path('/tmp') / ('cottontail-express-' + label)
    extracted.mkdir()
    subprocess.run(['tar', '-xzf', str(archive), '-C', str(extracted)], check=True)
    binary = next(extracted.glob('*/bin/cottontail')).resolve()
    subprocess.run(['file', str(binary)], check=True)
    subprocess.run(['ldd', str(binary)], check=True)
    report = OUT / (label + '-report')
    command = [
        '/usr/bin/time', '-v', '-o', str(OUT / (label + '.time.txt')),
        'node', 'scripts/run-upstream-tests.js', 'bun',
        '--binary', str(binary),
        '--command-adapter', '/tmp/cottontail-express-command',
        '--package-manager', str(Path(shutil.which('bun')).resolve()),
        '--test', TEST, '--jobs', '1', '--no-serial-retry',
        '--report-dir', str(report),
    ]
    started = time.monotonic()
    print(f'BEGIN {label}: {json.dumps(command)}', flush=True)
    with (OUT / (label + '.stdout')).open('w') as stdout, (OUT / (label + '.stderr')).open('w') as stderr:
        # The existing runner owns the original 600000 ms fixture deadline and
        # process containment; this driver neither retries nor overrides it.
        result = subprocess.run(command, stdout=stdout, stderr=stderr)
    item = {
        'label': label,
        'command': command,
        'exit_code': result.returncode,
        'elapsed_seconds': time.monotonic() - started,
        'binary_sha256': sha(binary),
        'report_dir': str(report),
        'environment': {k: os.environ.get(k) for k in ['CI', 'GITHUB_ACTIONS', 'RUNNER_ARCH', 'RUNNER_OS']},
    }
    evidence['results'].append(item)
    save()
    print(f'END {label}: {json.dumps(item)}', flush=True)
    print((OUT / (label + '.stdout')).read_text(), flush=True)
    print((OUT / (label + '.stderr')).read_text(), file=sys.stderr, flush=True)
    # Verify the frozen test, helper, config and dependency lock survived each run.
    for rel, expected in FROZEN.items():
        assert sha(SNAPSHOT / rel) == expected, rel

sys.exit(1 if any(item['exit_code'] != 0 for item in evidence['results']) else 0)
