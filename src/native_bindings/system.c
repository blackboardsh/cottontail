#include "registry.h"

extern char *ct_host_system_root_certificates(char **error_out);
extern void ct_host_string_free(char *value);

JSValueRef ct_system_root_certificates(
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

    char *error = NULL;
    char *pem = ct_host_system_root_certificates(&error);
    if (pem == NULL) {
        if (error != NULL) {
            JSStringRef error_string = JSStringCreateWithUTF8CString(error);
            JSValueRef error_argument = JSValueMakeString(context, error_string);
            if (exception != NULL) {
                *exception = JSObjectMakeError(context, 1, &error_argument, NULL);
            }
            JSStringRelease(error_string);
            ct_host_string_free(error);
        }
        return JSValueMakeUndefined(context);
    }

    JSStringRef pem_string = JSStringCreateWithUTF8CString(pem);
    JSValueRef result = JSValueMakeString(context, pem_string);
    JSStringRelease(pem_string);
    ct_host_string_free(pem);
    return result;
}

#define CT_NATIVE_BINDING_MODULE system
#define CT_NATIVE_BINDING_LIST "system.inc"
#include "module.h"
