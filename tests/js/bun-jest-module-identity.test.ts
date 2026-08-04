import * as bunTest from "bun:test";

const fileTest = Bun.jest(import.meta.path);

bunTest.test("Bun.jest shares the imported bun:test module", () => {
  bunTest.expect(fileTest.test).toBe(bunTest.test);
  bunTest.expect(fileTest.expect).toBe(bunTest.expect);
});

bunTest.describe("Bun.jest nested registration", () => {
  fileTest.test("reports dynamically registered results", () => {
    bunTest.expect(6 * 7).toBe(42);
  });
});
