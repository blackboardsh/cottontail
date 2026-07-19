import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const tempDir = cottontail.env("COTTONTAIL_TMP_DIR");
assert(tempDir, "COTTONTAIL_TMP_DIR missing");

const root = join(tempDir, "node-fs-unlink-directory-link");
const ordinaryDirectory = join(root, "ordinary-directory");
const targetDirectory = join(root, "target-directory");
const linkPath = join(root, "directory-link");
const sentinelPath = join(targetDirectory, "sentinel.txt");

rmSync(root, { recursive: true, force: true });
mkdirSync(ordinaryDirectory, { recursive: true });
mkdirSync(targetDirectory, { recursive: true });
writeFileSync(sentinelPath, "target survived");

try {
  let ordinaryDirectoryError: unknown;
  try {
    unlinkSync(ordinaryDirectory);
  } catch (error) {
    ordinaryDirectoryError = error;
  }
  assert(
    (ordinaryDirectoryError as { code?: string } | undefined)?.code === "EISDIR",
    `unlinkSync ordinary directory should fail with EISDIR, received ${String(ordinaryDirectoryError)}`,
  );
  assert(existsSync(ordinaryDirectory), "unlinkSync removed an ordinary directory");

  if (cottontail.platform() === "win32") {
    const junction = spawnSync("cmd.exe", ["/D", "/C", "mklink", "/J", linkPath, targetDirectory], {
      encoding: "utf8",
    });
    assert(
      junction.status === 0,
      `failed to create directory junction (${junction.status}): ${junction.stderr || junction.stdout}`,
    );
  } else {
    symlinkSync(targetDirectory, linkPath, "dir");
  }

  assert(lstatSync(linkPath).isSymbolicLink(), "directory link was not reported as a symbolic link");
  unlinkSync(linkPath);

  assert(!existsSync(linkPath), "unlinkSync left the directory link in place");
  assert(readFileSync(sentinelPath, "utf8") === "target survived", "unlinkSync damaged the link target");

  console.log("node fs unlink directory link passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
