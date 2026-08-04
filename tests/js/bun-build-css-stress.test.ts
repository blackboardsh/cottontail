import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-css-build-stress-"));
const entrypoint = join(root, "input.css");

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("Bun.build serializes 300 nested CSS at-rules", async () => {
  const source = "@media screen {".repeat(300) + ".test{color:red}" + "}".repeat(300);
  await Bun.write(entrypoint, source);

  const result = await Bun.build({ entrypoints: [entrypoint] });
  expect(result.success).toBe(true);
  expect(result.outputs).toHaveLength(1);
  expect(await result.outputs[0].text()).toContain(".test");
}, 10_000);

test("repeated small CSS builds stay within a normal test deadline", async () => {
  const inputs = [
    ".test{color:}",
    ".test{:red}",
    "@media screen { .test { color: red } }",
    ".test{color:red;;;}",
  ];

  for (let index = 0; index < 600; index++) {
    await Bun.write(entrypoint, inputs[index % inputs.length]);
    try {
      await Bun.build({ entrypoints: [entrypoint] });
    } catch {
      // Invalid CSS may reject; completion without a crash is the contract.
    }
  }
}, 10_000);
