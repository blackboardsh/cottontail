import { expect, test } from "bun:test";
import { canonicalBakeProjectRoot, normalizeBakeAssetPath } from "../../src/runtime_modules/bun/bake-dev-server.js";
import { Dev } from "../../compat/upstream/bun/v1.3.10/test/bake/bake-harness.ts";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Bake asset paths normalize filesystem segments without parsing path characters as URL syntax", () => {
  expect(normalizeBakeAssetPath("../../../private/tmp/entry.js")).toBe("/private/tmp/entry.js");
  expect(normalizeBakeAssetPath("entry #?.js", "/assets")).toBe("/assets/entry%20%23%3F.js");
  expect(normalizeBakeAssetPath("%2e%2e/entry.js", "/assets")).toBe("/assets/%252e%252e/entry.js");
  expect(normalizeBakeAssetPath("dir\\entry.js", "/assets")).toBe("/assets/dir%5Centry.js");
  expect(normalizeBakeAssetPath("//server/share/entry.js")).toBe("///server/share/entry.js");
  expect(normalizeBakeAssetPath("entry.js", "/assets%20root")).toBe("/assets%20root/entry.js");
  const root = mkdtempSync(join(tmpdir(), "cottontail-bake-root-"));
  try {
    const canonical = join(root, "canonical");
    const alias = join(root, "alias");
    mkdirSync(canonical);
    symlinkSync(canonical, alias, "dir");
    expect(canonicalBakeProjectRoot(alias)).toBe(realpathSync(canonical));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bake launcher preloads resolve bare packages from the user entrypoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "cottontail-bake-preload-"));
  const packageName = `cottontail-bake-preload-${process.pid}-${Date.now()}`;
  const packageRoot = join(root, "node_modules", packageName);
  const originalMain = process.argv[1];
  try {
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(root, "entry.ts"), "export {};\n");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: packageName,
      type: "module",
      exports: "./index.js",
    }));
    writeFileSync(join(packageRoot, "index.js"), 'export default "PASS";\n');
    process.argv[1] = join(root, "entry.ts");

    const generatedReferrer = join(root, "cottontail", "run", "fixture", "script-entry-runtime-test.mjs");
    const namespace = await (globalThis as any).__cottontailImportModule(packageName, generatedReferrer);
    expect(namespace.default).toBe("PASS");
  } finally {
    process.argv[1] = originalMain;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bake hot-reload waits reject and clean up when an expected client fails", async () => {
  for (const event of ["exit", "error"] as const) {
    const dev = Object.assign(new EventEmitter(), {
      nodeEnv: "development",
      connectedClients: new Set<EventEmitter>(),
    });
    const client = Object.assign(new EventEmitter(), {
      exited: false,
      exitCode: null,
    });
    dev.connectedClients.add(client);

    const wait = Dev.prototype.waitForHotReload.call(dev, true);
    expect(client.listenerCount("received-hmr-event")).toBe(1);
    expect(client.listenerCount("exit")).toBe(1);
    expect(client.listenerCount("error")).toBe(1);
    // AnyBuildFinishedWaitForWebSockets: the build is done, but this client is
    // still part of the snapshotted HMR barrier.
    dev.emit("watch_synchronization", 4);
    if (event === "exit") client.emit(event, 17, new Error("client transport closed"));
    else client.emit(event, new Error("client transport failed"));

    const outcome = await Promise.race([
      wait.then(
        () => "resolved",
        error => error,
      ),
      Bun.sleep(100).then(() => "timeout"),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/before hot-reload synchronization completed/);
    expect(client.listenerCount("received-hmr-event")).toBe(0);
    expect(client.listenerCount("exit")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
    expect(dev.listenerCount("watch_synchronization")).toBe(0);
    client.emit("received-hmr-event");
    dev.emit("watch_synchronization", 4);
  }
});
