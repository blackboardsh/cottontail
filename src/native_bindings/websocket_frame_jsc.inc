#include "websocket_frame.h"

static bool ct_websocket_get_bytes(
    JSContextRef context,
    JSValueRef value,
    uint8_t **bytes_out,
    size_t *length_out,
    JSValueRef *exception,
    const char *message
) {
    if (ct_get_bytes(context, value, bytes_out, length_out) == 0) return true;

    if (JSValueIsObject(context, value)) {
        JSObjectRef object = (JSObjectRef)value;
        JSValueRef buffer_value = ct_get_property(context, object, "buffer", exception);
        if (exception != NULL && *exception != NULL) return false;
        JSValueRef byte_offset_value = ct_get_property(context, object, "byteOffset", exception);
        if (exception != NULL && *exception != NULL) return false;
        JSValueRef byte_length_value = ct_get_property(context, object, "byteLength", exception);
        if (exception != NULL && *exception != NULL) return false;

        JSValueRef local_exception = NULL;
        JSTypedArrayType buffer_type = JSValueGetTypedArrayType(
            context,
            buffer_value,
            &local_exception
        );
        double byte_offset_number = JSValueToNumber(context, byte_offset_value, &local_exception);
        double byte_length_number = JSValueToNumber(context, byte_length_value, &local_exception);
        if (local_exception == NULL &&
            buffer_type == kJSTypedArrayTypeArrayBuffer &&
            isfinite(byte_offset_number) &&
            isfinite(byte_length_number) &&
            byte_offset_number >= 0 &&
            byte_length_number >= 0 &&
            floor(byte_offset_number) == byte_offset_number &&
            floor(byte_length_number) == byte_length_number &&
            byte_offset_number <= (double)SIZE_MAX &&
            byte_length_number <= (double)SIZE_MAX) {
            JSObjectRef buffer = (JSObjectRef)buffer_value;
            size_t buffer_length = JSObjectGetArrayBufferByteLength(context, buffer, &local_exception);
            uint8_t *base = (uint8_t *)JSObjectGetArrayBufferBytesPtr(
                context,
                buffer,
                &local_exception
            );
            size_t byte_offset = (size_t)byte_offset_number;
            size_t byte_length = (size_t)byte_length_number;
            if (local_exception == NULL &&
                byte_offset <= buffer_length &&
                byte_length <= buffer_length - byte_offset &&
                (base != NULL || byte_length == 0)) {
                *bytes_out = base != NULL ? base + byte_offset : NULL;
                *length_out = byte_length;
                return true;
            }
        }
    }

    ct_throw_type_error(context, exception, message);
    return false;
}

static bool ct_websocket_get_u8(
    JSContextRef context,
    JSValueRef value,
    uint8_t *result_out,
    JSValueRef *exception,
    const char *message
) {
    JSValueRef conversion_exception = NULL;
    double number = JSValueToNumber(context, value, &conversion_exception);
    if (conversion_exception != NULL) {
        if (exception != NULL) *exception = conversion_exception;
        return false;
    }
    if (!isfinite(number) || number < 0 || number > UINT8_MAX || floor(number) != number) {
        ct_throw_type_error(context, exception, message);
        return false;
    }
    *result_out = (uint8_t)number;
    return true;
}

static JSValueRef ct_websocket_frame_encode_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 4) {
        ct_throw_type_error(
            context,
            exception,
            "websocketFrameEncode requires payload, opcode, masked, and rsv1"
        );
        return JSValueMakeUndefined(context);
    }

    uint8_t *payload = NULL;
    size_t payload_length = 0;
    uint8_t opcode = 0;
    if (!ct_websocket_get_bytes(
            context,
            arguments[0],
            &payload,
            &payload_length,
            exception,
            "WebSocket payload must be an ArrayBuffer or typed array"
        ) ||
        !ct_websocket_get_u8(
            context,
            arguments[1],
            &opcode,
            exception,
            "WebSocket opcode must be an unsigned byte"
        )) {
        return JSValueMakeUndefined(context);
    }

    const bool masked = JSValueToBoolean(context, arguments[2]);
    const bool rsv1 = JSValueToBoolean(context, arguments[3]);
    if ((opcode & 0x08) != 0 && payload_length > 125) {
        ct_throw_message(context, exception, "WebSocket control frame payload must not exceed 125 bytes");
        return JSValueMakeUndefined(context);
    }

    uint8_t mask[4] = { 0, 0, 0, 0 };
    if (masked) {
        if (argument_count >= 5 && !JSValueIsUndefined(context, arguments[4])) {
            uint8_t *provided_mask = NULL;
            size_t provided_mask_length = 0;
            if (!ct_websocket_get_bytes(
                    context,
                    arguments[4],
                    &provided_mask,
                    &provided_mask_length,
                    exception,
                    "WebSocket mask must be a four-byte ArrayBuffer or typed array"
                )) {
                return JSValueMakeUndefined(context);
            }
            if (provided_mask_length != sizeof(mask)) {
                ct_throw_type_error(context, exception, "WebSocket mask must contain exactly four bytes");
                return JSValueMakeUndefined(context);
            }
            memcpy(mask, provided_mask, sizeof(mask));
        } else if (ct_fill_random_bytes(mask, sizeof(mask)) != 0) {
            ct_throw_message(context, exception, strerror(errno));
            return JSValueMakeUndefined(context);
        }
    }

    const size_t header_length = payload_length < 126 ? 2 : payload_length <= UINT16_MAX ? 4 : 10;
    const size_t prefix_length = header_length + (masked ? sizeof(mask) : 0);
    if (payload_length > SIZE_MAX - prefix_length) {
        ct_throw_message(context, exception, "WebSocket frame is too large");
        return JSValueMakeUndefined(context);
    }
    const size_t output_length = prefix_length + payload_length;
    uint8_t *output = (uint8_t *)malloc(output_length > 0 ? output_length : 1);
    if (output == NULL) {
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }

    if (ct_websocket_frame_encode(
            output,
            output_length,
            payload,
            payload_length,
            opcode,
            rsv1 ? 1 : 0,
            masked ? 1 : 0,
            masked ? mask : NULL
        ) != 0) {
        free(output);
        ct_throw_message(context, exception, "Unable to encode WebSocket frame");
        return JSValueMakeUndefined(context);
    }

    char *owned_output = (char *)output;
    JSValueRef result = ct_array_buffer_take_owned_bytes(
        context,
        &owned_output,
        output_length,
        exception
    );
    if (owned_output != NULL) free(owned_output);
    return result;
}

static JSValueRef ct_websocket_unmask_copy_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 2) {
        ct_throw_type_error(context, exception, "websocketUnmaskCopy requires payload and mask");
        return JSValueMakeUndefined(context);
    }

    uint8_t *input = NULL;
    uint8_t *mask = NULL;
    size_t input_length = 0;
    size_t mask_length = 0;
    if (!ct_websocket_get_bytes(
            context,
            arguments[0],
            &input,
            &input_length,
            exception,
            "WebSocket payload must be an ArrayBuffer or typed array"
        ) ||
        !ct_websocket_get_bytes(
            context,
            arguments[1],
            &mask,
            &mask_length,
            exception,
            "WebSocket mask must be a four-byte ArrayBuffer or typed array"
        )) {
        return JSValueMakeUndefined(context);
    }
    if (mask_length != 4) {
        ct_throw_type_error(context, exception, "WebSocket mask must contain exactly four bytes");
        return JSValueMakeUndefined(context);
    }

    uint8_t *output = (uint8_t *)malloc(input_length > 0 ? input_length : 1);
    if (output == NULL) {
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    if (ct_websocket_unmask_copy(output, input, input_length, mask) != 0) {
        free(output);
        ct_throw_message(context, exception, "Unable to unmask WebSocket payload");
        return JSValueMakeUndefined(context);
    }

    char *owned_output = (char *)output;
    JSValueRef result = ct_array_buffer_take_owned_bytes(
        context,
        &owned_output,
        input_length,
        exception
    );
    if (owned_output != NULL) free(owned_output);
    return result;
}
