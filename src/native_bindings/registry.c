#include "registry.h"

void ct_native_bindings_install(
    JSContextRef context,
    JSObjectRef target,
    CtJscRuntime *runtime,
    const char *const names[],
    size_t name_count,
    const JSObjectCallAsFunctionCallback callbacks[],
    size_t callback_count
) {
    if (name_count != callback_count) return;

    for (size_t index = 0; index < name_count; index += 1) {
        JSClassDefinition definition = kJSClassDefinitionEmpty;
        definition.className = names[index];
        definition.callAsFunction = callbacks[index];
        JSClassRef function_class = JSClassCreate(&definition);
        JSObjectRef function = JSObjectMake(context, function_class, runtime);
        JSClassRelease(function_class);

        JSStringRef property = JSStringCreateWithUTF8CString(names[index]);
        JSValueRef exception = NULL;
        JSObjectSetProperty(
            context,
            target,
            property,
            function,
            kJSPropertyAttributeNone,
            &exception
        );
        JSStringRelease(property);
    }
}
