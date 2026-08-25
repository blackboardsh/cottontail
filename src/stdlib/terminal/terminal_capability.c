#include "../native_capability.h"
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#if defined(_WIN32)
#include <io.h>
#endif
#if !defined(_WIN32)
#include <fcntl.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>
#endif

static JSValueRef ct_terminal_create(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
#if defined(_WIN32)
    (void)argc;
    (void)argv;
    ct_throw_message(ctx, exception, "PTY not supported on this platform");
    return JSValueMakeUndefined(ctx);
#else
    int cols = 80;
    int rows = 24;
    if (argc >= 1 && !ct_value_to_int_checked(ctx, argv[0], 1, UINT16_MAX, &cols, exception, "invalid terminal column count")) {
        return JSValueMakeUndefined(ctx);
    }
    if (argc >= 2 && !ct_value_to_int_checked(ctx, argv[1], 1, UINT16_MAX, &rows, exception, "invalid terminal row count")) {
        return JSValueMakeUndefined(ctx);
    }

    int master_fd = posix_openpt(O_RDWR | O_NOCTTY);
    if (master_fd < 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    if (grantpt(master_fd) != 0 || unlockpt(master_fd) != 0) {
        int open_error = errno;
        close(master_fd);
        ct_throw_message(ctx, exception, strerror(open_error));
        return JSValueMakeUndefined(ctx);
    }

    char *slave_name = ptsname(master_fd);
    if (slave_name == NULL) {
        int open_error = errno;
        close(master_fd);
        ct_throw_message(ctx, exception, strerror(open_error));
        return JSValueMakeUndefined(ctx);
    }
    int slave_fd = open(slave_name, O_RDWR | O_NOCTTY);
    if (slave_fd < 0) {
        int open_error = errno;
        close(master_fd);
        ct_throw_message(ctx, exception, strerror(open_error));
        return JSValueMakeUndefined(ctx);
    }
    int read_fd = dup(master_fd);
    int write_fd = dup(master_fd);
    if (read_fd < 0 || write_fd < 0) {
        int open_error = errno;
        if (read_fd >= 0) close(read_fd);
        if (write_fd >= 0) close(write_fd);
        close(slave_fd);
        close(master_fd);
        ct_throw_message(ctx, exception, strerror(open_error));
        return JSValueMakeUndefined(ctx);
    }

    struct winsize size;
    memset(&size, 0, sizeof(size));
    size.ws_col = (unsigned short)cols;
    size.ws_row = (unsigned short)rows;
    if (ioctl(master_fd, TIOCSWINSZ, &size) != 0) {
        int resize_error = errno;
        close(write_fd);
        close(read_fd);
        close(slave_fd);
        close(master_fd);
        ct_throw_message(ctx, exception, strerror(resize_error));
        return JSValueMakeUndefined(ctx);
    }

    fcntl(master_fd, F_SETFD, fcntl(master_fd, F_GETFD) | FD_CLOEXEC);
    fcntl(read_fd, F_SETFD, fcntl(read_fd, F_GETFD) | FD_CLOEXEC);
    fcntl(write_fd, F_SETFD, fcntl(write_fd, F_GETFD) | FD_CLOEXEC);
    fcntl(slave_fd, F_SETFD, fcntl(slave_fd, F_GETFD) | FD_CLOEXEC);

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "masterFd", JSValueMakeNumber(ctx, master_fd), exception);
    ct_set_property(ctx, result, "readFd", JSValueMakeNumber(ctx, read_fd), exception);
    ct_set_property(ctx, result, "writeFd", JSValueMakeNumber(ctx, write_fd), exception);
    ct_set_property(ctx, result, "slaveFd", JSValueMakeNumber(ctx, slave_fd), exception);
    return result;
#endif
}

static JSValueRef ct_terminal_write(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
#if defined(_WIN32)
    (void)argc;
    (void)argv;
    ct_throw_message(ctx, exception, "PTY not supported on this platform");
    return JSValueMakeUndefined(ctx);
#else
    if (argc < 2) {
        ct_throw_message(ctx, exception, "terminalWrite(fd, data) requires a file descriptor and data");
        return JSValueMakeUndefined(ctx);
    }
    int fd;
    if (!ct_value_to_int_checked(ctx, argv[0], 0, INT_MAX, &fd, exception, "invalid terminal file descriptor")) {
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *bytes = NULL;
    size_t len = 0;
    if (ct_get_bytes(ctx, argv[1], &bytes, &len) != 0) {
        ct_throw_message(ctx, exception, "terminal data must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }

    size_t written_total = 0;
    while (written_total < len) {
        ssize_t written = write(fd, bytes + written_total, len - written_total);
        if (written > 0) {
            written_total += (size_t)written;
            continue;
        }
        if (written < 0 && errno == EINTR) continue;
        if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            struct pollfd descriptor = { .fd = fd, .events = POLLOUT, .revents = 0 };
            int ready;
            do {
                ready = poll(&descriptor, 1, 1000);
            } while (ready < 0 && errno == EINTR);
            if (ready > 0) continue;
            if (written_total > 0) break;
        }
        if (written_total == 0) {
            ct_throw_message(ctx, exception, strerror(errno));
            return JSValueMakeUndefined(ctx);
        }
        break;
    }
    return JSValueMakeNumber(ctx, (double)written_total);
#endif
}

static JSValueRef ct_terminal_resize(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
#if defined(_WIN32)
    (void)argc;
    (void)argv;
    ct_throw_message(ctx, exception, "PTY not supported on this platform");
    return JSValueMakeUndefined(ctx);
#else
    if (argc < 3) {
        ct_throw_message(ctx, exception, "terminalResize(fd, cols, rows) requires a file descriptor, columns, and rows");
        return JSValueMakeUndefined(ctx);
    }
    int fd;
    int cols;
    int rows;
    if (!ct_value_to_int_checked(ctx, argv[0], 0, INT_MAX, &fd, exception, "invalid terminal file descriptor") ||
        !ct_value_to_int_checked(ctx, argv[1], 1, UINT16_MAX, &cols, exception, "invalid terminal column count") ||
        !ct_value_to_int_checked(ctx, argv[2], 1, UINT16_MAX, &rows, exception, "invalid terminal row count")) {
        return JSValueMakeUndefined(ctx);
    }
    struct winsize size;
    memset(&size, 0, sizeof(size));
    size.ws_col = (unsigned short)cols;
    size.ws_row = (unsigned short)rows;
    if (ioctl(fd, TIOCSWINSZ, &size) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
    }
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_terminal_get_flags(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
#if defined(_WIN32)
    (void)argc;
    (void)argv;
    return JSValueMakeNumber(ctx, 0);
#else
    if (argc < 2) return JSValueMakeNumber(ctx, 0);
    int fd;
    int kind;
    if (!ct_value_to_int_checked(ctx, argv[0], 0, INT_MAX, &fd, exception, "invalid terminal file descriptor") ||
        !ct_value_to_int_checked(ctx, argv[1], 0, 3, &kind, exception, "invalid terminal flag kind")) {
        return JSValueMakeUndefined(ctx);
    }
    struct termios attributes;
    if (tcgetattr(fd, &attributes) != 0) return JSValueMakeNumber(ctx, 0);
    tcflag_t value = kind == 0 ? attributes.c_iflag
        : kind == 1 ? attributes.c_oflag
        : kind == 2 ? attributes.c_lflag
        : attributes.c_cflag;
    return JSValueMakeNumber(ctx, (double)value);
#endif
}

static JSValueRef ct_terminal_set_flags(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
#if defined(_WIN32)
    (void)argc;
    (void)argv;
    return JSValueMakeUndefined(ctx);
#else
    if (argc < 3) return JSValueMakeUndefined(ctx);
    int fd;
    int kind;
    if (!ct_value_to_int_checked(ctx, argv[0], 0, INT_MAX, &fd, exception, "invalid terminal file descriptor") ||
        !ct_value_to_int_checked(ctx, argv[1], 0, 3, &kind, exception, "invalid terminal flag kind")) {
        return JSValueMakeUndefined(ctx);
    }
    double numeric = ct_value_to_number(ctx, argv[2]);
    if (!isfinite(numeric)) numeric = 0;
    if (numeric < 0) numeric = 0;
    if (numeric > (double)UINT32_MAX) numeric = (double)UINT32_MAX;
    struct termios attributes;
    if (tcgetattr(fd, &attributes) != 0) return JSValueMakeUndefined(ctx);
    tcflag_t value = (tcflag_t)numeric;
    if (kind == 0) attributes.c_iflag = value;
    else if (kind == 1) attributes.c_oflag = value;
    else if (kind == 2) attributes.c_lflag = value;
    else attributes.c_cflag = value;
    (void)tcsetattr(fd, TCSANOW, &attributes);
    return JSValueMakeUndefined(ctx);
#endif
}

static JSValueRef ct_terminal_set_raw_mode(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "terminalSetRawMode(fd, enabled) requires a file descriptor and mode");
        return JSValueMakeUndefined(ctx);
    }
    int fd;
    if (!ct_value_to_int_checked(ctx, argv[0], 0, INT_MAX, &fd, exception, "invalid terminal file descriptor")) {
        return JSValueMakeUndefined(ctx);
    }
#if defined(_WIN32)
    intptr_t raw_handle = _get_osfhandle(fd);
    HANDLE handle = raw_handle == -1 ? INVALID_HANDLE_VALUE : (HANDLE)raw_handle;
    DWORD current_mode = 0;
    DWORD pending_events = 0;
    if (handle == INVALID_HANDLE_VALUE ||
        !GetConsoleMode(handle, &current_mode) ||
        !GetNumberOfConsoleInputEvents(handle, &pending_events)) {
        ct_throw_message(ctx, exception, "PTY not supported on this platform");
        return JSValueMakeUndefined(ctx);
    }
    DWORD requested_mode;
    if (ct_value_to_bool(ctx, argv[1])) {
        requested_mode = ENABLE_WINDOW_INPUT | ENABLE_VIRTUAL_TERMINAL_INPUT;
        if (current_mode == requested_mode || SetConsoleMode(handle, requested_mode)) return JSValueMakeUndefined(ctx);
        requested_mode = ENABLE_WINDOW_INPUT;
        if (SetConsoleMode(handle, requested_mode)) return JSValueMakeUndefined(ctx);
    } else {
        requested_mode = ENABLE_ECHO_INPUT | ENABLE_LINE_INPUT | ENABLE_PROCESSED_INPUT;
        if (current_mode == requested_mode || SetConsoleMode(handle, requested_mode)) return JSValueMakeUndefined(ctx);
    }
    ct_throw_message(ctx, exception, "Unable to change console mode");
#else
    struct termios attributes;
    if (tcgetattr(fd, &attributes) != 0) {
        ct_throw_message(ctx, exception, strerror(errno));
        return JSValueMakeUndefined(ctx);
    }
    if (ct_value_to_bool(ctx, argv[1])) {
        cfmakeraw(&attributes);
    } else {
        attributes.c_iflag |= BRKINT | ICRNL | IXON;
        attributes.c_oflag |= OPOST;
#ifdef ONLCR
        attributes.c_oflag |= ONLCR;
#endif
        attributes.c_cflag |= CREAD;
        attributes.c_cflag &= ~CSIZE;
        attributes.c_cflag |= CS8;
        attributes.c_lflag |= ECHO | ECHOE | ECHOK | ICANON | ISIG | IEXTEN;
    }
    if (tcsetattr(fd, TCSANOW, &attributes) != 0) ct_throw_message(ctx, exception, strerror(errno));
#endif
    return JSValueMakeUndefined(ctx);
}


#define TERMINAL_BINDINGS \
    { "terminalCreate", ct_terminal_create }, \
    { "terminalWrite", ct_terminal_write }, \
    { "terminalResize", ct_terminal_resize }, \
    { "terminalGetFlags", ct_terminal_get_flags }, \
    { "terminalSetFlags", ct_terminal_set_flags }, \
    { "terminalSetRawMode", ct_terminal_set_raw_mode },
CT_CAPABILITY_EXPORT_BINDINGS(TERMINAL_BINDINGS)
