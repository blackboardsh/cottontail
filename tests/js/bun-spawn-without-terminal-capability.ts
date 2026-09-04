const terminalCapabilityIsLoaded = () => Boolean(
  ((globalThis as any)[Symbol.for("cottontail.capabilityModuleCache")] as Map<string, unknown> | undefined)
    ?.has("terminal"),
);

if (terminalCapabilityIsLoaded()) {
  throw new Error("terminal capability was loaded before ordinary spawn");
}
const externalNode = Bun.which("node");
if (externalNode == null) throw new Error("node executable not found");

const child = Bun.spawn([externalNode, "-e", "process.exit(0)"], {
  detached: true,
  stdio: ["ignore", "ignore", "ignore"],
});

if (terminalCapabilityIsLoaded()) {
  throw new Error("ordinary spawn loaded the terminal capability while starting");
}
if (await child.exited !== 0) {
  throw new Error("ordinary spawned process failed");
}
if (terminalCapabilityIsLoaded()) {
  throw new Error("ordinary spawn loaded the terminal capability while exiting");
}

const pipedChild = Bun.spawn([externalNode, "-e", "process.stdout.write('core-only')"], {
  stdout: "pipe",
  stderr: "pipe",
});
if (await pipedChild.stdout.text() !== "core-only" || await pipedChild.exited !== 0) {
  throw new Error("default piped spawn failed");
}
if (terminalCapabilityIsLoaded()) {
  throw new Error("default piped spawn loaded the terminal capability");
}

console.log("bun spawn without terminal capability passed");
