import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "cottontail-package-link-"));
const installHome = join(root, "home");
const packageDir = join(root, "linked-package");
const consumerDir = join(root, "consumer");
const runtimeCache = join(root, "runtime-cache");
mkdirSync(packageDir, { recursive: true });
mkdirSync(consumerDir, { recursive: true });
mkdirSync(runtimeCache, { recursive: true });

const env = {
  ...process.env,
  BUN_INSTALL: installHome,
  COTTONTAIL_TMP_DIR: runtimeCache,
};

function run(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8" });
  assert(result.status === 0, `${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  return result;
}

try {
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "linked-pkg",
      version: "1.2.3",
      bin: { "linked-cli": "cli.js" },
    }),
  );
  writeFileSync(join(packageDir, "cli.js"), "#!/usr/bin/env node\nconsole.log('linked cli')\n");
  writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0" }));

  const registered = run(packageDir, ["link"]);
  assert(registered.stdout.includes('Success! Registered "linked-pkg"'), "global registration output mismatch");

  const linked = run(consumerDir, ["link", "linked-pkg", "--save-text-lockfile"]);
  assert(linked.stdout.includes("installed linked-pkg@link:linked-pkg"), "consumer link output mismatch");
  assert(existsSync(join(consumerDir, "node_modules", "linked-pkg", "package.json")), "package link missing");
  assert(existsSync(join(consumerDir, "node_modules", ".bin", "linked-cli")), "consumer bin link missing");
  assert(readFileSync(join(consumerDir, "bun.lock"), "utf8").includes('"linked-pkg": "link:linked-pkg"'), "lockfile link spec missing");

  const cli = spawnSync(join(consumerDir, "node_modules", ".bin", "linked-cli"), [], { encoding: "utf8" });
  assert(cli.status === 0 && cli.stdout.includes("linked cli"), "linked executable did not run");

  const unlinked = run(packageDir, ["unlink"]);
  assert(unlinked.stdout.includes('success: unlinked package "linked-pkg"'), "global unlink output mismatch");
  assert(!existsSync(join(installHome, "install", "global", "node_modules", "linked-pkg")), "global package link remains");
  assert(!existsSync(join(installHome, "bin", "linked-cli")), "global bin link remains");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("bun package manager link passed");
