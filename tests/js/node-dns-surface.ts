import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
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

dns.setServers(["127.0.0.1", "127.0.0.1:53", "[::1]:53"]);
deepStrictEqual(dns.getServers(), ["127.0.0.1", "127.0.0.1", "::1"], "dns getServers mismatch");
try {
  dns.setServers(["not-an-ip"]);
  throw new Error("dns.setServers invalid server should throw");
} catch (error) {
  strictEqual((error as Error & { code?: string }).code, "ERR_INVALID_IP_ADDRESS", "dns.setServers invalid server code mismatch");
}
dns.setServers(["127.0.0.1"]);
const isolatedResolver = new dns.Resolver();
isolatedResolver.setServers(["8.8.8.8"]);
deepStrictEqual(isolatedResolver.getServers(), ["8.8.8.8"], "dns Resolver local servers mismatch");
deepStrictEqual(dns.getServers(), ["127.0.0.1"], "dns Resolver setServers should not mutate global servers");
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

const service = await dnsPromises.lookupService("127.0.0.1", 80);
ok(service.hostname.length > 0, "dns lookupService should return hostname");
ok(service.service.length > 0, "dns lookupService should return service");

const reverse = await dnsPromises.reverse("127.0.0.1");
ok(reverse.length > 0, "dns reverse should return at least one hostname");

const resolver = new dns.Resolver();
deepStrictEqual(resolver.getServers(), [], "dns Resolver should copy the configured global server list");

const promiseResolver = new dnsPromises.Resolver();
promiseResolver.setServers(["1.1.1.1"]);
deepStrictEqual(promiseResolver.getServers(), ["1.1.1.1"], "dns promises Resolver local servers mismatch");

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
