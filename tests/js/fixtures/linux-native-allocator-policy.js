import { dlopen, ptr } from "bun:ffi";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { symbols } = dlopen("libc.so.6", {
  malloc: { args: ["u64"], returns: "ptr" },
  free: { args: ["ptr"], returns: "void" },
  fopen: { args: ["cstring", "cstring"], returns: "ptr" },
  fclose: { args: ["ptr"], returns: "i32" },
  malloc_info: { args: ["i32", "ptr"], returns: "i32" },
});
const directory = mkdtempSync(join(tmpdir(), "cottontail-native-policy-"));
const filename = join(directory, "malloc.xml");
const name = Buffer.from(`${filename}\0`);
const mode = Buffer.from("w\0");

function mappedCount() {
  const file = symbols.fopen(ptr(name), ptr(mode));
  if (!file) throw new Error("Could not open allocator diagnostics");
  const status = symbols.malloc_info(0, file);
  symbols.fclose(file);
  if (status !== 0) throw new Error("Could not read allocator diagnostics");
  const match = /<total type="mmap" count="(\d+)"/.exec(readFileSync(filename, "utf8"));
  if (!match) throw new Error("Missing mmap count in glibc diagnostics");
  return Number(match[1]);
}

try {
  // By default, this free raises the dynamic mmap threshold above 2 MiB.
  // Inspect glibc's own counters instead of inferring policy from RSS or
  // relying on private malloc chunk layouts.
  const warmup = symbols.malloc(8 * 1024 * 1024);
  if (!warmup) throw new Error("Allocation failed");
  symbols.free(warmup);
  const before = mappedCount();
  const block = symbols.malloc(2 * 1024 * 1024);
  if (!block) throw new Error("Allocation failed");
  const after = mappedCount();
  symbols.free(block);
  console.log(JSON.stringify({ mapped: after > before }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
