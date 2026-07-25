import {
  accessSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlink,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (cottontail.platform() === "win32") {
  assert(!existsSync(""), "existsSync should reject an empty Windows path");
  const cwd = cottontail.cwd().replaceAll("/", "\\");
  const lexicalLongPath = `${cwd}\\${".\\".repeat(140)}README.md`;
  assert(lexicalLongPath.length > 260, `long-path probe was unexpectedly short: ${lexicalLongPath.length}`);
  assert(existsSync(lexicalLongPath), `existsSync rejected an existing long path: ${lexicalLongPath}`);

  const root = join(
    cwd,
    ".cottontail-tmp",
    `node-fs-wide-${globalThis.process?.pid ?? 0}-${Date.now()}`,
  );
  const longDirectory = Array.from(
    { length: 8 },
    (_, index) => `层级-${index}-${"x".repeat(32)}`,
  ).reduce((directory, segment) => join(directory, segment), root);
  assert(longDirectory.length > 260, `nested long-path probe was unexpectedly short: ${longDirectory.length}`);

  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(longDirectory, { recursive: true });

    const originalName = "résumé-東京-🙂.txt";
    const originalPath = join(longDirectory, originalName);
    writeFileSync(originalPath, "abcdef", "utf8");
    accessSync(originalPath);
    assert(readFileSync(originalPath, "utf8") === "abcdef", "Unicode long-path read/write round trip failed");

    const fd = openSync(originalPath, "r+");
    try {
      const patch = new TextEncoder().encode("XYZ");
      assert(writeSync(fd, patch, 0, patch.length, 1) === patch.length, "long-path fd write was incomplete");
    } finally {
      closeSync(fd);
    }
    assert(readFileSync(originalPath, "utf8") === "aXYZef", "long-path fd write was not observable");

    const originalStat = statSync(originalPath);
    assert(originalStat.isFile(), "statSync did not identify the Unicode long-path file");
    assert(originalStat.size === 6, `statSync reported the wrong long-path size: ${originalStat.size}`);
    assert(!lstatSync(originalPath).isSymbolicLink(), "lstatSync misidentified a regular long-path file");

    const entries = readdirSync(longDirectory);
    assert(entries.includes(originalName), "readdirSync lost the Unicode long-path filename");
    const dirents = readdirSync(longDirectory, { withFileTypes: true });
    const originalDirent = dirents.find(entry => String(entry.name) === originalName);
    assert(originalDirent?.isFile(), "readdirSync Dirent metadata was wrong for a Unicode long-path file");

    const timestamp = 1_700_000_123;
    utimesSync(originalPath, timestamp, timestamp);
    assert(
      Math.abs(statSync(originalPath).mtimeMs - timestamp * 1000) < 2_000,
      "utimesSync did not update a Unicode long-path file",
    );

    truncateSync(originalPath, 4);
    assert(readFileSync(originalPath, "utf8") === "aXYZ", "truncateSync failed on a Unicode long path");

    const renamedName = "renamed-文件-🙂.txt";
    const renamedPath = join(longDirectory, renamedName);
    renameSync(originalPath, renamedPath);
    assert(!existsSync(originalPath) && existsSync(renamedPath), "renameSync failed on Unicode long paths");

    const hardLinkName = "hard-link-链接.txt";
    const hardLinkPath = join(longDirectory, hardLinkName);
    linkSync(renamedPath, hardLinkPath);
    assert(readFileSync(hardLinkPath, "utf8") === "aXYZ", "linkSync failed on a Unicode long path");

    const resolved = realpathSync(renamedPath);
    assert(!resolved.startsWith("\\\\?\\"), `realpathSync leaked an extended path prefix: ${resolved}`);
    assert(basename(resolved) === renamedName, `realpathSync lost the Unicode filename: ${resolved}`);

    const symbolicLinkName = "symbolic-link-符号.lnk";
    const symbolicLinkPath = join(longDirectory, symbolicLinkName);
    let symbolicLinkCreated = false;
    try {
      symlinkSync(renamedName, symbolicLinkPath, "file");
      symbolicLinkCreated = true;
    } catch (error: any) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    }
    if (symbolicLinkCreated) {
      assert(lstatSync(symbolicLinkPath).isSymbolicLink(), "lstatSync did not identify a Unicode long-path symlink");
      assert(readlinkSync(symbolicLinkPath) === renamedName, "readlinkSync lost a Unicode relative target");
      assert(readFileSync(symbolicLinkPath, "utf8") === "aXYZ", "Unicode long-path symlink target was unreadable");
      assert(
        realpathSync(symbolicLinkPath).toLowerCase() === resolved.toLowerCase(),
        "realpathSync did not resolve the Unicode long-path symlink",
      );

      const danglingSymbolicLinkPath = join(longDirectory, "dangling-symbolic-link.lnk");
      symlinkSync("missing-long-path-target.txt", danglingSymbolicLinkPath, "file");
      assert(!existsSync(danglingSymbolicLinkPath), "a dangling long-path symlink unexpectedly exists");
      assert(
        lstatSync(danglingSymbolicLinkPath).isSymbolicLink(),
        "lstatSync rejected a dangling symlink whose link path exceeds MAX_PATH",
      );
      assert(
        readlinkSync(danglingSymbolicLinkPath) === "missing-long-path-target.txt",
        "readlinkSync changed a dangling long-path symlink target",
      );

      const absoluteDirectoryLinkPath = join(root, "absolute-long-directory-link");
      await new Promise<void>((resolve, reject) => {
        symlink(
          longDirectory,
          absoluteDirectoryLinkPath,
          "dir",
          error => error ? reject(error) : resolve(),
        );
      });
      assert(
        statSync(absoluteDirectoryLinkPath).isDirectory(),
        "async symlink rejected an absolute long directory target",
      );
      assert(
        readlinkSync(absoluteDirectoryLinkPath).toLowerCase() === longDirectory.toLowerCase(),
        "async symlink changed an absolute long directory target",
      );

      const absoluteFileLinkPath = join(root, "absolute-long-file-link");
      symlinkSync(renamedPath, absoluteFileLinkPath, "file");
      assert(
        readFileSync(absoluteFileLinkPath, "utf8") === "aXYZ",
        "symlinkSync rejected an absolute long file target",
      );
      assert(
        readlinkSync(absoluteFileLinkPath).toLowerCase() === renamedPath.toLowerCase(),
        "symlinkSync changed an absolute long file target",
      );
    }

    const envName = "COTTONTAIL_UNICODE_环境";
    const envValue = "välüe-東京-🙂";
    const envProbe = [
      `const name = ${JSON.stringify(envName)};`,
      `const expected = ${JSON.stringify(envValue)};`,
      "if (process.env[name] !== expected) throw new Error(`process.env mismatch: ${process.env[name]}`);",
      "if (cottontail.env(name) !== expected) throw new Error(`cottontail.env(name) mismatch: ${cottontail.env(name)}`);",
      "if (cottontail.env()[name] !== expected) throw new Error(`cottontail.env() mismatch: ${cottontail.env()[name]}`);",
    ].join("");
    const child = spawnSync(globalThis.process.execPath, ["-e", envProbe], {
      encoding: "utf8",
      env: { ...globalThis.process.env, [envName]: envValue },
    });
    assert(
      child.status === 0,
      `Unicode Windows environment round trip failed (${child.status}): ${child.stderr || child.stdout}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("node fs windows long path passed");
