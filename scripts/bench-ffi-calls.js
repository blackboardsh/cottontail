import { FFIType, dlopen } from "bun:ffi";

const libc = process.platform === "darwin"
  ? "/usr/lib/libSystem.B.dylib"
  : process.platform === "win32"
    ? "msvcrt.dll"
    : "libc.so.6";
const iterations = Number(process.env.COTTONTAIL_FFI_BENCH_ITERATIONS || 500_000);
const rounds = Number(process.env.COTTONTAIL_FFI_BENCH_ROUNDS || 7);
const library = dlopen(libc, {
  abs: { args: [FFIType.i32], returns: FFIType.i32 },
});
const abs = library.symbols.abs;

let checksum = 0;
for (let index = 0; index < 50_000; index++) checksum += abs(-index);

const samples = [];
for (let round = 0; round < rounds; round++) {
  const started = performance.now();
  for (let index = 0; index < iterations; index++) checksum += abs(-index);
  samples.push(performance.now() - started);
}
samples.sort((left, right) => left - right);
const medianMs = samples[Math.floor(samples.length / 2)];

console.log(JSON.stringify({
  iterations,
  rounds,
  medianMs,
  nanosecondsPerCall: medianMs * 1e6 / iterations,
  samplesMs: samples,
  checksum,
}));
