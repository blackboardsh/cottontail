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

export class Assert {}
export class CallTracker {}

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

function isObject(value) {
  return value !== null && typeof value === "object";
}

function deepEqualValue(actual, expected, strict) {
  if (strict ? actual === expected : actual == expected) return true;
  if (!isObject(actual) || !isObject(expected)) return false;
  if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected) && strict) return false;

  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length) return false;
  for (let index = 0; index < actualKeys.length; index += 1) {
    if (actualKeys[index] !== expectedKeys[index]) return false;
    if (!deepEqualValue(actual[actualKeys[index]], expected[expectedKeys[index]], strict)) return false;
  }
  return true;
}

export function deepStrictEqual(actual, expected, message) {
  if (!deepEqualValue(actual, expected, true)) {
    throw new AssertionError({ actual, expected, message, operator: "deepStrictEqual" });
  }
}

export function notDeepStrictEqual(actual, expected, message) {
  if (deepEqualValue(actual, expected, true)) {
    throw new AssertionError({ actual, expected, message, operator: "notDeepStrictEqual" });
  }
}

export function deepEqual(actual, expected, message) {
  if (!deepEqualValue(actual, expected, false)) {
    throw new AssertionError({ actual, expected, message, operator: "deepEqual" });
  }
}

export function notDeepEqual(actual, expected, message) {
  if (deepEqualValue(actual, expected, false)) {
    throw new AssertionError({ actual, expected, message, operator: "notDeepEqual" });
  }
}

function expectedMatches(error, expected) {
  if (expected == null) return true;
  if (typeof expected === "function") return error instanceof expected || expected(error) === true;
  if (expected instanceof RegExp) return expected.test(String(error?.message ?? error));
  if (typeof expected === "object") {
    return Object.keys(expected).every((key) => deepEqualValue(error?.[key], expected[key], true));
  }
  return false;
}

export function throws(fn, expected, message) {
  if (typeof fn !== "function") throw new TypeError("assert.throws requires a function");
  try {
    fn();
  } catch (error) {
    if (!expectedMatches(error, expected)) {
      throw new AssertionError({ actual: error, expected, message, operator: "throws" });
    }
    return error;
  }
  throw new AssertionError({ actual: undefined, expected, message, operator: "throws" });
}

export function doesNotThrow(fn, expected, message) {
  if (typeof fn !== "function") throw new TypeError("assert.doesNotThrow requires a function");
  try {
    return fn();
  } catch (error) {
    if (expectedMatches(error, expected)) {
      throw new AssertionError({ actual: error, expected, message, operator: "doesNotThrow" });
    }
    throw error;
  }
}

export async function rejects(fn, expected, message) {
  try {
    const value = typeof fn === "function" ? fn() : fn;
    await value;
  } catch (error) {
    if (!expectedMatches(error, expected)) {
      throw new AssertionError({ actual: error, expected, message, operator: "rejects" });
    }
    return error;
  }
  throw new AssertionError({ actual: undefined, expected, message, operator: "rejects" });
}

export async function doesNotReject(fn, expected, message) {
  try {
    const value = typeof fn === "function" ? fn() : fn;
    return await value;
  } catch (error) {
    if (expectedMatches(error, expected)) {
      throw new AssertionError({ actual: error, expected, message, operator: "doesNotReject" });
    }
    throw error;
  }
}

export function match(string, regexp, message) {
  if (!(regexp instanceof RegExp)) throw new TypeError("assert.match requires a RegExp");
  if (!regexp.test(String(string))) {
    throw new AssertionError({ actual: string, expected: regexp, message, operator: "match" });
  }
}

export function doesNotMatch(string, regexp, message) {
  if (!(regexp instanceof RegExp)) throw new TypeError("assert.doesNotMatch requires a RegExp");
  if (regexp.test(String(string))) {
    throw new AssertionError({ actual: string, expected: regexp, message, operator: "doesNotMatch" });
  }
}

export function ifError(value) {
  if (value) throw value instanceof Error ? value : new AssertionError({ actual: value, expected: null, operator: "ifError" });
}

export function partialDeepStrictEqual(actual, expected, message) {
  if (!isObject(actual) || !isObject(expected)) return deepStrictEqual(actual, expected, message);
  for (const key of Object.keys(expected)) {
    deepStrictEqual(actual[key], expected[key], message);
  }
}

const assert = Object.assign(ok, {
  Assert,
  AssertionError,
  CallTracker,
  deepEqual,
  deepStrictEqual,
  doesNotMatch,
  doesNotReject,
  doesNotThrow,
  equal,
  fail,
  ifError,
  match,
  notDeepEqual,
  notDeepStrictEqual,
  notEqual,
  notStrictEqual,
  ok,
  partialDeepStrictEqual,
  rejects,
  strict: null,
  strictEqual,
  throws,
});

assert.strict = assert;
export const strict = assert;

export default assert;
