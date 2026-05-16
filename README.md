# cottontail

`cottontail` is the early scaffold for a tiny Zig-based JavaScript runtime intended for Electrobun workloads.

This repo currently focuses on developer experience:

- Bun drives the local workflow.
- Zig is vendored locally into `vendors/zig`.
- The pinned Zig version is `0.16.0`, which is the latest stable Zig release as of `2026-05-16`.
- A minimal `cottontail` executable builds and runs so the toolchain is validated end to end.

## Scripts

- `bun run setup` downloads the pinned Zig toolchain if needed.
- `bun run build` builds the debug executable.
- `bun run build:release` builds with `ReleaseSmall`.
- `bun run run -- --help` builds and runs the executable, forwarding args after `--`.
- `bun run dev -- --version` is an alias for the same build-and-run flow.
- `bun run test` runs the Zig unit tests.
- `bun run check-zig-version` prints the vendored Zig version through the local wrapper script.

## Current status

The runtime itself is still a placeholder. QuickJS-ng integration has not been wired in yet; this scaffold is meant to lock in the Bun + vendored Zig workflow first so the next step can focus on embedding the engine cleanly.
