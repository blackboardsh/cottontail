import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep each static import in its own entrypoint: combining them can select the
// full bootstrap and hide a broken selective alias for another capability.
const modules = [
  ["bun:ffi", "FFIType", "object"], ["bun:sqlite", "Database", "function"],
  ["bun:sql", "SQL", "function"], ["bun:redis", "RedisClient", "function"],
  ["bun:s3", "S3Client", "function"], ["bun:toml", "parse", "function"],
  ["bun:json5", "parse", "function"], ["bun:color", "color", "function"],
  ["bun:jsc", "heapStats", "function"], ["bun:yaml", "parse", "function"],
  ["bun:test", "expect", "function"], ["node:sqlite", "DatabaseSync", "function"],
  ["bun:dns", "lookup", "function"], ["bun:socket", "connect", "function"],
  ["node:test", "test", "function"], ["node:test/reporters", "spec", "function"],
  ["node:zlib", "gzipSync", "function"],
  ...["node:inspector", "inspector", "node:inspector/promises", "inspector/promises"]
    .map(name => [name, "Session", "function"]),
  ...["node:repl", "repl"].map(name => [name, "writer", "function"]),
  ["node:sea", "isSea", "function"],
];
const root = mkdtempSync(join(tmpdir(), "cottontail-capability-entrypoints-"));
const env = { ...process.env, COTTONTAIL_TMP_DIR: join(root, "cache") };
delete env.COTTONTAIL_RUNTIME_MODULES_DIR;
function run(file, specifier) {
  const child = spawnSync(process.execPath, [file], {
    cwd: root, env, encoding: "utf8", timeout: 45_000,
  });
  assert.equal(child.error, undefined, `${specifier}: ${child.error}`);
  assert.equal(child.status, 0, `${specifier}: ${child.stderr}`);
  assert.equal(child.stdout, "entrypoint-ok\n", specifier);
  assert.equal(child.stderr, "", specifier);
}
try {
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  for (const [index, [specifier, key, type]] of modules.entries()) {
    const staticFile = join(root, `static-${index}.mjs`);
    writeFileSync(staticFile, `
      import * as initial from ${JSON.stringify(specifier)};
      if (typeof initial[${JSON.stringify(key)}] !== ${JSON.stringify(type)})
        throw new Error("missing static export in ${specifier}");
      console.log("entrypoint-ok");
    `);
    run(staticFile, specifier);
    const file = join(root, `entry-${index}.mjs`);
    writeFileSync(file, `
      import * as initial from ${JSON.stringify(specifier)};
      const dynamic = await import(${JSON.stringify(specifier)});
      const required = require(${JSON.stringify(specifier)});
      const requiredAgain = require(${JSON.stringify(specifier)});
      for (const module of [initial, dynamic, required, requiredAgain]) {
        if (typeof module[${JSON.stringify(key)}] !== ${JSON.stringify(type)})
          throw new Error("missing export in ${specifier}");
      }
      if (initial[${JSON.stringify(key)}] !== dynamic[${JSON.stringify(key)}] ||
          initial[${JSON.stringify(key)}] !== required[${JSON.stringify(key)}] ||
          required[${JSON.stringify(key)}] !== requiredAgain[${JSON.stringify(key)}])
        throw new Error("different capability instances in ${specifier}");
      ${specifier === "bun:test" ? 'if (Bun.jest(import.meta.path).expect !== initial.expect) throw new Error("different Bun.jest facade"); initial.expect(42).toBe(42);' : ""}
      ${key === "isSea" ? 'if (initial.isSea() !== false) throw new Error("unexpected SEA state");' : ""}
      ${key === "writer" ? 'if (initial.writer(42) !== "42") throw new Error("REPL writer failed");' : ""}
      ${key === "Session" ? 'if (initial.url() !== undefined) throw new Error("import opened an inspector"); new initial.Session();' : ""}
      console.log("entrypoint-ok");
    `);
    run(file, specifier);
  }
  // External builtins must preserve bun: in both bundle formats. In particular,
  // dropping the prefix turns bun:sql into an unrelated npm package named sql.
  const bundleEntry = join(root, "bundle-entry.mjs");
  const externalModules = modules.filter(([name]) => [
    "bun:sql", "bun:redis", "bun:s3", "bun:toml", "bun:json5", "bun:color",
    "bun:yaml", "bun:dns", "bun:socket",
  ].includes(name));
  writeFileSync(bundleEntry, externalModules.map(([name, key, type], index) =>
    `import { ${key} as item${index} } from ${JSON.stringify(name)};
     if (typeof item${index} !== ${JSON.stringify(type)}) throw new Error(${JSON.stringify(name)});`
  ).join("\n") + '\nconsole.log("entrypoint-ok");');
  for (const format of ["esm", "cjs"]) {
    const built = await Bun.build({
      entrypoints: [bundleEntry], target: "bun", format, packages: "external",
    });
    assert.equal(built.success, true, String(built.logs));
    const output = await built.outputs[0].text();
    for (const [name] of externalModules) assert.ok(output.includes(`"${name}"`), `${format}: lost ${name}`);
    const file = join(root, `built.${format === "esm" ? "mjs" : "cjs"}`);
    writeFileSync(file, output);
    run(file, `${format} external builtins`);
  }
  console.log("stdlib capability entrypoints passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
