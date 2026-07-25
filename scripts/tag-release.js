#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  compareReleaseVersions,
  parseReleaseVersion,
  suggestReleaseVersion,
} from "./release-version.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJsonPath = join(rootDir, "package.json");
const versionZigPath = join(rootDir, "src", "version.zig");
const dashConfigPath = join(rootDir, "dash.config.ts");

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

function updateDashPin(path, field, version) {
  const source = readFileSync(path, "utf8");
  const pattern = new RegExp(`^(// @dash .*\\b${field}=)[^\\s]+`, "m");
  const updated = source.replace(pattern, (_, prefix) => `${prefix}${version}`);
  if (updated === source) fail(`could not update ${field} in ${path}`);
  writeFileSync(path, updated);
}

if (process.argv.includes("--help")) {
  console.log("Usage: node scripts/tag-release.js [canary|stable]");
  console.log("Prompt for a semantic version, then commit, tag, and atomically push it.");
  process.exit(0);
}

const mode = process.argv[2] ?? "manual";
if (!["canary", "stable", "manual"].includes(mode)) {
  fail(`expected canary or stable, received ${JSON.stringify(mode)}`);
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
  .filter(Boolean)
  .map((tag) => ({ tag, version: parseReleaseVersion(tag.replace(/^v/, "")) }))
  .filter((entry) => entry.version)
  .sort((left, right) => compareReleaseVersions(right.version, left.version));
const latest = versions[0] ?? null;
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const current = parseReleaseVersion(packageJson.version);
if (!current) fail(`package.json contains an invalid version: ${packageJson.version}`);
const suggested = suggestReleaseVersion(
  mode,
  current.version,
  latest?.version.version,
);

console.log(`Latest tag:      ${latest?.tag ?? "(none)"}`);
console.log(`Package version: v${packageJson.version}`);
if (ahead > 0) console.log(`Local main:      ${ahead} unpushed commit(s) ahead of origin/main`);

const prompt = createInterface({ input: process.stdin, output: process.stdout });
const label = mode === "manual" ? "release" : mode;
const response = await prompt.question(`New ${label} semantic version [${suggested}]: `);
const answer = (response.trim() || suggested).replace(/^v/, "");
const next = parseReleaseVersion(answer);
if (!next) {
  prompt.close();
  fail(`"${answer}" is not a valid semantic version`);
}
if (latest && compareReleaseVersions(next, latest.version) <= 0) {
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
updateDashPin(dashConfigPath, "cottontail", answer);

const tag = `v${answer}`;
git(["add", "package.json", "src/version.zig", "dash.config.ts"], { inherit: true });
git(["commit", "-m", tag], { inherit: true });
git(["tag", "--annotate", tag, "--message", tag], { inherit: true });
git(["push", "--atomic", "origin", "HEAD:main", `refs/tags/${tag}`], { inherit: true });

console.log(`Published ${tag}. GitHub Actions will build and publish its platform matrix.`);
