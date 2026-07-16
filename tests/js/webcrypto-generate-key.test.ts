import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;

async function expectRejection(name: string, operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error: any) {
    strictEqual(error?.name, name);
    return;
  }
  throw new Error(`Expected ${name}`);
}

await expectRejection("NotSupportedError", () => subtle.generateKey("AES", true, []));
await expectRejection("TypeError", () => subtle.generateKey({} as any, true, []));
await expectRejection("NotSupportedError", () =>
  subtle.generateKey({ name: "HMAC", hash: "MD5" }, true, ["sign"]));
await expectRejection("OperationError", () =>
  subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 7 }, true, ["sign"]));
await expectRejection("OperationError", () =>
  subtle.generateKey({ name: "AES-GCM", length: 127 }, true, ["encrypt"]));
await expectRejection("SyntaxError", () =>
  subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["sign"] as any));
await expectRejection("OperationError", () =>
  subtle.generateKey({ name: "AES-GCM", length: 127 }, true, []));
await expectRejection("SyntaxError", () =>
  subtle.generateKey({ name: "AES-GCM", length: 128 }, true, []));
await expectRejection("NotSupportedError", () =>
  subtle.generateKey({ name: "ECDSA", namedCurve: "P-512" }, true, ["sign"]));
await expectRejection("OperationError", () =>
  subtle.generateKey({
    name: "RSA-PSS",
    modulusLength: 512,
    publicExponent: new Uint8Array([1, 0, 0]),
    hash: "SHA-256",
  }, true, ["sign"]));
await expectRejection("SyntaxError", () =>
  subtle.generateKey({
    name: "RSA-PSS",
    modulusLength: 512,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["verify"]));
await expectRejection("TypeError", () =>
  subtle.generateKey({ name: "AES-GCM", length: 128 }, true, undefined as any));
await expectRejection("TypeError", () =>
  subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["bogus"] as any));

const aes = await subtle.generateKey(
  { name: "aes-gcm", length: 128 },
  false,
  ["decrypt", "encrypt", "decrypt"],
);
strictEqual(aes.algorithm.name, "AES-GCM");
strictEqual(aes.extractable, false);
deepStrictEqual(aes.usages, ["decrypt", "encrypt"]);

const hmac = await subtle.generateKey({ name: "hmac", hash: "sha-512" }, true, ["verify", "sign", "verify"]);
strictEqual(hmac.algorithm.name, "HMAC");
strictEqual(hmac.algorithm.hash.name, "SHA-512");
strictEqual(hmac.algorithm.length, 1024);
deepStrictEqual(hmac.usages, ["verify", "sign"]);

const ecdsa = await subtle.generateKey(
  { name: "ecdsa", namedCurve: "P-256" },
  false,
  ["sign", "verify", "sign"],
);
deepStrictEqual(ecdsa.publicKey.usages, ["verify"]);
deepStrictEqual(ecdsa.privateKey.usages, ["sign"]);
strictEqual(ecdsa.publicKey.extractable, true);
strictEqual(ecdsa.privateKey.extractable, false);

const rsassa = await subtle.generateKey({
  name: "rsassa-pkcs1-v1_5",
  modulusLength: 512,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "sha-256",
}, true, ["sign"]);
strictEqual(rsassa.publicKey.algorithm.name, "RSASSA-PKCS1-v1_5");
deepStrictEqual(Array.from(rsassa.publicKey.algorithm.publicExponent), [1, 0, 1]);
deepStrictEqual(rsassa.publicKey.usages, []);
deepStrictEqual(rsassa.privateKey.usages, ["sign"]);

const ed25519 = await subtle.generateKey("ed25519", true, ["sign", "verify", "sign"]);
strictEqual(ed25519.publicKey.algorithm.name, "Ed25519");
deepStrictEqual(ed25519.publicKey.usages, ["verify"]);
deepStrictEqual(ed25519.privateKey.usages, ["sign"]);

const x25519 = await subtle.generateKey("x25519", true, ["deriveBits", "deriveKey", "deriveBits"]);
strictEqual(x25519.publicKey.algorithm.name, "X25519");
deepStrictEqual(x25519.publicKey.usages, []);
deepStrictEqual(x25519.privateKey.usages, ["deriveKey", "deriveBits"]);

console.log("webcrypto generateKey conformance passed");
