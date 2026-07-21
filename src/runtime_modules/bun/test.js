import nodeAssert from "../node/assert.js";
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from "../node/fs.js";
import { AsyncLocalStorage } from "../node/async_hooks.js";
import { applyBunFileConcurrency } from "../internal/bun-test-concurrency.js";
import { formatBunEachLabel, validateBunEachTable } from "../internal/bun-test-each.js";
import { captureTestRegistrationLine } from "../internal/bun-test-junit.js";
import {
  bunTestFilterIsActive,
  bunTestNameMatches,
  installBunTestFilterReporter,
  restoreBunTestFilterArgument,
} from "../internal/bun-test-filter.js";
import {
  beginBunTestCollection,
  createBunTestOrderScope,
  enqueueBunTestEntry,
  enqueueBunTestHook,
  flushBunTestOrderScope,
  reportBunTestRandomizationSeed,
} from "../internal/bun-test-order.js";
import {
  after as nodeAfter,
  afterEach as nodeAfterEach,
  before as nodeBefore,
  beforeEach as nodeBeforeEach,
  describe as nodeDescribe,
  mock as nodeMock,
  onTestFinished as nodeOnTestFinished,
  setDefaultTimeout as nodeSetDefaultTimeout,
  test as nodeTest,
} from "../node/test.js";

// Test orchestration must not depend on userland replacing the global constructor.
const Promise = globalThis.Promise;
const queueMicrotask = globalThis.queueMicrotask.bind(globalThis);

restoreBunTestFilterArgument();

function safeUncaughtDescriptorValue(object, name) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function formatUncaughtPlainObject(value) {
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || typeof key !== "string") continue;
    let rendered;
    if (!("value" in descriptor)) rendered = descriptor.get && descriptor.set ? "[Getter/Setter]" : descriptor.get ? "[Getter]" : "[Setter]";
    else if (typeof descriptor.value === "string") rendered = JSON.stringify(descriptor.value);
    else rendered = String(descriptor.value);
    entries.push(`  ${key}: ${rendered},`);
  }
  return `{\n${entries.join("\n")}\n}`;
}

function uncaughtRuntimeTrailer() {
  const version = globalThis.Bun?.version_with_sha ?? globalThis.Bun?.version ?? "unknown";
  return `\n\nBun v${version}`;
}

globalThis.__cottontailFormatUncaughtException ??= (value) => {
  if (!value || typeof value !== "object") return null;
  const code = safeUncaughtDescriptorValue(value, "code");
  const syscall = safeUncaughtDescriptorValue(value, "syscall");
  const errno = safeUncaughtDescriptorValue(value, "errno");
  const path = safeUncaughtDescriptorValue(value, "path");
  const message = safeUncaughtDescriptorValue(value, "message");
  if (typeof code === "string" && typeof syscall === "string" && typeof errno === "number" && typeof message === "string") {
    const fields = [
      ...(path === undefined ? [] : [["path", JSON.stringify(path)]]),
      ["syscall", JSON.stringify(syscall)],
      ["errno", String(errno)],
      ["code", JSON.stringify(code)],
    ];
    return `${message}\n${fields.map(([key, field], index) =>
      `${key.padStart(8)}: ${field}${index + 1 === fields.length ? "" : ","}`
    ).join("\n")}${uncaughtRuntimeTrailer()}`;
  }
  const sourceURL = safeUncaughtDescriptorValue(value, "sourceURL") ?? safeUncaughtDescriptorValue(value, "fileName");
  const line = safeUncaughtDescriptorValue(value, "line") ?? safeUncaughtDescriptorValue(value, "lineNumber");
  if (typeof message === "string" && (sourceURL != null || line != null)) {
    const location = `${sourceURL == null ? "<script>" : String(sourceURL)}${line == null ? "" : `:${line}`}`;
    return `error: ${message}\n${formatUncaughtPlainObject(value)}\n      at ${location}${uncaughtRuntimeTrailer()}`;
  }
  return null;
};

const mocks = new Set();
const restores = [];
const mockRestoreSymbol = Symbol("mockRestore");
let nextInvocationCallOrder = 1;
const moduleMocks = globalThis.__cottontailBunModuleMocks ??= new Map();
const snapshots = new Map();
const snapshotCounters = new Map();
const snapshotFiles = new Map();
const inlineSnapshotFiles = new Map();
const snapshotFileHeader = "// Bun Snapshot v1, https://bun.sh/docs/test/snapshots\n";
const snapshotReporter = { added: 0, passed: 0, failed: 0, reported: false };
let fakeSystemTime = null;
let fakeTimersEnabled = false;
let fakeNow = Date.now();
let fakeDateNanoseconds = BigInt(Math.trunc(fakeNow * 1e6));
let fakeHrtimeNanoseconds = 0n;
let fakePerformanceOrigin = fakeNow;
let nextFakeTimerId = 1;
const fakeTimers = new Map();
const realTimers = {
  Date: globalThis.Date,
  clearImmediate: globalThis.clearImmediate,
  clearInterval: globalThis.clearInterval,
  clearTimeout: globalThis.clearTimeout,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  processHrtime: globalThis.process?.hrtime,
  setImmediate: globalThis.setImmediate,
  setInterval: globalThis.setInterval,
  setTimeout: globalThis.setTimeout,
  performanceNow: globalThis.performance?.now?.bind(globalThis.performance),
};
const nativeDateNow = realTimers.Date.now.bind(realTimers.Date);
const nativeDateTimeFormatDescriptor = globalThis.Intl?.DateTimeFormat?.prototype
  ? Object.getOwnPropertyDescriptor(globalThis.Intl.DateTimeFormat.prototype, "format")
  : undefined;

function testDateNow() {
  return fakeTimersEnabled ? timerClock() : nativeDateNow();
}

let testDateConstructor;
testDateConstructor = new Proxy(realTimers.Date, {
  apply(target, thisArg, args) {
    if (fakeTimersEnabled && args.length === 0) return new target(timerClock()).toString();
    return Reflect.apply(target, thisArg, args);
  },
  construct(target, args, newTarget) {
    const actualArgs = fakeTimersEnabled && args.length === 0 ? [timerClock()] : args;
    return Reflect.construct(target, actualArgs, newTarget === testDateConstructor ? target : newTarget);
  },
});
Object.defineProperty(realTimers.Date, "now", {
  configurable: true,
  enumerable: false,
  writable: true,
  value: testDateNow,
});
Object.defineProperty(realTimers.Date.prototype, "constructor", {
  configurable: true,
  enumerable: false,
  writable: true,
  value: testDateConstructor,
});
globalThis.Date = testDateConstructor;

if (nativeDateTimeFormatDescriptor?.get) {
  const formatWrappers = new WeakMap();
  Object.defineProperty(globalThis.Intl.DateTimeFormat.prototype, "format", {
    ...nativeDateTimeFormatDescriptor,
    get() {
      let wrapped = formatWrappers.get(this);
      if (wrapped) return wrapped;
      const nativeFormat = nativeDateTimeFormatDescriptor.get.call(this);
      wrapped = function format(value) {
        if (arguments.length === 0 && fakeTimersEnabled) return nativeFormat(timerClock());
        return arguments.length === 0 ? nativeFormat() : nativeFormat(value);
      };
      formatWrappers.set(this, wrapped);
      return wrapped;
    },
  });
}
const assertionStates = new WeakMap();
const fallbackAssertionState = { count: 0, expected: null, required: false };
globalThis.__cottontailTestAssertionCount ??= 0;
globalThis.__cottontailTestSnapshotCount ??= 0;

function currentAssertionState() {
  const token = globalThis.__cottontailCurrentTestToken?.();
  if (!token || (typeof token !== "object" && typeof token !== "function")) return fallbackAssertionState;
  let state = assertionStates.get(token);
  if (!state) {
    state = { count: 0, expected: null, required: false };
    assertionStates.set(token, state);
  }
  return state;
}

function countAssertion() {
  currentAssertionState().count += 1;
  globalThis.__cottontailTestAssertionCount = Number(globalThis.__cottontailTestAssertionCount ?? 0) + 1;
}

function countSnapshotAssertion() {
  countAssertion();
  countSnapshot();
}

function countSnapshot() {
  globalThis.__cottontailTestSnapshotCount = Number(globalThis.__cottontailTestSnapshotCount ?? 0) + 1;
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function isPromiseLike(value) {
  return value != null && typeof value.then === "function";
}

function promiseFromActual(actual, mode) {
  const value = typeof actual === "function" ? actual() : actual;
  if (!isPromiseLike(value)) {
    throw new nodeAssert.AssertionError({
      message: `Matcher error: received value must be a promise or a function returning a promise for expect.${mode}`,
    });
  }
  return value;
}

function nativePromiseState(value) {
  const host = globalThis.cottontail;
  if (!(value instanceof Promise) || typeof host?.promiseStatus !== "function" ||
      typeof host?.promiseResult !== "function") {
    return null;
  }
  const status = host.promiseStatus(value);
  if (status < 0 || status > 2) return null;
  return { status, value: status === 0 ? undefined : host.promiseResult(value) };
}

function promiseModeError(mode, value) {
  return new nodeAssert.AssertionError({
    message: mode === "resolves"
      ? `Received promise rejected instead of resolved: ${formatValue(value)}`
      : "Received promise resolved instead of rejected",
  });
}

function deepEqual(left, right) {
  try {
    nodeAssert.deepStrictEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

const objectPrototypeToString = Object.prototype.toString;
const mapSizeGetter = Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get;
const setSizeGetter = Object.getOwnPropertyDescriptor(Set.prototype, "size")?.get;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const sharedArrayBufferByteLengthGetter = typeof SharedArrayBuffer === "function"
  ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get
  : undefined;
const regexpSourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get;
const dateGetTime = Date.prototype.getTime;

function hasIntrinsicSlot(getter, value) {
  if (typeof getter !== "function" || value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    getter.call(value);
    return true;
  } catch {
    return false;
  }
}

function isMapValue(value) {
  return hasIntrinsicSlot(mapSizeGetter, value);
}

function isSetValue(value) {
  return hasIntrinsicSlot(setSizeGetter, value);
}

function isDateValue(value) {
  return hasIntrinsicSlot(dateGetTime, value);
}

function isRegExpValue(value) {
  return hasIntrinsicSlot(regexpSourceGetter, value);
}

function isErrorValue(value) {
  if (typeof Error.isError === "function") return Error.isError(value);
  return objectPrototypeToString.call(value) === "[object Error]";
}

function binaryBufferKind(value) {
  if (value === null || typeof value !== "object") return null;
  const tag = objectPrototypeToString.call(value);
  if (tag === "[object SharedArrayBuffer]" || hasIntrinsicSlot(sharedArrayBufferByteLengthGetter, value)) {
    return "shared";
  }
  return hasIntrinsicSlot(arrayBufferByteLengthGetter, value) ? "array" : null;
}

function plainObjectEntries(value) {
  if (!isObject(value) || Array.isArray(value)) return null;
  if (isDateValue(value) || isRegExpValue(value) || isMapValue(value) || isSetValue(value)) return null;
  if (ArrayBuffer.isView(value) || binaryBufferKind(value) !== null) return null;
  const proto = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (proto !== Object.prototype && proto !== null && keys.length > 0) return null;
  const entries = keys.map((key) => [key, value[key]]);
  if (proto !== Object.prototype && proto !== null) {
    entries.push(["__proto__", proto]);
  }
  return entries;
}

const binaryHashCache = new WeakMap();

function bytesForBinaryValue(value) {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (binaryBufferKind(value) !== null) return new Uint8Array(value);
  return null;
}

function binaryHash(value) {
  const cached = binaryHashCache.get(value);
  if (cached) return cached;
  const bytes = bytesForBinaryValue(value);
  let fnv = 2166136261;
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    fnv = Math.imul(fnv ^ byte, 16777619);
    sum = (sum + Math.imul(byte + 1, index + 1)) >>> 0;
  }
  const hash = `${bytes.length}:${fnv >>> 0}:${sum >>> 0}`;
  binaryHashCache.set(value, hash);
  return hash;
}

function binaryEqual(actual, expected) {
  const left = bytesForBinaryValue(actual);
  const right = bytesForBinaryValue(expected);
  if (!left || !right) return false;
  if (left.byteLength !== right.byteLength) return false;
  if (left.buffer === right.buffer && left.byteOffset === right.byteOffset) return true;
  if (left.byteLength > 64 * 1024) return binaryHash(actual) === binaryHash(expected);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isBlobLike(value) {
  return value != null &&
    typeof value === "object" &&
    typeof value.size === "number" &&
    typeof value.type === "string" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.text === "function" &&
    typeof value.slice === "function" &&
    typeof value.exists !== "function";
}

function bunDeepEqual(actual, expected, seen = new WeakMap()) {
  if (Object.is(actual, expected)) return true;
  if (isBlobLike(actual) || isBlobLike(expected)) {
    return isBlobLike(actual) && isBlobLike(expected) &&
      actual.size === expected.size &&
      actual.type === expected.type;
  }
  if (ArrayBuffer.isView(actual) || ArrayBuffer.isView(expected)) {
    if (!ArrayBuffer.isView(actual) || !ArrayBuffer.isView(expected)) return false;
    return binaryEqual(actual, expected);
  }
  const actualBufferKind = binaryBufferKind(actual);
  const expectedBufferKind = binaryBufferKind(expected);
  if (actualBufferKind !== null || expectedBufferKind !== null) {
    if (actualBufferKind !== expectedBufferKind) return false;
    return binaryEqual(actual, expected);
  }
  if (!isObject(actual) || !isObject(expected)) return false;
  let expectedSeen = seen.get(actual);
  if (expectedSeen?.has(expected)) return true;
  if (!expectedSeen) {
    expectedSeen = new WeakSet();
    seen.set(actual, expectedSeen);
  }
  expectedSeen.add(expected);

  const actualEntries = plainObjectEntries(actual);
  const expectedEntries = plainObjectEntries(expected);
  if (!actualEntries || !expectedEntries) return deepEqual(actual, expected);
  if (actualEntries.length !== expectedEntries.length) return false;
  actualEntries.sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  expectedEntries.sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  for (let index = 0; index < actualEntries.length; index += 1) {
    if (actualEntries[index][0] !== expectedEntries[index][0]) return false;
    if (!bunDeepEqual(actualEntries[index][1], expectedEntries[index][1], seen)) return false;
  }
  return true;
}

function hasProperty(object, path) {
  if (Array.isArray(path)) {
    let cursor = object;
    for (const part of path) {
      if ((typeof part !== "string" && typeof part !== "number") || cursor == null || !(part in Object(cursor))) {
        return [false, undefined];
      }
      cursor = cursor[part];
    }
    return [true, cursor];
  }

  const source = String(path);
  if (source.length === 0) {
    return object != null && "" in Object(object) ? [true, object[""]] : [false, undefined];
  }

  let cursor = object;
  let index = 0;
  let tokenStart = 0;
  let tokenEnd = 0;
  const read = (key) => {
    if (cursor == null || !(key in Object(cursor))) return false;
    cursor = cursor[key];
    return true;
  };

  if (source[0] === "." && !read("")) return [false, undefined];
  while (index < source.length) {
    let character = source[index];
    while (character === "[" || character === "]" || character === ".") {
      index++;
      if (index === source.length) {
        if (character === ".") return read("") ? [true, cursor] : [false, undefined];
        return tokenEnd === 0 ? [false, undefined] : [true, cursor];
      }
      const previous = character;
      character = source[index];
      if (previous === "." && character === "." && !read("")) return [false, undefined];
    }

    tokenStart = index;
    while (index < source.length && source[index] !== "[" && source[index] !== "]" && source[index] !== ".") {
      index++;
    }
    if (!read(source.slice(tokenStart, index))) return [false, undefined];
    tokenEnd = index;
  }
  return [true, cursor];
}

function matcherName(expected) {
  return expected?.__expectMatcher;
}

function mapMatchResult(result, callback) {
  return isPromiseLike(result) ? Promise.resolve(result).then(callback) : callback(result);
}

function everyMatch(values, callback) {
  const results = values.map(callback);
  return results.some(isPromiseLike)
    ? Promise.all(results).then((settled) => settled.every(Boolean))
    : results.every(Boolean);
}

function someMatch(values, callback) {
  const results = values.map(callback);
  return results.some(isPromiseLike)
    ? Promise.all(results).then((settled) => settled.some(Boolean))
    : results.some(Boolean);
}

function findMatchingIndex(values, callback, start = 0) {
  for (let index = start; index < values.length; index += 1) {
    const result = callback(values[index]);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then((matched) => matched ? index : findMatchingIndex(values, callback, index + 1));
    }
    if (result) return index;
  }
  return -1;
}

function matchUnordered(expectedValues, actualValues, callback, expectedIndex = 0) {
  if (expectedIndex >= expectedValues.length) return true;
  const matchIndex = findMatchingIndex(actualValues, (actualValue) => callback(actualValue, expectedValues[expectedIndex]));
  return mapMatchResult(matchIndex, (index) => {
    if (index < 0) return false;
    const remaining = actualValues.slice();
    remaining.splice(index, 1);
    return matchUnordered(expectedValues, remaining, callback, expectedIndex + 1);
  });
}

function matchesAnyConstructor(actual, type) {
  if (type === String) return typeof actual === "string" || actual instanceof String;
  if (type === Number) return typeof actual === "number" || actual instanceof Number;
  if (type === Boolean) return typeof actual === "boolean" || actual instanceof Boolean;
  if (type === BigInt) return typeof actual === "bigint" || Object.prototype.toString.call(actual) === "[object BigInt]";
  if (type === Symbol) return typeof actual === "symbol" || Object.prototype.toString.call(actual) === "[object Symbol]";
  if (type === Function) return typeof actual === "function";
  if (type === Array) return Array.isArray(actual);
  if (type === Object) return actual !== null && (typeof actual === "object" || typeof actual === "function");
  if (type === Promise) return isPromiseLike(actual);
  return actual instanceof type;
}

function rawAsymmetricMatch(actual, expected) {
  switch (matcherName(expected)) {
    case "any":
      return matchesAnyConstructor(actual, expected.type);
    case "anything":
      return actual != null;
    case "arrayContaining":
      return Array.isArray(actual) && everyMatch(
        expected.items,
        (item) => someMatch(actual, (candidate) => matchesExpected(candidate, item)),
      );
    case "objectContaining":
      return isObject(actual) && everyMatch(Reflect.ownKeys(expected.shape), (key) =>
        key in Object(actual) && matchesExpected(actual[key], expected.shape[key]));
    case "stringContaining":
      return typeof actual === "string" && actual.includes(expected.text);
    case "stringMatching": {
      if (typeof actual !== "string") return false;
      if (typeof expected.pattern === "string") return actual.includes(expected.pattern);
      expected.pattern.lastIndex = 0;
      return expected.pattern.test(actual);
    }
    case "closeTo":
      if (typeof actual !== "number") return false;
      if (Object.is(actual, expected.value)) return true;
      return Math.abs(expected.value - actual) < 0.5 * 10 ** -expected.precision;
    case "custom": {
      const result = invokeCustomMatcher(expected.name, expected.matcher, expected.negate, actual, expected.args);
      const finish = (value) => customMatcherResult(expected.name, value).pass;
      return isPromiseLike(result) ? Promise.resolve(result).then(finish) : finish(result);
    }
    case "not":
      {
        const result = asymmetricMatch(actual, expected.matcher);
        return isPromiseLike(result) ? Promise.resolve(result).then((pass) => !pass) : !result;
      }
    default:
      return false;
  }
}

function asymmetricMatch(actual, expected) {
  const finish = (result, matchedValue, evaluated) => mapMatchResult(result, (pass) => {
    if (!expected.negate) return Boolean(pass);
    // Bun intentionally does not let `expect.not.closeTo()` match non-numbers.
    if (evaluated && matcherName(expected) === "closeTo" && typeof matchedValue !== "number") return false;
    return !pass;
  });

  if (expected.promiseMode) {
    if (!isPromiseLike(actual)) return finish(false, actual, false);
    return Promise.resolve(actual).then(
      (value) => expected.promiseMode === "resolves"
        ? finish(rawAsymmetricMatch(value, expected), value, true)
        : finish(false, value, false),
      (error) => expected.promiseMode === "rejects"
        ? finish(rawAsymmetricMatch(error, expected), error, true)
        : finish(false, error, false),
    );
  }

  return finish(rawAsymmetricMatch(actual, expected), actual, true);
}

const missingArrayValue = Symbol("missing array value");

function enumerableOwnKeys(value, symbolsOnly = false) {
  return Reflect.ownKeys(value).filter((key) =>
    (!symbolsOnly || typeof key === "symbol") &&
    Object.prototype.propertyIsEnumerable.call(value, key));
}

function arrayDataValue(value, index) {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  return descriptor && "value" in descriptor ? descriptor.value : missingArrayValue;
}

function calculatedClassName(value) {
  try {
    return value?.constructor?.name ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function sameEntries(left, right) {
  const leftEntries = Array.from(left.entries());
  const rightEntries = Array.from(right.entries());
  if (leftEntries.length !== rightEntries.length) return false;
  for (let index = 0; index < leftEntries.length; index++) {
    if (leftEntries[index][0] !== rightEntries[index][0] || leftEntries[index][1] !== rightEntries[index][1]) return false;
  }
  return true;
}

function matchEverySequential(values, callback, index = 0) {
  for (; index < values.length; index++) {
    const result = callback(values[index], index);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(async (matched) => {
        if (!matched) return false;
        for (let remaining = index + 1; remaining < values.length; remaining++) {
          if (!await callback(values[remaining], remaining)) return false;
        }
        return true;
      });
    }
    if (!result) return false;
  }
  return true;
}

function finishExpectedPair(state, result) {
  if (isPromiseLike(result)) {
    return Promise.resolve(result).then(
      (value) => {
        state.pairs.pop();
        return value;
      },
      (error) => {
        state.pairs.pop();
        throw error;
      },
    );
  }
  state.pairs.pop();
  return result;
}

function matchesEnumerableProperties(actual, expected, state, strict) {
  if (strict && calculatedClassName(actual) !== calculatedClassName(expected)) return false;
  const actualKeys = enumerableOwnKeys(actual);
  const expectedKeys = enumerableOwnKeys(expected);
  if (strict && actualKeys.length !== expectedKeys.length) return false;
  const keys = Array.from(new Set([...actualKeys, ...expectedKeys]));
  return matchEverySequential(keys, (key) => {
    const leftHas = Object.hasOwn(actual, key);
    const rightHas = Object.hasOwn(expected, key);
    const left = leftHas ? actual[key] : missingArrayValue;
    const right = rightHas ? expected[key] : missingArrayValue;
    if (!strict && (left === missingArrayValue || right === missingArrayValue) &&
        (left === missingArrayValue || left === undefined) &&
        (right === missingArrayValue || right === undefined)) {
      return true;
    }
    if (!leftHas || !rightHas) return false;
    return matchesExpected(left, right, state, strict);
  });
}

function matchesExpectedObject(actual, expected, state, strict) {
  if (isBlobLike(actual) || isBlobLike(expected)) {
    return isBlobLike(actual) && isBlobLike(expected) &&
      actual.size === expected.size && actual.type === expected.type;
  }

  if (objectPrototypeToString.call(actual) === "[object Dirent]" &&
      objectPrototypeToString.call(expected) === "[object Dirent]") {
    return matchesEnumerableProperties(actual, expected, state, strict);
  }

  const actualView = ArrayBuffer.isView(actual);
  const expectedView = ArrayBuffer.isView(expected);
  if (actualView || expectedView) {
    if (!actualView || !expectedView) return false;
    if (Object.prototype.toString.call(actual) !== Object.prototype.toString.call(expected)) return false;
    return binaryEqual(actual, expected);
  }

  const actualBufferKind = binaryBufferKind(actual);
  const expectedBufferKind = binaryBufferKind(expected);
  if (actualBufferKind !== null || expectedBufferKind !== null) {
    if (actualBufferKind !== expectedBufferKind) return false;
    return binaryEqual(actual, expected);
  }

  const actualDate = isDateValue(actual);
  const expectedDate = isDateValue(expected);
  if (actualDate || expectedDate) {
    return actualDate && expectedDate && dateGetTime.call(actual) === dateGetTime.call(expected);
  }
  const actualRegExp = isRegExpValue(actual);
  const expectedRegExp = isRegExpValue(expected);
  if (actualRegExp || expectedRegExp) {
    return actualRegExp && expectedRegExp &&
      actual.source === expected.source && actual.flags === expected.flags;
  }
  const actualError = isErrorValue(actual);
  const expectedError = isErrorValue(expected);
  if (actualError || expectedError) {
    if (!actualError || !expectedError) return false;
    if (actual.name !== expected.name || actual.message !== expected.message) return false;
    if (strict && Object.hasOwn(actual, "cause") !== Object.hasOwn(expected, "cause")) return false;
    if (!matchesExpected(actual.cause, expected.cause, state, strict)) return false;
  }

  const actualURL = typeof URL === "function" && actual instanceof URL;
  const expectedURL = typeof URL === "function" && expected instanceof URL;
  if (actualURL && expectedURL && actual.href !== expected.href) return false;
  if (strict && actualURL !== expectedURL) return false;

  const actualSearchParams = typeof URLSearchParams === "function" && actual instanceof URLSearchParams;
  const expectedSearchParams = typeof URLSearchParams === "function" && expected instanceof URLSearchParams;
  if (actualSearchParams && expectedSearchParams && !sameEntries(actual, expected)) return false;
  if (strict && actualSearchParams !== expectedSearchParams) return false;

  const actualHeaders = typeof Headers === "function" && actual instanceof Headers;
  const expectedHeaders = typeof Headers === "function" && expected instanceof Headers;
  if (actualHeaders && expectedHeaders && !sameEntries(actual, expected)) return false;
  if (strict && actualHeaders !== expectedHeaders) return false;

  const actualTag = Object.prototype.toString.call(actual);
  const expectedTag = Object.prototype.toString.call(expected);
  if (actualTag === "[object String]" || expectedTag === "[object String]") {
    return actualTag === expectedTag && calculatedClassName(actual) === calculatedClassName(expected) &&
      String(actual) === String(expected);
  }
  if (actualTag === "[object Number]" || expectedTag === "[object Number]" ||
      actualTag === "[object Boolean]" || expectedTag === "[object Boolean]") {
    if (actualTag !== expectedTag || !Object.is(actual.valueOf(), expected.valueOf())) return false;
  }

  const actualMap = isMapValue(actual);
  const expectedMap = isMapValue(expected);
  if (actualMap || expectedMap) {
    if (!actualMap || !expectedMap || actual.size !== expected.size) return false;
    return matchUnordered(Array.from(expected.entries()), Array.from(actual.entries()), ([actualKey, actualValue], [expectedKey, expectedValue]) => {
      const keyMatch = matchesExpected(actualKey, expectedKey, state, strict);
      return mapMatchResult(keyMatch, (keyMatched) => keyMatched && matchesExpected(actualValue, expectedValue, state, strict));
    });
  }
  const actualSet = isSetValue(actual);
  const expectedSet = isSetValue(expected);
  if (actualSet || expectedSet) {
    if (!actualSet || !expectedSet || actual.size !== expected.size) return false;
    return matchUnordered(Array.from(expected.values()), Array.from(actual.values()),
      (actualValue, expectedValue) => matchesExpected(actualValue, expectedValue, state, strict));
  }

  const actualArray = Array.isArray(actual);
  const expectedArray = Array.isArray(expected);
  if (actualArray !== expectedArray) return false;
  if (actualArray) {
    if (strict && actual.length !== expected.length) return false;
    const length = Math.max(actual.length, expected.length);
    const indicesMatch = matchEverySequential(Array.from({ length }, (_, index) => index), (index) => {
      const left = arrayDataValue(actual, index);
      const right = arrayDataValue(expected, index);
      if (strict) {
        if (left === missingArrayValue || right === missingArrayValue) return left === right;
      } else if ((left === missingArrayValue || right === missingArrayValue) &&
          (left === missingArrayValue || left === undefined) &&
          (right === missingArrayValue || right === undefined)) {
        return true;
      }
      return matchesExpected(left, right, state, strict);
    });
    return mapMatchResult(indicesMatch, (matched) => {
      if (!matched) return false;
      const actualSymbols = enumerableOwnKeys(actual, true);
      const expectedSymbols = enumerableOwnKeys(expected, true);
      if (strict && actualSymbols.length !== expectedSymbols.length) return false;
      const symbols = Array.from(new Set([...actualSymbols, ...expectedSymbols]));
      return matchEverySequential(symbols, (key) => {
        const leftHas = Object.hasOwn(actual, key);
        const rightHas = Object.hasOwn(expected, key);
        if (!strict && (!leftHas || !rightHas) && (!leftHas || actual[key] === undefined) && (!rightHas || expected[key] === undefined)) {
          return true;
        }
        return leftHas && rightHas && matchesExpected(actual[key], expected[key], state, strict);
      });
    });
  }

  return matchesEnumerableProperties(actual, expected, state, strict);
}

function matchesExpected(actual, expected, state = undefined, strict = false) {
  if (matcherName(expected)) return asymmetricMatch(actual, expected);
  if (matcherName(actual)) return asymmetricMatch(expected, actual);
  if (Object.is(actual, expected)) return true;
  if (!isObject(actual) || !isObject(expected)) return false;
  state ??= { pairs: [] };
  for (const pair of state.pairs) {
    if (pair.actual === actual) return pair.expected === expected;
    if (pair.expected === expected) return false;
  }
  state.pairs.push({ actual, expected });
  try {
    return finishExpectedPair(state, matchesExpectedObject(actual, expected, state, strict));
  } catch (error) {
    state.pairs.pop();
    throw error;
  }
}

function matchesObjectSubset(actual, expected, seen = new WeakMap()) {
  if (matcherName(expected)) return asymmetricMatch(actual, expected);
  if (matcherName(actual)) return asymmetricMatch(expected, actual);
  if (Object.is(actual, expected)) return true;
  if (!isObject(actual) || !isObject(expected)) return matchesExpected(actual, expected, seen);

  let expectedSeen = seen.get(actual);
  if (expectedSeen?.has(expected)) return true;
  if (!expectedSeen) {
    expectedSeen = new WeakSet();
    seen.set(actual, expectedSeen);
  }
  expectedSeen.add(expected);

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    const actualKeys = Reflect.ownKeys(actual).filter((key) => Object.prototype.propertyIsEnumerable.call(actual, key));
    const expectedKeys = Reflect.ownKeys(expected).filter((key) => Object.prototype.propertyIsEnumerable.call(expected, key));
    if (actualKeys.length !== expectedKeys.length ||
        !expectedKeys.every((key) => actualKeys.some((actualKey) => actualKey === key))) {
      return false;
    }
    return everyMatch(expectedKeys, (key) => matchesObjectSubset(actual[key], expected[key], seen));
  }

  if (isDateValue(expected) || isRegExpValue(expected) || isMapValue(expected) || isSetValue(expected) ||
    ArrayBuffer.isView(expected) || binaryBufferKind(expected) !== null) {
    return matchesExpected(actual, expected);
  }

  const keys = Reflect.ownKeys(expected).filter((key) => Object.prototype.propertyIsEnumerable.call(expected, key));
  return everyMatch(keys, (key) => key in Object(actual) && matchesObjectSubset(actual[key], expected[key], seen));
}

function formatValue(value) {
  try {
    const serialized = JSON.stringify(value);
    const formatted = serialized === undefined ? String(value) : serialized;
    const maxLength = 20_000;
    if (formatted.length <= maxLength) return formatted;
    const edgeLength = Math.floor(maxLength / 2);
    const omitted = formatted.length - edgeLength * 2;
    return `${formatted.slice(0, edgeLength)}... (${omitted} characters truncated) ...${formatted.slice(-edgeLength)}`;
  } catch {
    return String(value);
  }
}

function snapshotQuoteString(value) {
  const text = String(value).replace(/\r\n?/g, "\n");
  return text.includes("\n") ? `\n"${text}"\n` : `"${text}"`;
}

function indentSnapshotBlock(text) {
  return String(text).split("\n").map((line) => `  ${line}`).join("\n");
}

function snapshotMatcherText(value) {
  switch (matcherName(value)) {
    case "any":
      return `Any<${value.type?.name || "anonymous"}>`;
    case "anything":
      return "Anything";
    case "arrayContaining":
      return `ArrayContaining ${snapshotSerialize(value.items)}`;
    case "objectContaining":
      return `ObjectContaining ${snapshotSerialize(value.shape)}`;
    case "stringContaining":
      return `StringContaining ${snapshotQuoteString(value.text)}`;
    case "stringMatching":
      return `StringMatching ${snapshotSerialize(value.pattern)}`;
    case "closeTo":
      return `CloseTo<${String(value.value)}, ${String(value.precision)}>`;
    case "custom":
      return typeof value.toAsymmetricMatcher === "function" ? String(value.toAsymmetricMatcher()) : String(value.name);
    case "not":
      return `Not<${snapshotMatcherText(value.matcher)}>`;
    default:
      return null;
  }
}

function snapshotObjectEntries(value) {
  return Reflect.ownKeys(value)
    .filter((key) => Object.prototype.propertyIsEnumerable.call(value, key))
    .sort((left, right) => String(left).localeCompare(String(right)));
}

function snapshotObjectKey(key) {
  return typeof key === "symbol" ? `[${String(key)}]` : JSON.stringify(String(key));
}

function snapshotObjectBody(value, prefix, seen) {
  const keys = snapshotObjectEntries(value);
  if (keys.length === 0) return `${prefix}{}`;
  return [
    `${prefix}{`,
    ...keys.map((key) => {
      const item = snapshotSerialize(value[key], seen);
      if (item.startsWith("\n") && item.endsWith("\n")) {
        return `  ${snapshotObjectKey(key)}: ${item},`;
      }
      const lines = item.split("\n");
      return [
        `  ${snapshotObjectKey(key)}: ${lines[0]}`,
        ...lines.slice(1).map((line) => `  ${line}`),
      ].join("\n") + ",";
    }),
    "}",
  ].join("\n");
}

function snapshotSerialize(value, seen = new Set()) {
  const asymmetric = snapshotMatcherText(value);
  if (asymmetric != null) return asymmetric;
  if (typeof value === "string") return snapshotQuoteString(value);
  if (typeof value === "function") return value.name ? `[Function: ${value.name}]` : "[Function]";
  if (typeof value === "symbol") return String(value);
  if (typeof globalThis.ErrorEvent === "function" && value instanceof globalThis.ErrorEvent) {
    const error = value.error == null
      ? String(value.error)
      : value.error instanceof Error
        ? `[${value.error.name || "Error"}: ${String(value.error.message ?? "")}]`
        : snapshotSerialize(value.error);
    return `ErrorEvent {\n  type: ${JSON.stringify(String(value.type))},\n  message: ${JSON.stringify(String(value.message))}, \n  error: ${error}\n}`;
  }
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  if (isDateValue(value)) return value.toISOString();
  if (isRegExpValue(value)) return String(value);
  if (isErrorValue(value)) return value.message ? `[${value.name || "Error"}: ${value.message}]` : `[${value.name || "Error"}]`;
  if (typeof Promise === "function" && value instanceof Promise) return "Promise {}";
  if (typeof WeakMap === "function" && value instanceof WeakMap) return "WeakMap {}";
  if (typeof WeakSet === "function" && value instanceof WeakSet) return "WeakSet {}";

  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (typeof globalThis.Buffer?.isBuffer === "function" && globalThis.Buffer.isBuffer(value)) {
      return snapshotObjectBody({ type: "Buffer", data: Array.from(value) }, "", seen);
    }
    if (binaryBufferKind(value) !== null) {
      const bytes = Array.from(new Uint8Array(value));
      const name = binaryBufferKind(value) === "shared" ? "SharedArrayBuffer" : "ArrayBuffer";
      return bytes.length === 0
        ? `${name} []`
        : `${name} [\n${bytes.map((item) => `  ${item},`).join("\n")}\n]`;
    }
    if (value instanceof DataView) {
      const bytes = Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return bytes.length === 0
        ? "DataView []"
        : `DataView [\n${bytes.map((item) => `  ${item},`).join("\n")}\n]`;
    }
    if (ArrayBuffer.isView(value)) {
      const name = value.constructor?.name || "TypedArray";
      const items = Array.from(value);
      return items.length === 0
        ? `${name} []`
        : `${name} [\n${items.map((item) => `  ${snapshotSerialize(item, seen)},`).join("\n")}\n]`;
    }
    if (isMapValue(value)) {
      if (value.size === 0) return "Map {}";
      return [
        "Map {",
        ...Array.from(value, ([key, item]) => {
          const rendered = `${snapshotSerialize(key, seen)} => ${snapshotSerialize(item, seen)}`;
          return `${indentSnapshotBlock(rendered)},`;
        }),
        "}",
      ].join("\n");
    }
    if (isSetValue(value)) {
      if (value.size === 0) return "Set {}";
      return [
        "Set {",
        ...Array.from(value, (item) => `${indentSnapshotBlock(snapshotSerialize(item, seen))},`),
        "}",
      ].join("\n");
    }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return [
      "[",
        ...value.map((item) => `${indentSnapshotBlock(snapshotSerialize(item, seen))},`),
      "]",
    ].join("\n");
  }
    const prototype = Object.getPrototypeOf(value);
    const constructorName = value.constructor?.name;
    const prefix = prototype === Object.prototype || prototype === null || !constructorName || constructorName === "Object"
      ? ""
      : `${constructorName} `;
    return snapshotObjectBody(value, prefix, seen);
  } finally {
    seen.delete(value);
  }
}

function iterableIsEmpty(value) {
  if (value == null || typeof value[Symbol.iterator] !== "function") return false;
  try {
    return Boolean(value[Symbol.iterator]().next().done);
  } catch {
    return false;
  }
}

function isEmptyValue(value) {
  if (typeof value === "string") return value.length === 0;
  if (value instanceof String) return String(value).length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (ArrayBuffer.isView(value)) return value.byteLength === 0;
  if (binaryBufferKind(value) !== null) return value.byteLength === 0;
  if (isMapValue(value) || isSetValue(value)) return value.size === 0;
  if (typeof Headers !== "undefined" && value instanceof Headers) return iterableIsEmpty(value);
  if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) return iterableIsEmpty(value);
  if (typeof FormData !== "undefined" && value instanceof FormData) return iterableIsEmpty(value);
  if (value && typeof value === "object" && typeof value.size === "number" && typeof value.text === "function") {
    return value.size === 0;
  }
  if (value && typeof value === "object" && typeof value.next === "function") {
    try {
      return Boolean(value.next().done);
    } catch {
      return false;
    }
  }
  if (value && typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function isEmptyObjectValue(value) {
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== "object") return false;
  if (isMapValue(value) || isSetValue(value) || isDateValue(value) || isRegExpValue(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.keys(value).length === 0;
}

function snapshotText(value) {
  const serialized = snapshotSerialize(value);
  if (!serialized.includes("\n")) return serialized;
  return `${serialized.startsWith("\n") ? "" : "\n"}${serialized}${serialized.endsWith("\n") ? "" : "\n"}`;
}

function normalizeSnapshotText(value) {
  const text = String(value).replace(/^\n/, "").replace(/\n\s*$/, "");
  const lines = text.split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^\s*/)[0].length);
  const commonIndent = indents.length > 0 ? Math.min(...indents) : 0;
  return commonIndent > 0
    ? lines.map((line) => line.slice(Math.min(commonIndent, line.match(/^\s*/)[0].length))).join("\n")
    : text;
}

function inlineSnapshotMatches(received, wanted) {
  if (received === wanted) return true;
  return received.replace(/\\(["\\])/g, "$1") === wanted;
}

function captureSnapshotContext(token = globalThis.__cottontailCurrentTestToken?.()) {
  const activeFile = typeof globalThis.__cottontailCurrentTestFile === "function"
    ? globalThis.__cottontailCurrentTestFile()
    : "";
  const testName = typeof globalThis.__cottontailCurrentTestName === "function"
    ? globalThis.__cottontailCurrentTestName().replace(/ > /g, " ")
    : "";
  return {
    token,
    file: activeFile || globalThis.__cottontailRegisteringTestFile || globalThis.__filename ||
      globalThis.process?.argv?.[1] || "<script>",
    testName,
  };
}

function nextSnapshotIdentity(hint = undefined, context = undefined) {
  const { file, testName } = context ?? captureSnapshotContext();
  const scope = testName ? `${file}:${testName}` : file;
  const base = hint != null ? `${scope}:${String(hint)}` : scope;
  const current = snapshotCounters.get(base) ?? 0;
  const next = current + 1;
  snapshotCounters.set(base, next);
  const exportBase = hint != null ? `${testName}: ${String(hint)}` : testName || file;
  return { key: `${base}:${next}`, exportKey: `${exportBase} ${next}`, file };
}

function snapshotFilePath(testFile) {
  let path = String(testFile);
  if (!/^(?:[A-Za-z]:)?[\\/]/.test(path)) path = `${cottontail.cwd()}/${path}`;
  path = path.replace(/\\/g, "/");
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash) : cottontail.cwd();
  const basename = slash >= 0 ? path.slice(slash + 1) : path;
  return `${directory}/__snapshots__/${basename}.snap`;
}

function snapshotUpdateRequested() {
  return Array.from(globalThis.process?.argv ?? []).some((arg) =>
    arg === "-u" || arg === "--update-snapshots" || arg === "--updateSnapshot");
}

function snapshotCreationDisabledInCI() {
  const ci = globalThis.process?.env?.CI;
  return ci != null && ci !== "" && !/^(?:0|false)$/i.test(String(ci));
}

function parseSnapshotFile(source, path) {
  const parsed = Object.create(null);
  try {
    Function("exports", String(source))(parsed);
  } catch (error) {
    throw new Error(`Failed to parse snapshot file ${path}: ${error?.message ?? String(error)}`);
  }
  return new Map(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
}

function snapshotFileState(testFile) {
  const path = snapshotFilePath(testFile);
  let state = snapshotFiles.get(path);
  if (state) return state;
  const update = snapshotUpdateRequested();
  let values = new Map();
  let exists = false;
  if (!update) {
    try {
      const source = String(cottontail.readFile(path));
      exists = true;
      values = parseSnapshotFile(source, path);
    } catch (error) {
      if (nodeExistsSync(path)) throw error;
    }
  } else {
    exists = nodeExistsSync(path);
  }
  state = { path, values, update, exists, dirty: false, pendingAdded: 0 };
  snapshotFiles.set(path, state);
  return state;
}

function escapeSnapshotTemplate(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\0/g, "\\x00")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

function renderSnapshotFile(values) {
  let source = snapshotFileHeader;
  for (const [key, value] of values) {
    source += `\nexports[\`${escapeSnapshotTemplate(key)}\`] = \`${escapeSnapshotTemplate(value)}\`;\n`;
  }
  return source;
}

function skipSnapshotTrivia(source, index) {
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index++;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) return source.length;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      return end < 0 ? source.length : skipSnapshotTrivia(source, end + 2);
    }
    break;
  }
  return index;
}

function skipSnapshotQuoted(source, index) {
  const quote = source[index++];
  while (index < source.length) {
    const character = source[index++];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === quote) return index;
  }
  return source.length;
}

function snapshotSourceLineColumn(source, offset) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index++) {
    if (source.charCodeAt(index) === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function trimSnapshotSourceRange(source, start, end) {
  while (start < end && /\s/.test(source[start])) start++;
  while (end > start && /\s/.test(source[end - 1])) end--;
  return { start, end };
}

function parseInlineSnapshotArguments(source, open) {
  const args = [];
  const commas = [];
  let segmentStart = open + 1;
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  let index = open + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "'" || character === '"' || character === "`") {
      index = skipSnapshotQuoted(source, index);
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (character === "(") parens++;
    else if (character === ")") {
      if (parens === 0 && braces === 0 && brackets === 0) {
        const range = trimSnapshotSourceRange(source, segmentStart, index);
        if (range.start < range.end) args.push(range);
        return {
          args,
          commas,
          close: index,
          trailingComma: commas.length > 0 && skipSnapshotTrivia(source, commas.at(-1) + 1) === index,
        };
      }
      parens--;
    } else if (character === "{") braces++;
    else if (character === "}") braces--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "," && parens === 0 && braces === 0 && brackets === 0) {
      const range = trimSnapshotSourceRange(source, segmentStart, index);
      if (range.start < range.end) args.push(range);
      commas.push(index);
      segmentStart = index + 1;
    }
    index++;
  }
  return null;
}

function scanInlineSnapshotCalls(source) {
  const names = ["toMatchInlineSnapshot", "toThrowErrorMatchingInlineSnapshot"];
  const calls = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "'" || character === '"' || character === "`") {
      index = skipSnapshotQuoted(source, index);
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (character !== ".") {
      index++;
      continue;
    }
    const identifierStart = skipSnapshotTrivia(source, index + 1);
    const kind = names.find((name) =>
      source.startsWith(name, identifierStart) && !/[\w$]/.test(source[identifierStart + name.length] ?? ""));
    if (!kind) {
      index++;
      continue;
    }
    const open = skipSnapshotTrivia(source, identifierStart + kind.length);
    if (source[open] !== "(") {
      index++;
      continue;
    }
    const parsed = parseInlineSnapshotArguments(source, open);
    if (!parsed) {
      index++;
      continue;
    }
    const location = snapshotSourceLineColumn(source, identifierStart);
    calls.push({ kind, identifierStart, open, ...parsed, ...location });
    index = identifierStart + kind.length;
  }
  return calls;
}

function inlineSnapshotExpressionIsLiteral(source, range) {
  const start = skipSnapshotTrivia(source, range.start);
  const quote = source[start];
  if (quote !== "'" && quote !== '"' && quote !== "`") return false;
  const end = skipSnapshotQuoted(source, start);
  if (skipSnapshotTrivia(source, end) !== range.end) return false;
  if (quote === "`") {
    const body = source.slice(start + 1, end - 1);
    for (let index = 0; index + 1 < body.length; index++) {
      if (body[index] === "\\") {
        index++;
      } else if (body[index] === "$" && body[index + 1] === "{") {
        return false;
      }
    }
  }
  return true;
}

function normalizeInlineSnapshotPath(value) {
  let path = String(value ?? "").replace(/^file:\/\//, "");
  try {
    path = decodeURIComponent(path);
  } catch {}
  if (!/^(?:[A-Za-z]:)?[\\/]/.test(path)) path = `${cottontail.cwd()}/${path}`;
  return path.replace(/\\/g, "/");
}

function inlineSnapshotCaller(kind) {
  const stack = String(new Error().stack ?? "");
  for (const line of stack.split("\n")) {
    let location = line.trim();
    const open = location.lastIndexOf("(");
    if (open >= 0) location = location.slice(open + 1).replace(/\)$/, "");
    else location = location.replace(/^at\s+(?:[^ ]+\s+)?/, "");
    const match = /^(.*):(\d+):(\d+)$/.exec(location);
    if (!match) continue;
    const file = normalizeInlineSnapshotPath(match[1]);
    if (file.includes("/.cottontail-embedded-runtime/") || file.endsWith("/runtime_modules/bun/test.js")) continue;
    return { file, line: Number(match[2]), column: Number(match[3]), kind };
  }
  throw new Error(`Failed to update inline snapshot: Could not find '${kind}' here`);
}

function inlineSnapshotTestFile(context = undefined) {
  return normalizeInlineSnapshotPath(
    context?.file ||
    globalThis.__cottontailCurrentTestFile?.() ||
    globalThis.__cottontailRegisteringTestFile ||
    globalThis.__filename ||
    globalThis.process?.argv?.[1] ||
    "",
  );
}

function inlineSnapshotFileState(path) {
  let state = inlineSnapshotFiles.get(path);
  if (state) return state;
  const source = String(cottontail.readFile(path));
  state = {
    path,
    source,
    calls: scanInlineSnapshotCalls(source),
    assignments: new Map(),
    lastCalls: new Map(),
    usedCalls: new Set(),
    edits: new Map(),
    dirty: false,
    invalid: false,
  };
  inlineSnapshotFiles.set(path, state);
  return state;
}

function resolveInlineSnapshotCall(state, caller, scope) {
  const key = `${caller.kind}:${caller.line}:${caller.column}`;
  const assigned = state.assignments.get(key);
  const previous = state.lastCalls.get(scope);
  const preferredLine = state.source.startsWith("\n") ? caller.line - 1 : caller.line;
  const candidates = state.calls
    .filter((call) => call.kind === caller.kind && !state.usedCalls.has(call.identifierStart))
    .map((call) => ({
      call,
      score: Math.min(
        Math.abs(call.line - preferredLine),
        Math.abs(call.line - caller.line),
      ) * 10000 + Math.abs(call.column - caller.column),
    }))
    .sort((left, right) => left.score - right.score || left.call.identifierStart - right.call.identifierStart);
  if (assigned) {
    if (!state.edits.has(assigned.identifierStart)) return assigned;
    // COTTONTAIL-COMPAT: stock JSC source maps can collapse the final two
    // calls in a generated block onto one location. Consume a neighboring
    // unused source call before treating this as a repeated helper call.
    const neighbor = candidates.find(({ call }) => Math.abs(call.line - preferredLine) <= 1)?.call;
    if (!neighbor) return assigned;
    state.usedCalls.add(neighbor.identifierStart);
    state.lastCalls.set(scope, neighbor);
    return neighbor;
  }
  const nextInTest = previous == null
    ? null
    : state.calls.find((call) =>
      call.kind === caller.kind &&
      call.identifierStart > previous.identifierStart &&
      !state.usedCalls.has(call.identifierStart));
  const selected = nextInTest ?? candidates[0]?.call;
  if (!selected || (nextInTest == null &&
      Math.min(Math.abs(selected.line - preferredLine), Math.abs(selected.line - caller.line)) > 2)) {
    state.invalid = true;
    throw new Error(`Failed to update inline snapshot: Could not find '${caller.kind}' here`);
  }
  state.assignments.set(key, selected);
  state.usedCalls.add(selected.identifierStart);
  state.lastCalls.set(scope, selected);
  return selected;
}

function inlineSnapshotIndentInfo(value) {
  if (typeof value !== "string" || !value.startsWith("\n")) return null;
  const lines = value.split("\n");
  if (lines[0].trim() !== "" || lines.length < 3) return null;
  const firstContent = lines.findIndex((line, index) => index > 0 && line.trim() !== "");
  if (firstContent < 0) return null;
  const startIndent = lines[firstContent].match(/^[ \t]*/)?.[0] ?? "";
  const endIndent = lines.at(-1) ?? "";
  if (endIndent.trim() !== "") return null;
  for (let index = firstContent; index < lines.length - 1; index++) {
    if (lines[index].trim() !== "" && !lines[index].startsWith(startIndent)) return null;
  }
  return { startIndent, endIndent };
}

function reindentInlineSnapshot(value, source, call, existingValue) {
  if (!value.startsWith("\n")) return value;
  const existingIndent = inlineSnapshotIndentInfo(existingValue);
  const lineStart = source.lastIndexOf("\n", call.close - 1) + 1;
  const sourceIndent = source.slice(lineStart, call.close).match(/^[ \t]*/)?.[0] ?? "";
  const startIndent = existingIndent?.startIndent ?? sourceIndent;
  const endIndent = existingIndent?.endIndent ?? sourceIndent;
  const extra = existingIndent ? "" : "  ";
  const lines = value.slice(1).split("\n");
  let output = "\n";
  for (let index = 0; index < lines.length - 1; index++) {
    const line = lines[index];
    output += line.length === 0 ? "\n" : `${startIndent}${extra}${line}\n`;
  }
  return output + endIndent;
}

function inlineSnapshotTemplate(value, source, call, existingValue) {
  const indented = reindentInlineSnapshot(value, source, call, existingValue);
  return `\`${escapeSnapshotTemplate(indented)}\``;
}

function inlineSnapshotEdit(state, call, value, hasMatchers, existingValue) {
  const fail = (message) => {
    state.invalid = true;
    throw new Error(`Failed to update inline snapshot: ${message}`);
  };
  if (call.args.some((arg) => state.source.slice(arg.start, arg.end).trimStart().startsWith("..."))) {
    fail("Spread is not allowed");
  }
  if (call.args.length > 2) fail("Snapshot expects at most two arguments");
  const replacement = inlineSnapshotTemplate(value, state.source, call, existingValue);
  if (call.args.length === 0) {
    if (hasMatchers) fail("Snapshot has matchers and yet has no arguments");
    return { start: call.close, end: call.close, replacement };
  }
  if (call.args.length === 1) {
    const first = call.args[0];
    if (hasMatchers) {
      if (call.trailingComma) {
        const comma = call.commas.at(-1);
        return { start: comma + 1, end: comma + 1, replacement: ` ${replacement}` };
      }
      return { start: call.close, end: call.close, replacement: `, ${replacement}` };
    }
    if (!inlineSnapshotExpressionIsLiteral(state.source, first)) fail("Argument must be a string literal");
    return { start: first.start, end: first.end, replacement };
  }
  if (!hasMatchers) fail("Snapshot does not have matchers and yet has two arguments");
  const second = call.args[1];
  if (!inlineSnapshotExpressionIsLiteral(state.source, second)) fail("Argument must be a string literal");
  return { start: second.start, end: second.end, replacement };
}

function queueInlineSnapshot(kind, value, hasMatchers, existingValue, context = undefined, caller = undefined) {
  caller ??= inlineSnapshotCaller(kind);
  const testFile = inlineSnapshotTestFile(context);
  if (caller.file !== testFile) {
    throw new Error(
      `Inline snapshot matchers must be called from the test file: expected ${testFile}, called from ${caller.file}`,
    );
  }
  const state = inlineSnapshotFileState(testFile);
  const scope = context?.token ?? globalThis.__cottontailCurrentTestToken?.() ?? "<module>";
  const call = resolveInlineSnapshotCall(state, caller, scope);
  const previous = state.edits.get(call.identifierStart);
  if (previous) {
    if (previous.value !== value) {
      state.invalid = true;
      throw new Error("Failed to update inline snapshot: Multiple inline snapshots on the same line must all have the same value");
    }
    return;
  }
  const edit = inlineSnapshotEdit(state, call, value, hasMatchers, existingValue);
  state.edits.set(call.identifierStart, {
    ...edit,
    call,
    value,
    isAdded: existingValue === undefined,
    additionReported: false,
  });
  state.dirty = true;
  globalThis.__cottontailBunTestUsed = true;
}

function matchOrQueueInlineSnapshot(kind, actual, expected, hasMatchers, context = undefined, caller = undefined) {
  const value = snapshotText(actual);
  const received = normalizeSnapshotText(value);
  const wanted = normalizeSnapshotText(expected);
  if (expected === undefined) {
    if (snapshotCreationDisabledInCI() && !snapshotUpdateRequested()) {
      throw new Error([
        "Inline snapshot creation is disabled in CI environments unless --update-snapshots is used",
        `Received: ${received}`,
      ].join("\n"));
    }
    queueInlineSnapshot(kind, value, hasMatchers, expected, context, caller);
    return { pass: true, received, wanted };
  }
  const pass = inlineSnapshotMatches(received, wanted);
  if (pass) snapshotReporter.passed += 1;
  if (!pass && snapshotUpdateRequested()) {
    snapshotReporter.passed += 1;
    queueInlineSnapshot(kind, value, hasMatchers, expected, context, caller);
    return { pass: true, received, wanted };
  }
  if (!pass) snapshotReporter.failed += 1;
  return { pass, received, wanted };
}

function reportSnapshotSummary() {
  if (snapshotReporter.reported || (snapshotReporter.added === 0 && snapshotReporter.failed === 0)) return;
  const parts = [];
  if (snapshotReporter.passed > 0) parts.push(`${snapshotReporter.passed} passed`);
  if (snapshotReporter.added > 0) parts.push(`+${snapshotReporter.added} added`);
  if (snapshotReporter.failed > 0) parts.push(`${snapshotReporter.failed} failed`);
  console.error(`snapshots: ${parts.join(", ")}`);
  snapshotReporter.reported = true;

  // The Node-backed reporter prints the compact snapshot total. Bun prints
  // expect() calls separately whenever the detailed snapshot line is used.
  globalThis.__cottontailTestSnapshotCount = 0;
}

function flushSnapshotFiles() {
  for (const state of snapshotFiles.values()) {
    if (!state.dirty) continue;
    const slash = state.path.lastIndexOf("/");
    cottontail.mkdirSync(state.path.slice(0, slash), true);
    cottontail.writeFile(state.path, renderSnapshotFile(state.values));
    state.dirty = false;
    state.exists = true;
    snapshotReporter.added += state.pendingAdded;
    state.pendingAdded = 0;
  }
  for (const state of inlineSnapshotFiles.values()) {
    if (!state.dirty || state.invalid) continue;
    const edits = Array.from(state.edits.values())
      .sort((left, right) => left.call.identifierStart - right.call.identifierStart);
    let output = "";
    let cursor = 0;
    for (const edit of edits) {
      if (edit.start < cursor) {
        state.invalid = true;
        throw new Error("Failed to update inline snapshot: Did not advance.");
      }
      output += state.source.slice(cursor, edit.start) + edit.replacement;
      cursor = edit.end;
    }
    output += state.source.slice(cursor);
    cottontail.writeFile(state.path, output);
    state.source = output;
    state.dirty = false;
    for (const edit of edits) {
      if (!edit.isAdded || edit.additionReported) continue;
      snapshotReporter.added += 1;
      edit.additionReported = true;
    }
  }
  reportSnapshotSummary();
}

globalThis.__cottontailHasPendingSnapshots = () =>
  Array.from(snapshotFiles.values()).some((state) => state.dirty) ||
  Array.from(inlineSnapshotFiles.values()).some((state) => state.dirty && !state.invalid);

function compareSnapshot(actual, expected = undefined, hint = undefined, context = undefined) {
  const text = snapshotText(actual);
  if (expected != null) {
    return text === normalizeSnapshotText(expected);
  }
  const identity = nextSnapshotIdentity(hint, context);
  const state = snapshotFileState(identity.file);
  const existing = state.values.get(identity.exportKey);
  if (existing === undefined) {
    if (snapshotCreationDisabledInCI() && !state.update) {
      throw new Error([
        "Snapshot creation is disabled in CI environments",
        `Snapshot name: ${JSON.stringify(identity.exportKey)}`,
        `Received: ${text}`,
      ].join("\n"));
    }
    state.values.set(identity.exportKey, text);
    state.dirty = true;
    state.pendingAdded += 1;
    snapshots.set(identity.key, text);
    return true;
  }
  if (existing !== text && state.update) {
    state.values.set(identity.exportKey, text);
    state.dirty = true;
    snapshotReporter.passed += 1;
    snapshots.set(identity.key, text);
    return true;
  }
  snapshots.set(identity.key, existing);
  if (existing === text) {
    snapshotReporter.passed += 1;
    return true;
  }
  snapshotReporter.failed += 1;
  return false;
}

function assertPropertyMatchers(actual, propertyMatchers) {
  const matchesProperties = (received, expected) => {
    if (expected?.__expectMatcher) return matchesExpected(received, expected);
    if (!isObject(expected) || Array.isArray(expected)) return matchesExpected(received, expected);
    if (!isObject(received)) return false;
    return Reflect.ownKeys(expected).every((key) =>
      Object.prototype.hasOwnProperty.call(received, key) && matchesProperties(received[key], expected[key])
    );
  };
  const pass = matchesProperties(actual, propertyMatchers ?? {});
  if (!pass) {
    throw new nodeAssert.AssertionError({ message: `Expected ${formatValue(actual)} to match snapshot property matchers` });
  }
  const replaceMatchers = (received, expected, seen = new WeakMap()) => {
    if (!isObject(expected) || !isObject(received)) return;
    let visited = seen.get(received);
    if (visited?.has(expected)) return;
    if (!visited) {
      visited = new WeakSet();
      seen.set(received, visited);
    }
    visited.add(expected);
    for (const key of Reflect.ownKeys(expected)) {
      if (!Object.prototype.propertyIsEnumerable.call(expected, key)) continue;
      if (matcherName(expected[key])) {
        try {
          received[key] = expected[key];
        } catch {
          Object.defineProperty(received, key, { configurable: true, enumerable: true, writable: true, value: expected[key] });
        }
      } else {
        replaceMatchers(received[key], expected[key], seen);
      }
    }
  };
  replaceMatchers(actual, propertyMatchers);
}

globalThis.__cottontailFlushSnapshots = flushSnapshotFiles;

function callRecords(value) {
  const calls = value?.mock?.calls;
  if (!Array.isArray(calls)) throw new nodeAssert.AssertionError({ message: "Expected a mock function" });
  return calls;
}

function resultRecords(value) {
  const results = value?.mock?.results;
  if (!Array.isArray(results)) throw new nodeAssert.AssertionError({ message: "Expected value must be a mock function" });
  return results;
}

function mockDisplayName(value) {
  return typeof value?.getMockName === "function" ? value.getMockName() : "mock function";
}

// Jest-style "- Expected / + Received" diff for spy call-argument matchers
// (issue #10380).
function formatArgListForDiff(args) {
  const normalized = Array.isArray(args) ? (args.length === 1 ? args[0] : Array.from(args)) : args;
  try {
    const text = JSON.stringify(normalized, (key, value) => {
      if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
      if (typeof value === "bigint") return `${value}n`;
      if (typeof value === "symbol") return String(value);
      return value;
    }, 2);
    return text === undefined ? String(normalized) : text;
  } catch {
    return String(normalized);
  }
}

function diffTextLines(expectedText, receivedText) {
  const a = expectedText.split("\n");
  const b = receivedText.split("\n");
  const m = a.length;
  const n = b.length;
  const table = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < m) out.push(`- ${a[i++]}`);
  while (j < n) out.push(`+ ${b[j++]}`);
  return out.join("\n");
}

function snapshotDiffValue(value) {
  let text = snapshotSerialize(value);
  if (text.startsWith("\n")) text = text.slice(1);
  if (text.endsWith("\n")) text = text.slice(0, -1);
  return text;
}

function testDiffColorsEnabled() {
  const env = globalThis.process?.env;
  if (env?.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  if (env?.NO_COLOR !== undefined || env?.NODE_DISABLE_COLORS !== undefined) return false;
  return Boolean(globalThis.process?.stderr?.isTTY);
}

function styleMatcherSignature(signature, colors) {
  if (!colors) return signature;
  const match = /^(expect\()received(\)(?:\.not)?\.)([^\s(]+)(\()expected(\))$/.exec(signature);
  if (!match) return signature;
  const reset = "\x1b[0m";
  const dim = "\x1b[2m";
  return `${dim}${match[1]}${reset}\x1b[31mreceived${reset}${dim}${match[2]}${reset}` +
    `${match[3]}${dim}${match[4]}${reset}\x1b[32mexpected${reset}${dim}${match[5]}${reset}`;
}

function parseExpectationStackFrame(line) {
  const text = String(line ?? "").trim();
  let match = /^(.*?)@(.+):(\d+):(\d+)$/.exec(text);
  if (!match) match = /^at\s+(?:(.*?)\s+\()?(.+):(\d+):(\d+)\)?$/.exec(text);
  if (!match) return null;
  let filePath = String(match[2]).replace(/^file:\/\//, "").replaceAll("\\", "/");
  try { filePath = decodeURIComponent(filePath); } catch {}
  return {
    functionName: match[1] || "<anonymous>",
    filePath,
    line: Number(match[3]),
    column: Number(match[4]),
  };
}

function expectationCallSite(error, matcherName) {
  let stack = String(error?.stack ?? "");
  try { stack = globalThis.__cottontailRemapStackString?.(stack) ?? stack; } catch {}
  let frame = null;
  for (const line of stack.split("\n")) {
    const candidate = parseExpectationStackFrame(line);
    if (!candidate) continue;
    const path = candidate.filePath;
    if (!path || path.includes("/.cottontail-embedded-runtime/") || path.includes("/.cottontail-tmp/") ||
        path.endsWith("/script.bundle.mjs") || path.endsWith("/runtime_modules/bun/test.js")) continue;
    frame = candidate;
    break;
  }
  if (!frame || !matcherName) return frame;

  try {
    const sourceLines = String(globalThis.cottontail.readFile(frame.filePath)).split(/\r?\n/);
    const token = `.${matcherName}`;
    let best = null;
    const start = Math.max(0, frame.line - 7);
    const end = Math.min(sourceLines.length, frame.line + 6);
    for (let index = start; index < end; index++) {
      const column = sourceLines[index].indexOf(token);
      if (column < 0) continue;
      const distance = Math.abs(index + 1 - frame.line);
      if (!best || distance < best.distance) best = { line: index + 1, column: column + 2, distance };
    }
    if (best) frame = { ...frame, line: best.line, column: best.column };
  } catch {}
  return frame;
}

function decorateExpectationError(error, message) {
  const plainMessage = String(message).replace(/\x1b\[[0-9;]*m/g, "");
  const matcherName = /expect\(received\)(?:\.not)?\.([^\s(]+)\(/.exec(plainMessage)?.[1];
  const callSite = expectationCallSite(error, matcherName);
  Object.defineProperties(error, {
    __cottontailBunExpectation: { value: true, configurable: true },
    __cottontailBunCallSite: { value: callSite, configurable: true },
  });
  return error;
}

function inspectExpectationError(error, colors) {
  const message = String(error?.message ?? error ?? "Test failed");
  const frame = error?.__cottontailBunCallSite;
  if (!frame) return colors ? `error\x1b[0m\x1b[2m:\x1b[0m \x1b[1m${message}` : `error: ${message}`;
  const functionName = frame.functionName && frame.functionName !== "@" ? frame.functionName : "<anonymous>";
  if (!colors) {
    const plainMessage = message.replace(/\x1b\[[0-9;]*m/g, "");
    const separator = plainMessage.endsWith("\n") ? "\n" : "\n\n";
    return `error: ${plainMessage}${separator}      at ${functionName} (${frame.filePath}:${frame.line}:${frame.column})\n`;
  }
  const reset = "\x1b[0m";
  const dim = "\x1b[2m";
  const stack = `${reset}      ${dim}at ${reset}${reset}${dim}${functionName}${reset}${dim} (` +
    `${reset}${reset}\x1b[36m${frame.filePath}${reset}${dim}:${reset}\x1b[33m${frame.line}${reset}` +
    `${dim}:\x1b[33m${frame.column}${reset}${dim})${reset}`;
  const separator = message.endsWith("\n") ? "" : "\n";
  return `error${reset}${dim}:${reset} \x1b[1m${message}${separator}${reset}\n${stack}\n`;
}

globalThis.__cottontailInspectBunExpectationError = inspectExpectationError;

function formatEqualityFailure(actual, expected, signature, negate, includeSignature) {
  const colors = testDiffColorsEnabled();
  const body = globalThis.cottontail.formatDiff(
    snapshotDiffValue(actual),
    snapshotDiffValue(expected),
    negate,
    colors,
  );
  return `${includeSignature ? `${styleMatcherSignature(signature, colors)}\n\n` : ""}${body}\n`;
}

function formatCallArgsFailure(matcherName, expectedArgs, receivedCall, callCount) {
  const expectedText = formatArgListForDiff(expectedArgs);
  const lines = [`expect(received).${matcherName}(expected)`, "", "- Expected", "+ Received", ""];
  if (receivedCall === undefined) {
    lines.push(expectedText.split("\n").map((line) => `- ${line}`).join("\n"));
  } else {
    lines.push(diffTextLines(expectedText, formatArgListForDiff(receivedCall)));
  }
  lines.push("", `Number of calls: ${callCount}`);
  return lines.join("\n");
}

function requireNoMatcherArguments(name, args) {
  if (args.length !== 0) throw new TypeError(`${name} does not accept arguments`);
}

function requireCallCount(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} requires a non-negative integer`);
  }
  return value;
}

function requireNthCall(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} requires a positive integer`);
  }
  return value;
}

function timerClock() {
  return fakeSystemTime ?? fakeNow;
}

function millisecondsToNanoseconds(value) {
  const number = Number(value);
  return BigInt(Math.trunc((Number.isFinite(number) ? number : 0) * 1e6));
}

function syncFakeDateClock() {
  fakeNow = Number(fakeDateNanoseconds / 1000000n);
  fakeSystemTime = fakeNow;
}

function setFakeNow(value) {
  let next = value instanceof realTimers.Date ? value.getTime() : Number(value);
  if (!Number.isFinite(next)) next = nativeDateNow();
  fakeDateNanoseconds = millisecondsToNanoseconds(next);
  syncFakeDateClock();
}

function fakeHrtime(previous = undefined) {
  let value = fakeHrtimeNanoseconds;
  if (Array.isArray(previous)) {
    value -= BigInt(previous[0] || 0) * 1000000000n + BigInt(previous[1] || 0);
  }
  return [Number(value / 1000000000n), Number(value % 1000000000n)];
}

fakeHrtime.bigint = () => fakeHrtimeNanoseconds;

function normalizeTimerCallback(callback) {
  if (typeof callback === "function") return callback;
  const source = String(callback);
  return () => (0, eval)(source);
}

function fakeTimerHandle(timer) {
  let referenced = true;
  return {
    refresh() {
      timer.deadline = fakeDateNanoseconds + timer.delayNanoseconds;
      fakeTimers.set(timer.id, timer);
      return this;
    },
    ref() { referenced = true; return this; },
    unref() { referenced = false; return this; },
    hasRef() { return referenced; },
    [Symbol.toPrimitive]() { return timer.id; },
  };
}

function fakeSetTimeout(callback, ms = 0, ...args) {
  const id = nextFakeTimerId++;
  const delay = Math.max(0, Number(ms) || 0);
  const timer = {
    id,
    callback: normalizeTimerCallback(callback),
    args,
    deadline: fakeDateNanoseconds + millisecondsToNanoseconds(delay),
    delay,
    delayNanoseconds: millisecondsToNanoseconds(delay),
    interval: null,
  };
  fakeTimers.set(id, timer);
  return fakeTimerHandle(timer);
}

function fakeSetInterval(callback, ms = 0, ...args) {
  const id = nextFakeTimerId++;
  const interval = Math.max(1, Number(ms) || 0);
  const timer = {
    id,
    callback: normalizeTimerCallback(callback),
    args,
    deadline: fakeDateNanoseconds + millisecondsToNanoseconds(interval),
    delay: interval,
    delayNanoseconds: millisecondsToNanoseconds(interval),
    interval,
  };
  fakeTimers.set(id, timer);
  return fakeTimerHandle(timer);
}

function fakeClearTimer(id) {
  fakeTimers.delete(Number(id));
}

function fakeSetImmediate(callback, ...args) {
  return fakeSetTimeout(callback, 0, ...args);
}

function dueTimers(until = Infinity) {
  return Array.from(fakeTimers.values())
    .filter((timer) => until === Infinity || timer.deadline <= until)
    .sort((left, right) => left.deadline < right.deadline ? -1 : left.deadline > right.deadline ? 1 : left.id - right.id);
}

function runFakeTimer(timer) {
  if (!fakeTimers.has(timer.id)) return;
  fakeTimers.delete(timer.id);
  if (timer.deadline > fakeDateNanoseconds) {
    fakeHrtimeNanoseconds += timer.deadline - fakeDateNanoseconds;
    fakeDateNanoseconds = timer.deadline;
    syncFakeDateClock();
  }
  timer.callback(...timer.args);
  if (timer.interval != null && fakeTimersEnabled) {
    timer.deadline = fakeDateNanoseconds + timer.delayNanoseconds;
    fakeTimers.set(timer.id, timer);
  }
  cottontail.drainJobs?.();
}

function runTimersUntil(target) {
  let iterations = 0;
  while (true) {
    const next = dueTimers(target)[0];
    if (!next) break;
    runFakeTimer(next);
    iterations += 1;
    if (iterations > 100000) {
      throw new Error("Aborting after running 100000 timers, assuming an infinite loop");
    }
  }
  if (target !== Infinity && target > fakeDateNanoseconds) {
    fakeHrtimeNanoseconds += target - fakeDateNanoseconds;
    fakeDateNanoseconds = target;
    syncFakeDateClock();
  }
}

function installFakeTimers(options = undefined) {
  const hasCustomNow = options != null && typeof options === "object" && Object.prototype.hasOwnProperty.call(options, "now");
  if (fakeTimersEnabled) {
    if (hasCustomNow) {
      setFakeNow(options.now);
      fakePerformanceOrigin = fakeNow;
    }
    return;
  }
  fakeTimersEnabled = true;
  setFakeNow(hasCustomNow ? options.now : nativeDateNow());
  fakeHrtimeNanoseconds = 0n;
  fakePerformanceOrigin = fakeNow;
  // testing-library and user-event detect fake timers via an own `clock`
  // property on globalThis.setTimeout (issue #25869 / #26284).
  Object.defineProperty(fakeSetTimeout, "clock", { configurable: true, enumerable: false, writable: true, value: true });
  globalThis.setTimeout = fakeSetTimeout;
  globalThis.clearTimeout = fakeClearTimer;
  globalThis.setInterval = fakeSetInterval;
  globalThis.clearInterval = fakeClearTimer;
  globalThis.setImmediate = fakeSetImmediate;
  globalThis.clearImmediate = fakeClearTimer;
  globalThis.requestAnimationFrame = (callback) => fakeSetTimeout(() => callback(timerClock()), 16);
  globalThis.cancelAnimationFrame = fakeClearTimer;
  if (globalThis.performance) globalThis.performance.now = () => timerClock() - fakePerformanceOrigin;
  if (globalThis.process && typeof realTimers.processHrtime === "function") globalThis.process.hrtime = fakeHrtime;
}

function uninstallFakeTimers() {
  if (!fakeTimersEnabled) return;
  fakeTimersEnabled = false;
  fakeTimers.clear();
  fakeSystemTime = null;
  // The `clock` marker must be deleted (not set to false) so that
  // hasOwnProperty checks report real timers (issue #26284).
  delete fakeSetTimeout.clock;
  globalThis.setTimeout = realTimers.setTimeout;
  globalThis.clearTimeout = realTimers.clearTimeout;
  globalThis.setInterval = realTimers.setInterval;
  globalThis.clearInterval = realTimers.clearInterval;
  globalThis.setImmediate = realTimers.setImmediate;
  globalThis.clearImmediate = realTimers.clearImmediate;
  if (realTimers.requestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = realTimers.requestAnimationFrame;
  if (realTimers.cancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
  else globalThis.cancelAnimationFrame = realTimers.cancelAnimationFrame;
  if (globalThis.performance && realTimers.performanceNow) globalThis.performance.now = realTimers.performanceNow;
  if (globalThis.process && typeof realTimers.processHrtime === "function") globalThis.process.hrtime = realTimers.processHrtime;
}

class Expectation {
  constructor(
    actual,
    negate = false,
    promiseMode = null,
    label = undefined,
    rejectedValue = false,
    testToken = globalThis.__cottontailCurrentTestToken?.(),
  ) {
    Object.defineProperties(this, {
      actual: { configurable: true, writable: true, value: actual },
      _negate: { configurable: true, writable: true, value: negate },
      _promiseMode: { configurable: true, writable: true, value: promiseMode },
      _label: { configurable: true, writable: true, value: label },
      _rejectedValue: { configurable: true, writable: true, value: rejectedValue },
      _testToken: { configurable: true, writable: true, value: testToken },
    });
  }

  get [Symbol.toStringTag]() { return "Expect"; }

  get not() {
    return new Expectation(this.actual, !this._negate, this._promiseMode, this._label, this._rejectedValue, this._testToken);
  }

  get resolves() {
    return new Expectation(this.actual, this._negate, "resolves", this._label, false, this._testToken);
  }

  get rejects() {
    return new Expectation(this.actual, this._negate, "rejects", this._label, false, this._testToken);
  }

  _check(pass, message) {
    if (this._skipAssertionCount) this._skipAssertionCount = false;
    else countAssertion();
    const ok = this._negate ? !pass : pass;
    if (ok) return;
    if (typeof message === "function") message = message();
    const label = this._label == null ? "" : `${String(this._label)}\n\n`;
    const rendered = `${label}${message}`;
    throw decorateExpectationError(new nodeAssert.AssertionError({ message: rendered }), rendered);
  }

  _wrap(check) {
    if (this._promiseMode) {
      const mode = this._promiseMode;
      const promise = promiseFromActual(this.actual, mode);
      const runCheck = (actual) => check.call(
        new Expectation(actual, this._negate, null, this._label, mode === "rejects", this._testToken),
        actual,
      );
      const result = Promise.resolve(promise).then(
        (value) => {
          if (mode === "rejects") throw promiseModeError(mode, value);
          return runCheck(value);
        },
        (error) => {
          if (mode === "resolves") throw promiseModeError(mode, error);
          return runCheck(error);
        },
      );

      // Attach the mode handlers before draining. Waiting on the original
      // promise first lets JSC report a rejection as unhandled even though an
      // expect(...).rejects matcher consumes it in the same test turn.
      if (promise instanceof Promise && typeof globalThis.cottontail?.waitForPromise === "function") {
        result.catch(() => {});
        globalThis.cottontail.waitForPromise(result);
        const state = nativePromiseState(result);
        if (state?.status === 2) {
          throw state.value;
        }
        if (state?.status === 1) return undefined;
      }

      globalThis.__cottontailRegisterTestPendingPromise?.(result);
      return undefined;
    }
    return check.call(this, this.actual);
  }

  toBe(expected) {
    return this._wrap((actual) => {
      const pass = Object.is(actual, expected);
      this._check(pass, () => {
        const signature = `expect(received)${this._negate ? ".not" : ""}.toBe(expected)`;
        const body = this._negate
          ? `Expected: not ${formatValue(expected)}`
          : `Expected: ${formatValue(expected)}\nReceived: ${formatValue(actual)}`;
        return this._label == null ? `${signature}\n\n${body}` : body;
      });
    });
  }

  toEqual(expected) {
    return this._wrap((actual) => {
      const pass = matchesExpected(actual, expected);
      const finish = (matched) => this._check(Boolean(matched), () => {
        const signature = `expect(received)${this._negate ? ".not" : ""}.toEqual(expected)`;
        return formatEqualityFailure(actual, expected, signature, this._negate, this._label == null);
      });
      return isPromiseLike(pass) ? Promise.resolve(pass).then(finish) : finish(pass);
    });
  }

  toStrictEqual(expected) {
    return this._wrap((actual) => {
      const pass = matchesExpected(actual, expected, undefined, true);
      const finish = (matched) => this._check(Boolean(matched), () => {
        const signature = `expect(received)${this._negate ? ".not" : ""}.toStrictEqual(expected)`;
        return formatEqualityFailure(actual, expected, signature, this._negate, this._label == null);
      });
      return isPromiseLike(pass) ? Promise.resolve(pass).then(finish) : finish(pass);
    });
  }

  toMatchObject(expected) {
    return this._wrap((actual) => {
      if (!isObject(actual) || !isObject(expected)) {
        throw new TypeError("toMatchObject() requires object values");
      }
      // Bun treats a top-level asymmetric matcher as an empty partial object.
      const pass = matcherName(expected) ? true : matchesObjectSubset(actual, expected);
      return mapMatchResult(pass, (matched) =>
        this._check(Boolean(matched), `Expected ${formatValue(actual)} to match object ${formatValue(expected)}`));
    });
  }

  toBeDefined() { return this._wrap((actual) => this._check(actual !== undefined, "Expected value to be defined")); }
  toBeUndefined() { return this._wrap((actual) => this._check(actual === undefined, "Expected value to be undefined")); }
  toBeNull() { return this._wrap((actual) => this._check(actual === null, "Expected value to be null")); }
  toBeNil() { return this._wrap((actual) => this._check(actual == null, "Expected value to be null or undefined")); }
  toBeTruthy() { return this._wrap((actual) => this._check(Boolean(actual), "Expected value to be truthy")); }
  toBeFalsy() { return this._wrap((actual) => this._check(!actual, "Expected value to be falsy")); }
  toBeTrue() { return this._wrap((actual) => this._check(actual === true, "Expected value to be true")); }
  toBeFalse() { return this._wrap((actual) => this._check(actual === false, "Expected value to be false")); }
  toBeNaN() { return this._wrap((actual) => this._check(Number.isNaN(actual), "Expected value to be NaN")); }
  toBeFinite() { return this._wrap((actual) => this._check(Number.isFinite(actual), "Expected value to be finite")); }
  toBeTypeOf(type) {
    const validTypes = ["function", "object", "bigint", "boolean", "number", "string", "symbol", "undefined"];
    if (typeof type !== "string") throw new TypeError("toBeTypeOf() requires a string argument");
    if (!validTypes.includes(type)) {
      throw new TypeError("toBeTypeOf() requires a valid type string argument ('function', 'object', 'bigint', 'boolean', 'number', 'string', 'symbol', 'undefined')");
    }
    return this._wrap((actual) => this._check(typeof actual === type, `Expected type ${type}`));
  }
  toBeInstanceOf(type) { return this._wrap((actual) => this._check(actual instanceof type, `Expected instance of ${type?.name ?? type}`)); }
  toBeArray() { return this._wrap((actual) => this._check(Array.isArray(actual), "Expected value to be an array")); }
  toBeArrayOfSize(size) {
    if (typeof size !== "number" || !Number.isInteger(size) || Object.is(size, -0)) {
      throw new Error("toBeArrayOfSize() requires the first argument to be a number");
    }
    return this._wrap((actual) => this._check(Array.isArray(actual) && actual.length === size, `Expected array size ${size}`));
  }
  toBeObject() { return this._wrap((actual) => this._check(isObjectLike(actual), "Expected value to be an object")); }
  toBeFunction() { return this._wrap((actual) => this._check(typeof actual === "function", "Expected value to be a function")); }
  toBeString() { return this._wrap((actual) => this._check(typeof actual === "string" || actual instanceof String, "Expected value to be a string")); }
  toBeNumber() { return this._wrap((actual) => this._check(typeof actual === "number", "Expected value to be a number")); }
  toBeBoolean() { return this._wrap((actual) => this._check(typeof actual === "boolean", "Expected value to be a boolean")); }
  toBeSymbol() { return this._wrap((actual) => this._check(typeof actual === "symbol", "Expected value to be a symbol")); }
  toBeDate() { return this._wrap((actual) => this._check(actual instanceof Date, "Expected value to be a Date")); }
  toBeValidDate() { return this._wrap((actual) => this._check(actual instanceof Date && !Number.isNaN(actual.getTime()), "Expected valid Date")); }
  toBeInteger() { return this._wrap((actual) => this._check(Number.isInteger(actual), "Expected integer")); }
  toBeEven() {
    return this._wrap((actual) => {
      const pass = typeof actual === "bigint"
        ? actual % 2n === 0n
        : typeof actual === "number" && Number.isInteger(actual) && actual % 2 === 0;
      this._check(pass, "Expected even number");
    });
  }
  toBeOdd() {
    return this._wrap((actual) => {
      const pass = typeof actual === "bigint"
        ? actual % 2n !== 0n
        : typeof actual === "number" && Number.isInteger(actual) && Math.abs(actual % 2) === 1;
      this._check(pass, "Expected odd number");
    });
  }
  toBePositive() {
    return this._wrap((actual) => this._check(
      typeof actual === "number" && Number.isFinite(actual) && Math.round(actual) > 0,
      "Expected positive number",
    ));
  }
  toBeNegative() {
    return this._wrap((actual) => this._check(
      typeof actual === "number" && Number.isFinite(actual) && actual < 0 && Math.round(-actual) > 0,
      "Expected negative number",
    ));
  }
  toBeGreaterThan(expected) { return this._wrap((actual) => this._check(actual > expected, `Expected > ${expected}`)); }
  toBeGreaterThanOrEqual(expected) { return this._wrap((actual) => this._check(actual >= expected, `Expected >= ${expected}`)); }
  toBeLessThan(expected) { return this._wrap((actual) => this._check(actual < expected, `Expected < ${expected}`)); }
  toBeLessThanOrEqual(expected) { return this._wrap((actual) => this._check(actual <= expected, `Expected <= ${expected}`)); }
  toBeCloseTo(expected, precision = 2) {
    if (typeof expected !== "number") throw new TypeError("Expected expected to be a number for 'toBeCloseTo'.");
    if (typeof precision !== "number") throw new TypeError("Expected precision to be a number for 'toBeCloseTo'.");
    return this._wrap((actual) => {
      if (typeof actual !== "number") throw new TypeError("Expected received to be a number for 'expect'.");
      const bothInfinite = !Number.isNaN(actual) && !Number.isFinite(actual) &&
        !Number.isNaN(expected) && !Number.isFinite(expected);
      const pass = bothInfinite || Math.abs(actual - expected) < 10 ** -precision / 2;
      this._check(pass, `Expected close to ${expected}`);
    });
  }
  toBeWithin(min, max) {
    if (arguments.length < 2) throw new TypeError("toBeWithin() requires 2 arguments");
    if (typeof min !== "number") throw new TypeError("toBeWithin() requires the first argument to be a number");
    if (typeof max !== "number") throw new TypeError("toBeWithin() requires the second argument to be a number");
    return this._wrap((actual) => this._check(
      typeof actual === "number" && actual >= min && actual < max,
      `Expected within ${min}..${max}`,
    ));
  }
  toBeOneOf(values) { return this._wrap((actual) => this._check(Array.from(values ?? []).some((value) => Object.is(value, actual)), "Expected one of values")); }

  toContain(expected) {
    return this._wrap((actual) => {
      if (typeof actual === "string") {
        if (typeof expected !== "string") {
          throw new Error("Received value must be an array type, or both received and expected values must be strings.");
        }
        this._check(actual.includes(expected), `Expected ${formatValue(actual)} to contain ${formatValue(expected)}`);
        return;
      }
      if (actual == null || typeof actual[Symbol.iterator] !== "function") {
        throw new Error("Received value must be an array type, or both received and expected values must be strings.");
      }
      const pass = Array.from(actual).some((value) => Object.is(value, expected));
      this._check(pass, `Expected ${formatValue(actual)} to contain ${formatValue(expected)}`);
    });
  }

  toContainEqual(expected) {
    return this._wrap((actual) => {
      const pass = actual != null && typeof actual[Symbol.iterator] === "function" &&
        Array.from(actual).some((value) => matchesExpected(value, expected));
      this._check(pass, `Expected ${formatValue(actual)} to contain equal ${formatValue(expected)}`);
    });
  }
  toInclude(expected) { return this.toContain(expected); }
  toIncludeRepeated(expected, count = 1) {
    if (arguments.length < 2) throw new TypeError("toIncludeRepeated() requires 2 arguments");
    if (typeof expected !== "string") throw new TypeError("toIncludeRepeated() requires the first argument to be a string");
    if (!Number.isInteger(count) || count < 0 || count > 0xffffffff || Object.is(count, -0)) {
      throw new TypeError("toIncludeRepeated() requires the second argument to be a number");
    }
    if (expected.length === 0) throw new TypeError("toIncludeRepeated() requires the first argument to be a non-empty string");
    return this._wrap((actual) => {
      if (typeof actual !== "string") throw new TypeError("toIncludeRepeated() requires the expect(value) to be a string");
      const occurrences = actual.split(expected).length - 1;
      this._check(occurrences === count, `Expected ${expected} to occur ${count} times`);
    });
  }
  toStartWith(expected) { return this._wrap((actual) => this._check(String(actual).startsWith(String(expected)), `Expected to start with ${expected}`)); }
  toEndWith(expected) { return this._wrap((actual) => this._check(String(actual).endsWith(String(expected)), `Expected to end with ${expected}`)); }
  toMatch(expected) { return this._wrap((actual) => this._check(expected instanceof RegExp ? expected.test(String(actual)) : String(actual).includes(String(expected)), `Expected to match ${expected}`)); }
  toEqualIgnoringWhitespace(expected) {
    if (arguments.length < 1) throw new TypeError("toEqualIgnoringWhitespace() requires 1 argument");
    if (typeof expected !== "string") throw new TypeError("toEqualIgnoringWhitespace() requires argument to be a string");
    return this._wrap((actual) => {
      if (typeof actual !== "string") throw new TypeError("toEqualIgnoringWhitespace() requires argument to be a string");
      this._check(actual.replace(/\s+/g, "") === expected.replace(/\s+/g, ""), "Expected equal ignoring whitespace");
    });
  }
  toHaveLength(length) {
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
      throw new Error(`Expected value must be a non-negative integer: ${formatValue(length)}`);
    }
    return this._wrap((actual) => {
      let actualLength = actual?.length;
      if (actualLength == null && (binaryBufferKind(actual) !== null || ArrayBuffer.isView(actual))) actualLength = actual.byteLength;
      if (actualLength == null && typeof Headers === "function" && actual instanceof Headers) actualLength = Array.from(actual.keys()).length;
      if (actualLength == null && typeof FormData === "function" && actual instanceof FormData) actualLength = Array.from(actual.keys()).length;
      if (actualLength == null && typeof URLSearchParams === "function" && actual instanceof URLSearchParams) actualLength = Array.from(actual.keys()).length;
      if (actualLength == null &&
          ((typeof WeakMap === "function" && actual instanceof WeakMap) ||
           (typeof WeakSet === "function" && actual instanceof WeakSet)) &&
          typeof globalThis.cottontail?.weakCollectionSize === "function") {
        actualLength = globalThis.cottontail.weakCollectionSize(actual);
      }
      if (actualLength == null && typeof actual?.size === "number") {
        if (typeof actual.exists === "function" && typeof actual.name === "string" && actual.name && !nodeExistsSync(actual.name)) {
          throw new Error("Received file does not exist");
        }
        actualLength = actual.size;
      }
      this._check(actualLength === Number(length), `Expected length ${length}`);
    });
  }
  toBeEmpty() { return this._wrap((actual) => this._check(isEmptyValue(actual), "Expected value to be empty")); }
  toBeEmptyObject() { return this._wrap((actual) => this._check(isEmptyObjectValue(actual), "Expected value to be an empty object")); }

  toHaveProperty(path, expected = undefined) {
    return this._wrap((actual) => {
      const [exists, value] = hasProperty(actual, path);
      this._check(exists && (arguments.length < 2 || matchesExpected(value, expected)), `Expected property ${String(path)}`);
    });
  }

  // Bun checks own properties (hasOwnProperty), which on proxies triggers the
  // getOwnPropertyDescriptor trap -- trap errors must propagate (issue #11677).
  toContainKey(key) {
    return this._wrap((actual) => {
      if (!isObjectLike(actual)) throw new TypeError(`Expected value must be an object\nReceived: ${formatValue(actual)}`);
      this._check(Object.hasOwn(actual, key), `Expected key ${String(key)}`);
    });
  }
  toContainKeys(keys) {
    return this._wrap((actual) => {
      const expectedKeys = Array.from(keys ?? []);
      const pass = !isObjectLike(actual) ? expectedKeys.length === 0 : expectedKeys.every((key) => Object.hasOwn(actual, key));
      this._check(pass, `Expected keys\nReceived: ${formatValue(actual)}`);
    });
  }
  toContainAnyKeys(keys) {
    return this._wrap((actual) => this._check(
      isObjectLike(actual) && Array.from(keys ?? []).some((key) => Object.hasOwn(actual, key)),
      "Expected any key",
    ));
  }
  toContainAllKeys(keys) {
    return this._wrap((actual) => {
      const expectedKeys = Array.from(keys ?? []);
      const actualKeys = isObjectLike(actual) ? Object.keys(actual) : [];
      const pass = actualKeys.length === expectedKeys.length &&
        actualKeys.every((key) => expectedKeys.some((expected) => matchesExpected(key, expected)));
      this._check(pass, "Expected all keys");
    });
  }
  toContainValue(value) { return this._wrap((actual) => this._check(Object.values(Object(actual)).some((candidate) => matchesExpected(candidate, value)), "Expected object value")); }
  toContainValues(values) { return this._wrap((actual) => this._check(Array.from(values ?? []).every((value) => Object.values(Object(actual)).some((candidate) => matchesExpected(candidate, value))), "Expected object values")); }
  toContainAnyValues(values) { return this._wrap((actual) => this._check(Array.from(values ?? []).some((value) => Object.values(Object(actual)).some((candidate) => matchesExpected(candidate, value))), "Expected any object value")); }
  toContainAllValues(values) {
    return this._wrap((actual) => {
      const expectedValues = Array.from(values ?? []);
      const actualValues = actual == null ? [] : Object.values(Object(actual));
      const pass = actualValues.length === expectedValues.length && expectedValues.every((value) =>
        actualValues.some((candidate) => matchesExpected(candidate, value)));
      this._check(pass, "Expected all object values");
    });
  }

  toThrow(expected = undefined) {
    const rejectedValue = this._promiseMode === "rejects" || this._rejectedValue;
    return this._wrap((actual) => {
      const checkThrown = (didThrow, thrown) => {
        if (didThrow && isPromiseLike(thrown) && typeof thrown.catch === "function") {
          thrown.catch(() => {});
        }
        const objectMatches = (expectedObject) => Object.entries(expectedObject).every(([key, value]) => {
          const actualValue = thrown?.[key];
          return value instanceof RegExp ? value.test(String(actualValue)) : matchesExpected(actualValue, value);
        });
        const pass = didThrow && (expected === undefined ||
          (expected instanceof RegExp ? expected.test(String(thrown.message ?? thrown)) :
            typeof expected === "function" ? thrown instanceof expected :
              matcherName(expected) ? matchesExpected(thrown, expected) :
              expected && typeof expected === "object" ? objectMatches(expected) :
              String(thrown.message ?? thrown).includes(String(expected))));
        const receivedMessage = didThrow ? String(thrown?.message ?? thrown) : undefined;
        const expectedDescription = expected instanceof RegExp ? String(expected) : formatValue(expected);
        const message = !didThrow
          ? "Expected function to throw"
          : [
              expected === undefined ? null : `Expected pattern: ${expectedDescription}`,
              `Received message: ${JSON.stringify(receivedMessage)}`,
            ].filter(Boolean).join("\n");
        this._check(pass, message);
      };
      if (typeof actual !== "function") return checkThrown(rejectedValue || actual instanceof Error, actual);
      // Call `actual` inside its own try/catch so assertion failures raised by
      // `_check` below are never mistaken for the function under test throwing.
      let didThrow = false;
      let thrown;
      let result;
      try {
        result = actual();
      } catch (error) {
        didThrow = true;
        thrown = error;
      }
      if (didThrow) return checkThrown(true, thrown);
      if (isPromiseLike(result)) {
        const settled = result.then(
          () => this._check(false, "Expected function to throw"),
          (error) => checkThrown(true, error),
        );
        // Bun keeps the running test alive until this promise settles
        // (issue #23865) and counts the expect() call immediately — the
        // test may time out before the promise resolves.
        if (!this._promiseMode && globalThis.__cottontailRegisterTestPendingPromise?.(settled)) {
          countAssertion();
          this._skipAssertionCount = true;
        }
        return settled;
      }
      return this._check(false, "Expected function to throw");
    });
  }

  toThrowWithCode(cls, code) {
    return this._wrap((actual) => {
      let didThrow = false;
      let thrown;
      try {
        actual();
      } catch (error) {
        didThrow = true;
        thrown = error;
      }

      let pass = false;
      let message;
      if (!didThrow) {
        message = () => "Received function did not throw";
      } else if (!(thrown instanceof cls)) {
        message = () => `Expected error to be instanceof ${cls.name}; got ${thrown.__proto__.constructor.name}`;
      } else if (!("code" in thrown)) {
        message = () => `Expected error to have property 'code'; got ${thrown}`;
      } else if (thrown.code !== code) {
        message = () => `Expected error to have code '${code}'; got ${thrown.code}`;
      } else {
        pass = true;
      }

      this._check(pass, message ?? (() => "No message was specified for this matcher."));
      return this;
    });
  }

  toThrowError(expected = undefined) { return this.toThrow(expected); }
  toThrowErrorMatchingSnapshot(hint = undefined) {
    countSnapshotAssertion();
    this._skipAssertionCount = true;
    if (arguments.length > 0 && typeof hint !== "string") {
      throw new TypeError("Expected snapshot hint to be a string");
    }
    const currentTest = globalThis.__cottontailCurrentTestToken?.();
    if (!currentTest || currentTest !== this._testToken) {
      throw new Error("Snapshot matchers cannot be used outside of a test");
    }
    const snapshotContext = captureSnapshotContext(currentTest);
    return this._wrap((actual) => {
      const checkThrown = (didThrow, thrown) => {
        if (!didThrow) return this._check(false, "Matcher error: Received function did not throw");
        const value = thrown instanceof Error ? thrown.message : undefined;
        return this._check(
          compareSnapshot(value, undefined, hint, snapshotContext),
          "Expected thrown error to match snapshot",
        );
      };
      if (typeof actual !== "function") return checkThrown(this._rejectedValue || actual instanceof Error, actual);
      let result;
      try {
        result = actual();
      } catch (error) {
        return checkThrown(true, error);
      }
      if (isPromiseLike(result)) {
        const settled = result.then(
          () => checkThrown(false, undefined),
          (error) => checkThrown(true, error),
        );
        if (!this._promiseMode && globalThis.__cottontailRegisterTestPendingPromise?.(settled)) {
          this._skipAssertionCount = true;
        }
        return settled;
      }
      return checkThrown(false, undefined);
    });
  }
  toThrowErrorMatchingInlineSnapshot(inlineSnapshot = undefined) {
    countSnapshotAssertion();
    this._skipAssertionCount = true;
    if (arguments.length > 0 && typeof inlineSnapshot !== "string") {
      throw new TypeError("Expected inline snapshot to be a string");
    }
    const currentTest = globalThis.__cottontailCurrentTestToken?.();
    if ((currentTest && currentTest !== this._testToken) || (!currentTest && !globalThis.__cottontailRegisteringTestFile)) {
      throw new Error("Snapshot matchers cannot be used outside of a test");
    }
    const snapshotContext = captureSnapshotContext(currentTest);
    const snapshotCaller = inlineSnapshotCaller("toThrowErrorMatchingInlineSnapshot");
    nextSnapshotIdentity(undefined, snapshotContext);
    return this._wrap((actual) => {
      const checkThrown = (didThrow, thrown) => {
        if (!didThrow) {
          return this._check(false,
            "\u001b[2mexpect(\u001b[0m\u001b[31mreceived\u001b[0m\u001b[2m).\u001b[0m" +
            "toThrowErrorMatchingInlineSnapshot\u001b[2m(\u001b[0m\u001b[2m)\u001b[0m\n\n" +
            "\u001b[1mMatcher error\u001b[0m: Received function did not throw\n");
        }
        const value = thrown instanceof Error ? thrown.message : undefined;
        const result = matchOrQueueInlineSnapshot(
          "toThrowErrorMatchingInlineSnapshot",
          value,
          inlineSnapshot,
          false,
          snapshotContext,
          snapshotCaller,
        );
        return this._check(
          result.pass,
          `Expected thrown error to match inline snapshot\nExpected: ${JSON.stringify(result.wanted)}\nReceived: ${JSON.stringify(result.received)}`,
        );
      };
      if (typeof actual !== "function") return checkThrown(this._rejectedValue || actual instanceof Error, actual);
      let result;
      try {
        result = actual();
      } catch (error) {
        return checkThrown(true, error);
      }
      if (isPromiseLike(result)) {
        const settled = result.then(
          () => checkThrown(false, undefined),
          (error) => checkThrown(true, error),
        );
        if (!this._promiseMode && globalThis.__cottontailRegisterTestPendingPromise?.(settled)) {
          this._skipAssertionCount = true;
        }
        return settled;
      }
      return checkThrown(false, undefined);
    });
  }
  toMatchSnapshot(propertyMatchers = undefined, hint = undefined) {
    countSnapshotAssertion();
    this._skipAssertionCount = true;
    const currentTest = globalThis.__cottontailCurrentTestToken?.();
    if (!currentTest || currentTest !== this._testToken) {
      throw new Error("Snapshot matchers cannot be used outside of a test");
    }
    if (globalThis.__cottontailCurrentTestIsConcurrent?.() &&
        !globalThis.__cottontailCurrentTestHasOwnConcurrency?.()) {
      throw new Error("Snapshot matchers are not supported in concurrent tests");
    }
    const snapshotContext = captureSnapshotContext(currentTest);
    // Bun validates argument order: with two arguments the first must be a
    // property-matcher object and the second a string hint.
    if (arguments.length >= 2) {
      if (typeof hint !== "string") throw new Error("Expected second argument to be a string");
      if (!isObject(propertyMatchers)) throw new Error("Expected properties must be an object");
    } else if (arguments.length === 1 && typeof propertyMatchers !== "string" && !isObject(propertyMatchers)) {
      throw new Error("Expected first argument to be a string or object");
    }
    return this._wrap((actual) => {
      let snapshotHint = hint;
      if (typeof propertyMatchers === "string") {
        snapshotHint = propertyMatchers;
      } else if (propertyMatchers && typeof propertyMatchers === "object") {
        assertPropertyMatchers(actual, propertyMatchers);
      }
      this._check(
        compareSnapshot(actual, undefined, snapshotHint, snapshotContext),
        "Expected value to match snapshot",
      );
    });
  }
  toMatchInlineSnapshot(propertyMatchers = undefined, inlineSnapshot = undefined) {
    countSnapshotAssertion();
    this._skipAssertionCount = true;
    const currentTest = globalThis.__cottontailCurrentTestToken?.();
    if ((currentTest && currentTest !== this._testToken) ||
        (!currentTest && !globalThis.__cottontailRegisteringTestFile && !globalThis.__cottontailLoadingTestModules)) {
      throw new Error("Snapshot matchers cannot be used outside of a test");
    }
    const snapshotContext = captureSnapshotContext(currentTest);
    const snapshotCaller = inlineSnapshotCaller("toMatchInlineSnapshot");
    if (arguments.length >= 2 && !isObject(propertyMatchers)) {
      throw new Error("Matcher error: Expected properties must be an object");
    }
    if (arguments.length === 1 && typeof propertyMatchers !== "string" && !isObject(propertyMatchers)) {
      throw new Error("Matcher error: Expected first argument to be a string or object");
    }
    nextSnapshotIdentity(undefined, snapshotContext);
    return this._wrap((actual) => {
      let expected = inlineSnapshot;
      let hasMatchers = false;
      if (typeof propertyMatchers === "string" && inlineSnapshot === undefined) {
        expected = propertyMatchers;
      } else if (propertyMatchers && typeof propertyMatchers === "object") {
        hasMatchers = true;
        assertPropertyMatchers(actual, propertyMatchers);
      }
      const result = matchOrQueueInlineSnapshot(
        "toMatchInlineSnapshot",
        actual,
        expected,
        hasMatchers,
        snapshotContext,
        snapshotCaller,
      );
      this._check(
        result.pass,
        `Expected value to match inline snapshot\nExpected: ${JSON.stringify(result.wanted)}\nReceived: ${JSON.stringify(result.received)}`,
      );
    });
  }
  pass(message = "passes by .pass() assertion") {
    if (arguments.length > 0 && typeof message !== "string") throw new TypeError("Expected message to be a string for 'pass'.");
    return this._check(true, message);
  }
  fail(message = "fails by .fail() assertion") {
    if (arguments.length > 0 && typeof message !== "string") throw new TypeError("Expected message to be a string for 'fail'.");
    return this._check(false, message);
  }
  toSatisfy(predicate) {
    if (typeof predicate !== "function") throw new TypeError("toSatisfy() argument must be a function");
    return this._wrap((actual) => {
      let result;
      try {
        result = predicate(actual);
      } catch (error) {
        throw new AggregateError([error], "toSatisfy() predicate threw an exception");
      }
      this._check(result === true, "Expected predicate to pass");
    });
  }

  // Bun's upstream test/harness.ts registers toRun via expect.extend from a
  // bunfig preload; Cottontail provides it natively: spawn our own binary
  // with the given args and require a clean exit (and optional stdout).
  toRun(optionalStdout = undefined, expectedCode = 0) {
    return this._wrap((actual) => {
      const args = Array.isArray(actual) ? actual.map(String) : [String(actual)];
      const executable = globalThis.process?.execPath ?? cottontail.execPath?.();
      const result = cottontail.spawnSync(executable, args, {
        stdio: "pipe",
        env: { ...(globalThis.process?.env ?? {}), BUN_DEBUG_QUIET_LOGS: "1" },
      });
      const exitCode = Number(result.status ?? 1);
      this._check(
        exitCode === expectedCode,
        `Command ${[executable, ...args].join(" ")} exited ${exitCode} (expected ${expectedCode})\n${String(result.stderr ?? "")}\n${String(result.stdout ?? "")}`,
      );
      if (optionalStdout != null) {
        this._check(
          String(result.stdout ?? "") === String(optionalStdout),
          `Expected stdout ${JSON.stringify(String(optionalStdout))} but received ${JSON.stringify(String(result.stdout ?? ""))}`,
        );
      }
    });
  }

  toHaveBeenCalled(...args) {
    requireNoMatcherArguments("toHaveBeenCalled", args);
    return this._wrap((actual) => this._check(callRecords(actual).length > 0, `Expected ${mockDisplayName(actual)} to be called`));
  }
  toBeCalled() { return this.toHaveBeenCalled(); }
  toHaveBeenCalledOnce() { return this.toHaveBeenCalledTimes(1); }
  toHaveBeenCalledTimes(count) {
    const expected = requireCallCount(count, "toHaveBeenCalledTimes");
    return this._wrap((actual) => this._check(callRecords(actual).length === expected, `Expected ${mockDisplayName(actual)} to have ${expected} calls`));
  }
  toBeCalledTimes(count) { return this.toHaveBeenCalledTimes(count); }
  toHaveBeenCalledWith(...args) {
    return this._wrap((actual) => {
      const calls = callRecords(actual);
      this._check(
        calls.some((call) => call.length === args.length && matchesExpected(call, args)),
        () => formatCallArgsFailure("toHaveBeenCalledWith", args, calls.at(-1), calls.length),
      );
    });
  }
  toBeCalledWith(...args) { return this.toHaveBeenCalledWith(...args); }
  toHaveBeenLastCalledWith(...args) { return this.lastCalledWith(...args); }
  lastCalledWith(...args) {
    return this._wrap((actual) => {
      const calls = callRecords(actual);
      this._check(
        calls.at(-1)?.length === args.length && matchesExpected(calls.at(-1), args),
        () => formatCallArgsFailure("toHaveBeenLastCalledWith", args, calls.at(-1), calls.length),
      );
    });
  }
  toHaveBeenNthCalledWith(index, ...args) { return this.nthCalledWith(index, ...args); }
  nthCalledWith(index, ...args) {
    const nth = requireNthCall(index, "toHaveBeenNthCalledWith");
    return this._wrap((actual) => {
      const calls = callRecords(actual);
      this._check(
        calls[nth - 1]?.length === args.length && matchesExpected(calls[nth - 1], args),
        () => formatCallArgsFailure("toHaveBeenNthCalledWith", args, calls[nth - 1], calls.length),
      );
    });
  }

  toHaveReturned(...args) {
    requireNoMatcherArguments("toHaveReturned", args);
    return this._wrap((actual) => {
      const results = resultRecords(actual);
      const returned = results.filter((result) => result.type === "return").length;
      this._check(returned > 0, [
        "expect(received).toHaveReturned(expected)",
        "",
        "Expected number of succesful returns: >= 1",
        `Received number of succesful returns:    ${returned}`,
        `Received number of calls:                ${results.length}`,
      ].join("\n") + "\n");
    });
  }
  toReturn() { return this.toHaveReturned(); }
  toHaveReturnedTimes(count) {
    const expected = requireCallCount(count, "toHaveReturnedTimes");
    return this._wrap((actual) => this._check(resultRecords(actual).filter((result) => result.type === "return").length === expected, `Expected ${expected} returns`));
  }
  toHaveReturnedWith(value) { return this._wrap((actual) => this._check(resultRecords(actual).some((result) => result.type === "return" && matchesExpected(result.value, value)), "Expected return value")); }
  lastReturnedWith(value) {
    return this._wrap((actual) => {
      const result = resultRecords(actual).at(-1);
      this._check(result?.type === "return" && matchesExpected(result.value, value), "Expected last return value");
    });
  }
  toHaveLastReturnedWith(value) { return this.lastReturnedWith(value); }
  nthReturnedWith(index, value) {
    const nth = requireNthCall(index, "toHaveNthReturnedWith");
    return this._wrap((actual) => {
      const result = resultRecords(actual)[nth - 1];
      this._check(result?.type === "return" && matchesExpected(result.value, value), "Expected nth return value");
    });
  }
  toHaveNthReturnedWith(index, value) { return this.nthReturnedWith(index, value); }
}

// Initialize the property layout and hot identity matcher before tests take
// heap snapshots. Bun's native matcher structures are initialized up front.
new Expectation(undefined).toBe(undefined);
fallbackAssertionState.count = 0;
globalThis.__cottontailTestAssertionCount = 0;
globalThis.__cottontailTestSnapshotCount = 0;

export function expect(actual, label = undefined) {
  globalThis.__cottontailBunTestUsed = true;
  return new Expectation(actual, false, null, label);
}

function installCustomMatchers(matchers = {}) {
  const entries = [];
  const seen = new Set();
  for (let object = matchers; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
    for (const name of Reflect.ownKeys(object)) {
      if (typeof name !== "string" || name === "constructor" || seen.has(name)) continue;
      seen.add(name);
      entries.push([name, matchers[name]]);
    }
  }
  for (const [name, matcher] of entries) {
    if (typeof matcher !== "function") {
      const type = matcher === null ? "null" : typeof matcher;
      throw new TypeError(`expect.extend: \`${name}\` is not a valid matcher. Must be a function, is "${type}"`);
    }
    customStaticMatchers.set(name, matcher);
    expect[name] = (...args) => customAsymmetricMatcher(name, matcher, args, {});
    for (const surface of staticMatcherSurfaces.values()) {
      installCustomStaticMatcher(surface, name, matcher);
    }
    Object.defineProperty(Expectation.prototype, name, {
      configurable: true,
      value: function customMatcher(...args) {
        return this._wrap((actual) => {
          const finish = (result) => {
            const parsed = customMatcherResult(name, result);
            this._check(parsed.pass, () => customMatcherMessage(parsed));
            return this;
          };
          const result = invokeCustomMatcher(name, matcher, this._negate, actual, args, this._promiseMode);
          return isPromiseLike(result) ? Promise.resolve(result).then(finish) : finish(result);
        });
      },
    });
  }
}

const matcherUtils = {
  stringify: (value) => formatValue(value),
  printExpected: (value) => formatValue(value),
  printReceived: (value) => formatValue(value),
  EXPECTED_COLOR: (value) => String(value),
  RECEIVED_COLOR: (value) => String(value),
  matcherHint: (name, received = "received", expected = "expected", options = {}) =>
    `expect(${received})${options?.isNot ? ".not" : ""}.${String(name)}(${expected})`,
};

function customMatcherContext(isNot, promiseMode = null) {
  return {
    equals: (actual, expected) => matchesExpected(actual, expected),
    expand: false,
    isNot: Boolean(isNot),
    promise: promiseMode ?? "",
    utils: matcherUtils,
  };
}

function invokeCustomMatcher(_name, matcher, isNot, actual, args, promiseMode = null) {
  return matcher.call(customMatcherContext(isNot, promiseMode), actual, ...args);
}

function customMatcherResult(name, result) {
  const validObject = result !== null && typeof result === "object";
  const hasPass = validObject && "pass" in result;
  const message = validObject ? result.message : undefined;
  if (!hasPass || (message !== undefined && typeof message !== "string" && typeof message !== "function")) {
    throw new Error(
      `Unexpected return from matcher function \`${name}\`.\n` +
      "Matcher functions should return an object in the following format:\n" +
      "  {message?: string | function, pass: boolean}\n" +
      `'${formatValue(result)}' was returned`,
    );
  }
  return { pass: Boolean(result.pass), message };
}

function customMatcherMessage(result) {
  if (result.message === undefined) return "No message was specified for this matcher.";
  return typeof result.message === "function" ? result.message() : result.message;
}

function customAsymmetricMatcher(name, matcher, args, flags) {
  const result = { __expectMatcher: "custom", name, matcher, args, ...flags };
  result.asymmetricMatch = (actual) => asymmetricMatch(actual, result);
  result.toAsymmetricMatcher = (...values) => typeof matcher.toAsymmetricMatcher === "function"
    ? matcher.toAsymmetricMatcher(...values)
    : name;
  return result;
}

const customStaticMatchers = new Map();
const staticMatcherSurfaces = new Map();

function createAsymmetricMatcher(name, fields, flags) {
  const result = { __expectMatcher: name, ...fields, ...flags };
  result.asymmetricMatch = (actual) => asymmetricMatch(actual, result);
  return result;
}

const builtinAsymmetricFactories = {
  any(flags, type) {
    if (typeof type !== "function") {
      throw new TypeError("any() expects to be passed a constructor function. Please pass one or use anything() to match any object.");
    }
    return createAsymmetricMatcher("any", { type }, flags);
  },
  anything(flags) {
    return createAsymmetricMatcher("anything", {}, flags);
  },
  arrayContaining(flags, items) {
    if (!Array.isArray(items)) throw new TypeError("You must provide an array to arrayContaining().");
    return createAsymmetricMatcher("arrayContaining", { items }, flags);
  },
  objectContaining(flags, shape) {
    if (!isObject(shape)) throw new TypeError("You must provide an object to objectContaining().");
    return createAsymmetricMatcher("objectContaining", { shape }, flags);
  },
  stringContaining(flags, text) {
    if (typeof text !== "string" && !(text instanceof String)) throw new TypeError("Expected is not a string");
    return createAsymmetricMatcher("stringContaining", { text: String(text) }, flags);
  },
  stringMatching(flags, pattern) {
    if (typeof pattern !== "string" && !(pattern instanceof RegExp)) {
      throw new TypeError("Expected is not a String or a RegExp");
    }
    return createAsymmetricMatcher("stringMatching", { pattern }, flags);
  },
  closeTo(flags, value, precision = 2) {
    if (typeof value !== "number") throw new TypeError("Expected is not a Number");
    if (typeof precision !== "number") throw new TypeError("Precision is not a Number");
    return createAsymmetricMatcher("closeTo", { value, precision }, flags);
  },
};

function installCustomStaticMatcher(surface, name, matcher) {
  const flags = surface.__expectFlags;
  Object.defineProperty(surface, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: (...args) => customAsymmetricMatcher(name, matcher, args, flags),
  });
}

function staticMatcherSurface(negate = false, promiseMode = null) {
  const key = `${negate ? 1 : 0}:${promiseMode ?? "none"}`;
  const cached = staticMatcherSurfaces.get(key);
  if (cached) return cached;

  const flags = Object.freeze({ negate, promiseMode });
  const surface = {};
  Object.defineProperty(surface, "__expectFlags", { value: flags });
  staticMatcherSurfaces.set(key, surface);

  for (const [name, factory] of Object.entries(builtinAsymmetricFactories)) {
    surface[name] = (...args) => factory(flags, ...args);
  }
  for (const [name, matcher] of customStaticMatchers) installCustomStaticMatcher(surface, name, matcher);

  Object.defineProperties(surface, {
    not: {
      configurable: true,
      get: () => staticMatcherSurface(!negate, promiseMode),
    },
    resolvesTo: {
      configurable: true,
      get() {
        if (promiseMode) throw new Error(`expect.resolvesTo: already called expect.${promiseMode}To on this chain`);
        return staticMatcherSurface(negate, "resolves");
      },
    },
    rejectsTo: {
      configurable: true,
      get() {
        if (promiseMode) throw new Error(`expect.rejectsTo: already called expect.${promiseMode}To on this chain`);
        return staticMatcherSurface(negate, "rejects");
      },
    },
  });
  return surface;
}

const defaultStaticMatchers = staticMatcherSurface();
for (const name of Object.keys(builtinAsymmetricFactories)) expect[name] = defaultStaticMatchers[name];
expect.not = staticMatcherSurface(true);
expect.resolvesTo = staticMatcherSurface(false, "resolves");
expect.rejectsTo = staticMatcherSurface(false, "rejects");
expect.assertions = (count) => {
  if (globalThis.__cottontailCurrentTestIsConcurrent?.()) {
    throw new Error("expect.assertions() is not supported in concurrent tests");
  }
  currentAssertionState().expected = Number(count);
};
expect.hasAssertions = () => {
  if (globalThis.__cottontailCurrentTestIsConcurrent?.()) {
    throw new Error("expect.hasAssertions() is not supported in concurrent tests");
  }
  currentAssertionState().required = true;
};
expect.extend = installCustomMatchers;
expect.addSnapshotSerializer = (_serializer) => { throw new Error("Not implemented"); };
expect.unreachable = (message = "reached unreachable code") => { throw new nodeAssert.AssertionError({ message }); };

function normalizeMockImplementation(implementation, provided = true) {
  if (typeof implementation === "function") return implementation;
  return provided ? function mockValue() { return implementation; } : function mockFunction() {};
}

function mockState() {
  const state = {
    calls: [],
    contexts: [],
    instances: [],
    invocationCallOrder: [],
    results: [],
  };
  Object.defineProperty(state, "lastCall", {
    enumerable: true,
    get() { return state.calls.at(-1); },
  });
  return state;
}

function implementationName(implementation) {
  try {
    if (implementation?._isMockFunction && typeof implementation.getMockName === "function") {
      return implementation.getMockName();
    }
    return typeof implementation?.name === "string" && implementation.name ? implementation.name : "mockConstructor";
  } catch {
    return "mockConstructor";
  }
}

function invalidMockThis() {
  const error = new TypeError("Mock function method called with an invalid this value");
  error.code = "ERR_INVALID_THIS";
  throw error;
}

export function mock(implementation = undefined) {
  const provided = arguments.length > 0;
  let current = normalizeMockImplementation(implementation, provided);
  let state = mockState();
  let name = implementationName(implementation);
  const once = [];

  function mockedFunction(...args) {
    const callState = state;
    const context = this === globalThis ? undefined : this;
    callState.calls.push(args);
    callState.contexts.push(context);
    callState.instances.push(context);
    callState.invocationCallOrder.push(nextInvocationCallOrder++);
    const result = { type: "incomplete", value: undefined };
    callState.results.push(result);
    const implementationForCall = once.length > 0 ? once.shift() : current;
    try {
      const value = implementationForCall.apply(context, args);
      result.type = "return";
      result.value = value;
      return value;
    } catch (error) {
      result.type = "throw";
      result.value = error;
      throw error;
    }
  }

  const prototype = Object.create(Function.prototype);
  const assertThis = (value) => {
    if (value !== mockedFunction) invalidMockThis();
  };
  const method = (methodName, callback) => {
    Object.defineProperty(prototype, methodName, {
      configurable: true,
      value: function mockMethod(...args) {
        assertThis(this);
        return callback(...args);
      },
    });
  };

  Object.defineProperty(prototype, "_isMockFunction", { configurable: true, value: true });
  Object.defineProperty(prototype, "mock", {
    configurable: true,
    get() {
      assertThis(this);
      return state;
    },
  });
  method("mockClear", () => {
    state = mockState();
    return mockedFunction;
  });
  method("mockReset", () => {
    state = mockState();
    once.length = 0;
    current = normalizeMockImplementation(undefined, false);
    return mockedFunction;
  });
  method("mockImplementation", (next) => {
    if (typeof next !== "function") throw new TypeError("mockImplementation expects a function");
    current = next;
    return mockedFunction;
  });
  method("mockImplementationOnce", (next) => {
    if (typeof next !== "function") throw new TypeError("mockImplementationOnce expects a function");
    once.push(next);
    return mockedFunction;
  });
  method("mockReturnValue", (value) => {
    current = () => value;
    return mockedFunction;
  });
  method("mockReturnValueOnce", (value) => {
    once.push(() => value);
    return mockedFunction;
  });
  method("mockReturnThis", () => {
    current = function mockConstructorReturnThis() { return this; };
    return mockedFunction;
  });
  method("mockResolvedValue", (value) => {
    current = () => Promise.resolve(value);
    return mockedFunction;
  });
  method("mockResolvedValueOnce", (value) => {
    once.push(() => Promise.resolve(value));
    return mockedFunction;
  });
  method("mockRejectedValue", (value) => {
    current = () => Promise.resolve().then(() => { throw value; });
    return mockedFunction;
  });
  method("mockRejectedValueOnce", (value) => {
    once.push(() => Promise.resolve().then(() => { throw value; }));
    return mockedFunction;
  });
  method("mockName", (nextName) => {
    if (nextName != null && String(nextName)) {
      name = String(nextName);
      try { Object.defineProperty(mockedFunction, "name", { configurable: true, value: name }); } catch {}
    }
    return mockedFunction;
  });
  method("getMockName", () => name);
  method("withImplementation", (temporary, callback) => {
    if (typeof temporary !== "function" || typeof callback !== "function") {
      throw new TypeError("withImplementation expects two functions");
    }
    const previous = current;
    current = temporary;
    let value;
    try {
      value = callback();
    } catch (error) {
      current = previous;
      throw error;
    }
    if (isPromiseLike(value)) return Promise.resolve(value).finally(() => { current = previous; });
    current = previous;
    return value;
  });
  method("mockRestore", () => {
    const restore = mockedFunction[mockRestoreSymbol];
    restore?.();
    state = mockState();
    once.length = 0;
    current = normalizeMockImplementation(undefined, false);
    return undefined;
  });
  if (typeof Symbol.dispose === "symbol") {
    Object.defineProperty(prototype, Symbol.dispose, {
      configurable: true,
      value: function disposeMock() {
        assertThis(this);
        return mockedFunction.mockRestore();
      },
    });
  }

  Object.setPrototypeOf(mockedFunction, prototype);
  try { Object.defineProperty(mockedFunction, "name", { configurable: true, value: name }); } catch {}
  if (typeof implementation === "function") {
    try { Object.defineProperty(mockedFunction, "length", { configurable: true, value: implementation.length }); } catch {}
  }
  mocks.add(mockedFunction);
  return mockedFunction;
}

mock.clearAllMocks = () => {
  for (const item of mocks) item.mockClear?.();
};
mock.restore = () => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const item of mocks) item.mockReset?.();
  moduleMocks.clear();
  nodeMock.restoreAll?.();
};
function notifyModuleBindings(key, value) {
  const registry = globalThis.__cottontailModuleBindingListeners;
  const values = globalThis.__cottontailModuleBindingValues ??= new Map();
  const candidates = [String(key)];
  if (String(key).startsWith("file:./")) candidates.push(String(key).slice(5));
  else if (String(key).startsWith("./")) candidates.push(`file:${String(key)}`);
  if (String(key).startsWith("node:")) candidates.push(String(key).slice(5));
  else candidates.push(`node:${String(key)}`);
  for (const candidate of [...candidates]) {
    const extensionless = candidate.replace(/\.(?:[cm]?[jt]sx?)$/, "");
    if (extensionless !== candidate) candidates.push(extensionless);
  }
  for (const candidate of candidates) {
    values.set(candidate, value);
    if (!registry) continue;
    for (const listener of registry.get(candidate) ?? []) listener(value);
  }
}
globalThis.__cottontailNotifyModuleBindings = notifyModuleBindings;
mock.module = (specifier, factory = undefined) => {
  const key = String(specifier);
  const value = typeof factory === "function" ? factory() : factory;
  const restoreCommonJS = globalThis.__cottontailApplyCommonJSModuleMock?.(key, value);
  if (typeof restoreCommonJS === "function") restores.push(restoreCommonJS);
  const previous = moduleMocks.get(key);
  if (previous && value && typeof previous === "object" && typeof value === "object" &&
      typeof previous.then !== "function" && typeof value.then !== "function") {
    for (const name of Object.keys(previous)) delete previous[name];
    Object.assign(previous, value);
    notifyModuleBindings(key, previous);
    return previous;
  }
  moduleMocks.set(key, value);
  if (value && typeof value.then === "function") {
    Promise.resolve(value).then((resolved) => notifyModuleBindings(key, resolved));
  } else {
    notifyModuleBindings(key, value);
  }
  return value;
};

export function spyOn(object, property, accessType = undefined) {
  if (object == null) throw new TypeError("spyOn requires an object");
  let owner = object;
  let descriptor = Object.getOwnPropertyDescriptor(owner, property);
  while (!descriptor && (owner = Object.getPrototypeOf(owner))) descriptor = Object.getOwnPropertyDescriptor(owner, property);
  const ownDescriptor = Object.getOwnPropertyDescriptor(object, property);
  const original = object[property];
  if (original?._isMockFunction) return original;
  let spy;
  if (accessType === "get") {
    spy = mock(descriptor?.get ?? (() => original));
    Object.defineProperty(object, property, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: spy,
      set: descriptor?.set,
    });
  } else if (accessType === "set") {
    spy = mock(descriptor?.set ?? (() => undefined));
    Object.defineProperty(object, property, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: descriptor?.get,
      set: spy,
    });
  } else if (typeof original === "function") {
    spy = mock(original);
    Object.defineProperty(object, property, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      writable: true,
      value: spy,
    });
  } else {
    let value = original;
    spy = mock(() => value);
    Object.defineProperty(object, property, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get() { return spy.call(this); },
      set(next) { value = next; },
    });
  }
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (ownDescriptor) Object.defineProperty(object, property, ownDescriptor);
    else delete object[property];
  };
  restores.push(restore);
  Object.defineProperty(spy, mockRestoreSymbol, { configurable: true, value: restore });
  return spy;
}

function clearAllMocks() {
  mock.clearAllMocks();
}

function restoreAllMocks() {
  mock.restore();
}

function resetAllMocks() {
  for (const item of mocks) item.mockReset?.();
}

export function setSystemTime(value = Date.now()) {
  if (!fakeTimersEnabled) installFakeTimers();
  setFakeNow(value);
}

export function setDefaultTimeout(_timeout) {
  nodeSetDefaultTimeout(_timeout);
}

const doneSchedulerStorage = new AsyncLocalStorage();
const previousDoneFrames = new Map();

function normalizeDoneFramePath(path) {
  let normalized = String(path ?? "").replaceAll("\\", "/");
  if (normalized.startsWith("file://")) normalized = normalized.slice("file://".length);
  return normalized.replace(/[?#].*$/, "");
}

function doneContinuationFrame(error) {
  let stack = "";
  try {
    stack = String(error?.stack ?? new Error().stack ?? "");
  } catch {}
  const currentFile = normalizeDoneFramePath(globalThis.__cottontailCurrentTestFile?.());
  for (const line of stack.split("\n")) {
    const jscFrame = /^([^@]*)@(.+):([0-9]+):([0-9]+)$/.exec(line);
    const v8Frame = /^\s*at\s+(?:(.*?)\s+\()?(.+):([0-9]+):([0-9]+)\)?$/.exec(line);
    const filePath = normalizeDoneFramePath(jscFrame?.[2] ?? v8Frame?.[2]);
    const lineNumber = Number(jscFrame?.[3] ?? v8Frame?.[3]);
    if (!filePath || !Number.isFinite(lineNumber) || (currentFile && filePath !== currentFile)) continue;
    let column = Number(jscFrame?.[4] ?? v8Frame?.[4]);
    try {
      const sourceLine = String(nodeReadFileSync(filePath, "utf8")).split(/\r?\n/)[lineNumber - 1] ?? "";
      const constructorIndex = sourceLine.search(/\bnew\s+(?:[A-Za-z_$][\w$]*Error|Error)\b/);
      const prefix = constructorIndex >= 0 ? sourceLine.slice(0, constructorIndex) : sourceLine;
      const calls = [...prefix.matchAll(/\b[A-Za-z_$][\w$]*\s*\(/g)];
      if (calls.length > 0) column = calls[calls.length - 1].index + 1;
    } catch {}
    return { functionName: "<anonymous>", filePath, line: lineNumber, column };
  }
  return null;
}

function runDoneCallbackWithSchedulerTracking(callback, done) {
  const restorations = [];
  const replace = (owner, property, replacement) => {
    const original = owner?.[property];
    if (typeof original !== "function") return;
    try {
      owner[property] = replacement(original);
      restorations.push([owner, property, owner[property], original]);
    } catch {}
  };
  const wrapCallback = (kind, callbackValue) => typeof callbackValue !== "function"
    ? callbackValue
    : function doneScheduledCallback(...args) {
      return doneSchedulerStorage.run(kind, () => Reflect.apply(callbackValue, this, args));
    };

  replace(Promise.prototype, "then", (original) => function then(onFulfilled, onRejected) {
    return Reflect.apply(original, this, [
      wrapCallback("promise", onFulfilled),
      wrapCallback("promise", onRejected),
    ]);
  });
  for (const [name, kind] of [
    ["queueMicrotask", "microtask"],
    ["setTimeout", "timeout"],
    ["setInterval", "timeout"],
    ["setImmediate", "immediate"],
  ]) {
    replace(globalThis, name, (original) => function scheduleDoneCallback(callbackValue, ...args) {
      return Reflect.apply(original, this, [wrapCallback(kind, callbackValue), ...args]);
    });
  }
  replace(globalThis.process, "nextTick", (original) => function nextTick(callbackValue, ...args) {
    return Reflect.apply(original, this, [wrapCallback("nextTick", callbackValue), ...args]);
  });

  try {
    return doneSchedulerStorage.run("sync", () => callback(done));
  } finally {
    for (let index = restorations.length - 1; index >= 0; index -= 1) {
      const [owner, property, replacement, original] = restorations[index];
      if (owner[property] === replacement) owner[property] = original;
    }
  }
}

function wrapDoneCallback(callback) {
  if (typeof callback !== "function" || callback.length === 0) return callback;
  return () => new Promise((resolve, reject) => {
    let settled = false;
    let callbackReturned = false;
    let doneCalled = false;
    let doneError;
    let returnedPromise = null;
    let returnedPromiseSettled = true;
    let returnedPromiseError;

    const callbackFailure = (errors) => {
      if (errors.length === 1 && errors[0] instanceof Error) return errors[0];
      const error = new Error(String(errors[0]?.message ?? errors[0] ?? "Test callback failed"));
      error.code = "ERR_BUN_TEST_CALLBACK_FAILURES";
      error.errors = errors;
      return error;
    };
    const finish = () => {
      if (settled || !callbackReturned) return;
      const errors = [];
      if (doneError !== undefined) errors.push(doneError);
      if (returnedPromiseError !== undefined) errors.push(returnedPromiseError);
      if (returnedPromiseError !== undefined || (doneCalled && returnedPromiseSettled)) {
        settled = true;
        if (errors.length > 0) reject(callbackFailure(errors));
        else resolve();
      }
    };
    const done = (error = undefined) => {
      if (doneCalled || settled) return;
      doneCalled = true;
      const frame = doneContinuationFrame(error);
      const scheduler = doneSchedulerStorage.getStore();
      const previousFrame = frame && previousDoneFrames.get(frame.filePath);
      if (error instanceof Error && previousFrame &&
          (scheduler === "promise" || scheduler === "microtask" || scheduler === "nextTick")) {
        Object.defineProperty(error, "__cottontailBunAsyncParentFrames", {
          configurable: true,
          value: [previousFrame],
        });
      }
      if (frame) previousDoneFrames.set(frame.filePath, frame);
      if (error !== undefined && error !== null) doneError = error;
      finish();
    };
    try {
      const result = runDoneCallbackWithSchedulerTracking(callback, done);
      returnedPromise = result && typeof result.then === "function" ? result : null;
      returnedPromiseSettled = returnedPromise === null;
      callbackReturned = true;
      if (returnedPromise) {
        returnedPromise.then(
          () => {
            returnedPromiseSettled = true;
            finish();
          },
          (error) => {
            returnedPromiseSettled = true;
            returnedPromiseError = error;
            finish();
          },
        );
      }
      finish();
    } catch (error) {
      callbackReturned = true;
      returnedPromiseSettled = true;
      returnedPromiseError = error;
      finish();
    }
  });
}

function resetAssertionState() {
  const state = currentAssertionState();
  state.count = 0;
  state.expected = null;
  state.required = false;
}

function verifyAssertionState() {
  const state = currentAssertionState();
  if (state.expected != null && state.count !== state.expected) {
    const error = new nodeAssert.AssertionError({
      message: `expected ${state.expected} assertion${state.expected === 1 ? "" : "s"}, ` +
        `but test ended with ${state.count} assertion${state.count === 1 ? "" : "s"}`,
    });
    error.code = "ERR_BUN_EXPECT_ASSERTIONS";
    throw error;
  }
  if (state.required && state.count === 0) {
    const error = new nodeAssert.AssertionError({ message: "expected at least one assertion, but test ended with 0 assertions" });
    error.code = "ERR_BUN_EXPECT_ASSERTIONS";
    throw error;
  }
}

function wrapTestCallback(callback) {
  const wrapped = wrapDoneCallback(callback);
  if (typeof wrapped !== "function") return wrapped;
  return async () => {
    resetAssertionState();
    try {
      await wrapped();
      verifyAssertionState();
    } finally {
      globalThis.__cottontailRecordTestAssertionCount?.(currentAssertionState().count);
      resetAssertionState();
    }
  };
}

export function onTestFinished(callback) {
  if (typeof callback !== "function") throw new TypeError("onTestFinished requires a callback");
  nodeOnTestFinished(wrapDoneCallback(callback));
}

export function expectTypeOf(value) {
  void value;
  const chain = new Proxy(function expectTypeOfChain() {}, {
    get() {
      return chain;
    },
    apply() {
      return chain;
    },
  });
  return chain;
}

function normalizeEachValues(row) {
  return Array.isArray(row) ? row : [row];
}

function parseCallbackArgs(args) {
  if (typeof args[0] === "function") {
    return { name: args[0].name || "<anonymous>", options: normalizeTestOptions(args[1]), callback: args[0] };
  }
  if (typeof args[1] === "function") {
    return { name: args[0], options: normalizeTestOptions(args[2]), callback: args[1] };
  }
  return { name: args[0], options: normalizeTestOptions(args[1]), callback: args[2] };
}

function normalizeTestOptions(options) {
  if (typeof options === "number") return { timeout: options };
  return options && typeof options === "object" ? options : {};
}

function validateBunTestOptions(options) {
  const normalized = { ...options };
  if (normalized.retry != null && normalized.repeats != null) {
    throw new TypeError("Cannot set both retry and repeats");
  }
  for (const name of ["retry", "repeats"]) {
    if (normalized[name] == null) continue;
    const count = Number(normalized[name]);
    if (!Number.isInteger(count) || count < 0) {
      throw new TypeError(`${name} must be a non-negative integer`);
    }
    normalized[name] = count;
  }
  return normalized;
}

function parseDescribeArgs(args) {
  const first = args[0];
  if (typeof first !== "function") return parseCallbackArgs(args);
  if (args.length === 1) {
    return { name: first.name || "", options: {}, callback: first };
  }
  const callback = typeof args[1] === "function" ? args[1] : args[2];
  const options = normalizeTestOptions(typeof args[1] === "function" ? args[2] : args[1]);
  if (!first.name) {
    return {
      name: "<invalid describe>",
      options,
      callback: () => {
        nodeTest("<invalid describe>", () => {
          throw new TypeError("describe() expects first argument to be a named class, named function, number, or string");
        });
      },
    };
  }
  return { name: first.name, options, callback };
}

function normalizeTestName(name) {
  if (typeof name === "function") return name.name || String(name);
  return String(name ?? "<anonymous>");
}

const bunRootSuite = {
  name: "",
  parent: null,
  matchingTestCount: 0,
  totalTestCount: 0,
  orderScope: createBunTestOrderScope(),
};
// Grouped runs share one JS realm, so use unnamed suites to retain Bun's
// per-file lifecycle boundaries without changing visible test names.
const bunFileSuites = new Map();
let currentBunSuite = bunRootSuite;

function bunRegistrationSuite() {
  if (currentBunSuite !== bunRootSuite) return currentBunSuite;
  const registeringFile = globalThis.__cottontailRegisteringTestFile;
  if (!registeringFile) return bunRootSuite;
  const file = normalizeInlineSnapshotPath(registeringFile);
  let suite = bunFileSuites.get(file);
  if (suite) return suite;

  suite = {
    name: "",
    parent: bunRootSuite,
    matchingTestCount: 0,
    totalTestCount: 0,
    orderScope: createBunTestOrderScope(bunRootSuite.orderScope),
  };
  beginBunTestCollection(suite.orderScope);
  bunFileSuites.set(file, suite);
  const registrationLine = captureTestRegistrationLine(registeringFile);
  enqueueBunTestEntry(bunRootSuite.orderScope, () => nodeDescribe(
    "",
    {
      __bunDeferredDefinition: true,
      __bunRegistrationLine: registrationLine,
      __bunTest: true,
    },
    wrapBunDescribeCallback(() => {}, suite),
  ));
  return suite;
}

const startNodeTestRunSymbol = Symbol.for("cottontail.internal.startTestRun");
const startNodeTestRun = globalThis[startNodeTestRunSymbol];
globalThis[startNodeTestRunSymbol] = () => {
  flushBunTestOrderScope(bunRootSuite.orderScope);
  reportBunTestRandomizationSeed();
  return startNodeTestRun?.();
};
installBunTestFilterReporter(() => bunRootSuite.totalTestCount - bunRootSuite.matchingTestCount);

function bunSuiteNames(suite) {
  const names = [];
  for (let cursor = suite; cursor && cursor !== bunRootSuite; cursor = cursor.parent) {
    if (cursor.name) names.push(cursor.name);
  }
  return names.reverse();
}

function noteBunTestSelection(name, registrationSuite = currentBunSuite) {
  const matches = bunTestNameMatches(bunSuiteNames(currentBunSuite), name);
  for (let suite = registrationSuite; suite; suite = suite.parent) {
    suite.totalTestCount += 1;
    if (matches) suite.matchingTestCount += 1;
  }
}

function wrapBunDescribeCallback(callback, suite) {
  if (typeof callback !== "function") return callback;
  return function bunDescribeDefinition(...args) {
    const previousSuite = currentBunSuite;
    currentBunSuite = suite;
    beginBunTestCollection(suite.orderScope);
    const finishCollection = () => {
      flushBunTestOrderScope(suite.orderScope);
      currentBunSuite = previousSuite;
    };
    try {
      const result = Reflect.apply(callback, this, args);
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).finally(finishCollection);
      }
      finishCollection();
      return result;
    } catch (error) {
      finishCollection();
      throw error;
    }
  };
}

function wrapBunLifecycleHook(callback, suite) {
  const wrapped = wrapDoneCallback(callback);
  if (typeof wrapped !== "function") return wrapped;
  if (!bunTestFilterIsActive()) return wrapped;
  return function bunFilteredLifecycleHook(...args) {
    if (suite.matchingTestCount === 0) return undefined;
    return Reflect.apply(wrapped, this, args);
  };
}

function makeEach(base) {
  return (table) => {
    const rows = validateBunEachTable(table);
    return (name, options, callback) => {
      const parsed = parseCallbackArgs([name, options, callback]);
      rows.forEach((row, index) => {
        const values = normalizeEachValues(row);
        const testCallback = parsed.callback?.length > values.length
          ? (done) => parsed.callback?.call(row, ...values, done)
          : () => parsed.callback?.apply(row, values);
        base(formatBunEachLabel(parsed.name, values, index), parsed.options, testCallback);
      });
      return undefined;
    };
  };
}

function makeBunTestFunction(base) {
  const register = (args, extraOptions = {}, requireCallback = false) => {
    globalThis.__cottontailBunTestUsed = true;
    if (extraOptions.only) assertOnlyAllowed();
    const registrationSuite = bunRegistrationSuite();
    const parsed = parseCallbackArgs(args);
    if (requireCallback && typeof parsed.callback !== "function") {
      throw new TypeError("test.failing expects a function as the second argument");
    }
    const options = validateBunTestOptions({ ...parsed.options, ...extraOptions });
    const name = normalizeTestName(parsed.name);
    let registrationLine = captureTestRegistrationLine(
      globalThis.__cottontailRegisteringTestFile ?? globalThis.__filename ?? "",
    );
    if (options.todo && typeof parsed.callback !== "function") registrationLine = Math.max(0, registrationLine - 1);
    noteBunTestSelection(name, registrationSuite);
    return enqueueBunTestEntry(registrationSuite.orderScope, () => base(
      name,
      applyBunFileConcurrency({
        ...options,
        __bunRegistrationLine: registrationLine,
        __bunTest: true,
        __bunUsesDoneCallback: typeof parsed.callback === "function" && parsed.callback.length > 0,
      }),
      wrapTestCallback(parsed.callback),
    ));
  };
  const variant = (extraOptions, requireCallback = false) => {
    const result = (...args) => register(args, extraOptions, requireCallback);
    result.each = makeEach(result);
    result.skipIf = (condition) => condition ? variant({ ...extraOptions, skip: true }, requireCallback) : result;
    result.todoIf = (condition) => condition ? variant({ ...extraOptions, todo: true }, requireCallback) : result;
    result.if = (condition) => condition ? result : variant({ ...extraOptions, skip: true }, requireCallback);
    Object.defineProperty(result, "only", { get: () => variant({ ...extraOptions, only: true }, requireCallback) });
    Object.defineProperty(result, "failing", { get: () => variant({ ...extraOptions, failing: true }, true) });
    Object.defineProperty(result, "skip", { get: () => variant({ ...extraOptions, skip: true }, requireCallback) });
    Object.defineProperty(result, "todo", { get: () => variant({ ...extraOptions, todo: true }, requireCallback) });
    Object.defineProperty(result, "concurrent", { get: () => variant({ ...extraOptions, concurrent: true }, requireCallback) });
    Object.defineProperty(result, "serial", { get: () => variant({ ...extraOptions, serial: true }, requireCallback) });
    return result;
  };
  const fn = (...args) => register(args);
  fn.each = makeEach(fn);
  fn.only = variant({ only: true });
  fn.failing = variant({ failing: true }, true);
  fn.skip = variant({ skip: true });
  fn.todo = variant({ todo: true });
  fn.skipIf = (condition) => condition ? fn.skip : fn;
  fn.todoIf = (condition) => condition ? fn.todo : fn;
  fn.if = (condition) => condition ? fn : fn.skip;
  fn.concurrent = variant({ concurrent: true });
  fn.serial = variant({ serial: true });
  return fn;
}

function makeBunDescribe(base) {
  const fn = (...args) => {
    globalThis.__cottontailBunTestUsed = true;
    const registrationSuite = bunRegistrationSuite();
    const parsed = parseDescribeArgs(args);
    const name = normalizeTestName(parsed.name);
    const registrationLine = captureTestRegistrationLine(
      globalThis.__cottontailRegisteringTestFile ?? globalThis.__filename ?? "",
    );
    const suite = {
      name,
      parent: registrationSuite,
      matchingTestCount: 0,
      totalTestCount: 0,
      orderScope: createBunTestOrderScope(registrationSuite.orderScope),
    };
    return enqueueBunTestEntry(registrationSuite.orderScope, () => base(
      name,
      applyBunFileConcurrency({ ...parsed.options, __bunRegistrationLine: registrationLine, __bunDeferredDefinition: true, __bunTest: true }),
      wrapBunDescribeCallback(parsed.callback, suite),
    ));
  };
  fn.each = makeEach(fn);
  const variant = (extraOptions) => {
    const result = (...args) => {
      globalThis.__cottontailBunTestUsed = true;
      if (extraOptions.only) assertOnlyAllowed();
      const registrationSuite = bunRegistrationSuite();
      const parsed = parseDescribeArgs(args);
      const name = normalizeTestName(parsed.name);
      const registrationLine = captureTestRegistrationLine(
        globalThis.__cottontailRegisteringTestFile ?? globalThis.__filename ?? "",
      );
      const suite = {
        name,
        parent: registrationSuite,
        matchingTestCount: 0,
        totalTestCount: 0,
        orderScope: createBunTestOrderScope(registrationSuite.orderScope),
      };
      return enqueueBunTestEntry(registrationSuite.orderScope, () => base(
        name,
        applyBunFileConcurrency({ ...parsed.options, ...extraOptions, __bunRegistrationLine: registrationLine, __bunDeferredDefinition: true, __bunTest: true }),
        wrapBunDescribeCallback(parsed.callback, suite),
      ));
    };
    result.each = makeEach(result);
    result.skipIf = (condition) => condition ? variant({ ...extraOptions, skip: true }) : result;
    result.todoIf = (condition) => condition ? variant({ ...extraOptions, todo: true }) : result;
    result.if = (condition) => condition ? result : variant({ ...extraOptions, skip: true });
    Object.defineProperty(result, "only", { get: () => variant({ ...extraOptions, only: true }) });
    Object.defineProperty(result, "skip", { get: () => variant({ ...extraOptions, skip: true }) });
    Object.defineProperty(result, "todo", { get: () => variant({ ...extraOptions, todo: true }) });
    Object.defineProperty(result, "concurrent", { get: () => variant({ ...extraOptions, concurrent: true }) });
    Object.defineProperty(result, "serial", { get: () => variant({ ...extraOptions, serial: true }) });
    return result;
  };
  fn.only = variant({ only: true });
  fn.skip = variant({ skip: true });
  fn.todo = variant({ todo: true });
  fn.skipIf = (condition) => condition ? fn.skip : fn;
  fn.todoIf = (condition) => condition ? fn.todo : fn;
  fn.if = (condition) => condition ? fn : fn.skip;
  fn.concurrent = variant({ concurrent: true });
  fn.serial = variant({ serial: true });
  return fn;
}

function markBunTestUsed() {
  globalThis.__cottontailBunTestUsed = true;
}

function isTruthyEnvValue(value) {
  if (value == null) return false;
  const text = String(value).toLowerCase();
  return text !== "" && text !== "0" && text !== "false";
}

function isCIEnvironment() {
  const env = globalThis.process?.env ?? {};
  if (env.CI != null) return isTruthyEnvValue(env.CI);
  if (env.JENKINS_URL != null || env.BUILD_ID != null) return true;
  return ["GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "TRAVIS", "BUILDKITE", "APPVEYOR", "TEAMCITY_VERSION"]
    .some((name) => isTruthyEnvValue(env[name]));
}

// Bun refuses .only when running in a CI environment: the call throws while
// the test file is being evaluated, so the run errors out with exit code 1.
function assertOnlyAllowed() {
  if (!isCIEnvironment()) return;
  throw new Error(
    ".only is disabled in CI environments to prevent accidentally skipping tests. " +
    "To override, set the environment variable CI=false.",
  );
}

export const beforeAll = (callback, options = {}) => {
  markBunTestUsed();
  const suite = bunRegistrationSuite();
  const hook = wrapBunLifecycleHook(callback, suite);
  return enqueueBunTestHook(suite.orderScope, () => nodeBefore(hook, options));
};
export const afterAll = (callback, options = {}) => {
  markBunTestUsed();
  const suite = bunRegistrationSuite();
  const hook = wrapBunLifecycleHook(callback, suite);
  return enqueueBunTestHook(suite.orderScope, () => nodeAfter(hook, options));
};
export const beforeEach = (callback, options = {}) => {
  markBunTestUsed();
  const suite = bunRegistrationSuite();
  const hook = wrapBunLifecycleHook(callback, suite);
  return enqueueBunTestHook(suite.orderScope, () => nodeBeforeEach(hook, options));
};
export const afterEach = (callback, options = {}) => {
  markBunTestUsed();
  const suite = bunRegistrationSuite();
  const hook = wrapBunLifecycleHook(callback, suite);
  return enqueueBunTestHook(suite.orderScope, () => nodeAfterEach(hook, options));
};
export const test = makeBunTestFunction(nodeTest);
export const it = test;
export const describe = makeBunDescribe(nodeDescribe);
export const xit = test.skip;
export const xtest = test.skip;
export const xdescribe = describe.skip;

// Bun's jest.mock() is module mocking (mock.module), not the mock-function
// factory. It validates its arguments with TypeErrors (ENG-24434).
function jestMockModule(specifier, factory = undefined) {
  if (typeof specifier !== "string") {
    throw new TypeError("jest.mock() expects a string module path as the first argument");
  }
  if (typeof factory !== "function") {
    throw new TypeError("jest.mock() requires a module factory function as the second argument");
  }
  return mock.module(specifier, factory);
}

export const jest = {
  fn: mock,
  mock: jestMockModule,
  spyOn,
  clearAllMocks,
  resetAllMocks,
  restoreAllMocks,
  useFakeTimers(options = undefined) { installFakeTimers(options); return this; },
  useRealTimers() { uninstallFakeTimers(); return this; },
  isFakeTimers() { return fakeTimersEnabled; },
  setSystemTime,
  now() { return fakeTimersEnabled ? timerClock() : Date.now(); },
  clearAllTimers() {
    if (!fakeTimersEnabled) throw new Error("Fake timers are not active");
    fakeTimers.clear();
    return this;
  },
  getTimerCount() {
    if (!fakeTimersEnabled) throw new Error("Fake timers are not active");
    return fakeTimers.size;
  },
  runAllTimers() { runTimersUntil(Infinity); return this; },
  runOnlyPendingTimers() {
    const pending = dueTimers(Infinity);
    if (pending.length > 0) runTimersUntil(pending[pending.length - 1].deadline);
    return this;
  },
  advanceTimersByTime(ms = 0) {
    runTimersUntil(fakeDateNanoseconds + millisecondsToNanoseconds(Math.max(0, Number(ms) || 0)));
    return this;
  },
  advanceTimersToNextTimer(steps = 1) {
    for (let index = 0; index < Math.max(1, Number(steps) || 1); index += 1) {
      const next = dueTimers(Infinity)[0];
      if (!next) break;
      runTimersUntil(next.deadline);
    }
    return this;
  },
  setTimeout(timeout) { setDefaultTimeout(timeout); return this; },
};

export const vi = {
  ...jest,
};

const defaultExport = {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  jest,
  mock,
  onTestFinished,
  setDefaultTimeout,
  setSystemTime,
  spyOn,
  test,
  vi,
  xdescribe,
  xit,
  xtest,
};

function installShellConstructor() {
  const shell = globalThis.Bun?.$;
  if (typeof shell !== "function" || typeof shell.Shell === "function") return;

  class Shell {
    constructor() {
      const callable = (strings, ...values) => {
        const command = shell(strings, ...values);
        command.throws(callable._throws);
        if (callable._cwd != null) command.cwd(callable._cwd);
        if (callable._env != null) command.env(callable._env);
        return command;
      };
      Object.setPrototypeOf(callable, Shell.prototype);
      callable._cwd = undefined;
      callable._env = undefined;
      callable._throws = true;
      return callable;
    }

    cwd(value) {
      this._cwd = String(value);
      return this;
    }

    env(value) {
      this._env = { ...(value ?? {}) };
      return this;
    }

    throws(value = true) {
      this._throws = Boolean(value);
      return this;
    }

    nothrow() {
      return this.throws(false);
    }
  }

  Object.setPrototypeOf(Shell.prototype, Function.prototype);
  shell.Shell = Shell;
}

// Track subprocesses started inside tests so a test timeout can kill the
// dangling ones, like bun does. Blocking Bun.spawnSync calls inside a test
// with an explicit timeout get a watchdog that SIGKILLs the child at the
// test deadline (bun's watchdog terminates blocked tests the same way).
function installTestSubprocessTracking() {
  const bun = globalThis.Bun;
  if (!bun || bun.__cottontailTestSpawnTracked) return;
  const originalSpawn = bun.spawn;
  const originalSpawnSync = bun.spawnSync;
  if (typeof originalSpawn !== "function" || typeof originalSpawnSync !== "function") return;
  Object.defineProperty(bun, "__cottontailTestSpawnTracked", { value: true });

  const wrappedSpawn = function spawn(...args) {
    const proc = originalSpawn.apply(bun, args);
    globalThis.__cottontailRegisterTestSubprocess?.(proc);
    return proc;
  };
  Object.assign(wrappedSpawn, originalSpawn);
  bun.spawn = wrappedSpawn;

  const deadlineCommand = (cmd, remainingMs) => {
    const seconds = Math.max(Number(remainingMs), 5) / 1000;
    const script = `"$@" & CT_CHILD=$!; ( /bin/sleep ${seconds}; kill -9 $CT_CHILD 2>/dev/null ) >/dev/null 2>&1 & CT_WATCH=$!; ` +
      "{ wait $CT_CHILD; } 2>/dev/null; CT_STATUS=$?; kill $CT_WATCH 2>/dev/null; exit $CT_STATUS";
    return ["/bin/sh", "-c", script, "sh", ...cmd.map(String)];
  };

  const wrappedSpawnSync = function spawnSync(command, ...rest) {
    const remaining = globalThis.__cottontailCurrentTestRemainingMs?.();
    const platform = globalThis.process?.platform;
    if (remaining != null && Number.isFinite(remaining) && platform !== "win32") {
      let wrappedCommand = null;
      if (Array.isArray(command)) {
        wrappedCommand = deadlineCommand(command, remaining);
      } else if (command && typeof command === "object" && Array.isArray(command.cmd)) {
        wrappedCommand = { ...command, cmd: deadlineCommand(command.cmd, remaining) };
      }
      if (wrappedCommand != null) {
        const result = originalSpawnSync.call(bun, wrappedCommand, ...rest);
        if (Number(result?.exitCode) === 137) globalThis.__cottontailNoteDanglingProcessKilled?.();
        return result;
      }
    }
    return originalSpawnSync.call(bun, command, ...rest);
  };
  Object.assign(wrappedSpawnSync, originalSpawnSync);
  bun.spawnSync = wrappedSpawnSync;
}

function wrapCallerOriginFileURLToPath(fileURLToPath) {
  const wrapped = (value) => value === ""
    ? String(globalThis.process?.argv?.[1] ?? "")
    : fileURLToPath(value);
  Object.defineProperty(wrapped, "__cottontailCallerOriginFallback", { value: true });
  return wrapped;
}

function installCallerOriginFallback() {
  const bun = globalThis.Bun ??= {};
  if (bun.__cottontailCallerOriginFallback) return;
  Object.defineProperty(bun, "__cottontailCallerOriginFallback", { value: true });
  if (typeof bun.fileURLToPath === "function") {
    bun.fileURLToPath = wrapCallerOriginFileURLToPath(bun.fileURLToPath);
    return;
  }
  Object.defineProperty(bun, "fileURLToPath", {
    configurable: true,
    get() { return undefined; },
    set(value) {
      Object.defineProperty(bun, "fileURLToPath", {
        configurable: true,
        writable: true,
        value: typeof value === "function" ? wrapCallerOriginFileURLToPath(value) : value,
      });
    },
  });
}

globalThis.jest ??= jest;
globalThis.vi ??= vi;
installCallerOriginFallback();
installTestSubprocessTracking();

queueMicrotask(() => {
  globalThis.jest ??= jest;
  globalThis.vi ??= vi;
  installShellConstructor();
  installTestSubprocessTracking();
});

export default defaultExport;
