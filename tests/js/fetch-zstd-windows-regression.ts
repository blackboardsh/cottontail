import { createServer } from "node:http";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

if (process.platform !== "win32") {
  console.log("fetch zstd Windows regression skipped");
} else {
  const fixtureText = "hello cottontail zstd regression probe";
  const fixture = Buffer.from(
    "KLUv/SAmMQEAaGVsbG8gY290dG9udGFpbCB6c3RkIHJlZ3Jlc3Npb24gcHJvYmU=",
    "base64",
  );
  const text = "cottontail zstd response body\n".repeat(1_024);
  const payload = Buffer.from(text);
  const frameMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

  assert(fixture.subarray(0, frameMagic.length).equals(frameMagic), "zstd fixture has invalid frame magic");
  assert(zstdDecompressSync(fixture).toString() === fixtureText, "known zstd fixture did not decode");

  const compressed = zstdCompressSync(payload);
  assert(compressed.subarray(0, frameMagic.length).equals(frameMagic), "zstd compressor emitted an invalid frame");
  assert(zstdDecompressSync(compressed).equals(payload), "zstd frame did not round trip");
  console.log("zstd round trip passed");

  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-encoding": "zstd",
      "content-length": compressed.byteLength,
      "content-type": "text/plain; charset=utf-8",
    });
    response.end(compressed);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert(address != null && typeof address !== "string", "HTTP server did not bind to a TCP port");

    const response = await fetch(`http://127.0.0.1:${address.port}/zstd`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert(response.headers.get("content-encoding") === "zstd", "fetch discarded the Content-Encoding header");
    assert((await response.text()) === text, "fetch did not decode the zstd response body");
    assert(response.bodyUsed, "fetch response body was not marked as consumed");
    console.log("fetch zstd Windows regression passed");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error == null ? resolve() : reject(error)));
    });
  }
}
