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
extern bool ct_electrobun_enabled(void);
extern unsigned int ct_electrobun_create_window_host(
    const char *title,
    double x,
    double y,
    double width,
    double height,
    const char *title_bar_style,
    bool transparent,
    bool hidden,
    bool activate,
    double traffic_light_x,
    double traffic_light_y,
    bool quit_on_close,
    char **error_out
);
extern unsigned int ct_electrobun_create_webview_host(
    unsigned int window_id,
    unsigned int host_webview_id,
    const char *renderer,
    const char *url,
    double x,
    double y,
    double width,
    double height,
    bool auto_resize,
    const char *partition,
    const char *secret_key,
    const char *preload,
    const char *views_root,
    bool sandbox,
    bool start_transparent,
    bool start_passthrough,
    char **error_out
);
extern int ct_electrobun_close_window_host(unsigned int window_id, char **error_out);
extern int ct_electrobun_set_window_always_on_top_host(unsigned int window_id, bool flag, char **error_out);
extern bool ct_electrobun_send_host_message_host(unsigned int webview_id, const char *message, char **error_out);
extern char *ct_electrobun_pop_host_message_host(unsigned int *out_webview_id, char **error_out);
extern char *ct_electrobun_pop_event_host(char **error_out);
extern int ct_electrobun_call_u32_host(const char *symbol_name, unsigned int value, char **error_out);
extern int ct_electrobun_call_u32_bool_host(const char *symbol_name, unsigned int value, bool flag, char **error_out);
extern bool ct_electrobun_call_u32_bool_ret_host(const char *symbol_name, unsigned int value, char **error_out);
extern int ct_electrobun_call_u32_string_host(const char *symbol_name, unsigned int value, const char *text, char **error_out);
extern bool ct_electrobun_call_u32_string_bool_ret_host(const char *symbol_name, unsigned int value, const char *text, char **error_out);
extern int ct_electrobun_call_u32_string_bool_bool_host(const char *symbol_name, unsigned int value, const char *text, bool a, bool b, char **error_out);
extern int ct_electrobun_call_u32_f64_f64_host(const char *symbol_name, unsigned int value, double x, double y, char **error_out);
extern int ct_electrobun_call_u32_f64_host(const char *symbol_name, unsigned int value, double number, char **error_out);
extern double ct_electrobun_call_u32_f64_ret_host(const char *symbol_name, unsigned int value, char **error_out);
extern int ct_electrobun_call_u32_f64_f64_f64_f64_host(const char *symbol_name, unsigned int value, double x, double y, double width, double height, char **error_out);
extern char *ct_electrobun_get_window_frame_host(unsigned int window_id, char **error_out);
extern int ct_electrobun_resize_view_host(const char *symbol_name, unsigned int view_id, double x, double y, double width, double height, const char *masks_json, char **error_out);
extern int ct_electrobun_call_bool_host(const char *symbol_name, bool flag, char **error_out);
extern bool ct_electrobun_call_bool_ret_host(const char *symbol_name, char **error_out);
extern int ct_electrobun_call_void_host(const char *symbol_name, char **error_out);
extern int ct_electrobun_call_string_host(const char *symbol_name, const char *value, char **error_out);
extern bool ct_electrobun_call_string_bool_ret_host(const char *symbol_name, const char *value, char **error_out);
extern char *ct_electrobun_call_string_ret_host(const char *symbol_name, char **error_out);
extern char *ct_electrobun_call_string_string_ret_host(const char *symbol_name, const char *a, const char *b, char **error_out);
extern bool ct_electrobun_call_string_string_bool_ret_host(const char *symbol_name, const char *a, const char *b, char **error_out);
extern bool ct_electrobun_call_string_string_string_bool_ret_host(const char *symbol_name, const char *a, const char *b, const char *c, char **error_out);
extern int ct_electrobun_call_string_string_host(const char *symbol_name, const char *a, const char *b, char **error_out);
extern int ct_electrobun_call_int_host(const char *symbol_name, int value, char **error_out);
extern bool ct_electrobun_call_u32_ptr_exists_host(const char *symbol_name, unsigned int value, char **error_out);
extern bool ct_electrobun_native_call_host(const char *library_name, const char *symbol_name, const char *return_type, size_t argc, const uint64_t *args, uint64_t *result_out, char **error_out);
extern unsigned int ct_electrobun_create_wgpu_view_host(unsigned int window_id, double x, double y, double width, double height, bool start_transparent, bool start_passthrough, bool hidden, char **error_out);
extern unsigned int ct_electrobun_create_tray_host(const char *title, const char *image, bool is_template, unsigned int width, unsigned int height, bool handler_enabled, char **error_out);
extern bool ct_electrobun_show_tray_host(unsigned int tray_id, char **error_out);
extern char *ct_electrobun_get_tray_bounds_host(unsigned int tray_id, char **error_out);
extern int ct_electrobun_show_notification_host(const char *title, const char *body, const char *subtitle, bool silent, char **error_out);
extern int ct_electrobun_set_menu_host(const char *symbol_name, const char *menu_json, bool handler_enabled, char **error_out);
extern char *ct_electrobun_open_file_dialog_host(const char *starting_folder, const char *allowed_file_types, int can_choose_files, int can_choose_directories, int allows_multiple_selection, char **error_out);
extern int ct_electrobun_show_message_box_host(const char *box_type, const char *title, const char *message, const char *detail, const char *buttons, int default_id, int cancel_id, char **error_out);
extern int ct_electrobun_set_global_shortcut_callback_host(bool enabled, char **error_out);
extern int ct_electrobun_set_url_open_handler_host(bool enabled, char **error_out);
extern int ct_electrobun_set_app_reopen_handler_host(bool enabled, char **error_out);
extern int ct_electrobun_set_quit_requested_handler_host(bool enabled, char **error_out);
extern int ct_electrobun_quit_host(char **error_out);

struct CtQjsRuntime {
    JSRuntime *runtime;
    JSContext *context;
    JSValue host_object;
    int pending_unhandled_rejections;
    char *last_unhandled_rejection;
};

static JSValue ct_throw_host_error(JSContext *ctx, char *error_message);
static int ct_drain_jobs(CtQjsRuntime *runtime, char **error_out);

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

static int ct_js_value_to_native_u64(JSContext *ctx, JSValueConst value, uint64_t *out) {
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

static JSValue ct_electrobun_memory_address(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint64_t address = 0;

    (void) this_val;

    if (argc < 1 || ct_js_value_to_native_u64(ctx, argv[0], &address) != 0) {
        return JS_ThrowTypeError(ctx, "electrobun.memoryAddress(value) requires an ArrayBuffer, typed array, number, or bigint");
    }

    return JS_NewFloat64(ctx, (double) address);
}

static void ct_external_array_buffer_noop(JSRuntime *rt, void *opaque, void *ptr) {
    (void) rt;
    (void) opaque;
    (void) ptr;
}

static JSValue ct_electrobun_memory_view(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint64_t address = 0;
    uint64_t offset = 0;
    uint64_t length = 0;

    (void) this_val;

    if (argc < 3 ||
        ct_js_value_to_native_u64(ctx, argv[0], &address) != 0 ||
        ct_js_value_to_native_u64(ctx, argv[1], &offset) != 0 ||
        ct_js_value_to_native_u64(ctx, argv[2], &length) != 0) {
        return JS_ThrowTypeError(ctx, "electrobun.memoryView(ptr, offset, length) requires pointer, offset, and length");
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

static JSValue ct_electrobun_native_call(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *library_name = NULL;
    const char *symbol_name = NULL;
    const char *return_type = NULL;
    char *error_message = NULL;
    uint64_t args[8] = {0};
    uint64_t result = 0;
    int native_argc = argc - 3;
    bool ok = false;

    (void) this_val;

    if (argc < 3 || native_argc > 8) {
        return JS_ThrowTypeError(ctx, "electrobun.nativeCall(library, symbol, returnType, ...args) supports up to 8 native args");
    }

    library_name = JS_ToCString(ctx, argv[0]);
    symbol_name = JS_ToCString(ctx, argv[1]);
    return_type = JS_ToCString(ctx, argv[2]);
    if (library_name == NULL || symbol_name == NULL || return_type == NULL) {
        JS_FreeCString(ctx, library_name);
        JS_FreeCString(ctx, symbol_name);
        JS_FreeCString(ctx, return_type);
        return JS_EXCEPTION;
    }

    for (int index = 0; index < native_argc; index += 1) {
        if (ct_js_value_to_native_u64(ctx, argv[index + 3], &args[index]) != 0) {
            JS_FreeCString(ctx, library_name);
            JS_FreeCString(ctx, symbol_name);
            JS_FreeCString(ctx, return_type);
            return JS_ThrowTypeError(ctx, "native call args must be ArrayBuffers, typed arrays, numbers, or bigints");
        }
    }

    ok = ct_electrobun_native_call_host(library_name, symbol_name, return_type, (size_t) native_argc, args, &result, &error_message);
    JS_FreeCString(ctx, library_name);
    JS_FreeCString(ctx, symbol_name);
    JS_FreeCString(ctx, return_type);

    if (!ok) {
        return ct_throw_host_error(ctx, error_message);
    }

    if (strcmp(return_type, "void") == 0) {
        return JS_UNDEFINED;
    }
    if (strcmp(return_type, "u64") == 0) {
        return JS_NewBigUint64(ctx, result);
    }
    return JS_NewFloat64(ctx, (double) result);
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

static JSValue ct_return_owned_cstring(JSContext *ctx, char *value) {
    JSValue result;

    if (value == NULL) {
        return JS_NULL;
    }

    result = JS_NewString(ctx, value);
    ct_host_string_free(value);
    return result;
}

static JSValue ct_status_to_js(JSContext *ctx, int status, char *error_message) {
    if (status != 0 || error_message != NULL) {
        return ct_throw_host_error(ctx, error_message);
    }
    return JS_UNDEFINED;
}

static JSValue ct_electrobun_create_window(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    char *title_copy = NULL;
    char *title_bar_style_copy = NULL;
    const char *title = "Cottontail";
    const char *title_bar_style = "default";
    double x = 100;
    double y = 100;
    double width = 960;
    double height = 640;
    double traffic_light_x = 0;
    double traffic_light_y = 0;
    bool transparent = false;
    bool hidden = false;
    bool activate = true;
    bool quit_on_close = true;
    char *error_message = NULL;
    unsigned int window_id = 0;

    (void) this_val;

    if (argc >= 1) {
        JSValue title_value = JS_UNDEFINED;

        if (!JS_IsUndefined(argv[0]) && !JS_IsNull(argv[0]) && !JS_IsObject(argv[0])) {
            return JS_ThrowTypeError(ctx, "electrobun.createWindow(options) expects an options object");
        }

        title_value = JS_GetPropertyStr(ctx, argv[0], "title");
        if (JS_IsException(title_value)) {
            return JS_EXCEPTION;
        }

        if (!JS_IsUndefined(title_value) && !JS_IsNull(title_value)) {
            title_copy = ct_copy_js_string(ctx, title_value);
            if (title_copy == NULL) {
                JS_FreeValue(ctx, title_value);
                return JS_EXCEPTION;
            }
            title = title_copy;
        }
        JS_FreeValue(ctx, title_value);

        if (ct_get_optional_string_property(ctx, argv[0], "titleBarStyle", &title_bar_style_copy) != 0) {
            free(title_copy);
            return JS_EXCEPTION;
        }
        if (title_bar_style_copy != NULL) {
            title_bar_style = title_bar_style_copy;
        }

        if (ct_get_optional_float64_property(ctx, argv[0], "x", &x) != 0 ||
            ct_get_optional_float64_property(ctx, argv[0], "y", &y) != 0 ||
            ct_get_optional_float64_property(ctx, argv[0], "width", &width) != 0 ||
            ct_get_optional_float64_property(ctx, argv[0], "height", &height) != 0 ||
            ct_get_optional_float64_property(ctx, argv[0], "trafficLightX", &traffic_light_x) != 0 ||
            ct_get_optional_float64_property(ctx, argv[0], "trafficLightY", &traffic_light_y) != 0 ||
            ct_get_optional_bool_property(ctx, argv[0], "transparent", &transparent) != 0 ||
            ct_get_optional_bool_property(ctx, argv[0], "hidden", &hidden) != 0 ||
            ct_get_optional_bool_property(ctx, argv[0], "activate", &activate) != 0 ||
            ct_get_optional_bool_property(ctx, argv[0], "quitOnClose", &quit_on_close) != 0) {
            free(title_copy);
            free(title_bar_style_copy);
            return JS_EXCEPTION;
        }
    }

    window_id = ct_electrobun_create_window_host(
        title,
        x,
        y,
        width,
        height,
        title_bar_style,
        transparent,
        hidden,
        activate,
        traffic_light_x,
        traffic_light_y,
        quit_on_close,
        &error_message
    );
    free(title_copy);
    free(title_bar_style_copy);

    if (window_id == 0) {
        return ct_throw_host_error(ctx, error_message);
    }

    return JS_NewUint32(ctx, window_id);
}

static JSValue ct_electrobun_create_webview(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t window_id = 0;
    uint32_t host_webview_id = 0;
    double x = 0;
    double y = 0;
    double width = 800;
    double height = 600;
    bool auto_resize = true;
    bool sandbox = false;
    bool start_transparent = false;
    bool start_passthrough = false;
    char *renderer = ct_duplicate_string("native");
    char *url = ct_duplicate_string("");
    char *partition = ct_duplicate_string("persist:default");
    char *secret_key = ct_duplicate_string("");
    char *preload = ct_duplicate_string("");
    char *views_root = ct_duplicate_string("");
    char *error_message = NULL;
    unsigned int webview_id = 0;

    (void) this_val;

    if (renderer == NULL || url == NULL || partition == NULL || secret_key == NULL || preload == NULL || views_root == NULL) {
        free(renderer);
        free(url);
        free(partition);
        free(secret_key);
        free(preload);
        free(views_root);
        return JS_ThrowOutOfMemory(ctx);
    }

    if (argc < 1 || JS_IsUndefined(argv[0]) || JS_IsNull(argv[0]) || !JS_IsObject(argv[0])) {
        free(renderer);
        free(url);
        free(partition);
        free(secret_key);
        free(preload);
        free(views_root);
        return JS_ThrowTypeError(ctx, "electrobun.createWebview(options) expects an options object");
    }

    if (ct_get_optional_uint32_property(ctx, argv[0], "windowId", &window_id) != 0 ||
        ct_get_optional_uint32_property(ctx, argv[0], "hostWebviewId", &host_webview_id) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "renderer", &renderer) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "url", &url) != 0 ||
        ct_get_optional_float64_property(ctx, argv[0], "x", &x) != 0 ||
        ct_get_optional_float64_property(ctx, argv[0], "y", &y) != 0 ||
        ct_get_optional_float64_property(ctx, argv[0], "width", &width) != 0 ||
        ct_get_optional_float64_property(ctx, argv[0], "height", &height) != 0 ||
        ct_get_optional_bool_property(ctx, argv[0], "autoResize", &auto_resize) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "partition", &partition) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "secretKey", &secret_key) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "preload", &preload) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "viewsRoot", &views_root) != 0 ||
        ct_get_optional_bool_property(ctx, argv[0], "sandbox", &sandbox) != 0 ||
        ct_get_optional_bool_property(ctx, argv[0], "startTransparent", &start_transparent) != 0 ||
        ct_get_optional_bool_property(ctx, argv[0], "startPassthrough", &start_passthrough) != 0) {
        free(renderer);
        free(url);
        free(partition);
        free(secret_key);
        free(preload);
        free(views_root);
        return JS_EXCEPTION;
    }

    if (window_id == 0) {
        free(renderer);
        free(url);
        free(partition);
        free(secret_key);
        free(preload);
        free(views_root);
        return JS_ThrowTypeError(ctx, "electrobun.createWebview(options) requires windowId");
    }

    webview_id = ct_electrobun_create_webview_host(
        window_id,
        host_webview_id,
        renderer,
        url,
        x,
        y,
        width,
        height,
        auto_resize,
        partition,
        secret_key,
        preload,
        views_root,
        sandbox,
        start_transparent,
        start_passthrough,
        &error_message
    );

    free(renderer);
    free(url);
    free(partition);
    free(secret_key);
    free(preload);
    free(views_root);

    if (webview_id == 0) {
        return ct_throw_host_error(ctx, error_message);
    }

    return JS_NewUint32(ctx, webview_id);
}

static JSValue ct_electrobun_close_window(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t window_id = 0;
    char *error_message = NULL;

    (void) this_val;

    if (argc < 1 || JS_ToUint32(ctx, &window_id, argv[0]) < 0) {
        return JS_ThrowTypeError(ctx, "electrobun.closeWindow(windowId) requires a window id");
    }

    if (ct_electrobun_close_window_host(window_id, &error_message) != 0) {
        return ct_throw_host_error(ctx, error_message);
    }

    return JS_UNDEFINED;
}

static JSValue ct_electrobun_set_window_always_on_top(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t window_id = 0;
    int flag = 0;
    char *error_message = NULL;

    (void) this_val;

    if (argc < 2 || JS_ToUint32(ctx, &window_id, argv[0]) < 0) {
        return JS_ThrowTypeError(ctx, "electrobun.setWindowAlwaysOnTop(windowId, flag) requires a window id and flag");
    }

    flag = JS_ToBool(ctx, argv[1]);
    if (flag < 0) {
        return JS_EXCEPTION;
    }

    if (ct_electrobun_set_window_always_on_top_host(window_id, flag != 0, &error_message) != 0) {
        return ct_throw_host_error(ctx, error_message);
    }

    return JS_UNDEFINED;
}

static JSValue ct_electrobun_send_host_message(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t webview_id = 0;
    char *message = NULL;
    char *error_message = NULL;
    bool ok = false;

    (void) this_val;

    if (argc < 2 || JS_ToUint32(ctx, &webview_id, argv[0]) < 0) {
        return JS_ThrowTypeError(ctx, "electrobun.sendHostMessageToWebview(webviewId, message) requires a webview id and message");
    }

    message = ct_copy_js_string(ctx, argv[1]);
    if (message == NULL) {
        return JS_EXCEPTION;
    }

    ok = ct_electrobun_send_host_message_host(webview_id, message, &error_message);
    free(message);

    if (!ok) {
        return ct_throw_host_error(ctx, error_message);
    }

    return JS_TRUE;
}

static JSValue ct_electrobun_pop_host_message(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    unsigned int webview_id = 0;
    char *message = NULL;
    char *error_message = NULL;
    JSValue result = JS_UNDEFINED;

    (void) this_val;
    (void) argc;
    (void) argv;

    message = ct_electrobun_pop_host_message_host(&webview_id, &error_message);
    if (error_message != NULL) {
        return ct_throw_host_error(ctx, error_message);
    }
    if (message == NULL) {
        return JS_NULL;
    }

    result = JS_NewObject(ctx);
    if (JS_IsException(result)) {
        ct_host_string_free(message);
        return result;
    }

    if (JS_SetPropertyStr(ctx, result, "webviewId", JS_NewUint32(ctx, webview_id)) < 0 ||
        JS_SetPropertyStr(ctx, result, "message", JS_NewString(ctx, message)) < 0) {
        ct_host_string_free(message);
        JS_FreeValue(ctx, result);
        return JS_EXCEPTION;
    }

    ct_host_string_free(message);
    return result;
}

static JSValue ct_electrobun_quit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    char *error_message = NULL;

    (void) this_val;
    (void) argc;
    (void) argv;

    if (ct_electrobun_quit_host(&error_message) != 0) {
        return ct_throw_host_error(ctx, error_message);
    }

    return JS_UNDEFINED;
}

static JSValue ct_electrobun_core_call(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    char *signature = NULL;
    char *symbol = NULL;
    char *error_message = NULL;
    JSValue result = JS_UNDEFINED;

    (void) this_val;

    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "electrobun.coreCall(signature, symbol, ...args) requires a signature and symbol");
    }

    signature = ct_copy_js_string(ctx, argv[0]);
    symbol = ct_copy_js_string(ctx, argv[1]);
    if (signature == NULL || symbol == NULL) {
        result = JS_EXCEPTION;
        goto cleanup;
    }

    if (strcmp(signature, "u32") == 0) {
        uint32_t value = 0;
        if (argc < 3 || JS_ToUint32(ctx, &value, argv[2]) < 0) {
            result = JS_ThrowTypeError(ctx, "coreCall u32 requires one uint32 argument");
            goto cleanup;
        }
        result = ct_status_to_js(ctx, ct_electrobun_call_u32_host(symbol, value, &error_message), error_message);
        goto cleanup;
    }

    if (strcmp(signature, "u32_bool") == 0) {
        uint32_t value = 0;
        int flag = 0;
        if (argc < 4 || JS_ToUint32(ctx, &value, argv[2]) < 0) {
            result = JS_ThrowTypeError(ctx, "coreCall u32_bool requires uint32 and bool arguments");
            goto cleanup;
        }
        flag = JS_ToBool(ctx, argv[3]);
        if (flag < 0) {
            result = JS_EXCEPTION;
            goto cleanup;
        }
        result = ct_status_to_js(ctx, ct_electrobun_call_u32_bool_host(symbol, value, flag != 0, &error_message), error_message);
        goto cleanup;
    }

    if (strcmp(signature, "u32_bool_ret") == 0) {
        uint32_t value = 0;
        bool ok = false;
        if (argc < 3 || JS_ToUint32(ctx, &value, argv[2]) < 0) {
            result = JS_ThrowTypeError(ctx, "coreCall u32_bool_ret requires one uint32 argument");
            goto cleanup;
        }
        ok = ct_electrobun_call_u32_bool_ret_host(symbol, value, &error_message);
        result = error_message != NULL ? ct_throw_host_error(ctx, error_message) : JS_NewBool(ctx, ok);
        goto cleanup;
    }

    if (strcmp(signature, "u32_string") == 0) {
        uint32_t value = 0;
        char *text = NULL;
        if (argc < 4 || JS_ToUint32(ctx, &value, argv[2]) < 0) {
            result = JS_ThrowTypeError(ctx, "coreCall u32_string requires uint32 and string arguments");
            goto cleanup;
        }
        text = ct_copy_js_string(ctx, argv[3]);
        if (text == NULL) {
            result = JS_EXCEPTION;
            goto cleanup;
        }
        result = ct_status_to_js(ctx, ct_electrobun_call_u32_string_host(symbol, value, text, &error_message), error_message);
        free(text);
        goto cleanup;
    }

    if (strcmp(signature, "u32_string_bool_ret") == 0) {
        uint32_t value = 0;
        char *text = NULL;
        bool ok = false;
        if (argc < 4 || JS_ToUint32(ctx, &value, argv[2]) < 0) {
            result = JS_ThrowTypeError(ctx, "coreCall u32_string_bool_ret requires uint32 and string arguments");
            goto cleanup;
        }
        text = ct_copy_js_string(ctx, argv[3]);
        if (text == NULL) {
            result = JS_EXCEPTION;
            goto cleanup;
        }
        ok = ct_electrobun_call_u32_string_bool_ret_host(symbol, value, text, &error_message);
        result = error_message != NULL ? ct_throw_host_error(ctx, error_message) : JS_NewBool(ctx, ok);
        free(text);
        goto cleanup;
    }

    if (strcmp(signature, "u32_string_bool_bool") == 0) {
        uint32_t value = 0;
        char *text = NULL;
        int a = 0;
        int b = 0;
        if (argc < 6 || JS_ToUint32(ctx, &value, argv[2]) < 0) {
            result = JS_ThrowTypeError(ctx, "coreCall u32_string_bool_bool requires uint32, string, bool, bool arguments");
            goto cleanup;
        }
        text = ct_copy_js_string(ctx, argv[3]);
        a = JS_ToBool(ctx, argv[4]);
        b = JS_ToBool(ctx, argv[5]);
        if (text == NULL || a < 0 || b < 0) {
            free(text);
            result = JS_EXCEPTION;
            goto cleanup;
        }
        result = ct_status_to_js(ctx, ct_electrobun_call_u32_string_bool_bool_host(symbol, value, text, a != 0, b != 0, &error_message), error_message);
        free(text);
        goto cleanup;
    }

    if (strcmp(signature, "u32_f64_f64") == 0) {
        uint32_t value = 0;
        double x = 0;
        double y = 0;
        if (argc < 5 || JS_ToUint32(ctx, &value, argv[2]) < 0 || JS_ToFloat64(ctx, &x, argv[3]) < 0 || JS_ToFloat64(ctx, &y, argv[4]) < 0) {
            result = JS_ThrowTypeError(ctx, "coreCall u32_f64_f64 requires uint32, number, number arguments");
            goto cleanup;
        }
        result = ct_status_to_js(ctx, ct_electrobun_call_u32_f64_f64_host(symbol, value, x, y, &error_message), error_message);
        goto cleanup;
    }

    if (strcmp(signature, "u32_f64") == 0) {
        uint32_t value = 0;
        double number = 0;
        if (argc < 4 || JS_ToUint32(ctx, &value, argv[2]) < 0 || JS_ToFloat64(ctx, &number, argv[3]) < 0) {
            result = JS_ThrowTypeError(ctx, "coreCall u32_f64 requires uint32 and number arguments");
            goto cleanup;
        }
        result = ct_status_to_js(ctx, ct_electrobun_call_u32_f64_host(symbol, value, number, &error_message), error_message);
        goto cleanup;
    }

    if (strcmp(signature, "u32_f64_ret") == 0) {
        uint32_t value = 0;
        double number = 0;
        if (argc < 3 || JS_ToUint32(ctx, &value, argv[2]) < 0) {
            result = JS_ThrowTypeError(ctx, "coreCall u32_f64_ret requires one uint32 argument");
            goto cleanup;
        }
        number = ct_electrobun_call_u32_f64_ret_host(symbol, value, &error_message);
        result = error_message != NULL ? ct_throw_host_error(ctx, error_message) : JS_NewFloat64(ctx, number);
        goto cleanup;
    }

    if (strcmp(signature, "u32_f64_f64_f64_f64") == 0) {
        uint32_t value = 0;
        double x = 0;
        double y = 0;
        double width = 0;
        double height = 0;
        if (argc < 7 || JS_ToUint32(ctx, &value, argv[2]) < 0 || JS_ToFloat64(ctx, &x, argv[3]) < 0 || JS_ToFloat64(ctx, &y, argv[4]) < 0 || JS_ToFloat64(ctx, &width, argv[5]) < 0 || JS_ToFloat64(ctx, &height, argv[6]) < 0) {
            result = JS_ThrowTypeError(ctx, "coreCall u32_f64_f64_f64_f64 requires uint32 and four number arguments");
            goto cleanup;
        }
        result = ct_status_to_js(ctx, ct_electrobun_call_u32_f64_f64_f64_f64_host(symbol, value, x, y, width, height, &error_message), error_message);
        goto cleanup;
    }

    if (strcmp(signature, "bool") == 0) {
        int flag = 0;
        if (argc < 3) {
            result = JS_ThrowTypeError(ctx, "coreCall bool requires one bool argument");
            goto cleanup;
        }
        flag = JS_ToBool(ctx, argv[2]);
        if (flag < 0) {
            result = JS_EXCEPTION;
            goto cleanup;
        }
        result = ct_status_to_js(ctx, ct_electrobun_call_bool_host(symbol, flag != 0, &error_message), error_message);
        goto cleanup;
    }

    if (strcmp(signature, "bool_ret") == 0) {
        bool ok = ct_electrobun_call_bool_ret_host(symbol, &error_message);
        result = error_message != NULL ? ct_throw_host_error(ctx, error_message) : JS_NewBool(ctx, ok);
        goto cleanup;
    }

    if (strcmp(signature, "void") == 0) {
        result = ct_status_to_js(ctx, ct_electrobun_call_void_host(symbol, &error_message), error_message);
        goto cleanup;
    }

    if (strcmp(signature, "string") == 0) {
        char *value = NULL;
        if (argc < 3) {
            result = JS_ThrowTypeError(ctx, "coreCall string requires one string argument");
            goto cleanup;
        }
        value = ct_copy_js_string(ctx, argv[2]);
        if (value == NULL) {
            result = JS_EXCEPTION;
            goto cleanup;
        }
        result = ct_status_to_js(ctx, ct_electrobun_call_string_host(symbol, value, &error_message), error_message);
        free(value);
        goto cleanup;
    }

    if (strcmp(signature, "string_bool_ret") == 0) {
        char *value = NULL;
        bool ok = false;
        if (argc < 3) {
            result = JS_ThrowTypeError(ctx, "coreCall string_bool_ret requires one string argument");
            goto cleanup;
        }
        value = ct_copy_js_string(ctx, argv[2]);
        if (value == NULL) {
            result = JS_EXCEPTION;
            goto cleanup;
        }
        ok = ct_electrobun_call_string_bool_ret_host(symbol, value, &error_message);
        result = error_message != NULL ? ct_throw_host_error(ctx, error_message) : JS_NewBool(ctx, ok);
        free(value);
        goto cleanup;
    }

    if (strcmp(signature, "string_ret") == 0) {
        char *value = ct_electrobun_call_string_ret_host(symbol, &error_message);
        result = error_message != NULL ? ct_throw_host_error(ctx, error_message) : ct_return_owned_cstring(ctx, value);
        goto cleanup;
    }

    if (strcmp(signature, "string_string_ret") == 0 || strcmp(signature, "string_string_bool_ret") == 0 || strcmp(signature, "string_string") == 0) {
        char *a = NULL;
        char *b = NULL;
        if (argc < 4) {
            result = JS_ThrowTypeError(ctx, "coreCall string_string* requires two string arguments");
            goto cleanup;
        }
        a = ct_copy_js_string(ctx, argv[2]);
        b = ct_copy_js_string(ctx, argv[3]);
        if (a == NULL || b == NULL) {
            free(a);
            free(b);
            result = JS_EXCEPTION;
            goto cleanup;
        }
        if (strcmp(signature, "string_string_ret") == 0) {
            char *value = ct_electrobun_call_string_string_ret_host(symbol, a, b, &error_message);
            result = error_message != NULL ? ct_throw_host_error(ctx, error_message) : ct_return_owned_cstring(ctx, value);
        } else if (strcmp(signature, "string_string_bool_ret") == 0) {
            bool ok = ct_electrobun_call_string_string_bool_ret_host(symbol, a, b, &error_message);
            result = error_message != NULL ? ct_throw_host_error(ctx, error_message) : JS_NewBool(ctx, ok);
        } else {
            result = ct_status_to_js(ctx, ct_electrobun_call_string_string_host(symbol, a, b, &error_message), error_message);
        }
        free(a);
        free(b);
        goto cleanup;
    }

    if (strcmp(signature, "string_string_string_bool_ret") == 0) {
        char *a = NULL;
        char *b = NULL;
        char *c = NULL;
        bool ok = false;
        if (argc < 5) {
            result = JS_ThrowTypeError(ctx, "coreCall string_string_string_bool_ret requires three string arguments");
            goto cleanup;
        }
        a = ct_copy_js_string(ctx, argv[2]);
        b = ct_copy_js_string(ctx, argv[3]);
        c = ct_copy_js_string(ctx, argv[4]);
        if (a == NULL || b == NULL || c == NULL) {
            free(a);
            free(b);
            free(c);
            result = JS_EXCEPTION;
            goto cleanup;
        }
        ok = ct_electrobun_call_string_string_string_bool_ret_host(symbol, a, b, c, &error_message);
        result = error_message != NULL ? ct_throw_host_error(ctx, error_message) : JS_NewBool(ctx, ok);
        free(a);
        free(b);
        free(c);
        goto cleanup;
    }

    if (strcmp(signature, "int") == 0) {
        int32_t value = 0;
        if (argc < 3 || JS_ToInt32(ctx, &value, argv[2]) < 0) {
            result = JS_ThrowTypeError(ctx, "coreCall int requires one int argument");
            goto cleanup;
        }
        result = ct_status_to_js(ctx, ct_electrobun_call_int_host(symbol, value, &error_message), error_message);
        goto cleanup;
    }

    if (strcmp(signature, "u32_ptr_exists") == 0) {
        uint32_t value = 0;
        bool ok = false;
        if (argc < 3 || JS_ToUint32(ctx, &value, argv[2]) < 0) {
            result = JS_ThrowTypeError(ctx, "coreCall u32_ptr_exists requires one uint32 argument");
            goto cleanup;
        }
        ok = ct_electrobun_call_u32_ptr_exists_host(symbol, value, &error_message);
        result = error_message != NULL ? ct_throw_host_error(ctx, error_message) : JS_NewBool(ctx, ok);
        goto cleanup;
    }

    result = JS_ThrowTypeError(ctx, "unsupported electrobun.coreCall signature: %s", signature);

cleanup:
    free(signature);
    free(symbol);
    return result;
}

static JSValue ct_electrobun_get_window_frame(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t window_id = 0;
    char *error_message = NULL;
    char *frame_json = NULL;

    (void) this_val;

    if (argc < 1 || JS_ToUint32(ctx, &window_id, argv[0]) < 0) {
        return JS_ThrowTypeError(ctx, "electrobun.getWindowFrame(windowId) requires a window id");
    }

    frame_json = ct_electrobun_get_window_frame_host(window_id, &error_message);
    if (error_message != NULL) {
        return ct_throw_host_error(ctx, error_message);
    }
    return ct_return_owned_cstring(ctx, frame_json);
}

static JSValue ct_electrobun_resize_view(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    char *symbol = NULL;
    char *masks_json = NULL;
    uint32_t view_id = 0;
    double x = 0;
    double y = 0;
    double width = 0;
    double height = 0;
    char *error_message = NULL;
    JSValue result = JS_UNDEFINED;

    (void) this_val;

    if (argc < 7) {
        return JS_ThrowTypeError(ctx, "electrobun.resizeView(symbol, id, x, y, width, height, masksJSON) requires seven arguments");
    }

    symbol = ct_copy_js_string(ctx, argv[0]);
    masks_json = ct_copy_js_string(ctx, argv[6]);
    if (symbol == NULL || masks_json == NULL ||
        JS_ToUint32(ctx, &view_id, argv[1]) < 0 ||
        JS_ToFloat64(ctx, &x, argv[2]) < 0 ||
        JS_ToFloat64(ctx, &y, argv[3]) < 0 ||
        JS_ToFloat64(ctx, &width, argv[4]) < 0 ||
        JS_ToFloat64(ctx, &height, argv[5]) < 0) {
        free(symbol);
        free(masks_json);
        return JS_EXCEPTION;
    }

    result = ct_status_to_js(ctx, ct_electrobun_resize_view_host(symbol, view_id, x, y, width, height, masks_json, &error_message), error_message);
    free(symbol);
    free(masks_json);
    return result;
}

static JSValue ct_electrobun_create_wgpu_view(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t window_id = 0;
    double x = 0;
    double y = 0;
    double width = 320;
    double height = 240;
    bool start_transparent = false;
    bool start_passthrough = false;
    bool hidden = false;
    char *error_message = NULL;
    unsigned int view_id = 0;

    (void) this_val;

    if (argc < 1 || JS_IsUndefined(argv[0]) || JS_IsNull(argv[0]) || !JS_IsObject(argv[0])) {
        return JS_ThrowTypeError(ctx, "electrobun.createWGPUView(options) expects an options object");
    }

    if (ct_get_optional_uint32_property(ctx, argv[0], "windowId", &window_id) != 0 ||
        ct_get_optional_float64_property(ctx, argv[0], "x", &x) != 0 ||
        ct_get_optional_float64_property(ctx, argv[0], "y", &y) != 0 ||
        ct_get_optional_float64_property(ctx, argv[0], "width", &width) != 0 ||
        ct_get_optional_float64_property(ctx, argv[0], "height", &height) != 0 ||
        ct_get_optional_bool_property(ctx, argv[0], "startTransparent", &start_transparent) != 0 ||
        ct_get_optional_bool_property(ctx, argv[0], "startPassthrough", &start_passthrough) != 0 ||
        ct_get_optional_bool_property(ctx, argv[0], "hidden", &hidden) != 0) {
        return JS_EXCEPTION;
    }

    if (window_id == 0) {
        return JS_ThrowTypeError(ctx, "electrobun.createWGPUView(options) requires windowId");
    }

    view_id = ct_electrobun_create_wgpu_view_host(window_id, x, y, width, height, start_transparent, start_passthrough, hidden, &error_message);
    if (view_id == 0) {
        return ct_throw_host_error(ctx, error_message);
    }

    return JS_NewUint32(ctx, view_id);
}

static JSValue ct_electrobun_create_tray(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    char *title = ct_duplicate_string("");
    char *image = ct_duplicate_string("");
    bool is_template = false;
    bool handler_enabled = false;
    uint32_t width = 18;
    uint32_t height = 18;
    char *error_message = NULL;
    unsigned int tray_id = 0;

    (void) this_val;

    if (title == NULL || image == NULL) {
        free(title);
        free(image);
        return JS_ThrowOutOfMemory(ctx);
    }

    if (argc < 1 || JS_IsUndefined(argv[0]) || JS_IsNull(argv[0]) || !JS_IsObject(argv[0])) {
        free(title);
        free(image);
        return JS_ThrowTypeError(ctx, "electrobun.createTray(options) expects an options object");
    }

    if (ct_get_optional_string_property(ctx, argv[0], "title", &title) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "image", &image) != 0 ||
        ct_get_optional_bool_property(ctx, argv[0], "isTemplate", &is_template) != 0 ||
        ct_get_optional_bool_property(ctx, argv[0], "handler", &handler_enabled) != 0 ||
        ct_get_optional_uint32_property(ctx, argv[0], "width", &width) != 0 ||
        ct_get_optional_uint32_property(ctx, argv[0], "height", &height) != 0) {
        free(title);
        free(image);
        return JS_EXCEPTION;
    }

    tray_id = ct_electrobun_create_tray_host(title, image, is_template, width, height, handler_enabled, &error_message);
    free(title);
    free(image);
    if (tray_id == 0) {
        return ct_throw_host_error(ctx, error_message);
    }

    return JS_NewUint32(ctx, tray_id);
}

static JSValue ct_electrobun_show_tray(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t tray_id = 0;
    char *error_message = NULL;
    bool ok = false;

    (void) this_val;

    if (argc < 1 || JS_ToUint32(ctx, &tray_id, argv[0]) < 0) {
        return JS_ThrowTypeError(ctx, "electrobun.showTray(trayId) requires a tray id");
    }

    ok = ct_electrobun_show_tray_host(tray_id, &error_message);
    if (!ok || error_message != NULL) {
        return ct_throw_host_error(ctx, error_message);
    }
    return JS_TRUE;
}

static JSValue ct_electrobun_get_tray_bounds(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t tray_id = 0;
    char *error_message = NULL;
    char *bounds_json = NULL;

    (void) this_val;

    if (argc < 1 || JS_ToUint32(ctx, &tray_id, argv[0]) < 0) {
        return JS_ThrowTypeError(ctx, "electrobun.getTrayBounds(trayId) requires a tray id");
    }

    bounds_json = ct_electrobun_get_tray_bounds_host(tray_id, &error_message);
    if (error_message != NULL) {
        return ct_throw_host_error(ctx, error_message);
    }
    return ct_return_owned_cstring(ctx, bounds_json);
}

static JSValue ct_electrobun_show_notification(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    char *title = ct_duplicate_string("");
    char *body = ct_duplicate_string("");
    char *subtitle = ct_duplicate_string("");
    bool silent = false;
    char *error_message = NULL;
    JSValue result = JS_UNDEFINED;

    (void) this_val;

    if (title == NULL || body == NULL || subtitle == NULL) {
        free(title);
        free(body);
        free(subtitle);
        return JS_ThrowOutOfMemory(ctx);
    }

    if (argc < 1 || JS_IsUndefined(argv[0]) || JS_IsNull(argv[0]) || !JS_IsObject(argv[0])) {
        free(title);
        free(body);
        free(subtitle);
        return JS_ThrowTypeError(ctx, "electrobun.showNotification(options) expects an options object");
    }

    if (ct_get_optional_string_property(ctx, argv[0], "title", &title) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "body", &body) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "subtitle", &subtitle) != 0 ||
        ct_get_optional_bool_property(ctx, argv[0], "silent", &silent) != 0) {
        free(title);
        free(body);
        free(subtitle);
        return JS_EXCEPTION;
    }

    result = ct_status_to_js(ctx, ct_electrobun_show_notification_host(title, body, subtitle, silent, &error_message), error_message);
    free(title);
    free(body);
    free(subtitle);
    return result;
}

static JSValue ct_electrobun_set_menu(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    char *symbol = NULL;
    char *menu_json = NULL;
    int handler = 0;
    char *error_message = NULL;
    JSValue result = JS_UNDEFINED;

    (void) this_val;

    if (argc < 3) {
        return JS_ThrowTypeError(ctx, "electrobun.setMenu(symbol, menuJSON, handler) requires three arguments");
    }

    symbol = ct_copy_js_string(ctx, argv[0]);
    menu_json = ct_copy_js_string(ctx, argv[1]);
    handler = JS_ToBool(ctx, argv[2]);
    if (symbol == NULL || menu_json == NULL || handler < 0) {
        free(symbol);
        free(menu_json);
        return JS_EXCEPTION;
    }

    result = ct_status_to_js(ctx, ct_electrobun_set_menu_host(symbol, menu_json, handler != 0, &error_message), error_message);
    free(symbol);
    free(menu_json);
    return result;
}

static JSValue ct_electrobun_open_file_dialog(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    char *starting_folder = ct_duplicate_string("");
    char *allowed_file_types = ct_duplicate_string("");
    bool can_choose_files = true;
    bool can_choose_directories = false;
    bool allows_multiple_selection = false;
    char *error_message = NULL;
    char *value = NULL;

    (void) this_val;

    if (starting_folder == NULL || allowed_file_types == NULL) {
        free(starting_folder);
        free(allowed_file_types);
        return JS_ThrowOutOfMemory(ctx);
    }

    if (argc < 1 || JS_IsUndefined(argv[0]) || JS_IsNull(argv[0]) || !JS_IsObject(argv[0])) {
        free(starting_folder);
        free(allowed_file_types);
        return JS_ThrowTypeError(ctx, "electrobun.openFileDialog(options) expects an options object");
    }

    if (ct_get_optional_string_property(ctx, argv[0], "startingFolder", &starting_folder) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "allowedFileTypes", &allowed_file_types) != 0 ||
        ct_get_optional_bool_property(ctx, argv[0], "canChooseFiles", &can_choose_files) != 0 ||
        ct_get_optional_bool_property(ctx, argv[0], "canChooseDirectory", &can_choose_directories) != 0 ||
        ct_get_optional_bool_property(ctx, argv[0], "allowsMultipleSelection", &allows_multiple_selection) != 0) {
        free(starting_folder);
        free(allowed_file_types);
        return JS_EXCEPTION;
    }

    value = ct_electrobun_open_file_dialog_host(
        starting_folder,
        allowed_file_types,
        can_choose_files ? 1 : 0,
        can_choose_directories ? 1 : 0,
        allows_multiple_selection ? 1 : 0,
        &error_message
    );
    free(starting_folder);
    free(allowed_file_types);
    if (error_message != NULL) {
        return ct_throw_host_error(ctx, error_message);
    }
    return ct_return_owned_cstring(ctx, value);
}

static JSValue ct_electrobun_show_message_box(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    char *box_type = ct_duplicate_string("info");
    char *title = ct_duplicate_string("");
    char *message = ct_duplicate_string("");
    char *detail = ct_duplicate_string("");
    char *buttons = ct_duplicate_string("OK");
    int32_t default_id = 0;
    int32_t cancel_id = -1;
    char *error_message = NULL;
    int response = 0;

    (void) this_val;

    if (box_type == NULL || title == NULL || message == NULL || detail == NULL || buttons == NULL) {
        free(box_type);
        free(title);
        free(message);
        free(detail);
        free(buttons);
        return JS_ThrowOutOfMemory(ctx);
    }

    if (argc < 1 || JS_IsUndefined(argv[0]) || JS_IsNull(argv[0]) || !JS_IsObject(argv[0])) {
        free(box_type);
        free(title);
        free(message);
        free(detail);
        free(buttons);
        return JS_ThrowTypeError(ctx, "electrobun.showMessageBox(options) expects an options object");
    }

    if (ct_get_optional_string_property(ctx, argv[0], "boxType", &box_type) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "title", &title) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "message", &message) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "detail", &detail) != 0 ||
        ct_get_optional_string_property(ctx, argv[0], "buttons", &buttons) != 0) {
        free(box_type);
        free(title);
        free(message);
        free(detail);
        free(buttons);
        return JS_EXCEPTION;
    }

    if (ct_get_optional_uint32_property(ctx, argv[0], "defaultID", (uint32_t *) &default_id) != 0 ||
        ct_get_optional_uint32_property(ctx, argv[0], "cancelID", (uint32_t *) &cancel_id) != 0) {
        free(box_type);
        free(title);
        free(message);
        free(detail);
        free(buttons);
        return JS_EXCEPTION;
    }

    response = ct_electrobun_show_message_box_host(box_type, title, message, detail, buttons, default_id, cancel_id, &error_message);
    free(box_type);
    free(title);
    free(message);
    free(detail);
    free(buttons);
    if (error_message != NULL) {
        return ct_throw_host_error(ctx, error_message);
    }
    return JS_NewInt32(ctx, response);
}

static JSValue ct_electrobun_set_native_callback(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    char *name = NULL;
    int enabled = 0;
    char *error_message = NULL;
    int status = -1;

    (void) this_val;

    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "electrobun.setNativeCallback(name, enabled) requires a name and enabled flag");
    }

    name = ct_copy_js_string(ctx, argv[0]);
    enabled = JS_ToBool(ctx, argv[1]);
    if (name == NULL || enabled < 0) {
        free(name);
        return JS_EXCEPTION;
    }

    if (strcmp(name, "globalShortcut") == 0) {
        status = ct_electrobun_set_global_shortcut_callback_host(enabled != 0, &error_message);
    } else if (strcmp(name, "urlOpen") == 0) {
        status = ct_electrobun_set_url_open_handler_host(enabled != 0, &error_message);
    } else if (strcmp(name, "appReopen") == 0) {
        status = ct_electrobun_set_app_reopen_handler_host(enabled != 0, &error_message);
    } else if (strcmp(name, "quitRequested") == 0) {
        status = ct_electrobun_set_quit_requested_handler_host(enabled != 0, &error_message);
    } else {
        JSValue exception = JS_ThrowTypeError(ctx, "unknown native callback: %s", name);
        free(name);
        return exception;
    }

    free(name);
    return ct_status_to_js(ctx, status, error_message);
}

static JSValue ct_electrobun_pop_event(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    char *error_message = NULL;
    char *event_json = NULL;

    (void) this_val;
    (void) argc;
    (void) argv;

    event_json = ct_electrobun_pop_event_host(&error_message);
    if (error_message != NULL) {
        return ct_throw_host_error(ctx, error_message);
    }
    return ct_return_owned_cstring(ctx, event_json);
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
    JSValue electrobun = JS_UNDEFINED;

    if (JS_IsException(console)) {
        JS_FreeValue(ctx, global);
        return -1;
    }

    if (JS_IsException(cottontail)) {
        JS_FreeValue(ctx, console);
        JS_FreeValue(ctx, global);
        return -1;
    }

    if (ct_electrobun_enabled()) {
        electrobun = JS_NewObject(ctx);
        if (JS_IsException(electrobun)) {
            JS_FreeValue(ctx, cottontail);
            JS_FreeValue(ctx, console);
            JS_FreeValue(ctx, global);
            return -1;
        }
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
        JS_FreeValue(ctx, electrobun);
        JS_FreeValue(ctx, cottontail);
        JS_FreeValue(ctx, global);
        return -1;
    }

    if (!JS_IsUndefined(electrobun) &&
        (JS_SetPropertyStr(ctx, electrobun, "createWindow", JS_NewCFunction(ctx, ct_electrobun_create_window, "createWindow", 1)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "createWebview", JS_NewCFunction(ctx, ct_electrobun_create_webview, "createWebview", 1)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "closeWindow", JS_NewCFunction(ctx, ct_electrobun_close_window, "closeWindow", 1)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "setWindowAlwaysOnTop", JS_NewCFunction(ctx, ct_electrobun_set_window_always_on_top, "setWindowAlwaysOnTop", 2)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "sendHostMessageToWebview", JS_NewCFunction(ctx, ct_electrobun_send_host_message, "sendHostMessageToWebview", 2)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "popNextQueuedHostMessage", JS_NewCFunction(ctx, ct_electrobun_pop_host_message, "popNextQueuedHostMessage", 0)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "popNextNativeEvent", JS_NewCFunction(ctx, ct_electrobun_pop_event, "popNextNativeEvent", 0)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "coreCall", JS_NewCFunction(ctx, ct_electrobun_core_call, "coreCall", 2)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "nativeCall", JS_NewCFunction(ctx, ct_electrobun_native_call, "nativeCall", 3)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "memoryAddress", JS_NewCFunction(ctx, ct_electrobun_memory_address, "memoryAddress", 1)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "memoryView", JS_NewCFunction(ctx, ct_electrobun_memory_view, "memoryView", 3)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "getWindowFrame", JS_NewCFunction(ctx, ct_electrobun_get_window_frame, "getWindowFrame", 1)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "resizeView", JS_NewCFunction(ctx, ct_electrobun_resize_view, "resizeView", 7)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "createWGPUView", JS_NewCFunction(ctx, ct_electrobun_create_wgpu_view, "createWGPUView", 1)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "createTray", JS_NewCFunction(ctx, ct_electrobun_create_tray, "createTray", 1)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "showTray", JS_NewCFunction(ctx, ct_electrobun_show_tray, "showTray", 1)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "getTrayBounds", JS_NewCFunction(ctx, ct_electrobun_get_tray_bounds, "getTrayBounds", 1)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "showNotification", JS_NewCFunction(ctx, ct_electrobun_show_notification, "showNotification", 1)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "setMenu", JS_NewCFunction(ctx, ct_electrobun_set_menu, "setMenu", 3)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "openFileDialog", JS_NewCFunction(ctx, ct_electrobun_open_file_dialog, "openFileDialog", 1)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "showMessageBox", JS_NewCFunction(ctx, ct_electrobun_show_message_box, "showMessageBox", 1)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "setNativeCallback", JS_NewCFunction(ctx, ct_electrobun_set_native_callback, "setNativeCallback", 2)) < 0 ||
         JS_SetPropertyStr(ctx, electrobun, "quit", JS_NewCFunction(ctx, ct_electrobun_quit, "quit", 0)) < 0)) {
        JS_FreeValue(ctx, electrobun);
        JS_FreeValue(ctx, cottontail);
        JS_FreeValue(ctx, global);
        return -1;
    }

    runtime->host_object = JS_DupValue(ctx, cottontail);

    if (JS_SetPropertyStr(ctx, global, "cottontail", cottontail) < 0) {
        JS_FreeValue(ctx, runtime->host_object);
        runtime->host_object = JS_UNDEFINED;
        JS_FreeValue(ctx, electrobun);
        JS_FreeValue(ctx, cottontail);
        JS_FreeValue(ctx, global);
        return -1;
    }

    if (!JS_IsUndefined(electrobun) && JS_SetPropertyStr(ctx, global, "electrobun", electrobun) < 0) {
        JS_FreeValue(ctx, runtime->host_object);
        runtime->host_object = JS_UNDEFINED;
        JS_FreeValue(ctx, electrobun);
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
    JS_SetMaxStackSize(runtime->runtime, 0);

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
