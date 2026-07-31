import { posix, win32 } from "node:path";

const iterations = 200_000;
const rounds = 5;
const requestedFixture = process.argv[2];
let checksum = 0;
const nanotime = globalThis.cottontail?.nanotime ?? process.hrtime.bigint;

const fixtures = {
  posix: {
    short: "/usr/local/../bin/tool.js",
    long: `/${Array.from({ length: 32 }, (_, index) => `segment-${index}/..`).join("/")}/dist/tool.bundle.js`,
  },
  win32: {
    short: "C:\\Program Files\\cottontail\\..\\bin\\tool.js",
    long: `C:\\${Array.from({ length: 32 }, (_, index) => `segment-${index}\\..`).join("\\")}\\dist\\tool.bundle.js`,
  },
};

function consume(value) {
  checksum = (checksum + value.length + (value.charCodeAt(0) || 0)) | 0;
}

function measure(label, callback) {
  for (let index = 0; index < 5_000; index++) consume(callback());
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    const startedAt = nanotime();
    for (let index = 0; index < iterations; index++) consume(callback());
    samples.push(nanotime() - startedAt);
  }
  samples.sort((left, right) => left - right);
  console.log(`${label}.median_ns=${samples[Math.floor(samples.length / 2)]}`);
  console.log(`${label}.samples_ns=${samples.join(",")}`);
}

for (const [platformName, implementation] of [["posix", posix], ["win32", win32]]) {
  for (const size of ["short", "long"]) {
    if (requestedFixture && requestedFixture !== `${platformName}.${size}`) continue;
    const fixture = fixtures[platformName][size];
    console.log(`${platformName}.${size}.length=${fixture.length}`);
    measure(`${platformName}.${size}.public`, () => implementation.normalize(fixture));
  }
}

console.log(`checksum=${checksum}`);
