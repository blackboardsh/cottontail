# cottontail

`cottontail` is a tiny Zig-based JavaScript runtime for Electrobun workloads.

After a fresh clone, Bun is still the bootstrap path until `cottontail` is published or otherwise available on the machine. Once you have built the local binary once, you can use `cottontail` itself to drive the repo workflow.

This repo currently focuses on developer experience:

- Bun drives the local workflow.
- Zig is vendored locally into `vendors/zig`.
- QuickJS-ng is vendored locally into `vendors/quickjs`.
- The pinned Zig version is `0.16.0`, which is the latest stable Zig release as of `2026-05-16`.
- The pinned QuickJS-ng version is `0.14.0`, which is the latest release as of `2026-05-16`.
- `cottontail` can execute a JavaScript file and exposes a minimal `console.log` / `console.error` host.
- `cottontail.nanotime()` returns a monotonic nanosecond timestamp as a JavaScript `BigInt`.
- Zig now owns script loading and runtime flow; the C layer is kept to a narrow QuickJS bridge.
- The current runtime supports ESM entrypoints/imports, async job draining, and a minimal `cottontail` host API.

## Scripts

- `bun run setup` downloads the pinned Zig toolchain if needed.
- `bun run setup` also downloads the pinned QuickJS-ng amalgam if needed.
- `bun run build` builds the debug executable.
- `bun run build:release` builds with `ReleaseSmall`.
- `bun run run -- test.js` builds and runs a JavaScript file through `cottontail`.
- `bun run dev` vendors, builds, and runs the smoke test in `test.js`.
- `bun run bench` builds a release binary and runs dedicated startup / loop / JSON / async benchmarks.
- `bun run test:zig` runs the Zig unit tests.
- `bun run test:js` runs the JavaScript runtime behavior suite.
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

## Current status

The runtime is intentionally minimal right now. It embeds QuickJS-ng, supports relative ESM imports and async jobs, and exposes `cottontail.args`, `cwd()`, `readFile()`, `writeFile()`, `env()`, `nanotime()`, basic fs mutation, platform/process info, and synchronous child process execution, but it does not yet expose Electrobun-specific APIs or a broader compatibility surface.
