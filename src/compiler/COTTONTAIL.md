# Cottontail Compiler

This directory began as the final Zig implementation of Bun's compiler stack.
It is now maintained as Cottontail source so its parser, resolver, linker, and
printer can evolve independently of Bun.

The original license and repository documentation remain in this directory.
Legacy internal modules still refer to their root module as `bun`; Cottontail
code imports the subsystem as `cottontail_compiler`. Those internal names will
be removed as the imported source is reduced to the compiler components used by
Cottontail.

Compiler-internal install data types and the legacy binary-lockfile codec are
temporarily retained for narrow services invoked by Hutch. Public package
management and project mutation live in Hutch. Cottontail does not expose
package mutation or launch-time auto-install; runtime module resolution only
reads modules already present on disk. This source is not a dependency on an
external Bun installation.
