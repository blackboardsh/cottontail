#ifndef COTTONTAIL_NATIVE_STRIP_ANSI_H
#define COTTONTAIL_NATIVE_STRIP_ANSI_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    const uint16_t *ptr;
    size_t len;
} CtStripANSISlice;

typedef struct {
    const uint16_t *ptr;
    size_t len;
    size_t capacity;
} CtStripANSIResult;

int ct_strip_ansi_core(CtStripANSISlice input, CtStripANSIResult *output);
void ct_strip_ansi_core_free(void *pointer, size_t capacity);

#endif
