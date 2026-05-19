#!/usr/bin/env node

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const type = process.argv[2];

if (!type || !["beta", "patch", "minor", "major", "stable"].includes(type)) {
	console.error(
		"Usage: bun scripts/push-version.js <beta|patch|minor|major|stable>",
	);
	process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const packageJsonPath = join(repoRoot, "package.json");
const mainZigPath = join(repoRoot, "src", "main.zig");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const currentVersion = packageJson.version;

const versionCmd = {
	beta: "prerelease --preid=beta",
	patch: "prepatch --preid=beta",
	minor: "preminor --preid=beta",
	major: "premajor --preid=beta",
	stable: "patch",
}[type];

console.log(`Current version: ${currentVersion}`);
console.log(`Running: npm version ${versionCmd}`);

execSync(`npm version ${versionCmd} --no-git-tag-version`, {
	cwd: repoRoot,
	stdio: "inherit",
});

const updatedPackageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const newVersion = updatedPackageJson.version;
const tagName = `v${newVersion}`;

console.log(`New version: ${newVersion}`);

let mainZig = readFileSync(mainZigPath, "utf-8");
mainZig = mainZig.replace(
	/const version = ".*";/,
	`const version = "${newVersion}";`,
);
writeFileSync(mainZigPath, mainZig);
console.log(`Updated src/main.zig version to ${newVersion}`);

console.log(`Creating commit and tag: ${tagName}`);

execSync(`git add package.json src/main.zig`, {
	cwd: repoRoot,
	stdio: "inherit",
});
execSync(`git commit -m "${tagName}"`, { cwd: repoRoot, stdio: "inherit" });
execSync(`git tag ${tagName}`, { cwd: repoRoot, stdio: "inherit" });

console.log("Pushing to origin...");
execSync(`git push origin main --tags`, { cwd: repoRoot, stdio: "inherit" });

console.log(`\n✓ Successfully pushed ${tagName}`);
