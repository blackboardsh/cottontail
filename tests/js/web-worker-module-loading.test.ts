import { expect, test } from "bun:test";

test("Web Workers resolve runtime builtin imports before native evaluation", async () => {
  const source = [
    'import { basename } from "node:path";',
    'postMessage({ basename: basename("/cottontail/worker.js"), which: typeof Bun.which });',
  ].join("\n");
  const worker = new globalThis.Worker(
    `data:text/javascript,${encodeURIComponent(source)}`,
    { type: "module" },
  );

  const value = await new Promise<{ basename: string; which: string }>((resolve, reject) => {
    worker.onmessage = event => resolve(event.data);
    worker.onerror = event => reject(new Error(String(event.message ?? event)));
  });

  expect(value).toEqual({ basename: "worker.js", which: "function" });
  worker.terminate();
});

test("Web Worker source remains usable after top-level await and idle collection", async () => {
  const marker = "worker-owned-source-survives";
  const literal = marker.repeat(4096);
  const source = `
    function readRetainedLiteral() { return ${JSON.stringify(literal)}; }
    await new Promise(resolve => setTimeout(resolve, 10));
    self.onmessage = () => {
      // Native worker source ownership ends before evaluation. Force lazy
      // code to use JSC's own source after the bootstrap and a full collection.
      Bun.gc(true);
      const value = readRetainedLiteral();
      postMessage({ length: value.length, marker: value.slice(0, ${marker.length}),
        sourceRetained: readRetainedLiteral.toString().includes(${JSON.stringify(marker)}) });
    };
    postMessage("ready");
  `;
  const worker = new globalThis.Worker(
    `data:text/javascript,${encodeURIComponent(source)}`,
    { type: "module" },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Worker did not finish delayed source evaluation")), 10_000);
      worker.onerror = event => reject(new Error(String(event.message ?? event)));
      worker.onmessage = event => {
        if (event.data === "ready") setTimeout(() => worker.postMessage("read"), 50);
        else resolve(event.data);
      };
    });
    expect(value).toEqual({ length: literal.length, marker, sourceRetained: true });
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
}, 15_000);

test("Web Worker compaction preserves function names and delayed error locations", async () => {
  const source = `
    import { basename } from "node:path";
    function namedWorkerFailure() { throw new Error("delayed-worker-failure"); }
    class WorkerMessageValue {}
    await new Promise(resolve => setTimeout(resolve, 0));
    self.onmessage = () => {
      try { namedWorkerFailure(); }
      catch (error) {
        postMessage({ functionName: namedWorkerFailure.name,
          className: WorkerMessageValue.name, message: error.message,
          stack: String(error.stack), basename: basename("/worker/entry.js") });
      }
    };
    postMessage("ready");
  `;
  const worker = new globalThis.Worker(
    `data:text/javascript,${encodeURIComponent(source)}`,
    { type: "module" },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<{
      functionName: string; className: string; message: string; stack: string; basename: string;
    }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Worker did not report its delayed error")), 10_000);
      worker.onerror = event => reject(new Error(String(event.message ?? event)));
      worker.onmessage = event => {
        if (event.data === "ready") worker.postMessage("throw");
        else resolve(event.data);
      };
    });
    expect(result.functionName).toBe("namedWorkerFailure");
    expect(result.className).toBe("WorkerMessageValue");
    expect(result.message).toBe("delayed-worker-failure");
    expect(result.basename).toBe("entry.js");
    expect(result.stack).toContain("namedWorkerFailure");
    // Worker bundles do not emit source maps. Their generated location must
    // remain usable rather than becoming an anonymous/native frame.
    expect(result.stack).toMatch(/bun-worker-[^\s()]*\.js:\d+:\d+/);
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
}, 15_000);
