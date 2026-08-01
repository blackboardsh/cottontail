import { afterAll, expect, test } from "bun:test";
import fs, * as fsNamespace from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const windowsTest = test.skipIf(process.platform !== "win32");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-fs-win-permissions-"));
const wideName = `permissions-${String.fromCodePoint(0x1f600, 0x6587, 0x4ef6)}.txt`;

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function callbackOutcome(register: (callback: (error?: NodeJS.ErrnoException | null) => void) => void) {
  let synchronous = true;
  return new Promise<{ error?: NodeJS.ErrnoException | null; synchronous: boolean }>((resolve, reject) => {
    try {
      register(error => resolve({ error, synchronous }));
    } catch (error) {
      reject(error);
    } finally {
      synchronous = false;
    }
  });
}

function makeLongDirectory() {
  return Array.from(
    { length: 7 },
    (_, index) => `${String.fromCodePoint(0x5c42, 0x7ea7)}-${index}-${"x".repeat(34)}`,
  ).reduce((directory, segment) => path.join(directory, segment), root);
}

windowsTest("lchmod has Node's enumerable undefined fs shape and rejecting promises API", async () => {
  for (const surface of [fs, fsNamespace]) {
    expect(Object.keys(surface)).toContain("lchmod");
    expect(Object.keys(surface)).toContain("lchmodSync");
    expect(surface.lchmod).toBeUndefined();
    expect(surface.lchmodSync).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(surface, "lchmod")?.enumerable).toBe(true);
    expect(Object.getOwnPropertyDescriptor(surface, "lchmodSync")?.enumerable).toBe(true);
  }

  expect(typeof fsp.lchmod).toBe("function");
  for (const arguments_ of [[path.join(root, wideName), 0o600], [false, {}]]) {
    const rejection = fsp.lchmod(...(arguments_ as [any, any]));
    await expect(rejection).rejects.toMatchObject({
      code: "ERR_METHOD_NOT_IMPLEMENTED",
      message: "The lchmod() method is not implemented",
    });
  }
});

windowsTest("chmod uses the Windows read-only bit and validates wide long paths", async () => {
  const directory = makeLongDirectory();
  const target = path.join(directory, wideName);
  const missing = path.join(directory, `missing-${wideName}`);
  expect(target.length).toBeGreaterThan(260);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(target, "content");

  try {
    fs.chmodSync(target, 0o400);
    expect(fs.statSync(target).mode & 0o200).toBe(0);

    const callback = await callbackOutcome(done => fs.chmod(target, "600" as any, done));
    expect(callback.synchronous).toBe(false);
    expect(callback.error).toBeNull();
    expect(fs.statSync(target).mode & 0o200).not.toBe(0);

    await fsp.chmod(target, 0o400);
    expect(fs.statSync(target).mode & 0o200).toBe(0);
    await fsp.chmod(target, 0o600);

    expect(() => fs.chmodSync(missing, 0o600)).toThrow(expect.objectContaining({
      code: "ENOENT",
      path: missing,
      syscall: "chmod",
    }));
    const missingCallback = await callbackOutcome(done => fs.chmod(missing, 0o600, done));
    expect(missingCallback.error).toMatchObject({
      code: "ENOENT",
      path: missing,
      syscall: "chmod",
    });
    await expect(fsp.chmod(missing, 0o600)).rejects.toMatchObject({
      code: "ENOENT",
      path: missing,
      syscall: "chmod",
    });
  } finally {
    try {
      fs.chmodSync(target, 0o600);
    } catch {}
  }
});

windowsTest("fchmod updates wide-path files and preserves EBADF validation", async () => {
  const directory = makeLongDirectory();
  const target = path.join(directory, `fd-${wideName}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(target, "content");

  const fd = fs.openSync(target, "r+");
  try {
    fs.fchmodSync(fd, 0o400);
    expect(fs.fstatSync(fd).mode & 0o200).toBe(0);
    const callback = await callbackOutcome(done => fs.fchmod(fd, "600" as any, done));
    expect(callback.synchronous).toBe(false);
    expect(callback.error).toBeNull();
    expect(fs.fstatSync(fd).mode & 0o200).not.toBe(0);
  } finally {
    fs.closeSync(fd);
  }

  expect(() => fs.fchmodSync(fd, 0o600)).toThrow(expect.objectContaining({
    code: "EBADF",
    syscall: "fchmod",
  }));
  const closedCallback = await callbackOutcome(done => fs.fchmod(fd, 0o600, done));
  expect(closedCallback.error).toMatchObject({ code: "EBADF", syscall: "fchmod" });

  const handle = await fsp.open(target, "r+");
  await handle.chmod(0o400);
  expect((await handle.stat()).mode & 0o200).toBe(0);
  await handle.chmod(0o600);
  await handle.close();
  await expect(handle.chmod(0o600)).rejects.toMatchObject({ code: "EBADF", syscall: "fchmod" });
});

windowsTest("recursive copies restore Windows permissions without using Zig's unsupported path", () => {
  const source = path.join(root, "copy-permissions-source");
  const sourceFile = path.join(source, "nested", wideName);
  const destinations = [
    path.join(root, "copy-permissions-native"),
    path.join(root, "copy-permissions-timestamps"),
  ];
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, "content");
  fs.chmodSync(sourceFile, 0o400);

  try {
    fs.cpSync(source, destinations[0], { recursive: true });
    fs.cpSync(source, destinations[1], { recursive: true, preserveTimestamps: true });
    for (const destination of destinations) {
      const copied = path.join(destination, "nested", wideName);
      expect(fs.readFileSync(copied, "utf8")).toBe("content");
      expect(fs.statSync(copied).mode & 0o200).toBe(0);
    }
  } finally {
    fs.chmodSync(sourceFile, 0o600);
    for (const destination of destinations) {
      try { fs.chmodSync(path.join(destination, "nested", wideName), 0o600); } catch {}
    }
  }
});

windowsTest("chown APIs are validated no-ops while closed FileHandles still reject", async () => {
  const missing = path.join(root, `missing-owner-${wideName}`);
  expect(() => fs.chownSync(missing, false as any, 456)).toThrow(expect.objectContaining({
    code: "ERR_INVALID_ARG_TYPE",
  }));
  expect(() => fs.lchownSync(missing, 123, false as any)).toThrow(expect.objectContaining({
    code: "ERR_INVALID_ARG_TYPE",
  }));
  expect(() => fs.fchown(1, "bad" as any)).toThrow(expect.objectContaining({
    code: "ERR_INVALID_ARG_TYPE",
  }));
  expect(() => fs.fchmod(1, "123x" as any)).toThrow(expect.objectContaining({
    code: "ERR_INVALID_ARG_VALUE",
  }));
  expect(() => fs.fchmodSync(-1, 0o600)).toThrow(
    'The value of "fd" is out of range. It must be >= 0 && <= 2147483647. Received -1',
  );
  expect(() => fs.fchownSync(Number.POSITIVE_INFINITY, 1, 1)).toThrow(
    'The value of "fd" is out of range. It must be an integer. Received Infinity',
  );
  expect(fs.chownSync(missing, 123, 456)).toBeUndefined();
  expect(fs.lchownSync(missing, 123, 456)).toBeUndefined();
  expect(fs.chownSync(missing, -1, -1)).toBeUndefined();
  expect(fs.lchownSync(missing, -1, -1)).toBeUndefined();
  await expect(fsp.chown(missing, 123, 456)).resolves.toBeUndefined();
  await expect(fsp.lchown(missing, 123, 456)).resolves.toBeUndefined();

  for (const operation of [
    (done: (error?: NodeJS.ErrnoException | null) => void) => fs.chown(missing, 123, 456, done),
    (done: (error?: NodeJS.ErrnoException | null) => void) => fs.lchown(missing, 123, 456, done),
    (done: (error?: NodeJS.ErrnoException | null) => void) => fs.fchown(0x7fffffff, 123, 456, done),
  ]) {
    const result = await callbackOutcome(operation);
    expect(result.synchronous).toBe(false);
    expect(result.error).toBeNull();
  }
  expect(fs.fchownSync(0x7fffffff, 123, 456)).toBeUndefined();
  expect(fs.fchownSync(0x7fffffff, -1, -1)).toBeUndefined();

  const target = path.join(root, `owner-${wideName}`);
  fs.writeFileSync(target, "content");
  const handle = await fsp.open(target, "r+");
  await expect(handle.chown(123, 456)).resolves.toBeUndefined();
  await handle.close();
  await expect(handle.chown(123, 456)).rejects.toMatchObject({ code: "EBADF", syscall: "fchown" });
});
