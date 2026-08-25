#include "../native_capability.h"
#include <brotli/decode.h>
#include <brotli/encode.h>
#include <zlib.h>
#include <zstd.h>

typedef enum {
    CT_ZLIB_DEFLATE,
    CT_ZLIB_DEFLATE_RAW,
    CT_ZLIB_GZIP,
    CT_ZLIB_INFLATE,
    CT_ZLIB_INFLATE_RAW,
    CT_ZLIB_GUNZIP,
    CT_ZLIB_UNZIP,
    CT_ZLIB_BROTLI_COMPRESS,
    CT_ZLIB_BROTLI_DECOMPRESS,
    CT_ZLIB_ZSTD_COMPRESS,
    CT_ZLIB_ZSTD_DECOMPRESS,
} CtZlibMode;

static bool ct_zlib_mode_from_name(const char *name, CtZlibMode *mode) {
    if (strcmp(name, "deflate") == 0) {
        *mode = CT_ZLIB_DEFLATE;
        return true;
    }
    if (strcmp(name, "deflateRaw") == 0) {
        *mode = CT_ZLIB_DEFLATE_RAW;
        return true;
    }
    if (strcmp(name, "gzip") == 0) {
        *mode = CT_ZLIB_GZIP;
        return true;
    }
    if (strcmp(name, "inflate") == 0) {
        *mode = CT_ZLIB_INFLATE;
        return true;
    }
    if (strcmp(name, "inflateRaw") == 0) {
        *mode = CT_ZLIB_INFLATE_RAW;
        return true;
    }
    if (strcmp(name, "gunzip") == 0) {
        *mode = CT_ZLIB_GUNZIP;
        return true;
    }
    if (strcmp(name, "unzip") == 0) {
        *mode = CT_ZLIB_UNZIP;
        return true;
    }
    if (strcmp(name, "brotliCompress") == 0) {
        *mode = CT_ZLIB_BROTLI_COMPRESS;
        return true;
    }
    if (strcmp(name, "brotliDecompress") == 0) {
        *mode = CT_ZLIB_BROTLI_DECOMPRESS;
        return true;
    }
    if (strcmp(name, "zstdCompress") == 0) {
        *mode = CT_ZLIB_ZSTD_COMPRESS;
        return true;
    }
    if (strcmp(name, "zstdDecompress") == 0) {
        *mode = CT_ZLIB_ZSTD_DECOMPRESS;
        return true;
    }
    return false;
}

static bool ct_zlib_mode_compresses(CtZlibMode mode) {
    return mode == CT_ZLIB_DEFLATE || mode == CT_ZLIB_DEFLATE_RAW || mode == CT_ZLIB_GZIP || mode == CT_ZLIB_BROTLI_COMPRESS || mode == CT_ZLIB_ZSTD_COMPRESS;
}

static int ct_zlib_window_bits(CtZlibMode mode) {
    switch (mode) {
        case CT_ZLIB_DEFLATE:
        case CT_ZLIB_INFLATE:
            return MAX_WBITS;
        case CT_ZLIB_DEFLATE_RAW:
        case CT_ZLIB_INFLATE_RAW:
            return -MAX_WBITS;
        case CT_ZLIB_GZIP:
        case CT_ZLIB_GUNZIP:
            return MAX_WBITS + 16;
        case CT_ZLIB_UNZIP:
            return MAX_WBITS + 32;
        case CT_ZLIB_BROTLI_COMPRESS:
        case CT_ZLIB_BROTLI_DECOMPRESS:
        case CT_ZLIB_ZSTD_COMPRESS:
        case CT_ZLIB_ZSTD_DECOMPRESS:
            return MAX_WBITS;
    }
    return MAX_WBITS;
}

static bool ct_brotli_apply_encoder_params(JSContextRef ctx, BrotliEncoderState *state, JSObjectRef options, JSValueRef *exception) {
    if (options == NULL) return true;
    JSValueRef params_value = ct_get_property(ctx, options, "params", exception);
    if (exception != NULL && *exception != NULL) return false;
    if (JSValueIsUndefined(ctx, params_value) || JSValueIsNull(ctx, params_value)) return true;
    if (!JSValueIsObject(ctx, params_value)) {
        ct_throw_message(ctx, exception, "options.params must be an object");
        return false;
    }

    JSObjectRef params = (JSObjectRef)params_value;
    for (unsigned int key = 0; key <= 9; key += 1) {
        char property[16];
        snprintf(property, sizeof(property), "%u", key);
        JSValueRef value = ct_get_property(ctx, params, property, exception);
        if (exception != NULL && *exception != NULL) return false;
        if (JSValueIsUndefined(ctx, value)) continue;
        double number = ct_value_to_number(ctx, value);
        if (!isfinite(number) || number < 0 || number > UINT32_MAX || floor(number) != number ||
            BrotliEncoderSetParameter(state, (BrotliEncoderParameter)key, (uint32_t)number) == BROTLI_FALSE) {
            ct_throw_message(ctx, exception, "Setting Brotli parameter failed");
            return false;
        }
    }
    return true;
}

static JSValueRef ct_brotli_transform_sync(
    JSContextRef ctx,
    CtZlibMode mode,
    const uint8_t *input,
    size_t input_len,
    JSObjectRef options,
    JSValueRef *exception
) {
    size_t output_capacity = mode == CT_ZLIB_BROTLI_COMPRESS
        ? BrotliEncoderMaxCompressedSize(input_len)
        : input_len * 4 + 1024;
    if (output_capacity < 1024) output_capacity = 1024;

    if (mode == CT_ZLIB_BROTLI_COMPRESS) {
        BrotliEncoderState *state = BrotliEncoderCreateInstance(NULL, NULL, NULL);
        if (state == NULL) {
            ct_throw_message(ctx, exception, "Failed to initialize Brotli encoder");
            return JSValueMakeUndefined(ctx);
        }
        if (!ct_brotli_apply_encoder_params(ctx, state, options, exception)) {
            BrotliEncoderDestroyInstance(state);
            return JSValueMakeUndefined(ctx);
        }

        uint8_t *output = (uint8_t *)malloc(output_capacity);
        if (output == NULL) {
            BrotliEncoderDestroyInstance(state);
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        const uint8_t *next_in = input;
        size_t available_in = input_len;
        uint8_t *next_out = output;
        size_t available_out = output_capacity;
        while (true) {
            if (BrotliEncoderCompressStream(
                    state,
                    BROTLI_OPERATION_FINISH,
                    &available_in,
                    &next_in,
                    &available_out,
                    &next_out,
                    NULL
                ) == BROTLI_FALSE) {
                free(output);
                BrotliEncoderDestroyInstance(state);
                ct_throw_message(ctx, exception, "Brotli compression failed");
                return JSValueMakeUndefined(ctx);
            }
            if (BrotliEncoderIsFinished(state) == BROTLI_TRUE) {
                size_t output_len = (size_t)(next_out - output);
                BrotliEncoderDestroyInstance(state);
                return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, output_len, ct_array_buffer_free, NULL, exception);
            }
            if (available_out > 0) continue;
            size_t used = (size_t)(next_out - output);
            if (output_capacity > (size_t)512 * 1024 * 1024) {
                free(output);
                BrotliEncoderDestroyInstance(state);
                ct_throw_message(ctx, exception, "Brotli output is too large");
                return JSValueMakeUndefined(ctx);
            }
            size_t next_capacity = output_capacity * 2;
            uint8_t *next_output = (uint8_t *)realloc(output, next_capacity);
            if (next_output == NULL) {
                free(output);
                BrotliEncoderDestroyInstance(state);
                ct_throw_message(ctx, exception, "Out of memory");
                return JSValueMakeUndefined(ctx);
            }
            output = next_output;
            output_capacity = next_capacity;
            next_out = output + used;
            available_out = output_capacity - used;
        }
    }

    for (int attempt = 0; attempt < 12; attempt += 1) {
        uint8_t *output = (uint8_t *)malloc(output_capacity);
        if (output == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        size_t output_len = output_capacity;
        bool succeeded = BrotliDecoderDecompress(input_len, input, &output_len, output) == BROTLI_DECODER_RESULT_SUCCESS;
        if (succeeded) {
            return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, output_len, ct_array_buffer_free, NULL, exception);
        }
        free(output);
        output_capacity *= 2;
    }
    ct_throw_message(ctx, exception, mode == CT_ZLIB_BROTLI_COMPRESS ? "Brotli compression failed" : "Brotli decompression failed");
    return JSValueMakeUndefined(ctx);
}

typedef size_t (*CtZstdCompressBoundFn)(size_t src_size);
typedef size_t (*CtZstdCompressFn)(void *dst, size_t dst_capacity, const void *src, size_t src_size, int compression_level);
typedef unsigned long long (*CtZstdGetFrameContentSizeFn)(const void *src, size_t src_size);
typedef size_t (*CtZstdDecompressFn)(void *dst, size_t dst_capacity, const void *src, size_t src_size);
typedef unsigned int (*CtZstdIsErrorFn)(size_t code);
typedef const char *(*CtZstdGetErrorNameFn)(size_t code);

typedef struct {
    bool attempted;
    CtDynamicLibrary library;
    CtZstdCompressBoundFn compress_bound;
    CtZstdCompressFn compress;
    CtZstdGetFrameContentSizeFn get_frame_content_size;
    CtZstdDecompressFn decompress;
    CtZstdIsErrorFn is_error;
    CtZstdGetErrorNameFn get_error_name;
} CtZstdApi;

static CtZstdApi ct_zstd_api = {0};

#define CT_ZSTD_CONTENTSIZE_UNKNOWN ((unsigned long long)-1)
#define CT_ZSTD_CONTENTSIZE_ERROR ((unsigned long long)-2)

#if defined(_WIN32)
extern size_t ZSTD_compressBound(size_t src_size);
extern size_t ZSTD_compress(void *dst, size_t dst_capacity, const void *src, size_t src_size, int compression_level);
extern unsigned long long ZSTD_getFrameContentSize(const void *src, size_t src_size);
extern size_t ZSTD_decompress(void *dst, size_t dst_capacity, const void *src, size_t src_size);
extern unsigned int ZSTD_isError(size_t code);
extern const char *ZSTD_getErrorName(size_t code);
#endif

static bool ct_zstd_is_available(void) {
    return ct_zstd_api.compress_bound != NULL && ct_zstd_api.compress != NULL &&
        ct_zstd_api.get_frame_content_size != NULL && ct_zstd_api.decompress != NULL &&
        ct_zstd_api.is_error != NULL && ct_zstd_api.get_error_name != NULL;
}

static bool ct_zstd_load(void) {
    if (ct_zstd_api.attempted) return ct_zstd_is_available();
    ct_zstd_api.attempted = true;

#if defined(_WIN32)
    ct_zstd_api.compress_bound = ZSTD_compressBound;
    ct_zstd_api.compress = ZSTD_compress;
    ct_zstd_api.get_frame_content_size = ZSTD_getFrameContentSize;
    ct_zstd_api.decompress = ZSTD_decompress;
    ct_zstd_api.is_error = ZSTD_isError;
    ct_zstd_api.get_error_name = ZSTD_getErrorName;
    return ct_zstd_is_available();
#else
    const char *candidates[] = {
#if defined(__APPLE__)
        "libzstd.1.dylib",
        "libzstd.dylib",
        "/opt/homebrew/lib/libzstd.dylib",
        "/usr/local/lib/libzstd.dylib",
#else
        "libzstd.so.1",
        "libzstd.so",
#endif
    };
    for (size_t index = 0; index < sizeof(candidates) / sizeof(candidates[0]); index += 1) {
        void *symbol = NULL;
        if (ct_dynamic_library_open(&ct_zstd_api.library, candidates[index], NULL) != 0) continue;
        if (ct_dynamic_library_symbol(&ct_zstd_api.library, "ZSTD_compressBound", &symbol, NULL) == 0)
            ct_zstd_api.compress_bound = (CtZstdCompressBoundFn)symbol;
        if (ct_dynamic_library_symbol(&ct_zstd_api.library, "ZSTD_compress", &symbol, NULL) == 0)
            ct_zstd_api.compress = (CtZstdCompressFn)symbol;
        if (ct_dynamic_library_symbol(&ct_zstd_api.library, "ZSTD_getFrameContentSize", &symbol, NULL) == 0)
            ct_zstd_api.get_frame_content_size = (CtZstdGetFrameContentSizeFn)symbol;
        if (ct_dynamic_library_symbol(&ct_zstd_api.library, "ZSTD_decompress", &symbol, NULL) == 0)
            ct_zstd_api.decompress = (CtZstdDecompressFn)symbol;
        if (ct_dynamic_library_symbol(&ct_zstd_api.library, "ZSTD_isError", &symbol, NULL) == 0)
            ct_zstd_api.is_error = (CtZstdIsErrorFn)symbol;
        if (ct_dynamic_library_symbol(&ct_zstd_api.library, "ZSTD_getErrorName", &symbol, NULL) == 0)
            ct_zstd_api.get_error_name = (CtZstdGetErrorNameFn)symbol;
        if (ct_zstd_api.compress_bound != NULL && ct_zstd_api.compress != NULL && ct_zstd_api.get_frame_content_size != NULL &&
            ct_zstd_api.decompress != NULL && ct_zstd_api.is_error != NULL && ct_zstd_api.get_error_name != NULL) {
            return true;
        }
        ct_dynamic_library_close(&ct_zstd_api.library);
        ct_zstd_api.compress_bound = NULL;
        ct_zstd_api.compress = NULL;
        ct_zstd_api.get_frame_content_size = NULL;
        ct_zstd_api.decompress = NULL;
        ct_zstd_api.is_error = NULL;
        ct_zstd_api.get_error_name = NULL;
    }
    return false;
#endif
}

static JSValueRef ct_zstd_transform_sync(JSContextRef ctx, CtZlibMode mode, const uint8_t *input, size_t input_len, int level, JSValueRef *exception) {
    if (!ct_zstd_load()) {
        ct_throw_message(ctx, exception, "native Zstd support is unavailable");
        return JSValueMakeUndefined(ctx);
    }

    if (mode == CT_ZLIB_ZSTD_COMPRESS) {
        size_t output_capacity = ct_zstd_api.compress_bound(input_len);
        uint8_t *output = (uint8_t *)malloc(output_capacity > 0 ? output_capacity : 1);
        if (output == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        size_t output_len = ct_zstd_api.compress(output, output_capacity, input, input_len, level);
        if (ct_zstd_api.is_error(output_len)) {
            const char *message = ct_zstd_api.get_error_name(output_len);
            free(output);
            ct_throw_message(ctx, exception, message != NULL ? message : "Zstd compression failed");
            return JSValueMakeUndefined(ctx);
        }
        return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, output_len, ct_array_buffer_free, NULL, exception);
    }

    unsigned long long content_size = ct_zstd_api.get_frame_content_size(input, input_len);
    if (content_size == CT_ZSTD_CONTENTSIZE_ERROR) {
        ct_throw_message(ctx, exception, "Zstd decompression failed");
        return JSValueMakeUndefined(ctx);
    }

    size_t output_capacity = 0;
    if (content_size != CT_ZSTD_CONTENTSIZE_UNKNOWN) {
        output_capacity = (size_t)content_size;
    } else {
        output_capacity = input_len * 4 + 65536;
        if (output_capacity < 65536) output_capacity = 65536;
    }

    for (int attempt = 0; attempt < 12; attempt += 1) {
        uint8_t *output = (uint8_t *)malloc(output_capacity > 0 ? output_capacity : 1);
        if (output == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        size_t output_len = ct_zstd_api.decompress(output, output_capacity, input, input_len);
        if (!ct_zstd_api.is_error(output_len)) {
            return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, output_len, ct_array_buffer_free, NULL, exception);
        }
        const char *message = ct_zstd_api.get_error_name(output_len);
        free(output);
        if (content_size != CT_ZSTD_CONTENTSIZE_UNKNOWN) {
            ct_throw_message(ctx, exception, message != NULL ? message : "Zstd decompression failed");
            return JSValueMakeUndefined(ctx);
        }
        output_capacity *= 2;
    }

    ct_throw_message(ctx, exception, "Zstd decompression failed");
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_zlib_transform_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.zlibTransformSync(mode, data[, level]) requires mode and data");
        return JSValueMakeUndefined(ctx);
    }

    char *mode_name = ct_value_to_string_copy(ctx, argv[0]);
    if (mode_name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    CtZlibMode mode;
    if (!ct_zlib_mode_from_name(mode_name, &mode)) {
        ct_throw_message(ctx, exception, "Unsupported zlib mode");
        free(mode_name);
        return JSValueMakeUndefined(ctx);
    }
    free(mode_name);

    uint8_t *input = NULL;
    size_t input_len = 0;
    if (ct_get_bytes(ctx, argv[1], &input, &input_len) != 0) {
        ct_throw_message(ctx, exception, "zlib input must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }

    int level = Z_DEFAULT_COMPRESSION;
    int window_bits = ct_zlib_window_bits(mode);
    int mem_level = MAX_MEM_LEVEL;
    int strategy = Z_DEFAULT_STRATEGY;
    int finish_flush = Z_FINISH;
    size_t max_output_length = (size_t)-1;
    JSObjectRef options_object = NULL;
    uint8_t *dictionary = NULL;
    size_t dictionary_len = 0;
    if (argc >= 3 && !JSValueIsUndefined(ctx, argv[2]) && !JSValueIsNull(ctx, argv[2])) {
        if (JSValueIsObject(ctx, argv[2])) {
            JSObjectRef options = (JSObjectRef)argv[2];
            options_object = options;
            JSValueRef level_value = ct_get_property(ctx, options, "level", exception);
            if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
            if (!JSValueIsUndefined(ctx, level_value) && !JSValueIsNull(ctx, level_value)) level = (int)ct_value_to_number(ctx, level_value);
            JSValueRef window_bits_value = ct_get_property(ctx, options, "windowBits", exception);
            if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
            if (!JSValueIsUndefined(ctx, window_bits_value) && !JSValueIsNull(ctx, window_bits_value)) window_bits = (int)ct_value_to_number(ctx, window_bits_value);
            JSValueRef mem_level_value = ct_get_property(ctx, options, "memLevel", exception);
            if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
            if (!JSValueIsUndefined(ctx, mem_level_value) && !JSValueIsNull(ctx, mem_level_value)) mem_level = (int)ct_value_to_number(ctx, mem_level_value);
            JSValueRef strategy_value = ct_get_property(ctx, options, "strategy", exception);
            if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
            if (!JSValueIsUndefined(ctx, strategy_value) && !JSValueIsNull(ctx, strategy_value)) strategy = (int)ct_value_to_number(ctx, strategy_value);
            JSValueRef finish_flush_value = ct_get_property(ctx, options, "finishFlush", exception);
            if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
            if (!JSValueIsUndefined(ctx, finish_flush_value) && !JSValueIsNull(ctx, finish_flush_value)) finish_flush = (int)ct_value_to_number(ctx, finish_flush_value);
            JSValueRef max_output_length_value = ct_get_property(ctx, options, "maxOutputLength", exception);
            if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
            if (!JSValueIsUndefined(ctx, max_output_length_value) && !JSValueIsNull(ctx, max_output_length_value)) {
                double requested_max_output_length = ct_value_to_number(ctx, max_output_length_value);
                if (requested_max_output_length > 0 && requested_max_output_length < (double)((size_t)-1)) {
                    max_output_length = (size_t)requested_max_output_length;
                }
            }
            JSValueRef dictionary_value = ct_get_property(ctx, options, "dictionary", exception);
            if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
            if (!JSValueIsUndefined(ctx, dictionary_value) && !JSValueIsNull(ctx, dictionary_value)) {
                if (ct_get_bytes(ctx, dictionary_value, &dictionary, &dictionary_len) != 0) {
                    ct_throw_message(ctx, exception, "zlib dictionary must be an ArrayBuffer or typed array");
                    return JSValueMakeUndefined(ctx);
                }
            }
        } else {
            level = (int)ct_value_to_number(ctx, argv[2]);
        }
    }

    if (mode == CT_ZLIB_BROTLI_COMPRESS || mode == CT_ZLIB_BROTLI_DECOMPRESS) {
        return ct_brotli_transform_sync(ctx, mode, input, input_len, options_object, exception);
    }

    if (mode == CT_ZLIB_ZSTD_COMPRESS || mode == CT_ZLIB_ZSTD_DECOMPRESS) {
        return ct_zstd_transform_sync(ctx, mode, input, input_len, level == Z_DEFAULT_COMPRESSION ? 3 : level, exception);
    }

    if (level < Z_NO_COMPRESSION || level > Z_BEST_COMPRESSION) level = Z_DEFAULT_COMPRESSION;
    if (window_bits == 0) window_bits = ct_zlib_window_bits(mode);
    // Node's public zlib API always accepts a positive 8..15 windowBits. The
    // selected transform mode supplies zlib's raw/gzip wrapper modifier.
    if ((mode == CT_ZLIB_DEFLATE_RAW || mode == CT_ZLIB_INFLATE_RAW) && window_bits > 0) {
        window_bits = -window_bits;
    } else if ((mode == CT_ZLIB_GZIP || mode == CT_ZLIB_GUNZIP) && window_bits <= MAX_WBITS) {
        window_bits += 16;
    } else if (mode == CT_ZLIB_UNZIP && window_bits <= MAX_WBITS) {
        window_bits += 32;
    }
    if (mem_level < 1 || mem_level > MAX_MEM_LEVEL) mem_level = MAX_MEM_LEVEL;
    if (strategy < Z_DEFAULT_STRATEGY || strategy > Z_FIXED) strategy = Z_DEFAULT_STRATEGY;
    if (finish_flush < Z_NO_FLUSH || finish_flush > Z_TREES) finish_flush = Z_FINISH;

    const bool compressing = ct_zlib_mode_compresses(mode);
    size_t capacity = compressing ? (size_t)compressBound((uLong)input_len) + 64 : (input_len > 0 ? input_len * 3 : 65536);
    if (capacity < 65536) capacity = 65536;
    if (capacity > max_output_length) capacity = max_output_length;
    uint8_t *output = (uint8_t *)malloc(capacity);
    if (output == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    stream.next_in = input;
    stream.avail_in = (uInt)input_len;

    int status = compressing
        ? deflateInit2(&stream, level, Z_DEFLATED, window_bits, mem_level, strategy)
        : inflateInit2(&stream, window_bits);
    if (status != Z_OK) {
        free(output);
        ct_throw_message(ctx, exception, "Failed to initialize zlib stream");
        return JSValueMakeUndefined(ctx);
    }
    if (dictionary != NULL && dictionary_len > 0 && compressing) {
        status = deflateSetDictionary(&stream, dictionary, (uInt)dictionary_len);
        if (status != Z_OK) {
            free(output);
            deflateEnd(&stream);
            ct_throw_message(ctx, exception, "Failed to set zlib dictionary");
            return JSValueMakeUndefined(ctx);
        }
    }

    bool output_limit_exceeded = false;
    while (true) {
        if (stream.total_out >= capacity) {
            if (capacity >= max_output_length) {
                output_limit_exceeded = true;
                status = Z_MEM_ERROR;
                break;
            }
            if (capacity > (size_t)512 * 1024 * 1024) {
                status = Z_MEM_ERROR;
                break;
            }
            size_t next_capacity = capacity * 2;
            if (next_capacity < capacity || next_capacity > max_output_length) next_capacity = max_output_length;
            uint8_t *next_output = (uint8_t *)realloc(output, next_capacity);
            if (next_output == NULL) {
                status = Z_MEM_ERROR;
                break;
            }
            output = next_output;
            capacity = next_capacity;
        }

        const uLong previous_total_out = stream.total_out;
        const uInt previous_avail_in = stream.avail_in;
        stream.next_out = output + stream.total_out;
        stream.avail_out = (uInt)(capacity - stream.total_out);
        status = compressing ? deflate(&stream, finish_flush) : inflate(&stream, finish_flush);
        if (!compressing && status == Z_NEED_DICT && dictionary != NULL && dictionary_len > 0) {
            status = inflateSetDictionary(&stream, dictionary, (uInt)dictionary_len);
            if (status == Z_OK) continue;
        }
        if (status == Z_STREAM_END) break;
        if (finish_flush != Z_FINISH && stream.avail_in == 0 && (status == Z_OK || status == Z_BUF_ERROR)) {
            status = Z_STREAM_END;
            break;
        }
        if (status == Z_OK || status == Z_BUF_ERROR) {
            if (stream.avail_out == 0) continue;
            if (!compressing && (stream.total_out != previous_total_out || stream.avail_in != previous_avail_in)) continue;
        }
        break;
    }

    const size_t output_len = stream.total_out;
    if (compressing) {
        deflateEnd(&stream);
    } else {
        inflateEnd(&stream);
    }

    if (status != Z_STREAM_END) {
        if (output_limit_exceeded) {
            free(output);
            ct_throw_message(ctx, exception, "COTTONTAIL_ZLIB_OUTPUT_LIMIT");
            return JSValueMakeUndefined(ctx);
        }
        const char *message = stream.msg != NULL ? stream.msg : zError(status);
        free(output);
        ct_throw_message(ctx, exception, message != NULL ? message : "zlib transform failed");
        return JSValueMakeUndefined(ctx);
    }

    return ct_uint8_array_from_owned_bytes(ctx, output, output_len, exception);
}

static const struct { const char *name; JSObjectCallAsFunctionCallback callback; } bindings[] = {
    { "zlibTransformSync", ct_zlib_transform_sync },
};
#if defined(_WIN32)
__declspec(dllexport)
#else
__attribute__((visibility("default")))
#endif
int cottontail_capability_init(JSContextRef context, JSObjectRef target) {
    for (size_t i=0;i<sizeof(bindings)/sizeof(bindings[0]);i++) {
        JSClassDefinition definition=kJSClassDefinitionEmpty; definition.className=bindings[i].name; definition.callAsFunction=bindings[i].callback;
        JSClassRef cls=JSClassCreate(&definition); JSObjectRef fn=JSObjectMake(context,cls,NULL); JSClassRelease(cls);
        JSStringRef key=ct_js_string(bindings[i].name); JSValueRef error=NULL;
        JSObjectSetProperty(context,target,key,fn,kJSPropertyAttributeNone,&error); JSStringRelease(key); if(error)return -1;
    }
    return 0;
}
