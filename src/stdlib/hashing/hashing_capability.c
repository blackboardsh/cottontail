#include "../native_capability.h"
#include <stdio.h>
#if defined(_WIN32)
#define strcasecmp _stricmp
#else
#include <strings.h>
#endif

#if __has_include(<openssl/evp.h>)
#define CT_HAS_OPENSSL 1
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#if __has_include(<openssl/md4.h>)
#define CT_HAS_OPENSSL_MD4 1
#include <openssl/md4.h>
#else
#define CT_HAS_OPENSSL_MD4 0
#endif
#if __has_include(<openssl/core_names.h>)
#include <openssl/core_names.h>
#include <openssl/params.h>
#endif
#else
#define CT_HAS_OPENSSL 0
#define CT_HAS_OPENSSL_MD4 0
#endif

typedef int uv_once_t;
#define UV_ONCE_INIT 0
#define uv_once(flag, callback) do { if (*(flag) == 0) { *(flag) = 1; callback(); } } while (0)

static char *ct_duplicate_string(const char *value) {
    const size_t length = value != NULL ? strlen(value) : 0;
    char *copy = malloc(length + 1);
    if (copy == NULL) return NULL;
    if (length > 0) memcpy(copy, value, length);
    copy[length] = '\0';
    return copy;
}

#if CT_HAS_OPENSSL
static const EVP_MD *ct_crypto_fixed_digest(const char *algorithm_name) {
#if defined(OPENSSL_IS_BORINGSSL)
    if (strcasecmp(algorithm_name, "md4") == 0) return EVP_md4();
    if (strcasecmp(algorithm_name, "blake2b256") == 0) return EVP_blake2b256();
#endif
    return EVP_get_digestbyname(algorithm_name);
}

static int ct_crypto_digest_init(EVP_MD_CTX *context, const char *algorithm_name, const EVP_MD **digest_out, size_t *output_length_out) {
    const bool blake2b256 = strcasecmp(algorithm_name, "blake2b256") == 0;
#if defined(OPENSSL_IS_BORINGSSL)
    const EVP_MD *digest = blake2b256 ? EVP_blake2b256() : ct_crypto_fixed_digest(algorithm_name);
    if (digest == NULL || EVP_DigestInit_ex(context, digest, NULL) != 1) return 0;
    *digest_out = digest;
    *output_length_out = (size_t)EVP_MD_get_size(digest);
    return 1;
#else
    const EVP_MD *digest = EVP_get_digestbyname(blake2b256 ? "blake2b512" : algorithm_name);
    if (digest == NULL) return 0;
#if defined(OPENSSL_VERSION_MAJOR) && defined(OPENSSL_VERSION_MINOR) && \
    (OPENSSL_VERSION_MAJOR > 3 || (OPENSSL_VERSION_MAJOR == 3 && OPENSSL_VERSION_MINOR >= 2)) && \
    defined(OSSL_DIGEST_PARAM_SIZE)
    if (blake2b256) {
        size_t digest_size = 32;
        OSSL_PARAM params[] = {
            OSSL_PARAM_construct_size_t(OSSL_DIGEST_PARAM_SIZE, &digest_size),
            OSSL_PARAM_construct_end(),
        };
        if (EVP_DigestInit_ex2(context, digest, params) != 1) return 0;
        *digest_out = digest;
        *output_length_out = digest_size;
        return 1;
    }
#else
    if (blake2b256) return 0;
#endif
    if (EVP_DigestInit_ex(context, digest, NULL) != 1) return 0;
    *digest_out = digest;
    *output_length_out = (size_t)EVP_MD_get_size(digest);
    return 1;
#endif
}
#endif

#include "../../native_bindings/crypto_hasher_jsc.inc"

extern uint64_t ct_hash_value(int algorithm, const uint8_t *input, size_t input_len, uint64_t seed);

static JSValueRef hash_value(JSContextRef context, JSObjectRef function, JSObjectRef this_object, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)this_object;
    if (argc < 2) {
        ct_throw_message(context, exception, "hashValue requires an algorithm and input");
        return JSValueMakeUndefined(context);
    }
    uint8_t *input = NULL;
    size_t input_len = 0;
    if (ct_get_bytes(context, argv[1], &input, &input_len) != 0) {
        ct_throw_message(context, exception, "hash input must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(context);
    }
    uint64_t seed = 0;
    if (argc >= 3 && !JSValueIsUndefined(context, argv[2]) && !JSValueIsNull(context, argv[2])) {
        char *seed_text = ct_value_to_string_copy(context, argv[2]);
        if (seed_text != NULL) {
            seed = (uint64_t)strtoull(seed_text, NULL, 10);
            free(seed_text);
        }
    }
    const uint64_t result = ct_hash_value((int)ct_value_to_number(context, argv[0]), input, input_len, seed);
    char result_text[32];
    snprintf(result_text, sizeof(result_text), "%llu", (unsigned long long)result);
    return ct_make_string(context, result_text);
}

#define HASHING_BINDINGS \
    { "hashValue", hash_value }, \
    { "cryptoHasherCreate", ct_crypto_hasher_create }, \
    { "cryptoHasherUpdate", ct_crypto_hasher_update }, \
    { "cryptoHasherCopy", ct_crypto_hasher_copy }, \
    { "cryptoHasherDigest", ct_crypto_hasher_digest },
CT_CAPABILITY_EXPORT_BINDINGS(HASHING_BINDINGS)
