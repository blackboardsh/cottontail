// @bun
const namespace = await import("./fixtures/bun-artifact-config.jsonc");
const config = namespace.default ?? namespace;

if (config.answer !== 42) {
  throw new Error("dynamic import in a // @bun artifact was not rewritten");
}

console.log("bun transpiled dynamic import passed");
