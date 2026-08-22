# Cottontail

Cottontail is a small Zig-based JavaScript and TypeScript runtime built for
[Electrobun](https://github.com/blackboardsh/electrobun). It uses
JavaScriptCore and implements the Node and Bun APIs that application workloads
need.

## Responsibilities

Cottontail runs scripts, resolves installed modules, provides runtime APIs,
drains async work, runs tests, and exposes the compiler entry point used by
Hutch.

[Hutch](https://github.com/blackboardsh/hutch) owns project scripts,
dependencies, toolchains, version selection, and Electrobun orchestration.
Cottontail does not mutate application projects or act as their package
manager.

## Build

A fresh checkout requires Node.js 24. The setup scripts download the pinned Zig,
JavaScriptCore, and zig-html-rewriter artifacts and verify their checksums.

```sh
node scripts/setup.js
node scripts/setup-zig-html-rewriter.js
node scripts/setup-jsc.js
node scripts/zig.js build
```

The binary is written to `zig-out/bin/cottontail`.

After the first build, Cottontail can drive the repository scripts itself:

```sh
./zig-out/bin/cottontail scripts/repo.js build
./zig-out/bin/cottontail scripts/repo.js test
./zig-out/bin/cottontail scripts/repo.js bench
./zig-out/bin/cottontail scripts/repo.js run test.js
```

## Test

```sh
# Zig and JavaScript runtime suites
bun run test

# Runtime plus Electrobun bridge and CLI suites
bun run test:blocking

# Imported Node and Bun compatibility suites
bun run compat:upstream
```

See [cross-platform compatibility](docs/cross-platform-compatibility.md) for
the current platform matrix and known gaps.

## Local Electrobun development

With a sibling Electrobun checkout built at `../electrobun/package/dist`:

```sh
bun run test:electrobun
bun run test:electrobun:cli
bun run electrobun:window
```

The direct bridge is for local integration work. Production Electrobun builds
select and package Cottontail through the versioned Electrobun devkit.

Prebuilt releases support macOS arm64, Linux x64 and arm64, and Windows x64.
See [cross-platform bring-up](docs/cross-platform-bringup.md) for native build
diagnostics.
