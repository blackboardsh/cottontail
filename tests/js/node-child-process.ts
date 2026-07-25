import { ChildProcess, execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { ETIMEDOUT } from "node:constants";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const isWindows = cottontail.platform() === "win32";
const shellProgram = isWindows ? "cmd.exe" : "sh";
const shellArgs = (posix: string, windows: string, delayedExpansion = false) =>
  isWindows
    ? ["/d", ...(delayedExpansion ? ["/v:on"] : []), "/s", "/c", windows]
    : ["-c", posix];
const directShellOptions = isWindows ? { windowsVerbatimArguments: true } : {};

const child = spawn(shellProgram, shellArgs(
  "read value; printf stdout-$value; printf stderr-$value >&2",
  'set /p value=& <nul set /p "=stdout-!value!" & <nul set /p "=stderr-!value!" 1>&2 & exit /b 0',
  true,
), {
  ...directShellOptions,
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const result = await new Promise<{ code: number | null; signal: number | null }>((resolve) => {
  child.on("close", (code, signal) => resolve({ code, signal }));
  child.stdin.end("ok");
});

assert(result.code === 0, `child_process.spawn exit mismatch: ${result.code}`);
assert(result.signal === null, `child_process.spawn signal mismatch: ${result.signal}`);
assert(stdout === "stdout-ok", `child_process.spawn stdout mismatch: ${JSON.stringify(stdout)}`);
assert(stderr === "stderr-ok", `child_process.spawn stderr mismatch: ${JSON.stringify(stderr)}`);

const inherited = spawn(shellProgram, shellArgs(
  "printf inherited-stdout; printf inherited-stderr >&2",
  '<nul set /p "=inherited-stdout" & <nul set /p "=inherited-stderr" 1>&2 & exit /b 0',
), {
  ...directShellOptions,
  stdio: "inherit",
});

const inheritedResult = await new Promise<{ code: number | null; signal: number | null }>((resolve) => {
  inherited.on("close", (code, signal) => resolve({ code, signal }));
});

assert(inherited.stdout === null, "inherited child stdout should be null");
assert(inherited.stderr === null, "inherited child stderr should be null");
assert(inheritedResult.code === 0, `inherited child exit mismatch: ${inheritedResult.code}`);
assert(inheritedResult.signal === null, `inherited child signal mismatch: ${inheritedResult.signal}`);

const inheritedSync = isWindows
  ? spawnSync("cmd.exe", ["/D", "/C", "echo inherited-sync-stdout & echo inherited-sync-stderr 1>&2"], { stdio: "inherit" })
  : spawnSync("sh", ["-c", "printf inherited-sync-stdout; printf inherited-sync-stderr >&2"], { stdio: "inherit" });
assert(inheritedSync.status === 0, `inherited spawnSync exit mismatch: ${inheritedSync.status}`);
assert(inheritedSync.stdout === null, "inherited spawnSync stdout should be null");
assert(inheritedSync.stderr === null, "inherited spawnSync stderr should be null");

if (isWindows) {
  for (const suffix of ["cmd", "CMD", "bat", "cmd ", "cmd ...."]) {
    let asyncError: any;
    try {
      spawn(`missing.${suffix}`);
    } catch (error) {
      asyncError = error;
    }
    assert(asyncError?.code === "EINVAL", `direct Windows batch spawn did not throw EINVAL for ${suffix}`);
    assert(asyncError?.errno === -4071, `direct Windows batch spawn errno mismatch for ${suffix}`);
    const batchResult = spawnSync(`missing.${suffix}`);
    assert(batchResult.status === null, `direct Windows batch spawnSync status mismatch for ${suffix}`);
    assert(batchResult.error?.code === "EINVAL", `direct Windows batch spawnSync code mismatch for ${suffix}`);
    assert(batchResult.error?.errno === -4071, `direct Windows batch spawnSync errno mismatch for ${suffix}`);
  }
}

const shellChild = spawn(
  isWindows ? '<nul set /p "=shell-ok" & exit /b 0' : "printf shell-ok",
  { shell: isWindows ? "cmd.exe" : "/bin/sh", stdio: ["ignore", "pipe", "pipe"] },
);
shellChild.stdout.setEncoding("utf8");
let shellOut = "";
shellChild.stdout.on("data", (chunk) => {
  shellOut += chunk;
});
const shellCode = await new Promise<number | null>((resolve) => {
  shellChild.on("close", (code) => resolve(code));
});
assert(shellCode === 0, `shell child exit mismatch: ${shellCode}`);
assert(shellOut === "shell-ok", `shell child stdout mismatch: ${JSON.stringify(shellOut)}`);

let piped = "";
const pipeChild = spawn(shellProgram, shellArgs(
  "printf piped",
  '<nul set /p "=piped" & exit /b 0',
), { ...directShellOptions, stdio: ["ignore", "pipe", "pipe"] });
pipeChild.stdout.pipe({
  write(chunk: unknown) {
    piped += String(chunk);
  },
  end() {},
});
await new Promise<void>((resolve) => pipeChild.on("close", () => resolve()));
assert(piped === "piped", `child stdout pipe mismatch: ${JSON.stringify(piped)}`);

const stdinBackpressureChild = spawn(shellProgram, shellArgs(
  "cat >/dev/null",
  "more >nul",
), { ...directShellOptions, stdio: ["pipe", "ignore", "pipe"], highWaterMark: 2 });
const stdinAccepted = stdinBackpressureChild.stdin.write("abcd");
assert(stdinAccepted === false, "child stdin write should report backpressure over highWaterMark");
assert(stdinBackpressureChild.stdin.writableNeedDrain === true, "child stdin writableNeedDrain mismatch");
await new Promise<void>((resolve) => stdinBackpressureChild.stdin.once("drain", () => resolve()));
assert(stdinBackpressureChild.stdin.writableLength === 0, "child stdin writableLength should drain to zero");
assert(stdinBackpressureChild.stdin.writableNeedDrain === false, "child stdin writableNeedDrain should reset");
stdinBackpressureChild.stdin.end();
await new Promise<void>((resolve) => stdinBackpressureChild.on("close", () => resolve()));

const syncResult = spawnSync(process.execPath, [
  "-e",
  "process.stdout.write('sync-out'); process.stderr.write('sync-err')",
]);
assert(syncResult.status === 0, `spawnSync status mismatch: ${syncResult.status}`);
assert(syncResult.signal === null, "spawnSync signal mismatch");
assert(syncResult.stdout.toString() === "sync-out", "spawnSync stdout Buffer mismatch");
assert(syncResult.stderr.toString() === "sync-err", "spawnSync stderr Buffer mismatch");
assert(syncResult.output[1].toString() === "sync-out", "spawnSync output stdout mismatch");

const timeoutStartedAt = Date.now();
const timeoutResult = spawnSync("sh", ["-c", "sleep 5"], { timeout: 10 });
assert(timeoutResult.error?.code === "ETIMEDOUT", "spawnSync timeout code mismatch");
assert(timeoutResult.error?.errno === -ETIMEDOUT, "spawnSync timeout errno mismatch");
assert(Date.now() - timeoutStartedAt < 1_000, "spawnSync timeout waited for a descendant-held pipe");

const platformSignalAlias = process.platform === "linux"
  ? "SIGPOLL"
  : process.platform === "darwin"
    ? "SIGINFO"
    : "SIGTERM";
assert(new ChildProcess().kill(platformSignalAlias) === false, "child_process platform signal alias mismatch");

const mixedStdioResult = spawnSync(process.execPath, ["-e", "process.stdout.write('mixed-stdio')"], {
  stdio: [process.stdin, "pipe", process.stderr],
});
assert(mixedStdioResult.status === 0, `mixed spawnSync status mismatch: ${mixedStdioResult.status}`);
assert(mixedStdioResult.stdout.toString() === "mixed-stdio", "spawnSync stream stdio mapping mismatch");

const nestedOutput = execFileSync(
  process.execPath,
  ["-e", "process.stdout.write('nested-ok')"],
  { encoding: "utf8" },
);
assert(nestedOutput === "nested-ok", `nested process.execPath output mismatch: ${JSON.stringify(nestedOutput)}`);

if (isWindows) {
  const argvExpression = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
  const argvPayload = ["hello world", '"quoted value"', "tail\\"];
  const normalArgv = spawnSync(
    process.execPath,
    ["-e", argvExpression, "--", ...argvPayload],
    { encoding: "utf8" },
  );
  assert(normalArgv.status === 0, `normal spawnSync argv probe failed: ${normalArgv.stderr}`);
  assert(
    normalArgv.stdout === JSON.stringify(argvPayload),
    `normal spawnSync argv quoting mismatch: ${JSON.stringify(normalArgv.stdout)}`,
  );

  const verbatimExpected = ["hello", "world", "quoted value", "tail\\"];
  const verbatimArgv = spawnSync(
    process.execPath,
    ["-e", argvExpression, "--", ...argvPayload],
    { encoding: "utf8", windowsVerbatimArguments: true },
  );
  assert(verbatimArgv.status === 0, `verbatim spawnSync argv probe failed: ${verbatimArgv.stderr}`);
  assert(
    verbatimArgv.stdout === JSON.stringify(verbatimExpected),
    `verbatim spawnSync argv mismatch: ${JSON.stringify(verbatimArgv.stdout)}`,
  );

  const verbatimExecFile = execFileSync(
    process.execPath,
    ["-e", argvExpression, "--", ...argvPayload],
    { encoding: "utf8", windowsVerbatimArguments: true },
  );
  assert(
    verbatimExecFile === JSON.stringify(verbatimExpected),
    `verbatim execFileSync argv mismatch: ${JSON.stringify(verbatimExecFile)}`,
  );

  const parentSystemRoot = process.env.SystemRoot;
  assert(typeof parentSystemRoot === "string" && parentSystemRoot.length > 0, "parent SystemRoot is missing");
  const isolatedSystemRoot = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(process.env.SystemRoot || '')"],
    {
      encoding: "utf8",
      env: {
        COTTONTAIL_SYSTEM_ROOT_PROBE: "isolated",
        ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}),
      },
    },
  );
  assert(isolatedSystemRoot.status === 0, `isolated spawnSync failed: ${isolatedSystemRoot.stderr}`);
  assert(
    isolatedSystemRoot.stdout === parentSystemRoot,
    `spawnSync did not inherit SystemRoot: ${JSON.stringify(isolatedSystemRoot.stdout)}`,
  );

  const customSystemRootKey = "sYsTeMrOoT";
  const customSystemRoot = spawnSync(
    process.execPath,
    [
      "-e",
      "const key=Object.keys(process.env).find(key=>key.toLowerCase()==='systemroot');" +
        "process.stdout.write(JSON.stringify([key, key && process.env[key]]))",
    ],
    {
      argv0: "system-root-override-probe",
      encoding: "utf8",
      env: {
        [customSystemRootKey]: parentSystemRoot,
        ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}),
      },
    },
  );
  assert(customSystemRoot.status === 0, `custom SystemRoot spawnSync failed: ${customSystemRoot.stderr}`);
  assert(
    customSystemRoot.stdout === JSON.stringify([customSystemRootKey, parentSystemRoot]),
    `custom SystemRoot spelling/value was not preserved: ${JSON.stringify(customSystemRoot.stdout)}`,
  );
}

const maxBufferError = await new Promise<any>((resolve) => {
  execFile(
    process.execPath,
    ["-e", "process.stdout.write('too-long')"],
    { maxBuffer: 3 },
    (error) => resolve(error),
  );
});
assert(maxBufferError?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "execFile maxBuffer error mismatch");

const controller = new AbortController();
const abortChild = spawn(shellProgram, shellArgs(
  "sleep 5",
  "ping 127.0.0.1 -n 6 >nul",
), { ...directShellOptions, signal: controller.signal, stdio: ["ignore", "pipe", "pipe"] });
const abortError = new Promise<any>((resolve) => abortChild.on("error", resolve));
const abortClose = new Promise<void>((resolve) => abortChild.on("close", () => resolve()));
controller.abort();
const aborted = await abortError;
assert(aborted?.name === "AbortError", "spawn AbortSignal error mismatch");
await abortClose;

console.log("node child_process spawn passed");
