const assert = require("node:assert");
const { inspect } = require("node:util");
const vm = require("node:vm");

function check(value, message) {
  if (!value) throw new Error(message);
}

function capture(fn, message) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error(message || `Expected function to throw: ${fn}`);
}

async function captureAsync(promise, message) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error(message || "Expected promise to reject");
}

async function main() {
  check(assert.length === 0 && assert.fail.length === 5, "assert function arity mismatch");
  check(assert.Assert.length === 1 && assert.CallTracker.prototype.calls.length === 1,
    "assert constructor arity mismatch");
  assert.strictEqual(NaN, NaN);
  assert.notStrictEqual(0, -0);
  const zeroError = capture(() => assert.strictEqual(0, -0));
  check(zeroError.code === "ERR_ASSERTION", "strictEqual code mismatch");
  check(zeroError.operator === "strictEqual", "strictEqual operator mismatch");
  check(Object.is(zeroError.actual, 0) && Object.is(zeroError.expected, -0), "strictEqual metadata mismatch");

  const firstCycle = { value: 1 };
  firstCycle.self = firstCycle;
  const secondCycle = { value: 1 };
  secondCycle.self = secondCycle;
  assert.deepStrictEqual(firstCycle, secondCycle);

  const differentCycle = { value: 1 };
  differentCycle.self = { value: 1 };
  differentCycle.self.self = differentCycle.self;
  assert.throws(() => assert.deepStrictEqual(firstCycle, differentCycle), assert.AssertionError);

  assert.deepStrictEqual(
    new Map([[{ id: 1 }, { nested: new Set([{ value: 2 }]) }]]),
    new Map([[{ id: 1 }, { nested: new Set([{ value: 2 }]) }]]),
  );
  assert.deepEqual(new Set([1, "2", { three: 3 }]), new Set(["1", 2, { three: "3" }]));

  const symbol = Symbol("enumerable");
  assert.deepStrictEqual({ [symbol]: { value: 1 } }, { [symbol]: { value: 1 } });
  assert.throws(
    () => assert.deepStrictEqual({ [symbol]: 1 }, { [symbol]: 2 }),
    assert.AssertionError,
  );

  const firstError = new TypeError("failure", { cause: { code: 7 } });
  const secondError = new TypeError("failure", { cause: { code: 7 } });
  assert.deepStrictEqual(firstError, secondError);
  secondError.cause.code = 8;
  assert.throws(() => assert.deepStrictEqual(firstError, secondError), assert.AssertionError);

  assert.deepStrictEqual(new Float32Array([NaN]), new Float32Array([NaN]));
  assert.deepEqual(new Float32Array([0]), new Float32Array([-0]));
  assert.throws(
    () => assert.deepStrictEqual(new Float32Array([0]), new Float32Array([-0])),
    assert.AssertionError,
  );
  const leftView = new DataView(new Uint8Array([1, 2, 3]).buffer, 1, 2);
  const rightView = new DataView(new Uint8Array([2, 3]).buffer);
  assert.deepStrictEqual(leftView, rightView);

  const regexpA = /value/gi;
  const regexpB = /value/gi;
  regexpA.lastIndex = 1;
  assert.throws(() => assert.deepStrictEqual(regexpA, regexpB), assert.AssertionError);

  const sparse = [];
  sparse.length = 2;
  const explicit = [undefined, undefined];
  assert.throws(() => assert.deepStrictEqual(sparse, explicit), assert.AssertionError);

  assert.partialDeepStrictEqual(
    { rows: [{ id: 1 }, { id: 2 }, { id: 3 }], extra: true },
    { rows: [{ id: 1 }, { id: 3 }] },
  );
  assert.partialDeepStrictEqual(
    new Set([{ id: 1 }, { id: 2 }, { id: 3 }]),
    new Set([{ id: 2 }]),
  );
  assert.partialDeepStrictEqual(
    new Map([[{ id: 1 }, "one"], [{ id: 2 }, { value: 2 }]]),
    new Map([[{ id: 2 }, { value: 2 }]]),
  );
  assert.partialDeepStrictEqual(
    new Uint8Array([1, 8, 2, 8, 3]),
    new Uint8Array([1, 2, 3]),
  );
  assert.throws(
    () => assert.partialDeepStrictEqual([1, 2, 3], [3, 1]),
    assert.AssertionError,
  );

  class Left { constructor() { this.value = 1; } }
  class Right { constructor() { this.value = 1; } }
  assert.throws(() => assert.deepStrictEqual(new Left(), new Right()), assert.AssertionError);
  assert.deepEqual(new Left(), new Right());

  const configured = new assert.Assert({ skipPrototype: true });
  configured.deepStrictEqual(new Left(), new Right());
  check(capture(() => assert.Assert()).code === "ERR_CONSTRUCT_CALL_REQUIRED", "Assert must require new");
  assert.throws(() => new assert.Assert().equal(1, "1"), assert.AssertionError);
  const nonStrict = new assert.Assert({ strict: false, diff: "full" });
  nonStrict.equal(1, "1");
  check(nonStrict.ok.strictEqual === undefined, "Assert.ok must not alias the default assert export");
  const strictInstance = new assert.Assert();
  check(strictInstance.equal === strictInstance.strictEqual, "strict Assert equal alias mismatch");
  check(strictInstance.deepEqual === strictInstance.deepStrictEqual, "strict Assert deepEqual alias mismatch");
  const invalidDiff = capture(() => new assert.Assert({ diff: "invalid" }));
  check(invalidDiff.code === "ERR_INVALID_ARG_VALUE" && invalidDiff.message.includes("property 'options.diff'"),
    "Assert diff validation mismatch");
  assert.throws(() => assert.strict.equal(1, "1"), assert.AssertionError);

  assert.throws(() => { throw new TypeError("bad"); }, TypeError);
  assert.throws(() => { throw new Error("bad value"); }, /bad value/);
  assert.throws(
    () => { throw Object.assign(new Error("bad value"), { code: "E_BAD" }); },
    { code: /^E_BAD$/, message: /bad/ },
  );
  assert.throws(() => { throw new Error("bad"); }, error => error.message === "bad");
  const primitiveMismatch = capture(() => assert.throws(() => { throw null; }, { message: "bad" }));
  check(primitiveMismatch.message.startsWith("Expected values to be strictly deep-equal:"),
    "primitive exception mismatch must use a strict diff");
  const symbolMismatch = capture(() => assert.throws(() => { throw Symbol("bad"); }, RangeError));
  check(symbolMismatch.message.includes('Received "Symbol(bad)"'), "Error constructor primitive diagnostic mismatch");
  const arrayMismatch = capture(() => assert.throws(() => { throw [1, 2]; }, RangeError));
  check(arrayMismatch.message.includes('Received "[Array]"'), "Error constructor object diagnostic mismatch");
  class ForeignRangeError extends Error {}
  Object.defineProperty(ForeignRangeError, "name", { value: "RangeError" });
  const foreignRangeError = new ForeignRangeError("foreign");
  const foreignMismatch = capture(() => assert.throws(() => { throw foreignRangeError; }, RangeError));
  check(foreignMismatch.message.includes("identical name but a different prototype"),
    "cross-realm Error constructor diagnostic mismatch");
  const missing = capture(() => assert.throws(() => {}));
  check(missing.code === "ERR_ASSERTION" && missing.operator === "throws", "throws metadata mismatch");

  const unmatched = new RangeError("range");
  check(capture(() => assert.doesNotThrow(() => { throw unmatched; }, TypeError)) === unmatched,
    "doesNotThrow must rethrow unmatched errors");
  assert.doesNotThrow(() => 1);

  await assert.rejects(Promise.reject(new TypeError("async bad")), TypeError);
  await assert.rejects(async () => { throw Object.assign(new Error("async"), { code: "E_ASYNC" }); }, { code: "E_ASYNC" });
  await assert.rejects({
    then(_resolve, reject) { reject({ code: "E_THENABLE" }); },
    catch() {},
  }, { code: "E_THENABLE" });
  const invalidReturn = await captureAsync(assert.rejects(() => 1));
  check(invalidReturn.code === "ERR_INVALID_RETURN_VALUE", "rejects invalid return mismatch");
  const missingRejection = await captureAsync(assert.rejects(async () => {}, function expectedRejection() {}));
  check(missingRejection.operator === "rejects" && missingRejection.message.includes("Missing expected rejection"),
    "rejects missing rejection metadata mismatch");
  const rejectedValue = new Error("validation");
  const validation = () => "not true";
  const validationFailure = await captureAsync(assert.rejects(Promise.reject(rejectedValue), validation));
  check(validationFailure.actual === rejectedValue && validationFailure.expected === validation &&
    validationFailure.operator === "rejects", "rejects validation metadata mismatch");
  await assert.doesNotReject(Promise.resolve(1));
  const rejection = await Promise.resolve().then(() => assert.doesNotReject(Promise.reject(new Error("no")))).then(
    () => null,
    error => error,
  );
  check(rejection?.code === "ERR_ASSERTION" && rejection.operator === "doesNotReject", "doesNotReject metadata mismatch");
  const unmatchedRejection = new TypeError("unmatched");
  check(await captureAsync(assert.doesNotReject(Promise.reject(unmatchedRejection), RangeError)) === unmatchedRejection,
    "doesNotReject must rethrow unmatched rejections");

  assert.match("cottontail", /tail$/);
  assert.doesNotMatch("cottontail", /^tail/);
  const invalidMatchInput = capture(() => assert.match({ value: 1 }, /1/));
  check(invalidMatchInput.message.includes("Received type object ({ value: 1 })"), "match input diagnostic mismatch");
  const foreignRegExp = vm.runInNewContext("/tail$/");
  assert.match("cottontail", foreignRegExp);

  const generated = new assert.AssertionError({ actual: 1, expected: 2, operator: "strictEqual" });
  check(generated.generatedMessage === true, "generatedMessage mismatch");
  check(generated.name === "AssertionError" && generated.toString().startsWith("AssertionError [ERR_ASSERTION]:"),
    "AssertionError identity mismatch");
  check(generated.message.includes("Expected values to be strictly equal"), "AssertionError diff header missing");
  const custom = new assert.AssertionError({ actual: { value: 1 }, expected: { value: 2 }, operator: "deepStrictEqual", message: "custom" });
  check(custom.generatedMessage === false && custom.message.startsWith("custom\n"), "custom diff message mismatch");
  const emptyMessage = new assert.AssertionError({ actual: 1, expected: 2, operator: "strictEqual", message: "" });
  check(emptyMessage.generatedMessage === true, "empty AssertionError message metadata mismatch");
  const longValue = "A".repeat(1000);
  const longError = capture(() => assert.strictEqual(longValue, ""));
  check(inspect(longError).includes(`actual: '${"A".repeat(488)}...'`), "AssertionError inspect truncation mismatch");

  const wrapped = capture(() => assert.ifError(new Error("wrapped")));
  check(wrapped.code === "ERR_ASSERTION" && wrapped.message.includes("wrapped"), "ifError wrapper mismatch");
  const weirdStack = new Error();
  weirdStack.stack = "Error: custom\nThis is not a stack frame";
  check(!capture(() => assert.ifError(weirdStack)).stack.includes("not a stack frame"), "ifError copied a non-frame stack");
  check(capture(() => assert.strictEqual(1)).code === "ERR_MISSING_ARGS", "missing argument code mismatch");

  const tracker = new assert.CallTracker();
  const tracked = tracker.calls(value => value + 1, 1);
  check(tracked(1) === 2, "CallTracker return mismatch");
  tracker.verify();
  check(tracker.getCalls(tracked).length === 1, "CallTracker getCalls mismatch");
  tracker.reset(tracked);
  check(tracker.getCalls(tracked).length === 0, "CallTracker reset mismatch");

  const failingTracker = new assert.CallTracker();
  failingTracker.calls(function expectedCall() {}, 1);
  const trackerError = capture(() => failingTracker.verify());
  check(trackerError["operator 0"] === "expectedCall" && trackerError["actual 0"] === 0,
    "CallTracker AssertionError details mismatch");

  const iteratorPrototype = Reflect.getPrototypeOf(Array.prototype.values());
  const originalNext = iteratorPrototype.next;
  let proxyResult;
  function proxyTarget(a, b, c = 2) { return a + b + c; }
  const customProperty = Symbol("custom");
  proxyTarget.customProperty = customProperty;
  Object.defineProperty(proxyTarget, "length", { get() { throw new Error("length getter invoked"); } });
  iteratorPrototype.next = function forbiddenIterator() { throw new Error("array iterator invoked"); };
  Object.prototype.get = function forbiddenGetter() { throw new Error("Object.prototype.get invoked"); };
  try {
    const proxyTracker = new assert.CallTracker();
    const proxy = proxyTracker.calls(proxyTarget);
    proxyResult = {
      customProperty: proxy.customProperty,
      hasLength: Object.hasOwn(proxy, "length"),
      result: proxy(1, 2, 3),
    };
  } finally {
    iteratorPrototype.next = originalNext;
    delete Object.prototype.get;
  }
  check(proxyResult.customProperty === customProperty && proxyResult.hasLength && proxyResult.result === 6,
    "CallTracker proxy did not preserve function behavior");

  console.log("node assert conformance passed");
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
