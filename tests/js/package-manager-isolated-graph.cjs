"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cottontail = path.resolve(process.argv[2] || "zig-out/bin/cottontail");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-isolated-"));

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
      provider: "*",
    },
    devDependencies: {
      provider: "file:../provider-two",
    },
  });
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
      consumer: "file:../consumer",
      provider: "file:../provider-one",
    },
  });
  writeJson("packages/context-two/package.json", {
    name: "context-two",
    version: "1.0.0",
    dependencies: {
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
  assert.equal(consumerEntries.length, 2, `expected two peer contexts: ${firstEntries.join(", ")}`);
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
      "node_modules",
      "provider@file+packages+provider-one",
    ].sort(),
  );
  assert.equal(fs.existsSync(path.join(root, "node_modules", "context-two")), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules", "parent")), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules", "transitive-tool")), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules", "@scope")), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules", ".bun", "node_modules", "hidden-alias")), false);

  install();
  assert.deepEqual(storeEntries(), secondEntries, "an unchanged reinstall must preserve canonical store identity");
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
  fs.rmSync(root, { recursive: true, force: true });
}
