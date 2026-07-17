"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gzipSync } = require("node:zlib");
const { spawn, spawnSync } = require("node:child_process");

const cottontail = path.resolve(process.argv[2] || "zig-out/bin/cottontail");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-workspaces-"));
const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-workspace-registry-"));
const portFile = path.join(registryRoot, "port");

function writeJson(root, relative, value) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTarField(header, offset, width, value) {
  const encoded = `${value.toString(8).padStart(width - 1, "0")}\0`;
  header.write(encoded, offset, width, "ascii");
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

function writeRegistryPackage(name, version, extra = {}) {
  const metadata = { name, version, ...extra };
  fs.writeFileSync(path.join(registryRoot, `${name}.json`), JSON.stringify(metadata));
  fs.writeFileSync(path.join(registryRoot, `${name}-${version}.tgz`), packageArchive(metadata));
}

function waitForPort() {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (fs.existsSync(portFile)) return Number(fs.readFileSync(portFile, "utf8"));
    Atomics.wait(signal, 0, 0, 20);
  }
  throw new Error("registry server did not start");
}

function install(cwd, extra = []) {
  return spawnSync(cottontail, ["install", ...extra, "--ignore-scripts", "--silent"], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function expectSuccess(result) {
  assert.equal(result.status, 0, `install failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function expectWorkspaceLink(link, target) {
  assert.equal(fs.realpathSync(link), fs.realpathSync(target), `${link} does not resolve to ${target}`);
}

writeRegistryPackage("registryfoo", "1.0.0");
writeRegistryPackage("bar", "2.0.0");
writeRegistryPackage("noversion", "2.0.0");
writeRegistryPackage("tagged", "9.0.0");

const serverPath = path.join(registryRoot, "server.cjs");
fs.writeFileSync(
  serverPath,
  `
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const root = process.argv[2];
const portFile = process.argv[3];
const server = http.createServer((request, response) => {
  const name = decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1);
  if (name.startsWith("tarballs/")) {
    const filename = path.join(root, path.basename(name));
    if (!fs.existsSync(filename)) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/octet-stream" });
    fs.createReadStream(filename).pipe(response);
    return;
  }
  const metadataFile = path.join(root, name + ".json");
  if (!fs.existsSync(metadataFile)) return response.writeHead(404).end();
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  const filename = name + "-" + metadata.version + ".tgz";
  metadata.dist = { tarball: "http://127.0.0.1:" + server.address().port + "/tarballs/" + filename };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ name, "dist-tags": { latest: metadata.version }, versions: { [metadata.version]: metadata } }));
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
`,
);
const server = spawn(process.execPath, [serverPath, registryRoot, portFile], {
  stdio: ["ignore", "ignore", "inherit"],
});

try {
  const port = waitForPort();
  const registry = `http://127.0.0.1:${port}/`;

  const monorepo = path.join(scratch, "monorepo");
  writeJson(monorepo, "package.json", {
    name: "monorepo",
    private: true,
    dependencies: { consumer: "file:./vendor/consumer" },
    overrides: { target: "workspace:packages/replacement" },
    workspaces: {
      packages: ["{packages,apps}/**/*", "!packages/private/*"],
      catalog: { registryfoo: "1.0.0" },
    },
  });
  fs.writeFileSync(path.join(monorepo, "bunfig.toml"), `[install]\nregistry = "${registry}"\n`);
  writeJson(monorepo, "packages/core/package.json", { name: "core", version: "1.2.3" });
  writeJson(monorepo, "packages/noversion/package.json", { name: "noversion" });
  writeJson(monorepo, "packages/replacement/package.json", { name: "replacement", version: "3.0.0" });
  writeJson(monorepo, "packages/tagged/package.json", { name: "tagged", version: "1.0.0" });
  writeJson(monorepo, "packages/nested/types/package.json", { name: "types" });
  writeJson(monorepo, "packages/private/secret/package.json", { name: "secret", version: "1.0.0" });
  writeJson(monorepo, "vendor/consumer/package.json", {
    name: "consumer",
    version: "1.0.0",
    dependencies: { target: "1.0.0" },
  });
  writeJson(monorepo, "apps/site/package.json", {
    name: "site",
    version: "1.0.0",
    dependencies: {
      coreAlias: "workspace:core@^1.0.0",
      noversion: "",
      registryfoo: "catalog:",
      tagged: "canary",
      types: "workspace:*",
    },
  });

  const site = path.join(monorepo, "apps", "site");
  expectSuccess(install(site));
  assert.ok(fs.existsSync(path.join(monorepo, "bun.lock")));
  assert.equal(fs.existsSync(path.join(site, "bun.lock")), false);
  expectWorkspaceLink(path.join(monorepo, "node_modules", "core"), path.join(monorepo, "packages", "core"));
  expectWorkspaceLink(path.join(monorepo, "node_modules", "coreAlias"), path.join(monorepo, "packages", "core"));
  expectWorkspaceLink(path.join(monorepo, "node_modules", "site"), site);
  expectWorkspaceLink(path.join(monorepo, "node_modules", "tagged"), path.join(monorepo, "packages", "tagged"));
  expectWorkspaceLink(path.join(monorepo, "node_modules", "target"), path.join(monorepo, "packages", "replacement"));
  expectWorkspaceLink(path.join(monorepo, "node_modules", "types"), path.join(monorepo, "packages", "nested", "types"));
  assert.equal(fs.existsSync(path.join(monorepo, "node_modules", "secret")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(monorepo, "node_modules", "registryfoo", "package.json"))).version, "1.0.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(site, "node_modules", "noversion", "package.json"))).version, "2.0.0");

  expectSuccess(install(site, ["core@workspace:*"]));
  const sitePackage = JSON.parse(fs.readFileSync(path.join(site, "package.json")));
  assert.equal(sitePackage.dependencies.core, "workspace:*");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(monorepo, "package.json"))).dependencies, {
    consumer: "file:./vendor/consumer",
  });
  sitePackage.dependencies.core = "workspace:^2.0.0";
  writeJson(monorepo, "apps/site/package.json", sitePackage);
  const mismatch = install(site);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /No matching version for workspace dependency "core"\. Version: "workspace:\^2\.0\.0"/);
  delete sitePackage.dependencies.core;
  writeJson(monorepo, "apps/site/package.json", sitePackage);

  const missing = path.join(scratch, "missing");
  writeJson(missing, "package.json", { name: "missing", workspaces: ["does-not-exist"] });
  const missingResult = install(missing);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /Workspace not found "does-not-exist"/);

  const duplicate = path.join(scratch, "duplicate");
  writeJson(duplicate, "package.json", { name: "duplicate-root", workspaces: ["packages/*"] });
  writeJson(duplicate, "packages/a/package.json", { name: "same", version: "1.0.0" });
  writeJson(duplicate, "packages/b/package.json", { name: "same", version: "2.0.0" });
  const duplicateResult = install(duplicate);
  assert.equal(duplicateResult.status, 1);
  assert.match(duplicateResult.stderr, /Workspace name "same" already exists/);

  const conflict = path.join(scratch, "conflict");
  writeJson(conflict, "package.json", { name: "conflict-root", workspaces: ["packages/*"] });
  fs.writeFileSync(path.join(conflict, "bunfig.toml"), `[install]\nregistry = "${registry}"\n`);
  writeJson(conflict, "packages/bar/package.json", { name: "bar", version: "1.0.0" });
  writeJson(conflict, "packages/baz/package.json", {
    name: "baz",
    version: "1.0.0",
    dependencies: { bar: "^2.0.0" },
  });
  writeJson(conflict, "packages/stale/package.json", { name: "stale", version: "1.0.0" });
  expectSuccess(install(conflict));
  expectWorkspaceLink(path.join(conflict, "node_modules", "bar"), path.join(conflict, "packages", "bar"));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(conflict, "packages", "baz", "node_modules", "bar", "package.json"))).version,
    "2.0.0",
  );

  writeJson(conflict, "package.json", {
    name: "conflict-root",
    workspaces: ["packages/*"],
    dependencies: { bar: "^2.0.0" },
  });
  writeJson(conflict, "packages/stale/package.json", { name: "fresh", version: "1.0.0" });
  expectSuccess(install(conflict));
  assert.equal(JSON.parse(fs.readFileSync(path.join(conflict, "node_modules", "bar", "package.json"))).version, "2.0.0");
  assert.equal(fs.existsSync(path.join(conflict, "node_modules", "stale")), false);
  expectWorkspaceLink(path.join(conflict, "node_modules", "fresh"), path.join(conflict, "packages", "stale"));

  fs.writeFileSync(
    path.join(conflict, "bunfig.toml"),
    `[install]\nregistry = "${registry}"\nlinkWorkspacePackages = false\n`,
  );
  writeJson(conflict, "package.json", {
    name: "conflict-root",
    workspaces: ["packages/*"],
    dependencies: { bar: "*" },
  });
  writeJson(conflict, "packages/baz/package.json", {
    name: "baz",
    version: "1.0.0",
    dependencies: { bar: "workspace:*" },
  });
  expectSuccess(install(conflict));
  assert.equal(JSON.parse(fs.readFileSync(path.join(conflict, "node_modules", "bar", "package.json"))).version, "2.0.0");
  expectWorkspaceLink(path.join(conflict, "packages", "baz", "node_modules", "bar"), path.join(conflict, "packages", "bar"));

  console.log("package-manager workspaces: pass");
} finally {
  server.kill();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  fs.rmSync(registryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
