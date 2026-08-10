#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif

#include <node_api.h>

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#if defined(__linux__)
#include <dlfcn.h>
#include <pthread.h>
#include <semaphore.h>

typedef struct {
    int64_t tv_sec;
    int32_t tv_usec;
} CtUvTimeval64;

extern int uv_gettimeofday(CtUvTimeval64 *tv);
extern void uv_rwlock_destroy(pthread_rwlock_t *rwlock);
extern int uv_rwlock_init(pthread_rwlock_t *rwlock);
extern void uv_rwlock_rdlock(pthread_rwlock_t *rwlock);
extern void uv_rwlock_rdunlock(pthread_rwlock_t *rwlock);
extern int uv_rwlock_tryrdlock(pthread_rwlock_t *rwlock);
extern int uv_rwlock_trywrlock(pthread_rwlock_t *rwlock);
extern void uv_rwlock_wrlock(pthread_rwlock_t *rwlock);
extern void uv_rwlock_wrunlock(pthread_rwlock_t *rwlock);
extern void uv_sem_destroy(sem_t *sem);
extern int uv_sem_init(sem_t *sem, unsigned int value);
extern void uv_sem_post(sem_t *sem);
extern int uv_sem_trywait(sem_t *sem);
extern void uv_sem_wait(sem_t *sem);
extern unsigned int uv_version(void);
extern const char *uv_version_string(void);
#endif

typedef struct NativePluginArguments NativePluginArguments;
typedef struct NativePluginResult NativePluginResult;

typedef int (*FetchSourceCode)(const NativePluginArguments *, NativePluginResult *);
typedef void (*FreeSourceContext)(void *);

typedef struct NativeLogOptions {
    size_t struct_size;
    const uint8_t *message_ptr;
    size_t message_len;
    const uint8_t *path_ptr;
    size_t path_len;
    const uint8_t *source_line_text_ptr;
    size_t source_line_text_len;
    int8_t level;
    int32_t line;
    int32_t column;
    int32_t line_end;
    int32_t column_end;
} NativeLogOptions;

typedef void (*LogMessage)(const NativePluginArguments *, const NativeLogOptions *);

struct NativePluginArguments {
    size_t struct_size;
    void *bun;
    const uint8_t *path_ptr;
    size_t path_len;
    const uint8_t *namespace_ptr;
    size_t namespace_len;
    uint8_t default_loader;
    void *external;
};

struct NativePluginResult {
    size_t struct_size;
    uint8_t *source_ptr;
    size_t source_len;
    uint8_t loader;
    FetchSourceCode fetch_source_code;
    void *plugin_source_code_context;
    FreeSourceContext free_plugin_source_code_context;
    LogMessage log;
};

typedef struct PluginState {
    uint32_t observed;
    uint32_t transformed;
    uint32_t after_transform;
    uint32_t saw_reset_source;
    uint32_t cleanups;
} PluginState;

typedef struct SourceContext {
    PluginState *state;
    uint8_t *source;
} SourceContext;

NAPI_MODULE_EXPORT const char *BUN_PLUGIN_NAME = "cottontail_native_plugin_fixture";

static void free_source_context(void *opaque) {
    SourceContext *context = (SourceContext *)opaque;
    if (context == NULL) return;
    if (context->state != NULL) context->state->cleanups += 1;
    free(context->source);
    free(context);
}

NAPI_MODULE_EXPORT void native_observe(
    const NativePluginArguments *arguments,
    NativePluginResult *result
) {
    PluginState *state = (PluginState *)arguments->external;
    if (state != NULL) state->observed += 1;
    result->fetch_source_code(arguments, result);
}

NAPI_MODULE_EXPORT void native_transform(
    const NativePluginArguments *arguments,
    NativePluginResult *result
) {
    static const char replacement[] = "export const nativeValue = 42;";
    static const char warning[] = "native plugin warning";
    PluginState *state = (PluginState *)arguments->external;
    if (state != NULL) {
        state->transformed += 1;
        if (result->source_ptr != NULL) state->saw_reset_source += 1;
    }

    uint8_t *source = (uint8_t *)malloc(sizeof(replacement) - 1);
    SourceContext *context = (SourceContext *)malloc(sizeof(SourceContext));
    if (source == NULL || context == NULL) {
        free(source);
        free(context);
        return;
    }
    memcpy(source, replacement, sizeof(replacement) - 1);
    context->state = state;
    context->source = source;
    result->source_ptr = source;
    result->source_len = sizeof(replacement) - 1;
    result->loader = 1;
    result->plugin_source_code_context = context;
    result->free_plugin_source_code_context = free_source_context;

    NativeLogOptions log = {0};
    log.struct_size = sizeof(log);
    log.message_ptr = (const uint8_t *)warning;
    log.message_len = sizeof(warning) - 1;
    log.path_ptr = arguments->path_ptr;
    log.path_len = arguments->path_len;
    log.level = 3;
    result->log(arguments, &log);
}

NAPI_MODULE_EXPORT void native_after_transform(
    const NativePluginArguments *arguments,
    NativePluginResult *result
) {
    PluginState *state = (PluginState *)arguments->external;
    if (state != NULL) state->after_transform += 1;
    (void)result;
}

NAPI_MODULE_EXPORT void native_invalid_free(
    const NativePluginArguments *arguments,
    NativePluginResult *result
) {
    (void)arguments;
    result->free_plugin_source_code_context = free_source_context;
}

static void finalize_state(napi_env env, void *data, void *hint) {
    (void)env;
    (void)hint;
    free(data);
}

static napi_value create_state(napi_env env, napi_callback_info info) {
    (void)info;
    PluginState *state = (PluginState *)calloc(1, sizeof(PluginState));
    napi_value result = NULL;
    if (state == NULL || napi_create_external(env, state, finalize_state, NULL, &result) != napi_ok) {
        free(state);
        return NULL;
    }
    return result;
}

static PluginState *state_argument(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    void *state = NULL;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) return NULL;
    if (napi_get_value_external(env, argv[0], &state) != napi_ok) return NULL;
    return (PluginState *)state;
}

static napi_value state_counts(napi_env env, napi_callback_info info) {
    PluginState *state = state_argument(env, info);
    napi_value result = NULL;
    if (state == NULL || napi_create_object(env, &result) != napi_ok) return NULL;

    const char *names[] = { "observed", "transformed", "afterTransform", "sawResetSource", "cleanups" };
    const uint32_t values[] = {
        state->observed,
        state->transformed,
        state->after_transform,
        state->saw_reset_source,
        state->cleanups,
    };
    for (size_t index = 0; index < sizeof(values) / sizeof(values[0]); index += 1) {
        napi_value value = NULL;
        if (napi_create_uint32(env, values[index], &value) != napi_ok ||
            napi_set_named_property(env, result, names[index], value) != napi_ok) {
            return NULL;
        }
    }
    return result;
}

static napi_value abi_visibility(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = NULL;
    napi_value napi_visible = NULL;
    napi_value internal_hidden = NULL;
    int has_napi = 1;
    int hides_internal = 1;

#if defined(__linux__)
    has_napi = dlsym(RTLD_DEFAULT, "napi_create_object") != NULL;
    hides_internal = dlsym(RTLD_DEFAULT, "ct_bundle_build") == NULL;
#endif

    if (napi_create_object(env, &result) != napi_ok ||
        napi_get_boolean(env, has_napi, &napi_visible) != napi_ok ||
        napi_get_boolean(env, hides_internal, &internal_hidden) != napi_ok ||
        napi_set_named_property(env, result, "napiVisible", napi_visible) != napi_ok ||
        napi_set_named_property(env, result, "internalHidden", internal_hidden) != napi_ok) {
        return NULL;
    }
    return result;
}

static napi_value uv_version_string_value(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = NULL;

#if defined(__linux__)
    const char *version = uv_version_string();
    if (version == NULL || napi_create_string_utf8(env, version, NAPI_AUTO_LENGTH, &result) != napi_ok) return NULL;
#else
    if (napi_get_undefined(env, &result) != napi_ok) return NULL;
#endif

    return result;
}

static napi_value uv_version_value(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = NULL;

#if defined(__linux__)
    if (napi_create_uint32(env, uv_version(), &result) != napi_ok) return NULL;
#else
    if (napi_get_undefined(env, &result) != napi_ok) return NULL;
#endif

    return result;
}

static napi_value uv_gettimeofday_value(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = NULL;

#if defined(__linux__)
    CtUvTimeval64 now;
    if (uv_gettimeofday(&now) != 0 ||
        napi_create_double(env, (double)now.tv_sec * 1000.0 + (double)now.tv_usec / 1000.0, &result) != napi_ok) {
        return NULL;
    }
#else
    if (napi_get_undefined(env, &result) != napi_ok) return NULL;
#endif

    return result;
}

static napi_value uv_semaphore_lifecycle(napi_env env, napi_callback_info info) {
    (void)info;
    int success = 1;

#if defined(__linux__)
    sem_t semaphore;
    success = uv_sem_init(&semaphore, 0) == 0;
    if (success) {
        uv_sem_post(&semaphore);
        uv_sem_wait(&semaphore);
        uv_sem_post(&semaphore);
        success = uv_sem_trywait(&semaphore) == 0;
        uv_sem_destroy(&semaphore);
    }
#endif

    napi_value result = NULL;
    if (napi_get_boolean(env, success, &result) != napi_ok) return NULL;
    return result;
}

static napi_value uv_rwlock_lifecycle(napi_env env, napi_callback_info info) {
    (void)info;
    int success = 1;

#if defined(__linux__)
    pthread_rwlock_t rwlock;
    success = uv_rwlock_init(&rwlock) == 0;
    if (success) {
        uv_rwlock_rdlock(&rwlock);
        uv_rwlock_rdunlock(&rwlock);
        success = uv_rwlock_tryrdlock(&rwlock) == 0;
        if (success) uv_rwlock_rdunlock(&rwlock);
        if (success) {
            uv_rwlock_wrlock(&rwlock);
            uv_rwlock_wrunlock(&rwlock);
            success = uv_rwlock_trywrlock(&rwlock) == 0;
            if (success) uv_rwlock_wrunlock(&rwlock);
        }
        uv_rwlock_destroy(&rwlock);
    }
#endif

    napi_value result = NULL;
    if (napi_get_boolean(env, success, &result) != napi_ok) return NULL;
    return result;
}

static int export_function(napi_env env, napi_value exports, const char *name, napi_callback callback) {
    napi_value function = NULL;
    if (napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, NULL, &function) != napi_ok) return 0;
    return napi_set_named_property(env, exports, name, function) == napi_ok;
}

NAPI_MODULE_INIT() {
    if (!export_function(env, exports, "createState", create_state)) return NULL;
    if (!export_function(env, exports, "stateCounts", state_counts)) return NULL;
    if (!export_function(env, exports, "abiVisibility", abi_visibility)) return NULL;
    if (!export_function(env, exports, "uvVersion", uv_version_value)) return NULL;
    if (!export_function(env, exports, "uvVersionString", uv_version_string_value)) return NULL;
    if (!export_function(env, exports, "uvGettimeofday", uv_gettimeofday_value)) return NULL;
    if (!export_function(env, exports, "uvRwlockLifecycle", uv_rwlock_lifecycle)) return NULL;
    if (!export_function(env, exports, "uvSemaphoreLifecycle", uv_semaphore_lifecycle)) return NULL;
    return exports;
}
