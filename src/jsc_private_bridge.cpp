/*
 * OpaqueJSString's layout and is8Bit() accessor are from WebKit
 * WebKit-7624.2.5.10.6 (Source/JavaScriptCore/API/OpaqueJSString.h).
 * WebKit's public C API deliberately keeps this type opaque, so this bridge
 * must stay pinned to the vendored JSC release.
 */

#include <JavaScriptCore/JSContextRef.h>
#include <JavaScriptCore/JSObjectRef.h>
#include <JavaScriptCore/JSStringRef.h>
#include <JavaScriptCore/JSTypedArray.h>
#include <JavaScriptCore/JSValueRef.h>

#include <atomic>
#include <bit>
#include <cstdint>
#include <wtf/ThreadSafeRefCounted.h>
#include <wtf/PtrTag.h>
#include <wtf/text/StringImpl.h>

namespace WTF {

// Minimal ABI declaration for the pinned JSCOnly artifact. Its installed
// RunLoop.h depends on private platform headers that the artifact omits.
class RunLoop {
public:
    enum class CycleResult { Continue, Stop };
    static CycleResult cycle(unsigned mode);
};

// These are ABI declarations for the pinned JSC build. FunctionPtr with the
// CFunctionPtrTag stores one unmodified native pointer on Cottontail's 64-bit
// targets; keeping the declaration here avoids depending on WebKit private
// headers that are intentionally absent from the JSC artifact.
enum class FunctionAttributes {
    None,
    JITOperation,
    JSCHostCall,
};

template<PtrTag tag, typename, FunctionAttributes = FunctionAttributes::None>
class FunctionPtr;

template<PtrTag tag, typename Out, typename... In, FunctionAttributes attributes>
class FunctionPtr<tag, Out(In...), attributes> {
public:
    constexpr FunctionPtr(Out (*pointer)(In...))
        : m_pointer(pointer)
    {
    }

private:
    Out (*m_pointer)(In...);
};

class String {
public:
    String() = default;
    String(const String& other)
        : m_impl(other.m_impl)
    {
        if (m_impl != nullptr)
            m_impl->ref();
    }
    String(String&& other)
        : m_impl(other.m_impl)
    {
        other.m_impl = nullptr;
    }
    ~String()
    {
        if (m_impl != nullptr)
            m_impl->deref();
    }

private:
    StringImpl* m_impl { nullptr };
};

}

struct OpaqueJSString : public ThreadSafeRefCounted<OpaqueJSString> {
    bool is8Bit() { return m_string_impl == nullptr || m_string_impl->is8Bit(); }
    WTF::String string() const;

private:
    // WTF::String is a single RefPtr<StringImpl> in this pinned WebKit tag.
    WTF::StringImpl* m_string_impl;
    std::atomic<char16_t*> m_characters;
};

extern "C" bool ct_jsc_string_is_8_bit(JSStringRef string)
{
    return string != nullptr && string->is8Bit();
}

extern "C" void ct_jsc_run_loop_cycle()
{
    WTF::RunLoop::cycle(0);
}

namespace JSC {
using EncodedJSValue = int64_t;

class CallFrame;
class Exception;
class JSGlobalObject;
class JSObject;
class VM;

namespace DOMJIT {
class Signature;
}

enum class ImplementationVisibility : uint8_t {
    Public,
    Private,
    PrivateRecursive,
};

enum Intrinsic : uint8_t {
    NoIntrinsic,
};

using NativeFunction = WTF::FunctionPtr<
    WTF::CFunctionPtrTag,
    EncodedJSValue(JSGlobalObject*, CallFrame*),
    WTF::FunctionAttributes::JSCHostCall>;

class JSFunction {
public:
    static JSFunction* create(
        VM&,
        JSGlobalObject*,
        unsigned length,
        const WTF::String& name,
        NativeFunction,
        ImplementationVisibility,
        Intrinsic,
        NativeFunction native_constructor,
        const DOMJIT::Signature*);
};

class InternalFunction {
public:
    static InternalFunction* createFunctionThatMasqueradesAsUndefined(
        VM&,
        JSGlobalObject*,
        unsigned length,
        const WTF::String& name,
        NativeFunction);
};

class VM {
public:
    class DrainMicrotaskDelayScope {
    public:
        explicit DrainMicrotaskDelayScope(VM&);
        ~DrainMicrotaskDelayScope();

    private:
        // The actual member is RefPtr<VM>, whose storage is one pointer.
        VM* m_vm;
    };

    void drainMicrotasks();
    Exception* throwException(JSGlobalObject*, JSObject*);
};

class JSLockHolder {
public:
    JSLockHolder(VM&);
    ~JSLockHolder();

private:
    // The actual member is RefPtr<VM>, whose storage is one pointer.
    VM* m_vm;
};

JSObject* createError(JSGlobalObject*, const WTF::String&);
JSObject* createTypeError(JSGlobalObject*, const WTF::String&);
}

static_assert(sizeof(JSValueRef) == sizeof(JSC::EncodedJSValue));

static JSC::VM* ct_jsc_vm(JSContextRef context)
{
    return reinterpret_cast<JSC::VM*>(
        const_cast<OpaqueJSContextGroup*>(JSContextGetGroup(context)));
}

extern "C" void ct_jsc_drain_microtasks(JSContextRef context)
{
    auto* vm = ct_jsc_vm(context);
    JSC::JSLockHolder lock(*vm);
    vm->drainMicrotasks();
}

static JSC::JSGlobalObject* ct_jsc_global_object(JSContextRef context)
{
    return reinterpret_cast<JSC::JSGlobalObject*>(
        const_cast<OpaqueJSContext*>(context));
}

static JSC::EncodedJSValue ct_jsc_encode(JSValueRef value)
{
    return std::bit_cast<JSC::EncodedJSValue>(value);
}

static JSC::EncodedJSValue ct_jsc_throw(
    JSC::JSGlobalObject* global_object,
    const char* message,
    bool type_error = false)
{
    auto context = reinterpret_cast<JSContextRef>(global_object);
    auto message_ref = JSStringCreateWithUTF8CString(message);
    auto text = const_cast<OpaqueJSString*>(message_ref)->string();
    JSStringRelease(message_ref);
    auto* error = type_error
        ? JSC::createTypeError(global_object, text)
        : JSC::createError(global_object, text);
    ct_jsc_vm(context)->throwException(global_object, error);
    return 0;
}

static JSC::EncodedJSValue ct_jsc_buffer_is_ascii(
    JSC::JSGlobalObject* global_object,
    JSC::CallFrame* call_frame)
{
    // CallFrame slots are pinned to WebKit-7624.2.5.10.6. On all supported
    // 64-bit targets, slot 4 stores argumentCountIncludingThis and slot 6 is
    // the first argument.
    const auto* slots = reinterpret_cast<const uint64_t*>(call_frame);
    const auto argument_count_including_this = static_cast<uint32_t>(slots[4]);
    if (argument_count_including_this <= 1)
        return ct_jsc_throw(global_object, "First argument must be an ArrayBufferView", true);

    auto context = reinterpret_cast<JSContextRef>(global_object);
    auto input = std::bit_cast<JSValueRef>(slots[6]);
    if (!JSValueIsObject(context, input))
        return ct_jsc_throw(global_object, "First argument must be an ArrayBufferView", true);

    JSValueRef exception = nullptr;
    auto type = JSValueGetTypedArrayType(context, input, &exception);
    if (exception != nullptr)
        return ct_jsc_throw(global_object, "First argument must be an ArrayBufferView", true);

    auto object = reinterpret_cast<JSObjectRef>(const_cast<OpaqueJSValue*>(input));
    const uint8_t* bytes = nullptr;
    size_t byte_length = 0;
    if (type == kJSTypedArrayTypeArrayBuffer) {
        bytes = static_cast<const uint8_t*>(
            JSObjectGetArrayBufferBytesPtr(context, object, &exception));
        byte_length = JSObjectGetArrayBufferByteLength(context, object, &exception);
    } else if (type != kJSTypedArrayTypeNone) {
        bytes = static_cast<const uint8_t*>(
            JSObjectGetTypedArrayBytesPtr(context, object, &exception));
        byte_length = JSObjectGetTypedArrayByteLength(context, object, &exception);
    } else {
        return ct_jsc_throw(global_object, "First argument must be an ArrayBufferView", true);
    }
    if (exception != nullptr)
        return ct_jsc_throw(global_object, "First argument must be an ArrayBufferView", true);

    bool is_ascii = true;
    for (size_t index = 0; index < byte_length; ++index) {
        if (bytes[index] & 0x80) {
            is_ascii = false;
            break;
        }
    }
    return ct_jsc_encode(JSValueMakeBoolean(context, is_ascii));
}

static JSC::EncodedJSValue ct_jsc_not_implemented(
    JSC::JSGlobalObject* global_object,
    JSC::CallFrame* call_frame)
{
    const auto* slots = reinterpret_cast<const uint64_t*>(call_frame);
    const auto argument_count_including_this = static_cast<uint32_t>(slots[4]);
    if (argument_count_including_this <= 1)
        return ct_jsc_throw(global_object, "Not implemented");

    auto context = reinterpret_cast<JSContextRef>(global_object);
    auto global = JSContextGetGlobalObject(context);
    auto property_name = JSStringCreateWithUTF8CString(
        "__cottontailBufferTranscodeImplementation");
    JSValueRef exception = nullptr;
    auto implementation_value = JSObjectGetProperty(
        context,
        global,
        property_name,
        &exception);
    JSStringRelease(property_name);

    if (exception != nullptr || !JSValueIsObject(context, implementation_value))
        return ct_jsc_throw(global_object, "Not implemented");

    JSValueRef arguments[3];
    auto argument_count = static_cast<size_t>(argument_count_including_this - 1);
    if (argument_count > 3)
        argument_count = 3;
    for (size_t index = 0; index < argument_count; ++index)
        arguments[index] = std::bit_cast<JSValueRef>(slots[6 + index]);

    auto result = JSObjectCallAsFunction(
        context,
        reinterpret_cast<JSObjectRef>(const_cast<OpaqueJSValue*>(implementation_value)),
        nullptr,
        argument_count,
        arguments,
        &exception);
    if (exception != nullptr) {
        auto* error = reinterpret_cast<JSC::JSObject*>(
            const_cast<OpaqueJSValue*>(exception));
        ct_jsc_vm(context)->throwException(global_object, error);
        return 0;
    }
    return ct_jsc_encode(result);
}

extern "C" JSObjectRef ct_jsc_create_buffer_is_ascii(JSContextRef context)
{
    auto* vm = ct_jsc_vm(context);
    JSC::JSLockHolder lock(*vm);
    auto* global_object = ct_jsc_global_object(context);
    auto name_ref = JSStringCreateWithUTF8CString("isAscii");
    auto name = const_cast<OpaqueJSString*>(name_ref)->string();
    JSStringRelease(name_ref);
    auto callback = JSC::NativeFunction(ct_jsc_buffer_is_ascii);
    return reinterpret_cast<JSObjectRef>(JSC::JSFunction::create(
        *vm,
        global_object,
        1,
        name,
        callback,
        JSC::ImplementationVisibility::Public,
        JSC::NoIntrinsic,
        callback,
        nullptr));
}

extern "C" JSObjectRef ct_jsc_create_buffer_transcode(JSContextRef context)
{
    auto* vm = ct_jsc_vm(context);
    JSC::JSLockHolder lock(*vm);
    auto* global_object = ct_jsc_global_object(context);
    auto name_ref = JSStringCreateWithUTF8CString("transcode");
    auto name = const_cast<OpaqueJSString*>(name_ref)->string();
    JSStringRelease(name_ref);
    return reinterpret_cast<JSObjectRef>(
        JSC::InternalFunction::createFunctionThatMasqueradesAsUndefined(
            *vm,
            global_object,
            1,
            name,
            JSC::NativeFunction(ct_jsc_not_implemented)));
}

extern "C" void* ct_jsc_microtask_delay_begin(JSContextGroupRef group)
{
    if (group == nullptr)
        return nullptr;
    auto* vm = reinterpret_cast<JSC::VM*>(const_cast<OpaqueJSContextGroup*>(group));
    return new JSC::VM::DrainMicrotaskDelayScope(*vm);
}

extern "C" void ct_jsc_microtask_delay_end(void* opaque_scope)
{
    delete static_cast<JSC::VM::DrainMicrotaskDelayScope*>(opaque_scope);
}

extern "C" int ct_jsc_promise_status(JSValueRef value)
{
    if (value == nullptr)
        return -1;
    // JSPromise extends JSObject (two pointers) with two encoded internal
    // fields. Field zero is an int32 whose low two bits are the promise state.
    // This layout is pinned to WebKit-7624.2.5.10.6 alongside CallFrame above.
    const auto* fields = reinterpret_cast<const uint64_t*>(value) + 2;
    return static_cast<int>(static_cast<uint32_t>(fields[0]) & 0x3);
}

extern "C" JSValueRef ct_jsc_promise_result(JSValueRef value)
{
    if (value == nullptr)
        return nullptr;
    const auto* fields = reinterpret_cast<const uint64_t*>(value) + 2;
    return std::bit_cast<JSValueRef>(fields[1]);
}

extern "C" uint32_t ct_jsc_weak_collection_size(JSValueRef value)
{
    if (value == nullptr)
        return 0;
    // JSWeakMap/JSWeakSet extend JSNonFinalObject (two pointers) with a buffer
    // pointer followed by capacity, key count, and delete count. This reads the
    // live key count and is pinned to WebKit-7624.2.5.10.6 like the promise and
    // CallFrame layouts above. The JS host only calls it after an instanceof
    // WeakMap/WeakSet check.
    const auto* fields = reinterpret_cast<const uint32_t*>(value);
    constexpr size_t keyCountOffset = (2 * sizeof(void*) + sizeof(void*) + sizeof(uint32_t)) / sizeof(uint32_t);
    return fields[keyCountOffset];
}
