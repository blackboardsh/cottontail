"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { gzipSync } = require("node:zlib");

const cottontail = path.resolve(process.argv[2] || "zig-out/bin/cottontail");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-bunx-test-"));
const workDir = path.join(scratch, "work");
const tempDir = path.join(scratch, "temp");
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(tempDir, { recursive: true });

function writeTarField(header, offset, width, value) {
  header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
}

function tarEntry(name, contents, mode = 0o755) {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeTarField(header, 100, 8, mode);
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
  return Buffer.concat([header, body, padding]);
}

function executableSource(marker) {
  return `#!/usr/bin/env node
console.log(JSON.stringify({
  marker: ${JSON.stringify(marker)},
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  npmCommand: process.env.npm_command,
  lifecycleEvent: process.env.npm_lifecycle_event,
  lifecycleScript: process.env.npm_lifecycle_script,
  userAgent: process.env.npm_config_user_agent,
  execPath: process.execPath,
}));
`;
}

function packageArchive(manifest, entries) {
  const chunks = [tarEntry("package/package.json", `${JSON.stringify(manifest)}\n`, 0o644)];
  for (const entry of entries) chunks.push(tarEntry(`package/${entry.name}`, entry.contents, entry.mode));
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function packageRecord(name, manifest, entries) {
  const archive = packageArchive(manifest, entries);
  return {
    archive,
    integrity: `sha512-${crypto.createHash("sha512").update(archive).digest("base64")}`,
    manifest: { ...manifest, dist: {} },
    name,
  };
}

const packages = new Map();
packages.set(
  "fixture-tool",
  packageRecord(
    "fixture-tool",
    {
      name: "fixture-tool",
      version: "1.0.0",
      bin: { "fixture-tool": "cli.js", "alt-tool": "alt.js" },
    },
    [
      { name: "./cli.js", contents: executableSource("discarded-duplicate") },
      { name: "cli.js", contents: executableSource("fixture-main") },
      { name: "alt.js", contents: executableSource("fixture-alt") },
    ],
  ),
);
packages.set(
  "typescript",
  packageRecord(
    "typescript",
    { name: "typescript", version: "5.9.3", bin: { tsc: "tsc.js" } },
    [{ name: "tsc.js", contents: executableSource("typescript-tsc") }],
  ),
);
packages.set(
  "@scope/scoped-tool",
  packageRecord(
    "@scope/scoped-tool",
    { name: "@scope/scoped-tool", version: "2.0.0", bin: { "scope-cli": "cli.js" } },
    [{ name: "cli.js", contents: executableSource("scoped-actual-bin") }],
  ),
);

const requests = [];
const server = http.createServer((request, response) => {
  requests.push(request.url);
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname.startsWith("/tarballs/")) {
    const name = decodeURIComponent(pathname.slice("/tarballs/".length, -".tgz".length));
    const record = packages.get(name);
    if (!record) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/octet-stream" });
    return response.end(record.archive);
  }

  const name = decodeURIComponent(pathname.slice(1));
  const record = packages.get(name);
  if (!record) return response.writeHead(404).end();
  const port = server.address().port;
  const version = record.manifest.version;
  const manifest = {
    name,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        ...record.manifest,
        dist: {
          tarball: `http://127.0.0.1:${port}/tarballs/${encodeURIComponent(name)}.tgz`,
          integrity: record.integrity,
        },
      },
    },
  };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(manifest));
});

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd || workDir,
      env: {
        ...process.env,
        BUN_TMPDIR: tempDir,
        TMPDIR: tempDir,
        npm_config_registry: `http://127.0.0.1:${server.address().port}/`,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", status => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function expectSuccess(result) {
  assert.equal(result.status, 0, `command failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function payload(result) {
  expectSuccess(result);
  const line = result.stdout.trim().split(/\r?\n/).findLast(candidate => candidate.startsWith("{"));
  assert.ok(line, `missing JSON payload in stdout:\n${result.stdout}`);
  return JSON.parse(line);
}

async function main() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const first = payload(await run(cottontail, ["x", "--silent", "fixture-tool", "alpha", "two words"]));
  assert.equal(first.marker, "fixture-main", "normalized duplicate tar entries must use the last payload");
  assert.deepEqual(first.argv, ["alpha", "two words"]);
  assert.equal(fs.realpathSync(first.cwd), fs.realpathSync(workDir));
  assert.equal(first.npmCommand, "exec");
  assert.equal(first.lifecycleEvent, "bunx");
  assert.equal(first.lifecycleScript, "fixture-tool");
  assert.match(first.userAgent, /^bun\/1\.3\.10 /);
  assert.equal(fs.realpathSync(first.execPath), fs.realpathSync(process.execPath));

  const requestsAfterInstall = requests.length;
  const cached = payload(await run(cottontail, ["x", "--silent", "--no-install", "fixture-tool", "cached"]));
  assert.equal(cached.marker, "fixture-main");
  assert.deepEqual(cached.argv, ["cached"]);
  assert.equal(requests.length, requestsAfterInstall, "--no-install should use the bunx cache without registry traffic");

  const exact = payload(await run(cottontail, ["x", "--silent", "fixture-tool@1.0.0", "exact"]));
  assert.equal(exact.marker, "fixture-main");
  assert.deepEqual(exact.argv, ["exact"]);

  const alternate = payload(await run(cottontail, ["x", "--silent", "--package", "fixture-tool", "alt-tool", "alternate"]));
  assert.equal(alternate.marker, "fixture-alt");
  assert.deepEqual(alternate.argv, ["alternate"]);

  const alternateEquals = payload(await run(cottontail, ["bunx", "--silent", "--package=fixture-tool", "alt-tool", "equals"]));
  assert.equal(alternateEquals.marker, "fixture-alt");
  assert.deepEqual(alternateEquals.argv, ["equals"]);

  const alternateShort = payload(await run(cottontail, ["x", "--silent", "-p", "fixture-tool", "alt-tool", "short"]));
  assert.equal(alternateShort.marker, "fixture-alt");
  assert.deepEqual(alternateShort.argv, ["short"]);

  const alias = payload(await run(cottontail, ["x", "--silent", "tsc@5.9.3", "alias"]));
  assert.equal(alias.marker, "typescript-tsc");
  assert.deepEqual(alias.argv, ["alias"]);

  const scoped = payload(await run(cottontail, ["x", "--silent", "@scope/scoped-tool", "scoped"]));
  assert.equal(scoped.marker, "scoped-actual-bin");
  assert.deepEqual(scoped.argv, ["scoped"]);

  const forced = payload(await run(cottontail, ["--bun", "x", "--silent", "fixture-tool", "forced"]));
  assert.equal(forced.marker, "fixture-main");
  assert.deepEqual(forced.argv, ["forced"]);
  assert.equal(fs.realpathSync(forced.execPath), fs.realpathSync(cottontail));

  const argv0 = path.join(scratch, process.platform === "win32" ? "bunx.exe" : "bunx");
  if (process.platform === "win32") fs.copyFileSync(cottontail, argv0);
  else fs.symlinkSync(cottontail, argv0);
  const aliased = payload(await run(argv0, ["--silent", "fixture-tool", "argv0"]));
  assert.equal(aliased.marker, "fixture-main");
  assert.deepEqual(aliased.argv, ["argv0"]);

  const localRoot = path.join(workDir, "node_modules", "local-tool");
  fs.mkdirSync(localRoot, { recursive: true });
  fs.writeFileSync(path.join(localRoot, "package.json"), JSON.stringify({ name: "local-tool", version: "1.0.0", bin: "cli.js" }));
  fs.writeFileSync(path.join(localRoot, "cli.js"), executableSource("local-tool"), { mode: 0o755 });
  const registryBeforeLocal = requests.length;
  const local = payload(await run(cottontail, ["x", "--silent", "local-tool", "local"]));
  assert.equal(local.marker, "local-tool");
  assert.equal(requests.length, registryBeforeLocal, "local package bins should win without registry traffic");

  fs.writeFileSync(path.join(workDir, "fixture-tool.tgz"), packages.get("fixture-tool").archive);
  const localTarball = payload(await run(cottontail, ["x", "--silent", "./fixture-tool.tgz", "tarball"]));
  assert.equal(localTarball.marker, "fixture-main");
  assert.deepEqual(localTarball.argv, ["tarball"]);

  const missing = await run(cottontail, ["x", "--no-install", "definitely-missing-cottontail-bin"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Could not find an existing 'definitely-missing-cottontail-bin' binary/);

  const missingPackage = await run(cottontail, ["x", "--package"]);
  assert.equal(missingPackage.status, 1);
  assert.match(missingPackage.stderr, /--package requires a package name/);

  const missingBinary = await run(cottontail, ["x", "--package", "fixture-tool"]);
  assert.equal(missingBinary.status, 1);
  assert.match(missingBinary.stderr, /must specify the binary to run/);

  const versionResult = await run(cottontail, ["x", "--version"]);
  expectSuccess(versionResult);
  assert.match(versionResult.stdout.trim(), /^\d+\.\d+\.\d+/);

  const usageResult = await run(cottontail, ["x"]);
  assert.equal(usageResult.status, 1);
  assert.match(usageResult.stderr, /Usage: cottontail x/);

  console.log("package-manager bunx: pass");
}

main()
  .finally(() => {
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  })
  .catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
