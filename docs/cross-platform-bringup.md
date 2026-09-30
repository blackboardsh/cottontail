# Cross-platform bring-up

Use this runbook to reproduce the native GitHub Actions build on persistent
Linux and Windows machines. GitHub Actions remains the final clean-environment
and publishing gate, but platform work should be debugged locally first.

After the native build and package gate is green, continue with
[`cross-platform-compatibility.md`](cross-platform-compatibility.md) to validate
the complete Node and Bun behavior tiers on each operating system.

## Common rules

- Work from the repository root.
- Use the same commit on every machine. Record it with `git rev-parse HEAD`.
- Do not install Zig separately. `scripts/setup.js` downloads the pinned Zig
  toolchain into `vendors/zig`.
- Do not use Bun for this bring-up loop. The commands below use Node directly
  and match the GitHub Actions jobs.
- Do not upload to R2 from a VM. Let the complete GitHub Actions matrix publish
  after all five targets pass.

After pulling a new revision, leave `vendors/zig`, `vendors/jsc`, and
`vendors/zig-html-rewriter` in place unless diagnosing setup itself. Their
setup scripts validate revision and checksum stamps.

## Linux

Use Ubuntu 24.04. Use an x86-64 VM for the `linux-x64` artifact and an ARM64 VM
for the `linux-arm64` artifact. Run this first:

```bash
uname -m
node -p 'process.platform + " " + process.arch'
```

Expected values are `x86_64` plus `linux x64`, or `aarch64` plus `linux arm64`.
Emulation is acceptable for debugging, but the final GitHub Actions jobs run natively.

### Install prerequisites

```bash
sudo apt-get update
sudo apt-get install -y \
  ca-certificates curl git xz-utils build-essential clang g++ pkg-config \
  libbrotli-dev libffi-dev libicu-dev libssl-dev libzstd-dev zlib1g-dev

curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Open a fresh shell, then verify the tools:

```bash
node --version
node -p 'process.platform + " " + process.arch'
g++ --version
clang++ --version
```

Node must be version 24 and its architecture must match the VM.

### Pull and set up

```bash
git pull --ff-only
git rev-parse HEAD
node scripts/setup.js
node scripts/setup-zig-html-rewriter.js
node scripts/setup-jsc.js
```

Confirm that setup selected the expected JSC directory:

```bash
find vendors/jsc -maxdepth 3 -type f -name '.jsc-vendored' -print
```

### Run the GitHub Actions sequence

`pipefail` ensures a failed build remains a failed command when output is also
written to a log.

```bash
set -e -o pipefail
node scripts/zig.js build test --verbose 2>&1 | tee vm-linux-test.log
node scripts/zig.js build -Doptimize=ReleaseSmall -Dcpu=baseline --verbose 2>&1 \
  | tee vm-linux-release.log
test "$(./zig-out/bin/cottontail -p '6 * 7')" = '42'
node scripts/package-release.js
```

Success produces an archive and checksum under `release/`.

### Current Linux ARM64 checkpoint

The July 23, 2026 working-tree checkpoint has the following local evidence on
native Ubuntu 25.04 ARM64 with glibc 2.41:

- A fresh-cache `ReleaseSmall` build completed all 12 build steps. The native
  test target then passed 48 tests with one intentional skip.
- The complete local JavaScript behavior suite, including its hot/watch
  integration, passed against the final executable with its runtime modules
  embedded.
- Both targeted ICU Zig tests passed. The system-ICU path and the packaged ICU
  70.1 fallback were exercised, including a network-isolated packaged run with
  system ICU loading disabled.
- Packaging, checksum generation, the package script's smoke test, and an
  extracted-archive smoke outside the checkout passed.
- The upstream-runner regression suite passed all 13 tests.
- A real Node inventory/list smoke found 4,969 files recognized by Node's
  `tools/test.py`, mapping to 4,962 harness selectors, and exact focused
  selection worked.
- The Linux child-process deadlock and signal lifecycle/default gaps were
  fixed. JSC and libuv had both claimed `SIGUSR1`; Cottontail now moves JSC's
  GC suspension signal to a protected `SIGRTMIN` before VM creation and then
  allows libuv to own `SIGUSR1`. Lazy, unreferenced libuv watchers deliver
  external `SIGALRM`, `SIGPROF`, `SIGVTALRM`, `SIGPWR`, and aliases while
  tracking every supported listener add/remove path. `SIGPIPE` and `SIGXFSZ`
  have Node-compatible initial and post-listener defaults, `SIGKILL` and
  `SIGSTOP` registration is rejected, and numeric Linux real-time signals are
  external-target-only. All 30 process/signal lifecycle tests (60 assertions)
  and 50 consecutive child-process stress iterations passed.
- Linux `fs.statfsSync` and `fs.promises.statfs` now report the native
  filesystem magic in `type` instead of the previous zero placeholder,
  including bigint sync results.
- Standalone bytecode compilation now shuts down cleanly on Linux. The bridge
  owns its cached bytecode and restores the vendored JSC archive's
  `HAVE_MMAP`-dependent private ABI layout; all 12 runtime-bootstrap/startup
  checks passed.
- Focused constants, filesystem, networking/UDP, DNS, worker, and
  package-manager retry checks passed.

This remains an in-progress Linux ARM64 compatibility checkpoint. The Node
inventory verifies discovery and selection, not a 4,969-file execution pass.
One focused upstream Node execution was selected exactly but failed the copied
harness's global-leak check on Cottontail/Bun globals; the sampled Bun run
lacked its pinned snapshot test dependencies. The complete Node and Bun
upstream suites, real application canaries, and Linux x64 verification remain
outstanding. Synchronous fatal signals remain owned by Cottontail's native
crash handler rather than exposed as JavaScript signal events.

Performance tuning remains deferred while functional Linux parity is being
established. The five existing Bun performance quarantines remain documented
in `cross-platform-compatibility.md`; remaining functional gaps must not be
reclassified as performance exceptions.

### Linux diagnostics

For linker failures, collect these with the build log:

```bash
uname -a
ldd --version | head -1
node -p 'process.platform + " " + process.arch'
g++ -print-file-name=libstdc++.so
g++ -print-file-name=libgcc_s.so.1
g++ -print-file-name=libresolv.a
ldd zig-out/bin/cottontail 2>/dev/null || true
git status --short
```

An `_Unwind_*` symbol failure means the final link is missing the concrete GCC
unwind runtime reported by `g++ -print-file-name=libgcc_s.so.1`; it is not a JSC
or Cottontail behavior failure.

## Windows x64 and ARM64

Use native Node.js for the target architecture. The setup scripts select
`x64-windows-static` or `arm64-windows-static` dependencies and the matching JSC
SDK. Windows ARM64 uses interpreter-only JSC without JIT or WebAssembly.

The Windows Zig 0.16 ARM64 host compiler crashes, so setup deliberately installs
the x64 compiler on both architectures. `scripts/zig.js` passes the target
explicitly. Build on ARM64 hardware when targeting ARM64: generating the bundled
bytecode executes the newly built runtime.

Check the Node architecture before setup:

```powershell
node -p "process.platform + ' ' + process.arch"
```

### Install prerequisites

Install:

1. Git for Windows.
2. Node.js 24.18.0 for your target architecture (the release workflow pin).
3. Visual Studio Build Tools with the **Desktop development with C++** workload
   and a current Windows SDK. Windows x64 supports Visual Studio 2022. ARM64
   requires Visual Studio 2026 with the ARM64 C++ tools (MSVC 14.51 or newer),
   matching the static C++ runtime used by the published JSC ARM64 SDK.
4. The Visual Studio vcpkg component, or another `vcpkg.exe` discoverable
   through `VCPKG_ROOT` or `PATH`.

The full Visual Studio IDE is not required. Open a Visual Studio developer shell
for the target architecture. Do not use WSL for the Windows build.

Verify that all tools resolve in that shell:

```powershell
node --version
node -p "process.platform + ' ' + process.arch"
Get-Command node, cl, link | Format-Table Name, Source
```

The first command must report `v24.18.0`. `cl.exe` and `link.exe` must resolve
from the Visual Studio tools.

The copied Node test harness also requires Python. Use a Python installation
matching the target architecture:

```powershell
$env:PYTHON = (Resolve-Path C:\path\to\python\python.exe).Path
& $env:PYTHON -c "import platform; print(platform.machine())"
```

The architecture check must print `AMD64` or `ARM64`, matching the target.

### Pull and set up

```powershell
git pull --ff-only
git rev-parse HEAD
node scripts/setup.js
node scripts/setup-zig-html-rewriter.js
node scripts/setup-jsc.js
```

Confirm that these values and files are present:

```powershell
node -p "process.platform + ' ' + process.arch"
Get-ChildItem vendors\jsc -Recurse -Filter .jsc-vendored
Get-ChildItem vendors\jsc -Recurse -Filter JavaScriptCore.lib
Get-ChildItem vendors\jsc -Recurse -Filter SYSTEM_ICU_USAGE
Get-ChildItem "$env:WindowsSdkDir\Lib" -Recurse -Filter icu.lib
$arch = node -p "process.arch"
Get-Item "vendors\windows-deps\$arch-windows-static\lib\zstd.lib"
```

On Windows, `scripts/setup.js` installs the dependencies in `vcpkg.json` with
the target's `x64-windows-static` or `arm64-windows-static` triplet into `vendors/windows-deps`. That manifest
includes Zstandard, and the release links `zstd.lib` statically. Rerun setup
after changing `vcpkg.json`, or whenever a required library is absent. An
ambient `zstd.dll` on `PATH` is not a substitute for the vendored static
library.

### Run the GitHub Actions sequence

```powershell
node scripts/zig.js build test --verbose -j1
if ($LASTEXITCODE -ne 0) { throw "Windows tests failed" }

$env:COTTONTAIL_BUILD_JOBS = "1"
node scripts/build-release.js
if ($LASTEXITCODE -ne 0) { throw "Windows release build failed" }

$output = & .\zig-out\bin\cottontail.exe -p '6 * 7'
if ($LASTEXITCODE -ne 0 -or $output.Trim() -ne '42') {
  throw "Cottontail smoke test failed: $output"
}

node scripts/package-release.js
if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed" }
```

Run the Zig build commands directly. Do not merge and pipe their output through
`Tee-Object`: Zig uses its stdout listener protocol internally on Windows, and
putting that process behind a PowerShell pipeline can deadlock the build.
On Windows ARM, keep development Zig builds at `-j1` and run the build, local
suite, upstream Node suite, upstream Bun suite, and packaging as separate
phases. Parallelize only lightweight source inspection on a memory-constrained
VM.

### Windows diagnostics

For Windows toolchain or linker failures, capture:

```powershell
node -p "process.platform + ' ' + process.arch"
where.exe node
Get-Command cl, link | Format-List Name, Source
git status --short
```

## Working loop

On either VM:

1. Reproduce with the verbose test command.
2. Fix the first underlying compile or link failure rather than suppressing it.
3. Rerun the test build until it passes.
4. Run `ReleaseSmall`, the smoke test, and packaging.
5. Commit the platform fix and pull that same commit on the other machines.
6. Run GitHub Actions only after the affected native VM is green.

Do not add stubs, expected failures, or platform skips to make the release
matrix green. A target is complete only when its native test, release, smoke,
and package sequence all pass.

## Handoff prompt

Start a coding session from the repository root on the failing VM and use:

> Continue Cottontail's cross-platform release bring-up on this native machine.
> Read `docs/cross-platform-bringup.md` and `.github/workflows/build-release.yml`. Reproduce the
> failure locally with the documented verbose command, fix actual behavior or
> linkage without stubs or skips, and continue until tests, ReleaseSmall, the
> `6 * 7` smoke test, and packaging all pass. Preserve unrelated worktree
> changes and report the exact verification performed.

Attach or point the session at `vm-linux-test.log` or
`vm-windows-test.log` when a failure has already been captured.
