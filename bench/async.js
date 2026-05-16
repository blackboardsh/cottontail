let total = 0;

const start = cottontail.nanotime();
for (let i = 0; i < 5000; i += 1) {
  total += await Promise.resolve(i);
}
const elapsedNs = cottontail.nanotime() - start;

if (total <= 0) {
  throw new Error('async benchmark total failed');
}

console.log(`__bench_internal_ns__=${elapsedNs.toString()}`);

export {};
