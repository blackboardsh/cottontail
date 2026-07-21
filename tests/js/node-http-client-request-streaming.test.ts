import { expect, test } from "bun:test";
import http from "node:http";

test("ClientRequest streams chunked request bodies before end", async () => {
  let resolveFirstChunk: (value: Uint8Array) => void;
  const firstChunk = new Promise<Uint8Array>(resolve => {
    resolveFirstChunk = resolve;
  });

  const server = http.createServer((request, response) => {
    const chunks: Uint8Array[] = [];
    request.on("data", chunk => {
      chunks.push(chunk);
      if (chunks.length === 1) resolveFirstChunk(chunk);
    });
    request.once("end", () => response.end(Buffer.concat(chunks)));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("HTTP server did not bind a TCP address");

  try {
    const response = new Promise<string>((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${address.port}`, { method: "POST" }, incoming => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", chunk => chunks.push(chunk));
        incoming.once("end", () => resolve(Buffer.concat(chunks).toString()));
      });
      request.once("error", reject);
      request.write("first");

      firstChunk.then(chunk => {
        expect(Buffer.from(chunk).toString()).toBe("first");
        request.end("second");
      }, reject);
    });

    expect(await response).toBe("firstsecond");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
