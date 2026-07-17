"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { gzipSync } = require("node:zlib");

const cottontail = path.resolve(process.argv[2] || "zig-out/bin/cottontail");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-lockfiles-"));
const servers = [];

function writeJson(root, relative, value) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

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

function writeArchive(root, name = "archived", version = "1.2.3") {
  const archive = packageArchive({ name, version });
  fs.writeFileSync(path.join(root, `${name}.tgz`), archive);
  return {
    archive,
    integrity: `sha512-${crypto.createHash("sha512").update(archive).digest("base64")}`,
  };
}

function install(root, args = [], silent = true) {
  return spawnSync(
    cottontail,
    ["install", ...args, "--ignore-scripts", ...(silent ? ["--silent"] : [])],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
}

function expectSuccess(result) {
  assert.equal(result.status, 0, `install failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function waitForFile(filename) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (fs.existsSync(filename)) return;
    Atomics.wait(signal, 0, 0, 20);
  }
  throw new Error(`timed out waiting for ${filename}`);
}

function startRegistry() {
  const root = path.join(scratch, "registry");
  fs.mkdirSync(root, { recursive: true });
  const archive = packageArchive({ name: "remote", version: "1.0.0" });
  const integrity = `sha512-${crypto.createHash("sha512").update(archive).digest("base64")}`;
  fs.writeFileSync(path.join(root, "remote.tgz"), archive);
  const portFile = path.join(root, "port");
  const requestFile = path.join(root, "requests");
  const serverFile = path.join(root, "server.cjs");
  fs.writeFileSync(
    serverFile,
    `
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const [root, portFile, requestFile, integrity] = process.argv.slice(2);
const server = http.createServer((request, response) => {
  fs.appendFileSync(requestFile, request.url + "\\n");
  if (request.url === "/remote.tgz") {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    fs.createReadStream(path.join(root, "remote.tgz")).pipe(response);
    return;
  }
  if (request.url !== "/remote") return response.writeHead(404).end();
  const tarball = "http://127.0.0.1:" + server.address().port + "/remote.tgz";
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    name: "remote",
    "dist-tags": { latest: "1.0.0" },
    versions: { "1.0.0": { name: "remote", version: "1.0.0", dist: { tarball, integrity } } },
  }));
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
`,
  );
  const server = spawn(process.execPath, [serverFile, root, portFile, requestFile, integrity], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  servers.push(server);
  waitForFile(portFile);
  return {
    requestFile,
    url: `http://127.0.0.1:${fs.readFileSync(portFile, "utf8")}/`,
  };
}

function makeLocalProject(root, dependencyOrder = ["zeta", "alpha"]) {
  const dependencies = {};
  for (const name of dependencyOrder) dependencies[name] = `file:./vendor/${name}`;
  writeJson(root, "package.json", { name: "deterministic", dependencies });
  writeJson(root, "vendor/alpha/package.json", {
    name: "alpha",
    version: "1.0.0",
    bin: { zeta: "z.js", alpha: "a.js" },
  });
  writeJson(root, "vendor/zeta/package.json", { name: "zeta", version: "2.0.0" });
}

try {
  const npmRoot = path.join(scratch, "npm-migration");
  fs.mkdirSync(npmRoot, { recursive: true });
  const npmArchive = writeArchive(npmRoot);
  writeJson(npmRoot, "package.json", {
    name: "npm-migration",
    dependencies: { archived: "file:./archived.tgz" },
  });
  writeJson(npmRoot, "package-lock.json", {
    name: "npm-migration",
    lockfileVersion: 3,
    packages: {
      "": { name: "npm-migration", dependencies: { archived: "file:./archived.tgz" } },
      "node_modules/archived": {
        name: "archived",
        version: "1.2.3",
        resolved: "file:archived.tgz",
        integrity: npmArchive.integrity,
      },
    },
  });
  const npmResult = install(npmRoot, [], false);
  expectSuccess(npmResult);
  assert.match(npmResult.stderr, /migrated lockfile from package-lock\.json/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(npmRoot, "node_modules/archived/package.json"))).version, "1.2.3");
  const migratedLock = fs.readFileSync(path.join(npmRoot, "bun.lock"), "utf8");
  assert.match(migratedLock, /"configVersion": 0/);
  assert.ok(migratedLock.includes(npmArchive.integrity));

  fs.rmSync(path.join(npmRoot, "node_modules"), { recursive: true, force: true });
  fs.writeFileSync(path.join(npmRoot, "archived.tgz"), Buffer.concat([npmArchive.archive, Buffer.from("corrupt")]));
  const integrityFailure = install(npmRoot, ["--frozen-lockfile"]);
  assert.equal(integrityFailure.status, 1);
  assert.match(integrityFailure.stderr, /Integrity check failed/);
  assert.equal(fs.readFileSync(path.join(npmRoot, "bun.lock"), "utf8"), migratedLock);

  const yarnRoot = path.join(scratch, "yarn-migration");
  fs.mkdirSync(yarnRoot, { recursive: true });
  const yarnArchive = writeArchive(yarnRoot);
  writeJson(yarnRoot, "package.json", {
    name: "yarn-migration",
    dependencies: { archived: "file:./archived.tgz" },
  });
  fs.writeFileSync(
    path.join(yarnRoot, "yarn.lock"),
    `# yarn lockfile v1\n\narchived@file:./archived.tgz:\n  version "1.2.3"\n  resolved "file:./archived.tgz"\n  integrity ${yarnArchive.integrity}\n`,
  );
  const yarnResult = install(yarnRoot, [], false);
  expectSuccess(yarnResult);
  assert.match(yarnResult.stderr, /migrated lockfile from yarn\.lock/);
  assert.ok(fs.readFileSync(path.join(yarnRoot, "bun.lock"), "utf8").includes(yarnArchive.integrity));

  const first = path.join(scratch, "deterministic-first");
  const second = path.join(scratch, "deterministic-second");
  makeLocalProject(first, ["zeta", "alpha"]);
  makeLocalProject(second, ["alpha", "zeta"]);
  expectSuccess(install(first));
  expectSuccess(install(second));
  const firstLock = fs.readFileSync(path.join(first, "bun.lock"), "utf8");
  const secondLock = fs.readFileSync(path.join(second, "bun.lock"), "utf8");
  assert.equal(firstLock, secondLock);
  assert.match(firstLock, /"configVersion": 1/);
  assert.ok(firstLock.indexOf('"alpha"') < firstLock.indexOf('"zeta"'));

  fs.writeFileSync(path.join(first, "bun.lock"), firstLock.replace(/  "configVersion": 1,\n/, ""));
  expectSuccess(install(first));
  assert.match(fs.readFileSync(path.join(first, "bun.lock"), "utf8"), /"configVersion": 0/);

  const beforeFrozen = fs.readFileSync(path.join(second, "bun.lock"), "utf8");
  const changedPackage = JSON.parse(fs.readFileSync(path.join(second, "package.json"), "utf8"));
  changedPackage.dependencies.alpha = "file:./vendor/zeta";
  writeJson(second, "package.json", changedPackage);
  const frozen = install(second, ["--frozen-lockfile"]);
  assert.equal(frozen.status, 1);
  assert.match(frozen.stderr, /lockfile had changes, but lockfile is frozen/);
  assert.equal(fs.readFileSync(path.join(second, "bun.lock"), "utf8"), beforeFrozen);

  const noSave = path.join(scratch, "no-save");
  makeLocalProject(noSave, ["alpha"]);
  expectSuccess(install(noSave, ["--no-save"]));
  assert.equal(fs.existsSync(path.join(noSave, "bun.lock")), false);

  const lockfileOnly = path.join(scratch, "lockfile-only");
  const registry = startRegistry();
  writeJson(lockfileOnly, "package.json", { name: "lockfile-only", dependencies: { remote: "1.0.0" } });
  fs.writeFileSync(path.join(lockfileOnly, "bunfig.toml"), `[install]\nregistry = "${registry.url}"\n`);
  expectSuccess(install(lockfileOnly, ["--lockfile-only"]));
  assert.equal(fs.existsSync(path.join(lockfileOnly, "bun.lock")), true);
  assert.equal(fs.existsSync(path.join(lockfileOnly, "node_modules")), false);
  assert.deepEqual(fs.readFileSync(registry.requestFile, "utf8").trim().split(/\r?\n/), ["/remote"]);

  const binary = path.join(scratch, "binary-boundary");
  makeLocalProject(binary, ["alpha"]);
  fs.writeFileSync(path.join(binary, "bunfig.toml"), "[install]\nsaveTextLockfile = false\n");
  const binaryResult = install(binary);
  assert.equal(binaryResult.status, 1);
  assert.match(binaryResult.stderr, /writing bun\.lockb requires Bun's packed Lockfile\.Buffers/);
  assert.equal(fs.existsSync(path.join(binary, "bun.lock")), false);
  assert.equal(fs.existsSync(path.join(binary, "bun.lockb")), false);
  expectSuccess(install(binary, ["--save-text-lockfile"]));
  assert.equal(fs.existsSync(path.join(binary, "bun.lock")), true);
  expectSuccess(install(binary));

  const binaryRead = path.join(scratch, "binary-read-boundary");
  makeLocalProject(binaryRead, ["alpha"]);
  fs.writeFileSync(path.join(binaryRead, "bun.lockb"), "not a lockfile");
  const binaryReadResult = install(binaryRead);
  assert.equal(binaryReadResult.status, 1);
  assert.match(binaryReadResult.stderr, /reading bun\.lockb requires Bun's packed Lockfile\.Buffers/);

  const npmV1 = path.join(scratch, "npm-v1-boundary");
  writeJson(npmV1, "package.json", { name: "npm-v1" });
  writeJson(npmV1, "package-lock.json", { lockfileVersion: 1, packages: { "": {} } });
  const npmV1Result = install(npmV1);
  assert.equal(npmV1Result.status, 1);
  assert.match(npmV1Result.stderr, /upgrade package-lock\.json to lockfileVersion 2 or 3/);

  const monorepo = path.join(scratch, "config-v1-monorepo");
  writeJson(monorepo, "package.json", { name: "monorepo", workspaces: ["packages/*"] });
  writeJson(monorepo, "packages/app/package.json", {
    name: "app",
    version: "1.0.0",
    dependencies: { dep: "file:../../vendor/dep" },
  });
  writeJson(monorepo, "vendor/dep/package.json", { name: "dep", version: "1.0.0" });
  expectSuccess(install(monorepo));
  assert.equal(fs.existsSync(path.join(monorepo, "node_modules/.bun")), true);
  assert.equal(fs.existsSync(path.join(monorepo, "packages/app/node_modules/dep")), true);
  assert.match(fs.readFileSync(path.join(monorepo, "bun.lock"), "utf8"), /"configVersion": 1/);

  console.log("package-manager lockfiles: pass");
} finally {
  for (const server of servers) server.kill();
  if (process.env.COTTONTAIL_KEEP_TEST_TEMP) {
    console.error(`kept lockfile fixtures at ${scratch}`);
  } else {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
