#include "path.h"

static JSValueRef ct_path_normalize_native(
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
        ct_throw_type_error(context, exception, "pathNormalizeNative(windows, path) requires a path");
        return JSValueMakeUndefined(context);
    }

    JSStringRef input_string = JSValueToStringCopy(context, arguments[1], exception);
    if (input_string == NULL) return JSValueMakeUndefined(context);

    const CtPathSlice input = {
        .ptr = (const uint16_t *)JSStringGetCharactersPtr(input_string),
        .len = JSStringGetLength(input_string),
    };
    CtPathResult output = {0};
    const int status = ct_path_core_normalize(
        JSValueToBoolean(context, arguments[0]) ? 1 : 0,
        input,
        &output
    );
    JSStringRelease(input_string);

    if (status != 0) {
        ct_path_core_free((void *)output.ptr, output.len);
        ct_throw_message(context, exception, "Native path normalization failed");
        return JSValueMakeUndefined(context);
    }

    JSStringRef output_string = JSStringCreateWithCharacters(
        (const JSChar *)output.ptr,
        output.len
    );
    ct_path_core_free((void *)output.ptr, output.len);
    if (output_string == NULL) {
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }

    JSValueRef result = JSValueMakeString(context, output_string);
    JSStringRelease(output_string);
    return result;
}

static JSValueRef ct_which_path_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 5) {
        ct_throw_type_error(
            context,
            exception,
            "whichPathNative(path, cwd, bin, systemRoot, canonicalSystemRoot) requires five strings"
        );
        return JSValueMakeUndefined(context);
    }

    char *values[5] = { NULL, NULL, NULL, NULL, NULL };
    size_t lengths[5] = { 0, 0, 0, 0, 0 };
    for (size_t index = 0; index < 5; index += 1) {
        values[index] = ct_value_to_utf8_copy_checked(
            context,
            arguments[index],
            &lengths[index],
            exception
        );
        if (values[index] != NULL) continue;
        for (size_t free_index = 0; free_index < 5; free_index += 1) free(values[free_index]);
        if (exception == NULL || *exception == NULL) {
            ct_throw_message(context, exception, "Out of memory");
        }
        return JSValueMakeUndefined(context);
    }

    CtWhichResult output = {0};
    const int status = ct_which_core_find_on_path(
        (CtWhichSlice){ .ptr = values[0], .len = lengths[0] },
        (CtWhichSlice){ .ptr = values[1], .len = lengths[1] },
        (CtWhichSlice){ .ptr = values[2], .len = lengths[2] },
        (CtWhichSlice){ .ptr = values[3], .len = lengths[3] },
        (CtWhichSlice){ .ptr = values[4], .len = lengths[4] },
        &output
    );
    for (size_t index = 0; index < 5; index += 1) free(values[index]);

    if (status != 0) {
        ct_which_core_free((void *)output.ptr, output.len);
        ct_throw_message(context, exception, "Native executable search failed");
        return JSValueMakeUndefined(context);
    }
    if (output.ptr == NULL) return JSValueMakeNull(context);

    JSValueRef result = ct_make_string_len(context, output.ptr, output.len);
    ct_which_core_free((void *)output.ptr, output.len);
    return result;
}
