import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = join(rootDir, "scripts", "run-upstream-tests.js");

function createFixture(t) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "cottontail-upstream-runner-"));
  const snapshotRoot = join(fixtureRoot, "node-snapshot");
  const capturePath = join(fixtureRoot, "harness-invocations.jsonl");
  const targetsPath = join(fixtureRoot, "targets.json");
  const preflightShimPath = join(fixtureRoot, "preflight-shim.cjs");
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

  return {
    capturePath,
    preflightShimPath,
    snapshotRoot,
    targetsPath,
  };
}

function runRunner(fixture, args, {
  validCottontail = true,
  environment = {},
} = {}) {
  writeFileSync(fixture.capturePath, "");
  const env = {
    ...process.env,
    COTTONTAIL_UPSTREAM_TARGETS_PATH: fixture.targetsPath,
    COTTONTAIL_RUNNER_TEST_CAPTURE: fixture.capturePath,
    ...environment,
  };
  if (validCottontail) {
    env.COTTONTAIL_UPSTREAM_RUNNER_TEST_NODE_OPTIONS =
      `--require=${fixture.preflightShimPath}`;
  }
  return spawnSync(
    process.execPath,
    [
      runnerPath,
      "node",
      "--binary",
      process.execPath,
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

function assertSucceeded(result) {
  assert.equal(
    result.status,
    0,
    `runner exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function harnessArgs(...selectors) {
  return ["--shell", process.execPath, "-j4", "--report", ...selectors];
}

test("Node CLI filters pass only their selected paths to tools/test.py", async (t) => {
  const fixture = createFixture(t);

  await t.test("--match", () => {
    const result = runRunner(fixture, ["--match", "^test/parallel/test-alpha\\.js$"]);
    assertSucceeded(result);
    assert.match(result.stdout, /discovered runnable files: 3/);
    assert.deepEqual(
      readInvocations(fixture.capturePath),
      [harnessArgs("parallel/test-alpha")],
    );
  });

  await t.test("--max-tests", () => {
    const result = runRunner(fixture, ["--max-tests", "1"]);
    assertSucceeded(result);
    assert.deepEqual(
      readInvocations(fixture.capturePath),
      [harnessArgs("parallel/test-alpha")],
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
      [harnessArgs("parallel/test-beta")],
    );
  });

  await t.test("--test", () => {
    const result = runRunner(fixture, ["--test", "test/sequential/test-gamma.js"]);
    assertSucceeded(result);
    assert.deepEqual(
      readInvocations(fixture.capturePath),
      [harnessArgs("sequential/test-gamma")],
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
      harnessArgs("parallel/test-alpha", "sequential/test-gamma"),
      harnessArgs("parallel/test-beta"),
    ],
  );
  assert.match(result.stdout, /1 expected failure/);
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
      harnessArgs("parallel/test-alpha"),
      harnessArgs("sequential/test-gamma"),
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
    [harnessArgs("parallel/test-collision")],
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
    [harnessArgs("parallel/test-alpha")],
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
    [harnessArgs("parallel/test-alpha")],
  );
});

test("an empty Node selection fails before tools/test.py is invoked", (t) => {
  const fixture = createFixture(t);
  const result = runRunner(fixture, ["--match", "does-not-match"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No node upstream tests matched the requested selection/);
  assert.deepEqual(readInvocations(fixture.capturePath), []);
});
