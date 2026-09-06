import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { releaseTargetArgs } from './release-target.js';

const workflowPath = new URL('../.github/workflows/build-release.yml', import.meta.url);
const workflow = readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
const buildZig = readFileSync(new URL('../build.zig', import.meta.url), 'utf8');
const secretsCapability = readFileSync(
  new URL('../src/stdlib/secrets/main.js', import.meta.url),
  'utf8',
);
const capabilityActivation = readFileSync(
  new URL('../tests/js/stdlib-capability-activation.ts', import.meta.url),
  'utf8',
);

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

test('every release activates every packaged standard-library capability', () => {
  const activation = step('Activate every packaged standard-library capability');
  assert.doesNotMatch(activation, /if: matrix\.os/);
  assert.match(
    activation,
    /\.\/zig-out\/bin\/cottontail tests\/js\/stdlib-capability-activation\.ts/,
  );
  assert.ok(
    workflow.indexOf('- name: Build and strip release binary') <
      workflow.indexOf('- name: Activate every packaged standard-library capability'),
    'capability activation must exercise the optimized release layout',
  );
  assert.match(capabilityActivation, /cottontail-stdlib["']\)/);
  assert.match(capabilityActivation, /capabilities\.json/);
  assert.match(capabilityActivation, /archive:\s*\["compression"\]/);
  assert.match(capabilityActivation, /test:\s*\["glob",\s*"shell",\s*"toml"\]/);
});

test('the build installs a generated runtime capability dependency manifest', () => {
  assert.match(buildZig, /scripts\/capability-manifest\.js/);
  assert.match(
    buildZig,
    /bin\/cottontail-stdlib\/capabilities\.json/,
  );
  assert.match(
    workflow,
    /node --test[^\n]*scripts\/capability-manifest\.test\.js/,
  );
});

test('every release exercises a core-only runtime without optional capabilities', () => {
  const isolation = step('Test core-only capability isolation');
  assert.doesNotMatch(isolation, /if: matrix\.os/);
  assert.match(isolation, /run: node scripts\/test-capability-isolation\.js/);
  assert.ok(
    workflow.indexOf('- name: Build and strip release binary') <
      workflow.indexOf('- name: Test core-only capability isolation'),
    'capability isolation must exercise the optimized release layout',
  );
});

test('Windows compression capability links and exercises Zstandard', () => {
  const compressionCapability = buildZig.match(
    /const compression_capability_module[\s\S]*?const websocket_capability_module/,
  )?.[0];
  assert.ok(compressionCapability, 'missing compression capability build configuration');
  assert.match(compressionCapability, /if \(target\.result\.os\.tag == \.windows\)/);
  assert.match(compressionCapability, /"zstd\.lib"/);
  assert.match(
    compressionCapability,
    /linker_allow_shlib_undefined = target\.result\.os\.tag != \.windows/,
  );

  const regressionTest = step('Test Windows Zstd capability and fetch decoding');
  assert.match(regressionTest, /if: matrix\.os == 'windows'/);
  assert.match(
    regressionTest,
    /cottontail\.exe tests\/js\/fetch-zstd-windows-regression\.ts/,
  );
  assert.ok(
    workflow.indexOf('- name: Build and strip release binary') <
      workflow.indexOf('- name: Test Windows Zstd capability and fetch decoding'),
    'the Zstd regression test must exercise the optimized release layout',
  );
});

test('Windows capabilities resolve the prefixed JSC bridge from the executable', () => {
  const windowsCapabilityFlags = buildZig.match(
    /const capability_c_flags:[\s\S]*?else\s*&\.\{ "-std=c11", "-fPIC" \};/,
  )?.[0];
  assert.ok(windowsCapabilityFlags, 'missing shared capability C flags');
  assert.doesNotMatch(windowsCapabilityFlags, /-DJS_NO_EXPORT=1/);
  assert.match(buildZig, /"src\/stdlib\/jsc_bridge\.c"/);
  assert.match(buildZig, /"dlltool"/);
  assert.match(buildZig, /"cottontail\.exe"/);
  assert.match(buildZig, /command\.addOutputFileArg\("cottontail-jsc-bridge\.lib"\)/);
  assert.match(buildZig, /capability\.root_module\.addObjectFile\(import_library\)/);
  assert.ok(
    secretsCapability.includes('replaceAll("\\\\", "/")'),
    'the Windows secrets loader must normalize each individual path separator',
  );
  assert.ok(!secretsCapability.includes('replaceAll("\\\\\\\\", "/")'));
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
