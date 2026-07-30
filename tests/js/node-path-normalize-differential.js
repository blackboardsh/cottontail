import path from "node:path";

const casesPerPlatform = Number.parseInt(process.argv[2] ?? "20000", 10);
if (!Number.isSafeInteger(casesPerPlatform) || casesPerPlatform <= 0) {
  throw new TypeError("case count must be a positive integer");
}

let randomState = 0x6d2b79f5;

function randomUint32() {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return randomState >>> 0;
}

function randomInt(limit) {
  return randomUint32() % limit;
}

const components = [
  "",
  ".",
  "..",
  "...",
  "....",
  "a...",
  "δ...",
  "alpha",
  "βeta",
  "終",
  "file..",
  "space name",
  "\ud800x",
  "0",
];

function separator(windows) {
  const value = windows && randomInt(2) === 0 ? "\\" : "/";
  return value.repeat(1 + randomInt(3));
}

function component() {
  if (randomInt(4) === 0) return `segment-${randomInt(1000)}`;
  return components[randomInt(components.length)];
}

function longPath(windows, index) {
  const roots = windows
    ? ["", "\\", "/", "\\\\server\\share\\", "//server/share/"]
    : ["", "/", "///"];
  let value = roots[randomInt(roots.length)];

  // Exercise the first-component bookkeeping defect regularly.
  if (index % 5 === 0) {
    value = `${["a...", "δ...", "...."][index % 3]}${separator(windows)}..`;
  }

  const targetLength = 256 + randomInt(768);
  while (value.length < targetLength) {
    value += `${separator(windows)}${component()}`;
  }
  if (randomInt(4) === 0) value += separator(windows);

  if (value.length < 256 || value.includes(":")) {
    throw new Error("generated path is outside the native dispatch domain");
  }
  return value;
}

for (const [platform, windows, implementation] of [
  ["posix", false, path.posix],
  ["win32", true, path.win32],
]) {
  for (let index = 0; index < casesPerPlatform; index++) {
    const input = longPath(windows, index);
    const output = implementation.normalize(input);
    process.stdout.write(`${JSON.stringify([platform, index, input, output])}\n`);
  }
}
