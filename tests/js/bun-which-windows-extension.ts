import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const tempDir = cottontail.env("COTTONTAIL_TMP_DIR");
assert(tempDir, "COTTONTAIL_TMP_DIR missing");

if (cottontail.platform() === "win32") {
  const root = join(tempDir, "bun-which-windows-extension");
  const command = "cottontail-which-probe";
  const executable = join(root, `${command}.exe`);

  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(executable, "");
    const expected = realpathSync(executable).replaceAll("/", "\\").toLowerCase();
    const explicitExtension = Bun.which(`${command}.exe`, { PATH: root });
    const inferredExtension = Bun.which(command, { PATH: root });

    assert(
      inferredExtension?.replaceAll("/", "\\").toLowerCase() === expected,
      `Bun.which extensionless lookup mismatch: ${String(inferredExtension)}`,
    );
    assert(
      explicitExtension?.replaceAll("/", "\\").toLowerCase() === expected,
      `Bun.which extension-present lookup mismatch: ${String(explicitExtension)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("bun which windows extension passed");
