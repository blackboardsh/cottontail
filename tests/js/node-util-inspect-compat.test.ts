import { expect, test } from "bun:test";
import { createTracing } from "node:trace_events";
import { inspect } from "node:util";

test("inspect hides the runtime Date compatibility proxy", () => {
  expect(inspect(Date, { showProxy: true })).toBe("[Function: Date]");
  expect(inspect(new Proxy(Date, []), { showProxy: true })).toBe("Proxy [ [Function: Date], [] ]");
  expect(inspect(new Proxy(Date, String), { showProxy: true })).toBe(
    "Proxy [ [Function: Date], [Function: String] ]",
  );

  function Visible() {}
  const handler = {
    apply(target: typeof Visible, thisArg: unknown, argumentsList: unknown[]) {
      return Reflect.apply(target, thisArg, argumentsList);
    },
  };
  expect(inspect(new Proxy(Visible, handler), { showProxy: true })).toContain("Proxy [");
});

test("inspect preserves JavaScriptCore stack frames", () => {
  const error = new Error("boom");
  error.stack = "failure@file:///example.js:1:2\n@file:///example.js:3:4";
  expect(inspect(error)).toBe(error.stack);
});

test("restoring Error.stackTraceLimit re-enables stack capture", () => {
  const originalLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 0;
    expect(new Error("disabled").stack).toBeUndefined();

    Error.stackTraceLimit = originalLimit;
    const restored = new Error("restored").stack;
    expect(restored).toStartWith("Error: restored\n    at ");
  } finally {
    Error.stackTraceLimit = originalLimit;
  }
});

test("inspect matches Bun for non-string Error names", () => {
  const cases: Array<[unknown, string]> = [
    [404, "404: foo"],
    [0, "0: foo"],
    [0n, "0: foo"],
    [null, "null: foo"],
    [false, "false: foo"],
    ["", "foo"],
  ];

  for (const [name, expected] of cases) {
    const error = new RangeError("foo");
    error.name = name as string;
    expect(inspect(error).split("\n")[0]).toBe(expected);
  }
});

test("inspect matches Bun for non-string Error stacks", () => {
  const cases: Array<[unknown, string]> = [
    [404, "[404]"],
    [0, "[RangeError: foo]"],
    [0n, "[RangeError: foo]"],
    [null, "[RangeError: foo]"],
    [false, "[RangeError: foo]"],
    ["", "[RangeError: foo]"],
  ];

  for (const [stack, expected] of cases) {
    const error = new RangeError("foo");
    error.stack = stack as string;
    expect(inspect(error).split(" { ")[0]).toBe(expected);
  }
});

test("inspect identifies trace_events handles as Tracing instances", () => {
  const trace = createTracing({ categories: ["cottontail"] });
  expect(inspect({ trace }, { depth: 0 })).toBe("{ trace: [Tracing] }");
});

test("keep-names preserves explicit static class names", () => {
  class SymbolNameClass {
    static name = Symbol("name");
  }

  expect(typeof SymbolNameClass.name).toBe("symbol");
  expect(String(SymbolNameClass.name)).toBe("Symbol(name)");
  expect(inspect(new SymbolNameClass())).toBe("Symbol(name) {}");
});

test("inspect formats null-prototype Errors like Bun", () => {
  const error = new Error("test") as Error & { bar?: boolean };
  Object.defineProperty(error, Symbol.toStringTag, {
    value: "WOW",
    configurable: true,
  });
  Object.setPrototypeOf(error, null);

  expect(inspect(error)).toBe("[Object: null prototype] [WOW] {}");

  error.bar = true;
  delete error[Symbol.toStringTag];
  expect(inspect(error)).toBe("[Error: null prototype] { bar: true }");

  error.stack = "This is a stack";
  expect(inspect(error)).toBe("[Error: null prototype] { bar: true }");
});
