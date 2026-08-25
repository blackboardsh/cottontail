#ifndef COTTONTAIL_STDLIB_NATIVE_CAPABILITY_H
#define COTTONTAIL_STDLIB_NATIVE_CAPABILITY_H
#include <JavaScriptCore/JavaScript.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

static JSStringRef ct_js_string(const char *value) { return JSStringCreateWithUTF8CString(value != NULL ? value : ""); }
static JSValueRef ct_make_string_len(JSContextRef context, const char *value, size_t len) {
    if (value == NULL) len = 0;
    char *terminated = (char *)malloc(len + 1);
    if (terminated == NULL) return JSValueMakeUndefined(context);
    if (len > 0) memcpy(terminated, value, len);
    terminated[len] = '\0';
    JSStringRef string = JSStringCreateWithUTF8CString(terminated);
    free(terminated);
    JSValueRef result = JSValueMakeString(context, string);
    JSStringRelease(string);
    return result;
}
static JSValueRef ct_make_string(JSContextRef context, const char *value) { return ct_make_string_len(context, value, value != NULL ? strlen(value) : 0); }
static char *ct_value_to_string_copy(JSContextRef context, JSValueRef value) { size_t ignored=0; JSValueRef error=NULL; JSStringRef string=JSValueToStringCopy(context,value,&error);if(!string)return NULL;size_t size=JSStringGetMaximumUTF8CStringSize(string);char *buffer=malloc(size?size:1);if(buffer)JSStringGetUTF8CString(string,buffer,size);JSStringRelease(string);(void)ignored;return buffer;}
static double ct_value_to_number(JSContextRef context, JSValueRef value) { JSValueRef error=NULL;double result=JSValueToNumber(context,value,&error);return error==NULL?result:0; }
static bool ct_value_to_bool(JSContextRef context, JSValueRef value) { return JSValueToBoolean(context, value); }
static void ct_throw_message(JSContextRef context, JSValueRef *exception, const char *message) { if (exception != NULL) *exception = ct_make_string(context, message); }
static bool ct_set_property(JSContextRef context, JSObjectRef object, const char *name, JSValueRef value, JSValueRef *exception) {
    JSStringRef key=ct_js_string(name); JSObjectSetProperty(context,object,key,value,kJSPropertyAttributeNone,exception); JSStringRelease(key); return exception==NULL||*exception==NULL;
}
static JSValueRef ct_get_property(JSContextRef context, JSObjectRef object, const char *name, JSValueRef *exception) {
    JSStringRef key=ct_js_string(name); JSValueRef result=JSObjectGetProperty(context,object,key,exception); JSStringRelease(key); return result;
}
static void ct_throw_type_error(JSContextRef context, JSValueRef *exception, const char *message) {
    if (exception == NULL) return; JSValueRef local=NULL; JSValueRef ctor=ct_get_property(context,JSContextGetGlobalObject(context),"TypeError",&local);
    JSValueRef argument=ct_make_string(context,message); if(local==NULL&&ctor!=NULL&&JSValueIsObject(context,ctor)){JSObjectRef error=JSObjectCallAsConstructor(context,(JSObjectRef)ctor,1,&argument,&local);if(local==NULL&&error!=NULL){*exception=error;return;}}
    *exception=JSObjectMakeError(context,1,&argument,NULL);
}
static bool ct_value_to_int_checked(JSContextRef context, JSValueRef value, int minimum, int maximum, int *result, JSValueRef *exception, const char *message) {
    JSValueRef local=NULL; double number=JSValueToNumber(context,value,&local); if(local!=NULL){if(exception)*exception=local;return false;} if(!isfinite(number)||number<minimum||number>maximum){ct_throw_message(context,exception,message);return false;} *result=(int)number; return true;
}
static bool ct_value_to_uint32_checked(JSContextRef context, JSValueRef value, uint32_t *result, JSValueRef *exception, const char *message) {
    JSValueRef local=NULL; double number=JSValueToNumber(context,value,&local); if(local!=NULL){if(exception)*exception=local;return false;} if(!isfinite(number)||number<0||number>UINT32_MAX){ct_throw_message(context,exception,message);return false;} *result=(uint32_t)number; return true;
}
static char *ct_value_to_utf8_copy_checked(JSContextRef context, JSValueRef value, size_t *len, JSValueRef *exception) {
    *len=0; JSStringRef string=JSValueToStringCopy(context,value,exception); if(string==NULL||(exception&&*exception))return NULL; size_t size=JSStringGetMaximumUTF8CStringSize(string); char *buffer=malloc(size?size:1); if(!buffer){JSStringRelease(string);return NULL;} size_t written=JSStringGetUTF8CString(string,buffer,size); JSStringRelease(string); *len=written?written-1:0; return buffer;
}
static JSObjectRef ct_make_object(JSContextRef context){return JSObjectMake(context,NULL,NULL);}
static JSObjectRef ct_make_array(JSContextRef context,size_t count,const JSValueRef values[],JSValueRef *exception){return JSObjectMakeArray(context,count,values,exception);}
static void ct_array_buffer_free(void *bytes,void *context){(void)context;free(bytes);}
static JSValueRef ct_array_buffer_from_copy(JSContextRef context,const char *bytes,size_t len,JSValueRef *exception){void *copy=malloc(len?len:1);if(!copy){ct_throw_message(context,exception,"Out of memory");return JSValueMakeUndefined(context);}if(len)memcpy(copy,bytes,len);return JSObjectMakeArrayBufferWithBytesNoCopy(context,copy,len,ct_array_buffer_free,NULL,exception);}
static int ct_get_bytes(JSContextRef context,JSValueRef value,uint8_t **data,size_t *len){*data=NULL;*len=0;if(!JSValueIsObject(context,value))return -1;JSValueRef error=NULL;JSObjectRef object=(JSObjectRef)value;JSTypedArrayType type=JSValueGetTypedArrayType(context,value,&error);if(error)return -1;if(type==kJSTypedArrayTypeArrayBuffer){*data=JSObjectGetArrayBufferBytesPtr(context,object,&error);*len=JSObjectGetArrayBufferByteLength(context,object,&error);return error?-1:0;}if(type!=kJSTypedArrayTypeNone){size_t offset=JSObjectGetTypedArrayByteOffset(context,object,&error);*len=JSObjectGetTypedArrayByteLength(context,object,&error);JSObjectRef buffer=JSObjectGetTypedArrayBuffer(context,object,&error);uint8_t *base=buffer?JSObjectGetArrayBufferBytesPtr(context,buffer,&error):NULL;if(error)return -1;*data=base?base+offset:NULL;return 0;}return -1;}
static JSValueRef ct_uint8_array_from_owned_bytes(JSContextRef context,uint8_t *bytes,size_t len,JSValueRef *exception){JSObjectRef result=JSObjectMakeTypedArray(context,kJSTypedArrayTypeUint8Array,len,exception);if(!result||(exception&&*exception)){free(bytes);return JSValueMakeUndefined(context);}if(len){JSValueRef error=NULL;void *destination=JSObjectGetTypedArrayBytesPtr(context,result,&error);if(error||!destination){free(bytes);if(exception)*exception=error;return JSValueMakeUndefined(context);}memcpy(destination,bytes,len);}free(bytes);return result;}

typedef struct { void *handle; bool initialized; } CtDynamicLibrary;
static void ct_dynamic_library_close(CtDynamicLibrary *library){if(!library||!library->initialized)return;
#if defined(_WIN32)
if(library->handle)FreeLibrary((HMODULE)library->handle);
#else
if(library->handle)dlclose(library->handle);
#endif
memset(library,0,sizeof(*library));}
static int ct_dynamic_library_open(CtDynamicLibrary *library,const char *path,char **error){if(error)*error=NULL;if(!library)return -1;memset(library,0,sizeof(*library));library->initialized=true;
#if defined(_WIN32)
library->handle=(void *)LoadLibraryA(path);
#else
library->handle=dlopen(path,RTLD_NOW|RTLD_LOCAL);
#endif
return library->handle?0:-1;}
static int ct_dynamic_library_symbol(const CtDynamicLibrary *library,const char *name,void **symbol,char **error){if(error)*error=NULL;if(symbol)*symbol=NULL;if(!library||!library->handle||!symbol)return -1;
#if defined(_WIN32)
*symbol=(void *)GetProcAddress((HMODULE)library->handle,name);
#else
*symbol=dlsym(library->handle,name);
#endif
return *symbol?0:-1;}

#if defined(_WIN32)
#define CT_CAPABILITY_EXPORT __declspec(dllexport)
#else
#define CT_CAPABILITY_EXPORT __attribute__((visibility("default")))
#endif

#define CT_CAPABILITY_EXPORT_BINDINGS(list_file) \
    static const struct { const char *name; JSObjectCallAsFunctionCallback callback; } ct_capability_bindings[] = { \
        list_file \
    }; \
    CT_CAPABILITY_EXPORT int cottontail_capability_init(JSContextRef context, JSObjectRef target) { \
        for(size_t i=0;i<sizeof(ct_capability_bindings)/sizeof(ct_capability_bindings[0]);i++){JSClassDefinition definition=kJSClassDefinitionEmpty;definition.className=ct_capability_bindings[i].name;definition.callAsFunction=ct_capability_bindings[i].callback;JSClassRef cls=JSClassCreate(&definition);JSObjectRef fn=JSObjectMake(context,cls,NULL);JSClassRelease(cls);JSStringRef key=ct_js_string(ct_capability_bindings[i].name);JSValueRef error=NULL;JSObjectSetProperty(context,target,key,fn,kJSPropertyAttributeNone,&error);JSStringRelease(key);if(error)return -1;}return 0; \
    }
#endif
