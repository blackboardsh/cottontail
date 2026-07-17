#include "napi_bridge.h"

#include "compiler/src/napi/node_api.h"

#include <JavaScriptCore/JSTypedArray.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <limits>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <dlfcn.h>

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
    uint64_t id { 0 };
};

struct napi_callback_scope__ {
    NapiEnv* env { nullptr };
};

struct napi_async_work__ {
    NapiEnv* env { nullptr };
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

struct napi_threadsafe_function__ {
    NapiEnv* env { nullptr };
    JSValueRef callback { nullptr };
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
};

struct NapiEnv {
    NapiEnv* runtime_root { nullptr };
    JSGlobalContextRef context { nullptr };
    void* wake_opaque { nullptr };
    CtNapiWakeCallback wake_callback { nullptr };
    napi_extended_error_info last_error {};
    JSValueRef pending_exception { nullptr };
    napi_handle_scope__* current_scope { nullptr };
    std::unordered_set<napi_ref__*> references;
    std::unordered_set<NapiFinalizerData*> finalizers;
    std::unordered_set<NapiBufferFinalizer*> buffer_finalizers;
    std::unordered_set<napi_async_work__*> async_work;
    std::unordered_set<napi_threadsafe_function__*> thread_safe_functions;
    std::vector<NapiCleanupHook> cleanup_hooks;
    std::vector<napi_async_cleanup_hook_handle__*> async_cleanup_hooks;
    std::mutex async_mutex;
    std::condition_variable async_condition;
    std::deque<napi_async_work__*> pending_work;
    std::deque<napi_async_work__*> completed_work;
    std::deque<NapiPostedFinalizer> basic_finalizers;
    std::deque<NapiPostedFinalizer> posted_finalizers;
    std::vector<std::thread> worker_threads;
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
    std::string wrap_key;
    uint64_t finalizer_key { 1 };
    std::thread::id owner_thread;
    bool stop_workers { false };
    bool destroying { false };
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

static thread_local NapiEnv* loading_env;
static thread_local napi_module* loading_module;

struct RegisteredModule {
    napi_addon_register_func callback { nullptr };
    int version { NAPI_VERSION };
};

static std::mutex registered_modules_mutex;
static std::unordered_map<std::string, RegisteredModule> registered_modules;

static JSClassRef function_class;
static JSClassRef external_class;
static JSClassRef finalizer_class;
static JSClassRef type_tag_class;
static std::once_flag classes_once;

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
    if (length == NAPI_AUTO_LENGTH)
        length = std::strlen(bytes);

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
    std::fflush(stderr);
    std::abort();
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
    BasicFinalizerScope(NapiEnv* env, bool active)
        : m_env(env)
        , m_previous(env->in_basic_finalizer)
    {
        if (active)
            env->in_basic_finalizer = true;
    }

    ~BasicFinalizerScope()
    {
        m_env->in_basic_finalizer = m_previous;
    }

private:
    NapiEnv* m_env;
    bool m_previous;
};

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

    JSStringRef factory_name = JSStringCreateWithUTF8CString("createNapiFunction");
    JSStringRef parameter = JSStringCreateWithUTF8CString("dispatch");
    JSStringRef body = JSStringCreateWithUTF8CString(
        "\"use strict\"; return function(...args) { return dispatch(this, new.target, args); };"
    );
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

} // namespace

static void napi_worker_loop(NapiEnv* root)
{
    for (;;) {
        napi_async_work__* work = nullptr;
        {
            std::unique_lock lock(root->async_mutex);
            root->async_condition.wait(lock, [root] { return root->stop_workers || !root->pending_work.empty(); });
            if (root->stop_workers && root->pending_work.empty())
                return;
            work = root->pending_work.front();
            root->pending_work.pop_front();
        }
        int expected = 1;
        if (work->state.compare_exchange_strong(expected, 2)) {
            if (work->execute)
                work->execute(reinterpret_cast<napi_env>(work->env), work->data);
            work->state.store(3);
        }
        {
            std::lock_guard lock(root->async_mutex);
            root->completed_work.push_back(work);
        }
        wake(work->env);
    }
}

static NapiEnv* allocate_env(
    JSGlobalContextRef context,
    void* wake_opaque,
    CtNapiWakeCallback wake_callback,
    NapiEnv* root
)
{
    auto* env = new (std::nothrow) NapiEnv;
    if (!env)
        return nullptr;
    env->runtime_root = root ? root : env;
    env->context = context;
    env->wake_opaque = wake_opaque;
    env->wake_callback = wake_callback;
    env->owner_thread = std::this_thread::get_id();
    char key[96];
    std::snprintf(key, sizeof(key), "__cottontail_napi_wrap_%p", static_cast<void*>(env));
    env->wrap_key = key;
    finish(env, napi_ok);
    return env;
}

extern "C" CtNapiEnv* ct_napi_env_create(
    JSGlobalContextRef context,
    void* wake_opaque,
    CtNapiWakeCallback wake_callback
)
{
    if (!context)
        return nullptr;
    auto* env = allocate_env(context, wake_opaque, wake_callback, nullptr);
    if (!env)
        return nullptr;
    try {
        for (size_t index = 0; index < 4; ++index)
            env->worker_threads.emplace_back(napi_worker_loop, env);
    } catch (...) {
        {
            std::lock_guard lock(env->async_mutex);
            env->stop_workers = true;
        }
        env->async_condition.notify_all();
        for (auto& worker : env->worker_threads) {
            if (worker.joinable())
                worker.join();
        }
        delete env;
        return nullptr;
    }
    return env;
}

static void destroy_single_env(NapiEnv* env)
{
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
            env->async_cleanup_hooks.erase(async);
            hook->executing = true;
            if (!hook->removed && hook->callback)
                hook->callback(reinterpret_cast<napi_async_cleanup_hook_handle>(hook), hook->data);
            hook->executing = false;
            hook->removed = true;
            delete hook;
        } else {
            NapiCleanupHook hook = *sync;
            env->cleanup_hooks.erase(sync);
            if (hook.callback)
                hook.callback(hook.data);
        }
    }

    if (env->instance_finalizer) {
        auto callback = env->instance_finalizer;
        env->instance_finalizer = nullptr;
        callback(reinterpret_cast<napi_env>(env), env->instance_data, env->instance_hint);
    }

    auto finalizers = env->finalizers;
    for (auto* finalizer : finalizers) {
        invalidate_wrap_reference(finalizer);
        run_finalizer(finalizer);
        finalizer->env = nullptr;
    }
    env->finalizers.clear();

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
            if (finalizer.callback)
                finalizer.callback(reinterpret_cast<napi_env>(env), finalizer.data, finalizer.hint);
        }
    }

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

    auto thread_safe_functions = env->thread_safe_functions;
    for (auto* function : thread_safe_functions) {
        if (function->callback)
            JSValueUnprotect(env->context, function->callback);
        if (!function->finalized && function->finalize_callback)
            function->finalize_callback(reinterpret_cast<napi_env>(env), function->finalize_data, function->context);
        delete function;
    }
    env->thread_safe_functions.clear();

    if (env->pending_exception)
        JSValueUnprotect(env->context, env->pending_exception);
    delete env;
}

extern "C" CtNapiEnv* ct_napi_env_for_ffi_library(CtNapiEnv* opaque_env, const char* identity)
{
    auto* root = root_env(static_cast<NapiEnv*>(opaque_env));
    if (!root || !identity)
        return nullptr;
    auto existing = root->ffi_envs.find(identity);
    if (existing != root->ffi_envs.end())
        return existing->second;

    auto* env = allocate_env(root->context, root->wake_opaque, root->wake_callback, root);
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
    if (!root)
        return;

    root->destroying = true;
    for (auto* env : root->addon_envs)
        env->destroying = true;
    {
        std::lock_guard lock(root->async_mutex);
        root->stop_workers = true;
    }
    root->async_condition.notify_all();
    for (auto& worker : root->worker_threads) {
        if (worker.joinable())
            worker.join();
    }

    for (auto iterator = root->addon_envs.rbegin(); iterator != root->addon_envs.rend(); ++iterator)
        destroy_single_env(*iterator);
    root->addon_envs.clear();
    root->ffi_envs.clear();
    destroy_single_env(root);
}

extern "C" void napi_module_register(napi_module* module)
{
    if (!module)
        return;
    loading_module = module;
    if (loading_env && !loading_env->module_filename.empty() && module->nm_register_func) {
        std::lock_guard lock(registered_modules_mutex);
        registered_modules[loading_env->module_filename] = { module->nm_register_func, module->nm_version };
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
    if (!root || !path || !exception)
        return nullptr;

    auto* env = allocate_env(root->context, root->wake_opaque, root->wake_callback, root);
    if (!env) {
        *exception = make_loader_error(root, "failed to allocate a Node-API environment");
        return nullptr;
    }
    env->module_filename = path_to_file_uri(path);
    loading_env = env;
    loading_module = nullptr;
    dlerror();
    void* handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    const char* open_error = handle ? nullptr : dlerror();
    loading_env = nullptr;
    if (!handle) {
        *exception = make_loader_error(env, std::string("dlopen(") + path + ") failed: " + (open_error ? open_error : "unknown error"));
        destroy_single_env(env);
        return nullptr;
    }

    using RegisterFunction = napi_value (*)(napi_env, napi_value);
    using ApiVersionFunction = int32_t (*)();
    auto* direct_register = reinterpret_cast<RegisterFunction>(dlsym(handle, "napi_register_module_v1"));
    auto* get_api_version = reinterpret_cast<ApiVersionFunction>(dlsym(handle, "node_api_module_get_api_version_v1"));
    env->module_api_version = get_api_version ? get_api_version() : 8;
    napi_addon_register_func register_callback = direct_register;
    if (!register_callback && loading_module)
        register_callback = loading_module->nm_register_func;
    if (!register_callback) {
        std::lock_guard lock(registered_modules_mutex);
        auto iterator = registered_modules.find(env->module_filename);
        if (iterator != registered_modules.end())
            register_callback = iterator->second.callback;
    }
    if (!register_callback) {
        if (loading_module && !loading_module->nm_register_func)
            *exception = make_loader_error(env, "Module has no declared entry point.");
        else
            *exception = make_loader_error(env, std::string("Native addon ") + path + " does not export a Node-API module initializer");
        destroy_single_env(env);
        dlclose(handle);
        return nullptr;
    }

    root->addon_envs.push_back(env);
    if (!exports)
        exports = JSObjectMake(env->context, nullptr, nullptr);
    AutomaticScope scope(env);
    napi_value result = register_callback(reinterpret_cast<napi_env>(env), to_napi(exports));
    if (env->pending_exception) {
        *exception = env->pending_exception;
        JSValueUnprotect(env->context, env->pending_exception);
        env->pending_exception = nullptr;
        return nullptr;
    }
    return result ? to_js(result) : exports;
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
    if (result)
        *result = buffer ? std::min(bytes, buffer_size ? buffer_size - 1 : 0) : bytes;
    if (buffer && buffer_size) {
        size_t copied = std::min(bytes, buffer_size - 1);
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
    if (!env || !value || !result)
        return invalid(env);
    JSValueRef exception = nullptr;
    JSStringRef string = JSValueToStringCopy(env->context, to_js(value), &exception);
    if (exception)
        return caught(env, exception);
    napi_status status = output(env, result, JSValueMakeString(env->context, string));
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
    napi_status status = require_object(env, object, &target);
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
    napi_status status = require_object(env, object, &target);
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
    napi_status status = require_object(env, object, &target);
    if (status != napi_ok || !key || !result)
        return status != napi_ok ? status : invalid(env);
    JSValueRef exception = nullptr;
    JSValueRef value = JSObjectGetPropertyForKey(env->context, target, to_js(key), &exception);
    return exception ? caught(env, exception) : output(env, result, value);
}

extern "C" napi_status napi_delete_property(napi_env opaque_env, napi_value object, napi_value key, bool* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef target = nullptr;
    napi_status status = require_object(env, object, &target);
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
    JSObjectRef target = nullptr;
    napi_status status = require_object(env, object, &target);
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
    JSObjectRef target = nullptr;
    napi_status status = require_object(env, object, &target);
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
    napi_status status = require_object(env, object, &target);
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
    JSObjectRef target = nullptr;
    napi_status status = require_object(env, object, &target);
    if (status != napi_ok || !name || !result)
        return status != napi_ok ? status : invalid(env);
    JSValueRef exception = nullptr;
    JSValueRef value = get_property(env, target, name, &exception);
    return exception ? caught(env, exception) : output(env, result, value);
}

extern "C" napi_status napi_set_element(napi_env opaque_env, napi_value object, uint32_t index, napi_value value)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    JSObjectRef target = nullptr;
    napi_status status = require_object(env, object, &target);
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
    napi_status status = require_object(env, object, &target);
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
    if (!env || !callback || !result)
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
    if (!env || !receiver || !function || (argc && !argv))
        return invalid(env);
    JSObjectRef callable = as_object(env, function);
    if (!callable || !JSObjectIsFunction(env->context, callable))
        return finish(env, napi_function_expected);
    std::vector<JSValueRef> arguments(argc);
    for (size_t index = 0; index < argc; ++index)
        arguments[index] = to_js(argv[index]);
    JSValueRef exception = nullptr;
    JSObjectRef arguments_array = JSObjectMakeArray(env->context, argc, arguments.data(), &exception);
    JSObjectRef reflect = exception ? nullptr : global_constructor(env, "Reflect", &exception);
    JSValueRef apply_arguments[] = { callable, to_js(receiver), arguments_array };
    JSValueRef returned = exception || !reflect ? nullptr : call_method(env, reflect, "apply", 3, apply_arguments, &exception);
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
    JSObjectRef target = nullptr;
    napi_status status = require_object(env, object, &target);
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
    check_basic_finalizer_safety(env);
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

extern "C" napi_status napi_fatal_exception(napi_env opaque_env, napi_value error)
{
    return napi_throw(opaque_env, error);
}

extern "C" void napi_fatal_error(const char* location, size_t location_length, const char* message, size_t message_length)
{
    if (location) {
        if (location_length == NAPI_AUTO_LENGTH)
            location_length = std::strlen(location);
        std::fwrite(location, 1, location_length, stderr);
        std::fputs(": ", stderr);
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

static NapiFinalizerData* wrapped_finalizer(NapiEnv* env, JSObjectRef object, const char* key, JSValueRef* exception)
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
    if (wrapped_finalizer(env, object, key, &exception))
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
    status = attach_finalizer(env, target, env->wrap_key.c_str(), native_object, finalize_callback, finalize_hint, false);
    if (status != napi_ok)
        return status;
    if (result) {
        status = napi_create_reference(opaque_env, object, 0, result);
        if (status != napi_ok)
            return status;
        JSValueRef exception = nullptr;
        auto* finalizer = wrapped_finalizer(env, target, env->wrap_key.c_str(), &exception);
        if (exception)
            return caught(env, exception);
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
    auto* finalizer = wrapped_finalizer(env, target, env->wrap_key.c_str(), &exception);
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
    auto* finalizer = wrapped_finalizer(env, target, env->wrap_key.c_str(), &exception);
    if (exception)
        return caught(env, exception);
    if (!finalizer)
        return finish(env, napi_invalid_arg);
    if (result)
        *result = finalizer->data;
    finalizer->active = false;
    invalidate_wrap_reference(finalizer);
    JSStringRef key = property_name(env->wrap_key.c_str());
    JSObjectDeleteProperty(env->context, target, key, &exception);
    JSStringRelease(key);
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
        env->posted_finalizers.push_back({ finalize_callback, finalize_data, finalize_hint });
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
    JSObjectRef buffer_constructor = global_constructor(env, "Buffer", exception);
    if (*exception || !buffer_constructor)
        return false;
    JSValueRef argument = to_js(value);
    JSValueRef result = call_method(env, buffer_constructor, "isBuffer", 1, &argument, exception);
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
    JSObjectRef array_buffer = JSObjectMakeArrayBufferWithBytesNoCopy(env->context, external_data, byte_length, buffer_deallocator, finalizer, &exception);
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
    if (!env || !data || !result)
        return invalid(env);
    auto* finalizer = new (std::nothrow) NapiBufferFinalizer { env, data, finalize_hint, finalize_callback, false, false };
    if (!finalizer)
        return finish(env, napi_generic_failure);
    {
        std::lock_guard lock(env->async_mutex);
        env->buffer_finalizers.insert(finalizer);
    }
    JSValueRef exception = nullptr;
    JSObjectRef buffer = JSObjectMakeTypedArrayWithBytesNoCopy(env->context, kJSTypedArrayTypeUint8Array, data, length, buffer_deallocator, finalizer, &exception);
    if (exception)
        return caught(env, exception);
    apply_buffer_prototype(env, buffer, &exception);
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
    static const napi_node_version version { 24, 0, 0, "node" };
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
    if (!env || !result || !words || (sign_bit != 0 && sign_bit != 1))
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
    napi_env env,
    char* value,
    size_t length,
    napi_finalize,
    void*,
    napi_value* result,
    bool* copied
)
{
    // COTTONTAIL-COMPAT: Stock JSC's public C API cannot adopt external string
    // storage. Report the spec-defined copied fallback instead of claiming
    // zero-copy ownership while retaining caller memory.
    if (copied)
        *copied = true;
    return napi_create_string_latin1(env, value, length, result);
}

extern "C" napi_status node_api_create_external_string_utf16(
    napi_env env,
    char16_t* value,
    size_t length,
    napi_finalize,
    void*,
    napi_value* result,
    bool* copied
)
{
    // COTTONTAIL-COMPAT: See node_api_create_external_string_latin1 above.
    if (copied)
        *copied = true;
    return napi_create_string_utf16(env, value, length, result);
}

extern "C" napi_status napi_async_init(napi_env opaque_env, napi_value, napi_value resource_name, napi_async_context* result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !resource_name || !result)
        return invalid(env);
    auto* context = new (std::nothrow) napi_async_context__ { env->next_async_id++ };
    if (!context)
        return finish(env, napi_generic_failure);
    *result = reinterpret_cast<napi_async_context>(context);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_async_destroy(napi_env opaque_env, napi_async_context opaque_context)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !opaque_context)
        return invalid(env);
    delete reinterpret_cast<napi_async_context__*>(opaque_context);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_make_callback(
    napi_env env,
    napi_async_context,
    napi_value receiver,
    napi_value function,
    size_t argc,
    const napi_value* argv,
    napi_value* result
)
{
    return napi_call_function(env, receiver, function, argc, argv, result);
}

extern "C" napi_status napi_open_callback_scope(
    napi_env opaque_env,
    napi_value,
    napi_async_context,
    napi_callback_scope* result
)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    auto* scope = new (std::nothrow) napi_callback_scope__ { env };
    if (!scope)
        return finish(env, napi_generic_failure);
    *result = reinterpret_cast<napi_callback_scope>(scope);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_close_callback_scope(napi_env opaque_env, napi_callback_scope opaque_scope)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    auto* scope = reinterpret_cast<napi_callback_scope__*>(opaque_scope);
    if (!env || !scope || scope->env != env)
        return finish(env, napi_callback_scope_mismatch);
    delete scope;
    return finish(env, napi_ok);
}

extern "C" napi_status napi_create_async_work(
    napi_env opaque_env,
    napi_value,
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
    {
        std::lock_guard lock(env->async_mutex);
        env->async_work.insert(work);
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
    int expected = 0;
    if (!work->state.compare_exchange_strong(expected, 1))
        return finish(env, napi_generic_failure);
    NapiEnv* root = root_env(env);
    {
        std::lock_guard lock(root->async_mutex);
        root->pending_work.push_back(work);
    }
    root->async_condition.notify_one();
    wake(env);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_cancel_async_work(napi_env opaque_env, napi_async_work opaque_work)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    auto* work = reinterpret_cast<napi_async_work__*>(opaque_work);
    if (!env || !work || work->env != env)
        return invalid(env);
    int expected = 1;
    if (!work->state.compare_exchange_strong(expected, 4))
        return finish(env, napi_generic_failure);
    root_env(env)->async_condition.notify_all();
    return finish(env, napi_ok);
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
        std::lock_guard lock(env->async_mutex);
        env->async_work.erase(work);
        delete work;
    }
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_uv_event_loop(napi_env opaque_env, uv_loop_s** result)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !result)
        return invalid(env);
    // COTTONTAIL-COMPAT: Cottontail does not currently embed a libuv loop. A
    // fabricated uv_loop_t would let addons load and then corrupt native state.
    *result = nullptr;
    return finish(env, napi_generic_failure);
}

extern "C" napi_status napi_add_env_cleanup_hook(napi_env opaque_env, void (*callback)(void*), void* data)
{
    auto* env = reinterpret_cast<NapiEnv*>(opaque_env);
    if (!env || !callback)
        return invalid(env);
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
    if (!env || !callback || !result)
        return invalid(env);
    auto* hook = new (std::nothrow) napi_async_cleanup_hook_handle__ {
        env, callback, data, env->next_cleanup_order++, false, false
    };
    if (!hook)
        return finish(env, napi_generic_failure);
    env->async_cleanup_hooks.push_back(hook);
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
    napi_value,
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
    if (threadsafe->callback)
        JSValueProtect(env->context, threadsafe->callback);
    {
        std::lock_guard lock(env->async_mutex);
        env->thread_safe_functions.insert(threadsafe);
    }
    *result = reinterpret_cast<napi_threadsafe_function>(threadsafe);
    wake(env);
    return finish(env, napi_ok);
}

extern "C" napi_status napi_get_threadsafe_function_context(napi_threadsafe_function opaque_function, void** result)
{
    auto* function = reinterpret_cast<napi_threadsafe_function__*>(opaque_function);
    if (!function || !function->env || !result)
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
    if (!function || !function->env)
        return napi_invalid_arg;
    std::unique_lock lock(function->mutex);
    if (function->closing)
        return napi_closing;
    auto full = [function] {
        return function->max_queue_size && function->queue.size() >= function->max_queue_size;
    };
    if (full()) {
        if (mode == napi_tsfn_nonblocking)
            return napi_queue_full;
        if (std::this_thread::get_id() == function->env->owner_thread)
            return napi_would_deadlock;
        function->space_available.wait(lock, [function, full] { return function->closing || !full(); });
        if (function->closing)
            return napi_closing;
    }
    function->queue.push_back({ data });
    lock.unlock();
    wake(function->env);
    return napi_ok;
}

extern "C" napi_status napi_acquire_threadsafe_function(napi_threadsafe_function opaque_function)
{
    auto* function = reinterpret_cast<napi_threadsafe_function__*>(opaque_function);
    if (!function || !function->env)
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
    if (!function || !function->env)
        return napi_invalid_arg;
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
    }
    function->space_available.notify_all();
    wake(function->env);
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
        if (!root->completed_work.empty() || !root->pending_work.empty())
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
            if ((function->referenced && !function->finalized) || !function->queue.empty())
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
    std::deque<NapiPostedFinalizer> finalizers;
    {
        std::lock_guard lock(env->async_mutex);
        finalizers.swap(basic ? env->basic_finalizers : env->posted_finalizers);
    }
    while (!finalizers.empty()) {
        NapiPostedFinalizer finalizer = finalizers.front();
        finalizers.pop_front();
        BasicFinalizerScope finalizer_scope(env, basic);
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
        AutomaticScope scope(env);
        napi_status status = work->state.load() == 4 ? napi_cancelled : napi_ok;
        if (work->complete)
            work->complete(reinterpret_cast<napi_env>(env), status, work->data);
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
    std::vector<napi_threadsafe_function__*> thread_safe_functions;
    {
        std::lock_guard lock(env->async_mutex);
        thread_safe_functions.assign(env->thread_safe_functions.begin(), env->thread_safe_functions.end());
    }
    for (auto* function : thread_safe_functions) {
        for (;;) {
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
                if (should_finalize)
                    function->finalized = true;
            }
            function->space_available.notify_all();
            if (has_call) {
                if (function->aborting) {
                    if (function->call_js)
                        function->call_js(nullptr, nullptr, function->context, call.data);
                } else {
                    AutomaticScope scope(env);
                    if (function->call_js) {
                        function->call_js(reinterpret_cast<napi_env>(env), to_napi(function->callback), function->context, call.data);
                    } else if (function->callback) {
                        napi_value global = nullptr;
                        napi_get_global(reinterpret_cast<napi_env>(env), &global);
                        napi_call_function(reinterpret_cast<napi_env>(env), global, to_napi(function->callback), 0, nullptr, nullptr);
                    }
                }
                if (take_pending_exception(env, exception))
                    return false;
            }
            if (should_finalize) {
                if (function->finalize_callback)
                    function->finalize_callback(reinterpret_cast<napi_env>(env), function->finalize_data, function->context);
                if (function->callback)
                    JSValueUnprotect(env->context, function->callback);
                {
                    std::lock_guard lock(env->async_mutex);
                    env->thread_safe_functions.erase(function);
                }
                delete function;
                if (take_pending_exception(env, exception))
                    return false;
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
    if (!drain_finalizer_queue(root, true, exception))
        return;
    for (auto* env : root->addon_envs) {
        if (!drain_finalizer_queue(env, true, exception))
            return;
    }
}
