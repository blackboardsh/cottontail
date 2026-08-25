#include "../native_capability.h"
#include "../capability_host.h"
#if __has_include(<ffi/ffi.h>)
#include <ffi/ffi.h>
#else
#include <ffi.h>
#endif
#include <inttypes.h>
#if defined(_WIN32)
#include <windows.h>
typedef SRWLOCK pthread_mutex_t;
typedef CONDITION_VARIABLE pthread_cond_t;
typedef DWORD pthread_t;
#define PTHREAD_MUTEX_INITIALIZER SRWLOCK_INIT
static int pthread_mutex_init(pthread_mutex_t *mutex, const void *attributes) { (void)attributes; InitializeSRWLock(mutex); return 0; }
static int pthread_mutex_destroy(pthread_mutex_t *mutex) { (void)mutex; return 0; }
static int pthread_mutex_lock(pthread_mutex_t *mutex) { AcquireSRWLockExclusive(mutex); return 0; }
static int pthread_mutex_unlock(pthread_mutex_t *mutex) { ReleaseSRWLockExclusive(mutex); return 0; }
static int pthread_cond_init(pthread_cond_t *condition, const void *attributes) { (void)attributes; InitializeConditionVariable(condition); return 0; }
static int pthread_cond_destroy(pthread_cond_t *condition) { (void)condition; return 0; }
static int pthread_cond_wait(pthread_cond_t *condition, pthread_mutex_t *mutex) { return SleepConditionVariableSRW(condition, mutex, INFINITE, 0) ? 0 : -1; }
static int pthread_cond_signal(pthread_cond_t *condition) { WakeConditionVariable(condition); return 0; }
static pthread_t pthread_self(void) { return GetCurrentThreadId(); }
static int pthread_equal(pthread_t lhs, pthread_t rhs) { return lhs == rhs; }
#else
#include <pthread.h>
#endif
#include <stdio.h>
#define CT_FFI_MAX_ARGS 64
typedef enum { CT_FFI_TYPE_VOID, CT_FFI_TYPE_BOOL, CT_FFI_TYPE_U8, CT_FFI_TYPE_I8, CT_FFI_TYPE_U16, CT_FFI_TYPE_I16, CT_FFI_TYPE_U32, CT_FFI_TYPE_I32, CT_FFI_TYPE_U64, CT_FFI_TYPE_I64, CT_FFI_TYPE_F32, CT_FFI_TYPE_F64, CT_FFI_TYPE_PTR, CT_FFI_TYPE_CSTRING, CT_FFI_TYPE_FUNCTION, CT_FFI_TYPE_NAPI_ENV, CT_FFI_TYPE_NAPI_VALUE } CtFfiType;
typedef union { uint8_t u8; int8_t i8; uint16_t u16; int16_t i16; uint32_t u32; int32_t i32; uint64_t u64; int64_t i64; float f32; double f64; void *ptr; } CtFfiValue;
typedef struct CtFfiCapabilityState CtFfiCapabilityState;
typedef struct CtFfiCallback CtFfiCallback;
typedef struct CtFfiCallbackJob { CtFfiCallback *callback; size_t argc; CtFfiValue args[CT_FFI_MAX_ARGS]; CtFfiValue result; bool completed; bool wait_for_result; struct CtFfiCallbackJob *next; pthread_mutex_t mutex; pthread_cond_t cond; } CtFfiCallbackJob;
struct CtFfiCallback { CtFfiCapabilityState *state; JSContextRef ctx; JSObjectRef function; CtFfiType returns; CtFfiType arg_types[CT_FFI_MAX_ARGS]; ffi_type *ffi_arg_types[CT_FFI_MAX_ARGS]; size_t argc; bool threadsafe; pthread_t owner_thread; ffi_cif cif; ffi_closure *closure; void *code; bool closed; struct CtFfiCallback *next; };
typedef enum { CT_PREPARED_FFI_FAST_PATH_NONE, CT_PREPARED_FFI_FAST_PATH_I32_TO_I32 } CtPreparedFfiFastPath;
typedef struct CtPreparedFfiCall { void *function_pointer; CtFfiType returns; CtFfiType arg_types[CT_FFI_MAX_ARGS]; uint8_t return_type_id; uint8_t arg_type_ids[CT_FFI_MAX_ARGS]; ffi_type *ffi_arg_types[CT_FFI_MAX_ARGS]; size_t argc; ffi_cif cif; void *napi_env; CtFfiCapabilityState *state; JSObjectRef callback_constructor; JSObjectRef cstring_constructor; CtPreparedFfiFastPath fast_path; } CtPreparedFfiCall;
struct CtFfiCapabilityState { JSContextRef context; CtCapabilityHost host; pthread_mutex_t callback_mutex; CtFfiCallbackJob *callback_jobs_head; CtFfiCallbackJob *callback_jobs_tail; CtFfiCallback *callbacks; };
static pthread_mutex_t ct_prepared_ffi_class_mutex = PTHREAD_MUTEX_INITIALIZER;
static JSClassRef ct_prepared_ffi_class = NULL;
static char *ct_duplicate_string(const char *value) { if (value == NULL) return NULL; size_t length = strlen(value); char *copy = (char *)malloc(length + 1); if (copy != NULL) memcpy(copy, value, length + 1); return copy; }
static char *ct_copy_exception(JSContextRef context, JSValueRef value) { return ct_value_to_string_copy(context, value); }
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
        case CT_FFI_TYPE_NAPI_ENV:
        case CT_FFI_TYPE_NAPI_VALUE:
            return &ffi_type_pointer;
    }

    return &ffi_type_pointer;
}

static bool ct_ffi_type_from_name(const char *name, CtFfiType *out) {
    if (strcmp(name, "void") == 0) *out = CT_FFI_TYPE_VOID;
    else if (strcmp(name, "bool") == 0) *out = CT_FFI_TYPE_BOOL;
    else if (strcmp(name, "u8") == 0 || strcmp(name, "uint8_t") == 0) *out = CT_FFI_TYPE_U8;
    else if (strcmp(name, "i8") == 0 || strcmp(name, "int8_t") == 0) *out = CT_FFI_TYPE_I8;
    else if (strcmp(name, "u16") == 0 || strcmp(name, "uint16_t") == 0) *out = CT_FFI_TYPE_U16;
    else if (strcmp(name, "i16") == 0 || strcmp(name, "int16_t") == 0) *out = CT_FFI_TYPE_I16;
    else if (strcmp(name, "int") == 0) *out = CT_FFI_TYPE_I32;
    else if (strcmp(name, "u32") == 0 || strcmp(name, "uint32_t") == 0) *out = CT_FFI_TYPE_U32;
    else if (strcmp(name, "i32") == 0 || strcmp(name, "int32_t") == 0) *out = CT_FFI_TYPE_I32;
    else if (strcmp(name, "u64") == 0 || strcmp(name, "uint64_t") == 0 || strcmp(name, "usize") == 0 || strcmp(name, "size_t") == 0) *out = CT_FFI_TYPE_U64;
    else if (strcmp(name, "i64") == 0 || strcmp(name, "int64_t") == 0 || strcmp(name, "isize") == 0 || strcmp(name, "ssize_t") == 0) *out = CT_FFI_TYPE_I64;
    else if (strcmp(name, "f32") == 0) *out = CT_FFI_TYPE_F32;
    else if (strcmp(name, "f64") == 0) *out = CT_FFI_TYPE_F64;
    else if (strcmp(name, "ptr") == 0 || strcmp(name, "pointer") == 0) *out = CT_FFI_TYPE_PTR;
    else if (strcmp(name, "cstring") == 0) *out = CT_FFI_TYPE_CSTRING;
    else if (strcmp(name, "function") == 0 || strcmp(name, "callback") == 0) *out = CT_FFI_TYPE_FUNCTION;
    else if (strcmp(name, "napi_env") == 0) *out = CT_FFI_TYPE_NAPI_ENV;
    else if (strcmp(name, "napi_value") == 0) *out = CT_FFI_TYPE_NAPI_VALUE;
    else return false;
    return true;
}

static bool ct_ffi_type_from_id(uint8_t id, CtFfiType *out) {
    switch (id) {
        case 0:
        case 1:
            *out = CT_FFI_TYPE_I8;
            return true;
        case 2:
            *out = CT_FFI_TYPE_U8;
            return true;
        case 3:
            *out = CT_FFI_TYPE_I16;
            return true;
        case 4:
            *out = CT_FFI_TYPE_U16;
            return true;
        case 5:
            *out = CT_FFI_TYPE_I32;
            return true;
        case 6:
            *out = CT_FFI_TYPE_U32;
            return true;
        case 7:
        case 15:
            *out = CT_FFI_TYPE_I64;
            return true;
        case 8:
        case 16:
            *out = CT_FFI_TYPE_U64;
            return true;
        case 9:
            *out = CT_FFI_TYPE_F64;
            return true;
        case 10:
            *out = CT_FFI_TYPE_F32;
            return true;
        case 11:
            *out = CT_FFI_TYPE_BOOL;
            return true;
        case 12:
        case 20:
            *out = CT_FFI_TYPE_PTR;
            return true;
        case 13:
            *out = CT_FFI_TYPE_VOID;
            return true;
        case 14:
            *out = CT_FFI_TYPE_CSTRING;
            return true;
        case 17:
            *out = CT_FFI_TYPE_FUNCTION;
            return true;
        case 18:
            *out = CT_FFI_TYPE_NAPI_ENV;
            return true;
        case 19:
            *out = CT_FFI_TYPE_NAPI_VALUE;
            return true;
        default:
            return false;
    }
}

static int ct_parse_ffi_type_id(
    JSContextRef ctx,
    JSValueRef value,
    uint8_t *id_out,
    CtFfiType *type_out,
    JSValueRef *exception
) {
    JSValueRef local_exception = NULL;
    double number = JSValueToNumber(ctx, value, &local_exception);
    if (local_exception != NULL) {
        if (exception != NULL) *exception = local_exception;
        return -1;
    }
    if (!isfinite(number) || number < 0 || number > 20 || trunc(number) != number) {
        ct_throw_type_error(ctx, exception, "Unsupported FFI type id");
        return -1;
    }

    uint8_t id = (uint8_t)number;
    if (!ct_ffi_type_from_id(id, type_out)) {
        ct_throw_type_error(ctx, exception, "Unsupported FFI type id");
        return -1;
    }
    *id_out = id;
    return 0;
}

static int ct_parse_ffi_type_id_array(
    JSContextRef ctx,
    JSValueRef value,
    uint8_t *out_ids,
    CtFfiType *out_types,
    ffi_type **out_ffi_types,
    size_t *out_count,
    JSValueRef *exception
) {
    *out_count = 0;
    if (value == NULL || !JSValueIsObject(ctx, value)) {
        ct_throw_type_error(ctx, exception, "FFI args must be an array of type ids");
        return -1;
    }

    JSObjectRef object = (JSObjectRef)value;
    JSValueRef length_value = ct_get_property(ctx, object, "length", exception);
    if (exception != NULL && *exception != NULL) return -1;
    double length_number = JSValueToNumber(ctx, length_value, exception);
    if (exception != NULL && *exception != NULL) return -1;
    if (!isfinite(length_number) || length_number < 0 || trunc(length_number) != length_number ||
        length_number > CT_FFI_MAX_ARGS) {
        ct_throw_type_error(ctx, exception, "Cottontail FFI currently supports up to 64 arguments");
        return -1;
    }

    size_t length = (size_t)length_number;
    for (size_t index = 0; index < length; index += 1) {
        JSValueRef item = JSObjectGetPropertyAtIndex(ctx, object, (unsigned)index, exception);
        if (exception != NULL && *exception != NULL) return -1;
        if (ct_parse_ffi_type_id(ctx, item, &out_ids[index], &out_types[index], exception) != 0) return -1;
        out_ffi_types[index] = ct_ffi_libffi_type(out_types[index]);
    }

    *out_count = length;
    return 0;
}

static int ct_parse_ffi_type(JSContextRef ctx, JSValueRef value, CtFfiType *out, JSValueRef *exception) {
    char *name = ct_value_to_string_copy(ctx, value);
    bool ok = false;
    if (name == NULL) {
        ct_throw_message(ctx, exception, "unsupported FFI type");
        return -1;
    }

    ok = ct_ffi_type_from_name(name, out);
    free(name);
    if (!ok) {
        ct_throw_message(ctx, exception, "unsupported FFI type");
        return -1;
    }
    return 0;
}

static int ct_parse_ffi_type_array(
    JSContextRef ctx,
    JSValueRef value,
    CtFfiType *out_types,
    ffi_type **out_ffi_types,
    size_t *out_count,
    JSValueRef *exception
) {
    *out_count = 0;
    if (value == NULL || !JSValueIsObject(ctx, value)) {
        ct_throw_message(ctx, exception, "FFI args must be an array of type names");
        return -1;
    }

    JSObjectRef object = (JSObjectRef)value;
    JSValueRef length_value = ct_get_property(ctx, object, "length", exception);
    if (exception != NULL && *exception != NULL) return -1;
    size_t length = (size_t)ct_value_to_number(ctx, length_value);
    if (length > CT_FFI_MAX_ARGS) {
        ct_throw_message(ctx, exception, "Cottontail FFI currently supports up to 64 arguments");
        return -1;
    }

    for (size_t index = 0; index < length; index += 1) {
        JSValueRef item = JSObjectGetPropertyAtIndex(ctx, object, (unsigned)index, exception);
        if (exception != NULL && *exception != NULL) return -1;
        if (ct_parse_ffi_type(ctx, item, &out_types[index], exception) != 0) return -1;
        out_ffi_types[index] = ct_ffi_libffi_type(out_types[index]);
    }

    *out_count = length;
    return 0;
}

static int ct_value_to_u64(JSContextRef ctx, JSValueRef value, uint64_t *out) {
    *out = 0;
    if (value == NULL || JSValueIsUndefined(ctx, value) || JSValueIsNull(ctx, value)) return 0;

    uint8_t *bytes = NULL;
    size_t bytes_len = 0;
    if (ct_get_bytes(ctx, value, &bytes, &bytes_len) == 0) {
        *out = (uint64_t)(uintptr_t)bytes;
        return 0;
    }

    JSValueRef exception = NULL;
    double number = JSValueToNumber(ctx, value, &exception);
    if (exception == NULL) {
        if (!isfinite(number) || number < 0) return -1;
        *out = (uint64_t)number;
        return 0;
    }

    JSStringRef string = JSValueToStringCopy(ctx, value, NULL);
    if (string == NULL) return -1;
    size_t max = JSStringGetMaximumUTF8CStringSize(string);
    char *buffer = (char *)malloc(max);
    if (buffer == NULL) {
        JSStringRelease(string);
        return -1;
    }
    JSStringGetUTF8CString(string, buffer, max);
    JSStringRelease(string);
    char *end = NULL;
    *out = strtoull(buffer, &end, 10);
    bool ok = end != buffer;
    free(buffer);
    return ok ? 0 : -1;
}

static JSValueRef ct_memory_address(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    uint64_t address = 0;
    (void)function;
    (void)thisObject;
    if (argc < 1 || ct_value_to_u64(ctx, argv[0], &address) != 0) {
        ct_throw_message(ctx, exception, "cottontail.memoryAddress(value) requires an ArrayBuffer, typed array, number, or bigint");
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeNumber(ctx, (double)address);
}

static void ct_external_array_buffer_noop(void *bytes, void *deallocator_context) {
    (void)bytes;
    (void)deallocator_context;
}

static JSValueRef ct_make_empty_array_buffer(JSContextRef ctx, JSValueRef *exception) {
    JSValueRef constructor_exception = NULL;
    JSValueRef constructor_value = ct_get_property(ctx, JSContextGetGlobalObject(ctx), "ArrayBuffer", &constructor_exception);
    if (constructor_exception == NULL && constructor_value != NULL && JSValueIsObject(ctx, constructor_value)) {
        JSValueRef argument = JSValueMakeNumber(ctx, 0);
        JSObjectRef buffer = JSObjectCallAsConstructor(ctx, (JSObjectRef)constructor_value, 1, &argument, &constructor_exception);
        if (constructor_exception == NULL && buffer != NULL) return buffer;
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, NULL, 0, ct_external_array_buffer_noop, NULL, exception);
}

static JSValueRef ct_memory_view(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    uint64_t address = 0;
    uint64_t offset = 0;
    uint64_t length = 0;
    (void)function;
    (void)thisObject;
    if (argc < 3 ||
        ct_value_to_u64(ctx, argv[0], &address) != 0 ||
        ct_value_to_u64(ctx, argv[1], &offset) != 0 ||
        ct_value_to_u64(ctx, argv[2], &length) != 0) {
        ct_throw_message(ctx, exception, "cottontail.memoryView(ptr, offset, length) requires pointer, offset, and length");
        return JSValueMakeUndefined(ctx);
    }
    if (address == 0 || length == 0) return ct_make_empty_array_buffer(ctx, exception);
    return JSObjectMakeArrayBufferWithBytesNoCopy(
        ctx,
        (uint8_t *)(uintptr_t)(address + offset),
        (size_t)length,
        ct_external_array_buffer_noop,
        NULL,
        exception
    );
}

static int ct_ffi_value_from_js(JSContextRef ctx, JSValueRef value, CtFfiType type, CtFfiValue *out, JSValueRef *exception) {
    uint64_t native_value = 0;
    double number_value = 0;

    memset(out, 0, sizeof(*out));

    switch (type) {
        case CT_FFI_TYPE_VOID:
            return 0;
        case CT_FFI_TYPE_BOOL:
            out->u8 = JSValueToBoolean(ctx, value) ? 1 : 0;
            return 0;
        case CT_FFI_TYPE_F32:
            number_value = ct_value_to_number(ctx, value);
            out->f32 = (float)number_value;
            return 0;
        case CT_FFI_TYPE_F64:
            number_value = ct_value_to_number(ctx, value);
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
        case CT_FFI_TYPE_NAPI_ENV:
        case CT_FFI_TYPE_NAPI_VALUE:
            if (ct_value_to_u64(ctx, value, &native_value) != 0) {
                ct_throw_message(ctx, exception, "FFI argument must be a number, bigint, ArrayBuffer, typed array, null, or undefined");
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
        case CT_FFI_TYPE_NAPI_ENV:
        case CT_FFI_TYPE_NAPI_VALUE:
            value->ptr = (void *)(uintptr_t)value->u64;
            return &value->ptr;
        case CT_FFI_TYPE_VOID:
            return NULL;
    }

    return NULL;
}

static JSValueRef ct_ffi_value_to_js(JSContextRef ctx, CtFfiType type, CtFfiValue value, JSValueRef *exception) {
    switch (type) {
        case CT_FFI_TYPE_VOID:
            return JSValueMakeUndefined(ctx);
        case CT_FFI_TYPE_BOOL:
            return JSValueMakeBoolean(ctx, value.u8 != 0);
        case CT_FFI_TYPE_U8:
            return JSValueMakeNumber(ctx, value.u8);
        case CT_FFI_TYPE_I8:
            return JSValueMakeNumber(ctx, value.i8);
        case CT_FFI_TYPE_U16:
            return JSValueMakeNumber(ctx, value.u16);
        case CT_FFI_TYPE_I16:
            return JSValueMakeNumber(ctx, value.i16);
        case CT_FFI_TYPE_U32:
            return JSValueMakeNumber(ctx, value.u32);
        case CT_FFI_TYPE_I32:
            return JSValueMakeNumber(ctx, value.i32);
        case CT_FFI_TYPE_U64:
            return JSBigIntCreateWithUInt64(ctx, value.u64, exception);
        case CT_FFI_TYPE_I64:
            return JSBigIntCreateWithInt64(ctx, value.i64, exception);
        case CT_FFI_TYPE_F32:
            return JSValueMakeNumber(ctx, value.f32);
        case CT_FFI_TYPE_F64:
            return JSValueMakeNumber(ctx, value.f64);
        case CT_FFI_TYPE_PTR:
        case CT_FFI_TYPE_CSTRING:
        case CT_FFI_TYPE_FUNCTION:
            return JSValueMakeNumber(ctx, (double)(uintptr_t)value.ptr);
        case CT_FFI_TYPE_NAPI_ENV:
            return JSValueMakeNumber(ctx, (double)(uintptr_t)value.ptr);
        case CT_FFI_TYPE_NAPI_VALUE:
            return value.ptr != NULL ? (JSValueRef)value.ptr : JSValueMakeNull(ctx);
    }

    return JSValueMakeUndefined(ctx);
}

static int ct_ffi_result_from_js(JSContextRef ctx, JSValueRef value, CtFfiType type, CtFfiValue *out, JSValueRef *exception) {
    return ct_ffi_value_from_js(ctx, value, type, out, exception);
}

static int ct_call_js_callback(CtFfiCallback *callback, CtFfiValue *args, size_t argc, CtFfiValue *result) {
    JSContextRef ctx = callback->ctx;
    JSValueRef js_args[CT_FFI_MAX_ARGS];
    JSValueRef exception = NULL;

    for (size_t index = 0; index < argc; index += 1) {
        js_args[index] = ct_ffi_value_to_js(ctx, callback->arg_types[index], args[index], &exception);
        if (exception != NULL) {
            char *message = ct_copy_exception(ctx, exception);
            fprintf(stderr, "Cottontail FFI callback argument conversion failed: %s\n", message != NULL ? message : "unknown error");
            free(message);
            return -1;
        }
    }

    JSValueRef js_result = JSObjectCallAsFunction(ctx, callback->function, NULL, argc, js_args, &exception);
    if (exception != NULL) {
        char *message = ct_copy_exception(ctx, exception);
        fprintf(stderr, "Cottontail FFI callback failed: %s\n", message != NULL ? message : "unknown error");
        free(message);
        return -1;
    }

    if (callback->returns != CT_FFI_TYPE_VOID) {
        return ct_ffi_result_from_js(ctx, js_result, callback->returns, result, &exception);
    }

    return 0;
}

static void ct_write_ffi_return(void *ret, CtFfiType type, CtFfiValue value) {
    if (ret == NULL) return;

    switch (type) {
        case CT_FFI_TYPE_VOID:
            return;
        case CT_FFI_TYPE_BOOL:
        case CT_FFI_TYPE_U8:
            *((uint8_t *)ret) = value.u8;
            return;
        case CT_FFI_TYPE_I8:
            *((int8_t *)ret) = value.i8;
            return;
        case CT_FFI_TYPE_U16:
            *((uint16_t *)ret) = value.u16;
            return;
        case CT_FFI_TYPE_I16:
            *((int16_t *)ret) = value.i16;
            return;
        case CT_FFI_TYPE_U32:
            *((uint32_t *)ret) = value.u32;
            return;
        case CT_FFI_TYPE_I32:
            *((int32_t *)ret) = value.i32;
            return;
        case CT_FFI_TYPE_U64:
            *((uint64_t *)ret) = value.u64;
            return;
        case CT_FFI_TYPE_I64:
            *((int64_t *)ret) = value.i64;
            return;
        case CT_FFI_TYPE_F32:
            *((float *)ret) = value.f32;
            return;
        case CT_FFI_TYPE_F64:
            *((double *)ret) = value.f64;
            return;
        case CT_FFI_TYPE_PTR:
        case CT_FFI_TYPE_CSTRING:
        case CT_FFI_TYPE_FUNCTION:
        case CT_FFI_TYPE_NAPI_ENV:
        case CT_FFI_TYPE_NAPI_VALUE:
            *((void **)ret) = (void *)(uintptr_t)value.u64;
            return;
    }
}

static void ct_enqueue_callback_job(CtFfiCapabilityState *state, CtFfiCallbackJob *job) {
    pthread_mutex_lock(&state->callback_mutex);
    if (state->callback_jobs_tail != NULL) {
        state->callback_jobs_tail->next = job;
    } else {
        state->callback_jobs_head = job;
    }
    state->callback_jobs_tail = job;
    pthread_mutex_unlock(&state->callback_mutex);
    state->host.wake(state->host.runtime);
}

static bool ct_runtime_has_live_callbacks(CtFfiCapabilityState *state) {
    bool has_live_callback = false;
    pthread_mutex_lock(&state->callback_mutex);
    for (CtFfiCallback *callback = state->callbacks; callback != NULL; callback = callback->next) {
        if (!callback->closed) {
            has_live_callback = true;
            break;
        }
    }
    pthread_mutex_unlock(&state->callback_mutex);
    return has_live_callback;
}

static void ct_ffi_callback_dispatch(ffi_cif *cif, void *ret, void **args, void *userdata) {
    CtFfiCallback *callback = (CtFfiCallback *)userdata;
    CtFfiValue values[CT_FFI_MAX_ARGS];
    CtFfiValue result;
    bool same_thread = false;
    bool wait_for_result = false;
    (void)cif;

    memset(&result, 0, sizeof(result));
    memset(values, 0, sizeof(values));

    if (callback == NULL || callback->closed) {
        ct_write_ffi_return(ret, callback != NULL ? callback->returns : CT_FFI_TYPE_VOID, result);
        return;
    }

    for (size_t index = 0; index < callback->argc; index += 1) {
        switch (callback->arg_types[index]) {
            case CT_FFI_TYPE_BOOL:
            case CT_FFI_TYPE_U8:
                values[index].u8 = *((uint8_t *)args[index]);
                break;
            case CT_FFI_TYPE_I8:
                values[index].i8 = *((int8_t *)args[index]);
                break;
            case CT_FFI_TYPE_U16:
                values[index].u16 = *((uint16_t *)args[index]);
                break;
            case CT_FFI_TYPE_I16:
                values[index].i16 = *((int16_t *)args[index]);
                break;
            case CT_FFI_TYPE_U32:
                values[index].u32 = *((uint32_t *)args[index]);
                break;
            case CT_FFI_TYPE_I32:
                values[index].i32 = *((int32_t *)args[index]);
                break;
            case CT_FFI_TYPE_U64:
                values[index].u64 = *((uint64_t *)args[index]);
                break;
            case CT_FFI_TYPE_I64:
                values[index].i64 = *((int64_t *)args[index]);
                break;
            case CT_FFI_TYPE_F32:
                values[index].f32 = *((float *)args[index]);
                break;
            case CT_FFI_TYPE_F64:
                values[index].f64 = *((double *)args[index]);
                break;
            case CT_FFI_TYPE_PTR:
            case CT_FFI_TYPE_CSTRING:
            case CT_FFI_TYPE_FUNCTION:
            case CT_FFI_TYPE_NAPI_ENV:
            case CT_FFI_TYPE_NAPI_VALUE:
                values[index].u64 = (uint64_t)(uintptr_t)*((void **)args[index]);
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

    CtFfiCallbackJob *job = (CtFfiCallbackJob *)calloc(1, sizeof(CtFfiCallbackJob));
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

    ct_enqueue_callback_job(callback->state, job);

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

static int ct_drain_ffi_callbacks(CtFfiCapabilityState *state, char **error_out) {
    (void)error_out;

    while (true) {
        pthread_mutex_lock(&state->callback_mutex);
        CtFfiCallbackJob *job = state->callback_jobs_head;
        if (job != NULL) {
            state->callback_jobs_head = job->next;
            if (state->callback_jobs_head == NULL) {
                state->callback_jobs_tail = NULL;
            }
        }
        pthread_mutex_unlock(&state->callback_mutex);

        if (job == NULL) break;

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


typedef struct CtFfiLibrary {
    char *path;
    CtDynamicLibrary library;
    struct CtFfiLibrary *next;
} CtFfiLibrary;

static CtFfiLibrary *ct_ffi_libraries = NULL;

static CtFfiLibrary *ct_ffi_library(const char *path) {
    for (CtFfiLibrary *entry = ct_ffi_libraries; entry != NULL; entry = entry->next) {
        if (strcmp(entry->path, path) == 0) return entry;
    }
    CtFfiLibrary *entry = (CtFfiLibrary *)calloc(1, sizeof(*entry));
    if (entry == NULL) return NULL;
    entry->path = (char *)malloc(strlen(path) + 1);
    if (entry->path == NULL) {
        free(entry);
        return NULL;
    }
    strcpy(entry->path, path);
    if (ct_dynamic_library_open(&entry->library, path, NULL) != 0) {
        free(entry->path);
        free(entry);
        return NULL;
    }
    entry->next = ct_ffi_libraries;
    ct_ffi_libraries = entry;
    return entry;
}

static JSValueRef ct_ffi_native_symbol(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.nativeSymbol(library, symbol) requires library and symbol names");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    char *name = ct_value_to_string_copy(ctx, argv[1]);
    if (path == NULL || name == NULL) {
        free(path);
        free(name);
        ct_throw_message(ctx, exception, "cottontail.nativeSymbol requires string library and symbol names");
        return JSValueMakeUndefined(ctx);
    }
    CtFfiLibrary *library = ct_ffi_library(path);
    if (library == NULL) {
        char message[1024];
        snprintf(message, sizeof(message), "uv_dlopen(%s) failed: unable to open library", path);
        free(path);
        free(name);
        ct_throw_message(ctx, exception, message);
        return JSValueMakeUndefined(ctx);
    }
    void *symbol = NULL;
    if (ct_dynamic_library_symbol(&library->library, name, &symbol, NULL) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "uv_dlsym(%s) failed: symbol not found", name);
        free(path);
        free(name);
        ct_throw_message(ctx, exception, message);
        return JSValueMakeUndefined(ctx);
    }
    free(path);
    free(name);
    return JSValueMakeNumber(ctx, (double)(uintptr_t)symbol);
}


static JSValueRef ct_native_call_pointer(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    CtFfiCapabilityState *state = (CtFfiCapabilityState *)JSObjectGetPrivate(function);
    uint64_t pointer = 0;
    CtFfiType return_type = CT_FFI_TYPE_VOID;
    CtFfiType arg_types[CT_FFI_MAX_ARGS];
    ffi_type *ffi_arg_types[CT_FFI_MAX_ARGS];
    CtFfiValue arg_values[CT_FFI_MAX_ARGS];
    void *arg_value_ptrs[CT_FFI_MAX_ARGS];
    CtFfiValue result;
    ffi_cif cif;
    size_t arg_count = 0;
    (void)thisObject;

    memset(&result, 0, sizeof(result));

    if (argc < 4 || ct_value_to_u64(ctx, argv[0], &pointer) != 0 || pointer == 0) {
        ct_throw_message(ctx, exception, "cottontail.nativeCallPointer(pointer, returnType, argTypes, args) requires a function pointer");
        return JSValueMakeUndefined(ctx);
    }

    if (ct_parse_ffi_type(ctx, argv[1], &return_type, exception) != 0 ||
        ct_parse_ffi_type_array(ctx, argv[2], arg_types, ffi_arg_types, &arg_count, exception) != 0) {
        return JSValueMakeUndefined(ctx);
    }

    if (!JSValueIsObject(ctx, argv[3])) {
        ct_throw_message(ctx, exception, "cottontail.nativeCallPointer args must be an array");
        return JSValueMakeUndefined(ctx);
    }

    bool uses_napi = return_type == CT_FFI_TYPE_NAPI_ENV || return_type == CT_FFI_TYPE_NAPI_VALUE;
    for (size_t index = 0; index < arg_count; index += 1) {
        if (arg_types[index] == CT_FFI_TYPE_NAPI_ENV || arg_types[index] == CT_FFI_TYPE_NAPI_VALUE) {
            uses_napi = true;
            break;
        }
    }
    void *ffi_napi_env = uses_napi
        ? state->host.napi_env_for_library(state->host.runtime, "pointer")
        : NULL;
    if (uses_napi && ffi_napi_env == NULL) {
        ct_throw_message(ctx, exception, "failed to initialize the FFI Node-API environment");
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef args_array = (JSObjectRef)argv[3];
    for (size_t index = 0; index < arg_count; index += 1) {
        JSValueRef item = JSObjectGetPropertyAtIndex(ctx, args_array, (unsigned)index, exception);
        if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
        if (arg_types[index] == CT_FFI_TYPE_NAPI_ENV) {
            arg_values[index].u64 = (uint64_t)(uintptr_t)ffi_napi_env;
            arg_value_ptrs[index] = ct_ffi_value_ptr(&arg_values[index], arg_types[index]);
            continue;
        }
        if (arg_types[index] == CT_FFI_TYPE_NAPI_VALUE) {
            arg_values[index].u64 = (uint64_t)(uintptr_t)item;
            arg_value_ptrs[index] = ct_ffi_value_ptr(&arg_values[index], arg_types[index]);
            continue;
        }
        if (ct_ffi_value_from_js(ctx, item, arg_types[index], &arg_values[index], exception) != 0) {
            return JSValueMakeUndefined(ctx);
        }
        arg_value_ptrs[index] = ct_ffi_value_ptr(&arg_values[index], arg_types[index]);
    }

    if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, (unsigned int)arg_count, ct_ffi_libffi_type(return_type), ffi_arg_types) != FFI_OK) {
        ct_throw_message(ctx, exception, "ffi_prep_cif failed for function pointer");
        return JSValueMakeUndefined(ctx);
    }

    ffi_call(&cif, FFI_FN((void *)(uintptr_t)pointer), ct_ffi_value_ptr(&result, return_type), arg_value_ptrs);
    if (uses_napi) {
        JSValueRef napi_exception = state->host.napi_take_exception(ffi_napi_env);
        if (napi_exception != NULL) {
            *exception = napi_exception;
            return JSValueMakeUndefined(ctx);
        }
    }
    return ct_ffi_value_to_js(ctx, return_type, result, exception);
}

static uint32_t ct_ffi_to_uint32(double number) {
    if (!isfinite(number) || number == 0) return 0;
    double wrapped = fmod(trunc(number), 4294967296.0);
    if (wrapped < 0) wrapped += 4294967296.0;
    return (uint32_t)wrapped;
}

static int ct_ffi_number_from_js(
    JSContextRef ctx,
    JSValueRef value,
    double *out,
    JSValueRef *exception
) {
    if (JSValueIsBigInt(ctx, value)) {
        char *text = ct_value_to_string_copy(ctx, value);
        if (text == NULL) {
            ct_throw_type_error(ctx, exception, "Unable to convert FFI argument to a number");
            return -1;
        }
        *out = strtod(text, NULL);
        free(text);
        return 0;
    }

    JSValueRef local_exception = NULL;
    *out = JSValueToNumber(ctx, value, &local_exception);
    if (local_exception != NULL) {
        if (exception != NULL) *exception = local_exception;
        return -1;
    }
    return 0;
}

static uint64_t ct_ffi_decimal_word(const char *text) {
    if (text == NULL) return 0;
    bool negative = false;
    if (*text == '-' || *text == '+') {
        negative = *text == '-';
        text += 1;
    }

    uint64_t value = 0;
    while (*text >= '0' && *text <= '9') {
        value = value * 10u + (uint64_t)(*text - '0');
        text += 1;
    }
    return negative ? (uint64_t)(0u - value) : value;
}

static uint64_t ct_ffi_word_from_number(double number) {
    if (!isfinite(number)) return 0;

    char number_text[512];
    snprintf(number_text, sizeof(number_text), "%.0f", trunc(number));
    return ct_ffi_decimal_word(number_text);
}

static uint64_t ct_ffi_word_from_js(JSContextRef ctx, JSValueRef value) {
    char *text = NULL;
    uint64_t result = 0;

    if (JSValueIsBigInt(ctx, value)) {
        text = ct_value_to_string_copy(ctx, value);
        result = ct_ffi_decimal_word(text);
        free(text);
        return result;
    }

    JSValueRef local_exception = NULL;
    double number = JSValueToNumber(ctx, value, &local_exception);
    if (local_exception != NULL || !isfinite(number)) return 0;
    return ct_ffi_word_from_number(number);
}

static int ct_prepared_ffi_pointer_from_js(
    JSContextRef ctx,
    JSValueRef value,
    const CtPreparedFfiCall *call,
    size_t argument_index,
    uint64_t *out,
    JSValueRef *exception
) {
    uint8_t type_id = call->arg_type_ids[argument_index];
    bool function_pointer = type_id == 17;
    bool typed_array_only = type_id == 20;
    *out = 0;

    if (value == NULL || JSValueIsUndefined(ctx, value) || JSValueIsNull(ctx, value)) return 0;

    if (JSValueIsObject(ctx, value)) {
        JSValueRef local_exception = NULL;
        JSTypedArrayType array_type = JSValueGetTypedArrayType(ctx, value, &local_exception);
        if (local_exception != NULL) {
            if (exception != NULL) *exception = local_exception;
            return -1;
        }
        if (array_type != kJSTypedArrayTypeNone) {
            if (typed_array_only && array_type == kJSTypedArrayTypeArrayBuffer) {
                ct_throw_type_error(ctx, exception, "Expected a TypedArray");
                return -1;
            }

            uint8_t *bytes = NULL;
            size_t byte_len = 0;
            if (ct_get_bytes(ctx, value, &bytes, &byte_len) != 0) {
                ct_throw_type_error(ctx, exception, "Unable to convert buffer to a pointer");
                return -1;
            }
            if (array_type == kJSTypedArrayTypeArrayBuffer && byte_len == 0) {
                ct_throw_type_error(ctx, exception, "ArrayBufferView must have a length > 0. A pointer to empty memory doesn't work");
                return -1;
            }
            *out = (uint64_t)(uintptr_t)bytes;
            return 0;
        }

        if (typed_array_only) {
            ct_throw_type_error(ctx, exception, "Expected a TypedArray");
            return -1;
        }

        bool pointer_wrapper = function_pointer;
        if (!pointer_wrapper && call->callback_constructor != NULL) {
            pointer_wrapper = JSValueIsInstanceOfConstructor(
                ctx,
                value,
                call->callback_constructor,
                exception
            );
            if (exception != NULL && *exception != NULL) return -1;
        }
        if (!pointer_wrapper && call->cstring_constructor != NULL) {
            pointer_wrapper = JSValueIsInstanceOfConstructor(
                ctx,
                value,
                call->cstring_constructor,
                exception
            );
            if (exception != NULL && *exception != NULL) return -1;
        }
        if (pointer_wrapper) {
            JSValueRef pointer_value = ct_get_property(ctx, (JSObjectRef)value, "ptr", exception);
            if (exception != NULL && *exception != NULL) return -1;
            if (JSValueIsBigInt(ctx, pointer_value)) {
                if (!function_pointer) {
                    ct_throw_type_error(ctx, exception, "Unable to convert BigInt to a pointer");
                    return -1;
                }
                double pointer = 0;
                if (ct_ffi_number_from_js(ctx, pointer_value, &pointer, exception) != 0) return -1;
                if (!isfinite(pointer) || pointer < 0) {
                    ct_throw_type_error(ctx, exception, "Expected function to be a JSCallback or a number");
                    return -1;
                }
                *out = (uint64_t)pointer;
                return 0;
            }
            if (JSValueIsNumber(ctx, pointer_value)) {
                double pointer = JSValueToNumber(ctx, pointer_value, NULL);
                if (!isfinite(pointer) || pointer < 0) {
                    ct_throw_type_error(
                        ctx,
                        exception,
                        function_pointer
                            ? "Expected function to be a JSCallback or a number"
                            : "Unable to convert value to a pointer"
                    );
                    return -1;
                }
                *out = (uint64_t)pointer;
                return 0;
            }

            ct_throw_type_error(
                ctx,
                exception,
                function_pointer
                    ? "Expected function to be a JSCallback or a number"
                    : "Unable to convert value to a pointer"
            );
            return -1;
        }

        ct_throw_type_error(
            ctx,
            exception,
            function_pointer
                ? "Expected function to be a JSCallback or a number"
                : "Unable to convert value to a pointer"
        );
        return -1;
    }

    if (typed_array_only) {
        ct_throw_type_error(ctx, exception, "Expected a TypedArray");
        return -1;
    }
    if (JSValueIsString(ctx, value)) {
        ct_throw_type_error(ctx, exception, "To convert a string to a pointer, encode it as a buffer");
        return -1;
    }
    if (JSValueIsBigInt(ctx, value)) {
        if (!function_pointer) {
            ct_throw_type_error(ctx, exception, "Unable to convert BigInt to a pointer");
            return -1;
        }
        double pointer = 0;
        if (ct_ffi_number_from_js(ctx, value, &pointer, exception) != 0) return -1;
        if (!isfinite(pointer) || pointer < 0) {
            ct_throw_type_error(ctx, exception, "Expected function to be a JSCallback or a number");
            return -1;
        }
        *out = (uint64_t)pointer;
        return 0;
    }

    if (JSValueIsNumber(ctx, value)) {
        double pointer = JSValueToNumber(ctx, value, NULL);
        if (!isfinite(pointer) || pointer < 0) {
            ct_throw_type_error(
                ctx,
                exception,
                function_pointer
                    ? "Expected function to be a JSCallback or a number"
                    : "Unable to convert value to a pointer"
            );
            return -1;
        }
        *out = (uint64_t)pointer;
        return 0;
    }

    ct_throw_type_error(
        ctx,
        exception,
        function_pointer
            ? "Expected function to be a JSCallback or a number"
            : "Unable to convert value to a pointer"
    );
    return -1;
}

static int ct_prepared_ffi_argument_from_js(
    JSContextRef ctx,
    JSValueRef value,
    const CtPreparedFfiCall *call,
    size_t argument_index,
    CtFfiValue *out,
    JSValueRef *exception
) {
    uint8_t type_id = call->arg_type_ids[argument_index];
    double number = 0;
    uint32_t int32_bits = 0;
    uint64_t pointer = 0;
    memset(out, 0, sizeof(*out));

    switch (type_id) {
        case 0:
        case 1:
            if (ct_ffi_number_from_js(ctx, value, &number, exception) != 0) return -1;
            int32_bits = ct_ffi_to_uint32(number);
            out->i8 = (int8_t)(uint8_t)int32_bits;
            return 0;
        case 2:
            if (ct_ffi_number_from_js(ctx, value, &number, exception) != 0) return -1;
            if (isnan(number) || number <= 0) out->u8 = 0;
            else if (number >= UINT8_MAX) out->u8 = UINT8_MAX;
            else out->u8 = (uint8_t)ct_ffi_to_uint32(number);
            return 0;
        case 3:
            if (ct_ffi_number_from_js(ctx, value, &number, exception) != 0) return -1;
            if (isnan(number)) number = 0;
            if (number <= INT16_MIN) out->i16 = INT16_MIN;
            else if (number >= 32768.0) out->i16 = INT16_MIN;
            else out->i16 = (int16_t)(uint16_t)ct_ffi_to_uint32(number);
            return 0;
        case 4:
            if (ct_ffi_number_from_js(ctx, value, &number, exception) != 0) return -1;
            int32_bits = ct_ffi_to_uint32(number);
            if ((int32_t)int32_bits <= 0) out->u16 = 0;
            else if (int32_bits > UINT16_MAX) out->u16 = UINT16_MAX;
            else out->u16 = (uint16_t)int32_bits;
            return 0;
        case 5:
            if (ct_ffi_number_from_js(ctx, value, &number, exception) != 0) return -1;
            out->i32 = (int32_t)ct_ffi_to_uint32(number);
            return 0;
        case 6:
            if (ct_ffi_number_from_js(ctx, value, &number, exception) != 0) return -1;
            if (isnan(number) || number <= 0) out->u32 = 0;
            else if (number > UINT32_MAX) out->u32 = UINT32_MAX;
            else out->u32 = ct_ffi_to_uint32(number);
            return 0;
        case 7:
        case 15:
            out->u64 = ct_ffi_word_from_js(ctx, value);
            return 0;
        case 8:
        case 16:
            if (JSValueIsBigInt(ctx, value)) {
                out->u64 = ct_ffi_word_from_js(ctx, value);
                return 0;
            }
            if (ct_ffi_number_from_js(ctx, value, &number, exception) != 0) return -1;
            out->u64 = number > 0 ? ct_ffi_word_from_number(number) : 0;
            return 0;
        case 9:
            if (ct_ffi_number_from_js(ctx, value, &number, exception) != 0) return -1;
            out->f64 = isnan(number) || number == 0 ? 0 : number;
            return 0;
        case 10:
            if (ct_ffi_number_from_js(ctx, value, &number, exception) != 0) return -1;
            out->f32 = isnan(number) || number == 0 ? 0 : (float)number;
            return 0;
        case 11:
            out->u8 = JSValueToBoolean(ctx, value) ? 1 : 0;
            return 0;
        case 12:
        case 14:
        case 17:
        case 20:
            if (ct_prepared_ffi_pointer_from_js(
                    ctx,
                    value,
                    call,
                    argument_index,
                    &pointer,
                    exception
                ) != 0) {
                return -1;
            }
            out->u64 = pointer;
            return 0;
        case 13:
            return 0;
        case 18:
        case 19:
            return 0;
        default:
            ct_throw_type_error(ctx, exception, "Unsupported FFI argument type");
            return -1;
    }
}

static JSValueRef ct_prepared_ffi_result_to_js(
    JSContextRef ctx,
    const CtPreparedFfiCall *call,
    CtFfiValue result,
    JSValueRef *exception
) {
    switch (call->return_type_id) {
        case 12:
        case 17:
            return result.ptr == NULL
                ? JSValueMakeNull(ctx)
                : JSValueMakeNumber(ctx, (double)(uintptr_t)result.ptr);
        case 14:
        case 20:
            return JSValueMakeNumber(ctx, (double)(uintptr_t)result.ptr);
        case 15:
            return JSValueMakeNumber(ctx, (double)result.i64);
        case 16:
            if (result.u64 <= 9007199254740991ULL) return JSValueMakeNumber(ctx, (double)result.u64);
            return JSBigIntCreateWithUInt64(ctx, result.u64, exception);
        default:
            return ct_ffi_value_to_js(ctx, call->returns, result, exception);
    }
}

static JSValueRef ct_prepared_ffi_call_as_function(
    JSContextRef ctx,
    JSObjectRef function,
    JSObjectRef thisObject,
    size_t argc,
    const JSValueRef argv[],
    JSValueRef *exception
) {
    (void)thisObject;
    CtPreparedFfiCall *call = (CtPreparedFfiCall *)JSObjectGetPrivate(function);
    if (call == NULL || call->function_pointer == NULL) {
        ct_throw_type_error(ctx, exception, "FFI function is unavailable");
        return JSValueMakeUndefined(ctx);
    }

    if (call->fast_path == CT_PREPARED_FFI_FAST_PATH_I32_TO_I32) {
        JSValueRef value = argc > 0 ? argv[0] : JSValueMakeUndefined(ctx);
        double number = 0;
        if (ct_ffi_number_from_js(ctx, value, &number, exception) != 0) {
            return JSValueMakeUndefined(ctx);
        }

        int32_t argument = number >= INT32_MIN && number <= INT32_MAX
            ? (int32_t)number
            : (int32_t)ct_ffi_to_uint32(number);
        int32_t (*native_call)(int32_t) = (int32_t (*)(int32_t))call->function_pointer;
        return JSValueMakeNumber(ctx, native_call(argument));
    }

    CtFfiValue arg_values[CT_FFI_MAX_ARGS];
    void *arg_value_ptrs[CT_FFI_MAX_ARGS];
    CtFfiValue result;
    memset(&result, 0, sizeof(result));

    for (size_t index = 0; index < call->argc; index += 1) {
        JSValueRef value = index < argc ? argv[index] : JSValueMakeUndefined(ctx);
        if (call->arg_types[index] == CT_FFI_TYPE_NAPI_ENV) {
            arg_values[index].u64 = (uint64_t)(uintptr_t)call->napi_env;
        } else if (call->arg_types[index] == CT_FFI_TYPE_NAPI_VALUE) {
            arg_values[index].u64 = (uint64_t)(uintptr_t)value;
        } else if (ct_prepared_ffi_argument_from_js(
                       ctx,
                       value,
                       call,
                       index,
                       &arg_values[index],
                       exception
                   ) != 0) {
            return JSValueMakeUndefined(ctx);
        }
        arg_value_ptrs[index] = ct_ffi_value_ptr(&arg_values[index], call->arg_types[index]);
    }

    ffi_call(
        &call->cif,
        FFI_FN(call->function_pointer),
        ct_ffi_value_ptr(&result, call->returns),
        arg_value_ptrs
    );
    if (call->napi_env != NULL) {
        JSValueRef napi_exception = call->state->host.napi_take_exception(call->napi_env);
        if (napi_exception != NULL) {
            if (exception != NULL) *exception = napi_exception;
            return JSValueMakeUndefined(ctx);
        }
    }
    return ct_prepared_ffi_result_to_js(ctx, call, result, exception);
}

static void ct_prepared_ffi_call_destroy(CtPreparedFfiCall *call) {
    if (call == NULL) return;
    free(call);
}

static void ct_prepared_ffi_call_finalize(JSObjectRef object) {
    CtPreparedFfiCall *call = (CtPreparedFfiCall *)JSObjectGetPrivate(object);
    ct_prepared_ffi_call_destroy(call);
}

static JSClassRef ct_get_prepared_ffi_class(void) {
    pthread_mutex_lock(&ct_prepared_ffi_class_mutex);
    if (ct_prepared_ffi_class == NULL) {
        JSClassDefinition definition = kJSClassDefinitionEmpty;
        definition.className = "CottontailPreparedFFI";
        definition.callAsFunction = ct_prepared_ffi_call_as_function;
        definition.finalize = ct_prepared_ffi_call_finalize;
        ct_prepared_ffi_class = JSClassCreate(&definition);
    }
    JSClassRef result = ct_prepared_ffi_class;
    pthread_mutex_unlock(&ct_prepared_ffi_class_mutex);
    return result;
}

static JSValueRef ct_prepare_native_call(
    JSContextRef ctx,
    JSObjectRef function,
    JSObjectRef thisObject,
    size_t argc,
    const JSValueRef argv[],
    JSValueRef *exception
) {
    (void)thisObject;
    CtFfiCapabilityState *state = (CtFfiCapabilityState *)JSObjectGetPrivate(function);
    uint64_t pointer = 0;
    if (argc < 3 || ct_value_to_u64(ctx, argv[0], &pointer) != 0 || pointer == 0) {
        ct_throw_type_error(ctx, exception, "prepareNativeCall requires a function pointer and FFI signature");
        return JSValueMakeUndefined(ctx);
    }

    CtPreparedFfiCall *call = (CtPreparedFfiCall *)calloc(1, sizeof(*call));
    if (call == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    call->function_pointer = (void *)(uintptr_t)pointer;
    call->state = state;

    if (ct_parse_ffi_type_id(ctx, argv[1], &call->return_type_id, &call->returns, exception) != 0 ||
        ct_parse_ffi_type_id_array(
            ctx,
            argv[2],
            call->arg_type_ids,
            call->arg_types,
            call->ffi_arg_types,
            &call->argc,
            exception
        ) != 0) {
        ct_prepared_ffi_call_destroy(call);
        return JSValueMakeUndefined(ctx);
    }

    if (call->returns == CT_FFI_TYPE_I32 &&
        call->argc == 1 &&
        call->arg_types[0] == CT_FFI_TYPE_I32) {
        call->fast_path = CT_PREPARED_FFI_FAST_PATH_I32_TO_I32;
    }

    bool needs_pointer_constructors = false;
    for (size_t index = 0; index < call->argc && !needs_pointer_constructors; index += 1) {
        needs_pointer_constructors = call->arg_type_ids[index] == 12 ||
            call->arg_type_ids[index] == 14;
    }
    if (needs_pointer_constructors) {
        if (argc < 6 || !JSValueIsObject(ctx, argv[4]) || !JSValueIsObject(ctx, argv[5])) {
            ct_prepared_ffi_call_destroy(call);
            ct_throw_message(ctx, exception, "prepareNativeCall requires FFI pointer constructors");
            return JSValueMakeUndefined(ctx);
        }
        call->callback_constructor = (JSObjectRef)argv[4];
        call->cstring_constructor = (JSObjectRef)argv[5];
    }

    bool uses_napi = call->returns == CT_FFI_TYPE_NAPI_ENV || call->returns == CT_FFI_TYPE_NAPI_VALUE;
    for (size_t index = 0; index < call->argc && !uses_napi; index += 1) {
        uses_napi = call->arg_types[index] == CT_FFI_TYPE_NAPI_ENV ||
            call->arg_types[index] == CT_FFI_TYPE_NAPI_VALUE;
    }
    if (uses_napi) {
        char pointer_identity[64];
        char *identity = NULL;
        if (argc >= 4 && !JSValueIsUndefined(ctx, argv[3]) && !JSValueIsNull(ctx, argv[3])) {
            identity = ct_value_to_string_copy(ctx, argv[3]);
        } else {
            snprintf(pointer_identity, sizeof(pointer_identity), "pointer:%" PRIu64, pointer);
            identity = ct_duplicate_string(pointer_identity);
        }
        if (identity == NULL) {
            ct_prepared_ffi_call_destroy(call);
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        call->napi_env = state->host.napi_env_for_library(state->host.runtime, identity);
        free(identity);
        if (call->napi_env == NULL) {
            ct_prepared_ffi_call_destroy(call);
            ct_throw_message(ctx, exception, "failed to initialize the FFI Node-API environment");
            return JSValueMakeUndefined(ctx);
        }
    }

    if (ffi_prep_cif(
            &call->cif,
            FFI_DEFAULT_ABI,
            (unsigned int)call->argc,
            ct_ffi_libffi_type(call->returns),
            call->ffi_arg_types
        ) != FFI_OK) {
        ct_prepared_ffi_call_destroy(call);
        ct_throw_message(ctx, exception, "ffi_prep_cif failed for function pointer");
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef prepared = JSObjectMake(ctx, ct_get_prepared_ffi_class(), call);
    if (prepared == NULL) {
        ct_prepared_ffi_call_destroy(call);
        ct_throw_message(ctx, exception, "failed to create prepared FFI function");
        return JSValueMakeUndefined(ctx);
    }
    /* Root pointer constructors through the callable; JSC finalizers may run on any thread. */
    if (needs_pointer_constructors &&
        (!ct_set_property(
             ctx,
             prepared,
             "__cottontailFFICallbackConstructor",
             call->callback_constructor,
             exception
         ) ||
         !ct_set_property(
             ctx,
             prepared,
             "__cottontailFFICStringConstructor",
             call->cstring_constructor,
             exception
         ))) {
        JSObjectSetPrivate(prepared, NULL);
        ct_prepared_ffi_call_destroy(call);
        return JSValueMakeUndefined(ctx);
    }
    return prepared;
}

static JSValueRef ct_create_callback(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    CtFfiCapabilityState *state = (CtFfiCapabilityState *)JSObjectGetPrivate(function);
    CtFfiCallback *callback = NULL;
    (void)thisObject;

    if (argc < 4 || !JSValueIsObject(ctx, argv[0]) || !JSObjectIsFunction(ctx, (JSObjectRef)argv[0])) {
        ct_throw_message(ctx, exception, "cottontail.createCallback(fn, argTypes, returnType, threadsafe) requires a function");
        return JSValueMakeUndefined(ctx);
    }

    callback = (CtFfiCallback *)calloc(1, sizeof(CtFfiCallback));
    if (callback == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    callback->state = state;
    callback->ctx = ctx;
    callback->function = (JSObjectRef)argv[0];
    callback->threadsafe = JSValueToBoolean(ctx, argv[3]);
    callback->owner_thread = pthread_self();
    JSValueProtect(ctx, callback->function);

    if (ct_parse_ffi_type_array(ctx, argv[1], callback->arg_types, callback->ffi_arg_types, &callback->argc, exception) != 0 ||
        ct_parse_ffi_type(ctx, argv[2], &callback->returns, exception) != 0) {
        JSValueUnprotect(ctx, callback->function);
        free(callback);
        return JSValueMakeUndefined(ctx);
    }

    callback->closure = ffi_closure_alloc(sizeof(ffi_closure), &callback->code);
    if (callback->closure == NULL) {
        JSValueUnprotect(ctx, callback->function);
        free(callback);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    if (ffi_prep_cif(
            &callback->cif,
            FFI_DEFAULT_ABI,
            (unsigned int)callback->argc,
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
        JSValueUnprotect(ctx, callback->function);
        free(callback);
        ct_throw_message(ctx, exception, "failed to create FFI callback");
        return JSValueMakeUndefined(ctx);
    }

    pthread_mutex_lock(&state->callback_mutex);
    callback->next = state->callbacks;
    state->callbacks = callback;
    pthread_mutex_unlock(&state->callback_mutex);

    return JSValueMakeNumber(ctx, (double)(uintptr_t)callback->code);
}

static JSValueRef ct_close_callback(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    CtFfiCapabilityState *state = (CtFfiCapabilityState *)JSObjectGetPrivate(function);
    uint64_t code = 0;
    (void)thisObject;

    if (state == NULL || argc < 1 || ct_value_to_u64(ctx, argv[0], &code) != 0 || code == 0) {
        ct_throw_message(ctx, exception, "cottontail.closeCallback(ptr) requires a callback pointer");
        return JSValueMakeBoolean(ctx, false);
    }

    bool closed = false;
    JSObjectRef callback_function = NULL;
    pthread_mutex_lock(&state->callback_mutex);
    for (CtFfiCallback *callback = state->callbacks; callback != NULL; callback = callback->next) {
        if ((uint64_t)(uintptr_t)callback->code == code) {
            if (!callback->closed) {
                callback->closed = true;
                callback_function = callback->function;
                callback->function = NULL;
                closed = true;
            }
            break;
        }
    }
    pthread_mutex_unlock(&state->callback_mutex);

    if (callback_function != NULL) JSValueUnprotect(ctx, callback_function);
    return JSValueMakeBoolean(ctx, closed);
}



static bool ct_ffi_state_has_pending(void *opaque) { CtFfiCapabilityState *state = (CtFfiCapabilityState *)opaque; return ct_runtime_has_live_callbacks(state) || state->callback_jobs_head != NULL; }
static int ct_ffi_state_drain(void *opaque, char **error_out) { return ct_drain_ffi_callbacks((CtFfiCapabilityState *)opaque, error_out); }
static void ct_ffi_state_cleanup(void *opaque) {
    CtFfiCapabilityState *state = (CtFfiCapabilityState *)opaque;
    pthread_mutex_lock(&state->callback_mutex);
    for (CtFfiCallback *callback = state->callbacks; callback != NULL; callback = callback->next) callback->closed = true;
    CtFfiCallbackJob *job = state->callback_jobs_head; state->callback_jobs_head = state->callback_jobs_tail = NULL;
    pthread_mutex_unlock(&state->callback_mutex);
    while (job != NULL) { CtFfiCallbackJob *next = job->next; if (job->wait_for_result) { pthread_mutex_lock(&job->mutex); job->completed = true; pthread_cond_signal(&job->cond); pthread_mutex_unlock(&job->mutex); } else free(job); job = next; }
    CtFfiCallback *callback = state->callbacks;
    while (callback != NULL) { CtFfiCallback *next = callback->next; if (callback->function != NULL) JSValueUnprotect(callback->ctx, callback->function); if (callback->closure != NULL) ffi_closure_free(callback->closure); free(callback); callback = next; }
    pthread_mutex_destroy(&state->callback_mutex); free(state);
}
static int ct_ffi_bind(JSContextRef context, JSObjectRef target, CtFfiCapabilityState *state, const char *name, JSObjectCallAsFunctionCallback callback) {
    JSClassDefinition definition = kJSClassDefinitionEmpty; definition.className = name; definition.callAsFunction = callback;
    JSClassRef cls = JSClassCreate(&definition); JSObjectRef function = JSObjectMake(context, cls, state); JSClassRelease(cls);
    JSStringRef key = ct_js_string(name); JSValueRef error = NULL; JSObjectSetProperty(context, target, key, function, kJSPropertyAttributeNone, &error); JSStringRelease(key); return error == NULL ? 0 : -1;
}
CT_CAPABILITY_EXPORT int cottontail_capability_init(JSContextRef context, JSObjectRef target, const CtCapabilityHost *host) {
    if (host == NULL || host->register_lifecycle == NULL || host->wake == NULL || host->napi_env_for_library == NULL || host->napi_take_exception == NULL) return -1;
    CtFfiCapabilityState *state = (CtFfiCapabilityState *)calloc(1, sizeof(*state)); if (state == NULL) return -1;
    state->context = context; state->host = *host; pthread_mutex_init(&state->callback_mutex, NULL);
    if (ct_ffi_bind(context, target, state, "nativeSymbol", ct_ffi_native_symbol) != 0 ||
        ct_ffi_bind(context, target, state, "memoryAddress", ct_memory_address) != 0 ||
        ct_ffi_bind(context, target, state, "memoryView", ct_memory_view) != 0 ||
        ct_ffi_bind(context, target, state, "nativeCallPointer", ct_native_call_pointer) != 0 ||
        ct_ffi_bind(context, target, state, "prepareNativeCall", ct_prepare_native_call) != 0 ||
        ct_ffi_bind(context, target, state, "createCallback", ct_create_callback) != 0 ||
        ct_ffi_bind(context, target, state, "closeCallback", ct_close_callback) != 0 ||
        host->register_lifecycle(host->runtime, state, ct_ffi_state_has_pending, ct_ffi_state_drain, ct_ffi_state_cleanup) != 0) { ct_ffi_state_cleanup(state); return -1; }
    return 0;
}
