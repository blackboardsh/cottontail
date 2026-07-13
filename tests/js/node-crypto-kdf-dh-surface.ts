import { ok, strictEqual } from "node:assert/strict";
import * as crypto from "node:crypto";

const expectedFunctions = [
  "checkPrime",
  "checkPrimeSync",
  "argon2",
  "argon2Sync",
  "createCipheriv",
  "createDecipheriv",
  "createDiffieHellman",
  "createDiffieHellmanGroup",
  "createECDH",
  "createPrivateKey",
  "createPublicKey",
  "createSecretKey",
  "createSign",
  "createVerify",
  "decapsulate",
  "diffieHellman",
  "encapsulate",
  "generateKey",
  "generateKeyPair",
  "generateKeyPairSync",
  "generateKeySync",
  "generatePrime",
  "generatePrimeSync",
  "getCipherInfo",
  "getCiphers",
  "getCurves",
  "getDiffieHellman",
  "hkdf",
  "hkdfSync",
  "pbkdf2",
  "pbkdf2Sync",
  "privateDecrypt",
  "privateEncrypt",
  "publicDecrypt",
  "publicEncrypt",
  "scrypt",
  "scryptSync",
  "secureHeapUsed",
  "setEngine",
  "sign",
  "verify",
];

for (const name of expectedFunctions) {
  strictEqual(typeof (crypto as Record<string, unknown>)[name], "function", `crypto.${name} should be exported`);
}

strictEqual(typeof crypto.KeyObject, "function", "KeyObject class should be exported");
strictEqual(typeof crypto.Certificate, "function", "Certificate class should be exported");
strictEqual(typeof crypto.Cipheriv, "function", "Cipheriv class should be exported");
strictEqual(typeof crypto.Decipheriv, "function", "Decipheriv class should be exported");
strictEqual(typeof crypto.DiffieHellman, "function", "DiffieHellman class should be exported");
strictEqual(typeof crypto.DiffieHellmanGroup, "function", "DiffieHellmanGroup class should be exported");
strictEqual(typeof crypto.ECDH, "function", "ECDH class should be exported");
strictEqual(typeof crypto.Sign, "function", "Sign class should be exported");
strictEqual(typeof crypto.Verify, "function", "Verify class should be exported");
strictEqual(typeof crypto.X509Certificate, "function", "X509Certificate class should be exported");

function assertUnavailable(fn: () => unknown, message: string) {
  try {
    fn();
    throw new Error(`${message} should throw`);
  } catch (error) {
    ok(/unavailable|not found|Invalid|requires/i.test(String((error as Error).message)), message);
  }
}

const fixtureCertificate = `-----BEGIN CERTIFICATE-----
MIIBQzCB7gIJANAmNGVPqEmnMA0GCSqGSIb3DQEBCwUAMCkxEjAQBgNVBAMMCWxv
Y2FsaG9zdDETMBEGA1UECgwKQ290dG9udGFpbDAeFw0yNjA3MDkyMDM4MjNaFw0y
NjA3MTAyMDM4MjNaMCkxEjAQBgNVBAMMCWxvY2FsaG9zdDETMBEGA1UECgwKQ290
dG9udGFpbDBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQCxrbp6xdqZSiaRC1fTETCl
Pn710r85bO2nsZx4uSHHK8f1BOOpHyyBD2xGDfoD2yNejYA6wNxyNQitdemSR7jx
AgMBAAEwDQYJKoZIhvcNAQELBQADQQBL0kxlAffPRWvpCLV0ImWvo8iO1j3RSG4Q
UAz8KS3AJzrlgaBLeOil+VUAM5JL6pX59pP4hwG+15pwTClUlF5S
-----END CERTIFICATE-----`;

const fixtureSpkac =
  "MIG+MGowXDANBgkqhkiG9w0BAQEFAANLADBIAkEA3CVC49t2UyzFv0JdM6FI4pfXO3w3QW09cE9M2x+58p/6nBEBZP7BM79WcApX7K2MU475WN01/oO/V4CR88fGyQIDAQABFgpjb3R0b250YWlsMA0GCSqGSIb3DQEBBAUAA0EAVJjUmZQGXNpn7FVbiyp3uPmtcJd90N+OZ9UdvSHbf8oQQ87R/QiP1LK7rxymYht7MNpZtFDVDwcY6SqPJvgljA==";

const fixtureP384Certificate = `-----BEGIN CERTIFICATE-----
MIIBgjCCAQcCCQCg25+I3fvCADAKBggqhkjOPQQDAzAqMRMwEQYDVQQDDApwMzg0
LmxvY2FsMRMwEQYDVQQKDApDb3R0b250YWlsMB4XDTI2MDcwOTIyMDgyNFoXDTI2
MDcxMDIyMDgyNFowKjETMBEGA1UEAwwKcDM4NC5sb2NhbDETMBEGA1UECgwKQ290
dG9udGFpbDB2MBAGByqGSM49AgEGBSuBBAAiA2IABCnE11B6CDFBXu7yA/YnQwrr
p9cu4m2S9pjaP0+ZyYQiN610RwIThhKum1YF0hbjTDGuaIsCiBb/0ILRVTnCa4OQ
o5kDwEiSqGn3OYesNd5PaC1oP9S8phMtCZMQ9cOvrDAKBggqhkjOPQQDAwNpADBm
AjEAkvIkITCuGBxDB7M7vC1LbaL9uaAByHEbwnsKeOtxzokYDqvfA4zgNU1mu/2C
L2vdAjEAgEfm0L79YVJ/ULoLrVMQRjz7BohXvQV8pjJvUMNYYlDy/bJtlLYnVURf
xSxRGHYp
-----END CERTIFICATE-----`;

const secretKey = crypto.createSecretKey(Buffer.from("abc"));
strictEqual(secretKey.type, "secret", "secret KeyObject type mismatch");
strictEqual(secretKey.symmetricKeySize, 3, "secret KeyObject size mismatch");
strictEqual(secretKey.export().toString(), "abc", "secret KeyObject export mismatch");
strictEqual(secretKey.equals(crypto.createSecretKey("abc")), true, "secret KeyObject equality mismatch");
strictEqual(
  crypto.createHmac("sha256", secretKey).update("payload").digest("hex"),
  crypto.createHmac("sha256", "abc").update("payload").digest("hex"),
  "HMAC should accept secret KeyObject keys",
);

strictEqual(
  Buffer.from(crypto.hkdfSync("sha256", "key", "salt", "info", 16)).toString("hex"),
  "9ca0d662557439e3b83365f2da4626d3",
  "hkdfSync mismatch",
);

await new Promise<void>((resolve, reject) => {
  crypto.hkdf("sha256", "key", "salt", "info", 16, (error, key) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      strictEqual(Buffer.from(key).toString("hex"), "9ca0d662557439e3b83365f2da4626d3", "hkdf mismatch");
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});

strictEqual(
  crypto.pbkdf2Sync("pass", "salt", 1, 16, "sha256").toString("hex"),
  "65acafe9655d154ebe7ca04e8b7ebdbc",
  "pbkdf2Sync mismatch",
);

await new Promise<void>((resolve, reject) => {
  crypto.pbkdf2("pass", "salt", 1, 16, "sha256", (error, key) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      strictEqual(key.toString("hex"), "65acafe9655d154ebe7ca04e8b7ebdbc", "pbkdf2 mismatch");
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});

strictEqual(
  crypto.scryptSync("pass", "salt", 32, { N: 16, r: 1, p: 1 }).toString("hex"),
  "f7e84ff1cf9f23ac5a03ecdb61aa316b99b8ee7c9ee4157ed1493b4146efd6bd",
  "scryptSync mismatch",
);

const argon2Params = { message: "password", nonce: "1234567890123456", parallelism: 1, tagLength: 16, memory: 8, passes: 1 };
strictEqual(crypto.argon2Sync("argon2d", argon2Params).toString("hex"), "299a524ded56d1699c3f879e3168cd2d", "argon2d mismatch");
strictEqual(crypto.argon2Sync("argon2i", argon2Params).toString("hex"), "ffa1dd45e95573972998fcbde47f7bd5", "argon2i mismatch");
strictEqual(crypto.argon2Sync("argon2id", argon2Params).toString("hex"), "9ca591241a4bf1e0dd37eb15c6493918", "argon2id mismatch");

await new Promise<void>((resolve, reject) => {
  crypto.argon2("argon2id", argon2Params, (error, key) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      strictEqual(key.toString("hex"), "9ca591241a4bf1e0dd37eb15c6493918", "argon2 async mismatch");
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});

await new Promise<void>((resolve, reject) => {
  crypto.scrypt("pass", "salt", 32, { cost: 16, blockSize: 1, parallelization: 1 }, (error, key) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      strictEqual(
        key.toString("hex"),
        "f7e84ff1cf9f23ac5a03ecdb61aa316b99b8ee7c9ee4157ed1493b4146efd6bd",
        "scrypt mismatch",
      );
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});

strictEqual(crypto.checkPrimeSync(Buffer.from([17])), true, "17 should be prime");
strictEqual(crypto.checkPrimeSync(Buffer.from([21])), false, "21 should not be prime");

const generatedPrime = crypto.generatePrimeSync(8);
strictEqual(crypto.checkPrimeSync(generatedPrime), true, "generated prime should pass checkPrimeSync");

await new Promise<void>((resolve, reject) => {
  crypto.generatePrime(8, { bigint: true }, (error, prime) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      strictEqual(typeof prime, "bigint", "generatePrime bigint option mismatch");
      strictEqual(crypto.checkPrimeSync(prime), true, "async generated prime should pass checkPrimeSync");
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});

await new Promise<void>((resolve, reject) => {
  crypto.checkPrime(Buffer.from([19]), (error, isPrime) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      strictEqual(isPrime, true, "async checkPrime mismatch");
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});

const alice = crypto.createDiffieHellman(Buffer.from([23]), 5);
const bob = crypto.createDiffieHellman(alice.getPrime(), alice.getGenerator());
const alicePublic = alice.generateKeys();
const bobPublic = bob.generateKeys();
strictEqual(
  Buffer.from(alice.computeSecret(bobPublic)).toString("hex"),
  Buffer.from(bob.computeSecret(alicePublic)).toString("hex"),
  "Diffie-Hellman shared secret mismatch",
);

const generatedHmacKey = crypto.generateKeySync("hmac", { length: 128 });
strictEqual(generatedHmacKey.type, "secret", "generateKeySync hmac should return a secret key");
strictEqual(generatedHmacKey.symmetricKeySize, 16, "generateKeySync hmac key length mismatch");

await new Promise<void>((resolve, reject) => {
  crypto.generateKey("aes", { length: 128 }, (error, key) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      strictEqual(key.type, "secret", "generateKey aes should return a secret key");
      strictEqual(key.symmetricKeySize, 16, "generateKey aes length mismatch");
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});

strictEqual(Array.isArray(crypto.getCiphers()), true, "getCiphers should return an array");
ok(crypto.getCiphers().includes("aes-128-cbc"), "getCiphers should include native AES-CBC");
ok(crypto.getCiphers().includes("aes-256-gcm"), "getCiphers should include native AES-GCM");
strictEqual(crypto.getCipherInfo("aes-128-cbc")?.keyLength, 16, "getCipherInfo aes-128-cbc key length mismatch");
strictEqual(crypto.getCipherInfo("aes-256-ctr")?.ivLength, 16, "getCipherInfo aes-256-ctr iv length mismatch");
strictEqual(crypto.getCipherInfo("aes-128-gcm")?.mode, "gcm", "getCipherInfo should include supported AES-GCM");
const camelliaInfo = crypto.getCipherInfo("camellia-128-cbc");
if (camelliaInfo != null) {
  ok(crypto.getCiphers().includes("camellia-128-cbc"), "getCiphers should include native OpenSSL Camellia when available");
  strictEqual(camelliaInfo.keyLength, 16, "getCipherInfo camellia-128-cbc key length mismatch");
}

const cipherKey128 = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const cipherKey256 = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");
const cipherIv = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");

function encryptHex(algorithm: string, key: Buffer, iv: Buffer | null, text: string): string {
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("hex");
}

function decryptText(algorithm: string, key: Buffer, iv: Buffer | null, hex: string): string {
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  return Buffer.concat([decipher.update(Buffer.from(hex, "hex")), decipher.final()]).toString();
}

strictEqual(encryptHex("aes-128-cbc", cipherKey128, cipherIv, "cipher payload"), "49ac7b39d3efedfa7849e9260bc492bf", "aes-128-cbc encryption mismatch");
strictEqual(decryptText("aes-128-cbc", cipherKey128, cipherIv, "49ac7b39d3efedfa7849e9260bc492bf"), "cipher payload", "aes-128-cbc decryption mismatch");
strictEqual(encryptHex("aes-256-ctr", cipherKey256, cipherIv, "cipher payload"), "26e96b9243a03e7c1241c5205668", "aes-256-ctr encryption mismatch");
strictEqual(decryptText("aes-256-ctr", cipherKey256, cipherIv, "26e96b9243a03e7c1241c5205668"), "cipher payload", "aes-256-ctr decryption mismatch");
strictEqual(encryptHex("aes-128-cfb", cipherKey128, cipherIv, "cipher payload"), "dc0c59d6080773db86cd8c27a73f", "aes-128-cfb encryption mismatch");
strictEqual(encryptHex("aes-128-ofb", cipherKey128, cipherIv, "cipher payload"), "dc0c59d6080773db86cd8c27a73f", "aes-128-ofb encryption mismatch");
strictEqual(encryptHex("aes-128-ecb", cipherKey128, null, "sixteen byte msg"), "a5132f39dbe69b464a5cff93cf2e7d8300657ea140655a44782747705d422fad", "aes-128-ecb encryption mismatch");
if (camelliaInfo != null) {
  const camelliaEncrypted = encryptHex("camellia-128-cbc", cipherKey128, cipherIv, "cipher payload");
  strictEqual(decryptText("camellia-128-cbc", cipherKey128, cipherIv, camelliaEncrypted), "cipher payload", "camellia-128-cbc roundtrip mismatch");
}

const gcmCipher = crypto.createCipheriv("aes-256-gcm", cipherKey256, Buffer.from("0102030405060708090a0b0c", "hex"));
gcmCipher.setAAD(Buffer.from("gcm aad"));
const gcmEncrypted = Buffer.concat([gcmCipher.update("gcm payload"), gcmCipher.final()]);
const gcmTag = gcmCipher.getAuthTag();
const gcmDecipher = crypto.createDecipheriv("aes-256-gcm", cipherKey256, Buffer.from("0102030405060708090a0b0c", "hex"));
gcmDecipher.setAAD(Buffer.from("gcm aad"));
gcmDecipher.setAuthTag(gcmTag);
strictEqual(Buffer.concat([gcmDecipher.update(gcmEncrypted), gcmDecipher.final()]).toString(), "gcm payload", "aes-256-gcm roundtrip mismatch");

const chachaCipher = crypto.createCipheriv("chacha20-poly1305", cipherKey256, Buffer.from("0102030405060708090a0b0c", "hex"), { authTagLength: 16 });
const chachaEncrypted = Buffer.concat([chachaCipher.update("chacha payload"), chachaCipher.final()]);
const chachaTag = chachaCipher.getAuthTag();
const chachaDecipher = crypto.createDecipheriv("chacha20-poly1305", cipherKey256, Buffer.from("0102030405060708090a0b0c", "hex"), { authTagLength: 16 });
chachaDecipher.setAuthTag(chachaTag);
strictEqual(Buffer.concat([chachaDecipher.update(chachaEncrypted), chachaDecipher.final()]).toString(), "chacha payload", "chacha20-poly1305 roundtrip mismatch");

const noPaddingCipher = crypto.createCipheriv("aes-128-cbc", cipherKey128, cipherIv);
noPaddingCipher.setAutoPadding(false);
strictEqual(
  Buffer.concat([noPaddingCipher.update(Buffer.from("00112233445566778899aabbccddeeff", "hex")), noPaddingCipher.final()]).toString("hex"),
  "29d3d1b6edbd592b6bfb36b2d3dab5c6",
  "aes-128-cbc no-padding encryption mismatch",
);
strictEqual(Array.isArray(crypto.getCurves()), true, "getCurves should return an array");
ok(crypto.getCurves().includes("prime256v1"), "getCurves should include prime256v1");

const ecdhOne = crypto.createECDH("prime256v1");
ecdhOne.setPrivateKey(Buffer.from("0000000000000000000000000000000000000000000000000000000000000001", "hex"));
strictEqual(
  ecdhOne.getPublicKey("hex"),
  "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
  "ECDH private key 1 public key mismatch",
);
strictEqual(
  ecdhOne.getPublicKey("hex", "compressed"),
  "036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
  "ECDH compressed public key mismatch",
);
strictEqual(
  ecdhOne.getPublicKey("hex", "hybrid"),
  "076b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
  "ECDH hybrid public key mismatch",
);
const ecdhTwo = crypto.createECDH("prime256v1");
ecdhTwo.setPrivateKey(Buffer.from("0000000000000000000000000000000000000000000000000000000000000002", "hex"));
strictEqual(
  ecdhOne.computeSecret(ecdhTwo.getPublicKey()).toString("hex"),
  "7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978",
  "ECDH known shared secret mismatch",
);
strictEqual(
  ecdhTwo.computeSecret(ecdhOne.getPublicKey()).toString("hex"),
  "7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978",
  "ECDH reverse known shared secret mismatch",
);
const generatedAlice = crypto.createECDH("prime256v1");
const generatedBob = crypto.createECDH("prime256v1");
const generatedAlicePublic = generatedAlice.generateKeys();
const generatedBobPublic = generatedBob.generateKeys();
strictEqual(
  generatedAlice.computeSecret(generatedBobPublic).toString("hex"),
  generatedBob.computeSecret(generatedAlicePublic).toString("hex"),
  "ECDH generated shared secret mismatch",
);

const ecPair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
strictEqual(ecPair.privateKey.type, "private", "generateKeyPairSync ec private key type mismatch");
strictEqual(ecPair.privateKey.asymmetricKeyType, "ec", "generateKeyPairSync ec private key asymmetric type mismatch");
strictEqual(ecPair.privateKey.asymmetricKeyDetails.namedCurve, "prime256v1", "generateKeyPairSync ec curve mismatch");
strictEqual(ecPair.publicKey.type, "public", "generateKeyPairSync ec public key type mismatch");
const ecSignature = crypto.sign("sha256", Buffer.from("signed payload"), ecPair.privateKey);
strictEqual(crypto.verify("sha256", Buffer.from("signed payload"), ecPair.publicKey, ecSignature), true, "crypto.sign/verify ec mismatch");
strictEqual(crypto.verify("sha256", Buffer.from("tampered"), ecPair.publicKey, ecSignature), false, "crypto.verify should reject tampered data");

const ec384Pair = crypto.generateKeyPairSync("ec", { namedCurve: "secp384r1" });
const ec384Signature = crypto.sign("sha384", Buffer.from("signed payload"), ec384Pair.privateKey);
strictEqual(crypto.verify("sha384", Buffer.from("signed payload"), ec384Pair.publicKey, ec384Signature), true, "crypto.sign/verify secp384r1 mismatch");
const ec384P1363Signature = crypto.sign("sha384", Buffer.from("signed payload"), { key: ec384Pair.privateKey, dsaEncoding: "ieee-p1363" });
strictEqual(ec384P1363Signature.byteLength, 96, "secp384r1 ieee-p1363 signature length mismatch");
strictEqual(
  crypto.verify("sha384", Buffer.from("signed payload"), { key: ec384Pair.publicKey, dsaEncoding: "ieee-p1363" }, ec384P1363Signature),
  true,
  "crypto.sign/verify secp384r1 ieee-p1363 mismatch",
);

const secp256k1Alice = crypto.createECDH("secp256k1");
const secp256k1Bob = crypto.createECDH("secp256k1");
const secp256k1AlicePublic = secp256k1Alice.generateKeys();
const secp256k1BobPublic = secp256k1Bob.generateKeys();
strictEqual(
  secp256k1Alice.computeSecret(secp256k1BobPublic).toString("hex"),
  secp256k1Bob.computeSecret(secp256k1AlicePublic).toString("hex"),
  "secp256k1 ECDH shared secret mismatch",
);
const secp256k1Compressed = secp256k1Alice.getPublicKey(undefined, "compressed");
const secp256k1Hybrid = secp256k1Alice.getPublicKey(undefined, "hybrid");
strictEqual(secp256k1Compressed.byteLength, 33, "secp256k1 compressed public key length mismatch");
strictEqual(secp256k1Hybrid.byteLength, 65, "secp256k1 hybrid public key length mismatch");
strictEqual(
  secp256k1Bob.computeSecret(secp256k1Compressed).toString("hex"),
  secp256k1Bob.computeSecret(secp256k1Hybrid).toString("hex"),
  "secp256k1 compressed/hybrid public keys should compute the same secret",
);

const ed25519Pair = crypto.generateKeyPairSync("ed25519");
strictEqual(ed25519Pair.privateKey.type, "private", "generateKeyPairSync ed25519 private key type mismatch");
strictEqual(ed25519Pair.privateKey.asymmetricKeyType, "ed25519", "generateKeyPairSync ed25519 private key asymmetric type mismatch");
strictEqual(Object.keys(ed25519Pair.privateKey.asymmetricKeyDetails).length, 0, "generateKeyPairSync ed25519 details mismatch");
strictEqual(ed25519Pair.publicKey.type, "public", "generateKeyPairSync ed25519 public key type mismatch");
strictEqual(ed25519Pair.publicKey.asymmetricKeyType, "ed25519", "generateKeyPairSync ed25519 public key asymmetric type mismatch");
const ed25519Signature = crypto.sign(null, Buffer.from("ed25519 payload"), ed25519Pair.privateKey);
strictEqual(ed25519Signature.byteLength, 64, "Ed25519 signature length mismatch");
strictEqual(crypto.verify(null, Buffer.from("ed25519 payload"), ed25519Pair.publicKey, ed25519Signature), true, "crypto.sign/verify ed25519 mismatch");
strictEqual(crypto.verify(null, Buffer.from("tampered"), ed25519Pair.publicKey, ed25519Signature), false, "crypto.verify should reject tampered Ed25519 data");
const ed25519PrivateJwk = ed25519Pair.privateKey.export({ format: "jwk" });
const ed25519PublicJwk = ed25519Pair.publicKey.export({ format: "jwk" });
strictEqual(ed25519PrivateJwk.kty, "OKP", "private Ed25519 JWK kty mismatch");
strictEqual(ed25519PrivateJwk.crv, "Ed25519", "private Ed25519 JWK curve mismatch");
strictEqual(typeof ed25519PrivateJwk.d, "string", "private Ed25519 JWK d mismatch");
strictEqual(ed25519PublicJwk.d, undefined, "public Ed25519 JWK should not contain d");
strictEqual(crypto.createPrivateKey(ed25519PrivateJwk).equals(ed25519Pair.privateKey), true, "createPrivateKey Ed25519 JWK mismatch");
strictEqual(crypto.createPublicKey(ed25519PrivateJwk).equals(ed25519Pair.publicKey), true, "createPublicKey from private Ed25519 JWK mismatch");
strictEqual(crypto.createPublicKey(ed25519Pair.privateKey).equals(ed25519Pair.publicKey), true, "createPublicKey from private Ed25519 KeyObject mismatch");

const ed448Pair = crypto.generateKeyPairSync("ed448");
const ed448Signature = crypto.sign(null, Buffer.from("ed448 payload"), ed448Pair.privateKey);
strictEqual(ed448Signature.byteLength, 114, "Ed448 signature length mismatch");
strictEqual(crypto.verify(null, Buffer.from("ed448 payload"), ed448Pair.publicKey, ed448Signature), true, "crypto.sign/verify ed448 mismatch");
const ed448Jwk = ed448Pair.privateKey.export({ format: "jwk" });
strictEqual(ed448Jwk.crv, "Ed448", "private Ed448 JWK curve mismatch");
strictEqual(crypto.createPublicKey(ed448Jwk).equals(ed448Pair.publicKey), true, "createPublicKey Ed448 JWK mismatch");

const x25519PairOne = crypto.generateKeyPairSync("x25519");
const x25519PairTwo = crypto.generateKeyPairSync("x25519");
strictEqual(
  crypto.diffieHellman({ privateKey: x25519PairOne.privateKey, publicKey: x25519PairTwo.publicKey }).byteLength,
  32,
  "x25519 Diffie-Hellman secret length mismatch",
);
try {
  crypto.sign("sha256", "ed25519 payload", ed25519Pair.privateKey);
  throw new Error("Ed25519 digest signing should throw");
} catch (error) {
  ok(String((error as Error).message).includes("invalid digest"), "Ed25519 digest signing validation path");
}
try {
  crypto.createSign("sha256").update("ed25519 payload").sign(ed25519Pair.privateKey);
  throw new Error("createSign Ed25519 should throw");
} catch (error) {
  ok(String((error as Error).message).includes("Unsupported crypto operation"), "createSign Ed25519 validation path");
}

const p1363Signature = crypto.createSign("sha256").update("signed payload").sign({ key: ecPair.privateKey, dsaEncoding: "ieee-p1363" });
strictEqual(p1363Signature.byteLength, 64, "ECDSA ieee-p1363 signature length mismatch");
strictEqual(
  crypto.createVerify("sha256").update("signed payload").verify({ key: ecPair.publicKey, dsaEncoding: "ieee-p1363" }, p1363Signature),
  true,
  "createSign/createVerify ieee-p1363 mismatch",
);

const privateJwk = ecPair.privateKey.export({ format: "jwk" });
const publicJwk = ecPair.publicKey.export({ format: "jwk" });
strictEqual(privateJwk.kty, "EC", "private JWK kty mismatch");
strictEqual(privateJwk.crv, "P-256", "private JWK curve mismatch");
strictEqual(typeof privateJwk.d, "string", "private JWK d mismatch");
strictEqual(publicJwk.d, undefined, "public JWK should not contain d");
strictEqual(crypto.createPrivateKey(privateJwk).equals(ecPair.privateKey), true, "createPrivateKey JWK mismatch");
strictEqual(crypto.createPublicKey(privateJwk).equals(ecPair.publicKey), true, "createPublicKey from private JWK mismatch");
strictEqual(crypto.createPublicKey(ecPair.privateKey).equals(ecPair.publicKey), true, "createPublicKey from private KeyObject mismatch");

await new Promise<void>((resolve, reject) => {
  crypto.generateKeyPair("ec", { namedCurve: "prime256v1", publicKeyEncoding: { format: "jwk" }, privateKeyEncoding: { format: "jwk" } }, (error, publicKey, privateKey) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      strictEqual(publicKey.kty, "EC", "async generateKeyPair public JWK mismatch");
      strictEqual(privateKey.kty, "EC", "async generateKeyPair private JWK mismatch");
      strictEqual(typeof privateKey.d, "string", "async generateKeyPair private JWK d mismatch");
      const signature = crypto.sign("sha256", "async pair", crypto.createPrivateKey(privateKey));
      strictEqual(crypto.verify("sha256", "async pair", crypto.createPublicKey(publicKey), signature), true, "async generateKeyPair sign/verify mismatch");
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});

await new Promise<void>((resolve, reject) => {
  crypto.generateKeyPair("ed25519", { publicKeyEncoding: { format: "jwk" }, privateKeyEncoding: { format: "jwk" } }, (error, publicKey, privateKey) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      strictEqual(publicKey.kty, "OKP", "async generateKeyPair ed25519 public JWK mismatch");
      strictEqual(privateKey.kty, "OKP", "async generateKeyPair ed25519 private JWK mismatch");
      strictEqual(privateKey.crv, "Ed25519", "async generateKeyPair ed25519 private curve mismatch");
      const signature = crypto.sign(null, "async ed25519 pair", crypto.createPrivateKey(privateKey));
      strictEqual(crypto.verify(null, "async ed25519 pair", crypto.createPublicKey(publicKey), signature), true, "async generateKeyPair ed25519 sign/verify mismatch");
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});

const diffiePairOne = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const diffiePairTwo = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
strictEqual(
  crypto.diffieHellman({ privateKey: diffiePairOne.privateKey, publicKey: diffiePairTwo.publicKey }).toString("hex"),
  crypto.diffieHellman({ privateKey: diffiePairTwo.privateKey, publicKey: diffiePairOne.publicKey }).toString("hex"),
  "crypto.diffieHellman EC shared secret mismatch",
);

const rsaPair = crypto.generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 0x10001 });
strictEqual(rsaPair.privateKey.type, "private", "generateKeyPairSync rsa private key type mismatch");
strictEqual(rsaPair.privateKey.asymmetricKeyType, "rsa", "generateKeyPairSync rsa private key asymmetric type mismatch");
strictEqual(rsaPair.privateKey.asymmetricKeyDetails.modulusLength, 1024, "generateKeyPairSync rsa modulus length mismatch");
strictEqual(rsaPair.privateKey.asymmetricKeyDetails.publicExponent, 65537n, "generateKeyPairSync rsa public exponent mismatch");
strictEqual(rsaPair.publicKey.type, "public", "generateKeyPairSync rsa public key type mismatch");

const rsaPrivateJwk = rsaPair.privateKey.export({ format: "jwk" });
const rsaPublicJwk = rsaPair.publicKey.export({ format: "jwk" });
strictEqual(rsaPrivateJwk.kty, "RSA", "private RSA JWK kty mismatch");
strictEqual(rsaPublicJwk.kty, "RSA", "public RSA JWK kty mismatch");
strictEqual(typeof rsaPrivateJwk.d, "string", "private RSA JWK d mismatch");
strictEqual(rsaPublicJwk.d, undefined, "public RSA JWK should not contain d");
strictEqual(crypto.createPrivateKey(rsaPrivateJwk).equals(rsaPair.privateKey), true, "createPrivateKey RSA JWK mismatch");
strictEqual(crypto.createPublicKey(rsaPrivateJwk).equals(rsaPair.publicKey), true, "createPublicKey from private RSA JWK mismatch");

const rsaSignature = crypto.sign("sha256", "rsa payload", rsaPair.privateKey);
strictEqual(rsaSignature.byteLength, 128, "RSA signature length mismatch");
strictEqual(crypto.verify("sha256", "rsa payload", rsaPair.publicKey, rsaSignature), true, "crypto.sign/verify rsa mismatch");
strictEqual(crypto.verify("sha256", "tampered", rsaPair.publicKey, rsaSignature), false, "crypto.verify should reject tampered RSA data");
strictEqual(
  crypto.createVerify("sha256").update("rsa payload").verify(rsaPair.publicKey, crypto.createSign("sha256").update("rsa payload").sign(rsaPair.privateKey)),
  true,
  "createSign/createVerify RSA mismatch",
);
const rsaPssSignature = crypto.sign("sha256", "rsa payload", {
  key: rsaPair.privateKey,
  padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
});
strictEqual(
  crypto.verify("sha256", "rsa payload", {
    key: rsaPair.publicKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }, rsaPssSignature),
  true,
  "RSA-PSS sign/verify mismatch",
);
const rsaPemPair = crypto.generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const rsaPemSignature = crypto.sign("sha256", "rsa pem payload", crypto.createPrivateKey(rsaPemPair.privateKey));
strictEqual(crypto.verify("sha256", "rsa pem payload", crypto.createPublicKey(rsaPemPair.publicKey), rsaPemSignature), true, "RSA PEM import/export mismatch");

const rsaCiphertext = crypto.publicEncrypt(rsaPair.publicKey, Buffer.from("hello rsa"));
strictEqual(crypto.privateDecrypt(rsaPair.privateKey, rsaCiphertext).toString(), "hello rsa", "RSA OAEP roundtrip mismatch");
const rsaPkcs1Ciphertext = crypto.publicEncrypt({ key: rsaPair.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from("pkcs1"));
// Bun rejects PKCS#1 v1.5 privateDecrypt (Bleichenbacher attack mitigation);
// Cottontail follows Bun here rather than Node, which still allows it.
let rsaPkcs1Rejected = false;
try {
  crypto.privateDecrypt({ key: rsaPair.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, rsaPkcs1Ciphertext);
} catch {
  rsaPkcs1Rejected = true;
}
strictEqual(rsaPkcs1Rejected, true, "RSA PKCS#1 privateDecrypt should be rejected (Bleichenbacher mitigation)");
const rsaPrivateCiphertext = crypto.privateEncrypt(rsaPair.privateKey, Buffer.from("private side"));
strictEqual(crypto.publicDecrypt(rsaPair.publicKey, rsaPrivateCiphertext).toString(), "private side", "RSA privateEncrypt/publicDecrypt mismatch");
const rsaKem = crypto.encapsulate(rsaPair.publicKey);
strictEqual(rsaKem.sharedKey.byteLength, 64, "RSA KEM shared key length mismatch");
strictEqual(rsaKem.ciphertext.byteLength, 128, "RSA KEM ciphertext length mismatch");
strictEqual(crypto.decapsulate(rsaPair.privateKey, rsaKem.ciphertext).toString("hex"), rsaKem.sharedKey.toString("hex"), "RSA KEM decapsulation mismatch");

await new Promise<void>((resolve, reject) => {
  crypto.encapsulate(diffiePairOne.publicKey, (error, result) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      strictEqual(result.sharedKey.byteLength, 32, "EC KEM shared key length mismatch");
      strictEqual(result.ciphertext.byteLength, 65, "EC KEM ciphertext length mismatch");
      strictEqual(crypto.decapsulate(diffiePairOne.privateKey, result.ciphertext).toString("hex"), result.sharedKey.toString("hex"), "EC KEM decapsulation mismatch");
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});

try {
  crypto.generateKeyPairSync("rsa", {});
  throw new Error("generateKeyPairSync rsa without modulusLength should throw");
} catch (error) {
  ok(String((error as Error).message).includes("modulusLength"), "generateKeyPairSync rsa modulusLength validation path");
}

const cert = new crypto.X509Certificate(fixtureCertificate);
strictEqual(cert.subject, "CN=localhost\nO=Cottontail", "X509 subject mismatch");
strictEqual(cert.issuer, "CN=localhost\nO=Cottontail", "X509 issuer mismatch");
strictEqual(cert.serialNumber, "D02634654FA849A7", "X509 serial mismatch");
strictEqual(cert.signatureAlgorithm, "sha256WithRSAEncryption", "X509 signature algorithm mismatch");
strictEqual(cert.publicKey.asymmetricKeyType, "rsa", "X509 public key type mismatch");
strictEqual(cert.checkHost("localhost"), "localhost", "X509 checkHost CN mismatch");
strictEqual(cert.verify(cert.publicKey), true, "X509 self-signature verification mismatch");
strictEqual(cert.toJSON().includes("BEGIN CERTIFICATE"), true, "X509 JSON PEM mismatch");
strictEqual(cert.toLegacyObject().bits, 512, "X509 legacy object bit length mismatch");
const p384Cert = new crypto.X509Certificate(fixtureP384Certificate);
strictEqual(p384Cert.signatureAlgorithm, "ecdsa-with-SHA384", "P-384 X509 signature algorithm mismatch");
strictEqual(p384Cert.publicKey.asymmetricKeyDetails.namedCurve, "secp384r1", "P-384 X509 public key curve mismatch");
strictEqual(p384Cert.verify(p384Cert.publicKey), true, "P-384 X509 self-signature verification mismatch");
strictEqual(new crypto.Certificate().verifySpkac(fixtureSpkac), true, "Certificate verifySpkac valid mismatch");
strictEqual(crypto.Certificate.exportChallenge(fixtureSpkac).toString(), "cottontail", "Certificate exportChallenge valid mismatch");
strictEqual(crypto.Certificate.exportPublicKey(fixtureSpkac).toString().includes("BEGIN PUBLIC KEY"), true, "Certificate exportPublicKey valid mismatch");
strictEqual(new crypto.Certificate().verifySpkac(Buffer.from("bad")), false, "Certificate verifySpkac invalid mismatch");
strictEqual(crypto.Certificate.exportChallenge(Buffer.from("bad")).byteLength, 0, "Certificate exportChallenge invalid mismatch");
crypto.setEngine("dynamic");
assertUnavailable(() => crypto.setEngine("missing"), "setEngine missing engine path");
assertUnavailable(() => crypto.argon2Sync("argon2bad", argon2Params), "argon2Sync invalid algorithm path");
assertUnavailable(() => crypto.createECDH("not-a-curve"), "unavailable ECDH curve path");
try {
  crypto.createPrivateKey("bad");
  throw new Error("createPrivateKey unsupported input should throw");
} catch (error) {
  ok(String(error).includes("parse"), "createPrivateKey unsupported input path");
}
try {
  crypto.createSign("sha256").update("x").sign("bad");
  throw new Error("createSign/sign unsupported input should throw");
} catch (error) {
  ok(String(error).includes("parse"), "createSign/sign unsupported input path");
}
const heap = crypto.secureHeapUsed();
strictEqual(heap.total, 0, "secure heap total mismatch");
strictEqual(heap.used, 0, "secure heap used mismatch");
ok(heap.utilization === 0, "secure heap utilization mismatch");

console.log("node crypto kdf dh surface passed");
