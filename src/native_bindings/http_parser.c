#include "http_parser.h"

#include "../compiler/src/jsc/bindings/node/http/llhttp/llhttp.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <uv.h>

enum {
    CT_HTTP_PARSER_EVENT_MESSAGE_BEGIN = 0,
    CT_HTTP_PARSER_EVENT_URL = 1,
    CT_HTTP_PARSER_EVENT_STATUS = 2,
    CT_HTTP_PARSER_EVENT_HEADER_FIELD = 3,
    CT_HTTP_PARSER_EVENT_HEADER_VALUE = 4,
    CT_HTTP_PARSER_EVENT_HEADERS_COMPLETE = 5,
    CT_HTTP_PARSER_EVENT_BODY = 6,
    CT_HTTP_PARSER_EVENT_MESSAGE_COMPLETE = 7,
};

enum {
    CT_HTTP_PARSER_LENIENT_HEADERS = 1 << 0,
    CT_HTTP_PARSER_LENIENT_CHUNKED_LENGTH = 1 << 1,
    CT_HTTP_PARSER_LENIENT_KEEP_ALIVE = 1 << 2,
    CT_HTTP_PARSER_LENIENT_TRANSFER_ENCODING = 1 << 3,
    CT_HTTP_PARSER_LENIENT_VERSION = 1 << 4,
    CT_HTTP_PARSER_LENIENT_DATA_AFTER_CLOSE = 1 << 5,
    CT_HTTP_PARSER_LENIENT_OPTIONAL_LF_AFTER_CR = 1 << 6,
    CT_HTTP_PARSER_LENIENT_OPTIONAL_CRLF_AFTER_CHUNK = 1 << 7,
    CT_HTTP_PARSER_LENIENT_OPTIONAL_CR_BEFORE_LF = 1 << 8,
    CT_HTTP_PARSER_LENIENT_SPACES_AFTER_CHUNK_SIZE = 1 << 9,
};

#define CT_HTTP_PARSER_MAX_CHUNK_EXTENSIONS_SIZE (16U * 1024U)

typedef struct CtNativeHttpParser {
    llhttp_t parser;
    JSContextRef context;
    JSObjectRef dispatcher;
    JSValueRef callback_exception;
    const char *current_data;
    size_t current_length;
    size_t tracked_offset;
    uint64_t header_bytes;
    uint64_t max_header_size;
    uint64_t chunk_extension_bytes;
    bool initialized;
    bool executing;
    bool pause_requested;
    bool destroy_pending;
    bool headers_completed;
} CtNativeHttpParser;

static JSClassRef ct_http_parser_class = NULL;
static uv_once_t ct_http_parser_class_once = UV_ONCE_INIT;

static void ct_http_parser_free(CtNativeHttpParser *parser) {
    free(parser);
}

static void ct_http_parser_finalize(JSObjectRef object) {
    CtNativeHttpParser *parser = (CtNativeHttpParser *)JSObjectGetPrivate(object);
    if (parser != NULL) ct_http_parser_free(parser);
}

static void ct_http_parser_initialize_class(void) {
    JSClassDefinition definition = kJSClassDefinitionEmpty;
    definition.className = "CottontailHTTPParser";
    definition.finalize = ct_http_parser_finalize;
    ct_http_parser_class = JSClassCreate(&definition);
}

static JSValueRef ct_http_parser_make_error(
    JSContextRef context,
    const char *message,
    JSValueRef *exception
) {
    JSStringRef text = JSStringCreateWithUTF8CString(message);
    JSValueRef argument = JSValueMakeString(context, text);
    JSStringRelease(text);
    return JSObjectMakeError(context, 1, &argument, exception);
}

static void ct_http_parser_throw(
    JSContextRef context,
    JSValueRef *exception,
    const char *message
) {
    if (exception == NULL) return;
    JSValueRef construction_exception = NULL;
    JSValueRef error = ct_http_parser_make_error(context, message, &construction_exception);
    *exception = construction_exception != NULL ? construction_exception : error;
}

static void ct_http_parser_set_property(
    JSContextRef context,
    JSObjectRef object,
    const char *name,
    JSValueRef value,
    JSValueRef *exception
) {
    JSStringRef property = JSStringCreateWithUTF8CString(name);
    JSObjectSetProperty(context, object, property, value, kJSPropertyAttributeNone, exception);
    JSStringRelease(property);
}

static JSValueRef ct_http_parser_latin1_string(
    JSContextRef context,
    const char *bytes,
    size_t length
) {
    if (length == 0) {
        JSStringRef empty = JSStringCreateWithUTF8CString("");
        JSValueRef result = JSValueMakeString(context, empty);
        JSStringRelease(empty);
        return result;
    }
    if (length > SIZE_MAX / sizeof(JSChar)) return JSValueMakeUndefined(context);

    JSChar *characters = (JSChar *)malloc(length * sizeof(JSChar));
    if (characters == NULL) return JSValueMakeUndefined(context);
    for (size_t index = 0; index < length; index += 1) {
        characters[index] = (JSChar)(uint8_t)bytes[index];
    }
    JSStringRef string = JSStringCreateWithCharacters(characters, length);
    free(characters);
    JSValueRef result = JSValueMakeString(context, string);
    JSStringRelease(string);
    return result;
}

static void ct_http_parser_array_buffer_free(void *bytes, void *context) {
    (void)context;
    free(bytes);
}

static JSValueRef ct_http_parser_copy_array_buffer(
    JSContextRef context,
    const char *bytes,
    size_t length,
    JSValueRef *exception
) {
    void *copy = malloc(length > 0 ? length : 1);
    if (copy == NULL) {
        ct_http_parser_throw(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    if (length > 0) memcpy(copy, bytes, length);
    JSObjectRef result = JSObjectMakeArrayBufferWithBytesNoCopy(
        context,
        copy,
        length,
        ct_http_parser_array_buffer_free,
        NULL,
        exception
    );
    if (result == NULL) free(copy);
    return result != NULL ? result : JSValueMakeUndefined(context);
}

static bool ct_http_parser_span_offset(
    const char *input,
    size_t input_length,
    const char *bytes,
    size_t length,
    size_t *end_offset
) {
    if (input == NULL || bytes == NULL) return false;
    uintptr_t input_address = (uintptr_t)input;
    uintptr_t bytes_address = (uintptr_t)bytes;
    if (bytes_address < input_address) return false;
    uintptr_t raw_offset = bytes_address - input_address;
    if (raw_offset > input_length) return false;
    size_t offset = (size_t)raw_offset;
    if (length > input_length - offset) return false;
    if (end_offset != NULL) *end_offset = offset + length;
    return true;
}

static void ct_http_parser_capture_callback_exception(
    CtNativeHttpParser *parser,
    JSValueRef exception
) {
    parser->callback_exception = exception;
    JSValueProtect(parser->context, exception);
    llhttp_set_error_reason(&parser->parser, "HPE_USER:JS Exception");
}

static int ct_http_parser_dispatch(
    CtNativeHttpParser *parser,
    size_t argument_count,
    const JSValueRef arguments[],
    int *integer_result
) {
    if (parser->context == NULL || parser->dispatcher == NULL) return HPE_USER;

    JSValueRef callback_exception = NULL;
    JSValueRef result = JSObjectCallAsFunction(
        parser->context,
        parser->dispatcher,
        NULL,
        argument_count,
        arguments,
        &callback_exception
    );
    if (callback_exception != NULL) {
        ct_http_parser_capture_callback_exception(parser, callback_exception);
        return HPE_USER;
    }

    if (integer_result != NULL) {
        double value = JSValueToNumber(parser->context, result, &callback_exception);
        if (callback_exception != NULL) {
            ct_http_parser_capture_callback_exception(parser, callback_exception);
            return HPE_USER;
        }
        *integer_result = (int32_t)value;
    }

    if (parser->pause_requested) return HPE_PAUSED;
    return HPE_OK;
}

static int ct_http_parser_dispatch_simple(CtNativeHttpParser *parser, int event) {
    JSValueRef arguments[] = {
        JSValueMakeNumber(parser->context, event),
    };
    return ct_http_parser_dispatch(parser, 1, arguments, NULL);
}

static int ct_http_parser_dispatch_string(
    CtNativeHttpParser *parser,
    int event,
    const char *bytes,
    size_t length
) {
    JSValueRef value = ct_http_parser_latin1_string(parser->context, bytes, length);
    if (JSValueIsUndefined(parser->context, value) && length > 0) {
        parser->callback_exception = ct_http_parser_make_error(
            parser->context,
            "Out of memory",
            NULL
        );
        JSValueProtect(parser->context, parser->callback_exception);
        llhttp_set_error_reason(&parser->parser, "HPE_USER:JS Exception");
        return HPE_USER;
    }
    JSValueRef arguments[] = {
        JSValueMakeNumber(parser->context, event),
        value,
    };
    return ct_http_parser_dispatch(parser, 2, arguments, NULL);
}

static int ct_http_parser_dispatch_body(
    CtNativeHttpParser *parser,
    const char *bytes,
    size_t length
) {
    if (length == 0) return HPE_OK;
    JSValueRef buffer_exception = NULL;
    JSValueRef buffer = ct_http_parser_copy_array_buffer(
        parser->context,
        bytes,
        length,
        &buffer_exception
    );
    if (buffer_exception != NULL) {
        ct_http_parser_capture_callback_exception(parser, buffer_exception);
        return HPE_USER;
    }
    JSValueRef arguments[] = {
        JSValueMakeNumber(parser->context, CT_HTTP_PARSER_EVENT_BODY),
        buffer,
    };
    return ct_http_parser_dispatch(parser, 2, arguments, NULL);
}

static int ct_http_parser_track_span(
    CtNativeHttpParser *parser,
    const char *bytes,
    size_t length
) {
    size_t amount = length;
    size_t end = 0;
    if (ct_http_parser_span_offset(
        parser->current_data,
        parser->current_length,
        bytes,
        length,
        &end
    )) {
        if (end > parser->tracked_offset) {
            amount = end - parser->tracked_offset;
            parser->tracked_offset = end;
        } else {
            amount = 0;
        }
    }

    parser->header_bytes += amount;
    if (parser->max_header_size > 0 && parser->header_bytes >= parser->max_header_size) {
        llhttp_set_error_reason(&parser->parser, "HPE_HEADER_OVERFLOW:Header overflow");
        return HPE_USER;
    }
    return HPE_OK;
}

static int ct_http_parser_on_message_begin(llhttp_t *llhttp) {
    CtNativeHttpParser *parser = (CtNativeHttpParser *)llhttp->data;
    parser->header_bytes = 0;
    parser->chunk_extension_bytes = 0;
    parser->headers_completed = false;
    return ct_http_parser_dispatch_simple(parser, CT_HTTP_PARSER_EVENT_MESSAGE_BEGIN);
}

static int ct_http_parser_on_url(llhttp_t *llhttp, const char *bytes, size_t length) {
    CtNativeHttpParser *parser = (CtNativeHttpParser *)llhttp->data;
    int result = ct_http_parser_track_span(parser, bytes, length);
    if (result != HPE_OK) return result;
    return ct_http_parser_dispatch_string(parser, CT_HTTP_PARSER_EVENT_URL, bytes, length);
}

static int ct_http_parser_on_status(llhttp_t *llhttp, const char *bytes, size_t length) {
    CtNativeHttpParser *parser = (CtNativeHttpParser *)llhttp->data;
    int result = ct_http_parser_track_span(parser, bytes, length);
    if (result != HPE_OK) return result;
    return ct_http_parser_dispatch_string(parser, CT_HTTP_PARSER_EVENT_STATUS, bytes, length);
}

static int ct_http_parser_on_header_field(llhttp_t *llhttp, const char *bytes, size_t length) {
    CtNativeHttpParser *parser = (CtNativeHttpParser *)llhttp->data;
    int result = ct_http_parser_track_span(parser, bytes, length);
    if (result != HPE_OK) return result;
    return ct_http_parser_dispatch_string(parser, CT_HTTP_PARSER_EVENT_HEADER_FIELD, bytes, length);
}

static int ct_http_parser_on_header_value(llhttp_t *llhttp, const char *bytes, size_t length) {
    CtNativeHttpParser *parser = (CtNativeHttpParser *)llhttp->data;
    int result = ct_http_parser_track_span(parser, bytes, length);
    if (result != HPE_OK) return result;
    return ct_http_parser_dispatch_string(parser, CT_HTTP_PARSER_EVENT_HEADER_VALUE, bytes, length);
}

static int ct_http_parser_on_chunk_extension(
    llhttp_t *llhttp,
    const char *bytes,
    size_t length
) {
    (void)bytes;
    CtNativeHttpParser *parser = (CtNativeHttpParser *)llhttp->data;
    parser->chunk_extension_bytes += length;
    if (parser->chunk_extension_bytes > CT_HTTP_PARSER_MAX_CHUNK_EXTENSIONS_SIZE) {
        llhttp_set_error_reason(
            &parser->parser,
            "HPE_CHUNK_EXTENSIONS_OVERFLOW:Chunk extensions overflow"
        );
        return HPE_USER;
    }
    return HPE_OK;
}

static int ct_http_parser_on_headers_complete(llhttp_t *llhttp) {
    CtNativeHttpParser *parser = (CtNativeHttpParser *)llhttp->data;
    parser->headers_completed = true;
    parser->header_bytes = 0;

    JSValueRef arguments[] = {
        JSValueMakeNumber(parser->context, CT_HTTP_PARSER_EVENT_HEADERS_COMPLETE),
        JSValueMakeNumber(parser->context, llhttp->type),
        JSValueMakeNumber(parser->context, llhttp->http_major),
        JSValueMakeNumber(parser->context, llhttp->http_minor),
        JSValueMakeNumber(parser->context, llhttp->method),
        JSValueMakeNumber(parser->context, llhttp->status_code),
        JSValueMakeBoolean(parser->context, llhttp->upgrade != 0),
        JSValueMakeBoolean(parser->context, llhttp_should_keep_alive(llhttp) != 0),
    };
    int callback_result = 0;
    int result = ct_http_parser_dispatch(parser, 8, arguments, &callback_result);
    if (result != HPE_OK) return result;
    if (callback_result < 0 || callback_result > 2) {
        llhttp_set_error_reason(&parser->parser, "HPE_USER:User callback error");
        return HPE_USER;
    }
    return callback_result;
}

static int ct_http_parser_on_body(llhttp_t *llhttp, const char *bytes, size_t length) {
    CtNativeHttpParser *parser = (CtNativeHttpParser *)llhttp->data;
    size_t end = 0;
    if (ct_http_parser_span_offset(
        parser->current_data,
        parser->current_length,
        bytes,
        length,
        &end
    )) {
        parser->tracked_offset = end;
    }
    return ct_http_parser_dispatch_body(parser, bytes, length);
}

static int ct_http_parser_on_message_complete(llhttp_t *llhttp) {
    CtNativeHttpParser *parser = (CtNativeHttpParser *)llhttp->data;
    return ct_http_parser_dispatch_simple(parser, CT_HTTP_PARSER_EVENT_MESSAGE_COMPLETE);
}

static int ct_http_parser_on_chunk_header(llhttp_t *llhttp) {
    CtNativeHttpParser *parser = (CtNativeHttpParser *)llhttp->data;
    parser->header_bytes = 0;
    parser->chunk_extension_bytes = 0;
    return parser->pause_requested ? HPE_PAUSED : HPE_OK;
}

static int ct_http_parser_on_chunk_complete(llhttp_t *llhttp) {
    CtNativeHttpParser *parser = (CtNativeHttpParser *)llhttp->data;
    parser->header_bytes = 0;
    return parser->pause_requested ? HPE_PAUSED : HPE_OK;
}

static const llhttp_settings_t ct_http_parser_settings = {
    .on_message_begin = ct_http_parser_on_message_begin,
    .on_url = ct_http_parser_on_url,
    .on_status = ct_http_parser_on_status,
    .on_header_field = ct_http_parser_on_header_field,
    .on_header_value = ct_http_parser_on_header_value,
    .on_chunk_extension_name = ct_http_parser_on_chunk_extension,
    .on_chunk_extension_value = ct_http_parser_on_chunk_extension,
    .on_headers_complete = ct_http_parser_on_headers_complete,
    .on_body = ct_http_parser_on_body,
    .on_message_complete = ct_http_parser_on_message_complete,
    .on_chunk_header = ct_http_parser_on_chunk_header,
    .on_chunk_complete = ct_http_parser_on_chunk_complete,
};

static CtNativeHttpParser *ct_http_parser_from_value(
    JSContextRef context,
    JSValueRef value
) {
    uv_once(&ct_http_parser_class_once, ct_http_parser_initialize_class);
    if (
        value == NULL ||
        !JSValueIsObject(context, value) ||
        !JSValueIsObjectOfClass(context, value, ct_http_parser_class)
    ) {
        return NULL;
    }
    return (CtNativeHttpParser *)JSObjectGetPrivate((JSObjectRef)value);
}

static int ct_http_parser_get_bytes(
    JSContextRef context,
    JSValueRef value,
    const char **data,
    size_t *length
) {
    *data = NULL;
    *length = 0;
    if (!JSValueIsObject(context, value)) return -1;

    JSValueRef exception = NULL;
    JSObjectRef object = (JSObjectRef)value;
    JSTypedArrayType type = JSValueGetTypedArrayType(context, value, &exception);
    if (exception != NULL) return -1;
    if (type == kJSTypedArrayTypeArrayBuffer) {
        *data = (const char *)JSObjectGetArrayBufferBytesPtr(context, object, &exception);
        *length = JSObjectGetArrayBufferByteLength(context, object, &exception);
        return exception == NULL && (*data != NULL || *length == 0) ? 0 : -1;
    }
    if (type == kJSTypedArrayTypeNone) return -1;

    size_t offset = JSObjectGetTypedArrayByteOffset(context, object, &exception);
    size_t byte_length = JSObjectGetTypedArrayByteLength(context, object, &exception);
    JSObjectRef buffer = JSObjectGetTypedArrayBuffer(context, object, &exception);
    if (exception != NULL || buffer == NULL) return -1;
    const char *base = (const char *)JSObjectGetArrayBufferBytesPtr(context, buffer, &exception);
    if (exception != NULL || (base == NULL && byte_length > 0)) return -1;
    *data = base != NULL ? base + offset : NULL;
    *length = byte_length;
    return 0;
}

static void ct_http_parser_apply_leniency(CtNativeHttpParser *parser, uint32_t flags) {
    if (flags & CT_HTTP_PARSER_LENIENT_HEADERS) {
        llhttp_set_lenient_headers(&parser->parser, 1);
    }
    if (flags & CT_HTTP_PARSER_LENIENT_CHUNKED_LENGTH) {
        llhttp_set_lenient_chunked_length(&parser->parser, 1);
    }
    if (flags & CT_HTTP_PARSER_LENIENT_KEEP_ALIVE) {
        llhttp_set_lenient_keep_alive(&parser->parser, 1);
    }
    if (flags & CT_HTTP_PARSER_LENIENT_TRANSFER_ENCODING) {
        llhttp_set_lenient_transfer_encoding(&parser->parser, 1);
    }
    if (flags & CT_HTTP_PARSER_LENIENT_VERSION) {
        llhttp_set_lenient_version(&parser->parser, 1);
    }
    if (flags & CT_HTTP_PARSER_LENIENT_DATA_AFTER_CLOSE) {
        llhttp_set_lenient_data_after_close(&parser->parser, 1);
    }
    if (flags & CT_HTTP_PARSER_LENIENT_OPTIONAL_LF_AFTER_CR) {
        llhttp_set_lenient_optional_lf_after_cr(&parser->parser, 1);
    }
    if (flags & CT_HTTP_PARSER_LENIENT_OPTIONAL_CRLF_AFTER_CHUNK) {
        llhttp_set_lenient_optional_crlf_after_chunk(&parser->parser, 1);
    }
    if (flags & CT_HTTP_PARSER_LENIENT_OPTIONAL_CR_BEFORE_LF) {
        llhttp_set_lenient_optional_cr_before_lf(&parser->parser, 1);
    }
    if (flags & CT_HTTP_PARSER_LENIENT_SPACES_AFTER_CHUNK_SIZE) {
        llhttp_set_lenient_spaces_after_chunk_size(&parser->parser, 1);
    }
}

static JSValueRef ct_http_parser_parse_result(
    JSContextRef context,
    CtNativeHttpParser *parser,
    const char *data,
    size_t length,
    llhttp_errno_t error,
    JSValueRef *exception
) {
    size_t bytes_parsed = length;
    if (error != HPE_OK && data != NULL) {
        const char *position = llhttp_get_error_pos(&parser->parser);
        size_t offset = 0;
        if (ct_http_parser_span_offset(data, length, position, 0, &offset)) {
            bytes_parsed = offset;
        }
    }

    if (parser->callback_exception != NULL) {
        JSValueRef callback_exception = parser->callback_exception;
        parser->callback_exception = NULL;
        if (exception != NULL) *exception = callback_exception;
        JSValueUnprotect(context, callback_exception);
        return JSValueMakeUndefined(context);
    }

    if (
        error == HPE_OK ||
        error == HPE_PAUSED ||
        error == HPE_PAUSED_UPGRADE ||
        error == HPE_PAUSED_H2_UPGRADE
    ) {
        if (error == HPE_PAUSED_UPGRADE || error == HPE_PAUSED_H2_UPGRADE) {
            llhttp_resume_after_upgrade(&parser->parser);
        }
        return JSValueMakeNumber(context, (double)bytes_parsed);
    }

    const char *code = llhttp_errno_name(error);
    const char *reason = llhttp_get_error_reason(&parser->parser);
    char code_buffer[96];
    if (error == HPE_USER && reason != NULL) {
        const char *separator = strchr(reason, ':');
        if (separator != NULL) {
            size_t code_length = (size_t)(separator - reason);
            if (code_length >= sizeof(code_buffer)) code_length = sizeof(code_buffer) - 1;
            memcpy(code_buffer, reason, code_length);
            code_buffer[code_length] = '\0';
            code = code_buffer;
            reason = separator + 1;
        }
    }
    const char *error_code = code != NULL ? code : "HPE_UNKNOWN";
    const char *error_reason = reason != NULL ? reason : "Parse error";

    JSObjectRef descriptor = JSObjectMake(context, NULL, NULL);
    ct_http_parser_set_property(
        context,
        descriptor,
        "bytesParsed",
        JSValueMakeNumber(context, (double)bytes_parsed),
        exception
    );
    ct_http_parser_set_property(
        context,
        descriptor,
        "code",
        ct_http_parser_latin1_string(context, error_code, strlen(error_code)),
        exception
    );
    ct_http_parser_set_property(
        context,
        descriptor,
        "reason",
        ct_http_parser_latin1_string(context, error_reason, strlen(error_reason)),
        exception
    );
    return descriptor;
}

static JSValueRef ct_http_parser_run(
    JSContextRef context,
    CtNativeHttpParser *parser,
    const char *data,
    size_t length,
    JSObjectRef dispatcher,
    bool finish,
    JSValueRef *exception
) {
    static const char empty_input = '\0';
    parser->context = context;
    parser->dispatcher = dispatcher;
    parser->callback_exception = NULL;
    parser->current_data = data != NULL ? data : &empty_input;
    parser->current_length = length;
    parser->tracked_offset = 0;
    parser->executing = true;

    llhttp_errno_t error = finish
        ? llhttp_finish(&parser->parser)
        : llhttp_execute(&parser->parser, parser->current_data, length);

    if (
        !parser->headers_completed &&
        parser->tracked_offset < length &&
        error == HPE_OK
    ) {
        parser->header_bytes += length - parser->tracked_offset;
        if (
            parser->max_header_size > 0 &&
            parser->header_bytes >= parser->max_header_size
        ) {
            llhttp_set_error_reason(&parser->parser, "HPE_HEADER_OVERFLOW:Header overflow");
            error = HPE_USER;
        }
    }

    parser->executing = false;
    parser->context = NULL;
    parser->dispatcher = NULL;
    parser->current_data = NULL;
    parser->current_length = 0;
    JSValueRef result = ct_http_parser_parse_result(
        context,
        parser,
        finish ? NULL : data,
        length,
        error,
        exception
    );
    if (parser->destroy_pending) ct_http_parser_free(parser);
    return result;
}

JSValueRef ct_http_parser_create(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    (void)argument_count;
    (void)arguments;

    uv_once(&ct_http_parser_class_once, ct_http_parser_initialize_class);
    CtNativeHttpParser *parser = (CtNativeHttpParser *)calloc(1, sizeof(*parser));
    if (parser == NULL) {
        ct_http_parser_throw(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    JSObjectRef token = JSObjectMake(context, ct_http_parser_class, parser);
    if (token == NULL) {
        ct_http_parser_free(parser);
        ct_http_parser_throw(context, exception, "Failed to create native HTTP parser");
        return JSValueMakeUndefined(context);
    }
    return token;
}

JSValueRef ct_http_parser_initialize(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 4) {
        ct_http_parser_throw(
            context,
            exception,
            "httpParserInitialize(parser, type, maxHeaderSize, lenientFlags) requires four arguments"
        );
        return JSValueMakeUndefined(context);
    }
    CtNativeHttpParser *parser = ct_http_parser_from_value(context, arguments[0]);
    if (parser == NULL) {
        ct_http_parser_throw(context, exception, "Invalid native HTTP parser");
        return JSValueMakeUndefined(context);
    }

    JSValueRef conversion_exception = NULL;
    int type = (int)JSValueToNumber(context, arguments[1], &conversion_exception);
    double max_header_size = JSValueToNumber(context, arguments[2], &conversion_exception);
    uint32_t lenient_flags = (uint32_t)JSValueToNumber(
        context,
        arguments[3],
        &conversion_exception
    );
    if (conversion_exception != NULL) {
        if (exception != NULL) *exception = conversion_exception;
        return JSValueMakeUndefined(context);
    }
    if (type < HTTP_BOTH || type > HTTP_RESPONSE) {
        ct_http_parser_throw(context, exception, "Invalid HTTP parser type");
        return JSValueMakeUndefined(context);
    }

    llhttp_init(&parser->parser, (llhttp_type_t)type, &ct_http_parser_settings);
    parser->parser.data = parser;
    parser->max_header_size = max_header_size > 0 ? (uint64_t)max_header_size : 0;
    parser->header_bytes = 0;
    parser->chunk_extension_bytes = 0;
    parser->headers_completed = false;
    parser->pause_requested = false;
    parser->destroy_pending = false;
    parser->initialized = true;
    ct_http_parser_apply_leniency(parser, lenient_flags);
    return JSValueMakeUndefined(context);
}

JSValueRef ct_http_parser_execute(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 3) {
        ct_http_parser_throw(
            context,
            exception,
            "httpParserExecute(parser, input, dispatch) requires three arguments"
        );
        return JSValueMakeUndefined(context);
    }
    CtNativeHttpParser *parser = ct_http_parser_from_value(context, arguments[0]);
    if (
        parser == NULL ||
        !parser->initialized ||
        !JSValueIsObject(context, arguments[2]) ||
        !JSObjectIsFunction(context, (JSObjectRef)arguments[2])
    ) {
        ct_http_parser_throw(context, exception, "Invalid native HTTP parser execution");
        return JSValueMakeUndefined(context);
    }
    const char *data = NULL;
    size_t length = 0;
    if (ct_http_parser_get_bytes(context, arguments[1], &data, &length) != 0) {
        ct_http_parser_throw(context, exception, "HTTP parser input must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(context);
    }
    return ct_http_parser_run(
        context,
        parser,
        data,
        length,
        (JSObjectRef)arguments[2],
        false,
        exception
    );
}

JSValueRef ct_http_parser_finish(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 2) {
        ct_http_parser_throw(
            context,
            exception,
            "httpParserFinish(parser, dispatch) requires two arguments"
        );
        return JSValueMakeUndefined(context);
    }
    CtNativeHttpParser *parser = ct_http_parser_from_value(context, arguments[0]);
    if (
        parser == NULL ||
        !parser->initialized ||
        !JSValueIsObject(context, arguments[1]) ||
        !JSObjectIsFunction(context, (JSObjectRef)arguments[1])
    ) {
        ct_http_parser_throw(context, exception, "Invalid native HTTP parser finish");
        return JSValueMakeUndefined(context);
    }
    return ct_http_parser_run(
        context,
        parser,
        NULL,
        0,
        (JSObjectRef)arguments[1],
        true,
        exception
    );
}

JSValueRef ct_http_parser_pause(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) return JSValueMakeUndefined(context);
    CtNativeHttpParser *parser = ct_http_parser_from_value(context, arguments[0]);
    if (parser == NULL || !parser->initialized) return JSValueMakeUndefined(context);
    parser->pause_requested = true;
    if (!parser->executing) llhttp_pause(&parser->parser);
    (void)exception;
    return JSValueMakeUndefined(context);
}

JSValueRef ct_http_parser_resume(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) return JSValueMakeUndefined(context);
    CtNativeHttpParser *parser = ct_http_parser_from_value(context, arguments[0]);
    if (parser == NULL || !parser->initialized) return JSValueMakeUndefined(context);
    parser->pause_requested = false;
    if (llhttp_get_errno(&parser->parser) == HPE_PAUSED) llhttp_resume(&parser->parser);
    (void)exception;
    return JSValueMakeUndefined(context);
}

JSValueRef ct_http_parser_destroy(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    (void)exception;
    if (argument_count < 1 || !JSValueIsObject(context, arguments[0])) {
        return JSValueMakeUndefined(context);
    }
    JSObjectRef token = (JSObjectRef)arguments[0];
    CtNativeHttpParser *parser = ct_http_parser_from_value(context, arguments[0]);
    if (parser == NULL) return JSValueMakeUndefined(context);
    JSObjectSetPrivate(token, NULL);
    if (parser->executing) {
        parser->destroy_pending = true;
        parser->pause_requested = true;
    } else {
        ct_http_parser_free(parser);
    }
    return JSValueMakeUndefined(context);
}
