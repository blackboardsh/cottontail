import { binaryName, fail, fs, path, proc } from './ct-runtime.js';

const rootDir = proc.cwd();
const binaryPath = path.join(rootDir, 'zig-out', 'bin', binaryName('cottontail'));
const tempRoot = path.join(rootDir, '.cottontail-tmp');
const tempDir = path.join(tempRoot, `js-tests-${cottontail.nanotime().toString()}`);
const tempFilePath = path.join(tempDir, 'host-api-output.txt');
const tempDirPath = path.join(tempDir, 'host-api-dir');

function runCase(testCase) {
  const result = proc.spawnSync(binaryPath, [testCase.scriptPath, ...(testCase.args ?? [])], {
    cwd: rootDir,
    env: {
      ...(testCase.env ?? {}),
    },
    stdio: 'pipe',
  });

  if (result.status !== testCase.expectExitCode) {
    fail(
      [
        `Test "${testCase.name}" exited with ${result.status}, expected ${testCase.expectExitCode}.`,
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

if (!fs.existsSync(binaryPath)) {
  fail(`Built cottontail binary not found at ${binaryPath}. Run the build command first.`);
}

fs.mkdirSync(tempDir, { recursive: true });

try {
  const tests = [
    {
      name: 'smoke',
      scriptPath: path.join(rootDir, 'test.js'),
      expectExitCode: 0,
      stdoutIncludes: ['all js smoke tests passed'],
    },
    {
      name: 'modules',
      scriptPath: path.join(rootDir, 'tests', 'js', 'module-main.js'),
      expectExitCode: 0,
      stdoutIncludes: ['module imports passed'],
    },
    {
      name: 'async',
      scriptPath: path.join(rootDir, 'tests', 'js', 'async.js'),
      expectExitCode: 0,
      stdoutIncludes: ['async passed'],
    },
    {
      name: 'host-api',
      scriptPath: path.join(rootDir, 'tests', 'js', 'host-api.js'),
      args: ['alpha', 'beta'],
      env: {
        COTTONTAIL_TEST_ENV: 'present',
        COTTONTAIL_EXPECT_CWD: rootDir,
        COTTONTAIL_TMP_FILE: tempFilePath,
        COTTONTAIL_TMP_DIR: tempDirPath,
      },
      expectExitCode: 0,
      stdoutIncludes: ['host api passed'],
    },
    {
      name: 'sync-error',
      scriptPath: path.join(rootDir, 'tests', 'js', 'sync-error.js'),
      expectExitCode: 1,
      stderrIncludes: ['Error: sync boom'],
    },
    {
      name: 'unhandled-rejection',
      scriptPath: path.join(rootDir, 'tests', 'js', 'unhandled-rejection.js'),
      expectExitCode: 1,
      stderrIncludes: ['Error: async boom'],
    },
  ];

  for (const testCase of tests) {
    runCase(testCase);
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
