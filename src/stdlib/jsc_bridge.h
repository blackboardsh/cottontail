#ifndef COTTONTAIL_STDLIB_JSC_BRIDGE_H
#define COTTONTAIL_STDLIB_JSC_BRIDGE_H

#include <JavaScriptCore/JavaScript.h>

/*
 * JSC bridge ABI
 *
 * Cottontail embeds JavaScriptCore in the executable, while its first-party
 * dynamic libraries need a small part of the public JSC C API.  They must not
 * import the standard JS* names from the executable: exporting those names
 * lets unrelated process libraries bind to Cottontail's private JSC instance.
 *
 * Keep the standard spellings in dynamic-library source, but route them
 * through this Cottontail-owned, prefixed ABI.  jsc_bridge.c is the only file
 * that calls the embedded JSC symbols directly.
 */

#if defined(_WIN32)
#if defined(COTTONTAIL_JSC_BRIDGE_IMPLEMENTATION)
#define COTTONTAIL_JSC_BRIDGE_EXPORT __declspec(dllexport)
#else
#define COTTONTAIL_JSC_BRIDGE_EXPORT __declspec(dllimport)
#endif
#elif defined(__GNUC__)
#define COTTONTAIL_JSC_BRIDGE_EXPORT __attribute__((visibility("default")))
#else
#define COTTONTAIL_JSC_BRIDGE_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

#if defined(COTTONTAIL_JSC_BRIDGE_IMPLEMENTATION)
#define COTTONTAIL_JSC_BRIDGE_FORWARD(result, name, parameters, arguments) \
    COTTONTAIL_JSC_BRIDGE_EXPORT result cottontail_jsc_##name parameters { return name arguments; }
#define COTTONTAIL_JSC_BRIDGE_FORWARD_VOID(name, parameters, arguments) \
    COTTONTAIL_JSC_BRIDGE_EXPORT void cottontail_jsc_##name parameters { name arguments; }
#else
#define COTTONTAIL_JSC_BRIDGE_FORWARD(result, name, parameters, arguments) \
    COTTONTAIL_JSC_BRIDGE_EXPORT result cottontail_jsc_##name parameters;
#define COTTONTAIL_JSC_BRIDGE_FORWARD_VOID(name, parameters, arguments) \
    COTTONTAIL_JSC_BRIDGE_EXPORT void cottontail_jsc_##name parameters;
#endif

COTTONTAIL_JSC_BRIDGE_FORWARD(JSValueRef, JSBigIntCreateWithInt64,
    (JSContextRef context, int64_t integer, JSValueRef *exception),
    (context, integer, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSValueRef, JSBigIntCreateWithUInt64,
    (JSContextRef context, uint64_t integer, JSValueRef *exception),
    (context, integer, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSClassRef, JSClassCreate,
    (const JSClassDefinition *definition),
    (definition))
COTTONTAIL_JSC_BRIDGE_FORWARD_VOID(JSClassRelease,
    (JSClassRef js_class),
    (js_class))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSObjectRef, JSContextGetGlobalObject,
    (JSContextRef context),
    (context))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSObjectRef, JSObjectCallAsConstructor,
    (JSContextRef context, JSObjectRef object, size_t argument_count, const JSValueRef arguments[], JSValueRef *exception),
    (context, object, argument_count, arguments, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSValueRef, JSObjectCallAsFunction,
    (JSContextRef context, JSObjectRef object, JSObjectRef this_object, size_t argument_count, const JSValueRef arguments[], JSValueRef *exception),
    (context, object, this_object, argument_count, arguments, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(size_t, JSObjectGetArrayBufferByteLength,
    (JSContextRef context, JSObjectRef object, JSValueRef *exception),
    (context, object, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(void *, JSObjectGetArrayBufferBytesPtr,
    (JSContextRef context, JSObjectRef object, JSValueRef *exception),
    (context, object, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(void *, JSObjectGetPrivate,
    (JSObjectRef object),
    (object))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSValueRef, JSObjectGetProperty,
    (JSContextRef context, JSObjectRef object, JSStringRef property_name, JSValueRef *exception),
    (context, object, property_name, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSValueRef, JSObjectGetPropertyAtIndex,
    (JSContextRef context, JSObjectRef object, unsigned property_index, JSValueRef *exception),
    (context, object, property_index, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSObjectRef, JSObjectGetTypedArrayBuffer,
    (JSContextRef context, JSObjectRef object, JSValueRef *exception),
    (context, object, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(size_t, JSObjectGetTypedArrayByteLength,
    (JSContextRef context, JSObjectRef object, JSValueRef *exception),
    (context, object, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(size_t, JSObjectGetTypedArrayByteOffset,
    (JSContextRef context, JSObjectRef object, JSValueRef *exception),
    (context, object, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(void *, JSObjectGetTypedArrayBytesPtr,
    (JSContextRef context, JSObjectRef object, JSValueRef *exception),
    (context, object, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(bool, JSObjectIsFunction,
    (JSContextRef context, JSObjectRef object),
    (context, object))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSObjectRef, JSObjectMake,
    (JSContextRef context, JSClassRef js_class, void *data),
    (context, js_class, data))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSObjectRef, JSObjectMakeArray,
    (JSContextRef context, size_t argument_count, const JSValueRef arguments[], JSValueRef *exception),
    (context, argument_count, arguments, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSObjectRef, JSObjectMakeArrayBufferWithBytesNoCopy,
    (JSContextRef context, void *bytes, size_t byte_length, JSTypedArrayBytesDeallocator bytes_deallocator, void *deallocator_context, JSValueRef *exception),
    (context, bytes, byte_length, bytes_deallocator, deallocator_context, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSObjectRef, JSObjectMakeError,
    (JSContextRef context, size_t argument_count, const JSValueRef arguments[], JSValueRef *exception),
    (context, argument_count, arguments, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSObjectRef, JSObjectMakeTypedArray,
    (JSContextRef context, JSTypedArrayType array_type, size_t length, JSValueRef *exception),
    (context, array_type, length, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSObjectRef, JSObjectMakeTypedArrayWithArrayBuffer,
    (JSContextRef context, JSTypedArrayType array_type, JSObjectRef buffer, JSValueRef *exception),
    (context, array_type, buffer, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(bool, JSObjectSetPrivate,
    (JSObjectRef object, void *data),
    (object, data))
COTTONTAIL_JSC_BRIDGE_FORWARD_VOID(JSObjectSetProperty,
    (JSContextRef context, JSObjectRef object, JSStringRef property_name, JSValueRef value, JSPropertyAttributes attributes, JSValueRef *exception),
    (context, object, property_name, value, attributes, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD_VOID(JSObjectSetPropertyAtIndex,
    (JSContextRef context, JSObjectRef object, unsigned property_index, JSValueRef value, JSValueRef *exception),
    (context, object, property_index, value, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSStringRef, JSStringCreateWithCharacters,
    (const JSChar *characters, size_t character_count),
    (characters, character_count))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSStringRef, JSStringCreateWithUTF8CString,
    (const char *string),
    (string))
COTTONTAIL_JSC_BRIDGE_FORWARD(const JSChar *, JSStringGetCharactersPtr,
    (JSStringRef string),
    (string))
COTTONTAIL_JSC_BRIDGE_FORWARD(size_t, JSStringGetLength,
    (JSStringRef string),
    (string))
COTTONTAIL_JSC_BRIDGE_FORWARD(size_t, JSStringGetMaximumUTF8CStringSize,
    (JSStringRef string),
    (string))
COTTONTAIL_JSC_BRIDGE_FORWARD(size_t, JSStringGetUTF8CString,
    (JSStringRef string, char *buffer, size_t buffer_size),
    (string, buffer, buffer_size))
COTTONTAIL_JSC_BRIDGE_FORWARD_VOID(JSStringRelease,
    (JSStringRef string),
    (string))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSTypedArrayType, JSValueGetTypedArrayType,
    (JSContextRef context, JSValueRef value, JSValueRef *exception),
    (context, value, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(bool, JSValueIsBigInt,
    (JSContextRef context, JSValueRef value),
    (context, value))
COTTONTAIL_JSC_BRIDGE_FORWARD(bool, JSValueIsBoolean,
    (JSContextRef context, JSValueRef value),
    (context, value))
COTTONTAIL_JSC_BRIDGE_FORWARD(bool, JSValueIsInstanceOfConstructor,
    (JSContextRef context, JSValueRef value, JSObjectRef constructor, JSValueRef *exception),
    (context, value, constructor, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(bool, JSValueIsNull,
    (JSContextRef context, JSValueRef value),
    (context, value))
COTTONTAIL_JSC_BRIDGE_FORWARD(bool, JSValueIsNumber,
    (JSContextRef context, JSValueRef value),
    (context, value))
COTTONTAIL_JSC_BRIDGE_FORWARD(bool, JSValueIsObject,
    (JSContextRef context, JSValueRef value),
    (context, value))
COTTONTAIL_JSC_BRIDGE_FORWARD(bool, JSValueIsObjectOfClass,
    (JSContextRef context, JSValueRef value, JSClassRef js_class),
    (context, value, js_class))
COTTONTAIL_JSC_BRIDGE_FORWARD(bool, JSValueIsString,
    (JSContextRef context, JSValueRef value),
    (context, value))
COTTONTAIL_JSC_BRIDGE_FORWARD(bool, JSValueIsUndefined,
    (JSContextRef context, JSValueRef value),
    (context, value))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSValueRef, JSValueMakeBoolean,
    (JSContextRef context, bool boolean),
    (context, boolean))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSValueRef, JSValueMakeNull,
    (JSContextRef context),
    (context))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSValueRef, JSValueMakeNumber,
    (JSContextRef context, double number),
    (context, number))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSValueRef, JSValueMakeString,
    (JSContextRef context, JSStringRef string),
    (context, string))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSValueRef, JSValueMakeUndefined,
    (JSContextRef context),
    (context))
COTTONTAIL_JSC_BRIDGE_FORWARD_VOID(JSValueProtect,
    (JSContextRef context, JSValueRef value),
    (context, value))
COTTONTAIL_JSC_BRIDGE_FORWARD(bool, JSValueToBoolean,
    (JSContextRef context, JSValueRef value),
    (context, value))
COTTONTAIL_JSC_BRIDGE_FORWARD(double, JSValueToNumber,
    (JSContextRef context, JSValueRef value, JSValueRef *exception),
    (context, value, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD(JSStringRef, JSValueToStringCopy,
    (JSContextRef context, JSValueRef value, JSValueRef *exception),
    (context, value, exception))
COTTONTAIL_JSC_BRIDGE_FORWARD_VOID(JSValueUnprotect,
    (JSContextRef context, JSValueRef value),
    (context, value))

#if defined(COTTONTAIL_JSC_BRIDGE_IMPLEMENTATION)
COTTONTAIL_JSC_BRIDGE_EXPORT const JSClassDefinition *cottontail_jsc_get_class_definition_empty(void) {
    return &kJSClassDefinitionEmpty;
}
#else
COTTONTAIL_JSC_BRIDGE_EXPORT const JSClassDefinition *cottontail_jsc_get_class_definition_empty(void);
#endif

#undef COTTONTAIL_JSC_BRIDGE_FORWARD
#undef COTTONTAIL_JSC_BRIDGE_FORWARD_VOID

#ifdef __cplusplus
}
#endif

#if !defined(COTTONTAIL_JSC_BRIDGE_IMPLEMENTATION)
#define JSBigIntCreateWithInt64 cottontail_jsc_JSBigIntCreateWithInt64
#define JSBigIntCreateWithUInt64 cottontail_jsc_JSBigIntCreateWithUInt64
#define JSClassCreate cottontail_jsc_JSClassCreate
#define JSClassRelease cottontail_jsc_JSClassRelease
#define JSContextGetGlobalObject cottontail_jsc_JSContextGetGlobalObject
#define JSObjectCallAsConstructor cottontail_jsc_JSObjectCallAsConstructor
#define JSObjectCallAsFunction cottontail_jsc_JSObjectCallAsFunction
#define JSObjectGetArrayBufferByteLength cottontail_jsc_JSObjectGetArrayBufferByteLength
#define JSObjectGetArrayBufferBytesPtr cottontail_jsc_JSObjectGetArrayBufferBytesPtr
#define JSObjectGetPrivate cottontail_jsc_JSObjectGetPrivate
#define JSObjectGetProperty cottontail_jsc_JSObjectGetProperty
#define JSObjectGetPropertyAtIndex cottontail_jsc_JSObjectGetPropertyAtIndex
#define JSObjectGetTypedArrayBuffer cottontail_jsc_JSObjectGetTypedArrayBuffer
#define JSObjectGetTypedArrayByteLength cottontail_jsc_JSObjectGetTypedArrayByteLength
#define JSObjectGetTypedArrayByteOffset cottontail_jsc_JSObjectGetTypedArrayByteOffset
#define JSObjectGetTypedArrayBytesPtr cottontail_jsc_JSObjectGetTypedArrayBytesPtr
#define JSObjectIsFunction cottontail_jsc_JSObjectIsFunction
#define JSObjectMake cottontail_jsc_JSObjectMake
#define JSObjectMakeArray cottontail_jsc_JSObjectMakeArray
#define JSObjectMakeArrayBufferWithBytesNoCopy cottontail_jsc_JSObjectMakeArrayBufferWithBytesNoCopy
#define JSObjectMakeError cottontail_jsc_JSObjectMakeError
#define JSObjectMakeTypedArray cottontail_jsc_JSObjectMakeTypedArray
#define JSObjectMakeTypedArrayWithArrayBuffer cottontail_jsc_JSObjectMakeTypedArrayWithArrayBuffer
#define JSObjectSetPrivate cottontail_jsc_JSObjectSetPrivate
#define JSObjectSetProperty cottontail_jsc_JSObjectSetProperty
#define JSObjectSetPropertyAtIndex cottontail_jsc_JSObjectSetPropertyAtIndex
#define JSStringCreateWithCharacters cottontail_jsc_JSStringCreateWithCharacters
#define JSStringCreateWithUTF8CString cottontail_jsc_JSStringCreateWithUTF8CString
#define JSStringGetCharactersPtr cottontail_jsc_JSStringGetCharactersPtr
#define JSStringGetLength cottontail_jsc_JSStringGetLength
#define JSStringGetMaximumUTF8CStringSize cottontail_jsc_JSStringGetMaximumUTF8CStringSize
#define JSStringGetUTF8CString cottontail_jsc_JSStringGetUTF8CString
#define JSStringRelease cottontail_jsc_JSStringRelease
#define JSValueGetTypedArrayType cottontail_jsc_JSValueGetTypedArrayType
#define JSValueIsBigInt cottontail_jsc_JSValueIsBigInt
#define JSValueIsBoolean cottontail_jsc_JSValueIsBoolean
#define JSValueIsInstanceOfConstructor cottontail_jsc_JSValueIsInstanceOfConstructor
#define JSValueIsNull cottontail_jsc_JSValueIsNull
#define JSValueIsNumber cottontail_jsc_JSValueIsNumber
#define JSValueIsObject cottontail_jsc_JSValueIsObject
#define JSValueIsObjectOfClass cottontail_jsc_JSValueIsObjectOfClass
#define JSValueIsString cottontail_jsc_JSValueIsString
#define JSValueIsUndefined cottontail_jsc_JSValueIsUndefined
#define JSValueMakeBoolean cottontail_jsc_JSValueMakeBoolean
#define JSValueMakeNull cottontail_jsc_JSValueMakeNull
#define JSValueMakeNumber cottontail_jsc_JSValueMakeNumber
#define JSValueMakeString cottontail_jsc_JSValueMakeString
#define JSValueMakeUndefined cottontail_jsc_JSValueMakeUndefined
#define JSValueProtect cottontail_jsc_JSValueProtect
#define JSValueToBoolean cottontail_jsc_JSValueToBoolean
#define JSValueToNumber cottontail_jsc_JSValueToNumber
#define JSValueToStringCopy cottontail_jsc_JSValueToStringCopy
#define JSValueUnprotect cottontail_jsc_JSValueUnprotect
#define kJSClassDefinitionEmpty (*cottontail_jsc_get_class_definition_empty())
#endif

#undef COTTONTAIL_JSC_BRIDGE_EXPORT

#endif
