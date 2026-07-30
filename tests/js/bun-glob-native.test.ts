import { Glob } from "bun";
import { expect, test } from "bun:test";

test("native Bun.Glob matcher is installed", () => {
  expect(typeof cottontail.globCompileNative).toBe("function");
  const matcher = cottontail.globCompileNative("hello/{world,friend}/**");
  expect(typeof matcher).toBe("function");
  expect(matcher("hello/friend/from/cottontail")).toBeTrue();
});

test("native matcher preserves wildcard, class, brace, and negation behavior", () => {
  const cases: Array<[string, string, boolean]> = [
    ["*", "", true],
    ["*.ts", "index.ts", true],
    ["*.ts", "src/index.ts", false],
    ["src/*/*.ts", "src/lib/index.ts", true],
    ["src/*/*.ts", "src/index.ts", false],
    ["src/**/*.ts", "src/index.ts", true],
    ["src/**/*.ts", "src/lib/deep/index.ts", true],
    ["foo/**", "foo", false],
    ["foo/**", "foo/", true],
    ["foo/**", "foo/bar/baz", true],
    ["[!a-c].js", "d.js", true],
    ["[!a-c].js", "b.js", false],
    ["index.{ts,tsx,js,jsx}", "index.tsx", true],
    ["index.{ts,tsx,js,jsx}", "index.css", false],
    ["a{b,c{d,e}}f", "acef", true],
    ["a{b,c{d,e}}f", "accf", false],
    ["!**/*.md", "src/index.js", true],
    ["!**/*.md", "src/readme.md", false],
  ];

  for (const [pattern, path, expected] of cases) {
    expect(new Glob(pattern).match(path)).toBe(expected);
  }
});

test("native matcher preserves Unicode and WTF-8 edge behavior", () => {
  expect(new Glob("😎/¢£.{ts,tsx,js,jsx}").match("😎/¢£.tsx")).toBeTrue();
  expect(new Glob("F[ë£a]").match("F£")).toBeTrue();
  expect(new Glob("?ëlmao").match("ëëlmao")).toBeTrue();
  expect(new Glob("*").match("\uD800\uD800")).toBeTrue();
  expect(new Glob("hello/*/friends").match("hello/\uD800\uD800/friends")).toBeTrue();
  expect(new Glob("*.{js,\uD83D\u0027}").match("runtime.node.pre.out.js")).toBeTrue();
});

test("public matcher validation remains in JavaScript", () => {
  const glob = new Glob("*.js");
  expect(() => glob.match()).toThrow(TypeError);
  expect(() => glob.match(42 as never)).toThrow(TypeError);
  expect(() => glob.match({} as never)).toThrow(TypeError);
});
