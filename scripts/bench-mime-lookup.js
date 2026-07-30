const targetSampleNs = 30_000_000n;
const sampleCount = 9;
let checksum = 0;

function elapsed(iterations, operation) {
  const start = cottontail.nanotime();
  for (let index = 0; index < iterations; index += 1) {
    checksum ^= operation(index).length;
  }
  return cottontail.nanotime() - start;
}

function benchmark(name, operation) {
  for (let index = 0; index < 5_000; index += 1) operation(index);

  let iterations = 1;
  while (elapsed(iterations, operation) < targetSampleNs && iterations < 16_777_216) {
    iterations *= 2;
  }

  const samples = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    samples.push(Number(elapsed(iterations, operation)) / iterations);
  }
  samples.sort((left, right) => left - right);
  const medianNs = samples[Math.floor(samples.length / 2)];
  console.log(`${name}: ${medianNs.toFixed(1)} ns/op (${iterations} iterations)`);
}

const paths = [
  "style.css",
  "/tmp/document.docx",
  "module.wasm",
  "data.json",
  "font.woff2",
  "no-extension.unknown",
  "UPPER.CSS",
];

if (process.env.COTTONTAIL_MIME_PUBLIC_ONLY !== "1") {
  const expectedPath = process.env.COTTONTAIL_MIME_EXPECTED_PATH;
  if (expectedPath) {
    const jsMimeTypes = new Map(JSON.parse(cottontail.readFile(expectedPath)));
    const jsGuessMimeType = path => {
      const name = String(path);
      const basenameStart = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1;
      const dot = name.lastIndexOf(".");
      if (dot <= basenameStart || dot === name.length - 1) return "application/octet-stream";
      return jsMimeTypes.get(name.slice(dot + 1)) ?? "application/octet-stream";
    };
    benchmark("guess-mime/js-table-mixed", index => jsGuessMimeType(paths[index % paths.length]));
    benchmark("guess-mime/js-table-known-css", () => jsGuessMimeType("style.css"));
    benchmark("guess-mime/js-table-unknown", () => jsGuessMimeType("style.unknown"));
  }

  if (typeof cottontail.mimeTypeByExtension === "function") {
    const { guessMimeType } = await import("../src/runtime_modules/bun/file-io.js");
    benchmark("guess-mime/native-cache-mixed", index => guessMimeType(paths[index % paths.length]));
    benchmark("guess-mime/native-cache-known-css", () => guessMimeType("style.css"));
    benchmark("guess-mime/native-cache-unknown", () => guessMimeType("style.unknown"));
    benchmark("lookup/native-known-css", () => cottontail.mimeTypeByExtension("css"));
    benchmark("lookup/native-unknown", () => cottontail.mimeTypeByExtension("unknown"));
  }
}
benchmark("bun-file/type-mixed", index => Bun.file(paths[index % paths.length]).type);
benchmark("bun-file/type-known-css", () => Bun.file("style.css").type);
benchmark("bun-file/type-unknown", () => Bun.file("style.unknown").type);

if (checksum === 0x7fffffff) console.log("unreachable checksum", checksum);
