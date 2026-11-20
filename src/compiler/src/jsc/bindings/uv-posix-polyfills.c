#include "uv-posix-polyfills.h"

#if OS(LINUX) || OS(DARWIN) || OS(FREEBSD)

#include <pthread.h>
#include <unistd.h>
#include <stdlib.h>

// libuv does the annoying thing of #undef'ing these
#include <errno.h>
#if EDOM > 0
#define UV__ERR(x) (-(x))
#else
#define UV__ERR(x) (x)
#endif

void __bun_throw_not_implemented(const char* symbol_name)
{
    CrashHandler__unsupportedUVFunction(symbol_name);
}

// Internals

uint64_t uv__hrtime(uv_clocktype_t type);
int ct_internal_uv_gettimeofday(uv_timeval64_t* tv);
int ct_internal_uv_async_init(uv_loop_t* loop, uv_async_t* async, uv_async_cb async_cb);
int ct_internal_uv_async_send(uv_async_t* async);
void ct_internal_uv_close(uv_handle_t* handle, uv_close_cb close_cb);
int ct_internal_uv_is_closing(const uv_handle_t* handle);
void ct_internal_uv_sem_destroy(uv_sem_t* sem);
int ct_internal_uv_sem_init(uv_sem_t* sem, unsigned int value);
void ct_internal_uv_sem_post(uv_sem_t* sem);
int ct_internal_uv_sem_trywait(uv_sem_t* sem);
void ct_internal_uv_sem_wait(uv_sem_t* sem);
unsigned int ct_internal_uv_version(void);
const char* ct_internal_uv_version_string(void);

UV_EXTERN int uv_async_init(uv_loop_t* loop, uv_async_t* async, uv_async_cb async_cb)
{
    return ct_internal_uv_async_init(loop, async, async_cb);
}

UV_EXTERN int uv_async_send(uv_async_t* async)
{
    return ct_internal_uv_async_send(async);
}

UV_EXTERN void uv_close(uv_handle_t* handle, uv_close_cb close_cb)
{
    ct_internal_uv_close(handle, close_cb);
}

UV_EXTERN int uv_is_closing(const uv_handle_t* handle)
{
    return ct_internal_uv_is_closing(handle);
}

#if defined(__linux__)
#include "uv-posix-polyfills-linux.c"
// #elif defined(__MVS__)
// #include "uv/os390.h"
// #elif defined(__PASE__) /* __PASE__ and _AIX are both defined on IBM i */
// #include "uv/posix.h" /* IBM i needs uv/posix.h, not uv/aix.h */
// #elif defined(_AIX)
// #include "uv/aix.h"
// #elif defined(__sun)
// #include "uv/sunos.h"
#elif defined(__APPLE__)
#include "uv-posix-polyfills-darwin.c"
#elif defined(__FreeBSD__)
#include "uv-posix-polyfills-posix.c"
#elif defined(__CYGWIN__) || defined(__MSYS__) || defined(__HAIKU__) || defined(__QNX__) || defined(__GNU__)
#include "uv-posix-polyfills-posix.c"
#endif

uv_pid_t uv_os_getpid()
{
    return getpid();
}

uv_pid_t uv_os_getppid()
{
    return getppid();
}

UV_EXTERN void uv_once(uv_once_t* guard, void (*callback)(void))
{
    if (pthread_once(guard, callback))
        abort();
}

UV_EXTERN uint64_t uv_hrtime(void)
{
    return uv__hrtime(UV_CLOCK_PRECISE);
}

UV_EXTERN int uv_gettimeofday(uv_timeval64_t* tv)
{
    return ct_internal_uv_gettimeofday(tv);
}

UV_EXTERN unsigned int uv_version(void)
{
    return ct_internal_uv_version();
}

UV_EXTERN const char* uv_version_string(void)
{
    return ct_internal_uv_version_string();
}

UV_EXTERN void uv_sem_destroy(uv_sem_t* sem)
{
    ct_internal_uv_sem_destroy(sem);
}

UV_EXTERN int uv_sem_init(uv_sem_t* sem, unsigned int value)
{
    return ct_internal_uv_sem_init(sem, value);
}

UV_EXTERN void uv_sem_post(uv_sem_t* sem)
{
    ct_internal_uv_sem_post(sem);
}

UV_EXTERN int uv_sem_trywait(uv_sem_t* sem)
{
    return ct_internal_uv_sem_trywait(sem);
}

UV_EXTERN void uv_sem_wait(uv_sem_t* sem)
{
    ct_internal_uv_sem_wait(sem);
}

// Copy-pasted from libuv
UV_EXTERN void uv_mutex_destroy(uv_mutex_t* mutex)
{
    if (pthread_mutex_destroy(mutex))
        abort();
}

// Copy-pasted from libuv
UV_EXTERN int uv_mutex_init(uv_mutex_t* mutex)
{
    pthread_mutexattr_t attr;
    int err;

    if (pthread_mutexattr_init(&attr))
        abort();

    if (pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_ERRORCHECK))
        abort();

    err = pthread_mutex_init(mutex, &attr);

    if (pthread_mutexattr_destroy(&attr))
        abort();

    return UV__ERR(err);
}

// Copy-pasted from libuv
UV_EXTERN int uv_mutex_init_recursive(uv_mutex_t* mutex)
{
    pthread_mutexattr_t attr;
    int err;

    if (pthread_mutexattr_init(&attr))
        abort();

    if (pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_RECURSIVE))
        abort();

    err = pthread_mutex_init(mutex, &attr);

    if (pthread_mutexattr_destroy(&attr))
        abort();

    return UV__ERR(err);
}

// Copy-pasted from libuv
UV_EXTERN void uv_mutex_lock(uv_mutex_t* mutex)
{
    if (pthread_mutex_lock(mutex))
        abort();
}

// Copy-pasted from libuv
UV_EXTERN int uv_mutex_trylock(uv_mutex_t* mutex)
{
    int err;

    err = pthread_mutex_trylock(mutex);
    if (err) {
        if (err != EBUSY && err != EAGAIN)
            abort();
        return UV_EBUSY;
    }

    return 0;
}

// Copy-pasted from libuv
UV_EXTERN void uv_mutex_unlock(uv_mutex_t* mutex)
{
    if (pthread_mutex_unlock(mutex))
        abort();
}

// Copy-pasted from libuv
UV_EXTERN int uv_rwlock_init(uv_rwlock_t* rwlock)
{
    return UV__ERR(pthread_rwlock_init(rwlock, NULL));
}

// Copy-pasted from libuv
UV_EXTERN void uv_rwlock_destroy(uv_rwlock_t* rwlock)
{
    if (pthread_rwlock_destroy(rwlock))
        abort();
}

// Copy-pasted from libuv
UV_EXTERN void uv_rwlock_rdlock(uv_rwlock_t* rwlock)
{
    if (pthread_rwlock_rdlock(rwlock))
        abort();
}

// Copy-pasted from libuv
UV_EXTERN int uv_rwlock_tryrdlock(uv_rwlock_t* rwlock)
{
    int err;

    err = pthread_rwlock_tryrdlock(rwlock);
    if (err) {
        if (err != EBUSY && err != EAGAIN)
            abort();
        return UV_EBUSY;
    }

    return 0;
}

// Copy-pasted from libuv
UV_EXTERN void uv_rwlock_rdunlock(uv_rwlock_t* rwlock)
{
    if (pthread_rwlock_unlock(rwlock))
        abort();
}

// Copy-pasted from libuv
UV_EXTERN void uv_rwlock_wrlock(uv_rwlock_t* rwlock)
{
    if (pthread_rwlock_wrlock(rwlock))
        abort();
}

// Copy-pasted from libuv
UV_EXTERN int uv_rwlock_trywrlock(uv_rwlock_t* rwlock)
{
    int err;

    err = pthread_rwlock_trywrlock(rwlock);
    if (err) {
        if (err != EBUSY && err != EAGAIN)
            abort();
        return UV_EBUSY;
    }

    return 0;
}

// Copy-pasted from libuv
UV_EXTERN void uv_rwlock_wrunlock(uv_rwlock_t* rwlock)
{
    if (pthread_rwlock_unlock(rwlock))
        abort();
}

#endif
