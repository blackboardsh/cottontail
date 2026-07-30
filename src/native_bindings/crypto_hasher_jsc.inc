/*
 * Incremental Bun.CryptoHasher state.
 *
 * The JS-visible value is only a branded private token. Its OpenSSL state is
 * owned by the token and released by the JSC finalizer, following the same
 * lifetime model as the native HTTP parser. Input ArrayBuffer pointers are
 * borrowed only for the duration of EVP/HMAC update calls.
 */

enum {
    CT_CRYPTO_HASHER_OUTPUT_BUFFER = 0,
    CT_CRYPTO_HASHER_OUTPUT_HEX = 1,
    CT_CRYPTO_HASHER_OUTPUT_BASE64 = 2,
    CT_CRYPTO_HASHER_OUTPUT_BASE64URL = 3,
    CT_CRYPTO_HASHER_OUTPUT_LATIN1 = 4,
    CT_CRYPTO_HASHER_OUTPUT_ASCII = 5,
    CT_CRYPTO_HASHER_OUTPUT_UTF8 = 6,
    CT_CRYPTO_HASHER_OUTPUT_UTF16LE = 7,
    CT_CRYPTO_HASHER_OUTPUT_TARGET = 8,
};

#if CT_HAS_OPENSSL
typedef enum {
    CT_CRYPTO_HASHER_EVP,
    CT_CRYPTO_HASHER_HMAC,
    CT_CRYPTO_HASHER_MD4,
} CtCryptoHasherKind;

typedef struct {
    CtCryptoHasherKind kind;
    char *algorithm_name;
    const EVP_MD *md;
    EVP_MD_CTX *md_ctx;
    HMAC_CTX *hmac_ctx;
    size_t output_len;
    bool is_xof;
    bool consumed;
#if CT_HAS_OPENSSL_MD4 && !defined(OPENSSL_NO_MD4)
    MD4_CTX md4_ctx;
#endif
} CtCryptoHasherState;
#else
typedef struct {
    bool unavailable;
} CtCryptoHasherState;
#endif

static JSClassRef ct_crypto_hasher_class = NULL;
static uv_once_t ct_crypto_hasher_class_once = UV_ONCE_INIT;

static void ct_crypto_hasher_state_free(CtCryptoHasherState *state) {
    if (state == NULL) return;
#if CT_HAS_OPENSSL
    if (state->md_ctx != NULL) EVP_MD_CTX_free(state->md_ctx);
    if (state->hmac_ctx != NULL) HMAC_CTX_free(state->hmac_ctx);
    free(state->algorithm_name);
#endif
    free(state);
}

static void ct_crypto_hasher_finalize(JSObjectRef object) {
    CtCryptoHasherState *state = (CtCryptoHasherState *)JSObjectGetPrivate(object);
    if (state != NULL) ct_crypto_hasher_state_free(state);
}

static void ct_crypto_hasher_initialize_class(void) {
    JSClassDefinition definition = kJSClassDefinitionEmpty;
    definition.className = "CottontailCryptoHasher";
    definition.finalize = ct_crypto_hasher_finalize;
    ct_crypto_hasher_class = JSClassCreate(&definition);
}

static CtCryptoHasherState *ct_crypto_hasher_from_value(JSContextRef ctx, JSValueRef value) {
    if (
        !JSValueIsObject(ctx, value) ||
        ct_crypto_hasher_class == NULL ||
        !JSValueIsObjectOfClass(ctx, value, ct_crypto_hasher_class)
    ) {
        return NULL;
    }
    return (CtCryptoHasherState *)JSObjectGetPrivate((JSObjectRef)value);
}

#if CT_HAS_OPENSSL
static bool ct_crypto_hasher_evp_initialize(CtCryptoHasherState *state) {
    const EVP_MD *md = NULL;
    size_t output_len = 0;
    if (!ct_crypto_digest_init(state->md_ctx, state->algorithm_name, &md, &output_len)) {
        return false;
    }
    const int md_size = EVP_MD_get_size(md);
    const bool is_xof = (EVP_MD_get_flags(md) & EVP_MD_FLAG_XOF) != 0;
    if (output_len == 0 && md_size > 0) output_len = (size_t)md_size;
    if (output_len == 0) output_len = is_xof ? 32 : 1;
    if (output_len > EVP_MAX_MD_SIZE) return false;
    state->md = md;
    state->output_len = output_len;
    state->is_xof = is_xof;
    return true;
}

static CtCryptoHasherState *ct_crypto_hasher_state_create(
    const char *algorithm_name,
    const uint8_t *key,
    size_t key_len,
    bool keyed
) {
    CtCryptoHasherState *state = (CtCryptoHasherState *)calloc(1, sizeof(*state));
    if (state == NULL) return NULL;
    state->algorithm_name = ct_duplicate_string(algorithm_name);
    if (state->algorithm_name == NULL) {
        ct_crypto_hasher_state_free(state);
        return NULL;
    }

    if (keyed) {
        const EVP_MD *md = ct_crypto_fixed_digest(algorithm_name);
        if (
            md == NULL ||
            EVP_MD_get_size(md) <= 0 ||
            (EVP_MD_get_flags(md) & EVP_MD_FLAG_XOF) != 0 ||
            key_len > INT_MAX
        ) {
            ct_crypto_hasher_state_free(state);
            ERR_clear_error();
            return NULL;
        }
        state->kind = CT_CRYPTO_HASHER_HMAC;
        state->md = md;
        state->hmac_ctx = HMAC_CTX_new();
        const void *key_pointer = key_len == 0 ? (const void *)"" : (const void *)key;
        if (
            state->hmac_ctx == NULL ||
            HMAC_Init_ex(state->hmac_ctx, key_pointer, (int)key_len, md, NULL) != 1
        ) {
            ct_crypto_hasher_state_free(state);
            ERR_clear_error();
            return NULL;
        }
        state->output_len = (size_t)HMAC_size(state->hmac_ctx);
        if (state->output_len == 0 || state->output_len > EVP_MAX_MD_SIZE) {
            ct_crypto_hasher_state_free(state);
            return NULL;
        }
        return state;
    }

#if CT_HAS_OPENSSL_MD4 && !defined(OPENSSL_NO_MD4)
    if (strcasecmp(algorithm_name, "md4") == 0) {
        state->kind = CT_CRYPTO_HASHER_MD4;
        state->output_len = MD4_DIGEST_LENGTH;
        if (MD4_Init(&state->md4_ctx) != 1) {
            ct_crypto_hasher_state_free(state);
            ERR_clear_error();
            return NULL;
        }
        return state;
    }
#endif

    state->kind = CT_CRYPTO_HASHER_EVP;
    state->md_ctx = EVP_MD_CTX_new();
    if (state->md_ctx == NULL || !ct_crypto_hasher_evp_initialize(state)) {
        ct_crypto_hasher_state_free(state);
        ERR_clear_error();
        return NULL;
    }
    return state;
}

static CtCryptoHasherState *ct_crypto_hasher_state_copy(const CtCryptoHasherState *source) {
    if (source == NULL || source->consumed) return NULL;
    CtCryptoHasherState *copy = (CtCryptoHasherState *)calloc(1, sizeof(*copy));
    if (copy == NULL) return NULL;
    copy->kind = source->kind;
    copy->algorithm_name = ct_duplicate_string(source->algorithm_name);
    copy->md = source->md;
    copy->output_len = source->output_len;
    copy->is_xof = source->is_xof;
    if (copy->algorithm_name == NULL) {
        ct_crypto_hasher_state_free(copy);
        return NULL;
    }

    switch (source->kind) {
        case CT_CRYPTO_HASHER_EVP:
            copy->md_ctx = EVP_MD_CTX_new();
            if (
                copy->md_ctx == NULL ||
                EVP_MD_CTX_copy_ex(copy->md_ctx, source->md_ctx) != 1
            ) {
                ct_crypto_hasher_state_free(copy);
                ERR_clear_error();
                return NULL;
            }
            break;
        case CT_CRYPTO_HASHER_HMAC:
            copy->hmac_ctx = HMAC_CTX_new();
            if (
                copy->hmac_ctx == NULL ||
                HMAC_CTX_copy(copy->hmac_ctx, source->hmac_ctx) != 1
            ) {
                ct_crypto_hasher_state_free(copy);
                ERR_clear_error();
                return NULL;
            }
            break;
        case CT_CRYPTO_HASHER_MD4:
#if CT_HAS_OPENSSL_MD4 && !defined(OPENSSL_NO_MD4)
            copy->md4_ctx = source->md4_ctx;
            break;
#else
            ct_crypto_hasher_state_free(copy);
            return NULL;
#endif
    }
    return copy;
}

static bool ct_crypto_hasher_state_update(
    CtCryptoHasherState *state,
    const uint8_t *bytes,
    size_t length
) {
    if (state == NULL || state->consumed) return false;
    const uint8_t *input = length == 0 ? (const uint8_t *)"" : bytes;
    int ok = 0;
    switch (state->kind) {
        case CT_CRYPTO_HASHER_EVP:
            ok = EVP_DigestUpdate(state->md_ctx, input, length);
            break;
        case CT_CRYPTO_HASHER_HMAC:
            ok = HMAC_Update(state->hmac_ctx, input, length);
            break;
        case CT_CRYPTO_HASHER_MD4:
#if CT_HAS_OPENSSL_MD4 && !defined(OPENSSL_NO_MD4)
            ok = MD4_Update(&state->md4_ctx, input, length);
            break;
#else
            return false;
#endif
    }
    if (ok != 1) ERR_clear_error();
    return ok == 1;
}

static bool ct_crypto_hasher_state_digest(
    CtCryptoHasherState *state,
    uint8_t output[EVP_MAX_MD_SIZE],
    size_t *output_len
) {
    if (state == NULL || state->consumed) return false;
    bool ok = false;
    size_t result_len = state->output_len;
    switch (state->kind) {
        case CT_CRYPTO_HASHER_EVP:
            if (state->is_xof) {
                ok = EVP_DigestFinalXOF(state->md_ctx, output, result_len) == 1;
            } else {
                unsigned int fixed_len = 0;
                ok = EVP_DigestFinal_ex(state->md_ctx, output, &fixed_len) == 1;
                result_len = fixed_len;
            }
            if (ok) ok = ct_crypto_hasher_evp_initialize(state);
            break;
        case CT_CRYPTO_HASHER_HMAC: {
            unsigned int hmac_len = 0;
            ok = HMAC_Final(state->hmac_ctx, output, &hmac_len) == 1;
            result_len = hmac_len;
            HMAC_CTX_free(state->hmac_ctx);
            state->hmac_ctx = NULL;
            state->consumed = true;
            break;
        }
        case CT_CRYPTO_HASHER_MD4:
#if CT_HAS_OPENSSL_MD4 && !defined(OPENSSL_NO_MD4)
            ok = MD4_Final(output, &state->md4_ctx) == 1;
            result_len = MD4_DIGEST_LENGTH;
            if (ok) ok = MD4_Init(&state->md4_ctx) == 1;
            break;
#else
            return false;
#endif
    }
    if (!ok || result_len > EVP_MAX_MD_SIZE) {
        ERR_clear_error();
        return false;
    }
    *output_len = result_len;
    return true;
}
#endif

static JSValueRef ct_crypto_hasher_chars_result(
    JSContextRef ctx,
    const JSChar *characters,
    size_t length
) {
    JSStringRef string = JSStringCreateWithCharacters(characters, length);
    JSValueRef result = JSValueMakeString(ctx, string);
    JSStringRelease(string);
    return result;
}

static JSValueRef ct_crypto_hasher_utf8_result(
    JSContextRef ctx,
    const uint8_t *bytes,
    size_t length
) {
    JSChar characters[EVP_MAX_MD_SIZE];
    size_t input = 0;
    size_t output = 0;
    while (input < length) {
        const uint8_t first = bytes[input];
        uint32_t code_point = 0;
        size_t needed = 0;
        uint8_t lower = 0x80;
        uint8_t upper = 0xbf;
        if (first < 0x80) {
            characters[output++] = first;
            input += 1;
            continue;
        } else if (first >= 0xc2 && first <= 0xdf) {
            needed = 1;
            code_point = first & 0x1f;
        } else if (first >= 0xe0 && first <= 0xef) {
            needed = 2;
            code_point = first & 0x0f;
            if (first == 0xe0) lower = 0xa0;
            if (first == 0xed) upper = 0x9f;
        } else if (first >= 0xf0 && first <= 0xf4) {
            needed = 3;
            code_point = first & 0x07;
            if (first == 0xf0) lower = 0x90;
            if (first == 0xf4) upper = 0x8f;
        } else {
            characters[output++] = 0xfffd;
            input += 1;
            continue;
        }

        input += 1;
        bool failed = false;
        for (size_t seen = 0; seen < needed; seen += 1) {
            if (input >= length) {
                failed = true;
                break;
            }
            const uint8_t next = bytes[input];
            const uint8_t minimum = seen == 0 ? lower : 0x80;
            const uint8_t maximum = seen == 0 ? upper : 0xbf;
            if (next < minimum || next > maximum) {
                failed = true;
                break;
            }
            code_point = (code_point << 6) | (next & 0x3f);
            input += 1;
        }
        if (failed) {
            characters[output++] = 0xfffd;
            continue;
        }
        if (code_point <= 0xffff) {
            characters[output++] = (JSChar)code_point;
        } else {
            code_point -= 0x10000;
            characters[output++] = (JSChar)(0xd800 + (code_point >> 10));
            characters[output++] = (JSChar)(0xdc00 + (code_point & 0x3ff));
        }
    }
    return ct_crypto_hasher_chars_result(ctx, characters, output);
}

static JSValueRef ct_crypto_hasher_encoded_result(
    JSContextRef ctx,
    const uint8_t *bytes,
    size_t length,
    int encoding,
    JSValueRef *exception
) {
    switch (encoding) {
        case CT_CRYPTO_HASHER_OUTPUT_BUFFER:
            return ct_array_buffer_from_copy(ctx, (const char *)bytes, length, exception);
        case CT_CRYPTO_HASHER_OUTPUT_HEX: {
            static const char digits[] = "0123456789abcdef";
            char text[EVP_MAX_MD_SIZE * 2 + 1];
            for (size_t index = 0; index < length; index += 1) {
                text[index * 2] = digits[bytes[index] >> 4];
                text[index * 2 + 1] = digits[bytes[index] & 0x0f];
            }
            text[length * 2] = '\0';
            return ct_make_string(ctx, text);
        }
        case CT_CRYPTO_HASHER_OUTPUT_BASE64:
        case CT_CRYPTO_HASHER_OUTPUT_BASE64URL: {
#if CT_HAS_OPENSSL
            char text[4 * ((EVP_MAX_MD_SIZE + 2) / 3) + 1];
            int encoded_len = EVP_EncodeBlock((unsigned char *)text, bytes, (int)length);
            if (encoded_len < 0) {
                ct_throw_message(ctx, exception, "Digest encoding failed");
                return JSValueMakeUndefined(ctx);
            }
            size_t result_len = (size_t)encoded_len;
            if (encoding == CT_CRYPTO_HASHER_OUTPUT_BASE64URL) {
                for (size_t index = 0; index < result_len; index += 1) {
                    if (text[index] == '+') text[index] = '-';
                    else if (text[index] == '/') text[index] = '_';
                }
                while (result_len > 0 && text[result_len - 1] == '=') result_len -= 1;
            }
            text[result_len] = '\0';
            return ct_make_string(ctx, text);
#else
            ct_throw_message(ctx, exception, "Digest encoding is unavailable");
            return JSValueMakeUndefined(ctx);
#endif
        }
        case CT_CRYPTO_HASHER_OUTPUT_LATIN1:
        case CT_CRYPTO_HASHER_OUTPUT_ASCII: {
            JSChar characters[EVP_MAX_MD_SIZE];
            const uint8_t mask = encoding == CT_CRYPTO_HASHER_OUTPUT_ASCII ? 0x7f : 0xff;
            for (size_t index = 0; index < length; index += 1) {
                characters[index] = (JSChar)(bytes[index] & mask);
            }
            return ct_crypto_hasher_chars_result(ctx, characters, length);
        }
        case CT_CRYPTO_HASHER_OUTPUT_UTF8:
            return ct_crypto_hasher_utf8_result(ctx, bytes, length);
        case CT_CRYPTO_HASHER_OUTPUT_UTF16LE: {
            JSChar characters[EVP_MAX_MD_SIZE / 2];
            const size_t character_count = length / 2;
            for (size_t index = 0; index < character_count; index += 1) {
                characters[index] = (JSChar)(
                    (uint16_t)bytes[index * 2] |
                    ((uint16_t)bytes[index * 2 + 1] << 8)
                );
            }
            return ct_crypto_hasher_chars_result(ctx, characters, character_count);
        }
        default:
            ct_throw_type_error(ctx, exception, "Invalid native CryptoHasher encoding");
            return JSValueMakeUndefined(ctx);
    }
}

static JSValueRef ct_crypto_hasher_create(
    JSContextRef ctx,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argc,
    const JSValueRef argv[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argc < 1) {
        ct_throw_type_error(ctx, exception, "cryptoHasherCreate requires an algorithm");
        return JSValueMakeUndefined(ctx);
    }
    char *algorithm_name = ct_value_to_string_copy(ctx, argv[0]);
    if (algorithm_name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    const bool keyed = argc >= 2 && !JSValueIsUndefined(ctx, argv[1]);
    uint8_t *key = NULL;
    size_t key_len = 0;
    if (keyed && ct_get_bytes(ctx, argv[1], &key, &key_len) != 0) {
        free(algorithm_name);
        ct_throw_type_error(ctx, exception, "CryptoHasher key must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }

#if CT_HAS_OPENSSL
    CtCryptoHasherState *state = ct_crypto_hasher_state_create(
        algorithm_name,
        key,
        key_len,
        keyed
    );
#else
    CtCryptoHasherState *state = NULL;
#endif
    free(algorithm_name);
    if (state == NULL) return JSValueMakeNull(ctx);

    uv_once(&ct_crypto_hasher_class_once, ct_crypto_hasher_initialize_class);
    JSObjectRef token = JSObjectMake(ctx, ct_crypto_hasher_class, state);
    if (token == NULL) {
        ct_crypto_hasher_state_free(state);
        ct_throw_message(ctx, exception, "Failed to create native CryptoHasher");
        return JSValueMakeUndefined(ctx);
    }
    return token;
}

static JSValueRef ct_crypto_hasher_update(
    JSContextRef ctx,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argc,
    const JSValueRef argv[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argc < 2) {
        ct_throw_type_error(ctx, exception, "cryptoHasherUpdate requires a handle and input");
        return JSValueMakeUndefined(ctx);
    }
    CtCryptoHasherState *state = ct_crypto_hasher_from_value(ctx, argv[0]);
    uint8_t *bytes = NULL;
    size_t length = 0;
    if (state == NULL || ct_get_bytes(ctx, argv[1], &bytes, &length) != 0) {
        ct_throw_type_error(ctx, exception, "Invalid native CryptoHasher update");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    if (!ct_crypto_hasher_state_update(state, bytes, length)) {
        ct_throw_message(ctx, exception, "Digest operation failed");
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
#else
    ct_throw_message(ctx, exception, "Native incremental hashing is unavailable");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_hasher_copy(
    JSContextRef ctx,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argc,
    const JSValueRef argv[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argc < 1) {
        ct_throw_type_error(ctx, exception, "cryptoHasherCopy requires a handle");
        return JSValueMakeUndefined(ctx);
    }
    CtCryptoHasherState *state = ct_crypto_hasher_from_value(ctx, argv[0]);
#if CT_HAS_OPENSSL
    CtCryptoHasherState *copy = ct_crypto_hasher_state_copy(state);
#else
    CtCryptoHasherState *copy = NULL;
#endif
    if (copy == NULL) {
        ct_throw_message(ctx, exception, "Unable to copy native CryptoHasher");
        return JSValueMakeUndefined(ctx);
    }
    JSObjectRef token = JSObjectMake(ctx, ct_crypto_hasher_class, copy);
    if (token == NULL) {
        ct_crypto_hasher_state_free(copy);
        ct_throw_message(ctx, exception, "Failed to create native CryptoHasher copy");
        return JSValueMakeUndefined(ctx);
    }
    return token;
}

static JSValueRef ct_crypto_hasher_digest(
    JSContextRef ctx,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argc,
    const JSValueRef argv[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argc < 2) {
        ct_throw_type_error(ctx, exception, "cryptoHasherDigest requires a handle and output kind");
        return JSValueMakeUndefined(ctx);
    }
    CtCryptoHasherState *state = ct_crypto_hasher_from_value(ctx, argv[0]);
    if (state == NULL) {
        ct_throw_type_error(ctx, exception, "Invalid native CryptoHasher");
        return JSValueMakeUndefined(ctx);
    }
    JSValueRef conversion_exception = NULL;
    const int encoding = (int)JSValueToNumber(ctx, argv[1], &conversion_exception);
    if (conversion_exception != NULL) {
        if (exception != NULL) *exception = conversion_exception;
        return JSValueMakeUndefined(ctx);
    }

    uint8_t *target = NULL;
    size_t target_len = 0;
    if (encoding == CT_CRYPTO_HASHER_OUTPUT_TARGET) {
        if (
            argc < 3 ||
            ct_get_bytes(ctx, argv[2], &target, &target_len) != 0
        ) {
            ct_throw_type_error(ctx, exception, "Invalid CryptoHasher output target");
            return JSValueMakeUndefined(ctx);
        }
#if CT_HAS_OPENSSL
        if (target_len < state->output_len) {
            char message[96];
            snprintf(
                message,
                sizeof(message),
                "TypedArray must be at least %zu bytes",
                state->output_len
            );
            ct_throw_type_error(ctx, exception, message);
            return JSValueMakeUndefined(ctx);
        }
#endif
    } else if (
        encoding < CT_CRYPTO_HASHER_OUTPUT_BUFFER ||
        encoding > CT_CRYPTO_HASHER_OUTPUT_UTF16LE
    ) {
        ct_throw_type_error(ctx, exception, "Invalid native CryptoHasher encoding");
        return JSValueMakeUndefined(ctx);
    }

#if CT_HAS_OPENSSL
    uint8_t digest[EVP_MAX_MD_SIZE];
    size_t digest_len = 0;
    if (!ct_crypto_hasher_state_digest(state, digest, &digest_len)) {
        ct_throw_message(ctx, exception, "Digest operation failed");
        return JSValueMakeUndefined(ctx);
    }
    if (encoding == CT_CRYPTO_HASHER_OUTPUT_TARGET) {
        memcpy(target, digest, digest_len);
        return argv[2];
    }
    return ct_crypto_hasher_encoded_result(
        ctx,
        digest,
        digest_len,
        encoding,
        exception
    );
#else
    ct_throw_message(ctx, exception, "Native incremental hashing is unavailable");
    return JSValueMakeUndefined(ctx);
#endif
}
