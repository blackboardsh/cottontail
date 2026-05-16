# cottontail

`cottontail` is a tiny Zig-based JavaScript runtime for Electrobun workloads.

This repo currently focuses on developer experience:

- Bun drives the local workflow.
- Zig is vendored locally into `vendors/zig`.
- QuickJS-ng is vendored locally into `vendors/quickjs`.
- The pinned Zig version is `0.16.0`, which is the latest stable Zig release as of `2026-05-16`.
- The pinned QuickJS-ng version is `0.14.0`, which is the latest release as of `2026-05-16`.
- `cottontail` can execute a JavaScript file and exposes a minimal `console.log` / `console.error` host.

## Scripts

- `bun run setup` downloads the pinned Zig toolchain if needed.
- `bun run setup` also downloads the pinned QuickJS-ng amalgam if needed.
- `bun run build` builds the debug executable.
- `bun run build:release` builds with `ReleaseSmall`.
- `bun run run -- test.js` builds and runs a JavaScript file through `cottontail`.
- `bun run dev` vendors, builds, and runs the smoke test in `test.js`.
- `bun run test:zig` runs the Zig unit tests.
- `bun run test:js` runs the JavaScript smoke test.
- `bun run test` runs both the Zig and JavaScript tests.
- `bun run check-zig-version` prints the vendored Zig version through the local wrapper script.

## Current status

The runtime is intentionally minimal right now. It embeds QuickJS-ng, evaluates a single script file, and provides console output, but it does not yet expose Electrobun-specific APIs or broader runtime features.
