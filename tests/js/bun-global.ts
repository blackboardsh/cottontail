if (!globalThis.Bun?.spawnSync || !globalThis.Bun?.serve || !globalThis.Response) {
  throw new Error("Bun global runtime APIs were not installed");
}

const result = Bun.spawnSync(["sh", "-c", "printf bun-global"]);
if (!result.success || result.stdout.toString() !== "bun-global") {
  throw new Error("Bun.spawnSync global call failed");
}

console.log("bun global passed");
