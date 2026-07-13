# cottontail

`cottontail` is a tiny Zig-based JavaScript runtime for Electrobun workloads.

After a fresh clone, Bun is still the bootstrap path until `cottontail` is published or otherwise available on the machine. Once you have built the local binary once, you can use `cottontail` itself to drive the repo workflow.

This repo currently focuses on developer experience:

- Bun drives the local workflow.
- Zig is vendored locally into `vendors/zig`.
- The pinned Zig version is `0.16.0`.
- JavaScriptCore is the only JavaScript engine backend.
- `cottontail` can execute a JavaScript file and exposes a minimal `console.log` / `console.error` host.
- `cottontail.nanotime()` returns a monotonic nanosecond timestamp as a JavaScript `BigInt`.
- Zig owns script loading and runtime flow; the C layer is kept to a JavaScriptCore bridge.
- The current runtime supports ESM entrypoints/imports, async job draining, and a minimal `cottontail` host API.

## JavaScriptCore policy

Cottontail treats JavaScriptCore as an engine, not as the implementation layer
for Bun or Node compatibility. Runtime APIs and compatibility behavior belong in
Cottontail's Zig, C bridge, and JavaScript modules rather than in private JSC
patches.

Cottontail links a Cottontail-owned static JSC build (JSCOnly, published at
[`blackboardsh/jsc`](https://github.com/blackboardsh/jsc)). This vendored build
is the build: the earlier macOS system-framework path has been removed. `bun run
setup` downloads the release pinned in `scripts/jsc-manifest.json` into the
gitignored `vendors/jsc/` directory (with sha256 verification), and the regular
`node scripts/zig.js build` links the vendored static libraries. Cross-platform
distribution uses these Cottontail-owned builds. The pinned release ships
macOS arm64, Linux x64/arm64, and Windows arm64 archives. Cottontail's release
matrix uses the first three directly; Windows x64 is checksum-gated on an x64
JSC archive until that target is added to the pinned release. The only intended
Cottontail-specific WebKit change is
Electrobun's support for packaging ICU data separately from the engine. Keeping
that boundary allows a future Electrobun packaging step to include only the ICU
data an application requests, without changing JavaScriptCore behavior or its
public API.

Known engine difference: ShadowRealm stays disabled because the JSCOnly port
cannot construct ShadowRealms from C-API-created contexts (the constructor
segfaults), so Cottontail keeps the option off and the constructor absent.

Bun-specific JSC patches, including test clocks and private runtime hooks, are
not compatibility dependencies. Tests that rely on them should be adapted to
exercise Cottontail's public behavior, and required host functionality should be
exposed by Cottontail itself.

## Scripts

- `bun run setup` downloads the pinned Zig toolchain and the pinned JavaScriptCore build if needed.
- `bun run setup:jsc` vendors only the pinned JavaScriptCore build (see `scripts/jsc-manifest.json`).
- `bun run build` builds the debug executable.
- `bun run build:release` builds with `ReleaseSmall`.
- `bun run package:release` creates a platform archive and SHA-256 file under `release/`.
- `bun run run -- test.js` builds and runs a JavaScript file through `cottontail`.
- `bun run dev` vendors, builds, and runs the smoke test in `test.js`.
- `bun run bench` builds a release binary and runs dedicated startup / loop / JSON / async benchmarks.
- `bun run test:zig` runs the Zig unit tests.
- `bun run test:js` runs the JavaScript runtime behavior suite.
- `bun run test:electrobun` runs the local Electrobun bridge smoke test against a sibling `../electrobun/package/dist`.
- `bun run test:electrobun:cli` runs the new `cottontail electrobun` CLI fixture against a real `electrobun.config.ts`, TS entrypoints, and a TS `postBuild` hook.
- `bun run electrobun:window` opens a native window through the local Electrobun core.
- `bun run test` runs both the Zig and JavaScript tests.
- `bun run check-zig-version` prints the vendored Zig version through the local wrapper script.

## Release builds

CircleCI defines native release jobs for macOS arm64, Linux x64, Linux arm64,
and Windows x64 in `.circleci/config.yml`. Every job is configured to run Zig
tests, build with `ReleaseSmall`, smoke-test the binary, package the runtime
modules and platform esbuild binary, and store the archive plus its SHA-256
file. The Windows job remains a bring-up gate until the x64 JSC input and the
Win32 host implementation described below are complete.

The archive layout is stable for Dash CLI consumption:

- `bin/cottontail` (`bin/cottontail.exe` on Windows)
- `src/runtime_modules/`
- `vendors/esbuild/`
- `cottontail-release.json`

Windows x64 currently requires `COTTONTAIL_JSC_WINDOWS_X64_URL` and
`COTTONTAIL_JSC_WINDOWS_X64_SHA256` in the CircleCI project environment. The
URL must point to the same archive layout produced by `blackboardsh/jsc`. Once
that artifact is published with the pinned JSC release, it should be moved into
`scripts/jsc-manifest.json` and the temporary environment contract removed.
The current C host bridge also uses POSIX APIs directly for process, socket,
DNS, polling, mmap, user/group, and filesystem behavior; those paths still need
native Win32 implementations before the Windows job can pass.

## Bootstrap

After a fresh clone:

- `bun run build`

After the first local build, you can drive the repo with `cottontail` itself:

- `./zig-out/bin/cottontail scripts/repo.js build`
- `./zig-out/bin/cottontail scripts/repo.js test`
- `./zig-out/bin/cottontail scripts/repo.js bench`
- `./zig-out/bin/cottontail scripts/repo.js run test.js`

## Electrobun bridge

There is now a narrow Electrobun bridge mode for local architecture work:

- `./zig-out/bin/cottontail electrobun tests/js/electrobun-smoke.js`
- `./zig-out/bin/cottontail electrobun examples/electrobun-window.js`

This mode currently:

- stages `libElectrobunCore`, `libNativeWrapper`, and `libasar` beside the local `cottontail` executable
- looks for a sibling Electrobun checkout at `../electrobun/package/dist` by default
- exposes a tiny global `electrobun` object with `createWindow({...})` and `quit()`
- runs JavaScriptCore on a worker thread while the Electrobun native event loop owns the main thread

This is a bridge alpha, not Bun compatibility:

- it is meant to prove the runtime-to-core boundary
- it does not run Electrobun's existing Bun main-process bundle
- it does not yet expose webviews, events, or the broader Electrobun API surface

## Electrobun CLI

`cottontail` now has a first internal CLI/runtime split and a minimal Electrobun-oriented CLI surface:

- `./zig-out/bin/cottontail electrobun init hello-world --template=hello-world`
- `./zig-out/bin/cottontail electrobun config`
- `./zig-out/bin/cottontail electrobun build`
- `./zig-out/bin/cottontail electrobun run`
- `./zig-out/bin/cottontail electrobun dev`

This first cut:

- auto-vendors `esbuild` into `vendors/esbuild` on first use through `npm`
- transpiles and evaluates `electrobun.config.ts`
- transpiles TS lifecycle hooks like `postBuild.ts` and runs them under `cottontail`
- builds TypeScript/JavaScript entrypoints through an Electrobun-owned `build.main` contract backed by esbuild's JS API
- can scaffold projects from the Electrobun template directory
- can build and launch host-platform `mainProcess: "bun"` Electrobun app bundles from the checked-in `dist[-os-arch]` runtime assets
- can run `dev --watch` with a simple cross-platform polling watcher
- copies static assets from `build.copy`
- runs `mainProcess: "cottontail"` scripts through the local bridge path and `mainProcess: "bun"` scripts through the bundled Bun runtime/launcher path

Current limitations:

- `mainProcess: "zig"` is not implemented in this CLI path yet
- release packaging/signing/notarization from the old Electrobun CLI has not been ported into this cottontail path yet
- the direct `cottontail electrobun <entrypoint.js>` bridge is still the narrow `electrobun.createWindow()` / `quit()` surface, not the full Electrobun API

## Current status

The runtime is intentionally minimal right now. It embeds JavaScriptCore, supports relative ESM imports and async jobs, exposes `cottontail.args`, `cwd()`, `readFile()`, `writeFile()`, `env()`, `nanotime()`, basic fs mutation, platform/process info, and synchronous child process execution, and now has an early Electrobun bridge plus the first cottontail-owned Electrobun CLI path. It still does not expose a broad compatibility surface or a full Electrobun main-process API.
