import { dns } from "bun";
import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";

describe("dns.prefetch", () => {
  it("should prefetch", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("HTTP test server did not bind a TCP port");
    }

    try {
      const currentStats = dns.getCacheStats();
      dns.prefetch("localhost", address.port);
      await Bun.sleep(32);

      // Must set keepalive: false to ensure it doesn't reuse the socket.
      await fetch(`http://localhost:${address.port}`, { method: "HEAD", redirect: "manual", keepalive: false });
      const newStats = dns.getCacheStats();
      expect(currentStats).not.toEqual(newStats);
      if (
        newStats.cacheHitsCompleted > currentStats.cacheHitsCompleted ||
        newStats.cacheHitsInflight > currentStats.cacheHitsInflight
      ) {
        expect().pass();
      } else {
        expect().fail("dns.prefetch should have prefetched");
      }

      // Must set keepalive: false to ensure it doesn't reuse the socket.
      await fetch(`http://localhost:${address.port}`, { method: "HEAD", redirect: "manual", keepalive: false });
      const newStats2 = dns.getCacheStats();
      // Ensure it's cached.
      expect(newStats2.cacheHitsCompleted).toBeGreaterThan(currentStats.cacheHitsCompleted);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
