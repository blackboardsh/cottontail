import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "cottontail-version-identity-"));
const nestedTest = join(directory, "nested.test.js");
const packageVersion = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")).version;
writeFileSync(nestedTest, 'console.log("nested-test-body");\n');

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function cleanEnvironment() {
  const environment = { ...process.env };
  delete environment.COTTONTAIL_TEST_CLI_HEADER_PRINTED;
  delete environment.COTTONTAIL_UPSTREAM_VERSION;
  return environment;
}

function run(args: string[], environment = cleanEnvironment()) {
  return Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd: directory,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("nested test banners default to the Bun compatibility version", () => {
  const result = run(["test", nestedTest]);
  expect(result.exitCode).toBe(0);
  expect(String(result.stdout)).toContain("bun test v1.3.10 (cottontail)");
  expect(String(result.stdout)).toContain("nested-test-body");
});

test("nested test banners retain the upstream-version override", () => {
  const environment = cleanEnvironment();
  environment.COTTONTAIL_UPSTREAM_VERSION = "9.8.7";
  const result = run(["test", nestedTest], environment);
  expect(result.exitCode).toBe(0);
  expect(String(result.stdout)).toContain("bun test v9.8.7 (cottontail)");
});

test("version flags use production identity unless compatibility is requested", () => {
  expect(String(run(["--version"]).stdout).trim()).toBe(packageVersion);

  const environment = cleanEnvironment();
  environment.COTTONTAIL_UPSTREAM_VERSION = "9.8.7";
  expect(String(run(["-v"], environment).stdout).trim()).toBe("9.8.7");
  expect(String(run(["--revision"], environment).stdout).trim()).toBe("9.8.7+cottontail");
});
