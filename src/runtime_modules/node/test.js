import * as nodeAssert from "./assert.js";
import { AsyncLocalStorage } from "./async_hooks.js";
import { appendFileSync, readFileSync } from "./fs.js";
import { Readable } from "./stream.js";
import {
  captureTestRegistrationLine,
  junitReporterOptions,
  writeJunitReport,
} from "../internal/bun-test-junit.js";
import {
  appendGithubGroup,
  githubActionsEnabled,
  githubErrorAnnotation,
  githubTimeoutAnnotation,
} from "../internal/bun-test-github.js";
import { bunTestRuntimeOptions } from "../internal/bun-test-config.js";

const tests = [];
const events = [];
const Promise = globalThis.Promise;
const queueMicrotask = globalThis.queueMicrotask.bind(globalThis);
const runnerSetTimeout = globalThis.setTimeout;
const runnerClearTimeout = globalThis.clearTimeout;
const runnerSetInterval = globalThis.setInterval;
const runnerSetImmediate = globalThis.setImmediate;
const runnerQueueMicrotask = globalThis.queueMicrotask;
const runnerNextTick = globalThis.process?.nextTick?.bind(globalThis.process);
const runnerProcessCwd = typeof globalThis.process?.cwd === "function"
  ? globalThis.process.cwd.bind(globalThis.process)
  : () => ".";
const runnerPromiseThen = globalThis.Promise.prototype.then;
const runnerPromiseResolve = globalThis.Promise.resolve.bind(globalThis.Promise);
const runnerPromiseReject = globalThis.Promise.reject.bind(globalThis.Promise);
const runnerPromiseRace = globalThis.Promise.race.bind(globalThis.Promise);
const runnerPromiseAll = globalThis.Promise.all.bind(globalThis.Promise);
const runnerStderrWrite = globalThis.process?.stderr?.write?.bind(globalThis.process.stderr);
const runnerConsoleWarn = globalThis.console?.warn?.bind(globalThis.console);
const runnerConsoleError = globalThis.console?.error?.bind(globalThis.console);
const executionStorage = new AsyncLocalStorage();
const failureStorage = new AsyncLocalStorage();
const promiseOwners = new WeakMap();
let uncaughtCaptureInstalled = false;
let unhandledRejectionCaptureInstalled = false;
let asyncFailureGuardsInstalled = false;
let currentSuite;
let activeExecution = null;
let runScheduled = false;
let runnerActive = false;
let runAgain = false;
let afterTimer = null;
let finalizePromise = null;
let resultsReported = false;
let hasOnly = false;
let selectionDirty = true;

function runnerCwd() {
  try {
    return String(runnerProcessCwd());
  } catch {
    return ".";
  }
}
let defaultTimeout = 5000;
let passedTests = 0;
let failedTests = 0;
let skippedTests = 0;
let todoTests = 0;
let runnerErrors = 0;
let nextReportOrder = 0;
const failures = [];
const selectedRecords = new Set();

const testCliArgs = Array.from(globalThis.process?.argv ?? []).slice(2);
const testRuntimeOptions = bunTestRuntimeOptions(testCliArgs);
function testCliModeEnabled() {
  return globalThis.process?.env?.COTTONTAIL_TEST_CLI_HEADER_PRINTED === "1" ||
    globalThis.__cottontailBunTestHeaderPrinted === true;
}
const forceConcurrent = testRuntimeOptions.concurrent;
const runTodoTests = testRuntimeOptions.runTodo;
const dotsMode = testRuntimeOptions.reporters.dots;
const globalOnlyMode = testRuntimeOptions.only;
const passWithNoTests = testRuntimeOptions.passWithNoTests;
const junitOptions = junitReporterOptions(testRuntimeOptions);
const testFileCount = Math.max(1, Number(globalThis.process?.env?.COTTONTAIL_TEST_FILE_COUNT ?? 1) || 1);

function cliOption(name, fallback = undefined) {
  const equals = testCliArgs.find((arg) => String(arg).startsWith(`${name}=`));
  if (equals != null) return String(equals).slice(name.length + 1);
  const index = testCliArgs.indexOf(name);
  return index >= 0 ? testCliArgs[index + 1] : fallback;
}

const maxConcurrency = testRuntimeOptions.maxConcurrency;
defaultTimeout = testRuntimeOptions.timeout;
const onlyFailures = testRuntimeOptions.reporters.onlyFailures;
const runnerDateNow = Date.now.bind(Date);

const bailLimit = testRuntimeOptions.bail;
let bailReported = false;

function bailReached() {
  return failedTests + runnerErrors >= bailLimit;
}

function stopPendingTestsForBail() {
  if (!bailReached()) return;
  for (const record of tests) {
    if (record.ran) continue;
    record.ran = true;
    record.status = "filtered";
    record.resolve?.();
  }
}

function configuredTestNamePattern() {
  const source = testRuntimeOptions.namePattern;
  if (source == null) return null;
  return new RegExp(String(source));
}

const testNamePattern = configuredTestNamePattern();

let dotsLineHasMarkers = false;
let dotsDetailFile = "";

function testFileLabel(filePath = undefined) {
  let file = String(filePath ?? globalThis.process?.argv?.[1] ?? "test");
  const cwd = runnerCwd().replace(/[\\/]+$/, "");
  if (file.startsWith(`${cwd}/`) || file.startsWith(`${cwd}\\`)) file = file.slice(cwd.length + 1);
  return file.replace(/^\.[\\/]+/, "");
}

function dotsWrite(value) {
  const text = String(value);
  if (runnerStderrWrite) return runnerStderrWrite(text);
  return runnerConsoleError?.(text.replace(/\n$/, ""));
}

function prepareDotsDetail(filePath = undefined) {
  if (!dotsMode) return;
  const activeFile = filePath ?? currentExecution()?.record?.filePath;
  const label = testFileLabel(activeFile);
  if (dotsLineHasMarkers) dotsWrite("\n");
  if (label !== dotsDetailFile) {
    dotsWrite(dotsLineHasMarkers ? "\n" : dotsDetailFile ? "\n" : "");
    dotsWrite(`${label}:\n`);
    dotsDetailFile = label;
  }
  dotsLineHasMarkers = false;
}

function installDotsConsoleHooks() {
  if (!dotsMode || !globalThis.console) return;
  if (runnerConsoleWarn) {
    globalThis.console.warn = (...args) => {
      prepareDotsDetail();
      return runnerConsoleWarn(...args);
    };
  }
  if (runnerConsoleError) {
    globalThis.console.error = (...args) => {
      prepareDotsDetail();
      return runnerConsoleError(...args);
    };
  }
}

installDotsConsoleHooks();

function isTruthyEnvValue(value) {
  if (value == null) return false;
  const text = String(value).toLowerCase();
  return text !== "" && text !== "0" && text !== "false";
}

// Bun hides passing/skipped/todo lines (failures + summary only) when it
// detects an agent session: CLAUDECODE truthy while AGENT is not set at all.
// Setting AGENT (even to "false", as bun's test harness does) disables it.
const agentQuietMode = isTruthyEnvValue(globalThis.process?.env?.CLAUDECODE) &&
  globalThis.process?.env?.AGENT === undefined;

const defaultRetry = testRuntimeOptions.retry;
const rerunEach = testRuntimeOptions.rerunEach;
let completedRerunCount = 0;
const completedRuns = [];

function currentExecution() {
  const stored = executionStorage.getStore();
  if (stored?.kind !== "test" || stored.active !== false) return stored ?? activeExecution;
  return activeExecution?.active ? activeExecution : null;
}

function isNativePromise(value) {
  return value instanceof Promise || Object.prototype.toString.call(value) === "[object Promise]";
}

function promiseThen(value, onFulfilled, onRejected) {
  const promise = isNativePromise(value) ? value : runnerPromiseResolve(value);
  return runnerPromiseThen.call(promise, onFulfilled, onRejected);
}

function installUncaughtCapture() {
  if (uncaughtCaptureInstalled || typeof globalThis.process?.setUncaughtExceptionCaptureCallback !== "function") return;
  uncaughtCaptureInstalled = true;
  globalThis.process.setUncaughtExceptionCaptureCallback((error) => {
    const execution = executionStorage.getStore();
    if (execution?.failExternal) {
      execution.failExternal(error);
      return;
    }
    if (testCliModeEnabled()) {
      recordUnhandledError(error);
      scheduleAfterHooks();
      return;
    }
    globalThis.process.setUncaughtExceptionCaptureCallback(null);
    uncaughtCaptureInstalled = false;
    runnerSetTimeout(() => { throw error; }, 0);
  });
}

function installUnhandledRejectionCapture() {
  if (unhandledRejectionCaptureInstalled || typeof globalThis.process?.on !== "function") return;
  unhandledRejectionCaptureInstalled = true;
  globalThis.process.on("unhandledRejection", (reason, promise) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const owner = promise && typeof promise === "object" ? promiseOwners.get(promise) : null;
    if (owner?.kind === "test" && owner.active && typeof owner.failExternal === "function") {
      owner.failExternal(error);
      return;
    }
    if (owner && owner.kind !== "test" && typeof owner.failExternal === "function") {
      owner.failExternal(error);
      return;
    }
    const execution = currentExecution();
    if (execution?.kind === "test" && execution.active && typeof execution.failExternal === "function") {
      execution.failExternal(error);
      return;
    }
    recordUnhandledError(error);
  });
}

function guardAsyncCallback(callback, captureReturnedPromise = true, externalOnThrow = true, drainCurrentTurn = false) {
  const capturedExecution = failureStorage.getStore() ?? currentExecution();
  if (!capturedExecution || typeof callback !== "function") return callback;
  if (drainCurrentTurn && capturedExecution.kind === "test" && capturedExecution.active) {
    capturedExecution.needsPostBodyDrain = true;
  }
  return function guardedTestCallback(...args) {
    const execution = capturedExecution.kind === "test" && !capturedExecution.active
      ? currentExecution()
      : capturedExecution;
    try {
      const result = callback.apply(this, args);
      if (captureReturnedPromise && result && typeof result.then === "function" && execution) {
        promiseThen(result, undefined, execution.failExternal);
      }
      return result;
    } catch (error) {
      if (!externalOnThrow) throw error;
      if (execution?.failExternal) execution.failExternal(error);
      else recordUnhandledError(error);
      return undefined;
    }
  };
}

function copyTimerMetadata(wrapper, original) {
  // Preserve util.promisify(setTimeout) & friends: the promisify.custom symbol
  // lives on the original global timer functions and must survive wrapping.
  const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
  const custom = original?.[promisifyCustom];
  if (custom) Object.defineProperty(wrapper, promisifyCustom, { value: custom, configurable: true });
  return wrapper;
}

function installAsyncFailureGuards() {
  if (asyncFailureGuardsInstalled) return;
  asyncFailureGuardsInstalled = true;
  installUnhandledRejectionCapture();
  globalThis.setTimeout = copyTimerMetadata(
    (callback, ...args) => runnerSetTimeout(guardAsyncCallback(callback), ...args),
    runnerSetTimeout,
  );
  globalThis.setInterval = copyTimerMetadata(
    (callback, ...args) => runnerSetInterval(guardAsyncCallback(callback), ...args),
    runnerSetInterval,
  );
  if (typeof runnerSetImmediate === "function") {
    globalThis.setImmediate = copyTimerMetadata(
      (callback, ...args) => runnerSetImmediate(guardAsyncCallback(callback), ...args),
      runnerSetImmediate,
    );
  }
  globalThis.queueMicrotask = function queueMicrotask(callback) {
    if (typeof callback !== "function") {
      throw new TypeError('The "callback" argument must be of type function.');
    }
    const guarded = guardAsyncCallback(callback, true, true, true);
    return runnerQueueMicrotask(function runTestMicrotask() {
      globalThis.__cottontailBeforeMicrotask?.();
      return guarded();
    });
  };
  Object.defineProperty(globalThis.queueMicrotask, "name", { value: "queueMicrotask", configurable: true });
  if (runnerNextTick) {
    globalThis.process.nextTick = function nextTick(callback, ...args) {
      return runnerNextTick(guardAsyncCallback(callback, true, true, true), ...args);
    };
    Object.defineProperty(globalThis.process.nextTick, "name", { value: "nextTick", configurable: true });
  }
  globalThis.Promise.prototype.then = function testAwareThen(onFulfilled, onRejected) {
    const owner = failureStorage.getStore() ?? currentExecution();
    const result = runnerPromiseThen.call(
      this,
      guardAsyncCallback(onFulfilled, false, false),
      guardAsyncCallback(onRejected, false, false),
    );
    if (owner && result && typeof result === "object") promiseOwners.set(result, owner);
    return result;
  };
  globalThis.Promise.reject = function testAwareReject(reason) {
    const result = runnerPromiseReject(reason);
    const owner = failureStorage.getStore() ?? currentExecution();
    if (owner && result && typeof result === "object") {
      promiseOwners.set(result, owner);
      if (owner.kind === "test" && owner.active) owner.needsPostBodyDrain = true;
    }
    return result;
  };
  Object.defineProperty(globalThis.Promise.reject, "name", { value: "reject", configurable: true });
}

function createSuite(name, options = {}, parent = null) {
  const filePath = parent?.filePath || String(
    globalThis.__cottontailRegisteringTestFile ?? globalThis.__filename ?? "",
  );
  const directoryPath = parent?.filePath
    ? parent.directoryPath
    : String(globalThis.__dirname ?? "");
  return {
    kind: "suite",
    name,
    options,
    parent,
    children: [],
    beforeHooks: [],
    afterHooks: [],
    beforeEachHooks: [],
    afterEachHooks: [],
    beforeRan: false,
    afterRan: false,
    beforeError: null,
    preloadBeforeErrorFile: null,
    definitionError: null,
    definitionErrorReported: false,
    definitionFn: null,
    definitionState: parent ? "defined" : "root",
    filePath: parent ? filePath : "",
    directoryPath,
    registrationLine: Number(options.__bunRegistrationLine) || captureTestRegistrationLine(filePath),
  };
}

const rootSuite = createSuite("<root>");
currentSuite = rootSuite;

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

function makeTestContextAssert(record) {
  const base = nodeAssert.default ?? nodeAssert;
  const contextAssert = {};
  for (const [name, value] of Object.entries(base)) {
    if (name === "CallTracker" || name === "AssertionError" || name === "strict") continue;
    contextAssert[name] = value;
  }
  contextAssert.snapshot = (value, options = undefined) => {
    const expectation = globalThis.Bun?.jest?.(record.filePath)?.expect?.(value);
    if (!expectation?.toMatchSnapshot) throw new Error("Snapshot assertions require the test runner");
    const message = typeof options === "string" ? options : options?.message;
    return expectation.toMatchSnapshot(message);
  };
  contextAssert.fileSnapshot = (value, filename) => {
    const actual = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    nodeAssert.strictEqual(actual, String(readFileSync(filename, "utf8")));
  };
  return contextAssert;
}

function nestedTestNotImplemented(name) {
  const error = new Error(
    `${name}() inside another test() is not yet implemented in Bun. ` +
    "Track the status & thumbs up the issue: https://github.com/oven-sh/bun/issues/5090. " +
    "Use `bun:test` in the interim.",
  );
  error.name = "NotImplementedError";
  return error;
}

class TestContext {
  constructor(record) {
    this._record = record;
    this.name = record.name;
    this.fullName = fullTestName(record);
    this.filePath = record.filePath;
    this._abortController = new AbortController();
    this.signal = this._abortController.signal;
    this.mock = mock;
    this.assert = makeTestContextAssert(record);
  }

  test(name, options, fn) {
    const previousSuite = currentSuite;
    currentSuite = this._record?.suite ?? rootSuite;
    try {
      return test(name, options, fn);
    } finally {
      currentSuite = previousSuite;
    }
  }

  describe(name, options, fn) { return describe(name, options, fn); }
  before(fn, options = {}) { return before(fn, options); }
  after(fn, options = {}) { return after(fn, options); }
  beforeEach(fn, options = {}) { return beforeEach(fn, options); }
  afterEach(fn, options = {}) { return afterEach(fn, options); }

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

function timeoutFor(options = {}) {
  const value = Number(options.timeout ?? defaultTimeout);
  return Number.isFinite(value) && value >= 0 ? value : defaultTimeout;
}

function timeoutError(duration) {
  const error = new Error(`Test timed out after ${duration}ms`);
  error.code = "ERR_TEST_TIMEOUT";
  error.duration = duration;
  return error;
}

function withTimeout(callback, options = {}) {
  const duration = timeoutFor(options);
  if (duration === 0) return promiseThen(runnerPromiseResolve(), callback);
  // Bun's watchdog fails a test that overran an explicit timeout even when
  // the event loop was blocked (e.g. by spawnSync) so the timer never fired.
  const enforceElapsed = options.timeout != null;
  const startedAt = runnerDateNow();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = runnerSetTimeout(() => {
      if (settled) return;
      settled = true;
      reject(timeoutError(duration));
    }, duration);
    promiseThen(promiseThen(runnerPromiseResolve(), callback),
      (value) => {
        if (settled) return;
        settled = true;
        runnerClearTimeout(timer);
        if (enforceElapsed && runnerDateNow() - startedAt > duration) {
          reject(timeoutError(duration));
          return;
        }
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        runnerClearTimeout(timer);
        reject(error);
      },
    );
  });
}

function invokeDoneCallback(callback, thisValue, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error = undefined) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    try {
      const result = callback.apply(thisValue, [...args, done]);
      if (result && typeof result.then === "function") promiseThen(result, undefined, done);
    } catch (error) {
      done(error);
    }
  });
}

function invokeTestCallback(record, context) {
  const execution = executionStorage.getStore?.() ?? activeExecution;
  if (execution && record.options.timeout != null) {
    const duration = timeoutFor(record.options);
    if (duration > 0) execution.deadline = runnerDateNow() + duration;
  }
  return withTimeout(async () => {
    let value;
    if (typeof record.fn !== "function") value = undefined;
    else if (record.fn.length >= 2) value = await invokeDoneCallback(record.fn, undefined, [context]);
    else value = await record.fn(context);
    // Bun keeps a test alive until matcher-produced promises settle (e.g.
    // expect(asyncFn).toThrow() — issue #23865); they race the test timeout.
    while (execution?.pendingPromises?.length) {
      await runnerPromiseAll(execution.pendingPromises.splice(0));
    }
    return value;
  }, record.options);
}

function invokeHook(hook, context) {
  return withTimeout(() => {
    const target = { kind: "hook", failExternal: recordUnhandledError };
    return failureStorage.run(target, () => {
      let result;
      try {
        if (typeof hook.fn !== "function") result = undefined;
        else if (hook.fn.length >= 2) result = invokeDoneCallback(hook.fn, undefined, [context]);
        else result = hook.fn(context);
      } catch (error) {
        throw annotatePrimitiveError(error, context?.filePath ?? hook.filePath);
      }
      return promiseThen(
        runnerPromiseResolve(result),
        undefined,
        (error) => { throw annotatePrimitiveError(error, context?.filePath ?? hook.filePath); },
      );
    });
  }, hook.options);
}

async function runHookList(hooks, context, reverseLayers = false) {
  const orderedHooks = reverseLayers
    ? hooks.map((hook, index) => ({ hook, index })).sort((left, right) =>
      (Number(right.hook.layer ?? 0) - Number(left.hook.layer ?? 0)) || (left.index - right.index),
    ).map(({ hook }) => hook)
    : hooks;
  for (const hook of orderedHooks) {
    try {
      await invokeHook(hook, context);
    } catch (error) {
      return error;
    }
  }
  return null;
}

function tagPerTestHookError(error) {
  if (error === null) return null;
  if ((typeof error === "object" || typeof error === "function") &&
      Object.prototype.hasOwnProperty.call(error, "__cottontailBunPrimitiveError")) {
    const wrapped = new Error(String(error.__cottontailBunPrimitiveError));
    wrapped.code = "ERR_BUN_TEST_CALLBACK_FAILURES";
    wrapped.errors = [error.__cottontailBunPrimitiveError];
    return wrapped;
  }
  if (typeof error !== "object" && typeof error !== "function") {
    const wrapped = new Error(String(error));
    wrapped.code = "ERR_BUN_TEST_CALLBACK_FAILURES";
    wrapped.errors = [error];
    return wrapped;
  }
  try {
    Object.defineProperty(error, "__cottontailBunPerTestHook", { value: true, configurable: true });
  } catch {}
  return error;
}

function suiteChain(suite) {
  const chain = [];
  for (let cursor = suite; cursor; cursor = cursor.parent) chain.push(cursor);
  return chain.reverse();
}

function inheritedOption(record, name) {
  if (record.options[name]) return record.options[name];
  for (let suite = record.suite; suite; suite = suite.parent) {
    if (suite.options[name]) return suite.options[name];
  }
  return false;
}

function nodeHasOnly(node) {
  if (node.options?.only) return true;
  return node.kind === "suite" && node.children.some(nodeHasOnly);
}

function nodeHasBunOnly(node) {
  if (node.options?.only && node.options?.__bunTest) return true;
  return node.kind === "suite" && node.children.some(nodeHasBunOnly);
}

function rebuildSelection() {
  selectedRecords.clear();
  const visitChildren = (children, branchSelected, respectOnly) => {
    const onlyChildren = respectOnly ? children.filter(nodeHasOnly) : [];
    const selectedChildren = onlyChildren.length > 0
      ? onlyChildren
      : branchSelected ? children : [];
    for (const child of selectedChildren) {
      if (child.kind === "suite") visit(child, branchSelected || Boolean(child.options.only), respectOnly);
      else selectedRecords.add(child);
    }
  };
  const visit = (suite, branchSelected, respectOnly) =>
    visitChildren(suite.children, branchSelected || Boolean(suite.options.only), respectOnly);

  if (globalOnlyMode) {
    visit(rootSuite, !hasOnly, true);
  } else {
    const byFile = new Map();
    for (const child of rootSuite.children) {
      const file = child.filePath ?? "";
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(child);
    }
    for (const children of byFile.values()) {
      const respectOnly = children.some(nodeHasBunOnly);
      visitChildren(children, !respectOnly, respectOnly);
    }
  }
  selectionDirty = false;
}

function selectedByOnly(record) {
  if (selectionDirty) rebuildSelection();
  return selectedRecords.has(record) && (!testNamePattern || testNamePattern.test(fullTestName(record)));
}

function recordIsRunnable(record) {
  return !record.ran && selectedByOnly(record) && !inheritedOption(record, "skip") && !inheritedOption(record, "todo");
}

function hasPendingSuiteDefinitions(suite = rootSuite) {
  return suite.children.some((child) => child.kind === "suite" && (
    child.definitionState === "pending" || hasPendingSuiteDefinitions(child)
  ));
}

function discardSuiteTests(suite) {
  for (const child of suite.children) {
    if (child.kind === "suite") {
      child.definitionState = child.definitionState === "pending" ? "discarded" : child.definitionState;
      discardSuiteTests(child);
      continue;
    }
    if (child.ran) continue;
    child.ran = true;
    child.status = "filtered";
    child.resolve?.();
  }
}

async function defineDeferredSuite(suite) {
  if (suite.definitionState !== "pending") return suite.definitionError;
  suite.definitionState = "running";
  const previousSuite = currentSuite;
  const previousFile = globalThis.__filename;
  const previousDirectory = globalThis.__dirname;
  const previousRegisteringFile = globalThis.__cottontailRegisteringTestFile;
  currentSuite = suite;
  if (suite.filePath) {
    globalThis.__filename = suite.filePath;
    globalThis.__cottontailRegisteringTestFile = suite.filePath;
  }
  if (suite.directoryPath) globalThis.__dirname = suite.directoryPath;
  emit("test:suite:start", { name: suite.name });
  try {
    let rejectExternal;
    const failure = new Promise((_, reject) => { rejectExternal = reject; });
    const target = { kind: "describe", failExternal: rejectExternal };
    const result = failureStorage.run(
      target,
      () => typeof suite.definitionFn === "function" ? suite.definitionFn() : undefined,
    );
    await runnerPromiseRace([runnerPromiseResolve(result), failure]);
    suite.definitionState = "defined";
  } catch (error) {
    suite.definitionError = annotatePrimitiveError(error, suite.filePath);
    suite.definitionState = "failed";
    suite.definitionErrorReported = true;
    discardSuiteTests(suite);
    recordUnhandledError(suite.definitionError);
  } finally {
    emit("test:suite:finish", { name: suite.name });
    currentSuite = previousSuite;
    if (previousFile === undefined) delete globalThis.__filename;
    else globalThis.__filename = previousFile;
    if (previousDirectory === undefined) delete globalThis.__dirname;
    else globalThis.__dirname = previousDirectory;
    if (previousRegisteringFile === undefined) delete globalThis.__cottontailRegisteringTestFile;
    else globalThis.__cottontailRegisteringTestFile = previousRegisteringFile;
  }
  if (suite.definitionState === "failed") return suite.definitionError;
  for (let index = 0; index < suite.children.length; index += 1) {
    const child = suite.children[index];
    if (child.kind === "suite") await defineDeferredSuite(child);
  }
  return null;
}

async function defineDeferredSuites() {
  for (let index = 0; index < rootSuite.children.length; index += 1) {
    const child = rootSuite.children[index];
    if (child.kind === "suite") await defineDeferredSuite(child);
  }
}

function suiteHasRunnableTest(suite) {
  return suite.children.some((child) => child.kind === "suite" ? suiteHasRunnableTest(child) : recordIsRunnable(child));
}

function suiteHasRunnableWork(suite) {
  for (let cursor = suite; cursor; cursor = cursor.parent) {
    if (cursor.options.skip || cursor.options.todo) return false;
  }
  return suiteHasRunnableTest(suite);
}

function suiteHasLifecycleWork(suite) {
  for (let cursor = suite; cursor; cursor = cursor.parent) {
    if (cursor.options.skip || cursor.options.todo) return false;
  }
  if (suite.beforeHooks.length > 0 || suite.afterHooks.length > 0 ||
      suite.beforeEachHooks.length > 0 || suite.afterEachHooks.length > 0) return true;
  return suite.children.some((child) => child.kind === "suite" && suiteHasLifecycleWork(child));
}

function suiteBeforeError(suite) {
  for (const item of suiteChain(suite)) {
    if (item.beforeError) return item.beforeError;
  }
  return null;
}

function failingTestPassedError() {
  const error = new nodeAssert.AssertionError({
    message: "this test is marked as failing but it passed. Remove `.failing` if tested behavior now works",
  });
  error.code = "ERR_TEST_FAILING_PASSED";
  return error;
}

function todoTestPassedError() {
  const error = new nodeAssert.AssertionError({ message: "this test is marked as todo but passes" });
  error.code = "ERR_TEST_TODO_PASSED";
  return error;
}

function recordIsConcurrent(record) {
  if (record.options.serial) return false;
  return forceConcurrent || Boolean(inheritedOption(record, "concurrent"));
}

function drainPostBodyTurn(execution) {
  if (!execution.needsPostBodyDrain) return runnerPromiseResolve();
  execution.needsPostBodyDrain = false;
  return new Promise((resolve) => {
    if (typeof runnerSetImmediate === "function") runnerSetImmediate(resolve);
    else runnerSetTimeout(resolve, 0);
  });
}

function bunAsyncCallbackFailure(record, error) {
  if (!record.options?.__bunTest || error instanceof Error || error?.code === "ERR_BUN_TEST_CALLBACK_FAILURES") {
    return error;
  }
  const wrapped = new Error(String(error));
  wrapped.code = "ERR_BUN_TEST_CALLBACK_FAILURES";
  wrapped.errors = [error];
  return wrapped;
}

function reapDanglingProcesses(execution) {
  let killed = Number(execution.danglingKilled ?? 0);
  for (const proc of execution.subprocesses ?? []) {
    try {
      if (proc.killed || proc.exitCode != null) continue;
      proc.kill(9);
      killed += 1;
    } catch {}
  }
  execution.subprocesses?.clear?.();
  execution.danglingKilled = 0;
  if (killed > 0) {
    console.error(`killed ${killed} dangling process${killed === 1 ? "" : "es"}`);
  }
}

async function executeAttempt(record) {
  const context = new TestContext(record);
  const execution = {
    kind: "test",
    active: true,
    record,
    afterBodyHooks: [],
    afterEachHooks: [],
    finishHooks: [],
  };
  return executionStorage.run(execution, async () => {
    activeExecution = execution;
    const externalFailure = new Promise((_, reject) => {
      execution.failExternal = (error) => {
        const normalized = bunAsyncCallbackFailure(record, error);
        (execution.externalErrors ??= []).push(normalized);
        reject(normalized);
      };
    });

    const chain = suiteChain(record.suite);
    const beforeAllError = suiteBeforeError(record.suite);
    let setupError = beforeAllError;
    let bodyError = null;
    let cleanupError = null;
    try {
      if (!setupError) {
        for (const suite of chain) {
          const error = tagPerTestHookError(await runHookList(suite.beforeEachHooks, context));
          setupError ??= error;
          if (error) break;
        }
      }
      if (!setupError) {
        try {
          await runnerPromiseRace([invokeTestCallback(record, context), externalFailure]);
          await drainPostBodyTurn(execution);
          if (execution.externalErrors?.length) throw execution.externalErrors[0];
        } catch (error) {
          bodyError = annotatePrimitiveError(error, record.filePath);
        }
        // Like bun, a timed-out test kills subprocesses it left running.
        if (bodyError?.code === "ERR_TEST_TIMEOUT") reapDanglingProcesses(execution);
      }

      if (!beforeAllError) {
        const afterBodyError = await runHookList(execution.afterBodyHooks, context);
        cleanupError ??= afterBodyError;
        const dynamicAfterEachError = tagPerTestHookError(await runHookList(execution.afterEachHooks, context));
        cleanupError ??= dynamicAfterEachError;
        for (const suite of Array.from(chain).reverse()) {
          const afterEachError = tagPerTestHookError(await runHookList(suite.afterEachHooks, context, true));
          cleanupError ??= afterEachError;
        }
      }
      const finishError = await runHookList(execution.finishHooks, context);
      cleanupError ??= finishError;
    } finally {
      execution.active = false;
      if (activeExecution === execution) activeExecution = null;
    }

    if (record.options.failing && !setupError) {
      if (bodyError && bodyError.code !== "ERR_TEST_TIMEOUT" && bodyError.code !== "ERR_BUN_EXPECT_ASSERTIONS") bodyError = null;
      else if (!bodyError) bodyError = failingTestPassedError();
    }
    return setupError ?? bodyError ?? cleanupError;
  });
}

globalThis.__cottontailRecordTestAssertionCount = (count) => {
  const execution = executionStorage.getStore?.() ?? activeExecution;
  if (!execution?.record) return;
  (execution.record.attemptAssertionCounts ??= []).push(Math.max(0, Number(count) || 0));
};

function attemptCount(record) {
  if (record.options.repeats != null) return Number(record.options.repeats) + 1;
  if (record.options.retry != null) return Number(record.options.retry) + 1;
  if (defaultRetry > 0) return defaultRetry + 1;
  return 1;
}

async function execute(record) {
  if (record.ran) return record.result;
  record.ran = true;
  record.reportOrder = nextReportOrder++;
  globalThis.__cottontailBeginNextTickTurn?.();
  if (globalThis.process?.env?.COTTONTAIL_TEST_DEBUG === "1") console.error(`test:start ${record.name}`);
  emit("test:start", { name: record.name });

  if (!selectedByOnly(record)) {
    record.status = "filtered";
    record.resolve?.();
    return undefined;
  }
  if (rootSuite.preloadBeforeErrorFile === record.filePath) {
    record.status = "filtered";
    record.resolve?.();
    return undefined;
  }
  const skipReason = inheritedOption(record, "skip");
  const todoReason = inheritedOption(record, "todo");
  if (skipReason || (todoReason && (!runTodoTests || typeof record.fn !== "function"))) {
    const data = { name: record.name };
    if (todoReason) {
      data.todo = todoReason === true ? "todo" : todoReason;
      record.status = "todo";
      todoTests += 1;
    } else {
      data.skip = skipReason === true ? "skipped" : skipReason;
      record.status = "skip";
      skippedTests += 1;
    }
    emit("test:pass", data);
    emitDotsRecord(record);
    record.resolve?.();
    return undefined;
  }
  const started = performance?.now?.() ?? Date.now();
  let error = null;
  const totalAttempts = attemptCount(record);
  const retryMode = record.options.repeats == null;
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const attemptStarted = performance?.now?.() ?? Date.now();
    error = await executeAttempt(record);
    (record.attemptDurationsMs ??= []).push((performance?.now?.() ?? Date.now()) - attemptStarted);
    record.attempts = attempt + 1;
    if (retryMode && error) (record.attemptErrors ??= []).push(error);
    if (record.options.repeats != null) {
      if (error) break;
    } else if (!error) {
      break;
    }
  }

  if (todoReason) {
    if (error) {
      todoTests += 1;
      record.status = "todo";
      record.todoError = error;
      emit("test:pass", { name: record.name, todo: todoReason === true ? "todo" : todoReason });
      emitDotsRecord(record);
      record.resolve?.();
      return undefined;
    }
    error = todoTestPassedError();
  }

  const duration_ms = (performance?.now?.() ?? Date.now()) - started;
  record.durationMs = duration_ms;
  if (error) {
    if (error.code === "ERR_TEST_SKIP" || error.code === "ERR_TEST_TODO") {
      record.status = error.code === "ERR_TEST_SKIP" ? "skip" : "todo";
      if (record.status === "skip") skippedTests += 1;
      else todoTests += 1;
      emit("test:pass", { name: record.name, [record.status]: error.message });
      emitDotsRecord(record);
      record.resolve?.();
      return undefined;
    }
    failedTests += 1;
    failures.push({ record, error });
    record.status = "fail";
    record.error = error;
    emit("test:fail", { name: record.name, error, duration_ms });
    emitDotsRecord(record);
    record.reject?.(error);
    if (globalThis.process?.env?.COTTONTAIL_TEST_DEBUG === "1") console.error(`test:fail ${record.name}: ${error?.stack || error?.message || error}`);
    return undefined;
  }
  passedTests += 1;
  record.status = "pass";
  emit("test:pass", { name: record.name, duration_ms });
  emitDotsRecord(record);
  record.resolve?.();
  if (globalThis.process?.env?.COTTONTAIL_TEST_DEBUG === "1") console.error(`test:pass ${record.name}`);
}

function recordHookFailure(name, error, isRunnerError = false, filePath = undefined) {
  const record = {
    name,
    status: isRunnerError ? "error" : "fail",
    suite: currentSuite,
    filePath: String(filePath ?? currentSuite?.filePath ?? ""),
    reportOrder: nextReportOrder++,
  };
  if (isRunnerError) runnerErrors += 1;
  else failedTests += 1;
  failures.push({ record, error });
  emit("test:fail", { name, error });
  emitDotsRecord(record, error);
}

function recordUnhandledError(error) {
  const record = {
    name: "Unhandled error between tests",
    status: "error",
    suite: rootSuite,
    unhandledBetweenTests: true,
    reportOrder: nextReportOrder++,
  };
  runnerErrors += 1;
  failures.push({ record, error });
  emit("test:fail", { name: record.name, error });
  emitDotsRecord(record, error);
}

// Bun installs its test-runner rejection handlers before loading each test
// entrypoint, so module-scope failures use the same reporter as test failures.
if (testCliModeEnabled()) {
  installUncaughtCapture();
  installUnhandledRejectionCapture();
}

async function runConcurrentRecords(records) {
  const batchSize = Number.isFinite(maxConcurrency)
    ? Math.max(1, maxConcurrency)
    : Math.max(1, records.length);
  let cursor = 0;
  while (cursor < records.length && !bailReached()) {
    const batch = [];
    while (cursor < records.length && batch.length < batchSize) {
      batch.push(execute(records[cursor++]));
    }
    await runnerPromiseAll(batch);
  }
}

async function flushConcurrent(group) {
  if (group.length === 0) return;
  const records = group.splice(0);
  await runConcurrentRecords(records);
}

async function executeSuite(suite, concurrentGroup) {
  if (bailReached()) return;
  if (suite.definitionError && !suite.definitionErrorReported) {
    await flushConcurrent(concurrentGroup);
    suite.definitionErrorReported = true;
    recordHookFailure(suite.name, suite.definitionError, !(suite.definitionError instanceof TypeError));
  }

  const hasRunnableWork = suiteHasRunnableWork(suite);
  const runnable = hasRunnableWork || suiteHasLifecycleWork(suite);
  const shouldRunBefore = runnable && !suite.beforeRan && (suite !== rootSuite || hasRunnableWork);
  if (shouldRunBefore) {
    if (suite.beforeHooks.length > 0) await flushConcurrent(concurrentGroup);
    suite.beforeRan = true;
    suite.beforeError = await runHookList(suite.beforeHooks, new TestContext({ name: suite.name }));
    if (suite === rootSuite && suite.beforeError) {
      const firstRecord = tests.find((record) => !record.ran && recordIsRunnable(record));
      suite.preloadBeforeErrorFile = firstRecord?.filePath ?? null;
      recordHookFailure("(unnamed)", suite.beforeError, false, suite.preloadBeforeErrorFile);
      suite.beforeError = null;
    }
  }

  for (const child of suite.children) {
    if (bailReached()) break;
    if (child.kind === "suite") {
      await executeSuite(child, concurrentGroup);
    } else if (!child.ran) {
      if (recordIsConcurrent(child)) concurrentGroup.push(child);
      else {
        await flushConcurrent(concurrentGroup);
        await execute(child);
      }
    }
  }

  if (suite !== rootSuite && suite.beforeRan && !suite.afterRan) {
    if (suite.afterHooks.length > 0) await flushConcurrent(concurrentGroup);
    suite.afterRan = true;
    const error = await runHookList(suite.afterHooks, new TestContext({ name: suite.name }), true);
    if (error) recordHookFailure(suite.name, error);
  }
}

function hasPendingTests() {
  return tests.some((record) => !record.ran);
}

function formatFailure(error) {
  return String(error?.message ?? error ?? "Test failed");
}

function annotatePrimitiveError(error, filePath) {
  if (error instanceof Error || !filePath) return error;
  const message = String(error);
  const sourceLines = sourceLinesFor(filePath);
  if (!sourceLines) return error;
  let lineNumber = -1;
  let column = 1;
  for (let index = 0; index < sourceLines.length; index += 1) {
    const messageIndex = sourceLines[index].indexOf(message);
    if (messageIndex < 0 || !sourceLines[index].includes("throw")) continue;
    lineNumber = index + 1;
    column = Math.max(1, messageIndex);
    break;
  }
  if (lineNumber < 0) return error;
  const wrapped = new Error(message);
  wrapped.stack = `Error: ${message}\n<anonymous>@${filePath}:${lineNumber}:${column}`;
  Object.defineProperty(wrapped, "__cottontailBunPrimitiveError", {
    value: error,
    configurable: true,
  });
  return wrapped;
}

const sourceLineCache = new Map();

function normalizeDiagnosticPath(value) {
  let path = String(value ?? "").replaceAll("\\", "/");
  if (path.startsWith("file://")) {
    path = path.slice("file://".length);
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  }
  return path.replace(/[?#].*$/, "");
}

function parseStackFrame(line) {
  const text = String(line ?? "");
  let match = /^(.*?)@(.+):(\d+):(\d+)$/.exec(text);
  if (match) {
    return {
      functionName: match[1] || "<anonymous>",
      filePath: normalizeDiagnosticPath(match[2]),
      line: Number(match[3]),
      column: Number(match[4]),
    };
  }
  match = /^\s*at\s+(?:(.*?)\s+\()?(.+):(\d+):(\d+)\)?$/.exec(text);
  if (!match) return null;
  return {
    functionName: match[1] || "<anonymous>",
    filePath: normalizeDiagnosticPath(match[2]),
    line: Number(match[3]),
    column: Number(match[4]),
  };
}

function failureStackFrames(error) {
  let stack;
  try {
    stack = typeof error?.stack === "string" ? error.stack : "";
  } catch {
    stack = "";
  }
  if (!stack) return [];
  try {
    stack = globalThis.__cottontailRemapStackString?.(stack) ?? stack;
  } catch {}
  const frames = [];
  for (const line of String(stack).split("\n")) {
    const frame = parseStackFrame(line);
    if (!frame) continue;
    const path = frame.filePath;
    if (!path || path.includes("/.cottontail-embedded-runtime/") ||
        path.includes("/.cottontail-tmp/") || path.endsWith("/script.bundle.mjs")) continue;
    frames.push(frame);
  }
  for (const frame of error?.__cottontailBunAsyncParentFrames ?? []) {
    if (!frame?.filePath || !Number.isFinite(frame.line) || !Number.isFinite(frame.column)) continue;
    if (frames.some((candidate) => candidate.filePath === frame.filePath &&
        candidate.line === frame.line && candidate.column === frame.column)) continue;
    frames.push({
      functionName: frame.functionName || "<anonymous>",
      filePath: normalizeDiagnosticPath(frame.filePath),
      line: Number(frame.line),
      column: Number(frame.column),
    });
  }
  return frames.map(normalizeConstructedErrorFrame);
}

function sourceLinesFor(path) {
  if (sourceLineCache.has(path)) return sourceLineCache.get(path);
  let lines = null;
  try {
    lines = String(readFileSync(path, "utf8")).split(/\r?\n/);
  } catch {}
  if (!lines) {
    try {
      lines = globalThis.__cottontailSourceContextForLocation?.(path, 1, 1)?.lines ?? null;
    } catch {}
  }
  sourceLineCache.set(path, lines);
  return lines;
}

function normalizeConstructedErrorFrame(frame) {
  const sourceLine = sourceLinesFor(frame.filePath)?.[frame.line - 1];
  if (!sourceLine || !/\bnew\s+(?:Error|[A-Za-z_$][\w$]*Error)\s*\(/.test(sourceLine)) return frame;
  const closingParen = sourceLine.lastIndexOf(")");
  return closingParen < 0 ? frame : { ...frame, column: closingParen + 1 };
}

function durationSuffix(durationMs) {
  const duration = Number(durationMs);
  return Number.isFinite(duration) && duration >= 10 ? ` [${duration.toFixed(2)}ms]` : "";
}

function appendSourceFrame(lines, frame) {
  const sourceLines = sourceLinesFor(frame.filePath);
  if (!sourceLines || frame.line < 1 || frame.line > sourceLines.length) return;
  const start = Math.max(1, frame.line - 5);
  const width = String(frame.line).length;
  for (let lineNumber = start; lineNumber <= frame.line; lineNumber += 1) {
    lines.push(`${String(lineNumber).padStart(width)} | ${sourceLines[lineNumber - 1]}`);
  }
  const sourceLine = sourceLines[frame.line - 1];
  let column = Math.max(1, Math.min(Number(frame.column) || 1, sourceLine.length + 1));
  if (/\bnew\s+(?:Error|[A-Za-z_$][\w$]*Error)\s*\(/.test(sourceLine)) {
    const closingParen = sourceLine.lastIndexOf(")");
    if (closingParen >= 0) column = closingParen + 1;
  }
  lines.push(`${" ".repeat(width + 3 + column - 1)}^`);
}

function appendErrorDiagnostic(lines, error) {
  if (error?.code === "ERR_BUN_TEST_CALLBACK_FAILURES" && Array.isArray(error.errors)) {
    for (const item of error.errors) {
      appendErrorDiagnostic(lines, item);
      if (!(item instanceof Error)) lines.push(String(item));
    }
    return;
  }
  if (error?.code === "ERR_BUN_EXPECT_ASSERTIONS") {
    lines.push(`AssertionError: ${formatFailure(error)}`);
    return;
  }
  let frames = failureStackFrames(error);
  if (error?.__cottontailBunExpectation && error.__cottontailBunCallSite) {
    frames = [error.__cottontailBunCallSite];
  }
  if (frames.length > 0) appendSourceFrame(lines, frames[0]);
  const annotation = githubErrorAnnotation(error, frames, formatFailure(error));
  if (annotation) lines.push(annotation);
  lines.push(`error: ${formatFailure(error)}`);
  for (const frame of frames.slice(0, 5)) {
    const functionName = frame.functionName === "@" ? "<anonymous>" : frame.functionName;
    if (error?.__cottontailBunExpectation) {
      if (!formatFailure(error).endsWith("\n")) lines.push("");
      lines.push(`      at ${functionName} (${frame.filePath}:${frame.line}:${frame.column})`);
    } else if (error?.__cottontailBunPerTestHook) {
      lines.push(`      at ${functionName} (${frame.filePath}:${frame.line}:${frame.column})`);
    } else {
      lines.push(`    at ${functionName} (${frame.filePath}:${frame.line}:${frame.column})`);
    }
  }
}

function fullTestName(record) {
  const names = [];
  for (const suite of suiteChain(record.suite)) {
    if (suite !== rootSuite && suite.name) names.push(suite.name);
  }
  if (record.name && record.name !== "<root>") names.push(record.name);
  return names.join(" > ") || record.name || "test runner";
}

globalThis.__cottontailCurrentTestName = () => {
  const execution = executionStorage.getStore?.();
  return execution?.record ? fullTestName(execution.record) : "";
};

globalThis.__cottontailCurrentTestToken = () => {
  const execution = executionStorage.getStore?.() ?? activeExecution;
  return execution?.record;
};

globalThis.__cottontailCurrentTestFile = () => {
  const execution = executionStorage.getStore?.() ?? activeExecution;
  return execution?.record?.filePath ?? "";
};

globalThis.__cottontailCurrentTestIsConcurrent = () => {
  const execution = executionStorage.getStore?.() ?? activeExecution;
  return Boolean(execution?.record && recordIsConcurrent(execution.record));
};

globalThis.__cottontailCurrentTestHasOwnConcurrency = () => {
  const execution = executionStorage.getStore?.() ?? activeExecution;
  return Boolean(execution?.record?.options?.concurrent);
};

// Registers a promise the currently-running test must wait for before it can
// complete (subject to its timeout). Returns true when a test is active.
globalThis.__cottontailRegisterTestPendingPromise = (promise) => {
  const execution = executionStorage.getStore?.() ?? activeExecution;
  if (!execution) return false;
  (execution.pendingPromises ??= []).push(promise);
  return true;
};

// Track subprocesses spawned inside a test so a timeout can kill the ones
// still running ("killed N dangling process(es)"), matching bun.
globalThis.__cottontailRegisterTestSubprocess = (proc) => {
  const execution = executionStorage.getStore?.() ?? activeExecution;
  if (!execution || !proc || typeof proc !== "object") return false;
  const subprocesses = execution.subprocesses ??= new Set();
  subprocesses.add(proc);
  if (typeof proc.exited?.then === "function") {
    promiseThen(proc.exited, () => subprocesses.delete(proc), () => subprocesses.delete(proc));
  }
  return true;
};

// A blocking child that had to be SIGKILLed at the test deadline counts as a
// dangling process killed by the timeout.
globalThis.__cottontailNoteDanglingProcessKilled = () => {
  const execution = executionStorage.getStore?.() ?? activeExecution;
  if (!execution) return false;
  execution.danglingKilled = Number(execution.danglingKilled ?? 0) + 1;
  return true;
};

// Milliseconds left before the current test's explicit timeout, or null when
// no explicit per-test timeout is active.
globalThis.__cottontailCurrentTestRemainingMs = () => {
  const execution = executionStorage.getStore?.() ?? activeExecution;
  if (!execution || execution.deadline == null) return null;
  return Math.max(0, execution.deadline - runnerDateNow());
};

function appendFailure(lines, record, error) {
  if (record.unhandledBetweenTests) {
    lines.push("");
    lines.push("# Unhandled error between tests");
    lines.push("-------------------------------");
    appendErrorDiagnostic(lines, error);
    lines.push("-------------------------------");
    lines.push("");
    return;
  }
  const name = fullTestName(record);
  if (error?.code === "ERR_TEST_FAILING_PASSED") {
    lines.push(`(fail) ${name}${durationSuffix(record.durationMs)}`);
    lines.push(`  ^ ${formatFailure(error)}`);
    return;
  }
  if (error?.code === "ERR_TEST_TIMEOUT") {
    // Match `bun test` output for timeouts (no leading "error:" line).
    const duration = error.duration ?? timeoutFor(record.options ?? {});
    const annotation = githubTimeoutAnnotation(name, duration);
    if (annotation) lines.push(annotation);
    lines.push(`(fail) ${name}`);
    lines.push(record.options?.__bunUsesDoneCallback
      ? `  ^ this test timed out after ${duration}ms, before its done callback was called. ` +
        "If a done callback was not intended, remove the last parameter from the test callback function"
      : `  ^ this test timed out after ${duration}ms.`);
    return;
  }
  appendErrorDiagnostic(lines, error);
  lines.push(`(fail) ${name}${durationSuffix(record.durationMs)}`);
}

function appendFailureSummary(lines, view) {
  const name = fullTestName(view.record);
  lines.push(`(fail) ${name}`);
  if (view.error?.code === "ERR_TEST_FAILING_PASSED") {
    lines.push(`  ^ ${formatFailure(view.error)}`);
  } else if (view.error?.code === "ERR_TEST_TIMEOUT") {
    const duration = view.error.duration ?? timeoutFor(view.record.options ?? {});
    const annotation = githubTimeoutAnnotation(name, duration);
    if (annotation) lines.push(annotation);
    lines.push(view.record.options?.__bunUsesDoneCallback
      ? `  ^ this test timed out after ${duration}ms, before its done callback was called. ` +
        "If a done callback was not intended, remove the last parameter from the test callback function"
      : `  ^ this test timed out after ${duration}ms.`);
  }
}

function emitDotsRecord(record, error = record?.error) {
  if (!dotsMode || !record || record.dotsReported || record.status === "filtered") return;
  record.dotsReported = true;
  if (record.status === "pass" || record.status === "skip" || record.status === "todo") {
    dotsWrite(".");
    dotsLineHasMarkers = true;
    return;
  }
  prepareDotsDetail(record.filePath);
  const lines = [];
  appendFailure(lines, record, error);
  dotsWrite(`${lines.join("\n")}\n`);
}

function snapshotRecordView(record) {
  return {
    record,
    reportOrder: record.reportOrder,
    status: record.status,
    error: record.error,
    todoError: record.todoError,
    attempts: record.attempts,
    attemptErrors: record.attemptErrors,
  };
}

function appendRunRecords(lines, views, extraFailures = []) {
  const suppressPassing = onlyFailures || agentQuietMode;
  const entries = [
    ...views.map((view) => ({ kind: "view", order: view.reportOrder ?? Infinity, view })),
    ...extraFailures.map((failure) => ({
      kind: "failure",
      order: failure.record.reportOrder ?? Infinity,
      failure,
    })),
  ].sort((left, right) => left.order - right.order);
  for (const entry of entries) {
    if (entry.kind === "failure") {
      appendFailure(lines, entry.failure.record, entry.failure.error);
      continue;
    }
    const view = entry.view;
    if (view.status === "pass") {
      // Failed retry attempts print their errors even though the test passed.
      for (const attemptError of view.attemptErrors ?? []) {
        appendErrorDiagnostic(lines, attemptError);
      }
      if (!suppressPassing) {
        const retried = (view.attempts ?? 1) > 1 && view.record.options?.repeats == null;
        const suffix = retried ? ` (attempt ${view.attempts})` : "";
        lines.push(`(pass) ${fullTestName(view.record)}${suffix}${durationSuffix(view.record.durationMs)}`);
      }
    } else if (view.status === "fail") {
      for (const attemptError of (view.attemptErrors ?? []).slice(0, -1)) {
        appendErrorDiagnostic(lines, attemptError);
      }
      appendFailure(lines, view.record, view.error);
    } else if (!suppressPassing) {
      if (view.status === "todo" && view.todoError) appendErrorDiagnostic(lines, view.todoError);
      lines.push(`(${view.status}) ${fullTestName(view.record)}`);
    }
  }
}

function displayTestFile(filePath = undefined) {
  let file = String(filePath ?? globalThis.process?.argv?.[1] ?? "test").replaceAll("\\", "/");
  const cwd = runnerCwd().replaceAll("\\", "/").replace(/[\/]+$/, "");
  if (file.startsWith(`${cwd}/`)) file = file.slice(cwd.length + 1);
  return file.replace(/^\.\//, "");
}

function appendRunFileGroups(lines, views, extraFailures, runIndex, runCount) {
  const groups = new Map();
  const knownFiles = Array.isArray(globalThis.__cottontailTestFiles)
    ? globalThis.__cottontailTestFiles.map(displayTestFile)
    : [];
  const knownFileOrder = new Map(knownFiles.map((file, index) => [file, index]));
  const groupFor = (record) => {
    const file = displayTestFile(record?.filePath);
    let group = groups.get(file);
    if (!group) {
      group = {
        file,
        views: [],
        failures: [],
        order: knownFileOrder.get(file) ?? record?.reportOrder ?? Infinity,
      };
      groups.set(file, group);
    }
    group.order = Math.min(group.order, knownFileOrder.get(file) ?? record?.reportOrder ?? Infinity);
    return group;
  };

  for (const view of views) groupFor(view.record).views.push(view);
  for (const failure of extraFailures) groupFor(failure.record).failures.push(failure);
  knownFiles.forEach((file, index) => groupFor({ filePath: file, reportOrder: index }));
  if (groups.size === 0) {
    for (const record of tests) groupFor(record);
  }

  const ordered = [...groups.values()].sort((left, right) => left.order - right.order);
  if (ordered.length === 0) {
    ordered.push({ file: displayTestFile(), views: [], failures: [], order: Infinity });
  }
  for (const group of ordered) {
    if (lines.length > 1) lines.push("");
    const label = runCount > 1 ? `${group.file}: (run #${runIndex + 1})` : `${group.file}:`;
    const body = [];
    appendRunRecords(body, group.views, group.failures);
    appendGithubGroup(lines, label, body);
  }
}

function reportResults() {
  const reportEmptyGithubFile = testCliModeEnabled() && githubActionsEnabled();
  if (resultsReported ||
      (tests.length === 0 && failures.length === 0 && !globalThis.__cottontailBunTestUsed && !reportEmptyGithubFile)) return;
  resultsReported = true;
  const lines = [""];
  const currentViews = tests
    .filter((record) => record.status && record.status !== "filtered")
    .map(snapshotRecordView);
  const runDurationMs = currentViews.reduce((total, view) => total + (Number(view.record.durationMs) || 0), 0);
  const labelFilterMatchedNoTests = Boolean(testNamePattern) && currentViews.length === 0 &&
    failures.length === 0 && tests.length > 0;
  const runs = completedRuns.length > 0 ? [...completedRuns, currentViews] : [currentViews];
  const hasVisibleRunOutput = runs.some((views) => agentQuietMode
    ? views.some((view) => view.status === "fail")
    : views.length > 0);
  if (hasVisibleRunOutput || failures.length > 0 || labelFilterMatchedNoTests || reportEmptyGithubFile) {
    runs.forEach((views, index) => {
      const extraFailures = index === runs.length - 1
        ? failures.filter(({ record }) => !tests.includes(record))
        : [];
      appendRunFileGroups(lines, views, extraFailures, index, runs.length);
    });
  }
  if (labelFilterMatchedNoTests) {
    const pattern = String(cliOption("-t") ?? cliOption("--test-name-pattern") ?? "");
    lines.push("");
    lines.push(`error: regex ${JSON.stringify(pattern)} matched 0 tests. Searched ${testFileCount} ` +
      `file${testFileCount === 1 ? "" : "s"} (skipping ${tests.length} test${tests.length === 1 ? "" : "s"}) [0.00ms]`);
    console.error(lines.join("\n"));
    return;
  }
  const assertionCount = Number(globalThis.__cottontailTestAssertionCount ?? 0);
  const snapshotCount = Number(globalThis.__cottontailTestSnapshotCount ?? 0);
  const aggregateFile = globalThis.process?.env?.COTTONTAIL_TEST_AGGREGATE_FILE;
  if (aggregateFile) {
    appendFileSync(
      aggregateFile,
      `${passedTests}\t${skippedTests}\t${todoTests}\t${failedTests}\t${runnerErrors}\t${assertionCount}\n`,
    );
    if (dotsMode) return;
    console.error(lines.join("\n"));
    return;
  }
  if (dotsMode) {
    const summary = [`${passedTests} pass`];
    if (skippedTests > 0) summary.push(`${skippedTests} skip`);
    if (todoTests > 0) summary.push(`${todoTests} todo`);
    summary.push(`${failedTests} fail`);
    if (runnerErrors > 0) summary.push(`${runnerErrors} error`);
    const total = passedTests + skippedTests + todoTests + failedTests;
    summary.push(`Ran ${total} ${total === 1 ? "test" : "tests"} across ${testFileCount} ${testFileCount === 1 ? "file" : "files"}.`);
    dotsWrite(`\n\n${summary.join("\n")}\n`);
    dotsLineHasMarkers = false;
    return;
  }
  const orderedViews = [...currentViews].sort((left, right) =>
    (left.reportOrder ?? Infinity) - (right.reportOrder ?? Infinity),
  );
  const statusSections = passedTests > 20 ? [
    {
      name: "skipped",
      views: orderedViews.filter((view) => view.status === "skip"),
      append(view) { lines.push(`(skip) ${fullTestName(view.record)}`); },
    },
    {
      name: "todo",
      views: orderedViews.filter((view) => view.status === "todo"),
      append(view) { lines.push(`(todo) ${fullTestName(view.record)}`); },
    },
    {
      name: "failed",
      views: orderedViews.filter((view) => view.status === "fail"),
      append(view) { appendFailureSummary(lines, view); },
    },
  ].filter((section) => section.views.length > 0) : [];
  statusSections.forEach((section, index) => {
    lines.push("");
    if (index > 0) lines.push("");
    const count = section.views.length;
    lines.push(`${count} test${count === 1 ? "" : "s"} ${section.name}:`);
    for (const view of section.views) section.append(view);
  });
  lines.push("");
  if (bailReached() && !bailReported) {
    bailReported = true;
    lines.push(`Bailed out after ${bailLimit} failure${bailLimit === 1 ? "" : "s"}`);
    lines.push("");
  }
  lines.push(` ${passedTests} pass`);
  if (skippedTests > 0) lines.push(` ${skippedTests} skip`);
  if (todoTests > 0) lines.push(` ${todoTests} todo`);
  lines.push(` ${failedTests} fail`);
  if (runnerErrors > 0) lines.push(` ${runnerErrors} error`);
  if (snapshotCount > 0) {
    lines.push(` ${snapshotCount} snapshot${snapshotCount === 1 ? "" : "s"}, ${assertionCount} expect() calls`);
  } else if (assertionCount > 0) {
    lines.push(` ${assertionCount} expect() calls`);
  }
  const total = passedTests + skippedTests + todoTests + failedTests;
  lines.push(`Ran ${total} ${total === 1 ? "test" : "tests"} across ${testFileCount} ${testFileCount === 1 ? "file" : "files"}.${durationSuffix(runDurationMs)}`);
  console.error(lines.join("\n"));
}

async function finalizeRun(exitOnFailure = true) {
  if (finalizePromise) return finalizePromise;
  finalizePromise = (async () => {
    if (afterTimer !== null) {
      runnerClearTimeout(afterTimer);
      afterTimer = null;
    }
    if (rootSuite.beforeRan && !rootSuite.afterRan) {
      rootSuite.afterRan = true;
      const error = await runHookList(rootSuite.afterHooks, new TestContext({ name: rootSuite.name }), true);
      if (error) recordHookFailure(rootSuite.name, error);
    }
    try {
      await globalThis.__cottontailFlushSnapshots?.();
    } catch (error) {
      recordHookFailure("snapshot writer", error);
    }
    try {
      writeJunitReport(tests, rootSuite, junitOptions);
    } catch (error) {
      recordHookFailure("JUnit reporter", error);
    }
    reportResults();
    const labelFilterMatchedNoTests = Boolean(testNamePattern) &&
      tests.length > 0 && tests.every((record) => record.status === "filtered");
    if (exitOnFailure && (failedTests > 0 || runnerErrors > 0 || (labelFilterMatchedNoTests && !passWithNoTests))) {
      if (typeof globalThis.process?.exit === "function") globalThis.process.exit(1);
      if (failures.length > 0) throw failures[0].error;
      throw new Error(`No tests matched ${String(testNamePattern)}`);
    }
    // Like `bun test`, exit once the run completes even if servers/sockets
    // are still holding the event loop open.
    if (exitOnFailure && typeof globalThis.process?.exit === "function") {
      globalThis.process.exit(globalThis.process.exitCode ?? 0);
    }
  })();
  return finalizePromise;
}

function scheduleAfterHooks() {
  if (afterTimer !== null || runnerActive || runScheduled || hasPendingTests()) return;
  afterTimer = runnerSetTimeout(() => {
    afterTimer = null;
    promiseThen(finalizeRun(true), undefined, (error) => {
      runnerSetTimeout(() => { throw error; }, 0);
    });
  }, 0);
}

function resetForRerun() {
  nextReportOrder = 0;
  for (const record of tests) {
    record.ran = false;
    record.status = null;
    record.error = null;
    record.todoError = null;
    record.attempts = undefined;
    record.attemptErrors = undefined;
    record.attemptAssertionCounts = undefined;
    record.attemptDurationsMs = undefined;
    record.durationMs = undefined;
    record.reportOrder = undefined;
  }
  const resetSuite = (suite) => {
    suite.beforeRan = false;
    suite.afterRan = false;
    suite.beforeError = null;
    suite.preloadBeforeErrorFile = null;
    for (const child of suite.children) {
      if (child.kind === "suite") resetSuite(child);
    }
  };
  resetSuite(rootSuite);
}

function scheduleRun() {
  const reportEmptyGithubFile = testCliModeEnabled() && githubActionsEnabled();
  const noRegisteredWork = tests.length === 0 && failures.length === 0 && !suiteHasLifecycleWork(rootSuite) &&
    !hasPendingSuiteDefinitions() && !globalThis.__cottontailHasPendingSnapshots?.();
  if (noRegisteredWork) {
    if (reportEmptyGithubFile && globalThis.__cottontailTestEntrypointLoaded) reportResults();
    return;
  }
  installUncaughtCapture();
  installAsyncFailureGuards();
  if (runnerActive) {
    runAgain = true;
    return;
  }
  if (runScheduled) return;
  if (afterTimer !== null) {
    runnerClearTimeout(afterTimer);
    afterTimer = null;
  }
  finalizePromise = null;
  runScheduled = true;
  queueMicrotask(async () => {
    runScheduled = false;
    runnerActive = true;
    try {
      do {
        runAgain = false;
        if (globalThis.__cottontailBunTestUsed && !testCliModeEnabled()) {
          globalThis.__cottontailBunTestHeaderPrinted = true;
          console.log(`bun test ${globalThis.Bun?.version_with_sha ?? "0.0.0-cottontail (cottontail)"}`);
        }
        await defineDeferredSuites();
        const concurrentGroup = [];
        await executeSuite(rootSuite, concurrentGroup);
        await flushConcurrent(concurrentGroup);
        stopPendingTestsForBail();
        // --rerun-each=N runs every test N times (bun re-evaluates the file;
        // module state persists there too, so re-running records matches).
        if (!runAgain && !hasPendingTests() && completedRerunCount + 1 < rerunEach) {
          completedRerunCount += 1;
          completedRuns.push(tests
            .filter((record) => record.status && record.status !== "filtered")
            .map(snapshotRecordView));
          resetForRerun();
          runAgain = true;
        }
      } while (runAgain || hasPendingTests());
      runnerActive = false;
      scheduleAfterHooks();
    } catch (error) {
      runnerActive = false;
      recordHookFailure("test runner", error);
      scheduleAfterHooks();
    }
  });
}

globalThis[Symbol.for("cottontail.internal.startTestRun")] = scheduleRun;

function normalizeCountOption(value, name) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return count;
}

function validateTestOptions(options) {
  const normalized = { ...options };
  if (normalized.retry != null && normalized.repeats != null) {
    throw new TypeError("Cannot set both retry and repeats");
  }
  if (normalized.retry != null) normalized.retry = normalizeCountOption(normalized.retry, "retry");
  if (normalized.repeats != null) normalized.repeats = normalizeCountOption(normalized.repeats, "repeats");
  return normalized;
}

function makeTestFunction(defaultOptions = {}) {
  const fn = function nodeTest(name, options, callback) {
    if (currentExecution()) throw nestedTestNotImplemented("test");
    const parsed = parseTestArgs(name, options, callback);
    const record = {
      name: parsed.name,
      options: validateTestOptions({ ...defaultOptions, ...parsed.options }),
      fn: parsed.fn,
      suite: currentSuite,
      filePath: String(globalThis.__cottontailRegisteringTestFile ?? globalThis.__filename ?? globalThis.process?.argv?.[1] ?? ""),
      registrationLine: Number(parsed.options.__bunRegistrationLine) || captureTestRegistrationLine(
        String(globalThis.__cottontailRegisteringTestFile ?? globalThis.__filename ?? globalThis.process?.argv?.[1] ?? ""),
      ),
      ran: false,
      result: null,
    };
    record.result = new Promise((resolve, reject) => {
      record.resolve = resolve;
      record.reject = reject;
    });
    promiseThen(record.result, undefined, () => {});
    tests.push(record);
    currentSuite.children.push(record);
    if (record.options.only) hasOnly = true;
    selectionDirty = true;
    for (let suite = currentSuite; suite; suite = suite.parent) suite.afterRan = false;
    scheduleRun();
    return record.result;
  };
  return fn;
}

export const test = makeTestFunction();
export const it = test;

function suiteFunction(name, options, callback, defaultOptions = {}) {
  if (currentExecution()) throw nestedTestNotImplemented("describe");
  installAsyncFailureGuards();
  const parsed = parseTestArgs(name, options, callback);
  const suiteOptions = { ...defaultOptions, ...parsed.options };
  const parent = currentSuite;
  const child = createSuite(parsed.name, suiteOptions, parent);
  parent.children.push(child);
  if (suiteOptions.only) hasOnly = true;
  selectionDirty = true;
  if (suiteOptions.__bunDeferredDefinition) {
    child.definitionFn = parsed.fn;
    child.definitionState = "pending";
    scheduleRun();
    return undefined;
  }
  emit("test:suite:start", { name: parsed.name });
  currentSuite = child;
  try {
    let rejectExternal;
    const failure = new Promise((_, reject) => { rejectExternal = reject; });
    const target = { kind: "describe", failExternal: rejectExternal };
    const result = failureStorage.run(target, () => typeof parsed.fn === "function" ? parsed.fn() : undefined);
    const completion = runnerPromiseRace([runnerPromiseResolve(result), failure]);
    promiseThen(completion, undefined, (error) => {
      child.definitionError = error;
      scheduleRun();
    });
    emit("test:suite:finish", { name: parsed.name });
    return promiseThen(completion, undefined, () => {});
  } catch (error) {
    child.definitionError = error;
    emit("test:suite:finish", { name: parsed.name });
    scheduleRun();
    return runnerPromiseResolve();
  } finally {
    currentSuite = parent;
  }
}

export const describe = Object.assign(suiteFunction, {
  only: (...args) => suiteFunction(args[0], args[1], args[2], { only: true }),
  skip: (...args) => suiteFunction(args[0], args[1], args[2], { skip: true }),
  todo: (...args) => suiteFunction(args[0], args[1], args[2], { todo: true }),
});

export const suite = describe;
export const only = makeTestFunction({ only: true });
export const skip = makeTestFunction({ skip: true });
export const todo = makeTestFunction({ todo: true });

export function before(fn, options = {}) {
  const execution = currentExecution();
  if (execution) execution.afterBodyHooks.unshift({ fn, options, layer: globalThis.__cottontailTestRegistrationLayer ?? 0 });
  else {
    currentSuite.beforeHooks.push({
      fn,
      options,
      layer: globalThis.__cottontailTestRegistrationLayer ?? 0,
      filePath: String(globalThis.__cottontailRegisteringTestFile ?? globalThis.__filename ?? ""),
    });
    currentSuite.beforeRan = false;
    scheduleRun();
  }
}

export function after(fn, options = {}) {
  const execution = currentExecution();
  if (execution) execution.afterBodyHooks.push({ fn, options, layer: globalThis.__cottontailTestRegistrationLayer ?? 0 });
  else {
    currentSuite.afterHooks.push({ fn, options, layer: globalThis.__cottontailTestRegistrationLayer ?? 0 });
    currentSuite.afterRan = false;
    scheduleRun();
  }
}

export function beforeEach(fn, options = {}) {
  if (currentExecution()) {
    throw new Error("Cannot call beforeEach() inside a test. Call it inside describe() instead.");
  }
  currentSuite.beforeEachHooks.push({ fn, options, layer: globalThis.__cottontailTestRegistrationLayer ?? 0 });
  scheduleRun();
}

export function afterEach(fn, options = {}) {
  const execution = currentExecution();
  if (execution) execution.afterEachHooks.push({ fn, options, layer: globalThis.__cottontailTestRegistrationLayer ?? 0 });
  else currentSuite.afterEachHooks.push({ fn, options, layer: globalThis.__cottontailTestRegistrationLayer ?? 0 });
  scheduleRun();
}

export function onTestFinished(fn, options = {}) {
  if (typeof fn !== "function") throw new TypeError("onTestFinished requires a callback");
  const execution = currentExecution();
  if (!execution) throw new Error("Cannot call onTestFinished() outside of a test");
  if (execution.record.options.concurrent) {
    throw new Error("Cannot call onTestFinished() here. It cannot be called inside a concurrent test. Use test.serial or remove test.concurrent.");
  }
  execution.finishHooks.push({ fn, options });
}

export function setDefaultTimeout(timeout) {
  const value = Number(timeout);
  if (!Number.isFinite(value) || value < 0) throw new TypeError("timeout must be a non-negative number");
  defaultTimeout = value;
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
      await record.result;
    } catch {}
  }
  await finalizeRun(false);
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
  onTestFinished,
  only,
  run,
  setDefaultTimeout,
  skip,
  snapshot,
  suite,
  test,
  todo,
});

export default test;
