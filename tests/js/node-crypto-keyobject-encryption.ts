import { ok, strictEqual, throws } from "node:assert/strict";
import {
  KeyObject,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  generateKeyPairSync,
  sign,
  verify,
  webcrypto,
} from "node:crypto";

throws(() => new (KeyObject as any)("secret", Buffer.from("secret")));

const secret = createSecretKey("secret");
strictEqual(secret.toString(), "[object KeyObject]");
strictEqual(secret.symmetricKeySize, 6);
strictEqual(secret.equals(createSecretKey("secret")), true);
strictEqual(secret.equals(createSecretKey("different")), false);
throws(() => secret.equals(0 as any), /otherKeyObject/);
strictEqual(secret.export({ format: "jwk" }).k, "c2VjcmV0");

const cryptoKey = await webcrypto.subtle.importKey("raw", Buffer.from("secret"), "HMAC", true, ["sign"]);
strictEqual(KeyObject.from(cryptoKey).equals(secret), true);

const message = Buffer.from("encrypted-key roundtrip");
const rsa = generateKeyPairSync("rsa", { modulusLength: 512 });
const encryptedPkcs1 = rsa.privateKey.export({
  type: "pkcs1",
  format: "pem",
  cipher: "aes-256-cbc",
  passphrase: "traditional secret",
});
ok(encryptedPkcs1.includes("Proc-Type: 4,ENCRYPTED"));
ok(encryptedPkcs1.includes("DEK-Info: AES-256-CBC,"));
const importedPkcs1 = createPrivateKey({ key: encryptedPkcs1, passphrase: "traditional secret" });
strictEqual(verify("sha256", message, rsa.publicKey, sign("sha256", message, importedPkcs1)), true);
throws(() => createPrivateKey({ key: encryptedPkcs1, passphrase: "wrong" }), /bad decrypt/);

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const encryptedPkcs8 = ec.privateKey.export({
  type: "pkcs8",
  format: "pem",
  cipher: "aes-128-cbc",
  passphrase: "pbes2 secret",
});
ok(encryptedPkcs8.startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----\n"));
const importedPkcs8 = createPrivateKey({ key: encryptedPkcs8, passphrase: "pbes2 secret" });
const importedPublic = createPublicKey(importedPkcs8);
strictEqual(verify("sha256", message, importedPublic, sign("sha256", message, importedPkcs8)), true);
throws(() => createPrivateKey(encryptedPkcs8), /Passphrase required/);

const encryptedPkcs8Der = ec.privateKey.export({
  type: "pkcs8",
  format: "der",
  cipher: "aes-256-cbc",
  passphrase: "der secret",
});
const importedPkcs8Der = createPrivateKey({
  key: encryptedPkcs8Der,
  type: "pkcs8",
  format: "der",
  passphrase: "der secret",
});
strictEqual(verify("sha256", message, ec.publicKey, sign("sha256", message, importedPkcs8Der)), true);

console.log("node crypto keyobject encryption passed");
