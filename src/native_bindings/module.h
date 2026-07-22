#include "registry.h"

#ifndef CT_NATIVE_BINDING_MODULE
#error "CT_NATIVE_BINDING_MODULE must name the native binding subsystem"
#endif
#ifndef CT_NATIVE_BINDING_LIST
#error "CT_NATIVE_BINDING_LIST must name the native binding list"
#endif

#define CT_NATIVE_BINDING(name, callback) name,
static const char *const ct_native_binding_names[] = {
#include CT_NATIVE_BINDING_LIST
};
#undef CT_NATIVE_BINDING

#define CT_NATIVE_BINDING_REGISTER_INNER(name) ct_register_##name##_bindings
#define CT_NATIVE_BINDING_REGISTER(name) CT_NATIVE_BINDING_REGISTER_INNER(name)

void CT_NATIVE_BINDING_REGISTER(CT_NATIVE_BINDING_MODULE)(
    JSContextRef context,
    JSObjectRef target,
    CtJscRuntime *runtime,
    const JSObjectCallAsFunctionCallback callbacks[],
    size_t callback_count
) {
    ct_native_bindings_install(
        context,
        target,
        runtime,
        ct_native_binding_names,
        sizeof(ct_native_binding_names) / sizeof(ct_native_binding_names[0]),
        callbacks,
        callback_count
    );
}

#undef CT_NATIVE_BINDING_REGISTER
#undef CT_NATIVE_BINDING_REGISTER_INNER
#undef CT_NATIVE_BINDING_LIST
#undef CT_NATIVE_BINDING_MODULE
