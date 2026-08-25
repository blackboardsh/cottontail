import { expect, test } from "bun:test";

const dnsNamespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const urlNamespace = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const nativeUUIDBeforeActivation = [
  typeof cottontail.randomUUIDv5Native,
  typeof cottontail.randomUUIDv7Native,
];
void (globalThis as any).Cottontail.uuid;

function expectCodedError(
  operation: () => unknown,
  constructor: typeof TypeError | typeof RangeError,
  code: string,
  message: string,
) {
  try {
    operation();
    throw new Error("operation did not throw");
  } catch (error) {
    expect(error).toBeInstanceOf(constructor);
    expect((error as Error & { code?: string }).code).toBe(code);
    expect((error as Error).message).toBe(message);
  }
}

test("native UUID bindings install only when the capability activates", () => {
  expect(nativeUUIDBeforeActivation).toEqual(["undefined", "undefined"]);
  expect(typeof cottontail.randomUUIDv5Native).toBe("function");
  expect(typeof cottontail.randomUUIDv7Native).toBe("function");
});

test("randomUUIDv5 matches RFC vectors and namespace aliases", () => {
  expect(Bun.randomUUIDv5("hello.example.com", dnsNamespace)).toBe(
    "fdda765f-fc57-5604-a269-52a7df8164ec",
  );
  expect(Bun.randomUUIDv5("http://example.com/hello", urlNamespace)).toBe(
    "3bbcee75-cecc-5b56-8031-b6641c1ed1f1",
  );
  expect(Bun.randomUUIDv5("hello", "0f5abcd1-c194-47f3-905b-2df7263a084b")).toBe(
    "90123e1c-7512-523e-bb28-76fab9f2f73d",
  );
  expect(Bun.randomUUIDv5("hello.example.com", "DNS")).toBe(
    Bun.randomUUIDv5("hello.example.com", "dns"),
  );
  expect(Bun.randomUUIDv5("test", "url")).not.toBe(Bun.randomUUIDv5("test", "oid"));
  expect(Bun.randomUUIDv5("test", "oid")).not.toBe(Bun.randomUUIDv5("test", "x500"));
});

test("randomUUIDv5 accepts BufferSource names and namespaces", () => {
  const name = new TextEncoder().encode("hello.example.com");
  const namespace = Uint8Array.from(
    dnsNamespace.replaceAll("-", "").match(/../g)!.map(value => Number.parseInt(value, 16)),
  );
  const expected = Bun.randomUUIDv5("hello.example.com", dnsNamespace);

  expect(Bun.randomUUIDv5(name, namespace)).toBe(expected);
  expect(Bun.randomUUIDv5(name.buffer, new DataView(namespace.buffer))).toBe(expected);
  expect(Bun.randomUUIDv5(name.subarray(0), namespace.subarray(0))).toBe(expected);
  if (typeof SharedArrayBuffer === "function") {
    const sharedName = new SharedArrayBuffer(name.byteLength);
    new Uint8Array(sharedName).set(name);
    const sharedNamespace = new SharedArrayBuffer(namespace.byteLength);
    new Uint8Array(sharedNamespace).set(namespace);
    expect(Bun.randomUUIDv5(sharedName, sharedNamespace)).toBe(expected);
  }
});

test("randomUUIDv5 uses Bun UTF-8 replacement semantics for lone surrogates", () => {
  expect(Bun.randomUUIDv5("\ud800", "dns")).toBe(
    "67d0a96b-f0b9-5bb4-b673-a604fae2abbb",
  );
  expect(Bun.randomUUIDv5("a\udc00b", "dns")).toBe(
    "7ddcff48-f6da-51a8-84aa-6fabda0e46f1",
  );
});

test("randomUUIDv5 preserves all output encodings", () => {
  const hex = Bun.randomUUIDv5("hello.example.com", "dns");
  const expected = Buffer.from(hex.replaceAll("-", ""), "hex");

  expect(Bun.randomUUIDv5("hello.example.com", "dns", "buffer")).toEqual(expected);
  expect(Bun.randomUUIDv5("hello.example.com", "dns", "base64")).toBe(expected.toString("base64"));
  expect(Bun.randomUUIDv5("hello.example.com", "dns", "base64url")).toBe(expected.toString("base64url"));
});

test("randomUUIDv5 preserves Bun validation errors", () => {
  expectCodedError(
    () => Bun.randomUUIDv5(),
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "name" argument must be specified',
  );
  expectCodedError(
    () => Bun.randomUUIDv5("name"),
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "namespace" argument must be specified',
  );
  expectCodedError(
    () => Bun.randomUUIDv5("name", "invalid"),
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    "Invalid UUID format for namespace",
  );
  expectCodedError(
    () => Bun.randomUUIDv5("name", new Uint8Array(15)),
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    "Namespace must be exactly 16 bytes",
  );
  expectCodedError(
    () => Bun.randomUUIDv5("name", "dns", "invalid"),
    TypeError,
    "ERR_UNKNOWN_ENCODING",
    "Encoding must be one of base64, base64url, hex, or buffer",
  );
});

test("randomUUIDv7 preserves timestamp overloads and bit layout", () => {
  const timestamp = 1_625_097_600_000;
  for (const input of [timestamp, new Date(timestamp)]) {
    const value = Bun.randomUUIDv7("hex", input);
    const bytes = Buffer.from(value.replaceAll("-", ""), "hex");
    expect(Number.parseInt(value.slice(0, 13).replace("-", ""), 16)).toBe(timestamp);
    expect(bytes[6] & 0xf0).toBe(0x70);
    expect(bytes[8] & 0xc0).toBe(0x80);
  }
  expect(Bun.randomUUIDv7(timestamp)).toStartWith("017a5f5d-");
});

test("randomUUIDv7 is unique and lexicographically monotonic across 12-bit boundaries", () => {
  const timestamp = 1_625_097_600_123;
  const values = Array.from({ length: 8_192 }, () => Bun.randomUUIDv7("hex", timestamp));
  expect(new Set(values).size).toBe(values.length);
  expect(values.toSorted()).toEqual(values);
});

test("randomUUIDv7 preserves all output encodings", () => {
  const timestamp = 1_625_097_600_456;
  const hex = Bun.randomUUIDv7("hex", timestamp);
  const buffer = Bun.randomUUIDv7("buffer", timestamp);
  const base64 = Bun.randomUUIDv7("base64", timestamp);
  const base64url = Bun.randomUUIDv7("base64url", timestamp);

  expect(hex).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(buffer).toBeInstanceOf(Buffer);
  expect(buffer.byteLength).toBe(16);
  expect(Buffer.from(base64, "base64").byteLength).toBe(16);
  expect(Buffer.from(base64url, "base64url").byteLength).toBe(16);
});

test("randomUUIDv7 preserves Bun validation errors", () => {
  expectCodedError(
    () => Bun.randomUUIDv7("invalid"),
    TypeError,
    "ERR_UNKNOWN_ENCODING",
    "Encoding must be one of base64, base64url, hex, or buffer",
  );
  expectCodedError(
    () => Bun.randomUUIDv7("hex", -1),
    RangeError,
    "ERR_OUT_OF_RANGE",
    'The value of "timestamp" is out of range. It must be >= 0 and <= 9007199254740991. Received -1',
  );
  expectCodedError(
    () => Bun.randomUUIDv7("hex", 1.5),
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "timestamp" property must be of type integer. Received number',
  );
  expectCodedError(
    () => Bun.randomUUIDv7("hex", Infinity),
    RangeError,
    "ERR_OUT_OF_RANGE",
    'The value of "timestamp" is out of range. It must be >= 0 and <= 9007199254740991. Received Infinity',
  );
});
