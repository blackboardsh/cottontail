import { readFileSync } from "../node/fs.js";
import { resolve } from "../node/path.js";
import { parse as parseTOML } from "../bun/toml.js";

const argv = Array.from(globalThis.process?.argv ?? []).slice(2).map(String);
let cachedConfig;
let cachedRuntimeOptions;

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

function validateConfig(config) {
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
  return config;
}

export function bunTestConfig() {
  if (cachedConfig !== undefined) return cachedConfig;
  const cwd = String(globalThis.process?.cwd?.() ?? ".");
  const path = resolve(cwd, configuredPath());
  try {
    const document = parseTOML(String(readFileSync(path, "utf8")));
    const config = document?.test && typeof document.test === "object"
      ? document.test
      : Object.create(null);
    cachedConfig = validateConfig(config);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    cachedConfig = Object.create(null);
  }
  return cachedConfig;
}

export function bunTestRuntimeOptions(args = argv) {
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
