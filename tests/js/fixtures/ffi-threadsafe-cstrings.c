#include <stdint.h>
#include <stdio.h>
#include <string.h>

#if defined(_WIN32)
#include <windows.h>
typedef HANDLE thread_t;
#define THREAD_ENTRY DWORD WINAPI
typedef DWORD (WINAPI *thread_fn)(void *);
static int start_thread(thread_t *thread, thread_fn fn, void *arg) {
    *thread = CreateThread(NULL, 0, fn, arg, 0, NULL);
    return *thread == NULL ? 1 : 0;
}
static int join_thread(thread_t thread) {
    DWORD result = WaitForSingleObject(thread, INFINITE);
    CloseHandle(thread);
    return result == WAIT_OBJECT_0 ? 0 : 1;
}
#else
#include <pthread.h>
typedef pthread_t thread_t;
#define THREAD_ENTRY void *
typedef void *(*thread_fn)(void *);
static int start_thread(thread_t *thread, thread_fn fn, void *arg) {
    return pthread_create(thread, NULL, fn, arg);
}
static int join_thread(thread_t thread) { return pthread_join(thread, NULL); }
#endif

typedef void (*burst_callback)(uint32_t, const char *, const char *, const char *, const char *, void *);
typedef int32_t (*blocking_callback)(char *, void *);
typedef struct { burst_callback callback; uint32_t count; } burst_job;

/* Static storage lets the test inspect overwritten borrowed ptr arguments
 * without reading freed memory. The cstring arguments must retain each value. */
static char first[128];
static char second[128];
static char empty[2];

static THREAD_ENTRY burst_worker(void *arg) {
    burst_job *job = arg;
    for (uint32_t i = 0; i < job->count; i++) {
        snprintf(first, sizeof(first), "/tmp/zendo-%u-é-漢-🙂.mjs", i);
        snprintf(second, sizeof(second), "value-%u-é", i);
        empty[0] = '\0';
        job->callback(i, first, second, empty, NULL, first);
        strcpy(first, "OVERWRITTEN");
        strcpy(second, "OVERWRITTEN");
        strcpy(empty, "X");
    }
    return 0;
}

int32_t ffi_cstring_burst(burst_callback callback, uint32_t count) {
    burst_job job = { callback, count };
    thread_t thread;
    int status = start_thread(&thread, burst_worker, &job);
    /* Join while the JS owner is inside this FFI call. This ensures every
     * callback is queued and its native buffers are reused before delivery. */
    return status == 0 ? join_thread(thread) : status;
}

int32_t ffi_cstring_immediate(blocking_callback callback) {
    char text[] = "borrowed";
    int32_t result = callback(text, text);
    return result == 7 && strcmp(text, "Morrowed") == 0 ? 1 : 0;
}

static thread_t blocking_thread;
static blocking_callback blocking_fn;
static int32_t blocking_result;
static THREAD_ENTRY blocking_worker(void *unused) {
    (void)unused;
    blocking_result = ffi_cstring_immediate(blocking_fn);
    return 0;
}

int32_t ffi_cstring_start_blocking(blocking_callback callback) {
    blocking_fn = callback;
    blocking_result = 0;
    return start_thread(&blocking_thread, blocking_worker, NULL);
}

int32_t ffi_cstring_join_blocking(void) {
    return join_thread(blocking_thread) == 0 ? blocking_result : -1;
}
