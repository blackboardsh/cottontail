import assert from "node:assert/strict";
import { createServer, request } from "node:http";

function deadline<T>(promise: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
    }),
  ]);
}

function listen(server: ReturnType<typeof createServer>, path: string): Promise<void> {
  return deadline(new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  }), `listen ${path}`);
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return deadline(new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => error ? reject(error) : resolve());
  }), "server close");
}

function requestPipe(socketPath: string, body: string): Promise<string> {
  return deadline(new Promise<string>((resolve, reject) => {
    const outgoing = request({
      socketPath,
      method: "POST",
      path: "/pipe",
      headers: {
        "content-length": Buffer.byteLength(body),
        "content-type": "text/plain",
      },
    }, incoming => {
      incoming.setEncoding("utf8");
      let responseBody = "";
      incoming.on("data", chunk => {
        responseBody += chunk;
      });
      incoming.once("end", () => resolve(responseBody));
      incoming.once("error", reject);
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  }), `request ${socketPath}`);
}

if (process.platform === "win32") {
  const suffix = `${process.pid}-${Date.now().toString(36)}`;

  const nodePipe = `\\\\.\\pipe\\cottontail-node-http-${suffix}`;
  const nodeServer = createServer(async (incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    for await (const chunk of incoming) body += chunk;
    outgoing.end(`node:${body}`);
  });
  try {
    await listen(nodeServer, nodePipe);
    assert.equal(nodeServer.address(), nodePipe);
    assert.equal(await requestPipe(nodePipe, "canonical"), "node:canonical");
  } finally {
    await close(nodeServer);
  }

  const unixPath = `.cottontail-http-${suffix}.sock`;
  const bunServer = Bun.serve({
    unix: unixPath,
    async fetch(incoming) {
      return new Response(`bun:${await incoming.text()}`);
    },
  });
  try {
    assert.equal(bunServer.address, unixPath);
    assert.equal(bunServer.hostname, undefined);
    assert.equal(bunServer.port, undefined);
    assert.equal(bunServer.url.href, `unix://${unixPath}`);

    for (const body of ["fetch-one", "fetch-two"]) {
      const response = await deadline(fetch("http://localhost/pipe", {
        method: "POST",
        body,
        unix: unixPath,
      } as RequestInit & { unix: string }), `fetch ${body}`);
      assert.equal(await response.text(), `bun:${body}`);
    }
    assert.equal(await requestPipe(unixPath, "node-http"), "bun:node-http");
  } finally {
    await bunServer.stop(true);
  }

  const bunPipe = `\\\\.\\pipe\\cottontail-bun-http-${suffix}`;
  const bunPipeServer = Bun.serve({
    unix: bunPipe,
    fetch() {
      return new Response("canonical bun pipe");
    },
  });
  try {
    assert.equal(bunPipeServer.address, bunPipe);
    const response = await deadline(fetch("http://localhost/", {
      unix: bunPipe,
    } as RequestInit & { unix: string }), "canonical Bun pipe fetch");
    assert.equal(await response.text(), "canonical bun pipe");
  } finally {
    await bunPipeServer.stop(true);
  }

  assert.throws(
    () => Bun.serve({
      unix: `C:\\cottontail-not-found-${suffix}\\server.sock`,
      fetch: () => new Response("unreachable"),
    }),
    (error: NodeJS.ErrnoException) => error?.code === "ENOENT",
  );
  assert.throws(
    () => Bun.serve({
      unix: "x".repeat(260),
      fetch: () => new Response("unreachable"),
    }),
    (error: NodeJS.ErrnoException) => error?.code === "ENAMETOOLONG",
  );
}

console.log("windows http named pipe passed");
