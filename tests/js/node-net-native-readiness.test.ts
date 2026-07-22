import { expect, test } from "bun:test";
import { once } from "node:events";
import net from "node:net";

function withTimeout<T>(promise: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function listen(server: net.Server): Promise<net.AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address() as net.AddressInfo));
  });
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

test("net.Server accepts from native readable readiness", async () => {
  const server = net.createServer(socket => socket.end("ready"));
  const clients: net.Socket[] = [];
  try {
    const address = await listen(server);
    expect((server as any)._acceptWatchId).toBeGreaterThan(0);
    expect((server as any)._acceptTimer).toBeNull();

    server.unref();
    server.ref();
    const responses = await Promise.all(Array.from({ length: 16 }, async () => {
      const client = net.connect(address.port, address.address);
      clients.push(client);
      client.setEncoding("utf8");
      let response = "";
      client.on("data", chunk => { response += chunk; });
      await withTimeout(once(client, "end"), "client response");
      return response;
    }));
    expect(responses).toEqual(Array(16).fill("ready"));
  } finally {
    for (const client of clients) client.destroy();
    await closeServer(server);
  }
});

test("blocked socket writes resume from native writable readiness", async () => {
  let peer: net.Socket | undefined;
  let client: net.Socket | undefined;
  const accepted = Promise.withResolvers<net.Socket>();
  const server = net.createServer({ pauseOnConnect: true }, socket => {
    peer = socket;
    accepted.resolve(socket);
  });

  try {
    const address = await listen(server);
    client = net.connect({ host: address.address, port: address.port, highWaterMark: 16 * 1024 });
    await withTimeout(once(client, "connect"), "client connect");
    peer = await withTimeout(accepted.promise, "server accept");

    let received = 0;
    peer.on("data", chunk => { received += chunk.length; });
    const payload = Buffer.alloc(16 * 1024 * 1024, 0x5a);
    const drained = once(client, "drain");
    const writeCompleted = new Promise<void>((resolve, reject) => {
      expect(client!.write(payload, error => error ? reject(error) : resolve())).toBe(false);
    });

    expect((client as any)._outboundWrites.length).toBeGreaterThan(0);
    expect((client as any)._writeRetryTimer).toBeNull();
    peer.resume();
    await withTimeout(Promise.all([drained, writeCompleted]), "socket drain");
    client.end();
    await withTimeout(once(peer, "end"), "peer end");
    expect(received).toBe(payload.length);
  } finally {
    client?.destroy();
    peer?.destroy();
    await closeServer(server);
  }
});
