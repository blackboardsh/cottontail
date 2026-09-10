import { expect, test } from "bun:test";

async function runWorker(source: string, message?: unknown) {
  const worker = new globalThis.Worker(
    `data:text/javascript,${encodeURIComponent(source)}`,
    { type: "module" },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<any>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Worker did not respond")), 5_000);
      worker.onmessage = event => resolve(event.data);
      worker.onerror = event => reject(new Error(String(event.message ?? event)));
      if (message !== undefined) worker.postMessage(message);
    });
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
}

for (const [name, imports] of [
  ["no builtin imports", ""],
  ["full runtime imports", 'import { spawn } from "node:child_process";'],
]) {
  test(`Worker onmessage runs once per message with ${name}`, async () => {
    const result = await runWorker(`
      ${imports}
      const calls = [];
      self.onmessage = function (event) {
        calls.push(["attribute", event.data]);
      };
      self.addEventListener("message", function (event) {
        calls.push(["listener", event.data]);
        setTimeout(() => postMessage(calls), 0);
      });
    `, "request");
    expect(result).toEqual([
      ["attribute", "request"],
      ["listener", "request"],
    ]);
  });
}

test("Worker event attributes retain their registration order when reassigned", async () => {
  const result = await runWorker(`
    import { spawn } from "node:child_process";
    const calls = [];
    self.addEventListener("message", () => calls.push("before"));
    self.onmessage = () => calls.push("old");
    self.addEventListener("message", () => calls.push("after"));
    self.onmessage = () => calls.push("replacement");
    self.addEventListener("message", () => setTimeout(() => postMessage(calls), 0));
  `, "request");
  expect(result).toEqual(["before", "replacement", "after"]);
});

test("Worker event attributes and explicit listeners are separate registrations", async () => {
  const result = await runWorker(`
    import { spawn } from "node:child_process";
    let calls = 0;
    const handler = () => calls++;
    self.onmessage = handler;
    self.addEventListener("message", handler);
    self.addEventListener("message", () => setTimeout(() => postMessage(calls), 0));
  `, "request");
  expect(result).toBe(2);
});

test("Worker dispatchEvent shares native message handlers and supports clearing attributes", async () => {
  const result = await runWorker(`
    import { spawn } from "node:child_process";
    const calls = [];
    self.onmessage = event => calls.push("attribute:" + event.data);
    const listener = event => calls.push("listener:" + event.data);
    self.addEventListener("message", listener);
    const dispatched = self.dispatchEvent(new MessageEvent("message", { data: "first" }));
    self.onmessage = null;
    self.dispatchEvent(new MessageEvent("message", { data: "second" }));
    self.removeEventListener("message", listener);
    self.dispatchEvent(new MessageEvent("message", { data: "removed" }));
    self.onerror = event => event.preventDefault();
    const canceled = self.dispatchEvent(new Event("error", { cancelable: true }));
    postMessage({ calls, dispatched, canceled, cleared: self.onmessage === null });
  `);
  expect(result).toEqual({
    calls: ["attribute:first", "listener:first", "listener:second"],
    dispatched: true,
    canceled: false,
    cleared: true,
  });
});

test("Loading the full runtime after assigning Worker onmessage does not duplicate delivery", async () => {
  const result = await runWorker(`
    let calls = 0;
    self.onmessage = async () => {
      calls++;
      await import("node:child_process");
      setTimeout(() => postMessage(calls), 0);
    };
  `, "request");
  expect(result).toBe(1);
});

test("Worker dispatch skips removed attributes and defers new registrations", async () => {
  const result = await runWorker(`
    import { spawn } from "node:child_process";
    const calls = [];
    const replace = () => {
      calls.push("replace");
      self.onmessage = null;
      self.onmessage = event => calls.push("new:" + event.data);
      self.addEventListener("message", event => calls.push("added:" + event.data));
    };
    self.addEventListener("message", replace);
    self.onmessage = event => calls.push("old:" + event.data);
    self.dispatchEvent(new MessageEvent("message", { data: "first" }));
    self.removeEventListener("message", replace);
    self.dispatchEvent(new MessageEvent("message", { data: "second" }));
    postMessage(calls);
  `);
  expect(result).toEqual(["replace", "new:second", "added:second"]);
});
