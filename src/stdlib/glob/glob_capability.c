#include "../native_capability.h"
#include "../../native_bindings/glob_jsc.inc"

#define GLOB_BINDINGS \
    { "globCompileNative", ct_glob_compile_native },

CT_CAPABILITY_EXPORT_BINDINGS(GLOB_BINDINGS)
