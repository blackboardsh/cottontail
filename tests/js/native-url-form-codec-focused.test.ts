import { describe, expect, test } from "bun:test";

describe("native URL form codec", () => {
  const nativeRoutePrefix = `native=${"%E6%B8%AC%E8%A9%A6".repeat(8)}&`;

  test("passes the upstream WHATWG URL-encoded parser vectors", () => {
    // Node v24.11.1's vendored WPT url/urlencoded-parser.any.js cases.
    const vectors: Array<[string, string[][]]> = [
      ["test", [["test", ""]]],
      ["\uFEFFtest=\uFEFF", [["\uFEFFtest", "\uFEFF"]]],
      ["%EF%BB%BFtest=%EF%BB%BF", [["\uFEFFtest", "\uFEFF"]]],
      ["%EF%BF%BF=%EF%BF%BF", [["\uFFFF", "\uFFFF"]]],
      ["%FE%FF", [["\uFFFD\uFFFD", ""]]],
      ["%FF%FE", [["\uFFFD\uFFFD", ""]]],
      ["†&†=x", [["†", ""], ["†", "x"]]],
      ["%C2", [["\uFFFD", ""]]],
      ["%C2x", [["\uFFFDx", ""]]],
      [
        "_charset_=windows-1252&test=%C2x",
        [["_charset_", "windows-1252"], ["test", "\uFFFDx"]],
      ],
      ["", []],
      ["a", [["a", ""]]],
      ["a=b", [["a", "b"]]],
      ["a=", [["a", ""]]],
      ["=b", [["", "b"]]],
      ["&", []],
      ["&a", [["a", ""]]],
      ["a&", [["a", ""]]],
      ["a&a", [["a", ""], ["a", ""]]],
      ["a&b&c", [["a", ""], ["b", ""], ["c", ""]]],
      ["a=b&c=d", [["a", "b"], ["c", "d"]]],
      ["a=b&c=d&", [["a", "b"], ["c", "d"]]],
      ["&&&a=b&&&&c=d&", [["a", "b"], ["c", "d"]]],
      ["a=a&a=b&a=c", [["a", "a"], ["a", "b"], ["a", "c"]]],
      ["a==a", [["a", "=a"]]],
      ["a=a+b+c+d", [["a", "a b c d"]]],
      ["%=a", [["%", "a"]]],
      ["%a=a", [["%a", "a"]]],
      ["%a_=a", [["%a_", "a"]]],
      ["%61=a", [["a", "a"]]],
      ["%61+%4d%4D=", [["a MM", ""]]],
      ["id=0&value=%", [["id", "0"], ["value", "%"]]],
      ["b=%2sf%2a", [["b", "%2sf*"]]],
      ["b=%2%2af%2a", [["b", "%2*f*"]]],
      ["b=%%2a", [["b", "%*"]]],
    ];

    for (const [input, expected] of vectors) {
      expect([...new URLSearchParams(input)]).toEqual(expected);
      expect([...new URLSearchParams(nativeRoutePrefix + input)].slice(1)).toEqual(expected);
    }
  });

  test("parses and serializes WHATWG form data", () => {
    const params = new URLSearchParams(
      "a=b+c&unicode=%E6%B8%AC%E8%A9%A6&empty=&missing&bad=%&short=%2"
    );

    expect([...params]).toEqual([
      ["a", "b c"],
      ["unicode", "測試"],
      ["empty", ""],
      ["missing", ""],
      ["bad", "%"],
      ["short", "%2"],
    ]);
    expect(params.toString()).toBe(
      "a=b+c&unicode=%E6%B8%AC%E8%A9%A6&empty=&missing=&bad=%25&short=%252"
    );
  });

  test("uses replacement characters for malformed UTF-8 and lone surrogates", () => {
    const malformed = new URLSearchParams("value=%C3%28");
    expect(malformed.get("value")).toBe("�(");
    expect(malformed.toString()).toBe("value=%EF%BF%BD%28");

    const parsedSurrogates = new URLSearchParams(
      `${nativeRoutePrefix}\ud800=x&x=\udfff`
    );
    expect([...parsedSurrogates].slice(1)).toEqual([["�", "x"], ["x", "�"]]);

    const surrogates = new URLSearchParams([["\ud800", "\udfff"]]);
    expect(surrogates.toString()).toBe("%EF%BF%BD=%EF%BF%BD");
  });

  test("preserves ordering, duplicates, and empty sequences", () => {
    const params = new URLSearchParams("=4&&a=1&a=2&4&x=");
    expect([...params]).toEqual([
      ["", "4"],
      ["a", "1"],
      ["a", "2"],
      ["4", ""],
      ["x", ""],
    ]);
    expect(params.toString()).toBe("=4&a=1&a=2&4=&x=");
  });

  test("keeps URL.searchParams live in both directions", () => {
    const url = new URL("https://example.test/?a=one+two");
    const params = url.searchParams;

    params.append("unicode", "測試");
    expect(url.search).toBe("?a=one+two&unicode=%E6%B8%AC%E8%A9%A6");

    url.search = "?next=hello+world&next=again";
    expect(params.getAll("next")).toEqual(["hello world", "again"]);
    expect(params.toString()).toBe("next=hello+world&next=again");
  });

  test("does not alter the public interface", () => {
    const params = new URLSearchParams("a=1");
    expect(Object.prototype.toString.call(params)).toBe("[object URLSearchParams]");
    expect(params[Symbol.iterator]).toBe(params.entries);
    expect(Object.getOwnPropertyDescriptor(URLSearchParams.prototype, "size")?.get)
      .toBeTypeOf("function");
    expect(Object.getOwnPropertyDescriptor(URLSearchParams.prototype, "toString")?.enumerable)
      .toBe(false);
  });

  test("handles a large encoded form through the public API", () => {
    const input = Array.from(
      { length: 256 },
      (_, index) => `key+${index}=${encodeURIComponent(`value ${index} 測試`)}`
    ).join("&");
    const params = new URLSearchParams(input);

    expect(params.size).toBe(256);
    expect(params.get("key 128")).toBe("value 128 測試");
    expect(new URLSearchParams(params.toString()).get("key 255")).toBe("value 255 測試");
  });
});
