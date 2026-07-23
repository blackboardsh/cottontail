#!/usr/bin/env node

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
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
  const argv = testCase.argv ?? [testCase.scriptPath, ...(testCase.args ?? [])];
  const result = spawnSync(binaryPath, argv, {
    cwd: testCase.cwd ?? rootDir,
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
const nativeBuildOutDir = join(tempDir, 'native-build');

try {
  writeFileSync(join(tempDir, 'eval-data.json'), JSON.stringify({ value: 42 }));
  writeFileSync(
    join(tempDir, 'node-fs-binary-source.bin'),
    Uint8Array.from([0x00, 0x41, 0x0d, 0x0a, 0x42, 0x1a, 0x43, 0x0a, 0x0d, 0xff])
  );
  writeFileSync(join(tempDir, 'plain.test.js'), 'console.log("plain-test-body");\n');
  writeFileSync(
    join(tempDir, 'commonjs-using.js'),
    'let disposed = false; { using value = { [Symbol.dispose]() { disposed = true; } }; } if (!disposed) throw new Error("resource was not disposed"); console.log("commonjs using passed");\n'
  );
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
      name: 'import-meta-main-entry-identity',
      scriptPath: join(rootDir, 'tests', 'js', 'import-meta-main-entry.mjs'),
      expectExitCode: 0,
      stdoutIncludes: ['import.meta.main entry identity passed'],
    },
    {
      name: 'bun-narrow-import-installs-web-globals',
      scriptPath: join(rootDir, 'tests', 'js', 'fixtures', 'bun-narrow-import-globals.mjs'),
      expectExitCode: 0,
      stdoutIncludes: ['bun narrow import globals passed'],
    },
    {
      name: 'builtin-dynamic-import-default-identity',
      scriptPath: join(rootDir, 'tests', 'js', 'fixtures', 'builtin-dynamic-import-default-identity.mjs'),
      expectExitCode: 0,
      stdoutIncludes: ['builtin dynamic import identity passed'],
    },
    {
      name: 'bundled-dynamic-import-default-identity',
      argv: ['test', join(rootDir, 'tests', 'js', 'builtin-dynamic-import-default-identity.test.ts')],
      expectExitCode: 0,
      stdoutIncludes: ['1 pass', '0 fail'],
    },
    {
      name: 'runtime-bootstrap-startup-regressions',
      argv: ['test', join(rootDir, 'tests', 'js', 'runtime-bootstrap-startup.test.ts')],
      expectExitCode: 0,
      stdoutIncludes: ['9 pass', '0 fail'],
    },
    {
      name: 'upstream-test-temp-cleanup-regressions',
      argv: ['test', join(rootDir, 'tests', 'js', 'upstream-test-temp-cleanup.test.ts')],
      expectExitCode: 0,
      stderrIncludes: ['5 pass', '0 fail'],
    },
    {
      name: 'internal-runtime-bindings',
      argv: ['test', join(rootDir, 'tests', 'js', 'internal-runtime-bindings.test.ts')],
      expectExitCode: 0,
      stdoutIncludes: ['7 pass', '0 fail'],
    },
    {
      name: 'cli-version-identity-regressions',
      argv: ['test', join(rootDir, 'tests', 'js', 'cli-version-identity.test.ts')],
      expectExitCode: 0,
      stdoutIncludes: ['3 pass', '0 fail'],
    },
    {
      name: 'cli-init-regressions',
      argv: ['test', join(rootDir, 'tests', 'js', 'cli-init.test.ts')],
      env: {
        COTTONTAIL_INIT_TEST_ROOT: join(rootDir, '.cottontail-tmp'),
      },
      expectExitCode: 0,
      stdoutIncludes: ['5 pass', '0 fail'],
    },
    {
      name: 'cli-run-package-script-regressions',
      argv: ['test', join(rootDir, 'tests', 'js', 'cli-run-package-scripts.test.ts')],
      env: {
        COTTONTAIL_CLI_RUN_TEST_ROOT: join(rootDir, '.cottontail-tmp'),
      },
      expectExitCode: 0,
      stdoutIncludes: ['2 pass', '0 fail'],
    },
    {
      name: 'module-syntax-in-multiline-string',
      scriptPath: join(rootDir, 'tests', 'js', 'module-syntax-in-multiline-string.js'),
      expectExitCode: 0,
      stdoutIncludes: ['module syntax string passed'],
    },
    {
      name: 'async',
      scriptPath: join(rootDir, 'tests', 'js', 'async.js'),
      expectExitCode: 0,
      stdoutIncludes: ['async passed'],
    },
    {
      name: 'cli-print-process-arch',
      argv: ['-p', 'process.arch'],
      expectExitCode: 0,
      stdoutIncludes: [process.arch],
    },
    {
      name: 'cli-eval-argv-execargv',
      argv: [
        '-e',
        'console.log(process.argv.slice(1).join("|")); console.log(process.execArgv[0] + ":" + process.execArgv[1].startsWith("console.log"));',
        'alpha',
        'beta',
      ],
      expectExitCode: 0,
      stdoutIncludes: ['alpha|beta', '-e:true'],
    },
    {
      name: 'jsc-main-run-loop-gc-timer',
      scriptPath: join(rootDir, 'tests', 'js', 'jsc-main-run-loop-gc-timer.ts'),
      env: {
        JSC_percentCPUPerMBForFullTimer: '1',
        JSC_collectionTimerMaxPercentCPU: '0.5',
      },
      expectExitCode: 0,
      stdoutIncludes: ['jsc gc timer passed'],
    },
    {
      name: 'jsc-worker-stack-reservation',
      scriptPath: join(rootDir, 'tests', 'js', 'jsc-worker-stack-reservation.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['jsc worker stack reservation passed'],
    },
    {
      name: 'cli-eval-relative-import',
      cwd: tempDir,
      argv: ['-e', 'import data from "./eval-data.json"; console.log(data.value)'],
      expectExitCode: 0,
      stdoutIncludes: ['42'],
    },
    {
      name: 'commonjs-explicit-resource-management',
      cwd: tempDir,
      scriptPath: join(tempDir, 'commonjs-using.js'),
      expectExitCode: 0,
      stdoutIncludes: ['commonjs using passed'],
    },
    {
      name: 'commonjs-strict-mode',
      scriptPath: join(rootDir, 'tests', 'js', 'commonjs-strict-mode.cjs'),
      expectExitCode: 0,
    },
    {
      name: 'dynamic-import-method-name',
      scriptPath: join(rootDir, 'tests', 'js', 'dynamic-import-method-name.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['dynamic import method name passed'],
    },
    {
      name: 'cli-test-banner-without-registered-tests',
      cwd: tempDir,
      argv: ['test', 'plain.test.js'],
      expectExitCode: 0,
      stdoutIncludes: ['bun test v1.3.10 (cottontail)', 'plain-test-body'],
    },
    {
      name: 'cli-wasi-entrypoint',
      scriptPath: join(
        rootDir,
        'compat',
        'upstream',
        'bun',
        'v1.3.10',
        'test',
        'js',
        'bun',
        'wasm',
        'hello-wasi.wasm'
      ),
      expectExitCode: 0,
      stdoutIncludes: ['hello world'],
    },
    {
      name: 'cli-runtime-flag-execargv',
      argv: ['--no-warnings', '-p', 'process.execArgv.includes("--no-warnings")'],
      expectExitCode: 0,
      stdoutIncludes: ['true'],
    },
    {
      name: 'bun-which-windows-extension',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-which-windows-extension.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['bun which windows extension passed'],
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
      stdoutIncludes: ['cottontailConsoleObject: true', 'bun apis passed'],
    },
    {
      name: 'bun-global',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-global.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['bun global passed'],
    },
    {
      name: 'bun-semver',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-semver.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['bun semver passed'],
    },
    {
      name: 'bun-package-manager-internals',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-package-manager-internals.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['bun package manager internals passed'],
    },
    {
      name: 'bun-package-manager-link',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-package-manager-link.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['bun package manager link passed'],
    },
    {
      name: 'bun-sqlite',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-sqlite.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['bun sqlite passed'],
    },
    {
      name: 'bun-ffi-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-ffi-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['bun ffi surface passed'],
    },
    {
      name: 'bun-test-module',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-test-module.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['bun test module passed'],
    },
    {
      name: 'bun-build-error',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-build-error.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['bun build error passed'],
    },
    {
      name: 'bun-build-native',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-build-native.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['bun build native passed'],
    },
    {
      name: 'bun-typescript-compiler-parity',
      argv: ['test', join(rootDir, 'tests', 'js', 'bun-typescript-compiler-parity.test.ts')],
      expectExitCode: 0,
      stdoutIncludes: ['8 pass', '0 fail'],
    },
    {
      name: 'native-build-cli',
      argv: [
        'build',
        join(rootDir, 'tests', 'js', 'fixtures', 'bun-build-entry.ts'),
        '--target=bun',
        '--outdir',
        nativeBuildOutDir,
      ],
      expectExitCode: 0,
      stdoutIncludes: [join(nativeBuildOutDir, 'bun-build-entry.js')],
    },
    {
      name: 'native-build-cli-output',
      scriptPath: join(nativeBuildOutDir, 'bun-build-entry.js'),
      expectExitCode: 0,
      stdoutIncludes: ['84'],
    },
    {
      name: 'bun-cjs-interop',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-cjs-interop.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['bun cjs interop passed'],
    },
    {
      name: 'bun-jsc-and-global',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-jsc-and-global.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['bun jsc and global passed'],
    },
    {
      name: 'bun-serve-spawn-ts',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-serve-spawn.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['bun serve spawn ts passed'],
    },
    {
      name: 'bun-spawn-streaming',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-spawn-streaming.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['bun spawn streaming passed'],
    },
    {
      name: 'bun-shell-long-top-level-await',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-shell-long-top-level-await.ts'),
      env: {
        COTTONTAIL_TEST_SPIN_TOP_LEVEL_AWAIT: '1',
      },
      expectExitCode: 0,
      stdoutIncludes: ['bun shell long top-level await passed'],
    },
    {
      name: 'bun-spawn-execpath-env',
      scriptPath: join(rootDir, 'tests', 'js', 'bun-spawn-execpath-env.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['bun spawn execpath env passed'],
    },
    {
      name: 'extensionless-require-resolve',
      scriptPath: join(rootDir, 'tests', 'js', 'fixtures', 'extensionless-require-resolve'),
      expectExitCode: 0,
      stdoutIncludes: ['extensionless require resolve passed'],
    },
    {
      name: 'extensionless-require-resolve-invalid-cottontail-home',
      scriptPath: join(rootDir, 'tests', 'js', 'fixtures', 'extensionless-require-resolve'),
      env: {
        COTTONTAIL_HOME: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['extensionless require resolve passed'],
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
      name: 'node-path-platform',
      scriptPath: join(rootDir, 'tests', 'js', 'node-path-platform.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node path platform exports passed'],
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
      name: 'node-fs-binary-io',
      scriptPath: join(rootDir, 'tests', 'js', 'node-fs-binary-io.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['node fs binary io passed'],
    },
    {
      name: 'node-fs-windows-long-path',
      scriptPath: join(rootDir, 'tests', 'js', 'node-fs-windows-long-path.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node fs windows long path passed'],
    },
    {
      name: 'node-fs-unlink-directory-link',
      scriptPath: join(rootDir, 'tests', 'js', 'node-fs-unlink-directory-link.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['node fs unlink directory link passed'],
    },
    {
      name: 'node-fs-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-fs-surface.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['node fs surface passed'],
    },
    {
      name: 'node-child-process-inherited-sync',
      scriptPath: join(rootDir, 'tests', 'js', 'node-child-process-inherited-sync.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['inherited-sync-stdout', 'node child inherited sync passed'],
      stderrIncludes: ['inherited-sync-stderr'],
    },
    {
      name: 'node-child-process',
      scriptPath: join(rootDir, 'tests', 'js', 'node-child-process.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['inherited-stdout', 'inherited-sync-stdout', 'node child_process spawn passed'],
      stderrIncludes: ['inherited-stderr', 'inherited-sync-stderr'],
    },
    {
      name: 'node-child-process-fork',
      scriptPath: join(rootDir, 'tests', 'js', 'node-child-process-fork.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node child_process fork passed'],
    },
    {
      name: 'node-child-process-external-fork',
      scriptPath: join(rootDir, 'tests', 'js', 'node-child-process-external-fork.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node child_process external fork passed'],
    },
    {
      name: 'node-os',
      scriptPath: join(rootDir, 'tests', 'js', 'node-os.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node os passed'],
    },
    {
      name: 'node-process',
      scriptPath: join(rootDir, 'tests', 'js', 'node-process.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node process passed'],
    },
    {
      name: 'node-process-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-process-surface.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['node process surface passed'],
    },
    {
      name: 'node-module-direct-package-root',
      scriptPath: join(rootDir, 'tests', 'js', 'node-module-direct-package-root.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['node module direct package root passed'],
    },
    {
      name: 'node-module-absolute-main',
      scriptPath: join(rootDir, 'tests', 'js', 'node-module-absolute-main.cjs'),
      expectExitCode: 0,
      stdoutIncludes: ['node module absolute main passed'],
    },
    {
      name: 'node-module-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-module-surface.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['node module surface passed'],
    },
    {
      name: 'node-net',
      scriptPath: join(rootDir, 'tests', 'js', 'node-net.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node net passed'],
    },
    {
      name: 'node-net-native-readiness',
      argv: ['test', join(rootDir, 'tests', 'js', 'node-net-native-readiness.test.ts')],
      expectExitCode: 0,
      stdoutIncludes: ['2 pass', '0 fail'],
    },
    {
      name: 'node-net-lifecycle-regressions',
      argv: ['test', join(rootDir, 'tests', 'js', 'node-net-lifecycle-regressions.test.ts')],
      expectExitCode: 0,
      stdoutIncludes: ['6 pass', '0 fail'],
    },
    {
      name: 'node-net-duplex',
      argv: ['test', join(rootDir, 'tests', 'js', 'node-net-duplex.test.ts')],
      expectExitCode: 0,
      stdoutIncludes: ['7 pass', '0 fail'],
    },
    {
      name: 'node-readline',
      scriptPath: join(rootDir, 'tests', 'js', 'node-readline.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node readline passed'],
    },
    {
      name: 'node-compat-aliases',
      scriptPath: join(rootDir, 'tests', 'js', 'node-compat-aliases.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node compat aliases passed'],
    },
    {
      name: 'node-util-sys-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-util-sys-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node util sys surface passed'],
    },
    {
      name: 'node-stream-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-stream-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node stream surface passed'],
    },
    {
      name: 'node-small-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-small-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node small surface passed'],
    },
    {
      name: 'node-instrumentation-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-instrumentation-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node instrumentation surface passed'],
    },
    {
      name: 'node-v8-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-v8-surface.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['node v8 surface passed'],
    },
    {
      name: 'node-test-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-test-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node test surface passed'],
    },
    {
      name: 'node-cluster-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-cluster-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node cluster surface passed'],
    },
    {
      name: 'node-worker-threads-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-worker-threads-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node worker_threads surface passed'],
    },
    {
      name: 'node-zlib-streams-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-zlib-streams-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node zlib streams surface passed'],
    },
    {
      name: 'node-misc-modules-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-misc-modules-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node misc modules surface passed'],
    },
    {
      name: 'node-constants-zlib-crypto',
      scriptPath: join(rootDir, 'tests', 'js', 'node-constants-zlib-crypto.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node constants zlib crypto passed'],
    },
    {
      name: 'node-crypto-kdf-dh-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-crypto-kdf-dh-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node crypto kdf dh surface passed'],
    },
    {
      name: 'node-crypto-webcrypto-conformance',
      scriptPath: join(rootDir, 'tests', 'js', 'node-crypto-webcrypto-conformance.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node crypto webcrypto conformance passed'],
    },
    {
      name: 'node-http-https-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-http-https-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node http https surface passed'],
    },
    {
      name: 'websocket-production',
      argv: ['test', join(rootDir, 'tests', 'js', 'websocket-production.test.ts')],
      expectExitCode: 0,
      stdoutIncludes: ['5 pass', '0 fail'],
    },
    {
      name: 'node-dns-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-dns-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node dns surface passed'],
    },
    {
      name: 'node-dgram-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-dgram-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node dgram surface passed'],
    },
    {
      name: 'node-tls-http2-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-tls-http2-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node tls http2 surface passed'],
    },
    {
      name: 'node-sqlite-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-sqlite-surface.ts'),
      env: {
        COTTONTAIL_TMP_DIR: tempDir,
      },
      expectExitCode: 0,
      stdoutIncludes: ['node sqlite surface passed'],
    },
    {
      name: 'node-inspector-surface',
      scriptPath: join(rootDir, 'tests', 'js', 'node-inspector-surface.ts'),
      expectExitCode: 0,
      stdoutIncludes: ['node inspector surface passed'],
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

  const hotWatchResult = spawnSync(process.execPath, [join(rootDir, 'tests', 'js', 'hot-watch-runtime.integration.js')], {
    cwd: rootDir,
    env: process.env,
    encoding: 'utf8',
  });
  if (hotWatchResult.error) {
    fail(`Failed to execute hot/watch integration test: ${hotWatchResult.error.message}`);
  }
  if (hotWatchResult.status !== 0) {
    fail(
      [
        `Hot/watch integration test exited with ${hotWatchResult.status ?? 1}.`,
        hotWatchResult.stdout ? `stdout:\n${hotWatchResult.stdout}` : '',
        hotWatchResult.stderr ? `stderr:\n${hotWatchResult.stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  process.stdout.write(hotWatchResult.stdout);

  if (readdirSync(tempDir).some(name => name.startsWith('.cottontail-eval-'))) {
    fail('Eval entrypoint was not cleaned up.');
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
