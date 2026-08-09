import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "cottontail-runtime-define-"));
const entry = join(root, "entry.mjs");
const testEntry = join(root, "defined.test.ts");
const patternTestEntry = join(root, "define-pattern.test.ts");

writeFileSync(
  entry,
  `console.log(JSON.stringify({ url: import.meta.url, argv: process.argv.slice(2) }));\n`,
);
writeFileSync(
  testEntry,
  `import { expect, test } from "bun:test";
declare const EXPECTED_DEFINE: string;
test("runtime define reached the test bundle", () => expect(import.meta.url).toBe(EXPECTED_DEFINE));
`,
);
writeFileSync(
  patternTestEntry,
  `import { expect, test } from "bun:test";
test("--define=NOT_A_RUNTIME_FLAG", () => expect(true).toBe(true));
`,
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[]) {
  const child = Bun.spawnSync([process.execPath, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

test("runtime --define consumes a spaced value and replaces import.meta.url", () => {
  const result = run(["--define", 'import.meta.url="spaced-url"', entry]);

  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toEqual({ url: "spaced-url", argv: [] });
});

test("runtime --define=value accepts a colon payload and uses the last definition", () => {
  const result = run([
    '--define=import.meta.url="first-url"',
    '--define=import.meta.url:"last-url"',
    entry,
  ]);

  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toEqual({ url: "last-url", argv: [] });
});

test("runtime -d accepts spaced and attached forms", () => {
  const spaced = run(["-d", 'import.meta.url:"short-spaced"', entry]);
  const attached = run([
    '-dimport.meta.url="short-attached"',
    '-d=import.meta.url:"short-equals"',
    entry,
  ]);

  expect({ exitCode: spaced.exitCode, stderr: spaced.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(spaced.stdout)).toEqual({ url: "short-spaced", argv: [] });
  expect({ exitCode: attached.exitCode, stderr: attached.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(attached.stdout)).toEqual({ url: "short-equals", argv: [] });
});

test("runtime defines route through the test subcommand and leading runtime position", () => {
  const afterCommand = run([
    "test",
    "--define",
    'import.meta.url:"test-command-url"',
    '--define=EXPECTED_DEFINE:"test-command-url"',
    testEntry,
  ]);
  const beforeCommand = run([
    '-dimport.meta.url:"leading-test-url"',
    '-dEXPECTED_DEFINE:"leading-test-url"',
    "test",
    testEntry,
  ]);

  expect(afterCommand.exitCode).toBe(0);
  expect(`${afterCommand.stdout}\n${afterCommand.stderr}`).toContain("1 pass");
  expect(beforeCommand.exitCode).toBe(0);
  expect(`${beforeCommand.stdout}\n${beforeCommand.stderr}`).toContain("1 pass");
});

test("--define after the entrypoint remains a script argument", () => {
  const result = run([entry, "--define", 'import.meta.url="script-argument"']);

  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toEqual({
    url: pathToFileURL(realpathSync(entry)).href,
    argv: ["--define", 'import.meta.url="script-argument"'],
  });
});

test("define-looking eval source remains the eval value", () => {
  const result = run(["-e", 'console.log("--define=NOT_A_FLAG")']);

  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(result.stdout).toBe("--define=NOT_A_FLAG\n");
});

test("define-looking test option values remain option values", () => {
  const result = run([
    "test",
    "--test-name-pattern",
    "--define=NOT_A_RUNTIME_FLAG",
    patternTestEntry,
  ]);

  expect(result.exitCode).toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("1 pass");
});

test("malformed and missing runtime defines fail explicitly", () => {
  const malformed = run(["--define=NO_SEPARATOR", entry]);
  const missing = run(["-d"]);

  expect(malformed.exitCode).not.toBe(0);
  expect(malformed.stderr).toContain('expected ":" separator');
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr).toContain("requires a value");
});
