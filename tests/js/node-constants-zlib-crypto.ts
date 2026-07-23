import { ok, strictEqual, throws } from "node:assert/strict";
import constantsDefault, { EACCES } from "node:constants";
import * as constants from "node:constants";
import { createRequire } from "node:module";
import { constants as fsConstants } from "node:fs";
import { constants as osConstants } from "node:os";
import { getSystemErrorMap, getSystemErrorName } from "node:util";
import {
  constants as zlibConstants,
  deflate,
  deflateRawSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
  inflateSync,
} from "node:zlib";
import * as crypto from "node:crypto";

const require = createRequire(import.meta.url);
const requiredConstants = require("constants");
const requiredCrypto = require("node:crypto");
const requiredZlib = require("zlib");
const requiredBuffer = require("node:buffer");
const decoder = new TextDecoder();

function textFromBytes(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

strictEqual(constantsDefault.EACCES, EACCES, "constants default export mismatch");
strictEqual(constants.EACCES, EACCES, "constants named export mismatch");
strictEqual(requiredConstants.EACCES, EACCES, "require constants mismatch");
strictEqual(Object.isFrozen(requiredConstants), true, "require constants should be frozen");
ok(Number.isInteger(constants.S_IFDIR), "constants should expose fs mode constants");

const expectedPlatformConstants = process.platform === "linux"
  ? {
      EADDRINUSE: 98,
      ECONNREFUSED: 111,
      ENOBUFS: 105,
      ETIMEDOUT: 110,
      O_CREAT: 64,
      O_DIRECTORY: 16384,
      O_DIRECT: 65536,
      O_NOATIME: 262144,
      O_NONBLOCK: 2048,
      O_SYNC: 1052672,
      RTLD_DEEPBIND: 8,
      RTLD_GLOBAL: 256,
      RTLD_LOCAL: 0,
      SIGBUS: 7,
      SIGCHLD: 17,
      SIGUSR1: 10,
      SIGUSR2: 12,
    }
  : process.platform === "darwin"
    ? {
      EADDRINUSE: 48,
      ECONNREFUSED: 61,
      ENOBUFS: 55,
      ETIMEDOUT: 60,
      O_CREAT: 512,
      O_DIRECTORY: 1048576,
      O_NONBLOCK: 4,
      O_SYNC: 128,
      O_SYMLINK: 2097152,
      RTLD_GLOBAL: 8,
      RTLD_LOCAL: 4,
      SIGBUS: 10,
      SIGCHLD: 20,
      SIGINFO: 29,
      SIGUSR1: 30,
      SIGUSR2: 31,
      }
    : {};

for (const [name, expected] of Object.entries(expectedPlatformConstants)) {
  strictEqual((constants as Record<string, unknown>)[name], expected, `node:constants ${name} mismatch`);
  strictEqual(requiredConstants[name], expected, `require("constants") ${name} mismatch`);
}

if (process.platform === "linux") {
  strictEqual(Object.hasOwn(constantsDefault, "O_SYMLINK"), false, "Linux constants should omit O_SYMLINK");
  strictEqual(Object.hasOwn(constantsDefault, "SIGINFO"), false, "Linux constants should omit SIGINFO");
  strictEqual(Object.hasOwn(requiredConstants, "O_SYMLINK"), false, "Linux require constants should omit O_SYMLINK");
  strictEqual(Object.hasOwn(requiredConstants, "SIGINFO"), false, "Linux require constants should omit SIGINFO");
} else if (process.platform === "darwin") {
  strictEqual(Object.hasOwn(constantsDefault, "O_DIRECT"), false, "Darwin constants should omit O_DIRECT");
  strictEqual(Object.hasOwn(constantsDefault, "SIGPOLL"), false, "Darwin constants should omit SIGPOLL");
  strictEqual(Object.hasOwn(requiredConstants, "O_DIRECT"), false, "Darwin require constants should omit O_DIRECT");
  strictEqual(Object.hasOwn(requiredConstants, "SIGPOLL"), false, "Darwin require constants should omit SIGPOLL");
}

if ("O_CREAT" in expectedPlatformConstants) {
  for (const name of ["O_CREAT", "O_DIRECTORY", "O_DIRECT", "O_NOATIME"]) {
    if (name in expectedPlatformConstants) {
      strictEqual(
        (fsConstants as Record<string, unknown>)[name],
        (expectedPlatformConstants as Record<string, unknown>)[name],
        `fs.constants ${name} mismatch`,
      );
    }
  }
  strictEqual(osConstants.errno.EADDRINUSE, expectedPlatformConstants.EADDRINUSE, "os.constants errno mismatch");
  strictEqual("ENGINE_METHOD_ALL" in osConstants.errno, false, "os.constants errno should not contain crypto constants");
  strictEqual(osConstants.signals.SIGUSR1, expectedPlatformConstants.SIGUSR1, "os.constants signal mismatch");
  strictEqual(osConstants.dlopen.RTLD_GLOBAL, expectedPlatformConstants.RTLD_GLOBAL, "os.constants dlopen mismatch");
  if ("RTLD_DEEPBIND" in expectedPlatformConstants) {
    strictEqual(
      osConstants.dlopen.RTLD_DEEPBIND,
      expectedPlatformConstants.RTLD_DEEPBIND,
      "os.constants RTLD_DEEPBIND mismatch",
    );
  }

  const constantsBinding = (process as any).binding("constants");
  strictEqual(constantsBinding.fs.O_CREAT, expectedPlatformConstants.O_CREAT, "process constants fs mismatch");
  strictEqual(constantsBinding.os.errno.EADDRINUSE, expectedPlatformConstants.EADDRINUSE, "process constants errno mismatch");
  strictEqual(
    "ENGINE_METHOD_ALL" in constantsBinding.os.errno,
    false,
    "process constants errno should not contain crypto constants",
  );
  strictEqual(constantsBinding.os.signals.SIGUSR1, expectedPlatformConstants.SIGUSR1, "process constants signal mismatch");
  strictEqual(constantsBinding.os.dlopen.RTLD_GLOBAL, expectedPlatformConstants.RTLD_GLOBAL, "process constants dlopen mismatch");

  const uvBinding = (process as any).binding("uv");
  strictEqual(uvBinding.UV_EADDRINUSE, -expectedPlatformConstants.EADDRINUSE, "libuv EADDRINUSE mismatch");
  strictEqual(uvBinding.UV_ETIMEDOUT, -expectedPlatformConstants.ETIMEDOUT, "libuv ETIMEDOUT mismatch");
  strictEqual(getSystemErrorName(-expectedPlatformConstants.EADDRINUSE), "EADDRINUSE", "system error name mismatch");
  strictEqual(
    getSystemErrorMap().get(-expectedPlatformConstants.EADDRINUSE)?.[0],
    "EADDRINUSE",
    "system error map mismatch",
  );
}

const payload = "cottontail zlib payload";
strictEqual(textFromBytes(gunzipSync(gzipSync(payload))), payload, "gzip roundtrip mismatch");
strictEqual(textFromBytes(inflateSync(deflateSync(payload, { level: zlibConstants.Z_BEST_SPEED }))), payload, "deflate roundtrip mismatch");
strictEqual(textFromBytes(inflateRawSync(deflateRawSync(payload))), payload, "deflateRaw roundtrip mismatch");
strictEqual(zlibConstants.Z_OK, 0, "zlib constants mismatch");
strictEqual(textFromBytes(requiredZlib.gunzipSync(requiredZlib.gzipSync(payload))), payload, "required zlib mismatch");

const oversizedCompressed = gzipSync("a".repeat(128));
const originalMaxLength = requiredBuffer.kMaxLength;
try {
  requiredBuffer.kMaxLength = 64;
  strictEqual(require("buffer").kMaxLength, 64, "buffer CommonJS aliases should share mutable exports");
  throws(() => gunzipSync(oversizedCompressed), RangeError, "zlib should observe the mutable buffer output limit");
} finally {
  requiredBuffer.kMaxLength = originalMaxLength;
}

await new Promise<void>((resolve, reject) => {
  deflate(payload, (error, compressed) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      strictEqual(textFromBytes(inflateSync(compressed)), payload, "callback deflate roundtrip mismatch");
      resolve();
    } catch (roundtripError) {
      reject(roundtripError);
    }
  });
});

const sha256 = "a3b531da983cbdf728c07c6ade96c259a9ed3e256e62c3801e94c0a37bb6201f";
const hmacSha256 = "9a157a6fdc4a7cccdf784aef4aee07f827e230a4e623d5c6d9af645b2ff6e28a";
strictEqual(crypto.createHash("sha256").update("cotton").update("tail").digest("hex"), sha256, "sha256 mismatch");
strictEqual(crypto.hash("sha256", "cottontail", "hex"), sha256, "one-shot hash mismatch");
strictEqual(requiredCrypto.createHash("sha256").update("cottontail").digest("hex"), sha256, "required crypto hash mismatch");
strictEqual(crypto.createHmac("sha256", "key").update("cottontail").digest("hex"), hmacSha256, "hmac mismatch");
strictEqual(crypto.getHashes().includes("sha256"), true, "sha256 should be listed");

const random = crypto.randomBytes(16);
strictEqual(random.byteLength, 16, "randomBytes length mismatch");

const fillTarget = new Uint8Array(8);
strictEqual(crypto.randomFillSync(fillTarget), fillTarget, "randomFillSync should return input");
ok(fillTarget.some((byte) => byte !== 0), "randomFillSync should write bytes");

const randomValuesTarget = new Uint8Array(8);
strictEqual(crypto.getRandomValues(randomValuesTarget), randomValuesTarget, "getRandomValues should return input");
ok(randomValuesTarget.some((byte) => byte !== 0), "getRandomValues should write bytes");

const randomInt = crypto.randomInt(10, 20);
ok(randomInt >= 10 && randomInt < 20, "randomInt should stay inside range");
ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()), "randomUUID should be v4");
strictEqual(crypto.timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true, "timingSafeEqual true mismatch");
strictEqual(crypto.timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false, "timingSafeEqual false mismatch");

console.log("node constants zlib crypto passed");
