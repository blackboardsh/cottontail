import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-compiler-diagnostics-"));
const childEnvironment = { ...process.env, CI: "false" };
delete childEnvironment.BUN_OPTIONS;
delete childEnvironment.COTTONTAIL_TEST_CLI_HEADER_PRINTED;

afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(name: string, files: Record<string, string>) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  for (const [path, source] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, source);
  }
  return directory;
}

function run(directory: string, args: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd: directory,
    env: childEnvironment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

const directRunCases = [
  {
    name: "missing named export",
    command: ["run", "b.ts"],
    files: {
      "a.ts": "",
      "b.ts": 'import { not_found } from "./a"; console.log(not_found);\n',
    },
    expected: "SyntaxError: Export named 'not_found' not found in module '",
    suggestion: false,
  },
  {
    name: "missing named export suggests default",
    command: ["run", "b.ts"],
    files: {
      "a.ts": "export default function not_found() {};\n",
      "b.ts": 'import { not_found } from "./a"; console.log(not_found);\n',
    },
    expected: "SyntaxError: Export named 'not_found' not found in module '",
    suggestion: true,
  },
  {
    name: "type-only export is missing at runtime",
    command: ["run", "b.ts"],
    files: {
      "a.ts": 'export type not_found = "not_found";\n',
      "b.ts": 'import { not_found } from "./a"; console.log(not_found);\n',
    },
    expected: "SyntaxError: Export named 'not_found' not found in module '",
    suggestion: false,
  },
  {
    name: "JavaScript imports a TypeScript type",
    command: ["b.js"],
    files: {
      "b.js": "import {type_only} from './ts.ts';\n",
      "ts.ts": "export type type_only = 'type_only';\n",
    },
    expected: "SyntaxError: Export named 'type_only' not found in module '",
    suggestion: false,
  },
  {
    name: "JavaScript type import suggests default",
    command: ["b.js"],
    files: {
      "b.js": "import {type_only} from './ts.ts';\n",
      "ts.ts": "export type type_only = 'type_only'; export default function type_only() {};\n",
    },
    expected: "SyntaxError: Export named 'type_only' not found in module '",
    suggestion: true,
  },
  {
    name: "direct through-export reports its source",
    command: ["b.js"],
    files: {
      "b.js": "export {type_only} from './ts.ts';\n",
      "ts.ts": "export type type_only = 'type_only'; export default function type_only() {};\n",
    },
    expected: "SyntaxError: export 'type_only' not found in './ts.ts'",
  },
  {
    name: "imported through-export reports its source",
    command: ["b.js"],
    files: {
      "b.js": "import {type_only} from './ts.ts'; export {type_only};\n",
      "ts.ts": "export type type_only = 'type_only'; export default function type_only() {};\n",
    },
    expected: "SyntaxError: export 'type_only' not found in './ts.ts'",
  },
] as const;

for (const [index, scenario] of directRunCases.entries()) {
  test(`direct-run linker diagnostic: ${scenario.name}`, () => {
    const directory = fixture(`direct-${index}`, scenario.files);
    const result = run(directory, [...scenario.command]);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain(scenario.expected);
    if (scenario.suggestion === true) {
      expect(result.stderr).toContain("Did you mean to import default?");
    } else if (scenario.suggestion === false) {
      expect(result.stderr).not.toContain("Did you mean to import default?");
    }
  });
}

test("bun test tsconfig override reports unresolved imports as missing modules", () => {
  const directory = fixture("test-tsconfig-override", {
    "math.test.ts": `
      import { describe, test, expect } from "bun:test";
      import { add } from "@utils/math";
      describe("math", () => {
        test("addition", () => expect(add(2, 3)).toBe(5));
      });
    `,
    "src/math.ts": "export function add(a: number, b: number) { return a + b; }\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@utils/*": ["./wrong/*"] } } }),
    "test-tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@utils/*": ["./src/*"] } } }),
  });

  const failed = run(directory, ["test", "math.test.ts"]);
  expect(failed.exitCode).not.toBe(0);
  expect(failed.stderr).toContain("Cannot find module");

  const passed = run(directory, ["test", "--tsconfig-override", "test-tsconfig.json", "math.test.ts"]);
  expect(passed.exitCode, `${passed.stdout}\n${passed.stderr}`).toBe(0);
  expect(passed.stdout + passed.stderr).toContain("1 pass");
  expect(passed.stdout + passed.stderr).toContain("addition");
}, { timeout: 30_000 });
