#ifndef COTTONTAIL_STRIP_ANSI_H
#define COTTONTAIL_STRIP_ANSI_H

#include <stddef.h>
#include <stdint.h>

typedef struct CtStripAnsiLatin1Result {
    const uint8_t *ptr;
    size_t len;
    size_t capacity;
} CtStripAnsiLatin1Result;

typedef struct CtStripAnsiUtf16Result {
    const uint16_t *ptr;
    size_t len;
    size_t capacity;
} CtStripAnsiUtf16Result;

int ct_strip_ansi_latin1(
    const uint8_t *pointer,
    size_t len,
    CtStripAnsiLatin1Result *result
);
int ct_strip_ansi_utf16(
    const uint16_t *pointer,
    size_t len,
    CtStripAnsiUtf16Result *result
);
void ct_strip_ansi_free_latin1(uint8_t *pointer, size_t capacity);
void ct_strip_ansi_free_utf16(uint16_t *pointer, size_t capacity);

#endif
