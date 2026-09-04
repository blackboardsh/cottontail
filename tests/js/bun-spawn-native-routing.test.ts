import { expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";

const stdoutCommand = (text: string) => [
  process.execPath,
  "-e",
  `process.stdout.write(${JSON.stringify(text)})`,
];

function expectWindowsBatchRejection(callback: () => unknown, path: string) {
  let error: any;
  try {
    callback();
  } catch (cause) {
    error = cause;
  }
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("EINVAL");
  expect(error.errno).toBe(-4071);
  expect(error.path).toBe(path);
  expect(error.message).toContain("Cannot execute Windows .cmd/.bat files directly");
  expect(error.message).toContain("native .exe/.com");
}

test("ordinary async spawn does not activate the terminal capability", async () => {
  const terminalCapabilityIsLoaded = () => Boolean(
    ((globalThis as any)[Symbol.for("cottontail.capabilityModuleCache")] as Map<string, unknown> | undefined)
      ?.has("terminal"),
  );
  expect(terminalCapabilityIsLoaded()).toBe(false);
  const externalNode = Bun.which("node");
  expect(externalNode).not.toBeNull();

  const child = Bun.spawn([externalNode!, "-e", "process.exit(0)"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  expect(terminalCapabilityIsLoaded()).toBe(false);
  expect(await child.exited).toBe(0);
  expect(terminalCapabilityIsLoaded()).toBe(false);
});

test("Windows native spawn rejects batch files before and after PATHEXT resolution", () => {
  if (process.platform !== "win32") return;

  const directory = mkdtempSync(join(tmpdir(), "cottontail-batch-spawn-"));
  using cleanup = { [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) };
  const commandName = "cottontail-batch-spawn-probe";
  const cmdPath = join(directory, `${commandName}.CmD`);
  const batPath = join(directory, `${commandName}-bat.BaT`);
  const markerPath = join(directory, "batch-executed.txt");
  writeFileSync(cmdPath, `@echo executed>"${markerPath}"\r\n@exit /b 0\r\n`);
  writeFileSync(batPath, `@echo executed>"${markerPath}"\r\n@exit /b 0\r\n`);

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !["PATH", "PATHEXT"].includes(name.toUpperCase())),
  );
  Object.assign(env, { PATH: directory, PATHEXT: ".CMD;.BAT;.COM;.EXE" });

  expectWindowsBatchRejection(
    () => Bun.spawn([cmdPath, "ignored"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
    cmdPath,
  );
  expectWindowsBatchRejection(
    () => Bun.spawnSync([commandName, "ignored"], { env }),
    commandName,
  );
  expectWindowsBatchRejection(
    () => Bun.spawnSync([batPath], { env }),
    batPath,
  );
  expectWindowsBatchRejection(
    () => Bun.spawnSync([`${cmdPath}. `], { env }),
    `${cmdPath}. `,
  );
  expect(existsSync(markerPath)).toBe(false);

  const explicitShell = Bun.spawnSync(
    ["cmd.exe", "/d", "/s", "/c", "exit /b 0"],
    { windowsVerbatimArguments: true },
  );
  expect(explicitShell.exitCode).toBe(0);
});

test("argv0 overrides do not replace arbitrary executables", async () => {
  const externalNode = Bun.which("node");
  expect(externalNode).not.toBeNull();
  const argv0Command = [
    externalNode!,
    "-e",
    "process.stdout.write(process.argv0)",
  ];
  const asyncChild = Bun.spawn(argv0Command, {
    argv0: "async-display-name",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await asyncChild.stdout.text()).toBe("async-display-name");
  expect(await asyncChild.exited).toBe(0);

  const syncChild = Bun.spawnSync(argv0Command, {
    argv0: "sync-display-name",
  });
  expect(syncChild.exitCode).toBe(0);
  expect(syncChild.stdout.toString()).toBe("sync-display-name");

  const nodeChild = nodeSpawnSync(externalNode!, ["-e", "process.stdout.write(process.argv0)"], {
    argv0: "node-display-name",
  });
  expect(nodeChild.status).toBe(0);
  expect(nodeChild.stdout.toString()).toBe("node-display-name");

  if (process.platform === "win32") {
    const argvExpression = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
    const verbatimChild = Bun.spawnSync([
      process.execPath,
      "-e",
      argvExpression,
      "--",
      "hello world",
      '"quoted value"',
      "tail\\",
    ], {
      windowsVerbatimArguments: true,
    });
    expect(verbatimChild.exitCode).toBe(0);
    expect(verbatimChild.stdout.toString()).toBe(
      JSON.stringify(["hello", "world", "quoted value", "tail\\"]),
    );
  }
});

test("overriding process.execPath does not retarget an external executable", async () => {
  const externalNode = Bun.which("node");
  expect(externalNode).not.toBeNull();
  const originalExecPath = process.execPath;

  try {
    process.execPath = externalNode!;
    const child = Bun.spawn([
      process.execPath,
      "-e",
      'process.stdout.write(process.versions.cottontail ? "cottontail" : "node")',
    ], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.stdout.text()).toBe("node");
    expect(await child.exited).toBe(0);
  } finally {
    process.execPath = originalExecPath;
  }
});

test("numeric stdout descriptors route directly in async and sync spawn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-spawn-fd-"));
  using cleanup = { [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) };

  const asyncPath = join(directory, "async.txt");
  const asyncFd = openSync(asyncPath, "w+");
  const asyncChild = Bun.spawn(stdoutCommand("async-fd"), {
    stdin: "ignore",
    stdout: asyncFd,
    stderr: "ignore",
  });
  expect(asyncChild.stdout).toBe(asyncFd);
  expect(await asyncChild.exited).toBe(0);
  closeSync(asyncFd);
  expect(readFileSync(asyncPath, "utf8")).toBe("async-fd");

  const syncPath = join(directory, "sync.txt");
  const syncFd = openSync(syncPath, "w+");
  const syncChild = Bun.spawnSync(stdoutCommand("sync-fd"), {
    stdin: "ignore",
    stdout: syncFd,
    stderr: "ignore",
  });
  expect(syncChild.exitCode).toBe(0);
  expect(syncChild.stdout).toBe(syncFd);
  closeSync(syncFd);
  expect(readFileSync(syncPath, "utf8")).toBe("sync-fd");

  const nodePath = join(directory, "node.txt");
  const nodeFd = openSync(nodePath, "w+");
  const nodeChild = nodeSpawnSync(process.execPath, ["-e", "process.stdout.write('node-fd')"], {
    stdio: ["ignore", nodeFd, "ignore"],
  });
  expect(nodeChild.status).toBe(0);
  expect(nodeChild.stdout).toBeNull();
  closeSync(nodeFd);
  expect(readFileSync(nodePath, "utf8")).toBe("node-fd");
});

test("extra pipe descriptors are exposed and connected to the child", async () => {
  const externalNode = Bun.which("node");
  expect(externalNode).not.toBeNull();
  const child = Bun.spawn([
    externalNode!,
    "-e",
    `require("node:fs").writeSync(3, "extra-pipe"); setTimeout(() => {}, 100)`,
  ], {
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  const fd = child.stdio[3];
  expect(typeof fd).toBe("number");
  let output: string;
  try {
    output = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  expect(output).toBe("extra-pipe");
  expect(await child.exited).toBe(0);
});

test("same-slot numeric descriptors clear close-on-exec", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-spawn-same-fd-"));
  using cleanup = { [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) };
  const outputPath = join(directory, "same-slot.txt");
  const fd = openSync(outputPath, "w+");
  const stdio = Array.from({ length: fd + 1 }, () => "ignore" as const);
  stdio[fd] = fd as any;
  const externalNode = Bun.which("node");
  expect(externalNode).not.toBeNull();

  const child = Bun.spawn([
    externalNode!,
    "-e",
    `require("node:fs").writeSync(${fd}, "same-slot")`,
  ], { stdio });
  expect(await child.exited).toBe(0);
  closeSync(fd);
  expect(readFileSync(outputPath, "utf8")).toBe("same-slot");
});

// Bun 1.3.10 on Windows also never establishes the external Node extra-fd IPC channel.
test.skipIf(process.platform === "win32")("Bun.spawn IPC launches Node directly with its requested argv0", async () => {
  let resolveMessage!: (value: { argv0: string; pid: number }) => void;
  const messagePromise = new Promise<{ argv0: string; pid: number }>((resolve) => {
    resolveMessage = resolve;
  });
  const child = Bun.spawn({
    cmd: ["node", "-e", "process.send({ argv0: process.argv0, pid: process.pid })"],
    argv0: "node-ipc-display-name",
    ipc(message) {
      resolveMessage(message as { argv0: string; pid: number });
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });

  const [message, exitCode] = await Promise.all([messagePromise, child.exited]);
  expect(exitCode).toBe(0);
  expect(message.argv0).toBe("node-ipc-display-name");
  expect(message.pid).toBe(child.pid);
});

test("Bun subprocess ref and unref return undefined", async () => {
  const child = Bun.spawn([process.execPath, "-e", ""], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(child.unref()).toBeUndefined();
  expect(child.ref()).toBeUndefined();
  expect(await child.exited).toBe(0);
});
