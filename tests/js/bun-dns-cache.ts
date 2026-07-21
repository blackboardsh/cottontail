import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { dns as bunDns } from "bun";
import * as dns from "node:dns";
import { createServer } from "node:http";

const cacheBeforeDirectLookups = bunDns.getCacheStats();
throws(
  () => bunDns.lookup(undefined as never),
  (error: Error & { code?: string }) => error.code === "ERR_INVALID_ARG_TYPE" && /hostname to be a string/.test(error.message),
  "Bun.dns.lookup should require a hostname string",
);
throws(
  () => bunDns.lookup(""),
  (error: Error & { code?: string }) => error.code === "ERR_INVALID_ARG_TYPE" && /non-empty string/.test(error.message),
  "Bun.dns.lookup should reject an empty hostname",
);
throws(
  () => bunDns.lookup("localhost", "IPv4" as never),
  /InvalidOptions/,
  "Bun.dns.lookup should reject string options",
);
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
const lowercaseFamilyLookup = await bunDns.lookup("localhost", { backend: "getaddrinfo", family: "ipv4" as never });
ok(lowercaseFamilyLookup.every((record) => record.family === 4), "Bun DNS should accept its lowercase IPv4 alias");
const caresAliasLookup = await bunDns.lookup("localhost", { backend: "cares" as never });
ok(caresAliasLookup.length > 0, "Bun DNS should accept its c-ares backend alias");
throws(
  () => bunDns.lookup("localhost", { socketType: "UDP" as never }),
  /InvalidSocketType/,
  "Bun DNS should validate socketType",
);
throws(
  () => bunDns.lookup("localhost", { flags: 1 } as never),
  (error: Error & { code?: string }) => error.code === "ERR_INVALID_ARG_VALUE",
  "Bun DNS should validate address-info flags",
);
throws(
  () => bunDns.lookup("localhost", { port: 65536 } as never),
  (error: Error & { code?: string }) => error.code === "ERR_SOCKET_BAD_PORT",
  "Bun DNS should validate lookup ports",
);
throws(
  () => bunDns.prefetch("localhost", 1.5),
  (error: Error & { code?: string }) => error.code === "ERR_INVALID_ARG_TYPE" && /integer/.test(error.message),
  "Bun DNS prefetch should require an integer port",
);
deepStrictEqual(
  bunDns.getCacheStats(),
  cacheBeforeDirectLookups,
  "direct Node and Bun DNS lookups should not enter the network connection cache",
);

const server = createServer((_request, response) => {
  response.writeHead(204);
  response.end();
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (address == null || typeof address === "string") throw new Error("HTTP test server did not bind a TCP port");

try {
  const before = bunDns.getCacheStats();
  deepStrictEqual(
    Object.keys(before),
    ["cacheHitsCompleted", "cacheHitsInflight", "cacheMisses", "size", "errors", "totalCount"],
    "Bun DNS cache stats should expose Bun's counter shape",
  );

  bunDns.prefetch("localhost", address.port);
  const prefetched = bunDns.getCacheStats();
  strictEqual(prefetched.cacheMisses, before.cacheMisses + 1, "prefetch should populate a missing cache entry");
  strictEqual(prefetched.totalCount, before.totalCount + 1, "prefetch should count one resolver request");

  await fetch(`http://localhost:${address.port}`, { keepalive: false });
  const fetched = bunDns.getCacheStats();
  strictEqual(fetched.cacheHitsCompleted, prefetched.cacheHitsCompleted + 1, "fetch should consume the prefetched address");
  strictEqual(fetched.totalCount, prefetched.totalCount + 1, "fetch should count one cache lookup");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log("bun dns cache passed");
