#include "qjs_runner.h"

#include <JavaScriptCore/JavaScript.h>
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

#if defined(__APPLE__)
#define CT_PLATFORM_STRING "darwin"
#elif defined(__linux__)
#define CT_PLATFORM_STRING "linux"
#else
#define CT_PLATFORM_STRING "unknown"
#endif

#if defined(__aarch64__) || defined(_M_ARM64)
#define CT_ARCH_STRING "arm64"
#elif defined(__x86_64__) || defined(_M_X64)
#define CT_ARCH_STRING "x64"
#elif defined(__i386__) || defined(_M_IX86)
#define CT_ARCH_STRING "x86"
#else
#define CT_ARCH_STRING "unknown"
#endif

typedef struct {
    const char *name;
    const char *value;
} CtHostEnvEntry;

typedef struct {
    const char *cwd;
    const CtHostEnvEntry *env_entries;
    size_t env_count;
    bool capture_output;
} CtHostSpawnOptions;

typedef struct {
    int exit_code;
    char *stdout_ptr;
    size_t stdout_len;
    char *stderr_ptr;
    size_t stderr_len;
} CtHostSpawnResult;

extern void ct_host_string_free(char *value);
extern void ct_host_buffer_free(char *value);
extern bool ct_host_exists(const char *path);
extern int ct_host_mkdir(const char *path, bool recursive, char **error_out);
extern int ct_host_rm(const char *path, bool recursive, bool force, char **error_out);
extern int ct_host_unlink(const char *path, char **error_out);
extern int ct_host_chmod(const char *path, unsigned int mode, char **error_out);
extern int ct_host_spawn_sync(
    const char *file,
    const char *const *argv,
    size_t argc,
    CtHostSpawnOptions options,
    CtHostSpawnResult *result_out,
    char **error_out
);

typedef struct CtSpawnEvent {
    uint32_t process_id;
    char *type;
    char *data;
    size_t data_len;
    int exit_code;
    int signal_code;
    bool killed;
    struct CtSpawnEvent *next;
} CtSpawnEvent;

typedef struct CtWorkerMessage {
    uint32_t worker_id;
    char *message;
    struct CtWorkerMessage *next;
} CtWorkerMessage;

typedef struct CtAsyncProcess {
    uint32_t id;
    pid_t pid;
    int stdin_fd;
    int stdout_fd;
    int stderr_fd;
    CtQjsRuntime *runtime;
    pthread_t thread;
    struct CtAsyncProcess *next;
} CtAsyncProcess;

static pthread_mutex_t ct_async_processes_mutex = PTHREAD_MUTEX_INITIALIZER;
static CtAsyncProcess *ct_async_processes = NULL;

typedef struct CtHttpRequest {
    uint32_t id;
    int client_fd;
    char *method;
    char *url;
    char *headers_text;
    char *body;
    size_t body_len;
    bool claimed;
    bool completed;
    int status;
    char *response_headers_text;
    char *response_body;
    size_t response_body_len;
    pthread_mutex_t mutex;
    pthread_cond_t cond;
    struct CtHttpRequest *next;
} CtHttpRequest;

typedef struct CtHttpServer {
    uint32_t id;
    int listen_fd;
    uint16_t port;
    char *hostname;
    bool stopped;
    pthread_t thread;
    pthread_mutex_t mutex;
    CtHttpRequest *requests;
    struct CtHttpServer *next;
} CtHttpServer;

static pthread_mutex_t ct_http_servers_mutex = PTHREAD_MUTEX_INITIALIZER;
static CtHttpServer *ct_http_servers = NULL;
static uint32_t ct_next_http_server_id = 1;
static uint32_t ct_next_http_request_id = 1;

struct CtQjsRuntime {
    JSGlobalContextRef context;
    JSObjectRef host_object;
    JSObjectRef spawn_event_handler;
    pthread_mutex_t spawn_event_mutex;
    CtSpawnEvent *spawn_events_head;
    CtSpawnEvent *spawn_events_tail;
    CtWorkerMessage *worker_messages_head;
    CtWorkerMessage *worker_messages_tail;
    uint32_t next_process_id;
    uint32_t next_worker_id;
};

static char *ct_duplicate_bytes(const char *bytes, size_t len) {
    char *copy = (char *)malloc(len + 1);
    if (copy == NULL) return NULL;
    if (len > 0) memcpy(copy, bytes, len);
    copy[len] = 0;
    return copy;
}

static char *ct_duplicate_string(const char *value) {
    return ct_duplicate_bytes(value != NULL ? value : "", value != NULL ? strlen(value) : 0);
}

static bool ct_http_server_is_stopped(CtHttpServer *server) {
    bool stopped = false;
    pthread_mutex_lock(&server->mutex);
    stopped = server->stopped;
    pthread_mutex_unlock(&server->mutex);
    return stopped;
}

static const char *ct_http_reason_phrase(int status) {
    switch (status) {
        case 200: return "OK";
        case 201: return "Created";
        case 204: return "No Content";
        case 301: return "Moved Permanently";
        case 302: return "Found";
        case 304: return "Not Modified";
        case 400: return "Bad Request";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 500: return "Internal Server Error";
        case 503: return "Service Unavailable";
        default: return "OK";
    }
}

static ssize_t ct_http_send_all(int fd, const char *data, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t result = send(fd, data + sent, len - sent, 0);
        if (result < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (result == 0) return -1;
        sent += (size_t)result;
    }
    return (ssize_t)sent;
}

static void ct_http_free_request(CtHttpRequest *request) {
    if (request == NULL) return;
    if (request->client_fd >= 0) close(request->client_fd);
    free(request->method);
    free(request->url);
    free(request->headers_text);
    free(request->body);
    free(request->response_headers_text);
    free(request->response_body);
    pthread_cond_destroy(&request->cond);
    pthread_mutex_destroy(&request->mutex);
    free(request);
}

static char *ct_http_copy_range(const char *start, size_t len) {
    char *copy = (char *)malloc(len + 1);
    if (copy == NULL) return NULL;
    memcpy(copy, start, len);
    copy[len] = 0;
    return copy;
}

static const char *ct_http_find_header_end(const char *buffer, size_t len) {
    for (size_t index = 3; index < len; index += 1) {
        if (buffer[index - 3] == '\r' &&
            buffer[index - 2] == '\n' &&
            buffer[index - 1] == '\r' &&
            buffer[index] == '\n') {
            return buffer + index + 1;
        }
    }
    return NULL;
}

static size_t ct_http_content_length(const char *headers, size_t headers_len) {
    const char *cursor = headers;
    const char *end = headers + headers_len;
    while (cursor < end) {
        const char *line_end = memchr(cursor, '\n', (size_t)(end - cursor));
        const char *line_stop = line_end != NULL ? line_end : end;
        size_t line_len = (size_t)(line_stop - cursor);
        if (line_len > 0 && cursor[line_len - 1] == '\r') line_len -= 1;
        if (line_len >= 15 && strncasecmp(cursor, "content-length:", 15) == 0) {
            const char *value = cursor + 15;
            while (value < cursor + line_len && (*value == ' ' || *value == '\t')) value += 1;
            return (size_t)strtoull(value, NULL, 10);
        }
        if (line_end == NULL) break;
        cursor = line_end + 1;
    }
    return 0;
}

static int ct_http_read_request(int fd, CtHttpRequest *request) {
    size_t capacity = 8192;
    size_t len = 0;
    char *buffer = (char *)malloc(capacity + 1);
    const char *header_end = NULL;
    size_t header_len = 0;
    size_t content_len = 0;
    if (buffer == NULL) return -1;

    while (true) {
        if (len == capacity) {
            size_t next_capacity = capacity * 2;
            if (next_capacity > 1024 * 1024) {
                free(buffer);
                return -1;
            }
            char *next = (char *)realloc(buffer, next_capacity + 1);
            if (next == NULL) {
                free(buffer);
                return -1;
            }
            buffer = next;
            capacity = next_capacity;
        }
        ssize_t read_count = recv(fd, buffer + len, capacity - len, 0);
        if (read_count < 0) {
            if (errno == EINTR) continue;
            free(buffer);
            return -1;
        }
        if (read_count == 0) {
            free(buffer);
            return -1;
        }
        len += (size_t)read_count;
        buffer[len] = 0;
        header_end = ct_http_find_header_end(buffer, len);
        if (header_end != NULL) {
            header_len = (size_t)(header_end - buffer);
            content_len = ct_http_content_length(buffer, header_len);
            if (len >= header_len + content_len) break;
        }
    }

    const char *request_line_end = strstr(buffer, "\r\n");
    if (request_line_end == NULL || request_line_end > header_end) {
        free(buffer);
        return -1;
    }
    const char *first_space = memchr(buffer, ' ', (size_t)(request_line_end - buffer));
    if (first_space == NULL) {
        free(buffer);
        return -1;
    }
    const char *second_space = memchr(first_space + 1, ' ', (size_t)(request_line_end - first_space - 1));
    if (second_space == NULL) {
        free(buffer);
        return -1;
    }

    request->method = ct_http_copy_range(buffer, (size_t)(first_space - buffer));
    request->url = ct_http_copy_range(first_space + 1, (size_t)(second_space - first_space - 1));
    request->headers_text = ct_http_copy_range(request_line_end + 2, (size_t)(header_end - request_line_end - 4));
    request->body_len = content_len;
    request->body = (char *)malloc(content_len > 0 ? content_len : 1);
    if (request->method == NULL || request->url == NULL || request->headers_text == NULL || request->body == NULL) {
        free(buffer);
        return -1;
    }
    if (content_len > 0) memcpy(request->body, buffer + header_len, content_len);
    free(buffer);
    return 0;
}

static void ct_http_send_response(CtHttpRequest *request) {
    int status = request->status > 0 ? request->status : 200;
    const char *reason = ct_http_reason_phrase(status);
    const char *headers = request->response_headers_text != NULL ? request->response_headers_text : "";
    char head[512];
    int head_len = snprintf(
        head,
        sizeof(head),
        "HTTP/1.1 %d %s\r\nContent-Length: %zu\r\nConnection: close\r\n%s\r\n",
        status,
        reason,
        request->response_body_len,
        headers
    );
    if (head_len < 0) return;
    if ((size_t)head_len >= sizeof(head)) head_len = (int)sizeof(head) - 1;
    ct_http_send_all(request->client_fd, head, (size_t)head_len);
    if (request->response_body_len > 0 && request->response_body != NULL) {
        ct_http_send_all(request->client_fd, request->response_body, request->response_body_len);
    }
}

static void ct_http_server_add_request(CtHttpServer *server, CtHttpRequest *request) {
    pthread_mutex_lock(&server->mutex);
    request->next = server->requests;
    server->requests = request;
    pthread_mutex_unlock(&server->mutex);
}

static void ct_http_server_remove_request(CtHttpServer *server, CtHttpRequest *request) {
    pthread_mutex_lock(&server->mutex);
    CtHttpRequest **cursor = &server->requests;
    while (*cursor != NULL) {
        if (*cursor == request) {
            *cursor = request->next;
            break;
        }
        cursor = &(*cursor)->next;
    }
    pthread_mutex_unlock(&server->mutex);
}

static void *ct_http_server_thread(void *opaque) {
    CtHttpServer *server = (CtHttpServer *)opaque;
    while (!ct_http_server_is_stopped(server)) {
        int client_fd = accept(server->listen_fd, NULL, NULL);
        if (client_fd < 0) {
            if (errno == EINTR) continue;
            if (ct_http_server_is_stopped(server)) break;
            continue;
        }
        CtHttpRequest *request = (CtHttpRequest *)calloc(1, sizeof(CtHttpRequest));
        if (request == NULL) {
            close(client_fd);
            continue;
        }
        request->client_fd = client_fd;
        request->status = 200;
        pthread_mutex_init(&request->mutex, NULL);
        pthread_cond_init(&request->cond, NULL);

        pthread_mutex_lock(&ct_http_servers_mutex);
        request->id = ct_next_http_request_id++;
        if (ct_next_http_request_id == 0) ct_next_http_request_id = 1;
        pthread_mutex_unlock(&ct_http_servers_mutex);

        if (ct_http_read_request(client_fd, request) != 0) {
            static const char bad_request[] =
                "HTTP/1.1 400 Bad Request\r\nContent-Length: 11\r\nConnection: close\r\n\r\nBad Request";
            ct_http_send_all(client_fd, bad_request, sizeof(bad_request) - 1);
            ct_http_free_request(request);
            continue;
        }
        ct_http_server_add_request(server, request);

        pthread_mutex_lock(&request->mutex);
        while (!request->completed && !ct_http_server_is_stopped(server)) {
            pthread_cond_wait(&request->cond, &request->mutex);
        }
        pthread_mutex_unlock(&request->mutex);

        if (!ct_http_server_is_stopped(server)) {
            ct_http_send_response(request);
        }
        ct_http_server_remove_request(server, request);
        ct_http_free_request(request);
    }
    return NULL;
}

static CtHttpServer *ct_http_find_server(uint32_t id) {
    CtHttpServer *server = ct_http_servers;
    while (server != NULL) {
        if (server->id == id) return server;
        server = server->next;
    }
    return NULL;
}

static JSStringRef ct_js_string(const char *value) {
    return JSStringCreateWithUTF8CString(value != NULL ? value : "");
}

static JSValueRef ct_make_string(JSContextRef ctx, const char *value) {
    JSStringRef string = ct_js_string(value);
    JSValueRef result = JSValueMakeString(ctx, string);
    JSStringRelease(string);
    return result;
}

static JSValueRef ct_make_string_len(JSContextRef ctx, const char *value, size_t len) {
    char *copy = ct_duplicate_bytes(value != NULL ? value : "", value != NULL ? len : 0);
    if (copy == NULL) return JSValueMakeUndefined(ctx);
    JSValueRef result = ct_make_string(ctx, copy);
    free(copy);
    return result;
}

static char *ct_value_to_string_copy(JSContextRef ctx, JSValueRef value) {
    JSValueRef exception = NULL;
    JSStringRef string = JSValueToStringCopy(ctx, value, &exception);
    if (string == NULL) return NULL;
    size_t size = JSStringGetMaximumUTF8CStringSize(string);
    char *buffer = (char *)malloc(size > 0 ? size : 1);
    if (buffer == NULL) {
        JSStringRelease(string);
        return NULL;
    }
    JSStringGetUTF8CString(string, buffer, size);
    JSStringRelease(string);
    return buffer;
}

static char *ct_copy_exception(JSContextRef ctx, JSValueRef exception) {
    if (exception == NULL) return ct_duplicate_bytes("Unknown JavaScript exception", 28);

    JSStringRef source = ct_js_string(
        "(function(e){"
        "try{"
        "var head='';"
        "if(e&&e.message)head=(e.name?String(e.name):'Error')+': '+String(e.message);"
        "if(e&&e.stack){var stack=String(e.stack);return head&&stack.indexOf(head)<0?head+'\\n'+stack:stack;}"
        "if(head)return head;"
        "return String(e);}"
        "catch(_){return 'Unknown JavaScript exception';}"
        "})"
    );
    JSValueRef eval_exception = NULL;
    JSValueRef fn_value = JSEvaluateScript(ctx, source, NULL, NULL, 1, &eval_exception);
    JSStringRelease(source);
    if (eval_exception == NULL && fn_value != NULL && JSValueIsObject(ctx, fn_value)) {
        JSObjectRef fn = (JSObjectRef)fn_value;
        JSValueRef arg = exception;
        JSValueRef call_exception = NULL;
        JSValueRef formatted = JSObjectCallAsFunction(ctx, fn, NULL, 1, &arg, &call_exception);
        if (call_exception == NULL && formatted != NULL) {
            char *copy = ct_value_to_string_copy(ctx, formatted);
            if (copy != NULL) return copy;
        }
    }
    return ct_value_to_string_copy(ctx, exception);
}

static void ct_set_error_out(char **error_out, char *message) {
    if (error_out != NULL) {
        *error_out = message;
    } else {
        free(message);
    }
}

static void ct_throw_message(JSContextRef ctx, JSValueRef *exception, const char *message) {
    if (exception != NULL) *exception = ct_make_string(ctx, message);
}

static bool ct_set_property(JSContextRef ctx, JSObjectRef object, const char *name, JSValueRef value, JSValueRef *exception) {
    JSStringRef property = ct_js_string(name);
    JSObjectSetProperty(ctx, object, property, value, kJSPropertyAttributeNone, exception);
    JSStringRelease(property);
    return exception == NULL || *exception == NULL;
}

static JSValueRef ct_get_property(JSContextRef ctx, JSObjectRef object, const char *name, JSValueRef *exception) {
    JSStringRef property = ct_js_string(name);
    JSValueRef result = JSObjectGetProperty(ctx, object, property, exception);
    JSStringRelease(property);
    return result;
}

static bool ct_value_to_bool(JSContextRef ctx, JSValueRef value) {
    return JSValueToBoolean(ctx, value);
}

static double ct_value_to_number(JSContextRef ctx, JSValueRef value) {
    JSValueRef exception = NULL;
    double number = JSValueToNumber(ctx, value, &exception);
    return exception == NULL ? number : 0;
}

static char *ct_value_to_optional_string(JSContextRef ctx, JSValueRef value) {
    if (value == NULL || JSValueIsUndefined(ctx, value) || JSValueIsNull(ctx, value)) return NULL;
    return ct_value_to_string_copy(ctx, value);
}

static JSObjectRef ct_make_object(JSContextRef ctx) {
    return JSObjectMake(ctx, NULL, NULL);
}

static JSObjectRef ct_make_array(JSContextRef ctx, size_t count, const JSValueRef values[], JSValueRef *exception) {
    return JSObjectMakeArray(ctx, count, values, exception);
}

static void ct_array_buffer_free(void *bytes, void *deallocator_context) {
    (void)deallocator_context;
    free(bytes);
}

static JSValueRef ct_array_buffer_from_copy(JSContextRef ctx, const char *bytes, size_t len, JSValueRef *exception) {
    void *copy = malloc(len > 0 ? len : 1);
    if (copy == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    if (len > 0) memcpy(copy, bytes, len);
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, copy, len, ct_array_buffer_free, NULL, exception);
}

static int ct_get_bytes(JSContextRef ctx, JSValueRef value, uint8_t **out_data, size_t *out_len) {
    *out_data = NULL;
    *out_len = 0;
    if (!JSValueIsObject(ctx, value)) return -1;

    JSValueRef exception = NULL;
    JSObjectRef object = (JSObjectRef)value;
    JSTypedArrayType type = JSValueGetTypedArrayType(ctx, value, &exception);
    if (exception != NULL) return -1;

    if (type == kJSTypedArrayTypeArrayBuffer) {
        *out_data = (uint8_t *)JSObjectGetArrayBufferBytesPtr(ctx, object, &exception);
        *out_len = JSObjectGetArrayBufferByteLength(ctx, object, &exception);
        return exception == NULL && *out_data != NULL ? 0 : -1;
    }

    if (type != kJSTypedArrayTypeNone) {
        size_t byte_offset = JSObjectGetTypedArrayByteOffset(ctx, object, &exception);
        size_t byte_len = JSObjectGetTypedArrayByteLength(ctx, object, &exception);
        JSObjectRef buffer = JSObjectGetTypedArrayBuffer(ctx, object, &exception);
        if (exception != NULL || buffer == NULL) return -1;
        uint8_t *base = (uint8_t *)JSObjectGetArrayBufferBytesPtr(ctx, buffer, &exception);
        if (exception != NULL || base == NULL) return -1;
        *out_data = base + byte_offset;
        *out_len = byte_len;
        return 0;
    }

    return -1;
}

static void ct_free_string_array(char **values, size_t count) {
    if (values == NULL) return;
    for (size_t index = 0; index < count; index += 1) free(values[index]);
    free(values);
}

static int ct_parse_string_array(JSContextRef ctx, JSValueRef value, char ***out_values, size_t *out_count, JSValueRef *exception) {
    *out_values = NULL;
    *out_count = 0;
    if (value == NULL || JSValueIsUndefined(ctx, value) || JSValueIsNull(ctx, value)) return 0;
    if (!JSValueIsObject(ctx, value)) {
        ct_throw_message(ctx, exception, "Expected array");
        return -1;
    }

    JSObjectRef object = (JSObjectRef)value;
    JSValueRef len_value = ct_get_property(ctx, object, "length", exception);
    if (exception != NULL && *exception != NULL) return -1;
    size_t count = (size_t)ct_value_to_number(ctx, len_value);
    char **items = (char **)calloc(count > 0 ? count : 1, sizeof(char *));
    if (items == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return -1;
    }

    for (size_t index = 0; index < count; index += 1) {
        JSValueRef item = JSObjectGetPropertyAtIndex(ctx, object, (unsigned)index, exception);
        if (exception != NULL && *exception != NULL) {
            ct_free_string_array(items, index);
            return -1;
        }
        items[index] = ct_value_to_string_copy(ctx, item);
        if (items[index] == NULL) {
            ct_free_string_array(items, index);
            ct_throw_message(ctx, exception, "Out of memory");
            return -1;
        }
    }

    *out_values = items;
    *out_count = count;
    return 0;
}

static void ct_free_env_entries(CtHostEnvEntry *entries, size_t count) {
    if (entries == NULL) return;
    for (size_t index = 0; index < count; index += 1) {
        free((char *)entries[index].name);
        free((char *)entries[index].value);
    }
    free(entries);
}

static int ct_parse_env_object(JSContextRef ctx, JSValueRef value, CtHostEnvEntry **out_entries, size_t *out_count, JSValueRef *exception) {
    *out_entries = NULL;
    *out_count = 0;
    if (value == NULL || JSValueIsUndefined(ctx, value) || JSValueIsNull(ctx, value)) return 0;
    if (!JSValueIsObject(ctx, value)) {
        ct_throw_message(ctx, exception, "spawn env must be an object");
        return -1;
    }

    JSObjectRef object = (JSObjectRef)value;
    JSPropertyNameArrayRef names = JSObjectCopyPropertyNames(ctx, object);
    size_t count = JSPropertyNameArrayGetCount(names);
    CtHostEnvEntry *entries = (CtHostEnvEntry *)calloc(count > 0 ? count : 1, sizeof(CtHostEnvEntry));
    if (entries == NULL) {
        JSPropertyNameArrayRelease(names);
        ct_throw_message(ctx, exception, "Out of memory");
        return -1;
    }

    for (size_t index = 0; index < count; index += 1) {
        JSStringRef name_ref = JSPropertyNameArrayGetNameAtIndex(names, index);
        size_t name_size = JSStringGetMaximumUTF8CStringSize(name_ref);
        char *name = (char *)malloc(name_size > 0 ? name_size : 1);
        if (name == NULL) {
            JSPropertyNameArrayRelease(names);
            ct_free_env_entries(entries, index);
            ct_throw_message(ctx, exception, "Out of memory");
            return -1;
        }
        JSStringGetUTF8CString(name_ref, name, name_size);

        JSValueRef prop = JSObjectGetProperty(ctx, object, name_ref, exception);
        if (exception != NULL && *exception != NULL) {
            free(name);
            JSPropertyNameArrayRelease(names);
            ct_free_env_entries(entries, index);
            return -1;
        }
        char *prop_value = ct_value_to_string_copy(ctx, prop);
        if (prop_value == NULL) {
            free(name);
            JSPropertyNameArrayRelease(names);
            ct_free_env_entries(entries, index);
            ct_throw_message(ctx, exception, "Out of memory");
            return -1;
        }
        entries[index].name = name;
        entries[index].value = prop_value;
    }

    JSPropertyNameArrayRelease(names);
    *out_entries = entries;
    *out_count = count;
    return 0;
}

static JSValueRef ct_make_function(JSContextRef ctx, const char *name, JSObjectCallAsFunctionCallback callback, CtQjsRuntime *runtime) {
    JSClassDefinition definition = kJSClassDefinitionEmpty;
    definition.className = name;
    definition.callAsFunction = callback;
    JSClassRef cls = JSClassCreate(&definition);
    JSObjectRef function = JSObjectMake(ctx, cls, runtime);
    JSClassRelease(cls);
    return function;
}

static JSValueRef ct_make_plain_function(JSContextRef ctx, const char *name, JSObjectCallAsFunctionCallback callback) {
    JSStringRef function_name = ct_js_string(name);
    JSObjectRef function = JSObjectMakeFunctionWithCallback(ctx, function_name, callback);
    JSStringRelease(function_name);
    return function;
}

static CtQjsRuntime *ct_callback_runtime(JSObjectRef function) {
    return (CtQjsRuntime *)JSObjectGetPrivate(function);
}

static JSValueRef ct_console_log_impl(JSContextRef ctx, size_t argc, const JSValueRef argv[], FILE *stream) {
    for (size_t index = 0; index < argc; index += 1) {
        char *text = ct_value_to_string_copy(ctx, argv[index]);
        if (index > 0) fputc(' ', stream);
        fputs(text != NULL ? text : "", stream);
        free(text);
    }
    fputc('\n', stream);
    fflush(stream);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_console_log(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)exception;
    return ct_console_log_impl(ctx, argc, argv, stdout);
}

static JSValueRef ct_console_error(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)exception;
    return ct_console_log_impl(ctx, argc, argv, stderr);
}

static JSValueRef ct_nanotime(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
    (void)exception;
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return JSValueMakeNumber(ctx, (double)ts.tv_sec * 1000000000.0 + (double)ts.tv_nsec);
}

static JSValueRef ct_sleep(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.sleep(ms) requires a duration");
        return JSValueMakeUndefined(ctx);
    }
    double ms = ct_value_to_number(ctx, argv[0]);
    if (ms > 0) usleep((useconds_t)(ms * 1000.0));
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_cwd(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
    char buffer[4096];
    if (getcwd(buffer, sizeof(buffer)) == NULL) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    return ct_make_string(ctx, buffer);
}

static JSValueRef ct_pid(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
    (void)exception;
    return JSValueMakeNumber(ctx, (double)getpid());
}

static JSValueRef ct_exec_path(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
#if defined(__APPLE__)
    char buffer[4096];
    uint32_t size = sizeof(buffer);
    if (_NSGetExecutablePath(buffer, &size) == 0) return ct_make_string(ctx, buffer);
#endif
    (void)exception;
    return ct_make_string(ctx, "cottontail");
}

static JSValueRef ct_platform(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
    (void)exception;
    return ct_make_string(ctx, CT_PLATFORM_STRING);
}

static JSValueRef ct_arch(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
    (void)exception;
    return ct_make_string(ctx, CT_ARCH_STRING);
}

static JSValueRef ct_hostname(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
    char buffer[256];
    if (gethostname(buffer, sizeof(buffer)) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    buffer[sizeof(buffer) - 1] = 0;
    return ct_make_string(ctx, buffer);
}

static JSValueRef ct_read_file_common(JSContextRef ctx, size_t argc, const JSValueRef argv[], JSValueRef *exception, bool as_buffer) {
    if (argc < 1) {
        ct_throw_message(ctx, exception, "readFile(path) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    if (path == NULL) {
        ct_throw_message(ctx, exception, "Invalid path");
        return JSValueMakeUndefined(ctx);
    }
    FILE *file = fopen(path, "rb");
    if (file == NULL) {
        ct_throw_message(ctx, exception, strerror(errno));
        free(path);
        return JSValueMakeUndefined(ctx);
    }
    fseek(file, 0, SEEK_END);
    long len = ftell(file);
    fseek(file, 0, SEEK_SET);
    if (len < 0) len = 0;
    char *buffer = (char *)malloc((size_t)len + 1);
    if (buffer == NULL) {
        fclose(file);
        free(path);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    size_t read_len = fread(buffer, 1, (size_t)len, file);
    buffer[read_len] = 0;
    fclose(file);
    free(path);
    JSValueRef result = as_buffer ? ct_array_buffer_from_copy(ctx, buffer, read_len, exception) : ct_make_string_len(ctx, buffer, read_len);
    free(buffer);
    return result;
}

static JSValueRef ct_read_file(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    return ct_read_file_common(ctx, argc, argv, exception, false);
}

static JSValueRef ct_read_file_buffer(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    return ct_read_file_common(ctx, argc, argv, exception, true);
}

static JSValueRef ct_write_file(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "writeFile(path, data) requires path and data");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    if (path == NULL) {
        ct_throw_message(ctx, exception, "Invalid path");
        return JSValueMakeUndefined(ctx);
    }
    FILE *file = fopen(path, "wb");
    if (file == NULL) {
        ct_throw_message(ctx, exception, strerror(errno));
        free(path);
        return JSValueMakeUndefined(ctx);
    }

    uint8_t *bytes = NULL;
    size_t len = 0;
    if (ct_get_bytes(ctx, argv[1], &bytes, &len) == 0) {
        if (len > 0) fwrite(bytes, 1, len, file);
    } else {
        char *text = ct_value_to_string_copy(ctx, argv[1]);
        if (text != NULL) {
            fwrite(text, 1, strlen(text), file);
            free(text);
        }
    }
    fclose(file);
    free(path);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_env(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc >= 1 && !JSValueIsUndefined(ctx, argv[0]) && !JSValueIsNull(ctx, argv[0])) {
        char *name = ct_value_to_string_copy(ctx, argv[0]);
        const char *value = name != NULL ? getenv(name) : NULL;
        free(name);
        return value != NULL ? ct_make_string(ctx, value) : JSValueMakeUndefined(ctx);
    }
    JSObjectRef env = ct_make_object(ctx);
    for (char **entry = environ; entry != NULL && *entry != NULL; entry += 1) {
        const char *equals = strchr(*entry, '=');
        if (equals == NULL) continue;
        char *name = ct_duplicate_bytes(*entry, (size_t)(equals - *entry));
        if (name == NULL) continue;
        ct_set_property(ctx, env, name, ct_make_string(ctx, equals + 1), exception);
        free(name);
        if (exception != NULL && *exception != NULL) return env;
    }
    return env;
}

static JSValueRef ct_exists_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "existsSync(path) requires a path");
        return JSValueMakeBoolean(ctx, false);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    bool exists = path != NULL && ct_host_exists(path);
    free(path);
    return JSValueMakeBoolean(ctx, exists);
}

static void ct_define_stat_fields(JSContextRef ctx, JSObjectRef object, const struct stat *stat_value, JSValueRef *exception) {
    ct_set_property(ctx, object, "size", JSValueMakeNumber(ctx, (double)stat_value->st_size), exception);
    ct_set_property(ctx, object, "mode", JSValueMakeNumber(ctx, (double)stat_value->st_mode), exception);
    ct_set_property(ctx, object, "isFile", JSValueMakeBoolean(ctx, S_ISREG(stat_value->st_mode)), exception);
    ct_set_property(ctx, object, "isDirectory", JSValueMakeBoolean(ctx, S_ISDIR(stat_value->st_mode)), exception);
    ct_set_property(ctx, object, "isSymbolicLink", JSValueMakeBoolean(ctx, S_ISLNK(stat_value->st_mode)), exception);
}

static JSValueRef ct_stat_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "statSync(path) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    bool follow = argc < 2 || ct_value_to_bool(ctx, argv[1]);
    struct stat stat_value;
    int status = follow ? stat(path, &stat_value) : lstat(path, &stat_value);
    if (status != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        free(path);
        return JSValueMakeUndefined(ctx);
    }
    free(path);
    JSObjectRef result = ct_make_object(ctx);
    ct_define_stat_fields(ctx, result, &stat_value, exception);
    return result;
}

static JSValueRef ct_read_dir_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "readDirSync(path) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    DIR *dir = path != NULL ? opendir(path) : NULL;
    if (dir == NULL) {
        ct_throw_message(ctx, exception, strerror(errno));
        free(path);
        return JSValueMakeUndefined(ctx);
    }
    JSObjectRef result = ct_make_array(ctx, 0, NULL, exception);
    unsigned index = 0;
    for (;;) {
        struct dirent *entry = readdir(dir);
        if (entry == NULL) break;
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        size_t full_len = strlen(path) + strlen(entry->d_name) + 2;
        char *full = (char *)malloc(full_len);
        if (full == NULL) continue;
        snprintf(full, full_len, "%s/%s", path, entry->d_name);
        struct stat stat_value;
        if (lstat(full, &stat_value) != 0) {
            free(full);
            continue;
        }
        free(full);
        JSObjectRef item = ct_make_object(ctx);
        ct_set_property(ctx, item, "name", ct_make_string(ctx, entry->d_name), exception);
        ct_define_stat_fields(ctx, item, &stat_value, exception);
        JSObjectSetPropertyAtIndex(ctx, result, index++, item, exception);
    }
    closedir(dir);
    free(path);
    return result;
}

static JSValueRef ct_mkdir_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "mkdirSync(path) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    bool recursive = argc >= 2 && ct_value_to_bool(ctx, argv[1]);
    char *error = NULL;
    if (ct_host_mkdir(path, recursive, &error) != 0) ct_throw_message(ctx, exception, error != NULL ? error : "mkdir failed");
    if (error != NULL) ct_host_string_free(error);
    free(path);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_rm_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "rmSync(path) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    bool recursive = argc >= 2 && ct_value_to_bool(ctx, argv[1]);
    bool force = argc >= 3 && ct_value_to_bool(ctx, argv[2]);
    char *error = NULL;
    if (ct_host_rm(path, recursive, force, &error) != 0) ct_throw_message(ctx, exception, error != NULL ? error : "rm failed");
    if (error != NULL) ct_host_string_free(error);
    free(path);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_unlink_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "unlinkSync(path) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    char *error = NULL;
    if (ct_host_unlink(path, &error) != 0) ct_throw_message(ctx, exception, error != NULL ? error : "unlink failed");
    if (error != NULL) ct_host_string_free(error);
    free(path);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_chmod_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "chmodSync(path, mode) requires path and mode");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    unsigned int mode = (unsigned int)ct_value_to_number(ctx, argv[1]);
    char *error = NULL;
    if (ct_host_chmod(path, mode, &error) != 0) ct_throw_message(ctx, exception, error != NULL ? error : "chmod failed");
    if (error != NULL) ct_host_string_free(error);
    free(path);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_spawn_result_to_js(JSContextRef ctx, const CtHostSpawnResult *result, JSValueRef *exception) {
    JSObjectRef response = ct_make_object(ctx);
    ct_set_property(ctx, response, "status", JSValueMakeNumber(ctx, result->exit_code), exception);
    ct_set_property(ctx, response, "stdout", ct_make_string_len(ctx, result->stdout_ptr != NULL ? result->stdout_ptr : "", result->stdout_len), exception);
    ct_set_property(ctx, response, "stderr", ct_make_string_len(ctx, result->stderr_ptr != NULL ? result->stderr_ptr : "", result->stderr_len), exception);
    return response;
}

static int ct_parse_spawn_options(JSContextRef ctx, JSValueRef value, char **cwd, CtHostEnvEntry **env_entries, size_t *env_count, bool *capture_output, JSValueRef *exception) {
    *cwd = NULL;
    *env_entries = NULL;
    *env_count = 0;
    *capture_output = true;
    if (value == NULL || JSValueIsUndefined(ctx, value) || JSValueIsNull(ctx, value) || !JSValueIsObject(ctx, value)) return 0;
    JSObjectRef object = (JSObjectRef)value;
    JSValueRef cwd_value = ct_get_property(ctx, object, "cwd", exception);
    JSValueRef env_value = ct_get_property(ctx, object, "env", exception);
    JSValueRef stdio_value = ct_get_property(ctx, object, "stdio", exception);
    if (exception != NULL && *exception != NULL) return -1;
    *cwd = ct_value_to_optional_string(ctx, cwd_value);
    if (ct_parse_env_object(ctx, env_value, env_entries, env_count, exception) != 0) return -1;
    if (!JSValueIsUndefined(ctx, stdio_value) && !JSValueIsNull(ctx, stdio_value)) {
        char *stdio = ct_value_to_string_copy(ctx, stdio_value);
        if (stdio != NULL && strcmp(stdio, "inherit") == 0) *capture_output = false;
        free(stdio);
    }
    return 0;
}

static JSValueRef ct_spawn_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "spawnSync(file, args, options) requires a file");
        return JSValueMakeUndefined(ctx);
    }
    char *file = ct_value_to_string_copy(ctx, argv[0]);
    char **args = NULL;
    size_t arg_count = 0;
    char *cwd = NULL;
    CtHostEnvEntry *env_entries = NULL;
    size_t env_count = 0;
    bool capture_output = true;
    if (ct_parse_string_array(ctx, argc >= 2 ? argv[1] : NULL, &args, &arg_count, exception) != 0 ||
        ct_parse_spawn_options(ctx, argc >= 3 ? argv[2] : NULL, &cwd, &env_entries, &env_count, &capture_output, exception) != 0) {
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }
    CtHostSpawnResult result = {0};
    char *error = NULL;
    if (ct_host_spawn_sync(file, (const char *const *)args, arg_count, (CtHostSpawnOptions){
            .cwd = cwd,
            .env_entries = env_entries,
            .env_count = env_count,
            .capture_output = capture_output,
        }, &result, &error) != 0) {
        ct_throw_message(ctx, exception, error != NULL ? error : "spawn failed");
    }
    JSValueRef response = ct_spawn_result_to_js(ctx, &result, exception);
    if (error != NULL) ct_host_string_free(error);
    if (result.stdout_ptr != NULL) ct_host_buffer_free(result.stdout_ptr);
    if (result.stderr_ptr != NULL) ct_host_buffer_free(result.stderr_ptr);
    free(file);
    ct_free_string_array(args, arg_count);
    free(cwd);
    ct_free_env_entries(env_entries, env_count);
    return response;
}

static void ct_queue_spawn_event(CtQjsRuntime *runtime, CtSpawnEvent *event) {
    pthread_mutex_lock(&runtime->spawn_event_mutex);
    if (runtime->spawn_events_tail != NULL) {
        runtime->spawn_events_tail->next = event;
    } else {
        runtime->spawn_events_head = event;
    }
    runtime->spawn_events_tail = event;
    pthread_mutex_unlock(&runtime->spawn_event_mutex);
}

static void ct_queue_spawn_text(CtQjsRuntime *runtime, uint32_t id, const char *type, const char *data, size_t data_len) {
    if (data == NULL || data_len == 0) return;
    CtSpawnEvent *event = (CtSpawnEvent *)calloc(1, sizeof(CtSpawnEvent));
    if (event == NULL) return;
    event->process_id = id;
    event->type = ct_duplicate_bytes(type, strlen(type));
    event->data = ct_duplicate_bytes(data, data_len);
    event->data_len = data_len;
    ct_queue_spawn_event(runtime, event);
}

static void ct_async_process_remove(CtAsyncProcess *process) {
    pthread_mutex_lock(&ct_async_processes_mutex);
    CtAsyncProcess **cursor = &ct_async_processes;
    while (*cursor != NULL) {
        if (*cursor == process) {
            *cursor = process->next;
            break;
        }
        cursor = &(*cursor)->next;
    }
    pthread_mutex_unlock(&ct_async_processes_mutex);
}

static CtAsyncProcess *ct_async_process_find(uint32_t id) {
    CtAsyncProcess *result = NULL;
    pthread_mutex_lock(&ct_async_processes_mutex);
    CtAsyncProcess *cursor = ct_async_processes;
    while (cursor != NULL) {
        if (cursor->id == id) {
            result = cursor;
            break;
        }
        cursor = cursor->next;
    }
    pthread_mutex_unlock(&ct_async_processes_mutex);
    return result;
}

static bool ct_async_processes_has_runtime(CtQjsRuntime *runtime) {
    bool found = false;
    pthread_mutex_lock(&ct_async_processes_mutex);
    CtAsyncProcess *cursor = ct_async_processes;
    while (cursor != NULL) {
        if (cursor->runtime == runtime) {
            found = true;
            break;
        }
        cursor = cursor->next;
    }
    pthread_mutex_unlock(&ct_async_processes_mutex);
    return found;
}

static void ct_async_processes_stop_runtime(CtQjsRuntime *runtime) {
    pthread_mutex_lock(&ct_async_processes_mutex);
    CtAsyncProcess *cursor = ct_async_processes;
    while (cursor != NULL) {
        if (cursor->runtime == runtime) {
            kill(cursor->pid, SIGTERM);
            if (cursor->stdin_fd >= 0) {
                close(cursor->stdin_fd);
                cursor->stdin_fd = -1;
            }
        }
        cursor = cursor->next;
    }
    pthread_mutex_unlock(&ct_async_processes_mutex);
}

static void ct_async_processes_wait_for_runtime(CtQjsRuntime *runtime) {
    ct_async_processes_stop_runtime(runtime);
    for (int attempt = 0; attempt < 500 && ct_async_processes_has_runtime(runtime); attempt += 1) {
        if (attempt == 250) ct_async_processes_stop_runtime(runtime);
        usleep(1000);
    }
}

static void *ct_async_process_thread(void *opaque) {
    CtAsyncProcess *process = (CtAsyncProcess *)opaque;
    int status = 0;
    bool exited = false;
    if (process->stdout_fd >= 0) fcntl(process->stdout_fd, F_SETFL, fcntl(process->stdout_fd, F_GETFL, 0) | O_NONBLOCK);
    if (process->stderr_fd >= 0) fcntl(process->stderr_fd, F_SETFL, fcntl(process->stderr_fd, F_GETFL, 0) | O_NONBLOCK);

    while (!exited || process->stdout_fd >= 0 || process->stderr_fd >= 0) {
        struct pollfd fds[2];
        const char *types[2];
        int count = 0;
        if (process->stdout_fd >= 0) {
            fds[count].fd = process->stdout_fd;
            fds[count].events = POLLIN | POLLHUP | POLLERR;
            fds[count].revents = 0;
            types[count] = "stdout";
            count += 1;
        }
        if (process->stderr_fd >= 0) {
            fds[count].fd = process->stderr_fd;
            fds[count].events = POLLIN | POLLHUP | POLLERR;
            fds[count].revents = 0;
            types[count] = "stderr";
            count += 1;
        }

        int ready = count > 0 ? poll(fds, (nfds_t)count, 50) : 0;
        if (ready > 0) {
            for (int index = 0; index < count; index += 1) {
                if ((fds[index].revents & (POLLIN | POLLHUP | POLLERR)) == 0) continue;
                char buffer[16384];
                for (;;) {
                    ssize_t n = read(fds[index].fd, buffer, sizeof(buffer));
                    if (n > 0) {
                        ct_queue_spawn_text(process->runtime, process->id, types[index], buffer, (size_t)n);
                        continue;
                    }
                    if (n == 0) {
                        if (fds[index].fd == process->stdout_fd) {
                            close(process->stdout_fd);
                            process->stdout_fd = -1;
                        } else if (fds[index].fd == process->stderr_fd) {
                            close(process->stderr_fd);
                            process->stderr_fd = -1;
                        }
                        break;
                    }
                    if (errno == EINTR) continue;
                    if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                    if (fds[index].fd == process->stdout_fd) {
                        close(process->stdout_fd);
                        process->stdout_fd = -1;
                    } else if (fds[index].fd == process->stderr_fd) {
                        close(process->stderr_fd);
                        process->stderr_fd = -1;
                    }
                    break;
                }
            }
        }

        if (!exited) {
            pid_t wait_result = waitpid(process->pid, &status, WNOHANG);
            if (wait_result == process->pid) {
                exited = true;
            } else if (wait_result < 0 && errno != EINTR) {
                exited = true;
            }
        }

        if (count == 0 && !exited) usleep(1000);
    }

    if (!exited) {
        while (waitpid(process->pid, &status, 0) < 0 && errno == EINTR) {}
    }
    int exit_code = 1;
    int signal_code = 0;
    if (WIFEXITED(status)) exit_code = WEXITSTATUS(status);
    else if (WIFSIGNALED(status)) {
        signal_code = WTERMSIG(status);
        exit_code = 128 + signal_code;
    }

    CtSpawnEvent *exit_event = (CtSpawnEvent *)calloc(1, sizeof(CtSpawnEvent));
    if (exit_event != NULL) {
        exit_event->process_id = process->id;
        exit_event->type = ct_duplicate_bytes("exit", 4);
        exit_event->exit_code = exit_code;
        exit_event->signal_code = signal_code;
        ct_queue_spawn_event(process->runtime, exit_event);
    }
    if (process->stdin_fd >= 0) close(process->stdin_fd);
    ct_async_process_remove(process);
    free(process);
    return NULL;
}

static JSValueRef ct_spawn_start(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    CtQjsRuntime *runtime = ct_callback_runtime(function);
    if (argc < 1) {
        ct_throw_message(ctx, exception, "spawnStart(file, args, options) requires a file");
        return JSValueMakeUndefined(ctx);
    }
    char *file = ct_value_to_string_copy(ctx, argv[0]);
    char **args = NULL;
    size_t arg_count = 0;
    char *cwd = NULL;
    CtHostEnvEntry *env_entries = NULL;
    size_t env_count = 0;
    bool capture_output = true;
    if (ct_parse_string_array(ctx, argc >= 2 ? argv[1] : NULL, &args, &arg_count, exception) != 0 ||
        ct_parse_spawn_options(ctx, argc >= 3 ? argv[2] : NULL, &cwd, &env_entries, &env_count, &capture_output, exception) != 0) {
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }

    uint32_t id = ++runtime->next_process_id;

    int stdin_pipe[2] = { -1, -1 };
    int stdout_pipe[2] = { -1, -1 };
    int stderr_pipe[2] = { -1, -1 };
    if (pipe(stdin_pipe) != 0 || pipe(stdout_pipe) != 0 || pipe(stderr_pipe) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }

    pid_t pid = fork();
    if (pid == 0) {
        if (cwd != NULL) chdir(cwd);
        for (size_t index = 0; index < env_count; index += 1) {
            setenv(env_entries[index].name, env_entries[index].value, 1);
        }
        close(stdin_pipe[1]);
        close(stdout_pipe[0]);
        close(stderr_pipe[0]);
        dup2(stdin_pipe[0], STDIN_FILENO);
        dup2(stdout_pipe[1], STDOUT_FILENO);
        dup2(stderr_pipe[1], STDERR_FILENO);
        close(stdin_pipe[0]);
        close(stdout_pipe[1]);
        close(stderr_pipe[1]);
        char **argv_exec = (char **)calloc(arg_count + 2, sizeof(char *));
        if (argv_exec == NULL) _exit(127);
        argv_exec[0] = file;
        for (size_t index = 0; index < arg_count; index += 1) argv_exec[index + 1] = args[index];
        argv_exec[arg_count + 1] = NULL;
        execvp(file, argv_exec);
        _exit(127);
    }

    close(stdin_pipe[0]);
    close(stdout_pipe[1]);
    close(stderr_pipe[1]);
    if (pid < 0) {
        close(stdin_pipe[1]);
        close(stdout_pipe[0]);
        close(stderr_pipe[0]);
        ct_throw_message(ctx, exception, strerror(errno));
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }

    CtAsyncProcess *process = (CtAsyncProcess *)calloc(1, sizeof(CtAsyncProcess));
    if (process == NULL) {
        close(stdin_pipe[1]);
        close(stdout_pipe[0]);
        close(stderr_pipe[0]);
        ct_throw_message(ctx, exception, "Out of memory");
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }
    process->id = id;
    process->pid = pid;
    process->stdin_fd = stdin_pipe[1];
    process->stdout_fd = stdout_pipe[0];
    process->stderr_fd = stderr_pipe[0];
    process->runtime = runtime;
    pthread_mutex_lock(&ct_async_processes_mutex);
    process->next = ct_async_processes;
    ct_async_processes = process;
    pthread_mutex_unlock(&ct_async_processes_mutex);
    if (pthread_create(&process->thread, NULL, ct_async_process_thread, process) == 0) {
        pthread_detach(process->thread);
    }

    JSObjectRef response = ct_make_object(ctx);
    ct_set_property(ctx, response, "id", JSValueMakeNumber(ctx, id), exception);
    ct_set_property(ctx, response, "pid", JSValueMakeNumber(ctx, pid), exception);

    free(file);
    ct_free_string_array(args, arg_count);
    free(cwd);
    ct_free_env_entries(env_entries, env_count);
    return response;
}

static JSValueRef ct_spawn_write(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)exception;
    if (argc < 2) return JSValueMakeBoolean(ctx, false);
    uint32_t id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    uint8_t *bytes = NULL;
    size_t len = 0;
    char *text = NULL;
    if (ct_get_bytes(ctx, argv[1], &bytes, &len) != 0) {
        text = ct_value_to_string_copy(ctx, argv[1]);
        bytes = (uint8_t *)text;
        len = text != NULL ? strlen(text) : 0;
    }
    bool ok = false;
    pthread_mutex_lock(&ct_async_processes_mutex);
    CtAsyncProcess *process = ct_async_processes;
    while (process != NULL && process->id != id) process = process->next;
    if (process != NULL && process->stdin_fd >= 0) {
        ok = len == 0 || write(process->stdin_fd, bytes, len) >= 0;
    }
    pthread_mutex_unlock(&ct_async_processes_mutex);
    free(text);
    return JSValueMakeBoolean(ctx, ok);
}

static JSValueRef ct_spawn_close_stdin(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)exception;
    if (argc < 1) return JSValueMakeUndefined(ctx);
    uint32_t id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    pthread_mutex_lock(&ct_async_processes_mutex);
    CtAsyncProcess *process = ct_async_processes;
    while (process != NULL && process->id != id) process = process->next;
    if (process != NULL && process->stdin_fd >= 0) {
        close(process->stdin_fd);
        process->stdin_fd = -1;
    }
    pthread_mutex_unlock(&ct_async_processes_mutex);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_spawn_kill(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)exception;
    if (argc < 1) return JSValueMakeBoolean(ctx, false);
    uint32_t id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    int signal_number = argc >= 2 ? (int)ct_value_to_number(ctx, argv[1]) : SIGTERM;
    bool ok = false;
    pthread_mutex_lock(&ct_async_processes_mutex);
    CtAsyncProcess *process = ct_async_processes;
    while (process != NULL && process->id != id) process = process->next;
    if (process != NULL) ok = kill(process->pid, signal_number) == 0;
    pthread_mutex_unlock(&ct_async_processes_mutex);
    return JSValueMakeBoolean(ctx, ok);
}

static JSValueRef ct_spawn_detached(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "spawnDetached(file, args, options) requires a file");
        return JSValueMakeNumber(ctx, 0);
    }
    char *file = ct_value_to_string_copy(ctx, argv[0]);
    char **args = NULL;
    size_t arg_count = 0;
    char *cwd = NULL;
    CtHostEnvEntry *env_entries = NULL;
    size_t env_count = 0;
    bool capture_output = true;
    if (ct_parse_string_array(ctx, argc >= 2 ? argv[1] : NULL, &args, &arg_count, exception) != 0 ||
        ct_parse_spawn_options(ctx, argc >= 3 ? argv[2] : NULL, &cwd, &env_entries, &env_count, &capture_output, exception) != 0) {
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeNumber(ctx, 0);
    }

    pid_t pid = fork();
    if (pid == 0) {
        if (cwd != NULL) chdir(cwd);
        for (size_t index = 0; index < env_count; index += 1) {
            setenv(env_entries[index].name, env_entries[index].value, 1);
        }
        int dev_null = open("/dev/null", O_RDWR);
        if (dev_null >= 0) {
            dup2(dev_null, STDIN_FILENO);
            dup2(dev_null, STDOUT_FILENO);
            dup2(dev_null, STDERR_FILENO);
            if (dev_null > STDERR_FILENO) close(dev_null);
        }
        char **argv_exec = (char **)calloc(arg_count + 2, sizeof(char *));
        if (argv_exec == NULL) _exit(127);
        argv_exec[0] = file;
        for (size_t index = 0; index < arg_count; index += 1) argv_exec[index + 1] = args[index];
        argv_exec[arg_count + 1] = NULL;
        execvp(file, argv_exec);
        _exit(127);
    }

    if (pid < 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        pid = 0;
    }
    free(file);
    ct_free_string_array(args, arg_count);
    free(cwd);
    ct_free_env_entries(env_entries, env_count);
    return JSValueMakeNumber(ctx, (double)pid);
}

static JSValueRef ct_spawn_set_event_handler(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    (void)exception;
    CtQjsRuntime *runtime = ct_callback_runtime(function);
    if (runtime->spawn_event_handler != NULL) {
        JSValueUnprotect(ctx, runtime->spawn_event_handler);
        runtime->spawn_event_handler = NULL;
    }
    if (argc >= 1 && JSValueIsObject(ctx, argv[0])) {
        runtime->spawn_event_handler = (JSObjectRef)argv[0];
        JSValueProtect(ctx, runtime->spawn_event_handler);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_false(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
    (void)exception;
    return JSValueMakeBoolean(ctx, false);
}

static JSValueRef ct_undefined(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
    (void)exception;
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_dispatch_spawn_events(JSContextRef ctx, CtQjsRuntime *runtime, JSValueRef *exception) {
    if (runtime->spawn_event_handler == NULL) return JSValueMakeUndefined(ctx);
    for (;;) {
        pthread_mutex_lock(&runtime->spawn_event_mutex);
        CtSpawnEvent *event = runtime->spawn_events_head;
        if (event != NULL) {
            runtime->spawn_events_head = event->next;
            if (runtime->spawn_events_head == NULL) runtime->spawn_events_tail = NULL;
        }
        pthread_mutex_unlock(&runtime->spawn_event_mutex);
        if (event == NULL) break;

        JSObjectRef item = ct_make_object(ctx);
        ct_set_property(ctx, item, "id", JSValueMakeNumber(ctx, event->process_id), exception);
        ct_set_property(ctx, item, "type", ct_make_string(ctx, event->type != NULL ? event->type : ""), exception);
        if (event->data != NULL) {
            ct_set_property(ctx, item, "data", ct_array_buffer_from_copy(ctx, event->data, event->data_len, exception), exception);
        }
        if (strcmp(event->type != NULL ? event->type : "", "exit") == 0) {
            ct_set_property(ctx, item, "exitCode", JSValueMakeNumber(ctx, event->exit_code), exception);
            ct_set_property(ctx, item, "signalCode", JSValueMakeNull(ctx), exception);
            ct_set_property(ctx, item, "killed", JSValueMakeBoolean(ctx, event->killed), exception);
        }
        JSValueRef arg = item;
        JSObjectCallAsFunction(ctx, runtime->spawn_event_handler, NULL, 1, &arg, exception);
        free(event->type);
        free(event->data);
        free(event);
        if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_drain_jobs(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    (void)argc;
    (void)argv;
    CtQjsRuntime *runtime = ct_callback_runtime(function);
    return ct_dispatch_spawn_events(ctx, runtime, exception);
}

static JSValueRef ct_worker_spawn(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    (void)argc;
    (void)argv;
    (void)exception;
    CtQjsRuntime *runtime = ct_callback_runtime(function);
    uint32_t id = ++runtime->next_worker_id;
    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, id), exception);
    return result;
}

static void ct_queue_worker_message(CtQjsRuntime *runtime, uint32_t worker_id, char *message) {
    CtWorkerMessage *item = (CtWorkerMessage *)calloc(1, sizeof(CtWorkerMessage));
    if (item == NULL) {
        free(message);
        return;
    }
    item->worker_id = worker_id;
    item->message = message;
    if (runtime->worker_messages_tail != NULL) runtime->worker_messages_tail->next = item;
    else runtime->worker_messages_head = item;
    runtime->worker_messages_tail = item;
}

static JSValueRef ct_worker_post_message_to(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    CtQjsRuntime *runtime = ct_callback_runtime(function);
    if (argc < 2) return JSValueMakeUndefined(ctx);
    uint32_t id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    char *raw = ct_value_to_string_copy(ctx, argv[1]);
    if (raw == NULL) return JSValueMakeUndefined(ctx);

    JSStringRef source = ct_js_string(
        "(function(raw){"
        "const message=JSON.parse(raw);"
        "return JSON.stringify({type:'response',requestId:message.requestId,success:true,payload:{method:message.method,params:message.params}});"
        "})"
    );
    JSValueRef eval_exception = NULL;
    JSValueRef fn_value = JSEvaluateScript(ctx, source, NULL, NULL, 1, &eval_exception);
    JSStringRelease(source);
    if (eval_exception == NULL && fn_value != NULL && JSValueIsObject(ctx, fn_value)) {
        JSValueRef arg = ct_make_string(ctx, raw);
        JSValueRef call_exception = NULL;
        JSValueRef response = JSObjectCallAsFunction(ctx, (JSObjectRef)fn_value, NULL, 1, &arg, &call_exception);
        if (call_exception == NULL && response != NULL) {
            char *message = ct_value_to_string_copy(ctx, response);
            if (message != NULL) ct_queue_worker_message(runtime, id, message);
        } else if (exception != NULL) {
            *exception = call_exception;
        }
    } else if (exception != NULL) {
        *exception = eval_exception;
    }
    free(raw);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_worker_poll_messages(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    CtQjsRuntime *runtime = ct_callback_runtime(function);
    uint32_t id = argc >= 1 ? (uint32_t)ct_value_to_number(ctx, argv[0]) : 0;
    JSObjectRef result = ct_make_array(ctx, 0, NULL, exception);
    unsigned index = 0;
    CtWorkerMessage **cursor = &runtime->worker_messages_head;
    while (*cursor != NULL) {
        CtWorkerMessage *item = *cursor;
        if (item->worker_id != id) {
            cursor = &item->next;
            continue;
        }
        *cursor = item->next;
        if (runtime->worker_messages_tail == item) runtime->worker_messages_tail = NULL;
        JSObjectSetPropertyAtIndex(ctx, result, index++, ct_make_string(ctx, item->message), exception);
        free(item->message);
        free(item);
    }
    return result;
}

static JSValueRef ct_open_fd(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "openFd(path) requires a path");
        return JSValueMakeNumber(ctx, -1);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    char *flags = argc >= 2 ? ct_value_to_optional_string(ctx, argv[1]) : NULL;
    int open_flags = O_RDONLY;
    if (flags != NULL && (strchr(flags, 'w') != NULL)) open_flags = O_WRONLY | O_CREAT | O_TRUNC;
    int fd = open(path, open_flags, 0666);
    if (fd < 0) ct_throw_message(ctx, exception, strerror(errno));
    free(path);
    free(flags);
    return JSValueMakeNumber(ctx, fd);
}

static JSValueRef ct_read_fd(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) return ct_array_buffer_from_copy(ctx, "", 0, exception);
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    size_t max_bytes = argc >= 2 ? (size_t)ct_value_to_number(ctx, argv[1]) : 65536;
    char *buffer = (char *)malloc(max_bytes > 0 ? max_bytes : 1);
    if (buffer == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    ssize_t n = read(fd, buffer, max_bytes);
    if (n < 0) n = 0;
    JSValueRef result = ct_array_buffer_from_copy(ctx, buffer, (size_t)n, exception);
    free(buffer);
    return result;
}

static JSValueRef ct_close_fd(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)exception;
    if (argc >= 1) close((int)ct_value_to_number(ctx, argv[0]));
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_http_server_start(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    const char *hostname = "127.0.0.1";
    char *hostname_arg = NULL;
    int port_value = 0;
    if (argc >= 1 && !JSValueIsUndefined(ctx, argv[0]) && !JSValueIsNull(ctx, argv[0])) {
        hostname_arg = ct_value_to_string_copy(ctx, argv[0]);
        if (hostname_arg != NULL) hostname = hostname_arg;
    }
    if (argc >= 2) port_value = (int)ct_value_to_number(ctx, argv[1]);

    signal(SIGPIPE, SIG_IGN);
    int listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        free(hostname_arg);
        return JSValueMakeUndefined(ctx);
    }
    int yes = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port_value);
    if (strcmp(hostname, "0.0.0.0") == 0) {
        addr.sin_addr.s_addr = htonl(INADDR_ANY);
    } else if (inet_pton(AF_INET, hostname, &addr.sin_addr) != 1) {
        close(listen_fd);
        free(hostname_arg);
        ct_throw_message(ctx, exception, "Bun.serve currently requires an IPv4 hostname");
        return JSValueMakeUndefined(ctx);
    }

    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(listen_fd);
        ct_throw_message(ctx, exception, strerror(errno));
        free(hostname_arg);
        return JSValueMakeUndefined(ctx);
    }
    socklen_t addr_len = sizeof(addr);
    if (getsockname(listen_fd, (struct sockaddr *)&addr, &addr_len) != 0 ||
        listen(listen_fd, 128) != 0) {
        close(listen_fd);
        ct_throw_message(ctx, exception, strerror(errno));
        free(hostname_arg);
        return JSValueMakeUndefined(ctx);
    }

    CtHttpServer *server = (CtHttpServer *)calloc(1, sizeof(CtHttpServer));
    if (server == NULL) {
        close(listen_fd);
        ct_throw_message(ctx, exception, "Out of memory");
        free(hostname_arg);
        return JSValueMakeUndefined(ctx);
    }
    server->listen_fd = listen_fd;
    server->port = ntohs(addr.sin_port);
    server->hostname = ct_duplicate_string(hostname);
    pthread_mutex_init(&server->mutex, NULL);

    pthread_mutex_lock(&ct_http_servers_mutex);
    server->id = ct_next_http_server_id++;
    if (ct_next_http_server_id == 0) ct_next_http_server_id = 1;
    server->next = ct_http_servers;
    ct_http_servers = server;
    pthread_mutex_unlock(&ct_http_servers_mutex);

    if (pthread_create(&server->thread, NULL, ct_http_server_thread, server) != 0) {
        pthread_mutex_lock(&ct_http_servers_mutex);
        if (ct_http_servers == server) ct_http_servers = server->next;
        pthread_mutex_unlock(&ct_http_servers_mutex);
        close(listen_fd);
        free(server->hostname);
        pthread_mutex_destroy(&server->mutex);
        free(server);
        free(hostname_arg);
        ct_throw_message(ctx, exception, "pthread_create failed");
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, server->id), exception);
    ct_set_property(ctx, result, "port", JSValueMakeNumber(ctx, server->port), exception);
    ct_set_property(ctx, result, "hostname", ct_make_string(ctx, server->hostname), exception);
    free(hostname_arg);
    return result;
}

static JSValueRef ct_http_server_poll(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) return JSValueMakeNull(ctx);
    uint32_t server_id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    pthread_mutex_lock(&ct_http_servers_mutex);
    CtHttpServer *server = ct_http_find_server(server_id);
    pthread_mutex_unlock(&ct_http_servers_mutex);
    if (server == NULL) return JSValueMakeNull(ctx);

    JSObjectRef result = NULL;
    pthread_mutex_lock(&server->mutex);
    CtHttpRequest *request = server->requests;
    while (request != NULL && request->claimed) request = request->next;
    if (request != NULL) {
        request->claimed = true;
        result = ct_make_object(ctx);
        ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, request->id), exception);
        ct_set_property(ctx, result, "method", ct_make_string(ctx, request->method != NULL ? request->method : "GET"), exception);
        ct_set_property(ctx, result, "url", ct_make_string(ctx, request->url != NULL ? request->url : "/"), exception);
        ct_set_property(ctx, result, "headersText", ct_make_string(ctx, request->headers_text != NULL ? request->headers_text : ""), exception);
        ct_set_property(ctx, result, "body", ct_array_buffer_from_copy(ctx, request->body != NULL ? request->body : "", request->body_len, exception), exception);
    }
    pthread_mutex_unlock(&server->mutex);
    return result != NULL ? result : JSValueMakeNull(ctx);
}

static JSValueRef ct_http_server_respond(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 5) {
        ct_throw_message(ctx, exception, "httpServerRespond requires server id, request id, status, headers, body");
        return JSValueMakeUndefined(ctx);
    }
    uint32_t server_id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    uint32_t request_id = (uint32_t)ct_value_to_number(ctx, argv[1]);
    int status = (int)ct_value_to_number(ctx, argv[2]);
    char *headers_text = ct_value_to_string_copy(ctx, argv[3]);
    uint8_t *body_data = NULL;
    size_t body_len = 0;
    if (ct_get_bytes(ctx, argv[4], &body_data, &body_len) != 0) {
        free(headers_text);
        ct_throw_message(ctx, exception, "HTTP response body must be ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }
    char *body_copy = (char *)malloc(body_len > 0 ? body_len : 1);
    if (body_copy == NULL) {
        free(headers_text);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    if (body_len > 0) memcpy(body_copy, body_data, body_len);

    pthread_mutex_lock(&ct_http_servers_mutex);
    CtHttpServer *server = ct_http_find_server(server_id);
    pthread_mutex_unlock(&ct_http_servers_mutex);
    if (server == NULL) {
        free(headers_text);
        free(body_copy);
        ct_throw_message(ctx, exception, "HTTP server not found");
        return JSValueMakeUndefined(ctx);
    }

    pthread_mutex_lock(&server->mutex);
    CtHttpRequest *request = server->requests;
    while (request != NULL && request->id != request_id) request = request->next;
    pthread_mutex_unlock(&server->mutex);
    if (request == NULL) {
        free(headers_text);
        free(body_copy);
        ct_throw_message(ctx, exception, "HTTP request not found");
        return JSValueMakeUndefined(ctx);
    }

    pthread_mutex_lock(&request->mutex);
    request->status = status;
    request->response_headers_text = headers_text;
    request->response_body = body_copy;
    request->response_body_len = body_len;
    request->completed = true;
    pthread_cond_signal(&request->cond);
    pthread_mutex_unlock(&request->mutex);
    return JSValueMakeUndefined(ctx);
}

static void ct_http_stop_server(CtHttpServer *server, bool remove_from_global_list) {
    if (server == NULL) return;
    pthread_mutex_lock(&server->mutex);
    if (!server->stopped) {
        server->stopped = true;
        shutdown(server->listen_fd, SHUT_RDWR);
        close(server->listen_fd);
        CtHttpRequest *request = server->requests;
        while (request != NULL) {
            pthread_mutex_lock(&request->mutex);
            request->completed = true;
            pthread_cond_signal(&request->cond);
            pthread_mutex_unlock(&request->mutex);
            request = request->next;
        }
    }
    pthread_mutex_unlock(&server->mutex);
    pthread_join(server->thread, NULL);

    if (remove_from_global_list) {
        pthread_mutex_lock(&ct_http_servers_mutex);
        if (ct_http_servers == server) {
            ct_http_servers = server->next;
        } else {
            CtHttpServer *cursor = ct_http_servers;
            while (cursor != NULL && cursor->next != server) cursor = cursor->next;
            if (cursor != NULL) cursor->next = server->next;
        }
        pthread_mutex_unlock(&ct_http_servers_mutex);
    }

    CtHttpRequest *request = server->requests;
    while (request != NULL) {
        CtHttpRequest *next = request->next;
        ct_http_free_request(request);
        request = next;
    }
    free(server->hostname);
    pthread_mutex_destroy(&server->mutex);
    free(server);
}

static JSValueRef ct_http_server_stop(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)exception;
    if (argc < 1) return JSValueMakeUndefined(ctx);
    uint32_t server_id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    pthread_mutex_lock(&ct_http_servers_mutex);
    CtHttpServer *server = ct_http_find_server(server_id);
    pthread_mutex_unlock(&ct_http_servers_mutex);
    if (server != NULL) ct_http_stop_server(server, true);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_exit(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)exception;
    int code = argc >= 1 ? (int)ct_value_to_number(ctx, argv[0]) : 0;
    exit(code);
}

static bool ct_install_function(JSContextRef ctx, JSObjectRef target, const char *name, JSObjectCallAsFunctionCallback callback, CtQjsRuntime *runtime) {
    JSValueRef exception = NULL;
    return ct_set_property(ctx, target, name, ct_make_function(ctx, name, callback, runtime), &exception);
}

static int ct_install_host_api(CtQjsRuntime *runtime) {
    JSContextRef ctx = runtime->context;
    JSValueRef exception = NULL;
    JSObjectRef global = JSContextGetGlobalObject(ctx);

    JSObjectRef console = ct_make_object(ctx);
    ct_set_property(ctx, console, "log", ct_make_plain_function(ctx, "log", ct_console_log), &exception);
    ct_set_property(ctx, console, "error", ct_make_plain_function(ctx, "error", ct_console_error), &exception);
    ct_set_property(ctx, console, "warn", ct_make_plain_function(ctx, "warn", ct_console_error), &exception);
    ct_set_property(ctx, global, "console", console, &exception);

    JSObjectRef host = ct_make_object(ctx);
    runtime->host_object = host;
    JSValueProtect(ctx, host);

    ct_install_function(ctx, host, "nanotime", ct_nanotime, runtime);
    ct_install_function(ctx, host, "sleep", ct_sleep, runtime);
    ct_install_function(ctx, host, "drainJobs", ct_drain_jobs, runtime);
    ct_install_function(ctx, host, "cwd", ct_cwd, runtime);
    ct_install_function(ctx, host, "readFile", ct_read_file, runtime);
    ct_install_function(ctx, host, "readFileBuffer", ct_read_file_buffer, runtime);
    ct_install_function(ctx, host, "writeFile", ct_write_file, runtime);
    ct_install_function(ctx, host, "openFd", ct_open_fd, runtime);
    ct_install_function(ctx, host, "readFd", ct_read_fd, runtime);
    ct_install_function(ctx, host, "closeFd", ct_close_fd, runtime);
    ct_install_function(ctx, host, "env", ct_env, runtime);
    ct_install_function(ctx, host, "existsSync", ct_exists_sync, runtime);
    ct_install_function(ctx, host, "statSync", ct_stat_sync, runtime);
    ct_install_function(ctx, host, "readDirSync", ct_read_dir_sync, runtime);
    ct_install_function(ctx, host, "mkdirSync", ct_mkdir_sync, runtime);
    ct_install_function(ctx, host, "rmSync", ct_rm_sync, runtime);
    ct_install_function(ctx, host, "unlinkSync", ct_unlink_sync, runtime);
    ct_install_function(ctx, host, "chmodSync", ct_chmod_sync, runtime);
    ct_install_function(ctx, host, "spawnSync", ct_spawn_sync, runtime);
    ct_install_function(ctx, host, "spawnStart", ct_spawn_start, runtime);
    ct_install_function(ctx, host, "spawnWrite", ct_spawn_write, runtime);
    ct_install_function(ctx, host, "spawnCloseStdin", ct_spawn_close_stdin, runtime);
    ct_install_function(ctx, host, "spawnKill", ct_spawn_kill, runtime);
    ct_install_function(ctx, host, "spawnDispose", ct_undefined, runtime);
    ct_install_function(ctx, host, "spawnSetEventHandler", ct_spawn_set_event_handler, runtime);
    ct_install_function(ctx, host, "spawnDetached", ct_spawn_detached, runtime);
    ct_install_function(ctx, host, "httpServerStart", ct_http_server_start, runtime);
    ct_install_function(ctx, host, "httpServerPoll", ct_http_server_poll, runtime);
    ct_install_function(ctx, host, "httpServerRespond", ct_http_server_respond, runtime);
    ct_install_function(ctx, host, "httpServerStop", ct_http_server_stop, runtime);
    ct_install_function(ctx, host, "spawnWorker", ct_worker_spawn, runtime);
    ct_install_function(ctx, host, "isWorker", ct_false, runtime);
    ct_install_function(ctx, host, "workerPostMessage", ct_undefined, runtime);
    ct_install_function(ctx, host, "workerPollIncomingMessages", ct_worker_poll_messages, runtime);
    ct_install_function(ctx, host, "workerPostMessageTo", ct_worker_post_message_to, runtime);
    ct_install_function(ctx, host, "workerPollMessages", ct_worker_poll_messages, runtime);
    ct_install_function(ctx, host, "workerTerminate", ct_undefined, runtime);
    ct_install_function(ctx, host, "exit", ct_exit, runtime);
    ct_install_function(ctx, host, "execPath", ct_exec_path, runtime);
    ct_install_function(ctx, host, "pid", ct_pid, runtime);
    ct_install_function(ctx, host, "platform", ct_platform, runtime);
    ct_install_function(ctx, host, "arch", ct_arch, runtime);
    ct_install_function(ctx, host, "hostname", ct_hostname, runtime);
    JSObjectRef args = ct_make_array(ctx, 0, NULL, &exception);
    ct_set_property(ctx, host, "args", args, &exception);
    ct_set_property(ctx, global, "cottontail", host, &exception);

    JSStringRef bootstrap = ct_js_string(
        "globalThis.global = globalThis;"
        "globalThis.__ctUnhandledRejection = undefined;"
        "if (typeof Promise === 'function' && !Promise.__cottontailPatchedReject) {"
        "  const reject = Promise.reject.bind(Promise);"
        "  Promise.reject = function(reason){ globalThis.__ctUnhandledRejection = reason; return reject(reason); };"
        "  Promise.__cottontailPatchedReject = true;"
        "}"
    );
    JSValueRef bootstrap_exception = NULL;
    JSEvaluateScript(ctx, bootstrap, NULL, NULL, 1, &bootstrap_exception);
    JSStringRelease(bootstrap);

    return exception == NULL && bootstrap_exception == NULL ? 0 : -1;
}

CtQjsRuntime *ct_qjs_runtime_create(void) {
    return ct_qjs_runtime_create_with_stack_size(0);
}

CtQjsRuntime *ct_qjs_runtime_create_with_stack_size(size_t stack_size) {
    (void)stack_size;
    CtQjsRuntime *runtime = (CtQjsRuntime *)calloc(1, sizeof(CtQjsRuntime));
    if (runtime == NULL) return NULL;
    runtime->context = JSGlobalContextCreate(NULL);
    if (runtime->context == NULL) {
        free(runtime);
        return NULL;
    }
    pthread_mutex_init(&runtime->spawn_event_mutex, NULL);
    if (ct_install_host_api(runtime) != 0) {
        ct_qjs_runtime_destroy(runtime);
        return NULL;
    }
    return runtime;
}

void ct_qjs_runtime_destroy(CtQjsRuntime *runtime) {
    if (runtime == NULL) return;
    ct_async_processes_wait_for_runtime(runtime);
    pthread_mutex_lock(&ct_http_servers_mutex);
    CtHttpServer *servers = ct_http_servers;
    ct_http_servers = NULL;
    pthread_mutex_unlock(&ct_http_servers_mutex);
    while (servers != NULL) {
        CtHttpServer *next = servers->next;
        ct_http_stop_server(servers, false);
        servers = next;
    }

    JSContextRef ctx = runtime->context;
    if (ctx != NULL) {
        if (runtime->spawn_event_handler != NULL) JSValueUnprotect(ctx, runtime->spawn_event_handler);
        if (runtime->host_object != NULL) JSValueUnprotect(ctx, runtime->host_object);
        JSGlobalContextRelease(runtime->context);
    }
    while (runtime->spawn_events_head != NULL) {
        CtSpawnEvent *event = runtime->spawn_events_head;
        runtime->spawn_events_head = event->next;
        free(event->type);
        free(event->data);
        free(event);
    }
    while (runtime->worker_messages_head != NULL) {
        CtWorkerMessage *message = runtime->worker_messages_head;
        runtime->worker_messages_head = message->next;
        free(message->message);
        free(message);
    }
    pthread_mutex_destroy(&runtime->spawn_event_mutex);
    free(runtime);
}

int ct_qjs_runtime_set_args(CtQjsRuntime *runtime, size_t argc, const char *const *argv, char **error_out) {
    if (error_out != NULL) *error_out = NULL;
    JSContextRef ctx = runtime->context;
    JSValueRef exception = NULL;
    size_t user_argc = argc > 0 ? argc - 1 : 0;
    JSValueRef *arg_values = user_argc > 0 ? (JSValueRef *)calloc(user_argc, sizeof(JSValueRef)) : NULL;
    JSValueRef *argv_values = (JSValueRef *)calloc(argc + 1, sizeof(JSValueRef));
    if ((user_argc > 0 && arg_values == NULL) || argv_values == NULL) {
        free(arg_values);
        free(argv_values);
        ct_set_error_out(error_out, ct_duplicate_bytes("Out of memory", 13));
        return -1;
    }
    argv_values[0] = ct_make_string(ctx, "cottontail");
    for (size_t index = 0; index < argc; index += 1) {
        argv_values[index + 1] = ct_make_string(ctx, argv[index]);
    }
    for (size_t index = 0; index < user_argc; index += 1) {
        arg_values[index] = ct_make_string(ctx, argv[index + 1]);
    }
    JSObjectRef args = ct_make_array(ctx, user_argc, arg_values, &exception);
    JSObjectRef process_argv = exception == NULL ? ct_make_array(ctx, argc + 1, argv_values, &exception) : NULL;
    free(arg_values);
    free(argv_values);
    if (exception != NULL) {
        ct_set_error_out(error_out, ct_copy_exception(ctx, exception));
        return -1;
    }
    ct_set_property(ctx, runtime->host_object, "args", args, &exception);
    if (exception == NULL) ct_set_property(ctx, runtime->host_object, "argv", process_argv, &exception);
    if (exception != NULL) {
        ct_set_error_out(error_out, ct_copy_exception(ctx, exception));
        return -1;
    }
    return 0;
}

static char *ct_prepare_wrapped_source(const uint8_t *source, size_t source_len) {
    const char *prefix =
        "globalThis.__ctDone=false;globalThis.__ctError=undefined;"
        "Promise.resolve((async()=>{\n";
    const char *suffix =
        "\n})()).then(()=>{globalThis.__ctDone=true;},"
        "e=>{globalThis.__ctError=e;globalThis.__ctDone=true;});";
    size_t prefix_len = strlen(prefix);
    size_t suffix_len = strlen(suffix);
    char *out = (char *)malloc(prefix_len + source_len + suffix_len + 1);
    if (out == NULL) return NULL;
    memcpy(out, prefix, prefix_len);
    char *cursor = out + prefix_len;

    const char *start = (const char *)source;
    const char *end = start + source_len;
    while (start < end) {
        const char *line_end = memchr(start, '\n', (size_t)(end - start));
        if (line_end == NULL) line_end = end;
        const char *trim = start;
        while (trim < line_end && (*trim == ' ' || *trim == '\t')) trim += 1;
        bool skip = false;
        if ((size_t)(line_end - trim) >= 9 && strncmp(trim, "export {", 8) == 0) {
            skip = true;
        }
        if (!skip) {
            size_t line_len = (size_t)(line_end - start);
            memcpy(cursor, start, line_len);
            cursor += line_len;
            if (line_end < end) *cursor++ = '\n';
        }
        start = line_end < end ? line_end + 1 : end;
    }

    memcpy(cursor, suffix, suffix_len);
    cursor += suffix_len;
    *cursor = 0;
    return out;
}

static bool ct_global_bool(JSContextRef ctx, const char *name) {
    JSValueRef exception = NULL;
    JSValueRef value = ct_get_property(ctx, JSContextGetGlobalObject(ctx), name, &exception);
    return exception == NULL && value != NULL && JSValueToBoolean(ctx, value);
}

static JSValueRef ct_global_value(JSContextRef ctx, const char *name) {
    JSValueRef exception = NULL;
    return ct_get_property(ctx, JSContextGetGlobalObject(ctx), name, &exception);
}

static int ct_jsc_runtime_has_active_handles(CtQjsRuntime *runtime, bool *has_active_handles_out, char **error_out) {
    *has_active_handles_out = false;
    JSContextRef ctx = runtime->context;
    JSStringRef source = ct_js_string(
        "globalThis.__cottontailHasActiveHandles ? globalThis.__cottontailHasActiveHandles() : false"
    );
    JSValueRef exception = NULL;
    JSValueRef value = JSEvaluateScript(ctx, source, NULL, NULL, 1, &exception);
    JSStringRelease(source);
    if (exception != NULL) {
        ct_set_error_out(error_out, ct_copy_exception(ctx, exception));
        return -1;
    }
    *has_active_handles_out = value != NULL && JSValueToBoolean(ctx, value);
    return 0;
}

int ct_qjs_runtime_eval(CtQjsRuntime *runtime, const uint8_t *source, size_t source_len, const char *filename, char **error_out) {
    if (error_out != NULL) *error_out = NULL;
    JSContextRef ctx = runtime->context;
    char *wrapped = ct_prepare_wrapped_source(source, source_len);
    if (wrapped == NULL) {
        ct_set_error_out(error_out, ct_duplicate_bytes("Out of memory", 13));
        return -1;
    }

    JSStringRef script = ct_js_string(wrapped);
    JSStringRef source_url = ct_js_string(filename != NULL ? filename : "<script>");
    JSValueRef exception = NULL;
    JSEvaluateScript(ctx, script, NULL, source_url, 1, &exception);
    JSStringRelease(script);
    JSStringRelease(source_url);
    free(wrapped);
    if (exception != NULL) {
        ct_set_error_out(error_out, ct_copy_exception(ctx, exception));
        return -1;
    }

    for (int index = 0; index < 30000 && !ct_global_bool(ctx, "__ctDone"); index += 1) {
        if (ct_qjs_runtime_tick(runtime, error_out) != 0) return -1;
        usleep(1000);
    }

    JSValueRef error_value = ct_global_value(ctx, "__ctError");
    if (error_value != NULL && !JSValueIsUndefined(ctx, error_value) && !JSValueIsNull(ctx, error_value)) {
        ct_set_error_out(error_out, ct_copy_exception(ctx, error_value));
        return -1;
    }
    JSValueRef unhandled = ct_global_value(ctx, "__ctUnhandledRejection");
    if (unhandled != NULL && !JSValueIsUndefined(ctx, unhandled) && !JSValueIsNull(ctx, unhandled)) {
        ct_set_error_out(error_out, ct_copy_exception(ctx, unhandled));
        return -1;
    }

    for (;;) {
        bool has_active_handles = false;
        if (ct_jsc_runtime_has_active_handles(runtime, &has_active_handles, error_out) != 0) return -1;
        if (!has_active_handles) break;
        if (ct_qjs_runtime_tick(runtime, error_out) != 0) return -1;
        usleep(1000);
    }

    unhandled = ct_global_value(ctx, "__ctUnhandledRejection");
    if (unhandled != NULL && !JSValueIsUndefined(ctx, unhandled) && !JSValueIsNull(ctx, unhandled)) {
        ct_set_error_out(error_out, ct_copy_exception(ctx, unhandled));
        return -1;
    }
    return 0;
}

int ct_qjs_runtime_tick(CtQjsRuntime *runtime, char **error_out) {
    if (error_out != NULL) *error_out = NULL;
    JSContextRef ctx = runtime->context;
    JSStringRef source = ct_js_string(
        "(function(){"
        "let delay=16;"
        "if(globalThis.__cottontailRunLoopTick) delay=globalThis.__cottontailRunLoopTick();"
        "return delay == null ? 16 : Number(delay);"
        "})()"
    );
    JSValueRef exception = NULL;
    JSEvaluateScript(ctx, source, NULL, NULL, 1, &exception);
    JSStringRelease(source);
    if (exception != NULL) {
        ct_set_error_out(error_out, ct_copy_exception(ctx, exception));
        return -1;
    }
    return 0;
}

void ct_qjs_string_free(char *value) {
    free(value);
}
