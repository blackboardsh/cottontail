#include "qjs_runner.h"

#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#include <direct.h>
#include <windows.h>
#else
#include <limits.h>
#include <time.h>
#include <unistd.h>
extern char **environ;
#endif

#include "quickjs.h"

#if defined(_WIN32)
#define CT_PLATFORM_STRING "win32"
#elif defined(__APPLE__)
#define CT_PLATFORM_STRING "darwin"
#elif defined(__linux__)
#define CT_PLATFORM_STRING "linux"
#else
#define CT_PLATFORM_STRING "unknown"
#endif

#if defined(__aarch64__) || defined(_M_ARM64)
#define CT_ARCH_STRING "arm64"
#elif defined(__x86_64__) || defined(_M_X64)
#define CT_ARCH_STRING "x64"
#elif defined(__i386__) || defined(_M_IX86)
#define CT_ARCH_STRING "x86"
#else
#define CT_ARCH_STRING "unknown"
#endif

typedef struct {
    const char *name;
    const char *value;
} CtHostEnvEntry;

typedef struct {
    const char *cwd;
    const CtHostEnvEntry *env_entries;
    size_t env_count;
    bool capture_output;
} CtHostSpawnOptions;

typedef struct {
    int exit_code;
    char *stdout_ptr;
    size_t stdout_len;
    char *stderr_ptr;
    size_t stderr_len;
} CtHostSpawnResult;

extern void ct_host_string_free(char *value);
extern void ct_host_buffer_free(char *value);
extern bool ct_host_exists(const char *path);
extern int ct_host_mkdir(const char *path, bool recursive, char **error_out);
extern int ct_host_rm(const char *path, bool recursive, bool force, char **error_out);
extern int ct_host_unlink(const char *path, char **error_out);
extern int ct_host_chmod(const char *path, unsigned int mode, char **error_out);
extern int ct_host_spawn_sync(
    const char *file,
    const char *const *argv,
    size_t argc,
    CtHostSpawnOptions options,
    CtHostSpawnResult *result_out,
    char **error_out
);

struct CtQjsRuntime {
    JSRuntime *runtime;
    JSContext *context;
    JSValue host_object;
    int pending_unhandled_rejections;
    char *last_unhandled_rejection;
};

static char *ct_duplicate_bytes(const char *value, size_t len) {
    char *copy = (char *) malloc(len + 1);

    if (copy == NULL) {
        return NULL;
    }

    memcpy(copy, value, len);
    copy[len] = '\0';
    return copy;
}

static char *ct_duplicate_string(const char *value) {
    return ct_duplicate_bytes(value, strlen(value));
}

static void ct_free_string(char **value_ptr) {
    if (value_ptr == NULL || *value_ptr == NULL) {
        return;
    }

    free(*value_ptr);
    *value_ptr = NULL;
}

static int ct_read_file_bytes(const char *path, char **out_buf, size_t *out_len) {
    FILE *file = fopen(path, "rb");
    char *buffer = NULL;

    if (file == NULL) {
        return -1;
    }

    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return -1;
    }

    long file_size = ftell(file);
    if (file_size < 0) {
        fclose(file);
        return -1;
    }

    if (fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return -1;
    }

    buffer = (char *) malloc((size_t) file_size + 1);
    if (buffer == NULL) {
        fclose(file);
        return -1;
    }

    if (file_size > 0 && fread(buffer, 1, (size_t) file_size, file) != (size_t) file_size) {
        fclose(file);
        free(buffer);
        return -1;
    }

    fclose(file);
    buffer[file_size] = '\0';

    *out_buf = buffer;
    *out_len = (size_t) file_size;
    return 0;
}

static int ct_write_file_bytes(const char *path, const char *data, size_t len) {
    FILE *file = fopen(path, "wb");

    if (file == NULL) {
        return -1;
    }

    if (len > 0 && fwrite(data, 1, len, file) != len) {
        fclose(file);
        return -1;
    }

    fclose(file);
    return 0;
}

static char *ct_copy_value_string(JSContext *ctx, JSValueConst value) {
    const char *message = NULL;
    const char *stack_message = NULL;
    char *copied = NULL;

    message = JS_ToCString(ctx, value);

    if (JS_IsError(value)) {
        JSValue stack = JS_GetPropertyStr(ctx, value, "stack");
        if (!JS_IsUndefined(stack)) {
            stack_message = JS_ToCString(ctx, stack);
            if (stack_message != NULL) {
                if (message != NULL && strstr(stack_message, message) == stack_message) {
                    copied = ct_duplicate_string(stack_message);
                } else if (message != NULL) {
                    size_t message_len = strlen(message);
                    size_t stack_len = strlen(stack_message);
                    copied = (char *) malloc(message_len + stack_len + 2);
                    if (copied != NULL) {
                        memcpy(copied, message, message_len);
                        copied[message_len] = '\n';
                        memcpy(copied + message_len + 1, stack_message, stack_len + 1);
                    }
                } else {
                    copied = ct_duplicate_string(stack_message);
                }
            }
        }
        if (stack_message != NULL) {
            JS_FreeCString(ctx, stack_message);
        }
        JS_FreeValue(ctx, stack);
    }

    if (copied == NULL && message != NULL) {
        copied = ct_duplicate_string(message);
    }

    if (message != NULL) {
        JS_FreeCString(ctx, message);
    }

    if (copied != NULL) {
        return copied;
    }

    return ct_duplicate_string("Unknown JavaScript exception");
}

static char *ct_copy_exception(JSContext *ctx) {
    JSValue exception = JS_GetException(ctx);
    char *copied = ct_copy_value_string(ctx, exception);
    JS_FreeValue(ctx, exception);
    return copied;
}

static int ct_define_string_property_len(
    JSContext *ctx,
    JSValueConst object,
    const char *name,
    size_t name_len,
    const char *value
) {
    JSAtom property = JS_NewAtomLen(ctx, name, name_len);
    JSValue js_value = JS_NewString(ctx, value);
    int status = 0;

    if (property == JS_ATOM_NULL || JS_IsException(js_value)) {
        JS_FreeAtom(ctx, property);
        JS_FreeValue(ctx, js_value);
        return -1;
    }

    status = JS_DefinePropertyValue(ctx, object, property, js_value, JS_PROP_C_W_E);
    JS_FreeAtom(ctx, property);
    return status;
}

static void ct_clear_unhandled_rejection_state(CtQjsRuntime *runtime) {
    runtime->pending_unhandled_rejections = 0;
    ct_free_string(&runtime->last_unhandled_rejection);
}

static void ct_set_error_out(char **error_out, char *message) {
    if (error_out != NULL) {
        *error_out = message;
    } else {
        free(message);
    }
}

static char *ct_copy_js_string(JSContext *ctx, JSValueConst value) {
    size_t len = 0;
    const char *string_value = JS_ToCStringLen(ctx, &len, value);
    char *copy = NULL;

    if (string_value == NULL) {
        return NULL;
    }

    copy = ct_duplicate_bytes(string_value, len);
    JS_FreeCString(ctx, string_value);
    return copy;
}

static void ct_free_string_array(char **values, size_t count) {
    if (values == NULL) {
        return;
    }

    for (size_t index = 0; index < count; index += 1) {
        free(values[index]);
    }

    free(values);
}

static void ct_free_env_entries(CtHostEnvEntry *entries, size_t count) {
    if (entries == NULL) {
        return;
    }

    for (size_t index = 0; index < count; index += 1) {
        free((char *) entries[index].name);
        free((char *) entries[index].value);
    }

    free(entries);
}

static JSValue ct_throw_host_error(JSContext *ctx, char *error_message) {
    JSValue exception = JS_ThrowInternalError(
        ctx,
        "%s",
        error_message != NULL ? error_message : "Host operation failed"
    );

    if (error_message != NULL) {
        ct_host_string_free(error_message);
    }

    return exception;
}

static int ct_parse_string_array(
    JSContext *ctx,
    JSValueConst value,
    char ***out_values,
    size_t *out_count
) {
    JSValue length_value = JS_UNDEFINED;
    uint32_t length = 0;
    char **values = NULL;

    *out_values = NULL;
    *out_count = 0;

    if (JS_IsUndefined(value) || JS_IsNull(value)) {
        return 0;
    }

    if (!JS_IsArray(value)) {
        JS_ThrowTypeError(ctx, "spawnSync args must be an array");
        return -1;
    }

    length_value = JS_GetPropertyStr(ctx, value, "length");
    if (JS_IsException(length_value)) {
        return -1;
    }

    if (JS_ToUint32(ctx, &length, length_value) < 0) {
        JS_FreeValue(ctx, length_value);
        return -1;
    }
    JS_FreeValue(ctx, length_value);

    values = (char **) calloc(length > 0 ? length : 1, sizeof(char *));
    if (values == NULL) {
        JS_ThrowOutOfMemory(ctx);
        return -1;
    }

    for (uint32_t index = 0; index < length; index += 1) {
        JSValue item = JS_GetPropertyUint32(ctx, value, index);
        if (JS_IsException(item)) {
            ct_free_string_array(values, index);
            return -1;
        }

        values[index] = ct_copy_js_string(ctx, item);
        JS_FreeValue(ctx, item);

        if (values[index] == NULL) {
            ct_free_string_array(values, index + 1);
            return -1;
        }
    }

    *out_values = values;
    *out_count = length;
    return 0;
}

static int ct_parse_env_object(
    JSContext *ctx,
    JSValueConst value,
    CtHostEnvEntry **out_entries,
    size_t *out_count
) {
    JSPropertyEnum *properties = NULL;
    uint32_t property_count = 0;
    CtHostEnvEntry *entries = NULL;

    *out_entries = NULL;
    *out_count = 0;

    if (JS_IsUndefined(value) || JS_IsNull(value)) {
        return 0;
    }

    if (!JS_IsObject(value)) {
        JS_ThrowTypeError(ctx, "spawnSync env must be an object");
        return -1;
    }

    if (JS_GetOwnPropertyNames(
            ctx,
            &properties,
            &property_count,
            value,
            JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY
        ) < 0) {
        return -1;
    }

    entries = (CtHostEnvEntry *) calloc(property_count > 0 ? property_count : 1, sizeof(CtHostEnvEntry));
    if (entries == NULL) {
        JS_FreePropertyEnum(ctx, properties, property_count);
        JS_ThrowOutOfMemory(ctx);
        return -1;
    }

    for (uint32_t index = 0; index < property_count; index += 1) {
        JSValue property_value = JS_GetProperty(ctx, value, properties[index].atom);
        const char *name = NULL;

        if (JS_IsException(property_value)) {
            JS_FreePropertyEnum(ctx, properties, property_count);
            ct_free_env_entries(entries, index);
            return -1;
        }

        name = JS_AtomToCString(ctx, properties[index].atom);
        if (name == NULL) {
            JS_FreeValue(ctx, property_value);
            JS_FreePropertyEnum(ctx, properties, property_count);
            ct_free_env_entries(entries, index);
            return -1;
        }

        entries[index].name = ct_duplicate_string(name);
        JS_FreeCString(ctx, name);

        if (entries[index].name == NULL) {
            JS_FreeValue(ctx, property_value);
            JS_FreePropertyEnum(ctx, properties, property_count);
            ct_free_env_entries(entries, index + 1);
            JS_ThrowOutOfMemory(ctx);
            return -1;
        }

        entries[index].value = ct_copy_js_string(ctx, property_value);
        JS_FreeValue(ctx, property_value);

        if (entries[index].value == NULL) {
            JS_FreePropertyEnum(ctx, properties, property_count);
            ct_free_env_entries(entries, index + 1);
            return -1;
        }
    }

    JS_FreePropertyEnum(ctx, properties, property_count);
    *out_entries = entries;
    *out_count = property_count;
    return 0;
}

static void ct_promise_rejection_tracker(
    JSContext *ctx,
    JSValueConst promise,
    JSValueConst reason,
    bool is_handled,
    void *opaque
) {
    CtQjsRuntime *runtime = (CtQjsRuntime *) opaque;
    (void) promise;

    if (is_handled) {
        if (runtime->pending_unhandled_rejections > 0) {
            runtime->pending_unhandled_rejections -= 1;
        }
        if (runtime->pending_unhandled_rejections == 0) {
            ct_free_string(&runtime->last_unhandled_rejection);
        }
        return;
    }

    runtime->pending_unhandled_rejections += 1;
    ct_free_string(&runtime->last_unhandled_rejection);
    runtime->last_unhandled_rejection = ct_copy_value_string(ctx, reason);
}

static int64_t ct_monotonic_nanotime(void) {
#if defined(_WIN32)
    LARGE_INTEGER counter;
    LARGE_INTEGER frequency;

    QueryPerformanceCounter(&counter);
    QueryPerformanceFrequency(&frequency);

    return (int64_t) ((counter.QuadPart * 1000000000LL) / frequency.QuadPart);
#else
    struct timespec ts;

    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t) ts.tv_sec * 1000000000LL + ts.tv_nsec;
#endif
}

static char *ct_get_cwd_string(void) {
#if defined(_WIN32)
    return _getcwd(NULL, 0);
#else
    return getcwd(NULL, 0);
#endif
}

static JSValue ct_console_log(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;

    for (int i = 0; i < argc; i += 1) {
        const char *value = JS_ToCString(ctx, argv[i]);
        if (value == NULL) {
            return JS_EXCEPTION;
        }

        if (i > 0) {
            fputc(' ', stdout);
        }

        fputs(value, stdout);
        JS_FreeCString(ctx, value);
    }

    fputc('\n', stdout);
    fflush(stdout);
    return JS_UNDEFINED;
}

static JSValue ct_console_error(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;

    for (int i = 0; i < argc; i += 1) {
        const char *value = JS_ToCString(ctx, argv[i]);
        if (value == NULL) {
            return JS_EXCEPTION;
        }

        if (i > 0) {
            fputc(' ', stderr);
        }

        fputs(value, stderr);
        JS_FreeCString(ctx, value);
    }

    fputc('\n', stderr);
    fflush(stderr);
    return JS_UNDEFINED;
}

static JSValue ct_nanotime(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;

    return JS_NewBigInt64(ctx, ct_monotonic_nanotime());
}

static JSValue ct_cwd(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    char *cwd = NULL;
    JSValue result;

    (void) this_val;
    (void) argc;
    (void) argv;

    cwd = ct_get_cwd_string();
    if (cwd == NULL) {
        return JS_ThrowInternalError(ctx, "failed to get current working directory");
    }

    result = JS_NewString(ctx, cwd);
    free(cwd);
    return result;
}

static JSValue ct_read_file(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = NULL;
    char *buffer = NULL;
    size_t buffer_len = 0;
    JSValue result;

    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.readFile(path) requires a path");
    }

    path = JS_ToCString(ctx, argv[0]);
    if (path == NULL) {
        return JS_EXCEPTION;
    }

    if (ct_read_file_bytes(path, &buffer, &buffer_len) != 0) {
        JSValue exception = JS_ThrowReferenceError(ctx, "failed to read file '%s'", path);
        JS_FreeCString(ctx, path);
        return exception;
    }

    result = JS_NewStringLen(ctx, buffer, buffer_len);
    free(buffer);
    JS_FreeCString(ctx, path);
    return result;
}

static JSValue ct_write_file(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = NULL;
    const char *data = NULL;
    size_t data_len = 0;

    (void) this_val;

    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "cottontail.writeFile(path, data) requires a path and data");
    }

    path = JS_ToCString(ctx, argv[0]);
    if (path == NULL) {
        return JS_EXCEPTION;
    }

    data = JS_ToCStringLen(ctx, &data_len, argv[1]);
    if (data == NULL) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    if (ct_write_file_bytes(path, data, data_len) != 0) {
        JSValue exception = JS_ThrowReferenceError(ctx, "failed to write file '%s'", path);
        JS_FreeCString(ctx, data);
        JS_FreeCString(ctx, path);
        return exception;
    }

    JS_FreeCString(ctx, data);
    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

static JSValue ct_env(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;

    if (argc >= 1) {
        const char *name = JS_ToCString(ctx, argv[0]);
        const char *value = NULL;

        if (name == NULL) {
            return JS_EXCEPTION;
        }

        value = getenv(name);
        JS_FreeCString(ctx, name);

        if (value == NULL) {
            return JS_UNDEFINED;
        }

        return JS_NewString(ctx, value);
    }

    JSValue result = JS_NewObject(ctx);
    if (JS_IsException(result)) {
        return result;
    }

#if defined(_WIN32)
    LPCH env_block = GetEnvironmentStringsA();
    if (env_block == NULL) {
        JS_FreeValue(ctx, result);
        return JS_ThrowInternalError(ctx, "failed to enumerate environment");
    }

    for (LPCH entry = env_block; *entry != '\0'; entry += strlen(entry) + 1) {
        char *separator = strchr(entry, '=');
        if (separator == NULL || separator == entry) {
            continue;
        }

        size_t name_len = (size_t) (separator - entry);
        if (ct_define_string_property_len(ctx, result, entry, name_len, separator + 1) < 0) {
            FreeEnvironmentStringsA(env_block);
            JS_FreeValue(ctx, result);
            return JS_EXCEPTION;
        }
    }

    FreeEnvironmentStringsA(env_block);
#else
    for (char **entry = environ; entry != NULL && *entry != NULL; entry += 1) {
        char *separator = strchr(*entry, '=');
        if (separator == NULL || separator == *entry) {
            continue;
        }

        size_t name_len = (size_t) (separator - *entry);
        if (ct_define_string_property_len(ctx, result, *entry, name_len, separator + 1) < 0) {
            JS_FreeValue(ctx, result);
            return JS_EXCEPTION;
        }
    }
#endif

    return result;
}

static JSValue ct_exists_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = NULL;
    bool exists = false;

    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.existsSync(path) requires a path");
    }

    path = JS_ToCString(ctx, argv[0]);
    if (path == NULL) {
        return JS_EXCEPTION;
    }

    exists = ct_host_exists(path);
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, exists);
}

static JSValue ct_mkdir_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = NULL;
    bool recursive = false;
    char *error_message = NULL;

    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.mkdirSync(path, recursive) requires a path");
    }

    path = JS_ToCString(ctx, argv[0]);
    if (path == NULL) {
        return JS_EXCEPTION;
    }

    if (argc >= 2) {
        int recursive_value = JS_ToBool(ctx, argv[1]);
        if (recursive_value < 0) {
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
        recursive = recursive_value != 0;
    }

    if (ct_host_mkdir(path, recursive, &error_message) != 0) {
        JS_FreeCString(ctx, path);
        return ct_throw_host_error(ctx, error_message);
    }

    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

static JSValue ct_rm_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = NULL;
    bool recursive = false;
    bool force = false;
    char *error_message = NULL;

    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.rmSync(path, recursive, force) requires a path");
    }

    path = JS_ToCString(ctx, argv[0]);
    if (path == NULL) {
        return JS_EXCEPTION;
    }

    if (argc >= 2) {
        int recursive_value = JS_ToBool(ctx, argv[1]);
        if (recursive_value < 0) {
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
        recursive = recursive_value != 0;
    }

    if (argc >= 3) {
        int force_value = JS_ToBool(ctx, argv[2]);
        if (force_value < 0) {
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
        force = force_value != 0;
    }

    if (ct_host_rm(path, recursive, force, &error_message) != 0) {
        JS_FreeCString(ctx, path);
        return ct_throw_host_error(ctx, error_message);
    }

    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

static JSValue ct_unlink_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = NULL;
    char *error_message = NULL;

    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.unlinkSync(path) requires a path");
    }

    path = JS_ToCString(ctx, argv[0]);
    if (path == NULL) {
        return JS_EXCEPTION;
    }

    if (ct_host_unlink(path, &error_message) != 0) {
        JS_FreeCString(ctx, path);
        return ct_throw_host_error(ctx, error_message);
    }

    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

static JSValue ct_chmod_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = NULL;
    int32_t mode = 0;
    char *error_message = NULL;

    (void) this_val;

    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "cottontail.chmodSync(path, mode) requires a path and mode");
    }

    path = JS_ToCString(ctx, argv[0]);
    if (path == NULL) {
        return JS_EXCEPTION;
    }

    if (JS_ToInt32(ctx, &mode, argv[1]) < 0) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    if (ct_host_chmod(path, (unsigned int) mode, &error_message) != 0) {
        JS_FreeCString(ctx, path);
        return ct_throw_host_error(ctx, error_message);
    }

    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

static JSValue ct_spawn_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *file = NULL;
    char **args = NULL;
    size_t arg_count = 0;
    char *cwd = NULL;
    CtHostEnvEntry *env_entries = NULL;
    size_t env_count = 0;
    bool capture_output = true;
    char *error_message = NULL;
    CtHostSpawnResult result = {0};
    JSValue response = JS_UNDEFINED;

    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.spawnSync(file, args, options) requires a file");
    }

    file = JS_ToCString(ctx, argv[0]);
    if (file == NULL) {
        return JS_EXCEPTION;
    }

    if (argc >= 2 && ct_parse_string_array(ctx, argv[1], &args, &arg_count) != 0) {
        JS_FreeCString(ctx, file);
        return JS_EXCEPTION;
    }

    if (argc >= 3 && !JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) {
        JSValue cwd_value = JS_GetPropertyStr(ctx, argv[2], "cwd");
        JSValue env_value = JS_GetPropertyStr(ctx, argv[2], "env");
        JSValue stdio_value = JS_GetPropertyStr(ctx, argv[2], "stdio");

        if (JS_IsException(cwd_value) || JS_IsException(env_value) || JS_IsException(stdio_value)) {
            JS_FreeValue(ctx, cwd_value);
            JS_FreeValue(ctx, env_value);
            JS_FreeValue(ctx, stdio_value);
            JS_FreeCString(ctx, file);
            ct_free_string_array(args, arg_count);
            return JS_EXCEPTION;
        }

        if (!JS_IsUndefined(cwd_value) && !JS_IsNull(cwd_value)) {
            cwd = ct_copy_js_string(ctx, cwd_value);
            if (cwd == NULL) {
                JS_FreeValue(ctx, cwd_value);
                JS_FreeValue(ctx, env_value);
                JS_FreeValue(ctx, stdio_value);
                JS_FreeCString(ctx, file);
                ct_free_string_array(args, arg_count);
                return JS_EXCEPTION;
            }
        }

        if (ct_parse_env_object(ctx, env_value, &env_entries, &env_count) != 0) {
            JS_FreeValue(ctx, cwd_value);
            JS_FreeValue(ctx, env_value);
            JS_FreeValue(ctx, stdio_value);
            JS_FreeCString(ctx, file);
            ct_free_string_array(args, arg_count);
            free(cwd);
            return JS_EXCEPTION;
        }

        if (!JS_IsUndefined(stdio_value) && !JS_IsNull(stdio_value)) {
            char *stdio = ct_copy_js_string(ctx, stdio_value);
            if (stdio == NULL) {
                JS_FreeValue(ctx, cwd_value);
                JS_FreeValue(ctx, env_value);
                JS_FreeValue(ctx, stdio_value);
                JS_FreeCString(ctx, file);
                ct_free_string_array(args, arg_count);
                ct_free_env_entries(env_entries, env_count);
                free(cwd);
                return JS_EXCEPTION;
            }

            if (strcmp(stdio, "inherit") == 0) {
                capture_output = false;
            } else if (strcmp(stdio, "pipe") != 0) {
                free(stdio);
                JS_FreeValue(ctx, cwd_value);
                JS_FreeValue(ctx, env_value);
                JS_FreeValue(ctx, stdio_value);
                JS_FreeCString(ctx, file);
                ct_free_string_array(args, arg_count);
                ct_free_env_entries(env_entries, env_count);
                free(cwd);
                return JS_ThrowTypeError(ctx, "spawnSync options.stdio must be 'pipe' or 'inherit'");
            }

            free(stdio);
        }

        JS_FreeValue(ctx, cwd_value);
        JS_FreeValue(ctx, env_value);
        JS_FreeValue(ctx, stdio_value);
    }

    if (ct_host_spawn_sync(
            file,
            (const char *const *) args,
            arg_count,
            (CtHostSpawnOptions){
                .cwd = cwd,
                .env_entries = env_entries,
                .env_count = env_count,
                .capture_output = capture_output,
            },
            &result,
            &error_message
        ) != 0) {
        JS_FreeCString(ctx, file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        free(cwd);
        return ct_throw_host_error(ctx, error_message);
    }

    response = JS_NewObject(ctx);
    if (JS_IsException(response)) {
        JS_FreeCString(ctx, file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        free(cwd);
        if (result.stdout_ptr != NULL) {
            ct_host_buffer_free(result.stdout_ptr);
        }
        if (result.stderr_ptr != NULL) {
            ct_host_buffer_free(result.stderr_ptr);
        }
        return response;
    }

    if (JS_SetPropertyStr(ctx, response, "status", JS_NewInt32(ctx, result.exit_code)) < 0 ||
        JS_SetPropertyStr(
            ctx,
            response,
            "stdout",
            JS_NewStringLen(ctx, result.stdout_ptr != NULL ? result.stdout_ptr : "", result.stdout_len)
        ) < 0 ||
        JS_SetPropertyStr(
            ctx,
            response,
            "stderr",
            JS_NewStringLen(ctx, result.stderr_ptr != NULL ? result.stderr_ptr : "", result.stderr_len)
        ) < 0) {
        JS_FreeValue(ctx, response);
        JS_FreeCString(ctx, file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        free(cwd);
        if (result.stdout_ptr != NULL) {
            ct_host_buffer_free(result.stdout_ptr);
        }
        if (result.stderr_ptr != NULL) {
            ct_host_buffer_free(result.stderr_ptr);
        }
        return JS_EXCEPTION;
    }

    JS_FreeCString(ctx, file);
    ct_free_string_array(args, arg_count);
    ct_free_env_entries(env_entries, env_count);
    free(cwd);

    if (result.stdout_ptr != NULL) {
        ct_host_buffer_free(result.stdout_ptr);
    }
    if (result.stderr_ptr != NULL) {
        ct_host_buffer_free(result.stderr_ptr);
    }

    return response;
}

static JSValue ct_exit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t code = 0;

    (void) this_val;

    if (argc >= 1 && JS_ToInt32(ctx, &code, argv[0]) < 0) {
        return JS_EXCEPTION;
    }

    exit(code);
}

static JSValue ct_platform(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;

    return JS_NewString(ctx, CT_PLATFORM_STRING);
}

static JSValue ct_arch(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;

    return JS_NewString(ctx, CT_ARCH_STRING);
}

static int ct_set_import_meta(JSContext *ctx, JSValue module_value, const char *module_name, bool is_main) {
    JSModuleDef *module = (JSModuleDef *) JS_VALUE_GET_PTR(module_value);
    JSValue meta = JS_GetImportMeta(ctx, module);

    if (JS_IsException(meta)) {
        return -1;
    }

    if (JS_SetPropertyStr(ctx, meta, "url", JS_NewString(ctx, module_name)) < 0) {
        JS_FreeValue(ctx, meta);
        return -1;
    }

    if (JS_SetPropertyStr(ctx, meta, "main", JS_NewBool(ctx, is_main)) < 0) {
        JS_FreeValue(ctx, meta);
        return -1;
    }

    JS_FreeValue(ctx, meta);
    return 0;
}

static JSModuleDef *ct_module_loader(JSContext *ctx, const char *module_name, void *opaque, JSValueConst attributes) {
    char *buffer = NULL;
    size_t buffer_len = 0;
    JSValue compiled;
    JSModuleDef *module = NULL;

    (void) opaque;
    (void) attributes;

    if (ct_read_file_bytes(module_name, &buffer, &buffer_len) != 0) {
        JS_ThrowReferenceError(ctx, "failed to load module '%s'", module_name);
        return NULL;
    }

    compiled = JS_Eval(
        ctx,
        buffer,
        buffer_len,
        module_name,
        JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY
    );
    free(buffer);

    if (JS_IsException(compiled)) {
        return NULL;
    }

    if (ct_set_import_meta(ctx, compiled, module_name, false) < 0) {
        JS_FreeValue(ctx, compiled);
        return NULL;
    }

    module = (JSModuleDef *) JS_VALUE_GET_PTR(compiled);
    JS_FreeValue(ctx, compiled);
    return module;
}

static int ct_module_check_attributes(JSContext *ctx, void *opaque, JSValueConst attributes) {
    (void) ctx;
    (void) opaque;
    (void) attributes;
    return 0;
}

static int ct_install_host_api(CtQjsRuntime *runtime) {
    JSContext *ctx = runtime->context;
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue console = JS_NewObject(ctx);
    JSValue cottontail = JS_NewObject(ctx);

    if (JS_IsException(console)) {
        JS_FreeValue(ctx, global);
        return -1;
    }

    if (JS_IsException(cottontail)) {
        JS_FreeValue(ctx, console);
        JS_FreeValue(ctx, global);
        return -1;
    }

    if (JS_SetPropertyStr(ctx, console, "log", JS_NewCFunction(ctx, ct_console_log, "log", 1)) < 0) {
        JS_FreeValue(ctx, cottontail);
        JS_FreeValue(ctx, console);
        JS_FreeValue(ctx, global);
        return -1;
    }

    if (JS_SetPropertyStr(ctx, console, "error", JS_NewCFunction(ctx, ct_console_error, "error", 1)) < 0) {
        JS_FreeValue(ctx, cottontail);
        JS_FreeValue(ctx, console);
        JS_FreeValue(ctx, global);
        return -1;
    }

    if (JS_SetPropertyStr(ctx, global, "console", console) < 0) {
        JS_FreeValue(ctx, cottontail);
        JS_FreeValue(ctx, console);
        JS_FreeValue(ctx, global);
        return -1;
    }

    if (JS_SetPropertyStr(ctx, cottontail, "nanotime", JS_NewCFunction(ctx, ct_nanotime, "nanotime", 0)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "cwd", JS_NewCFunction(ctx, ct_cwd, "cwd", 0)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "readFile", JS_NewCFunction(ctx, ct_read_file, "readFile", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "writeFile", JS_NewCFunction(ctx, ct_write_file, "writeFile", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "env", JS_NewCFunction(ctx, ct_env, "env", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "existsSync", JS_NewCFunction(ctx, ct_exists_sync, "existsSync", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "mkdirSync", JS_NewCFunction(ctx, ct_mkdir_sync, "mkdirSync", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "rmSync", JS_NewCFunction(ctx, ct_rm_sync, "rmSync", 3)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "unlinkSync", JS_NewCFunction(ctx, ct_unlink_sync, "unlinkSync", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "chmodSync", JS_NewCFunction(ctx, ct_chmod_sync, "chmodSync", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "spawnSync", JS_NewCFunction(ctx, ct_spawn_sync, "spawnSync", 3)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "exit", JS_NewCFunction(ctx, ct_exit, "exit", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "platform", JS_NewCFunction(ctx, ct_platform, "platform", 0)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "arch", JS_NewCFunction(ctx, ct_arch, "arch", 0)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "args", JS_NewArray(ctx)) < 0) {
        JS_FreeValue(ctx, cottontail);
        JS_FreeValue(ctx, global);
        return -1;
    }

    runtime->host_object = JS_DupValue(ctx, cottontail);

    if (JS_SetPropertyStr(ctx, global, "cottontail", cottontail) < 0) {
        JS_FreeValue(ctx, runtime->host_object);
        runtime->host_object = JS_UNDEFINED;
        JS_FreeValue(ctx, cottontail);
        JS_FreeValue(ctx, global);
        return -1;
    }

    JS_FreeValue(ctx, global);
    return 0;
}

static int ct_drain_jobs(CtQjsRuntime *runtime, char **error_out) {
    while (JS_IsJobPending(runtime->runtime)) {
        JSContext *job_context = NULL;
        int status = JS_ExecutePendingJob(runtime->runtime, &job_context);

        if (status < 0) {
            ct_set_error_out(error_out, ct_copy_exception(job_context != NULL ? job_context : runtime->context));
            return -1;
        }
    }

    if (runtime->pending_unhandled_rejections > 0) {
        if (runtime->last_unhandled_rejection != NULL) {
            ct_set_error_out(error_out, ct_duplicate_string(runtime->last_unhandled_rejection));
        } else {
            ct_set_error_out(error_out, ct_duplicate_string("Unhandled promise rejection"));
        }
        return -1;
    }

    return 0;
}

CtQjsRuntime *ct_qjs_runtime_create(void) {
    CtQjsRuntime *runtime = (CtQjsRuntime *) calloc(1, sizeof(CtQjsRuntime));

    if (runtime == NULL) {
        return NULL;
    }

    runtime->host_object = JS_UNDEFINED;
    runtime->runtime = JS_NewRuntime();
    if (runtime->runtime == NULL) {
        ct_qjs_runtime_destroy(runtime);
        return NULL;
    }

    runtime->context = JS_NewContext(runtime->runtime);
    if (runtime->context == NULL) {
        ct_qjs_runtime_destroy(runtime);
        return NULL;
    }

    JS_SetModuleLoaderFunc2(runtime->runtime, NULL, ct_module_loader, ct_module_check_attributes, runtime);
    JS_SetHostPromiseRejectionTracker(runtime->runtime, ct_promise_rejection_tracker, runtime);

    if (ct_install_host_api(runtime) != 0) {
        ct_qjs_runtime_destroy(runtime);
        return NULL;
    }

    return runtime;
}

void ct_qjs_runtime_destroy(CtQjsRuntime *runtime) {
    if (runtime == NULL) {
        return;
    }

    ct_free_string(&runtime->last_unhandled_rejection);

    if (runtime->context != NULL) {
        if (!JS_IsUndefined(runtime->host_object)) {
            JS_FreeValue(runtime->context, runtime->host_object);
            runtime->host_object = JS_UNDEFINED;
        }
        JS_FreeContext(runtime->context);
    }

    if (runtime->runtime != NULL) {
        JS_FreeRuntime(runtime->runtime);
    }

    free(runtime);
}

int ct_qjs_runtime_set_args(
    CtQjsRuntime *runtime,
    size_t argc,
    const char *const *argv,
    char **error_out
) {
    JSValue args = JS_NewArray(runtime->context);

    if (error_out != NULL) {
        *error_out = NULL;
    }

    if (JS_IsException(args)) {
        ct_set_error_out(error_out, ct_copy_exception(runtime->context));
        return -1;
    }

    for (size_t i = 0; i < argc; i += 1) {
        if (JS_SetPropertyUint32(runtime->context, args, (uint32_t) i, JS_NewString(runtime->context, argv[i])) < 0) {
            JS_FreeValue(runtime->context, args);
            ct_set_error_out(error_out, ct_copy_exception(runtime->context));
            return -1;
        }
    }

    if (JS_SetPropertyStr(runtime->context, runtime->host_object, "args", args) < 0) {
        JS_FreeValue(runtime->context, args);
        ct_set_error_out(error_out, ct_copy_exception(runtime->context));
        return -1;
    }

    return 0;
}

int ct_qjs_runtime_eval(
    CtQjsRuntime *runtime,
    const uint8_t *source,
    size_t source_len,
    const char *filename,
    char **error_out
) {
    JSValue result = JS_UNDEFINED;
    bool is_module = false;

    if (error_out != NULL) {
        *error_out = NULL;
    }

    ct_clear_unhandled_rejection_state(runtime);
    is_module = JS_DetectModule((const char *) source, source_len);

    if (is_module) {
        result = JS_Eval(
            runtime->context,
            (const char *) source,
            source_len,
            filename,
            JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY
        );

        if (JS_IsException(result)) {
            ct_set_error_out(error_out, ct_copy_exception(runtime->context));
            return -1;
        }

        if (ct_set_import_meta(runtime->context, result, filename, true) < 0) {
            JS_FreeValue(runtime->context, result);
            ct_set_error_out(error_out, ct_copy_exception(runtime->context));
            return -1;
        }

        result = JS_EvalFunction(runtime->context, result);
    } else {
        result = JS_Eval(
            runtime->context,
            (const char *) source,
            source_len,
            filename,
            JS_EVAL_TYPE_GLOBAL
        );
    }

    if (JS_IsException(result)) {
        JS_FreeValue(runtime->context, result);
        ct_set_error_out(error_out, ct_copy_exception(runtime->context));
        return -1;
    }

    if (ct_drain_jobs(runtime, error_out) != 0) {
        JS_FreeValue(runtime->context, result);
        return -1;
    }

    if (JS_IsPromise(result)) {
        JSPromiseStateEnum state = JS_PromiseState(runtime->context, result);

        if (state == JS_PROMISE_REJECTED) {
            JSValue promise_result = JS_PromiseResult(runtime->context, result);
            ct_set_error_out(error_out, ct_copy_value_string(runtime->context, promise_result));
            JS_FreeValue(runtime->context, promise_result);
            JS_FreeValue(runtime->context, result);
            return -1;
        }

        if (state == JS_PROMISE_PENDING) {
            JS_FreeValue(runtime->context, result);
            ct_set_error_out(error_out, ct_duplicate_string("Top-level promise is still pending"));
            return -1;
        }

        JSValue promise_result = JS_PromiseResult(runtime->context, result);
        JS_FreeValue(runtime->context, promise_result);
    }

    JS_FreeValue(runtime->context, result);
    return 0;
}

void ct_qjs_string_free(char *value) {
    free(value);
}
