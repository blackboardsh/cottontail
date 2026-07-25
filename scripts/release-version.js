const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseReleaseVersion(value) {
  if (typeof value !== "string") return null;
  const match = value.match(semverPattern);
  if (!match) return null;
  return {
    version: value,
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left.localeCompare(right);
}

export function compareReleaseVersions(left, right) {
  const leftVersion = typeof left === "string" ? parseReleaseVersion(left) : left;
  const rightVersion = typeof right === "string" ? parseReleaseVersion(right) : right;
  if (!leftVersion || !rightVersion) {
    throw new Error("Cannot compare invalid semantic versions");
  }

  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] - rightVersion.core[index];
    }
  }
  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1;
  if (rightVersion.prerelease.length === 0 && leftVersion.prerelease.length > 0) return -1;
  for (
    let index = 0;
    index < Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
    index += 1
  ) {
    if (leftVersion.prerelease[index] === undefined) return -1;
    if (rightVersion.prerelease[index] === undefined) return 1;
    const comparison = compareIdentifier(
      leftVersion.prerelease[index],
      rightVersion.prerelease[index],
    );
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export function releaseTargetForVersion(value) {
  const version = typeof value === "string" ? parseReleaseVersion(value) : value;
  if (!version) throw new Error("Cannot classify an invalid semantic version");
  return version.prerelease.length === 0 ? "production" : "canary";
}

export function isReleaseVersionForMode(mode, value) {
  if (mode === "manual") return true;
  return releaseTargetForVersion(value) === mode;
}

function formatCore(core) {
  return core.join(".");
}

function nextMinor(version, suffix = "") {
  return `${version.core[0]}.${version.core[1] + 1}.0${suffix}`;
}

export function suggestReleaseVersion(mode, currentValue, latestValue = null) {
  if (!["canary", "production", "manual"].includes(mode)) {
    throw new Error(`Unsupported release mode: ${mode}`);
  }
  const current = parseReleaseVersion(currentValue);
  const latest = latestValue ? parseReleaseVersion(latestValue) : null;
  if (!current || (latestValue && !latest)) {
    throw new Error("Cannot suggest a release from an invalid semantic version");
  }
  const base = latest && compareReleaseVersions(latest, current) > 0 ? latest : current;

  if (mode === "manual") return nextMinor(base);
  if (mode === "production") {
    return base.prerelease.length > 0 ? formatCore(base.core) : nextMinor(base);
  }

  let candidate;
  if (
    base.prerelease.length === 2 &&
    base.prerelease[0] === "canary" &&
    /^(0|[1-9]\d*)$/.test(base.prerelease[1])
  ) {
    candidate = `${formatCore(base.core)}-canary.${Number(base.prerelease[1]) + 1}`;
  } else {
    candidate = `${formatCore(base.core)}-canary.1`;
  }
  return compareReleaseVersions(candidate, base) > 0
    ? candidate
    : nextMinor(base, "-canary.1");
}
