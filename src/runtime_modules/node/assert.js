import { internalRequire } from "./util/internal/loader.js";

const kAssertOptions = Symbol("assert options");

export class AssertionError extends Error {
  constructor(options) {
    if (options === null || typeof options !== "object") {
      throw invalidArgType("options", "an object", options);
    }

    const {
      message,
      operator,
      stackStartFn,
      stackStartFunction,
      details,
      diff = "simple",
    } = options;
    let { actual, expected } = options;

    if (message == null && isErrorObject(actual) && isErrorObject(expected)) {
      actual = copyErrorForAssertion(actual);
      expected = copyErrorForAssertion(expected);
    }

    super(formatAssertionErrorMessage(actual, expected, operator, message, diff));

    Object.defineProperty(this, "name", {
      __proto__: null,
      value: "AssertionError [ERR_ASSERTION]",
      enumerable: false,
      writable: true,
      configurable: true,
    });
    this.code = "ERR_ASSERTION";
    this.generatedMessage = options.generatedMessage === undefined
      ? !message
      : Boolean(options.generatedMessage);
    this.diff = diff;

    if (details) {
      this.actual = undefined;
      this.expected = undefined;
      this.operator = undefined;
      for (let index = 0; index < details.length; index += 1) {
        const detail = details[index];
        this[`message ${index}`] = detail.message;
        this[`actual ${index}`] = detail.actual;
        this[`expected ${index}`] = detail.expected;
        this[`operator ${index}`] = detail.operator;
        this[`stack trace ${index}`] = detail.stack;
      }
    } else {
      this.actual = actual;
      this.expected = expected;
      this.operator = operator;
    }

    const start = stackStartFn || stackStartFunction;
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, start || AssertionError);
    }
    if (start && typeof this.stack === "string" && start.name) {
      this.stack = cleanAssertionStack(this.stack, start.name);
    }

    // Force stack creation with Node's coded name, then expose the public name.
    void this.stack;
    this.name = "AssertionError";
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](_depth, context) {
    const actual = this.actual;
    const expected = this.expected;
    if (typeof actual === "string") this.actual = truncateAssertionString(actual);
    if (typeof expected === "string") this.expected = truncateAssertionString(expected);
    try {
      return inspectValue(this, {
        ...context,
        customInspect: false,
        depth: 0,
      });
    } finally {
      this.actual = actual;
      this.expected = expected;
    }
  }
}

export function Assert(options) {
  if (new.target === undefined) {
    throw nodeError(TypeError, "ERR_CONSTRUCT_CALL_REQUIRED", "Cannot call constructor Assert without new");
  }

  const normalized = Object.assign(Object.create(null), {
    strict: true,
    skipPrototype: false,
  }, options);
  if (normalized.diff !== undefined && normalized.diff !== "simple" && normalized.diff !== "full") {
    const error = invalidArgValue("options.diff", normalized.diff);
    error.message = `The property 'options.diff' must be one of: 'simple', 'full'. Received '${normalized.diff}'`;
    throw error;
  }

  this.AssertionError = AssertionError;
  kAssertOptionsMap.set(this, normalized);
  if (normalized.strict) {
    this.equal = this.strictEqual;
    this.deepEqual = this.deepStrictEqual;
    this.notEqual = this.notStrictEqual;
    this.notDeepEqual = this.notDeepStrictEqual;
  }
}

const kAssertOptionsMap = new WeakMap();

function nodeError(Ctor, code, message) {
  const error = new Ctor(message);
  error.code = code;
  return error;
}

function cleanAssertionStack(stack, functionName) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const functionFrame = new RegExp(`^\\s*at\\s+Function\\.${escaped}(?:\\d+)?\\b`);
  let lines = stack.split("\n").filter((line) => !functionFrame.test(line));
  if (functionName === "rejects" || functionName === "doesNotReject") return lines.join("\n");

  const frame = new RegExp(`(?:^\\s*at\\s+(?:Function\\.)?${escaped}(?:\\d+)?\\b)|(?:^${escaped}@)`);
  const frameIndex = lines.findIndex((line, index) => index > 0 && frame.test(line));
  if (frameIndex !== -1) lines = [lines[0], ...lines.slice(frameIndex + 1)];
  return lines.join("\n");
}

function invalidArgType(name, expected, actual) {
  let expectedDescription = expected;
  if (expected === "a function") expectedDescription = "of type function";
  else if (expected === "an object") expectedDescription = "of type object";
  else if (expected === "a number") expectedDescription = "of type number";
  else if (expected === "an object, Error, function, or RegExp") {
    expectedDescription = "of type function or an instance of Error, RegExp, or Object";
  } else if (expected === "a function or RegExp") {
    expectedDescription = "of type function or an instance of RegExp";
  }
  return nodeError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be ${expectedDescription}.${describeInvalidValue(actual)}`,
  );
}

function describeInvalidValue(value) {
  if (value === null) return " Received null";
  if (value === undefined) return " Received undefined";
  const type = typeof value;
  if (type === "string") return ` Received type string (${formatAssertionValue(value)})`;
  if (type !== "object" && type !== "function") return ` Received type ${type} (${String(value)})`;
  const name = value?.constructor?.name;
  return name ? ` Received an instance of ${name}` : ` Received type ${type}`;
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

function validateCallCount(expected) {
  if (typeof expected !== "number") {
    throw invalidArgType("expected", "a number", expected);
  }
  if (!Number.isInteger(expected) || expected < 0 || expected > 0xffffffff) {
    throw outOfRange("expected", ">= 0 && <= 4294967295", expected);
  }
}

const callTrackerState = new WeakMap();
const callTrackerHandlerState = new WeakMap();

function callTrackerCheck(tracker, fn) {
  const state = callTrackerState.get(tracker);
  const check = state?.wrappers.get(fn);
  if (!check) throw invalidArgValue("fn", fn);
  return check;
}

function callTrackerApply(target, thisArg, args) {
  const check = callTrackerHandlerState.get(this);
  check.actual += 1;
  check.calls.push(Object.freeze({
    arguments: Object.freeze(Array.prototype.slice.call(args)),
    thisArg,
  }));
  return Reflect.apply(target, thisArg, args);
}

function noop() {}

export class CallTracker {
  constructor() {
    callTrackerState.set(this, {
      checks: [],
      wrappers: new WeakMap(),
    });
  }

  calls(fn, expected = 1) {
    if (globalThis.process?._exiting) {
      throw nodeError(Error, "ERR_UNAVAILABLE_DURING_EXIT", "Cannot call tracker.calls() during process exit");
    }

    let target = fn;
    if (typeof fn === "number") {
      expected = fn;
      target = undefined;
    }
    validateCallCount(expected);

    if (target === undefined) {
      target = noop;
    } else if (typeof target !== "function") {
      throw invalidArgType("fn", "a function", target);
    }

    const state = callTrackerState.get(this);
    const check = {
      actual: 0,
      calls: [],
      exact: expected,
      operator: functionName(target),
      stack: new Error(),
      target,
    };

    const handler = Object.create(null);
    handler.apply = callTrackerApply;
    callTrackerHandlerState.set(handler, check);
    const wrapped = new Proxy(target, handler);

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
      message: failures.length === 1
        ? failures[0].message
        : "Functions were not called the expected number of times",
      details: failures,
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

  reset(fn) {
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

let assertionFormatInternals;

function getAssertionFormatInternals() {
  if (assertionFormatInternals) return assertionFormatInternals;

  let inspect = (value) => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  let colors = {
    blue: "",
    gray: "",
    green: "",
    red: "",
    white: "",
    hasColors: false,
    refresh() {},
  };
  let myers;

  try {
    inspect = internalRequire("node:util").inspect;
  } catch {}
  try {
    colors = internalRequire("internal/util/colors");
    colors.refresh?.();
  } catch {}
  try {
    myers = internalRequire("internal/assert/myers_diff");
  } catch {}

  assertionFormatInternals = { colors, inspect, myers };
  return assertionFormatInternals;
}

function inspectValue(value, overrides = undefined) {
  const { inspect } = getAssertionFormatInternals();
  try {
    return inspect(value, {
      compact: false,
      customInspect: false,
      depth: 1000,
      getters: true,
      maxArrayLength: Infinity,
      showHidden: false,
      showProxy: false,
      sorted: true,
      ...overrides,
    });
  } catch {
    try {
      return String(value);
    } catch {
      return "<uninspectable>";
    }
  }
}

function formatAssertionValue(value) {
  return inspectValue(value, { compact: true, depth: 2 });
}

function truncateAssertionString(value) {
  const lines = value.split("\n", 11);
  if (lines.length > 10) return `${lines.slice(0, 10).join("\n")}\n...`;
  if (value.length > 512) return `${value.slice(512)}...`;
  return value;
}

function copyErrorForAssertion(source) {
  const target = Object.assign(Object.create(Object.getPrototypeOf(source)), source);
  Object.defineProperty(target, "message", {
    __proto__: null,
    value: source.message,
    configurable: true,
  });
  if (Object.prototype.hasOwnProperty.call(source, "cause")) {
    const cause = isErrorObject(source.cause)
      ? copyErrorForAssertion(source.cause)
      : source.cause;
    Object.defineProperty(target, "cause", {
      __proto__: null,
      value: cause,
      configurable: true,
    });
  }
  return target;
}

const readableOperators = {
  deepStrictEqual: "Expected values to be strictly deep-equal:",
  partialDeepStrictEqual: "Expected values to be partially and strictly deep-equal:",
  strictEqual: "Expected values to be strictly equal:",
  strictEqualObject: 'Expected "actual" to be reference-equal to "expected":',
  deepEqual: "Expected values to be loosely deep-equal:",
  notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
  notStrictEqual: 'Expected "actual" to be strictly unequal to:',
  notStrictEqualObject: 'Expected "actual" not to be reference-equal to "expected":',
  notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
  notIdentical: "Values have same structure but are not reference-equal:",
  notDeepEqualUnequal: "Expected values not to be loosely deep-equal:",
};

function simpleDiff(actual, expected, inspectedActual, inspectedExpected) {
  const { colors } = getAssertionFormatInternals();
  const stringsLength = inspectedActual.length + inspectedExpected.length -
    (typeof actual === "string" ? 2 : 0) -
    (typeof expected === "string" ? 2 : 0);
  if (stringsLength <= 12 && (actual !== 0 || expected !== 0)) {
    return { header: "", message: `${inspectedActual} !== ${inspectedExpected}` };
  }
  let message = `\n${colors.green}+${colors.white} ${inspectedActual}\n${colors.red}-${colors.white} ${inspectedExpected}`;
  if (typeof actual === "string" && typeof expected === "string") {
    const terminalWidth = globalThis.process?.stderr?.isTTY
      ? globalThis.process.stderr.columns
      : 80;
    if (actual.length + expected.length <= terminalWidth) {
      const length = Math.min(inspectedActual.length, inspectedExpected.length);
      for (let index = 0; index < length; index += 1) {
        if (inspectedActual[index] === inspectedExpected[index]) continue;
        if (index >= 3) message += `\n${" ".repeat(index + 2)}^`;
        break;
      }
    }
  }
  return { message };
}

function createAssertionDiff(actual, expected, operator, customMessage, diffType) {
  const { colors, myers } = getAssertionFormatInternals();
  if (operator === "strictEqual" &&
      ((isObject(actual) && isObject(expected)) ||
       (typeof actual === "function" && typeof expected === "function"))) {
    operator = "strictEqualObject";
  }

  const actualText = inspectValue(actual);
  const expectedText = inspectValue(expected);
  const actualLines = actualText.split("\n");
  const expectedLines = expectedText.split("\n");
  let header = `${colors.green}+ actual${colors.white} ${colors.red}- expected${colors.white}`;
  let message;
  let skipped = false;

  if ((actualLines.length === 1 && expectedLines.length === 1) &&
      (!isObject(actual) || !isObject(expected))) {
    const result = simpleDiff(actual, expected, actualLines[0], expectedLines[0]);
    header = result.header ?? header;
    message = result.message;
  } else if (actualText === expectedText) {
    operator = "notIdentical";
    if (actualLines.length > 50 && diffType !== "full") {
      message = `${actualLines.slice(0, 50).join("\n")}\n...`;
      skipped = true;
    } else {
      message = actualText;
    }
    header = "";
  } else if (myers?.myersDiff && myers?.printMyersDiff) {
    const result = myers.printMyersDiff(
      myers.myersDiff(actualLines, expectedLines, isObject(actual)),
      operator,
    );
    message = result.message;
    skipped = result.skipped;
    if (operator === "partialDeepStrictEqual") {
      header = `${colors.gray}${colors.hasColors ? "" : "+ "}actual${colors.white} ${colors.red}- expected${colors.white}`;
    }
  } else {
    message = `\n${colors.green}+${colors.white} ${actualText}\n${colors.red}-${colors.white} ${expectedText}`;
  }

  const title = customMessage || readableOperators[operator] || "Expected values to be equal:";
  return `${title}\n${header}${skipped ? "\n... Skipped lines" : ""}\n${message}\n`;
}

function formatAssertionErrorMessage(actual, expected, operator, message, diffType = "simple") {
  if (message != null &&
      operator !== "strictEqual" &&
      operator !== "deepStrictEqual" &&
      operator !== "partialDeepStrictEqual") {
    return String(message);
  }

  if (operator === "strictEqual" || operator === "deepStrictEqual" || operator === "partialDeepStrictEqual") {
    return createAssertionDiff(actual, expected, operator, message, diffType);
  }

  if (operator === "notStrictEqual" || operator === "notDeepStrictEqual") {
    const objectReference = operator === "notStrictEqual" &&
      (isObject(actual) || typeof actual === "function");
    const title = readableOperators[objectReference ? "notStrictEqualObject" : operator];
    let inspected = inspectValue(actual);
    const lines = inspected.split("\n");
    if (lines.length > 50 && diffType !== "full") {
      inspected = `${lines.slice(0, 46).join("\n")}\n...`;
    }
    return `${title}${lines.length === 1 && inspected.length <= 5 ? " " : "\n\n"}${inspected}${lines.length > 1 ? "\n" : ""}`;
  }

  let actualText = inspectValue(actual);
  let expectedText = inspectValue(expected);
  if (diffType !== "full") {
    if (actualText.length > 512) actualText = `${actualText.slice(0, 509)}...`;
    if (expectedText.length > 512) expectedText = `${expectedText.slice(0, 509)}...`;
  }
  if (operator === "deepEqual") {
    return `${readableOperators.deepEqual}\n\n${actualText}\n\nshould loosely deep-equal\n\n${expectedText}`;
  }
  if (operator === "notDeepEqual") {
    if (actualText === expectedText) return `${readableOperators.notDeepEqual}\n\n${actualText}`;
    return `${readableOperators.notDeepEqualUnequal}\n\n${actualText}\n\nshould not loosely deep-equal\n\n${expectedText}`;
  }
  if (operator === "fail" && actual === undefined && expected === undefined) return "Failed";
  return `${actualText} ${operator ?? "=="} ${expectedText}`;
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

function assertOptions(receiver) {
  return (receiver !== null && (typeof receiver === "object" || typeof receiver === "function"))
    ? kAssertOptionsMap.get(receiver)
    : undefined;
}

function missingArgs(...names) {
  const quoted = names.map((name) => `"${name}"`);
  const list = quoted.length === 2
    ? `${quoted[0]} and ${quoted[1]}`
    : `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
  return nodeError(TypeError, "ERR_MISSING_ARGS", `The ${list} arguments must be specified`);
}

function innerFail(options) {
  if (isErrorObject(options.message)) throw options.message;
  throw new AssertionError(options);
}

export function fail(actual, expected, message, operator, stackStartFn) {
  const argsLength = arguments.length;
  let generatedMessage = false;

  if (actual == null && argsLength <= 1) {
    generatedMessage = true;
    message = "Failed";
  } else if (argsLength === 1) {
    message = actual;
    actual = undefined;
  } else {
    emitLegacyFailWarning();
    if (argsLength === 2) operator = "!=";
  }

  innerFail({
    actual,
    expected,
    message,
    operator: operator === undefined ? "fail" : operator,
    generatedMessage: generatedMessage || message == null,
    stackStartFn: stackStartFn || fail,
    diff: assertOptions(this)?.diff,
  });
}

function assertOk(receiver, stackStartFn, args) {
  const [value, suppliedMessage] = args;
  if (value) return;
  if (isErrorObject(suppliedMessage)) throw suppliedMessage;

  const generatedMessage = args.length === 0 || suppliedMessage == null;
  const message = args.length === 0
    ? "No value argument passed to `assert.ok()`"
    : suppliedMessage;
  innerFail({
    actual: value,
    expected: true,
    message,
    operator: "==",
    generatedMessage,
    stackStartFn,
    diff: assertOptions(receiver)?.diff,
  });
}

export function ok(...args) {
  return assertOk(this, ok, args);
}

export function equal(actual, expected, message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (actual != expected && (!Number.isNaN(actual) || !Number.isNaN(expected))) {
    innerFail({ actual, expected, message, operator: "==", stackStartFn: equal, diff: assertOptions(this)?.diff });
  }
}

export function notEqual(actual, expected, message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
    innerFail({ actual, expected, message, operator: "!=", stackStartFn: notEqual, diff: assertOptions(this)?.diff });
  }
}

export function strictEqual(actual, expected, message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (!Object.is(actual, expected)) {
    innerFail({ actual, expected, message, operator: "strictEqual", stackStartFn: strictEqual, diff: assertOptions(this)?.diff });
  }
}

export function notStrictEqual(actual, expected, message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (Object.is(actual, expected)) {
    innerFail({ actual, expected, message, operator: "notStrictEqual", stackStartFn: notStrictEqual, diff: assertOptions(this)?.diff });
  }
}

const kLoose = 0;
const kPartial = 1;
const kStrict = 2;
const kStrictWithoutPrototypes = 3;

function isObject(value) {
  return value !== null && typeof value === "object";
}

function objectTag(value) {
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return "";
  }
}

const regexpSourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get;

function isRegExpValue(value) {
  if (!regexpSourceGetter) return value instanceof RegExp;
  try {
    regexpSourceGetter.call(value);
    return true;
  } catch {
    return false;
  }
}

function isSharedArrayBufferValue(value) {
  if (typeof SharedArrayBuffer === "undefined") return false;
  if (objectTag(value) === "[object SharedArrayBuffer]") return true;
  try {
    return SharedArrayBuffer !== ArrayBuffer && value instanceof SharedArrayBuffer;
  } catch {
    return false;
  }
}

function boxedPrimitiveValue(value, tag) {
  try {
    switch (tag) {
      case "[object Number]": return { boxed: true, value: Number.prototype.valueOf.call(value) };
      case "[object Boolean]": return { boxed: true, value: Boolean.prototype.valueOf.call(value) };
      case "[object String]": return { boxed: true, value: String.prototype.valueOf.call(value) };
      case "[object BigInt]": return { boxed: true, value: BigInt.prototype.valueOf.call(value) };
      case "[object Symbol]": return { boxed: true, value: Symbol.prototype.valueOf.call(value) };
      default: return { boxed: false, value: undefined };
    }
  } catch {
    return { boxed: false, value: undefined };
  }
}

function isFloatArrayTag(tag) {
  return tag === "[object Float16Array]" || tag === "[object Float32Array]" || tag === "[object Float64Array]";
}

const typedArrayTagGetter = (() => {
  try {
    return Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;
  } catch {
    return undefined;
  }
})();

const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const sharedArrayBufferByteLengthGetter = typeof SharedArrayBuffer === "function"
  ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get
  : undefined;
const mapSizeGetter = Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get;
const setSizeGetter = Object.getOwnPropertyDescriptor(Set.prototype, "size")?.get;

function nativeViewTag(value) {
  if (!ArrayBuffer.isView(value)) return undefined;
  if (objectTag(value) === "[object DataView]") return "DataView";
  try {
    return typedArrayTagGetter?.call(value);
  } catch {
    return undefined;
  }
}

function arrayBufferKind(value) {
  try {
    arrayBufferByteLengthGetter?.call(value);
    return "ArrayBuffer";
  } catch {}
  if (sharedArrayBufferByteLengthGetter) {
    try {
      sharedArrayBufferByteLengthGetter.call(value);
      return "SharedArrayBuffer";
    } catch {}
  }
  return undefined;
}

function isMapValue(value) {
  try {
    mapSizeGetter?.call(value);
    return true;
  } catch {
    return false;
  }
}

function isSetValue(value) {
  try {
    setSizeGetter?.call(value);
    return true;
  } catch {
    return false;
  }
}

function isCanonicalIndex(key) {
  if (typeof key !== "string" || key === "") return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === key;
}

function enumerableKeys(value, mode, skipIndexes = false) {
  const keys = Object.keys(value).filter((key) => !skipIndexes || !isCanonicalIndex(key));
  if (mode !== kLoose) {
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, symbol)) keys.push(symbol);
    }
  }
  return keys;
}

function compareEnumerableProperties(actual, expected, mode, memo, skipIndexes = false) {
  const expectedKeys = enumerableKeys(expected, mode, skipIndexes);
  if (mode !== kPartial) {
    const actualKeys = enumerableKeys(actual, mode, skipIndexes);
    if (actualKeys.length !== expectedKeys.length) return false;
  }

  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(actual, key);
    if (!descriptor?.enumerable) return false;
    const actualValue = Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : actual[key];
    if (!innerDeepEqual(actualValue, expected[key], mode, memo)) return false;
  }
  return true;
}

function bytesForView(value) {
  try {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } catch {
    return null;
  }
}

function bytesForBuffer(value) {
  try {
    return new Uint8Array(value);
  } catch {
    return null;
  }
}

function bytesEqual(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) return false;
  }
  return true;
}

function bytesContainSubsequence(actual, expected) {
  if (!actual || !expected || actual.length < expected.length) return false;
  let actualIndex = 0;
  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
    while (actualIndex < actual.length && !Object.is(actual[actualIndex], expected[expectedIndex])) actualIndex += 1;
    if (actualIndex === actual.length) return false;
    actualIndex += 1;
  }
  return true;
}

function compareArrays(actual, expected, mode, memo) {
  const actualIndexes = Object.keys(actual).filter(isCanonicalIndex);
  const expectedIndexes = Object.keys(expected).filter(isCanonicalIndex);
  if (mode === kPartial) {
    if (actual.length < expected.length) return false;
    const actualValues = actualIndexes.map((key) => actual[key]);
    const expectedValues = expectedIndexes.map((key) => expected[key]);
    let actualIndex = 0;
    for (const expectedValue of expectedValues) {
      while (actualIndex < actualValues.length &&
             !innerDeepEqual(actualValues[actualIndex], expectedValue, mode, memo)) actualIndex += 1;
      if (actualIndex === actualValues.length) return false;
      actualIndex += 1;
    }
  } else {
    if (actual.length !== expected.length || actualIndexes.length !== expectedIndexes.length) return false;
    for (let index = 0; index < actualIndexes.length; index += 1) {
      if (actualIndexes[index] !== expectedIndexes[index] ||
          !innerDeepEqual(actual[actualIndexes[index]], expected[expectedIndexes[index]], mode, memo)) return false;
    }
  }
  return compareEnumerableProperties(actual, expected, mode, memo, true);
}

function compareArrayBufferViews(actual, expected, mode, memo, tag) {
  const actualNativeTag = nativeViewTag(actual);
  if (!ArrayBuffer.isView(expected) || nativeViewTag(expected) !== actualNativeTag) return false;

  if (mode === kLoose && isFloatArrayTag(`[object ${actualNativeTag}]`)) {
    if (actual.length !== expected.length) return false;
    for (let index = 0; index < actual.length; index += 1) {
      if (actual[index] !== expected[index]) return false;
    }
  } else {
    const actualBytes = bytesForView(actual);
    const expectedBytes = bytesForView(expected);
    if (mode === kPartial && actual.byteLength !== expected.byteLength) {
      if (!bytesContainSubsequence(actualBytes, expectedBytes)) return false;
    } else if (!bytesEqual(actualBytes, expectedBytes)) {
      return false;
    }
  }

  return compareEnumerableProperties(actual, expected, mode, memo, true);
}

function matchUnordered(actualItems, expectedItems, comparator) {
  const actualMatches = new Array(actualItems.length).fill(-1);
  const augment = (expectedIndex, visited) => {
    for (let actualIndex = 0; actualIndex < actualItems.length; actualIndex += 1) {
      if (visited.has(actualIndex) || !comparator(actualItems[actualIndex], expectedItems[expectedIndex])) continue;
      visited.add(actualIndex);
      if (actualMatches[actualIndex] === -1 || augment(actualMatches[actualIndex], visited)) {
        actualMatches[actualIndex] = expectedIndex;
        return true;
      }
    }
    return false;
  };
  for (let expectedIndex = 0; expectedIndex < expectedItems.length; expectedIndex += 1) {
    if (!augment(expectedIndex, new Set())) return false;
  }
  return true;
}

function compareSets(actual, expected, mode, memo) {
  if (!isSetValue(expected) ||
      (mode === kPartial ? actual.size < expected.size : actual.size !== expected.size)) return false;
  const contentsEqual = matchUnordered(
    Array.from(actual),
    Array.from(expected),
    (left, right) => innerDeepEqual(left, right, mode, memo),
  );
  return contentsEqual && compareEnumerableProperties(actual, expected, mode, memo);
}

function compareMaps(actual, expected, mode, memo) {
  if (!isMapValue(expected) ||
      (mode === kPartial ? actual.size < expected.size : actual.size !== expected.size)) return false;
  const entriesEqual = matchUnordered(
    Array.from(actual),
    Array.from(expected),
    ([actualKey, actualValue], [expectedKey, expectedValue]) =>
      innerDeepEqual(actualKey, expectedKey, mode, memo) &&
      innerDeepEqual(actualValue, expectedValue, mode, memo),
  );
  return entriesEqual && compareEnumerableProperties(actual, expected, mode, memo);
}

function isErrorObject(value, tag = objectTag(value)) {
  return tag === "[object Error]" || value instanceof Error;
}

function compareErrors(actual, expected, mode, memo) {
  if (!isErrorObject(expected)) return false;
  const compareSpecial = (key) => {
    if (Object.prototype.propertyIsEnumerable.call(expected, key)) return true;
    if (mode === kPartial &&
        (expected[key] === undefined || (key === "message" && expected[key] === ""))) return true;
    return innerDeepEqual(actual[key], expected[key], mode, memo);
  };
  if (!compareSpecial("name") || !compareSpecial("message") ||
      !compareSpecial("cause") || !compareSpecial("errors")) return false;

  for (const key of ["cause", "errors"]) {
    const actualOwn = Object.prototype.hasOwnProperty.call(actual, key);
    const expectedOwn = Object.prototype.hasOwnProperty.call(expected, key);
    if (mode === kPartial ? expectedOwn && !actualOwn : actualOwn !== expectedOwn) return false;
  }
  return compareEnumerableProperties(actual, expected, mode, memo);
}

function compareObjects(actual, expected, mode, memo) {
  if (mode === kStrict && Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false;

  const actualTag = objectTag(actual);
  const expectedTag = objectTag(expected);
  if (actualTag !== expectedTag) return false;

  const actualIsArray = Array.isArray(actual);
  const expectedIsArray = Array.isArray(expected);
  if (actualIsArray !== expectedIsArray) return false;
  if (actualIsArray) return compareArrays(actual, expected, mode, memo);

  const actualIsView = ArrayBuffer.isView(actual);
  const expectedIsView = ArrayBuffer.isView(expected);
  if (actualIsView !== expectedIsView) return false;
  if (actualIsView) return compareArrayBufferViews(actual, expected, mode, memo, actualTag);

  const actualBufferKind = arrayBufferKind(actual);
  const expectedBufferKind = arrayBufferKind(expected);
  if (Boolean(actualBufferKind) !== Boolean(expectedBufferKind)) return false;
  if (actualBufferKind) {
    if (expectedBufferKind !== actualBufferKind ||
        isSharedArrayBufferValue(actual) !== isSharedArrayBufferValue(expected)) return false;
    const actualBytes = bytesForBuffer(actual);
    const expectedBytes = bytesForBuffer(expected);
    const contentsEqual = mode === kPartial && actual.byteLength !== expected.byteLength
      ? bytesContainSubsequence(actualBytes, expectedBytes)
      : bytesEqual(actualBytes, expectedBytes);
    return contentsEqual && compareEnumerableProperties(actual, expected, mode, memo);
  }

  if (actualTag === "[object Date]") {
    try {
      if (Date.prototype.getTime.call(actual) !== Date.prototype.getTime.call(expected)) return false;
    } catch {
      return false;
    }
    return compareEnumerableProperties(actual, expected, mode, memo);
  }

  const actualIsRegExp = isRegExpValue(actual);
  const expectedIsRegExp = isRegExpValue(expected);
  if (actualIsRegExp !== expectedIsRegExp) return false;
  if (actualIsRegExp) {
    try {
      if (regexpSourceGetter.call(actual) !== regexpSourceGetter.call(expected) ||
          actual.flags !== expected.flags || actual.lastIndex !== expected.lastIndex) return false;
    } catch {
      return false;
    }
    return compareEnumerableProperties(actual, expected, mode, memo);
  }

  if (isErrorObject(actual, actualTag)) return compareErrors(actual, expected, mode, memo);
  const actualIsSet = isSetValue(actual);
  const expectedIsSet = isSetValue(expected);
  if (actualIsSet !== expectedIsSet) return false;
  if (actualIsSet) return compareSets(actual, expected, mode, memo);

  const actualIsMap = isMapValue(actual);
  const expectedIsMap = isMapValue(expected);
  if (actualIsMap !== expectedIsMap) return false;
  if (actualIsMap) return compareMaps(actual, expected, mode, memo);

  const boxed = boxedPrimitiveValue(actual, actualTag);
  const expectedBoxed = boxedPrimitiveValue(expected, expectedTag);
  if (boxed.boxed) {
    if (!expectedBoxed.boxed || !Object.is(boxed.value, expectedBoxed.value)) return false;
  } else if (expectedBoxed.boxed) {
    return false;
  }

  if ((actualTag === "[object WeakMap]" || actualTag === "[object WeakSet]") && actual !== expected) return false;
  if (actualTag === "[object URL]" && actual.href !== expected.href) return false;

  return compareEnumerableProperties(actual, expected, mode, memo);
}

function innerDeepEqual(actual, expected, mode, memo) {
  if (actual === expected) {
    return actual !== 0 || Object.is(actual, expected) || mode === kLoose;
  }

  if (mode !== kLoose) {
    if (typeof actual === "number" && typeof expected === "number" && Number.isNaN(actual) && Number.isNaN(expected)) return true;
    if (!isObject(actual) || !isObject(expected)) return false;
  } else {
    if (!isObject(actual)) {
      if (isObject(expected)) return false;
      return actual == expected || (Number.isNaN(actual) && Number.isNaN(expected));
    }
    if (!isObject(expected)) return false;
  }

  if (memo.left.has(actual)) return memo.left.get(actual) === expected;
  if (memo.right.has(expected)) return false;
  memo.left.set(actual, expected);
  memo.right.set(expected, actual);
  try {
    return compareObjects(actual, expected, mode, memo);
  } finally {
    memo.left.delete(actual);
    memo.right.delete(expected);
  }
}

function deepEqualValue(actual, expected, mode) {
  const normalizedMode = mode === true ? kStrict : mode === false ? kLoose : mode;
  return innerDeepEqual(actual, expected, normalizedMode, {
    left: new WeakMap(),
    right: new WeakMap(),
  });
}

export function deepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  const mode = assertOptions(this)?.skipPrototype ? kStrictWithoutPrototypes : kStrict;
  if (!deepEqualValue(actual, expected, mode)) {
    innerFail({ actual, expected, message, operator: "deepStrictEqual", stackStartFn: deepStrictEqual, diff: assertOptions(this)?.diff });
  }
}

export function notDeepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  const mode = assertOptions(this)?.skipPrototype ? kStrictWithoutPrototypes : kStrict;
  if (deepEqualValue(actual, expected, mode)) {
    innerFail({ actual, expected, message, operator: "notDeepStrictEqual", stackStartFn: notDeepStrictEqual, diff: assertOptions(this)?.diff });
  }
}

export function deepEqual(actual, expected, message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (!deepEqualValue(actual, expected, kLoose)) {
    innerFail({ actual, expected, message, operator: "deepEqual", stackStartFn: deepEqual, diff: assertOptions(this)?.diff });
  }
}

export function notDeepEqual(actual, expected, message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (deepEqualValue(actual, expected, kLoose)) {
    innerFail({ actual, expected, message, operator: "notDeepEqual", stackStartFn: notDeepEqual, diff: assertOptions(this)?.diff });
  }
}

function safeInstanceOf(value, Ctor) {
  try {
    return value instanceof Ctor;
  } catch {
    return false;
  }
}

function isErrorConstructor(value) {
  if (value === Error) return true;
  try {
    return Object.prototype.isPrototypeOf.call(Error, value) ||
      (value?.prototype !== undefined && isErrorObject(value.prototype));
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

const noException = {};

class Comparison {
  constructor(value, keys, actual = undefined) {
    for (const key of keys) {
      if (!(key in value)) continue;
      const expectedValue = value[key];
      if (actual !== undefined && typeof actual[key] === "string" && isRegExpValue(expectedValue) &&
          RegExp.prototype.exec.call(expectedValue, actual[key]) !== null) {
        this[key] = actual[key];
      } else {
        this[key] = expectedValue;
      }
    }
  }
}

function exceptionMismatch(actual, expected, message, fn, receiver, keys = undefined) {
  if (isErrorObject(message)) throw message;
  if (message == null && keys) {
    const error = new AssertionError({
      actual: new Comparison(actual, keys),
      expected: new Comparison(expected, keys, actual),
      operator: "deepStrictEqual",
      stackStartFn: fn,
      diff: assertOptions(receiver)?.diff,
    });
    error.actual = actual;
    error.expected = expected;
    error.operator = fn.name;
    throw error;
  }
  innerFail({
    actual,
    expected,
    message,
    operator: fn.name,
    stackStartFn: fn,
    diff: assertOptions(receiver)?.diff,
  });
}

function expectedException(actual, expected, message, fn, receiver) {
  if (isRegExpValue(expected)) {
    if (RegExp.prototype.exec.call(expected, String(actual)) !== null) return;
    const generated = message == null;
    const generatedMessage = `The input did not match the regular expression ${formatAssertionValue(expected)}. Input:\n\n${formatAssertionValue(String(actual))}\n`;
    innerFail({
      actual,
      expected,
      message: message ?? generatedMessage,
      generatedMessage: generated,
      operator: fn.name,
      stackStartFn: fn,
      diff: assertOptions(receiver)?.diff,
    });
  }

  if (typeof expected !== "function") {
    if (!isObject(actual)) {
      const error = new AssertionError({
        actual,
        expected,
        message,
        operator: "deepStrictEqual",
        stackStartFn: fn,
        diff: assertOptions(receiver)?.diff,
      });
      error.operator = fn.name;
      throw error;
    }
    const keys = Object.keys(expected);
    if (isErrorObject(expected)) {
      if (!keys.includes("name")) keys.push("name");
      if (!keys.includes("message")) keys.push("message");
    } else if (keys.length === 0) {
      const error = invalidArgValue("error", expected);
      error.message = `The argument 'error' may not be an empty object. Received ${formatAssertionValue(expected)}`;
      throw error;
    }

    for (const key of keys) {
      const wanted = expected[key];
      if (typeof actual[key] === "string" && isRegExpValue(wanted) &&
          RegExp.prototype.exec.call(wanted, actual[key]) !== null) continue;
      if (!(key in actual) || !deepEqualValue(actual[key], wanted, kStrict)) {
        return exceptionMismatch(actual, expected, message, fn, receiver, keys);
      }
    }
    return;
  }

  if (expected.prototype !== undefined && safeInstanceOf(actual, expected)) return;

  let result = false;
  let generatedMessage;
  if (isErrorConstructor(expected)) {
    generatedMessage = `The error is expected to be an instance of "${expected.name}". Received `;
    if (isErrorObject(actual)) {
      const actualName = actual?.constructor?.name || actual?.name;
      generatedMessage += expected.name === actualName
        ? "an error with identical name but a different prototype."
        : `"${actualName}"`;
      if (actual.message) generatedMessage += `\n\nError message:\n\n${actual.message}`;
    } else {
      generatedMessage += `"${inspectValue(actual, { compact: true, depth: -1 })}"`;
    }
  } else {
    result = Reflect.apply(expected, {}, [actual]);
    if (result === true) return;
    const name = expected.name ? `"${expected.name}" ` : "";
    generatedMessage = `The ${name}validation function is expected to return "true". Received ${formatAssertionValue(result)}`;
    if (isErrorObject(actual)) generatedMessage += `\n\nCaught error:\n\n${actual}`;
  }

  innerFail({
    actual,
    expected,
    message: message ?? generatedMessage,
    generatedMessage: message == null,
    operator: fn.name,
    stackStartFn: fn,
    diff: assertOptions(receiver)?.diff,
  });
}

function getActual(fn) {
  if (typeof fn !== "function") throw invalidArgType("fn", "a function", fn);
  try {
    fn();
  } catch (error) {
    return error;
  }
  return noException;
}

async function waitForActual(promiseFn) {
  let promise;
  if (typeof promiseFn === "function") {
    promise = promiseFn();
    if (!isValidPromiseLike(promise)) throw invalidReturnValueError(promise);
  } else if (isValidPromiseLike(promiseFn)) {
    promise = promiseFn;
  } else {
    throw promiseArgTypeError(promiseFn);
  }

  try {
    await promise;
  } catch (error) {
    return error;
  }
  return noException;
}

function normalizeExpectedArguments(actual, args) {
  let [expected, message] = args;
  if (typeof expected === "string") {
    if (args.length > 1) {
      throw invalidArgType("error", "an object, Error, function, or RegExp", expected);
    }
    if (isObject(actual) && actual.message === expected) {
      return { ambiguous: `The error message "${actual.message}" is identical to the message.` };
    }
    if (!isObject(actual) && actual === expected) {
      return { ambiguous: `The error "${actual}" is identical to the message.` };
    }
    message = expected;
    expected = undefined;
  } else if (expected != null && typeof expected !== "object" && typeof expected !== "function") {
    throw invalidArgType("error", "an object, Error, function, or RegExp", expected);
  }
  return { expected, message };
}

function expectsError(receiver, fn, actual, args) {
  const normalized = normalizeExpectedArguments(actual, args);
  if (normalized.ambiguous) {
    throw nodeError(
      TypeError,
      "ERR_AMBIGUOUS_ARGUMENT",
      `The "error/message" argument is ambiguous. ${normalized.ambiguous}`,
    );
  }
  const { expected, message } = normalized;

  if (actual === noException) {
    const details = `${expected?.name ? ` (${expected.name})` : ""}${message ? `: ${message}` : "."}`;
    const kind = fn === rejects ? "rejection" : "exception";
    innerFail({
      actual: undefined,
      expected,
      message: `Missing expected ${kind}${details}`,
      operator: fn.name,
      stackStartFn: fn,
      diff: assertOptions(receiver)?.diff,
    });
  }
  if (expected != null) expectedException(actual, expected, message, fn, receiver);
}

function matchingUnwantedError(actual, expected) {
  if (isRegExpValue(expected)) return RegExp.prototype.exec.call(expected, String(actual)) !== null;
  if (typeof expected !== "function") throw invalidArgType("expected", "a function or RegExp", expected);
  if (expected.prototype !== undefined && safeInstanceOf(actual, expected)) return true;
  if (Object.prototype.isPrototypeOf.call(Error, expected)) return false;
  return Reflect.apply(expected, {}, [actual]) === true;
}

function expectsNoError(receiver, fn, actual, args) {
  if (actual === noException) return;
  let [expected, message] = args;
  if (typeof expected === "string") {
    message = expected;
    expected = undefined;
  }
  if (expected == null || matchingUnwantedError(actual, expected)) {
    const kind = fn === doesNotReject ? "rejection" : "exception";
    innerFail({
      actual,
      expected,
      message: `Got unwanted ${kind}${message ? `: ${message}` : "."}\nActual message: "${actual?.message}"`,
      operator: fn.name,
      stackStartFn: fn,
      diff: assertOptions(receiver)?.diff,
    });
  }
  throw actual;
}

export function throws(fn, ...args) {
  expectsError(this, throws, getActual(fn), args);
}

export function doesNotThrow(fn, ...args) {
  expectsNoError(this, doesNotThrow, getActual(fn), args);
}

export async function rejects(fn, ...args) {
  expectsError(this, rejects, await waitForActual(fn), args);
}

export async function doesNotReject(fn, ...args) {
  expectsNoError(this, doesNotReject, await waitForActual(fn), args);
}

function describeReceivedForMatch(value) {
  return `type ${typeof value} (${formatAssertionValue(value)})`;
}

function internalMatch(string, regexp, message, operator) {
  if (!isRegExpValue(regexp)) {
    throw invalidArgType("regexp", "an instance of RegExp", regexp);
  }
  const shouldMatch = operator === "match";
  if (typeof string !== "string" || (RegExp.prototype.exec.call(regexp, string) !== null) !== shouldMatch) {
    if (isErrorObject(message)) throw message;
    const generatedMessage = !message;
    if (!message) {
      message = typeof string !== "string"
        ? `The "string" argument must be of type string. Received ${describeReceivedForMatch(string)}`
        : (shouldMatch
            ? "The input did not match the regular expression "
            : "The input was expected to not match the regular expression ") +
          `${formatAssertionValue(regexp)}. Input:\n\n${formatAssertionValue(string)}\n`;
    }
    throw new AssertionError({
      actual: string,
      expected: regexp,
      message,
      operator,
      generatedMessage,
      stackStartFn: shouldMatch ? match : doesNotMatch,
      diff: assertOptions(this)?.diff,
    });
  }
}

export function match(string, regexp, message) {
  internalMatch.call(this, string, regexp, message, "match");
}

export function doesNotMatch(string, regexp, message) {
  internalMatch.call(this, string, regexp, message, "doesNotMatch");
}

export function ifError(value) {
  if (value === null || value === undefined) return;
  let message = "ifError got unwanted exception: ";
  if (isObject(value) && typeof value.message === "string") {
    message += value.message.length === 0 && value.constructor
      ? value.constructor.name
      : value.message;
  } else {
    message += formatAssertionValue(value);
  }

  const error = new AssertionError({
    actual: value,
    expected: null,
    message,
    operator: "ifError",
    stackStartFn: ifError,
    diff: assertOptions(this)?.diff,
  });
  if (typeof value?.stack === "string" && typeof error.stack === "string") {
    const originalStart = value.stack.indexOf("\n    at");
    if (originalStart !== -1) {
      const originalFrames = value.stack.slice(originalStart + 1).split("\n");
      let newFrames = error.stack.split("\n");
      for (let index = 0; index < originalFrames.length; index += 1) {
        const duplicate = newFrames.indexOf(originalFrames[index]);
        if (duplicate !== -1) {
          newFrames = newFrames.slice(0, duplicate);
          break;
        }
      }
      error.stack = `${newFrames.join("\n")}\n${originalFrames.join("\n")}`;
    }
  }
  throw error;
}

export function partialDeepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (!deepEqualValue(actual, expected, kPartial)) {
    innerFail({
      actual,
      expected,
      message,
      operator: "partialDeepStrictEqual",
      stackStartFn: partialDeepStrictEqual,
      diff: assertOptions(this)?.diff,
    });
  }
}

Object.assign(Assert.prototype, {
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
  ok: function ok(...args) {
    return assertOk(this, ok, args);
  },
  partialDeepStrictEqual,
  rejects,
  strictEqual,
  throws,
});

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

export const strict = Object.assign(function strict(...args) {
  return assertOk(this, strict, args);
}, assert, {
  equal: strictEqual,
  deepEqual: deepStrictEqual,
  notEqual: notStrictEqual,
  notDeepEqual: notDeepStrictEqual,
});
strict.Assert = Assert;
strict.strict = strict;
assert.strict = strict;

export default assert;
