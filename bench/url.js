import {
  domainToASCII,
  domainToUnicode,
  fileURLToPath,
  pathToFileURL,
} from "node:url";

const nativeParseForm = cottontail.urlParseForm;

const samples = [
  "https://user:pass@example.com:8443/a/b/../c?q=hello%20world#fragment",
  "https://例え.テスト/資料/一?name=値&empty=#片",
  "http://0x7f.1:80/a/./b/../../c?x=1&x=2",
  "file:///tmp/cottontail%20url/%E6%B8%AC%E8%A9%A6.txt",
  "custom:opaque path?query=value#hash",
];

function now() {
  return cottontail.nanotime();
}

function measure(name, iterations, operation) {
  let checksum = 0;
  for (let index = 0; index < 500; index += 1) checksum ^= operation(index);

  const startedAt = now();
  for (let index = 0; index < iterations; index += 1) checksum ^= operation(index);
  const elapsed = now() - startedAt;
  const nsPerOperation = Number(elapsed) / iterations;
  console.log(`${name}: ${nsPerOperation.toFixed(1)} ns/op (${checksum})`);
  return elapsed;
}

function sample(iterations, operation) {
  let checksum = 0;
  for (let index = 0; index < 1_000; index += 1) checksum ^= operation(index);

  const startedAt = now();
  for (let index = 0; index < iterations; index += 1) checksum ^= operation(index);
  const elapsed = now() - startedAt;
  return { elapsed, nsPerOperation: Number(elapsed) / iterations, checksum };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function compareFormParser(name, input, iterations, lookup) {
  const adaptive = [];
  const js = [];
  let elapsed = 0;
  let checksum = 0;
  const operation = () => {
    const params = new URLSearchParams(input);
    return params.size + params.get(lookup).length;
  };

  for (let round = 0; round < 7; round += 1) {
    const modes = round % 2 === 0 ? ["adaptive", "js"] : ["js", "adaptive"];
    for (const mode of modes) {
      cottontail.urlParseForm = mode === "adaptive" ? nativeParseForm : undefined;
      const result = sample(iterations, operation);
      elapsed += result.elapsed;
      checksum ^= result.checksum;
      (mode === "adaptive" ? adaptive : js).push(result.nsPerOperation);
    }
  }
  cottontail.urlParseForm = nativeParseForm;

  const adaptiveMedian = median(adaptive);
  const jsMedian = median(js);
  const change = ((jsMedian - adaptiveMedian) / jsMedian) * 100;
  console.log(
    `search-params-parse-${name}: adaptive=${adaptiveMedian.toFixed(1)} ns/op ` +
      `js=${jsMedian.toFixed(1)} ns/op change=${change.toFixed(1)}% (${checksum})`
  );
  return elapsed;
}

let total = 0;
total += measure("url-parse-and-read", 20_000, (index) => {
  const url = new URL(samples[index % samples.length], "https://base.example/root/");
  return url.href.length + url.hostname.length + url.pathname.length + url.search.length;
});

total += measure("url-parse-no-base", 20_000, (index) => {
  const url = new URL(samples[index % samples.length]);
  return url.href.length + url.hostname.length + url.pathname.length + url.search.length;
});

const mutable = new URL("https://user:pass@example.com:8080/a?x=1#old");
total += measure("url-mutate-and-read", 20_000, (index) => {
  mutable.pathname = `/items/${index}/../current`;
  mutable.search = `?query=${index}&value=hello world`;
  mutable.hash = `#${index}`;
  return mutable.href.length;
});

const forms = [
  ["short-ascii", "name=value+one", 40_000, "name", false],
  [
    "large-ascii",
    Array.from(
      { length: 24 },
      (_, index) => `name${index}=value${index}`
    ).join("&"),
    20_000,
    "name12",
    false,
  ],
  [
    "encoded-unicode-below-threshold",
    Array.from(
      { length: 3 },
      (_, index) => `name+${index}=${encodeURIComponent(`value ${index} 測試`)}`
    ).join("&"),
    20_000,
    "name 1",
    false,
  ],
  [
    "encoded-unicode",
    Array.from({ length: 6 }, (_, index) =>
      `name+${index}=${encodeURIComponent(`value ${index} 測試`)}`
    ).join("&"),
    20_000,
    "name 3",
    true,
  ],
  [
    "large",
    Array.from(
      { length: 24 },
      (_, index) => `name+${index}=${encodeURIComponent(`value ${index} 測試`)}`
    ).join("&"),
    10_000,
    "name 12",
    true,
  ],
];

for (const [name, input, iterations, lookup, usesNative] of forms) {
  if (usesNative) {
    total += compareFormParser(name, input, iterations, lookup);
  } else {
    total += measure(`search-params-parse-${name}-js-route`, iterations, () => {
      const params = new URLSearchParams(input);
      return params.size + params.get(lookup).length;
    });
  }
}

const params = new URLSearchParams(forms[4][1]);
total += measure("search-params-serialize", 20_000, () => params.toString().length);

const unicodeDomains = ["例え.テスト", "mañana.com", "bücher.example", "δοκιμή.gr"];
total += measure("domain-idna", 20_000, (index) => {
  const ascii = domainToASCII(unicodeDomains[index % unicodeDomains.length]);
  return ascii.length + domainToUnicode(ascii).length;
});

const paths = [
  "/tmp/cottontail url/file#1?.txt",
  "/Users/example/資料/測試.txt",
  "/opt/cottontail/a/b/c/d/e/f/g.js",
];
total += measure("file-url-round-trip", 20_000, (index) => {
  const fileURL = pathToFileURL(paths[index % paths.length]);
  return fileURLToPath(fileURL).length + fileURL.href.length;
});

console.log(`__bench_internal_ns__=${total}`);
