import { spawn, spawnSync } from "bun";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(fn: () => unknown, label: string) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, `${label} did not throw`);
}

const objectForm = (spawnSync as any)(
  { cmd: ["sh", "-c", "printf object"], stdout: "pipe" },
  { stdout: "ignore" },
);
assert(objectForm.stdout?.toString() === "object", "object-form options were overridden by a second argument");

for (const stdio of [null, []] as const) {
  const result = spawnSync(["sh", "-c", "printf default"], { stdio: stdio as any, stdout: "ignore" });
  assert(result.stdout?.toString() === "default", "stdio presence did not take precedence over stdout");
}

const ignored = spawnSync(["sh", "-c", "printf ignored"], {
  stdio: ["ignore", "ignore", "ignore"],
  stdout: "pipe",
} as any);
assert(ignored.stdout === undefined, "stdio array did not override stdout");

assert(spawnSync(["true"], { onExit: null as any }).exitCode === 0, "null onExit was not ignored");
assert(spawnSync(["true"], { signal: "" as any }).exitCode === 0, "empty signal was not ignored");
assert(spawnSync(["true"], { env: "" as any }).exitCode === 0, "empty env was not ignored");
assert(spawnSync(["true"], { terminal: "" as any }).exitCode === 0, "empty terminal was not ignored");
assertThrows(() => spawnSync(["true"], { onExit: false as any }), "false onExit");
assertThrows(() => spawnSync(["true"], { signal: false as any }), "false signal");
assertThrows(() => spawnSync(["true"], { env: false as any }), "false env");
assertThrows(() => spawnSync(["true"], { terminal: false as any }), "false terminal");
assertThrows(() => spawn(["true"], { terminal: false as any }), "false async terminal");

const envValues = spawnSync(
  [process.execPath, "-e", "console.log(`${process.env.A}|${process.env.B}`)"],
  { env: { A: null as any, B: undefined } },
);
assert(envValues.stdout?.toString().trim() === "null|undefined", "spawn env coercion mismatch");

const defaults = spawn(["sh", "-c", "printf async"]);
assert(defaults.stdin === undefined, "default async stdin must be ignored");
assert(defaults.stdout != null, "default async stdout must be piped");
assert(defaults.stderr === undefined, "default async stderr must be inherited");
assert(await defaults.stdout.text() === "async", "default async stdout mismatch");
assert(await defaults.exited === 0, "default async child failed");

const ignoredIpc = spawn(["true"], { ipc: true as any });
assert(ignoredIpc.connected === false, "non-callable ipc option opened a channel");
assert(await ignoredIpc.exited === 0, "non-callable ipc child failed");

let onExitThis: unknown;
let onExitChild: unknown;
const callbackChild = spawn(["true"], {
  onExit(this: unknown, subprocess: unknown) {
    onExitThis = this;
    onExitChild = subprocess;
    return new Promise(() => {});
  },
});
assert(await callbackChild.exited === 0, "onExit return value delayed the exited promise");
assert(onExitThis === callbackChild && onExitChild === callbackChild, "onExit subprocess receiver/argument mismatch");

const killedChild = spawn(["sh", "-c", "sleep 1"], { stdout: "ignore", stderr: "ignore" });
killedChild.kill(0);
assert(killedChild.killed === false, "kill(0) marked the subprocess killed");
killedChild.kill("SIGTERM");
assert(killedChild.killed === false, "subprocess was marked killed before its exit was observed");
await killedChild.exited;
assert(killedChild.killed === true && killedChild.signalCode === "SIGTERM", "killed subprocess state mismatch");

console.log("bun spawn contract passed");
