const rounds = Number(process.env.COTTONTAIL_UUID_BENCH_ROUNDS ?? 9);
const scale = Number(process.env.COTTONTAIL_UUID_BENCH_SCALE ?? 1);
const fixedTimestamp = 1_625_097_600_000;
const dnsNamespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const nameBytes = new TextEncoder().encode("www.example.com");
const longName = `cottontail-${"测试🌟".repeat(64)}`;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function checksumValue(value) {
  if (typeof value === "string") {
    return value.length + value.charCodeAt(value.length - 1);
  }
  return value.byteLength + value[15];
}

function measure(name, iterations, operation) {
  let checksum = 0;
  for (let index = 0; index < Math.min(iterations, 5_000); index += 1) {
    checksum += checksumValue(operation(index));
  }

  const samplesMs = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      checksum += checksumValue(operation(index));
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

const scaled = count => Math.max(1, Math.round(count * scale));
const results = [
  measure("v7-fixed-hex", scaled(150_000), () => Bun.randomUUIDv7("hex", fixedTimestamp)),
  measure("v7-current-hex", scaled(150_000), () => Bun.randomUUIDv7()),
  measure("v7-fixed-base64url", scaled(100_000), () => Bun.randomUUIDv7("base64url", fixedTimestamp)),
  measure("v7-fixed-buffer", scaled(100_000), () => Bun.randomUUIDv7("buffer", fixedTimestamp)),
  measure("v5-short-alias-hex", scaled(75_000), index => Bun.randomUUIDv5(`name-${index & 255}`, "dns")),
  measure("v5-buffer-hex", scaled(75_000), () => Bun.randomUUIDv5(nameBytes, dnsNamespace)),
  measure("v5-long-unicode-base64", scaled(20_000), () => Bun.randomUUIDv5(longName, "url", "base64")),
];

console.log(JSON.stringify({ rounds, results }, null, 2));
