#include "../native_capability.h"
#if defined(_WIN32)
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <wincred.h>

static char *ct_duplicate_bytes(const char *bytes, size_t len) {
    char *copy = (char *)malloc(len + 1);
    if (copy == NULL) return NULL;
    if (len > 0) memcpy(copy, bytes, len);
    copy[len] = '\0';
    return copy;
}

static WCHAR *ct_windows_utf8_to_wide(const char *value) {
    if (value == NULL) return NULL;
    size_t length = strlen(value);
    if (length > INT_MAX) return NULL;
    if (length == 0) return (WCHAR *)calloc(1, sizeof(WCHAR));
    int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, (int)length, NULL, 0);
    if (required <= 0) return NULL;
    WCHAR *wide = (WCHAR *)malloc(((size_t)required + 1) * sizeof(WCHAR));
    if (wide == NULL) return NULL;
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, (int)length, wide, required) != required) {
        free(wide);
        return NULL;
    }
    wide[required] = L'\0';
    return wide;
}

static char *ct_windows_wide_to_utf8(const WCHAR *value, size_t length, size_t *length_out) {
    if (length_out != NULL) *length_out = 0;
    if (value == NULL || length > INT_MAX) return NULL;
    if (length == 0) return (char *)calloc(1, 1);
    int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, (int)length, NULL, 0, NULL, NULL);
    if (required <= 0) return NULL;
    char *utf8 = (char *)malloc((size_t)required + 1);
    if (utf8 == NULL) return NULL;
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, (int)length, utf8, required, NULL, NULL) != required) {
        free(utf8);
        return NULL;
    }
    utf8[required] = '\0';
    if (length_out != NULL) *length_out = (size_t)required;
    return utf8;
}
#endif
#if defined(_WIN32)
static WCHAR ct_windows_secret_username[] = L"Cottontail";

static bool ct_windows_secret_legacy_string_eligible(const JSChar *characters, size_t length) {
    for (size_t index = 0; index < length; index += 1) {
        unsigned int code_unit = (unsigned int)characters[index];
        if (code_unit == 0) return false;
        if (code_unit >= 0xd800 && code_unit <= 0xdbff) {
            if (index + 1 >= length) return false;
            unsigned int trailing = (unsigned int)characters[index + 1];
            if (trailing < 0xdc00 || trailing > 0xdfff) return false;
            index += 1;
        } else if (code_unit >= 0xdc00 && code_unit <= 0xdfff) {
            return false;
        }
    }
    return true;
}

static WCHAR *ct_windows_secret_target(
    JSContextRef ctx,
    JSValueRef service_value,
    JSValueRef name_value,
    bool *legacy_eligible_out,
    DWORD *error_out,
    JSValueRef *exception
) {
    /* TargetName lookup is case-insensitive. Canonical hex of the UTF-16 code
       units preserves exact JavaScript string identity, including lone
       surrogates and embedded NULs, without relying on target-name casing. */
    static const WCHAR prefix[] = L"CottontailSecrets-v1-";
    static const WCHAR hex[] = L"0123456789ABCDEF";
    *legacy_eligible_out = false;
    *error_out = ERROR_NOT_ENOUGH_MEMORY;

    JSStringRef service = JSValueToStringCopy(ctx, service_value, exception);
    if (service == NULL) return NULL;
    if (exception != NULL && *exception != NULL) {
        JSStringRelease(service);
        return NULL;
    }
    JSStringRef name = JSValueToStringCopy(ctx, name_value, exception);
    if (name == NULL || (exception != NULL && *exception != NULL)) {
        if (name != NULL) JSStringRelease(name);
        JSStringRelease(service);
        return NULL;
    }

    size_t service_len = JSStringGetLength(service);
    size_t name_len = JSStringGetLength(name);
    const JSChar *service_characters = JSStringGetCharactersPtr(service);
    const JSChar *name_characters = JSStringGetCharactersPtr(name);
    *legacy_eligible_out =
        ct_windows_secret_legacy_string_eligible(service_characters, service_len) &&
        ct_windows_secret_legacy_string_eligible(name_characters, name_len);

    size_t prefix_len = sizeof(prefix) / sizeof(prefix[0]) - 1;
    if (service_len > SIZE_MAX / 4 || name_len > SIZE_MAX / 4) {
        JSStringRelease(service);
        JSStringRelease(name);
        return NULL;
    }
    size_t service_hex_len = service_len * 4;
    size_t name_hex_len = name_len * 4;
    if (service_hex_len > SIZE_MAX - prefix_len - 2 ||
        name_hex_len > SIZE_MAX - prefix_len - service_hex_len - 2) {
        JSStringRelease(service);
        JSStringRelease(name);
        return NULL;
    }
    size_t target_len = prefix_len + service_hex_len + 1 + name_hex_len;
    if (target_len > CRED_MAX_GENERIC_TARGET_NAME_LENGTH) {
        JSStringRelease(service);
        JSStringRelease(name);
        *error_out = ERROR_BAD_LENGTH;
        return NULL;
    }
    WCHAR *target = (WCHAR *)malloc((target_len + 1) * sizeof(WCHAR));
    if (target == NULL) {
        JSStringRelease(service);
        JSStringRelease(name);
        return NULL;
    }
    WCHAR *cursor = target;
    memcpy(cursor, prefix, prefix_len * sizeof(WCHAR));
    cursor += prefix_len;
    for (size_t index = 0; index < service_len; index += 1) {
        unsigned int code_unit = (unsigned int)service_characters[index];
        *cursor++ = hex[(code_unit >> 12) & 0x0f];
        *cursor++ = hex[(code_unit >> 8) & 0x0f];
        *cursor++ = hex[(code_unit >> 4) & 0x0f];
        *cursor++ = hex[code_unit & 0x0f];
    }
    *cursor++ = L'-';
    for (size_t index = 0; index < name_len; index += 1) {
        unsigned int code_unit = (unsigned int)name_characters[index];
        *cursor++ = hex[(code_unit >> 12) & 0x0f];
        *cursor++ = hex[(code_unit >> 8) & 0x0f];
        *cursor++ = hex[(code_unit >> 4) & 0x0f];
        *cursor++ = hex[code_unit & 0x0f];
    }
    *cursor = L'\0';
    JSStringRelease(service);
    JSStringRelease(name);
    *error_out = ERROR_SUCCESS;
    return target;
}

static WCHAR *ct_windows_secret_legacy_target(const char *service, const char *name) {
    size_t service_len = strlen(service);
    size_t name_len = strlen(name);
    if (service_len > SIZE_MAX - name_len - 2) {
        errno = ENOMEM;
        return NULL;
    }
    size_t target_len = service_len + 1 + name_len;
    char *target = (char *)malloc(target_len + 1);
    if (target == NULL) {
        errno = ENOMEM;
        return NULL;
    }
    memcpy(target, service, service_len);
    target[service_len] = '/';
    memcpy(target + service_len + 1, name, name_len);
    target[target_len] = '\0';
    WCHAR *wide = ct_windows_utf8_to_wide(target);
    free(target);
    return wide;
}

static bool ct_windows_secret_legacy_matches(
    PCREDENTIALW credential,
    const WCHAR *target,
    const WCHAR *username
) {
    /* The old service/name target was ambiguous at slashes. Old entries also
       stored name as UserName, which conservatively attributes uncorrupted
       entries. Case-insensitive overwrite history cannot be recovered. */
    return credential != NULL &&
        credential->TargetName != NULL &&
        credential->UserName != NULL &&
        wcscmp(credential->TargetName, target) == 0 &&
        wcscmp(credential->UserName, username) == 0;
}

static bool ct_windows_secret_delete_matching_legacy(
    const WCHAR *target,
    const WCHAR *username,
    bool *deleted_out,
    DWORD *error_out
) {
    *deleted_out = false;
    *error_out = ERROR_SUCCESS;
    PCREDENTIALW credential = NULL;
    if (!CredReadW(target, CRED_TYPE_GENERIC, 0, &credential)) {
        DWORD error_code = GetLastError();
        if (error_code == ERROR_NOT_FOUND) return true;
        *error_out = error_code;
        return false;
    }
    bool matches = ct_windows_secret_legacy_matches(credential, target, username);
    CredFree(credential);
    if (!matches) return true;

    /* CredDeleteW has no conditional form, so keep this best-effort migration
       path limited to an explicit delete (including public set-to-empty). */
    if (CredDeleteW(target, CRED_TYPE_GENERIC, 0)) {
        *deleted_out = true;
        return true;
    }
    DWORD error_code = GetLastError();
    if (error_code == ERROR_NOT_FOUND) return true;
    *error_out = error_code;
    return false;
}

static void ct_windows_secret_throw_error(JSContextRef ctx, JSValueRef *exception, DWORD error_code) {
    if (exception == NULL) return;

    WCHAR *wide_message = NULL;
    DWORD wide_length = FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        NULL,
        error_code,
        MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        (LPWSTR)&wide_message,
        0,
        NULL
    );
    size_t message_len = 0;
    char *message = wide_length > 0
        ? ct_windows_wide_to_utf8(wide_message, (size_t)wide_length, &message_len)
        : NULL;
    if (wide_message != NULL) LocalFree(wide_message);

    const char *fallback = "Windows Credential Manager error";
    if (message == NULL) {
        message_len = strlen(fallback);
        message = ct_duplicate_bytes(fallback, message_len);
    }

    char suffix[64];
    int suffix_length = snprintf(suffix, sizeof(suffix), " (code: %lu)", (unsigned long)error_code);
    if (suffix_length < 0) suffix_length = 0;
    size_t suffix_len = (size_t)suffix_length;
    char *message_with_code = NULL;
    if (message != NULL && message_len <= SIZE_MAX - suffix_len - 1) {
        message_with_code = (char *)malloc(message_len + suffix_len + 1);
        if (message_with_code != NULL) {
            memcpy(message_with_code, message, message_len);
            memcpy(message_with_code + message_len, suffix, suffix_len);
            message_with_code[message_len + suffix_len] = '\0';
        }
    }

    const char *final_message = message_with_code != NULL
        ? message_with_code
        : (message != NULL ? message : fallback);
    size_t final_message_len = message_with_code != NULL
        ? message_len + suffix_len
        : strlen(final_message);
    JSValueRef argument = ct_make_string_len(ctx, final_message, final_message_len);
    JSObjectRef error = JSObjectMakeError(ctx, 1, &argument, NULL);
    ct_set_property(
        ctx,
        error,
        "code",
        ct_make_string(
            ctx,
            error_code == ERROR_ACCESS_DENIED
                ? "ERR_SECRETS_ACCESS_DENIED"
                : "ERR_SECRETS_PLATFORM_ERROR"
        ),
        NULL
    );
    *exception = error;
    free(message_with_code);
    free(message);
}

static bool ct_windows_secret_copy_key(
    JSContextRef ctx,
    size_t argc,
    const JSValueRef argv[],
    char **service_out,
    char **name_out,
    JSValueRef *exception
) {
    *service_out = NULL;
    *name_out = NULL;
    if (argc < 2) {
        ct_throw_type_error(ctx, exception, "Windows Credential Manager requires service and name");
        return false;
    }
    *service_out = ct_value_to_string_copy(ctx, argv[0]);
    *name_out = ct_value_to_string_copy(ctx, argv[1]);
    if (*service_out != NULL && *name_out != NULL) return true;
    free(*service_out);
    free(*name_out);
    *service_out = NULL;
    *name_out = NULL;
    ct_throw_message(ctx, exception, "Out of memory");
    return false;
}
#endif

static JSValueRef ct_secret_get(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
#if defined(_WIN32)
    char *service = NULL;
    char *name = NULL;
    if (!ct_windows_secret_copy_key(
            ctx,
            argc,
            argv,
            &service,
            &name,
            exception)) {
        return JSValueMakeUndefined(ctx);
    }
    bool legacy_eligible = false;
    DWORD target_error = ERROR_SUCCESS;
    WCHAR *target = ct_windows_secret_target(
        ctx,
        argv[0],
        argv[1],
        &legacy_eligible,
        &target_error,
        exception
    );
    WCHAR *legacy_target = legacy_eligible
        ? ct_windows_secret_legacy_target(service, name)
        : NULL;
    WCHAR *legacy_username = legacy_eligible
        ? ct_windows_utf8_to_wide(name)
        : NULL;
    free(service);
    free(name);
    bool target_too_long = target == NULL && target_error == ERROR_BAD_LENGTH;
    bool legacy_setup_failed =
        legacy_eligible && (legacy_target == NULL || legacy_username == NULL);
    if ((target == NULL && !target_too_long) || legacy_setup_failed) {
        DWORD setup_error = legacy_setup_failed
            ? ERROR_NOT_ENOUGH_MEMORY
            : target_error;
        free(target);
        free(legacy_target);
        free(legacy_username);
        if (exception == NULL || *exception == NULL) {
            ct_windows_secret_throw_error(ctx, exception, setup_error);
        }
        return JSValueMakeUndefined(ctx);
    }

    PCREDENTIALW credential = NULL;
    BOOL read = target != NULL
        ? CredReadW(target, CRED_TYPE_GENERIC, 0, &credential)
        : FALSE;
    DWORD error_code = target == NULL
        ? ERROR_NOT_FOUND
        : (read ? ERROR_SUCCESS : GetLastError());
    if (!read && error_code == ERROR_NOT_FOUND && legacy_eligible) {
        read = CredReadW(legacy_target, CRED_TYPE_GENERIC, 0, &credential);
        error_code = read ? ERROR_SUCCESS : GetLastError();
        if (read && !ct_windows_secret_legacy_matches(credential, legacy_target, legacy_username)) {
            CredFree(credential);
            credential = NULL;
            read = FALSE;
            error_code = ERROR_NOT_FOUND;
        }
    }
    free(target);
    free(legacy_target);
    free(legacy_username);
    if (!read) {
        if (error_code == ERROR_NOT_FOUND) return JSValueMakeNull(ctx);
        ct_windows_secret_throw_error(ctx, exception, error_code);
        return JSValueMakeUndefined(ctx);
    }

    JSValueRef result = JSValueMakeNull(ctx);
    if (credential->CredentialBlob != NULL && credential->CredentialBlobSize > 0) {
        result = ct_make_string_len(
            ctx,
            (const char *)credential->CredentialBlob,
            (size_t)credential->CredentialBlobSize
        );
    }
    CredFree(credential);
    return result;
#else
    (void)argc;
    (void)argv;
    ct_throw_message(ctx, exception, "Windows Credential Manager is unavailable on this platform");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_secret_set(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
#if defined(_WIN32)
    char *service = NULL;
    char *name = NULL;
    if (argc < 3 ||
        !ct_windows_secret_copy_key(
            ctx,
            argc,
            argv,
            &service,
            &name,
            exception)) {
        if (argc < 3 && (exception == NULL || *exception == NULL)) {
            ct_throw_type_error(ctx, exception, "Windows Credential Manager requires service, name, and value");
        }
        return JSValueMakeUndefined(ctx);
    }
    size_t value_len = 0;
    char *value = ct_value_to_utf8_copy_checked(ctx, argv[2], &value_len, exception);
    if (value == NULL) {
        free(service);
        free(name);
        if (exception == NULL || *exception == NULL) ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    bool legacy_eligible = false;
    DWORD target_error = ERROR_SUCCESS;
    WCHAR *target = ct_windows_secret_target(
        ctx,
        argv[0],
        argv[1],
        &legacy_eligible,
        &target_error,
        exception
    );
    bool needs_legacy_delete = value_len == 0 && legacy_eligible;
    WCHAR *legacy_target = needs_legacy_delete
        ? ct_windows_secret_legacy_target(service, name)
        : NULL;
    WCHAR *legacy_username = needs_legacy_delete
        ? ct_windows_utf8_to_wide(name)
        : NULL;
    free(service);
    free(name);
    bool target_too_long = target == NULL && target_error == ERROR_BAD_LENGTH;
    bool legacy_setup_failed =
        needs_legacy_delete && (legacy_target == NULL || legacy_username == NULL);
    if ((target == NULL && !(value_len == 0 && target_too_long)) ||
        legacy_setup_failed) {
        DWORD setup_error = legacy_setup_failed
            ? ERROR_NOT_ENOUGH_MEMORY
            : target_error;
        free(target);
        free(legacy_target);
        free(legacy_username);
        SecureZeroMemory(value, value_len);
        free(value);
        if (exception == NULL || *exception == NULL) {
            ct_windows_secret_throw_error(ctx, exception, setup_error);
        }
        return JSValueMakeUndefined(ctx);
    }

    BOOL written = FALSE;
    DWORD error_code = ERROR_SUCCESS;
    if (value_len == 0) {
        written = target != NULL
            ? CredDeleteW(target, CRED_TYPE_GENERIC, 0)
            : TRUE;
        error_code = target == NULL || written ? ERROR_SUCCESS : GetLastError();
        if (!written && error_code == ERROR_NOT_FOUND) {
            written = TRUE;
            error_code = ERROR_SUCCESS;
        }
        if (written && needs_legacy_delete) {
            bool legacy_deleted = false;
            if (!ct_windows_secret_delete_matching_legacy(
                    legacy_target,
                    legacy_username,
                    &legacy_deleted,
                    &error_code)) {
                written = FALSE;
            }
        }
    } else {
        CREDENTIALW credential;
        memset(&credential, 0, sizeof(credential));
        credential.Type = CRED_TYPE_GENERIC;
        credential.TargetName = target;
        credential.UserName = ct_windows_secret_username;
        credential.CredentialBlobSize = (DWORD)value_len;
        credential.CredentialBlob = (LPBYTE)value;
        credential.Persist = CRED_PERSIST_ENTERPRISE;
        written = CredWriteW(&credential, 0);
        error_code = written ? ERROR_SUCCESS : GetLastError();
    }

    free(target);
    free(legacy_target);
    free(legacy_username);
    SecureZeroMemory(value, value_len);
    free(value);
    if (!written) {
        ct_windows_secret_throw_error(ctx, exception, error_code);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
#else
    (void)argc;
    (void)argv;
    ct_throw_message(ctx, exception, "Windows Credential Manager is unavailable on this platform");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_secret_delete(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
#if defined(_WIN32)
    char *service = NULL;
    char *name = NULL;
    if (!ct_windows_secret_copy_key(
            ctx,
            argc,
            argv,
            &service,
            &name,
            exception)) {
        return JSValueMakeUndefined(ctx);
    }
    bool legacy_eligible = false;
    DWORD target_error = ERROR_SUCCESS;
    WCHAR *target = ct_windows_secret_target(
        ctx,
        argv[0],
        argv[1],
        &legacy_eligible,
        &target_error,
        exception
    );
    WCHAR *legacy_target = legacy_eligible
        ? ct_windows_secret_legacy_target(service, name)
        : NULL;
    WCHAR *legacy_username = legacy_eligible
        ? ct_windows_utf8_to_wide(name)
        : NULL;
    free(service);
    free(name);
    bool target_too_long = target == NULL && target_error == ERROR_BAD_LENGTH;
    bool legacy_setup_failed =
        legacy_eligible && (legacy_target == NULL || legacy_username == NULL);
    if ((target == NULL && !target_too_long) || legacy_setup_failed) {
        DWORD setup_error = legacy_setup_failed
            ? ERROR_NOT_ENOUGH_MEMORY
            : target_error;
        free(target);
        free(legacy_target);
        free(legacy_username);
        if (exception == NULL || *exception == NULL) {
            ct_windows_secret_throw_error(ctx, exception, setup_error);
        }
        return JSValueMakeUndefined(ctx);
    }

    BOOL deleted = target != NULL
        ? CredDeleteW(target, CRED_TYPE_GENERIC, 0)
        : FALSE;
    DWORD error_code = target == NULL
        ? ERROR_NOT_FOUND
        : (deleted ? ERROR_SUCCESS : GetLastError());
    if (!deleted && error_code != ERROR_NOT_FOUND) {
        free(target);
        free(legacy_target);
        free(legacy_username);
        ct_windows_secret_throw_error(ctx, exception, error_code);
        return JSValueMakeUndefined(ctx);
    }
    bool legacy_deleted = false;
    bool legacy_ok = !legacy_eligible ||
        ct_windows_secret_delete_matching_legacy(
            legacy_target,
            legacy_username,
            &legacy_deleted,
            &error_code
        );
    free(target);
    free(legacy_target);
    free(legacy_username);
    if (!legacy_ok) {
        ct_windows_secret_throw_error(ctx, exception, error_code);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeBoolean(ctx, deleted || legacy_deleted);
#else
    (void)argc;
    (void)argv;
    ct_throw_message(ctx, exception, "Windows Credential Manager is unavailable on this platform");
    return JSValueMakeUndefined(ctx);
#endif
}

#if defined(_WIN32)
#define CT_BINDING(name, callback) { name, callback },
CT_CAPABILITY_EXPORT_BINDINGS(
    CT_BINDING("secretGet", ct_secret_get)
    CT_BINDING("secretSet", ct_secret_set)
    CT_BINDING("secretDelete", ct_secret_delete)
)
#undef CT_BINDING
#endif
