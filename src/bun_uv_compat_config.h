#pragma once

// The Bun libuv compatibility sources only need OS() from root.h. Avoid
// pulling Bun's unrelated JSC build configuration into Cottontail's C build.
#define BUN__ROOT__H

#if defined(__APPLE__)
#define COTTONTAIL_BUN_UV_OS_DARWIN 1
#else
#define COTTONTAIL_BUN_UV_OS_DARWIN 0
#endif

#if defined(__linux__)
#define COTTONTAIL_BUN_UV_OS_LINUX 1
#else
#define COTTONTAIL_BUN_UV_OS_LINUX 0
#endif

#if defined(__FreeBSD__)
#define COTTONTAIL_BUN_UV_OS_FREEBSD 1
#else
#define COTTONTAIL_BUN_UV_OS_FREEBSD 0
#endif

#define OS(name) COTTONTAIL_BUN_UV_OS_##name
