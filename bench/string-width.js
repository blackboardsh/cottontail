const sampleCount = 11;
const targetSampleMs = 80;

const cases = [
  ["ascii/1", "x"],
  ["ascii/4", "done"],
  ["ascii/8", "complete"],
  ["ascii/16", "build complete!!"],
  ["ascii/32", "status: compiling package 42/100"],
  ["ascii/64", "build complete; ".repeat(5).slice(0, 64)],
  ["ascii/128", "build complete; ".repeat(9).slice(0, 128)],
  ["ascii/256", "build complete; ".repeat(17).slice(0, 256)],
  ["ascii/1024", "build complete; ".repeat(69).slice(0, 1024)],
  ["ascii/16384", "build complete; ".repeat(1100).slice(0, 16384)],
  ["ansi/16384", "\x1b[31merror\x1b[0m: package failed\n".repeat(512)],
  ["cjk/8192", "界古池や".repeat(2048)],
  ["fallback-emoji/8192", "build 👩‍👩‍👦‍👦 complete\n".repeat(512)],
];

function median(values) {
  return values.slice().sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function measure(operation) {
  let iterations = 1;
  let checksum = 0;
  for (;;) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      checksum += operation();
    }
    const elapsed = performance.now() - started;
    if (elapsed >= targetSampleMs) break;
    iterations = Math.max(iterations + 1, Math.ceil(iterations * targetSampleMs / Math.max(elapsed, 0.01)));
  }

  const samples = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      checksum += operation();
    }
    samples.push((performance.now() - started) * 1e6 / iterations);
  }
  if (checksum === 0) throw new Error("string width benchmark was optimized away");
  return { medianNs: median(samples), iterations };
}

const results = {};
for (const [name, input] of cases) {
  if (process.env.STRING_WIDTH_BENCH_FILTER && name !== process.env.STRING_WIDTH_BENCH_FILTER) {
    continue;
  }
  results[name] = measure(() => Bun.stringWidth(input));
  if (name.startsWith("ascii/") && typeof globalThis.cottontail?.stringWidthNative === "function") {
    results[`${name}/direct-native`] = measure(
      () => globalThis.cottontail.stringWidthNative(input, false, true),
    );
  }
}
console.log(JSON.stringify(results, null, 2));
