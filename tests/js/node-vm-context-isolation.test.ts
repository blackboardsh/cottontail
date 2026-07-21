import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import util from "node:util";

describe("node:vm native context realms", () => {
  test("contexts have independent intrinsic identities", () => {
    const hostObject = {};
    const hostFunction = () => 42;
    const context = vm.createContext({ hostObject, hostFunction });
    const foreign = vm.runInContext(
      "({ Object, Function, SharedArrayBuffer, object: {}, fn() {}, array: [], set: new Set([1, 2, 3]), buffer: new ArrayBuffer(3), shared: new SharedArrayBuffer(4), error: new Error('foreign') })",
      context,
    );

    expect(foreign.Object).not.toBe(Object);
    expect(foreign.Function).not.toBe(Function);
    expect(Object.getPrototypeOf(foreign.object)).toBe(foreign.Object.prototype);
    expect(Object.getPrototypeOf(foreign.fn)).toBe(foreign.Function.prototype);
    expect(foreign.object instanceof Object).toBe(false);
    expect(foreign.fn instanceof Function).toBe(false);
    expect(foreign.array instanceof Array).toBe(false);
    expect(foreign.set).toStrictEqual(new Set([1, 2, 3]));
    expect(foreign.buffer).toHaveLength(3);
    expect(foreign.shared).toHaveLength(4);
    expect(foreign.buffer.byteLength).toBe(3);
    expect(foreign.shared.byteLength).toBe(4);
    expect(foreign.SharedArrayBuffer).not.toBe(SharedArrayBuffer);
    expect(foreign.error instanceof Error).toBe(false);
    expect(vm.runInContext("hostObject", context)).toBe(hostObject);
    expect(vm.runInContext("hostFunction", context)).toBe(hostFunction);
  });

  test("context globals and lexical declarations persist across runs", () => {
    const sandbox: Record<PropertyKey, unknown> = { value: 2 };
    const context = vm.createContext(sandbox);

    expect(vm.runInContext("var count = value; let lexical = 7; function add(n) { count += n; return count; } add(3)", context))
      .toBe(5);
    expect(sandbox.count).toBe(5);
    expect(typeof sandbox.add).toBe("function");
    expect(vm.runInContext("lexical + add(4)", context)).toBe(16);
    expect(sandbox.count).toBe(9);

    sandbox.value = 20;
    expect(vm.runInContext("value", context)).toBe(20);

    const symbol = Symbol("sandbox-key");
    sandbox[symbol] = "symbol value";
    expect(vm.runInContext("Reflect.ownKeys(globalThis).find(key => typeof key === 'symbol' && key.description === 'sandbox-key')", context))
      .toBe(symbol);
  });

  test("intrinsic mutations stay inside their context", () => {
    const first = vm.createContext({});
    const second = vm.createContext({});

    vm.runInContext("Object.prototype.realmOnly = 123", first);
    expect(vm.runInContext("({}).realmOnly", first)).toBe(123);
    expect(vm.runInContext("({}).realmOnly", second)).toBe(undefined);
    expect(({} as { realmOnly?: number }).realmOnly).toBe(undefined);
  });

  test("foreign exceptions retain realm identity and filenames", () => {
    const context = vm.createContext({ touched: false });
    let thrown: unknown;
    try {
      vm.runInContext("touched = true; throw new TypeError('from context')", context, { filename: "foreign-context.vm.js" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeTruthy();
    expect(thrown instanceof TypeError).toBe(false);
    expect((thrown as Error).name).toBe("TypeError");
    expect((thrown as Error).message).toBe("from context");
    expect((thrown as Error).stack).toContain("foreign-context.vm.js");
    expect(context.touched).toBe(true);
  });

  test("codeGeneration.strings blocks eval and string constructors", () => {
    const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: true } });
    expect(vm.runInContext("try { new Function('return 42')() } catch (error) { error.name }", context))
      .toBe("EvalError");
    expect(vm.runInContext("try { eval('1 + 1') } catch (error) { error.name }", context))
      .toBe("EvalError");
    expect(vm.runInContext("try { Object.defineProperty({}, 'x', { get: Function }).x } catch (error) { error.name }", context))
      .toBe("EvalError");
  });

  test("util.inspect sanitizes options passed to a foreign custom inspector", () => {
    const target = vm.runInNewContext(
      `({
        [Symbol.for('nodejs.util.inspect.custom')](depth, ctx) {
          this.depth = depth;
          this.ctx = ctx;
          try {
            this.stylized = ctx.stylize('\u{1f408}');
          } catch (error) {
            this.stylizeException = error;
          }
          return this.stylized;
        }
      })`,
      { __proto__: null },
    );

    expect(target.ctx).toBe(undefined);
    expect(util.inspect(target)).toBe("\u{1f408}");
    expect(typeof target.ctx).toBe("object");

    const graph = fullObjectGraph(target);
    expect(graph.has(Object)).toBe(false);
    expect(graph.has(Function)).toBe(false);
    expect(fullObjectGraph(globalThis).has(Function.prototype)).toBe(true);
  });
});

function fullObjectGraph(value: unknown) {
  const graph = new Set<unknown>([value]);
  for (const entry of graph) {
    if ((typeof entry !== "object" && typeof entry !== "function") || entry === null) continue;
    graph.add(Object.getPrototypeOf(entry));
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(entry))) {
      graph.add(descriptor.value);
      graph.add(descriptor.set);
      graph.add(descriptor.get);
    }
  }
  return graph;
}
