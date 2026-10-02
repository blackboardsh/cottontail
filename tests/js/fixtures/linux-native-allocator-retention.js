import { dlopen, toArrayBuffer } from "bun:ffi";

const { symbols } = dlopen("libc.so.6", {
  malloc: { args: ["u64"], returns: "ptr" },
  free: { args: ["ptr"], returns: "void" },
  memset: { args: ["ptr", "i32", "u64"], returns: "ptr" },
});

const idleProbe = process.argv.at(-1) === "idle";

function run() {
  // Small live allocations between freed blocks prevent the arena's top from
  // shrinking automatically. These model native compiler/loader scratch space
  // interleaved with long-lived runtime state, outside JSC's heap and libpas.
  const blocks = [];
  const pins = [];
  const blockSize = 64 * 1024;
  const count = 2048;
  for (let index = 0; index < count; index++) {
    const block = symbols.malloc(blockSize);
    const pin = symbols.malloc(32);
    if (!block || !pin) throw new Error("Allocation failed");
    symbols.memset(block, 0x5a, blockSize);
    symbols.memset(pin, 0x3c, 32);
    blocks.push(block);
    pins.push(pin);
  }
  for (const block of blocks) symbols.free(block);
  const before = process.memoryUsage().rss;
  if (!idleProbe) Bun.gc(true);
  function finish() {
    const after = process.memoryUsage().rss;
    for (const pin of pins) {
      if (new Uint8Array(toArrayBuffer(pin, 0, 32)).some(byte => byte !== 0x3c)) {
        throw new Error("Collection damaged live native state");
      }
      symbols.free(pin);
    }
    console.log(JSON.stringify({ reclaimed: before - after }));
  }
  if (idleProbe) setTimeout(finish, 6500);
  else finish();
}

// Allocate only after startup collection, without enough JS heap growth to
// trigger the adaptive collector. Idle trimming must notice native frees.
if (idleProbe) setTimeout(run, 250);
else run();
