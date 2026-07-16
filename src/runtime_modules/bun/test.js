import nodeAssert from "../node/assert.js";
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

const mocks = new Set();
const restores = [];
const mockRestoreSymbol = Symbol("mockRestore");
let nextInvocationCallOrder = 1;
const moduleMocks = globalThis.__cottontailBunModuleMocks ??= new Map();
const snapshots = new Map();
const snapshotCounters = new Map();
const writableSnapshotFiles = new Set();
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
let assertionCount = 0;
let expectedAssertions = null;
let requireAssertions = false;
globalThis.__cottontailTestAssertionCount ??= 0;

function isObject(value) {
  return value !== null && typeof value === "object";
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

function deepEqual(left, right) {
  try {
    nodeAssert.deepStrictEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function plainObjectEntries(value) {
  if (!isObject(value) || Array.isArray(value)) return null;
  if (value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set) return null;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return null;
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
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
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
  if (actual instanceof ArrayBuffer || expected instanceof ArrayBuffer) {
    if (!(actual instanceof ArrayBuffer) || !(expected instanceof ArrayBuffer)) return false;
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
  const parts = Array.isArray(path) ? path : String(path).split(".");
  let cursor = object;
  for (const part of parts) {
    if (cursor == null || !(part in Object(cursor))) return [false, undefined];
    cursor = cursor[part];
  }
  return [true, cursor];
}

function matcherName(expected) {
  return expected?.__expectMatcher;
}

function asymmetricMatch(actual, expected) {
  switch (matcherName(expected)) {
    case "any":
      return expected.type === String ? typeof actual === "string" || actual instanceof String
        : expected.type === Number ? typeof actual === "number" || actual instanceof Number
        : expected.type === Boolean ? typeof actual === "boolean" || actual instanceof Boolean
        : expected.type === BigInt ? typeof actual === "bigint"
        : expected.type === Symbol ? typeof actual === "symbol"
        : actual instanceof expected.type;
    case "anything":
      return actual != null;
    case "arrayContaining":
      return Array.isArray(actual) && expected.items.every((item) => actual.some((candidate) => matchesExpected(candidate, item)));
    case "objectContaining":
      return isObject(actual) && Object.keys(expected.shape).every((key) => matchesExpected(actual[key], expected.shape[key]));
    case "stringContaining":
      return String(actual).includes(expected.text);
    case "stringMatching":
      return expected.pattern.test(String(actual));
    case "closeTo":
      return Math.abs(Number(actual) - Number(expected.value)) < 10 ** -Number(expected.precision) / 2;
    case "custom": {
      const result = invokeCustomMatcher(expected.name, expected.matcher, expected.negate, actual, expected.args);
      const finish = (value) => {
        const pass = customMatcherResult(expected.name, value).pass;
        return expected.negate ? !pass : pass;
      };
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

function matchesExpected(actual, expected, seen = new WeakMap()) {
  if (matcherName(expected)) return asymmetricMatch(actual, expected);
  if (Object.is(actual, expected)) return true;
  if (isBlobLike(actual) || isBlobLike(expected)) return bunDeepEqual(actual, expected);
  if (ArrayBuffer.isView(actual) || ArrayBuffer.isView(expected) || actual instanceof ArrayBuffer || expected instanceof ArrayBuffer) {
    return bunDeepEqual(actual, expected);
  }
  if (actual instanceof Error || expected instanceof Error) {
    return actual instanceof Error && expected instanceof Error && actual.name === expected.name && actual.message === expected.message;
  }
  if (!isObject(actual) || !isObject(expected)) return false;
  let expectedSeen = seen.get(actual);
  if (expectedSeen?.has(expected)) return true;
  if (!expectedSeen) {
    expectedSeen = new WeakSet();
    seen.set(actual, expectedSeen);
  }
  expectedSeen.add(expected);

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
      if (!matchesExpected(actual[index], expected[index], seen)) return false;
    }
    return true;
  }
  if (expected instanceof Map) {
    if (!(actual instanceof Map) || actual.size !== expected.size) return false;
    const unmatched = Array.from(actual.entries());
    for (const [expectedKey, expectedValue] of expected) {
      const index = unmatched.findIndex(([key, value]) =>
        matchesExpected(key, expectedKey, seen) && matchesExpected(value, expectedValue, seen));
      if (index < 0) return false;
      unmatched.splice(index, 1);
    }
    return true;
  }
  if (expected instanceof Set) {
    if (!(actual instanceof Set) || actual.size !== expected.size) return false;
    const unmatched = Array.from(actual.values());
    for (const expectedValue of expected) {
      const index = unmatched.findIndex((value) => matchesExpected(value, expectedValue, seen));
      if (index < 0) return false;
      unmatched.splice(index, 1);
    }
    return true;
  }
  if (expected instanceof Date || expected instanceof RegExp) return deepEqual(actual, expected);

  const expectedKeys = Reflect.ownKeys(expected);
  const actualKeys = Reflect.ownKeys(actual);
  const expectedHasProtoKey = Object.prototype.hasOwnProperty.call(expected, "__proto__");
  const actualHasProtoKey = Object.prototype.hasOwnProperty.call(actual, "__proto__");
  const expectedPrototype = Object.getPrototypeOf(expected);
  const actualPrototype = Object.getPrototypeOf(actual);
  const expectedVirtualProto = actualHasProtoKey && !expectedHasProtoKey && expectedPrototype !== Object.prototype && expectedPrototype !== null;
  const actualVirtualProto = expectedHasProtoKey && !actualHasProtoKey && actualPrototype !== Object.prototype && actualPrototype !== null;
  if (expectedVirtualProto) expectedKeys.push("__proto__");
  if (actualVirtualProto) actualKeys.push("__proto__");
  if (actualKeys.length !== expectedKeys.length) return false;
  for (const key of expectedKeys) {
    const virtualProtoKey = key === "__proto__";
    if (!Object.prototype.hasOwnProperty.call(actual, key) && !(virtualProtoKey && actualVirtualProto)) return false;
    const actualValue = virtualProtoKey && actualVirtualProto ? actualPrototype : actual[key];
    const expectedValue = virtualProtoKey && expectedVirtualProto ? expectedPrototype : expected[key];
    if (!matchesExpected(actualValue, expectedValue, seen)) return false;
  }
  return true;
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
  const text = String(value);
  if (text.includes("\n")) return `"${text.replace(/\\/g, "\\\\")}"`;
  return JSON.stringify(text);
}

function indentSnapshotBlock(text) {
  return String(text).split("\n").map((line) => `  ${line}`).join("\n");
}

function snapshotSerialize(value) {
  if (typeof value === "string") return snapshotQuoteString(value);
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
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return [
      "[",
      ...value.map((item) => `${indentSnapshotBlock(snapshotSerialize(item))},`),
      "]",
    ].join("\n");
  }
  const entries = plainObjectEntries(value);
  if (entries) {
    if (entries.length === 0) return "{}";
    entries.sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    return [
      "{",
      ...entries.map(([key, item]) => {
        const serialized = snapshotSerialize(item);
        if (typeof item === "string" && item.includes("\n")) {
          return `  ${JSON.stringify(String(key))}: \n${serialized}\n,`;
        }
        if (serialized.includes("\n")) {
          const lines = serialized.split("\n");
          return [
            `  ${JSON.stringify(String(key))}: ${lines[0]}`,
            ...lines.slice(1).map((line) => `  ${line}`),
          ].join("\n") + ",";
        }
        return `  ${JSON.stringify(String(key))}: ${serialized},`;
      }),
      "}",
    ].join("\n");
  }
  return formatValue(value);
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
  if (value instanceof ArrayBuffer) return value.byteLength === 0;
  if (value instanceof Map || value instanceof Set) return value.size === 0;
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
  if (value instanceof Map || value instanceof Set || value instanceof Date || value instanceof RegExp) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.keys(value).length === 0;
}

function snapshotText(value) {
  return snapshotSerialize(value);
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

function nextSnapshotIdentity(hint = undefined) {
  const file = globalThis.process?.argv?.[1] ?? "<script>";
  const testName = typeof globalThis.__cottontailCurrentTestName === "function" ? globalThis.__cottontailCurrentTestName() : "";
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

function persistSnapshot(identity, text) {
  if (!globalThis.cottontail?.writeFile || identity.file === "<script>") return;
  const path = snapshotFilePath(identity.file);
  let source = "// Jest Snapshot v1, https://bun.sh/docs/test/snapshots\n";
  try {
    source = String(cottontail.readFile(path));
    if (!writableSnapshotFiles.has(path)) return;
  } catch {
    const slash = path.lastIndexOf("/");
    cottontail.mkdirSync(path.slice(0, slash), true);
    writableSnapshotFiles.add(path);
  }
  const escapedKey = String(identity.exportKey).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  const escapedText = String(text).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  source += `\nexports[\`${escapedKey}\`] = \`\n${escapedText}\n\`;\n`;
  cottontail.writeFile(path, source);
}

function compareSnapshot(actual, expected = undefined, hint = undefined) {
  const text = snapshotText(actual);
  if (expected != null) {
    return text === normalizeSnapshotText(expected);
  }
  const identity = nextSnapshotIdentity(hint);
  if (!snapshots.has(identity.key)) {
    snapshots.set(identity.key, text);
    persistSnapshot(identity, text);
  }
  return snapshots.get(identity.key) === text;
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
}

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
  constructor(actual, negate = false, promiseMode = null, label = undefined, rejectedValue = false) {
    this.actual = actual;
    this._negate = negate;
    this._promiseMode = promiseMode;
    this._label = label;
    this._rejectedValue = rejectedValue;
  }

  get not() {
    return new Expectation(this.actual, !this._negate, this._promiseMode, this._label, this._rejectedValue);
  }

  get resolves() {
    const handled = Promise.resolve().then(() => promiseFromActual(this.actual, "resolves")).then(
      (value) => value,
      (error) => {
        throw new nodeAssert.AssertionError({
          message: `Received promise rejected instead of resolved: ${formatValue(error)}`,
        });
      },
    );
    return new Expectation(handled, this._negate, "resolves", this._label);
  }

  get rejects() {
    const handled = Promise.resolve().then(() => promiseFromActual(this.actual, "rejects")).then(
      (promise) => promise,
    ).then(
      () => {
        throw new nodeAssert.AssertionError({ message: "Received promise resolved instead of rejected" });
      },
      (error) => error,
    );
    return new Expectation(handled, this._negate, "rejects", this._label);
  }

  async _promiseActual() {
    if (this._promiseMode === "resolves") return await this.actual;
    if (this._promiseMode === "rejects") return await this.actual;
    return this.actual;
  }

  _check(pass, message) {
    if (this._skipAssertionCount) this._skipAssertionCount = false;
    else {
      assertionCount += 1;
      globalThis.__cottontailTestAssertionCount += 1;
    }
    const ok = this._negate ? !pass : pass;
    if (ok) return;
    if (typeof message === "function") message = message();
    const label = this._label == null ? "" : `${String(this._label)}\n\n`;
    throw new nodeAssert.AssertionError({ message: `${label}${message}` });
  }

  _wrap(check) {
    if (this._promiseMode) {
      const rejectedValue = this._promiseMode === "rejects";
      return this._promiseActual().then((actual) => check.call(new Expectation(actual, this._negate, null, this._label, rejectedValue), actual));
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
        const body = this._negate
          ? `Expected: not ${formatValue(expected)}`
          : `Expected: ${formatValue(expected)}\nReceived: ${formatValue(actual)}`;
        return this._label == null ? `${signature}\n\n${body}` : body;
      });
      return isPromiseLike(pass) ? Promise.resolve(pass).then(finish) : finish(pass);
    });
  }

  toStrictEqual(expected) {
    return this.toEqual(expected);
  }

  toMatchObject(expected) {
    return this._wrap((actual) => {
      const pass = matcherName(expected)
        ? isObject(actual)
        : isObject(actual) && Object.keys(expected ?? {}).every((key) => matchesExpected(actual[key], expected[key]));
      this._check(pass, `Expected ${formatValue(actual)} to match object ${formatValue(expected)}`);
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
  toBeTypeOf(type) { return this._wrap((actual) => this._check(typeof actual === String(type), `Expected type ${type}`)); }
  toBeInstanceOf(type) { return this._wrap((actual) => this._check(actual instanceof type, `Expected instance of ${type?.name ?? type}`)); }
  toBeArray() { return this._wrap((actual) => this._check(Array.isArray(actual), "Expected value to be an array")); }
  toBeArrayOfSize(size) { return this._wrap((actual) => this._check(Array.isArray(actual) && actual.length === Number(size), `Expected array size ${size}`)); }
  toBeObject() { return this._wrap((actual) => this._check(isObject(actual) && !Array.isArray(actual), "Expected value to be an object")); }
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
      typeof actual === "number" && Number.isFinite(actual) && Math.round(actual) < 0,
      "Expected negative number",
    ));
  }
  toBeGreaterThan(expected) { return this._wrap((actual) => this._check(actual > expected, `Expected > ${expected}`)); }
  toBeGreaterThanOrEqual(expected) { return this._wrap((actual) => this._check(actual >= expected, `Expected >= ${expected}`)); }
  toBeLessThan(expected) { return this._wrap((actual) => this._check(actual < expected, `Expected < ${expected}`)); }
  toBeLessThanOrEqual(expected) { return this._wrap((actual) => this._check(actual <= expected, `Expected <= ${expected}`)); }
  toBeCloseTo(expected, precision = 2) { return this._wrap((actual) => this._check(Math.abs(Number(actual) - Number(expected)) < 10 ** -Number(precision) / 2, `Expected close to ${expected}`)); }
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
      const pass = typeof actual === "string" ? actual.includes(String(expected)) : Array.from(actual ?? []).some((value) => matchesExpected(value, expected));
      this._check(pass, `Expected ${formatValue(actual)} to contain ${formatValue(expected)}`);
    });
  }

  toContainEqual(expected) { return this.toContain(expected); }
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
    return this._wrap((actual) => {
      const actualLength = actual?.length ?? (actual instanceof ArrayBuffer || ArrayBuffer.isView(actual) ? actual.byteLength : undefined);
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
  toContainKey(key) { return this._wrap((actual) => this._check(isObject(actual) && Object.hasOwn(actual, key), `Expected key ${String(key)}`)); }
  toContainKeys(keys) { return this._wrap((actual) => this._check(Array.from(keys ?? []).every((key) => isObject(actual) && Object.hasOwn(actual, key)), "Expected keys")); }
  toContainAnyKeys(keys) { return this._wrap((actual) => this._check(Array.from(keys ?? []).some((key) => isObject(actual) && Object.hasOwn(actual, key)), "Expected any key")); }
  toContainAllKeys(keys) { return this.toContainKeys(keys); }
  toContainValue(value) { return this._wrap((actual) => this._check(Object.values(Object(actual)).some((candidate) => matchesExpected(candidate, value)), "Expected object value")); }
  toContainValues(values) { return this._wrap((actual) => this._check(Array.from(values ?? []).every((value) => Object.values(Object(actual)).some((candidate) => matchesExpected(candidate, value))), "Expected object values")); }
  toContainAnyValues(values) { return this._wrap((actual) => this._check(Array.from(values ?? []).some((value) => Object.values(Object(actual)).some((candidate) => matchesExpected(candidate, value))), "Expected any object value")); }
  toContainAllValues(values) { return this.toContainValues(values); }

  toThrow(expected = undefined) {
    const rejectedValue = this._promiseMode === "rejects" || this._rejectedValue;
    return this._wrap((actual) => {
      const checkThrown = (didThrow, thrown) => {
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
        this._check(pass, "Expected function to throw");
      };
      if (typeof actual !== "function") return checkThrown(rejectedValue, actual);
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
          assertionCount += 1;
          globalThis.__cottontailTestAssertionCount += 1;
          this._skipAssertionCount = true;
        }
        return settled;
      }
      return this._check(false, "Expected function to throw");
    });
  }

  toThrowError(expected = undefined) { return this.toThrow(expected); }
  toThrowErrorMatchingSnapshot() { return this.toThrow(); }
  toThrowErrorMatchingInlineSnapshot() { return this.toThrow(); }
  toMatchSnapshot(propertyMatchers = undefined, hint = undefined) {
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
      this._check(compareSnapshot(actual, undefined, snapshotHint), "Expected value to match snapshot");
    });
  }
  toMatchInlineSnapshot(propertyMatchers = undefined, inlineSnapshot = undefined) {
    return this._wrap((actual) => {
      let expected = inlineSnapshot;
      if (typeof propertyMatchers === "string" && inlineSnapshot === undefined) {
        expected = propertyMatchers;
      } else if (propertyMatchers && typeof propertyMatchers === "object") {
        assertPropertyMatchers(actual, propertyMatchers);
      }
      const received = snapshotText(actual);
      const wanted = normalizeSnapshotText(expected);
      this._check(inlineSnapshotMatches(received, wanted), `Expected value to match inline snapshot\nExpected: ${JSON.stringify(wanted)}\nReceived: ${JSON.stringify(received)}`);
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
        calls.some((call) => matchesExpected(call, args)),
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
        matchesExpected(calls.at(-1), args),
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
        matchesExpected(calls[nth - 1], args),
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
assertionCount = 0;
globalThis.__cottontailTestAssertionCount = 0;

export function expect(actual, label = undefined) {
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
    expect[name] = (...args) => customAsymmetricMatcher(name, matcher, args, false);
    expect.not[name] = (...args) => customAsymmetricMatcher(name, matcher, args, true);
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

function customAsymmetricMatcher(name, matcher, args, negate) {
  const result = { __expectMatcher: "custom", name, matcher, args, negate };
  result.asymmetricMatch = (actual) => asymmetricMatch(actual, result);
  result.toAsymmetricMatcher = (...values) => typeof matcher.toAsymmetricMatcher === "function"
    ? matcher.toAsymmetricMatcher(...values)
    : name;
  return result;
}

expect.any = (type) => ({ __expectMatcher: "any", type });
expect.anything = () => ({ __expectMatcher: "anything" });
expect.arrayContaining = (items) => ({ __expectMatcher: "arrayContaining", items: Array.from(items ?? []) });
expect.objectContaining = (shape) => ({ __expectMatcher: "objectContaining", shape: shape ?? {} });
expect.stringContaining = (text) => ({ __expectMatcher: "stringContaining", text: String(text) });
expect.stringMatching = (pattern) => ({ __expectMatcher: "stringMatching", pattern: pattern instanceof RegExp ? pattern : new RegExp(String(pattern)) });
expect.closeTo = (value, precision = 2) => ({ __expectMatcher: "closeTo", value, precision });
expect.not = {
  arrayContaining: (items) => ({ __expectMatcher: "not", matcher: expect.arrayContaining(items) }),
  objectContaining: (shape) => ({ __expectMatcher: "not", matcher: expect.objectContaining(shape) }),
  stringContaining: (text) => ({ __expectMatcher: "not", matcher: expect.stringContaining(text) }),
  stringMatching: (pattern) => ({ __expectMatcher: "not", matcher: expect.stringMatching(pattern) }),
};
expect.assertions = (count) => { expectedAssertions = Number(count); };
expect.hasAssertions = () => { requireAssertions = true; };
expect.extend = installCustomMatchers;
expect.addSnapshotSerializer = (_serializer) => undefined;
expect.unreachable = (message = "reached unreachable code") => { throw new nodeAssert.AssertionError({ message }); };
expect.resolvesTo = (value, expected) => expect(value).resolves.toEqual(expected);
expect.rejectsTo = (value, expected) => expect(value).rejects.toThrow(expected);

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

function wrapDoneCallback(callback) {
  if (typeof callback !== "function" || callback.length === 0) return callback;
  return () => new Promise((resolve, reject) => {
    let settled = false;
    let callbackReturned = false;
    let returnedPromise = null;
    let returnedPromiseSettled = false;
    let doneCalled = false;
    const done = (error = undefined) => {
      if (settled) return;
      if (error) {
        settled = true;
        reject(error);
        return;
      }
      doneCalled = true;
      if (callbackReturned && (!returnedPromise || returnedPromiseSettled)) {
        settled = true;
        resolve();
      }
    };
    try {
      const result = callback(done);
      returnedPromise = result && typeof result.then === "function" ? result : null;
      callbackReturned = true;
      if (returnedPromise) {
        returnedPromise.then(
          () => {
            returnedPromiseSettled = true;
            if (!settled && doneCalled) {
              settled = true;
              resolve();
            }
          },
          (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          },
        );
      } else if (doneCalled && !settled) {
        settled = true;
        resolve();
      }
    } catch (error) {
      done(error);
    }
  });
}

function resetAssertionState() {
  assertionCount = 0;
  expectedAssertions = null;
  requireAssertions = false;
}

function verifyAssertionState() {
  if (expectedAssertions != null && assertionCount !== expectedAssertions) {
    throw new nodeAssert.AssertionError({ message: `Expected ${expectedAssertions} assertions, received ${assertionCount}` });
  }
  if (requireAssertions && assertionCount === 0) {
    throw new nodeAssert.AssertionError({ message: "Expected at least one assertion" });
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

function formatEachName(name, values, index) {
  let valueIndex = 0;
  return String(name).replace(/%[#psdifjo]/g, (token) => {
    if (token === "%#") return String(index);
    const value = values[valueIndex++];
    if (token === "%s") return String(value);
    if (token === "%d" || token === "%i") return String(Number(value));
    if (token === "%f") return String(Number(value));
    return formatValue(value);
  });
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
        throw new TypeError("describe() expects first argument to be a named class, named function, number, or string");
      },
    };
  }
  return { name: first.name, options, callback };
}

function normalizeTestName(name) {
  if (typeof name === "function") return name.name || String(name);
  return String(name ?? "<anonymous>");
}

function makeEach(base) {
  return (table) => (name, options, callback) => {
    const parsed = parseCallbackArgs([name, options, callback]);
    Array.from(table ?? []).forEach((row, index) => {
      const values = normalizeEachValues(row);
      const testCallback = parsed.callback?.length > values.length
        ? (done) => parsed.callback?.(...values, done)
        : () => parsed.callback?.(...values);
      base(formatEachName(parsed.name, values, index), parsed.options, testCallback);
    });
    return undefined;
  };
}

function makeBunTestFunction(base) {
  const register = (args, extraOptions = {}, requireCallback = false) => {
    globalThis.__cottontailBunTestUsed = true;
    if (extraOptions.only) assertOnlyAllowed();
    const parsed = parseCallbackArgs(args);
    if (requireCallback && typeof parsed.callback !== "function") {
      throw new TypeError("test.failing expects a function as the second argument");
    }
    return base(
      normalizeTestName(parsed.name),
      { ...parsed.options, ...extraOptions },
      wrapTestCallback(parsed.callback),
    );
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
    const parsed = parseDescribeArgs(args);
    return base(normalizeTestName(parsed.name), parsed.options, parsed.callback);
  };
  fn.each = makeEach(fn);
  const variant = (extraOptions) => {
    const result = (...args) => {
      globalThis.__cottontailBunTestUsed = true;
      if (extraOptions.only) assertOnlyAllowed();
      const parsed = parseDescribeArgs(args);
      return base(normalizeTestName(parsed.name), { ...parsed.options, ...extraOptions }, parsed.callback);
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
  return nodeBefore(wrapDoneCallback(callback), options);
};
export const afterAll = (callback, options = {}) => {
  markBunTestUsed();
  return nodeAfter(wrapDoneCallback(callback), options);
};
export const beforeEach = (callback, options = {}) => {
  markBunTestUsed();
  return nodeBeforeEach(wrapDoneCallback(callback), options);
};
export const afterEach = (callback, options = {}) => {
  markBunTestUsed();
  return nodeAfterEach(wrapDoneCallback(callback), options);
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
    const script = `"$@" & CT_CHILD=$!; ( sleep ${seconds}; kill -9 $CT_CHILD 2>/dev/null ) >/dev/null 2>&1 & CT_WATCH=$!; ` +
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
