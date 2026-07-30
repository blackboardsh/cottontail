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
