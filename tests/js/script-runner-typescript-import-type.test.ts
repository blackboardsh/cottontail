import { expect, test } from "bun:test";

test("script runner leaves TypeScript import types for the compiler", async () => {
  const certificate: import("node:crypto").X509Certificate | null = null;
  const crypto = await import("node:crypto");

  expect(certificate).toBeNull();
  expect(typeof crypto.X509Certificate).toBe("function");
});
