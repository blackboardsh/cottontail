#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWindowsJobChild, terminateWindowsJobChild } from './windows-job-child.js';

// This is a deliberately narrow native gate, not the full test-js suite. No
// build, alternate runtime, or runtime-source overlay is allowed here.
export const nativeBoundaryFixtures = Object.freeze([
  'native-host-namespace-factory.mjs',
  'native-host-namespace.mjs',
  'node-worker-internal-loader.mjs',
  'node-dgram-peer-loss.mjs',
  'fd-watch-runtime-ownership.mjs',
  'node-dgram-lifecycle.mjs',
  'runtime-active-handles.mjs',
  'idle-runtime.test.ts',
  'bun-serve-idle-lifecycle.mjs',
  'runtime-bootstrap-startup.test.ts',
]);
export const nativeBoundaryTimeoutMs = 90_000;

export function nativeBoundaryPlan(root, platform = process.platform) {
  const binary = join(root, 'zig-out', 'bin', platform === 'win32' ? 'cottontail.exe' : 'cottontail');
  return {
    binary,
    jobLauncher: platform === 'win32' ? join(root, 'zig-out', 'bin', 'cottontail-bun-compat-job.exe') : null,
    tests: nativeBoundaryFixtures.map(name => ({
      name,
      // One explicit absolute test file avoids the Windows multi-file
      // aggregate's pre-existing zero-test result. This gate intentionally
      // selects only bytecode identity invalidation (19 tests filtered out).
      args: name === 'runtime-bootstrap-startup.test.ts'
        ? ['test', join(root, 'tests', 'js', name), '-t', 'compiled bytecode is embedded']
        : name.endsWith('.test.ts') ? ['test', join(root, 'tests', 'js', name)]
        : [join(root, 'tests', 'js', name)],
      timeoutMs: nativeBoundaryTimeoutMs,
    })),
  };
}

export function nativeBoundaryEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => {
    const name = key.toUpperCase();
    return name !== 'COTTONTAIL_RUNTIME_MODULES_DIR' &&
      !name.startsWith('COTTONTAIL_ELECTROBUN_') &&
      name !== 'ELECTROBUN_INSTALL_ROOT_NAME' && name !== 'ELECTROBUN_LAUNCHER_PID';
  }));
}

export function runNativeBoundaryTest(plan, fixture, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  return new Promise((resolveTest, rejectTest) => {
    const spawnOptions = {
      cwd: dirname(dirname(dirname(plan.binary))),
      env: nativeBoundaryEnvironment(), stdio: 'inherit', windowsHide: true,
      detached: platform !== 'win32',
    };
    const child = platform === 'win32'
      ? startWindowsJobChild(plan.binary, fixture.args, { jobLauncher: plan.jobLauncher, spawnOptions, spawnProcess })
      : spawnProcess(plan.binary, fixture.args, spawnOptions);
    let timedOut = false;
    let finished = false;
    let watchdog;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      if (error) rejectTest(error);
      else resolveTest();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Only the uniquely named Job or process group created above is owned.
      // The Windows launcher also kills/proves empty its Job on natural exit.
      if (platform === 'win32') {
        void terminateWindowsJobChild(child, { spawnProcess, timeoutMs: 5_000, watchdogMs: 6_000 })
          .catch(error => finish(error));
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') finish(error); }
      }
      watchdog = setTimeout(() => {
        child.unref();
        finish(new Error(`${fixture.name}: owned child did not close after timeout cleanup`));
      }, 7_000);
    }, fixture.timeoutMs);
    child.once('error', finish);
    child.once('close', (code, signal) => {
      if (timedOut) finish(new Error(`${fixture.name}: exceeded ${fixture.timeoutMs}ms`));
      else if (code !== 0) finish(new Error(`${fixture.name}: native release exited ${code} (${signal ?? 'no signal'})`));
      else finish();
    });
  });
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const plan = nativeBoundaryPlan(root);
  accessSync(plan.binary, constants.X_OK);
  // Installed by the existing pre-release Windows console build, never rebuilt
  // here: its install step would overwrite the export-restricted executable.
  if (plan.jobLauncher) accessSync(plan.jobLauncher, constants.X_OK);
  for (const fixture of plan.tests) {
    console.log(`Native release regression: ${fixture.name}`);
    await runNativeBoundaryTest(plan, fixture);
  }
  console.log(`Native release boundary regressions passed (${plan.tests.length} fixtures)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
