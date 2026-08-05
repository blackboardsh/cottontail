import {
  hostedGitInfo,
  install_test_helpers,
  isArchitectureMatch,
  isOperatingSystemMatch,
} from "bun:internal-for-testing";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(isArchitectureMatch(["any"]), "architecture wildcard did not match");
assert(isArchitectureMatch(["unknown", process.arch]), "architecture inclusion did not match");
assert(!isArchitectureMatch([`!${process.arch}`]), "architecture exclusion did not apply");
assert(isOperatingSystemMatch(["any"]), "operating-system wildcard did not match");
assert(!isOperatingSystemMatch([`!${process.platform}`]), "operating-system exclusion did not apply");

assert(hostedGitInfo.parseUrl("git@github.com:cottontail/runtime.git") !== null, "scp URL did not parse");
const shortcut = hostedGitInfo.fromUrl("github:cottontail/runtime.git#preview");
assert(shortcut?.type === "github", "shortcut provider mismatch");
assert(shortcut?.user === "cottontail", "shortcut user mismatch");
assert(shortcut?.project === "runtime", "shortcut project mismatch");
assert(shortcut?.committish === "preview", "shortcut committish mismatch");

const complex = hostedGitInfo.fromUrl(
  "https://user@github.com/cottontail/runtime#feature/path@next:1",
);
assert(complex?.user === "cottontail", "authenticated URL user mismatch");
assert(complex?.project === "runtime", "authenticated URL project mismatch");
assert(complex?.committish === "feature/path@next:1", "complex fragment mismatch");

const lockfileDir = mkdtempSync(join(tmpdir(), "cottontail-lockfile-internals-"));
try {
  writeFileSync(join(lockfileDir, "bun.lock"), JSON.stringify({
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: {
      "": { name: "root" },
      "packages/a": {
        name: "pkg-a",
        version: "1.0.0",
        dependencies: { "pkg-b": "workspace:" },
      },
      "packages/b": { name: "pkg-b", version: "1.0.0" },
    },
    packages: {
      "pkg-a": ["pkg-a@workspace:packages/a"],
      "pkg-b": ["pkg-b@workspace:packages/b"],
    },
  }));
  const parsed = install_test_helpers.parseLockfile(lockfileDir);
  const workspaceDependency = parsed.dependencies.find(
    (dependency: any) => dependency.name === "pkg-b" && dependency.literal === "workspace:",
  );
  assert(workspaceDependency?.workspace === "", "bare workspace protocol suffix was not preserved");
} finally {
  rmSync(lockfileDir, { recursive: true, force: true });
}

console.log("bun package manager internals passed");
