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
macOS arm64, Linux x64/arm64, and Windows x64 archives. Cottontail's release
matrix uses all four directly. The only intended
Cottontail-specific engine contract is that JSC uses the unversioned ICU 70 C
ABI. On every supported platform, Cottontail's runtime bridge first uses a
system ICU with ABI 70 or newer. If none is usable, the executable switches to
its statically linked ICU 70.1 fallback implementation and a checksum-pinned
external data file. JSC SDK artifacts publish the fallback code and canonical
data; setup can also reproduce the Unix fallback from its checksum-pinned ICU
source when consuming an older artifact.

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
- `bun run pin:jsc -- [WebKit-tag]` pins a completed R2 JSC matrix (or `jsc/latest.json` when omitted) and updates the matching build path.
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

GitHub Actions defines native release jobs for macOS arm64, Linux x64, Linux
arm64, and Windows x64 in `.github/workflows/build-release.yml`. Every job runs Zig
tests, builds with `ReleaseSmall`, smoke-tests the binary, packages the runtime,
and stores the archive plus its SHA-256 file. The JavaScript runtime modules are
embedded in the executable at build time.

For native VM setup, exact workflow-equivalent commands, diagnostics, and the
cross-platform working loop, see [`docs/cross-platform-bringup.md`](docs/cross-platform-bringup.md).

The schema 2 archive layout contains a standalone executable for Dash CLI consumption:

- `bin/cottontail` (`bin/cottontail.exe` on Windows)
- `runtime_modules/` for downstream bundlers that need physical module paths
- `cottontail-release.json`

Cottontail does not put downloaded files beside its executable. When no
compatible system ICU exists, it downloads and verifies `icudt70l.dat` into a
shared per-user location: `~/Library/Application Support/Cottontail/icu/70.1`
on macOS, `%LOCALAPPDATA%\Cottontail\icu\70.1` on Windows, and
`${XDG_DATA_HOME:-~/.local/share}/cottontail/icu/70.1` on Linux. A small verified
marker avoids hashing the 28 MB database on every launch. GitHub Actions runs the
packaged Linux binary in a minimal image with no system ICU to exercise this
production download path without a CI-only switch.

The native matrix exercises the platform host bridge on each supported target.

### Preview publishing

After every `main` branch matrix job succeeds, a fan-in job uploads the complete
release to Cloudflare R2. Configure these GitHub repository secrets:

- `COTTONTAIL_R2_ACCOUNT_ID`: Cloudflare account ID used to derive the R2 S3 endpoint.
- `COTTONTAIL_R2_ACCESS_KEY_ID`: access key from an R2 Object Read & Write token scoped to the release bucket.
- `COTTONTAIL_R2_SECRET_ACCESS_KEY`: secret for that access key.

Configure this GitHub repository variable:

- `COTTONTAIL_R2_PUBLIC_BASE_URL`: public custom-domain or `r2.dev` origin for the bucket, without a trailing slash.

The target bucket is `electrobun-artifacts`. Continuous preview archives use
immutable revision paths:

- `cottontail/preview/builds/<git-sha>/<platform>/cottontail.tar.gz`

Consumers discover the newest complete preview matrix through
`cottontail/preview/latest.json`. The checksum remains in the manifest and the
adjacent `.sha256` object; it is not part of the object path.

Commits tagged `v<version>` also publish an immutable, derivable version release:

- `cottontail/releases/<version>/<platform>/cottontail.tar.gz`
- `cottontail/releases/<version>/manifest.json`

For example, version `0.1.1-beta.0` on macOS ARM64 is always located at
`cottontail/releases/0.1.1-beta.0/macos-arm64/cottontail.tar.gz`. The preview
channel pointers are:

- `cottontail/preview/latest.json`
- `cottontail/preview/versions/<version>.json`

The publisher uploads every archive before replacing `latest.json`, so a failed
build or upload cannot advertise a partial matrix. Pull requests run tests and
packaging but skip R2 publishing. Run
`node scripts/upload-release-r2.js --dry-run` after local packaging to inspect a
single-platform dry run without requiring credentials. Real publication requires
all four archives and the `--all` option.

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

- transpiles and evaluates `electrobun.config.ts`
- transpiles TS lifecycle hooks like `postBuild.ts` and runs them under `cottontail`
- builds TypeScript/JavaScript entrypoints with Cottontail's native Zig compiler
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
