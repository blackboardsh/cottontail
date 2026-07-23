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
  after all four targets pass.

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
node scripts/zig.js build -Doptimize=ReleaseSmall --verbose 2>&1 \
  | tee vm-linux-release.log
test "$(./zig-out/bin/cottontail -p '6 * 7')" = '42'
node scripts/package-release.js
```

Success produces an archive and checksum under `release/`.

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

## Windows x64

Use Windows 11 or Windows Server x64 when possible. On a Windows ARM VM, install
and run the x64 editions of Node and the shell so the built-in x64 emulation
exercises the artifact Cottontail will distribute. This command must
report `win32 x64`:

```powershell
node -p "process.platform + ' ' + process.arch"
```

If it reports `arm64`, stop and install x64 Node before running setup. The JSC
manifest intentionally contains a Windows x64 artifact, not a Windows ARM64
artifact.

### Install prerequisites

Install:

1. Git for Windows.
2. Node.js 24 LTS, x64.
3. Visual Studio 2022 Build Tools with the **Desktop development with C++**
   workload and a current Windows SDK.

The full Visual Studio IDE is not required. After installation, open **x64
Native Tools PowerShell for VS 2022**. Do not use WSL for the Windows build.

Verify that all tools resolve in that shell:

```powershell
node --version
node -p "process.platform + ' ' + process.arch"
Get-Command node, cl, link | Format-Table Name, Source
```

`cl.exe` and `link.exe` must resolve from the Visual Studio tools.

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
```

### Run the GitHub Actions sequence

```powershell
node scripts/zig.js build test --verbose 2>&1 |
  Tee-Object vm-windows-test.log
if ($LASTEXITCODE -ne 0) { throw "Windows tests failed" }

node scripts/zig.js build -Doptimize=ReleaseSmall --verbose 2>&1 |
  Tee-Object vm-windows-release.log
if ($LASTEXITCODE -ne 0) { throw "Windows release build failed" }

$output = & .\zig-out\bin\cottontail.exe -p '6 * 7'
if ($LASTEXITCODE -ne 0 -or $output.Trim() -ne '42') {
  throw "Cottontail smoke test failed: $output"
}

node scripts/package-release.js
if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed" }
```

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
