import { once } from "node:events";
import { expect, test } from "bun:test";
import { WebSocket, WebSocketServer } from "ws";

test("ws validates URLs and subprotocols before connecting", () => {
  expect(() => new WebSocket("ftp://localhost/socket")).toThrow(SyntaxError);
  expect(() => new WebSocket("ws://localhost/socket#fragment")).toThrow(SyntaxError);
  expect(() => new WebSocket("ws://localhost/socket", ["chat", "chat"])).toThrow(SyntaxError);
  expect(() => new WebSocket("ws://localhost/socket", ["not a token"])).toThrow(SyntaxError);
});

test("ws forwards client options through its finishRequest facade", async () => {
  const server = new WebSocketServer({
    port: 0,
    handleProtocols(protocols) {
      return protocols.has("chat") ? "chat" : false;
    },
  });
  await once(server, "listening");

  const connection = new Promise<{ socket: WebSocket; headers: Record<string, string> }>((resolve) => {
    server.once("connection", (socket, request) => resolve({ socket, headers: request.headers }));
  });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("expected an IP listener");

  const client = new WebSocket(`ws://127.0.0.1:${address.port}/socket`, "chat", {
    auth: "cottontail:secret",
    headers: { "X-Initial": "present" },
    origin: "https://example.test",
    finishRequest(request) {
      expect(typeof request.on).toBe("function");
      expect(Object.prototype.toString.call(request)).toBe("[object ClientRequest]");
      request.setHeader("X-Finished", "present");
      request.end();
    },
  });

  try {
    await once(client, "open");
    const accepted = await connection;
    expect(client.protocol).toBe("chat");
    expect(accepted.headers.authorization).toBe(`Basic ${Buffer.from("cottontail:secret").toString("base64")}`);
    expect(accepted.headers.origin).toBe("https://example.test");
    expect(accepted.headers["x-initial"]).toBe("present");
    expect(accepted.headers["x-finished"]).toBe("present");

    const closed = once(client, "close");
    client.close();
    await closed;
  } finally {
    client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
