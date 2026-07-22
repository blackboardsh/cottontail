#ifndef COTTONTAIL_NAPI_BRIDGE_H
#define COTTONTAIL_NAPI_BRIDGE_H

#include <JavaScriptCore/JavaScript.h>

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct NapiEnv CtNapiEnv;
typedef struct uv_loop_s uv_loop_t;
typedef void (*CtNapiWakeCallback)(void *opaque);

/* The caller owns event_loop and must keep it alive through ct_napi_env_destroy. */
CtNapiEnv *ct_napi_env_create(
    JSGlobalContextRef context,
    uv_loop_t *event_loop,
    void *wake_opaque,
    CtNapiWakeCallback wake_callback
);
CtNapiEnv *ct_napi_env_for_ffi_library(CtNapiEnv *env, const char *identity);
void ct_napi_env_destroy(CtNapiEnv *env);

JSValueRef ct_napi_load_addon(
    CtNapiEnv *env,
    const char *path,
    JSObjectRef exports,
    JSValueRef *exception
);

bool ct_napi_env_has_pending_work(CtNapiEnv *env);
void ct_napi_env_drain(CtNapiEnv *env, JSValueRef *exception);
void ct_napi_env_drain_gc(CtNapiEnv *env, JSValueRef *exception);
JSValueRef ct_napi_env_take_exception(CtNapiEnv *env);

#ifdef __cplusplus
}
#endif

#endif
