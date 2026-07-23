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
