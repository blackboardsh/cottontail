const rounds = Number(process.env.COTTONTAIL_TEXT_BENCH_ROUNDS ?? 7);
const scale = Number(process.env.COTTONTAIL_TEXT_BENCH_SCALE ?? 1);

const cases = [
  {
    operation: "escapeHTML",
    case: "small-escaped",
    input: "<div title=\"x\">Tom & Jerry's</div>",
    iterations: 100_000,
    run(input) {
      return Bun.escapeHTML(input).length;
    },
  },
  {
    operation: "escapeHTML",
    case: "large-ascii",
    input: "cottontail runtime text ".repeat(2_800),
    iterations: 250,
    run(input) {
      return Bun.escapeHTML(input).length;
    },
  },
  {
    operation: "escapeHTML",
    case: "large-escaped",
    input: "<cottontail title=\"native\">&'".repeat(2_200),
    iterations: 150,
    run(input) {
      return Bun.escapeHTML(input).length;
    },
  },
  {
    operation: "stripANSI",
    case: "small-ansi",
    input: "\x1b[31mred\x1b[0m plain",
    iterations: 100_000,
    run(input) {
      return Bun.stripANSI(input).length;
    },
  },
  {
    operation: "stripANSI",
    case: "large-ansi",
    input: "\x1b[38;2;255;0;0mred\x1b[0m plain \x1b]8;;https://example.com\x07link\x1b]8;;\x07 ".repeat(1_200),
    iterations: 200,
    run(input) {
      return Bun.stripANSI(input).length;
    },
  },
  {
    operation: "stripANSI",
    case: "large-plain",
    input: "plain terminal output ".repeat(3_200),
    iterations: 2_000,
    run(input) {
      return Bun.stripANSI(input).length;
    },
  },
  {
    operation: "stringWidth",
    case: "small-ascii",
    input: "cottontail",
    iterations: 250_000,
    run(input) {
      return Bun.stringWidth(input);
    },
  },
  {
    operation: "stringWidth",
    case: "ascii-256",
    input: "a".repeat(256),
    iterations: 100_000,
    run(input) {
      return Bun.stringWidth(input);
    },
  },
  {
    operation: "stringWidth",
    case: "ascii-4096",
    input: "a".repeat(4_096),
    iterations: 10_000,
    run(input) {
      return Bun.stringWidth(input);
    },
  },
  {
    operation: "stringWidth",
    case: "large-ascii",
    input: "cottontail runtime text ".repeat(2_800),
    iterations: 1_000,
    run(input) {
      return Bun.stringWidth(input);
    },
  },
  {
    operation: "stringWidth",
    case: "large-unicode",
    input: "Cottontail 👩‍💻 🇨🇦 1️⃣ カタカナ e\u0301 \u00b1 ".repeat(1_500),
    iterations: 250,
    run(input) {
      return Bun.stringWidth(input);
    },
  },
  {
    operation: "stringWidth",
    case: "large-ansi",
    input: "\x1b[31mred\x1b[0m \x1b]8;;https://example.com\x07link\x1b]8;;\x07 ".repeat(2_000),
    iterations: 250,
    run(input) {
      return Bun.stringWidth(input);
    },
  },
];

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(entry) {
  let checksum = 0;
  const iterations = Math.max(1, Math.round(entry.iterations * scale));
  for (let index = 0; index < 100; index += 1) checksum += entry.run(entry.input);

  const samplesMs = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      checksum += entry.run(entry.input);
    }
    samplesMs.push(performance.now() - started);
  }
  const medianMs = median(samplesMs);
  return {
    operation: entry.operation,
    case: entry.case,
    codeUnits: entry.input.length,
    iterations,
    medianMs,
    nanosecondsPerCall: medianMs * 1_000_000 / iterations,
    checksum,
    samplesMs,
  };
}

console.log(JSON.stringify({ rounds, results: cases.map(measure) }, null, 2));
