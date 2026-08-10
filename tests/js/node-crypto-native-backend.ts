import { strictEqual } from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  privateEncrypt,
  publicDecrypt,
  publicEncrypt,
  scryptSync,
  sign,
  verify,
} from "node:crypto";

const native = (globalThis as typeof globalThis & {
  cottontail: {
    cryptoHashSync(algorithm: string, data: ArrayBufferView): ArrayBuffer;
    cryptoScryptSync(
      password: ArrayBufferView,
      salt: ArrayBufferView,
      keyLength: number,
      N: number,
      r: number,
      p: number,
      maxmem: number,
    ): ArrayBuffer;
    cryptoRsaGenerateKeyPair(modulusLength: number, publicExponent: number): object;
    cryptoRsaCrypt(...args: unknown[]): ArrayBuffer;
    cryptoEcGenerateKeyPair(curve: string): { privateKey: ArrayBuffer; publicKey: ArrayBuffer };
  };
}).cottontail;

for (const name of [
  "cryptoHashSync",
  "cryptoScryptSync",
  "cryptoRsaGenerateKeyPair",
  "cryptoRsaCrypt",
  "cryptoEcGenerateKeyPair",
] as const) {
  strictEqual(typeof native[name], "function", `${name} native binding is missing`);
}

strictEqual(
  Buffer.from(native.cryptoHashSync("md4", new Uint8Array())).toString("hex"),
  "31d6cfe0d16ae931b73c59d7e0c089c0",
  "native MD4 vector mismatch",
);
const blake2b256Empty = "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8";
let nativeBlake2b256Error: unknown;
try {
  strictEqual(
    Buffer.from(native.cryptoHashSync("blake2b256", new Uint8Array())).toString("hex"),
    blake2b256Empty,
    "native BLAKE2b-256 vector mismatch",
  );
} catch (error) {
  nativeBlake2b256Error = error;
}
if (nativeBlake2b256Error != null) {
  strictEqual(process.platform, "linux", "native BLAKE2b-256 should only require the public fallback on Linux");
  strictEqual(
    (nativeBlake2b256Error as Error).message,
    "Unsupported digest algorithm",
    "native BLAKE2b-256 failed for an unexpected reason",
  );
}
strictEqual(
  createHash("blake2b256").digest("hex"),
  blake2b256Empty,
  "node:crypto BLAKE2b-256 public fallback vector mismatch",
);

const password = new TextEncoder().encode("pass");
const salt = new TextEncoder().encode("salt");
const nativeScrypt = Buffer.from(native.cryptoScryptSync(password, salt, 32, 16, 1, 1, 32 * 1024 * 1024));
strictEqual(
  nativeScrypt.toString("hex"),
  "f7e84ff1cf9f23ac5a03ecdb61aa316b99b8ee7c9ee4157ed1493b4146efd6bd",
  "native scrypt vector mismatch",
);
strictEqual(
  scryptSync("pass", "salt", 32, { N: 16, r: 1, p: 1 }).toString("hex"),
  nativeScrypt.toString("hex"),
  "node:crypto scrypt did not match the native backend",
);

const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
const encrypted = publicEncrypt(
  { key: rsa.publicKey, oaepHash: "sha256", oaepLabel: Buffer.from("native") },
  Buffer.from("cottontail"),
);
strictEqual(
  privateDecrypt(
    { key: rsa.privateKey, oaepHash: "sha256", oaepLabel: Buffer.from("native") },
    encrypted,
  ).toString(),
  "cottontail",
  "native RSA OAEP round trip mismatch",
);
const signedPayload = privateEncrypt(rsa.privateKey, Buffer.from("native rsa"));
strictEqual(publicDecrypt(rsa.publicKey, signedPayload).toString(), "native rsa", "native RSA PKCS#1 round trip mismatch");

let oaepError: unknown;
try {
  privateDecrypt(
    { key: rsa.privateKey, oaepHash: "sha512" },
    encrypted,
  );
} catch (error) {
  oaepError = error;
}
strictEqual(oaepError instanceof Error, true, "native RSA failure should become a JavaScript Error");
strictEqual(
  (oaepError as Error & { code?: string }).code,
  "ERR_OSSL_RSA_OAEP_DECODING_ERROR",
  "native RSA OAEP failure code mismatch",
);

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const signature = sign("sha256", Buffer.from("native ec"), ec.privateKey);
strictEqual(verify("sha256", Buffer.from("native ec"), ec.publicKey, signature), true, "native P-256 signature mismatch");

console.log("node crypto native backend passed");
