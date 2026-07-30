import { describe, expect, test } from "bun:test";
import { releaseWeakRefs } from "bun:jsc";

const EXPECTED = {
  blake2b256: {
    bytes: 32,
    hex: "256c83b297114d201b30179f3f0ef0cace9783622da5974326b436178aeef610",
  },
  blake2b512: {
    bytes: 64,
    hex: "021ced8799296ceca557832ab941a50b4a11f83478cf141f51f933f653ab9fbcc05a037cddbed06e309bf334942c4e58cdf1a46e237911ccd7fcf9787cbc7fd0",
  },
  blake2s256: {
    bytes: 32,
    hex: "9aec6806794561107e594b1f6a8a6b0c92a0cba9acf5e5e93cca06f781813b0b",
  },
  md4: {
    bytes: 16,
    hex: "aa010fbc1d14c795d86ef98c95479d17",
  },
  md5: {
    bytes: 16,
    hex: "5eb63bbbe01eeed093cb22bb8f5acdc3",
  },
  ripemd160: {
    bytes: 20,
    hex: "98c615784ccb5fe5936fbc0cbe9dfdb408d92f0f",
  },
  sha1: {
    bytes: 20,
    hex: "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed",
  },
  sha224: {
    bytes: 28,
    hex: "2f05477fc24bb4faefd86517156dafdecec45b8ad3cf2522a563582b",
  },
  sha256: {
    bytes: 32,
    hex: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
  },
  sha384: {
    bytes: 48,
    hex: "fdbd8e75a67f29f701a4e040385e2e23986303ea10239211af907fcbb83578b3e417cb71ce646efd0819dd8c088de1bd",
  },
  sha512: {
    bytes: 64,
    hex: "309ecc489c12d6eb4cc40f50c902f2b4d0ed77ee511a7c7a9bcd3ca86d4cd86f989dd35bc5ff499670da34255b45b0cfd830e81f605dcf7dc5542e93ae9cd76f",
  },
  "sha512-224": {
    bytes: 28,
    hex: "22e0d52336f64a998085078b05a6e37b26f8120f43bf4db4c43a64ee",
  },
  "sha512-256": {
    bytes: 32,
    hex: "0ac561fac838104e3f2e4ad107b4bee3e938bf15f2b15f009ccccd61a913f017",
  },
  "sha3-224": {
    bytes: 28,
    hex: "dfb7f18c77e928bb56faeb2da27291bd790bc1045cde45f3210bb6c5",
  },
  "sha3-256": {
    bytes: 32,
    hex: "644bcc7e564373040999aac89e7622f3ca71fba1d972fd94a31c3bfbf24e3938",
  },
  "sha3-384": {
    bytes: 48,
    hex: "83bff28dde1b1bf5810071c6643c08e5b05bdb836effd70b403ea8ea0a634dc4997eb1053aa3593f590f9c63630dd90b",
  },
  "sha3-512": {
    bytes: 64,
    hex: "840006653e9ac9e95117a15c915caab81662918e925de9e004f774ff82d7079a40d4d27b1b372657c61d46d470304c88c788b3a4527ad074d1dccbee5dbaa99a",
  },
  shake128: {
    bytes: 16,
    hex: "3a9159f071e4dd1c8c4f968607c30942",
  },
  shake256: {
    bytes: 32,
    hex: "369771bb2cb9d2b04c1d54cca487e372d9f187f73f7ba3f65b95c8ee7798c527",
  },
} as const;

const CANONICAL_ALGORITHMS = Object.keys(EXPECTED) as Array<keyof typeof EXPECTED>;

const HMAC_EXPECTED = {
  md5: "4e7eb9f9332e4eb1dc5a2d7d065ba1bf",
  sha1: "e2e1f7f597941d9b0021978618218a9e08731426",
  sha224: "d34c3a2647d4f82a4e6baeaa7d94379eafd931e0c16cbc44b4ba4d1e",
  sha256: "c7a7c96c73af32ea6e5b1ca6768b1d822249eb88f85160433d7b09bb2b21e170",
  sha384: "2483522dcb7cb65fa13f0a3c1efe867abbd79ecb19a6ba4bac45d4f4bac31de2e2463b11838b8055601fad73d0b5af4c",
  sha512:
    "f82266c950db24eba03f899466fdf905494709f09f98f4b7d7db31f1443a33b4fe5ca82f74fb360609d8a05a87fb065dd77bee912c27de89cbba7897061ac735",
  "sha512-224": "af398c7f21f58e1377580227a89590d3ab8be52b31182fad9ec4d667",
  "sha512-256": "0ed15b2750a2a7281e96af006ab79e82ed54a7a2081bdb49e70a70d8c6bfeff0",
  blake2b512:
    "9e66ba10f4d7e80abc2584150fc5f9a246634118280fd9ae086794d37cb9919d681ee285b68f9cec2eda9f878d157125cc465c8b0e3c023a7040ed0be7f25023",
} as const;

const HASH_CLASSES = [
  ["md4", Bun.MD4],
  ["md5", Bun.MD5],
  ["sha1", Bun.SHA1],
  ["sha224", Bun.SHA224],
  ["sha256", Bun.SHA256],
  ["sha384", Bun.SHA384],
  ["sha512", Bun.SHA512],
  ["sha512-256", Bun.SHA512_256],
] as const;

const encoder = new TextEncoder();

function expectExactError(callback: () => unknown, ErrorType: ErrorConstructor, message: string) {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ErrorType);
  expect((caught as Error | undefined)?.message).toBe(message);
}

function expectBytes(actual: ArrayBuffer | ArrayBufferView, expected: Uint8Array) {
  const bytes = actual instanceof ArrayBuffer
    ? new Uint8Array(actual)
    : new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
  expect(Buffer.from(bytes)).toEqual(Buffer.from(expected));
}

function expectFilled(bytes: Uint8Array, value: number) {
  expect(Array.from(bytes)).toEqual(Array(bytes.byteLength).fill(value));
}

async function eventuallyReleasesSome(refs: WeakRef<object>[]) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Bun.sleep(0);
    Bun.gc(true);
    releaseWeakRefs();
    await Bun.sleep(0);
    if (refs.some(ref => ref.deref() === undefined)) return true;
  }
  return false;
}

describe("native Bun.CryptoHasher algorithms and aliases", () => {
  test("advertises the complete canonical algorithm set", () => {
    expect(Bun.CryptoHasher.algorithms).toEqual(CANONICAL_ALGORITHMS);
    expect(Object.isFrozen(Bun.CryptoHasher.algorithms)).toBe(true);
  });

  for (const algorithm of CANONICAL_ALGORITHMS) {
    test(`${algorithm} one-shot, multipart, copy, and reset`, () => {
      const expected = EXPECTED[algorithm];
      expect(Bun.CryptoHasher.hash(algorithm, "hello world", "hex")).toBe(expected.hex);

      const hasher = new Bun.CryptoHasher(algorithm);
      expect(hasher.algorithm).toBe(algorithm);
      expect(hasher.byteLength).toBe(expected.bytes);
      expect(hasher.update("hello ")).toBe(hasher);

      const copied = hasher.copy();
      expect(copied.algorithm).toBe(algorithm);
      expect(copied.byteLength).toBe(expected.bytes);
      hasher.update("world");
      copied.update("world");
      expect(hasher.digest("hex")).toBe(expected.hex);
      expect(copied.digest("hex")).toBe(expected.hex);

      const defaultDigest = hasher.update("hello world").digest();
      expect(Buffer.isBuffer(defaultDigest)).toBe(true);
      expect(defaultDigest).toEqual(Buffer.from(expected.hex, "hex"));

      const cleanCopy = hasher.copy();
      cleanCopy.update("hello world");
      expect(cleanCopy.digest("hex")).toBe(expected.hex);
    });
  }

  const aliases = [
    ["rmd160", "ripemd160"],
    ["RMD_160", "ripemd160"],
    ["sha128", "sha1"],
    ["sha-1", "sha1"],
    ["SHA_1", "sha1"],
    ["sha/1", "sha1"],
    ["sha-224", "sha224"],
    ["sHa-256", "sha256"],
    ["sha-384", "sha384"],
    ["sha-512", "sha512"],
    ["sha-512/224", "sha512-224"],
    ["sha-512_224", "sha512-224"],
    ["sha-512224", "sha512-224"],
    ["sha512-224", "sha512-224"],
    ["sha-512/256", "sha512-256"],
    ["sha-512_256", "sha512-256"],
    ["sha-512256", "sha512-256"],
    ["sha512-256", "sha512-256"],
    ["SHA3_224", "sha3-224"],
    ["SHA3/256", "sha3-256"],
    ["SHA3-384", "sha3-384"],
    ["SHA3_512", "sha3-512"],
    ["SHAKE-128", "shake128"],
    ["SHAKE_256", "shake256"],
    ["BLAKE2B-256", "blake2b256"],
    ["BLAKE2B/512", "blake2b512"],
    ["BLAKE2S_256", "blake2s256"],
  ] as const;

  test("normalizes every documented alias family and Cottontail punctuation aliases", () => {
    for (const [alias, canonical] of aliases) {
      const hasher = new Bun.CryptoHasher(alias);
      expect(hasher.algorithm).toBe(canonical);
      hasher.update("hello world");
      expect(hasher.digest("hex")).toBe(EXPECTED[canonical].hex);
    }
  });
});

describe("native state snapshots mutable inputs", () => {
  test("CryptoHasher update consumes an offset view immediately", () => {
    const storage = Uint8Array.from([0xff, 0x61, 0x62, 0x63, 0xee]);
    const input = storage.subarray(1, 4);
    const hasher = new Bun.CryptoHasher("sha256").update(input);
    storage.fill(0x78);
    expect(hasher.digest("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("SHA class update consumes an offset view immediately", () => {
    const storage = Uint8Array.from([0xff, 0x61, 0x62, 0x63, 0xee]);
    const input = storage.subarray(1, 4);
    const hasher = new Bun.SHA256().update(input);
    storage.fill(0x78);
    expect(hasher.digest("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("HMAC snapshots its offset key view immediately", () => {
    const keyStorage = Uint8Array.from([0xff, 0x6b, 0x65, 0x79, 0xee]);
    const key = keyStorage.subarray(1, 4);
    const hmac = new Bun.CryptoHasher("sha256", key).update("data\n");
    keyStorage.fill(0x78);
    expect(hmac.digest("hex")).toBe(HMAC_EXPECTED.sha256);
  });
});

describe("CryptoHasher and HMAC lifecycle", () => {
  test("unkeyed digest resets, repeat digest hashes empty input, and copy after digest is clean", () => {
    const hasher = new Bun.CryptoHasher("sha256").update("hello");
    expect(hasher.digest("hex")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(hasher.digest("hex")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    hasher.update("world");
    const copied = hasher.copy();
    expect(hasher.digest("hex")).toBe("486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7");
    expect(copied.digest("hex")).toBe("486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7");

    const cleanCopy = hasher.copy().update("hello world");
    expect(cleanCopy.digest("hex")).toBe(EXPECTED.sha256.hex);
  });

  test("copies branch independently", () => {
    const original = new Bun.CryptoHasher("sha256").update("prefix-");
    const copied = original.copy();
    original.update("left");
    copied.update("right");
    expect(original.digest("hex")).toBe(Bun.CryptoHasher.hash("sha256", "prefix-left", "hex"));
    expect(copied.digest("hex")).toBe(Bun.CryptoHasher.hash("sha256", "prefix-right", "hex"));
  });

  for (const [algorithm, expected] of Object.entries(HMAC_EXPECTED)) {
    test(`${algorithm} HMAC accepts current key forms and copies native state`, () => {
      const keyFactories = [
        () => "key",
        () => encoder.encode("key"),
        () => encoder.encode("key").buffer,
      ];
      for (const makeKey of keyFactories) {
        const hmac = new Bun.CryptoHasher(algorithm, makeKey()).update("data\n");
        const copied = hmac.copy();
        expect(hmac.algorithm).toBe(algorithm);
        expect(hmac.byteLength).toBe(expected.length / 2);
        expect(hmac.digest("hex")).toBe(expected);
        expect(copied.digest("hex")).toBe(expected);
      }
    });
  }

  test("HMAC digest consumes the state with exact Cottontail errors", () => {
    const hmac = new Bun.CryptoHasher("sha256", "key").update("data\n");
    expect(hmac.algorithm).toBe("sha256");
    expect(hmac.digest("hex")).toBe(HMAC_EXPECTED.sha256);
    expect(hmac.algorithm).toBe("sha256");
    expectExactError(() => hmac.digest(), Error, "Digest already called");
    expectExactError(() => hmac.update("more"), Error, "Digest already called");
    expectExactError(() => hmac.copy(), Error, "CryptoHasher hasher already digested");
    expectExactError(() => hmac.byteLength, Error, "CryptoHasher hasher already digested");
  });

  test("preserves the current keyed algorithm restrictions and null-key error", () => {
    const rejected = CANONICAL_ALGORITHMS.filter(
      algorithm => !Object.prototype.hasOwnProperty.call(HMAC_EXPECTED, algorithm),
    );
    for (const algorithm of rejected) {
      expectExactError(
        () => new Bun.CryptoHasher(algorithm, "key"),
        Error,
        `${algorithm} is not supported`,
      );
      expect(() => new Bun.CryptoHasher(algorithm)).not.toThrow();
    }
    expectExactError(
      () => new Bun.CryptoHasher("sha256", null as never),
      TypeError,
      "CryptoHasher update requires data",
    );
  });
});

describe("output encodings and target views", () => {
  test("CryptoHasher and SHA classes preserve every digest encoding", () => {
    const expectedBytes = Buffer.from(EXPECTED.sha256.hex, "hex");
    const encodings = ["utf8", "ucs2", "utf16le", "latin1", "ascii", "base64", "base64url", "hex"] as const;

    for (const encoding of encodings) {
      expect(new Bun.CryptoHasher("sha256").update("hello world").digest(encoding)).toBe(
        expectedBytes.toString(encoding),
      );
      expect(Bun.SHA256.hash("hello world", encoding)).toBe(expectedBytes.toString(encoding));
    }

    for (const output of [
      new Bun.CryptoHasher("sha256").update("hello world").digest(),
      new Bun.CryptoHasher("sha256").update("hello world").digest("buffer"),
      new Bun.CryptoHasher("sha256").update("hello world").digest(null as never),
      new Bun.SHA256().update("hello world").digest(),
      Bun.SHA256.hash("hello world"),
    ]) {
      expect(Buffer.isBuffer(output)).toBe(true);
      expect(output).toEqual(expectedBytes);
    }
  });

  test("input string encodings remain supported by both state lanes", () => {
    const hexInput = Buffer.from("hello world").toString("hex");
    const base64Input = Buffer.from("hello world").toString("base64");
    expect(new Bun.CryptoHasher("sha256").update(hexInput, "hex").digest("hex")).toBe(EXPECTED.sha256.hex);
    expect(new Bun.CryptoHasher("sha256").update(base64Input, "base64").digest("hex")).toBe(EXPECTED.sha256.hex);
    expect(new Bun.SHA256().update(hexInput, "hex").digest("hex")).toBe(EXPECTED.sha256.hex);
    expect(new Bun.SHA256().update(base64Input, "base64").digest("hex")).toBe(EXPECTED.sha256.hex);
  });

  test("CryptoHasher honors DataView offsets, returns the target, and leaves suffixes untouched", () => {
    const expected = Buffer.from(EXPECTED.sha256.hex, "hex");
    const backing = new Uint8Array(51).fill(0xa5);
    const target = new DataView(backing.buffer, 7, 37);
    const hasher = new Bun.CryptoHasher("sha256").update("hello world");

    expectExactError(
      () => hasher.digest(new Uint8Array(31)),
      TypeError,
      "TypedArray must be at least 32 bytes",
    );
    expect(hasher.digest(target as never)).toBe(target);
    expectBytes(new Uint8Array(backing.buffer, 7, 32), expected);
    expectFilled(backing.subarray(0, 7), 0xa5);
    expectFilled(backing.subarray(39), 0xa5);

    const staticBacking = new Uint8Array(40).fill(0x5a);
    expect(Bun.CryptoHasher.hash("sha256", "hello world", staticBacking.buffer as never)).toBe(
      staticBacking.buffer,
    );
    expectBytes(staticBacking.subarray(0, 32), expected);
    expectFilled(staticBacking.subarray(32), 0x5a);
  });

  test("HMAC validates an undersized target before consuming and can retry", () => {
    const hmac = new Bun.CryptoHasher("sha256", "key").update("data\n");
    expectExactError(
      () => hmac.digest(new Uint8Array(31)),
      TypeError,
      "TypedArray must be at least 32 bytes",
    );
    expect(hmac.digest("hex")).toBe(HMAC_EXPECTED.sha256);
  });

  test("SHA target views preserve offsets and suffixes", () => {
    const expected = Buffer.from(EXPECTED.sha256.hex, "hex");
    const backing = new Uint8Array(52).fill(0x3c);
    const target = new Uint16Array(backing.buffer, 6, 18);
    const hasher = new Bun.SHA256().update("hello world");

    expect(hasher.digest(target)).toBe(target);
    expectBytes(new Uint8Array(backing.buffer, 6, 32), expected);
    expectFilled(backing.subarray(0, 6), 0x3c);
    expectFilled(backing.subarray(38), 0x3c);
  });

  test("SHA output errors consume the wrapper and preserve exact lifecycle errors", () => {
    const tooSmall = new Bun.SHA256().update("hello world");
    const className = tooSmall.constructor.name;
    expectExactError(
      () => tooSmall.digest(new Uint8Array(31)),
      TypeError,
      "TypedArray must be at least 32 bytes",
    );
    expectExactError(
      () => tooSmall.digest("hex"),
      Error,
      `${className} hasher already digested, create a new instance to digest again`,
    );
    expectExactError(
      () => tooSmall.update("more"),
      Error,
      `${className} hasher already digested, create a new instance to update`,
    );

    const badEncoding = new Bun.SHA256().update("hello world");
    expectExactError(
      () => badEncoding.digest("bogus" as never),
      TypeError,
      "Unknown encoding: bogus",
    );
    expectExactError(
      () => badEncoding.digest(),
      Error,
      `${badEncoding.constructor.name} hasher already digested, create a new instance to digest again`,
    );
  });
});

describe("Bun SHA-class state lane", () => {
  for (const [algorithm, Hash] of HASH_CLASSES) {
    test(`${algorithm} multipart state and terminal errors`, () => {
      const expected = EXPECTED[algorithm];
      expect(Hash.hash("hello world", "hex")).toBe(expected.hex);

      const hasher = new Hash();
      expect(hasher.byteLength).toBe(expected.bytes);
      expect(hasher.update("hello ")).toBe(hasher);
      hasher.update("world");
      expect(hasher.digest("hex")).toBe(expected.hex);
      expect(hasher.byteLength).toBe(expected.bytes);
      expectExactError(
        () => hasher.digest(),
        Error,
        `${Hash.name} hasher already digested, create a new instance to digest again`,
      );
      expectExactError(
        () => hasher.update("again"),
        Error,
        `${Hash.name} hasher already digested, create a new instance to update`,
      );
    });
  }
});

describe("Blob and File inputs", () => {
  test("Blob and web File work for CryptoHasher and SHA instance/static paths", () => {
    const inputs = [
      new Blob(["hello ", encoder.encode("world")], { type: "text/plain" }),
      new File(["hello ", encoder.encode("world")], "payload.txt", { type: "text/plain" }),
    ];

    for (const input of inputs) {
      expect(Bun.CryptoHasher.hash("sha256", input, "hex")).toBe(EXPECTED.sha256.hex);
      expect(new Bun.CryptoHasher("sha256").update(input).digest("hex")).toBe(EXPECTED.sha256.hex);
      expect(Bun.SHA256.hash(input, "hex")).toBe(EXPECTED.sha256.hex);
      expect(new Bun.SHA256().update(input).digest("hex")).toBe(EXPECTED.sha256.hex);
    }
  });

  test("Bun.file remains rejected with the exact Cottontail error", () => {
    const file = Bun.file(import.meta.path);
    const expectedMessage = "Bun.file is not supported by CryptoHasher";
    expectExactError(
      () => Bun.CryptoHasher.hash("sha1", file),
      TypeError,
      expectedMessage,
    );
    expectExactError(
      () => new Bun.CryptoHasher("sha1").update(file),
      TypeError,
      expectedMessage,
    );
    expectExactError(
      () => Bun.SHA1.hash(file),
      TypeError,
      expectedMessage,
    );
    expectExactError(
      () => new Bun.SHA1().update(file),
      TypeError,
      expectedMessage,
    );
  });

  test("missing and null update inputs preserve exact validation errors", () => {
    const missing = new Bun.CryptoHasher("sha1");
    expectExactError(
      () => missing.update(),
      TypeError,
      "CryptoHasher update requires data",
    );
    expectExactError(
      () => missing.update(undefined),
      TypeError,
      "CryptoHasher update requires data",
    );
    expectExactError(
      () => missing.update(null),
      TypeError,
      "CryptoHasher update requires data",
    );
  });
});

describe("SHAKE fixed output length", () => {
  for (const algorithm of ["shake128", "shake256"] as const) {
    test(`${algorithm} preserves default output length across copy, reset, and oversized targets`, () => {
      const expected = EXPECTED[algorithm];
      const hasher = new Bun.CryptoHasher(algorithm).update("hello ");
      const copied = hasher.copy();
      hasher.update("world");
      copied.update("world");
      expect(hasher.digest("hex")).toBe(expected.hex);
      expect(copied.digest("hex")).toBe(expected.hex);

      const backing = new Uint8Array(73).fill(0xcc);
      const target = new Uint8Array(backing.buffer, 4, 65);
      hasher.update("hello world");
      expect(hasher.digest(target)).toBe(target);
      expectBytes(target.subarray(0, expected.bytes), Buffer.from(expected.hex, "hex"));
      expectFilled(target.subarray(expected.bytes), 0xcc);
      expectFilled(backing.subarray(0, 4), 0xcc);
      expectFilled(backing.subarray(69), 0xcc);

      hasher.update("hello world");
      expectExactError(
        () => hasher.digest(new Uint8Array(expected.bytes - 1)),
        TypeError,
        `TypedArray must be at least ${expected.bytes} bytes`,
      );
      expect(hasher.digest("hex")).toBe(expected.hex);
    });
  }
});

describe("native handle lifetime", () => {
  test("live hashers do not retain update buffers or HMAC key buffers", async () => {
    const streamingHasher = new Bun.CryptoHasher("sha256");
    const updateRefs: WeakRef<object>[] = [];
    (() => {
      for (let index = 0; index < 48; index += 1) {
        const backing = new ArrayBuffer(64 * 1024);
        const chunk = new Uint8Array(backing);
        chunk[0] = index;
        updateRefs.push(new WeakRef(backing));
        streamingHasher.update(chunk);
      }
    })();

    const hmacs: Bun.CryptoHasher[] = [];
    const keyRefs: WeakRef<object>[] = [];
    (() => {
      for (let index = 0; index < 32; index += 1) {
        const backing = new ArrayBuffer(64);
        const key = new Uint8Array(backing, 7, 32);
        key.fill(index);
        keyRefs.push(new WeakRef(backing));
        hmacs.push(new Bun.CryptoHasher("sha256", key).update("data\n"));
      }
    })();

    expect(await eventuallyReleasesSome(updateRefs)).toBe(true);
    expect(await eventuallyReleasesSome(keyRefs)).toBe(true);
    expect(streamingHasher.digest().byteLength).toBe(32);
    for (const hmac of hmacs) expect(hmac.digest().byteLength).toBe(32);
  }, 0);

  test("copied states survive collection and finalization of their originals", async () => {
    const originalRefs: WeakRef<object>[] = [];
    const copies: Bun.CryptoHasher[] = [];
    (() => {
      for (let index = 0; index < 48; index += 1) {
        const original = new Bun.CryptoHasher("sha256").update("hello world");
        originalRefs.push(new WeakRef(original));
        copies.push(original.copy());
      }
    })();

    expect(await eventuallyReleasesSome(originalRefs)).toBe(true);
    for (const copied of copies) expect(copied.digest("hex")).toBe(EXPECTED.sha256.hex);
  }, 0);

  test("partial, copied, reset, and consumed handles tolerate finalizer churn", async () => {
    const payload = new Uint8Array(257).fill(0x61);
    for (let round = 0; round < 4; round += 1) {
      for (let index = 0; index < 256; index += 1) {
        const hasher = new Bun.CryptoHasher(CANONICAL_ALGORITHMS[index % CANONICAL_ALGORITHMS.length]);
        hasher.update(payload);
        if ((index & 1) === 0) hasher.copy().update("copy-tail");
        if (index % 3 === 0) hasher.digest();

        const fixed = new Bun.SHA256().update(payload);
        if ((index & 1) === 0) fixed.digest();

        const hmac = new Bun.CryptoHasher("sha256", payload.subarray(0, 32)).update(payload);
        if (index % 3 === 0) hmac.copy();
        if (index % 4 === 0) hmac.digest();
      }
      await Bun.sleep(0);
      Bun.gc(true);
      releaseWeakRefs();
    }

    expect(Bun.CryptoHasher.hash("sha256", "hello world", "hex")).toBe(EXPECTED.sha256.hex);
    expect(Bun.SHA256.hash("hello world", "hex")).toBe(EXPECTED.sha256.hex);
  }, 0);
});
