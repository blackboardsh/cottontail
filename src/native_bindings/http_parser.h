#ifndef COTTONTAIL_NATIVE_BINDINGS_HTTP_PARSER_H
#define COTTONTAIL_NATIVE_BINDINGS_HTTP_PARSER_H

#include <JavaScriptCore/JavaScript.h>
#include <stddef.h>

JSValueRef ct_http_parser_create(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
);

JSValueRef ct_http_parser_initialize(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
);

JSValueRef ct_http_parser_execute(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
);

JSValueRef ct_http_parser_finish(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
);

JSValueRef ct_http_parser_pause(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
);

JSValueRef ct_http_parser_resume(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
);

JSValueRef ct_http_parser_destroy(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
);

#endif
