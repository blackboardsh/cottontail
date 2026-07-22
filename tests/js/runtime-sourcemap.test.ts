import { expect, test } from "bun:test";
import { createSourceMapConsumer } from "../../src/runtime_modules/vendor/sourcemap.js";

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
