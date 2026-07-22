#ifndef COTTONTAIL_NATIVE_BINDINGS_REGISTRY_H
#define COTTONTAIL_NATIVE_BINDINGS_REGISTRY_H

#include "jsc_runner.h"

#include <JavaScriptCore/JavaScript.h>
#include <stddef.h>

void ct_native_bindings_install(
    JSContextRef context,
    JSObjectRef target,
    CtJscRuntime *runtime,
    const char *const names[],
    size_t name_count,
    const JSObjectCallAsFunctionCallback callbacks[],
    size_t callback_count
);

#define CT_DECLARE_NATIVE_BINDING_MODULE(name) \
    void ct_register_##name##_bindings( \
        JSContextRef context, \
        JSObjectRef target, \
        CtJscRuntime *runtime, \
        const JSObjectCallAsFunctionCallback callbacks[], \
        size_t callback_count \
    )

CT_DECLARE_NATIVE_BINDING_MODULE(runtime);
CT_DECLARE_NATIVE_BINDING_MODULE(inspector);
CT_DECLARE_NATIVE_BINDING_MODULE(filesystem);
CT_DECLARE_NATIVE_BINDING_MODULE(process);
CT_DECLARE_NATIVE_BINDING_MODULE(http);
CT_DECLARE_NATIVE_BINDING_MODULE(tooling);
CT_DECLARE_NATIVE_BINDING_MODULE(memory_ffi);
CT_DECLARE_NATIVE_BINDING_MODULE(worker);
CT_DECLARE_NATIVE_BINDING_MODULE(system);
CT_DECLARE_NATIVE_BINDING_MODULE(compression);
CT_DECLARE_NATIVE_BINDING_MODULE(crypto);
CT_DECLARE_NATIVE_BINDING_MODULE(dns);
CT_DECLARE_NATIVE_BINDING_MODULE(sockets);
CT_DECLARE_NATIVE_BINDING_MODULE(tls);
CT_DECLARE_NATIVE_BINDING_MODULE(sqlite);
CT_DECLARE_NATIVE_BINDING_MODULE(platform);

#undef CT_DECLARE_NATIVE_BINDING_MODULE

#endif
