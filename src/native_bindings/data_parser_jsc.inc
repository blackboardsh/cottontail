#include "data_parser.h"

enum {
    CT_DATA_PARSER_ERROR_SYNTAX = 1,
    CT_DATA_PARSER_ERROR_RANGE = 2,
};

typedef struct {
    JSContextRef context;
    JSValueRef *exception;
    JSValueRef *protected_values;
    size_t protected_count;
    size_t protected_capacity;
    char *error_message;
    int error_kind;
} CtDataParserBuilder;

static bool ct_data_parser_builder_failed(const CtDataParserBuilder *builder) {
    return builder == NULL ||
        (builder->exception != NULL && *builder->exception != NULL);
}

static bool ct_data_parser_builder_protect(
    CtDataParserBuilder *builder,
    JSValueRef value
) {
    if (ct_data_parser_builder_failed(builder) || value == NULL) return false;
    if (builder->protected_count == builder->protected_capacity) {
        size_t next_capacity = builder->protected_capacity == 0
            ? 16
            : builder->protected_capacity * 2;
        if (next_capacity < builder->protected_capacity ||
            next_capacity > SIZE_MAX / sizeof(*builder->protected_values)) {
            return false;
        }
        JSValueRef *next = (JSValueRef *)realloc(
            builder->protected_values,
            next_capacity * sizeof(*next)
        );
        if (next == NULL) return false;
        builder->protected_values = next;
        builder->protected_capacity = next_capacity;
    }
    JSValueProtect(builder->context, value);
    builder->protected_values[builder->protected_count++] = value;
    return true;
}

static void ct_data_parser_builder_deinit(CtDataParserBuilder *builder) {
    if (builder == NULL) return;
    for (size_t index = 0; index < builder->protected_count; index += 1) {
        JSValueUnprotect(builder->context, builder->protected_values[index]);
    }
    free(builder->protected_values);
    free(builder->error_message);
    builder->protected_values = NULL;
    builder->protected_count = 0;
    builder->protected_capacity = 0;
    builder->error_message = NULL;
}

uintptr_t ct_data_parser_builder_make_null(void *opaque_builder) {
    CtDataParserBuilder *builder = (CtDataParserBuilder *)opaque_builder;
    return ct_data_parser_builder_failed(builder)
        ? 0
        : (uintptr_t)JSValueMakeNull(builder->context);
}

uintptr_t ct_data_parser_builder_make_undefined(void *opaque_builder) {
    CtDataParserBuilder *builder = (CtDataParserBuilder *)opaque_builder;
    return ct_data_parser_builder_failed(builder)
        ? 0
        : (uintptr_t)JSValueMakeUndefined(builder->context);
}

uintptr_t ct_data_parser_builder_make_boolean(void *opaque_builder, bool value) {
    CtDataParserBuilder *builder = (CtDataParserBuilder *)opaque_builder;
    return ct_data_parser_builder_failed(builder)
        ? 0
        : (uintptr_t)JSValueMakeBoolean(builder->context, value);
}

uintptr_t ct_data_parser_builder_make_number(void *opaque_builder, double value) {
    CtDataParserBuilder *builder = (CtDataParserBuilder *)opaque_builder;
    return ct_data_parser_builder_failed(builder)
        ? 0
        : (uintptr_t)JSValueMakeNumber(builder->context, value);
}

uintptr_t ct_data_parser_builder_make_string(
    void *opaque_builder,
    const uint8_t *value,
    size_t len
) {
    CtDataParserBuilder *builder = (CtDataParserBuilder *)opaque_builder;
    if (ct_data_parser_builder_failed(builder) || (len > 0 && value == NULL)) return 0;
    JSValueRef result = ct_make_string_len(
        builder->context,
        (const char *)value,
        len
    );
    if (result == NULL || !ct_data_parser_builder_protect(builder, result)) return 0;
    return (uintptr_t)result;
}

uintptr_t ct_data_parser_builder_make_array(void *opaque_builder, size_t len) {
    CtDataParserBuilder *builder = (CtDataParserBuilder *)opaque_builder;
    if (ct_data_parser_builder_failed(builder) || len > UINT32_MAX) return 0;

    JSObjectRef result = ct_make_array(
        builder->context,
        0,
        NULL,
        builder->exception
    );
    if (result == NULL || ct_data_parser_builder_failed(builder)) return 0;
    if (len > 0) {
        JSObjectSetPropertyAtIndex(
            builder->context,
            result,
            (unsigned)(len - 1),
            JSValueMakeUndefined(builder->context),
            builder->exception
        );
        if (ct_data_parser_builder_failed(builder)) return 0;
    }
    if (!ct_data_parser_builder_protect(builder, result)) return 0;
    return (uintptr_t)result;
}

uintptr_t ct_data_parser_builder_make_object(void *opaque_builder) {
    CtDataParserBuilder *builder = (CtDataParserBuilder *)opaque_builder;
    if (ct_data_parser_builder_failed(builder)) return 0;
    JSObjectRef result = ct_make_object(builder->context);
    if (result == NULL || !ct_data_parser_builder_protect(builder, result)) return 0;
    return (uintptr_t)result;
}

bool ct_data_parser_builder_set_index(
    void *opaque_builder,
    uintptr_t raw_array,
    size_t index,
    uintptr_t raw_value
) {
    CtDataParserBuilder *builder = (CtDataParserBuilder *)opaque_builder;
    if (ct_data_parser_builder_failed(builder) ||
        raw_array == 0 ||
        raw_value == 0 ||
        index > UINT32_MAX) {
        return false;
    }
    JSObjectSetPropertyAtIndex(
        builder->context,
        (JSObjectRef)raw_array,
        (unsigned)index,
        (JSValueRef)raw_value,
        builder->exception
    );
    return !ct_data_parser_builder_failed(builder);
}

bool ct_data_parser_builder_set_property(
    void *opaque_builder,
    uintptr_t raw_object,
    uintptr_t raw_key,
    uintptr_t raw_value
) {
    CtDataParserBuilder *builder = (CtDataParserBuilder *)opaque_builder;
    if (ct_data_parser_builder_failed(builder) ||
        raw_object == 0 ||
        raw_key == 0 ||
        raw_value == 0) {
        return false;
    }

    JSStringRef key = JSValueToStringCopy(
        builder->context,
        (JSValueRef)raw_key,
        builder->exception
    );
    if (key == NULL || ct_data_parser_builder_failed(builder)) return false;
    JSObjectSetProperty(
        builder->context,
        (JSObjectRef)raw_object,
        key,
        (JSValueRef)raw_value,
        kJSPropertyAttributeNone,
        builder->exception
    );
    JSStringRelease(key);
    return !ct_data_parser_builder_failed(builder);
}

void ct_data_parser_builder_set_error(
    void *opaque_builder,
    int kind,
    const uint8_t *message,
    size_t len
) {
    CtDataParserBuilder *builder = (CtDataParserBuilder *)opaque_builder;
    if (builder == NULL || builder->error_message != NULL) return;
    builder->error_kind = kind;
    builder->error_message = ct_duplicate_bytes(
        (const char *)(message != NULL ? message : (const uint8_t *)""),
        message != NULL ? len : 0
    );
}

static void ct_data_parser_throw(
    JSContextRef context,
    JSValueRef *exception,
    const char *constructor_name,
    const char *message
) {
    if (exception == NULL) return;
    JSValueRef constructor_exception = NULL;
    JSValueRef constructor_value = ct_get_property(
        context,
        JSContextGetGlobalObject(context),
        constructor_name,
        &constructor_exception
    );
    if (constructor_exception == NULL &&
        constructor_value != NULL &&
        JSValueIsObject(context, constructor_value)) {
        JSValueRef argument = ct_make_string(context, message);
        JSObjectRef error = JSObjectCallAsConstructor(
            context,
            (JSObjectRef)constructor_value,
            1,
            &argument,
            &constructor_exception
        );
        if (constructor_exception == NULL && error != NULL) {
            *exception = error;
            return;
        }
    }
    JSValueRef argument = ct_make_string(context, message);
    *exception = JSObjectMakeError(context, 1, &argument, NULL);
}

static JSValueRef ct_yaml_parser_parse_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) {
        ct_throw_type_error(
            context,
            exception,
            "yamlParseNative(source) requires a source string"
        );
        return JSValueMakeUndefined(context);
    }

    size_t input_len = 0;
    char *input = ct_value_to_utf8_copy_checked(
        context,
        arguments[0],
        &input_len,
        exception
    );
    if (input == NULL) {
        if (exception == NULL || *exception == NULL) {
            ct_throw_message(context, exception, "Out of memory");
        }
        return JSValueMakeUndefined(context);
    }

    CtDataParserBuilder builder = {
        .context = context,
        .exception = exception,
        .protected_values = NULL,
        .protected_count = 0,
        .protected_capacity = 0,
        .error_message = NULL,
        .error_kind = 0,
    };
    uintptr_t raw_result = ct_yaml_parser_parse(
        (const uint8_t *)input,
        input_len,
        &builder
    );
    free(input);

    JSValueRef result = raw_result != 0
        ? (JSValueRef)raw_result
        : JSValueMakeUndefined(context);
    if (raw_result == 0 && (exception == NULL || *exception == NULL)) {
        const char *message = builder.error_message != NULL
            ? builder.error_message
            : "Unable to parse input";
        const char *constructor = builder.error_kind == CT_DATA_PARSER_ERROR_RANGE
            ? "RangeError"
            : builder.error_kind == CT_DATA_PARSER_ERROR_SYNTAX
                ? "SyntaxError"
                : "Error";
        ct_data_parser_throw(context, exception, constructor, message);
    }
    ct_data_parser_builder_deinit(&builder);
    return result;
}
