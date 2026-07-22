import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Bun.build plugin graphs ignore imports in comments and strings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-plugin-import-scan-"));
  const entry = join(directory, "entry.ts");
  const ignored = join(directory, "ignored.svelte");
  let ignoredLoads = 0;

  writeFileSync(entry, [
    '// import component from "./ignored.svelte";',
    '/* require("./ignored.svelte"); */',
    'const text = \'import("./ignored.svelte")\';',
    "export default text;",
    "",
  ].join("\n"));
  writeFileSync(ignored, "this is not a JavaScript module\n");

  try {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      throw: false,
      plugins: [{
        name: "ignored-comment-import",
        setup(build) {
          build.onLoad({ filter: /ignored\.svelte$/ }, () => {
            ignoredLoads++;
            throw new Error("commented imports must not enter the plugin graph");
          });
        },
      }],
    });

    expect(result.success).toBe(true);
    expect(ignoredLoads).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
