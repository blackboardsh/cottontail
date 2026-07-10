import nodeAssert from "../node/assert.js";
import {
  after as nodeAfter,
  afterEach,
  before as nodeBefore,
  beforeEach,
  describe as nodeDescribe,
  it,
  mock as nodeMock,
  test,
} from "../node/test.js";

const mocks = new Set();
const restores = [];
const moduleMocks = globalThis.__cottontailBunModuleMocks ??= new Map();
const snapshots = new Map();
const snapshotCounters = new Map();
let fakeSystemTime = null;
let fakeTimersEnabled = false;
let fakeNow = Date.now();
let nextFakeTimerId = 1;
const fakeTimers = new Map();
const realTimers = {
  Date: globalThis.Date,
  clearImmediate: globalThis.clearImmediate,
  clearInterval: globalThis.clearInterval,
  clearTimeout: globalThis.clearTimeout,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  setImmediate: globalThis.setImmediate,
  setInterval: globalThis.setInterval,
  setTimeout: globalThis.setTimeout,
};
let assertionCount = 0;
let expectedAssertions = null;
let requireAssertions = false;

function isObject(value) {
  return value !== null && typeof value === "object";
}

function deepEqual(left, right) {
  try {
    nodeAssert.deepStrictEqual(left, right);
    return true;
  } catch {
    return false;
  }
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
    default:
      return false;
  }
}

function matchesExpected(actual, expected) {
  if (matcherName(expected)) return asymmetricMatch(actual, expected);
  return deepEqual(actual, expected);
}

function formatValue(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function snapshotText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "bigint") return `${value}n`;
  return formatValue(value);
}

function normalizeSnapshotText(value) {
  return String(value).replace(/^\n/, "").replace(/\n\s*$/, "");
}

function nextSnapshotKey(hint = undefined) {
  const file = globalThis.process?.argv?.[1] ?? "<script>";
  if (hint != null) return `${file}:${String(hint)}`;
  const current = snapshotCounters.get(file) ?? 0;
  const next = current + 1;
  snapshotCounters.set(file, next);
  return `${file}:${next}`;
}

function compareSnapshot(actual, expected = undefined, hint = undefined) {
  const text = snapshotText(actual);
  if (expected != null) {
    return text === normalizeSnapshotText(expected);
  }
  const key = nextSnapshotKey(hint);
  if (!snapshots.has(key)) snapshots.set(key, text);
  return snapshots.get(key) === text;
}

function assertPropertyMatchers(actual, propertyMatchers) {
  const pass = isObject(actual) && Object.keys(propertyMatchers ?? {})
    .every((key) => matchesExpected(actual[key], propertyMatchers[key]));
  if (!pass) {
    throw new nodeAssert.AssertionError({ message: `Expected ${formatValue(actual)} to match snapshot property matchers` });
  }
}

function failMatcher(pass, negate, message) {
  const ok = negate ? !pass : pass;
  if (!ok) throw new nodeAssert.AssertionError({ message });
}

function callRecords(value) {
  const calls = value?.mock?.calls;
  if (!Array.isArray(calls)) throw new nodeAssert.AssertionError({ message: "Expected a mock function" });
  return calls;
}

function resultRecords(value) {
  return value?.mock?.results ?? [];
}

function timerClock() {
  return fakeSystemTime ?? fakeNow;
}

function setFakeNow(value) {
  fakeNow = value instanceof realTimers.Date ? value.getTime() : Number(value);
  if (!Number.isFinite(fakeNow)) fakeNow = realTimers.Date.now();
  fakeSystemTime = fakeNow;
}

function normalizeTimerCallback(callback) {
  if (typeof callback === "function") return callback;
  const source = String(callback);
  return () => (0, eval)(source);
}

function fakeSetTimeout(callback, ms = 0, ...args) {
  const id = nextFakeTimerId++;
  fakeTimers.set(id, {
    id,
    callback: normalizeTimerCallback(callback),
    args,
    deadline: timerClock() + Math.max(0, Number(ms) || 0),
    interval: null,
  });
  return id;
}

function fakeSetInterval(callback, ms = 0, ...args) {
  const id = nextFakeTimerId++;
  const interval = Math.max(1, Number(ms) || 0);
  fakeTimers.set(id, {
    id,
    callback: normalizeTimerCallback(callback),
    args,
    deadline: timerClock() + interval,
    interval,
  });
  return id;
}

function fakeClearTimer(id) {
  fakeTimers.delete(Number(id));
}

function fakeSetImmediate(callback, ...args) {
  return fakeSetTimeout(callback, 0, ...args);
}

function dueTimers(until = Infinity) {
  return Array.from(fakeTimers.values())
    .filter((timer) => timer.deadline <= until)
    .sort((left, right) => left.deadline - right.deadline || left.id - right.id);
}

function runFakeTimer(timer) {
  if (!fakeTimers.has(timer.id)) return;
  fakeTimers.delete(timer.id);
  fakeNow = Math.max(timer.deadline, fakeNow);
  fakeSystemTime = fakeNow;
  timer.callback(...timer.args);
  if (timer.interval != null && fakeTimersEnabled) {
    timer.deadline = fakeNow + timer.interval;
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
  if (Number.isFinite(target)) {
    fakeNow = Math.max(fakeNow, target);
    fakeSystemTime = fakeNow;
  }
}

function installFakeTimers() {
  if (fakeTimersEnabled) return;
  fakeTimersEnabled = true;
  setFakeNow(fakeSystemTime ?? realTimers.Date.now());
  class FakeDate extends realTimers.Date {
    constructor(...args) {
      super(...(args.length === 0 ? [timerClock()] : args));
    }

    static now() {
      return timerClock();
    }
  }
  globalThis.Date = FakeDate;
  globalThis.setTimeout = fakeSetTimeout;
  globalThis.clearTimeout = fakeClearTimer;
  globalThis.setInterval = fakeSetInterval;
  globalThis.clearInterval = fakeClearTimer;
  globalThis.setImmediate = fakeSetImmediate;
  globalThis.clearImmediate = fakeClearTimer;
  globalThis.requestAnimationFrame = (callback) => fakeSetTimeout(() => callback(timerClock()), 16);
  globalThis.cancelAnimationFrame = fakeClearTimer;
}

function uninstallFakeTimers() {
  if (!fakeTimersEnabled) return;
  fakeTimersEnabled = false;
  fakeTimers.clear();
  fakeSystemTime = null;
  globalThis.Date = realTimers.Date;
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
}

class Expectation {
  constructor(actual, negate = false, promiseMode = null) {
    this.actual = actual;
    this._negate = negate;
    this._promiseMode = promiseMode;
  }

  get not() {
    return new Expectation(this.actual, !this._negate, this._promiseMode);
  }

  get resolves() {
    return new Expectation(Promise.resolve(this.actual), this._negate, "resolves");
  }

  get rejects() {
    const handled = Promise.resolve(this.actual).then(
      () => {
        throw new nodeAssert.AssertionError({ message: "Expected promise to reject" });
      },
      (error) => error,
    );
    return new Expectation(handled, this._negate, "rejects");
  }

  async _promiseActual() {
    if (this._promiseMode === "resolves") return await this.actual;
    if (this._promiseMode === "rejects") return await this.actual;
    return this.actual;
  }

  _check(pass, message) {
    assertionCount += 1;
    failMatcher(pass, this._negate, message);
  }

  _wrap(check) {
    if (this._promiseMode) {
      return this._promiseActual().then((actual) => check.call(new Expectation(actual, this._negate, null), actual));
    }
    return check.call(this, this.actual);
  }

  toBe(expected) {
    return this._wrap((actual) => this._check(Object.is(actual, expected), `Expected ${formatValue(actual)} to be ${formatValue(expected)}`));
  }

  toEqual(expected) {
    return this._wrap((actual) => this._check(matchesExpected(actual, expected), `Expected ${formatValue(actual)} to equal ${formatValue(expected)}`));
  }

  toStrictEqual(expected) {
    return this.toEqual(expected);
  }

  toMatchObject(expected) {
    return this._wrap((actual) => {
      const pass = isObject(actual) && Object.keys(expected ?? {}).every((key) => matchesExpected(actual[key], expected[key]));
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
  toBeString() { return this._wrap((actual) => this._check(typeof actual === "string", "Expected value to be a string")); }
  toBeNumber() { return this._wrap((actual) => this._check(typeof actual === "number", "Expected value to be a number")); }
  toBeBoolean() { return this._wrap((actual) => this._check(typeof actual === "boolean", "Expected value to be a boolean")); }
  toBeSymbol() { return this._wrap((actual) => this._check(typeof actual === "symbol", "Expected value to be a symbol")); }
  toBeDate() { return this._wrap((actual) => this._check(actual instanceof Date, "Expected value to be a Date")); }
  toBeValidDate() { return this._wrap((actual) => this._check(actual instanceof Date && !Number.isNaN(actual.getTime()), "Expected valid Date")); }
  toBeInteger() { return this._wrap((actual) => this._check(Number.isInteger(actual), "Expected integer")); }
  toBeEven() { return this._wrap((actual) => this._check(Number(actual) % 2 === 0, "Expected even number")); }
  toBeOdd() { return this._wrap((actual) => this._check(Math.abs(Number(actual) % 2) === 1, "Expected odd number")); }
  toBePositive() { return this._wrap((actual) => this._check(Number(actual) > 0, "Expected positive number")); }
  toBeNegative() { return this._wrap((actual) => this._check(Number(actual) < 0, "Expected negative number")); }
  toBeGreaterThan(expected) { return this._wrap((actual) => this._check(actual > expected, `Expected > ${expected}`)); }
  toBeGreaterThanOrEqual(expected) { return this._wrap((actual) => this._check(actual >= expected, `Expected >= ${expected}`)); }
  toBeLessThan(expected) { return this._wrap((actual) => this._check(actual < expected, `Expected < ${expected}`)); }
  toBeLessThanOrEqual(expected) { return this._wrap((actual) => this._check(actual <= expected, `Expected <= ${expected}`)); }
  toBeCloseTo(expected, precision = 2) { return this._wrap((actual) => this._check(Math.abs(Number(actual) - Number(expected)) < 10 ** -Number(precision) / 2, `Expected close to ${expected}`)); }
  toBeWithin(min, max) { return this._wrap((actual) => this._check(Number(actual) >= Number(min) && Number(actual) <= Number(max), `Expected within ${min}..${max}`)); }
  toBeOneOf(values) { return this._wrap((actual) => this._check(Array.from(values ?? []).some((value) => Object.is(value, actual)), "Expected one of values")); }

  toContain(expected) {
    return this._wrap((actual) => {
      const pass = typeof actual === "string" ? actual.includes(String(expected)) : Array.from(actual ?? []).some((value) => matchesExpected(value, expected));
      this._check(pass, `Expected ${formatValue(actual)} to contain ${formatValue(expected)}`);
    });
  }

  toContainEqual(expected) { return this.toContain(expected); }
  toInclude(expected) { return this.toContain(expected); }
  toIncludeRepeated(expected) { return this.toContain(expected); }
  toStartWith(expected) { return this._wrap((actual) => this._check(String(actual).startsWith(String(expected)), `Expected to start with ${expected}`)); }
  toEndWith(expected) { return this._wrap((actual) => this._check(String(actual).endsWith(String(expected)), `Expected to end with ${expected}`)); }
  toMatch(expected) { return this._wrap((actual) => this._check(expected instanceof RegExp ? expected.test(String(actual)) : String(actual).includes(String(expected)), `Expected to match ${expected}`)); }
  toEqualIgnoringWhitespace(expected) { return this._wrap((actual) => this._check(String(actual).replace(/\s+/g, "") === String(expected).replace(/\s+/g, ""), "Expected equal ignoring whitespace")); }
  toHaveLength(length) { return this._wrap((actual) => this._check(actual?.length === Number(length), `Expected length ${length}`)); }

  toHaveProperty(path, expected = undefined) {
    return this._wrap((actual) => {
      const [exists, value] = hasProperty(actual, path);
      this._check(exists && (arguments.length < 2 || matchesExpected(value, expected)), `Expected property ${String(path)}`);
    });
  }

  toContainKey(key) { return this._wrap((actual) => this._check(isObject(actual) && key in actual, `Expected key ${String(key)}`)); }
  toContainKeys(keys) { return this._wrap((actual) => this._check(Array.from(keys ?? []).every((key) => isObject(actual) && key in actual), "Expected keys")); }
  toContainAnyKeys(keys) { return this._wrap((actual) => this._check(Array.from(keys ?? []).some((key) => isObject(actual) && key in actual), "Expected any key")); }
  toContainAllKeys(keys) { return this.toContainKeys(keys); }
  toContainValue(value) { return this._wrap((actual) => this._check(Object.values(Object(actual)).some((candidate) => matchesExpected(candidate, value)), "Expected object value")); }
  toContainValues(values) { return this._wrap((actual) => this._check(Array.from(values ?? []).every((value) => Object.values(Object(actual)).some((candidate) => matchesExpected(candidate, value))), "Expected object values")); }
  toContainAnyValues(values) { return this._wrap((actual) => this._check(Array.from(values ?? []).some((value) => Object.values(Object(actual)).some((candidate) => matchesExpected(candidate, value))), "Expected any object value")); }
  toContainAllValues(values) { return this.toContainValues(values); }

  toThrow(expected = undefined) {
    return this._wrap((actual) => {
      let thrown;
      if (typeof actual === "function") {
        try {
          actual();
        } catch (error) {
          thrown = error;
        }
      } else {
        thrown = actual;
      }
      const pass = thrown && (expected === undefined ||
        (expected instanceof RegExp ? expected.test(String(thrown.message ?? thrown)) :
          typeof expected === "function" ? thrown instanceof expected :
            String(thrown.message ?? thrown).includes(String(expected))));
      this._check(pass, "Expected function to throw");
    });
  }

  toThrowError(expected = undefined) { return this.toThrow(expected); }
  toThrowErrorMatchingSnapshot() { return this.toThrow(); }
  toThrowErrorMatchingInlineSnapshot() { return this.toThrow(); }
  toMatchSnapshot(propertyMatchers = undefined, hint = undefined) {
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
      this._check(compareSnapshot(actual, expected), "Expected value to match inline snapshot");
    });
  }
  toSatisfy(predicate) { return this._wrap((actual) => this._check(predicate(actual) === true, "Expected predicate to pass")); }

  toHaveBeenCalled() { return this._wrap((actual) => this._check(callRecords(actual).length > 0, "Expected mock to be called")); }
  toBeCalled() { return this.toHaveBeenCalled(); }
  toHaveBeenCalledOnce() { return this.toHaveBeenCalledTimes(1); }
  toHaveBeenCalledTimes(count) { return this._wrap((actual) => this._check(callRecords(actual).length === Number(count), `Expected ${count} calls`)); }
  toBeCalledTimes(count) { return this.toHaveBeenCalledTimes(count); }
  toHaveBeenCalledWith(...args) { return this._wrap((actual) => this._check(callRecords(actual).some((call) => matchesExpected(call, args)), "Expected call arguments")); }
  toBeCalledWith(...args) { return this.toHaveBeenCalledWith(...args); }
  toHaveBeenLastCalledWith(...args) { return this.lastCalledWith(...args); }
  lastCalledWith(...args) { return this._wrap((actual) => this._check(matchesExpected(callRecords(actual).at(-1), args), "Expected last call arguments")); }
  toHaveBeenNthCalledWith(index, ...args) { return this.nthCalledWith(index, ...args); }
  nthCalledWith(index, ...args) { return this._wrap((actual) => this._check(matchesExpected(callRecords(actual)[Number(index) - 1], args), "Expected nth call arguments")); }

  toHaveReturned() { return this._wrap((actual) => this._check(resultRecords(actual).some((result) => result.type === "return"), "Expected mock to return")); }
  toReturn() { return this.toHaveReturned(); }
  toHaveReturnedTimes(count) { return this._wrap((actual) => this._check(resultRecords(actual).filter((result) => result.type === "return").length === Number(count), `Expected ${count} returns`)); }
  toHaveReturnedWith(value) { return this._wrap((actual) => this._check(resultRecords(actual).some((result) => result.type === "return" && matchesExpected(result.value, value)), "Expected return value")); }
  lastReturnedWith(value) { return this._wrap((actual) => this._check(matchesExpected(resultRecords(actual).filter((result) => result.type === "return").at(-1)?.value, value), "Expected last return value")); }
  toHaveLastReturnedWith(value) { return this.lastReturnedWith(value); }
  nthReturnedWith(index, value) { return this._wrap((actual) => this._check(matchesExpected(resultRecords(actual).filter((result) => result.type === "return")[Number(index) - 1]?.value, value), "Expected nth return value")); }
  toHaveNthReturnedWith(index, value) { return this.nthReturnedWith(index, value); }
}

export function expect(actual) {
  return new Expectation(actual);
}

expect.any = (type) => ({ __expectMatcher: "any", type });
expect.anything = () => ({ __expectMatcher: "anything" });
expect.arrayContaining = (items) => ({ __expectMatcher: "arrayContaining", items: Array.from(items ?? []) });
expect.objectContaining = (shape) => ({ __expectMatcher: "objectContaining", shape: shape ?? {} });
expect.stringContaining = (text) => ({ __expectMatcher: "stringContaining", text: String(text) });
expect.stringMatching = (pattern) => ({ __expectMatcher: "stringMatching", pattern: pattern instanceof RegExp ? pattern : new RegExp(String(pattern)) });
expect.closeTo = (value, precision = 2) => ({ __expectMatcher: "closeTo", value, precision });
expect.assertions = (count) => { expectedAssertions = Number(count); };
expect.hasAssertions = () => { requireAssertions = true; };
expect.extend = (_matchers) => undefined;
expect.addSnapshotSerializer = (_serializer) => undefined;
expect.unreachable = (message = "unreachable") => { throw new nodeAssert.AssertionError({ message }); };
expect.resolvesTo = (value, expected) => expect(value).resolves.toEqual(expected);
expect.rejectsTo = (value, expected) => expect(value).rejects.toThrow(expected);

function normalizeMockImplementation(implementation) {
  return typeof implementation === "function" ? implementation : function mockFunction() {};
}

export function mock(implementation = undefined) {
  let current = normalizeMockImplementation(implementation);
  const calls = [];
  const contexts = [];
  const instances = [];
  const results = [];
  const invocationCallOrder = [];

  function mockedFunction(...args) {
    calls.push(args);
    contexts.push(this);
    invocationCallOrder.push(invocationCallOrder.length + 1);
    if (new.target) instances.push(this);
    try {
      const value = current.apply(this, args);
      results.push({ type: "return", value });
      return value;
    } catch (error) {
      results.push({ type: "throw", value: error });
      throw error;
    }
  }

  mockedFunction.mock = { calls, contexts, instances, invocationCallOrder, results };
  mockedFunction.mockClear = () => {
    calls.length = 0;
    contexts.length = 0;
    instances.length = 0;
    invocationCallOrder.length = 0;
    results.length = 0;
    return mockedFunction;
  };
  mockedFunction.mockReset = () => {
    mockedFunction.mockClear();
    current = function mockFunction() {};
    return mockedFunction;
  };
  mockedFunction.mockImplementation = (next) => {
    current = normalizeMockImplementation(next);
    return mockedFunction;
  };
  mockedFunction.mockReturnValue = (value) => mockedFunction.mockImplementation(() => value);
  mockedFunction.mockResolvedValue = (value) => mockedFunction.mockImplementation(() => Promise.resolve(value));
  mockedFunction.mockRejectedValue = (value) => mockedFunction.mockImplementation(() => Promise.reject(value));
  mockedFunction.mockRestore = () => {
    mockedFunction.mockReset();
    return undefined;
  };
  mocks.add(mockedFunction);
  return mockedFunction;
}

mock.clearAllMocks = () => {
  for (const item of mocks) item.mockClear?.();
};
mock.restore = () => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const item of mocks) item.mockRestore?.();
  moduleMocks.clear();
  nodeMock.restoreAll?.();
};
mock.module = (specifier, factory = undefined) => {
  const key = String(specifier);
  const value = typeof factory === "function" ? factory() : factory;
  moduleMocks.set(key, value);
  return value;
};

export function spyOn(object, property, accessType = undefined) {
  if (object == null) throw new TypeError("spyOn requires an object");
  const descriptor = Object.getOwnPropertyDescriptor(object, property);
  const original = object[property];
  let spy;
  if (accessType === "get") {
    spy = mock(descriptor?.get ?? (() => original));
    Object.defineProperty(object, property, { configurable: true, get: spy });
  } else if (accessType === "set") {
    spy = mock(descriptor?.set ?? (() => undefined));
    Object.defineProperty(object, property, { configurable: true, set: spy });
  } else {
    spy = mock(typeof original === "function" ? original : () => original);
    object[property] = spy;
  }
  restores.push(() => descriptor ? Object.defineProperty(object, property, descriptor) : delete object[property]);
  spy.mockRestore = () => {
    const restore = restores.pop();
    restore?.();
  };
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
  return undefined;
}

export function onTestFinished(callback) {
  if (typeof callback !== "function") throw new TypeError("onTestFinished requires a callback");
  nodeAfter(callback);
}

export function expectTypeOf(value) {
  return expect(value);
}

export const beforeAll = nodeBefore;
export const afterAll = nodeAfter;
export { afterEach, beforeEach, it, test };
export const describe = nodeDescribe;
export const xit = Object.assign(() => undefined, { skip: () => undefined });
export const xtest = xit;
export const xdescribe = xit;

export const jest = {
  fn: mock,
  mock,
  spyOn,
  clearAllMocks,
  resetAllMocks,
  restoreAllMocks,
  useFakeTimers() { installFakeTimers(); return this; },
  useRealTimers() { uninstallFakeTimers(); return this; },
  isFakeTimers() { return fakeTimersEnabled; },
  setSystemTime,
  now() { return fakeTimersEnabled ? timerClock() : Date.now(); },
  clearAllTimers() { fakeTimers.clear(); return this; },
  getTimerCount() { return fakeTimers.size; },
  runAllTimers() { runTimersUntil(Infinity); return this; },
  runOnlyPendingTimers() {
    const pending = dueTimers(Infinity);
    for (const timer of pending) runFakeTimer(timer);
    return this;
  },
  advanceTimersByTime(ms = 0) { runTimersUntil(timerClock() + Math.max(0, Number(ms) || 0)); return this; },
  advanceTimersToNextTimer(steps = 1) {
    for (let index = 0; index < Math.max(1, Number(steps) || 1); index += 1) {
      const next = dueTimers(Infinity)[0];
      if (!next) break;
      runTimersUntil(next.deadline);
    }
    return this;
  },
  setTimeout(_timeout) {},
};

export const vi = {
  ...jest,
};

if (globalThis.process?.on) {
  globalThis.process.on("beforeExit", () => {
    if (expectedAssertions != null && assertionCount !== expectedAssertions) {
      throw new nodeAssert.AssertionError({ message: `Expected ${expectedAssertions} assertions, received ${assertionCount}` });
    }
    if (requireAssertions && assertionCount === 0) {
      throw new nodeAssert.AssertionError({ message: "Expected at least one assertion" });
    }
  });
}

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

export default defaultExport;
