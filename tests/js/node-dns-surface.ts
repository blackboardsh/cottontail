import { ok, strictEqual } from "node:assert/strict";
import { createRequire } from "node:module";
import * as dns from "node:dns";
import * as dnsPromises from "node:dns/promises";

const require = createRequire(import.meta.url);
const requiredDns = require("dns");
const requiredDnsPromises = require("node:dns/promises");

strictEqual(requiredDns.lookup, dns.lookup, "require dns lookup mismatch");
strictEqual(requiredDnsPromises.lookup, dnsPromises.lookup, "require dns/promises lookup mismatch");
strictEqual(dns.NOTFOUND, "ENOTFOUND", "dns NOTFOUND constant mismatch");
strictEqual(dns.ADDRCONFIG, 1024, "dns ADDRCONFIG constant mismatch");
strictEqual(dns.promises.lookup, dnsPromises.lookup, "dns.promises lookup mismatch");

const expectedDnsFunctions = [
  "getDefaultResultOrder",
  "getServers",
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTlsa",
  "resolveTxt",
  "reverse",
  "setDefaultResultOrder",
  "setServers",
];

for (const name of expectedDnsFunctions) {
  strictEqual(typeof (dns as Record<string, unknown>)[name], "function", `dns.${name} should be exported`);
  strictEqual(typeof (dnsPromises as Record<string, unknown>)[name], "function", `dns/promises.${name} should be exported`);
}

strictEqual(typeof dns.Resolver, "function", "dns Resolver should be exported");
strictEqual(typeof dnsPromises.Resolver, "function", "dns/promises Resolver should be exported");

const previousOrder = dns.getDefaultResultOrder();
dns.setDefaultResultOrder("ipv4first");
strictEqual(dns.getDefaultResultOrder(), "ipv4first", "dns default order setter mismatch");
dns.setDefaultResultOrder(previousOrder);

dns.setServers(["127.0.0.1"]);
strictEqual(dns.getServers()[0], "127.0.0.1", "dns getServers mismatch");
dns.setServers([]);

const lookupAll = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
  dns.lookup("localhost", { all: true, order: "ipv4first" }, (error, addresses) => {
    if (error) reject(error);
    else resolve(addresses);
  });
});
ok(lookupAll.some((record) => record.address === "127.0.0.1" && record.family === 4), "dns lookup all should include localhost IPv4");

const lookupOne = await dnsPromises.lookup("localhost", { family: 4 });
strictEqual(lookupOne.address, "127.0.0.1", "dns promises lookup IPv4 mismatch");
strictEqual(lookupOne.family, 4, "dns promises lookup family mismatch");

const resolved4 = await dnsPromises.resolve4("localhost");
ok(resolved4.includes("127.0.0.1"), "dns promises resolve4 should include localhost IPv4");

const resolved4WithTtl = await dnsPromises.resolve4("localhost", { ttl: true });
ok(resolved4WithTtl.some((record) => record.address === "127.0.0.1" && record.ttl === 0), "dns resolve4 ttl shape mismatch");

const resolvedAny = await dnsPromises.resolveAny("localhost");
ok(resolvedAny.some((record) => record.type === "A" && record.address === "127.0.0.1"), "dns resolveAny should include A record");

const service = await dnsPromises.lookupService("127.0.0.1", 80);
ok(service.hostname.length > 0, "dns lookupService should return hostname");
ok(service.service.length > 0, "dns lookupService should return service");

const reverse = await dnsPromises.reverse("127.0.0.1");
ok(reverse.length > 0, "dns reverse should return at least one hostname");

const resolver = new dns.Resolver();
const resolverAddresses = await new Promise<string[]>((resolve, reject) => {
  resolver.resolve4("localhost", (error, addresses) => {
    if (error) reject(error);
    else resolve(addresses);
  });
});
ok(resolverAddresses.includes("127.0.0.1"), "dns Resolver resolve4 mismatch");

const promiseResolver = new dnsPromises.Resolver();
const promiseResolverAddresses = await promiseResolver.resolve4("localhost");
ok(promiseResolverAddresses.includes("127.0.0.1"), "dns promises Resolver resolve4 mismatch");

try {
  dns.resolve("localhost", "BAD", () => {});
  throw new Error("dns.resolve invalid rrtype should throw");
} catch (error) {
  strictEqual((error as Error & { code?: string }).code, "ERR_INVALID_ARG_VALUE", "dns.resolve invalid rrtype code mismatch");
}

await new Promise<void>((resolve, reject) => {
  dns.resolveMx("cottontail.invalid", (error) => {
    try {
      ok(error, "dns resolveMx should return an error for .invalid names");
      strictEqual(error?.syscall, "queryMx", "dns resolveMx error syscall mismatch");
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});

await dnsPromises.resolveTxt("cottontail.invalid").then(
  () => {
    throw new Error("dns/promises resolveTxt should reject for .invalid names");
  },
  (error) => {
    strictEqual(error.syscall, "queryTxt", "dns/promises resolveTxt error syscall mismatch");
  },
);

console.log("node dns surface passed");
