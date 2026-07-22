import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

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
    }, 20_000);
    child.once("close", status => {
      clearTimeout(timeout);
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
  });
}

function parseTar(bytes) {
  const entries = new Map();
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "");
    const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/s, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const dataStart = offset + 512;
    entries.set(name, bytes.subarray(dataStart, dataStart + size));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

const tempDir = mkdtempSync(path.join(os.tmpdir(), "cottontail-publish-native-"));
const homeDir = path.join(tempDir, "home");
const packageDir = path.join(tempDir, "package");
mkdirSync(homeDir);
mkdirSync(packageDir);

const requests = [];
let baseUrl;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    const captured = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString(),
    };
    requests.push(captured);

    if (request.method === "GET" && request.url === "/done") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ token: "654321" }));
      return;
    }
    if (request.method === "PUT" && request.url === "/@scope%2fnative-publish-fixture") {
      if (request.headers["npm-otp"] !== "654321") {
        response.writeHead(401, {
          "content-type": "application/json",
          "npm-notice": "complete registry authentication",
          "www-authenticate": "OTP",
        });
        response.end(JSON.stringify({ authUrl: `${baseUrl}/auth`, doneUrl: `${baseUrl}/done` }));
        return;
      }
      response.writeHead(201, { "content-type": "application/json", "npm-notice": "published" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unexpected request" }));
  });
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const lifecycleScript =
    'require("node:fs").appendFileSync("lifecycle.log", `${process.env.npm_lifecycle_event}:${process.env.npm_command}\\n`);\n';
  const lifecycleCommand = "node lifecycle.cjs";
  writeFileSync(path.join(packageDir, "lifecycle.cjs"), lifecycleScript);
  mkdirSync(path.join(packageDir, "bin"));
  writeFileSync(path.join(packageDir, "bin", "cli.js"), "#!/usr/bin/env node\nconsole.log('fixture');\n");
  writeFileSync(path.join(packageDir, "README.md"), "# Native publish fixture\n");
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@scope/native-publish-fixture",
      version: "1.2.3+build.7",
      bin: "./bin/cli.js",
      dependencies: { "workspace-dependency": "workspace:1.0.0" },
      scripts: {
        prepublishOnly: lifecycleCommand,
        prepack: lifecycleCommand,
        prepare: lifecycleCommand,
        postpack: lifecycleCommand,
        publish: lifecycleCommand,
        postpublish: lifecycleCommand,
      },
    }),
  );
  writeFileSync(
    path.join(packageDir, "bunfig.toml"),
    `[install]\ncache = false\nregistry = { url = "${baseUrl}", token = "registry-token" }\n`,
  );

  const env = { ...process.env };
  for (const name of [
    "BUN_CONFIG_REGISTRY",
    "BUN_CONFIG_TOKEN",
    "NPM_CONFIG_REGISTRY",
    "NPM_CONFIG_TOKEN",
    "npm_config_registry",
  ]) {
    delete env[name];
  }
  Object.assign(env, {
    EAS_BUILD: "1",
    HOME: homeDir,
    XDG_CONFIG_HOME: homeDir,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  });

  const result = await runCottontail(["publish", "--tag", "beta", "--access", "public"], packageDir, env);
  assert.equal(result.status, 0, `publish failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /Tag: beta/);
  assert.match(result.stdout, /Access: public/);
  assert.match(result.stdout, /\+ @scope\/native-publish-fixture@1\.2\.3/);
  assert.match(result.stdout, /Authenticate your account at:/);
  assert.match(result.stderr, /note: complete registry authentication/);
  assert.match(result.stderr, /note: published/);

  assert.equal(requests.length, 3);
  const [initialPut, doneRequest, otpPut] = requests;
  assert.equal(initialPut.method, "PUT");
  assert.equal(initialPut.url, "/@scope%2fnative-publish-fixture");
  assert.equal(initialPut.headers.authorization, "Bearer registry-token");
  assert.equal(initialPut.headers["npm-auth-type"], "web");
  assert.equal(initialPut.headers["npm-command"], "publish");
  assert.equal(initialPut.headers["content-type"], "application/json");
  assert.match(initialPut.headers["user-agent"], /workspaces\/true/);
  assert.match(initialPut.headers["user-agent"], /ci\/expo-application-services/);
  assert.equal(doneRequest.method, "GET");
  assert.equal(doneRequest.url, "/done");
  assert.equal(otpPut.headers["npm-auth-type"], "legacy");
  assert.equal(otpPut.headers["npm-otp"], "654321");
  assert.equal(otpPut.body, initialPut.body);

  const document = JSON.parse(otpPut.body);
  assert.equal(document._id, "@scope/native-publish-fixture");
  assert.equal(document.name, "@scope/native-publish-fixture");
  assert.deepEqual(document["dist-tags"], { beta: "1.2.3" });
  assert.equal(document.access, "public");
  assert.deepEqual(Object.keys(document.versions), ["1.2.3"]);
  const metadata = document.versions["1.2.3"];
  assert.equal(metadata._id, "@scope/native-publish-fixture@1.2.3");
  assert.equal(metadata.version, "1.2.3+build.7");
  assert.equal(metadata.dependencies["workspace-dependency"], "1.0.0");
  assert.deepEqual(metadata.bin, { "@scope/native-publish-fixture": "bin/cli.js" });
  assert.equal(metadata.readme, "# Native publish fixture\n");
  assert.equal(metadata.readmeFilename, "README.md");

  const attachmentName = "@scope/native-publish-fixture-1.2.3+build.7.tgz";
  const attachment = document._attachments[attachmentName];
  assert.ok(attachment);
  const tarball = Buffer.from(attachment.data, "base64");
  assert.equal(attachment.length, tarball.length);
  assert.equal(metadata.shasum, createHash("sha1").update(tarball).digest("hex"));
  assert.equal(metadata.integrity, `sha512-${createHash("sha512").update(tarball).digest("base64")}`);
  assert.equal(metadata.dist.shasum, metadata.shasum);
  assert.equal(metadata.dist.integrity, metadata.integrity);
  assert.equal(
    metadata.dist.tarball,
    `${baseUrl}/@scope/native-publish-fixture/-/${attachmentName}`,
  );

  const tarEntries = parseTar(gunzipSync(tarball));
  assert.ok(tarEntries.has("package/package.json"));
  const packedManifest = JSON.parse(tarEntries.get("package/package.json").toString());
  assert.equal(packedManifest.dependencies["workspace-dependency"], "1.0.0");
  assert.equal(existsSync(path.join(packageDir, "scope-native-publish-fixture-1.2.3+build.7.tgz")), false);
  assert.equal(
    readFileSync(path.join(packageDir, "lifecycle.log"), "utf8"),
    [
      "prepublishOnly:pack",
      "prepack:pack",
      "prepare:pack",
      "postpack:pack",
      "publish:publish",
      "postpublish:publish",
      "",
    ].join("\n"),
  );

  const invalid = await runCottontail(["publish", "--access", "team"], packageDir, env);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /invalid `access` value: 'team'/);
  assert.equal(requests.length, 3);

  const noAuthDir = path.join(tempDir, "no-auth");
  mkdirSync(noAuthDir);
  writeFileSync(path.join(noAuthDir, "package.json"), JSON.stringify({ name: "no-auth", version: "1.0.0" }));
  const noAuth = await runCottontail(["publish", "--dry-run", "--ignore-scripts"], noAuthDir, env);
  assert.equal(noAuth.status, 1);
  assert.match(noAuth.stderr, /missing authentication/);

  console.log("package manager native publish test passed");
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(tempDir, { recursive: true, force: true });
}
