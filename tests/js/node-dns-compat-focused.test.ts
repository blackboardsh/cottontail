import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createSocket } from "node:dgram";
import * as dns from "node:dns";
import * as dnsPromises from "node:dns/promises";

const originalServers = dns.getServers();

const recordTypes = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  NAPTR: 35,
  TLSA: 52,
  CAA: 257,
  ANY: 255,
} as const;

function encodeName(name: string) {
  return Buffer.concat([
    ...name.split(".").filter(Boolean).map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);
}

function questionEnd(query: Buffer) {
  let offset = 12;
  while (query[offset] !== 0) offset += query[offset] + 1;
  return offset + 5;
}

function answer(type: number, data: Buffer, ttl = 123) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0xc00c, 0);
  header.writeUInt16BE(type, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt32BE(ttl, 6);
  header.writeUInt16BE(data.length, 10);
  return Buffer.concat([header, data]);
}

function dnsResponse(query: Buffer, answers: Buffer[]) {
  const end = questionEnd(query);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  return Buffer.concat([header, query.subarray(12, end), ...answers]);
}

function characterString(value: string) {
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

function recordData(type: number) {
  if (type === recordTypes.A) return Buffer.from([192, 0, 2, 42]);
  if (type === recordTypes.AAAA) return Buffer.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 42]);
  if (type === recordTypes.NS) return encodeName("ns.example.test");
  if (type === recordTypes.CNAME) return encodeName("alias.example.test");
  if (type === recordTypes.PTR) return encodeName("ptr.example.test");
  if (type === recordTypes.MX) {
    const priority = Buffer.alloc(2);
    priority.writeUInt16BE(10);
    return Buffer.concat([priority, encodeName("mail.example.test")]);
  }
  if (type === recordTypes.TXT) return Buffer.concat([characterString("first"), characterString("second")]);
  if (type === recordTypes.SOA) {
    const numbers = Buffer.alloc(20);
    [1, 2, 3, 4, 5].forEach((value, index) => numbers.writeUInt32BE(value, index * 4));
    return Buffer.concat([encodeName("ns.example.test"), encodeName("hostmaster.example.test"), numbers]);
  }
  if (type === recordTypes.SRV) {
    const values = Buffer.alloc(6);
    values.writeUInt16BE(1, 0);
    values.writeUInt16BE(2, 2);
    values.writeUInt16BE(443, 4);
    return Buffer.concat([values, encodeName("service.example.test")]);
  }
  if (type === recordTypes.NAPTR) {
    const values = Buffer.alloc(4);
    values.writeUInt16BE(1, 0);
    values.writeUInt16BE(12, 2);
    return Buffer.concat([
      values,
      characterString("S"),
      characterString("SIP+D2U"),
      characterString(""),
      encodeName("replacement.example.test"),
    ]);
  }
  if (type === recordTypes.CAA) return Buffer.concat([Buffer.from([128, 5]), Buffer.from("issueca.example")]);
  if (type === recordTypes.TLSA) return Buffer.from([3, 1, 1, 0xde, 0xad, 0xbe, 0xef]);
  throw new Error(`Unsupported test record type: ${type}`);
}

async function createDnsServer() {
  const server = createSocket("udp4");
  server.on("message", (query, remote) => {
    const end = questionEnd(query);
    const requestedType = query.readUInt16BE(end - 4);
    const types = requestedType === recordTypes.ANY
      ? [recordTypes.A, recordTypes.AAAA, recordTypes.MX, recordTypes.NS, recordTypes.TXT, recordTypes.PTR,
        recordTypes.SOA, recordTypes.CAA, recordTypes.CNAME, recordTypes.SRV, recordTypes.NAPTR, recordTypes.TLSA]
      : [requestedType];
    server.send(dnsResponse(query, types.map(type => answer(type, recordData(type)))), remote.port, remote.address);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.bind(0, "127.0.0.1", resolve);
  });
  return server;
}

afterEach(() => {
  dns.setServers(originalServers);
});

test("setServers skips holes, observes shrinking arrays, and canonicalizes default ports", () => {
  const sparse: string[] = [];
  sparse[0] = "127.0.0.1";
  sparse[2] = "0.0.0.0";
  dns.setServers(sparse);
  expect(dns.getServers()).toEqual(["127.0.0.1", "0.0.0.0"]);

  const shrinking = ["127.0.0.1", "192.168.1.1", "unused", "127.1.0.1"];
  Object.defineProperty(shrinking, 2, {
    enumerable: true,
    get() {
      shrinking.length = 3;
      return "0.0.0.0";
    },
  });
  dns.setServers(shrinking);
  expect(dns.getServers()).toEqual(["127.0.0.1", "192.168.1.1", "0.0.0.0"]);

  dns.setServers(["4.4.4.4:53", "[2001:4860:4860::8888]:53", "[fe80::1]:666", "[fe80::1]"]);
  expect(dns.getServers()).toEqual(["4.4.4.4", "2001:4860:4860::8888", "[fe80::1]:666", "fe80::1"]);
});

test("setServers rejects invalid input without mutating resolver state", () => {
  dns.setServers(["8.8.8.8", "8.8.4.4"]);
  assert.throws(() => dns.setServers(["127.0.0.1:bad"]), {
    name: "TypeError",
    code: "ERR_INVALID_IP_ADDRESS",
    message: "Invalid IP address: 127.0.0.1:bad",
  });
  expect(dns.getServers()).toEqual(["8.8.8.8", "8.8.4.4"]);
});

test("lookup validates hostnames, hints, family, and callbacks synchronously", () => {
  const invalidHostname = { name: "TypeError", code: "ERR_INVALID_ARG_TYPE" };
  assert.throws(() => dns.lookup({} as never, () => {}), invalidHostname);
  assert.throws(() => dnsPromises.lookup({} as never), invalidHostname);

  const hints = dns.V4MAPPED | dns.ADDRCONFIG | dns.ALL | 1;
  assert.throws(() => dns.lookup("nodejs.org", { hints }, () => {}), {
    name: "TypeError",
    code: "ERR_INVALID_ARG_VALUE",
  });
  assert.throws(() => dnsPromises.lookup("nodejs.org", { hints }), {
    name: "TypeError",
    code: "ERR_INVALID_ARG_VALUE",
  });
  assert.throws(() => dns.lookup("", { family: "invalid" as never }, () => {}), {
    name: "TypeError",
    code: "ERR_INVALID_ARG_TYPE",
  });
  assert.throws(() => dns.lookup("nodejs.org"), {
    name: "TypeError",
    code: "ERR_INVALID_ARG_TYPE",
  });
});

test("resolve and lookupService expose synchronous Node argument errors", () => {
  assert.throws(() => dns.resolve("example.com", [] as never, () => {}), {
    name: "TypeError",
    code: "ERR_INVALID_ARG_TYPE",
  });
  assert.throws(() => dnsPromises.resolve(), {
    name: "TypeError",
    code: "ERR_INVALID_ARG_TYPE",
  });
  assert.throws(() => dns.lookupService("0.0.0.0"), {
    name: "TypeError",
    code: "ERR_MISSING_ARGS",
    message: 'The "address", "port", and "callback" arguments must be specified',
  });
  assert.throws(() => dnsPromises.lookupService("0.0.0.0"), {
    name: "TypeError",
    code: "ERR_MISSING_ARGS",
    message: 'The "address" and "port" arguments must be specified',
  });
});

test("falsey lookup values retain the deprecated null-address result", async () => {
  for (const hostname of ["", null, undefined, 0, Number.NaN]) {
    expect(await dnsPromises.lookup(hostname as never)).toEqual({ address: null, family: 4 });
  }
});

test("resolve4 queries a selected non-default UDP resolver", async () => {
  const server = createSocket("udp4");
  server.on("message", (query, remote) => {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(query.readUInt16BE(0), 0);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(1, 6);

    const answer = Buffer.alloc(16);
    answer.writeUInt16BE(0xc00c, 0);
    answer.writeUInt16BE(1, 2);
    answer.writeUInt16BE(1, 4);
    answer.writeUInt32BE(42, 6);
    answer.writeUInt16BE(4, 10);
    answer.set([192, 0, 2, 42], 12);
    server.send(Buffer.concat([header, query.subarray(12), answer]), remote.port, remote.address);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.bind(0, "127.0.0.1", resolve);
  });

  try {
    dns.setServers([`127.0.0.1:${server.address().port}`]);
    expect(await dnsPromises.resolve4("example.test", { ttl: true })).toEqual([
      { address: "192.0.2.42", ttl: 42 },
    ]);
  } finally {
    server.close();
  }
});

test("selected resolvers decode every Node DNS record shape", async () => {
  const server = await createDnsServer();
  const resolver = new dnsPromises.Resolver();
  resolver.setServers([`127.0.0.1:${server.address().port}`]);

  try {
    expect(await resolver.resolve4("example.test", { ttl: true })).toEqual([{ address: "192.0.2.42", ttl: 123 }]);
    expect(await resolver.resolve6("example.test", { ttl: true })).toEqual([{ address: "2001:db8::2a", ttl: 123 }]);
    expect(await resolver.resolveMx("example.test")).toEqual([{ exchange: "mail.example.test", priority: 10 }]);
    expect(await resolver.resolveNs("example.test")).toEqual(["ns.example.test"]);
    expect(await resolver.resolveCname("example.test")).toEqual(["alias.example.test"]);
    expect(await resolver.resolvePtr("example.test")).toEqual(["ptr.example.test"]);
    expect(await resolver.resolveTxt("example.test")).toEqual([["first", "second"]]);
    expect(await resolver.resolveSoa("example.test")).toEqual({
      nsname: "ns.example.test",
      hostmaster: "hostmaster.example.test",
      serial: 1,
      refresh: 2,
      retry: 3,
      expire: 4,
      minttl: 5,
    });
    expect(await resolver.resolveSrv("example.test")).toEqual([{
      priority: 1,
      weight: 2,
      port: 443,
      name: "service.example.test",
    }]);
    expect(await resolver.resolveNaptr("example.test")).toEqual([{
      flags: "S",
      service: "SIP+D2U",
      regexp: "",
      replacement: "replacement.example.test",
      order: 1,
      preference: 12,
    }]);
    expect(await resolver.resolveCaa("example.test")).toEqual([{ critical: 128, issue: "ca.example" }]);
    const tlsa = await resolver.resolveTlsa("example.test");
    expect(tlsa[0]).toMatchObject({ certUsage: 3, selector: 1, match: 1 });
    expect(Array.from(new Uint8Array(tlsa[0].data))).toEqual([0xde, 0xad, 0xbe, 0xef]);

    const any = await resolver.resolveAny("example.test");
    expect(any).toContainEqual({ type: "A", address: "192.0.2.42", ttl: 123 });
    expect(any).toContainEqual({ type: "AAAA", address: "2001:db8::2a", ttl: 123 });
    expect(any).toContainEqual({ type: "TXT", entries: ["first", "second"] });
    expect(any).toContainEqual({ type: "CAA", critical: 128, issue: "ca.example" });
  } finally {
    server.close();
  }
});

test("Resolver cancellation aborts pending selected-server queries", async () => {
  const server = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.bind(0, "127.0.0.1", resolve);
  });
  const resolver = new dnsPromises.Resolver({ timeout: 10_000, tries: 2 });
  resolver.setServers([`127.0.0.1:${server.address().port}`]);
  resolver.setLocalAddress("127.0.0.1");
  server.once("message", (_query, remote) => {
    expect(remote.address).toBe("127.0.0.1");
    resolver.cancel();
  });

  try {
    await expect(resolver.resolve4("cancel.example.test")).rejects.toMatchObject({
      code: "ECANCELLED",
      syscall: "queryA",
      hostname: "cancel.example.test",
    });

    server.once("message", () => resolver.cancel());
    await expect(resolver.reverse("123.45.67.89")).rejects.toMatchObject({
      code: "ECANCELLED",
      syscall: "getHostByAddr",
      hostname: "123.45.67.89",
    });
  } finally {
    server.close();
  }
});

test("Resolver validates local addresses and constructor options", () => {
  const resolver = new dns.Resolver();
  resolver.setLocalAddress("127.0.0.1");
  resolver.setLocalAddress("::1");
  resolver.setLocalAddress("127.0.0.1", "::1");
  assert.throws(() => resolver.setLocalAddress("127.0.0.1", "127.0.0.1"));
  assert.throws(() => resolver.setLocalAddress("bad"));
  assert.throws(() => resolver.setLocalAddress(123 as never), { code: "ERR_INVALID_ARG_TYPE" });
  assert.throws(() => new dns.Resolver({ timeout: -2 }), { code: "ERR_OUT_OF_RANGE" });
  assert.throws(() => new dnsPromises.Resolver({ tries: 0 }), { code: "ERR_OUT_OF_RANGE" });
});
