import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const tempDir = mkdtempSync(path.join(os.tmpdir(), "cottontail-dist-tag-native-"));
const homeDir = path.join(tempDir, "home");
const packageDir = path.join(tempDir, "package");
mkdirSync(homeDir);
mkdirSync(packageDir);

const packageName = "@scope/native-dist-tag-fixture";
const tagsPath = "/-/package/@scope%2fnative-dist-tag-fixture/dist-tags";
const tags = { latest: "1.0.0", beta: "1.1.0" };
const requests = [];
let baseUrl;
let donePolls = 0;

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

    if (request.method === "GET" && request.url === "/otp/done") {
      donePolls += 1;
      if (donePolls === 1) {
        response.writeHead(202, { "content-type": "application/json", "retry-after": "0" });
        response.end(JSON.stringify({ pending: true }));
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ token: "246810" }));
      }
      return;
    }

    if (request.method === "GET" && request.url === tagsPath) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ _etag: "registry-etag", ...tags }));
      return;
    }
    if (request.method === "GET" && request.url === "/-/package/empty-package/dist-tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ _etag: "empty-etag" }));
      return;
    }

    if (request.method === "PUT" && request.url === `${tagsPath}/next`) {
      if (request.headers["npm-otp"] !== "246810") {
        response.writeHead(401, {
          "content-type": "application/json",
          "npm-notice": "authenticate dist-tag mutation",
        });
        response.end(
          JSON.stringify({
            message: "This operation requires a one-time password",
            authUrl: `${baseUrl}/otp/auth`,
            doneUrl: `${baseUrl}/otp/done`,
          }),
        );
        return;
      }
      tags.next = JSON.parse(captured.body);
      response.writeHead(200, { "content-type": "application/json", "npm-notice": "tag updated" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "PUT" && request.url === `${tagsPath}/blocked`) {
      response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer realm=registry" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    if (request.method === "PUT" && request.url?.startsWith(`${tagsPath}/`)) {
      const tag = decodeURIComponent(request.url.slice(tagsPath.length + 1));
      tags[tag] = JSON.parse(captured.body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "DELETE" && request.url?.startsWith(`${tagsPath}/`)) {
      const tag = decodeURIComponent(request.url.slice(tagsPath.length + 1));
      delete tags[tag];
      response.writeHead(204);
      response.end();
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

  writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: packageName, version: "1.0.0" }));
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
    HOME: homeDir,
    XDG_CONFIG_HOME: homeDir,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  });

  let start = requests.length;
  const listed = await runCottontail(["pm", "dist-tag", "ls"], packageDir, env);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, "beta: 1.1.0\nlatest: 1.0.0\n");
  assert.equal(requests.length, start + 1);
  assert.equal(requests[start].url, tagsPath);
  assert.equal(requests[start].headers.authorization, "Bearer registry-token");
  assert.equal(requests[start].headers["npm-command"], "dist-tag");
  assert.equal(requests[start].headers["npm-auth-type"], "web");

  start = requests.length;
  const idempotent = await runCottontail(
    ["pm", "dist-tag", "add", `${packageName}@1.1.0`, "beta"],
    packageDir,
    env,
  );
  assert.equal(idempotent.status, 0, idempotent.stderr);
  assert.match(idempotent.stderr, /already set to version 1\.1\.0/);
  assert.equal(requests.length, start + 1, "idempotent add must not send PUT");

  start = requests.length;
  const invalidTag = await runCottontail(
    ["pm", "dist-tag", "add", `${packageName}@2.0.0`, "^2.0.0"],
    packageDir,
    env,
  );
  assert.equal(invalidTag.status, 1);
  assert.match(invalidTag.stderr, /Tag name must not be a valid SemVer range: \^2\.0\.0/);
  assert.equal(requests.length, start, "invalid tags must fail before registry access");

  start = requests.length;
  const leadingZeroTag = await runCottontail(
    ["pm", "dist-tag", "add", `${packageName}@2.0.0`, "01.2.3"],
    packageDir,
    env,
  );
  assert.equal(leadingZeroTag.status, 0, leadingZeroTag.stderr);
  assert.equal(leadingZeroTag.stdout, `+01.2.3: ${packageName}@2.0.0\n`);
  assert.deepEqual(
    requests.slice(start).map(request => [request.method, request.url]),
    [
      ["GET", tagsPath],
      ["PUT", `${tagsPath}/01.2.3`],
    ],
  );

  start = requests.length;
  const added = await runCottontail(
    ["pm", "dist-tag", "add", `${packageName}@2.0.0`, "next"],
    packageDir,
    env,
  );
  assert.equal(added.status, 0, `dist-tag add failed\nstdout:\n${added.stdout}\nstderr:\n${added.stderr}`);
  assert.match(added.stdout, /Authenticate your account at:/);
  assert.match(added.stdout, /\+next: @scope\/native-dist-tag-fixture@2\.0\.0/);
  assert.match(added.stderr, /note: authenticate dist-tag mutation/);
  assert.match(added.stderr, /note: tag updated/);
  const addRequests = requests.slice(start);
  assert.deepEqual(
    addRequests.map(request => [request.method, request.url]),
    [
      ["GET", tagsPath],
      ["PUT", `${tagsPath}/next`],
      ["GET", "/otp/done"],
      ["GET", "/otp/done"],
      ["PUT", `${tagsPath}/next`],
    ],
  );
  assert.ok(!requests.some(request => request.url === "/otp/auth"), "web OTP must not assume a browser request");
  assert.equal(addRequests[1].body, '"2.0.0"');
  assert.equal(addRequests[1].headers["content-type"], "application/json");
  assert.equal(addRequests[4].headers["npm-auth-type"], "legacy");
  assert.equal(addRequests[4].headers["npm-otp"], "246810");
  assert.equal(addRequests[4].body, addRequests[1].body);

  start = requests.length;
  const removed = await runCottontail(["pm", "dist-tag", "rm", packageName, "beta"], packageDir, env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(removed.stdout, `-beta: ${packageName}@1.1.0\n`);
  assert.deepEqual(
    requests.slice(start).map(request => [request.method, request.url]),
    [
      ["GET", tagsPath],
      ["DELETE", `${tagsPath}/beta`],
    ],
  );

  start = requests.length;
  const missing = await runCottontail(["pm", "dist-tag", "rm", packageName, "missing"], packageDir, env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing is not a dist-tag/);
  assert.equal(requests.length, start + 1);

  start = requests.length;
  const unsupportedAuth = await runCottontail(
    ["pm", "dist-tag", "add", `${packageName}@3.0.0`, "blocked"],
    packageDir,
    env,
  );
  assert.equal(unsupportedAuth.status, 1);
  assert.match(unsupportedAuth.stderr, /unable to authenticate, need: Bearer realm=registry/);
  assert.equal(requests.length, start + 2);

  start = requests.length;
  const empty = await runCottontail(["pm", "dist-tag", "ls", "empty-package"], packageDir, env);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /No dist-tags found for empty-package/);
  assert.equal(requests.length, start + 1);

  console.log("package manager native dist-tag test passed");
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(tempDir, { recursive: true, force: true });
}
