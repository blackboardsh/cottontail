import { afterAll, describe, expect, test } from "bun:test";
import { memfd_create, setSyntheticAllocationLimitForTesting } from "bun:internal-for-testing";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-fs-focused-"));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function rejectionOf(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected promise to reject");
    },
    error => error,
  );
}

test("string writes stop hex decoding at the first invalid pair", async () => {
  const target = path.join(root, "hex.bin");
  fs.writeFileSync(target, "ascii", "hex");
  expect([...fs.readFileSync(target)]).toEqual([]);

  await fsp.writeFile(target, "0a0cg1", "hex");
  expect([...fs.readFileSync(target)]).toEqual([0x0a, 0x0c]);
});

test("unlinking a directory reports the platform errno", () => {
  const target = path.join(root, "unlink-directory");
  fs.mkdirSync(target);
  expect(() => fs.unlinkSync(target)).toThrow(expect.objectContaining({
    code: process.platform === "linux" ? "EISDIR" : "EPERM",
    syscall: "unlink",
    path: target,
  }));
  fs.rmdirSync(target);
});

test("readlink reports EINVAL for regular files", async () => {
  const target = path.join(root, "readlink-regular-file.txt");
  fs.writeFileSync(target, "not a symbolic link");
  const expected = { code: "EINVAL", syscall: "readlink", path: target };

  expect(() => fs.readlinkSync(target)).toThrow(expect.objectContaining(expected));
  expect(fsp.readlink(target)).rejects.toMatchObject(expected);
});

test("concurrent recursive readdir calls return independent snapshots", async () => {
  const target = path.join(root, "recursive");
  fs.mkdirSync(path.join(target, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(target, "a", "one.txt"), "1");
  fs.writeFileSync(path.join(target, "a", "b", "two.txt"), "2");

  const results = await Promise.all(
    Array.from({ length: 200 }, () => fsp.readdir(target, { recursive: true, withFileTypes: true })),
  );
  expect(results[0].length).toBeGreaterThan(0);
  expect(results[1]).not.toBe(results[0]);
  expect(results[1][0]).not.toBe(results[0][0]);
  expect(results.map(entries => entries.map(entry => path.join(entry.parentPath, entry.name)).sort()))
    .toEqual(Array.from({ length: 200 }, () => results[0].map(entry => path.join(entry.parentPath, entry.name)).sort()));
});

describe("FileHandle stable-path behavior", () => {
  test("read, readv, readFile, and closed-descriptor errors", async () => {
    const target = path.join(root, "handle.txt");
    fs.writeFileSync(target, "abcdefghij");

    const handle = await fsp.open(target, "r");
    const first = Buffer.alloc(3);
    expect(await handle.read(first, 0, 3, 0)).toEqual({ bytesRead: 3, buffer: first });
    const buffers = [Buffer.alloc(2), Buffer.alloc(2)];
    expect(await handle.readv(buffers, 0)).toEqual({ bytesRead: 4, buffers });
    await handle.close();
    expect(handle.read(Buffer.alloc(1))).rejects.toMatchObject({ code: "EBADF" });

    const readFileHandle = await fsp.open(target, "r");
    expect(await readFileHandle.readFile()).toEqual(Buffer.from("abcdefghij"));
    await readFileHandle.close();

    const webStreamHandle = await fsp.open(target, "r");
    const reader = webStreamHandle.readableWebStream().getReader();
    expect((await reader.read()).value).toBeInstanceOf(Uint8Array);
    reader.releaseLock();
    await webStreamHandle.close();

    const nodeStreamHandle = await fsp.open(target, "r");
    const stream = nodeStreamHandle.createReadStream();
    let text = "";
    for await (const chunk of stream) text += chunk;
    expect(text).toBe("abcdefghij");
    await nodeStreamHandle.close();
  });

  test("FileHandle-backed streams retain ownership and dispatch patched methods", async () => {
    const readTarget = path.join(root, "handle-stream-read.txt");
    fs.writeFileSync(readTarget, "stream-data");
    const readHandle = await fsp.open(readTarget, "r");
    const originalRead = readHandle.read;
    let readCalls = 0;
    readHandle.read = function (...args: Parameters<typeof originalRead>) {
      readCalls += 1;
      return originalRead.apply(this, args);
    };
    let text = "";
    for await (const chunk of fs.createReadStream(null, { fd: readHandle })) text += chunk;
    expect(text).toBe("stream-data");
    expect(readCalls).toBeGreaterThan(0);
    expect(readHandle.fd).toBe(-1);

    const writeTarget = path.join(root, "handle-stream-write.txt");
    const writeHandle = await fsp.open(writeTarget, "w+");
    const originalWrite = writeHandle.write;
    let writeCalls = 0;
    writeHandle.write = function (...args: Parameters<typeof originalWrite>) {
      writeCalls += 1;
      return originalWrite.apply(this, args);
    };
    const stream = fs.createWriteStream(null, { fd: writeHandle });
    const closed = new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.once("close", resolve);
    });
    stream.end("written-through-handle");
    await closed;
    expect(writeCalls).toBeGreaterThan(0);
    expect(writeHandle.fd).toBe(-1);
    expect(fs.readFileSync(writeTarget, "utf8")).toBe("written-through-handle");
  });

  test("closing a referenced FileHandle closes its stream and descriptor once", async () => {
    const target = path.join(root, "handle-stream-close.txt");
    fs.writeFileSync(target, "close-me");
    const handle = await fsp.open(target, "r");
    let handleCloseEvents = 0;
    handle.on("close", () => handleCloseEvents += 1);
    const stream = fs.createReadStream(null, { fd: handle, autoClose: false });
    const streamClosed = new Promise<void>(resolve => stream.once("close", resolve));
    await handle.close();
    await streamClosed;
    await handle.close();
    expect(handle.fd).toBe(-1);
    expect(handleCloseEvents).toBe(1);
  });
});

describe("native fs.watch", () => {
  test("delivers raw encoded filenames and closes idempotently", async () => {
    const target = path.join(root, "watch-encoded-\u65b0\u5efa.txt");
    fs.writeFileSync(target, "before");
    const watcher = fs.watch(target, { encoding: "buffer" });
    expect(watcher.constructor.name).toBe("FSWatcher");

    let revision = 0;
    const event = await new Promise<{ eventType: string; filename: Buffer }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for native file event")), 3000);
      const interval = setInterval(() => fs.writeFileSync(target, `revision-${revision++}`), 25);
      watcher.once("error", reject);
      watcher.on("change", (eventType, filename) => {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve({ eventType, filename: filename as Buffer });
      });
    });
    expect(event.eventType).toBe("change");
    expect(event.filename).toBeInstanceOf(Buffer);
    expect(event.filename.toString()).toBe(path.basename(target));

    const closed = new Promise<void>(resolve => watcher.once("close", resolve));
    watcher.close();
    watcher.close();
    await closed;
  });

  test("recursive directory events preserve the relative child path", async () => {
    const watched = path.join(root, "watch-recursive");
    const child = path.join(watched, "nested");
    const target = path.join(child, "child.txt");
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(target, "before");
    const watcher = fs.watch(watched, { recursive: true });

    let revision = 0;
    const filename = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for recursive native event")), 3000);
      const interval = setInterval(() => fs.writeFileSync(target, `revision-${revision++}`), 25);
      watcher.once("error", reject);
      watcher.on("change", (_eventType, changed) => {
        if (path.basename(String(changed)) !== "child.txt") return;
        clearTimeout(timeout);
        clearInterval(interval);
        resolve(String(changed));
      });
    });
    expect(filename.replaceAll("\\", "/")).toBe("nested/child.txt");
    watcher.close();
  });

  test("pre-aborted watchers report the custom reason and close once", async () => {
    const reason = new Error("stop watching");
    const watcher = fs.watch(path.join(root, "not-opened-after-abort"), {
      signal: AbortSignal.abort(reason),
    });
    let closeEvents = 0;
    watcher.on("close", () => closeEvents += 1);
    const error = await new Promise<Error>(resolve => watcher.once("error", resolve));
    await new Promise(resolve => queueMicrotask(resolve));
    expect(error).toBe(reason);
    expect(closeEvents).toBe(1);
  });
});

test("glob uses Bun grammar and Node fs validation", () => {
  const cwd = path.join(root, "glob-grammar");
  fs.mkdirSync(cwd);
  for (const name of ["a.js", "b.ts", "c.txt", ".hidden.js", "foo1.txt", "fooA.txt", "literal[.txt"]) {
    fs.writeFileSync(path.join(cwd, name), name);
  }

  expect(fs.globSync("[ab].{js,ts}", { cwd })).toEqual(["a.js", "b.ts"]);
  expect(fs.globSync("foo[0-9].txt", { cwd })).toEqual(["foo1.txt"]);
  expect(fs.globSync("foo[^0-9].txt", { cwd })).toEqual(["fooA.txt"]);
  expect(fs.globSync("literal\\[.txt", { cwd })).toEqual(["literal[.txt"]);
  expect(fs.globSync("*", { cwd })).not.toContain(".hidden.js");
  expect(() => fs.globSync(1 as any, { cwd })).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  const dirents = fs.globSync("*", { cwd: new URL(`file://${cwd}/`), withFileTypes: true });
  expect(dirents.map(entry => entry.name)).toContain("a.js");
  expect(dirents.find(entry => entry.name === "a.js")?.parentPath).toBe(cwd);

  fs.mkdirSync(path.join(cwd, "nested"));
  fs.writeFileSync(path.join(cwd, "nested", "deep.txt"), "deep");
  const pruned = fs.globSync("**/*.txt", {
    cwd,
    withFileTypes: true,
    exclude(entry) {
      return entry.isDirectory() && entry.name === "nested";
    },
  });
  expect(pruned.some(entry => entry.name === "deep.txt")).toBe(false);
  expect(fs.globSync(".hidden.js", { cwd })).toEqual([".hidden.js"]);
  expect(fs.globSync(".*", { cwd })).toEqual([]);
  expect(fs.globSync("!*", { cwd })).toEqual([]);
  const negative = fs.globSync("!*.js", { cwd });
  expect(negative).not.toContain("a.js");
  expect(negative).not.toContain(".hidden.js");
  expect(negative.every(value => !value.includes(path.sep))).toBe(true);

  const absolute = fs.globSync(path.join(cwd, "*.{js,ts}"));
  expect(absolute).toEqual([path.join(cwd, "a.js"), path.join(cwd, "b.ts")]);
  expect(fs.globSync("a.js", { cwd, absolute: true } as any)).toEqual(["a.js"]);

  const excluded: string[] = [];
  expect(fs.globSync("*.js", {
    cwd,
    exclude(value) {
      excluded.push(value);
      return false;
    },
  })).toEqual(["a.js"]);
  expect(excluded).toEqual(["a.js"]);
  expect(() => (fs.glob as any)("*.js", { cwd }, undefined)).toThrow(
    expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
  );
});

test("fs flags, modes, and encoding aliases follow Bun validation", () => {
  const target = path.join(root, "validation-options.txt");
  fs.writeFileSync(target, "initial");

  const upperFd = fs.openSync(target, "R" as any);
  fs.closeSync(upperFd);
  const numericFd = fs.openSync(target, -1 as any);
  fs.closeSync(numericFd);
  expect(() => fs.openSync(target, "Rw" as any)).toThrow(expect.objectContaining({
    code: "ERR_INVALID_ARG_TYPE",
  }));
  expect(() => fs.openSync(target, "0o644" as any)).toThrow(expect.objectContaining({
    code: "ERR_INVALID_ARG_TYPE",
  }));

  const modeTarget = path.join(root, "octal-mode.txt");
  const modeFd = fs.openSync(modeTarget, "w", "0600" as any);
  fs.closeSync(modeFd);
  if (process.platform !== "win32") expect(fs.statSync(modeTarget).mode & 0o777).toBe(0o600);
  expect(() => fs.openSync(modeTarget, "r", "08" as any)).toThrow(expect.objectContaining({
    code: "ERR_INVALID_ARG_VALUE",
  }));

  fs.writeFileSync(target, "alias", { encoding: "UTF16-LE" as any });
  expect(fs.readFileSync(target, { encoding: "utf16-le" as any })).toBe("alias");
  expect(fs.readFileSync(target, { encoding: false as any })).toBeInstanceOf(Buffer);
  expect(() => fs.readFileSync(target, { encoding: "utf-16le" as any })).toThrow(
    expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
  );
});

test("fs path and numeric validation is eager and non-coercing", () => {
  const target = path.join(root, "edge-validation.txt");
  fs.writeFileSync(target, "data");

  for (const operation of [
    () => fs.accessSync({} as any),
    () => fs.chmodSync({} as any, 0o600),
    () => fs.readdirSync({} as any),
    () => fs.realpathSync({} as any),
  ]) {
    expect(operation).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  }

  let callbackCalled = false;
  const callback = () => { callbackCalled = true; };
  expect(() => fs.access({} as any, callback)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  expect(() => fs.chown(target, "1" as any, 0, callback)).toThrow(
    expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
  );
  expect(() => fs.rename({} as any, target, callback)).toThrow(
    expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
  );
  expect(callbackCalled).toBe(false);

  const fd = fs.openSync(target, "r+");
  try {
    expect(() => fs.readSync(fd, Buffer.alloc(1), "0" as any, 1, 0)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => fs.writeSync(fd, Buffer.from("x"), "0" as any, 1, 0)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  } finally {
    fs.closeSync(fd);
  }

  expect(fs.readFileSync(new URL(`file://${target}`), "utf8")).toBe("data");
  expect(() => fs.readFileSync(`file://${target}`)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  expect(() => fs.statSync({ href: `file://${target}`, protocol: "file:" } as any)).toThrow(
    expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
  );
});

test("autoClose false streams release abort listeners and preserve descriptors", async () => {
  const target = path.join(root, "stream-abort-cleanup.txt");
  fs.writeFileSync(target, "read-data");

  const readFd = fs.openSync(target, "r");
  const readController = new AbortController();
  const readStream = fs.createReadStream(null as any, {
    fd: readFd,
    autoClose: false,
    signal: readController.signal,
  });
  await new Promise<void>((resolve, reject) => {
    readStream.once("error", reject);
    readStream.once("end", resolve);
    readStream.resume();
  });
  expect(getEventListeners(readController.signal, "abort")).toHaveLength(0);
  expect(fs.fstatSync(readFd).isFile()).toBe(true);
  fs.closeSync(readFd);

  const writeFd = fs.openSync(target, "w+");
  const writeController = new AbortController();
  const writeStream = fs.createWriteStream(null as any, {
    fd: writeFd,
    autoClose: false,
    signal: writeController.signal,
  });
  writeStream.end("written");
  await new Promise<void>((resolve, reject) => {
    writeStream.once("error", reject);
    writeStream.once("finish", resolve);
  });
  expect(getEventListeners(writeController.signal, "abort")).toHaveLength(0);
  expect(fs.fstatSync(writeFd).isFile()).toBe(true);
  fs.closeSync(writeFd);
  expect(fs.readFileSync(target, "utf8")).toBe("written");
});

test("native FileHandle requests register once and clean up after abort", async () => {
  const target = path.join(root, "native-request-cleanup.bin");
  const handle = await fsp.open(target, "w+");
  try {
    const beforeWrite = new Set(process._getActiveRequests());
    const write = handle.write(Buffer.alloc(256 * 1024, 0x61));
    const request = process._getActiveRequests().find(
      item => item?.constructor?.name === "FSReqPromise" && !beforeWrite.has(item),
    );
    expect(request).toBeDefined();
    await write;
    expect(process._getActiveRequests().some(item => item === request)).toBe(false);

    const controller = new AbortController();
    const reason = new Error("cancel bounded native write");
    const beforeAbort = new Set(process._getActiveRequests());
    const aborted = handle.writeFile(Buffer.alloc(256 * 1024, 0x62), { signal: controller.signal });
    const abortedRequest = process._getActiveRequests().find(
      item => item?.constructor?.name === "FSReqPromise" && !beforeAbort.has(item),
    );
    expect(abortedRequest).toBeDefined();
    controller.abort(reason);
    expect(await rejectionOf(aborted)).toBe(reason);
    expect(process._getActiveRequests().some(item => item === abortedRequest)).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    await handle.close();
  }
});

test("synthetic allocation limits cover sync and descriptor reads", async () => {
  const target = path.join(root, "bounded-oom.bin");
  fs.writeFileSync(target, Buffer.alloc(384 * 1024, 0x63));
  const previousLimit = setSyntheticAllocationLimitForTesting(64 * 1024);
  try {
    expect(() => fs.readFileSync(target)).toThrow(expect.objectContaining({
      code: "ENOMEM",
      syscall: "read",
      path: target,
    }));
    expect(() => fs.readFileSync(target, "utf8")).toThrow(expect.objectContaining({ code: "ENOMEM" }));

    const handle = await fsp.open(target, "r");
    try {
      expect(await rejectionOf(handle.readFile())).toMatchObject({ code: "ENOMEM", syscall: "read" });
      expect(fs.fstatSync(handle.fd).isFile()).toBe(true);
    } finally {
      await handle.close();
    }

    const fd = fs.openSync(target, "r");
    try {
      expect(await rejectionOf(fsp.readFile(fd))).toMatchObject({ code: "ENOMEM", syscall: "read" });
      expect(fs.fstatSync(fd).isFile()).toBe(true);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    setSyntheticAllocationLimitForTesting(previousLimit);
  }
});

test("FileHandle reports one close failure then remains idempotent", async () => {
  const target = path.join(root, "close-failure.txt");
  fs.writeFileSync(target, "close");
  const handle = await fsp.open(target, "r");
  fs.closeSync(handle.fd);
  expect(await rejectionOf(handle.close())).toMatchObject({ code: "EBADF", syscall: "close" });
  await handle.close();
  expect(handle.fd).toBe(-1);
});

test("memfd_create is native on Linux and guarded elsewhere", () => {
  if (process.platform !== "linux") {
    expect(() => memfd_create(4097)).toThrow(expect.objectContaining({ code: "ENOSYS" }));
    return;
  }

  const fd = memfd_create(4097);
  try {
    expect(fs.fstatSync(fd).size).toBe(4097);
    expect(fs.writeSync(fd, Buffer.from("memfd"), 0, 5, 0)).toBe(5);
    const output = Buffer.alloc(5);
    expect(fs.readSync(fd, output, 0, output.length, 0)).toBe(5);
    expect(output.toString()).toBe("memfd");
  } finally {
    fs.closeSync(fd);
  }
});

test("BigIntStats preserves exact integer fields and nanosecond components", () => {
  const target = path.join(root, "stat-precision.txt");
  fs.writeFileSync(target, "precision");
  const numberStats = fs.statSync(target);
  const bigintStats = fs.statSync(target, { bigint: true });

  for (const field of ["dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size", "blksize", "blocks"] as const) {
    if (Number.isSafeInteger(numberStats[field])) expect(bigintStats[field]).toBe(BigInt(numberStats[field]));
  }
  for (const field of ["atime", "mtime", "ctime", "birthtime"] as const) {
    const milliseconds = bigintStats[`${field}Ms`];
    const nanoseconds = bigintStats[`${field}Ns`];
    expect(nanoseconds / 1000000n).toBe(milliseconds);
    expect(nanoseconds).toBeGreaterThanOrEqual(milliseconds * 1000000n);
    expect(nanoseconds).toBeLessThan(milliseconds * 1000000n + 1000000n);
  }
});

test("aborted writes remove their signal listener", async () => {
  const target = path.join(root, "aborted.txt");
  const controller = new AbortController();
  const result = fsp.writeFile(target, "data", { signal: controller.signal });
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  process.nextTick(() => controller.abort());
  await result.then(
    () => { throw new Error("aborted write resolved"); },
    error => expect(error).toBe(controller.signal.reason),
  );
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("FileHandle native requests retain the descriptor until abort completion", async () => {
  const writeTarget = path.join(root, "native-abort-write.bin");
  const writeHandle = await fsp.open(writeTarget, "w+");
  const writeController = new AbortController();
  const writeReason = new Error("cancel native write");
  const pendingWrite = writeHandle.writeFile(Buffer.alloc(2 * 1024 * 1024, 0x61), {
    signal: writeController.signal,
  });
  expect(getEventListeners(writeController.signal, "abort")).toHaveLength(1);
  writeController.abort(writeReason);
  await expect(pendingWrite).rejects.toBe(writeReason);
  expect(getEventListeners(writeController.signal, "abort")).toHaveLength(0);
  await writeHandle.close();
  expect(writeHandle.fd).toBe(-1);

  const readTarget = path.join(root, "native-abort-read.bin");
  fs.writeFileSync(readTarget, Buffer.alloc(2 * 1024 * 1024, 0x62));
  const readHandle = await fsp.open(readTarget, "r");
  const readController = new AbortController();
  const readReason = new Error("cancel native read");
  const pendingRead = readHandle.readFile({ signal: readController.signal });
  expect(getEventListeners(readController.signal, "abort")).toHaveLength(1);
  readController.abort(readReason);
  await expect(pendingRead).rejects.toBe(readReason);
  expect(getEventListeners(readController.signal, "abort")).toHaveLength(0);
  await readHandle.close();
  expect(readHandle.fd).toBe(-1);
});

test("one signal cancels concurrent writes and releases shared state", async () => {
  const controller = new AbortController();
  const targets = ["aborted-a.txt", "aborted-b.txt"].map(name => path.join(root, name));
  const writes = targets.map(target => fsp.writeFile(target, "data", { signal: controller.signal }));
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

  process.nextTick(() => controller.abort(new Error("cancel concurrent writes")));
  const results = await Promise.allSettled(writes);
  expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
  expect(results.map(result => result.reason)).toEqual([controller.signal.reason, controller.signal.reason]);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  expect(targets.map(target => fs.existsSync(target))).toEqual([false, false]);
});

describe("cp and copyFile production behavior", () => {
  test("copyFile uses clone fallback, preserves mode, and reports exclusive destinations", () => {
    const source = path.join(root, "copy-source.txt");
    const destination = path.join(root, "copy-destination.txt");
    const cloneDestination = path.join(root, "copy-clone-destination.txt");
    fs.writeFileSync(source, "copy-data");
    if (process.platform !== "win32") fs.chmodSync(source, 0o640);

    fs.copyFileSync(source, destination);
    fs.copyFileSync(source, cloneDestination, fs.constants.COPYFILE_FICLONE);
    expect(fs.readFileSync(destination, "utf8")).toBe("copy-data");
    expect(fs.readFileSync(cloneDestination, "utf8")).toBe("copy-data");
    if (process.platform !== "win32") {
      expect(fs.statSync(destination).mode & 0o777).toBe(0o640);
      expect(fs.statSync(cloneDestination).mode & 0o777).toBe(0o640);
    }

    fs.copyFileSync(source, source);
    expect(fs.readFileSync(source, "utf8")).toBe("copy-data");
    expect(() => fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)).toThrow(
      expect.objectContaining({
        code: "EEXIST",
        syscall: "copyfile",
        path: source,
        dest: destination,
      }),
    );
  });

  test("recursive fallback rejects self-subdirectories and preserves metadata", () => {
    const source = path.join(root, "cp-metadata-source");
    const destination = path.join(root, "cp-metadata-destination");
    const nestedDestination = path.join(source, "nested-copy");
    fs.mkdirSync(source);
    const sourceFile = path.join(source, "readonly.txt");
    fs.writeFileSync(sourceFile, "metadata");
    const timestamp = new Date("2020-01-02T03:04:05.000Z");
    fs.utimesSync(sourceFile, timestamp, timestamp);
    if (process.platform !== "win32") fs.chmodSync(sourceFile, 0o440);

    expect(() => fs.cpSync(source, nestedDestination, {
      recursive: true,
      preserveTimestamps: true,
    })).toThrow(`cannot copy ${source} to a subdirectory of self ${nestedDestination}`);
    expect(fs.existsSync(nestedDestination)).toBe(false);

    fs.cpSync(source, destination, {
      recursive: true,
      preserveTimestamps: true,
      force: true,
    });
    const copiedFile = path.join(destination, "readonly.txt");
    expect(fs.readFileSync(copiedFile, "utf8")).toBe("metadata");
    expect(Math.abs(fs.statSync(copiedFile).mtimeMs - timestamp.getTime())).toBeLessThan(1000);
    if (process.platform !== "win32") {
      expect(fs.statSync(copiedFile).mode & 0o777).toBe(0o440);
    }
  });

  test("promise and callback cp await asynchronous filters", async () => {
    const source = path.join(root, "cp-filter-source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "keep.txt"), "keep");
    fs.writeFileSync(path.join(source, "drop.txt"), "drop");

    const promiseDestination = path.join(root, "cp-filter-promise");
    const seen: string[] = [];
    await fsp.cp(source, promiseDestination, {
      recursive: true,
      filter: async (sourcePath) => {
        await Promise.resolve();
        seen.push(path.basename(sourcePath));
        return !sourcePath.endsWith("drop.txt");
      },
    });
    expect(fs.readdirSync(promiseDestination).sort()).toEqual(["keep.txt"]);
    expect(seen.sort()).toEqual(["cp-filter-source", "drop.txt", "keep.txt"]);

    const callbackDestination = path.join(root, "cp-filter-callback");
    await new Promise<void>((resolve, reject) => {
      fs.cp(source, callbackDestination, {
        recursive: true,
        filter: async sourcePath => !sourcePath.endsWith("drop.txt"),
      }, error => error ? reject(error) : resolve());
    });
    expect(fs.readdirSync(callbackDestination).sort()).toEqual(["keep.txt"]);
  });

  test("sync cp rejects promise-returning filters before creating output", () => {
    const source = path.join(root, "cp-sync-filter-source");
    const destination = path.join(root, "cp-sync-filter-destination");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "file.txt"), "data");

    expect(() => fs.cpSync(source, destination, {
      recursive: true,
      filter: async () => true,
    })).toThrow("Expected a boolean from the filter function, but got a promise");
    expect(fs.existsSync(destination)).toBe(false);
  });
});
