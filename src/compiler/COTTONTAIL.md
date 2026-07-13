# Cottontail Compiler

This directory began as the final Zig implementation of Bun's compiler stack.
It is now maintained as Cottontail source so its parser, resolver, linker, and
printer can evolve independently of Bun.

The original license and repository documentation remain in this directory.
Legacy internal modules still refer to their root module as `bun`; Cottontail
code imports the subsystem as `cottontail_compiler`. Those internal names will
be removed as the imported source is reduced to the compiler components used by
Cottontail.

The package-manager source is intentionally retained. Resolver auto-install is
currently disabled at the compiler boundary until its network and event-loop
dependencies are connected to Cottontail's runtime; it is not a dependency on
an external Bun installation.
