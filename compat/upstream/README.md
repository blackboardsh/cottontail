# Upstream Test Dependencies

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
