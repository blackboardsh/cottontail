import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

test("prepared workers expose Bun's hardcoded ws package", async () => {
  const result = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort } = require("node:worker_threads");
      const ws = require("ws");
      const websocket = require("ws/lib/websocket");
      const nextWs = require("next/dist/compiled/ws");
      parentPort.postMessage({
        websocketServer: typeof ws.WebSocketServer,
        websocket: typeof ws.WebSocket,
        aliasesMatch: ws === websocket && ws === nextWs,
      });
    `, { eval: true });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });

  expect(result).toEqual({
    websocketServer: "function",
    websocket: "function",
    aliasesMatch: true,
  });
});
