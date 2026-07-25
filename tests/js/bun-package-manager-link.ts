import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const globalPackageDir = join(installHome, "install", "global", "node_modules", "linked-pkg");
const globalBinDir = join(installHome, "bin");
const globalCopyMarker = join(globalPackageDir, ".cottontail-global-link-source");
const globalCopyMarkerPrefix = "COTTONTAIL_GLOBAL_LINK_COPY_V1\n";
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
  assert(existsSync(globalPackageDir), "global package registration missing");
  const globalPackageStat = lstatSync(globalPackageDir);
  if (globalPackageStat.isSymbolicLink()) {
    assert(!existsSync(globalCopyMarker), "global symlink unexpectedly contains a copy-fallback marker");
  } else if (process.platform === "win32" && globalPackageStat.isDirectory()) {
    assert(existsSync(globalCopyMarker), "Windows global-link fallback marker missing");
    assert(
      readFileSync(globalCopyMarker, "utf8") === `${globalCopyMarkerPrefix}${packageDir}`,
      "Windows global-link fallback marker mismatch",
    );
  } else {
    throw new Error("global registration is neither a symbolic link nor the Windows copy fallback");
  }

  const linked = run(consumerDir, ["link", "linked-pkg", "--save-text-lockfile"]);
  assert(linked.stdout.includes("installed linked-pkg@link:linked-pkg"), "consumer link output mismatch");
  assert(existsSync(join(consumerDir, "node_modules", "linked-pkg", "package.json")), "package link missing");
  const executableNames = process.platform === "win32"
    ? ["linked-cli.exe", "linked-cli.cmd", "linked-cli"]
    : ["linked-cli"];
  const executablePath = executableNames
    .map((name) => join(consumerDir, "node_modules", ".bin", name))
    .find(existsSync);
  assert(executablePath, "consumer bin link missing");
  assert(readFileSync(join(consumerDir, "bun.lock"), "utf8").includes('"linked-pkg": "link:linked-pkg"'), "lockfile link spec missing");

  const cli = spawnSync(executablePath, [], {
    encoding: "utf8",
    shell: process.platform === "win32" && executablePath.toLowerCase().endsWith(".cmd"),
  });
  assert(
    cli.status === 0 && cli.stdout.includes("linked cli"),
    `linked executable did not run: status=${cli.status}, error=${cli.error?.message ?? ""}, stderr=${cli.stderr}`,
  );

  const unlinked = run(packageDir, ["unlink"]);
  assert(unlinked.stdout.includes('success: unlinked package "linked-pkg"'), "global unlink output mismatch");
  assert(readFileSync(join(packageDir, "cli.js"), "utf8").includes("linked cli"), "global unlink damaged the source package");
  assert(
    !existsSync(globalPackageDir),
    `global package link remains: stdout=${unlinked.stdout}, marker=${
      existsSync(globalCopyMarker) ? readFileSync(globalCopyMarker, "utf8") : "<missing>"
    }, entries=${existsSync(globalPackageDir) ? readdirSync(globalPackageDir).join(",") : "<missing>"}`,
  );
  for (const executableName of [...executableNames, "linked-cli.bunx"]) {
    assert(!existsSync(join(globalBinDir, executableName)), `global bin link remains: ${executableName}`);
  }

  mkdirSync(globalPackageDir, { recursive: true });
  mkdirSync(globalBinDir, { recursive: true });
  const unrelatedPackageSentinel = join(globalPackageDir, "keep.txt");
  const unrelatedBinSentinel = join(globalBinDir, process.platform === "win32" ? "linked-cli.cmd" : "linked-cli");
  writeFileSync(unrelatedPackageSentinel, "keep");
  writeFileSync(unrelatedBinSentinel, "keep");
  const ignoredUnlink = run(packageDir, ["unlink"]);
  assert(ignoredUnlink.stdout.includes("is not globally linked"), "ordinary directory unlink output mismatch");
  assert(existsSync(unrelatedPackageSentinel), "ordinary global package directory was removed");
  assert(existsSync(unrelatedBinSentinel), "ordinary global bin was removed");

  writeFileSync(globalCopyMarker, `${globalCopyMarkerPrefix}${join(root, "different-source")}`);
  const wrongSourceUnlink = run(packageDir, ["unlink"]);
  assert(wrongSourceUnlink.stdout.includes("is not globally linked"), "wrong-source marker unlink output mismatch");
  assert(existsSync(unrelatedPackageSentinel), "wrong-source global package directory was removed");
  assert(existsSync(unrelatedBinSentinel), "wrong-source global bin was removed");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("bun package manager link passed");
