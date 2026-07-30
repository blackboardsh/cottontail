#ifndef COTTONTAIL_GLOB_H
#define COTTONTAIL_GLOB_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool ct_glob_match(
    const uint8_t *pattern,
    size_t pattern_length,
    const uint8_t *path,
    size_t path_length
);

#endif
