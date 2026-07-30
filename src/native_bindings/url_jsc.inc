static JSValueRef ct_url_parse_form_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) return JSObjectMakeArray(context, 0, NULL, exception);
    JSStringRef input = JSValueToStringCopy(context, arguments[0], exception);
    if (input == NULL || (exception != NULL && *exception != NULL)) {
        return JSValueMakeUndefined(context);
    }
    JSObjectRef result = ct_url_parse_form(context, input, exception);
    JSStringRelease(input);
    return result != NULL ? result : JSValueMakeUndefined(context);
}
