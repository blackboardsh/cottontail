import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { releaseTargetArgs } from './release-target.js';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import {
  nativeBoundaryEnvironment, nativeBoundaryFixtures, nativeBoundaryPlan,
  nativeBoundaryTimeoutMs, runNativeBoundaryTest,
} from './test-native-boundary-release.js';

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

test('Windows releases require native Job cleanup tests after building the supervisor', () => {
  const name = 'Test native Windows Job process cleanup';
  const gate = step(name);
  assert.match(gate, /if: matrix\.os == 'windows'/);
  assert.match(gate, /COTTONTAIL_REQUIRE_WINDOWS_JOB_LAUNCHER: '1'/);
  assert.match(gate, /COTTONTAIL_TEST_WINDOWS_JOB_LAUNCHER: zig-out\/bin\/cottontail-bun-compat-job\.exe/);
  assert.match(gate, /node --test scripts\/windows-job-child\.test\.js/);
  assert.match(gate, /if \(\$LASTEXITCODE -ne 0\) \{ throw/);
  assert.ok(workflow.indexOf('- name: Test Unicode output in a legacy Windows console') < workflow.indexOf(`- name: ${name}`));
  assert.ok(workflow.indexOf(`- name: ${name}`) < workflow.indexOf('- name: Package release'));
});

test('all four releases gate native namespace, worker loader, and socket ownership after final validation', () => {
  for (const platform of ['macos-arm64', 'linux-x64', 'linux-arm64', 'windows-x64']) {
    assert.ok(workflow.includes(`platform: ${platform}`));
  }
  for (const suffix of ['', ' on Windows']) {
    const name = `Test native namespace, workers, and socket ownership${suffix}`;
    const gate = step(name);
    assert.match(gate, /timeout-minutes: 10/);
    assert.match(gate, /node scripts\/test-native-boundary-release\.js/);
    assert.match(gate, suffix ? /if: matrix\.os == 'windows'/ : /if: matrix\.os != 'windows'/);
    if (suffix) {
      assert.match(gate, /shell: pwsh/);
      assert.match(gate, /if \(\$LASTEXITCODE -ne 0\) \{ throw/);
    }
    assert.ok(workflow.indexOf('- name: Validate stripped release binary') < workflow.indexOf(`- name: ${name}`));
    assert.ok(workflow.indexOf(`- name: ${name}`) < workflow.indexOf('- name: Package release'));
  }
});

test('native boundary plan runs exact release binaries directly with bounded fixture arguments', () => {
  assert.deepEqual(nativeBoundaryFixtures, [
    'native-host-namespace-factory.mjs', 'native-host-namespace.mjs',
    'node-worker-internal-loader.mjs', 'node-dgram-peer-loss.mjs',
    'fd-watch-runtime-ownership.mjs', 'node-dgram-lifecycle.mjs',
    'runtime-active-handles.mjs', 'idle-runtime.test.ts', 'bun-serve-idle-lifecycle.mjs',
    'runtime-bootstrap-startup.test.ts',
  ]);
  for (const platform of ['darwin', 'linux', 'win32']) {
    const plan = nativeBoundaryPlan('/fixture-root', platform);
    assert.equal(plan.binary, join('/fixture-root', 'zig-out/bin', platform === 'win32' ? 'cottontail.exe' : 'cottontail'));
    assert.equal(Boolean(plan.jobLauncher), platform === 'win32');
    assert.deepEqual(plan.tests.map(test => test.args), nativeBoundaryFixtures.map(name => name === 'runtime-bootstrap-startup.test.ts'
      ? ['test', join('/fixture-root', 'tests/js', name), '-t', 'compiled bytecode is embedded']
      : name.endsWith('.test.ts') ? ['test', join('/fixture-root', 'tests/js', name)]
      : [join('/fixture-root', 'tests/js', name)]));
    assert.equal(plan.tests.length, 10);
    assert.ok(plan.tests.every(test => test.timeoutMs === 90_000));
  }
  assert.equal(nativeBoundaryTimeoutMs, 90_000);
  const runner = readFileSync(new URL('./test-native-boundary-release.js', import.meta.url), 'utf8');
  assert.doesNotMatch(runner, /scripts\/zig\.js|build-release\.js|\bbun\s+test/);
  assert.match(runner, /startWindowsJobChild/);
  assert.match(runner, /terminateWindowsJobChild/);
});

test('bytecode release gate preserves the same-path identity assertions and existing test budget', () => {
  const source = readFileSync(new URL('../tests/js/runtime-bootstrap-startup.test.ts', import.meta.url), 'utf8');
  assert.match(source, /const compiledBytecodeTimeoutMs = isWindows \? 30_000 : 5_000/);
  assert.match(source, /withOwnedWindowsImageRetry\(\(\) => writeFileSync\(executable, bytes\)\)/);
  assert.match(source, /cmd: \[executable\]/);
  assert.match(source, /expect\(String\(initial\.stdout\)\.trim\(\)\)\.toBe\("bytecode-one"\)/);
  assert.match(source, /expect\(String\(invalidated\.stdout\)\.trim\(\)\)\.toBe\("bytecode-two"\)/);
  assert.match(source, /\{ timeout: compiledBytecodeTimeoutMs \}/);
});

test('native release gate removes source and Desktop runtime overlays', () => {
  assert.deepEqual(nativeBoundaryEnvironment({
    PATH: 'tools', COTTONTAIL_RUNTIME_MODULES_DIR: 'source',
    COTTONTAIL_ELECTROBUN_BOOTSTRAP: 'desktop', ELECTROBUN_INSTALL_ROOT_NAME: 'app',
    ELECTROBUN_LAUNCHER_PID: '123', Keep: 'value',
  }), { PATH: 'tools', Keep: 'value' });
});

test('native release gate propagates failures and cannot fall back to Node or Bun', async () => {
  const plan = nativeBoundaryPlan('/fixture-root', 'linux');
  for (const code of [0, 9]) {
    const calls = [];
    const run = runNativeBoundaryTest(plan, plan.tests[0], {
      platform: 'linux',
      spawnProcess(command, args, options) {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', code, null));
        return child;
      },
    });
    if (code) await assert.rejects(run, /native release exited 9/);
    else await run;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, plan.binary);
    assert.deepEqual(calls[0].args, plan.tests[0].args);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, 'inherit');
  }
});

test('Windows native gate owns a unique Job and preserves the full failure status', async () => {
  const plan = nativeBoundaryPlan('/fixture-root', 'win32');
  const calls = [];
  await assert.rejects(runNativeBoundaryTest(plan, plan.tests[0], {
    platform: 'win32',
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0xc0000409, null));
      return child;
    },
  }), /native release exited 3221226505/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, plan.jobLauncher);
  assert.equal(calls[0].args[0], 'run');
  assert.match(calls[0].args[1], /^Local\\CottontailBunCompat-[0-9a-f-]+$/);
  assert.equal(calls[0].args[2], String(process.pid));
  assert.equal(calls[0].args[3], plan.binary);
  assert.deepEqual(calls[0].args.slice(4), plan.tests[0].args);
  assert.equal(calls[0].options.detached, false);
  assert.equal(calls[0].options.windowsHide, true);
});

test('Windows native timeout terminates only the Job started by that fixture', async () => {
  const plan = nativeBoundaryPlan('/fixture-root', 'win32');
  const calls = [];
  let launcher;
  await assert.rejects(runNativeBoundaryTest(plan, { ...plan.tests[0], timeoutMs: 1 }, {
    platform: 'win32',
    spawnProcess(command, args) {
      calls.push({ command, args });
      const child = new EventEmitter();
      if (args[0] === 'run') launcher = child;
      else queueMicrotask(() => {
        child.emit('close', 0, null);
        launcher.emit('close', 1, null);
      });
      return child;
    },
  }), /exceeded 1ms/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, plan.jobLauncher);
  assert.deepEqual(calls[1].args, ['terminate', calls[0].args[1], '5000']);
});

test('release TLS tests cover default trust on clean Macs and explicit CA overrides', () => {
  const localTrust = step('Test default TLS certificate trust');
  assert.doesNotMatch(localTrust, /if: matrix\.os/);
  assert.match(localTrust, /node --test scripts\/tls-ca-portability\.test\.js/);
  assert.doesNotMatch(localTrust, /COTTONTAIL_TLS_PUBLIC_URL/);
  const macosTrust = step('Test macOS certificate trust without Homebrew');
  assert.match(macosTrust, /if: matrix\.os == 'macos'/);
  assert.match(macosTrust, /COTTONTAIL_TLS_PUBLIC_URL: https:\/\/electrobun-artifacts\.blackboard\.sh\/cottontail\/channels\/canary\.json/);
  assert.match(macosTrust, /node --test --test-name-pattern="macOS public HTTPS" scripts\/tls-ca-portability\.test\.js/);
  for (const name of ['Test default TLS certificate trust', 'Test macOS certificate trust without Homebrew']) {
    assert.ok(
      workflow.indexOf('- name: Build and strip release binary') < workflow.indexOf(`- name: ${name}`),
      'TLS regression tests must exercise the stripped release binary',
    );
  }
});

test('releases check native dependencies and compressed HTTP without Homebrew', () => {
  const dependencies = step('Validate macOS native library portability');
  assert.match(dependencies, /if: matrix\.os == 'macos'/);
  assert.match(dependencies, /node scripts\/verify-macos-native-deps\.js/);
  const compression = step('Test bundled HTTP compression');
  assert.doesNotMatch(compression, /if: matrix\.os/);
  assert.match(compression, /node --test scripts\/compression-portability\.test\.js/);
  for (const name of ['Validate macOS native library portability', 'Test bundled HTTP compression']) {
    assert.ok(workflow.indexOf('- name: Build and strip release binary') < workflow.indexOf(`- name: ${name}`));
  }
});

test('every release checks native stdio offsets after building and before packaging', () => {
  const stdio = step('Test native stdio redirection');
  assert.doesNotMatch(stdio, /^\s+if:/m, 'stdio regression must run on all four native release targets');
  assert.match(stdio, /run: node --test scripts\/stdio-redirection\.test\.js/);
  const index = workflow.indexOf('- name: Test native stdio redirection');
  assert.ok(workflow.indexOf('- name: Build and strip release binary') < index);
  assert.ok(index < workflow.indexOf('- name: Package release'));
});

test('the JS suite forwards its selected runtime to native stdio regressions', () => {
  const runner = readFileSync(new URL('./test-js.js', import.meta.url), 'utf8');
  const stdio = runner.match(/name: 'native-stdio-redirection',[\s\S]*?\n    },/)?.[0];
  assert.ok(stdio, 'missing native stdio regression in the JS suite');
  assert.match(stdio, /env: \{ COTTONTAIL_TEST_BINARY: binaryPath \}/);
});

test('every release and the JS suite run externally bounded delayed worker termination regressions', () => {
  const termination = step('Test delayed runaway worker termination');
  assert.doesNotMatch(termination, /^\s+if:/m, 'worker regression must run on all four native release targets');
  assert.match(termination, /run: node --test scripts\/worker-delayed-termination\.test\.js/);
  const index = workflow.indexOf('- name: Test delayed runaway worker termination');
  assert.ok(workflow.indexOf('- name: Build and strip release binary') < index);
  assert.ok(index < workflow.indexOf('- name: Package release'));
  const runner = readFileSync(new URL('./test-js.js', import.meta.url), 'utf8');
  const worker = runner.match(/name: 'worker-delayed-termination',[\s\S]*?\n    },/)?.[0];
  assert.ok(worker, 'missing bounded delayed worker regression in the JS suite');
  assert.match(worker, /env: \{ COTTONTAIL_TEST_BINARY: binaryPath \}/);
});

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
