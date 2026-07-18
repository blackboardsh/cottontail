#if !defined(__x86_64__) && !defined(__aarch64__)
#error "The Cottontail ICU bridge supports x86_64 and aarch64 Linux"
#endif

    .text

#if defined(__x86_64__)
    .macro ICU_TRAMPOLINE name
    .globl \name
    .type \name, @function
\name:
    jmp *cottontail_icu_target_\name(%rip)
    .size \name, .-\name
    .endm
#else
    .macro ICU_TRAMPOLINE name
    .globl \name
    .type \name, %function
\name:
    adrp x16, cottontail_icu_target_\name
    ldr x16, [x16, :lo12:cottontail_icu_target_\name]
    br x16
    .size \name, .-\name
    .endm
#endif

#define ICU_SYMBOL(name) ICU_TRAMPOLINE name

#include "icu-symbols.inc"

#undef ICU_SYMBOL

    .purgem ICU_TRAMPOLINE

#if defined(__linux__)
    .section .note.GNU-stack,"",@progbits
#endif
