import { expect, jest, mock, spyOn, vi } from "bun:test";
import { createRequire } from "node:module";
import { fn as liveFn, iCallFn, rexported, variable as liveVariable } from "./fixtures/mock-live-fixture";
import { trimWithLodash } from "./fixtures/mock-package-consumer";

const fn = mock((value: number) => value + 1);
expect(fn(2)).toBe(3);
expect(fn).toHaveBeenCalledTimes(1);
expect(fn).toHaveBeenCalledWith(2);
fn.mockReturnValue(10);
expect(fn(1)).toBe(10);

const object = {
  value: 4,
  add(amount: number) {
    return this.value + amount;
  },
};
const spy = spyOn(object, "add");
expect(object.add(6)).toBe(10);
expect(spy).toHaveBeenCalledOnce();
spy.mockRestore();
expect(object.add(1)).toBe(5);

const jestFn = jest.fn().mockResolvedValue("ok");
expect(await jestFn()).toBe("ok");
jest.clearAllMocks();
expect(jestFn).not.toHaveBeenCalled();

expect({ user: { name: "Ada", roles: ["admin"] } }).toMatchObject({
  user: expect.objectContaining({ name: "Ada" }),
});
expect(["a", "b"]).toContain("b");
expect("cottontail").toMatch(/tail$/);
await expect(Promise.resolve(42)).resolves.toBe(42);
await expect(new Promise((_resolve, reject) => setTimeout(() => reject(new Error("boom")), 0))).rejects.toThrow("boom");

expect("inline snapshot").toMatchInlineSnapshot('"inline snapshot"');
expect({ id: 1, name: "Ada" }).toMatchInlineSnapshot({ id: expect.any(Number) }, `
{
  "id": 1,
  "name": "Ada",
}
`);
expect({ id: 1, name: "Ada" }).toMatchSnapshot("named-object");
expect({ id: 1, name: "Ada" }).toMatchSnapshot("named-object");

jest.useFakeTimers();
const calls: string[] = [];
setTimeout(() => calls.push("timeout"), 50);
const interval = setInterval(() => calls.push("interval"), 25);
expect(jest.isFakeTimers()).toBe(true);
expect(jest.getTimerCount()).toBe(2);
jest.advanceTimersByTime(24);
expect(calls).toEqual([]);
jest.advanceTimersByTime(1);
expect(calls).toEqual(["interval"]);
clearInterval(interval);
jest.advanceTimersToNextTimer();
expect(calls).toEqual(["interval", "timeout"]);
jest.setSystemTime(new Date("2020-01-02T03:04:05.000Z"));
expect(Date.now()).toBe(1577934245000);
expect(new Date().toISOString()).toBe("2020-01-02T03:04:05.000Z");
jest.clearAllTimers();
expect(jest.getTimerCount()).toBe(0);
jest.useRealTimers();
expect(jest.isFakeTimers()).toBe(false);

vi.useFakeTimers({ now: 1000 });
expect(Date.now()).toBe(1000);
expect(performance.now()).toBe(0);
const pendingCalls: number[] = [];
setInterval(() => pendingCalls.push(Date.now()), 25);
setTimeout(() => pendingCalls.push(Date.now()), 100);
vi.runOnlyPendingTimers();
expect(pendingCalls).toEqual([1025, 1050, 1075, 1100, 1100]);
vi.useRealTimers();
expect(() => vi.getTimerCount()).toThrow("Fake timers are not active");

mock.module("virtual:bun-test-module", () => ({ value: 42 }));
const require = createRequire(`${process.cwd()}/tests/js/bun-test-module.ts`);
expect(require("virtual:bun-test-module").value).toBe(42);
const mockSpecifier = "virtual:bun-test-module";
const imported = await import(mockSpecifier);
expect(imported.value).toBe(42);
expect(imported.default.value).toBe(42);
mock.restore();

expect(trimWithLodash("  original  ")).toBe("original");
mock.module(require.resolve("lodash"), () => ({ trim: () => "mocked" }));
expect(trimWithLodash("  original  ")).toBe("mocked");
mock.restore();
expect(trimWithLodash("  original  ")).toBe("original");

expect(liveFn()).toBe(42);
expect(rexported).toBe(42);
mock.module("./fixtures/mock-live-fixture.ts", () => ({
  fn: () => 3,
  rexported: 43,
  variable: 10,
}));
expect(liveFn(), "live imported function").toBe(3);
expect(liveVariable).toBe(10);
expect(rexported).toBe(43);
expect((await import("./fixtures/mock-live-source")).rexported).toBe(43);
expect(iCallFn(), "function using rebound export").toBe(3);
mock.restore();

console.log("bun test module passed");
