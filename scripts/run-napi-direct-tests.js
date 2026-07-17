#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const defaultTestRoot = path.join(
  repoRoot,
  "compat/upstream/bun/v1.3.10/test/napi/node-napi-tests/test",
);

function usage() {
  console.error(
    "Usage: node scripts/run-napi-direct-tests.js --binary <path> [--jobs <count>] [--timeout <ms>] [--json]",
  );
}

function parseArguments(argv) {
  const options = {
    binary: null,
    jobs: 4,
    json: false,
    testRoot: defaultTestRoot,
    timeout: 20_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--binary") {
      options.binary = argv[++index];
    } else if (argument === "--jobs") {
      options.jobs = Number(argv[++index]);
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--test-root") {
      options.testRoot = path.resolve(argv[++index]);
    } else if (argument === "--timeout") {
      options.timeout = Number(argv[++index]);
    } else {
      usage();
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.binary) {
    usage();
    throw new Error("--binary is required");
  }
  options.binary = path.resolve(options.binary);
  if (!Number.isInteger(options.timeout) || options.timeout <= 0) {
    throw new Error("--timeout must be a positive integer");
  }
  if (!Number.isInteger(options.jobs) || options.jobs <= 0) {
    throw new Error("--jobs must be a positive integer");
  }
  return options;
}

async function findDirectTests(directory) {
  const tests = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...(await findDirectTests(entryPath)));
    } else if (entry.isFile() && entry.name === "test.js") {
      tests.push(entryPath);
    }
  }
  return tests.sort();
}

function runTest(binary, testPath, timeout) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(binary, [testPath], {
      cwd: path.dirname(testPath),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        durationMs: Math.round(performance.now() - startedAt),
        signal,
        stderr,
        stdout,
        timedOut,
      });
    });
  });
}

const options = parseArguments(process.argv.slice(2));
const tests = await findDirectTests(options.testRoot);
const results = new Array(tests.length);
let nextTest = 0;

async function runNextTest() {
  for (;;) {
    const index = nextTest++;
    if (index >= tests.length) return;
    const testPath = tests[index];
    const result = await runTest(options.binary, testPath, options.timeout);
    const relativePath = path.relative(options.testRoot, testPath);
    results[index] = { path: relativePath, ...result };
    if (!options.json) {
      const status = result.code === 0 && !result.timedOut ? "PASS" : "FAIL";
      console.log(`${status} ${relativePath} (${result.durationMs}ms)`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(options.jobs, tests.length) }, runNextTest));

const passed = results.filter((result) => result.code === 0 && !result.timedOut).length;
const failed = results.length - passed;

if (options.json) {
  console.log(JSON.stringify({ failed, passed, total: results.length, results }, null, 2));
} else {
  for (const result of results) {
    if (result.code === 0 && !result.timedOut) continue;
    console.log(`\n--- ${result.path} ---`);
    console.log(
      `exit=${result.code ?? "null"} signal=${result.signal ?? "none"} timeout=${result.timedOut}`,
    );
    if (result.stdout) console.log(`stdout:\n${result.stdout.trimEnd()}`);
    if (result.stderr) console.log(`stderr:\n${result.stderr.trimEnd()}`);
  }
  console.log(`\nN-API direct programs: ${passed}/${results.length} passed, ${failed} failed`);
}

process.exitCode = failed === 0 ? 0 : 1;
