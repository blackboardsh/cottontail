#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import { join } from 'path';

const rootDir = process.cwd();
const binaryPath = join(
  rootDir,
  'zig-out',
  'bin',
  process.platform === 'win32' ? 'cottontail.exe' : 'cottontail'
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runCase(testCase) {
  const result = spawnSync(binaryPath, [testCase.scriptPath, ...(testCase.args ?? [])], {
    cwd: rootDir,
    env: {
      ...process.env,
      ...(testCase.env ?? {}),
    },
    encoding: 'utf8',
  });

  if (result.error) {
    fail(`Failed to execute "${testCase.name}": ${result.error.message}`);
  }

  const exitCode = result.status ?? 1;
  if (exitCode !== testCase.expectExitCode) {
    fail(
      [
        `Test "${testCase.name}" exited with ${exitCode}, expected ${testCase.expectExitCode}.`,
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  for (const expected of testCase.stdoutIncludes ?? []) {
    if (!result.stdout.includes(expected)) {
      fail(`Test "${testCase.name}" stdout did not include: ${expected}`);
    }
  }

  for (const expected of testCase.stderrIncludes ?? []) {
    if (!result.stderr.includes(expected)) {
      fail(`Test "${testCase.name}" stderr did not include: ${expected}`);
    }
  }

  console.log(`ok ${testCase.name}`);
}

if (!existsSync(binaryPath)) {
  fail(`Built cottontail binary not found at ${binaryPath}. Run "bun run build" first.`);
}

const tempDir = mkdtempSync(join(os.tmpdir(), 'cottontail-js-tests-'));
const tempFilePath = join(tempDir, 'host-api-output.txt');

try {
  const tests = [
    {
      name: 'smoke',
      scriptPath: join(rootDir, 'test.js'),
      expectExitCode: 0,
      stdoutIncludes: ['all js smoke tests passed'],
    },
    {
      name: 'modules',
      scriptPath: join(rootDir, 'tests', 'js', 'module-main.js'),
      expectExitCode: 0,
      stdoutIncludes: ['module imports passed'],
    },
    {
      name: 'async',
      scriptPath: join(rootDir, 'tests', 'js', 'async.js'),
      expectExitCode: 0,
      stdoutIncludes: ['async passed'],
    },
    {
      name: 'host-api',
      scriptPath: join(rootDir, 'tests', 'js', 'host-api.js'),
      args: ['alpha', 'beta'],
      env: {
        COTTONTAIL_TEST_ENV: 'present',
        COTTONTAIL_EXPECT_CWD: rootDir,
        COTTONTAIL_TMP_FILE: tempFilePath,
      },
      expectExitCode: 0,
      stdoutIncludes: ['host api passed'],
    },
    {
      name: 'bun-apis',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-apis.js'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['bun apis passed'],
    },
    {
      name: 'bun-global',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-global.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['bun global passed'],
    },
    {
      name: 'bun-serve-spawn-ts',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-serve-spawn.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['bun serve spawn ts passed'],
    },
    {
      name: 'bun-serve-detached',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-serve-detached.ts'),
      env: {
        COTTONTAIL_SERVE_DETACHED_OUTPUT: join(tempDir, 'serve-detached.txt'),
      },
      expectExitCode: 0,
      stdoutIncludes: ['bun serve detached passed'],
    },
    {
      name: 'await-then-serve',
      scriptPath: join(rootDir, 'tests', 'js', 'await-then-serve.ts'),
      env: {
        COTTONTAIL_SERVE_DETACHED_OUTPUT: join(tempDir, 'await-serve.txt'),
      },
      expectExitCode: 0,
      stdoutIncludes: ['await then serve passed'],
    },
    {
      name: 'node-fs',
      scriptPath: join(rootDir, 'tests', 'js', 'node-fs.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['node fs passed'],
    },
    {
      name: 'node-child-process',
      scriptPath: join(rootDir, 'tests', 'js', 'node-child-process.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node child_process spawn passed'],
    },
    {
      name: 'node-os',
      scriptPath: join(rootDir, 'tests', 'js', 'node-os.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node os passed'],
    },
    {
      name: 'proxy-function',
      scriptPath: join(rootDir, 'tests', 'js', 'proxy-function.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['proxy function passed'],
    },
    {
      name: 'spawn-detached',
      scriptPath: join(rootDir, 'tests', 'js', 'spawn-detached.ts'),
      env: {
        COTTONTAIL_DETACHED_OUTPUT: join(tempDir, 'spawn-detached.txt'),
      },
      expectExitCode: 0,
      stdoutIncludes: ['spawn detached passed'],
    },
    {
      name: 'timer-clock',
      scriptPath: join(rootDir, 'tests', 'js', 'timer-clock.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['timer clock passed'],
    },
    {
      name: 'worker-request-response',
      scriptPath: join(rootDir, 'tests', 'js', 'worker-request-response.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['worker request response passed'],
    },
    {
      name: 'worker-delayed-request',
      scriptPath: join(rootDir, 'tests', 'js', 'worker-delayed-request.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['worker delayed request passed'],
    },
    {
      name: 'sync-error',
      scriptPath: join(rootDir, 'tests', 'js', 'sync-error.js'),
      expectExitCode: 1,
      stderrIncludes: ['Error: sync boom'],
    },
    {
      name: 'unhandled-rejection',
      scriptPath: join(rootDir, 'tests', 'js', 'unhandled-rejection.js'),
      expectExitCode: 1,
      stderrIncludes: ['Error: async boom'],
    },
  ];

  for (const testCase of tests) {
    runCase(testCase);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
