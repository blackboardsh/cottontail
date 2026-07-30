import { Buffer } from "node:buffer";
import { indexOfLine } from "bun";
import { expect, test } from "bun:test";

function asBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function referenceIndexOfLine(value: ArrayBuffer | ArrayBufferView, offset: unknown = 0): number {
  const bytes = asBytes(value);
  const startNumber = Number(offset);
  const start = Number.isFinite(startNumber) ? Math.max(0, Math.trunc(startNumber)) : 0;
  for (let index = start; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 10) return index;
  }
  return -1;
}

test("matches Bun's upstream line and non-number offset cases", () => {
  expect(indexOfLine(new Uint8ClampedArray(), {})).toBe(-1);
  expect(indexOfLine(new Uint8Array(), {})).toBe(-1);
  expect(indexOfLine(new Uint8Array(), null)).toBe(-1);
  expect(indexOfLine(new Uint8Array(), undefined)).toBe(-1);
  expect(indexOfLine(new Uint8Array(), Number.NaN)).toBe(-1);

  const bytes = new Uint8Array([104, 101, 108, 108, 111, 10, 119, 111, 114, 108, 100]);
  expect(indexOfLine(bytes, {})).toBe(5);
  expect(indexOfLine(bytes, "2")).toBe(5);

  const source = "\nconst a = 1;\n\nconst b = 2;\n\n😋const c = 3;\n";
  const buffer = Buffer.from(source);
  let byteOffset = 0;
  for (const expected of [0, 13, 14, 27, 28, 45]) {
    expect(indexOfLine(buffer, byteOffset)).toBe(expected);
    byteOffset = expected + 1;
  }
  expect(indexOfLine(buffer, byteOffset)).toBe(-1);
});

test("returns byte offsets for every supported buffer and view shape", () => {
  const storage = new ArrayBuffer(96);
  const all = new Uint8Array(storage);
  all.fill(0x61);
  all[7] = 10;
  all[29] = 10;
  all[71] = 10;

  const expected = 21;
  const views: ArrayBufferView[] = [
    new Uint8Array(storage, 8, 64),
    new Uint8ClampedArray(storage, 8, 64),
    new Int8Array(storage, 8, 64),
    new Uint16Array(storage, 8, 32),
    new Int32Array(storage, 8, 16),
    new Float64Array(storage, 8, 8),
    new BigUint64Array(storage, 8, 8),
    new DataView(storage, 8, 64),
    Buffer.from(storage, 8, 64),
  ];

  for (const view of views) {
    expect(indexOfLine(view)).toBe(expected);
    expect(indexOfLine(view, expected + 1)).toBe(63);
    expect(indexOfLine(view, 64)).toBe(-1);
  }
  expect(indexOfLine(storage)).toBe(7);

  const sliced = Buffer.from(storage).subarray(8, 72);
  expect(sliced.byteOffset).toBeGreaterThan(0);
  expect(indexOfLine(sliced)).toBe(expected);
});

test("treats CR as data and LF as the only line delimiter", () => {
  const bytes = Buffer.from("\rfirst\r\nsecond\nthird\r");
  expect(indexOfLine(bytes)).toBe(7);
  expect(indexOfLine(bytes, 8)).toBe(14);
  expect(indexOfLine(bytes, 15)).toBe(-1);
});

test("preserves offset conversion, truncation, and clamping", () => {
  const bytes = new Uint8Array([0, 10, 0, 10, 0]);
  const cases: Array<[unknown, number]> = [
    [undefined, 1],
    [null, 1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
    [Number.NEGATIVE_INFINITY, 1],
    [-100, 1],
    [-0, 1],
    [0.99, 1],
    [1.99, 1],
    [2.99, 3],
    ["2", 3],
    [{}, 1],
    [{ valueOf: () => 2.8 }, 3],
    [2n, 3],
    [5, -1],
    [Number.MAX_SAFE_INTEGER, -1],
  ];
  for (const [offset, expected] of cases) {
    expect(indexOfLine(bytes, offset)).toBe(expected);
  }

  const conversionError = new Error("offset conversion");
  expect(() => indexOfLine(bytes, Symbol("offset"))).toThrow();
  expect(() => indexOfLine(bytes, { valueOf: () => { throw conversionError; } })).toThrow(conversionError);
});

test("preserves sliced-view bounds on the native path", () => {
  const prefix = 1_024;
  const viewLength = 1_024 * 1_024;
  const newline = 384 * 1_024 + 73;
  const storage = new Uint8Array(prefix + viewLength + 1_024);
  storage.fill(0x61);
  storage[prefix - 1] = 10;
  storage[prefix + newline] = 10;
  storage[prefix + viewLength] = 10;

  const view = storage.subarray(prefix, prefix + viewLength);
  expect(indexOfLine(view)).toBe(newline);
  expect(indexOfLine(view, newline + 1)).toBe(-1);

  const dataView = new DataView(storage.buffer, prefix, viewLength);
  expect(indexOfLine(dataView)).toBe(newline);
  expect(indexOfLine(dataView, newline + 1)).toBe(-1);

  const buffer = Buffer.from(storage.buffer, prefix, viewLength);
  expect(indexOfLine(buffer)).toBe(newline);
  expect(indexOfLine(buffer, newline + 1)).toBe(-1);

  Object.defineProperty(view, "byteLength", { configurable: true, value: newline });
  expect(indexOfLine(view)).toBe(-1);
  Object.defineProperty(view, "byteLength", { configurable: true, value: viewLength + 1_024 });
  expect(indexOfLine(view)).toBe(newline);

  const bounded = new Uint8Array(512 * 1_024);
  bounded[300 * 1_024] = 10;
  Object.defineProperty(bounded, "byteLength", { value: 256 * 1_024 });
  expect(indexOfLine(bounded)).toBe(-1);

  const raw = new ArrayBuffer(512 * 1_024);
  new Uint8Array(raw)[raw.byteLength - 1] = 10;
  expect(indexOfLine(raw)).toBe(raw.byteLength - 1);
});

test("preserves shared and detached buffer behavior", () => {
  if (typeof SharedArrayBuffer === "function") {
    const shared = new SharedArrayBuffer(4 * 1024);
    const sharedBytes = new Uint8Array(shared);
    sharedBytes[3 * 1024] = 10;
    expect(indexOfLine(shared)).toBe(3 * 1024);
    expect(indexOfLine(sharedBytes)).toBe(3 * 1024);
    expect(indexOfLine(new DataView(shared))).toBe(3 * 1024);
  }

  const detachedStorage = new ArrayBuffer(4 * 1024);
  const detachedBytes = new Uint8Array(detachedStorage);
  const detachedView = new DataView(detachedStorage);
  structuredClone(detachedStorage, { transfer: [detachedStorage] });
  expect(indexOfLine(detachedBytes)).toBe(-1);
  expect(() => indexOfLine(detachedView)).toThrow();

  const offsetDetachedStorage = new ArrayBuffer(4 * 1024);
  const offsetDetachedBytes = new Uint8Array(offsetDetachedStorage);
  offsetDetachedBytes[3 * 1024] = 10;
  expect(indexOfLine(offsetDetachedBytes, {
    valueOf() {
      structuredClone(offsetDetachedStorage, { transfer: [offsetDetachedStorage] });
      return 0;
    },
  })).toBe(-1);

  const getterDetachedStorage = new ArrayBuffer(512 * 1_024);
  const getterDetachedBytes = new Uint8Array(getterDetachedStorage);
  Object.defineProperty(getterDetachedBytes, "byteLength", {
    get() {
      if (getterDetachedStorage.byteLength !== 0) {
        structuredClone(getterDetachedStorage, { transfer: [getterDetachedStorage] });
      }
      return 512 * 1_024;
    },
  });
  expect(indexOfLine(getterDetachedBytes)).toBe(-1);
});

test("preserves asBuffer coercion and invalid-input errors", () => {
  expect(indexOfLine("one\ntwo")).toBe(3);
  expect(indexOfLine([1, 2, 10, 4] as never)).toBe(2);
  expect(indexOfLine(null as never)).toBe(-1);
  expect(indexOfLine(undefined as never)).toBe(-1);
  expect(() => indexOfLine(Symbol("value") as never)).toThrow();
});

test("matches the previous implementation across deterministic randomized inputs", () => {
  let state = 0x9e3779b9;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  const boundaryLengths = [
    0, 1, 2, 3, 15, 31, 32, 63, 64, 65, 127, 128, 129, 255, 256,
    511, 512, 1_023, 1_024, 1_025, 4_095, 4_096, 16_384, 65_536,
    262_143, 262_144, 262_145,
  ];
  const offsets: unknown[] = [
    undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -100, -0, 0,
    0.9, 1, 1.9, "2", {}, 3n, Number.MAX_SAFE_INTEGER,
  ];

  for (let iteration = 0; iteration < 600; iteration += 1) {
    const length = iteration < boundaryLengths.length
      ? boundaryLengths[iteration]
      : random() % 65_537;
    const prefix = (random() % 31) + 1;
    const suffix = (random() % 31) + 1;
    const storage = new Uint8Array(prefix + length + suffix);
    storage.fill(0x61);
    for (let count = random() % 6; count > 0 && length > 0; count -= 1) {
      storage[prefix + (random() % length)] = 10;
    }
    storage[prefix - 1] = 10;
    storage[prefix + length] = 10;

    const byteView = storage.subarray(prefix, prefix + length);
    const input: ArrayBufferView = iteration % 4 === 0
      ? byteView
      : iteration % 4 === 1
        ? new DataView(storage.buffer, prefix, length)
        : iteration % 4 === 2
          ? Buffer.from(storage.buffer, prefix, length)
          : new Uint8ClampedArray(storage.buffer, prefix, length);
    const offset = iteration % 5 === 0
      ? Math.max(0, length - 1)
      : iteration % 5 === 1
        ? length
        : iteration % 5 === 2
          ? length + 1
          : offsets[random() % offsets.length];
    expect(indexOfLine(input, offset)).toBe(referenceIndexOfLine(input, offset));
  }

  const large = new Uint8Array(2 * 1024 * 1024);
  large.fill(0x61);
  expect(indexOfLine(large)).toBe(-1);
  large[large.length - 1] = 10;
  expect(indexOfLine(large)).toBe(large.length - 1);
});
