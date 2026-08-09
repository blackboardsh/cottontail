import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cottontail-build-html-")));

// Keep an escaped template literal before the import-looking fixture strings.
// The runtime compatibility scanner must not lose lexical context here and
// subsequently rewrite source text that is data rather than module syntax.
const quotedRegexFixture = /">/;
const nestedTemplateFixture = `
export const greeting = (name) => \`Hello, \${name}!\`;
`.trim();

const scannerFixtureSources = {
  "/in/2nd.js": `
console.log('2nd');`,
  "/in/entry.js": `
import badDefaultImport from './template.html';
console.log('Loaded HTML!', badDefaultImport);`,
  "/in/main.js": `
import page from './page.html';
console.log(page);`,
  "/in/runtime.js": `
import page from './page.html';
console.log(JSON.stringify(page));`,
};

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("HTML entry points report an invalid default import", async () => {
  const fixture = join(root, "invalid-default");
  mkdirSync(join(fixture, "in"), { recursive: true });
  expect(quotedRegexFixture.test('">')).toBe(true);
  expect(nestedTemplateFixture).toContain("`Hello, ${name}!`");
  expect(scannerFixtureSources["/in/entry.js"].trim()).toMatch(/^import badDefaultImport/);
  writeFileSync(join(fixture, "in", "nested-template.js"), nestedTemplateFixture);
  writeFileSync(join(fixture, "in", "entry.js"), scannerFixtureSources["/in/entry.js"].trim());
  writeFileSync(join(fixture, "in", "2nd.js"), 'console.log("2nd");\n');
  writeFileSync(join(fixture, "in", "template.html"), [
    "<!DOCTYPE html>",
    "<html>",
    "  <head>",
    "    <title>HTML Template</title>",
    "  </head>",
    "  <body>",
    "    <h1>HTML Template</h1>",
    '    <script src="./entry.js"></script>',
    '    <script src="./2nd.js"></script>',
    "  </body>",
    "</html>",
    "",
  ].join("\n"));

  const previousCwd = process.cwd();
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    process.chdir(fixture);
    result = await Bun.build({
      entrypoints: ["in/template.html", "in/entry.js"],
      outdir: join(fixture, "out"),
      target: "browser",
      format: "esm",
      naming: { entry: "[dir]/[name].[ext]", chunk: "[name]-[hash].[ext]" },
      throw: false,
    });
  } finally {
    process.chdir(previousCwd);
  }

  Bun.gc(true);
  expect(result.success).toBe(false);
  expect(result.logs).toHaveLength(1);
  expect(result.logs[0].message).toContain('No matching export in "in/template.html" for import "default"');
  expect(result.logs[0].position?.file).toBe(join(fixture, "in", "entry.js"));
});

test("file-loaded HTML is emitted and referenced by its JavaScript importer", async () => {
  const fixture = join(root, "file-loader");
  const inputDirectory = join(fixture, "in");
  const outputDirectory = join(fixture, "out");
  mkdirSync(inputDirectory, { recursive: true });
  expect(scannerFixtureSources["/in/main.js"].trim()).toMatch(/^import page/);
  writeFileSync(join(inputDirectory, "main.js"), scannerFixtureSources["/in/main.js"].trim());
  writeFileSync(join(inputDirectory, "page.html"), [
    "<!doctype html>",
    '<script src="./main.js"></script>',
    "",
  ].join("\n"));

  const result = await Bun.build({
    entrypoints: [join(inputDirectory, "main.js")],
    outdir: outputDirectory,
    target: "browser",
    format: "esm",
    loader: { ".html": "file" },
  });

  expect(result.success).toBe(true);
  const javascript = result.outputs.find(output => output.kind === "entry-point");
  const html = result.outputs.find(output => output.loader === "file");
  expect(javascript).toBeDefined();
  expect(html).toBeDefined();
  expect(javascript!.path).toBe(join(outputDirectory, "main.js"));
  expect(basename(html!.path)).toMatch(/^page-[a-zA-Z0-9]+\.html$/);
  expect(readFileSync(javascript!.path, "utf8")).toMatch(/\.\/page-[a-zA-Z0-9]+\.html/);
});

test("parser-confirmed runtime HTML imports still use the generated loader", () => {
  const fixture = join(root, "runtime-loader");
  const entry = join(fixture, "runtime.js");
  const html = join(fixture, "page.html");
  mkdirSync(fixture, { recursive: true });
  expect(scannerFixtureSources["/in/runtime.js"].trim()).toMatch(/^import page/);
  writeFileSync(entry, scannerFixtureSources["/in/runtime.js"].trim());
  writeFileSync(html, "<!doctype html>\n");

  const child = Bun.spawnSync({ cmd: [process.execPath, entry] });
  expect(child.exitCode).toBe(0);
  expect(child.stderr.toString()).toBe("");
  expect(JSON.parse(child.stdout.toString())).toEqual({ index: html, files: null });
});
