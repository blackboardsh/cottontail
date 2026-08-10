import { expect, test } from "bun:test";

test("captureStackTrace fills the visible limit when recapturing an Error", () => {
  function f1() { f2(); }
  function f2() { f3(); }
  function f3() { f4(); }
  function f4() { f5(); }
  function f5() { f6(); }
  function f6() { f7(); }
  function f7() { f8(); }
  function f8() { f9(); }
  function f9() { f10(); }
  function f10() { capture(); }
  function capture() {
    const plainTarget = {};
    Error.captureStackTrace(plainTarget);
    expect(plainTarget.stack.split("\n")).toHaveLength(11);

    const errorTarget = new Error();
    Error.captureStackTrace(errorTarget);
    expect(errorTarget.stack.split("\n")).toHaveLength(11);
  }

  f1();
});

test("captureStackTrace retains async ancestry", async () => {
  async function outer() {
    await Promise.resolve();
    return await inner();
  }

  async function inner() {
    await Promise.resolve();
    const target = {};
    Error.captureStackTrace(target);
    return target.stack;
  }

  expect(await outer()).toContain("async outer");
});

test("captureStackTrace preserves async ancestry after a supplied constructor boundary", async () => {
  async function outer() {
    return await middle();
  }

  async function middle() {
    return await boundary();
  }

  async function boundary() {
    await Promise.resolve();
    const target = {};
    Error.captureStackTrace(target, boundary);
    return target.stack;
  }

  const stack = await outer();
  expect(stack).not.toContain("at boundary");
  expect(stack).toContain("at async middle");
  expect(stack).toContain("at async outer");
});

test("captureStackTrace clears async ancestry when its constructor boundary is absent", async () => {
  function absent() {}

  async function outer() {
    await Promise.resolve();
    const target = {};
    Error.captureStackTrace(target, absent);
    return target.stack;
  }

  expect(await outer()).toBe("Error");
});

test("captureStackTrace applies the limit after removing its constructor boundary", () => {
  const originalLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 3;
  try {
    function target() {
      const result = {};
      Error.captureStackTrace(result, target);
      return result.stack;
    }

    function recurse(depth) {
      if (depth === 0) return target();
      const stack = recurse(depth - 1);
      return `${stack}`;
    }

    const stack = recurse(20);
    expect(stack.split("\n")).toHaveLength(4);
    expect(stack).not.toContain("at target");
    expect(stack).toContain("at recurse");
  } finally {
    Error.stackTraceLimit = originalLimit;
  }
});

test("captureStackTrace uses identity for an anonymous constructor boundary", () => {
  const target = {};
  const functions = [
    function () {
      Error.captureStackTrace(target, functions[0]);
    },
    function caller() {
      functions[0]();
    },
  ];

  expect(functions[0].name).toBe("");
  functions[1]();
  expect(target.stack.split("\n")[1]).toContain("at caller");
});

test("captureStackTrace does not confuse a same-named absent constructor boundary", () => {
  const target = {};
  const absent = function same() {};

  function same() {
    Error.captureStackTrace(target, absent);
  }

  same();
  expect(target.stack).toBe("Error");
});

test("captureStackTrace does not invoke a constructor name getter", async () => {
  let nameReads = 0;
  async function absent() {}
  Object.defineProperty(absent, "name", {
    configurable: true,
    get() {
      nameReads += 1;
      return "inner";
    },
  });

  async function inner() {
    await Promise.resolve();
    const target = {};
    Error.captureStackTrace(target, absent);
    return target.stack;
  }

  expect(await inner()).toBe("Error");
  expect(nameReads).toBe(0);
});

test("captureStackTrace restores public state before prepareStackTrace", () => {
  const originalPrepare = Error.prepareStackTrace;
  const originalLimit = Error.stackTraceLimit;
  const replacementPrepare = () => "replacement";
  let observedPrepare;
  let observedLimit;

  Error.stackTraceLimit = 3;
  const prepare = (_error, callSites) => {
    observedPrepare = Error.prepareStackTrace;
    observedLimit = Error.stackTraceLimit;
    Error.prepareStackTrace = replacementPrepare;
    Error.stackTraceLimit = 77;
    return callSites.length;
  };
  Error.prepareStackTrace = prepare;

  try {
    function boundary() {
      const target = {};
      Error.captureStackTrace(target, boundary);
      return target;
    }
    function first() { return boundary(); }
    function second() { return first(); }
    function third() { return second(); }

    const target = third();
    expect(target.stack).toBe(3);
    expect(observedPrepare).toBe(prepare);
    expect(observedLimit).toBe(3);
    expect(Error.prepareStackTrace).toBe(replacementPrepare);
    expect(Error.stackTraceLimit).toBe(77);
  } finally {
    Error.prepareStackTrace = originalPrepare;
    Error.stackTraceLimit = originalLimit;
  }
});
