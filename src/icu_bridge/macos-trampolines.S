#if !defined(__aarch64__) && !defined(__x86_64__)
#error "The Cottontail macOS ICU bridge supports arm64 and x86_64"
#endif

    .text

#if defined(__x86_64__)
    .macro ICU_TRAMPOLINE name
    .globl _\name
_\name:
    jmp *_cottontail_icu_target_\name(%rip)
    .endm
#else
    .macro ICU_TRAMPOLINE name
    .globl _\name
_\name:
    adrp x16, _cottontail_icu_target_\name@PAGE
    ldr x16, [x16, _cottontail_icu_target_\name@PAGEOFF]
    br x16
    .endm

#endif

#define ICU_SYMBOL(name) ICU_TRAMPOLINE name

#include "icu-symbols.inc"

#undef ICU_SYMBOL

    .purgem ICU_TRAMPOLINE
