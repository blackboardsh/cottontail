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
#include <cstdlib>
#include <cstdio>
#include <cstdint>
#include <cstddef>
#include <span>
#include <utility>
#include <vector>
#include <wtf/Function.h>
#include <wtf/ThreadSafeRefCounted.h>
#if defined(_WIN32)
#include <wtf/MainThread.h>
#endif
#include <wtf/PtrTag.h>
#include <wtf/text/ExternalStringImpl.h>
#include <wtf/text/StringImpl.h>

namespace WTF {

// Minimal ABI declaration for the pinned JSCOnly artifact. Its installed
// RunLoop.h depends on private platform headers that the artifact omits.
#if defined(__linux__)
void initializeMainThread();
#endif

class RunLoop {
public:
    enum class CycleResult { Continue, Stop };
    static RunLoop& currentSingleton();
    void dispatch(Function<void()>&&);
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

    StringImpl* impl() const { return m_impl; }

    static String adopt(StringImpl& impl)
    {
        String string;
        string.m_impl = &impl;
        return string;
    }

private:
    StringImpl* m_impl { nullptr };
};

}

struct OpaqueJSString : public ThreadSafeRefCounted<OpaqueJSString> {
    static RefPtr<OpaqueJSString> tryCreate(WTF::String&&);
    // Keep this declaration ABI-owned by JavaScriptCore. Without it, MSVC
    // synthesizes another public destructor in this bridge object.
    ~OpaqueJSString();
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

using CtExternalStringFinalize = void (*)(void*, void*, size_t);

#if defined(__linux__)
// The Linux JSC artifact is built with libstdc++, while Zig compiles this
// bridge with libc++. std::span has the same pinned two-word ABI in both, but
// a different mangled namespace. Name the two GNU symbols explicitly rather
// than introducing a second C++ runtime into Cottontail's own objects.
template<typename Character>
struct GnuExternalStringSpan {
    const Character* data;
    size_t size;
};

using ExternalStringFreeFunction = WTF::ExternalStringImplFreeFunction;

extern WTF::Ref<WTF::ExternalStringImpl> create_external_latin1_gnu(
    GnuExternalStringSpan<uint8_t>,
    ExternalStringFreeFunction&&)
    asm("_ZN3WTF18ExternalStringImpl6createESt4spanIKhLm18446744073709551615EEONS_8FunctionIFvPS0_PvjEEE");
extern WTF::Ref<WTF::ExternalStringImpl> create_external_utf16_gnu(
    GnuExternalStringSpan<char16_t>,
    ExternalStringFreeFunction&&)
    asm("_ZN3WTF18ExternalStringImpl6createESt4spanIKDsLm18446744073709551615EEONS_8FunctionIFvPS0_PvjEEE");
#endif

static WTF::Ref<WTF::ExternalStringImpl> create_external_impl(
    std::span<const uint8_t> characters,
    WTF::ExternalStringImplFreeFunction&& finalize)
{
#if defined(__linux__)
    static_assert(sizeof(GnuExternalStringSpan<uint8_t>) == sizeof(char*) + sizeof(size_t));
    return create_external_latin1_gnu(
        { characters.data(), characters.size() },
        std::move(finalize));
#else
    return WTF::ExternalStringImpl::create(characters, std::move(finalize));
#endif
}

static WTF::Ref<WTF::ExternalStringImpl> create_external_impl(
    std::span<const char16_t> characters,
    WTF::ExternalStringImplFreeFunction&& finalize)
{
#if defined(__linux__)
    static_assert(sizeof(GnuExternalStringSpan<char16_t>) == sizeof(char*) + sizeof(size_t));
    return create_external_utf16_gnu(
        { characters.data(), characters.size() },
        std::move(finalize));
#else
    return WTF::ExternalStringImpl::create(characters, std::move(finalize));
#endif
}

template<typename Character>
static JSStringRef create_external_string(
    const Character* characters,
    size_t length,
    CtExternalStringFinalize finalize,
    void* context)
{
    if (characters == nullptr || length == 0 || finalize == nullptr)
        return nullptr;

    auto impl = create_external_impl(
        std::span<const Character>(characters, length),
        [finalize, context](WTF::ExternalStringImpl*, void* buffer, unsigned buffer_size) {
            finalize(context, buffer, buffer_size);
        });
    auto string = WTF::String::adopt(impl.leakRef());
    auto opaque = OpaqueJSString::tryCreate(std::move(string));
    return opaque.leakRef();
}

extern "C" JSStringRef ct_jsc_string_create_external_latin1(
    const uint8_t* characters,
    size_t length,
    CtExternalStringFinalize finalize,
    void* context)
{
    return create_external_string(characters, length, finalize, context);
}

extern "C" JSStringRef ct_jsc_string_create_external_utf16(
    const char16_t* characters,
    size_t length,
    CtExternalStringFinalize finalize,
    void* context)
{
    return create_external_string(characters, length, finalize, context);
}

extern "C" void ct_jsc_run_loop_cycle()
{
    WTF::RunLoop::cycle(0);
}

extern "C" void* ct_jsc_run_loop_current()
{
    return &WTF::RunLoop::currentSingleton();
}

extern "C" void ct_jsc_run_loop_dispatch(void* run_loop, void (*callback)(void*), void* context)
{
    if (run_loop == nullptr || callback == nullptr)
        return;
    static_cast<WTF::RunLoop*>(run_loop)->dispatch([callback, context] {
        callback(context);
    });
}

#if defined(_WIN32) || defined(__linux__)
extern "C" void ct_jsc_initialize_main_thread()
{
    // The public JSContext API initializes JSC/WTF, but it does not establish
    // WTF's main RunLoop on the generic static ports. JSC's delayed GC
    // callbacks eventually consult the process-wide MemoryPressureHandler,
    // whose timer is bound to that main RunLoop. Match WebKit's own `jsc`
    // embedding sequence before the first VM is created.
    WTF::initializeMainThread();
}
#endif

namespace JSC {
using EncodedJSValue = int64_t;

class CallFrame;
class Exception;
class HeapAnalyzer;
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
    Exception* cottontailThrowException(JSGlobalObject* global_object, JSObject* exception)
    {
        return throwException(global_object, exception);
    }

private:
    // Access control is part of an MSVC C++ symbol name. WebKit declares this
    // overload private, so keeping it private here is required when linking
    // the static Windows SDK. The public inline wrapper is Cottontail-only.
    Exception* throwException(JSGlobalObject*, JSObject*);
};

// Heap profiling is a stock JSC facility, but JSCOnly does not install its
// private headers. These opaque declarations are pinned to the vendored
// WebKit release, just like the CallFrame and OpaqueJSString ABI bridges in
// this file. The storage deliberately exceeds the private class layouts.
class HeapProfiler {
public:
    explicit HeapProfiler(VM&);
    ~HeapProfiler();
    void clearSnapshots();
    void setActiveHeapAnalyzer(HeapAnalyzer*);

private:
    alignas(std::max_align_t) unsigned char m_storage[256];
};

class HeapSnapshotBuilder {
public:
    enum SnapshotType { InspectorSnapshot, GCDebuggingSnapshot };

    HeapSnapshotBuilder(HeapProfiler&, SnapshotType = InspectorSnapshot);
    // The real class inherits HeapAnalyzer and declares a final virtual
    // destructor. Virtualness is part of its MSVC C++ symbol name.
    virtual ~HeapSnapshotBuilder();
    void buildSnapshot();
    WTF::String json();

private:
    alignas(std::max_align_t) unsigned char m_storage[4096];
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

static char* ct_jsc_copy_utf8(const WTF::String& value)
{
    auto* impl = value.impl();
    if (impl == nullptr)
        return nullptr;

    JSStringRef string = nullptr;
    if (impl->is8Bit()) {
        auto source = impl->span8();
        std::vector<JSChar> characters(source.size());
        for (size_t index = 0; index < source.size(); ++index)
            characters[index] = static_cast<JSChar>(source[index]);
        string = JSStringCreateWithCharacters(characters.data(), characters.size());
    } else {
        auto source = impl->span16();
        static_assert(sizeof(char16_t) == sizeof(JSChar));
        string = JSStringCreateWithCharacters(
            reinterpret_cast<const JSChar*>(source.data()), source.size());
    }
    if (string == nullptr)
        return nullptr;

    size_t capacity = JSStringGetMaximumUTF8CStringSize(string);
    char* result = static_cast<char*>(std::malloc(capacity));
    if (result == nullptr) {
        JSStringRelease(string);
        return nullptr;
    }
    size_t written = JSStringGetUTF8CString(string, result, capacity);
    JSStringRelease(string);
    if (written == 0) {
        std::free(result);
        return nullptr;
    }
    return result;
}

extern "C" char* ct_jsc_heap_snapshot(JSContextRef context, int gc_debugging)
{
    if (context == nullptr)
        return nullptr;
    auto* vm = ct_jsc_vm(context);
    JSC::JSLockHolder lock(*vm);

    // VM::ensureHeapProfiler() is inline in a private header omitted by the
    // JSCOnly artifact. Locate m_activeHeapAnalyzer with a temporary sentinel,
    // then use the pinned field delta to reach the adjacent LazyUniqueRef. The
    // tagged slot itself supplies JSC's real initializer function, so ownership
    // and destruction remain with the VM. Fail closed if the layout changes.
    JSC::HeapProfiler probe(*vm);
    alignas(std::max_align_t) unsigned char sentinel;
    probe.setActiveHeapAnalyzer(reinterpret_cast<JSC::HeapAnalyzer*>(&sentinel));
    constexpr size_t vm_scan_size = 128 * 1024;
    constexpr ptrdiff_t heap_profiler_delta = 184;
    uintptr_t* active_slot = nullptr;
    auto* vm_bytes = reinterpret_cast<unsigned char*>(vm);
    for (size_t offset = 0; offset + sizeof(void*) <= vm_scan_size; offset += alignof(void*)) {
        auto* candidate = reinterpret_cast<uintptr_t*>(vm_bytes + offset);
        if (*candidate == reinterpret_cast<uintptr_t>(&sentinel)) {
            active_slot = candidate;
            break;
        }
    }
    probe.setActiveHeapAnalyzer(nullptr);
    if (active_slot == nullptr)
        return nullptr;

    auto* lazy_slot = reinterpret_cast<uintptr_t*>(
        reinterpret_cast<unsigned char*>(active_slot) + heap_profiler_delta);
    uintptr_t tagged_pointer = *lazy_slot;
    bool debug = std::getenv("COTTONTAIL_JSC_DEBUG") != nullptr;
    if (debug) {
        std::fprintf(
            stderr,
            "cottontail: JSC heap profiler active_offset=%td lazy_offset=%td tagged=%p\n",
            reinterpret_cast<unsigned char*>(active_slot) - vm_bytes,
            reinterpret_cast<unsigned char*>(lazy_slot) - vm_bytes,
            reinterpret_cast<void*>(tagged_pointer));
    }
    if (tagged_pointer == 0)
        return nullptr;

    JSC::HeapProfiler* profiler = nullptr;
    if (tagged_pointer & 1) {
        if ((tagged_pointer & 3) != 1)
            return nullptr;
        using LazyInitializer = JSC::HeapProfiler* (*)(JSC::VM&, void*);
        auto* initializer_slot = reinterpret_cast<LazyInitializer*>(tagged_pointer & ~uintptr_t(3));
        LazyInitializer initializer = *initializer_slot;
        if (initializer == nullptr)
            return nullptr;
        profiler = initializer(*vm, lazy_slot);
    } else
        profiler = reinterpret_cast<JSC::HeapProfiler*>(tagged_pointer);
    if (debug) {
        std::fprintf(
            stderr,
            "cottontail: JSC heap profiler initialized=%p slot=%p\n",
            static_cast<void*>(profiler),
            reinterpret_cast<void*>(*lazy_slot));
    }
    if (profiler == nullptr || *reinterpret_cast<JSC::VM**>(profiler) != vm)
        return nullptr;

    profiler->clearSnapshots();
    char* result = nullptr;
    {
        const auto snapshot_type = gc_debugging
            ? JSC::HeapSnapshotBuilder::GCDebuggingSnapshot
            : JSC::HeapSnapshotBuilder::InspectorSnapshot;
        JSC::HeapSnapshotBuilder builder(*profiler, snapshot_type);
        builder.buildSnapshot();
        auto json = builder.json();
        result = ct_jsc_copy_utf8(json);
    }
    profiler->clearSnapshots();
    return result;
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
    ct_jsc_vm(context)->cottontailThrowException(global_object, error);
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
        ct_jsc_vm(context)->cottontailThrowException(global_object, error);
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

    // On 64-bit JSC, cells are the only JSValues with neither NumberTag nor
    // OtherTag set. JSPromiseType is 0x51 in WebKit-7624.2.5.10.6 and lives
    // at byte five of JSCell's header. Validate both before reading the two
    // JSPromise internal fields below; this bridge is pinned to that build.
    constexpr uint64_t not_cell_mask = 0xfffe000000000002ULL;
    const auto encoded = std::bit_cast<uint64_t>(value);
    if ((encoded & not_cell_mask) != 0)
        return -1;
    const auto* cell = reinterpret_cast<const uint8_t*>(value);
    constexpr uint8_t js_promise_type = 0x51;
    if (cell[5] != js_promise_type)
        return -1;

    // JSPromise extends JSObject (two words) with two encoded fields. Field
    // zero contains an int32 whose low two bits are the promise state.
    const auto* fields = reinterpret_cast<const uint64_t*>(value) + 2;
    return static_cast<int>(static_cast<uint32_t>(fields[0]) & 0x3);
}

extern "C" bool ct_jsc_array_buffer_view_has_buffer(JSValueRef value)
{
    if (value == nullptr)
        return false;

    // JSArrayBufferView extends the two-word JSObject with m_vector,
    // m_length, m_byteOffset, then its uint8_t TypedArrayMode. Bit 0x08 is
    // JSC's isHavingArrayBufferMode. Calling possiblySharedBuffer() here would
    // materialize the buffer for FastTypedArray and change the queried state.
    static_assert(sizeof(void*) == 8);
    constexpr size_t typed_array_mode_offset = 5 * sizeof(void*);
    constexpr uint8_t is_having_array_buffer_mode = 0x08;
    const auto* cell = reinterpret_cast<const uint8_t*>(value);
    return (cell[typed_array_mode_offset] & is_having_array_buffer_mode) != 0;
}

extern "C" JSValueRef ct_jsc_promise_result(JSValueRef value)
{
    if (ct_jsc_promise_status(value) < 0)
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
