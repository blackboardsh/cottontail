import { expect, test } from "bun:test";
import { getCallSites, parseEnv, styleText } from "node:util";

test("parseEnv handles quotes, comments, exports, and multiline values", () => {
  expect(parseEnv([
    "A=unquoted#comment",
    "export B = 'quoted # value' # comment",
    'C="first\\nsecond"',
    "D=`first",
    "second` # comment",
  ].join("\n"))).toEqual({
    A: "unquoted",
    B: "quoted # value",
    C: "first\nsecond",
    D: "first\nsecond",
  });
});

test("getCallSites starts at the util caller", () => {
  function capture() {
    return getCallSites(2);
  }

  const sites = capture();
  expect(sites).toHaveLength(2);
  expect(sites[0].functionName).toBe("capture");
  expect(sites[0].scriptName).toContain("node-util-native-bindings.test.ts");
});

test("styleText validates an explicitly supplied stream", () => {
  expect(() => styleText("red", "text", { stream: {} as NodeJS.WritableStream })).toThrow();
  expect(styleText("red", "text")).toContain("\x1b[31m");
});
