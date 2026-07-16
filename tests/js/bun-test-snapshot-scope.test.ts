import { expect, test } from "bun:test";

let staleExpectation: ReturnType<typeof expect>;

test("captures snapshot ownership", () => {
  staleExpectation = expect(25);
});

test("rejects an expectation from another test", () => {
  expect(() => staleExpectation.toMatchSnapshot()).toThrow(
    "Snapshot matchers cannot be used outside of a test",
  );
});
