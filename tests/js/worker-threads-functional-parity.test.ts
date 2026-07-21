import { expect, test } from "bun:test";
import {
  SHARE_ENV,
  Worker,
} from "node:worker_threads";

function once(target: any, event: string) {
  return new Promise<any[]>(resolve => target.once(event, (...args: any[]) => resolve(args)));
}

function streamText(stream: any) {
  return new Promise<string>((resolve, reject) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => { text += chunk; });
    stream.once("error", reject);
    stream.once("end", () => resolve(text));
  });
}

test("SHARE_ENV propagates live parent and worker mutations", async () => {
  const prefix = `CT_WORKER_SHARED_${Date.now()}`;
  const inheritedKey = `${prefix}_INHERITED`;
  const lateKey = `${prefix}_LATE`;
  const workerKey = `${prefix}_WORKER`;
  const deletedKey = `${prefix}_DELETED`;
  process.env[inheritedKey] = "parent-before";
  process.env[deletedKey] = "delete-me";

  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     parentPort.once("message", ({ inheritedKey, lateKey, workerKey, deletedKey }) => {
       const observed = {
         inherited: process.env[inheritedKey],
         late: process.env[lateKey],
       };
       process.env[workerKey] = "worker-write";
       delete process.env[deletedKey];
       parentPort.postMessage(observed);
     });`,
    { eval: true, env: SHARE_ENV },
  );

  process.env[lateKey] = "parent-after";
  const result = once(worker, "message");
  worker.postMessage({ inheritedKey, lateKey, workerKey, deletedKey });
  expect((await result)[0]).toEqual({ inherited: "parent-before", late: "parent-after" });
  await once(worker, "exit");
  expect(process.env[workerKey]).toBe("worker-write");
  expect(process.env[deletedKey]).toBeUndefined();

  for (const key of [inheritedKey, lateKey, workerKey, deletedKey]) delete process.env[key];
});

test("ordinary worker environments remain isolated", async () => {
  const key = `CT_WORKER_ISOLATED_${Date.now()}`;
  delete process.env[key];
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     process.env[workerData] = "worker-only";
     parentPort.postMessage(process.env[workerData]);`,
    { eval: true, workerData: key },
  );
  expect((await once(worker, "message"))[0]).toBe("worker-only");
  await once(worker, "exit");
  expect(process.env[key]).toBeUndefined();
});

test("worker options expose argv, execArgv, name, resource limits, and stdio", async () => {
  const worker = new Worker(
    `const { parentPort, resourceLimits, threadName } = require("node:worker_threads");
     const chunks = [];
     process.stdin.on("data", chunk => chunks.push(chunk));
     process.stdin.on("end", () => {
       process.stdout.write(Buffer.concat(chunks));
       process.stderr.write("stderr-ok");
       parentPort.postMessage({ argv: process.argv, execArgv: process.execArgv, resourceLimits, threadName });
     });`,
    {
      eval: true,
      argv: ["first", 2],
      execArgv: ["--no-warnings"],
      name: "cottontail-worker-test",
      resourceLimits: { stackSizeMb: 2 },
      stdin: true,
      stdout: true,
      stderr: true,
    },
  );
  const exit = once(worker, "exit");
  const stdoutText = streamText(worker.stdout);
  const stderrText = streamText(worker.stderr);
  worker.stdin!.end("stdin-ok");
  const [metadata] = await once(worker, "message");
  const [stdout, stderr] = await Promise.all([stdoutText, stderrText]);
  await exit;

  expect(metadata.argv.slice(-2)).toEqual(["first", "2"]);
  expect(metadata.execArgv).toEqual(["--no-warnings"]);
  expect(metadata.threadName).toBe("cottontail-worker-test");
  expect(metadata.resourceLimits).toEqual({ stackSizeMb: 2 });
  expect(stdout).toBe("stdin-ok");
  expect(stderr).toBe("stderr-ok");
});

test("Worker rejects invalid option containers", () => {
  expect(() => new Worker("", { eval: true, env: 42 as any })).toThrow({
    name: "TypeError",
    code: "ERR_INVALID_ARG_TYPE",
  });
  expect(() => new Worker("", { eval: true, execArgv: "--no-warnings" as any })).toThrow({
    name: "TypeError",
    code: "ERR_INVALID_ARG_TYPE",
  });
  expect(() => new Worker("", { eval: true, argv: "value" as any })).toThrow({
    name: "TypeError",
    code: "ERR_INVALID_ARG_TYPE",
  });
});
