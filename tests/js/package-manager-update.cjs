"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { gzipSync } = require("node:zlib");

const cottontail = path.resolve(process.argv[2] || "zig-out/bin/cottontail");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-update-"));
const registryRoot = path.join(scratch, "registry");
const portFile = path.join(registryRoot, "port");
const versionsFile = path.join(registryRoot, "versions.json");
const packageName = "update-fixture";
const allVersions = ["1.0.0", "1.0.1", "1.1.0", "2.0.0"];

function writeTarField(header, offset, width, value) {
  header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
}

function packageArchive(packageJson) {
  const body = Buffer.from(`${JSON.stringify(packageJson)}\n`);
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0, 100, "utf8");
  writeTarField(header, 100, 8, 0o644);
  writeTarField(header, 108, 8, 0);
  writeTarField(header, 116, 8, 0);
  writeTarField(header, 124, 12, body.length);
  writeTarField(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]));
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function setRegistryVersions(versions) {
  fs.writeFileSync(versionsFile, JSON.stringify(versions));
}

function waitForPort() {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (fs.existsSync(portFile)) return Number(fs.readFileSync(portFile, "utf8"));
    Atomics.wait(signal, 0, 0, 10);
  }
  throw new Error("registry server did not start");
}

function makeProject(name, packageJson, registry) {
  const root = path.join(scratch, name);
  const home = path.join(scratch, `${name}-home`);
  fs.mkdirSync(home, { recursive: true });
  writeJson(path.join(root, "package.json"), packageJson);
  fs.writeFileSync(path.join(root, "bunfig.toml"), `[install]\nregistry = "${registry}"\n`);
  return { root, home };
}

function run(project, args, cwd = project.root, input) {
  const env = { ...process.env, HOME: project.home };
  delete env.BUN_INSTALL_CACHE_DIR;
  delete env.XDG_CACHE_HOME;
  delete env.npm_config_cache;
  delete env.NPM_CONFIG_CACHE;
  return spawnSync(cottontail, args, {
    cwd,
    env,
    encoding: "utf8",
    input,
    timeout: 30_000,
  });
}

function expectSuccess(label, result) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function install(project) {
  const result = run(project, ["install", "--ignore-scripts", "--silent"]);
  expectSuccess("install", result);
}

function update(project, args = [], cwd = project.root) {
  const result = run(project, ["update", ...args, "--ignore-scripts", "--silent"], cwd);
  expectSuccess(`update ${args.join(" ")}`, result);
}

function readPackage(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function installedVersion(root, alias) {
  return readPackage(path.join(root, "node_modules", alias, "package.json")).version;
}

fs.mkdirSync(registryRoot, { recursive: true });
for (const version of allVersions) {
  fs.writeFileSync(
    path.join(registryRoot, `${packageName}-${version}.tgz`),
    packageArchive({ name: packageName, version }),
  );
}
setRegistryVersions(["1.0.0"]);

const serverFile = path.join(registryRoot, "server.cjs");
fs.writeFileSync(
  serverFile,
  `
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const [root, portFile, versionsFile, packageName] = process.argv.slice(2);
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1);
  if (pathname.startsWith("tarballs/")) {
    const filename = path.join(root, path.basename(pathname));
    if (!fs.existsSync(filename)) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/octet-stream" });
    return fs.createReadStream(filename).pipe(response);
  }
  if (pathname !== packageName) return response.writeHead(404).end();
  const enabled = JSON.parse(fs.readFileSync(versionsFile, "utf8"));
  const versions = {};
  for (const version of enabled) {
    versions[version] = {
      name: packageName,
      version,
      dist: {
        tarball:
          "http://127.0.0.1:" +
          server.address().port +
          "/tarballs/" +
          packageName +
          "-" +
          version +
          ".tgz",
      },
    };
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      name: packageName,
      "dist-tags": { latest: enabled[enabled.length - 1] },
      versions,
    }),
  );
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
`,
);

const server = spawn(
  process.execPath,
  [serverFile, registryRoot, portFile, versionsFile, packageName],
  { stdio: ["ignore", "ignore", "inherit"] },
);

try {
  const port = waitForPort();
  const registry = `http://127.0.0.1:${port}/`;

  const help = spawnSync(cottontail, ["update", "--help"], { encoding: "utf8" });
  expectSuccess("update --help", help);
  assert.match(help.stdout, /-r, --recursive/);

  const pinning = makeProject(
    "pinning",
    {
      name: "pinning",
      dependencies: {
        tildeAlias: `npm:${packageName}@~1.0.0`,
        exactAlias: `npm:${packageName}@1.0.0`,
        caretAlias: `npm:${packageName}@^1.0.0`,
        duplicateAlias: `npm:${packageName}@^1.0.0`,
        tagAlias: `npm:${packageName}@latest`,
      },
      peerDependencies: {
        duplicateAlias: `npm:${packageName}@^1.0.0`,
      },
    },
    registry,
  );
  setRegistryVersions(["1.0.0"]);
  install(pinning);
  setRegistryVersions(allVersions);
  update(pinning);

  let manifest = readPackage(path.join(pinning.root, "package.json"));
  assert.deepEqual(manifest.dependencies, {
    tildeAlias: `npm:${packageName}@~1.0.1`,
    exactAlias: `npm:${packageName}@1.0.0`,
    caretAlias: `npm:${packageName}@^1.1.0`,
    duplicateAlias: `npm:${packageName}@^1.1.0`,
    tagAlias: `npm:${packageName}@latest`,
  });
  assert.equal(manifest.peerDependencies.duplicateAlias, `npm:${packageName}@^1.0.0`);
  assert.equal(installedVersion(pinning.root, "tildeAlias"), "1.0.1");
  assert.equal(installedVersion(pinning.root, "exactAlias"), "1.0.0");
  assert.equal(installedVersion(pinning.root, "caretAlias"), "1.1.0");
  assert.equal(installedVersion(pinning.root, "tagAlias"), "1.0.0");

  update(pinning, ["exactAlias", "--latest"]);
  manifest = readPackage(path.join(pinning.root, "package.json"));
  assert.equal(manifest.dependencies.exactAlias, `npm:${packageName}@2.0.0`);
  assert.equal(installedVersion(pinning.root, "exactAlias"), "2.0.0");

  update(pinning, ["tildeAlias", "--latest"]);
  manifest = readPackage(path.join(pinning.root, "package.json"));
  assert.equal(manifest.dependencies.tildeAlias, `npm:${packageName}@~2.0.0`);

  update(pinning, ["caretAlias@^2.0.0"]);
  manifest = readPackage(path.join(pinning.root, "package.json"));
  assert.equal(manifest.dependencies.caretAlias, `npm:${packageName}@^2.0.0`);

  update(pinning, ["tagAlias"]);
  manifest = readPackage(path.join(pinning.root, "package.json"));
  assert.equal(manifest.dependencies.tagAlias, `npm:${packageName}@^2.0.0`);

  const noSave = makeProject(
    "no-save",
    {
      name: "no-save",
      dependencies: { moving: `npm:${packageName}@^1.0.0` },
    },
    registry,
  );
  setRegistryVersions(["1.0.0"]);
  install(noSave);
  const packageBefore = fs.readFileSync(path.join(noSave.root, "package.json"));
  const lockBefore = fs.readFileSync(path.join(noSave.root, "bun.lock"));
  setRegistryVersions(allVersions);
  update(noSave, ["--no-save"]);
  assert.deepEqual(fs.readFileSync(path.join(noSave.root, "package.json")), packageBefore);
  assert.deepEqual(fs.readFileSync(path.join(noSave.root, "bun.lock")), lockBefore);
  assert.equal(installedVersion(noSave.root, "moving"), "1.1.0");

  const exactStable = makeProject(
    "exact-stable",
    {
      name: "exact-stable",
      dependencies: { [packageName]: "1.0.0" },
    },
    registry,
  );
  setRegistryVersions(["1.0.0"]);
  install(exactStable);
  const exactPackageBefore = fs.readFileSync(path.join(exactStable.root, "package.json"));
  const exactLockBefore = fs.readFileSync(path.join(exactStable.root, "bun.lock"));
  setRegistryVersions(allVersions);
  update(exactStable);
  assert.deepEqual(fs.readFileSync(path.join(exactStable.root, "package.json")), exactPackageBefore);
  assert.deepEqual(fs.readFileSync(path.join(exactStable.root, "bun.lock")), exactLockBefore);

  const interactive = makeProject(
    "interactive-latest-selection",
    {
      name: "interactive-latest-selection",
      dependencies: { [packageName]: "1.0.0" },
    },
    registry,
  );
  setRegistryVersions(["1.0.0"]);
  install(interactive);
  setRegistryVersions(allVersions);
  const interactiveResult = run(
    interactive,
    ["update", "--interactive", "--ignore-scripts"],
    interactive.root,
    "l\r",
  );
  expectSuccess("interactive update latest selection", interactiveResult);
  assert.equal(readPackage(path.join(interactive.root, "package.json")).dependencies[packageName], "2.0.0");
  assert.equal(installedVersion(interactive.root, packageName), "2.0.0");

  const catalog = makeProject(
    "catalog",
    {
      name: "catalog-root",
      private: true,
      workspaces: {
        packages: ["packages/*"],
        catalog: { [packageName]: "^1.0.0" },
      },
    },
    registry,
  );
  const catalogChild = path.join(catalog.root, "packages", "child");
  writeJson(path.join(catalogChild, "package.json"), {
    name: "catalog-child",
    version: "1.0.0",
    dependencies: { [packageName]: "catalog:" },
  });
  setRegistryVersions(["1.0.0"]);
  install(catalog);
  const catalogPackageBefore = fs.readFileSync(path.join(catalogChild, "package.json"));
  setRegistryVersions(allVersions);
  update(catalog, ["--dry-run"], catalogChild);
  assert.deepEqual(fs.readFileSync(path.join(catalogChild, "package.json")), catalogPackageBefore);

  const workspace = makeProject(
    "workspace",
    {
      name: "workspace-root",
      private: true,
      workspaces: ["packages/*"],
      dependencies: { [packageName]: "1.0.0" },
    },
    registry,
  );
  const child = path.join(workspace.root, "packages", "child");
  writeJson(path.join(child, "package.json"), { name: "child", version: "1.0.0" });
  setRegistryVersions(["1.0.0"]);
  install(workspace);
  setRegistryVersions(allVersions);
  update(workspace, [packageName], child);

  assert.equal(readPackage(path.join(workspace.root, "package.json")).dependencies[packageName], "1.0.0");
  assert.equal(
    readPackage(path.join(child, "package.json")).dependencies[packageName],
    "^2.0.0",
  );
  assert.equal(installedVersion(workspace.root, packageName), "1.0.0");
  assert.equal(installedVersion(child, packageName), "2.0.0");

  update(workspace, ["--recursive", "--dry-run"]);

  const localSource = path.join(scratch, "local-source");
  const localSourceNext = path.join(scratch, "local-source-next");
  const rawSource = path.join(scratch, "raw-source");
  writeJson(path.join(localSource, "package.json"), { name: "local-update", version: "1.0.0" });
  writeJson(path.join(localSourceNext, "package.json"), { name: "local-update", version: "3.0.0" });
  writeJson(path.join(rawSource, "package.json"), { name: "raw-update", version: "4.0.0" });
  const localProject = makeProject(
    "local-update-project",
    {
      name: "local-update-project",
      dependencies: { "local-update": "file:../local-source" },
    },
    registry,
  );
  install(localProject);
  writeJson(path.join(localSource, "package.json"), { name: "local-update", version: "2.0.0" });
  update(localProject, ["local-update"]);
  assert.equal(installedVersion(localProject.root, "local-update"), "2.0.0");
  assert.equal(
    readPackage(path.join(localProject.root, "package.json")).dependencies["local-update"],
    "file:../local-source",
  );

  update(localProject, ["local-update@file:../local-source-next"]);
  assert.equal(installedVersion(localProject.root, "local-update"), "3.0.0");
  assert.equal(
    readPackage(path.join(localProject.root, "package.json")).dependencies["local-update"],
    "file:../local-source-next",
  );

  update(localProject, ["../raw-source"]);
  assert.equal(installedVersion(localProject.root, "raw-update"), "4.0.0");
  assert.equal(
    readPackage(path.join(localProject.root, "package.json")).dependencies["raw-update"],
    "file:../raw-source",
  );

  const tarballPath = path.join(scratch, "mutable-source.tgz");
  fs.writeFileSync(tarballPath, packageArchive({ name: "tarball-update", version: "1.0.0" }));
  const tarballProject = makeProject(
    "tarball-update-project",
    {
      name: "tarball-update-project",
      dependencies: { "tarball-update": "file:../mutable-source.tgz" },
    },
    registry,
  );
  install(tarballProject);
  const tarballLockBefore = fs.readFileSync(path.join(tarballProject.root, "bun.lock"));
  fs.writeFileSync(tarballPath, packageArchive({ name: "tarball-update", version: "2.0.0" }));
  update(tarballProject, ["tarball-update"]);
  assert.equal(installedVersion(tarballProject.root, "tarball-update"), "2.0.0");
  assert.equal(
    readPackage(path.join(tarballProject.root, "package.json")).dependencies["tarball-update"],
    "file:../mutable-source.tgz",
  );
  assert.notDeepEqual(fs.readFileSync(path.join(tarballProject.root, "bun.lock")), tarballLockBefore);

  console.log("package-manager update: pass");
} finally {
  server.kill();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
