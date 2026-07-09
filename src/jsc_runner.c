#include "jsc_runner.h"

#include <JavaScriptCore/JavaScript.h>
#include <arpa/inet.h>
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <ffi/ffi.h>
#include <fcntl.h>
#include <limits.h>
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
#include <zlib.h>

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

#define CT_FFI_MAX_ARGS 64
#define CT_WORKER_STACK_SIZE (32u * 1024u * 1024u)

static void ct_clear_environment(void) {
    while (environ != NULL && environ[0] != NULL) {
        const char *entry = environ[0];
        const char *equals = strchr(entry, '=');
        if (equals == NULL) break;
        size_t name_len = (size_t)(equals - entry);
        char *name = (char *)malloc(name_len + 1);
        if (name == NULL) return;
        memcpy(name, entry, name_len);
        name[name_len] = '\0';
        unsetenv(name);
        free(name);
    }
}

typedef struct {
    const char *name;
    const char *value;
} CtHostEnvEntry;

typedef struct {
    const char *cwd;
    const CtHostEnvEntry *env_entries;
    size_t env_count;
    bool clear_env;
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

typedef enum {
    CT_FFI_TYPE_VOID,
    CT_FFI_TYPE_BOOL,
    CT_FFI_TYPE_U8,
    CT_FFI_TYPE_I8,
    CT_FFI_TYPE_U16,
    CT_FFI_TYPE_I16,
    CT_FFI_TYPE_U32,
    CT_FFI_TYPE_I32,
    CT_FFI_TYPE_U64,
    CT_FFI_TYPE_I64,
    CT_FFI_TYPE_F32,
    CT_FFI_TYPE_F64,
    CT_FFI_TYPE_PTR,
    CT_FFI_TYPE_CSTRING,
    CT_FFI_TYPE_FUNCTION,
} CtFfiType;

typedef union {
    uint8_t u8;
    int8_t i8;
    uint16_t u16;
    int16_t i16;
    uint32_t u32;
    int32_t i32;
    uint64_t u64;
    int64_t i64;
    float f32;
    double f64;
    void *ptr;
} CtFfiValue;

typedef struct CtFfiCallback CtFfiCallback;

typedef struct CtFfiCallbackJob {
    CtFfiCallback *callback;
    size_t argc;
    CtFfiValue args[CT_FFI_MAX_ARGS];
    CtFfiValue result;
    bool completed;
    bool wait_for_result;
    struct CtFfiCallbackJob *next;
    pthread_mutex_t mutex;
    pthread_cond_t cond;
} CtFfiCallbackJob;

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

typedef struct CtFdEvent {
    uint32_t watch_id;
    char *type;
    char *data;
    size_t data_len;
    char *message;
    struct CtFdEvent *next;
} CtFdEvent;

typedef struct CtWorker CtWorker;

typedef struct CtWorkerMessage {
    char *json;
    struct CtWorkerMessage *next;
} CtWorkerMessage;

typedef struct CtWorkerEvent {
    uint32_t worker_id;
    struct CtWorkerEvent *next;
} CtWorkerEvent;

struct CtWorker {
    uint32_t id;
    pthread_t thread;
    bool terminated;
    pthread_mutex_t mutex;
    CtJscRuntime *parent_runtime;
    CtWorkerMessage *parent_to_worker_head;
    CtWorkerMessage *parent_to_worker_tail;
    CtWorkerMessage *worker_to_parent_head;
    CtWorkerMessage *worker_to_parent_tail;
    struct CtWorker *next;
};

typedef struct {
    char *script_path;
    CtWorker *worker;
} CtWorkerStart;

typedef struct CtAsyncProcess {
    uint32_t id;
    pid_t pid;
    int stdin_fd;
    int stdout_fd;
    int stderr_fd;
    CtJscRuntime *runtime;
    pthread_t thread;
    struct CtAsyncProcess *next;
} CtAsyncProcess;

typedef struct CtFdWatcher {
    uint32_t id;
    int fd;
    size_t max_bytes;
    CtJscRuntime *runtime;
    pthread_t thread;
    pthread_mutex_t mutex;
    bool active;
    struct CtFdWatcher *next;
} CtFdWatcher;

typedef enum {
    CT_PROCESS_STDIO_PIPE,
    CT_PROCESS_STDIO_INHERIT,
    CT_PROCESS_STDIO_IGNORE,
} CtProcessStdioMode;

static pthread_mutex_t ct_async_processes_mutex = PTHREAD_MUTEX_INITIALIZER;
static CtAsyncProcess *ct_async_processes = NULL;
static pthread_mutex_t ct_fd_watchers_mutex = PTHREAD_MUTEX_INITIALIZER;
static CtFdWatcher *ct_fd_watchers = NULL;
static pthread_mutex_t ct_workers_mutex = PTHREAD_MUTEX_INITIALIZER;
static CtWorker *ct_workers = NULL;
static uint32_t ct_next_worker_id = 1;

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

struct CtJscRuntime {
    JSGlobalContextRef context;
    JSObjectRef host_object;
    JSObjectRef spawn_event_handler;
    JSObjectRef fd_event_handler;
    JSObjectRef worker_event_handler;
    pthread_mutex_t spawn_event_mutex;
    CtSpawnEvent *spawn_events_head;
    CtSpawnEvent *spawn_events_tail;
    pthread_mutex_t fd_event_mutex;
    CtFdEvent *fd_events_head;
    CtFdEvent *fd_events_tail;
    pthread_mutex_t worker_event_mutex;
    CtWorkerEvent *worker_events_head;
    CtWorkerEvent *worker_events_tail;
    CtWorker *worker;
    pthread_t owner_thread;
    pthread_mutex_t callback_mutex;
    CtFfiCallbackJob *callback_jobs_head;
    CtFfiCallbackJob *callback_jobs_tail;
    CtFfiCallback *callbacks;
    uint32_t next_process_id;
    uint32_t next_worker_id;
    uint32_t next_fd_watch_id;
};

static int ct_jsc_runtime_eval_internal(
    CtJscRuntime *runtime,
    const uint8_t *source,
    size_t source_len,
    const char *filename,
    bool wait_for_active_handles,
    char **error_out
);
static int ct_jsc_runtime_tick_with_delay(CtJscRuntime *runtime, int *delay_ms_out, char **error_out);
static char *ct_prepare_sync_source(const uint8_t *source, size_t source_len, const char *filename);

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

static bool ct_debug_flag(const char *name) {
    const char *value = getenv(name);
    return value != NULL && value[0] != 0 && strcmp(value, "0") != 0;
}

static int ct_read_file_bytes(const char *path, char **out_buf, size_t *out_len) {
    FILE *file = fopen(path, "rb");
    long len = 0;
    char *buffer = NULL;
    size_t read_len = 0;

    if (file == NULL) return -1;
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return -1;
    }
    len = ftell(file);
    if (len < 0) {
        fclose(file);
        return -1;
    }
    if (fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return -1;
    }

    buffer = (char *)malloc((size_t)len + 1);
    if (buffer == NULL) {
        fclose(file);
        return -1;
    }
    read_len = fread(buffer, 1, (size_t)len, file);
    if (ferror(file)) {
        free(buffer);
        fclose(file);
        return -1;
    }
    fclose(file);
    buffer[read_len] = 0;
    *out_buf = buffer;
    *out_len = read_len;
    return 0;
}

static bool ct_is_absolute_path(const char *path) {
    return path != NULL && path[0] == '/';
}

static bool ct_is_relative_path(const char *path) {
    return path != NULL && (
        strncmp(path, "./", 2) == 0 ||
        strncmp(path, "../", 3) == 0 ||
        strcmp(path, ".") == 0 ||
        strcmp(path, "..") == 0
    );
}

static int ct_hex_digit(char ch) {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
}

static char *ct_file_url_to_path(const char *url) {
    const char *cursor = url + strlen("file://");
    size_t len = strlen(cursor);
    char *out = (char *)malloc(len + 1);
    size_t out_len = 0;
    if (out == NULL) return NULL;

    while (*cursor != 0) {
        if (*cursor == '%' && cursor[1] != 0 && cursor[2] != 0) {
            int hi = ct_hex_digit(cursor[1]);
            int lo = ct_hex_digit(cursor[2]);
            if (hi >= 0 && lo >= 0) {
                out[out_len++] = (char)((hi << 4) | lo);
                cursor += 3;
                continue;
            }
        }
        out[out_len++] = *cursor++;
    }
    out[out_len] = 0;
    return out;
}

static char *ct_path_dirname(const char *path) {
    if (path == NULL || path[0] == 0 || path[0] == '<') {
        char cwd[PATH_MAX];
        if (getcwd(cwd, sizeof(cwd)) == NULL) return ct_duplicate_string(".");
        return ct_duplicate_string(cwd);
    }

    char *path_copy = NULL;
    if (strncmp(path, "file://", 7) == 0) {
        path_copy = ct_file_url_to_path(path);
    } else {
        path_copy = ct_duplicate_string(path);
    }
    if (path_copy == NULL) return NULL;

    char *slash = strrchr(path_copy, '/');
    if (slash == NULL) {
        free(path_copy);
        char cwd[PATH_MAX];
        if (getcwd(cwd, sizeof(cwd)) == NULL) return ct_duplicate_string(".");
        return ct_duplicate_string(cwd);
    }
    if (slash == path_copy) {
        slash[1] = 0;
    } else {
        slash[0] = 0;
    }
    return path_copy;
}

static char *ct_join_paths(const char *base, const char *leaf) {
    size_t base_len = strlen(base != NULL ? base : "");
    size_t leaf_len = strlen(leaf != NULL ? leaf : "");
    bool needs_slash = base_len > 0 && base[base_len - 1] != '/';
    char *out = (char *)malloc(base_len + (needs_slash ? 1 : 0) + leaf_len + 1);
    if (out == NULL) return NULL;
    memcpy(out, base, base_len);
    size_t cursor = base_len;
    if (needs_slash) out[cursor++] = '/';
    memcpy(out + cursor, leaf, leaf_len);
    cursor += leaf_len;
    out[cursor] = 0;
    return out;
}

static char *ct_resolve_import_path(const char *specifier, const char *referrer) {
    char *candidate = NULL;
    if (specifier == NULL || specifier[0] == 0) return NULL;

    if (strncmp(specifier, "file://", 7) == 0) {
        candidate = ct_file_url_to_path(specifier);
    } else if (ct_is_absolute_path(specifier)) {
        candidate = ct_duplicate_string(specifier);
    } else if (ct_is_relative_path(specifier)) {
        char *dir = ct_path_dirname(referrer);
        if (dir == NULL) return NULL;
        candidate = ct_join_paths(dir, specifier);
        free(dir);
    } else {
        candidate = ct_duplicate_string(specifier);
    }

    if (candidate == NULL) return NULL;
    char *resolved = realpath(candidate, NULL);
    if (resolved != NULL) {
        free(candidate);
        return resolved;
    }
    return candidate;
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

static int ct_fill_random_bytes(uint8_t *buffer, size_t len) {
    if (len == 0) return 0;
#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
    arc4random_buf(buffer, len);
    return 0;
#else
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) return -1;
    size_t offset = 0;
    while (offset < len) {
        ssize_t count = read(fd, buffer + offset, len - offset);
        if (count > 0) {
            offset += (size_t)count;
            continue;
        }
        if (count < 0 && errno == EINTR) continue;
        close(fd);
        return -1;
    }
    close(fd);
    return 0;
#endif
}

static JSValueRef ct_random_bytes(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.randomBytes(size) requires a byte length");
        return JSValueMakeUndefined(ctx);
    }
    double length_value = ct_value_to_number(ctx, argv[0]);
    if (length_value < 0 || length_value > 2147483647.0) {
        ct_throw_message(ctx, exception, "Invalid random byte length");
        return JSValueMakeUndefined(ctx);
    }
    size_t len = (size_t)length_value;
    uint8_t *buffer = (uint8_t *)malloc(len > 0 ? len : 1);
    if (buffer == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    if (ct_fill_random_bytes(buffer, len) != 0) {
        free(buffer);
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, buffer, len, ct_array_buffer_free, NULL, exception);
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

static JSValueRef ct_make_function(JSContextRef ctx, const char *name, JSObjectCallAsFunctionCallback callback, CtJscRuntime *runtime) {
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

static CtJscRuntime *ct_callback_runtime(JSObjectRef function) {
    return (CtJscRuntime *)JSObjectGetPrivate(function);
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

static JSValueRef ct_kill_process(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.kill(pid[, signal]) requires a process id");
        return JSValueMakeBoolean(ctx, false);
    }
    pid_t pid = (pid_t)ct_value_to_number(ctx, argv[0]);
    int signal_number = argc >= 2 ? (int)ct_value_to_number(ctx, argv[1]) : SIGTERM;
    if (kill(pid, signal_number) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeBoolean(ctx, false);
    }
    return JSValueMakeBoolean(ctx, true);
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

struct CtFfiCallback {
    CtJscRuntime *runtime;
    JSContextRef ctx;
    JSObjectRef function;
    CtFfiType returns;
    CtFfiType arg_types[CT_FFI_MAX_ARGS];
    ffi_type *ffi_arg_types[CT_FFI_MAX_ARGS];
    size_t argc;
    bool threadsafe;
    pthread_t owner_thread;
    ffi_cif cif;
    ffi_closure *closure;
    void *code;
    bool closed;
    struct CtFfiCallback *next;
};

typedef struct CtNativeLibrary {
    char *path;
    void *handle;
    struct CtNativeLibrary *next;
} CtNativeLibrary;

static pthread_mutex_t ct_native_libraries_mutex = PTHREAD_MUTEX_INITIALIZER;
static CtNativeLibrary *ct_native_libraries = NULL;

static void *ct_get_native_library_handle(const char *path, char **error_out) {
    void *handle = NULL;

    pthread_mutex_lock(&ct_native_libraries_mutex);
    for (CtNativeLibrary *entry = ct_native_libraries; entry != NULL; entry = entry->next) {
        if (strcmp(entry->path, path) == 0) {
            handle = entry->handle;
            break;
        }
    }
    pthread_mutex_unlock(&ct_native_libraries_mutex);

    if (handle != NULL) return handle;

    handle = dlopen(path, RTLD_LAZY | RTLD_LOCAL);
    if (handle == NULL) {
        const char *message = dlerror();
        *error_out = message != NULL ? ct_duplicate_string(message) : ct_duplicate_string("dlopen failed");
        return NULL;
    }

    CtNativeLibrary *entry = (CtNativeLibrary *)calloc(1, sizeof(CtNativeLibrary));
    if (entry == NULL) {
        *error_out = ct_duplicate_string("out of memory");
        return handle;
    }
    entry->path = ct_duplicate_string(path);
    entry->handle = handle;

    pthread_mutex_lock(&ct_native_libraries_mutex);
    entry->next = ct_native_libraries;
    ct_native_libraries = entry;
    pthread_mutex_unlock(&ct_native_libraries_mutex);

    return handle;
}

static ffi_type *ct_ffi_libffi_type(CtFfiType type) {
    switch (type) {
        case CT_FFI_TYPE_VOID:
            return &ffi_type_void;
        case CT_FFI_TYPE_BOOL:
        case CT_FFI_TYPE_U8:
            return &ffi_type_uint8;
        case CT_FFI_TYPE_I8:
            return &ffi_type_sint8;
        case CT_FFI_TYPE_U16:
            return &ffi_type_uint16;
        case CT_FFI_TYPE_I16:
            return &ffi_type_sint16;
        case CT_FFI_TYPE_U32:
            return &ffi_type_uint32;
        case CT_FFI_TYPE_I32:
            return &ffi_type_sint32;
        case CT_FFI_TYPE_U64:
            return &ffi_type_uint64;
        case CT_FFI_TYPE_I64:
            return &ffi_type_sint64;
        case CT_FFI_TYPE_F32:
            return &ffi_type_float;
        case CT_FFI_TYPE_F64:
            return &ffi_type_double;
        case CT_FFI_TYPE_PTR:
        case CT_FFI_TYPE_CSTRING:
        case CT_FFI_TYPE_FUNCTION:
            return &ffi_type_pointer;
    }

    return &ffi_type_pointer;
}

static bool ct_ffi_type_from_name(const char *name, CtFfiType *out) {
    if (strcmp(name, "void") == 0) *out = CT_FFI_TYPE_VOID;
    else if (strcmp(name, "bool") == 0) *out = CT_FFI_TYPE_BOOL;
    else if (strcmp(name, "u8") == 0) *out = CT_FFI_TYPE_U8;
    else if (strcmp(name, "i8") == 0) *out = CT_FFI_TYPE_I8;
    else if (strcmp(name, "u16") == 0) *out = CT_FFI_TYPE_U16;
    else if (strcmp(name, "i16") == 0) *out = CT_FFI_TYPE_I16;
    else if (strcmp(name, "int") == 0) *out = CT_FFI_TYPE_I32;
    else if (strcmp(name, "u32") == 0) *out = CT_FFI_TYPE_U32;
    else if (strcmp(name, "i32") == 0) *out = CT_FFI_TYPE_I32;
    else if (strcmp(name, "u64") == 0) *out = CT_FFI_TYPE_U64;
    else if (strcmp(name, "i64") == 0) *out = CT_FFI_TYPE_I64;
    else if (strcmp(name, "f32") == 0) *out = CT_FFI_TYPE_F32;
    else if (strcmp(name, "f64") == 0) *out = CT_FFI_TYPE_F64;
    else if (strcmp(name, "ptr") == 0 || strcmp(name, "pointer") == 0) *out = CT_FFI_TYPE_PTR;
    else if (strcmp(name, "cstring") == 0) *out = CT_FFI_TYPE_CSTRING;
    else if (strcmp(name, "function") == 0 || strcmp(name, "callback") == 0) *out = CT_FFI_TYPE_FUNCTION;
    else return false;
    return true;
}

static int ct_parse_ffi_type(JSContextRef ctx, JSValueRef value, CtFfiType *out, JSValueRef *exception) {
    char *name = ct_value_to_string_copy(ctx, value);
    bool ok = false;
    if (name == NULL) {
        ct_throw_message(ctx, exception, "unsupported FFI type");
        return -1;
    }

    ok = ct_ffi_type_from_name(name, out);
    free(name);
    if (!ok) {
        ct_throw_message(ctx, exception, "unsupported FFI type");
        return -1;
    }
    return 0;
}

static int ct_parse_ffi_type_array(
    JSContextRef ctx,
    JSValueRef value,
    CtFfiType *out_types,
    ffi_type **out_ffi_types,
    size_t *out_count,
    JSValueRef *exception
) {
    *out_count = 0;
    if (value == NULL || !JSValueIsObject(ctx, value)) {
        ct_throw_message(ctx, exception, "FFI args must be an array of type names");
        return -1;
    }

    JSObjectRef object = (JSObjectRef)value;
    JSValueRef length_value = ct_get_property(ctx, object, "length", exception);
    if (exception != NULL && *exception != NULL) return -1;
    size_t length = (size_t)ct_value_to_number(ctx, length_value);
    if (length > CT_FFI_MAX_ARGS) {
        ct_throw_message(ctx, exception, "Cottontail FFI currently supports up to 64 arguments");
        return -1;
    }

    for (size_t index = 0; index < length; index += 1) {
        JSValueRef item = JSObjectGetPropertyAtIndex(ctx, object, (unsigned)index, exception);
        if (exception != NULL && *exception != NULL) return -1;
        if (ct_parse_ffi_type(ctx, item, &out_types[index], exception) != 0) return -1;
        out_ffi_types[index] = ct_ffi_libffi_type(out_types[index]);
    }

    *out_count = length;
    return 0;
}

static int ct_value_to_u64(JSContextRef ctx, JSValueRef value, uint64_t *out) {
    *out = 0;
    if (value == NULL || JSValueIsUndefined(ctx, value) || JSValueIsNull(ctx, value)) return 0;

    uint8_t *bytes = NULL;
    size_t bytes_len = 0;
    if (ct_get_bytes(ctx, value, &bytes, &bytes_len) == 0) {
        *out = (uint64_t)(uintptr_t)bytes;
        return 0;
    }

    JSValueRef exception = NULL;
    double number = JSValueToNumber(ctx, value, &exception);
    if (exception == NULL) {
        *out = (uint64_t)number;
        return 0;
    }

    JSStringRef string = JSValueToStringCopy(ctx, value, NULL);
    if (string == NULL) return -1;
    size_t max = JSStringGetMaximumUTF8CStringSize(string);
    char *buffer = (char *)malloc(max);
    if (buffer == NULL) {
        JSStringRelease(string);
        return -1;
    }
    JSStringGetUTF8CString(string, buffer, max);
    JSStringRelease(string);
    char *end = NULL;
    *out = strtoull(buffer, &end, 10);
    bool ok = end != buffer;
    free(buffer);
    return ok ? 0 : -1;
}

static int ct_ffi_value_from_js(JSContextRef ctx, JSValueRef value, CtFfiType type, CtFfiValue *out, JSValueRef *exception) {
    uint64_t native_value = 0;
    double number_value = 0;

    memset(out, 0, sizeof(*out));

    switch (type) {
        case CT_FFI_TYPE_VOID:
            return 0;
        case CT_FFI_TYPE_BOOL:
            out->u8 = JSValueToBoolean(ctx, value) ? 1 : 0;
            return 0;
        case CT_FFI_TYPE_F32:
            number_value = ct_value_to_number(ctx, value);
            out->f32 = (float)number_value;
            return 0;
        case CT_FFI_TYPE_F64:
            number_value = ct_value_to_number(ctx, value);
            out->f64 = number_value;
            return 0;
        case CT_FFI_TYPE_U8:
        case CT_FFI_TYPE_I8:
        case CT_FFI_TYPE_U16:
        case CT_FFI_TYPE_I16:
        case CT_FFI_TYPE_U32:
        case CT_FFI_TYPE_I32:
        case CT_FFI_TYPE_U64:
        case CT_FFI_TYPE_I64:
        case CT_FFI_TYPE_PTR:
        case CT_FFI_TYPE_CSTRING:
        case CT_FFI_TYPE_FUNCTION:
            if (ct_value_to_u64(ctx, value, &native_value) != 0) {
                ct_throw_message(ctx, exception, "FFI argument must be a number, bigint, ArrayBuffer, typed array, null, or undefined");
                return -1;
            }
            out->u64 = native_value;
            return 0;
    }

    return -1;
}

static void *ct_ffi_value_ptr(CtFfiValue *value, CtFfiType type) {
    switch (type) {
        case CT_FFI_TYPE_BOOL:
        case CT_FFI_TYPE_U8:
            return &value->u8;
        case CT_FFI_TYPE_I8:
            return &value->i8;
        case CT_FFI_TYPE_U16:
            return &value->u16;
        case CT_FFI_TYPE_I16:
            return &value->i16;
        case CT_FFI_TYPE_U32:
            return &value->u32;
        case CT_FFI_TYPE_I32:
            return &value->i32;
        case CT_FFI_TYPE_U64:
            return &value->u64;
        case CT_FFI_TYPE_I64:
            return &value->i64;
        case CT_FFI_TYPE_F32:
            return &value->f32;
        case CT_FFI_TYPE_F64:
            return &value->f64;
        case CT_FFI_TYPE_PTR:
        case CT_FFI_TYPE_CSTRING:
        case CT_FFI_TYPE_FUNCTION:
            value->ptr = (void *)(uintptr_t)value->u64;
            return &value->ptr;
        case CT_FFI_TYPE_VOID:
            return NULL;
    }

    return NULL;
}

static JSValueRef ct_ffi_value_to_js(JSContextRef ctx, CtFfiType type, CtFfiValue value) {
    switch (type) {
        case CT_FFI_TYPE_VOID:
            return JSValueMakeUndefined(ctx);
        case CT_FFI_TYPE_BOOL:
            return JSValueMakeBoolean(ctx, value.u8 != 0);
        case CT_FFI_TYPE_U8:
            return JSValueMakeNumber(ctx, value.u8);
        case CT_FFI_TYPE_I8:
            return JSValueMakeNumber(ctx, value.i8);
        case CT_FFI_TYPE_U16:
            return JSValueMakeNumber(ctx, value.u16);
        case CT_FFI_TYPE_I16:
            return JSValueMakeNumber(ctx, value.i16);
        case CT_FFI_TYPE_U32:
            return JSValueMakeNumber(ctx, value.u32);
        case CT_FFI_TYPE_I32:
            return JSValueMakeNumber(ctx, value.i32);
        case CT_FFI_TYPE_U64:
            return JSValueMakeNumber(ctx, (double)value.u64);
        case CT_FFI_TYPE_I64:
            return JSValueMakeNumber(ctx, (double)value.i64);
        case CT_FFI_TYPE_F32:
            return JSValueMakeNumber(ctx, value.f32);
        case CT_FFI_TYPE_F64:
            return JSValueMakeNumber(ctx, value.f64);
        case CT_FFI_TYPE_PTR:
        case CT_FFI_TYPE_CSTRING:
        case CT_FFI_TYPE_FUNCTION:
            return JSValueMakeNumber(ctx, (double)(uintptr_t)value.ptr);
    }

    return JSValueMakeUndefined(ctx);
}

static int ct_ffi_result_from_js(JSContextRef ctx, JSValueRef value, CtFfiType type, CtFfiValue *out, JSValueRef *exception) {
    return ct_ffi_value_from_js(ctx, value, type, out, exception);
}

static int ct_call_js_callback(CtFfiCallback *callback, CtFfiValue *args, size_t argc, CtFfiValue *result) {
    JSContextRef ctx = callback->ctx;
    JSValueRef js_args[CT_FFI_MAX_ARGS];
    JSValueRef exception = NULL;

    for (size_t index = 0; index < argc; index += 1) {
        js_args[index] = ct_ffi_value_to_js(ctx, callback->arg_types[index], args[index]);
    }

    JSValueRef js_result = JSObjectCallAsFunction(ctx, callback->function, NULL, argc, js_args, &exception);
    if (exception != NULL) {
        char *message = ct_copy_exception(ctx, exception);
        fprintf(stderr, "Cottontail FFI callback failed: %s\n", message != NULL ? message : "unknown error");
        free(message);
        return -1;
    }

    if (callback->returns != CT_FFI_TYPE_VOID) {
        return ct_ffi_result_from_js(ctx, js_result, callback->returns, result, &exception);
    }

    return 0;
}

static void ct_write_ffi_return(void *ret, CtFfiType type, CtFfiValue value) {
    if (ret == NULL) return;

    switch (type) {
        case CT_FFI_TYPE_VOID:
            return;
        case CT_FFI_TYPE_BOOL:
        case CT_FFI_TYPE_U8:
            *((uint8_t *)ret) = value.u8;
            return;
        case CT_FFI_TYPE_I8:
            *((int8_t *)ret) = value.i8;
            return;
        case CT_FFI_TYPE_U16:
            *((uint16_t *)ret) = value.u16;
            return;
        case CT_FFI_TYPE_I16:
            *((int16_t *)ret) = value.i16;
            return;
        case CT_FFI_TYPE_U32:
            *((uint32_t *)ret) = value.u32;
            return;
        case CT_FFI_TYPE_I32:
            *((int32_t *)ret) = value.i32;
            return;
        case CT_FFI_TYPE_U64:
            *((uint64_t *)ret) = value.u64;
            return;
        case CT_FFI_TYPE_I64:
            *((int64_t *)ret) = value.i64;
            return;
        case CT_FFI_TYPE_F32:
            *((float *)ret) = value.f32;
            return;
        case CT_FFI_TYPE_F64:
            *((double *)ret) = value.f64;
            return;
        case CT_FFI_TYPE_PTR:
        case CT_FFI_TYPE_CSTRING:
        case CT_FFI_TYPE_FUNCTION:
            *((void **)ret) = (void *)(uintptr_t)value.u64;
            return;
    }
}

static void ct_enqueue_callback_job(CtJscRuntime *runtime, CtFfiCallbackJob *job) {
    pthread_mutex_lock(&runtime->callback_mutex);
    if (runtime->callback_jobs_tail != NULL) {
        runtime->callback_jobs_tail->next = job;
    } else {
        runtime->callback_jobs_head = job;
    }
    runtime->callback_jobs_tail = job;
    pthread_mutex_unlock(&runtime->callback_mutex);
}

static bool ct_runtime_has_live_callbacks(CtJscRuntime *runtime) {
    bool has_live_callback = false;
    pthread_mutex_lock(&runtime->callback_mutex);
    for (CtFfiCallback *callback = runtime->callbacks; callback != NULL; callback = callback->next) {
        if (!callback->closed) {
            has_live_callback = true;
            break;
        }
    }
    pthread_mutex_unlock(&runtime->callback_mutex);
    return has_live_callback;
}

static void ct_ffi_callback_dispatch(ffi_cif *cif, void *ret, void **args, void *userdata) {
    CtFfiCallback *callback = (CtFfiCallback *)userdata;
    CtFfiValue values[CT_FFI_MAX_ARGS];
    CtFfiValue result;
    bool same_thread = false;
    bool wait_for_result = false;
    (void)cif;

    memset(&result, 0, sizeof(result));
    memset(values, 0, sizeof(values));

    if (callback == NULL || callback->closed) {
        ct_write_ffi_return(ret, callback != NULL ? callback->returns : CT_FFI_TYPE_VOID, result);
        return;
    }

    for (size_t index = 0; index < callback->argc; index += 1) {
        switch (callback->arg_types[index]) {
            case CT_FFI_TYPE_BOOL:
            case CT_FFI_TYPE_U8:
                values[index].u8 = *((uint8_t *)args[index]);
                break;
            case CT_FFI_TYPE_I8:
                values[index].i8 = *((int8_t *)args[index]);
                break;
            case CT_FFI_TYPE_U16:
                values[index].u16 = *((uint16_t *)args[index]);
                break;
            case CT_FFI_TYPE_I16:
                values[index].i16 = *((int16_t *)args[index]);
                break;
            case CT_FFI_TYPE_U32:
                values[index].u32 = *((uint32_t *)args[index]);
                break;
            case CT_FFI_TYPE_I32:
                values[index].i32 = *((int32_t *)args[index]);
                break;
            case CT_FFI_TYPE_U64:
                values[index].u64 = *((uint64_t *)args[index]);
                break;
            case CT_FFI_TYPE_I64:
                values[index].i64 = *((int64_t *)args[index]);
                break;
            case CT_FFI_TYPE_F32:
                values[index].f32 = *((float *)args[index]);
                break;
            case CT_FFI_TYPE_F64:
                values[index].f64 = *((double *)args[index]);
                break;
            case CT_FFI_TYPE_PTR:
            case CT_FFI_TYPE_CSTRING:
            case CT_FFI_TYPE_FUNCTION:
                values[index].u64 = (uint64_t)(uintptr_t)*((void **)args[index]);
                break;
            case CT_FFI_TYPE_VOID:
                break;
        }
    }

    same_thread = pthread_equal(pthread_self(), callback->owner_thread) != 0;
    wait_for_result = !callback->threadsafe || callback->returns != CT_FFI_TYPE_VOID;

    if (same_thread) {
        if (ct_call_js_callback(callback, values, callback->argc, &result) != 0) {
            memset(&result, 0, sizeof(result));
        }
        ct_write_ffi_return(ret, callback->returns, result);
        return;
    }

    CtFfiCallbackJob *job = (CtFfiCallbackJob *)calloc(1, sizeof(CtFfiCallbackJob));
    if (job == NULL) {
        ct_write_ffi_return(ret, callback->returns, result);
        return;
    }

    job->callback = callback;
    job->argc = callback->argc;
    job->wait_for_result = wait_for_result;
    memcpy(job->args, values, sizeof(CtFfiValue) * callback->argc);

    if (wait_for_result) {
        pthread_mutex_init(&job->mutex, NULL);
        pthread_cond_init(&job->cond, NULL);
        pthread_mutex_lock(&job->mutex);
    }

    ct_enqueue_callback_job(callback->runtime, job);

    if (wait_for_result) {
        while (!job->completed) {
            pthread_cond_wait(&job->cond, &job->mutex);
        }
        result = job->result;
        pthread_mutex_unlock(&job->mutex);
        pthread_cond_destroy(&job->cond);
        pthread_mutex_destroy(&job->mutex);
        free(job);
    }

    ct_write_ffi_return(ret, callback->returns, result);
}

static int ct_drain_ffi_callbacks(CtJscRuntime *runtime, char **error_out) {
    (void)error_out;

    while (true) {
        pthread_mutex_lock(&runtime->callback_mutex);
        CtFfiCallbackJob *job = runtime->callback_jobs_head;
        if (job != NULL) {
            runtime->callback_jobs_head = job->next;
            if (runtime->callback_jobs_head == NULL) {
                runtime->callback_jobs_tail = NULL;
            }
        }
        pthread_mutex_unlock(&runtime->callback_mutex);

        if (job == NULL) break;

        if (ct_call_js_callback(job->callback, job->args, job->argc, &job->result) != 0) {
            memset(&job->result, 0, sizeof(job->result));
        }

        if (job->wait_for_result) {
            pthread_mutex_lock(&job->mutex);
            job->completed = true;
            pthread_cond_signal(&job->cond);
            pthread_mutex_unlock(&job->mutex);
        } else {
            free(job);
        }
    }

    return 0;
}

static JSValueRef ct_memory_address(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    uint64_t address = 0;
    (void)function;
    (void)thisObject;

    if (argc < 1 || ct_value_to_u64(ctx, argv[0], &address) != 0) {
        ct_throw_message(ctx, exception, "cottontail.memoryAddress(value) requires an ArrayBuffer, typed array, number, or bigint");
        return JSValueMakeUndefined(ctx);
    }

    return JSValueMakeNumber(ctx, (double)address);
}

static void ct_external_array_buffer_noop(void *bytes, void *deallocator_context) {
    (void)bytes;
    (void)deallocator_context;
}

static JSValueRef ct_memory_view(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    uint64_t address = 0;
    uint64_t offset = 0;
    uint64_t length = 0;
    (void)function;
    (void)thisObject;

    if (argc < 3 ||
        ct_value_to_u64(ctx, argv[0], &address) != 0 ||
        ct_value_to_u64(ctx, argv[1], &offset) != 0 ||
        ct_value_to_u64(ctx, argv[2], &length) != 0) {
        ct_throw_message(ctx, exception, "cottontail.memoryView(ptr, offset, length) requires pointer, offset, and length");
        return JSValueMakeUndefined(ctx);
    }

    if (address == 0 || length == 0) {
        return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, NULL, 0, ct_external_array_buffer_noop, NULL, exception);
    }

    return JSObjectMakeArrayBufferWithBytesNoCopy(
        ctx,
        (uint8_t *)(uintptr_t)(address + offset),
        (size_t)length,
        ct_external_array_buffer_noop,
        NULL,
        exception
    );
}

static JSValueRef ct_native_call(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    void *handle = NULL;
    void *symbol = NULL;
    char *open_error = NULL;
    CtFfiType return_type = CT_FFI_TYPE_VOID;
    CtFfiType arg_types[CT_FFI_MAX_ARGS];
    ffi_type *ffi_arg_types[CT_FFI_MAX_ARGS];
    CtFfiValue arg_values[CT_FFI_MAX_ARGS];
    void *arg_value_ptrs[CT_FFI_MAX_ARGS];
    CtFfiValue result;
    ffi_cif cif;
    size_t arg_count = 0;
    (void)function;
    (void)thisObject;

    memset(&result, 0, sizeof(result));

    if (argc < 5) {
        ct_throw_message(ctx, exception, "cottontail.nativeCall(library, symbol, returnType, argTypes, args) requires five arguments");
        return JSValueMakeUndefined(ctx);
    }

    char *library_path = ct_value_to_string_copy(ctx, argv[0]);
    char *symbol_name = ct_value_to_string_copy(ctx, argv[1]);
    if (library_path == NULL || symbol_name == NULL) {
        free(library_path);
        free(symbol_name);
        ct_throw_message(ctx, exception, "cottontail.nativeCall requires string library and symbol names");
        return JSValueMakeUndefined(ctx);
    }

    if (ct_parse_ffi_type(ctx, argv[2], &return_type, exception) != 0 ||
        ct_parse_ffi_type_array(ctx, argv[3], arg_types, ffi_arg_types, &arg_count, exception) != 0) {
        free(library_path);
        free(symbol_name);
        return JSValueMakeUndefined(ctx);
    }

    if (!JSValueIsObject(ctx, argv[4])) {
        free(library_path);
        free(symbol_name);
        ct_throw_message(ctx, exception, "cottontail.nativeCall args must be an array");
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef args_array = (JSObjectRef)argv[4];
    for (size_t index = 0; index < arg_count; index += 1) {
        JSValueRef item = JSObjectGetPropertyAtIndex(ctx, args_array, (unsigned)index, exception);
        if (exception != NULL && *exception != NULL) {
            free(library_path);
            free(symbol_name);
            return JSValueMakeUndefined(ctx);
        }
        if (ct_ffi_value_from_js(ctx, item, arg_types[index], &arg_values[index], exception) != 0) {
            free(library_path);
            free(symbol_name);
            return JSValueMakeUndefined(ctx);
        }
        arg_value_ptrs[index] = ct_ffi_value_ptr(&arg_values[index], arg_types[index]);
    }

    handle = ct_get_native_library_handle(library_path, &open_error);
    if (handle == NULL) {
        char message[1024];
        snprintf(message, sizeof(message), "dlopen(%s) failed: %s", library_path, open_error != NULL ? open_error : "unknown error");
        free(open_error);
        free(library_path);
        free(symbol_name);
        ct_throw_message(ctx, exception, message);
        return JSValueMakeUndefined(ctx);
    }

    symbol = dlsym(handle, symbol_name);
    if (symbol == NULL) {
        char message[1024];
        snprintf(message, sizeof(message), "dlsym(%s) failed: %s", symbol_name, dlerror());
        free(library_path);
        free(symbol_name);
        ct_throw_message(ctx, exception, message);
        return JSValueMakeUndefined(ctx);
    }

    if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, (unsigned int)arg_count, ct_ffi_libffi_type(return_type), ffi_arg_types) != FFI_OK) {
        char message[1024];
        snprintf(message, sizeof(message), "ffi_prep_cif failed for %s", symbol_name);
        free(library_path);
        free(symbol_name);
        ct_throw_message(ctx, exception, message);
        return JSValueMakeUndefined(ctx);
    }

    ffi_call(&cif, FFI_FN(symbol), ct_ffi_value_ptr(&result, return_type), arg_value_ptrs);
    JSValueRef js_result = ct_ffi_value_to_js(ctx, return_type, result);

    free(library_path);
    free(symbol_name);
    return js_result;
}

static JSValueRef ct_create_callback(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    CtJscRuntime *runtime = ct_callback_runtime(function);
    CtFfiCallback *callback = NULL;
    (void)thisObject;

    if (argc < 4 || !JSValueIsObject(ctx, argv[0]) || !JSObjectIsFunction(ctx, (JSObjectRef)argv[0])) {
        ct_throw_message(ctx, exception, "cottontail.createCallback(fn, argTypes, returnType, threadsafe) requires a function");
        return JSValueMakeUndefined(ctx);
    }

    callback = (CtFfiCallback *)calloc(1, sizeof(CtFfiCallback));
    if (callback == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    callback->runtime = runtime;
    callback->ctx = ctx;
    callback->function = (JSObjectRef)argv[0];
    callback->threadsafe = JSValueToBoolean(ctx, argv[3]);
    callback->owner_thread = pthread_self();
    JSValueProtect(ctx, callback->function);

    if (ct_parse_ffi_type_array(ctx, argv[1], callback->arg_types, callback->ffi_arg_types, &callback->argc, exception) != 0 ||
        ct_parse_ffi_type(ctx, argv[2], &callback->returns, exception) != 0) {
        JSValueUnprotect(ctx, callback->function);
        free(callback);
        return JSValueMakeUndefined(ctx);
    }

    callback->closure = ffi_closure_alloc(sizeof(ffi_closure), &callback->code);
    if (callback->closure == NULL) {
        JSValueUnprotect(ctx, callback->function);
        free(callback);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    if (ffi_prep_cif(
            &callback->cif,
            FFI_DEFAULT_ABI,
            (unsigned int)callback->argc,
            ct_ffi_libffi_type(callback->returns),
            callback->ffi_arg_types
        ) != FFI_OK ||
        ffi_prep_closure_loc(
            callback->closure,
            &callback->cif,
            ct_ffi_callback_dispatch,
            callback,
            callback->code
        ) != FFI_OK) {
        ffi_closure_free(callback->closure);
        JSValueUnprotect(ctx, callback->function);
        free(callback);
        ct_throw_message(ctx, exception, "failed to create FFI callback");
        return JSValueMakeUndefined(ctx);
    }

    pthread_mutex_lock(&runtime->callback_mutex);
    callback->next = runtime->callbacks;
    runtime->callbacks = callback;
    pthread_mutex_unlock(&runtime->callback_mutex);

    return JSValueMakeNumber(ctx, (double)(uintptr_t)callback->code);
}

static JSValueRef ct_close_callback(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    CtJscRuntime *runtime = ct_callback_runtime(function);
    uint64_t code = 0;
    (void)thisObject;

    if (runtime == NULL || argc < 1 || ct_value_to_u64(ctx, argv[0], &code) != 0 || code == 0) {
        ct_throw_message(ctx, exception, "cottontail.closeCallback(ptr) requires a callback pointer");
        return JSValueMakeBoolean(ctx, false);
    }

    bool closed = false;
    JSObjectRef callback_function = NULL;
    pthread_mutex_lock(&runtime->callback_mutex);
    for (CtFfiCallback *callback = runtime->callbacks; callback != NULL; callback = callback->next) {
        if ((uint64_t)(uintptr_t)callback->code == code) {
            if (!callback->closed) {
                callback->closed = true;
                callback_function = callback->function;
                callback->function = NULL;
                closed = true;
            }
            break;
        }
    }
    pthread_mutex_unlock(&runtime->callback_mutex);

    if (callback_function != NULL) JSValueUnprotect(ctx, callback_function);
    return JSValueMakeBoolean(ctx, closed);
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

static double ct_stat_time_ms(time_t seconds, long nanoseconds) {
    return ((double)seconds * 1000.0) + ((double)nanoseconds / 1000000.0);
}

static double ct_stat_atime_ms(const struct stat *stat_value) {
#if defined(__APPLE__) || defined(__MACH__)
    return ct_stat_time_ms(stat_value->st_atimespec.tv_sec, stat_value->st_atimespec.tv_nsec);
#elif defined(__linux__)
    return ct_stat_time_ms(stat_value->st_atim.tv_sec, stat_value->st_atim.tv_nsec);
#else
    return ct_stat_time_ms(stat_value->st_atime, 0);
#endif
}

static double ct_stat_mtime_ms(const struct stat *stat_value) {
#if defined(__APPLE__) || defined(__MACH__)
    return ct_stat_time_ms(stat_value->st_mtimespec.tv_sec, stat_value->st_mtimespec.tv_nsec);
#elif defined(__linux__)
    return ct_stat_time_ms(stat_value->st_mtim.tv_sec, stat_value->st_mtim.tv_nsec);
#else
    return ct_stat_time_ms(stat_value->st_mtime, 0);
#endif
}

static double ct_stat_ctime_ms(const struct stat *stat_value) {
#if defined(__APPLE__) || defined(__MACH__)
    return ct_stat_time_ms(stat_value->st_ctimespec.tv_sec, stat_value->st_ctimespec.tv_nsec);
#elif defined(__linux__)
    return ct_stat_time_ms(stat_value->st_ctim.tv_sec, stat_value->st_ctim.tv_nsec);
#else
    return ct_stat_time_ms(stat_value->st_ctime, 0);
#endif
}

static double ct_stat_birthtime_ms(const struct stat *stat_value) {
#if defined(__APPLE__) || defined(__MACH__)
    return ct_stat_time_ms(stat_value->st_birthtimespec.tv_sec, stat_value->st_birthtimespec.tv_nsec);
#else
    return ct_stat_ctime_ms(stat_value);
#endif
}

static void ct_define_stat_fields(JSContextRef ctx, JSObjectRef object, const struct stat *stat_value, JSValueRef *exception) {
    ct_set_property(ctx, object, "size", JSValueMakeNumber(ctx, (double)stat_value->st_size), exception);
    ct_set_property(ctx, object, "mode", JSValueMakeNumber(ctx, (double)stat_value->st_mode), exception);
    ct_set_property(ctx, object, "atimeMs", JSValueMakeNumber(ctx, ct_stat_atime_ms(stat_value)), exception);
    ct_set_property(ctx, object, "mtimeMs", JSValueMakeNumber(ctx, ct_stat_mtime_ms(stat_value)), exception);
    ct_set_property(ctx, object, "ctimeMs", JSValueMakeNumber(ctx, ct_stat_ctime_ms(stat_value)), exception);
    ct_set_property(ctx, object, "birthtimeMs", JSValueMakeNumber(ctx, ct_stat_birthtime_ms(stat_value)), exception);
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

static int ct_parse_spawn_options(JSContextRef ctx, JSValueRef value, char **cwd, CtHostEnvEntry **env_entries, size_t *env_count, bool *clear_env, bool *capture_output, JSValueRef *exception) {
    *cwd = NULL;
    *env_entries = NULL;
    *env_count = 0;
    *clear_env = false;
    *capture_output = true;
    if (value == NULL || JSValueIsUndefined(ctx, value) || JSValueIsNull(ctx, value) || !JSValueIsObject(ctx, value)) return 0;
    JSObjectRef object = (JSObjectRef)value;
    JSValueRef cwd_value = ct_get_property(ctx, object, "cwd", exception);
    JSValueRef env_value = ct_get_property(ctx, object, "env", exception);
    JSValueRef clear_env_value = ct_get_property(ctx, object, "clearEnv", exception);
    JSValueRef stdio_value = ct_get_property(ctx, object, "stdio", exception);
    if (exception != NULL && *exception != NULL) return -1;
    *cwd = ct_value_to_optional_string(ctx, cwd_value);
    *clear_env = JSValueToBoolean(ctx, clear_env_value);
    if (ct_parse_env_object(ctx, env_value, env_entries, env_count, exception) != 0) return -1;
    if (!JSValueIsUndefined(ctx, stdio_value) && !JSValueIsNull(ctx, stdio_value)) {
        char *stdio = ct_value_to_string_copy(ctx, stdio_value);
        if (stdio != NULL && strcmp(stdio, "inherit") == 0) *capture_output = false;
        free(stdio);
    }
    return 0;
}

static void ct_process_close_fd(int *fd) {
    if (*fd >= 0) {
        close(*fd);
        *fd = -1;
    }
}

static int ct_process_parse_stdio_value(JSContextRef ctx, JSValueRef value, CtProcessStdioMode *out, JSValueRef *exception) {
    if (JSValueIsUndefined(ctx, value)) return 0;
    if (JSValueIsNull(ctx, value)) {
        *out = CT_PROCESS_STDIO_IGNORE;
        return 0;
    }
    if (JSValueIsNumber(ctx, value)) {
        *out = CT_PROCESS_STDIO_INHERIT;
        return 0;
    }

    char *mode = ct_value_to_string_copy(ctx, value);
    if (mode == NULL) {
        ct_throw_message(ctx, exception, "spawn stdio must be 'pipe', 'inherit', or 'ignore'");
        return -1;
    }

    if (strcmp(mode, "pipe") == 0) {
        *out = CT_PROCESS_STDIO_PIPE;
    } else if (strcmp(mode, "inherit") == 0) {
        *out = CT_PROCESS_STDIO_INHERIT;
    } else if (strcmp(mode, "ignore") == 0) {
        *out = CT_PROCESS_STDIO_IGNORE;
    } else {
        free(mode);
        ct_throw_message(ctx, exception, "spawn stdio must be 'pipe', 'inherit', or 'ignore'");
        return -1;
    }

    free(mode);
    return 0;
}

static int ct_process_parse_stdio_mode(
    JSContextRef ctx,
    JSObjectRef options,
    const char *name,
    CtProcessStdioMode *mode,
    JSValueRef *exception
) {
    JSValueRef value = ct_get_property(ctx, options, name, exception);
    if (exception != NULL && *exception != NULL) return -1;
    return ct_process_parse_stdio_value(ctx, value, mode, exception);
}

static int ct_open_dev_null(int flags) {
    return open("/dev/null", flags);
}

static void ct_child_apply_input_stdio(CtProcessStdioMode mode, int pipe_read_fd) {
    if (mode == CT_PROCESS_STDIO_INHERIT) return;

    if (mode == CT_PROCESS_STDIO_PIPE && pipe_read_fd >= 0) {
        dup2(pipe_read_fd, STDIN_FILENO);
        return;
    }

    int devnull = ct_open_dev_null(O_RDONLY);
    if (devnull >= 0) {
        dup2(devnull, STDIN_FILENO);
        if (devnull > STDERR_FILENO) close(devnull);
    }
}

static void ct_child_apply_output_stdio(CtProcessStdioMode mode, int pipe_write_fd, int fd) {
    if (mode == CT_PROCESS_STDIO_INHERIT) return;

    if (mode == CT_PROCESS_STDIO_PIPE && pipe_write_fd >= 0) {
        dup2(pipe_write_fd, fd);
        return;
    }

    int devnull = ct_open_dev_null(O_WRONLY);
    if (devnull >= 0) {
        dup2(devnull, fd);
        if (devnull > STDERR_FILENO) close(devnull);
    }
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
    bool clear_env = false;
    bool capture_output = true;
    if (ct_parse_string_array(ctx, argc >= 2 ? argv[1] : NULL, &args, &arg_count, exception) != 0 ||
        ct_parse_spawn_options(ctx, argc >= 3 ? argv[2] : NULL, &cwd, &env_entries, &env_count, &clear_env, &capture_output, exception) != 0) {
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
            .clear_env = clear_env,
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

static void ct_queue_spawn_event(CtJscRuntime *runtime, CtSpawnEvent *event) {
    pthread_mutex_lock(&runtime->spawn_event_mutex);
    if (runtime->spawn_events_tail != NULL) {
        runtime->spawn_events_tail->next = event;
    } else {
        runtime->spawn_events_head = event;
    }
    runtime->spawn_events_tail = event;
    pthread_mutex_unlock(&runtime->spawn_event_mutex);
}

static void ct_queue_spawn_text(CtJscRuntime *runtime, uint32_t id, const char *type, const char *data, size_t data_len) {
    if (data == NULL || data_len == 0) return;
    CtSpawnEvent *event = (CtSpawnEvent *)calloc(1, sizeof(CtSpawnEvent));
    if (event == NULL) return;
    event->process_id = id;
    event->type = ct_duplicate_bytes(type, strlen(type));
    event->data = ct_duplicate_bytes(data, data_len);
    event->data_len = data_len;
    ct_queue_spawn_event(runtime, event);
}

static void ct_queue_fd_event(CtJscRuntime *runtime, CtFdEvent *event) {
    pthread_mutex_lock(&runtime->fd_event_mutex);
    if (runtime->fd_events_tail != NULL) {
        runtime->fd_events_tail->next = event;
    } else {
        runtime->fd_events_head = event;
    }
    runtime->fd_events_tail = event;
    pthread_mutex_unlock(&runtime->fd_event_mutex);
}

static void ct_queue_worker_event(CtJscRuntime *runtime, uint32_t worker_id) {
    if (runtime == NULL) return;
    CtWorkerEvent *event = (CtWorkerEvent *)calloc(1, sizeof(CtWorkerEvent));
    if (event == NULL) return;
    event->worker_id = worker_id;
    pthread_mutex_lock(&runtime->worker_event_mutex);
    if (runtime->worker_events_tail != NULL) {
        runtime->worker_events_tail->next = event;
    } else {
        runtime->worker_events_head = event;
    }
    runtime->worker_events_tail = event;
    pthread_mutex_unlock(&runtime->worker_event_mutex);
}

static void ct_queue_fd_data(CtJscRuntime *runtime, uint32_t id, const char *data, size_t data_len) {
    if (data == NULL || data_len == 0) return;
    if (ct_debug_flag("COTTONTAIL_FD_DEBUG")) {
        fprintf(stderr, "[cottontail:fd] data id=%u bytes=%zu\n", id, data_len);
        fflush(stderr);
    }
    CtFdEvent *event = (CtFdEvent *)calloc(1, sizeof(CtFdEvent));
    if (event == NULL) return;
    event->watch_id = id;
    event->type = ct_duplicate_bytes("data", 4);
    event->data = ct_duplicate_bytes(data, data_len);
    event->data_len = data_len;
    if (event->type == NULL || event->data == NULL) {
        free(event->type);
        free(event->data);
        free(event);
        return;
    }
    ct_queue_fd_event(runtime, event);
}

static void ct_queue_fd_simple(CtJscRuntime *runtime, uint32_t id, const char *type, const char *message) {
    if (ct_debug_flag("COTTONTAIL_FD_DEBUG")) {
        fprintf(stderr, "[cottontail:fd] %s id=%u%s%s\n", type, id, message != NULL ? " message=" : "", message != NULL ? message : "");
        fflush(stderr);
    }
    CtFdEvent *event = (CtFdEvent *)calloc(1, sizeof(CtFdEvent));
    if (event == NULL) return;
    event->watch_id = id;
    event->type = ct_duplicate_bytes(type, strlen(type));
    if (message != NULL) event->message = ct_duplicate_bytes(message, strlen(message));
    if (event->type == NULL || (message != NULL && event->message == NULL)) {
        free(event->type);
        free(event->message);
        free(event);
        return;
    }
    ct_queue_fd_event(runtime, event);
}

static bool ct_fd_watcher_is_active(CtFdWatcher *watcher) {
    bool active = false;
    pthread_mutex_lock(&watcher->mutex);
    active = watcher->active;
    pthread_mutex_unlock(&watcher->mutex);
    return active;
}

static void ct_fd_watcher_set_active(CtFdWatcher *watcher, bool active) {
    pthread_mutex_lock(&watcher->mutex);
    watcher->active = active;
    pthread_mutex_unlock(&watcher->mutex);
}

static void ct_fd_watchers_remove(CtFdWatcher *watcher) {
    pthread_mutex_lock(&ct_fd_watchers_mutex);
    CtFdWatcher **cursor = &ct_fd_watchers;
    while (*cursor != NULL) {
        if (*cursor == watcher) {
            *cursor = watcher->next;
            break;
        }
        cursor = &(*cursor)->next;
    }
    pthread_mutex_unlock(&ct_fd_watchers_mutex);
}

static bool ct_fd_watcher_stop_id(uint32_t id) {
    bool found = false;
    pthread_mutex_lock(&ct_fd_watchers_mutex);
    for (CtFdWatcher *watcher = ct_fd_watchers; watcher != NULL; watcher = watcher->next) {
        if (watcher->id == id) {
            ct_fd_watcher_set_active(watcher, false);
            found = true;
            break;
        }
    }
    pthread_mutex_unlock(&ct_fd_watchers_mutex);
    return found;
}

static bool ct_fd_watchers_has_runtime(CtJscRuntime *runtime) {
    bool found = false;
    pthread_mutex_lock(&ct_fd_watchers_mutex);
    for (CtFdWatcher *watcher = ct_fd_watchers; watcher != NULL; watcher = watcher->next) {
        if (watcher->runtime == runtime && ct_fd_watcher_is_active(watcher)) {
            found = true;
            break;
        }
    }
    pthread_mutex_unlock(&ct_fd_watchers_mutex);
    return found;
}

static void ct_fd_watchers_stop_runtime(CtJscRuntime *runtime) {
    pthread_mutex_lock(&ct_fd_watchers_mutex);
    for (CtFdWatcher *watcher = ct_fd_watchers; watcher != NULL; watcher = watcher->next) {
        if (watcher->runtime == runtime) {
            ct_fd_watcher_set_active(watcher, false);
        }
    }
    pthread_mutex_unlock(&ct_fd_watchers_mutex);
}

static void ct_fd_watchers_wait_for_runtime(CtJscRuntime *runtime) {
    ct_fd_watchers_stop_runtime(runtime);
    for (int attempt = 0; attempt < 500 && ct_fd_watchers_has_runtime(runtime); attempt += 1) {
        usleep(1000);
    }
}

static void *ct_fd_watcher_thread(void *opaque) {
    CtFdWatcher *watcher = (CtFdWatcher *)opaque;
    if (ct_debug_flag("COTTONTAIL_FD_DEBUG")) {
        fprintf(stderr, "[cottontail:fd] thread start id=%u fd=%d max=%zu\n", watcher->id, watcher->fd, watcher->max_bytes);
        fflush(stderr);
    }
    int flags = fcntl(watcher->fd, F_GETFL, 0);
    if (flags >= 0) {
        (void)fcntl(watcher->fd, F_SETFL, flags | O_NONBLOCK);
    }

    while (ct_fd_watcher_is_active(watcher)) {
        struct pollfd poll_fd;
        poll_fd.fd = watcher->fd;
        poll_fd.events = POLLIN | POLLHUP | POLLERR;
        poll_fd.revents = 0;

        int ready = poll(&poll_fd, 1, 50);
        if (!ct_fd_watcher_is_active(watcher)) break;
        if (ready == 0) continue;
        if (ready < 0) {
            if (errno == EINTR) continue;
            ct_queue_fd_simple(watcher->runtime, watcher->id, "error", strerror(errno));
            break;
        }
        if ((poll_fd.revents & POLLNVAL) != 0) {
            ct_queue_fd_simple(watcher->runtime, watcher->id, "error", "invalid file descriptor");
            break;
        }
        if ((poll_fd.revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
            continue;
        }

        bool terminal = false;
        for (;;) {
            size_t max_bytes = watcher->max_bytes > 0 ? watcher->max_bytes : 65536;
            if (max_bytes > 1024 * 1024) max_bytes = 1024 * 1024;
            char *buffer = (char *)malloc(max_bytes);
            if (buffer == NULL) {
                ct_queue_fd_simple(watcher->runtime, watcher->id, "error", "Out of memory");
                terminal = true;
                break;
            }

            ssize_t n = read(watcher->fd, buffer, max_bytes);
            if (n > 0) {
                ct_queue_fd_data(watcher->runtime, watcher->id, buffer, (size_t)n);
                free(buffer);
                continue;
            }
            free(buffer);

            if (n == 0) {
                ct_queue_fd_simple(watcher->runtime, watcher->id, "end", NULL);
                terminal = true;
                break;
            }
            if (errno == EINTR) {
                continue;
            }
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                if ((poll_fd.revents & POLLHUP) != 0) {
                    ct_queue_fd_simple(watcher->runtime, watcher->id, "end", NULL);
                    terminal = true;
                }
                break;
            }

            ct_queue_fd_simple(watcher->runtime, watcher->id, "error", strerror(errno));
            terminal = true;
            break;
        }

        if (terminal) break;
    }

    ct_fd_watchers_remove(watcher);
    ct_fd_watcher_set_active(watcher, false);
    if (ct_debug_flag("COTTONTAIL_FD_DEBUG")) {
        fprintf(stderr, "[cottontail:fd] thread stop id=%u fd=%d\n", watcher->id, watcher->fd);
        fflush(stderr);
    }
    pthread_mutex_destroy(&watcher->mutex);
    free(watcher);
    return NULL;
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

static bool ct_async_processes_has_runtime(CtJscRuntime *runtime) {
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

static void ct_async_processes_stop_runtime(CtJscRuntime *runtime) {
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

static void ct_async_processes_wait_for_runtime(CtJscRuntime *runtime) {
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
    CtJscRuntime *runtime = ct_callback_runtime(function);
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
    bool clear_env = false;
    bool capture_output = true;
    CtProcessStdioMode stdin_mode = CT_PROCESS_STDIO_IGNORE;
    CtProcessStdioMode stdout_mode = CT_PROCESS_STDIO_PIPE;
    CtProcessStdioMode stderr_mode = CT_PROCESS_STDIO_INHERIT;
    if (ct_parse_string_array(ctx, argc >= 2 ? argv[1] : NULL, &args, &arg_count, exception) != 0 ||
        ct_parse_spawn_options(ctx, argc >= 3 ? argv[2] : NULL, &cwd, &env_entries, &env_count, &clear_env, &capture_output, exception) != 0) {
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }

    if (argc >= 3 && !JSValueIsUndefined(ctx, argv[2]) && !JSValueIsNull(ctx, argv[2]) && JSValueIsObject(ctx, argv[2])) {
        JSObjectRef options = (JSObjectRef)argv[2];
        JSValueRef stdio_value = ct_get_property(ctx, options, "stdio", exception);
        if (exception != NULL && *exception != NULL) {
            free(file);
            ct_free_string_array(args, arg_count);
            free(cwd);
            ct_free_env_entries(env_entries, env_count);
            return JSValueMakeUndefined(ctx);
        }

        if (!JSValueIsUndefined(ctx, stdio_value)) {
            CtProcessStdioMode stdio_mode = stdout_mode;
            if (ct_process_parse_stdio_value(ctx, stdio_value, &stdio_mode, exception) != 0) {
                free(file);
                ct_free_string_array(args, arg_count);
                free(cwd);
                ct_free_env_entries(env_entries, env_count);
                return JSValueMakeUndefined(ctx);
            }
            stdin_mode = stdio_mode;
            stdout_mode = stdio_mode;
            stderr_mode = stdio_mode;
        }

        if (ct_process_parse_stdio_mode(ctx, options, "stdin", &stdin_mode, exception) != 0 ||
            ct_process_parse_stdio_mode(ctx, options, "stdout", &stdout_mode, exception) != 0 ||
            ct_process_parse_stdio_mode(ctx, options, "stderr", &stderr_mode, exception) != 0) {
            free(file);
            ct_free_string_array(args, arg_count);
            free(cwd);
            ct_free_env_entries(env_entries, env_count);
            return JSValueMakeUndefined(ctx);
        }
    }

    uint32_t id = ++runtime->next_process_id;

    int stdin_pipe[2] = { -1, -1 };
    int stdout_pipe[2] = { -1, -1 };
    int stderr_pipe[2] = { -1, -1 };
    if (stdin_mode == CT_PROCESS_STDIO_PIPE && pipe(stdin_pipe) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }
    if (stdout_mode == CT_PROCESS_STDIO_PIPE && pipe(stdout_pipe) != 0) {
        ct_process_close_fd(&stdin_pipe[0]);
        ct_process_close_fd(&stdin_pipe[1]);
        ct_throw_message(ctx, exception, strerror(errno));
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }
    if (stderr_mode == CT_PROCESS_STDIO_PIPE && pipe(stderr_pipe) != 0) {
        ct_process_close_fd(&stdin_pipe[0]);
        ct_process_close_fd(&stdin_pipe[1]);
        ct_process_close_fd(&stdout_pipe[0]);
        ct_process_close_fd(&stdout_pipe[1]);
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
        if (clear_env) ct_clear_environment();
        for (size_t index = 0; index < env_count; index += 1) {
            setenv(env_entries[index].name, env_entries[index].value, 1);
        }
        ct_process_close_fd(&stdin_pipe[1]);
        ct_process_close_fd(&stdout_pipe[0]);
        ct_process_close_fd(&stderr_pipe[0]);
        ct_child_apply_input_stdio(stdin_mode, stdin_pipe[0]);
        ct_child_apply_output_stdio(stdout_mode, stdout_pipe[1], STDOUT_FILENO);
        ct_child_apply_output_stdio(stderr_mode, stderr_pipe[1], STDERR_FILENO);
        ct_process_close_fd(&stdin_pipe[0]);
        ct_process_close_fd(&stdout_pipe[1]);
        ct_process_close_fd(&stderr_pipe[1]);
        char **argv_exec = (char **)calloc(arg_count + 2, sizeof(char *));
        if (argv_exec == NULL) _exit(127);
        argv_exec[0] = file;
        for (size_t index = 0; index < arg_count; index += 1) argv_exec[index + 1] = args[index];
        argv_exec[arg_count + 1] = NULL;
        execvp(file, argv_exec);
        _exit(127);
    }

    ct_process_close_fd(&stdin_pipe[0]);
    ct_process_close_fd(&stdout_pipe[1]);
    ct_process_close_fd(&stderr_pipe[1]);
    if (pid < 0) {
        ct_process_close_fd(&stdin_pipe[1]);
        ct_process_close_fd(&stdout_pipe[0]);
        ct_process_close_fd(&stderr_pipe[0]);
        ct_throw_message(ctx, exception, strerror(errno));
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }

    CtAsyncProcess *process = (CtAsyncProcess *)calloc(1, sizeof(CtAsyncProcess));
    if (process == NULL) {
        ct_process_close_fd(&stdin_pipe[1]);
        ct_process_close_fd(&stdout_pipe[0]);
        ct_process_close_fd(&stderr_pipe[0]);
        ct_throw_message(ctx, exception, "Out of memory");
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }
    process->id = id;
    process->pid = pid;
    process->stdin_fd = stdin_mode == CT_PROCESS_STDIO_PIPE ? stdin_pipe[1] : -1;
    process->stdout_fd = stdout_mode == CT_PROCESS_STDIO_PIPE ? stdout_pipe[0] : -1;
    process->stderr_fd = stderr_mode == CT_PROCESS_STDIO_PIPE ? stderr_pipe[0] : -1;
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
    bool clear_env = false;
    bool capture_output = true;
    if (ct_parse_string_array(ctx, argc >= 2 ? argv[1] : NULL, &args, &arg_count, exception) != 0 ||
        ct_parse_spawn_options(ctx, argc >= 3 ? argv[2] : NULL, &cwd, &env_entries, &env_count, &clear_env, &capture_output, exception) != 0) {
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeNumber(ctx, 0);
    }

    pid_t pid = fork();
    if (pid == 0) {
        if (cwd != NULL) chdir(cwd);
        if (clear_env) ct_clear_environment();
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
    CtJscRuntime *runtime = ct_callback_runtime(function);
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

static JSValueRef ct_dispatch_spawn_events(JSContextRef ctx, CtJscRuntime *runtime, JSValueRef *exception) {
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

static JSValueRef ct_dispatch_fd_events(JSContextRef ctx, CtJscRuntime *runtime, JSValueRef *exception) {
    if (runtime->fd_event_handler == NULL) return JSValueMakeUndefined(ctx);
    for (;;) {
        pthread_mutex_lock(&runtime->fd_event_mutex);
        CtFdEvent *event = runtime->fd_events_head;
        if (event != NULL) {
            runtime->fd_events_head = event->next;
            if (runtime->fd_events_head == NULL) runtime->fd_events_tail = NULL;
        }
        pthread_mutex_unlock(&runtime->fd_event_mutex);
        if (event == NULL) break;

        JSObjectRef item = ct_make_object(ctx);
        ct_set_property(ctx, item, "id", JSValueMakeNumber(ctx, event->watch_id), exception);
        ct_set_property(ctx, item, "type", ct_make_string(ctx, event->type != NULL ? event->type : ""), exception);
        if (event->data != NULL) {
            ct_set_property(ctx, item, "data", ct_array_buffer_from_copy(ctx, event->data, event->data_len, exception), exception);
        }
        if (event->message != NULL) {
            ct_set_property(ctx, item, "message", ct_make_string(ctx, event->message), exception);
        }
        JSValueRef arg = item;
        JSObjectCallAsFunction(ctx, runtime->fd_event_handler, NULL, 1, &arg, exception);
        free(event->type);
        free(event->data);
        free(event->message);
        free(event);
        if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_dispatch_worker_events(JSContextRef ctx, CtJscRuntime *runtime, JSValueRef *exception) {
    if (runtime->worker_event_handler == NULL) return JSValueMakeUndefined(ctx);
    for (;;) {
        pthread_mutex_lock(&runtime->worker_event_mutex);
        CtWorkerEvent *event = runtime->worker_events_head;
        if (event != NULL) {
            runtime->worker_events_head = event->next;
            if (runtime->worker_events_head == NULL) runtime->worker_events_tail = NULL;
        }
        pthread_mutex_unlock(&runtime->worker_event_mutex);
        if (event == NULL) break;

        JSObjectRef item = ct_make_object(ctx);
        ct_set_property(ctx, item, "id", JSValueMakeNumber(ctx, event->worker_id), exception);
        JSValueRef arg = item;
        JSObjectCallAsFunction(ctx, runtime->worker_event_handler, NULL, 1, &arg, exception);
        free(event);
        if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_drain_jobs(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    (void)argc;
    (void)argv;
    CtJscRuntime *runtime = ct_callback_runtime(function);
    ct_dispatch_spawn_events(ctx, runtime, exception);
    if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
    ct_dispatch_fd_events(ctx, runtime, exception);
    if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
    return ct_dispatch_worker_events(ctx, runtime, exception);
}

static JSValueRef ct_import_module(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    CtJscRuntime *runtime = ct_callback_runtime(function);
    if (runtime == NULL || argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.importModule(specifier[, referrer]) requires a module specifier");
        return JSValueMakeUndefined(ctx);
    }

    char *specifier = ct_value_to_string_copy(ctx, argv[0]);
    char *referrer = argc >= 2 ? ct_value_to_optional_string(ctx, argv[1]) : NULL;
    if (specifier == NULL) {
        free(referrer);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    char *resolved_path = ct_resolve_import_path(specifier, referrer);
    free(specifier);
    free(referrer);
    if (resolved_path == NULL) {
        ct_throw_message(ctx, exception, "Unable to resolve dynamic import");
        return JSValueMakeUndefined(ctx);
    }

    char *source = NULL;
    size_t source_len = 0;
    if (ct_read_file_bytes(resolved_path, &source, &source_len) != 0) {
        char message[PATH_MAX + 128];
        snprintf(message, sizeof(message), "Unable to read dynamic import: %s", resolved_path);
        free(resolved_path);
        ct_throw_message(ctx, exception, message);
        return JSValueMakeUndefined(ctx);
    }

    char *wrapped = ct_prepare_sync_source((const uint8_t *)source, source_len, resolved_path);
    free(source);
    if (wrapped == NULL) {
        free(resolved_path);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    JSStringRef script = ct_js_string(wrapped);
    JSStringRef source_url = ct_js_string(resolved_path);
    JSValueRef eval_exception = NULL;
    JSEvaluateScript(ctx, script, NULL, source_url, 1, &eval_exception);
    JSStringRelease(script);
    JSStringRelease(source_url);
    free(wrapped);
    if (eval_exception != NULL) {
        char *error = ct_copy_exception(ctx, eval_exception);
        ct_throw_message(ctx, exception, error != NULL ? error : "Dynamic import failed");
        free(error);
        free(resolved_path);
        return JSValueMakeUndefined(ctx);
    }
    free(resolved_path);

    return ct_make_object(ctx);
}

static CtWorker *ct_worker_find_locked(uint32_t id) {
    for (CtWorker *worker = ct_workers; worker != NULL; worker = worker->next) {
        if (worker->id == id) return worker;
    }
    return NULL;
}

static CtWorker *ct_worker_find(uint32_t id) {
    CtWorker *worker = NULL;
    pthread_mutex_lock(&ct_workers_mutex);
    worker = ct_worker_find_locked(id);
    pthread_mutex_unlock(&ct_workers_mutex);
    return worker;
}

static int ct_worker_queue_push_locked(CtWorkerMessage **head, CtWorkerMessage **tail, const char *json) {
    CtWorkerMessage *message = (CtWorkerMessage *)calloc(1, sizeof(CtWorkerMessage));
    if (message == NULL) return -1;
    message->json = ct_duplicate_string(json);
    if (message->json == NULL) {
        free(message);
        return -1;
    }

    if (*tail != NULL) {
        (*tail)->next = message;
    } else {
        *head = message;
    }
    *tail = message;
    return 0;
}

static JSObjectRef ct_worker_drain_queue(JSContextRef ctx, CtWorker *worker, bool parent_to_worker, JSValueRef *exception) {
    CtWorkerMessage *head = NULL;
    JSObjectRef array = ct_make_array(ctx, 0, NULL, exception);
    uint32_t index = 0;

    pthread_mutex_lock(&worker->mutex);
    if (parent_to_worker) {
        head = worker->parent_to_worker_head;
        worker->parent_to_worker_head = NULL;
        worker->parent_to_worker_tail = NULL;
    } else {
        head = worker->worker_to_parent_head;
        worker->worker_to_parent_head = NULL;
        worker->worker_to_parent_tail = NULL;
    }
    pthread_mutex_unlock(&worker->mutex);

    while (head != NULL) {
        CtWorkerMessage *next = head->next;
        JSObjectSetPropertyAtIndex(ctx, array, index++, ct_make_string(ctx, head->json), exception);
        free(head->json);
        free(head);
        head = next;
    }

    return array;
}

static JSValueRef ct_is_worker(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
    (void)exception;
    CtJscRuntime *runtime = ct_callback_runtime(function);
    return JSValueMakeBoolean(ctx, runtime != NULL && runtime->worker != NULL);
}

static JSValueRef ct_worker_post_message(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    CtJscRuntime *runtime = ct_callback_runtime(function);
    CtJscRuntime *parent_runtime = NULL;
    uint32_t worker_id = 0;
    if (runtime == NULL || runtime->worker == NULL) {
        ct_throw_message(ctx, exception, "workerPostMessage is only available inside a worker");
        return JSValueMakeUndefined(ctx);
    }
    if (argc < 1) {
        ct_throw_message(ctx, exception, "workerPostMessage(json) requires a JSON string");
        return JSValueMakeUndefined(ctx);
    }

    char *json = ct_value_to_string_copy(ctx, argv[0]);
    if (json == NULL) return JSValueMakeUndefined(ctx);

    pthread_mutex_lock(&runtime->worker->mutex);
    int status = ct_worker_queue_push_locked(&runtime->worker->worker_to_parent_head, &runtime->worker->worker_to_parent_tail, json);
    parent_runtime = runtime->worker->parent_runtime;
    worker_id = runtime->worker->id;
    pthread_mutex_unlock(&runtime->worker->mutex);
    free(json);

    if (status != 0) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    ct_queue_worker_event(parent_runtime, worker_id);
    return JSValueMakeBoolean(ctx, true);
}

static JSValueRef ct_worker_poll_incoming_messages(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    (void)argc;
    (void)argv;
    CtJscRuntime *runtime = ct_callback_runtime(function);
    if (runtime == NULL || runtime->worker == NULL) {
        return ct_make_array(ctx, 0, NULL, exception);
    }
    return ct_worker_drain_queue(ctx, runtime->worker, true, exception);
}

static JSValueRef ct_worker_post_message_to(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "workerPostMessageTo(id, json) requires a worker id");
        return JSValueMakeUndefined(ctx);
    }

    uint32_t id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    char *json = ct_value_to_string_copy(ctx, argv[1]);
    if (json == NULL) return JSValueMakeUndefined(ctx);

    CtWorker *worker = ct_worker_find(id);
    if (worker == NULL) {
        free(json);
        ct_throw_message(ctx, exception, "worker not found");
        return JSValueMakeUndefined(ctx);
    }

    pthread_mutex_lock(&worker->mutex);
    int status = ct_worker_queue_push_locked(&worker->parent_to_worker_head, &worker->parent_to_worker_tail, json);
    pthread_mutex_unlock(&worker->mutex);
    free(json);

    if (status != 0) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeBoolean(ctx, true);
}

static JSValueRef ct_worker_poll_messages(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "workerPollMessages(id) requires a worker id");
        return JSValueMakeUndefined(ctx);
    }

    uint32_t id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    CtWorker *worker = ct_worker_find(id);
    if (worker == NULL) {
        return ct_make_array(ctx, 0, NULL, exception);
    }
    return ct_worker_drain_queue(ctx, worker, false, exception);
}

static JSValueRef ct_worker_terminate(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)exception;
    if (argc < 1) return JSValueMakeBoolean(ctx, false);
    uint32_t id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    CtWorker *worker = ct_worker_find(id);
    if (worker == NULL) return JSValueMakeBoolean(ctx, false);
    pthread_mutex_lock(&worker->mutex);
    worker->terminated = true;
    pthread_mutex_unlock(&worker->mutex);
    return JSValueMakeBoolean(ctx, true);
}

static JSValueRef ct_worker_set_event_handler(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    (void)exception;
    CtJscRuntime *runtime = ct_callback_runtime(function);
    if (runtime->worker_event_handler != NULL) {
        JSValueUnprotect(ctx, runtime->worker_event_handler);
        runtime->worker_event_handler = NULL;
    }
    if (argc >= 1 && JSValueIsObject(ctx, argv[0])) {
        runtime->worker_event_handler = (JSObjectRef)argv[0];
        JSValueProtect(ctx, runtime->worker_event_handler);
    }
    return JSValueMakeUndefined(ctx);
}

static void *ct_worker_entry(void *opaque) {
    CtWorkerStart *start = (CtWorkerStart *)opaque;
    CtJscRuntime *runtime = ct_jsc_runtime_create();
    char *source = NULL;
    size_t source_len = 0;
    char *error = NULL;
    static const char worker_bootstrap_source[] =
        "(()=>{"
        "const g=globalThis;"
        "g.self=g;"
        "const listeners=new Map();"
        "function serialize(message){"
        "const seen=new WeakSet();"
        "return JSON.stringify(message,(_key,value)=>{"
        "if(typeof value==='bigint')return value.toString();"
        "if(typeof value==='function'||typeof value==='symbol')return undefined;"
        "if(value&&typeof value==='object'){if(seen.has(value))return undefined;seen.add(value);}"
        "return value;"
        "});"
        "}"
        "function add(name,handler){"
        "if(typeof handler!=='function')return g;"
        "const key=String(name);"
        "const handlers=listeners.get(key)||[];"
        "handlers.push(handler);"
        "listeners.set(key,handlers);"
        "return g;"
        "}"
        "function remove(name,handler){"
        "const key=String(name);"
        "const handlers=listeners.get(key)||[];"
        "listeners.set(key,handlers.filter((item)=>item!==handler&&item.listener!==handler));"
        "return g;"
        "}"
        "function emit(name,event){"
        "const handler=g['on'+name];"
        "if(typeof handler==='function')handler.call(g,event);"
        "for(const listener of listeners.get(String(name))||[])listener.call(g,event);"
        "}"
        "function hasMessageListener(){"
        "const handler=g['onmessage'];"
        "return typeof handler==='function'||((listeners.get('message')||[]).length>0);"
        "}"
        "g.postMessage=g.self.postMessage=(message)=>cottontail.workerPostMessage(serialize(message));"
        "g.addEventListener=g.self.addEventListener=add;"
        "g.removeEventListener=g.self.removeEventListener=remove;"
        "g.__cottontailPollWorkerMessages=()=>{"
        "if(!hasMessageListener())return;"
        "for(const item of cottontail.workerPollIncomingMessages()){"
        "let data=item;"
        "try{data=JSON.parse(item);}catch{}"
        "emit('message',{data});"
        "}"
        "};"
        "if(!g.__cottontailHasActiveHandles)g.__cottontailHasActiveHandles=()=>{"
        "return hasMessageListener();"
        "};"
        "if(!g.__cottontailRunLoopTick)g.__cottontailRunLoopTick=()=>{"
        "g.__cottontailPollWorkerMessages();"
        "if(cottontail.drainJobs)cottontail.drainJobs();"
        "return 16;"
        "};"
        "})();";

    if (runtime == NULL) {
        fprintf(stderr, "cottontail: worker runtime initialization failed\n");
        free(start->script_path);
        free(start);
        return NULL;
    }
    runtime->worker = start->worker;

    JSStringRef bootstrap = ct_js_string(worker_bootstrap_source);
    JSStringRef bootstrap_name = ct_js_string("<cottontail-worker-bootstrap>");
    JSValueRef bootstrap_exception = NULL;
    JSEvaluateScript(runtime->context, bootstrap, NULL, bootstrap_name, 1, &bootstrap_exception);
    JSStringRelease(bootstrap);
    JSStringRelease(bootstrap_name);
    if (bootstrap_exception != NULL) {
        error = ct_copy_exception(runtime->context, bootstrap_exception);
        fprintf(stderr, "%s\n", error != NULL ? error : "cottontail: worker bootstrap failed");
        free(error);
        ct_jsc_runtime_destroy(runtime);
        free(start->script_path);
        free(start);
        return NULL;
    }

    if (ct_read_file_bytes(start->script_path, &source, &source_len) != 0) {
        fprintf(stderr, "cottontail: failed to load worker script %s\n", start->script_path);
        ct_jsc_runtime_destroy(runtime);
        free(start->script_path);
        free(start);
        return NULL;
    }

    if (ct_jsc_runtime_eval(runtime, (const uint8_t *)source, source_len, start->script_path, &error) != 0) {
        fprintf(stderr, "%s\n", error != NULL ? error : "cottontail: worker script failed");
        free(error);
        free(source);
        ct_jsc_runtime_destroy(runtime);
        free(start->script_path);
        free(start);
        return NULL;
    }
    free(source);

    while (true) {
        bool terminated = false;
        pthread_mutex_lock(&start->worker->mutex);
        terminated = start->worker->terminated;
        pthread_mutex_unlock(&start->worker->mutex);
        if (terminated) break;

        int delay_ms = 16;
        if (ct_jsc_runtime_tick_with_delay(runtime, &delay_ms, &error) != 0) {
            fprintf(stderr, "%s\n", error != NULL ? error : "cottontail: worker tick failed");
            free(error);
            break;
        }
        usleep((useconds_t)delay_ms * 1000);
    }

    ct_jsc_runtime_destroy(runtime);
    pthread_mutex_lock(&start->worker->mutex);
    start->worker->terminated = true;
    pthread_mutex_unlock(&start->worker->mutex);
    free(start->script_path);
    free(start);
    return NULL;
}

static JSValueRef ct_worker_spawn(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    CtJscRuntime *runtime = ct_callback_runtime(function);
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.spawnWorker(scriptPath) requires a script path");
        return JSValueMakeUndefined(ctx);
    }

    char *script_path = ct_value_to_string_copy(ctx, argv[0]);
    if (script_path == NULL) return JSValueMakeUndefined(ctx);

    CtWorker *worker = (CtWorker *)calloc(1, sizeof(CtWorker));
    CtWorkerStart *start = (CtWorkerStart *)calloc(1, sizeof(CtWorkerStart));
    if (worker == NULL || start == NULL) {
        free(worker);
        free(start);
        free(script_path);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    pthread_mutex_init(&worker->mutex, NULL);
    worker->parent_runtime = runtime;
    pthread_mutex_lock(&ct_workers_mutex);
    worker->id = ct_next_worker_id++;
    worker->next = ct_workers;
    ct_workers = worker;
    pthread_mutex_unlock(&ct_workers_mutex);

    start->script_path = script_path;
    start->worker = worker;

    pthread_attr_t attr;
    int attr_status = pthread_attr_init(&attr);
    if (attr_status != 0) {
        pthread_mutex_lock(&worker->mutex);
        worker->terminated = true;
        pthread_mutex_unlock(&worker->mutex);
        free(start->script_path);
        free(start);
        ct_throw_message(ctx, exception, "failed to initialize worker thread attributes");
        return JSValueMakeUndefined(ctx);
    }

    attr_status = pthread_attr_setstacksize(&attr, CT_WORKER_STACK_SIZE);
    if (attr_status != 0) {
        pthread_attr_destroy(&attr);
        pthread_mutex_lock(&worker->mutex);
        worker->terminated = true;
        pthread_mutex_unlock(&worker->mutex);
        free(start->script_path);
        free(start);
        ct_throw_message(ctx, exception, "failed to set worker thread stack size");
        return JSValueMakeUndefined(ctx);
    }

    pthread_t thread;
    int create_status = pthread_create(&thread, &attr, ct_worker_entry, start);
    pthread_attr_destroy(&attr);
    if (create_status != 0) {
        pthread_mutex_lock(&worker->mutex);
        worker->terminated = true;
        pthread_mutex_unlock(&worker->mutex);
        free(start->script_path);
        free(start);
        ct_throw_message(ctx, exception, "failed to create worker thread");
        return JSValueMakeUndefined(ctx);
    }

    worker->thread = thread;
    pthread_detach(thread);

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, worker->id), exception);
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
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.readFd(fd[, maxBytes]) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    size_t max_bytes = argc >= 2 ? (size_t)ct_value_to_number(ctx, argv[1]) : 65536;
    if (fd < 0) {
        ct_throw_message(ctx, exception, "invalid file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    if (max_bytes == 0) max_bytes = 65536;
    if (max_bytes > 1024 * 1024) max_bytes = 1024 * 1024;

    struct pollfd poll_fd;
    poll_fd.fd = fd;
    poll_fd.events = POLLIN | POLLHUP | POLLERR;
    poll_fd.revents = 0;

    int ready = poll(&poll_fd, 1, 0);
    if (ready == 0) {
        return JSValueMakeNull(ctx);
    }
    if (ready < 0) {
        if (errno == EINTR) return JSValueMakeNull(ctx);
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    if ((poll_fd.revents & POLLNVAL) != 0) {
        ct_throw_message(ctx, exception, "invalid file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    if ((poll_fd.revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
        return JSValueMakeNull(ctx);
    }

    char *buffer = (char *)malloc(max_bytes > 0 ? max_bytes : 1);
    if (buffer == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    ssize_t n = read(fd, buffer, max_bytes);
    if (n < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
            free(buffer);
            return JSValueMakeNull(ctx);
        }
        ct_throw_message(ctx, exception, strerror(errno));
        free(buffer);
        return JSValueMakeUndefined(ctx);
    }
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

static JSValueRef ct_fd_write(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.fdWrite(fd, data) requires a file descriptor and data");
        return JSValueMakeBoolean(ctx, false);
    }

    int fd = (int)ct_value_to_number(ctx, argv[0]);
    uint8_t *bytes = NULL;
    size_t len = 0;
    char *text = NULL;
    if (ct_get_bytes(ctx, argv[1], &bytes, &len) != 0) {
        text = ct_value_to_string_copy(ctx, argv[1]);
        bytes = (uint8_t *)text;
        len = text != NULL ? strlen(text) : 0;
    }

    bool ok = fd >= 0;
    size_t written_total = 0;
    while (ok && written_total < len) {
        ssize_t written = write(fd, bytes + written_total, len - written_total);
        if (written < 0) {
            if (errno == EINTR) continue;
            ok = false;
            break;
        }
        written_total += (size_t)written;
    }

    free(text);
    return JSValueMakeBoolean(ctx, ok);
}

static JSValueRef ct_fd_watch_start(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    CtJscRuntime *runtime = ct_callback_runtime(function);
    if (runtime == NULL || argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.fdWatchStart(fd[, maxBytes]) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }

    int fd = (int)ct_value_to_number(ctx, argv[0]);
    size_t max_bytes = argc >= 2 ? (size_t)ct_value_to_number(ctx, argv[1]) : 65536;
    if (fd < 0) {
        ct_throw_message(ctx, exception, "invalid file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    if (max_bytes == 0) max_bytes = 65536;
    if (max_bytes > 1024 * 1024) max_bytes = 1024 * 1024;

    CtFdWatcher *watcher = (CtFdWatcher *)calloc(1, sizeof(CtFdWatcher));
    if (watcher == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    watcher->id = ++runtime->next_fd_watch_id;
    if (watcher->id == 0) watcher->id = ++runtime->next_fd_watch_id;
    watcher->fd = fd;
    watcher->max_bytes = max_bytes;
    watcher->runtime = runtime;
    watcher->active = true;
    pthread_mutex_init(&watcher->mutex, NULL);
    if (ct_debug_flag("COTTONTAIL_FD_DEBUG")) {
        fprintf(stderr, "[cottontail:fd] start id=%u fd=%d max=%zu\n", watcher->id, watcher->fd, watcher->max_bytes);
        fflush(stderr);
    }

    pthread_mutex_lock(&ct_fd_watchers_mutex);
    watcher->next = ct_fd_watchers;
    ct_fd_watchers = watcher;
    pthread_mutex_unlock(&ct_fd_watchers_mutex);

    if (pthread_create(&watcher->thread, NULL, ct_fd_watcher_thread, watcher) != 0) {
        ct_fd_watcher_set_active(watcher, false);
        ct_fd_watchers_remove(watcher);
        pthread_mutex_destroy(&watcher->mutex);
        free(watcher);
        ct_throw_message(ctx, exception, "failed to create fd watcher thread");
        return JSValueMakeUndefined(ctx);
    }
    pthread_detach(watcher->thread);

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, watcher->id), exception);
    return result;
}

static JSValueRef ct_fd_watch_stop(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)exception;
    if (argc < 1) return JSValueMakeBoolean(ctx, false);
    uint32_t id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    return JSValueMakeBoolean(ctx, ct_fd_watcher_stop_id(id));
}

static JSValueRef ct_fd_set_event_handler(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    (void)exception;
    CtJscRuntime *runtime = ct_callback_runtime(function);
    if (runtime->fd_event_handler != NULL) {
        JSValueUnprotect(ctx, runtime->fd_event_handler);
        runtime->fd_event_handler = NULL;
    }
    if (argc >= 1 && JSValueIsObject(ctx, argv[0])) {
        runtime->fd_event_handler = (JSObjectRef)argv[0];
        JSValueProtect(ctx, runtime->fd_event_handler);
    }
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

static bool ct_install_function(JSContextRef ctx, JSObjectRef target, const char *name, JSObjectCallAsFunctionCallback callback, CtJscRuntime *runtime) {
    JSValueRef exception = NULL;
    return ct_set_property(ctx, target, name, ct_make_function(ctx, name, callback, runtime), &exception);
}

static int ct_install_host_api(CtJscRuntime *runtime) {
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
    ct_install_function(ctx, host, "importModule", ct_import_module, runtime);
    ct_install_function(ctx, host, "cwd", ct_cwd, runtime);
    ct_install_function(ctx, host, "readFile", ct_read_file, runtime);
    ct_install_function(ctx, host, "readFileBuffer", ct_read_file_buffer, runtime);
    ct_install_function(ctx, host, "writeFile", ct_write_file, runtime);
    ct_install_function(ctx, host, "openFd", ct_open_fd, runtime);
    ct_install_function(ctx, host, "readFd", ct_read_fd, runtime);
    ct_install_function(ctx, host, "closeFd", ct_close_fd, runtime);
    ct_install_function(ctx, host, "fdWrite", ct_fd_write, runtime);
    ct_install_function(ctx, host, "fdWatchStart", ct_fd_watch_start, runtime);
    ct_install_function(ctx, host, "fdWatchStop", ct_fd_watch_stop, runtime);
    ct_install_function(ctx, host, "fdSetEventHandler", ct_fd_set_event_handler, runtime);
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
    ct_install_function(ctx, host, "memoryAddress", ct_memory_address, runtime);
    ct_install_function(ctx, host, "memoryView", ct_memory_view, runtime);
    ct_install_function(ctx, host, "nativeCall", ct_native_call, runtime);
    ct_install_function(ctx, host, "createCallback", ct_create_callback, runtime);
    ct_install_function(ctx, host, "closeCallback", ct_close_callback, runtime);
    ct_install_function(ctx, host, "spawnWorker", ct_worker_spawn, runtime);
    ct_install_function(ctx, host, "isWorker", ct_is_worker, runtime);
    ct_install_function(ctx, host, "workerPostMessage", ct_worker_post_message, runtime);
    ct_install_function(ctx, host, "workerPollIncomingMessages", ct_worker_poll_incoming_messages, runtime);
    ct_install_function(ctx, host, "workerPostMessageTo", ct_worker_post_message_to, runtime);
    ct_install_function(ctx, host, "workerPollMessages", ct_worker_poll_messages, runtime);
    ct_install_function(ctx, host, "workerSetEventHandler", ct_worker_set_event_handler, runtime);
    ct_install_function(ctx, host, "workerTerminate", ct_worker_terminate, runtime);
    ct_install_function(ctx, host, "exit", ct_exit, runtime);
    ct_install_function(ctx, host, "execPath", ct_exec_path, runtime);
    ct_install_function(ctx, host, "pid", ct_pid, runtime);
    ct_install_function(ctx, host, "kill", ct_kill_process, runtime);
    ct_install_function(ctx, host, "randomBytes", ct_random_bytes, runtime);
    ct_install_function(ctx, host, "platform", ct_platform, runtime);
    ct_install_function(ctx, host, "arch", ct_arch, runtime);
    ct_install_function(ctx, host, "hostname", ct_hostname, runtime);
    JSObjectRef args = ct_make_array(ctx, 0, NULL, &exception);
    ct_set_property(ctx, host, "args", args, &exception);
    ct_set_property(ctx, global, "cottontail", host, &exception);

    JSStringRef bootstrap = ct_js_string(
        "globalThis.global = globalThis;"
        "globalThis.__ctUnhandledRejection = undefined;"
        "if (typeof globalThis.queueMicrotask !== 'function') {"
        "  globalThis.queueMicrotask = function(callback){"
        "    if (typeof callback !== 'function') throw new TypeError('queueMicrotask callback must be a function');"
        "    Promise.resolve().then(callback);"
        "  };"
        "}"
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

CtJscRuntime *ct_jsc_runtime_create(void) {
    return ct_jsc_runtime_create_with_stack_size(0);
}

CtJscRuntime *ct_jsc_runtime_create_with_stack_size(size_t stack_size) {
    (void)stack_size;
    CtJscRuntime *runtime = (CtJscRuntime *)calloc(1, sizeof(CtJscRuntime));
    if (runtime == NULL) return NULL;
    runtime->context = JSGlobalContextCreate(NULL);
    if (runtime->context == NULL) {
        free(runtime);
        return NULL;
    }
    pthread_mutex_init(&runtime->spawn_event_mutex, NULL);
    pthread_mutex_init(&runtime->fd_event_mutex, NULL);
    pthread_mutex_init(&runtime->worker_event_mutex, NULL);
    pthread_mutex_init(&runtime->callback_mutex, NULL);
    runtime->owner_thread = pthread_self();
    if (ct_install_host_api(runtime) != 0) {
        ct_jsc_runtime_destroy(runtime);
        return NULL;
    }
    return runtime;
}

void ct_jsc_runtime_destroy(CtJscRuntime *runtime) {
    if (runtime == NULL) return;
    ct_async_processes_wait_for_runtime(runtime);
    ct_fd_watchers_wait_for_runtime(runtime);
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
        if (runtime->fd_event_handler != NULL) JSValueUnprotect(ctx, runtime->fd_event_handler);
        if (runtime->worker_event_handler != NULL) JSValueUnprotect(ctx, runtime->worker_event_handler);
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
    while (runtime->fd_events_head != NULL) {
        CtFdEvent *event = runtime->fd_events_head;
        runtime->fd_events_head = event->next;
        free(event->type);
        free(event->data);
        free(event->message);
        free(event);
    }
    while (runtime->worker_events_head != NULL) {
        CtWorkerEvent *event = runtime->worker_events_head;
        runtime->worker_events_head = event->next;
        free(event);
    }
    while (runtime->callback_jobs_head != NULL) {
        CtFfiCallbackJob *job = runtime->callback_jobs_head;
        runtime->callback_jobs_head = job->next;
        if (job->wait_for_result) {
            pthread_mutex_lock(&job->mutex);
            job->completed = true;
            pthread_cond_signal(&job->cond);
            pthread_mutex_unlock(&job->mutex);
        } else {
            free(job);
        }
    }
    pthread_mutex_destroy(&runtime->spawn_event_mutex);
    pthread_mutex_destroy(&runtime->fd_event_mutex);
    pthread_mutex_destroy(&runtime->worker_event_mutex);
    pthread_mutex_destroy(&runtime->callback_mutex);
    free(runtime);
}

int ct_jsc_runtime_set_args(CtJscRuntime *runtime, size_t argc, const char *const *argv, char **error_out) {
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

typedef struct {
    char *data;
    size_t len;
    size_t cap;
} CtStringBuilder;

static bool ct_sb_init(CtStringBuilder *builder, size_t initial_capacity) {
    builder->len = 0;
    builder->cap = initial_capacity > 0 ? initial_capacity : 1;
    builder->data = (char *)malloc(builder->cap);
    if (builder->data == NULL) return false;
    builder->data[0] = 0;
    return true;
}

static bool ct_sb_reserve(CtStringBuilder *builder, size_t extra) {
    if (extra > SIZE_MAX - builder->len - 1) return false;
    size_t required = builder->len + extra + 1;
    if (required <= builder->cap) return true;
    size_t next_cap = builder->cap;
    while (next_cap < required) {
        if (next_cap > SIZE_MAX / 2) {
            next_cap = required;
            break;
        }
        next_cap *= 2;
    }
    char *next = (char *)realloc(builder->data, next_cap);
    if (next == NULL) return false;
    builder->data = next;
    builder->cap = next_cap;
    return true;
}

static bool ct_sb_append_bytes(CtStringBuilder *builder, const char *bytes, size_t len) {
    if (!ct_sb_reserve(builder, len)) return false;
    if (len > 0) memcpy(builder->data + builder->len, bytes, len);
    builder->len += len;
    builder->data[builder->len] = 0;
    return true;
}

static bool ct_sb_append_cstr(CtStringBuilder *builder, const char *value) {
    return ct_sb_append_bytes(builder, value != NULL ? value : "", value != NULL ? strlen(value) : 0);
}

static bool ct_sb_append_js_string_literal(CtStringBuilder *builder, const char *value) {
    if (!ct_sb_append_cstr(builder, "\"")) return false;
    const unsigned char *cursor = (const unsigned char *)(value != NULL ? value : "");
    while (*cursor != 0) {
        char escape[7];
        switch (*cursor) {
            case '\\':
                if (!ct_sb_append_cstr(builder, "\\\\")) return false;
                break;
            case '"':
                if (!ct_sb_append_cstr(builder, "\\\"")) return false;
                break;
            case '\n':
                if (!ct_sb_append_cstr(builder, "\\n")) return false;
                break;
            case '\r':
                if (!ct_sb_append_cstr(builder, "\\r")) return false;
                break;
            case '\t':
                if (!ct_sb_append_cstr(builder, "\\t")) return false;
                break;
            default:
                if (*cursor < 0x20) {
                    snprintf(escape, sizeof(escape), "\\u%04x", *cursor);
                    if (!ct_sb_append_cstr(builder, escape)) return false;
                } else if (!ct_sb_append_bytes(builder, (const char *)cursor, 1)) {
                    return false;
                }
                break;
        }
        cursor += 1;
    }
    return ct_sb_append_cstr(builder, "\"");
}

static bool ct_is_js_identifier_char(char ch) {
    return (ch >= 'A' && ch <= 'Z') ||
        (ch >= 'a' && ch <= 'z') ||
        (ch >= '0' && ch <= '9') ||
        ch == '_' ||
        ch == '$';
}

static bool ct_append_rewritten_dynamic_imports(
    CtStringBuilder *builder,
    const char *line,
    size_t line_len,
    const char *filename
) {
    const char *cursor = line;
    const char *end = line + line_len;

    while (cursor < end) {
        const char *import_start = NULL;
        const char *open_paren = NULL;
        for (const char *scan = cursor; scan + 6 <= end; scan += 1) {
            if (strncmp(scan, "import", 6) != 0) continue;
            if (scan > line && ct_is_js_identifier_char(scan[-1])) continue;
            if (scan + 6 < end && ct_is_js_identifier_char(scan[6])) continue;
            const char *after_import = scan + 6;
            while (after_import < end && (*after_import == ' ' || *after_import == '\t')) after_import += 1;
            if (after_import < end && *after_import == '(') {
                import_start = scan;
                open_paren = after_import;
                break;
            }
        }

        if (import_start == NULL) {
            return ct_sb_append_bytes(builder, cursor, (size_t)(end - cursor));
        }

        if (!ct_sb_append_bytes(builder, cursor, (size_t)(import_start - cursor))) return false;

        const char *literal_start = open_paren + 1;
        while (literal_start < end && (*literal_start == ' ' || *literal_start == '\t')) literal_start += 1;
        if (literal_start >= end || (*literal_start != '"' && *literal_start != '\'')) {
            if (!ct_sb_append_bytes(builder, import_start, (size_t)(open_paren + 1 - import_start))) return false;
            cursor = open_paren + 1;
            continue;
        }

        char quote = *literal_start;
        const char *literal_end = literal_start + 1;
        bool escaped = false;
        while (literal_end < end) {
            char ch = *literal_end;
            literal_end += 1;
            if (escaped) {
                escaped = false;
            } else if (ch == '\\') {
                escaped = true;
            } else if (ch == quote) {
                break;
            }
        }
        if (literal_end > end || literal_end[-1] != quote) {
            if (!ct_sb_append_bytes(builder, import_start, (size_t)(open_paren + 1 - import_start))) return false;
            cursor = open_paren + 1;
            continue;
        }

        const char *close_paren = literal_end;
        while (close_paren < end && (*close_paren == ' ' || *close_paren == '\t')) close_paren += 1;
        if (close_paren >= end || *close_paren != ')') {
            if (!ct_sb_append_bytes(builder, import_start, (size_t)(open_paren + 1 - import_start))) return false;
            cursor = open_paren + 1;
            continue;
        }

        if (!ct_sb_append_cstr(builder, "cottontail.importModule(")) return false;
        if (!ct_sb_append_bytes(builder, literal_start, (size_t)(literal_end - literal_start))) return false;
        if (!ct_sb_append_cstr(builder, ",")) return false;
        if (!ct_sb_append_js_string_literal(builder, filename != NULL ? filename : "<script>")) return false;
        if (!ct_sb_append_cstr(builder, ")")) return false;
        cursor = close_paren + 1;
    }

    return true;
}

static char *ct_path_basename_copy(const char *path) {
    if (path == NULL || path[0] == 0) return ct_duplicate_string("");
    char *path_copy = NULL;
    if (strncmp(path, "file://", 7) == 0) {
        path_copy = ct_file_url_to_path(path);
    } else {
        path_copy = ct_duplicate_string(path);
    }
    if (path_copy == NULL) return NULL;
    char *slash = strrchr(path_copy, '/');
    char *result = ct_duplicate_string(slash != NULL ? slash + 1 : path_copy);
    free(path_copy);
    return result;
}

static char *ct_file_url_for_path(const char *path) {
    if (path == NULL) return ct_duplicate_string("file://");
    if (strncmp(path, "file://", 7) == 0) return ct_duplicate_string(path);
    size_t len = strlen(path);
    char *out = (char *)malloc(strlen("file://") + len + 1);
    if (out == NULL) return NULL;
    memcpy(out, "file://", strlen("file://"));
    memcpy(out + strlen("file://"), path, len);
    out[strlen("file://") + len] = 0;
    return out;
}

static bool ct_match_import_meta_property(
    const char *start,
    const char *end,
    const char *property,
    const char **after_out
) {
    size_t len = strlen(property);
    if ((size_t)(end - start) < len) return false;
    if (strncmp(start, property, len) != 0) return false;
    if (start + len < end && ct_is_js_identifier_char(start[len])) return false;
    *after_out = start + len;
    return true;
}

static bool ct_append_rewritten_import_meta(
    CtStringBuilder *builder,
    const char *line,
    size_t line_len,
    const char *filename
) {
    const char *cursor = line;
    const char *end = line + line_len;
    const char *meta_prefix = "import.meta.";
    size_t meta_prefix_len = strlen(meta_prefix);
    char *dirname = ct_path_dirname(filename);
    char *basename = ct_path_basename_copy(filename);
    char *file_url = ct_file_url_for_path(filename);
    if (dirname == NULL || basename == NULL || file_url == NULL) {
        free(dirname);
        free(basename);
        free(file_url);
        return false;
    }

    while (cursor < end) {
        const char *found = NULL;
        for (const char *scan = cursor; scan + meta_prefix_len <= end; scan += 1) {
            if (strncmp(scan, meta_prefix, meta_prefix_len) == 0) {
                found = scan;
                break;
            }
        }
        if (found == NULL) {
            bool ok = ct_sb_append_bytes(builder, cursor, (size_t)(end - cursor));
            free(dirname);
            free(basename);
            free(file_url);
            return ok;
        }

        if (!ct_sb_append_bytes(builder, cursor, (size_t)(found - cursor))) {
            free(dirname);
            free(basename);
            free(file_url);
            return false;
        }

        const char *property_start = found + meta_prefix_len;
        const char *after = NULL;
        if (ct_match_import_meta_property(property_start, end, "dirname", &after) ||
            ct_match_import_meta_property(property_start, end, "dir", &after)) {
            if (!ct_sb_append_js_string_literal(builder, dirname)) {
                free(dirname);
                free(basename);
                free(file_url);
                return false;
            }
            cursor = after;
        } else if (ct_match_import_meta_property(property_start, end, "filename", &after) ||
            ct_match_import_meta_property(property_start, end, "path", &after)) {
            if (!ct_sb_append_js_string_literal(builder, filename != NULL ? filename : "")) {
                free(dirname);
                free(basename);
                free(file_url);
                return false;
            }
            cursor = after;
        } else if (ct_match_import_meta_property(property_start, end, "file", &after)) {
            if (!ct_sb_append_js_string_literal(builder, basename)) {
                free(dirname);
                free(basename);
                free(file_url);
                return false;
            }
            cursor = after;
        } else if (ct_match_import_meta_property(property_start, end, "url", &after)) {
            if (!ct_sb_append_js_string_literal(builder, file_url)) {
                free(dirname);
                free(basename);
                free(file_url);
                return false;
            }
            cursor = after;
        } else if (ct_match_import_meta_property(property_start, end, "main", &after)) {
            if (!ct_sb_append_cstr(builder, "true")) {
                free(dirname);
                free(basename);
                free(file_url);
                return false;
            }
            cursor = after;
        } else {
            if (!ct_sb_append_bytes(builder, found, meta_prefix_len)) {
                free(dirname);
                free(basename);
                free(file_url);
                return false;
            }
            cursor = property_start;
        }
    }

    free(dirname);
    free(basename);
    free(file_url);
    return true;
}

static char *ct_prepare_source_with_wrappers(
    const uint8_t *source,
    size_t source_len,
    const char *filename,
    const char *prefix,
    const char *suffix
) {
    size_t prefix_len = strlen(prefix);
    size_t suffix_len = strlen(suffix);
    CtStringBuilder builder;
    if (!ct_sb_init(&builder, prefix_len + source_len + suffix_len + 1)) return NULL;
    if (!ct_sb_append_bytes(&builder, prefix, prefix_len)) {
        free(builder.data);
        return NULL;
    }

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
            CtStringBuilder meta_builder;
            if (!ct_sb_init(&meta_builder, line_len + 1)) {
                free(builder.data);
                return NULL;
            }
            if (!ct_append_rewritten_import_meta(&meta_builder, start, line_len, filename)) {
                free(meta_builder.data);
                free(builder.data);
                return NULL;
            }
            if (!ct_append_rewritten_dynamic_imports(&builder, meta_builder.data, meta_builder.len, filename)) {
                free(meta_builder.data);
                free(builder.data);
                return NULL;
            }
            free(meta_builder.data);
            if (line_end < end && !ct_sb_append_cstr(&builder, "\n")) {
                free(builder.data);
                return NULL;
            }
        }
        start = line_end < end ? line_end + 1 : end;
    }

    if (!ct_sb_append_bytes(&builder, suffix, suffix_len)) {
        free(builder.data);
        return NULL;
    }
    return builder.data;
}

static char *ct_prepare_wrapped_source(const uint8_t *source, size_t source_len, const char *filename) {
    return ct_prepare_source_with_wrappers(
        source,
        source_len,
        filename,
        "globalThis.__ctDone=false;globalThis.__ctError=undefined;"
        "Promise.resolve((async()=>{\n",
        "\n})()).then(()=>{globalThis.__ctDone=true;},"
        "e=>{globalThis.__ctError=e;globalThis.__ctDone=true;});"
    );
}

static char *ct_prepare_sync_source(const uint8_t *source, size_t source_len, const char *filename) {
    return ct_prepare_source_with_wrappers(
        source,
        source_len,
        filename,
        "(()=>{\n",
        "\n})();"
    );
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

static bool ct_runtime_has_pending_native_events(CtJscRuntime *runtime) {
    bool pending = false;

    pthread_mutex_lock(&runtime->callback_mutex);
    pending = runtime->callback_jobs_head != NULL;
    pthread_mutex_unlock(&runtime->callback_mutex);
    if (pending) return true;
    if (ct_runtime_has_live_callbacks(runtime)) return true;

    pthread_mutex_lock(&runtime->spawn_event_mutex);
    pending = runtime->spawn_events_head != NULL;
    pthread_mutex_unlock(&runtime->spawn_event_mutex);
    if (pending) return true;

    pthread_mutex_lock(&runtime->fd_event_mutex);
    pending = runtime->fd_events_head != NULL;
    pthread_mutex_unlock(&runtime->fd_event_mutex);
    if (pending) return true;

    pthread_mutex_lock(&runtime->worker_event_mutex);
    pending = runtime->worker_events_head != NULL;
    pthread_mutex_unlock(&runtime->worker_event_mutex);
    if (pending) return true;

    return ct_fd_watchers_has_runtime(runtime);
}

static int ct_jsc_runtime_has_active_handles(CtJscRuntime *runtime, bool *has_active_handles_out, char **error_out) {
    *has_active_handles_out = false;
    if (ct_runtime_has_pending_native_events(runtime)) {
        *has_active_handles_out = true;
        return 0;
    }

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
    if (!*has_active_handles_out && ct_runtime_has_pending_native_events(runtime)) {
        *has_active_handles_out = true;
    }
    return 0;
}

static int ct_jsc_runtime_eval_internal(
    CtJscRuntime *runtime,
    const uint8_t *source,
    size_t source_len,
    const char *filename,
    bool wait_for_active_handles,
    char **error_out
) {
    if (error_out != NULL) *error_out = NULL;
    JSContextRef ctx = runtime->context;
    char *wrapped = ct_prepare_wrapped_source(source, source_len, filename);
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
        if (ct_jsc_runtime_tick(runtime, error_out) != 0) return -1;
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

    if (!wait_for_active_handles) return 0;

    for (;;) {
        bool has_active_handles = false;
        int delay_ms = 16;
        if (ct_jsc_runtime_has_active_handles(runtime, &has_active_handles, error_out) != 0) return -1;
        if (!has_active_handles) break;
        if (ct_jsc_runtime_tick_with_delay(runtime, &delay_ms, error_out) != 0) return -1;
        usleep((useconds_t)delay_ms * 1000);
    }

    unhandled = ct_global_value(ctx, "__ctUnhandledRejection");
    if (unhandled != NULL && !JSValueIsUndefined(ctx, unhandled) && !JSValueIsNull(ctx, unhandled)) {
        ct_set_error_out(error_out, ct_copy_exception(ctx, unhandled));
        return -1;
    }
    return 0;
}

int ct_jsc_runtime_eval(CtJscRuntime *runtime, const uint8_t *source, size_t source_len, const char *filename, char **error_out) {
    return ct_jsc_runtime_eval_internal(runtime, source, source_len, filename, true, error_out);
}

static int ct_jsc_runtime_tick_with_delay(CtJscRuntime *runtime, int *delay_ms_out, char **error_out) {
    if (error_out != NULL) *error_out = NULL;
    if (delay_ms_out != NULL) *delay_ms_out = 16;
    JSContextRef ctx = runtime->context;
    if (ct_drain_ffi_callbacks(runtime, error_out) != 0) return -1;
    JSStringRef source = ct_js_string(
        "(function(){"
        "let delay=16;"
        "if(globalThis.__cottontailRunLoopTick) delay=globalThis.__cottontailRunLoopTick();"
        "return delay == null ? 16 : Number(delay);"
        "})()"
    );
    JSValueRef exception = NULL;
    JSValueRef value = JSEvaluateScript(ctx, source, NULL, NULL, 1, &exception);
    JSStringRelease(source);
    if (exception != NULL) {
        ct_set_error_out(error_out, ct_copy_exception(ctx, exception));
        return -1;
    }
    if (delay_ms_out != NULL && value != NULL) {
        JSValueRef number_exception = NULL;
        double delay = JSValueToNumber(ctx, value, &number_exception);
        if (number_exception == NULL && delay == delay) {
            if (delay < 1) delay = 1;
            if (delay > 1000) delay = 1000;
            *delay_ms_out = (int)delay;
        }
    }
    return 0;
}

int ct_jsc_runtime_tick(CtJscRuntime *runtime, char **error_out) {
    return ct_jsc_runtime_tick_with_delay(runtime, NULL, error_out);
}

void ct_jsc_string_free(char *value) {
    free(value);
}
