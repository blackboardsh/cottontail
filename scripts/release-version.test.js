import assert from "node:assert/strict";
import test from "node:test";

import {
  compareReleaseVersions,
  suggestReleaseVersion,
} from "./release-version.js";

test("canary releases increment or introduce the canary number", () => {
  assert.equal(suggestReleaseVersion("canary", "1.2.3-canary.4"), "1.2.3-canary.5");
  assert.equal(suggestReleaseVersion("canary", "1.2.3-beta.2"), "1.2.3-canary.1");
  assert.equal(suggestReleaseVersion("canary", "1.2.3"), "1.3.0-canary.1");
  assert.equal(suggestReleaseVersion("canary", "1.2.3-rc.1"), "1.3.0-canary.1");
});

test("stable releases remove prerelease suffixes or advance the minor", () => {
  assert.equal(suggestReleaseVersion("stable", "1.2.3-canary.4"), "1.2.3");
  assert.equal(suggestReleaseVersion("stable", "1.2.3"), "1.3.0");
  assert.equal(suggestReleaseVersion("manual", "1.2.3"), "1.3.0");
});

test("suggestions account for a newer existing tag", () => {
  assert.equal(
    suggestReleaseVersion("canary", "1.2.3-canary.2", "1.2.3-canary.7"),
    "1.2.3-canary.8",
  );
  assert(compareReleaseVersions("1.2.3", "1.2.3-canary.9") > 0);
});
