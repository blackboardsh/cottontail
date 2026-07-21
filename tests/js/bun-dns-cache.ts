import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { dns as bunDns } from "bun";
import * as dns from "node:dns";
import { createSocket } from "node:dgram";
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

function encodeDnsName(name: string) {
  return Buffer.concat([
    ...name.split(".").filter(Boolean).map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);
}

function dnsQuestionEnd(query: Buffer) {
  let offset = 12;
  while (query[offset] !== 0) offset += query[offset] + 1;
  return offset + 5;
}

function dnsQuestionName(query: Buffer) {
  const labels = [];
  let offset = 12;
  while (query[offset] !== 0) {
    const length = query[offset++];
    labels.push(query.subarray(offset, offset + length).toString());
    offset += length;
  }
  return labels.join(".");
}

function dnsAnswer(type: number, data: Buffer, ttl = 45) {
  const answer = Buffer.alloc(12);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(type, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(ttl, 6);
  answer.writeUInt16BE(data.length, 10);
  return Buffer.concat([answer, data]);
}

function dnsResponse(query: Buffer, answers: Buffer[], responseCode = 0) {
  const questionEnd = dnsQuestionEnd(query);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180 | responseCode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  return Buffer.concat([header, query.subarray(12, questionEnd), ...answers]);
}

const dnsServer = createSocket("udp4");
dnsServer.on("message", (query, remote) => {
  const type = query.readUInt16BE(dnsQuestionEnd(query) - 4);
  let answer;
  if (type === 1) answer = dnsAnswer(type, Buffer.from([192, 0, 2, 10]));
  else if (type === 12) answer = dnsAnswer(type, encodeDnsName("ptr.fixture.test"));
  else if (type === 16) answer = dnsAnswer(type, Buffer.concat([Buffer.from([7]), Buffer.from("fixture")]));
  const missing = dnsQuestionName(query) === "missing.fixture.test";
  dnsServer.send(dnsResponse(query, missing || answer == null ? [] : [answer], missing ? 3 : 0), remote.port, remote.address);
});
await new Promise<void>((resolve, reject) => {
  dnsServer.once("error", reject);
  dnsServer.bind(0, "127.0.0.1", resolve);
});

const originalDnsServers = dns.getServers();
try {
  deepStrictEqual(Object.keys(bunDns), [
    "lookup", "resolve", "resolveSrv", "resolveTxt", "resolveSoa", "resolveNaptr", "resolveMx", "resolveCaa",
    "resolveNs", "resolvePtr", "resolveCname", "resolveAny", "getServers", "setServers", "reverse",
    "lookupService", "prefetch", "getCacheStats", "ADDRCONFIG", "ALL", "V4MAPPED",
  ]);
  throws(() => bunDns.setServers(["127.0.0.1"] as never), {
    name: "TypeError",
    code: "ERR_INVALID_ARG_TYPE",
  });

  const dnsPort = dnsServer.address().port;
  strictEqual(bunDns.setServers([[4, "127.0.0.1", dnsPort]]), undefined);
  deepStrictEqual(bunDns.getServers(), [`127.0.0.1:${dnsPort}`]);

  const addressPromise = bunDns.resolve("fixture.test", "A");
  ok(addressPromise instanceof Promise, "Bun.dns.resolve should return a promise");
  deepStrictEqual(await addressPromise, [{ address: "192.0.2.10", ttl: 45 }]);
  deepStrictEqual(await bunDns.resolveTxt("fixture.test"), [["fixture"]]);
  deepStrictEqual(await bunDns.reverse("192.0.2.10"), ["ptr.fixture.test"]);

  const service = await bunDns.lookupService("127.0.0.1", 80);
  strictEqual(service[0], "localhost");
  strictEqual(service[1], "http");

  await bunDns.resolve("missing.fixture.test", "A").then(
    () => { throw new Error("missing DNS name should reject"); },
    (error) => {
      strictEqual(error.name, "DNSException");
      strictEqual(error.code, "DNS_ENOTFOUND");
      strictEqual(error.syscall, "queryA");
      strictEqual(error.hostname, "missing.fixture.test");
    },
  );
} finally {
  dns.setServers(originalDnsServers);
  dnsServer.close();
}

console.log("bun dns cache passed");
