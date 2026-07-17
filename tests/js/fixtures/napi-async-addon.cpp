#include <node_api.h>

#include <new>
#include <thread>

namespace {

struct AsyncWorkData {
    napi_async_work work { nullptr };
    napi_deferred deferred { nullptr };
    int32_t input { 0 };
    int32_t output { 0 };
};

void execute_async_work(napi_env, void* opaque)
{
    auto* data = static_cast<AsyncWorkData*>(opaque);
    data->output = data->input * 2;
}

void complete_async_work(napi_env env, napi_status status, void* opaque)
{
    auto* data = static_cast<AsyncWorkData*>(opaque);
    napi_value value = nullptr;
    if (status == napi_ok && napi_create_int32(env, data->output, &value) == napi_ok)
        napi_resolve_deferred(env, data->deferred, value);
    napi_delete_async_work(env, data->work);
    delete data;
}

napi_value async_double(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argument = nullptr;
    if (napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr) != napi_ok || argc != 1)
        return nullptr;

    auto* data = new (std::nothrow) AsyncWorkData;
    if (!data) {
        napi_throw_error(env, nullptr, "failed to allocate async work data");
        return nullptr;
    }
    if (napi_get_value_int32(env, argument, &data->input) != napi_ok) {
        delete data;
        return nullptr;
    }

    napi_value promise = nullptr;
    napi_value resource_name = nullptr;
    napi_status status = napi_create_promise(env, &data->deferred, &promise);
    if (status == napi_ok)
        status = napi_create_string_utf8(env, "napi-async-double", NAPI_AUTO_LENGTH, &resource_name);
    if (status == napi_ok) {
        status = napi_create_async_work(
            env,
            nullptr,
            resource_name,
            execute_async_work,
            complete_async_work,
            data,
            &data->work
        );
    }
    if (status == napi_ok)
        status = napi_queue_async_work(env, data->work);
    if (status != napi_ok) {
        if (data->work)
            napi_delete_async_work(env, data->work);
        delete data;
        napi_throw_error(env, nullptr, "failed to queue async work");
        return nullptr;
    }
    return promise;
}

struct ThreadsafeData {
    napi_threadsafe_function function { nullptr };
    napi_deferred deferred { nullptr };
};

void call_from_thread(napi_env env, napi_value callback, void* opaque, void* raw_value)
{
    auto* data = static_cast<ThreadsafeData*>(opaque);
    auto* number = static_cast<int32_t*>(raw_value);
    napi_value receiver = nullptr;
    napi_value argument = nullptr;
    napi_value result = nullptr;
    napi_status status = napi_get_undefined(env, &receiver);
    if (status == napi_ok)
        status = napi_create_int32(env, *number, &argument);
    if (status == napi_ok)
        status = napi_call_function(env, receiver, callback, 1, &argument, &result);
    if (status == napi_ok)
        napi_resolve_deferred(env, data->deferred, result);
    delete number;
}

void finalize_threadsafe(napi_env, void* opaque, void*)
{
    delete static_cast<ThreadsafeData*>(opaque);
}

napi_value call_threadsafe(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value callback = nullptr;
    if (napi_get_cb_info(env, info, &argc, &callback, nullptr, nullptr) != napi_ok || argc != 1)
        return nullptr;

    auto* data = new (std::nothrow) ThreadsafeData;
    if (!data) {
        napi_throw_error(env, nullptr, "failed to allocate thread-safe function data");
        return nullptr;
    }
    napi_value promise = nullptr;
    napi_value resource_name = nullptr;
    napi_status status = napi_create_promise(env, &data->deferred, &promise);
    if (status == napi_ok)
        status = napi_create_string_utf8(env, "napi-threadsafe-call", NAPI_AUTO_LENGTH, &resource_name);
    if (status == napi_ok) {
        status = napi_create_threadsafe_function(
            env,
            callback,
            nullptr,
            resource_name,
            1,
            1,
            data,
            finalize_threadsafe,
            data,
            call_from_thread,
            &data->function
        );
    }
    if (status != napi_ok) {
        delete data;
        napi_throw_error(env, nullptr, "failed to create a thread-safe function");
        return nullptr;
    }

    std::thread([data] {
        auto* number = new (std::nothrow) int32_t(21);
        if (!number || napi_call_threadsafe_function(data->function, number, napi_tsfn_blocking) != napi_ok)
            delete number;
        napi_release_threadsafe_function(data->function, napi_tsfn_release);
    }).detach();
    return promise;
}

} // namespace

NAPI_MODULE_INIT()
{
    napi_property_descriptor properties[] = {
        { "asyncDouble", nullptr, async_double, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "callThreadsafe", nullptr, call_threadsafe, nullptr, nullptr, nullptr, napi_default, nullptr },
    };
    if (napi_define_properties(env, exports, 2, properties) != napi_ok)
        return nullptr;
    return exports;
}
