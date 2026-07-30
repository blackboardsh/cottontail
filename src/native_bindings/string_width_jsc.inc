extern ptrdiff_t ct_string_width_utf16(
    const uint16_t *ptr,
    size_t len,
    bool exclude_ansi,
    bool ambiguous_as_wide
);

static JSValueRef ct_string_width_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;

    if (argument_count < 3 || !JSValueIsString(context, arguments[0])) {
        ct_throw_type_error(
            context,
            exception,
            "stringWidthNative expects a string and two boolean options"
        );
        return JSValueMakeUndefined(context);
    }

    JSStringRef string = JSValueToStringCopy(context, arguments[0], exception);
    if (string == NULL || (exception != NULL && *exception != NULL)) {
        return JSValueMakeUndefined(context);
    }

    const ptrdiff_t width = ct_string_width_utf16(
        (const uint16_t *)JSStringGetCharactersPtr(string),
        JSStringGetLength(string),
        !JSValueToBoolean(context, arguments[1]),
        !JSValueToBoolean(context, arguments[2])
    );
    JSStringRelease(string);
    return JSValueMakeNumber(context, (double)width);
}
