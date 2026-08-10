import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

const role = process.argv[2];
const fixturePath = fileURLToPath(import.meta.url);

function spawnDescendant(descendantRole) {
  const child = spawn(process.execPath, [fixturePath, descendantRole], {
    // The descendant must outlive termination of this direct child; otherwise
    // the inherited pipe closes naturally and the regression is not exercised.
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  child.once("error", error => {
    writeSync(2, `failed to spawn inherited-output descendant: ${error.message}\n`);
    process.exit(70);
  });
}

switch (role) {
  case "max-buffer-parent":
    spawnDescendant("flood-descendant");
    setInterval(() => {}, 60_000);
    break;

  case "timeout-parent":
    spawnDescendant("heartbeat-descendant");
    // spawn() does not return until the descendant owns its inherited stdio
    // handles. This marker therefore proves the timeout did not win the race
    // before the fixture established the condition under test.
    writeSync(1, "descendant-ready\n");
    setInterval(() => {}, 60_000);
    break;

  case "flood-descendant": {
    const chunk = Buffer.from("y\n".repeat(128));
    for (;;) writeSync(1, chunk);
  }

  case "heartbeat-descendant":
    // Keep the inherited stdout handle active without creating meaningful
    // buffering pressure. Closing the reader makes the next write fail, so
    // the descendant also cleans itself up promptly after the assertion.
    setInterval(() => writeSync(1, "."), 50);
    break;

  default:
    throw new Error(`unknown inherited-output fixture role: ${role}`);
}
