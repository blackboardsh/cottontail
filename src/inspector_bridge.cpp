#include <JavaScriptCore/JSContextRef.h>
#include <JavaScriptCore/JSStringRef.h>

#include <openssl/evp.h>
#include <uv.h>

#include <wtf/ThreadSafeRefCounted.h>
#include <wtf/text/StringImpl.h>

#include <algorithm>
#include <atomic>
#include <bit>
#include <cerrno>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iterator>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif

extern "C" void* ct_jsc_run_loop_current(void);
extern "C" void ct_jsc_run_loop_dispatch(void*, void (*)(void*), void*);
extern "C" void ct_jsc_run_loop_cycle(void);

namespace WTF {

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
    ~OpaqueJSString();
    bool is8Bit() { return m_string_impl == nullptr || m_string_impl->is8Bit(); }
    WTF::String string() const;

private:
    WTF::StringImpl* m_string_impl;
    std::atomic<char16_t*> m_characters;
};

namespace JSC {

class JSGlobalObject;
class VM;

class JSLockHolder {
public:
    JSLockHolder(VM&);
    ~JSLockHolder();

private:
    VM* m_vm;
};

}

namespace Inspector {

class FrontendChannel {
public:
    enum class ConnectionType : bool {
        Remote,
        Local,
    };

    virtual ~FrontendChannel() { }
    virtual ConnectionType connectionType() const = 0;
    virtual void sendMessageToFrontend(const WTF::String&) = 0;
};

// The JSCOnly SDK intentionally omits private inspector headers. These method
// declarations and the storage reservation are pinned to WebKit-7624.2.5.10.6.
// Construction and destruction are still performed by JavaScriptCore itself.
class JSGlobalObjectInspectorController {
public:
    explicit JSGlobalObjectInspectorController(JSC::JSGlobalObject&);
    ~JSGlobalObjectInspectorController();
    void connectFrontend(FrontendChannel&, bool isAutomaticInspection, bool immediatelyPause);
    void disconnectFrontend(FrontendChannel&);
    void dispatchMessageFromFrontend(const WTF::String&);
    void globalObjectDestroyed();
    void setDidBeginCheckedPtrDeletion();

private:
    alignas(std::max_align_t) unsigned char m_storage[4096];
};

}

namespace {

constexpr size_t maxInspectorMessageSize = 16 * 1024 * 1024;
constexpr size_t maxHttpHeaderSize = 64 * 1024;
constexpr size_t maxQueuedOutputSize = 32 * 1024 * 1024;

// WebKit-7624.2.5.10.6's private controller layout. Its registry teardown
// leaves two CheckedPtrs targeting deleted agents, and the JSCOnly SDK omits
// the types needed to clear them normally. Keep this with the pinned storage.
constexpr size_t inspectorAgentCheckedPtrOffset = 0x48;
constexpr size_t inspectorAgentCheckedPtrCountOffset = 0x18;
constexpr size_t consoleClientOffset = 0x28;
constexpr size_t consoleAgentCheckedPtrOffset = 0x28;
constexpr size_t consoleAgentCheckedPtrCountOffset = 0x28;

struct CtJscInspector;
struct InspectorServer;
struct InspectorClient;
struct FramedInspectorClient;

static JSC::VM* inspectorVM(JSContextRef context)
{
    return reinterpret_cast<JSC::VM*>(
        const_cast<OpaqueJSContextGroup*>(JSContextGetGroup(context)));
}

static JSC::JSGlobalObject* inspectorGlobalObject(JSContextRef context)
{
    return reinterpret_cast<JSC::JSGlobalObject*>(
        const_cast<OpaqueJSContext*>(context));
}

static void* pinnedPointerAt(void* owner, size_t offset)
{
    void* pointer = nullptr;
    std::memcpy(&pointer, static_cast<unsigned char*>(owner) + offset, sizeof(pointer));
    return pointer;
}

static void releasePinnedCheckedPtr(void* owner, size_t pointerOffset, size_t countOffset)
{
    if (!owner)
        return;

    auto* bytes = static_cast<unsigned char*>(owner);
    void* target = pinnedPointerAt(owner, pointerOffset);
    if (!target)
        return;

    auto* countAddress = static_cast<unsigned char*>(target) + countOffset;
    uint32_t count = 0;
    std::memcpy(&count, countAddress, sizeof(count));
    if (!count)
        std::abort();
    --count;
    std::memcpy(countAddress, &count, sizeof(count));

    target = nullptr;
    std::memcpy(bytes + pointerOffset, &target, sizeof(target));
}

static void releasePinnedInspectorCheckedPtrs(Inspector::JSGlobalObjectInspectorController* controller)
{
    static_assert(sizeof(void*) == 8);
    releasePinnedCheckedPtr(
        controller,
        inspectorAgentCheckedPtrOffset,
        inspectorAgentCheckedPtrCountOffset);
    releasePinnedCheckedPtr(
        pinnedPointerAt(controller, consoleClientOffset),
        consoleAgentCheckedPtrOffset,
        consoleAgentCheckedPtrCountOffset);
}

static char* duplicateCString(std::string_view value)
{
    if (value.size() == std::numeric_limits<size_t>::max())
        return nullptr;
    char* copy = static_cast<char*>(std::malloc(value.size() + 1));
    if (!copy)
        return nullptr;
    if (!value.empty())
        std::memcpy(copy, value.data(), value.size());
    copy[value.size()] = '\0';
    return copy;
}

static std::string stringToUTF8(const WTF::String& value)
{
    auto* impl = value.impl();
    if (!impl)
        return {};

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
    if (!string)
        return {};

    const size_t capacity = JSStringGetMaximumUTF8CStringSize(string);
    std::vector<char> buffer(capacity);
    std::string result;
    if (capacity) {
        const size_t written = JSStringGetUTF8CString(string, buffer.data(), capacity);
        if (written)
            result.assign(buffer.data(), written - 1);
    }
    JSStringRelease(string);
    return result;
}

static bool utf8IsValid(std::string_view input)
{
    size_t index = 0;
    while (index < input.size()) {
        const auto first = static_cast<unsigned char>(input[index++]);
        if (first < 0x80)
            continue;

        uint32_t codePoint = 0;
        size_t continuationCount = 0;
        if ((first & 0xe0) == 0xc0) {
            codePoint = first & 0x1f;
            continuationCount = 1;
            if (codePoint < 2)
                return false;
        } else if ((first & 0xf0) == 0xe0) {
            codePoint = first & 0x0f;
            continuationCount = 2;
        } else if ((first & 0xf8) == 0xf0) {
            codePoint = first & 0x07;
            continuationCount = 3;
        } else {
            return false;
        }

        if (index + continuationCount > input.size())
            return false;
        for (size_t count = 0; count < continuationCount; ++count) {
            const auto next = static_cast<unsigned char>(input[index++]);
            if ((next & 0xc0) != 0x80)
                return false;
            codePoint = (codePoint << 6) | (next & 0x3f);
        }
        if ((continuationCount == 2 && codePoint < 0x800)
            || (continuationCount == 3 && codePoint < 0x10000)
            || codePoint > 0x10ffff
            || (codePoint >= 0xd800 && codePoint <= 0xdfff))
            return false;
    }
    return true;
}

static std::string jsonEscape(std::string_view input)
{
    static constexpr char hex[] = "0123456789abcdef";
    std::string output;
    output.reserve(input.size() + 8);
    for (const unsigned char byte : input) {
        switch (byte) {
        case '"': output += "\\\""; break;
        case '\\': output += "\\\\"; break;
        case '\b': output += "\\b"; break;
        case '\f': output += "\\f"; break;
        case '\n': output += "\\n"; break;
        case '\r': output += "\\r"; break;
        case '\t': output += "\\t"; break;
        default:
            if (byte < 0x20) {
                output += "\\u00";
                output += hex[byte >> 4];
                output += hex[byte & 0x0f];
            } else {
                output += static_cast<char>(byte);
            }
        }
    }
    return output;
}

static std::string lowercaseASCII(std::string_view input)
{
    std::string result(input);
    std::transform(result.begin(), result.end(), result.begin(), [](unsigned char byte) {
        return static_cast<char>(std::tolower(byte));
    });
    return result;
}

static std::string_view trimASCII(std::string_view input)
{
    while (!input.empty() && (input.front() == ' ' || input.front() == '\t'))
        input.remove_prefix(1);
    while (!input.empty() && (input.back() == ' ' || input.back() == '\t'))
        input.remove_suffix(1);
    return input;
}

static std::string jsStringToUTF8(JSStringRef value)
{
    if (!value)
        return {};
    const size_t capacity = JSStringGetMaximumUTF8CStringSize(value);
    std::vector<char> buffer(capacity);
    if (!capacity)
        return {};
    const size_t written = JSStringGetUTF8CString(value, buffer.data(), capacity);
    return written ? std::string(buffer.data(), written - 1) : std::string {};
}

enum class CustomInspectorDomain : uint8_t {
    None,
    HTTPServer,
    BunFrontendDevServer,
    LifecycleReporter,
    TestReporter,
};

static CustomInspectorDomain customDomainForMethod(std::string_view method)
{
    if (method.starts_with("HTTPServer."))
        return CustomInspectorDomain::HTTPServer;
    if (method.starts_with("BunFrontendDevServer."))
        return CustomInspectorDomain::BunFrontendDevServer;
    if (method.starts_with("LifecycleReporter."))
        return CustomInspectorDomain::LifecycleReporter;
    if (method.starts_with("TestReporter."))
        return CustomInspectorDomain::TestReporter;
    return CustomInspectorDomain::None;
}

struct InspectorCommand {
    uint64_t id { 0 };
    std::string method;
};

static bool parseInspectorCommand(JSContextRef context, const std::string& message, InspectorCommand& command)
{
    JSStringRef json = JSStringCreateWithUTF8CString(message.c_str());
    if (!json)
        return false;
    JSValueRef value = JSValueMakeFromJSONString(context, json);
    JSStringRelease(json);
    if (!value || !JSValueIsObject(context, value))
        return false;

    JSValueRef exception = nullptr;
    JSObjectRef object = JSValueToObject(context, value, &exception);
    if (!object || exception)
        return false;

    JSStringRef methodName = JSStringCreateWithUTF8CString("method");
    JSValueRef methodValue = JSObjectGetProperty(context, object, methodName, &exception);
    JSStringRelease(methodName);
    if (exception || !methodValue || !JSValueIsString(context, methodValue))
        return false;
    JSStringRef method = JSValueToStringCopy(context, methodValue, &exception);
    if (exception || !method)
        return false;
    command.method = jsStringToUTF8(method);
    JSStringRelease(method);

    JSStringRef idName = JSStringCreateWithUTF8CString("id");
    JSValueRef idValue = JSObjectGetProperty(context, object, idName, &exception);
    JSStringRelease(idName);
    if (exception || !idValue || !JSValueIsNumber(context, idValue))
        return false;
    const double id = JSValueToNumber(context, idValue, &exception);
    if (exception || !std::isfinite(id) || id < 1 || id > 9007199254740991.0 || std::floor(id) != id)
        return false;
    command.id = static_cast<uint64_t>(id);
    return !command.method.empty();
}

class MessageSink {
public:
    virtual ~MessageSink() = default;
    virtual void send(std::string&&) = 0;
    virtual bool isRemoteDebugger() const = 0;
};

class LocalMessageSink final : public MessageSink {
public:
    void send(std::string&& message) final
    {
        std::lock_guard lock(m_mutex);
        m_messages.push_back(std::move(message));
    }

    bool isRemoteDebugger() const final { return false; }

    std::vector<std::string> take()
    {
        std::lock_guard lock(m_mutex);
        std::vector<std::string> messages;
        messages.swap(m_messages);
        return messages;
    }

private:
    std::mutex m_mutex;
    std::vector<std::string> m_messages;
};

class WebSocketMessageSink final : public MessageSink {
public:
    explicit WebSocketMessageSink(std::weak_ptr<InspectorClient> client)
        : m_client(std::move(client))
    {
    }

    void send(std::string&&) final;
    bool isRemoteDebugger() const final { return true; }

private:
    std::weak_ptr<InspectorClient> m_client;
};

class FramedMessageSink final : public MessageSink {
public:
    explicit FramedMessageSink(std::weak_ptr<FramedInspectorClient> client)
        : m_client(std::move(client))
    {
    }

    void send(std::string&&) final;
    bool isRemoteDebugger() const final { return true; }

private:
    std::weak_ptr<FramedInspectorClient> m_client;
};

class InspectorFrontend final : public Inspector::FrontendChannel {
public:
    InspectorFrontend(uint64_t id, std::shared_ptr<MessageSink> sink)
        : m_id(id)
        , m_sink(std::move(sink))
    {
    }

    ConnectionType connectionType() const final
    {
        return m_sink->isRemoteDebugger() ? ConnectionType::Remote : ConnectionType::Local;
    }

    void sendMessageToFrontend(const WTF::String& message) final
    {
        if (auto text = stringToUTF8(message); !text.empty())
            m_sink->send(std::move(text));
    }

    uint64_t id() const { return m_id; }
    bool isRemoteDebugger() const { return m_sink->isRemoteDebugger(); }
    void send(std::string message) { m_sink->send(std::move(message)); }

    bool customDomainEnabled(CustomInspectorDomain domain) const
    {
        switch (domain) {
        case CustomInspectorDomain::HTTPServer: return m_httpServerEnabled;
        case CustomInspectorDomain::BunFrontendDevServer: return m_bunFrontendDevServerEnabled;
        case CustomInspectorDomain::LifecycleReporter: return m_lifecycleReporterEnabled;
        case CustomInspectorDomain::TestReporter: return m_testReporterEnabled;
        case CustomInspectorDomain::None: return false;
        }
        return false;
    }

    void setCustomDomainEnabled(CustomInspectorDomain domain, bool enabled)
    {
        switch (domain) {
        case CustomInspectorDomain::HTTPServer: m_httpServerEnabled = enabled; break;
        case CustomInspectorDomain::BunFrontendDevServer: m_bunFrontendDevServerEnabled = enabled; break;
        case CustomInspectorDomain::LifecycleReporter: m_lifecycleReporterEnabled = enabled; break;
        case CustomInspectorDomain::TestReporter: m_testReporterEnabled = enabled; break;
        case CustomInspectorDomain::None: break;
        }
    }

private:
    uint64_t m_id;
    std::shared_ptr<MessageSink> m_sink;
    bool m_httpServerEnabled { false };
    bool m_bunFrontendDevServerEnabled { false };
    bool m_lifecycleReporterEnabled { false };
    bool m_testReporterEnabled { false };
};

enum class InspectorEventType {
    Open,
    Message,
    Close,
    Notification,
};

struct InspectorEvent {
    InspectorEventType type;
    uint64_t id;
    std::shared_ptr<MessageSink> sink;
    std::string message;
    CustomInspectorDomain domain { CustomInspectorDomain::None };
    bool replayable { false };
};

struct CtJscInspector {
    explicit CtJscInspector(JSGlobalContextRef context)
        : context(context)
        , runLoop(ct_jsc_run_loop_current())
    {
    }

    JSGlobalContextRef context;
    std::atomic<size_t> referenceCount { 1 };
    void* runLoop { nullptr };
    void* controllerMemory { nullptr };
    Inspector::JSGlobalObjectInspectorController* controller { nullptr };
    std::unordered_map<uint64_t, std::unique_ptr<InspectorFrontend>> frontends;
    std::mutex eventMutex;
    std::deque<InspectorEvent> events;
    std::atomic<bool> eventTaskScheduled { false };
    std::atomic<bool> closing { false };
    std::atomic<size_t> remoteConnectionCount { 0 };
    std::atomic<uint64_t> nextConnectionId { 1 };
    std::mutex localSinkMutex;
    std::unordered_map<uint64_t, std::shared_ptr<LocalMessageSink>> localSinks;
    std::shared_ptr<InspectorServer> server;
    std::shared_ptr<FramedInspectorClient> framedClient;
    std::string serverUrl;
    std::mutex moduleGraphMutex;
    std::string moduleGraph { R"({"esm":[],"cjs":[],"cwd":"","main":"","argv":[]})" };
    std::vector<std::string> testReporterFoundEvents;
    bool pauseOnStart { false };
    bool pauseConsumed { false };

    bool ensureController(std::string& error)
    {
        if (controller)
            return true;
        auto* vm = inspectorVM(context);
        if (!vm) {
            error = "JavaScriptCore VM is unavailable";
            return false;
        }
        JSC::JSLockHolder lock(*vm);
        controllerMemory = std::calloc(1, sizeof(Inspector::JSGlobalObjectInspectorController));
        if (!controllerMemory) {
            error = "Out of memory creating the inspector controller";
            return false;
        }
        controller = new (controllerMemory) Inspector::JSGlobalObjectInspectorController(
            *inspectorGlobalObject(context));
        JSGlobalContextSetInspectable(context, true);
        return true;
    }

    void enqueue(InspectorEvent&& event);
    void processEvents();
    bool dispatchCustomCommand(InspectorFrontend&, const std::string&);
    void destroyController();
    bool hasTransport() const { return server || framedClient; }
    void retain() { referenceCount.fetch_add(1, std::memory_order_relaxed); }
    void release()
    {
        if (referenceCount.fetch_sub(1, std::memory_order_acq_rel) == 1)
            delete this;
    }
};

static void processInspectorEvents(void* opaque)
{
    static_cast<CtJscInspector*>(opaque)->processEvents();
}

void CtJscInspector::enqueue(InspectorEvent&& event)
{
    {
        std::lock_guard lock(eventMutex);
        if (closing.load(std::memory_order_acquire))
            return;
        events.push_back(std::move(event));
        if (eventTaskScheduled.exchange(true, std::memory_order_acq_rel))
            return;
    }
    ct_jsc_run_loop_dispatch(runLoop, processInspectorEvents, this);
}

bool CtJscInspector::dispatchCustomCommand(InspectorFrontend& frontend, const std::string& message)
{
    InspectorCommand command;
    if (!parseInspectorCommand(context, message, command))
        return false;
    const CustomInspectorDomain domain = customDomainForMethod(command.method);
    if (domain == CustomInspectorDomain::None)
        return false;

    const size_t separator = command.method.find('.');
    const std::string_view action = separator == std::string::npos
        ? std::string_view {}
        : std::string_view(command.method).substr(separator + 1);
    std::string result = "{}";
    bool knownCommand = true;

    if (action == "enable") {
        const bool wasEnabled = frontend.customDomainEnabled(domain);
        frontend.setCustomDomainEnabled(domain, true);
        frontend.send("{\"id\":" + std::to_string(command.id) + ",\"result\":{}}");
        if (domain == CustomInspectorDomain::TestReporter && !wasEnabled) {
            for (const auto& foundEvent : testReporterFoundEvents)
                frontend.send(foundEvent);
        }
        return true;
    }
    if (action == "disable") {
        frontend.setCustomDomainEnabled(domain, false);
    } else if (domain == CustomInspectorDomain::HTTPServer
        && (action == "startListening" || action == "stopListening"
            || action == "getRequestBody" || action == "getResponseBody")) {
    } else if (domain == CustomInspectorDomain::LifecycleReporter
        && (action == "preventExit" || action == "stopPreventingExit")) {
    } else if (domain == CustomInspectorDomain::LifecycleReporter && action == "getModuleGraph") {
        std::lock_guard lock(moduleGraphMutex);
        result = moduleGraph;
    } else {
        knownCommand = false;
    }

    if (knownCommand) {
        frontend.send("{\"id\":" + std::to_string(command.id) + ",\"result\":" + result + "}");
    } else {
        frontend.send("{\"id\":" + std::to_string(command.id)
            + ",\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}");
    }
    return true;
}

void CtJscInspector::processEvents()
{
    auto* vm = inspectorVM(context);
    if (!vm) {
        eventTaskScheduled.store(false, std::memory_order_release);
        return;
    }
    JSC::JSLockHolder lock(*vm);

    while (true) {
        std::deque<InspectorEvent> pending;
        {
            std::lock_guard eventLock(eventMutex);
            if (events.empty()) {
                eventTaskScheduled.store(false, std::memory_order_release);
                return;
            }
            pending.swap(events);
        }

        for (auto& event : pending) {
            if (closing.load(std::memory_order_acquire) && event.type != InspectorEventType::Close)
                continue;

            switch (event.type) {
            case InspectorEventType::Open: {
                if (!controller || frontends.contains(event.id))
                    break;
                auto frontend = std::make_unique<InspectorFrontend>(event.id, std::move(event.sink));
                const bool remote = frontend->isRemoteDebugger();
                const bool shouldPause = remote && pauseOnStart && !pauseConsumed;
                if (shouldPause)
                    pauseConsumed = true;
                controller->connectFrontend(*frontend, false, shouldPause);
                frontends.emplace(event.id, std::move(frontend));
                if (remote)
                    remoteConnectionCount.fetch_add(1, std::memory_order_release);
                break;
            }
            case InspectorEventType::Message:
                if (controller && frontends.contains(event.id)) {
                    auto& frontend = *frontends.at(event.id);
                    if (!dispatchCustomCommand(frontend, event.message)) {
                        JSStringRef messageRef = JSStringCreateWithUTF8CString(event.message.c_str());
                        if (messageRef) {
                            auto message = const_cast<OpaqueJSString*>(messageRef)->string();
                            JSStringRelease(messageRef);
                            controller->dispatchMessageFromFrontend(message);
                        }
                    }
                }
                break;
            case InspectorEventType::Close: {
                auto iterator = frontends.find(event.id);
                if (iterator == frontends.end())
                    break;
                const bool remote = iterator->second->isRemoteDebugger();
                if (controller)
                    controller->disconnectFrontend(*iterator->second);
                frontends.erase(iterator);
                if (remote)
                    remoteConnectionCount.fetch_sub(1, std::memory_order_release);
                break;
            }
            case InspectorEventType::Notification:
                if (event.replayable)
                    testReporterFoundEvents.push_back(event.message);
                for (auto& entry : frontends) {
                    if (entry.second->customDomainEnabled(event.domain))
                        entry.second->send(event.message);
                }
                break;
            }
        }
    }
}

void CtJscInspector::destroyController()
{
    if (!controller)
        return;
    auto* vm = inspectorVM(context);
    if (!vm)
        return;
    JSC::JSLockHolder lock(*vm);
    for (auto& entry : frontends)
        controller->disconnectFrontend(*entry.second);
    frontends.clear();
    remoteConnectionCount.store(0, std::memory_order_release);
    releasePinnedInspectorCheckedPtrs(controller);
    controller->globalObjectDestroyed();
    controller->setDidBeginCheckedPtrDeletion();
    controller->~JSGlobalObjectInspectorController();
    std::free(controllerMemory);
    controllerMemory = nullptr;
    controller = nullptr;
    JSGlobalContextSetInspectable(context, false);
}

struct InspectorWriteRequest {
    uv_write_t request;
    std::vector<char> bytes;
    bool closeAfterWrite { false };
};

enum class InspectorStreamKind {
    Tcp,
    Pipe,
};

struct InspectorClient : public std::enable_shared_from_this<InspectorClient> {
    InspectorClient(InspectorServer* server, uint64_t id, InspectorStreamKind streamKind)
        : server(server)
        , id(id)
        , streamKind(streamKind)
    {
    }

    InspectorServer* server;
    uint64_t id;
    InspectorStreamKind streamKind;
    uv_tcp_t tcpHandle { };
    uv_pipe_t pipeHandle { };
    uv_stream_t* stream { nullptr };
    bool upgraded { false };
    std::atomic<bool> closing { false };
    std::atomic<bool> closeRequested { false };
    std::vector<unsigned char> input;
    uint8_t fragmentOpcode { 0 };
    std::string fragmentedMessage;
    std::mutex outputMutex;
    std::deque<std::string> output;
    size_t queuedOutputSize { 0 };

    void enqueueOutput(std::string&& message);
};

struct InspectorServer : public std::enable_shared_from_this<InspectorServer> {
    InspectorServer(CtJscInspector* inspector, std::string host, uint16_t port, std::string path)
        : inspector(inspector)
        , host(std::move(host))
        , requestedPort(port)
        , path(std::move(path))
    {
    }

    InspectorServer(CtJscInspector* inspector, std::string unixPath)
        : inspector(inspector)
        , unixSocket(true)
        , unixPath(std::move(unixPath))
        , path("/")
    {
    }

    CtJscInspector* inspector;
    bool unixSocket { false };
    std::string host;
    uint16_t requestedPort { 0 };
    uint16_t boundPort { 0 };
    std::string unixPath;
    std::string path;
    std::string url;
    std::string startupError;
    uv_loop_t loop { };
    uv_tcp_t tcpListener { };
    uv_pipe_t pipeListener { };
    uv_async_t async { };
    uv_thread_t thread { };
    uv_sem_t started { };
    bool threadCreated { false };
    bool loopInitialized { false };
    bool listenerInitialized { false };
    bool unixPathBound { false };
    std::atomic<bool> asyncInitialized { false };
    std::atomic<bool> stopRequested { false };
    std::unordered_map<InspectorClient*, std::shared_ptr<InspectorClient>> clients;

    uv_stream_t* listenerStream()
    {
        return unixSocket
            ? reinterpret_cast<uv_stream_t*>(&pipeListener)
            : reinterpret_cast<uv_stream_t*>(&tcpListener);
    }

    bool start();
    void stop();
    void enqueue(InspectorEvent&& event) { inspector->enqueue(std::move(event)); }
    void closeClient(const std::shared_ptr<InspectorClient>&, bool notifyInspector = true);
    void sendFrame(const std::shared_ptr<InspectorClient>&, uint8_t opcode, std::string_view payload, bool closeAfter = false);
    void flushOutput(const std::shared_ptr<InspectorClient>&);
    void processInput(const std::shared_ptr<InspectorClient>&);
    void processHttp(const std::shared_ptr<InspectorClient>&);
    void processFrames(const std::shared_ptr<InspectorClient>&);
};

enum class FramedTransportKind {
    Tcp,
    Unix,
    FileDescriptor,
};

static void closeOwnedFd(int fd);

struct FramedInspectorClient : public std::enable_shared_from_this<FramedInspectorClient> {
    FramedInspectorClient(CtJscInspector* inspector, std::string host, uint16_t port)
        : inspector(inspector)
        , kind(FramedTransportKind::Tcp)
        , host(std::move(host))
        , port(port)
    {
    }

    FramedInspectorClient(CtJscInspector* inspector, std::string unixPath)
        : inspector(inspector)
        , kind(FramedTransportKind::Unix)
        , unixPath(std::move(unixPath))
    {
    }

    FramedInspectorClient(CtJscInspector* inspector, int ownedFd)
        : inspector(inspector)
        , kind(FramedTransportKind::FileDescriptor)
        , ownedFd(ownedFd)
    {
    }

    ~FramedInspectorClient() { closeOwnedFd(ownedFd); }

    CtJscInspector* inspector;
    FramedTransportKind kind;
    std::string host;
    uint16_t port { 0 };
    std::string unixPath;
    int ownedFd { -1 };
    uint64_t connectionId { 0 };
    std::string startupError;
    uv_loop_t loop { };
    uv_tcp_t tcpHandle { };
    uv_pipe_t pipeHandle { };
    uv_stream_t* stream { nullptr };
    uv_async_t async { };
    uv_thread_t thread { };
    uv_sem_t started { };
    bool threadCreated { false };
    bool loopInitialized { false };
    bool streamInitialized { false };
    bool startedPosted { false };
    bool opened { false };
    bool closeEventSent { false };
    std::atomic<bool> asyncInitialized { false };
    std::atomic<bool> stopRequested { false };
    std::atomic<bool> closeRequested { false };
    std::atomic<bool> closing { false };
    std::mutex outputMutex;
    std::deque<std::string> output;
    size_t queuedOutputSize { 0 };
    std::vector<unsigned char> input;

    bool start();
    void stop();
    void enqueueOutput(std::string&&);
    void flushOutput();
    void processInput();
    void connected(int status);
    void closeOnLoop(bool notifyInspector = true);
    void postStarted();
};

void WebSocketMessageSink::send(std::string&& message)
{
    if (auto client = m_client.lock())
        client->enqueueOutput(std::move(message));
}

void FramedMessageSink::send(std::string&& message)
{
    if (auto client = m_client.lock())
        client->enqueueOutput(std::move(message));
}

void InspectorClient::enqueueOutput(std::string&& message)
{
    if (closing.load(std::memory_order_acquire) || message.size() > maxInspectorMessageSize)
        return;
    {
        std::lock_guard lock(outputMutex);
        if (message.size() > maxQueuedOutputSize - queuedOutputSize) {
            output.clear();
            queuedOutputSize = 0;
            closeRequested.store(true, std::memory_order_release);
        } else {
            queuedOutputSize += message.size();
            output.push_back(std::move(message));
        }
    }
    if (server && server->asyncInitialized.load(std::memory_order_acquire))
        uv_async_send(&server->async);
}

static void inspectorWriteComplete(uv_write_t* request, int status)
{
    auto* write = reinterpret_cast<InspectorWriteRequest*>(request);
    auto* client = static_cast<InspectorClient*>(request->handle->data);
    const bool closeAfter = write->closeAfterWrite || status < 0;
    delete write;
    if (closeAfter && client && client->server) {
        auto iterator = client->server->clients.find(client);
        if (iterator != client->server->clients.end())
            client->server->closeClient(iterator->second);
    }
}

static bool writeBytes(const std::shared_ptr<InspectorClient>& client, std::vector<char>&& bytes, bool closeAfter)
{
    if (!client || client->closing.load(std::memory_order_acquire))
        return false;
    const size_t queued = uv_stream_get_write_queue_size(client->stream);
    if (queued > maxQueuedOutputSize || bytes.size() > maxQueuedOutputSize - queued)
        return false;
    auto* write = new (std::nothrow) InspectorWriteRequest;
    if (!write)
        return false;
    write->bytes = std::move(bytes);
    write->closeAfterWrite = closeAfter;
    if (closeAfter)
        uv_read_stop(client->stream);
    uv_buf_t buffer = uv_buf_init(write->bytes.data(), static_cast<unsigned int>(write->bytes.size()));
    const int status = uv_write(&write->request, client->stream, &buffer, 1, inspectorWriteComplete);
    if (status < 0) {
        delete write;
        return false;
    }
    return true;
}

static std::vector<char> websocketFrame(uint8_t opcode, std::string_view payload)
{
    std::vector<char> frame;
    frame.reserve(payload.size() + 10);
    frame.push_back(static_cast<char>(0x80 | (opcode & 0x0f)));
    if (payload.size() < 126) {
        frame.push_back(static_cast<char>(payload.size()));
    } else if (payload.size() <= 0xffff) {
        frame.push_back(126);
        frame.push_back(static_cast<char>((payload.size() >> 8) & 0xff));
        frame.push_back(static_cast<char>(payload.size() & 0xff));
    } else {
        frame.push_back(127);
        const uint64_t length = payload.size();
        for (int shift = 56; shift >= 0; shift -= 8)
            frame.push_back(static_cast<char>((length >> shift) & 0xff));
    }
    frame.insert(frame.end(), payload.begin(), payload.end());
    return frame;
}

void InspectorServer::sendFrame(const std::shared_ptr<InspectorClient>& client, uint8_t opcode, std::string_view payload, bool closeAfter)
{
    if (!writeBytes(client, websocketFrame(opcode, payload), closeAfter))
        closeClient(client);
}

void InspectorServer::flushOutput(const std::shared_ptr<InspectorClient>& client)
{
    std::deque<std::string> messages;
    {
        std::lock_guard lock(client->outputMutex);
        messages.swap(client->output);
        client->queuedOutputSize = 0;
    }
    for (auto& message : messages)
        sendFrame(client, 0x1, message);
}

static void inspectorClientClosed(uv_handle_t* handle)
{
    auto* client = static_cast<InspectorClient*>(handle->data);
    if (!client || !client->server)
        return;
    auto* server = client->server;
    auto iterator = server->clients.find(client);
    if (iterator == server->clients.end())
        return;
    auto retained = std::move(iterator->second);
    server->clients.erase(iterator);
}

void InspectorServer::closeClient(const std::shared_ptr<InspectorClient>& client, bool notifyInspector)
{
    if (!client || client->closing.exchange(true, std::memory_order_acq_rel))
        return;
    uv_read_stop(client->stream);
    if (notifyInspector && client->upgraded)
        enqueue({ InspectorEventType::Close, client->id, nullptr, {} });
    auto* handle = reinterpret_cast<uv_handle_t*>(client->stream);
    if (!uv_is_closing(handle))
        uv_close(handle, inspectorClientClosed);
}

static void sendHttpResponse(
    const std::shared_ptr<InspectorClient>& client,
    int status,
    std::string_view statusText,
    std::string_view contentType,
    std::string_view body,
    std::string_view extraHeaders = {})
{
    std::string response = "HTTP/1.1 " + std::to_string(status) + " " + std::string(statusText) + "\r\n";
    response += "Connection: close\r\n";
    if (!contentType.empty())
        response += "Content-Type: " + std::string(contentType) + "\r\n";
    response += "Content-Length: " + std::to_string(body.size()) + "\r\n";
    response += extraHeaders;
    response += "\r\n";
    response += body;
    std::vector<char> bytes(response.begin(), response.end());
    if (!writeBytes(client, std::move(bytes), true) && client->server)
        client->server->closeClient(client);
}

static std::string websocketAccept(std::string_view key)
{
    std::string input(key);
    input += "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int digestLength = 0;
    if (!EVP_Digest(input.data(), input.size(), digest, &digestLength, EVP_sha1(), nullptr))
        return {};
    std::string encoded(4 * ((digestLength + 2) / 3), '\0');
    const int encodedLength = EVP_EncodeBlock(
        reinterpret_cast<unsigned char*>(encoded.data()), digest, static_cast<int>(digestLength));
    if (encodedLength < 0)
        return {};
    encoded.resize(static_cast<size_t>(encodedLength));
    return encoded;
}

static bool websocketKeyIsValid(std::string_view key)
{
    if (key.size() != 24)
        return false;
    unsigned char decoded[24] { };
    const int length = EVP_DecodeBlock(
        decoded,
        reinterpret_cast<const unsigned char*>(key.data()),
        static_cast<int>(key.size()));
    if (length < 0)
        return false;
    size_t padding = 0;
    if (!key.empty() && key.back() == '=')
        ++padding;
    if (key.size() > 1 && key[key.size() - 2] == '=')
        ++padding;
    return static_cast<size_t>(length) >= padding
        && static_cast<size_t>(length) - padding == 16;
}

static bool headerContainsToken(std::string_view value, std::string_view expected)
{
    const std::string target = lowercaseASCII(expected);
    while (!value.empty()) {
        const size_t comma = value.find(',');
        const std::string token = lowercaseASCII(trimASCII(value.substr(0, comma)));
        if (token == target)
            return true;
        if (comma == std::string_view::npos)
            break;
        value.remove_prefix(comma + 1);
    }
    return false;
}

void InspectorServer::processHttp(const std::shared_ptr<InspectorClient>& client)
{
    if (client->input.size() > maxHttpHeaderSize) {
        sendHttpResponse(client, 431, "Request Header Fields Too Large", "text/plain", "Request headers too large\n");
        return;
    }

    static constexpr unsigned char delimiter[] = { '\r', '\n', '\r', '\n' };
    auto headerEnd = std::search(client->input.begin(), client->input.end(), std::begin(delimiter), std::end(delimiter));
    if (headerEnd == client->input.end())
        return;
    const size_t headerSize = static_cast<size_t>(headerEnd - client->input.begin()) + 4;
    std::string header(reinterpret_cast<const char*>(client->input.data()), headerSize);
    client->input.erase(client->input.begin(), client->input.begin() + static_cast<ptrdiff_t>(headerSize));

    const size_t requestLineEnd = header.find("\r\n");
    if (requestLineEnd == std::string::npos) {
        sendHttpResponse(client, 400, "Bad Request", "text/plain", "Bad Request\n");
        return;
    }
    const std::string_view requestLine(header.data(), requestLineEnd);
    const size_t firstSpace = requestLine.find(' ');
    const size_t secondSpace = firstSpace == std::string_view::npos ? std::string_view::npos : requestLine.find(' ', firstSpace + 1);
    if (firstSpace == std::string_view::npos || secondSpace == std::string_view::npos) {
        sendHttpResponse(client, 400, "Bad Request", "text/plain", "Bad Request\n");
        return;
    }
    const std::string_view method = requestLine.substr(0, firstSpace);
    const std::string_view versionText = requestLine.substr(secondSpace + 1);
    std::string target(requestLine.substr(firstSpace + 1, secondSpace - firstSpace - 1));
    if (const size_t query = target.find('?'); query != std::string::npos)
        target.resize(query);

    std::unordered_map<std::string, std::string> headers;
    size_t cursor = requestLineEnd + 2;
    while (cursor + 2 <= headerSize) {
        const size_t lineEnd = header.find("\r\n", cursor);
        if (lineEnd == std::string::npos || lineEnd == cursor)
            break;
        const std::string_view line(header.data() + cursor, lineEnd - cursor);
        if (const size_t colon = line.find(':'); colon != std::string_view::npos) {
            headers[lowercaseASCII(trimASCII(line.substr(0, colon)))] = std::string(trimASCII(line.substr(colon + 1)));
        }
        cursor = lineEnd + 2;
    }

    if (versionText != "HTTP/1.1") {
        sendHttpResponse(client, 400, "Bad Request", "text/plain", "Bad Request\n");
        return;
    }
    if (method != "GET") {
        sendHttpResponse(client, 405, "Method Not Allowed", "text/plain", "Method Not Allowed\n", "Allow: GET\r\n");
        return;
    }

    if (target == "/json/version") {
        const std::string body = "{\"Protocol-Version\":\"1.3\",\"Browser\":\"Bun\",\"User-Agent\":\"Cottontail/1.3.10\",\"Bun-Version\":\"1.3.10\"}";
        sendHttpResponse(client, 200, "OK", "application/json; charset=UTF-8", body);
        return;
    }
    if (target == "/json" || target == "/json/list") {
        std::string id = path.size() > 1 ? path.substr(1) : "cottontail";
        const std::string escapedUrl = jsonEscape(url);
        const std::string devtoolsTarget = url.starts_with("ws://") ? url.substr(5) : url;
        const std::string body = "[{\"description\":\"Cottontail JavaScriptCore runtime\",\"id\":\""
            + jsonEscape(id) + "\",\"title\":\"Bun\",\"type\":\"node\",\"url\":\"file://\",\"webSocketDebuggerUrl\":\""
            + escapedUrl + "\",\"devtoolsFrontendUrl\":\"https://debug.bun.sh/#"
            + jsonEscape(devtoolsTarget) + "\"}]";
        sendHttpResponse(client, 200, "OK", "application/json; charset=UTF-8", body);
        return;
    }

    const auto upgrade = headers.find("upgrade");
    const auto connection = headers.find("connection");
    const auto key = headers.find("sec-websocket-key");
    const auto version = headers.find("sec-websocket-version");
    if (!unixSocket && target != path) {
        sendHttpResponse(client, 404, "Not Found", "text/plain", "Not Found\n");
        return;
    }
    if (upgrade == headers.end() || lowercaseASCII(trimASCII(upgrade->second)) != "websocket"
        || connection == headers.end() || !headerContainsToken(connection->second, "upgrade")
        || key == headers.end() || !websocketKeyIsValid(trimASCII(key->second))
        || version == headers.end() || trimASCII(version->second) != "13") {
        sendHttpResponse(client, 426, "Upgrade Required", "text/plain", "Upgrade Required\n", "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n");
        return;
    }

    const std::string accept = websocketAccept(trimASCII(key->second));
    if (accept.empty()) {
        sendHttpResponse(client, 500, "Internal Server Error", "text/plain", "Inspector handshake failed\n");
        return;
    }
    std::string response = "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: "
        + accept + "\r\n\r\n";
    std::vector<char> bytes(response.begin(), response.end());
    if (!writeBytes(client, std::move(bytes), false)) {
        closeClient(client);
        return;
    }

    client->upgraded = true;
    auto sink = std::make_shared<WebSocketMessageSink>(client);
    enqueue({ InspectorEventType::Open, client->id, std::move(sink), {} });
    if (!client->input.empty())
        processFrames(client);
}

static std::string closePayload(uint16_t code, std::string_view reason = {})
{
    std::string payload;
    payload.reserve(reason.size() + 2);
    payload.push_back(static_cast<char>((code >> 8) & 0xff));
    payload.push_back(static_cast<char>(code & 0xff));
    payload.append(reason);
    return payload;
}

static bool websocketCloseCodeIsValid(uint16_t code)
{
    if (code < 1000 || code >= 5000)
        return false;
    if (code >= 3000)
        return true;
    if (code > 1014)
        return false;
    return code != 1004 && code != 1005 && code != 1006;
}

void InspectorServer::processFrames(const std::shared_ptr<InspectorClient>& client)
{
    while (client->input.size() >= 2 && !client->closing.load(std::memory_order_acquire)) {
        const uint8_t first = client->input[0];
        const uint8_t second = client->input[1];
        const bool final = first & 0x80;
        const uint8_t opcode = first & 0x0f;
        const bool masked = second & 0x80;
        uint64_t payloadLength = second & 0x7f;
        size_t headerLength = 2;

        if (first & 0x70 || !masked) {
            sendFrame(client, 0x8, closePayload(1002, "Invalid WebSocket frame"), true);
            return;
        }
        if (payloadLength == 126) {
            if (client->input.size() < 4)
                return;
            payloadLength = (static_cast<uint64_t>(client->input[2]) << 8) | client->input[3];
            if (payloadLength < 126) {
                sendFrame(client, 0x8, closePayload(1002, "Non-canonical frame length"), true);
                return;
            }
            headerLength = 4;
        } else if (payloadLength == 127) {
            if (client->input.size() < 10)
                return;
            if (client->input[2] & 0x80) {
                sendFrame(client, 0x8, closePayload(1002, "Invalid frame length"), true);
                return;
            }
            payloadLength = 0;
            for (size_t index = 2; index < 10; ++index)
                payloadLength = (payloadLength << 8) | client->input[index];
            if (payloadLength <= 0xffff) {
                sendFrame(client, 0x8, closePayload(1002, "Non-canonical frame length"), true);
                return;
            }
            headerLength = 10;
        }

        const bool control = opcode >= 0x8;
        if ((control && (!final || payloadLength > 125)) || payloadLength > maxInspectorMessageSize) {
            sendFrame(client, 0x8, closePayload(payloadLength > maxInspectorMessageSize ? 1009 : 1002), true);
            return;
        }
        if (headerLength > std::numeric_limits<size_t>::max() - 4
            || payloadLength > std::numeric_limits<size_t>::max() - headerLength - 4)
            return;
        const size_t frameLength = headerLength + 4 + static_cast<size_t>(payloadLength);
        if (client->input.size() < frameLength)
            return;

        const unsigned char* mask = client->input.data() + headerLength;
        std::string payload(static_cast<size_t>(payloadLength), '\0');
        for (size_t index = 0; index < payload.size(); ++index)
            payload[index] = static_cast<char>(client->input[headerLength + 4 + index] ^ mask[index & 3]);
        client->input.erase(client->input.begin(), client->input.begin() + static_cast<ptrdiff_t>(frameLength));

        if (opcode == 0x8) {
            const uint16_t code = payload.size() >= 2
                ? (static_cast<uint16_t>(static_cast<unsigned char>(payload[0])) << 8)
                    | static_cast<unsigned char>(payload[1])
                : 1000;
            if (payload.size() == 1 || !websocketCloseCodeIsValid(code)
                || (payload.size() > 2 && !utf8IsValid(std::string_view(payload).substr(2)))) {
                sendFrame(client, 0x8, closePayload(1002), true);
            } else {
                sendFrame(client, 0x8, payload.empty() ? closePayload(1000) : payload, true);
            }
            return;
        }
        if (opcode == 0x9) {
            sendFrame(client, 0xA, payload);
            continue;
        }
        if (opcode == 0xA)
            continue;
        if (opcode == 0x2) {
            sendFrame(client, 0x8, closePayload(1003, "Binary messages are not supported"), true);
            return;
        }

        std::string message;
        if (opcode == 0x1) {
            if (client->fragmentOpcode) {
                sendFrame(client, 0x8, closePayload(1002), true);
                return;
            }
            if (!final) {
                client->fragmentOpcode = opcode;
                client->fragmentedMessage = std::move(payload);
                continue;
            }
            message = std::move(payload);
        } else if (opcode == 0x0) {
            if (!client->fragmentOpcode) {
                sendFrame(client, 0x8, closePayload(1002), true);
                return;
            }
            if (client->fragmentedMessage.size() + payload.size() > maxInspectorMessageSize) {
                sendFrame(client, 0x8, closePayload(1009), true);
                return;
            }
            client->fragmentedMessage += payload;
            if (!final)
                continue;
            message.swap(client->fragmentedMessage);
            client->fragmentOpcode = 0;
        } else {
            sendFrame(client, 0x8, closePayload(1002), true);
            return;
        }

        if (!utf8IsValid(message)) {
            sendFrame(client, 0x8, closePayload(1007), true);
            return;
        }
        enqueue({ InspectorEventType::Message, client->id, nullptr, std::move(message) });
    }
}

void InspectorServer::processInput(const std::shared_ptr<InspectorClient>& client)
{
    if (client->upgraded)
        processFrames(client);
    else
        processHttp(client);
}

static void inspectorAllocate(uv_handle_t*, size_t suggestedSize, uv_buf_t* buffer)
{
    const size_t size = std::max<size_t>(suggestedSize, 4096);
    buffer->base = new (std::nothrow) char[size];
    buffer->len = buffer->base ? size : 0;
}

static void inspectorRead(uv_stream_t* stream, ssize_t count, const uv_buf_t* buffer)
{
    std::unique_ptr<char[]> storage(buffer->base);
    auto* rawClient = static_cast<InspectorClient*>(stream->data);
    if (!rawClient || !rawClient->server)
        return;
    auto iterator = rawClient->server->clients.find(rawClient);
    if (iterator == rawClient->server->clients.end())
        return;
    auto client = iterator->second;
    if (count <= 0) {
        if (count < 0)
            rawClient->server->closeClient(client);
        return;
    }
    if (client->input.size() + static_cast<size_t>(count) > maxInspectorMessageSize + maxHttpHeaderSize) {
        rawClient->server->closeClient(client);
        return;
    }
    const auto* bytes = reinterpret_cast<const unsigned char*>(buffer->base);
    client->input.insert(client->input.end(), bytes, bytes + count);
    rawClient->server->processInput(client);
}

static void inspectorAccepted(uv_stream_t* listener, int status)
{
    auto* server = static_cast<InspectorServer*>(listener->data);
    if (!server || status < 0 || server->stopRequested.load(std::memory_order_acquire))
        return;
    const uint64_t id = server->inspector->nextConnectionId.fetch_add(1, std::memory_order_relaxed);
    const auto streamKind = server->unixSocket ? InspectorStreamKind::Pipe : InspectorStreamKind::Tcp;
    auto client = std::make_shared<InspectorClient>(server, id, streamKind);
    const int initStatus = server->unixSocket
        ? uv_pipe_init(&server->loop, &client->pipeHandle, 0)
        : uv_tcp_init(&server->loop, &client->tcpHandle);
    if (initStatus < 0)
        return;
    client->stream = server->unixSocket
        ? reinterpret_cast<uv_stream_t*>(&client->pipeHandle)
        : reinterpret_cast<uv_stream_t*>(&client->tcpHandle);
    client->stream->data = client.get();
    server->clients.emplace(client.get(), client);
    if (uv_accept(listener, client->stream) < 0) {
        server->closeClient(client, false);
        return;
    }
    if (uv_read_start(client->stream, inspectorAllocate, inspectorRead) < 0)
        server->closeClient(client, false);
}

static void inspectorAsync(uv_async_t* handle)
{
    auto* server = static_cast<InspectorServer*>(handle->data);
    if (!server)
        return;
    if (server->stopRequested.load(std::memory_order_acquire)) {
        std::vector<std::shared_ptr<InspectorClient>> clients;
        clients.reserve(server->clients.size());
        for (auto& entry : server->clients)
            clients.push_back(entry.second);
        for (auto& client : clients)
            server->closeClient(client);
        auto* listenerHandle = reinterpret_cast<uv_handle_t*>(server->listenerStream());
        if (server->listenerInitialized && !uv_is_closing(listenerHandle))
            uv_close(listenerHandle, nullptr);
        if (!uv_is_closing(reinterpret_cast<uv_handle_t*>(&server->async)))
            uv_close(reinterpret_cast<uv_handle_t*>(&server->async), nullptr);
        return;
    }

    std::vector<std::shared_ptr<InspectorClient>> clients;
    clients.reserve(server->clients.size());
    for (auto& entry : server->clients)
        clients.push_back(entry.second);
    for (auto& client : clients) {
        if (client->closeRequested.load(std::memory_order_acquire))
            server->closeClient(client);
        else
            server->flushOutput(client);
    }
}

struct ResolveResult {
    sockaddr_storage address { };
    bool resolved { false };
    std::string error;
};

static void inspectorResolved(uv_getaddrinfo_t* request, int status, addrinfo* addresses)
{
    auto* result = static_cast<ResolveResult*>(request->data);
    if (status < 0) {
        result->error = uv_strerror(status);
        return;
    }
    for (auto* address = addresses; address; address = address->ai_next) {
        if (address->ai_family != AF_INET && address->ai_family != AF_INET6)
            continue;
        const size_t size = address->ai_family == AF_INET ? sizeof(sockaddr_in) : sizeof(sockaddr_in6);
        std::memcpy(&result->address, address->ai_addr, size);
        result->resolved = true;
        break;
    }
    uv_freeaddrinfo(addresses);
}

static void inspectorThread(void* opaque)
{
    auto* server = static_cast<InspectorServer*>(opaque);
    int status = uv_loop_init(&server->loop);
    if (status < 0) {
        server->startupError = uv_strerror(status);
        uv_sem_post(&server->started);
        return;
    }
    server->loopInitialized = true;

    ResolveResult resolved;
    if (server->unixSocket) {
        status = uv_pipe_init(&server->loop, &server->pipeListener, 0);
        if (status >= 0) {
            server->listenerInitialized = true;
            server->pipeListener.data = server;
            status = uv_pipe_bind(&server->pipeListener, server->unixPath.c_str());
            if (status >= 0)
                server->unixPathBound = true;
        }
    } else {
        uv_getaddrinfo_t resolver { };
        resolver.data = &resolved;
        addrinfo hints { };
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_protocol = IPPROTO_TCP;
        const std::string service = std::to_string(server->requestedPort);
        status = uv_getaddrinfo(&server->loop, &resolver, inspectorResolved, server->host.c_str(), service.c_str(), &hints);
        if (status >= 0)
            uv_run(&server->loop, UV_RUN_DEFAULT);
        if (status < 0 || !resolved.resolved) {
            server->startupError = status < 0 ? uv_strerror(status) : (resolved.error.empty() ? "Unable to resolve inspector host" : resolved.error);
            uv_sem_post(&server->started);
            uv_loop_close(&server->loop);
            server->loopInitialized = false;
            return;
        }

        status = uv_tcp_init(&server->loop, &server->tcpListener);
        if (status >= 0) {
            server->listenerInitialized = true;
            server->tcpListener.data = server;
            status = uv_tcp_bind(&server->tcpListener, reinterpret_cast<const sockaddr*>(&resolved.address), 0);
        }
    }
    if (status >= 0)
        status = uv_listen(server->listenerStream(), 128, inspectorAccepted);
    if (status >= 0) {
        status = uv_async_init(&server->loop, &server->async, inspectorAsync);
        if (status >= 0) {
            server->asyncInitialized.store(true, std::memory_order_release);
            server->async.data = server;
        }
    }
    if (status < 0) {
        server->startupError = uv_strerror(status);
        auto* listenerHandle = reinterpret_cast<uv_handle_t*>(server->listenerStream());
        if (server->listenerInitialized && !uv_is_closing(listenerHandle))
            uv_close(listenerHandle, nullptr);
        uv_run(&server->loop, UV_RUN_DEFAULT);
        uv_sem_post(&server->started);
        uv_loop_close(&server->loop);
        server->loopInitialized = false;
        return;
    }

    if (server->unixSocket) {
        server->url = "ws+unix://" + server->unixPath;
    } else {
        sockaddr_storage socketAddress { };
        int socketLength = sizeof(socketAddress);
        if (uv_tcp_getsockname(&server->tcpListener, reinterpret_cast<sockaddr*>(&socketAddress), &socketLength) == 0) {
            if (socketAddress.ss_family == AF_INET)
                server->boundPort = ntohs(reinterpret_cast<sockaddr_in*>(&socketAddress)->sin_port);
            else if (socketAddress.ss_family == AF_INET6)
                server->boundPort = ntohs(reinterpret_cast<sockaddr_in6*>(&socketAddress)->sin6_port);
        }
        std::string displayHost = server->host;
        if (displayHost.find(':') != std::string::npos && (displayHost.empty() || displayHost.front() != '['))
            displayHost = "[" + displayHost + "]";
        server->url = "ws://" + displayHost + ":" + std::to_string(server->boundPort) + server->path;
    }
    uv_sem_post(&server->started);

    uv_run(&server->loop, UV_RUN_DEFAULT);
    server->asyncInitialized.store(false, std::memory_order_release);
    server->listenerInitialized = false;
    uv_loop_close(&server->loop);
    server->loopInitialized = false;
}

bool InspectorServer::start()
{
    if (uv_sem_init(&started, 0) < 0) {
        startupError = "Unable to initialize inspector startup synchronization";
        return false;
    }
    const int status = uv_thread_create(&thread, inspectorThread, this);
    if (status < 0) {
        startupError = uv_strerror(status);
        uv_sem_destroy(&started);
        return false;
    }
    threadCreated = true;
    uv_sem_wait(&started);
    uv_sem_destroy(&started);
    if (!startupError.empty()) {
        uv_thread_join(&thread);
        threadCreated = false;
        if (unixPathBound && !unixPath.empty()) {
            std::remove(unixPath.c_str());
            unixPathBound = false;
        }
        return false;
    }
    return true;
}

void InspectorServer::stop()
{
    if (!threadCreated)
        return;
    stopRequested.store(true, std::memory_order_release);
    if (asyncInitialized.load(std::memory_order_acquire))
        uv_async_send(&async);
    uv_thread_join(&thread);
    threadCreated = false;
    if (unixPathBound && !unixPath.empty()) {
        std::remove(unixPath.c_str());
        unixPathBound = false;
    }
}

struct FramedWriteRequest {
    uv_write_t request;
    std::vector<char> bytes;
};

static void closeOwnedFd(int fd)
{
    if (fd < 0)
        return;
#if defined(_WIN32)
    _close(fd);
#else
    close(fd);
#endif
}

void FramedInspectorClient::postStarted()
{
    if (startedPosted)
        return;
    startedPosted = true;
    uv_sem_post(&started);
}

void FramedInspectorClient::closeOnLoop(bool notifyInspector)
{
    if (closing.exchange(true, std::memory_order_acq_rel))
        return;
    if (notifyInspector && opened && !closeEventSent) {
        closeEventSent = true;
        inspector->enqueue({ InspectorEventType::Close, connectionId, nullptr, {} });
    }
    if (streamInitialized) {
        uv_read_stop(stream);
        auto* handle = reinterpret_cast<uv_handle_t*>(stream);
        if (!uv_is_closing(handle))
            uv_close(handle, nullptr);
    }
    if (asyncInitialized.load(std::memory_order_acquire)) {
        auto* handle = reinterpret_cast<uv_handle_t*>(&async);
        if (!uv_is_closing(handle))
            uv_close(handle, nullptr);
    }
}

static void framedWriteComplete(uv_write_t* request, int status)
{
    auto* write = reinterpret_cast<FramedWriteRequest*>(request);
    auto* client = static_cast<FramedInspectorClient*>(request->handle->data);
    delete write;
    if (status < 0 && client)
        client->closeOnLoop();
}

void FramedInspectorClient::flushOutput()
{
    std::deque<std::string> messages;
    {
        std::lock_guard lock(outputMutex);
        messages.swap(output);
        queuedOutputSize = 0;
    }
    for (auto& message : messages) {
        auto* write = new (std::nothrow) FramedWriteRequest;
        if (!write) {
            closeOnLoop();
            return;
        }
        const uint32_t size = static_cast<uint32_t>(message.size());
        write->bytes.reserve(message.size() + 4);
        write->bytes.push_back(static_cast<char>((size >> 24) & 0xff));
        write->bytes.push_back(static_cast<char>((size >> 16) & 0xff));
        write->bytes.push_back(static_cast<char>((size >> 8) & 0xff));
        write->bytes.push_back(static_cast<char>(size & 0xff));
        write->bytes.insert(write->bytes.end(), message.begin(), message.end());
        const size_t queued = uv_stream_get_write_queue_size(stream);
        if (queued > maxQueuedOutputSize || write->bytes.size() > maxQueuedOutputSize - queued) {
            delete write;
            closeOnLoop();
            return;
        }
        uv_buf_t buffer = uv_buf_init(write->bytes.data(), static_cast<unsigned int>(write->bytes.size()));
        const int status = uv_write(&write->request, stream, &buffer, 1, framedWriteComplete);
        if (status < 0) {
            delete write;
            closeOnLoop();
            return;
        }
    }
}

void FramedInspectorClient::enqueueOutput(std::string&& message)
{
    if (closing.load(std::memory_order_acquire) || message.size() > maxInspectorMessageSize)
        return;
    {
        std::lock_guard lock(outputMutex);
        if (message.size() > maxQueuedOutputSize - queuedOutputSize) {
            output.clear();
            queuedOutputSize = 0;
            closeRequested.store(true, std::memory_order_release);
        } else {
            queuedOutputSize += message.size();
            output.push_back(std::move(message));
        }
    }
    if (asyncInitialized.load(std::memory_order_acquire))
        uv_async_send(&async);
}

void FramedInspectorClient::processInput()
{
    while (input.size() >= 4) {
        const uint32_t length = (static_cast<uint32_t>(input[0]) << 24)
            | (static_cast<uint32_t>(input[1]) << 16)
            | (static_cast<uint32_t>(input[2]) << 8)
            | static_cast<uint32_t>(input[3]);
        if (length > maxInspectorMessageSize) {
            closeOnLoop();
            return;
        }
        const size_t frameLength = static_cast<size_t>(length) + 4;
        if (input.size() < frameLength)
            return;
        std::string message(input.begin() + 4, input.begin() + frameLength);
        input.erase(input.begin(), input.begin() + frameLength);
        if (message.find('\0') != std::string::npos || !utf8IsValid(message)) {
            closeOnLoop();
            return;
        }
        inspector->enqueue({ InspectorEventType::Message, connectionId, nullptr, std::move(message) });
    }
}

static void framedRead(uv_stream_t* stream, ssize_t count, const uv_buf_t* buffer)
{
    std::unique_ptr<char[]> storage(buffer->base);
    auto* client = static_cast<FramedInspectorClient*>(stream->data);
    if (!client)
        return;
    if (count <= 0) {
        if (count < 0)
            client->closeOnLoop();
        return;
    }
    if (client->input.size() + static_cast<size_t>(count) > maxInspectorMessageSize + 4) {
        client->closeOnLoop();
        return;
    }
    const auto* bytes = reinterpret_cast<const unsigned char*>(buffer->base);
    client->input.insert(client->input.end(), bytes, bytes + count);
    client->processInput();
}

void FramedInspectorClient::connected(int status)
{
    if (status < 0) {
        startupError = uv_strerror(status);
        postStarted();
        closeOnLoop(false);
        return;
    }
    status = uv_read_start(stream, inspectorAllocate, framedRead);
    if (status < 0) {
        startupError = uv_strerror(status);
        postStarted();
        closeOnLoop(false);
        return;
    }
    opened = true;
    auto sink = std::make_shared<FramedMessageSink>(weak_from_this());
    inspector->enqueue({ InspectorEventType::Open, connectionId, std::move(sink), {} });
    postStarted();
}

static void framedConnected(uv_connect_t* request, int status)
{
    auto* client = static_cast<FramedInspectorClient*>(request->data);
    delete request;
    if (client)
        client->connected(status);
}

static void framedAsync(uv_async_t* handle)
{
    auto* client = static_cast<FramedInspectorClient*>(handle->data);
    if (!client)
        return;
    if (client->stopRequested.load(std::memory_order_acquire)
        || client->closeRequested.load(std::memory_order_acquire)) {
        client->closeOnLoop();
        return;
    }
    client->flushOutput();
}

static void framedInspectorThread(void* opaque)
{
    auto* client = static_cast<FramedInspectorClient*>(opaque);
    int status = uv_loop_init(&client->loop);
    if (status < 0) {
        client->startupError = uv_strerror(status);
        client->postStarted();
        closeOwnedFd(std::exchange(client->ownedFd, -1));
        return;
    }
    client->loopInitialized = true;

    ResolveResult resolved;
    if (client->kind == FramedTransportKind::Tcp) {
        uv_getaddrinfo_t resolver { };
        resolver.data = &resolved;
        addrinfo hints { };
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_protocol = IPPROTO_TCP;
        const std::string service = std::to_string(client->port);
        status = uv_getaddrinfo(&client->loop, &resolver, inspectorResolved, client->host.c_str(), service.c_str(), &hints);
        if (status >= 0)
            uv_run(&client->loop, UV_RUN_DEFAULT);
        if (status < 0 || !resolved.resolved) {
            client->startupError = status < 0 ? uv_strerror(status) : (resolved.error.empty() ? "Unable to resolve inspector host" : resolved.error);
            client->postStarted();
            uv_loop_close(&client->loop);
            client->loopInitialized = false;
            return;
        }
    }

    if (client->kind == FramedTransportKind::Tcp) {
        status = uv_tcp_init(&client->loop, &client->tcpHandle);
        client->stream = reinterpret_cast<uv_stream_t*>(&client->tcpHandle);
    } else {
        status = uv_pipe_init(&client->loop, &client->pipeHandle, 0);
        client->stream = reinterpret_cast<uv_stream_t*>(&client->pipeHandle);
    }
    if (status >= 0) {
        client->streamInitialized = true;
        client->stream->data = client;
        status = uv_async_init(&client->loop, &client->async, framedAsync);
    }
    if (status >= 0) {
        client->asyncInitialized.store(true, std::memory_order_release);
        client->async.data = client;
    }
    if (status < 0) {
        client->startupError = uv_strerror(status);
        client->postStarted();
        closeOwnedFd(std::exchange(client->ownedFd, -1));
        client->closeOnLoop(false);
        uv_run(&client->loop, UV_RUN_DEFAULT);
        uv_loop_close(&client->loop);
        client->loopInitialized = false;
        return;
    }

    if (client->kind == FramedTransportKind::FileDescriptor) {
        status = uv_pipe_open(&client->pipeHandle, client->ownedFd);
        if (status >= 0)
            client->ownedFd = -1;
        client->connected(status);
    } else {
        auto* request = new (std::nothrow) uv_connect_t;
        if (!request) {
            client->startupError = "Out of memory connecting inspector transport";
            client->postStarted();
            client->closeOnLoop(false);
        } else {
            request->data = client;
            if (client->kind == FramedTransportKind::Tcp) {
                status = uv_tcp_connect(request, &client->tcpHandle, reinterpret_cast<const sockaddr*>(&resolved.address), framedConnected);
                if (status < 0) {
                    delete request;
                    client->connected(status);
                }
            } else {
                uv_pipe_connect(request, &client->pipeHandle, client->unixPath.c_str(), framedConnected);
            }
        }
    }

    uv_run(&client->loop, UV_RUN_DEFAULT);
    closeOwnedFd(std::exchange(client->ownedFd, -1));
    client->asyncInitialized.store(false, std::memory_order_release);
    client->streamInitialized = false;
    uv_loop_close(&client->loop);
    client->loopInitialized = false;
}

bool FramedInspectorClient::start()
{
    connectionId = inspector->nextConnectionId.fetch_add(1, std::memory_order_relaxed);
    if (uv_sem_init(&started, 0) < 0) {
        startupError = "Unable to initialize inspector startup synchronization";
        closeOwnedFd(std::exchange(ownedFd, -1));
        return false;
    }
    const int status = uv_thread_create(&thread, framedInspectorThread, this);
    if (status < 0) {
        startupError = uv_strerror(status);
        uv_sem_destroy(&started);
        closeOwnedFd(std::exchange(ownedFd, -1));
        return false;
    }
    threadCreated = true;
    uv_sem_wait(&started);
    uv_sem_destroy(&started);
    if (!startupError.empty()) {
        uv_thread_join(&thread);
        threadCreated = false;
        return false;
    }
    return true;
}

void FramedInspectorClient::stop()
{
    if (!threadCreated)
        return;
    stopRequested.store(true, std::memory_order_release);
    if (asyncInitialized.load(std::memory_order_acquire))
        uv_async_send(&async);
    uv_thread_join(&thread);
    threadCreated = false;
}

struct InspectorNotification {
    uv_loop_t loop { };
    uv_tcp_t tcpHandle { };
    uv_pipe_t pipeHandle { };
    uv_stream_t* stream { nullptr };
    uv_connect_t connectRequest { };
    uv_write_t writeRequest { };
    uv_timer_t timer { };
    bool streamInitialized { false };
    bool timerInitialized { false };
    bool finished { false };
    bool delivered { false };
};

static void finishInspectorNotification(InspectorNotification* notification)
{
    if (!notification || notification->finished)
        return;
    notification->finished = true;
    if (notification->timerInitialized) {
        uv_timer_stop(&notification->timer);
        auto* timer = reinterpret_cast<uv_handle_t*>(&notification->timer);
        if (!uv_is_closing(timer))
            uv_close(timer, nullptr);
    }
    if (notification->streamInitialized) {
        auto* stream = reinterpret_cast<uv_handle_t*>(notification->stream);
        if (!uv_is_closing(stream))
            uv_close(stream, nullptr);
    }
}

static void inspectorNotificationWritten(uv_write_t* request, int status)
{
    auto* notification = static_cast<InspectorNotification*>(request->data);
    if (notification)
        notification->delivered = status >= 0;
    finishInspectorNotification(notification);
}

static void inspectorNotificationConnected(uv_connect_t* request, int status)
{
    auto* notification = static_cast<InspectorNotification*>(request->data);
    if (!notification || notification->finished)
        return;
    if (status < 0) {
        finishInspectorNotification(notification);
        return;
    }
    static char byte = '1';
    uv_buf_t buffer = uv_buf_init(&byte, 1);
    notification->writeRequest.data = notification;
    if (uv_write(&notification->writeRequest, notification->stream, &buffer, 1, inspectorNotificationWritten) < 0)
        finishInspectorNotification(notification);
}

static void inspectorNotificationTimedOut(uv_timer_t* timer)
{
    finishInspectorNotification(static_cast<InspectorNotification*>(timer->data));
}

static int sendInspectorNotification(
    const char* host,
    uint16_t port,
    const char* unixPath)
{
    InspectorNotification notification;
    if (uv_loop_init(&notification.loop) < 0)
        return -1;

    ResolveResult resolved;
    int status = 0;
    if (!unixPath) {
        uv_getaddrinfo_t resolver { };
        resolver.data = &resolved;
        addrinfo hints { };
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_protocol = IPPROTO_TCP;
        const std::string service = std::to_string(port);
        status = uv_getaddrinfo(&notification.loop, &resolver, inspectorResolved, host, service.c_str(), &hints);
        if (status >= 0)
            uv_run(&notification.loop, UV_RUN_DEFAULT);
        if (status < 0 || !resolved.resolved) {
            uv_loop_close(&notification.loop);
            return -1;
        }
    }

    if (unixPath) {
        status = uv_pipe_init(&notification.loop, &notification.pipeHandle, 0);
        notification.stream = reinterpret_cast<uv_stream_t*>(&notification.pipeHandle);
    } else {
        status = uv_tcp_init(&notification.loop, &notification.tcpHandle);
        notification.stream = reinterpret_cast<uv_stream_t*>(&notification.tcpHandle);
    }
    if (status >= 0) {
        notification.streamInitialized = true;
        notification.stream->data = &notification;
        status = uv_timer_init(&notification.loop, &notification.timer);
    }
    if (status >= 0) {
        notification.timerInitialized = true;
        notification.timer.data = &notification;
        status = uv_timer_start(&notification.timer, inspectorNotificationTimedOut, 1000, 0);
    }
    if (status < 0) {
        finishInspectorNotification(&notification);
        uv_run(&notification.loop, UV_RUN_DEFAULT);
        uv_loop_close(&notification.loop);
        return -1;
    }

    notification.connectRequest.data = &notification;
    if (unixPath) {
        uv_pipe_connect(
            &notification.connectRequest,
            &notification.pipeHandle,
            unixPath,
            inspectorNotificationConnected);
    } else {
        status = uv_tcp_connect(
            &notification.connectRequest,
            &notification.tcpHandle,
            reinterpret_cast<const sockaddr*>(&resolved.address),
            inspectorNotificationConnected);
        if (status < 0)
            finishInspectorNotification(&notification);
    }

    uv_run(&notification.loop, UV_RUN_DEFAULT);
    uv_loop_close(&notification.loop);
    return notification.delivered ? 0 : -1;
}

}

extern "C" int ct_jsc_inspector_notify_tcp(const char* host, uint16_t port)
{
    if (!host || !host[0] || !port)
        return -1;
    return sendInspectorNotification(host, port, nullptr);
}

extern "C" int ct_jsc_inspector_notify_unix(const char* unixPath)
{
    if (!unixPath || !unixPath[0])
        return -1;
    return sendInspectorNotification(nullptr, 0, unixPath);
}

extern "C" int ct_jsc_inspector_emit(CtJscInspector* inspector, const char* method, const char* paramsJson)
{
    if (!inspector || inspector->closing.load(std::memory_order_acquire) || !method || !paramsJson)
        return -1;
    const CustomInspectorDomain domain = customDomainForMethod(method);
    if (domain == CustomInspectorDomain::None || !utf8IsValid(method) || !utf8IsValid(paramsJson))
        return -1;
    std::string message = "{\"method\":\"";
    message += jsonEscape(method);
    message += "\",\"params\":";
    message += paramsJson;
    message += '}';
    const bool replayable = std::strcmp(method, "TestReporter.found") == 0;
    inspector->enqueue({ InspectorEventType::Notification, 0, nullptr, std::move(message), domain, replayable });
    return 0;
}

extern "C" int ct_jsc_inspector_set_module_graph(CtJscInspector* inspector, const char* graphJson)
{
    if (!inspector || inspector->closing.load(std::memory_order_acquire) || !graphJson || !utf8IsValid(graphJson))
        return -1;
    std::lock_guard lock(inspector->moduleGraphMutex);
    inspector->moduleGraph = graphJson;
    return 0;
}

extern "C" CtJscInspector* ct_jsc_inspector_create(JSGlobalContextRef context, char** errorOut)
{
    if (errorOut)
        *errorOut = nullptr;
    if (!context) {
        if (errorOut)
            *errorOut = duplicateCString("JavaScriptCore context is unavailable");
        return nullptr;
    }
    auto* inspector = new (std::nothrow) CtJscInspector(context);
    if (!inspector) {
        if (errorOut)
            *errorOut = duplicateCString("Out of memory creating inspector state");
        return nullptr;
    }
    std::string error;
    if (!inspector->ensureController(error)) {
        if (errorOut)
            *errorOut = duplicateCString(error);
        delete inspector;
        return nullptr;
    }
    return inspector;
}

extern "C" void ct_jsc_inspector_destroy(CtJscInspector* inspector)
{
    if (!inspector)
        return;
    {
        std::lock_guard lock(inspector->eventMutex);
        if (inspector->closing.exchange(true, std::memory_order_acq_rel))
            return;
    }
    if (inspector->server) {
        inspector->server->stop();
        inspector->server.reset();
    }
    if (inspector->framedClient) {
        inspector->framedClient->stop();
        inspector->framedClient.reset();
    }
    while (inspector->eventTaskScheduled.load(std::memory_order_acquire))
        ct_jsc_run_loop_cycle();
    {
        std::lock_guard lock(inspector->localSinkMutex);
        inspector->localSinks.clear();
    }
    inspector->destroyController();
    inspector->release();
}

extern "C" void ct_jsc_inspector_retain(CtJscInspector* inspector)
{
    if (inspector)
        inspector->retain();
}

extern "C" void ct_jsc_inspector_release(CtJscInspector* inspector)
{
    if (inspector)
        inspector->release();
}

extern "C" int ct_jsc_inspector_start_server(
    CtJscInspector* inspector,
    const char* host,
    uint16_t port,
    const char* path,
    bool pauseOnStart,
    char** urlOut,
    char** errorOut)
{
    if (urlOut)
        *urlOut = nullptr;
    if (errorOut)
        *errorOut = nullptr;
    if (!inspector || inspector->closing.load(std::memory_order_acquire) || !host || !path || path[0] != '/') {
        if (errorOut)
            *errorOut = duplicateCString("Invalid inspector server configuration");
        return -1;
    }
    if (inspector->hasTransport()) {
        if (errorOut)
            *errorOut = duplicateCString("Inspector transport is already active");
        return -1;
    }
    std::string error;
    if (!inspector->ensureController(error)) {
        if (errorOut)
            *errorOut = duplicateCString(error);
        return -1;
    }
    inspector->pauseOnStart = pauseOnStart;
    inspector->pauseConsumed = false;
    auto server = std::make_shared<InspectorServer>(inspector, host, port, path);
    if (!server->start()) {
        if (errorOut)
            *errorOut = duplicateCString(server->startupError);
        return -1;
    }
    inspector->serverUrl = server->url;
    inspector->server = std::move(server);
    if (urlOut)
        *urlOut = duplicateCString(inspector->serverUrl);
    return 0;
}

extern "C" int ct_jsc_inspector_start_unix_server(
    CtJscInspector* inspector,
    const char* unixPath,
    bool pauseOnStart,
    char** urlOut,
    char** errorOut)
{
    if (urlOut)
        *urlOut = nullptr;
    if (errorOut)
        *errorOut = nullptr;
    if (!inspector || inspector->closing.load(std::memory_order_acquire) || !unixPath || !unixPath[0]) {
        if (errorOut)
            *errorOut = duplicateCString("Invalid inspector Unix server configuration");
        return -1;
    }
    if (inspector->hasTransport()) {
        if (errorOut)
            *errorOut = duplicateCString("Inspector transport is already active");
        return -1;
    }
    std::string error;
    if (!inspector->ensureController(error)) {
        if (errorOut)
            *errorOut = duplicateCString(error);
        return -1;
    }
    inspector->pauseOnStart = pauseOnStart;
    inspector->pauseConsumed = false;
    auto server = std::make_shared<InspectorServer>(inspector, unixPath);
    if (!server->start()) {
        if (errorOut)
            *errorOut = duplicateCString(server->startupError);
        return -1;
    }
    inspector->serverUrl = server->url;
    inspector->server = std::move(server);
    if (urlOut)
        *urlOut = duplicateCString(inspector->serverUrl);
    return 0;
}

static int startFramedInspectorClient(
    CtJscInspector* inspector,
    std::shared_ptr<FramedInspectorClient> client,
    bool pauseOnStart,
    char** errorOut)
{
    if (errorOut)
        *errorOut = nullptr;
    if (!inspector || inspector->closing.load(std::memory_order_acquire) || !client) {
        if (errorOut)
            *errorOut = duplicateCString("Invalid framed inspector configuration");
        return -1;
    }
    if (inspector->hasTransport()) {
        if (errorOut)
            *errorOut = duplicateCString("Inspector transport is already active");
        return -1;
    }
    std::string error;
    if (!inspector->ensureController(error)) {
        if (errorOut)
            *errorOut = duplicateCString(error);
        return -1;
    }
    inspector->pauseOnStart = pauseOnStart;
    inspector->pauseConsumed = false;
    if (!client->start()) {
        if (errorOut)
            *errorOut = duplicateCString(client->startupError);
        return -1;
    }
    inspector->framedClient = std::move(client);
    inspector->serverUrl.clear();
    return 0;
}

extern "C" int ct_jsc_inspector_connect_tcp(
    CtJscInspector* inspector,
    const char* host,
    uint16_t port,
    bool pauseOnStart,
    char** errorOut)
{
    if (!host || !host[0] || !port) {
        if (errorOut)
            *errorOut = duplicateCString("Invalid inspector TCP connection configuration");
        return -1;
    }
    return startFramedInspectorClient(
        inspector,
        std::make_shared<FramedInspectorClient>(inspector, host, port),
        pauseOnStart,
        errorOut);
}

extern "C" int ct_jsc_inspector_connect_unix(
    CtJscInspector* inspector,
    const char* unixPath,
    bool pauseOnStart,
    char** errorOut)
{
    if (!unixPath || !unixPath[0]) {
        if (errorOut)
            *errorOut = duplicateCString("Invalid inspector Unix connection configuration");
        return -1;
    }
    return startFramedInspectorClient(
        inspector,
        std::make_shared<FramedInspectorClient>(inspector, unixPath),
        pauseOnStart,
        errorOut);
}

extern "C" int ct_jsc_inspector_connect_fd(
    CtJscInspector* inspector,
    int fd,
    bool pauseOnStart,
    char** errorOut)
{
#if defined(_WIN32)
    const int ownedFd = _dup(fd);
#else
    const int ownedFd = dup(fd);
#endif
    if (ownedFd < 0) {
        if (errorOut)
            *errorOut = duplicateCString(std::strerror(errno));
        return -1;
    }
    return startFramedInspectorClient(
        inspector,
        std::make_shared<FramedInspectorClient>(inspector, ownedFd),
        pauseOnStart,
        errorOut);
}

extern "C" void ct_jsc_inspector_stop_server(CtJscInspector* inspector)
{
    if (!inspector)
        return;
    if (inspector->server) {
        inspector->server->stop();
        inspector->server.reset();
    }
    if (inspector->framedClient) {
        inspector->framedClient->stop();
        inspector->framedClient.reset();
    }
    inspector->serverUrl.clear();
}

extern "C" char* ct_jsc_inspector_copy_url(CtJscInspector* inspector)
{
    if (!inspector || !inspector->server || inspector->serverUrl.empty())
        return nullptr;
    return duplicateCString(inspector->serverUrl);
}

extern "C" bool ct_jsc_inspector_has_server(CtJscInspector* inspector)
{
    return inspector && inspector->hasTransport();
}

extern "C" bool ct_jsc_inspector_has_remote_connection(CtJscInspector* inspector)
{
    return inspector && inspector->remoteConnectionCount.load(std::memory_order_acquire) > 0;
}

extern "C" bool ct_jsc_inspector_keeps_event_loop_alive(CtJscInspector* inspector)
{
    return inspector && inspector->framedClient
        && !inspector->framedClient->closing.load(std::memory_order_acquire);
}

extern "C" int ct_jsc_inspector_wait_for_connection(CtJscInspector* inspector)
{
    if (!inspector || !inspector->hasTransport())
        return -1;
    while (inspector->hasTransport() && !inspector->closing.load(std::memory_order_acquire)
        && (!inspector->framedClient || !inspector->framedClient->closing.load(std::memory_order_acquire))
        && inspector->remoteConnectionCount.load(std::memory_order_acquire) == 0) {
        ct_jsc_run_loop_cycle();
        uv_sleep(1);
    }
    return inspector->remoteConnectionCount.load(std::memory_order_acquire) > 0 ? 0 : -1;
}

extern "C" uint64_t ct_jsc_inspector_connect_local(CtJscInspector* inspector)
{
    if (!inspector)
        return 0;
    const uint64_t id = inspector->nextConnectionId.fetch_add(1, std::memory_order_relaxed);
    auto sink = std::make_shared<LocalMessageSink>();
    {
        std::lock_guard lock(inspector->localSinkMutex);
        if (inspector->closing.load(std::memory_order_acquire))
            return 0;
        inspector->localSinks.emplace(id, sink);
    }
    inspector->enqueue({ InspectorEventType::Open, id, std::move(sink), {} });
    return id;
}

extern "C" int ct_jsc_inspector_send_local(CtJscInspector* inspector, uint64_t id, const char* message)
{
    if (!inspector || !id || !message || !utf8IsValid(message))
        return -1;
    {
        std::lock_guard lock(inspector->localSinkMutex);
        if (inspector->closing.load(std::memory_order_acquire) || !inspector->localSinks.contains(id))
            return -1;
    }
    inspector->enqueue({ InspectorEventType::Message, id, nullptr, message });
    return 0;
}

extern "C" char** ct_jsc_inspector_take_local_messages(CtJscInspector* inspector, uint64_t id, size_t* countOut)
{
    if (countOut)
        *countOut = 0;
    if (!inspector || !id)
        return nullptr;
    std::shared_ptr<LocalMessageSink> sink;
    {
        std::lock_guard lock(inspector->localSinkMutex);
        auto iterator = inspector->localSinks.find(id);
        if (iterator == inspector->localSinks.end())
            return nullptr;
        sink = iterator->second;
    }
    auto messages = sink->take();
    if (messages.empty())
        return nullptr;
    char** output = static_cast<char**>(std::calloc(messages.size(), sizeof(char*)));
    if (!output)
        return nullptr;
    for (size_t index = 0; index < messages.size(); ++index) {
        output[index] = duplicateCString(messages[index]);
        if (!output[index]) {
            for (size_t previous = 0; previous < index; ++previous)
                std::free(output[previous]);
            std::free(output);
            return nullptr;
        }
    }
    if (countOut)
        *countOut = messages.size();
    return output;
}

extern "C" void ct_jsc_inspector_free_messages(char** messages, size_t count)
{
    if (!messages)
        return;
    for (size_t index = 0; index < count; ++index)
        std::free(messages[index]);
    std::free(messages);
}

extern "C" void ct_jsc_inspector_disconnect_local(CtJscInspector* inspector, uint64_t id)
{
    if (!inspector || !id)
        return;
    {
        std::lock_guard lock(inspector->localSinkMutex);
        inspector->localSinks.erase(id);
    }
    if (!inspector->closing.load(std::memory_order_acquire))
        inspector->enqueue({ InspectorEventType::Close, id, nullptr, {} });
}
