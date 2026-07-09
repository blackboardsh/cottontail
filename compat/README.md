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

The generated `api-surface.json` is intentionally an inventory, not a behavior
test result. It records:

- the local Node builtin module export names
- the local Bun `Bun` object, selected `bun:*` module exports, and globals
- the Cottontail runtime-module exports found under `src/runtime_modules`
- a first-pass name-level coverage comparison

Unsupported APIs should stay visible in this manifest until they are implemented
and covered by tests. Runtime stubs should throw clear errors when added; they
should not print to stdout because that would affect CLI/app behavior.

## Inline Caveats

Use this grep-friendly comment format for places where an implementation is
intentionally incomplete or conservative:

```js
// COTTONTAIL-COMPAT: <module-or-api> - <short reason>; <next step>.
```

Keep the comment close to the behavior it qualifies. These comments are for
real compatibility gaps, not generic todos.
