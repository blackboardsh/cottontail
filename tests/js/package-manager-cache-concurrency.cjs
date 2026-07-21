"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { spawn, spawnSync } = require("node:child_process");
const { gzipSync } = require("node:zlib");

const cottontail = path.resolve(process.argv[2] || "zig-out/bin/cottontail");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-cache-concurrency-"));
const registryRoot = path.join(scratch, "registry");
const projectRoot = path.join(scratch, "project");
const home = path.join(scratch, "home");
const portFile = path.join(registryRoot, "port");
const statsFile = path.join(registryRoot, "stats.json");
const packageCount = 8;
const responseDelayMs = 220;

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

function waitForFile(filename) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (fs.existsSync(filename)) return;
    Atomics.wait(signal, 0, 0, 10);
  }
  throw new Error(`timed out waiting for ${filename}`);
}

function readStats() {
  return JSON.parse(fs.readFileSync(statsFile, "utf8"));
}

function runInstall(args = []) {
  const env = { ...process.env, HOME: home };
  delete env.BUN_INSTALL_CACHE_DIR;
  delete env.XDG_CACHE_HOME;
  delete env.npm_config_cache;
  delete env.NPM_CONFIG_CACHE;
  const started = performance.now();
  const result = spawnSync(cottontail, ["install", "--ignore-scripts", "--silent", ...args], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
  return { result, elapsedMs: performance.now() - started };
}

function expectSuccess(run) {
  assert.equal(
    run.result.status,
    0,
    `install failed\nstdout:\n${run.result.stdout}\nstderr:\n${run.result.stderr}`,
  );
}

function removeInstall({ lockfile }) {
  fs.rmSync(path.join(projectRoot, "node_modules"), { recursive: true, force: true });
  if (lockfile) {
    fs.rmSync(path.join(projectRoot, "bun.lock"), { force: true });
    fs.rmSync(path.join(projectRoot, "bun.lockb"), { force: true });
  }
}

function countCacheFiles(root, extension) {
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) count += countCacheFiles(filename, extension);
    else if (entry.name.endsWith(extension)) count += 1;
  }
  return count;
}

fs.mkdirSync(registryRoot, { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(home, { recursive: true });

const dependencies = {};
for (let index = 0; index < packageCount; index += 1) {
  const name = `delayed-package-${index}`;
  const metadata = { name, version: "1.0.0" };
  const archive = packageArchive(metadata);
  dependencies[name] = "1.0.0";
  fs.writeFileSync(path.join(registryRoot, `${name}.tgz`), archive);
  fs.writeFileSync(
    path.join(registryRoot, `${name}.json`),
    JSON.stringify({
      metadata,
      integrity: `sha512-${crypto.createHash("sha512").update(archive).digest("base64")}`,
    }),
  );
}

fs.writeFileSync(
  path.join(projectRoot, "package.json"),
  `${JSON.stringify({ name: "cache-concurrency", version: "1.0.0", dependencies }, null, 2)}\n`,
);

const serverFile = path.join(registryRoot, "server.cjs");
fs.writeFileSync(
  serverFile,
  `
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const [root, portFile, statsFile, delayText] = process.argv.slice(2);
const delay = Number(delayText);
const stats = { active: 0, maxActive: 0, requests: 0 };
function saveStats() { fs.writeFileSync(statsFile, JSON.stringify(stats)); }
const server = http.createServer((request, response) => {
  stats.active += 1;
  stats.requests += 1;
  stats.maxActive = Math.max(stats.maxActive, stats.active);
  saveStats();
  setTimeout(() => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname.startsWith("/tarballs/")) {
      const filename = path.join(root, path.basename(pathname));
      if (fs.existsSync(filename)) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(fs.readFileSync(filename));
      } else {
        response.writeHead(404).end();
      }
    } else {
      const name = pathname.slice(1);
      const metadataFile = path.join(root, name + ".json");
      if (!fs.existsSync(metadataFile)) {
        response.writeHead(404).end();
      } else {
        const fixture = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
        const metadata = {
          ...fixture.metadata,
          dist: {
            tarball: "http://127.0.0.1:" + server.address().port + "/tarballs/" + name + ".tgz",
            integrity: fixture.integrity,
          },
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          name,
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": metadata },
        }));
      }
    }
    stats.active -= 1;
    saveStats();
  }, delay);
});
saveStats();
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
`,
);

const server = spawn(
  process.execPath,
  [serverFile, registryRoot, portFile, statsFile, String(responseDelayMs)],
  { stdio: ["ignore", "ignore", "inherit"] },
);

try {
  waitForFile(portFile);
  const port = fs.readFileSync(portFile, "utf8");
  fs.writeFileSync(
    path.join(projectRoot, "bunfig.toml"),
    `[install]\nregistry = "http://127.0.0.1:${port}/"\n`,
  );

  const cold = runInstall();
  expectSuccess(cold);
  const coldStats = readStats();
  assert.equal(coldStats.requests, packageCount * 2);
  assert.ok(coldStats.maxActive >= 4, `expected concurrent fetches, observed ${coldStats.maxActive}`);
  assert.ok(
    cold.elapsedMs < 2_500,
    `cold install took ${cold.elapsedMs.toFixed(2)}ms; delayed requests appear serialized`,
  );

  const cacheRoot = path.join(home, ".bun", "install", "cache");
  assert.equal(countCacheFiles(cacheRoot, ".npm"), packageCount);
  assert.equal(countCacheFiles(cacheRoot, ".tgz"), packageCount);

  removeInstall({ lockfile: false });
  const warmLocked = runInstall();
  expectSuccess(warmLocked);
  assert.equal(readStats().requests, coldStats.requests, "lockfile reinstall contacted the registry");

  removeInstall({ lockfile: true });
  const warmUnlocked = runInstall();
  expectSuccess(warmUnlocked);
  assert.equal(readStats().requests, coldStats.requests, "manifest-cache reinstall contacted the registry");

  removeInstall({ lockfile: true });
  const noCache = runInstall(["--no-cache"]);
  expectSuccess(noCache);
  assert.equal(
    readStats().requests,
    coldStats.requests + packageCount * 2,
    "--no-cache reused registry artifacts",
  );

  console.log(
    `package-manager cache concurrency: pass ` +
      `(cold=${cold.elapsedMs.toFixed(2)}ms, warm-lock=${warmLocked.elapsedMs.toFixed(2)}ms, ` +
      `warm-unlocked=${warmUnlocked.elapsedMs.toFixed(2)}ms, no-cache=${noCache.elapsedMs.toFixed(2)}ms, ` +
      `max-active=${coldStats.maxActive})`,
  );
} finally {
  server.kill();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
