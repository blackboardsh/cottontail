#include "../native_capability.h"

extern uint8_t *ct_markdown_render_html(const uint8_t *, size_t, uint64_t, size_t *, char **);
extern uint8_t *ct_markdown_parse_events(const uint8_t *, size_t, uint64_t, size_t *, char **);
extern void ct_markdown_free(uint8_t *, size_t);
extern void ct_markdown_string_free(char *);

static JSValueRef markdown_call(JSContextRef context, size_t argc, const JSValueRef argv[], JSValueRef *exception, bool events) {
    if (argc < 1) {
        ct_throw_message(context, exception, events ? "markdownEvents(source[, flags]) requires source" : "markdownHtml(source[, flags]) requires source");
        return JSValueMakeUndefined(context);
    }
    size_t source_len = 0;
    char *source = ct_value_to_utf8_copy_checked(context, argv[0], &source_len, exception);
    if (source == NULL) {
        if (exception == NULL || *exception == NULL) ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    const uint64_t flags = argc >= 2 ? (uint64_t)ct_value_to_number(context, argv[1]) : 0;
    size_t output_len = 0;
    char *error = NULL;
    uint8_t *output = events
        ? ct_markdown_parse_events((const uint8_t *)source, source_len, flags, &output_len, &error)
        : ct_markdown_render_html((const uint8_t *)source, source_len, flags, &output_len, &error);
    free(source);
    if (output == NULL) {
        ct_throw_message(context, exception, error != NULL ? error : (events ? "Markdown parsing failed" : "Markdown rendering failed"));
        ct_markdown_string_free(error);
        return JSValueMakeUndefined(context);
    }
    JSValueRef result = ct_make_string_len(context, (const char *)output, output_len);
    ct_markdown_free(output, output_len);
    return result;
}

static JSValueRef markdown_html(JSContextRef context, JSObjectRef function, JSObjectRef this_object, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function; (void)this_object;
    return markdown_call(context, argc, argv, exception, false);
}

static JSValueRef markdown_events(JSContextRef context, JSObjectRef function, JSObjectRef this_object, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function; (void)this_object;
    return markdown_call(context, argc, argv, exception, true);
}

#define MARKDOWN_BINDINGS \
    { "markdownHtml", markdown_html }, \
    { "markdownEvents", markdown_events },
CT_CAPABILITY_EXPORT_BINDINGS(MARKDOWN_BINDINGS)
