import * as nodeAssert from "./assert.js";
import { Readable } from "./stream.js";

const tests = [];
const events = [];
const beforeHooks = [];
const afterHooks = [];
const beforeEachHooks = [];
const afterEachHooks = [];
let beforeRan = false;

function emit(type, data = {}) {
  const event = { type, data };
  events.push(event);
  return event;
}

function parseTestArgs(name, options, fn) {
  if (typeof name === "function") {
    fn = name;
    options = {};
    name = fn.name || "<anonymous>";
  } else if (typeof name === "object" && name !== null) {
    fn = options;
    options = name;
    name = options.name ?? "<anonymous>";
  } else if (typeof options === "function") {
    fn = options;
    options = {};
  }
  return { name: String(name ?? "<anonymous>"), options: options ?? {}, fn };
}

class TestContext {
  constructor(record) {
    this.name = record.name;
    this.signal = { aborted: false };
    this.mock = mock;
    this.assert = assert;
  }

  async test(name, options, fn) {
    return test(name, options, fn);
  }

  skip(reason = "skipped") {
    const error = new Error(String(reason));
    error.code = "ERR_TEST_SKIP";
    throw error;
  }

  todo(reason = "todo") {
    const error = new Error(String(reason));
    error.code = "ERR_TEST_TODO";
    throw error;
  }

  diagnostic(message) {
    emit("test:diagnostic", { message: String(message), nesting: 0 });
  }
}

async function runHookList(hooks) {
  for (const hook of hooks) await hook.fn();
}

async function execute(record) {
  if (record.ran) return record.result;
  record.ran = true;
  emit("test:start", { name: record.name });
  if (record.options.skip) {
    emit("test:pass", { name: record.name, skip: record.options.skip === true ? "skipped" : record.options.skip });
    return undefined;
  }
  if (record.options.todo) {
    emit("test:pass", { name: record.name, todo: record.options.todo === true ? "todo" : record.options.todo });
    return undefined;
  }

  const started = performance?.now?.() ?? Date.now();
  try {
    if (!beforeRan) {
      beforeRan = true;
      await runHookList(beforeHooks);
    }
    await runHookList(beforeEachHooks);
    if (typeof record.fn === "function") {
      const context = new TestContext(record);
      if (record.fn.length >= 2) {
        await new Promise((resolve, reject) => {
          let settled = false;
          const done = (error = undefined) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve();
          };
          try {
            const result = record.fn(context, done);
            if (result && typeof result.then === "function") result.then(undefined, done);
          } catch (error) {
            done(error);
          }
        });
      } else {
        await record.fn(context);
      }
    }
    await runHookList(afterEachHooks);
    emit("test:pass", { name: record.name, duration_ms: (performance?.now?.() ?? Date.now()) - started });
  } catch (error) {
    emit("test:fail", { name: record.name, error, duration_ms: (performance?.now?.() ?? Date.now()) - started });
    throw error;
  }
}

function makeTestFunction(defaultOptions = {}) {
  const fn = function nodeTest(name, options, callback) {
    const parsed = parseTestArgs(name, options, callback);
    const record = {
      name: parsed.name,
      options: { ...defaultOptions, ...parsed.options },
      fn: parsed.fn,
      ran: false,
      result: null,
    };
    tests.push(record);
    record.result = Promise.resolve().then(() => execute(record));
    return record.result;
  };
  return fn;
}

export const test = makeTestFunction();
export const it = test;

function suiteFunction(name, options, callback) {
  const parsed = parseTestArgs(name, options, callback);
  emit("test:suite:start", { name: parsed.name });
  try {
    const result = typeof parsed.fn === "function" ? parsed.fn() : undefined;
    emit("test:suite:finish", { name: parsed.name });
    return Promise.resolve(result);
  } catch (error) {
    emit("test:fail", { name: parsed.name, error });
    return Promise.reject(error);
  }
}

export const describe = Object.assign(suiteFunction, {
  only: (...args) => suiteFunction(args[0], { ...(typeof args[1] === "object" ? args[1] : {}), only: true }, typeof args[1] === "function" ? args[1] : args[2]),
  skip: (...args) => suiteFunction(args[0], { ...(typeof args[1] === "object" ? args[1] : {}), skip: true }, typeof args[1] === "function" ? args[1] : args[2]),
  todo: (...args) => suiteFunction(args[0], { ...(typeof args[1] === "object" ? args[1] : {}), todo: true }, typeof args[1] === "function" ? args[1] : args[2]),
});

export const suite = describe;
export const only = makeTestFunction({ only: true });
export const skip = makeTestFunction({ skip: true });
export const todo = makeTestFunction({ todo: true });

export function before(fn, options = {}) {
  beforeHooks.push({ fn, options });
}

export function after(fn, options = {}) {
  afterHooks.push({ fn, options });
}

export function beforeEach(fn, options = {}) {
  beforeEachHooks.push({ fn, options });
}

export function afterEach(fn, options = {}) {
  afterEachHooks.push({ fn, options });
}

class MockTracker {
  constructor() {
    this._restores = [];
  }

  fn(implementation = function mockFunction() {}) {
    const calls = [];
    const wrapped = function mockedFunction(...args) {
      calls.push({ arguments: args, result: undefined, error: undefined, this: this });
      try {
        const result = implementation.apply(this, args);
        calls[calls.length - 1].result = result;
        return result;
      } catch (error) {
        calls[calls.length - 1].error = error;
        throw error;
      }
    };
    wrapped.mock = { calls, callCount: () => calls.length, resetCalls: () => { calls.length = 0; } };
    return wrapped;
  }

  method(object, methodName, implementation = object?.[methodName]) {
    const original = object[methodName];
    const wrapped = this.fn(implementation);
    object[methodName] = wrapped;
    this._restores.push(() => { object[methodName] = original; });
    return wrapped;
  }

  getter(object, propertyName, implementation) {
    const original = Object.getOwnPropertyDescriptor(object, propertyName);
    Object.defineProperty(object, propertyName, { get: this.fn(implementation), configurable: true });
    this._restores.push(() => original ? Object.defineProperty(object, propertyName, original) : delete object[propertyName]);
  }

  setter(object, propertyName, implementation) {
    const original = Object.getOwnPropertyDescriptor(object, propertyName);
    Object.defineProperty(object, propertyName, { set: this.fn(implementation), configurable: true });
    this._restores.push(() => original ? Object.defineProperty(object, propertyName, original) : delete object[propertyName]);
  }

  property(object, propertyName, value) {
    const original = Object.getOwnPropertyDescriptor(object, propertyName);
    Object.defineProperty(object, propertyName, { value, writable: true, configurable: true });
    this._restores.push(() => original ? Object.defineProperty(object, propertyName, original) : delete object[propertyName]);
  }

  reset() {
    this.restoreAll();
  }

  restoreAll() {
    for (const restore of this._restores.splice(0).reverse()) restore();
  }

  get timers() {
    return {
      enable() {},
      reset() {},
      tick() {},
    };
  }
}

export const mock = new MockTracker();

export const assert = {
  ...nodeAssert,
  register(name, fn) {
    this[name] = fn;
  },
};

export const snapshot = {
  _serializers: [],
  _resolveSnapshotPath: null,
  setDefaultSnapshotSerializers(serializers = []) {
    this._serializers = Array.from(serializers);
  },
  setResolveSnapshotPath(callback) {
    this._resolveSnapshotPath = callback;
  },
};

async function *runEvents(options = {}) {
  void options;
  for (const record of tests) {
    try {
      await execute(record);
    } catch {}
  }
  await runHookList(afterHooks);
  yield *events;
}

export function run(options = {}) {
  return Readable.from(runEvents(options));
}

Object.assign(test, {
  after,
  afterEach,
  assert,
  before,
  beforeEach,
  describe,
  it,
  mock,
  only,
  run,
  skip,
  snapshot,
  suite,
  test,
  todo,
});

export default test;
