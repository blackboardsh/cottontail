#ifndef COTTONTAIL_BUFFER_H
#define COTTONTAIL_BUFFER_H

#include <stddef.h>
#include <stdint.h>

int ct_buffer_compare(
    const uint8_t *left,
    size_t left_length,
    const uint8_t *right,
    size_t right_length
);

ptrdiff_t ct_buffer_index_of(
    const uint8_t *haystack,
    size_t haystack_length,
    const uint8_t *needle,
    size_t needle_length,
    size_t offset,
    uint8_t reverse
);

int ct_buffer_fill_pattern(
    uint8_t *target,
    size_t target_length,
    const uint8_t *pattern,
    size_t pattern_length
);

#endif
