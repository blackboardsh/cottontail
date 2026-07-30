const lengths = [16, 32, 64, 128, 256, 512, 1024, 4096, 16384];
const output = {};

for (const length of lengths) {
  const input = `\x1b[31m${"x".repeat(length)}\x1b[0m`;
  const iterations = Math.max(2_000, Math.ceil((32 * 1024 * 1024) / input.length));
  const samples = [];
  let checksum = 0;

  for (let warmup = 0; warmup < 1_000; warmup += 1) checksum += Bun.stripANSI(input).length;
  for (let sample = 0; sample < 7; sample += 1) {
    const start = Bun.nanoseconds();
    for (let index = 0; index < iterations; index += 1) {
      checksum += Bun.stripANSI(input).length;
    }
    samples.push(Bun.nanoseconds() - start);
  }

  samples.sort((left, right) => left - right);
  output[length] = {
    iterations,
    nsPerCall: samples[3] / iterations,
    checksum,
  };
}

console.log(JSON.stringify(output));
