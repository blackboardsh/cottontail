#include "../native_capability.h" /* Shared capability value helpers. */
#include "../../native_bindings/strip_ansi.h"
#include "../../native_bindings/string_width_jsc.inc"

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
    if (argument_count < 1) return ct_make_string(context, "");
    JSStringRef input = JSValueToStringCopy(context, arguments[0], exception);
    if (input == NULL || (exception != NULL && *exception != NULL)) {
        return JSValueMakeUndefined(context);
    }
    CtStripAnsiUtf16Result output;
    const int status = ct_strip_ansi_utf16(
        (const uint16_t *)JSStringGetCharactersPtr(input),
        JSStringGetLength(input),
        &output
    );
    if (status < 0) {
        JSStringRelease(input);
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    if (status == 0) {
        JSValueRef result = JSValueMakeString(context, input);
        JSStringRelease(input);
        return result;
    }
    JSStringRef string = JSStringCreateWithCharacters((const JSChar *)output.ptr, output.len);
    JSValueRef result = JSValueMakeString(context, string);
    JSStringRelease(string);
    JSStringRelease(input);
    ct_strip_ansi_free_utf16((uint16_t *)output.ptr, output.capacity);
    return result;
}

static const struct {
    const char *name;
    JSObjectCallAsFunctionCallback callback;
} bindings[] = {
    { "stripANSINative", ct_strip_ansi_native },
    { "stringWidthNative", ct_string_width_native },
};

#if defined(_WIN32)
__declspec(dllexport)
#else
__attribute__((visibility("default")))
#endif
int cottontail_capability_init(JSContextRef context, JSObjectRef target) {
    for (size_t index = 0; index < sizeof(bindings) / sizeof(bindings[0]); index += 1) {
        JSClassDefinition definition = kJSClassDefinitionEmpty;
        definition.className = bindings[index].name;
        definition.callAsFunction = bindings[index].callback;
        JSClassRef class_ref = JSClassCreate(&definition);
        JSObjectRef callback = JSObjectMake(context, class_ref, NULL);
        JSClassRelease(class_ref);
        JSStringRef key = ct_js_string(bindings[index].name);
        JSValueRef exception = NULL;
        JSObjectSetProperty(context, target, key, callback, kJSPropertyAttributeNone, &exception);
        JSStringRelease(key);
        if (exception != NULL) return -1;
    }
    return 0;
}
