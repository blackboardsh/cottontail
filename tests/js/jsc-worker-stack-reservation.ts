import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (cottontail.platform() === "win32") {
  const tempDir = cottontail.env("COTTONTAIL_TMP_DIR");
  assert(tempDir, "COTTONTAIL_TMP_DIR missing");
  const marker = join(tempDir, "jsc-worker-stack-reservation.txt");
  rmSync(marker, { force: true });

  const workerSource = `cottontail.writeFile(${JSON.stringify(marker)}, "ready");`;
  const worker = new Worker(`data:text/javascript,${encodeURIComponent(workerSource)}`);
  try {
    for (let attempt = 0; attempt < 100 && !cottontail.existsSync(marker); attempt += 1) {
      await Bun.sleep(20);
    }
    assert(cottontail.existsSync(marker), "worker did not evaluate its script");
    assert(readFileSync(marker, "utf8") === "ready", "worker marker contents mismatch");
  } finally {
    worker.terminate();
    rmSync(marker, { force: true });
  }
}

console.log("jsc worker stack reservation passed");
