import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-fs-native-bulk-"));

beforeAll(() => fs.mkdirSync(root, { recursive: true }));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function createTree(name: string) {
  const tree = path.join(root, name);
  fs.mkdirSync(path.join(tree, "nested", "deep"), { recursive: true });
  fs.writeFileSync(path.join(tree, "root.txt"), "root");
  fs.writeFileSync(path.join(tree, "nested", "child.txt"), "child");
  fs.writeFileSync(path.join(tree, "nested", "deep", "leaf.txt"), "leaf");
  if (process.platform !== "win32") {
    fs.symlinkSync("../root.txt", path.join(tree, "nested", "root-link"));
  }
  return tree;
}

function treeSnapshot(tree: string) {
  return fs.readdirSync(tree, { recursive: true })
    .map(value => String(value).replaceAll("\\", "/"))
    .sort();
}

describe("native recursive copy", () => {
  test("the default recursive path crosses the native boundary once", () => {
    const source = createTree("native-copy-source");
    const destination = path.join(root, "native-copy-destination");
    const host = (globalThis as any).cottontail;
    expect(typeof host.copyTreeSync).toBe("function");
    const nativeCopy = host.copyTreeSync;
    let calls = 0;
    host.copyTreeSync = (...args: unknown[]) => {
      calls += 1;
      return nativeCopy(...args);
    };
    try {
      fs.cpSync(source, destination, { recursive: true });
    } finally {
      host.copyTreeSync = nativeCopy;
    }

    expect(calls).toBe(1);
    expect(treeSnapshot(destination)).toEqual(treeSnapshot(source));
    expect(fs.readFileSync(path.join(destination, "nested", "deep", "leaf.txt"), "utf8")).toBe("leaf");
    if (process.platform !== "win32") {
      expect(fs.readlinkSync(path.join(destination, "nested", "root-link")))
        .toBe(path.resolve(source, "root.txt"));
    }
  });

  test("overwrite, errorOnExist, modes, and self-copy checks retain Node semantics", () => {
    const source = createTree("copy-options-source");
    const destination = path.join(root, "copy-options-destination");
    fs.cpSync(source, destination, { recursive: true });
    fs.writeFileSync(path.join(source, "root.txt"), "updated");

    fs.cpSync(source, destination, { recursive: true, force: false });
    expect(fs.readFileSync(path.join(destination, "root.txt"), "utf8")).toBe("root");
    expect(() => fs.cpSync(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
    })).toThrow(expect.objectContaining({ code: "EEXIST" }));

    fs.cpSync(source, destination, { recursive: true, force: true });
    expect(fs.readFileSync(path.join(destination, "root.txt"), "utf8")).toBe("updated");
    expect(() => fs.cpSync(source, path.join(source, "child"), { recursive: true }))
      .toThrow(expect.objectContaining({ code: "EINVAL" }));

    if (process.platform !== "win32") {
      const executable = path.join(source, "executable");
      fs.writeFileSync(executable, "#!/bin/sh\n");
      fs.chmodSync(executable, 0o751);
      const copied = path.join(root, "copied-executable");
      fs.copyFileSync(executable, copied);
      expect(fs.statSync(copied).mode & 0o777).toBe(0o751);
    }
  });

  test("existing hard links to source files remain untouched", () => {
    if (process.platform === "win32") return;
    const source = createTree("copy-hard-link-source");
    const destination = path.join(root, "copy-hard-link-destination");
    fs.mkdirSync(destination);
    const sourceFile = path.join(source, "root.txt");
    const destinationFile = path.join(destination, "root.txt");
    fs.linkSync(sourceFile, destinationFile);
    const before = fs.statSync(destinationFile);

    fs.cpSync(source, destination, { recursive: true });

    const after = fs.statSync(destinationFile);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(fs.readFileSync(destinationFile, "utf8")).toBe("root");
  });

  test("sync filters remain JS-orchestrated and are never bypassed", () => {
    const source = createTree("sync-filter-source");
    const destination = path.join(root, "sync-filter-destination");
    const host = (globalThis as any).cottontail;
    const nativeCopy = host.copyTreeSync;
    let nativeTreeCalls = 0;
    host.copyTreeSync = (...args: unknown[]) => {
      nativeTreeCalls += 1;
      return nativeCopy(...args);
    };
    const visited: string[] = [];
    try {
      fs.cpSync(source, destination, {
        recursive: true,
        filter(sourcePath) {
          visited.push(path.basename(sourcePath));
          return !sourcePath.endsWith("child.txt");
        },
      });
    } finally {
      host.copyTreeSync = nativeCopy;
    }

    expect(nativeTreeCalls).toBe(0);
    expect(visited).toContain("child.txt");
    expect(fs.existsSync(path.join(destination, "nested", "child.txt"))).toBe(false);
    expect(fs.existsSync(path.join(destination, "nested", "deep", "leaf.txt"))).toBe(true);
  });

  test("dereference and timestamp preservation stay on the JS path", async () => {
    const source = createTree("special-options-source");
    const dereferencedDestination = path.join(root, "dereferenced-destination");
    const timestampDestination = path.join(root, "timestamp-destination");
    const asyncDereferencedDestination = path.join(root, "async-dereferenced-destination");
    const asyncTimestampDestination = path.join(root, "async-timestamp-destination");
    const sourceFile = path.join(source, "root.txt");
    const fixed = new Date("2020-01-02T03:04:05.000Z");
    fs.utimesSync(sourceFile, fixed, fixed);
    const host = (globalThis as any).cottontail;
    const nativeCopy = host.copyTreeSync;
    const nativeAsyncCopy = host.fsCopyTreeStart;
    let nativeTreeCalls = 0;
    host.copyTreeSync = (...args: unknown[]) => {
      nativeTreeCalls += 1;
      return nativeCopy(...args);
    };
    host.fsCopyTreeStart = (...args: unknown[]) => {
      nativeTreeCalls += 1;
      return nativeAsyncCopy(...args);
    };
    try {
      fs.cpSync(source, dereferencedDestination, { dereference: true, recursive: true });
      fs.cpSync(source, timestampDestination, { preserveTimestamps: true, recursive: true });
      await fsp.cp(source, asyncDereferencedDestination, { dereference: true, recursive: true });
      await fsp.cp(source, asyncTimestampDestination, { preserveTimestamps: true, recursive: true });
    } finally {
      host.copyTreeSync = nativeCopy;
      host.fsCopyTreeStart = nativeAsyncCopy;
    }

    expect(nativeTreeCalls).toBe(0);
    if (process.platform !== "win32") {
      expect(fs.lstatSync(path.join(dereferencedDestination, "nested", "root-link")).isSymbolicLink())
        .toBe(false);
      expect(fs.lstatSync(path.join(asyncDereferencedDestination, "nested", "root-link")).isSymbolicLink())
        .toBe(false);
    }
    expect(fs.statSync(path.join(timestampDestination, "root.txt")).mtimeMs).toBe(fixed.getTime());
    expect(fs.statSync(path.join(asyncTimestampDestination, "root.txt")).mtimeMs).toBe(fixed.getTime());
  });

  test("fallback copies compare exact large directory identities", async () => {
    const source = createTree("large-directory-identity-source");
    const nested = path.join(source, "nested");
    const syncDestination = path.join(root, "large-directory-identity-sync");
    const asyncDestination = path.join(root, "large-directory-identity-async");
    const host = (globalThis as any).cottontail;
    const nativeStat = host.statSync;
    const sourceIdentity = 9007199254740992n;
    const nestedIdentity = 9007199254740993n;

    expect(Number(sourceIdentity)).toBe(Number(nestedIdentity));
    host.statSync = (entry: string, follow: boolean) => {
      const result = nativeStat(entry, follow);
      const resolved = path.resolve(entry);
      const exactIdentity = resolved === path.resolve(source)
        ? sourceIdentity
        : resolved === path.resolve(nested)
          ? nestedIdentity
          : null;
      return exactIdentity === null
        ? result
        : {
            ...result,
            ino: Number(exactIdentity),
            inoBigInt: exactIdentity.toString(),
          };
    };

    try {
      fs.cpSync(source, syncDestination, {
        preserveTimestamps: true,
        recursive: true,
      });
      await fsp.cp(source, asyncDestination, {
        preserveTimestamps: true,
        recursive: true,
      });
    } finally {
      host.statSync = nativeStat;
    }

    expect(treeSnapshot(syncDestination)).toEqual(treeSnapshot(source));
    expect(treeSnapshot(asyncDestination)).toEqual(treeSnapshot(source));
  });

  test("default and verbatim symlink targets retain Node semantics", async () => {
    if (process.platform === "win32") return;
    const source = createTree("verbatim-source");
    const defaultDestination = path.join(root, "verbatim-default-destination");
    const verbatimDestination = path.join(root, "verbatim-true-destination");
    const asyncDefaultDestination = path.join(root, "async-verbatim-default-destination");
    const asyncVerbatimDestination = path.join(root, "async-verbatim-true-destination");
    const host = (globalThis as any).cottontail;
    const nativeCopy = host.copyTreeSync;
    const nativeAsyncCopy = host.fsCopyTreeStart;
    let nativeSyncTreeCalls = 0;
    let nativeAsyncTreeCalls = 0;
    host.copyTreeSync = (...args: unknown[]) => {
      nativeSyncTreeCalls += 1;
      return nativeCopy(...args);
    };
    host.fsCopyTreeStart = (...args: unknown[]) => {
      nativeAsyncTreeCalls += 1;
      return nativeAsyncCopy(...args);
    };
    try {
      fs.cpSync(source, defaultDestination, { recursive: true });
      fs.cpSync(source, verbatimDestination, {
        recursive: true,
        verbatimSymlinks: true,
      });
      await fsp.cp(source, asyncDefaultDestination, { recursive: true });
      await fsp.cp(source, asyncVerbatimDestination, {
        recursive: true,
        verbatimSymlinks: true,
      });
    } finally {
      host.copyTreeSync = nativeCopy;
      host.fsCopyTreeStart = nativeAsyncCopy;
    }

    expect(nativeSyncTreeCalls).toBe(1);
    expect(nativeAsyncTreeCalls).toBe(1);
    expect(fs.readlinkSync(path.join(defaultDestination, "nested", "root-link")))
      .toBe(path.resolve(source, "root.txt"));
    expect(fs.readlinkSync(path.join(verbatimDestination, "nested", "root-link")))
      .toBe("../root.txt");
    expect(fs.readlinkSync(path.join(asyncDefaultDestination, "nested", "root-link")))
      .toBe(path.resolve(source, "root.txt"));
    expect(fs.readlinkSync(path.join(asyncVerbatimDestination, "nested", "root-link")))
      .toBe("../root.txt");
  });

  test("native traversal copies dangling symlinks without dereferencing them", async () => {
    if (process.platform === "win32") return;
    const source = path.join(root, "dangling-source");
    const syncDestination = path.join(root, "dangling-sync-destination");
    const asyncDestination = path.join(root, "dangling-async-destination");
    fs.mkdirSync(source);
    fs.symlinkSync("missing-target", path.join(source, "link"));

    fs.cpSync(source, syncDestination, { recursive: true });
    await fsp.cp(source, asyncDestination, { recursive: true });

    expect(fs.readlinkSync(path.join(syncDestination, "link")))
      .toBe(path.resolve(source, "missing-target"));
    expect(fs.readlinkSync(path.join(asyncDestination, "link")))
      .toBe(path.resolve(source, "missing-target"));
  });

  test("native traversal rejects copying a symlink over a regular file", async () => {
    if (process.platform === "win32") return;
    const source = path.join(root, "symlink-over-file-source");
    const syncDestination = path.join(root, "symlink-over-file-sync");
    const asyncDestination = path.join(root, "symlink-over-file-async");
    fs.mkdirSync(source);
    fs.symlinkSync(root, path.join(source, "entry"));
    fs.mkdirSync(syncDestination);
    fs.mkdirSync(asyncDestination);
    fs.writeFileSync(path.join(syncDestination, "entry"), "existing");
    fs.writeFileSync(path.join(asyncDestination, "entry"), "existing");

    expect(() => fs.cpSync(source, syncDestination, { recursive: true }))
      .toThrow(expect.objectContaining({ code: "EEXIST" }));
    let rejection: any;
    try {
      await fsp.cp(source, asyncDestination, { recursive: true });
    } catch (error) {
      rejection = error;
    }
    expect(rejection?.code).toBe("EEXIST");
    expect(fs.readFileSync(path.join(syncDestination, "entry"), "utf8")).toBe("existing");
    expect(fs.readFileSync(path.join(asyncDestination, "entry"), "utf8")).toBe("existing");
  });

  test("native traversal rejects recursive destination-link relationships", () => {
    if (process.platform === "win32") return;
    const source = path.join(root, "symlink-relationship-source");
    const destination = path.join(root, "symlink-relationship-destination");
    fs.mkdirSync(path.join(source, "a", "b"), { recursive: true });
    fs.symlinkSync(path.join(source, "a", "b"), path.join(source, "a", "link"));
    fs.mkdirSync(path.join(destination, "a"), { recursive: true });
    fs.symlinkSync(source, path.join(destination, "a", "link"));
    expect(() => fs.cpSync(source, destination, { recursive: true }))
      .toThrow(expect.objectContaining({ code: "ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY" }));

    const equalSource = path.join(root, "equal-link-source");
    const equalDestination = path.join(root, "equal-link-destination");
    fs.mkdirSync(equalSource);
    fs.mkdirSync(equalDestination);
    fs.symlinkSync(equalDestination, path.join(equalSource, "link"));
    fs.cpSync(equalSource, equalDestination, { recursive: true });
    expect(() => fs.cpSync(equalSource, equalDestination, { recursive: true }))
      .toThrow(expect.objectContaining({ code: "ERR_FS_CP_EINVAL" }));
  });

  test("clone modes stay on per-file native operations", async () => {
    const source = createTree("copy-mode-source");
    const syncDestination = path.join(root, "copy-mode-sync-destination");
    const asyncDestination = path.join(root, "copy-mode-async-destination");
    const host = (globalThis as any).cottontail;
    const copyTreeSync = host.copyTreeSync;
    const cloneFileSync = host.cloneFileSync;
    const fsCopyTreeStart = host.fsCopyTreeStart;
    const fsAsyncCopyFileStart = host.fsAsyncCopyFileStart;
    let nativeTreeCalls = 0;
    let cloneCalls = 0;
    const asyncModes: number[] = [];
    host.copyTreeSync = (...args: unknown[]) => {
      nativeTreeCalls += 1;
      return copyTreeSync(...args);
    };
    host.cloneFileSync = (...args: unknown[]) => {
      cloneCalls += 1;
      return cloneFileSync(...args);
    };
    host.fsCopyTreeStart = (...args: unknown[]) => {
      nativeTreeCalls += 1;
      return fsCopyTreeStart(...args);
    };
    host.fsAsyncCopyFileStart = (...args: unknown[]) => {
      asyncModes.push(Number(args[2]));
      return fsAsyncCopyFileStart(...args);
    };
    try {
      fs.cpSync(source, syncDestination, {
        mode: fs.constants.COPYFILE_FICLONE,
        recursive: true,
      });
      await fsp.cp(source, asyncDestination, {
        mode: fs.constants.COPYFILE_FICLONE,
        recursive: true,
      });
    } finally {
      host.copyTreeSync = copyTreeSync;
      host.cloneFileSync = cloneFileSync;
      host.fsCopyTreeStart = fsCopyTreeStart;
      host.fsAsyncCopyFileStart = fsAsyncCopyFileStart;
    }

    expect(nativeTreeCalls).toBe(0);
    expect(cloneCalls).toBeGreaterThan(0);
    expect(asyncModes.length).toBeGreaterThan(0);
    expect(asyncModes.every(mode => mode === fs.constants.COPYFILE_FICLONE)).toBe(true);
    expect(treeSnapshot(syncDestination)).toEqual(treeSnapshot(source));
    expect(treeSnapshot(asyncDestination)).toEqual(treeSnapshot(source));
    expect(() => fs.cpSync(source, path.join(root, "invalid-mode"), {
      mode: 8,
      recursive: true,
    })).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
  });

  test("promise filters are awaited while accepted files use native copy", async () => {
    const source = createTree("async-filter-source");
    const destination = path.join(root, "async-filter-destination");
    const host = (globalThis as any).cottontail;
    const nativeAsyncCopy = host.fsCopyTreeStart;
    let nativeTreeCalls = 0;
    let pendingFilters = 0;
    host.fsCopyTreeStart = (...args: unknown[]) => {
      nativeTreeCalls += 1;
      return nativeAsyncCopy(...args);
    };
    try {
      await fsp.cp(source, destination, {
        recursive: true,
        async filter(sourcePath) {
          pendingFilters += 1;
          await new Promise(resolve => setTimeout(resolve, 1));
          return !sourcePath.endsWith("leaf.txt");
        },
      });
    } finally {
      host.fsCopyTreeStart = nativeAsyncCopy;
    }
    expect(nativeTreeCalls).toBe(0);
    expect(pendingFilters).toBeGreaterThan(3);
    expect(fs.existsSync(path.join(destination, "nested", "child.txt"))).toBe(true);
    expect(fs.existsSync(path.join(destination, "nested", "deep", "leaf.txt"))).toBe(false);
  });
});

describe("native asynchronous bulk filesystem work", () => {
  test("promise and callback copyFile use native asynchronous requests", async () => {
    const source = path.join(root, "async-copy-file-source");
    const promiseDestination = path.join(root, "async-copy-file-promise");
    const callbackDestination = path.join(root, "async-copy-file-callback");
    fs.writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 0x5a));
    const host = (globalThis as any).cottontail;
    expect(typeof host.fsAsyncCopyFileStart).toBe("function");
    const nativeStart = host.fsAsyncCopyFileStart;
    let starts = 0;
    host.fsAsyncCopyFileStart = (...args: unknown[]) => {
      starts += 1;
      return nativeStart(...args);
    };
    try {
      await fsp.copyFile(source, promiseDestination);
      await new Promise<void>((resolve, reject) => {
        fs.copyFile(source, callbackDestination, error => {
          if (error) reject(error);
          else {
            expect(error).toBeNull();
            resolve();
          }
        });
      });
    } finally {
      host.fsAsyncCopyFileStart = nativeStart;
    }
    expect(starts).toBe(2);
    expect(fs.statSync(promiseDestination).size).toBe(2 * 1024 * 1024);
    expect(fs.statSync(callbackDestination).size).toBe(2 * 1024 * 1024);
  });

  test("promise and callback cp use a native asynchronous request", async () => {
    const source = createTree("async-copy-source");
    const promiseDestination = path.join(root, "async-copy-promise");
    const callbackDestination = path.join(root, "async-copy-callback");
    const host = (globalThis as any).cottontail;
    expect(typeof host.fsCopyTreeStart).toBe("function");
    const nativeStart = host.fsCopyTreeStart;
    let starts = 0;
    host.fsCopyTreeStart = (...args: unknown[]) => {
      starts += 1;
      return nativeStart(...args);
    };
    try {
      await fsp.cp(source, promiseDestination, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        fs.cp(source, callbackDestination, { recursive: true }, error => {
          if (error) reject(error);
          else {
            expect(error).toBeNull();
            resolve();
          }
        });
      });
    } finally {
      host.fsCopyTreeStart = nativeStart;
    }
    expect(starts).toBe(2);
    expect(treeSnapshot(promiseDestination)).toEqual(treeSnapshot(source));
    expect(treeSnapshot(callbackDestination)).toEqual(treeSnapshot(source));
  });

  test("promise and callback rm use native asynchronous requests", async () => {
    const promiseTarget = createTree("async-rm-promise");
    const callbackTarget = createTree("async-rm-callback");
    const host = (globalThis as any).cottontail;
    expect(typeof host.fsRmStart).toBe("function");
    const nativeStart = host.fsRmStart;
    let starts = 0;
    host.fsRmStart = (...args: unknown[]) => {
      starts += 1;
      return nativeStart(...args);
    };
    try {
      await fsp.rm(promiseTarget, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        fs.rm(callbackTarget, { recursive: true }, error => {
          if (error) reject(error);
          else {
            expect(error).toBeNull();
            resolve();
          }
        });
      });
    } finally {
      host.fsRmStart = nativeStart;
    }
    expect(starts).toBe(2);
    expect(fs.existsSync(promiseTarget)).toBe(false);
    expect(fs.existsSync(callbackTarget)).toBe(false);
  });

  test("native async copy errors retain Node path metadata", async () => {
    const source = createTree("async-copy-error-source");
    const destination = path.join(root, "async-copy-error-destination");
    let rejection: any;
    try {
      await fsp.cp(source, destination);
    } catch (error) {
      rejection = error;
    }
    expect(rejection?.code).toBe("EISDIR");
    expect(rejection?.path).toBe(source);
    expect(rejection?.syscall).toBe("cp");
  });
});

describe("recursive remove validation and symlinks", () => {
  test("rm validates options consistently across sync, promise, and callback APIs", async () => {
    const target = path.join(root, "rm-validation");
    fs.mkdirSync(target);
    for (const options of [
      null,
      "options",
      { recursive: 1 },
      { force: 1 },
      { maxRetries: -1 },
      { retryDelay: -1 },
    ]) {
      expect(() => fs.rmSync(target, options as any)).toThrow();
      expect(() => fs.rm(target, options as any, () => {})).toThrow();
      let rejection;
      try {
        await fsp.rm(target, options as any);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeDefined();
    }
    expect(fs.existsSync(target)).toBe(true);
  });

  test("recursive removal unlinks a directory symlink without following it", () => {
    if (process.platform === "win32") return;
    const outside = createTree("rm-link-outside");
    const container = path.join(root, "rm-link-container");
    fs.mkdirSync(container);
    fs.symlinkSync(outside, path.join(container, "linked-directory"));
    fs.rmSync(container, { recursive: true });
    expect(fs.existsSync(container)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "root.txt"), "utf8")).toBe("root");
  });

  test("force controls missing recursive targets across all APIs", async () => {
    const missing = path.join(root, "already-missing");
    expect(fs.rmSync(missing, { force: true })).toBeUndefined();
    expect(() => fs.rmSync(missing, { recursive: true })).toThrow(expect.objectContaining({
      code: "ENOENT",
    }));
    let promiseError: any;
    try {
      await fsp.rm(missing, { recursive: true });
    } catch (error) {
      promiseError = error;
    }
    expect(promiseError?.code).toBe("ENOENT");
    const callbackError = await new Promise<any>(resolve => {
      fs.rm(missing, { recursive: true }, resolve);
    });
    expect(callbackError?.code).toBe("ENOENT");
    await fsp.rm(missing, { recursive: true, force: true });
    expect(() => fs.rmSync(root, { force: true })).toThrow(expect.objectContaining({
      code: expect.any(String),
    }));
  });
});
