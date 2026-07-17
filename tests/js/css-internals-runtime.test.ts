import { cssInternals } from "bun:internal-for-testing";
import { describe, expect, test } from "bun:test";

describe("vendored Zig CSS internals", () => {
  test("parses and combines declarations", () => {
    expect(cssInternals._test(
      ".foo { border-left: 2px solid red; border-right: 2px solid red; border-bottom: 2px solid red; border-top: 2px solid red; }",
      "",
    )).toBe(".foo {\n  border: 2px solid red;\n}\n");
  });

  test("minifies stylesheets and style attributes", () => {
    expect(cssInternals.minifyTest(
      "a { width: calc(3px * 2); color: rgb(255, 0, 0); }",
      "",
    )).toBe("a{color:red;width:6px}");
    expect(cssInternals.attrTest(
      "color: rgb(255, 0, 0); margin: 0px",
      "",
      true,
    )).toBe("color:red;margin:0");
  });

  test("applies browser prefix targets", () => {
    expect(cssInternals.prefixTest(
      ".foo { flex-direction: row; }",
      "",
      { safari: 4 << 16 },
    )).toBe(
      ".foo {\n" +
      "  -webkit-box-orient: horizontal;\n" +
      "  -webkit-box-direction: normal;\n" +
      "  -webkit-flex-direction: row;\n" +
      "  flex-direction: row;\n" +
      "}\n",
    );
  });
});
