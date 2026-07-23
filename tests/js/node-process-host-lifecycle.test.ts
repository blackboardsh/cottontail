import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fixtureDirectory = mkdtempSync(join(tmpdir(), "cottontail-process-lifecycle-"));
let fixtureId = 0;

afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

async function runSource(source: string) {
  const fixture = join(fixtureDirectory, `fixture-${fixtureId++}.js`);
  writeFileSync(fixture, source);
  const child = Bun.spawn({
    cmd: [process.execPath, fixture],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function runExternallySignaledSource(
  source: string,
  signal: NodeJS.Signals,
  resetSignalDisposition: string | undefined = undefined,
) {
  const id = fixtureId++;
  const fixture = join(fixtureDirectory, `fixture-${id}.js`);
  const readyFile = join(fixtureDirectory, `fixture-${id}.ready`);
  writeFileSync(fixture, source);
  const cmd = resetSignalDisposition === undefined
    ? [process.execPath, fixture]
    : [
        "sh",
        "-c",
        `trap - ${resetSignalDisposition}; exec "$@"`,
        "sh",
        process.execPath,
        fixture,
      ];
  const child = Bun.spawn({
    cmd,
    env: { ...process.env, COTTONTAIL_SIGNAL_READY_FILE: readyFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = child.stdout.text();
  const stderrPromise = child.stderr.text();

  for (let attempt = 0; attempt < 200 && !existsSync(readyFile); attempt++) {
    await Bun.sleep(10);
  }
  if (!existsSync(readyFile)) {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error(`signal fixture did not become ready: ${fixture}`);
  }
  child.kill(signal);

  const [stdout, stderr, exitCode] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("beforeExit repeats when a listener schedules referenced work", async () => {
  const result = await runSource(`
    let count = 0;
    process.on("beforeExit", () => {
      console.log("beforeExit", count);
      if (count++ === 0) setTimeout(() => {}, 1);
    });
    process.on("exit", () => console.log("exit", count));
  `);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("beforeExit 0\nbeforeExit 1\nexit 2\n");
});

test("top-level exceptions route through the fatal exception handler", async () => {
  const result = await runSource(`
    process.on("uncaughtExceptionMonitor", error => console.log("monitor", error.message));
    process.on("uncaughtException", error => {
      console.log("caught", error.message);
      process.exitCode = 42;
    });
    throw new Error("host-fatal");
  `);

  expect(result.exitCode).toBe(42);
  expect(result.stdout).toContain("monitor host-fatal\ncaught host-fatal\n");
});

test("an exception from an uncaughtException listener uses fatal exit code 7", async () => {
  const result = await runSource(`
    process.on("uncaughtException", () => { throw new Error("handler-failed"); });
    throw new Error("original");
  `);

  expect(result.exitCode).toBe(7);
  expect(result.stderr).toContain("handler-failed");
});

test("exit listeners can replace a fatal exit code with zero", async () => {
  const result = await runSource(`
    process.on("exit", code => {
      console.log(code, process.exitCode);
      process.exitCode = 0;
    });
    throw new Error("fatal-before-exit");
  `);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("1 1\n");
});

test.skipIf(process.platform === "win32")("OS signals emit their name and number", async () => {
  const result = await runSource(`
    process.once("SIGUSR1", (name, number) => {
      console.log(name, number);
      process.exit(0);
    });
    process.kill(process.pid, "SIGUSR1");
  `);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`SIGUSR1 ${process.binding("constants").os.signals.SIGUSR1}\n`);
});

for (const signal of ["SIGALRM", "SIGPROF", "SIGVTALRM", "SIGPWR"] as const) {
  test.skipIf(process.platform !== "linux")(`external ${signal} reaches process listeners`, async () => {
    const result = await runExternallySignaledSource(`
      const { writeFileSync } = require("node:fs");
      const deadline = setTimeout(() => process.exit(2), 2000);
      process.once(${JSON.stringify(signal)}, (name, number) => {
        clearTimeout(deadline);
        console.log(name, number);
        process.exit(0);
      });
      writeFileSync(process.env.COTTONTAIL_SIGNAL_READY_FILE, "ready");
    `, signal);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${signal} ${process.binding("constants").os.signals[signal]}\n`);
  });
}

for (const method of [
  "on",
  "addListener",
  "prependListener",
  "once",
  "prependOnceListener",
] as const) {
  test.skipIf(process.platform !== "linux")(`${method} starts a native signal watcher`, async () => {
    const result = await runExternallySignaledSource(`
      const { writeFileSync } = require("node:fs");
      const deadline = setTimeout(() => process.exit(2), 2000);
      process[${JSON.stringify(method)}]("SIGPROF", (name, number) => {
        clearTimeout(deadline);
        console.log(name, number);
        process.exit(0);
      });
      writeFileSync(process.env.COTTONTAIL_SIGNAL_READY_FILE, "ready");
    `, "SIGPROF");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`SIGPROF ${process.binding("constants").os.signals.SIGPROF}\n`);
  });
}

test.skipIf(process.platform !== "linux")("once auto-removal restores the default signal disposition", async () => {
  const result = await runExternallySignaledSource(`
    const { writeFileSync, writeSync } = require("node:fs");
    process.once("SIGPROF", () => {
      writeSync(1, "first\\n");
      Bun.spawn({
        cmd: ["sh", "-c", "kill -PROF " + process.pid],
        stdout: "ignore",
        stderr: "ignore",
      });
    });
    writeFileSync(process.env.COTTONTAIL_SIGNAL_READY_FILE, "ready");
    setTimeout(() => process.exit(2), 2000);
  `, "SIGPROF", "PROF");

  expect(result.exitCode).toBe(128 + process.binding("constants").os.signals.SIGPROF);
  expect(result.stdout).toBe("first\n");
});

for (const [method, removal] of [
  ["removeListener", `process.removeListener("SIGPROF", listener);`],
  ["off", `process.off("SIGPROF", listener);`],
  ["named removeAllListeners", `process.removeAllListeners("SIGPROF");`],
  ["global removeAllListeners", `process.removeAllListeners();`],
] as const) {
  test.skipIf(process.platform !== "linux")(`${method} stops the last native signal watcher`, async () => {
    const result = await runExternallySignaledSource(`
      const { writeFileSync } = require("node:fs");
      const listener = () => {};
      process.on("SIGPROF", listener);
      ${removal}
      writeFileSync(process.env.COTTONTAIL_SIGNAL_READY_FILE, "ready");
      setTimeout(() => process.exit(2), 2000);
    `, "SIGPROF", "PROF");

    expect(result.exitCode).toBe(128 + process.binding("constants").os.signals.SIGPROF);
    expect(result.stdout).toBe("");
  });
}

test.skipIf(process.platform !== "linux")("removeAllListeners does not uninstall signal lifecycle support", async () => {
  const result = await runExternallySignaledSource(`
    const { writeFileSync } = require("node:fs");
    process.removeAllListeners();
    const deadline = setTimeout(() => process.exit(2), 2000);
    process.once("SIGPWR", (name, number) => {
      clearTimeout(deadline);
      console.log(name, number);
      process.exit(0);
    });
    writeFileSync(process.env.COTTONTAIL_SIGNAL_READY_FILE, "ready");
  `, "SIGPWR");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`SIGPWR ${process.binding("constants").os.signals.SIGPWR}\n`);
});

test.skipIf(process.platform !== "linux")("signal listeners are unreferenced and lifecycle hooks are hidden", async () => {
  const result = await runSource(`
    process.on("SIGPROF", () => {});
    console.log(process.listenerCount("newListener"), process.listenerCount("removeListener"));
  `);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("0 0\n");
});

for (const [signal, shellSignal] of [
  ["SIGPIPE", "PIPE"],
  ["SIGXFSZ", "XFSZ"],
] as const) {
  test.skipIf(process.platform !== "linux")(`${signal} is initially ignored`, async () => {
    const result = await runExternallySignaledSource(`
      const { writeFileSync } = require("node:fs");
      writeFileSync(process.env.COTTONTAIL_SIGNAL_READY_FILE, "ready");
      setTimeout(() => {
        console.log("alive");
        process.exit(0);
      }, 250);
    `, signal, shellSignal);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("alive\n");
  });

  test.skipIf(process.platform !== "linux")(`${signal} returns to default after listener removal`, async () => {
    const result = await runExternallySignaledSource(`
      const { writeFileSync } = require("node:fs");
      const listener = () => {};
      process.on(${JSON.stringify(signal)}, listener);
      process.off(${JSON.stringify(signal)}, listener);
      writeFileSync(process.env.COTTONTAIL_SIGNAL_READY_FILE, "ready");
      setTimeout(() => process.exit(2), 2000);
    `, signal, shellSignal);

    expect(result.exitCode).toBe(128 + process.binding("constants").os.signals[signal]);
    expect(result.stdout).toBe("");
  });
}

test.skipIf(process.platform !== "linux")("signal aliases retain independent watchers", async () => {
  const result = await runExternallySignaledSource(`
    const { writeFileSync } = require("node:fs");
    const seen = [];
    const deadline = setTimeout(() => process.exit(2), 2000);
    for (const name of ["SIGIO", "SIGPOLL"]) {
      process.once(name, emittedName => {
        seen.push(emittedName);
        if (seen.length === 2) {
          clearTimeout(deadline);
          console.log(seen.sort().join(","));
          process.exit(0);
        }
      });
    }
    writeFileSync(process.env.COTTONTAIL_SIGNAL_READY_FILE, "ready");
  `, "SIGIO");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("SIGIO,SIGPOLL\n");
});

test.skipIf(process.platform !== "linux")("SIGKILL and SIGSTOP listeners fail without insertion", async () => {
  const result = await runSource(`
    for (const name of ["SIGKILL", "SIGSTOP"]) {
      try {
        process.on(name, () => {});
      } catch (error) {
        console.log(name, error.code, error.errno, error.syscall, process.listenerCount(name));
      }
    }
  `);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("SIGKILL EINVAL -22 uv_signal_start 0\nSIGSTOP EINVAL -22 uv_signal_start 0\n");
});

test.skipIf(process.platform !== "linux")("numeric Linux real-time signals are bounded and external-only", async () => {
  const result = await runSource(`
    (async () => {
      const reportError = (label, callback) => {
        try {
          callback();
        } catch (error) {
          console.log(label, error.code, error.errno, error.syscall);
        }
      };

      const validationTarget = Bun.spawn({ cmd: ["sleep", "5"], stdout: "ignore", stderr: "ignore" });
      reportError("signal65", () => process.kill(validationTarget.pid, 65));
      reportError("self34", () => process.kill(process.pid, 34));
      reportError("group34", () => process.kill(0, 34));
      console.log("nativeSelf34", process._kill(process.pid, 34));
      console.log("nativeGroup34", process._kill(0, 34));
      process.kill(validationTarget.pid, "SIGKILL");
      await validationTarget.exited;

      for (const signal of [32, 34, 64]) {
        const child = Bun.spawn({ cmd: ["sleep", "5"], stdout: "ignore", stderr: "ignore" });
        await Bun.sleep(20);
        console.log("external", signal, process.kill(child.pid, signal), await child.exited);
      }
    })().catch(error => {
      console.error(error);
      process.exit(2);
    });
  `);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(
    "signal65 EINVAL -22 kill\n" +
    "self34 EINVAL -22 kill\n" +
    "group34 EINVAL -22 kill\n" +
    "nativeSelf34 -22\n" +
    "nativeGroup34 -22\n" +
    "external 32 true 160\n" +
    "external 34 true 162\n" +
    "external 64 true 192\n",
  );
});

test.skipIf(process.platform === "win32")("self-signals are queued without OS coalescing", async () => {
  const result = await runSource(`
    const expected = 64;
    let count = 0;
    const deadline = setTimeout(() => process.exit(2), 2000);
    const handler = () => {
      count++;
      if (count === expected) {
        clearTimeout(deadline);
        process.off("SIGINT", handler);
        process.exit(0);
      }
    };
    process.on("SIGINT", handler);
    for (let index = 0; index < expected; index++) process.kill(process.pid, "SIGINT");
  `);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
});

test("memoryUsage arrayBuffers grows with ArrayBuffer backing stores", () => {
  const initial = process.memoryUsage().arrayBuffers;
  const buffer = new ArrayBuffer(16 * 1024 * 1024);
  expect(buffer.byteLength).toBe(16 * 1024 * 1024);
  expect(process.memoryUsage().arrayBuffers).toBeGreaterThanOrEqual(initial + buffer.byteLength);
});
