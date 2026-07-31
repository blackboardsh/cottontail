let accumulator = 0;

const nanotime = globalThis.cottontail?.nanotime ?? process.hrtime.bigint;
const start = nanotime();
for (let i = 0; i < 200_000; i += 1) {
  accumulator += i;
}
const elapsedNs = nanotime() - start;

if (accumulator <= 0) {
  throw new Error("loop benchmark accumulator failed");
}

console.log(`__bench_internal_ns__=${elapsedNs.toString()}`);
