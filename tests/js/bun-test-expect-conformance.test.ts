import { expect, test } from "bun:test";

test("toContain uses identity while toContainEqual uses deep equality", () => {
  const value = {};
  expect([value]).toContain(value);
  expect([{}]).not.toContain({});
  expect([[1]]).not.toContain([1]);
  expect([NaN]).toContain(NaN);
  expect([-0]).not.toContain(0);
  expect([1]).not.toContain(expect.any(Number));
  expect([{}]).toContainEqual({});
  expect(() => expect(null).toContain(1)).toThrow(
    "Received value must be an array type, or both received and expected values must be strings.",
  );
});

test("toBeCloseTo validates numeric inputs and handles infinities", () => {
  expect(Infinity).toBeCloseTo(Infinity);
  expect(Infinity).toBeCloseTo(-Infinity);
  expect(1).not.toBeCloseTo(Infinity);
  expect(NaN).not.toBeCloseTo(NaN);
  expect(() => expect("1").toBeCloseTo(1)).toThrow(TypeError);
  expect(() => expect(1).toBeCloseTo("1" as any)).toThrow(TypeError);
  expect(() => expect(1n).toBeCloseTo(1)).toThrow(TypeError);
  expect(() => expect(1).toBeCloseTo(1n as any)).toThrow(TypeError);
  expect(() => expect(1).toBeCloseTo(1, "2" as any)).toThrow(TypeError);
});

test("typed matcher arguments follow Bun validation", () => {
  expect(() => expect([1]).toBeArrayOfSize("1" as any)).toThrow(
    "toBeArrayOfSize() requires the first argument to be a number",
  );
  expect(() => expect([]).toBeArrayOfSize(-0)).toThrow(
    "toBeArrayOfSize() requires the first argument to be a number",
  );
  expect([]).not.toBeArrayOfSize(-1);
  expect(() => expect([]).toHaveLength("0" as any)).toThrow("Expected value must be a non-negative integer");
  expect([]).toHaveLength(-0);
  expect(() => expect(1).toBeTypeOf(123 as any)).toThrow("toBeTypeOf() requires a string argument");
  expect(() => expect(1).toBeTypeOf("invalid" as any)).toThrow("toBeTypeOf() requires a valid type string argument");
});

test("negative matcher includes Bun's half-unit boundary", () => {
  expect(-0.5).toBeNegative();
  expect(-0.499999).not.toBeNegative();
});

test("expectation metadata and unsupported serializer match Bun", () => {
  const expectation = expect(1);
  expect(Object.prototype.toString.call(expectation)).toBe("[object Expect]");
  expect(Object.keys(expectation)).toEqual([]);
  expect(expectation[Symbol.toStringTag]).toBe("Expect");
  expect(() => expect.addSnapshotSerializer({} as any)).toThrow("Not implemented");
});
