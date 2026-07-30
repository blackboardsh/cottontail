import { Glob } from "bun";

const engine = process.env.COTTONTAIL_GLOB_BENCH_ENGINE ?? "native";
const rounds = Number(process.env.COTTONTAIL_GLOB_BENCH_ROUNDS ?? 7);
const scale = Number(process.env.COTTONTAIL_GLOB_BENCH_SCALE ?? 1);

if (engine === "js") {
  globalThis.cottontail.globCompileNative = undefined;
}

const simplePattern = "src/**/*.ts";
const bracePattern = "index.{ts,tsx,js,jsx}";
const complexPattern = "{src,extensions}/**/{common,browser,node,electron-main,electron-sandbox}/**/*{[cC]ontribution,[sS]ervice,*[pP]rovider*}.{ts,tsx,js,jsx}";
const simplePaths = [
  "src/index.ts",
  "src/lib/index.ts",
  "src/lib/deep/component.ts",
  "src/index.js",
  "test/index.ts",
  "src/lib/component.tsx",
];
const complexPaths = Array.from({ length: 512 }, (_, index) => {
  const root = index % 3 === 0 ? "extensions" : "src";
  const layer = ["common", "browser", "node", "electron-main"][index % 4];
  const stem = index % 5 === 0 ? "service" : index % 7 === 0 ? "Provider" : "component";
  const extension = index % 6 === 0 ? "js" : "ts";
  return `${root}/pkg-${index % 32}/${layer}/feature-${index}/${stem}-${index}.${extension}`;
});
const bracePaths = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.css", "src/index.ts"];

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(name, iterations, operation) {
  let checksum = 0;
  for (let index = 0; index < Math.min(iterations, 2_000); index += 1) {
    checksum += operation(index);
  }

  const samplesMs = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      checksum += operation(index);
    }
    samplesMs.push(performance.now() - started);
  }

  const medianMs = median(samplesMs);
  return {
    name,
    iterations,
    medianMs,
    nanosecondsPerOperation: medianMs * 1e6 / iterations,
    samplesMs,
    checksum,
  };
}

const simpleMatcher = new Glob(simplePattern);
const braceMatcher = new Glob(bracePattern);
const complexMatcher = new Glob(complexPattern);
const results = [
  measure("simple-construction", Math.max(1, Math.round(20_000 * scale)), index => {
    return new Glob(simplePattern).match(simplePaths[index % simplePaths.length]) ? 1 : 0;
  }),
  measure("simple-repeated-match", Math.max(1, Math.round(300_000 * scale)), index => {
    return simpleMatcher.match(simplePaths[index % simplePaths.length]) ? 1 : 0;
  }),
  measure("brace-construction", Math.max(1, Math.round(10_000 * scale)), index => {
    return new Glob(bracePattern).match(bracePaths[index % bracePaths.length]) ? 1 : 0;
  }),
  measure("brace-repeated-match", Math.max(1, Math.round(200_000 * scale)), index => {
    return braceMatcher.match(bracePaths[index % bracePaths.length]) ? 1 : 0;
  }),
  measure("complex-construction", Math.max(1, Math.round(4_000 * scale)), index => {
    return new Glob(complexPattern).match(complexPaths[index % complexPaths.length]) ? 1 : 0;
  }),
  measure("complex-repeated-match", Math.max(1, Math.round(100_000 * scale)), index => {
    return complexMatcher.match(complexPaths[index % complexPaths.length]) ? 1 : 0;
  }),
];

console.log(JSON.stringify({ engine, rounds, results }, null, 2));
