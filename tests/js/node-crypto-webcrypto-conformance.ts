import { ok, strictEqual } from "node:assert/strict";
import { createPrivateKey, createPublicKey, webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const encoder = new TextEncoder();

function hex(value: ArrayBuffer | ArrayBufferView): string {
  return Buffer.from(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)).toString("hex");
}

function text(value: ArrayBuffer): string {
  return Buffer.from(value).toString();
}

function bytes(value: ArrayBuffer | ArrayBufferView): Buffer {
  return Buffer.from(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

strictEqual(hex(await subtle.digest("SHA-256", encoder.encode("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "subtle.digest SHA-256 mismatch");
strictEqual(hex(await subtle.digest({ name: "SHA-384" }, encoder.encode("abc"))), "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7", "subtle.digest SHA-384 mismatch");

const aesGcmKey = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
strictEqual(aesGcmKey.type, "secret", "AES-GCM key type mismatch");
strictEqual(aesGcmKey.algorithm.length, 256, "AES-GCM key length mismatch");
const gcmIv = Buffer.from("000102030405060708090a0b", "hex");
const gcmCiphertext = await subtle.encrypt({ name: "AES-GCM", iv: gcmIv, additionalData: encoder.encode("aad") }, aesGcmKey, encoder.encode("gcm payload"));
strictEqual(text(await subtle.decrypt({ name: "AES-GCM", iv: gcmIv, additionalData: encoder.encode("aad") }, aesGcmKey, gcmCiphertext)), "gcm payload", "AES-GCM roundtrip mismatch");

const aesCbcKey = await subtle.importKey("raw", Buffer.from("00112233445566778899aabbccddeeff", "hex"), "AES-CBC", true, ["encrypt", "decrypt"]);
const cbcIv = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
const cbcCiphertext = await subtle.encrypt({ name: "AES-CBC", iv: cbcIv }, aesCbcKey, encoder.encode("cbc payload"));
strictEqual(text(await subtle.decrypt({ name: "AES-CBC", iv: cbcIv }, aesCbcKey, cbcCiphertext)), "cbc payload", "AES-CBC roundtrip mismatch");

const aesCtrKey = await subtle.importKey("raw", Buffer.from("00112233445566778899aabbccddeeff", "hex"), "AES-CTR", true, ["encrypt", "decrypt"]);
const ctrCounter = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
const ctrCiphertext = await subtle.encrypt({ name: "AES-CTR", counter: ctrCounter, length: 64 }, aesCtrKey, encoder.encode("ctr payload"));
strictEqual(text(await subtle.decrypt({ name: "AES-CTR", counter: ctrCounter, length: 64 }, aesCtrKey, ctrCiphertext)), "ctr payload", "AES-CTR roundtrip mismatch");

const aesKwKey = await subtle.importKey("raw", Buffer.alloc(16, 1), "AES-KW", true, ["wrapKey", "unwrapKey"]);
const aesKwPayloadKey = await subtle.importKey("raw", Buffer.alloc(16, 2), "AES-GCM", true, ["encrypt"]);
const aesKwWrapped = await subtle.wrapKey("raw", aesKwPayloadKey, aesKwKey, "AES-KW");
strictEqual(hex(aesKwWrapped), "2152937994459ab9fb05db73e66f546291eb5389bc8aa7cc", "AES-KW wrap mismatch");
const aesKwUnwrapped = await subtle.unwrapKey("raw", aesKwWrapped, aesKwKey, "AES-KW", "AES-GCM", true, ["encrypt"]);
strictEqual(hex(await subtle.exportKey("raw", aesKwUnwrapped)), "02020202020202020202020202020202", "AES-KW unwrap mismatch");

const hmacKey = await subtle.importKey("raw", encoder.encode("secret"), { name: "HMAC", hash: "SHA-256" }, true, ["sign", "verify"]);
strictEqual(hmacKey.algorithm.length, 48, "imported HMAC key length mismatch");
const hmacSignature = await subtle.sign("HMAC", hmacKey, encoder.encode("hmac payload"));
strictEqual(hex(hmacSignature), "78e089137b5bebdaf42c866289884292db889d44efb6a052107c5cc6517df8c1", "HMAC signature mismatch");
strictEqual(await subtle.verify("HMAC", hmacKey, hmacSignature, encoder.encode("hmac payload")), true, "HMAC verify mismatch");
strictEqual(await subtle.verify("HMAC", hmacKey, hmacSignature, encoder.encode("tampered")), false, "HMAC verify should reject tampered data");

const pbkdf2Key = await subtle.importKey("raw", encoder.encode("password"), "PBKDF2", false, ["deriveBits", "deriveKey"]);
strictEqual(hex(await subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode("salt"), iterations: 1, hash: "SHA-256" }, pbkdf2Key, 128)), "120fb6cffcf8b32c43e7225256c4f837", "PBKDF2 deriveBits mismatch");
const pbkdf2AesKey = await subtle.deriveKey({ name: "PBKDF2", salt: encoder.encode("salt"), iterations: 1, hash: "SHA-256" }, pbkdf2Key, { name: "AES-GCM", length: 128 }, true, ["encrypt", "decrypt"]);
strictEqual(pbkdf2AesKey.algorithm.length, 128, "PBKDF2 deriveKey AES length mismatch");

const hkdfKey = await subtle.importKey("raw", encoder.encode("key"), "HKDF", false, ["deriveBits"]);
strictEqual(hex(await subtle.deriveBits({ name: "HKDF", salt: encoder.encode("salt"), info: encoder.encode("info"), hash: "SHA-256" }, hkdfKey, 128)), "9ca0d662557439e3b83365f2da4626d3", "HKDF deriveBits mismatch");

const rsaPssPair = await subtle.generateKey({ name: "RSA-PSS", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const rsaPssSignature = await subtle.sign({ name: "RSA-PSS", saltLength: 32 }, rsaPssPair.privateKey, encoder.encode("rsa pss payload"));
strictEqual(await subtle.verify({ name: "RSA-PSS", saltLength: 32 }, rsaPssPair.publicKey, rsaPssSignature, encoder.encode("rsa pss payload")), true, "RSA-PSS verify mismatch");
strictEqual(await subtle.verify({ name: "RSA-PSS", saltLength: 32 }, rsaPssPair.publicKey, rsaPssSignature, encoder.encode("tampered")), false, "RSA-PSS verify should reject tampered data");
const rsaPssJwk = await subtle.exportKey("jwk", rsaPssPair.publicKey);
const importedRsaPssPublic = await subtle.importKey("jwk", rsaPssJwk, { name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"]);
strictEqual(await subtle.verify({ name: "RSA-PSS", saltLength: 32 }, importedRsaPssPublic, rsaPssSignature, encoder.encode("rsa pss payload")), true, "RSA-PSS JWK import mismatch");

const rsaOaepPair = await subtle.generateKey({ name: "RSA-OAEP", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
const oaepCiphertext = await subtle.encrypt({ name: "RSA-OAEP", label: encoder.encode("label") }, rsaOaepPair.publicKey, encoder.encode("rsa oaep payload"));
strictEqual(text(await subtle.decrypt({ name: "RSA-OAEP", label: encoder.encode("label") }, rsaOaepPair.privateKey, oaepCiphertext)), "rsa oaep payload", "RSA-OAEP roundtrip mismatch");
const rsaOaepSpki = await subtle.exportKey("spki", rsaOaepPair.publicKey);
const rsaOaepPkcs8 = await subtle.exportKey("pkcs8", rsaOaepPair.privateKey);
const importedRsaOaepPublic = await subtle.importKey("spki", rsaOaepSpki, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
const importedRsaOaepPrivate = await subtle.importKey("pkcs8", rsaOaepPkcs8, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]);
const importedOaepCiphertext = await subtle.encrypt({ name: "RSA-OAEP" }, importedRsaOaepPublic, encoder.encode("imported rsa"));
strictEqual(text(await subtle.decrypt({ name: "RSA-OAEP" }, importedRsaOaepPrivate, importedOaepCiphertext)), "imported rsa", "RSA-OAEP spki/pkcs8 import mismatch");

const wrappedHmacKey = await subtle.wrapKey("raw", hmacKey, aesGcmKey, { name: "AES-GCM", iv: gcmIv });
const unwrappedHmacKey = await subtle.unwrapKey("raw", wrappedHmacKey, aesGcmKey, { name: "AES-GCM", iv: gcmIv }, { name: "HMAC", hash: "SHA-256" }, true, ["sign", "verify"]);
strictEqual(await subtle.verify("HMAC", unwrappedHmacKey, await subtle.sign("HMAC", unwrappedHmacKey, encoder.encode("wrapped")), encoder.encode("wrapped")), true, "wrapKey/unwrapKey HMAC mismatch");

const ecdsaP256 = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const ecdsaP256Signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ecdsaP256.privateKey, encoder.encode("ecdsa p256"));
strictEqual(Buffer.from(ecdsaP256Signature).byteLength, 64, "ECDSA P-256 signature length mismatch");
strictEqual(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ecdsaP256.publicKey, ecdsaP256Signature, encoder.encode("ecdsa p256")), true, "ECDSA P-256 verify mismatch");
const ecdsaP256Spki = await subtle.exportKey("spki", ecdsaP256.publicKey);
const ecdsaP256Pkcs8 = await subtle.exportKey("pkcs8", ecdsaP256.privateKey);
strictEqual(createPublicKey({ key: bytes(ecdsaP256Spki), format: "der", type: "spki" }).asymmetricKeyType, "ec", "ECDSA P-256 SPKI should import as EC");
strictEqual(createPrivateKey({ key: bytes(ecdsaP256Pkcs8), format: "der", type: "pkcs8" }).asymmetricKeyType, "ec", "ECDSA P-256 PKCS8 should import as EC");
const importedEcdsaP256Public = await subtle.importKey("spki", ecdsaP256Spki, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
const importedEcdsaP256Private = await subtle.importKey("pkcs8", ecdsaP256Pkcs8, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const importedEcdsaP256Signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, importedEcdsaP256Private, encoder.encode("ecdsa p256 der"));
strictEqual(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, importedEcdsaP256Public, importedEcdsaP256Signature, encoder.encode("ecdsa p256 der")), true, "ECDSA P-256 spki/pkcs8 import mismatch");

const ecdsaP384 = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"]);
const ecdsaP384Jwk = await subtle.exportKey("jwk", ecdsaP384.publicKey);
const importedEcdsaP384Public = await subtle.importKey("jwk", ecdsaP384Jwk, { name: "ECDSA", namedCurve: "P-384" }, true, ["verify"]);
const ecdsaP384Signature = await subtle.sign({ name: "ECDSA", hash: "SHA-384" }, ecdsaP384.privateKey, encoder.encode("ecdsa p384"));
strictEqual(Buffer.from(ecdsaP384Signature).byteLength, 96, "ECDSA P-384 signature length mismatch");
strictEqual(await subtle.verify({ name: "ECDSA", hash: "SHA-384" }, importedEcdsaP384Public, ecdsaP384Signature, encoder.encode("ecdsa p384")), true, "ECDSA P-384 JWK import mismatch");
const ecdsaP384Spki = await subtle.exportKey("spki", ecdsaP384.publicKey);
const ecdsaP384Pkcs8 = await subtle.exportKey("pkcs8", ecdsaP384.privateKey);
strictEqual(createPublicKey({ key: bytes(ecdsaP384Spki), format: "der", type: "spki" }).asymmetricKeyType, "ec", "ECDSA P-384 SPKI should import as EC");
strictEqual(createPrivateKey({ key: bytes(ecdsaP384Pkcs8), format: "der", type: "pkcs8" }).asymmetricKeyType, "ec", "ECDSA P-384 PKCS8 should import as EC");
const importedEcdsaP384Spki = await subtle.importKey("spki", ecdsaP384Spki, { name: "ECDSA", namedCurve: "P-384" }, true, ["verify"]);
const importedEcdsaP384Pkcs8 = await subtle.importKey("pkcs8", ecdsaP384Pkcs8, { name: "ECDSA", namedCurve: "P-384" }, true, ["sign"]);
const importedEcdsaP384Signature = await subtle.sign({ name: "ECDSA", hash: "SHA-384" }, importedEcdsaP384Pkcs8, encoder.encode("ecdsa p384 der"));
strictEqual(await subtle.verify({ name: "ECDSA", hash: "SHA-384" }, importedEcdsaP384Spki, importedEcdsaP384Signature, encoder.encode("ecdsa p384 der")), true, "ECDSA P-384 spki/pkcs8 import mismatch");

const ecdhA = await subtle.generateKey({ name: "ECDH", namedCurve: "P-384" }, true, ["deriveBits"]);
const ecdhB = await subtle.generateKey({ name: "ECDH", namedCurve: "P-384" }, true, ["deriveBits"]);
strictEqual(Buffer.from(await subtle.deriveBits({ name: "ECDH", public: ecdhB.publicKey }, ecdhA.privateKey, 384)).byteLength, 48, "ECDH P-384 deriveBits length mismatch");

const ed25519Pair = await subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const ed25519Signature = await subtle.sign("Ed25519", ed25519Pair.privateKey, encoder.encode("ed25519 payload"));
strictEqual(Buffer.from(ed25519Signature).byteLength, 64, "Ed25519 signature length mismatch");
strictEqual(await subtle.verify("Ed25519", ed25519Pair.publicKey, ed25519Signature, encoder.encode("ed25519 payload")), true, "Ed25519 verify mismatch");
const ed25519Spki = await subtle.exportKey("spki", ed25519Pair.publicKey);
const ed25519Pkcs8 = await subtle.exportKey("pkcs8", ed25519Pair.privateKey);
strictEqual(createPublicKey({ key: bytes(ed25519Spki), format: "der", type: "spki" }).asymmetricKeyType, "ed25519", "Ed25519 SPKI should import as Ed25519");
strictEqual(createPrivateKey({ key: bytes(ed25519Pkcs8), format: "der", type: "pkcs8" }).asymmetricKeyType, "ed25519", "Ed25519 PKCS8 should import as Ed25519");
const importedEd25519Public = await subtle.importKey("spki", ed25519Spki, "Ed25519", true, ["verify"]);
const importedEd25519Private = await subtle.importKey("pkcs8", ed25519Pkcs8, "Ed25519", true, ["sign"]);
const importedEd25519Signature = await subtle.sign("Ed25519", importedEd25519Private, encoder.encode("ed25519 der"));
strictEqual(await subtle.verify("Ed25519", importedEd25519Public, importedEd25519Signature, encoder.encode("ed25519 der")), true, "Ed25519 spki/pkcs8 import mismatch");
const importedEd25519RawPublic = await subtle.importKey("raw", await subtle.exportKey("raw", ed25519Pair.publicKey), "Ed25519", true, ["verify"]);
strictEqual(await subtle.verify("Ed25519", importedEd25519RawPublic, ed25519Signature, encoder.encode("ed25519 payload")), true, "Ed25519 raw public import mismatch");

const ed448Pair = await subtle.generateKey("Ed448", true, ["sign", "verify"]);
const ed448Jwk = await subtle.exportKey("jwk", ed448Pair.privateKey);
const importedEd448Private = await subtle.importKey("jwk", ed448Jwk, "Ed448", true, ["sign"]);
const ed448Signature = await subtle.sign("Ed448", importedEd448Private, encoder.encode("ed448 payload"));
strictEqual(Buffer.from(ed448Signature).byteLength, 114, "Ed448 signature length mismatch");
strictEqual(await subtle.verify("Ed448", ed448Pair.publicKey, ed448Signature, encoder.encode("ed448 payload")), true, "Ed448 JWK import/sign mismatch");
const ed448Spki = await subtle.exportKey("spki", ed448Pair.publicKey);
const ed448Pkcs8 = await subtle.exportKey("pkcs8", ed448Pair.privateKey);
strictEqual(createPublicKey({ key: bytes(ed448Spki), format: "der", type: "spki" }).asymmetricKeyType, "ed448", "Ed448 SPKI should import as Ed448");
strictEqual(createPrivateKey({ key: bytes(ed448Pkcs8), format: "der", type: "pkcs8" }).asymmetricKeyType, "ed448", "Ed448 PKCS8 should import as Ed448");
const importedEd448Public = await subtle.importKey("spki", ed448Spki, "Ed448", true, ["verify"]);
const importedEd448Pkcs8 = await subtle.importKey("pkcs8", ed448Pkcs8, "Ed448", true, ["sign"]);
const importedEd448Signature = await subtle.sign("Ed448", importedEd448Pkcs8, encoder.encode("ed448 der"));
strictEqual(await subtle.verify("Ed448", importedEd448Public, importedEd448Signature, encoder.encode("ed448 der")), true, "Ed448 spki/pkcs8 import mismatch");
const importedEd448RawPublic = await subtle.importKey("raw", await subtle.exportKey("raw", ed448Pair.publicKey), "Ed448", true, ["verify"]);
strictEqual(await subtle.verify("Ed448", importedEd448RawPublic, ed448Signature, encoder.encode("ed448 payload")), true, "Ed448 raw public import mismatch");

const x25519A = await subtle.generateKey("X25519", true, ["deriveBits"]);
const x25519B = await subtle.generateKey("X25519", true, ["deriveBits"]);
const x25519Secret = await subtle.deriveBits({ name: "X25519", public: x25519B.publicKey }, x25519A.privateKey, 256);
strictEqual(Buffer.from(x25519Secret).byteLength, 32, "X25519 deriveBits length mismatch");
const x25519Spki = await subtle.exportKey("spki", x25519B.publicKey);
const x25519Pkcs8 = await subtle.exportKey("pkcs8", x25519A.privateKey);
strictEqual(createPublicKey({ key: bytes(x25519Spki), format: "der", type: "spki" }).asymmetricKeyType, "x25519", "X25519 SPKI should import as X25519");
strictEqual(createPrivateKey({ key: bytes(x25519Pkcs8), format: "der", type: "pkcs8" }).asymmetricKeyType, "x25519", "X25519 PKCS8 should import as X25519");
const importedX25519Public = await subtle.importKey("spki", x25519Spki, "X25519", true, []);
const importedX25519Private = await subtle.importKey("pkcs8", x25519Pkcs8, "X25519", true, ["deriveBits"]);
strictEqual(hex(await subtle.deriveBits({ name: "X25519", public: importedX25519Public }, importedX25519Private, 256)), hex(x25519Secret), "X25519 spki/pkcs8 import mismatch");

const x448A = await subtle.generateKey("X448", true, ["deriveBits"]);
const x448B = await subtle.generateKey("X448", true, ["deriveBits"]);
const x448Secret = await subtle.deriveBits({ name: "X448", public: x448B.publicKey }, x448A.privateKey, 448);
strictEqual(Buffer.from(x448Secret).byteLength, 56, "X448 deriveBits length mismatch");
const x448Spki = await subtle.exportKey("spki", x448B.publicKey);
const x448Pkcs8 = await subtle.exportKey("pkcs8", x448A.privateKey);
strictEqual(createPublicKey({ key: bytes(x448Spki), format: "der", type: "spki" }).asymmetricKeyType, "x448", "X448 SPKI should import as X448");
strictEqual(createPrivateKey({ key: bytes(x448Pkcs8), format: "der", type: "pkcs8" }).asymmetricKeyType, "x448", "X448 PKCS8 should import as X448");
const importedX448Public = await subtle.importKey("spki", x448Spki, "X448", true, []);
const importedX448Private = await subtle.importKey("pkcs8", x448Pkcs8, "X448", true, ["deriveBits"]);
strictEqual(hex(await subtle.deriveBits({ name: "X448", public: importedX448Public }, importedX448Private, 448)), hex(x448Secret), "X448 spki/pkcs8 import mismatch");

ok(webcrypto.getRandomValues(new Uint8Array(8)) instanceof Uint8Array, "webcrypto.getRandomValues should return the input view");

console.log("node crypto webcrypto conformance passed");
