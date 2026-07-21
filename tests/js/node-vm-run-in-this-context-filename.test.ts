import { afterEach, describe, expect, test } from "bun:test";
import { runInThisContext, Script } from "node:vm";

const originalPrepareStackTrace = Error.prepareStackTrace;

afterEach(() => {
  Error.prepareStackTrace = originalPrepareStackTrace;
});

describe("node:vm runInThisContext filenames", () => {
  test("filename options annotate function and Script stacks without replacing Error", () => {
    expect(runInThisContext("Error === globalThis.Error", { filename: "identity.vm.js" })).toBe(true);
    expect(runInThisContext("new Error('direct').stack", "direct.vm.js")).toContain("direct.vm.js");
    expect(new Script("new Error('script').stack", { filename: "script.vm.js" }).runInThisContext())
      .toContain("script.vm.js");
  });

  test("an explicit sourceURL takes precedence over the filename option", () => {
    const stack = runInThisContext(
      "new Error('inline').stack\n//# sourceURL=inline.vm.js",
      { filename: "option.vm.js" },
    );
    expect(stack).toContain("inline.vm.js");
    expect(stack).not.toContain("option.vm.js");
  });

  test("custom prepareStackTrace receives the VM filename call site", () => {
    let firstCallSite;
    Error.prepareStackTrace = (_error, trace) => {
      firstCallSite = trace[0];
      return `custom:${String(trace[0])}`;
    };

    expect(runInThisContext("new Error('custom').stack", { filename: "custom.vm.js" }))
      .toBe("custom:custom.vm.js:1:1");
    expect(firstCallSite.getFileName()).toBe("custom.vm.js");
    expect(firstCallSite.getScriptNameOrSourceURL()).toBe("custom.vm.js");
  });

  test("thrown errors retain the filename after evaluation returns", () => {
    let thrown;
    try {
      runInThisContext("throw new TypeError('thrown')", { filename: "thrown.vm.js" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown.stack).toContain("thrown.vm.js");
  });
});
