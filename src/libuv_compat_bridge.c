#include <stdio.h>
#include <stdlib.h>

_Noreturn void CrashHandler__unsupportedUVFunction(const char* function_name)
{
    fprintf(
        stderr,
        "Cottontail encountered a crash when running a NAPI module that tried to call\n"
        "the %s libuv function.\n\n"
        "Cottontail is actively working on supporting all libuv functions for POSIX\n"
        "systems, please report it here to track our progress:\n\n"
        "https://github.com/blackboardsh/cottontail/issues\n",
        function_name ? function_name : "<unknown>"
    );
    fflush(stderr);

    if (getenv("BUN_INTERNAL_SUPPRESS_CRASH_ON_UV_STUB"))
        _Exit(1);
    abort();
}
