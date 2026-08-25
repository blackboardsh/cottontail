#ifndef COTTONTAIL_STDLIB_CAPABILITY_HOST_H
#define COTTONTAIL_STDLIB_CAPABILITY_HOST_H
#include <stdbool.h>
#include <JavaScriptCore/JavaScript.h>
typedef bool (*CtCapabilityHasPending)(void *state);
typedef int (*CtCapabilityDrain)(void *state, char **error_out);
typedef void (*CtCapabilityCleanup)(void *state);
typedef struct CtCapabilityHost {
    void *runtime;
    void (*wake)(void *runtime);
    int (*register_lifecycle)(void *runtime, void *state, CtCapabilityHasPending has_pending, CtCapabilityDrain drain, CtCapabilityCleanup cleanup);
    void *(*napi_env_for_library)(void *runtime, const char *identity);
    JSValueRef (*napi_take_exception)(void *environment);
} CtCapabilityHost;
#endif
