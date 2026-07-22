import { basename, dirname, join, resolve } from "node:path";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Bun's repository runner gives each child an owned TMPDIR and removes it
// after the child exits. Direct Cottontail runs do not have that parent, so
// reproduce the same ownership boundary before the upstream harness loads.
const hostType = typeof (globalThis as any).cottontail;
const isCottontail = hostType === "function" || hostType === "object";
const parentOwnsTemp = process.env.COTTONTAIL_UPSTREAM_TEMP_OWNER === "launcher";
const ownerKey = Symbol.for("cottontail.upstreamTestTempOwner");

if (isCottontail && !parentOwnsTemp && !(globalThis as any)[ownerKey]) {
  const prefix = "cottontail-bun-tests-";
  const base = realpathSync.native(resolve(process.env.COTTONTAIL_UPSTREAM_TMPDIR || tmpdir()));
  const ownedRoot = mkdtempSync(join(base, prefix));
  Object.defineProperty(globalThis, ownerKey, { value: ownedRoot, configurable: false });
  const tempKeys = ["COTTONTAIL_TMP_DIR", "BUN_TMPDIR", "TEST_TMPDIR", "TMPDIR", "TMP", "TEMP"] as const;
  const previous = new Map(tempKeys.map(key => [key, process.env[key]]));
  let finalized = false;

  for (const key of tempKeys) process.env[key] = ownedRoot;

  process.once("exit", () => {
    if (finalized) return;
    finalized = true;

    const keepTemp = process.env.COTTONTAIL_UPSTREAM_KEEP_TEMP === "1" ||
      process.env.COTTONTAIL_KEEP_TEMP !== undefined ||
      process.env.DEBUG === "1";
    if (keepTemp) {
      console.error(`kept upstream temp root: ${ownedRoot}`);
      return;
    }

    // Never remove by name or scan the system temp directory. The only path
    // eligible for deletion is the exact root created by this module.
    if (dirname(ownedRoot) !== base || !basename(ownedRoot).startsWith(prefix)) return;

    for (const key of tempKeys) {
      if (process.env[key] !== ownedRoot) continue;
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    try {
      rmSync(ownedRoot, { recursive: true, force: true });
    } catch (error) {
      console.error(`failed to remove upstream temp root ${ownedRoot}: ${error}`);
    }
  });
}
