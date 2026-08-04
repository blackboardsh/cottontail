import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

const fixtureDirectory = realpathSync(
  path.join(import.meta.dir, "fixtures", "esm-lexical-paths", "nested"),
);

function loadFixture(filename: string) {
  const fixturePath = path.join(fixtureDirectory, filename);
  const source = [
    `import(${JSON.stringify(fixturePath)})`,
    ".then(({ lexicalPaths }) => console.log(JSON.stringify(lexicalPaths)))",
    ".catch(error => { console.error(error); process.exitCode = 1; });",
  ].join("");
  const result = spawnSync(process.execPath, ["-e", source], {
    cwd: import.meta.dir,
    encoding: "utf8",
    timeout: 30_000,
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout.trim()) as {
    dirname: string;
    filename: string;
    sibling: string;
  };
}

function expectLexicalPaths(filename: string) {
  const lexicalPaths = loadFixture(filename);
  expect(realpathSync(lexicalPaths.dirname)).toBe(fixtureDirectory);
  expect(realpathSync(lexicalPaths.filename)).toBe(path.join(fixtureDirectory, filename));
  expect(lexicalPaths.sibling).toBe("nested-sibling");
}

test("nested synchronous ESM has module-local __filename and __dirname", () => {
  expectLexicalPaths("sync.mjs");
});

test("nested asynchronous ESM has module-local __filename and __dirname", () => {
  expectLexicalPaths("async.mjs");
});
