import { expect, mock } from "bun:test";

const symbol = Symbol("value");

expect(expect.any(Number)).toEqual(42);
expect({ value: 42 }).toEqual({ value: expect.any(Number) });
expect({ value: expect.stringMatching(/tail/) }).toEqual({ value: "cottontail" });
expect(expect.arrayContaining([expect.any(Number), "tail"])).toEqual(["tail", 42, true]);
expect(expect.objectContaining({ [symbol]: expect.anything() })).toEqual({ [symbol]: 1, extra: true });

expect(expect.not.stringContaining("tail")).not.toEqual("cottontail");
expect(expect.not.stringContaining("tail")).toEqual(42);
expect(expect.closeTo(1.23)).toEqual(1.234);
expect(expect.not.closeTo(1.23)).not.toEqual("1.23");

await expect(Promise.resolve("cottontail")).toEqual(expect.resolvesTo.stringContaining("tail"));
await expect({ value: Promise.reject("failure") }).toEqual({
  value: expect.rejectsTo.stringContaining("fail"),
});
await expect(Promise.resolve("cottontail")).toEqual(expect.not.resolvesTo.stringContaining("rabbit"));

expect(expect(Promise.resolve("cottontail")).resolves.toBe("cottontail")).toBeUndefined();
expect(expect(Promise.reject("failure")).rejects.toBe("failure")).toBeUndefined();

expect([1, , 3]).toEqual([1, undefined, 3]);
expect([1, , 3]).not.toStrictEqual([1, undefined, 3]);
expect("cottontail").toContainEqual("c");
expect("cottontail").not.toContainEqual("cottontail");

const weakKey = {};
const weakMap = new WeakMap([[weakKey, true]]);
expect(weakMap).toHaveLength(1);
weakMap.delete(weakKey);
expect(weakMap).toHaveLength(0);

const call = mock();
call("tail", undefined);
expect(call).toHaveBeenCalledWith("tail", undefined);
expect(call).not.toHaveBeenCalledWith("tail");

expect(() => expect.any()).toThrow();
expect(() => expect.arrayContaining("tail" as never)).toThrow();
expect(() => expect.closeTo("1" as never)).toThrow();

console.log("bun asymmetric matchers passed");
