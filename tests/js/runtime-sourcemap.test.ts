import { expect, test } from "bun:test";
import {
  createSourceMapConsumer,
  remapStackString,
} from "../../src/runtime_modules/vendor/sourcemap.js";

test("large source maps decode only the requested source content", () => {
  const selectedSource = [
    'const message = "escaped\\ntext";',
    "throw new Error(message);",
    "",
  ].join("\n");
  const map = JSON.stringify({
    version: 3,
    metadata: { nested: [{ ignored: true }] },
    names: [],
    sources: ["src/input.js", "src/unrelated.js"],
    sourcesContent: [selectedSource, "x".repeat(2 * 1024 * 1024)],
    sourceRoot: "../",
    mappings: "AAAA;AACA",
  });

  const consumer = createSourceMapConsumer(map, {
    mapPath: "/tmp/project/out/app.js.map",
    bundlePath: "/tmp/project/out/app.js",
    sourceRoot: "/tmp/project/out",
  });

  expect(consumer?.originalPositionFor(2, 1)).toEqual({
    source: "/tmp/project/src/input.js",
    line: 2,
    column: 1,
    lines: selectedSource.split("\n"),
  });
});

test("Windows bundle frames remap case-insensitively without duplicating an absolute source root", () => {
  const runtimeGlobal = globalThis as typeof globalThis & {
    __cottontailBundlePath?: string;
    __cottontailBundleSourceMap?: string;
    __cottontailBundleSourceMapData?: string;
    __cottontailBundleSourceRoot?: string;
  };
  const previous = {
    bundlePath: runtimeGlobal.__cottontailBundlePath,
    sourceMap: runtimeGlobal.__cottontailBundleSourceMap,
    sourceMapData: runtimeGlobal.__cottontailBundleSourceMapData,
    sourceRoot: runtimeGlobal.__cottontailBundleSourceRoot,
  };

  try {
    runtimeGlobal.__cottontailBundlePath = "C:\\Repo\\run\\script.bundle.mjs";
    runtimeGlobal.__cottontailBundleSourceMap = undefined;
    runtimeGlobal.__cottontailBundleSourceMapData = JSON.stringify({
      version: 3,
      names: [],
      sources: ["[eval]"],
      sourcesContent: ['throw new Error("boom");'],
      sourceRoot: "C:\\Repo",
      mappings: "AAAA",
    });
    runtimeGlobal.__cottontailBundleSourceRoot = "C:\\Repo";

    expect(remapStackString("boom@c:\\repo\\run\\script.bundle.mjs:1:1"))
      .toBe("boom@C:/Repo/[eval]:1:1");
  } finally {
    runtimeGlobal.__cottontailBundlePath = previous.bundlePath;
    runtimeGlobal.__cottontailBundleSourceMap = previous.sourceMap;
    runtimeGlobal.__cottontailBundleSourceMapData = previous.sourceMapData;
    runtimeGlobal.__cottontailBundleSourceRoot = previous.sourceRoot;
  }
});
