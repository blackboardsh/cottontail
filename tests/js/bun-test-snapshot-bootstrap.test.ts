import { $ } from "bun";
import { expect, test } from "bun:test";

test("Bun shell drops empty interpolations", async () => {
  expect(await $`echo ${""} present`.text()).toBe("present\n");
  expect(await $`echo ${["", "present", ""]}`.text()).toBe("present\n");
});

test("creates and reloads a hinted external snapshot", () => {
  expect("").toMatchSnapshot(`""`);
});

test("formats multiline snapshot strings like Bun", () => {
  expect("line one\nline two").toMatchInlineSnapshot(`
    "line one
    line two"
  `);
  expect({ alpha: "line one\nline two", omega: "done" }).toMatchInlineSnapshot(`
    {
      "alpha": 
    "line one
    line two"
    ,
      "omega": "done",
    }
  `);
});
