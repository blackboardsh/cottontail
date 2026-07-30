#pragma once

#include <JavaScriptCore/JSContextRef.h>
#include <JavaScriptCore/JSObjectRef.h>
#include <JavaScriptCore/JSStringRef.h>
#include <JavaScriptCore/JSValueRef.h>

#ifdef __cplusplus
extern "C" {
#endif

JSObjectRef ct_url_parse_form(
    JSContextRef context,
    JSStringRef input,
    JSValueRef* exception);

#ifdef __cplusplus
}
#endif
