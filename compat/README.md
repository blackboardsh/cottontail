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

## Upstream Test Snapshots

`compat/upstream/` contains owned Cottontail snapshots copied from the Node and
Bun repositories. These are intentionally committed into this repo so Cottontail
can keep testing against known Node/Bun behavior even if those projects change,
slow down, or Cottontail intentionally diverges.

The pinned upstream targets are recorded in:

```sh
compat/upstream/targets.json
```

Each snapshot has:

- `manifest.json` for source tag/commit/provenance
- `status.json` for Cottontail's current enabled/skipped/expected-failure state
- the copied upstream test files and upstream license notice

`status.json` may set `defaultStatus` to `enabled` to run the copied corpus by
default, then use per-test `disabled` or `skip` entries to quarantine failures
as they are discovered. Explicit `--test <relative-path>` runs the selected
test even if it is currently disabled, which keeps reproduction easy.
Per-test `args` are appended to the Cottontail invocation. A `serial: true`
entry runs outside the Bun harness's parallel file workers for load-sensitive
tests. A `splitBundlerTests: true` entry runs every discovered `itBundled` case
in its own process through Bun's `BUN_BUNDLER_TEST_FILTER`, bounding retained
fixture memory. The owned `expectBundled.ts` helper provides a registration-only
discovery pass, so generated case IDs are included and skipped/commented cases
are not. These adaptations must include their rationale in the entry's `reason`.
An enabled split entry may use `expectedFailureBundlerTests` to map individual
case IDs to documented reasons. Those cases remain in every run as strict
expected failures, so a newly passing case is reported as an XPASS.

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

Refresh the copied snapshots from the versions in `targets.json`:

```sh
bun run compat:upstream:import
```

Upstream tests run against the vendored JavaScriptCore build — the only engine
Cottontail links (see the README's JavaScriptCore policy section). Engine
expectations recorded in `status.json` reflect that build; for example,
`test/js/bun/jsc/shadow.test.js` is an expected failure because ShadowRealm is
intentionally disabled on the vendored JSCOnly build.

The copied tests are now part of Cottontail's owned compatibility corpus. Do not
silently rewrite them to pass. When a copied upstream test needs local
adaptation, either fix Cottontail/the runner or document the ownership decision
in the relevant `status.json`.

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
