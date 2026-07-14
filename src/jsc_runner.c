#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif
#if defined(_WIN32) && !defined(WIN32_LEAN_AND_MEAN)
#define WIN32_LEAN_AND_MEAN
#endif

#include "jsc_runner.h"

#include <JavaScriptCore/JavaScript.h>
#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <windns.h>
#include <winioctl.h>
#else
#include <arpa/inet.h>
#endif
#if defined(__APPLE__) || defined(__MACH__)
#include <compression.h>
#else
#include <brotli/decode.h>
#include <brotli/encode.h>
#endif
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#if __has_include(<ffi/ffi.h>)
#include <ffi/ffi.h>
#else
#include <ffi.h>
#endif
#include <fcntl.h>
#if !defined(_WIN32)
#include <grp.h>
#include <ifaddrs.h>
#endif
#include <limits.h>
#include <math.h>
#if !defined(_WIN32)
#include <netdb.h>
#include <net/if.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pwd.h>
#endif
#if defined(_WIN32)
#include <bmalloc/pas_thread.h>
#else
#include <pthread.h>
#endif
#if !defined(_WIN32)
#include <resolv.h>
#endif
#include <signal.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(_WIN32)
#include <direct.h>
#include <io.h>
#include <process.h>
#include <psapi.h>
#include <iphlpapi.h>
#include <tlhelp32.h>
#define chdir _chdir
#define dup2 _dup2
#define getcwd _getcwd
#define open _open
#define O_SYNC 0
#define F_OK 0
#define STDIN_FILENO 0
#define STDOUT_FILENO 1
#define STDERR_FILENO 2
#define strcasecmp _stricmp
#define strncasecmp _strnicmp
#define SHUT_WR SD_SEND
#define SHUT_RDWR SD_BOTH
#define umask _umask
typedef SSIZE_T ssize_t;
typedef long suseconds_t;
typedef int mode_t;
typedef int pid_t;
typedef unsigned int useconds_t;
typedef unsigned int uid_t;
typedef unsigned int gid_t;
#else
#include <strings.h>
#endif
#include "sqlite3_local.h"
#if !defined(_WIN32)
#include <arpa/nameser.h>
#include <sys/socket.h>
#include <sys/resource.h>
#include <sys/mman.h>
#include <sys/un.h>
#endif
#include <sys/stat.h>
#if defined(__APPLE__) || defined(__MACH__)
#include <mach/mach.h>
#include <net/if_dl.h>
#include <sys/mount.h>
#include <sys/sysctl.h>
#elif defined(__linux__)
#include <netpacket/packet.h>
#include <sys/statvfs.h>
#elif !defined(_WIN32)
#include <sys/statvfs.h>
#endif
#if !defined(_WIN32)
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>
#endif
#include <time.h>
#include <zlib.h>

#if defined(_WIN32)
#define environ _environ

#ifndef PTHREAD_MUTEX_INITIALIZER
#define PTHREAD_MUTEX_INITIALIZER SRWLOCK_INIT
#endif
#ifndef PTHREAD_COND_INITIALIZER
#define PTHREAD_COND_INITIALIZER CONDITION_VARIABLE_INIT
#endif

typedef struct {
    void *(*start_routine)(void *);
    void *argument;
} CtWindowsThreadStart;

static unsigned __stdcall ct_windows_thread_entry(void *opaque) {
    CtWindowsThreadStart *start = (CtWindowsThreadStart *)opaque;
    void *(*start_routine)(void *) = start->start_routine;
    void *argument = start->argument;
    free(start);
    (void)start_routine(argument);
    return 0;
}

static int ct_windows_thread_create(
    pthread_t *thread,
    size_t stack_size,
    void *(*start_routine)(void *),
    void *argument
) {
    CtWindowsThreadStart *start = (CtWindowsThreadStart *)malloc(sizeof(*start));
    if (start == NULL) return ENOMEM;
    start->start_routine = start_routine;
    start->argument = argument;
    uintptr_t handle = _beginthreadex(NULL, (unsigned)stack_size, ct_windows_thread_entry, start, 0, NULL);
    if (handle == 0) {
        int error = errno == 0 ? EAGAIN : errno;
        free(start);
        return error;
    }
    *thread = handle;
    return 0;
}

static int ct_windows_thread_detach(pthread_t thread) {
    return CloseHandle((HANDLE)thread) ? 0 : EINVAL;
}

static int ct_windows_thread_join(pthread_t thread, void **result) {
    if (result != NULL) *result = NULL;
    DWORD wait_result = WaitForSingleObject((HANDLE)thread, INFINITE);
    if (wait_result != WAIT_OBJECT_0) return EINVAL;
    return CloseHandle((HANDLE)thread) ? 0 : EINVAL;
}

static int ct_windows_mutex_destroy(pthread_mutex_t *mutex) {
    (void)mutex;
    return 0;
}

static int ct_windows_cond_destroy(pthread_cond_t *cond) {
    (void)cond;
    return 0;
}

static int ct_windows_cond_signal(pthread_cond_t *cond) {
    WakeConditionVariable(cond);
    return 0;
}

#define pthread_create(thread, attr, start, argument) \
    ct_windows_thread_create((thread), 0, (start), (argument))
#define pthread_detach ct_windows_thread_detach
#define pthread_join ct_windows_thread_join
#define pthread_equal(left, right) ((left) == (right))
#define pthread_mutex_destroy ct_windows_mutex_destroy
#define pthread_cond_destroy ct_windows_cond_destroy
#define pthread_cond_signal ct_windows_cond_signal

// Recent MSVC STL headers vectorize std::unique through this runtime entry
// point. JSC may be built with newer headers than the consumer's installed
// toolset, so provide the scalar-equivalent algorithm only when the runtime
// itself does not define it.
void *__stdcall ct_std_unique_8_fallback(void *first_value, void *last_value) {
    uint64_t *first = (uint64_t *)first_value;
    uint64_t *last = (uint64_t *)last_value;
    if (first == last) return first;
    uint64_t *result = first;
    for (uint64_t *current = first + 1; current != last; current++) {
        if (*result != *current) {
            result++;
            *result = *current;
        }
    }
    return result + 1;
}
#pragma comment(linker, "/alternatename:__std_unique_8=ct_std_unique_8_fallback")

struct rusage {
    struct timeval ru_utime;
    struct timeval ru_stime;
    SIZE_T ru_maxrss;
    long ru_ixrss;
    long ru_idrss;
    long ru_isrss;
    long ru_minflt;
    long ru_majflt;
    long ru_nswap;
    long ru_inblock;
    long ru_oublock;
    long ru_msgsnd;
    long ru_msgrcv;
    long ru_nsignals;
    long ru_nvcsw;
    long ru_nivcsw;
};

#define RUSAGE_SELF 0

int unsetenv(const char *name) {
    return _putenv_s(name, "");
}

int setenv(const char *name, const char *value, int overwrite) {
    if (!overwrite && getenv(name) != NULL) return 0;
    return _putenv_s(name, value);
}

static int ct_lstat(const char *path, struct stat *stat_value) {
    if (stat(path, stat_value) != 0) return -1;
    DWORD attributes = GetFileAttributesA(path);
    if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        stat_value->st_mode = (stat_value->st_mode & ~S_IFMT) | S_IFLNK;
    }
    return 0;
}

static ssize_t ct_pread(int fd, void *buffer, size_t length, off_t offset) {
    HANDLE handle = (HANDLE)_get_osfhandle(fd);
    if (handle == INVALID_HANDLE_VALUE) {
        errno = EBADF;
        return -1;
    }
    OVERLAPPED overlapped;
    memset(&overlapped, 0, sizeof(overlapped));
    overlapped.Offset = (DWORD)((uint64_t)offset & 0xffffffffu);
    overlapped.OffsetHigh = (DWORD)((uint64_t)offset >> 32);
    DWORD transferred = 0;
    DWORD amount = length > UINT32_MAX ? UINT32_MAX : (DWORD)length;
    if (!ReadFile(handle, buffer, amount, &transferred, &overlapped)) {
        if (GetLastError() == ERROR_HANDLE_EOF) return 0;
        errno = EIO;
        return -1;
    }
    return (ssize_t)transferred;
}

static ssize_t ct_pwrite(int fd, const void *buffer, size_t length, off_t offset) {
    HANDLE handle = (HANDLE)_get_osfhandle(fd);
    if (handle == INVALID_HANDLE_VALUE) {
        errno = EBADF;
        return -1;
    }
    OVERLAPPED overlapped;
    memset(&overlapped, 0, sizeof(overlapped));
    overlapped.Offset = (DWORD)((uint64_t)offset & 0xffffffffu);
    overlapped.OffsetHigh = (DWORD)((uint64_t)offset >> 32);
    DWORD transferred = 0;
    DWORD amount = length > UINT32_MAX ? UINT32_MAX : (DWORD)length;
    if (!WriteFile(handle, buffer, amount, &transferred, &overlapped)) {
        errno = EIO;
        return -1;
    }
    return (ssize_t)transferred;
}

static int ct_fchmod(int fd, mode_t mode) {
    HANDLE handle = (HANDLE)_get_osfhandle(fd);
    if (handle == INVALID_HANDLE_VALUE) {
        errno = EBADF;
        return -1;
    }
    WCHAR path[32768];
    DWORD length = GetFinalPathNameByHandleW(handle, path, (DWORD)(sizeof(path) / sizeof(path[0])), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (length == 0 || length >= sizeof(path) / sizeof(path[0])) {
        errno = EIO;
        return -1;
    }
    const WCHAR *normalized = wcsncmp(path, L"\\\\?\\", 4) == 0 ? path + 4 : path;
    return _wchmod(normalized, mode);
}

static void ct_windows_filetime_from_timeval(const struct timeval *value, FILETIME *filetime) {
    const uint64_t epoch_delta = 11644473600ULL;
    uint64_t ticks = ((uint64_t)value->tv_sec + epoch_delta) * 10000000ULL + (uint64_t)value->tv_usec * 10ULL;
    filetime->dwLowDateTime = (DWORD)ticks;
    filetime->dwHighDateTime = (DWORD)(ticks >> 32);
}

static int ct_futimes(int fd, const struct timeval times[2]) {
    HANDLE handle = (HANDLE)_get_osfhandle(fd);
    if (handle == INVALID_HANDLE_VALUE) {
        errno = EBADF;
        return -1;
    }
    FILETIME access_time;
    FILETIME modification_time;
    ct_windows_filetime_from_timeval(&times[0], &access_time);
    ct_windows_filetime_from_timeval(&times[1], &modification_time);
    if (!SetFileTime(handle, NULL, &access_time, &modification_time)) {
        errno = EIO;
        return -1;
    }
    return 0;
}

static int ct_utimes(const char *path, const struct timeval times[2]) {
    HANDLE handle = CreateFileA(path, FILE_WRITE_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (handle == INVALID_HANDLE_VALUE) {
        errno = ENOENT;
        return -1;
    }
    FILETIME access_time;
    FILETIME modification_time;
    ct_windows_filetime_from_timeval(&times[0], &access_time);
    ct_windows_filetime_from_timeval(&times[1], &modification_time);
    BOOL ok = SetFileTime(handle, NULL, &access_time, &modification_time);
    CloseHandle(handle);
    if (!ok) {
        errno = EIO;
        return -1;
    }
    return 0;
}

static int ct_truncate(const char *path, off_t length) {
    int fd = _open(path, _O_WRONLY | _O_BINARY);
    if (fd < 0) return -1;
    int status = _chsize_s(fd, length) == 0 ? 0 : -1;
    _close(fd);
    return status;
}

static int ct_unsupported_ownership(void) {
    errno = ENOSYS;
    return -1;
}

static int ct_link(const char *existing_path, const char *new_path) {
    if (CreateHardLinkA(new_path, existing_path, NULL)) return 0;
    errno = EIO;
    return -1;
}

static int ct_symlink(const char *target, const char *path) {
    DWORD attributes = GetFileAttributesA(target);
    DWORD flags = (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0)
        ? SYMBOLIC_LINK_FLAG_DIRECTORY
        : 0;
#if defined(SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE)
    if (CreateSymbolicLinkA(path, target, flags | SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE)) return 0;
#endif
    if (CreateSymbolicLinkA(path, target, flags)) return 0;
    errno = GetLastError() == ERROR_PRIVILEGE_NOT_HELD ? EPERM : EIO;
    return -1;
}

typedef struct {
    DWORD tag;
    WORD data_length;
    WORD reserved;
    union {
        struct {
            WORD substitute_name_offset;
            WORD substitute_name_length;
            WORD print_name_offset;
            WORD print_name_length;
            ULONG flags;
            WCHAR path_buffer[1];
        } symbolic_link;
        struct {
            WORD substitute_name_offset;
            WORD substitute_name_length;
            WORD print_name_offset;
            WORD print_name_length;
            WCHAR path_buffer[1];
        } mount_point;
    } data;
} CtReparseDataBuffer;

static ssize_t ct_readlink(const char *path, char *buffer, size_t capacity) {
    HANDLE handle = CreateFileA(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
                                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (handle == INVALID_HANDLE_VALUE) {
        errno = ENOENT;
        return -1;
    }
    unsigned char storage[MAXIMUM_REPARSE_DATA_BUFFER_SIZE];
    DWORD bytes = 0;
    BOOL ok = DeviceIoControl(handle, FSCTL_GET_REPARSE_POINT, NULL, 0, storage, sizeof(storage), &bytes, NULL);
    CloseHandle(handle);
    if (!ok) {
        errno = EINVAL;
        return -1;
    }
    CtReparseDataBuffer *reparse = (CtReparseDataBuffer *)storage;
    const WCHAR *wide = NULL;
    int wide_len = 0;
    if (reparse->tag == IO_REPARSE_TAG_SYMLINK) {
        wide = reparse->data.symbolic_link.path_buffer + reparse->data.symbolic_link.print_name_offset / sizeof(WCHAR);
        wide_len = reparse->data.symbolic_link.print_name_length / sizeof(WCHAR);
    } else if (reparse->tag == IO_REPARSE_TAG_MOUNT_POINT) {
        wide = reparse->data.mount_point.path_buffer + reparse->data.mount_point.print_name_offset / sizeof(WCHAR);
        wide_len = reparse->data.mount_point.print_name_length / sizeof(WCHAR);
    } else {
        errno = EINVAL;
        return -1;
    }
    int required = WideCharToMultiByte(CP_UTF8, 0, wide, wide_len, NULL, 0, NULL, NULL);
    if (required < 0) {
        errno = EILSEQ;
        return -1;
    }
    if ((size_t)required > capacity) return (ssize_t)capacity;
    int written = WideCharToMultiByte(CP_UTF8, 0, wide, wide_len, buffer, (int)capacity, NULL, NULL);
    if (written <= 0 && wide_len > 0) {
        errno = EILSEQ;
        return -1;
    }
    return written;
}

static char *ct_realpath(const char *path, char *resolved) {
    return _fullpath(resolved, path, resolved != NULL ? PATH_MAX : 0);
}

static void ct_usleep(unsigned long usec) {
    Sleep((DWORD)((usec + 999) / 1000));
}

static int ct_clock_gettime(int clock_id, struct timespec *value) {
    if (clock_id == 0) {
        FILETIME file_time;
        ULARGE_INTEGER ticks;
        GetSystemTimePreciseAsFileTime(&file_time);
        ticks.LowPart = file_time.dwLowDateTime;
        ticks.HighPart = file_time.dwHighDateTime;
        const uint64_t unix_ticks = ticks.QuadPart - 116444736000000000ULL;
        value->tv_sec = (time_t)(unix_ticks / 10000000ULL);
        value->tv_nsec = (long)((unix_ticks % 10000000ULL) * 100ULL);
        return 0;
    }
    LARGE_INTEGER frequency;
    LARGE_INTEGER counter;
    if (!QueryPerformanceFrequency(&frequency) || !QueryPerformanceCounter(&counter)) {
        errno = EINVAL;
        return -1;
    }
    value->tv_sec = (time_t)(counter.QuadPart / frequency.QuadPart);
    value->tv_nsec = (long)(((counter.QuadPart % frequency.QuadPart) * 1000000000LL) / frequency.QuadPart);
    return 0;
}

static int ct_windows_socket_errno(void);

static int ct_setsockopt(SOCKET socket, int level, int option, const void *value, int length) {
    int result = setsockopt(socket, level, option, (const char *)value, length);
    if (result == SOCKET_ERROR) errno = ct_windows_socket_errno();
    return result;
}

static int ct_getsockopt(SOCKET socket, int level, int option, void *value, int *length) {
    int result = getsockopt(socket, level, option, (char *)value, length);
    if (result == SOCKET_ERROR) errno = ct_windows_socket_errno();
    return result;
}

static int ct_windows_socket_errno(void) {
    int error = WSAGetLastError();
    switch (error) {
        case WSANOTINITIALISED: return ENETDOWN;
        case WSAEINVAL: return EINVAL;
        case WSAEINTR: return EINTR;
        case WSAEWOULDBLOCK: return EWOULDBLOCK;
        case WSAEINPROGRESS: return EINPROGRESS;
        case WSAEALREADY: return EALREADY;
        case WSAENOTSOCK: return ENOTSOCK;
        case WSAEDESTADDRREQ: return EDESTADDRREQ;
        case WSAEMSGSIZE: return EMSGSIZE;
        case WSAEPROTOTYPE: return EPROTOTYPE;
        case WSAENOPROTOOPT: return ENOPROTOOPT;
        case WSAEPROTONOSUPPORT: return EPROTONOSUPPORT;
        case WSAEOPNOTSUPP: return EOPNOTSUPP;
        case WSAEAFNOSUPPORT: return EAFNOSUPPORT;
        case WSAEADDRINUSE: return EADDRINUSE;
        case WSAEADDRNOTAVAIL: return EADDRNOTAVAIL;
        case WSAENETDOWN: return ENETDOWN;
        case WSAENETUNREACH: return ENETUNREACH;
        case WSAECONNABORTED: return ECONNABORTED;
        case WSAECONNRESET: return ECONNRESET;
        case WSAENOBUFS: return ENOBUFS;
        case WSAEISCONN: return EISCONN;
        case WSAENOTCONN: return ENOTCONN;
        case WSAESHUTDOWN: return EPIPE;
        case WSAETIMEDOUT: return ETIMEDOUT;
        case WSAECONNREFUSED: return ECONNREFUSED;
        case WSAEHOSTUNREACH: return EHOSTUNREACH;
        default: return EIO;
    }
}

static SOCKET ct_windows_socket_from_fd(int fd) {
    return (SOCKET)(uintptr_t)(uint32_t)fd;
}

static INIT_ONCE ct_winsock_once = INIT_ONCE_STATIC_INIT;
static int ct_winsock_status = WSANOTINITIALISED;

static BOOL CALLBACK ct_windows_initialize_winsock(PINIT_ONCE once, PVOID parameter, PVOID *context) {
    (void)once;
    (void)parameter;
    (void)context;
    WSADATA data;
    ct_winsock_status = WSAStartup(MAKEWORD(2, 2), &data);
    return TRUE;
}

static int ct_windows_ensure_winsock(void) {
    if (!InitOnceExecuteOnce(&ct_winsock_once, ct_windows_initialize_winsock, NULL, NULL)) return EIO;
    return ct_winsock_status == 0 ? 0 : ENETDOWN;
}

static int ct_windows_socket_create(int family, int type, int protocol) {
    int startup_error = ct_windows_ensure_winsock();
    if (startup_error != 0) {
        errno = startup_error;
        return -1;
    }
    SOCKET socket_value = socket(family, type, protocol);
    if (socket_value == INVALID_SOCKET) {
        errno = ct_windows_socket_errno();
        return -1;
    }
    return (int)(uint32_t)(uintptr_t)socket_value;
}

static int ct_windows_accept(int fd, struct sockaddr *address, int *address_length) {
    SOCKET accepted = accept(ct_windows_socket_from_fd(fd), address, address_length);
    if (accepted == INVALID_SOCKET) {
        errno = ct_windows_socket_errno();
        return -1;
    }
    return (int)(uint32_t)(uintptr_t)accepted;
}

static int ct_windows_bind(int fd, const struct sockaddr *address, int address_length) {
    int result = bind(ct_windows_socket_from_fd(fd), address, address_length);
    if (result == SOCKET_ERROR) errno = ct_windows_socket_errno();
    return result;
}

static int ct_windows_connect(int fd, const struct sockaddr *address, int address_length) {
    int result = connect(ct_windows_socket_from_fd(fd), address, address_length);
    if (result == SOCKET_ERROR) errno = ct_windows_socket_errno();
    return result;
}

static int ct_windows_getpeername(int fd, struct sockaddr *address, int *address_length) {
    int result = getpeername(ct_windows_socket_from_fd(fd), address, address_length);
    if (result == SOCKET_ERROR) errno = ct_windows_socket_errno();
    return result;
}

static int ct_windows_getsockname(int fd, struct sockaddr *address, int *address_length) {
    int result = getsockname(ct_windows_socket_from_fd(fd), address, address_length);
    if (result == SOCKET_ERROR) errno = ct_windows_socket_errno();
    return result;
}

static int ct_windows_listen(int fd, int backlog) {
    int result = listen(ct_windows_socket_from_fd(fd), backlog);
    if (result == SOCKET_ERROR) errno = ct_windows_socket_errno();
    return result;
}

static int ct_windows_poll(WSAPOLLFD *fds, ULONG count, int timeout) {
    int result = WSAPoll(fds, count, timeout);
    if (result == SOCKET_ERROR) errno = ct_windows_socket_errno();
    return result;
}

static int ct_windows_recv(int fd, char *buffer, int length, int flags) {
    int result = recv(ct_windows_socket_from_fd(fd), buffer, length, flags);
    if (result == SOCKET_ERROR) errno = ct_windows_socket_errno();
    return result;
}

static int ct_windows_recvfrom(int fd, char *buffer, int length, int flags, struct sockaddr *address, int *address_length) {
    int result = recvfrom(ct_windows_socket_from_fd(fd), buffer, length, flags, address, address_length);
    if (result == SOCKET_ERROR) errno = ct_windows_socket_errno();
    return result;
}

static int ct_windows_send(int fd, const char *buffer, int length, int flags) {
    int result = send(ct_windows_socket_from_fd(fd), buffer, length, flags);
    if (result == SOCKET_ERROR) errno = ct_windows_socket_errno();
    return result;
}

static int ct_windows_sendto(int fd, const char *buffer, int length, int flags, const struct sockaddr *address, int address_length) {
    int result = sendto(ct_windows_socket_from_fd(fd), buffer, length, flags, address, address_length);
    if (result == SOCKET_ERROR) errno = ct_windows_socket_errno();
    return result;
}

static int ct_windows_shutdown(int fd, int how) {
    int result = shutdown(ct_windows_socket_from_fd(fd), how);
    if (result == SOCKET_ERROR) errno = ct_windows_socket_errno();
    return result;
}

static bool ct_windows_is_socket(int fd) {
    if (fd < 0) return false;
    int socket_type = 0;
    int length = sizeof(socket_type);
    int previous_error = WSAGetLastError();
    bool is_socket = getsockopt(ct_windows_socket_from_fd(fd), SOL_SOCKET, SO_TYPE, (char *)&socket_type, &length) == 0;
    WSASetLastError(previous_error);
    return is_socket;
}

static int ct_windows_close(int fd) {
    if (ct_windows_is_socket(fd)) {
        int result = closesocket(ct_windows_socket_from_fd(fd));
        if (result != 0) errno = ct_windows_socket_errno();
        return result;
    }
    return _close(fd);
}

static ssize_t ct_windows_read(int fd, void *buffer, size_t length) {
    if (!ct_windows_is_socket(fd)) return _read(fd, buffer, length > UINT_MAX ? UINT_MAX : (unsigned int)length);
    int result = recv(ct_windows_socket_from_fd(fd), (char *)buffer, length > INT_MAX ? INT_MAX : (int)length, 0);
    if (result == SOCKET_ERROR) {
        errno = ct_windows_socket_errno();
        return -1;
    }
    return result;
}

static ssize_t ct_windows_write(int fd, const void *buffer, size_t length) {
    if (!ct_windows_is_socket(fd)) return _write(fd, buffer, length > UINT_MAX ? UINT_MAX : (unsigned int)length);
    int result = send(ct_windows_socket_from_fd(fd), (const char *)buffer, length > INT_MAX ? INT_MAX : (int)length, 0);
    if (result == SOCKET_ERROR) {
        errno = ct_windows_socket_errno();
        return -1;
    }
    return result;
}

static int ct_windows_descriptor_read_ready(int fd) {
    if (ct_windows_is_socket(fd)) {
        SOCKET socket_value = ct_windows_socket_from_fd(fd);
        fd_set read_fds;
        fd_set error_fds;
        FD_ZERO(&read_fds);
        FD_ZERO(&error_fds);
        FD_SET(socket_value, &read_fds);
        FD_SET(socket_value, &error_fds);
        struct timeval timeout = { 0, 0 };
        int result = select(0, &read_fds, NULL, &error_fds, &timeout);
        if (result == SOCKET_ERROR) {
            errno = ct_windows_socket_errno();
            return -1;
        }
        return result;
    }
    intptr_t raw_handle = _get_osfhandle(fd);
    if (raw_handle == -1) {
        errno = EBADF;
        return -1;
    }
    HANDLE handle = (HANDLE)raw_handle;
    if (GetFileType(handle) == FILE_TYPE_PIPE) {
        DWORD available = 0;
        if (PeekNamedPipe(handle, NULL, 0, NULL, &available, NULL)) return available > 0 ? 1 : 0;
        DWORD error = GetLastError();
        if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) return 1;
        errno = EIO;
        return -1;
    }
    if (GetFileType(handle) == FILE_TYPE_DISK) return 1;
    DWORD wait_result = WaitForSingleObject(handle, 0);
    if (wait_result == WAIT_OBJECT_0) return 1;
    if (wait_result == WAIT_TIMEOUT) return 0;
    errno = EIO;
    return -1;
}

static int ct_kill(pid_t pid, int signal_number) {
    HANDLE process = OpenProcess(signal_number == 0 ? PROCESS_QUERY_LIMITED_INFORMATION : PROCESS_TERMINATE, FALSE, (DWORD)pid);
    if (process == NULL) {
        errno = GetLastError() == ERROR_ACCESS_DENIED ? EPERM : ESRCH;
        return -1;
    }
    BOOL ok = signal_number == 0 || TerminateProcess(process, (UINT)signal_number);
    CloseHandle(process);
    if (!ok) {
        errno = EPERM;
        return -1;
    }
    return 0;
}

static pid_t ct_getppid(void) {
    DWORD current_pid = GetCurrentProcessId();
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32 entry;
    memset(&entry, 0, sizeof(entry));
    entry.dwSize = sizeof(entry);
    pid_t parent_pid = 0;
    if (Process32First(snapshot, &entry)) {
        do {
            if (entry.th32ProcessID == current_pid) {
                parent_pid = (pid_t)entry.th32ParentProcessID;
                break;
            }
        } while (Process32Next(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return parent_pid;
}

static int ct_getrusage(int who, struct rusage *usage) {
    (void)who;
    memset(usage, 0, sizeof(*usage));
    FILETIME creation_time;
    FILETIME exit_time;
    FILETIME kernel_time;
    FILETIME user_time;
    if (!GetProcessTimes(GetCurrentProcess(), &creation_time, &exit_time, &kernel_time, &user_time)) return -1;
    ULARGE_INTEGER kernel;
    ULARGE_INTEGER user;
    kernel.LowPart = kernel_time.dwLowDateTime;
    kernel.HighPart = kernel_time.dwHighDateTime;
    user.LowPart = user_time.dwLowDateTime;
    user.HighPart = user_time.dwHighDateTime;
    usage->ru_stime.tv_sec = (long)(kernel.QuadPart / 10000000ULL);
    usage->ru_stime.tv_usec = (long)((kernel.QuadPart % 10000000ULL) / 10ULL);
    usage->ru_utime.tv_sec = (long)(user.QuadPart / 10000000ULL);
    usage->ru_utime.tv_usec = (long)((user.QuadPart % 10000000ULL) / 10ULL);
    PROCESS_MEMORY_COUNTERS memory;
    memset(&memory, 0, sizeof(memory));
    memory.cb = sizeof(memory);
    if (GetProcessMemoryInfo(GetCurrentProcess(), &memory, sizeof(memory))) usage->ru_maxrss = memory.PeakWorkingSetSize;
    return 0;
}

#define getppid ct_getppid
#define getpid _getpid
#define getrusage ct_getrusage
#define accept ct_windows_accept
#define bind ct_windows_bind
#define close ct_windows_close
#define connect ct_windows_connect
#define getpeername ct_windows_getpeername
#define getsockopt ct_getsockopt
#define getsockname ct_windows_getsockname
#define kill ct_kill
#define lstat ct_lstat
#define pread ct_pread
#define pwrite ct_pwrite
#define read ct_windows_read
#define fsync _commit
#define fdatasync _commit
#define ftruncate(fd, length) (_chsize_s((fd), (length)) == 0 ? 0 : -1)
#define fchmod ct_fchmod
#define fchown(fd, uid, gid) ct_unsupported_ownership()
#define chown(path, uid, gid) ct_unsupported_ownership()
#define lchown(path, uid, gid) ct_unsupported_ownership()
#define futimes ct_futimes
#define truncate ct_truncate
#define utimes ct_utimes
#define link ct_link
#define symlink ct_symlink
#define readlink ct_readlink
#define listen ct_windows_listen
#define poll ct_windows_poll
#define realpath ct_realpath
#define recv ct_windows_recv
#define recvfrom ct_windows_recvfrom
#define send ct_windows_send
#define sendto ct_windows_sendto
#define setsockopt ct_setsockopt
#define shutdown ct_windows_shutdown
#define socket ct_windows_socket_create
#define usleep ct_usleep
#define write ct_windows_write
#define CLOCK_REALTIME 0
#define CLOCK_MONOTONIC 1
#define clock_gettime ct_clock_gettime
#else
extern char **environ;
#endif

extern uint8_t *ct_markdown_render_html(const uint8_t *source_ptr, size_t source_len, uint64_t flags, size_t *output_len, char **error_out);
extern uint8_t *ct_markdown_parse_events(const uint8_t *source_ptr, size_t source_len, uint64_t flags, size_t *output_len, char **error_out);
extern void ct_markdown_free(uint8_t *ptr, size_t len);
extern void ct_markdown_string_free(char *ptr);

#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>
#include <CommonCrypto/CommonCryptor.h>
#include <CommonCrypto/CommonHMAC.h>
#include <mach-o/dyld.h>
extern void JSSynchronousGarbageCollectForDebugging(JSContextRef ctx);
extern JSObjectRef JSGetMemoryUsageStatistics(JSContextRef ctx);
#endif

#if __has_include(<openssl/evp.h>) && __has_include(<openssl/kdf.h>) && __has_include(<openssl/ssl.h>) && __has_include(<openssl/err.h>)
#define CT_HAS_OPENSSL 1
#include <openssl/core_names.h>
#include <openssl/ec.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/kdf.h>
#include <openssl/params.h>
#include <openssl/pem.h>
#include <openssl/rsa.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>
#if __has_include(<openssl/thread.h>)
#include <openssl/thread.h>
#endif
#else
#define CT_HAS_OPENSSL 0
#endif

#if defined(__APPLE__)
#define CT_PLATFORM_STRING "darwin"
#elif defined(__linux__)
#define CT_PLATFORM_STRING "linux"
#elif defined(_WIN32)
#define CT_PLATFORM_STRING "win32"
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

static int ct_get_bytes(JSContextRef ctx, JSValueRef value, uint8_t **out_data, size_t *out_len);
static void ct_queue_fd_data(CtJscRuntime *runtime, uint32_t id, const char *data, size_t data_len);
static void ct_queue_fd_simple(CtJscRuntime *runtime, uint32_t id, const char *type, const char *message);

#if defined(__APPLE__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static unsigned char *ct_cc_md5(const void *data, CC_LONG len, unsigned char *md) {
    return CC_MD5(data, len, md);
}
#pragma clang diagnostic pop
#endif

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
    bool input_present;
    const uint8_t *input_ptr;
    size_t input_len;
} CtHostSpawnOptions;

typedef struct {
    int exit_code;
    int signal_code;
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
extern int ct_host_rmdir(const char *path, char **error_out);
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
extern uint8_t *ct_strip_typescript_types(
    const uint8_t *source,
    size_t source_len,
    int mode,
    size_t *out_len,
    char **error_out
);
extern uint8_t *ct_transpiler_process(
    int operation,
    const uint8_t *source,
    size_t source_len,
    const uint8_t *options,
    size_t options_len,
    const uint8_t *loader,
    size_t loader_len,
    size_t *out_len,
    char **error_out
);
extern void ct_transpiler_free(uint8_t *value, size_t len);
extern void ct_transpiler_string_free(char *value);
extern uint8_t *ct_bundle_entry_point_options(
    const uint8_t *entry,
    size_t entry_len,
    const uint8_t *working_dir,
    size_t working_dir_len,
    const uint8_t *options,
    size_t options_len,
    size_t *out_len,
    char **error_out
);
extern void ct_bundle_free(uint8_t *value, size_t len);
extern void ct_bundle_string_free(char *value);
extern uint8_t *ct_password_hash(
    int algorithm,
    const uint8_t *password,
    size_t password_len,
    uint32_t time_cost,
    uint32_t memory_cost,
    uint8_t bcrypt_cost,
    size_t *out_len,
    char **error_out
);
extern int ct_password_verify(
    int algorithm,
    const uint8_t *password,
    size_t password_len,
    const uint8_t *hash,
    size_t hash_len,
    char **error_out
);
extern int ct_crypto_argon2(
    int algorithm,
    const uint8_t *message,
    size_t message_len,
    const uint8_t *nonce,
    size_t nonce_len,
    uint32_t parallelism,
    uint32_t memory,
    uint32_t passes,
    const uint8_t *secret,
    size_t secret_len,
    const uint8_t *associated_data,
    size_t associated_data_len,
    uint8_t *output,
    size_t output_len,
    char **error_out
);
extern uint64_t ct_hash_value(int algorithm, const uint8_t *input, size_t input_len, uint64_t seed);

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
    CT_FFI_TYPE_NAPI_ENV,
    CT_FFI_TYPE_NAPI_VALUE,
} CtFfiType;

static _Thread_local JSContextRef ct_active_napi_context = NULL;

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
    int received_fd;
    bool has_fd;
    int exit_code;
    int signal_code;
    bool killed;
    struct rusage resource_usage;
    bool has_resource_usage;
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

typedef struct CtSharedBuffer {
    uint32_t id;
    uint8_t *bytes;
    size_t byte_len;
    uint32_t refs;
    struct CtSharedBuffer *next;
} CtSharedBuffer;

typedef struct CtAtomicWaiter {
    void *ptr;
    bool notified;
    struct CtAtomicWaiter *next;
} CtAtomicWaiter;

typedef struct CtWorkerMessage {
    char *json;
    struct CtWorkerMessage *next;
} CtWorkerMessage;

typedef struct CtWorkerEvent {
    uint32_t worker_id;
    char *type;
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
    int ipc_fd;
    CtJscRuntime *runtime;
    pthread_t thread;
#if defined(_WIN32)
    HANDLE process_handle;
#endif
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
static pthread_mutex_t ct_shared_buffers_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t ct_shared_buffers_cond = PTHREAD_COND_INITIALIZER;
static CtSharedBuffer *ct_shared_buffers = NULL;
static CtAtomicWaiter *ct_atomic_waiters = NULL;
static uint32_t ct_next_shared_buffer_id = 1;

typedef struct CtHttpRequest {
    uint32_t id;
    int client_fd;
    char *method;
    char *url;
    char *headers_text;
    char *body;
    size_t body_len;
    bool keep_alive;
    bool ready;
    bool claimed;
    bool completed;
    bool response_started;
    bool response_streaming;
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
    char *unix_path;
    bool stopped;
    pthread_t thread;
    pthread_mutex_t mutex;
    pthread_cond_t clients_cond;
    size_t active_clients;
    CtHttpRequest *requests;
    struct CtHttpServer *next;
} CtHttpServer;

typedef struct CtHttpClientTask {
    CtHttpServer *server;
    CtHttpRequest *request;
} CtHttpClientTask;

typedef struct CtHttpReadBuffer {
    char *data;
    size_t len;
    size_t capacity;
} CtHttpReadBuffer;

typedef struct CtTlsConnection {
    uint32_t id;
    int fd;
#if CT_HAS_OPENSSL
    SSL_CTX *ctx;
    SSL *ssl;
#else
    void *ctx;
    void *ssl;
#endif
    CtJscRuntime *runtime;
    pthread_t thread;
    pthread_mutex_t mutex;
    bool active;
    bool watcher_started;
    bool server_side;
    struct CtTlsConnection *next;
} CtTlsConnection;

typedef struct CtTlsAccepted {
    CtTlsConnection *connection;
    struct CtTlsAccepted *next;
} CtTlsAccepted;

typedef struct CtTlsServer {
    uint32_t id;
    int listen_fd;
    uint16_t port;
    char *hostname;
    bool stopped;
    bool thread_started;
    pthread_t thread;
    pthread_mutex_t mutex;
    CtJscRuntime *runtime;
    CtTlsAccepted *accepted_head;
    CtTlsAccepted *accepted_tail;
#if CT_HAS_OPENSSL
    SSL_CTX *ctx;
#else
    void *ctx;
#endif
    struct CtTlsServer *next;
} CtTlsServer;

typedef struct CtSqliteStmt CtSqliteStmt;
typedef struct CtSqliteSession CtSqliteSession;
typedef struct CtCryptoCipher CtCryptoCipher;
typedef struct CtSqliteFunction CtSqliteFunction;
typedef int (*CtSqliteEnableLoadExtensionFn)(sqlite3 *, int);
typedef int (*CtSqliteLoadExtensionFn)(sqlite3 *, const char *, const char *, char **);

typedef struct CtSqliteDb {
    uint32_t id;
    sqlite3 *db;
    CtSqliteStmt *statements;
    CtSqliteSession *sessions;
    CtSqliteFunction *authorizer;
    bool allow_load_extension;
    bool load_extension_enabled;
    struct CtSqliteDb *next;
} CtSqliteDb;

struct CtSqliteStmt {
    uint32_t id;
    sqlite3_stmt *stmt;
    CtSqliteDb *owner;
    CtSqliteStmt *owner_next;
    CtSqliteStmt *next;
};

struct CtSqliteSession {
    uint32_t id;
    sqlite3_session *session;
    CtSqliteDb *owner;
    CtSqliteSession *owner_next;
    CtSqliteSession *next;
};

struct CtCryptoCipher {
    uint32_t id;
#if defined(__APPLE__)
    CCCryptorRef cryptor;
#else
    void *cryptor;
#endif
#if CT_HAS_OPENSSL
    EVP_CIPHER_CTX *evp_cipher;
    bool evp_aead;
    bool evp_encrypt;
    bool evp_finalized;
    uint8_t evp_auth_tag[16];
    size_t evp_auth_tag_len;
#endif
    struct CtCryptoCipher *next;
};

struct CtSqliteFunction {
    JSContextRef ctx;
    JSObjectRef callback;
    JSObjectRef result_callback;
    JSObjectRef start_callback;
    JSObjectRef inverse_callback;
    JSValueRef start_value;
    bool has_start_value;
};

typedef struct CtSqliteAggregateState {
    bool initialized;
    JSValueRef accumulator;
    char *error_message;
} CtSqliteAggregateState;

typedef struct CtSqliteApplyCallbacks {
    JSContextRef ctx;
    JSObjectRef filter;
    JSObjectRef conflict;
    char *error_message;
} CtSqliteApplyCallbacks;

static pthread_mutex_t ct_http_servers_mutex = PTHREAD_MUTEX_INITIALIZER;
static CtHttpServer *ct_http_servers = NULL;
static uint32_t ct_next_http_server_id = 1;
static uint32_t ct_next_http_request_id = 1;
static pthread_mutex_t ct_tls_mutex = PTHREAD_MUTEX_INITIALIZER;
static CtTlsServer *ct_tls_servers = NULL;
static CtTlsConnection *ct_tls_connections = NULL;
static uint32_t ct_next_tls_server_id = 1;
static uint32_t ct_next_tls_connection_id = 1;
static CtSqliteDb *ct_sqlite_dbs = NULL;
static CtSqliteStmt *ct_sqlite_stmts = NULL;
static CtSqliteSession *ct_sqlite_sessions = NULL;
static uint32_t ct_next_sqlite_db_id = 1;
static uint32_t ct_next_sqlite_stmt_id = 1;
static uint32_t ct_next_sqlite_session_id = 1;
static CtCryptoCipher *ct_crypto_ciphers = NULL;
static uint32_t ct_next_crypto_cipher_id = 1;

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
static int ct_jsc_runtime_has_active_handles(CtJscRuntime *runtime, bool *has_active_handles_out, char **error_out);
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

static void ct_http_clear_request(CtHttpRequest *request) {
    free(request->method);
    request->method = NULL;
    free(request->url);
    request->url = NULL;
    free(request->headers_text);
    request->headers_text = NULL;
    free(request->body);
    request->body = NULL;
    request->body_len = 0;
    free(request->response_headers_text);
    request->response_headers_text = NULL;
    free(request->response_body);
    request->response_body = NULL;
    request->response_body_len = 0;
    request->keep_alive = false;
    request->ready = false;
    request->claimed = false;
    request->completed = false;
    request->response_started = false;
    request->response_streaming = false;
    request->status = 200;
}

static void ct_http_free_request(CtHttpRequest *request) {
    if (request == NULL) return;
    if (request->client_fd >= 0) close(request->client_fd);
    ct_http_clear_request(request);
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

static bool ct_http_is_token_char(unsigned char value) {
    if ((value >= '0' && value <= '9') ||
        (value >= 'A' && value <= 'Z') ||
        (value >= 'a' && value <= 'z')) return true;
    switch (value) {
        case '!': case '#': case '$': case '%': case '&': case '\'': case '*': case '+':
        case '-': case '.': case '^': case '_': case '`': case '|': case '~': return true;
        default: return false;
    }
}

static bool ct_http_valid_request_target(const char *method, size_t method_len, const char *target, size_t target_len) {
    if (target_len == 0) return false;
    for (size_t index = 0; index < target_len; index += 1) {
        unsigned char value = (unsigned char)target[index];
        if (value <= 0x20 || value == 0x7f || value == '^' || value == '\\') return false;
    }
    if (target[0] == '/' || (target_len == 1 && target[0] == '*')) return true;
    if (target_len >= 7 && strncasecmp(target, "http://", 7) == 0) return true;
    if (target_len >= 8 && strncasecmp(target, "https://", 8) == 0) return true;
    return method_len == 7 && strncasecmp(method, "CONNECT", 7) == 0 && memchr(target, ':', target_len) != NULL;
}

static int ct_http_parse_transfer_encoding_value(
    const char *value,
    const char *value_end,
    bool *saw_any,
    bool *saw_chunked
) {
    const char *cursor = value;
    while (cursor < value_end) {
        while (cursor < value_end && (*cursor == ' ' || *cursor == '\t')) cursor += 1;
        const char *token = cursor;
        while (cursor < value_end && *cursor != ',') cursor += 1;
        const char *token_end = cursor;
        while (token_end > token && (token_end[-1] == ' ' || token_end[-1] == '\t')) token_end -= 1;
        if (token == token_end || *saw_chunked) return -1;
        for (const char *item = token; item < token_end; item += 1) {
            if (!ct_http_is_token_char((unsigned char)*item)) return -1;
        }
        *saw_any = true;
        if ((size_t)(token_end - token) == 7 && strncasecmp(token, "chunked", 7) == 0) {
            *saw_chunked = true;
        }
        if (cursor < value_end) cursor += 1;
    }
    return 0;
}

static bool ct_http_header_value_has_token(const char *value, const char *value_end, const char *expected) {
    size_t expected_len = strlen(expected);
    const char *cursor = value;
    while (cursor < value_end) {
        while (cursor < value_end && (*cursor == ' ' || *cursor == '\t' || *cursor == ',')) cursor += 1;
        const char *token = cursor;
        while (cursor < value_end && *cursor != ',') cursor += 1;
        const char *token_end = cursor;
        while (token_end > token && (token_end[-1] == ' ' || token_end[-1] == '\t')) token_end -= 1;
        if ((size_t)(token_end - token) == expected_len && strncasecmp(token, expected, expected_len) == 0) return true;
    }
    return false;
}

static int ct_http_parse_head(
    const char *buffer,
    size_t header_len,
    size_t *out_content_len,
    bool *out_chunked,
    bool *out_keep_alive
) {
    const char *head_end = buffer + header_len;
    const char *request_line_end = strstr(buffer, "\r\n");
    if (request_line_end == NULL || request_line_end >= head_end) return -1;

    const char *first_space = memchr(buffer, ' ', (size_t)(request_line_end - buffer));
    if (first_space == NULL || first_space == buffer) return -1;
    const char *second_space = memchr(first_space + 1, ' ', (size_t)(request_line_end - first_space - 1));
    if (second_space == NULL || second_space == first_space + 1) return -1;
    if (memchr(second_space + 1, ' ', (size_t)(request_line_end - second_space - 1)) != NULL) return -1;

    size_t method_len = (size_t)(first_space - buffer);
    for (size_t index = 0; index < method_len; index += 1) {
        if (!ct_http_is_token_char((unsigned char)buffer[index])) return -1;
    }
    size_t target_len = (size_t)(second_space - first_space - 1);
    if (!ct_http_valid_request_target(buffer, method_len, first_space + 1, target_len)) return -1;

    const char *version = second_space + 1;
    size_t version_len = (size_t)(request_line_end - version);
    bool http_11 = version_len == 8 && memcmp(version, "HTTP/1.1", 8) == 0;
    bool http_10 = version_len == 8 && memcmp(version, "HTTP/1.0", 8) == 0;
    if (!http_11 && !http_10) return -1;

    bool has_host = false;
    bool has_content_length = false;
    bool has_transfer_encoding = false;
    bool saw_chunked = false;
    bool connection_close = false;
    bool connection_keep_alive = false;
    size_t content_len = 0;
    const char *cursor = request_line_end + 2;
    while (cursor < head_end) {
        const char *line_end = memchr(cursor, '\n', (size_t)(head_end - cursor));
        if (line_end == NULL || line_end == cursor || line_end[-1] != '\r') return -1;
        size_t line_len = (size_t)(line_end - cursor - 1);
        if (line_len == 0) break;
        if (memchr(cursor, '\r', line_len) != NULL || memchr(cursor, '\n', line_len) != NULL) return -1;

        const char *colon = memchr(cursor, ':', line_len);
        if (colon == NULL || colon == cursor) return -1;
        size_t name_len = (size_t)(colon - cursor);
        for (size_t index = 0; index < name_len; index += 1) {
            if (!ct_http_is_token_char((unsigned char)cursor[index])) return -1;
        }

        const char *value = colon + 1;
        const char *value_end = cursor + line_len;
        while (value < value_end && (*value == ' ' || *value == '\t')) value += 1;
        while (value_end > value && (value_end[-1] == ' ' || value_end[-1] == '\t')) value_end -= 1;
        for (const char *item = value; item < value_end; item += 1) {
            unsigned char byte = (unsigned char)*item;
            if ((byte < 0x20 && byte != '\t') || byte == 0x7f) return -1;
        }

        if (name_len == 4 && strncasecmp(cursor, "host", 4) == 0) {
            if (value == value_end) return -1;
            has_host = true;
        } else if (name_len == 14 && strncasecmp(cursor, "content-length", 14) == 0) {
            if (value == value_end) return -1;
            size_t parsed = 0;
            for (const char *item = value; item < value_end; item += 1) {
                if (*item < '0' || *item > '9') return -1;
                size_t digit = (size_t)(*item - '0');
                if (parsed > (SIZE_MAX - digit) / 10) return -1;
                parsed = parsed * 10 + digit;
            }
            if (parsed > 1024 * 1024) return -1;
            if (has_content_length && parsed != content_len) return -1;
            has_content_length = true;
            content_len = parsed;
        } else if (name_len == 17 && strncasecmp(cursor, "transfer-encoding", 17) == 0) {
            if (ct_http_parse_transfer_encoding_value(
                    value,
                    value_end,
                    &has_transfer_encoding,
                    &saw_chunked
                ) != 0) return -1;
        } else if (name_len == 10 && strncasecmp(cursor, "connection", 10) == 0) {
            connection_close = connection_close || ct_http_header_value_has_token(value, value_end, "close");
            connection_keep_alive = connection_keep_alive || ct_http_header_value_has_token(value, value_end, "keep-alive");
        }
        cursor = line_end + 1;
    }

    if (http_11 && !has_host) return -1;
    if (has_transfer_encoding && has_content_length) return -1;
    if (has_transfer_encoding && !saw_chunked) return -1;
    *out_content_len = content_len;
    *out_chunked = saw_chunked;
    *out_keep_alive = http_11 ? !connection_close : connection_keep_alive;
    return 0;
}

static const char *ct_http_find_crlf(const char *data, size_t len) {
    for (size_t index = 1; index < len; index += 1) {
        if (data[index - 1] == '\r' && data[index] == '\n') return data + index - 1;
        if (data[index] == '\n' && data[index - 1] != '\r') return (const char *)-1;
    }
    return NULL;
}

static int ct_http_decode_chunked(
    const char *data,
    size_t len,
    char **out_body,
    size_t *out_body_len,
    size_t *out_consumed
) {
    size_t position = 0;
    size_t decoded_len = 0;
    char *decoded = (char *)malloc(len > 0 ? len : 1);
    if (decoded == NULL) return -1;

    while (true) {
        const char *line_end = ct_http_find_crlf(data + position, len - position);
        if (line_end == (const char *)-1) {
            free(decoded);
            return -1;
        }
        if (line_end == NULL) {
            free(decoded);
            return 1;
        }
        const char *line = data + position;
        const char *size_end = memchr(line, ';', (size_t)(line_end - line));
        if (size_end == NULL) size_end = line_end;
        while (size_end > line && (size_end[-1] == ' ' || size_end[-1] == '\t')) size_end -= 1;
        if (size_end == line) {
            free(decoded);
            return -1;
        }

        size_t chunk_size = 0;
        for (const char *item = line; item < size_end; item += 1) {
            unsigned char value = (unsigned char)*item;
            size_t digit;
            if (value >= '0' && value <= '9') digit = (size_t)(value - '0');
            else if (value >= 'a' && value <= 'f') digit = (size_t)(value - 'a' + 10);
            else if (value >= 'A' && value <= 'F') digit = (size_t)(value - 'A' + 10);
            else {
                free(decoded);
                return -1;
            }
            if (chunk_size > (SIZE_MAX - digit) / 16) {
                free(decoded);
                return -1;
            }
            chunk_size = chunk_size * 16 + digit;
        }
        if (chunk_size > 1024 * 1024 || decoded_len > 1024 * 1024 - chunk_size) {
            free(decoded);
            return -1;
        }
        position = (size_t)(line_end - data) + 2;

        if (chunk_size == 0) {
            while (true) {
                if (len - position < 2) {
                    free(decoded);
                    return 1;
                }
                const char *trailer_end = ct_http_find_crlf(data + position, len - position);
                if (trailer_end == (const char *)-1) {
                    free(decoded);
                    return -1;
                }
                if (trailer_end == NULL) {
                    free(decoded);
                    return 1;
                }
                if (trailer_end == data + position) {
                    *out_body = decoded;
                    *out_body_len = decoded_len;
                    *out_consumed = position + 2;
                    return 0;
                }
                const char *colon = memchr(data + position, ':', (size_t)(trailer_end - (data + position)));
                if (colon == NULL || colon == data + position) {
                    free(decoded);
                    return -1;
                }
                position = (size_t)(trailer_end - data) + 2;
            }
        }

        if (len - position < chunk_size) {
            free(decoded);
            return 1;
        }
        if (len - position < chunk_size + 1) {
            free(decoded);
            return 1;
        }
        if (data[position + chunk_size] != '\r') {
            free(decoded);
            return -1;
        }
        if (len - position < chunk_size + 2) {
            free(decoded);
            return 1;
        }
        if (data[position + chunk_size + 1] != '\n') {
            free(decoded);
            return -1;
        }
        if (chunk_size > 0) memcpy(decoded + decoded_len, data + position, chunk_size);
        decoded_len += chunk_size;
        position += chunk_size + 2;
    }
}

static int ct_http_read_request(int fd, CtHttpRequest *request, CtHttpReadBuffer *input) {
    if (input->data == NULL) {
        input->capacity = 8192;
        input->data = (char *)malloc(input->capacity + 1);
        if (input->data == NULL) return -1;
        input->len = 0;
        input->data[0] = 0;
    }

    while (true) {
        const char *header_end = ct_http_find_header_end(input->data, input->len);
        if (header_end != NULL) {
            size_t header_len = (size_t)(header_end - input->data);
            size_t content_len = 0;
            bool chunked = false;
            bool keep_alive = false;
            if (ct_http_parse_head(input->data, header_len, &content_len, &chunked, &keep_alive) != 0) return -1;

            char *decoded_body = NULL;
            size_t decoded_body_len = 0;
            size_t chunked_consumed = 0;
            bool complete = false;
            if (chunked) {
                int decode_status = ct_http_decode_chunked(
                    input->data + header_len,
                    input->len - header_len,
                    &decoded_body,
                    &decoded_body_len,
                    &chunked_consumed
                );
                if (decode_status < 0) return -1;
                complete = decode_status == 0;
            } else {
                complete = input->len >= header_len + content_len;
            }

            if (complete) {
                const char *request_line_end = strstr(input->data, "\r\n");
                if (request_line_end == NULL || request_line_end > header_end) {
                    free(decoded_body);
                    return -1;
                }
                const char *first_space = memchr(input->data, ' ', (size_t)(request_line_end - input->data));
                const char *second_space = first_space == NULL
                    ? NULL
                    : memchr(first_space + 1, ' ', (size_t)(request_line_end - first_space - 1));
                if (first_space == NULL || second_space == NULL) {
                    free(decoded_body);
                    return -1;
                }

                request->method = ct_http_copy_range(input->data, (size_t)(first_space - input->data));
                request->url = ct_http_copy_range(first_space + 1, (size_t)(second_space - first_space - 1));
                request->headers_text = ct_http_copy_range(request_line_end + 2, (size_t)(header_end - request_line_end - 4));
                request->body_len = chunked ? decoded_body_len : content_len;
                request->body = chunked ? decoded_body : (char *)malloc(content_len > 0 ? content_len : 1);
                request->keep_alive = keep_alive;
                if (request->method == NULL || request->url == NULL || request->headers_text == NULL || request->body == NULL) {
                    return -1;
                }
                if (!chunked && content_len > 0) memcpy(request->body, input->data + header_len, content_len);

                size_t consumed = header_len + (chunked ? chunked_consumed : content_len);
                size_t remaining = input->len - consumed;
                if (remaining > 0) memmove(input->data, input->data + consumed, remaining);
                input->len = remaining;
                input->data[remaining] = 0;
                return 0;
            }
        }

        if (input->len == input->capacity) {
            size_t next_capacity = input->capacity * 2;
            if (next_capacity > 2 * 1024 * 1024) return -1;
            char *next = (char *)realloc(input->data, next_capacity + 1);
            if (next == NULL) return -1;
            input->data = next;
            input->capacity = next_capacity;
        }
        ssize_t read_count = recv(fd, input->data + input->len, input->capacity - input->len, 0);
        if (read_count < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (read_count == 0) return -1;
        input->len += (size_t)read_count;
        input->data[input->len] = 0;
    }
}

static void ct_http_send_response(CtHttpRequest *request) {
    int status = request->status > 0 ? request->status : 200;
    const char *reason = ct_http_reason_phrase(status);
    const char *headers = request->response_headers_text != NULL ? request->response_headers_text : "";
    char head[512];
    int head_len = snprintf(
        head,
        sizeof(head),
        "HTTP/1.1 %d %s\r\nContent-Length: %zu\r\nConnection: %s\r\n%s\r\n",
        status,
        reason,
        request->response_body_len,
        request->keep_alive ? "keep-alive" : "close",
        headers
    );
    if (head_len < 0) return;
    if ((size_t)head_len >= sizeof(head)) head_len = (int)sizeof(head) - 1;
    ct_http_send_all(request->client_fd, head, (size_t)head_len);
    if (request->response_body_len > 0 && request->response_body != NULL) {
        ct_http_send_all(request->client_fd, request->response_body, request->response_body_len);
    }
}

static ssize_t ct_http_send_chunked_response_head(CtHttpRequest *request) {
    int status = request->status > 0 ? request->status : 200;
    const char *reason = ct_http_reason_phrase(status);
    const char *headers = request->response_headers_text != NULL ? request->response_headers_text : "";
    const char *connection = request->keep_alive ? "keep-alive" : "close";
    int head_len = snprintf(
        NULL,
        0,
        "HTTP/1.1 %d %s\r\nTransfer-Encoding: chunked\r\nConnection: %s\r\n%s\r\n",
        status,
        reason,
        connection,
        headers
    );
    if (head_len < 0) return -1;

    char *head = (char *)malloc((size_t)head_len + 1);
    if (head == NULL) return -1;
    snprintf(
        head,
        (size_t)head_len + 1,
        "HTTP/1.1 %d %s\r\nTransfer-Encoding: chunked\r\nConnection: %s\r\n%s\r\n",
        status,
        reason,
        connection,
        headers
    );
    ssize_t result = ct_http_send_all(request->client_fd, head, (size_t)head_len);
    free(head);
    return result;
}

static ssize_t ct_http_send_chunk(CtHttpRequest *request, const uint8_t *data, size_t len) {
    if (len == 0) return 0;

    char frame_head[2 * sizeof(size_t) + 3];
    int frame_head_len = snprintf(frame_head, sizeof(frame_head), "%zx\r\n", len);
    if (frame_head_len < 0 || (size_t)frame_head_len >= sizeof(frame_head)) return -1;
    if (ct_http_send_all(request->client_fd, frame_head, (size_t)frame_head_len) < 0) return -1;
    if (ct_http_send_all(request->client_fd, (const char *)data, len) < 0) return -1;
    if (ct_http_send_all(request->client_fd, "\r\n", 2) < 0) return -1;
    return (ssize_t)len;
}

static bool ct_http_server_track_request(CtHttpServer *server, CtHttpRequest *request) {
    pthread_mutex_lock(&server->mutex);
    if (server->stopped) {
        pthread_mutex_unlock(&server->mutex);
        return false;
    }
    request->next = server->requests;
    server->requests = request;
    server->active_clients += 1;
    pthread_mutex_unlock(&server->mutex);
    return true;
}

static void ct_http_server_finish_request(CtHttpServer *server, CtHttpRequest *request) {
    pthread_mutex_lock(&server->mutex);
    CtHttpRequest **cursor = &server->requests;
    while (*cursor != NULL) {
        if (*cursor == request) {
            *cursor = request->next;
            break;
        }
        cursor = &(*cursor)->next;
    }
    if (server->active_clients > 0) server->active_clients -= 1;
    pthread_cond_broadcast(&server->clients_cond);
    pthread_mutex_unlock(&server->mutex);
}

static void *ct_http_client_thread(void *opaque) {
    CtHttpClientTask *task = (CtHttpClientTask *)opaque;
    CtHttpServer *server = task->server;
    CtHttpRequest *request = task->request;
    CtHttpReadBuffer input = {0};
    free(task);

    while (!ct_http_server_is_stopped(server)) {
        if (ct_http_read_request(request->client_fd, request, &input) != 0) {
            if (!ct_http_server_is_stopped(server) && input.len > 0) {
                static const char bad_request[] =
                    "HTTP/1.1 400 Bad Request\r\nContent-Length: 11\r\nConnection: close\r\n\r\nBad Request";
                ct_http_send_all(request->client_fd, bad_request, sizeof(bad_request) - 1);
            }
            break;
        }

        pthread_mutex_lock(&server->mutex);
        request->ready = true;
        pthread_mutex_unlock(&server->mutex);

        pthread_mutex_lock(&request->mutex);
        while (!request->completed) pthread_cond_wait(&request->cond, &request->mutex);
        pthread_mutex_unlock(&request->mutex);

        if (ct_http_server_is_stopped(server)) break;
        if (!request->response_streaming) ct_http_send_response(request);
        if (!request->keep_alive) break;

        pthread_mutex_lock(&ct_http_servers_mutex);
        uint32_t next_request_id = ct_next_http_request_id++;
        if (ct_next_http_request_id == 0) ct_next_http_request_id = 1;
        pthread_mutex_unlock(&ct_http_servers_mutex);

        pthread_mutex_lock(&server->mutex);
        ct_http_clear_request(request);
        request->id = next_request_id;
        pthread_mutex_unlock(&server->mutex);
    }

    free(input.data);
    ct_http_server_finish_request(server, request);
    ct_http_free_request(request);
    return NULL;
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
        int no_delay = 1;
        setsockopt(client_fd, IPPROTO_TCP, TCP_NODELAY, &no_delay, sizeof(no_delay));
#if defined(TCP_SENDMOREACKS)
        int send_more_acks = 1;
        setsockopt(client_fd, IPPROTO_TCP, TCP_SENDMOREACKS, &send_more_acks, sizeof(send_more_acks));
#endif
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

        if (!ct_http_server_track_request(server, request)) {
            ct_http_free_request(request);
            break;
        }

        CtHttpClientTask *task = (CtHttpClientTask *)calloc(1, sizeof(CtHttpClientTask));
        if (task == NULL) {
            ct_http_server_finish_request(server, request);
            ct_http_free_request(request);
            continue;
        }
        task->server = server;
        task->request = request;

        pthread_t client_thread;
        if (pthread_create(&client_thread, NULL, ct_http_client_thread, task) != 0) {
            free(task);
            ct_http_server_finish_request(server, request);
            ct_http_free_request(request);
            continue;
        }
        pthread_detach(client_thread);
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

__attribute__((visibility("default"))) int napi_create_string_utf8(
    void *env,
    const char *value,
    size_t length,
    void **result
) {
    (void)env;
    if (ct_active_napi_context == NULL || value == NULL || result == NULL) return 1;
    if (length == (size_t)-1) length = strlen(value);
    *result = (void *)ct_make_string_len(ct_active_napi_context, value, length);
    return 0;
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

static char *ct_value_to_utf8_copy(JSContextRef ctx, JSValueRef value, size_t *len_out) {
    *len_out = 0;
    JSValueRef exception = NULL;
    JSStringRef string = JSValueToStringCopy(ctx, value, &exception);
    if (string == NULL) return NULL;
    size_t size = JSStringGetMaximumUTF8CStringSize(string);
    char *buffer = (char *)malloc(size > 0 ? size : 1);
    if (buffer == NULL) {
        JSStringRelease(string);
        return NULL;
    }
    size_t written = JSStringGetUTF8CString(string, buffer, size);
    JSStringRelease(string);
    *len_out = written > 0 ? written - 1 : 0;
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

static void ct_mmap_array_buffer_free(void *bytes, void *deallocator_context) {
#if !defined(_WIN32)
    size_t length = (size_t)(uintptr_t)deallocator_context;
    if (bytes != NULL && length > 0) munmap(bytes, length);
#else
    (void)bytes;
    (void)deallocator_context;
#endif
}

static void ct_sqlite_array_buffer_free(void *bytes, void *deallocator_context) {
    (void)deallocator_context;
    sqlite3_free(bytes);
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

typedef enum {
    CT_ZLIB_DEFLATE,
    CT_ZLIB_DEFLATE_RAW,
    CT_ZLIB_GZIP,
    CT_ZLIB_INFLATE,
    CT_ZLIB_INFLATE_RAW,
    CT_ZLIB_GUNZIP,
    CT_ZLIB_UNZIP,
    CT_ZLIB_BROTLI_COMPRESS,
    CT_ZLIB_BROTLI_DECOMPRESS,
    CT_ZLIB_ZSTD_COMPRESS,
    CT_ZLIB_ZSTD_DECOMPRESS,
} CtZlibMode;

static bool ct_zlib_mode_from_name(const char *name, CtZlibMode *mode) {
    if (strcmp(name, "deflate") == 0) {
        *mode = CT_ZLIB_DEFLATE;
        return true;
    }
    if (strcmp(name, "deflateRaw") == 0) {
        *mode = CT_ZLIB_DEFLATE_RAW;
        return true;
    }
    if (strcmp(name, "gzip") == 0) {
        *mode = CT_ZLIB_GZIP;
        return true;
    }
    if (strcmp(name, "inflate") == 0) {
        *mode = CT_ZLIB_INFLATE;
        return true;
    }
    if (strcmp(name, "inflateRaw") == 0) {
        *mode = CT_ZLIB_INFLATE_RAW;
        return true;
    }
    if (strcmp(name, "gunzip") == 0) {
        *mode = CT_ZLIB_GUNZIP;
        return true;
    }
    if (strcmp(name, "unzip") == 0) {
        *mode = CT_ZLIB_UNZIP;
        return true;
    }
    if (strcmp(name, "brotliCompress") == 0) {
        *mode = CT_ZLIB_BROTLI_COMPRESS;
        return true;
    }
    if (strcmp(name, "brotliDecompress") == 0) {
        *mode = CT_ZLIB_BROTLI_DECOMPRESS;
        return true;
    }
    if (strcmp(name, "zstdCompress") == 0) {
        *mode = CT_ZLIB_ZSTD_COMPRESS;
        return true;
    }
    if (strcmp(name, "zstdDecompress") == 0) {
        *mode = CT_ZLIB_ZSTD_DECOMPRESS;
        return true;
    }
    return false;
}

static bool ct_zlib_mode_compresses(CtZlibMode mode) {
    return mode == CT_ZLIB_DEFLATE || mode == CT_ZLIB_DEFLATE_RAW || mode == CT_ZLIB_GZIP || mode == CT_ZLIB_BROTLI_COMPRESS || mode == CT_ZLIB_ZSTD_COMPRESS;
}

static int ct_zlib_window_bits(CtZlibMode mode) {
    switch (mode) {
        case CT_ZLIB_DEFLATE:
        case CT_ZLIB_INFLATE:
            return MAX_WBITS;
        case CT_ZLIB_DEFLATE_RAW:
        case CT_ZLIB_INFLATE_RAW:
            return -MAX_WBITS;
        case CT_ZLIB_GZIP:
        case CT_ZLIB_GUNZIP:
            return MAX_WBITS + 16;
        case CT_ZLIB_UNZIP:
            return MAX_WBITS + 32;
        case CT_ZLIB_BROTLI_COMPRESS:
        case CT_ZLIB_BROTLI_DECOMPRESS:
        case CT_ZLIB_ZSTD_COMPRESS:
        case CT_ZLIB_ZSTD_DECOMPRESS:
            return MAX_WBITS;
    }
    return MAX_WBITS;
}

static JSValueRef ct_brotli_transform_sync(JSContextRef ctx, CtZlibMode mode, const uint8_t *input, size_t input_len, JSValueRef *exception) {
#if defined(__APPLE__) || defined(__MACH__)
    size_t output_capacity = mode == CT_ZLIB_BROTLI_COMPRESS
        ? input_len + (input_len / 4) + 1024
        : input_len * 4 + 1024;
#else
    size_t output_capacity = mode == CT_ZLIB_BROTLI_COMPRESS
        ? BrotliEncoderMaxCompressedSize(input_len)
        : input_len * 4 + 1024;
#endif
    if (output_capacity < 1024) output_capacity = 1024;

    for (int attempt = 0; attempt < 12; attempt += 1) {
        uint8_t *output = (uint8_t *)malloc(output_capacity);
        if (output == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        size_t output_len = output_capacity;
#if defined(__APPLE__) || defined(__MACH__)
        output_len = mode == CT_ZLIB_BROTLI_COMPRESS
            ? compression_encode_buffer(output, output_capacity, input, input_len, NULL, COMPRESSION_BROTLI)
            : compression_decode_buffer(output, output_capacity, input, input_len, NULL, COMPRESSION_BROTLI);
        bool succeeded = output_len > 0 || input_len == 0;
#else
        bool succeeded = mode == CT_ZLIB_BROTLI_COMPRESS
            ? BrotliEncoderCompress(
                BROTLI_DEFAULT_QUALITY,
                BROTLI_DEFAULT_WINDOW,
                BROTLI_MODE_GENERIC,
                input_len,
                input,
                &output_len,
                output
            ) == BROTLI_TRUE
            : BrotliDecoderDecompress(input_len, input, &output_len, output) == BROTLI_DECODER_RESULT_SUCCESS;
#endif
        if (succeeded) {
            return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, output_len, ct_array_buffer_free, NULL, exception);
        }
        free(output);
        output_capacity *= 2;
    }
    ct_throw_message(ctx, exception, mode == CT_ZLIB_BROTLI_COMPRESS ? "Brotli compression failed" : "Brotli decompression failed");
    return JSValueMakeUndefined(ctx);
}

typedef size_t (*CtZstdCompressBoundFn)(size_t src_size);
typedef size_t (*CtZstdCompressFn)(void *dst, size_t dst_capacity, const void *src, size_t src_size, int compression_level);
typedef unsigned long long (*CtZstdGetFrameContentSizeFn)(const void *src, size_t src_size);
typedef size_t (*CtZstdDecompressFn)(void *dst, size_t dst_capacity, const void *src, size_t src_size);
typedef unsigned int (*CtZstdIsErrorFn)(size_t code);
typedef const char *(*CtZstdGetErrorNameFn)(size_t code);

typedef struct {
    bool attempted;
    void *handle;
    CtZstdCompressBoundFn compress_bound;
    CtZstdCompressFn compress;
    CtZstdGetFrameContentSizeFn get_frame_content_size;
    CtZstdDecompressFn decompress;
    CtZstdIsErrorFn is_error;
    CtZstdGetErrorNameFn get_error_name;
} CtZstdApi;

static CtZstdApi ct_zstd_api = {0};

#define CT_ZSTD_CONTENTSIZE_UNKNOWN ((unsigned long long)-1)
#define CT_ZSTD_CONTENTSIZE_ERROR ((unsigned long long)-2)

static bool ct_zstd_load(void) {
    if (ct_zstd_api.attempted) return ct_zstd_api.handle != NULL;
    ct_zstd_api.attempted = true;

    const char *candidates[] = {
        "libzstd.1.dylib",
        "libzstd.dylib",
        "/opt/homebrew/lib/libzstd.dylib",
        "/usr/local/lib/libzstd.dylib",
        "libzstd.so.1",
        "libzstd.so",
    };
    for (size_t index = 0; index < sizeof(candidates) / sizeof(candidates[0]); index += 1) {
        void *handle = dlopen(candidates[index], RTLD_LAZY | RTLD_LOCAL);
        if (handle == NULL) continue;
        ct_zstd_api.compress_bound = (CtZstdCompressBoundFn)dlsym(handle, "ZSTD_compressBound");
        ct_zstd_api.compress = (CtZstdCompressFn)dlsym(handle, "ZSTD_compress");
        ct_zstd_api.get_frame_content_size = (CtZstdGetFrameContentSizeFn)dlsym(handle, "ZSTD_getFrameContentSize");
        ct_zstd_api.decompress = (CtZstdDecompressFn)dlsym(handle, "ZSTD_decompress");
        ct_zstd_api.is_error = (CtZstdIsErrorFn)dlsym(handle, "ZSTD_isError");
        ct_zstd_api.get_error_name = (CtZstdGetErrorNameFn)dlsym(handle, "ZSTD_getErrorName");
        if (ct_zstd_api.compress_bound != NULL && ct_zstd_api.compress != NULL && ct_zstd_api.get_frame_content_size != NULL &&
            ct_zstd_api.decompress != NULL && ct_zstd_api.is_error != NULL && ct_zstd_api.get_error_name != NULL) {
            ct_zstd_api.handle = handle;
            return true;
        }
        dlclose(handle);
        memset(&ct_zstd_api, 0, sizeof(ct_zstd_api));
        ct_zstd_api.attempted = true;
    }
    return false;
}

static JSValueRef ct_zstd_transform_sync(JSContextRef ctx, CtZlibMode mode, const uint8_t *input, size_t input_len, int level, JSValueRef *exception) {
    if (!ct_zstd_load()) {
        ct_throw_message(ctx, exception, "native Zstd support is unavailable");
        return JSValueMakeUndefined(ctx);
    }

    if (mode == CT_ZLIB_ZSTD_COMPRESS) {
        size_t output_capacity = ct_zstd_api.compress_bound(input_len);
        uint8_t *output = (uint8_t *)malloc(output_capacity > 0 ? output_capacity : 1);
        if (output == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        size_t output_len = ct_zstd_api.compress(output, output_capacity, input, input_len, level);
        if (ct_zstd_api.is_error(output_len)) {
            const char *message = ct_zstd_api.get_error_name(output_len);
            free(output);
            ct_throw_message(ctx, exception, message != NULL ? message : "Zstd compression failed");
            return JSValueMakeUndefined(ctx);
        }
        return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, output_len, ct_array_buffer_free, NULL, exception);
    }

    unsigned long long content_size = ct_zstd_api.get_frame_content_size(input, input_len);
    if (content_size == CT_ZSTD_CONTENTSIZE_ERROR) {
        ct_throw_message(ctx, exception, "Zstd decompression failed");
        return JSValueMakeUndefined(ctx);
    }

    size_t output_capacity = 0;
    if (content_size != CT_ZSTD_CONTENTSIZE_UNKNOWN) {
        output_capacity = (size_t)content_size;
    } else {
        output_capacity = input_len * 4 + 65536;
        if (output_capacity < 65536) output_capacity = 65536;
    }

    for (int attempt = 0; attempt < 12; attempt += 1) {
        uint8_t *output = (uint8_t *)malloc(output_capacity > 0 ? output_capacity : 1);
        if (output == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        size_t output_len = ct_zstd_api.decompress(output, output_capacity, input, input_len);
        if (!ct_zstd_api.is_error(output_len)) {
            return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, output_len, ct_array_buffer_free, NULL, exception);
        }
        const char *message = ct_zstd_api.get_error_name(output_len);
        free(output);
        if (content_size != CT_ZSTD_CONTENTSIZE_UNKNOWN) {
            ct_throw_message(ctx, exception, message != NULL ? message : "Zstd decompression failed");
            return JSValueMakeUndefined(ctx);
        }
        output_capacity *= 2;
    }

    ct_throw_message(ctx, exception, "Zstd decompression failed");
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_zlib_transform_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.zlibTransformSync(mode, data[, level]) requires mode and data");
        return JSValueMakeUndefined(ctx);
    }

    char *mode_name = ct_value_to_string_copy(ctx, argv[0]);
    if (mode_name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    CtZlibMode mode;
    if (!ct_zlib_mode_from_name(mode_name, &mode)) {
        ct_throw_message(ctx, exception, "Unsupported zlib mode");
        free(mode_name);
        return JSValueMakeUndefined(ctx);
    }
    free(mode_name);

    uint8_t *input = NULL;
    size_t input_len = 0;
    if (ct_get_bytes(ctx, argv[1], &input, &input_len) != 0) {
        ct_throw_message(ctx, exception, "zlib input must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }

    int level = Z_DEFAULT_COMPRESSION;
    int window_bits = ct_zlib_window_bits(mode);
    int mem_level = MAX_MEM_LEVEL;
    int strategy = Z_DEFAULT_STRATEGY;
    int finish_flush = Z_FINISH;
    uint8_t *dictionary = NULL;
    size_t dictionary_len = 0;
    if (argc >= 3 && !JSValueIsUndefined(ctx, argv[2]) && !JSValueIsNull(ctx, argv[2])) {
        if (JSValueIsObject(ctx, argv[2])) {
            JSObjectRef options = (JSObjectRef)argv[2];
            JSValueRef level_value = ct_get_property(ctx, options, "level", exception);
            if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
            if (!JSValueIsUndefined(ctx, level_value) && !JSValueIsNull(ctx, level_value)) level = (int)ct_value_to_number(ctx, level_value);
            JSValueRef window_bits_value = ct_get_property(ctx, options, "windowBits", exception);
            if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
            if (!JSValueIsUndefined(ctx, window_bits_value) && !JSValueIsNull(ctx, window_bits_value)) window_bits = (int)ct_value_to_number(ctx, window_bits_value);
            JSValueRef mem_level_value = ct_get_property(ctx, options, "memLevel", exception);
            if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
            if (!JSValueIsUndefined(ctx, mem_level_value) && !JSValueIsNull(ctx, mem_level_value)) mem_level = (int)ct_value_to_number(ctx, mem_level_value);
            JSValueRef strategy_value = ct_get_property(ctx, options, "strategy", exception);
            if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
            if (!JSValueIsUndefined(ctx, strategy_value) && !JSValueIsNull(ctx, strategy_value)) strategy = (int)ct_value_to_number(ctx, strategy_value);
            JSValueRef finish_flush_value = ct_get_property(ctx, options, "finishFlush", exception);
            if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
            if (!JSValueIsUndefined(ctx, finish_flush_value) && !JSValueIsNull(ctx, finish_flush_value)) finish_flush = (int)ct_value_to_number(ctx, finish_flush_value);
            JSValueRef dictionary_value = ct_get_property(ctx, options, "dictionary", exception);
            if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
            if (!JSValueIsUndefined(ctx, dictionary_value) && !JSValueIsNull(ctx, dictionary_value)) {
                if (ct_get_bytes(ctx, dictionary_value, &dictionary, &dictionary_len) != 0) {
                    ct_throw_message(ctx, exception, "zlib dictionary must be an ArrayBuffer or typed array");
                    return JSValueMakeUndefined(ctx);
                }
            }
        } else {
            level = (int)ct_value_to_number(ctx, argv[2]);
        }
    }

    if (mode == CT_ZLIB_BROTLI_COMPRESS || mode == CT_ZLIB_BROTLI_DECOMPRESS) {
        return ct_brotli_transform_sync(ctx, mode, input, input_len, exception);
    }

    if (mode == CT_ZLIB_ZSTD_COMPRESS || mode == CT_ZLIB_ZSTD_DECOMPRESS) {
        return ct_zstd_transform_sync(ctx, mode, input, input_len, level == Z_DEFAULT_COMPRESSION ? 3 : level, exception);
    }

    if (level < Z_NO_COMPRESSION || level > Z_BEST_COMPRESSION) level = Z_DEFAULT_COMPRESSION;
    if (window_bits == 0) window_bits = ct_zlib_window_bits(mode);
    if (mem_level < 1 || mem_level > MAX_MEM_LEVEL) mem_level = MAX_MEM_LEVEL;
    if (strategy < Z_DEFAULT_STRATEGY || strategy > Z_FIXED) strategy = Z_DEFAULT_STRATEGY;
    if (finish_flush < Z_NO_FLUSH || finish_flush > Z_TREES) finish_flush = Z_FINISH;

    const bool compressing = ct_zlib_mode_compresses(mode);
    size_t capacity = compressing ? (size_t)compressBound((uLong)input_len) + 64 : (input_len > 0 ? input_len * 3 : 65536);
    if (capacity < 65536) capacity = 65536;
    uint8_t *output = (uint8_t *)malloc(capacity);
    if (output == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    stream.next_in = input;
    stream.avail_in = (uInt)input_len;

    int status = compressing
        ? deflateInit2(&stream, level, Z_DEFLATED, window_bits, mem_level, strategy)
        : inflateInit2(&stream, window_bits);
    if (status != Z_OK) {
        free(output);
        ct_throw_message(ctx, exception, "Failed to initialize zlib stream");
        return JSValueMakeUndefined(ctx);
    }
    if (dictionary != NULL && dictionary_len > 0 && compressing) {
        status = deflateSetDictionary(&stream, dictionary, (uInt)dictionary_len);
        if (status != Z_OK) {
            free(output);
            deflateEnd(&stream);
            ct_throw_message(ctx, exception, "Failed to set zlib dictionary");
            return JSValueMakeUndefined(ctx);
        }
    }

    while (true) {
        if (stream.total_out >= capacity) {
            if (capacity > (size_t)512 * 1024 * 1024) {
                status = Z_MEM_ERROR;
                break;
            }
            size_t next_capacity = capacity * 2;
            uint8_t *next_output = (uint8_t *)realloc(output, next_capacity);
            if (next_output == NULL) {
                status = Z_MEM_ERROR;
                break;
            }
            output = next_output;
            capacity = next_capacity;
        }

        const uLong previous_total_out = stream.total_out;
        const uInt previous_avail_in = stream.avail_in;
        stream.next_out = output + stream.total_out;
        stream.avail_out = (uInt)(capacity - stream.total_out);
        status = compressing ? deflate(&stream, finish_flush) : inflate(&stream, finish_flush);
        if (!compressing && status == Z_NEED_DICT && dictionary != NULL && dictionary_len > 0) {
            status = inflateSetDictionary(&stream, dictionary, (uInt)dictionary_len);
            if (status == Z_OK) continue;
        }
        if (status == Z_STREAM_END) break;
        if (finish_flush != Z_FINISH && stream.avail_in == 0 && (status == Z_OK || status == Z_BUF_ERROR)) {
            status = Z_STREAM_END;
            break;
        }
        if (status == Z_OK || status == Z_BUF_ERROR) {
            if (stream.avail_out == 0) continue;
            if (!compressing && (stream.total_out != previous_total_out || stream.avail_in != previous_avail_in)) continue;
        }
        break;
    }

    const size_t output_len = stream.total_out;
    if (compressing) {
        deflateEnd(&stream);
    } else {
        inflateEnd(&stream);
    }

    if (status != Z_STREAM_END) {
        const char *message = stream.msg != NULL ? stream.msg : zError(status);
        free(output);
        ct_throw_message(ctx, exception, message != NULL ? message : "zlib transform failed");
        return JSValueMakeUndefined(ctx);
    }

    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, output_len, ct_array_buffer_free, NULL, exception);
}

typedef struct {
    const char *name;
    size_t output_len;
#if defined(__APPLE__)
    unsigned int hmac_algorithm;
    unsigned char *(*digest_fn)(const void *, CC_LONG, unsigned char *);
#endif
} CtDigestAlgorithm;

static const CtDigestAlgorithm *ct_digest_algorithm(const char *name) {
#if defined(__APPLE__)
    static const CtDigestAlgorithm algorithms[] = {
        {"md5", CC_MD5_DIGEST_LENGTH, kCCHmacAlgMD5, ct_cc_md5},
        {"sha1", CC_SHA1_DIGEST_LENGTH, kCCHmacAlgSHA1, CC_SHA1},
        {"sha224", CC_SHA224_DIGEST_LENGTH, kCCHmacAlgSHA224, CC_SHA224},
        {"sha256", CC_SHA256_DIGEST_LENGTH, kCCHmacAlgSHA256, CC_SHA256},
        {"sha384", CC_SHA384_DIGEST_LENGTH, kCCHmacAlgSHA384, CC_SHA384},
        {"sha512", CC_SHA512_DIGEST_LENGTH, kCCHmacAlgSHA512, CC_SHA512},
    };
    for (size_t index = 0; index < sizeof(algorithms) / sizeof(algorithms[0]); index += 1) {
        if (strcasecmp(name, algorithms[index].name) == 0) return &algorithms[index];
    }
#else
    (void)name;
#endif
    return NULL;
}

static JSValueRef ct_crypto_hash_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.cryptoHashSync(algorithm, data) requires algorithm and data");
        return JSValueMakeUndefined(ctx);
    }

    char *algorithm_name = ct_value_to_string_copy(ctx, argv[0]);
    if (algorithm_name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *input = NULL;
    size_t input_len = 0;
    if (ct_get_bytes(ctx, argv[1], &input, &input_len) != 0) {
        free(algorithm_name);
        ct_throw_message(ctx, exception, "hash input must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }
    size_t requested_output_len = 0;
    if (argc >= 3 && !JSValueIsUndefined(ctx, argv[2]) && !JSValueIsNull(ctx, argv[2])) {
        double number = ct_value_to_number(ctx, argv[2]);
        if (number > 0) requested_output_len = (size_t)number;
    }

#if CT_HAS_OPENSSL
    const EVP_MD *md = EVP_get_digestbyname(algorithm_name);
    if (md != NULL) {
        EVP_MD_CTX *md_ctx = EVP_MD_CTX_new();
        if (md_ctx == NULL) {
            free(algorithm_name);
            ct_throw_message(ctx, exception, "Failed to allocate digest context");
            return JSValueMakeUndefined(ctx);
        }
        const int md_size = EVP_MD_get_size(md);
        const bool is_xof = (EVP_MD_get_flags(md) & EVP_MD_FLAG_XOF) != 0;
        size_t output_len = requested_output_len > 0 ? requested_output_len : (md_size > 0 ? (size_t)md_size : 0);
        if (output_len == 0) output_len = is_xof ? 32 : 1;
        uint8_t *output = (uint8_t *)malloc(output_len);
        if (output == NULL) {
            EVP_MD_CTX_free(md_ctx);
            free(algorithm_name);
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        int ok = EVP_DigestInit_ex(md_ctx, md, NULL) == 1 &&
            EVP_DigestUpdate(md_ctx, input, input_len) == 1;
        if (ok && is_xof) {
            ok = EVP_DigestFinalXOF(md_ctx, output, output_len) == 1;
        } else if (ok) {
            unsigned int final_len = 0;
            ok = EVP_DigestFinal_ex(md_ctx, output, &final_len) == 1;
            output_len = final_len;
        }
        EVP_MD_CTX_free(md_ctx);
        free(algorithm_name);
        if (!ok) {
            free(output);
            ct_throw_message(ctx, exception, "Digest operation failed");
            return JSValueMakeUndefined(ctx);
        }
        return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, output_len, ct_array_buffer_free, NULL, exception);
    }
#endif

    const CtDigestAlgorithm *algorithm = ct_digest_algorithm(algorithm_name);
    free(algorithm_name);
    if (algorithm == NULL) {
        ct_throw_message(ctx, exception, "Unsupported digest algorithm");
        return JSValueMakeUndefined(ctx);
    }

    uint8_t *output = (uint8_t *)malloc(algorithm->output_len);
    if (output == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
#if defined(__APPLE__)
    algorithm->digest_fn(input, (CC_LONG)input_len, output);
#else
    free(output);
    ct_throw_message(ctx, exception, "Native digest algorithms are not available on this platform yet");
    return JSValueMakeUndefined(ctx);
#endif
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, algorithm->output_len, ct_array_buffer_free, NULL, exception);
}

static JSValueRef ct_crypto_hmac_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "cottontail.cryptoHmacSync(algorithm, key, data) requires algorithm, key, and data");
        return JSValueMakeUndefined(ctx);
    }

    char *algorithm_name = ct_value_to_string_copy(ctx, argv[0]);
    if (algorithm_name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *key = NULL;
    size_t key_len = 0;
    uint8_t *input = NULL;
    size_t input_len = 0;
    if (ct_get_bytes(ctx, argv[1], &key, &key_len) != 0 || ct_get_bytes(ctx, argv[2], &input, &input_len) != 0) {
        free(algorithm_name);
        ct_throw_message(ctx, exception, "HMAC key and input must be ArrayBuffers or typed arrays");
        return JSValueMakeUndefined(ctx);
    }

#if CT_HAS_OPENSSL
    const EVP_MD *md = EVP_get_digestbyname(algorithm_name);
    if (md != NULL) {
        const int md_size = EVP_MD_get_size(md);
        if (md_size <= 0 || (EVP_MD_get_flags(md) & EVP_MD_FLAG_XOF) != 0) {
            free(algorithm_name);
            ct_throw_message(ctx, exception, "HMAC algorithm is not available");
            return JSValueMakeUndefined(ctx);
        }
        uint8_t *output = (uint8_t *)malloc((size_t)md_size);
        if (output == NULL) {
            free(algorithm_name);
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        unsigned int output_len = 0;
        unsigned char *result = HMAC(md, key, (int)key_len, input, input_len, output, &output_len);
        free(algorithm_name);
        if (result == NULL) {
            free(output);
            ct_throw_message(ctx, exception, "HMAC operation failed");
            return JSValueMakeUndefined(ctx);
        }
        return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, output_len, ct_array_buffer_free, NULL, exception);
    }
#endif

    const CtDigestAlgorithm *algorithm = ct_digest_algorithm(algorithm_name);
    free(algorithm_name);
    if (algorithm == NULL) {
        ct_throw_message(ctx, exception, "Unsupported HMAC algorithm");
        return JSValueMakeUndefined(ctx);
    }

    uint8_t *output = (uint8_t *)malloc(algorithm->output_len);
    if (output == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
#if defined(__APPLE__)
    CCHmac((CCHmacAlgorithm)algorithm->hmac_algorithm, key, key_len, input, input_len, output);
#else
    free(output);
    ct_throw_message(ctx, exception, "Native HMAC algorithms are not available on this platform yet");
    return JSValueMakeUndefined(ctx);
#endif
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, algorithm->output_len, ct_array_buffer_free, NULL, exception);
}

static JSValueRef ct_crypto_argon2_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 7) {
        ct_throw_message(ctx, exception, "cottontail.cryptoArgon2Sync(algorithm, message, nonce, parallelism, tagLength, memory, passes, secret, associatedData) requires seven arguments");
        return JSValueMakeUndefined(ctx);
    }

    char *algorithm_name = ct_value_to_string_copy(ctx, argv[0]);
    if (algorithm_name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    int algorithm = -1;
    if (strcasecmp(algorithm_name, "argon2d") == 0) algorithm = 0;
    else if (strcasecmp(algorithm_name, "argon2i") == 0) algorithm = 1;
    else if (strcasecmp(algorithm_name, "argon2id") == 0) algorithm = 2;
    free(algorithm_name);
    if (algorithm < 0) {
        ct_throw_message(ctx, exception, "Invalid Argon2 algorithm");
        return JSValueMakeUndefined(ctx);
    }

    uint8_t *message = NULL;
    size_t message_len = 0;
    uint8_t *nonce = NULL;
    size_t nonce_len = 0;
    if (ct_get_bytes(ctx, argv[1], &message, &message_len) != 0 || ct_get_bytes(ctx, argv[2], &nonce, &nonce_len) != 0) {
        ct_throw_message(ctx, exception, "Argon2 message and nonce must be ArrayBuffers or typed arrays");
        return JSValueMakeUndefined(ctx);
    }

    uint32_t parallelism = (uint32_t)ct_value_to_number(ctx, argv[3]);
    size_t tag_len = (size_t)ct_value_to_number(ctx, argv[4]);
    uint32_t memory = (uint32_t)ct_value_to_number(ctx, argv[5]);
    uint32_t passes = (uint32_t)ct_value_to_number(ctx, argv[6]);
    if (parallelism == 0 || tag_len == 0 || memory == 0 || passes == 0) {
        ct_throw_message(ctx, exception, "Argon2 numeric parameters must be positive");
        return JSValueMakeUndefined(ctx);
    }

    uint8_t *secret = NULL;
    size_t secret_len = 0;
    bool has_secret = argc >= 8 && !JSValueIsUndefined(ctx, argv[7]) && !JSValueIsNull(ctx, argv[7]);
    if (has_secret && ct_get_bytes(ctx, argv[7], &secret, &secret_len) != 0) {
        ct_throw_message(ctx, exception, "Argon2 secret must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }

    uint8_t *associated_data = NULL;
    size_t associated_data_len = 0;
    bool has_associated_data = argc >= 9 && !JSValueIsUndefined(ctx, argv[8]) && !JSValueIsNull(ctx, argv[8]);
    if (has_associated_data && ct_get_bytes(ctx, argv[8], &associated_data, &associated_data_len) != 0) {
        ct_throw_message(ctx, exception, "Argon2 associatedData must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }

    uint8_t *output = (uint8_t *)malloc(tag_len);
    if (output == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    char *error = NULL;
    int status = ct_crypto_argon2(
        algorithm,
        message,
        message_len,
        nonce,
        nonce_len,
        parallelism,
        memory,
        passes,
        has_secret ? secret : NULL,
        has_secret ? secret_len : 0,
        has_associated_data ? associated_data : NULL,
        has_associated_data ? associated_data_len : 0,
        output,
        tag_len,
        &error
    );
    if (status != 0) {
        free(output);
        ct_throw_message(ctx, exception, error != NULL ? error : "Argon2 derivation failed");
        if (error != NULL) ct_host_string_free(error);
        return JSValueMakeUndefined(ctx);
    }

    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, tag_len, ct_array_buffer_free, NULL, exception);
}

static JSValueRef ct_password_hash_sync_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 5) {
        ct_throw_message(ctx, exception, "passwordHashSync requires algorithm, password, timeCost, memoryCost, and bcryptCost");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *password = NULL;
    size_t password_len = 0;
    if (ct_get_bytes(ctx, argv[1], &password, &password_len) != 0) {
        ct_throw_message(ctx, exception, "password must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }
    size_t result_len = 0;
    char *error = NULL;
    uint8_t *result = ct_password_hash(
        (int)ct_value_to_number(ctx, argv[0]),
        password,
        password_len,
        (uint32_t)ct_value_to_number(ctx, argv[2]),
        (uint32_t)ct_value_to_number(ctx, argv[3]),
        (uint8_t)ct_value_to_number(ctx, argv[4]),
        &result_len,
        &error
    );
    if (result == NULL) {
        ct_throw_message(ctx, exception, error != NULL ? error : "Password hashing failed");
        if (error != NULL) ct_host_string_free(error);
        return JSValueMakeUndefined(ctx);
    }
    JSValueRef value = ct_make_string_len(ctx, (const char *)result, result_len);
    ct_host_buffer_free((char *)result);
    return value;
}

static JSValueRef ct_password_verify_sync_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "passwordVerifySync requires algorithm, password, and hash");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *password = NULL;
    size_t password_len = 0;
    uint8_t *hash = NULL;
    size_t hash_len = 0;
    if (ct_get_bytes(ctx, argv[1], &password, &password_len) != 0 || ct_get_bytes(ctx, argv[2], &hash, &hash_len) != 0) {
        ct_throw_message(ctx, exception, "password and hash must be ArrayBuffers or typed arrays");
        return JSValueMakeUndefined(ctx);
    }
    char *error = NULL;
    int result = ct_password_verify(
        (int)ct_value_to_number(ctx, argv[0]),
        password,
        password_len,
        hash,
        hash_len,
        &error
    );
    if (result < 0) {
        ct_throw_message(ctx, exception, error != NULL ? error : "Password verification failed");
        if (error != NULL) ct_host_string_free(error);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeBoolean(ctx, result == 1);
}

static JSValueRef ct_hash_value_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "hashValue requires an algorithm and input");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *input = NULL;
    size_t input_len = 0;
    if (ct_get_bytes(ctx, argv[1], &input, &input_len) != 0) {
        ct_throw_message(ctx, exception, "hash input must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }
    uint64_t seed = 0;
    if (argc >= 3 && !JSValueIsUndefined(ctx, argv[2]) && !JSValueIsNull(ctx, argv[2])) {
        char *seed_text = ct_value_to_string_copy(ctx, argv[2]);
        if (seed_text != NULL) {
            seed = (uint64_t)strtoull(seed_text, NULL, 10);
            free(seed_text);
        }
    }
    uint64_t result = ct_hash_value((int)ct_value_to_number(ctx, argv[0]), input, input_len, seed);
    char result_text[32];
    snprintf(result_text, sizeof(result_text), "%llu", (unsigned long long)result);
    return ct_make_string(ctx, result_text);
}

static JSValueRef ct_crypto_ed25519_generate_key_pair(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
#if CT_HAS_OPENSSL
    EVP_PKEY_CTX *keygen_ctx = EVP_PKEY_CTX_new_id(EVP_PKEY_ED25519, NULL);
    if (keygen_ctx == NULL) {
        ct_throw_message(ctx, exception, "Failed to create Ed25519 keygen context");
        return JSValueMakeUndefined(ctx);
    }
    EVP_PKEY *key = NULL;
    if (EVP_PKEY_keygen_init(keygen_ctx) != 1 || EVP_PKEY_keygen(keygen_ctx, &key) != 1 || key == NULL) {
        EVP_PKEY_CTX_free(keygen_ctx);
        ct_throw_message(ctx, exception, "Failed to generate Ed25519 key pair");
        return JSValueMakeUndefined(ctx);
    }
    EVP_PKEY_CTX_free(keygen_ctx);

    unsigned char public_key[32];
    unsigned char private_key[32];
    size_t public_len = sizeof(public_key);
    size_t private_len = sizeof(private_key);
    int ok = EVP_PKEY_get_raw_public_key(key, public_key, &public_len) == 1 &&
        EVP_PKEY_get_raw_private_key(key, private_key, &private_len) == 1 &&
        public_len == sizeof(public_key) &&
        private_len == sizeof(private_key);
    EVP_PKEY_free(key);
    if (!ok) {
        ct_throw_message(ctx, exception, "Failed to export Ed25519 key pair");
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "publicKey", ct_array_buffer_from_copy(ctx, (const char *)public_key, sizeof(public_key), exception), exception);
    ct_set_property(ctx, result, "privateKey", ct_array_buffer_from_copy(ctx, (const char *)private_key, sizeof(private_key), exception), exception);
    return result;
#else
    ct_throw_message(ctx, exception, "Ed25519 is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_ed25519_public_from_private(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.cryptoEd25519PublicFromPrivate(privateKey) requires a private key");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *private_key = NULL;
    size_t private_len = 0;
    if (ct_get_bytes(ctx, argv[0], &private_key, &private_len) != 0 || private_len != 32) {
        ct_throw_message(ctx, exception, "Ed25519 private key must be 32 bytes");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    EVP_PKEY *key = EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, NULL, private_key, private_len);
    if (key == NULL) {
        ct_throw_message(ctx, exception, "Invalid Ed25519 private key");
        return JSValueMakeUndefined(ctx);
    }
    unsigned char public_key[32];
    size_t public_len = sizeof(public_key);
    int ok = EVP_PKEY_get_raw_public_key(key, public_key, &public_len) == 1 && public_len == sizeof(public_key);
    EVP_PKEY_free(key);
    if (!ok) {
        ct_throw_message(ctx, exception, "Failed to derive Ed25519 public key");
        return JSValueMakeUndefined(ctx);
    }
    return ct_array_buffer_from_copy(ctx, (const char *)public_key, sizeof(public_key), exception);
#else
    ct_throw_message(ctx, exception, "Ed25519 is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_ed25519_sign(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.cryptoEd25519Sign(privateKey, data) requires key and data");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *private_key = NULL;
    size_t private_len = 0;
    uint8_t *data = NULL;
    size_t data_len = 0;
    if (ct_get_bytes(ctx, argv[0], &private_key, &private_len) != 0 || private_len != 32 || ct_get_bytes(ctx, argv[1], &data, &data_len) != 0) {
        ct_throw_message(ctx, exception, "Ed25519 sign requires a 32-byte private key and byte data");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    EVP_PKEY *key = EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, NULL, private_key, private_len);
    EVP_MD_CTX *md_ctx = EVP_MD_CTX_new();
    if (key == NULL || md_ctx == NULL) {
        if (key != NULL) EVP_PKEY_free(key);
        if (md_ctx != NULL) EVP_MD_CTX_free(md_ctx);
        ct_throw_message(ctx, exception, "Failed to initialize Ed25519 signer");
        return JSValueMakeUndefined(ctx);
    }
    size_t signature_len = 0;
    int ok = EVP_DigestSignInit(md_ctx, NULL, NULL, NULL, key) == 1 &&
        EVP_DigestSign(md_ctx, NULL, &signature_len, data, data_len) == 1;
    uint8_t *signature = ok ? (uint8_t *)malloc(signature_len) : NULL;
    if (signature == NULL) ok = 0;
    if (ok) ok = EVP_DigestSign(md_ctx, signature, &signature_len, data, data_len) == 1;
    EVP_MD_CTX_free(md_ctx);
    EVP_PKEY_free(key);
    if (!ok) {
        free(signature);
        ct_throw_message(ctx, exception, "Ed25519 signing failed");
        return JSValueMakeUndefined(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, signature, signature_len, ct_array_buffer_free, NULL, exception);
#else
    ct_throw_message(ctx, exception, "Ed25519 is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_ed25519_verify(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "cottontail.cryptoEd25519Verify(publicKey, data, signature) requires key, data, and signature");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *public_key = NULL;
    size_t public_len = 0;
    uint8_t *data = NULL;
    size_t data_len = 0;
    uint8_t *signature = NULL;
    size_t signature_len = 0;
    if (ct_get_bytes(ctx, argv[0], &public_key, &public_len) != 0 || public_len != 32 ||
        ct_get_bytes(ctx, argv[1], &data, &data_len) != 0 ||
        ct_get_bytes(ctx, argv[2], &signature, &signature_len) != 0) {
        ct_throw_message(ctx, exception, "Ed25519 verify requires a 32-byte public key, byte data, and signature");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    EVP_PKEY *key = EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, NULL, public_key, public_len);
    EVP_MD_CTX *md_ctx = EVP_MD_CTX_new();
    if (key == NULL || md_ctx == NULL) {
        if (key != NULL) EVP_PKEY_free(key);
        if (md_ctx != NULL) EVP_MD_CTX_free(md_ctx);
        ct_throw_message(ctx, exception, "Failed to initialize Ed25519 verifier");
        return JSValueMakeUndefined(ctx);
    }
    int status = 0;
    if (EVP_DigestVerifyInit(md_ctx, NULL, NULL, NULL, key) == 1) {
        status = EVP_DigestVerify(md_ctx, signature, signature_len, data, data_len);
    }
    EVP_MD_CTX_free(md_ctx);
    EVP_PKEY_free(key);
    return JSValueMakeBoolean(ctx, status == 1);
#else
    ct_throw_message(ctx, exception, "Ed25519 is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static int ct_raw_key_type_id(const char *type_name) {
#if CT_HAS_OPENSSL
    if (type_name == NULL) return 0;
    if (strcasecmp(type_name, "ed25519") == 0) return EVP_PKEY_ED25519;
    if (strcasecmp(type_name, "x25519") == 0) return EVP_PKEY_X25519;
    if (strcasecmp(type_name, "x448") == 0) return EVP_PKEY_X448;
    if (strcasecmp(type_name, "ed448") == 0) return EVP_PKEY_ED448;
#else
    (void)type_name;
#endif
    return 0;
}

static JSValueRef ct_crypto_raw_key_generate_key_pair(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.cryptoRawKeyGenerateKeyPair(type) requires a key type");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *type_name = ct_value_to_string_copy(ctx, argv[0]);
    int key_type = ct_raw_key_type_id(type_name);
    free(type_name);
    if (key_type == 0) {
        ct_throw_message(ctx, exception, "Unknown raw key type");
        return JSValueMakeUndefined(ctx);
    }
    EVP_PKEY_CTX *keygen_ctx = EVP_PKEY_CTX_new_id(key_type, NULL);
    EVP_PKEY *key = NULL;
    if (keygen_ctx == NULL || EVP_PKEY_keygen_init(keygen_ctx) != 1 || EVP_PKEY_keygen(keygen_ctx, &key) != 1 || key == NULL) {
        if (keygen_ctx != NULL) EVP_PKEY_CTX_free(keygen_ctx);
        ct_throw_message(ctx, exception, "Failed to generate raw key pair");
        return JSValueMakeUndefined(ctx);
    }
    EVP_PKEY_CTX_free(keygen_ctx);

    size_t public_len = 0;
    size_t private_len = 0;
    int ok = EVP_PKEY_get_raw_public_key(key, NULL, &public_len) == 1 &&
        EVP_PKEY_get_raw_private_key(key, NULL, &private_len) == 1;
    uint8_t *public_key = ok ? (uint8_t *)malloc(public_len) : NULL;
    uint8_t *private_key = ok ? (uint8_t *)malloc(private_len) : NULL;
    if (public_key == NULL || private_key == NULL) ok = 0;
    if (ok) ok = EVP_PKEY_get_raw_public_key(key, public_key, &public_len) == 1 &&
        EVP_PKEY_get_raw_private_key(key, private_key, &private_len) == 1;
    EVP_PKEY_free(key);
    if (!ok) {
        free(public_key);
        free(private_key);
        ct_throw_message(ctx, exception, "Failed to export raw key pair");
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "publicKey", JSObjectMakeArrayBufferWithBytesNoCopy(ctx, public_key, public_len, ct_array_buffer_free, NULL, exception), exception);
    ct_set_property(ctx, result, "privateKey", JSObjectMakeArrayBufferWithBytesNoCopy(ctx, private_key, private_len, ct_array_buffer_free, NULL, exception), exception);
    return result;
#else
    ct_throw_message(ctx, exception, "Raw key generation is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_raw_public_from_private(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.cryptoRawPublicFromPrivate(type, privateKey) requires a key type and private key");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *type_name = ct_value_to_string_copy(ctx, argv[0]);
    int key_type = ct_raw_key_type_id(type_name);
    free(type_name);
    uint8_t *private_key = NULL;
    size_t private_len = 0;
    if (key_type == 0 || ct_get_bytes(ctx, argv[1], &private_key, &private_len) != 0) {
        ct_throw_message(ctx, exception, "Invalid raw private key input");
        return JSValueMakeUndefined(ctx);
    }
    EVP_PKEY *key = EVP_PKEY_new_raw_private_key(key_type, NULL, private_key, private_len);
    if (key == NULL) {
        ct_throw_message(ctx, exception, "Invalid raw private key");
        return JSValueMakeUndefined(ctx);
    }
    size_t public_len = 0;
    int ok = EVP_PKEY_get_raw_public_key(key, NULL, &public_len) == 1;
    uint8_t *public_key = ok ? (uint8_t *)malloc(public_len) : NULL;
    if (public_key == NULL) ok = 0;
    if (ok) ok = EVP_PKEY_get_raw_public_key(key, public_key, &public_len) == 1;
    EVP_PKEY_free(key);
    if (!ok) {
        free(public_key);
        ct_throw_message(ctx, exception, "Failed to derive raw public key");
        return JSValueMakeUndefined(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, public_key, public_len, ct_array_buffer_free, NULL, exception);
#else
    ct_throw_message(ctx, exception, "Raw public key derivation is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_raw_sign(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "cottontail.cryptoRawSign(type, privateKey, data) requires a key type, private key, and data");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *type_name = ct_value_to_string_copy(ctx, argv[0]);
    int key_type = ct_raw_key_type_id(type_name);
    free(type_name);
    uint8_t *private_key = NULL;
    size_t private_len = 0;
    uint8_t *data = NULL;
    size_t data_len = 0;
    if (key_type == 0 || ct_get_bytes(ctx, argv[1], &private_key, &private_len) != 0 || ct_get_bytes(ctx, argv[2], &data, &data_len) != 0) {
        ct_throw_message(ctx, exception, "Invalid raw signing input");
        return JSValueMakeUndefined(ctx);
    }
    EVP_PKEY *key = EVP_PKEY_new_raw_private_key(key_type, NULL, private_key, private_len);
    EVP_MD_CTX *md_ctx = EVP_MD_CTX_new();
    if (key == NULL || md_ctx == NULL) {
        if (key != NULL) EVP_PKEY_free(key);
        if (md_ctx != NULL) EVP_MD_CTX_free(md_ctx);
        ct_throw_message(ctx, exception, "Failed to initialize raw signer");
        return JSValueMakeUndefined(ctx);
    }
    size_t signature_len = 0;
    int ok = EVP_DigestSignInit(md_ctx, NULL, NULL, NULL, key) == 1 &&
        EVP_DigestSign(md_ctx, NULL, &signature_len, data, data_len) == 1;
    uint8_t *signature = ok ? (uint8_t *)malloc(signature_len) : NULL;
    if (signature == NULL) ok = 0;
    if (ok) ok = EVP_DigestSign(md_ctx, signature, &signature_len, data, data_len) == 1;
    EVP_MD_CTX_free(md_ctx);
    EVP_PKEY_free(key);
    if (!ok) {
        free(signature);
        ct_throw_message(ctx, exception, "Raw signing failed");
        return JSValueMakeUndefined(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, signature, signature_len, ct_array_buffer_free, NULL, exception);
#else
    ct_throw_message(ctx, exception, "Raw signing is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_raw_verify(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 4) {
        ct_throw_message(ctx, exception, "cottontail.cryptoRawVerify(type, publicKey, data, signature) requires a key type, public key, data, and signature");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *type_name = ct_value_to_string_copy(ctx, argv[0]);
    int key_type = ct_raw_key_type_id(type_name);
    free(type_name);
    uint8_t *public_key = NULL;
    size_t public_len = 0;
    uint8_t *data = NULL;
    size_t data_len = 0;
    uint8_t *signature = NULL;
    size_t signature_len = 0;
    if (key_type == 0 || ct_get_bytes(ctx, argv[1], &public_key, &public_len) != 0 ||
        ct_get_bytes(ctx, argv[2], &data, &data_len) != 0 ||
        ct_get_bytes(ctx, argv[3], &signature, &signature_len) != 0) {
        ct_throw_message(ctx, exception, "Invalid raw verification input");
        return JSValueMakeUndefined(ctx);
    }
    EVP_PKEY *key = EVP_PKEY_new_raw_public_key(key_type, NULL, public_key, public_len);
    EVP_MD_CTX *md_ctx = EVP_MD_CTX_new();
    if (key == NULL || md_ctx == NULL) {
        if (key != NULL) EVP_PKEY_free(key);
        if (md_ctx != NULL) EVP_MD_CTX_free(md_ctx);
        ct_throw_message(ctx, exception, "Failed to initialize raw verifier");
        return JSValueMakeUndefined(ctx);
    }
    int status = 0;
    if (EVP_DigestVerifyInit(md_ctx, NULL, NULL, NULL, key) == 1) {
        status = EVP_DigestVerify(md_ctx, signature, signature_len, data, data_len);
    }
    EVP_MD_CTX_free(md_ctx);
    EVP_PKEY_free(key);
    return JSValueMakeBoolean(ctx, status == 1);
#else
    ct_throw_message(ctx, exception, "Raw verification is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_raw_diffie_hellman(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "cottontail.cryptoRawDiffieHellman(type, privateKey, publicKey) requires a key type, private key, and public key");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *type_name = ct_value_to_string_copy(ctx, argv[0]);
    int key_type = ct_raw_key_type_id(type_name);
    free(type_name);
    uint8_t *private_key = NULL;
    size_t private_len = 0;
    uint8_t *public_key = NULL;
    size_t public_len = 0;
    if (key_type == 0 || ct_get_bytes(ctx, argv[1], &private_key, &private_len) != 0 || ct_get_bytes(ctx, argv[2], &public_key, &public_len) != 0) {
        ct_throw_message(ctx, exception, "Invalid raw Diffie-Hellman input");
        return JSValueMakeUndefined(ctx);
    }
    EVP_PKEY *private_pkey = EVP_PKEY_new_raw_private_key(key_type, NULL, private_key, private_len);
    EVP_PKEY *public_pkey = EVP_PKEY_new_raw_public_key(key_type, NULL, public_key, public_len);
    EVP_PKEY_CTX *derive_ctx = private_pkey != NULL ? EVP_PKEY_CTX_new(private_pkey, NULL) : NULL;
    if (private_pkey == NULL || public_pkey == NULL || derive_ctx == NULL ||
        EVP_PKEY_derive_init(derive_ctx) != 1 ||
        EVP_PKEY_derive_set_peer(derive_ctx, public_pkey) != 1) {
        if (derive_ctx != NULL) EVP_PKEY_CTX_free(derive_ctx);
        if (private_pkey != NULL) EVP_PKEY_free(private_pkey);
        if (public_pkey != NULL) EVP_PKEY_free(public_pkey);
        ct_throw_message(ctx, exception, "Failed to initialize raw Diffie-Hellman");
        return JSValueMakeUndefined(ctx);
    }
    size_t secret_len = 0;
    int ok = EVP_PKEY_derive(derive_ctx, NULL, &secret_len) == 1;
    uint8_t *secret = ok ? (uint8_t *)malloc(secret_len) : NULL;
    if (secret == NULL) ok = 0;
    if (ok) ok = EVP_PKEY_derive(derive_ctx, secret, &secret_len) == 1;
    EVP_PKEY_CTX_free(derive_ctx);
    EVP_PKEY_free(private_pkey);
    EVP_PKEY_free(public_pkey);
    if (!ok) {
        free(secret);
        ct_throw_message(ctx, exception, "Raw Diffie-Hellman failed");
        return JSValueMakeUndefined(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, secret, secret_len, ct_array_buffer_free, NULL, exception);
#else
    ct_throw_message(ctx, exception, "Raw Diffie-Hellman is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static BIGNUM *ct_bn_from_js_bytes(JSContextRef ctx, JSValueRef value) {
    uint8_t *bytes = NULL;
    size_t len = 0;
    if (ct_get_bytes(ctx, value, &bytes, &len) != 0 || len == 0) return NULL;
    return BN_bin2bn(bytes, (int)len, NULL);
}

#if CT_HAS_OPENSSL
static JSValueRef ct_js_from_bn(JSContextRef ctx, const BIGNUM *bn, JSValueRef *exception) {
    if (bn == NULL) return JSValueMakeUndefined(ctx);
    int len = BN_num_bytes(bn);
    if (len <= 0) {
        uint8_t zero = 0;
        return ct_array_buffer_from_copy(ctx, (const char *)&zero, 1, exception);
    }
    uint8_t *buffer = (uint8_t *)malloc((size_t)len);
    if (buffer == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    BN_bn2bin(bn, buffer);
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, buffer, (size_t)len, ct_array_buffer_free, NULL, exception);
}

static EVP_PKEY *ct_rsa_pkey_from_js(JSContextRef ctx, const JSValueRef argv[], size_t offset, bool private_key) {
    BIGNUM *n = ct_bn_from_js_bytes(ctx, argv[offset + 0]);
    BIGNUM *e = ct_bn_from_js_bytes(ctx, argv[offset + 1]);
    BIGNUM *d = private_key ? ct_bn_from_js_bytes(ctx, argv[offset + 2]) : NULL;
    if (n == NULL || e == NULL || (private_key && d == NULL)) {
        if (n != NULL) BN_free(n);
        if (e != NULL) BN_free(e);
        if (d != NULL) BN_free(d);
        return NULL;
    }

    RSA *rsa = RSA_new();
    if (rsa == NULL) {
        BN_free(n);
        BN_free(e);
        if (d != NULL) BN_free(d);
        return NULL;
    }
    if (RSA_set0_key(rsa, n, e, d) != 1) {
        RSA_free(rsa);
        return NULL;
    }

    if (private_key) {
        BIGNUM *p = ct_bn_from_js_bytes(ctx, argv[offset + 3]);
        BIGNUM *q = ct_bn_from_js_bytes(ctx, argv[offset + 4]);
        if (p != NULL && q != NULL) {
            if (RSA_set0_factors(rsa, p, q) != 1) {
                BN_free(p);
                BN_free(q);
                RSA_free(rsa);
                return NULL;
            }
        } else {
            if (p != NULL) BN_free(p);
            if (q != NULL) BN_free(q);
        }

        BIGNUM *dp = ct_bn_from_js_bytes(ctx, argv[offset + 5]);
        BIGNUM *dq = ct_bn_from_js_bytes(ctx, argv[offset + 6]);
        BIGNUM *qi = ct_bn_from_js_bytes(ctx, argv[offset + 7]);
        if (dp != NULL && dq != NULL && qi != NULL) {
            if (RSA_set0_crt_params(rsa, dp, dq, qi) != 1) {
                BN_free(dp);
                BN_free(dq);
                BN_free(qi);
                RSA_free(rsa);
                return NULL;
            }
        } else {
            if (dp != NULL) BN_free(dp);
            if (dq != NULL) BN_free(dq);
            if (qi != NULL) BN_free(qi);
        }
    }

    EVP_PKEY *pkey = EVP_PKEY_new();
    if (pkey == NULL || EVP_PKEY_assign_RSA(pkey, rsa) != 1) {
        if (pkey != NULL) EVP_PKEY_free(pkey);
        RSA_free(rsa);
        return NULL;
    }
    return pkey;
}

static JSObjectRef ct_js_from_rsa_pkey(JSContextRef ctx, EVP_PKEY *pkey, const char *key_type, JSValueRef *exception) {
    RSA *rsa = EVP_PKEY_get1_RSA(pkey);
    if (rsa == NULL) {
        ct_throw_message(ctx, exception, "Imported key is not an RSA key");
        return NULL;
    }
    const BIGNUM *n = NULL;
    const BIGNUM *e = NULL;
    const BIGNUM *d = NULL;
    const BIGNUM *p = NULL;
    const BIGNUM *q = NULL;
    const BIGNUM *dp = NULL;
    const BIGNUM *dq = NULL;
    const BIGNUM *qi = NULL;
    RSA_get0_key(rsa, &n, &e, &d);
    RSA_get0_factors(rsa, &p, &q);
    RSA_get0_crt_params(rsa, &dp, &dq, &qi);

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "asymmetricKeyType", ct_make_string(ctx, "rsa"), exception);
    ct_set_property(ctx, result, "type", ct_make_string(ctx, key_type), exception);
    ct_set_property(ctx, result, "n", ct_js_from_bn(ctx, n, exception), exception);
    ct_set_property(ctx, result, "e", ct_js_from_bn(ctx, e, exception), exception);
    if (strcasecmp(key_type, "private") == 0) {
        if (d != NULL) ct_set_property(ctx, result, "d", ct_js_from_bn(ctx, d, exception), exception);
        if (p != NULL) ct_set_property(ctx, result, "p", ct_js_from_bn(ctx, p, exception), exception);
        if (q != NULL) ct_set_property(ctx, result, "q", ct_js_from_bn(ctx, q, exception), exception);
        if (dp != NULL) ct_set_property(ctx, result, "dp", ct_js_from_bn(ctx, dp, exception), exception);
        if (dq != NULL) ct_set_property(ctx, result, "dq", ct_js_from_bn(ctx, dq, exception), exception);
        if (qi != NULL) ct_set_property(ctx, result, "qi", ct_js_from_bn(ctx, qi, exception), exception);
    }
    RSA_free(rsa);
    return result;
}

static JSValueRef ct_bio_to_js(JSContextRef ctx, BIO *bio, bool pem, JSValueRef *exception) {
    BUF_MEM *mem = NULL;
    BIO_get_mem_ptr(bio, &mem);
    if (mem == NULL || mem->data == NULL) {
        ct_throw_message(ctx, exception, "Failed to read encoded key");
        return JSValueMakeUndefined(ctx);
    }
    if (pem) return ct_make_string_len(ctx, mem->data, mem->length);
    return ct_array_buffer_from_copy(ctx, mem->data, mem->length, exception);
}

static int ct_ec_curve_nid(const char *name) {
    if (name == NULL) return NID_undef;
    if (strcasecmp(name, "p-256") == 0 || strcasecmp(name, "p256") == 0 || strcasecmp(name, "secp256r1") == 0) return NID_X9_62_prime256v1;
    if (strcasecmp(name, "p-384") == 0 || strcasecmp(name, "p384") == 0) return NID_secp384r1;
    if (strcasecmp(name, "p-521") == 0 || strcasecmp(name, "p521") == 0) return NID_secp521r1;
    int nid = OBJ_sn2nid(name);
    if (nid == NID_undef) nid = OBJ_ln2nid(name);
    if (nid == NID_undef) nid = OBJ_txt2nid(name);
    return nid;
}

static EC_KEY *ct_ec_key_from_private(const char *curve_name, const uint8_t *private_key, size_t private_len) {
    int nid = ct_ec_curve_nid(curve_name);
    if (nid == NID_undef) return NULL;
    EC_KEY *key = EC_KEY_new_by_curve_name(nid);
    if (key == NULL) return NULL;
    BIGNUM *private_bn = BN_bin2bn(private_key, (int)private_len, NULL);
    if (private_bn == NULL || EC_KEY_set_private_key(key, private_bn) != 1) {
        if (private_bn != NULL) BN_free(private_bn);
        EC_KEY_free(key);
        return NULL;
    }
    const EC_GROUP *group = EC_KEY_get0_group(key);
    EC_POINT *public_point = EC_POINT_new(group);
    if (public_point == NULL || EC_POINT_mul(group, public_point, private_bn, NULL, NULL, NULL) != 1 ||
        EC_KEY_set_public_key(key, public_point) != 1) {
        if (public_point != NULL) EC_POINT_free(public_point);
        BN_free(private_bn);
        EC_KEY_free(key);
        return NULL;
    }
    EC_POINT_free(public_point);
    BN_free(private_bn);
    return key;
}

static EC_KEY *ct_ec_key_from_public(const char *curve_name, const uint8_t *public_key, size_t public_len) {
    int nid = ct_ec_curve_nid(curve_name);
    if (nid == NID_undef) return NULL;
    EC_KEY *key = EC_KEY_new_by_curve_name(nid);
    if (key == NULL) return NULL;
    const EC_GROUP *group = EC_KEY_get0_group(key);
    EC_POINT *point = EC_POINT_new(group);
    if (point == NULL || EC_POINT_oct2point(group, point, public_key, public_len, NULL) != 1 ||
        EC_KEY_set_public_key(key, point) != 1) {
        if (point != NULL) EC_POINT_free(point);
        EC_KEY_free(key);
        return NULL;
    }
    EC_POINT_free(point);
    return key;
}

static JSValueRef ct_ec_private_to_js(JSContextRef ctx, EC_KEY *key, JSValueRef *exception) {
    const BIGNUM *private_bn = EC_KEY_get0_private_key(key);
    return ct_js_from_bn(ctx, private_bn, exception);
}

static JSValueRef ct_ec_public_to_js(JSContextRef ctx, EC_KEY *key, JSValueRef *exception) {
    const EC_GROUP *group = EC_KEY_get0_group(key);
    const EC_POINT *point = EC_KEY_get0_public_key(key);
    size_t len = EC_POINT_point2oct(group, point, POINT_CONVERSION_UNCOMPRESSED, NULL, 0, NULL);
    if (len == 0) {
        ct_throw_message(ctx, exception, "Failed to encode EC public key");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *buffer = (uint8_t *)malloc(len);
    if (buffer == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    if (EC_POINT_point2oct(group, point, POINT_CONVERSION_UNCOMPRESSED, buffer, len, NULL) != len) {
        free(buffer);
        ct_throw_message(ctx, exception, "Failed to encode EC public key");
        return JSValueMakeUndefined(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, buffer, len, ct_array_buffer_free, NULL, exception);
}

static int ct_ec_key_ensure_public(EC_KEY *key) {
    if (key == NULL || EC_KEY_get0_public_key(key) != NULL) return key != NULL;
    const BIGNUM *private_bn = EC_KEY_get0_private_key(key);
    const EC_GROUP *group = EC_KEY_get0_group(key);
    if (private_bn == NULL || group == NULL) return 0;
    EC_POINT *public_point = EC_POINT_new(group);
    if (public_point == NULL) return 0;
    int ok = EC_POINT_mul(group, public_point, private_bn, NULL, NULL, NULL) == 1 &&
        EC_KEY_set_public_key(key, public_point) == 1;
    EC_POINT_free(public_point);
    return ok;
}

static const char *ct_ec_curve_name_from_nid(int nid) {
    if (nid == NID_X9_62_prime256v1) return "prime256v1";
    if (nid == NID_secp384r1) return "secp384r1";
    if (nid == NID_secp521r1) return "secp521r1";
#ifdef NID_secp256k1
    if (nid == NID_secp256k1) return "secp256k1";
#endif
    const char *name = OBJ_nid2sn(nid);
    return name != NULL ? name : OBJ_nid2ln(nid);
}

static const char *ct_raw_key_name_from_id(int key_id) {
    if (key_id == EVP_PKEY_ED25519) return "ed25519";
    if (key_id == EVP_PKEY_X25519) return "x25519";
    if (key_id == EVP_PKEY_X448) return "x448";
    if (key_id == EVP_PKEY_ED448) return "ed448";
    return NULL;
}

static JSValueRef ct_raw_pkey_part_to_js(JSContextRef ctx, EVP_PKEY *pkey, bool private_part, JSValueRef *exception) {
    size_t len = 0;
    int ok = private_part
        ? EVP_PKEY_get_raw_private_key(pkey, NULL, &len)
        : EVP_PKEY_get_raw_public_key(pkey, NULL, &len);
    if (ok != 1 || len == 0) {
        ct_throw_message(ctx, exception, private_part ? "Failed to read raw private key" : "Failed to read raw public key");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *buffer = (uint8_t *)malloc(len);
    if (buffer == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    ok = private_part
        ? EVP_PKEY_get_raw_private_key(pkey, buffer, &len)
        : EVP_PKEY_get_raw_public_key(pkey, buffer, &len);
    if (ok != 1) {
        free(buffer);
        ct_throw_message(ctx, exception, private_part ? "Failed to read raw private key" : "Failed to read raw public key");
        return JSValueMakeUndefined(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, buffer, len, ct_array_buffer_free, NULL, exception);
}

static JSObjectRef ct_js_from_ec_pkey(JSContextRef ctx, EVP_PKEY *pkey, const char *key_type, JSValueRef *exception) {
    EC_KEY *ec = EVP_PKEY_get1_EC_KEY(pkey);
    if (ec == NULL) {
        ct_throw_message(ctx, exception, "Imported key is not an EC key");
        return NULL;
    }
    const EC_GROUP *group = EC_KEY_get0_group(ec);
    int nid = group != NULL ? EC_GROUP_get_curve_name(group) : NID_undef;
    const char *curve_name = ct_ec_curve_name_from_nid(nid);
    if (curve_name == NULL || !ct_ec_key_ensure_public(ec)) {
        EC_KEY_free(ec);
        ct_throw_message(ctx, exception, "Unsupported EC key curve");
        return NULL;
    }

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "asymmetricKeyType", ct_make_string(ctx, "ec"), exception);
    ct_set_property(ctx, result, "type", ct_make_string(ctx, key_type), exception);
    ct_set_property(ctx, result, "namedCurve", ct_make_string(ctx, curve_name), exception);
    ct_set_property(ctx, result, "publicKey", ct_ec_public_to_js(ctx, ec, exception), exception);
    if (strcasecmp(key_type, "private") == 0) {
        const BIGNUM *private_bn = EC_KEY_get0_private_key(ec);
        if (private_bn == NULL) {
            EC_KEY_free(ec);
            ct_throw_message(ctx, exception, "Imported EC private key is missing private key material");
            return NULL;
        }
        ct_set_property(ctx, result, "privateKey", ct_js_from_bn(ctx, private_bn, exception), exception);
    }
    EC_KEY_free(ec);
    return result;
}

static JSObjectRef ct_js_from_raw_pkey(JSContextRef ctx, EVP_PKEY *pkey, const char *key_type, JSValueRef *exception) {
    const char *type_name = ct_raw_key_name_from_id(EVP_PKEY_base_id(pkey));
    if (type_name == NULL) {
        ct_throw_message(ctx, exception, "Unsupported raw key type");
        return NULL;
    }
    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "asymmetricKeyType", ct_make_string(ctx, type_name), exception);
    ct_set_property(ctx, result, "type", ct_make_string(ctx, key_type), exception);
    ct_set_property(ctx, result, "publicKey", ct_raw_pkey_part_to_js(ctx, pkey, false, exception), exception);
    if (strcasecmp(key_type, "private") == 0) {
        ct_set_property(ctx, result, "privateKey", ct_raw_pkey_part_to_js(ctx, pkey, true, exception), exception);
    }
    return result;
}

static JSObjectRef ct_js_from_evp_pkey(JSContextRef ctx, EVP_PKEY *pkey, const char *key_type, JSValueRef *exception) {
    int key_id = EVP_PKEY_base_id(pkey);
    if (key_id == EVP_PKEY_RSA || key_id == EVP_PKEY_RSA_PSS) return ct_js_from_rsa_pkey(ctx, pkey, key_type, exception);
    if (key_id == EVP_PKEY_EC) return ct_js_from_ec_pkey(ctx, pkey, key_type, exception);
    if (ct_raw_key_name_from_id(key_id) != NULL) return ct_js_from_raw_pkey(ctx, pkey, key_type, exception);
    ct_throw_message(ctx, exception, "Invalid encoded key type");
    return NULL;
}

static EVP_PKEY *ct_ec_pkey_from_js(JSContextRef ctx, const char *curve_name, JSValueRef key_value, bool private_key) {
    uint8_t *key_bytes = NULL;
    size_t key_len = 0;
    if (ct_get_bytes(ctx, key_value, &key_bytes, &key_len) != 0 || key_len == 0) return NULL;
    EC_KEY *ec = private_key
        ? ct_ec_key_from_private(curve_name, key_bytes, key_len)
        : ct_ec_key_from_public(curve_name, key_bytes, key_len);
    if (ec == NULL) return NULL;
    EVP_PKEY *pkey = EVP_PKEY_new();
    if (pkey == NULL || EVP_PKEY_assign_EC_KEY(pkey, ec) != 1) {
        if (pkey != NULL) EVP_PKEY_free(pkey);
        EC_KEY_free(ec);
        return NULL;
    }
    return pkey;
}

static int ct_write_generic_pkey(BIO *bio, EVP_PKEY *pkey, bool private_key, bool pem) {
    if (pem) {
        return private_key
            ? PEM_write_bio_PrivateKey(bio, pkey, NULL, NULL, 0, NULL, NULL)
            : PEM_write_bio_PUBKEY(bio, pkey);
    }
    return private_key
        ? i2d_PKCS8PrivateKey_bio(bio, pkey, NULL, NULL, 0, NULL, NULL)
        : i2d_PUBKEY_bio(bio, pkey);
}

static int ct_rsa_padding_from_node(int node_padding) {
    if (node_padding == 6) return RSA_PKCS1_PSS_PADDING;
    return RSA_PKCS1_PADDING;
}

static int ct_rsa_configure_pkey_ctx(EVP_PKEY_CTX *pkey_ctx, int node_padding, int salt_len, const EVP_MD *md, bool signing) {
    if (pkey_ctx == NULL) return 0;
    int padding = ct_rsa_padding_from_node(node_padding);
    if (EVP_PKEY_CTX_set_rsa_padding(pkey_ctx, padding) != 1) return 0;
    if (padding == RSA_PKCS1_PSS_PADDING) {
        int effective_salt_len = salt_len;
        if (effective_salt_len == 0) effective_salt_len = signing ? RSA_PSS_SALTLEN_MAX_SIGN : RSA_PSS_SALTLEN_AUTO;
        if (EVP_PKEY_CTX_set_rsa_mgf1_md(pkey_ctx, md) != 1) return 0;
        if (EVP_PKEY_CTX_set_rsa_pss_saltlen(pkey_ctx, effective_salt_len) != 1) return 0;
    }
    return 1;
}
#endif

static JSValueRef ct_crypto_rsa_export_key(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 11) {
        ct_throw_message(ctx, exception, "cottontail.cryptoRsaExportKey requires key type, format, encoding type, and RSA parts");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *key_type = ct_value_to_string_copy(ctx, argv[0]);
    char *format = ct_value_to_string_copy(ctx, argv[1]);
    char *encoding_type = ct_value_to_string_copy(ctx, argv[2]);
    if (key_type == NULL || format == NULL || encoding_type == NULL) {
        free(key_type);
        free(format);
        free(encoding_type);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    bool private_key = strcasecmp(key_type, "private") == 0;
    bool pem = strcasecmp(format, "pem") == 0;
    bool pkcs1 = strcasecmp(encoding_type, "pkcs1") == 0;
    EVP_PKEY *pkey = ct_rsa_pkey_from_js(ctx, argv, 3, private_key);
    BIO *bio = BIO_new(BIO_s_mem());
    if (pkey == NULL || bio == NULL) {
        if (pkey != NULL) EVP_PKEY_free(pkey);
        if (bio != NULL) BIO_free(bio);
        free(key_type);
        free(format);
        free(encoding_type);
        ct_throw_message(ctx, exception, "Failed to initialize RSA key export");
        return JSValueMakeUndefined(ctx);
    }

    int ok = 0;
    RSA *rsa = pkcs1 ? EVP_PKEY_get1_RSA(pkey) : NULL;
    if (pem) {
        if (private_key && pkcs1) ok = PEM_write_bio_RSAPrivateKey(bio, rsa, NULL, NULL, 0, NULL, NULL);
        else if (private_key) ok = PEM_write_bio_PrivateKey(bio, pkey, NULL, NULL, 0, NULL, NULL);
        else if (pkcs1) ok = PEM_write_bio_RSAPublicKey(bio, rsa);
        else ok = PEM_write_bio_PUBKEY(bio, pkey);
    } else {
        if (private_key && pkcs1) ok = i2d_RSAPrivateKey_bio(bio, rsa);
        else if (private_key) ok = i2d_PKCS8PrivateKey_bio(bio, pkey, NULL, NULL, 0, NULL, NULL);
        else if (pkcs1) ok = i2d_RSAPublicKey_bio(bio, rsa);
        else ok = i2d_PUBKEY_bio(bio, pkey);
    }
    if (rsa != NULL) RSA_free(rsa);
    EVP_PKEY_free(pkey);
    free(key_type);
    free(format);
    free(encoding_type);
    if (!ok) {
        BIO_free(bio);
        ct_throw_message(ctx, exception, "RSA key export failed");
        return JSValueMakeUndefined(ctx);
    }
    JSValueRef result = ct_bio_to_js(ctx, bio, pem, exception);
    BIO_free(bio);
    return result;
#else
    ct_throw_message(ctx, exception, "RSA key export is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_ec_export_key(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 5) {
        ct_throw_message(ctx, exception, "cottontail.cryptoEcExportKey requires key type, format, encoding type, curve, and key bytes");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *key_type = ct_value_to_string_copy(ctx, argv[0]);
    char *format = ct_value_to_string_copy(ctx, argv[1]);
    char *encoding_type = ct_value_to_string_copy(ctx, argv[2]);
    char *curve_name = ct_value_to_string_copy(ctx, argv[3]);
    if (key_type == NULL || format == NULL || encoding_type == NULL || curve_name == NULL) {
        free(key_type);
        free(format);
        free(encoding_type);
        free(curve_name);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    bool private_key = strcasecmp(key_type, "private") == 0;
    bool pem = strcasecmp(format, "pem") == 0;
    bool sec1 = strcasecmp(encoding_type, "sec1") == 0;
    EVP_PKEY *pkey = ct_ec_pkey_from_js(ctx, curve_name, argv[4], private_key);
    BIO *bio = BIO_new(BIO_s_mem());
    free(key_type);
    free(format);
    free(curve_name);
    if (pkey == NULL || bio == NULL) {
        if (pkey != NULL) EVP_PKEY_free(pkey);
        if (bio != NULL) BIO_free(bio);
        free(encoding_type);
        ct_throw_message(ctx, exception, "Failed to initialize EC key export");
        return JSValueMakeUndefined(ctx);
    }

    int ok = 0;
    if (sec1) {
        EC_KEY *ec = EVP_PKEY_get1_EC_KEY(pkey);
        if (private_key && ec != NULL) {
            ok = pem
                ? PEM_write_bio_ECPrivateKey(bio, ec, NULL, NULL, 0, NULL, NULL)
                : i2d_ECPrivateKey_bio(bio, ec);
        }
        if (ec != NULL) EC_KEY_free(ec);
    } else {
        ok = ct_write_generic_pkey(bio, pkey, private_key, pem);
    }
    EVP_PKEY_free(pkey);
    free(encoding_type);
    if (!ok) {
        BIO_free(bio);
        ct_throw_message(ctx, exception, "EC key export failed");
        return JSValueMakeUndefined(ctx);
    }
    JSValueRef result = ct_bio_to_js(ctx, bio, pem, exception);
    BIO_free(bio);
    return result;
#else
    ct_throw_message(ctx, exception, "EC key export is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_raw_export_key(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 5) {
        ct_throw_message(ctx, exception, "cottontail.cryptoRawExportKey requires key type, format, encoding type, raw key type, and key bytes");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *key_type = ct_value_to_string_copy(ctx, argv[0]);
    char *format = ct_value_to_string_copy(ctx, argv[1]);
    char *raw_type = ct_value_to_string_copy(ctx, argv[3]);
    if (key_type == NULL || format == NULL || raw_type == NULL) {
        free(key_type);
        free(format);
        free(raw_type);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    bool private_key = strcasecmp(key_type, "private") == 0;
    bool pem = strcasecmp(format, "pem") == 0;
    int pkey_id = ct_raw_key_type_id(raw_type);
    uint8_t *key_bytes = NULL;
    size_t key_len = 0;
    if (pkey_id == 0 || ct_get_bytes(ctx, argv[4], &key_bytes, &key_len) != 0 || key_len == 0) {
        free(key_type);
        free(format);
        free(raw_type);
        ct_throw_message(ctx, exception, "Invalid raw key export input");
        return JSValueMakeUndefined(ctx);
    }
    EVP_PKEY *pkey = private_key
        ? EVP_PKEY_new_raw_private_key(pkey_id, NULL, key_bytes, key_len)
        : EVP_PKEY_new_raw_public_key(pkey_id, NULL, key_bytes, key_len);
    BIO *bio = BIO_new(BIO_s_mem());
    free(key_type);
    free(raw_type);
    if (pkey == NULL || bio == NULL) {
        if (pkey != NULL) EVP_PKEY_free(pkey);
        if (bio != NULL) BIO_free(bio);
        free(format);
        ct_throw_message(ctx, exception, "Failed to initialize raw key export");
        return JSValueMakeUndefined(ctx);
    }
    int ok = ct_write_generic_pkey(bio, pkey, private_key, pem);
    EVP_PKEY_free(pkey);
    free(format);
    if (!ok) {
        BIO_free(bio);
        ct_throw_message(ctx, exception, "Raw key export failed");
        return JSValueMakeUndefined(ctx);
    }
    JSValueRef result = ct_bio_to_js(ctx, bio, pem, exception);
    BIO_free(bio);
    return result;
#else
    ct_throw_message(ctx, exception, "Raw key export is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static NETSCAPE_SPKI *ct_spkac_from_js(JSContextRef ctx, JSValueRef value) {
#if CT_HAS_OPENSSL
    uint8_t *data = NULL;
    size_t data_len = 0;
    if (ct_get_bytes(ctx, value, &data, &data_len) != 0 || data_len == 0 || data_len > INT_MAX) return NULL;
    return NETSCAPE_SPKI_b64_decode((const char *)data, (int)data_len);
#else
    (void)ctx;
    (void)value;
    return NULL;
#endif
}

static JSValueRef ct_crypto_spkac_verify(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.cryptoSpkacVerify(spkac) requires SPKAC data");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    NETSCAPE_SPKI *spki = ct_spkac_from_js(ctx, argv[0]);
    if (spki == NULL) return JSValueMakeBoolean(ctx, false);
    EVP_PKEY *pkey = NETSCAPE_SPKI_get_pubkey(spki);
    int ok = pkey != NULL ? NETSCAPE_SPKI_verify(spki, pkey) : 0;
    if (pkey != NULL) EVP_PKEY_free(pkey);
    NETSCAPE_SPKI_free(spki);
    return JSValueMakeBoolean(ctx, ok == 1);
#else
    ct_throw_message(ctx, exception, "SPKAC verification is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_spkac_export_public_key(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.cryptoSpkacExportPublicKey(spkac) requires SPKAC data");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    NETSCAPE_SPKI *spki = ct_spkac_from_js(ctx, argv[0]);
    if (spki == NULL) return ct_array_buffer_from_copy(ctx, "", 0, exception);
    EVP_PKEY *pkey = NETSCAPE_SPKI_get_pubkey(spki);
    BIO *bio = pkey != NULL ? BIO_new(BIO_s_mem()) : NULL;
    int ok = bio != NULL && PEM_write_bio_PUBKEY(bio, pkey) == 1;
    if (pkey != NULL) EVP_PKEY_free(pkey);
    NETSCAPE_SPKI_free(spki);
    if (!ok) {
        if (bio != NULL) BIO_free(bio);
        return ct_array_buffer_from_copy(ctx, "", 0, exception);
    }
    JSValueRef result = ct_bio_to_js(ctx, bio, false, exception);
    BIO_free(bio);
    return result;
#else
    ct_throw_message(ctx, exception, "SPKAC public key export is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static EVP_PKEY *ct_read_pem_key_from_bytes(const uint8_t *data, size_t data_len, bool private_key) {
#if CT_HAS_OPENSSL
    ERR_clear_error();
    BIO *bio = BIO_new_mem_buf(data, (int)data_len);
    if (bio == NULL) return NULL;
    EVP_PKEY *pkey = private_key ? PEM_read_bio_PrivateKey(bio, NULL, NULL, NULL) : PEM_read_bio_PUBKEY(bio, NULL, NULL, NULL);
    BIO_free(bio);
    if (pkey != NULL) return pkey;
    ERR_clear_error();
    if (private_key) return NULL;

    bio = BIO_new_mem_buf(data, (int)data_len);
    if (bio == NULL) return NULL;
    RSA *rsa = PEM_read_bio_RSAPublicKey(bio, NULL, NULL, NULL);
    BIO_free(bio);
    if (rsa != NULL) {
        pkey = EVP_PKEY_new();
        if (pkey == NULL || EVP_PKEY_assign_RSA(pkey, rsa) != 1) {
            if (pkey != NULL) EVP_PKEY_free(pkey);
            RSA_free(rsa);
            ERR_clear_error();
            return NULL;
        }
        return pkey;
    }
    ERR_clear_error();

    bio = BIO_new_mem_buf(data, (int)data_len);
    if (bio == NULL) return NULL;
    X509 *certificate = PEM_read_bio_X509(bio, NULL, NULL, NULL);
    BIO_free(bio);
    if (certificate == NULL) {
        ERR_clear_error();
        return NULL;
    }
    pkey = X509_get_pubkey(certificate);
    X509_free(certificate);
    if (pkey == NULL) ERR_clear_error();
    return pkey;
#else
    (void)data;
    (void)data_len;
    (void)private_key;
    return NULL;
#endif
}

static EVP_PKEY *ct_read_der_key_from_bytes(const uint8_t *data, size_t data_len, bool private_key) {
#if CT_HAS_OPENSSL
    BIO *bio = BIO_new_mem_buf(data, (int)data_len);
    if (bio == NULL) return NULL;
    EVP_PKEY *pkey = private_key ? d2i_PrivateKey_bio(bio, NULL) : d2i_PUBKEY_bio(bio, NULL);
    BIO_free(bio);
    if (pkey != NULL || private_key) return pkey;

    bio = BIO_new_mem_buf(data, (int)data_len);
    if (bio == NULL) return NULL;
    RSA *rsa = d2i_RSAPublicKey_bio(bio, NULL);
    BIO_free(bio);
    if (rsa == NULL) return NULL;
    pkey = EVP_PKEY_new();
    if (pkey == NULL || EVP_PKEY_assign_RSA(pkey, rsa) != 1) {
        if (pkey != NULL) EVP_PKEY_free(pkey);
        RSA_free(rsa);
        return NULL;
    }
    return pkey;
#else
    (void)data;
    (void)data_len;
    (void)private_key;
    return NULL;
#endif
}

static JSValueRef ct_crypto_import_key(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 4) {
        ct_throw_message(ctx, exception, "cottontail.cryptoImportKey(type, format, keyType, data) requires four arguments");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *requested_type = ct_value_to_string_copy(ctx, argv[0]);
    char *format = ct_value_to_string_copy(ctx, argv[1]);
    if (requested_type == NULL || format == NULL) {
        free(requested_type);
        free(format);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *data = NULL;
    size_t data_len = 0;
    if (ct_get_bytes(ctx, argv[3], &data, &data_len) != 0 || data_len == 0) {
        free(requested_type);
        free(format);
        ct_throw_message(ctx, exception, "Encoded key data must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }
    bool private_key = strcasecmp(requested_type, "public") != 0;
    EVP_PKEY *pkey = NULL;
    if (strcasecmp(format, "der") == 0) {
        pkey = ct_read_der_key_from_bytes(data, data_len, private_key);
    } else {
        pkey = ct_read_pem_key_from_bytes(data, data_len, private_key);
    }
    bool output_private = private_key;
    if (pkey == NULL && private_key) {
        pkey = strcasecmp(format, "der") == 0
            ? ct_read_der_key_from_bytes(data, data_len, false)
            : ct_read_pem_key_from_bytes(data, data_len, false);
        output_private = false;
    } else if (pkey == NULL && !private_key) {
        pkey = strcasecmp(format, "der") == 0
            ? ct_read_der_key_from_bytes(data, data_len, true)
            : ct_read_pem_key_from_bytes(data, data_len, true);
        output_private = false;
    }
    free(format);
    if (pkey == NULL) {
        free(requested_type);
        ct_throw_message(ctx, exception, "Failed to parse encoded key");
        return JSValueMakeUndefined(ctx);
    }
    JSObjectRef result = ct_js_from_evp_pkey(ctx, pkey, output_private ? "private" : "public", exception);
    EVP_PKEY_free(pkey);
    free(requested_type);
    return result != NULL ? result : JSValueMakeUndefined(ctx);
#else
    ct_throw_message(ctx, exception, "Encoded key import is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_rsa_sign(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 12) {
        ct_throw_message(ctx, exception, "cottontail.cryptoRsaSign requires algorithm, padding, saltLength, RSA private parts, and data");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *algorithm_name = ct_value_to_string_copy(ctx, argv[0]);
    if (algorithm_name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    const EVP_MD *md = EVP_get_digestbyname(algorithm_name);
    free(algorithm_name);
    if (md == NULL) {
        ct_throw_message(ctx, exception, "Unsupported RSA digest algorithm");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *data = NULL;
    size_t data_len = 0;
    if (ct_get_bytes(ctx, argv[11], &data, &data_len) != 0) {
        ct_throw_message(ctx, exception, "RSA sign data must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }
    EVP_PKEY *pkey = ct_rsa_pkey_from_js(ctx, argv, 3, true);
    EVP_MD_CTX *md_ctx = EVP_MD_CTX_new();
    if (pkey == NULL || md_ctx == NULL) {
        if (pkey != NULL) EVP_PKEY_free(pkey);
        if (md_ctx != NULL) EVP_MD_CTX_free(md_ctx);
        ct_throw_message(ctx, exception, "Failed to initialize RSA signer");
        return JSValueMakeUndefined(ctx);
    }
    EVP_PKEY_CTX *pkey_ctx = NULL;
    int node_padding = (int)ct_value_to_number(ctx, argv[1]);
    int salt_len = (int)ct_value_to_number(ctx, argv[2]);
    int ok = EVP_DigestSignInit(md_ctx, &pkey_ctx, md, NULL, pkey) == 1 &&
        ct_rsa_configure_pkey_ctx(pkey_ctx, node_padding, salt_len, md, true) &&
        EVP_DigestSignUpdate(md_ctx, data, data_len) == 1;
    size_t signature_len = 0;
    if (ok) ok = EVP_DigestSignFinal(md_ctx, NULL, &signature_len) == 1;
    uint8_t *signature = ok ? (uint8_t *)malloc(signature_len) : NULL;
    if (signature == NULL) ok = 0;
    if (ok) ok = EVP_DigestSignFinal(md_ctx, signature, &signature_len) == 1;
    EVP_MD_CTX_free(md_ctx);
    EVP_PKEY_free(pkey);
    if (!ok) {
        free(signature);
        ct_throw_message(ctx, exception, "RSA signing failed");
        return JSValueMakeUndefined(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, signature, signature_len, ct_array_buffer_free, NULL, exception);
#else
    ct_throw_message(ctx, exception, "RSA signing is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_rsa_verify(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 7) {
        ct_throw_message(ctx, exception, "cottontail.cryptoRsaVerify requires algorithm, padding, saltLength, RSA public parts, data, and signature");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *algorithm_name = ct_value_to_string_copy(ctx, argv[0]);
    if (algorithm_name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    const EVP_MD *md = EVP_get_digestbyname(algorithm_name);
    free(algorithm_name);
    if (md == NULL) {
        ct_throw_message(ctx, exception, "Unsupported RSA digest algorithm");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *data = NULL;
    size_t data_len = 0;
    uint8_t *signature = NULL;
    size_t signature_len = 0;
    if (ct_get_bytes(ctx, argv[5], &data, &data_len) != 0 || ct_get_bytes(ctx, argv[6], &signature, &signature_len) != 0) {
        ct_throw_message(ctx, exception, "RSA verify data and signature must be ArrayBuffers or typed arrays");
        return JSValueMakeUndefined(ctx);
    }
    EVP_PKEY *pkey = ct_rsa_pkey_from_js(ctx, argv, 3, false);
    EVP_MD_CTX *md_ctx = EVP_MD_CTX_new();
    if (pkey == NULL || md_ctx == NULL) {
        if (pkey != NULL) EVP_PKEY_free(pkey);
        if (md_ctx != NULL) EVP_MD_CTX_free(md_ctx);
        ct_throw_message(ctx, exception, "Failed to initialize RSA verifier");
        return JSValueMakeUndefined(ctx);
    }
    EVP_PKEY_CTX *pkey_ctx = NULL;
    int node_padding = (int)ct_value_to_number(ctx, argv[1]);
    int salt_len = (int)ct_value_to_number(ctx, argv[2]);
    int ok = EVP_DigestVerifyInit(md_ctx, &pkey_ctx, md, NULL, pkey) == 1 &&
        ct_rsa_configure_pkey_ctx(pkey_ctx, node_padding, salt_len, md, false) &&
        EVP_DigestVerifyUpdate(md_ctx, data, data_len) == 1;
    int status = ok ? EVP_DigestVerifyFinal(md_ctx, signature, signature_len) : 0;
    EVP_MD_CTX_free(md_ctx);
    EVP_PKEY_free(pkey);
    return JSValueMakeBoolean(ctx, status == 1);
#else
    ct_throw_message(ctx, exception, "RSA verification is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_ec_generate_key_pair(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.cryptoEcGenerateKeyPair(curve) requires a curve name");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *curve_name = ct_value_to_string_copy(ctx, argv[0]);
    if (curve_name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    int nid = ct_ec_curve_nid(curve_name);
    if (nid == NID_undef) {
        free(curve_name);
        ct_throw_message(ctx, exception, "Unknown EC curve");
        return JSValueMakeUndefined(ctx);
    }
    EC_KEY *key = EC_KEY_new_by_curve_name(nid);
    if (key == NULL || EC_KEY_generate_key(key) != 1) {
        if (key != NULL) EC_KEY_free(key);
        free(curve_name);
        ct_throw_message(ctx, exception, "Failed to generate EC key pair");
        return JSValueMakeUndefined(ctx);
    }
    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "privateKey", ct_ec_private_to_js(ctx, key, exception), exception);
    ct_set_property(ctx, result, "publicKey", ct_ec_public_to_js(ctx, key, exception), exception);
    EC_KEY_free(key);
    free(curve_name);
    return result;
#else
    ct_throw_message(ctx, exception, "EC key generation is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_ec_public_from_private(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.cryptoEcPublicFromPrivate(curve, privateKey) requires a curve and private key");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *curve_name = ct_value_to_string_copy(ctx, argv[0]);
    uint8_t *private_key = NULL;
    size_t private_len = 0;
    if (curve_name == NULL || ct_get_bytes(ctx, argv[1], &private_key, &private_len) != 0) {
        free(curve_name);
        ct_throw_message(ctx, exception, "Invalid EC private key input");
        return JSValueMakeUndefined(ctx);
    }
    EC_KEY *key = ct_ec_key_from_private(curve_name, private_key, private_len);
    free(curve_name);
    if (key == NULL) {
        ct_throw_message(ctx, exception, "Invalid EC private key");
        return JSValueMakeUndefined(ctx);
    }
    JSValueRef result = ct_ec_public_to_js(ctx, key, exception);
    EC_KEY_free(key);
    return result;
#else
    ct_throw_message(ctx, exception, "EC public key derivation is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_ec_sign(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "cottontail.cryptoEcSign(curve, privateKey, digest) requires a curve, private key, and digest");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *curve_name = ct_value_to_string_copy(ctx, argv[0]);
    uint8_t *private_key = NULL;
    size_t private_len = 0;
    uint8_t *digest = NULL;
    size_t digest_len = 0;
    if (curve_name == NULL || ct_get_bytes(ctx, argv[1], &private_key, &private_len) != 0 || ct_get_bytes(ctx, argv[2], &digest, &digest_len) != 0) {
        free(curve_name);
        ct_throw_message(ctx, exception, "Invalid EC signing input");
        return JSValueMakeUndefined(ctx);
    }
    EC_KEY *key = ct_ec_key_from_private(curve_name, private_key, private_len);
    free(curve_name);
    if (key == NULL) {
        ct_throw_message(ctx, exception, "Invalid EC private key");
        return JSValueMakeUndefined(ctx);
    }
    unsigned int signature_len = ECDSA_size(key);
    uint8_t *signature = (uint8_t *)malloc(signature_len);
    if (signature == NULL) {
        EC_KEY_free(key);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    int ok = ECDSA_sign(0, digest, (int)digest_len, signature, &signature_len, key) == 1;
    EC_KEY_free(key);
    if (!ok) {
        free(signature);
        ct_throw_message(ctx, exception, "EC signing failed");
        return JSValueMakeUndefined(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, signature, signature_len, ct_array_buffer_free, NULL, exception);
#else
    ct_throw_message(ctx, exception, "EC signing is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_ec_verify(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 4) {
        ct_throw_message(ctx, exception, "cottontail.cryptoEcVerify(curve, publicKey, digest, signature) requires a curve, public key, digest, and signature");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *curve_name = ct_value_to_string_copy(ctx, argv[0]);
    uint8_t *public_key = NULL;
    size_t public_len = 0;
    uint8_t *digest = NULL;
    size_t digest_len = 0;
    uint8_t *signature = NULL;
    size_t signature_len = 0;
    if (curve_name == NULL || ct_get_bytes(ctx, argv[1], &public_key, &public_len) != 0 ||
        ct_get_bytes(ctx, argv[2], &digest, &digest_len) != 0 ||
        ct_get_bytes(ctx, argv[3], &signature, &signature_len) != 0) {
        free(curve_name);
        ct_throw_message(ctx, exception, "Invalid EC verification input");
        return JSValueMakeUndefined(ctx);
    }
    EC_KEY *key = ct_ec_key_from_public(curve_name, public_key, public_len);
    free(curve_name);
    if (key == NULL) {
        ct_throw_message(ctx, exception, "Invalid EC public key");
        return JSValueMakeUndefined(ctx);
    }
    int status = ECDSA_verify(0, digest, (int)digest_len, signature, (int)signature_len, key);
    EC_KEY_free(key);
    return JSValueMakeBoolean(ctx, status == 1);
#else
    ct_throw_message(ctx, exception, "EC verification is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_ec_diffie_hellman(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "cottontail.cryptoEcDiffieHellman(curve, privateKey, publicKey) requires a curve, private key, and public key");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *curve_name = ct_value_to_string_copy(ctx, argv[0]);
    uint8_t *private_key = NULL;
    size_t private_len = 0;
    uint8_t *public_key = NULL;
    size_t public_len = 0;
    if (curve_name == NULL || ct_get_bytes(ctx, argv[1], &private_key, &private_len) != 0 || ct_get_bytes(ctx, argv[2], &public_key, &public_len) != 0) {
        free(curve_name);
        ct_throw_message(ctx, exception, "Invalid EC Diffie-Hellman input");
        return JSValueMakeUndefined(ctx);
    }
    EC_KEY *private_ec = ct_ec_key_from_private(curve_name, private_key, private_len);
    EC_KEY *public_ec = ct_ec_key_from_public(curve_name, public_key, public_len);
    free(curve_name);
    if (private_ec == NULL || public_ec == NULL) {
        if (private_ec != NULL) EC_KEY_free(private_ec);
        if (public_ec != NULL) EC_KEY_free(public_ec);
        ct_throw_message(ctx, exception, "Invalid EC Diffie-Hellman key");
        return JSValueMakeUndefined(ctx);
    }
    const EC_GROUP *group = EC_KEY_get0_group(private_ec);
    int field_size = EC_GROUP_get_degree(group);
    size_t secret_len = (size_t)((field_size + 7) / 8);
    uint8_t *secret = (uint8_t *)malloc(secret_len);
    if (secret == NULL) {
        EC_KEY_free(private_ec);
        EC_KEY_free(public_ec);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    int actual_len = ECDH_compute_key(secret, secret_len, EC_KEY_get0_public_key(public_ec), private_ec, NULL);
    EC_KEY_free(private_ec);
    EC_KEY_free(public_ec);
    if (actual_len <= 0) {
        free(secret);
        ct_throw_message(ctx, exception, "EC Diffie-Hellman failed");
        return JSValueMakeUndefined(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, secret, (size_t)actual_len, ct_array_buffer_free, NULL, exception);
#else
    ct_throw_message(ctx, exception, "EC Diffie-Hellman is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
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

#if defined(__APPLE__)
typedef struct {
    const char *name;
    size_t key_len;
    size_t iv_len;
    CCMode mode;
} CtCipherAlgorithm;

static const CtCipherAlgorithm *ct_cipher_algorithm(const char *name) {
    static const CtCipherAlgorithm algorithms[] = {
        {"aes-128-cbc", 16, 16, kCCModeCBC},
        {"aes-192-cbc", 24, 16, kCCModeCBC},
        {"aes-256-cbc", 32, 16, kCCModeCBC},
        {"aes-128-ctr", 16, 16, kCCModeCTR},
        {"aes-192-ctr", 24, 16, kCCModeCTR},
        {"aes-256-ctr", 32, 16, kCCModeCTR},
        {"aes-128-cfb", 16, 16, kCCModeCFB},
        {"aes-192-cfb", 24, 16, kCCModeCFB},
        {"aes-256-cfb", 32, 16, kCCModeCFB},
        {"aes-128-cfb8", 16, 16, kCCModeCFB8},
        {"aes-192-cfb8", 24, 16, kCCModeCFB8},
        {"aes-256-cfb8", 32, 16, kCCModeCFB8},
        {"aes-128-ofb", 16, 16, kCCModeOFB},
        {"aes-192-ofb", 24, 16, kCCModeOFB},
        {"aes-256-ofb", 32, 16, kCCModeOFB},
        {"aes-128-ecb", 16, 0, kCCModeECB},
        {"aes-192-ecb", 24, 0, kCCModeECB},
        {"aes-256-ecb", 32, 0, kCCModeECB},
    };
    for (size_t index = 0; index < sizeof(algorithms) / sizeof(algorithms[0]); index += 1) {
        if (strcasecmp(name, algorithms[index].name) == 0) return &algorithms[index];
    }
    return NULL;
}
#endif

static CtCryptoCipher *ct_crypto_cipher_find(uint32_t id) {
    CtCryptoCipher *cursor = ct_crypto_ciphers;
    while (cursor != NULL) {
        if (cursor->id == id) return cursor;
        cursor = cursor->next;
    }
    return NULL;
}

static void ct_crypto_cipher_remove(CtCryptoCipher *cipher) {
    if (cipher == NULL) return;
    CtCryptoCipher **cursor = &ct_crypto_ciphers;
    while (*cursor != NULL) {
        if (*cursor == cipher) {
            *cursor = cipher->next;
            break;
        }
        cursor = &(*cursor)->next;
    }
#if defined(__APPLE__)
    if (cipher->cryptor != NULL) CCCryptorRelease(cipher->cryptor);
#endif
#if CT_HAS_OPENSSL
    if (cipher->evp_cipher != NULL) EVP_CIPHER_CTX_free(cipher->evp_cipher);
#endif
    free(cipher);
}

#if CT_HAS_OPENSSL
static const char *ct_evp_cipher_mode_name(const EVP_CIPHER *cipher) {
    switch (EVP_CIPHER_get_mode(cipher)) {
        case EVP_CIPH_ECB_MODE: return "ecb";
        case EVP_CIPH_CBC_MODE: return "cbc";
        case EVP_CIPH_CFB_MODE: return "cfb";
        case EVP_CIPH_OFB_MODE: return "ofb";
        case EVP_CIPH_CTR_MODE: return "ctr";
        case EVP_CIPH_GCM_MODE: return "gcm";
        case EVP_CIPH_CCM_MODE: return "ccm";
        case EVP_CIPH_XTS_MODE: return "xts";
        case EVP_CIPH_WRAP_MODE: return "wrap";
        case EVP_CIPH_OCB_MODE: return "ocb";
        case EVP_CIPH_SIV_MODE: return "siv";
#ifdef EVP_CIPH_GCM_SIV_MODE
        case EVP_CIPH_GCM_SIV_MODE: return "gcm-siv";
#endif
        case EVP_CIPH_STREAM_CIPHER: return "stream";
        default: return "unknown";
    }
}

static JSObjectRef ct_evp_cipher_info_object(JSContextRef ctx, const EVP_CIPHER *cipher, JSValueRef *exception) {
    JSObjectRef result = ct_make_object(ctx);
    const char *name = EVP_CIPHER_get0_name(cipher);
    ct_set_property(ctx, result, "name", ct_make_string(ctx, name != NULL ? name : ""), exception);
    ct_set_property(ctx, result, "nid", JSValueMakeNumber(ctx, EVP_CIPHER_get_nid(cipher)), exception);
    ct_set_property(ctx, result, "mode", ct_make_string(ctx, ct_evp_cipher_mode_name(cipher)), exception);
    ct_set_property(ctx, result, "blockSize", JSValueMakeNumber(ctx, EVP_CIPHER_get_block_size(cipher)), exception);
    ct_set_property(ctx, result, "keyLength", JSValueMakeNumber(ctx, EVP_CIPHER_get_key_length(cipher)), exception);
    int iv_len = EVP_CIPHER_get_iv_length(cipher);
    if (iv_len > 0) ct_set_property(ctx, result, "ivLength", JSValueMakeNumber(ctx, iv_len), exception);
    if ((EVP_CIPHER_get_flags(cipher) & EVP_CIPH_FLAG_AEAD_CIPHER) != 0) {
        ct_set_property(ctx, result, "authTagLength", JSValueMakeNumber(ctx, 16), exception);
    }
    return result;
}
#endif

static JSValueRef ct_crypto_cipher_info(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.cryptoCipherInfo(name) requires a cipher name");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    char *name = ct_value_to_string_copy(ctx, argv[0]);
    if (name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    const EVP_CIPHER *cipher = EVP_get_cipherbyname(name);
    free(name);
    if (cipher == NULL) return JSValueMakeUndefined(ctx);
    return ct_evp_cipher_info_object(ctx, cipher, exception);
#else
    ct_throw_message(ctx, exception, "Cipher metadata is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

#if CT_HAS_OPENSSL
typedef struct {
    JSContextRef ctx;
    JSObjectRef array;
    unsigned index;
    JSValueRef *exception;
} CtCipherListContext;

static void ct_cipher_list_callback(const EVP_CIPHER *cipher, const char *from, const char *to, void *arg) {
    (void)to;
    CtCipherListContext *list = (CtCipherListContext *)arg;
    const char *name = from != NULL ? from : (cipher != NULL ? EVP_CIPHER_get0_name(cipher) : NULL);
    if (name == NULL || name[0] == '\0') return;
    JSObjectSetPropertyAtIndex(list->ctx, list->array, list->index++, ct_make_string(list->ctx, name), list->exception);
}
#endif

static JSValueRef ct_crypto_get_ciphers(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
#if CT_HAS_OPENSSL
    JSObjectRef array = ct_make_array(ctx, 0, NULL, exception);
    CtCipherListContext list = { ctx, array, 0, exception };
    EVP_CIPHER_do_all_sorted(ct_cipher_list_callback, &list);
    return array;
#else
    ct_throw_message(ctx, exception, "Cipher listing is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_cipher_create(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 5) {
        ct_throw_message(ctx, exception, "cottontail.cryptoCipherCreate(algorithm, key, iv, encrypt, autoPadding) requires five arguments");
        return JSValueMakeUndefined(ctx);
    }

    char *algorithm_name = ct_value_to_string_copy(ctx, argv[0]);
    if (algorithm_name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    uint8_t *key = NULL;
    size_t key_len = 0;
    uint8_t *iv = NULL;
    size_t iv_len = 0;
    if (ct_get_bytes(ctx, argv[1], &key, &key_len) != 0 || ct_get_bytes(ctx, argv[2], &iv, &iv_len) != 0) {
        free(algorithm_name);
        ct_throw_message(ctx, exception, "cipher key and iv must be ArrayBuffers or typed arrays");
        return JSValueMakeUndefined(ctx);
    }
    bool encrypt = ct_value_to_bool(ctx, argv[3]);
    bool auto_padding = ct_value_to_bool(ctx, argv[4]);

#if CT_HAS_OPENSSL
    const EVP_CIPHER *evp_cipher = EVP_get_cipherbyname(algorithm_name);
    if (evp_cipher != NULL) {
        int expected_key_len = EVP_CIPHER_get_key_length(evp_cipher);
        int default_iv_len = EVP_CIPHER_get_iv_length(evp_cipher);
        bool is_aead = (EVP_CIPHER_get_flags(evp_cipher) & EVP_CIPH_FLAG_AEAD_CIPHER) != 0;
        if (expected_key_len > 0 && key_len != (size_t)expected_key_len) {
            free(algorithm_name);
            ct_throw_message(ctx, exception, "Invalid cipher key length");
            return JSValueMakeUndefined(ctx);
        }
        if (!is_aead && default_iv_len >= 0 && iv_len != (size_t)default_iv_len) {
            free(algorithm_name);
            ct_throw_message(ctx, exception, "Invalid cipher iv length");
            return JSValueMakeUndefined(ctx);
        }
        if (is_aead && iv_len == 0) {
            free(algorithm_name);
            ct_throw_message(ctx, exception, "Invalid cipher iv length");
            return JSValueMakeUndefined(ctx);
        }

        EVP_CIPHER_CTX *evp_ctx = EVP_CIPHER_CTX_new();
        if (evp_ctx == NULL) {
            free(algorithm_name);
            ct_throw_message(ctx, exception, "Failed to allocate cipher context");
            return JSValueMakeUndefined(ctx);
        }
        int ok = EVP_CipherInit_ex(evp_ctx, evp_cipher, NULL, NULL, NULL, encrypt ? 1 : 0) == 1;
        if (ok && is_aead && default_iv_len >= 0 && iv_len != (size_t)default_iv_len) {
            ok = EVP_CIPHER_CTX_ctrl(evp_ctx, EVP_CTRL_AEAD_SET_IVLEN, (int)iv_len, NULL) == 1;
        }
        if (ok && !is_aead) EVP_CIPHER_CTX_set_padding(evp_ctx, auto_padding ? 1 : 0);
        if (ok) ok = EVP_CipherInit_ex(evp_ctx, NULL, NULL, key, iv_len > 0 ? iv : NULL, encrypt ? 1 : 0) == 1;
        if (!ok) {
            EVP_CIPHER_CTX_free(evp_ctx);
            free(algorithm_name);
            ct_throw_message(ctx, exception, "Failed to initialize cipher");
            return JSValueMakeUndefined(ctx);
        }

        CtCryptoCipher *entry = (CtCryptoCipher *)calloc(1, sizeof(CtCryptoCipher));
        if (entry == NULL) {
            EVP_CIPHER_CTX_free(evp_ctx);
            free(algorithm_name);
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        entry->id = ct_next_crypto_cipher_id++;
        if (ct_next_crypto_cipher_id == 0) ct_next_crypto_cipher_id = 1;
        entry->evp_cipher = evp_ctx;
        entry->evp_aead = is_aead;
        entry->evp_encrypt = encrypt;
        entry->next = ct_crypto_ciphers;
        ct_crypto_ciphers = entry;
        free(algorithm_name);
        return JSValueMakeNumber(ctx, entry->id);
    }
#endif

#if defined(__APPLE__)
    const CtCipherAlgorithm *algorithm = ct_cipher_algorithm(algorithm_name);
    free(algorithm_name);
    if (algorithm == NULL) {
        ct_throw_message(ctx, exception, "Unsupported cipher algorithm");
        return JSValueMakeUndefined(ctx);
    }

    if (key_len != algorithm->key_len) {
        ct_throw_message(ctx, exception, "Invalid cipher key length");
        return JSValueMakeUndefined(ctx);
    }
    if (iv_len != algorithm->iv_len) {
        ct_throw_message(ctx, exception, "Invalid cipher iv length");
        return JSValueMakeUndefined(ctx);
    }

    CCPadding padding = (auto_padding && (algorithm->mode == kCCModeCBC || algorithm->mode == kCCModeECB)) ? ccPKCS7Padding : ccNoPadding;
    CCModeOptions options = algorithm->mode == kCCModeCTR ? kCCModeOptionCTR_BE : 0;
    CCCryptorRef cryptor = NULL;
    CCCryptorStatus status = CCCryptorCreateWithMode(
        encrypt ? kCCEncrypt : kCCDecrypt,
        algorithm->mode,
        kCCAlgorithmAES,
        padding,
        algorithm->iv_len > 0 ? iv : NULL,
        key,
        key_len,
        NULL,
        0,
        0,
        options,
        &cryptor
    );
    if (status != kCCSuccess || cryptor == NULL) {
        ct_throw_message(ctx, exception, "Failed to initialize cipher");
        return JSValueMakeUndefined(ctx);
    }

    CtCryptoCipher *entry = (CtCryptoCipher *)calloc(1, sizeof(CtCryptoCipher));
    if (entry == NULL) {
        CCCryptorRelease(cryptor);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    entry->id = ct_next_crypto_cipher_id++;
    if (ct_next_crypto_cipher_id == 0) ct_next_crypto_cipher_id = 1;
    entry->cryptor = cryptor;
    entry->next = ct_crypto_ciphers;
    ct_crypto_ciphers = entry;
    return JSValueMakeNumber(ctx, entry->id);
#else
    free(algorithm_name);
    ct_throw_message(ctx, exception, "Native cipher algorithms are not available on this platform yet");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_cipher_update(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.cryptoCipherUpdate(id, data) requires a cipher id and data");
        return JSValueMakeUndefined(ctx);
    }
    CtCryptoCipher *entry = ct_crypto_cipher_find((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "Cipher not found");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *input = NULL;
    size_t input_len = 0;
    if (ct_get_bytes(ctx, argv[1], &input, &input_len) != 0) {
        ct_throw_message(ctx, exception, "cipher input must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }

#if CT_HAS_OPENSSL
    if (entry->evp_cipher != NULL) {
        if (entry->evp_finalized) {
            ct_throw_message(ctx, exception, "Cipher already finalized");
            return JSValueMakeUndefined(ctx);
        }
        size_t output_capacity = input_len + 32;
        uint8_t *output = (uint8_t *)malloc(output_capacity > 0 ? output_capacity : 1);
        if (output == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        int output_len = 0;
        if (EVP_CipherUpdate(entry->evp_cipher, output, &output_len, input, (int)input_len) != 1) {
            free(output);
            ct_throw_message(ctx, exception, "Cipher update failed");
            return JSValueMakeUndefined(ctx);
        }
        return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, (size_t)output_len, ct_array_buffer_free, NULL, exception);
    }
#endif

#if defined(__APPLE__)
    size_t output_capacity = CCCryptorGetOutputLength(entry->cryptor, input_len, false);
    uint8_t *output = (uint8_t *)malloc(output_capacity > 0 ? output_capacity : 1);
    if (output == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    size_t output_len = 0;
    CCCryptorStatus status = CCCryptorUpdate(entry->cryptor, input, input_len, output, output_capacity, &output_len);
    if (status != kCCSuccess) {
        free(output);
        ct_throw_message(ctx, exception, "Cipher update failed");
        return JSValueMakeUndefined(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, output_len, ct_array_buffer_free, NULL, exception);
#else
    ct_throw_message(ctx, exception, "Native cipher algorithms are not available on this platform yet");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_cipher_final(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.cryptoCipherFinal(id) requires a cipher id");
        return JSValueMakeUndefined(ctx);
    }
    CtCryptoCipher *entry = ct_crypto_cipher_find((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "Cipher not found");
        return JSValueMakeUndefined(ctx);
    }

#if CT_HAS_OPENSSL
    if (entry->evp_cipher != NULL) {
        if (entry->evp_finalized) {
            ct_throw_message(ctx, exception, "Cipher already finalized");
            return JSValueMakeUndefined(ctx);
        }
        uint8_t *output = (uint8_t *)malloc(32);
        if (output == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        int output_len = 0;
        int ok = EVP_CipherFinal_ex(entry->evp_cipher, output, &output_len) == 1;
        if (ok && entry->evp_aead && entry->evp_encrypt) {
            entry->evp_auth_tag_len = sizeof(entry->evp_auth_tag);
            ok = EVP_CIPHER_CTX_ctrl(entry->evp_cipher, EVP_CTRL_AEAD_GET_TAG, (int)entry->evp_auth_tag_len, entry->evp_auth_tag) == 1;
        }
        if (!ok) {
            free(output);
            ct_crypto_cipher_remove(entry);
            ct_throw_message(ctx, exception, "Cipher final failed");
            return JSValueMakeUndefined(ctx);
        }
        entry->evp_finalized = true;
        if (!entry->evp_aead || !entry->evp_encrypt) {
            ct_crypto_cipher_remove(entry);
        }
        return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, (size_t)output_len, ct_array_buffer_free, NULL, exception);
    }
#endif

#if defined(__APPLE__)
    size_t output_capacity = CCCryptorGetOutputLength(entry->cryptor, 0, true);
    uint8_t *output = (uint8_t *)malloc(output_capacity > 0 ? output_capacity : 1);
    if (output == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    size_t output_len = 0;
    CCCryptorStatus status = CCCryptorFinal(entry->cryptor, output, output_capacity, &output_len);
    ct_crypto_cipher_remove(entry);
    if (status != kCCSuccess) {
        free(output);
        ct_throw_message(ctx, exception, "Cipher final failed");
        return JSValueMakeUndefined(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, output, output_len, ct_array_buffer_free, NULL, exception);
#else
    ct_crypto_cipher_remove(entry);
    ct_throw_message(ctx, exception, "Native cipher algorithms are not available on this platform yet");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_cipher_set_aad(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.cryptoCipherSetAAD(id, aad) requires a cipher id and AAD");
        return JSValueMakeUndefined(ctx);
    }
    CtCryptoCipher *entry = ct_crypto_cipher_find((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "Cipher not found");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *aad = NULL;
    size_t aad_len = 0;
    if (ct_get_bytes(ctx, argv[1], &aad, &aad_len) != 0) {
        ct_throw_message(ctx, exception, "cipher AAD must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    if (entry->evp_cipher == NULL || !entry->evp_aead || entry->evp_finalized) {
        ct_throw_message(ctx, exception, "Cipher AAD is only valid for active AEAD ciphers");
        return JSValueMakeUndefined(ctx);
    }
    int output_len = 0;
    if (EVP_CipherUpdate(entry->evp_cipher, NULL, &output_len, aad, (int)aad_len) != 1) {
        ct_throw_message(ctx, exception, "Cipher AAD update failed");
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
#else
    ct_throw_message(ctx, exception, "AEAD cipher support is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_cipher_set_auth_tag(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.cryptoCipherSetAuthTag(id, tag) requires a cipher id and tag");
        return JSValueMakeUndefined(ctx);
    }
    CtCryptoCipher *entry = ct_crypto_cipher_find((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "Cipher not found");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *tag = NULL;
    size_t tag_len = 0;
    if (ct_get_bytes(ctx, argv[1], &tag, &tag_len) != 0) {
        ct_throw_message(ctx, exception, "cipher auth tag must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    if (entry->evp_cipher == NULL || !entry->evp_aead || entry->evp_encrypt || entry->evp_finalized) {
        ct_throw_message(ctx, exception, "Cipher auth tag is only valid for active AEAD deciphers");
        return JSValueMakeUndefined(ctx);
    }
    if (tag_len == 0 || tag_len > 16 || EVP_CIPHER_CTX_ctrl(entry->evp_cipher, EVP_CTRL_AEAD_SET_TAG, (int)tag_len, tag) != 1) {
        ct_throw_message(ctx, exception, "Cipher auth tag update failed");
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
#else
    ct_throw_message(ctx, exception, "AEAD cipher support is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_crypto_cipher_get_auth_tag(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.cryptoCipherGetAuthTag(id) requires a cipher id");
        return JSValueMakeUndefined(ctx);
    }
    CtCryptoCipher *entry = ct_crypto_cipher_find((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "Cipher not found");
        return JSValueMakeUndefined(ctx);
    }
#if CT_HAS_OPENSSL
    if (entry->evp_cipher == NULL || !entry->evp_aead || !entry->evp_encrypt || !entry->evp_finalized || entry->evp_auth_tag_len == 0) {
        ct_throw_message(ctx, exception, "Cipher auth tag is not available");
        return JSValueMakeUndefined(ctx);
    }
    JSValueRef result = ct_array_buffer_from_copy(ctx, (const char *)entry->evp_auth_tag, entry->evp_auth_tag_len, exception);
    ct_crypto_cipher_remove(entry);
    return result;
#else
    ct_throw_message(ctx, exception, "AEAD cipher support is unavailable in this build");
    return JSValueMakeUndefined(ctx);
#endif
}

static CtSqliteDb *ct_sqlite_find_db(uint32_t id) {
    CtSqliteDb *cursor = ct_sqlite_dbs;
    while (cursor != NULL) {
        if (cursor->id == id) return cursor;
        cursor = cursor->next;
    }
    return NULL;
}

static CtSqliteStmt *ct_sqlite_find_stmt(uint32_t id) {
    CtSqliteStmt *cursor = ct_sqlite_stmts;
    while (cursor != NULL) {
        if (cursor->id == id) return cursor;
        cursor = cursor->next;
    }
    return NULL;
}

static CtSqliteSession *ct_sqlite_find_session(uint32_t id) {
    CtSqliteSession *cursor = ct_sqlite_sessions;
    while (cursor != NULL) {
        if (cursor->id == id) return cursor;
        cursor = cursor->next;
    }
    return NULL;
}

static CtSqliteEnableLoadExtensionFn ct_sqlite_enable_load_extension_fn(void) {
    return sqlite3_enable_load_extension;
}

static CtSqliteLoadExtensionFn ct_sqlite_load_extension_fn(void) {
    return sqlite3_load_extension;
}

static void ct_sqlite_throw(JSContextRef ctx, JSValueRef *exception, sqlite3 *db) {
    ct_throw_message(ctx, exception, db != NULL ? sqlite3_errmsg(db) : "SQLite error");
}

static void ct_sqlite_unlink_stmt(CtSqliteStmt *stmt) {
    if (stmt == NULL) return;
    CtSqliteStmt **global_cursor = &ct_sqlite_stmts;
    while (*global_cursor != NULL) {
        if (*global_cursor == stmt) {
            *global_cursor = stmt->next;
            break;
        }
        global_cursor = &(*global_cursor)->next;
    }
    if (stmt->owner != NULL) {
        CtSqliteStmt **owner_cursor = &stmt->owner->statements;
        while (*owner_cursor != NULL) {
            if (*owner_cursor == stmt) {
                *owner_cursor = stmt->owner_next;
                break;
            }
            owner_cursor = &(*owner_cursor)->owner_next;
        }
    }
}

static void ct_sqlite_finalize_stmt(CtSqliteStmt *stmt) {
    if (stmt == NULL) return;
    ct_sqlite_unlink_stmt(stmt);
    if (stmt->stmt != NULL) sqlite3_finalize(stmt->stmt);
    free(stmt);
}

static void ct_sqlite_unlink_session(CtSqliteSession *session) {
    if (session == NULL) return;
    CtSqliteSession **global_cursor = &ct_sqlite_sessions;
    while (*global_cursor != NULL) {
        if (*global_cursor == session) {
            *global_cursor = session->next;
            break;
        }
        global_cursor = &(*global_cursor)->next;
    }
    if (session->owner != NULL) {
        CtSqliteSession **owner_cursor = &session->owner->sessions;
        while (*owner_cursor != NULL) {
            if (*owner_cursor == session) {
                *owner_cursor = session->owner_next;
                break;
            }
            owner_cursor = &(*owner_cursor)->owner_next;
        }
    }
}

static void ct_sqlite_delete_session(CtSqliteSession *session) {
    if (session == NULL) return;
    ct_sqlite_unlink_session(session);
    if (session->session != NULL) sqlite3session_delete(session->session);
    free(session);
}

static JSValueRef ct_sqlite_column_value(JSContextRef ctx, sqlite3_stmt *stmt, int column, bool safe_integers, JSValueRef *exception) {
    int type = sqlite3_column_type(stmt, column);
    switch (type) {
        case SQLITE_INTEGER: {
            sqlite3_int64 value = sqlite3_column_int64(stmt, column);
            if (safe_integers) return JSBigIntCreateWithInt64(ctx, value, exception);
            return JSValueMakeNumber(ctx, (double)value);
        }
        case SQLITE_FLOAT:
            return JSValueMakeNumber(ctx, sqlite3_column_double(stmt, column));
        case SQLITE_TEXT:
            return ct_make_string_len(ctx, (const char *)sqlite3_column_text(stmt, column), (size_t)sqlite3_column_bytes(stmt, column));
        case SQLITE_BLOB:
            return ct_array_buffer_from_copy(ctx, (const char *)sqlite3_column_blob(stmt, column), (size_t)sqlite3_column_bytes(stmt, column), exception);
        case SQLITE_NULL:
        default:
            return JSValueMakeNull(ctx);
    }
}

static JSObjectRef ct_sqlite_row_object(JSContextRef ctx, sqlite3_stmt *stmt, bool safe_integers, JSValueRef *exception) {
    int count = sqlite3_column_count(stmt);
    JSObjectRef row = ct_make_object(ctx);
    for (int index = 0; index < count; index += 1) {
        const char *name = sqlite3_column_name(stmt, index);
        ct_set_property(ctx, row, name != NULL ? name : "", ct_sqlite_column_value(ctx, stmt, index, safe_integers, exception), exception);
    }
    return row;
}

static JSObjectRef ct_sqlite_row_array(JSContextRef ctx, sqlite3_stmt *stmt, bool safe_integers, JSValueRef *exception) {
    int count = sqlite3_column_count(stmt);
    JSObjectRef row = ct_make_array(ctx, 0, NULL, exception);
    for (int index = 0; index < count; index += 1) {
        JSObjectSetPropertyAtIndex(ctx, row, (unsigned)index, ct_sqlite_column_value(ctx, stmt, index, safe_integers, exception), exception);
    }
    return row;
}

static int ct_sqlite_bind_value(JSContextRef ctx, sqlite3_stmt *stmt, int index, JSValueRef value, JSValueRef *exception) {
    if (value == NULL || JSValueIsUndefined(ctx, value) || JSValueIsNull(ctx, value)) return sqlite3_bind_null(stmt, index);
    if (JSValueIsBoolean(ctx, value)) return sqlite3_bind_int(stmt, index, ct_value_to_bool(ctx, value) ? 1 : 0);
    if (JSValueIsNumber(ctx, value)) return sqlite3_bind_double(stmt, index, ct_value_to_number(ctx, value));
    if (JSValueIsString(ctx, value)) {
        char *text = ct_value_to_string_copy(ctx, value);
        if (text == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return SQLITE_NOMEM;
        }
        int status = sqlite3_bind_text(stmt, index, text, -1, SQLITE_TRANSIENT);
        free(text);
        return status;
    }
    uint8_t *bytes = NULL;
    size_t bytes_len = 0;
    if (ct_get_bytes(ctx, value, &bytes, &bytes_len) == 0) {
        return sqlite3_bind_blob(stmt, index, bytes, (int)bytes_len, SQLITE_TRANSIENT);
    }
    char *text = ct_value_to_string_copy(ctx, value);
    if (text == NULL) {
        ct_throw_message(ctx, exception, "Unsupported SQLite bind parameter");
        return SQLITE_MISUSE;
    }
    int status = sqlite3_bind_text(stmt, index, text, -1, SQLITE_TRANSIENT);
    free(text);
    return status;
}

static int ct_sqlite_bind_params(JSContextRef ctx, sqlite3_stmt *stmt, JSValueRef params, JSValueRef *exception) {
    sqlite3_reset(stmt);
    sqlite3_clear_bindings(stmt);
    if (params == NULL || JSValueIsUndefined(ctx, params) || JSValueIsNull(ctx, params)) return SQLITE_OK;
    if (!JSValueIsObject(ctx, params)) return SQLITE_OK;

    JSObjectRef object = (JSObjectRef)params;
    JSValueRef length_value = ct_get_property(ctx, object, "length", exception);
    if (exception != NULL && *exception != NULL) return SQLITE_MISUSE;
    size_t count = JSValueIsUndefined(ctx, length_value) ? 0 : (size_t)ct_value_to_number(ctx, length_value);
    if (count > 0) {
        for (size_t index = 0; index < count; index += 1) {
            JSValueRef value = JSObjectGetPropertyAtIndex(ctx, object, (unsigned)index, exception);
            if (exception != NULL && *exception != NULL) return SQLITE_MISUSE;
            int status = ct_sqlite_bind_value(ctx, stmt, (int)index + 1, value, exception);
            if (status != SQLITE_OK) return status;
        }
        return SQLITE_OK;
    }

    int bind_count = sqlite3_bind_parameter_count(stmt);
    for (int index = 1; index <= bind_count; index += 1) {
        const char *name = sqlite3_bind_parameter_name(stmt, index);
        if (name == NULL || name[0] == '\0') continue;
        JSValueRef value = ct_get_property(ctx, object, name, exception);
        if (exception != NULL && *exception != NULL) return SQLITE_MISUSE;
        if (JSValueIsUndefined(ctx, value) && (name[0] == ':' || name[0] == '$' || name[0] == '@')) {
            value = ct_get_property(ctx, object, name + 1, exception);
            if (exception != NULL && *exception != NULL) return SQLITE_MISUSE;
        }
        int status = ct_sqlite_bind_value(ctx, stmt, index, value, exception);
        if (status != SQLITE_OK) return status;
    }
    return SQLITE_OK;
}

static JSValueRef ct_sqlite_value_to_js(JSContextRef ctx, sqlite3_value *value, JSValueRef *exception) {
    switch (sqlite3_value_type(value)) {
        case SQLITE_INTEGER:
            return JSValueMakeNumber(ctx, (double)sqlite3_value_int64(value));
        case SQLITE_FLOAT:
            return JSValueMakeNumber(ctx, sqlite3_value_double(value));
        case SQLITE_TEXT:
            return ct_make_string_len(ctx, (const char *)sqlite3_value_text(value), (size_t)sqlite3_value_bytes(value));
        case SQLITE_BLOB:
            return ct_array_buffer_from_copy(ctx, (const char *)sqlite3_value_blob(value), (size_t)sqlite3_value_bytes(value), exception);
        case SQLITE_NULL:
        default:
            return JSValueMakeNull(ctx);
    }
}

static void ct_sqlite_result_from_js(sqlite3_context *sqlite_ctx, JSContextRef ctx, JSValueRef value) {
    if (value == NULL || JSValueIsUndefined(ctx, value) || JSValueIsNull(ctx, value)) {
        sqlite3_result_null(sqlite_ctx);
        return;
    }
    if (JSValueIsBoolean(ctx, value)) {
        sqlite3_result_int(sqlite_ctx, ct_value_to_bool(ctx, value) ? 1 : 0);
        return;
    }
    if (JSValueIsNumber(ctx, value)) {
        double number = ct_value_to_number(ctx, value);
        sqlite3_result_double(sqlite_ctx, number);
        return;
    }
    if (JSValueIsString(ctx, value)) {
        char *text = ct_value_to_string_copy(ctx, value);
        if (text == NULL) {
            sqlite3_result_error_nomem(sqlite_ctx);
            return;
        }
        sqlite3_result_text(sqlite_ctx, text, -1, SQLITE_TRANSIENT);
        free(text);
        return;
    }
    uint8_t *bytes = NULL;
    size_t bytes_len = 0;
    if (ct_get_bytes(ctx, value, &bytes, &bytes_len) == 0) {
        sqlite3_result_blob(sqlite_ctx, bytes, (int)bytes_len, SQLITE_TRANSIENT);
        return;
    }
    sqlite3_result_error(sqlite_ctx, "Unsupported SQLite function return value", -1);
}

static void ct_sqlite_function_destroy(void *opaque) {
    CtSqliteFunction *entry = (CtSqliteFunction *)opaque;
    if (entry == NULL) return;
    if (entry->ctx != NULL && entry->callback != NULL) {
        JSValueUnprotect(entry->ctx, entry->callback);
    }
    if (entry->ctx != NULL && entry->result_callback != NULL) {
        JSValueUnprotect(entry->ctx, entry->result_callback);
    }
    if (entry->ctx != NULL && entry->start_callback != NULL) {
        JSValueUnprotect(entry->ctx, entry->start_callback);
    }
    if (entry->ctx != NULL && entry->inverse_callback != NULL) {
        JSValueUnprotect(entry->ctx, entry->inverse_callback);
    }
    if (entry->ctx != NULL && entry->has_start_value && entry->start_value != NULL) {
        JSValueUnprotect(entry->ctx, entry->start_value);
    }
    free(entry);
}

static JSValueRef ct_sqlite_authorizer_string(JSContextRef ctx, const char *value) {
    return value != NULL ? ct_make_string(ctx, value) : JSValueMakeNull(ctx);
}

static int ct_sqlite_authorizer_call(void *opaque, int action_code, const char *arg1, const char *arg2, const char *database_name, const char *trigger_or_view) {
    CtSqliteFunction *entry = (CtSqliteFunction *)opaque;
    if (entry == NULL || entry->ctx == NULL || entry->callback == NULL) return SQLITE_DENY;

    JSValueRef args[] = {
        JSValueMakeNumber(entry->ctx, action_code),
        ct_sqlite_authorizer_string(entry->ctx, arg1),
        ct_sqlite_authorizer_string(entry->ctx, arg2),
        ct_sqlite_authorizer_string(entry->ctx, database_name),
        ct_sqlite_authorizer_string(entry->ctx, trigger_or_view),
    };
    JSValueRef exception = NULL;
    JSValueRef result = JSObjectCallAsFunction(entry->ctx, entry->callback, NULL, 5, args, &exception);
    if (exception != NULL) return SQLITE_DENY;
    double number = JSValueToNumber(entry->ctx, result, &exception);
    if (exception != NULL || !isfinite(number)) return SQLITE_DENY;
    int code = (int)number;
    if ((double)code != number) return SQLITE_DENY;
    if (code == SQLITE_OK || code == SQLITE_DENY || code == SQLITE_IGNORE) return code;
    return SQLITE_DENY;
}

static void ct_sqlite_function_call(sqlite3_context *sqlite_ctx, int argc, sqlite3_value **argv) {
    CtSqliteFunction *entry = (CtSqliteFunction *)sqlite3_user_data(sqlite_ctx);
    if (entry == NULL || entry->ctx == NULL || entry->callback == NULL) {
        sqlite3_result_error(sqlite_ctx, "SQLite function callback is unavailable", -1);
        return;
    }

    JSValueRef *args = (JSValueRef *)calloc((size_t)(argc > 0 ? argc : 1), sizeof(JSValueRef));
    if (args == NULL) {
        sqlite3_result_error_nomem(sqlite_ctx);
        return;
    }
    JSValueRef exception = NULL;
    for (int index = 0; index < argc; index += 1) {
        args[index] = ct_sqlite_value_to_js(entry->ctx, argv[index], &exception);
        if (exception != NULL) {
            char *message = ct_copy_exception(entry->ctx, exception);
            sqlite3_result_error(sqlite_ctx, message != NULL ? message : "SQLite function argument conversion failed", -1);
            free(message);
            free(args);
            return;
        }
    }

    JSValueRef result = JSObjectCallAsFunction(entry->ctx, entry->callback, NULL, (size_t)argc, args, &exception);
    free(args);
    if (exception != NULL) {
        char *message = ct_copy_exception(entry->ctx, exception);
        sqlite3_result_error(sqlite_ctx, message != NULL ? message : "SQLite function callback failed", -1);
        free(message);
        return;
    }
    ct_sqlite_result_from_js(sqlite_ctx, entry->ctx, result);
}

static void ct_sqlite_aggregate_state_set_error(sqlite3_context *sqlite_ctx, CtSqliteAggregateState *state, char *message, const char *fallback) {
    const char *text = fallback;
    if (state != NULL) {
        if (state->error_message == NULL) {
            state->error_message = message != NULL ? message : ct_duplicate_bytes(fallback, strlen(fallback));
        } else {
            free(message);
        }
        text = state->error_message != NULL ? state->error_message : fallback;
    } else if (message != NULL) {
        text = message;
    }
    sqlite3_result_error(sqlite_ctx, text != NULL ? text : "SQLite aggregate callback failed", -1);
    if (state == NULL) {
        free(message);
    }
}

static void ct_sqlite_aggregate_state_clear(CtSqliteFunction *entry, CtSqliteAggregateState *state) {
    if (entry == NULL || state == NULL) return;
    if (entry->ctx != NULL && state->initialized && state->accumulator != NULL) {
        JSValueUnprotect(entry->ctx, state->accumulator);
    }
    free(state->error_message);
    state->initialized = false;
    state->accumulator = NULL;
    state->error_message = NULL;
}

static bool ct_sqlite_aggregate_initialize(sqlite3_context *sqlite_ctx, CtSqliteFunction *entry, CtSqliteAggregateState *state) {
    if (entry == NULL || entry->ctx == NULL || state == NULL) return false;
    if (state->initialized) return state->error_message == NULL;

    JSValueRef accumulator = NULL;
    if (entry->start_callback != NULL) {
        JSValueRef exception = NULL;
        accumulator = JSObjectCallAsFunction(entry->ctx, entry->start_callback, NULL, 0, NULL, &exception);
        if (exception != NULL) {
            ct_sqlite_aggregate_state_set_error(sqlite_ctx, state, ct_copy_exception(entry->ctx, exception), "SQLite aggregate start callback failed");
            return false;
        }
    } else if (entry->has_start_value) {
        accumulator = entry->start_value;
    } else {
        accumulator = JSValueMakeUndefined(entry->ctx);
    }

    JSValueProtect(entry->ctx, accumulator);
    state->accumulator = accumulator;
    state->initialized = true;
    return true;
}

static void ct_sqlite_aggregate_call(sqlite3_context *sqlite_ctx, int argc, sqlite3_value **argv, JSObjectRef callback, const char *name) {
    CtSqliteFunction *entry = (CtSqliteFunction *)sqlite3_user_data(sqlite_ctx);
    if (entry == NULL || entry->ctx == NULL || callback == NULL) {
        sqlite3_result_error(sqlite_ctx, "SQLite aggregate callback is unavailable", -1);
        return;
    }

    CtSqliteAggregateState *state = (CtSqliteAggregateState *)sqlite3_aggregate_context(sqlite_ctx, sizeof(CtSqliteAggregateState));
    if (state == NULL) {
        sqlite3_result_error_nomem(sqlite_ctx);
        return;
    }
    if (state->error_message != NULL) {
        sqlite3_result_error(sqlite_ctx, state->error_message, -1);
        return;
    }
    if (!ct_sqlite_aggregate_initialize(sqlite_ctx, entry, state)) return;

    size_t js_argc = (size_t)argc + 1;
    JSValueRef *args = (JSValueRef *)calloc(js_argc > 0 ? js_argc : 1, sizeof(JSValueRef));
    if (args == NULL) {
        sqlite3_result_error_nomem(sqlite_ctx);
        return;
    }
    args[0] = state->accumulator;

    JSValueRef exception = NULL;
    for (int index = 0; index < argc; index += 1) {
        args[(size_t)index + 1] = ct_sqlite_value_to_js(entry->ctx, argv[index], &exception);
        if (exception != NULL) {
            ct_sqlite_aggregate_state_set_error(sqlite_ctx, state, ct_copy_exception(entry->ctx, exception), "SQLite aggregate argument conversion failed");
            free(args);
            return;
        }
    }

    JSValueRef result = JSObjectCallAsFunction(entry->ctx, callback, NULL, js_argc, args, &exception);
    free(args);
    if (exception != NULL) {
        char fallback[128];
        snprintf(fallback, sizeof(fallback), "SQLite aggregate %s callback failed", name != NULL ? name : "step");
        ct_sqlite_aggregate_state_set_error(sqlite_ctx, state, ct_copy_exception(entry->ctx, exception), fallback);
        return;
    }

    JSValueProtect(entry->ctx, result);
    if (state->accumulator != NULL) JSValueUnprotect(entry->ctx, state->accumulator);
    state->accumulator = result;
}

static void ct_sqlite_aggregate_step(sqlite3_context *sqlite_ctx, int argc, sqlite3_value **argv) {
    CtSqliteFunction *entry = (CtSqliteFunction *)sqlite3_user_data(sqlite_ctx);
    ct_sqlite_aggregate_call(sqlite_ctx, argc, argv, entry != NULL ? entry->callback : NULL, "step");
}

static void ct_sqlite_aggregate_inverse(sqlite3_context *sqlite_ctx, int argc, sqlite3_value **argv) {
    CtSqliteFunction *entry = (CtSqliteFunction *)sqlite3_user_data(sqlite_ctx);
    ct_sqlite_aggregate_call(sqlite_ctx, argc, argv, entry != NULL ? entry->inverse_callback : NULL, "inverse");
}

static void ct_sqlite_aggregate_emit_result(sqlite3_context *sqlite_ctx, bool clear_state) {
    CtSqliteFunction *entry = (CtSqliteFunction *)sqlite3_user_data(sqlite_ctx);
    if (entry == NULL || entry->ctx == NULL) {
        sqlite3_result_error(sqlite_ctx, "SQLite aggregate callback is unavailable", -1);
        return;
    }

    CtSqliteAggregateState *state = (CtSqliteAggregateState *)sqlite3_aggregate_context(sqlite_ctx, sizeof(CtSqliteAggregateState));
    if (state == NULL) {
        sqlite3_result_error_nomem(sqlite_ctx);
        return;
    }
    if (state->error_message != NULL) {
        sqlite3_result_error(sqlite_ctx, state->error_message, -1);
        if (clear_state) ct_sqlite_aggregate_state_clear(entry, state);
        return;
    }
    if (!ct_sqlite_aggregate_initialize(sqlite_ctx, entry, state)) {
        if (clear_state) ct_sqlite_aggregate_state_clear(entry, state);
        return;
    }

    JSValueRef result = state->accumulator;
    if (entry->result_callback != NULL) {
        JSValueRef exception = NULL;
        JSValueRef arg = state->accumulator;
        result = JSObjectCallAsFunction(entry->ctx, entry->result_callback, NULL, 1, &arg, &exception);
        if (exception != NULL) {
            ct_sqlite_aggregate_state_set_error(sqlite_ctx, state, ct_copy_exception(entry->ctx, exception), "SQLite aggregate result callback failed");
            if (clear_state) ct_sqlite_aggregate_state_clear(entry, state);
            return;
        }
    }

    ct_sqlite_result_from_js(sqlite_ctx, entry->ctx, result);
    if (clear_state) ct_sqlite_aggregate_state_clear(entry, state);
}

static void ct_sqlite_aggregate_value(sqlite3_context *sqlite_ctx) {
    ct_sqlite_aggregate_emit_result(sqlite_ctx, false);
}

static void ct_sqlite_aggregate_final(sqlite3_context *sqlite_ctx) {
    ct_sqlite_aggregate_emit_result(sqlite_ctx, true);
}

static JSValueRef ct_sqlite_open(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteOpen(path) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    if (path == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    sqlite3 *db = NULL;
    int flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI;
    if (argc >= 3 && !JSValueIsUndefined(ctx, argv[2]) && !JSValueIsNull(ctx, argv[2])) {
        flags = (int)ct_value_to_number(ctx, argv[2]);
    }
    int status = sqlite3_open_v2(path, &db, flags, NULL);
    free(path);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, db);
        if (db != NULL) sqlite3_close(db);
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = (CtSqliteDb *)calloc(1, sizeof(CtSqliteDb));
    if (entry == NULL) {
        sqlite3_close(db);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    entry->id = ct_next_sqlite_db_id++;
    if (ct_next_sqlite_db_id == 0) ct_next_sqlite_db_id = 1;
    entry->db = db;
    entry->allow_load_extension = argc >= 2 && ct_value_to_bool(ctx, argv[1]);
    entry->load_extension_enabled = entry->allow_load_extension;
    CtSqliteEnableLoadExtensionFn enable_load_extension = ct_sqlite_enable_load_extension_fn();
    if (enable_load_extension != NULL) {
        enable_load_extension(db, entry->load_extension_enabled ? 1 : 0);
    }
    entry->next = ct_sqlite_dbs;
    ct_sqlite_dbs = entry;

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, entry->id), exception);
    return result;
}

static JSValueRef ct_sqlite_close(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteClose(id) requires a database id");
        return JSValueMakeUndefined(ctx);
    }
    uint32_t id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    CtSqliteDb **cursor = &ct_sqlite_dbs;
    while (*cursor != NULL && (*cursor)->id != id) cursor = &(*cursor)->next;
    if (*cursor == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = *cursor;
    while (entry->sessions != NULL) ct_sqlite_delete_session(entry->sessions);
    while (entry->statements != NULL) ct_sqlite_finalize_stmt(entry->statements);
    sqlite3_set_authorizer(entry->db, NULL, NULL);
    if (entry->authorizer != NULL) {
        ct_sqlite_function_destroy(entry->authorizer);
        entry->authorizer = NULL;
    }
    int status = sqlite3_close(entry->db);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    *cursor = entry->next;
    free(entry);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_exec(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteExec(id, sql) requires database id and SQL");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    char *sql = ct_value_to_string_copy(ctx, argv[1]);
    if (sql == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    char *error_message = NULL;
    int status = sqlite3_exec(entry->db, sql, NULL, NULL, &error_message);
    free(sql);
    if (status != SQLITE_OK) {
        ct_throw_message(ctx, exception, error_message != NULL ? error_message : sqlite3_errmsg(entry->db));
        sqlite3_free(error_message);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_prepare(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqlitePrepare(id, sql) requires database id and SQL");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    char *sql = ct_value_to_string_copy(ctx, argv[1]);
    if (sql == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    sqlite3_stmt *stmt = NULL;
    int status = sqlite3_prepare_v2(entry->db, sql, -1, &stmt, NULL);
    free(sql);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    if (stmt == NULL) {
        ct_throw_message(ctx, exception, "Query contained no valid SQL statement; likely empty query.");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *stmt_entry = (CtSqliteStmt *)calloc(1, sizeof(CtSqliteStmt));
    if (stmt_entry == NULL) {
        sqlite3_finalize(stmt);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    stmt_entry->id = ct_next_sqlite_stmt_id++;
    if (ct_next_sqlite_stmt_id == 0) ct_next_sqlite_stmt_id = 1;
    stmt_entry->stmt = stmt;
    stmt_entry->owner = entry;
    stmt_entry->next = ct_sqlite_stmts;
    ct_sqlite_stmts = stmt_entry;
    stmt_entry->owner_next = entry->statements;
    entry->statements = stmt_entry;

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, stmt_entry->id), exception);
    ct_set_property(ctx, result, "sourceSQL", ct_make_string(ctx, sqlite3_sql(stmt) != NULL ? sqlite3_sql(stmt) : ""), exception);
    ct_set_property(ctx, result, "paramsCount", JSValueMakeNumber(ctx, sqlite3_bind_parameter_count(stmt)), exception);
    return result;
}

static JSValueRef ct_sqlite_statement_finalize(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementFinalize(id) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *stmt = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (stmt != NULL) ct_sqlite_finalize_stmt(stmt);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_statement_all(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementAll(id[, params]) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    int status = ct_sqlite_bind_params(ctx, entry->stmt, argc >= 2 ? argv[1] : NULL, exception);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        return JSValueMakeUndefined(ctx);
    }
    JSObjectRef rows = ct_make_array(ctx, 0, NULL, exception);
    unsigned row_index = 0;
    bool safe_integers = argc >= 3 && ct_value_to_bool(ctx, argv[2]);
    while ((status = sqlite3_step(entry->stmt)) == SQLITE_ROW) {
        JSObjectSetPropertyAtIndex(ctx, rows, row_index++, ct_sqlite_row_object(ctx, entry->stmt, safe_integers, exception), exception);
    }
    if (status != SQLITE_DONE) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        sqlite3_reset(entry->stmt);
        return JSValueMakeUndefined(ctx);
    }
    sqlite3_reset(entry->stmt);
    return rows;
}

static JSValueRef ct_sqlite_statement_get(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementGet(id[, params]) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    int status = ct_sqlite_bind_params(ctx, entry->stmt, argc >= 2 ? argv[1] : NULL, exception);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        return JSValueMakeUndefined(ctx);
    }
    bool safe_integers = argc >= 3 && ct_value_to_bool(ctx, argv[2]);
    status = sqlite3_step(entry->stmt);
    if (status == SQLITE_ROW) {
        JSObjectRef row = ct_sqlite_row_object(ctx, entry->stmt, safe_integers, exception);
        sqlite3_reset(entry->stmt);
        return row;
    }
    if (status != SQLITE_DONE) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        sqlite3_reset(entry->stmt);
        return JSValueMakeUndefined(ctx);
    }
    sqlite3_reset(entry->stmt);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_statement_values(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementValues(id[, params]) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    int status = ct_sqlite_bind_params(ctx, entry->stmt, argc >= 2 ? argv[1] : NULL, exception);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        return JSValueMakeUndefined(ctx);
    }
    JSObjectRef rows = ct_make_array(ctx, 0, NULL, exception);
    unsigned row_index = 0;
    bool safe_integers = argc >= 3 && ct_value_to_bool(ctx, argv[2]);
    while ((status = sqlite3_step(entry->stmt)) == SQLITE_ROW) {
        JSObjectSetPropertyAtIndex(ctx, rows, row_index++, ct_sqlite_row_array(ctx, entry->stmt, safe_integers, exception), exception);
    }
    sqlite3_reset(entry->stmt);
    if (status != SQLITE_DONE) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        return JSValueMakeUndefined(ctx);
    }
    return rows;
}

static JSValueRef ct_sqlite_statement_run(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementRun(id[, params]) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    int status = ct_sqlite_bind_params(ctx, entry->stmt, argc >= 2 ? argv[1] : NULL, exception);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        return JSValueMakeUndefined(ctx);
    }
    status = sqlite3_step(entry->stmt);
    if (status != SQLITE_DONE && status != SQLITE_ROW) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        sqlite3_reset(entry->stmt);
        return JSValueMakeUndefined(ctx);
    }
    sqlite3_reset(entry->stmt);
    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "lastInsertRowid", JSValueMakeNumber(ctx, (double)sqlite3_last_insert_rowid(entry->owner->db)), exception);
    ct_set_property(ctx, result, "changes", JSValueMakeNumber(ctx, sqlite3_stmt_readonly(entry->stmt) ? 0 : sqlite3_changes(entry->owner->db)), exception);
    return result;
}

static JSValueRef ct_sqlite_statement_columns(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementColumns(id) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    int count = sqlite3_column_count(entry->stmt);
    JSObjectRef columns = ct_make_array(ctx, 0, NULL, exception);
    ct_set_property(ctx, columns, "readOnly", JSValueMakeBoolean(ctx, sqlite3_stmt_readonly(entry->stmt) != 0), exception);
    for (int index = 0; index < count; index += 1) {
        JSObjectRef column = ct_make_object(ctx);
        const char *name = sqlite3_column_name(entry->stmt, index);
        const char *declared_type = sqlite3_column_decltype(entry->stmt, index);
        const char *table = sqlite3_column_table_name(entry->stmt, index);
        const char *database = sqlite3_column_database_name(entry->stmt, index);
        const char *origin = sqlite3_column_origin_name(entry->stmt, index);
        ct_set_property(ctx, column, "name", ct_make_string(ctx, name != NULL ? name : ""), exception);
        ct_set_property(ctx, column, "type", ct_make_string(ctx, declared_type != NULL ? declared_type : ""), exception);
        ct_set_property(ctx, column, "column", ct_make_string(ctx, origin != NULL ? origin : ""), exception);
        ct_set_property(ctx, column, "table", ct_make_string(ctx, table != NULL ? table : ""), exception);
        ct_set_property(ctx, column, "database", ct_make_string(ctx, database != NULL ? database : ""), exception);
        JSObjectSetPropertyAtIndex(ctx, columns, (unsigned)index, column, exception);
    }
    return columns;
}

static JSValueRef ct_sqlite_statement_expanded_sql(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementExpandedSql(id) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    char *expanded = sqlite3_expanded_sql(entry->stmt);
    if (expanded == NULL) {
        ct_throw_message(ctx, exception, "Failed to expand SQLite statement");
        return JSValueMakeUndefined(ctx);
    }
    JSValueRef result = ct_make_string(ctx, expanded);
    sqlite3_free(expanded);
    return result;
}

static JSValueRef ct_sqlite_statement_parameter_names(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementParameterNames(id) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    int count = sqlite3_bind_parameter_count(entry->stmt);
    JSObjectRef names = ct_make_array(ctx, 0, NULL, exception);
    for (int index = 1; index <= count; index += 1) {
        const char *name = sqlite3_bind_parameter_name(entry->stmt, index);
        JSObjectSetPropertyAtIndex(ctx, names, (unsigned)(index - 1), name != NULL ? ct_make_string(ctx, name) : JSValueMakeNull(ctx), exception);
    }
    return names;
}

static const char *ct_sqlite_column_type_name(int type) {
    switch (type) {
        case SQLITE_INTEGER: return "INTEGER";
        case SQLITE_FLOAT: return "FLOAT";
        case SQLITE_TEXT: return "TEXT";
        case SQLITE_BLOB: return "BLOB";
        case SQLITE_NULL:
        default: return "NULL";
    }
}

static JSValueRef ct_sqlite_statement_column_types(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementColumnTypes(id) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    if (sqlite3_stmt_readonly(entry->stmt) == 0) {
        ct_throw_message(ctx, exception, "columnTypes is not available for non-read-only statements (INSERT, UPDATE, DELETE, etc.)");
        return JSValueMakeUndefined(ctx);
    }

    int status = sqlite3_step(entry->stmt);
    int count = sqlite3_column_count(entry->stmt);
    JSObjectRef types = ct_make_array(ctx, 0, NULL, exception);
    if (status == SQLITE_ROW) {
        for (int index = 0; index < count; index += 1) {
            JSObjectSetPropertyAtIndex(
                ctx,
                types,
                (unsigned)index,
                ct_make_string(ctx, ct_sqlite_column_type_name(sqlite3_column_type(entry->stmt, index))),
                exception
            );
        }
    }
    sqlite3_reset(entry->stmt);
    if (status != SQLITE_ROW && status != SQLITE_DONE) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        return JSValueMakeUndefined(ctx);
    }
    return types;
}

static JSValueRef ct_sqlite_in_transaction(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteInTransaction(id) requires a database id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeBoolean(ctx, sqlite3_get_autocommit(entry->db) == 0);
}

static JSValueRef ct_sqlite_create_function(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 5) {
        ct_throw_message(ctx, exception, "sqliteCreateFunction(id, name, argc, flags, callback) requires five arguments");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    char *name = ct_value_to_string_copy(ctx, argv[1]);
    if (name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    if (!JSValueIsObject(ctx, argv[4]) || !JSObjectIsFunction(ctx, (JSObjectRef)argv[4])) {
        free(name);
        ct_throw_message(ctx, exception, "SQLite function callback must be a function");
        return JSValueMakeUndefined(ctx);
    }

    CtSqliteFunction *callback = (CtSqliteFunction *)calloc(1, sizeof(CtSqliteFunction));
    if (callback == NULL) {
        free(name);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    callback->ctx = ctx;
    callback->callback = (JSObjectRef)argv[4];
    JSValueProtect(ctx, callback->callback);

    int function_argc = (int)ct_value_to_number(ctx, argv[2]);
    int flags = SQLITE_UTF8 | (int)ct_value_to_number(ctx, argv[3]);
    int status = sqlite3_create_function_v2(
        entry->db,
        name,
        function_argc,
        flags,
        callback,
        ct_sqlite_function_call,
        NULL,
        NULL,
        ct_sqlite_function_destroy
    );
    free(name);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_create_aggregate(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 8) {
        ct_throw_message(ctx, exception, "sqliteCreateAggregate(id, name, argc, flags, start, step, result, inverse) requires eight arguments");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    char *name = ct_value_to_string_copy(ctx, argv[1]);
    if (name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    if (!JSValueIsObject(ctx, argv[5]) || !JSObjectIsFunction(ctx, (JSObjectRef)argv[5])) {
        free(name);
        ct_throw_message(ctx, exception, "SQLite aggregate step callback must be a function");
        return JSValueMakeUndefined(ctx);
    }
    if (!JSValueIsUndefined(ctx, argv[6]) && !JSValueIsNull(ctx, argv[6]) && (!JSValueIsObject(ctx, argv[6]) || !JSObjectIsFunction(ctx, (JSObjectRef)argv[6]))) {
        free(name);
        ct_throw_message(ctx, exception, "SQLite aggregate result callback must be a function");
        return JSValueMakeUndefined(ctx);
    }
    if (!JSValueIsUndefined(ctx, argv[7]) && !JSValueIsNull(ctx, argv[7]) && (!JSValueIsObject(ctx, argv[7]) || !JSObjectIsFunction(ctx, (JSObjectRef)argv[7]))) {
        free(name);
        ct_throw_message(ctx, exception, "SQLite aggregate inverse callback must be a function");
        return JSValueMakeUndefined(ctx);
    }

    CtSqliteFunction *callback = (CtSqliteFunction *)calloc(1, sizeof(CtSqliteFunction));
    if (callback == NULL) {
        free(name);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    callback->ctx = ctx;
    callback->callback = (JSObjectRef)argv[5];
    JSValueProtect(ctx, callback->callback);
    if (JSValueIsObject(ctx, argv[4]) && JSObjectIsFunction(ctx, (JSObjectRef)argv[4])) {
        callback->start_callback = (JSObjectRef)argv[4];
        JSValueProtect(ctx, callback->start_callback);
    } else {
        callback->start_value = argv[4];
        callback->has_start_value = true;
        JSValueProtect(ctx, callback->start_value);
    }
    if (!JSValueIsUndefined(ctx, argv[6]) && !JSValueIsNull(ctx, argv[6])) {
        callback->result_callback = (JSObjectRef)argv[6];
        JSValueProtect(ctx, callback->result_callback);
    }
    if (!JSValueIsUndefined(ctx, argv[7]) && !JSValueIsNull(ctx, argv[7])) {
        callback->inverse_callback = (JSObjectRef)argv[7];
        JSValueProtect(ctx, callback->inverse_callback);
    }

    int function_argc = (int)ct_value_to_number(ctx, argv[2]);
    int flags = SQLITE_UTF8 | (int)ct_value_to_number(ctx, argv[3]);
    int status;
    if (callback->inverse_callback != NULL) {
        status = sqlite3_create_window_function(
            entry->db,
            name,
            function_argc,
            flags,
            callback,
            ct_sqlite_aggregate_step,
            ct_sqlite_aggregate_final,
            ct_sqlite_aggregate_value,
            ct_sqlite_aggregate_inverse,
            ct_sqlite_function_destroy
        );
    } else {
        status = sqlite3_create_function_v2(
            entry->db,
            name,
            function_argc,
            flags,
            callback,
            NULL,
            ct_sqlite_aggregate_step,
            ct_sqlite_aggregate_final,
            ct_sqlite_function_destroy
        );
    }
    free(name);
    if (status != SQLITE_OK) {
        ct_sqlite_function_destroy(callback);
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_set_authorizer(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteSetAuthorizer(id, callback) requires database id and callback");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }

    sqlite3_set_authorizer(entry->db, NULL, NULL);
    if (entry->authorizer != NULL) {
        ct_sqlite_function_destroy(entry->authorizer);
        entry->authorizer = NULL;
    }

    if (JSValueIsNull(ctx, argv[1]) || JSValueIsUndefined(ctx, argv[1])) {
        return JSValueMakeUndefined(ctx);
    }
    if (!JSValueIsObject(ctx, argv[1]) || !JSObjectIsFunction(ctx, (JSObjectRef)argv[1])) {
        ct_throw_message(ctx, exception, "SQLite authorizer callback must be a function or null");
        return JSValueMakeUndefined(ctx);
    }

    CtSqliteFunction *callback = (CtSqliteFunction *)calloc(1, sizeof(CtSqliteFunction));
    if (callback == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    callback->ctx = ctx;
    callback->callback = (JSObjectRef)argv[1];
    JSValueProtect(ctx, callback->callback);

    int status = sqlite3_set_authorizer(entry->db, ct_sqlite_authorizer_call, callback);
    if (status != SQLITE_OK) {
        ct_sqlite_function_destroy(callback);
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    entry->authorizer = callback;
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_enable_load_extension(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteEnableLoadExtension(id, enabled) requires database id and enabled");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    if (!entry->allow_load_extension) {
        ct_throw_message(ctx, exception, "Cannot enable extension loading because it was disabled at database creation.");
        return JSValueMakeUndefined(ctx);
    }

    bool enabled = ct_value_to_bool(ctx, argv[1]);
    CtSqliteEnableLoadExtensionFn enable_load_extension = ct_sqlite_enable_load_extension_fn();
    if (enable_load_extension == NULL) {
        if (enabled) {
            ct_throw_message(ctx, exception, "SQLite extension loading is unavailable in this SQLite build");
            return JSValueMakeUndefined(ctx);
        }
    } else {
        int status = enable_load_extension(entry->db, enabled ? 1 : 0);
        if (status != SQLITE_OK) {
            ct_sqlite_throw(ctx, exception, entry->db);
            return JSValueMakeUndefined(ctx);
        }
    }
    entry->load_extension_enabled = enabled;
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_load_extension(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteLoadExtension(id, path) requires database id and path");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    if (!entry->allow_load_extension || !entry->load_extension_enabled) {
        ct_throw_message(ctx, exception, "extension loading is not allowed");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteLoadExtensionFn load_extension = ct_sqlite_load_extension_fn();
    if (load_extension == NULL) {
        ct_throw_message(ctx, exception, "SQLite extension loading is unavailable in this SQLite build");
        return JSValueMakeUndefined(ctx);
    }

    char *path = ct_value_to_string_copy(ctx, argv[1]);
    if (path == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    char *error_message = NULL;
    int status = load_extension(entry->db, path, NULL, &error_message);
    free(path);
    if (status != SQLITE_OK) {
        ct_throw_message(ctx, exception, error_message != NULL ? error_message : sqlite3_errmsg(entry->db));
        sqlite3_free(error_message);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_backup(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteBackup(id, path) requires database id and destination path");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *source = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (source == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[1]);
    if (path == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    sqlite3 *destination = NULL;
    int status = sqlite3_open_v2(path, &destination, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI, NULL);
    free(path);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, destination);
        if (destination != NULL) sqlite3_close(destination);
        return JSValueMakeUndefined(ctx);
    }

    sqlite3_backup *backup = sqlite3_backup_init(destination, "main", source->db, "main");
    if (backup == NULL) {
        ct_sqlite_throw(ctx, exception, destination);
        sqlite3_close(destination);
        return JSValueMakeUndefined(ctx);
    }
    int pages = 0;
    do {
        status = sqlite3_backup_step(backup, 100);
        pages += 100;
    } while (status == SQLITE_OK || status == SQLITE_BUSY || status == SQLITE_LOCKED);
    int finish_status = sqlite3_backup_finish(backup);
    if (finish_status != SQLITE_OK) status = finish_status;
    if (status != SQLITE_DONE) {
        ct_sqlite_throw(ctx, exception, destination);
        sqlite3_close(destination);
        return JSValueMakeUndefined(ctx);
    }
    sqlite3_close(destination);
    return JSValueMakeNumber(ctx, (double)pages);
}

static JSValueRef ct_sqlite_serialize(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteSerialize(id[, schema]) requires a database id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }

    char *schema = NULL;
    if (argc >= 2 && !JSValueIsUndefined(ctx, argv[1]) && !JSValueIsNull(ctx, argv[1])) {
        schema = ct_value_to_string_copy(ctx, argv[1]);
        if (schema == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
    }

    sqlite3_int64 size = 0;
    unsigned char *bytes = sqlite3_serialize(entry->db, schema != NULL ? schema : "main", &size, 0);
    free(schema);
    if (bytes == NULL) {
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }

    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, bytes, (size_t)size, ct_sqlite_array_buffer_free, NULL, exception);
}

static JSValueRef ct_sqlite_file_control(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "sqliteFileControl(id, fileName, op[, result]) requires database id, file name, and op");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }

    char *file_name = NULL;
    if (!JSValueIsUndefined(ctx, argv[1]) && !JSValueIsNull(ctx, argv[1])) {
        file_name = ct_value_to_string_copy(ctx, argv[1]);
        if (file_name == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
    }

    int op = (int)ct_value_to_number(ctx, argv[2]);
    int result_int = -1;
    void *result_ptr = NULL;
    uint8_t *bytes = NULL;
    size_t bytes_len = 0;
    if (argc >= 4 && !JSValueIsUndefined(ctx, argv[3]) && !JSValueIsNull(ctx, argv[3])) {
        if (ct_get_bytes(ctx, argv[3], &bytes, &bytes_len) == 0) {
            result_ptr = bytes;
        } else if (JSValueIsNumber(ctx, argv[3])) {
            result_int = (int)ct_value_to_number(ctx, argv[3]);
            result_ptr = &result_int;
        } else {
            free(file_name);
            ct_throw_message(ctx, exception, "sqliteFileControl result must be a number, null, ArrayBuffer, or typed array");
            return JSValueMakeUndefined(ctx);
        }
    }

    int status = sqlite3_file_control(entry->db, file_name, op, result_ptr);
    free(file_name);
    if (status == SQLITE_ERROR) {
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeNumber(ctx, status);
}

static JSValueRef ct_sqlite_session_create(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteSessionCreate(id[, dbName, table]) requires a database id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    char *db_name = argc >= 2 ? ct_value_to_optional_string(ctx, argv[1]) : NULL;
    char *table = argc >= 3 ? ct_value_to_optional_string(ctx, argv[2]) : NULL;

    sqlite3_session *session = NULL;
    int status = sqlite3session_create(entry->db, db_name != NULL ? db_name : "main", &session);
    free(db_name);
    if (status != SQLITE_OK) {
        free(table);
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    status = sqlite3session_attach(session, table);
    free(table);
    if (status != SQLITE_OK) {
        sqlite3session_delete(session);
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }

    CtSqliteSession *session_entry = (CtSqliteSession *)calloc(1, sizeof(CtSqliteSession));
    if (session_entry == NULL) {
        sqlite3session_delete(session);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    session_entry->id = ct_next_sqlite_session_id++;
    if (ct_next_sqlite_session_id == 0) ct_next_sqlite_session_id = 1;
    session_entry->session = session;
    session_entry->owner = entry;
    session_entry->next = ct_sqlite_sessions;
    ct_sqlite_sessions = session_entry;
    session_entry->owner_next = entry->sessions;
    entry->sessions = session_entry;

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, session_entry->id), exception);
    return result;
}

static JSValueRef ct_sqlite_session_changeset(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteSessionChangeset(id, patchset) requires a session id and patchset flag");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteSession *session = ct_sqlite_find_session((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (session == NULL) {
        ct_throw_message(ctx, exception, "SQLite session not found");
        return JSValueMakeUndefined(ctx);
    }
    int byte_len = 0;
    void *bytes = NULL;
    bool patchset = ct_value_to_bool(ctx, argv[1]);
    int status = patchset
        ? sqlite3session_patchset(session->session, &byte_len, &bytes)
        : sqlite3session_changeset(session->session, &byte_len, &bytes);
    if (status != SQLITE_OK) {
        if (bytes != NULL) sqlite3_free(bytes);
        ct_sqlite_throw(ctx, exception, session->owner != NULL ? session->owner->db : NULL);
        return JSValueMakeUndefined(ctx);
    }
    if (bytes == NULL || byte_len <= 0) {
        if (bytes != NULL) sqlite3_free(bytes);
        return ct_array_buffer_from_copy(ctx, "", 0, exception);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, bytes, (size_t)byte_len, ct_sqlite_array_buffer_free, NULL, exception);
}

static JSValueRef ct_sqlite_session_close(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteSessionClose(id) requires a session id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteSession *session = ct_sqlite_find_session((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (session != NULL) ct_sqlite_delete_session(session);
    return JSValueMakeUndefined(ctx);
}

static int ct_sqlite_changeset_filter(void *opaque, const char *table) {
    CtSqliteApplyCallbacks *callbacks = (CtSqliteApplyCallbacks *)opaque;
    if (callbacks == NULL || callbacks->filter == NULL) return 1;
    JSValueRef arg = ct_make_string(callbacks->ctx, table != NULL ? table : "");
    JSValueRef call_exception = NULL;
    JSValueRef result = JSObjectCallAsFunction(callbacks->ctx, callbacks->filter, NULL, 1, &arg, &call_exception);
    if (call_exception != NULL) {
        callbacks->error_message = ct_copy_exception(callbacks->ctx, call_exception);
        return 0;
    }
    return ct_value_to_bool(callbacks->ctx, result) ? 1 : 0;
}

static int ct_sqlite_changeset_conflict(void *opaque, int reason, sqlite3_changeset_iter *iterator) {
    (void)iterator;
    CtSqliteApplyCallbacks *callbacks = (CtSqliteApplyCallbacks *)opaque;
    if (callbacks == NULL || callbacks->conflict == NULL) return SQLITE_CHANGESET_ABORT;
    JSValueRef arg = JSValueMakeNumber(callbacks->ctx, reason);
    JSValueRef call_exception = NULL;
    JSValueRef result = JSObjectCallAsFunction(callbacks->ctx, callbacks->conflict, NULL, 1, &arg, &call_exception);
    if (call_exception != NULL) {
        callbacks->error_message = ct_copy_exception(callbacks->ctx, call_exception);
        return SQLITE_CHANGESET_ABORT;
    }
    return (int)ct_value_to_number(callbacks->ctx, result);
}

static JSValueRef ct_sqlite_apply_changeset(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteApplyChangeset(id, changeset[, filter, onConflict]) requires database id and changeset");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *bytes = NULL;
    size_t bytes_len = 0;
    if (ct_get_bytes(ctx, argv[1], &bytes, &bytes_len) != 0 || bytes_len > INT_MAX) {
        ct_throw_message(ctx, exception, "changeset must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }

    CtSqliteApplyCallbacks callbacks;
    memset(&callbacks, 0, sizeof(callbacks));
    callbacks.ctx = ctx;
    if (argc >= 3 && JSValueIsObject(ctx, argv[2]) && JSObjectIsFunction(ctx, (JSObjectRef)argv[2])) {
        callbacks.filter = (JSObjectRef)argv[2];
        JSValueProtect(ctx, callbacks.filter);
    }
    if (argc >= 4 && JSValueIsObject(ctx, argv[3]) && JSObjectIsFunction(ctx, (JSObjectRef)argv[3])) {
        callbacks.conflict = (JSObjectRef)argv[3];
        JSValueProtect(ctx, callbacks.conflict);
    }

    int status = sqlite3changeset_apply(
        entry->db,
        (int)bytes_len,
        bytes,
        callbacks.filter != NULL ? ct_sqlite_changeset_filter : NULL,
        ct_sqlite_changeset_conflict,
        &callbacks
    );

    if (callbacks.filter != NULL) JSValueUnprotect(ctx, callbacks.filter);
    if (callbacks.conflict != NULL) JSValueUnprotect(ctx, callbacks.conflict);
    if (callbacks.error_message != NULL) {
        ct_throw_message(ctx, exception, callbacks.error_message);
        free(callbacks.error_message);
        return JSValueMakeUndefined(ctx);
    }
    if (status == SQLITE_ABORT) return JSValueMakeBoolean(ctx, false);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeBoolean(ctx, true);
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

static void ct_free_envp(char **envp, size_t count) {
    if (envp == NULL) return;
    for (size_t index = 0; index < count; index += 1) free(envp[index]);
    free(envp);
}

static char **ct_env_entries_to_envp(const CtHostEnvEntry *entries, size_t count) {
    char **envp = (char **)calloc(count + 1, sizeof(char *));
    if (envp == NULL) return NULL;
    for (size_t index = 0; index < count; index += 1) {
        size_t name_len = strlen(entries[index].name);
        size_t value_len = strlen(entries[index].value);
        envp[index] = (char *)malloc(name_len + value_len + 2);
        if (envp[index] == NULL) {
            ct_free_envp(envp, index);
            return NULL;
        }
        memcpy(envp[index], entries[index].name, name_len);
        envp[index][name_len] = '=';
        memcpy(envp[index] + name_len + 1, entries[index].value, value_len);
        envp[index][name_len + value_len + 1] = '\0';
    }
    envp[count] = NULL;
    return envp;
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

static JSValueRef ct_dns_lookup(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "dnsLookup(hostname[, family]) requires a hostname");
        return JSValueMakeUndefined(ctx);
    }

    char *hostname = ct_value_to_string_copy(ctx, argv[0]);
    if (hostname == NULL) {
        ct_throw_message(ctx, exception, "Failed to read hostname");
        return JSValueMakeUndefined(ctx);
    }

    int family = argc >= 2 ? (int)ct_value_to_number(ctx, argv[1]) : 0;
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_socktype = SOCK_STREAM;
    if (family == 4) hints.ai_family = AF_INET;
    else if (family == 6) hints.ai_family = AF_INET6;
    else hints.ai_family = AF_UNSPEC;

    struct addrinfo *results = NULL;
    int status = getaddrinfo(hostname, NULL, &hints, &results);
    free(hostname);
    if (status != 0) {
        ct_throw_message(ctx, exception, gai_strerror(status));
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef array = ct_make_array(ctx, 0, NULL, exception);
    unsigned index = 0;
    for (struct addrinfo *entry = results; entry != NULL; entry = entry->ai_next) {
        if (entry->ai_family != AF_INET && entry->ai_family != AF_INET6) continue;
        char address[NI_MAXHOST];
        int name_status = getnameinfo(entry->ai_addr, (socklen_t)entry->ai_addrlen, address, sizeof(address), NULL, 0, NI_NUMERICHOST);
        if (name_status != 0) continue;
        JSObjectRef item = ct_make_object(ctx);
        ct_set_property(ctx, item, "address", ct_make_string(ctx, address), exception);
        ct_set_property(ctx, item, "family", JSValueMakeNumber(ctx, entry->ai_family == AF_INET6 ? 6 : 4), exception);
        JSObjectSetPropertyAtIndex(ctx, array, index++, item, exception);
    }
    freeaddrinfo(results);
    return array;
}

static JSValueRef ct_dns_lookup_service(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "dnsLookupService(address, port) requires address and port");
        return JSValueMakeUndefined(ctx);
    }

    char *address = ct_value_to_string_copy(ctx, argv[0]);
    int port = (int)ct_value_to_number(ctx, argv[1]);
    if (address == NULL) {
        ct_throw_message(ctx, exception, "Failed to read address");
        return JSValueMakeUndefined(ctx);
    }

    struct sockaddr_storage storage;
    memset(&storage, 0, sizeof(storage));
    socklen_t storage_len = 0;
    struct sockaddr_in *addr4 = (struct sockaddr_in *)&storage;
    struct sockaddr_in6 *addr6 = (struct sockaddr_in6 *)&storage;
    if (inet_pton(AF_INET, address, &addr4->sin_addr) == 1) {
        addr4->sin_family = AF_INET;
        addr4->sin_port = htons((uint16_t)port);
        storage_len = sizeof(struct sockaddr_in);
    } else if (inet_pton(AF_INET6, address, &addr6->sin6_addr) == 1) {
        addr6->sin6_family = AF_INET6;
        addr6->sin6_port = htons((uint16_t)port);
        storage_len = sizeof(struct sockaddr_in6);
    } else {
        free(address);
        ct_throw_message(ctx, exception, "lookupService requires an IPv4 or IPv6 address");
        return JSValueMakeUndefined(ctx);
    }
    free(address);

    char hostname[NI_MAXHOST];
    char service[NI_MAXSERV];
    int status = getnameinfo((struct sockaddr *)&storage, storage_len, hostname, sizeof(hostname), service, sizeof(service), 0);
    if (status != 0) {
        ct_throw_message(ctx, exception, gai_strerror(status));
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "hostname", ct_make_string(ctx, hostname), exception);
    ct_set_property(ctx, result, "service", ct_make_string(ctx, service), exception);
    return result;
}

#if !defined(_WIN32)
static int ct_dns_type_from_name(const char *type) {
    if (strcasecmp(type, "CNAME") == 0) return ns_t_cname;
    if (strcasecmp(type, "MX") == 0) return ns_t_mx;
    if (strcasecmp(type, "NS") == 0) return ns_t_ns;
    if (strcasecmp(type, "PTR") == 0) return ns_t_ptr;
    if (strcasecmp(type, "SOA") == 0) return ns_t_soa;
    if (strcasecmp(type, "SRV") == 0) return ns_t_srv;
    if (strcasecmp(type, "TXT") == 0) return ns_t_txt;
    if (strcasecmp(type, "NAPTR") == 0) return ns_t_naptr;
    if (strcasecmp(type, "TLSA") == 0) return 52;
    if (strcasecmp(type, "CAA") == 0) return 257;
    return -1;
}

static JSValueRef ct_dns_uncompress_name_value(JSContextRef ctx, ns_msg *message, const unsigned char *ptr, JSValueRef *exception) {
    char name[NS_MAXDNAME];
    if (ns_name_uncompress(ns_msg_base(*message), ns_msg_end(*message), ptr, name, sizeof(name)) < 0) {
        ct_throw_message(ctx, exception, "Failed to parse DNS name");
        return JSValueMakeUndefined(ctx);
    }
    return ct_make_string(ctx, name);
}

static const unsigned char *ct_dns_read_character_string(JSContextRef ctx, const unsigned char *cursor, const unsigned char *end, JSObjectRef out, unsigned *index, JSValueRef *exception) {
    if (cursor >= end) {
        ct_throw_message(ctx, exception, "Invalid DNS character string");
        return NULL;
    }
    unsigned length = *cursor++;
    if (cursor + length > end) {
        ct_throw_message(ctx, exception, "Invalid DNS character string length");
        return NULL;
    }
    JSObjectSetPropertyAtIndex(ctx, out, (*index)++, ct_make_string_len(ctx, (const char *)cursor, length), exception);
    return cursor + length;
}

static JSValueRef ct_dns_parse_record(JSContextRef ctx, ns_msg *message, ns_rr *record, int requested_type, JSValueRef *exception) {
    const unsigned char *rdata = ns_rr_rdata(*record);
    const unsigned char *end = rdata + ns_rr_rdlen(*record);
    int type = ns_rr_type(*record);
    if (type != requested_type) return JSValueMakeUndefined(ctx);

    if (type == ns_t_cname || type == ns_t_ns || type == ns_t_ptr) {
        return ct_dns_uncompress_name_value(ctx, message, rdata, exception);
    }

    if (type == ns_t_mx) {
        if (rdata + 2 > end) {
            ct_throw_message(ctx, exception, "Invalid MX record");
            return JSValueMakeUndefined(ctx);
        }
        JSObjectRef result = ct_make_object(ctx);
        ct_set_property(ctx, result, "exchange", ct_dns_uncompress_name_value(ctx, message, rdata + 2, exception), exception);
        ct_set_property(ctx, result, "priority", JSValueMakeNumber(ctx, ns_get16(rdata)), exception);
        ct_set_property(ctx, result, "type", ct_make_string(ctx, "MX"), exception);
        return result;
    }

    if (type == ns_t_txt) {
        JSObjectRef result = ct_make_array(ctx, 0, NULL, exception);
        unsigned index = 0;
        const unsigned char *cursor = rdata;
        while (cursor < end) {
            cursor = ct_dns_read_character_string(ctx, cursor, end, result, &index, exception);
            if (cursor == NULL) return JSValueMakeUndefined(ctx);
        }
        return result;
    }

    if (type == ns_t_soa) {
        JSObjectRef result = ct_make_object(ctx);
        char name[NS_MAXDNAME];
        int consumed = ns_name_uncompress(ns_msg_base(*message), ns_msg_end(*message), rdata, name, sizeof(name));
        if (consumed < 0) {
            ct_throw_message(ctx, exception, "Invalid SOA nsname");
            return JSValueMakeUndefined(ctx);
        }
        ct_set_property(ctx, result, "nsname", ct_make_string(ctx, name), exception);
        const unsigned char *cursor = rdata + consumed;
        consumed = ns_name_uncompress(ns_msg_base(*message), ns_msg_end(*message), cursor, name, sizeof(name));
        if (consumed < 0 || cursor + consumed + 20 > end) {
            ct_throw_message(ctx, exception, "Invalid SOA record");
            return JSValueMakeUndefined(ctx);
        }
        ct_set_property(ctx, result, "hostmaster", ct_make_string(ctx, name), exception);
        cursor += consumed;
        ct_set_property(ctx, result, "serial", JSValueMakeNumber(ctx, ns_get32(cursor)), exception); cursor += 4;
        ct_set_property(ctx, result, "refresh", JSValueMakeNumber(ctx, ns_get32(cursor)), exception); cursor += 4;
        ct_set_property(ctx, result, "retry", JSValueMakeNumber(ctx, ns_get32(cursor)), exception); cursor += 4;
        ct_set_property(ctx, result, "expire", JSValueMakeNumber(ctx, ns_get32(cursor)), exception); cursor += 4;
        ct_set_property(ctx, result, "minttl", JSValueMakeNumber(ctx, ns_get32(cursor)), exception);
        return result;
    }

    if (type == ns_t_srv) {
        if (rdata + 6 > end) {
            ct_throw_message(ctx, exception, "Invalid SRV record");
            return JSValueMakeUndefined(ctx);
        }
        JSObjectRef result = ct_make_object(ctx);
        ct_set_property(ctx, result, "priority", JSValueMakeNumber(ctx, ns_get16(rdata)), exception);
        ct_set_property(ctx, result, "weight", JSValueMakeNumber(ctx, ns_get16(rdata + 2)), exception);
        ct_set_property(ctx, result, "port", JSValueMakeNumber(ctx, ns_get16(rdata + 4)), exception);
        ct_set_property(ctx, result, "name", ct_dns_uncompress_name_value(ctx, message, rdata + 6, exception), exception);
        return result;
    }

    if (type == ns_t_naptr) {
        if (rdata + 4 > end) {
            ct_throw_message(ctx, exception, "Invalid NAPTR record");
            return JSValueMakeUndefined(ctx);
        }
        JSObjectRef result = ct_make_object(ctx);
        ct_set_property(ctx, result, "order", JSValueMakeNumber(ctx, ns_get16(rdata)), exception);
        ct_set_property(ctx, result, "preference", JSValueMakeNumber(ctx, ns_get16(rdata + 2)), exception);
        const unsigned char *cursor = rdata + 4;
        JSObjectRef holder = ct_make_array(ctx, 0, NULL, exception);
        unsigned index = 0;
        cursor = ct_dns_read_character_string(ctx, cursor, end, holder, &index, exception);
        if (cursor == NULL) return JSValueMakeUndefined(ctx);
        ct_set_property(ctx, result, "flags", JSObjectGetPropertyAtIndex(ctx, holder, 0, exception), exception);
        cursor = ct_dns_read_character_string(ctx, cursor, end, holder, &index, exception);
        if (cursor == NULL) return JSValueMakeUndefined(ctx);
        ct_set_property(ctx, result, "service", JSObjectGetPropertyAtIndex(ctx, holder, 1, exception), exception);
        cursor = ct_dns_read_character_string(ctx, cursor, end, holder, &index, exception);
        if (cursor == NULL) return JSValueMakeUndefined(ctx);
        ct_set_property(ctx, result, "regexp", JSObjectGetPropertyAtIndex(ctx, holder, 2, exception), exception);
        ct_set_property(ctx, result, "replacement", ct_dns_uncompress_name_value(ctx, message, cursor, exception), exception);
        return result;
    }

    if (type == 257) {
        if (rdata + 2 > end || rdata + 2 + rdata[1] > end) {
            ct_throw_message(ctx, exception, "Invalid CAA record");
            return JSValueMakeUndefined(ctx);
        }
        unsigned char flags = rdata[0];
        unsigned tag_len = rdata[1];
        char tag[256];
        memcpy(tag, rdata + 2, tag_len);
        tag[tag_len] = '\0';
        const unsigned char *value = rdata + 2 + tag_len;
        size_t value_len = (size_t)(end - value);
        JSObjectRef result = ct_make_object(ctx);
        ct_set_property(ctx, result, "critical", JSValueMakeNumber(ctx, (flags & 0x80) ? 1 : 0), exception);
        ct_set_property(ctx, result, "type", ct_make_string(ctx, "CAA"), exception);
        ct_set_property(ctx, result, tag, ct_make_string_len(ctx, (const char *)value, value_len), exception);
        return result;
    }

    if (type == 52) {
        if (rdata + 3 > end) {
            ct_throw_message(ctx, exception, "Invalid TLSA record");
            return JSValueMakeUndefined(ctx);
        }
        JSObjectRef result = ct_make_object(ctx);
        ct_set_property(ctx, result, "usage", JSValueMakeNumber(ctx, rdata[0]), exception);
        ct_set_property(ctx, result, "selector", JSValueMakeNumber(ctx, rdata[1]), exception);
        ct_set_property(ctx, result, "matchingType", JSValueMakeNumber(ctx, rdata[2]), exception);
        ct_set_property(ctx, result, "cert", ct_array_buffer_from_copy(ctx, (const char *)(rdata + 3), (size_t)(end - (rdata + 3)), exception), exception);
        return result;
    }

    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_dns_resolve_records(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "dnsResolveRecords(hostname, type) requires hostname and type");
        return JSValueMakeUndefined(ctx);
    }
    char *hostname = ct_value_to_string_copy(ctx, argv[0]);
    char *type_name = ct_value_to_string_copy(ctx, argv[1]);
    if (hostname == NULL || type_name == NULL) {
        free(hostname);
        free(type_name);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    int record_type = ct_dns_type_from_name(type_name);
    free(type_name);
    if (record_type < 0) {
        free(hostname);
        ct_throw_message(ctx, exception, "Unsupported DNS record type");
        return JSValueMakeUndefined(ctx);
    }

    unsigned char answer[65536];
    int length = res_query(hostname, ns_c_in, record_type, answer, sizeof(answer));
    free(hostname);
    if (length < 0) {
        ct_throw_message(ctx, exception, hstrerror(h_errno));
        return JSValueMakeUndefined(ctx);
    }

    ns_msg message;
    if (ns_initparse(answer, length, &message) != 0) {
        ct_throw_message(ctx, exception, "Failed to parse DNS response");
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef results = ct_make_array(ctx, 0, NULL, exception);
    unsigned result_index = 0;
    int count = ns_msg_count(message, ns_s_an);
    for (int index = 0; index < count; index += 1) {
        ns_rr record;
        if (ns_parserr(&message, ns_s_an, index, &record) != 0) continue;
        JSValueRef parsed = ct_dns_parse_record(ctx, &message, &record, record_type, exception);
        if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
        if (!JSValueIsUndefined(ctx, parsed)) {
            JSObjectSetPropertyAtIndex(ctx, results, result_index++, parsed, exception);
        }
    }
    return results;
}
#else
static int ct_dns_type_from_name(const char *type) {
    if (strcasecmp(type, "CNAME") == 0) return DNS_TYPE_CNAME;
    if (strcasecmp(type, "MX") == 0) return DNS_TYPE_MX;
    if (strcasecmp(type, "NS") == 0) return DNS_TYPE_NS;
    if (strcasecmp(type, "PTR") == 0) return DNS_TYPE_PTR;
    if (strcasecmp(type, "SOA") == 0) return DNS_TYPE_SOA;
    if (strcasecmp(type, "SRV") == 0) return DNS_TYPE_SRV;
    if (strcasecmp(type, "TXT") == 0) return DNS_TYPE_TEXT;
    if (strcasecmp(type, "NAPTR") == 0) return DNS_TYPE_NAPTR;
    if (strcasecmp(type, "TLSA") == 0) return 52;
    if (strcasecmp(type, "CAA") == 0) return 257;
    return -1;
}

static JSValueRef ct_dns_windows_record_to_js(JSContextRef ctx, const DNS_RECORDA *record, int requested_type, JSValueRef *exception) {
    if ((int)record->wType != requested_type) return JSValueMakeUndefined(ctx);

    if (requested_type == DNS_TYPE_CNAME || requested_type == DNS_TYPE_NS || requested_type == DNS_TYPE_PTR) {
        return ct_make_string(ctx, record->Data.PTR.pNameHost);
    }
    if (requested_type == DNS_TYPE_MX) {
        JSObjectRef result = ct_make_object(ctx);
        ct_set_property(ctx, result, "exchange", ct_make_string(ctx, record->Data.MX.pNameExchange), exception);
        ct_set_property(ctx, result, "priority", JSValueMakeNumber(ctx, record->Data.MX.wPreference), exception);
        ct_set_property(ctx, result, "type", ct_make_string(ctx, "MX"), exception);
        return result;
    }
    if (requested_type == DNS_TYPE_TEXT) {
        JSObjectRef result = ct_make_array(ctx, 0, NULL, exception);
        for (DWORD index = 0; index < record->Data.TXT.dwStringCount; index += 1) {
            JSObjectSetPropertyAtIndex(ctx, result, index, ct_make_string(ctx, record->Data.TXT.pStringArray[index]), exception);
        }
        return result;
    }
    if (requested_type == DNS_TYPE_SOA) {
        JSObjectRef result = ct_make_object(ctx);
        ct_set_property(ctx, result, "nsname", ct_make_string(ctx, record->Data.SOA.pNamePrimaryServer), exception);
        ct_set_property(ctx, result, "hostmaster", ct_make_string(ctx, record->Data.SOA.pNameAdministrator), exception);
        ct_set_property(ctx, result, "serial", JSValueMakeNumber(ctx, record->Data.SOA.dwSerialNo), exception);
        ct_set_property(ctx, result, "refresh", JSValueMakeNumber(ctx, record->Data.SOA.dwRefresh), exception);
        ct_set_property(ctx, result, "retry", JSValueMakeNumber(ctx, record->Data.SOA.dwRetry), exception);
        ct_set_property(ctx, result, "expire", JSValueMakeNumber(ctx, record->Data.SOA.dwExpire), exception);
        ct_set_property(ctx, result, "minttl", JSValueMakeNumber(ctx, record->Data.SOA.dwDefaultTtl), exception);
        return result;
    }
    if (requested_type == DNS_TYPE_SRV) {
        JSObjectRef result = ct_make_object(ctx);
        ct_set_property(ctx, result, "priority", JSValueMakeNumber(ctx, record->Data.SRV.wPriority), exception);
        ct_set_property(ctx, result, "weight", JSValueMakeNumber(ctx, record->Data.SRV.wWeight), exception);
        ct_set_property(ctx, result, "port", JSValueMakeNumber(ctx, record->Data.SRV.wPort), exception);
        ct_set_property(ctx, result, "name", ct_make_string(ctx, record->Data.SRV.pNameTarget), exception);
        return result;
    }
    if (requested_type == DNS_TYPE_NAPTR) {
        JSObjectRef result = ct_make_object(ctx);
        ct_set_property(ctx, result, "order", JSValueMakeNumber(ctx, record->Data.NAPTR.wOrder), exception);
        ct_set_property(ctx, result, "preference", JSValueMakeNumber(ctx, record->Data.NAPTR.wPreference), exception);
        ct_set_property(ctx, result, "flags", ct_make_string(ctx, record->Data.NAPTR.pFlags), exception);
        ct_set_property(ctx, result, "service", ct_make_string(ctx, record->Data.NAPTR.pService), exception);
        ct_set_property(ctx, result, "regexp", ct_make_string(ctx, record->Data.NAPTR.pRegularExpression), exception);
        ct_set_property(ctx, result, "replacement", ct_make_string(ctx, record->Data.NAPTR.pReplacement), exception);
        return result;
    }
    if (requested_type == 52) {
        JSObjectRef result = ct_make_object(ctx);
        ct_set_property(ctx, result, "usage", JSValueMakeNumber(ctx, record->Data.TLSA.bCertUsage), exception);
        ct_set_property(ctx, result, "selector", JSValueMakeNumber(ctx, record->Data.TLSA.bSelector), exception);
        ct_set_property(ctx, result, "matchingType", JSValueMakeNumber(ctx, record->Data.TLSA.bMatchingType), exception);
        ct_set_property(ctx, result, "cert", ct_array_buffer_from_copy(ctx, (const char *)record->Data.TLSA.bCertificateAssociationData, record->Data.TLSA.bCertificateAssociationDataLength, exception), exception);
        return result;
    }
    if (requested_type == 257) {
        const BYTE *data = record->Data.UNKNOWN.bData;
        DWORD data_len = record->Data.UNKNOWN.dwByteCount;
        if (data_len < 2 || 2u + data[1] > data_len) {
            ct_throw_message(ctx, exception, "Invalid CAA record");
            return JSValueMakeUndefined(ctx);
        }
        unsigned tag_len = data[1];
        char tag[256];
        memcpy(tag, data + 2, tag_len);
        tag[tag_len] = '\0';
        JSObjectRef result = ct_make_object(ctx);
        ct_set_property(ctx, result, "critical", JSValueMakeNumber(ctx, (data[0] & 0x80) ? 1 : 0), exception);
        ct_set_property(ctx, result, "type", ct_make_string(ctx, "CAA"), exception);
        ct_set_property(ctx, result, tag, ct_make_string_len(ctx, (const char *)(data + 2 + tag_len), data_len - 2 - tag_len), exception);
        return result;
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_dns_resolve_records(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "dnsResolveRecords(hostname, type) requires hostname and type");
        return JSValueMakeUndefined(ctx);
    }
    char *hostname = ct_value_to_string_copy(ctx, argv[0]);
    char *type_name = ct_value_to_string_copy(ctx, argv[1]);
    if (hostname == NULL || type_name == NULL) {
        free(hostname);
        free(type_name);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    int record_type = ct_dns_type_from_name(type_name);
    free(type_name);
    if (record_type < 0) {
        free(hostname);
        ct_throw_message(ctx, exception, "Unsupported DNS record type");
        return JSValueMakeUndefined(ctx);
    }

    DNS_RECORDA *records = NULL;
    DNS_STATUS status = DnsQuery_A(hostname, (WORD)record_type, DNS_QUERY_STANDARD, NULL, &records, NULL);
    free(hostname);
    if (status != ERROR_SUCCESS) {
        char message[80];
        snprintf(message, sizeof(message), "DNS query failed with status %ld", (long)status);
        ct_throw_message(ctx, exception, message);
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef results = ct_make_array(ctx, 0, NULL, exception);
    unsigned result_index = 0;
    for (DNS_RECORDA *record = records; record != NULL; record = record->pNext) {
        JSValueRef parsed = ct_dns_windows_record_to_js(ctx, record, record_type, exception);
        if (exception != NULL && *exception != NULL) {
            DnsRecordListFree(records, DnsFreeRecordList);
            return JSValueMakeUndefined(ctx);
        }
        if (!JSValueIsUndefined(ctx, parsed)) JSObjectSetPropertyAtIndex(ctx, results, result_index++, parsed, exception);
    }
    DnsRecordListFree(records, DnsFreeRecordList);
    return results;
}
#endif

static JSObjectRef ct_udp_make_address(JSContextRef ctx, const struct sockaddr *addr, socklen_t addr_len, JSValueRef *exception) {
    char host[NI_MAXHOST];
    char service[NI_MAXSERV];
    int status = getnameinfo(addr, addr_len, host, sizeof(host), service, sizeof(service), NI_NUMERICHOST | NI_NUMERICSERV);
    if (status != 0) {
        ct_throw_message(ctx, exception, gai_strerror(status));
        return NULL;
    }
    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "address", ct_make_string(ctx, host), exception);
    ct_set_property(ctx, result, "port", JSValueMakeNumber(ctx, atoi(service)), exception);
    ct_set_property(ctx, result, "family", ct_make_string(ctx, addr->sa_family == AF_INET6 ? "IPv6" : "IPv4"), exception);
    return result;
}

static int ct_udp_family_from_arg(JSContextRef ctx, JSValueRef value) {
    int family = (int)ct_value_to_number(ctx, value);
    return family == 6 ? AF_INET6 : AF_INET;
}

static int ct_udp_resolve_address(JSContextRef ctx, const char *address, int port, int family, struct sockaddr_storage *storage, socklen_t *storage_len, JSValueRef *exception) {
    char port_text[32];
    snprintf(port_text, sizeof(port_text), "%d", port);

    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = family;
    hints.ai_socktype = SOCK_DGRAM;
    hints.ai_flags = address == NULL || address[0] == 0 ? AI_PASSIVE : 0;

    struct addrinfo *results = NULL;
    int status = getaddrinfo(address != NULL && address[0] != 0 ? address : NULL, port_text, &hints, &results);
    if (status != 0) {
        ct_throw_message(ctx, exception, gai_strerror(status));
        return -1;
    }
    if (results == NULL || results->ai_addrlen > sizeof(struct sockaddr_storage)) {
        freeaddrinfo(results);
        ct_throw_message(ctx, exception, "Failed to resolve UDP address");
        return -1;
    }
    memcpy(storage, results->ai_addr, results->ai_addrlen);
    *storage_len = (socklen_t)results->ai_addrlen;
    freeaddrinfo(results);
    return 0;
}

static JSValueRef ct_udp_socket_create(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    int family = argc >= 1 ? ct_udp_family_from_arg(ctx, argv[0]) : AF_INET;
    int fd = socket(family, SOCK_DGRAM, 0);
    if (fd < 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
#if defined(_WIN32)
    u_long nonblocking = 1;
    ioctlsocket(fd, FIONBIO, &nonblocking);
#else
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
#endif
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "fd", JSValueMakeNumber(ctx, fd), exception);
    ct_set_property(ctx, result, "family", JSValueMakeNumber(ctx, family == AF_INET6 ? 6 : 4), exception);
    return result;
}

static JSValueRef ct_udp_socket_bind(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "udpSocketBind(fd, port, address, family) requires fd, port, and address");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    int port = (int)ct_value_to_number(ctx, argv[1]);
    char *address = ct_value_to_optional_string(ctx, argv[2]);
    int family = argc >= 4 ? ct_udp_family_from_arg(ctx, argv[3]) : AF_INET;
    struct sockaddr_storage storage;
    socklen_t storage_len = 0;
    if (ct_udp_resolve_address(ctx, address, port, family, &storage, &storage_len, exception) != 0) {
        free(address);
        return JSValueMakeUndefined(ctx);
    }
    free(address);
    if (bind(fd, (struct sockaddr *)&storage, storage_len) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }

    struct sockaddr_storage bound;
    socklen_t bound_len = sizeof(bound);
    if (getsockname(fd, (struct sockaddr *)&bound, &bound_len) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    JSObjectRef result = ct_udp_make_address(ctx, (struct sockaddr *)&bound, bound_len, exception);
    return result != NULL ? result : JSValueMakeUndefined(ctx);
}

static JSValueRef ct_udp_socket_address(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "udpSocketAddress(fd) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    struct sockaddr_storage address;
    socklen_t address_len = sizeof(address);
    if (getsockname(fd, (struct sockaddr *)&address, &address_len) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    JSObjectRef result = ct_udp_make_address(ctx, (struct sockaddr *)&address, address_len, exception);
    return result != NULL ? result : JSValueMakeUndefined(ctx);
}

static JSValueRef ct_udp_socket_send(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 5) {
        ct_throw_message(ctx, exception, "udpSocketSend(fd, data, port, address, family) requires fd, data, port, address, and family");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    uint8_t *data = NULL;
    size_t data_len = 0;
    if (ct_get_bytes(ctx, argv[1], &data, &data_len) != 0) {
        ct_throw_message(ctx, exception, "UDP data must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }
    int port = (int)ct_value_to_number(ctx, argv[2]);
    char *address = ct_value_to_optional_string(ctx, argv[3]);
    int family = ct_udp_family_from_arg(ctx, argv[4]);
    struct sockaddr_storage storage;
    socklen_t storage_len = 0;
    if (ct_udp_resolve_address(ctx, address, port, family, &storage, &storage_len, exception) != 0) {
        free(address);
        return JSValueMakeUndefined(ctx);
    }
    free(address);
    ssize_t sent = sendto(fd, (const char *)data, (int)data_len, 0, (struct sockaddr *)&storage, storage_len);
    if (sent < 0 && errno == EISCONN) {
        sent = send(fd, (const char *)data, (int)data_len, 0);
    }
    if (sent < 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeNumber(ctx, (double)sent);
}

static JSValueRef ct_udp_socket_connect(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 4) {
        ct_throw_message(ctx, exception, "udpSocketConnect(fd, port, address, family) requires fd, port, address, and family");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    int port = (int)ct_value_to_number(ctx, argv[1]);
    char *address = ct_value_to_optional_string(ctx, argv[2]);
    int family = ct_udp_family_from_arg(ctx, argv[3]);
    struct sockaddr_storage storage;
    socklen_t storage_len = 0;
    if (ct_udp_resolve_address(ctx, address, port, family, &storage, &storage_len, exception) != 0) {
        free(address);
        return JSValueMakeUndefined(ctx);
    }
    free(address);
    if (connect(fd, (struct sockaddr *)&storage, storage_len) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_udp_socket_receive(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "udpSocketReceive(fd[, maxBytes]) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    size_t max_bytes = argc >= 2 ? (size_t)ct_value_to_number(ctx, argv[1]) : 65536;
    if (max_bytes == 0) max_bytes = 65536;
    if (max_bytes > 1024 * 1024) max_bytes = 1024 * 1024;

#ifdef _WIN32
    int ready = ct_windows_descriptor_read_ready(fd);
#else
    struct pollfd poll_fd;
    poll_fd.fd = fd;
    poll_fd.events = POLLIN | POLLERR | POLLHUP;
    poll_fd.revents = 0;
    int ready = poll(&poll_fd, 1, 0);
#endif
    if (ready == 0) return JSValueMakeNull(ctx);
    if (ready < 0) {
        if (errno == EINTR) return JSValueMakeNull(ctx);
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
#ifndef _WIN32
    if ((poll_fd.revents & POLLNVAL) != 0) {
        ct_throw_message(ctx, exception, "invalid UDP socket");
        return JSValueMakeUndefined(ctx);
    }
    if ((poll_fd.revents & POLLIN) == 0) return JSValueMakeNull(ctx);
#endif

    char *buffer = (char *)malloc(max_bytes > 0 ? max_bytes : 1);
    if (buffer == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    struct sockaddr_storage source;
    socklen_t source_len = sizeof(source);
    ssize_t received = recvfrom(fd, buffer, max_bytes, 0, (struct sockaddr *)&source, &source_len);
    if (received < 0) {
        free(buffer);
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return JSValueMakeNull(ctx);
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef result = ct_make_object(ctx);
    JSObjectRef rinfo = ct_udp_make_address(ctx, (struct sockaddr *)&source, source_len, exception);
    if (rinfo == NULL) {
        free(buffer);
        return JSValueMakeUndefined(ctx);
    }
    ct_set_property(ctx, rinfo, "size", JSValueMakeNumber(ctx, (double)received), exception);
    ct_set_property(ctx, result, "rinfo", rinfo, exception);
    ct_set_property(ctx, result, "data", JSObjectMakeArrayBufferWithBytesNoCopy(ctx, buffer, (size_t)received, ct_array_buffer_free, NULL, exception), exception);
    return result;
}

static JSValueRef ct_udp_socket_close(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "udpSocketClose(fd) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    if (fd >= 0 && close(fd) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_udp_socket_set_broadcast(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "udpSocketSetBroadcast(fd[, enabled]) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    int enabled = argc >= 2 ? (ct_value_to_bool(ctx, argv[1]) ? 1 : 0) : 1;
    if (setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &enabled, sizeof(enabled)) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeBoolean(ctx, true);
}

static JSValueRef ct_udp_socket_set_ttl(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "udpSocketSetTTL(fd, ttl[, family]) requires a file descriptor and ttl");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    int ttl = (int)ct_value_to_number(ctx, argv[1]);
    int family = argc >= 3 ? ct_udp_family_from_arg(ctx, argv[2]) : AF_INET;
    int level = family == AF_INET6 ? IPPROTO_IPV6 : IPPROTO_IP;
#if defined(IPV6_UNICAST_HOPS)
    int option = family == AF_INET6 ? IPV6_UNICAST_HOPS : IP_TTL;
#else
    int option = IP_TTL;
#endif
    if (setsockopt(fd, level, option, &ttl, sizeof(ttl)) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeNumber(ctx, ttl);
}

static JSValueRef ct_udp_socket_set_multicast_ttl(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "udpSocketSetMulticastTTL(fd, ttl[, family]) requires a file descriptor and ttl");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    int ttl = (int)ct_value_to_number(ctx, argv[1]);
    int family = argc >= 3 ? ct_udp_family_from_arg(ctx, argv[2]) : AF_INET;
    if (family == AF_INET6) {
#if defined(IPV6_MULTICAST_HOPS)
        if (setsockopt(fd, IPPROTO_IPV6, IPV6_MULTICAST_HOPS, &ttl, sizeof(ttl)) != 0) {
            ct_throw_message(ctx, exception, strerror(errno));
            return JSValueMakeUndefined(ctx);
        }
#endif
    } else {
        unsigned char value = (unsigned char)ttl;
        if (setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &value, sizeof(value)) != 0) {
            ct_throw_message(ctx, exception, strerror(errno));
            return JSValueMakeUndefined(ctx);
        }
    }
    return JSValueMakeNumber(ctx, ttl);
}

static JSValueRef ct_udp_socket_set_multicast_loopback(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "udpSocketSetMulticastLoopback(fd[, enabled[, family]]) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    int enabled = argc >= 2 ? (ct_value_to_bool(ctx, argv[1]) ? 1 : 0) : 1;
    int family = argc >= 3 ? ct_udp_family_from_arg(ctx, argv[2]) : AF_INET;
    if (family == AF_INET6) {
#if defined(IPV6_MULTICAST_LOOP)
        if (setsockopt(fd, IPPROTO_IPV6, IPV6_MULTICAST_LOOP, &enabled, sizeof(enabled)) != 0) {
            ct_throw_message(ctx, exception, strerror(errno));
            return JSValueMakeUndefined(ctx);
        }
#endif
    } else {
        unsigned char value = (unsigned char)enabled;
        if (setsockopt(fd, IPPROTO_IP, IP_MULTICAST_LOOP, &value, sizeof(value)) != 0) {
            ct_throw_message(ctx, exception, strerror(errno));
            return JSValueMakeUndefined(ctx);
        }
    }
    return JSValueMakeBoolean(ctx, enabled != 0);
}

static JSValueRef ct_udp_socket_set_buffer_size(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "udpSocketSetBufferSize(fd, send, size) requires fd, send, and size");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    int option = ct_value_to_bool(ctx, argv[1]) ? SO_SNDBUF : SO_RCVBUF;
    int size = (int)ct_value_to_number(ctx, argv[2]);
    if (setsockopt(fd, SOL_SOCKET, option, &size, sizeof(size)) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeNumber(ctx, size);
}

static JSValueRef ct_udp_socket_get_buffer_size(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "udpSocketGetBufferSize(fd, send) requires fd and send");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    int option = ct_value_to_bool(ctx, argv[1]) ? SO_SNDBUF : SO_RCVBUF;
    int size = 0;
    socklen_t size_len = sizeof(size);
    if (getsockopt(fd, SOL_SOCKET, option, &size, &size_len) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeNumber(ctx, size);
}

static JSValueRef ct_udp_socket_membership(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "udpSocketMembership(fd, multicastAddress[, interfaceAddress[, family[, join]]]) requires fd and multicastAddress");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    char *multicast = ct_value_to_optional_string(ctx, argv[1]);
    char *iface = argc >= 3 ? ct_value_to_optional_string(ctx, argv[2]) : NULL;
    int family = argc >= 4 ? ct_udp_family_from_arg(ctx, argv[3]) : AF_INET;
    bool join = argc >= 5 ? ct_value_to_bool(ctx, argv[4]) : true;
    int status = 0;
    if (family == AF_INET6) {
#if defined(IPV6_JOIN_GROUP) && defined(IPV6_LEAVE_GROUP)
        struct ipv6_mreq request;
        memset(&request, 0, sizeof(request));
        if (multicast == NULL || inet_pton(AF_INET6, multicast, &request.ipv6mr_multiaddr) != 1) {
            status = EINVAL;
        } else {
            request.ipv6mr_interface = iface != NULL && iface[0] != 0 ? if_nametoindex(iface) : 0;
            int option = join ? IPV6_JOIN_GROUP : IPV6_LEAVE_GROUP;
            if (setsockopt(fd, IPPROTO_IPV6, option, &request, sizeof(request)) != 0) status = errno;
        }
#else
        status = ENOSYS;
#endif
    } else {
        struct ip_mreq request;
        memset(&request, 0, sizeof(request));
        if (multicast == NULL || inet_pton(AF_INET, multicast, &request.imr_multiaddr) != 1) {
            status = EINVAL;
        } else if (iface != NULL && iface[0] != 0) {
            if (inet_pton(AF_INET, iface, &request.imr_interface) != 1) request.imr_interface.s_addr = htonl(INADDR_ANY);
        } else {
            request.imr_interface.s_addr = htonl(INADDR_ANY);
        }
        if (status == 0) {
            int option = join ? IP_ADD_MEMBERSHIP : IP_DROP_MEMBERSHIP;
            if (setsockopt(fd, IPPROTO_IP, option, &request, sizeof(request)) != 0) status = errno;
        }
    }
    free(multicast);
    free(iface);
    if (status != 0) {
        ct_throw_message(ctx, exception, strerror(status));
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeBoolean(ctx, true);
}

static int ct_tcp_family_from_arg(JSContextRef ctx, JSValueRef value) {
    int family = (int)ct_value_to_number(ctx, value);
    return family == 6 ? AF_INET6 : AF_INET;
}

static int ct_tcp_resolve_address(JSContextRef ctx, const char *address, int port, int family, bool passive, struct addrinfo **out_results, JSValueRef *exception) {
    char port_text[32];
    snprintf(port_text, sizeof(port_text), "%d", port);

    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = family;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = passive ? AI_PASSIVE : 0;

    int status = getaddrinfo(address != NULL && address[0] != 0 ? address : NULL, port_text, &hints, out_results);
    if (status != 0) {
        ct_throw_message(ctx, exception, gai_strerror(status));
        return -1;
    }
    return 0;
}

static void ct_set_nonblocking_fd(int fd) {
#if defined(_WIN32)
    u_long nonblocking = 1;
    ioctlsocket(fd, FIONBIO, &nonblocking);
#else
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
#endif
}

static void ct_set_blocking_fd(int fd) {
#if defined(_WIN32)
    u_long nonblocking = 0;
    ioctlsocket(fd, FIONBIO, &nonblocking);
#else
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0) fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);
#endif
}

static JSObjectRef ct_tcp_address_object(JSContextRef ctx, int fd, bool peer, JSValueRef *exception) {
    struct sockaddr_storage address;
    socklen_t address_len = sizeof(address);
    int status = peer
        ? getpeername(fd, (struct sockaddr *)&address, &address_len)
        : getsockname(fd, (struct sockaddr *)&address, &address_len);
    if (status != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return NULL;
    }
    return ct_udp_make_address(ctx, (struct sockaddr *)&address, address_len, exception);
}

static JSValueRef ct_tcp_server_listen(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "tcpServerListen(port, address[, family]) requires a port and address");
        return JSValueMakeUndefined(ctx);
    }
#if !defined(_WIN32)
    signal(SIGPIPE, SIG_IGN);
#endif
    double port_number = ct_value_to_number(ctx, argv[0]);
    if (!isfinite(port_number) || port_number < 0 || port_number > 65535) {
        ct_throw_message(ctx, exception, "tcpServerListen(port, address[, family]) requires a valid port");
        return JSValueMakeUndefined(ctx);
    }
    int port = (int)port_number;
    char *address = ct_value_to_optional_string(ctx, argv[1]);
    int family = argc >= 3 ? ct_tcp_family_from_arg(ctx, argv[2]) : AF_INET;

    struct addrinfo *results = NULL;
    if (ct_tcp_resolve_address(ctx, address, port, family, true, &results, exception) != 0) {
        free(address);
        return JSValueMakeUndefined(ctx);
    }
    free(address);

    int listen_fd = -1;
    for (struct addrinfo *entry = results; entry != NULL; entry = entry->ai_next) {
        listen_fd = socket(entry->ai_family, entry->ai_socktype, entry->ai_protocol);
        if (listen_fd < 0) continue;
        int yes = 1;
        setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
        if (bind(listen_fd, entry->ai_addr, (socklen_t)entry->ai_addrlen) == 0 && listen(listen_fd, 128) == 0) {
            ct_set_nonblocking_fd(listen_fd);
            break;
        }
        close(listen_fd);
        listen_fd = -1;
    }
    freeaddrinfo(results);
    if (listen_fd < 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "fd", JSValueMakeNumber(ctx, listen_fd), exception);
    JSObjectRef local = ct_tcp_address_object(ctx, listen_fd, false, exception);
    if (local != NULL) ct_set_property(ctx, result, "address", local, exception);
    return result;
}

static JSValueRef ct_tcp_server_accept(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "tcpServerAccept(fd) requires a server file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    int listen_fd = (int)ct_value_to_number(ctx, argv[0]);
    struct sockaddr_storage remote_addr;
    socklen_t remote_len = sizeof(remote_addr);
    int fd = accept(listen_fd, (struct sockaddr *)&remote_addr, &remote_len);
    if (fd < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return JSValueMakeNull(ctx);
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    int no_delay = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &no_delay, sizeof(no_delay));
#if defined(TCP_SENDMOREACKS)
    int send_more_acks = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_SENDMOREACKS, &send_more_acks, sizeof(send_more_acks));
#endif
    ct_set_nonblocking_fd(fd);

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "fd", JSValueMakeNumber(ctx, fd), exception);
    JSObjectRef remote = ct_udp_make_address(ctx, (struct sockaddr *)&remote_addr, remote_len, exception);
    if (remote != NULL) ct_set_property(ctx, result, "remote", remote, exception);
    JSObjectRef local = ct_tcp_address_object(ctx, fd, false, exception);
    if (local != NULL) ct_set_property(ctx, result, "local", local, exception);
    return result;
}

static JSValueRef ct_tcp_socket_connect(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "tcpSocketConnect(port, address[, family]) requires a port and address");
        return JSValueMakeUndefined(ctx);
    }
#if !defined(_WIN32)
    signal(SIGPIPE, SIG_IGN);
#endif
    double port_number = ct_value_to_number(ctx, argv[0]);
    if (!isfinite(port_number) || port_number < 0 || port_number > 65535) {
        ct_throw_message(ctx, exception, "tcpSocketConnect(port, address[, family]) requires a valid port");
        return JSValueMakeUndefined(ctx);
    }
    int port = (int)port_number;
    char *address = ct_value_to_optional_string(ctx, argv[1]);
    int family = argc >= 3 ? ct_tcp_family_from_arg(ctx, argv[2]) : AF_INET;

    struct addrinfo *results = NULL;
    if (ct_tcp_resolve_address(ctx, address != NULL ? address : "127.0.0.1", port, family, false, &results, exception) != 0) {
        free(address);
        return JSValueMakeUndefined(ctx);
    }
    free(address);

    int fd = -1;
    int last_errno = ECONNREFUSED;
    for (struct addrinfo *entry = results; entry != NULL; entry = entry->ai_next) {
        fd = socket(entry->ai_family, entry->ai_socktype, entry->ai_protocol);
        if (fd < 0) {
            last_errno = errno;
            continue;
        }
        if (connect(fd, entry->ai_addr, (socklen_t)entry->ai_addrlen) == 0) {
            break;
        }
        last_errno = errno;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(results);
    if (fd < 0) {
        ct_throw_message(ctx, exception, strerror(last_errno));
        return JSValueMakeUndefined(ctx);
    }
    int no_delay = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &no_delay, sizeof(no_delay));
    ct_set_nonblocking_fd(fd);
    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "fd", JSValueMakeNumber(ctx, fd), exception);
    JSObjectRef local = ct_tcp_address_object(ctx, fd, false, exception);
    if (local != NULL) ct_set_property(ctx, result, "local", local, exception);
    JSObjectRef remote = ct_tcp_address_object(ctx, fd, true, exception);
    if (remote != NULL) ct_set_property(ctx, result, "remote", remote, exception);
    return result;
}

static JSObjectRef ct_unix_address_from_path(JSContextRef ctx, const char *path, JSValueRef *exception) {
    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "path", ct_make_string(ctx, path != NULL ? path : ""), exception);
    ct_set_property(ctx, result, "family", ct_make_string(ctx, "Unix"), exception);
    return result;
}

static JSObjectRef ct_unix_address_from_fd(JSContextRef ctx, int fd, bool peer, JSValueRef *exception) {
#if !defined(_WIN32)
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    socklen_t address_len = sizeof(address);
    int status = peer
        ? getpeername(fd, (struct sockaddr *)&address, &address_len)
        : getsockname(fd, (struct sockaddr *)&address, &address_len);
    if (status != 0) return ct_unix_address_from_path(ctx, "", exception);
    size_t base_len = offsetof(struct sockaddr_un, sun_path);
    size_t path_capacity = address_len > base_len ? (size_t)(address_len - base_len) : 0;
    size_t path_len = strnlen(address.sun_path, path_capacity);
    char path[sizeof(address.sun_path) + 1];
    if (path_len > sizeof(address.sun_path)) path_len = sizeof(address.sun_path);
    memcpy(path, address.sun_path, path_len);
    path[path_len] = 0;
    return ct_unix_address_from_path(ctx, path, exception);
#else
    (void)fd;
    (void)peer;
    return ct_unix_address_from_path(ctx, "", exception);
#endif
}

static JSValueRef ct_unix_server_listen(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
#if defined(_WIN32)
    (void)argc;
    (void)argv;
    ct_throw_message(ctx, exception, "Unix domain sockets are not available on this platform");
    return JSValueMakeUndefined(ctx);
#else
    if (argc < 1) {
        ct_throw_message(ctx, exception, "unixServerListen(path[, backlog]) requires a socket path");
        return JSValueMakeUndefined(ctx);
    }
    signal(SIGPIPE, SIG_IGN);
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    if (path == NULL) return JSValueMakeUndefined(ctx);
    if (strlen(path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) {
        free(path);
        ct_throw_message(ctx, exception, "Unix socket path is too long");
        return JSValueMakeUndefined(ctx);
    }

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        free(path);
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }

    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    strncpy(address.sun_path, path, sizeof(address.sun_path) - 1);
    unlink(path);

    int backlog = argc >= 2 ? (int)ct_value_to_number(ctx, argv[1]) : 128;
    if (backlog <= 0) backlog = 128;
    if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(fd, backlog) != 0) {
        char *message = ct_duplicate_string(strerror(errno));
        close(fd);
        unlink(path);
        free(path);
        ct_throw_message(ctx, exception, message != NULL ? message : "Unix socket listen failed");
        free(message);
        return JSValueMakeUndefined(ctx);
    }
    ct_set_nonblocking_fd(fd);

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "fd", JSValueMakeNumber(ctx, fd), exception);
    ct_set_property(ctx, result, "path", ct_make_string(ctx, path), exception);
    JSObjectRef local = ct_unix_address_from_path(ctx, path, exception);
    ct_set_property(ctx, result, "address", local, exception);
    free(path);
    return result;
#endif
}

static JSValueRef ct_unix_server_accept(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
#if defined(_WIN32)
    (void)argc;
    (void)argv;
    return JSValueMakeNull(ctx);
#else
    if (argc < 1) {
        ct_throw_message(ctx, exception, "unixServerAccept(fd) requires a server file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    int listen_fd = (int)ct_value_to_number(ctx, argv[0]);
    struct sockaddr_un remote_addr;
    memset(&remote_addr, 0, sizeof(remote_addr));
    socklen_t remote_len = sizeof(remote_addr);
    int fd = accept(listen_fd, (struct sockaddr *)&remote_addr, &remote_len);
    if (fd < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return JSValueMakeNull(ctx);
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    ct_set_nonblocking_fd(fd);

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "fd", JSValueMakeNumber(ctx, fd), exception);
    JSObjectRef local = ct_unix_address_from_fd(ctx, fd, false, exception);
    if (local != NULL) ct_set_property(ctx, result, "local", local, exception);
    JSObjectRef remote = ct_unix_address_from_fd(ctx, fd, true, exception);
    if (remote != NULL) ct_set_property(ctx, result, "remote", remote, exception);
    return result;
#endif
}

static JSValueRef ct_unix_socket_connect(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
#if defined(_WIN32)
    (void)argc;
    (void)argv;
    ct_throw_message(ctx, exception, "Unix domain sockets are not available on this platform");
    return JSValueMakeUndefined(ctx);
#else
    if (argc < 1) {
        ct_throw_message(ctx, exception, "unixSocketConnect(path) requires a socket path");
        return JSValueMakeUndefined(ctx);
    }
    signal(SIGPIPE, SIG_IGN);
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    if (path == NULL) return JSValueMakeUndefined(ctx);
    if (strlen(path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) {
        free(path);
        ct_throw_message(ctx, exception, "Unix socket path is too long");
        return JSValueMakeUndefined(ctx);
    }

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        free(path);
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }

    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    strncpy(address.sun_path, path, sizeof(address.sun_path) - 1);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
        char *message = ct_duplicate_string(strerror(errno));
        close(fd);
        free(path);
        ct_throw_message(ctx, exception, message != NULL ? message : "Unix socket connect failed");
        free(message);
        return JSValueMakeUndefined(ctx);
    }
    ct_set_nonblocking_fd(fd);

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "fd", JSValueMakeNumber(ctx, fd), exception);
    JSObjectRef local = ct_unix_address_from_fd(ctx, fd, false, exception);
    if (local != NULL) ct_set_property(ctx, result, "local", local, exception);
    JSObjectRef remote = ct_unix_address_from_path(ctx, path, exception);
    ct_set_property(ctx, result, "remote", remote, exception);
    free(path);
    return result;
#endif
}

static JSValueRef ct_tcp_socket_address(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "tcpSocketAddress(fd[, peer]) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    bool peer = argc >= 2 ? ct_value_to_bool(ctx, argv[1]) : false;
    JSObjectRef result = ct_tcp_address_object(ctx, fd, peer, exception);
    return result != NULL ? result : JSValueMakeUndefined(ctx);
}

static JSValueRef ct_socket_pair(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
#if defined(_WIN32)
    ct_throw_message(ctx, exception, "socketpair is unavailable on Windows");
    return JSValueMakeUndefined(ctx);
#else
    int descriptors[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, descriptors) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    ct_set_nonblocking_fd(descriptors[0]);
    ct_set_nonblocking_fd(descriptors[1]);
    JSValueRef values[2] = {
        JSValueMakeNumber(ctx, descriptors[0]),
        JSValueMakeNumber(ctx, descriptors[1]),
    };
    return ct_make_array(ctx, 2, values, exception);
#endif
}

static JSValueRef ct_tcp_socket_set_no_delay(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "tcpSocketSetNoDelay(fd[, enabled]) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    int enabled = argc >= 2 ? (ct_value_to_bool(ctx, argv[1]) ? 1 : 0) : 1;
    if (setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled)) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeBoolean(ctx, true);
}

static JSValueRef ct_tcp_socket_set_keep_alive(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "tcpSocketSetKeepAlive(fd[, enabled[, initialDelay]]) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    int enabled = argc >= 2 ? (ct_value_to_bool(ctx, argv[1]) ? 1 : 0) : 0;
    if (setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &enabled, sizeof(enabled)) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    if (enabled && argc >= 3) {
        double delay_ms = ct_value_to_number(ctx, argv[2]);
        if (delay_ms > 0) {
            int delay_seconds = (int)ceil(delay_ms / 1000.0);
            if (delay_seconds < 1) delay_seconds = 1;
#if defined(TCP_KEEPALIVE)
            if (setsockopt(fd, IPPROTO_TCP, TCP_KEEPALIVE, &delay_seconds, sizeof(delay_seconds)) != 0) {
                ct_throw_message(ctx, exception, strerror(errno));
                return JSValueMakeUndefined(ctx);
            }
#elif defined(TCP_KEEPIDLE)
            if (setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &delay_seconds, sizeof(delay_seconds)) != 0) {
                ct_throw_message(ctx, exception, strerror(errno));
                return JSValueMakeUndefined(ctx);
            }
#else
            (void)delay_seconds;
#endif
        }
    }
    return JSValueMakeBoolean(ctx, true);
}

static JSValueRef ct_tcp_socket_shutdown(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "tcpSocketShutdown(fd) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    if (shutdown(fd, SHUT_WR) != 0 && errno != ENOTCONN) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

#if CT_HAS_OPENSSL
static pthread_once_t ct_tls_init_once_control = PTHREAD_ONCE_INIT;

static void ct_tls_init_once(void) {
    SSL_library_init();
    SSL_load_error_strings();
    OpenSSL_add_ssl_algorithms();
}

static char *ct_tls_error_message(const char *fallback) {
    unsigned long code = ERR_get_error();
    if (code == 0) return ct_duplicate_string(fallback != NULL ? fallback : "TLS operation failed");
    char buffer[256];
    ERR_error_string_n(code, buffer, sizeof(buffer));
    return ct_duplicate_string(buffer);
}

static void ct_tls_connection_add(CtTlsConnection *connection) {
    pthread_mutex_lock(&ct_tls_mutex);
    connection->next = ct_tls_connections;
    ct_tls_connections = connection;
    pthread_mutex_unlock(&ct_tls_mutex);
}

static void ct_tls_connection_remove(CtTlsConnection *connection) {
    pthread_mutex_lock(&ct_tls_mutex);
    CtTlsConnection **cursor = &ct_tls_connections;
    while (*cursor != NULL) {
        if (*cursor == connection) {
            *cursor = connection->next;
            break;
        }
        cursor = &(*cursor)->next;
    }
    pthread_mutex_unlock(&ct_tls_mutex);
}

static CtTlsConnection *ct_tls_connection_find(uint32_t id) {
    CtTlsConnection *result = NULL;
    pthread_mutex_lock(&ct_tls_mutex);
    for (CtTlsConnection *connection = ct_tls_connections; connection != NULL; connection = connection->next) {
        if (connection->id == id) {
            result = connection;
            break;
        }
    }
    pthread_mutex_unlock(&ct_tls_mutex);
    return result;
}

static void ct_tls_connection_free(CtTlsConnection *connection) {
    if (connection == NULL) return;
    ct_tls_connection_remove(connection);
    if (connection->ssl != NULL) SSL_free(connection->ssl);
    if (connection->ctx != NULL) SSL_CTX_free(connection->ctx);
    if (connection->fd >= 0) close(connection->fd);
    pthread_mutex_destroy(&connection->mutex);
    free(connection);
}

static CtTlsServer *ct_tls_server_find(uint32_t id) {
    CtTlsServer *result = NULL;
    pthread_mutex_lock(&ct_tls_mutex);
    for (CtTlsServer *server = ct_tls_servers; server != NULL; server = server->next) {
        if (server->id == id) {
            result = server;
            break;
        }
    }
    pthread_mutex_unlock(&ct_tls_mutex);
    return result;
}

static void ct_tls_server_remove(CtTlsServer *server) {
    pthread_mutex_lock(&ct_tls_mutex);
    CtTlsServer **cursor = &ct_tls_servers;
    while (*cursor != NULL) {
        if (*cursor == server) {
            *cursor = server->next;
            break;
        }
        cursor = &(*cursor)->next;
    }
    pthread_mutex_unlock(&ct_tls_mutex);
}

static bool ct_tls_server_is_stopped(CtTlsServer *server) {
    bool stopped = false;
    pthread_mutex_lock(&server->mutex);
    stopped = server->stopped;
    pthread_mutex_unlock(&server->mutex);
    return stopped;
}

static void ct_tls_server_set_stopped(CtTlsServer *server, bool stopped) {
    pthread_mutex_lock(&server->mutex);
    server->stopped = stopped;
    pthread_mutex_unlock(&server->mutex);
}

static void ct_tls_server_push_accepted(CtTlsServer *server, CtTlsConnection *connection) {
    CtTlsAccepted *accepted = (CtTlsAccepted *)calloc(1, sizeof(CtTlsAccepted));
    if (accepted == NULL) {
        ct_tls_connection_free(connection);
        return;
    }
    accepted->connection = connection;
    pthread_mutex_lock(&server->mutex);
    if (server->accepted_tail != NULL) server->accepted_tail->next = accepted;
    else server->accepted_head = accepted;
    server->accepted_tail = accepted;
    pthread_mutex_unlock(&server->mutex);
}

static CtTlsConnection *ct_tls_server_pop_accepted(CtTlsServer *server) {
    pthread_mutex_lock(&server->mutex);
    CtTlsAccepted *accepted = server->accepted_head;
    if (accepted == NULL) {
        pthread_mutex_unlock(&server->mutex);
        return NULL;
    }
    server->accepted_head = accepted->next;
    if (server->accepted_head == NULL) server->accepted_tail = NULL;
    pthread_mutex_unlock(&server->mutex);
    CtTlsConnection *connection = accepted->connection;
    free(accepted);
    return connection;
}

static void ct_tls_server_free(CtTlsServer *server) {
    if (server == NULL) return;
    ct_tls_server_remove(server);
    ct_tls_server_set_stopped(server, true);
    if (server->listen_fd >= 0) close(server->listen_fd);
    if (server->thread_started) pthread_join(server->thread, NULL);
    CtTlsAccepted *accepted = server->accepted_head;
    while (accepted != NULL) {
        CtTlsAccepted *next = accepted->next;
        ct_tls_connection_free(accepted->connection);
        free(accepted);
        accepted = next;
    }
    if (server->ctx != NULL) SSL_CTX_free(server->ctx);
    free(server->hostname);
    pthread_mutex_destroy(&server->mutex);
    free(server);
}

static bool ct_tls_connection_is_active(CtTlsConnection *connection) {
    bool active = false;
    pthread_mutex_lock(&connection->mutex);
    active = connection->active;
    pthread_mutex_unlock(&connection->mutex);
    return active;
}

static void ct_tls_connection_set_active(CtTlsConnection *connection, bool active) {
    pthread_mutex_lock(&connection->mutex);
    connection->active = active;
    pthread_mutex_unlock(&connection->mutex);
}

static int ct_tls_use_cert_pem(JSContextRef ctx, SSL_CTX *ssl_ctx, const char *cert_pem, JSValueRef *exception) {
    BIO *bio = BIO_new_mem_buf(cert_pem, -1);
    if (bio == NULL) {
        ct_throw_message(ctx, exception, "Failed to allocate TLS certificate BIO");
        return -1;
    }
    X509 *cert = PEM_read_bio_X509(bio, NULL, 0, NULL);
    if (cert == NULL) {
        BIO_free(bio);
        char *message = ct_tls_error_message("Failed to parse TLS certificate");
        ct_throw_message(ctx, exception, message);
        free(message);
        return -1;
    }
    int ok = SSL_CTX_use_certificate(ssl_ctx, cert);
    X509_free(cert);
    BIO_free(bio);
    if (ok != 1) {
        char *message = ct_tls_error_message("Failed to use TLS certificate");
        ct_throw_message(ctx, exception, message);
        free(message);
        return -1;
    }
    return 0;
}

static int ct_tls_use_key_pem(JSContextRef ctx, SSL_CTX *ssl_ctx, const char *key_pem, JSValueRef *exception) {
    BIO *bio = BIO_new_mem_buf(key_pem, -1);
    if (bio == NULL) {
        ct_throw_message(ctx, exception, "Failed to allocate TLS private key BIO");
        return -1;
    }
    EVP_PKEY *key = PEM_read_bio_PrivateKey(bio, NULL, 0, NULL);
    if (key == NULL) {
        BIO_free(bio);
        char *message = ct_tls_error_message("Failed to parse TLS private key");
        ct_throw_message(ctx, exception, message);
        free(message);
        return -1;
    }
    int ok = SSL_CTX_use_PrivateKey(ssl_ctx, key);
    EVP_PKEY_free(key);
    BIO_free(bio);
    if (ok != 1) {
        char *message = ct_tls_error_message("Failed to use TLS private key");
        ct_throw_message(ctx, exception, message);
        free(message);
        return -1;
    }
    return 0;
}

static int ct_tls_load_ca_pem(SSL_CTX *ssl_ctx, const char *ca_pem) {
    if (ca_pem == NULL || ca_pem[0] == '\0') return 0;
    BIO *bio = BIO_new_mem_buf(ca_pem, -1);
    if (bio == NULL) return -1;
    int loaded = 0;
    for (;;) {
        X509 *cert = PEM_read_bio_X509(bio, NULL, 0, NULL);
        if (cert == NULL) break;
        if (X509_STORE_add_cert(SSL_CTX_get_cert_store(ssl_ctx), cert) == 1) loaded += 1;
        X509_free(cert);
    }
    BIO_free(bio);
    ERR_clear_error();
    return loaded > 0 ? 0 : -1;
}

static int ct_tls_make_socket(JSContextRef ctx, const char *host, int port, int family, JSValueRef *exception) {
    struct addrinfo *results = NULL;
    if (ct_tcp_resolve_address(ctx, host != NULL ? host : "127.0.0.1", port, family, false, &results, exception) != 0) return -1;
    int fd = -1;
    int last_errno = ECONNREFUSED;
    for (struct addrinfo *entry = results; entry != NULL; entry = entry->ai_next) {
        fd = socket(entry->ai_family, entry->ai_socktype, entry->ai_protocol);
        if (fd < 0) {
            last_errno = errno;
            continue;
        }
        if (connect(fd, entry->ai_addr, (socklen_t)entry->ai_addrlen) == 0) break;
        last_errno = errno;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(results);
    if (fd < 0) {
        ct_throw_message(ctx, exception, strerror(last_errno));
        return -1;
    }
    return fd;
}

static JSValueRef ct_tls_x509_der(JSContextRef ctx, X509 *cert, JSValueRef *exception) {
    if (cert == NULL) return JSValueMakeNull(ctx);
    int len = i2d_X509(cert, NULL);
    if (len <= 0) return JSValueMakeNull(ctx);
    unsigned char *buffer = (unsigned char *)malloc((size_t)len);
    if (buffer == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    unsigned char *cursor = buffer;
    int written = i2d_X509(cert, &cursor);
    if (written != len) {
        free(buffer);
        return JSValueMakeNull(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, buffer, (size_t)len, ct_array_buffer_free, NULL, exception);
}

static JSValueRef ct_tls_session_der(JSContextRef ctx, SSL *ssl, JSValueRef *exception) {
    if (ssl == NULL) return JSValueMakeNull(ctx);
    SSL_SESSION *session = SSL_get1_session(ssl);
    if (session == NULL) return JSValueMakeNull(ctx);
    int len = i2d_SSL_SESSION(session, NULL);
    if (len <= 0) {
        SSL_SESSION_free(session);
        return JSValueMakeNull(ctx);
    }
    unsigned char *buffer = (unsigned char *)malloc((size_t)len);
    if (buffer == NULL) {
        SSL_SESSION_free(session);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    unsigned char *cursor = buffer;
    int written = i2d_SSL_SESSION(session, &cursor);
    SSL_SESSION_free(session);
    if (written != len) {
        free(buffer);
        return JSValueMakeNull(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, buffer, (size_t)len, ct_array_buffer_free, NULL, exception);
}

static JSObjectRef ct_tls_connection_result(JSContextRef ctx, CtTlsConnection *connection, JSValueRef *exception) {
    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, connection->id), exception);
    ct_set_property(ctx, result, "fd", JSValueMakeNumber(ctx, connection->fd), exception);
    JSObjectRef local = ct_tcp_address_object(ctx, connection->fd, false, exception);
    if (local != NULL) ct_set_property(ctx, result, "local", local, exception);
    JSObjectRef remote = ct_tcp_address_object(ctx, connection->fd, true, exception);
    if (remote != NULL) ct_set_property(ctx, result, "remote", remote, exception);
    pthread_mutex_lock(&connection->mutex);
    const char *protocol = SSL_get_version(connection->ssl);
    const SSL_CIPHER *cipher = SSL_get_current_cipher(connection->ssl);
    ct_set_property(ctx, result, "protocol", protocol != NULL ? ct_make_string(ctx, protocol) : JSValueMakeNull(ctx), exception);
    ct_set_property(ctx, result, "cipher", cipher != NULL ? ct_make_string(ctx, SSL_CIPHER_get_name(cipher)) : JSValueMakeNull(ctx), exception);
    X509 *local_cert = SSL_get_certificate(connection->ssl);
    ct_set_property(ctx, result, "localCertificate", ct_tls_x509_der(ctx, local_cert, exception), exception);
    X509 *peer_cert = SSL_get_peer_certificate(connection->ssl);
    ct_set_property(ctx, result, "peerCertificate", ct_tls_x509_der(ctx, peer_cert, exception), exception);
    if (peer_cert != NULL) X509_free(peer_cert);
    ct_set_property(ctx, result, "session", ct_tls_session_der(ctx, connection->ssl, exception), exception);
    ct_set_property(ctx, result, "sessionReused", JSValueMakeBoolean(ctx, SSL_session_reused(connection->ssl) == 1), exception);
    pthread_mutex_unlock(&connection->mutex);
    return result;
}

static void *ct_tls_server_thread(void *opaque) {
    CtTlsServer *server = (CtTlsServer *)opaque;
    while (!ct_tls_server_is_stopped(server)) {
        struct pollfd poll_fd;
        poll_fd.fd = server->listen_fd;
        poll_fd.events = POLLIN | POLLERR | POLLHUP;
        poll_fd.revents = 0;
        int ready = poll(&poll_fd, 1, 50);
        if (ct_tls_server_is_stopped(server)) break;
        if (ready == 0) continue;
        if (ready < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if ((poll_fd.revents & POLLIN) == 0) continue;

        struct sockaddr_storage remote_addr;
        socklen_t remote_len = sizeof(remote_addr);
        int fd = accept(server->listen_fd, (struct sockaddr *)&remote_addr, &remote_len);
        if (fd < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) continue;
            break;
        }
        ct_set_blocking_fd(fd);

        SSL *ssl = SSL_new(server->ctx);
        if (ssl == NULL) {
            close(fd);
            continue;
        }
        SSL_set_fd(ssl, fd);
        if (SSL_accept(ssl) != 1) {
            SSL_free(ssl);
            close(fd);
            continue;
        }
        ct_set_nonblocking_fd(fd);

        CtTlsConnection *connection = (CtTlsConnection *)calloc(1, sizeof(CtTlsConnection));
        if (connection == NULL) {
            SSL_free(ssl);
            close(fd);
            continue;
        }
        pthread_mutex_init(&connection->mutex, NULL);
        connection->fd = fd;
        connection->ctx = NULL;
        connection->ssl = ssl;
        connection->runtime = server->runtime;
        connection->active = true;
        connection->server_side = true;
        pthread_mutex_lock(&ct_tls_mutex);
        connection->id = ct_next_tls_connection_id++;
        if (ct_next_tls_connection_id == 0) ct_next_tls_connection_id = 1;
        pthread_mutex_unlock(&ct_tls_mutex);
        ct_tls_connection_add(connection);
        ct_tls_server_push_accepted(server, connection);
    }
    return NULL;
}

static void *ct_tls_read_thread(void *opaque) {
    CtTlsConnection *connection = (CtTlsConnection *)opaque;
    while (ct_tls_connection_is_active(connection)) {
        struct pollfd poll_fd;
        poll_fd.fd = connection->fd;
        poll_fd.events = POLLIN | POLLHUP | POLLERR;
        poll_fd.revents = 0;
        int ready = poll(&poll_fd, 1, 50);
        if (!ct_tls_connection_is_active(connection)) break;
        if (ready == 0) continue;
        if (ready < 0) {
            if (errno == EINTR) continue;
            ct_queue_fd_simple(connection->runtime, connection->id, "error", strerror(errno));
            break;
        }
        if ((poll_fd.revents & POLLNVAL) != 0) {
            ct_queue_fd_simple(connection->runtime, connection->id, "error", "invalid TLS socket");
            break;
        }

        bool terminal = false;
        for (;;) {
            char buffer[65536];
            pthread_mutex_lock(&connection->mutex);
            int n = connection->ssl != NULL ? SSL_read(connection->ssl, buffer, sizeof(buffer)) : -1;
            int ssl_error = n <= 0 && connection->ssl != NULL ? SSL_get_error(connection->ssl, n) : SSL_ERROR_SYSCALL;
            pthread_mutex_unlock(&connection->mutex);
            if (n > 0) {
                ct_queue_fd_data(connection->runtime, connection->id, buffer, (size_t)n);
                continue;
            }
            if (ssl_error == SSL_ERROR_WANT_READ || ssl_error == SSL_ERROR_WANT_WRITE) break;
            if (ssl_error == SSL_ERROR_ZERO_RETURN) {
                ct_queue_fd_simple(connection->runtime, connection->id, "end", NULL);
                terminal = true;
                break;
            }
            if (ssl_error == SSL_ERROR_SYSCALL && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) break;
            char *message = ct_tls_error_message("TLS read failed");
            if (message != NULL && strstr(message, "unexpected eof") != NULL) {
                free(message);
                ct_queue_fd_simple(connection->runtime, connection->id, "end", NULL);
                terminal = true;
                break;
            }
            ct_queue_fd_simple(connection->runtime, connection->id, "error", message);
            free(message);
            terminal = true;
            break;
        }
        if (terminal) break;
    }
    ct_tls_connection_set_active(connection, false);
    ct_tls_connection_free(connection);
    return NULL;
}

static JSValueRef ct_tls_client_connect(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 4) {
        ct_throw_message(ctx, exception, "tlsClientConnect(port, host, servername, rejectUnauthorized[, ca]) requires port, host, servername, and rejectUnauthorized");
        return JSValueMakeUndefined(ctx);
    }
    pthread_once(&ct_tls_init_once_control, ct_tls_init_once);
    int port = (int)ct_value_to_number(ctx, argv[0]);
    char *host = ct_value_to_optional_string(ctx, argv[1]);
    char *servername = ct_value_to_optional_string(ctx, argv[2]);
    bool reject_unauthorized = ct_value_to_bool(ctx, argv[3]);
    char *ca = argc >= 5 ? ct_value_to_optional_string(ctx, argv[4]) : NULL;

    int fd = ct_tls_make_socket(ctx, host != NULL ? host : "127.0.0.1", port, AF_UNSPEC, exception);
    if (fd < 0) {
        free(host);
        free(servername);
        free(ca);
        return JSValueMakeUndefined(ctx);
    }

    SSL_CTX *ssl_ctx = SSL_CTX_new(TLS_client_method());
    SSL *ssl = ssl_ctx != NULL ? SSL_new(ssl_ctx) : NULL;
    if (ssl_ctx == NULL || ssl == NULL) {
        if (ssl != NULL) SSL_free(ssl);
        if (ssl_ctx != NULL) SSL_CTX_free(ssl_ctx);
        close(fd);
        free(host);
        free(servername);
        free(ca);
        char *message = ct_tls_error_message("Failed to initialize TLS client");
        ct_throw_message(ctx, exception, message);
        free(message);
        return JSValueMakeUndefined(ctx);
    }
    SSL_CTX_set_default_verify_paths(ssl_ctx);
    if (ca != NULL && ca[0] != '\0') ct_tls_load_ca_pem(ssl_ctx, ca);
    SSL_set_verify(ssl, reject_unauthorized ? SSL_VERIFY_PEER : SSL_VERIFY_NONE, NULL);
    if (servername != NULL && servername[0] != '\0') SSL_set_tlsext_host_name(ssl, servername);
    SSL_set_fd(ssl, fd);
    /* Bound the handshake: a peer that is not a TLS server would otherwise
     * leave SSL_connect blocked in read forever and freeze the event loop. */
    struct timeval handshake_timeout = { .tv_sec = 10, .tv_usec = 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &handshake_timeout, sizeof(handshake_timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &handshake_timeout, sizeof(handshake_timeout));
    if (SSL_connect(ssl) != 1) {
        char *message = ct_tls_error_message("TLS connect failed");
        SSL_free(ssl);
        SSL_CTX_free(ssl_ctx);
        close(fd);
        free(host);
        free(servername);
        free(ca);
        ct_throw_message(ctx, exception, message);
        free(message);
        return JSValueMakeUndefined(ctx);
    }
    if (reject_unauthorized && SSL_get_verify_result(ssl) != X509_V_OK) {
        const char *verify_error = X509_verify_cert_error_string(SSL_get_verify_result(ssl));
        SSL_free(ssl);
        SSL_CTX_free(ssl_ctx);
        close(fd);
        free(host);
        free(servername);
        free(ca);
        ct_throw_message(ctx, exception, verify_error != NULL ? verify_error : "TLS certificate verification failed");
        return JSValueMakeUndefined(ctx);
    }
    ct_set_nonblocking_fd(fd);

    CtTlsConnection *connection = (CtTlsConnection *)calloc(1, sizeof(CtTlsConnection));
    if (connection == NULL) {
        SSL_free(ssl);
        SSL_CTX_free(ssl_ctx);
        close(fd);
        free(host);
        free(servername);
        free(ca);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    pthread_mutex_init(&connection->mutex, NULL);
    connection->fd = fd;
    connection->ctx = ssl_ctx;
    connection->ssl = ssl;
    connection->runtime = JSObjectGetPrivate(function);
    connection->active = true;
    pthread_mutex_lock(&ct_tls_mutex);
    connection->id = ct_next_tls_connection_id++;
    if (ct_next_tls_connection_id == 0) ct_next_tls_connection_id = 1;
    pthread_mutex_unlock(&ct_tls_mutex);
    ct_tls_connection_add(connection);

    JSObjectRef result = ct_tls_connection_result(ctx, connection, exception);
    free(host);
    free(servername);
    free(ca);
    return result;
}

static JSValueRef ct_tls_server_listen(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 4) {
        ct_throw_message(ctx, exception, "tlsServerListen(port, host, cert, key) requires port, host, cert, and key");
        return JSValueMakeUndefined(ctx);
    }
    pthread_once(&ct_tls_init_once_control, ct_tls_init_once);
    int port = (int)ct_value_to_number(ctx, argv[0]);
    char *host = ct_value_to_optional_string(ctx, argv[1]);
    char *cert = ct_value_to_string_copy(ctx, argv[2]);
    char *key = ct_value_to_string_copy(ctx, argv[3]);

    SSL_CTX *ssl_ctx = SSL_CTX_new(TLS_server_method());
    if (ssl_ctx == NULL || cert == NULL || key == NULL || ct_tls_use_cert_pem(ctx, ssl_ctx, cert, exception) != 0 || ct_tls_use_key_pem(ctx, ssl_ctx, key, exception) != 0 || SSL_CTX_check_private_key(ssl_ctx) != 1) {
        if (exception != NULL && *exception == NULL) {
            char *message = ct_tls_error_message("Failed to initialize TLS server credentials");
            ct_throw_message(ctx, exception, message);
            free(message);
        }
        if (ssl_ctx != NULL) SSL_CTX_free(ssl_ctx);
        free(host);
        free(cert);
        free(key);
        return JSValueMakeUndefined(ctx);
    }
    free(cert);
    free(key);

    struct addrinfo *results = NULL;
    if (ct_tcp_resolve_address(ctx, host, port, AF_INET, true, &results, exception) != 0) {
        SSL_CTX_free(ssl_ctx);
        free(host);
        return JSValueMakeUndefined(ctx);
    }
    int listen_fd = -1;
    for (struct addrinfo *entry = results; entry != NULL; entry = entry->ai_next) {
        listen_fd = socket(entry->ai_family, entry->ai_socktype, entry->ai_protocol);
        if (listen_fd < 0) continue;
        int yes = 1;
        setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
        if (bind(listen_fd, entry->ai_addr, (socklen_t)entry->ai_addrlen) == 0 && listen(listen_fd, 128) == 0) {
            ct_set_nonblocking_fd(listen_fd);
            break;
        }
        close(listen_fd);
        listen_fd = -1;
    }
    freeaddrinfo(results);
    if (listen_fd < 0) {
        SSL_CTX_free(ssl_ctx);
        free(host);
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }

    CtTlsServer *server = (CtTlsServer *)calloc(1, sizeof(CtTlsServer));
    if (server == NULL) {
        SSL_CTX_free(ssl_ctx);
        close(listen_fd);
        free(host);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    server->listen_fd = listen_fd;
    server->ctx = ssl_ctx;
    server->hostname = host != NULL ? host : ct_duplicate_string("127.0.0.1");
    server->runtime = JSObjectGetPrivate(function);
    pthread_mutex_init(&server->mutex, NULL);
    pthread_mutex_lock(&ct_tls_mutex);
    server->id = ct_next_tls_server_id++;
    if (ct_next_tls_server_id == 0) ct_next_tls_server_id = 1;
    server->next = ct_tls_servers;
    ct_tls_servers = server;
    pthread_mutex_unlock(&ct_tls_mutex);
    if (pthread_create(&server->thread, NULL, ct_tls_server_thread, server) != 0) {
        ct_tls_server_free(server);
        ct_throw_message(ctx, exception, "Failed to start TLS server accept thread");
        return JSValueMakeUndefined(ctx);
    }
    server->thread_started = true;

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, server->id), exception);
    JSObjectRef address = ct_tcp_address_object(ctx, listen_fd, false, exception);
    if (address != NULL) ct_set_property(ctx, result, "address", address, exception);
    return result;
}

static JSValueRef ct_tls_server_accept(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "tlsServerAccept(id) requires a server id");
        return JSValueMakeUndefined(ctx);
    }
    CtTlsServer *server = ct_tls_server_find((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (server == NULL) return JSValueMakeNull(ctx);
    CtTlsConnection *connection = ct_tls_server_pop_accepted(server);
    if (connection == NULL) return JSValueMakeNull(ctx);
    JSObjectRef result = ct_tls_connection_result(ctx, connection, exception);
    return result;
}

static JSValueRef ct_tls_server_close(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)ctx;
    (void)function;
    (void)thisObject;
    (void)exception;
    if (argc >= 1) ct_tls_server_free(ct_tls_server_find((uint32_t)ct_value_to_number(ctx, argv[0])));
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_tls_connection_read_start(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "tlsConnectionReadStart(id) requires a connection id");
        return JSValueMakeUndefined(ctx);
    }
    CtTlsConnection *connection = ct_tls_connection_find((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (connection == NULL) return JSValueMakeBoolean(ctx, false);
    if (!connection->watcher_started) {
        connection->watcher_started = true;
        if (pthread_create(&connection->thread, NULL, ct_tls_read_thread, connection) != 0) {
            connection->watcher_started = false;
            ct_throw_message(ctx, exception, "Failed to start TLS read watcher");
            return JSValueMakeUndefined(ctx);
        }
        pthread_detach(connection->thread);
    }
    return JSValueMakeBoolean(ctx, true);
}

static JSValueRef ct_tls_connection_write(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "tlsConnectionWrite(id, data) requires connection id and data");
        return JSValueMakeBoolean(ctx, false);
    }
    CtTlsConnection *connection = ct_tls_connection_find((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (connection == NULL) return JSValueMakeBoolean(ctx, false);
    uint8_t *bytes = NULL;
    size_t len = 0;
    char *text = NULL;
    if (ct_get_bytes(ctx, argv[1], &bytes, &len) != 0) {
        text = ct_value_to_string_copy(ctx, argv[1]);
        bytes = (uint8_t *)text;
        len = text != NULL ? strlen(text) : 0;
    }
    size_t written_total = 0;
    bool ok = true;
    while (written_total < len) {
        pthread_mutex_lock(&connection->mutex);
        int written = SSL_write(connection->ssl, bytes + written_total, (int)(len - written_total));
        int ssl_error = written <= 0 ? SSL_get_error(connection->ssl, written) : SSL_ERROR_NONE;
        pthread_mutex_unlock(&connection->mutex);
        if (written > 0) {
            written_total += (size_t)written;
            continue;
        }
        if (ssl_error == SSL_ERROR_WANT_READ || ssl_error == SSL_ERROR_WANT_WRITE) {
            usleep(1000);
            continue;
        }
        ok = false;
        break;
    }
    free(text);
    return JSValueMakeBoolean(ctx, ok);
}

static JSValueRef ct_tls_connection_close(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)exception;
    if (argc < 1) return JSValueMakeUndefined(ctx);
    CtTlsConnection *connection = ct_tls_connection_find((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (connection == NULL) return JSValueMakeUndefined(ctx);
    ct_tls_connection_set_active(connection, false);
    pthread_mutex_lock(&connection->mutex);
    if (connection->ssl != NULL) SSL_shutdown(connection->ssl);
    if (connection->fd >= 0) {
        shutdown(connection->fd, SHUT_RDWR);
        close(connection->fd);
        connection->fd = -1;
    }
    pthread_mutex_unlock(&connection->mutex);
    if (!connection->watcher_started) ct_tls_connection_free(connection);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_tls_connection_shutdown(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "tlsConnectionShutdown(id) requires a connection id");
        return JSValueMakeUndefined(ctx);
    }
    CtTlsConnection *connection = ct_tls_connection_find((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (connection == NULL) return JSValueMakeUndefined(ctx);
    pthread_mutex_lock(&connection->mutex);
    if (connection->ssl != NULL) SSL_shutdown(connection->ssl);
    pthread_mutex_unlock(&connection->mutex);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_tls_connection_info(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "tlsConnectionInfo(id) requires a connection id");
        return JSValueMakeUndefined(ctx);
    }
    CtTlsConnection *connection = ct_tls_connection_find((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (connection == NULL) return JSValueMakeNull(ctx);
    return ct_tls_connection_result(ctx, connection, exception);
}
#else
static JSValueRef ct_tls_unavailable(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
    ct_throw_message(ctx, exception, "native TLS support is unavailable in this Cottontail build");
    return JSValueMakeUndefined(ctx);
}
#define ct_tls_client_connect ct_tls_unavailable
#define ct_tls_server_listen ct_tls_unavailable
#define ct_tls_server_accept ct_tls_unavailable
#define ct_tls_server_close ct_tls_unavailable
#define ct_tls_connection_read_start ct_tls_unavailable
#define ct_tls_connection_write ct_tls_unavailable
#define ct_tls_connection_close ct_tls_unavailable
#define ct_tls_connection_shutdown ct_tls_unavailable
#define ct_tls_connection_info ct_tls_unavailable
#endif

static double ct_rusage_maxrss_bytes(const struct rusage *usage) {
#if defined(__APPLE__) || defined(__MACH__)
    return (double)usage->ru_maxrss;
#else
    return (double)usage->ru_maxrss * 1024.0;
#endif
}

static double ct_current_rss_bytes(void) {
#if defined(__APPLE__) || defined(__MACH__)
    mach_task_basic_info_data_t info;
    mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t)&info, &count) == KERN_SUCCESS) {
        return (double)info.resident_size;
    }
#elif defined(__linux__)
    FILE *file = fopen("/proc/self/statm", "r");
    if (file != NULL) {
        unsigned long size_pages = 0;
        unsigned long resident_pages = 0;
        if (fscanf(file, "%lu %lu", &size_pages, &resident_pages) == 2) {
            fclose(file);
            long page_size = sysconf(_SC_PAGESIZE);
            return (double)resident_pages * (double)(page_size > 0 ? page_size : 4096);
        }
        fclose(file);
    }
#endif
    struct rusage usage;
    return getrusage(RUSAGE_SELF, &usage) == 0 ? ct_rusage_maxrss_bytes(&usage) : 0;
}

static double ct_total_memory_bytes(void) {
#if defined(__APPLE__) || defined(__MACH__)
    uint64_t value = 0;
    size_t len = sizeof(value);
    if (sysctlbyname("hw.memsize", &value, &len, NULL, 0) == 0) return (double)value;
#endif
#if defined(_SC_PHYS_PAGES) && defined(_SC_PAGESIZE)
    long pages = sysconf(_SC_PHYS_PAGES);
    long page_size = sysconf(_SC_PAGESIZE);
    if (pages > 0 && page_size > 0) return (double)pages * (double)page_size;
#endif
    return 0;
}

static double ct_available_memory_bytes(void) {
#if defined(__linux__) && defined(_SC_AVPHYS_PAGES) && defined(_SC_PAGESIZE)
    long pages = sysconf(_SC_AVPHYS_PAGES);
    long page_size = sysconf(_SC_PAGESIZE);
    if (pages > 0 && page_size > 0) return (double)pages * (double)page_size;
#elif defined(__APPLE__) || defined(__MACH__)
    vm_statistics64_data_t stats;
    mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
    if (host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&stats, &count) == KERN_SUCCESS) {
        vm_size_t page_size = 0;
        host_page_size(mach_host_self(), &page_size);
        uint64_t pages = (uint64_t)stats.free_count + (uint64_t)stats.inactive_count;
        return (double)pages * (double)(page_size > 0 ? page_size : 4096);
    }
#endif
    return ct_total_memory_bytes();
}

static JSObjectRef ct_rusage_object(JSContextRef ctx, const struct rusage *usage, JSValueRef *exception) {
    JSObjectRef result = ct_make_object(ctx);
    double user_us = (double)usage->ru_utime.tv_sec * 1000000.0 + (double)usage->ru_utime.tv_usec;
    double system_us = (double)usage->ru_stime.tv_sec * 1000000.0 + (double)usage->ru_stime.tv_usec;
    ct_set_property(ctx, result, "userCPUTime", JSValueMakeNumber(ctx, user_us), exception);
    ct_set_property(ctx, result, "systemCPUTime", JSValueMakeNumber(ctx, system_us), exception);
    ct_set_property(ctx, result, "maxRSS", JSValueMakeNumber(ctx, ct_rusage_maxrss_bytes(usage)), exception);
    ct_set_property(ctx, result, "sharedMemorySize", JSValueMakeNumber(ctx, (double)usage->ru_ixrss), exception);
    ct_set_property(ctx, result, "unsharedDataSize", JSValueMakeNumber(ctx, (double)usage->ru_idrss), exception);
    ct_set_property(ctx, result, "unsharedStackSize", JSValueMakeNumber(ctx, (double)usage->ru_isrss), exception);
    ct_set_property(ctx, result, "minorPageFault", JSValueMakeNumber(ctx, (double)usage->ru_minflt), exception);
    ct_set_property(ctx, result, "majorPageFault", JSValueMakeNumber(ctx, (double)usage->ru_majflt), exception);
    ct_set_property(ctx, result, "swappedOut", JSValueMakeNumber(ctx, (double)usage->ru_nswap), exception);
    ct_set_property(ctx, result, "fsRead", JSValueMakeNumber(ctx, (double)usage->ru_inblock), exception);
    ct_set_property(ctx, result, "fsWrite", JSValueMakeNumber(ctx, (double)usage->ru_oublock), exception);
    ct_set_property(ctx, result, "ipcSent", JSValueMakeNumber(ctx, (double)usage->ru_msgsnd), exception);
    ct_set_property(ctx, result, "ipcReceived", JSValueMakeNumber(ctx, (double)usage->ru_msgrcv), exception);
    ct_set_property(ctx, result, "signalsCount", JSValueMakeNumber(ctx, (double)usage->ru_nsignals), exception);
    ct_set_property(ctx, result, "voluntaryContextSwitches", JSValueMakeNumber(ctx, (double)usage->ru_nvcsw), exception);
    ct_set_property(ctx, result, "involuntaryContextSwitches", JSValueMakeNumber(ctx, (double)usage->ru_nivcsw), exception);
    return result;
}

#if !defined(_WIN32)
static int ct_process_setgroups(JSContextRef ctx, JSValueRef value, JSValueRef *exception) {
    if (!JSValueIsObject(ctx, value)) return -1;
    JSObjectRef array = (JSObjectRef)value;
    JSStringRef length_name = ct_js_string("length");
    JSValueRef length_value = JSObjectGetProperty(ctx, array, length_name, exception);
    JSStringRelease(length_name);
    if (exception != NULL && *exception != NULL) return -1;
    size_t length = (size_t)ct_value_to_number(ctx, length_value);
    gid_t *groups = (gid_t *)malloc(sizeof(gid_t) * (length > 0 ? length : 1));
    if (groups == NULL) return -1;
    for (size_t index = 0; index < length; index += 1) {
        JSValueRef item = JSObjectGetPropertyAtIndex(ctx, array, (unsigned)index, exception);
        if (exception != NULL && *exception != NULL) {
            free(groups);
            return -1;
        }
        groups[index] = (gid_t)ct_value_to_number(ctx, item);
    }
    int status = setgroups((int)length, groups);
    free(groups);
    return status;
}
#endif

static JSValueRef ct_process_info(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "processInfo(kind, ...) requires a kind");
        return JSValueMakeUndefined(ctx);
    }
    char *kind = ct_value_to_string_copy(ctx, argv[0]);
    if (kind == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    if (strcmp(kind, "chdir") == 0) {
        char *path = argc >= 2 ? ct_value_to_string_copy(ctx, argv[1]) : NULL;
        if (path == NULL || chdir(path) != 0) ct_throw_message(ctx, exception, strerror(errno));
        free(path);
        free(kind);
        return JSValueMakeUndefined(ctx);
    }
    if (strcmp(kind, "ppid") == 0) {
        free(kind);
        return JSValueMakeNumber(ctx, (double)getppid());
    }
#if !defined(_WIN32)
    if (strcmp(kind, "getuid") == 0) {
        free(kind);
        return JSValueMakeNumber(ctx, (double)getuid());
    }
    if (strcmp(kind, "geteuid") == 0) {
        free(kind);
        return JSValueMakeNumber(ctx, (double)geteuid());
    }
    if (strcmp(kind, "getgid") == 0) {
        free(kind);
        return JSValueMakeNumber(ctx, (double)getgid());
    }
    if (strcmp(kind, "getegid") == 0) {
        free(kind);
        return JSValueMakeNumber(ctx, (double)getegid());
    }
    if (strcmp(kind, "setuid") == 0) {
        int status = argc >= 2 ? setuid((uid_t)ct_value_to_number(ctx, argv[1])) : -1;
        if (status != 0) ct_throw_message(ctx, exception, strerror(errno));
        free(kind);
        return JSValueMakeUndefined(ctx);
    }
    if (strcmp(kind, "seteuid") == 0) {
        int status = argc >= 2 ? seteuid((uid_t)ct_value_to_number(ctx, argv[1])) : -1;
        if (status != 0) ct_throw_message(ctx, exception, strerror(errno));
        free(kind);
        return JSValueMakeUndefined(ctx);
    }
    if (strcmp(kind, "setgid") == 0) {
        int status = argc >= 2 ? setgid((gid_t)ct_value_to_number(ctx, argv[1])) : -1;
        if (status != 0) ct_throw_message(ctx, exception, strerror(errno));
        free(kind);
        return JSValueMakeUndefined(ctx);
    }
    if (strcmp(kind, "setegid") == 0) {
        int status = argc >= 2 ? setegid((gid_t)ct_value_to_number(ctx, argv[1])) : -1;
        if (status != 0) ct_throw_message(ctx, exception, strerror(errno));
        free(kind);
        return JSValueMakeUndefined(ctx);
    }
    if (strcmp(kind, "getgroups") == 0) {
        int count = getgroups(0, NULL);
        if (count < 0) {
            ct_throw_message(ctx, exception, strerror(errno));
            free(kind);
            return JSValueMakeUndefined(ctx);
        }
        gid_t *groups = (gid_t *)malloc(sizeof(gid_t) * (count > 0 ? count : 1));
        if (groups == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            free(kind);
            return JSValueMakeUndefined(ctx);
        }
        int actual = getgroups(count, groups);
        JSObjectRef result = ct_make_array(ctx, 0, NULL, exception);
        for (int index = 0; index < actual; index += 1) {
            JSObjectSetPropertyAtIndex(ctx, result, (unsigned)index, JSValueMakeNumber(ctx, (double)groups[index]), exception);
        }
        free(groups);
        free(kind);
        return result;
    }
    if (strcmp(kind, "setgroups") == 0) {
        int status = argc >= 2 ? ct_process_setgroups(ctx, argv[1], exception) : -1;
        if (status != 0 && (exception == NULL || *exception == NULL)) ct_throw_message(ctx, exception, strerror(errno));
        free(kind);
        return JSValueMakeUndefined(ctx);
    }
    if (strcmp(kind, "initgroups") == 0) {
        char *user = argc >= 2 ? ct_value_to_string_copy(ctx, argv[1]) : NULL;
        gid_t gid = argc >= 3 ? (gid_t)ct_value_to_number(ctx, argv[2]) : 0;
        int status = user != NULL ? initgroups(user, gid) : -1;
        if (status != 0) ct_throw_message(ctx, exception, strerror(errno));
        free(user);
        free(kind);
        return JSValueMakeUndefined(ctx);
    }
#endif
    if (strcmp(kind, "umask") == 0) {
        if (argc >= 2 && !JSValueIsUndefined(ctx, argv[1]) && !JSValueIsNull(ctx, argv[1])) {
            mode_t old = umask((mode_t)ct_value_to_number(ctx, argv[1]));
            free(kind);
            return JSValueMakeNumber(ctx, (double)old);
        }
        mode_t old = umask(0);
        umask(old);
        free(kind);
        return JSValueMakeNumber(ctx, (double)old);
    }
    if (strcmp(kind, "memoryUsage") == 0) {
        JSObjectRef result = ct_make_object(ctx);
        double rss = ct_current_rss_bytes();
        ct_set_property(ctx, result, "rss", JSValueMakeNumber(ctx, rss), exception);
        ct_set_property(ctx, result, "heapTotal", JSValueMakeNumber(ctx, 0), exception);
        ct_set_property(ctx, result, "heapUsed", JSValueMakeNumber(ctx, 0), exception);
        ct_set_property(ctx, result, "external", JSValueMakeNumber(ctx, 0), exception);
        ct_set_property(ctx, result, "arrayBuffers", JSValueMakeNumber(ctx, 0), exception);
        free(kind);
        return result;
    }
    if (strcmp(kind, "resourceUsage") == 0 || strcmp(kind, "threadResourceUsage") == 0) {
        struct rusage usage;
#if defined(RUSAGE_THREAD)
        int who = strcmp(kind, "threadResourceUsage") == 0 ? RUSAGE_THREAD : RUSAGE_SELF;
#else
        int who = RUSAGE_SELF;
#endif
        if (getrusage(who, &usage) != 0) {
            ct_throw_message(ctx, exception, strerror(errno));
            free(kind);
            return JSValueMakeUndefined(ctx);
        }
        JSObjectRef result = ct_rusage_object(ctx, &usage, exception);
        free(kind);
        return result;
    }
    if (strcmp(kind, "availableMemory") == 0) {
        free(kind);
        return JSValueMakeNumber(ctx, ct_available_memory_bytes());
    }
    if (strcmp(kind, "constrainedMemory") == 0) {
        free(kind);
        return JSValueMakeNumber(ctx, ct_total_memory_bytes());
    }

    free(kind);
    ct_throw_message(ctx, exception, "Unknown processInfo kind");
    return JSValueMakeUndefined(ctx);
}

static int ct_prefix_bits_from_sockaddr(const struct sockaddr *address) {
    if (address == NULL) return -1;
    const unsigned char *bytes = NULL;
    size_t len = 0;
    if (address->sa_family == AF_INET) {
        bytes = (const unsigned char *)&((const struct sockaddr_in *)address)->sin_addr;
        len = 4;
    } else if (address->sa_family == AF_INET6) {
        bytes = (const unsigned char *)&((const struct sockaddr_in6 *)address)->sin6_addr;
        len = 16;
    } else {
        return -1;
    }

    int bits = 0;
    bool saw_zero = false;
    for (size_t index = 0; index < len; index += 1) {
        unsigned char byte = bytes[index];
        for (int bit = 7; bit >= 0; bit -= 1) {
            bool set = ((byte >> bit) & 1u) != 0;
            if (set && saw_zero) return bits;
            if (set) bits += 1;
            else saw_zero = true;
        }
    }
    return bits;
}

static bool ct_sockaddr_to_ip(const struct sockaddr *address, char *buffer, size_t buffer_len, unsigned *scope_id) {
    if (address == NULL || buffer == NULL) return false;
    if (scope_id != NULL) *scope_id = 0;
    if (address->sa_family == AF_INET) {
        const struct sockaddr_in *addr4 = (const struct sockaddr_in *)address;
        return inet_ntop(AF_INET, &addr4->sin_addr, buffer, (socklen_t)buffer_len) != NULL;
    }
    if (address->sa_family == AF_INET6) {
        const struct sockaddr_in6 *addr6 = (const struct sockaddr_in6 *)address;
        if (scope_id != NULL) *scope_id = addr6->sin6_scope_id;
        return inet_ntop(AF_INET6, &addr6->sin6_addr, buffer, (socklen_t)buffer_len) != NULL;
    }
    return false;
}

#if !defined(_WIN32)
static void ct_mac_for_interface(struct ifaddrs *interfaces, const char *name, char out[18]) {
    snprintf(out, 18, "00:00:00:00:00:00");
    if (interfaces == NULL || name == NULL) return;
    for (struct ifaddrs *entry = interfaces; entry != NULL; entry = entry->ifa_next) {
        if (entry->ifa_name == NULL || strcmp(entry->ifa_name, name) != 0 || entry->ifa_addr == NULL) continue;
        const unsigned char *mac = NULL;
        size_t len = 0;
#if defined(__APPLE__) || defined(__MACH__)
        if (entry->ifa_addr->sa_family == AF_LINK) {
            const struct sockaddr_dl *link = (const struct sockaddr_dl *)entry->ifa_addr;
            if (link->sdl_alen > 0) {
                mac = (const unsigned char *)LLADDR(link);
                len = (size_t)link->sdl_alen;
            }
        }
#elif defined(__linux__)
        if (entry->ifa_addr->sa_family == AF_PACKET) {
            const struct sockaddr_ll *link = (const struct sockaddr_ll *)entry->ifa_addr;
            if (link->sll_halen > 0) {
                mac = (const unsigned char *)link->sll_addr;
                len = (size_t)link->sll_halen;
            }
        }
#endif
        if (mac != NULL && len >= 6) {
            snprintf(out, 18, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
            return;
        }
    }
}

static JSValueRef ct_os_network_interfaces(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;

    struct ifaddrs *interfaces = NULL;
    if (getifaddrs(&interfaces) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef result = ct_make_array(ctx, 0, NULL, exception);
    unsigned index = 0;
    for (struct ifaddrs *entry = interfaces; entry != NULL; entry = entry->ifa_next) {
        if (entry->ifa_name == NULL || entry->ifa_addr == NULL) continue;
        int family = entry->ifa_addr->sa_family;
        if (family != AF_INET && family != AF_INET6) continue;

        char address[INET6_ADDRSTRLEN];
        char netmask[INET6_ADDRSTRLEN];
        unsigned scope_id = 0;
        if (!ct_sockaddr_to_ip(entry->ifa_addr, address, sizeof(address), &scope_id)) continue;
        bool has_netmask = ct_sockaddr_to_ip(entry->ifa_netmask, netmask, sizeof(netmask), NULL);
        int prefix = ct_prefix_bits_from_sockaddr(entry->ifa_netmask);
        char mac[18];
        ct_mac_for_interface(interfaces, entry->ifa_name, mac);

        JSObjectRef item = ct_make_object(ctx);
        ct_set_property(ctx, item, "name", ct_make_string(ctx, entry->ifa_name), exception);
        ct_set_property(ctx, item, "address", ct_make_string(ctx, address), exception);
        ct_set_property(ctx, item, "netmask", ct_make_string(ctx, has_netmask ? netmask : ""), exception);
        ct_set_property(ctx, item, "family", ct_make_string(ctx, family == AF_INET6 ? "IPv6" : "IPv4"), exception);
        ct_set_property(ctx, item, "mac", ct_make_string(ctx, mac), exception);
        ct_set_property(ctx, item, "internal", JSValueMakeBoolean(ctx, (entry->ifa_flags & IFF_LOOPBACK) != 0), exception);
        if (prefix >= 0) {
            char cidr[INET6_ADDRSTRLEN + 8];
            snprintf(cidr, sizeof(cidr), "%s/%d", address, prefix);
            ct_set_property(ctx, item, "cidr", ct_make_string(ctx, cidr), exception);
        } else {
            ct_set_property(ctx, item, "cidr", JSValueMakeNull(ctx), exception);
        }
        if (family == AF_INET6) {
            ct_set_property(ctx, item, "scopeid", JSValueMakeNumber(ctx, (double)scope_id), exception);
        }
        JSObjectSetPropertyAtIndex(ctx, result, index++, item, exception);
    }

    freeifaddrs(interfaces);
    return result;
}
#else
static void ct_windows_adapter_name(const WCHAR *wide_name, char *name, size_t name_len) {
    if (wide_name == NULL || name_len == 0) {
        if (name_len > 0) name[0] = '\0';
        return;
    }
    int length = WideCharToMultiByte(CP_UTF8, 0, wide_name, -1, name, (int)name_len, NULL, NULL);
    if (length <= 0) name[0] = '\0';
}

static void ct_windows_netmask(ADDRESS_FAMILY family, unsigned prefix, char *out, size_t out_len) {
    if (family == AF_INET) {
        struct in_addr mask;
        mask.s_addr = htonl(prefix == 0 ? 0u : 0xffffffffu << (32 - (prefix > 32 ? 32 : prefix)));
        if (inet_ntop(AF_INET, &mask, out, (socklen_t)out_len) == NULL) out[0] = '\0';
        return;
    }
    struct in6_addr mask;
    memset(&mask, 0, sizeof(mask));
    if (prefix > 128) prefix = 128;
    for (unsigned index = 0; index < 16; index += 1) {
        unsigned remaining = prefix > index * 8 ? prefix - index * 8 : 0;
        mask.s6_addr[index] = remaining >= 8 ? 0xff : remaining == 0 ? 0 : (unsigned char)(0xff << (8 - remaining));
    }
    if (inet_ntop(AF_INET6, &mask, out, (socklen_t)out_len) == NULL) out[0] = '\0';
}

static JSValueRef ct_os_network_interfaces(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
    ULONG size = 16 * 1024;
    IP_ADAPTER_ADDRESSES *adapters = NULL;
    ULONG status = ERROR_BUFFER_OVERFLOW;
    for (int attempt = 0; attempt < 3 && status == ERROR_BUFFER_OVERFLOW; attempt += 1) {
        free(adapters);
        adapters = (IP_ADAPTER_ADDRESSES *)malloc(size);
        if (adapters == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        status = GetAdaptersAddresses(AF_UNSPEC, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER, NULL, adapters, &size);
    }
    if (status != NO_ERROR) {
        free(adapters);
        ct_throw_message(ctx, exception, "GetAdaptersAddresses failed");
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef result = ct_make_array(ctx, 0, NULL, exception);
    unsigned index = 0;
    for (IP_ADAPTER_ADDRESSES *adapter = adapters; adapter != NULL; adapter = adapter->Next) {
        char name[512];
        ct_windows_adapter_name(adapter->FriendlyName, name, sizeof(name));
        char mac[18] = "00:00:00:00:00:00";
        if (adapter->PhysicalAddressLength >= 6) {
            const unsigned char *bytes = adapter->PhysicalAddress;
            snprintf(mac, sizeof(mac), "%02x:%02x:%02x:%02x:%02x:%02x", bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
        }
        for (IP_ADAPTER_UNICAST_ADDRESS *unicast = adapter->FirstUnicastAddress; unicast != NULL; unicast = unicast->Next) {
            const struct sockaddr *socket_address = unicast->Address.lpSockaddr;
            int family = socket_address != NULL ? socket_address->sa_family : AF_UNSPEC;
            if (family != AF_INET && family != AF_INET6) continue;
            char address[INET6_ADDRSTRLEN];
            char netmask[INET6_ADDRSTRLEN];
            unsigned scope_id = 0;
            if (!ct_sockaddr_to_ip(socket_address, address, sizeof(address), &scope_id)) continue;
            ct_windows_netmask((ADDRESS_FAMILY)family, unicast->OnLinkPrefixLength, netmask, sizeof(netmask));

            JSObjectRef item = ct_make_object(ctx);
            ct_set_property(ctx, item, "name", ct_make_string(ctx, name), exception);
            ct_set_property(ctx, item, "address", ct_make_string(ctx, address), exception);
            ct_set_property(ctx, item, "netmask", ct_make_string(ctx, netmask), exception);
            ct_set_property(ctx, item, "family", ct_make_string(ctx, family == AF_INET6 ? "IPv6" : "IPv4"), exception);
            ct_set_property(ctx, item, "mac", ct_make_string(ctx, mac), exception);
            ct_set_property(ctx, item, "internal", JSValueMakeBoolean(ctx, adapter->IfType == IF_TYPE_SOFTWARE_LOOPBACK), exception);
            char cidr[INET6_ADDRSTRLEN + 8];
            snprintf(cidr, sizeof(cidr), "%s/%u", address, (unsigned)unicast->OnLinkPrefixLength);
            ct_set_property(ctx, item, "cidr", ct_make_string(ctx, cidr), exception);
            if (family == AF_INET6) ct_set_property(ctx, item, "scopeid", JSValueMakeNumber(ctx, (double)scope_id), exception);
            JSObjectSetPropertyAtIndex(ctx, result, index++, item, exception);
        }
    }
    free(adapters);
    return result;
}
#endif

static JSValueRef ct_os_get_priority(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
#if defined(_WIN32)
    DWORD pid = argc >= 1 ? (DWORD)ct_value_to_number(ctx, argv[0]) : 0;
    HANDLE process = pid == 0 ? GetCurrentProcess() : OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (process == NULL) {
        ct_throw_message(ctx, exception, "Unable to open process");
        return JSValueMakeUndefined(ctx);
    }
    DWORD priority_class = GetPriorityClass(process);
    if (pid != 0) CloseHandle(process);
    if (priority_class == 0) {
        ct_throw_message(ctx, exception, "GetPriorityClass failed");
        return JSValueMakeUndefined(ctx);
    }
    int priority = priority_class == REALTIME_PRIORITY_CLASS ? -20
        : priority_class == HIGH_PRIORITY_CLASS ? -14
        : priority_class == ABOVE_NORMAL_PRIORITY_CLASS ? -7
        : priority_class == BELOW_NORMAL_PRIORITY_CLASS ? 7
        : priority_class == IDLE_PRIORITY_CLASS ? 19
        : 0;
#else
    id_t pid = argc >= 1 ? (id_t)ct_value_to_number(ctx, argv[0]) : 0;
    errno = 0;
    int priority = getpriority(PRIO_PROCESS, pid);
    if (priority == -1 && errno != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
#endif
    return JSValueMakeNumber(ctx, (double)priority);
}

static JSValueRef ct_os_set_priority(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "osSetPriority(pid, priority) requires pid and priority");
        return JSValueMakeUndefined(ctx);
    }
    int pid = (int)ct_value_to_number(ctx, argv[0]);
    int priority = (int)ct_value_to_number(ctx, argv[1]);
#if defined(_WIN32)
    DWORD priority_class = priority <= -20 ? REALTIME_PRIORITY_CLASS
        : priority <= -14 ? HIGH_PRIORITY_CLASS
        : priority <= -7 ? ABOVE_NORMAL_PRIORITY_CLASS
        : priority >= 19 ? IDLE_PRIORITY_CLASS
        : priority >= 7 ? BELOW_NORMAL_PRIORITY_CLASS
        : NORMAL_PRIORITY_CLASS;
    HANDLE process = pid == 0 ? GetCurrentProcess() : OpenProcess(PROCESS_SET_INFORMATION, FALSE, (DWORD)pid);
    if (process == NULL || !SetPriorityClass(process, priority_class)) {
        if (process != NULL && pid != 0) CloseHandle(process);
        ct_throw_message(ctx, exception, "SetPriorityClass failed");
        return JSValueMakeUndefined(ctx);
    }
    if (pid != 0) CloseHandle(process);
#else
    if (setpriority(PRIO_PROCESS, pid, priority) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
#endif
    return JSValueMakeUndefined(ctx);
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
        case CT_FFI_TYPE_NAPI_ENV:
        case CT_FFI_TYPE_NAPI_VALUE:
            return &ffi_type_pointer;
    }

    return &ffi_type_pointer;
}

static bool ct_ffi_type_from_name(const char *name, CtFfiType *out) {
    if (strcmp(name, "void") == 0) *out = CT_FFI_TYPE_VOID;
    else if (strcmp(name, "bool") == 0) *out = CT_FFI_TYPE_BOOL;
    else if (strcmp(name, "u8") == 0 || strcmp(name, "uint8_t") == 0) *out = CT_FFI_TYPE_U8;
    else if (strcmp(name, "i8") == 0 || strcmp(name, "int8_t") == 0) *out = CT_FFI_TYPE_I8;
    else if (strcmp(name, "u16") == 0 || strcmp(name, "uint16_t") == 0) *out = CT_FFI_TYPE_U16;
    else if (strcmp(name, "i16") == 0 || strcmp(name, "int16_t") == 0) *out = CT_FFI_TYPE_I16;
    else if (strcmp(name, "int") == 0) *out = CT_FFI_TYPE_I32;
    else if (strcmp(name, "u32") == 0 || strcmp(name, "uint32_t") == 0) *out = CT_FFI_TYPE_U32;
    else if (strcmp(name, "i32") == 0 || strcmp(name, "int32_t") == 0) *out = CT_FFI_TYPE_I32;
    else if (strcmp(name, "u64") == 0 || strcmp(name, "uint64_t") == 0 || strcmp(name, "usize") == 0 || strcmp(name, "size_t") == 0) *out = CT_FFI_TYPE_U64;
    else if (strcmp(name, "i64") == 0 || strcmp(name, "int64_t") == 0 || strcmp(name, "isize") == 0 || strcmp(name, "ssize_t") == 0) *out = CT_FFI_TYPE_I64;
    else if (strcmp(name, "f32") == 0) *out = CT_FFI_TYPE_F32;
    else if (strcmp(name, "f64") == 0) *out = CT_FFI_TYPE_F64;
    else if (strcmp(name, "ptr") == 0 || strcmp(name, "pointer") == 0) *out = CT_FFI_TYPE_PTR;
    else if (strcmp(name, "cstring") == 0) *out = CT_FFI_TYPE_CSTRING;
    else if (strcmp(name, "function") == 0 || strcmp(name, "callback") == 0) *out = CT_FFI_TYPE_FUNCTION;
    else if (strcmp(name, "napi_env") == 0) *out = CT_FFI_TYPE_NAPI_ENV;
    else if (strcmp(name, "napi_value") == 0) *out = CT_FFI_TYPE_NAPI_VALUE;
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
        if (!isfinite(number) || number < 0) return -1;
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
        case CT_FFI_TYPE_NAPI_ENV:
        case CT_FFI_TYPE_NAPI_VALUE:
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
        case CT_FFI_TYPE_NAPI_ENV:
        case CT_FFI_TYPE_NAPI_VALUE:
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
        case CT_FFI_TYPE_NAPI_ENV:
            return JSValueMakeNumber(ctx, (double)(uintptr_t)value.ptr);
        case CT_FFI_TYPE_NAPI_VALUE:
            return value.ptr != NULL ? (JSValueRef)value.ptr : JSValueMakeNull(ctx);
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
        case CT_FFI_TYPE_NAPI_ENV:
        case CT_FFI_TYPE_NAPI_VALUE:
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
            case CT_FFI_TYPE_NAPI_ENV:
            case CT_FFI_TYPE_NAPI_VALUE:
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

static CtSharedBuffer *ct_shared_buffer_find_by_id_locked(uint32_t id) {
    for (CtSharedBuffer *buffer = ct_shared_buffers; buffer != NULL; buffer = buffer->next) {
        if (buffer->id == id) return buffer;
    }
    return NULL;
}

static CtSharedBuffer *ct_shared_buffer_find_by_ptr_locked(const void *ptr) {
    for (CtSharedBuffer *buffer = ct_shared_buffers; buffer != NULL; buffer = buffer->next) {
        if (buffer->bytes == ptr) return buffer;
    }
    return NULL;
}

static void ct_shared_buffer_unref_locked(CtSharedBuffer *buffer) {
    if (buffer == NULL || buffer->refs == 0) return;
    buffer->refs -= 1;
    if (buffer->refs > 0) return;
    CtSharedBuffer **cursor = &ct_shared_buffers;
    while (*cursor != NULL && *cursor != buffer) cursor = &(*cursor)->next;
    if (*cursor == buffer) *cursor = buffer->next;
    free(buffer->bytes);
    free(buffer);
}

static void ct_shared_array_buffer_deallocator(void *bytes, void *deallocator_context) {
    (void)bytes;
    CtSharedBuffer *buffer = (CtSharedBuffer *)deallocator_context;
    pthread_mutex_lock(&ct_shared_buffers_mutex);
    ct_shared_buffer_unref_locked(buffer);
    pthread_mutex_unlock(&ct_shared_buffers_mutex);
}

static JSObjectRef ct_shared_buffer_make_array_buffer(JSContextRef ctx, CtSharedBuffer *buffer, JSValueRef *exception) {
    pthread_mutex_lock(&ct_shared_buffers_mutex);
    buffer->refs += 1;
    pthread_mutex_unlock(&ct_shared_buffers_mutex);
    JSObjectRef object = JSObjectMakeArrayBufferWithBytesNoCopy(
        ctx,
        buffer->byte_len > 0 ? buffer->bytes : NULL,
        buffer->byte_len,
        ct_shared_array_buffer_deallocator,
        buffer,
        exception
    );
    if (object == NULL) {
        pthread_mutex_lock(&ct_shared_buffers_mutex);
        ct_shared_buffer_unref_locked(buffer);
        pthread_mutex_unlock(&ct_shared_buffers_mutex);
    }
    return object;
}

static JSValueRef ct_shared_array_buffer_create(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    size_t byte_len = argc >= 1 ? (size_t)ct_value_to_number(ctx, argv[0]) : 0;
    CtSharedBuffer *buffer = (CtSharedBuffer *)calloc(1, sizeof(CtSharedBuffer));
    if (buffer == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    buffer->bytes = byte_len > 0 ? (uint8_t *)calloc(1, byte_len) : NULL;
    if (byte_len > 0 && buffer->bytes == NULL) {
        free(buffer);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    buffer->byte_len = byte_len;
    pthread_mutex_lock(&ct_shared_buffers_mutex);
    buffer->id = ct_next_shared_buffer_id++;
    if (buffer->id == 0) buffer->id = ct_next_shared_buffer_id++;
    buffer->next = ct_shared_buffers;
    ct_shared_buffers = buffer;
    pthread_mutex_unlock(&ct_shared_buffers_mutex);
    return ct_shared_buffer_make_array_buffer(ctx, buffer, exception);
}

static JSValueRef ct_shared_array_buffer_wrap(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sharedArrayBufferWrap(id) requires an id");
        return JSValueMakeUndefined(ctx);
    }
    uint32_t id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    pthread_mutex_lock(&ct_shared_buffers_mutex);
    CtSharedBuffer *buffer = ct_shared_buffer_find_by_id_locked(id);
    pthread_mutex_unlock(&ct_shared_buffers_mutex);
    if (buffer == NULL) {
        ct_throw_message(ctx, exception, "SharedArrayBuffer backing store was not found");
        return JSValueMakeUndefined(ctx);
    }
    return ct_shared_buffer_make_array_buffer(ctx, buffer, exception);
}

static JSValueRef ct_shared_array_buffer_info(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1 || !JSValueIsObject(ctx, argv[0])) return JSValueMakeNull(ctx);
    JSObjectRef object = (JSObjectRef)argv[0];
    JSValueRef local_exception = NULL;
    JSTypedArrayType type = JSValueGetTypedArrayType(ctx, argv[0], &local_exception);
    if (local_exception != NULL) return JSValueMakeNull(ctx);
    JSObjectRef buffer_object = object;
    if (type != kJSTypedArrayTypeArrayBuffer) {
        if (type == kJSTypedArrayTypeNone) return JSValueMakeNull(ctx);
        buffer_object = JSObjectGetTypedArrayBuffer(ctx, object, &local_exception);
        if (local_exception != NULL || buffer_object == NULL) return JSValueMakeNull(ctx);
    }
    void *ptr = JSObjectGetArrayBufferBytesPtr(ctx, buffer_object, &local_exception);
    if (local_exception != NULL) return JSValueMakeNull(ctx);
    pthread_mutex_lock(&ct_shared_buffers_mutex);
    CtSharedBuffer *buffer = ct_shared_buffer_find_by_ptr_locked(ptr);
    pthread_mutex_unlock(&ct_shared_buffers_mutex);
    if (buffer == NULL) return JSValueMakeNull(ctx);
    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, buffer->id), exception);
    ct_set_property(ctx, result, "byteLength", JSValueMakeNumber(ctx, (double)buffer->byte_len), exception);
    return result;
}

static size_t ct_atomic_element_size(JSTypedArrayType type) {
    switch (type) {
        case kJSTypedArrayTypeInt8Array:
        case kJSTypedArrayTypeUint8Array:
            return 1;
        case kJSTypedArrayTypeInt16Array:
        case kJSTypedArrayTypeUint16Array:
            return 2;
        case kJSTypedArrayTypeInt32Array:
        case kJSTypedArrayTypeUint32Array:
            return 4;
        case kJSTypedArrayTypeBigInt64Array:
        case kJSTypedArrayTypeBigUint64Array:
            return 8;
        default:
            return 0;
    }
}

static int64_t ct_atomic_read_value(void *ptr, JSTypedArrayType type) {
    switch (type) {
        case kJSTypedArrayTypeInt8Array: return *(int8_t *)ptr;
        case kJSTypedArrayTypeUint8Array: return *(uint8_t *)ptr;
        case kJSTypedArrayTypeInt16Array: return *(int16_t *)ptr;
        case kJSTypedArrayTypeUint16Array: return *(uint16_t *)ptr;
        case kJSTypedArrayTypeInt32Array: return *(int32_t *)ptr;
        case kJSTypedArrayTypeUint32Array: return *(uint32_t *)ptr;
        case kJSTypedArrayTypeBigInt64Array: return *(int64_t *)ptr;
        case kJSTypedArrayTypeBigUint64Array: return (int64_t)*(uint64_t *)ptr;
        default: return 0;
    }
}

static void ct_atomic_write_value(void *ptr, JSTypedArrayType type, int64_t value) {
    switch (type) {
        case kJSTypedArrayTypeInt8Array: *(int8_t *)ptr = (int8_t)value; break;
        case kJSTypedArrayTypeUint8Array: *(uint8_t *)ptr = (uint8_t)value; break;
        case kJSTypedArrayTypeInt16Array: *(int16_t *)ptr = (int16_t)value; break;
        case kJSTypedArrayTypeUint16Array: *(uint16_t *)ptr = (uint16_t)value; break;
        case kJSTypedArrayTypeInt32Array: *(int32_t *)ptr = (int32_t)value; break;
        case kJSTypedArrayTypeUint32Array: *(uint32_t *)ptr = (uint32_t)value; break;
        case kJSTypedArrayTypeBigInt64Array: *(int64_t *)ptr = (int64_t)value; break;
        case kJSTypedArrayTypeBigUint64Array: *(uint64_t *)ptr = (uint64_t)value; break;
        default: break;
    }
}

static JSValueRef ct_atomic_result(JSContextRef ctx, JSTypedArrayType type, int64_t value, JSValueRef *exception) {
    switch (type) {
        case kJSTypedArrayTypeBigInt64Array:
            return JSBigIntCreateWithInt64(ctx, value, exception);
        case kJSTypedArrayTypeBigUint64Array:
            return JSBigIntCreateWithUInt64(ctx, (uint64_t)value, exception);
        default:
            return JSValueMakeNumber(ctx, (double)value);
    }
}

static int ct_atomic_view_ptr(JSContextRef ctx, JSValueRef value, size_t index, void **ptr_out, JSTypedArrayType *type_out, JSValueRef *exception) {
    if (!JSValueIsObject(ctx, value)) {
        ct_throw_message(ctx, exception, "Atomics operation requires a typed array");
        return -1;
    }
    JSObjectRef object = (JSObjectRef)value;
    JSValueRef local_exception = NULL;
    JSTypedArrayType type = JSValueGetTypedArrayType(ctx, value, &local_exception);
    if (local_exception != NULL || ct_atomic_element_size(type) == 0) {
        ct_throw_message(ctx, exception, "Atomics operation requires an integer typed array");
        return -1;
    }
    size_t length = JSObjectGetTypedArrayLength(ctx, object, &local_exception);
    if (local_exception != NULL || index >= length) {
        ct_throw_message(ctx, exception, "Atomics index is out of range");
        return -1;
    }
    void *base = JSObjectGetTypedArrayBytesPtr(ctx, object, &local_exception);
    if (local_exception != NULL || base == NULL) {
        ct_throw_message(ctx, exception, "Atomics typed array backing store is unavailable");
        return -1;
    }
    *ptr_out = (uint8_t *)base + index * ct_atomic_element_size(type);
    *type_out = type;
    return 0;
}

static JSValueRef ct_shared_atomic_op(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "sharedAtomicOp(op, typedArray, index[, value[, replacement]]) requires arguments");
        return JSValueMakeUndefined(ctx);
    }
    char *op = ct_value_to_string_copy(ctx, argv[0]);
    size_t index = (size_t)ct_value_to_number(ctx, argv[2]);
    void *ptr = NULL;
    JSTypedArrayType type = kJSTypedArrayTypeNone;
    if (ct_atomic_view_ptr(ctx, argv[1], index, &ptr, &type, exception) != 0) {
        free(op);
        return JSValueMakeUndefined(ctx);
    }
    int64_t value = argc >= 4 ? (int64_t)ct_value_to_number(ctx, argv[3]) : 0;
    int64_t replacement = argc >= 5 ? (int64_t)ct_value_to_number(ctx, argv[4]) : 0;
    int64_t old_value = 0;
    pthread_mutex_lock(&ct_shared_buffers_mutex);
    old_value = ct_atomic_read_value(ptr, type);
    if (op != NULL) {
        if (strcmp(op, "store") == 0) {
            ct_atomic_write_value(ptr, type, value);
            old_value = value;
        } else if (strcmp(op, "add") == 0) {
            ct_atomic_write_value(ptr, type, old_value + value);
        } else if (strcmp(op, "sub") == 0) {
            ct_atomic_write_value(ptr, type, old_value - value);
        } else if (strcmp(op, "and") == 0) {
            ct_atomic_write_value(ptr, type, old_value & value);
        } else if (strcmp(op, "or") == 0) {
            ct_atomic_write_value(ptr, type, old_value | value);
        } else if (strcmp(op, "xor") == 0) {
            ct_atomic_write_value(ptr, type, old_value ^ value);
        } else if (strcmp(op, "exchange") == 0) {
            ct_atomic_write_value(ptr, type, value);
        } else if (strcmp(op, "compareExchange") == 0) {
            if (old_value == value) ct_atomic_write_value(ptr, type, replacement);
        }
    }
    pthread_mutex_unlock(&ct_shared_buffers_mutex);
    free(op);
    return ct_atomic_result(ctx, type, old_value, exception);
}

static JSValueRef ct_shared_atomic_wait(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "sharedAtomicWait(typedArray, index, value[, timeout]) requires arguments");
        return JSValueMakeUndefined(ctx);
    }
    size_t index = (size_t)ct_value_to_number(ctx, argv[1]);
    void *ptr = NULL;
    JSTypedArrayType type = kJSTypedArrayTypeNone;
    if (ct_atomic_view_ptr(ctx, argv[0], index, &ptr, &type, exception) != 0) return JSValueMakeUndefined(ctx);
    if (type != kJSTypedArrayTypeInt32Array && type != kJSTypedArrayTypeBigInt64Array) {
        ct_throw_message(ctx, exception, "Atomics.wait requires Int32Array or BigInt64Array");
        return JSValueMakeUndefined(ctx);
    }
    int64_t expected = (int64_t)ct_value_to_number(ctx, argv[2]);
    double timeout_ms = argc >= 4 && !JSValueIsUndefined(ctx, argv[3]) ? ct_value_to_number(ctx, argv[3]) : INFINITY;
    if (timeout_ms != timeout_ms) timeout_ms = INFINITY;
    if (timeout_ms < 0) timeout_ms = 0;
    const char *result = "ok";
    pthread_mutex_lock(&ct_shared_buffers_mutex);
    if (ct_atomic_read_value(ptr, type) != expected) {
        result = "not-equal";
    } else if (timeout_ms == 0) {
        result = "timed-out";
    } else {
        CtAtomicWaiter waiter = {
            .ptr = ptr,
            .notified = false,
            .next = ct_atomic_waiters,
        };
        ct_atomic_waiters = &waiter;
        struct timespec deadline;
        if (timeout_ms != INFINITY) {
            clock_gettime(CLOCK_REALTIME, &deadline);
            long seconds = (long)(timeout_ms / 1000.0);
            long nanos = (long)((timeout_ms - (double)seconds * 1000.0) * 1000000.0);
            deadline.tv_sec += seconds;
            deadline.tv_nsec += nanos;
            if (deadline.tv_nsec >= 1000000000L) {
                deadline.tv_sec += deadline.tv_nsec / 1000000000L;
                deadline.tv_nsec %= 1000000000L;
            }
        }
        while (!waiter.notified) {
            int status = timeout_ms == INFINITY
                ? pthread_cond_wait(&ct_shared_buffers_cond, &ct_shared_buffers_mutex)
                : pthread_cond_timedwait(&ct_shared_buffers_cond, &ct_shared_buffers_mutex, &deadline);
            if (status == ETIMEDOUT && !waiter.notified) {
                result = "timed-out";
                break;
            }
        }
        if (waiter.notified) result = "ok";
        CtAtomicWaiter **cursor = &ct_atomic_waiters;
        while (*cursor != NULL && *cursor != &waiter) cursor = &(*cursor)->next;
        if (*cursor == &waiter) *cursor = waiter.next;
    }
    pthread_mutex_unlock(&ct_shared_buffers_mutex);
    return ct_make_string(ctx, result);
}

static size_t ct_atomic_notify_count(JSContextRef ctx, JSValueRef value) {
    if (value == NULL || JSValueIsUndefined(ctx, value)) return SIZE_MAX;
    double number = ct_value_to_number(ctx, value);
    if (number != number || number <= 0) return 0;
    if (number == INFINITY) return SIZE_MAX;
    return (size_t)floor(number);
}

static JSValueRef ct_shared_atomic_notify(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sharedAtomicNotify(typedArray, index[, count]) requires arguments");
        return JSValueMakeUndefined(ctx);
    }
    size_t index = (size_t)ct_value_to_number(ctx, argv[1]);
    void *ptr = NULL;
    JSTypedArrayType type = kJSTypedArrayTypeNone;
    if (ct_atomic_view_ptr(ctx, argv[0], index, &ptr, &type, exception) != 0) return JSValueMakeUndefined(ctx);
    if (type != kJSTypedArrayTypeInt32Array && type != kJSTypedArrayTypeBigInt64Array) {
        ct_throw_message(ctx, exception, "Atomics.notify requires Int32Array or BigInt64Array");
        return JSValueMakeUndefined(ctx);
    }
    size_t limit = ct_atomic_notify_count(ctx, argc >= 3 ? argv[2] : NULL);
    size_t notified = 0;
    pthread_mutex_lock(&ct_shared_buffers_mutex);
    for (CtAtomicWaiter *waiter = ct_atomic_waiters; waiter != NULL && notified < limit; waiter = waiter->next) {
        if (!waiter->notified && waiter->ptr == ptr) {
            waiter->notified = true;
            notified += 1;
        }
    }
    if (notified > 0) pthread_cond_broadcast(&ct_shared_buffers_cond);
    pthread_mutex_unlock(&ct_shared_buffers_mutex);
    return JSValueMakeNumber(ctx, (double)notified);
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

    JSContextRef previous_napi_context = ct_active_napi_context;
    ct_active_napi_context = ctx;
    ffi_call(&cif, FFI_FN(symbol), ct_ffi_value_ptr(&result, return_type), arg_value_ptrs);
    ct_active_napi_context = previous_napi_context;
    JSValueRef js_result = ct_ffi_value_to_js(ctx, return_type, result);

    free(library_path);
    free(symbol_name);
    return js_result;
}

static JSValueRef ct_native_symbol(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    void *handle = NULL;
    void *symbol = NULL;
    char *open_error = NULL;
    (void)function;
    (void)thisObject;

    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.nativeSymbol(library, symbol) requires library and symbol names");
        return JSValueMakeUndefined(ctx);
    }

    char *library_path = ct_value_to_string_copy(ctx, argv[0]);
    char *symbol_name = ct_value_to_string_copy(ctx, argv[1]);
    if (library_path == NULL || symbol_name == NULL) {
        free(library_path);
        free(symbol_name);
        ct_throw_message(ctx, exception, "cottontail.nativeSymbol requires string library and symbol names");
        return JSValueMakeUndefined(ctx);
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

    free(library_path);
    free(symbol_name);
    return JSValueMakeNumber(ctx, (double)(uintptr_t)symbol);
}

static JSValueRef ct_native_call_pointer(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    uint64_t pointer = 0;
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

    if (argc < 4 || ct_value_to_u64(ctx, argv[0], &pointer) != 0 || pointer == 0) {
        ct_throw_message(ctx, exception, "cottontail.nativeCallPointer(pointer, returnType, argTypes, args) requires a function pointer");
        return JSValueMakeUndefined(ctx);
    }

    if (ct_parse_ffi_type(ctx, argv[1], &return_type, exception) != 0 ||
        ct_parse_ffi_type_array(ctx, argv[2], arg_types, ffi_arg_types, &arg_count, exception) != 0) {
        return JSValueMakeUndefined(ctx);
    }

    if (!JSValueIsObject(ctx, argv[3])) {
        ct_throw_message(ctx, exception, "cottontail.nativeCallPointer args must be an array");
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef args_array = (JSObjectRef)argv[3];
    for (size_t index = 0; index < arg_count; index += 1) {
        JSValueRef item = JSObjectGetPropertyAtIndex(ctx, args_array, (unsigned)index, exception);
        if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(ctx);
        if (ct_ffi_value_from_js(ctx, item, arg_types[index], &arg_values[index], exception) != 0) {
            return JSValueMakeUndefined(ctx);
        }
        arg_value_ptrs[index] = ct_ffi_value_ptr(&arg_values[index], arg_types[index]);
    }

    if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, (unsigned int)arg_count, ct_ffi_libffi_type(return_type), ffi_arg_types) != FFI_OK) {
        ct_throw_message(ctx, exception, "ffi_prep_cif failed for function pointer");
        return JSValueMakeUndefined(ctx);
    }

    JSContextRef previous_napi_context = ct_active_napi_context;
    ct_active_napi_context = ctx;
    ffi_call(&cif, FFI_FN((void *)(uintptr_t)pointer), ct_ffi_value_ptr(&result, return_type), arg_value_ptrs);
    ct_active_napi_context = previous_napi_context;
    return ct_ffi_value_to_js(ctx, return_type, result);
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

static JSValueRef ct_mmap_file_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
#if defined(_WIN32)
    (void)argc;
    (void)argv;
    ct_throw_message(ctx, exception, "Bun.mmap is unavailable on Windows");
    return JSValueMakeUndefined(ctx);
#else
    if (argc < 1) {
        ct_throw_message(ctx, exception, "Expected a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    int fd = path != NULL ? open(path, O_RDWR) : -1;
    if (fd < 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        free(path);
        return JSValueMakeUndefined(ctx);
    }
    struct stat stat_value;
    if (fstat(fd, &stat_value) != 0) {
        int stat_error = errno;
        close(fd);
        free(path);
        ct_throw_message(ctx, exception, strerror(stat_error));
        return JSValueMakeUndefined(ctx);
    }
    size_t offset = argc >= 2 ? (size_t)ct_value_to_number(ctx, argv[1]) : 0;
    long page_size = sysconf(_SC_PAGESIZE);
    if (page_size > 0) offset -= offset % (size_t)page_size;
    double wanted_number = argc >= 3 ? ct_value_to_number(ctx, argv[2]) : -1;
    size_t available = (uint64_t)stat_value.st_size > offset ? (size_t)((uint64_t)stat_value.st_size - offset) : 0;
    size_t map_size = wanted_number >= 0 ? (size_t)wanted_number : available;
    if (map_size > available) map_size = available;
    int flags = argc >= 4 && !JSValueToBoolean(ctx, argv[3]) ? MAP_PRIVATE : MAP_SHARED;
    void *mapping = mmap(NULL, map_size, PROT_READ | PROT_WRITE, flags, fd, (off_t)offset);
    int map_error = errno;
    close(fd);
    free(path);
    if (mapping == MAP_FAILED) {
        ct_throw_message(ctx, exception, strerror(map_error));
        return JSValueMakeUndefined(ctx);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(
        ctx,
        mapping,
        map_size,
        ct_mmap_array_buffer_free,
        (void *)(uintptr_t)map_size,
        exception
    );
#endif
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
    ct_set_property(ctx, object, "dev", JSValueMakeNumber(ctx, (double)stat_value->st_dev), exception);
    ct_set_property(ctx, object, "ino", JSValueMakeNumber(ctx, (double)stat_value->st_ino), exception);
    ct_set_property(ctx, object, "size", JSValueMakeNumber(ctx, (double)stat_value->st_size), exception);
    ct_set_property(ctx, object, "mode", JSValueMakeNumber(ctx, (double)stat_value->st_mode), exception);
    ct_set_property(ctx, object, "nlink", JSValueMakeNumber(ctx, (double)stat_value->st_nlink), exception);
    ct_set_property(ctx, object, "uid", JSValueMakeNumber(ctx, (double)stat_value->st_uid), exception);
    ct_set_property(ctx, object, "gid", JSValueMakeNumber(ctx, (double)stat_value->st_gid), exception);
    ct_set_property(ctx, object, "rdev", JSValueMakeNumber(ctx, (double)stat_value->st_rdev), exception);
#if defined(__APPLE__) || defined(__linux__)
    ct_set_property(ctx, object, "blksize", JSValueMakeNumber(ctx, (double)stat_value->st_blksize), exception);
    ct_set_property(ctx, object, "blocks", JSValueMakeNumber(ctx, (double)stat_value->st_blocks), exception);
#else
    ct_set_property(ctx, object, "blksize", JSValueMakeNumber(ctx, 0), exception);
    ct_set_property(ctx, object, "blocks", JSValueMakeNumber(ctx, 0), exception);
#endif
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

static JSValueRef ct_rmdir_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "rmdirSync(path) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    char *error = NULL;
    if (ct_host_rmdir(path, &error) != 0) ct_throw_message(ctx, exception, error != NULL ? error : "rmdir failed");
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
    ct_set_property(ctx, response, "signalCode",
                    result->signal_code > 0 ? JSValueMakeNumber(ctx, result->signal_code) : JSValueMakeNull(ctx),
                    exception);
    ct_set_property(ctx, response, "stdout", ct_make_string_len(ctx, result->stdout_ptr != NULL ? result->stdout_ptr : "", result->stdout_len), exception);
    ct_set_property(ctx, response, "stderr", ct_make_string_len(ctx, result->stderr_ptr != NULL ? result->stderr_ptr : "", result->stderr_len), exception);
    return response;
}

static int ct_parse_spawn_options(JSContextRef ctx, JSValueRef value, char **cwd, CtHostEnvEntry **env_entries, size_t *env_count, bool *clear_env, bool *capture_output, bool *input_present, uint8_t **input_ptr, size_t *input_len, JSValueRef *exception) {
    *cwd = NULL;
    *env_entries = NULL;
    *env_count = 0;
    *clear_env = false;
    *capture_output = true;
    if (input_present != NULL) *input_present = false;
    if (input_ptr != NULL) *input_ptr = NULL;
    if (input_len != NULL) *input_len = 0;
    if (value == NULL || JSValueIsUndefined(ctx, value) || JSValueIsNull(ctx, value) || !JSValueIsObject(ctx, value)) return 0;
    JSObjectRef object = (JSObjectRef)value;
    JSValueRef cwd_value = ct_get_property(ctx, object, "cwd", exception);
    JSValueRef env_value = ct_get_property(ctx, object, "env", exception);
    JSValueRef clear_env_value = ct_get_property(ctx, object, "clearEnv", exception);
    JSValueRef stdio_value = ct_get_property(ctx, object, "stdio", exception);
    JSValueRef input_value = ct_get_property(ctx, object, "input", exception);
    if (exception != NULL && *exception != NULL) return -1;
    *cwd = ct_value_to_optional_string(ctx, cwd_value);
    *clear_env = JSValueToBoolean(ctx, clear_env_value);
    if (ct_parse_env_object(ctx, env_value, env_entries, env_count, exception) != 0) return -1;
    if (!JSValueIsUndefined(ctx, stdio_value) && !JSValueIsNull(ctx, stdio_value)) {
        char *stdio = ct_value_to_string_copy(ctx, stdio_value);
        if (stdio != NULL && strcmp(stdio, "inherit") == 0) *capture_output = false;
        free(stdio);
    }
    if (input_present != NULL && input_ptr != NULL && input_len != NULL &&
        !JSValueIsUndefined(ctx, input_value) && !JSValueIsNull(ctx, input_value)) {
        if (ct_get_bytes(ctx, input_value, input_ptr, input_len) != 0) {
            ct_throw_message(ctx, exception, "spawn input must be an ArrayBuffer or typed array");
            return -1;
        }
        *input_present = true;
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
    bool input_present = false;
    uint8_t *input_ptr = NULL;
    size_t input_len = 0;
    if (ct_parse_string_array(ctx, argc >= 2 ? argv[1] : NULL, &args, &arg_count, exception) != 0 ||
        ct_parse_spawn_options(ctx, argc >= 3 ? argv[2] : NULL, &cwd, &env_entries, &env_count, &clear_env, &capture_output, &input_present, &input_ptr, &input_len, exception) != 0) {
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
            .input_present = input_present,
            .input_ptr = input_ptr,
            .input_len = input_len,
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

static JSValueRef ct_process_execve(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "processExecve(file, args, env) requires file, args, and env");
        return JSValueMakeUndefined(ctx);
    }
    char *file = ct_value_to_string_copy(ctx, argv[0]);
    char **args = NULL;
    size_t arg_count = 0;
    CtHostEnvEntry *env_entries = NULL;
    size_t env_count = 0;
    if (file == NULL ||
        ct_parse_string_array(ctx, argv[1], &args, &arg_count, exception) != 0 ||
        ct_parse_env_object(ctx, argv[2], &env_entries, &env_count, exception) != 0) {
        free(file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }

    char **argv_exec = (char **)calloc(arg_count + 1, sizeof(char *));
    char **envp = ct_env_entries_to_envp(env_entries, env_count);
    if (argv_exec == NULL || envp == NULL) {
        free(argv_exec);
        ct_free_envp(envp, env_count);
        free(file);
        ct_free_string_array(args, arg_count);
        ct_free_env_entries(env_entries, env_count);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    for (size_t index = 0; index < arg_count; index += 1) argv_exec[index] = args[index];
    argv_exec[arg_count] = NULL;

#if defined(_WIN32)
    ct_throw_message(ctx, exception, "process.execve is unavailable on this platform");
#else
    execve(file, argv_exec, envp);
    ct_throw_message(ctx, exception, strerror(errno));
#endif

    free(argv_exec);
    ct_free_envp(envp, env_count);
    free(file);
    ct_free_string_array(args, arg_count);
    ct_free_env_entries(env_entries, env_count);
    return JSValueMakeUndefined(ctx);
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

static void ct_queue_spawn_ipc(CtJscRuntime *runtime, uint32_t id, const char *data, size_t data_len, int received_fd) {
    if (data == NULL && received_fd < 0) return;
    CtSpawnEvent *event = (CtSpawnEvent *)calloc(1, sizeof(CtSpawnEvent));
    if (event == NULL) return;
    event->process_id = id;
    event->type = ct_duplicate_bytes("ipc", 3);
    event->data = data_len > 0 ? ct_duplicate_bytes(data, data_len) : NULL;
    event->data_len = data_len;
    if (received_fd >= 0) {
        event->received_fd = received_fd;
        event->has_fd = true;
    }
    if (event->type == NULL || (data_len > 0 && event->data == NULL)) {
        free(event->type);
        free(event->data);
        if (received_fd >= 0) close(received_fd);
        free(event);
        return;
    }
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

static void ct_queue_worker_event(CtJscRuntime *runtime, uint32_t worker_id, const char *type) {
    if (runtime == NULL) return;
    CtWorkerEvent *event = (CtWorkerEvent *)calloc(1, sizeof(CtWorkerEvent));
    if (event == NULL) return;
    event->worker_id = worker_id;
    event->type = ct_duplicate_string(type != NULL ? type : "message");
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
#if defined(_WIN32)
    bool is_socket = ct_windows_is_socket(watcher->fd);
    intptr_t os_handle = is_socket ? -1 : _get_osfhandle(watcher->fd);
    bool is_crt_handle = os_handle != -1;
    bool is_crt_pipe = is_crt_handle && GetFileType((HANDLE)os_handle) == FILE_TYPE_PIPE;
    if (!is_crt_handle) ct_set_nonblocking_fd(watcher->fd);
#else
    int flags = fcntl(watcher->fd, F_GETFL, 0);
    if (flags >= 0) {
        (void)fcntl(watcher->fd, F_SETFL, flags | O_NONBLOCK);
    }
#endif

    while (ct_fd_watcher_is_active(watcher)) {
#if defined(_WIN32)
        if (is_crt_pipe) {
            DWORD available = 0;
            if (!PeekNamedPipe((HANDLE)os_handle, NULL, 0, NULL, &available, NULL)) {
                DWORD error = GetLastError();
                if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) {
                    ct_queue_fd_simple(watcher->runtime, watcher->id, "end", NULL);
                } else {
                    ct_queue_fd_simple(watcher->runtime, watcher->id, "error", "PeekNamedPipe failed");
                }
                break;
            }
            if (available == 0) {
                Sleep(10);
                continue;
            }
        }
#endif
        struct pollfd poll_fd;
        poll_fd.fd = watcher->fd;
        poll_fd.events = POLLIN | POLLHUP | POLLERR;
        poll_fd.revents = 0;
#if defined(_WIN32)
        if (is_crt_handle) poll_fd.revents = POLLIN;
#endif

#if defined(_WIN32)
        int ready;
        if (is_crt_handle) {
            poll_fd.revents = POLLIN;
            ready = 1;
        } else {
            ready = ct_windows_descriptor_read_ready(watcher->fd);
            if (ready > 0) poll_fd.revents = POLLIN;
        }
#else
        int ready = poll(&poll_fd, 1, 50);
#endif
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
            if (cursor->ipc_fd >= 0) {
                close(cursor->ipc_fd);
                cursor->ipc_fd = -1;
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

#if defined(_WIN32)
typedef struct {
    char *data;
    size_t len;
    size_t capacity;
} CtWindowsCommandLine;

static bool ct_windows_command_append(CtWindowsCommandLine *command, const char *data, size_t len) {
    if (command->len + len + 1 > command->capacity) {
        size_t capacity = command->capacity > 0 ? command->capacity : 128;
        while (capacity < command->len + len + 1) capacity *= 2;
        char *next = (char *)realloc(command->data, capacity);
        if (next == NULL) return false;
        command->data = next;
        command->capacity = capacity;
    }
    memcpy(command->data + command->len, data, len);
    command->len += len;
    command->data[command->len] = '\0';
    return true;
}

static bool ct_windows_command_append_char(CtWindowsCommandLine *command, char value) {
    return ct_windows_command_append(command, &value, 1);
}

static bool ct_windows_command_append_arg(CtWindowsCommandLine *command, const char *arg) {
    if (command->len > 0 && !ct_windows_command_append_char(command, ' ')) return false;
    size_t len = strlen(arg);
    bool quote = len == 0 || strpbrk(arg, " \t\n\v\"") != NULL;
    if (!quote) return ct_windows_command_append(command, arg, len);
    if (!ct_windows_command_append_char(command, '\"')) return false;
    size_t backslashes = 0;
    for (const char *cursor = arg;; cursor += 1) {
        if (*cursor == '\\') {
            backslashes += 1;
            continue;
        }
        if (*cursor == '\"' || *cursor == '\0') {
            size_t count = backslashes * 2 + (*cursor == '\"' ? 1 : 0);
            for (size_t index = 0; index < count; index += 1) {
                if (!ct_windows_command_append_char(command, '\\')) return false;
            }
            backslashes = 0;
            if (*cursor == '\0') break;
        } else {
            for (size_t index = 0; index < backslashes; index += 1) {
                if (!ct_windows_command_append_char(command, '\\')) return false;
            }
            backslashes = 0;
        }
        if (!ct_windows_command_append_char(command, *cursor)) return false;
    }
    return ct_windows_command_append_char(command, '\"');
}

static WCHAR *ct_windows_utf8_to_wide(const char *value) {
    if (value == NULL) return NULL;
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, NULL, 0);
    if (length <= 0) return NULL;
    WCHAR *wide = (WCHAR *)malloc(sizeof(WCHAR) * (size_t)length);
    if (wide == NULL) return NULL;
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, wide, length) <= 0) {
        free(wide);
        return NULL;
    }
    return wide;
}

static int ct_windows_env_entry_compare(const void *left, const void *right) {
    const CtHostEnvEntry *const *left_entry = (const CtHostEnvEntry *const *)left;
    const CtHostEnvEntry *const *right_entry = (const CtHostEnvEntry *const *)right;
    return _stricmp((*left_entry)->name, (*right_entry)->name);
}

static WCHAR *ct_windows_environment_block(const CtHostEnvEntry *entries, size_t count) {
    const CtHostEnvEntry **sorted = count > 0 ? (const CtHostEnvEntry **)malloc(sizeof(*sorted) * count) : NULL;
    if (count > 0 && sorted == NULL) return NULL;
    for (size_t index = 0; index < count; index += 1) sorted[index] = &entries[index];
    qsort(sorted, count, sizeof(*sorted), ct_windows_env_entry_compare);

    size_t capacity = 1;
    for (size_t index = 0; index < count; index += 1) {
        int name_len = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, sorted[index]->name, -1, NULL, 0);
        int value_len = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, sorted[index]->value, -1, NULL, 0);
        if (name_len <= 0 || value_len <= 0) {
            free(sorted);
            return NULL;
        }
        capacity += (size_t)name_len + (size_t)value_len;
    }
    WCHAR *block = (WCHAR *)calloc(capacity, sizeof(WCHAR));
    if (block == NULL) {
        free(sorted);
        return NULL;
    }
    size_t cursor = 0;
    for (size_t index = 0; index < count; index += 1) {
        int name_len = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, sorted[index]->name, -1, block + cursor, (int)(capacity - cursor));
        cursor += (size_t)name_len - 1;
        block[cursor++] = L'=';
        int value_len = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, sorted[index]->value, -1, block + cursor, (int)(capacity - cursor));
        cursor += (size_t)value_len;
    }
    block[cursor] = L'\0';
    free(sorted);
    return block;
}

static HANDLE ct_windows_null_handle(DWORD access) {
    SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
    return CreateFileW(L"NUL", access, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
}

static bool ct_windows_create_pipe(HANDLE *parent_end, HANDLE *child_end, bool parent_writes) {
    SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
    HANDLE read_handle = NULL;
    HANDLE write_handle = NULL;
    if (!CreatePipe(&read_handle, &write_handle, &security, 0)) return false;
    *parent_end = parent_writes ? write_handle : read_handle;
    *child_end = parent_writes ? read_handle : write_handle;
    if (!SetHandleInformation(*parent_end, HANDLE_FLAG_INHERIT, 0)) {
        CloseHandle(read_handle);
        CloseHandle(write_handle);
        return false;
    }
    return true;
}

static int ct_windows_handle_to_fd(HANDLE handle, int flags) {
    if (handle == NULL || handle == INVALID_HANDLE_VALUE) return -1;
    int fd = _open_osfhandle((intptr_t)handle, flags | _O_BINARY);
    if (fd < 0) CloseHandle(handle);
    return fd;
}

static bool ct_windows_spawn_process(
    const char *file,
    char *const *args,
    size_t arg_count,
    const char *argv0,
    const char *cwd,
    const CtHostEnvEntry *env_entries,
    size_t env_count,
    bool clear_env,
    CtProcessStdioMode stdin_mode,
    CtProcessStdioMode stdout_mode,
    CtProcessStdioMode stderr_mode,
    bool detached,
    HANDLE *process_out,
    DWORD *pid_out,
    int *stdin_fd_out,
    int *stdout_fd_out,
    int *stderr_fd_out
) {
    *process_out = NULL;
    *pid_out = 0;
    *stdin_fd_out = -1;
    *stdout_fd_out = -1;
    *stderr_fd_out = -1;

    CtWindowsCommandLine command = { 0 };
    if (!ct_windows_command_append_arg(&command, argv0 != NULL && argv0[0] != '\0' ? argv0 : file)) goto fail;
    for (size_t index = 0; index < arg_count; index += 1) {
        if (!ct_windows_command_append_arg(&command, args[index])) goto fail;
    }
    WCHAR *file_wide = ct_windows_utf8_to_wide(file);
    WCHAR *command_wide = ct_windows_utf8_to_wide(command.data);
    WCHAR *cwd_wide = cwd != NULL ? ct_windows_utf8_to_wide(cwd) : NULL;
    WCHAR *environment = (clear_env || env_count > 0) ? ct_windows_environment_block(env_entries, env_count) : NULL;
    if (file_wide == NULL || command_wide == NULL || (cwd != NULL && cwd_wide == NULL) || ((clear_env || env_count > 0) && environment == NULL)) {
        free(file_wide); free(command_wide); free(cwd_wide); free(environment);
        goto fail;
    }

    HANDLE parent_stdin = NULL, child_stdin = NULL;
    HANDLE parent_stdout = NULL, child_stdout = NULL;
    HANDLE parent_stderr = NULL, child_stderr = NULL;
    if (stdin_mode == CT_PROCESS_STDIO_PIPE && !ct_windows_create_pipe(&parent_stdin, &child_stdin, true)) goto handles_fail;
    if (stdout_mode == CT_PROCESS_STDIO_PIPE && !ct_windows_create_pipe(&parent_stdout, &child_stdout, false)) goto handles_fail;
    if (stderr_mode == CT_PROCESS_STDIO_PIPE && !ct_windows_create_pipe(&parent_stderr, &child_stderr, false)) goto handles_fail;
    if (stdin_mode == CT_PROCESS_STDIO_INHERIT) child_stdin = GetStdHandle(STD_INPUT_HANDLE);
    else if (stdin_mode == CT_PROCESS_STDIO_IGNORE) child_stdin = ct_windows_null_handle(GENERIC_READ);
    if (stdout_mode == CT_PROCESS_STDIO_INHERIT) child_stdout = GetStdHandle(STD_OUTPUT_HANDLE);
    else if (stdout_mode == CT_PROCESS_STDIO_IGNORE) child_stdout = ct_windows_null_handle(GENERIC_WRITE);
    if (stderr_mode == CT_PROCESS_STDIO_INHERIT) child_stderr = GetStdHandle(STD_ERROR_HANDLE);
    else if (stderr_mode == CT_PROCESS_STDIO_IGNORE) child_stderr = ct_windows_null_handle(GENERIC_WRITE);
    if (child_stdin == INVALID_HANDLE_VALUE || child_stdout == INVALID_HANDLE_VALUE || child_stderr == INVALID_HANDLE_VALUE) goto handles_fail;

    STARTUPINFOW startup;
    PROCESS_INFORMATION process_info;
    memset(&startup, 0, sizeof(startup));
    memset(&process_info, 0, sizeof(process_info));
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = child_stdin;
    startup.hStdOutput = child_stdout;
    startup.hStdError = child_stderr;
    DWORD flags = CREATE_UNICODE_ENVIRONMENT | (detached ? CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS : CREATE_NO_WINDOW);
    BOOL created = CreateProcessW(file_wide, command_wide, NULL, NULL, TRUE, flags, environment, cwd_wide, &startup, &process_info);

    if (stdin_mode != CT_PROCESS_STDIO_INHERIT && child_stdin != NULL) CloseHandle(child_stdin);
    if (stdout_mode != CT_PROCESS_STDIO_INHERIT && child_stdout != NULL) CloseHandle(child_stdout);
    if (stderr_mode != CT_PROCESS_STDIO_INHERIT && child_stderr != NULL) CloseHandle(child_stderr);
    free(file_wide); free(command_wide); free(cwd_wide); free(environment); free(command.data);
    if (!created) {
        if (parent_stdin != NULL) CloseHandle(parent_stdin);
        if (parent_stdout != NULL) CloseHandle(parent_stdout);
        if (parent_stderr != NULL) CloseHandle(parent_stderr);
        return false;
    }
    CloseHandle(process_info.hThread);
    *process_out = process_info.hProcess;
    *pid_out = process_info.dwProcessId;
    *stdin_fd_out = ct_windows_handle_to_fd(parent_stdin, _O_WRONLY);
    *stdout_fd_out = ct_windows_handle_to_fd(parent_stdout, _O_RDONLY);
    *stderr_fd_out = ct_windows_handle_to_fd(parent_stderr, _O_RDONLY);
    return true;

handles_fail:
    if (parent_stdin != NULL) CloseHandle(parent_stdin);
    if (parent_stdout != NULL) CloseHandle(parent_stdout);
    if (parent_stderr != NULL) CloseHandle(parent_stderr);
    if (stdin_mode != CT_PROCESS_STDIO_INHERIT && child_stdin != NULL && child_stdin != INVALID_HANDLE_VALUE) CloseHandle(child_stdin);
    if (stdout_mode != CT_PROCESS_STDIO_INHERIT && child_stdout != NULL && child_stdout != INVALID_HANDLE_VALUE) CloseHandle(child_stdout);
    if (stderr_mode != CT_PROCESS_STDIO_INHERIT && child_stderr != NULL && child_stderr != INVALID_HANDLE_VALUE) CloseHandle(child_stderr);
    free(file_wide); free(command_wide); free(cwd_wide); free(environment);
fail:
    free(command.data);
    return false;
}

static bool ct_windows_drain_process_pipe(CtAsyncProcess *process, int *fd, const char *type) {
    if (*fd < 0) return false;
    intptr_t raw_handle = _get_osfhandle(*fd);
    if (raw_handle == -1) {
        close(*fd);
        *fd = -1;
        return false;
    }
    DWORD available = 0;
    if (!PeekNamedPipe((HANDLE)raw_handle, NULL, 0, NULL, &available, NULL)) {
        DWORD error = GetLastError();
        if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) {
            close(*fd);
            *fd = -1;
        }
        return false;
    }
    if (available == 0) return false;
    char buffer[16384];
    unsigned int amount = available < sizeof(buffer) ? (unsigned int)available : (unsigned int)sizeof(buffer);
    int count = read(*fd, buffer, amount);
    if (count > 0) {
        ct_queue_spawn_text(process->runtime, process->id, type, buffer, (size_t)count);
        return true;
    }
    return false;
}

static void ct_windows_rusage_for_process(HANDLE process, struct rusage *usage) {
    memset(usage, 0, sizeof(*usage));
    FILETIME creation_time, exit_time, kernel_time, user_time;
    if (GetProcessTimes(process, &creation_time, &exit_time, &kernel_time, &user_time)) {
        ULARGE_INTEGER kernel = { .LowPart = kernel_time.dwLowDateTime, .HighPart = kernel_time.dwHighDateTime };
        ULARGE_INTEGER user = { .LowPart = user_time.dwLowDateTime, .HighPart = user_time.dwHighDateTime };
        usage->ru_stime.tv_sec = (long)(kernel.QuadPart / 10000000ULL);
        usage->ru_stime.tv_usec = (long)((kernel.QuadPart % 10000000ULL) / 10ULL);
        usage->ru_utime.tv_sec = (long)(user.QuadPart / 10000000ULL);
        usage->ru_utime.tv_usec = (long)((user.QuadPart % 10000000ULL) / 10ULL);
    }
    PROCESS_MEMORY_COUNTERS memory = { 0 };
    memory.cb = sizeof(memory);
    if (GetProcessMemoryInfo(process, &memory, sizeof(memory))) usage->ru_maxrss = memory.PeakWorkingSetSize;
}
#endif

static void *ct_async_process_thread(void *opaque) {
    CtAsyncProcess *process = (CtAsyncProcess *)opaque;
#if defined(_WIN32)
    bool exited = false;
    DWORD exit_code = 1;
    while (!exited || process->stdout_fd >= 0 || process->stderr_fd >= 0) {
        bool read_data = false;
        read_data |= ct_windows_drain_process_pipe(process, &process->stdout_fd, "stdout");
        read_data |= ct_windows_drain_process_pipe(process, &process->stderr_fd, "stderr");
        if (!exited && WaitForSingleObject(process->process_handle, 0) == WAIT_OBJECT_0) {
            exited = true;
            GetExitCodeProcess(process->process_handle, &exit_code);
        }
        if (exited && !read_data) {
            ct_windows_drain_process_pipe(process, &process->stdout_fd, "stdout");
            ct_windows_drain_process_pipe(process, &process->stderr_fd, "stderr");
            if (process->stdout_fd >= 0) { close(process->stdout_fd); process->stdout_fd = -1; }
            if (process->stderr_fd >= 0) { close(process->stderr_fd); process->stderr_fd = -1; }
        }
        if (!read_data && !exited) Sleep(10);
    }
    struct rusage resource_usage;
    ct_windows_rusage_for_process(process->process_handle, &resource_usage);
    CtSpawnEvent *exit_event = (CtSpawnEvent *)calloc(1, sizeof(CtSpawnEvent));
    if (exit_event != NULL) {
        exit_event->process_id = process->id;
        exit_event->type = ct_duplicate_bytes("exit", 4);
        exit_event->exit_code = (int)exit_code;
        exit_event->resource_usage = resource_usage;
        exit_event->has_resource_usage = true;
        ct_queue_spawn_event(process->runtime, exit_event);
    }
    if (process->stdin_fd >= 0) close(process->stdin_fd);
    CloseHandle(process->process_handle);
    ct_async_process_remove(process);
    free(process);
    return NULL;
#else
    int status = 0;
    bool exited = false;
    struct rusage resource_usage;
    memset(&resource_usage, 0, sizeof(resource_usage));
    bool has_resource_usage = false;
    if (process->stdout_fd >= 0) fcntl(process->stdout_fd, F_SETFL, fcntl(process->stdout_fd, F_GETFL, 0) | O_NONBLOCK);
    if (process->stderr_fd >= 0) fcntl(process->stderr_fd, F_SETFL, fcntl(process->stderr_fd, F_GETFL, 0) | O_NONBLOCK);
    if (process->ipc_fd >= 0) fcntl(process->ipc_fd, F_SETFL, fcntl(process->ipc_fd, F_GETFL, 0) | O_NONBLOCK);

    while (!exited || process->stdout_fd >= 0 || process->stderr_fd >= 0 || process->ipc_fd >= 0) {
        struct pollfd fds[3];
        const char *types[3];
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
        if (process->ipc_fd >= 0) {
            fds[count].fd = process->ipc_fd;
            fds[count].events = POLLIN | POLLHUP | POLLERR | POLLNVAL;
            fds[count].revents = 0;
            types[count] = "ipc";
            count += 1;
        }

        int ready = count > 0 ? poll(fds, (nfds_t)count, 50) : 0;
        if (ready > 0) {
            for (int index = 0; index < count; index += 1) {
                if ((fds[index].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) == 0) continue;
                if (strcmp(types[index], "ipc") == 0) {
                    if ((fds[index].revents & POLLNVAL) != 0) {
                        process->ipc_fd = -1;
                        continue;
                    }
                    for (;;) {
                        char buffer[65536];
                        char control[CMSG_SPACE(sizeof(int))];
                        struct iovec iov;
                        memset(&iov, 0, sizeof(iov));
                        iov.iov_base = buffer;
                        iov.iov_len = sizeof(buffer);
                        struct msghdr msg;
                        memset(&msg, 0, sizeof(msg));
                        memset(control, 0, sizeof(control));
                        msg.msg_iov = &iov;
                        msg.msg_iovlen = 1;
                        msg.msg_control = control;
                        msg.msg_controllen = sizeof(control);
                        ssize_t n = recvmsg(fds[index].fd, &msg, 0);
                        if (n > 0) {
                            int received_fd = -1;
                            for (struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg); cmsg != NULL; cmsg = CMSG_NXTHDR(&msg, cmsg)) {
                                if (cmsg->cmsg_level == SOL_SOCKET && cmsg->cmsg_type == SCM_RIGHTS && cmsg->cmsg_len >= CMSG_LEN(sizeof(int))) {
                                    memcpy(&received_fd, CMSG_DATA(cmsg), sizeof(int));
                                    break;
                                }
                            }
                            ct_queue_spawn_ipc(process->runtime, process->id, buffer, (size_t)n, received_fd);
                            continue;
                        }
                        if (n == 0) {
                            if (process->ipc_fd >= 0) close(process->ipc_fd);
                            process->ipc_fd = -1;
                            break;
                        }
                        if (errno == EINTR) continue;
                        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                        if (process->ipc_fd >= 0) close(process->ipc_fd);
                        process->ipc_fd = -1;
                        break;
                    }
                    continue;
                }
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
            pid_t wait_result = wait4(process->pid, &status, WNOHANG, &resource_usage);
            if (wait_result == process->pid) {
                exited = true;
                has_resource_usage = true;
            } else if (wait_result < 0 && errno != EINTR) {
                exited = true;
            }
        }

        if (count == 0 && !exited) usleep(1000);
    }

    if (!exited) {
        pid_t wait_result;
        do {
            wait_result = wait4(process->pid, &status, 0, &resource_usage);
        } while (wait_result < 0 && errno == EINTR);
        has_resource_usage = wait_result == process->pid;
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
        exit_event->resource_usage = resource_usage;
        exit_event->has_resource_usage = has_resource_usage;
        ct_queue_spawn_event(process->runtime, exit_event);
    }
    if (process->stdin_fd >= 0) close(process->stdin_fd);
    if (process->ipc_fd >= 0) close(process->ipc_fd);
    ct_async_process_remove(process);
    free(process);
    return NULL;
#endif
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
    bool ipc_enabled = false;
    CtProcessStdioMode stdin_mode = CT_PROCESS_STDIO_IGNORE;
    CtProcessStdioMode stdout_mode = CT_PROCESS_STDIO_PIPE;
    CtProcessStdioMode stderr_mode = CT_PROCESS_STDIO_INHERIT;
    if (ct_parse_string_array(ctx, argc >= 2 ? argv[1] : NULL, &args, &arg_count, exception) != 0 ||
        ct_parse_spawn_options(ctx, argc >= 3 ? argv[2] : NULL, &cwd, &env_entries, &env_count, &clear_env, &capture_output, NULL, NULL, NULL, exception) != 0) {
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }

    char *argv0 = NULL;
    if (argc >= 3 && !JSValueIsUndefined(ctx, argv[2]) && !JSValueIsNull(ctx, argv[2]) && JSValueIsObject(ctx, argv[2])) {
        JSObjectRef options = (JSObjectRef)argv[2];
        JSValueRef stdio_value = ct_get_property(ctx, options, "stdio", exception);
        JSValueRef ipc_value = ct_get_property(ctx, options, "ipc", exception);
        JSValueRef argv0_value = ct_get_property(ctx, options, "argv0", exception);
        if (exception != NULL && *exception != NULL) {
            free(file);
            ct_free_string_array(args, arg_count);
            free(cwd);
            ct_free_env_entries(env_entries, env_count);
            return JSValueMakeUndefined(ctx);
        }
        ipc_enabled = JSValueToBoolean(ctx, ipc_value);
        argv0 = ct_value_to_optional_string(ctx, argv0_value);

        if (!JSValueIsUndefined(ctx, stdio_value)) {
            CtProcessStdioMode stdio_mode = stdout_mode;
            if (ct_process_parse_stdio_value(ctx, stdio_value, &stdio_mode, exception) != 0) {
                free(file);
                ct_free_string_array(args, arg_count);
                free(cwd);
                free(argv0);
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
            free(argv0);
            ct_free_env_entries(env_entries, env_count);
            return JSValueMakeUndefined(ctx);
        }
    }

    uint32_t id = ++runtime->next_process_id;

#if defined(_WIN32)
    if (ipc_enabled) {
        ct_throw_message(ctx, exception, "IPC handle passing is unavailable on this platform");
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        free(argv0);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }
    HANDLE process_handle = NULL;
    DWORD pid = 0;
    int stdin_fd = -1;
    int stdout_fd = -1;
    int stderr_fd = -1;
    if (!ct_windows_spawn_process(file, args, arg_count, argv0, cwd, env_entries, env_count, clear_env,
                                  stdin_mode, stdout_mode, stderr_mode, false, &process_handle, &pid,
                                  &stdin_fd, &stdout_fd, &stderr_fd)) {
        ct_throw_message(ctx, exception, "CreateProcessW failed");
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        free(argv0);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }
    CtAsyncProcess *process = (CtAsyncProcess *)calloc(1, sizeof(CtAsyncProcess));
    if (process == NULL) {
        TerminateProcess(process_handle, 1);
        CloseHandle(process_handle);
        if (stdin_fd >= 0) close(stdin_fd);
        if (stdout_fd >= 0) close(stdout_fd);
        if (stderr_fd >= 0) close(stderr_fd);
        ct_throw_message(ctx, exception, "Out of memory");
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        free(argv0);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }
    process->id = id;
    process->pid = (pid_t)pid;
    process->stdin_fd = stdin_fd;
    process->stdout_fd = stdout_fd;
    process->stderr_fd = stderr_fd;
    process->ipc_fd = -1;
    process->runtime = runtime;
    process->process_handle = process_handle;
    pthread_mutex_lock(&ct_async_processes_mutex);
    process->next = ct_async_processes;
    ct_async_processes = process;
    pthread_mutex_unlock(&ct_async_processes_mutex);
    if (pthread_create(&process->thread, NULL, ct_async_process_thread, process) == 0) pthread_detach(process->thread);

    JSObjectRef response = ct_make_object(ctx);
    ct_set_property(ctx, response, "id", JSValueMakeNumber(ctx, id), exception);
    ct_set_property(ctx, response, "pid", JSValueMakeNumber(ctx, (double)pid), exception);
    free(file);
    ct_free_string_array(args, arg_count);
    free(cwd);
    free(argv0);
    ct_free_env_entries(env_entries, env_count);
    return response;
#else
    int stdin_pipe[2] = { -1, -1 };
    int stdout_pipe[2] = { -1, -1 };
    int stderr_pipe[2] = { -1, -1 };
    int ipc_socket[2] = { -1, -1 };
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
#if !defined(_WIN32)
    if (ipc_enabled && socketpair(AF_UNIX, SOCK_STREAM, 0, ipc_socket) != 0) {
        ct_process_close_fd(&stdin_pipe[0]);
        ct_process_close_fd(&stdin_pipe[1]);
        ct_process_close_fd(&stdout_pipe[0]);
        ct_process_close_fd(&stdout_pipe[1]);
        ct_process_close_fd(&stderr_pipe[0]);
        ct_process_close_fd(&stderr_pipe[1]);
        ct_throw_message(ctx, exception, strerror(errno));
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }
#else
    if (ipc_enabled) {
        ct_process_close_fd(&stdin_pipe[0]);
        ct_process_close_fd(&stdin_pipe[1]);
        ct_process_close_fd(&stdout_pipe[0]);
        ct_process_close_fd(&stdout_pipe[1]);
        ct_process_close_fd(&stderr_pipe[0]);
        ct_process_close_fd(&stderr_pipe[1]);
        ct_throw_message(ctx, exception, "IPC handle passing is unavailable on this platform");
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeUndefined(ctx);
    }
#endif

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
        if (ipc_enabled) {
            ct_process_close_fd(&ipc_socket[0]);
            if (ipc_socket[1] >= 0) {
                dup2(ipc_socket[1], 3);
                if (ipc_socket[1] != 3) close(ipc_socket[1]);
                setenv("COTTONTAIL_IPC_FD", "3", 1);
            }
        }
        char **argv_exec = (char **)calloc(arg_count + 2, sizeof(char *));
        if (argv_exec == NULL) _exit(127);
        argv_exec[0] = argv0 != NULL && argv0[0] != '\0' ? argv0 : file;
        for (size_t index = 0; index < arg_count; index += 1) argv_exec[index + 1] = args[index];
        argv_exec[arg_count + 1] = NULL;
        execvp(file, argv_exec);
        _exit(127);
    }

    free(argv0);
    ct_process_close_fd(&stdin_pipe[0]);
    ct_process_close_fd(&stdout_pipe[1]);
    ct_process_close_fd(&stderr_pipe[1]);
    if (ipc_enabled) ct_process_close_fd(&ipc_socket[1]);
    if (pid < 0) {
        ct_process_close_fd(&stdin_pipe[1]);
        ct_process_close_fd(&stdout_pipe[0]);
        ct_process_close_fd(&stderr_pipe[0]);
        ct_process_close_fd(&ipc_socket[0]);
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
        ct_process_close_fd(&ipc_socket[0]);
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
    process->ipc_fd = ipc_enabled ? ipc_socket[0] : -1;
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
    if (process->ipc_fd >= 0) ct_set_property(ctx, response, "ipcFd", JSValueMakeNumber(ctx, process->ipc_fd), exception);

    free(file);
    ct_free_string_array(args, arg_count);
    free(cwd);
    ct_free_env_entries(env_entries, env_count);
    return response;
#endif
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

static JSValueRef ct_spawn_close_ipc(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)exception;
    if (argc < 1) return JSValueMakeUndefined(ctx);
    uint32_t id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    pthread_mutex_lock(&ct_async_processes_mutex);
    CtAsyncProcess *process = ct_async_processes;
    while (process != NULL && process->id != id) process = process->next;
    if (process != NULL && process->ipc_fd >= 0) {
        close(process->ipc_fd);
        process->ipc_fd = -1;
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
        ct_parse_spawn_options(ctx, argc >= 3 ? argv[2] : NULL, &cwd, &env_entries, &env_count, &clear_env, &capture_output, NULL, NULL, NULL, exception) != 0) {
        free(file);
        ct_free_string_array(args, arg_count);
        free(cwd);
        ct_free_env_entries(env_entries, env_count);
        return JSValueMakeNumber(ctx, 0);
    }

#if defined(_WIN32)
    HANDLE process_handle = NULL;
    DWORD pid = 0;
    int stdin_fd = -1, stdout_fd = -1, stderr_fd = -1;
    if (!ct_windows_spawn_process(file, args, arg_count, NULL, cwd, env_entries, env_count, clear_env,
                                  CT_PROCESS_STDIO_IGNORE, CT_PROCESS_STDIO_IGNORE, CT_PROCESS_STDIO_IGNORE,
                                  true, &process_handle, &pid, &stdin_fd, &stdout_fd, &stderr_fd)) {
        ct_throw_message(ctx, exception, "CreateProcessW failed");
        pid = 0;
    }
    if (process_handle != NULL) CloseHandle(process_handle);
    if (stdin_fd >= 0) close(stdin_fd);
    if (stdout_fd >= 0) close(stdout_fd);
    if (stderr_fd >= 0) close(stderr_fd);
#else
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
#endif
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

static JSValueRef ct_gc(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    (void)argc;
    (void)argv;
    (void)exception;
#if defined(__APPLE__)
    JSSynchronousGarbageCollectForDebugging(ctx);
#else
    JSGarbageCollect(ctx);
#endif
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_jsc_memory_usage(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    (void)argc;
    (void)argv;
    (void)exception;
#if defined(__APPLE__)
    JSObjectRef statistics = JSGetMemoryUsageStatistics(ctx);
    return statistics != NULL ? statistics : ct_make_object(ctx);
#else
    return ct_make_object(ctx);
#endif
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
        if (strcmp(event->type != NULL ? event->type : "", "ipc") == 0) {
            if (event->has_fd) {
                ct_set_property(ctx, item, "fd", JSValueMakeNumber(ctx, event->received_fd), exception);
            } else {
                ct_set_property(ctx, item, "fd", JSValueMakeNull(ctx), exception);
            }
        }
        if (strcmp(event->type != NULL ? event->type : "", "exit") == 0) {
            if (event->signal_code > 0) {
                ct_set_property(ctx, item, "exitCode", JSValueMakeNull(ctx), exception);
                ct_set_property(ctx, item, "signalCode", JSValueMakeNumber(ctx, event->signal_code), exception);
            } else {
                ct_set_property(ctx, item, "exitCode", JSValueMakeNumber(ctx, event->exit_code), exception);
                ct_set_property(ctx, item, "signalCode", JSValueMakeNull(ctx), exception);
            }
            ct_set_property(ctx, item, "killed", JSValueMakeBoolean(ctx, event->killed), exception);
            if (event->has_resource_usage) {
                ct_set_property(ctx, item, "resourceUsage", ct_rusage_object(ctx, &event->resource_usage, exception), exception);
            }
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
        ct_set_property(ctx, item, "type", ct_make_string(ctx, event->type != NULL ? event->type : "message"), exception);
        JSValueRef arg = item;
        JSObjectCallAsFunction(ctx, runtime->worker_event_handler, NULL, 1, &arg, exception);
        free(event->type);
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

    JSValueRef hook_value = ct_get_property(ctx, JSContextGetGlobalObject(ctx), "__cottontailImportModule", exception);
    if (exception != NULL && *exception != NULL) {
        free(specifier);
        free(referrer);
        return JSValueMakeUndefined(ctx);
    }
    if (hook_value != NULL && JSValueIsObject(ctx, hook_value)) {
        JSObjectRef hook = (JSObjectRef)hook_value;
        if (JSObjectIsFunction(ctx, hook)) {
            JSValueRef args[2] = {
                ct_make_string(ctx, specifier),
                referrer != NULL ? ct_make_string(ctx, referrer) : JSValueMakeUndefined(ctx),
            };
            JSValueRef hook_exception = NULL;
            JSValueRef result = JSObjectCallAsFunction(ctx, hook, NULL, 2, args, &hook_exception);
            free(specifier);
            free(referrer);
            if (hook_exception != NULL) {
                char *error = ct_copy_exception(ctx, hook_exception);
                ct_throw_message(ctx, exception, error != NULL ? error : "Dynamic import failed");
                free(error);
                return JSValueMakeUndefined(ctx);
            }
            return result != NULL ? result : JSValueMakeUndefined(ctx);
        }
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

static JSValueRef ct_worker_thread_id(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    (void)argc;
    (void)argv;
    (void)exception;
    CtJscRuntime *runtime = ct_callback_runtime(function);
    return JSValueMakeNumber(ctx, runtime != NULL && runtime->worker != NULL ? runtime->worker->id : 0);
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
    ct_queue_worker_event(parent_runtime, worker_id, "message");
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
        bool has_active_handles = false;
        if (ct_jsc_runtime_has_active_handles(runtime, &has_active_handles, &error) != 0) {
            fprintf(stderr, "%s\n", error != NULL ? error : "cottontail: worker active-handle check failed");
            free(error);
            break;
        }
        if (!has_active_handles) break;
        usleep((useconds_t)delay_ms * 1000);
    }

    ct_jsc_runtime_destroy(runtime);
    pthread_mutex_lock(&start->worker->mutex);
    start->worker->terminated = true;
    pthread_mutex_unlock(&start->worker->mutex);
    ct_queue_worker_event(start->worker->parent_runtime, start->worker->id, "exit");
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

    pthread_t thread;
#if defined(_WIN32)
    int create_status = ct_windows_thread_create(&thread, CT_WORKER_STACK_SIZE, ct_worker_entry, start);
#else
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

    int create_status = pthread_create(&thread, &attr, ct_worker_entry, start);
    pthread_attr_destroy(&attr);
#endif
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
    char *flags = argc >= 2 && !JSValueIsNumber(ctx, argv[1]) ? ct_value_to_optional_string(ctx, argv[1]) : NULL;
    int open_flags = O_RDONLY;
    if (argc >= 2 && JSValueIsNumber(ctx, argv[1])) {
        open_flags = (int)ct_value_to_number(ctx, argv[1]);
    } else if (flags != NULL) {
        if (strcmp(flags, "r") == 0) open_flags = O_RDONLY;
        else if (strcmp(flags, "r+") == 0) open_flags = O_RDWR;
        else if (strcmp(flags, "rs") == 0 || strcmp(flags, "sr") == 0) open_flags = O_RDONLY | O_SYNC;
        else if (strcmp(flags, "rs+") == 0 || strcmp(flags, "sr+") == 0) open_flags = O_RDWR | O_SYNC;
        else if (strcmp(flags, "w") == 0) open_flags = O_WRONLY | O_CREAT | O_TRUNC;
        else if (strcmp(flags, "wx") == 0 || strcmp(flags, "xw") == 0) open_flags = O_WRONLY | O_CREAT | O_TRUNC | O_EXCL;
        else if (strcmp(flags, "w+") == 0) open_flags = O_RDWR | O_CREAT | O_TRUNC;
        else if (strcmp(flags, "wx+") == 0 || strcmp(flags, "xw+") == 0) open_flags = O_RDWR | O_CREAT | O_TRUNC | O_EXCL;
        else if (strcmp(flags, "a") == 0) open_flags = O_WRONLY | O_CREAT | O_APPEND;
        else if (strcmp(flags, "ax") == 0 || strcmp(flags, "xa") == 0) open_flags = O_WRONLY | O_CREAT | O_APPEND | O_EXCL;
        else if (strcmp(flags, "a+") == 0) open_flags = O_RDWR | O_CREAT | O_APPEND;
        else if (strcmp(flags, "ax+") == 0 || strcmp(flags, "xa+") == 0) open_flags = O_RDWR | O_CREAT | O_APPEND | O_EXCL;
        else if (strcmp(flags, "as") == 0 || strcmp(flags, "sa") == 0) open_flags = O_WRONLY | O_CREAT | O_APPEND | O_SYNC;
        else if (strcmp(flags, "as+") == 0 || strcmp(flags, "sa+") == 0) open_flags = O_RDWR | O_CREAT | O_APPEND | O_SYNC;
    }
    int mode = argc >= 3 ? (int)ct_value_to_number(ctx, argv[2]) : 0666;
    int fd = open(path, open_flags, (mode_t)mode);
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

#if defined(_WIN32)
    int ready = ct_windows_descriptor_read_ready(fd);
#else
    struct pollfd poll_fd;
    poll_fd.fd = fd;
    poll_fd.events = POLLIN | POLLHUP | POLLERR;
    poll_fd.revents = 0;
    int ready = poll(&poll_fd, 1, 0);
#endif
    if (ready == 0) {
        return JSValueMakeNull(ctx);
    }
    if (ready < 0) {
        if (errno == EINTR) return JSValueMakeNull(ctx);
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
#if !defined(_WIN32)
    if ((poll_fd.revents & POLLNVAL) != 0) {
        ct_throw_message(ctx, exception, "invalid file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    if ((poll_fd.revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
        return JSValueMakeNull(ctx);
    }
#endif

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

static JSValueRef ct_fd_write_some(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.fdWriteSome(fd, data) requires a file descriptor and data");
        return JSValueMakeUndefined(ctx);
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
    if (fd < 0 || bytes == NULL) {
        free(text);
        ct_throw_message(ctx, exception, "invalid file descriptor or data");
        return JSValueMakeUndefined(ctx);
    }
    if (len == 0) {
        free(text);
        return JSValueMakeNumber(ctx, 0);
    }

    ssize_t written;
    do {
        written = write(fd, bytes, len);
    } while (written < 0 && errno == EINTR);
    free(text);
    if (written < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) return JSValueMakeNumber(ctx, 0);
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeNumber(ctx, (double)written);
}

static JSValueRef ct_ipc_send(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "cottontail.ipcSend(fd, data[, sendFd]) requires a socket fd and data");
        return JSValueMakeBoolean(ctx, false);
    }
#if defined(_WIN32)
    ct_throw_message(ctx, exception, "ipcSend is unavailable on this platform");
    return JSValueMakeBoolean(ctx, false);
#else
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    int send_fd = argc >= 3 && !JSValueIsUndefined(ctx, argv[2]) && !JSValueIsNull(ctx, argv[2])
        ? (int)ct_value_to_number(ctx, argv[2])
        : -1;
    uint8_t *bytes = NULL;
    size_t len = 0;
    char *text = NULL;
    if (ct_get_bytes(ctx, argv[1], &bytes, &len) != 0) {
        text = ct_value_to_string_copy(ctx, argv[1]);
        bytes = (uint8_t *)text;
        len = text != NULL ? strlen(text) : 0;
    }
    if (fd < 0 || bytes == NULL) {
        free(text);
        return JSValueMakeBoolean(ctx, false);
    }

    signal(SIGPIPE, SIG_IGN);
    char empty = 0;
    struct iovec iov;
    iov.iov_base = len > 0 ? (void *)bytes : (void *)&empty;
    iov.iov_len = len > 0 ? len : 1;
    struct msghdr msg;
    memset(&msg, 0, sizeof(msg));
    msg.msg_iov = &iov;
    msg.msg_iovlen = 1;

    char control[CMSG_SPACE(sizeof(int))];
    if (send_fd >= 0) {
        memset(control, 0, sizeof(control));
        msg.msg_control = control;
        msg.msg_controllen = sizeof(control);
        struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
        cmsg->cmsg_level = SOL_SOCKET;
        cmsg->cmsg_type = SCM_RIGHTS;
        cmsg->cmsg_len = CMSG_LEN(sizeof(int));
        memcpy(CMSG_DATA(cmsg), &send_fd, sizeof(int));
    }

    bool ok = false;
    for (;;) {
        ssize_t sent = sendmsg(fd, &msg, 0);
        if (sent >= 0) {
            ok = true;
            break;
        }
        if (errno == EINTR) continue;
        break;
    }
    free(text);
    return JSValueMakeBoolean(ctx, ok);
#endif
}

static JSValueRef ct_ipc_recv(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "cottontail.ipcRecv(fd[, maxBytes]) requires a socket fd");
        return JSValueMakeUndefined(ctx);
    }
#if defined(_WIN32)
    ct_throw_message(ctx, exception, "ipcRecv is unavailable on this platform");
    return JSValueMakeUndefined(ctx);
#else
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    size_t max_bytes = argc >= 2 ? (size_t)ct_value_to_number(ctx, argv[1]) : 65536;
    if (fd < 0) {
        ct_throw_message(ctx, exception, "invalid IPC file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    if (max_bytes == 0) max_bytes = 65536;
    if (max_bytes > 1024 * 1024) max_bytes = 1024 * 1024;

    struct pollfd poll_fd;
    poll_fd.fd = fd;
    poll_fd.events = POLLIN | POLLHUP | POLLERR;
    poll_fd.revents = 0;
    int ready = poll(&poll_fd, 1, 0);
    if (ready == 0) return JSValueMakeNull(ctx);
    if (ready < 0) {
        if (errno == EINTR) return JSValueMakeNull(ctx);
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    if ((poll_fd.revents & POLLNVAL) != 0) {
        JSObjectRef result = ct_make_object(ctx);
        ct_set_property(ctx, result, "data", ct_array_buffer_from_copy(ctx, "", 0, exception), exception);
        ct_set_property(ctx, result, "fd", JSValueMakeNull(ctx), exception);
        ct_set_property(ctx, result, "end", JSValueMakeBoolean(ctx, true), exception);
        return result;
    }

    char *buffer = (char *)malloc(max_bytes > 0 ? max_bytes : 1);
    if (buffer == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    char control[CMSG_SPACE(sizeof(int))];
    struct iovec iov;
    iov.iov_base = buffer;
    iov.iov_len = max_bytes;
    struct msghdr msg;
    memset(&msg, 0, sizeof(msg));
    memset(control, 0, sizeof(control));
    msg.msg_iov = &iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control;
    msg.msg_controllen = sizeof(control);

    ssize_t n;
    for (;;) {
        n = recvmsg(fd, &msg, 0);
        if (n >= 0 || errno != EINTR) break;
    }
    if (n < 0) {
        free(buffer);
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return JSValueMakeNull(ctx);
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "data", ct_array_buffer_from_copy(ctx, buffer, (size_t)n, exception), exception);
    free(buffer);
    int received_fd = -1;
    for (struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg); cmsg != NULL; cmsg = CMSG_NXTHDR(&msg, cmsg)) {
        if (cmsg->cmsg_level == SOL_SOCKET && cmsg->cmsg_type == SCM_RIGHTS && cmsg->cmsg_len >= CMSG_LEN(sizeof(int))) {
            memcpy(&received_fd, CMSG_DATA(cmsg), sizeof(int));
            break;
        }
    }
    if (received_fd >= 0) ct_set_property(ctx, result, "fd", JSValueMakeNumber(ctx, received_fd), exception);
    else ct_set_property(ctx, result, "fd", JSValueMakeNull(ctx), exception);
    ct_set_property(ctx, result, "end", JSValueMakeBoolean(ctx, n == 0), exception);
    return result;
#endif
}

static JSValueRef ct_access_sync_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "accessSync(path[, mode]) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    int mode = argc >= 2 ? (int)ct_value_to_number(ctx, argv[1]) : F_OK;
    if (path == NULL || access(path, mode) != 0) ct_throw_message(ctx, exception, strerror(errno));
    free(path);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_fd_read_at(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 4) {
        ct_throw_message(ctx, exception, "cottontail.fdReadAt(fd, buffer, offset, length[, position]) requires fd, buffer, offset, and length");
        return JSValueMakeNumber(ctx, 0);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    uint8_t *bytes = NULL;
    size_t bytes_len = 0;
    if (fd < 0 || ct_get_bytes(ctx, argv[1], &bytes, &bytes_len) != 0) {
        ct_throw_message(ctx, exception, "invalid fd or read buffer");
        return JSValueMakeNumber(ctx, 0);
    }
    size_t offset = (size_t)ct_value_to_number(ctx, argv[2]);
    size_t length = (size_t)ct_value_to_number(ctx, argv[3]);
    if (offset > bytes_len) offset = bytes_len;
    if (length > bytes_len - offset) length = bytes_len - offset;
    bool has_position = argc >= 5 && !JSValueIsUndefined(ctx, argv[4]) && !JSValueIsNull(ctx, argv[4]);
    ssize_t count;
    do {
        count = has_position
            ? pread(fd, bytes + offset, length, (off_t)ct_value_to_number(ctx, argv[4]))
            : read(fd, bytes + offset, length);
    } while (count < 0 && errno == EINTR);
    if (count < 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeNumber(ctx, 0);
    }
    return JSValueMakeNumber(ctx, (double)count);
}

static JSValueRef ct_fd_write_at(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 4) {
        ct_throw_message(ctx, exception, "cottontail.fdWriteAt(fd, data, offset, length[, position]) requires fd, data, offset, and length");
        return JSValueMakeNumber(ctx, 0);
    }
    int fd = (int)ct_value_to_number(ctx, argv[0]);
    uint8_t *bytes = NULL;
    size_t bytes_len = 0;
    char *text = NULL;
    if (ct_get_bytes(ctx, argv[1], &bytes, &bytes_len) != 0) {
        text = ct_value_to_string_copy(ctx, argv[1]);
        bytes = (uint8_t *)text;
        bytes_len = text != NULL ? strlen(text) : 0;
    }
    if (fd < 0 || bytes == NULL) {
        free(text);
        ct_throw_message(ctx, exception, "invalid fd or write data");
        return JSValueMakeNumber(ctx, 0);
    }
    size_t offset = (size_t)ct_value_to_number(ctx, argv[2]);
    size_t length = (size_t)ct_value_to_number(ctx, argv[3]);
    if (offset > bytes_len) offset = bytes_len;
    if (length > bytes_len - offset) length = bytes_len - offset;
    bool has_position = argc >= 5 && !JSValueIsUndefined(ctx, argv[4]) && !JSValueIsNull(ctx, argv[4]);
    size_t written_total = 0;
    while (written_total < length) {
        ssize_t count = has_position
            ? pwrite(fd, bytes + offset + written_total, length - written_total, (off_t)ct_value_to_number(ctx, argv[4]) + (off_t)written_total)
            : write(fd, bytes + offset + written_total, length - written_total);
        if (count < 0) {
            if (errno == EINTR) continue;
            free(text);
            ct_throw_message(ctx, exception, strerror(errno));
            return JSValueMakeNumber(ctx, (double)written_total);
        }
        if (count == 0) break;
        written_total += (size_t)count;
    }
    free(text);
    return JSValueMakeNumber(ctx, (double)written_total);
}

static JSValueRef ct_fstat_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "fstatSync(fd) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    struct stat stat_value;
    if (fstat((int)ct_value_to_number(ctx, argv[0]), &stat_value) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    JSObjectRef result = ct_make_object(ctx);
    ct_define_stat_fields(ctx, result, &stat_value, exception);
    return result;
}

static JSValueRef ct_fsync_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1 || fsync((int)ct_value_to_number(ctx, argv[0])) != 0) ct_throw_message(ctx, exception, strerror(errno));
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_fdatasync_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "fdatasyncSync(fd) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }
#if defined(__APPLE__) || defined(__MACH__)
    int status = fsync((int)ct_value_to_number(ctx, argv[0]));
#else
    int status = fdatasync((int)ct_value_to_number(ctx, argv[0]));
#endif
    if (status != 0) ct_throw_message(ctx, exception, strerror(errno));
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_ftruncate_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "ftruncateSync(fd[, len]) requires a file descriptor");
        return JSValueMakeUndefined(ctx);
    }
    off_t len = argc >= 2 ? (off_t)ct_value_to_number(ctx, argv[1]) : 0;
    if (ftruncate((int)ct_value_to_number(ctx, argv[0]), len) != 0) ct_throw_message(ctx, exception, strerror(errno));
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_fchmod_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2 || fchmod((int)ct_value_to_number(ctx, argv[0]), (mode_t)ct_value_to_number(ctx, argv[1])) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_fchown_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3 || fchown((int)ct_value_to_number(ctx, argv[0]), (uid_t)ct_value_to_number(ctx, argv[1]), (gid_t)ct_value_to_number(ctx, argv[2])) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
    }
    return JSValueMakeUndefined(ctx);
}

static void ct_timeval_from_seconds(double seconds, struct timeval *value) {
    time_t whole = (time_t)seconds;
    double fraction = seconds - (double)whole;
    if (fraction < 0) fraction = 0;
    value->tv_sec = whole;
    value->tv_usec = (suseconds_t)(fraction * 1000000.0);
}

static JSValueRef ct_futimes_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "futimesSync(fd, atime, mtime) requires fd, atime, and mtime");
        return JSValueMakeUndefined(ctx);
    }
    struct timeval times[2];
    ct_timeval_from_seconds(ct_value_to_number(ctx, argv[1]), &times[0]);
    ct_timeval_from_seconds(ct_value_to_number(ctx, argv[2]), &times[1]);
    if (futimes((int)ct_value_to_number(ctx, argv[0]), times) != 0) ct_throw_message(ctx, exception, strerror(errno));
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_truncate_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "truncateSync(path[, len]) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    off_t len = argc >= 2 ? (off_t)ct_value_to_number(ctx, argv[1]) : 0;
    if (path == NULL || truncate(path, len) != 0) ct_throw_message(ctx, exception, strerror(errno));
    free(path);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_utimes_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "utimesSync(path, atime, mtime[, follow]) requires path, atime, and mtime");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    struct timeval times[2];
    ct_timeval_from_seconds(ct_value_to_number(ctx, argv[1]), &times[0]);
    ct_timeval_from_seconds(ct_value_to_number(ctx, argv[2]), &times[1]);
    bool follow = argc < 4 || ct_value_to_bool(ctx, argv[3]);
    int status;
    if (follow) {
        status = utimes(path, times);
    } else {
#if defined(__APPLE__) || defined(__MACH__)
        status = lutimes(path, times);
#elif defined(AT_SYMLINK_NOFOLLOW)
        struct timespec ts[2];
        ts[0].tv_sec = times[0].tv_sec;
        ts[0].tv_nsec = times[0].tv_usec * 1000;
        ts[1].tv_sec = times[1].tv_sec;
        ts[1].tv_nsec = times[1].tv_usec * 1000;
        status = utimensat(AT_FDCWD, path, ts, AT_SYMLINK_NOFOLLOW);
#else
        errno = ENOSYS;
        status = -1;
#endif
    }
    if (path == NULL || status != 0) ct_throw_message(ctx, exception, strerror(errno));
    free(path);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_chown_native_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "chownSync(path, uid, gid[, follow]) requires path, uid, and gid");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    uid_t uid = (uid_t)ct_value_to_number(ctx, argv[1]);
    gid_t gid = (gid_t)ct_value_to_number(ctx, argv[2]);
    bool follow = argc < 4 || ct_value_to_bool(ctx, argv[3]);
    int status = follow ? chown(path, uid, gid) : lchown(path, uid, gid);
    if (path == NULL || status != 0) ct_throw_message(ctx, exception, strerror(errno));
    free(path);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_lchmod_sync(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "lchmodSync(path, mode) requires path and mode");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
#if defined(__APPLE__) || defined(__MACH__)
    int status = lchmod(path, (mode_t)ct_value_to_number(ctx, argv[1]));
#else
    errno = ENOSYS;
    int status = -1;
#endif
    if (path == NULL || status != 0) ct_throw_message(ctx, exception, strerror(errno));
    free(path);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_link_sync_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "linkSync(existingPath, newPath) requires existingPath and newPath");
        return JSValueMakeUndefined(ctx);
    }
    char *existing_path = ct_value_to_string_copy(ctx, argv[0]);
    char *new_path = ct_value_to_string_copy(ctx, argv[1]);
    if (existing_path == NULL || new_path == NULL || link(existing_path, new_path) != 0) ct_throw_message(ctx, exception, strerror(errno));
    free(existing_path);
    free(new_path);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_symlink_sync_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "symlinkSync(target, path) requires target and path");
        return JSValueMakeUndefined(ctx);
    }
    char *target = ct_value_to_string_copy(ctx, argv[0]);
    char *path = ct_value_to_string_copy(ctx, argv[1]);
    if (target == NULL || path == NULL || symlink(target, path) != 0) ct_throw_message(ctx, exception, strerror(errno));
    free(target);
    free(path);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_rename_sync_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "renameSync(oldPath, newPath) requires oldPath and newPath");
        return JSValueMakeUndefined(ctx);
    }
    char *old_path = ct_value_to_string_copy(ctx, argv[0]);
    char *new_path = ct_value_to_string_copy(ctx, argv[1]);
    if (old_path == NULL || new_path == NULL || rename(old_path, new_path) != 0) ct_throw_message(ctx, exception, strerror(errno));
    free(old_path);
    free(new_path);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_readlink_sync_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "readlinkSync(path) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    size_t capacity = 256;
    char *buffer = NULL;
    ssize_t count = -1;
    while (path != NULL) {
        char *next = (char *)realloc(buffer, capacity + 1);
        if (next == NULL) {
            free(buffer);
            free(path);
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        buffer = next;
        count = readlink(path, buffer, capacity);
        if (count < 0 || (size_t)count < capacity) break;
        capacity *= 2;
    }
    if (path == NULL || count < 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        free(buffer);
        free(path);
        return JSValueMakeUndefined(ctx);
    }
    buffer[count] = 0;
    JSValueRef result = ct_make_string_len(ctx, buffer, (size_t)count);
    free(buffer);
    free(path);
    return result;
}

static JSValueRef ct_realpath_sync_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "realpathSync(path) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    char *resolved = path != NULL ? realpath(path, NULL) : NULL;
    if (resolved == NULL) {
        ct_throw_message(ctx, exception, strerror(errno));
        free(path);
        return JSValueMakeUndefined(ctx);
    }
    JSValueRef result = ct_make_string(ctx, resolved);
    free(resolved);
    free(path);
    return result;
}

static JSValueRef ct_statfs_sync_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "statfsSync(path) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    JSObjectRef result = ct_make_object(ctx);
#if defined(__APPLE__) || defined(__MACH__)
    struct statfs value;
    if (path == NULL || statfs(path, &value) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        free(path);
        return JSValueMakeUndefined(ctx);
    }
    ct_set_property(ctx, result, "type", JSValueMakeNumber(ctx, (double)value.f_type), exception);
    ct_set_property(ctx, result, "bsize", JSValueMakeNumber(ctx, (double)value.f_bsize), exception);
    ct_set_property(ctx, result, "blocks", JSValueMakeNumber(ctx, (double)value.f_blocks), exception);
    ct_set_property(ctx, result, "bfree", JSValueMakeNumber(ctx, (double)value.f_bfree), exception);
    ct_set_property(ctx, result, "bavail", JSValueMakeNumber(ctx, (double)value.f_bavail), exception);
    ct_set_property(ctx, result, "files", JSValueMakeNumber(ctx, (double)value.f_files), exception);
    ct_set_property(ctx, result, "ffree", JSValueMakeNumber(ctx, (double)value.f_ffree), exception);
#elif defined(__linux__)
    struct statvfs value;
    if (path == NULL || statvfs(path, &value) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        free(path);
        return JSValueMakeUndefined(ctx);
    }
    ct_set_property(ctx, result, "type", JSValueMakeNumber(ctx, 0), exception);
    ct_set_property(ctx, result, "bsize", JSValueMakeNumber(ctx, (double)value.f_bsize), exception);
    ct_set_property(ctx, result, "blocks", JSValueMakeNumber(ctx, (double)value.f_blocks), exception);
    ct_set_property(ctx, result, "bfree", JSValueMakeNumber(ctx, (double)value.f_bfree), exception);
    ct_set_property(ctx, result, "bavail", JSValueMakeNumber(ctx, (double)value.f_bavail), exception);
    ct_set_property(ctx, result, "files", JSValueMakeNumber(ctx, (double)value.f_files), exception);
    ct_set_property(ctx, result, "ffree", JSValueMakeNumber(ctx, (double)value.f_ffree), exception);
#else
    ULARGE_INTEGER available;
    ULARGE_INTEGER total;
    ULARGE_INTEGER free_bytes;
    if (path == NULL || !GetDiskFreeSpaceExA(path, &available, &total, &free_bytes)) {
        ct_throw_message(ctx, exception, "GetDiskFreeSpaceEx failed");
        free(path);
        return JSValueMakeUndefined(ctx);
    }
    const double block_size = 4096.0;
    ct_set_property(ctx, result, "type", JSValueMakeNumber(ctx, 0), exception);
    ct_set_property(ctx, result, "bsize", JSValueMakeNumber(ctx, block_size), exception);
    ct_set_property(ctx, result, "blocks", JSValueMakeNumber(ctx, (double)total.QuadPart / block_size), exception);
    ct_set_property(ctx, result, "bfree", JSValueMakeNumber(ctx, (double)free_bytes.QuadPart / block_size), exception);
    ct_set_property(ctx, result, "bavail", JSValueMakeNumber(ctx, (double)available.QuadPart / block_size), exception);
    ct_set_property(ctx, result, "files", JSValueMakeNumber(ctx, 0), exception);
    ct_set_property(ctx, result, "ffree", JSValueMakeNumber(ctx, 0), exception);
#endif
    free(path);
    return result;
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
    char *unix_path = NULL;
    int port_value = 0;
    if (argc >= 1 && !JSValueIsUndefined(ctx, argv[0]) && !JSValueIsNull(ctx, argv[0])) {
        hostname_arg = ct_value_to_string_copy(ctx, argv[0]);
        if (hostname_arg != NULL) hostname = hostname_arg;
    }
    if (argc >= 2) port_value = (int)ct_value_to_number(ctx, argv[1]);
    if (argc >= 3 && !JSValueIsUndefined(ctx, argv[2]) && !JSValueIsNull(ctx, argv[2])) {
        unix_path = ct_value_to_string_copy(ctx, argv[2]);
        if (unix_path != NULL && unix_path[0] == 0) {
            free(unix_path);
            unix_path = NULL;
        }
    }

#if !defined(_WIN32)
    signal(SIGPIPE, SIG_IGN);
#endif
    int listen_fd = socket(unix_path != NULL ? AF_UNIX : AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        free(hostname_arg);
        free(unix_path);
        return JSValueMakeUndefined(ctx);
    }
    int yes = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    uint16_t bound_port = 0;
    if (unix_path != NULL) {
#if defined(_WIN32)
        close(listen_fd);
        free(hostname_arg);
        free(unix_path);
        ct_throw_message(ctx, exception, "Unix-domain HTTP listeners are unavailable on this platform");
        return JSValueMakeUndefined(ctx);
#else
        struct sockaddr_un addr;
        memset(&addr, 0, sizeof(addr));
        addr.sun_family = AF_UNIX;
        size_t path_len = strlen(unix_path);
        if (path_len == 0 || path_len >= sizeof(addr.sun_path)) {
            close(listen_fd);
            free(hostname_arg);
            free(unix_path);
            ct_throw_message(ctx, exception, "Unix socket path is too long");
            return JSValueMakeUndefined(ctx);
        }
        memcpy(addr.sun_path, unix_path, path_len + 1);
        unlink(unix_path);
        if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0 || listen(listen_fd, 128) != 0) {
            int bind_errno = errno;
            close(listen_fd);
            unlink(unix_path);
            free(hostname_arg);
            free(unix_path);
            ct_throw_message(ctx, exception, strerror(bind_errno));
            return JSValueMakeUndefined(ctx);
        }
#endif
    } else {
        struct sockaddr_in addr;
        memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_port = htons((uint16_t)port_value);
        if (strcmp(hostname, "0.0.0.0") == 0 || strcmp(hostname, "0") == 0) {
            addr.sin_addr.s_addr = htonl(INADDR_ANY);
        } else if (strcmp(hostname, "localhost") == 0) {
            addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
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
        if (getsockname(listen_fd, (struct sockaddr *)&addr, &addr_len) != 0 || listen(listen_fd, 128) != 0) {
            close(listen_fd);
            ct_throw_message(ctx, exception, strerror(errno));
            free(hostname_arg);
            return JSValueMakeUndefined(ctx);
        }
        bound_port = ntohs(addr.sin_port);
    }

    CtHttpServer *server = (CtHttpServer *)calloc(1, sizeof(CtHttpServer));
    if (server == NULL) {
        close(listen_fd);
        if (unix_path != NULL) unlink(unix_path);
        ct_throw_message(ctx, exception, "Out of memory");
        free(hostname_arg);
        free(unix_path);
        return JSValueMakeUndefined(ctx);
    }
    server->listen_fd = listen_fd;
    server->port = bound_port;
    server->hostname = unix_path == NULL ? ct_duplicate_string(hostname) : NULL;
    server->unix_path = unix_path;
    pthread_mutex_init(&server->mutex, NULL);
    pthread_cond_init(&server->clients_cond, NULL);

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
        if (server->unix_path != NULL) unlink(server->unix_path);
        free(server->unix_path);
        pthread_cond_destroy(&server->clients_cond);
        pthread_mutex_destroy(&server->mutex);
        free(server);
        free(hostname_arg);
        ct_throw_message(ctx, exception, "pthread_create failed");
        return JSValueMakeUndefined(ctx);
    }

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, server->id), exception);
    if (server->unix_path != NULL) {
        ct_set_property(ctx, result, "address", ct_make_string(ctx, server->unix_path), exception);
    } else {
        ct_set_property(ctx, result, "port", JSValueMakeNumber(ctx, server->port), exception);
        ct_set_property(ctx, result, "hostname", ct_make_string(ctx, server->hostname), exception);
    }
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
    while (request != NULL && (!request->ready || request->claimed)) request = request->next;
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

static CtHttpRequest *ct_http_server_lock_request(uint32_t server_id, uint32_t request_id, const char **error_message) {
    *error_message = NULL;

    pthread_mutex_lock(&ct_http_servers_mutex);
    CtHttpServer *server = ct_http_find_server(server_id);
    if (server != NULL) pthread_mutex_lock(&server->mutex);
    pthread_mutex_unlock(&ct_http_servers_mutex);
    if (server == NULL) {
        *error_message = "HTTP server not found";
        return NULL;
    }
    if (server->stopped) {
        pthread_mutex_unlock(&server->mutex);
        *error_message = "HTTP server is stopped";
        return NULL;
    }

    CtHttpRequest *request = server->requests;
    while (request != NULL && request->id != request_id) request = request->next;
    if (request == NULL) {
        pthread_mutex_unlock(&server->mutex);
        *error_message = "HTTP request not found";
        return NULL;
    }

    pthread_mutex_lock(&request->mutex);
    if (request->completed) {
        pthread_mutex_unlock(&request->mutex);
        pthread_mutex_unlock(&server->mutex);
        *error_message = "HTTP response is already complete";
        return NULL;
    }
    pthread_mutex_unlock(&server->mutex);
    return request;
}

static void ct_http_complete_failed_stream(CtHttpRequest *request) {
    request->keep_alive = false;
    request->completed = true;
    pthread_cond_signal(&request->cond);
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

    const char *lookup_error = NULL;
    CtHttpRequest *request = ct_http_server_lock_request(server_id, request_id, &lookup_error);
    if (request == NULL) {
        free(headers_text);
        free(body_copy);
        ct_throw_message(ctx, exception, lookup_error);
        return JSValueMakeUndefined(ctx);
    }

    if (request->response_started) {
        pthread_mutex_unlock(&request->mutex);
        free(headers_text);
        free(body_copy);
        ct_throw_message(ctx, exception, "HTTP response has already started");
        return JSValueMakeUndefined(ctx);
    }

    request->status = status;
    request->response_headers_text = headers_text;
    request->response_body = body_copy;
    request->response_body_len = body_len;
    request->response_started = true;
    request->completed = true;
    pthread_cond_signal(&request->cond);
    pthread_mutex_unlock(&request->mutex);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_http_server_response_start(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 4) {
        ct_throw_message(ctx, exception, "httpServerResponseStart requires server id, request id, status, and headers");
        return JSValueMakeUndefined(ctx);
    }

    uint32_t server_id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    uint32_t request_id = (uint32_t)ct_value_to_number(ctx, argv[1]);
    int status = (int)ct_value_to_number(ctx, argv[2]);
    char *headers_text = ct_value_to_string_copy(ctx, argv[3]);
    if (headers_text == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    const char *lookup_error = NULL;
    CtHttpRequest *request = ct_http_server_lock_request(server_id, request_id, &lookup_error);
    if (request == NULL) {
        free(headers_text);
        ct_throw_message(ctx, exception, lookup_error);
        return JSValueMakeUndefined(ctx);
    }
    if (request->response_started) {
        pthread_mutex_unlock(&request->mutex);
        free(headers_text);
        ct_throw_message(ctx, exception, "HTTP response has already started");
        return JSValueMakeUndefined(ctx);
    }

    request->status = status;
    request->response_headers_text = headers_text;
    request->response_started = true;
    request->response_streaming = true;
    if (ct_http_send_chunked_response_head(request) < 0) {
        ct_http_complete_failed_stream(request);
        pthread_mutex_unlock(&request->mutex);
        ct_throw_message(ctx, exception, "Failed to start HTTP response stream");
        return JSValueMakeUndefined(ctx);
    }
    pthread_mutex_unlock(&request->mutex);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_http_server_response_write(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "httpServerResponseWrite requires server id, request id, and body chunk");
        return JSValueMakeUndefined(ctx);
    }

    uint32_t server_id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    uint32_t request_id = (uint32_t)ct_value_to_number(ctx, argv[1]);
    uint8_t *chunk_data = NULL;
    size_t chunk_len = 0;
    if (ct_get_bytes(ctx, argv[2], &chunk_data, &chunk_len) != 0) {
        ct_throw_message(ctx, exception, "HTTP response chunk must be ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }

    const char *lookup_error = NULL;
    CtHttpRequest *request = ct_http_server_lock_request(server_id, request_id, &lookup_error);
    if (request == NULL) {
        ct_throw_message(ctx, exception, lookup_error);
        return JSValueMakeUndefined(ctx);
    }
    if (!request->response_started || !request->response_streaming) {
        pthread_mutex_unlock(&request->mutex);
        ct_throw_message(ctx, exception, "HTTP response stream has not started");
        return JSValueMakeUndefined(ctx);
    }

    if (ct_http_send_chunk(request, chunk_data, chunk_len) < 0) {
        ct_http_complete_failed_stream(request);
        pthread_mutex_unlock(&request->mutex);
        ct_throw_message(ctx, exception, "Failed to write HTTP response stream");
        return JSValueMakeUndefined(ctx);
    }
    pthread_mutex_unlock(&request->mutex);
    return JSValueMakeNumber(ctx, (double)chunk_len);
}

static JSValueRef ct_http_server_response_end(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "httpServerResponseEnd requires server id and request id");
        return JSValueMakeUndefined(ctx);
    }

    uint32_t server_id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    uint32_t request_id = (uint32_t)ct_value_to_number(ctx, argv[1]);
    const char *lookup_error = NULL;
    CtHttpRequest *request = ct_http_server_lock_request(server_id, request_id, &lookup_error);
    if (request == NULL) {
        ct_throw_message(ctx, exception, lookup_error);
        return JSValueMakeUndefined(ctx);
    }
    if (!request->response_started || !request->response_streaming) {
        pthread_mutex_unlock(&request->mutex);
        ct_throw_message(ctx, exception, "HTTP response stream has not started");
        return JSValueMakeUndefined(ctx);
    }

    if (ct_http_send_all(request->client_fd, "0\r\n\r\n", 5) < 0) {
        ct_http_complete_failed_stream(request);
        pthread_mutex_unlock(&request->mutex);
        ct_throw_message(ctx, exception, "Failed to end HTTP response stream");
        return JSValueMakeUndefined(ctx);
    }
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
            shutdown(request->client_fd, SHUT_RDWR);
            pthread_mutex_lock(&request->mutex);
            request->completed = true;
            pthread_cond_signal(&request->cond);
            pthread_mutex_unlock(&request->mutex);
            request = request->next;
        }
    }
    pthread_mutex_unlock(&server->mutex);
    pthread_join(server->thread, NULL);

    pthread_mutex_lock(&server->mutex);
    while (server->active_clients > 0) pthread_cond_wait(&server->clients_cond, &server->mutex);
    pthread_mutex_unlock(&server->mutex);

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
    if (server->unix_path != NULL) unlink(server->unix_path);
    free(server->unix_path);
    pthread_cond_destroy(&server->clients_cond);
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

static JSValueRef ct_strip_typescript_types_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "stripTypeScriptTypes(source[, mode]) requires source");
        return JSValueMakeUndefined(ctx);
    }

    size_t source_len = 0;
    char *source = ct_value_to_utf8_copy(ctx, argv[0], &source_len);
    if (source == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    int mode = argc >= 2 ? (int)ct_value_to_number(ctx, argv[1]) : 0;
    size_t output_len = 0;
    char *error = NULL;
    uint8_t *output = ct_strip_typescript_types((const uint8_t *)source, source_len, mode, &output_len, &error);
    free(source);

    if (output == NULL) {
        ct_throw_message(ctx, exception, error != NULL ? error : "TypeScript transform failed");
        if (error != NULL) ct_transpiler_string_free(error);
        return JSValueMakeUndefined(ctx);
    }

    JSValueRef result = ct_make_string_len(ctx, (const char *)output, output_len);
    ct_transpiler_free(output, output_len);
    return result;
}

static JSValueRef ct_transpiler_process_native(JSContextRef ctx, size_t argc, const JSValueRef argv[], JSValueRef *exception, int operation) {
    if (argc < 1) {
        ct_throw_message(ctx, exception, "transpiler operation requires source");
        return JSValueMakeUndefined(ctx);
    }

    size_t source_len = 0;
    char *source = ct_value_to_utf8_copy(ctx, argv[0], &source_len);
    if (source == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    size_t options_len = 0;
    char *options = argc >= 2 ? ct_value_to_utf8_copy(ctx, argv[1], &options_len) : NULL;
    size_t loader_len = 0;
    char *loader = argc >= 3 ? ct_value_to_utf8_copy(ctx, argv[2], &loader_len) : NULL;
    if ((argc >= 2 && options == NULL) || (argc >= 3 && loader == NULL)) {
        free(source);
        free(options);
        free(loader);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    size_t output_len = 0;
    char *error = NULL;
    uint8_t *output = ct_transpiler_process(
        operation,
        (const uint8_t *)source,
        source_len,
        (const uint8_t *)options,
        options_len,
        (const uint8_t *)loader,
        loader_len,
        &output_len,
        &error
    );
    free(source);
    free(options);
    free(loader);

    if (output == NULL) {
        ct_throw_message(ctx, exception, error != NULL ? error : "JavaScript transform failed");
        if (error != NULL) ct_transpiler_string_free(error);
        return JSValueMakeUndefined(ctx);
    }

    JSValueRef result = ct_make_string_len(ctx, (const char *)output, output_len);
    ct_transpiler_free(output, output_len);
    return result;
}

static JSValueRef ct_transpiler_transform_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    return ct_transpiler_process_native(ctx, argc, argv, exception, 0);
}

static JSValueRef ct_transpiler_scan_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    return ct_transpiler_process_native(ctx, argc, argv, exception, 1);
}

static JSValueRef ct_transpiler_scan_imports_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    return ct_transpiler_process_native(ctx, argc, argv, exception, 2);
}

static JSValueRef ct_bundle_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "bundleNative(entrypoint, workingDirectory[, options]) requires two arguments");
        return JSValueMakeUndefined(ctx);
    }

    size_t entry_len = 0;
    size_t working_dir_len = 0;
    size_t options_len = 0;
    char *entry = ct_value_to_utf8_copy(ctx, argv[0], &entry_len);
    char *working_dir = ct_value_to_utf8_copy(ctx, argv[1], &working_dir_len);
    char *options = argc >= 3 ? ct_value_to_utf8_copy(ctx, argv[2], &options_len) : NULL;
    if (entry == NULL || working_dir == NULL || (argc >= 3 && options == NULL)) {
        free(entry);
        free(working_dir);
        free(options);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    size_t output_len = 0;
    char *error = NULL;
    uint8_t *output = ct_bundle_entry_point_options(
        (const uint8_t *)entry,
        entry_len,
        (const uint8_t *)working_dir,
        working_dir_len,
        (const uint8_t *)options,
        options_len,
        &output_len,
        &error
    );
    free(entry);
    free(working_dir);
    free(options);
    if (output == NULL) {
        ct_throw_message(ctx, exception, error != NULL ? error : "JavaScript bundle failed");
        if (error != NULL) ct_bundle_string_free(error);
        return JSValueMakeUndefined(ctx);
    }
    JSValueRef result = ct_make_string_len(ctx, (const char *)output, output_len);
    ct_bundle_free(output, output_len);
    return result;
}

static JSValueRef ct_markdown_html_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "markdownHtml(source[, flags]) requires source");
        return JSValueMakeUndefined(ctx);
    }

    size_t source_len = 0;
    char *source = ct_value_to_utf8_copy(ctx, argv[0], &source_len);
    if (source == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    uint64_t flags = argc >= 2 ? (uint64_t)ct_value_to_number(ctx, argv[1]) : 0;
    size_t output_len = 0;
    char *error = NULL;
    uint8_t *output = ct_markdown_render_html((const uint8_t *)source, source_len, flags, &output_len, &error);
    free(source);

    if (output == NULL) {
        ct_throw_message(ctx, exception, error != NULL ? error : "Markdown rendering failed");
        if (error != NULL) ct_markdown_string_free(error);
        return JSValueMakeUndefined(ctx);
    }

    JSValueRef result = ct_make_string_len(ctx, (const char *)output, output_len);
    ct_markdown_free(output, output_len);
    return result;
}

static JSValueRef ct_markdown_events_native(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "markdownEvents(source[, flags]) requires source");
        return JSValueMakeUndefined(ctx);
    }

    size_t source_len = 0;
    char *source = ct_value_to_utf8_copy(ctx, argv[0], &source_len);
    if (source == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    uint64_t flags = argc >= 2 ? (uint64_t)ct_value_to_number(ctx, argv[1]) : 0;
    size_t output_len = 0;
    char *error = NULL;
    uint8_t *output = ct_markdown_parse_events((const uint8_t *)source, source_len, flags, &output_len, &error);
    free(source);

    if (output == NULL) {
        ct_throw_message(ctx, exception, error != NULL ? error : "Markdown parsing failed");
        if (error != NULL) ct_markdown_string_free(error);
        return JSValueMakeUndefined(ctx);
    }

    JSValueRef result = ct_make_string_len(ctx, (const char *)output, output_len);
    ct_markdown_free(output, output_len);
    return result;
}

static JSValueRef ct_exit(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)thisObject;
    (void)exception;
    CtJscRuntime *runtime = (CtJscRuntime *)JSObjectGetPrivate(function);
    if (runtime != NULL && runtime->worker != NULL) {
        pthread_mutex_lock(&runtime->worker->mutex);
        runtime->worker->terminated = true;
        pthread_mutex_unlock(&runtime->worker->mutex);
        return JSValueMakeUndefined(ctx);
    }
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
    ct_install_function(ctx, host, "gc", ct_gc, runtime);
    ct_install_function(ctx, host, "jscMemoryUsage", ct_jsc_memory_usage, runtime);
    ct_install_function(ctx, host, "importModule", ct_import_module, runtime);
    ct_install_function(ctx, host, "cwd", ct_cwd, runtime);
    ct_install_function(ctx, host, "readFile", ct_read_file, runtime);
    ct_install_function(ctx, host, "readFileBuffer", ct_read_file_buffer, runtime);
    ct_install_function(ctx, host, "mmapFile", ct_mmap_file_native, runtime);
    ct_install_function(ctx, host, "writeFile", ct_write_file, runtime);
    ct_install_function(ctx, host, "openFd", ct_open_fd, runtime);
    ct_install_function(ctx, host, "readFd", ct_read_fd, runtime);
    ct_install_function(ctx, host, "closeFd", ct_close_fd, runtime);
    ct_install_function(ctx, host, "fdWrite", ct_fd_write, runtime);
    ct_install_function(ctx, host, "fdWriteSome", ct_fd_write_some, runtime);
    ct_install_function(ctx, host, "ipcSend", ct_ipc_send, runtime);
    ct_install_function(ctx, host, "ipcRecv", ct_ipc_recv, runtime);
    ct_install_function(ctx, host, "accessSync", ct_access_sync_native, runtime);
    ct_install_function(ctx, host, "fdReadAt", ct_fd_read_at, runtime);
    ct_install_function(ctx, host, "fdWriteAt", ct_fd_write_at, runtime);
    ct_install_function(ctx, host, "fstatSync", ct_fstat_sync, runtime);
    ct_install_function(ctx, host, "fsyncSync", ct_fsync_sync, runtime);
    ct_install_function(ctx, host, "fdatasyncSync", ct_fdatasync_sync, runtime);
    ct_install_function(ctx, host, "ftruncateSync", ct_ftruncate_sync, runtime);
    ct_install_function(ctx, host, "fchmodSync", ct_fchmod_sync, runtime);
    ct_install_function(ctx, host, "fchownSync", ct_fchown_sync, runtime);
    ct_install_function(ctx, host, "futimesSync", ct_futimes_sync, runtime);
    ct_install_function(ctx, host, "truncateSync", ct_truncate_sync, runtime);
    ct_install_function(ctx, host, "utimesSync", ct_utimes_sync, runtime);
    ct_install_function(ctx, host, "chownSync", ct_chown_native_sync, runtime);
    ct_install_function(ctx, host, "lchmodSync", ct_lchmod_sync, runtime);
    ct_install_function(ctx, host, "linkSync", ct_link_sync_native, runtime);
    ct_install_function(ctx, host, "symlinkSync", ct_symlink_sync_native, runtime);
    ct_install_function(ctx, host, "renameSync", ct_rename_sync_native, runtime);
    ct_install_function(ctx, host, "readlinkSync", ct_readlink_sync_native, runtime);
    ct_install_function(ctx, host, "realpathSync", ct_realpath_sync_native, runtime);
    ct_install_function(ctx, host, "statfsSync", ct_statfs_sync_native, runtime);
    ct_install_function(ctx, host, "fdWatchStart", ct_fd_watch_start, runtime);
    ct_install_function(ctx, host, "fdWatchStop", ct_fd_watch_stop, runtime);
    ct_install_function(ctx, host, "fdSetEventHandler", ct_fd_set_event_handler, runtime);
    ct_install_function(ctx, host, "env", ct_env, runtime);
    ct_install_function(ctx, host, "existsSync", ct_exists_sync, runtime);
    ct_install_function(ctx, host, "statSync", ct_stat_sync, runtime);
    ct_install_function(ctx, host, "readDirSync", ct_read_dir_sync, runtime);
    ct_install_function(ctx, host, "mkdirSync", ct_mkdir_sync, runtime);
    ct_install_function(ctx, host, "rmSync", ct_rm_sync, runtime);
    ct_install_function(ctx, host, "rmdirSync", ct_rmdir_sync, runtime);
    ct_install_function(ctx, host, "unlinkSync", ct_unlink_sync, runtime);
    ct_install_function(ctx, host, "chmodSync", ct_chmod_sync, runtime);
    ct_install_function(ctx, host, "spawnSync", ct_spawn_sync, runtime);
    ct_install_function(ctx, host, "processExecve", ct_process_execve, runtime);
    ct_install_function(ctx, host, "spawnStart", ct_spawn_start, runtime);
    ct_install_function(ctx, host, "spawnWrite", ct_spawn_write, runtime);
    ct_install_function(ctx, host, "spawnCloseStdin", ct_spawn_close_stdin, runtime);
    ct_install_function(ctx, host, "spawnCloseIpc", ct_spawn_close_ipc, runtime);
    ct_install_function(ctx, host, "spawnKill", ct_spawn_kill, runtime);
    ct_install_function(ctx, host, "spawnDispose", ct_undefined, runtime);
    ct_install_function(ctx, host, "spawnSetEventHandler", ct_spawn_set_event_handler, runtime);
    ct_install_function(ctx, host, "spawnDetached", ct_spawn_detached, runtime);
    ct_install_function(ctx, host, "httpServerStart", ct_http_server_start, runtime);
    ct_install_function(ctx, host, "httpServerPoll", ct_http_server_poll, runtime);
    ct_install_function(ctx, host, "httpServerRespond", ct_http_server_respond, runtime);
    ct_install_function(ctx, host, "httpServerResponseStart", ct_http_server_response_start, runtime);
    ct_install_function(ctx, host, "httpServerResponseWrite", ct_http_server_response_write, runtime);
    ct_install_function(ctx, host, "httpServerResponseEnd", ct_http_server_response_end, runtime);
    ct_install_function(ctx, host, "httpServerStop", ct_http_server_stop, runtime);
    ct_install_function(ctx, host, "stripTypeScriptTypes", ct_strip_typescript_types_native, runtime);
    ct_install_function(ctx, host, "transpilerTransform", ct_transpiler_transform_native, runtime);
    ct_install_function(ctx, host, "transpilerScan", ct_transpiler_scan_native, runtime);
    ct_install_function(ctx, host, "transpilerScanImports", ct_transpiler_scan_imports_native, runtime);
    ct_install_function(ctx, host, "bundleNative", ct_bundle_native, runtime);
    ct_install_function(ctx, host, "markdownHtml", ct_markdown_html_native, runtime);
    ct_install_function(ctx, host, "markdownEvents", ct_markdown_events_native, runtime);
    ct_install_function(ctx, host, "memoryAddress", ct_memory_address, runtime);
    ct_install_function(ctx, host, "memoryView", ct_memory_view, runtime);
    ct_install_function(ctx, host, "sharedArrayBufferCreate", ct_shared_array_buffer_create, runtime);
    ct_install_function(ctx, host, "sharedArrayBufferWrap", ct_shared_array_buffer_wrap, runtime);
    ct_install_function(ctx, host, "sharedArrayBufferInfo", ct_shared_array_buffer_info, runtime);
    ct_install_function(ctx, host, "sharedAtomicOp", ct_shared_atomic_op, runtime);
    ct_install_function(ctx, host, "sharedAtomicWait", ct_shared_atomic_wait, runtime);
    ct_install_function(ctx, host, "sharedAtomicNotify", ct_shared_atomic_notify, runtime);
    ct_install_function(ctx, host, "nativeCall", ct_native_call, runtime);
    ct_install_function(ctx, host, "nativeSymbol", ct_native_symbol, runtime);
    ct_install_function(ctx, host, "nativeCallPointer", ct_native_call_pointer, runtime);
    ct_install_function(ctx, host, "createCallback", ct_create_callback, runtime);
    ct_install_function(ctx, host, "closeCallback", ct_close_callback, runtime);
    ct_install_function(ctx, host, "spawnWorker", ct_worker_spawn, runtime);
    ct_install_function(ctx, host, "isWorker", ct_is_worker, runtime);
    ct_install_function(ctx, host, "workerThreadId", ct_worker_thread_id, runtime);
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
    ct_install_function(ctx, host, "processInfo", ct_process_info, runtime);
    ct_install_function(ctx, host, "osNetworkInterfaces", ct_os_network_interfaces, runtime);
    ct_install_function(ctx, host, "osGetPriority", ct_os_get_priority, runtime);
    ct_install_function(ctx, host, "osSetPriority", ct_os_set_priority, runtime);
    ct_install_function(ctx, host, "randomBytes", ct_random_bytes, runtime);
    ct_install_function(ctx, host, "zlibTransformSync", ct_zlib_transform_sync, runtime);
    ct_install_function(ctx, host, "cryptoHashSync", ct_crypto_hash_sync, runtime);
    ct_install_function(ctx, host, "cryptoHmacSync", ct_crypto_hmac_sync, runtime);
    ct_install_function(ctx, host, "cryptoArgon2Sync", ct_crypto_argon2_sync, runtime);
    ct_install_function(ctx, host, "passwordHashSync", ct_password_hash_sync_native, runtime);
    ct_install_function(ctx, host, "passwordVerifySync", ct_password_verify_sync_native, runtime);
    ct_install_function(ctx, host, "hashValue", ct_hash_value_native, runtime);
    ct_install_function(ctx, host, "cryptoEd25519GenerateKeyPair", ct_crypto_ed25519_generate_key_pair, runtime);
    ct_install_function(ctx, host, "cryptoEd25519PublicFromPrivate", ct_crypto_ed25519_public_from_private, runtime);
    ct_install_function(ctx, host, "cryptoEd25519Sign", ct_crypto_ed25519_sign, runtime);
    ct_install_function(ctx, host, "cryptoEd25519Verify", ct_crypto_ed25519_verify, runtime);
    ct_install_function(ctx, host, "cryptoRawKeyGenerateKeyPair", ct_crypto_raw_key_generate_key_pair, runtime);
    ct_install_function(ctx, host, "cryptoRawPublicFromPrivate", ct_crypto_raw_public_from_private, runtime);
    ct_install_function(ctx, host, "cryptoRawSign", ct_crypto_raw_sign, runtime);
    ct_install_function(ctx, host, "cryptoRawVerify", ct_crypto_raw_verify, runtime);
    ct_install_function(ctx, host, "cryptoRawDiffieHellman", ct_crypto_raw_diffie_hellman, runtime);
    ct_install_function(ctx, host, "cryptoEcGenerateKeyPair", ct_crypto_ec_generate_key_pair, runtime);
    ct_install_function(ctx, host, "cryptoEcPublicFromPrivate", ct_crypto_ec_public_from_private, runtime);
    ct_install_function(ctx, host, "cryptoEcSign", ct_crypto_ec_sign, runtime);
    ct_install_function(ctx, host, "cryptoEcVerify", ct_crypto_ec_verify, runtime);
    ct_install_function(ctx, host, "cryptoEcDiffieHellman", ct_crypto_ec_diffie_hellman, runtime);
    ct_install_function(ctx, host, "cryptoImportKey", ct_crypto_import_key, runtime);
    ct_install_function(ctx, host, "cryptoRsaExportKey", ct_crypto_rsa_export_key, runtime);
    ct_install_function(ctx, host, "cryptoEcExportKey", ct_crypto_ec_export_key, runtime);
    ct_install_function(ctx, host, "cryptoRawExportKey", ct_crypto_raw_export_key, runtime);
    ct_install_function(ctx, host, "cryptoSpkacVerify", ct_crypto_spkac_verify, runtime);
    ct_install_function(ctx, host, "cryptoSpkacExportPublicKey", ct_crypto_spkac_export_public_key, runtime);
    ct_install_function(ctx, host, "cryptoRsaSign", ct_crypto_rsa_sign, runtime);
    ct_install_function(ctx, host, "cryptoRsaVerify", ct_crypto_rsa_verify, runtime);
    ct_install_function(ctx, host, "cryptoCipherInfo", ct_crypto_cipher_info, runtime);
    ct_install_function(ctx, host, "cryptoGetCiphers", ct_crypto_get_ciphers, runtime);
    ct_install_function(ctx, host, "cryptoCipherCreate", ct_crypto_cipher_create, runtime);
    ct_install_function(ctx, host, "cryptoCipherUpdate", ct_crypto_cipher_update, runtime);
    ct_install_function(ctx, host, "cryptoCipherFinal", ct_crypto_cipher_final, runtime);
    ct_install_function(ctx, host, "cryptoCipherSetAAD", ct_crypto_cipher_set_aad, runtime);
    ct_install_function(ctx, host, "cryptoCipherSetAuthTag", ct_crypto_cipher_set_auth_tag, runtime);
    ct_install_function(ctx, host, "cryptoCipherGetAuthTag", ct_crypto_cipher_get_auth_tag, runtime);
    ct_install_function(ctx, host, "dnsLookup", ct_dns_lookup, runtime);
    ct_install_function(ctx, host, "dnsLookupService", ct_dns_lookup_service, runtime);
    ct_install_function(ctx, host, "dnsResolveRecords", ct_dns_resolve_records, runtime);
    ct_install_function(ctx, host, "udpSocketCreate", ct_udp_socket_create, runtime);
    ct_install_function(ctx, host, "udpSocketBind", ct_udp_socket_bind, runtime);
    ct_install_function(ctx, host, "udpSocketAddress", ct_udp_socket_address, runtime);
    ct_install_function(ctx, host, "udpSocketSend", ct_udp_socket_send, runtime);
    ct_install_function(ctx, host, "udpSocketConnect", ct_udp_socket_connect, runtime);
    ct_install_function(ctx, host, "udpSocketReceive", ct_udp_socket_receive, runtime);
    ct_install_function(ctx, host, "udpSocketClose", ct_udp_socket_close, runtime);
    ct_install_function(ctx, host, "udpSocketSetBroadcast", ct_udp_socket_set_broadcast, runtime);
    ct_install_function(ctx, host, "udpSocketSetTTL", ct_udp_socket_set_ttl, runtime);
    ct_install_function(ctx, host, "udpSocketSetMulticastTTL", ct_udp_socket_set_multicast_ttl, runtime);
    ct_install_function(ctx, host, "udpSocketSetMulticastLoopback", ct_udp_socket_set_multicast_loopback, runtime);
    ct_install_function(ctx, host, "udpSocketSetBufferSize", ct_udp_socket_set_buffer_size, runtime);
    ct_install_function(ctx, host, "udpSocketGetBufferSize", ct_udp_socket_get_buffer_size, runtime);
    ct_install_function(ctx, host, "udpSocketMembership", ct_udp_socket_membership, runtime);
    ct_install_function(ctx, host, "tcpServerListen", ct_tcp_server_listen, runtime);
    ct_install_function(ctx, host, "tcpServerAccept", ct_tcp_server_accept, runtime);
    ct_install_function(ctx, host, "tcpSocketConnect", ct_tcp_socket_connect, runtime);
    ct_install_function(ctx, host, "tcpSocketAddress", ct_tcp_socket_address, runtime);
    ct_install_function(ctx, host, "socketPair", ct_socket_pair, runtime);
    ct_install_function(ctx, host, "tcpSocketSetNoDelay", ct_tcp_socket_set_no_delay, runtime);
    ct_install_function(ctx, host, "tcpSocketSetKeepAlive", ct_tcp_socket_set_keep_alive, runtime);
    ct_install_function(ctx, host, "tcpSocketShutdown", ct_tcp_socket_shutdown, runtime);
    ct_install_function(ctx, host, "unixServerListen", ct_unix_server_listen, runtime);
    ct_install_function(ctx, host, "unixServerAccept", ct_unix_server_accept, runtime);
    ct_install_function(ctx, host, "unixSocketConnect", ct_unix_socket_connect, runtime);
    ct_install_function(ctx, host, "tlsClientConnect", ct_tls_client_connect, runtime);
    ct_install_function(ctx, host, "tlsServerListen", ct_tls_server_listen, runtime);
    ct_install_function(ctx, host, "tlsServerAccept", ct_tls_server_accept, runtime);
    ct_install_function(ctx, host, "tlsServerClose", ct_tls_server_close, runtime);
    ct_install_function(ctx, host, "tlsConnectionReadStart", ct_tls_connection_read_start, runtime);
    ct_install_function(ctx, host, "tlsConnectionWrite", ct_tls_connection_write, runtime);
    ct_install_function(ctx, host, "tlsConnectionShutdown", ct_tls_connection_shutdown, runtime);
    ct_install_function(ctx, host, "tlsConnectionClose", ct_tls_connection_close, runtime);
    ct_install_function(ctx, host, "tlsConnectionInfo", ct_tls_connection_info, runtime);
    ct_install_function(ctx, host, "sqliteOpen", ct_sqlite_open, runtime);
    ct_install_function(ctx, host, "sqliteClose", ct_sqlite_close, runtime);
    ct_install_function(ctx, host, "sqliteExec", ct_sqlite_exec, runtime);
    ct_install_function(ctx, host, "sqlitePrepare", ct_sqlite_prepare, runtime);
    ct_install_function(ctx, host, "sqliteStatementFinalize", ct_sqlite_statement_finalize, runtime);
    ct_install_function(ctx, host, "sqliteStatementAll", ct_sqlite_statement_all, runtime);
    ct_install_function(ctx, host, "sqliteStatementGet", ct_sqlite_statement_get, runtime);
    ct_install_function(ctx, host, "sqliteStatementValues", ct_sqlite_statement_values, runtime);
    ct_install_function(ctx, host, "sqliteStatementRun", ct_sqlite_statement_run, runtime);
    ct_install_function(ctx, host, "sqliteStatementColumns", ct_sqlite_statement_columns, runtime);
    ct_install_function(ctx, host, "sqliteStatementExpandedSql", ct_sqlite_statement_expanded_sql, runtime);
    ct_install_function(ctx, host, "sqliteStatementParameterNames", ct_sqlite_statement_parameter_names, runtime);
    ct_install_function(ctx, host, "sqliteStatementColumnTypes", ct_sqlite_statement_column_types, runtime);
    ct_install_function(ctx, host, "sqliteInTransaction", ct_sqlite_in_transaction, runtime);
    ct_install_function(ctx, host, "sqliteCreateFunction", ct_sqlite_create_function, runtime);
    ct_install_function(ctx, host, "sqliteCreateAggregate", ct_sqlite_create_aggregate, runtime);
    ct_install_function(ctx, host, "sqliteSetAuthorizer", ct_sqlite_set_authorizer, runtime);
    ct_install_function(ctx, host, "sqliteEnableLoadExtension", ct_sqlite_enable_load_extension, runtime);
    ct_install_function(ctx, host, "sqliteLoadExtension", ct_sqlite_load_extension, runtime);
    ct_install_function(ctx, host, "sqliteBackup", ct_sqlite_backup, runtime);
    ct_install_function(ctx, host, "sqliteSerialize", ct_sqlite_serialize, runtime);
    ct_install_function(ctx, host, "sqliteFileControl", ct_sqlite_file_control, runtime);
    ct_install_function(ctx, host, "sqliteSessionCreate", ct_sqlite_session_create, runtime);
    ct_install_function(ctx, host, "sqliteSessionChangeset", ct_sqlite_session_changeset, runtime);
    ct_install_function(ctx, host, "sqliteSessionClose", ct_sqlite_session_close, runtime);
    ct_install_function(ctx, host, "sqliteApplyChangeset", ct_sqlite_apply_changeset, runtime);
    ct_install_function(ctx, host, "platform", ct_platform, runtime);
    ct_install_function(ctx, host, "arch", ct_arch, runtime);
    ct_install_function(ctx, host, "hostname", ct_hostname, runtime);
    JSObjectRef args = ct_make_array(ctx, 0, NULL, &exception);
    ct_set_property(ctx, host, "args", args, &exception);
#if defined(COTTONTAIL_VENDORED_JSC)
    ct_set_property(ctx, host, "jscVendored", JSValueMakeBoolean(ctx, true), &exception);
#else
    ct_set_property(ctx, host, "jscVendored", JSValueMakeBoolean(ctx, false), &exception);
#endif
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
        "  const then = Promise.prototype.then;"
        "  const catchPromise = Promise.prototype.catch;"
        "  const pending = [];"
        "  const markHandled = function(promise){"
        "    for (let index = 0; index < pending.length; index++) {"
        "      const entry = pending[index];"
        "      if (entry.promise !== promise) continue;"
        "      entry.handled = true;"
        "      if (globalThis.__ctUnhandledRejection === entry.reason) globalThis.__ctUnhandledRejection = undefined;"
        "    }"
        "  };"
        "  Promise.reject = function(reason){"
        "    const promise = reject(reason);"
        "    const entry = { promise, reason, handled: false };"
        "    pending.push(entry);"
        "    queueMicrotask(function(){ if (!entry.handled) globalThis.__ctUnhandledRejection = reason; });"
        "    return promise;"
        "  };"
        "  Promise.prototype.then = function(onFulfilled, onRejected){ markHandled(this); return then.call(this, onFulfilled, onRejected); };"
        "  Promise.prototype.catch = function(onRejected){ markHandled(this); return catchPromise.call(this, onRejected); };"
        "  Promise.__cottontailPatchedReject = true;"
        "}"
        "if (typeof globalThis.SharedArrayBuffer !== 'function' && globalThis.cottontail?.sharedArrayBufferCreate) {"
        "  const __ctSharedBuffers = new WeakSet();"
        "  const __ctMarkShared = (buffer) => {"
        "    if (buffer && typeof buffer === 'object') {"
        "      __ctSharedBuffers.add(buffer);"
        "      try { Object.setPrototypeOf(buffer, SharedArrayBuffer.prototype); } catch {}"
        "    }"
        "    return buffer;"
        "  };"
        "  function SharedArrayBuffer(length) {"
        "    if (!new.target) throw new TypeError(\"Constructor SharedArrayBuffer requires 'new'\");"
        "    const size = Number(length);"
        "    if (!Number.isFinite(size) || size < 0) throw new RangeError('Invalid SharedArrayBuffer length');"
        "    return __ctMarkShared(cottontail.sharedArrayBufferCreate(Math.floor(size)));"
        "  }"
        "  SharedArrayBuffer.prototype = Object.create(ArrayBuffer.prototype);"
        "  SharedArrayBuffer.prototype.constructor = SharedArrayBuffer;"
        "  try { SharedArrayBuffer.prototype[Symbol.toStringTag] = 'SharedArrayBuffer'; } catch {}"
        "  globalThis.SharedArrayBuffer = SharedArrayBuffer;"
        "  globalThis.__cottontailMarkSharedArrayBuffer = __ctMarkShared;"
        "}"
        "if (globalThis.cottontail?.sharedAtomicOp && globalThis.Atomics && !globalThis.Atomics.__cottontailPatched) {"
        "  const __ctAtomics = globalThis.Atomics;"
        "  const __ctToAtomicNumber = (value) => typeof value === 'bigint' ? Number(value) : Number(value);"
        "  const __ctAtomic = (op, array, index, value, replacement) => cottontail.sharedAtomicOp(op, array, Number(index), __ctToAtomicNumber(value ?? 0), __ctToAtomicNumber(replacement ?? 0));"
        "  __ctAtomics.load = (array, index) => __ctAtomic('load', array, index, 0);"
        "  __ctAtomics.store = (array, index, value) => __ctAtomic('store', array, index, value);"
        "  __ctAtomics.add = (array, index, value) => __ctAtomic('add', array, index, value);"
        "  __ctAtomics.sub = (array, index, value) => __ctAtomic('sub', array, index, value);"
        "  __ctAtomics.and = (array, index, value) => __ctAtomic('and', array, index, value);"
        "  __ctAtomics.or = (array, index, value) => __ctAtomic('or', array, index, value);"
        "  __ctAtomics.xor = (array, index, value) => __ctAtomic('xor', array, index, value);"
        "  __ctAtomics.exchange = (array, index, value) => __ctAtomic('exchange', array, index, value);"
        "  __ctAtomics.compareExchange = (array, index, expected, replacement) => __ctAtomic('compareExchange', array, index, expected, replacement);"
        "  __ctAtomics.wait = (array, index, value, timeout) => cottontail.sharedAtomicWait(array, Number(index), __ctToAtomicNumber(value), timeout == null ? Infinity : Number(timeout));"
        "  __ctAtomics.notify = (array, index, count) => cottontail.sharedAtomicNotify(array, Number(index), count == null ? Infinity : Number(count));"
        "  __ctAtomics.wake = __ctAtomics.notify;"
        "  __ctAtomics.waitAsync = (array, index, value, timeout) => ({ async: true, value: Promise.resolve(__ctAtomics.wait(array, index, value, timeout)) });"
        "  Object.defineProperty(__ctAtomics, '__cottontailPatched', { value: true });"
        "}"
    );
    JSValueRef bootstrap_exception = NULL;
    JSEvaluateScript(ctx, bootstrap, NULL, NULL, 1, &bootstrap_exception);
    JSStringRelease(bootstrap);
    if (bootstrap_exception != NULL) {
        char *message = ct_copy_exception(ctx, bootstrap_exception);
        fprintf(stderr, "cottontail: host bootstrap failed: %s\n", message != NULL ? message : "unknown error");
        free(message);
    }

    return exception == NULL && bootstrap_exception == NULL ? 0 : -1;
}

CtJscRuntime *ct_jsc_runtime_create(void) {
    return ct_jsc_runtime_create_with_stack_size(0);
}

CtJscRuntime *ct_jsc_runtime_create_with_stack_size(size_t stack_size) {
    (void)stack_size;
#if defined(_WIN32)
    if (ct_windows_ensure_winsock() != 0) return NULL;
#endif
    CtJscRuntime *runtime = (CtJscRuntime *)calloc(1, sizeof(CtJscRuntime));
    if (runtime == NULL) return NULL;
    /* Use JSGlobalContextCreateInGroup(NULL, ...) rather than JSGlobalContextCreate(NULL):
     * on Darwin, JSGlobalContextCreate falls back to one process-wide shared VM when the
     * binary is not linked against the JavaScriptCore dylib (NSVersionOfLinkTimeLibrary
     * returns -1 for our statically linked vendored build). A shared VM couples every
     * cottontail runtime (main thread + workers) to one JSLock/microtask queue, which
     * stalls the parent's microtask drain whenever a worker blocks inside a host call.
     * JSGlobalContextCreateInGroup(NULL, ...) always creates a fresh VM per runtime and
     * behaves identically on the system framework. */
#if defined(COTTONTAIL_VENDORED_JSC)
    /* The vendored JSCOnly static build crashes on `new ShadowRealm()` when the
     * global object was created through the C API (JSGlobalContextCreate): the
     * non-Apple port's C-API global object cannot derive a ShadowRealm global,
     * so construction dereferences a null hook. Leave the option off so the
     * constructor is absent instead of a segfault. (The Apple system framework's
     * JSAPIGlobalObject supported it, but cottontail no longer links that.) */
    runtime->context = JSGlobalContextCreateInGroup(NULL, NULL);
#else
    const char *shadow_realm_option = getenv("JSC_useShadowRealm");
    char *previous_shadow_realm_option = shadow_realm_option != NULL ? strdup(shadow_realm_option) : NULL;
    setenv("JSC_useShadowRealm", "true", 1);
    runtime->context = JSGlobalContextCreateInGroup(NULL, NULL);
    if (previous_shadow_realm_option != NULL) {
        setenv("JSC_useShadowRealm", previous_shadow_realm_option, 1);
        free(previous_shadow_realm_option);
    } else {
        unsetenv("JSC_useShadowRealm");
    }
#endif
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
        free(event->type);
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

int ct_jsc_runtime_set_args(
    CtJscRuntime *runtime,
    size_t argc,
    const char *const *argv,
    size_t user_arg_offset,
    size_t exec_argc,
    const char *const *exec_argv,
    char **error_out
) {
    if (error_out != NULL) *error_out = NULL;
    JSContextRef ctx = runtime->context;
    JSValueRef exception = NULL;
    if (user_arg_offset > argc) user_arg_offset = argc;
    size_t user_argc = argc - user_arg_offset;
    JSValueRef *arg_values = user_argc > 0 ? (JSValueRef *)calloc(user_argc, sizeof(JSValueRef)) : NULL;
    JSValueRef *argv_values = (JSValueRef *)calloc(argc + 1, sizeof(JSValueRef));
    JSValueRef *exec_arg_values = exec_argc > 0 ? (JSValueRef *)calloc(exec_argc, sizeof(JSValueRef)) : NULL;
    if ((user_argc > 0 && arg_values == NULL) || argv_values == NULL || (exec_argc > 0 && exec_arg_values == NULL)) {
        free(arg_values);
        free(argv_values);
        free(exec_arg_values);
        ct_set_error_out(error_out, ct_duplicate_bytes("Out of memory", 13));
        return -1;
    }
    argv_values[0] = ct_make_string(ctx, "cottontail");
    for (size_t index = 0; index < argc; index += 1) {
        argv_values[index + 1] = ct_make_string(ctx, argv[index]);
    }
    for (size_t index = 0; index < user_argc; index += 1) {
        arg_values[index] = ct_make_string(ctx, argv[index + user_arg_offset]);
    }
    for (size_t index = 0; index < exec_argc; index += 1) {
        exec_arg_values[index] = ct_make_string(ctx, exec_argv[index]);
    }
    JSObjectRef args = ct_make_array(ctx, user_argc, arg_values, &exception);
    JSObjectRef process_argv = exception == NULL ? ct_make_array(ctx, argc + 1, argv_values, &exception) : NULL;
    JSObjectRef process_exec_argv = exception == NULL ? ct_make_array(ctx, exec_argc, exec_arg_values, &exception) : NULL;
    free(arg_values);
    free(argv_values);
    free(exec_arg_values);
    if (exception != NULL) {
        ct_set_error_out(error_out, ct_copy_exception(ctx, exception));
        return -1;
    }
    ct_set_property(ctx, runtime->host_object, "args", args, &exception);
    if (exception == NULL) ct_set_property(ctx, runtime->host_object, "argv", process_argv, &exception);
    if (exception == NULL) ct_set_property(ctx, runtime->host_object, "execArgv", process_exec_argv, &exception);
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
        char scan_quote = 0;
        bool scan_escaped = false;
        for (const char *scan = cursor; scan + 6 <= end; scan += 1) {
            char ch = *scan;
            if (scan_escaped) {
                scan_escaped = false;
                continue;
            }
            if (scan_quote != 0) {
                if (ch == '\\') scan_escaped = true;
                else if (ch == scan_quote) scan_quote = 0;
                continue;
            }
            if (ch == '"' || ch == '\'' || ch == '`') {
                scan_quote = ch;
                continue;
            }
            if (ch == '/' && scan + 1 < end && scan[1] == '/') break;
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

        const char *argument_start = open_paren + 1;
        const char *argument_end = argument_start;
        int depth = 1;
        char quote = 0;
        bool escaped = false;
        while (argument_end < end) {
            char ch = *argument_end;
            if (escaped) {
                escaped = false;
                argument_end += 1;
                continue;
            }
            if (quote != 0) {
                if (ch == '\\') {
                    escaped = true;
                } else if (ch == quote) {
                    quote = 0;
                }
                argument_end += 1;
                continue;
            }
            if (ch == '"' || ch == '\'' || ch == '`') {
                quote = ch;
            } else if (ch == '(') {
                depth += 1;
            } else if (ch == ')') {
                depth -= 1;
                if (depth == 0) break;
            } else if (ch == '\\') {
                escaped = true;
            }
            argument_end += 1;
        }
        if (argument_end >= end || *argument_end != ')') {
            if (!ct_sb_append_bytes(builder, import_start, (size_t)(open_paren + 1 - import_start))) return false;
            cursor = open_paren + 1;
            continue;
        }

        if (!ct_sb_append_cstr(builder, "cottontail.importModule(")) return false;
        if (!ct_sb_append_cstr(builder, "(")) return false;
        if (!ct_sb_append_bytes(builder, argument_start, (size_t)(argument_end - argument_start))) return false;
        if (!ct_sb_append_cstr(builder, "),")) return false;
        if (!ct_sb_append_js_string_literal(builder, filename != NULL ? filename : "<script>")) return false;
        if (!ct_sb_append_cstr(builder, ")")) return false;
        cursor = argument_end + 1;
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
    const char *meta_token = "import.meta";
    size_t meta_token_len = strlen(meta_token);
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
        char scan_quote = 0;
        bool scan_escaped = false;
        for (const char *scan = cursor; scan + meta_token_len <= end; scan += 1) {
            char ch = *scan;
            if (scan_escaped) {
                scan_escaped = false;
                continue;
            }
            if (scan_quote != 0) {
                if (ch == '\\') scan_escaped = true;
                else if (ch == scan_quote) scan_quote = 0;
                continue;
            }
            if (ch == '"' || ch == '\'' || ch == '`') {
                scan_quote = ch;
                continue;
            }
            if (ch == '/' && scan + 1 < end && scan[1] == '/') break;
            if (strncmp(scan, meta_token, meta_token_len) == 0 &&
                (scan == line || !ct_is_js_identifier_char(scan[-1])) &&
                (scan + meta_token_len == end || !ct_is_js_identifier_char(scan[meta_token_len]))) {
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

        const char *after_meta = found + meta_token_len;
        if (after_meta >= end || *after_meta != '.') {
            if (!ct_sb_append_cstr(builder, "globalThis.__cottontailImportMeta")) {
                free(dirname);
                free(basename);
                free(file_url);
                return false;
            }
            cursor = after_meta;
            continue;
        }

        const char *property_start = after_meta + 1;
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
        } else if (ct_match_import_meta_property(property_start, end, "require", &after)) {
            if (!ct_sb_append_cstr(builder, "globalThis.require")) {
                free(dirname);
                free(basename);
                free(file_url);
                return false;
            }
            cursor = after;
        } else if (ct_match_import_meta_property(property_start, end, "resolveSync", &after)) {
            if (!ct_sb_append_cstr(builder, "globalThis.__cottontailImportMetaResolveSync")) {
                free(dirname);
                free(basename);
                free(file_url);
                return false;
            }
            cursor = after;
        } else if (ct_match_import_meta_property(property_start, end, "resolve", &after)) {
            if (!ct_sb_append_cstr(builder, "globalThis.__cottontailImportMetaResolve")) {
                free(dirname);
                free(basename);
                free(file_url);
                return false;
            }
            cursor = after;
        } else {
            if (!ct_sb_append_cstr(builder, "globalThis.__cottontailImportMeta.")) {
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

static bool ct_append_import_meta_setup(CtStringBuilder *builder, const char *filename) {
    char *dirname = ct_path_dirname(filename);
    char *basename = ct_path_basename_copy(filename);
    char *file_url = ct_file_url_for_path(filename);
    if (dirname == NULL || basename == NULL || file_url == NULL) {
        free(dirname);
        free(basename);
        free(file_url);
        return false;
    }

    bool ok =
        ct_sb_append_cstr(builder, "globalThis.__cottontailImportMeta={dirname:") &&
        ct_sb_append_js_string_literal(builder, dirname) &&
        ct_sb_append_cstr(builder, ",dir:") &&
        ct_sb_append_js_string_literal(builder, dirname) &&
        ct_sb_append_cstr(builder, ",filename:") &&
        ct_sb_append_js_string_literal(builder, filename != NULL ? filename : "") &&
        ct_sb_append_cstr(builder, ",path:") &&
        ct_sb_append_js_string_literal(builder, filename != NULL ? filename : "") &&
        ct_sb_append_cstr(builder, ",file:") &&
        ct_sb_append_js_string_literal(builder, basename) &&
        ct_sb_append_cstr(builder, ",url:") &&
        ct_sb_append_js_string_literal(builder, file_url) &&
        ct_sb_append_cstr(builder, ",main:true};") &&
        ct_sb_append_cstr(builder, "Object.defineProperty(globalThis.__cottontailImportMeta,\"require\",{get(){return globalThis.require},set(v){globalThis.require=v},configurable:true});") &&
        ct_sb_append_cstr(builder, "Object.defineProperty(globalThis.__cottontailImportMeta,\"resolve\",{get(){return globalThis.__cottontailImportMetaResolve},configurable:true});") &&
        ct_sb_append_cstr(builder, "Object.defineProperty(globalThis.__cottontailImportMeta,\"resolveSync\",{get(){return globalThis.__cottontailImportMetaResolveSync},configurable:true});");

    free(dirname);
    free(basename);
    free(file_url);
    return ok;
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
    if (!ct_append_import_meta_setup(&builder, filename)) {
        free(builder.data);
        return NULL;
    }
    if (!ct_sb_append_bytes(&builder, prefix, prefix_len)) {
        free(builder.data);
        return NULL;
    }

    const char *start = (const char *)source;
    const char *end = start + source_len;
    const char *lowered_marker = "/* cottontail:module-syntax-lowered */";
    bool module_syntax_lowered = source_len >= strlen(lowered_marker) &&
        memcmp(source, lowered_marker, strlen(lowered_marker)) == 0;
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
            if (module_syntax_lowered) {
                if (!ct_sb_append_bytes(&builder, start, line_len)) {
                    free(builder.data);
                    return NULL;
                }
                if (line_end < end && !ct_sb_append_cstr(&builder, "\n")) {
                    free(builder.data);
                    return NULL;
                }
                start = line_end < end ? line_end + 1 : end;
                continue;
            }
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
        "(()=>{const __ctTopLevelPromise=(async()=>{\n",
        "\n})();try{globalThis.__cottontailSuppressAsyncHookPromise=true;"
        "__ctTopLevelPromise.then(()=>{globalThis.__ctDone=true;},"
        "e=>{globalThis.__ctError=e;globalThis.__ctDone=true;});}"
        "finally{globalThis.__cottontailSuppressAsyncHookPromise=false;}})();"
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
        if (wait_for_active_handles && !ct_global_bool(ctx, "__ctDone")) {
            bool has_active_handles = false;
            if (ct_jsc_runtime_has_active_handles(runtime, &has_active_handles, error_out) != 0) return -1;
            if (!has_active_handles) return -13;
        }
        usleep(1000);
    }
    if (!ct_global_bool(ctx, "__ctDone")) return -13;
    JSValueRef error_value = ct_global_value(ctx, "__ctError");
    if (error_value != NULL && !JSValueIsUndefined(ctx, error_value) && !JSValueIsNull(ctx, error_value)) {
        ct_set_error_out(error_out, ct_copy_exception(ctx, error_value));
        return -1;
    }
    for (int index = 0; index < 16; index += 1) {
        if (ct_jsc_runtime_tick(runtime, error_out) != 0) return -1;
    }

    error_value = ct_global_value(ctx, "__ctError");
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

    error_value = ct_global_value(ctx, "__ctError");
    if (error_value != NULL && !JSValueIsUndefined(ctx, error_value) && !JSValueIsNull(ctx, error_value)) {
        ct_set_error_out(error_out, ct_copy_exception(ctx, error_value));
        return -1;
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
