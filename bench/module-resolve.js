import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const iterations = 2_000;
let resolved = "";

require.resolve("picomatch");
require.resolve("./json.js");

const nanotime = globalThis.cottontail?.nanotime ?? process.hrtime.bigint;
const start = nanotime();
for (let index = 0; index < iterations; index += 1) {
  resolved = require.resolve(index % 2 === 0 ? "picomatch" : "./json.js");
}
const elapsedNs = nanotime() - start;

if (!resolved.endsWith("json.js")) {
  throw new Error(`module resolution benchmark returned ${resolved}`);
}

console.log(`__bench_internal_ns__=${elapsedNs.toString()}`);
