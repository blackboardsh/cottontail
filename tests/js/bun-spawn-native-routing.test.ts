import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";

test.skipIf(process.platform === "win32")("argv0 overrides do not replace arbitrary executables", async () => {
  const asyncChild = Bun.spawn(["/bin/sh", "-c", "printf '%s' \"$0\""], {
    argv0: "async-display-name",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await asyncChild.stdout.text()).toBe("async-display-name");
  expect(await asyncChild.exited).toBe(0);

  const syncChild = Bun.spawnSync(["/bin/sh", "-c", "printf '%s' \"$0\""], {
    argv0: "sync-display-name",
  });
  expect(syncChild.exitCode).toBe(0);
  expect(syncChild.stdout.toString()).toBe("sync-display-name");

  const nodeChild = nodeSpawnSync("/bin/sh", ["-c", "printf '%s' \"$0\""], {
    argv0: "node-display-name",
  });
  expect(nodeChild.status).toBe(0);
  expect(nodeChild.stdout.toString()).toBe("node-display-name");
});

test.skipIf(process.platform === "win32")("numeric stdout descriptors route directly in async and sync spawn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-spawn-fd-"));
  using cleanup = { [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) };

  const asyncPath = join(directory, "async.txt");
  const asyncFd = openSync(asyncPath, "w+");
  const asyncChild = Bun.spawn(["/bin/sh", "-c", "printf async-fd"], {
    stdin: "ignore",
    stdout: asyncFd,
    stderr: "ignore",
  });
  expect(asyncChild.stdout).toBe(asyncFd);
  expect(await asyncChild.exited).toBe(0);
  closeSync(asyncFd);
  expect(readFileSync(asyncPath, "utf8")).toBe("async-fd");

  const syncPath = join(directory, "sync.txt");
  const syncFd = openSync(syncPath, "w+");
  const syncChild = Bun.spawnSync(["/bin/sh", "-c", "printf sync-fd"], {
    stdin: "ignore",
    stdout: syncFd,
    stderr: "ignore",
  });
  expect(syncChild.exitCode).toBe(0);
  expect(syncChild.stdout).toBe(syncFd);
  closeSync(syncFd);
  expect(readFileSync(syncPath, "utf8")).toBe("sync-fd");

  const nodePath = join(directory, "node.txt");
  const nodeFd = openSync(nodePath, "w+");
  const nodeChild = nodeSpawnSync("/bin/sh", ["-c", "printf node-fd"], {
    stdio: ["ignore", nodeFd, "ignore"],
  });
  expect(nodeChild.status).toBe(0);
  expect(nodeChild.stdout).toBeNull();
  closeSync(nodeFd);
  expect(readFileSync(nodePath, "utf8")).toBe("node-fd");
});

test.skipIf(process.platform === "win32")("extra pipe descriptors are exposed and connected to the child", async () => {
  const child = Bun.spawn(["/bin/sh", "-c", "printf extra-pipe >&3"], {
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  const fd = child.stdio[3];
  expect(typeof fd).toBe("number");
  expect(await child.exited).toBe(0);
  expect(readFileSync(fd, "utf8")).toBe("extra-pipe");
  closeSync(fd);
});

test.skipIf(process.platform === "win32")("Bun.spawn IPC launches Node directly with its requested argv0", async () => {
  let resolveMessage!: (value: { argv0: string; pid: number }) => void;
  const messagePromise = new Promise<{ argv0: string; pid: number }>((resolve) => {
    resolveMessage = resolve;
  });
  const child = Bun.spawn({
    cmd: ["node", "-e", "process.send({ argv0: process.argv0, pid: process.pid })"],
    argv0: "node-ipc-display-name",
    ipc(message) {
      resolveMessage(message as { argv0: string; pid: number });
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });

  const [message, exitCode] = await Promise.all([messagePromise, child.exited]);
  expect(exitCode).toBe(0);
  expect(message.argv0).toBe("node-ipc-display-name");
  expect(message.pid).toBe(child.pid);
});

test("Bun subprocess ref and unref return undefined", async () => {
  const child = Bun.spawn([process.execPath, "-e", ""], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(child.unref()).toBeUndefined();
  expect(child.ref()).toBeUndefined();
  expect(await child.exited).toBe(0);
});
