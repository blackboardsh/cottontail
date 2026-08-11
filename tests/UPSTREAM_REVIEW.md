# Bun-Derived JavaScript Test Upstream Review

The Bun-derived tests are Cottontail-owned JavaScript tests, not a live mirror
of Bun's repository. Bun compatibility established a useful starting line, not
a permanent dependency or product boundary. Local tests may now diverge, move
to another repository, or be retired when the corresponding subsystem changes.

This document records the human decisions. The small machine-readable companion
is [`upstream-review.json`](upstream-review.json). Exact per-file execution and
baseline ownership remain in
[`compat/upstream/bun/v1.3.10/status.json`](../compat/upstream/bun/v1.3.10/status.json).

## Frozen baseline

- Bun version: `1.3.10`
- Bun tag: `bun-v1.3.10`
- Bun commit: `30e609e08073cf7114bfb278506962a5b19d0677`
- Last upstream test review: Bun `1.3.10` at that commit
- Upstream comparison paths: `test/`, including its helpers and fixtures, plus
  the recorded package, parser, Bake, and TypeScript support closure

The macOS baseline contains 1,342 runnable Bun-derived files:

| Classification | Count |
| --- | ---: |
| Enabled Cottontail JavaScript baseline files | 1,319 |
| Whole-file expected failures | 19 |
| Deliberately out of scope | 4 |

There are also 29 explicitly named test-case exclusions and five expected
failures among individually split bundler cases. These remain visible
exceptions; they are not part of the zero-unexpected-failure target. An
unexpected pass is still a result that must be reviewed rather than silently
accepted.

Platform-specific expected results or exclusions must be explicit metadata
decisions; do not make silent per-platform changes to the suite being
certified. The baseline runs against Cottontail directly. Fixture dependencies
are prepared explicitly with an external package manager rather than routing
the runtime through another product's command facade.

## Current scope decisions

| Area | Destination | Current decision |
| --- | --- | --- |
| VM, module loading, process lifecycle, Node/Web APIs, and Bun runtime APIs | Cottontail | Adopt behavior that remains relevant, expressed in Cottontail terms. |
| Package management and project mutation | Out of scope | Use the project's selected external package manager; do not adopt Bun package-manager tests into Cottontail. |
| `Bun.build`, transpiler, plugins, macros, and compiler-backed compatibility APIs | Cottontail | Retain narrow runtime/compiler implementation coverage while those APIs remain implemented here. |
| Product identity and CLI wording | Cottontail | Tests assert Cottontail identity; Bun branding is not a compatibility requirement. |
| Bun React Server Components pipeline | Out of scope | Electrobun targets Warren/Cottontail-UI; reconsider only if Bun RSC becomes a product dependency. |
| JavaScriptCore sampling profiler | Out of scope | The Cottontail JSC build intentionally omits it; reconsider only if profiling becomes a supported feature. |
| Externalized subsystems | None yet | Name the destination repository here and in metadata when the first subsystem moves. |

The four current exact out-of-scope files are
`test/bake/dev/react-response.test.ts`, `test/cli/run/cpu-prof.test.ts`, and
`test/js/node/inspector/inspector-profiler.test.ts`, plus the dedicated
performance file `test/js/bun/http/serve-body-leak.test.ts`.

The three former Next Pages runnable files were retired because they install a
fixture, assert Bun package-manager lockfile/layout state, and drive Bun-specific
public orchestration. The retained fixture tree remains provenance input for
reviewing related upstream changes but is not part of the runnable baseline.

## Reviewing a newer Bun release

A Git tree diff between the last reviewed commit and the candidate Bun release
tag or commit is the source of truth. The tool diffs the whole tree before
filtering the recorded closure, so it catches added, deleted, renamed, and
modified tests, cross-boundary moves, and fixture or helper changes. Merged
pull requests are optional context for understanding a diff; scanning pull
requests is not a complete change inventory.

Run the read-only comparison tool with a candidate ref:

```sh
bun run compat:bun-tests:review --to bun-v1.3.11
```

Use `--format json` for a machine-readable review inbox. The tool uses a
temporary, no-checkout Git clone and compares only the paths recorded in
`upstream-review.json`. It removes the clone afterward and never copies into,
deletes from, or rewrites the owned JavaScript tests. A network fetch is
therefore review work, not an import.

For each reported change, make one explicit decision:

- `cottontail`: adapt or add coverage for Cottontail-owned runtime behavior or
  narrow compiler implementation behavior that has not yet been extracted.
- `external`: move or reimplement the subsystem and its coverage in a named
  external library repository.
- `out-of-scope`: do not adopt the test; record the product-boundary reason and
  what would cause reconsideration.

The suggested destination in the comparison output is only triage, not a
dependency edge. Current mappings and most-specific routing rules take
precedence, existing paths then fall back to the exact baseline status index,
and new paths finally use the Cottontail default. The reviewer owns the final
decision.

After review, update `lastReviewed` even when no tests are adopted. Update the
current routing rule when ownership changes and append a dated `history` entry
that records the source commit, old destination, new destination, and reason.
An `external` decision must name its destination repository. Keep rules loose:
add exact-path mappings only for exceptions, renames, splits, combinations, or
substantially rewritten tests.

The mapping list is deliberately empty. Populate it when a test changes relative
path or identity; matching entries are attached to the comparison report. An
exceptional mapping has this shape:

```json
{
  "originPaths": ["test/example.test.ts"],
  "localPaths": ["tests/js/example.test.ts"],
  "relationship": "adapted",
  "destination": "cottontail",
  "effectiveAt": "<reviewed Bun commit>",
  "reason": "Why same-relative-path provenance is no longer sufficient"
}
```

## Import policy and provenance

Automatic Bun test refreshes are disabled because reconstructing imported
destinations would discard intentional Cottontail changes. The importer
requires the explicit `--allow-bun-replace` escape hatch, verifies the pinned
commit, and stages a complete snapshot before an exceptional baseline
replacement. Ordinary review must use the comparison tool. Node's separate
snapshot import remains available.

Preserve Bun's MIT license at
[`compat/upstream/bun/v1.3.10/LICENSE.md`](../compat/upstream/bun/v1.3.10/LICENSE.md),
the source tag and commit in the snapshot manifest, and enough path history to
identify a derived test's origin. Do not remove attribution when a test is
adapted. Git history plus this baseline supplies provenance for same-path
tests. Record an explicit mapping
when a test is renamed, split, combined, or moved to another repository under a
different path. An upstream path records the immediate comparison source, not
exclusive authorship; preserve nested notices from Deno, Node, WebKit, WPT,
test262, esbuild, and other original sources too.

## Review history

| Date | Through | Result |
| --- | --- | --- |
| 2026-08-08 | Bun `1.3.10` (`30e609e08073`) | Established the owned Cottontail/Hutch JavaScript test baseline and routing policy. |
| 2026-08-11 | Bun `1.3.10` (`30e609e08073`) | Retired the 103-file transitional package-manager tier and classified future package-manager changes as out of scope. |
