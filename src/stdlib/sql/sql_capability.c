#include "../native_capability.h"
#include "../../native_bindings/sql_wire_jsc.inc"

#define CT_NATIVE_BINDING(name, callback) { name, callback },
static const struct { const char *name; JSObjectCallAsFunctionCallback callback; } bindings[] = {
#include "../../native_bindings/sql_wire.inc"
};
#undef CT_NATIVE_BINDING

#if defined(_WIN32)
__declspec(dllexport)
#else
__attribute__((visibility("default")))
#endif
int cottontail_capability_init(JSContextRef context, JSObjectRef target) {
    for (size_t i = 0; i < sizeof(bindings) / sizeof(bindings[0]); i++) {
        JSClassDefinition definition = kJSClassDefinitionEmpty;
        definition.className = bindings[i].name;
        definition.callAsFunction = bindings[i].callback;
        JSClassRef cls = JSClassCreate(&definition);
        JSObjectRef fn = JSObjectMake(context, cls, NULL);
        JSClassRelease(cls);
        JSStringRef key = ct_js_string(bindings[i].name);
        JSValueRef error = NULL;
        JSObjectSetProperty(context, target, key, fn, kJSPropertyAttributeNone, &error);
        JSStringRelease(key);
        if (error != NULL) return -1;
    }
    return 0;
}
