import { expect, test } from "bun:test";
import {
  BroadcastChannel,
  MessageChannel,
  SHARE_ENV,
  Worker,
  moveMessagePortToContext,
} from "node:worker_threads";
import { createContext, runInContext } from "node:vm";

function once(target: any, event: string) {
  return new Promise<any[]>(resolve => target.once(event, (...args: any[]) => resolve(args)));
}

test("per-worker CPU and profiler APIs expose the native boundary instead of fake data", async () => {
  const worker = new Worker(`setInterval(() => {}, 1000);`, { eval: true });
  await once(worker, "online");
  for (const method of ["cpuUsage", "startCpuProfile", "startHeapProfile"] as const) {
    let error: any;
    try {
      await worker[method]();
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("ERR_COTTONTAIL_NATIVE_BOUNDARY");
  }
  await worker.terminate();
});

test("moving a MessagePort into a shared-realm vm context keeps it functional", async () => {
  const { port1, port2 } = new MessageChannel();
  const context = createContext({});
  context.port = moveMessagePortToContext(port1, context);
  expect(runInContext("port", context)).toBe(port1);
  const received = new Promise(resolve => { context.record = resolve; });
  runInContext("port.onmessage = ({ data }) => record(data)", context);
  port2.postMessage("moved");
  expect(await received).toBe("moved");
});

test.todo("COTTONTAIL-COMPAT: Worker.ref/unref needs a native parent-loop keepalive hook", async () => {
  const worker = new Worker(`setTimeout(() => {}, 1000);`, { eval: true });
  worker.unref();
  expect(await once(worker, "exit")).toBeDefined();
});

test.todo("COTTONTAIL-COMPAT: resourceLimits needs native JSC heap and thread-stack enforcement", async () => {
  const worker = new Worker(`for (;;) new ArrayBuffer(1024 * 1024);`, {
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 8, stackSizeMb: 1 },
  });
  expect(await once(worker, "error")).toBeDefined();
});

test.todo("COTTONTAIL-COMPAT: Worker name needs native OS-thread naming in addition to JS metadata", () => {});

test.todo("COTTONTAIL-COMPAT: SHARE_ENV needs a process-wide live environment binding", async () => {
  const worker = new Worker(`process.env.CT_SHARE_ENV_PROBE = "worker";`, { eval: true, env: SHARE_ENV });
  await once(worker, "exit");
  expect(process.env.CT_SHARE_ENV_PROBE).toBe("worker");
});

test.todo("COTTONTAIL-COMPAT: BroadcastChannel needs a process-wide cross-isolate registry", async () => {
  const channel = new BroadcastChannel("worker-native-boundary");
  const worker = new Worker(
    `const { BroadcastChannel } = require("node:worker_threads");
     new BroadcastChannel("worker-native-boundary").postMessage("worker");`,
    { eval: true },
  );
  const message = new Promise(resolve => { channel.onmessage = event => resolve(event.data); });
  expect(await message).toBe("worker");
  await worker.terminate();
});

test.todo("COTTONTAIL-COMPAT: natural process.exitCode and beforeExit need native worker-exit propagation", async () => {
  const worker = new Worker(`process.exitCode = 23;`, { eval: true });
  expect((await once(worker, "exit"))[0]).toBe(23);
});

test.todo("COTTONTAIL-COMPAT: hard termination needs a native JSC interrupt for non-cooperative JavaScript", async () => {
  const worker = new Worker(`for (;;) {}`, { eval: true });
  expect(await worker.terminate()).toBe(1);
});

test.todo("COTTONTAIL-COMPAT: postMessageToThread needs native destination-listener acknowledgement and timeout", () => {});

test.todo("COTTONTAIL-COMPAT: worker_threads.locks needs a process-wide native registry across isolates", () => {});

test.todo("COTTONTAIL-COMPAT: exact worker stdio backpressure and fd writes need native worker pipe hooks", () => {});
