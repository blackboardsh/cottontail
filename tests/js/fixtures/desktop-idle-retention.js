// Run with --smol to exercise the desktop's low-memory heap policy without
// loading a GUI library or requiring a display server.
let reference;
globalThis.liveDesktopState = { value: "still-live" };
setTimeout(() => {
  globalThis.temporaryBootstrapGraph = Array.from({ length: 120_000 }, (_, index) => ({
    text: `module-${index}-${"x".repeat(100)}`,
    entries: [index, index + 1, index + 2],
  }));
  reference = new WeakRef(globalThis.temporaryBootstrapGraph);
  // Simulate a graph surviving the allocation-triggered collection, then
  // becoming unreachable as lazy initialization finishes. No GC after release.
  Bun.gc(true);
  setTimeout(() => { globalThis.temporaryBootstrapGraph = null; }, 0);
}, 250);
setTimeout(() => {
  console.log(JSON.stringify({
    collected: reference?.deref() === undefined,
    live: globalThis.liveDesktopState.value,
  }));
}, 4_000);
