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
    "#exact-no-extension": "./lib/extensionless",
    "#legacy/": "./legacy/",
    "#blocked": [null, "./lib/local.cjs"],
    "#invalid-segment": "./lib/../lib/local.cjs",
    "#encoded": "./lib/local%2Ecjs",
    "#events": "node:events",
  },
}));
write(join(root, "lib", "local.cjs"), "module.exports = { value: 'local' };\n");
write(join(root, "lib", "alpha.cjs"), "module.exports = { value: 'alpha' };\n");
write(join(root, "lib", "extensionless.js"), "module.exports = { value: 'extensionless' };\n");
write(join(root, "legacy", "value.js"), "module.exports = { value: 'legacy-file' };\n");
write(join(root, "legacy", "folder", "index.js"), "module.exports = { value: 'legacy-directory' };\n");

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

const packageTargets = join(root, "node_modules", "package-target-parity");
mkdirSync(packageTargets, { recursive: true });
writeFileSync(join(packageTargets, "package.json"), JSON.stringify({
  name: "package-target-parity",
  exports: {
    ".": "./index.cjs",
    "./exact-no-extension": "./lib/extensionless",
    "./exact-directory": "./lib/directory",
    "./legacy/": "./lib/legacy/",
    "./condition-null": { require: null, default: "./lib/fallback.cjs" },
    "./array-null": [null, "./lib/fallback.cjs"],
    "./invalid-segment": "./lib/../lib/fallback.cjs",
    "./encoded": "./lib/fallback%2Ecjs",
    "./single-decode": "./lib/fallback%252Ecjs",
    "./feature/*-suffix": "./lib/special.cjs",
    "./feature/*": "./lib/pattern/*.cjs",
  },
}));
write(join(packageTargets, "index.cjs"), "module.exports = { value: 'root' };\n");
write(join(packageTargets, "lib", "extensionless.js"), "module.exports = { value: 'extensionless' };\n");
write(join(packageTargets, "lib", "directory", "index.cjs"), "module.exports = { value: 'directory' };\n");
write(join(packageTargets, "lib", "legacy", "value.js"), "module.exports = { value: 'legacy-file' };\n");
write(join(packageTargets, "lib", "legacy", "folder", "index.js"), "module.exports = { value: 'legacy-directory' };\n");
write(join(packageTargets, "lib", "fallback.cjs"), "module.exports = { value: 'fallback' };\n");
write(join(packageTargets, "lib", "fallback%2Ecjs"), "module.exports = { value: 'single-decode' };\n");
write(join(packageTargets, "lib", "special.cjs"), "module.exports = { value: 'special' };\n");
write(join(packageTargets, "lib", "pattern", "-suffix.cjs"), "module.exports = { value: 'general' };\n");

const mixedExports = join(root, "node_modules", "mixed-exports-parity");
mkdirSync(mixedExports, { recursive: true });
writeFileSync(join(mixedExports, "package.json"), JSON.stringify({
  name: "mixed-exports-parity",
  exports: { ".": "./index.cjs", require: "./index.cjs" },
}));
write(join(mixedExports, "index.cjs"), "module.exports = { value: 'mixed' };\n");

const extensionlessModule = join(root, "node_modules", "extensionless-module-field");
mkdirSync(extensionlessModule, { recursive: true });
writeFileSync(join(extensionlessModule, "package.json"), JSON.stringify({
  name: "extensionless-module-field",
  main: "./lib/umd/main.js",
  module: "./lib/esm/main.js",
}));
write(join(extensionlessModule, "lib", "umd", "main.js"), "module.exports = { format: () => 'umd-fallback' };\n");
write(join(extensionlessModule, "lib", "esm", "main.js"), 'export { format } from "./impl/format";\n');
write(join(extensionlessModule, "lib", "esm", "impl", "format.js"), "export const format = () => 'extensionless-esm';\n");
const extensionlessEntry = join(root, "extensionless-entry.js");
write(extensionlessEntry, 'import { format } from "extensionless-module-field"; console.log(format());\n');

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

test("package imports distinguish exact targets from legacy prefix expansion", () => {
  const require = createRequire(entry);
  expect(() => require("#exact-no-extension")).toThrow();
  expect(() => Bun.resolveSync("#exact-no-extension", root)).toThrow();
  expect(require("#legacy/value").value).toBe("legacy-file");
  expect(require("#legacy/folder").value).toBe("legacy-directory");
  expect(require("#encoded").value).toBe("local");
});

test("package imports preserve blocked and invalid target states", () => {
  const require = createRequire(entry);
  expect(() => require("#blocked")).toThrow();
  expect(() => Bun.resolveSync("#blocked", root)).toThrow();
  expect(() => require("#invalid-segment")).toThrow();
});

test("package exports use exact lookup except for trailing-slash maps", () => {
  const require = createRequire(entry);
  expect(() => require("package-target-parity/exact-no-extension")).toThrow();
  expect(() => require("package-target-parity/exact-directory")).toThrow();
  expect(() => Bun.resolveSync("package-target-parity/exact-no-extension", root)).toThrow();
  expect(require("package-target-parity/legacy/value").value).toBe("legacy-file");
  expect(require("package-target-parity/legacy/folder").value).toBe("legacy-directory");
});

test("package exports preserve target status, decoding, and pattern specificity", () => {
  const require = createRequire(entry);
  expect(() => require("package-target-parity/condition-null")).toThrow();
  expect(Bun.resolveSync("package-target-parity/condition-null", root))
    .toEndWith(join("node_modules", "package-target-parity", "lib", "fallback.cjs"));
  expect(() => require("package-target-parity/array-null")).toThrow();
  expect(() => require("package-target-parity/invalid-segment")).toThrow();
  expect(require("package-target-parity/encoded").value).toBe("fallback");
  expect(require("package-target-parity/single-decode").value).toBe("single-decode");
  expect(require("package-target-parity/feature/-suffix").value).toBe("general");
  expect(() => require("mixed-exports-parity")).toThrow();
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

test("bundler follows module fields and extensionless relative ESM imports", async () => {
  const result = await Bun.build({
    entrypoints: [extensionlessEntry],
    format: "esm",
    target: "bun",
  });

  expect(result.success).toBe(true);
  expect(result.outputs).toHaveLength(1);
  const source = await result.outputs[0].text();
  expect(source).toContain("extensionless-esm");
  expect(source).not.toContain("umd-fallback");
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
