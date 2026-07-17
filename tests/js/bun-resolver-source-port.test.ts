import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = mkdtempSync(join(tmpdir(), "cottontail-resolver-source-"));
const entry = join(root, "src", "entry.js");
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(entry, "");

function write(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

writeFileSync(join(root, "package.json"), JSON.stringify({
  name: "resolver-source-port",
  imports: {
    "#local": "./lib/local.cjs",
    "#features/*": "./lib/*.cjs",
    "#events": "node:events",
  },
}));
write(join(root, "lib", "local.cjs"), "module.exports = { value: 'local' };\n");
write(join(root, "lib", "alpha.cjs"), "module.exports = { value: 'alpha' };\n");

const conditional = join(root, "node_modules", "conditional-resolver");
mkdirSync(conditional, { recursive: true });
writeFileSync(join(conditional, "package.json"), JSON.stringify({
  name: "conditional-resolver",
  exports: {
    ".": {
      cottontail_source_port: {
        import: "./import.cjs",
        require: "./require.cjs",
      },
      default: "./fallback.cjs",
    },
  },
}));
write(join(conditional, "import.cjs"), "module.exports = { value: 'import' };\n");
write(join(conditional, "require.cjs"), "module.exports = { value: 'require' };\n");
write(join(conditional, "fallback.cjs"), "module.exports = { value: 'fallback' };\n");

const mainEntry = join(root, "module-main", "entry.cjs");
write(join(root, "module-main", "child.cjs"), [
  "module.exports = {",
  "  nested: module !== require.main,",
  "  mainFilename: require.main && require.main.filename,",
  "};",
  "",
].join("\n"));
write(mainEntry, [
  "const child = require('./child.cjs');",
  "if (!child.nested || child.mainFilename !== __filename) process.exitCode = 91;",
  "else console.log('nested-main-ok');",
  "",
].join("\n"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("Bun message error spellings are exact aliases", () => {
  expect(globalThis.BuildError).toBe(globalThis.BuildMessage);
  expect(globalThis.ResolveError).toBe(globalThis.ResolveMessage);
});

test("package imports resolve exact, wildcard, and builtin targets", () => {
  const require = createRequire(entry);
  expect(require("#local").value).toBe("local");
  expect(require("#features/alpha").value).toBe("alpha");
  expect(require("#events")).toBe(require("node:events"));
  expect(Bun.resolveSync("#features/alpha", root)).toBe(join(root, "lib", "alpha.cjs"));
});

test("condition maps distinguish import and require while preserving custom conditions", () => {
  process.execArgv.push("--conditions=cottontail_source_port");
  try {
    const require = createRequire(entry);
    expect(require("conditional-resolver").value).toBe("require");
    expect(Bun.resolveSync("conditional-resolver", root)).toBe(join(conditional, "import.cjs"));
  } finally {
    process.execArgv.splice(process.execArgv.lastIndexOf("--conditions=cottontail_source_port"), 1);
  }
});

test("file URL require and resolution decode paths", () => {
  const require = createRequire(entry);
  const local = join(root, "lib", "local.cjs");
  const url = pathToFileURL(local).href;
  expect(require.resolve(url)).toBe(local);
  expect(require(url).value).toBe("local");
});

test("NODE_PATH accepts packages without package.json", () => {
  const nodePath = join(root, "global-modules");
  write(join(nodePath, "node-path-source-port", "index.js"), "module.exports = { value: 'node-path' };\n");
  const previous = process.env.NODE_PATH;
  process.env.NODE_PATH = nodePath;
  try {
    expect(createRequire(entry)("node-path-source-port").value).toBe("node-path");
  } finally {
    if (previous === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = previous;
  }
});

test("createRequire diagnostics retain the file referrer", () => {
  const require = createRequire(entry);
  expect(() => require("resolver-source-port-missing")).toThrow(entry);
});

test("nested require keeps the original CommonJS entry as require.main", () => {
  const child = Bun.spawnSync({ cmd: [process.execPath, mainEntry] });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("nested-main-ok\n");
  expect(child.stderr.toString()).toBe("");
});

test("Bun.resolve APIs reject missing arguments with Bun's contract", async () => {
  expect(() => Bun.resolveSync()).toThrow("Expected a specifier and a from path");
  await expect(Bun.resolve()).rejects.toThrow("Expected a specifier and a from path");
  try {
    Bun.resolveSync();
  } catch (error) {
    expect(error.code).toBe("ERR_INVALID_ARG_TYPE");
  }
});
