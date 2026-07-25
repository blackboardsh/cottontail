import { dlopen } from "bun:ffi";
import { spawnSync } from "node:child_process";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const HANDLE_FLAG_INHERIT = 0x1;
const WAIT_TIMEOUT = 0x102;
const kernel32 = dlopen("kernel32.dll", {
  CreateEventW: { args: ["ptr", "bool", "bool", "ptr"], returns: "ptr" },
  SetHandleInformation: { args: ["ptr", "uint32_t", "uint32_t"], returns: "bool" },
  WaitForSingleObject: { args: ["ptr", "uint32_t"], returns: "uint32_t" },
  CloseHandle: { args: ["ptr"], returns: "bool" },
});
const {
  CreateEventW,
  SetHandleInformation,
  WaitForSingleObject,
  CloseHandle,
} = kernel32.symbols;

/*
 * An inheritable event models a child handle prepared by another worker's
 * concurrent spawn. CreateProcessW(..., TRUE, ...) leaks it deterministically
 * unless the spawn supplies PROC_THREAD_ATTRIBUTE_HANDLE_LIST.
 */
const handle = CreateEventW(null, true, false, null);
assert(handle != null, "CreateEventW failed");
assert(
  SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT),
  "SetHandleInformation failed",
);

const probeSource = String.raw`
  const { dlopen } = require("bun:ffi");
  const kernel32 = dlopen("kernel32.dll", {
    SetEvent: { args: ["ptr"], returns: "bool" },
  });
  const signaled = kernel32.symbols.SetEvent(Number(process.env.COTTONTAIL_TEST_INHERITABLE_HANDLE));
  process.stdout.write(signaled ? "set-event" : "set-event-failed");
  kernel32.close();
`;

try {
  const probe = spawnSync(process.execPath, ["-e", probeSource], {
    env: {
      ...process.env,
      COTTONTAIL_TEST_INHERITABLE_HANDLE: String(handle),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert(
    probe.status === 0,
    `handle-isolation probe exited with ${probe.status}: ${probe.stderr}`,
  );
  assert(
    WaitForSingleObject(handle, 0) === WAIT_TIMEOUT,
    `an unrelated inheritable handle leaked into a child process (${probe.stdout})`,
  );

  console.log("node child_process Windows handle isolation passed");
} finally {
  SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
  CloseHandle(handle);
  kernel32.close();
}
