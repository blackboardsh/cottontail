#include <node_api.h>

namespace {

int next_order = 1;
bool registered_reentrant = false;

napi_value set_order(napi_env env, napi_value exports, const char* name)
{
    napi_value order = nullptr;
    if (napi_create_int32(env, next_order++, &order) != napi_ok)
        return nullptr;
    if (napi_set_named_property(env, exports, name, order) != napi_ok)
        return nullptr;
    return exports;
}

napi_value register_reentrant(napi_env env, napi_value exports)
{
    return set_order(env, exports, "reentrant");
}

napi_module reentrant_module {
    NAPI_MODULE_VERSION,
    0,
    __FILE__,
    register_reentrant,
    "cottontail_reentrant_registration",
    nullptr,
    { nullptr },
};

napi_value register_first(napi_env env, napi_value exports)
{
    napi_value result = set_order(env, exports, "first");
    if (result && !registered_reentrant) {
        registered_reentrant = true;
        napi_module_register(&reentrant_module);
    }
    return result;
}

napi_value register_second(napi_env env, napi_value exports)
{
    return set_order(env, exports, "second");
}

napi_module first_module {
    NAPI_MODULE_VERSION,
    0,
    __FILE__,
    register_first,
    "cottontail_first_registration",
    nullptr,
    { nullptr },
};

napi_module second_module {
    NAPI_MODULE_VERSION,
    0,
    __FILE__,
    register_second,
    "cottontail_second_registration",
    nullptr,
    { nullptr },
};

NAPI_C_CTOR(register_modules)
{
    napi_module_register(&first_module);
    napi_module_register(&second_module);
}

} // namespace
