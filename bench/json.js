const rows = [];

for (let i = 0; i < 4000; i += 1) {
  rows.push({
    id: i,
    label: `item-${i}`,
    enabled: i % 2 === 0,
    score: i * 3,
    tags: [`group-${i % 8}`, `bucket-${i % 16}`],
    meta: {
      phase: i % 5,
      active: i % 3 === 0,
    },
  });
}

const start = cottontail.nanotime();
const encoded = JSON.stringify(rows);
const decoded = JSON.parse(encoded);
const elapsedNs = cottontail.nanotime() - start;

if (decoded.length !== rows.length) {
  throw new Error("json benchmark roundtrip failed");
}

console.log(`__bench_internal_ns__=${elapsedNs.toString()}`);
