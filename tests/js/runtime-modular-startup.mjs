import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-modular-startup-"));
const binary = process.execPath;
const env = { ...process.env, COTTONTAIL_TMP_DIR: join(root, "cache") };
delete env.COTTONTAIL_RUNTIME_MODULES_DIR;

function run(file, expected = "", args = [], overrides = {}) {
  // Exercise both freshly generated launchers and their cached bytecode.
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawnSync(binary, [...args, file], {
      cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 45_000,
    });
    assert.equal(child.error, undefined, `${file}: ${child.error}`);
    assert.equal(child.status, 0, `${file}: ${child.stderr}`);
    assert.equal(child.stderr, "", file);
    assert.equal(child.stdout, expected, file);
  }
}

try {
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const sources = ["", "// comment only\n", "void 0;\n", "export {};\n", '"use strict";\n'];
  for (const extension of ["js", "mjs", "ts"]) {
    const cases = extension === "ts" ? [...sources, "interface Empty {}\ntype Nothing = never;\n"] : sources;
    for (const [index, source] of cases.entries()) {
      const name = `empty-${index}.${extension}`;
      const file = join(root, name);
      writeFileSync(file, source);
      run(file);
      const importer = join(root, `import-${index}-${extension}.mjs`);
      writeFileSync(importer, `
        import * as initial from "./${name}";
        const again = await import("./${name}");
        if (initial !== again) throw new Error("different import namespace");
        if (Object.keys(again).length !== 0) throw new Error("unexpected exports");
        console.log("empty-import-ok");
      `);
      run(importer, "empty-import-ok\n");
    }
  }

  // No imports: these must take the selective SQL bootstrap, not the full
  // compatibility path that previously hid its stale embedded-source import.
  for (const property of ["SQL", "sql", "postgres"]) {
    const file = join(root, `sql-${property}.js`);
    writeFileSync(file, `
      if (typeof Bun.${property} !== "function") throw new Error("missing SQL API");
      if (Bun.sql !== Bun.postgres) throw new Error("different SQL aliases");
      console.log("sql-startup-ok");
    `);
    run(file, "sql-startup-ok\n");
  }
  const identity = join(root, "sql-identity.mjs");
  writeFileSync(identity, `
    import { SQL, sql } from "bun:sql";
    // Bun globals are lazy compatibility facades; the module imports and
    // capability namespace expose the underlying implementation functions.
    if (SQL !== Cottontail.sql.SQL || sql !== Cottontail.sql.sql)
      throw new Error("different SQL capability instances");
    console.log("sql-identity-ok");
  `);
  run(identity, "sql-identity-ok\n");
  const preconnect = join(root, "sql-preconnect.js");
  writeFileSync(preconnect, `
    if (typeof Bun.SQL !== "function") throw new Error("missing SQL API");
    await Bun.sql.close();
    console.log("sql-preconnect-ok");
  `);
  run(preconnect, "sql-preconnect-ok\n", ["--sql-preconnect"], { DATABASE_URL: "sqlite://:memory:" });
  console.log("runtime modular startup passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
