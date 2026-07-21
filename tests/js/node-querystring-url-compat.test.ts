import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import querystring from "node:querystring";
import { format, parse } from "node:url";

test("querystring parse preserves malformed escapes and applies Node maxKeys rules", () => {
  expect(querystring.unescape("%2%2af%2a")).toBe("%2*f*");
  expect(querystring.parse(null as never)).toEqual(Object.create(null));

  const input = Array.from({ length: 1001 }, (_, index) => `${index}=${index}`).join("&");
  expect(Object.keys(querystring.parse(input, undefined, undefined, { maxKeys: "Infinity" as never }))).toHaveLength(1000);
  expect(Object.keys(querystring.parse(input, undefined, undefined, { maxKeys: Number.NaN }))).toHaveLength(1001);
});

test("querystring stringify handles arrays and primitive values", () => {
  expect(querystring.stringify({
    array: [1, 2],
    empty: [],
    object: {},
    nan: Number.NaN,
    bigint: 3n,
    bool: false,
  })).toBe("array=1&array=2&object=&nan=&bigint=3&bool=false");
  expect(querystring.stringify(null)).toBe("");
});

test("querystring escape matches Node surrogate handling", () => {
  expect(querystring.escape(`${String.fromCharCode(0xd801)}test`)).toBe("%F0%90%91%B4est");
  assert.throws(() => querystring.escape(String.fromCharCode(0xd801)), {
    name: "URIError",
    code: "ERR_INVALID_URI",
    message: "URI malformed",
  });
});

test("querystring unescapeBuffer only decodes plus when requested", () => {
  expect(querystring.unescapeBuffer("a+b").toString()).toBe("a+b");
  expect(querystring.unescapeBuffer("a+b", true).toString()).toBe("a b");
  expect(querystring.unescapeBuffer("a%2g").toString()).toBe("a%2g");
});

test("querystring default export supports a custom decoder", () => {
  const original = querystring.unescape;
  try {
    querystring.unescape = value => value.replace(/o/g, "_");
    expect(querystring.parse("foo=bor")).toEqual({ __proto__: null, f__: "b_r" });
  } finally {
    querystring.unescape = original;
  }
});

test("CommonJS querystring exports remain mutable", () => {
  const commonJS = require("node:querystring") as typeof querystring;
  const original = commonJS.unescape;
  try {
    commonJS.unescape = value => value.replace(/o/g, "_");
    expect(commonJS.unescape("foo")).toBe("f__");
    expect(commonJS.parse("foo=bor")).toEqual({ __proto__: null, f__: "b_r" });
  } finally {
    commonJS.unescape = original;
  }
});

test("legacy URL query parsing and formatting use querystring semantics", () => {
  const parsed = parse("/?tag=a&tag=b&space=x+y", true);
  expect(Object.getPrototypeOf(parsed.query)).toBeNull();
  expect(parsed.query).toEqual({ __proto__: null, tag: ["a", "b"], space: "x y" });

  expect(format({
    protocol: "http:",
    host: "example.test",
    pathname: "/",
    query: { tag: ["a", "b"], invalid: Infinity, space: "x y", tilde: "~" },
  })).toBe("http://example.test/?tag=a&tag=b&invalid=&space=x%20y&tilde=~");
});
