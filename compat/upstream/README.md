# Upstream Test Dependencies

## Temporary directories

Run copied tests through `scripts/run-upstream-tests.js` when possible. Like Bun's own
repository runner, it gives every child an owned temp root through `BUN_TMPDIR`,
`TEST_TMPDIR`, `TMPDIR`, `TMP`, and `TEMP`, then removes that root after the child exits.
Direct Cottontail runs of the Bun snapshot get the same containment from the snapshot's
Cottontail-only preload.

## External package-manager fixtures

Cottontail owns the runtime and bundler behavior exercised by the Bun corpus;
package installation is external. The compatibility build includes a tiny
test-only command adapter. It routes runtime/compiler commands to the exact
Cottontail binary and routes only package commands to an explicitly selected
package manager. CI selects its pinned Bun 1.3.10 executable for that role:

```sh
COMMAND_ADAPTER="$(pwd)/zig-out/bin/cottontail-upstream-command"
PACKAGE_MANAGER="$(bun -e 'console.log(process.execPath)')"
node scripts/run-upstream-tests.js bun \
  --command-adapter "$COMMAND_ADAPTER" \
  --package-manager "$PACKAGE_MANAGER" \
  --test test/bundler/bundler_npm.test.ts \
  --case '^npm/ReactSSR$' \
  --expect-pass \
  --jobs 1
```

The test process remains the Cottontail binary selected by `--binary`. Both the
adapter and external manager are copied into the run's immutable tool store and
included in its identity hash. The runner never searches for or silently selects
a global package manager. `COTTONTAIL_UPSTREAM_COMMAND_ADAPTER` and
`COTTONTAIL_UPSTREAM_PACKAGE_MANAGER` provide explicit CI/local overrides.

Set `COTTONTAIL_UPSTREAM_KEEP_TEMP=1`, `COTTONTAIL_KEEP_TEMP`, or `DEBUG=1` to preserve
the run's root for inspection. Cleanup never scans for `bun.test.*` names; it can
only remove the exact root created for that run.

The copied upstream snapshots do not track `node_modules` or native binaries. Restore the
Bun snapshot's JavaScript dependencies without lifecycle scripts from its checked-in lockfile:

```sh
bun install --cwd=compat/upstream/bun/v1.3.10/test --frozen-lockfile --ignore-scripts
```

## DuckDB 1.3.1

`test/js/third_party/duckdb/duckdb-basic-usage.test.ts` needs the platform-specific
`duckdb.node` that the package's install script normally downloads. The upstream runner
prepares this fixture automatically when that exact test is selected. To prepare it
explicitly, run:

```sh
node scripts/setup-upstream-duckdb.js
```

The setup reads the resulting `duckdb@1.3.1` package from the Bun 1.3.10 snapshot,
downloads the pinned Node ABI 137 archive, verifies both the archive and extracted addon
SHA-256 values, and installs only `lib/binding/duckdb.node`. It never falls back to a
local source build. Downloads are cached under ignored `node_modules/.cache`; set
`COTTONTAIL_UPSTREAM_FIXTURE_CACHE` to use another cache directory.

The manifest pins macOS arm64/x64, glibc Linux arm64/x64, and Windows x64 artifacts.
Linux musl and Windows arm64 remain no-op skips, matching the copied upstream test,
because DuckDB 1.3.1 does not publish binaries for those targets.

The reproducible focused check is:

```sh
node scripts/run-upstream-tests.js bun \
  --test test/js/third_party/duckdb/duckdb-basic-usage.test.ts \
  --jobs 1
```
