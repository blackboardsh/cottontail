#include "../native_capability.h"

extern uint8_t *ct_password_hash(int, const uint8_t *, size_t, uint32_t, uint32_t, uint8_t, size_t *, char **);
extern int ct_password_verify(int, const uint8_t *, size_t, const uint8_t *, size_t, char **);

static JSValueRef password_hash(JSContextRef context, JSObjectRef function, JSObjectRef this_object, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)this_object;
    if (argc < 5) {
        ct_throw_message(context, exception, "passwordHashSync requires algorithm, password, timeCost, memoryCost, and bcryptCost");
        return JSValueMakeUndefined(context);
    }
    uint8_t *password = NULL;
    size_t password_len = 0;
    if (ct_get_bytes(context, argv[1], &password, &password_len) != 0) {
        ct_throw_message(context, exception, "password must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(context);
    }
    size_t result_len = 0;
    char *error = NULL;
    uint8_t *result = ct_password_hash(
        (int)ct_value_to_number(context, argv[0]), password, password_len,
        (uint32_t)ct_value_to_number(context, argv[2]),
        (uint32_t)ct_value_to_number(context, argv[3]),
        (uint8_t)ct_value_to_number(context, argv[4]), &result_len, &error
    );
    if (result == NULL) {
        ct_throw_message(context, exception, error != NULL ? error : "Password hashing failed");
        free(error);
        return JSValueMakeUndefined(context);
    }
    JSValueRef value = ct_make_string_len(context, (const char *)result, result_len);
    free(result);
    return value;
}

static JSValueRef password_verify(JSContextRef context, JSObjectRef function, JSObjectRef this_object, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)this_object;
    if (argc < 3) {
        ct_throw_message(context, exception, "passwordVerifySync requires algorithm, password, and hash");
        return JSValueMakeUndefined(context);
    }
    uint8_t *password = NULL;
    size_t password_len = 0;
    uint8_t *hash = NULL;
    size_t hash_len = 0;
    if (ct_get_bytes(context, argv[1], &password, &password_len) != 0 || ct_get_bytes(context, argv[2], &hash, &hash_len) != 0) {
        ct_throw_message(context, exception, "password and hash must be ArrayBuffers or typed arrays");
        return JSValueMakeUndefined(context);
    }
    char *error = NULL;
    int result = ct_password_verify((int)ct_value_to_number(context, argv[0]), password, password_len, hash, hash_len, &error);
    if (result < 0) {
        ct_throw_message(context, exception, error != NULL ? error : "Password verification failed");
        free(error);
        return JSValueMakeUndefined(context);
    }
    return JSValueMakeBoolean(context, result == 1);
}

#define PASSWORD_BINDINGS \
    { "passwordHashSync", password_hash }, \
    { "passwordVerifySync", password_verify },
CT_CAPABILITY_EXPORT_BINDINGS(PASSWORD_BINDINGS)
