import { expect, test } from "bun:test";

let matcherSettled = false;

test("waits for an un-awaited resolves matcher at invocation", () => {
  const value = new Promise<number>(resolve => {
    setTimeout(() => {
      matcherSettled = true;
      resolve(42);
    }, 10);
  });

  expect(value).resolves.toBe(42);
  expect(matcherSettled).toBe(true);
});

test("does not advance until the matcher settles", () => {
  expect(matcherSettled).toBe(true);
});
