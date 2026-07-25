import { spawnSync as nodeSpawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(process.platform === "win32", "windows-unicode-cwd must run on Windows");

const originalCwd = process.cwd();
const tempRoot = cottontail.env("COTTONTAIL_TMP_DIR") || tmpdir();
const root = join(tempRoot, `cottontail-unicode-cwd-${process.pid}-${Date.now()}`);
const unicodeLeaf = "目录-é-ß-🚀";
const unicodeDirectory = join(root, unicodeLeaf);
const childSource = `
  process.stdout.write(JSON.stringify({
    processCwd: process.cwd(),
    nativeCwd: cottontail.cwd(),
  }));
`;

function assertChildCwd(stdout: string, label: string) {
  const child = JSON.parse(stdout);
  assert(child.processCwd === unicodeDirectory, `${label} process.cwd() lost Unicode: ${child.processCwd}`);
  assert(child.nativeCwd === unicodeDirectory, `${label} cottontail.cwd() lost Unicode: ${child.nativeCwd}`);
}

mkdirSync(unicodeDirectory, { recursive: true });
try {
  process.chdir(root);
  process.chdir(unicodeLeaf);
  assert(process.cwd() === unicodeDirectory, `process.cwd() lost Unicode: ${process.cwd()}`);
  assert(cottontail.cwd() === unicodeDirectory, `cottontail.cwd() lost Unicode: ${cottontail.cwd()}`);

  process.chdir(originalCwd);

  const bunChild = Bun.spawnSync({
    cmd: [process.execPath, "-e", childSource],
    cwd: unicodeDirectory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  assert(
    bunChild.exitCode === 0,
    `Bun.spawnSync Unicode cwd failed (${bunChild.exitCode}): ${bunChild.stderr.toString()}`,
  );
  assertChildCwd(bunChild.stdout.toString(), "Bun.spawnSync child");

  const nodeChild = nodeSpawnSync(process.execPath, ["-e", childSource], {
    cwd: unicodeDirectory,
    encoding: "utf8",
  });
  assert(
    nodeChild.status === 0,
    `node:child_process Unicode cwd failed (${nodeChild.status}): ${nodeChild.stderr}`,
  );
  assertChildCwd(nodeChild.stdout, "node:child_process child");
} finally {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
}

console.log("windows unicode cwd passed");
