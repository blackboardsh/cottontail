import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function withLegacyWalk<T>(operation: () => T): T {
  const host = (globalThis as any).cottontail;
  const nativeWalk = host.walkDirSync;
  host.walkDirSync = undefined;
  try {
    return operation();
  } finally {
    host.walkDirSync = nativeWalk;
  }
}

function globOutcome(root: string) {
  try {
    return { result: fs.globSync("**/*.txt", { cwd: root }) };
  } catch (error: any) {
    return {
      error: {
        code: error?.code,
        path: error?.path,
        syscall: error?.syscall,
      },
    };
  }
}

describe("native recursive filesystem walk", () => {
  let root = "";
  const txtPaths = [
    path.join("nested", "deeper", "unicode-\u2603.txt"),
    "root.txt",
  ];

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-native-walk-"));
    fs.mkdirSync(path.join(root, "nested", "deeper"), { recursive: true });
    fs.mkdirSync(path.join(root, "empty"));
    fs.writeFileSync(path.join(root, "root.txt"), "root");
    fs.writeFileSync(path.join(root, "nested", "alpha.js"), "alpha");
    fs.writeFileSync(path.join(root, "nested", "deeper", "unicode-\u2603.txt"), "snow");
    fs.writeFileSync(path.join(root, ".hidden.txt"), "hidden");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("globSync walks a deep tree and keeps Node path semantics", () => {
    const host = (globalThis as any).cottontail;
    expect(typeof host.walkDirSync).toBe("function");
    const nativeWalk = host.walkDirSync;
    let nativeCalls = 0;
    host.walkDirSync = (walkRoot: string, prefix: string) => {
      nativeCalls += 1;
      return nativeWalk(walkRoot, prefix);
    };
    try {
      expect(fs.globSync("**/*.txt", { cwd: root })).toEqual(txtPaths);
    } finally {
      host.walkDirSync = nativeWalk;
    }
    expect(nativeCalls).toBe(1);
    expect(fs.globSync(".hidden.txt", { cwd: root })).toEqual([".hidden.txt"]);
    expect(fs.globSync(path.join(root, "nested", "**", "*.txt"))).toEqual([
      path.join(root, "nested", "deeper", "unicode-\u2603.txt"),
    ]);

    const entries = fs.globSync("nested/**/*.txt", {
      cwd: root,
      withFileTypes: true,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBeInstanceOf(fs.Dirent);
    expect(entries[0].name).toBe("unicode-\u2603.txt");
    expect(entries[0].isFile()).toBe(true);
    expect(entries[0].parentPath).toBe(path.join(root, "nested", "deeper"));

    expect(fs.globSync("**/*", { cwd: root })).toEqual(
      withLegacyWalk(() => fs.globSync("**/*", { cwd: root })),
    );
    const normalizeDirents = (values: fs.Dirent[]) => values.map((entry) => ({
      directory: entry.isDirectory(),
      file: entry.isFile(),
      link: entry.isSymbolicLink(),
      name: String(entry.name),
      parentPath: entry.parentPath,
    }));
    expect(normalizeDirents(fs.globSync("**/*", { cwd: root, withFileTypes: true }))).toEqual(
      normalizeDirents(withLegacyWalk(() => fs.globSync("**/*", { cwd: root, withFileTypes: true }))),
    );
  });

  test("a directory symlink cycle terminates without duplicate files", () => {
    const loop = path.join(root, "nested", "deeper", "loop");
    try {
      fs.symlinkSync(root, loop, process.platform === "win32" ? "junction" : "dir");
    } catch (error: any) {
      if (process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EACCES")) return;
      throw error;
    }

    expect(fs.globSync("**/*.txt", { cwd: root })).toEqual(txtPaths);
    expect(fs.globSync("**/*", { cwd: root })).toEqual(
      withLegacyWalk(() => fs.globSync("**/*", { cwd: root })),
    );
  });

  test("missing static roots retain an empty glob result", () => {
    expect(fs.globSync("missing/**/*.txt", { cwd: root })).toEqual([]);
  });

  test("permission and descendant error details match the legacy walker", () => {
    if (process.platform === "win32") return;
    const restricted = path.join(root, "restricted");
    fs.mkdirSync(restricted);
    fs.writeFileSync(path.join(restricted, "blocked.txt"), "blocked");
    fs.chmodSync(restricted, 0o000);
    try {
      const legacy = withLegacyWalk(() => globOutcome(root));
      expect(globOutcome(root)).toEqual(legacy);
    } finally {
      fs.chmodSync(restricted, 0o755);
    }
  });
});
