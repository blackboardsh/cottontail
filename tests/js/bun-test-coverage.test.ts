import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function fixture(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-test-coverage-"));
  for (const [name, source] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  return directory;
}

function run(directory: string, args: string[]) {
  const result = Bun.spawnSync([process.execPath, "test", ...args], {
    cwd: directory,
    env: { ...process.env, AGENT: "0", CI: "false", GITHUB_ACTIONS: "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ...result, stderrText: String(result.stderr ?? "") };
}

const testSource = `
import { expect, test } from "bun:test";
import { called } from "./source";

test("coverage", () => {
  expect(called()).toBe("called");
});
`;

const moduleSource = `
export function called() {
  return "called";
}

export function notCalled() {
  return "not called";
}
`;

test("--coverage reports mapped project sources and skips test files by default", () => {
  const directory = fixture({
    "sample.test.ts": testSource,
    "source.ts": moduleSource,
  });
  try {
    const result = run(directory, ["--coverage", "sample.test.ts"]);
    expect(result.exitCode, result.stderrText).toBe(0);
    expect(result.stderrText).toContain("File");
    expect(result.stderrText).toContain("% Funcs");
    expect(result.stderrText).toMatch(/ source\.ts\s+\|/);
    expect(result.stderrText).not.toMatch(/ sample\.test\.ts\s+\|/);
    expect(result.stderrText).not.toContain("NaN");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bunfig coverage supports reporters, directory, ignore patterns, and test files", () => {
  const directory = fixture({
    "bunfig.toml": `
[test]
coverage = true
coverageReporter = ["text", "lcov"]
coverageDir = "artifacts"
coverageSkipTestFiles = false
coveragePathIgnorePatterns = ["ignored.ts"]
`,
    "sample.test.ts": `
import { expect, test } from "bun:test";
import { included } from "./included";
import { ignored } from "./ignored";
test("coverage", () => {
  expect(included()).toBe(1);
  expect(ignored()).toBe(2);
});
`,
    "included.ts": `export function included() { return 1; }`,
    "ignored.ts": `export function ignored() { return 2; }`,
  });
  try {
    const result = run(directory, ["sample.test.ts"]);
    expect(result.exitCode, result.stderrText).toBe(0);
    expect(result.stderrText).toMatch(/ included\.ts\s+\|/);
    expect(result.stderrText).toMatch(/ sample\.test\.ts\s+\|/);
    expect(result.stderrText).not.toMatch(/ ignored\.ts\s+\|/);

    const lcovPath = join(directory, "artifacts", "lcov.info");
    expect(existsSync(lcovPath)).toBe(true);
    const lcov = readFileSync(lcovPath, "utf8");
    expect(lcov).toContain("SF:included.ts");
    expect(lcov).toContain("SF:sample.test.ts");
    expect(lcov).not.toContain("ignored.ts");
    expect(lcov).toContain("end_of_record");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coverageThreshold sets a failing exit code without fabricating a test failure", () => {
  const directory = fixture({
    "bunfig.toml": `
[test]
coverage = true
coverageThreshold = 1.0
`,
    "sample.test.ts": testSource,
    "source.ts": moduleSource,
  });
  try {
    const result = run(directory, ["sample.test.ts"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderrText).toContain("1 pass");
    expect(result.stderrText).toContain("0 fail");
    expect(result.stderrText).toMatch(/ source\.ts\s+\|\s+(?!100\.00)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid coverage reporters fail before test discovery", () => {
  const directory = fixture({ "sample.test.ts": `throw new Error("must not run");` });
  try {
    const result = run(directory, ["--coverage-reporter", "json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderrText).toContain("invalid coverage reporter");
    expect(result.stderrText).not.toContain("must not run");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coverage finalizes for files that register no tests", () => {
  const directory = fixture({ "empty.test.ts": `class Example { #value = 1; }` });
  try {
    const result = run(directory, ["--coverage", "empty.test.ts"]);
    expect(result.exitCode, result.stderrText).toBe(0);
    expect(result.stderrText).toContain("All files");
    expect(result.stderrText).not.toContain("coverage reporter");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
