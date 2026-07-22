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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-create-test-"));
const workDir = path.join(scratch, "work");
const createDir = path.join(scratch, "templates");
const tempDir = path.join(scratch, "temp");
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(createDir, { recursive: true });
fs.mkdirSync(tempDir, { recursive: true });

function writeTarField(header, offset, width, value) {
  header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
}

function tarEntry(name, contents, mode = 0o644) {
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

function archive(entries) {
  return gzipSync(Buffer.concat([...entries.map(entry => tarEntry(entry.name, entry.contents, entry.mode)), Buffer.alloc(1024)]));
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cottontail, args, {
      cwd: options.cwd || workDir,
      env: {
        ...process.env,
        BUN_CREATE_DIR: createDir,
        BUN_TMPDIR: tempDir,
        TMPDIR: tempDir,
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", status => {
      clearTimeout(timeout);
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

function createLocalTemplate(name) {
  const root = path.join(createDir, name);
  fs.mkdirSync(path.join(root, "nested"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "ignored"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "app.js"), "console.log('app');\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "nested", "value.txt"), "nested\n");
  fs.writeFileSync(path.join(root, "node_modules", "ignored", "index.js"), "ignored\n");
  fs.writeFileSync(path.join(root, ".git", "config"), "ignored\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(root, "yarn.lock"), "ignored\n");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "ignored\n");
  fs.writeFileSync(path.join(root, "gitignore"), "node_modules\n");
  fs.writeFileSync(path.join(root, ".npmignore"), "src\n");
  fs.writeFileSync(
    path.join(root, "postinstall.cjs"),
    'require("node:fs").writeFileSync("postinstall-ran.txt", "yes\\n");\n',
  );
  writeJson(path.join(root, "package.json"), {
    name: "template-name",
    scripts: {
      dev: "bun app.js",
      legacy: "react-scripts start",
      build: "react-scripts build",
    },
    "bun-create": {
      postinstall: "bun postinstall.cjs",
      start: "bun run dev",
    },
  });
  return root;
}

const githubArchive = archive([
  {
    name: "owner-repository-deadbee/package.json",
    contents: `${JSON.stringify({
      name: "github-template",
      scripts: { dev: "bun src/app.js" },
      "bun-create": { start: "bun run dev" },
    })}\n`,
  },
  { name: "owner-repository-deadbee/src/app.js", contents: "console.log('remote');\n", mode: 0o755 },
  { name: "owner-repository-deadbee/README.md", contents: "remote readme\n" },
]);

const initializerArchive = archive([
  {
    name: "package/package.json",
    contents: `${JSON.stringify({
      name: "create-fixture",
      version: "1.0.0",
      bin: { "create-fixture": "cli.js" },
    })}\n`,
  },
  {
    name: "package/cli.js",
    mode: 0o755,
    contents: `#!/usr/bin/env bun
const fs = require("node:fs");
fs.writeFileSync("create-wrapper.json", JSON.stringify({
  argv: process.argv.slice(2),
  lifecycleEvent: process.env.npm_lifecycle_event,
  lifecycleScript: process.env.npm_lifecycle_script,
}));
`,
  },
]);
const initializerIntegrity = `sha512-${crypto.createHash("sha512").update(initializerArchive).digest("base64")}`;

const githubRequests = [];
const registryRequests = [];
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/repos/owner/repository/tarball") {
    githubRequests.push({ authorization: request.headers.authorization, url: request.url });
    response.writeHead(200, { "content-type": "application/x-gzip" });
    return response.end(githubArchive);
  }
  if (url.pathname === "/tarballs/create-fixture.tgz") {
    registryRequests.push(request.url);
    response.writeHead(200, { "content-type": "application/octet-stream" });
    return response.end(initializerArchive);
  }
  if (decodeURIComponent(url.pathname.slice(1)) === "create-fixture") {
    registryRequests.push(request.url);
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(
      JSON.stringify({
        name: "create-fixture",
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: "create-fixture",
            version: "1.0.0",
            bin: { "create-fixture": "cli.js" },
            dist: {
              tarball: `${origin}/tarballs/create-fixture.tgz`,
              integrity: initializerIntegrity,
            },
          },
        },
      }),
    );
  }
  response.writeHead(404);
  response.end();
});

async function main() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  createLocalTemplate("local-template");
  const localDestination = path.join(workDir, "local-app");
  fs.mkdirSync(localDestination, { recursive: true });
  fs.writeFileSync(path.join(localDestination, "stale.txt"), "stale\n");
  const local = await run([
    "create",
    "local-template",
    localDestination,
    "--no-install",
    "--no-git",
  ]);
  expectSuccess(local);
  assert.match(local.stdout, /Created local-template project successfully/);
  assert.match(local.stdout, /bun run dev/);
  assert.equal(fs.existsSync(path.join(localDestination, "stale.txt")), false);
  assert.equal(fs.readFileSync(path.join(localDestination, "nested", "value.txt"), "utf8"), "nested\n");
  assert.equal(fs.existsSync(path.join(localDestination, "node_modules")), false);
  assert.equal(fs.existsSync(path.join(localDestination, ".git")), false);
  assert.equal(fs.existsSync(path.join(localDestination, "package-lock.json")), false);
  assert.equal(fs.existsSync(path.join(localDestination, "yarn.lock")), false);
  assert.equal(fs.existsSync(path.join(localDestination, "pnpm-lock.yaml")), false);
  assert.equal(fs.existsSync(path.join(localDestination, "gitignore")), false);
  assert.equal(fs.readFileSync(path.join(localDestination, ".gitignore"), "utf8"), "node_modules\n");
  assert.equal(fs.existsSync(path.join(localDestination, ".npmignore")), false);
  assert.equal(fs.readFileSync(path.join(localDestination, "postinstall-ran.txt"), "utf8"), "yes\n");
  if (process.platform !== "win32") {
    assert.notEqual(fs.statSync(path.join(localDestination, "app.js")).mode & 0o111, 0);
  }
  const localPackage = JSON.parse(fs.readFileSync(path.join(localDestination, "package.json"), "utf8"));
  assert.equal(localPackage.name, "local-app");
  assert.equal(localPackage["bun-create"], undefined);
  assert.equal(localPackage.scripts.legacy, undefined);
  assert.equal(localPackage.scripts.build, "npx react-scripts build");

  createLocalTemplate("raw-template");
  const rawDestination = path.join(workDir, "raw-app");
  const raw = await run([
    "create",
    "raw-template",
    rawDestination,
    "--no-package-json",
    "--no-install",
    "--no-git",
  ]);
  expectSuccess(raw);
  const rawPackage = JSON.parse(fs.readFileSync(path.join(rawDestination, "package.json"), "utf8"));
  assert.equal(rawPackage.name, "template-name");
  assert.ok(rawPackage["bun-create"]);
  assert.equal(fs.existsSync(path.join(rawDestination, "postinstall-ran.txt")), false);

  const githubDestination = path.join(workDir, "github-app");
  fs.mkdirSync(path.join(githubDestination, "src"), { recursive: true });
  fs.writeFileSync(path.join(githubDestination, "src", "app.js"), "existing\n");
  fs.writeFileSync(path.join(githubDestination, "README.md"), "existing readme\n");
  const githubEnv = {
    GITHUB_API_URL: origin,
    GITHUB_TOKEN: "test-token",
  };
  const conflict = await run(
    ["create", "owner/repository", githubDestination, "--no-install", "--no-git"],
    { env: githubEnv },
  );
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /contains files that could conflict/);
  assert.match(conflict.stderr, /src\//);
  assert.equal(fs.readFileSync(path.join(githubDestination, "src", "app.js"), "utf8"), "existing\n");

  const forced = await run(
    ["create", "owner/repository", githubDestination, "--force", "--no-install", "--no-git"],
    { env: githubEnv },
  );
  expectSuccess(forced);
  assert.match(forced.stdout, /Success! owner\/repository loaded into github-app/);
  assert.equal(fs.readFileSync(path.join(githubDestination, "src", "app.js"), "utf8"), "console.log('remote');\n");
  assert.equal(JSON.parse(fs.readFileSync(path.join(githubDestination, "package.json"), "utf8")).name, "github-app");
  assert.ok(githubRequests.length >= 2);
  assert.ok(githubRequests.every(entry => entry.authorization === "Bearer test-token"));

  const currentDestination = path.join(workDir, "current-app");
  fs.mkdirSync(currentDestination, { recursive: true });
  const current = await run(
    ["create", "owner/repository", ".", "--no-install", "--no-git"],
    { cwd: currentDestination, env: githubEnv },
  );
  expectSuccess(current);
  assert.doesNotMatch(current.stdout, /\n  cd /);
  assert.match(current.stdout, /bun run dev/);

  const registry = `${origin}/`;
  const initializer = await run(
    ["create", "--bun", "fixture", "generated-app", "--flavor", "test"],
    { env: { npm_config_registry: registry } },
  );
  expectSuccess(initializer);
  const invocation = JSON.parse(fs.readFileSync(path.join(workDir, "create-wrapper.json"), "utf8"));
  assert.deepEqual(invocation.argv, ["generated-app", "--flavor", "test"]);
  assert.equal(invocation.lifecycleEvent, "bunx");
  assert.equal(invocation.lifecycleScript, "create-fixture");
  assert.ok(registryRequests.some(request => request === "/create-fixture"));

  const noArgs = await run(["create"]);
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stdout, /Usage:/);
  const empty = await run(["create", ""]);
  expectSuccess(empty);
  assert.match(empty.stdout, /Usage:/);

  console.log("package-manager create: pass");
}

main()
  .finally(() => {
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  })
  .catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
