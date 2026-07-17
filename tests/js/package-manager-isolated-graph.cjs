"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cottontail = path.resolve(process.argv[2] || "zig-out/bin/cottontail");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-isolated-"));
const junctionTarget = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-junction-target-"));

function writeJson(relative, value) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function runInstall() {
  return spawnSync(cottontail, ["install", "--ignore-scripts", "--silent"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function install() {
  const result = runInstall();
  assert.equal(result.status, 0, `install failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function storeEntries() {
  return fs.readdirSync(path.join(root, "node_modules", ".bun")).sort();
}

try {
  fs.writeFileSync(
    path.join(root, "bunfig.toml"),
    '[install]\nlinker = "isolated"\npublicHoistPattern = [\n  "transitive-*",\n  "@scope/*",\n]\nhoistPattern = ["provider", "hidden-alias"]\n',
  );
  writeJson("packages/provider-one/package.json", {
    name: "provider",
    version: "1.0.0",
  });
  writeJson("packages/provider-two/package.json", {
    name: "provider",
    version: "2.0.0",
  });
  writeJson("packages/consumer/package.json", {
    name: "consumer",
    version: "1.0.0",
    peerDependencies: {
      provider: "^1.0.0",
    },
    devDependencies: {
      provider: "file:../provider-two",
    },
  });
  writeJson("packages/deep-leaf/package.json", {
    name: "deep-leaf",
    version: "1.0.0",
    peerDependencies: {
      provider: "^1.0.0",
    },
  });
  writeJson("packages/deep-middle/package.json", {
    name: "deep-middle",
    version: "1.0.0",
    bin: {
      "deep-middle": "cli.js",
    },
    dependencies: {
      "deep-leaf": "file:../deep-leaf",
    },
  });
  fs.writeFileSync(path.join(root, "packages", "deep-middle", "cli.js"), "#!/usr/bin/env bun\n");
  writeJson("packages/transitive-tool/package.json", {
    name: "transitive-tool",
    version: "1.0.0",
  });
  writeJson("packages/aliased-target/package.json", {
    name: "aliased-target",
    version: "1.0.0",
  });
  writeJson("packages/scoped-tool/package.json", {
    name: "@scope/tool",
    version: "1.0.0",
  });
  writeJson("packages/optional-consumer/package.json", {
    name: "optional-consumer",
    version: "1.0.0",
    peerDependencies: {
      "missing-optional": "*",
    },
    peerDependenciesMeta: {
      "missing-optional": {
        optional: true,
      },
    },
  });
  writeJson("packages/parent/package.json", {
    name: "parent",
    version: "1.0.0",
    dependencies: {
      "@scope/tool": "file:../scoped-tool",
      "hidden-alias": "file:../aliased-target",
      "transitive-tool": "file:../transitive-tool",
    },
  });
  writeJson("packages/context-one/package.json", {
    name: "context-one",
    version: "1.0.0",
    dependencies: {
      "deep-middle": "file:../deep-middle",
      consumer: "file:../consumer",
      provider: "file:../provider-one",
    },
  });
  writeJson("packages/context-two/package.json", {
    name: "context-two",
    version: "1.0.0",
    dependencies: {
      "deep-middle": "file:../deep-middle",
      consumer: "file:../consumer",
      provider: "file:../provider-two",
    },
  });
  writeJson("package.json", {
    name: "isolated-root",
    version: "1.0.0",
    dependencies: {
      "context-one": "file:./packages/context-one",
      "context-two": "file:./packages/context-two",
      "optional-consumer": "file:./packages/optional-consumer",
      parent: "file:./packages/parent",
    },
  });

  install();

  const firstEntries = storeEntries();
  const consumerEntries = firstEntries.filter(name => /^consumer@file\+packages\+consumer\+[0-9a-f]+$/.test(name));
  const middleEntries = firstEntries.filter(name => /^deep-middle@file\+packages\+deep-middle\+[0-9a-f]+$/.test(name));
  const leafEntries = firstEntries.filter(name => /^deep-leaf@file\+packages\+deep-leaf\+[0-9a-f]+$/.test(name));
  assert.equal(consumerEntries.length, 2, `expected two peer contexts: ${firstEntries.join(", ")}`);
  assert.equal(middleEntries.length, 2, `expected transitive middle contexts: ${firstEntries.join(", ")}`);
  assert.equal(leafEntries.length, 2, `expected transitive leaf contexts: ${firstEntries.join(", ")}`);
  assert.ok(firstEntries.includes("provider@file+packages+provider-one"));
  assert.ok(firstEntries.includes("provider@file+packages+provider-two"));
  assert.ok(firstEntries.includes("context-one@file+packages+context-one"));
  assert.ok(firstEntries.includes("context-two@file+packages+context-two"));
  assert.ok(firstEntries.includes("parent@file+packages+parent"));
  assert.ok(firstEntries.includes("aliased-target@file+packages+aliased-target"));
  assert.ok(firstEntries.includes("@scope+tool@file+packages+scoped-tool"));
  assert.ok(firstEntries.includes("optional-consumer@file+packages+optional-consumer"));
  assert.equal(firstEntries.some(name => name.startsWith("optional-consumer@file+packages+optional-consumer+")), false);
  assert.ok(firstEntries.includes("transitive-tool@file+packages+transitive-tool"));
  assert.ok(fs.lstatSync(path.join(root, "node_modules", "context-one")).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(root, "node_modules", "context-two")).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(root, "node_modules", "transitive-tool")).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(root, "node_modules", "@scope", "tool")).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(path.join(root, "node_modules", ".bun", "node_modules")).sort(), [
    "hidden-alias",
    "provider",
  ]);
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(fs.realpathSync(path.join(root, "node_modules", ".bun", "node_modules", "hidden-alias")), "package.json"),
        "utf8",
      ),
    ).name,
    "aliased-target",
  );

  const peerVersions = new Map();
  for (const consumerEntry of consumerEntries) {
    const consumerPeer = path.join(root, "node_modules", ".bun", consumerEntry, "node_modules", "provider");
    assert.ok(fs.lstatSync(consumerPeer).isSymbolicLink());
    const peerPackage = JSON.parse(fs.readFileSync(path.join(fs.realpathSync(consumerPeer), "package.json"), "utf8"));
    peerVersions.set(peerPackage.version, consumerEntry);
  }
  assert.deepEqual([...peerVersions.keys()].sort(), ["1.0.0", "2.0.0"]);
  const retainedConsumerEntry = peerVersions.get("1.0.0");

  const deepPeerVersions = new Map();
  for (const middleEntry of middleEntries) {
    const middleModules = path.join(root, "node_modules", ".bun", middleEntry, "node_modules");
    const leafPackageDir = fs.realpathSync(path.join(middleModules, "deep-leaf"));
    const leafModules = path.dirname(leafPackageDir);
    const providerPackage = JSON.parse(
      fs.readFileSync(path.join(fs.realpathSync(path.join(leafModules, "provider")), "package.json"), "utf8"),
    );
    deepPeerVersions.set(providerPackage.version, {
      leafEntry: path.basename(path.dirname(leafModules)),
      middleEntry,
    });
  }
  assert.deepEqual([...deepPeerVersions.keys()].sort(), ["1.0.0", "2.0.0"]);
  const retainedDeep = deepPeerVersions.get("1.0.0");
  for (const [contextName, providerVersion] of [
    ["context-one", "1.0.0"],
    ["context-two", "2.0.0"],
  ]) {
    const contextModules = path.dirname(fs.realpathSync(path.join(root, "node_modules", contextName)));
    const bin = path.join(contextModules, ".bin", process.platform === "win32" ? "deep-middle.cmd" : "deep-middle");
    assert.ok(fs.existsSync(bin), `missing reconciled bin for ${contextName}`);
    const expectedEntry = deepPeerVersions.get(providerVersion).middleEntry;
    if (process.platform === "win32") {
      assert.match(fs.readFileSync(bin, "utf8"), new RegExp(expectedEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } else {
      assert.ok(fs.realpathSync(bin).includes(`${path.sep}${expectedEntry}${path.sep}`));
    }
  }

  fs.writeFileSync(path.join(root, "bunfig.toml"), '[install]\nlinker = "isolated"\nhoistPattern = ["provider"]\n');
  fs.writeFileSync(path.join(root, ".npmrc"), "public-hoist-pattern=transitive-*\n");
  writeJson("package.json", {
    name: "isolated-root",
    version: "1.0.0",
    dependencies: {
      "context-one": "file:./packages/context-one",
    },
  });
  install();

  const secondEntries = storeEntries();
  assert.deepEqual(
    secondEntries,
    [
      "context-one@file+packages+context-one",
      retainedConsumerEntry,
      retainedDeep.leafEntry,
      retainedDeep.middleEntry,
      "node_modules",
      "provider@file+packages+provider-one",
    ].sort(),
  );
  assert.equal(fs.existsSync(path.join(root, "node_modules", "context-two")), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules", "parent")), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules", "transitive-tool")), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules", "@scope")), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules", ".bun", "node_modules", "hidden-alias")), false);

  fs.writeFileSync(path.join(junctionTarget, "sentinel.txt"), "preserve me\n");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(junctionTarget, path.join(root, "node_modules", "stale-directory-link"), linkType);
  fs.mkdirSync(path.join(root, "node_modules", "@stale"), { recursive: true });
  fs.symlinkSync(junctionTarget, path.join(root, "node_modules", "@stale", "package"), linkType);
  fs.symlinkSync(junctionTarget, path.join(root, "node_modules", ".bun", "stale-store-link"), linkType);
  const staleBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "stale-bin.cmd" : "stale-bin");
  fs.mkdirSync(path.dirname(staleBin), { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(staleBin, "@exit /b 0\r\n");
  } else {
    fs.symlinkSync(path.join(junctionTarget, "sentinel.txt"), staleBin);
  }

  install();
  assert.deepEqual(storeEntries(), secondEntries, "an unchanged reinstall must preserve canonical store identity");
  assert.equal(fs.existsSync(path.join(root, "node_modules", "stale-directory-link")), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules", "@stale")), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules", ".bun", "stale-store-link")), false);
  assert.equal(fs.existsSync(staleBin), false);
  assert.equal(fs.readFileSync(path.join(junctionTarget, "sentinel.txt"), "utf8"), "preserve me\n");
  const retainedPeer = path.join(root, "node_modules", ".bun", retainedConsumerEntry, "node_modules", "provider");
  assert.equal(JSON.parse(fs.readFileSync(path.join(fs.realpathSync(retainedPeer), "package.json"), "utf8")).version, "1.0.0");

  fs.writeFileSync(path.join(root, "bunfig.toml"), '[install]\nlinker = "isolated"\npublicHoistPattern = 123\n');
  let invalid = runInstall();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Expected a string or an array of strings/);

  fs.writeFileSync(path.join(root, "bunfig.toml"), '[install]\nlinker = "isolated"\npublicHoistPattern = ["*", true]\n');
  invalid = runInstall();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Expected a string/);

  console.log("package-manager isolated graph: pass");
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  fs.rmSync(junctionTarget, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
