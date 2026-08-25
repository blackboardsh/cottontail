import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { resolveBunStatusPlatform } from './bun-status-platform.js';

const workflowPath = new URL('../.github/workflows/bun-compat.yml', import.meta.url);
const buildPath = new URL('../build.zig', import.meta.url);
const commandAdapterPath = new URL('../tests/upstream-command-adapter.zig', import.meta.url);
const windowsJobLauncherPath = new URL('../tests/windows-job-launcher.zig', import.meta.url);
const statusPath = new URL('../compat/upstream/bun/v1.3.10/status.json', import.meta.url);
const expectBundledPath = new URL(
  '../compat/upstream/bun/v1.3.10/test/bundler/expectBundled.ts',
  import.meta.url,
);
const bunTestAdapterPath = new URL('../src/runtime_modules/node/test.js', import.meta.url);
// Windows runners may check the repository out with CRLF line endings;
// normalize so the contract regexes match regardless of checkout config.
const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const workflow = readText(workflowPath);
const build = readText(buildPath);
const commandAdapter = readText(commandAdapterPath);
const windowsJobLauncher = readText(windowsJobLauncherPath);
const status = JSON.parse(readText(statusPath));
const expectBundled = readText(expectBundledPath);
const bunTestAdapter = readText(bunTestAdapterPath);

function workflowTriggers(source) {
  const end = source.indexOf('\npermissions:');
  assert.notEqual(end, -1, 'workflow must declare permissions after its triggers');
  return source.slice(0, end);
}

function workflowStep(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = workflow.indexOf('\n      - name:', start + marker.length);
  return {
    source: workflow.slice(start, end === -1 ? workflow.length : end),
    start,
  };
}

function countFromList(output, label) {
  const match = output.match(new RegExp(`^  ${label}: (\\d+)`, 'm'));
  assert.ok(match, `missing ${label} count in upstream runner output`);
  return Number(match[1]);
}

test('runs only for compat branches and manual dispatch', () => {
  const triggers = workflowTriggers(workflow);
  assert.match(triggers, /^on:\n  push:\n    branches:\n      - "compat\/\*\*"\n  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(triggers, /\btags:|\bpull_request:|\bschedule:/);
});

test('cross-platform default-shell steps avoid POSIX line continuations', () => {
  const steps = workflow.split(/^      - name: /m).slice(1);
  const contractStep = steps.find((step) =>
    step.startsWith('Validate compatibility runner contracts\n'),
  );
  assert.ok(contractStep, 'missing compatibility runner contract step');
  assert.match(contractStep, /^Validate compatibility runner contracts\n        run: >-/);

  for (const step of steps) {
    const name = step.slice(0, step.indexOf('\n'));
    const hasRun = /^        run:/m.test(step);
    const hasExplicitShell = /^        shell:/m.test(step);
    const isPlatformRestricted = /^        if: matrix\.os ==/m.test(step);
    if (hasRun && !hasExplicitShell && !isPlatformRestricted) {
      assert.doesNotMatch(
        step,
        /\\[ \t]*$/m,
        `${name} must be valid in both PowerShell and POSIX shells`,
      );
    }
  }
});

test('Windows runner contracts wait for the Cottontail-owned native job launcher', () => {
  const earlyContracts = workflowStep('Validate compatibility runner contracts');
  const nonWindowsRunner = workflowStep('Validate upstream runner contracts');
  const buildCottontail = workflowStep('Build Cottontail');
  const windowsRunner = workflowStep('Validate upstream runner contracts on Windows');

  assert.doesNotMatch(earlyContracts.source, /tests\/upstream-runner\.test\.mjs/);
  assert.match(nonWindowsRunner.source, /if: matrix\.os != 'windows'/);
  assert.match(nonWindowsRunner.source, /run: node --test tests\/upstream-runner\.test\.mjs/);
  assert.ok(
    nonWindowsRunner.start < buildCottontail.start,
    'non-Windows runner contracts should remain an early validation gate',
  );

  assert.match(windowsRunner.source, /if: matrix\.os == 'windows'/);
  assert.match(
    windowsRunner.source,
    /COTTONTAIL_UPSTREAM_JOB_LAUNCHER: zig-out\/bin\/cottontail-bun-compat-job\.exe/,
  );
  assert.match(windowsRunner.source, /run: node --test tests\/upstream-runner\.test\.mjs/);
  assert.ok(
    buildCottontail.start < windowsRunner.start,
    'Windows runner contracts must wait until Cottontail builds the native launcher',
  );
  assert.equal(
    workflow.match(/run: node --test tests\/upstream-runner\.test\.mjs/g)?.length,
    2,
    'the runner contracts must execute exactly once per matrix leg',
  );
});

test('runs the strict complete Cottontail-owned Bun tier without publishing', () => {
  for (const platform of ['macos-arm64', 'linux-x64', 'linux-arm64', 'windows-x64']) {
    assert.match(workflow, new RegExp(`platform: ${platform}`));
  }
  assert.match(workflow, /runner: macos-26/);
  assert.match(workflow, /runner: ubuntu-24\.04/);
  assert.match(workflow, /runner: ubuntu-24\.04-arm/);
  assert.match(workflow, /runner: windows-2025/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(
    workflow,
    /node scripts\/zig\.js build -Doptimize=ReleaseFast -Dcpu=baseline/,
  );
  assert.match(
    workflow,
    /node scripts\/zig\.js build -Doptimize=ReleaseFast -Dtarget=x86_64-windows-msvc -Dcpu=baseline/,
  );
  assert.match(workflow, /run: node scripts\/zig\.js build test/);
  assert.match(workflow, /run: node scripts\/test-js\.js/);
  assert.match(workflow, /run: node scripts\/check-bun-status\.js/);
  for (const contract of [
    'scripts/bun-status-platform.test.js',
    'tests/upstream-status-accounting.test.mjs',
    'tests/upstream-runner.test.mjs',
  ]) {
    assert.ok(workflow.includes(contract), `compatibility CI must run ${contract}`);
  }
  assert.match(
    workflow,
    /node scripts\/run-upstream-tests\.js bun --command-adapter "\$command_adapter" --package-manager "\$package_manager" "\$\{job_launcher_args\[@\]\}"/,
  );
  assert.doesNotMatch(workflow, /continue-on-error:|upload-release-r2|publish|secrets\./i);

  const cottontailOutOfScope = Object.values(status.tests ?? {}).filter(
    (entry) => entry.status === 'skip' || entry.status === 'disabled',
  );

  const output = execFileSync(
    process.execPath,
    ['scripts/run-upstream-tests.js', 'bun', '--list'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  const discovered = countFromList(output, 'discovered runnable files');
  const enabled = countFromList(output, 'enabled');
  const expectedFailures = countFromList(output, 'expected-failure');
  const disabled = countFromList(output, 'disabled');
  const notEnabled = countFromList(output, 'not-enabled');

  assert.equal(disabled, cottontailOutOfScope.length);
  assert.equal(notEnabled, 0);
  assert.equal(discovered - disabled, enabled + expectedFailures);
});

test('uses the Cottontail adapter and external Bun only for package fixtures', () => {
  assert.match(commandAdapter, /COTTONTAIL_BINARY/);
  assert.match(commandAdapter, /COTTONTAIL_UPSTREAM_PACKAGE_MANAGER/);
  assert.match(commandAdapter, /isPackageManagerCommand\(args\[1\]\)/);
  assert.match(commandAdapter, /"install"/);
  assert.match(commandAdapter, /"x"/);
  assert.match(windowsJobLauncher, /Local\\\\CottontailBunCompat-/);
  assert.match(build, /\.name = "cottontail-upstream-command"/);
  assert.match(build, /tests\/upstream-command-adapter\.zig/);
  assert.match(build, /\.name = "cottontail-bun-compat-job"/);
  assert.match(build, /tests\/windows-job-launcher\.zig/);
  assert.doesNotMatch(workflow, /Hutch|hutch/);
  assert.match(workflow, /COTTONTAIL_TEST_WINDOWS_JOB_LAUNCHER: zig-out\/bin\/cottontail-bun-compat-job\.exe/);
  assert.match(workflow, /run: node --test scripts\/windows-job-child\.test\.js/);
  assert.equal(
    workflow.match(/command_adapter="\$\(node -e/g)?.length,
    2,
    'both suite steps must select the Cottontail-owned adapter',
  );
  assert.equal(
    workflow.match(/package_manager="\$\(bun -e 'console\.log\(process\.execPath\)'\)"/g)?.length,
    2,
    'both suite steps must select the workflow-pinned Bun executable',
  );
  assert.equal(
    workflow.match(/job_launcher_args=\(\)[\s\S]*?if \[\[ "\$\{\{ matrix\.os \}\}" == "windows" \]\]; then[\s\S]*?job_launcher_args=\(--job-launcher zig-out\/bin\/cottontail-bun-compat-job\.exe\)[\s\S]*?fi/g)?.length,
    2,
    'the launcher argument must be present on Windows and omitted elsewhere',
  );
  const suiteCommands = workflow
    .split('\n')
    .filter(line => line.includes('node scripts/run-upstream-tests.js') && !line.includes('--list'));
  assert.equal(suiteCommands.length, 4, 'expected the complete tier and three focused suite commands');
  assert.ok(
    suiteCommands.every(line =>
      line.includes('--command-adapter "$command_adapter"') &&
      line.includes('--package-manager "$package_manager"') &&
      line.includes('"${job_launcher_args[@]}"')
    ),
    'every suite command must carry the adapter, external manager, and conditional Windows launcher',
  );
  assert.match(
    workflow,
    /--test test\/bundler\/bundler_defer\.test\.ts --case '\^\\\$file\$' --expect-pass --jobs 1/,
  );
  assert.match(
    workflow,
    /--test test\/bundler\/bundler_npm\.test\.ts --case '\^npm\/ReactSSR\$' --expect-pass --jobs 1/,
  );
  assert.match(
    workflow,
    /--test test\/bundler\/bundler_npm\.test\.ts --case '\^npm\/LodashES\$' --expect-pass --jobs 1/,
  );
});

test('generated bundler deadlines use the owned timeout scale exactly once', () => {
  assert.doesNotMatch(
    expectBundled,
    /COTTONTAIL_TEST_TIMEOUT_SCALE/,
    'the copied generated-bundler harness must not apply the owned adapter scale a second time',
  );
  assert.match(
    bunTestAdapter,
    /const configuredTimeoutScale = Number\([\s\S]*COTTONTAIL_TEST_TIMEOUT_SCALE[\s\S]*return duration \* timeoutScale;/,
  );

  const htmlServer = status.tests['test/bundler/bundler_html_server.test.ts'];
  assert.equal(htmlServer.status, 'enabled');
  assert.deepEqual(htmlServer.env, { COTTONTAIL_TEST_TIMEOUT_SCALE: '2' });
  assert.equal(htmlServer.timeoutMs, 60_000);
});

test('platform status overrides preserve Mac and Windows while retaining Linux evidence', () => {
  const mac = resolveBunStatusPlatform(status, 'darwin', 'arm64');
  const windows = resolveBunStatusPlatform(status, 'win32', 'x64');
  const linuxX64 = resolveBunStatusPlatform(status, 'linux', 'x64');
  const linuxArm64 = resolveBunStatusPlatform(status, 'linux', 'arm64');
  const exclusionCases = (resolved) => Object.values(resolved.tests).reduce(
    (count, entry) => count + (entry.testNameExclusion?.testNames?.length ?? 0),
    0,
  );

  assert.equal(exclusionCases(mac), 29);
  assert.equal(exclusionCases(windows), 29);
  assert.equal(exclusionCases(linuxX64), 37);
  assert.equal(exclusionCases(linuxArm64), 43);

  const symbolsPath = 'test/js/bun/symbols.test.ts';
  for (const resolved of [linuxX64, linuxArm64]) {
    assert.equal(resolved.tests[symbolsPath].testNameExclusion, undefined);
    assert.equal(resolved.tests[symbolsPath].args, undefined);
  }

  const adoptedFdPath = 'test/js/bun/net/socket.test.ts';
  assert.equal(mac.tests[adoptedFdPath].testNameExclusion, undefined);
  assert.equal(windows.tests[adoptedFdPath].testNameExclusion, undefined);
  assert.equal(linuxX64.tests[adoptedFdPath].testNameExclusion, undefined);
  assert.equal(linuxArm64.tests[adoptedFdPath].testNameExclusion?.testNames.length, 1);
});
