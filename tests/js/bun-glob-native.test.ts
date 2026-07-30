import { Glob } from "bun";
import { expect, test } from "bun:test";

test("native Bun.Glob matcher is installed", () => {
  expect(typeof cottontail.globCompileNative).toBe("function");
  const matcher = cottontail.globCompileNative("hello/{world,friend}/**");
  expect(typeof matcher).toBe("function");
  expect(matcher("hello/friend/from/cottontail")).toBeTrue();
});

test("compact public patterns retain wildcard, class, brace, and negation behavior", () => {
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

test("compact public patterns preserve Unicode and WTF-8 edge behavior", () => {
  expect(new Glob("😎/¢£.{ts,tsx,js,jsx}").match("😎/¢£.tsx")).toBeTrue();
  expect(new Glob("F[ë£a]").match("F£")).toBeTrue();
  expect(new Glob("?ëlmao").match("ëëlmao")).toBeTrue();
  expect(new Glob("*").match("\uD800\uD800")).toBeTrue();
  expect(new Glob("hello/*/friends").match("hello/\uD800\uD800/friends")).toBeTrue();
  expect(new Glob("*.{js,\uD83D\u0027}").match("runtime.node.pre.out.js")).toBeTrue();
});

test("high-complexity public patterns demonstrably dispatch to native", () => {
  const host = cottontail as typeof cottontail & {
    globCompileNative: (pattern: string) => (path: string) => boolean;
  };
  const compile = host.globCompileNative;
  let calls = 0;
  host.globCompileNative = pattern => {
    calls += 1;
    return compile(pattern);
  };
  try {
    const glob = new Glob(
      "{src,extensions}/**/{common,browser,node,electron-main,electron-sandbox}/**/*{[cC]ontribution,[sS]ervice,*[pP]rovider*}.{ts,tsx,js,jsx}",
    );
    expect(calls).toBe(1);
    expect(glob.match("src/pkg/browser/feature/service-provider.ts")).toBeTrue();
    expect(glob.match("docs/pkg/browser/feature/service-provider.ts")).toBeFalse();
  } finally {
    host.globCompileNative = compile;
  }
});

test("native dispatch and guarded fallbacks match the prior JS matcher", () => {
  const host = cottontail as typeof cottontail & {
    globCompileNative?: (pattern: string) => (path: string) => boolean;
  };
  const compile = host.globCompileNative;
  expect(typeof compile).toBe("function");

  const cases: Array<{ native: boolean; pattern: string; paths: string[] }> = [
    {
      native: true,
      pattern: "{src,test,lib,app}/{a,b,{c,d}}/{one,two,three,four}/**/*.{js,ts,tsx,jsx}",
      paths: [
        "src/c/three/index.ts",
        "app/d/four/deep/component.jsx",
        "test/a/one/index.css",
        "docs/c/three/index.ts",
      ],
    },
    {
      native: true,
      pattern: "{src,test,lib,app}/{one,two,three,four}/[!a-c]*.{js,ts,tsx,jsx}",
      paths: [
        "src/one/delta.ts",
        "test/two/alpha.ts",
        "lib/three/δelta.jsx",
        "app/four/component.css",
      ],
    },
    {
      native: false,
      pattern: "{src,test,lib,app}/**/@(foo|bar|baz)-{one,two,three,four}.{js,ts,tsx,jsx}",
      paths: [
        "src/foo-one.ts",
        "test/deep/bar-three.jsx",
        "lib/deep/qux-two.js",
        "docs/baz-four.tsx",
      ],
    },
    {
      native: false,
      pattern: "!{src,test,lib,app}/**/{one,two,three,four}/*.{md,txt,rst,adoc}",
      paths: [
        "src/docs/one/readme.md",
        "app/deep/four/guide.adoc",
        "docs/one/readme.md",
        "src/docs/five/readme.md",
      ],
    },
    {
      native: true,
      pattern: "{src,test,lib,app}/{one,two,three,four}/{a,b,c,d}/**",
      paths: [
        "src/one/a/",
        "src/one/a/deep/file.ts",
        "test/four/d",
        "docs/one/a/deep/file.ts",
      ],
    },
    {
      native: true,
      pattern: "{你好,😎,\uD800x,café}/{一,二,三,四}/{α,β,γ,δ}/*.{js,ts,tsx,jsx}",
      paths: [
        "你好/一/α/入口.ts",
        "😎/四/δ/app.jsx",
        "\uD800x/二/β/file.js",
        "cafe/一/α/file.ts",
      ],
    },
  ];

  let nativeCompiles = 0;
  try {
    for (const { native, pattern, paths } of cases) {
      host.globCompileNative = undefined;
      const jsMatcher = new Glob(pattern);

      host.globCompileNative = value => {
        nativeCompiles += 1;
        return compile!(value);
      };
      const compileCountBefore = nativeCompiles;
      const nativeMatcher = new Glob(pattern);
      expect(nativeCompiles - compileCountBefore).toBe(native ? 1 : 0);

      for (const path of paths) {
        const nativeResult = nativeMatcher.match(path);
        const jsResult = jsMatcher.match(path);
        if (nativeResult !== jsResult) {
          throw new Error(
            `native Glob mismatch for ${JSON.stringify(pattern)} and ${JSON.stringify(path)}: ` +
              `native=${nativeResult}, js=${jsResult}`,
          );
        }
        expect(nativeResult).toBe(jsResult);
      }
    }
  } finally {
    host.globCompileNative = compile;
  }
  expect(nativeCompiles).toBe(cases.filter(entry => entry.native).length);
});

test("public matcher validation remains in JavaScript", () => {
  const glob = new Glob("*.js");
  expect(() => glob.match()).toThrow(TypeError);
  expect(() => glob.match(42 as never)).toThrow(TypeError);
  expect(() => glob.match({} as never)).toThrow(TypeError);
});
