import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";

function referenceCompare(
  left: Uint8Array,
  leftStart: number,
  leftEnd: number,
  right: Uint8Array,
  rightStart: number,
  rightEnd: number,
) {
  const length = Math.min(leftEnd - leftStart, rightEnd - rightStart);
  for (let index = 0; index < length; index += 1) {
    if (left[leftStart + index] !== right[rightStart + index]) {
      return left[leftStart + index] < right[rightStart + index] ? -1 : 1;
    }
  }
  const leftLength = leftEnd - leftStart;
  const rightLength = rightEnd - rightStart;
  return leftLength === rightLength ? 0 : leftLength < rightLength ? -1 : 1;
}

function makeBytes(length: number, seed: number) {
  const output = Buffer.allocUnsafe(length);
  let value = seed >>> 0;
  for (let index = 0; index < output.length; index += 1) {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = value >>> 24;
  }
  return output;
}

function referenceSearch(haystack: Uint8Array, needle: Uint8Array, byteOffset: number, forward: boolean) {
  let offset = Number(byteOffset);
  if (Number.isNaN(offset)) offset = forward ? 0 : haystack.length - 1;
  else offset = Math.trunc(offset);
  if (offset < 0) offset += haystack.length;
  if (forward) {
    if (offset < 0) offset = 0;
    if (offset >= haystack.length) return -1;
  } else {
    if (offset < 0) return -1;
    offset = Math.min(offset, haystack.length - 1);
  }

  if (needle.length === 0) return Math.max(0, Math.min(haystack.length, offset));
  if (needle.length > haystack.length) return -1;
  const maximum = haystack.length - needle.length;
  if (!forward) offset = Math.min(offset, maximum);

  for (
    let candidate = offset;
    forward ? candidate <= maximum : candidate >= 0;
    candidate += forward ? 1 : -1
  ) {
    let equal = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[candidate + index] !== needle[index]) {
        equal = false;
        break;
      }
    }
    if (equal) return candidate;
  }
  return -1;
}

test("native Buffer host operations are installed", () => {
  expect(typeof cottontail.bufferCompare).toBe("function");
  expect(typeof cottontail.bufferIndexOf).toBe("function");
  expect(typeof cottontail.bufferFillPattern).toBe("function");
});

test("compare and equals preserve lexicographic behavior across native thresholds", () => {
  for (const length of [0, 1, 63, 64, 65, 4_096, 65_536]) {
    const left = makeBytes(length, 1);
    const right = Buffer.from(left);
    expect(Buffer.compare(left, right)).toBe(0);
    expect(left.equals(right)).toBe(true);

    if (length > 0) {
      right[length - 1] ^= 0xff;
      expect(Buffer.compare(left, right)).toBe(referenceCompare(left, 0, length, right, 0, length));
      expect(left.equals(right)).toBe(false);
    }
  }

  const left = makeBytes(8_192, 2);
  const right = new Uint8Array(left);
  right[7_000] ^= 1;
  expect(left.compare(right, 113, 8_000, 97, 7_984)).toBe(
    referenceCompare(left, 97, 7_984, right, 113, 8_000),
  );
});

test("multi-byte search preserves offsets, directions, and UTF-16 alignment", () => {
  const haystack = makeBytes(65_536, 3);
  const needle = Buffer.from("cottontail-native-buffer-needle");
  needle.copy(haystack, 257);
  needle.copy(haystack, 48_123);

  expect(haystack.indexOf(needle)).toBe(257);
  expect(haystack.indexOf(needle, 258)).toBe(48_123);
  expect(haystack.lastIndexOf(needle)).toBe(48_123);
  expect(haystack.lastIndexOf(needle, 48_122)).toBe(257);
  expect(haystack.includes(needle, 258)).toBe(true);
  expect(haystack.indexOf(Buffer.from("definitely-not-present"))).toBe(-1);

  const wide = Buffer.from("xxneedlexxneedle", "utf16le");
  expect(wide.indexOf("needle", 1, "utf16le")).toBe(4);
  expect(wide.indexOf("needle", 5, "utf16le")).toBe(4);
  expect(wide.lastIndexOf("needle", wide.length, "utf16le")).toBe(20);
  expect(wide.lastIndexOf("needle", 19, "utf16le")).toBe(4);

  let state = 0xc0770a11;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  for (let iteration = 0; iteration < 256; iteration += 1) {
    const randomHaystack = makeBytes(64 + random() % 2_048, random());
    const randomNeedle = makeBytes(1 + random() % 32, random());
    if (iteration % 3 !== 0 && randomNeedle.length <= randomHaystack.length) {
      const insertion = random() % (randomHaystack.length - randomNeedle.length + 1);
      randomNeedle.copy(randomHaystack, insertion);
    }
    const offset = Number(random() % (randomHaystack.length * 3 + 1)) - randomHaystack.length;
    expect(randomHaystack.indexOf(randomNeedle, offset)).toBe(
      referenceSearch(randomHaystack, randomNeedle, offset, true),
    );
    expect(randomHaystack.lastIndexOf(randomNeedle, offset)).toBe(
      referenceSearch(randomHaystack, randomNeedle, offset, false),
    );
  }
});

test("repeated fill snapshots overlap and treats typed views as raw bytes", () => {
  const overlapping = Buffer.from("abcdefghijkl");
  expect(overlapping.fill(overlapping.subarray(2, 5))).toBe(overlapping);
  expect(overlapping.toString()).toBe("cdecdecdecde");

  const partialOverlap = Buffer.from("abcdefghijkl");
  partialOverlap.fill(partialOverlap.subarray(0, 4), 2, 12);
  expect(partialOverlap.toString()).toBe("ababcdabcdab");

  const typed = Buffer.alloc(130);
  typed.fill(new Uint16Array([0x1234, 0x5678]));
  expect(typed.subarray(0, 12).toString("hex")).toBe("341278563412785634127856");

  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const dataView = Buffer.alloc(130);
  dataView.fill(new DataView(bytes.buffer, 1, 2));
  expect(dataView.subarray(0, 9).toString("hex")).toBe("020302030203020302");
});

test("public Buffer method descriptors remain unchanged", () => {
  for (const [target, name] of [
    [Buffer, "compare"],
    [Buffer.prototype, "equals"],
    [Buffer.prototype, "indexOf"],
    [Buffer.prototype, "lastIndexOf"],
    [Buffer.prototype, "includes"],
    [Buffer.prototype, "fill"],
    [Buffer.prototype, "copy"],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    expect(descriptor).toMatchObject({
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
});
