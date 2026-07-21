import {
  hostedGitInfo,
  isArchitectureMatch,
  isOperatingSystemMatch,
} from "bun:internal-for-testing";

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

console.log("bun package manager internals passed");
