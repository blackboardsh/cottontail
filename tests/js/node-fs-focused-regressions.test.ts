import { afterAll, describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-fs-focused-"));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

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
