import { expect, test } from "bun:test";

test("deep equality handles large arrays without exhausting the stack", () => {
  const actual = Array.from({ length: 40_000 }, (_, index) => ({ key: `item-${index}` }));
  const expected = Array.from({ length: 40_000 }, (_, index) => ({ key: `item-${index}` }));
  expect(actual).toEqual(expected);
});
