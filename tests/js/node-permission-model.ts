import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, toNamespacedPath } from "node:path";
import { spawnSync } from "node:child_process";

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "cottontail-permission-"));
const allowed = join(root, "allowed");
const denied = join(root, "denied");
mkdirSync(allowed);
mkdirSync(denied);
const readable = join(allowed, "readable.txt");
const blocked = join(denied, "blocked.txt");
writeFileSync(readable, "allowed");
writeFileSync(blocked, "blocked");

try {
  const script = `
    const assert = require("node:assert");
    const fs = require("node:fs");
    const path = require("node:path");
    const readable = ${JSON.stringify(readable)};
    const blocked = ${JSON.stringify(blocked)};
    const allowed = ${JSON.stringify(allowed)};
    assert.strictEqual(typeof process.permission.has, "function");
    assert.strictEqual(process.permission.has("fs"), false);
    assert.strictEqual(process.permission.has("fs.read", readable), true);
    assert.strictEqual(process.permission.has("fs.read", blocked), false);
    assert.strictEqual(fs.readFileSync(readable, "utf8"), "allowed");
    assert.throws(() => fs.readFileSync(blocked), {
      code: "ERR_ACCESS_DENIED",
      permission: "FileSystemRead",
    });
    fs.writeFileSync(path.join(allowed, "written.txt"), "written");
    assert.throws(() => fs.writeFileSync(blocked, "changed"), {
      code: "ERR_ACCESS_DENIED",
      permission: "FileSystemWrite",
    });
    assert.throws(() => fs.writeFileSync(path.join(allowed, "..", "escape.txt"), "changed"), {
      code: "ERR_ACCESS_DENIED",
      permission: "FileSystemWrite",
    });
    console.log("permission-enforcement-ok");
  `;
  const result = spawnSync(process.execPath, [
    "--permission",
    "--allow-fs-read", readable,
    "--allow-fs-write", allowed,
    "-e", script,
  ], { encoding: "utf8" });
  assert(result.status === 0, `permission child failed: ${result.stderr}`);
  assert(result.stdout.includes("permission-enforcement-ok"), "permission enforcement child did not finish");
  assert(readFileSync(blocked, "utf8") === "blocked", "denied file was modified");

  if (process.platform === "win32") {
    const driveRoot = parse(process.cwd()).root;
    const windowsScript = `
      const assert = require("node:assert");
      const path = require("node:path");
      const root = ${JSON.stringify(driveRoot)};
      assert.strictEqual(process.permission.has("fs.write", root), true);
      assert.strictEqual(process.permission.has("fs.write", path.toNamespacedPath(root)), true);
      assert.strictEqual(process.permission.has("fs.write", "\\\\\\\\A\\\\C:\\\\Users"), false);
      console.log("windows-permission-paths-ok");
    `;
    const windowsResult = spawnSync(process.execPath, [
      "--permission",
      "--allow-fs-write", `${driveRoot}*`,
      "-e", windowsScript,
    ], { encoding: "utf8" });
    assert(windowsResult.status === 0, `Windows permission path child failed: ${windowsResult.stderr}`);
    assert(windowsResult.stdout.includes("windows-permission-paths-ok"), "Windows permission path checks did not finish");

    const quoted = spawnSync(process.execPath, [
      "--permission",
      `--allow-fs-write="${toNamespacedPath(driveRoot)}"`,
      "-e",
      `console.log(process.permission.has("fs.write", ${JSON.stringify(driveRoot)}))`,
    ], { encoding: "utf8" });
    assert(quoted.status === 0, `quoted Windows permission child failed: ${quoted.stderr}`);
    assert(quoted.stdout.trim() === "false", `quoted Windows allow-list was accepted: ${JSON.stringify(quoted.stdout)}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("node permission model passed");
