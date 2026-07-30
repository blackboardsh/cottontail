#include "strip_ansi.h"

static JSValueRef ct_strip_ansi_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) {
        ct_throw_type_error(context, exception, "stripANSINative(value) requires a string");
        return JSValueMakeUndefined(context);
    }

    JSStringRef input_string = JSValueToStringCopy(context, arguments[0], exception);
    if (input_string == NULL) return JSValueMakeUndefined(context);

    const CtStripANSISlice input = {
        .ptr = (const uint16_t *)JSStringGetCharactersPtr(input_string),
        .len = JSStringGetLength(input_string),
    };
    CtStripANSIResult output = {0};
    const int status = ct_strip_ansi_core(input, &output);
    JSStringRelease(input_string);

    if (status == 1) return arguments[0];
    if (status != 0) {
        ct_strip_ansi_core_free((void *)output.ptr, output.capacity);
        ct_throw_message(context, exception, "Native ANSI stripping failed");
        return JSValueMakeUndefined(context);
    }

    static const JSChar empty_character = 0;
    const JSChar *characters = output.len == 0
        ? &empty_character
        : (const JSChar *)output.ptr;
    JSStringRef output_string = JSStringCreateWithCharacters(characters, output.len);
    ct_strip_ansi_core_free((void *)output.ptr, output.capacity);
    if (output_string == NULL) {
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }

    JSValueRef result = JSValueMakeString(context, output_string);
    JSStringRelease(output_string);
    return result;
}
