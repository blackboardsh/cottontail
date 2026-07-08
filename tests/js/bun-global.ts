if (!globalThis.Bun?.spawnSync || !globalThis.Bun?.serve || !globalThis.Response) {
  throw new Error("Bun global runtime APIs were not installed");
}

if (typeof globalThis.crypto?.randomUUID !== "function") {
  throw new Error("global crypto.randomUUID was not installed");
}

const uuid = globalThis.crypto.randomUUID();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) {
  throw new Error(`crypto.randomUUID returned an invalid UUID: ${uuid}`);
}

const bareUuid = crypto.randomUUID();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(bareUuid)) {
  throw new Error(`bare crypto.randomUUID returned an invalid UUID: ${bareUuid}`);
}

const randomValues = globalThis.crypto.getRandomValues(new Uint8Array(8));
if (!(randomValues instanceof Uint8Array) || randomValues.length !== 8) {
  throw new Error("crypto.getRandomValues did not return the input typed array");
}

const result = Bun.spawnSync(["sh", "-c", "printf bun-global"]);
if (!result.success || result.stdout.toString() !== "bun-global") {
  throw new Error("Bun.spawnSync global call failed");
}

const shellPath = Bun.which("sh");
if (cottontail.platform() !== "win32" && (!shellPath || !shellPath.endsWith("/sh"))) {
  throw new Error(`Bun.which failed to resolve sh: ${shellPath}`);
}

const buffer = Buffer.concat([Buffer.from("git "), Buffer.from("version")]);
if (!Buffer.isBuffer(buffer) || !(buffer instanceof Buffer) || buffer.toString() !== "git version") {
  throw new Error("Buffer compatibility APIs failed");
}

console.log("bun global passed");
