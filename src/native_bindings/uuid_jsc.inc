#include "uuid.h"

static bool ct_uuid_encoding(
    JSContextRef context,
    JSValueRef value,
    uint8_t *encoding,
    JSValueRef *exception
) {
    if (!JSValueIsNumber(context, value)) {
        ct_throw_type_error(context, exception, "Invalid native UUID encoding");
        return false;
    }
    const double number = JSValueToNumber(context, value, exception);
    if ((exception != NULL && *exception != NULL) ||
        number < 0 ||
        number > 3 ||
        number != (double)(uint8_t)number) {
        ct_throw_type_error(context, exception, "Invalid native UUID encoding");
        return false;
    }
    *encoding = (uint8_t)number;
    return true;
}

static JSValueRef ct_uuid_result(
    JSContextRef context,
    const uint8_t uuid[16],
    uint8_t encoding,
    JSValueRef *exception
) {
    if (encoding == 1) {
        return ct_array_buffer_from_copy(context, (const char *)uuid, 16, exception);
    }

    uint8_t formatted[36];
    const size_t length = ct_uuid_format(encoding, uuid, formatted);
    if (length == 0) {
        ct_throw_type_error(context, exception, "Invalid native UUID encoding");
        return JSValueMakeUndefined(context);
    }
    return ct_make_string_len(context, (const char *)formatted, length);
}

static JSValueRef ct_random_uuid_v7_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 2 || !JSValueIsNumber(context, arguments[0])) {
        ct_throw_type_error(
            context,
            exception,
            "randomUUIDv7Native(timestamp, encoding) requires a timestamp"
        );
        return JSValueMakeUndefined(context);
    }

    const double timestamp_number = JSValueToNumber(context, arguments[0], exception);
    if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(context);

    uint8_t encoding = 0;
    if (!ct_uuid_encoding(context, arguments[1], &encoding, exception)) {
        return JSValueMakeUndefined(context);
    }

    uint8_t uuid[16];
    ct_uuid_v7((uint64_t)timestamp_number, uuid);
    return ct_uuid_result(context, uuid, encoding, exception);
}

static JSValueRef ct_random_uuid_v5_native(
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
        ct_throw_type_error(
            context,
            exception,
            "randomUUIDv5Native(name, namespace, encoding) requires three arguments"
        );
        return JSValueMakeUndefined(context);
    }

    uint8_t encoding = 0;
    if (!ct_uuid_encoding(context, arguments[2], &encoding, exception)) {
        return JSValueMakeUndefined(context);
    }

    uint8_t *namespace_bytes = NULL;
    size_t namespace_length = 0;
    if (ct_get_bytes(context, arguments[1], &namespace_bytes, &namespace_length) != 0 ||
        namespace_length != 16) {
        ct_throw_type_error(context, exception, "Invalid native UUID namespace");
        return JSValueMakeUndefined(context);
    }

    uint8_t uuid[16];
    if (JSValueIsString(context, arguments[0])) {
        JSStringRef name = JSValueToStringCopy(context, arguments[0], exception);
        if (name == NULL || (exception != NULL && *exception != NULL)) {
            return JSValueMakeUndefined(context);
        }
        const JSChar *characters = JSStringGetCharactersPtr(name);
        const size_t length = JSStringGetLength(name);
        ct_uuid_v5_utf16(
            (CtUuidSlice){ .ptr = namespace_bytes, .len = namespace_length },
            (CtUuidUtf16Slice){
                .ptr = (const uint16_t *)characters,
                .len = length,
            },
            uuid
        );
        JSStringRelease(name);
    } else {
        uint8_t *name = NULL;
        size_t name_length = 0;
        if (ct_get_bytes(context, arguments[0], &name, &name_length) != 0) {
            ct_throw_type_error(context, exception, "Invalid native UUID name");
            return JSValueMakeUndefined(context);
        }
        ct_uuid_v5(
            (CtUuidSlice){ .ptr = namespace_bytes, .len = namespace_length },
            (CtUuidSlice){ .ptr = name, .len = name_length },
            uuid
        );
    }

    return ct_uuid_result(context, uuid, encoding, exception);
}
