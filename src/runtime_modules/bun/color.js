const formatAliases = new Map([
  ["[r,g,b,a]", "[rgba]"],
  ["[rgb]", "[rgb]"],
  ["[rgba]", "[rgba]"],
  ["{r,g,b}", "{rgb}"],
  ["{rgb}", "{rgb}"],
  ["{rgba}", "{rgba}"],
  ["ansi_256", "ansi-256"],
  ["ansi-256", "ansi-256"],
  ["ansi256", "ansi-256"],
  ["ansi_16", "ansi-16"],
  ["ansi-16", "ansi-16"],
  ["ansi_16m", "ansi-24bit"],
  ["ansi-16m", "ansi-24bit"],
  ["ansi-24bit", "ansi-24bit"],
  ["ansi-truecolor", "ansi-24bit"],
  ["ansi", "ansi"],
  ["css", "css"],
  ["hex", "hex"],
  ["HEX", "HEX"],
  ["hsl", "hsl"],
  ["lab", "lab"],
  ["number", "number"],
  ["rgb", "rgb"],
  ["rgba", "rgba"],
]);

function invalidArgument(name, expected, value) {
  const error = new TypeError(`The \"${name}\" argument must be of type ${expected}. Received ${value === null ? "null" : typeof value}`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function normalizeFormat(format) {
  if (format == null) return "css";
  if (typeof format !== "string") throw invalidArgument("format", "string", format);
  const normalized = formatAliases.get(format);
  if (normalized === undefined) {
    const error = new TypeError(`Invalid color format: ${format}`);
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }
  return normalized;
}

function packedNumberColor(value) {
  let integer;
  if (Number.isInteger(value) && value >= 0 && value < 0xffffffff) {
    integer = value;
  } else {
    let int64;
    if (Number.isNaN(value)) int64 = 0n;
    else if (value === Infinity || value >= 0x8000000000000000) int64 = 0x7fffffffffffffffn;
    else if (value === -Infinity || value <= -0x8000000000000000) int64 = -0x8000000000000000n;
    else int64 = BigInt(Math.trunc(value));
    const divisor = 0xffffffffn;
    integer = Number(((int64 % divisor) + divisor) % divisor);
  }
  integer >>>= 0;
  return {
    r: (integer >>> 16) & 0xff,
    g: (integer >>> 8) & 0xff,
    b: integer & 0xff,
    a: (integer >>> 24) & 0xff,
  };
}

const ansi16Table = Uint8Array.from([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  0, 4, 4, 4, 12, 12, 2, 6, 4, 4, 12, 12, 2, 2, 6, 4,
  12, 12, 2, 2, 2, 6, 12, 12, 10, 10, 10, 10, 14, 12, 10, 10,
  10, 10, 10, 14, 1, 5, 4, 4, 12, 12, 3, 8, 4, 4, 12, 12,
  2, 2, 6, 4, 12, 12, 2, 2, 2, 6, 12, 12, 10, 10, 10, 10,
  14, 12, 10, 10, 10, 10, 10, 14, 1, 1, 5, 4, 12, 12, 1, 1,
  5, 4, 12, 12, 3, 3, 8, 4, 12, 12, 2, 2, 2, 6, 12, 12,
  10, 10, 10, 10, 14, 12, 10, 10, 10, 10, 10, 14, 1, 1, 1, 5,
  12, 12, 1, 1, 1, 5, 12, 12, 1, 1, 1, 5, 12, 12, 3, 3,
  3, 7, 12, 12, 10, 10, 10, 10, 14, 12, 10, 10, 10, 10, 10, 14,
  9, 9, 9, 9, 13, 12, 9, 9, 9, 9, 13, 12, 9, 9, 9, 9,
  13, 12, 9, 9, 9, 9, 13, 12, 11, 11, 11, 11, 7, 12, 10, 10,
  10, 10, 10, 14, 9, 9, 9, 9, 9, 13, 9, 9, 9, 9, 9, 13,
  9, 9, 9, 9, 9, 13, 9, 9, 9, 9, 9, 13, 9, 9, 9, 9,
  9, 13, 11, 11, 11, 11, 11, 15, 0, 0, 0, 0, 0, 0, 8, 8,
  8, 8, 8, 8, 7, 7, 7, 7, 7, 7, 15, 15, 15, 15, 15, 15,
]);

function wrappedSquareDifference(left, right) {
  const difference = (left - right) >>> 0;
  return Math.imul(difference, difference) >>> 0;
}

function ansiDistance(red, green, blue, r, g, b) {
  return (wrappedSquareDifference(red, r) + wrappedSquareDifference(green, g) + wrappedSquareDifference(blue, b)) >>> 0;
}

function ansiCubeIndex(value) {
  if (value < 48) return 0;
  if (value < 114) return 1;
  return Math.floor((value - 35) / 40);
}

function ansi256Index(r, g, b) {
  const levels = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
  const qr = ansiCubeIndex(r);
  const qg = ansiCubeIndex(g);
  const qb = ansiCubeIndex(b);
  const cr = levels[qr];
  const cg = levels[qg];
  const cb = levels[qb];
  const cubeIndex = (16 + (36 * qr) + (6 * qg) + qb) >>> 0;
  if (cr === r && cg === g && cb === b) return cubeIndex;

  const average = Math.floor((r + g + b) / 3);
  const greyIndex = average > 238 ? 23 : Math.floor(((average - 3) >>> 0) / 10);
  const grey = (8 + (10 * greyIndex)) >>> 0;
  return ansiDistance(grey, grey, grey, r, g, b) < ansiDistance(cr, cg, cb, r, g, b)
    ? (232 + greyIndex) >>> 0
    : cubeIndex;
}

function fastNumericAnsi(value, format) {
  const { r, g, b } = packedNumberColor(value);
  if (format === "ansi-24bit") return `\x1b[38;2;${r};${g};${b}m`;
  const index = ansi256Index(r, g, b);
  if (format === "ansi-256") return `\x1b[38;5;${index}m`;
  if (format === "ansi-16") return `\x1b[38;5;${String.fromCharCode(ansi16Table[index & 0xff])}m`;
  return undefined;
}

function nativeColor(input, format) {
  let nativeInput = input;
  let inputKind;
  if (typeof input === "number") {
    const { r, g, b, a } = packedNumberColor(input);
    nativeInput = [r, g, b, a];
    inputKind = "packed-number";
  }
  const response = JSON.parse(cottontail.buildNative(JSON.stringify({
    __cottontailColor: { input: nativeInput, inputKind, format },
  }), cottontail.cwd()));
  if (!response.success) {
    const ErrorType = response.name === "TypeError" ? TypeError : Error;
    const error = new ErrorType(response.error || "Bun.color failed");
    if (response.code) error.code = response.code;
    throw error;
  }
  return response.result;
}

function resolveAnsiFormat() {
  const forceColor = globalThis.process?.env?.FORCE_COLOR;
  if (forceColor === "0") return null;
  if (forceColor === undefined && globalThis.process?.env?.NO_COLOR !== undefined) return null;
  return "ansi-24bit";
}

function ansiColor(input, format) {
  const rgba = nativeColor(input, "{rgba}");
  if (rgba === null || typeof rgba !== "object") return rgba;
  if (format === "ansi") {
    format = resolveAnsiFormat();
    if (format === null) return "";
  }
  if (format === "ansi-24bit") return `\x1b[38;2;${rgba.r};${rgba.g};${rgba.b}m`;
  const index = ansi256Index(rgba.r, rgba.g, rgba.b);
  if (format === "ansi-256") return `\x1b[38;5;${index}m`;
  return `\x1b[38;5;${String.fromCharCode(ansi16Table[index & 0xff])}m`;
}

export function color(input, format = undefined) {
  if (input === undefined) throw invalidArgument("input", "string, number, or object", input);
  const normalizedFormat = normalizeFormat(format);
  if (typeof input === "number") {
    const fast = fastNumericAnsi(input, normalizedFormat);
    if (fast !== undefined) return fast;
  }
  if (normalizedFormat === "ansi" || normalizedFormat.startsWith("ansi-")) {
    return ansiColor(input, normalizedFormat);
  }
  return nativeColor(input, normalizedFormat);
}

export default color;
