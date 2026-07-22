import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binary =
  process.env.COTTONTAIL_BIN ??
  path.join(rootDir, "zig-out", "bin", process.platform === "win32" ? "cottontail.exe" : "cottontail");

assert.ok(existsSync(binary), `missing built cottontail binary: ${binary}`);

function runCottontail(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cottontail ${args.join(" ")} timed out`));
    }, 30_000);
    child.once("close", status => {
      clearTimeout(timeout);
      resolve({ status, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    });
  });
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

const tempDir = mkdtempSync(path.join(os.tmpdir(), "cottontail-update-native-"));
const homeDir = path.join(tempDir, "home");
const packageDir = path.join(tempDir, "package");
mkdirSync(homeDir);
mkdirSync(packageDir);

const packageNames = ["tilde-pkg", "exact-pkg", "real-pkg", "new-pkg"];
const versions = ["1.0.0", "1.0.2", "2.0.0"];
const archives = new Map();
for (const name of packageNames) {
  for (const version of versions) {
    const archive = packageArchive({ name, version });
    archives.set(`${name}-${version}.tgz`, {
      archive,
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    });
  }
}

const requests = [];
let baseUrl;
let availableVersions = ["1.0.0"];
const server = http.createServer((request, response) => {
  requests.push(request.url);
  if (request.url?.startsWith("/tarballs/")) {
    const filename = request.url.slice("/tarballs/".length);
    const found = archives.get(filename);
    if (!found) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(found.archive);
    return;
  }
  const name = decodeURIComponent(request.url?.slice(1) ?? "");
  if (!packageNames.includes(name)) return response.writeHead(404).end();
  const manifestVersions = {};
  for (const version of availableVersions) {
    const filename = `${name}-${version}.tgz`;
    manifestVersions[version] = {
      name,
      version,
      dist: {
        tarball: `${baseUrl}/tarballs/${filename}`,
        integrity: archives.get(filename).integrity,
      },
    };
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      name,
      "dist-tags": { latest: availableVersions.at(-1) },
      versions: manifestVersions,
    }),
  );
});

function readPackageJson() {
  return JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
}

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;

  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "update-fixture",
      version: "1.0.0",
      dependencies: {
        "tilde-pkg": "~1.0.0",
        "exact-pkg": "1.0.0",
        alias: "npm:real-pkg@~1.0.0",
      },
    }),
  );
  writeFileSync(
    path.join(packageDir, "bunfig.toml"),
    `[install]\ncache = false\nregistry = "${baseUrl}/"\nlinker = "hoisted"\n`,
  );
  const env = {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: homeDir,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  for (const name of ["BUN_CONFIG_REGISTRY", "NPM_CONFIG_REGISTRY", "npm_config_registry"]) delete env[name];

  const installed = await runCottontail(["install", "--ignore-scripts"], packageDir, env);
  assert.equal(installed.status, 0, `initial install failed\n${installed.stdout}\n${installed.stderr}`);
  availableVersions = versions;

  const requestsBeforeValidation = requests.length;
  let result = await runCottontail(["update", "@invalid", "--ignore-scripts"], packageDir, env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unrecognised dependency format: @invalid/);
  assert.equal(requests.length, requestsBeforeValidation, "invalid update package reached the registry");

  result = await runCottontail(["update", "tilde-pkg", "--ignore-scripts"], packageDir, env);
  assert.equal(result.status, 0, `tilde update failed\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /installed tilde-pkg@1\.0\.2/);
  assert.equal(readPackageJson().dependencies["tilde-pkg"], "~1.0.2");

  result = await runCottontail(["update", "alias", "--ignore-scripts"], packageDir, env);
  assert.equal(result.status, 0, `alias update failed\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /installed alias@1\.0\.2/);
  assert.equal(readPackageJson().dependencies.alias, "npm:real-pkg@~1.0.2");

  const lockPath = path.join(packageDir, "bun.lock");
  const lockBeforeNoop = readFileSync(lockPath);
  const requestsBeforeNoop = requests.length;
  result = await runCottontail(["update", "exact-pkg", "--ignore-scripts"], packageDir, env);
  assert.equal(result.status, 0, `exact update failed\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /installed exact-pkg@1\.0\.0/);
  assert.match(result.stdout, /done/);
  assert.equal(readPackageJson().dependencies["exact-pkg"], "1.0.0");
  assert.deepEqual(readFileSync(lockPath), lockBeforeNoop, "no-op update rewrote bun.lock");
  assert.ok(requests.slice(requestsBeforeNoop).includes("/exact-pkg"), "no-op update did not refresh registry metadata");

  result = await runCottontail(["update", "exact-pkg", "--latest", "--ignore-scripts"], packageDir, env);
  assert.equal(result.status, 0, `latest update failed\n${result.stdout}\n${result.stderr}`);
  assert.equal(readPackageJson().dependencies["exact-pkg"], "2.0.0");

  result = await runCottontail(["update", "tilde-pkg@^2.0.0", "--ignore-scripts"], packageDir, env);
  assert.equal(result.status, 0, `explicit update failed\n${result.stdout}\n${result.stderr}`);
  assert.equal(readPackageJson().dependencies["tilde-pkg"], "~2.0.0");

  result = await runCottontail(["update", "new-pkg@1.0.2", "--ignore-scripts"], packageDir, env);
  assert.equal(result.status, 0, `missing dependency update failed\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /installed new-pkg@1\.0\.2/);
  assert.equal(readPackageJson().dependencies["new-pkg"], "1.0.2");

  result = await runCottontail(
    ["update", "new-alias@npm:real-pkg@~1.0.0", "--ignore-scripts"],
    packageDir,
    env,
  );
  assert.equal(result.status, 0, `missing alias update failed\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /installed new-alias@1\.0\.2/);
  assert.equal(readPackageJson().dependencies["new-alias"], "npm:real-pkg@^1.0.2");

  console.log("package manager native update test passed");
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(tempDir, { recursive: true, force: true });
}
