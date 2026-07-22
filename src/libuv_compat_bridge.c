#include <stdio.h>
#include <stdlib.h>

_Noreturn void CrashHandler__unsupportedUVFunction(const char* function_name)
{
    fprintf(
        stderr,
        "Bun encountered a crash when running a NAPI module that tried to call\n"
        "the %s libuv function.\n\n"
        "Bun is actively working on supporting all libuv functions for POSIX\n"
        "systems, please see this issue to track our progress:\n\n"
        "https://github.com/oven-sh/bun/issues/18546\n",
        function_name ? function_name : "<unknown>"
    );
    fflush(stderr);

    if (getenv("BUN_INTERNAL_SUPPRESS_CRASH_ON_UV_STUB"))
        _Exit(1);
    abort();
}
