import { fork } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "bun:test";

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 10_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

test("fork queues a large startup message until the child IPC listener is ready", async () => {
  const child = fork(join(import.meta.dir, "fixtures", "child-process-delayed-ipc-listener.js"), [], {
    serialization: "json",
    silent: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const response = new Promise<any>((resolve, reject) => {
    child.once("error", reject);
    child.once("message", resolve);
  });
  const sendError = new Promise<Error | null>((resolve) => {
    expect(child.send({ payload: "x".repeat(64 * 1024) }, resolve)).toBe(true);
  });

  expect(await withTimeout(sendError, `startup IPC send timed out: ${stderr}`)).toBeNull();
  expect(await withTimeout(response, `startup IPC response timed out: ${stderr}`)).toEqual({ size: 64 * 1024 });
  expect(await withTimeout(
    new Promise<number | null>((resolve) => child.once("close", resolve)),
    `startup IPC child did not exit: ${stderr}`,
  )).toBe(0);
});

test("killing a child before IPC readiness cancels callbackless queued messages", async () => {
  const child = fork(join(import.meta.dir, "fixtures", "child-process-delayed-ipc-listener.js"), [], {
    serialization: "json",
    silent: true,
  });
  const close = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  expect(child.send({ ignored: true })).toBe(true);
  expect(child.kill("SIGINT")).toBe(true);
  expect(await withTimeout(close, "killed pre-ready child did not close")).toEqual({
    code: null,
    signal: "SIGINT",
  });
});
