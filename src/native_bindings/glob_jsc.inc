#include "glob.h"

typedef struct {
    uint8_t *pattern;
    size_t pattern_length;
} CtGlobMatcher;

static bool ct_glob_wtf8_capacity(JSStringRef string, size_t *capacity_out) {
    const size_t length = JSStringGetLength(string);
    if (length > (SIZE_MAX - 1) / 3) return false;
    *capacity_out = length * 3 + 1;
    return true;
}

static bool ct_glob_copy_wtf8(
    JSStringRef string,
    uint8_t *output,
    size_t capacity,
    size_t *length_out
) {
    const size_t length = JSStringGetLength(string);
    if (capacity == 0) return false;
    if (length == 0) {
        output[0] = 0;
        *length_out = 0;
        return true;
    }
    const JSChar *characters = JSStringGetCharactersPtr(string);
    if (characters == NULL) return false;

    size_t cursor = 0;
    for (size_t index = 0; index < length; index += 1) {
        uint32_t code_point = characters[index];
        if (code_point >= 0xd800 && code_point <= 0xdbff &&
            index + 1 < length &&
            characters[index + 1] >= 0xdc00 &&
            characters[index + 1] <= 0xdfff) {
            code_point = 0x10000 +
                ((code_point - 0xd800) << 10) +
                (characters[index + 1] - 0xdc00);
            index += 1;
        }

        if (code_point <= 0x7f) {
            if (cursor + 1 >= capacity) return false;
            output[cursor++] = (uint8_t)code_point;
        } else if (code_point <= 0x7ff) {
            if (cursor + 2 >= capacity) return false;
            output[cursor++] = (uint8_t)(0xc0 | (code_point >> 6));
            output[cursor++] = (uint8_t)(0x80 | (code_point & 0x3f));
        } else if (code_point <= 0xffff) {
            if (cursor + 3 >= capacity) return false;
            output[cursor++] = (uint8_t)(0xe0 | (code_point >> 12));
            output[cursor++] = (uint8_t)(0x80 | ((code_point >> 6) & 0x3f));
            output[cursor++] = (uint8_t)(0x80 | (code_point & 0x3f));
        } else {
            if (cursor + 4 >= capacity) return false;
            output[cursor++] = (uint8_t)(0xf0 | (code_point >> 18));
            output[cursor++] = (uint8_t)(0x80 | ((code_point >> 12) & 0x3f));
            output[cursor++] = (uint8_t)(0x80 | ((code_point >> 6) & 0x3f));
            output[cursor++] = (uint8_t)(0x80 | (code_point & 0x3f));
        }
    }
    output[cursor] = 0;
    *length_out = cursor;
    return true;
}

static void ct_glob_matcher_finalize(JSObjectRef object) {
    CtGlobMatcher *matcher = (CtGlobMatcher *)JSObjectGetPrivate(object);
    if (matcher == NULL) return;
    free(matcher->pattern);
    free(matcher);
}

static JSValueRef ct_glob_matcher_call(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)this_object;
    CtGlobMatcher *matcher = (CtGlobMatcher *)JSObjectGetPrivate(function);
    if (matcher == NULL) {
        ct_throw_type_error(context, exception, "Native Glob matcher is no longer valid");
        return JSValueMakeUndefined(context);
    }
    if (argument_count < 1 || !JSValueIsString(context, arguments[0])) {
        ct_throw_type_error(context, exception, "Glob.match expects a string");
        return JSValueMakeUndefined(context);
    }

    JSStringRef path_string = JSValueToStringCopy(context, arguments[0], exception);
    if (path_string == NULL || (exception != NULL && *exception != NULL)) {
        return JSValueMakeUndefined(context);
    }

    size_t capacity = 0;
    if (!ct_glob_wtf8_capacity(path_string, &capacity)) {
        JSStringRelease(path_string);
        ct_throw_message(context, exception, "Glob path is too large");
        return JSValueMakeUndefined(context);
    }
    char stack_buffer[4096];
    uint8_t *path = capacity <= sizeof(stack_buffer)
        ? (uint8_t *)stack_buffer
        : (uint8_t *)malloc(capacity);
    if (path == NULL) {
        JSStringRelease(path_string);
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }

    size_t path_length = 0;
    const bool converted = ct_glob_copy_wtf8(
        path_string,
        path,
        capacity,
        &path_length
    );
    JSStringRelease(path_string);
    if (!converted) {
        if (path != (uint8_t *)stack_buffer) free(path);
        ct_throw_message(context, exception, "Unable to encode Glob path");
        return JSValueMakeUndefined(context);
    }
    const bool matched = ct_glob_match(
        matcher->pattern,
        matcher->pattern_length,
        path,
        path_length
    );

    if (path != (uint8_t *)stack_buffer) free(path);
    return JSValueMakeBoolean(context, matched);
}

static JSValueRef ct_glob_compile_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1 || !JSValueIsString(context, arguments[0])) {
        ct_throw_type_error(context, exception, "Glob pattern must be a string");
        return JSValueMakeUndefined(context);
    }

    JSStringRef pattern_string = JSValueToStringCopy(context, arguments[0], exception);
    if (pattern_string == NULL || (exception != NULL && *exception != NULL)) {
        return JSValueMakeUndefined(context);
    }
    size_t capacity = 0;
    if (!ct_glob_wtf8_capacity(pattern_string, &capacity)) {
        JSStringRelease(pattern_string);
        ct_throw_message(context, exception, "Glob pattern is too large");
        return JSValueMakeUndefined(context);
    }

    CtGlobMatcher *matcher = (CtGlobMatcher *)calloc(1, sizeof(CtGlobMatcher));
    if (matcher != NULL) {
        matcher->pattern = (uint8_t *)malloc(capacity > 0 ? capacity : 1);
    }
    if (matcher == NULL || matcher->pattern == NULL) {
        JSStringRelease(pattern_string);
        if (matcher != NULL) free(matcher);
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }

    const bool converted = ct_glob_copy_wtf8(
        pattern_string,
        matcher->pattern,
        capacity,
        &matcher->pattern_length
    );
    JSStringRelease(pattern_string);
    if (!converted) {
        free(matcher->pattern);
        free(matcher);
        ct_throw_message(context, exception, "Unable to encode Glob pattern");
        return JSValueMakeUndefined(context);
    }

    JSClassDefinition definition = kJSClassDefinitionEmpty;
    definition.className = "CottontailGlobMatcher";
    definition.callAsFunction = ct_glob_matcher_call;
    definition.finalize = ct_glob_matcher_finalize;
    JSClassRef matcher_class = JSClassCreate(&definition);
    JSObjectRef object = JSObjectMake(context, matcher_class, matcher);
    JSClassRelease(matcher_class);
    if (object == NULL) {
        free(matcher->pattern);
        free(matcher);
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    return object;
}
