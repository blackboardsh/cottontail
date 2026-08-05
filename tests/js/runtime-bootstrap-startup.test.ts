import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWindows = process.platform === "win32";
const isCI = process.env.CI === "true" || process.env.CI === "1";
// Windows x64 currently runs under emulation during bring-up. Keep the
// functional regression coverage while Windows startup performance is deferred.
const maxStartupRss = (isWindows ? 384 : 250) * 1024 * 1024;
const maxStdioStartupDurationMs = isWindows ? 30_000 : 5_000;
// Cold Linux CI runners (empty caches, loaded hosts) sit just over the 1s
// local budget; the assertion guards spawn-timeout behavior, not micro-perf.
const coldReadlineTimeoutMs = isWindows ? 30_000 : isCI ? 5_000 : 1_000;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cottontail-runtime-bootstrap-"));

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

function run(args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, ...args],
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("no-op runtime stays below the startup RSS budget", () => {
  expect(run(["-e", ""]).exitCode).toBe(0);

  const result = run(["-e", "Bun.gc(true); console.log(process.memoryUsage.rss())"]);
  expect(String(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  const rss = Number(String(result.stdout).trim());
  expect(Number.isFinite(rss)).toBe(true);
  expect(rss).toBeLessThan(maxStartupRss);
});

test("selective bootstrap retains representative builtin behavior", () => {
  const fixture = join(import.meta.dir, "fixtures", "runtime-bootstrap-builtins.mjs");
  const result = run([fixture]);
  expect(String(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(String(result.stdout)).toContain("runtime-bootstrap-builtins-ok");
});

test("selective bootstrap supports process.chdir", () => {
  const destination = join(temporaryDirectory, "selective-chdir");
  mkdirSync(destination, { recursive: true });
  const result = run([
    "-e",
    `process.chdir(${JSON.stringify(destination)}); console.log(process.cwd())`,
  ]);
  expect(String(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(String(result.stdout).trim()).toBe(realpathSync(destination));
});

test("full-runtime globals select the complete bootstrap", () => {
  const result = run(["-e", "console.log(typeof fetch, typeof Response, typeof process.stdout?.write)"]);
  expect(String(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(String(result.stdout).trim()).toBe("function function function");
});

test("advanced console methods select the compatible formatter", () => {
  const fixture = join(temporaryDirectory, "selective-console.js");
  writeFileSync(fixture, `
const value = new Proxy({ answer: 42 }, {
  get(target, property, receiver) {
    process.stdout.write(\`unexpected proxy get: \${String(property)}\\n\`);
    return Reflect.get(target, property, receiver);
  },
});
console.group("group");
console.log(value);
console.groupEnd();
console.time("clock");
console.timeLog("clock", "tick");
console.timeEnd("clock");
`);

  const result = run([fixture]);
  expect(result.exitCode).toBe(0);
  expect(String(result.stdout)).toBe("group\n  {\n    answer: 42,\n  }\n");
  expect(String(result.stderr).replace(/^\[.+?ms\] /gm, "")).toBe("clock tick\nclock\n");
});

test("confirm is available in the selective runtime", () => {
  const fixture = join(temporaryDirectory, "selective-confirm.js");
  writeFileSync(fixture, 'console.error(confirm("Proceed?") ? "Yes" : "No");\n');
  const result = Bun.spawnSync({
    cmd: [process.execPath, fixture],
    env: process.env,
    stdin: Buffer.from("Y\r\n"),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(String(result.stdout)).toBe("Proceed? [y/N] ");
  expect(String(result.stderr)).toBe("Yes\n");
});

test("selective bootstrap consumes internal spawn identity variables", () => {
  const inheritedArgv0 = "cottontail-spawn-alias";
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", `console.log(JSON.stringify({
      execPath: process.execPath,
      argv0: process.argv0,
      execValue: process.env.COTTONTAIL_SPAWN_EXEC_PATH,
      argv0Value: process.env.COTTONTAIL_SPAWN_ARGV0,
      hasExec: "COTTONTAIL_SPAWN_EXEC_PATH" in process.env,
      hasArgv0: "COTTONTAIL_SPAWN_ARGV0" in process.env,
      keys: Object.keys(process.env).filter(key => key.startsWith("COTTONTAIL_SPAWN_")),
    }))`],
    env: {
      ...process.env,
    },
    argv0: inheritedArgv0,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(String(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(String(result.stdout))).toEqual({
    execPath: process.execPath,
    argv0: inheritedArgv0,
    hasExec: false,
    hasArgv0: false,
    keys: [],
  });
});

test("stdio-only child evals stay on the selective startup path", () => {
  const startedAt = Date.now();
  for (let index = 0; index < 4; index += 1) {
    const result = run(["-e", `process.stderr.write("child-${index}\\n")`]);
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).toBe("");
    expect(String(result.stderr)).toBe(`child-${index}\n`);
  }
  expect(Date.now() - startedAt).toBeLessThan(maxStdioStartupDurationMs);
});

test("selective bootstrap initializes process before transitive runtime modules", () => {
  const fixture = join(temporaryDirectory, "selective-process-argv.js");
  const userArguments = Array.from({ length: 129 }, (_, index) => `arg${index}`);
  writeFileSync(fixture, "console.log(JSON.stringify(process.argv));\n");

  const result = run([fixture, ...userArguments]);
  expect(String(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);

  const argv = JSON.parse(String(result.stdout));
  expect(argv[0]).toBe(process.execPath);
  expect(argv[1]).toBe(realpathSync(fixture));
  expect(argv.slice(2)).toEqual(userArguments);
});

test("wrapped node shebang entrypoints remain valid JavaScript", () => {
  const fixture = join(temporaryDirectory, "vite-bin-smoke.js");
  writeFileSync(
    fixture,
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({ platform: process.platform, argv: process.argv.slice(2) }));\n",
  );

  const result = run([fixture, "vite-smoke"]);
  expect(String(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(String(result.stdout))).toEqual({
    platform: process.platform,
    argv: ["vite-smoke"],
  });
});

test("ordinary CommonJS entrypoints retain ownership of -c arguments", () => {
  const fixture = join(temporaryDirectory, "commonjs-cli-arguments.cjs");
  const config = join(temporaryDirectory, "application.config.js");
  writeFileSync(fixture, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  writeFileSync(config, "module.exports = { nested: { value: true } };\n");

  const result = run([fixture, "-c", config]);
  expect(String(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(String(result.stdout))).toEqual(["-c", config]);
});

test("cold readline process bootstrap completes within Bun's spawn timeout", () => {
  const fixture = join(import.meta.dir, "fixtures", "runtime-bootstrap-readline-close.mjs");
  const coldRoot = join(temporaryDirectory, "cold-readline");
  mkdirSync(coldRoot, { recursive: true });
  const env = {
    ...process.env,
    TMPDIR: coldRoot,
    COTTONTAIL_TMP_DIR: coldRoot,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  const result = Bun.spawnSync({
    cmd: [process.execPath, fixture],
    env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    timeout: coldReadlineTimeoutMs,
  });
  expect(String(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
});

test("compiled standalone executables retain the low-RSS bootstrap", () => {
  const entry = join(temporaryDirectory, "standalone-entry.mjs");
  const executable = join(temporaryDirectory, process.platform === "win32" ? "standalone.exe" : "standalone");
  writeFileSync(entry, "Bun.gc(true); console.log(process.memoryUsage.rss());\n");

  const build = run(["build", "--compile", entry, "--outfile", executable]);
  expect(String(build.stderr)).toBe("");
  expect(build.exitCode).toBe(0);

  const result = Bun.spawnSync({
    cmd: [executable],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(String(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(Number(String(result.stdout).trim())).toBeLessThan(maxStartupRss);
});

test("compiled bytecode is embedded and invalidates when source identity changes", () => {
  const entry = join(temporaryDirectory, "bytecode-entry.mjs");
  const executable = join(temporaryDirectory, process.platform === "win32" ? "bytecode.exe" : "bytecode");
  writeFileSync(entry, 'console.log("bytecode-one");\n');

  const build = run(["build", "--compile", "--bytecode", entry, "--outfile", executable]);
  expect(String(build.stderr)).toBe("");
  expect(build.exitCode).toBe(0);

  const initial = Bun.spawnSync({ cmd: [executable], stdout: "pipe", stderr: "pipe" });
  expect(initial.exitCode).toBe(0);
  expect(String(initial.stderr)).toBe("");
  expect(String(initial.stdout).trim()).toBe("bytecode-one");

  const bytes = readFileSync(executable);
  const magic = Buffer.from("COTTONTAIL-STAND5");
  const trailerOffset = bytes.length - magic.length - 5 * 8 - 4;
  expect(bytes.subarray(trailerOffset + 5 * 8 + 4).equals(magic)).toBe(true);
  const lengths = [0, 1, 2, 3, 4].map(index => Number(bytes.readBigUInt64LE(trailerOffset + index * 8)));
  const [sourceLength, mapLength, filesLength, execArgvLength, bytecodeLength] = lengths;
  expect(execArgvLength).toBe(0);
  expect(bytecodeLength).toBeGreaterThan(56);
  const payloadOffset = trailerOffset - sourceLength - mapLength - filesLength - execArgvLength - bytecodeLength;
  const bytecodeOffset = payloadOffset + sourceLength + mapLength + filesLength + execArgvLength;
  expect(bytes.subarray(bytecodeOffset, bytecodeOffset + 8).toString()).toBe("CTJSCB02");

  const sourceBytes = bytes.subarray(payloadOffset, payloadOffset + sourceLength);
  const markerOffset = sourceBytes.indexOf("bytecode-one");
  expect(markerOffset).toBeGreaterThanOrEqual(0);
  sourceBytes.set(Buffer.from("bytecode-two"), markerOffset);
  writeFileSync(executable, bytes);

  const invalidated = Bun.spawnSync({ cmd: [executable], stdout: "pipe", stderr: "pipe" });
  expect(invalidated.exitCode).toBe(0);
  expect(String(invalidated.stderr)).toBe("");
  expect(String(invalidated.stdout).trim()).toBe("bytecode-two");
});

test("nested test runs remove per-invocation artifacts on process.exit", () => {
  const cleanupRoot = join(temporaryDirectory, "artifact-cleanup");
  const fixture = join(temporaryDirectory, "artifact-cleanup.test.ts");
  mkdirSync(cleanupRoot, { recursive: true });
  writeFileSync(fixture, 'import { test } from "bun:test"; test("nested", () => {});\n');

  const env = { ...process.env, COTTONTAIL_TMP_DIR: cleanupRoot };
  delete env.COTTONTAIL_KEEP_TEMP;
  delete env.COTTONTAIL_TEST_CLI_HEADER_PRINTED;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", fixture],
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);

  const runRoot = join(cleanupRoot, "cottontail", "run");
  expect(existsSync(runRoot) ? readdirSync(runRoot) : []).toEqual([]);
});

test("test-runner start hook is hidden from string global enumeration", () => {
  expect(Object.getOwnPropertyNames(globalThis)).not.toContain("__cottontailStartTestRun");
  expect(typeof globalThis[Symbol.for("cottontail.internal.startTestRun")]).toBe("function");
});
