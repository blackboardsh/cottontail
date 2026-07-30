#include "native_bindings/text_utilities.h"

static JSValueRef ct_text_ascii_width_native(
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
        ct_throw_type_error(
            context,
            exception,
            "textASCIIWidthNative(value) requires a value"
        );
        return JSValueMakeUndefined(context);
    }

    JSStringRef input = JSValueToStringCopy(context, arguments[0], exception);
    if (input == NULL) return JSValueMakeUndefined(context);
    const intptr_t width = ct_text_ascii_width(
        (const uint16_t *)JSStringGetCharactersPtr(input),
        JSStringGetLength(input)
    );
    JSStringRelease(input);
    return JSValueMakeNumber(context, (double)width);
}
