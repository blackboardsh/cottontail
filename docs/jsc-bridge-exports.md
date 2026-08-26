# Cottontail JSC bridge exports

Cottontail statically links its own JavaScriptCore. Its first-party dynamic
libraries need a small part of the stock JSC C API, but the stock names must
not be exported from the executable's process-wide symbol namespace.

On Linux, an executable that exports names such as `JSValueMakeString` can
interpose those functions into an unrelated WebKitGTK loaded later in the same
process. WebKit then passes values from its system JavaScriptCore to
Cottontail's embedded JavaScriptCore, which is an incompatible engine instance
and can crash immediately.

## Bridge contract

The private runtime bridge uses the `cottontail_jsc_` prefix. For example,
dynamic libraries call `cottontail_jsc_JSValueMakeString`, while their source
continues to use `JSValueMakeString` through the remapping declarations in
`src/stdlib/jsc_bridge.h`.

`kJSClassDefinitionEmpty` is data rather than a function, so the bridge exposes
`cottontail_jsc_get_class_definition_empty()` and the remapping header
dereferences its result. This avoids platform-specific imported-data behavior.

The bridge source is compiled into the runtime by `configureJsc()` in
`build.zig`. Its symbols are the only JSC C bridge entries allowed by:

- `src/compiler/src/symbols.dyn` on Linux
- `src/compiler/src/symbols.txt` on macOS
- `src/compiler/src/symbols.def` on Windows

The executable and its bundled dynamic libraries must be built and shipped
together when this bridge changes. This is an internal bridge, not a supported
third-party JSC ABI.

## Invariants

- Never add an unprefixed `JS*` or `kJSClassDefinitionEmpty` entry to an export
  manifest.
- Add new bridge functions to the implementation, remapping header, all three
  export manifests, and `scripts/jsc-bridge-contract.js` in the same change.
- Keep Linux installed binaries export-restricted in every optimization mode.
  Zig 0.16's built-in linker currently accepts but does not apply the version
  script, and debug builds still use `-rdynamic`.
- Validate the release contract with `bun run test:release` and inspect a Linux
  build with `readelf --dyn-syms zig-out/bin/cottontail` when changing exports.

This rule is deliberately limited to the JSC C bridge. N-API, libuv, and the
V8 compatibility symbols are separate native-addon contracts.
