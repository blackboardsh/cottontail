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

## Scripts

- `bun run setup` downloads the pinned Zig toolchain if needed.
- `bun run build` builds the debug executable.
- `bun run build:release` builds with `ReleaseSmall`.
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
