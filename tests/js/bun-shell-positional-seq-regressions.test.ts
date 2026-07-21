import { expect, test } from "bun:test";
import { $ } from "bun";

test("unbraced positional parameters consume one digit", async () => {
  const output = await $`
    echo "one=$1"
    echo "ten=$10"
    echo "eleven=$11suffix"
    echo "nine=$9"
    echo "ninety=$90"
  `.quiet();
  const [one, ten, eleven, nine, ninety] = output.stdout.toString()
    .trimEnd()
    .split("\n")
    .map(value => value.slice(value.indexOf("=") + 1));

  expect(ten).toBe(`${one}0`);
  expect(eleven).toBe(`${one}1suffix`);
  expect(ninety).toBe(`${nine}0`);
});

test("seq ignores operands after its third numeric operand", async () => {
  const output = await $`seq 1 2 3 ignored invalid`.quiet().nothrow();

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("1\n3\n");
  expect(output.stderr.toString()).toBe("");
});
