import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { dns as bunDns } from "bun";
import * as dns from "node:dns";

const localhost4 = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
  dns.lookup("localhost", { all: true, family: "IPv4" }, (error, records) => {
    if (error) reject(error);
    else resolve(records);
  });
});
ok(localhost4.length > 0, "IPv4 localhost lookup should return records");
ok(localhost4.every((record) => record.family === 4), "IPv4 family normalization should filter records");

throws(
  () => dns.lookup("localhost", "IPv4" as never, () => {}),
  (error: Error & { code?: string }) => error.code === "ERR_INVALID_ARG_TYPE",
  "Node lookup should reject a string options shorthand",
);
throws(
  () => bunDns.lookup("localhost", { backend: "invalid" } as never),
  /InvalidBackend/,
  "Bun.dns.lookup should validate backend",
);
throws(
  () => bunDns.lookup("localhost", { family: 5 } as never),
  /InvalidFamily/,
  "Bun.dns.lookup should validate family",
);

const bunLookup = await bunDns.lookup("localhost", { backend: "system", family: "IPv4" });
ok(bunLookup.length > 0, "Bun.dns.lookup should return localhost records");
ok(bunLookup.every((record) => record.family === 4 && Number.isInteger(record.ttl)), "Bun DNS records should include family and TTL");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    return new Response(null, { status: 204 });
  },
});

try {
  const before = bunDns.getCacheStats();
  deepStrictEqual(
    Object.keys(before),
    ["cacheHitsCompleted", "cacheHitsInflight", "cacheMisses", "size", "errors", "totalCount"],
    "Bun DNS cache stats should expose Bun's counter shape",
  );

  bunDns.prefetch("localhost", server.port);
  const prefetched = bunDns.getCacheStats();
  strictEqual(prefetched.cacheMisses, before.cacheMisses + 1, "prefetch should populate a missing cache entry");
  strictEqual(prefetched.totalCount, before.totalCount + 1, "prefetch should count one resolver request");

  await fetch(`http://localhost:${server.port}`, { keepalive: false });
  const fetched = bunDns.getCacheStats();
  strictEqual(fetched.cacheHitsCompleted, prefetched.cacheHitsCompleted + 1, "fetch should consume the prefetched address");
  strictEqual(fetched.totalCount, prefetched.totalCount + 1, "fetch should count one cache lookup");
} finally {
  server.stop(true);
}

console.log("bun dns cache passed");
