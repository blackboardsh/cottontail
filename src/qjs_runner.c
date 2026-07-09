#include "qjs_runner.h"

#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#if defined(_WIN32)
#include <direct.h>
#include <windows.h>
#else
#include <dlfcn.h>
#include <ffi/ffi.h>
#include <arpa/inet.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <zlib.h>
extern char **environ;
#endif

#include "quickjs.h"

#define CT_FFI_MAX_ARGS 64
#define CT_JS_STACK_SIZE (8u * 1024u * 1024u)
#define CT_WORKER_STACK_SIZE (32u * 1024u * 1024u)
#define CT_DEFAULT_IDLE_TICK_MS 16u
#define CT_MAX_IDLE_TICK_MS 50u

#if !defined(_WIN32)
static void ct_clear_environment(void) {
    while (environ != NULL && environ[0] != NULL) {
        const char *entry = environ[0];
        const char *equals = strchr(entry, '=');
        if (equals == NULL) break;
        size_t name_len = (size_t)(equals - entry);
        char *name = (char *)malloc(name_len + 1);
        if (name == NULL) return;
        memcpy(name, entry, name_len);
        name[name_len] = '\0';
        unsetenv(name);
        free(name);
    }
}
#endif

#if !defined(_WIN32)
typedef struct CtWorker CtWorker;
typedef struct CtProcessEvent CtProcessEvent;
typedef struct CtFdEvent CtFdEvent;
typedef struct CtFdWatcher CtFdWatcher;
#endif

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
    bool clear_env;
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

typedef enum {
    CT_FFI_TYPE_VOID,
    CT_FFI_TYPE_BOOL,
    CT_FFI_TYPE_U8,
    CT_FFI_TYPE_I8,
    CT_FFI_TYPE_U16,
    CT_FFI_TYPE_I16,
    CT_FFI_TYPE_U32,
    CT_FFI_TYPE_I32,
    CT_FFI_TYPE_U64,
    CT_FFI_TYPE_I64,
    CT_FFI_TYPE_F32,
    CT_FFI_TYPE_F64,
    CT_FFI_TYPE_PTR,
    CT_FFI_TYPE_CSTRING,
    CT_FFI_TYPE_FUNCTION,
} CtFfiType;

typedef union {
    uint8_t u8;
    int8_t i8;
    uint16_t u16;
    int16_t i16;
    uint32_t u32;
    int32_t i32;
    uint64_t u64;
    int64_t i64;
    float f32;
    double f64;
    void *ptr;
} CtFfiValue;

typedef struct CtFfiCallback CtFfiCallback;
static int ct_get_array_buffer_bytes(JSContext *ctx, JSValueConst value, uint8_t **out_data, size_t *out_len);

typedef struct CtFfiCallbackJob {
    CtFfiCallback *callback;
    size_t argc;
    CtFfiValue args[CT_FFI_MAX_ARGS];
    CtFfiValue result;
    bool completed;
    bool wait_for_result;
    struct CtFfiCallbackJob *next;
#if !defined(_WIN32)
    pthread_mutex_t mutex;
    pthread_cond_t cond;
#endif
} CtFfiCallbackJob;

struct CtQjsRuntime {
    JSRuntime *runtime;
    JSContext *context;
    JSValue host_object;
    JSValue process_event_callback;
    JSValue fd_event_callback;
    JSValue worker_event_callback;
    uint32_t next_tick_delay_ms;
    int pending_unhandled_rejections;
    char *last_unhandled_rejection;
    bool draining_jobs;
#if !defined(_WIN32)
    pthread_t owner_thread;
    pthread_mutex_t callback_mutex;
    pthread_mutex_t process_event_mutex;
    CtProcessEvent *process_events_head;
    CtProcessEvent *process_events_tail;
    pthread_mutex_t fd_event_mutex;
    CtFdEvent *fd_events_head;
    CtFdEvent *fd_events_tail;
    pthread_mutex_t worker_event_mutex;
    struct CtWorkerEvent *worker_events_head;
    struct CtWorkerEvent *worker_events_tail;
    uint32_t next_fd_watch_id;
    CtWorker *worker;
#endif
    CtFfiCallbackJob *callback_jobs_head;
    CtFfiCallbackJob *callback_jobs_tail;
};

#if !defined(_WIN32)
typedef struct CtHttpRequest {
    uint32_t id;
    int client_fd;
    char *method;
    char *url;
    char *headers_text;
    char *body;
    size_t body_len;
    bool claimed;
    bool completed;
    int status;
    char *response_headers_text;
    char *response_body;
    size_t response_body_len;
    pthread_mutex_t mutex;
    pthread_cond_t cond;
    struct CtHttpRequest *next;
} CtHttpRequest;

typedef struct CtHttpServer {
    uint32_t id;
    int listen_fd;
    uint16_t port;
    char *hostname;
    bool stopped;
    pthread_t thread;
    pthread_mutex_t mutex;
    CtHttpRequest *requests;
    struct CtHttpServer *next;
} CtHttpServer;

static pthread_mutex_t ct_http_servers_mutex = PTHREAD_MUTEX_INITIALIZER;
static CtHttpServer *ct_http_servers = NULL;
static uint32_t ct_next_http_server_id = 1;
static uint32_t ct_next_http_request_id = 1;

typedef struct {
    char *data;
    size_t len;
    size_t cap;
} CtByteBuffer;

typedef enum {
    CT_PROCESS_STDIO_PIPE,
    CT_PROCESS_STDIO_INHERIT,
    CT_PROCESS_STDIO_IGNORE,
} CtProcessStdioMode;

typedef enum {
    CT_PROCESS_EVENT_STDOUT,
    CT_PROCESS_EVENT_STDERR,
    CT_PROCESS_EVENT_EXIT,
} CtProcessEventKind;

struct CtProcessEvent {
    uint32_t process_id;
    CtProcessEventKind kind;
    char *data;
    size_t data_len;
    int exit_code;
    int signal_code;
    bool killed;
    struct CtProcessEvent *next;
};

typedef struct CtProcess {
    uint32_t id;
    CtQjsRuntime *runtime;
    pid_t pid;
    int stdin_fd;
    int stdout_fd;
    int stderr_fd;
    CtByteBuffer stdout_buffer;
    CtByteBuffer stderr_buffer;
    int exit_code;
    int signal_code;
    bool completed;
    bool killed;
    pthread_t thread;
    pthread_mutex_t mutex;
    struct CtProcess *next;
} CtProcess;

static pthread_mutex_t ct_processes_mutex = PTHREAD_MUTEX_INITIALIZER;
static CtProcess *ct_processes = NULL;
static uint32_t ct_next_process_id = 1;

struct CtFdEvent {
    uint32_t watch_id;
    char *type;
    char *data;
    size_t data_len;
    char *message;
    struct CtFdEvent *next;
};

struct CtFdWatcher {
    uint32_t id;
    int fd;
    size_t max_bytes;
    CtQjsRuntime *runtime;
    pthread_t thread;
    pthread_mutex_t mutex;
    bool active;
    struct CtFdWatcher *next;
};

static pthread_mutex_t ct_fd_watchers_mutex = PTHREAD_MUTEX_INITIALIZER;
static CtFdWatcher *ct_fd_watchers = NULL;

typedef struct CtWorkerMessage {
    char *json;
    struct CtWorkerMessage *next;
} CtWorkerMessage;

typedef struct CtWorkerEvent {
    uint32_t worker_id;
    struct CtWorkerEvent *next;
} CtWorkerEvent;

struct CtWorker {
    uint32_t id;
    pthread_t thread;
    bool terminated;
    pthread_mutex_t mutex;
    CtQjsRuntime *parent_runtime;
    CtWorkerMessage *parent_to_worker_head;
    CtWorkerMessage *parent_to_worker_tail;
    CtWorkerMessage *worker_to_parent_head;
    CtWorkerMessage *worker_to_parent_tail;
    struct CtWorker *next;
};

static pthread_mutex_t ct_workers_mutex = PTHREAD_MUTEX_INITIALIZER;
static CtWorker *ct_workers = NULL;
static uint32_t ct_next_worker_id = 1;
#endif

static JSValue ct_throw_host_error(JSContext *ctx, char *error_message);
static int ct_drain_jobs(CtQjsRuntime *runtime, char **error_out);
#if !defined(_WIN32)
static void *ct_fd_watcher_thread(void *opaque);
static void ct_fd_watcher_set_active(CtFdWatcher *watcher, bool active);
static void ct_fd_watchers_remove(CtFdWatcher *watcher);
static bool ct_fd_watcher_stop_id(uint32_t id);
#endif

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

static bool ct_debug_flag(const char *name) {
    const char *value = getenv(name);
    return value != NULL && value[0] != 0 && strcmp(value, "0") != 0;
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

static int ct_js_value_to_native_u64(JSContext *ctx, JSValueConst value, uint64_t *out) {
    if (JS_IsUndefined(value) || JS_IsNull(value)) {
        *out = 0;
        return 0;
    }

    if (JS_IsArrayBuffer(value)) {
        size_t size = 0;
        uint8_t *data = JS_GetArrayBuffer(ctx, &size, value);
        (void) size;
        if (data == NULL) {
            return -1;
        }
        *out = (uint64_t) (uintptr_t) data;
        return 0;
    }

    if (JS_GetTypedArrayType(value) >= 0) {
        size_t byte_offset = 0;
        size_t byte_length = 0;
        size_t bytes_per_element = 0;
        size_t buffer_size = 0;
        uint8_t *data = NULL;
        JSValue buffer = JS_GetTypedArrayBuffer(ctx, value, &byte_offset, &byte_length, &bytes_per_element);

        (void) byte_length;
        (void) bytes_per_element;

        if (JS_IsException(buffer)) {
            return -1;
        }

        data = JS_GetArrayBuffer(ctx, &buffer_size, buffer);
        JS_FreeValue(ctx, buffer);
        if (data == NULL || byte_offset > buffer_size) {
            return -1;
        }

        *out = (uint64_t) (uintptr_t) (data + byte_offset);
        return 0;
    }

    if (JS_IsObject(value)) {
        JSValue buffer = JS_GetPropertyStr(ctx, value, "buffer");
        if (JS_IsException(buffer)) {
            return -1;
        }
        if (JS_IsArrayBuffer(buffer)) {
            JSValue byte_offset_value = JS_GetPropertyStr(ctx, value, "byteOffset");
            uint64_t byte_offset = 0;
            size_t size = 0;
            uint8_t *data = NULL;

            if (JS_IsException(byte_offset_value)) {
                JS_FreeValue(ctx, buffer);
                return -1;
            }
            if (JS_IsBigInt(byte_offset_value)) {
                if (JS_ToBigUint64(ctx, &byte_offset, byte_offset_value) < 0) {
                    JS_FreeValue(ctx, byte_offset_value);
                    JS_FreeValue(ctx, buffer);
                    return -1;
                }
            } else {
                double byte_offset_number = 0;
                if (JS_ToFloat64(ctx, &byte_offset_number, byte_offset_value) < 0 || byte_offset_number < 0) {
                    JS_FreeValue(ctx, byte_offset_value);
                    JS_FreeValue(ctx, buffer);
                    return -1;
                }
                byte_offset = (uint64_t) byte_offset_number;
            }
            JS_FreeValue(ctx, byte_offset_value);

            data = JS_GetArrayBuffer(ctx, &size, buffer);
            JS_FreeValue(ctx, buffer);
            if (data == NULL || byte_offset > size) {
                return -1;
            }
            *out = (uint64_t) (uintptr_t) (data + byte_offset);
            return 0;
        }
        JS_FreeValue(ctx, buffer);
    }

    if (JS_IsBigInt(value) && JS_ToBigUint64(ctx, out, value) == 0) {
        return 0;
    }

    if (JS_IsNumber(value)) {
        double number = 0;
        if (JS_ToFloat64(ctx, &number, value) < 0) {
            return -1;
        }
        *out = (uint64_t) number;
        return 0;
    }

    return -1;
}

static void ct_external_array_buffer_noop(JSRuntime *rt, void *opaque, void *ptr) {
    (void) rt;
    (void) opaque;
    (void) ptr;
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

static int ct_get_optional_float64_property(
    JSContext *ctx,
    JSValueConst object,
    const char *name,
    double *out_value
) {
    JSValue value = JS_GetPropertyStr(ctx, object, name);

    if (JS_IsException(value)) {
        return -1;
    }

    if (!JS_IsUndefined(value) && !JS_IsNull(value)) {
        if (JS_ToFloat64(ctx, out_value, value) < 0) {
            JS_FreeValue(ctx, value);
            return -1;
        }
    }

    JS_FreeValue(ctx, value);
    return 0;
}

static int ct_get_optional_bool_property(
    JSContext *ctx,
    JSValueConst object,
    const char *name,
    bool *out_value
) {
    JSValue value = JS_GetPropertyStr(ctx, object, name);
    int bool_value = 0;

    if (JS_IsException(value)) {
        return -1;
    }

    if (!JS_IsUndefined(value) && !JS_IsNull(value)) {
        bool_value = JS_ToBool(ctx, value);
        if (bool_value < 0) {
            JS_FreeValue(ctx, value);
            return -1;
        }
        *out_value = bool_value != 0;
    }

    JS_FreeValue(ctx, value);
    return 0;
}

static int ct_get_optional_uint32_property(
    JSContext *ctx,
    JSValueConst object,
    const char *name,
    uint32_t *out_value
) {
    JSValue value = JS_GetPropertyStr(ctx, object, name);

    if (JS_IsException(value)) {
        return -1;
    }

    if (!JS_IsUndefined(value) && !JS_IsNull(value)) {
        if (JS_ToUint32(ctx, out_value, value) < 0) {
            JS_FreeValue(ctx, value);
            return -1;
        }
    }

    JS_FreeValue(ctx, value);
    return 0;
}

static int ct_get_optional_string_property(
    JSContext *ctx,
    JSValueConst object,
    const char *name,
    char **out_value
) {
    JSValue value = JS_GetPropertyStr(ctx, object, name);

    if (JS_IsException(value)) {
        return -1;
    }

    if (!JS_IsUndefined(value) && !JS_IsNull(value)) {
        char *copy = ct_copy_js_string(ctx, value);
        if (copy == NULL) {
            JS_FreeValue(ctx, value);
            return -1;
        }
        free(*out_value);
        *out_value = copy;
    }

    JS_FreeValue(ctx, value);
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

static JSValue ct_sleep(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double ms = 0;

    (void) this_val;

    if (argc < 1 || JS_ToFloat64(ctx, &ms, argv[0]) < 0) {
        return JS_ThrowTypeError(ctx, "cottontail.sleep(ms) requires a duration in milliseconds");
    }

    if (ms <= 0) {
        return JS_UNDEFINED;
    }

#if defined(_WIN32)
    Sleep((DWORD) ms);
#else
    struct timespec duration;
    duration.tv_sec = (time_t) (ms / 1000);
    duration.tv_nsec = (long) ((ms - ((double) duration.tv_sec * 1000.0)) * 1000000.0);
    while (nanosleep(&duration, &duration) != 0 && errno == EINTR) {}
#endif

    return JS_UNDEFINED;
}

static JSValue ct_drain_jobs_host(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    CtQjsRuntime *runtime = (CtQjsRuntime *) JS_GetContextOpaque(ctx);
    char *error_message = NULL;

    (void) this_val;
    (void) argc;
    (void) argv;

    if (runtime == NULL) {
        return JS_ThrowInternalError(ctx, "Cottontail runtime is not available");
    }

    if (ct_drain_jobs(runtime, &error_message) != 0) {
        return ct_throw_host_error(ctx, error_message);
    }

    return JS_UNDEFINED;
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

static JSValue ct_pid(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;

#if defined(_WIN32)
    return JS_NewInt32(ctx, (int32_t) GetCurrentProcessId());
#else
    return JS_NewInt32(ctx, (int32_t) getpid());
#endif
}

static JSValue ct_kill_process(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t pid = 0;
    int32_t signal_number = SIGTERM;
    (void) this_val;

    if (argc < 1) return JS_ThrowTypeError(ctx, "cottontail.kill(pid[, signal]) requires a process id");
    if (JS_ToInt32(ctx, &pid, argv[0]) != 0) return JS_EXCEPTION;
    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1]) && JS_ToInt32(ctx, &signal_number, argv[1]) != 0) {
        return JS_EXCEPTION;
    }

#if defined(_WIN32)
    return JS_ThrowInternalError(ctx, "cottontail.kill is not implemented on Windows yet");
#else
    if (kill((pid_t) pid, signal_number) != 0) {
        return JS_ThrowInternalError(ctx, "%s", strerror(errno));
    }
    return JS_NewBool(ctx, true);
#endif
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

static JSValue ct_read_file_buffer(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = NULL;
    char *buffer = NULL;
    size_t buffer_len = 0;
    JSValue result;

    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.readFileBuffer(path) requires a path");
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

    result = JS_NewArrayBufferCopy(ctx, (const uint8_t *) buffer, buffer_len);
    free(buffer);
    JS_FreeCString(ctx, path);
    return result;
}

static int ct_fill_random_bytes(uint8_t *buffer, size_t len) {
    if (len == 0) return 0;
#if defined(_WIN32)
    (void) buffer;
    errno = ENOSYS;
    return -1;
#elif defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
    arc4random_buf(buffer, len);
    return 0;
#else
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) return -1;
    size_t offset = 0;
    while (offset < len) {
        ssize_t count = read(fd, buffer + offset, len - offset);
        if (count > 0) {
            offset += (size_t) count;
            continue;
        }
        if (count < 0 && errno == EINTR) continue;
        close(fd);
        return -1;
    }
    close(fd);
    return 0;
#endif
}

static JSValue ct_random_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int64_t len_value = 0;
    uint8_t *buffer = NULL;
    JSValue result;
    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.randomBytes(size) requires a byte length");
    }
    if (JS_ToInt64(ctx, &len_value, argv[0]) != 0) return JS_EXCEPTION;
    if (len_value < 0 || len_value > INT32_MAX) {
        return JS_ThrowRangeError(ctx, "Invalid random byte length");
    }

    buffer = (uint8_t *) malloc((size_t) len_value > 0 ? (size_t) len_value : 1);
    if (buffer == NULL) return JS_ThrowOutOfMemory(ctx);
    if (ct_fill_random_bytes(buffer, (size_t) len_value) != 0) {
        JSValue exception = JS_ThrowInternalError(ctx, "%s", strerror(errno));
        free(buffer);
        return exception;
    }
    result = JS_NewArrayBufferCopy(ctx, buffer, (size_t) len_value);
    free(buffer);
    return result;
}

static JSValue ct_write_file(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = NULL;
    const char *data = NULL;
    size_t data_len = 0;
    uint8_t *buffer_data = NULL;
    size_t buffer_len = 0;
    int data_is_buffer = 0;

    (void) this_val;

    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "cottontail.writeFile(path, data) requires a path and data");
    }

    path = JS_ToCString(ctx, argv[0]);
    if (path == NULL) {
        return JS_EXCEPTION;
    }

    if (ct_get_array_buffer_bytes(ctx, argv[1], &buffer_data, &buffer_len) == 0) {
        data_is_buffer = 1;
        data = (const char *) buffer_data;
        data_len = buffer_len;
    } else {
        data = JS_ToCStringLen(ctx, &data_len, argv[1]);
        if (data == NULL) {
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
    }

    if (ct_write_file_bytes(path, data, data_len) != 0) {
        JSValue exception = JS_ThrowReferenceError(ctx, "failed to write file '%s'", path);
        if (!data_is_buffer) {
            JS_FreeCString(ctx, data);
        }
        JS_FreeCString(ctx, path);
        return exception;
    }

    if (!data_is_buffer) {
        JS_FreeCString(ctx, data);
    }
    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

static int ct_open_flags_from_string(const char *flags, int *out_flags) {
#if defined(_WIN32)
    (void) flags;
    (void) out_flags;
    return -1;
#else
    int value = 0;

    if (flags == NULL || strcmp(flags, "r") == 0) {
        value = O_RDONLY;
    } else if (strcmp(flags, "r+") == 0) {
        value = O_RDWR;
    } else if (strcmp(flags, "w") == 0) {
        value = O_WRONLY | O_CREAT | O_TRUNC;
    } else if (strcmp(flags, "w+") == 0) {
        value = O_RDWR | O_CREAT | O_TRUNC;
    } else if (strcmp(flags, "a") == 0) {
        value = O_WRONLY | O_CREAT | O_APPEND;
    } else if (strcmp(flags, "a+") == 0) {
        value = O_RDWR | O_CREAT | O_APPEND;
    } else if (strcmp(flags, "wx") == 0) {
        value = O_WRONLY | O_CREAT | O_TRUNC | O_EXCL;
    } else if (strcmp(flags, "wx+") == 0) {
        value = O_RDWR | O_CREAT | O_TRUNC | O_EXCL;
    } else if (strcmp(flags, "ax") == 0) {
        value = O_WRONLY | O_CREAT | O_APPEND | O_EXCL;
    } else if (strcmp(flags, "ax+") == 0) {
        value = O_RDWR | O_CREAT | O_APPEND | O_EXCL;
    } else {
        return -1;
    }

    *out_flags = value;
    return 0;
#endif
}

static JSValue ct_open_fd(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = NULL;
    const char *flags_string = "r";
    const char *allocated_flags = NULL;
    int open_flags = 0;
    int32_t mode = 0666;
    int fd = -1;

    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.openFd(path[, flags[, mode]]) requires a path");
    }

    path = JS_ToCString(ctx, argv[0]);
    if (path == NULL) {
        return JS_EXCEPTION;
    }

    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        allocated_flags = JS_ToCString(ctx, argv[1]);
        if (allocated_flags == NULL) {
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
        flags_string = allocated_flags;
    }

    if (argc >= 3 && !JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) {
        if (JS_ToInt32(ctx, &mode, argv[2]) != 0) {
            if (allocated_flags != NULL) JS_FreeCString(ctx, allocated_flags);
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
    }

    if (ct_open_flags_from_string(flags_string, &open_flags) != 0) {
        JSValue exception = JS_ThrowTypeError(ctx, "unsupported open flags: %s", flags_string);
        if (allocated_flags != NULL) JS_FreeCString(ctx, allocated_flags);
        JS_FreeCString(ctx, path);
        return exception;
    }

#if defined(_WIN32)
    fd = -1;
#else
    fd = open(path, open_flags, (mode_t) mode);
#endif

    if (fd < 0) {
        JSValue exception = JS_ThrowInternalError(ctx, "open failed for '%s': %s", path, strerror(errno));
        if (allocated_flags != NULL) JS_FreeCString(ctx, allocated_flags);
        JS_FreeCString(ctx, path);
        return exception;
    }

    if (allocated_flags != NULL) JS_FreeCString(ctx, allocated_flags);
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, fd);
}

static JSValue ct_read_fd(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd = -1;
    int32_t max_len = 65536;
    uint8_t *buffer = NULL;
    ssize_t count = -1;

    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.readFd(fd[, maxBytes]) requires a file descriptor");
    }

    if (JS_ToInt32(ctx, &fd, argv[0]) != 0) {
        return JS_EXCEPTION;
    }

    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        if (JS_ToInt32(ctx, &max_len, argv[1]) != 0) {
            return JS_EXCEPTION;
        }
    }

    if (fd < 0) {
        return JS_ThrowRangeError(ctx, "invalid file descriptor: %d", fd);
    }
    if (max_len <= 0) {
        max_len = 65536;
    }
    if (max_len > 1024 * 1024) {
        max_len = 1024 * 1024;
    }

#if defined(_WIN32)
    return JS_ThrowInternalError(ctx, "readFd is not implemented on Windows yet");
#else
    {
        struct pollfd poll_fd;
        int ready = 0;

        poll_fd.fd = fd;
        poll_fd.events = POLLIN | POLLHUP | POLLERR;
        poll_fd.revents = 0;

        ready = poll(&poll_fd, 1, 0);
        if (ready == 0) {
            return JS_NULL;
        }
        if (ready < 0) {
            if (errno == EINTR) return JS_NULL;
            return JS_ThrowInternalError(ctx, "poll failed for fd %d: %s", fd, strerror(errno));
        }
        if ((poll_fd.revents & POLLNVAL) != 0) {
            return JS_ThrowInternalError(ctx, "invalid file descriptor: %d", fd);
        }
        if ((poll_fd.revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
            return JS_NULL;
        }
    }

    buffer = (uint8_t *) malloc((size_t) max_len);
    if (buffer == NULL) {
        return JS_ThrowOutOfMemory(ctx);
    }

    count = read(fd, buffer, (size_t) max_len);
    if (count < 0) {
        JSValue exception;
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
            free(buffer);
            return JS_NULL;
        }
        exception = JS_ThrowInternalError(ctx, "read failed for fd %d: %s", fd, strerror(errno));
        free(buffer);
        return exception;
    }

    {
        JSValue result = JS_NewArrayBufferCopy(ctx, buffer, (size_t) count);
        free(buffer);
        return result;
    }
#endif
}

static JSValue ct_close_fd(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd = -1;

    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.closeFd(fd) requires a file descriptor");
    }

    if (JS_ToInt32(ctx, &fd, argv[0]) != 0) {
        return JS_EXCEPTION;
    }

    if (fd < 0) {
        return JS_ThrowRangeError(ctx, "invalid file descriptor: %d", fd);
    }

#if defined(_WIN32)
    return JS_ThrowInternalError(ctx, "closeFd is not implemented on Windows yet");
#else
    if (close(fd) != 0) {
        return JS_ThrowInternalError(ctx, "close failed for fd %d: %s", fd, strerror(errno));
    }
#endif

    return JS_UNDEFINED;
}

static JSValue ct_fd_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd = -1;
    uint8_t *bytes = NULL;
    size_t len = 0;
    const char *string_value = NULL;
    size_t string_len = 0;
    bool ok = true;
    (void) this_val;

    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "cottontail.fdWrite(fd, data) requires a file descriptor and data");
    }
    if (JS_ToInt32(ctx, &fd, argv[0]) != 0) return JS_EXCEPTION;
    if (fd < 0) return JS_NewBool(ctx, false);

    if (ct_get_array_buffer_bytes(ctx, argv[1], &bytes, &len) != 0) {
        string_value = JS_ToCStringLen(ctx, &string_len, argv[1]);
        if (string_value == NULL) return JS_EXCEPTION;
        bytes = (uint8_t *) string_value;
        len = string_len;
    }

    {
        size_t written_total = 0;
        while (written_total < len) {
            ssize_t written = write(fd, bytes + written_total, len - written_total);
            if (written < 0) {
                if (errno == EINTR) continue;
                ok = false;
                break;
            }
            written_total += (size_t) written;
        }
    }

    if (string_value != NULL) JS_FreeCString(ctx, string_value);
    return JS_NewBool(ctx, ok);
}

static JSValue ct_fd_watch_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    CtQjsRuntime *runtime = (CtQjsRuntime *) JS_GetContextOpaque(ctx);
    int32_t fd = -1;
    int32_t max_bytes_value = 65536;
    size_t max_bytes = 65536;
    (void) this_val;

    if (runtime == NULL || argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.fdWatchStart(fd[, maxBytes]) requires a file descriptor");
    }
    if (JS_ToInt32(ctx, &fd, argv[0]) != 0) return JS_EXCEPTION;
    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1]) && JS_ToInt32(ctx, &max_bytes_value, argv[1]) != 0) {
        return JS_EXCEPTION;
    }
    if (fd < 0) return JS_ThrowRangeError(ctx, "invalid file descriptor: %d", fd);
    if (max_bytes_value > 0) max_bytes = (size_t) max_bytes_value;
    if (max_bytes > 1024 * 1024) max_bytes = 1024 * 1024;

#if defined(_WIN32)
    return JS_ThrowInternalError(ctx, "fdWatchStart is not implemented on Windows yet");
#else
    CtFdWatcher *watcher = (CtFdWatcher *) calloc(1, sizeof(CtFdWatcher));
    if (watcher == NULL) return JS_ThrowOutOfMemory(ctx);

    watcher->id = ++runtime->next_fd_watch_id;
    if (watcher->id == 0) watcher->id = ++runtime->next_fd_watch_id;
    watcher->fd = fd;
    watcher->max_bytes = max_bytes;
    watcher->runtime = runtime;
    watcher->active = true;
    pthread_mutex_init(&watcher->mutex, NULL);
    if (ct_debug_flag("COTTONTAIL_FD_DEBUG")) {
        fprintf(stderr, "[cottontail:fd] start id=%u fd=%d max=%zu\n", watcher->id, watcher->fd, watcher->max_bytes);
        fflush(stderr);
    }

    pthread_mutex_lock(&ct_fd_watchers_mutex);
    watcher->next = ct_fd_watchers;
    ct_fd_watchers = watcher;
    pthread_mutex_unlock(&ct_fd_watchers_mutex);

    if (pthread_create(&watcher->thread, NULL, ct_fd_watcher_thread, watcher) != 0) {
        ct_fd_watcher_set_active(watcher, false);
        ct_fd_watchers_remove(watcher);
        pthread_mutex_destroy(&watcher->mutex);
        free(watcher);
        return JS_ThrowInternalError(ctx, "failed to create fd watcher thread");
    }
    pthread_detach(watcher->thread);

    JSValue result = JS_NewObject(ctx);
    if (JS_IsException(result)) return result;
    if (JS_SetPropertyStr(ctx, result, "id", JS_NewUint32(ctx, watcher->id)) < 0) {
        JS_FreeValue(ctx, result);
        return JS_EXCEPTION;
    }
    return result;
#endif
}

static JSValue ct_fd_watch_stop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t id = 0;
    (void) this_val;

    if (argc < 1) return JS_NewBool(ctx, false);
    if (JS_ToInt32(ctx, &id, argv[0]) != 0) return JS_EXCEPTION;
#if defined(_WIN32)
    return JS_NewBool(ctx, false);
#else
    return JS_NewBool(ctx, id > 0 && ct_fd_watcher_stop_id((uint32_t) id));
#endif
}

static JSValue ct_fd_set_event_handler(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    CtQjsRuntime *runtime = (CtQjsRuntime *) JS_GetContextOpaque(ctx);
    (void) this_val;

    if (runtime == NULL) {
        return JS_ThrowInternalError(ctx, "Cottontail runtime is not available");
    }
    if (argc < 1 || JS_IsUndefined(argv[0]) || JS_IsNull(argv[0])) {
        if (!JS_IsUndefined(runtime->fd_event_callback)) {
            JS_FreeValue(ctx, runtime->fd_event_callback);
        }
        runtime->fd_event_callback = JS_UNDEFINED;
        return JS_UNDEFINED;
    }
    if (!JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "fdSetEventHandler requires a function, null, or undefined");
    }
    if (!JS_IsUndefined(runtime->fd_event_callback)) {
        JS_FreeValue(ctx, runtime->fd_event_callback);
    }
    runtime->fd_event_callback = JS_DupValue(ctx, argv[0]);
    return JS_UNDEFINED;
}

static JSValue ct_worker_set_event_handler(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    CtQjsRuntime *runtime = (CtQjsRuntime *) JS_GetContextOpaque(ctx);
    (void) this_val;

    if (runtime == NULL) {
        return JS_ThrowInternalError(ctx, "Cottontail runtime is not available");
    }
    if (argc < 1 || JS_IsUndefined(argv[0]) || JS_IsNull(argv[0])) {
        if (!JS_IsUndefined(runtime->worker_event_callback)) {
            JS_FreeValue(ctx, runtime->worker_event_callback);
        }
        runtime->worker_event_callback = JS_UNDEFINED;
        return JS_UNDEFINED;
    }
    if (!JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "workerSetEventHandler requires a function, null, or undefined");
    }
    if (!JS_IsUndefined(runtime->worker_event_callback)) {
        JS_FreeValue(ctx, runtime->worker_event_callback);
    }
    runtime->worker_event_callback = JS_DupValue(ctx, argv[0]);
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

static double ct_stat_time_ms(time_t seconds, long nanoseconds) {
    return ((double) seconds * 1000.0) + ((double) nanoseconds / 1000000.0);
}

static double ct_stat_atime_ms(const struct stat *stat_value) {
#if defined(__APPLE__) || defined(__MACH__)
    return ct_stat_time_ms(stat_value->st_atimespec.tv_sec, stat_value->st_atimespec.tv_nsec);
#elif defined(__linux__)
    return ct_stat_time_ms(stat_value->st_atim.tv_sec, stat_value->st_atim.tv_nsec);
#else
    return ct_stat_time_ms(stat_value->st_atime, 0);
#endif
}

static double ct_stat_mtime_ms(const struct stat *stat_value) {
#if defined(__APPLE__) || defined(__MACH__)
    return ct_stat_time_ms(stat_value->st_mtimespec.tv_sec, stat_value->st_mtimespec.tv_nsec);
#elif defined(__linux__)
    return ct_stat_time_ms(stat_value->st_mtim.tv_sec, stat_value->st_mtim.tv_nsec);
#else
    return ct_stat_time_ms(stat_value->st_mtime, 0);
#endif
}

static double ct_stat_ctime_ms(const struct stat *stat_value) {
#if defined(__APPLE__) || defined(__MACH__)
    return ct_stat_time_ms(stat_value->st_ctimespec.tv_sec, stat_value->st_ctimespec.tv_nsec);
#elif defined(__linux__)
    return ct_stat_time_ms(stat_value->st_ctim.tv_sec, stat_value->st_ctim.tv_nsec);
#else
    return ct_stat_time_ms(stat_value->st_ctime, 0);
#endif
}

static double ct_stat_birthtime_ms(const struct stat *stat_value) {
#if defined(__APPLE__) || defined(__MACH__)
    return ct_stat_time_ms(stat_value->st_birthtimespec.tv_sec, stat_value->st_birthtimespec.tv_nsec);
#else
    return ct_stat_ctime_ms(stat_value);
#endif
}

static int ct_define_stat_fields(JSContext *ctx, JSValueConst result, const struct stat *stat_value) {
    if (JS_SetPropertyStr(ctx, result, "size", JS_NewFloat64(ctx, (double) stat_value->st_size)) < 0 ||
        JS_SetPropertyStr(ctx, result, "mode", JS_NewInt32(ctx, (int32_t) stat_value->st_mode)) < 0 ||
        JS_SetPropertyStr(ctx, result, "atimeMs", JS_NewFloat64(ctx, ct_stat_atime_ms(stat_value))) < 0 ||
        JS_SetPropertyStr(ctx, result, "mtimeMs", JS_NewFloat64(ctx, ct_stat_mtime_ms(stat_value))) < 0 ||
        JS_SetPropertyStr(ctx, result, "ctimeMs", JS_NewFloat64(ctx, ct_stat_ctime_ms(stat_value))) < 0 ||
        JS_SetPropertyStr(ctx, result, "birthtimeMs", JS_NewFloat64(ctx, ct_stat_birthtime_ms(stat_value))) < 0 ||
        JS_SetPropertyStr(ctx, result, "isFile", JS_NewBool(ctx, S_ISREG(stat_value->st_mode))) < 0 ||
        JS_SetPropertyStr(ctx, result, "isDirectory", JS_NewBool(ctx, S_ISDIR(stat_value->st_mode))) < 0 ||
        JS_SetPropertyStr(ctx, result, "isSymbolicLink", JS_NewBool(ctx, S_ISLNK(stat_value->st_mode))) < 0) {
        return -1;
    }
    return 0;
}

static JSValue ct_stat_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = NULL;
    bool follow_links = true;
    struct stat stat_value;
    JSValue result;

    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.statSync(path) requires a path");
    }

    path = JS_ToCString(ctx, argv[0]);
    if (path == NULL) {
        return JS_EXCEPTION;
    }

    if (argc >= 2) {
        follow_links = JS_ToBool(ctx, argv[1]);
    }

    if ((follow_links ? stat(path, &stat_value) : lstat(path, &stat_value)) != 0) {
        JSValue exception = JS_ThrowReferenceError(ctx, "failed to stat file '%s'", path);
        JS_FreeCString(ctx, path);
        return exception;
    }

    JS_FreeCString(ctx, path);
    result = JS_NewObject(ctx);
    if (JS_IsException(result)) {
        return result;
    }

    if (ct_define_stat_fields(ctx, result, &stat_value) != 0) {
        JS_FreeValue(ctx, result);
        return JS_EXCEPTION;
    }

    return result;
}

static JSValue ct_read_dir_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = NULL;
    DIR *dir = NULL;
    JSValue result;
    uint32_t index = 0;

    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.readDirSync(path) requires a path");
    }

    path = JS_ToCString(ctx, argv[0]);
    if (path == NULL) {
        return JS_EXCEPTION;
    }

    dir = opendir(path);
    if (dir == NULL) {
        JSValue exception = JS_ThrowReferenceError(ctx, "failed to read directory '%s'", path);
        JS_FreeCString(ctx, path);
        return exception;
    }

    result = JS_NewArray(ctx);
    if (JS_IsException(result)) {
        closedir(dir);
        JS_FreeCString(ctx, path);
        return result;
    }

    for (;;) {
        struct dirent *entry = readdir(dir);
        if (entry == NULL) {
            break;
        }

        const char *name = entry->d_name;
        if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
            continue;
        }

        size_t path_len = strlen(path);
        size_t name_len = strlen(name);
        bool needs_separator = path_len > 0 && path[path_len - 1] != '/';
        size_t full_path_len = path_len + (needs_separator ? 1u : 0u) + name_len;
        char *full_path = (char *) malloc(full_path_len + 1);
        struct stat stat_value;
        JSValue item;

        if (full_path == NULL) {
            JS_FreeValue(ctx, result);
            closedir(dir);
            JS_FreeCString(ctx, path);
            return JS_ThrowOutOfMemory(ctx);
        }

        memcpy(full_path, path, path_len);
        if (needs_separator) {
            full_path[path_len] = '/';
        }
        memcpy(full_path + path_len + (needs_separator ? 1u : 0u), name, name_len);
        full_path[full_path_len] = 0;

        if (lstat(full_path, &stat_value) != 0) {
            free(full_path);
            continue;
        }
        free(full_path);

        item = JS_NewObject(ctx);
        if (JS_IsException(item)) {
            JS_FreeValue(ctx, result);
            closedir(dir);
            JS_FreeCString(ctx, path);
            return item;
        }

        if (JS_SetPropertyStr(ctx, item, "name", JS_NewString(ctx, name)) < 0 ||
            ct_define_stat_fields(ctx, item, &stat_value) != 0 ||
            JS_SetPropertyUint32(ctx, result, index++, item) < 0) {
            JS_FreeValue(ctx, item);
            JS_FreeValue(ctx, result);
            closedir(dir);
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
    }

    closedir(dir);
    JS_FreeCString(ctx, path);
    return result;
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

#if !defined(_WIN32)
static bool ct_http_server_is_stopped(CtHttpServer *server) {
    bool stopped = false;
    pthread_mutex_lock(&server->mutex);
    stopped = server->stopped;
    pthread_mutex_unlock(&server->mutex);
    return stopped;
}

static const char *ct_http_reason_phrase(int status) {
    switch (status) {
        case 200: return "OK";
        case 201: return "Created";
        case 204: return "No Content";
        case 301: return "Moved Permanently";
        case 302: return "Found";
        case 304: return "Not Modified";
        case 400: return "Bad Request";
        case 404: return "Not Found";
        case 500: return "Internal Server Error";
        case 503: return "Service Unavailable";
        default: return "OK";
    }
}

static ssize_t ct_http_send_all(int fd, const char *data, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t result = send(fd, data + sent, len - sent, 0);
        if (result < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (result == 0) return -1;
        sent += (size_t) result;
    }
    return (ssize_t) sent;
}

static void ct_http_free_request(CtHttpRequest *request) {
    if (request == NULL) return;
    if (request->client_fd >= 0) close(request->client_fd);
    free(request->method);
    free(request->url);
    free(request->headers_text);
    free(request->body);
    free(request->response_headers_text);
    free(request->response_body);
    pthread_cond_destroy(&request->cond);
    pthread_mutex_destroy(&request->mutex);
    free(request);
}

static char *ct_http_copy_range(const char *start, size_t len) {
    char *copy = (char *) malloc(len + 1);
    if (copy == NULL) return NULL;
    memcpy(copy, start, len);
    copy[len] = '\0';
    return copy;
}

static const char *ct_http_find_header_end(const char *buffer, size_t len) {
    for (size_t index = 3; index < len; index += 1) {
        if (buffer[index - 3] == '\r' &&
            buffer[index - 2] == '\n' &&
            buffer[index - 1] == '\r' &&
            buffer[index] == '\n') {
            return buffer + index + 1;
        }
    }
    return NULL;
}

static size_t ct_http_content_length(const char *headers, size_t headers_len) {
    const char *cursor = headers;
    const char *end = headers + headers_len;
    while (cursor < end) {
        const char *line_end = memchr(cursor, '\n', (size_t) (end - cursor));
        const char *line_stop = line_end != NULL ? line_end : end;
        size_t line_len = (size_t) (line_stop - cursor);
        if (line_len > 0 && cursor[line_len - 1] == '\r') line_len -= 1;
        if (line_len >= 15 && strncasecmp(cursor, "content-length:", 15) == 0) {
            const char *value = cursor + 15;
            while (value < cursor + line_len && (*value == ' ' || *value == '\t')) value += 1;
            return (size_t) strtoull(value, NULL, 10);
        }
        if (line_end == NULL) break;
        cursor = line_end + 1;
    }
    return 0;
}

static int ct_http_read_request(int fd, CtHttpRequest *request) {
    size_t capacity = 8192;
    size_t len = 0;
    char *buffer = (char *) malloc(capacity + 1);
    const char *header_end = NULL;
    size_t header_len = 0;
    size_t content_len = 0;

    if (buffer == NULL) return -1;

    while (true) {
        if (len == capacity) {
            size_t next_capacity = capacity * 2;
            char *next = NULL;
            if (next_capacity > 1024 * 1024) {
                free(buffer);
                return -1;
            }
            next = (char *) realloc(buffer, next_capacity + 1);
            if (next == NULL) {
                free(buffer);
                return -1;
            }
            buffer = next;
            capacity = next_capacity;
        }

        ssize_t read_count = recv(fd, buffer + len, capacity - len, 0);
        if (read_count < 0) {
            if (errno == EINTR) continue;
            free(buffer);
            return -1;
        }
        if (read_count == 0) {
            free(buffer);
            return -1;
        }

        len += (size_t) read_count;
        buffer[len] = '\0';

        header_end = ct_http_find_header_end(buffer, len);
        if (header_end != NULL) {
            header_len = (size_t) (header_end - buffer);
            content_len = ct_http_content_length(buffer, header_len);
            if (len >= header_len + content_len) break;
        }
    }

    const char *request_line_end = strstr(buffer, "\r\n");
    const char *first_space = NULL;
    const char *second_space = NULL;
    if (request_line_end == NULL || request_line_end > header_end) {
        free(buffer);
        return -1;
    }

    first_space = memchr(buffer, ' ', (size_t) (request_line_end - buffer));
    if (first_space == NULL) {
        free(buffer);
        return -1;
    }
    second_space = memchr(first_space + 1, ' ', (size_t) (request_line_end - first_space - 1));
    if (second_space == NULL) {
        free(buffer);
        return -1;
    }

    request->method = ct_http_copy_range(buffer, (size_t) (first_space - buffer));
    request->url = ct_http_copy_range(first_space + 1, (size_t) (second_space - first_space - 1));
    request->headers_text = ct_http_copy_range(request_line_end + 2, (size_t) (header_end - request_line_end - 4));
    request->body_len = content_len;
    request->body = (char *) malloc(content_len > 0 ? content_len : 1);
    if (request->method == NULL || request->url == NULL || request->headers_text == NULL || request->body == NULL) {
        free(buffer);
        return -1;
    }
    if (content_len > 0) {
        memcpy(request->body, buffer + header_len, content_len);
    }

    free(buffer);
    return 0;
}

static void ct_http_send_response(CtHttpRequest *request) {
    int status = request->status > 0 ? request->status : 200;
    const char *reason = ct_http_reason_phrase(status);
    const char *headers = request->response_headers_text != NULL ? request->response_headers_text : "";
    char head[512];
    int head_len = snprintf(
        head,
        sizeof(head),
        "HTTP/1.1 %d %s\r\nContent-Length: %zu\r\nConnection: close\r\n%s\r\n",
        status,
        reason,
        request->response_body_len,
        headers
    );
    if (head_len < 0) return;
    if ((size_t) head_len >= sizeof(head)) head_len = (int) sizeof(head) - 1;
    ct_http_send_all(request->client_fd, head, (size_t) head_len);
    if (request->response_body_len > 0 && request->response_body != NULL) {
        ct_http_send_all(request->client_fd, request->response_body, request->response_body_len);
    }
}

static void ct_http_server_add_request(CtHttpServer *server, CtHttpRequest *request) {
    pthread_mutex_lock(&server->mutex);
    request->next = server->requests;
    server->requests = request;
    pthread_mutex_unlock(&server->mutex);
}

static void ct_http_server_remove_request(CtHttpServer *server, CtHttpRequest *request) {
    pthread_mutex_lock(&server->mutex);
    CtHttpRequest **cursor = &server->requests;
    while (*cursor != NULL) {
        if (*cursor == request) {
            *cursor = request->next;
            break;
        }
        cursor = &(*cursor)->next;
    }
    pthread_mutex_unlock(&server->mutex);
}

static void *ct_http_server_thread(void *opaque) {
    CtHttpServer *server = (CtHttpServer *) opaque;
    while (!ct_http_server_is_stopped(server)) {
        int client_fd = accept(server->listen_fd, NULL, NULL);
        if (client_fd < 0) {
            if (errno == EINTR) continue;
            if (ct_http_server_is_stopped(server)) break;
            continue;
        }

        CtHttpRequest *request = (CtHttpRequest *) calloc(1, sizeof(CtHttpRequest));
        if (request == NULL) {
            close(client_fd);
            continue;
        }
        request->client_fd = client_fd;
        request->status = 200;
        pthread_mutex_init(&request->mutex, NULL);
        pthread_cond_init(&request->cond, NULL);

        pthread_mutex_lock(&ct_http_servers_mutex);
        request->id = ct_next_http_request_id++;
        if (ct_next_http_request_id == 0) ct_next_http_request_id = 1;
        pthread_mutex_unlock(&ct_http_servers_mutex);

        if (ct_http_read_request(client_fd, request) != 0) {
            static const char bad_request[] =
                "HTTP/1.1 400 Bad Request\r\nContent-Length: 11\r\nConnection: close\r\n\r\nBad Request";
            ct_http_send_all(client_fd, bad_request, sizeof(bad_request) - 1);
            ct_http_free_request(request);
            continue;
        }

        ct_http_server_add_request(server, request);

        pthread_mutex_lock(&request->mutex);
        while (!request->completed && !ct_http_server_is_stopped(server)) {
            pthread_cond_wait(&request->cond, &request->mutex);
        }
        pthread_mutex_unlock(&request->mutex);

        if (!ct_http_server_is_stopped(server)) {
            ct_http_send_response(request);
        }

        ct_http_server_remove_request(server, request);
        ct_http_free_request(request);
    }
    return NULL;
}

static CtHttpServer *ct_http_find_server(uint32_t id) {
    CtHttpServer *server = ct_http_servers;
    while (server != NULL) {
        if (server->id == id) return server;
        server = server->next;
    }
    return NULL;
}

static JSValue ct_http_server_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *hostname = "127.0.0.1";
    const char *hostname_arg = NULL;
    int32_t port_value = 0;
    int listen_fd = -1;
    struct sockaddr_in addr;
    socklen_t addr_len = sizeof(addr);
    CtHttpServer *server = NULL;
    int yes = 1;
    JSValue result = JS_UNDEFINED;
    (void) this_val;

    if (argc >= 1 && !JS_IsUndefined(argv[0]) && !JS_IsNull(argv[0])) {
        hostname_arg = JS_ToCString(ctx, argv[0]);
        if (hostname_arg == NULL) return JS_EXCEPTION;
        hostname = hostname_arg;
    }
    if (argc >= 2 && JS_ToInt32(ctx, &port_value, argv[1]) < 0) {
        if (hostname_arg != NULL) JS_FreeCString(ctx, hostname_arg);
        return JS_EXCEPTION;
    }

    signal(SIGPIPE, SIG_IGN);

    listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        if (hostname_arg != NULL) JS_FreeCString(ctx, hostname_arg);
        return JS_ThrowInternalError(ctx, "socket failed: %s", strerror(errno));
    }
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t) port_value);
    if (strcmp(hostname, "0.0.0.0") == 0) {
        addr.sin_addr.s_addr = htonl(INADDR_ANY);
    } else if (inet_pton(AF_INET, hostname, &addr.sin_addr) != 1) {
        close(listen_fd);
        if (hostname_arg != NULL) JS_FreeCString(ctx, hostname_arg);
        return JS_ThrowTypeError(ctx, "Bun.serve currently requires an IPv4 hostname");
    }

    if (bind(listen_fd, (struct sockaddr *) &addr, sizeof(addr)) != 0) {
        JSValue error = JS_ThrowInternalError(ctx, "bind failed: %s", strerror(errno));
        close(listen_fd);
        if (hostname_arg != NULL) JS_FreeCString(ctx, hostname_arg);
        return error;
    }

    if (getsockname(listen_fd, (struct sockaddr *) &addr, &addr_len) != 0) {
        JSValue error = JS_ThrowInternalError(ctx, "getsockname failed: %s", strerror(errno));
        close(listen_fd);
        if (hostname_arg != NULL) JS_FreeCString(ctx, hostname_arg);
        return error;
    }

    if (listen(listen_fd, 128) != 0) {
        JSValue error = JS_ThrowInternalError(ctx, "listen failed: %s", strerror(errno));
        close(listen_fd);
        if (hostname_arg != NULL) JS_FreeCString(ctx, hostname_arg);
        return error;
    }

    server = (CtHttpServer *) calloc(1, sizeof(CtHttpServer));
    if (server == NULL) {
        close(listen_fd);
        if (hostname_arg != NULL) JS_FreeCString(ctx, hostname_arg);
        return JS_ThrowOutOfMemory(ctx);
    }
    server->listen_fd = listen_fd;
    server->port = ntohs(addr.sin_port);
    server->hostname = ct_duplicate_string(hostname);
    pthread_mutex_init(&server->mutex, NULL);

    pthread_mutex_lock(&ct_http_servers_mutex);
    server->id = ct_next_http_server_id++;
    if (ct_next_http_server_id == 0) ct_next_http_server_id = 1;
    server->next = ct_http_servers;
    ct_http_servers = server;
    pthread_mutex_unlock(&ct_http_servers_mutex);

    if (pthread_create(&server->thread, NULL, ct_http_server_thread, server) != 0) {
        pthread_mutex_lock(&ct_http_servers_mutex);
        if (ct_http_servers == server) {
            ct_http_servers = server->next;
        } else {
            CtHttpServer *cursor = ct_http_servers;
            while (cursor != NULL && cursor->next != server) cursor = cursor->next;
            if (cursor != NULL) cursor->next = server->next;
        }
        pthread_mutex_unlock(&ct_http_servers_mutex);
        close(listen_fd);
        free(server->hostname);
        pthread_mutex_destroy(&server->mutex);
        free(server);
        if (hostname_arg != NULL) JS_FreeCString(ctx, hostname_arg);
        return JS_ThrowInternalError(ctx, "pthread_create failed");
    }

    result = JS_NewObject(ctx);
    if (JS_IsException(result) ||
        JS_SetPropertyStr(ctx, result, "id", JS_NewUint32(ctx, server->id)) < 0 ||
        JS_SetPropertyStr(ctx, result, "port", JS_NewInt32(ctx, (int32_t) server->port)) < 0 ||
        JS_SetPropertyStr(ctx, result, "hostname", JS_NewString(ctx, server->hostname)) < 0) {
        if (!JS_IsException(result)) JS_FreeValue(ctx, result);
        if (hostname_arg != NULL) JS_FreeCString(ctx, hostname_arg);
        return JS_EXCEPTION;
    }

    if (hostname_arg != NULL) JS_FreeCString(ctx, hostname_arg);
    return result;
}

static JSValue ct_http_server_poll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t server_id = 0;
    JSValue result = JS_NULL;
    (void) this_val;

    if (argc < 1 || JS_ToUint32(ctx, &server_id, argv[0]) < 0) return JS_EXCEPTION;

    pthread_mutex_lock(&ct_http_servers_mutex);
    CtHttpServer *server = ct_http_find_server(server_id);
    pthread_mutex_unlock(&ct_http_servers_mutex);
    if (server == NULL) return JS_NULL;

    pthread_mutex_lock(&server->mutex);
    CtHttpRequest *request = server->requests;
    while (request != NULL && request->claimed) request = request->next;
    if (request != NULL) {
        request->claimed = true;
        result = JS_NewObject(ctx);
        if (!JS_IsException(result)) {
            JS_SetPropertyStr(ctx, result, "id", JS_NewUint32(ctx, request->id));
            JS_SetPropertyStr(ctx, result, "method", JS_NewString(ctx, request->method != NULL ? request->method : "GET"));
            JS_SetPropertyStr(ctx, result, "url", JS_NewString(ctx, request->url != NULL ? request->url : "/"));
            JS_SetPropertyStr(ctx, result, "headersText", JS_NewString(ctx, request->headers_text != NULL ? request->headers_text : ""));
            JS_SetPropertyStr(ctx, result, "body", JS_NewArrayBufferCopy(ctx, (const uint8_t *) request->body, request->body_len));
        }
    }
    pthread_mutex_unlock(&server->mutex);

    return result;
}

static JSValue ct_http_server_respond(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t server_id = 0;
    uint32_t request_id = 0;
    int32_t status = 200;
    char *headers_text = NULL;
    uint8_t *body_data = NULL;
    size_t body_len = 0;
    char *body_copy = NULL;
    CtHttpRequest *request = NULL;
    (void) this_val;

    if (argc < 5 ||
        JS_ToUint32(ctx, &server_id, argv[0]) < 0 ||
        JS_ToUint32(ctx, &request_id, argv[1]) < 0 ||
        JS_ToInt32(ctx, &status, argv[2]) < 0) {
        return JS_EXCEPTION;
    }

    headers_text = ct_copy_js_string(ctx, argv[3]);
    if (headers_text == NULL) return JS_EXCEPTION;
    if (ct_get_array_buffer_bytes(ctx, argv[4], &body_data, &body_len) != 0) {
        free(headers_text);
        return JS_EXCEPTION;
    }
    body_copy = (char *) malloc(body_len > 0 ? body_len : 1);
    if (body_copy == NULL) {
        free(headers_text);
        return JS_ThrowOutOfMemory(ctx);
    }
    if (body_len > 0) memcpy(body_copy, body_data, body_len);

    pthread_mutex_lock(&ct_http_servers_mutex);
    CtHttpServer *server = ct_http_find_server(server_id);
    pthread_mutex_unlock(&ct_http_servers_mutex);
    if (server == NULL) {
        free(headers_text);
        free(body_copy);
        return JS_ThrowInternalError(ctx, "HTTP server not found");
    }

    pthread_mutex_lock(&server->mutex);
    request = server->requests;
    while (request != NULL && request->id != request_id) request = request->next;
    pthread_mutex_unlock(&server->mutex);

    if (request == NULL) {
        free(headers_text);
        free(body_copy);
        return JS_ThrowInternalError(ctx, "HTTP request not found");
    }

    pthread_mutex_lock(&request->mutex);
    request->status = status;
    request->response_headers_text = headers_text;
    request->response_body = body_copy;
    request->response_body_len = body_len;
    request->completed = true;
    pthread_cond_signal(&request->cond);
    pthread_mutex_unlock(&request->mutex);

    return JS_UNDEFINED;
}

static void ct_http_stop_server(CtHttpServer *server, bool remove_from_global_list) {
    if (server == NULL) return;

    pthread_mutex_lock(&server->mutex);
    if (!server->stopped) {
        server->stopped = true;
        shutdown(server->listen_fd, SHUT_RDWR);
        close(server->listen_fd);
        CtHttpRequest *request = server->requests;
        while (request != NULL) {
            pthread_mutex_lock(&request->mutex);
            request->completed = true;
            pthread_cond_signal(&request->cond);
            pthread_mutex_unlock(&request->mutex);
            request = request->next;
        }
    }
    pthread_mutex_unlock(&server->mutex);

    pthread_join(server->thread, NULL);

    if (remove_from_global_list) {
        pthread_mutex_lock(&ct_http_servers_mutex);
        if (ct_http_servers == server) {
            ct_http_servers = server->next;
        } else {
            CtHttpServer *cursor = ct_http_servers;
            while (cursor != NULL && cursor->next != server) cursor = cursor->next;
            if (cursor != NULL) cursor->next = server->next;
        }
        pthread_mutex_unlock(&ct_http_servers_mutex);
    }

    CtHttpRequest *request = server->requests;
    while (request != NULL) {
        CtHttpRequest *next = request->next;
        ct_http_free_request(request);
        request = next;
    }
    free(server->hostname);
    pthread_mutex_destroy(&server->mutex);
    free(server);
}

static JSValue ct_http_server_stop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t server_id = 0;
    (void) this_val;
    if (argc < 1 || JS_ToUint32(ctx, &server_id, argv[0]) < 0) return JS_EXCEPTION;

    pthread_mutex_lock(&ct_http_servers_mutex);
    CtHttpServer *server = ct_http_find_server(server_id);
    pthread_mutex_unlock(&ct_http_servers_mutex);
    if (server != NULL) ct_http_stop_server(server, true);
    return JS_UNDEFINED;
}

static void ct_http_stop_all(void) {
    while (true) {
        pthread_mutex_lock(&ct_http_servers_mutex);
        CtHttpServer *server = ct_http_servers;
        pthread_mutex_unlock(&ct_http_servers_mutex);
        if (server == NULL) break;
        ct_http_stop_server(server, true);
    }
}

static void ct_byte_buffer_free(CtByteBuffer *buffer) {
    if (buffer == NULL) return;
    free(buffer->data);
    buffer->data = NULL;
    buffer->len = 0;
    buffer->cap = 0;
}

static bool ct_byte_buffer_append(CtByteBuffer *buffer, const char *data, size_t len) {
    if (len == 0) return true;
    if (buffer->len > SIZE_MAX - len) return false;
    size_t needed = buffer->len + len;
    if (needed > buffer->cap) {
        size_t next_cap = buffer->cap == 0 ? 4096 : buffer->cap;
        while (next_cap < needed) {
            if (next_cap > SIZE_MAX / 2) {
                next_cap = needed;
                break;
            }
            next_cap *= 2;
        }
        char *next = (char *) realloc(buffer->data, next_cap);
        if (next == NULL) return false;
        buffer->data = next;
        buffer->cap = next_cap;
    }
    memcpy(buffer->data + buffer->len, data, len);
    buffer->len += len;
    return true;
}

static void ct_process_event_free(CtProcessEvent *event) {
    if (event == NULL) return;
    free(event->data);
    free(event);
}

static void ct_process_event_queue_clear(CtQjsRuntime *runtime) {
    if (runtime == NULL) return;

    pthread_mutex_lock(&runtime->process_event_mutex);
    CtProcessEvent *event = runtime->process_events_head;
    runtime->process_events_head = NULL;
    runtime->process_events_tail = NULL;
    pthread_mutex_unlock(&runtime->process_event_mutex);

    while (event != NULL) {
        CtProcessEvent *next = event->next;
        ct_process_event_free(event);
        event = next;
    }
}

static void ct_process_enqueue_event(
    CtProcess *process,
    CtProcessEventKind kind,
    const char *data,
    size_t data_len,
    int exit_code,
    int signal_code,
    bool killed
) {
    if (process == NULL || process->runtime == NULL) return;

    CtProcessEvent *event = (CtProcessEvent *) calloc(1, sizeof(CtProcessEvent));
    if (event == NULL) return;

    event->process_id = process->id;
    event->kind = kind;
    event->exit_code = exit_code;
    event->signal_code = signal_code;
    event->killed = killed;

    if (data_len > 0) {
        event->data = (char *) malloc(data_len);
        if (event->data == NULL) {
            free(event);
            return;
        }
        memcpy(event->data, data, data_len);
        event->data_len = data_len;
    }

    pthread_mutex_lock(&process->runtime->process_event_mutex);
    if (process->runtime->process_events_tail != NULL) {
        process->runtime->process_events_tail->next = event;
    } else {
        process->runtime->process_events_head = event;
    }
    process->runtime->process_events_tail = event;
    pthread_mutex_unlock(&process->runtime->process_event_mutex);
}

static const char *ct_process_event_kind_name(CtProcessEventKind kind) {
    switch (kind) {
        case CT_PROCESS_EVENT_STDOUT:
            return "stdout";
        case CT_PROCESS_EVENT_STDERR:
            return "stderr";
        case CT_PROCESS_EVENT_EXIT:
            return "exit";
    }

    return "unknown";
}

static int ct_drain_process_events(CtQjsRuntime *runtime, char **error_out) {
    JSContext *ctx = runtime->context;

    while (true) {
        pthread_mutex_lock(&runtime->process_event_mutex);
        CtProcessEvent *event = runtime->process_events_head;
        if (event != NULL) {
            runtime->process_events_head = event->next;
            if (runtime->process_events_head == NULL) {
                runtime->process_events_tail = NULL;
            }
        }
        pthread_mutex_unlock(&runtime->process_event_mutex);

        if (event == NULL) break;

        if (!JS_IsUndefined(runtime->process_event_callback) &&
            !JS_IsNull(runtime->process_event_callback)) {
            JSValue payload = JS_NewObject(ctx);
            JSValue callback_result = JS_UNDEFINED;
            bool failed = JS_IsException(payload);

            if (!failed) {
                failed =
                    JS_SetPropertyStr(ctx, payload, "id", JS_NewUint32(ctx, event->process_id)) < 0 ||
                    JS_SetPropertyStr(ctx, payload, "type", JS_NewString(ctx, ct_process_event_kind_name(event->kind))) < 0;
            }

            if (!failed && event->kind == CT_PROCESS_EVENT_EXIT) {
                failed =
                    JS_SetPropertyStr(ctx, payload, "exitCode", JS_NewInt32(ctx, event->exit_code)) < 0 ||
                    JS_SetPropertyStr(
                        ctx,
                        payload,
                        "signalCode",
                        event->signal_code != 0 ? JS_NewInt32(ctx, event->signal_code) : JS_NULL
                    ) < 0 ||
                    JS_SetPropertyStr(ctx, payload, "killed", JS_NewBool(ctx, event->killed)) < 0;
            } else if (!failed) {
                failed = JS_SetPropertyStr(
                    ctx,
                    payload,
                    "data",
                    JS_NewArrayBufferCopy(ctx, (const uint8_t *) event->data, event->data_len)
                ) < 0;
            }

            if (!failed) {
                callback_result = JS_Call(ctx, runtime->process_event_callback, JS_UNDEFINED, 1, &payload);
                if (JS_IsException(callback_result)) {
                    failed = true;
                }
            }

            JS_FreeValue(ctx, callback_result);
            JS_FreeValue(ctx, payload);

            if (failed) {
                ct_process_event_free(event);
                ct_set_error_out(error_out, ct_copy_exception(ctx));
                return -1;
            }
        }

        ct_process_event_free(event);
    }

    return 0;
}

static void ct_fd_event_free(CtFdEvent *event) {
    if (event == NULL) return;
    free(event->type);
    free(event->data);
    free(event->message);
    free(event);
}

static void ct_fd_event_queue_clear(CtQjsRuntime *runtime) {
    if (runtime == NULL) return;

    pthread_mutex_lock(&runtime->fd_event_mutex);
    CtFdEvent *event = runtime->fd_events_head;
    runtime->fd_events_head = NULL;
    runtime->fd_events_tail = NULL;
    pthread_mutex_unlock(&runtime->fd_event_mutex);

    while (event != NULL) {
        CtFdEvent *next = event->next;
        ct_fd_event_free(event);
        event = next;
    }
}

static void ct_fd_enqueue_event(CtQjsRuntime *runtime, CtFdEvent *event) {
    if (runtime == NULL || event == NULL) return;

    pthread_mutex_lock(&runtime->fd_event_mutex);
    if (runtime->fd_events_tail != NULL) {
        runtime->fd_events_tail->next = event;
    } else {
        runtime->fd_events_head = event;
    }
    runtime->fd_events_tail = event;
    pthread_mutex_unlock(&runtime->fd_event_mutex);
}

static void ct_worker_event_free(CtWorkerEvent *event) {
    free(event);
}

static void ct_worker_event_queue_clear(CtQjsRuntime *runtime) {
    if (runtime == NULL) return;

    pthread_mutex_lock(&runtime->worker_event_mutex);
    CtWorkerEvent *event = runtime->worker_events_head;
    runtime->worker_events_head = NULL;
    runtime->worker_events_tail = NULL;
    pthread_mutex_unlock(&runtime->worker_event_mutex);

    while (event != NULL) {
        CtWorkerEvent *next = event->next;
        ct_worker_event_free(event);
        event = next;
    }
}

static void ct_worker_enqueue_event(CtQjsRuntime *runtime, uint32_t worker_id) {
    if (runtime == NULL) return;

    CtWorkerEvent *event = (CtWorkerEvent *) calloc(1, sizeof(CtWorkerEvent));
    if (event == NULL) return;
    event->worker_id = worker_id;

    pthread_mutex_lock(&runtime->worker_event_mutex);
    if (runtime->worker_events_tail != NULL) {
        runtime->worker_events_tail->next = event;
    } else {
        runtime->worker_events_head = event;
    }
    runtime->worker_events_tail = event;
    pthread_mutex_unlock(&runtime->worker_event_mutex);
}

static void ct_fd_enqueue_data(CtQjsRuntime *runtime, uint32_t id, const char *data, size_t data_len) {
    if (data == NULL || data_len == 0) return;
    if (ct_debug_flag("COTTONTAIL_FD_DEBUG")) {
        fprintf(stderr, "[cottontail:fd] data id=%u bytes=%zu\n", id, data_len);
        fflush(stderr);
    }

    CtFdEvent *event = (CtFdEvent *) calloc(1, sizeof(CtFdEvent));
    if (event == NULL) return;
    event->watch_id = id;
    event->type = ct_duplicate_bytes("data", 4);
    event->data = ct_duplicate_bytes(data, data_len);
    event->data_len = data_len;
    if (event->type == NULL || event->data == NULL) {
        ct_fd_event_free(event);
        return;
    }
    ct_fd_enqueue_event(runtime, event);
}

static void ct_fd_enqueue_simple(CtQjsRuntime *runtime, uint32_t id, const char *type, const char *message) {
    if (ct_debug_flag("COTTONTAIL_FD_DEBUG")) {
        fprintf(stderr, "[cottontail:fd] %s id=%u%s%s\n", type, id, message != NULL ? " message=" : "", message != NULL ? message : "");
        fflush(stderr);
    }

    CtFdEvent *event = (CtFdEvent *) calloc(1, sizeof(CtFdEvent));
    if (event == NULL) return;
    event->watch_id = id;
    event->type = ct_duplicate_string(type);
    if (message != NULL) event->message = ct_duplicate_string(message);
    if (event->type == NULL || (message != NULL && event->message == NULL)) {
        ct_fd_event_free(event);
        return;
    }
    ct_fd_enqueue_event(runtime, event);
}

static bool ct_fd_watcher_is_active(CtFdWatcher *watcher) {
    bool active = false;
    pthread_mutex_lock(&watcher->mutex);
    active = watcher->active;
    pthread_mutex_unlock(&watcher->mutex);
    return active;
}

static void ct_fd_watcher_set_active(CtFdWatcher *watcher, bool active) {
    pthread_mutex_lock(&watcher->mutex);
    watcher->active = active;
    pthread_mutex_unlock(&watcher->mutex);
}

static void ct_fd_watchers_remove(CtFdWatcher *watcher) {
    pthread_mutex_lock(&ct_fd_watchers_mutex);
    CtFdWatcher **cursor = &ct_fd_watchers;
    while (*cursor != NULL) {
        if (*cursor == watcher) {
            *cursor = watcher->next;
            break;
        }
        cursor = &(*cursor)->next;
    }
    pthread_mutex_unlock(&ct_fd_watchers_mutex);
}

static bool ct_fd_watcher_stop_id(uint32_t id) {
    bool found = false;
    pthread_mutex_lock(&ct_fd_watchers_mutex);
    for (CtFdWatcher *watcher = ct_fd_watchers; watcher != NULL; watcher = watcher->next) {
        if (watcher->id == id) {
            ct_fd_watcher_set_active(watcher, false);
            found = true;
            break;
        }
    }
    pthread_mutex_unlock(&ct_fd_watchers_mutex);
    return found;
}

static bool ct_fd_watchers_has_runtime(CtQjsRuntime *runtime) {
    bool found = false;
    pthread_mutex_lock(&ct_fd_watchers_mutex);
    for (CtFdWatcher *watcher = ct_fd_watchers; watcher != NULL; watcher = watcher->next) {
        if (watcher->runtime == runtime && ct_fd_watcher_is_active(watcher)) {
            found = true;
            break;
        }
    }
    pthread_mutex_unlock(&ct_fd_watchers_mutex);
    return found;
}

static void ct_fd_watchers_stop_runtime(CtQjsRuntime *runtime) {
    pthread_mutex_lock(&ct_fd_watchers_mutex);
    for (CtFdWatcher *watcher = ct_fd_watchers; watcher != NULL; watcher = watcher->next) {
        if (watcher->runtime == runtime) {
            ct_fd_watcher_set_active(watcher, false);
        }
    }
    pthread_mutex_unlock(&ct_fd_watchers_mutex);
}

static void ct_fd_watchers_wait_for_runtime(CtQjsRuntime *runtime) {
    ct_fd_watchers_stop_runtime(runtime);
    for (int attempt = 0; attempt < 500 && ct_fd_watchers_has_runtime(runtime); attempt += 1) {
        usleep(1000);
    }
}

static void *ct_fd_watcher_thread(void *opaque) {
    CtFdWatcher *watcher = (CtFdWatcher *) opaque;
    if (ct_debug_flag("COTTONTAIL_FD_DEBUG")) {
        fprintf(stderr, "[cottontail:fd] thread start id=%u fd=%d max=%zu\n", watcher->id, watcher->fd, watcher->max_bytes);
        fflush(stderr);
    }

    int flags = fcntl(watcher->fd, F_GETFL, 0);
    if (flags >= 0) {
        (void) fcntl(watcher->fd, F_SETFL, flags | O_NONBLOCK);
    }

    while (ct_fd_watcher_is_active(watcher)) {
        struct pollfd poll_fd;
        poll_fd.fd = watcher->fd;
        poll_fd.events = POLLIN | POLLHUP | POLLERR;
        poll_fd.revents = 0;

        int ready = poll(&poll_fd, 1, 50);
        if (!ct_fd_watcher_is_active(watcher)) break;
        if (ready == 0) continue;
        if (ready < 0) {
            if (errno == EINTR) continue;
            ct_fd_enqueue_simple(watcher->runtime, watcher->id, "error", strerror(errno));
            break;
        }
        if ((poll_fd.revents & POLLNVAL) != 0) {
            ct_fd_enqueue_simple(watcher->runtime, watcher->id, "error", "invalid file descriptor");
            break;
        }
        if ((poll_fd.revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
            continue;
        }

        bool terminal = false;
        for (;;) {
            size_t max_bytes = watcher->max_bytes > 0 ? watcher->max_bytes : 65536;
            if (max_bytes > 1024 * 1024) max_bytes = 1024 * 1024;
            char *buffer = (char *) malloc(max_bytes);
            if (buffer == NULL) {
                ct_fd_enqueue_simple(watcher->runtime, watcher->id, "error", "Out of memory");
                terminal = true;
                break;
            }

            ssize_t n = read(watcher->fd, buffer, max_bytes);
            if (n > 0) {
                ct_fd_enqueue_data(watcher->runtime, watcher->id, buffer, (size_t) n);
                free(buffer);
                continue;
            }
            free(buffer);

            if (n == 0) {
                ct_fd_enqueue_simple(watcher->runtime, watcher->id, "end", NULL);
                terminal = true;
                break;
            }
            if (errno == EINTR) {
                continue;
            }
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                if ((poll_fd.revents & POLLHUP) != 0) {
                    ct_fd_enqueue_simple(watcher->runtime, watcher->id, "end", NULL);
                    terminal = true;
                }
                break;
            }

            ct_fd_enqueue_simple(watcher->runtime, watcher->id, "error", strerror(errno));
            terminal = true;
            break;
        }

        if (terminal) break;
    }

    ct_fd_watchers_remove(watcher);
    ct_fd_watcher_set_active(watcher, false);
    if (ct_debug_flag("COTTONTAIL_FD_DEBUG")) {
        fprintf(stderr, "[cottontail:fd] thread stop id=%u fd=%d\n", watcher->id, watcher->fd);
        fflush(stderr);
    }
    pthread_mutex_destroy(&watcher->mutex);
    free(watcher);
    return NULL;
}

static int ct_drain_fd_events(CtQjsRuntime *runtime, char **error_out) {
    JSContext *ctx = runtime->context;

    while (true) {
        pthread_mutex_lock(&runtime->fd_event_mutex);
        CtFdEvent *event = runtime->fd_events_head;
        if (event != NULL) {
            runtime->fd_events_head = event->next;
            if (runtime->fd_events_head == NULL) {
                runtime->fd_events_tail = NULL;
            }
        }
        pthread_mutex_unlock(&runtime->fd_event_mutex);

        if (event == NULL) break;

        if (!JS_IsUndefined(runtime->fd_event_callback) &&
            !JS_IsNull(runtime->fd_event_callback)) {
            JSValue payload = JS_NewObject(ctx);
            JSValue callback_result = JS_UNDEFINED;
            bool failed = JS_IsException(payload);

            if (!failed) {
                failed =
                    JS_SetPropertyStr(ctx, payload, "id", JS_NewUint32(ctx, event->watch_id)) < 0 ||
                    JS_SetPropertyStr(ctx, payload, "type", JS_NewString(ctx, event->type != NULL ? event->type : "")) < 0;
            }
            if (!failed && event->data != NULL) {
                failed = JS_SetPropertyStr(
                    ctx,
                    payload,
                    "data",
                    JS_NewArrayBufferCopy(ctx, (const uint8_t *) event->data, event->data_len)
                ) < 0;
            }
            if (!failed && event->message != NULL) {
                failed = JS_SetPropertyStr(ctx, payload, "message", JS_NewString(ctx, event->message)) < 0;
            }
            if (!failed) {
                callback_result = JS_Call(ctx, runtime->fd_event_callback, JS_UNDEFINED, 1, &payload);
                if (JS_IsException(callback_result)) {
                    failed = true;
                }
            }

            JS_FreeValue(ctx, callback_result);
            JS_FreeValue(ctx, payload);

            if (failed) {
                ct_fd_event_free(event);
                ct_set_error_out(error_out, ct_copy_exception(ctx));
                return -1;
            }
        }

        ct_fd_event_free(event);
    }

    return 0;
}

static int ct_drain_worker_events(CtQjsRuntime *runtime, char **error_out) {
    JSContext *ctx = runtime->context;

    if (JS_IsUndefined(runtime->worker_event_callback) ||
        JS_IsNull(runtime->worker_event_callback)) {
        return 0;
    }

    while (true) {
        pthread_mutex_lock(&runtime->worker_event_mutex);
        CtWorkerEvent *event = runtime->worker_events_head;
        if (event != NULL) {
            runtime->worker_events_head = event->next;
            if (runtime->worker_events_head == NULL) {
                runtime->worker_events_tail = NULL;
            }
        }
        pthread_mutex_unlock(&runtime->worker_event_mutex);

        if (event == NULL) break;

        JSValue payload = JS_NewObject(ctx);
        JSValue callback_result = JS_UNDEFINED;
        bool failed = JS_IsException(payload);

        if (!failed) {
            failed = JS_SetPropertyStr(ctx, payload, "id", JS_NewUint32(ctx, event->worker_id)) < 0;
        }
        if (!failed) {
            callback_result = JS_Call(ctx, runtime->worker_event_callback, JS_UNDEFINED, 1, &payload);
            if (JS_IsException(callback_result)) {
                failed = true;
            }
        }

        JS_FreeValue(ctx, callback_result);
        JS_FreeValue(ctx, payload);

        if (failed) {
            ct_worker_event_free(event);
            ct_set_error_out(error_out, ct_copy_exception(ctx));
            return -1;
        }

        ct_worker_event_free(event);
    }

    return 0;
}

static CtProcess *ct_process_find(uint32_t id) {
    CtProcess *process = ct_processes;
    while (process != NULL) {
        if (process->id == id) return process;
        process = process->next;
    }
    return NULL;
}

static int ct_process_parse_stdio_mode(
    JSContext *ctx,
    JSValueConst options,
    const char *name,
    CtProcessStdioMode default_mode,
    CtProcessStdioMode *out
) {
    JSValue value = JS_GetPropertyStr(ctx, options, name);
    if (JS_IsException(value)) return -1;

    if (JS_IsUndefined(value)) {
        JS_FreeValue(ctx, value);
        *out = default_mode;
        return 0;
    }

    if (JS_IsNull(value)) {
        JS_FreeValue(ctx, value);
        *out = CT_PROCESS_STDIO_IGNORE;
        return 0;
    }

    char *mode = ct_copy_js_string(ctx, value);
    JS_FreeValue(ctx, value);
    if (mode == NULL) return -1;

    if (strcmp(mode, "pipe") == 0) {
        *out = CT_PROCESS_STDIO_PIPE;
    } else if (strcmp(mode, "inherit") == 0) {
        *out = CT_PROCESS_STDIO_INHERIT;
    } else if (strcmp(mode, "ignore") == 0) {
        *out = CT_PROCESS_STDIO_IGNORE;
    } else {
        free(mode);
        JS_ThrowTypeError(ctx, "spawn stdio must be 'pipe', 'inherit', or 'ignore'");
        return -1;
    }

    free(mode);
    return 0;
}

static int ct_process_parse_input(JSContext *ctx, JSValueConst options, char **out_data, size_t *out_len) {
    JSValue value = JS_GetPropertyStr(ctx, options, "input");
    uint8_t *bytes = NULL;
    size_t len = 0;
    char *copy = NULL;

    *out_data = NULL;
    *out_len = 0;

    if (JS_IsException(value)) return -1;
    if (JS_IsUndefined(value) || JS_IsNull(value)) {
        JS_FreeValue(ctx, value);
        return 0;
    }

    if (ct_get_array_buffer_bytes(ctx, value, &bytes, &len) == 0) {
        copy = (char *) malloc(len > 0 ? len : 1);
        if (copy == NULL) {
            JS_FreeValue(ctx, value);
            JS_ThrowOutOfMemory(ctx);
            return -1;
        }
        if (len > 0) memcpy(copy, bytes, len);
        JS_FreeValue(ctx, value);
        *out_data = copy;
        *out_len = len;
        return 0;
    }

    size_t string_len = 0;
    const char *string_value = JS_ToCStringLen(ctx, &string_len, value);
    if (string_value == NULL) {
        JS_FreeValue(ctx, value);
        return -1;
    }
    copy = (char *) malloc(string_len > 0 ? string_len : 1);
    if (copy == NULL) {
        JS_FreeCString(ctx, string_value);
        JS_FreeValue(ctx, value);
        JS_ThrowOutOfMemory(ctx);
        return -1;
    }
    if (string_len > 0) memcpy(copy, string_value, string_len);
    JS_FreeCString(ctx, string_value);
    JS_FreeValue(ctx, value);

    *out_data = copy;
    *out_len = string_len;
    return 0;
}

static int ct_open_dev_null(int flags) {
    return open("/dev/null", flags);
}

static void ct_child_apply_input_stdio(CtProcessStdioMode mode, int pipe_read_fd) {
    if (mode == CT_PROCESS_STDIO_INHERIT) return;

    if (mode == CT_PROCESS_STDIO_PIPE && pipe_read_fd >= 0) {
        dup2(pipe_read_fd, STDIN_FILENO);
        return;
    }

    int devnull = ct_open_dev_null(O_RDONLY);
    if (devnull >= 0) {
        dup2(devnull, STDIN_FILENO);
        if (devnull > STDERR_FILENO) close(devnull);
    }
}

static void ct_child_apply_output_stdio(CtProcessStdioMode mode, int pipe_write_fd, int fd) {
    if (mode == CT_PROCESS_STDIO_INHERIT) return;

    if (mode == CT_PROCESS_STDIO_PIPE && pipe_write_fd >= 0) {
        dup2(pipe_write_fd, fd);
        return;
    }

    int devnull = ct_open_dev_null(O_WRONLY);
    if (devnull >= 0) {
        dup2(devnull, fd);
        if (devnull > STDERR_FILENO) close(devnull);
    }
}

static void ct_process_close_fd(int *fd) {
    if (fd != NULL && *fd >= 0) {
        close(*fd);
        *fd = -1;
    }
}

static void *ct_process_reader_thread(void *opaque) {
    CtProcess *process = (CtProcess *) opaque;
    int stdout_fd = process->stdout_fd;
    int stderr_fd = process->stderr_fd;

    while (stdout_fd >= 0 || stderr_fd >= 0) {
        fd_set read_fds;
        int max_fd = -1;
        FD_ZERO(&read_fds);
        if (stdout_fd >= 0) {
            FD_SET(stdout_fd, &read_fds);
            if (stdout_fd > max_fd) max_fd = stdout_fd;
        }
        if (stderr_fd >= 0) {
            FD_SET(stderr_fd, &read_fds);
            if (stderr_fd > max_fd) max_fd = stderr_fd;
        }

        int ready = select(max_fd + 1, &read_fds, NULL, NULL, NULL);
        if (ready < 0) {
            if (errno == EINTR) continue;
            break;
        }

        if (stdout_fd >= 0 && FD_ISSET(stdout_fd, &read_fds)) {
            char buffer[8192];
            ssize_t count = read(stdout_fd, buffer, sizeof(buffer));
            if (count > 0) {
                pthread_mutex_lock(&process->mutex);
                (void) ct_byte_buffer_append(&process->stdout_buffer, buffer, (size_t) count);
                pthread_mutex_unlock(&process->mutex);
                ct_process_enqueue_event(
                    process,
                    CT_PROCESS_EVENT_STDOUT,
                    buffer,
                    (size_t) count,
                    0,
                    0,
                    false
                );
            } else {
                close(stdout_fd);
                stdout_fd = -1;
                pthread_mutex_lock(&process->mutex);
                process->stdout_fd = -1;
                pthread_mutex_unlock(&process->mutex);
            }
        }

        if (stderr_fd >= 0 && FD_ISSET(stderr_fd, &read_fds)) {
            char buffer[8192];
            ssize_t count = read(stderr_fd, buffer, sizeof(buffer));
            if (count > 0) {
                pthread_mutex_lock(&process->mutex);
                (void) ct_byte_buffer_append(&process->stderr_buffer, buffer, (size_t) count);
                pthread_mutex_unlock(&process->mutex);
                ct_process_enqueue_event(
                    process,
                    CT_PROCESS_EVENT_STDERR,
                    buffer,
                    (size_t) count,
                    0,
                    0,
                    false
                );
            } else {
                close(stderr_fd);
                stderr_fd = -1;
                pthread_mutex_lock(&process->mutex);
                process->stderr_fd = -1;
                pthread_mutex_unlock(&process->mutex);
            }
        }
    }

    int status = 0;
    while (waitpid(process->pid, &status, 0) < 0) {
        if (errno == EINTR) continue;
        status = 127 << 8;
        break;
    }

    pthread_mutex_lock(&process->mutex);
    if (WIFEXITED(status)) {
        process->exit_code = WEXITSTATUS(status);
        process->signal_code = 0;
    } else if (WIFSIGNALED(status)) {
        process->exit_code = 128 + WTERMSIG(status);
        process->signal_code = WTERMSIG(status);
    } else {
        process->exit_code = 127;
        process->signal_code = 0;
    }
    process->completed = true;
    int exit_code = process->exit_code;
    int signal_code = process->signal_code;
    bool killed = process->killed;
    pthread_mutex_unlock(&process->mutex);

    ct_process_enqueue_event(
        process,
        CT_PROCESS_EVENT_EXIT,
        NULL,
        0,
        exit_code,
        signal_code,
        killed
    );

    return NULL;
}

static void ct_process_free(CtProcess *process) {
    if (process == NULL) return;
    ct_process_close_fd(&process->stdin_fd);
    ct_process_close_fd(&process->stdout_fd);
    ct_process_close_fd(&process->stderr_fd);
    ct_byte_buffer_free(&process->stdout_buffer);
    ct_byte_buffer_free(&process->stderr_buffer);
    pthread_mutex_destroy(&process->mutex);
    free(process);
}

static void ct_process_remove(CtProcess *process) {
    if (process == NULL) return;

    pthread_mutex_lock(&ct_processes_mutex);
    if (ct_processes == process) {
        ct_processes = process->next;
    } else {
        CtProcess *cursor = ct_processes;
        while (cursor != NULL && cursor->next != process) cursor = cursor->next;
        if (cursor != NULL) cursor->next = process->next;
    }
    pthread_mutex_unlock(&ct_processes_mutex);
    process->next = NULL;
}

static JSValue ct_spawn_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *file = NULL;
    char **args = NULL;
    size_t arg_count = 0;
    char *cwd = NULL;
    CtHostEnvEntry *env_entries = NULL;
    size_t env_count = 0;
    bool clear_env = false;
    char *input_data = NULL;
    size_t input_len = 0;
    CtProcessStdioMode stdin_mode = CT_PROCESS_STDIO_IGNORE;
    CtProcessStdioMode stdout_mode = CT_PROCESS_STDIO_PIPE;
    CtProcessStdioMode stderr_mode = CT_PROCESS_STDIO_INHERIT;
    int stdin_pipe[2] = { -1, -1 };
    int stdout_pipe[2] = { -1, -1 };
    int stderr_pipe[2] = { -1, -1 };
    CtProcess *process = NULL;
    pid_t pid = -1;
    (void) this_val;

    if (argc < 1) return JS_ThrowTypeError(ctx, "cottontail.spawnStart(file, args, options) requires a file");
    file = JS_ToCString(ctx, argv[0]);
    if (file == NULL) return JS_EXCEPTION;

    if (argc >= 2 && ct_parse_string_array(ctx, argv[1], &args, &arg_count) != 0) {
        JS_FreeCString(ctx, file);
        return JS_EXCEPTION;
    }

    if (argc >= 3 && !JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) {
        JSValue cwd_value = JS_GetPropertyStr(ctx, argv[2], "cwd");
        JSValue env_value = JS_GetPropertyStr(ctx, argv[2], "env");
        JSValue clear_env_value = JS_GetPropertyStr(ctx, argv[2], "clearEnv");
        if (JS_IsException(cwd_value) || JS_IsException(env_value) || JS_IsException(clear_env_value)) {
            JS_FreeValue(ctx, cwd_value);
            JS_FreeValue(ctx, env_value);
            JS_FreeValue(ctx, clear_env_value);
            JS_FreeCString(ctx, file);
            ct_free_string_array(args, arg_count);
            return JS_EXCEPTION;
        }
        clear_env = JS_ToBool(ctx, clear_env_value) != 0;

        if (!JS_IsUndefined(cwd_value) && !JS_IsNull(cwd_value)) {
            cwd = ct_copy_js_string(ctx, cwd_value);
            if (cwd == NULL) {
                JS_FreeValue(ctx, cwd_value);
                JS_FreeValue(ctx, env_value);
                JS_FreeValue(ctx, clear_env_value);
                JS_FreeCString(ctx, file);
                ct_free_string_array(args, arg_count);
                return JS_EXCEPTION;
            }
        }

        if (ct_parse_env_object(ctx, env_value, &env_entries, &env_count) != 0 ||
            ct_process_parse_stdio_mode(ctx, argv[2], "stdin", CT_PROCESS_STDIO_IGNORE, &stdin_mode) != 0 ||
            ct_process_parse_stdio_mode(ctx, argv[2], "stdout", CT_PROCESS_STDIO_PIPE, &stdout_mode) != 0 ||
            ct_process_parse_stdio_mode(ctx, argv[2], "stderr", CT_PROCESS_STDIO_INHERIT, &stderr_mode) != 0 ||
            ct_process_parse_input(ctx, argv[2], &input_data, &input_len) != 0) {
            JS_FreeValue(ctx, cwd_value);
            JS_FreeValue(ctx, env_value);
            JS_FreeValue(ctx, clear_env_value);
            JS_FreeCString(ctx, file);
            ct_free_string_array(args, arg_count);
            ct_free_env_entries(env_entries, env_count);
            free(cwd);
            free(input_data);
            return JS_EXCEPTION;
        }

        JS_FreeValue(ctx, cwd_value);
        JS_FreeValue(ctx, env_value);
        JS_FreeValue(ctx, clear_env_value);
    }

    if ((stdin_mode == CT_PROCESS_STDIO_PIPE || input_len > 0) && pipe(stdin_pipe) != 0) {
        JSValue error = JS_ThrowInternalError(ctx, "pipe failed: %s", strerror(errno));
        JS_FreeCString(ctx, file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        free(cwd);
        free(input_data);
        return error;
    }
    if (stdout_mode == CT_PROCESS_STDIO_PIPE && pipe(stdout_pipe) != 0) {
        JSValue error = JS_ThrowInternalError(ctx, "pipe failed: %s", strerror(errno));
        ct_process_close_fd(&stdin_pipe[0]);
        ct_process_close_fd(&stdin_pipe[1]);
        JS_FreeCString(ctx, file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        free(cwd);
        free(input_data);
        return error;
    }
    if (stderr_mode == CT_PROCESS_STDIO_PIPE && pipe(stderr_pipe) != 0) {
        JSValue error = JS_ThrowInternalError(ctx, "pipe failed: %s", strerror(errno));
        ct_process_close_fd(&stdin_pipe[0]);
        ct_process_close_fd(&stdin_pipe[1]);
        ct_process_close_fd(&stdout_pipe[0]);
        ct_process_close_fd(&stdout_pipe[1]);
        JS_FreeCString(ctx, file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        free(cwd);
        free(input_data);
        return error;
    }

    pid = fork();
    if (pid < 0) {
        JSValue error = JS_ThrowInternalError(ctx, "fork failed: %s", strerror(errno));
        ct_process_close_fd(&stdin_pipe[0]);
        ct_process_close_fd(&stdin_pipe[1]);
        ct_process_close_fd(&stdout_pipe[0]);
        ct_process_close_fd(&stdout_pipe[1]);
        ct_process_close_fd(&stderr_pipe[0]);
        ct_process_close_fd(&stderr_pipe[1]);
        JS_FreeCString(ctx, file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        free(cwd);
        free(input_data);
        return error;
    }

    if (pid == 0) {
        char **exec_argv = (char **) calloc(arg_count + 2, sizeof(char *));
        if (exec_argv == NULL) _exit(127);
        exec_argv[0] = (char *) file;
        for (size_t index = 0; index < arg_count; index += 1) exec_argv[index + 1] = args[index];
        exec_argv[arg_count + 1] = NULL;

        if (cwd != NULL) chdir(cwd);
        if (clear_env) ct_clear_environment();
        for (size_t index = 0; index < env_count; index += 1) {
            setenv(env_entries[index].name, env_entries[index].value, 1);
        }

        ct_process_close_fd(&stdin_pipe[1]);
        ct_process_close_fd(&stdout_pipe[0]);
        ct_process_close_fd(&stderr_pipe[0]);
        ct_child_apply_input_stdio(stdin_mode, stdin_pipe[0]);
        ct_child_apply_output_stdio(stdout_mode, stdout_pipe[1], STDOUT_FILENO);
        ct_child_apply_output_stdio(stderr_mode, stderr_pipe[1], STDERR_FILENO);
        ct_process_close_fd(&stdin_pipe[0]);
        ct_process_close_fd(&stdout_pipe[1]);
        ct_process_close_fd(&stderr_pipe[1]);

        execvp(file, exec_argv);
        _exit(127);
    }

    ct_process_close_fd(&stdin_pipe[0]);
    ct_process_close_fd(&stdout_pipe[1]);
    ct_process_close_fd(&stderr_pipe[1]);

    bool keep_stdin_pipe = stdin_mode == CT_PROCESS_STDIO_PIPE && input_len == 0;
    if (stdin_pipe[1] >= 0 && input_len > 0) {
        size_t written_total = 0;
        while (written_total < input_len) {
            ssize_t written = write(stdin_pipe[1], input_data + written_total, input_len - written_total);
            if (written < 0) {
                if (errno == EINTR) continue;
                break;
            }
            written_total += (size_t) written;
        }
        ct_process_close_fd(&stdin_pipe[1]);
    } else if (stdin_pipe[1] >= 0 && !keep_stdin_pipe) {
        ct_process_close_fd(&stdin_pipe[1]);
    }

    process = (CtProcess *) calloc(1, sizeof(CtProcess));
    if (process == NULL) {
        kill(pid, SIGTERM);
        waitpid(pid, NULL, 0);
        ct_process_close_fd(&stdin_pipe[1]);
        ct_process_close_fd(&stdout_pipe[0]);
        ct_process_close_fd(&stderr_pipe[0]);
        JS_FreeCString(ctx, file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        free(cwd);
        free(input_data);
        return JS_ThrowOutOfMemory(ctx);
    }

    process->pid = pid;
    process->runtime = (CtQjsRuntime *) JS_GetContextOpaque(ctx);
    process->stdin_fd = keep_stdin_pipe ? stdin_pipe[1] : -1;
    process->stdout_fd = stdout_pipe[0];
    process->stderr_fd = stderr_pipe[0];
    process->exit_code = 0;
    process->signal_code = 0;
    pthread_mutex_init(&process->mutex, NULL);

    pthread_mutex_lock(&ct_processes_mutex);
    process->id = ct_next_process_id++;
    if (ct_next_process_id == 0) ct_next_process_id = 1;
    process->next = ct_processes;
    ct_processes = process;
    pthread_mutex_unlock(&ct_processes_mutex);

    if (pthread_create(&process->thread, NULL, ct_process_reader_thread, process) != 0) {
        ct_process_remove(process);
        kill(pid, SIGTERM);
        waitpid(pid, NULL, 0);
        ct_process_free(process);
        JS_FreeCString(ctx, file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        free(cwd);
        free(input_data);
        return JS_ThrowInternalError(ctx, "failed to create process watcher thread");
    }

    JSValue response = JS_NewObject(ctx);
    if (JS_IsException(response)) {
        JS_FreeCString(ctx, file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        free(cwd);
        free(input_data);
        return response;
    }

    if (JS_SetPropertyStr(ctx, response, "id", JS_NewUint32(ctx, process->id)) < 0 ||
        JS_SetPropertyStr(ctx, response, "pid", JS_NewInt32(ctx, (int32_t) pid)) < 0) {
        JS_FreeValue(ctx, response);
        JS_FreeCString(ctx, file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        free(cwd);
        free(input_data);
        return JS_EXCEPTION;
    }

    JS_FreeCString(ctx, file);
    ct_free_string_array(args, arg_count);
    ct_free_env_entries(env_entries, env_count);
    free(cwd);
    free(input_data);
    return response;
}

static JSValue ct_spawn_poll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t process_id = 0;
    CtProcess *process = NULL;
    JSValue response = JS_UNDEFINED;
    (void) this_val;

    if (argc < 1 || JS_ToUint32(ctx, &process_id, argv[0]) < 0) return JS_EXCEPTION;

    pthread_mutex_lock(&ct_processes_mutex);
    process = ct_process_find(process_id);
    pthread_mutex_unlock(&ct_processes_mutex);
    if (process == NULL) return JS_NULL;

    response = JS_NewObject(ctx);
    if (JS_IsException(response)) return response;

    pthread_mutex_lock(&process->mutex);
    JSValue stdout_value = JS_NewArrayBufferCopy(
        ctx,
        (const uint8_t *) process->stdout_buffer.data,
        process->stdout_buffer.len
    );
    JSValue stderr_value = JS_NewArrayBufferCopy(
        ctx,
        (const uint8_t *) process->stderr_buffer.data,
        process->stderr_buffer.len
    );
    bool failed =
        JS_IsException(stdout_value) ||
        JS_IsException(stderr_value) ||
        JS_SetPropertyStr(ctx, response, "id", JS_NewUint32(ctx, process->id)) < 0 ||
        JS_SetPropertyStr(ctx, response, "pid", JS_NewInt32(ctx, (int32_t) process->pid)) < 0 ||
        JS_SetPropertyStr(ctx, response, "completed", JS_NewBool(ctx, process->completed)) < 0 ||
        JS_SetPropertyStr(ctx, response, "killed", JS_NewBool(ctx, process->killed)) < 0 ||
        JS_SetPropertyStr(ctx, response, "stdout", stdout_value) < 0 ||
        JS_SetPropertyStr(ctx, response, "stderr", stderr_value) < 0;

    if (!failed) {
        JSValue exit_code_value = process->completed ? JS_NewInt32(ctx, process->exit_code) : JS_NULL;
        JSValue signal_code_value = process->signal_code != 0 ? JS_NewInt32(ctx, process->signal_code) : JS_NULL;
        failed =
            JS_SetPropertyStr(ctx, response, "exitCode", exit_code_value) < 0 ||
            JS_SetPropertyStr(ctx, response, "signalCode", signal_code_value) < 0;
    }
    pthread_mutex_unlock(&process->mutex);

    if (failed) {
        JS_FreeValue(ctx, response);
        return JS_EXCEPTION;
    }

    return response;
}

static JSValue ct_spawn_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t process_id = 0;
    CtProcess *process = NULL;
    int stdin_fd = -1;
    uint8_t *bytes = NULL;
    size_t len = 0;
    const char *string_value = NULL;
    size_t string_len = 0;
    bool ok = true;
    (void) this_val;

    if (argc < 2 || JS_ToUint32(ctx, &process_id, argv[0]) < 0) return JS_EXCEPTION;

    if (ct_get_array_buffer_bytes(ctx, argv[1], &bytes, &len) != 0) {
        string_value = JS_ToCStringLen(ctx, &string_len, argv[1]);
        if (string_value == NULL) return JS_EXCEPTION;
        bytes = (uint8_t *) string_value;
        len = string_len;
    }

    pthread_mutex_lock(&ct_processes_mutex);
    process = ct_process_find(process_id);
    pthread_mutex_unlock(&ct_processes_mutex);

    if (process == NULL) {
        if (string_value != NULL) JS_FreeCString(ctx, string_value);
        return JS_NewBool(ctx, false);
    }

    pthread_mutex_lock(&process->mutex);
    stdin_fd = process->stdin_fd;
    if (process->completed || stdin_fd < 0) ok = false;
    pthread_mutex_unlock(&process->mutex);

    if (ok) {
        size_t written_total = 0;
        while (written_total < len) {
            ssize_t written = write(stdin_fd, bytes + written_total, len - written_total);
            if (written < 0) {
                if (errno == EINTR) continue;
                ok = false;
                break;
            }
            written_total += (size_t) written;
        }
    }

    if (string_value != NULL) JS_FreeCString(ctx, string_value);
    return JS_NewBool(ctx, ok);
}

static JSValue ct_spawn_close_stdin(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t process_id = 0;
    CtProcess *process = NULL;
    bool ok = false;
    (void) this_val;

    if (argc < 1 || JS_ToUint32(ctx, &process_id, argv[0]) < 0) return JS_EXCEPTION;

    pthread_mutex_lock(&ct_processes_mutex);
    process = ct_process_find(process_id);
    pthread_mutex_unlock(&ct_processes_mutex);
    if (process == NULL) return JS_NewBool(ctx, false);

    pthread_mutex_lock(&process->mutex);
    if (process->stdin_fd >= 0) {
        ct_process_close_fd(&process->stdin_fd);
        ok = true;
    }
    pthread_mutex_unlock(&process->mutex);

    return JS_NewBool(ctx, ok);
}

static JSValue ct_spawn_kill(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t process_id = 0;
    int32_t signal_number = SIGTERM;
    CtProcess *process = NULL;
    bool ok = false;
    (void) this_val;

    if (argc < 1 || JS_ToUint32(ctx, &process_id, argv[0]) < 0) return JS_EXCEPTION;
    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1]) && JS_ToInt32(ctx, &signal_number, argv[1]) < 0) {
        return JS_EXCEPTION;
    }

    pthread_mutex_lock(&ct_processes_mutex);
    process = ct_process_find(process_id);
    pthread_mutex_unlock(&ct_processes_mutex);
    if (process == NULL) return JS_NewBool(ctx, false);

    pthread_mutex_lock(&process->mutex);
    if (!process->completed && kill(process->pid, signal_number) == 0) {
        process->killed = true;
        ok = true;
    }
    pthread_mutex_unlock(&process->mutex);

    return JS_NewBool(ctx, ok);
}

static JSValue ct_spawn_dispose(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t process_id = 0;
    CtProcess *process = NULL;
    bool completed = false;
    (void) this_val;

    if (argc < 1 || JS_ToUint32(ctx, &process_id, argv[0]) < 0) return JS_EXCEPTION;

    pthread_mutex_lock(&ct_processes_mutex);
    process = ct_process_find(process_id);
    pthread_mutex_unlock(&ct_processes_mutex);
    if (process == NULL) return JS_UNDEFINED;

    pthread_mutex_lock(&process->mutex);
    completed = process->completed;
    pthread_mutex_unlock(&process->mutex);
    if (!completed) return JS_UNDEFINED;

    pthread_join(process->thread, NULL);
    ct_process_remove(process);
    ct_process_free(process);
    return JS_UNDEFINED;
}

static JSValue ct_spawn_set_event_handler(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    CtQjsRuntime *runtime = (CtQjsRuntime *) JS_GetContextOpaque(ctx);
    (void) this_val;

    if (runtime == NULL) {
        return JS_ThrowInternalError(ctx, "Cottontail runtime is not available");
    }

    if (argc < 1 || JS_IsUndefined(argv[0]) || JS_IsNull(argv[0])) {
        if (!JS_IsUndefined(runtime->process_event_callback)) {
            JS_FreeValue(ctx, runtime->process_event_callback);
        }
        runtime->process_event_callback = JS_UNDEFINED;
        return JS_UNDEFINED;
    }

    if (!JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "spawnSetEventHandler requires a function, null, or undefined");
    }

    if (!JS_IsUndefined(runtime->process_event_callback)) {
        JS_FreeValue(ctx, runtime->process_event_callback);
    }
    runtime->process_event_callback = JS_DupValue(ctx, argv[0]);
    return JS_UNDEFINED;
}

static void ct_process_stop_all(void) {
    while (true) {
        pthread_mutex_lock(&ct_processes_mutex);
        CtProcess *process = ct_processes;
        pthread_mutex_unlock(&ct_processes_mutex);
        if (process == NULL) break;

        pthread_mutex_lock(&process->mutex);
        if (!process->completed) {
            process->killed = true;
            kill(process->pid, SIGTERM);
        }
        pthread_mutex_unlock(&process->mutex);

        pthread_join(process->thread, NULL);
        ct_process_remove(process);
        ct_process_free(process);
    }
}

static JSValue ct_spawn_detached(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *file = NULL;
    char **args = NULL;
    size_t arg_count = 0;
    char *cwd = NULL;
    CtHostEnvEntry *env_entries = NULL;
    size_t env_count = 0;
    bool clear_env = false;
    pid_t pid = -1;
    (void) this_val;

    if (argc < 1) return JS_ThrowTypeError(ctx, "cottontail.spawnDetached(file, args, options) requires a file");
    file = JS_ToCString(ctx, argv[0]);
    if (file == NULL) return JS_EXCEPTION;
    if (argc >= 2 && ct_parse_string_array(ctx, argv[1], &args, &arg_count) != 0) {
        JS_FreeCString(ctx, file);
        return JS_EXCEPTION;
    }
    if (argc >= 3 && !JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) {
        JSValue cwd_value = JS_GetPropertyStr(ctx, argv[2], "cwd");
        JSValue env_value = JS_GetPropertyStr(ctx, argv[2], "env");
        JSValue clear_env_value = JS_GetPropertyStr(ctx, argv[2], "clearEnv");
        if (JS_IsException(cwd_value) || JS_IsException(env_value) || JS_IsException(clear_env_value)) {
            JS_FreeValue(ctx, cwd_value);
            JS_FreeValue(ctx, env_value);
            JS_FreeValue(ctx, clear_env_value);
            JS_FreeCString(ctx, file);
            ct_free_string_array(args, arg_count);
            return JS_EXCEPTION;
        }
        clear_env = JS_ToBool(ctx, clear_env_value) != 0;
        if (!JS_IsUndefined(cwd_value) && !JS_IsNull(cwd_value)) {
            cwd = ct_copy_js_string(ctx, cwd_value);
            if (cwd == NULL) {
                JS_FreeValue(ctx, cwd_value);
                JS_FreeValue(ctx, env_value);
                JS_FreeValue(ctx, clear_env_value);
                JS_FreeCString(ctx, file);
                ct_free_string_array(args, arg_count);
                return JS_EXCEPTION;
            }
        }
        if (ct_parse_env_object(ctx, env_value, &env_entries, &env_count) != 0) {
            JS_FreeValue(ctx, cwd_value);
            JS_FreeValue(ctx, env_value);
            JS_FreeValue(ctx, clear_env_value);
            JS_FreeCString(ctx, file);
            ct_free_string_array(args, arg_count);
            free(cwd);
            return JS_EXCEPTION;
        }
        JS_FreeValue(ctx, cwd_value);
        JS_FreeValue(ctx, env_value);
        JS_FreeValue(ctx, clear_env_value);
    }

    pid = fork();
    if (pid < 0) {
        JSValue error = JS_ThrowInternalError(ctx, "fork failed: %s", strerror(errno));
        JS_FreeCString(ctx, file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        free(cwd);
        return error;
    }

    if (pid == 0) {
        char **exec_argv = (char **) calloc(arg_count + 2, sizeof(char *));
        if (exec_argv == NULL) _exit(127);
        exec_argv[0] = (char *) file;
        for (size_t index = 0; index < arg_count; index += 1) {
            exec_argv[index + 1] = args[index];
        }
        exec_argv[arg_count + 1] = NULL;
        setsid();
        if (cwd != NULL) chdir(cwd);
        if (clear_env) ct_clear_environment();
        for (size_t index = 0; index < env_count; index += 1) {
            setenv(env_entries[index].name, env_entries[index].value, 1);
        }
        int devnull = open("/dev/null", O_RDWR);
        if (devnull >= 0) {
            dup2(devnull, STDIN_FILENO);
            dup2(devnull, STDOUT_FILENO);
            dup2(devnull, STDERR_FILENO);
            if (devnull > STDERR_FILENO) close(devnull);
        }
        execvp(file, exec_argv);
        _exit(127);
    }

    JS_FreeCString(ctx, file);
    ct_free_string_array(args, arg_count);
    ct_free_env_entries(env_entries, env_count);
    free(cwd);
    return JS_NewInt32(ctx, (int32_t) pid);
}
#else
static JSValue ct_http_server_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_ThrowInternalError(ctx, "Cottontail Bun.serve is not implemented on Windows yet");
}

static JSValue ct_http_server_poll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_NULL;
}

static JSValue ct_http_server_respond(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_ThrowInternalError(ctx, "Cottontail Bun.serve is not implemented on Windows yet");
}

static JSValue ct_http_server_stop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) ctx;
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_UNDEFINED;
}

static void ct_http_stop_all(void) {}

static JSValue ct_spawn_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_ThrowInternalError(ctx, "Cottontail Bun.spawn is not implemented on Windows yet");
}

static JSValue ct_spawn_poll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_NULL;
}

static JSValue ct_spawn_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_NewBool(ctx, false);
}

static JSValue ct_spawn_close_stdin(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_NewBool(ctx, false);
}

static JSValue ct_spawn_kill(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_NewBool(ctx, false);
}

static JSValue ct_spawn_dispose(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) ctx;
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_UNDEFINED;
}

static JSValue ct_spawn_set_event_handler(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) ctx;
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_UNDEFINED;
}

static void ct_process_stop_all(void) {}

static JSValue ct_spawn_detached(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_ThrowInternalError(ctx, "Cottontail Bun.spawn detached mode is not implemented on Windows yet");
}
#endif

static JSValue ct_spawn_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *file = NULL;
    char **args = NULL;
    size_t arg_count = 0;
    char *cwd = NULL;
    CtHostEnvEntry *env_entries = NULL;
    size_t env_count = 0;
    bool clear_env = false;
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
        JSValue clear_env_value = JS_GetPropertyStr(ctx, argv[2], "clearEnv");
        JSValue stdio_value = JS_GetPropertyStr(ctx, argv[2], "stdio");

        if (JS_IsException(cwd_value) || JS_IsException(env_value) || JS_IsException(clear_env_value) || JS_IsException(stdio_value)) {
            JS_FreeValue(ctx, cwd_value);
            JS_FreeValue(ctx, env_value);
            JS_FreeValue(ctx, clear_env_value);
            JS_FreeValue(ctx, stdio_value);
            JS_FreeCString(ctx, file);
            ct_free_string_array(args, arg_count);
            return JS_EXCEPTION;
        }
        clear_env = JS_ToBool(ctx, clear_env_value) != 0;

        if (!JS_IsUndefined(cwd_value) && !JS_IsNull(cwd_value)) {
            cwd = ct_copy_js_string(ctx, cwd_value);
            if (cwd == NULL) {
                JS_FreeValue(ctx, cwd_value);
                JS_FreeValue(ctx, env_value);
                JS_FreeValue(ctx, clear_env_value);
                JS_FreeValue(ctx, stdio_value);
                JS_FreeCString(ctx, file);
                ct_free_string_array(args, arg_count);
                return JS_EXCEPTION;
            }
        }

        if (ct_parse_env_object(ctx, env_value, &env_entries, &env_count) != 0) {
            JS_FreeValue(ctx, cwd_value);
            JS_FreeValue(ctx, env_value);
            JS_FreeValue(ctx, clear_env_value);
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
                JS_FreeValue(ctx, clear_env_value);
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
                JS_FreeValue(ctx, clear_env_value);
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
        JS_FreeValue(ctx, clear_env_value);
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
                .clear_env = clear_env,
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

static JSValue ct_hostname(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;

#if defined(_WIN32)
    char buffer[MAX_COMPUTERNAME_LENGTH + 1];
    DWORD size = sizeof(buffer);
    if (GetComputerNameA(buffer, &size) == 0) {
        return JS_ThrowInternalError(ctx, "failed to resolve hostname");
    }
    return JS_NewStringLen(ctx, buffer, size);
#else
    char buffer[256];
    if (gethostname(buffer, sizeof(buffer)) != 0) {
        return JS_ThrowInternalError(ctx, "failed to resolve hostname");
    }
    buffer[sizeof(buffer) - 1] = '\0';
    return JS_NewString(ctx, buffer);
#endif
}

static JSValue ct_exec_path(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;

#if defined(_WIN32)
    char buffer[MAX_PATH];
    DWORD len = GetModuleFileNameA(NULL, buffer, sizeof(buffer));
    if (len == 0 || len >= sizeof(buffer)) return JS_ThrowInternalError(ctx, "failed to resolve executable path");
    return JS_NewStringLen(ctx, buffer, len);
#elif defined(__APPLE__)
    char buffer[PATH_MAX];
    uint32_t size = sizeof(buffer);
    if (_NSGetExecutablePath(buffer, &size) != 0) {
        char *dynamic_buffer = (char *) malloc(size);
        if (dynamic_buffer == NULL) return JS_ThrowOutOfMemory(ctx);
        if (_NSGetExecutablePath(dynamic_buffer, &size) != 0) {
            free(dynamic_buffer);
            return JS_ThrowInternalError(ctx, "failed to resolve executable path");
        }
        JSValue result = JS_NewString(ctx, dynamic_buffer);
        free(dynamic_buffer);
        return result;
    }
    return JS_NewString(ctx, buffer);
#else
    char buffer[PATH_MAX];
    ssize_t len = readlink("/proc/self/exe", buffer, sizeof(buffer) - 1);
    if (len < 0) return JS_ThrowInternalError(ctx, "failed to resolve executable path");
    buffer[len] = '\0';
    return JS_NewStringLen(ctx, buffer, (size_t) len);
#endif
}

#if !defined(_WIN32)

struct CtFfiCallback {
    CtQjsRuntime *runtime;
    JSContext *ctx;
    JSValue function;
    CtFfiType returns;
    CtFfiType arg_types[CT_FFI_MAX_ARGS];
    ffi_type *ffi_arg_types[CT_FFI_MAX_ARGS];
    size_t argc;
    bool threadsafe;
    pthread_t owner_thread;
    ffi_cif cif;
    ffi_closure *closure;
    void *code;
};

typedef struct {
    char *script_path;
    CtWorker *worker;
} CtWorkerStart;

typedef struct CtNativeLibrary {
    char *path;
    void *handle;
    struct CtNativeLibrary *next;
} CtNativeLibrary;

static pthread_mutex_t ct_native_libraries_mutex = PTHREAD_MUTEX_INITIALIZER;
static CtNativeLibrary *ct_native_libraries = NULL;

static void *ct_get_native_library_handle(const char *path, char **error_out) {
    void *handle = NULL;

    pthread_mutex_lock(&ct_native_libraries_mutex);
    for (CtNativeLibrary *entry = ct_native_libraries; entry != NULL; entry = entry->next) {
        if (strcmp(entry->path, path) == 0) {
            handle = entry->handle;
            break;
        }
    }
    pthread_mutex_unlock(&ct_native_libraries_mutex);

    if (handle != NULL) {
        return handle;
    }

    handle = dlopen(path, RTLD_LAZY | RTLD_LOCAL);
    if (handle == NULL) {
        const char *message = dlerror();
        *error_out = message != NULL ? ct_duplicate_string(message) : ct_duplicate_string("dlopen failed");
        return NULL;
    }

    CtNativeLibrary *entry = (CtNativeLibrary *) calloc(1, sizeof(CtNativeLibrary));
    if (entry == NULL) {
        *error_out = ct_duplicate_string("out of memory");
        return handle;
    }
    entry->path = ct_duplicate_string(path);
    entry->handle = handle;

    pthread_mutex_lock(&ct_native_libraries_mutex);
    entry->next = ct_native_libraries;
    ct_native_libraries = entry;
    pthread_mutex_unlock(&ct_native_libraries_mutex);

    return handle;
}

static ffi_type *ct_ffi_libffi_type(CtFfiType type) {
    switch (type) {
        case CT_FFI_TYPE_VOID:
            return &ffi_type_void;
        case CT_FFI_TYPE_BOOL:
        case CT_FFI_TYPE_U8:
            return &ffi_type_uint8;
        case CT_FFI_TYPE_I8:
            return &ffi_type_sint8;
        case CT_FFI_TYPE_U16:
            return &ffi_type_uint16;
        case CT_FFI_TYPE_I16:
            return &ffi_type_sint16;
        case CT_FFI_TYPE_U32:
            return &ffi_type_uint32;
        case CT_FFI_TYPE_I32:
            return &ffi_type_sint32;
        case CT_FFI_TYPE_U64:
            return &ffi_type_uint64;
        case CT_FFI_TYPE_I64:
            return &ffi_type_sint64;
        case CT_FFI_TYPE_F32:
            return &ffi_type_float;
        case CT_FFI_TYPE_F64:
            return &ffi_type_double;
        case CT_FFI_TYPE_PTR:
        case CT_FFI_TYPE_CSTRING:
        case CT_FFI_TYPE_FUNCTION:
            return &ffi_type_pointer;
    }

    return &ffi_type_pointer;
}

static bool ct_ffi_type_from_name(const char *name, CtFfiType *out) {
    if (strcmp(name, "void") == 0) *out = CT_FFI_TYPE_VOID;
    else if (strcmp(name, "bool") == 0) *out = CT_FFI_TYPE_BOOL;
    else if (strcmp(name, "u8") == 0) *out = CT_FFI_TYPE_U8;
    else if (strcmp(name, "i8") == 0) *out = CT_FFI_TYPE_I8;
    else if (strcmp(name, "u16") == 0) *out = CT_FFI_TYPE_U16;
    else if (strcmp(name, "i16") == 0) *out = CT_FFI_TYPE_I16;
    else if (strcmp(name, "int") == 0) *out = CT_FFI_TYPE_I32;
    else if (strcmp(name, "u32") == 0) *out = CT_FFI_TYPE_U32;
    else if (strcmp(name, "i32") == 0) *out = CT_FFI_TYPE_I32;
    else if (strcmp(name, "u64") == 0) *out = CT_FFI_TYPE_U64;
    else if (strcmp(name, "i64") == 0) *out = CT_FFI_TYPE_I64;
    else if (strcmp(name, "f32") == 0) *out = CT_FFI_TYPE_F32;
    else if (strcmp(name, "f64") == 0) *out = CT_FFI_TYPE_F64;
    else if (strcmp(name, "ptr") == 0 || strcmp(name, "pointer") == 0) *out = CT_FFI_TYPE_PTR;
    else if (strcmp(name, "cstring") == 0) *out = CT_FFI_TYPE_CSTRING;
    else if (strcmp(name, "function") == 0 || strcmp(name, "callback") == 0) *out = CT_FFI_TYPE_FUNCTION;
    else return false;
    return true;
}

static int ct_parse_ffi_type(JSContext *ctx, JSValueConst value, CtFfiType *out) {
    const char *name = JS_ToCString(ctx, value);
    bool ok = false;

    if (name == NULL) {
        return -1;
    }

    ok = ct_ffi_type_from_name(name, out);
    JS_FreeCString(ctx, name);

    if (!ok) {
        JS_ThrowTypeError(ctx, "unsupported FFI type");
        return -1;
    }

    return 0;
}

static int ct_parse_ffi_type_array(
    JSContext *ctx,
    JSValueConst value,
    CtFfiType *out_types,
    ffi_type **out_ffi_types,
    size_t *out_count
) {
    JSValue length_value = JS_UNDEFINED;
    uint32_t length = 0;

    *out_count = 0;

    if (!JS_IsArray(value)) {
        JS_ThrowTypeError(ctx, "FFI args must be an array of type names");
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

    if (length > CT_FFI_MAX_ARGS) {
        JS_ThrowTypeError(ctx, "Cottontail FFI currently supports up to %d arguments", CT_FFI_MAX_ARGS);
        return -1;
    }

    for (uint32_t index = 0; index < length; index += 1) {
        JSValue item = JS_GetPropertyUint32(ctx, value, index);
        if (JS_IsException(item)) {
            return -1;
        }
        if (ct_parse_ffi_type(ctx, item, &out_types[index]) != 0) {
            JS_FreeValue(ctx, item);
            return -1;
        }
        JS_FreeValue(ctx, item);
        out_ffi_types[index] = ct_ffi_libffi_type(out_types[index]);
    }

    *out_count = length;
    return 0;
}

static int ct_ffi_value_from_js(JSContext *ctx, JSValueConst value, CtFfiType type, CtFfiValue *out) {
    uint64_t native_value = 0;
    double number_value = 0;

    memset(out, 0, sizeof(*out));

    switch (type) {
        case CT_FFI_TYPE_VOID:
            return 0;
        case CT_FFI_TYPE_BOOL:
            out->u8 = JS_ToBool(ctx, value) != 0;
            return 0;
        case CT_FFI_TYPE_F32:
            if (JS_ToFloat64(ctx, &number_value, value) < 0) return -1;
            out->f32 = (float) number_value;
            return 0;
        case CT_FFI_TYPE_F64:
            if (JS_ToFloat64(ctx, &number_value, value) < 0) return -1;
            out->f64 = number_value;
            return 0;
        case CT_FFI_TYPE_U8:
        case CT_FFI_TYPE_I8:
        case CT_FFI_TYPE_U16:
        case CT_FFI_TYPE_I16:
        case CT_FFI_TYPE_U32:
        case CT_FFI_TYPE_I32:
        case CT_FFI_TYPE_U64:
        case CT_FFI_TYPE_I64:
        case CT_FFI_TYPE_PTR:
        case CT_FFI_TYPE_CSTRING:
        case CT_FFI_TYPE_FUNCTION:
            if (JS_IsUndefined(value) || JS_IsNull(value)) {
                native_value = 0;
            } else if (ct_js_value_to_native_u64(ctx, value, &native_value) != 0) {
                JS_ThrowTypeError(ctx, "FFI argument must be a number, bigint, ArrayBuffer, typed array, null, or undefined");
                return -1;
            }
            out->u64 = native_value;
            return 0;
    }

    return -1;
}

static void *ct_ffi_value_ptr(CtFfiValue *value, CtFfiType type) {
    switch (type) {
        case CT_FFI_TYPE_BOOL:
        case CT_FFI_TYPE_U8:
            return &value->u8;
        case CT_FFI_TYPE_I8:
            return &value->i8;
        case CT_FFI_TYPE_U16:
            return &value->u16;
        case CT_FFI_TYPE_I16:
            return &value->i16;
        case CT_FFI_TYPE_U32:
            return &value->u32;
        case CT_FFI_TYPE_I32:
            return &value->i32;
        case CT_FFI_TYPE_U64:
            return &value->u64;
        case CT_FFI_TYPE_I64:
            return &value->i64;
        case CT_FFI_TYPE_F32:
            return &value->f32;
        case CT_FFI_TYPE_F64:
            return &value->f64;
        case CT_FFI_TYPE_PTR:
        case CT_FFI_TYPE_CSTRING:
        case CT_FFI_TYPE_FUNCTION:
            value->ptr = (void *) (uintptr_t) value->u64;
            return &value->ptr;
        case CT_FFI_TYPE_VOID:
            return NULL;
    }

    return NULL;
}

static JSValue ct_ffi_value_to_js(JSContext *ctx, CtFfiType type, CtFfiValue value) {
    switch (type) {
        case CT_FFI_TYPE_VOID:
            return JS_UNDEFINED;
        case CT_FFI_TYPE_BOOL:
            return JS_NewBool(ctx, value.u8 != 0);
        case CT_FFI_TYPE_U8:
            return JS_NewUint32(ctx, value.u8);
        case CT_FFI_TYPE_I8:
            return JS_NewInt32(ctx, value.i8);
        case CT_FFI_TYPE_U16:
            return JS_NewUint32(ctx, value.u16);
        case CT_FFI_TYPE_I16:
            return JS_NewInt32(ctx, value.i16);
        case CT_FFI_TYPE_U32:
            return JS_NewUint32(ctx, value.u32);
        case CT_FFI_TYPE_I32:
            return JS_NewInt32(ctx, value.i32);
        case CT_FFI_TYPE_U64:
            return JS_NewBigUint64(ctx, value.u64);
        case CT_FFI_TYPE_I64:
            return JS_NewBigInt64(ctx, value.i64);
        case CT_FFI_TYPE_F32:
            return JS_NewFloat64(ctx, value.f32);
        case CT_FFI_TYPE_F64:
            return JS_NewFloat64(ctx, value.f64);
        case CT_FFI_TYPE_PTR:
        case CT_FFI_TYPE_CSTRING:
        case CT_FFI_TYPE_FUNCTION:
            return JS_NewFloat64(ctx, (double) (uintptr_t) value.ptr);
    }

    return JS_UNDEFINED;
}

static int ct_ffi_result_from_js(JSContext *ctx, JSValueConst value, CtFfiType type, CtFfiValue *out) {
    return ct_ffi_value_from_js(ctx, value, type, out);
}

static int ct_call_js_callback(CtFfiCallback *callback, CtFfiValue *args, size_t argc, CtFfiValue *result) {
    JSContext *ctx = callback->ctx;
    JSValue js_args[CT_FFI_MAX_ARGS];
    JSValue js_result = JS_UNDEFINED;
    int status = 0;

    for (size_t index = 0; index < argc; index += 1) {
        js_args[index] = ct_ffi_value_to_js(ctx, callback->arg_types[index], args[index]);
        if (JS_IsException(js_args[index])) {
            for (size_t cleanup = 0; cleanup < index; cleanup += 1) {
                JS_FreeValue(ctx, js_args[cleanup]);
            }
            return -1;
        }
    }

    js_result = JS_Call(ctx, callback->function, JS_UNDEFINED, (int) argc, js_args);
    for (size_t index = 0; index < argc; index += 1) {
        JS_FreeValue(ctx, js_args[index]);
    }

    if (JS_IsException(js_result)) {
        char *message = ct_copy_exception(ctx);
        fprintf(stderr, "Cottontail FFI callback failed: %s\n", message != NULL ? message : "unknown error");
        free(message);
        return -1;
    }

    if (callback->returns != CT_FFI_TYPE_VOID) {
        status = ct_ffi_result_from_js(ctx, js_result, callback->returns, result);
    }
    JS_FreeValue(ctx, js_result);
    if (ct_drain_jobs(callback->runtime, NULL) != 0) {
        return -1;
    }
    return status;
}

static void ct_write_ffi_return(void *ret, CtFfiType type, CtFfiValue value) {
    if (ret == NULL) return;

    switch (type) {
        case CT_FFI_TYPE_VOID:
            return;
        case CT_FFI_TYPE_BOOL:
        case CT_FFI_TYPE_U8:
            *((uint8_t *) ret) = value.u8;
            return;
        case CT_FFI_TYPE_I8:
            *((int8_t *) ret) = value.i8;
            return;
        case CT_FFI_TYPE_U16:
            *((uint16_t *) ret) = value.u16;
            return;
        case CT_FFI_TYPE_I16:
            *((int16_t *) ret) = value.i16;
            return;
        case CT_FFI_TYPE_U32:
            *((uint32_t *) ret) = value.u32;
            return;
        case CT_FFI_TYPE_I32:
            *((int32_t *) ret) = value.i32;
            return;
        case CT_FFI_TYPE_U64:
            *((uint64_t *) ret) = value.u64;
            return;
        case CT_FFI_TYPE_I64:
            *((int64_t *) ret) = value.i64;
            return;
        case CT_FFI_TYPE_F32:
            *((float *) ret) = value.f32;
            return;
        case CT_FFI_TYPE_F64:
            *((double *) ret) = value.f64;
            return;
        case CT_FFI_TYPE_PTR:
        case CT_FFI_TYPE_CSTRING:
        case CT_FFI_TYPE_FUNCTION:
            *((void **) ret) = (void *) (uintptr_t) value.u64;
            return;
    }
}

static void ct_enqueue_callback_job(CtQjsRuntime *runtime, CtFfiCallbackJob *job) {
    pthread_mutex_lock(&runtime->callback_mutex);
    if (runtime->callback_jobs_tail != NULL) {
        runtime->callback_jobs_tail->next = job;
    } else {
        runtime->callback_jobs_head = job;
    }
    runtime->callback_jobs_tail = job;
    pthread_mutex_unlock(&runtime->callback_mutex);
}

static void ct_ffi_callback_dispatch(ffi_cif *cif, void *ret, void **args, void *userdata) {
    CtFfiCallback *callback = (CtFfiCallback *) userdata;
    CtFfiValue values[CT_FFI_MAX_ARGS];
    CtFfiValue result;
    bool same_thread = false;
    bool wait_for_result = false;
    (void) cif;

    memset(&result, 0, sizeof(result));
    memset(values, 0, sizeof(values));

    for (size_t index = 0; index < callback->argc; index += 1) {
        switch (callback->arg_types[index]) {
            case CT_FFI_TYPE_BOOL:
            case CT_FFI_TYPE_U8:
                values[index].u8 = *((uint8_t *) args[index]);
                break;
            case CT_FFI_TYPE_I8:
                values[index].i8 = *((int8_t *) args[index]);
                break;
            case CT_FFI_TYPE_U16:
                values[index].u16 = *((uint16_t *) args[index]);
                break;
            case CT_FFI_TYPE_I16:
                values[index].i16 = *((int16_t *) args[index]);
                break;
            case CT_FFI_TYPE_U32:
                values[index].u32 = *((uint32_t *) args[index]);
                break;
            case CT_FFI_TYPE_I32:
                values[index].i32 = *((int32_t *) args[index]);
                break;
            case CT_FFI_TYPE_U64:
                values[index].u64 = *((uint64_t *) args[index]);
                break;
            case CT_FFI_TYPE_I64:
                values[index].i64 = *((int64_t *) args[index]);
                break;
            case CT_FFI_TYPE_F32:
                values[index].f32 = *((float *) args[index]);
                break;
            case CT_FFI_TYPE_F64:
                values[index].f64 = *((double *) args[index]);
                break;
            case CT_FFI_TYPE_PTR:
            case CT_FFI_TYPE_CSTRING:
            case CT_FFI_TYPE_FUNCTION:
                values[index].u64 = (uint64_t) (uintptr_t) *((void **) args[index]);
                break;
            case CT_FFI_TYPE_VOID:
                break;
        }
    }

    same_thread = pthread_equal(pthread_self(), callback->owner_thread) != 0;
    wait_for_result = !callback->threadsafe || callback->returns != CT_FFI_TYPE_VOID;

    if (same_thread) {
        if (ct_call_js_callback(callback, values, callback->argc, &result) != 0) {
            memset(&result, 0, sizeof(result));
        }
        ct_write_ffi_return(ret, callback->returns, result);
        return;
    }

    CtFfiCallbackJob *job = (CtFfiCallbackJob *) calloc(1, sizeof(CtFfiCallbackJob));
    if (job == NULL) {
        ct_write_ffi_return(ret, callback->returns, result);
        return;
    }

    job->callback = callback;
    job->argc = callback->argc;
    job->wait_for_result = wait_for_result;
    memcpy(job->args, values, sizeof(CtFfiValue) * callback->argc);

    if (wait_for_result) {
        pthread_mutex_init(&job->mutex, NULL);
        pthread_cond_init(&job->cond, NULL);
        pthread_mutex_lock(&job->mutex);
    }

    ct_enqueue_callback_job(callback->runtime, job);

    if (wait_for_result) {
        while (!job->completed) {
            pthread_cond_wait(&job->cond, &job->mutex);
        }
        result = job->result;
        pthread_mutex_unlock(&job->mutex);
        pthread_cond_destroy(&job->cond);
        pthread_mutex_destroy(&job->mutex);
        free(job);
    }

    ct_write_ffi_return(ret, callback->returns, result);
}

static int ct_drain_ffi_callbacks(CtQjsRuntime *runtime, char **error_out) {
    (void) error_out;

    while (true) {
        pthread_mutex_lock(&runtime->callback_mutex);
        CtFfiCallbackJob *job = runtime->callback_jobs_head;
        if (job != NULL) {
            runtime->callback_jobs_head = job->next;
            if (runtime->callback_jobs_head == NULL) {
                runtime->callback_jobs_tail = NULL;
            }
        }
        pthread_mutex_unlock(&runtime->callback_mutex);

        if (job == NULL) {
            break;
        }

        if (ct_call_js_callback(job->callback, job->args, job->argc, &job->result) != 0) {
            memset(&job->result, 0, sizeof(job->result));
        }

        if (job->wait_for_result) {
            pthread_mutex_lock(&job->mutex);
            job->completed = true;
            pthread_cond_signal(&job->cond);
            pthread_mutex_unlock(&job->mutex);
        } else {
            free(job);
        }
    }

    return 0;
}

static JSValue ct_memory_address(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint64_t address = 0;
    (void) this_val;

    if (argc < 1 || ct_js_value_to_native_u64(ctx, argv[0], &address) != 0) {
        return JS_ThrowTypeError(ctx, "cottontail.memoryAddress(value) requires an ArrayBuffer, typed array, number, or bigint");
    }

    return JS_NewFloat64(ctx, (double) address);
}

static JSValue ct_memory_view(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint64_t address = 0;
    uint64_t offset = 0;
    uint64_t length = 0;
    (void) this_val;

    if (argc < 3 ||
        ct_js_value_to_native_u64(ctx, argv[0], &address) != 0 ||
        ct_js_value_to_native_u64(ctx, argv[1], &offset) != 0 ||
        ct_js_value_to_native_u64(ctx, argv[2], &length) != 0) {
        return JS_ThrowTypeError(ctx, "cottontail.memoryView(ptr, offset, length) requires pointer, offset, and length");
    }

    if (address == 0 || length == 0) {
        return JS_NewArrayBufferCopy(ctx, NULL, 0);
    }

    return JS_NewArrayBuffer(
        ctx,
        (uint8_t *) (uintptr_t) (address + offset),
        (size_t) length,
        ct_external_array_buffer_noop,
        NULL,
        false
    );
}

static JSValue ct_native_call(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *library_path = NULL;
    const char *symbol_name = NULL;
    void *handle = NULL;
    void *symbol = NULL;
    char *open_error = NULL;
    CtFfiType return_type = CT_FFI_TYPE_VOID;
    CtFfiType arg_types[CT_FFI_MAX_ARGS];
    ffi_type *ffi_arg_types[CT_FFI_MAX_ARGS];
    CtFfiValue arg_values[CT_FFI_MAX_ARGS];
    void *arg_value_ptrs[CT_FFI_MAX_ARGS];
    CtFfiValue result;
    ffi_cif cif;
    size_t arg_count = 0;
    JSValue js_result = JS_UNDEFINED;
    (void) this_val;

    memset(&result, 0, sizeof(result));

    if (argc < 5) {
        return JS_ThrowTypeError(ctx, "cottontail.nativeCall(library, symbol, returnType, argTypes, args) requires five arguments");
    }

    library_path = JS_ToCString(ctx, argv[0]);
    symbol_name = JS_ToCString(ctx, argv[1]);
    if (library_path == NULL || symbol_name == NULL) {
        JS_FreeCString(ctx, library_path);
        JS_FreeCString(ctx, symbol_name);
        return JS_EXCEPTION;
    }

    if (ct_parse_ffi_type(ctx, argv[2], &return_type) != 0 ||
        ct_parse_ffi_type_array(ctx, argv[3], arg_types, ffi_arg_types, &arg_count) != 0) {
        JS_FreeCString(ctx, library_path);
        JS_FreeCString(ctx, symbol_name);
        return JS_EXCEPTION;
    }

    if (!JS_IsArray(argv[4])) {
        JS_FreeCString(ctx, library_path);
        JS_FreeCString(ctx, symbol_name);
        return JS_ThrowTypeError(ctx, "cottontail.nativeCall args must be an array");
    }

    for (size_t index = 0; index < arg_count; index += 1) {
        JSValue item = JS_GetPropertyUint32(ctx, argv[4], (uint32_t) index);
        if (JS_IsException(item)) {
            JS_FreeCString(ctx, library_path);
            JS_FreeCString(ctx, symbol_name);
            return JS_EXCEPTION;
        }
        if (ct_ffi_value_from_js(ctx, item, arg_types[index], &arg_values[index]) != 0) {
            JS_FreeValue(ctx, item);
            JS_FreeCString(ctx, library_path);
            JS_FreeCString(ctx, symbol_name);
            return JS_EXCEPTION;
        }
        JS_FreeValue(ctx, item);
        arg_value_ptrs[index] = ct_ffi_value_ptr(&arg_values[index], arg_types[index]);
    }

    handle = ct_get_native_library_handle(library_path, &open_error);
    if (handle == NULL) {
        JSValue error = JS_ThrowInternalError(ctx, "dlopen(%s) failed: %s", library_path, open_error != NULL ? open_error : "unknown error");
        free(open_error);
        JS_FreeCString(ctx, library_path);
        JS_FreeCString(ctx, symbol_name);
        return error;
    }

    symbol = dlsym(handle, symbol_name);
    if (symbol == NULL) {
        JSValue error = JS_ThrowInternalError(ctx, "dlsym(%s) failed: %s", symbol_name, dlerror());
        JS_FreeCString(ctx, library_path);
        JS_FreeCString(ctx, symbol_name);
        return error;
    }

    if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, (unsigned int) arg_count, ct_ffi_libffi_type(return_type), ffi_arg_types) != FFI_OK) {
        JS_FreeCString(ctx, library_path);
        JS_FreeCString(ctx, symbol_name);
        return JS_ThrowInternalError(ctx, "ffi_prep_cif failed for %s", symbol_name);
    }

    ffi_call(&cif, FFI_FN(symbol), ct_ffi_value_ptr(&result, return_type), arg_value_ptrs);
    js_result = ct_ffi_value_to_js(ctx, return_type, result);

    JS_FreeCString(ctx, library_path);
    JS_FreeCString(ctx, symbol_name);
    return js_result;
}

static JSValue ct_create_callback(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    CtQjsRuntime *runtime = (CtQjsRuntime *) JS_GetContextOpaque(ctx);
    CtFfiCallback *callback = NULL;
    (void) this_val;

    if (argc < 4 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "cottontail.createCallback(fn, argTypes, returnType, threadsafe) requires a function");
    }

    callback = (CtFfiCallback *) calloc(1, sizeof(CtFfiCallback));
    if (callback == NULL) {
        return JS_ThrowOutOfMemory(ctx);
    }

    callback->runtime = runtime;
    callback->ctx = ctx;
    callback->function = JS_DupValue(ctx, argv[0]);
    callback->threadsafe = JS_ToBool(ctx, argv[3]) != 0;
    callback->owner_thread = pthread_self();

    if (ct_parse_ffi_type_array(ctx, argv[1], callback->arg_types, callback->ffi_arg_types, &callback->argc) != 0 ||
        ct_parse_ffi_type(ctx, argv[2], &callback->returns) != 0) {
        JS_FreeValue(ctx, callback->function);
        free(callback);
        return JS_EXCEPTION;
    }

    callback->closure = ffi_closure_alloc(sizeof(ffi_closure), &callback->code);
    if (callback->closure == NULL) {
        JS_FreeValue(ctx, callback->function);
        free(callback);
        return JS_ThrowOutOfMemory(ctx);
    }

    if (ffi_prep_cif(
            &callback->cif,
            FFI_DEFAULT_ABI,
            (unsigned int) callback->argc,
            ct_ffi_libffi_type(callback->returns),
            callback->ffi_arg_types
        ) != FFI_OK ||
        ffi_prep_closure_loc(
            callback->closure,
            &callback->cif,
            ct_ffi_callback_dispatch,
            callback,
            callback->code
        ) != FFI_OK) {
        ffi_closure_free(callback->closure);
        JS_FreeValue(ctx, callback->function);
        free(callback);
        return JS_ThrowInternalError(ctx, "failed to create FFI callback");
    }

    return JS_NewFloat64(ctx, (double) (uintptr_t) callback->code);
}

static int ct_get_array_buffer_bytes(JSContext *ctx, JSValueConst value, uint8_t **out_data, size_t *out_len) {
    uint8_t *data = NULL;
    size_t len = 0;

    data = JS_GetArrayBuffer(ctx, &len, value);
    if (data != NULL) {
        *out_data = data;
        *out_len = len;
        return 0;
    }

    JSValue buffer = JS_GetPropertyStr(ctx, value, "buffer");
    if (JS_IsException(buffer)) {
        return -1;
    }
    if (!JS_IsUndefined(buffer) && !JS_IsNull(buffer)) {
        JSValue byte_offset_value = JS_GetPropertyStr(ctx, value, "byteOffset");
        JSValue byte_length_value = JS_GetPropertyStr(ctx, value, "byteLength");
        uint32_t byte_offset = 0;
        uint32_t byte_length = 0;

        if (JS_IsException(byte_offset_value) || JS_IsException(byte_length_value) ||
            JS_ToUint32(ctx, &byte_offset, byte_offset_value) < 0 ||
            JS_ToUint32(ctx, &byte_length, byte_length_value) < 0) {
            JS_FreeValue(ctx, byte_offset_value);
            JS_FreeValue(ctx, byte_length_value);
            JS_FreeValue(ctx, buffer);
            return -1;
        }
        JS_FreeValue(ctx, byte_offset_value);
        JS_FreeValue(ctx, byte_length_value);

        data = JS_GetArrayBuffer(ctx, &len, buffer);
        JS_FreeValue(ctx, buffer);
        if (data == NULL || byte_offset > len || byte_length > len - byte_offset) {
            return -1;
        }
        *out_data = data + byte_offset;
        *out_len = byte_length;
        return 0;
    }

    JS_FreeValue(ctx, buffer);
    return -1;
}

static JSValue ct_inflate_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *input = NULL;
    size_t input_len = 0;
    z_stream stream;
    uint8_t *output = NULL;
    size_t output_capacity = 0;
    size_t output_len = 0;
    int status = Z_OK;
    JSValue result = JS_UNDEFINED;
    (void) this_val;

    if (argc < 1 || ct_get_array_buffer_bytes(ctx, argv[0], &input, &input_len) != 0) {
        return JS_ThrowTypeError(ctx, "cottontail.inflateSync(data) requires an ArrayBuffer or typed array");
    }

    memset(&stream, 0, sizeof(stream));
    status = inflateInit(&stream);
    if (status != Z_OK) {
        return JS_ThrowInternalError(ctx, "inflateInit failed");
    }

    output_capacity = input_len * 3 + 1024;
    if (output_capacity < 4096) output_capacity = 4096;
    output = (uint8_t *) malloc(output_capacity);
    if (output == NULL) {
        inflateEnd(&stream);
        return JS_ThrowOutOfMemory(ctx);
    }

    stream.next_in = input;
    stream.avail_in = (uInt) input_len;

    while (true) {
        if (output_len == output_capacity) {
            size_t next_capacity = output_capacity * 2;
            uint8_t *next_output = (uint8_t *) realloc(output, next_capacity);
            if (next_output == NULL) {
                free(output);
                inflateEnd(&stream);
                return JS_ThrowOutOfMemory(ctx);
            }
            output = next_output;
            output_capacity = next_capacity;
        }

        stream.next_out = output + output_len;
        stream.avail_out = (uInt) (output_capacity - output_len);
        status = inflate(&stream, Z_NO_FLUSH);
        output_len = stream.total_out;

        if (status == Z_STREAM_END) break;
        if (status != Z_OK) {
            JSValue error = JS_ThrowInternalError(ctx, "inflate failed: %d", status);
            free(output);
            inflateEnd(&stream);
            return error;
        }
    }

    result = JS_NewArrayBufferCopy(ctx, output, output_len);
    free(output);
    inflateEnd(&stream);
    return result;
}

static CtWorker *ct_worker_find_locked(uint32_t id) {
    for (CtWorker *worker = ct_workers; worker != NULL; worker = worker->next) {
        if (worker->id == id) return worker;
    }
    return NULL;
}

static CtWorker *ct_worker_find(uint32_t id) {
    CtWorker *worker = NULL;
    pthread_mutex_lock(&ct_workers_mutex);
    worker = ct_worker_find_locked(id);
    pthread_mutex_unlock(&ct_workers_mutex);
    return worker;
}

static int ct_worker_queue_push_locked(CtWorkerMessage **head, CtWorkerMessage **tail, const char *json) {
    CtWorkerMessage *message = (CtWorkerMessage *) calloc(1, sizeof(CtWorkerMessage));
    if (message == NULL) return -1;
    message->json = ct_duplicate_string(json);
    if (message->json == NULL) {
        free(message);
        return -1;
    }

    if (*tail != NULL) {
        (*tail)->next = message;
    } else {
        *head = message;
    }
    *tail = message;
    return 0;
}

static JSValue ct_worker_drain_queue(JSContext *ctx, CtWorker *worker, bool parent_to_worker) {
    CtWorkerMessage *head = NULL;
    CtWorkerMessage *tail = NULL;
    JSValue array = JS_NewArray(ctx);
    uint32_t index = 0;

    if (JS_IsException(array)) return array;

    pthread_mutex_lock(&worker->mutex);
    if (parent_to_worker) {
        head = worker->parent_to_worker_head;
        tail = worker->parent_to_worker_tail;
        worker->parent_to_worker_head = NULL;
        worker->parent_to_worker_tail = NULL;
    } else {
        head = worker->worker_to_parent_head;
        tail = worker->worker_to_parent_tail;
        worker->worker_to_parent_head = NULL;
        worker->worker_to_parent_tail = NULL;
    }
    (void) tail;
    pthread_mutex_unlock(&worker->mutex);

    while (head != NULL) {
        CtWorkerMessage *next = head->next;
        JS_SetPropertyUint32(ctx, array, index++, JS_NewString(ctx, head->json));
        free(head->json);
        free(head);
        head = next;
    }

    return array;
}

static JSValue ct_is_worker(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    CtQjsRuntime *runtime = (CtQjsRuntime *) JS_GetContextOpaque(ctx);
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_NewBool(ctx, runtime != NULL && runtime->worker != NULL);
}

static JSValue ct_worker_post_message(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    CtQjsRuntime *runtime = (CtQjsRuntime *) JS_GetContextOpaque(ctx);
    CtQjsRuntime *parent_runtime = NULL;
    uint32_t worker_id = 0;
    const char *json = NULL;
    int status = 0;
    (void) this_val;

    if (runtime == NULL || runtime->worker == NULL) {
        return JS_ThrowInternalError(ctx, "workerPostMessage is only available inside a worker");
    }
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "workerPostMessage(json) requires a JSON string");
    }

    json = JS_ToCString(ctx, argv[0]);
    if (json == NULL) return JS_EXCEPTION;

    pthread_mutex_lock(&runtime->worker->mutex);
    status = ct_worker_queue_push_locked(
        &runtime->worker->worker_to_parent_head,
        &runtime->worker->worker_to_parent_tail,
        json
    );
    parent_runtime = runtime->worker->parent_runtime;
    worker_id = runtime->worker->id;
    pthread_mutex_unlock(&runtime->worker->mutex);
    JS_FreeCString(ctx, json);

    if (status != 0) return JS_ThrowOutOfMemory(ctx);
    ct_worker_enqueue_event(parent_runtime, worker_id);
    return JS_TRUE;
}

static JSValue ct_worker_poll_incoming_messages(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    CtQjsRuntime *runtime = (CtQjsRuntime *) JS_GetContextOpaque(ctx);
    (void) this_val;
    (void) argc;
    (void) argv;

    if (runtime == NULL || runtime->worker == NULL) {
        return JS_NewArray(ctx);
    }
    return ct_worker_drain_queue(ctx, runtime->worker, true);
}

static JSValue ct_worker_post_message_to(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t id = 0;
    const char *json = NULL;
    CtWorker *worker = NULL;
    int status = 0;
    (void) this_val;

    if (argc < 2 || JS_ToUint32(ctx, &id, argv[0]) < 0) {
        return JS_ThrowTypeError(ctx, "workerPostMessageTo(id, json) requires a worker id");
    }
    json = JS_ToCString(ctx, argv[1]);
    if (json == NULL) return JS_EXCEPTION;

    worker = ct_worker_find(id);
    if (worker == NULL) {
        JS_FreeCString(ctx, json);
        return JS_ThrowReferenceError(ctx, "worker not found: %" PRIu32, id);
    }

    pthread_mutex_lock(&worker->mutex);
    status = ct_worker_queue_push_locked(&worker->parent_to_worker_head, &worker->parent_to_worker_tail, json);
    pthread_mutex_unlock(&worker->mutex);
    JS_FreeCString(ctx, json);

    if (status != 0) return JS_ThrowOutOfMemory(ctx);
    return JS_TRUE;
}

static JSValue ct_worker_poll_messages(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t id = 0;
    CtWorker *worker = NULL;
    (void) this_val;

    if (argc < 1 || JS_ToUint32(ctx, &id, argv[0]) < 0) {
        return JS_ThrowTypeError(ctx, "workerPollMessages(id) requires a worker id");
    }

    worker = ct_worker_find(id);
    if (worker == NULL) return JS_NewArray(ctx);
    return ct_worker_drain_queue(ctx, worker, false);
}

static JSValue ct_worker_terminate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t id = 0;
    CtWorker *worker = NULL;
    (void) this_val;

    if (argc < 1 || JS_ToUint32(ctx, &id, argv[0]) < 0) {
        return JS_ThrowTypeError(ctx, "workerTerminate(id) requires a worker id");
    }

    worker = ct_worker_find(id);
    if (worker == NULL) return JS_FALSE;

    pthread_mutex_lock(&worker->mutex);
    worker->terminated = true;
    pthread_mutex_unlock(&worker->mutex);
    return JS_TRUE;
}

static void *ct_worker_entry(void *opaque) {
    CtWorkerStart *start = (CtWorkerStart *) opaque;
    CtQjsRuntime *runtime = ct_qjs_runtime_create();
    char *source = NULL;
    size_t source_len = 0;
    char *error = NULL;
    static const char worker_bootstrap_source[] =
        "(()=>{"
        "const g=globalThis;"
        "g.self=g;"
        "const listeners=new Map();"
        "function serialize(message){"
        "const seen=new WeakSet();"
        "return JSON.stringify(message,(_key,value)=>{"
        "if(typeof value==='bigint')return value.toString();"
        "if(typeof value==='function'||typeof value==='symbol')return undefined;"
        "if(value&&typeof value==='object'){if(seen.has(value))return undefined;seen.add(value);}"
        "return value;"
        "});"
        "}"
        "function add(name,handler){"
        "if(typeof handler!=='function')return g;"
        "const key=String(name);"
        "const handlers=listeners.get(key)||[];"
        "handlers.push(handler);"
        "listeners.set(key,handlers);"
        "return g;"
        "}"
        "function remove(name,handler){"
        "const key=String(name);"
        "const handlers=listeners.get(key)||[];"
        "listeners.set(key,handlers.filter((item)=>item!==handler&&item.listener!==handler));"
        "return g;"
        "}"
        "function emit(name,event){"
        "const handler=g['on'+name];"
        "if(typeof handler==='function')handler.call(g,event);"
        "for(const listener of listeners.get(String(name))||[])listener.call(g,event);"
        "}"
        "g.postMessage=g.self.postMessage=(message)=>cottontail.workerPostMessage(serialize(message));"
        "g.addEventListener=g.self.addEventListener=add;"
        "g.removeEventListener=g.self.removeEventListener=remove;"
        "g.__cottontailPollWorkerMessages=()=>{"
        "for(const item of cottontail.workerPollIncomingMessages()){"
        "let data=item;"
        "try{data=JSON.parse(item);}catch{}"
        "emit('message',{data});"
        "}"
        "};"
        "if(!g.__cottontailHasActiveHandles)g.__cottontailHasActiveHandles=()=>{"
        "const handler=g['onmessage'];"
        "return typeof handler==='function'||((listeners.get('message')||[]).length>0);"
        "};"
        "if(!g.__cottontailRunLoopTick)g.__cottontailRunLoopTick=()=>{"
        "g.__cottontailPollWorkerMessages();"
        "if(cottontail.drainJobs)cottontail.drainJobs();"
        "return 16;"
        "};"
        "})();";

    if (runtime == NULL) {
        fprintf(stderr, "cottontail: worker runtime initialization failed\n");
        free(start->script_path);
        free(start);
        return NULL;
    }
    runtime->worker = start->worker;

    JSValue bootstrap_result = JS_Eval(
        runtime->context,
        worker_bootstrap_source,
        sizeof(worker_bootstrap_source) - 1,
        "<cottontail-worker-bootstrap>",
        JS_EVAL_TYPE_GLOBAL
    );
    if (JS_IsException(bootstrap_result)) {
        error = ct_copy_exception(runtime->context);
        fprintf(stderr, "%s\n", error != NULL ? error : "cottontail: worker bootstrap failed");
        ct_qjs_string_free(error);
        ct_qjs_runtime_destroy(runtime);
        free(start->script_path);
        free(start);
        return NULL;
    }
    JS_FreeValue(runtime->context, bootstrap_result);

    if (ct_read_file_bytes(start->script_path, &source, &source_len) != 0) {
        fprintf(stderr, "cottontail: failed to load worker script %s\n", start->script_path);
        ct_qjs_runtime_destroy(runtime);
        free(start->script_path);
        free(start);
        return NULL;
    }

    if (ct_qjs_runtime_eval(runtime, (const uint8_t *) source, source_len, start->script_path, &error) != 0) {
        fprintf(stderr, "%s\n", error != NULL ? error : "cottontail: worker script failed");
        ct_qjs_string_free(error);
        free(source);
        ct_qjs_runtime_destroy(runtime);
        free(start->script_path);
        free(start);
        return NULL;
    }
    free(source);

    while (true) {
        bool terminated = false;
        pthread_mutex_lock(&start->worker->mutex);
        terminated = start->worker->terminated;
        pthread_mutex_unlock(&start->worker->mutex);
        if (terminated) break;

        if (ct_qjs_runtime_tick(runtime, &error) != 0) {
            fprintf(stderr, "%s\n", error != NULL ? error : "cottontail: worker tick failed");
            ct_qjs_string_free(error);
            break;
        }
        usleep((useconds_t) runtime->next_tick_delay_ms * 1000u);
    }

    ct_qjs_runtime_destroy(runtime);
    pthread_mutex_lock(&start->worker->mutex);
    start->worker->terminated = true;
    pthread_mutex_unlock(&start->worker->mutex);
    free(start->script_path);
    free(start);
    return NULL;
}

static JSValue ct_spawn_worker(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    CtQjsRuntime *runtime = (CtQjsRuntime *) JS_GetContextOpaque(ctx);
    const char *script_path = NULL;
    CtWorkerStart *start = NULL;
    CtWorker *worker = NULL;
    pthread_t thread;
    pthread_attr_t attr;
    int attr_status = 0;
    int create_status = 0;
    (void) this_val;

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "cottontail.spawnWorker(scriptPath) requires a script path");
    }

    script_path = JS_ToCString(ctx, argv[0]);
    if (script_path == NULL) {
        return JS_EXCEPTION;
    }

    worker = (CtWorker *) calloc(1, sizeof(CtWorker));
    start = (CtWorkerStart *) calloc(1, sizeof(CtWorkerStart));
    if (worker == NULL || start == NULL) {
        free(worker);
        free(start);
        JS_FreeCString(ctx, script_path);
        return JS_ThrowOutOfMemory(ctx);
    }
    pthread_mutex_init(&worker->mutex, NULL);
    worker->parent_runtime = runtime;
    pthread_mutex_lock(&ct_workers_mutex);
    worker->id = ct_next_worker_id++;
    worker->next = ct_workers;
    ct_workers = worker;
    pthread_mutex_unlock(&ct_workers_mutex);

    start->script_path = ct_duplicate_string(script_path);
    start->worker = worker;
    JS_FreeCString(ctx, script_path);
    if (start->script_path == NULL) {
        pthread_mutex_lock(&worker->mutex);
        worker->terminated = true;
        pthread_mutex_unlock(&worker->mutex);
        free(start);
        return JS_ThrowOutOfMemory(ctx);
    }

    attr_status = pthread_attr_init(&attr);
    if (attr_status != 0) {
        pthread_mutex_lock(&worker->mutex);
        worker->terminated = true;
        pthread_mutex_unlock(&worker->mutex);
        free(start->script_path);
        free(start);
        return JS_ThrowInternalError(ctx, "failed to initialize worker thread attributes");
    }

    attr_status = pthread_attr_setstacksize(&attr, CT_WORKER_STACK_SIZE);
    if (attr_status != 0) {
        pthread_attr_destroy(&attr);
        pthread_mutex_lock(&worker->mutex);
        worker->terminated = true;
        pthread_mutex_unlock(&worker->mutex);
        free(start->script_path);
        free(start);
        return JS_ThrowInternalError(ctx, "failed to set worker thread stack size");
    }

    create_status = pthread_create(&thread, &attr, ct_worker_entry, start);
    pthread_attr_destroy(&attr);

    if (create_status != 0) {
        pthread_mutex_lock(&worker->mutex);
        worker->terminated = true;
        pthread_mutex_unlock(&worker->mutex);
        free(start->script_path);
        free(start);
        return JS_ThrowInternalError(ctx, "failed to create worker thread");
    }
    worker->thread = thread;
    pthread_detach(thread);

    JSValue handle = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, handle, "id", JS_NewUint32(ctx, worker->id));
    return handle;
}

#else

static JSValue ct_memory_address(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_ThrowInternalError(ctx, "Cottontail FFI is not implemented on Windows yet");
}

static JSValue ct_memory_view(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_ThrowInternalError(ctx, "Cottontail FFI is not implemented on Windows yet");
}

static JSValue ct_native_call(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_ThrowInternalError(ctx, "Cottontail FFI is not implemented on Windows yet");
}

static JSValue ct_create_callback(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_ThrowInternalError(ctx, "Cottontail FFI callbacks are not implemented on Windows yet");
}

static JSValue ct_inflate_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_ThrowInternalError(ctx, "Cottontail zlib is not implemented on Windows yet");
}

static JSValue ct_spawn_worker(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_ThrowInternalError(ctx, "Cottontail workers are not implemented on Windows yet");
}

static JSValue ct_is_worker(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_FALSE;
}

static JSValue ct_worker_post_message(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_ThrowInternalError(ctx, "Cottontail workers are not implemented on Windows yet");
}

static JSValue ct_worker_poll_incoming_messages(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_NewArray(ctx);
}

static JSValue ct_worker_post_message_to(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_ThrowInternalError(ctx, "Cottontail workers are not implemented on Windows yet");
}

static JSValue ct_worker_poll_messages(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_NewArray(ctx);
}

static JSValue ct_worker_terminate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void) this_val;
    (void) argc;
    (void) argv;
    return JS_FALSE;
}

#endif

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
        JS_SetPropertyStr(ctx, cottontail, "sleep", JS_NewCFunction(ctx, ct_sleep, "sleep", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "drainJobs", JS_NewCFunction(ctx, ct_drain_jobs_host, "drainJobs", 0)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "cwd", JS_NewCFunction(ctx, ct_cwd, "cwd", 0)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "readFile", JS_NewCFunction(ctx, ct_read_file, "readFile", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "readFileBuffer", JS_NewCFunction(ctx, ct_read_file_buffer, "readFileBuffer", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "writeFile", JS_NewCFunction(ctx, ct_write_file, "writeFile", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "openFd", JS_NewCFunction(ctx, ct_open_fd, "openFd", 3)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "readFd", JS_NewCFunction(ctx, ct_read_fd, "readFd", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "closeFd", JS_NewCFunction(ctx, ct_close_fd, "closeFd", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "fdWrite", JS_NewCFunction(ctx, ct_fd_write, "fdWrite", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "fdWatchStart", JS_NewCFunction(ctx, ct_fd_watch_start, "fdWatchStart", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "fdWatchStop", JS_NewCFunction(ctx, ct_fd_watch_stop, "fdWatchStop", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "fdSetEventHandler", JS_NewCFunction(ctx, ct_fd_set_event_handler, "fdSetEventHandler", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "env", JS_NewCFunction(ctx, ct_env, "env", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "existsSync", JS_NewCFunction(ctx, ct_exists_sync, "existsSync", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "statSync", JS_NewCFunction(ctx, ct_stat_sync, "statSync", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "readDirSync", JS_NewCFunction(ctx, ct_read_dir_sync, "readDirSync", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "mkdirSync", JS_NewCFunction(ctx, ct_mkdir_sync, "mkdirSync", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "rmSync", JS_NewCFunction(ctx, ct_rm_sync, "rmSync", 3)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "unlinkSync", JS_NewCFunction(ctx, ct_unlink_sync, "unlinkSync", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "chmodSync", JS_NewCFunction(ctx, ct_chmod_sync, "chmodSync", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "spawnSync", JS_NewCFunction(ctx, ct_spawn_sync, "spawnSync", 3)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "spawnStart", JS_NewCFunction(ctx, ct_spawn_start, "spawnStart", 3)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "spawnPoll", JS_NewCFunction(ctx, ct_spawn_poll, "spawnPoll", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "spawnWrite", JS_NewCFunction(ctx, ct_spawn_write, "spawnWrite", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "spawnCloseStdin", JS_NewCFunction(ctx, ct_spawn_close_stdin, "spawnCloseStdin", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "spawnKill", JS_NewCFunction(ctx, ct_spawn_kill, "spawnKill", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "spawnDispose", JS_NewCFunction(ctx, ct_spawn_dispose, "spawnDispose", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "spawnSetEventHandler", JS_NewCFunction(ctx, ct_spawn_set_event_handler, "spawnSetEventHandler", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "spawnDetached", JS_NewCFunction(ctx, ct_spawn_detached, "spawnDetached", 3)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "httpServerStart", JS_NewCFunction(ctx, ct_http_server_start, "httpServerStart", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "httpServerPoll", JS_NewCFunction(ctx, ct_http_server_poll, "httpServerPoll", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "httpServerRespond", JS_NewCFunction(ctx, ct_http_server_respond, "httpServerRespond", 5)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "httpServerStop", JS_NewCFunction(ctx, ct_http_server_stop, "httpServerStop", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "memoryAddress", JS_NewCFunction(ctx, ct_memory_address, "memoryAddress", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "memoryView", JS_NewCFunction(ctx, ct_memory_view, "memoryView", 3)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "nativeCall", JS_NewCFunction(ctx, ct_native_call, "nativeCall", 5)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "createCallback", JS_NewCFunction(ctx, ct_create_callback, "createCallback", 4)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "inflateSync", JS_NewCFunction(ctx, ct_inflate_sync, "inflateSync", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "spawnWorker", JS_NewCFunction(ctx, ct_spawn_worker, "spawnWorker", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "isWorker", JS_NewCFunction(ctx, ct_is_worker, "isWorker", 0)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "workerPostMessage", JS_NewCFunction(ctx, ct_worker_post_message, "workerPostMessage", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "workerPollIncomingMessages", JS_NewCFunction(ctx, ct_worker_poll_incoming_messages, "workerPollIncomingMessages", 0)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "workerPostMessageTo", JS_NewCFunction(ctx, ct_worker_post_message_to, "workerPostMessageTo", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "workerPollMessages", JS_NewCFunction(ctx, ct_worker_poll_messages, "workerPollMessages", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "workerSetEventHandler", JS_NewCFunction(ctx, ct_worker_set_event_handler, "workerSetEventHandler", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "workerTerminate", JS_NewCFunction(ctx, ct_worker_terminate, "workerTerminate", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "exit", JS_NewCFunction(ctx, ct_exit, "exit", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "execPath", JS_NewCFunction(ctx, ct_exec_path, "execPath", 0)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "pid", JS_NewCFunction(ctx, ct_pid, "pid", 0)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "kill", JS_NewCFunction(ctx, ct_kill_process, "kill", 2)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "randomBytes", JS_NewCFunction(ctx, ct_random_bytes, "randomBytes", 1)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "platform", JS_NewCFunction(ctx, ct_platform, "platform", 0)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "arch", JS_NewCFunction(ctx, ct_arch, "arch", 0)) < 0 ||
        JS_SetPropertyStr(ctx, cottontail, "hostname", JS_NewCFunction(ctx, ct_hostname, "hostname", 0)) < 0 ||
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
    if (runtime->draining_jobs) {
        return 0;
    }
    runtime->draining_jobs = true;

#if !defined(_WIN32)
    if (ct_drain_process_events(runtime, error_out) != 0) {
        runtime->draining_jobs = false;
        return -1;
    }

    if (ct_drain_fd_events(runtime, error_out) != 0) {
        runtime->draining_jobs = false;
        return -1;
    }

    if (ct_drain_worker_events(runtime, error_out) != 0) {
        runtime->draining_jobs = false;
        return -1;
    }

    if (ct_drain_ffi_callbacks(runtime, error_out) != 0) {
        runtime->draining_jobs = false;
        return -1;
    }
#endif

    while (JS_IsJobPending(runtime->runtime)) {
        JSContext *job_context = NULL;
        int status = JS_ExecutePendingJob(runtime->runtime, &job_context);

        if (status < 0) {
            ct_set_error_out(error_out, ct_copy_exception(job_context != NULL ? job_context : runtime->context));
            runtime->draining_jobs = false;
            return -1;
        }
    }

    if (runtime->pending_unhandled_rejections > 0) {
        if (runtime->last_unhandled_rejection != NULL) {
            ct_set_error_out(error_out, ct_duplicate_string(runtime->last_unhandled_rejection));
        } else {
            ct_set_error_out(error_out, ct_duplicate_string("Unhandled promise rejection"));
        }
        runtime->draining_jobs = false;
        return -1;
    }

    runtime->draining_jobs = false;
    return 0;
}

CtQjsRuntime *ct_qjs_runtime_create(void) {
    return ct_qjs_runtime_create_with_stack_size(CT_JS_STACK_SIZE);
}

CtQjsRuntime *ct_qjs_runtime_create_with_stack_size(size_t stack_size) {
    CtQjsRuntime *runtime = (CtQjsRuntime *) calloc(1, sizeof(CtQjsRuntime));

    if (runtime == NULL) {
        return NULL;
    }

    runtime->host_object = JS_UNDEFINED;
    runtime->process_event_callback = JS_UNDEFINED;
    runtime->fd_event_callback = JS_UNDEFINED;
    runtime->worker_event_callback = JS_UNDEFINED;
    runtime->next_tick_delay_ms = CT_DEFAULT_IDLE_TICK_MS;
#if !defined(_WIN32)
    runtime->owner_thread = pthread_self();
    pthread_mutex_init(&runtime->callback_mutex, NULL);
    pthread_mutex_init(&runtime->process_event_mutex, NULL);
    pthread_mutex_init(&runtime->fd_event_mutex, NULL);
    pthread_mutex_init(&runtime->worker_event_mutex, NULL);
#endif
    runtime->runtime = JS_NewRuntime();
    if (runtime->runtime == NULL) {
        ct_qjs_runtime_destroy(runtime);
        return NULL;
    }
    JS_SetMaxStackSize(runtime->runtime, stack_size == 0 ? CT_JS_STACK_SIZE : stack_size);

    runtime->context = JS_NewContext(runtime->runtime);
    if (runtime->context == NULL) {
        ct_qjs_runtime_destroy(runtime);
        return NULL;
    }
    JS_SetContextOpaque(runtime->context, runtime);

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

    ct_http_stop_all();
    ct_process_stop_all();
#if !defined(_WIN32)
    ct_fd_watchers_wait_for_runtime(runtime);
    ct_process_event_queue_clear(runtime);
    ct_fd_event_queue_clear(runtime);
    ct_worker_event_queue_clear(runtime);
#endif

    ct_free_string(&runtime->last_unhandled_rejection);

    if (runtime->context != NULL) {
        if (!JS_IsUndefined(runtime->process_event_callback)) {
            JS_FreeValue(runtime->context, runtime->process_event_callback);
            runtime->process_event_callback = JS_UNDEFINED;
        }
        if (!JS_IsUndefined(runtime->fd_event_callback)) {
            JS_FreeValue(runtime->context, runtime->fd_event_callback);
            runtime->fd_event_callback = JS_UNDEFINED;
        }
        if (!JS_IsUndefined(runtime->worker_event_callback)) {
            JS_FreeValue(runtime->context, runtime->worker_event_callback);
            runtime->worker_event_callback = JS_UNDEFINED;
        }
        if (!JS_IsUndefined(runtime->host_object)) {
            JS_FreeValue(runtime->context, runtime->host_object);
            runtime->host_object = JS_UNDEFINED;
        }
        JS_FreeContext(runtime->context);
    }

#if !defined(_WIN32)
    pthread_mutex_lock(&runtime->callback_mutex);
    CtFfiCallbackJob *job = runtime->callback_jobs_head;
    runtime->callback_jobs_head = NULL;
    runtime->callback_jobs_tail = NULL;
    pthread_mutex_unlock(&runtime->callback_mutex);
    while (job != NULL) {
        CtFfiCallbackJob *next = job->next;
        if (job->wait_for_result) {
            pthread_mutex_lock(&job->mutex);
            job->completed = true;
            pthread_cond_signal(&job->cond);
            pthread_mutex_unlock(&job->mutex);
        } else {
            free(job);
        }
        job = next;
    }
    pthread_mutex_destroy(&runtime->callback_mutex);
    pthread_mutex_destroy(&runtime->process_event_mutex);
    pthread_mutex_destroy(&runtime->fd_event_mutex);
    pthread_mutex_destroy(&runtime->worker_event_mutex);
#endif

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
    JSValue process_argv = JS_NewArray(runtime->context);
    size_t user_argc = argc > 0 ? argc - 1 : 0;

    if (error_out != NULL) {
        *error_out = NULL;
    }

    if (JS_IsException(args) || JS_IsException(process_argv)) {
        JS_FreeValue(runtime->context, args);
        JS_FreeValue(runtime->context, process_argv);
        ct_set_error_out(error_out, ct_copy_exception(runtime->context));
        return -1;
    }

    if (JS_SetPropertyUint32(runtime->context, process_argv, 0, JS_NewString(runtime->context, "cottontail")) < 0) {
        JS_FreeValue(runtime->context, args);
        JS_FreeValue(runtime->context, process_argv);
        ct_set_error_out(error_out, ct_copy_exception(runtime->context));
        return -1;
    }

    for (size_t i = 0; i < argc; i += 1) {
        if (JS_SetPropertyUint32(runtime->context, process_argv, (uint32_t) i + 1, JS_NewString(runtime->context, argv[i])) < 0) {
            JS_FreeValue(runtime->context, args);
            JS_FreeValue(runtime->context, process_argv);
            ct_set_error_out(error_out, ct_copy_exception(runtime->context));
            return -1;
        }
    }

    for (size_t i = 0; i < user_argc; i += 1) {
        if (JS_SetPropertyUint32(runtime->context, args, (uint32_t) i, JS_NewString(runtime->context, argv[i + 1])) < 0) {
            JS_FreeValue(runtime->context, args);
            JS_FreeValue(runtime->context, process_argv);
            ct_set_error_out(error_out, ct_copy_exception(runtime->context));
            return -1;
        }
    }

    if (JS_SetPropertyStr(runtime->context, runtime->host_object, "args", args) < 0) {
        JS_FreeValue(runtime->context, args);
        JS_FreeValue(runtime->context, process_argv);
        ct_set_error_out(error_out, ct_copy_exception(runtime->context));
        return -1;
    }

    if (JS_SetPropertyStr(runtime->context, runtime->host_object, "argv", process_argv) < 0) {
        JS_FreeValue(runtime->context, process_argv);
        ct_set_error_out(error_out, ct_copy_exception(runtime->context));
        return -1;
    }

    return 0;
}

static int ct_qjs_runtime_has_active_handles(
    CtQjsRuntime *runtime,
    bool *has_active_handles_out,
    char **error_out
) {
    static const char source[] =
        "globalThis.__cottontailHasActiveHandles ? globalThis.__cottontailHasActiveHandles() : false;";
    JSValue result = JS_UNDEFINED;
    int bool_result = 0;

    *has_active_handles_out = false;

#if !defined(_WIN32)
    pthread_mutex_lock(&runtime->fd_event_mutex);
    bool has_fd_events = runtime->fd_events_head != NULL;
    pthread_mutex_unlock(&runtime->fd_event_mutex);
    pthread_mutex_lock(&runtime->worker_event_mutex);
    bool has_worker_events = runtime->worker_events_head != NULL;
    pthread_mutex_unlock(&runtime->worker_event_mutex);
    if (has_fd_events || has_worker_events || ct_fd_watchers_has_runtime(runtime)) {
        *has_active_handles_out = true;
        return 0;
    }
#endif

    result = JS_Eval(
        runtime->context,
        source,
        sizeof(source) - 1,
        "<cottontail-active-handles>",
        JS_EVAL_TYPE_GLOBAL
    );

    if (JS_IsException(result)) {
        JS_FreeValue(runtime->context, result);
        ct_set_error_out(error_out, ct_copy_exception(runtime->context));
        return -1;
    }

    bool_result = JS_ToBool(runtime->context, result);
    JS_FreeValue(runtime->context, result);
    if (bool_result < 0) {
        ct_set_error_out(error_out, ct_copy_exception(runtime->context));
        return -1;
    }

    *has_active_handles_out = bool_result != 0;
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

        while (state == JS_PROMISE_PENDING) {
            if (ct_qjs_runtime_tick(runtime, error_out) != 0) {
                JS_FreeValue(runtime->context, result);
                return -1;
            }
            usleep((useconds_t) runtime->next_tick_delay_ms * 1000u);
            state = JS_PromiseState(runtime->context, result);
        }

        if (state == JS_PROMISE_REJECTED) {
            JSValue promise_result = JS_PromiseResult(runtime->context, result);
            ct_set_error_out(error_out, ct_copy_value_string(runtime->context, promise_result));
            JS_FreeValue(runtime->context, promise_result);
            JS_FreeValue(runtime->context, result);
            return -1;
        }

        JSValue promise_result = JS_PromiseResult(runtime->context, result);
        JS_FreeValue(runtime->context, promise_result);
    }

    while (true) {
        bool has_active_handles = false;
        if (ct_qjs_runtime_has_active_handles(runtime, &has_active_handles, error_out) != 0) {
            JS_FreeValue(runtime->context, result);
            return -1;
        }
        if (!has_active_handles) break;
        if (ct_qjs_runtime_tick(runtime, error_out) != 0) {
            JS_FreeValue(runtime->context, result);
            return -1;
        }
        usleep((useconds_t) runtime->next_tick_delay_ms * 1000u);
    }

    JS_FreeValue(runtime->context, result);
    return 0;
}

int ct_qjs_runtime_tick(CtQjsRuntime *runtime, char **error_out) {
    static const char tick_source[] =
        "globalThis.__cottontailRunLoopTick ? globalThis.__cottontailRunLoopTick() : 16;";
    JSValue result = JS_UNDEFINED;

    if (error_out != NULL) {
        *error_out = NULL;
    }

    result = JS_Eval(
        runtime->context,
        tick_source,
        sizeof(tick_source) - 1,
        "<cottontail-run-loop-tick>",
        JS_EVAL_TYPE_GLOBAL
    );

    if (JS_IsException(result)) {
        JS_FreeValue(runtime->context, result);
        ct_set_error_out(error_out, ct_copy_exception(runtime->context));
        return -1;
    }

    if (!JS_IsUndefined(result) && !JS_IsNull(result)) {
        double next_delay = 0;
        if (JS_ToFloat64(runtime->context, &next_delay, result) < 0) {
            JS_FreeValue(runtime->context, result);
            ct_set_error_out(error_out, ct_copy_exception(runtime->context));
            return -1;
        }
        if (next_delay < 1) {
            runtime->next_tick_delay_ms = 1;
        } else if (next_delay > CT_MAX_IDLE_TICK_MS) {
            runtime->next_tick_delay_ms = CT_MAX_IDLE_TICK_MS;
        } else {
            runtime->next_tick_delay_ms = (uint32_t) next_delay;
        }
    } else {
        runtime->next_tick_delay_ms = CT_DEFAULT_IDLE_TICK_MS;
    }

    JS_FreeValue(runtime->context, result);
    return ct_drain_jobs(runtime, error_out);
}

void ct_qjs_string_free(char *value) {
    free(value);
}
