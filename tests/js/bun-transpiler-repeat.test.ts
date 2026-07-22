import { expect, test } from "bun:test";

test("repeated pure transforms return the same output", async () => {
  const source = Array.from(
    { length: 64 },
    (_, index) => `export const value${index}: number = ${index};`,
  ).join("\n");
  const transforms = Array.from(
    { length: 32 },
    () => new Bun.Transpiler({ loader: "ts" }).transform(source),
  );
  const outputs = await Promise.all(transforms);

  expect(new Set(outputs).size).toBe(1);
  expect(outputs[0]).toContain("export const value63 = 63");
});
