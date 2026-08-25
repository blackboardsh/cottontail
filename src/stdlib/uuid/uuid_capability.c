#include "../native_capability.h" /* Length-aware capability strings. */
#include "../../native_bindings/uuid_jsc.inc"

static const struct {
    const char *name;
    JSObjectCallAsFunctionCallback callback;
} bindings[] = {
    { "randomUUIDv7Native", ct_random_uuid_v7_native },
    { "randomUUIDv5Native", ct_random_uuid_v5_native },
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
