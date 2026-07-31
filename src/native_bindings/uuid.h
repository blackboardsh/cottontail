#ifndef COTTONTAIL_NATIVE_UUID_H
#define COTTONTAIL_NATIVE_UUID_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    const uint8_t *ptr;
    size_t len;
} CtUuidSlice;

typedef struct {
    const uint16_t *ptr;
    size_t len;
} CtUuidUtf16Slice;

void ct_uuid_v7(uint64_t timestamp, uint8_t output[16]);
void ct_uuid_v5(CtUuidSlice namespace_bytes, CtUuidSlice name, uint8_t output[16]);
void ct_uuid_v5_utf16(
    CtUuidSlice namespace_bytes,
    CtUuidUtf16Slice name,
    uint8_t output[16]
);
void ct_uuid_v5_latin1(
    CtUuidSlice namespace_bytes,
    CtUuidSlice name,
    uint8_t output[16]
);
size_t ct_uuid_format(uint8_t encoding, const uint8_t uuid[16], uint8_t output[36]);

#endif
