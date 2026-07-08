export class AssertionError extends Error {
  constructor(options = {}) {
    super(options.message || "Assertion failed");
    this.name = "AssertionError";
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator;
    this.code = "ERR_ASSERTION";
  }
}

export function fail(message = "Assertion failed") {
  throw new AssertionError({ message });
}

export function ok(value, message) {
  if (!value) {
    throw new AssertionError({
      actual: value,
      expected: true,
      message,
      operator: "==",
    });
  }
}

export function equal(actual, expected, message) {
  if (actual != expected) {
    throw new AssertionError({ actual, expected, message, operator: "==" });
  }
}

export function notEqual(actual, expected, message) {
  if (actual == expected) {
    throw new AssertionError({ actual, expected, message, operator: "!=" });
  }
}

export function strictEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new AssertionError({ actual, expected, message, operator: "===" });
  }
}

export function notStrictEqual(actual, expected, message) {
  if (actual === expected) {
    throw new AssertionError({ actual, expected, message, operator: "!==" });
  }
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(Object(value)).sort());
}

export function deepStrictEqual(actual, expected, message) {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new AssertionError({ actual, expected, message, operator: "deepStrictEqual" });
  }
}

export function notDeepStrictEqual(actual, expected, message) {
  if (stableJson(actual) === stableJson(expected)) {
    throw new AssertionError({ actual, expected, message, operator: "notDeepStrictEqual" });
  }
}

const assert = Object.assign(ok, {
  AssertionError,
  deepStrictEqual,
  doesNotThrow(fn, message) {
    return fn();
  },
  equal,
  fail,
  ifError(value) {
    if (value) throw value;
  },
  notDeepStrictEqual,
  notEqual,
  notStrictEqual,
  ok,
  strict: null,
  strictEqual,
});

assert.strict = assert;

export default assert;
