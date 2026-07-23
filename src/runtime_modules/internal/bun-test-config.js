import { readFileSync } from "../node/fs.js";
import { resolve } from "../node/path.js";
import { parse as parseTOML } from "../bun/toml.js";

const argv = Array.from(globalThis.process?.argv ?? []).slice(2).map(String);
const emptyConfig = Object.create(null);
let cachedConfig;
let cachedRuntimeOptions;

function testCliModeEnabled() {
  return globalThis.__cottontailBunTestHeaderPrinted === true ||
    globalThis.process?.env?.COTTONTAIL_TEST_CLI_HEADER_PRINTED === "1";
}

function option(args, name) {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline != null) return { present: true, value: inline.slice(name.length + 1) };
  const index = args.indexOf(name);
  return index < 0
    ? { present: false, value: undefined }
    : { present: true, value: args[index + 1] };
}

function flag(args, name) {
  return args.includes(name);
}

function configuredPath() {
  const long = option(argv, "--config");
  if (long.present) return long.value || "bunfig.toml";
  const short = option(argv, "-c");
  return short.present ? short.value || "bunfig.toml" : "bunfig.toml";
}

function expectType(value, expected, name) {
  if (typeof value !== expected) {
    throw new TypeError(`Expected [test].${name} to be ${expected}`);
  }
}

function configU32(value, name) {
  expectType(value, "number", name);
  if (!Number.isFinite(value)) throw new TypeError(`Expected [test].${name} to be a finite number`);
  return Math.trunc(value) >>> 0;
}

function cliU32(value, name, message) {
  if (value === undefined || value === "" || !/^\+?\d+$/.test(String(value))) {
    throw new Error(message ?? `${name} expects a number`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(message ?? `${name} expects a number`);
  }
  return parsed;
}

function validateConcurrentTestGlob(value) {
  if (typeof value === "string") {
    if (value.length === 0) throw new Error("concurrentTestGlob cannot be an empty string");
    return [value];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("concurrentTestGlob must be a string or array of strings");
  }
  if (value.length === 0) throw new Error("concurrentTestGlob array cannot be empty");
  return value.map((pattern) => {
    if (typeof pattern !== "string") {
      throw new TypeError("concurrentTestGlob array must contain only strings");
    }
    if (pattern.length === 0) throw new Error("concurrentTestGlob patterns cannot be empty strings");
    return pattern;
  });
}

function configPropertyLocation(source, name) {
  const lines = String(source).split("\n");
  let section = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, "");
    const sectionMatch = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section !== "test") continue;
    const propertyMatch = new RegExp(`^(\\s*${name}\\s*=\\s*)`).exec(line);
    if (!propertyMatch) continue;
    return {
      line: index + 1,
      lineText: line,
      valueColumn: propertyMatch[1].length + 1,
      valueText: line.slice(propertyMatch[1].length),
    };
  }
  return null;
}

function arrayItemOffsets(source) {
  const offsets = [];
  let quote = "";
  let escaped = false;
  let squareDepth = 0;
  let braceDepth = 0;
  let expectingItem = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (quote === '"' && character === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (character === quote && !escaped) quote = "";
      escaped = false;
      continue;
    }
    if (character === '"' || character === "'") {
      if (expectingItem && squareDepth === 1 && braceDepth === 0) {
        offsets.push(index);
        expectingItem = false;
      }
      quote = character;
      continue;
    }
    if (character === "[") {
      squareDepth += 1;
      if (squareDepth === 1) expectingItem = true;
      continue;
    }
    if (character === "]") {
      squareDepth -= 1;
      continue;
    }
    if (character === "{") braceDepth += 1;
    if (character === "}") braceDepth -= 1;
    if (character === "," && squareDepth === 1 && braceDepth === 0) {
      expectingItem = true;
      continue;
    }
    if (expectingItem && squareDepth === 1 && braceDepth === 0 && !/\s/.test(character)) {
      offsets.push(index);
      expectingItem = false;
    }
  }
  return offsets;
}

function failInvalidBunfig(source, path, name, message, itemIndex = null) {
  const location = configPropertyLocation(source, name);
  if (!location) throw new TypeError(message);
  const itemOffset = itemIndex == null ? 0 : (arrayItemOffsets(location.valueText)[itemIndex] ?? 0);
  const column = location.valueColumn + itemOffset;
  const prefix = `${location.line} | `;
  const diagnostic = [
    `${prefix}${location.lineText}`,
    `${" ".repeat(prefix.length + column - 1)}^`,
    `error: ${message}`,
    `    at ${path}:${location.line}:${column}`,
    "",
    "Invalid Bunfig: failed to load bunfig",
  ].join("\n");
  globalThis.process?.stderr?.write?.(`${diagnostic}\n`);
  if (typeof globalThis.process?.exit === "function") globalThis.process.exit(1);
  throw new TypeError(message);
}

function validateCoverageConfig(config, source, path) {
  if (!Object.hasOwn(config, "coveragePathIgnorePatterns")) return;
  const value = config.coveragePathIgnorePatterns;
  if (typeof value === "string") return;
  if (!Array.isArray(value)) {
    failInvalidBunfig(
      source,
      path,
      "coveragePathIgnorePatterns",
      "coveragePathIgnorePatterns must be a string or array of strings",
    );
  }
  const invalidIndex = value.findIndex((pattern) => typeof pattern !== "string");
  if (invalidIndex >= 0) {
    failInvalidBunfig(
      source,
      path,
      "coveragePathIgnorePatterns",
      "coveragePathIgnorePatterns array must contain only strings",
      invalidIndex,
    );
  }
}

function validateConfig(config, source, path) {
  if (Object.hasOwn(config, "randomize")) expectType(config.randomize, "boolean", "randomize");
  if (Object.hasOwn(config, "seed")) configU32(config.seed, "seed");
  if (Object.hasOwn(config, "rerunEach")) configU32(config.rerunEach, "rerunEach");
  if (Object.hasOwn(config, "retry")) configU32(config.retry, "retry");
  if (Object.hasOwn(config, "onlyFailures")) expectType(config.onlyFailures, "boolean", "onlyFailures");
  if (Object.hasOwn(config, "concurrentTestGlob")) validateConcurrentTestGlob(config.concurrentTestGlob);
  if (Object.hasOwn(config, "reporter")) {
    if (!config.reporter || typeof config.reporter !== "object" || Array.isArray(config.reporter)) {
      throw new TypeError("Expected [test].reporter to be object");
    }
    if (Object.hasOwn(config.reporter, "junit")) expectType(config.reporter.junit, "string", "reporter.junit");
    if (Object.hasOwn(config.reporter, "dots")) expectType(config.reporter.dots, "boolean", "reporter.dots");
    if (Object.hasOwn(config.reporter, "dot")) expectType(config.reporter.dot, "boolean", "reporter.dot");
  }
  validateCoverageConfig(config, source, path);
  return config;
}

export function bunTestConfig() {
  if (!testCliModeEnabled()) return emptyConfig;
  if (cachedConfig !== undefined) return cachedConfig;
  const cwd = String(globalThis.process?.cwd?.() ?? ".");
  const path = resolve(cwd, configuredPath());
  try {
    const source = String(readFileSync(path, "utf8"));
    const document = parseTOML(source);
    const config = document?.test && typeof document.test === "object"
      ? document.test
      : Object.create(null);
    cachedConfig = validateConfig(config, source, path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    cachedConfig = Object.create(null);
  }
  return cachedConfig;
}

export function bunTestRuntimeOptions(args = argv) {
  if (!testCliModeEnabled()) args = [];
  if (args === argv && cachedRuntimeOptions !== undefined) return cachedRuntimeOptions;
  const config = bunTestConfig();

  const retryOption = option(args, "--retry");
  const rerunEachOption = option(args, "--rerun-each");
  let retry = retryOption.present
    ? cliU32(retryOption.value, "--retry", "--retry expects a number")
    : 0;
  let rerunEach = rerunEachOption.present
    ? cliU32(rerunEachOption.value, "--rerun-each", "--rerun-each expects a number")
    : 0;
  if (retry !== 0 && rerunEach !== 0) {
    throw new Error("--retry cannot be used with --rerun-each");
  }

  let randomize = flag(args, "--randomize");
  const seedOption = option(args, "--seed");
  let seed = null;
  if (seedOption.present) {
    seed = cliU32(seedOption.value, "--seed", `Invalid seed value: ${seedOption.value ?? ""}`);
    randomize = true;
  }

  if (Object.hasOwn(config, "randomize")) randomize = config.randomize;
  if (Object.hasOwn(config, "seed")) {
    if (!(Object.hasOwn(config, "randomize") ? config.randomize : randomize)) {
      throw new Error('"seed" can only be used when "randomize" is true');
    }
    seed = configU32(config.seed, "seed");
  }
  if (Object.hasOwn(config, "rerunEach")) {
    if (retry !== 0) throw new Error('"rerunEach" cannot be used with "retry"');
    rerunEach = configU32(config.rerunEach, "rerunEach");
  }
  if (Object.hasOwn(config, "retry")) {
    if (rerunEach !== 0) throw new Error('"retry" cannot be used with "rerunEach"');
    retry = configU32(config.retry, "retry");
  }

  const maxConcurrencyOption = option(args, "--max-concurrency");
  const maxConcurrency = maxConcurrencyOption.present
    ? cliU32(maxConcurrencyOption.value, "--max-concurrency", `Invalid max-concurrency: "${maxConcurrencyOption.value ?? ""}"`)
    : 20;

  const reporterOption = option(args, "--reporter");
  const reporterOutfileOption = option(args, "--reporter-outfile");
  let dots = flag(args, "--dots");
  let junit = false;
  let reporterOutfile = reporterOutfileOption.present ? reporterOutfileOption.value : undefined;
  if (reporterOption.present) {
    if (reporterOption.value === "junit") {
      if (!reporterOutfile) {
        throw new Error("--reporter=junit requires --reporter-outfile [file] to specify where to save the XML report");
      }
      junit = true;
    } else if (reporterOption.value === "dots" || reporterOption.value === "dot") {
      dots = true;
    } else {
      throw new Error(`unsupported reporter format '${reporterOption.value ?? ""}'. Available options: 'junit' (for XML test results), 'dots'`);
    }
  }

  let onlyFailures = flag(args, "--only-failures");
  if (Object.hasOwn(config, "onlyFailures")) onlyFailures = config.onlyFailures;
  if (config.reporter) {
    const configuredDots = config.reporter.dots ?? config.reporter.dot;
    if (configuredDots !== undefined) dots = configuredDots;
    if (typeof config.reporter.junit === "string" && config.reporter.junit.length > 0) {
      junit = true;
      reporterOutfile = config.reporter.junit;
    }
  }

  const concurrentTestGlob = Object.hasOwn(config, "concurrentTestGlob")
    ? validateConcurrentTestGlob(config.concurrentTestGlob)
    : [];
  const timeoutOption = option(args, "--timeout");
  const timeout = timeoutOption.present ? Number(timeoutOption.value) : 5000;
  const bailOption = option(args, "--bail");
  const bail = bailOption.present
    ? (bailOption.value === undefined || String(bailOption.value).startsWith("-") ? 1 : Number(bailOption.value))
    : Infinity;
  const namePattern = option(args, "-t").value ?? option(args, "--test-name-pattern").value;

  const result = {
    bail: bail === Infinity ? Infinity : Number.isInteger(bail) && bail > 0 ? bail : 1,
    concurrent: flag(args, "--concurrent"),
    concurrentTestGlob,
    maxConcurrency: maxConcurrency === 0 ? Infinity : maxConcurrency,
    namePattern,
    only: flag(args, "--only") || flag(args, "--test-only"),
    passWithNoTests: flag(args, "--pass-with-no-tests"),
    randomize,
    reporters: { dots, junit, onlyFailures },
    reporterOutfile,
    rerunEach: Math.max(rerunEach, 1),
    retry,
    runTodo: flag(args, "--todo"),
    seed,
    timeout: Number.isFinite(timeout) && timeout >= 0 ? timeout : 5000,
  };
  if (args === argv) cachedRuntimeOptions = result;
  return result;
}
