#if !defined(__x86_64__)
#error "The Cottontail Windows ICU bridge supports x64"
#endif

    .text

    .macro ICU_TRAMPOLINE name
    .globl \name
\name:
    jmp *cottontail_icu_target_\name(%rip)
    .endm

#define ICU_SYMBOL(name) ICU_TRAMPOLINE name

#include "icu-symbols.inc"

#undef ICU_SYMBOL

    .purgem ICU_TRAMPOLINE
