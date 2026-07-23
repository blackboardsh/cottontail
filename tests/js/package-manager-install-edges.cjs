"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { gzipSync } = require("node:zlib");

const cottontail = path.resolve(process.argv[2] || "zig-out/bin/cottontail");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-install-edges-"));

function writeJson(filename, value) {
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
  return gzipSync(
    Buffer.concat([
      header,
      body,
      Buffer.alloc((512 - (body.length % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
}

function isolatedEnvironment(home, extra = {}) {
  const env = { ...process.env, HOME: home, ...extra };
  for (const name of [
    "BUN_INSTALL_CACHE_DIR",
    "XDG_CACHE_HOME",
    "npm_config_cache",
    "NPM_CONFIG_CACHE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    delete env[name];
  }
  return env;
}

function runInstall(root, home, args = [], extraEnvironment = {}) {
  fs.mkdirSync(home, { recursive: true });
  return spawnSync(cottontail, ["install", "--silent", ...args], {
    cwd: root,
    env: isolatedEnvironment(home, extraEnvironment),
    encoding: "utf8",
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

function waitForFile(filename) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (fs.existsSync(filename)) return;
    Atomics.wait(signal, 0, 0, 10);
  }
  throw new Error(`timed out waiting for ${filename}`);
}

function testNodeGypLifecycle() {
  if (process.platform === "win32") return;

  const emptyPath = path.join(scratch, "empty-path");
  const fakeNodeGyp = path.join(scratch, "fake-node-gyp");
  fs.mkdirSync(emptyPath, { recursive: true });
  fs.writeFileSync(
    fakeNodeGyp,
    "#!/bin/sh\n" +
      "printf '%s|%s|%s\\n' \"$npm_package_name\" \"$npm_lifecycle_event\" \"$*\" >> \"$INIT_CWD/node-gyp-events\"\n" +
      ": > \"$PWD/build.node\"\n",
    { mode: 0o755 },
  );
  const lifecycleEnvironment = { PATH: emptyPath, npm_config_node_gyp: fakeNodeGyp };

  const root = path.join(scratch, "root-node-gyp");
  const home = path.join(scratch, "root-node-gyp-home");
  writeJson(path.join(root, "package.json"), {
    name: "root-node-gyp",
    version: "1.0.0",
    scripts: {
      postinstall: "printf 'postinstall\\n' >> \"$INIT_CWD/node-gyp-events\"",
    },
  });
  fs.writeFileSync(path.join(root, "binding.gyp"), "{}\n");

  let result = runInstall(root, home, [], lifecycleEnvironment);
  expectSuccess("automatic root node-gyp", result);
  assert.equal(
    fs.readFileSync(path.join(root, "node-gyp-events"), "utf8"),
    "root-node-gyp|install|rebuild\npostinstall\n",
  );
  assert.ok(fs.existsSync(path.join(root, "build.node")));

  fs.rmSync(path.join(root, "node-gyp-events"));
  fs.rmSync(path.join(root, "build.node"));
  result = runInstall(root, home, [], lifecycleEnvironment);
  expectSuccess("repeated automatic root node-gyp", result);
  assert.equal(
    fs.readFileSync(path.join(root, "node-gyp-events"), "utf8"),
    "root-node-gyp|install|rebuild\npostinstall\n",
  );

  writeJson(path.join(root, "package.json"), {
    name: "root-node-gyp",
    version: "1.0.0",
    scripts: {
      preinstall: "printf 'preinstall\\n' >> \"$INIT_CWD/node-gyp-events\"",
      postinstall: "printf 'postinstall\\n' >> \"$INIT_CWD/node-gyp-events\"",
    },
  });
  fs.rmSync(path.join(root, "node-gyp-events"));
  result = runInstall(root, home, [], lifecycleEnvironment);
  expectSuccess("preinstall suppresses automatic node-gyp", result);
  assert.equal(fs.readFileSync(path.join(root, "node-gyp-events"), "utf8"), "preinstall\npostinstall\n");

  writeJson(path.join(root, "package.json"), {
    name: "root-node-gyp",
    version: "1.0.0",
    scripts: { install: "node-gyp --version" },
  });
  fs.rmSync(path.join(root, "binding.gyp"));
  fs.rmSync(path.join(root, "node-gyp-events"));
  result = runInstall(root, home, [], lifecycleEnvironment);
  expectSuccess("node-gyp lifecycle PATH wrapper", result);
  assert.equal(
    fs.readFileSync(path.join(root, "node-gyp-events"), "utf8"),
    "root-node-gyp|install|--version\n",
  );

  const dependency = path.join(scratch, "native-dependency");
  writeJson(path.join(dependency, "package.json"), { name: "native-dependency", version: "1.0.0" });
  fs.writeFileSync(path.join(dependency, "binding.gyp"), "{}\n");
  const dependencyRoot = path.join(scratch, "dependency-node-gyp");
  const dependencyHome = path.join(scratch, "dependency-node-gyp-home");
  writeJson(path.join(dependencyRoot, "package.json"), {
    name: "dependency-node-gyp",
    version: "1.0.0",
    dependencies: { "native-dependency": "file:../native-dependency" },
  });
  result = runInstall(dependencyRoot, dependencyHome, [], lifecycleEnvironment);
  expectSuccess("automatic dependency node-gyp", result);
  assert.equal(
    fs.readFileSync(path.join(dependencyRoot, "node-gyp-events"), "utf8"),
    "native-dependency|install|rebuild\n",
  );
}

function testRegistryAndMinimumAge() {
  const registryRoot = path.join(scratch, "registry");
  const portFile = path.join(registryRoot, "port");
  const statsFile = path.join(registryRoot, "stats.json");
  fs.mkdirSync(registryRoot, { recursive: true });

  const versions = {
    "edge-package": ["1.0.0"],
    "cross-package": ["1.0.0"],
    "retry-package": ["1.0.0"],
    "age-package": ["1.0.0", "2.0.0"],
    "excluded-package": ["1.0.0", "2.0.0"],
    "invalid-time-package": ["1.0.0"],
    "direct-musl-package": ["1.0.0"],
    "glibc-package": ["1.0.0"],
    "musl-package": ["1.0.0"],
  };
  for (const [name, packageVersions] of Object.entries(versions)) {
    for (const version of packageVersions) {
      const libc = name === "glibc-package"
        ? ["glibc"]
        : name === "musl-package" || name === "direct-musl-package"
          ? ["musl"]
          : undefined;
      fs.writeFileSync(
        path.join(registryRoot, `${name}-${version}.tgz`),
        packageArchive({
          name,
          version,
          ...(libc ? { os: ["linux"], cpu: [process.arch], libc } : {}),
        }),
      );
    }
  }

  const serverFile = path.join(registryRoot, "server.cjs");
  fs.writeFileSync(
    serverFile,
    `
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const [root, portFile, statsFile] = process.argv.slice(2);
const stats = { requests: [], retryManifestRequests: 0 };
function save() { fs.writeFileSync(statsFile, JSON.stringify(stats)); }
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  stats.requests.push({
    host: request.headers.host,
    pathname: url.pathname,
    authorization: request.headers.authorization || null,
    npmAuthType: request.headers["npm-auth-type"] || null,
    accept: request.headers.accept || null,
  });
  if (url.pathname === "/retry-package") {
    stats.retryManifestRequests += 1;
    if (stats.retryManifestRequests <= 2) {
      save();
      response.writeHead(429).end("retry");
      return;
    }
  }
  if (url.pathname.startsWith("/tarballs/")) {
    const filename = path.join(root, path.basename(url.pathname));
    save();
    if (!fs.existsSync(filename)) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/octet-stream" });
    return fs.createReadStream(filename).pipe(response);
  }
  const name = url.pathname.slice(1);
  const packageVersions = ${JSON.stringify(versions)}[name];
  if (!packageVersions) {
    save();
    return response.writeHead(404).end();
  }
  const now = Date.now();
  const manifestVersions = {};
  const time = {};
  for (const version of packageVersions) {
    let tarball = "/tarballs/" + name + "-" + version + ".tgz";
    if (name === "cross-package") {
      tarball = "http://localhost:" + server.address().port + tarball;
    }
    manifestVersions[version] = { name, version, dist: { tarball } };
    if (version === "1.0.0") time[version] = new Date(now - 20 * 86400000).toISOString();
    else time[version] = new Date(now - 86400000).toISOString();
  }
  if (name === "invalid-time-package") time["1.0.0"] = "not-a-date";
  save();
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    name,
    "dist-tags": { latest: packageVersions[packageVersions.length - 1] },
    versions: manifestVersions,
    time,
  }));
});
save();
server.listen(0, () => fs.writeFileSync(portFile, String(server.address().port)));
`,
  );

  const server = spawn(process.execPath, [serverFile, registryRoot, portFile, statsFile], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    waitForFile(portFile);
    const port = Number(fs.readFileSync(portFile, "utf8"));
    const root = path.join(scratch, "registry-project");
    const home = path.join(scratch, "registry-project-home");
    writeJson(path.join(root, "package.json"), {
      name: "registry-project",
      version: "1.0.0",
      dependencies: {
        "edge-package": "*",
        "cross-package": "*",
        "retry-package": "*",
        "age-package": "*",
        "excluded-package": "*",
        "invalid-time-package": "*",
        "direct-musl-package": "*",
      },
      optionalDependencies: {
        "glibc-package": "*",
        "musl-package": "*",
      },
    });
    fs.writeFileSync(
      path.join(root, "bunfig.toml"),
      `[install]\nregistry = "http://127.0.0.1:${port}///"\nminimumReleaseAge = ${5 * 86400}\nminimumReleaseAgeExcludes = ["excluded-package"]\n`,
    );

    const result = runInstall(root, home, ["--no-verify"], {
      BUN_CONFIG_TOKEN: "edge-token",
    });
    expectSuccess("registry edge and minimum release age install", result);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "node_modules", "age-package", "package.json"))).version,
      "1.0.0",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "node_modules", "excluded-package", "package.json"))).version,
      "2.0.0",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "node_modules", "invalid-time-package", "package.json"))).version,
      "1.0.0",
    );
    if (process.platform === "linux") {
      assert.ok(fs.existsSync(path.join(root, "node_modules", "glibc-package", "package.json")));
      assert.ok(!fs.existsSync(path.join(root, "node_modules", "musl-package")));
      assert.ok(!fs.existsSync(path.join(root, "node_modules", "direct-musl-package")));

      // Bun's current lock format does not persist libc metadata, so a
      // lockfile reinstall must rehydrate it from the package archives.
      fs.rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
      const lockedResult = runInstall(root, home, ["--no-verify"], {
        BUN_CONFIG_TOKEN: "edge-token",
      });
      expectSuccess("registry libc install from legacy lock metadata", lockedResult);
      assert.ok(fs.existsSync(path.join(root, "node_modules", "glibc-package", "package.json")));
      assert.ok(!fs.existsSync(path.join(root, "node_modules", "musl-package")));
      assert.ok(!fs.existsSync(path.join(root, "node_modules", "direct-musl-package")));
    }

    const stats = JSON.parse(fs.readFileSync(statsFile, "utf8"));
    assert.ok(stats.retryManifestRequests >= 3, "429 manifest response was not retried");
    const manifests = stats.requests.filter((request) => !request.pathname.startsWith("/tarballs/"));
    assert.ok(manifests.length >= Object.keys(versions).length);
    assert.ok(manifests.every((request) => !request.pathname.startsWith("//")));
    assert.ok(manifests.every((request) => request.authorization === "Bearer edge-token"));
    assert.ok(manifests.every((request) => request.npmAuthType === "legacy"));
    assert.ok(manifests.every((request) => request.accept.includes("application/json")));

    const sameOriginTarballs = stats.requests.filter(
      (request) => request.pathname.startsWith("/tarballs/") && request.host.startsWith("127.0.0.1:"),
    );
    assert.ok(sameOriginTarballs.length > 0);
    assert.ok(sameOriginTarballs.every((request) => request.authorization === "Bearer edge-token"));
    const crossOriginTarball = stats.requests.find(
      (request) => request.pathname === "/tarballs/cross-package-1.0.0.tgz" && request.host.startsWith("localhost:"),
    );
    assert.ok(crossOriginTarball, "cross-origin tarball was not requested");
    assert.equal(crossOriginTarball.authorization, null);

    if (process.platform === "linux") {
      const offlineRoot = path.join(scratch, "registry-offline-project");
      const offlineHome = path.join(scratch, "registry-offline-home");
      writeJson(path.join(offlineRoot, "package.json"), {
        name: "registry-offline-project",
        version: "1.0.0",
        dependencies: { "edge-package": "*" },
      });
      fs.writeFileSync(
        path.join(offlineRoot, "bunfig.toml"),
        `[install]\nregistry = "http://127.0.0.1:${port}/"\n`,
      );
      expectSuccess(
        "registry offline fixture initial install",
        runInstall(offlineRoot, offlineHome, ["--no-verify"]),
      );

      const lockPath = path.join(offlineRoot, "bun.lock");
      const lockSource = fs.readFileSync(lockPath, "utf8");
      const unreachableLockSource = lockSource.replaceAll(`:${port}`, ":1");
      assert.notEqual(unreachableLockSource, lockSource, "offline fixture lock should contain registry URLs");
      fs.writeFileSync(lockPath, unreachableLockSource);
      fs.rmSync(path.join(offlineHome, ".bun", "install", "cache"), {
        recursive: true,
        force: true,
      });
      expectSuccess(
        "intact legacy lock reinstall without registry or tarball cache",
        runInstall(offlineRoot, offlineHome, ["--no-verify"]),
      );
    }
  } finally {
    server.kill();
  }
}

try {
  testNodeGypLifecycle();
  testRegistryAndMinimumAge();
  console.log("package-manager install edges: pass");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
