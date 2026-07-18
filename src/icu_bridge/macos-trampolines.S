#if !defined(__aarch64__)
#error "The Cottontail macOS ICU bridge supports arm64"
#endif

    .text

    .macro ICU_TRAMPOLINE name
    .globl _\name
_\name:
    adrp x16, _cottontail_icu_target_\name@PAGE
    ldr x16, [x16, _cottontail_icu_target_\name@PAGEOFF]
    br x16
    .endm

#define ICU_SYMBOL(name) ICU_TRAMPOLINE name

#include "icu-symbols.inc"

#undef ICU_SYMBOL

    .purgem ICU_TRAMPOLINE
