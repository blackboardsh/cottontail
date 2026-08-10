import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { bunStatusPlatformKey } from "../scripts/bun-status-platform.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = join(rootDir, "scripts", "run-upstream-tests.js");
const sharedStateRoot = mkdtempSync(join(tmpdir(), "cottontail-baseline-tools-"));
process.on("exit", () => rmSync(sharedStateRoot, { recursive: true, force: true }));

function createFixture(t) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "cottontail-upstream-runner-"));
  const snapshotRoot = join(fixtureRoot, "node-snapshot");
  const bunSnapshotRoot = join(fixtureRoot, "bun-snapshot");
  const capturePath = join(fixtureRoot, "harness-invocations.jsonl");
  const bunCapturePath = join(fixtureRoot, "bun-invocations.jsonl");
  const environmentCapturePath = join(fixtureRoot, "harness-environment.jsonl");
  const reportsRoot = join(fixtureRoot, "reports");
  const locksRoot = join(fixtureRoot, "locks");
  const stateRoot = sharedStateRoot;
  const targetsPath = join(fixtureRoot, "targets.json");
  const preflightShimPath = join(fixtureRoot, "preflight-shim.cjs");
  const cottontailBinaryPath = join(
    fixtureRoot,
    process.platform === "win32"
      ? `cottontail-test-${basename(fixtureRoot)}.cmd`
      : `cottontail-test-${basename(fixtureRoot)}`,
  );
  const hutchEnginePath = join(
    fixtureRoot,
    process.platform === "win32" ? "hutch-engine.cmd" : "hutch-engine",
  );
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const testPaths = [
    "test/parallel/test-alpha.js",
    "test/parallel/test-beta.mjs",
    "test/sequential/test-gamma.js",
    "test/fixtures/helper.js",
  ];
  for (const testPath of testPaths) {
    const absolutePath = join(snapshotRoot, testPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, "// runner fixture\n");
  }
  writeFileSync(join(snapshotRoot, "test", "parallel", "testcfg.py"), "# suite marker\n");
  writeFileSync(join(snapshotRoot, "test", "sequential", "testcfg.py"), "# suite marker\n");

  mkdirSync(join(snapshotRoot, "tools"), { recursive: true });
  const harnessPath = join(snapshotRoot, "tools", "test.py");
  writeFileSync(
    harnessPath,
    [
      "import json",
      "import os",
      "import sys",
      "",
      "class Context:",
      "    def __init__(self, *args):",
      "        pass",
      "",
      "class TestRepository:",
      "    def __init__(self, path):",
      "        self.path = path",
      "",
      "class Case:",
      "    def __init__(self, file_path, selector):",
      "        self.file = file_path",
      "        self.path = selector.split('/')",
      "",
      "def GetSuites(test_root):",
      "    return [",
      "        name for name in os.listdir(test_root)",
      "        if os.path.isfile(os.path.join(test_root, name, 'testcfg.py'))",
      "    ]",
      "",
      "def SplitPath(value):",
      "    return value",
      "",
      "def inventory_records(test_root):",
      "    records = []",
      "    for suite in sorted(GetSuites(test_root)):",
      "        suite_root = os.path.join(test_root, suite)",
      "        for current, _, names in os.walk(suite_root):",
      "            for name in sorted(names):",
      "                if not (name.endswith('.js') or name.endswith('.mjs')):",
      "                    continue",
      "                file_path = os.path.join(current, name)",
      "                relative = os.path.relpath(file_path, test_root).replace(os.sep, '/')",
      "                selector = os.path.splitext(relative)[0]",
      "                records.append((file_path, selector))",
      "    return records",
      "",
      "class LiteralTestSuite:",
      "    def __init__(self, repositories, test_root):",
      "        self.test_root = test_root",
      "",
      "    def ListTests(self, current_path, path, context, arch, mode):",
      "        prefix = path + '/'",
      "        return [",
      "            Case(file_path, selector)",
      "            for file_path, selector in inventory_records(self.test_root)",
      "            if selector.startswith(prefix)",
      "        ]",
      "",
      "if __name__ == '__main__':",
      "    capture_path = os.environ['COTTONTAIL_RUNNER_TEST_CAPTURE']",
      "    with open(capture_path, 'a', encoding='utf-8') as capture:",
      "        capture.write(json.dumps(sys.argv[1:]) + '\\n')",
      "    environment_capture_path = os.environ.get('COTTONTAIL_RUNNER_TEST_ENV_CAPTURE')",
      "    if environment_capture_path:",
      "        with open(environment_capture_path, 'a', encoding='utf-8') as capture:",
      "            capture.write(json.dumps({",
      "                'spawnExecPath': os.environ.get('COTTONTAIL_SPAWN_EXEC_PATH'),",
      "                'spawnArgv0': os.environ.get('COTTONTAIL_SPAWN_ARGV0'),",
      "                'cottontailBinary': os.environ.get('COTTONTAIL_BINARY'),",
      "                'dashCottontail': os.environ.get('DASH_COTTONTAIL'),",
      "                'hutchLauncherPath': os.environ.get('HUTCH_LAUNCHER_PATH'),",
      "                'hutchLauncherVersion': os.environ.get('HUTCH_LAUNCHER_VERSION'),",
      "                'hutchActiveChannel': os.environ.get('HUTCH_ACTIVE_CHANNEL'),",
      "                'loaderVars': sorted(key for key in os.environ if (",
      "                    key.upper() in {'BUN_OPTIONS', 'NODE_OPTIONS', 'NODE_PATH'} or",
      "                    key.upper().startswith(('DYLD_', 'LD_'))",
      "                )),",
      "            }) + '\\n')",
      "",
      "    args = sys.argv[1:]",
      "    selectors = []",
      "    index = 0",
      "    while index < len(args):",
      "        argument = args[index]",
      "        if argument == '--shell':",
      "            index += 2",
      "        elif argument in ('-j4', '--report'):",
      "            index += 1",
      "        elif argument.startswith('-'):",
      "            index += 1",
      "        else:",
      "            selectors.append(argument)",
      "            index += 1",
      "",
      "    snapshot_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))",
      "    test_root = os.path.join(snapshot_root, 'test')",
      "    records = inventory_records(test_root)",
      "    selected = [record for record in records if record[1] in selectors]",
      "    report_delta = int(os.environ.get('COTTONTAIL_RUNNER_TEST_REPORT_DELTA', '0'))",
      "    print(f'Total: {len(selected) + report_delta} tests')",
      "    print(' *    0 tests will be skipped')",
      "",
      "    fail_selector = os.environ.get('COTTONTAIL_RUNNER_TEST_FAIL_SELECTOR')",
      "    if fail_selector and fail_selector in selectors:",
      "        sys.exit(1)",
      "    sys.exit(int(os.environ.get('COTTONTAIL_RUNNER_TEST_HARNESS_EXIT', '0')))",
      "",
    ].join("\n"),
  );
  chmodSync(harnessPath, 0o755);

  const bunTests = {
    "test/js/fail-fast.test.js": { exitCode: 1, delayMs: 5 },
    "test/js/pass-after.test.js": { exitCode: 0, delayMs: 120 },
    "test/js/pass-fast.test.js": { exitCode: 0, delayMs: 5 },
    "test/js/timeout-budget.test.js": { exitCode: 0, delayMs: 120 },
  };
  for (const [testPath, behavior] of Object.entries(bunTests)) {
    const absolutePath = join(bunSnapshotRoot, testPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(
      absolutePath,
      [
        'const fs = require("node:fs");',
        `const record = ${JSON.stringify({ path: testPath, ...behavior })};`,
        "const capturePath = process.env.COTTONTAIL_RUNNER_BUN_CAPTURE;",
        "if (capturePath) fs.appendFileSync(capturePath, JSON.stringify({",
        "  ...record,",
        "  at: Date.now(),",
        "  hutchLauncherPath: process.env.HUTCH_LAUNCHER_PATH ?? null,",
        "  hutchLauncherVersion: process.env.HUTCH_LAUNCHER_VERSION ?? null,",
        "  hutchActiveChannel: process.env.HUTCH_ACTIVE_CHANNEL ?? null,",
        "  temp: Object.fromEntries([",
        "    'COTTONTAIL_TMP_DIR', 'BUN_TMPDIR', 'TEST_TMPDIR', 'TMPDIR', 'TMP', 'TEMP',",
        "  ].map(key => [key, process.env[key] ?? null])),",
        "  argv: process.argv.slice(2),",
        "}) + '\\n');",
        "setTimeout(() => {",
        "  process.stderr.write(process.env.COTTONTAIL_RUNNER_TEST_SUMMARY ?? `\\n 1 pass\\n 0 fail\\n 1 expect() calls\\nRan 1 test across 1 file.\\n`);",
        "  process.exit(record.exitCode);",
        "}, Number(process.env.COTTONTAIL_RUNNER_TEST_DELAY_MS ?? record.delayMs));",
        "",
      ].join("\n"),
    );
  }
  writeFileSync(
    join(bunSnapshotRoot, "status.json"),
    JSON.stringify({
      schema: 1,
      defaultStatus: "enabled",
      tests: {
        "test/js/timeout-budget.test.js": { timeoutMs: 1000 },
      },
    }, null, 2),
  );
  writeFileSync(join(bunSnapshotRoot, "manifest.json"), JSON.stringify({
    schema: 1,
    runtime: "bun",
    version: "1.3.10-test",
    commit: "abcdef0123456789abcdef0123456789abcdef01",
  }, null, 2));

  writeFileSync(
    join(snapshotRoot, "status.json"),
    JSON.stringify(
      {
        schema: 1,
        defaultStatus: "enabled",
        tests: {
          "test/parallel/test-beta.mjs": {
            status: "expected-failure",
            reason: "runner fixture",
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(snapshotRoot, "manifest.json"), JSON.stringify({
    schema: 1,
    runtime: "node",
    version: "24.11.1-test",
    commit: "0123456789abcdef0123456789abcdef01234567",
  }, null, 2));
  writeFileSync(
    targetsPath,
    JSON.stringify(
      {
        schema: 1,
        node: {
          version: "24.11.1-test",
          commit: "0123456789abcdef0123456789abcdef01234567",
          snapshot: snapshotRoot,
        },
        bun: {
          version: "1.3.10-test",
          commit: "abcdef0123456789abcdef0123456789abcdef01",
          snapshot: bunSnapshotRoot,
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    preflightShimPath,
    [
      "if (process.env.COTTONTAIL_UPSTREAM_PREFLIGHT === '1') {",
      "  const productVersion = '9.9.9-runner-test';",
      "  globalThis.cottontail = {",
      "    processInfo(name) {",
      "      if (name === 'version') return productVersion;",
      "      throw new Error(`unexpected processInfo key: ${name}`);",
      "    },",
      "  };",
      "  globalThis.Bun = { version: '1.3.10' };",
      "  process.versions.cottontail = productVersion;",
      "  process.versions.bun = globalThis.Bun.version;",
      "  process.revision = 'cottontail';",
      "  process.isBun = true;",
      "}",
      "",
    ].join("\n"),
  );

  if (process.platform === "win32") {
    const nodePath = process.execPath.replaceAll("%", "%%");
    const shimPath = preflightShimPath.replaceAll("%", "%%");
    writeFileSync(
      cottontailBinaryPath,
      `@echo off\r\nif "%COTTONTAIL_UPSTREAM_PREFLIGHT%"=="1" set "NODE_OPTIONS=--require=\\"${shimPath}\\""\r\n"${nodePath}" %*\r\n`,
    );
    writeFileSync(
      hutchEnginePath,
      "@echo off\r\n\"%COTTONTAIL_BINARY%\" %*\r\n",
    );
  } else {
    writeFileSync(
      cottontailBinaryPath,
      [
        "#!/usr/bin/env node",
        'const { spawnSync } = require("node:child_process");',
        `const shim = ${JSON.stringify(preflightShimPath)};`,
        "const env = { ...process.env };",
        "if (env.COTTONTAIL_UPSTREAM_PREFLIGHT === '1') env.NODE_OPTIONS = `--require=${shim}`;",
        "else delete env.NODE_OPTIONS;",
        "const result = spawnSync(process.execPath, process.argv.slice(2), {",
        "  env,",
        '  stdio: "inherit",',
        "});",
        "if (result.error) throw result.error;",
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n"),
    );
    writeFileSync(
      hutchEnginePath,
      [
        "#!/usr/bin/env node",
        'const { spawnSync } = require("node:child_process");',
        "const result = spawnSync(process.env.COTTONTAIL_BINARY, process.argv.slice(2), {",
        "  env: process.env,",
        '  stdio: "inherit",',
        "});",
        "if (result.error) throw result.error;",
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n"),
    );
  }
  chmodSync(cottontailBinaryPath, 0o755);
  chmodSync(hutchEnginePath, 0o755);

  return {
    bunCapturePath,
    bunSnapshotRoot,
    capturePath,
    cottontailBinaryPath,
    environmentCapturePath,
    hutchEnginePath,
    locksRoot,
    preflightShimPath,
    reportsRoot,
    stateRoot,
    snapshotRoot,
    targetsPath,
  };
}

function runRunner(fixture, args, {
  validCottontail = true,
  environment = {},
  runtime = "node",
} = {}) {
  writeFileSync(fixture.capturePath, "");
  writeFileSync(fixture.bunCapturePath, "");
  const env = {
    ...process.env,
    COTTONTAIL_UPSTREAM_TARGETS_PATH: fixture.targetsPath,
    COTTONTAIL_RUNNER_TEST_CAPTURE: fixture.capturePath,
    COTTONTAIL_RUNNER_BUN_CAPTURE: fixture.bunCapturePath,
    COTTONTAIL_BASELINE_REPORTS_DIR: fixture.reportsRoot,
    COTTONTAIL_BASELINE_LOCK_DIR: fixture.locksRoot,
    COTTONTAIL_BASELINE_STATE_DIR: fixture.stateRoot,
    ...environment,
  };
  const binaryPath = validCottontail ? fixture.cottontailBinaryPath : process.execPath;
  return spawnSync(
    process.execPath,
    [
      runnerPath,
      runtime,
      "--binary",
      binaryPath,
      ...args,
    ],
    {
      cwd: rootDir,
      env,
      encoding: "utf8",
    },
  );
}

function readInvocations(capturePath) {
  if (!existsSync(capturePath)) return [];
  return readFileSync(capturePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readJsonLines(path) {
  return readInvocations(path);
}

function writeTestList(fixture, name, paths) {
  const path = join(dirname(fixture.targetsPath), name);
  writeFileSync(path, `${paths.join("\n")}\n`);
  return path;
}

function installBundlerDiscoveryFixture(fixture, mode) {
  const relativePath = "test/bundler/discovery.test.js";
  const absolutePath = join(fixture.bunSnapshotRoot, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, [
    'const prefix = "COTTONTAIL_BUNDLER_TEST_ID:";',
    'const mode = process.env.COTTONTAIL_RUNNER_DISCOVERY_MODE;',
    'if (process.env.COTTONTAIL_BUNDLER_TEST_DISCOVER === "1") {',
    '  process.stdout.write(`${prefix}"case/one"\\n`);',
    '  if (mode === "nonzero") process.exit(2);',
    '  if (mode === "duplicate") process.stdout.write(`${prefix}"case/one"\\n`);',
    '  if (mode === "partial") process.stdout.write(`${prefix}{`);',
    '  if (mode === "truncated") process.stdout.write("x".repeat(4096));',
    '  if (mode === "timeout") setInterval(() => {}, 1000);',
    '} else {',
    '  const count = mode === "duplicate" ? 2 : 1;',
    '  process.stderr.write(`\\n ${count} pass\\n 0 fail\\n ${count} expect() calls\\nRan ${count} tests across 1 file.\\n`);',
    '}',
    '',
  ].join("\n"));
  const statusPath = join(fixture.bunSnapshotRoot, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.tests[relativePath] = {
    status: "enabled",
    splitBundlerTests: true,
    timeoutMs: mode === "timeout" ? 100 : 1000,
    env: { COTTONTAIL_RUNNER_DISCOVERY_MODE: mode },
  };
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  return relativePath;
}

function reportEvents(reportDir) {
  return readJsonLines(join(reportDir, "events.jsonl"));
}

function assertSucceeded(result) {
  assert.equal(
    result.status,
    0,
    `runner exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function harnessArgs(fixture, ...selectors) {
  const toolsRoot = join(sharedStateRoot, "tools");
  const binaryName = basename(fixture.cottontailBinaryPath);
  const pinnedBinary = readdirSync(toolsRoot)
    .map((hash) => join(toolsRoot, hash, binaryName))
    .find(existsSync);
  assert.ok(pinnedBinary, "expected the runner to pin its selected binary");
  return ["--shell", pinnedBinary, "-j4", "--report", ...selectors];
}

test("Node CLI filters pass only their selected paths to tools/test.py", async (t) => {
  const fixture = createFixture(t);

  await t.test("--match", () => {
    const result = runRunner(fixture, ["--match", "^test/parallel/test-alpha\\.js$"]);
    assertSucceeded(result);
    assert.match(result.stdout, /discovered runnable files: 3/);
    assert.deepEqual(
      readInvocations(fixture.capturePath),
      [harnessArgs(fixture, "parallel/test-alpha")],
    );
  });

  await t.test("--max-tests", () => {
    const result = runRunner(fixture, ["--max-tests", "1"]);
    assertSucceeded(result);
    assert.deepEqual(
      readInvocations(fixture.capturePath),
      [harnessArgs(fixture, "parallel/test-alpha")],
    );
  });

  await t.test("--only-status", () => {
    const result = runRunner(
      fixture,
      ["--only-status", "expected-failure"],
      { environment: { COTTONTAIL_RUNNER_TEST_HARNESS_EXIT: "1" } },
    );
    assertSucceeded(result);
    assert.deepEqual(
      readInvocations(fixture.capturePath),
      [harnessArgs(fixture, "parallel/test-beta")],
    );
  });

  await t.test("--test", () => {
    const result = runRunner(fixture, ["--test", "test/sequential/test-gamma.js"]);
    assertSucceeded(result);
    assert.deepEqual(
      readInvocations(fixture.capturePath),
      [harnessArgs(fixture, "sequential/test-gamma")],
    );
  });
});

test("Node default runs use explicit selectors and isolate expected failures", (t) => {
  const fixture = createFixture(t);
  const result = runRunner(
    fixture,
    ["--include-expected-failures"],
    {
      environment: {
        COTTONTAIL_RUNNER_TEST_FAIL_SELECTOR: "parallel/test-beta",
      },
    },
  );
  assertSucceeded(result);
  assert.deepEqual(
    readInvocations(fixture.capturePath),
    [
      harnessArgs(fixture, "parallel/test-alpha", "sequential/test-gamma"),
      harnessArgs(fixture, "parallel/test-beta"),
    ],
  );
  assert.match(result.stdout, /1 expected failure/);
});

test("a healed Node expected-failure chunk is reported explicitly as XPASS", (t) => {
  const fixture = createFixture(t);
  const result = runRunner(fixture, ["--include-expected-failures"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /XPASS node/);
  assert.match(result.stdout, /XPASS Node harness chunk 2\/2/);
});

test("Hutch is exposed as the CLI while Cottontail remains the test runtime", (t) => {
  const fixture = createFixture(t);
  const result = runRunner(
    fixture,
    ["--hutch", fixture.hutchEnginePath, "--match", "^test/parallel/test-alpha\\.js$"],
    {
      environment: {
        COTTONTAIL_RUNNER_TEST_ENV_CAPTURE: fixture.environmentCapturePath,
        HUTCH_LAUNCHER_PATH: "/wrong/outer/hutch",
        HUTCH_LAUNCHER_VERSION: "wrong-version",
        HUTCH_ACTIVE_CHANNEL: "wrong-channel",
        bUn_OpTiOnS: "--smol",
        dYlD_iNsErT_LiBrArIeS: "/not-loaded.dylib",
        dYlD_rOoT_pAtH: "/not-loaded-root",
        lD_aUdIt: "/not-loaded-audit.so",
        lD_pReLoAd: "/not-loaded.so",
        nOdE_oPtIoNs: "--no-warnings",
        nOdE_pAtH: "/wrong/modules",
      },
    },
  );
  assertSucceeded(result);
  const [environment] = readInvocations(fixture.environmentCapturePath);
  assert.equal(basename(environment.spawnExecPath), basename(fixture.hutchEnginePath));
  assert.equal(environment.spawnArgv0, environment.spawnExecPath);
  assert.equal(basename(environment.cottontailBinary), basename(fixture.cottontailBinaryPath));
  assert.equal(environment.dashCottontail, environment.cottontailBinary);
  assert.equal(environment.hutchLauncherPath, null);
  assert.equal(environment.hutchLauncherVersion, null);
  assert.equal(environment.hutchActiveChannel, null);
  assert.deepEqual(environment.loaderVars, []);
});

test("the outer Hutch launcher is rejected clearly", (t) => {
  const fixture = createFixture(t);
  const outerHutchPath = join(dirname(fixture.targetsPath), process.platform === "win32" ? "hutch.exe" : "hutch");
  copyFileSync(process.execPath, outerHutchPath);
  chmodSync(outerHutchPath, 0o755);
  const result = runRunner(fixture, [
    "--hutch",
    outerHutchPath,
    "--match",
    "^test/parallel/test-alpha\\.js$",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must point directly to a Hutch engine, not the outer Hutch launcher/);
  assert.deepEqual(readInvocations(fixture.capturePath), []);
});

test("test metadata cannot reintroduce loader variables", (t) => {
  const fixture = createFixture(t);
  const statusPath = join(fixture.bunSnapshotRoot, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.tests["test/js/pass-fast.test.js"] = {
    env: { dYlD_rOoT_pAtH: "/metadata-loader-root" },
  };
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);

  const result = runRunner(
    fixture,
    ["--test", "test/js/pass-fast.test.js"],
    { runtime: "bun" },
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /test metadata cannot override loader or runtime routing environment variable\(s\): dYlD_rOoT_pAtH/,
  );
  assert.deepEqual(readInvocations(fixture.bunCapturePath), []);
});

test("the Bun runner applies the exact platform status override", (t) => {
  const fixture = createFixture(t);
  const statusPath = join(fixture.bunSnapshotRoot, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.platformOverrides = {
    [bunStatusPlatformKey()]: {
      tests: {
        "test/js/pass-fast.test.js": {
          args: ["--platform-status-override"],
        },
      },
    },
  };
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);

  const result = runRunner(
    fixture,
    ["--test", "test/js/pass-fast.test.js"],
    { runtime: "bun" },
  );
  assertSucceeded(result);
  assert.deepEqual(readJsonLines(fixture.bunCapturePath)[0].argv, ["--platform-status-override"]);
});

test("per-entry short temp mode bypasses a long ambient root and cleans its owned root", (t) => {
  const fixture = createFixture(t);
  const statusPath = join(fixture.bunSnapshotRoot, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.tests["test/js/pass-fast.test.js"] = {
    env: { COTTONTAIL_UPSTREAM_SHORT_TEMP: "1" },
  };
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);

  const ambientTemp = join(
    dirname(fixture.targetsPath),
    "ambient-temp-that-is-deliberately-too-long-for-repeated-path-fixtures",
  );
  mkdirSync(ambientTemp, { recursive: true });
  const result = runRunner(
    fixture,
    ["--test", "test/js/pass-fast.test.js"],
    {
      runtime: "bun",
      environment: { COTTONTAIL_UPSTREAM_TMPDIR: ambientTemp },
    },
  );
  assertSucceeded(result);

  const [invocation] = readJsonLines(fixture.bunCapturePath);
  const tempPaths = Object.values(invocation.temp);
  assert.ok(tempPaths.every(Boolean));
  assert.equal(new Set(tempPaths).size, 1, "all test temp variables must share one owned root");
  const ownedRunTemp = tempPaths[0];
  const ownedShortRoot = dirname(ownedRunTemp);
  assert.match(basename(ownedRunTemp), /^run-/);
  assert.match(basename(ownedShortRoot), /^ct-/);
  assert.equal(
    resolve(ownedRunTemp).startsWith(`${resolve(ambientTemp)}${sep}`),
    false,
    "short temp mode must ignore the ambient containment path",
  );
  if (process.platform !== "win32") {
    assert.equal(dirname(ownedShortRoot), "/tmp");
  }
  assert.equal(existsSync(ownedRunTemp), false, "runner must remove the per-attempt root");
  assert.equal(existsSync(ownedShortRoot), false, "runner must remove the short parent root");
  assert.equal(existsSync(ambientTemp), true, "runner must not remove the caller-owned base");
  assert.deepEqual(readdirSync(ambientTemp), []);
});

test("--expect-pass validates a focused recorded failure without editing status", (t) => {
  const fixture = createFixture(t);
  const result = runRunner(fixture, [
    "--only-status",
    "expected-failure",
    "--expect-pass",
  ]);
  assertSucceeded(result);
  assert.deepEqual(
    readInvocations(fixture.capturePath),
    [harnessArgs(fixture, "parallel/test-beta")],
  );
});

test("Node selectors are split into bounded command-line chunks", (t) => {
  const fixture = createFixture(t);
  const result = runRunner(
    fixture,
    [],
    {
      environment: {
        COTTONTAIL_UPSTREAM_NODE_SELECTOR_CHUNK_CHARS: "25",
      },
    },
  );
  assertSucceeded(result);
  assert.deepEqual(
    readInvocations(fixture.capturePath),
    [
      harnessArgs(fixture, "parallel/test-alpha"),
      harnessArgs(fixture, "sequential/test-gamma"),
    ],
  );
});

test("Node discovery excludes files outside harness-configured suites", (t) => {
  const fixture = createFixture(t);
  const result = runRunner(fixture, ["--test", "test/fixtures/helper.js"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not recognized by tools\/test\.py/);
  assert.deepEqual(readInvocations(fixture.capturePath), []);
});

test("Node selector collisions must be selected as one harness group", (t) => {
  const fixture = createFixture(t);
  const jsPath = join(fixture.snapshotRoot, "test", "parallel", "test-collision.js");
  const mjsPath = join(fixture.snapshotRoot, "test", "parallel", "test-collision.mjs");
  writeFileSync(jsPath, "// collision fixture\n");
  writeFileSync(mjsPath, "// collision fixture\n");

  const partial = runRunner(fixture, ["--match", "test-collision\\.js$"]);
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /Select every colliding path together/);
  assert.deepEqual(readInvocations(fixture.capturePath), []);

  const complete = runRunner(fixture, ["--match", "test-collision\\.(?:js|mjs)$"]);
  assertSucceeded(complete);
  assert.deepEqual(
    readInvocations(fixture.capturePath),
    [harnessArgs(fixture, "parallel/test-collision")],
  );
});

test("Node execution fails if tools/test.py matches a different test count", (t) => {
  const fixture = createFixture(t);
  const result = runRunner(
    fixture,
    ["--match", "^test/parallel/test-alpha\\.js$"],
    {
      environment: {
        COTTONTAIL_RUNNER_TEST_REPORT_DELTA: "-1",
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /tools\/test\.py matched 0 test\(s\), expected 1/);
  assert.deepEqual(
    readInvocations(fixture.capturePath),
    [harnessArgs(fixture, "parallel/test-alpha")],
  );
});

test("a non-Cottontail binary cannot false-green an upstream run", (t) => {
  const fixture = createFixture(t);
  const result = runRunner(
    fixture,
    ["--match", "^test/parallel/test-alpha\\.js$"],
    { validCottontail: false },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Binary is not a working Cottontail runtime/);
  assert.deepEqual(readInvocations(fixture.capturePath), []);
});

test("runtime source overlays cannot false-green an upstream run", (t) => {
  const fixture = createFixture(t);
  const result = runRunner(
    fixture,
    ["--match", "^test/parallel/test-alpha\\.js$"],
    {
      environment: {
        COTTONTAIL_RUNTIME_MODULES_DIR: join(fixture.snapshotRoot, "runtime-overlay"),
      },
    },
  );
  assertSucceeded(result);
  assert.deepEqual(
    readInvocations(fixture.capturePath),
    [harnessArgs(fixture, "parallel/test-alpha")],
  );
});

test("an empty Node selection fails before tools/test.py is invoked", (t) => {
  const fixture = createFixture(t);
  const result = runRunner(fixture, ["--match", "does-not-match"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No node JavaScript baseline tests matched the requested selection/);
  assert.deepEqual(readInvocations(fixture.capturePath), []);
});

test("--test-list selects exact JavaScript baseline paths", (t) => {
  const fixture = createFixture(t);
  const testList = writeTestList(fixture, "selected-tests.txt", [
    "# focused failures from a previous run",
    "test/parallel/test-alpha.js",
    "",
    "test/sequential/test-gamma.js",
  ]);
  const result = runRunner(fixture, ["--test-list", testList, "--expect-pass"]);
  assertSucceeded(result);
  assert.deepEqual(readInvocations(fixture.capturePath), [
    harnessArgs(fixture, "parallel/test-alpha", "sequential/test-gamma"),
  ]);
});

test("Bun-derived tests report completion order, heartbeat, durable events, and logs", (t) => {
  const fixture = createFixture(t);
  const reportDir = join(dirname(fixture.targetsPath), "live-report");
  const result = runRunner(
    fixture,
    [
      "--match",
      "^test/js/(?:pass-after|pass-fast)\\.test\\.js$",
      "--jobs",
      "2",
      "--report-dir",
      reportDir,
    ],
    {
      runtime: "bun",
      environment: {
        COTTONTAIL_BASELINE_HEARTBEAT_MS: "20",
        HUTCH_LAUNCHER_PATH: "/inherited/outer/hutch",
        HUTCH_LAUNCHER_VERSION: "inherited",
        HUTCH_ACTIVE_CHANNEL: "canary",
      },
    },
  );
  assertSucceeded(result);
  const fastDone = result.stdout.indexOf("ok bun test/js/pass-fast.test.js");
  const slowDone = result.stdout.indexOf("ok bun test/js/pass-after.test.js");
  assert.ok(fastDone >= 0 && slowDone > fastDone, result.stdout);
  assert.match(result.stdout, /heartbeat JavaScript baseline suite:/);

  const invocations = readJsonLines(fixture.bunCapturePath);
  assert.equal(invocations.length, 2);
  for (const invocation of invocations) {
    assert.equal(invocation.hutchLauncherPath, null);
    assert.equal(invocation.hutchLauncherVersion, null);
    assert.equal(invocation.hutchActiveChannel, null);
    assert.deepEqual(invocation.argv, []);
  }
  const plan = JSON.parse(readFileSync(join(reportDir, "plans", "bun.json"), "utf8"));
  assert.ok(plan.tests.every((entry) => entry.args.length === 0));
  assert.ok(plan.tests.every((entry) => entry.owner === "cottontail-runtime"));
  const events = reportEvents(reportDir);
  assert.equal(events.filter((event) => event.kind === "terminal").length, 2);
  assert.ok(events.some((event) => event.kind === "heartbeat"));
  assert.equal(readdirSync(join(reportDir, "logs")).length, 2);
  const summary = JSON.parse(readFileSync(join(reportDir, "summary.json"), "utf8"));
  assert.deepEqual(
    { planned: summary.planned, completed: summary.completed, unexpected: summary.unexpected },
    { planned: 2, completed: 2, unexpected: 0 },
  );
});

test("--jobs=1 serializes bun:test unless metadata owns max-concurrency", (t) => {
  const fixture = createFixture(t);
  const statusPath = join(fixture.bunSnapshotRoot, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.tests["test/js/pass-after.test.js"] = {
    args: ["--max-concurrency=7"],
  };
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  const reportDir = join(dirname(fixture.targetsPath), "serial-args-report");

  const result = runRunner(
    fixture,
    [
      "--match",
      "^test/js/(?:pass-after|pass-fast)\\.test\\.js$",
      "--jobs",
      "1",
      "--report-dir",
      reportDir,
    ],
    { runtime: "bun" },
  );
  assertSucceeded(result);

  const invocations = readJsonLines(fixture.bunCapturePath);
  assert.deepEqual(
    Object.fromEntries(invocations.map((invocation) => [invocation.path, invocation.argv])),
    {
      "test/js/pass-after.test.js": ["--max-concurrency=7"],
      "test/js/pass-fast.test.js": ["--max-concurrency", "1"],
    },
  );
  const plan = JSON.parse(readFileSync(join(reportDir, "plans", "bun.json"), "utf8"));
  assert.deepEqual(
    Object.fromEntries(plan.tests.map((entry) => [entry.path, entry.args])),
    {
      "test/js/pass-after.test.js": ["--max-concurrency=7"],
      "test/js/pass-fast.test.js": ["--max-concurrency", "1"],
    },
  );
});

test("a timeout override does not force a Bun-derived test into the serial phase", (t) => {
  const fixture = createFixture(t);
  const result = runRunner(
    fixture,
    [
      "--match",
      "^test/js/(?:pass-fast|timeout-budget)\\.test\\.js$",
      "--jobs",
      "2",
    ],
    { runtime: "bun" },
  );
  assertSucceeded(result);
  const timeoutStart = result.stdout.indexOf("bun test/js/timeout-budget.test.js (attempt 1, parallel)");
  const firstDone = result.stdout.indexOf("ok bun test/js/pass-fast.test.js");
  assert.ok(timeoutStart >= 0 && firstDone > timeoutStart, result.stdout);
  assert.doesNotMatch(result.stdout, /timeout-budget.*explicit serial/);
});

test("--max-failures stops scheduling and records only terminal failures", (t) => {
  const fixture = createFixture(t);
  const testList = writeTestList(fixture, "fail-first.txt", [
    "test/js/fail-fast.test.js",
    "test/js/pass-after.test.js",
  ]);
  const reportDir = join(dirname(fixture.targetsPath), "fail-fast-report");
  const result = runRunner(
    fixture,
    [
      "--test-list",
      testList,
      "--jobs",
      "1",
      "--no-serial-retry",
      "--max-failures",
      "1",
      "--report-dir",
      reportDir,
    ],
    { runtime: "bun" },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(
    readJsonLines(fixture.bunCapturePath).map((record) => record.path),
    ["test/js/fail-fast.test.js"],
  );
  const terminals = reportEvents(reportDir).filter((event) => event.kind === "terminal");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].unexpected, true);
  const summary = JSON.parse(readFileSync(join(reportDir, "summary.json"), "utf8"));
  assert.equal(summary.planned, 2);
  assert.equal(summary.completed, 1);
  assert.equal(summary.stoppedEarly, true);
});

test("parallel fail-fast cancels in-flight attempts before releasing the lock", (t) => {
  const fixture = createFixture(t);
  const testList = writeTestList(fixture, "parallel-fail-fast.txt", [
    "test/js/fail-fast.test.js",
    "test/js/pass-after.test.js",
  ]);
  const reportDir = join(dirname(fixture.targetsPath), "parallel-fail-fast-report");
  const result = runRunner(
    fixture,
    [
      "--test-list",
      testList,
      "--jobs",
      "2",
      "--no-serial-retry",
      "--max-failures",
      "1",
      "--report-dir",
      reportDir,
    ],
    { runtime: "bun" },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const events = reportEvents(reportDir);
  assert.deepEqual(
    events.filter((event) => event.kind === "terminal").map((event) => event.unitId),
    ["bun:test/js/fail-fast.test.js"],
  );
  assert.ok(events.some((event) =>
    event.kind === "attempt-end" &&
    event.unitId === "bun:test/js/pass-after.test.js" &&
    event.terminal === false
  ));
  for (const invocation of readJsonLines(fixture.bunCapturePath)) {
    for (const ownedTemp of Object.values(invocation.temp)) {
      assert.equal(existsSync(ownedTemp), false, `canceled attempt retained ${ownedTemp}`);
    }
  }
  assert.equal(readdirSync(fixture.locksRoot).length, 0);
});

test("serial confirmation attempts are visible and count one final failure", (t) => {
  const fixture = createFixture(t);
  const reportDir = join(dirname(fixture.targetsPath), "confirmation-report");
  const result = runRunner(
    fixture,
    [
      "--test",
      "test/js/fail-fast.test.js",
      "--jobs",
      "2",
      "--max-failures",
      "1",
      "--report-dir",
      reportDir,
    ],
    { runtime: "bun" },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /attempt 1 done.*awaiting serial confirmation/);
  assert.match(result.stdout, /attempt 2, serial confirmation/);
  assert.deepEqual(
    readJsonLines(fixture.bunCapturePath).map((entry) => entry.argv),
    [[], ["--max-concurrency", "1"]],
  );
  const events = reportEvents(reportDir);
  assert.equal(events.filter((event) => event.kind === "attempt-end").length, 2);
  assert.equal(events.filter((event) => event.kind === "terminal").length, 1);
});

test("explicit serial metadata constrains only that file's in-file concurrency", (t) => {
  const fixture = createFixture(t);
  const statusPath = join(fixture.bunSnapshotRoot, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.tests["test/js/pass-fast.test.js"] = { serial: true };
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  const result = runRunner(
    fixture,
    ["--test", "test/js/pass-fast.test.js", "--jobs", "2"],
    { runtime: "bun" },
  );
  assertSucceeded(result);
  assert.deepEqual(readJsonLines(fixture.bunCapturePath)[0].argv, ["--max-concurrency", "1"]);
  assert.match(result.stdout, /explicit serial/);
});

test("focused selectors preserve xfail semantics unless --expect-pass opts in", (t) => {
  const fixture = createFixture(t);
  const statusPath = join(fixture.bunSnapshotRoot, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.tests["test/js/fail-fast.test.js"] = {
    status: "expected-failure",
    reason: "fixture xfail",
  };
  status.tests["test/js/pass-fast.test.js"] = {
    status: "expected-failure",
    reason: "fixture XPASS",
  };
  writeFileSync(statusPath, JSON.stringify(status, null, 2));
  const testList = writeTestList(fixture, "xfail-list.txt", [
    "test/js/fail-fast.test.js",
    "test/js/pass-fast.test.js",
  ]);
  const preserved = runRunner(
    fixture,
    ["--test-list", testList, "--jobs", "2"],
    { runtime: "bun" },
  );
  assert.equal(preserved.status, 1, preserved.stdout + preserved.stderr);
  assert.match(preserved.stdout, /xfail bun test\/js\/fail-fast\.test\.js/);
  assert.match(preserved.stdout, /XPASS bun test\/js\/pass-fast\.test\.js/);
  assert.doesNotMatch(preserved.stdout, /serial confirmation/);
  assert.equal(readJsonLines(fixture.bunCapturePath).length, 2);

  const optedIn = runRunner(
    fixture,
    ["--test", "test/js/pass-fast.test.js", "--expect-pass", "--jobs", "2"],
    { runtime: "bun" },
  );
  assertSucceeded(optedIn);
  assert.match(optedIn.stdout, /ok bun test\/js\/pass-fast\.test\.js/);
});

test("focused selectors cannot cross status or repository ownership boundaries", (t) => {
  const fixture = createFixture(t);
  const statusPath = join(fixture.bunSnapshotRoot, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.tests["test/js/pass-fast.test.js"] = {
    status: "skip",
    owner: "hutch-package-manager",
    reason: "owned by Hutch",
  };
  status.tests["test/js/pass-after.test.js"] = {
    status: "not-enabled",
    reason: "diagnostic tier",
  };
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);

  const owned = runRunner(
    fixture,
    ["--test", "test/js/pass-fast.test.js"],
    { runtime: "bun" },
  );
  assert.equal(owned.status, 1);
  assert.match(owned.stderr, /owned by hutch-package-manager, not Cottontail/);
  assert.deepEqual(readJsonLines(fixture.bunCapturePath), []);

  const disabledByDefault = runRunner(
    fixture,
    ["--test", "test/js/pass-after.test.js"],
    { runtime: "bun" },
  );
  assert.equal(disabledByDefault.status, 1);
  assert.match(disabledByDefault.stderr, /is not-enabled/);

  const diagnosticOptIn = runRunner(
    fixture,
    ["--test", "test/js/pass-after.test.js", "--only-status", "not-enabled"],
    { runtime: "bun" },
  );
  assertSucceeded(diagnosticOptIn);
});

test("all-skipped and all-TODO expected failures are platform skips, not XPASS", async (t) => {
  for (const [label, summary] of [
    ["skipped", "\n 0 pass\n 1 skipped\n 0 fail\n 0 expect() calls\nRan 1 test across 1 file.\n"],
    ["TODO", "\n 0 pass\n 4 todo\n 0 fail\n 0 expect() calls\nRan 4 tests across 1 file.\n"],
  ]) {
    await t.test(label, () => {
      const fixture = createFixture(t);
      const statusPath = join(fixture.bunSnapshotRoot, "status.json");
      const status = JSON.parse(readFileSync(statusPath, "utf8"));
      status.tests["test/js/pass-fast.test.js"] = {
        status: "expected-failure",
        reason: "platform gated",
        env: { COTTONTAIL_RUNNER_TEST_SUMMARY: summary },
      };
      writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
      const result = runRunner(
        fixture,
        ["--test", "test/js/pass-fast.test.js"],
        { runtime: "bun" },
      );
      assertSucceeded(result);
      assert.match(result.stdout, /skip bun test\/js\/pass-fast\.test\.js/);
      assert.doesNotMatch(result.stdout, /XPASS/);
    });
  }
});

test("split bundler discovery fails closed on incomplete output", async (t) => {
  for (const [mode, expected, environment] of [
    ["nonzero", /discovery must exit cleanly/, {}],
    ["timeout", /discovery must exit cleanly/, {}],
    ["partial", /final record was truncated/, {}],
    [
      "truncated",
      process.platform === "win32" ? /discovery must exit cleanly/ : /final record was truncated/,
      { COTTONTAIL_UPSTREAM_TEST_MAX_BUFFER: "256" },
    ],
  ]) {
    await t.test(mode, () => {
      const fixture = createFixture(t);
      const path = installBundlerDiscoveryFixture(fixture, mode);
      const result = runRunner(
        fixture,
        ["--test", path],
        { runtime: "bun", environment },
      );
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, expected);
    });
  }
});

test("split bundler discovery groups duplicate scoped case IDs", (t) => {
  const fixture = createFixture(t);
  const path = installBundlerDiscoveryFixture(fixture, "duplicate");
  const result = runRunner(fixture, ["--test", path], { runtime: "bun" });
  assertSucceeded(result);
  assert.match(
    result.stdout,
    /\[1\/1\] ok bun test\/bundler\/discovery\.test\.js \[case\/one\] \(2 tests, 2 assertions\)/,
  );
});

test("resume skips matching passes, reruns failures, and rejects changed tests", (t) => {
  const fixture = createFixture(t);
  const testList = writeTestList(fixture, "resume-tests.txt", [
    "test/js/pass-fast.test.js",
    "test/js/fail-fast.test.js",
  ]);
  const reportDir = join(dirname(fixture.targetsPath), "resume-report");
  const common = [
    "--test-list",
    testList,
    "--jobs",
    "1",
    "--no-serial-retry",
    "--max-failures",
    "1",
  ];
  const first = runRunner(
    fixture,
    [...common, "--report-dir", reportDir],
    { runtime: "bun" },
  );
  assert.equal(first.status, 1, first.stdout + first.stderr);
  appendFileSync(join(reportDir, "events.jsonl"), '{"interrupted":');

  const resumed = runRunner(
    fixture,
    [...common, "--resume", reportDir],
    { runtime: "bun" },
  );
  assert.equal(resumed.status, 1, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, /resume ok bun:test\/js\/pass-fast\.test\.js/);
  assert.deepEqual(
    readJsonLines(fixture.bunCapturePath).map((record) => record.path),
    ["test/js/fail-fast.test.js"],
  );

  writeFileSync(
    join(fixture.bunSnapshotRoot, "test/js/pass-fast.test.js"),
    "process.exit(0); // changed after checkpoint\n",
  );
  const changed = runRunner(
    fixture,
    [...common, "--resume", reportDir],
    { runtime: "bun" },
  );
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /Cannot resume JavaScript baseline suite: bun plan or test hashes changed/);
});

test("a live baseline-suite lock rejects a competitor and a proven stale lock is reclaimed", async (t) => {
  const fixture = createFixture(t);
  const firstReport = join(dirname(fixture.targetsPath), "lock-owner-report");
  const env = {
    ...process.env,
    COTTONTAIL_UPSTREAM_TARGETS_PATH: fixture.targetsPath,
    COTTONTAIL_RUNNER_TEST_CAPTURE: fixture.capturePath,
    COTTONTAIL_RUNNER_BUN_CAPTURE: fixture.bunCapturePath,
    COTTONTAIL_BASELINE_REPORTS_DIR: fixture.reportsRoot,
    COTTONTAIL_BASELINE_LOCK_DIR: fixture.locksRoot,
    COTTONTAIL_BASELINE_STATE_DIR: fixture.stateRoot,
    COTTONTAIL_RUNNER_TEST_DELAY_MS: "700",
  };
  const child = spawn(process.execPath, [
    runnerPath,
    "bun",
    "--binary",
    fixture.cottontailBinaryPath,
    "--test",
    "test/js/pass-after.test.js",
    "--report-dir",
    firstReport,
  ], { cwd: rootDir, env, encoding: "utf8" });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });

  const deadline = Date.now() + 3000;
  while ((!existsSync(fixture.locksRoot) || readdirSync(fixture.locksRoot).length === 0) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.ok(existsSync(fixture.locksRoot) && readdirSync(fixture.locksRoot).length > 0);
  const lockName = readdirSync(fixture.locksRoot)[0];

  const competitor = runRunner(
    fixture,
    ["--test", "test/js/pass-fast.test.js"],
    { runtime: "bun" },
  );
  assert.equal(competitor.status, 1);
  assert.match(competitor.stderr, /JavaScript baseline suite is already running as PID/);

  const firstStatus = await new Promise((resolveStatus) => child.on("close", resolveStatus));
  assert.equal(firstStatus, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);

  const staleLock = join(fixture.locksRoot, lockName);
  mkdirSync(staleLock);
  writeFileSync(join(staleLock, "owner.json"), JSON.stringify({
    schema: 1,
    token: "proven-stale-fixture",
    pid: 2_000_000_000,
    hostname: hostname(),
    activeChildren: [],
  }));
  const reclaimed = runRunner(
    fixture,
    ["--test", "test/js/pass-fast.test.js"],
    { runtime: "bun" },
  );
  assertSucceeded(reclaimed);
  assert.equal(existsSync(staleLock), false);
});
