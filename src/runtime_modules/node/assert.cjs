class AssertionError extends Error {
  constructor(options = {}) {
    super(options.message || "Assertion failed");
    this.name = "AssertionError";
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator;
    this.code = "ERR_ASSERTION";
  }
}

function fail(message = "Assertion failed") {
  throw new AssertionError({ message });
}

function ok(value, message) {
  if (!value) {
    throw new AssertionError({
      actual: value,
      expected: true,
      message,
      operator: "==",
    });
  }
}

function equal(actual, expected, message) {
  if (actual != expected) {
    throw new AssertionError({ actual, expected, message, operator: "==" });
  }
}

function notEqual(actual, expected, message) {
  if (actual == expected) {
    throw new AssertionError({ actual, expected, message, operator: "!=" });
  }
}

function strictEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new AssertionError({ actual, expected, message, operator: "===" });
  }
}

function notStrictEqual(actual, expected, message) {
  if (actual === expected) {
    throw new AssertionError({ actual, expected, message, operator: "!==" });
  }
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(Object(value)).sort());
}

function deepStrictEqual(actual, expected, message) {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new AssertionError({ actual, expected, message, operator: "deepStrictEqual" });
  }
}

function notDeepStrictEqual(actual, expected, message) {
  if (stableJson(actual) === stableJson(expected)) {
    throw new AssertionError({ actual, expected, message, operator: "notDeepStrictEqual" });
  }
}

const assert = Object.assign(ok, {
  AssertionError,
  deepStrictEqual,
  doesNotThrow(fn) {
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
module.exports = assert;
