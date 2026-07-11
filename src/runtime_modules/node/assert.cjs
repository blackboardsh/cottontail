"use strict";

class AssertionError extends Error {
  constructor(options = {}) {
    super(options.message === undefined ? "Assertion failed" : options.message);
    this.name = "AssertionError";
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator;
    this.code = "ERR_ASSERTION";
    this.generatedMessage = options.generatedMessage === undefined
      ? options.message === undefined
      : Boolean(options.generatedMessage);
    if (options.stackStartFn && typeof this.stack === "string") {
      const name = options.stackStartFn.name;
      if (name) {
        this.stack = this.stack
          .split("\n")
          .filter((line) => !new RegExp(`^\\s*at\\s+${name}\\b`).test(line))
          .join("\n");
        if (!this.stack.includes(name)) this.stack += `\n    at ${name}`;
      }
    }
  }
}

function nodeError(Ctor, code, message) {
  const error = new Ctor(message);
  error.code = code;
  return error;
}

function invalidArgType(name, expected, actual) {
  return nodeError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be ${expected}. Received ${actual === null ? "null" : typeof actual}`,
  );
}

function outOfRange(name, range, actual) {
  return nodeError(
    RangeError,
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${actual}`,
  );
}

function invalidArgValue(name, value) {
  return nodeError(
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    `The argument '${name}' is invalid. Received ${value}`,
  );
}

function functionName(fn) {
  return typeof fn?.name === "string" && fn.name.length > 0 ? fn.name : "<anonymous>";
}

function validateCallCount(exact) {
  if (typeof exact !== "number") throw invalidArgType("exact", "a number", exact);
  if (!Number.isInteger(exact) || exact < 0) {
    throw outOfRange("exact", "a non-negative integer", exact);
  }
}

const callTrackerState = new WeakMap();

function callTrackerCheck(tracker, fn) {
  const state = callTrackerState.get(tracker);
  const check = state?.wrappers.get(fn);
  if (!check) throw invalidArgValue("fn", fn);
  return check;
}

function copyTrackedFunctionProperties(source, target) {
  const sanitizeDescriptor = (descriptor) => {
    const clean = Object.create(null);
    const fields = ["value", "writable", "get", "set", "enumerable", "configurable"];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      if (Object.prototype.hasOwnProperty.call(descriptor, field)) clean[field] = descriptor[field];
    }
    return clean;
  };
  const keys = Reflect.ownKeys(source);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === "arguments" || key === "caller" || key === "name" || key === "prototype") continue;
    if (key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    try {
      Object.defineProperty(target, key, sanitizeDescriptor(descriptor));
    } catch {}
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(source, "length");
  if (lengthDescriptor) {
    try {
      Object.defineProperty(target, "length", sanitizeDescriptor(lengthDescriptor));
    } catch {}
  } else {
    try {
      delete target.length;
    } catch {}
  }
}

class CallTracker {
  constructor() {
    callTrackerState.set(this, {
      checks: [],
      wrappers: new WeakMap(),
    });
  }

  calls(fn = undefined, exact = 1) {
    if (globalThis.process?._exiting) {
      throw nodeError(Error, "ERR_UNAVAILABLE_DURING_EXIT", "Cannot call tracker.calls() during process exit");
    }

    let target = fn;
    let expected = exact;
    if (arguments.length === 1 && typeof fn === "number") {
      expected = fn;
      target = undefined;
    }
    validateCallCount(expected);

    if (target === undefined) {
      target = function noop() {};
    } else if (typeof target !== "function") {
      throw invalidArgType("fn", "a function", target);
    }

    const state = callTrackerState.get(this);
    const check = {
      actual: 0,
      calls: [],
      exact: expected,
      operator: functionName(target),
      stack: new Error().stack,
      target,
    };

    const wrapped = function trackedCall(...args) {
      check.actual += 1;
      check.calls.push(Object.freeze({
        arguments: Object.freeze(Array.prototype.slice.call(args)),
        thisArg: this,
      }));
      return target.apply(this, args);
    };
    copyTrackedFunctionProperties(target, wrapped);

    state.checks.push(check);
    state.wrappers.set(wrapped, check);
    return wrapped;
  }

  report() {
    const state = callTrackerState.get(this);
    const failures = [];
    for (let index = 0; index < state.checks.length; index += 1) {
      const check = state.checks[index];
      if (check.actual === check.exact) continue;
      failures.push({
        message: `Expected the ${check.operator} function to be executed ${check.exact} time(s) but was executed ${check.actual} time(s).`,
        actual: check.actual,
        expected: check.exact,
        operator: check.operator,
        stack: check.stack,
      });
    }
    return failures;
  }

  verify() {
    const failures = this.report();
    if (failures.length === 0) return;
    throw new AssertionError({
      actual: failures,
      expected: [],
      message: failures.length === 1
        ? failures[0].message
        : "Functions were not called the expected number of times",
      operator: "callTracker",
    });
  }

  getCalls(fn) {
    const check = callTrackerCheck(this, fn);
    const calls = new Array(check.calls.length);
    for (let index = 0; index < check.calls.length; index += 1) {
      const call = check.calls[index];
      calls[index] = Object.freeze({
        arguments: Object.freeze(Array.prototype.slice.call(call.arguments)),
        thisArg: call.thisArg,
      });
    }
    return Object.freeze(calls);
  }

  reset(fn = undefined) {
    const state = callTrackerState.get(this);
    if (fn === undefined) {
      for (let index = 0; index < state.checks.length; index += 1) {
        state.checks[index].actual = 0;
        state.checks[index].calls = [];
      }
      return;
    }
    const check = callTrackerCheck(this, fn);
    check.actual = 0;
    check.calls = [];
  }
}

let legacyFailWarningEmitted = false;

function formatAssertionValue(value) {
  if (typeof value === "string") return `'${value}'`;
  return String(value);
}

function emitLegacyFailWarning() {
  if (legacyFailWarningEmitted) return;
  legacyFailWarningEmitted = true;
  globalThis.process?.emitWarning?.(
    "assert.fail() with more than one argument is deprecated. Please use assert.strictEqual() instead or only pass a message.",
    "DeprecationWarning",
    "DEP0094",
  );
}

function fail(actual = undefined, expected = undefined, message = undefined, operator = undefined, stackStartFn = fail) {
  if (arguments.length <= 1) {
    throw new AssertionError({
      actual,
      expected: undefined,
      message: arguments.length === 0 ? "Failed" : actual,
      operator: "fail",
      generatedMessage: arguments.length === 0,
      stackStartFn,
    });
  }

  emitLegacyFailWarning();
  if (message instanceof Error) throw message;

  const assertionOperator = operator ?? (arguments.length >= 3 ? "fail" : "!=");
  const generatedMessage = message === undefined;
  const assertionMessage = generatedMessage
    ? `${formatAssertionValue(actual)} ${assertionOperator} ${formatAssertionValue(expected)}`
    : String(message);
  throw new AssertionError({
    actual,
    expected,
    message: assertionMessage,
    operator: assertionOperator,
    generatedMessage,
    stackStartFn,
  });
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
  if (actual != expected) throw new AssertionError({ actual, expected, message, operator: "==" });
}

function notEqual(actual, expected, message) {
  if (actual == expected) throw new AssertionError({ actual, expected, message, operator: "!=" });
}

function strictEqual(actual, expected, message) {
  if (actual !== expected) throw new AssertionError({ actual, expected, message, operator: "===" });
}

function notStrictEqual(actual, expected, message) {
  if (actual === expected) throw new AssertionError({ actual, expected, message, operator: "!==" });
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function samePrimitive(actual, expected, strict) {
  return strict ? Object.is(actual, expected) : actual == expected;
}

function deepEqualValue(actual, expected, strict, seen = new WeakMap()) {
  if (samePrimitive(actual, expected, strict)) return true;
  if (!isObject(actual) || !isObject(expected)) return false;
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
  if (strict && Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false;
  if (actual instanceof Map || expected instanceof Map) {
    if (!(actual instanceof Map) || !(expected instanceof Map) || actual.size !== expected.size) return false;
    for (const [key, value] of actual) {
      if (!expected.has(key) || !deepEqualValue(value, expected.get(key), strict, seen)) return false;
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
  const actualKeys = Reflect.ownKeys(actual).sort((left, right) => String(left).localeCompare(String(right)));
  const expectedKeys = Reflect.ownKeys(expected).sort((left, right) => String(left).localeCompare(String(right)));
  if (actualKeys.length !== expectedKeys.length) return false;
  for (let index = 0; index < actualKeys.length; index += 1) {
    if (actualKeys[index] !== expectedKeys[index]) return false;
    if (!deepEqualValue(actual[actualKeys[index]], expected[expectedKeys[index]], strict, seen)) return false;
  }
  return true;
}

function deepStrictEqual(actual, expected, message) {
  if (!deepEqualValue(actual, expected, true)) {
    throw new AssertionError({ actual, expected, message, operator: "deepStrictEqual" });
  }
}

function notDeepStrictEqual(actual, expected, message) {
  if (deepEqualValue(actual, expected, true)) {
    throw new AssertionError({ actual, expected, message, operator: "notDeepStrictEqual" });
  }
}

function deepEqual(actual, expected, message) {
  if (!deepEqualValue(actual, expected, false)) {
    throw new AssertionError({ actual, expected, message, operator: "deepEqual" });
  }
}

function notDeepEqual(actual, expected, message) {
  if (deepEqualValue(actual, expected, false)) {
    throw new AssertionError({ actual, expected, message, operator: "notDeepEqual" });
  }
}

function expectedMatches(error, expected) {
  if (expected == null) return true;
  if (typeof expected === "function") return safeInstanceOf(error, expected) || expected(error) === true;
  if (expected instanceof RegExp) return expected.test(String(error?.message ?? error));
  if (typeof expected === "object") {
    return Object.keys(expected).every((key) => deepEqualValue(error?.[key], expected[key], true));
  }
  return false;
}

function safeInstanceOf(value, Ctor) {
  try {
    return value instanceof Ctor;
  } catch {
    return false;
  }
}

function describePromiseValue(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return `type string ('${value}')`;
  if (typeof value === "number") return `type number (${value})`;
  if (typeof value === "boolean") return `type boolean (${value})`;
  if (typeof value === "function") return "an instance of Function";
  const name = value?.constructor?.name;
  return name ? `an instance of ${name}` : typeof value;
}

function promiseArgTypeError(value) {
  return nodeError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    `The "promiseFn" argument must be of type function or an instance of Promise. Received ${describePromiseValue(value)}`,
  );
}

function invalidReturnValueError(value) {
  return nodeError(
    TypeError,
    "ERR_INVALID_RETURN_VALUE",
    `Expected instance of Promise to be returned from the "promiseFn" function but got ${describePromiseValue(value)}.`,
  );
}

function isValidPromiseLike(value) {
  return value !== null &&
    typeof value === "object" &&
    typeof value.then === "function" &&
    typeof value.catch === "function";
}

function getPromiseResult(promiseFn) {
  if (typeof promiseFn === "function") {
    let value;
    try {
      value = promiseFn();
    } catch (error) {
      return { syncError: error };
    }
    if (!isValidPromiseLike(value)) return { setupError: invalidReturnValueError(value) };
    return { promise: value };
  }
  if (!isValidPromiseLike(promiseFn)) return { setupError: promiseArgTypeError(promiseFn) };
  return { promise: promiseFn };
}

function markPromiseHandled(promise) {
  if (promise && typeof promise.catch === "function") {
    try {
      promise.catch(() => {});
    } catch {}
  }
}

function expectedLabel(expected) {
  return typeof expected === "function" && expected.name ? ` (${expected.name})` : "";
}

function validateExpected(error, expected, operator, message) {
  if (expected == null) return true;
  if (typeof expected === "function") {
    if (safeInstanceOf(error, expected)) return true;
    const result = expected(error);
    if (result === true) return true;
    throw new AssertionError({
      actual: error,
      expected,
      message: message ?? `The "validate" validation function is expected to return "true". Received ${formatAssertionValue(result)}\n\nCaught error:\n\n${String(error)}`,
      operator,
      generatedMessage: message == null,
    });
  }
  return expectedMatches(error, expected);
}

function throws(fn, expected, message) {
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

function doesNotThrow(fn, expected, message) {
  try {
    return fn();
  } catch (error) {
    if (expectedMatches(error, expected)) {
      throw new AssertionError({ actual: error, expected, message, operator: "doesNotThrow" });
    }
    throw error;
  }
}

async function rejects(fn, expected, message) {
  const result = getPromiseResult(fn);
  if (result.setupError) throw result.setupError;
  if (result.syncError) throw result.syncError;
  markPromiseHandled(result.promise);
  try {
    await result.promise;
  } catch (error) {
    if (!validateExpected(error, expected, "rejects", message)) {
      throw new AssertionError({
        actual: error,
        expected,
        message,
        operator: "rejects",
        generatedMessage: message == null,
        stackStartFn: rejects,
      });
    }
    return error;
  }
  throw new AssertionError({
    actual: undefined,
    expected,
    message: message ?? `Missing expected rejection${expectedLabel(expected)}.`,
    operator: "rejects",
    generatedMessage: message == null,
  });
}

async function doesNotReject(fn, expected, message) {
  const result = getPromiseResult(fn);
  if (result.setupError) throw result.setupError;
  if (result.syncError) throw result.syncError;
  markPromiseHandled(result.promise);
  try {
    return await result.promise;
  } catch (error) {
    if (validateExpected(error, expected, "doesNotReject", message)) {
      throw new AssertionError({
        actual: error,
        expected,
        message: message ?? `Got unwanted rejection.\nActual message: "${String(error?.message ?? error)}"`,
        operator: "doesNotReject",
        generatedMessage: message == null,
      });
    }
    throw error;
  }
}

function match(string, regexp, message) {
  if (!(regexp instanceof RegExp)) throw new TypeError("assert.match requires a RegExp");
  if (!regexp.test(String(string))) {
    throw new AssertionError({ actual: string, expected: regexp, message, operator: "match" });
  }
}

function doesNotMatch(string, regexp, message) {
  if (!(regexp instanceof RegExp)) throw new TypeError("assert.doesNotMatch requires a RegExp");
  if (regexp.test(String(string))) {
    throw new AssertionError({ actual: string, expected: regexp, message, operator: "doesNotMatch" });
  }
}

function ifError(value) {
  if (value) throw value instanceof Error ? value : new AssertionError({ actual: value, expected: null, operator: "ifError" });
}

function partialDeepStrictEqual(actual, expected, message) {
  if (!isObject(actual) || !isObject(expected)) return deepStrictEqual(actual, expected, message);
  for (const key of Object.keys(expected)) deepStrictEqual(actual[key], expected[key], message);
}

class Assert {}

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
module.exports = assert;
