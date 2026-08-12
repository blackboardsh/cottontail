import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { releaseTargetArgs } from './release-target.js';

const workflowPath = new URL('../.github/workflows/build-release.yml', import.meta.url);
const workflow = readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');

function step(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing release workflow step: ${name}`);
  const end = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

test('Linux releases enforce the GLIBC 2.38 public ABI ceiling', () => {
  const validation = step('Validate Linux glibc ABI');
  assert.match(validation, /if: matrix\.os == 'linux'/);
  assert.match(
    validation,
    /run: node scripts\/verify-linux-glibc\.js zig-out\/bin\/cottontail 2\.38/,
  );

  const tagValidation = step('Validate release tag');
  assert.match(tagValidation, /scripts\/verify-linux-glibc\.test\.js/);
  assert.match(tagValidation, /scripts\/build-release-workflow\.test\.js/);
});

test('the Windows console test builds the same target as the Windows release', () => {
  // Zig ignores a build script's default_target once any of -Dtarget/-Dcpu/
  // -Dofmt/-Ddynamic-linker is passed, so a step carrying only -Dcpu=baseline
  // silently resolves "native" and compiles the MSVC release against mingw
  // headers. Every Windows step must therefore name its target outright.
  const consoleTest = step('Test Unicode output in a legacy Windows console');
  assert.match(consoleTest, /if: matrix\.os == 'windows'/);
  for (const argument of releaseTargetArgs('win32')) {
    assert.ok(
      consoleTest.includes(`${argument} `) || consoleTest.includes(`${argument}\n`),
      `the Windows console test must pass ${argument}`,
    );
  }

  // The console test's Zig install step writes an unrestricted
  // cottontail.exe into zig-out/bin. It must run before build-release.js so
  // it cannot clobber the export-restricted release binary staged there.
  assert.ok(
    workflow.indexOf('- name: Test Unicode output in a legacy Windows console') <
      workflow.indexOf('- name: Build and strip release binary'),
    'the Windows console test must run before the release build',
  );
});

test('Windows releases exercise the Hutch private file runner', () => {
  const privateFileTest = step('Test Hutch private file runner on Windows');
  assert.match(privateFileTest, /if: matrix\.os == 'windows'/);
  assert.match(
    privateFileTest,
    /node scripts\/test-hutch-private-file-release\.js \.\\zig-out\\bin\\cottontail\.exe/,
  );
  assert.doesNotMatch(privateFileTest, /hutch-shell-cli\.test\.ts/);
  assert.match(privateFileTest, /Windows Hutch private file tests failed/);
  assert.ok(
    workflow.indexOf('- name: Build and strip release binary') <
      workflow.indexOf('- name: Test Hutch private file runner on Windows'),
    'the Hutch private file tests must exercise the release binary',
  );
});

test('packaged Linux releases prove the pinned ICU fallback without system ICU', () => {
  const smoke = step('Smoke test packaged pinned ICU fallback');
  assert.match(smoke, /if: matrix\.os == 'linux'/);
  assert.match(smoke, /FROM ubuntu:24\.04/);
  const installCommand = smoke.match(/apt-get install[\s\S]*?>\/dev\/null/)?.[0];
  assert.ok(installCommand, 'minimal ICU image must install its runtime dependencies');
  assert.doesNotMatch(installCommand, /\blibicu[^\s]*/);
  assert.match(smoke, /--network none/);
  assert.match(smoke, /--read-only/);
  assert.match(smoke, /--env HOME=\/unwritable/);
  assert.match(smoke, /--env XDG_DATA_HOME=\/unwritable/);
  assert.match(smoke, /ldconfig -p \| grep -q "libicu"/);
  assert.match(smoke, /\/app\/share\/cottontail\/icu\/70\.1\/icudt70l\.dat/);
  assert.match(smoke, /\/app\/share\/cottontail\/icu\/70\.1\/LICENSE/);
  // The entry script runs from /work rather than the filesystem root: a
  // root-level entry path is the one input where the module resolver's
  // PathName.init computes an empty dir string, which panics DirInfo
  // resolution inside this container. Copying into the workdir keeps the
  // image ICU-free (the part that exercises the fallback) without leaning
  // on that resolver edge case.
  assert.match(smoke, /cp \/icu-fallback-smoke\.js \/work\/icu-fallback-smoke\.js/);
  assert.match(
    smoke,
    /test "\$\(\/app\/bin\/cottontail \/work\/icu-fallback-smoke\.js\)" = "icu fallback passed"/,
  );
});
