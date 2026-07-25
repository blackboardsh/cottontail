import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlink,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertInvalidType(action: () => unknown, label: string) {
  let error: any;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  assert(error?.code === "ERR_INVALID_ARG_VALUE", `${label} accepted an invalid symlink type`);
}

function removeLink(path: string) {
  try {
    unlinkSync(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

assert(cottontail.platform() === "win32", "Windows symlink regression ran on a non-Windows host");
const tempDir = cottontail.env("COTTONTAIL_TMP_DIR");
assert(tempDir, "COTTONTAIL_TMP_DIR missing");

const root = join(tempDir, "node-fs-windows-symlink-types");
const invalidLink = join(root, "invalid-link");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

try {
  assertInvalidType(() => symlinkSync("target", invalidLink, "invalid" as any), "symlinkSync");
  assertInvalidType(
    () => symlink("target", invalidLink, 1 as any, () => {
      throw new Error("invalid symlink type reached callback");
    }),
    "symlink",
  );

  const junctionTarget = join(root, "junction-target");
  const junctionPath = join(root, "junction-link");
  mkdirSync(junctionTarget);
  const relativeJunctionTarget = relative(root, junctionTarget);
  symlinkSync(relativeJunctionTarget, junctionPath, "junction");

  const junctionReadlink = readlinkSync(junctionPath);
  assert(isAbsolute(junctionReadlink), `junction target was not made absolute: ${junctionReadlink}`);
  assert(
    resolve(junctionReadlink).toLowerCase() === junctionTarget.toLowerCase(),
    `junction target mismatch: ${junctionReadlink}`,
  );
  assert(lstatSync(junctionPath).isSymbolicLink(), "lstatSync did not identify the junction");
  assert(statSync(junctionPath).isDirectory(), "statSync did not follow the junction");

  const reparseQuery = spawnSync("fsutil.exe", ["reparsepoint", "query", junctionPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert(
    reparseQuery.status === 0 && /0xa0000003/i.test(reparseQuery.stdout),
    `symlink type "junction" did not create a mount-point reparse tag: ${reparseQuery.stderr || reparseQuery.stdout}`,
  );

  rmSync(junctionTarget, { recursive: true });
  assert(!existsSync(junctionPath), "dangling junction unexpectedly exists");
  assert(lstatSync(junctionPath).isSymbolicLink(), "lstatSync rejected a dangling junction");
  assert(
    resolve(readlinkSync(junctionPath)).toLowerCase() === junctionTarget.toLowerCase(),
    "readlinkSync rejected a dangling junction",
  );
  removeLink(junctionPath);

  let symlinkPrivilegeAvailable = true;
  const lateDirectory = join(root, "late-directory");
  const danglingDirectoryLink = join(root, "dangling-directory-link");
  try {
    symlinkSync("late-directory", danglingDirectoryLink, "dir");
  } catch (error: any) {
    if (error?.code === "EPERM" || error?.code === "EACCES") symlinkPrivilegeAvailable = false;
    else throw error;
  }

  if (symlinkPrivilegeAvailable) {
    assert(!existsSync(danglingDirectoryLink), "dangling directory symlink unexpectedly exists");
    assert(
      lstatSync(danglingDirectoryLink).isSymbolicLink(),
      "lstatSync rejected a dangling directory symlink",
    );
    mkdirSync(lateDirectory);
    assert(
      statSync(danglingDirectoryLink).isDirectory(),
      `symlink type "dir" was not retained until its target was created`,
    );
    removeLink(danglingDirectoryLink);
    rmSync(lateDirectory, { recursive: true });

    const lateFile = join(root, "late-file.txt");
    const danglingFileLink = join(root, "dangling-file-link");
    symlinkSync("late-file.txt", danglingFileLink, "file");
    assert(lstatSync(danglingFileLink).isSymbolicLink(), "lstatSync rejected a dangling file symlink");
    writeFileSync(lateFile, "late target");
    assert(readFileSync(danglingFileLink, "utf8") === "late target", "file symlink did not follow its late target");
    removeLink(danglingFileLink);
    rmSync(lateFile);

    const automaticDirectory = join(root, "automatic-directory");
    const automaticDirectoryLink = join(root, "automatic-directory-link");
    mkdirSync(automaticDirectory);
    symlinkSync("automatic-directory", automaticDirectoryLink);
    assert(
      statSync(automaticDirectoryLink).isDirectory(),
      "omitted symlink type did not detect a relative directory target beside the link",
    );
    removeLink(automaticDirectoryLink);
    rmSync(automaticDirectory, { recursive: true });
  }

  console.log("node fs windows symlink types passed");
} finally {
  removeLink(join(root, "junction-link"));
  removeLink(join(root, "dangling-directory-link"));
  removeLink(join(root, "dangling-file-link"));
  removeLink(join(root, "automatic-directory-link"));
  rmSync(root, { recursive: true, force: true });
}
