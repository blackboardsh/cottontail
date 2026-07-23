import { ChildProcess, execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { ETIMEDOUT } from "node:constants";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const child = spawn("sh", ["-c", "read value; printf stdout-$value; printf stderr-$value >&2"], {
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

const inherited = spawn("sh", ["-c", "printf inherited-stdout; printf inherited-stderr >&2"], {
  stdio: "inherit",
});

const inheritedResult = await new Promise<{ code: number | null; signal: number | null }>((resolve) => {
  inherited.on("close", (code, signal) => resolve({ code, signal }));
});

assert(inherited.stdout === null, "inherited child stdout should be null");
assert(inherited.stderr === null, "inherited child stderr should be null");
assert(inheritedResult.code === 0, `inherited child exit mismatch: ${inheritedResult.code}`);
assert(inheritedResult.signal === null, `inherited child signal mismatch: ${inheritedResult.signal}`);

const inheritedSync = cottontail.platform() === "win32"
  ? spawnSync("cmd.exe", ["/D", "/C", "echo inherited-sync-stdout & echo inherited-sync-stderr 1>&2"], { stdio: "inherit" })
  : spawnSync("sh", ["-c", "printf inherited-sync-stdout; printf inherited-sync-stderr >&2"], { stdio: "inherit" });
assert(inheritedSync.status === 0, `inherited spawnSync exit mismatch: ${inheritedSync.status}`);
assert(inheritedSync.stdout === null, "inherited spawnSync stdout should be null");
assert(inheritedSync.stderr === null, "inherited spawnSync stderr should be null");

const shellChild = spawn("printf shell-ok", { shell: "/bin/sh", stdio: ["ignore", "pipe", "pipe"] });
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
const pipeChild = spawn("sh", ["-c", "printf piped"], { stdio: ["ignore", "pipe", "pipe"] });
pipeChild.stdout.pipe({
  write(chunk: unknown) {
    piped += String(chunk);
  },
  end() {},
});
await new Promise<void>((resolve) => pipeChild.on("close", () => resolve()));
assert(piped === "piped", `child stdout pipe mismatch: ${JSON.stringify(piped)}`);

const stdinBackpressureChild = spawn("sh", ["-c", "cat >/dev/null"], { stdio: ["pipe", "ignore", "pipe"], highWaterMark: 2 });
const stdinAccepted = stdinBackpressureChild.stdin.write("abcd");
assert(stdinAccepted === false, "child stdin write should report backpressure over highWaterMark");
assert(stdinBackpressureChild.stdin.writableNeedDrain === true, "child stdin writableNeedDrain mismatch");
await new Promise<void>((resolve) => stdinBackpressureChild.stdin.once("drain", () => resolve()));
assert(stdinBackpressureChild.stdin.writableLength === 0, "child stdin writableLength should drain to zero");
assert(stdinBackpressureChild.stdin.writableNeedDrain === false, "child stdin writableNeedDrain should reset");
stdinBackpressureChild.stdin.end();
await new Promise<void>((resolve) => stdinBackpressureChild.on("close", () => resolve()));

const syncResult = spawnSync("sh", ["-c", "printf sync-out; printf sync-err >&2"]);
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

const maxBufferError = await new Promise<any>((resolve) => {
  execFile("sh", ["-c", "printf too-long"], { maxBuffer: 3 }, (error) => resolve(error));
});
assert(maxBufferError?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "execFile maxBuffer error mismatch");

const controller = new AbortController();
const abortChild = spawn("sh", ["-c", "exec sleep 5"], { signal: controller.signal, stdio: ["ignore", "pipe", "pipe"] });
const abortError = new Promise<any>((resolve) => abortChild.on("error", resolve));
const abortClose = new Promise<void>((resolve) => abortChild.on("close", () => resolve()));
controller.abort();
const aborted = await abortError;
assert(aborted?.name === "AbortError", "spawn AbortSignal error mismatch");
await abortClose;

console.log("node child_process spawn passed");
