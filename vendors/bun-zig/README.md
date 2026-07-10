# Bun Zig Parser Snapshot

This directory vendors the parser/transpiler-adjacent Zig sources from Bun tag
`bun-v1.3.14` (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`).

Cottontail uses this snapshot as the source of truth for JavaScript,
TypeScript, and JSX parsing/transformation behavior. Runtime APIs such as
`node:module.stripTypeScriptTypes` and `Bun.Transpiler` should be thin wrappers
around this embedded backend, not shell-outs to esbuild or Bun.

The vendored files are intentionally scoped to parser/printer/support modules
rather than the whole Bun repository.
