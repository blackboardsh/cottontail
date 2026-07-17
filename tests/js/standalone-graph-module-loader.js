import { existsSync } from "node:fs";
import { createRequire, findSourceMap } from "node:module";

function assert(value, message) {
  if (!value) throw new Error(message);
}

const root = process.platform === "win32" ? "B:/~BUN/root" : "/$bunfs/root";
assert(!existsSync(root), "virtual standalone root must not exist on disk");

const sourceMap = JSON.stringify({
  version: 3,
  sources: ["static-source.ts"],
  names: [],
  mappings: "AAAA",
});

globalThis.__cottontailStandaloneFiles = new Map([
  [`${root}/chunk-main.js`, [
    'import { decorate } from "./static-dependency.mjs";',
    'import metadata from "./metadata.json";',
    'export const value = decorate(metadata.name);',
    'export async function readText() {',
    '  return (await import("./message.txt", { with: { type: "text" } })).default;',
    '}',
  ].join("\n")],
  [`${root}/static-dependency.mjs`, [
    'export function decorate(value) { return `embedded:${value}`; }',
    '//# sourceMappingURL=static-dependency.mjs.map',
  ].join("\n")],
  [`${root}/static-dependency.mjs.map`, sourceMap],
  [`${root}/metadata.json`, JSON.stringify({ name: "cottontail" })],
  [`${root}/message.txt`, "standalone graph text"],
  [`${root}/commonjs.cjs`, 'module.exports = require("./metadata.json").name;'],
]);

const require = createRequire(`${root}/entry.js`);
assert(require.resolve("./chunk-main.js") === `${root}/chunk-main.js`, "virtual chunk resolution mismatch");
assert(require("./commonjs.cjs") === "cottontail", "virtual CommonJS or JSON load mismatch");

const chunk = await globalThis.cottontail.importModule("./chunk-main.js", `${root}/entry.js`);
assert(chunk.value === "embedded:cottontail", "dynamic chunk static dependency mismatch");
assert(await chunk.readText() === "standalone graph text", "dynamic chunk text import mismatch");
assert(
  findSourceMap(`${root}/static-dependency.mjs`)?.findEntry(1, 0).originalSource === "static-source.ts",
  "virtual source-map load mismatch",
);

console.log("standalone graph module loader passed");
