#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJsonPath = join(rootDir, "package.json");
const versionZigPath = join(rootDir, "src", "version.zig");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function fail(message) {
  console.error(`cottontail release: ${message}`);
  process.exit(1);
}

function git(args, options = {}) {
  const output = execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function parseSemver(value) {
  const match = value.match(semverPattern);
  if (!match) return null;
  return {
    raw: value,
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left.localeCompare(right);
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1;
  if (right.prerelease.length === 0 && left.prerelease.length > 0) return -1;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const comparison = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

if (process.argv.includes("--help")) {
  console.log("Usage: bun run release");
  console.log("Fetch tags, prompt for a new semantic version, then commit, tag, and push it.");
  process.exit(0);
}

if (git(["branch", "--show-current"]) !== "main") {
  fail("releases must be created from the main branch");
}
if (git(["status", "--porcelain"])) {
  fail("the working tree must be clean before creating a release");
}

console.log("Fetching origin/main and release tags...");
git(["fetch", "origin", "main", "--tags", "--prune"], { inherit: true });

const [aheadText, behindText] = git(["rev-list", "--left-right", "--count", "HEAD...origin/main"]).split(/\s+/);
const ahead = Number(aheadText);
const behind = Number(behindText);
if (behind > 0) fail(`main is ${behind} commit(s) behind origin/main; pull or rebase first`);

const versions = git(["tag", "--list", "v*"])
  .split("\n")
  .map((tag) => ({ tag, version: parseSemver(tag.replace(/^v/, "")) }))
  .filter((entry) => entry.version)
  .sort((left, right) => compareSemver(right.version, left.version));
const latest = versions[0] ?? null;
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

console.log(`Latest tag:      ${latest?.tag ?? "(none)"}`);
console.log(`Package version: v${packageJson.version}`);
if (ahead > 0) console.log(`Local main:      ${ahead} unpushed commit(s) ahead of origin/main`);

const prompt = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await prompt.question("New semantic version: ")).trim().replace(/^v/, "");
const next = parseSemver(answer);
if (!next) {
  prompt.close();
  fail(`"${answer}" is not a valid semantic version`);
}
if (latest && compareSemver(next, latest.version) <= 0) {
  prompt.close();
  fail(`v${answer} must be newer than ${latest.tag}`);
}
if (versions.some((entry) => entry.tag === `v${answer}`)) {
  prompt.close();
  fail(`tag v${answer} already exists`);
}

const confirmation = (await prompt.question(`Create and push release v${answer}? [y/N] `)).trim().toLowerCase();
prompt.close();
if (confirmation !== "y" && confirmation !== "yes") {
  console.log("Release cancelled; no files were changed.");
  process.exit(0);
}

packageJson.version = answer;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

const versionZig = readFileSync(versionZigPath, "utf8");
const updatedVersionZig = versionZig.replace(
  /pub const version = "[^"]+";/,
  `pub const version = "${answer}";`,
);
if (updatedVersionZig === versionZig) fail("could not update src/version.zig");
writeFileSync(versionZigPath, updatedVersionZig);

const tag = `v${answer}`;
git(["add", "package.json", "src/version.zig"], { inherit: true });
git(["commit", "-m", tag], { inherit: true });
git(["tag", "--annotate", tag, "--message", tag], { inherit: true });
git(["push", "--atomic", "origin", "HEAD:main", `refs/tags/${tag}`], { inherit: true });

console.log(`Published ${tag}. CircleCI will build and publish its platform matrix.`);
