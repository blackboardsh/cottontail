import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const scratchRoot = process.env.COTTONTAIL_INIT_TEST_ROOT ?? join(process.cwd(), ".cottontail-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "cli-init-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runInit(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "init", ...args],
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

test("init configures an existing project without replacing user files", () => {
  const directory = join(scratch, "existing-project");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    `{
      // Existing Bun projects commonly use JSONC package metadata.
      "name": "kept-name",
      "module": "index.ts",
      "custom": { "keep": true },
      "devDependencies": { "@types/bun": "latest" },
      "peerDependencies": { "typescript": "^5" },
    }`,
  );
  writeFileSync(join(directory, "index.ts"), "// user entrypoint\n");

  const result = runInit(directory, ["--yes"]);
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);

  const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  expect(packageJson.name).toBe("kept-name");
  expect(packageJson.custom).toEqual({ keep: true });
  expect(packageJson.private).toBe(true);
  expect(readFileSync(join(directory, "index.ts"), "utf8")).toBe("// user entrypoint\n");
  expect(existsSync(join(directory, "tsconfig.json"))).toBe(true);
  expect(existsSync(join(directory, ".gitignore"))).toBe(true);
  expect(readFileSync(join(directory, "README.md"), "utf8")).toContain("bun v1.3.10");
  expect(existsSync(join(directory, "bun.lock"))).toBe(false);
});

test("minimal init omits project extras and agent rules", () => {
  const directory = join(scratch, "minimal-project");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      devDependencies: { "@types/bun": "latest" },
      peerDependencies: { typescript: "^5" },
    }),
  );

  const result = runInit(directory, ["--minimal", "--yes"], { CURSOR_TRACE_ID: "test" });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(existsSync(join(directory, "tsconfig.json"))).toBe(true);
  expect(existsSync(join(directory, "index.ts"))).toBe(false);
  expect(existsSync(join(directory, ".gitignore"))).toBe(false);
  expect(existsSync(join(directory, "README.md"))).toBe(false);
  expect(existsSync(join(directory, ".cursor"))).toBe(false);
});

test("init refuses to replace a destination file", () => {
  const directory = join(scratch, "destination-file");
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, "project");
  writeFileSync(destination, "do not replace\n");

  const result = runInit(directory, ["--yes", "project"]);
  expect(result.exitCode).not.toBe(0);
  expect(readFileSync(destination, "utf8")).toBe("do not replace\n");
});

test("init creates and enters a nested UTF-8 destination", () => {
  const directory = join(scratch, "unicode-destination");
  const destination = join(directory, "u t f ∞™", "subpath");
  mkdirSync(destination, { recursive: true });
  writeFileSync(
    join(destination, "package.json"),
    JSON.stringify({
      name: "unicode-project",
      devDependencies: { "@types/bun": "latest" },
      peerDependencies: { typescript: "^5" },
    }),
  );

  const result = runInit(directory, ["--yes", "u t f ∞™/subpath"]);
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(JSON.parse(readFileSync(join(destination, "package.json"), "utf8")).name).toBe("unicode-project");
  expect(existsSync(join(destination, "index.ts"))).toBe(true);
});

test("init help documents the supported templates", () => {
  const result = runInit(scratch, ["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage: bun init");
  expect(result.stdout).toContain("--react=tailwind");
  expect(result.stdout).toContain("--minimal");
});
