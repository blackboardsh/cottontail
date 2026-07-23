#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const jscRoot = resolve(process.env.JSC_ROOT || join(root, "..", "jsc"));
const nodeBinary = process.env.NODE_BINARY || "node";

function fail(message) {
	throw new Error(`[local-cottontail] ${message}`);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd || root,
		env: options.env || process.env,
		encoding: options.capture ? "utf8" : undefined,
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error) fail(`could not start ${command}: ${result.error.message}`);
	if (result.status !== 0) {
		const detail = options.capture
			? `\n${String(result.stderr || result.stdout || "").trim()}`
			: "";
		fail(`${command} exited with status ${result.status ?? 1}${detail}`);
	}
	return options.capture ? String(result.stdout).trim() : "";
}

function hostPaths() {
	const key = `${process.platform}-${process.arch}`;
	const configs = {
		"darwin-arm64": {
			platform: "macos-arm64",
			artifact: "cottontail-jsc-macos-arm64.tar.gz",
			data: "icudt70l-macos-arm64.dat",
			binary: "cottontail",
		},
		"linux-x64": {
			platform: "linux-x64",
			artifact: "cottontail-jsc-linux-amd64.tar.gz",
			data: "icudt70l-linux-x64.dat",
			binary: "cottontail",
		},
		"linux-arm64": {
			platform: "linux-arm64",
			artifact: "cottontail-jsc-linux-arm64.tar.gz",
			data: "icudt70l-linux-arm64.dat",
			binary: "cottontail",
		},
		"win32-x64": {
			platform: "windows-x64",
			artifact: "cottontail-jsc-windows-amd64.tar.gz",
			data: "icudt70l-windows-x64.dat",
			binary: "cottontail.exe",
		},
	};
	const config = configs[key];
	if (!config) return null;
	return {
		...config,
		archivePath: join(jscRoot, "release", config.artifact),
		dataPath: join(jscRoot, "release", config.data),
		binaryPath: join(root, "zig-out", "bin", config.binary),
	};
}

function hashFile(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function addRepositoryPaths(hash, repository, pathspecs) {
	const tracked = run("git", ["ls-files", "-z", "--", ...pathspecs], {
		cwd: repository,
		capture: true,
	});
	const untracked = run(
		"git",
		["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs],
		{ cwd: repository, capture: true },
	);
	const paths = new Set(
		`${tracked}\0${untracked}`.split("\0").filter(Boolean),
	);
	for (const relativePath of [...paths].sort()) {
		const path = join(repository, relativePath);
		hash.update(relativePath);
		hash.update("\0");
		if (!existsSync(path) || !statSync(path).isFile()) {
			hash.update("missing");
		} else {
			hash.update(readFileSync(path));
		}
		hash.update("\0");
	}
}

function fingerprint(paths) {
	const hash = createHash("sha256");
	hash.update(`cottontail-local-build-v1\0${paths.platform}\0`);
	hash.update(hashFile(paths.archivePath));
	hash.update("\0");
	if (existsSync(paths.dataPath)) hash.update(hashFile(paths.dataPath));
	hash.update("\0");
	addRepositoryPaths(hash, root, [
		"build.zig",
		"package.json",
		"packages",
		"src",
		"scripts/build-local.js",
		"scripts/build-release.js",
		"scripts/embed-runtime-modules.js",
		"scripts/jsc-manifest.json",
		"scripts/setup.js",
		"scripts/setup-jsc.js",
		"scripts/setup-zig-html-rewriter.js",
		"scripts/zig-html-rewriter-manifest.json",
		"scripts/zig-manifest.json",
		"scripts/zig.js",
	]);
	return hash.digest("hex");
}

function stateIsCurrent(statePath, expectedFingerprint, binaryPath) {
	if (!existsSync(statePath) || !existsSync(binaryPath)) return false;
	try {
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		return state.schema === 1 && state.fingerprint === expectedFingerprint;
	} catch {
		return false;
	}
}

function main() {
	const paths = hostPaths();
	if (!paths) fail(`unsupported host ${process.platform}-${process.arch}`);
	const jscBuildScript = join(jscRoot, "scripts", "build-local-jsc.js");
	if (!process.argv.includes("--no-deps")) {
		if (!existsSync(jscBuildScript)) {
			fail(`local JSC checkout is missing: ${jscRoot}`);
		}
		const jscArgs = [jscBuildScript];
		if (
			process.argv.includes("--force") ||
			["1", "true", "yes"].includes(
				String(process.env.DASH_LOCAL_REBUILD_JSC || "").toLowerCase(),
			)
		) {
			jscArgs.push("--force");
		}
		run(nodeBinary, jscArgs, {
			cwd: jscRoot,
			env: {
				...process.env,
				COTTONTAIL_ROOT: root,
			},
		});
	}
	if (!existsSync(paths.archivePath)) {
		fail(
			`local JSC SDK is missing: ${paths.archivePath}\n` +
				`Run "node scripts/build-local-jsc.js" in ${jscRoot} first.`,
		);
	}

	const statePath = join(root, "zig-out", "local-build.json");
	const expectedFingerprint = fingerprint(paths);
	const force =
		process.argv.includes("--force") ||
		["1", "true", "yes"].includes(
			String(process.env.DASH_LOCAL_REBUILD_COTTONTAIL || "").toLowerCase(),
		);
	if (
		!force &&
		stateIsCurrent(statePath, expectedFingerprint, paths.binaryPath)
	) {
		console.log(`[local-cottontail] Using cached ${paths.binaryPath}`);
		console.log(
			JSON.stringify({
				binaryPath: paths.binaryPath,
				fingerprint: expectedFingerprint,
			}),
		);
		return;
	}

	const env = {
		...process.env,
		COTTONTAIL_JSC_ARCHIVE: paths.archivePath,
		...(existsSync(paths.dataPath)
			? { COTTONTAIL_JSC_ICU_DATA: paths.dataPath }
			: {}),
	};
	console.log(`[local-cottontail] Building against ${paths.archivePath}`);
	run(nodeBinary, [join(root, "scripts", "setup.js")], { env });
	run(nodeBinary, [join(root, "scripts", "setup-zig-html-rewriter.js")], {
		env,
	});
	run(nodeBinary, [join(root, "scripts", "setup-jsc.js")], { env });
	run(nodeBinary, [join(root, "scripts", "build-release.js")], { env });

	const completedFingerprint = fingerprint(paths);
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(
		statePath,
		`${JSON.stringify(
			{
				schema: 1,
				platform: paths.platform,
				fingerprint: completedFingerprint,
				jscArchive: paths.archivePath,
				binaryPath: paths.binaryPath,
				builtAt: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
	);
	console.log(
		JSON.stringify({
			binaryPath: paths.binaryPath,
			fingerprint: completedFingerprint,
		}),
	);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
