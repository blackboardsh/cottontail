#include "napi_bridge.h"

#include "compiler/src/napi/node_api.h"

#include <JavaScriptCore/JSTypedArray.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <functional>
#include <limits>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <uv.h>
#include <vector>

using CtExternalStringFinalize = void (*)(void*, void*, size_t);
extern "C" JSStringRef ct_jsc_string_create_external_latin1(
    const uint8_t*,
    size_t,
    CtExternalStringFinalize,
    void*);
extern "C" JSStringRef ct_jsc_string_create_external_utf16(
    const char16_t*,
    size_t,
    CtExternalStringFinalize,
    void*);
extern "C" void* ct_jsc_microtask_delay_begin(JSContextGroupRef);
extern "C" void ct_jsc_microtask_delay_end(void*);
extern "C" bool ct_jsc_string_is_8_bit(JSStringRef);

// COTTONTAIL-COMPAT: A native weak handle can clear during the current job;
// JavaScript WeakRef intentionally keeps its target alive until the job ends.
typedef const struct OpaqueJSWeak* CtJSWeakRef;
extern "C" CtJSWeakRef JSWeakCreate(JSContextGroupRef, JSObjectRef);
extern "C" void JSWeakRelease(JSContextGroupRef, CtJSWeakRef);
extern "C" JSObjectRef JSWeakGetObject(CtJSWeakRef);

namespace v8 {
namespace internal {
class Isolate;
}

template<typename T>
class Local {
public:
    Local() = default;
    explicit Local(uintptr_t* location)
        : location(location)
    {
    }
    template<typename U>
    Local(const Local<U>& other)
        : location(other.location)
    {
    }
    bool IsEmpty() const { return !location; }
    T* operator->() const { return reinterpret_cast<T*>(location); }

    uintptr_t* location { nullptr };
};

template<typename T>
class MaybeLocal {
public:
    MaybeLocal() = default;
    explicit MaybeLocal(Local<T> value)
        : value(value)
    {
    }
    template<typename U>
    MaybeLocal(Local<U> value)
        : value(value)
    {
    }

    Local<T> value;
};

template<typename T>
class Maybe {
public:
    Maybe() = default;
    explicit Maybe(T value)
        : has_value(true)
        , value(value)
    {
    }

    bool has_value { false };
    T value {};
};

template<>
class Maybe<void> {
public:
    Maybe() = default;
    explicit Maybe(bool value)
        : has_value(value)
    {
    }

    bool has_value { false };
};

class Data;
class Context;
class Value;
class Primitive;
class Boolean;
class Number;
class External;
class Object;
class Array;
class String;
class Function;
class FunctionTemplate;
class ObjectTemplate;
class Signature;
class CFunction;

template<typename T>
class FunctionCallbackInfo {
public:
    void* implicit_args { nullptr };
    uintptr_t* values { nullptr };
    uintptr_t length { 0 };
};

using FunctionCallback = void (*)(const FunctionCallbackInfo<Value>&);

enum class NewStringType {
    kNormal,
    kInternalized,
};

enum class ConstructorBehavior {
    kThrow,
    kAllow,
};

enum class SideEffectType {
    kHasSideEffect,
    kHasNoSideEffect,
    kHasSideEffectToReceiver,
};

class Isolate {
public:
    static Isolate* GetCurrent();
    Local<Context> GetCurrentContext();
};

class HandleScope {
public:
    explicit HandleScope(Isolate*);
    ~HandleScope();
    static uintptr_t* CreateHandle(internal::Isolate*, uintptr_t);

protected:
    void* storage[3] {};
};

class EscapableHandleScopeBase : public HandleScope {
public:
    explicit EscapableHandleScopeBase(Isolate*);

protected:
    uintptr_t* EscapeSlot(uintptr_t*);

private:
    uintptr_t* escape_slot { nullptr };
};

class Data { };

class Value : public Data {
public:
    bool FullIsFalse() const;
    bool FullIsTrue() const;
    bool IsArray() const;
    bool IsBigInt() const;
    bool IsBoolean() const;
    bool IsFunction() const;
    bool IsInt32() const;
    bool IsMap() const;
    bool IsNumber() const;
    bool IsObject() const;
    bool IsUint32() const;
    bool StrictEquals(Local<Value>) const;
};

class Primitive : public Value { };
class Boolean : public Primitive { };

class Number : public Primitive {
public:
    static Local<Number> New(Isolate*, double);
    double Value() const;
};

class External : public Value {
public:
    static Local<External> New(Isolate*, void*);
    void* Value() const;
};

class Context : public Value {
public:
    Isolate* GetIsolate();
};

class String : public Value {
public:
    static MaybeLocal<String> NewFromUtf8(Isolate*, const char*, NewStringType, int length = -1);
    static MaybeLocal<String> NewFromOneByte(Isolate*, const uint8_t*, NewStringType, int length = -1);
    bool ContainsOnlyOneByte() const;
    bool IsExternal() const;
    bool IsExternalOneByte() const;
    bool IsExternalTwoByte() const;
    bool IsOneByte() const;
    int Length() const;
    int Utf8Length(Isolate*) const;
    int WriteUtf8(Isolate*, char*, int length = -1, int* nchars = nullptr, int options = 0) const;
};

class Object : public Value {
public:
    static Local<Object> New(Isolate*);
    MaybeLocal<Value> Get(Local<Context>, uint32_t);
    MaybeLocal<Value> Get(Local<Context>, Local<Value>);
    void SetInternalField(int, Local<Data>);
    Local<Data> SlowGetInternalField(int);
    Maybe<bool> Set(Local<Context>, uint32_t, Local<Value>);
    Maybe<bool> Set(Local<Context>, Local<Value>, Local<Value>);
};

class Array : public Object {
public:
    enum class CallbackResult {
        kException,
        kBreak,
        kContinue,
    };
    using IterationCallback = CallbackResult (*)(uint32_t, Local<Value>, void*);

    static Local<Array> New(Isolate*, int length = 0);
    static Local<Array> New(Isolate*, Local<Value>*, size_t);
    static MaybeLocal<Array> New(Local<Context>, size_t, std::function<MaybeLocal<Value>()>);
    Maybe<void> Iterate(Local<Context>, IterationCallback, void*);
    uint32_t Length() const;
};

class Function : public Object {
public:
    Local<Value> GetName() const;
    void SetName(Local<String>);
};

class ObjectTemplate : public Data {
public:
    static Local<ObjectTemplate> New(Isolate*, Local<FunctionTemplate> = Local<FunctionTemplate>());
    int InternalFieldCount() const;
    MaybeLocal<Object> NewInstance(Local<Context>);
    void SetInternalFieldCount(int);
};

class FunctionTemplate : public Value {
public:
    static Local<FunctionTemplate> New(
        Isolate*,
        FunctionCallback = nullptr,
        Local<Value> = Local<Value>(),
        Local<Signature> = Local<Signature>(),
        int = 0,
        ConstructorBehavior = ConstructorBehavior::kAllow,
        SideEffectType = SideEffectType::kHasSideEffect,
        const CFunction* = nullptr,
        uint16_t = 0,
        uint16_t = 0,
        uint16_t = 0);
    MaybeLocal<Function> GetFunction(Local<Context>);
};

namespace api_internal {
void ToLocalEmpty();
void FromJustIsNothing();
uintptr_t* GlobalizeReference(internal::Isolate*, uintptr_t);
void DisposeGlobal(uintptr_t*);
Local<Value> GetFunctionTemplateData(Isolate*, Local<Data>);
}

namespace internal {
Isolate* IsolateFromNeverReadOnlySpaceObject(uintptr_t);
}
}

namespace node {
using addon_register_func = void (*)(v8::Local<v8::Object>, v8::Local<v8::Value>, void*);
using addon_context_register_func = void (*)(v8::Local<v8::Object>, v8::Local<v8::Value>, v8::Local<v8::Context>, void*);

struct node_module {
    int nm_version;
    unsigned int nm_flags;
    void* nm_dso_handle;
    const char* nm_filename;
    addon_register_func nm_register_func;
    addon_context_register_func nm_context_register_func;
    const char* nm_modname;
    void* nm_priv;
    node_module* nm_link;
};

void AddEnvironmentCleanupHook(v8::Isolate*, void (*)(void*), void*);
void RemoveEnvironmentCleanupHook(v8::Isolate*, void (*)(void*), void*);
}

extern "C" void node_module_register(void*);

struct napi_handle_scope__ {
    NapiEnv* env { nullptr };
    napi_handle_scope__* parent { nullptr };
    std::vector<JSValueRef> values;
    bool escapable { false };
    bool escaped { false };
    bool closed { false };
};

struct napi_callback_info__ {
    NapiEnv* env { nullptr };
    size_t argc { 0 };
    const JSValueRef* argv { nullptr };
    JSValueRef this_value { nullptr };
    JSValueRef new_target { nullptr };
    void* data { nullptr };
};

struct NapiFinalizerData;

struct napi_ref__ {
    NapiEnv* env { nullptr };
    JSValueRef value { nullptr };
    JSObjectRef weak_ref { nullptr };
    uint32_t count { 0 };
    bool primitive { false };
    bool strong { false };
    bool always_strong { false };
    bool deleted { false };
    bool invalidated { false };
    NapiFinalizerData* owner_finalizer { nullptr };
};

struct napi_deferred__ {
    NapiEnv* env { nullptr };
    JSObjectRef resolve { nullptr };
    JSObjectRef reject { nullptr };
    bool settled { false };
};

struct napi_async_context__ {
    NapiEnv* env { nullptr };
    JSObjectRef record { nullptr };
    CtJSWeakRef resource { nullptr };
};

struct napi_callback_scope__ {
    NapiEnv* env { nullptr };
    JSObjectRef token { nullptr };
    bool had_pending_exception { false };
};

struct napi_async_work__ {
    NapiEnv* env { nullptr };
    uv_work_t request {};
    napi_async_context async_context { nullptr };
    napi_async_execute_callback execute { nullptr };
    napi_async_complete_callback complete { nullptr };
    void* data { nullptr };
    std::atomic<int> state { 0 }; // 0 created, 1 queued, 2 running, 3 complete, 4 cancelled, 5 delivered
    std::atomic<bool> delete_requested { false };
};

struct NapiCleanupHook {
    void (*callback)(void*) { nullptr };
    void* data { nullptr };
    uint64_t order { 0 };
};

struct napi_async_cleanup_hook_handle__ {
    NapiEnv* env { nullptr };
    napi_async_cleanup_hook callback { nullptr };
    void* data { nullptr };
    uint64_t order { 0 };
    bool removed { false };
    bool executing { false };
};

struct NapiFunctionData {
    NapiEnv* env { nullptr };
    napi_callback callback { nullptr };
    void* data { nullptr };
    bool class_constructor { false };
};

struct NapiFinalizerData {
    NapiEnv* env { nullptr };
    void* data { nullptr };
    void* hint { nullptr };
    napi_finalize callback { nullptr };
    bool active { true };
    bool external { false };
    bool basic { false };
    napi_ref__* wrap_ref { nullptr };
};

struct NapiPostedFinalizer {
    napi_finalize callback { nullptr };
    void* data { nullptr };
    void* hint { nullptr };
    bool is_finalizer { true };
};

struct NapiBufferFinalizer {
    NapiEnv* env { nullptr };
    void* data { nullptr };
    void* hint { nullptr };
    napi_finalize callback { nullptr };
    bool owns_data { false };
    bool finalized { false };
};

struct NapiTypeTagData {
    uint64_t lower { 0 };
    uint64_t upper { 0 };
};

struct NapiTsfnCall {
    void* data { nullptr };
};

enum class NapiEventLoopLifecycle : uint8_t {
    unavailable,
    active,
    cleanup,
};

struct napi_threadsafe_function__ {
    NapiEnv* env { nullptr };
    JSValueRef callback { nullptr };
    napi_async_context async_context { nullptr };
    void* context { nullptr };
    void* finalize_data { nullptr };
    napi_finalize finalize_callback { nullptr };
    napi_threadsafe_function_call_js call_js { nullptr };
    size_t max_queue_size { 0 };
    std::mutex mutex;
    std::condition_variable space_available;
    std::deque<NapiTsfnCall> queue;
    size_t thread_count { 0 };
    bool closing { false };
    bool aborting { false };
    bool referenced { true };
    bool finalized { false };
    bool teardown_started { false };
    bool teardown_complete { false };
};

struct NapiEnv {
    NapiEnv* runtime_root { nullptr };
    JSGlobalContextRef context { nullptr };
    JSObjectRef function_call { nullptr };
    // The runtime owns this loop. Only the root env stores the borrowed pointer.
    uv_loop_t* event_loop { nullptr };
    NapiEventLoopLifecycle event_loop_lifecycle { NapiEventLoopLifecycle::unavailable };
    void* wake_opaque { nullptr };
    CtNapiWakeCallback wake_callback { nullptr };
    napi_extended_error_info last_error {};
    JSValueRef pending_exception { nullptr };
    napi_handle_scope__* current_scope { nullptr };
    std::unordered_set<napi_ref__*> references;
    std::unordered_set<NapiFinalizerData*> finalizers;
    std::unordered_set<NapiBufferFinalizer*> buffer_finalizers;
    std::unordered_set<napi_async_work__*> async_work;
    std::unordered_set<napi_async_context__*> async_contexts;
    std::unordered_set<napi_threadsafe_function__*> thread_safe_functions;
    std::vector<NapiCleanupHook> cleanup_hooks;
    std::vector<napi_async_cleanup_hook_handle__*> async_cleanup_hooks;
    std::mutex async_mutex;
    std::deque<napi_async_work__*> completed_work;
    std::deque<NapiPostedFinalizer> basic_finalizers;
    std::deque<NapiPostedFinalizer> posted_finalizers;
    std::vector<NapiEnv*> addon_envs;
    std::unordered_map<std::string, NapiEnv*> ffi_envs;
    void* instance_data { nullptr };
    void* instance_hint { nullptr };
    napi_finalize instance_finalizer { nullptr };
    int64_t external_memory { 0 };
    uint64_t next_async_id { 1 };
    uint64_t next_cleanup_order { 1 };
    int32_t module_api_version { NAPI_VERSION };
    std::string module_filename;
    void* addon_handle { nullptr };
    JSValueRef addon_exports { nullptr };
    void* legacy_v8_state { nullptr };
    std::string wrap_key;
    uint64_t finalizer_key { 1 };
    JSObjectRef wrap_map { nullptr };
    JSObjectRef logically_detached_buffers { nullptr };
    std::thread::id owner_thread;
    bool destroying { false };
    bool in_finalizer { false };
    bool in_basic_finalizer { false };
};

namespace {

constexpr const char* error_messages[] = {
    nullptr,
    "Invalid argument",
    "An object was expected",
    "A string was expected",
    "A string or symbol was expected",
    "A function was expected",
    "A number was expected",
    "A boolean was expected",
    "An array was expected",
    "Unknown failure",
    "An exception is pending",
    "The async work item was cancelled",
    "The escapable handle scope has already been escaped",
    "Handle scope mismatch",
    "Callback scope mismatch",
    "Thread-safe function queue is full",
    "Thread-safe function is closing",
    "A BigInt was expected",
    "A Date was expected",
    "An ArrayBuffer was expected",
    "A detachable ArrayBuffer was expected",
    "The operation would deadlock",
    "External buffers are not allowed",
    "JavaScript execution is not allowed",
};

struct RegisteredModule;
struct ModuleRegistrationSession;

static thread_local NapiEnv* loading_env;
static thread_local ModuleRegistrationSession* module_registration_session;
static thread_local NapiEnv* active_env;
static unsigned char empty_external_buffer_sentinel;

static constexpr uintptr_t legacy_v8_pointer_tag = 1;
static constexpr uintptr_t legacy_v8_tag_mask = 3;

static uintptr_t legacy_v8_tag_pointer(const void* pointer)
{
    return reinterpret_cast<uintptr_t>(pointer) | legacy_v8_pointer_tag;
}

static uintptr_t legacy_v8_tag_smi(int32_t value)
{
    return static_cast<uintptr_t>(static_cast<uint32_t>(value)) << 32;
}

enum class LegacyV8InstanceType : uint16_t {
    string = 0x7f,
    object = 0x80,
    heap_number = 0x82,
    oddball = 0x83,
};

struct alignas(8) LegacyV8Map {
    uintptr_t meta_map { 0 };
    uint32_t unused { 0xaaaaaaaa };
    LegacyV8InstanceType instance_type { LegacyV8InstanceType::object };

    enum class MetaTag { meta };

    explicit LegacyV8Map(MetaTag)
        : meta_map(legacy_v8_tag_pointer(this))
    {
    }

    explicit LegacyV8Map(LegacyV8InstanceType type)
        : meta_map(legacy_v8_tag_pointer(&map_map()))
        , instance_type(type)
    {
    }

    static const LegacyV8Map& map_map()
    {
        static const LegacyV8Map map(MetaTag::meta);
        return map;
    }

    static const LegacyV8Map& object_map()
    {
        static const LegacyV8Map map(LegacyV8InstanceType::object);
        return map;
    }

    static const LegacyV8Map& string_map()
    {
        static const LegacyV8Map map(LegacyV8InstanceType::string);
        return map;
    }

    static const LegacyV8Map& heap_number_map()
    {
        static const LegacyV8Map map(LegacyV8InstanceType::heap_number);
        return map;
    }

    static const LegacyV8Map& oddball_map()
    {
        static const LegacyV8Map map(LegacyV8InstanceType::oddball);
        return map;
    }
};

static_assert(sizeof(LegacyV8Map) == 16);
static_assert(offsetof(LegacyV8Map, instance_type) == 12);

enum class LegacyV8OddballKind : int32_t {
    undefined = 4,
    null = 3,
    true_value = 99,
    false_value = 98,
};

struct alignas(8) LegacyV8Oddball {
    uintptr_t map { legacy_v8_tag_pointer(&LegacyV8Map::oddball_map()) };
    uintptr_t unused[4] {};
    uintptr_t kind { 0 };

    explicit LegacyV8Oddball(LegacyV8OddballKind value)
        : kind(legacy_v8_tag_smi(static_cast<int32_t>(value)))
    {
    }
};

static_assert(offsetof(LegacyV8Oddball, kind) == 40);

static const LegacyV8Oddball& legacy_v8_undefined()
{
    static const LegacyV8Oddball value(LegacyV8OddballKind::undefined);
    return value;
}

static const LegacyV8Oddball& legacy_v8_null()
{
    static const LegacyV8Oddball value(LegacyV8OddballKind::null);
    return value;
}

static const LegacyV8Oddball& legacy_v8_true()
{
    static const LegacyV8Oddball value(LegacyV8OddballKind::true_value);
    return value;
}

static const LegacyV8Oddball& legacy_v8_false()
{
    static const LegacyV8Oddball value(LegacyV8OddballKind::false_value);
    return value;
}

enum class LegacyV8HeapKind : uint8_t {
    js_value,
    number,
    external,
    function_template,
    function_target,
    object_template,
};

struct alignas(8) LegacyV8HeapObject {
    uintptr_t map { 0 };
    union {
        JSValueRef js_value;
        double number;
        void* pointer;
    } payload {};
    LegacyV8HeapKind kind { LegacyV8HeapKind::js_value };
    void (*destroy_payload)(void*) { nullptr };

    ~LegacyV8HeapObject()
    {
        if (destroy_payload)
            destroy_payload(payload.pointer);
    }
};

static_assert(offsetof(LegacyV8HeapObject, map) == 0);
static_assert(offsetof(LegacyV8HeapObject, payload) == 8);

struct LegacyV8Handle {
    uintptr_t raw { 0 };
    JSValueRef protected_value { nullptr };
    void* owned_value { nullptr };
    void (*destroy_owned)(void*) { nullptr };
};

struct LegacyV8ScopeData {
    NapiEnv* env { nullptr };
    LegacyV8ScopeData* previous { nullptr };
    std::deque<LegacyV8Handle> handles;
};

struct LegacyV8IsolateData {
    void* state { nullptr };
    NapiEnv* env { nullptr };
    uintptr_t padding[78] {};
    uintptr_t roots[9] {};
};

static_assert(offsetof(LegacyV8IsolateData, roots) == 640);

struct LegacyV8InternalFields {
    std::vector<JSValueRef> values;
    std::vector<bool> initialized;
};

struct LegacyV8State {
    explicit LegacyV8State(NapiEnv* owner)
        : env(owner)
    {
        isolate.state = this;
        isolate.env = owner;
        isolate.roots[4] = legacy_v8_tag_pointer(&legacy_v8_undefined());
        isolate.roots[5] = isolate.roots[4];
        isolate.roots[6] = legacy_v8_tag_pointer(&legacy_v8_null());
        isolate.roots[7] = legacy_v8_tag_pointer(&legacy_v8_true());
        isolate.roots[8] = legacy_v8_tag_pointer(&legacy_v8_false());
    }

    NapiEnv* env { nullptr };
    LegacyV8IsolateData isolate;
    std::unordered_map<JSObjectRef, LegacyV8InternalFields> internal_fields;
};

struct LegacyV8FunctionTemplateData {
    v8::FunctionCallback callback { nullptr };
    JSValueRef data { nullptr };
};

struct LegacyV8FunctionData {
    NapiEnv* env { nullptr };
    JSGlobalContextRef context { nullptr };
    v8::FunctionCallback callback { nullptr };
    JSValueRef data { nullptr };
};

struct LegacyV8ObjectTemplateData {
    int internal_field_count { 0 };
};

static thread_local LegacyV8ScopeData* legacy_v8_scope;

class ActiveEnvScope {
public:
    explicit ActiveEnvScope(NapiEnv* env)
        : previous(active_env)
    {
        active_env = env;
    }

    ~ActiveEnvScope()
    {
        active_env = previous;
    }

private:
    NapiEnv* previous;
};

enum class RegisteredModuleKind {
    napi,
    legacy,
};

struct RegisteredModule {
    RegisteredModuleKind kind { RegisteredModuleKind::napi };
    napi_module napi_module_data {};
    node::node_module* legacy_module { nullptr };

    static RegisteredModule from_napi(const napi_module& module)
    {
        RegisteredModule registration;
        registration.kind = RegisteredModuleKind::napi;
        registration.napi_module_data = module;
        return registration;
    }

    static RegisteredModule from_legacy(node::node_module* module)
    {
        RegisteredModule registration;
        registration.kind = RegisteredModuleKind::legacy;
        registration.legacy_module = module;
        return registration;
    }
};

struct ModuleRegistrationSession {
    std::vector<RegisteredModule> registrations;
    bool attempted { false };
    bool invalid { false };
    bool allocation_failed { false };
};

class ModuleRegistrationScope {
public:
    ModuleRegistrationScope(NapiEnv* env, ModuleRegistrationSession* session)
        : previous_env(loading_env)
        , previous_session(module_registration_session)
    {
        loading_env = env;
        module_registration_session = session;
    }

    void did_finish_loading()
    {
        loading_env = previous_env;
    }

    ~ModuleRegistrationScope()
    {
        loading_env = previous_env;
        module_registration_session = previous_session;
    }

private:
    NapiEnv* previous_env { nullptr };
    ModuleRegistrationSession* previous_session { nullptr };
};

class AddonLibrary {
public:
    AddonLibrary() = default;
    AddonLibrary(const AddonLibrary&) = delete;
    AddonLibrary& operator=(const AddonLibrary&) = delete;

    ~AddonLibrary()
    {
        if (initialized)
            uv_dlclose(&library);
    }

    bool open(const char* path)
    {
        initialized = true;
        return uv_dlopen(path, &library) == 0;
    }

    const char* error() const
    {
        return initialized ? uv_dlerror(&library) : "dynamic library is not open";
    }

    void* key() const
    {
        return reinterpret_cast<void*>(library.handle);
    }

    template<typename Function>
    Function symbol(const char* name)
    {
        void* pointer = nullptr;
        if (uv_dlsym(&library, name, &pointer) != 0)
            return nullptr;
        return reinterpret_cast<Function>(pointer);
    }

    void keep_loaded()
    {
        if (!initialized)
            return;
        // Addon code and cached registrations remain valid for process lifetime.
        // Clear only libuv's transient symbol-error allocation.
        library.handle = nullptr;
        uv_dlclose(&library);
        initialized = false;
    }

private:
    uv_lib_t library {};
    bool initialized { false };
};

static std::mutex registered_modules_mutex;
static std::unordered_map<void*, std::vector<RegisteredModule>> registered_modules;

static JSClassRef function_class;
static JSClassRef external_class;
static JSClassRef finalizer_class;
static JSClassRef type_tag_class;
static JSClassRef legacy_v8_function_class;
static std::once_flag classes_once;
static std::once_flag legacy_v8_classes_once;

static JSValueRef call_napi_function(
    JSContextRef,
    JSObjectRef,
    JSObjectRef,
    size_t,
    const JSValueRef[],
    JSValueRef*
);
static JSObjectRef construct_napi_function(
    JSContextRef,
    JSObjectRef,
    size_t,
    const JSValueRef[],
    JSValueRef*
);
static bool napi_function_has_instance(
    JSContextRef,
    JSObjectRef,
    JSValueRef,
    JSValueRef*
);
static void wake(NapiEnv* env);

static NapiEnv* root_env(NapiEnv* env)
{
    return env && env->runtime_root ? env->runtime_root : env;
}

static uv_loop_t* event_loop_for_env(NapiEnv* env)
{
    auto* root = root_env(env);
    if (!root || root->event_loop_lifecycle == NapiEventLoopLifecycle::unavailable)
        return nullptr;
    return root->event_loop;
}

static bool event_loop_is_active(NapiEnv* env)
{
    auto* root = root_env(env);
    return root
        && root->event_loop_lifecycle == NapiEventLoopLifecycle::active
        && root->event_loop;
}

static void finalize_function(JSObjectRef object)
{
    delete static_cast<NapiFunctionData*>(JSObjectGetPrivate(object));
}

static void run_finalizer(NapiFinalizerData* finalizer)
{
    if (!finalizer || !finalizer->active)
        return;
    finalizer->active = false;
    if (!finalizer->callback)
        return;
    if (!finalizer->env) {
        finalizer->callback(nullptr, finalizer->data, finalizer->hint);
        return;
    }
    {
        std::lock_guard lock(finalizer->env->async_mutex);
        auto& queue = finalizer->basic && !finalizer->env->destroying
            ? finalizer->env->basic_finalizers
            : finalizer->env->posted_finalizers;
        queue.push_back({ finalizer->callback, finalizer->data, finalizer->hint });
    }
    wake(finalizer->env);
}

static void invalidate_wrap_reference(NapiFinalizerData* finalizer)
{
    if (!finalizer || !finalizer->wrap_ref)
        return;
    auto* reference = finalizer->wrap_ref;
    finalizer->wrap_ref = nullptr;
    reference->owner_finalizer = nullptr;
    if (reference->deleted || !reference->env)
        return;
    if (reference->value && reference->strong)
        JSValueUnprotect(reference->env->context, reference->value);
    if (reference->weak_ref)
        JSValueUnprotect(reference->env->context, reference->weak_ref);
    reference->value = nullptr;
    reference->weak_ref = nullptr;
    reference->count = 0;
    reference->strong = false;
    reference->invalidated = true;
}

static void finalize_external(JSObjectRef object)
{
    auto* finalizer = static_cast<NapiFinalizerData*>(JSObjectGetPrivate(object));
    if (!finalizer)
        return;
    invalidate_wrap_reference(finalizer);
    run_finalizer(finalizer);
    if (finalizer->env)
        finalizer->env->finalizers.erase(finalizer);
    delete finalizer;
}

static void finalize_type_tag(JSObjectRef object)
{
    delete static_cast<NapiTypeTagData*>(JSObjectGetPrivate(object));
}

static void initialize_classes()
{
    JSClassDefinition function_definition = kJSClassDefinitionEmpty;
    function_definition.className = "NapiFunction";
    function_definition.finalize = finalize_function;
    function_definition.callAsFunction = call_napi_function;
    function_definition.callAsConstructor = construct_napi_function;
    function_definition.hasInstance = napi_function_has_instance;
    function_class = JSClassCreate(&function_definition);

    JSClassDefinition external_definition = kJSClassDefinitionEmpty;
    external_definition.className = "NapiExternal";
    external_definition.finalize = finalize_external;
    external_class = JSClassCreate(&external_definition);

    JSClassDefinition finalizer_definition = kJSClassDefinitionEmpty;
    finalizer_definition.className = "NapiFinalizer";
    finalizer_definition.finalize = finalize_external;
    finalizer_class = JSClassCreate(&finalizer_definition);

    JSClassDefinition type_tag_definition = kJSClassDefinitionEmpty;
    type_tag_definition.className = "NapiTypeTag";
    type_tag_definition.finalize = finalize_type_tag;
    type_tag_class = JSClassCreate(&type_tag_definition);
}

static JSStringRef make_utf8_string(const char* bytes, size_t length)
{
    if (!bytes)
        return nullptr;
    if (length == NAPI_AUTO_LENGTH) {
        length = std::strlen(bytes);
        bool is_ascii = true;
        for (size_t index = 0; index < length; ++index) {
            if (static_cast<unsigned char>(bytes[index]) > 0x7f) {
                is_ascii = false;
                break;
            }
        }
        if (is_ascii)
            return JSStringCreateWithUTF8CString(bytes);
    }

    std::vector<JSChar> characters;
    characters.reserve(length);
    size_t input = 0;
    while (input < length) {
        const auto first = static_cast<unsigned char>(bytes[input]);
        uint32_t code_point = 0;
        size_t sequence_length = 0;
        if (first < 0x80) {
            code_point = first;
            sequence_length = 1;
        } else if ((first & 0xe0) == 0xc0) {
            code_point = first & 0x1f;
            sequence_length = 2;
        } else if ((first & 0xf0) == 0xe0) {
            code_point = first & 0x0f;
            sequence_length = 3;
        } else if ((first & 0xf8) == 0xf0) {
            code_point = first & 0x07;
            sequence_length = 4;
        } else {
            characters.push_back(0xfffd);
            ++input;
            continue;
        }
        bool valid = input + sequence_length <= length;
        for (size_t index = 1; valid && index < sequence_length; ++index) {
            const auto continuation = static_cast<unsigned char>(bytes[input + index]);
            if ((continuation & 0xc0) != 0x80)
                valid = false;
            else
                code_point = (code_point << 6) | (continuation & 0x3f);
        }
        const uint32_t minimum = sequence_length == 1 ? 0 : sequence_length == 2 ? 0x80 : sequence_length == 3 ? 0x800 : 0x10000;
        if (!valid || code_point < minimum || code_point > 0x10ffff || (code_point >= 0xd800 && code_point <= 0xdfff)) {
            characters.push_back(0xfffd);
            ++input;
            continue;
        }
        if (code_point <= 0xffff) {
            characters.push_back(static_cast<JSChar>(code_point));
        } else {
            code_point -= 0x10000;
            characters.push_back(static_cast<JSChar>(0xd800 + (code_point >> 10)));
            characters.push_back(static_cast<JSChar>(0xdc00 + (code_point & 0x3ff)));
        }
        input += sequence_length;
    }
    return JSStringCreateWithCharacters(characters.data(), characters.size());
}

static JSStringRef make_latin1_string(const char* bytes, size_t length)
{
    if (!bytes)
        return nullptr;
    if (length == NAPI_AUTO_LENGTH)
        length = std::strlen(bytes);
    std::vector<JSChar> characters(length);
    for (size_t index = 0; index < length; ++index)
        characters[index] = static_cast<unsigned char>(bytes[index]);
    return JSStringCreateWithCharacters(characters.data(), characters.size());
}

static JSValueRef to_js(napi_value value)
{
    return reinterpret_cast<JSValueRef>(value);
}

static napi_value to_napi(JSValueRef value)
{
    return reinterpret_cast<napi_value>(const_cast<OpaqueJSValue*>(value));
}

static napi_status finish(NapiEnv* env, napi_status status)
{
    if (!env)
        return napi_invalid_arg;
    env->last_error.error_code = status;
    env->last_error.engine_error_code = 0;
    env->last_error.engine_reserved = nullptr;
    env->last_error.error_message = status == napi_ok ? nullptr : error_messages[std::min<size_t>(status, std::size(error_messages) - 1)];
    return status;
}

static napi_status invalid(NapiEnv* env)
{
    return env ? finish(env, napi_invalid_arg) : napi_invalid_arg;
}

static void check_basic_finalizer_safety(NapiEnv* env)
{
    if (!env || !env->in_basic_finalizer || env->module_api_version != NAPI_VERSION_EXPERIMENTAL)
        return;
    std::fprintf(stderr, "FATAL ERROR: Finalizer is calling a function that may affect GC state.\n");
    std::fprintf(stderr, "The finalizers are run directly from GC and must not affect GC state.\n");
    std::fprintf(stderr, "Use `node_api_post_finalizer` from inside of the finalizer to work around this issue.\n");
    std::fprintf(stderr, "It schedules the call as a new task in the event loop.\n");
    std::fprintf(stderr, "panic(main thread): N-API finalizer attempted a GC-unsafe operation\n");
    std::fflush(stderr);
    std::abort();
}

static napi_status ensure_can_run_js(NapiEnv* env)
{
    if (!env)
        return napi_invalid_arg;
    check_basic_finalizer_safety(env);
    if (env->in_finalizer)
        return finish(env, napi_cannot_run_js);
    if (env->pending_exception)
        return finish(env, napi_pending_exception);
    return napi_ok;
}

static void protect_pending(NapiEnv* env, JSValueRef exception)
{
    if (env->pending_exception)
        JSValueUnprotect(env->context, env->pending_exception);
    env->pending_exception = exception;
    if (exception)
        JSValueProtect(env->context, exception);
}

static napi_status caught(NapiEnv* env, JSValueRef exception)
{
    if (exception)
        protect_pending(env, exception);
    return finish(env, napi_pending_exception);
}

static void track(NapiEnv* env, JSValueRef value)
{
    if (!env || !value || !env->current_scope)
        return;
    JSValueProtect(env->context, value);
    env->current_scope->values.push_back(value);
}

static napi_status output(NapiEnv* env, napi_value* result, JSValueRef value)
{
    if (!env || !result || !value)
        return invalid(env);
    track(env, value);
    *result = to_napi(value);
    return finish(env, napi_ok);
}

static JSStringRef property_name(const char* name)
{
    return JSStringCreateWithUTF8CString(name);
}

static JSValueRef get_property(NapiEnv* env, JSObjectRef object, const char* name, JSValueRef* exception = nullptr)
{
    JSStringRef key = property_name(name);
    JSValueRef value = JSObjectGetProperty(env->context, object, key, exception);
    JSStringRelease(key);
    return value;
}

static void set_property(
    NapiEnv* env,
    JSObjectRef object,
    const char* name,
    JSValueRef value,
    JSPropertyAttributes attributes,
    JSValueRef* exception
)
{
    JSStringRef key = property_name(name);
    JSObjectSetProperty(env->context, object, key, value, attributes, exception);
    JSStringRelease(key);
}

static JSObjectRef global_constructor(NapiEnv* env, const char* name, JSValueRef* exception)
{
    JSValueRef value = get_property(env, JSContextGetGlobalObject(env->context), name, exception);
    if (!value || !JSValueIsObject(env->context, value))
        return nullptr;
    return const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(value));
}

static JSObjectRef cached_function_call(NapiEnv* env, JSValueRef* exception)
{
    if (env->function_call)
        return env->function_call;
    JSObjectRef constructor = global_constructor(env, "Function", exception);
    JSValueRef prototype_value = *exception || !constructor ? nullptr : get_property(env, constructor, "prototype", exception);
    if (*exception || !prototype_value || !JSValueIsObject(env->context, prototype_value))
        return nullptr;
    JSObjectRef prototype = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(prototype_value));
    JSValueRef call_value = get_property(env, prototype, "call", exception);
    if (*exception || !call_value || !JSValueIsObject(env->context, call_value))
        return nullptr;
    JSObjectRef call = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(call_value));
    if (!JSObjectIsFunction(env->context, call))
        return nullptr;
    env->function_call = call;
    JSValueProtect(env->context, call);
    return call;
}

static void define_data_property(
    NapiEnv* env,
    JSObjectRef target,
    const char* name,
    JSValueRef value,
    bool writable,
    bool enumerable,
    bool configurable,
    JSValueRef* exception
)
{
    JSObjectRef descriptor = JSObjectMake(env->context, nullptr, nullptr);
    set_property(env, descriptor, "value", value, kJSPropertyAttributeNone, exception);
    if (!*exception)
        set_property(env, descriptor, "writable", JSValueMakeBoolean(env->context, writable), kJSPropertyAttributeNone, exception);
    if (!*exception)
        set_property(env, descriptor, "enumerable", JSValueMakeBoolean(env->context, enumerable), kJSPropertyAttributeNone, exception);
    if (!*exception)
        set_property(env, descriptor, "configurable", JSValueMakeBoolean(env->context, configurable), kJSPropertyAttributeNone, exception);
    JSObjectRef object_constructor = *exception ? nullptr : global_constructor(env, "Object", exception);
    JSValueRef define_property_value = *exception || !object_constructor ? nullptr : get_property(env, object_constructor, "defineProperty", exception);
    if (*exception || !define_property_value || !JSValueIsObject(env->context, define_property_value))
        return;
    JSStringRef key_string = property_name(name);
    JSValueRef arguments[] = { target, JSValueMakeString(env->context, key_string), descriptor };
    JSStringRelease(key_string);
    auto define_property = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(define_property_value));
    JSObjectCallAsFunction(env->context, define_property, object_constructor, 3, arguments, exception);
}

static JSValueRef call_method(
    NapiEnv* env,
    JSObjectRef receiver,
    const char* name,
    size_t argc,
    const JSValueRef argv[],
    JSValueRef* exception
)
{
    JSValueRef method_value = get_property(env, receiver, name, exception);
    if (*exception || !method_value || !JSValueIsObject(env->context, method_value))
        return nullptr;
    JSObjectRef method = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(method_value));
    if (!JSObjectIsFunction(env->context, method))
        return nullptr;
    return JSObjectCallAsFunction(env->context, method, receiver, argc, argv, exception);
}

static JSValueRef call_global_function(
    NapiEnv* env,
    const char* name,
    size_t argc,
    const JSValueRef argv[],
    JSValueRef* exception
)
{
    JSObjectRef global = JSContextGetGlobalObject(env->context);
    JSValueRef function_value = get_property(env, global, name, exception);
    if (*exception || !function_value || !JSValueIsObject(env->context, function_value))
        return nullptr;
    JSObjectRef function = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(function_value));
    if (!JSObjectIsFunction(env->context, function))
        return nullptr;
    return JSObjectCallAsFunction(env->context, function, global, argc, argv, exception);
}

static JSObjectRef load_builtin_module(NapiEnv* env, const char* name, JSValueRef* exception)
{
    JSObjectRef global = JSContextGetGlobalObject(env->context);
    JSValueRef process_value = get_property(env, global, "process", exception);
    if (*exception || !process_value || !JSValueIsObject(env->context, process_value))
        return nullptr;
    JSObjectRef process = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(process_value));
    JSStringRef name_string = make_utf8_string(name, NAPI_AUTO_LENGTH);
    if (!name_string)
        return nullptr;
    JSValueRef argument = JSValueMakeString(env->context, name_string);
    JSStringRelease(name_string);
    JSValueRef module_value = call_method(env, process, "getBuiltinModule", 1, &argument, exception);
    if (*exception || !module_value || !JSValueIsObject(env->context, module_value))
        return nullptr;
    return const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(module_value));
}

static bool process_is_exiting(NapiEnv* env, JSValueRef* exception)
{
    JSObjectRef global = JSContextGetGlobalObject(env->context);
    JSValueRef process_value = get_property(env, global, "process", exception);
    if (*exception || !process_value || !JSValueIsObject(env->context, process_value))
        return false;
    JSObjectRef process = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(process_value));
    JSValueRef exiting = get_property(env, process, "_exiting", exception);
    return !*exception && exiting && JSValueToBoolean(env->context, exiting);
}

static bool mark_array_buffer_untransferable(NapiEnv* env, JSObjectRef array_buffer, JSValueRef* exception)
{
    JSObjectRef worker_threads = load_builtin_module(env, "worker_threads", exception);
    if (*exception)
        return false;
    if (!worker_threads)
        return true;
    JSValueRef argument = array_buffer;
    call_method(env, worker_threads, "markAsUntransferable", 1, &argument, exception);
    return !*exception;
}

static JSObjectRef ensure_logically_detached_buffers(NapiEnv* env, JSValueRef* exception)
{
    NapiEnv* root = root_env(env);
    if (root->logically_detached_buffers)
        return root->logically_detached_buffers;
    JSObjectRef constructor = global_constructor(root, "WeakSet", exception);
    JSObjectRef buffers = *exception || !constructor
        ? nullptr
        : JSObjectCallAsConstructor(root->context, constructor, 0, nullptr, exception);
    if (*exception || !buffers)
        return nullptr;
    root->logically_detached_buffers = buffers;
    JSValueProtect(root->context, buffers);
    return buffers;
}

static bool mark_logically_detached(NapiEnv* env, JSObjectRef array_buffer, JSValueRef* exception)
{
    JSObjectRef buffers = ensure_logically_detached_buffers(env, exception);
    if (*exception || !buffers)
        return false;
    JSValueRef argument = array_buffer;
    call_method(env, buffers, "add", 1, &argument, exception);
    return !*exception;
}

static bool is_logically_detached(NapiEnv* env, JSObjectRef array_buffer, JSValueRef* exception)
{
    NapiEnv* root = root_env(env);
    if (!root->logically_detached_buffers)
        return false;
    JSValueRef argument = array_buffer;
    JSValueRef result = call_method(env, root->logically_detached_buffers, "has", 1, &argument, exception);
    return !*exception && result && JSValueToBoolean(env->context, result);
}

static void scope_open(NapiEnv* env, napi_handle_scope__* scope, bool escapable)
{
    scope->env = env;
    scope->parent = env->current_scope;
    scope->escapable = escapable;
    env->current_scope = scope;
}

static napi_status scope_close(NapiEnv* env, napi_handle_scope__* scope)
{
    if (!env || !scope || scope->env != env || scope->closed || env->current_scope != scope)
        return finish(env, napi_handle_scope_mismatch);
    env->current_scope = scope->parent;
    for (auto iterator = scope->values.rbegin(); iterator != scope->values.rend(); ++iterator)
        JSValueUnprotect(env->context, *iterator);
    scope->values.clear();
    scope->closed = true;
    return finish(env, napi_ok);
}

class AutomaticScope {
public:
    explicit AutomaticScope(NapiEnv* env)
        : m_env(env)
    {
        scope_open(env, &m_scope, false);
    }

    ~AutomaticScope()
    {
        if (!m_scope.closed)
            scope_close(m_env, &m_scope);
    }

private:
    NapiEnv* m_env;
    napi_handle_scope__ m_scope;
};

class BasicFinalizerScope {
public:
    BasicFinalizerScope(NapiEnv* env, bool basic, bool is_finalizer = true)
        : m_env(env)
        , m_previous_finalizer(env->in_finalizer)
        , m_previous_basic(env->in_basic_finalizer)
    {
        if (is_finalizer)
            env->in_finalizer = true;
        if (is_finalizer && basic)
            env->in_basic_finalizer = true;
    }

    ~BasicFinalizerScope()
    {
        m_env->in_finalizer = m_previous_finalizer;
        m_env->in_basic_finalizer = m_previous_basic;
    }

private:
    NapiEnv* m_env;
    bool m_previous_finalizer;
    bool m_previous_basic;
};

class MicrotaskDelayScope {
public:
    explicit MicrotaskDelayScope(JSGlobalContextRef context)
        : m_scope(context ? ct_jsc_microtask_delay_begin(JSContextGetGroup(context)) : nullptr)
    {
    }

    ~MicrotaskDelayScope()
    {
        if (m_scope)
            ct_jsc_microtask_delay_end(m_scope);
    }

private:
    void* m_scope;
};

static bool is_reserved_function_name(const char* name, size_t length)
{
    static constexpr const char* reserved[] = {
        "arguments", "await", "break", "case", "catch", "class", "const",
        "continue", "debugger", "default", "delete", "do", "else", "enum",
        "eval", "export", "extends", "false", "finally", "for", "function",
        "if", "implements", "import", "in", "instanceof", "interface", "let",
        "new", "null", "package", "private", "protected", "public", "return",
        "static", "super", "switch", "this", "throw", "true", "try", "typeof",
        "var", "void", "while", "with", "yield",
    };
    for (const char* candidate : reserved) {
        if (std::strlen(candidate) == length && std::memcmp(candidate, name, length) == 0)
            return true;
    }
    return false;
}

static JSObjectRef make_napi_function(
    NapiEnv* env,
    const char* name,
    size_t length,
    napi_callback callback,
    void* data,
    bool class_constructor,
    JSValueRef* exception
)
{
    std::call_once(classes_once, initialize_classes);
    auto* metadata = new (std::nothrow) NapiFunctionData { env, callback, data, class_constructor };
    if (!metadata)
        return nullptr;
    JSObjectRef dispatcher = JSObjectMake(env->context, function_class, metadata);

    JSObjectRef function_constructor = global_constructor(env, "Function", exception);
    if (!*exception && function_constructor) {
        JSValueRef prototype = get_property(env, function_constructor, "prototype", exception);
        if (!*exception && prototype)
            JSObjectSetPrototype(env->context, dispatcher, prototype);
    }

    size_t function_name_length = 0;
    if (name)
        function_name_length = length == NAPI_AUTO_LENGTH ? std::strlen(name) : length;
    bool can_embed_name = function_name_length > 0;
    for (size_t index = 0; can_embed_name && index < function_name_length; ++index) {
        const unsigned char byte = static_cast<unsigned char>(name[index]);
        const bool valid = index == 0
            ? (std::isalpha(byte) || byte == '_' || byte == '$')
            : (std::isalnum(byte) || byte == '_' || byte == '$');
        can_embed_name = valid;
    }
    if (can_embed_name && is_reserved_function_name(name, function_name_length))
        can_embed_name = false;
    std::string function_source = "\"use strict\"; return function";
    if (can_embed_name) {
        function_source.push_back(' ');
        function_source.append(name, function_name_length);
    }
    function_source += "() { return dispatch(this, new.target, arguments); };";

    JSStringRef factory_name = JSStringCreateWithUTF8CString("createNapiFunction");
    JSStringRef parameter = JSStringCreateWithUTF8CString("dispatch");
    JSStringRef body = make_utf8_string(function_source.data(), function_source.size());
    JSObjectRef factory = *exception ? nullptr : JSObjectMakeFunction(env->context, factory_name, 1, &parameter, body, nullptr, 1, exception);
    JSStringRelease(body);
    JSStringRelease(parameter);
    JSStringRelease(factory_name);
    JSValueRef dispatcher_value = dispatcher;
    JSValueRef function_value = *exception || !factory ? nullptr : JSObjectCallAsFunction(env->context, factory, nullptr, 1, &dispatcher_value, exception);
    JSObjectRef function = !*exception && function_value && JSValueIsObject(env->context, function_value)
        ? const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(function_value))
        : nullptr;

    if (*exception || !function) {
        delete metadata;
        JSObjectSetPrivate(dispatcher, nullptr);
        return nullptr;
    }

    if (!*exception && name) {
        JSStringRef string = make_utf8_string(name, length);
        if (string) {
            define_data_property(env, function, "name", JSValueMakeString(env->context, string), false, false, true, exception);
            JSStringRelease(string);
        }
    }
    if (!*exception)
        define_data_property(env, function, "length", JSValueMakeNumber(env->context, 0), false, false, true, exception);
    if (*exception) {
        delete metadata;
        JSObjectSetPrivate(dispatcher, nullptr);
        return nullptr;
    }
    return function;
}

static JSValueRef invoke_napi_callback(
    NapiFunctionData* metadata,
    JSValueRef this_value,
    JSValueRef new_target,
    size_t argc,
    const JSValueRef argv[],
    JSValueRef* exception
)
{
    if (!metadata || !metadata->env || !metadata->callback)
        return JSValueMakeUndefined(metadata && metadata->env ? metadata->env->context : nullptr);
    NapiEnv* env = metadata->env;
    ActiveEnvScope active_scope(env);
    AutomaticScope scope(env);
    napi_callback_info__ info { env, argc, argv, this_value, new_target, metadata->data };
    napi_value returned = metadata->callback(reinterpret_cast<napi_env>(env), reinterpret_cast<napi_callback_info>(&info));
    if (env->pending_exception) {
        *exception = env->pending_exception;
        JSValueUnprotect(env->context, env->pending_exception);
        env->pending_exception = nullptr;
        return JSValueMakeUndefined(env->context);
    }
    return returned ? to_js(returned) : JSValueMakeUndefined(env->context);
}

static JSValueRef call_napi_function(
    JSContextRef ctx,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argc,
    const JSValueRef argv[],
    JSValueRef* exception
)
{
    auto* metadata = static_cast<NapiFunctionData*>(JSObjectGetPrivate(function));
    if (!metadata || !metadata->env || argc != 3 || !JSValueIsObject(ctx, argv[2]))
        return JSValueMakeUndefined(ctx);
    NapiEnv* env = metadata->env;
    JSObjectRef arguments_object = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(argv[2]));
    JSValueRef length_value = get_property(env, arguments_object, "length", exception);
    if (*exception)
        return JSValueMakeUndefined(ctx);
    size_t argument_count = static_cast<size_t>(JSValueToNumber(ctx, length_value, exception));
    if (*exception)
        return JSValueMakeUndefined(ctx);
    std::vector<JSValueRef> arguments(argument_count);
    for (size_t index = 0; index < argument_count; ++index) {
        arguments[index] = JSObjectGetPropertyAtIndex(ctx, arguments_object, static_cast<unsigned>(index), exception);
        if (*exception)
            return JSValueMakeUndefined(ctx);
    }
    JSValueRef new_target = JSValueIsUndefined(ctx, argv[1]) ? nullptr : argv[1];
    (void)this_object;
    return invoke_napi_callback(metadata, argv[0], new_target, argument_count, arguments.data(), exception);
}

static JSObjectRef construct_napi_function(
    JSContextRef ctx,
    JSObjectRef constructor,
    size_t argc,
    const JSValueRef argv[],
    JSValueRef* exception
)
{
    auto* metadata = static_cast<NapiFunctionData*>(JSObjectGetPrivate(constructor));
    if (!metadata || !metadata->env)
        return nullptr;
    NapiEnv* env = metadata->env;
    JSObjectRef this_value = JSObjectMake(ctx, nullptr, nullptr);
    JSValueRef prototype = get_property(env, constructor, "prototype", exception);
    if (!*exception && prototype && JSValueIsObject(ctx, prototype))
        JSObjectSetPrototype(ctx, this_value, prototype);
    if (*exception)
        return nullptr;
    JSValueRef returned = invoke_napi_callback(metadata, this_value, constructor, argc, argv, exception);
    if (*exception)
        return nullptr;
    if (returned && JSValueIsObject(ctx, returned))
        return const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(returned));
    return this_value;
}

static bool napi_function_has_instance(
    JSContextRef ctx,
    JSObjectRef constructor,
    JSValueRef possible_instance,
    JSValueRef* exception
)
{
    if (!JSValueIsObject(ctx, possible_instance))
        return false;
    auto* metadata = static_cast<NapiFunctionData*>(JSObjectGetPrivate(constructor));
    if (!metadata || !metadata->env)
        return false;
    JSValueRef prototype = get_property(metadata->env, constructor, "prototype", exception);
    if (*exception || !prototype || !JSValueIsObject(ctx, prototype))
        return false;
    JSObjectRef cursor = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(possible_instance));
    for (;;) {
        JSValueRef current = JSObjectGetPrototype(ctx, cursor);
        if (!current || JSValueIsNull(ctx, current))
            return false;
        if (JSValueIsStrictEqual(ctx, current, prototype))
            return true;
        if (!JSValueIsObject(ctx, current))
            return false;
        cursor = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(current));
    }
}

static void wake(NapiEnv* env)
{
    if (env && env->wake_callback)
        env->wake_callback(env->wake_opaque);
}

static void buffer_deallocator(void* bytes, void* opaque)
{
    auto* finalizer = static_cast<NapiBufferFinalizer*>(opaque);
    if (finalizer) {
        if (finalizer->finalized) {
            delete finalizer;
            return;
        }
        if (finalizer->env) {
            std::lock_guard lock(finalizer->env->async_mutex);
            finalizer->env->buffer_finalizers.erase(finalizer);
        }
        if (finalizer->callback && finalizer->env) {
            {
                std::lock_guard lock(finalizer->env->async_mutex);
                finalizer->env->posted_finalizers.push_back({ finalizer->callback, finalizer->data, finalizer->hint });
            }
            wake(finalizer->env);
        } else if (finalizer->callback) {
            finalizer->callback(nullptr, finalizer->data, finalizer->hint);
        } else if (finalizer->owns_data) {
            std::free(bytes);
        }
        delete finalizer;
    } else {
        std::free(bytes);
    }
}

static void external_string_deallocator(void* opaque, void*, size_t)
{
    buffer_deallocator(nullptr, opaque);
}

static JSObjectRef as_object(NapiEnv* env, napi_value value)
{
    JSValueRef js_value = to_js(value);
    if (!js_value || !JSValueIsObject(env->context, js_value))
        return nullptr;
    return const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(js_value));
}

static napi_status require_object(NapiEnv* env, napi_value value, JSObjectRef* result)
{
    if (!env || !value || !result)
        return invalid(env);
    *result = as_object(env, value);
    return *result ? napi_ok : finish(env, napi_object_expected);
}

static napi_status require_property_target(NapiEnv* env, napi_value value, JSObjectRef* result)
{
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    *result = JSValueToObject(env->context, to_js(value), &exception);
    if (exception)
        return caught(env, exception);
    return *result ? napi_ok : finish(env, napi_object_expected);
}

static JSObjectRef create_error_object(NapiEnv* env, const char* constructor_name, napi_value code, napi_value message, JSValueRef* exception)
{
    if (!message || !JSValueIsString(env->context, to_js(message)))
        return nullptr;
    JSObjectRef constructor = global_constructor(env, constructor_name, exception);
    if (*exception || !constructor)
        return nullptr;
    JSValueRef arguments[] = { to_js(message) };
    JSObjectRef error = JSObjectCallAsConstructor(env->context, constructor, 1, arguments, exception);
    if (*exception || !error)
        return nullptr;
    if (code && !JSValueIsUndefined(env->context, to_js(code)))
        set_property(env, error, "code", to_js(code), kJSPropertyAttributeNone, exception);
    return error;
}

static bool is_instance_of_global(NapiEnv* env, napi_value value, const char* constructor_name, JSValueRef* exception)
{
    if (!value || !JSValueIsObject(env->context, to_js(value)))
        return false;
    JSObjectRef constructor = global_constructor(env, constructor_name, exception);
    if (*exception || !constructor)
        return false;
    return JSValueIsInstanceOfConstructor(env->context, to_js(value), constructor, exception);
}

static std::string copy_js_string(JSStringRef string)
{
    if (!string)
        return {};
    size_t capacity = JSStringGetMaximumUTF8CStringSize(string);
    std::string result(capacity ? capacity - 1 : 0, '\0');
    if (capacity) {
        size_t written = JSStringGetUTF8CString(string, result.data(), capacity);
        result.resize(written ? written - 1 : 0);
    }
    return result;
}

static std::string path_to_file_uri(const char* path)
{
    static constexpr char hex[] = "0123456789ABCDEF";
    std::string normalized = path ? path : "";
#if defined(_WIN32)
    std::replace(normalized.begin(), normalized.end(), '\\', '/');
    if (normalized.size() >= 2 && normalized[1] == ':')
        normalized.insert(normalized.begin(), '/');
#endif
    std::string result = "file://";
    result.reserve(result.size() + normalized.size());
    for (unsigned char byte : normalized) {
        const bool unescaped = (byte >= 'a' && byte <= 'z')
            || (byte >= 'A' && byte <= 'Z')
            || (byte >= '0' && byte <= '9')
            || byte == '-' || byte == '.' || byte == '_' || byte == '~'
            || byte == '/' || byte == ':';
        if (unescaped) {
            result.push_back(static_cast<char>(byte));
        } else {
            result.push_back('%');
            result.push_back(hex[byte >> 4]);
            result.push_back(hex[byte & 0x0f]);
        }
    }
    return result;
}

static LegacyV8State* legacy_v8_state_for(NapiEnv* env)
{
    if (!env)
        return nullptr;
    if (!env->legacy_v8_state)
        env->legacy_v8_state = new (std::nothrow) LegacyV8State(env);
    return static_cast<LegacyV8State*>(env->legacy_v8_state);
}

static NapiEnv* legacy_v8_env(v8::Isolate* isolate)
{
    auto* data = reinterpret_cast<LegacyV8IsolateData*>(isolate);
    return data ? data->env : nullptr;
}

static v8::Isolate* legacy_v8_isolate(NapiEnv* env)
{
    auto* state = legacy_v8_state_for(env);
    return state ? reinterpret_cast<v8::Isolate*>(&state->isolate) : nullptr;
}

static void legacy_v8_destroy_state(NapiEnv* env)
{
    auto* state = env ? static_cast<LegacyV8State*>(env->legacy_v8_state) : nullptr;
    if (!state)
        return;
    for (auto& entry : state->internal_fields) {
        auto& fields = entry.second;
        for (size_t index = 0; index < fields.values.size(); ++index) {
            if (index < fields.initialized.size() && fields.initialized[index] && fields.values[index])
                JSValueUnprotect(env->context, fields.values[index]);
        }
    }
    delete state;
    env->legacy_v8_state = nullptr;
}

static const LegacyV8Oddball* legacy_v8_as_oddball(uintptr_t raw)
{
    if ((raw & legacy_v8_tag_mask) != legacy_v8_pointer_tag)
        return nullptr;
    auto* pointer = reinterpret_cast<const LegacyV8Oddball*>(raw & ~legacy_v8_tag_mask);
    if (pointer == &legacy_v8_undefined() || pointer == &legacy_v8_null()
        || pointer == &legacy_v8_true() || pointer == &legacy_v8_false())
        return pointer;
    return nullptr;
}

static LegacyV8HeapObject* legacy_v8_heap_object(uintptr_t raw)
{
    if ((raw & legacy_v8_tag_mask) != legacy_v8_pointer_tag || legacy_v8_as_oddball(raw))
        return nullptr;
    return reinterpret_cast<LegacyV8HeapObject*>(raw & ~legacy_v8_tag_mask);
}

static LegacyV8HeapObject* legacy_v8_new_heap(const LegacyV8Map& map, LegacyV8HeapKind kind)
{
    auto* object = new (std::nothrow) LegacyV8HeapObject;
    if (!object)
        return nullptr;
    object->map = legacy_v8_tag_pointer(&map);
    object->kind = kind;
    return object;
}

static uintptr_t* legacy_v8_add_handle_to(
    LegacyV8ScopeData* scope,
    uintptr_t raw,
    JSValueRef protected_value = nullptr,
    void* owned_value = nullptr,
    void (*destroy_owned)(void*) = nullptr)
{
    if (!scope)
        return nullptr;
    if (protected_value)
        JSValueProtect(scope->env->context, protected_value);
    scope->handles.push_back({ raw, protected_value, owned_value, destroy_owned });
    return &scope->handles.back().raw;
}

static uintptr_t* legacy_v8_add_handle(uintptr_t raw, JSValueRef protected_value = nullptr, void* owned_value = nullptr, void (*destroy_owned)(void*) = nullptr)
{
    return legacy_v8_add_handle_to(legacy_v8_scope, raw, protected_value, owned_value, destroy_owned);
}

static uintptr_t legacy_v8_encode_js_value(NapiEnv* env, JSValueRef value, LegacyV8ScopeData* scope)
{
    if (!env || !value || !scope)
        return 0;
    if (JSValueIsUndefined(env->context, value))
        return legacy_v8_tag_pointer(&legacy_v8_undefined());
    if (JSValueIsNull(env->context, value))
        return legacy_v8_tag_pointer(&legacy_v8_null());
    if (JSValueIsBoolean(env->context, value))
        return legacy_v8_tag_pointer(JSValueToBoolean(env->context, value) ? &legacy_v8_true() : &legacy_v8_false());
    if (JSValueIsNumber(env->context, value)) {
        JSValueRef exception = nullptr;
        double number = JSValueToNumber(env->context, value, &exception);
        if (!exception && std::isfinite(number) && !(number == 0 && std::signbit(number))
            && std::trunc(number) == number
            && number >= std::numeric_limits<int32_t>::min()
            && number <= std::numeric_limits<int32_t>::max())
            return legacy_v8_tag_smi(static_cast<int32_t>(number));
        auto* object = legacy_v8_new_heap(LegacyV8Map::heap_number_map(), LegacyV8HeapKind::number);
        if (!object)
            return 0;
        object->payload.number = number;
        legacy_v8_add_handle_to(scope, legacy_v8_tag_pointer(object), nullptr, object, [](void* value) { delete static_cast<LegacyV8HeapObject*>(value); });
        return legacy_v8_tag_pointer(object);
    }

    auto* object = legacy_v8_new_heap(
        JSValueIsString(env->context, value) ? LegacyV8Map::string_map() : LegacyV8Map::object_map(),
        LegacyV8HeapKind::js_value);
    if (!object)
        return 0;
    object->payload.js_value = value;
    legacy_v8_add_handle_to(scope, legacy_v8_tag_pointer(object), value, object, [](void* owned) { delete static_cast<LegacyV8HeapObject*>(owned); });
    return legacy_v8_tag_pointer(object);
}

static uintptr_t* legacy_v8_add_js_handle_to(LegacyV8ScopeData* scope, JSValueRef value)
{
    if (!scope || !value)
        return nullptr;
    const size_t old_size = scope->handles.size();
    uintptr_t raw = legacy_v8_encode_js_value(scope->env, value, scope);
    if (!raw && !(JSValueIsNumber(scope->env->context, value) && JSValueToNumber(scope->env->context, value, nullptr) == 0))
        return nullptr;
    if (scope->handles.size() != old_size)
        return &scope->handles.back().raw;
    return legacy_v8_add_handle_to(scope, raw);
}

static uintptr_t* legacy_v8_add_js_handle(JSValueRef value)
{
    return legacy_v8_add_js_handle_to(legacy_v8_scope, value);
}

static JSValueRef legacy_v8_decode_raw(NapiEnv* env, uintptr_t raw)
{
    if (!env)
        return nullptr;
    if ((raw & legacy_v8_tag_mask) == 0)
        return JSValueMakeNumber(env->context, static_cast<int32_t>(raw >> 32));
    if (const auto* oddball = legacy_v8_as_oddball(raw)) {
        const int32_t kind = static_cast<int32_t>(oddball->kind >> 32);
        if (kind == static_cast<int32_t>(LegacyV8OddballKind::undefined))
            return JSValueMakeUndefined(env->context);
        if (kind == static_cast<int32_t>(LegacyV8OddballKind::null))
            return JSValueMakeNull(env->context);
        if (kind == static_cast<int32_t>(LegacyV8OddballKind::true_value))
            return JSValueMakeBoolean(env->context, true);
        return JSValueMakeBoolean(env->context, false);
    }
    auto* object = legacy_v8_heap_object(raw);
    if (!object)
        return nullptr;
    if (object->kind == LegacyV8HeapKind::number)
        return JSValueMakeNumber(env->context, object->payload.number);
    if (object->kind == LegacyV8HeapKind::js_value)
        return object->payload.js_value;
    return nullptr;
}

template<typename T>
static JSValueRef legacy_v8_js_value(v8::Local<T> value)
{
    auto* env = active_env ? active_env : loading_env;
    return value.location ? legacy_v8_decode_raw(env, *value.location) : nullptr;
}

static uintptr_t* legacy_v8_clone_handle_to(LegacyV8ScopeData* scope, uintptr_t raw)
{
    if (!scope)
        return nullptr;
    if ((raw & legacy_v8_tag_mask) == 0 || legacy_v8_as_oddball(raw))
        return legacy_v8_add_handle_to(scope, raw);
    auto* object = legacy_v8_heap_object(raw);
    if (!object)
        return nullptr;
    if (object->kind == LegacyV8HeapKind::js_value)
        return legacy_v8_add_js_handle_to(scope, object->payload.js_value);
    auto* clone = legacy_v8_new_heap(
        object->kind == LegacyV8HeapKind::number ? LegacyV8Map::heap_number_map() : LegacyV8Map::object_map(),
        object->kind);
    if (!clone)
        return nullptr;
    clone->payload = object->payload;
    return legacy_v8_add_handle_to(scope, legacy_v8_tag_pointer(clone), nullptr, clone, [](void* value) { delete static_cast<LegacyV8HeapObject*>(value); });
}

static LegacyV8HeapObject* legacy_v8_owned_object(const void* handle, LegacyV8HeapKind kind)
{
    if (!handle)
        return nullptr;
    auto raw = *reinterpret_cast<const uintptr_t*>(handle);
    auto* object = legacy_v8_heap_object(raw);
    return object && object->kind == kind ? object : nullptr;
}

static void legacy_v8_function_finalize(JSObjectRef function)
{
    auto* data = static_cast<LegacyV8FunctionData*>(JSObjectGetPrivate(function));
    if (!data)
        return;
    if (data->data && data->context)
        JSValueUnprotect(data->context, data->data);
    delete data;
}

struct LegacyV8ImplicitArgs {
    void* unused { nullptr };
    v8::Isolate* isolate { nullptr };
    void* context { nullptr };
    uintptr_t return_value { 0 };
    uintptr_t target { 0 };
    void* new_target { nullptr };
};

static JSValueRef legacy_v8_function_call(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argc,
    const JSValueRef argv[],
    JSValueRef* exception)
{
    auto* data = static_cast<LegacyV8FunctionData*>(JSObjectGetPrivate(function));
    if (!data || !data->env || !data->callback)
        return JSValueMakeUndefined(context);
    ActiveEnvScope active_scope(data->env);
    v8::Isolate* isolate = legacy_v8_isolate(data->env);
    v8::HandleScope handle_scope(isolate);
    std::vector<uintptr_t> arguments(argc + 1);
    arguments[0] = legacy_v8_encode_js_value(
        data->env,
        this_object ? static_cast<JSValueRef>(this_object) : JSContextGetGlobalObject(context),
        legacy_v8_scope);
    for (size_t index = 0; index < argc; ++index)
        arguments[index + 1] = legacy_v8_encode_js_value(data->env, argv[index], legacy_v8_scope);
    auto* target = legacy_v8_new_heap(LegacyV8Map::object_map(), LegacyV8HeapKind::function_target);
    if (!target)
        return JSValueMakeUndefined(context);
    target->payload.pointer = data;
    legacy_v8_add_handle(legacy_v8_tag_pointer(target), nullptr, target, [](void* value) { delete static_cast<LegacyV8HeapObject*>(value); });
    LegacyV8ImplicitArgs implicit_args {
        nullptr,
        isolate,
        data->env->context,
        legacy_v8_tag_pointer(&legacy_v8_undefined()),
        legacy_v8_tag_pointer(target),
        nullptr,
    };
    v8::FunctionCallbackInfo<v8::Value> info;
    info.implicit_args = &implicit_args;
    info.values = arguments.data() + 1;
    info.length = static_cast<int>(argc);
    data->callback(info);
    if (data->env->pending_exception) {
        *exception = data->env->pending_exception;
        JSValueUnprotect(data->env->context, data->env->pending_exception);
        data->env->pending_exception = nullptr;
        return JSValueMakeUndefined(context);
    }
    JSValueRef returned = legacy_v8_decode_raw(data->env, implicit_args.return_value);
    return returned ? returned : JSValueMakeUndefined(context);
}

static void initialize_legacy_v8_classes()
{
    JSClassDefinition definition = kJSClassDefinitionEmpty;
    definition.className = "LegacyV8Function";
    definition.callAsFunction = legacy_v8_function_call;
    definition.finalize = legacy_v8_function_finalize;
    legacy_v8_function_class = JSClassCreate(&definition);
}

} // namespace

v8::Isolate* v8::Isolate::GetCurrent()
{
    NapiEnv* env = active_env ? active_env : loading_env;
    return legacy_v8_isolate(env);
}

v8::Local<v8::Context> v8::Isolate::GetCurrentContext()
{
    auto* env = legacy_v8_env(this);
    return env ? v8::Local<v8::Context>(legacy_v8_add_js_handle(JSContextGetGlobalObject(env->context))) : v8::Local<v8::Context>();
}

v8::Isolate* v8::Context::GetIsolate()
{
    return v8::Isolate::GetCurrent();
}

v8::HandleScope::HandleScope(v8::Isolate* isolate)
{
    auto* env = legacy_v8_env(isolate);
    auto* scope = new LegacyV8ScopeData { env, legacy_v8_scope, {} };
    storage[0] = isolate;
    storage[1] = scope;
    legacy_v8_scope = scope;
}

v8::HandleScope::~HandleScope()
{
    auto* scope = static_cast<LegacyV8ScopeData*>(storage[1]);
    if (!scope)
        return;
    legacy_v8_scope = scope->previous;
    for (auto& handle : scope->handles) {
        if (handle.protected_value)
            JSValueUnprotect(scope->env->context, handle.protected_value);
        if (handle.destroy_owned)
            handle.destroy_owned(handle.owned_value);
    }
    delete scope;
    storage[1] = nullptr;
}

uintptr_t* v8::HandleScope::CreateHandle(v8::internal::Isolate*, uintptr_t raw)
{
    return legacy_v8_clone_handle_to(legacy_v8_scope, raw);
}

v8::EscapableHandleScopeBase::EscapableHandleScopeBase(v8::Isolate* isolate)
    : HandleScope(isolate)
{
    auto* scope = static_cast<LegacyV8ScopeData*>(storage[1]);
    escape_slot = scope && scope->previous
        ? legacy_v8_add_handle_to(scope->previous, legacy_v8_tag_pointer(&legacy_v8_undefined()))
        : nullptr;
}

uintptr_t* v8::EscapableHandleScopeBase::EscapeSlot(uintptr_t* value)
{
    if (!escape_slot || !value)
        std::abort();
    auto* scope = static_cast<LegacyV8ScopeData*>(storage[1]);
    uintptr_t* result = legacy_v8_clone_handle_to(scope ? scope->previous : nullptr, *value);
    escape_slot = nullptr;
    return result;
}

static NapiEnv* legacy_v8_current_env()
{
    return active_env ? active_env : loading_env;
}

static uintptr_t legacy_v8_raw(const void* value)
{
    return value ? *reinterpret_cast<const uintptr_t*>(value) : 0;
}

static bool legacy_v8_raw_is_smi(uintptr_t raw)
{
    return (raw & legacy_v8_tag_mask) == 0;
}

static double legacy_v8_number_value(NapiEnv* env, uintptr_t raw, bool* valid = nullptr)
{
    if (legacy_v8_raw_is_smi(raw)) {
        if (valid)
            *valid = true;
        return static_cast<int32_t>(raw >> 32);
    }
    auto* object = legacy_v8_heap_object(raw);
    if (object && object->kind == LegacyV8HeapKind::number) {
        if (valid)
            *valid = true;
        return object->payload.number;
    }
    JSValueRef value = legacy_v8_decode_raw(env, raw);
    if (value && JSValueIsNumber(env->context, value)) {
        JSValueRef exception = nullptr;
        double number = JSValueToNumber(env->context, value, &exception);
        if (!exception) {
            if (valid)
                *valid = true;
            return number;
        }
    }
    if (valid)
        *valid = false;
    return 0;
}

bool v8::Value::FullIsFalse() const
{
    auto* env = legacy_v8_current_env();
    JSValueRef value = legacy_v8_decode_raw(env, legacy_v8_raw(this));
    return value && JSValueIsBoolean(env->context, value) && !JSValueToBoolean(env->context, value);
}

bool v8::Value::FullIsTrue() const
{
    auto* env = legacy_v8_current_env();
    JSValueRef value = legacy_v8_decode_raw(env, legacy_v8_raw(this));
    return value && JSValueIsBoolean(env->context, value) && JSValueToBoolean(env->context, value);
}

bool v8::Value::IsArray() const
{
    auto* env = legacy_v8_current_env();
    JSValueRef value = legacy_v8_decode_raw(env, legacy_v8_raw(this));
    return value && JSValueIsArray(env->context, value);
}

bool v8::Value::IsBigInt() const
{
    auto* env = legacy_v8_current_env();
    JSValueRef value = legacy_v8_decode_raw(env, legacy_v8_raw(this));
    return value && JSValueIsBigInt(env->context, value);
}

bool v8::Value::IsBoolean() const
{
    auto* env = legacy_v8_current_env();
    JSValueRef value = legacy_v8_decode_raw(env, legacy_v8_raw(this));
    return value && JSValueIsBoolean(env->context, value);
}

bool v8::Value::IsFunction() const
{
    auto* env = legacy_v8_current_env();
    JSValueRef value = legacy_v8_decode_raw(env, legacy_v8_raw(this));
    if (!value || !JSValueIsObject(env->context, value))
        return false;
    return JSObjectIsFunction(env->context, const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(value)));
}

bool v8::Value::IsInt32() const
{
    auto* env = legacy_v8_current_env();
    bool valid = false;
    double number = legacy_v8_number_value(env, legacy_v8_raw(this), &valid);
    return valid && std::isfinite(number) && std::trunc(number) == number
        && number >= std::numeric_limits<int32_t>::min()
        && number <= std::numeric_limits<int32_t>::max();
}

bool v8::Value::IsMap() const
{
    auto* env = legacy_v8_current_env();
    JSValueRef value = legacy_v8_decode_raw(env, legacy_v8_raw(this));
    if (!value)
        return false;
    JSValueRef exception = nullptr;
    bool result = is_instance_of_global(env, to_napi(value), "Map", &exception);
    if (exception)
        caught(env, exception);
    return result && !exception;
}

bool v8::Value::IsNumber() const
{
    bool valid = false;
    (void)legacy_v8_number_value(legacy_v8_current_env(), legacy_v8_raw(this), &valid);
    return valid;
}

bool v8::Value::IsObject() const
{
    auto* env = legacy_v8_current_env();
    JSValueRef value = legacy_v8_decode_raw(env, legacy_v8_raw(this));
    return value && JSValueIsObject(env->context, value);
}

bool v8::Value::IsUint32() const
{
    auto* env = legacy_v8_current_env();
    bool valid = false;
    double number = legacy_v8_number_value(env, legacy_v8_raw(this), &valid);
    return valid && std::isfinite(number) && std::trunc(number) == number
        && number >= 0 && number <= std::numeric_limits<uint32_t>::max();
}

bool v8::Value::StrictEquals(v8::Local<v8::Value> other) const
{
    auto* env = legacy_v8_current_env();
    uintptr_t left_raw = legacy_v8_raw(this);
    uintptr_t right_raw = other.location ? *other.location : 0;
    JSValueRef left = legacy_v8_decode_raw(env, left_raw);
    JSValueRef right = legacy_v8_decode_raw(env, right_raw);
    if (left && right)
        return JSValueIsStrictEqual(env->context, left, right);
    return left_raw == right_raw;
}

v8::Local<v8::Number> v8::Number::New(v8::Isolate* isolate, double number)
{
    auto* env = legacy_v8_env(isolate);
    uintptr_t* handle = env ? legacy_v8_add_js_handle(JSValueMakeNumber(env->context, number)) : nullptr;
    return v8::Local<v8::Number>(handle);
}

double v8::Number::Value() const
{
    return legacy_v8_number_value(legacy_v8_current_env(), legacy_v8_raw(this));
}

v8::Local<v8::External> v8::External::New(v8::Isolate*, void* pointer)
{
    auto* object = legacy_v8_new_heap(LegacyV8Map::object_map(), LegacyV8HeapKind::external);
    if (!object)
        return v8::Local<v8::External>();
    object->payload.pointer = pointer;
    uintptr_t* handle = legacy_v8_add_handle(
        legacy_v8_tag_pointer(object), nullptr, object,
        [](void* value) { delete static_cast<LegacyV8HeapObject*>(value); });
    return v8::Local<v8::External>(handle);
}

void* v8::External::Value() const
{
    auto* object = legacy_v8_owned_object(this, LegacyV8HeapKind::external);
    return object ? object->payload.pointer : nullptr;
}

static JSStringRef legacy_v8_string_copy(const void* value)
{
    auto* env = legacy_v8_current_env();
    JSValueRef js_value = legacy_v8_decode_raw(env, legacy_v8_raw(value));
    if (!env || !js_value || !JSValueIsString(env->context, js_value))
        return nullptr;
    JSValueRef exception = nullptr;
    JSStringRef string = JSValueToStringCopy(env->context, js_value, &exception);
    if (exception) {
        caught(env, exception);
        return nullptr;
    }
    return string;
}

v8::MaybeLocal<v8::String> v8::String::NewFromUtf8(v8::Isolate* isolate, const char* data, v8::NewStringType, int signed_length)
{
    auto* env = legacy_v8_env(isolate);
    if (!env || !data || signed_length < -1)
        return v8::MaybeLocal<v8::String>();
    size_t length = signed_length < 0 ? NAPI_AUTO_LENGTH : static_cast<size_t>(signed_length);
    JSStringRef string = make_utf8_string(data, length);
    if (!string)
        return v8::MaybeLocal<v8::String>();
    JSValueRef value = JSValueMakeString(env->context, string);
    JSStringRelease(string);
    uintptr_t* handle = legacy_v8_add_js_handle(value);
    return handle ? v8::MaybeLocal<v8::String>(v8::Local<v8::String>(handle)) : v8::MaybeLocal<v8::String>();
}

v8::MaybeLocal<v8::String> v8::String::NewFromOneByte(v8::Isolate* isolate, const uint8_t* data, v8::NewStringType, int signed_length)
{
    auto* env = legacy_v8_env(isolate);
    if (!env || !data || signed_length < -1)
        return v8::MaybeLocal<v8::String>();
    size_t length = signed_length < 0 ? NAPI_AUTO_LENGTH : static_cast<size_t>(signed_length);
    JSStringRef string = make_latin1_string(reinterpret_cast<const char*>(data), length);
    if (!string)
        return v8::MaybeLocal<v8::String>();
    JSValueRef value = JSValueMakeString(env->context, string);
    JSStringRelease(string);
    uintptr_t* handle = legacy_v8_add_js_handle(value);
    return handle ? v8::MaybeLocal<v8::String>(v8::Local<v8::String>(handle)) : v8::MaybeLocal<v8::String>();
}

bool v8::String::ContainsOnlyOneByte() const
{
    JSStringRef string = legacy_v8_string_copy(this);
    if (!string)
        return false;
    const JSChar* characters = JSStringGetCharactersPtr(string);
    size_t length = JSStringGetLength(string);
    bool result = true;
    for (size_t index = 0; index < length; ++index) {
        if (characters[index] > 0xff) {
            result = false;
            break;
        }
    }
    JSStringRelease(string);
    return result;
}

bool v8::String::IsOneByte() const
{
    return ContainsOnlyOneByte();
}

bool v8::String::IsExternal() const
{
    return false;
}

bool v8::String::IsExternalOneByte() const
{
    return false;
}

bool v8::String::IsExternalTwoByte() const
{
    return false;
}

int v8::String::Length() const
{
    JSStringRef string = legacy_v8_string_copy(this);
    if (!string)
        return 0;
    size_t length = JSStringGetLength(string);
    JSStringRelease(string);
    return length > static_cast<size_t>(std::numeric_limits<int>::max())
        ? std::numeric_limits<int>::max()
        : static_cast<int>(length);
}

static size_t legacy_v8_utf8_width(uint32_t code_point)
{
    if (code_point <= 0x7f)
        return 1;
    if (code_point <= 0x7ff)
        return 2;
    if (code_point <= 0xffff)
        return 3;
    return 4;
}

static size_t legacy_v8_encode_utf8(uint32_t code_point, char* output)
{
    const size_t width = legacy_v8_utf8_width(code_point);
    if (width == 1) {
        output[0] = static_cast<char>(code_point);
    } else if (width == 2) {
        output[0] = static_cast<char>(0xc0 | (code_point >> 6));
        output[1] = static_cast<char>(0x80 | (code_point & 0x3f));
    } else if (width == 3) {
        output[0] = static_cast<char>(0xe0 | (code_point >> 12));
        output[1] = static_cast<char>(0x80 | ((code_point >> 6) & 0x3f));
        output[2] = static_cast<char>(0x80 | (code_point & 0x3f));
    } else {
        output[0] = static_cast<char>(0xf0 | (code_point >> 18));
        output[1] = static_cast<char>(0x80 | ((code_point >> 12) & 0x3f));
        output[2] = static_cast<char>(0x80 | ((code_point >> 6) & 0x3f));
        output[3] = static_cast<char>(0x80 | (code_point & 0x3f));
    }
    return width;
}

int v8::String::Utf8Length(v8::Isolate*) const
{
    JSStringRef string = legacy_v8_string_copy(this);
    if (!string)
        return 0;
    const JSChar* characters = JSStringGetCharactersPtr(string);
    size_t length = JSStringGetLength(string);
    size_t bytes = 0;
    for (size_t index = 0; index < length; ++index) {
        uint32_t code_point = characters[index];
        if (code_point >= 0xd800 && code_point <= 0xdbff && index + 1 < length
            && characters[index + 1] >= 0xdc00 && characters[index + 1] <= 0xdfff) {
            code_point = 0x10000 + ((code_point - 0xd800) << 10) + (characters[++index] - 0xdc00);
        }
        bytes += legacy_v8_utf8_width(code_point);
    }
    JSStringRelease(string);
    return bytes > static_cast<size_t>(std::numeric_limits<int>::max())
        ? std::numeric_limits<int>::max()
        : static_cast<int>(bytes);
}

int v8::String::WriteUtf8(v8::Isolate*, char* buffer, int signed_length, int* nchars, int) const
{
    JSStringRef string = legacy_v8_string_copy(this);
    if (!string || !buffer) {
        if (nchars)
            *nchars = 0;
        if (string)
            JSStringRelease(string);
        return 0;
    }
    const size_t string_length = JSStringGetLength(string);
    if (signed_length < 0 && ct_jsc_string_is_8_bit(string)) {
        const size_t capacity = JSStringGetMaximumUTF8CStringSize(string);
        const size_t written = JSStringGetUTF8CString(string, buffer, capacity);
        if (nchars)
            *nchars = static_cast<int>(std::min(string_length, static_cast<size_t>(std::numeric_limits<int>::max())));
        JSStringRelease(string);
        return written > static_cast<size_t>(std::numeric_limits<int>::max())
            ? std::numeric_limits<int>::max()
            : static_cast<int>(written);
    }
    const JSChar* characters = JSStringGetCharactersPtr(string);
    const size_t capacity = signed_length < 0 ? std::numeric_limits<size_t>::max() : static_cast<size_t>(signed_length);
    size_t read = 0;
    size_t written = 0;
    while (read < string_length) {
        uint32_t code_point = characters[read];
        size_t consumed = 1;
        const bool is_surrogate_pair = code_point >= 0xd800 && code_point <= 0xdbff
            && read + 1 < string_length
            && characters[read + 1] >= 0xdc00 && characters[read + 1] <= 0xdfff;
        if (is_surrogate_pair) {
            code_point = 0x10000 + ((code_point - 0xd800) << 10) + (characters[read + 1] - 0xdc00);
            consumed = 2;
        }
        size_t width = legacy_v8_utf8_width(code_point);
        const size_t remaining = capacity - std::min(capacity, written);
        if (is_surrogate_pair && width > remaining && remaining >= 3) {
            // V8 writes the leading surrogate as WTF-8 when a buffer ends
            // between the two UTF-16 code units of a surrogate pair.
            code_point = characters[read];
            consumed = 1;
            width = 3;
        }
        if (width > remaining)
            break;
        legacy_v8_encode_utf8(code_point, buffer + written);
        written += width;
        read += consumed;
    }
    if (read == string_length && written < capacity)
        buffer[written++] = '\0';
    if (nchars)
        *nchars = static_cast<int>(read);
    JSStringRelease(string);
    return static_cast<int>(written);
}

static JSObjectRef legacy_v8_object_ref(NapiEnv* env, const void* value)
{
    JSValueRef js_value = legacy_v8_decode_raw(env, legacy_v8_raw(value));
    if (!js_value || !JSValueIsObject(env->context, js_value))
        return nullptr;
    return const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(js_value));
}

v8::Local<v8::Object> v8::Object::New(v8::Isolate* isolate)
{
    auto* env = legacy_v8_env(isolate);
    JSObjectRef object = env ? JSObjectMake(env->context, nullptr, nullptr) : nullptr;
    return v8::Local<v8::Object>(object ? legacy_v8_add_js_handle(object) : nullptr);
}

v8::MaybeLocal<v8::Value> v8::Object::Get(v8::Local<v8::Context>, uint32_t index)
{
    auto* env = legacy_v8_current_env();
    JSObjectRef object = legacy_v8_object_ref(env, this);
    if (!object)
        return v8::MaybeLocal<v8::Value>();
    JSValueRef exception = nullptr;
    JSValueRef value = JSObjectGetPropertyAtIndex(env->context, object, index, &exception);
    if (exception) {
        caught(env, exception);
        return v8::MaybeLocal<v8::Value>();
    }
    return v8::MaybeLocal<v8::Value>(v8::Local<v8::Value>(legacy_v8_add_js_handle(value)));
}

v8::MaybeLocal<v8::Value> v8::Object::Get(v8::Local<v8::Context>, v8::Local<v8::Value> key)
{
    auto* env = legacy_v8_current_env();
    JSObjectRef object = legacy_v8_object_ref(env, this);
    JSValueRef key_value = legacy_v8_js_value(key);
    if (!object || !key_value)
        return v8::MaybeLocal<v8::Value>();
    JSValueRef exception = nullptr;
    JSValueRef value = JSObjectGetPropertyForKey(env->context, object, key_value, &exception);
    if (exception) {
        caught(env, exception);
        return v8::MaybeLocal<v8::Value>();
    }
    return v8::MaybeLocal<v8::Value>(v8::Local<v8::Value>(legacy_v8_add_js_handle(value)));
}

v8::Maybe<bool> v8::Object::Set(v8::Local<v8::Context>, uint32_t index, v8::Local<v8::Value> value)
{
    auto* env = legacy_v8_current_env();
    JSObjectRef object = legacy_v8_object_ref(env, this);
    JSValueRef assigned = legacy_v8_js_value(value);
    if (!object || !assigned)
        return v8::Maybe<bool>();
    JSValueRef exception = nullptr;
    JSObjectSetPropertyAtIndex(env->context, object, index, assigned, &exception);
    if (exception) {
        caught(env, exception);
        return v8::Maybe<bool>();
    }
    return v8::Maybe<bool>(true);
}

v8::Maybe<bool> v8::Object::Set(v8::Local<v8::Context>, v8::Local<v8::Value> key, v8::Local<v8::Value> value)
{
    auto* env = legacy_v8_current_env();
    JSObjectRef object = legacy_v8_object_ref(env, this);
    JSValueRef key_value = legacy_v8_js_value(key);
    JSValueRef assigned = legacy_v8_js_value(value);
    if (!object || !key_value || !assigned)
        return v8::Maybe<bool>();
    JSValueRef exception = nullptr;
    JSObjectSetPropertyForKey(env->context, object, key_value, assigned, kJSPropertyAttributeNone, &exception);
    if (exception) {
        caught(env, exception);
        return v8::Maybe<bool>();
    }
    return v8::Maybe<bool>(true);
}

void v8::Object::SetInternalField(int index, v8::Local<v8::Data> value)
{
    auto* env = legacy_v8_current_env();
    auto* state = legacy_v8_state_for(env);
    JSObjectRef object = legacy_v8_object_ref(env, this);
    JSValueRef js_value = legacy_v8_js_value(value);
    if (!state || !object || !js_value || index < 0)
        return;
    auto& fields = state->internal_fields[object];
    const size_t required = static_cast<size_t>(index) + 1;
    if (fields.values.size() < required) {
        fields.values.resize(required, nullptr);
        fields.initialized.resize(required, false);
    }
    if (fields.initialized[index] && fields.values[index])
        JSValueUnprotect(env->context, fields.values[index]);
    fields.values[index] = js_value;
    fields.initialized[index] = true;
    JSValueProtect(env->context, js_value);
}

v8::Local<v8::Data> v8::Object::SlowGetInternalField(int index)
{
    auto* env = legacy_v8_current_env();
    auto* state = legacy_v8_state_for(env);
    JSObjectRef object = legacy_v8_object_ref(env, this);
    JSValueRef value = JSValueMakeUndefined(env->context);
    if (state && object && index >= 0) {
        auto iterator = state->internal_fields.find(object);
        if (iterator != state->internal_fields.end()) {
            auto& fields = iterator->second;
            if (static_cast<size_t>(index) < fields.values.size() && fields.initialized[index])
                value = fields.values[index];
        }
    }
    return v8::Local<v8::Data>(legacy_v8_add_js_handle(value));
}

v8::Local<v8::Array> v8::Array::New(v8::Isolate* isolate, int length)
{
    auto* env = legacy_v8_env(isolate);
    if (!env)
        return v8::Local<v8::Array>();
    JSValueRef exception = nullptr;
    JSObjectRef array = JSObjectMakeArray(env->context, 0, nullptr, &exception);
    if (exception || !array) {
        if (exception)
            caught(env, exception);
        return v8::Local<v8::Array>();
    }
    if (length > 0)
        set_property(env, array, "length", JSValueMakeNumber(env->context, length), kJSPropertyAttributeNone, &exception);
    if (exception) {
        caught(env, exception);
        return v8::Local<v8::Array>();
    }
    return v8::Local<v8::Array>(legacy_v8_add_js_handle(array));
}

v8::Local<v8::Array> v8::Array::New(v8::Isolate* isolate, v8::Local<v8::Value>* elements, size_t length)
{
    auto* env = legacy_v8_env(isolate);
    if (!env)
        return v8::Local<v8::Array>();
    std::vector<JSValueRef> values(length);
    for (size_t index = 0; index < length; ++index) {
        values[index] = legacy_v8_js_value(elements[index]);
        if (!values[index])
            values[index] = JSValueMakeUndefined(env->context);
    }
    JSValueRef exception = nullptr;
    JSObjectRef array = JSObjectMakeArray(env->context, length, values.data(), &exception);
    if (exception || !array) {
        if (exception)
            caught(env, exception);
        return v8::Local<v8::Array>();
    }
    return v8::Local<v8::Array>(legacy_v8_add_js_handle(array));
}

v8::MaybeLocal<v8::Array> v8::Array::New(
    v8::Local<v8::Context> context,
    size_t length,
    std::function<v8::MaybeLocal<v8::Value>()> next)
{
    auto* env = legacy_v8_current_env();
    std::vector<JSValueRef> values;
    values.reserve(length);
    for (size_t index = 0; index < length; ++index) {
        v8::MaybeLocal<v8::Value> maybe = next();
        if (maybe.value.IsEmpty())
            return v8::MaybeLocal<v8::Array>();
        JSValueRef value = legacy_v8_js_value(maybe.value);
        if (!value)
            return v8::MaybeLocal<v8::Array>();
        values.push_back(value);
    }
    JSValueRef exception = nullptr;
    JSObjectRef array = JSObjectMakeArray(env->context, length, values.data(), &exception);
    if (exception || !array) {
        if (exception)
            caught(env, exception);
        return v8::MaybeLocal<v8::Array>();
    }
    return v8::MaybeLocal<v8::Array>(v8::Local<v8::Array>(legacy_v8_add_js_handle(array)));
}

uint32_t v8::Array::Length() const
{
    auto* env = legacy_v8_current_env();
    JSObjectRef array = legacy_v8_object_ref(env, this);
    if (!array)
        return 0;
    JSValueRef exception = nullptr;
    JSValueRef value = get_property(env, array, "length", &exception);
    double length = exception ? 0 : JSValueToNumber(env->context, value, &exception);
    if (exception) {
        caught(env, exception);
        return 0;
    }
    return static_cast<uint32_t>(length);
}

v8::Maybe<void> v8::Array::Iterate(v8::Local<v8::Context> context, v8::Array::IterationCallback callback, void* data)
{
    if (!callback)
        return v8::Maybe<void>();
    const uint32_t length = Length();
    for (uint32_t index = 0; index < length; ++index) {
        v8::MaybeLocal<v8::Value> maybe = Get(context, index);
        if (maybe.value.IsEmpty())
            return v8::Maybe<void>();
        switch (callback(index, maybe.value, data)) {
        case v8::Array::CallbackResult::kException:
            return v8::Maybe<void>();
        case v8::Array::CallbackResult::kBreak:
            return v8::Maybe<void>(true);
        case v8::Array::CallbackResult::kContinue:
            break;
        }
    }
    return v8::Maybe<void>(true);
}

v8::Local<v8::ObjectTemplate> v8::ObjectTemplate::New(v8::Isolate*, v8::Local<v8::FunctionTemplate>)
{
    auto* metadata = new (std::nothrow) LegacyV8ObjectTemplateData;
    auto* object = legacy_v8_new_heap(LegacyV8Map::object_map(), LegacyV8HeapKind::object_template);
    if (!metadata || !object) {
        delete metadata;
        delete object;
        return v8::Local<v8::ObjectTemplate>();
    }
    object->payload.pointer = metadata;
    object->destroy_payload = [](void* value) { delete static_cast<LegacyV8ObjectTemplateData*>(value); };
    uintptr_t* handle = legacy_v8_add_handle(
        legacy_v8_tag_pointer(object), nullptr, object,
        [](void* value) { delete static_cast<LegacyV8HeapObject*>(value); });
    return v8::Local<v8::ObjectTemplate>(handle);
}

int v8::ObjectTemplate::InternalFieldCount() const
{
    auto* object = legacy_v8_owned_object(this, LegacyV8HeapKind::object_template);
    auto* metadata = object ? static_cast<LegacyV8ObjectTemplateData*>(object->payload.pointer) : nullptr;
    return metadata ? metadata->internal_field_count : 0;
}

void v8::ObjectTemplate::SetInternalFieldCount(int count)
{
    auto* object = legacy_v8_owned_object(this, LegacyV8HeapKind::object_template);
    auto* metadata = object ? static_cast<LegacyV8ObjectTemplateData*>(object->payload.pointer) : nullptr;
    if (metadata)
        metadata->internal_field_count = std::max(0, count);
}

v8::MaybeLocal<v8::Object> v8::ObjectTemplate::NewInstance(v8::Local<v8::Context>)
{
    auto* env = legacy_v8_current_env();
    auto* state = legacy_v8_state_for(env);
    auto* template_object = legacy_v8_owned_object(this, LegacyV8HeapKind::object_template);
    auto* metadata = template_object ? static_cast<LegacyV8ObjectTemplateData*>(template_object->payload.pointer) : nullptr;
    if (!env || !state || !metadata)
        return v8::MaybeLocal<v8::Object>();
    JSObjectRef object = JSObjectMake(env->context, nullptr, nullptr);
    auto& fields = state->internal_fields[object];
    fields.values.resize(metadata->internal_field_count, nullptr);
    fields.initialized.resize(metadata->internal_field_count, false);
    return v8::MaybeLocal<v8::Object>(v8::Local<v8::Object>(legacy_v8_add_js_handle(object)));
}

v8::Local<v8::FunctionTemplate> v8::FunctionTemplate::New(
    v8::Isolate*,
    v8::FunctionCallback callback,
    v8::Local<v8::Value> data,
    v8::Local<v8::Signature>,
    int,
    v8::ConstructorBehavior,
    v8::SideEffectType,
    const v8::CFunction*,
    uint16_t,
    uint16_t,
    uint16_t)
{
    auto* function_template = new (std::nothrow) LegacyV8FunctionTemplateData { callback, legacy_v8_js_value(data) };
    auto* object = legacy_v8_new_heap(LegacyV8Map::object_map(), LegacyV8HeapKind::function_template);
    if (!function_template || !object) {
        delete function_template;
        delete object;
        return v8::Local<v8::FunctionTemplate>();
    }
    object->payload.pointer = function_template;
    object->destroy_payload = [](void* value) { delete static_cast<LegacyV8FunctionTemplateData*>(value); };
    uintptr_t* handle = legacy_v8_add_handle(
        legacy_v8_tag_pointer(object), nullptr, object,
        [](void* value) { delete static_cast<LegacyV8HeapObject*>(value); });
    if (!handle) {
        delete object;
        return v8::Local<v8::FunctionTemplate>();
    }
    return v8::Local<v8::FunctionTemplate>(handle);
}

v8::MaybeLocal<v8::Function> v8::FunctionTemplate::GetFunction(v8::Local<v8::Context>)
{
    auto* env = legacy_v8_current_env();
    auto* template_object = legacy_v8_owned_object(this, LegacyV8HeapKind::function_template);
    auto* function_template = template_object
        ? static_cast<LegacyV8FunctionTemplateData*>(template_object->payload.pointer)
        : nullptr;
    if (!env || !function_template || !function_template->callback)
        return v8::MaybeLocal<v8::Function>();
    std::call_once(legacy_v8_classes_once, initialize_legacy_v8_classes);
    auto* data = new (std::nothrow) LegacyV8FunctionData {
        env,
        env->context,
        function_template->callback,
        function_template->data,
    };
    if (!data)
        return v8::MaybeLocal<v8::Function>();
    if (data->data)
        JSValueProtect(data->context, data->data);
    JSObjectRef function = JSObjectMake(env->context, legacy_v8_function_class, data);
    JSValueRef exception = nullptr;
    JSObjectRef function_constructor = global_constructor(env, "Function", &exception);
    if (!exception && function_constructor) {
        JSValueRef prototype = get_property(env, function_constructor, "prototype", &exception);
        if (!exception && prototype)
            JSObjectSetPrototype(env->context, function, prototype);
    }
    if (exception) {
        caught(env, exception);
        return v8::MaybeLocal<v8::Function>();
    }
    uintptr_t* handle = legacy_v8_add_js_handle(function);
    if (!handle)
        return v8::MaybeLocal<v8::Function>();
    return v8::MaybeLocal<v8::Function>(v8::Local<v8::Function>(handle));
}

v8::Local<v8::Value> v8::Function::GetName() const
{
    auto* env = legacy_v8_current_env();
    JSObjectRef function = legacy_v8_object_ref(env, this);
    if (!function)
        return v8::Local<v8::Value>();
    JSValueRef exception = nullptr;
    JSValueRef name = get_property(env, function, "name", &exception);
    if (exception) {
        caught(env, exception);
        return v8::Local<v8::Value>();
    }
    return v8::Local<v8::Value>(legacy_v8_add_js_handle(name));
}

void v8::Function::SetName(v8::Local<v8::String> name)
{
    auto* env = legacy_v8_current_env();
    JSObjectRef function = legacy_v8_object_ref(env, this);
    JSValueRef name_value = legacy_v8_js_value(name);
    if (!env || !function || !name_value)
        return;
    JSValueRef exception = nullptr;
    define_data_property(env, function, "name", name_value, false, false, true, &exception);
    if (exception)
        caught(env, exception);
}

void v8::api_internal::ToLocalEmpty()
{
    std::abort();
}

void v8::api_internal::FromJustIsNothing()
{
    std::abort();
}

uintptr_t* v8::api_internal::GlobalizeReference(v8::internal::Isolate*, uintptr_t raw)
{
    auto* env = legacy_v8_current_env();
    if (!env)
        return nullptr;
    auto* persistent = new (std::nothrow) LegacyV8Handle;
    if (!persistent)
        return nullptr;
    persistent->raw = raw;
    if (!legacy_v8_raw_is_smi(raw) && !legacy_v8_as_oddball(raw)) {
        auto* object = legacy_v8_heap_object(raw);
        if (!object) {
            delete persistent;
            return nullptr;
        }
        auto* clone = legacy_v8_new_heap(
            object->kind == LegacyV8HeapKind::number ? LegacyV8Map::heap_number_map() : LegacyV8Map::object_map(),
            object->kind);
        if (!clone) {
            delete persistent;
            return nullptr;
        }
        clone->payload = object->payload;
        persistent->raw = legacy_v8_tag_pointer(clone);
        persistent->owned_value = clone;
        persistent->destroy_owned = [](void* value) { delete static_cast<LegacyV8HeapObject*>(value); };
        if (object->kind == LegacyV8HeapKind::js_value) {
            persistent->protected_value = object->payload.js_value;
            JSValueProtect(env->context, persistent->protected_value);
        }
    }
    return &persistent->raw;
}

void v8::api_internal::DisposeGlobal(uintptr_t* location)
{
    if (!location)
        return;
    auto* env = legacy_v8_current_env();
    auto* persistent = reinterpret_cast<LegacyV8Handle*>(location);
    if (env && persistent->protected_value)
        JSValueUnprotect(env->context, persistent->protected_value);
    if (persistent->destroy_owned)
        persistent->destroy_owned(persistent->owned_value);
    delete persistent;
}

v8::Local<v8::Value> v8::api_internal::GetFunctionTemplateData(v8::Isolate*, v8::Local<v8::Data> target)
{
    auto* object = target.location ? legacy_v8_heap_object(*target.location) : nullptr;
    auto* function = object && object->kind == LegacyV8HeapKind::function_target
        ? static_cast<LegacyV8FunctionData*>(object->payload.pointer)
        : nullptr;
    auto* env = legacy_v8_current_env();
    JSValueRef data = function && function->data ? function->data : JSValueMakeUndefined(env->context);
    return v8::Local<v8::Value>(legacy_v8_add_js_handle(data));
}

v8::internal::Isolate* v8::internal::IsolateFromNeverReadOnlySpaceObject(uintptr_t)
{
    return reinterpret_cast<v8::internal::Isolate*>(v8::Isolate::GetCurrent());
}

void node::AddEnvironmentCleanupHook(v8::Isolate* isolate, void (*callback)(void*), void* data)
{
    auto* env = legacy_v8_env(isolate);
    if (env && callback)
        (void)napi_add_env_cleanup_hook(reinterpret_cast<napi_env>(env), callback, data);
}

void node::RemoveEnvironmentCleanupHook(v8::Isolate* isolate, void (*callback)(void*), void* data)
{
    auto* env = legacy_v8_env(isolate);
    if (env && callback)
        (void)napi_remove_env_cleanup_hook(reinterpret_cast<napi_env>(env), callback, data);
}

static void napi_uv_work_execute(uv_work_t* request)
{
    auto* work = static_cast<napi_async_work__*>(request->data);
    int expected = 1;
    if (!work || !work->state.compare_exchange_strong(expected, 2))
        return;
    if (work->execute)
        work->execute(reinterpret_cast<napi_env>(work->env), work->data);
}

static void napi_uv_work_complete(uv_work_t* request, int status)
{
    auto* work = static_cast<napi_async_work__*>(request->data);
    if (!work || !work->env)
        return;
    work->state.store(status == UV_ECANCELED ? 4 : 3);
    NapiEnv* root = root_env(work->env);
    {
        std::lock_guard lock(root->async_mutex);
        root->completed_work.push_back(work);
    }
    wake(work->env);
}

static NapiEnv* allocate_env(
    JSGlobalContextRef context,
    uv_loop_t* event_loop,
    void* wake_opaque,
    CtNapiWakeCallback wake_callback,
    NapiEnv* root
)
{
    if (!context || (!root && !event_loop)
        || (root && (!event_loop_is_active(root) || event_loop != event_loop_for_env(root))))
        return nullptr;
    auto* env = new (std::nothrow) NapiEnv;
    if (!env)
        return nullptr;
    env->runtime_root = root ? root : env;
    env->context = context;
    if (!root) {
        env->event_loop = event_loop;
        env->event_loop_lifecycle = NapiEventLoopLifecycle::active;
    }
    env->wake_opaque = wake_opaque;
    env->wake_callback = wake_callback;
    env->owner_thread = std::this_thread::get_id();
    char key[96];
    std::snprintf(key, sizeof(key), "__cottontail_napi_wrap_%p", static_cast<void*>(env));
    env->wrap_key = key;
    finish(env, napi_ok);
    return env;
}

static void teardown_threadsafe_function(NapiEnv* env, napi_threadsafe_function__* function)
{
    std::deque<NapiTsfnCall> pending_calls;
    {
        std::lock_guard lock(function->mutex);
        function->teardown_started = true;
        function->closing = true;
        function->aborting = true;
        function->referenced = false;
        pending_calls.swap(function->queue);
    }
    function->space_available.notify_all();

    if (function->call_js) {
        while (!pending_calls.empty()) {
            function->call_js(nullptr, nullptr, function->context, pending_calls.front().data);
            pending_calls.pop_front();
        }
    }

    if (!function->finalized && function->finalize_callback) {
        AutomaticScope scope(env);
        function->finalize_callback(reinterpret_cast<napi_env>(env), function->finalize_data, function->context);
    }
    if (function->async_context) {
        napi_async_context context = std::exchange(function->async_context, nullptr);
        (void)napi_async_destroy(reinterpret_cast<napi_env>(env), context);
    }
    if (function->callback)
        JSValueUnprotect(env->context, function->callback);

    bool delete_now = false;
    {
        std::lock_guard lock(function->mutex);
        function->callback = nullptr;
        function->finalized = true;
        function->teardown_complete = true;
        function->env = nullptr;
        delete_now = function->thread_count == 0;
    }
    if (delete_now)
        delete function;
}

extern "C" CtNapiEnv* ct_napi_env_create(
    JSGlobalContextRef context,
    uv_loop_t* event_loop,
    void* wake_opaque,
    CtNapiWakeCallback wake_callback
)
{
    if (!context || !event_loop)
        return nullptr;
    auto* env = allocate_env(context, event_loop, wake_opaque, wake_callback, nullptr);
    return env;
}

static void drain_finalizer_queues(NapiEnv* env)
{
    for (;;) {
        std::deque<NapiPostedFinalizer> basic;
        std::deque<NapiPostedFinalizer> posted;
        {
            std::lock_guard lock(env->async_mutex);
            basic.swap(env->basic_finalizers);
            posted.swap(env->posted_finalizers);
        }
        if (basic.empty() && posted.empty())
            break;
        for (const auto& finalizer : basic) {
            BasicFinalizerScope finalizer_scope(env, true);
            if (finalizer.callback)
                finalizer.callback(reinterpret_cast<napi_env>(env), finalizer.data, finalizer.hint);
        }
        for (const auto& finalizer : posted) {
            BasicFinalizerScope finalizer_scope(env, false, finalizer.is_finalizer);
            if (finalizer.callback)
                finalizer.callback(reinterpret_cast<napi_env>(env), finalizer.data, finalizer.hint);
        }
    }
}

static uint32_t finalizer_retain_count(const NapiFinalizerData* finalizer)
{
    auto* reference = finalizer ? finalizer->wrap_ref : nullptr;
    if (!reference || reference->deleted || reference->invalidated)
        return 0;
    return reference->count;
}

static void destroy_single_env(NapiEnv* env)
{
    ActiveEnvScope active_scope(env);
    for (;;) {
        auto sync = std::max_element(env->cleanup_hooks.begin(), env->cleanup_hooks.end(), [](const auto& left, const auto& right) {
            return left.order < right.order;
        });
        auto async = std::max_element(env->async_cleanup_hooks.begin(), env->async_cleanup_hooks.end(), [](const auto* left, const auto* right) {
            return left->order < right->order;
        });
        const bool has_sync = sync != env->cleanup_hooks.end();
        const bool has_async = async != env->async_cleanup_hooks.end();
        if (!has_sync && !has_async)
            break;
        if (has_async && (!has_sync || (*async)->order > sync->order)) {
            auto* hook = *async;
            hook->executing = true;
            if (!hook->removed && hook->callback)
                hook->callback(reinterpret_cast<napi_async_cleanup_hook_handle>(hook), hook->data);
            hook->executing = false;
            if (hook->removed) {
                auto iterator = std::find(env->async_cleanup_hooks.begin(), env->async_cleanup_hooks.end(), hook);
                if (iterator != env->async_cleanup_hooks.end()) env->async_cleanup_hooks.erase(iterator);
                hook->env = nullptr;
                delete hook;
                continue;
            }

            // Drive only until this hook unregisters. UV_RUN_DEFAULT would
            // also wait for unrelated referenced handles on the shared loop.
            if (auto* loop = event_loop_for_env(env)) {
                while (std::find(env->async_cleanup_hooks.begin(), env->async_cleanup_hooks.end(), hook)
                    != env->async_cleanup_hooks.end()) {
                    if (uv_run(loop, UV_RUN_ONCE) == 0)
                        break;
                }
            }
            auto iterator = std::find(env->async_cleanup_hooks.begin(), env->async_cleanup_hooks.end(), hook);
            if (iterator != env->async_cleanup_hooks.end()) {
                env->async_cleanup_hooks.erase(iterator);
                hook->removed = true;
                hook->env = nullptr;
                delete hook;
            }
        } else {
            NapiCleanupHook hook = *sync;
            env->cleanup_hooks.erase(sync);
            if (hook.callback)
                hook.callback(hook.data);
        }
    }

    auto thread_safe_functions = env->thread_safe_functions;
    env->thread_safe_functions.clear();
    for (auto* function : thread_safe_functions)
        teardown_threadsafe_function(env, function);

    if (env->instance_finalizer) {
        auto callback = env->instance_finalizer;
        env->instance_finalizer = nullptr;
        callback(reinterpret_cast<napi_env>(env), env->instance_data, env->instance_hint);
        std::fflush(nullptr);
    }

    // ObjectWrap instances can retain one another through their wrap refs.
    // Run an unretained child's destructor before the parent it will unref.
    while (!env->finalizers.empty()) {
        NapiFinalizerData* finalizer = nullptr;
        uint32_t lowest_retain_count = std::numeric_limits<uint32_t>::max();
        for (auto* candidate : env->finalizers) {
            const uint32_t retain_count = finalizer_retain_count(candidate);
            if (!finalizer || retain_count < lowest_retain_count) {
                finalizer = candidate;
                lowest_retain_count = retain_count;
            }
            if (retain_count == 0)
                break;
        }
        if (!finalizer)
            break;
        env->finalizers.erase(finalizer);
        invalidate_wrap_reference(finalizer);
        run_finalizer(finalizer);
        finalizer->env = nullptr;
        drain_finalizer_queues(env);
    }

    std::vector<NapiBufferFinalizer*> buffer_finalizers;
    {
        std::lock_guard lock(env->async_mutex);
        buffer_finalizers.assign(env->buffer_finalizers.begin(), env->buffer_finalizers.end());
        env->buffer_finalizers.clear();
    }
    for (auto* finalizer : buffer_finalizers) {
        if (!finalizer || finalizer->finalized)
            continue;
        finalizer->finalized = true;
        if (finalizer->callback)
            finalizer->callback(reinterpret_cast<napi_env>(env), finalizer->data, finalizer->hint);
        else if (finalizer->owns_data)
            std::free(finalizer->data);
        finalizer->env = nullptr;
    }

    drain_finalizer_queues(env);

    auto references = env->references;
    for (auto* reference : references) {
        if (reference->value && reference->strong)
            JSValueUnprotect(env->context, reference->value);
        if (reference->weak_ref)
            JSValueUnprotect(env->context, reference->weak_ref);
        delete reference;
    }
    env->references.clear();

    auto work_items = env->async_work;
    for (auto* work : work_items) {
        env->async_work.erase(work);
        delete work;
    }

    auto async_contexts = env->async_contexts;
    for (auto* context : async_contexts) {
        if (context->record)
            JSValueUnprotect(env->context, context->record);
        if (context->resource)
            JSWeakRelease(JSContextGetGroup(env->context), context->resource);
        delete context;
    }
    env->async_contexts.clear();

    if (env->pending_exception)
        JSValueUnprotect(env->context, env->pending_exception);
    if (env->function_call)
        JSValueUnprotect(env->context, env->function_call);
    if (env->wrap_map)
        JSValueUnprotect(env->context, env->wrap_map);
    if (env->logically_detached_buffers)
        JSValueUnprotect(env->context, env->logically_detached_buffers);
    if (env->addon_exports)
        JSValueUnprotect(env->context, env->addon_exports);
    legacy_v8_destroy_state(env);
    if (env == env->runtime_root) {
        env->event_loop_lifecycle = NapiEventLoopLifecycle::unavailable;
        env->event_loop = nullptr;
    }
    delete env;
}

extern "C" CtNapiEnv* ct_napi_env_for_ffi_library(CtNapiEnv* opaque_env, const char* identity)
{
    auto* root = root_env(static_cast<NapiEnv*>(opaque_env));
    if (!root || !identity || !event_loop_is_active(root))
        return nullptr;
    auto existing = root->ffi_envs.find(identity);
    if (existing != root->ffi_envs.end())
        return existing->second;

    auto* env = allocate_env(root->context, event_loop_for_env(root), root->wake_opaque, root->wake_callback, root);
    if (!env)
        return nullptr;
    env->module_api_version = 9;
    env->module_filename = std::string("ffi://") + identity;
    try {
        root->ffi_envs.emplace(identity, env);
        root->addon_envs.push_back(env);
    } catch (...) {
        root->ffi_envs.erase(identity);
        destroy_single_env(env);
        return nullptr;
    }
    return env;
}

extern "C" void ct_napi_env_destroy(CtNapiEnv* opaque_env)
{
    auto* root = root_env(static_cast<NapiEnv*>(opaque_env));
    if (!root || !event_loop_is_active(root))
        return;
    MicrotaskDelayScope microtasks(root->context);

    root->event_loop_lifecycle = NapiEventLoopLifecycle::cleanup;
    root->destroying = true;
    for (auto* env : root->addon_envs)
        env->destroying = true;

    std::vector<NapiEnv*> environments { root };
    environments.insert(environments.end(), root->addon_envs.begin(), root->addon_envs.end());
    for (auto* env : environments) {
        std::lock_guard lock(env->async_mutex);
        for (auto* work : env->async_work) {
            if (work->state.load() == 1)
                (void)uv_cancel(reinterpret_cast<uv_req_t*>(&work->request));
        }
    }
    for (;;) {
        bool pending = false;
        for (auto* env : environments) {
            std::lock_guard lock(env->async_mutex);
            for (auto* work : env->async_work) {
                const int state = work->state.load();
                if (state == 1 || state == 2) {
                    pending = true;
                    break;
                }
            }
            if (pending) break;
        }
        auto* loop = event_loop_for_env(root);
        if (!pending || !loop) break;
        (void)uv_run(loop, UV_RUN_ONCE);
    }

    for (auto iterator = root->addon_envs.rbegin(); iterator != root->addon_envs.rend(); ++iterator)
        destroy_single_env(*iterator);
    root->addon_envs.clear();
    root->ffi_envs.clear();
    destroy_single_env(root);
}

extern "C" void napi_module_register(napi_module* module)
{
    auto* session = module_registration_session;
    if (!session)
        return;
    session->attempted = true;
    if (!module || !module->nm_register_func) {
        session->invalid = true;
        return;
    }
    try {
        session->registrations.push_back(RegisteredModule::from_napi(*module));
    } catch (...) {
        session->allocation_failed = true;
    }
}

extern "C" void node_module_register(void* opaque_module)
{
    auto* session = module_registration_session;
    if (!session)
        return;
    session->attempted = true;
    auto* module = static_cast<node::node_module*>(opaque_module);
    if (!module || (!module->nm_register_func && !module->nm_context_register_func)) {
        session->invalid = true;
        return;
    }
    try {
        session->registrations.push_back(RegisteredModule::from_legacy(module));
    } catch (...) {
        session->allocation_failed = true;
    }
}

static bool cache_registered_modules(void* handle, const std::vector<RegisteredModule>& registrations)
{
    try {
        std::lock_guard lock(registered_modules_mutex);
        registered_modules[handle] = registrations;
        return true;
    } catch (...) {
        return false;
    }
}

static bool find_registered_modules(
    void* handle,
    std::vector<RegisteredModule>* registrations,
    bool* found
)
{
    try {
        std::lock_guard lock(registered_modules_mutex);
        auto iterator = registered_modules.find(handle);
        *found = iterator != registered_modules.end();
        if (*found)
            *registrations = iterator->second;
        return true;
    } catch (...) {
        return false;
    }
}

static JSValueRef make_loader_error(NapiEnv* env, const std::string& message)
{
    JSStringRef string = make_utf8_string(message.data(), message.size());
    JSValueRef argument = JSValueMakeString(env->context, string);
    JSStringRelease(string);
    JSValueRef exception = nullptr;
    JSObjectRef error = JSObjectMakeError(env->context, 1, &argument, &exception);
    return exception ? exception : error;
}

static bool retain_addon_env(NapiEnv* root, NapiEnv* env, JSValueRef* exception)
{
    try {
        root->addon_envs.push_back(env);
        return true;
    } catch (...) {
        *exception = make_loader_error(root, "failed to retain a Node-API environment");
        return false;
    }
}

static JSValueRef invoke_napi_module(
    NapiEnv* env,
    napi_addon_register_func callback,
    JSObjectRef exports,
    JSValueRef* exception
)
{
    if (!callback)
        return nullptr;
    ActiveEnvScope active_scope(env);
    AutomaticScope automatic_scope(env);
    napi_value result = callback(reinterpret_cast<napi_env>(env), to_napi(exports));
    if (env->pending_exception) {
        *exception = env->pending_exception;
        JSValueUnprotect(env->context, env->pending_exception);
        env->pending_exception = nullptr;
        return nullptr;
    }
    return result ? to_js(result) : nullptr;
}

static JSValueRef invoke_legacy_module(NapiEnv* env, node::node_module* module, JSObjectRef exports, JSValueRef* exception)
{
    constexpr int node_module_version = 137;
    const char* module_name = module && module->nm_modname ? module->nm_modname : "unknown";
    if (!module)
        return nullptr;
    if (module->nm_version != node_module_version) {
        *exception = make_loader_error(
            env,
            std::string("The module '") + module_name
                + "' was compiled against a different Node.js ABI version using NODE_MODULE_VERSION "
                + std::to_string(module->nm_version)
                + ". This version of Cottontail requires NODE_MODULE_VERSION "
                + std::to_string(node_module_version) + ". Please try re-compiling or re-installing the module.");
        return nullptr;
    }
    if (!module->nm_context_register_func && !module->nm_register_func) {
        *exception = make_loader_error(env, std::string("The module '") + module_name + "' has no declared entry point.");
        return nullptr;
    }
    if (!exports)
        exports = JSObjectMake(env->context, nullptr, nullptr);
    JSObjectRef module_object = JSObjectMake(env->context, nullptr, nullptr);
    set_property(env, module_object, "exports", exports, kJSPropertyAttributeNone, exception);
    if (*exception)
        return nullptr;

    ActiveEnvScope active_scope(env);
    AutomaticScope automatic_scope(env);
    v8::Isolate* isolate = legacy_v8_isolate(env);
    v8::HandleScope handle_scope(isolate);
    v8::Local<v8::Object> local_exports(legacy_v8_add_js_handle(exports));
    v8::Local<v8::Value> local_module(legacy_v8_add_js_handle(module_object));
    v8::Local<v8::Context> context = isolate->GetCurrentContext();
    if (module->nm_context_register_func)
        module->nm_context_register_func(local_exports, local_module, context, module->nm_priv);
    else
        module->nm_register_func(local_exports, local_module, module->nm_priv);

    if (env->pending_exception) {
        *exception = env->pending_exception;
        JSValueUnprotect(env->context, env->pending_exception);
        env->pending_exception = nullptr;
        return nullptr;
    }
    JSValueRef result = get_property(env, module_object, "exports", exception);
    return *exception ? nullptr : result;
}

static JSValueRef remember_addon_exports(NapiEnv* env, void* handle, JSValueRef exports)
{
    env->addon_handle = handle;
    env->addon_exports = exports;
    if (exports)
        JSValueProtect(env->context, exports);
    return exports;
}

static void* find_addon_symbol(void* handle, const char* symbol)
{
    if (!handle || !symbol)
        return nullptr;
    uv_lib_t library {};
    library.handle = reinterpret_cast<decltype(library.handle)>(handle);
    void* pointer = nullptr;
    const int status = uv_dlsym(&library, symbol, &pointer);
    library.handle = nullptr;
    uv_dlclose(&library);
    return status == 0 ? pointer : nullptr;
}

static std::string addon_no_entrypoint_message(const char* path)
{
    std::string module_name = path ? path : "unknown";
    const size_t separator = module_name.find_last_of("/\\");
    if (separator != std::string::npos)
        module_name.erase(0, separator + 1);
    if (module_name.ends_with(".node"))
        module_name.resize(module_name.size() - 5);
    return std::string("The module '") + module_name + "' has no declared entry point.";
}

extern "C" JSValueRef ct_napi_load_addon(
    CtNapiEnv* opaque_env,
    const char* path,
    JSObjectRef exports,
    JSValueRef* exception
)
{
    auto* root = root_env(static_cast<NapiEnv*>(opaque_env));
    if (exception)
        *exception = nullptr;
    if (!root || !path || !exception || !event_loop_is_active(root))
        return nullptr;

    auto* env = allocate_env(root->context, event_loop_for_env(root), root->wake_opaque, root->wake_callback, root);
    if (!env) {
        *exception = make_loader_error(root, "failed to allocate a Node-API environment");
        return nullptr;
    }
    try {
        env->module_filename = path_to_file_uri(path);
    } catch (...) {
        *exception = make_loader_error(root, "failed to record the native addon filename");
        destroy_single_env(env);
        return nullptr;
    }

    ModuleRegistrationSession registration_session;
    ModuleRegistrationScope registration_scope(env, &registration_session);
    AddonLibrary library;
    const bool opened = library.open(path);
    registration_scope.did_finish_loading();
    if (!opened) {
        *exception = make_loader_error(env, std::string("uv_dlopen(") + path + ") failed: " + library.error());
        destroy_single_env(env);
        return nullptr;
    }
    void* handle = library.key();

    if (registration_session.allocation_failed) {
        *exception = make_loader_error(env, "failed to record a native addon registration");
        destroy_single_env(env);
        return nullptr;
    }

    const bool registered_during_load = registration_session.attempted;
    bool found_cached_registrations = false;
    if (!registered_during_load
        && !find_registered_modules(handle, &registration_session.registrations, &found_cached_registrations)) {
        *exception = make_loader_error(env, "failed to retrieve cached native addon registrations");
        destroy_single_env(env);
        return nullptr;
    }

    if (registered_during_load && registration_session.invalid) {
        *exception = make_loader_error(env, addon_no_entrypoint_message(path));
        destroy_single_env(env);
        return nullptr;
    }

    if (!registration_session.registrations.empty()) {
        if (registered_during_load && !cache_registered_modules(handle, registration_session.registrations)) {
            *exception = make_loader_error(env, "failed to cache native addon registrations");
            destroy_single_env(env);
            return nullptr;
        }
        library.keep_loaded();

        JSValueRef current_exports = exports ? static_cast<JSValueRef>(exports) : JSObjectMake(env->context, nullptr, nullptr);
        const size_t cached_registration_count = registration_session.registrations.size();
        size_t index = 0;
        while (index < registration_session.registrations.size()) {
            RegisteredModule registration = registration_session.registrations[index++];
            NapiEnv* module_env = env;
            if (index > 1) {
                module_env = allocate_env(root->context, event_loop_for_env(root), root->wake_opaque, root->wake_callback, root);
                if (!module_env) {
                    *exception = make_loader_error(root, "failed to allocate a Node-API environment");
                    return nullptr;
                }
                try {
                    module_env->module_filename = env->module_filename;
                } catch (...) {
                    *exception = make_loader_error(root, "failed to record the native addon filename");
                    destroy_single_env(module_env);
                    return nullptr;
                }
            }

            if (registration.kind == RegisteredModuleKind::napi)
                module_env->module_api_version = registration.napi_module_data.nm_version;
            if (!retain_addon_env(root, module_env, exception)) {
                destroy_single_env(module_env);
                return nullptr;
            }

            if (registration.kind == RegisteredModuleKind::legacy) {
                if (!JSValueIsObject(module_env->context, current_exports)) {
                    *exception = make_loader_error(module_env, "Expected a native addon registration to receive an exports object");
                    return nullptr;
                }
                current_exports = invoke_legacy_module(
                    module_env,
                    registration.legacy_module,
                    const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(current_exports)),
                    exception);
            } else {
                auto& module = registration.napi_module_data;
                if (!JSValueIsObject(module_env->context, current_exports)) {
                    *exception = make_loader_error(module_env, "Expected a Node-API module registration to receive an exports object");
                    return nullptr;
                }
                current_exports = invoke_napi_module(
                    module_env,
                    module.nm_register_func,
                    const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(current_exports)),
                    exception);
                if (!*exception && !current_exports) {
                    const char* module_name = module.nm_modname ? module.nm_modname : "unknown";
                    *exception = make_loader_error(module_env, std::string("Node-API module \"") + module_name + "\" returned an error");
                } else if (!*exception && !JSValueIsObject(module_env->context, current_exports)) {
                    const char* module_name = module.nm_modname ? module.nm_modname : "unknown";
                    *exception = make_loader_error(module_env, std::string("Expected Node-API module \"") + module_name + "\" to return an exports object");
                }
            }
            if (*exception)
                return nullptr;
            current_exports = remember_addon_exports(module_env, handle, current_exports);
            if (registration_session.allocation_failed) {
                *exception = make_loader_error(module_env, "failed to record a native addon registration");
                return nullptr;
            }
            if (registration_session.invalid) {
                *exception = make_loader_error(module_env, addon_no_entrypoint_message(path));
                return nullptr;
            }
        }

        if ((registered_during_load || registration_session.registrations.size() != cached_registration_count)
            && !cache_registered_modules(handle, registration_session.registrations)) {
            *exception = make_loader_error(env, "failed to cache native addon registrations");
            return nullptr;
        }
        return current_exports;
    }

    using RegisterFunction = napi_value (*)(napi_env, napi_value);
    using ApiVersionFunction = int32_t (*)();
    auto direct_register = library.symbol<RegisterFunction>("napi_register_module_v1");
    auto get_api_version = library.symbol<ApiVersionFunction>("node_api_module_get_api_version_v1");
    env->module_api_version = get_api_version ? get_api_version() : 8;
    if (!direct_register) {
        *exception = make_loader_error(env, std::string("Native addon ") + path + " does not export a Node-API or V8 module initializer");
        destroy_single_env(env);
        return nullptr;
    }

    if (!exports)
        exports = JSObjectMake(env->context, nullptr, nullptr);
    if (!retain_addon_env(root, env, exception)) {
        destroy_single_env(env);
        return nullptr;
    }
    library.keep_loaded();
    JSValueRef result = invoke_napi_module(env, direct_register, exports, exception);
    if (*exception)
        return nullptr;
    return remember_addon_exports(env, handle, result ? result : exports);
}

extern "C" void* ct_napi_get_addon_symbol(
    CtNapiEnv* opaque_env,
    JSValueRef addon_exports,
    const char* symbol
)
{
    auto* root = root_env(static_cast<NapiEnv*>(opaque_env));
    if (!root || !addon_exports || !symbol)
        return nullptr;
    for (auto* env : root->addon_envs) {
        if (!env->addon_handle || !env->addon_exports)
            continue;
        if (JSValueIsStrictEqual(root->context, env->addon_exports, addon_exports))
            return find_addon_symbol(env->addon_handle, symbol);
    }
    return nullptr;
}

extern "C" bool ct_napi_get_external_value(
    CtNapiEnv* opaque_env,
    JSValueRef value,
    void** result
)
{
    auto* root = root_env(static_cast<NapiEnv*>(opaque_env));
    if (!root || !value || !result)
        return false;
    std::call_once(classes_once, initialize_classes);
    if (!JSValueIsObjectOfClass(root->context, value, external_class))
        return false;
    auto* finalizer = static_cast<NapiFinalizerData*>(
        JSObjectGetPrivate(const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(value))));
    if (!finalizer || !finalizer->active || !finalizer->external ||
        !finalizer->env || root_env(finalizer->env) != root)
        return false;
    *result = finalizer->data;
    return true;
}

extern "C" napi_status napi_get_last_error_info(napi_env opaque_env, const napi_extended_error_info** result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    *result = &env->last_error;
    return napi_ok;
}

extern "C" napi_status napi_get_undefined(napi_env opaque_env, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    return env ? output(env, result, JSValueMakeUndefined(env->context)) : napi_invalid_arg;
}

extern "C" napi_status napi_get_null(napi_env opaque_env, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    return env ? output(env, result, JSValueMakeNull(env->context)) : napi_invalid_arg;
}

extern "C" napi_status napi_get_global(napi_env opaque_env, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    return env ? output(env, result, JSContextGetGlobalObject(env->context)) : napi_invalid_arg;
}

extern "C" napi_status napi_get_boolean(napi_env opaque_env, bool value, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    return env ? output(env, result, JSValueMakeBoolean(env->context, value)) : napi_invalid_arg;
}

extern "C" napi_status napi_create_object(napi_env opaque_env, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    return env ? output(env, result, JSObjectMake(env->context, nullptr, nullptr)) : napi_invalid_arg;
}

extern "C" napi_status napi_create_array(napi_env opaque_env, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    JSObjectRef array = JSObjectMakeArray(env->context, 0, nullptr, &exception);
    return exception ? caught(env, exception) : output(env, result, array);
}

extern "C" napi_status napi_create_array_with_length(napi_env opaque_env, size_t length, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);

    // Node's V8 implementation narrows size_t to int before constructing the
    // array. Bun preserves this observable behavior as well.
    const int32_t narrowed = static_cast<int32_t>(length);
    const uint32_t array_length = narrowed > 0 ? static_cast<uint32_t>(narrowed) : 0;
    JSValueRef exception = nullptr;
    JSObjectRef array_constructor = global_constructor(env, "Array", &exception);
    JSValueRef argument = JSValueMakeNumber(env->context, static_cast<double>(array_length));
    JSObjectRef array = exception || !array_constructor ? nullptr : JSObjectCallAsConstructor(env->context, array_constructor, 1, &argument, &exception);
    return exception ? caught(env, exception) : output(env, result, array);
}

extern "C" napi_status napi_create_double(napi_env opaque_env, double value, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    return env ? output(env, result, JSValueMakeNumber(env->context, value)) : napi_invalid_arg;
}

extern "C" napi_status napi_create_int32(napi_env env, int32_t value, napi_value* result)
{
    return napi_create_double(env, value, result);
}

extern "C" napi_status napi_create_uint32(napi_env env, uint32_t value, napi_value* result)
{
    return napi_create_double(env, value, result);
}

extern "C" napi_status napi_create_int64(napi_env env, int64_t value, napi_value* result)
{
    return napi_create_double(env, static_cast<double>(value), result);
}

extern "C" napi_status napi_create_string_utf8(napi_env opaque_env, const char* value, size_t length, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result || (!value && length != 0))
        return invalid(env);
    if (length != NAPI_AUTO_LENGTH && length > static_cast<size_t>(std::numeric_limits<int32_t>::max()))
        return invalid(env);
    JSStringRef string = length == 0 ? JSStringCreateWithUTF8CString("") : make_utf8_string(value, length);
    if (!string)
        return finish(env, napi_generic_failure);
    napi_status status = output(env, result, JSValueMakeString(env->context, string));
    JSStringRelease(string);
    return status;
}

extern "C" napi_status napi_create_string_latin1(napi_env opaque_env, const char* value, size_t length, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result || (!value && length != 0))
        return invalid(env);
    if (length != NAPI_AUTO_LENGTH && length > static_cast<size_t>(std::numeric_limits<int32_t>::max()))
        return invalid(env);
    JSStringRef string = length == 0 ? JSStringCreateWithUTF8CString("") : make_latin1_string(value, length);
    if (!string)
        return finish(env, napi_generic_failure);
    napi_status status = output(env, result, JSValueMakeString(env->context, string));
    JSStringRelease(string);
    return status;
}

extern "C" napi_status napi_create_string_utf16(napi_env opaque_env, const char16_t* value, size_t length, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result || (!value && length != 0))
        return invalid(env);
    if (length != NAPI_AUTO_LENGTH && length > static_cast<size_t>(std::numeric_limits<int32_t>::max()))
        return invalid(env);
    if (length == NAPI_AUTO_LENGTH) {
        length = 0;
        while (value[length])
            ++length;
    }
    static_assert(sizeof(char16_t) == sizeof(JSChar));
    JSStringRef string = length == 0
        ? JSStringCreateWithUTF8CString("")
        : JSStringCreateWithCharacters(reinterpret_cast<const JSChar*>(value), length);
    napi_status status = output(env, result, JSValueMakeString(env->context, string));
    JSStringRelease(string);
    return status;
}

extern "C" napi_status napi_create_symbol(napi_env opaque_env, napi_value description, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !result)
        return invalid(env);
    JSStringRef string = nullptr;
    JSValueRef exception = nullptr;
    if (description) {
        if (!JSValueIsString(env->context, to_js(description)))
            return finish(env, napi_string_expected);
        string = JSValueToStringCopy(env->context, to_js(description), &exception);
    }
    if (exception)
        return caught(env, exception);
    JSValueRef symbol = JSValueMakeSymbol(env->context, string);
    if (string)
        JSStringRelease(string);
    return output(env, result, symbol);
}

extern "C" napi_status node_api_symbol_for(napi_env opaque_env, const char* description, size_t length, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !result || (!description && length != 0))
        return invalid(env);
    JSValueRef exception = nullptr;
    JSObjectRef symbol_constructor = global_constructor(env, "Symbol", &exception);
    if (exception || !symbol_constructor)
        return exception ? caught(env, exception) : finish(env, napi_generic_failure);
    JSValueRef argument = nullptr;
    napi_value temporary = nullptr;
    napi_status status = napi_create_string_utf8(opaque_env, description ? description : "", length, &temporary);
    if (status != napi_ok)
        return status;
    argument = to_js(temporary);
    JSValueRef symbol = call_method(env, symbol_constructor, "for", 1, &argument, &exception);
    return exception ? caught(env, exception) : output(env, result, symbol);
}

extern "C" napi_status napi_typeof(napi_env opaque_env, napi_value value, napi_valuetype* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef js_value = to_js(value);
    if (JSValueIsUndefined(env->context, js_value))
        *result = napi_undefined;
    else if (JSValueIsNull(env->context, js_value))
        *result = napi_null;
    else if (JSValueIsBoolean(env->context, js_value))
        *result = napi_boolean;
    else if (JSValueIsNumber(env->context, js_value))
        *result = napi_number;
    else if (JSValueIsString(env->context, js_value))
        *result = napi_string;
    else if (JSValueIsSymbol(env->context, js_value))
        *result = napi_symbol;
    else if (JSValueIsBigInt(env->context, js_value))
        *result = napi_bigint;
    else if (JSValueIsObjectOfClass(env->context, js_value, external_class))
        *result = napi_external;
    else if (JSValueIsObject(env->context, js_value) && JSObjectIsFunction(env->context, as_object(env, value)))
        *result = napi_function;
    else
        *result = napi_object;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_value_double(napi_env opaque_env, napi_value value, double* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value || !result)
        return invalid(env);
    if (!JSValueIsNumber(env->context, to_js(value)))
        return finish(env, napi_number_expected);
    JSValueRef exception = nullptr;
    *result = JSValueToNumber(env->context, to_js(value), &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_get_value_int32(napi_env opaque_env, napi_value value, int32_t* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value || !result)
        return invalid(env);
    if (!JSValueIsNumber(env->context, to_js(value)))
        return finish(env, napi_number_expected);
    JSValueRef exception = nullptr;
    *result = JSValueToInt32(env->context, to_js(value), &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_get_value_uint32(napi_env opaque_env, napi_value value, uint32_t* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value || !result)
        return invalid(env);
    if (!JSValueIsNumber(env->context, to_js(value)))
        return finish(env, napi_number_expected);
    JSValueRef exception = nullptr;
    *result = JSValueToUInt32(env->context, to_js(value), &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_get_value_int64(napi_env opaque_env, napi_value value, int64_t* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value || !result)
        return invalid(env);
    double number = 0;
    napi_status status = napi_get_value_double(opaque_env, value, &number);
    if (status != napi_ok)
        return status;
    if (!std::isfinite(number)) {
        *result = 0;
    } else if (number >= 0x1p63) {
        *result = std::numeric_limits<int64_t>::max();
    } else if (number <= -0x1p63) {
        *result = std::numeric_limits<int64_t>::min();
    } else {
        *result = static_cast<int64_t>(number);
    }
    return status;
}

extern "C" napi_status napi_get_value_bool(napi_env opaque_env, napi_value value, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value || !result)
        return invalid(env);
    if (!JSValueIsBoolean(env->context, to_js(value)))
        return finish(env, napi_boolean_expected);
    *result = JSValueToBoolean(env->context, to_js(value));
    return finish(env, napi_ok);
}

static napi_status get_string(NapiEnv* env, napi_value value, JSStringRef* result)
{
    if (!env || !value || !result)
        return invalid(env);
    if (!JSValueIsString(env->context, to_js(value)))
        return finish(env, napi_string_expected);
    JSValueRef exception = nullptr;
    *result = JSValueToStringCopy(env->context, to_js(value), &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

static size_t utf8_prefix_length(const char* bytes, size_t length, size_t capacity)
{
    const size_t limit = std::min(length, capacity);
    size_t offset = 0;
    while (offset < limit) {
        const uint8_t lead = static_cast<uint8_t>(bytes[offset]);
        const size_t sequence_length = lead < 0x80 ? 1
            : (lead & 0xe0) == 0xc0 ? 2
            : (lead & 0xf0) == 0xe0 ? 3
            : (lead & 0xf8) == 0xf0 ? 4
            : 1;
        if (offset + sequence_length > limit)
            break;
        offset += sequence_length;
    }
    return offset;
}

extern "C" napi_status napi_get_value_string_utf8(napi_env opaque_env, napi_value value, char* buffer, size_t buffer_size, size_t* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value)
        return invalid(env);
    JSStringRef string = nullptr;
    napi_status status = get_string(env, value, &string);
    if (status != napi_ok)
        return status;
    if (!buffer && !result) {
        JSStringRelease(string);
        return invalid(env);
    }
    size_t capacity = JSStringGetMaximumUTF8CStringSize(string);
    std::vector<char> complete(capacity ? capacity : 1);
    size_t bytes_with_null = JSStringGetUTF8CString(string, complete.data(), complete.size());
    JSStringRelease(string);
    size_t bytes = bytes_with_null ? bytes_with_null - 1 : 0;
    const size_t copied = buffer
        ? utf8_prefix_length(complete.data(), bytes, buffer_size ? buffer_size - 1 : 0)
        : bytes;
    if (result)
        *result = copied;
    if (buffer && buffer_size) {
        std::memcpy(buffer, complete.data(), copied);
        buffer[copied] = '\0';
    }
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_value_string_utf16(napi_env opaque_env, napi_value value, char16_t* buffer, size_t buffer_size, size_t* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value)
        return invalid(env);
    JSStringRef string = nullptr;
    napi_status status = get_string(env, value, &string);
    if (status != napi_ok)
        return status;
    if (!buffer && !result) {
        JSStringRelease(string);
        return invalid(env);
    }
    size_t length = JSStringGetLength(string);
    size_t copied = buffer ? std::min(length, buffer_size ? buffer_size - 1 : 0) : length;
    if (buffer && buffer_size) {
        const JSChar* characters = JSStringGetCharactersPtr(string);
        std::memcpy(buffer, characters, copied * sizeof(char16_t));
        buffer[copied] = 0;
    }
    if (result)
        *result = copied;
    JSStringRelease(string);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_value_string_latin1(napi_env opaque_env, napi_value value, char* buffer, size_t buffer_size, size_t* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value)
        return invalid(env);
    JSStringRef string = nullptr;
    napi_status status = get_string(env, value, &string);
    if (status != napi_ok)
        return status;
    if (!buffer && !result) {
        JSStringRelease(string);
        return invalid(env);
    }
    size_t length = JSStringGetLength(string);
    size_t copied = buffer ? std::min(length, buffer_size ? buffer_size - 1 : 0) : length;
    if (buffer && buffer_size) {
        const JSChar* characters = JSStringGetCharactersPtr(string);
        for (size_t index = 0; index < copied; ++index)
            buffer[index] = static_cast<char>(characters[index] & 0xff);
        buffer[copied] = '\0';
    }
    if (result)
        *result = copied;
    JSStringRelease(string);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_coerce_to_bool(napi_env opaque_env, napi_value value, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result)
        return invalid(env);
    return output(env, result, JSValueMakeBoolean(env->context, JSValueToBoolean(env->context, to_js(value))));
}

extern "C" napi_status napi_coerce_to_number(napi_env opaque_env, napi_value value, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    double number = JSValueToNumber(env->context, to_js(value), &exception);
    return exception ? caught(env, exception) : output(env, result, JSValueMakeNumber(env->context, number));
}

extern "C" napi_status napi_coerce_to_string(napi_env opaque_env, napi_value value, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    napi_status status = ensure_can_run_js(env);
    if (status != napi_ok)
        return status;
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    JSStringRef string = JSValueToStringCopy(env->context, to_js(value), &exception);
    if (exception)
        return caught(env, exception);
    status = output(env, result, JSValueMakeString(env->context, string));
    JSStringRelease(string);
    return status;
}

extern "C" napi_status napi_coerce_to_object(napi_env opaque_env, napi_value value, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    JSObjectRef object = JSValueToObject(env->context, to_js(value), &exception);
    return exception ? caught(env, exception) : output(env, result, object);
}

extern "C" napi_status napi_get_prototype(napi_env opaque_env, napi_value object, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef target = nullptr;
    napi_status status = require_object(env, object, &target);
    if (status != napi_ok || !result)
        return status != napi_ok ? status : invalid(env);
    return output(env, result, JSObjectGetPrototype(env->context, target));
}

extern "C" napi_status napi_set_property(napi_env opaque_env, napi_value object, napi_value key, napi_value value)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef target = nullptr;
    napi_status status = require_property_target(env, object, &target);
    if (status != napi_ok || !key || !value)
        return status != napi_ok ? status : invalid(env);
    JSValueRef exception = nullptr;
    JSObjectSetPropertyForKey(env->context, target, to_js(key), to_js(value), kJSPropertyAttributeNone, &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_has_property(napi_env opaque_env, napi_value object, napi_value key, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef target = nullptr;
    napi_status status = require_property_target(env, object, &target);
    if (status != napi_ok || !key || !result)
        return status != napi_ok ? status : invalid(env);
    JSValueRef exception = nullptr;
    *result = JSObjectHasPropertyForKey(env->context, target, to_js(key), &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_get_property(napi_env opaque_env, napi_value object, napi_value key, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef target = nullptr;
    napi_status status = require_property_target(env, object, &target);
    if (status != napi_ok || !key || !result)
        return status != napi_ok ? status : invalid(env);
    JSValueRef exception = nullptr;
    JSValueRef value = JSObjectGetPropertyForKey(env->context, target, to_js(key), &exception);
    return exception ? caught(env, exception) : output(env, result, value);
}

extern "C" napi_status napi_delete_property(napi_env opaque_env, napi_value object, napi_value key, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    napi_status status = ensure_can_run_js(env);
    if (status != napi_ok)
        return status;
    JSObjectRef target = nullptr;
    status = require_property_target(env, object, &target);
    if (status != napi_ok || !key)
        return status != napi_ok ? status : invalid(env);
    JSValueRef exception = nullptr;
    bool deleted = JSObjectDeletePropertyForKey(env->context, target, to_js(key), &exception);
    if (result)
        *result = deleted;
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_has_own_property(napi_env opaque_env, napi_value object, napi_value key, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    napi_status status = ensure_can_run_js(env);
    if (status != napi_ok)
        return status;
    JSObjectRef target = nullptr;
    status = require_property_target(env, object, &target);
    if (status != napi_ok || !key || !result)
        return status != napi_ok ? status : invalid(env);
    if (!JSValueIsString(env->context, to_js(key)) && !JSValueIsSymbol(env->context, to_js(key)))
        return finish(env, napi_name_expected);
    JSValueRef exception = nullptr;
    JSObjectRef object_constructor = global_constructor(env, "Object", &exception);
    JSValueRef prototype_value = exception ? nullptr : get_property(env, object_constructor, "prototype", &exception);
    JSObjectRef prototype = prototype_value && JSValueIsObject(env->context, prototype_value) ? const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(prototype_value)) : nullptr;
    JSValueRef argument = to_js(key);
    JSValueRef value = nullptr;
    if (!exception && prototype) {
        JSValueRef method_value = get_property(env, prototype, "hasOwnProperty", &exception);
        if (!exception && method_value && JSValueIsObject(env->context, method_value)) {
            auto method = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(method_value));
            value = JSObjectCallAsFunction(env->context, method, target, 1, &argument, &exception);
        }
    }
    if (exception)
        return caught(env, exception);
    *result = value && JSValueToBoolean(env->context, value);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_set_named_property(napi_env opaque_env, napi_value object, const char* name, napi_value value)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    napi_status status = ensure_can_run_js(env);
    if (status != napi_ok)
        return status;
    JSObjectRef target = nullptr;
    status = require_property_target(env, object, &target);
    if (status != napi_ok || !name || !value)
        return status != napi_ok ? status : invalid(env);
    JSValueRef exception = nullptr;
    set_property(env, target, name, to_js(value), kJSPropertyAttributeNone, &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_has_named_property(napi_env opaque_env, napi_value object, const char* name, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef target = nullptr;
    napi_status status = require_property_target(env, object, &target);
    if (status != napi_ok || !name || !result)
        return status != napi_ok ? status : invalid(env);
    JSStringRef key_string = property_name(name);
    JSValueRef key = JSValueMakeString(env->context, key_string);
    JSValueRef exception = nullptr;
    *result = JSObjectHasPropertyForKey(env->context, target, key, &exception);
    JSStringRelease(key_string);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_get_named_property(napi_env opaque_env, napi_value object, const char* name, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    napi_status status = ensure_can_run_js(env);
    if (status != napi_ok)
        return status;
    JSObjectRef target = nullptr;
    status = require_property_target(env, object, &target);
    if (status != napi_ok || !name || !result)
        return status != napi_ok ? status : invalid(env);
    JSValueRef exception = nullptr;
    JSValueRef value = get_property(env, target, name, &exception);
    return exception ? caught(env, exception) : output(env, result, value);
}

extern "C" napi_status napi_set_element(napi_env opaque_env, napi_value object, uint32_t index, napi_value value)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    napi_status status = ensure_can_run_js(env);
    if (status != napi_ok)
        return status;
    JSObjectRef target = nullptr;
    status = require_property_target(env, object, &target);
    if (status != napi_ok || !value)
        return status != napi_ok ? status : invalid(env);
    JSValueRef exception = nullptr;
    JSObjectSetPropertyAtIndex(env->context, target, index, to_js(value), &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_has_element(napi_env opaque_env, napi_value object, uint32_t index, bool* result)
{
    char key[32];
    std::snprintf(key, sizeof(key), "%u", index);
    return napi_has_named_property(opaque_env, object, key, result);
}

extern "C" napi_status napi_get_element(napi_env opaque_env, napi_value object, uint32_t index, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef target = nullptr;
    napi_status status = require_property_target(env, object, &target);
    if (status != napi_ok || !result)
        return status != napi_ok ? status : invalid(env);
    JSValueRef exception = nullptr;
    JSValueRef value = JSObjectGetPropertyAtIndex(env->context, target, index, &exception);
    return exception ? caught(env, exception) : output(env, result, value);
}

extern "C" napi_status napi_delete_element(napi_env opaque_env, napi_value object, uint32_t index, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env)
        return napi_invalid_arg;
    char key[32];
    std::snprintf(key, sizeof(key), "%u", index);
    napi_value key_value = nullptr;
    napi_status status = napi_create_string_utf8(opaque_env, key, NAPI_AUTO_LENGTH, &key_value);
    return status == napi_ok ? napi_delete_property(opaque_env, object, key_value, result) : status;
}

extern "C" napi_status napi_get_property_names(napi_env opaque_env, napi_value object, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    napi_status status = ensure_can_run_js(env);
    if (status != napi_ok)
        return status;
    return napi_get_all_property_names(
        opaque_env,
        object,
        napi_key_include_prototypes,
        static_cast<napi_key_filter>(napi_key_enumerable | napi_key_skip_symbols),
        napi_key_numbers_to_strings,
        result
    );
}

extern "C" napi_status napi_is_array(napi_env opaque_env, napi_value value, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result)
        return invalid(env);
    *result = JSValueIsArray(env->context, to_js(value));
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_array_length(napi_env opaque_env, napi_value value, uint32_t* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result)
        return invalid(env);
    if (!JSValueIsArray(env->context, to_js(value)))
        return finish(env, napi_array_expected);
    JSValueRef exception = nullptr;
    JSValueRef length = get_property(env, as_object(env, value), "length", &exception);
    if (exception)
        return caught(env, exception);
    *result = static_cast<uint32_t>(JSValueToNumber(env->context, length, &exception));
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_strict_equals(napi_env opaque_env, napi_value left, napi_value right, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !left || !right || !result)
        return invalid(env);
    *result = JSValueIsStrictEqual(env->context, to_js(left), to_js(right));
    return finish(env, napi_ok);
}

extern "C" napi_status napi_create_function(
    napi_env opaque_env,
    const char* name,
    size_t length,
    napi_callback callback,
    void* data,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    napi_status status = ensure_can_run_js(env);
    if (status != napi_ok)
        return status;
    if (!env || !callback)
        return invalid(env);
    JSValueRef exception = nullptr;
    JSObjectRef function = make_napi_function(env, name, name ? length : 0, callback, data, false, &exception);
    if (exception)
        return caught(env, exception);
    return function ? output(env, result, function) : finish(env, napi_generic_failure);
}

extern "C" napi_status napi_call_function(
    napi_env opaque_env,
    napi_value receiver,
    napi_value function,
    size_t argc,
    const napi_value* argv,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    napi_status status = ensure_can_run_js(env);
    if (status != napi_ok)
        return status;
    if (!env || !receiver || !function || (argc && !argv))
        return invalid(env);
    JSObjectRef callable = as_object(env, function);
    if (!callable || !JSObjectIsFunction(env->context, callable))
        return finish(env, napi_function_expected);
    JSValueRef exception = nullptr;
    JSObjectRef function_call = cached_function_call(env, &exception);
    constexpr size_t inline_capacity = 8;
    JSValueRef inline_arguments[inline_capacity + 1];
    std::vector<JSValueRef> heap_arguments;
    JSValueRef* arguments = inline_arguments;
    if (argc > inline_capacity) {
        heap_arguments.resize(argc + 1);
        arguments = heap_arguments.data();
    }
    arguments[0] = to_js(receiver);
    for (size_t index = 0; index < argc; ++index)
        arguments[index + 1] = to_js(argv[index]);
    JSValueRef returned = exception || !function_call
        ? nullptr
        : JSObjectCallAsFunction(env->context, function_call, callable, argc + 1, arguments, &exception);
    if (exception)
        return caught(env, exception);
    if (process_is_exiting(env, &exception))
        return finish(env, napi_pending_exception);
    if (exception)
        return caught(env, exception);
    if (result)
        return output(env, result, returned);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_new_instance(
    napi_env opaque_env,
    napi_value constructor,
    size_t argc,
    const napi_value* argv,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !constructor || !result || (argc && !argv))
        return invalid(env);
    JSObjectRef callable = as_object(env, constructor);
    if (!callable || !JSObjectIsConstructor(env->context, callable))
        return finish(env, napi_function_expected);
    std::vector<JSValueRef> arguments(argc);
    for (size_t index = 0; index < argc; ++index)
        arguments[index] = to_js(argv[index]);
    JSValueRef exception = nullptr;
    JSObjectRef instance = JSObjectCallAsConstructor(env->context, callable, argc, arguments.data(), &exception);
    return exception ? caught(env, exception) : output(env, result, instance);
}

extern "C" napi_status napi_instanceof(napi_env opaque_env, napi_value object, napi_value constructor, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !object || !constructor || !result)
        return invalid(env);
    JSObjectRef callable = as_object(env, constructor);
    if (!callable || !JSObjectIsConstructor(env->context, callable)) {
        napi_status status = napi_throw_type_error(opaque_env, nullptr, "Constructor must be a function");
        return status == napi_ok ? finish(env, napi_pending_exception) : status;
    }
    JSValueRef exception = nullptr;
    *result = JSValueIsInstanceOfConstructor(env->context, to_js(object), callable, &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_get_cb_info(
    napi_env opaque_env,
    napi_callback_info opaque_info,
    size_t* argc,
    napi_value* argv,
    napi_value* this_argument,
    void** data
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    auto* info = reinterpret_cast<napi_callback_info__*>(opaque_info);
    if (!env || !info || info->env != env)
        return invalid(env);
    if (argv && !argc)
        return invalid(env);
    if (argc) {
        size_t capacity = *argc;
        if (argv) {
            size_t copied = std::min(capacity, info->argc);
            for (size_t index = 0; index < copied; ++index)
                argv[index] = to_napi(info->argv[index]);
            for (size_t index = copied; index < capacity; ++index)
                argv[index] = to_napi(JSValueMakeUndefined(env->context));
        }
        *argc = info->argc;
    }
    if (this_argument)
        *this_argument = to_napi(info->this_value ? info->this_value : JSContextGetGlobalObject(env->context));
    if (data)
        *data = info->data;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_new_target(napi_env opaque_env, napi_callback_info opaque_info, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    auto* info = reinterpret_cast<napi_callback_info__*>(opaque_info);
    if (!env || !info || info->env != env || !result)
        return invalid(env);
    *result = info->new_target ? to_napi(info->new_target) : nullptr;
    if (info->new_target)
        track(env, info->new_target);
    return finish(env, napi_ok);
}

static napi_status define_one_property(
    NapiEnv* env,
    JSObjectRef target,
    const napi_property_descriptor& property,
    bool class_property
)
{
    if (!property.utf8name && !property.name)
        return invalid(env);
    JSValueRef exception = nullptr;
    JSValueRef key = nullptr;
    JSStringRef key_string = nullptr;
    if (property.utf8name) {
        key_string = make_utf8_string(property.utf8name, NAPI_AUTO_LENGTH);
        key = JSValueMakeString(env->context, key_string);
    } else {
        key = to_js(property.name);
    }

    JSObjectRef descriptor = JSObjectMake(env->context, nullptr, nullptr);
    const auto attributes = static_cast<unsigned>(property.attributes);
    set_property(env, descriptor, "enumerable", JSValueMakeBoolean(env->context, attributes & napi_enumerable), kJSPropertyAttributeNone, &exception);
    set_property(env, descriptor, "configurable", JSValueMakeBoolean(env->context, attributes & napi_configurable), kJSPropertyAttributeNone, &exception);

    if (!exception && property.method) {
        const char* function_name = property.utf8name ? property.utf8name : nullptr;
        JSObjectRef function = make_napi_function(env, function_name, function_name ? NAPI_AUTO_LENGTH : 0, property.method, property.data, false, &exception);
        if (function) {
            set_property(env, descriptor, "value", function, kJSPropertyAttributeNone, &exception);
            set_property(env, descriptor, "writable", JSValueMakeBoolean(env->context, attributes & napi_writable), kJSPropertyAttributeNone, &exception);
        }
    } else if (!exception && (property.getter || property.setter)) {
        if (property.getter) {
            JSObjectRef getter = make_napi_function(env, property.utf8name, property.utf8name ? NAPI_AUTO_LENGTH : 0, property.getter, property.data, false, &exception);
            if (getter)
                set_property(env, descriptor, "get", getter, kJSPropertyAttributeNone, &exception);
        }
        if (!exception && property.setter) {
            JSObjectRef setter = make_napi_function(env, property.utf8name, property.utf8name ? NAPI_AUTO_LENGTH : 0, property.setter, property.data, false, &exception);
            if (setter)
                set_property(env, descriptor, "set", setter, kJSPropertyAttributeNone, &exception);
        }
    } else if (!exception) {
        JSValueRef value = property.value ? to_js(property.value) : JSValueMakeUndefined(env->context);
        set_property(env, descriptor, "value", value, kJSPropertyAttributeNone, &exception);
        set_property(env, descriptor, "writable", JSValueMakeBoolean(env->context, attributes & napi_writable), kJSPropertyAttributeNone, &exception);
    }

    JSObjectRef object_constructor = exception ? nullptr : global_constructor(env, "Object", &exception);
    if (!exception && object_constructor) {
        JSValueRef arguments[] = { target, key, descriptor };
        JSValueRef define_property_value = get_property(env, object_constructor, "defineProperty", &exception);
        if (!exception && define_property_value && JSValueIsObject(env->context, define_property_value)) {
            JSObjectRef define_property = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(define_property_value));
            JSObjectCallAsFunction(env->context, define_property, object_constructor, 3, arguments, &exception);
        }
    }
    if (key_string)
        JSStringRelease(key_string);
    (void)class_property;
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_define_properties(
    napi_env opaque_env,
    napi_value object,
    size_t property_count,
    const napi_property_descriptor* properties
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    napi_status status = ensure_can_run_js(env);
    if (status != napi_ok)
        return status;
    JSObjectRef target = nullptr;
    status = require_object(env, object, &target);
    if (status != napi_ok || (property_count && !properties))
        return status != napi_ok ? status : invalid(env);
    for (size_t index = 0; index < property_count; ++index) {
        status = define_one_property(env, target, properties[index], false);
        if (status != napi_ok)
            return status;
    }
    return finish(env, napi_ok);
}

extern "C" napi_status napi_define_class(
    napi_env opaque_env,
    const char* name,
    size_t length,
    napi_callback callback,
    void* data,
    size_t property_count,
    const napi_property_descriptor* properties,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !name || !callback || !result || (property_count && !properties))
        return invalid(env);
    JSValueRef exception = nullptr;
    JSObjectRef constructor = make_napi_function(env, name, length, callback, data, true, &exception);
    if (exception || !constructor)
        return exception ? caught(env, exception) : finish(env, napi_generic_failure);
    JSObjectRef prototype = JSObjectMake(env->context, nullptr, nullptr);
    set_property(env, prototype, "constructor", constructor, kJSPropertyAttributeDontEnum, &exception);
    set_property(env, constructor, "prototype", prototype, kJSPropertyAttributeDontEnum | kJSPropertyAttributeDontDelete, &exception);
    if (exception)
        return caught(env, exception);

    for (size_t index = 0; index < property_count; ++index) {
        JSObjectRef target = (properties[index].attributes & napi_static) ? constructor : prototype;
        napi_status status = define_one_property(env, target, properties[index], true);
        if (status != napi_ok)
            return status;
    }
    return output(env, result, constructor);
}

static napi_status create_error(
    napi_env opaque_env,
    const char* constructor,
    napi_value code,
    napi_value message,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !message || !result)
        return invalid(env);
    if (!JSValueIsString(env->context, to_js(message)) || (code && !JSValueIsString(env->context, to_js(code))))
        return finish(env, napi_string_expected);
    JSValueRef exception = nullptr;
    JSObjectRef error = create_error_object(env, constructor, code, message, &exception);
    return exception ? caught(env, exception) : output(env, result, error);
}

extern "C" napi_status napi_create_error(napi_env env, napi_value code, napi_value message, napi_value* result)
{
    return create_error(env, "Error", code, message, result);
}

extern "C" napi_status napi_create_type_error(napi_env env, napi_value code, napi_value message, napi_value* result)
{
    return create_error(env, "TypeError", code, message, result);
}

extern "C" napi_status napi_create_range_error(napi_env env, napi_value code, napi_value message, napi_value* result)
{
    return create_error(env, "RangeError", code, message, result);
}

extern "C" napi_status node_api_create_syntax_error(napi_env env, napi_value code, napi_value message, napi_value* result)
{
    return create_error(env, "SyntaxError", code, message, result);
}

extern "C" napi_status napi_throw(napi_env opaque_env, napi_value error)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    napi_status status = ensure_can_run_js(env);
    if (status != napi_ok)
        return status;
    if (!env || !error)
        return invalid(env);
    protect_pending(env, to_js(error));
    return finish(env, napi_ok);
}

static napi_status throw_error_string(napi_env opaque_env, const char* constructor, const char* code, const char* message)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !message)
        return invalid(env);
    napi_value code_value = nullptr;
    napi_value message_value = nullptr;
    napi_value error = nullptr;
    if (code && napi_create_string_utf8(opaque_env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok)
        return env->last_error.error_code;
    if (napi_create_string_utf8(opaque_env, message, NAPI_AUTO_LENGTH, &message_value) != napi_ok)
        return env->last_error.error_code;
    napi_status status = create_error(opaque_env, constructor, code_value, message_value, &error);
    return status == napi_ok ? napi_throw(opaque_env, error) : status;
}

extern "C" napi_status napi_throw_error(napi_env env, const char* code, const char* message)
{
    return throw_error_string(env, "Error", code, message);
}

extern "C" napi_status napi_throw_type_error(napi_env env, const char* code, const char* message)
{
    return throw_error_string(env, "TypeError", code, message);
}

extern "C" napi_status napi_throw_range_error(napi_env env, const char* code, const char* message)
{
    return throw_error_string(env, "RangeError", code, message);
}

extern "C" napi_status node_api_throw_syntax_error(napi_env env, const char* code, const char* message)
{
    return throw_error_string(env, "SyntaxError", code, message);
}

extern "C" napi_status napi_is_error(napi_env opaque_env, napi_value value, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    *result = is_instance_of_global(env, value, "Error", &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_is_exception_pending(napi_env opaque_env, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !result)
        return invalid(env);
    *result = env->pending_exception != nullptr;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_and_clear_last_exception(napi_env opaque_env, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !result)
        return invalid(env);
    JSValueRef value = env->pending_exception ? env->pending_exception : JSValueMakeUndefined(env->context);
    track(env, value);
    *result = to_napi(value);
    if (env->pending_exception) {
        JSValueUnprotect(env->context, env->pending_exception);
        env->pending_exception = nullptr;
    }
    return finish(env, napi_ok);
}

static bool handle_uncaught_exception(NapiEnv* env, JSValueRef error, JSValueRef* exception)
{
    JSObjectRef global = JSContextGetGlobalObject(env->context);
    JSValueRef handler_value = get_property(env, global, "__cottontailHandleUncaughtException", exception);
    if (*exception || !handler_value || !JSValueIsObject(env->context, handler_value))
        return false;
    JSObjectRef handler = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(handler_value));
    if (!JSObjectIsFunction(env->context, handler))
        return false;
    JSValueRef handled = JSObjectCallAsFunction(env->context, handler, global, 1, &error, exception);
    return !*exception && handled && JSValueToBoolean(env->context, handled);
}

extern "C" napi_status napi_fatal_exception(napi_env opaque_env, napi_value error)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !error)
        return invalid(env);

    JSValueRef exception = nullptr;
    if (!is_instance_of_global(env, error, "Error", &exception))
        return exception ? caught(env, exception) : finish(env, napi_invalid_arg);

    if (handle_uncaught_exception(env, to_js(error), &exception))
        return finish(env, napi_ok);
    if (exception) {
        protect_pending(env, exception);
        return finish(env, napi_ok);
    }

    protect_pending(env, to_js(error));
    return finish(env, napi_ok);
}

extern "C" void napi_fatal_error(const char* location, size_t location_length, const char* message, size_t message_length)
{
    std::fputs("FATAL ERROR: ", stderr);
    if (location) {
        if (location_length == NAPI_AUTO_LENGTH)
            location_length = std::strlen(location);
        std::fwrite(location, 1, location_length, stderr);
        std::fputc(' ', stderr);
    }
    if (message) {
        if (message_length == NAPI_AUTO_LENGTH)
            message_length = std::strlen(message);
        std::fwrite(message, 1, message_length, stderr);
    }
    std::fputc('\n', stderr);
    std::fflush(stderr);
    std::abort();
}

extern "C" napi_status napi_open_handle_scope(napi_env opaque_env, napi_handle_scope* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    auto* scope = new (std::nothrow) napi_handle_scope__;
    if (!scope)
        return finish(env, napi_generic_failure);
    scope_open(env, scope, false);
    *result = reinterpret_cast<napi_handle_scope>(scope);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_close_handle_scope(napi_env opaque_env, napi_handle_scope opaque_scope)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    auto* scope = reinterpret_cast<napi_handle_scope__*>(opaque_scope);
    napi_status status = scope_close(env, scope);
    if (status == napi_ok)
        delete scope;
    return status;
}

extern "C" napi_status napi_open_escapable_handle_scope(napi_env opaque_env, napi_escapable_handle_scope* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    auto* scope = new (std::nothrow) napi_handle_scope__;
    if (!scope)
        return finish(env, napi_generic_failure);
    scope_open(env, scope, true);
    *result = reinterpret_cast<napi_escapable_handle_scope>(scope);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_close_escapable_handle_scope(napi_env opaque_env, napi_escapable_handle_scope opaque_scope)
{
    return napi_close_handle_scope(opaque_env, reinterpret_cast<napi_handle_scope>(opaque_scope));
}

extern "C" napi_status napi_escape_handle(
    napi_env opaque_env,
    napi_escapable_handle_scope opaque_scope,
    napi_value escapee,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    auto* scope = reinterpret_cast<napi_handle_scope__*>(opaque_scope);
    if (!env || !scope || scope->env != env || !scope->escapable || scope->closed || !escapee || !result)
        return invalid(env);
    if (scope->escaped)
        return finish(env, napi_escape_called_twice);
    scope->escaped = true;
    if (scope->parent) {
        JSValueProtect(env->context, to_js(escapee));
        scope->parent->values.push_back(to_js(escapee));
    }
    *result = escapee;
    return finish(env, napi_ok);
}

static NapiFinalizerData* create_finalizer(
    NapiEnv* env,
    void* data,
    napi_finalize callback,
    void* hint,
    bool external,
    bool basic
)
{
    auto* finalizer = new (std::nothrow) NapiFinalizerData { env, data, hint, callback, true, external, basic };
    if (finalizer)
        env->finalizers.insert(finalizer);
    return finalizer;
}

extern "C" napi_status napi_create_external(
    napi_env opaque_env,
    void* data,
    napi_finalize finalize_callback,
    void* finalize_hint,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    std::call_once(classes_once, initialize_classes);
    auto* finalizer = create_finalizer(env, data, finalize_callback, finalize_hint, true, false);
    if (!finalizer)
        return finish(env, napi_generic_failure);
    JSObjectRef external = JSObjectMake(env->context, external_class, finalizer);
    return output(env, result, external);
}

extern "C" napi_status napi_get_value_external(napi_env opaque_env, napi_value value, void** result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value || !result)
        return invalid(env);
    if (!JSValueIsObjectOfClass(env->context, to_js(value), external_class))
        return finish(env, napi_invalid_arg);
    auto* finalizer = static_cast<NapiFinalizerData*>(JSObjectGetPrivate(as_object(env, value)));
    if (!finalizer)
        return finish(env, napi_invalid_arg);
    *result = finalizer->data;
    return finish(env, napi_ok);
}

static NapiFinalizerData* property_finalizer(NapiEnv* env, JSObjectRef object, const char* key, JSValueRef* exception)
{
    JSValueRef holder_value = get_property(env, object, key, exception);
    if (*exception || !holder_value || !JSValueIsObjectOfClass(env->context, holder_value, finalizer_class))
        return nullptr;
    return static_cast<NapiFinalizerData*>(JSObjectGetPrivate(const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(holder_value))));
}

static napi_status attach_finalizer(
    NapiEnv* env,
    JSObjectRef object,
    const char* key,
    void* data,
    napi_finalize callback,
    void* hint,
    bool basic
)
{
    std::call_once(classes_once, initialize_classes);
    JSValueRef exception = nullptr;
    if (property_finalizer(env, object, key, &exception))
        return finish(env, napi_invalid_arg);
    if (exception)
        return caught(env, exception);
    auto* finalizer = create_finalizer(env, data, callback, hint, false, basic);
    if (!finalizer)
        return finish(env, napi_generic_failure);
    JSObjectRef holder = JSObjectMake(env->context, finalizer_class, finalizer);
    set_property(env, object, key, holder, kJSPropertyAttributeDontEnum, &exception);
    if (exception) {
        env->finalizers.erase(finalizer);
        finalizer->active = false;
        finalizer->env = nullptr;
        return caught(env, exception);
    }
    return finish(env, napi_ok);
}

static JSObjectRef ensure_wrap_map(NapiEnv* env, JSValueRef* exception)
{
    NapiEnv* root = root_env(env);
    if (root->wrap_map)
        return root->wrap_map;
    JSObjectRef constructor = global_constructor(root, "WeakMap", exception);
    if (*exception || !constructor)
        return nullptr;
    JSObjectRef map = JSObjectCallAsConstructor(root->context, constructor, 0, nullptr, exception);
    if (*exception || !map)
        return nullptr;
    root->wrap_map = map;
    JSValueProtect(root->context, map);
    return map;
}

static NapiFinalizerData* wrapped_finalizer(NapiEnv* env, JSObjectRef object, JSValueRef* exception)
{
    JSObjectRef map = ensure_wrap_map(env, exception);
    if (*exception || !map)
        return nullptr;
    JSValueRef key = object;
    JSValueRef holder_value = call_method(env, map, "get", 1, &key, exception);
    if (*exception || !holder_value || !JSValueIsObjectOfClass(env->context, holder_value, finalizer_class))
        return nullptr;
    return static_cast<NapiFinalizerData*>(JSObjectGetPrivate(const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(holder_value))));
}

static napi_status attach_wrap_finalizer(
    NapiEnv* env,
    JSObjectRef object,
    void* data,
    napi_finalize callback,
    void* hint
)
{
    std::call_once(classes_once, initialize_classes);
    JSValueRef exception = nullptr;
    JSObjectRef map = ensure_wrap_map(env, &exception);
    if (exception)
        return caught(env, exception);
    if (!map)
        return finish(env, napi_generic_failure);
    if (wrapped_finalizer(env, object, &exception))
        return finish(env, napi_invalid_arg);
    if (exception)
        return caught(env, exception);
    auto* finalizer = create_finalizer(env, data, callback, hint, false, false);
    if (!finalizer)
        return finish(env, napi_generic_failure);
    JSObjectRef holder = JSObjectMake(env->context, finalizer_class, finalizer);
    JSValueRef arguments[] = { object, holder };
    call_method(env, map, "set", 2, arguments, &exception);
    if (exception) {
        env->finalizers.erase(finalizer);
        finalizer->active = false;
        finalizer->env = nullptr;
        return caught(env, exception);
    }
    return finish(env, napi_ok);
}

extern "C" napi_status napi_wrap(
    napi_env opaque_env,
    napi_value object,
    void* native_object,
    napi_finalize finalize_callback,
    void* finalize_hint,
    napi_ref* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef target = nullptr;
    napi_status status = require_object(env, object, &target);
    if (status != napi_ok)
        return status;
    status = attach_wrap_finalizer(env, target, native_object, finalize_callback, finalize_hint);
    if (status != napi_ok)
        return status;
    if (result) {
        status = napi_create_reference(opaque_env, object, 0, result);
        if (status != napi_ok)
            return status;
        JSValueRef exception = nullptr;
        auto* finalizer = wrapped_finalizer(env, target, &exception);
        if (exception)
            return caught(env, exception);
        if (!finalizer)
            return finish(env, napi_generic_failure);
        auto* reference = reinterpret_cast<napi_ref__*>(*result);
        finalizer->wrap_ref = reference;
        reference->owner_finalizer = finalizer;
    }
    return finish(env, napi_ok);
}

extern "C" napi_status napi_unwrap(napi_env opaque_env, napi_value object, void** result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef target = nullptr;
    napi_status status = require_object(env, object, &target);
    if (status != napi_ok || !result)
        return status != napi_ok ? status : invalid(env);
    JSValueRef exception = nullptr;
    auto* finalizer = wrapped_finalizer(env, target, &exception);
    if (exception)
        return caught(env, exception);
    if (!finalizer)
        return finish(env, napi_invalid_arg);
    *result = finalizer->data;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_remove_wrap(napi_env opaque_env, napi_value object, void** result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef target = nullptr;
    napi_status status = require_object(env, object, &target);
    if (status != napi_ok)
        return status;
    JSValueRef exception = nullptr;
    auto* finalizer = wrapped_finalizer(env, target, &exception);
    if (exception)
        return caught(env, exception);
    if (!finalizer)
        return finish(env, napi_invalid_arg);
    if (result)
        *result = finalizer->data;
    finalizer->active = false;
    if (finalizer->wrap_ref) {
        finalizer->wrap_ref->owner_finalizer = nullptr;
        finalizer->wrap_ref = nullptr;
    }
    JSObjectRef map = ensure_wrap_map(env, &exception);
    JSValueRef key = target;
    if (!exception && map)
        call_method(env, map, "delete", 1, &key, &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_add_finalizer(
    napi_env opaque_env,
    napi_value object,
    void* native_object,
    napi_finalize finalize_callback,
    void* finalize_hint,
    napi_ref* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    JSObjectRef target = nullptr;
    napi_status status = require_object(env, object, &target);
    if (status != napi_ok || !finalize_callback)
        return status != napi_ok ? status : invalid(env);
    char key[128];
    std::snprintf(key, sizeof(key), "__cottontail_napi_finalizer_%p_%llu", static_cast<void*>(env), static_cast<unsigned long long>(env->finalizer_key++));
    status = attach_finalizer(env, target, key, native_object, finalize_callback, finalize_hint, true);
    if (status != napi_ok)
        return status;
    if (result)
        return napi_create_reference(opaque_env, object, 0, result);
    return finish(env, napi_ok);
}

extern "C" napi_status node_api_post_finalizer(
    napi_env opaque_env,
    napi_finalize finalize_callback,
    void* finalize_data,
    void* finalize_hint
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !finalize_callback)
        return invalid(env);
    {
        std::lock_guard lock(env->async_mutex);
        env->posted_finalizers.push_back({ finalize_callback, finalize_data, finalize_hint, false });
    }
    wake(env);
    return finish(env, napi_ok);
}

extern "C" JSValueRef ct_napi_env_take_exception(CtNapiEnv* opaque_env)
{
    auto* env = static_cast<NapiEnv*>(opaque_env);
    if (!env || !env->pending_exception)
        return nullptr;
    JSValueRef exception = env->pending_exception;
    env->pending_exception = nullptr;
    JSValueUnprotect(env->context, exception);
    return exception;
}

static JSObjectRef make_weak_ref(NapiEnv* env, JSValueRef value, JSValueRef* exception)
{
    JSObjectRef constructor = global_constructor(env, "WeakRef", exception);
    if (*exception || !constructor)
        return nullptr;
    return JSObjectCallAsConstructor(env->context, constructor, 1, &value, exception);
}

static JSValueRef dereference_weak_ref(NapiEnv* env, JSObjectRef weak_ref, JSValueRef* exception)
{
    return call_method(env, weak_ref, "deref", 0, nullptr, exception);
}

extern "C" napi_status napi_create_reference(napi_env opaque_env, napi_value value, uint32_t initial_count, napi_ref* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef js_value = to_js(value);
    const bool is_symbol = JSValueIsSymbol(env->context, js_value);
    const bool can_be_weak = JSValueIsObject(env->context, js_value) || is_symbol;
    const bool primitive = !can_be_weak;
    if (primitive && env->module_api_version != NAPI_VERSION_EXPERIMENTAL)
        return finish(env, napi_invalid_arg);
    auto* reference = new (std::nothrow) napi_ref__;
    if (!reference)
        return finish(env, napi_generic_failure);
    reference->env = env;
    reference->value = js_value;
    reference->count = initial_count;
    reference->primitive = primitive;
    JSValueRef exception = nullptr;
    if (initial_count > 0) {
        JSValueProtect(env->context, js_value);
        reference->strong = true;
    }
    if (can_be_weak) {
        reference->weak_ref = make_weak_ref(env, js_value, &exception);
        if (!exception && reference->weak_ref) {
            JSValueProtect(env->context, reference->weak_ref);
        } else if (is_symbol) {
            // Registered symbols are immortal and cannot be WeakRef targets.
            exception = nullptr;
            reference->weak_ref = nullptr;
            reference->always_strong = true;
            if (!reference->strong) {
                JSValueProtect(env->context, js_value);
                reference->strong = true;
            }
        }
    } else if (initial_count == 0) {
        reference->value = nullptr;
    }
    if (exception) {
        if (reference->strong)
            JSValueUnprotect(env->context, js_value);
        delete reference;
        return caught(env, exception);
    }
    env->references.insert(reference);
    *result = reinterpret_cast<napi_ref>(reference);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_delete_reference(napi_env opaque_env, napi_ref opaque_reference)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    auto* reference = reinterpret_cast<napi_ref__*>(opaque_reference);
    if (!env || !reference || reference->env != env || reference->deleted)
        return invalid(env);
    reference->deleted = true;
    if (reference->owner_finalizer) {
        reference->owner_finalizer->wrap_ref = nullptr;
        reference->owner_finalizer = nullptr;
    }
    env->references.erase(reference);
    if (reference->value && reference->strong)
        JSValueUnprotect(env->context, reference->value);
    if (reference->weak_ref)
        JSValueUnprotect(env->context, reference->weak_ref);
    delete reference;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_reference_ref(napi_env opaque_env, napi_ref opaque_reference, uint32_t* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    auto* reference = reinterpret_cast<napi_ref__*>(opaque_reference);
    if (!env || !reference || reference->env != env || reference->deleted)
        return invalid(env);
    if (reference->invalidated)
        return finish(env, napi_generic_failure);
    if (reference->count == 0 && reference->weak_ref) {
        JSValueRef exception = nullptr;
        JSValueRef value = dereference_weak_ref(env, reference->weak_ref, &exception);
        if (exception)
            return caught(env, exception);
        if (!value || JSValueIsUndefined(env->context, value))
            return finish(env, napi_generic_failure);
        reference->value = value;
        JSValueProtect(env->context, value);
        reference->strong = true;
    }
    ++reference->count;
    if (result)
        *result = reference->count;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_reference_unref(napi_env opaque_env, napi_ref opaque_reference, uint32_t* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    auto* reference = reinterpret_cast<napi_ref__*>(opaque_reference);
    if (!env || !reference || reference->env != env || reference->deleted)
        return invalid(env);
    if (reference->invalidated)
        return finish(env, napi_generic_failure);
    if (reference->count == 0)
        return finish(env, napi_generic_failure);
    --reference->count;
    if (reference->count == 0 && reference->strong && !reference->always_strong) {
        JSValueUnprotect(env->context, reference->value);
        reference->strong = false;
        if (reference->primitive)
            reference->value = nullptr;
    }
    if (result)
        *result = reference->count;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_reference_value(napi_env opaque_env, napi_ref opaque_reference, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    auto* reference = reinterpret_cast<napi_ref__*>(opaque_reference);
    if (!env || !reference || reference->env != env || reference->deleted || !result)
        return invalid(env);
    if (reference->invalidated) {
        *result = nullptr;
        return finish(env, napi_ok);
    }
    JSValueRef value = reference->value;
    if (reference->count == 0 && reference->weak_ref) {
        JSValueRef exception = nullptr;
        value = dereference_weak_ref(env, reference->weak_ref, &exception);
        if (exception)
            return caught(env, exception);
        if (!value || JSValueIsUndefined(env->context, value)) {
            *result = nullptr;
            return finish(env, napi_ok);
        }
    }
    if (!value) {
        *result = nullptr;
        return finish(env, napi_ok);
    }
    track(env, value);
    *result = to_napi(value);
    return finish(env, napi_ok);
}

static bool is_array_buffer(NapiEnv* env, napi_value value, JSValueRef* exception)
{
    return value && JSValueGetTypedArrayType(env->context, to_js(value), exception) == kJSTypedArrayTypeArrayBuffer;
}

static bool is_buffer_value(NapiEnv* env, napi_value value, JSValueRef* exception)
{
    if (!value || !JSValueIsObject(env->context, to_js(value)))
        return false;
    JSObjectRef array_buffer_constructor = global_constructor(env, "ArrayBuffer", exception);
    if (*exception || !array_buffer_constructor)
        return false;
    JSValueRef argument = to_js(value);
    JSValueRef result = call_method(env, array_buffer_constructor, "isView", 1, &argument, exception);
    return !*exception && result && JSValueToBoolean(env->context, result);
}

static void apply_buffer_prototype(NapiEnv* env, JSObjectRef buffer, JSValueRef* exception)
{
    JSObjectRef constructor = global_constructor(env, "Buffer", exception);
    if (*exception || !constructor)
        return;
    JSValueRef prototype = get_property(env, constructor, "prototype", exception);
    if (!*exception && prototype)
        JSObjectSetPrototype(env->context, buffer, prototype);
}

extern "C" napi_status napi_create_arraybuffer(napi_env opaque_env, size_t byte_length, void** data, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !result)
        return invalid(env);
    void* bytes = std::calloc(byte_length ? byte_length : 1, 1);
    if (!bytes)
        return finish(env, napi_generic_failure);
    auto* finalizer = new (std::nothrow) NapiBufferFinalizer { env, bytes, nullptr, nullptr, true, false };
    if (!finalizer) {
        std::free(bytes);
        return finish(env, napi_generic_failure);
    }
    {
        std::lock_guard lock(env->async_mutex);
        env->buffer_finalizers.insert(finalizer);
    }
    JSValueRef exception = nullptr;
    JSObjectRef array_buffer = JSObjectMakeArrayBufferWithBytesNoCopy(env->context, bytes, byte_length, buffer_deallocator, finalizer, &exception);
    if (exception)
        return caught(env, exception);
    if (data)
        *data = byte_length ? bytes : nullptr;
    return output(env, result, array_buffer);
}

extern "C" napi_status napi_create_external_arraybuffer(
    napi_env opaque_env,
    void* external_data,
    size_t byte_length,
    napi_finalize finalize_callback,
    void* finalize_hint,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || (!external_data && byte_length) || !result)
        return invalid(env);
    auto* finalizer = new (std::nothrow) NapiBufferFinalizer { env, external_data, finalize_hint, finalize_callback, false, false };
    if (!finalizer)
        return finish(env, napi_generic_failure);
    {
        std::lock_guard lock(env->async_mutex);
        env->buffer_finalizers.insert(finalizer);
    }
    JSValueRef exception = nullptr;
    void* backing_data = external_data ? external_data : &empty_external_buffer_sentinel;
    JSObjectRef array_buffer = JSObjectMakeArrayBufferWithBytesNoCopy(env->context, backing_data, byte_length, buffer_deallocator, finalizer, &exception);
    if (!exception && !external_data && byte_length == 0)
        mark_logically_detached(env, array_buffer, &exception);
    if (!exception)
        mark_array_buffer_untransferable(env, array_buffer, &exception);
    return exception ? caught(env, exception) : output(env, result, array_buffer);
}

extern "C" napi_status napi_is_arraybuffer(napi_env opaque_env, napi_value value, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    *result = is_array_buffer(env, value, &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_get_arraybuffer_info(napi_env opaque_env, napi_value value, void** data, size_t* byte_length)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value)
        return invalid(env);
    JSValueRef exception = nullptr;
    if (!is_array_buffer(env, value, &exception))
        return exception ? caught(env, exception) : finish(env, napi_arraybuffer_expected);
    JSObjectRef object = as_object(env, value);
    size_t length = JSObjectGetArrayBufferByteLength(env->context, object, &exception);
    void* bytes = data && length && !exception
        ? JSObjectGetArrayBufferBytesPtr(env->context, object, &exception)
        : nullptr;
    if (exception)
        return caught(env, exception);
    if (data)
        *data = length ? bytes : nullptr;
    if (byte_length)
        *byte_length = length;
    return finish(env, napi_ok);
}

static JSTypedArrayType to_jsc_typed_array(napi_typedarray_type type)
{
    switch (type) {
    case napi_int8_array: return kJSTypedArrayTypeInt8Array;
    case napi_uint8_array: return kJSTypedArrayTypeUint8Array;
    case napi_uint8_clamped_array: return kJSTypedArrayTypeUint8ClampedArray;
    case napi_int16_array: return kJSTypedArrayTypeInt16Array;
    case napi_uint16_array: return kJSTypedArrayTypeUint16Array;
    case napi_int32_array: return kJSTypedArrayTypeInt32Array;
    case napi_uint32_array: return kJSTypedArrayTypeUint32Array;
    case napi_float32_array: return kJSTypedArrayTypeFloat32Array;
    case napi_float64_array: return kJSTypedArrayTypeFloat64Array;
    case napi_bigint64_array: return kJSTypedArrayTypeBigInt64Array;
    case napi_biguint64_array: return kJSTypedArrayTypeBigUint64Array;
    }
    return kJSTypedArrayTypeNone;
}

static bool from_jsc_typed_array(JSTypedArrayType type, napi_typedarray_type* result)
{
    switch (type) {
    case kJSTypedArrayTypeInt8Array: *result = napi_int8_array; return true;
    case kJSTypedArrayTypeUint8Array: *result = napi_uint8_array; return true;
    case kJSTypedArrayTypeUint8ClampedArray: *result = napi_uint8_clamped_array; return true;
    case kJSTypedArrayTypeInt16Array: *result = napi_int16_array; return true;
    case kJSTypedArrayTypeUint16Array: *result = napi_uint16_array; return true;
    case kJSTypedArrayTypeInt32Array: *result = napi_int32_array; return true;
    case kJSTypedArrayTypeUint32Array: *result = napi_uint32_array; return true;
    case kJSTypedArrayTypeFloat32Array: *result = napi_float32_array; return true;
    case kJSTypedArrayTypeFloat64Array: *result = napi_float64_array; return true;
    case kJSTypedArrayTypeBigInt64Array: *result = napi_bigint64_array; return true;
    case kJSTypedArrayTypeBigUint64Array: *result = napi_biguint64_array; return true;
    default: return false;
    }
}

extern "C" napi_status napi_is_typedarray(napi_env opaque_env, napi_value value, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    napi_typedarray_type ignored;
    *result = from_jsc_typed_array(JSValueGetTypedArrayType(env->context, to_js(value), &exception), &ignored);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_create_typedarray(
    napi_env opaque_env,
    napi_typedarray_type type,
    size_t length,
    napi_value arraybuffer,
    size_t byte_offset,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !arraybuffer || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    if (!is_array_buffer(env, arraybuffer, &exception))
        return exception ? caught(env, exception) : finish(env, napi_arraybuffer_expected);
    JSTypedArrayType jsc_type = to_jsc_typed_array(type);
    if (jsc_type == kJSTypedArrayTypeNone)
        return invalid(env);
    JSObjectRef view = JSObjectMakeTypedArrayWithArrayBufferAndOffset(env->context, jsc_type, as_object(env, arraybuffer), byte_offset, length, &exception);
    return exception ? caught(env, exception) : output(env, result, view);
}

extern "C" napi_status napi_get_typedarray_info(
    napi_env opaque_env,
    napi_value value,
    napi_typedarray_type* type,
    size_t* length,
    void** data,
    napi_value* arraybuffer,
    size_t* byte_offset
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value)
        return invalid(env);
    JSValueRef exception = nullptr;
    JSTypedArrayType jsc_type = JSValueGetTypedArrayType(env->context, to_js(value), &exception);
    napi_typedarray_type napi_type;
    if (exception)
        return caught(env, exception);
    if (!from_jsc_typed_array(jsc_type, &napi_type))
        return finish(env, napi_invalid_arg);
    JSObjectRef view = as_object(env, value);
    // JSC pins a backing store when its data pointer is requested. Preserve
    // detachability unless the N-API caller actually asks for that pointer.
    size_t view_length = length ? JSObjectGetTypedArrayLength(env->context, view, &exception) : 0;
    size_t byte_length = data && !exception ? JSObjectGetTypedArrayByteLength(env->context, view, &exception) : 0;
    size_t offset = (data || byte_offset) && !exception ? JSObjectGetTypedArrayByteOffset(env->context, view, &exception) : 0;
    void* bytes = data && byte_length && !exception
        ? JSObjectGetTypedArrayBytesPtr(env->context, view, &exception)
        : nullptr;
    JSObjectRef buffer = arraybuffer && !exception ? JSObjectGetTypedArrayBuffer(env->context, view, &exception) : nullptr;
    if (exception)
        return caught(env, exception);
    if (type)
        *type = napi_type;
    if (length)
        *length = view_length;
    if (data)
        *data = bytes ? static_cast<unsigned char*>(bytes) + offset : nullptr;
    if (arraybuffer) {
        track(env, buffer);
        *arraybuffer = to_napi(buffer);
    }
    if (byte_offset)
        *byte_offset = offset;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_create_dataview(
    napi_env opaque_env,
    size_t length,
    napi_value arraybuffer,
    size_t byte_offset,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !arraybuffer || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    if (!is_array_buffer(env, arraybuffer, &exception))
        return exception ? caught(env, exception) : finish(env, napi_arraybuffer_expected);
    size_t buffer_length = JSObjectGetArrayBufferByteLength(env->context, as_object(env, arraybuffer), &exception);
    if (exception)
        return caught(env, exception);
    if (byte_offset > buffer_length || length > buffer_length - byte_offset) {
        napi_status status = napi_throw_range_error(
            opaque_env,
            "ERR_NAPI_INVALID_DATAVIEW_ARGS",
            "byte_offset + byte_length should be less than or equal to the size in bytes of the array passed in");
        return status == napi_ok ? finish(env, napi_pending_exception) : status;
    }
    JSObjectRef constructor = global_constructor(env, "DataView", &exception);
    JSValueRef arguments[] = { to_js(arraybuffer), JSValueMakeNumber(env->context, byte_offset), JSValueMakeNumber(env->context, length) };
    JSObjectRef view = exception || !constructor ? nullptr : JSObjectCallAsConstructor(env->context, constructor, 3, arguments, &exception);
    return exception ? caught(env, exception) : output(env, result, view);
}

extern "C" napi_status napi_is_dataview(napi_env opaque_env, napi_value value, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    *result = is_instance_of_global(env, value, "DataView", &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_get_dataview_info(
    napi_env opaque_env,
    napi_value value,
    size_t* byte_length,
    void** data,
    napi_value* arraybuffer,
    size_t* byte_offset
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value)
        return invalid(env);
    bool is_view = false;
    napi_status status = napi_is_dataview(opaque_env, value, &is_view);
    if (status != napi_ok || !is_view)
        return status != napi_ok ? status : finish(env, napi_invalid_arg);
    JSObjectRef view = as_object(env, value);
    JSValueRef exception = nullptr;
    JSValueRef buffer_value = get_property(env, view, "buffer", &exception);
    JSValueRef length_value = exception ? nullptr : get_property(env, view, "byteLength", &exception);
    JSValueRef offset_value = exception ? nullptr : get_property(env, view, "byteOffset", &exception);
    if (exception)
        return caught(env, exception);
    JSObjectRef buffer = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(buffer_value));
    size_t offset = static_cast<size_t>(JSValueToNumber(env->context, offset_value, &exception));
    size_t length = static_cast<size_t>(JSValueToNumber(env->context, length_value, &exception));
    void* bytes = data && length
        ? JSObjectGetArrayBufferBytesPtr(env->context, buffer, &exception)
        : nullptr;
    if (exception)
        return caught(env, exception);
    if (byte_length)
        *byte_length = length;
    if (data)
        *data = bytes ? static_cast<unsigned char*>(bytes) + offset : nullptr;
    if (arraybuffer) {
        track(env, buffer_value);
        *arraybuffer = to_napi(buffer_value);
    }
    if (byte_offset)
        *byte_offset = offset;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_create_buffer(napi_env opaque_env, size_t length, void** data, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    JSObjectRef buffer = JSObjectMakeTypedArray(env->context, kJSTypedArrayTypeUint8Array, length, &exception);
    if (exception)
        return caught(env, exception);
    apply_buffer_prototype(env, buffer, &exception);
    if (exception)
        return caught(env, exception);
    if (data)
        *data = JSObjectGetTypedArrayBytesPtr(env->context, buffer, &exception);
    return exception ? caught(env, exception) : output(env, result, buffer);
}

extern "C" napi_status napi_create_external_buffer(
    napi_env opaque_env,
    size_t length,
    void* data,
    napi_finalize finalize_callback,
    void* finalize_hint,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || (!data && length) || !result)
        return invalid(env);
    auto* finalizer = new (std::nothrow) NapiBufferFinalizer { env, data, finalize_hint, finalize_callback, false, false };
    if (!finalizer)
        return finish(env, napi_generic_failure);
    {
        std::lock_guard lock(env->async_mutex);
        env->buffer_finalizers.insert(finalizer);
    }
    JSValueRef exception = nullptr;
    void* backing_data = data ? data : &empty_external_buffer_sentinel;
    JSObjectRef buffer = JSObjectMakeTypedArrayWithBytesNoCopy(env->context, kJSTypedArrayTypeUint8Array, backing_data, length, buffer_deallocator, finalizer, &exception);
    if (exception)
        return caught(env, exception);
    apply_buffer_prototype(env, buffer, &exception);
    JSValueRef array_buffer = exception ? nullptr : get_property(env, buffer, "buffer", &exception);
    if (!exception && array_buffer && JSValueIsObject(env->context, array_buffer)) {
        auto object = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(array_buffer));
        if (!data && length == 0)
            mark_logically_detached(env, object, &exception);
        mark_array_buffer_untransferable(env, object, &exception);
    }
    return exception ? caught(env, exception) : output(env, result, buffer);
}

extern "C" napi_status napi_create_buffer_copy(
    napi_env opaque_env,
    size_t length,
    const void* source,
    void** result_data,
    napi_value* result
)
{
    void* destination = nullptr;
    napi_status status = napi_create_buffer(opaque_env, length, &destination, result);
    if (status == napi_ok && length) {
        if (!source)
            return invalid(reinterpret_cast<NapiEnv*>(opaque_env));
        std::memcpy(destination, source, length);
    }
    if (status == napi_ok && result_data)
        *result_data = destination;
    return status;
}

extern "C" napi_status napi_is_buffer(napi_env opaque_env, napi_value value, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    *result = is_buffer_value(env, value, &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_get_buffer_info(napi_env opaque_env, napi_value value, void** data, size_t* length)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value)
        return invalid(env);
    JSValueRef exception = nullptr;
    if (!is_buffer_value(env, value, &exception))
        return exception ? caught(env, exception) : finish(env, napi_invalid_arg);
    JSObjectRef buffer = as_object(env, value);
    size_t size = JSObjectGetTypedArrayByteLength(env->context, buffer, &exception);
    size_t offset = data && !exception ? JSObjectGetTypedArrayByteOffset(env->context, buffer, &exception) : 0;
    void* bytes = data && size && !exception
        ? JSObjectGetTypedArrayBytesPtr(env->context, buffer, &exception)
        : nullptr;
    if (exception)
        return caught(env, exception);
    if (data)
        *data = bytes ? static_cast<unsigned char*>(bytes) + offset : nullptr;
    if (length)
        *length = size;
    return finish(env, napi_ok);
}

extern "C" napi_status node_api_create_buffer_from_arraybuffer(
    napi_env opaque_env,
    napi_value arraybuffer,
    size_t byte_offset,
    size_t byte_length,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !arraybuffer || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    if (!is_array_buffer(env, arraybuffer, &exception))
        return exception ? caught(env, exception) : finish(env, napi_arraybuffer_expected);
    JSObjectRef buffer = JSObjectMakeTypedArrayWithArrayBufferAndOffset(env->context, kJSTypedArrayTypeUint8Array, as_object(env, arraybuffer), byte_offset, byte_length, &exception);
    if (exception)
        return caught(env, exception);
    apply_buffer_prototype(env, buffer, &exception);
    return exception ? caught(env, exception) : output(env, result, buffer);
}

extern "C" napi_status napi_create_promise(napi_env opaque_env, napi_deferred* deferred, napi_value* promise)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !deferred || !promise)
        return invalid(env);
    JSValueRef exception = nullptr;
    JSObjectRef resolve = nullptr;
    JSObjectRef reject = nullptr;
    JSObjectRef promise_object = JSObjectMakeDeferredPromise(env->context, &resolve, &reject, &exception);
    if (exception)
        return caught(env, exception);
    auto* state = new (std::nothrow) napi_deferred__ { env, resolve, reject, false };
    if (!state)
        return finish(env, napi_generic_failure);
    JSValueProtect(env->context, resolve);
    JSValueProtect(env->context, reject);
    *deferred = reinterpret_cast<napi_deferred>(state);
    return output(env, promise, promise_object);
}

static napi_status settle_deferred(napi_env opaque_env, napi_deferred opaque_deferred, napi_value value, bool resolve)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    auto* deferred = reinterpret_cast<napi_deferred__*>(opaque_deferred);
    if (!env || !deferred || deferred->env != env || deferred->settled || !value)
        return invalid(env);
    JSValueRef exception = nullptr;
    JSObjectRef function = resolve ? deferred->resolve : deferred->reject;
    JSValueRef argument = to_js(value);
    JSObjectCallAsFunction(env->context, function, nullptr, 1, &argument, &exception);
    deferred->settled = true;
    JSValueUnprotect(env->context, deferred->resolve);
    JSValueUnprotect(env->context, deferred->reject);
    delete deferred;
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_resolve_deferred(napi_env env, napi_deferred deferred, napi_value resolution)
{
    return settle_deferred(env, deferred, resolution, true);
}

extern "C" napi_status napi_reject_deferred(napi_env env, napi_deferred deferred, napi_value rejection)
{
    return settle_deferred(env, deferred, rejection, false);
}

extern "C" napi_status napi_is_promise(napi_env opaque_env, napi_value value, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    *result = is_instance_of_global(env, value, "Promise", &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_create_date(napi_env opaque_env, double time, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    JSValueRef argument = JSValueMakeNumber(env->context, time);
    JSObjectRef date = JSObjectMakeDate(env->context, 1, &argument, &exception);
    return exception ? caught(env, exception) : output(env, result, date);
}

extern "C" napi_status napi_is_date(napi_env opaque_env, napi_value value, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result)
        return invalid(env);
    *result = JSValueIsDate(env->context, to_js(value));
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_date_value(napi_env opaque_env, napi_value value, double* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result)
        return invalid(env);
    if (!JSValueIsDate(env->context, to_js(value)))
        return finish(env, napi_date_expected);
    JSValueRef exception = nullptr;
    JSValueRef number = call_method(env, as_object(env, value), "getTime", 0, nullptr, &exception);
    if (exception)
        return caught(env, exception);
    *result = JSValueToNumber(env->context, number, &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_run_script(napi_env opaque_env, napi_value script, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !script || !result)
        return invalid(env);
    if (!JSValueIsString(env->context, to_js(script)))
        return finish(env, napi_string_expected);
    JSValueRef exception = nullptr;
    JSStringRef source = JSValueToStringCopy(env->context, to_js(script), &exception);
    if (exception)
        return caught(env, exception);
    JSValueRef value = JSEvaluateScript(env->context, source, nullptr, nullptr, 1, &exception);
    JSStringRelease(source);
    if (exception && JSValueIsObject(env->context, exception)) {
        JSValueRef ignored_exception = nullptr;
        auto error = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(exception));
        JSValueRef name_value = get_property(env, error, "name", &ignored_exception);
        JSValueRef message_value = ignored_exception ? nullptr : get_property(env, error, "message", &ignored_exception);
        if (!ignored_exception && name_value && message_value
            && JSValueIsString(env->context, name_value) && JSValueIsString(env->context, message_value)) {
            JSStringRef name_string = JSValueToStringCopy(env->context, name_value, &ignored_exception);
            JSStringRef message_string = ignored_exception ? nullptr : JSValueToStringCopy(env->context, message_value, &ignored_exception);
            const std::string name = ignored_exception ? std::string() : copy_js_string(name_string);
            const std::string message = ignored_exception ? std::string() : copy_js_string(message_string);
            if (name_string)
                JSStringRelease(name_string);
            if (message_string)
                JSStringRelease(message_string);
            constexpr std::string_view prefix = "Can't find variable: ";
            if (!ignored_exception && name == "ReferenceError" && message.starts_with(prefix)) {
                std::string normalized = message.substr(prefix.size()) + " is not defined";
                JSStringRef normalized_string = JSStringCreateWithUTF8CString(normalized.c_str());
                set_property(env, error, "message", JSValueMakeString(env->context, normalized_string), kJSPropertyAttributeNone, &ignored_exception);
                JSStringRelease(normalized_string);
            }
        }
    }
    return exception ? caught(env, exception) : output(env, result, value);
}

extern "C" napi_status napi_adjust_external_memory(napi_env opaque_env, int64_t change, int64_t* adjusted)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !adjusted)
        return invalid(env);
    if ((change > 0 && env->external_memory > std::numeric_limits<int64_t>::max() - change)
        || (change < 0 && env->external_memory < std::numeric_limits<int64_t>::min() - change))
        return finish(env, napi_generic_failure);
    env->external_memory += change;
    *adjusted = env->external_memory;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_version(napi_env opaque_env, uint32_t* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    *result = 9;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_node_version(napi_env opaque_env, const napi_node_version** result)
{
    // COTTONTAIL-COMPAT: Keep this synchronized with nodeCompatVersion in node/process.js.
    static const napi_node_version version { 24, 11, 1, "node" };
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    *result = &version;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_create_bigint_int64(napi_env opaque_env, int64_t value, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    JSValueRef bigint = JSBigIntCreateWithInt64(env->context, value, &exception);
    return exception ? caught(env, exception) : output(env, result, bigint);
}

extern "C" napi_status napi_create_bigint_uint64(napi_env opaque_env, uint64_t value, napi_value* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    JSValueRef bigint = JSBigIntCreateWithUInt64(env->context, value, &exception);
    return exception ? caught(env, exception) : output(env, result, bigint);
}

static JSValueRef bigint_from_string(NapiEnv* env, const std::string& text, JSValueRef* exception)
{
    JSStringRef string = make_utf8_string(text.data(), text.size());
    JSValueRef result = JSBigIntCreateWithString(env->context, string, exception);
    JSStringRelease(string);
    return result;
}

static JSValueRef negate_bigint(NapiEnv* env, JSValueRef value, JSValueRef* exception)
{
    JSStringRef name = JSStringCreateWithUTF8CString("negateBigInt");
    JSStringRef parameter = JSStringCreateWithUTF8CString("value");
    JSStringRef body = JSStringCreateWithUTF8CString("return -value;");
    JSObjectRef function = JSObjectMakeFunction(env->context, name, 1, &parameter, body, nullptr, 1, exception);
    JSStringRelease(body);
    JSStringRelease(parameter);
    JSStringRelease(name);
    if (*exception || !function)
        return nullptr;
    return JSObjectCallAsFunction(env->context, function, nullptr, 1, &value, exception);
}

extern "C" napi_status napi_create_bigint_words(
    napi_env opaque_env,
    int sign_bit,
    size_t word_count,
    const uint64_t* words,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result || !words)
        return invalid(env);
    if (word_count > std::numeric_limits<unsigned>::max())
        return finish(env, napi_invalid_arg);
    if (word_count >= static_cast<size_t>(std::numeric_limits<int>::max())) {
        napi_status status = napi_throw_range_error(opaque_env, nullptr, "Out of memory");
        return status == napi_ok ? finish(env, napi_pending_exception) : status;
    }
    size_t highest = word_count;
    while (highest && words[highest - 1] == 0)
        --highest;
    const bool negative = sign_bit && highest;
    std::string text = "0x";
    if (!highest) {
        text += "0";
    } else {
        char chunk[17];
        std::snprintf(chunk, sizeof(chunk), "%llx", static_cast<unsigned long long>(words[highest - 1]));
        text += chunk;
        while (--highest) {
            std::snprintf(chunk, sizeof(chunk), "%016llx", static_cast<unsigned long long>(words[highest - 1]));
            text += chunk;
        }
    }
    JSValueRef exception = nullptr;
    JSValueRef bigint = bigint_from_string(env, text, &exception);
    if (!exception && negative)
        bigint = negate_bigint(env, bigint, &exception);
    return exception ? caught(env, exception) : output(env, result, bigint);
}

static napi_status bigint_to_string(NapiEnv* env, napi_value value, std::string* output_text)
{
    if (!env || !value || !output_text)
        return invalid(env);
    if (!JSValueIsBigInt(env->context, to_js(value)))
        return finish(env, napi_bigint_expected);
    JSValueRef exception = nullptr;
    JSObjectRef boxed = JSValueToObject(env->context, to_js(value), &exception);
    if (exception)
        return caught(env, exception);
    JSValueRef radix = JSValueMakeNumber(env->context, 16);
    JSValueRef text_value = call_method(env, boxed, "toString", 1, &radix, &exception);
    if (exception)
        return caught(env, exception);
    JSStringRef string = JSValueToStringCopy(env->context, text_value, &exception);
    if (exception)
        return caught(env, exception);
    *output_text = copy_js_string(string);
    JSStringRelease(string);
    return finish(env, napi_ok);
}

static bool bigint_lossless(NapiEnv* env, napi_value value, const char* method, JSValueRef* exception)
{
    JSObjectRef constructor = global_constructor(env, "BigInt", exception);
    if (*exception || !constructor)
        return false;
    JSValueRef arguments[] = { JSValueMakeNumber(env->context, 64), to_js(value) };
    JSValueRef narrowed = call_method(env, constructor, method, 2, arguments, exception);
    return !*exception && JSValueIsStrictEqual(env->context, narrowed, to_js(value));
}

extern "C" napi_status napi_get_value_bigint_int64(napi_env opaque_env, napi_value value, int64_t* result, bool* lossless)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value || !result || !lossless)
        return invalid(env);
    if (!JSValueIsBigInt(env->context, to_js(value)))
        return finish(env, napi_bigint_expected);
    JSValueRef exception = nullptr;
    *result = JSValueToInt64(env->context, to_js(value), &exception);
    if (!exception)
        *lossless = bigint_lossless(env, value, "asIntN", &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_get_value_bigint_uint64(napi_env opaque_env, napi_value value, uint64_t* result, bool* lossless)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value || !result || !lossless)
        return invalid(env);
    if (!JSValueIsBigInt(env->context, to_js(value)))
        return finish(env, napi_bigint_expected);
    JSValueRef exception = nullptr;
    *result = JSValueToUInt64(env->context, to_js(value), &exception);
    if (!exception)
        *lossless = bigint_lossless(env, value, "asUintN", &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_get_value_bigint_words(
    napi_env opaque_env,
    napi_value value,
    int* sign_bit,
    size_t* word_count,
    uint64_t* words
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value || !word_count)
        return invalid(env);
    if ((!sign_bit) != (!words))
        return finish(env, napi_invalid_arg);
    std::string text;
    napi_status status = bigint_to_string(env, value, &text);
    if (status != napi_ok)
        return status;
    bool negative = !text.empty() && text[0] == '-';
    if (negative)
        text.erase(text.begin());
    size_t required = text == "0" ? 0 : (text.size() + 15) / 16;
    size_t capacity = *word_count;
    if (sign_bit)
        *sign_bit = negative ? 1 : 0;
    *word_count = required;
    if (words) {
        size_t copied = std::min(capacity, required);
        for (size_t index = 0; index < copied; ++index) {
            size_t end = text.size() - std::min(text.size(), index * 16);
            size_t start = end > 16 ? end - 16 : 0;
            words[index] = std::strtoull(text.substr(start, end - start).c_str(), nullptr, 16);
        }
    }
    return finish(env, napi_ok);
}

extern "C" napi_status napi_set_instance_data(napi_env opaque_env, void* data, napi_finalize callback, void* hint)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env)
        return napi_invalid_arg;
    if (env->instance_finalizer)
        env->instance_finalizer(opaque_env, env->instance_data, env->instance_hint);
    env->instance_data = data;
    env->instance_finalizer = callback;
    env->instance_hint = hint;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_instance_data(napi_env opaque_env, void** result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    *result = env->instance_data;
    return finish(env, napi_ok);
}

extern "C" napi_status node_api_get_module_file_name(napi_env opaque_env, const char** result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    *result = env->module_filename.c_str();
    return finish(env, napi_ok);
}

extern "C" napi_status node_api_create_property_key_utf8(napi_env env, const char* value, size_t length, napi_value* result)
{
    return napi_create_string_utf8(env, value, length, result);
}

extern "C" napi_status node_api_create_property_key_latin1(napi_env env, const char* value, size_t length, napi_value* result)
{
    return napi_create_string_latin1(env, value, length, result);
}

extern "C" napi_status node_api_create_property_key_utf16(napi_env env, const char16_t* value, size_t length, napi_value* result)
{
    return napi_create_string_utf16(env, value, length, result);
}

extern "C" napi_status node_api_create_external_string_latin1(
    napi_env opaque_env,
    char* value,
    size_t length,
    napi_finalize finalize_callback,
    void* finalize_hint,
    napi_value* result,
    bool* copied
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result || !finalize_callback)
        return invalid(env);
    if (length == NAPI_AUTO_LENGTH)
        length = std::strlen(value);
    if (length == 0 || length > static_cast<size_t>(std::numeric_limits<int32_t>::max()))
        return invalid(env);

    auto* finalizer = new (std::nothrow) NapiBufferFinalizer {
        env, value, finalize_hint, finalize_callback, false, false
    };
    if (!finalizer)
        return finish(env, napi_generic_failure);
    {
        std::lock_guard lock(env->async_mutex);
        env->buffer_finalizers.insert(finalizer);
    }

    JSStringRef string = ct_jsc_string_create_external_latin1(
        reinterpret_cast<const uint8_t*>(value),
        length,
        external_string_deallocator,
        finalizer);
    if (!string) {
        std::lock_guard lock(env->async_mutex);
        env->buffer_finalizers.erase(finalizer);
        delete finalizer;
        return finish(env, napi_generic_failure);
    }

    napi_status status = output(env, result, JSValueMakeString(env->context, string));
    JSStringRelease(string);
    if (copied)
        *copied = false;
    return status;
}

extern "C" napi_status node_api_create_external_string_utf16(
    napi_env opaque_env,
    char16_t* value,
    size_t length,
    napi_finalize finalize_callback,
    void* finalize_hint,
    napi_value* result,
    bool* copied
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !value || !result || !finalize_callback)
        return invalid(env);
    if (length == NAPI_AUTO_LENGTH) {
        length = 0;
        while (value[length])
            ++length;
    }
    if (length == 0 || length > static_cast<size_t>(std::numeric_limits<int32_t>::max()))
        return invalid(env);

    auto* finalizer = new (std::nothrow) NapiBufferFinalizer {
        env, value, finalize_hint, finalize_callback, false, false
    };
    if (!finalizer)
        return finish(env, napi_generic_failure);
    {
        std::lock_guard lock(env->async_mutex);
        env->buffer_finalizers.insert(finalizer);
    }

    JSStringRef string = ct_jsc_string_create_external_utf16(
        value,
        length,
        external_string_deallocator,
        finalizer);
    if (!string) {
        std::lock_guard lock(env->async_mutex);
        env->buffer_finalizers.erase(finalizer);
        delete finalizer;
        return finish(env, napi_generic_failure);
    }

    napi_status status = output(env, result, JSValueMakeString(env->context, string));
    JSStringRelease(string);
    if (copied)
        *copied = false;
    return status;
}

extern "C" napi_status napi_async_init(
    napi_env opaque_env,
    napi_value resource,
    napi_value resource_name,
    napi_async_context* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !resource_name || !result)
        return invalid(env);

    JSContextGroupRef context_group = JSContextGetGroup(env->context);
    JSObjectRef resource_object = resource && JSValueIsObject(env->context, to_js(resource))
        ? as_object(env, resource)
        : nullptr;
    CtJSWeakRef weak_resource = resource_object
        ? JSWeakCreate(context_group, resource_object)
        : nullptr;
    if (resource_object && !weak_resource)
        return finish(env, napi_generic_failure);

    JSValueRef exception = nullptr;
    JSValueRef arguments[] = {
        resource ? to_js(resource) : JSValueMakeUndefined(env->context),
        to_js(resource_name),
        JSValueMakeBoolean(env->context, weak_resource != nullptr),
    };
    JSValueRef record_value = call_global_function(
        env,
        "__cottontailNapiAsyncInit",
        std::size(arguments),
        arguments,
        &exception);
    if (exception) {
        if (weak_resource)
            JSWeakRelease(context_group, weak_resource);
        return caught(env, exception);
    }
    if (!record_value || !JSValueIsObject(env->context, record_value)) {
        if (weak_resource)
            JSWeakRelease(context_group, weak_resource);
        return finish(env, napi_generic_failure);
    }

    auto* context = new (std::nothrow) napi_async_context__ {
        env,
        const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(record_value)),
        weak_resource,
    };
    if (!context) {
        if (weak_resource)
            JSWeakRelease(context_group, weak_resource);
        return finish(env, napi_generic_failure);
    }
    JSValueProtect(env->context, context->record);
    try {
        env->async_contexts.insert(context);
    } catch (...) {
        JSValueUnprotect(env->context, context->record);
        if (context->resource)
            JSWeakRelease(context_group, context->resource);
        delete context;
        return finish(env, napi_generic_failure);
    }
    *result = reinterpret_cast<napi_async_context>(context);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_async_destroy(napi_env opaque_env, napi_async_context opaque_context)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !opaque_context)
        return invalid(env);
    auto* context = reinterpret_cast<napi_async_context__*>(opaque_context);
    if (context->env != env || !env->async_contexts.contains(context))
        return invalid(env);

    JSValueRef exception = nullptr;
    JSValueRef argument = context->record;
    JSValueRef returned = call_global_function(
        env,
        "__cottontailNapiAsyncDestroy",
        1,
        &argument,
        &exception);
    env->async_contexts.erase(context);
    JSValueUnprotect(env->context, context->record);
    if (context->resource)
        JSWeakRelease(JSContextGetGroup(env->context), context->resource);
    delete context;
    if (exception)
        return caught(env, exception);
    return returned ? finish(env, napi_ok) : finish(env, napi_generic_failure);
}

extern "C" napi_status napi_make_callback(
    napi_env opaque_env,
    napi_async_context opaque_context,
    napi_value receiver,
    napi_value function,
    size_t argc,
    const napi_value* argv,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !receiver || !function || (argc && !argv))
        return invalid(env);
    auto* context = reinterpret_cast<napi_async_context__*>(opaque_context);
    if (context && (context->env != env || !env->async_contexts.contains(context)))
        return invalid(env);
    JSObjectRef callable = as_object(env, function);
    if (!callable || !JSObjectIsFunction(env->context, callable))
        return finish(env, napi_function_expected);

    std::vector<JSValueRef> js_arguments(argc);
    for (size_t index = 0; index < argc; ++index)
        js_arguments[index] = to_js(argv[index]);
    JSValueRef exception = nullptr;
    JSObjectRef argument_array = JSObjectMakeArray(
        env->context,
        argc,
        js_arguments.empty() ? nullptr : js_arguments.data(),
        &exception);
    JSObjectRef async_resource = context && context->resource
        ? JSWeakGetObject(context->resource)
        : nullptr;
    JSValueRef host_arguments[] = {
        context ? static_cast<JSValueRef>(context->record) : JSValueMakeNull(env->context),
        to_js(receiver),
        callable,
        argument_array,
        async_resource ? static_cast<JSValueRef>(async_resource) : JSValueMakeUndefined(env->context),
    };
    JSValueRef returned = exception
        ? nullptr
        : call_global_function(
            env,
            "__cottontailNapiMakeCallback",
            std::size(host_arguments),
            host_arguments,
            &exception);
    if (exception)
        return caught(env, exception);
    if (!returned)
        return finish(env, napi_generic_failure);
    if (process_is_exiting(env, &exception))
        return finish(env, napi_pending_exception);
    if (exception)
        return caught(env, exception);
    return result ? output(env, result, returned) : finish(env, napi_ok);
}

extern "C" napi_status napi_open_callback_scope(
    napi_env opaque_env,
    napi_value,
    napi_async_context opaque_context,
    napi_callback_scope* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    auto* context = reinterpret_cast<napi_async_context__*>(opaque_context);
    if (!env || !context || !result || context->env != env || !env->async_contexts.contains(context))
        return invalid(env);

    JSValueRef exception = nullptr;
    JSObjectRef async_resource = context->resource
        ? JSWeakGetObject(context->resource)
        : nullptr;
    JSValueRef arguments[] = {
        context->record,
        async_resource ? static_cast<JSValueRef>(async_resource) : JSValueMakeUndefined(env->context),
    };
    JSValueRef token_value = call_global_function(
        env,
        "__cottontailNapiOpenCallbackScope",
        std::size(arguments),
        arguments,
        &exception);
    if (exception)
        return caught(env, exception);
    if (!token_value || !JSValueIsObject(env->context, token_value))
        return finish(env, napi_generic_failure);
    auto token = const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(token_value));
    auto* scope = new (std::nothrow) napi_callback_scope__ {
        env,
        token,
        env->pending_exception != nullptr,
    };
    if (!scope)
        return finish(env, napi_generic_failure);
    JSValueProtect(env->context, token);
    *result = reinterpret_cast<napi_callback_scope>(scope);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_close_callback_scope(napi_env opaque_env, napi_callback_scope opaque_scope)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    auto* scope = reinterpret_cast<napi_callback_scope__*>(opaque_scope);
    if (!env || !scope || scope->env != env)
        return finish(env, napi_callback_scope_mismatch);

    const bool had_pending_exception = scope->had_pending_exception;
    const bool failed = !had_pending_exception && env->pending_exception != nullptr;
    JSValueRef close_exception = nullptr;
    JSValueRef arguments[] = {
        scope->token,
        JSValueMakeBoolean(env->context, failed),
    };
    JSValueRef returned = call_global_function(
        env,
        "__cottontailNapiCloseCallbackScope",
        std::size(arguments),
        arguments,
        &close_exception);
    JSValueUnprotect(env->context, scope->token);
    delete scope;

    if (close_exception)
        protect_pending(env, close_exception);
    if (!returned && !close_exception)
        return finish(env, napi_generic_failure);

    if (!had_pending_exception && env->pending_exception) {
        JSValueRef pending = env->pending_exception;
        env->pending_exception = nullptr;
        JSValueRef handler_exception = nullptr;
        const bool handled = handle_uncaught_exception(env, pending, &handler_exception);
        if (handler_exception) {
            JSValueUnprotect(env->context, pending);
            protect_pending(env, handler_exception);
        } else if (handled) {
            JSValueUnprotect(env->context, pending);
        } else {
            env->pending_exception = pending;
        }
    }
    return finish(env, napi_ok);
}

extern "C" napi_status napi_create_async_work(
    napi_env opaque_env,
    napi_value resource,
    napi_value resource_name,
    napi_async_execute_callback execute,
    napi_async_complete_callback complete,
    void* data,
    napi_async_work* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !resource_name || !execute || !result)
        return invalid(env);
    auto* work = new (std::nothrow) napi_async_work__;
    if (!work)
        return finish(env, napi_generic_failure);
    work->env = env;
    work->execute = execute;
    work->complete = complete;
    work->data = data;
    napi_status context_status = napi_async_init(
        opaque_env,
        resource,
        resource_name,
        &work->async_context);
    if (context_status != napi_ok) {
        delete work;
        return context_status;
    }
    try {
        std::lock_guard lock(env->async_mutex);
        env->async_work.insert(work);
    } catch (...) {
        napi_async_context context = std::exchange(work->async_context, nullptr);
        (void)napi_async_destroy(opaque_env, context);
        delete work;
        return finish(env, napi_generic_failure);
    }
    *result = reinterpret_cast<napi_async_work>(work);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_queue_async_work(napi_env opaque_env, napi_async_work opaque_work)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    auto* work = reinterpret_cast<napi_async_work__*>(opaque_work);
    if (!env || !work || work->env != env)
        return invalid(env);
    auto* loop = event_loop_is_active(env) ? event_loop_for_env(env) : nullptr;
    if (!loop)
        return finish(env, napi_generic_failure);
    int expected = 0;
    if (!work->state.compare_exchange_strong(expected, 1))
        return finish(env, napi_generic_failure);
    work->request.data = work;
    int status = uv_queue_work(loop, &work->request, napi_uv_work_execute, napi_uv_work_complete);
    if (status != 0) {
        work->state.store(0);
        return finish(env, napi_generic_failure);
    }
    return finish(env, napi_ok);
}

extern "C" napi_status napi_cancel_async_work(napi_env opaque_env, napi_async_work opaque_work)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    auto* work = reinterpret_cast<napi_async_work__*>(opaque_work);
    if (!env || !work || work->env != env)
        return invalid(env);
    if (work->state.load() != 1)
        return finish(env, napi_generic_failure);
    return finish(env, uv_cancel(reinterpret_cast<uv_req_t*>(&work->request)) == 0
        ? napi_ok
        : napi_generic_failure);
}

extern "C" napi_status napi_delete_async_work(napi_env opaque_env, napi_async_work opaque_work)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    auto* work = reinterpret_cast<napi_async_work__*>(opaque_work);
    if (!env || !work || work->env != env)
        return invalid(env);
    int state = work->state.load();
    if (state == 1 || state == 2)
        return finish(env, napi_generic_failure);
    work->delete_requested.store(true);
    if (state == 0 || state == 5) {
        napi_status context_status = napi_ok;
        if (work->async_context) {
            napi_async_context context = std::exchange(work->async_context, nullptr);
            context_status = napi_async_destroy(opaque_env, context);
        }
        std::lock_guard lock(env->async_mutex);
        env->async_work.erase(work);
        delete work;
        if (context_status != napi_ok)
            return context_status;
    }
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_uv_event_loop(napi_env opaque_env, uv_loop_s** result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    auto* loop = event_loop_for_env(env);
    if (!loop)
        return finish(env, napi_generic_failure);
    *result = loop;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_add_env_cleanup_hook(napi_env opaque_env, void (*callback)(void*), void* data)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !callback)
        return invalid(env);
    for (const auto& hook : env->cleanup_hooks) {
        if (hook.callback == callback && hook.data == data)
            std::abort();
    }
    env->cleanup_hooks.push_back({ callback, data, env->next_cleanup_order++ });
    return finish(env, napi_ok);
}

extern "C" napi_status napi_remove_env_cleanup_hook(napi_env opaque_env, void (*callback)(void*), void* data)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !callback)
        return invalid(env);
    for (auto iterator = env->cleanup_hooks.rbegin(); iterator != env->cleanup_hooks.rend(); ++iterator) {
        if (iterator->callback == callback && iterator->data == data) {
            env->cleanup_hooks.erase(std::next(iterator).base());
            return finish(env, napi_ok);
        }
    }
    return finish(env, napi_ok);
}

extern "C" napi_status napi_add_async_cleanup_hook(
    napi_env opaque_env,
    napi_async_cleanup_hook callback,
    void* data,
    napi_async_cleanup_hook_handle* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !callback)
        return invalid(env);
    auto* hook = new (std::nothrow) napi_async_cleanup_hook_handle__ {
        env, callback, data, env->next_cleanup_order++, false, false
    };
    if (!hook)
        return finish(env, napi_generic_failure);
    env->async_cleanup_hooks.push_back(hook);
    if (result)
        *result = reinterpret_cast<napi_async_cleanup_hook_handle>(hook);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_remove_async_cleanup_hook(napi_async_cleanup_hook_handle opaque_hook)
{
    auto* hook = reinterpret_cast<napi_async_cleanup_hook_handle__*>(opaque_hook);
    if (!hook || !hook->env)
        return napi_invalid_arg;
    NapiEnv* env = hook->env;
    if (hook->executing) {
        hook->removed = true;
        return finish(env, napi_ok);
    }
    if (hook->removed)
        return finish(env, napi_ok);
    hook->removed = true;
    auto iterator = std::find(env->async_cleanup_hooks.begin(), env->async_cleanup_hooks.end(), hook);
    if (iterator != env->async_cleanup_hooks.end())
        env->async_cleanup_hooks.erase(iterator);
    hook->env = nullptr;
    delete hook;
    return finish(env, napi_ok);
}

static std::string type_tag_key(NapiEnv* env)
{
    return env->wrap_key + "_type_tag";
}

extern "C" napi_status napi_type_tag_object(napi_env opaque_env, napi_value value, const napi_type_tag* tag)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef object = nullptr;
    napi_status status = require_object(env, value, &object);
    if (status != napi_ok || !tag)
        return status != napi_ok ? status : invalid(env);
    std::call_once(classes_once, initialize_classes);
    std::string key = type_tag_key(env);
    JSValueRef exception = nullptr;
    JSValueRef existing = get_property(env, object, key.c_str(), &exception);
    if (exception)
        return caught(env, exception);
    if (existing && JSValueIsObjectOfClass(env->context, existing, type_tag_class))
        return finish(env, napi_invalid_arg);
    auto* data = new (std::nothrow) NapiTypeTagData { tag->lower, tag->upper };
    if (!data)
        return finish(env, napi_generic_failure);
    JSObjectRef holder = JSObjectMake(env->context, type_tag_class, data);
    set_property(env, object, key.c_str(), holder, kJSPropertyAttributeDontEnum, &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_check_object_type_tag(napi_env opaque_env, napi_value value, const napi_type_tag* tag, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef object = nullptr;
    napi_status status = require_object(env, value, &object);
    if (status != napi_ok || !tag || !result)
        return status != napi_ok ? status : invalid(env);
    std::string key = type_tag_key(env);
    JSValueRef exception = nullptr;
    JSValueRef holder_value = get_property(env, object, key.c_str(), &exception);
    if (exception)
        return caught(env, exception);
    *result = false;
    if (holder_value && JSValueIsObjectOfClass(env->context, holder_value, type_tag_class)) {
        auto* data = static_cast<NapiTypeTagData*>(JSObjectGetPrivate(const_cast<JSObjectRef>(reinterpret_cast<const OpaqueJSValue*>(holder_value))));
        *result = data && data->lower == tag->lower && data->upper == tag->upper;
    }
    return finish(env, napi_ok);
}

static napi_status object_static_method(napi_env opaque_env, napi_value value, const char* method)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef object = nullptr;
    napi_status status = require_object(env, value, &object);
    if (status != napi_ok)
        return status;
    JSValueRef exception = nullptr;
    JSObjectRef constructor = global_constructor(env, "Object", &exception);
    JSValueRef argument = object;
    if (!exception && constructor)
        call_method(env, constructor, method, 1, &argument, &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_object_freeze(napi_env env, napi_value object)
{
    return object_static_method(env, object, "freeze");
}

extern "C" napi_status napi_object_seal(napi_env env, napi_value object)
{
    return object_static_method(env, object, "seal");
}

extern "C" napi_status napi_get_all_property_names(
    napi_env opaque_env,
    napi_value value,
    napi_key_collection_mode key_mode,
    napi_key_filter key_filter,
    napi_key_conversion key_conversion,
    napi_value* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef object = nullptr;
    napi_status status = require_object(env, value, &object);
    if (status != napi_ok || !result)
        return status != napi_ok ? status : invalid(env);
    static const char body[] =
        "const out=[]; const seen=new Set(); let cur=o;"
        "do { for (const key of Reflect.ownKeys(cur)) {"
        "if (seen.has(key)) continue; seen.add(key);"
        "const d=Object.getOwnPropertyDescriptor(cur,key);"
        "if ((filter&1)&&!d.writable) continue;"
        "if ((filter&2)&&!d.enumerable) continue;"
        "if ((filter&4)&&!d.configurable) continue;"
        "if ((filter&8)&&typeof key==='string') continue;"
        "if ((filter&16)&&typeof key==='symbol') continue;"
        "out.push(convert&&typeof key==='string'&&/^(0|[1-9][0-9]*)$/.test(key)?Number(key):key);"
        "} cur=Object.getPrototypeOf(cur); } while (includePrototype&&cur); return out;";
    JSStringRef parameter_names[] = {
        property_name("o"), property_name("includePrototype"), property_name("filter"), property_name("convert")
    };
    JSStringRef source = make_utf8_string(body, sizeof(body) - 1);
    JSStringRef name = property_name("getNapiPropertyNames");
    JSValueRef exception = nullptr;
    JSObjectRef function = JSObjectMakeFunction(env->context, name, 4, parameter_names, source, nullptr, 1, &exception);
    for (auto parameter : parameter_names)
        JSStringRelease(parameter);
    JSStringRelease(source);
    JSStringRelease(name);
    if (exception)
        return caught(env, exception);
    JSValueRef arguments[] = {
        object,
        JSValueMakeBoolean(env->context, key_mode == napi_key_include_prototypes),
        JSValueMakeNumber(env->context, key_filter),
        JSValueMakeBoolean(env->context, key_conversion == napi_key_keep_numbers),
    };
    JSValueRef names = JSObjectCallAsFunction(env->context, function, nullptr, 4, arguments, &exception);
    return exception ? caught(env, exception) : output(env, result, names);
}

extern "C" napi_status napi_detach_arraybuffer(napi_env opaque_env, napi_value value)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value)
        return invalid(env);
    JSValueRef exception = nullptr;
    if (!is_array_buffer(env, value, &exception))
        return exception ? caught(env, exception) : finish(env, napi_arraybuffer_expected);
    JSObjectRef array_buffer = as_object(env, value);
    JSValueRef transferred = call_method(env, array_buffer, "transfer", 0, nullptr, &exception);
    if (exception)
        return caught(env, exception);
    if (transferred)
        return finish(env, napi_ok);

    // COTTONTAIL-COMPAT: Stock JSC's public C API has no direct detach entry
    // point. Older JSC builds are adapted through the standard transfer list.
    JSObjectRef clone = global_constructor(env, "structuredClone", &exception);
    if (exception || !clone || !JSObjectIsFunction(env->context, clone))
        return finish(env, napi_detachable_arraybuffer_expected);
    JSValueRef transfer_items[] = { to_js(value) };
    JSObjectRef transfer = JSObjectMakeArray(env->context, 1, transfer_items, &exception);
    JSObjectRef options = JSObjectMake(env->context, nullptr, nullptr);
    if (!exception)
        set_property(env, options, "transfer", transfer, kJSPropertyAttributeNone, &exception);
    JSValueRef arguments[] = { to_js(value), options };
    if (!exception)
        JSObjectCallAsFunction(env->context, clone, nullptr, 2, arguments, &exception);
    return exception ? caught(env, exception) : finish(env, napi_ok);
}

extern "C" napi_status napi_is_detached_arraybuffer(napi_env opaque_env, napi_value value, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    check_basic_finalizer_safety(env);
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    if (!is_array_buffer(env, value, &exception))
        return exception ? caught(env, exception) : finish(env, napi_arraybuffer_expected);
    JSObjectRef array_buffer = as_object(env, value);
    if (is_logically_detached(env, array_buffer, &exception)) {
        *result = true;
        return finish(env, napi_ok);
    }
    if (exception)
        return caught(env, exception);
    JSValueRef detached = get_property(env, array_buffer, "detached", &exception);
    if (exception)
        return caught(env, exception);
    if (detached && JSValueIsBoolean(env->context, detached)) {
        *result = JSValueToBoolean(env->context, detached);
        return finish(env, napi_ok);
    }

    JSObjectRef constructor = global_constructor(env, "Uint8Array", &exception);
    JSValueRef argument = to_js(value);
    JSObjectRef view = exception || !constructor ? nullptr : JSObjectCallAsConstructor(env->context, constructor, 1, &argument, &exception);
    (void)view;
    *result = exception != nullptr;
    if (exception)
        exception = nullptr;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_create_threadsafe_function(
    napi_env opaque_env,
    napi_value function,
    napi_value resource,
    napi_value resource_name,
    size_t max_queue_size,
    size_t initial_thread_count,
    void* finalize_data,
    napi_finalize finalize_callback,
    void* context,
    napi_threadsafe_function_call_js call_js,
    napi_threadsafe_function* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !resource_name || !initial_thread_count || !result || (!function && !call_js))
        return invalid(env);
    if (function) {
        JSObjectRef callable = as_object(env, function);
        if (!callable || !JSObjectIsFunction(env->context, callable))
            return finish(env, napi_function_expected);
    }
    auto* threadsafe = new (std::nothrow) napi_threadsafe_function__;
    if (!threadsafe)
        return finish(env, napi_generic_failure);
    threadsafe->env = env;
    threadsafe->callback = function ? to_js(function) : nullptr;
    threadsafe->context = context;
    threadsafe->finalize_data = finalize_data;
    threadsafe->finalize_callback = finalize_callback;
    threadsafe->call_js = call_js;
    threadsafe->max_queue_size = max_queue_size;
    threadsafe->thread_count = initial_thread_count;
    napi_status context_status = napi_async_init(
        opaque_env,
        resource,
        resource_name,
        &threadsafe->async_context);
    if (context_status != napi_ok) {
        delete threadsafe;
        return context_status;
    }
    if (threadsafe->callback)
        JSValueProtect(env->context, threadsafe->callback);
    try {
        std::lock_guard lock(env->async_mutex);
        env->thread_safe_functions.insert(threadsafe);
    } catch (...) {
        if (threadsafe->callback)
            JSValueUnprotect(env->context, threadsafe->callback);
        napi_async_context async_context = std::exchange(threadsafe->async_context, nullptr);
        (void)napi_async_destroy(opaque_env, async_context);
        delete threadsafe;
        return finish(env, napi_generic_failure);
    }
    *result = reinterpret_cast<napi_threadsafe_function>(threadsafe);
    wake(env);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_threadsafe_function_context(napi_threadsafe_function opaque_function, void** result)
{
    auto* function = reinterpret_cast<napi_threadsafe_function__*>(opaque_function);
    if (!function || !result)
        return napi_invalid_arg;
    *result = function->context;
    return napi_ok;
}

extern "C" napi_status napi_call_threadsafe_function(
    napi_threadsafe_function opaque_function,
    void* data,
    napi_threadsafe_function_call_mode mode
)
{
    auto* function = reinterpret_cast<napi_threadsafe_function__*>(opaque_function);
    if (!function)
        return napi_invalid_arg;
    std::unique_lock lock(function->mutex);
    if (function->closing) {
        if (!function->thread_count)
            return napi_invalid_arg;
        --function->thread_count;
        const bool delete_now = function->teardown_complete && function->thread_count == 0;
        lock.unlock();
        if (delete_now)
            delete function;
        return napi_closing;
    }
    NapiEnv* env = function->env;
    if (!env)
        return napi_invalid_arg;
    auto full = [function] {
        return function->max_queue_size && function->queue.size() >= function->max_queue_size;
    };
    if (full()) {
        if (mode == napi_tsfn_nonblocking)
            return napi_queue_full;
        if (std::this_thread::get_id() == function->env->owner_thread)
            return napi_would_deadlock;
        function->space_available.wait(lock, [function, full] { return function->closing || !full(); });
        if (function->closing) {
            if (!function->thread_count)
                return napi_invalid_arg;
            --function->thread_count;
            const bool delete_now = function->teardown_complete && function->thread_count == 0;
            lock.unlock();
            if (delete_now)
                delete function;
            return napi_closing;
        }
    }
    function->queue.push_back({ data });
    lock.unlock();
    wake(env);
    return napi_ok;
}

extern "C" napi_status napi_acquire_threadsafe_function(napi_threadsafe_function opaque_function)
{
    auto* function = reinterpret_cast<napi_threadsafe_function__*>(opaque_function);
    if (!function)
        return napi_invalid_arg;
    std::lock_guard lock(function->mutex);
    if (function->closing)
        return napi_closing;
    ++function->thread_count;
    return napi_ok;
}

extern "C" napi_status napi_release_threadsafe_function(
    napi_threadsafe_function opaque_function,
    napi_threadsafe_function_release_mode mode
)
{
    auto* function = reinterpret_cast<napi_threadsafe_function__*>(opaque_function);
    if (!function)
        return napi_invalid_arg;
    NapiEnv* env = nullptr;
    bool delete_now = false;
    {
        std::lock_guard lock(function->mutex);
        if (!function->thread_count)
            return napi_invalid_arg;
        if (mode == napi_tsfn_abort) {
            function->aborting = true;
            function->closing = true;
        }
        --function->thread_count;
        if (!function->thread_count)
            function->closing = true;
        env = function->env;
        delete_now = function->teardown_complete && function->thread_count == 0;
    }
    function->space_available.notify_all();
    if (delete_now)
        delete function;
    else if (env)
        wake(env);
    return napi_ok;
}

extern "C" napi_status napi_unref_threadsafe_function(napi_env opaque_env, napi_threadsafe_function opaque_function)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    auto* function = reinterpret_cast<napi_threadsafe_function__*>(opaque_function);
    if (!env || !function || function->env != env)
        return invalid(env);
    std::lock_guard lock(function->mutex);
    function->referenced = false;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_ref_threadsafe_function(napi_env opaque_env, napi_threadsafe_function opaque_function)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    auto* function = reinterpret_cast<napi_threadsafe_function__*>(opaque_function);
    if (!env || !function || function->env != env)
        return invalid(env);
    std::lock_guard lock(function->mutex);
    if (function->closing)
        return finish(env, napi_closing);
    function->referenced = true;
    return finish(env, napi_ok);
}

extern "C" bool ct_napi_env_has_pending_work(CtNapiEnv* opaque_env)
{
    auto* root = root_env(static_cast<NapiEnv*>(opaque_env));
    if (!root)
        return false;
    {
        std::lock_guard lock(root->async_mutex);
        if (!root->completed_work.empty())
            return true;
    }

    auto has_pending_for_env = [](NapiEnv* env) {
        std::vector<napi_threadsafe_function__*> thread_safe_functions;
        {
            std::lock_guard lock(env->async_mutex);
            if (!env->basic_finalizers.empty() || !env->posted_finalizers.empty())
                return true;
            for (auto* work : env->async_work) {
                const int state = work->state.load();
                if (state == 1 || state == 2)
                    return true;
            }
            thread_safe_functions.assign(env->thread_safe_functions.begin(), env->thread_safe_functions.end());
        }
        for (auto* function : thread_safe_functions) {
            std::lock_guard lock(function->mutex);
            if (function->referenced && !function->finalized)
                return true;
        }
        return false;
    };

    if (has_pending_for_env(root))
        return true;
    for (auto* env : root->addon_envs) {
        if (has_pending_for_env(env))
            return true;
    }
    return false;
}

static bool take_pending_exception(NapiEnv* env, JSValueRef* exception)
{
    if (!env->pending_exception)
        return false;
    *exception = env->pending_exception;
    JSValueUnprotect(env->context, env->pending_exception);
    env->pending_exception = nullptr;
    return true;
}

static bool drain_finalizer_queue(NapiEnv* env, bool basic, JSValueRef* exception)
{
    ActiveEnvScope active_scope(env);
    std::deque<NapiPostedFinalizer> finalizers;
    {
        std::lock_guard lock(env->async_mutex);
        finalizers.swap(basic ? env->basic_finalizers : env->posted_finalizers);
    }
    while (!finalizers.empty()) {
        NapiPostedFinalizer finalizer = finalizers.front();
        finalizers.pop_front();
        BasicFinalizerScope finalizer_scope(env, basic, finalizer.is_finalizer);
        AutomaticScope scope(env);
        if (finalizer.callback)
            finalizer.callback(reinterpret_cast<napi_env>(env), finalizer.data, finalizer.hint);
        if (take_pending_exception(env, exception)) {
            std::lock_guard lock(env->async_mutex);
            auto& queue = basic ? env->basic_finalizers : env->posted_finalizers;
            while (!finalizers.empty()) {
                queue.push_front(finalizers.back());
                finalizers.pop_back();
            }
            return false;
        }
    }
    return true;
}

static bool drain_completed_work(NapiEnv* root, JSValueRef* exception)
{
    std::deque<napi_async_work__*> completed;
    {
        std::lock_guard lock(root->async_mutex);
        completed.swap(root->completed_work);
    }
    while (!completed.empty()) {
        napi_async_work__* work = completed.front();
        completed.pop_front();
        NapiEnv* env = work->env;
        ActiveEnvScope active_scope(env);
        AutomaticScope scope(env);
        napi_status status = work->state.load() == 4 ? napi_cancelled : napi_ok;
        napi_callback_scope callback_scope = nullptr;
        if (work->complete && work->async_context)
            (void)napi_open_callback_scope(
                reinterpret_cast<napi_env>(env),
                nullptr,
                work->async_context,
                &callback_scope);
        if (work->complete)
            work->complete(reinterpret_cast<napi_env>(env), status, work->data);
        if (callback_scope)
            (void)napi_close_callback_scope(reinterpret_cast<napi_env>(env), callback_scope);
        if (work->async_context) {
            napi_async_context context = std::exchange(work->async_context, nullptr);
            (void)napi_async_destroy(reinterpret_cast<napi_env>(env), context);
        }
        work->state.store(5);
        if (work->delete_requested.load()) {
            std::lock_guard lock(env->async_mutex);
            env->async_work.erase(work);
            delete work;
        }
        if (take_pending_exception(env, exception)) {
            std::lock_guard lock(root->async_mutex);
            while (!completed.empty()) {
                root->completed_work.push_front(completed.back());
                completed.pop_back();
            }
            return false;
        }
    }
    return true;
}

static bool drain_threadsafe_functions(NapiEnv* env, JSValueRef* exception)
{
    ActiveEnvScope active_scope(env);
    constexpr size_t max_dispatch_iterations = 999;
    std::vector<napi_threadsafe_function__*> thread_safe_functions;
    {
        std::lock_guard lock(env->async_mutex);
        thread_safe_functions.assign(env->thread_safe_functions.begin(), env->thread_safe_functions.end());
    }
    for (auto* function : thread_safe_functions) {
        size_t dispatch_iterations = 0;
        bool dispatched_call = false;
        for (;;) {
            JSValueRef exit_exception = nullptr;
            if (process_is_exiting(env, &exit_exception)) {
                {
                    std::lock_guard lock(function->mutex);
                    function->closing = true;
                    function->aborting = true;
                    function->referenced = false;
                }
                function->space_available.notify_all();
                break;
            }
            if (exit_exception) {
                *exception = exit_exception;
                return false;
            }

            NapiTsfnCall call;
            bool has_call = false;
            bool should_finalize = false;
            {
                std::lock_guard lock(function->mutex);
                if (!function->queue.empty()) {
                    call = function->queue.front();
                    function->queue.pop_front();
                    has_call = true;
                }
                should_finalize = function->closing && function->queue.empty() && !function->thread_count && !function->finalized;
            }
            function->space_available.notify_all();
            if (should_finalize && dispatched_call) {
                wake(env);
                break;
            }
            if (has_call) {
                if (function->aborting) {
                    if (function->call_js)
                        function->call_js(nullptr, nullptr, function->context, call.data);
                } else {
                    AutomaticScope scope(env);
                    napi_callback_scope callback_scope = nullptr;
                    napi_status scope_status = function->async_context
                        ? napi_open_callback_scope(
                            reinterpret_cast<napi_env>(env),
                            nullptr,
                            function->async_context,
                            &callback_scope)
                        : napi_ok;
                    if (scope_status == napi_ok) {
                        if (function->call_js) {
                            function->call_js(reinterpret_cast<napi_env>(env), to_napi(function->callback), function->context, call.data);
                        } else if (function->callback) {
                            napi_value global = nullptr;
                            napi_get_global(reinterpret_cast<napi_env>(env), &global);
                            napi_call_function(reinterpret_cast<napi_env>(env), global, to_napi(function->callback), 0, nullptr, nullptr);
                        }
                    }
                    if (callback_scope) {
                        napi_status close_status = napi_close_callback_scope(
                            reinterpret_cast<napi_env>(env),
                            callback_scope);
                        if (scope_status == napi_ok)
                            scope_status = close_status;
                    }
                    if (scope_status != napi_ok && !env->pending_exception) {
                        (void)napi_throw_error(
                            reinterpret_cast<napi_env>(env),
                            nullptr,
                            "failed to enter the thread-safe function async context");
                    }
                }
                if (take_pending_exception(env, exception))
                    return false;
                dispatched_call = true;
            }
            if (should_finalize) {
                {
                    std::lock_guard lock(function->mutex);
                    function->finalized = true;
                }
                if (function->finalize_callback) {
                    AutomaticScope scope(env);
                    function->finalize_callback(reinterpret_cast<napi_env>(env), function->finalize_data, function->context);
                }
                napi_status context_status = napi_ok;
                if (function->async_context) {
                    napi_async_context context = std::exchange(function->async_context, nullptr);
                    context_status = napi_async_destroy(reinterpret_cast<napi_env>(env), context);
                }
                if (function->callback)
                    JSValueUnprotect(env->context, function->callback);
                {
                    std::lock_guard lock(env->async_mutex);
                    env->thread_safe_functions.erase(function);
                }
                delete function;
                if (context_status != napi_ok && !env->pending_exception) {
                    (void)napi_throw_error(
                        reinterpret_cast<napi_env>(env),
                        nullptr,
                        "failed to destroy the thread-safe function async context");
                }
                if (take_pending_exception(env, exception))
                    return false;
                break;
            }
            if (has_call && ++dispatch_iterations >= max_dispatch_iterations) {
                wake(env);
                break;
            }
            if (!has_call)
                break;
        }
    }
    return true;
}

extern "C" void ct_napi_env_drain(CtNapiEnv* opaque_env, JSValueRef* exception)
{
    auto* root = root_env(static_cast<NapiEnv*>(opaque_env));
    if (exception)
        *exception = nullptr;
    if (!root || !exception)
        return;
    MicrotaskDelayScope microtasks(root->context);

    if (!drain_completed_work(root, exception))
        return;
    if (!drain_finalizer_queue(root, true, exception) || !drain_finalizer_queue(root, false, exception)
        || !drain_threadsafe_functions(root, exception))
        return;
    for (auto* env : root->addon_envs) {
        if (!drain_finalizer_queue(env, true, exception) || !drain_finalizer_queue(env, false, exception)
            || !drain_threadsafe_functions(env, exception))
            return;
    }
}

extern "C" void ct_napi_env_drain_gc(CtNapiEnv* opaque_env, JSValueRef* exception)
{
    auto* root = root_env(static_cast<NapiEnv*>(opaque_env));
    if (exception)
        *exception = nullptr;
    if (!root || !exception)
        return;
    MicrotaskDelayScope microtasks(root->context);
    if (!drain_finalizer_queue(root, true, exception))
        return;
    for (auto* env : root->addon_envs) {
        if (!drain_finalizer_queue(env, true, exception))
            return;
    }
}
