import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-runtime-module-field-"));
const nodeModules = join(root, "node_modules");
const runtimeChildTimeout = 20_000;
const runtimeResolutionTimeout = 90_000;

function write(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function installPackage(
  name: string,
  packageJson: Record<string, unknown>,
  files: Record<string, string>,
) {
  installRawPackage(name, `${JSON.stringify({ name, ...packageJson }, null, 2)}\n`, files);
}

function installRawPackage(name: string, packageJson: string, files: Record<string, string>) {
  const packageRoot = join(nodeModules, name);
  write(join(packageRoot, "package.json"), packageJson);
  for (const [relativePath, source] of Object.entries(files)) {
    write(join(packageRoot, relativePath), source);
  }
}

function runBuiltEntry(label: string, source: string) {
  const entry = join(root, `${label}-input.js`);
  const output = join(root, `${label}-output.js`);
  write(entry, source);
  const build = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      entry,
      "--no-bundle",
      `--outfile=${output}`,
      "--target=browser",
      "--format=esm",
    ],
    cwd: root,
    timeout: runtimeChildTimeout,
  });
  if (build.signalCode != null) {
    throw new Error(`build child exceeded ${runtimeChildTimeout}ms and terminated with ${build.signalCode}`);
  }
  if (build.exitCode !== 0) {
    throw new Error(
      `build child exited ${build.exitCode}\nstdout:\n${build.stdout.toString()}\nstderr:\n${build.stderr.toString()}`,
    );
  }
  const child = Bun.spawnSync({
    cmd: [process.execPath, output],
    cwd: root,
    timeout: runtimeChildTimeout,
  });
  if (child.signalCode != null) {
    throw new Error(`runtime child exceeded ${runtimeChildTimeout}ms and terminated with ${child.signalCode}`);
  }
  if (child.exitCode !== 0) {
    throw new Error(
      `runtime child exited ${child.exitCode}\nstdout:\n${child.stdout.toString()}\nstderr:\n${child.stderr.toString()}`,
    );
  }
  return child.stdout.toString();
}

function runRequire(label: string, packageName: string) {
  return runBuiltEntry(
    label,
    `const { selected } = require(${JSON.stringify(packageName)});\nconsole.log(selected);\n`,
  );
}

function runImport(label: string, packageName: string) {
  return runBuiltEntry(
    label,
    `import { selected } from ${JSON.stringify(packageName)};\nconsole.log(selected);\n`,
  );
}

installPackage("module-only-require", { module: "./module.cjs" }, {
  "module.cjs": "exports.selected = 'module';\n",
});
installPackage("module-only-import", { module: "./module.mjs" }, {
  "module.mjs": "export const selected = 'module';\n",
});

installPackage("index-before-module-require", { module: "./module.cjs" }, {
  "module.cjs": "exports.selected = 'module';\n",
  "index.js": "exports.selected = 'index';\n",
});
installPackage("index-before-module-import", { module: "./module.mjs" }, {
  "module.mjs": "export const selected = 'module';\n",
  "index.mjs": "export const selected = 'index';\n",
});

installPackage("main-before-module-require", {
  main: "./main.cjs",
  module: "./module.cjs",
}, {
  "main.cjs": "exports.selected = 'main';\n",
  "module.cjs": "exports.selected = 'module';\n",
  "index.js": "exports.selected = 'index';\n",
});
installPackage("main-before-module-import", {
  main: "./main.mjs",
  module: "./module.mjs",
}, {
  "main.mjs": "export const selected = 'main';\n",
  "module.mjs": "export const selected = 'module';\n",
  "index.mjs": "export const selected = 'index';\n",
});

installPackage("missing-main-module-require", {
  main: "./missing.cjs",
  module: "./module.cjs",
}, {
  "module.cjs": "exports.selected = 'module';\n",
});
installPackage("missing-main-module-import", {
  main: "./missing.mjs",
  module: "./module.mjs",
}, {
  "module.mjs": "export const selected = 'module';\n",
});

installPackage("invalid-module-require", { module: "./missing.cjs" }, {
  "index.js": "exports.selected = 'index';\n",
});
installPackage("invalid-module-import", { module: "./missing.mjs" }, {
  "index.mjs": "export const selected = 'index';\n",
});

installPackage("self-module-require", { module: "." }, {});
installPackage("self-module-import", { module: "./" }, {
  "index.mjs": "export const selected = 'index';\n",
});

installRawPackage("jsonc-runtime-package", `
  {
    // Bun accepts comments in runtime package manifests.
    "name": "jsonc-runtime-package",
    "exports": {
      ".": {
        /* Conditions may also carry trailing commas. */
        "require": "./require.cjs",
      },
    },
  },
`, {
  "require.cjs": "exports.selected = 'jsonc';\n",
});
installRawPackage("invalid-runtime-package", `
  {
    "name": "invalid-runtime-package",
    "main": "./main.cjs",
    this is not valid JSON
  }
`, {
  "main.cjs": "exports.selected = 'partial-main';\n",
  "index.js": "exports.selected = 'index';\n",
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("runtime require and import use a string module field when main is absent", () => {
  expect(runRequire("module-only-require-entry", "module-only-require")).toBe("module\n");
  expect(runImport("module-only-import-entry", "module-only-import")).toBe("module\n");
}, runtimeResolutionTimeout);

test("runtime require keeps index precedence while import prefers module", () => {
  expect(runRequire("index-before-module-require-entry", "index-before-module-require")).toBe("index\n");
  expect(runImport("index-before-module-import-entry", "index-before-module-import")).toBe("module\n");
}, runtimeResolutionTimeout);

test("runtime require and import preserve main precedence over module", () => {
  expect(runRequire("main-before-module-require-entry", "main-before-module-require")).toBe("main\n");
  expect(runImport("main-before-module-import-entry", "main-before-module-import")).toBe("main\n");
}, runtimeResolutionTimeout);

test("runtime require and import use module after an unresolved main and index", () => {
  expect(runRequire("missing-main-module-require-entry", "missing-main-module-require")).toBe("module\n");
  expect(runImport("missing-main-module-import-entry", "missing-main-module-import")).toBe("module\n");
}, runtimeResolutionTimeout);

test("an invalid module target does not displace the index fallback", () => {
  expect(runRequire("invalid-module-require-entry", "invalid-module-require")).toBe("index\n");
  expect(runImport("invalid-module-import-entry", "invalid-module-import")).toBe("index\n");
}, runtimeResolutionTimeout);

test("self-referential module directories terminate and retain normal fallback behavior", () => {
  expect(runBuiltEntry(
    "self-module-require-entry",
    "try { require('self-module-require'); } catch (error) { console.log(error.code); }\n",
  )).toBe("MODULE_NOT_FOUND\n");
  expect(runImport("self-module-import-entry", "self-module-import")).toBe("index\n");
}, runtimeResolutionTimeout);

test("runtime package manifests accept comments and trailing commas", () => {
  expect(runRequire("jsonc-runtime-package-entry", "jsonc-runtime-package")).toBe("jsonc\n");
}, runtimeResolutionTimeout);

test("malformed runtime package manifests do not expose partially parsed fields", () => {
  expect(runRequire("invalid-runtime-package-entry", "invalid-runtime-package")).toBe("index\n");
}, runtimeResolutionTimeout);
