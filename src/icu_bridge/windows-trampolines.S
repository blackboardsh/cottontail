#if !defined(__x86_64__) && !defined(__aarch64__)
#error "The Cottontail Windows ICU bridge supports x64 and ARM64"
#endif

    .text

    .macro ICU_TRAMPOLINE name
    .p2align 2
    .globl \name
\name:
#if defined(__aarch64__)
    // x16 is the ABI's volatile intra-procedure scratch register. Preserve
    // integer/floating arguments and LR, and never touch Windows' reserved x18.
    adrp x16, cottontail_icu_target_\name
    ldr x16, [x16, :lo12:cottontail_icu_target_\name]
    br x16
#else
    jmp *cottontail_icu_target_\name(%rip)
#endif
    .endm

#define ICU_SYMBOL(name) ICU_TRAMPOLINE name

#include "icu-symbols.inc"

#undef ICU_SYMBOL

    .purgem ICU_TRAMPOLINE
