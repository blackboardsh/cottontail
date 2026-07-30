const samples = 9;
const targetSampleNanoseconds = 20_000_000;
let checksum = 0;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function elapsedNanoseconds(callback, iterations) {
  const start = Bun.nanoseconds();
  let result = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    result += callback();
  }
  const elapsed = Bun.nanoseconds() - start;
  checksum ^= result;
  return elapsed;
}

function calibrate(callback) {
  let iterations = 1;
  while (iterations < 5_000_000) {
    const elapsed = elapsedNanoseconds(callback, iterations);
    if (elapsed >= targetSampleNanoseconds / 4) {
      const scale = Math.max(1, Math.ceil(targetSampleNanoseconds / elapsed));
      return Math.min(5_000_000, iterations * scale);
    }
    iterations *= 2;
  }
  return iterations;
}

function measure(callback) {
  const iterations = calibrate(callback);
  for (let warmup = 0; warmup < 3; warmup += 1) {
    elapsedNanoseconds(callback, Math.min(iterations, 1_000));
  }
  const timings = [];
  for (let sample = 0; sample < samples; sample += 1) {
    timings.push(elapsedNanoseconds(callback, iterations) / iterations);
  }
  return { iterations, nanoseconds: median(timings) };
}

function makeCase(size, position) {
  const bytes = new Uint8Array(size);
  bytes.fill(0x61);
  if (position === "start") bytes[1] = 10;
  else if (position === "middle") bytes[Math.floor(size / 2)] = 10;
  else if (position === "end") bytes[size - 1] = 10;
  return bytes;
}

const sizes = [
  ["32 B", 32],
  ["256 B", 256],
  ["1 KiB", 1_024],
  ["4 KiB", 4_096],
  ["2 MiB", 2 * 1024 * 1024],
  ["8 MiB", 8 * 1024 * 1024],
];
const positions = ["start", "middle", "end", "absent"];
const results = [];

for (const [sizeLabel, size] of sizes) {
  for (const position of positions) {
    const bytes = makeCase(size, position);
    const measurement = measure(() => Bun.indexOfLine(bytes, 0));
    results.push({
      case: `${sizeLabel} ${position}`,
      iterations: measurement.iterations,
      nanoseconds: measurement.nanoseconds,
    });
  }
}

for (const result of results) {
  console.log(
    `${result.case.padEnd(18)} ${result.nanoseconds.toFixed(2).padStart(12)} ns ` +
      `(${result.iterations} iterations)`,
  );
}
console.log(`checksum ${checksum}`);
