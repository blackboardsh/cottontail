#ifndef COTTONTAIL_WEBSOCKET_FRAME_H
#define COTTONTAIL_WEBSOCKET_FRAME_H

#include <stddef.h>
#include <stdint.h>

int ct_websocket_frame_encode(
    uint8_t *output,
    size_t output_length,
    const uint8_t *payload,
    size_t payload_length,
    uint8_t opcode,
    uint8_t rsv1,
    uint8_t masked,
    const uint8_t *mask
);

int ct_websocket_unmask_copy(
    uint8_t *output,
    const uint8_t *input,
    size_t length,
    const uint8_t *mask
);

#endif
