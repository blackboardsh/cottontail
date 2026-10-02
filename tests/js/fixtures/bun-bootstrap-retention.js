import "bun";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (!process.versions.cottontail) throw new Error("This regression must execute Cottontail");
const check = (value, message) => { if (!value) throw new Error(message); };
const directory = process.argv[2];
check(cottontail.__cottontailTestHostModules === undefined, "test host modules initialized before bun:test was used");

// A real full worker exercises the native worker bundler. Its generated source
// must not retain the unused UDP or test-host implementations as lazy branches.
const workerPath = join(directory, "path-worker.mjs");
writeFileSync(workerPath, [
  'import { basename } from "node:path";',
  'self.onmessage = () => postMessage({ path: basename("/a/worker"), testHost: cottontail.__cottontailTestHostModules !== undefined });',
  '',
].join("\n"));
const worker = new Worker(workerPath);
let timeout;
try {
  const result = await new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("worker bootstrap timed out")), 5_000);
    worker.onerror = event => reject(new Error(String(event.message)));
    worker.onmessage = event => resolve(event.data);
    worker.postMessage("probe");
  });
  check(result.path === "worker" && result.testHost === false, "worker initialized test-only host modules");
} finally {
  clearTimeout(timeout);
  await worker.terminate();
}
const workerDirectory = join(process.env.COTTONTAIL_TMP_DIR, "workers");
const bundles = readdirSync(workerDirectory).filter(name => /^bun-worker-\d+-\d+\.js$/.test(name));
check(bundles.length === 1, "worker bundle was not observed");
const bundled = readFileSync(join(workerDirectory, bundles[0]), "utf8");
// This diagnostic belongs to dgram's native-handle constructor and survives
// minification, unlike bundler file-label comments. Its presence would show
// that the unused implementation is still retained by the source provider.
check(!bundled.includes("native UDP sockets are unavailable"), "unused UDP module remained in the worker source");
check(cottontail.__cottontailTestHostModules === undefined, "worker preparation initialized test host modules in the parent");

// Loading the real test capability must preserve the application's canonical
// builtin objects and the public bun:test/Bun.jest facade identities.
const testApi = await import("bun:test");
testApi.expect(6 * 7).toBe(42);
const host = cottontail.__cottontailTestHostModules;
check(host !== undefined, "test host modules were not initialized on demand");
check(host.Readable === require("node:stream").Readable, "test capability has a second stream realm");
check(host.AsyncLocalStorage === require("node:async_hooks").AsyncLocalStorage, "test capability has a second async-hooks realm");
const fileTest = Bun.jest(import.meta.path);
check(fileTest.expect === testApi.expect && fileTest.test === testApi.test, "test facade identity changed");

let resolvePacket;
const packet = new Promise(resolve => { resolvePacket = resolve; });
const server = await Bun.udpSocket({
  hostname: "127.0.0.1",
  binaryType: "uint8array",
  socket: { data(_socket, data) { resolvePacket(new TextDecoder().decode(data)); } },
});
let client;
let udpTimeout;
try {
  client = await Bun.udpSocket({ hostname: "127.0.0.1" });
  check(client.sendMany(["lazy-udp-ok", server.port, "127.0.0.1"]) === 1, "UDP send failed after lazy loading");
  const received = await Promise.race([
    packet,
    new Promise((_, reject) => { udpTimeout = setTimeout(() => reject(new Error("UDP round trip timed out")), 5_000); }),
  ]);
  check(received === "lazy-udp-ok", "UDP payload changed after lazy loading");
} finally {
  clearTimeout(udpTimeout);
  client?.close();
  server.close();
}
console.log(JSON.stringify({
  cottontail: true, deferredTestHost: true, leanWorkerBundle: true,
  testIdentity: true, udpRoundTrip: true,
}));
