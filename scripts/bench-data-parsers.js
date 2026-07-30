import { JSON5, TOML, YAML } from "bun";

const rounds = Number(process.env.COTTONTAIL_DATA_PARSER_BENCH_ROUNDS ?? 7);
const scale = Number(process.env.COTTONTAIL_DATA_PARSER_BENCH_SCALE ?? 1);
const engine = process.env.COTTONTAIL_DATA_PARSER_BENCH_ENGINE ?? "public";

if (engine === "js" && globalThis.cottontail?.yamlParseNative) {
  globalThis.cottontail.yamlParseNative = undefined;
}

const small = {
  json5: `{
    // Cottontail parser benchmark
    name: 'cottontail',
    enabled: true,
    ports: [3000, 3001,],
    ratio: .75,
  }`,
  toml: `
name = "cottontail"
enabled = true
ports = [3000, 3001]
[server]
host = "127.0.0.1"
ratio = 0.75
`,
  yaml: `
name: cottontail
enabled: true
ports:
  - 3000
  - 3001
server:
  host: 127.0.0.1
  ratio: 0.75
`,
};

const largeRows = Number(process.env.COTTONTAIL_DATA_PARSER_BENCH_ROWS ?? 4_000);
const large = {
  json5: `{
    rows: [
${Array.from({ length: largeRows }, (_, index) =>
  `      { id: ${index}, name: 'item-${index}', active: ${index % 2 === 0}, score: ${index}.25, tags: ['g${index % 8}', 'b${index % 16}'], },`
).join("\n")}
    ],
  }`,
  toml: Array.from({ length: largeRows }, (_, index) => `
[[rows]]
id = ${index}
name = "item-${index}"
active = ${index % 2 === 0}
score = ${index}.25
tags = ["g${index % 8}", "b${index % 16}"]
`).join(""),
  yaml: `rows:\n${Array.from({ length: largeRows }, (_, index) =>
  `  - id: ${index}\n    name: item-${index}\n    active: ${index % 2 === 0}\n    score: ${index}.25\n    tags: [g${index % 8}, b${index % 16}]`
).join("\n")}\n`,
};

const parsers = {
  json5: JSON5.parse,
  toml: TOML.parse,
  yaml: YAML.parse,
};

function rowCount(result) {
  if (Array.isArray(result?.rows)) return result.rows.length;
  return result?.name === "cottontail" ? 1 : 0;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(name, size, source, iterations) {
  const parse = parsers[name];
  let checksum = 0;
  for (let index = 0; index < 5; index += 1) checksum += rowCount(parse(source));

  const samplesMs = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      checksum += rowCount(parse(source));
    }
    samplesMs.push(performance.now() - started);
  }

  const medianMs = median(samplesMs);
  return {
    parser: name,
    size,
    bytes: new TextEncoder().encode(source).byteLength,
    iterations,
    medianMs,
    microsecondsPerParse: medianMs * 1_000 / iterations,
    checksum,
    samplesMs,
  };
}

const results = [];
for (const name of Object.keys(parsers)) {
  results.push(measure(name, "small", small[name], Math.max(1, Math.round(2_000 * scale))));
  results.push(measure(name, "large", large[name], Math.max(1, Math.round(3 * scale))));
}

console.log(JSON.stringify({ engine, rounds, largeRows, results }, null, 2));
