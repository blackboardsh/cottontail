import { $ } from "bun";

if (process.platform === "linux") {
  const output = await $`sleep 5; printf child-ok`.quiet();
  if (output.stdout.toString() !== "child-ok") {
    throw new Error(`unexpected shell output: ${JSON.stringify(output.stdout.toString())}`);
  }
}

console.log("bun shell long top-level await passed");
