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

function deepEqual(actual, expected, seen = new WeakMap()) {
  if (Object.is(actual, expected)) return true;
  if (actual === null || expected === null) return actual === expected;
  if (typeof actual !== "object" || typeof expected !== "object") return false;
  if (ArrayBuffer.isView(actual) || ArrayBuffer.isView(expected)) {
    if (!ArrayBuffer.isView(actual) || !ArrayBuffer.isView(expected)) return false;
    if (actual.byteLength !== expected.byteLength) return false;
    const left = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
    const right = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }
  if (actual instanceof Date || expected instanceof Date) {
    return actual instanceof Date && expected instanceof Date && actual.getTime() === expected.getTime();
  }
  if (actual instanceof RegExp || expected instanceof RegExp) {
    return actual instanceof RegExp && expected instanceof RegExp && String(actual) === String(expected);
  }
  if (seen.get(actual) === expected) return true;
  seen.set(actual, expected);
  if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false;
  if (actual instanceof Map || expected instanceof Map) {
    if (!(actual instanceof Map) || !(expected instanceof Map) || actual.size !== expected.size) return false;
    for (const [key, value] of actual) {
      if (!expected.has(key) || !deepEqual(value, expected.get(key), seen)) return false;
    }
    return true;
  }
  if (actual instanceof Set || expected instanceof Set) {
    if (!(actual instanceof Set) || !(expected instanceof Set) || actual.size !== expected.size) return false;
    for (const value of actual) {
      if (!expected.has(value)) return false;
    }
    return true;
  }
  const actualKeys = Reflect.ownKeys(actual);
  const expectedKeys = Reflect.ownKeys(expected);
  if (actualKeys.length !== expectedKeys.length) return false;
  actualKeys.sort((left, right) => String(left).localeCompare(String(right)));
  expectedKeys.sort((left, right) => String(left).localeCompare(String(right)));
  for (let index = 0; index < actualKeys.length; index += 1) {
    if (actualKeys[index] !== expectedKeys[index]) return false;
    if (!deepEqual(actual[actualKeys[index]], expected[expectedKeys[index]], seen)) return false;
  }
  return true;
}

function deepStrictEqual(actual, expected, message) {
  if (!deepEqual(actual, expected)) {
    throw new AssertionError({ actual, expected, message, operator: "deepStrictEqual" });
  }
}

function notDeepStrictEqual(actual, expected, message) {
  if (deepEqual(actual, expected)) {
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
