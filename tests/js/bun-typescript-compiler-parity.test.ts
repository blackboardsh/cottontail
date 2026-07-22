import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-bun-typescript-parity-"));
let fixtureIndex = 0;

afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(name: string, files: Record<string, string>) {
  const directory = join(root, `${fixtureIndex++}-${name}`);
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(directory, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return directory;
}

function run(directory: string, entrypoint = "entry.ts", args: string[] = []) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ...args, entrypoint],
    cwd: directory,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function expectSuccess(result: ReturnType<typeof run>) {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
}

test("ships the Bun 1.3.10 public declaration package", () => {
  const packageRoot = join(import.meta.dir, "..", "..", "packages", "bun-types");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  expect({ name: manifest.name, version: manifest.version, types: manifest.types }).toEqual({
    name: "bun-types",
    version: "1.3.10",
    types: "./index.d.ts",
  });

  const index = readFileSync(join(packageRoot, "index.d.ts"), "utf8");
  const references = Array.from(index.matchAll(/reference path="\.\/(.+?)"/g), match => match[1]);
  expect(references).toEqual([
    "globals.d.ts",
    "s3.d.ts",
    "fetch.d.ts",
    "bun.d.ts",
    "extensions.d.ts",
    "devserver.d.ts",
    "ffi.d.ts",
    "html-rewriter.d.ts",
    "jsc.d.ts",
    "sqlite.d.ts",
    "test.d.ts",
    "wasm.d.ts",
    "overrides.d.ts",
    "deprecated.d.ts",
    "redis.d.ts",
    "shell.d.ts",
    "serve.d.ts",
    "sql.d.ts",
    "security.d.ts",
    "bundle.d.ts",
    "bun.ns.d.ts",
  ]);
  for (const reference of references) expect(existsSync(join(packageRoot, reference))).toBe(true);
});

test("erases type-only names across representative re-export forms", () => {
  const variants = {
    "export-from": `export { my_string, my_value, my_only } from "./a.ts";`,
    "import-then-export": `
      import { my_string, my_value, my_only } from "./a.ts";
      export { my_string, my_value, my_only };
    `,
    "export-star": `export * from "./a.ts";`,
    "export-star-merge": `export * from "./a-no-value.ts"; export * from "./a-with-value.ts";`,
  };

  for (const [name, reexport] of Object.entries(variants)) {
    const directory = fixture(name, {
      "a.ts": `
        export type my_string = "1";
        export type my_value = "2";
        export const my_value = "2";
        export const my_only = "3";
      `,
      "a-no-value.ts": `
        export type my_string = "1";
        export type my_value = "2";
        export const my_only = "3";
      `,
      "a-with-value.ts": `export type my_string = "1"; export const my_value = "2";`,
      "b.ts": reexport,
      "entry.ts": `import * as values from "./b.ts"; console.log(JSON.stringify(values));`,
    });
    const result = run(directory);
    expectSuccess(result);
    expect(JSON.parse(result.stdout)).toEqual({ my_only: "3", my_value: "2" });
  }
});

test("accepts explicit export type chains without creating runtime exports", () => {
  const directory = fixture("explicit-export-type", {
    "source.ts": `export type Type = string;`,
    "reexport.ts": `export type { Type } from "./source.ts";`,
    "entry.ts": `import { Type } from "./reexport.ts"; const value: Type = "ok"; console.log(value);`,
  });
  const result = run(directory);
  expectSuccess(result);
  expect(result.stdout).toBe("ok");
});

test("uses import attributes for static and dynamic loader selection", () => {
  const staticText = fixture("static-text-attribute", {
    payload: "hello from text loader\n",
    "entry.ts": `import text from "./payload" with { type: "text" }; console.log(JSON.stringify(text));`,
  });
  const staticTextResult = run(staticText);
  expectSuccess(staticTextResult);
  expect(JSON.parse(staticTextResult.stdout)).toBe("hello from text loader\n");

  const staticTypeScript = fixture("static-ts-attribute", {
    module: `export const answer: number = 42;`,
    "entry.ts": `import { answer } from "./module" with { type: "ts" }; console.log(answer);`,
  });
  const staticTypeScriptResult = run(staticTypeScript);
  expectSuccess(staticTypeScriptResult);
  expect(staticTypeScriptResult.stdout).toBe("42");

  const dynamicText = fixture("dynamic-text-attribute", {
    payload: "hello from dynamic text loader\n",
    "entry.ts": `
      const value = await import("./payload", { with: { type: "text" } });
      console.log(JSON.stringify(value.default));
    `,
  });
  const dynamicTextResult = run(dynamicText);
  expectSuccess(dynamicTextResult);
  expect(JSON.parse(dynamicTextResult.stdout)).toBe("hello from dynamic text loader\n");
});

test("resolves tsconfig paths automatically and through an override", () => {
  const compilerOptions = {
    baseUrl: ".",
    moduleResolution: "bundler",
    paths: { "@lane/*": ["src/*"] },
  };
  const automatic = fixture("automatic-tsconfig", {
    "tsconfig.json": JSON.stringify({ compilerOptions }),
    "src/value.ts": `export const value = "automatic";`,
    "entry.ts": `import { value } from "@lane/value"; console.log(value);`,
  });
  const automaticResult = run(automatic);
  expectSuccess(automaticResult);
  expect(automaticResult.stdout).toBe("automatic");

  const override = fixture("override-tsconfig", {
    "tsconfig.json": JSON.stringify({ compilerOptions: { ...compilerOptions, paths: { "@lane/*": ["wrong/*"] } } }),
    "custom.json": JSON.stringify({ compilerOptions }),
    "src/value.ts": `export const value = "override";`,
    "entry.ts": `import { value } from "@lane/value"; console.log(value);`,
  });
  const overrideResult = run(override, "entry.ts", ["--tsconfig-override", "custom.json"]);
  expectSuccess(overrideResult);
  expect(overrideResult.stdout).toBe("override");
});

test("inherits tsconfig path resolution through extends", () => {
  const directory = fixture("inherited-tsconfig", {
    "base.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        moduleResolution: "bundler",
        paths: { "@inherited/*": ["src/*"] },
      },
    }),
    "tsconfig.json": JSON.stringify({ extends: "./base.json" }),
    "src/value.ts": `export const value = "inherited";`,
    "entry.ts": `import { value } from "@inherited/value"; console.log(value);`,
  });
  const result = run(directory);
  expectSuccess(result);
  expect(result.stdout).toBe("inherited");
});

test("reports precise missing type-value linkage diagnostics", () => {
  const missing = fixture("missing-type-value", {
    "types.ts": `export type type_only = "type_only";`,
    "entry.js": `import { type_only } from "./types.ts"; console.log(type_only);`,
  });
  const missingResult = run(missing, "entry.js");
  expect(missingResult.exitCode).toBe(1);
  expect(missingResult.stdout).toBe("");
  expect(missingResult.stderr).toMatch(
    /SyntaxError: Export named 'type_only' not found in module '|error: No matching export in "types\.ts" for import "type_only"/,
  );
  expect(missingResult.stderr).not.toContain("Did you mean to import default?");

  const defaultSuggestion = fixture("missing-type-value-default", {
    "types.ts": `export type type_only = "type_only"; export default function type_only() {}`,
    "entry.js": `import { type_only } from "./types.ts"; console.log(type_only);`,
  });
  const defaultResult = run(defaultSuggestion, "entry.js");
  expect(defaultResult.exitCode).toBe(1);
  if (defaultResult.stderr.includes('error: No matching export in "types.ts" for import "type_only"')) {
    expect(defaultResult.stderr).not.toContain("Did you mean to import default?");
  } else {
    expect(defaultResult.stderr).toContain("SyntaxError: Export named 'type_only' not found in module '");
    expect(defaultResult.stderr).toContain("Did you mean to import default?");
  }

  const throughExport = fixture("missing-through-export", {
    "types.ts": `export type type_only = "type_only"; export default function type_only() {}`,
    "entry.js": `export { type_only } from "./types.ts";`,
  });
  const throughResult = run(throughExport, "entry.js");
  expect(throughResult.exitCode).toBe(1);
  expect(throughResult.stderr).toMatch(
    /SyntaxError: export 'type_only' not found in '\.\/types\.ts'|error: No matching export in "types\.ts" for import "type_only"/,
  );
});

test("reports duplicate and ambiguous exports precisely", () => {
  const duplicate = fixture("duplicate-export", {
    "source.js": `export const value = "source";`,
    "duplicate.js": `export { value } from "./source.js"; export const value = "local";`,
    "entry.js": `import { value } from "./duplicate.js"; console.log(value);`,
  });
  const duplicateResult = run(duplicate, "entry.js");
  expect(duplicateResult.exitCode).toBe(1);
  expect(duplicateResult.stderr).toMatch(
    /SyntaxError: Cannot export a duplicate name 'value'\.|error: Multiple exports with the same name "value"/,
  );

  const ambiguous = fixture("ambiguous-export", {
    "left.ts": `export const value = "left";`,
    "right.ts": `export const value = "right";`,
    "barrel.ts": `export * from "./left.ts"; export * from "./right.ts";`,
    "entry.ts": `import { value } from "./barrel.ts"; console.log(value);`,
  });
  const ambiguousResult = run(ambiguous);
  expect(ambiguousResult.exitCode).toBe(1);
  expect(ambiguousResult.stderr).toMatch(
    /SyntaxError: Export named 'value' cannot be resolved due to ambiguous multiple bindings in module|error: Ambiguous import "value" has multiple matching exports/,
  );
});
