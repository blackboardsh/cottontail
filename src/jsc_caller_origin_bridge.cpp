/*
 * Native callerSourceOrigin helper for the pinned Windows JSC artifact.
 *
 * JSC's rendered Windows stacks discard URL query strings and fragments.
 * Dynamic module factories are compiled with their complete import.meta URL,
 * so read SourceOrigin directly from the JavaScript caller's frame when that
 * exact identity is required.
 */

// The vendored JSC archive uses WTF's release layouts. SourceOrigin owns URL
// and RefPtr fields, so this translation unit must match those layouts even
// when the surrounding Cottontail build is unoptimized.
#ifndef NDEBUG
#define NDEBUG 1
#ifndef RELEASE_WITHOUT_OPTIMIZATIONS
#define RELEASE_WITHOUT_OPTIMIZATIONS 1
#endif
#endif

#include <JavaScriptCore/JSContextRef.h>
#include <JavaScriptCore/JSObjectRef.h>
#include <JavaScriptCore/JSStringRef.h>
#include <JavaScriptCore/JSValueRef.h>

#include <bit>
#include <cstdint>
#include <wtf/FunctionPtr.h>
#include <wtf/RefCounted.h>
#include <wtf/URL.h>

namespace JSC {

using EncodedJSValue = int64_t;

class CallFrame;
class JSGlobalObject;
class VM;

class ScriptFetcher : public WTF::RefCounted<ScriptFetcher> {
public:
    virtual ~ScriptFetcher() = default;
    virtual bool isCachedScriptFetcher() const { return false; }
    virtual bool isWorkerScriptFetcher() const { return false; }
};

class SourceOrigin {
public:
    explicit SourceOrigin(const WTF::URL& url)
        : m_url(url)
    {
    }

    explicit SourceOrigin(const WTF::URL& url, WTF::Ref<ScriptFetcher>&& fetcher)
        : m_url(url)
        , m_fetcher(WTF::move(fetcher))
    {
    }

    SourceOrigin() = default;

    const WTF::URL& url() const { return m_url; }
    const WTF::String& string() const { return m_url.string(); }
    bool isNull() const { return m_url.isNull(); }

private:
    WTF::URL m_url;
    WTF::RefPtr<ScriptFetcher> m_fetcher;
};

class CallFrame {
public:
    SourceOrigin callerSourceOrigin(VM&);
};

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

class JSLockHolder {
public:
    JSLockHolder(VM&);
    ~JSLockHolder();

private:
    VM* m_vm;
};

}

static JSC::VM* ct_jsc_vm(JSContextRef context)
{
    return reinterpret_cast<JSC::VM*>(
        const_cast<OpaqueJSContextGroup*>(JSContextGetGroup(context)));
}

static JSC::JSGlobalObject* ct_jsc_global_object(JSContextRef context)
{
    return reinterpret_cast<JSC::JSGlobalObject*>(
        const_cast<OpaqueJSContext*>(context));
}

static JSC::EncodedJSValue JSC_HOST_CALL_ATTRIBUTES ct_jsc_caller_source_origin(
    JSC::JSGlobalObject* global_object,
    JSC::CallFrame* call_frame)
{
    auto context = reinterpret_cast<JSContextRef>(global_object);
    const auto* slots = reinterpret_cast<const uint64_t*>(call_frame);
    auto* wrapper_frame = reinterpret_cast<JSC::CallFrame*>(slots[0]);
    if (wrapper_frame == nullptr)
        return std::bit_cast<JSC::EncodedJSValue>(JSValueMakeNull(context));

    JSC::SourceOrigin source_origin = wrapper_frame->callerSourceOrigin(*ct_jsc_vm(context));
    if (source_origin.isNull())
        return std::bit_cast<JSC::EncodedJSValue>(JSValueMakeNull(context));

    auto utf8 = source_origin.string().utf8();
    auto string = JSStringCreateWithUTF8CString(utf8.data());
    auto result = JSValueMakeString(context, string);
    JSStringRelease(string);
    return std::bit_cast<JSC::EncodedJSValue>(result);
}

extern "C" JSObjectRef ct_jsc_create_caller_source_origin(JSContextRef context)
{
    auto* vm = ct_jsc_vm(context);
    JSC::JSLockHolder lock(*vm);
    auto* global_object = ct_jsc_global_object(context);
    auto name = WTF::String::fromLatin1("callerSourceOriginInternal");
    auto callback = JSC::NativeFunction(ct_jsc_caller_source_origin);
    return reinterpret_cast<JSObjectRef>(JSC::JSFunction::create(
        *vm,
        global_object,
        0,
        name,
        callback,
        JSC::ImplementationVisibility::Private,
        JSC::NoIntrinsic,
        callback,
        nullptr));
}
