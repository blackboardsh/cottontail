# Cottontail Compatibility Surface

This directory tracks the API-name surface Cottontail is aiming to cover for
Node and Bun compatibility.

Regenerate the manifest with:

```sh
bun run compat:surface
```

View a terminal summary with:

```sh
bun run compat:surface:view
```

Regenerate and view in one command with:

```sh
bun run compat:surface:all
```

## JavaScript Baseline Tests

`compat/upstream/` contains the Node snapshot and the frozen source baseline for
the Bun-derived JavaScript tests. The Bun tree is no longer a live mirror:
Cottontail and Hutch own their tests and may adapt them as the products diverge
from Bun. The exact Bun v1.3.10 ownership index assigns 1,345 runnable files to
Cottontail and 100 package-manager, project-mutation, and package-script files
to Hutch. Cottontail currently enables 1,324 files, carries 18 whole-file
expected failures, and deliberately leaves three files out of scope. Hutch's
100 files run from its own repository. A `hutch` review route means handoff to
that repository, not vendoring Hutch tests or creating a permanent Cottontail
dependency on Hutch. The long-term dependency direction is Hutch to Cottontail.

The ownership boundary, reviewed-through Bun commit, future tag-diff process,
and provenance policy are recorded in
[`tests/UPSTREAM_REVIEW.md`](../tests/UPSTREAM_REVIEW.md). The adjacent
`tests/upstream-review.json` supplies the small machine-readable review policy.

Cottontail-local package-manager and project-command regressions also live
under Hutch's `tests/package-manager/` directory and run through
`scripts/run-local-package-manager-tests.js`. Runtime-facing
`bun:internal-for-testing` coverage remains here.

The pinned upstream targets are recorded in:

```sh
compat/upstream/targets.json
```

Each snapshot has:

- `manifest.json` for source tag/commit/provenance
- `status.json` for Cottontail's current enabled/skipped/expected-failure state
- the copied upstream test files and upstream license notice

The Bun `status.json` uses `defaultStatus: "not-enabled"`. Every currently
copied runnable file has an exact-path entry in `tests`. Regex status patterns
are forbidden: after an upstream refresh, a newly copied test is therefore
reported as unclassified instead of silently inheriting an expected failure.
Run the accounting check before changing the compatibility headline:

```sh
bun run compat:upstream:check
```

The check rejects stale paths, missing exact entries, count drift, unaccounted
`--test-name-pattern` arguments, and delegated files that are not marked
`owner: "hutch-package-manager"` plus `status: "skip"`. It also reports every
whole-file expected failure, structured test-name exclusion, split bundler
expected failure, and source-level upstream todo/skip marker.

Per-test `args` are appended to the Cottontail invocation. Every
`--test-name-pattern` argument must have matching `testNameExclusion` metadata,
which records the exact omitted names, classification, and reason. A
`serial: true` entry runs outside the Bun harness's parallel file workers for
load-sensitive tests. A `splitBundlerTests: true` entry runs every discovered
`itBundled` case in its own process through Bun's
`BUN_BUNDLER_TEST_FILTER`, bounding retained fixture memory. The owned
`expectBundled.ts` helper provides a registration-only discovery pass, so
generated case IDs are included and skipped/commented cases are not. These
adaptations must include their rationale in the entry's `reason`. An enabled
split entry may use `expectedFailureBundlerTests` to map individual case IDs to
reasons, with matching classifications in
`expectedFailureBundlerTestClassifications`. Those cases remain in every run as
strict expected failures, so a newly passing case is reported as an XPASS.

The source-marker count is an audit inventory, not a parity score. Upstream
todo/skip syntax includes platform guards, tests of `bun:test` skip behavior,
and fixture source embedded in strings. Runtime execution summaries determine
which cases actually skipped on a platform. Bun's copied `expectations.txt` is
retained for provenance but is not applied by Cottontail's direct Bun runner.

The Bun runner uses up to four workers by default. Independent failures from
the parallel phase are retried serially before being reported. Use `--jobs 1`
for deterministic debugging, or select one generated case without registering
the rest of a matrix:

```sh
node scripts/run-upstream-tests.js bun \
  --test test/bundler/bundler_plugin.test.ts \
  --case 'plugin/FileLoaderMultipleAssets'
```

Use `--no-serial-retry` when probing unclassified files in bulk. It preserves
the normal timeout and result reporting but avoids spending a second full test
budget confirming every discovery failure; enabled-suite and focused repair
runs should retain the default serial retry.

List imported upstream test status:

```sh
bun run compat:upstream:list
```

Run the currently enabled upstream tests:

```sh
bun run compat:upstream
```

Enabled Node tests run through Node's copied `tools/test.py` harness with
Cottontail passed as `--shell`, so Node metadata, flags, reporters, skip lists,
and harness setup stay in the path. Enabled Bun tests currently run directly
against the copied test file path.

Run enabled tests plus expected failures, requiring the expected failures to
still fail:

```sh
bun run compat:upstream:xfail
```

Refresh the Node snapshot from the version in `targets.json`:

```sh
bun run compat:upstream:import
```

Bun replacement is disabled by default because the old import operation deletes
destination paths and can erase intentional local adaptations. Review a newer
Bun tag without changing local tests instead:

```sh
bun run compat:bun-tests:review --to bun-v1.3.11
```

Upstream tests run against the vendored JavaScriptCore build — the only engine
Cottontail links (see the README's JavaScriptCore policy section). Engine
expectations recorded in `status.json` reflect that build. The native JSC
ShadowRealm feature remains intentionally disabled in the vendored JSCOnly
build, but Cottontail installs a tested, isolated `node:vm`-backed compatibility
constructor. Consequently, `test/js/bun/jsc/shadow.test.js` is enabled rather
than an expected failure.

The Bun-derived tests are now part of Cottontail's owned JavaScript baseline
suite. Do not silently rewrite them to pass. When an upstream-derived test
needs local adaptation, either fix Cottontail/the runner or document the
ownership decision in the relevant `status.json`. Preserve its inline notices
and the snapshot's license and provenance records; Bun may be the immediate
comparison source rather than the test's original author.

The generated `api-surface.json` is intentionally an inventory, not a behavior
test result. It records:

- the local Node builtin module export names
- the local Bun `Bun` object, selected `bun:*` module exports, and globals
- the Cottontail runtime-module exports found under `src/runtime_modules`
- a first-pass name-level coverage comparison
- a heuristic Node behavioral-readiness signal based on inline caveats,
  explicit unsupported/native markers, and Node-focused test files

Unsupported APIs should stay visible in this manifest until they are implemented
and covered by tests. Runtime stubs should throw clear errors when added; they
should not print to stdout because that would affect CLI/app behavior.

The behavioral-readiness percentage is intentionally rough. It is not a Node
conformance score; it is a dashboard signal that should move as compatibility
caveats are added, removed, and covered by tests.

## Inline Caveats

Use this grep-friendly comment format for places where an implementation is
intentionally incomplete or conservative:

```js
// COTTONTAIL-COMPAT: <module-or-api> - <short reason>; <next step>.
```

Keep the comment close to the behavior it qualifies. These comments are for
real compatibility gaps, not generic todos.
