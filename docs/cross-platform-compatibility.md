# Cross-platform Node and Bun compatibility

This runbook covers the work required for Cottontail to replace Bun as the
runtime, test runner, build runner, and package manager in Electrobun, Dash
Desktop, and Dash platform applications on macOS, Linux, and Windows.

Use `docs/cross-platform-bringup.md` first when a target does not build, link,
smoke test, or package. This document starts where native release bring-up ends:
the executable exists, but its Node or Bun behavior has not yet been validated
against the macOS baseline.

## Current baseline

Cottontail owns these pinned upstream snapshots:

- Node 24.11.1: 7,015 discovered runnable files, all currently enabled.
- Bun 1.3.10: 1,440 enabled files and five performance-only expected failures.

Those classifications are global and were established from the current macOS
working baseline. `compat:surface:all` does not record results by operating
system. It can therefore display 100 percent while the same enabled tier fails
on Linux or Windows.

The release workflow currently proves native compilation, Zig tests, a small
runtime smoke test, packaging, and Linux ICU fallback. It does not run the local
JavaScript behavior suite or either copied upstream compatibility suite.

## Definition of done

A Cottontail revision is cross-platform compatible only when the same revision
and pinned JSC revision satisfy all of these gates on:

- macOS ARM64
- Linux x64 on glibc
- Linux ARM64 on glibc
- Windows x64, including Windows ARM machines using x64 emulation

Each target must:

1. Pass the native test, release build, smoke test, and packaging sequence.
2. Pass Cottontail's local JavaScript behavior suite.
3. Pass every platform-applicable enabled Node 24.11.1 upstream test.
4. Pass every platform-applicable enabled Bun 1.3.10 upstream test.
5. Preserve the five existing performance-only expected failures without adding
   new expected failures, disabled tests, stubs, or Cottontail-only platform
   skips.
6. Install the Bun snapshot dependencies using Cottontail itself on a clean
   platform-native `node_modules` tree.
7. Run from the packaged archive outside the source checkout.
8. Build and launch the real Dash Desktop and Dash platform application
   canaries with Bun absent from `PATH`.

An upstream-authored skip for functionality that Node or Bun does not support
on that operating system is valid. A new skip that only avoids a Cottontail
failure is not.

## First runner improvements

Do these before a long repair campaign. They improve iteration and reporting
but must not delay fixing an already understood runtime failure.

### Make Node filters effective

`scripts/run-upstream-tests.js node --match ...` currently computes a filtered
entry list, but `runNodeHarness()` invokes the full suite whenever Node's
`defaultStatus` is `enabled`. Update it so `--match`, `--max-tests`,
`--only-status`, and `--test` all pass the selected Node test selectors to
`tools/test.py`.

Until that is fixed, use `--test` for a focused Node reproduction.

### Record platform results separately

Do not make `status.json` platform-specific. It defines the common compatibility
contract. Add generated result records keyed by:

- Cottontail Git revision
- JSC build revision
- operating system and architecture
- upstream runtime and version
- passed, failed, skipped, timed out, and expected-failure counts
- failed test paths and elapsed time

Teach `compat:surface:all` to show one row per platform. A platform is unknown
until a result from the exact Cottontail revision exists.

## Prepare each VM

Follow the prerequisite and native build steps in
`docs/cross-platform-bringup.md`. Use the same Git revision on every machine:

```sh
git rev-parse HEAD
```

Build once, then use the exact resulting executable for every focused test:

```sh
node scripts/setup.js
node scripts/setup-zig-html-rewriter.js
node scripts/setup-jsc.js
node scripts/zig.js build test
node scripts/zig.js build -Doptimize=ReleaseSmall -Dcpu=baseline
```

On Windows, use:

```powershell
node scripts/zig.js build -Doptimize=ReleaseSmall `
  -Dtarget=x86_64-windows-msvc -Dcpu=baseline
```

Windows also needs Python 3 available as `python` for Node's copied
`tools/test.py` harness.

## Use clean test dependencies

Never copy the macOS Bun snapshot `node_modules` tree onto Linux or Windows.
Optional packages and native addons are selected by operating system and
architecture.

Remove the ignored tree and bootstrap it with the Cottontail binary under test:

```sh
rm -rf compat/upstream/bun/v1.3.10/test/node_modules
./zig-out/bin/cottontail install \
  --cwd compat/upstream/bun/v1.3.10/test \
  --ignore-scripts
```

Windows PowerShell:

```powershell
Remove-Item -Recurse -Force `
  compat\upstream\bun\v1.3.10\test\node_modules `
  -ErrorAction SilentlyContinue

.\zig-out\bin\cottontail.exe install `
  --cwd compat\upstream\bun\v1.3.10\test `
  --ignore-scripts
```

If this fails, treat it as the first package-manager compatibility failure.
An external Bun installation may be used temporarily to unblock unrelated
runtime diagnosis, but the final platform gate must bootstrap with Cottontail.
The upstream runner prepares its pinned DuckDB and Svelte fixtures when those
tests are selected.

## Establish a native baseline

Capture logs from one complete run before changing behavior. Do not run the full
corpus after every fix.

### Linux

```sh
set -e -o pipefail
binary="$PWD/zig-out/bin/cottontail"

node scripts/test-js.js 2>&1 | tee vm-linux-local-js.log
node scripts/run-upstream-tests.js node \
  --binary "$binary" 2>&1 | tee vm-linux-node.log
node scripts/run-upstream-tests.js bun \
  --binary "$binary" --jobs 4 --no-serial-retry \
  2>&1 | tee vm-linux-bun-discovery.log
```

The discovery run avoids serially repeating every initial Bun failure. Once the
failure set is understood, rerun failing files or subsystems with `--jobs 1`.

### Windows PowerShell

```powershell
$binary = (Resolve-Path .\zig-out\bin\cottontail.exe).Path

node scripts/test-js.js 2>&1 |
  Tee-Object vm-windows-local-js.log
if ($LASTEXITCODE -ne 0) { throw "Local JavaScript tests failed" }

node scripts/run-upstream-tests.js node --binary $binary 2>&1 |
  Tee-Object vm-windows-node.log
if ($LASTEXITCODE -ne 0) { Write-Host "Node baseline has failures" }

node scripts/run-upstream-tests.js bun --binary $binary `
  --jobs 4 --no-serial-retry 2>&1 |
  Tee-Object vm-windows-bun-discovery.log
if ($LASTEXITCODE -ne 0) { Write-Host "Bun baseline has failures" }
```

Keep environment setup failures separate from runtime failures. Missing Python,
compiler tools, certificates, fixture packages, or permissions do not prove a
Cottontail behavior gap.

## Triage by root cause

Do not process thousands of failures independently. Group failures by their
first shared incorrect behavior. One host-layer correction can repair hundreds
of upstream files.

Use this order:

1. Crashes, hangs, memory corruption, and process leaks.
2. Test runner, temp-directory, fixture, and process-tree cleanup failures.
3. Module loading, package resolution, TypeScript transformation, and source
   maps.
4. Filesystem, path, process, child process, workers, and environment behavior.
5. Timers, async hooks, streams, sockets, DNS, HTTP, TLS, and WebSockets.
6. Bun.file, Bun.spawn, Bun shell, Bun test, Bun.build, and package management.
7. N-API, FFI, SQLite, and third-party native-addon integrations.
8. Inspector, profiling, stress, and platform-specific edge behavior.

Fix shared behavior in the lowest correct layer:

- JavaScript API orchestration: `src/runtime_modules/node/`,
  `src/runtime_modules/bun/`, and `src/runtime_modules/internal/`.
- Portable host primitives: `src/native_bindings/`, `src/native_bindings.zig`,
  `src/jsc_runner.c`, and `src/host.zig`.
- Workers and processes: `src/runtime_modules/node/worker_threads.js`,
  `src/runtime_modules/node/child_process.js`, `src/native_bindings/worker.c`,
  and `src/native_bindings/process.c`.
- Compiler and module loading: `src/cottontail_transpiler.zig`,
  `src/cottontail_bundler.zig`, `src/script_runner.zig`, and
  `src/compiler/src/`.
- Package management: `src/package_manager_*.zig` and
  `src/compiler/src/install/`.
- JSC private ABI adapters: `src/jsc_*_bridge.cpp` and `src/napi_bridge.cpp`.

Prefer Zig, libuv, OpenSSL, and the existing native host boundaries over
shelling out to Unix utilities. Port the corresponding platform implementation
from the last Zig Bun source when it provides the required behavior. Do not
fake successful results in JavaScript.

## Focused repair commands

Run one failing copied file deterministically:

```sh
node scripts/run-upstream-tests.js bun \
  --test test/js/node/fs/promises.test.js \
  --jobs 1

node scripts/run-upstream-tests.js node \
  --test test/parallel/test-buffer-badhex.js
```

Run a Bun subsystem:

```sh
node scripts/run-upstream-tests.js bun \
  --match '^test/js/node/(fs|path|module)/' \
  --jobs 1

node scripts/run-upstream-tests.js bun \
  --match '^test/js/bun/(spawn|shell|net|http|fetch)/' \
  --jobs 1

node scripts/run-upstream-tests.js bun \
  --match '^test/(bundler|cli|config)/' \
  --jobs 1
```

For generated bundler cases:

```sh
node scripts/run-upstream-tests.js bun \
  --test test/bundler/bundler_plugin.test.ts \
  --case 'plugin/FileLoaderMultipleAssets' \
  --jobs 1
```

Use `--timeout-scale` only to distinguish slow progress from a deadlock.
Returning within a larger diagnostic timeout is not the final fix when Node or
Bun completes the same operation within its normal deadline.

After fixing a root cause:

1. Add or extend a focused local test under `tests/`.
2. Run that local test on the failing platform.
3. Run the copied upstream file.
4. Run the affected subsystem.
5. Run the same focused checks on macOS to catch regressions.
6. Commit the root-cause fix before starting another subsystem.

Run the complete native suite only after a meaningful batch or before merging.

## Platform-specific risk areas

### Windows

Prioritize:

- UTF-16 paths, drive-relative paths, UNC paths, long paths, and path casing.
- File sharing flags, delete/rename behavior, junctions, symlinks, hardlinks,
  and locked files.
- `PATHEXT`, `.cmd` package shims, command quoting, `argv0`, handle inheritance,
  job objects, termination, and exit status.
- Named pipes, overlapped I/O, console streams, terminal behavior, and watchers.
- Windows certificate stores, TLS verification, DNS, and network error codes.
- DLL and `.node` loading, MSVC runtime compatibility, N-API, and FFI calling
  conventions.
- Package lifecycle shell selection and atomic `node_modules` replacement.

Do not translate Windows semantics into POSIX semantics merely to satisfy a
macOS-authored local test. Match Node or Bun on Windows.

### Linux

Prioritize:

- glibc behavior on both x64 and ARM64.
- File descriptor inheritance, signals, process groups, `/proc`, `epoll`,
  `inotify`, `eventfd`, and `memfd`.
- Filesystem modes, symlinks, hardlinks, case sensitivity, atomic rename, and
  executable bits.
- Resolver behavior, system CA discovery, OpenSSL error mapping, IPv4/IPv6,
  Unix sockets, and HTTP/TLS shutdown.
- PTYs, terminal flags, shell process groups, and child cleanup.
- ELF `.so` and `.node` loading, N-API, FFI ABI, and native optional packages.
- The packaged ICU fallback on hosts without a compatible system ICU.

A Linux x64 pass does not replace Linux ARM64 validation when native addons,
JSC ABI, atomics, or package optional dependencies are involved.

## Status and test ownership rules

- Keep a macOS-passing test `enabled` while repairing another platform.
- Do not add a platform-specific `expected-failure` to `status.json`.
- Do not rewrite copied upstream assertions to match Cottontail.
- Upstream-authored platform skips remain intact.
- When Node and Bun intentionally differ by platform, implement and test the
  same branch in Cottontail.
- Use the standard inline caveat format only for a real remaining gap:

```js
// COTTONTAIL-COMPAT: <module-or-api> - <reason>; <next step>.
```

- A timeout, crash, or missing fixture is not evidence that API behavior is
  implemented.
- The five current Bun expected failures are performance quarantines. Functional
  parity work must not add to that list.

## Final native gate

After focused repairs are green, run without `--no-serial-retry`:

```sh
node scripts/zig.js build test
node scripts/zig.js build -Doptimize=ReleaseSmall -Dcpu=baseline
node scripts/test-js.js
node scripts/run-upstream-tests.js node
node scripts/run-upstream-tests.js bun --jobs 4
node scripts/run-upstream-tests.js bun \
  --include-expected-failures --jobs 4
node scripts/package-release.js
```

Use the explicit Windows target for the Windows release build.

Extract the packaged archive into a clean directory and repeat:

- `cottontail -p "6 * 7"`
- a TypeScript entrypoint
- a CommonJS entrypoint
- a worker
- a child process
- a local HTTP and WebSocket server/client exchange
- `cottontail test`
- `cottontail build`
- `cottontail install` in a clean fixture

The packaged binary must not load libraries or runtime source from the checkout.

## Project canary

The final proof is a real project, not only upstream tests.

On Windows and both Linux architectures:

1. Remove Bun from `PATH`.
2. Point dash-cli and Electrobun at the exact packaged Cottontail artifact.
3. Install a clean dependency graph using Cottontail.
4. Build Dash Desktop and the Dash platform applications.
5. Launch the applications and exercise main-process startup, workers, child
   processes, filesystem access, networking, test execution, and rebuild/watch.
6. Record the Cottontail Git revision, JSC revision, artifact SHA-256, and
   project revisions.

Any required fallback to Bun is a compatibility failure to classify and repair.

## CI after native convergence

Once the VMs are green, add a compatibility workflow separate from the fast
native build workflow:

- Pull requests run local JavaScript tests and affected Node/Bun subsystem
  shards.
- `main`, scheduled runs, and release candidates run the full macOS, Linux x64,
  Linux ARM64, and Windows x64 compatibility matrix.
- Upload structured platform results and failure logs.
- Require the complete exact-revision matrix before publishing a release that
  claims cross-platform Node/Bun compatibility.

The R2 publish gate should continue to publish only after all required platform
jobs pass.

## VM handoff prompt

Use this prompt from the repository root on a native VM:

> Continue Cottontail's Node 24.11.1 and Bun 1.3.10 cross-platform parity work
> on this native machine. Read `docs/cross-platform-bringup.md` and
> `docs/cross-platform-compatibility.md`. Work from the same committed revision
> as the other platforms. First make the native build and local JavaScript suite
> pass, then establish the upstream Node and Bun failure baseline. Group
> failures by root cause and fix actual behavior in the lowest correct native or
> runtime layer. Do not add stubs, expected failures, disabled tests, or
> Cottontail-only platform skips. Use focused upstream files and subsystem runs
> while iterating, preserve macOS behavior, and continue until the complete
> platform-applicable enabled suites pass. Record exact commands and logs.
