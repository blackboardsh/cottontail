function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(Bun.semver.order("1.0.0", "2.0.0") === -1, "basic semver order failed");
assert(Bun.semver.order("1.0.0-beta.11", "1.0.0-beta.2") === 1, "prerelease order failed");
assert(Bun.semver.order("v1.2.x", "1.2.0") === 1, "loose wildcard order failed");
assert(Bun.semver.satisfies("1.5.0", "^1.2.3"), "caret range failed");
assert(Bun.semver.satisfies("1.5.0", "1.2.3 - 2.0.0"), "hyphen range failed");
assert(!Bun.semver.satisfies("1.5.0-beta.1", "^1.2.3"), "prerelease exclusion failed");
assert(Bun.semver.satisfies(Buffer.from("2.1.0"), Buffer.from(">=2 <3")), "Buffer input failed");

for (const call of [
  () => Bun.semver.order("1.0.0"),
  () => Bun.semver.satisfies("1.0.0"),
  () => Bun.semver.order(Symbol("version"), "1.0.0"),
]) {
  let threw = false;
  try {
    call();
  } catch (error) {
    threw = error instanceof TypeError;
  }
  assert(threw, "invalid semver call should throw TypeError");
}

console.log("bun semver passed");
