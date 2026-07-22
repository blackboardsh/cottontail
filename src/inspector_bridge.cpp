#include <JavaScriptCore/JSContextRef.h>
#include <JavaScriptCore/JSStringRef.h>

#include <openssl/evp.h>
#include <uv.h>

#include <wtf/ThreadSafeRefCounted.h>
#include <wtf/text/StringImpl.h>

#include <algorithm>
#include <atomic>
#include <bit>
#include <cctype>
#include <cstddef>
#include <cstdint>
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

private:
    alignas(std::max_align_t) unsigned char m_storage[4096];
};

}

namespace {

constexpr size_t maxInspectorMessageSize = 16 * 1024 * 1024;
constexpr size_t maxHttpHeaderSize = 64 * 1024;
constexpr size_t maxQueuedOutputSize = 32 * 1024 * 1024;

struct CtJscInspector;
struct InspectorServer;
struct InspectorClient;

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

private:
    uint64_t m_id;
    std::shared_ptr<MessageSink> m_sink;
};

enum class InspectorEventType {
    Open,
    Message,
    Close,
};

struct InspectorEvent {
    InspectorEventType type;
    uint64_t id;
    std::shared_ptr<MessageSink> sink;
    std::string message;
};

struct CtJscInspector {
    explicit CtJscInspector(JSGlobalContextRef context)
        : context(context)
        , runLoop(ct_jsc_run_loop_current())
    {
    }

    JSGlobalContextRef context;
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
    std::string serverUrl;
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
    void destroyController();
};

static void processInspectorEvents(void* opaque)
{
    static_cast<CtJscInspector*>(opaque)->processEvents();
}

void CtJscInspector::enqueue(InspectorEvent&& event)
{
    {
        std::lock_guard lock(eventMutex);
        events.push_back(std::move(event));
        if (eventTaskScheduled.exchange(true, std::memory_order_acq_rel))
            return;
    }
    ct_jsc_run_loop_dispatch(runLoop, processInspectorEvents, this);
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
                    JSStringRef messageRef = JSStringCreateWithUTF8CString(event.message.c_str());
                    if (messageRef) {
                        auto message = const_cast<OpaqueJSString*>(messageRef)->string();
                        JSStringRelease(messageRef);
                        controller->dispatchMessageFromFrontend(message);
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
    controller->globalObjectDestroyed();
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

struct InspectorClient : public std::enable_shared_from_this<InspectorClient> {
    InspectorClient(InspectorServer* server, uint64_t id)
        : server(server)
        , id(id)
    {
    }

    InspectorServer* server;
    uint64_t id;
    uv_tcp_t handle { };
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

    CtJscInspector* inspector;
    std::string host;
    uint16_t requestedPort;
    uint16_t boundPort { 0 };
    std::string path;
    std::string url;
    std::string startupError;
    uv_loop_t loop { };
    uv_tcp_t listener { };
    uv_async_t async { };
    uv_thread_t thread { };
    uv_sem_t started { };
    bool threadCreated { false };
    bool loopInitialized { false };
    bool listenerInitialized { false };
    std::atomic<bool> asyncInitialized { false };
    std::atomic<bool> stopRequested { false };
    std::unordered_map<InspectorClient*, std::shared_ptr<InspectorClient>> clients;

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

void WebSocketMessageSink::send(std::string&& message)
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
        if (queuedOutputSize + message.size() > maxQueuedOutputSize) {
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
    auto* write = new (std::nothrow) InspectorWriteRequest;
    if (!write)
        return false;
    write->bytes = std::move(bytes);
    write->closeAfterWrite = closeAfter;
    if (closeAfter)
        uv_read_stop(reinterpret_cast<uv_stream_t*>(&client->handle));
    uv_buf_t buffer = uv_buf_init(write->bytes.data(), static_cast<unsigned int>(write->bytes.size()));
    const int status = uv_write(&write->request, reinterpret_cast<uv_stream_t*>(&client->handle), &buffer, 1, inspectorWriteComplete);
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
    uv_read_stop(reinterpret_cast<uv_stream_t*>(&client->handle));
    if (notifyInspector && client->upgraded)
        enqueue({ InspectorEventType::Close, client->id, nullptr, {} });
    if (!uv_is_closing(reinterpret_cast<uv_handle_t*>(&client->handle)))
        uv_close(reinterpret_cast<uv_handle_t*>(&client->handle), inspectorClientClosed);
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
        const std::string body = "[{\"description\":\"Cottontail JavaScriptCore runtime\",\"id\":\""
            + jsonEscape(id) + "\",\"title\":\"Bun\",\"type\":\"node\",\"url\":\"file://\",\"webSocketDebuggerUrl\":\""
            + escapedUrl + "\",\"devtoolsFrontendUrl\":\"https://debug.bun.sh/#"
            + jsonEscape(url.substr(5)) + "\"}]";
        sendHttpResponse(client, 200, "OK", "application/json; charset=UTF-8", body);
        return;
    }

    const auto upgrade = headers.find("upgrade");
    const auto connection = headers.find("connection");
    const auto key = headers.find("sec-websocket-key");
    const auto version = headers.find("sec-websocket-version");
    if (target != path) {
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
    auto client = std::make_shared<InspectorClient>(server, id);
    if (uv_tcp_init(&server->loop, &client->handle) < 0)
        return;
    client->handle.data = client.get();
    server->clients.emplace(client.get(), client);
    if (uv_accept(listener, reinterpret_cast<uv_stream_t*>(&client->handle)) < 0) {
        server->closeClient(client, false);
        return;
    }
    if (uv_read_start(reinterpret_cast<uv_stream_t*>(&client->handle), inspectorAllocate, inspectorRead) < 0)
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
        if (server->listenerInitialized && !uv_is_closing(reinterpret_cast<uv_handle_t*>(&server->listener)))
            uv_close(reinterpret_cast<uv_handle_t*>(&server->listener), nullptr);
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

    status = uv_tcp_init(&server->loop, &server->listener);
    if (status >= 0) {
        server->listenerInitialized = true;
        server->listener.data = server;
        status = uv_tcp_bind(&server->listener, reinterpret_cast<const sockaddr*>(&resolved.address), 0);
    }
    if (status >= 0)
        status = uv_listen(reinterpret_cast<uv_stream_t*>(&server->listener), 128, inspectorAccepted);
    if (status >= 0) {
        status = uv_async_init(&server->loop, &server->async, inspectorAsync);
        if (status >= 0) {
            server->asyncInitialized.store(true, std::memory_order_release);
            server->async.data = server;
        }
    }
    if (status < 0) {
        server->startupError = uv_strerror(status);
        if (server->listenerInitialized && !uv_is_closing(reinterpret_cast<uv_handle_t*>(&server->listener)))
            uv_close(reinterpret_cast<uv_handle_t*>(&server->listener), nullptr);
        uv_run(&server->loop, UV_RUN_DEFAULT);
        uv_sem_post(&server->started);
        uv_loop_close(&server->loop);
        server->loopInitialized = false;
        return;
    }

    sockaddr_storage socketAddress { };
    int socketLength = sizeof(socketAddress);
    if (uv_tcp_getsockname(&server->listener, reinterpret_cast<sockaddr*>(&socketAddress), &socketLength) == 0) {
        if (socketAddress.ss_family == AF_INET)
            server->boundPort = ntohs(reinterpret_cast<sockaddr_in*>(&socketAddress)->sin_port);
        else if (socketAddress.ss_family == AF_INET6)
            server->boundPort = ntohs(reinterpret_cast<sockaddr_in6*>(&socketAddress)->sin6_port);
    }
    std::string displayHost = server->host;
    if (displayHost.find(':') != std::string::npos && (displayHost.empty() || displayHost.front() != '['))
        displayHost = "[" + displayHost + "]";
    server->url = "ws://" + displayHost + ":" + std::to_string(server->boundPort) + server->path;
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
}

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
    inspector->closing.store(true, std::memory_order_release);
    if (inspector->server) {
        inspector->server->stop();
        inspector->server.reset();
    }
    while (inspector->eventTaskScheduled.load(std::memory_order_acquire))
        ct_jsc_run_loop_cycle();
    inspector->destroyController();
    delete inspector;
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
    if (!inspector || !host || !path || path[0] != '/') {
        if (errorOut)
            *errorOut = duplicateCString("Invalid inspector server configuration");
        return -1;
    }
    if (inspector->server) {
        if (errorOut)
            *errorOut = duplicateCString("Inspector server is already active");
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

extern "C" void ct_jsc_inspector_stop_server(CtJscInspector* inspector)
{
    if (!inspector || !inspector->server)
        return;
    inspector->server->stop();
    inspector->server.reset();
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
    return inspector && inspector->server;
}

extern "C" bool ct_jsc_inspector_has_remote_connection(CtJscInspector* inspector)
{
    return inspector && inspector->remoteConnectionCount.load(std::memory_order_acquire) > 0;
}

extern "C" int ct_jsc_inspector_wait_for_connection(CtJscInspector* inspector)
{
    if (!inspector || !inspector->server)
        return -1;
    while (inspector->server && !inspector->closing.load(std::memory_order_acquire)
        && inspector->remoteConnectionCount.load(std::memory_order_acquire) == 0) {
        ct_jsc_run_loop_cycle();
        uv_sleep(1);
    }
    return inspector->remoteConnectionCount.load(std::memory_order_acquire) > 0 ? 0 : -1;
}

extern "C" uint64_t ct_jsc_inspector_connect_local(CtJscInspector* inspector)
{
    if (!inspector || inspector->closing.load(std::memory_order_acquire))
        return 0;
    const uint64_t id = inspector->nextConnectionId.fetch_add(1, std::memory_order_relaxed);
    auto sink = std::make_shared<LocalMessageSink>();
    {
        std::lock_guard lock(inspector->localSinkMutex);
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
        if (!inspector->localSinks.contains(id))
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
    inspector->enqueue({ InspectorEventType::Close, id, nullptr, {} });
}
