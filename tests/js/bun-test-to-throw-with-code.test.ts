import { expect, test } from "bun:test";

test("ParseArrayIndex() should reject values that don't fit in a 32 bits size_t", () => {
  // Copied from Bun v1.3.10: test/js/node/buffer.test.js.
  const source = Buffer.alloc(1);
  const target = Buffer.alloc(1);
  expect(() => source.copy(target, 0, 0x100000000, 0x100000001)).toThrowWithCode(
    RangeError,
    "ERR_OUT_OF_RANGE",
  );
});

test("toThrowWithCode accepts subclasses and inherited code properties", () => {
  class CodedTypeError extends TypeError {}
  Object.defineProperty(CodedTypeError.prototype, "code", { value: "ERR_INHERITED" });

  let calls = 0;
  expect(() => {
    calls += 1;
    throw new CodedTypeError("coded");
  }).toThrowWithCode(TypeError, "ERR_INHERITED");
  expect(calls).toBe(1);
});

test("toThrowWithCode reports each failed requirement", () => {
  const coded = Object.assign(new TypeError("coded"), { code: "ERR_ACTUAL" });

  expect(() => expect(() => {}).toThrowWithCode(Error, "ERR_EXPECTED")).toThrow(
    "Received function did not throw",
  );
  expect(() => expect(() => { throw new Error("wrong class"); }).toThrowWithCode(TypeError, "ERR_EXPECTED")).toThrow(
    "Expected error to be instanceof TypeError; got Error",
  );
  expect(() => expect(() => { throw new Error("missing"); }).toThrowWithCode(Error, "ERR_EXPECTED")).toThrow(
    "Expected error to have property 'code'; got Error: missing",
  );
  expect(() => expect(() => { throw coded; }).toThrowWithCode(TypeError, "ERR_EXPECTED")).toThrow(
    "Expected error to have code 'ERR_EXPECTED'; got ERR_ACTUAL",
  );
});

test("toThrowWithCode is synchronous and follows custom matcher negation", () => {
  expect(() => expect(() => Promise.resolve()).toThrowWithCode(Error, "ERR_EXPECTED")).toThrow(
    "Received function did not throw",
  );
  expect(() => {}).not.toThrowWithCode(Error, "ERR_EXPECTED");
  expect(() => { throw null; }).not.toThrowWithCode(Error, "ERR_EXPECTED");

  const coded = Object.assign(new Error("coded"), { code: "ERR_EXPECTED" });
  expect(() => expect(() => { throw coded; }).not.toThrowWithCode(Error, "ERR_EXPECTED")).toThrow(
    "No message was specified for this matcher.",
  );
});
