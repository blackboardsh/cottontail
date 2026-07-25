import { linkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (process.platform === "win32") {
  const root = mkdtempSync(join(process.cwd(), ".cottontail-windows-env-case-"));
  try {
    const winningBin = join(root, "winning-bin");
    const losingBin = join(root, "losing-bin");
    mkdirSync(winningBin);
    mkdirSync(losingBin);
    linkSync(process.execPath, join(winningBin, "env-case-probe.exe"));

    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => {
        const uppercaseKey = key.toUpperCase();
        return uppercaseKey !== "PATH" && uppercaseKey !== "PATHEXT";
      }),
    );

    // Node sorts Windows environment keys lexicographically, then keeps the
    // first spelling of each case-insensitive key. "PATH" therefore wins over
    // the earlier-inserted "Path" for both lookup and the child's environment.
    env.Path = losingBin;
    env.PATH = winningBin;
    env.PATHEXT = ".EXE";

    const childSource = [
      'const pathKeys = Object.keys(process.env).filter(key => key.toUpperCase() === "PATH");',
      "process.stdout.write(JSON.stringify({ pathKeys, path: process.env.PATH, mixed: process.env.Path }));",
    ].join("");
    const result = spawnSync("env-case-probe", ["-e", childSource], {
      cwd: root,
      env,
      encoding: "utf8",
    });

    assert(result.status === 0, [
      `case-dedup child exited with ${result.status}`,
      result.error?.stack ?? result.error?.message ?? "",
      result.stderr ?? "",
    ].filter(Boolean).join("\n"));

    const observed = JSON.parse(result.stdout);
    assert(
      JSON.stringify(observed.pathKeys) === JSON.stringify(["PATH"]),
      `child received duplicate or incorrectly spelled PATH entries: ${JSON.stringify(observed.pathKeys)}`,
    );
    assert(observed.path === winningBin, `child PATH mismatch: ${JSON.stringify(observed.path)}`);
    assert(observed.mixed === winningBin, `case-insensitive child PATH lookup mismatch: ${JSON.stringify(observed.mixed)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("node child_process Windows env case dedup passed");
