if (!globalThis.Bun?.spawnSync || !globalThis.Bun?.serve || !globalThis.Response) {
  throw new Error("Bun global runtime APIs were not installed");
}

if (Bun.version !== "1.3.10" || process.versions.bun !== Bun.version) {
  throw new Error(`Bun compatibility version mismatch: ${Bun.version} / ${process.versions.bun}`);
}
if (process.versions.cottontail !== String(cottontail.processInfo("version"))) {
  throw new Error(`Cottontail product version mismatch: ${process.versions.cottontail}`);
}
if (Object.prototype.toString.call(process) !== "[object process]") {
  throw new Error("process Symbol.toStringTag branding mismatch");
}

if (typeof globalThis.crypto?.randomUUID !== "function") {
  throw new Error("global crypto.randomUUID was not installed");
}

if (typeof SharedArrayBuffer === "function") {
  const shared = new SharedArrayBuffer(1);
  if (!(shared instanceof SharedArrayBuffer) || shared instanceof ArrayBuffer) {
    throw new Error("SharedArrayBuffer constructor identity mismatch");
  }
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

const nodeCrypto = require("node:crypto");
try {
  nodeCrypto.timingSafeEqual(new Uint8Array([1]), "1");
  throw new Error("crypto.timingSafeEqual should reject strings");
} catch (error) {
  if (!(error instanceof TypeError)) throw error;
}

let globalMessage = "";
globalThis.onmessage = (event) => { globalMessage = event.data; };
globalThis.dispatchEvent(new MessageEvent("message", { data: "global-message" }));
globalThis.onmessage = null;
if (globalMessage !== "global-message") {
  throw new Error("global onmessage handler was not dispatched");
}

if (typeof globalThis.postMessage !== "function" || globalThis.postMessage("main-thread-noop") !== undefined) {
  throw new Error("main-thread postMessage global behavior mismatch");
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

const protocolBuffer = Buffer.from('Content-Length: 11\r\n\r\n{"ok":true}');
const separator = Buffer.from("\r\n\r\n");
if (protocolBuffer.indexOf("\r\n\r\n") !== 18 || protocolBuffer.indexOf(separator) !== 18) {
  throw new Error("Buffer.indexOf failed to find protocol separator");
}
const protocolBody = protocolBuffer.slice(protocolBuffer.indexOf(separator) + separator.length);
if (!Buffer.isBuffer(protocolBody) || protocolBody.toString("utf8") !== '{"ok":true}') {
  throw new Error(`Buffer.slice/toString compatibility failed: ${protocolBody.toString("utf8")}`);
}
if (!protocolBuffer.includes(separator)) {
  throw new Error("Buffer.includes failed to find protocol separator");
}
if (Buffer.from("ff", "hex").toString("base64") !== "/w==") {
  throw new Error("Buffer hex/base64 encoding compatibility failed");
}

if (typeof Blob !== "function" || typeof File !== "function" || typeof URL.createObjectURL !== "function") {
  throw new Error("Blob/File object URL globals were not installed");
}
const globalBlob = new Blob(["global-blob"], { type: "text/plain" });
if (globalBlob.size !== 11 || globalBlob.type !== "text/plain;charset=utf-8" || await globalBlob.text() !== "global-blob") {
  throw new Error("Blob global behavior mismatch");
}
const directTypedArrayBlob = new Blob(Buffer.from("1234"));
if (await directTypedArrayBlob.text() !== "1234") {
  throw new Error("direct typed-array Blob construction mismatch");
}
if (await new Blob(["BunFoo"]).slice(-3, 4).text() !== "F") {
  throw new Error("Blob negative slice mismatch");
}
const typedModuleBlob = new Blob([
  "export function typedBlob(value: any): boolean { return Bun.inspect(new Error()).includes('typedBlob(value: any): boolean'); }",
], { type: "application/typescript" });
const typedModuleURL = URL.createObjectURL(typedModuleBlob);
const typedModule = await import(typedModuleURL);
URL.revokeObjectURL(typedModuleURL);
if (typedModule.typedBlob() !== true) {
  throw new Error("TypeScript Blob module stack-source mismatch");
}
const globalFile = new File(["file"], "sample.txt", { type: "text/plain", lastModified: 1 });
if (globalFile.name !== "sample.txt" || globalFile.lastModified !== 1 || await globalFile.text() !== "file") {
  throw new Error("File global behavior mismatch");
}
const globalObjectUrl = URL.createObjectURL(globalBlob);
if (globalThis.resolveObjectURL(globalObjectUrl) !== globalBlob) {
  throw new Error("global resolveObjectURL failed");
}
URL.revokeObjectURL(globalObjectUrl);
if (globalThis.resolveObjectURL(globalObjectUrl) !== undefined) {
  throw new Error("global revokeObjectURL failed");
}

console.log("bun global passed");
