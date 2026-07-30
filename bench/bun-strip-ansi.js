const cases = {
  "small-no-op": "plain text without controls",
  "small-csi": "\x1b[31mhello world\x1b[0m",
  "large-no-op": "plain \ud83d\ude80 text ".repeat(4096),
  "large-sparse-csi": ("plain text ".repeat(64) + "\x1b[38;2;255;0;0mred\x1b[0m").repeat(128),
  "large-control-heavy": "\x1b[1mA\x1b[0m\x9b32mB\x9b0m".repeat(8192),
  "large-osc": ("prefix\x1b]8;;https://example.com/path\x07link\x1b]8;;\x1b\\suffix").repeat(4096),
  "large-unicode": ("你好\ud83d\ude80e\u0301\x1b[35m世界\ud83d\ude00\x1b[0m").repeat(4096),
};

const samples = 11;
const targetCodeUnits = 64 * 1024 * 1024;
const output = {};

for (const [name, input] of Object.entries(cases)) {
  const iterations = Math.max(100, Math.min(2_000_000, Math.ceil(targetCodeUnits / Math.max(input.length, 1))));
  let checksum = 0;
  for (let index = 0; index < 200; index += 1) checksum += Bun.stripANSI(input).length;

  const timings = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const start = Bun.nanoseconds();
    for (let index = 0; index < iterations; index += 1) {
      checksum += Bun.stripANSI(input).length;
    }
    timings.push(Bun.nanoseconds() - start);
  }
  timings.sort((left, right) => left - right);
  output[name] = {
    inputLength: input.length,
    iterations,
    medianNs: timings[Math.floor(timings.length / 2)],
    checksum,
  };
}

console.log(JSON.stringify(output));
