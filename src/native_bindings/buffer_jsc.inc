#include "buffer.h"

static bool ct_buffer_get_bytes(
    JSContextRef context,
    JSValueRef value,
    uint8_t **bytes_out,
    size_t *length_out,
    JSValueRef *exception
) {
    if (ct_get_bytes(context, value, bytes_out, length_out) == 0) return true;
    ct_throw_type_error(context, exception, "Native Buffer operation requires a typed array");
    return false;
}

static bool ct_buffer_get_index(
    JSContextRef context,
    JSValueRef value,
    size_t *index_out,
    JSValueRef *exception
) {
    JSValueRef conversion_exception = NULL;
    double number = JSValueToNumber(context, value, &conversion_exception);
    if (conversion_exception != NULL) {
        if (exception != NULL) *exception = conversion_exception;
        return false;
    }
    if (!isfinite(number) || number < 0 || floor(number) != number || number > (double)SIZE_MAX) {
        ct_throw_type_error(context, exception, "Native Buffer operation received an invalid index");
        return false;
    }
    *index_out = (size_t)number;
    return true;
}

static JSValueRef ct_buffer_compare_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 6) {
        ct_throw_type_error(context, exception, "bufferCompare requires two typed arrays and four indexes");
        return JSValueMakeUndefined(context);
    }

    uint8_t *left = NULL;
    uint8_t *right = NULL;
    size_t left_length = 0;
    size_t right_length = 0;
    size_t left_start = 0;
    size_t left_end = 0;
    size_t right_start = 0;
    size_t right_end = 0;
    if (!ct_buffer_get_bytes(context, arguments[0], &left, &left_length, exception) ||
        !ct_buffer_get_index(context, arguments[1], &left_start, exception) ||
        !ct_buffer_get_index(context, arguments[2], &left_end, exception) ||
        !ct_buffer_get_bytes(context, arguments[3], &right, &right_length, exception) ||
        !ct_buffer_get_index(context, arguments[4], &right_start, exception) ||
        !ct_buffer_get_index(context, arguments[5], &right_end, exception)) {
        return JSValueMakeUndefined(context);
    }
    if (left_start > left_end || left_end > left_length ||
        right_start > right_end || right_end > right_length) {
        ct_throw_type_error(context, exception, "Native Buffer compare range is out of bounds");
        return JSValueMakeUndefined(context);
    }

    int result = ct_buffer_compare(
        left != NULL ? left + left_start : NULL,
        left_end - left_start,
        right != NULL ? right + right_start : NULL,
        right_end - right_start
    );
    return JSValueMakeNumber(context, (double)result);
}

static JSValueRef ct_buffer_index_of_native(
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
        ct_throw_type_error(context, exception, "bufferIndexOf requires haystack, needle, offset, and direction");
        return JSValueMakeUndefined(context);
    }

    uint8_t *haystack = NULL;
    uint8_t *needle = NULL;
    size_t haystack_length = 0;
    size_t needle_length = 0;
    size_t offset = 0;
    if (!ct_buffer_get_bytes(context, arguments[0], &haystack, &haystack_length, exception) ||
        !ct_buffer_get_bytes(context, arguments[1], &needle, &needle_length, exception) ||
        !ct_buffer_get_index(context, arguments[2], &offset, exception)) {
        return JSValueMakeUndefined(context);
    }
    if (offset > haystack_length) {
        ct_throw_type_error(context, exception, "Native Buffer search arguments are out of bounds");
        return JSValueMakeUndefined(context);
    }

    ptrdiff_t result = ct_buffer_index_of(
        haystack,
        haystack_length,
        needle,
        needle_length,
        offset,
        JSValueToBoolean(context, arguments[3]) ? 1 : 0
    );
    return JSValueMakeNumber(context, (double)result);
}

static JSValueRef ct_buffer_index_of_line_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 3) {
        ct_throw_type_error(context, exception, "bufferIndexOfLine requires a buffer, offset, and end");
        return JSValueMakeUndefined(context);
    }

    uint8_t *buffer = NULL;
    size_t buffer_length = 0;
    size_t offset = 0;
    size_t end = 0;
    if (!ct_buffer_get_bytes(context, arguments[0], &buffer, &buffer_length, exception) ||
        !ct_buffer_get_index(context, arguments[1], &offset, exception) ||
        !ct_buffer_get_index(context, arguments[2], &end, exception)) {
        return JSValueMakeUndefined(context);
    }
    if (offset >= end || offset >= buffer_length) {
        return JSValueMakeNumber(context, -1);
    }

    end = end < buffer_length ? end : buffer_length;
    ptrdiff_t result = ct_buffer_index_of_line(buffer, end, offset);
    return JSValueMakeNumber(context, (double)result);
}

static JSValueRef ct_buffer_fill_pattern_native(
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
        ct_throw_type_error(context, exception, "bufferFillPattern requires target, pattern, start, and end");
        return JSValueMakeUndefined(context);
    }

    uint8_t *target = NULL;
    uint8_t *pattern = NULL;
    size_t target_length = 0;
    size_t pattern_length = 0;
    size_t start = 0;
    size_t end = 0;
    if (!ct_buffer_get_bytes(context, arguments[0], &target, &target_length, exception) ||
        !ct_buffer_get_bytes(context, arguments[1], &pattern, &pattern_length, exception) ||
        !ct_buffer_get_index(context, arguments[2], &start, exception) ||
        !ct_buffer_get_index(context, arguments[3], &end, exception)) {
        return JSValueMakeUndefined(context);
    }
    if (start > end || end > target_length || pattern_length == 0) {
        ct_throw_type_error(context, exception, "Native Buffer fill arguments are out of bounds");
        return JSValueMakeUndefined(context);
    }

    int result = ct_buffer_fill_pattern(
        target != NULL ? target + start : NULL,
        end - start,
        pattern,
        pattern_length
    );
    if (result == -2) {
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    if (result != 0) {
        ct_throw_type_error(context, exception, "Native Buffer fill failed");
        return JSValueMakeUndefined(context);
    }
    return arguments[0];
}
