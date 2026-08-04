#include <cottontail-jsc-embedder.h>
#include "strip_ansi.h"

extern ptrdiff_t ct_string_width_latin1(
    const uint8_t *ptr,
    size_t len,
    bool exclude_ansi,
    bool ambiguous_as_wide
);
extern int ct_embedded_runtime_module_source(
    const uint8_t *path,
    size_t path_len,
    const uint8_t **source_out,
    size_t *source_len_out
);

static bool ct_direct_buffer_index(
    CtJscInvocation *invocation,
    CtJscEncodedValue value,
    size_t *result
) {
    const double number = ct_jsc_value_to_number(invocation, value);
    if (ct_jsc_invocation_has_exception(invocation) ||
        !isfinite(number) ||
        number < 0 ||
        floor(number) != number ||
        number > (double)SIZE_MAX) {
        return false;
    }
    *result = (size_t)number;
    return true;
}

static CtJscEncodedValue ct_direct_concat_http_body_chunks(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 1) {
        return ct_jsc_throw_type_error(invocation, "concatHttpBodyChunks requires an array");
    }

    JSContextRef context = ct_jsc_invocation_context_ref(invocation);
    JSValueRef chunks_value = ct_jsc_value_get_ref(
        invocation,
        ct_jsc_invocation_argument(invocation, 0)
    );
    if (!JSValueIsObject(context, chunks_value)) {
        return ct_jsc_throw_type_error(invocation, "concatHttpBodyChunks requires an array");
    }

    JSObjectRef chunks = (JSObjectRef)chunks_value;
    JSValueRef exception = NULL;
    JSValueRef length_value = ct_get_property(context, chunks, "length", &exception);
    if (exception != NULL) return ct_jsc_throw_value_ref(invocation, exception);
    const double length_number = JSValueToNumber(context, length_value, &exception);
    if (exception != NULL) return ct_jsc_throw_value_ref(invocation, exception);
    if (!isfinite(length_number) || length_number < 0 ||
        floor(length_number) != length_number || length_number > UINT32_MAX) {
        return ct_jsc_throw_type_error(invocation, "concatHttpBodyChunks received an invalid array length");
    }

    const uint32_t count = (uint32_t)length_number;
    size_t total = 0;
    for (uint32_t index = 0; index < count; index += 1) {
        JSValueRef value = JSObjectGetPropertyAtIndex(context, chunks, index, &exception);
        if (exception != NULL) return ct_jsc_throw_value_ref(invocation, exception);
        uint8_t *data = NULL;
        size_t length = 0;
        if (ct_get_bytes(context, value, &data, &length) != 0) {
            return ct_jsc_throw_type_error(
                invocation,
                "concatHttpBodyChunks entries must be ArrayBuffers or typed arrays"
            );
        }
        if (length > SIZE_MAX - total) {
            return ct_jsc_throw_error(invocation, "concatHttpBodyChunks result is too large");
        }
        total += length;
    }

    char *output = ct_http_body_chunk_alloc(total);
    if (total > 0 && output == NULL) return ct_jsc_throw_error(invocation, "Out of memory");
    size_t offset = 0;
    for (uint32_t index = 0; index < count; index += 1) {
        JSValueRef value = JSObjectGetPropertyAtIndex(context, chunks, index, &exception);
        if (exception != NULL) {
            ct_http_body_chunk_free(output, total);
            return ct_jsc_throw_value_ref(invocation, exception);
        }
        uint8_t *data = NULL;
        size_t length = 0;
        if (ct_get_bytes(context, value, &data, &length) != 0 || length > total - offset) {
            ct_http_body_chunk_free(output, total);
            return ct_jsc_throw_type_error(
                invocation,
                "concatHttpBodyChunks entries changed while being read"
            );
        }
        if (length > 0) memcpy(output + offset, data, length);
        offset += length;
    }
    if (offset != total) {
        ct_http_body_chunk_free(output, total);
        return ct_jsc_throw_type_error(
            invocation,
            "concatHttpBodyChunks entries changed while being read"
        );
    }

    JSValueRef result = ct_array_buffer_take_http_body_chunk(
        context,
        &output,
        total,
        &exception
    );
    ct_http_body_chunk_free(output, total);
    if (exception != NULL) return ct_jsc_throw_value_ref(invocation, exception);
    return ct_jsc_value_from_ref(invocation, result);
}

static CtJscEncodedValue ct_direct_buffer_compare(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 6) {
        return ct_jsc_throw_type_error(
            invocation,
            "bufferCompare requires two typed arrays and four indexes"
        );
    }
    CtJscBytesView left;
    CtJscBytesView right;
    size_t left_start;
    size_t left_end;
    size_t right_start;
    size_t right_end;
    if (!ct_jsc_value_get_bytes_view(invocation, ct_jsc_invocation_argument(invocation, 0), &left) ||
        !ct_direct_buffer_index(invocation, ct_jsc_invocation_argument(invocation, 1), &left_start) ||
        !ct_direct_buffer_index(invocation, ct_jsc_invocation_argument(invocation, 2), &left_end) ||
        !ct_jsc_value_get_bytes_view(invocation, ct_jsc_invocation_argument(invocation, 3), &right) ||
        !ct_direct_buffer_index(invocation, ct_jsc_invocation_argument(invocation, 4), &right_start) ||
        !ct_direct_buffer_index(invocation, ct_jsc_invocation_argument(invocation, 5), &right_end)) {
        if (ct_jsc_invocation_has_exception(invocation)) return ct_jsc_make_undefined(invocation);
        return ct_jsc_throw_type_error(
            invocation,
            "Native Buffer operation received invalid arguments"
        );
    }
    if (left_start > left_end || left_end > left.length ||
        right_start > right_end || right_end > right.length) {
        return ct_jsc_throw_type_error(
            invocation,
            "Native Buffer compare range is out of bounds"
        );
    }
    return ct_jsc_make_int32(
        invocation,
        ct_buffer_compare(
            left.data != NULL ? left.data + left_start : NULL,
            left_end - left_start,
            right.data != NULL ? right.data + right_start : NULL,
            right_end - right_start
        )
    );
}

static CtJscEncodedValue ct_direct_buffer_index_of(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 4) {
        return ct_jsc_throw_type_error(
            invocation,
            "bufferIndexOf requires haystack, needle, offset, and direction"
        );
    }
    CtJscBytesView haystack;
    CtJscBytesView needle;
    size_t offset;
    if (!ct_jsc_value_get_bytes_view(invocation, ct_jsc_invocation_argument(invocation, 0), &haystack) ||
        !ct_jsc_value_get_bytes_view(invocation, ct_jsc_invocation_argument(invocation, 1), &needle) ||
        !ct_direct_buffer_index(invocation, ct_jsc_invocation_argument(invocation, 2), &offset)) {
        if (ct_jsc_invocation_has_exception(invocation)) return ct_jsc_make_undefined(invocation);
        return ct_jsc_throw_type_error(
            invocation,
            "Native Buffer operation received invalid arguments"
        );
    }
    if (offset > haystack.length) {
        return ct_jsc_throw_type_error(
            invocation,
            "Native Buffer search arguments are out of bounds"
        );
    }
    return ct_jsc_make_number(
        invocation,
        (double)ct_buffer_index_of(
            haystack.data,
            haystack.length,
            needle.data,
            needle.length,
            offset,
            ct_jsc_value_to_boolean(
                invocation,
                ct_jsc_invocation_argument(invocation, 3)
            ) ? 1 : 0
        )
    );
}

static CtJscEncodedValue ct_direct_buffer_index_of_line(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 3) {
        return ct_jsc_throw_type_error(
            invocation,
            "bufferIndexOfLine requires a buffer, offset, and end"
        );
    }
    CtJscBytesView buffer;
    size_t offset;
    size_t end;
    if (!ct_jsc_value_get_bytes_view(invocation, ct_jsc_invocation_argument(invocation, 0), &buffer) ||
        !ct_direct_buffer_index(invocation, ct_jsc_invocation_argument(invocation, 1), &offset) ||
        !ct_direct_buffer_index(invocation, ct_jsc_invocation_argument(invocation, 2), &end)) {
        if (ct_jsc_invocation_has_exception(invocation)) return ct_jsc_make_undefined(invocation);
        return ct_jsc_throw_type_error(
            invocation,
            "Native Buffer operation received invalid arguments"
        );
    }
    if (offset >= end || offset >= buffer.length) {
        return ct_jsc_make_int32(invocation, -1);
    }
    if (end > buffer.length) end = buffer.length;
    return ct_jsc_make_number(
        invocation,
        (double)ct_buffer_index_of_line(buffer.data, end, offset)
    );
}

static CtJscEncodedValue ct_direct_buffer_fill_pattern(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 4) {
        return ct_jsc_throw_type_error(
            invocation,
            "bufferFillPattern requires target, pattern, start, and end"
        );
    }
    CtJscBytesView target;
    CtJscBytesView pattern;
    size_t start;
    size_t end;
    if (!ct_jsc_value_get_bytes_view(invocation, ct_jsc_invocation_argument(invocation, 0), &target) ||
        !ct_jsc_value_get_bytes_view(invocation, ct_jsc_invocation_argument(invocation, 1), &pattern) ||
        !ct_direct_buffer_index(invocation, ct_jsc_invocation_argument(invocation, 2), &start) ||
        !ct_direct_buffer_index(invocation, ct_jsc_invocation_argument(invocation, 3), &end)) {
        if (ct_jsc_invocation_has_exception(invocation)) return ct_jsc_make_undefined(invocation);
        return ct_jsc_throw_type_error(
            invocation,
            "Native Buffer operation received invalid arguments"
        );
    }
    if (start > end || end > target.length || pattern.length == 0) {
        return ct_jsc_throw_type_error(
            invocation,
            "Native Buffer fill arguments are out of bounds"
        );
    }
    const int status = ct_buffer_fill_pattern(
        target.data != NULL ? (uint8_t *)target.data + start : NULL,
        end - start,
        pattern.data,
        pattern.length
    );
    if (status == -2) return ct_jsc_throw_error(invocation, "Out of memory");
    if (status != 0) return ct_jsc_throw_type_error(invocation, "Native Buffer fill failed");
    return ct_jsc_invocation_argument(invocation, 0);
}

static bool ct_direct_unsigned_byte(
    CtJscInvocation *invocation,
    CtJscEncodedValue value,
    uint8_t *result
) {
    const double number = ct_jsc_value_to_number(invocation, value);
    if (ct_jsc_invocation_has_exception(invocation) ||
        !isfinite(number) || number < 0 || number > UINT8_MAX || floor(number) != number) {
        return false;
    }
    *result = (uint8_t)number;
    return true;
}

static CtJscEncodedValue ct_direct_websocket_frame_encode(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 4) {
        return ct_jsc_throw_type_error(
            invocation,
            "websocketFrameEncode requires payload, opcode, masked, and rsv1"
        );
    }
    CtJscBytesView payload;
    uint8_t opcode;
    if (!ct_jsc_value_get_bytes_view(invocation, ct_jsc_invocation_argument(invocation, 0), &payload) ||
        !ct_direct_unsigned_byte(invocation, ct_jsc_invocation_argument(invocation, 1), &opcode)) {
        if (ct_jsc_invocation_has_exception(invocation)) return ct_jsc_make_undefined(invocation);
        return ct_jsc_throw_type_error(invocation, "Invalid WebSocket frame arguments");
    }
    const bool masked = ct_jsc_value_to_boolean(
        invocation,
        ct_jsc_invocation_argument(invocation, 2)
    );
    const bool rsv1 = ct_jsc_value_to_boolean(
        invocation,
        ct_jsc_invocation_argument(invocation, 3)
    );
    if ((opcode & 0x08) != 0 && payload.length > 125) {
        return ct_jsc_throw_error(
            invocation,
            "WebSocket control frame payload must not exceed 125 bytes"
        );
    }

    uint8_t mask[4] = {0};
    if (masked) {
        if (ct_jsc_invocation_argument_count(invocation) >= 5 &&
            !ct_jsc_value_is_undefined(ct_jsc_invocation_argument(invocation, 4))) {
            CtJscBytesView provided;
            if (!ct_jsc_value_get_bytes_view(
                    invocation,
                    ct_jsc_invocation_argument(invocation, 4),
                    &provided
                ) || provided.length != sizeof(mask)) {
                return ct_jsc_throw_type_error(
                    invocation,
                    "WebSocket mask must contain exactly four bytes"
                );
            }
            memcpy(mask, provided.data, sizeof(mask));
        } else if (ct_fill_random_bytes(mask, sizeof(mask)) != 0) {
            return ct_jsc_throw_error(invocation, strerror(errno));
        }
    }

    const size_t header_length = payload.length < 126 ? 2 : payload.length <= UINT16_MAX ? 4 : 10;
    const size_t prefix_length = header_length + (masked ? sizeof(mask) : 0);
    if (payload.length > SIZE_MAX - prefix_length) {
        return ct_jsc_throw_error(invocation, "WebSocket frame is too large");
    }
    CtJscMutableBytesView output;
    CtJscEncodedValue result = ct_jsc_make_uint8_array_uninitialized(
        invocation,
        prefix_length + payload.length,
        &output
    );
    if (output.data == NULL && output.length != 0) {
        return ct_jsc_throw_error(invocation, "Out of memory");
    }
    if (ct_websocket_frame_encode(
            output.data,
            output.length,
            payload.data,
            payload.length,
            opcode,
            rsv1 ? 1 : 0,
            masked ? 1 : 0,
            masked ? mask : NULL
        ) != 0) {
        return ct_jsc_throw_error(invocation, "Unable to encode WebSocket frame");
    }
    return result;
}

static CtJscEncodedValue ct_direct_websocket_unmask_copy(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 2) {
        return ct_jsc_throw_type_error(
            invocation,
            "websocketUnmaskCopy requires payload and mask"
        );
    }
    CtJscBytesView input;
    CtJscBytesView mask;
    if (!ct_jsc_value_get_bytes_view(invocation, ct_jsc_invocation_argument(invocation, 0), &input) ||
        !ct_jsc_value_get_bytes_view(invocation, ct_jsc_invocation_argument(invocation, 1), &mask)) {
        return ct_jsc_throw_type_error(
            invocation,
            "WebSocket payload and mask must be typed arrays"
        );
    }
    if (mask.length != 4) {
        return ct_jsc_throw_type_error(
            invocation,
            "WebSocket mask must contain exactly four bytes"
        );
    }
    CtJscMutableBytesView output;
    CtJscEncodedValue result = ct_jsc_make_uint8_array_uninitialized(
        invocation,
        input.length,
        &output
    );
    if (output.data == NULL && output.length != 0) {
        return ct_jsc_throw_error(invocation, "Out of memory");
    }
    if (ct_websocket_unmask_copy(output.data, input.data, input.length, mask.data) != 0) {
        return ct_jsc_throw_error(invocation, "Unable to unmask WebSocket payload");
    }
    return result;
}

static CtJscEncodedValue ct_direct_which_path_native(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 5) {
        return ct_jsc_throw_type_error(
            invocation,
            "whichPathNative(path, cwd, bin, systemRoot, canonicalSystemRoot) requires five strings"
        );
    }

    CtJscUtf8View values[5];
    for (size_t index = 0; index < 5; index += 1) {
        if (ct_jsc_value_to_utf8_view(
                invocation,
                ct_jsc_invocation_argument(invocation, index),
                &values[index]
            )) {
            continue;
        }
        if (ct_jsc_invocation_has_exception(invocation)) {
            return ct_jsc_make_undefined(invocation);
        }
        return ct_jsc_throw_error(invocation, "Unable to encode executable search input");
    }

    CtWhichResult output = {0};
    const int status = ct_which_core_find_on_path(
        (CtWhichSlice){ .ptr = (const char *)values[0].data, .len = values[0].length },
        (CtWhichSlice){ .ptr = (const char *)values[1].data, .len = values[1].length },
        (CtWhichSlice){ .ptr = (const char *)values[2].data, .len = values[2].length },
        (CtWhichSlice){ .ptr = (const char *)values[3].data, .len = values[3].length },
        (CtWhichSlice){ .ptr = (const char *)values[4].data, .len = values[4].length },
        &output
    );
    if (status != 0) {
        ct_which_core_free((void *)output.ptr, output.len);
        return ct_jsc_throw_error(invocation, "Native executable search failed");
    }
    if (output.ptr == NULL) return ct_jsc_make_null(invocation);

    CtJscEncodedValue result = ct_jsc_make_utf8_string(
        invocation,
        (const uint8_t *)output.ptr,
        output.len
    );
    ct_which_core_free((void *)output.ptr, output.len);
    return result;
}

static CtJscEncodedValue ct_direct_path_normalize_native(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 2) {
        return ct_jsc_throw_type_error(
            invocation,
            "pathNormalizeNative(windows, path) requires a path"
        );
    }

    CtJscStringView input;
    if (!ct_jsc_value_to_string_view(
            invocation,
            ct_jsc_invocation_argument(invocation, 1),
            &input
        )) {
        return ct_jsc_invocation_has_exception(invocation)
            ? ct_jsc_make_undefined(invocation)
            : ct_jsc_throw_error(invocation, "Unable to read path input");
    }

    uint16_t *widened = NULL;
    const uint16_t *characters = (const uint16_t *)input.data;
    if (input.encoding == CT_JSC_STRING_LATIN1 && input.length > 0) {
        if (input.length > SIZE_MAX / sizeof(uint16_t)) {
            return ct_jsc_throw_error(invocation, "Path input is too large");
        }
        widened = (uint16_t *)malloc(input.length * sizeof(uint16_t));
        if (widened == NULL) return ct_jsc_throw_error(invocation, "Out of memory");
        for (size_t index = 0; index < input.length; index += 1) {
            widened[index] = ((const uint8_t *)input.data)[index];
        }
        characters = widened;
    }

    CtPathResult output = {0};
    const int status = ct_path_core_normalize(
        ct_jsc_value_to_boolean(
            invocation,
            ct_jsc_invocation_argument(invocation, 0)
        ) ? 1 : 0,
        (CtPathSlice){ .ptr = characters, .len = input.length },
        &output
    );
    free(widened);
    if (status != 0) {
        ct_path_core_free((void *)output.ptr, output.len);
        return ct_jsc_throw_error(invocation, "Native path normalization failed");
    }
    CtJscEncodedValue result = ct_jsc_make_utf16_string(
        invocation,
        output.ptr,
        output.len
    );
    ct_path_core_free((void *)output.ptr, output.len);
    return result;
}

static CtJscEncodedValue ct_direct_mime_type_by_extension(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 1 ||
        !ct_jsc_value_is_string(ct_jsc_invocation_argument(invocation, 0))) {
        return ct_jsc_throw_type_error(
            invocation,
            "mimeTypeByExtension(extension) requires a string"
        );
    }

    CtJscStringView extension;
    if (!ct_jsc_value_get_string_view(
            invocation,
            ct_jsc_invocation_argument(invocation, 0),
            &extension
        )) {
        return ct_jsc_make_undefined(invocation);
    }

    static const uint8_t fallback[] = "application/octet-stream";
    if (extension.encoding != CT_JSC_STRING_LATIN1 || extension.length > 64) {
        return ct_jsc_make_latin1_string(
            invocation,
            fallback,
            sizeof(fallback) - 1
        );
    }
    const uint8_t *bytes = (const uint8_t *)extension.data;
    for (size_t index = 0; index < extension.length; index += 1) {
        if (bytes[index] <= 0x7f) continue;
        return ct_jsc_make_latin1_string(
            invocation,
            fallback,
            sizeof(fallback) - 1
        );
    }

    size_t result_length = 0;
    const uint8_t *result = ct_host_mime_type_by_extension(
        bytes,
        extension.length,
        &result_length
    );
    return ct_jsc_make_latin1_string(invocation, result, result_length);
}

static CtJscEncodedValue ct_direct_text_encoding_lookup(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 1) {
        return ct_jsc_throw_type_error(invocation, "textEncodingLookup requires a label");
    }

    CtJscStringView label;
    if (!ct_jsc_value_to_string_view(
            invocation,
            ct_jsc_invocation_argument(invocation, 0),
            &label
        )) {
        return ct_jsc_invocation_has_exception(invocation)
            ? ct_jsc_make_undefined(invocation)
            : ct_jsc_throw_error(invocation, "Unable to read text encoding label");
    }

    int encoding = -1;
    if (label.encoding == CT_JSC_STRING_LATIN1) {
        encoding = ct_text_encoding_lookup(
            (const uint8_t *)label.data,
            label.length
        );
    }
    return ct_jsc_make_int32(invocation, encoding);
}

static CtJscEncodedValue ct_direct_text_decode(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 2) {
        return ct_jsc_throw_type_error(
            invocation,
            "textDecode requires an encoding and bytes"
        );
    }

    const double encoding_number = ct_jsc_value_to_number(
        invocation,
        ct_jsc_invocation_argument(invocation, 0)
    );
    if (ct_jsc_invocation_has_exception(invocation)) {
        return ct_jsc_make_undefined(invocation);
    }
    if (!isfinite(encoding_number) ||
        floor(encoding_number) != encoding_number ||
        encoding_number < 0 ||
        encoding_number >= CT_TEXT_ENCODING_COUNT) {
        return ct_jsc_throw_type_error(
            invocation,
            "textDecode received an invalid encoding"
        );
    }

    CtJscBytesView bytes;
    if (!ct_jsc_value_get_bytes_view(
            invocation,
            ct_jsc_invocation_argument(invocation, 1),
            &bytes
        )) {
        return ct_jsc_throw_type_error(
            invocation,
            "textDecode requires an ArrayBuffer or typed array"
        );
    }

    const size_t argument_count = ct_jsc_invocation_argument_count(invocation);
    const bool fatal = argument_count >= 3 && ct_jsc_value_to_boolean(
        invocation,
        ct_jsc_invocation_argument(invocation, 2)
    );
    const bool strip_bom = argument_count >= 4 && ct_jsc_value_to_boolean(
        invocation,
        ct_jsc_invocation_argument(invocation, 3)
    );
    const CtTextEncoding encoding = (CtTextEncoding)(int)encoding_number;
    if (encoding == CT_TEXT_ENCODING_UTF8) {
        bool is_ascii = true;
        for (size_t index = 0; index < bytes.length; index += 1) {
            if (bytes.data[index] > 0x7f) {
                is_ascii = false;
                break;
            }
        }
        if (is_ascii) {
            return ct_jsc_make_latin1_string(invocation, bytes.data, bytes.length);
        }
    }
    JSContextRef context = ct_jsc_invocation_context_ref(invocation);
    JSValueRef exception = NULL;
    JSValueRef result = NULL;
    if (encoding == CT_TEXT_ENCODING_X_USER_DEFINED) {
        result = ct_text_decode_x_user_defined(
            context,
            bytes.data,
            bytes.length,
            &exception
        );
    } else if (encoding == CT_TEXT_ENCODING_REPLACEMENT) {
        result = bytes.length == 0
            ? ct_make_string(context, "")
            : ct_make_string(context, "\xef\xbf\xbd");
    } else {
        result = ct_text_decode_indexed_single_byte(
            context,
            encoding,
            bytes.data,
            bytes.length,
            fatal,
            &exception
        );
        if (exception == NULL && JSValueIsNull(context, result)) {
            result = ct_text_decode_with_icu(
                context,
                encoding,
                bytes.data,
                bytes.length,
                fatal,
                strip_bom,
                &exception
            );
        }
    }
    if (exception != NULL) {
        return ct_jsc_throw_value_ref(invocation, exception);
    }
    return ct_jsc_value_from_ref(invocation, result);
}

static CtJscEncodedValue ct_direct_text_encode(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    CtJscStringView input = {0};
    if (ct_jsc_invocation_argument_count(invocation) >= 1 &&
        !ct_jsc_value_to_string_view(
            invocation,
            ct_jsc_invocation_argument(invocation, 0),
            &input
        )) {
        return ct_jsc_invocation_has_exception(invocation)
            ? ct_jsc_make_undefined(invocation)
            : ct_jsc_throw_error(invocation, "Unable to read TextEncoder input");
    }

    size_t byte_length = 0;
    if (input.length > 0) {
        byte_length = input.encoding == CT_JSC_STRING_LATIN1
            ? ct_text_encoding_utf8_length_latin1(
                (const uint8_t *)input.data,
                input.length
            )
            : ct_text_encoding_utf8_length_utf16(
                (const uint16_t *)input.data,
                input.length
            );
    }

    CtJscMutableBytesView output;
    CtJscEncodedValue result = ct_jsc_make_uint8_array_uninitialized(
        invocation,
        byte_length,
        &output
    );
    if (byte_length == 0) return result;
    if (output.data == NULL || output.length != byte_length) {
        return ct_jsc_throw_error(invocation, "Out of memory");
    }

    const size_t written = input.encoding == CT_JSC_STRING_LATIN1
        ? ct_text_encoding_encode_latin1(
            (const uint8_t *)input.data,
            input.length,
            output.data,
            output.length
        )
        : ct_text_encoding_encode_utf16(
            (const uint16_t *)input.data,
            input.length,
            output.data,
            output.length
        );
    if (written != byte_length) {
        return ct_jsc_throw_error(invocation, "Failed to encode text input");
    }
    return result;
}

static void ct_direct_glob_matcher_finalize(void *user_data) {
    CtGlobMatcher *matcher = (CtGlobMatcher *)user_data;
    if (matcher == NULL) return;
    free(matcher->pattern);
    free(matcher);
}

static CtJscEncodedValue ct_direct_glob_matcher_call(
    CtJscInvocation *invocation,
    void *user_data
) {
    CtGlobMatcher *matcher = (CtGlobMatcher *)user_data;
    if (matcher == NULL) {
        return ct_jsc_throw_type_error(
            invocation,
            "Native Glob matcher is no longer valid"
        );
    }
    if (ct_jsc_invocation_argument_count(invocation) < 1 ||
        !ct_jsc_value_is_string(ct_jsc_invocation_argument(invocation, 0))) {
        return ct_jsc_throw_type_error(invocation, "Glob.match expects a string");
    }

    CtJscUtf8View path;
    if (!ct_jsc_value_get_utf8_view(
            invocation,
            ct_jsc_invocation_argument(invocation, 0),
            &path
        )) {
        return ct_jsc_invocation_has_exception(invocation)
            ? ct_jsc_make_undefined(invocation)
            : ct_jsc_throw_error(invocation, "Unable to encode Glob path");
    }
    return ct_jsc_make_boolean(
        invocation,
        ct_glob_match(
            matcher->pattern,
            matcher->pattern_length,
            path.data,
            path.length
        )
    );
}

static CtJscEncodedValue ct_direct_glob_compile(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 1 ||
        !ct_jsc_value_is_string(ct_jsc_invocation_argument(invocation, 0))) {
        return ct_jsc_throw_type_error(invocation, "Glob pattern must be a string");
    }

    CtJscUtf8View pattern;
    if (!ct_jsc_value_get_utf8_view(
            invocation,
            ct_jsc_invocation_argument(invocation, 0),
            &pattern
        )) {
        return ct_jsc_invocation_has_exception(invocation)
            ? ct_jsc_make_undefined(invocation)
            : ct_jsc_throw_error(invocation, "Unable to encode Glob pattern");
    }

    CtGlobMatcher *matcher = (CtGlobMatcher *)calloc(1, sizeof(CtGlobMatcher));
    if (matcher != NULL) {
        matcher->pattern = (uint8_t *)malloc(pattern.length > 0 ? pattern.length : 1);
    }
    if (matcher == NULL || matcher->pattern == NULL) {
        ct_direct_glob_matcher_finalize(matcher);
        return ct_jsc_throw_error(invocation, "Out of memory");
    }
    if (pattern.length > 0) {
        memcpy(matcher->pattern, pattern.data, pattern.length);
    }
    matcher->pattern_length = pattern.length;

    JSObjectRef function = ct_jsc_embedder_create_function_with_finalizer(
        ct_jsc_invocation_context_ref(invocation),
        "match",
        1,
        ct_direct_glob_matcher_call,
        matcher,
        ct_direct_glob_matcher_finalize
    );
    if (function == NULL) {
        return ct_jsc_throw_error(invocation, "Unable to create native Glob matcher");
    }
    return ct_jsc_value_from_ref(invocation, function);
}

static CtJscEncodedValue ct_direct_strip_ansi(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 1) {
        return ct_jsc_make_latin1_string(invocation, (const uint8_t *)"", 0);
    }

    const CtJscEncodedValue value = ct_jsc_invocation_argument(invocation, 0);
    CtJscStringView input;
    if (!ct_jsc_value_to_string_view(invocation, value, &input)) {
        return ct_jsc_invocation_has_exception(invocation)
            ? ct_jsc_make_undefined(invocation)
            : ct_jsc_throw_error(invocation, "Unable to read stripANSI input");
    }

    if (input.encoding == CT_JSC_STRING_LATIN1) {
        CtStripAnsiLatin1Result output;
        const int status = ct_strip_ansi_latin1(
            (const uint8_t *)input.data,
            input.length,
            &output
        );
        if (status < 0) return ct_jsc_throw_error(invocation, "Out of memory");
        if (status == 0) {
            return ct_jsc_value_is_string(value)
                ? value
                : ct_jsc_make_latin1_string(
                    invocation,
                    (const uint8_t *)input.data,
                    input.length
                );
        }
        CtJscEncodedValue result = ct_jsc_make_latin1_string(
            invocation,
            output.ptr,
            output.len
        );
        ct_strip_ansi_free_latin1((uint8_t *)output.ptr, output.capacity);
        return result;
    }

    CtStripAnsiUtf16Result output;
    const int status = ct_strip_ansi_utf16(
        (const uint16_t *)input.data,
        input.length,
        &output
    );
    if (status < 0) return ct_jsc_throw_error(invocation, "Out of memory");
    if (status == 0) {
        return ct_jsc_value_is_string(value)
            ? value
            : ct_jsc_make_utf16_string(
                invocation,
                (const uint16_t *)input.data,
                input.length
            );
    }
    CtJscEncodedValue result = ct_jsc_make_utf16_string(
        invocation,
        output.ptr,
        output.len
    );
    ct_strip_ansi_free_utf16((uint16_t *)output.ptr, output.capacity);
    return result;
}

static CtJscEncodedValue ct_direct_string_width_native(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 3) {
        return ct_jsc_throw_type_error(
            invocation,
            "stringWidthNative expects a string and two boolean options"
        );
    }

    CtJscStringView string;
    if (!ct_jsc_value_get_string_view(
            invocation,
            ct_jsc_invocation_argument(invocation, 0),
            &string
        )) {
        return ct_jsc_throw_type_error(
            invocation,
            "stringWidthNative expects a string and two boolean options"
        );
    }

    const bool exclude_ansi = !ct_jsc_value_to_boolean(
        invocation,
        ct_jsc_invocation_argument(invocation, 1)
    );
    const bool ambiguous_as_wide = !ct_jsc_value_to_boolean(
        invocation,
        ct_jsc_invocation_argument(invocation, 2)
    );
    const ptrdiff_t width = string.encoding == CT_JSC_STRING_LATIN1
        ? ct_string_width_latin1(
            (const uint8_t *)string.data,
            string.length,
            exclude_ansi,
            ambiguous_as_wide
        )
        : ct_string_width_utf16(
            (const uint16_t *)string.data,
            string.length,
            exclude_ansi,
            ambiguous_as_wide
        );
    return ct_jsc_make_number(invocation, (double)width);
}

static bool ct_direct_uuid_encoding(
    CtJscInvocation *invocation,
    CtJscEncodedValue value,
    uint8_t *encoding
) {
    if (!ct_jsc_value_is_number(value)) return false;
    const double number = ct_jsc_value_to_number(invocation, value);
    if (ct_jsc_invocation_has_exception(invocation) ||
        number < 0 ||
        number > 3 ||
        number != (double)(uint8_t)number) {
        return false;
    }
    *encoding = (uint8_t)number;
    return true;
}

static CtJscEncodedValue ct_direct_uuid_result(
    CtJscInvocation *invocation,
    const uint8_t uuid[16],
    uint8_t encoding
) {
    if (encoding == 1) {
        return ct_jsc_make_uint8_array_copy(invocation, uuid, 16);
    }
    uint8_t formatted[36];
    const size_t length = ct_uuid_format(encoding, uuid, formatted);
    if (length == 0) {
        return ct_jsc_throw_type_error(invocation, "Invalid native UUID encoding");
    }
    return ct_jsc_make_latin1_string(invocation, formatted, length);
}

static CtJscEncodedValue ct_direct_random_uuid_v7_native(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 2) {
        return ct_jsc_throw_type_error(
            invocation,
            "randomUUIDv7Native(timestamp, encoding) requires a timestamp"
        );
    }
    const CtJscEncodedValue timestamp_value = ct_jsc_invocation_argument(invocation, 0);
    if (!ct_jsc_value_is_number(timestamp_value)) {
        return ct_jsc_throw_type_error(
            invocation,
            "randomUUIDv7Native(timestamp, encoding) requires a timestamp"
        );
    }
    uint8_t encoding = 0;
    if (!ct_direct_uuid_encoding(
            invocation,
            ct_jsc_invocation_argument(invocation, 1),
            &encoding
        )) {
        return ct_jsc_throw_type_error(invocation, "Invalid native UUID encoding");
    }
    const double timestamp = ct_jsc_value_to_number(invocation, timestamp_value);
    if (ct_jsc_invocation_has_exception(invocation)) {
        return ct_jsc_make_undefined(invocation);
    }
    uint8_t uuid[16];
    ct_uuid_v7((uint64_t)timestamp, uuid);
    return ct_direct_uuid_result(invocation, uuid, encoding);
}

static CtJscEncodedValue ct_direct_random_uuid_v5_native(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 3) {
        return ct_jsc_throw_type_error(
            invocation,
            "randomUUIDv5Native(name, namespace, encoding) requires three arguments"
        );
    }

    uint8_t encoding = 0;
    if (!ct_direct_uuid_encoding(
            invocation,
            ct_jsc_invocation_argument(invocation, 2),
            &encoding
        )) {
        return ct_jsc_throw_type_error(invocation, "Invalid native UUID encoding");
    }

    CtJscBytesView namespace_bytes;
    if (!ct_jsc_value_get_bytes_view(
            invocation,
            ct_jsc_invocation_argument(invocation, 1),
            &namespace_bytes
        ) || namespace_bytes.length != 16) {
        return ct_jsc_throw_type_error(invocation, "Invalid native UUID namespace");
    }

    const CtJscEncodedValue name_value = ct_jsc_invocation_argument(invocation, 0);
    uint8_t uuid[16];
    if (ct_jsc_value_is_string(name_value)) {
        CtJscStringView name;
        if (!ct_jsc_value_get_string_view(invocation, name_value, &name)) {
            return ct_jsc_make_undefined(invocation);
        }
        if (name.encoding == CT_JSC_STRING_LATIN1) {
            ct_uuid_v5_latin1(
                (CtUuidSlice){ .ptr = namespace_bytes.data, .len = namespace_bytes.length },
                (CtUuidSlice){ .ptr = (const uint8_t *)name.data, .len = name.length },
                uuid
            );
        } else {
            ct_uuid_v5_utf16(
                (CtUuidSlice){ .ptr = namespace_bytes.data, .len = namespace_bytes.length },
                (CtUuidUtf16Slice){ .ptr = (const uint16_t *)name.data, .len = name.length },
                uuid
            );
        }
    } else {
        CtJscBytesView name;
        if (!ct_jsc_value_get_bytes_view(invocation, name_value, &name)) {
            return ct_jsc_throw_type_error(invocation, "Invalid native UUID name");
        }
        ct_uuid_v5(
            (CtUuidSlice){ .ptr = namespace_bytes.data, .len = namespace_bytes.length },
            (CtUuidSlice){ .ptr = name.data, .len = name.length },
            uuid
        );
    }
    return ct_direct_uuid_result(invocation, uuid, encoding);
}

static CtJscEncodedValue ct_direct_crypto_hasher_update(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 2) {
        return ct_jsc_throw_type_error(
            invocation,
            "cryptoHasherUpdate requires a handle and input"
        );
    }

    const CtJscEncodedValue handle_value = ct_jsc_invocation_argument(invocation, 0);
    JSContextRef context = ct_jsc_invocation_context_ref(invocation);
    JSValueRef handle_ref = ct_jsc_value_get_ref(invocation, handle_value);
    CtCryptoHasherState *state = ct_crypto_hasher_from_value(context, handle_ref);
    CtJscBytesView bytes;
    if (state == NULL || !ct_jsc_value_get_bytes_view(
            invocation,
            ct_jsc_invocation_argument(invocation, 1),
            &bytes
        )) {
        return ct_jsc_throw_type_error(invocation, "Invalid native CryptoHasher update");
    }
#if CT_HAS_OPENSSL
    if (!ct_crypto_hasher_state_update(state, bytes.data, bytes.length)) {
        return ct_jsc_throw_error(invocation, "Digest operation failed");
    }
    return ct_jsc_make_undefined(invocation);
#else
    return ct_jsc_throw_error(invocation, "Native incremental hashing is unavailable");
#endif
}

static CtJscEncodedValue ct_direct_crypto_hasher_create(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 1) {
        return ct_jsc_throw_type_error(
            invocation,
            "cryptoHasherCreate requires an algorithm"
        );
    }

    CtJscUtf8View algorithm;
    if (!ct_jsc_value_to_utf8_view(
            invocation,
            ct_jsc_invocation_argument(invocation, 0),
            &algorithm
        )) {
        return ct_jsc_invocation_has_exception(invocation)
            ? ct_jsc_make_undefined(invocation)
            : ct_jsc_throw_error(invocation, "Unable to read CryptoHasher algorithm");
    }
    if (algorithm.length >= 128) return ct_jsc_make_null(invocation);
    char algorithm_name[128];
    if (algorithm.length > 0) {
        memcpy(algorithm_name, algorithm.data, algorithm.length);
    }
    algorithm_name[algorithm.length] = '\0';

    const size_t argument_count = ct_jsc_invocation_argument_count(invocation);
    const bool keyed = argument_count >= 2 && !ct_jsc_value_is_undefined(
        ct_jsc_invocation_argument(invocation, 1)
    );
    CtJscBytesView key = {0};
    if (keyed && !ct_jsc_value_get_bytes_view(
            invocation,
            ct_jsc_invocation_argument(invocation, 1),
            &key
        )) {
        return ct_jsc_throw_type_error(
            invocation,
            "CryptoHasher key must be an ArrayBuffer or typed array"
        );
    }

#if CT_HAS_OPENSSL
    CtCryptoHasherState *state = ct_crypto_hasher_state_create(
        algorithm_name,
        key.data,
        key.length,
        keyed
    );
#else
    CtCryptoHasherState *state = NULL;
#endif
    if (state == NULL) return ct_jsc_make_null(invocation);

    uv_once(&ct_crypto_hasher_class_once, ct_crypto_hasher_initialize_class);
    JSObjectRef token = JSObjectMake(
        ct_jsc_invocation_context_ref(invocation),
        ct_crypto_hasher_class,
        state
    );
    if (token == NULL) {
        ct_crypto_hasher_state_free(state);
        return ct_jsc_throw_error(invocation, "Failed to create native CryptoHasher");
    }
    return ct_jsc_value_from_ref(invocation, token);
}

static CtJscEncodedValue ct_direct_crypto_hasher_copy(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 1) {
        return ct_jsc_throw_type_error(invocation, "cryptoHasherCopy requires a handle");
    }
    JSContextRef context = ct_jsc_invocation_context_ref(invocation);
    CtCryptoHasherState *state = ct_crypto_hasher_from_value(
        context,
        ct_jsc_value_get_ref(invocation, ct_jsc_invocation_argument(invocation, 0))
    );
#if CT_HAS_OPENSSL
    CtCryptoHasherState *copy = ct_crypto_hasher_state_copy(state);
#else
    CtCryptoHasherState *copy = NULL;
#endif
    if (copy == NULL) {
        return ct_jsc_throw_error(invocation, "Unable to copy native CryptoHasher");
    }
    JSObjectRef token = JSObjectMake(context, ct_crypto_hasher_class, copy);
    if (token == NULL) {
        ct_crypto_hasher_state_free(copy);
        return ct_jsc_throw_error(invocation, "Failed to create native CryptoHasher copy");
    }
    return ct_jsc_value_from_ref(invocation, token);
}

static CtJscEncodedValue ct_direct_crypto_hasher_digest(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 2) {
        return ct_jsc_throw_type_error(
            invocation,
            "cryptoHasherDigest requires a handle and output kind"
        );
    }
    JSContextRef context = ct_jsc_invocation_context_ref(invocation);
    CtCryptoHasherState *state = ct_crypto_hasher_from_value(
        context,
        ct_jsc_value_get_ref(invocation, ct_jsc_invocation_argument(invocation, 0))
    );
    if (state == NULL) {
        return ct_jsc_throw_type_error(invocation, "Invalid native CryptoHasher");
    }

    const int encoding = (int)ct_jsc_value_to_number(
        invocation,
        ct_jsc_invocation_argument(invocation, 1)
    );
    if (ct_jsc_invocation_has_exception(invocation)) {
        return ct_jsc_make_undefined(invocation);
    }

    CtJscBytesView target = {0};
    if (encoding == CT_CRYPTO_HASHER_OUTPUT_TARGET) {
        if (ct_jsc_invocation_argument_count(invocation) < 3 ||
            !ct_jsc_value_get_bytes_view(
                invocation,
                ct_jsc_invocation_argument(invocation, 2),
                &target
            )) {
            return ct_jsc_throw_type_error(
                invocation,
                "Invalid CryptoHasher output target"
            );
        }
#if CT_HAS_OPENSSL
        if (target.length < state->output_len) {
            char message[96];
            snprintf(
                message,
                sizeof(message),
                "TypedArray must be at least %zu bytes",
                state->output_len
            );
            return ct_jsc_throw_type_error(invocation, message);
        }
#endif
    } else if (encoding < CT_CRYPTO_HASHER_OUTPUT_BUFFER ||
        encoding > CT_CRYPTO_HASHER_OUTPUT_UTF16LE) {
        return ct_jsc_throw_type_error(
            invocation,
            "Invalid native CryptoHasher encoding"
        );
    }

#if CT_HAS_OPENSSL
    uint8_t digest[EVP_MAX_MD_SIZE];
    size_t digest_length = 0;
    if (!ct_crypto_hasher_state_digest(state, digest, &digest_length)) {
        return ct_jsc_throw_error(invocation, "Digest operation failed");
    }
    if (encoding == CT_CRYPTO_HASHER_OUTPUT_TARGET) {
        memcpy((uint8_t *)target.data, digest, digest_length);
        return ct_jsc_invocation_argument(invocation, 2);
    }

    JSValueRef exception = NULL;
    JSValueRef result = ct_crypto_hasher_encoded_result(
        context,
        digest,
        digest_length,
        encoding,
        &exception
    );
    if (exception != NULL) return ct_jsc_throw_value_ref(invocation, exception);
    return ct_jsc_value_from_ref(invocation, result);
#else
    return ct_jsc_throw_error(invocation, "Native incremental hashing is unavailable");
#endif
}

struct CtModuleResolveCacheEntry {
    uint64_t hash;
    uint8_t import_kind;
    size_t request_length;
    size_t base_length;
    size_t conditions_length;
    uint8_t *key;
    JSValueRef result;
    CtModuleResolveCacheEntry *next;
};

static uint64_t ct_module_resolve_hash_bytes(
    uint64_t hash,
    const uint8_t *data,
    size_t length
) {
    for (size_t index = 0; index < length; index += 1) {
        hash ^= data[index];
        hash *= UINT64_C(1099511628211);
    }
    hash ^= (uint8_t)length;
    hash *= UINT64_C(1099511628211);
    hash ^= (uint8_t)(length >> 8);
    hash *= UINT64_C(1099511628211);
    return hash;
}

static uint64_t ct_module_resolve_hash(
    const CtJscUtf8View *request,
    const CtJscUtf8View *base,
    bool import_kind,
    const CtJscUtf8View *conditions
) {
    uint64_t hash = UINT64_C(14695981039346656037);
    hash = ct_module_resolve_hash_bytes(hash, request->data, request->length);
    hash ^= import_kind ? 1 : 0;
    hash *= UINT64_C(1099511628211);
    hash = ct_module_resolve_hash_bytes(hash, base->data, base->length);
    return ct_module_resolve_hash_bytes(hash, conditions->data, conditions->length);
}

static bool ct_module_resolve_cache_entry_matches(
    const CtModuleResolveCacheEntry *entry,
    uint64_t hash,
    const CtJscUtf8View *request,
    const CtJscUtf8View *base,
    bool import_kind,
    const CtJscUtf8View *conditions
) {
    if (entry->hash != hash ||
        entry->import_kind != (uint8_t)import_kind ||
        entry->request_length != request->length ||
        entry->base_length != base->length ||
        entry->conditions_length != conditions->length) {
        return false;
    }
    const uint8_t *cursor = entry->key;
    if (request->length > 0 && memcmp(cursor, request->data, request->length) != 0) return false;
    cursor += request->length;
    if (base->length > 0 && memcmp(cursor, base->data, base->length) != 0) return false;
    cursor += base->length;
    return conditions->length == 0 ||
        memcmp(cursor, conditions->data, conditions->length) == 0;
}

static bool ct_module_resolve_cache_reserve(
    CtJscRuntime *runtime,
    size_t minimum_capacity
) {
    size_t capacity = runtime->module_resolve_cache_capacity;
    if (capacity >= minimum_capacity) return true;
    if (capacity == 0) capacity = 64;
    while (capacity < minimum_capacity) {
        if (capacity > SIZE_MAX / 2) return false;
        capacity *= 2;
    }
    CtModuleResolveCacheEntry **buckets = (CtModuleResolveCacheEntry **)calloc(
        capacity,
        sizeof(CtModuleResolveCacheEntry *)
    );
    if (buckets == NULL) return false;

    for (size_t index = 0; index < runtime->module_resolve_cache_capacity; index += 1) {
        CtModuleResolveCacheEntry *entry = runtime->module_resolve_cache_buckets[index];
        while (entry != NULL) {
            CtModuleResolveCacheEntry *next = entry->next;
            const size_t bucket = (size_t)entry->hash & (capacity - 1);
            entry->next = buckets[bucket];
            buckets[bucket] = entry;
            entry = next;
        }
    }
    free(runtime->module_resolve_cache_buckets);
    runtime->module_resolve_cache_buckets = buckets;
    runtime->module_resolve_cache_capacity = capacity;
    return true;
}

static void ct_module_resolve_cache_clear(CtJscRuntime *runtime) {
    if (runtime == NULL) return;
    for (size_t index = 0; index < runtime->module_resolve_cache_capacity; index += 1) {
        CtModuleResolveCacheEntry *entry = runtime->module_resolve_cache_buckets[index];
        while (entry != NULL) {
            CtModuleResolveCacheEntry *next = entry->next;
            if (runtime->context != NULL && entry->result != NULL) {
                JSValueUnprotect(runtime->context, entry->result);
            }
            free(entry->key);
            free(entry);
            entry = next;
        }
    }
    free(runtime->module_resolve_cache_buckets);
    runtime->module_resolve_cache_buckets = NULL;
    runtime->module_resolve_cache_capacity = 0;
    runtime->module_resolve_cache_count = 0;
}

static bool ct_direct_module_resolve_cache_arguments(
    CtJscInvocation *invocation,
    CtJscUtf8View *request,
    CtJscUtf8View *base,
    bool *import_kind,
    CtJscUtf8View *conditions
) {
    if (ct_jsc_invocation_argument_count(invocation) < 4) return false;
    CtJscEncodedValue request_value = ct_jsc_invocation_argument(invocation, 0);
    CtJscEncodedValue base_value = ct_jsc_invocation_argument(invocation, 1);
    CtJscEncodedValue conditions_value = ct_jsc_invocation_argument(invocation, 3);
    if (!ct_jsc_value_is_string(request_value) ||
        !ct_jsc_value_is_string(base_value) ||
        !ct_jsc_value_is_string(conditions_value)) {
        return false;
    }
    if (!ct_jsc_value_get_utf8_view(invocation, request_value, request) ||
        !ct_jsc_value_get_utf8_view(invocation, base_value, base) ||
        !ct_jsc_value_get_utf8_view(invocation, conditions_value, conditions)) {
        return false;
    }
    *import_kind = ct_jsc_value_to_boolean(
        invocation,
        ct_jsc_invocation_argument(invocation, 2)
    );
    return !ct_jsc_invocation_has_exception(invocation);
}

static CtJscEncodedValue ct_direct_module_resolve_cache_get(
    CtJscInvocation *invocation,
    void *user_data
) {
    CtJscRuntime *runtime = (CtJscRuntime *)user_data;
    CtJscUtf8View request;
    CtJscUtf8View base;
    CtJscUtf8View conditions;
    bool import_kind;
    if (!ct_direct_module_resolve_cache_arguments(
            invocation,
            &request,
            &base,
            &import_kind,
            &conditions
        )) {
        if (ct_jsc_invocation_has_exception(invocation)) return ct_jsc_make_undefined(invocation);
        return ct_jsc_throw_type_error(
            invocation,
            "moduleResolveCacheGet requires string request, base, and conditions"
        );
    }
    if (runtime == NULL || runtime->module_resolve_cache_capacity == 0) {
        return ct_jsc_make_undefined(invocation);
    }
    const uint64_t hash = ct_module_resolve_hash(
        &request,
        &base,
        import_kind,
        &conditions
    );
    const size_t bucket = (size_t)hash & (runtime->module_resolve_cache_capacity - 1);
    for (CtModuleResolveCacheEntry *entry = runtime->module_resolve_cache_buckets[bucket];
         entry != NULL;
         entry = entry->next) {
        if (ct_module_resolve_cache_entry_matches(
                entry,
                hash,
                &request,
                &base,
                import_kind,
                &conditions
            )) {
            return ct_jsc_value_from_ref(invocation, entry->result);
        }
    }
    return ct_jsc_make_undefined(invocation);
}

static CtJscEncodedValue ct_direct_module_resolve_cache_put(
    CtJscInvocation *invocation,
    void *user_data
) {
    CtJscRuntime *runtime = (CtJscRuntime *)user_data;
    CtJscUtf8View request;
    CtJscUtf8View base;
    CtJscUtf8View conditions;
    bool import_kind;
    if (!ct_direct_module_resolve_cache_arguments(
            invocation,
            &request,
            &base,
            &import_kind,
            &conditions
        ) ||
        ct_jsc_invocation_argument_count(invocation) < 5 ||
        !ct_jsc_value_is_string(ct_jsc_invocation_argument(invocation, 4))) {
        if (ct_jsc_invocation_has_exception(invocation)) return ct_jsc_make_undefined(invocation);
        return ct_jsc_throw_type_error(
            invocation,
            "moduleResolveCachePut requires string request, base, conditions, and result"
        );
    }
    CtJscEncodedValue result_value = ct_jsc_invocation_argument(invocation, 4);
    if (runtime == NULL) return result_value;

    const uint64_t hash = ct_module_resolve_hash(
        &request,
        &base,
        import_kind,
        &conditions
    );
    if (runtime->module_resolve_cache_capacity > 0) {
        const size_t bucket = (size_t)hash & (runtime->module_resolve_cache_capacity - 1);
        for (CtModuleResolveCacheEntry *entry = runtime->module_resolve_cache_buckets[bucket];
             entry != NULL;
             entry = entry->next) {
            if (!ct_module_resolve_cache_entry_matches(
                    entry,
                    hash,
                    &request,
                    &base,
                    import_kind,
                    &conditions
                )) {
                continue;
            }
            JSValueRef result = ct_jsc_value_get_ref(invocation, result_value);
            JSValueProtect(runtime->context, result);
            JSValueUnprotect(runtime->context, entry->result);
            entry->result = result;
            return result_value;
        }
    }

    if (runtime->module_resolve_cache_count + 1 >
        runtime->module_resolve_cache_capacity - runtime->module_resolve_cache_capacity / 4) {
        size_t minimum = runtime->module_resolve_cache_capacity == 0
            ? 64
            : runtime->module_resolve_cache_capacity * 2;
        if (!ct_module_resolve_cache_reserve(runtime, minimum)) return result_value;
    }
    if (request.length > SIZE_MAX - base.length ||
        request.length + base.length > SIZE_MAX - conditions.length) {
        return result_value;
    }
    const size_t key_length = request.length + base.length + conditions.length;
    CtModuleResolveCacheEntry *entry = (CtModuleResolveCacheEntry *)calloc(1, sizeof(*entry));
    if (entry == NULL) return result_value;
    entry->key = (uint8_t *)malloc(key_length > 0 ? key_length : 1);
    if (entry->key == NULL) {
        free(entry);
        return result_value;
    }
    uint8_t *cursor = entry->key;
    if (request.length > 0) memcpy(cursor, request.data, request.length);
    cursor += request.length;
    if (base.length > 0) memcpy(cursor, base.data, base.length);
    cursor += base.length;
    if (conditions.length > 0) memcpy(cursor, conditions.data, conditions.length);

    entry->hash = hash;
    entry->import_kind = (uint8_t)import_kind;
    entry->request_length = request.length;
    entry->base_length = base.length;
    entry->conditions_length = conditions.length;
    entry->result = ct_jsc_value_get_ref(invocation, result_value);
    JSValueProtect(runtime->context, entry->result);
    const size_t bucket = (size_t)hash & (runtime->module_resolve_cache_capacity - 1);
    entry->next = runtime->module_resolve_cache_buckets[bucket];
    runtime->module_resolve_cache_buckets[bucket] = entry;
    runtime->module_resolve_cache_count += 1;
    return result_value;
}

static CtJscEncodedValue ct_direct_module_resolve_cache_clear(
    CtJscInvocation *invocation,
    void *user_data
) {
    ct_module_resolve_cache_clear((CtJscRuntime *)user_data);
    return ct_jsc_make_undefined(invocation);
}

static CtJscEncodedValue ct_direct_runtime_module_source(
    CtJscInvocation *invocation,
    void *user_data
) {
    (void)user_data;
    if (ct_jsc_invocation_argument_count(invocation) < 1 ||
        !ct_jsc_value_is_string(ct_jsc_invocation_argument(invocation, 0))) {
        return ct_jsc_throw_type_error(
            invocation,
            "runtimeModuleSourceNative requires a string path"
        );
    }
    CtJscUtf8View path;
    if (!ct_jsc_value_get_utf8_view(
            invocation,
            ct_jsc_invocation_argument(invocation, 0),
            &path
        )) {
        return ct_jsc_make_undefined(invocation);
    }
    const uint8_t *source = NULL;
    size_t source_length = 0;
    const int status = ct_embedded_runtime_module_source(
        path.data,
        path.length,
        &source,
        &source_length
    );
    if (status < 0) {
        return ct_jsc_throw_error(invocation, "Embedded runtime module data is invalid");
    }
    if (status == 0) return ct_jsc_make_undefined(invocation);
    return ct_jsc_make_utf8_string(invocation, source, source_length);
}

typedef struct CtDirectNativeBindingDefinition {
    const char *name;
    unsigned arity;
    CtJscNativeCallback callback;
} CtDirectNativeBindingDefinition;

static const CtDirectNativeBindingDefinition ct_direct_native_binding_definitions[] = {
#define CT_DIRECT_NATIVE_BINDING(name, arity, callback) { name, arity, callback },
#include "direct-bindings.generated.inc"
#undef CT_DIRECT_NATIVE_BINDING
};

#define CT_DIRECT_NATIVE_BINDING_COUNT \
    (sizeof(ct_direct_native_binding_definitions) / \
        sizeof(ct_direct_native_binding_definitions[0]))

static const CtDirectNativeBindingDefinition *ct_direct_native_binding_for_name(
    const char *name
) {
    for (size_t index = 0;
         index < CT_DIRECT_NATIVE_BINDING_COUNT;
         index += 1) {
        const CtDirectNativeBindingDefinition *binding =
            &ct_direct_native_binding_definitions[index];
        if (strcmp(name, binding->name) == 0) return binding;
    }
    return NULL;
}
