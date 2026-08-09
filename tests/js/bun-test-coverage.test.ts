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

test("coverage distinguishes generated ESM wrappers from user callbacks", () => {
  const directory = fixture({
    "sample.test.ts": `
import { expect, test } from "bun:test";
import { api, callback } from "./source";
test("coverage", () => {
  expect(typeof api).toBe("object");
  expect(typeof callback).toBe("function");
});
`,
    "source.ts": `
export const api = { __esmForce(callback) { return callback; } };
export const callback = api.__esmForce(() => "not called");
`,
  });
  try {
    const result = run(directory, [
      "--coverage",
      "--coverage-reporter=lcov",
      "--coverage-dir=artifacts",
      "sample.test.ts",
    ]);
    expect(result.exitCode, result.stderrText).toBe(0);
    const lcov = readFileSync(join(directory, "artifacts", "lcov.info"), "utf8");
    const sourceRecord = lcov.match(/SF:source\.ts\n([\s\S]*?)end_of_record/)?.[1] ?? "";
    // The object method ran and the returned callback did not. The synthetic
    // init_source wrapper must not become a third source-level function.
    expect(sourceRecord).toContain("FNF:2");
    expect(sourceRecord).toContain("FNH:1");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coverage does not attribute module initializer ranges to user functions", () => {
  const directory = fixture({
    "demo1.ts": `
export class Y {
#hello;
};
`,
    "demo2.ts": `
import { Y } from "./demo1";

export function covered() {
  // this function IS covered
  return Y;
}

export function uncovered() {
  // this function is not covered
  return 42;
}

covered();
`,
  });
  try {
    const result = run(directory, [
      "--coverage",
      "--coverage-reporter=lcov",
      "--coverage-dir=artifacts",
      "./demo2.ts",
    ]);
    expect(result.exitCode, result.stderrText).toBe(0);
    const lcov = readFileSync(join(directory, "artifacts", "lcov.info"), "utf8");
    const demo1 = lcov.match(/SF:demo1\.ts\n([\s\S]*?)end_of_record/)?.[1] ?? "";
    const demo2 = lcov.match(/SF:demo2\.ts\n([\s\S]*?)end_of_record/)?.[1] ?? "";
    expect(demo1).toContain("FNF:1\nFNH:0");
    expect(demo2).toContain("FNF:2\nFNH:1");
    expect(demo2).toMatch(/^DA:4,[1-9]\d*$/m);
    expect(demo2).toMatch(/^DA:6,[1-9]\d*$/m);
    expect(demo2).toMatch(/^DA:14,[1-9]\d*$/m);
    expect(demo2).toContain("DA:9,0\nDA:10,0\nDA:11,1");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coverage preserves nested user functions inside an executed declaration", () => {
  const directory = fixture({
    "sample.test.ts": `
import { expect, test } from "bun:test";
import "./source";
test("nested coverage", () => expect(true).toBe(true));
`,
    "source.ts": `
export function outer() {
  const never = () => 1;
}

outer();
`,
  });
  try {
    const result = run(directory, [
      "--coverage",
      "--coverage-reporter=lcov",
      "--coverage-dir=artifacts",
      "./sample.test.ts",
    ]);
    expect(result.exitCode, result.stderrText).toBe(0);
    const lcov = readFileSync(join(directory, "artifacts", "lcov.info"), "utf8");
    const source = lcov.match(/SF:source\.ts\n([\s\S]*?)end_of_record/)?.[1] ?? "";
    expect(source).toContain("FNF:2\nFNH:1");
    expect(source).toMatch(/^DA:2,[1-9]\d*$/m);
    expect(source).toMatch(/^DA:6,[1-9]\d*$/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
