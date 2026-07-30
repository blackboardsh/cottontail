#ifndef COTTONTAIL_NATIVE_PATH_H
#define COTTONTAIL_NATIVE_PATH_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    const uint16_t *ptr;
    size_t len;
} CtPathSlice;

typedef struct {
    const uint16_t *ptr;
    size_t len;
} CtPathResult;

typedef struct {
    const char *ptr;
    size_t len;
} CtWhichSlice;

typedef struct {
    const char *ptr;
    size_t len;
} CtWhichResult;

int ct_path_core_normalize(uint8_t windows, CtPathSlice input, CtPathResult *output);
void ct_path_core_free(void *pointer, size_t len);
int ct_which_core_find_on_path(
    CtWhichSlice path,
    CtWhichSlice cwd,
    CtWhichSlice bin,
    CtWhichSlice system_root,
    CtWhichSlice canonical_system_root,
    CtWhichResult *output
);
void ct_which_core_free(void *pointer, size_t len);

#endif
