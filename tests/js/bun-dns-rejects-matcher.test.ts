import { dns } from "bun";
import { expect, test } from "bun:test";

test("Bun.dns errors match object subsets directly", async () => {
  try {
    await dns.lookup("adsfa.asdfasdf.asdf.com", { backend: "system" });
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({
      code: "DNS_ENOTFOUND",
      name: "DNSException",
    });
  }
});

test("Bun.dns lookup rejects with Bun's DNSException shape", async () => {
  await expect(dns.lookup("adsfa.asdfasdf.asdf.com", { backend: "system" })).rejects.toMatchObject({
    code: "DNS_ENOTFOUND",
    name: "DNSException",
  });
});

test("Bun.dns rejections are consumed by a basic rejects matcher", () => {
  expect(dns.lookup("adsfa.asdfasdf.asdf.com", { backend: "system" })).rejects.toBeDefined();
});

test("unawaited rejects matchers participate in the active test", () => {
  expect(dns.lookup("adsfa.asdfasdf.asdf.com", { backend: "system" })).rejects.toMatchObject({
    code: "DNS_ENOTFOUND",
    name: "DNSException",
  });
});
