import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  consumeWebSocketDataFrame,
  createWebSocketMessageState,
  parseWebSocketClosePayload,
  parseWebSocketFrames,
  websocketFrame,
} from "node:http";
import { Buffer } from "node:buffer";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import WsClient, { WebSocketServer } from "ws";

function deadline<T>(promise: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    timer.unref?.();
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

function websocketAccept(key: string): string {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function listen(server: ReturnType<typeof createNetServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address == null || typeof address === "string") {
        reject(new Error("expected an IP listener"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeNetServer(server: ReturnType<typeof createNetServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function openRawWebSocket(port: number): Promise<{ socket: ReturnType<typeof netConnect>; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1");
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      socket.off("data", onData);
      const statusLine = buffer.subarray(0, headerEnd).toString("latin1").split("\r\n", 1)[0];
      if (!statusLine.includes(" 101 ")) {
        reject(new Error(`WebSocket upgrade failed: ${statusLine}`));
        return;
      }
      resolve({ socket, head: buffer.subarray(headerEnd + 4) });
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write([
        "GET /socket HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"));
    });
  });
}

function protocolError(action: () => unknown): { closeCode?: number } {
  try {
    action();
  } catch (error) {
    return error as { closeCode?: number };
  }
  throw new Error("expected a WebSocket protocol error");
}

describe("shared WebSocket framing", () => {
  test("enforces endpoint roles, canonical lengths, control frames, and fragmentation", () => {
    expect(protocolError(() => parseWebSocketFrames(
      Buffer.from([0x81, 0x80, 0, 0, 0, 0]),
      { expectMasked: false },
    )).closeCode).toBe(1002);
    expect(protocolError(() => parseWebSocketFrames(
      Buffer.from([0x81, 0x00]),
      { expectMasked: true },
    )).closeCode).toBe(1002);
    expect(protocolError(() => parseWebSocketFrames(
      Buffer.from([0x82, 0x7e, 0x00, 0x01, 0x00]),
      { expectMasked: false },
    )).closeCode).toBe(1002);
    expect(protocolError(() => parseWebSocketFrames(
      Buffer.from([0x09, 0x00]),
      { expectMasked: false },
    )).closeCode).toBe(1002);

    const state = createWebSocketMessageState();
    const first = parseWebSocketFrames(Buffer.from([0x01, 0x03, 0x68, 0x65, 0x6c]), {
      expectMasked: false,
    }).frames[0];
    const continuation = parseWebSocketFrames(Buffer.from([0x80, 0x02, 0x6c, 0x6f]), {
      expectMasked: false,
    }).frames[0];
    expect(consumeWebSocketDataFrame(state, first)).toBeNull();
    expect(consumeWebSocketDataFrame(state, continuation)?.payload.toString()).toBe("hello");
    expect(protocolError(() => consumeWebSocketDataFrame(state, continuation)).closeCode).toBe(1002);
  });

  test("rejects invalid close codes and UTF-8", () => {
    expect(protocolError(() => parseWebSocketClosePayload(Buffer.from([0x03, 0xed]))).closeCode).toBe(1002);
    expect(protocolError(() => parseWebSocketClosePayload(
      Buffer.from([0x03, 0xe8, 0xc0, 0xaf]),
    )).closeCode).toBe(1007);
  });
});

test("global client rejects masked server frames and flushes a protocol close", async () => {
  let resolveClientCloseFrame!: (value: { code: number; reason: string }) => void;
  let rejectClientCloseFrame!: (error: unknown) => void;
  const clientCloseFrame = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    resolveClientCloseFrame = resolve;
    rejectClientCloseFrame = reject;
  });

  const server = createNetServer((socket) => {
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    socket.on("error", rejectClientCloseFrame);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const headers = buffer.subarray(0, headerEnd).toString("latin1");
        const keyLine = headers.split("\r\n").find((line) => line.toLowerCase().startsWith("sec-websocket-key:"));
        const key = keyLine?.slice(keyLine.indexOf(":") + 1).trim();
        if (!key) {
          rejectClientCloseFrame(new Error("missing Sec-WebSocket-Key"));
          socket.destroy();
          return;
        }
        upgraded = true;
        buffer = buffer.subarray(headerEnd + 4);
        const response = Buffer.from([
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
          "",
          "",
        ].join("\r\n"));
        socket.write(Buffer.concat([response, websocketFrame(0x1, "must-fail", true)]));
      }
      if (buffer.byteLength === 0) return;
      try {
        const parsed = parseWebSocketFrames(buffer, { expectMasked: true });
        buffer = parsed.remaining;
        const close = parsed.frames.find((frame) => frame.opcode === 0x8);
        if (close) resolveClientCloseFrame(parseWebSocketClosePayload(close.payload));
      } catch (error) {
        rejectClientCloseFrame(error);
      }
    });
  });

  try {
    const port = await deadline(listen(server), "raw WebSocket listener");
    let messages = 0;
    const closeEvent = new Promise<CloseEvent>((resolve) => {
      const client = new globalThis.WebSocket(`ws://127.0.0.1:${port}/socket`);
      client.addEventListener("message", () => { messages += 1; });
      client.addEventListener("error", () => {});
      client.addEventListener("close", resolve);
    });
    const [close, peerClose] = await deadline(
      Promise.all([closeEvent, clientCloseFrame]),
      "global client protocol close",
    );
    expect(messages).toBe(0);
    expect(close.code).toBe(1002);
    expect(close.wasClean).toBe(false);
    expect(peerClose.code).toBe(1002);
  } finally {
    await deadline(closeNetServer(server), "raw WebSocket listener close");
  }
});

test("Bun.serve rejects unmasked client frames before dispatching message", async () => {
  let resolveServerClose!: (value: { code: number; reason: string }) => void;
  const serverClose = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveServerClose = resolve;
  });
  let messages = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request)) return undefined as never;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message() { messages += 1; },
      close(_ws, code, reason) { resolveServerClose({ code, reason }); },
    },
  });

  let rawSocket: ReturnType<typeof netConnect> | null = null;
  try {
    const opened = await deadline(openRawWebSocket(server.port!), "Bun.serve raw upgrade");
    rawSocket = opened.socket;
    const received = new Promise<Buffer>((resolve, reject) => {
      const chunks = opened.head.byteLength > 0 ? [opened.head] : [];
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      };
      opened.socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      opened.socket.once("end", finish);
      opened.socket.once("close", finish);
      opened.socket.once("error", reject);
    });
    opened.socket.write(websocketFrame(0x1, "unmasked", false));
    const [responseBytes, close] = await deadline(
      Promise.all([received, serverClose]),
      "Bun.serve protocol close",
    );
    const frames = parseWebSocketFrames(responseBytes, { expectMasked: false }).frames;
    const closeFrame = frames.find((frame) => frame.opcode === 0x8);
    expect(closeFrame).toBeDefined();
    expect(parseWebSocketClosePayload(closeFrame!.payload).code).toBe(1002);
    expect(close.code).toBe(1002);
    expect(messages).toBe(0);
  } finally {
    rawSocket?.destroy();
    await server.stop(true);
  }
});

test("ws client and server negotiate permessage-deflate and close cleanly", async () => {
  let wss!: WebSocketServer;
  await deadline(new Promise<void>((resolve, reject) => {
    wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      perMessageDeflate: { threshold: 0 },
    }, resolve);
    wss.once("error", reject);
  }), "ws server listen");

  const payload = "compress-me:".repeat(512);
  try {
    const address = wss.address();
    if (address == null || typeof address === "string") throw new Error("expected a ws IP listener");

    const serverRoundTrip = new Promise<void>((resolve, reject) => {
      wss.once("connection", (socket) => {
        try {
          expect(socket.extensions).toBe("permessage-deflate");
        } catch (error) {
          reject(error);
          return;
        }
        socket.once("error", reject);
        socket.once("message", (data, isBinary) => {
          try {
            expect(isBinary).toBe(false);
            expect(data.toString()).toBe(payload);
          } catch (error) {
            reject(error);
            return;
          }
          socket.send(data, { binary: false, compress: true }, (error?: Error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      });
    });

    const clientClose = new Promise<{ code: number; reason: string; wasClean: boolean }>((resolve, reject) => {
      const client = new WsClient(`ws://127.0.0.1:${address.port}/socket`, {
        perMessageDeflate: true,
      });
      client.once("error", reject);
      client.once("open", () => {
        try {
          expect(client.extensions.includes("permessage-deflate")).toBe(true);
          client.send(payload, { compress: true }, (error?: Error) => {
            if (error) reject(error);
          });
        } catch (error) {
          reject(error);
        }
      });
      client.once("message", (data, isBinary) => {
        try {
          expect(isBinary).toBe(false);
          expect(data.toString()).toBe(payload);
          client.close(1000, "done");
        } catch (error) {
          reject(error);
        }
      });
      client.once("close", (code, reason, wasClean) => resolve({ code, reason, wasClean }));
    });

    const [, close] = await deadline(
      Promise.all([serverRoundTrip, clientClose]),
      "compressed ws round trip",
    );
    expect(close.code).toBe(1000);
    expect(close.reason).toBe("done");
    expect(close.wasClean).toBe(true);
  } finally {
    await deadline(new Promise<void>((resolve) => wss.close(() => resolve())), "ws server close");
  }
});
