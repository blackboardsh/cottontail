#include "../native_capability.h"

#include <errno.h>

#if defined(_WIN32)
#include <bcrypt.h>
#else
#include <stdlib.h>
#endif

static JSValueRef ct_array_buffer_take_owned_bytes(
    JSContextRef context,
    char **bytes,
    size_t length,
    JSValueRef *exception
) {
    JSObjectRef result = JSObjectMakeArrayBufferWithBytesNoCopy(
        context,
        *bytes,
        length,
        ct_array_buffer_free,
        NULL,
        exception
    );
    if (result != NULL) *bytes = NULL;
    return result != NULL ? result : JSValueMakeUndefined(context);
}

static int ct_fill_random_bytes(uint8_t *buffer, size_t length) {
    if (length == 0) return 0;
#if defined(_WIN32)
    if (length > ULONG_MAX ||
        BCryptGenRandom(NULL, buffer, (ULONG)length, BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
        errno = EIO;
        return -1;
    }
#else
    arc4random_buf(buffer, length);
#endif
    return 0;
}

#include "../../native_bindings/websocket_frame_jsc.inc"

#define CT_NATIVE_BINDING(name, callback) { name, callback },
static const struct {
    const char *name;
    JSObjectCallAsFunctionCallback callback;
} bindings[] = {
    CT_NATIVE_BINDING("websocketFrameEncode", ct_websocket_frame_encode_native)
    CT_NATIVE_BINDING("websocketUnmaskCopy", ct_websocket_unmask_copy_native)
};
#undef CT_NATIVE_BINDING

#if defined(_WIN32)
__declspec(dllexport)
#else
__attribute__((visibility("default")))
#endif
int cottontail_capability_init(JSContextRef context, JSObjectRef target) {
    for (size_t index = 0; index < sizeof(bindings) / sizeof(bindings[0]); index += 1) {
        JSClassDefinition definition = kJSClassDefinitionEmpty;
        definition.className = bindings[index].name;
        definition.callAsFunction = bindings[index].callback;
        JSClassRef class_ref = JSClassCreate(&definition);
        JSObjectRef function = JSObjectMake(context, class_ref, NULL);
        JSClassRelease(class_ref);
        JSStringRef key = ct_js_string(bindings[index].name);
        JSValueRef exception = NULL;
        JSObjectSetProperty(context, target, key, function, kJSPropertyAttributeNone, &exception);
        JSStringRelease(key);
        if (exception != NULL) return -1;
    }
    return 0;
}
