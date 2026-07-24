import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const testRoot = path.join(
  process.env.COTTONTAIL_TMP_DIR ?? process.cwd(),
  "package-manager-external-file-dependencies",
);
const app = path.join(testRoot, "app");
const external = path.join(testRoot, "external");
const nested = path.join(testRoot, "nested");

function writePackage(directory: string, value: object) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function install(attempt: number) {
  const result = spawnSync(process.execPath, ["install", "--silent"], {
    cwd: app,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `external file dependency install ${attempt} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

fs.rmSync(testRoot, { recursive: true, force: true });

try {
  writePackage(app, {
    name: "consumer",
    version: "1.0.0",
    dependencies: {
      external: "file:../external",
    },
  });
  writePackage(external, {
    name: "external",
    version: "1.0.0",
    dependencies: {
      nested: "file:../nested",
    },
  });
  writePackage(nested, {
    name: "nested",
    version: "1.0.0",
  });

  install(1);
  install(2);

  const installedExternal = path.join(app, "node_modules", "external");
  assert.ok(fs.lstatSync(installedExternal).isDirectory());
  assert.ok(
    fs.existsSync(path.join(installedExternal, "node_modules", "nested", "package.json")),
  );
  assert.ok(!fs.existsSync(path.join(external, "node_modules")));

  console.log("package manager external file dependencies passed");
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
