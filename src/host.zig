const std = @import("std");
const builtin = @import("builtin");
const compiler = @import("cottontail_compiler");
const signal_forwarding = @import("signal_forwarding.zig");
// COTTONTAIL-COMPAT: SDK 26.4 asserts the size of Mach bitfield records that
// Zig's C importer leaves opaque. Use Zig's Darwin libc ABI instead.
const DarwinC = struct {
    pub const EACCES: c_int = @intFromEnum(std.c.E.ACCES);
    pub const EPERM: c_int = @intFromEnum(std.c.E.PERM);
    pub const ENOENT: c_int = @intFromEnum(std.c.E.NOENT);
    pub const ENOTDIR: c_int = @intFromEnum(std.c.E.NOTDIR);
    pub const ENOEXEC: c_int = @intFromEnum(std.c.E.NOEXEC);
    pub const ENOMEM: c_int = @intFromEnum(std.c.E.NOMEM);
    pub const EMFILE: c_int = @intFromEnum(std.c.E.MFILE);
    pub const ENFILE: c_int = @intFromEnum(std.c.E.NFILE);
    pub const F_DUPFD_CLOEXEC: c_int = std.c.F.DUPFD_CLOEXEC;
    pub const F_GETFD: c_int = std.c.F.GETFD;
    pub const F_SETFD: c_int = std.c.F.SETFD;
    pub const FD_CLOEXEC: c_int = std.c.FD_CLOEXEC;
    pub const O_RDONLY: c_int = @bitCast(std.c.O{});
    pub const O_WRONLY: c_int = @bitCast(std.c.O{ .ACCMODE = .WRONLY });
    pub const posix_spawn_file_actions_t = std.c.posix_spawn_file_actions_t;
    pub const malloc = std.c.malloc;
    pub const free = std.c.free;
    pub const close = std.c.close;
    pub const pipe = std.c.pipe;
    pub const fcntl = std.c.fcntl;
    pub const posix_spawn_file_actions_init = std.c.posix_spawn_file_actions_init;
    pub const posix_spawn_file_actions_destroy = std.c.posix_spawn_file_actions_destroy;
    pub const posix_spawn_file_actions_addclose = std.c.posix_spawn_file_actions_addclose;
    pub const posix_spawn_file_actions_addopen = std.c.posix_spawn_file_actions_addopen;
    pub const posix_spawn_file_actions_adddup2 = std.c.posix_spawn_file_actions_adddup2;
    pub const posix_spawn_file_actions_addinherit_np = std.c.posix_spawn_file_actions_addinherit_np;
    pub const posix_spawn_file_actions_addchdir_np = std.c.posix_spawn_file_actions_addchdir_np;
    pub const posix_spawn = std.c.posix_spawn;
    pub const posix_spawnp = std.c.posix_spawnp;
};
const c = if (builtin.os.tag == .windows) @cImport({
    @cInclude("errno.h");
    @cInclude("stdlib.h");
}) else if (builtin.os.tag == .macos) DarwinC else @cImport({
    // Zig imports declarations rather than glibc's fortified inline wrappers.
    // Newer glibc fcntl wrappers intentionally contain compile-time error calls
    // that translate-c cannot lower as declarations.
    @cUndef("_FORTIFY_SOURCE");
    @cDefine("_GNU_SOURCE", "1");
    @cInclude("errno.h");
    @cInclude("fcntl.h");
    @cInclude("signal.h");
    @cInclude("spawn.h");
    @cInclude("stdlib.h");
    @cInclude("unistd.h");
});

const Semver = compiler.Semver;

extern "c" fn _get_osfhandle(fd: c_int) isize;
extern "c" fn ct_paths_are_same_file(source: [*:0]const u8, destination: [*:0]const u8) c_int;
extern "c" fn ct_native_copy_file(source: [*:0]const u8, destination: [*:0]const u8, exclusive: c_int) c_int;
extern "c" fn ct_native_clone_tree(source: [*:0]const u8, destination: [*:0]const u8) c_int;
extern "c" fn ct_native_chmod(path: [*:0]const u8, mode: c_uint) c_int;

pub const CtHostEnvEntry = extern struct {
    name: [*:0]const u8,
    value: [*:0]const u8,
};

pub const CtHostSpawnOptions = extern struct {
    cwd: ?[*:0]const u8,
    argv0: ?[*:0]const u8,
    env_entries: ?[*]const CtHostEnvEntry,
    env_count: usize,
    clear_env: bool,
    stdin_mode: c_int,
    stdout_mode: c_int,
    stderr_mode: c_int,
    stdin_fd: c_int,
    stdout_fd: c_int,
    stderr_fd: c_int,
    input_present: bool,
    input_ptr: ?[*]const u8,
    input_len: usize,
    timeout_enabled: bool,
    timeout_ms: u64,
    max_buffer_enabled: bool,
    max_buffer: u64,
    kill_signal: c_int,
    abort_requested: bool,
    windows_hide: bool,
    windows_verbatim_arguments: bool,
};

extern "c" fn ct_windows_spawn_host_process(
    file: [*:0]const u8,
    args_ptr: ?[*]const [*:0]const u8,
    arg_count: usize,
    options: CtHostSpawnOptions,
    process_out: *usize,
    thread_out: *usize,
    stdin_handle_out: *usize,
    stdout_handle_out: *usize,
    stderr_handle_out: *usize,
) c_int;

pub const CtHostSpawnResult = extern struct {
    exit_code: c_int,
    signal_code: c_int,
    pid: u64,
    stdout_ptr: ?[*]u8,
    stdout_len: usize,
    stdout_present: bool,
    stderr_ptr: ?[*]u8,
    stderr_len: usize,
    stderr_present: bool,
    exited_due_to_timeout: bool,
    exited_due_to_max_buffer: bool,
    memfd_count: u32,
    resource_usage_present: bool,
    user_cpu_time: u64,
    system_cpu_time: u64,
    max_rss: u64,
    shared_memory_size: u64,
    swapped_out: u64,
    fs_read: u64,
    fs_write: u64,
    ipc_sent: u64,
    ipc_received: u64,
    signals_count: u64,
    voluntary_context_switches: u64,
    involuntary_context_switches: u64,
};

const SpawnStdio = enum(c_int) {
    pipe = 0,
    inherit = 1,
    ignore = 2,
};

const SpawnTerminationReason = enum {
    none,
    timeout,
    max_buffer,
    abort_signal,
    io_error,
};

var host_io: ?std.Io = null;

pub fn configure(io: std.Io) void {
    host_io = io;
}

pub fn getIo() std.Io {
    return host_io orelse @panic("cottontail host IO is not configured");
}

fn setErrorOut(error_out: *?[*:0]u8, message: []const u8) void {
    error_out.* = allocCString(message);
}

fn setFormattedErrorOut(error_out: *?[*:0]u8, comptime format: []const u8, args: anytype) void {
    const message = std.fmt.allocPrintSentinel(std.heap.c_allocator, format, args, 0) catch {
        error_out.* = null;
        return;
    };
    error_out.* = message.ptr;
}

fn windowsPathAttributes(sub_path: []const u8) ?std.os.windows.FILE.ATTRIBUTE {
    if (sub_path.len == 0) return null;
    const windows = std.os.windows;
    const cwd = std.Io.Dir.cwd();
    const sub_path_w = std.Io.Threaded.sliceToPrefixedFileW(cwd.handle, sub_path, .{}) catch return null;
    const attributes: windows.OBJECT.ATTRIBUTES = .{
        .RootDirectory = if (std.Io.Dir.path.isAbsoluteWindowsWtf16(sub_path_w.span())) null else cwd.handle,
        .ObjectName = @constCast(&sub_path_w.string()),
    };
    var basic_info: windows.FILE.BASIC_INFORMATION = undefined;
    if (windows.ntdll.NtQueryAttributesFile(&attributes, &basic_info) != .SUCCESS) return null;
    return basic_info.FileAttributes;
}

fn windowsDirectoryLinkTag(sub_path: []const u8) ?std.os.windows.IO_REPARSE_TAG {
    const windows = std.os.windows;
    const cwd = std.Io.Dir.cwd();
    const sub_path_w = std.Io.Threaded.sliceToPrefixedFileW(cwd.handle, sub_path, .{}) catch return null;
    const attributes: windows.OBJECT.ATTRIBUTES = .{
        .RootDirectory = if (std.Io.Dir.path.isAbsoluteWindowsWtf16(sub_path_w.span())) null else cwd.handle,
        .ObjectName = @constCast(&sub_path_w.string()),
    };
    var io_status_block: windows.IO_STATUS_BLOCK = undefined;
    var handle: windows.HANDLE = undefined;
    if (windows.ntdll.NtCreateFile(
        &handle,
        .{
            .SPECIFIC = .{ .FILE = .{ .READ_ATTRIBUTES = true } },
            .STANDARD = .{ .SYNCHRONIZE = true },
        },
        &attributes,
        &io_status_block,
        null,
        .{ .NORMAL = true },
        .VALID_FLAGS,
        .OPEN,
        .{
            .DIRECTORY_FILE = true,
            .IO = .SYNCHRONOUS_NONALERT,
            .OPEN_REPARSE_POINT = true,
        },
        null,
        0,
    ) != .SUCCESS) return null;
    defer windows.CloseHandle(handle);

    var tag_info: windows.FILE.ATTRIBUTE_TAG_INFO = undefined;
    if (windows.ntdll.NtQueryInformationFile(
        handle,
        &io_status_block,
        &tag_info,
        @sizeOf(windows.FILE.ATTRIBUTE_TAG_INFO),
        .AttributeTag,
    ) != .SUCCESS) return null;
    return tag_info.ReparseTag;
}

fn isWindowsDirectoryLinkTag(tag: std.os.windows.IO_REPARSE_TAG) bool {
    const TagInt = @typeInfo(std.os.windows.IO_REPARSE_TAG).@"struct".backing_integer.?;
    const value: TagInt = @bitCast(tag);
    return value == @as(TagInt, @bitCast(std.os.windows.IO_REPARSE_TAG.SYMLINK)) or
        value == @as(TagInt, @bitCast(std.os.windows.IO_REPARSE_TAG.MOUNT_POINT));
}

test "Windows unlink only recognizes symbolic-link and mount-point reparse tags" {
    try std.testing.expect(isWindowsDirectoryLinkTag(.SYMLINK));
    try std.testing.expect(isWindowsDirectoryLinkTag(.MOUNT_POINT));
    try std.testing.expect(!isWindowsDirectoryLinkTag(.IIS_CACHE));
    try std.testing.expect(!isWindowsDirectoryLinkTag(.PROJFS));
    try std.testing.expect(!isWindowsDirectoryLinkTag(std.os.windows.IO_REPARSE_TAG.CLOUD(0)));
}

fn allocCString(bytes: []const u8) ?[*:0]u8 {
    const raw = c.malloc(bytes.len + 1) orelse return null;
    const ptr: [*]u8 = @ptrCast(raw);

    @memcpy(ptr[0..bytes.len], bytes);
    ptr[bytes.len] = 0;
    return @ptrCast(ptr);
}

fn allocBuffer(bytes: []const u8) ?[*]u8 {
    const raw = c.malloc(bytes.len + 1) orelse return null;
    const ptr: [*]u8 = @ptrCast(raw);

    @memcpy(ptr[0..bytes.len], bytes);
    ptr[bytes.len] = 0;
    return ptr;
}

pub export fn ct_semver_order(
    left_ptr: [*]const u8,
    left_len: usize,
    right_ptr: [*]const u8,
    right_len: usize,
    result_out: *c_int,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    const left = left_ptr[0..left_len];
    const right = right_ptr[0..right_len];

    if (!compiler.strings.isAllASCII(left) or !compiler.strings.isAllASCII(right)) {
        result_out.* = 0;
        return 0;
    }

    const left_result = Semver.Version.parse(Semver.SlicedString.init(left, left));
    if (!left_result.valid) {
        setFormattedErrorOut(error_out, "Invalid SemVer: {s}\n", .{left});
        return -1;
    }

    const right_result = Semver.Version.parse(Semver.SlicedString.init(right, right));
    if (!right_result.valid) {
        setFormattedErrorOut(error_out, "Invalid SemVer: {s}\n", .{right});
        return -1;
    }

    result_out.* = switch (left_result.version.max().orderWithoutBuild(right_result.version.max(), left, right)) {
        .lt => -1,
        .eq => 0,
        .gt => 1,
    };
    return 0;
}

pub export fn ct_semver_satisfies(
    version_ptr: [*]const u8,
    version_len: usize,
    range_ptr: [*]const u8,
    range_len: usize,
    result_out: *bool,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    const version = version_ptr[0..version_len];
    const range = range_ptr[0..range_len];

    if (!compiler.strings.isAllASCII(version) or !compiler.strings.isAllASCII(range)) {
        result_out.* = false;
        return 0;
    }

    const version_result = Semver.Version.parse(Semver.SlicedString.init(version, version));
    if (version_result.wildcard != .none) {
        result_out.* = false;
        return 0;
    }
    const parsed_version = version_result.version.min();

    var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena.deinit();
    var stack_fallback = std.heap.stackFallback(512, arena.allocator());
    const parsed_range = Semver.Query.parse(
        stack_fallback.get(),
        range,
        Semver.SlicedString.init(range, range),
    ) catch {
        setErrorOut(error_out, "Out of memory");
        return -1;
    };
    defer parsed_range.deinit();

    if (parsed_range.getExactVersion()) |exact| {
        result_out.* = parsed_version.eql(exact);
        return 0;
    }

    result_out.* = parsed_range.satisfies(parsed_version, range, version);
    return 0;
}

fn termToExitCode(term: std.process.Child.Term) c_int {
    return switch (term) {
        .exited => |code| @as(c_int, code),
        .signal => |signal| 128 + @as(c_int, @intCast(@intFromEnum(signal))),
        .stopped => 1,
        .unknown => 1,
    };
}

fn termToSignalCode(term: std.process.Child.Term) c_int {
    return switch (term) {
        .signal => |signal| @as(c_int, @intCast(@intFromEnum(signal))),
        else => 0,
    };
}

fn cwdOption(path: ?[*:0]const u8) std.process.Child.Cwd {
    return if (path) |cwd_path|
        .{ .path = std.mem.span(cwd_path) }
    else
        .inherit;
}

fn spawnFileForDescriptor(fd: c_int) std.Io.File {
    if (comptime builtin.os.tag == .windows) {
        const handle = windowsFileHandle(fd);
        return .{ .handle = handle, .flags = .{ .nonblocking = false } };
    }
    return .{ .handle = @intCast(fd), .flags = .{ .nonblocking = false } };
}

fn windowsFileHandle(fd: c_int) std.os.windows.HANDLE {
    const raw = _get_osfhandle(fd);
    return @ptrFromInt(@as(usize, @bitCast(raw)));
}

fn spawnStdioOption(mode: c_int, source_fd: c_int) std.process.SpawnOptions.StdIo {
    if (source_fd >= 0) return .{ .file = spawnFileForDescriptor(source_fd) };
    return switch (@as(SpawnStdio, @enumFromInt(mode))) {
        .pipe => .pipe,
        .inherit => .inherit,
        .ignore => .ignore,
    };
}

fn inheritWindowsSystemRoot(
    map: *std.process.Environ.Map,
    allocator: std.mem.Allocator,
) !void {
    if (comptime builtin.os.tag != .windows) return;
    if (map.contains("SystemRoot")) return;

    const parent_environ: std.process.Environ = .{ .block = .global };
    const value = parent_environ.getAlloc(allocator, "SystemRoot") catch |err| switch (err) {
        error.EnvironmentVariableMissing => return,
        else => return err,
    };
    defer allocator.free(value);
    try map.put("SystemRoot", value);
}

fn windowsPipeFile(raw_handle: usize) ?std.Io.File {
    if (raw_handle == 0) return null;
    return .{
        .handle = @ptrFromInt(raw_handle),
        .flags = .{ .nonblocking = false },
    };
}

fn spawnWindowsNative(
    file: [*:0]const u8,
    args_ptr: ?[*]const [*:0]const u8,
    arg_count: usize,
    options: CtHostSpawnOptions,
) std.process.SpawnError!std.process.Child {
    var process_handle: usize = 0;
    var thread_handle: usize = 0;
    var stdin_handle: usize = 0;
    var stdout_handle: usize = 0;
    var stderr_handle: usize = 0;
    const code = ct_windows_spawn_host_process(
        file,
        args_ptr,
        arg_count,
        options,
        &process_handle,
        &thread_handle,
        &stdin_handle,
        &stdout_handle,
        &stderr_handle,
    );
    if (code != 0) return posixSpawnError(code);
    if (process_handle == 0 or thread_handle == 0) return error.Unexpected;

    return .{
        .id = @ptrFromInt(process_handle),
        .thread_handle = @ptrFromInt(thread_handle),
        .stdin = windowsPipeFile(stdin_handle),
        .stdout = windowsPipeFile(stdout_handle),
        .stderr = windowsPipeFile(stderr_handle),
        .request_resource_usage_statistics = true,
    };
}

fn posixSpawnError(code: c_int) std.process.SpawnError {
    return switch (code) {
        c.EACCES => error.AccessDenied,
        c.EPERM => error.PermissionDenied,
        c.ENOENT => error.FileNotFound,
        c.ENOTDIR => error.NotDir,
        c.ENOEXEC => error.InvalidExe,
        c.ENOMEM => error.SystemResources,
        c.EMFILE => error.ProcessFdQuotaExceeded,
        c.ENFILE => error.SystemFdQuotaExceeded,
        else => error.Unexpected,
    };
}

fn checkPosixSpawnResult(code: c_int) std.process.SpawnError!void {
    if (code != 0) return posixSpawnError(code);
}

fn closePosixSpawnFd(fd: *c_int) void {
    if (fd.* >= 0) {
        _ = c.close(fd.*);
        fd.* = -1;
    }
}

fn createPosixSpawnPipe() std.process.SpawnError![2]c_int {
    var fds = [2]c_int{ -1, -1 };
    if (c.pipe(&fds) != 0) return error.Unexpected;
    errdefer {
        closePosixSpawnFd(&fds[0]);
        closePosixSpawnFd(&fds[1]);
    }
    for (&fds) |*fd| {
        if (fd.* <= std.posix.STDERR_FILENO) {
            const relocated = c.fcntl(fd.*, c.F_DUPFD_CLOEXEC, @as(c_int, std.posix.STDERR_FILENO + 1));
            if (relocated < 0) return error.Unexpected;
            _ = c.close(fd.*);
            fd.* = relocated;
        } else {
            const flags = c.fcntl(fd.*, c.F_GETFD);
            if (flags < 0 or c.fcntl(fd.*, c.F_SETFD, flags | c.FD_CLOEXEC) < 0) return error.Unexpected;
        }
    }
    return fds;
}

fn addPosixSpawnInheritAction(
    actions: *c.posix_spawn_file_actions_t,
    fd: c_int,
) std.process.SpawnError!void {
    if (comptime builtin.os.tag == .macos) {
        try checkPosixSpawnResult(c.posix_spawn_file_actions_addinherit_np(actions, fd));
    } else {
        try checkPosixSpawnResult(c.posix_spawn_file_actions_adddup2(actions, fd, fd));
    }
}

fn addPosixSpawnDup2Action(
    actions: *c.posix_spawn_file_actions_t,
    source_fd: c_int,
    target_fd: c_int,
) std.process.SpawnError!void {
    if (source_fd == target_fd) return addPosixSpawnInheritAction(actions, target_fd);
    try checkPosixSpawnResult(c.posix_spawn_file_actions_adddup2(actions, source_fd, target_fd));
}

fn addPosixSpawnStdioAction(
    actions: *c.posix_spawn_file_actions_t,
    option: std.process.SpawnOptions.StdIo,
    pipe_fd: c_int,
    action_fd: c_int,
    target_fd: c_int,
    input: bool,
) std.process.SpawnError!void {
    switch (option) {
        .inherit => try addPosixSpawnInheritAction(actions, target_fd),
        .file => |file| {
            const source_fd: c_int = if (action_fd >= 0) action_fd else @intCast(file.handle);
            try addPosixSpawnDup2Action(actions, source_fd, target_fd);
        },
        .ignore => try checkPosixSpawnResult(c.posix_spawn_file_actions_addopen(
            actions,
            target_fd,
            "/dev/null",
            if (input) c.O_RDONLY else c.O_WRONLY,
            0,
        )),
        .pipe => try addPosixSpawnDup2Action(actions, pipe_fd, target_fd),
        .close => try checkPosixSpawnResult(c.posix_spawn_file_actions_addclose(actions, target_fd)),
    }
}

fn spawnPosixWithArgv0(
    executable: [*:0]const u8,
    argv: []const []const u8,
    cwd: ?[*:0]const u8,
    env_map: ?*const std.process.Environ.Map,
    stdin_option: std.process.SpawnOptions.StdIo,
    stdout_option: std.process.SpawnOptions.StdIo,
    stderr_option: std.process.SpawnOptions.StdIo,
    create_process_group: bool,
) std.process.SpawnError!std.process.Child {
    const gpa = std.heap.c_allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const argv_z = try arena.allocSentinel(?[*:0]u8, argv.len, null);
    for (argv, 0..) |arg, index| argv_z[index] = (try arena.dupeZ(u8, arg)).ptr;

    var env_block: ?std.process.Environ.PosixBlock = null;
    defer if (env_block) |block| block.deinit(gpa);
    const envp: [*:null]?[*:0]u8 = if (env_map) |map| block: {
        const block_value = try map.createPosixBlock(gpa, .{});
        env_block = block_value;
        break :block @ptrCast(@constCast(block_value.slice.ptr));
    } else std.c.environ;

    var stdin_pipe = if (stdin_option == .pipe) try createPosixSpawnPipe() else [2]c_int{ -1, -1 };
    errdefer {
        closePosixSpawnFd(&stdin_pipe[0]);
        closePosixSpawnFd(&stdin_pipe[1]);
    }
    var stdout_pipe = if (stdout_option == .pipe) try createPosixSpawnPipe() else [2]c_int{ -1, -1 };
    errdefer {
        closePosixSpawnFd(&stdout_pipe[0]);
        closePosixSpawnFd(&stdout_pipe[1]);
    }
    var stderr_pipe = if (stderr_option == .pipe) try createPosixSpawnPipe() else [2]c_int{ -1, -1 };
    errdefer {
        closePosixSpawnFd(&stderr_pipe[0]);
        closePosixSpawnFd(&stderr_pipe[1]);
    }

    var actions: c.posix_spawn_file_actions_t = undefined;
    try checkPosixSpawnResult(c.posix_spawn_file_actions_init(&actions));
    defer _ = c.posix_spawn_file_actions_destroy(&actions);

    const stdio_options = [_]std.process.SpawnOptions.StdIo{ stdin_option, stdout_option, stderr_option };
    var stdio_action_fds = [_]c_int{ -1, -1, -1 };
    defer for (&stdio_action_fds) |*fd| closePosixSpawnFd(fd);
    for (stdio_options, 0..) |option, target_fd| {
        switch (option) {
            .file => |file| {
                const source_fd: c_int = @intCast(file.handle);
                if (source_fd == target_fd) continue;
                stdio_action_fds[target_fd] = c.fcntl(
                    source_fd,
                    c.F_DUPFD_CLOEXEC,
                    @as(c_int, std.posix.STDERR_FILENO + 1),
                );
                if (stdio_action_fds[target_fd] < 0) return error.Unexpected;
            },
            else => {},
        }
    }

    if (cwd) |cwd_path| try checkPosixSpawnResult(c.posix_spawn_file_actions_addchdir_np(&actions, cwd_path));
    try addPosixSpawnStdioAction(&actions, stdin_option, stdin_pipe[0], stdio_action_fds[0], std.posix.STDIN_FILENO, true);
    try addPosixSpawnStdioAction(&actions, stdout_option, stdout_pipe[1], stdio_action_fds[1], std.posix.STDOUT_FILENO, false);
    try addPosixSpawnStdioAction(&actions, stderr_option, stderr_pipe[1], stdio_action_fds[2], std.posix.STDERR_FILENO, false);

    if (stdin_pipe[1] >= 0) try checkPosixSpawnResult(c.posix_spawn_file_actions_addclose(&actions, stdin_pipe[1]));
    if (stdout_pipe[0] >= 0) try checkPosixSpawnResult(c.posix_spawn_file_actions_addclose(&actions, stdout_pipe[0]));
    if (stderr_pipe[0] >= 0) try checkPosixSpawnResult(c.posix_spawn_file_actions_addclose(&actions, stderr_pipe[0]));
    if (stdin_pipe[0] >= 0) try checkPosixSpawnResult(c.posix_spawn_file_actions_addclose(&actions, stdin_pipe[0]));
    if (stdout_pipe[1] >= 0) try checkPosixSpawnResult(c.posix_spawn_file_actions_addclose(&actions, stdout_pipe[1]));
    if (stderr_pipe[1] >= 0) try checkPosixSpawnResult(c.posix_spawn_file_actions_addclose(&actions, stderr_pipe[1]));
    for (stdio_action_fds) |fd| {
        if (fd >= 0) try checkPosixSpawnResult(c.posix_spawn_file_actions_addclose(&actions, fd));
    }

    var resolved_executable: ?[:0]u8 = null;
    defer if (resolved_executable) |path| gpa.free(path);
    if (cwd) |cwd_path| {
        const executable_slice = std.mem.span(executable);
        if (!std.fs.path.isAbsolute(executable_slice) and std.mem.indexOfScalar(u8, executable_slice, '/') != null) {
            resolved_executable = try std.fs.path.joinZ(gpa, &.{ std.mem.span(cwd_path), executable_slice });
        }
    }
    const spawn_file = if (resolved_executable) |path| path.ptr else executable;
    var pid: std.posix.pid_t = -1;
    const spawn_result = spawn: {
        if (comptime builtin.os.tag == .linux) {
            var attributes: c.posix_spawnattr_t = undefined;
            try checkPosixSpawnResult(c.posix_spawnattr_init(&attributes));
            defer _ = c.posix_spawnattr_destroy(&attributes);

            var default_signals: c.sigset_t = undefined;
            var signal_mask: c.sigset_t = undefined;
            _ = c.sigemptyset(&default_signals);
            _ = c.sigemptyset(&signal_mask);
            var signal_number: c_int = 1;
            while (signal_number < c.NSIG) : (signal_number += 1) {
                if (signal_number != c.SIGKILL and signal_number != c.SIGSTOP) {
                    _ = c.sigaddset(&default_signals, signal_number);
                }
            }
            try checkPosixSpawnResult(c.posix_spawnattr_setsigdefault(&attributes, &default_signals));
            try checkPosixSpawnResult(c.posix_spawnattr_setsigmask(&attributes, &signal_mask));
            var flags: c_short = @intCast(c.POSIX_SPAWN_SETSIGDEF | c.POSIX_SPAWN_SETSIGMASK);
            if (create_process_group) {
                try checkPosixSpawnResult(c.posix_spawnattr_setpgroup(&attributes, 0));
                flags |= @intCast(c.POSIX_SPAWN_SETPGROUP);
            }
            try checkPosixSpawnResult(c.posix_spawnattr_setflags(&attributes, flags));
            break :spawn if (resolved_executable != null or std.mem.indexOfScalar(u8, std.mem.span(executable), '/') != null)
                c.posix_spawn(&pid, spawn_file, &actions, &attributes, @ptrCast(argv_z.ptr), @ptrCast(envp))
            else
                c.posix_spawnp(&pid, spawn_file, &actions, &attributes, @ptrCast(argv_z.ptr), @ptrCast(envp));
        }
        break :spawn if (resolved_executable != null or std.mem.indexOfScalar(u8, std.mem.span(executable), '/') != null)
            c.posix_spawn(&pid, spawn_file, &actions, null, @ptrCast(argv_z.ptr), @ptrCast(envp))
        else
            c.posix_spawnp(&pid, spawn_file, &actions, null, @ptrCast(argv_z.ptr), @ptrCast(envp));
    };
    try checkPosixSpawnResult(spawn_result);

    closePosixSpawnFd(&stdin_pipe[0]);
    closePosixSpawnFd(&stdout_pipe[1]);
    closePosixSpawnFd(&stderr_pipe[1]);

    return .{
        .id = pid,
        .thread_handle = {},
        .stdin = if (stdin_option == .pipe) .{ .handle = stdin_pipe[1], .flags = .{ .nonblocking = false } } else null,
        .stdout = if (stdout_option == .pipe) .{ .handle = stdout_pipe[0], .flags = .{ .nonblocking = false } } else null,
        .stderr = if (stderr_option == .pipe) .{ .handle = stderr_pipe[0], .flags = .{ .nonblocking = false } } else null,
        .request_resource_usage_statistics = true,
    };
}

fn createSpawnMemfd(name: []const u8, append: bool) ?std.Io.File {
    if (comptime builtin.os.tag != .linux) return null;
    const fd = std.posix.memfd_create(name, 0) catch return null;
    if (append) {
        const current_flags = c.fcntl(fd, c.F_GETFL);
        if (current_flags < 0) {
            _ = c.close(fd);
            return null;
        }
        if (c.fcntl(fd, c.F_SETFL, current_flags | c.O_APPEND) < 0) {
            _ = c.close(fd);
            return null;
        }
    }
    return .{ .handle = fd, .flags = .{ .nonblocking = false } };
}

fn readSpawnMemfd(file: std.Io.File, io: std.Io, output: *std.ArrayList(u8)) !void {
    const length = try file.length(io);
    if (length > std.math.maxInt(usize)) return error.FileTooBig;
    try output.resize(std.heap.c_allocator, @intCast(length));
    output.items.len = try file.readPositionalAll(io, output.items, 0);
}

fn shouldCreateNoWindow(stdin_mode: c_int, stdout_mode: c_int, stderr_mode: c_int) bool {
    const inherit = @intFromEnum(SpawnStdio.inherit);
    return stdin_mode != inherit and stdout_mode != inherit and stderr_mode != inherit;
}

test "spawn window policy preserves inherited stdio" {
    const pipe = @intFromEnum(SpawnStdio.pipe);
    const inherit = @intFromEnum(SpawnStdio.inherit);
    const ignore = @intFromEnum(SpawnStdio.ignore);

    try std.testing.expect(shouldCreateNoWindow(ignore, pipe, pipe));
    try std.testing.expect(!shouldCreateNoWindow(inherit, pipe, pipe));
    try std.testing.expect(!shouldCreateNoWindow(ignore, inherit, pipe));
    try std.testing.expect(!shouldCreateNoWindow(ignore, pipe, inherit));
}

fn processId(id: std.process.Child.Id) u64 {
    if (comptime builtin.os.tag == .windows) {
        const windows = std.os.windows;
        var info: windows.PROCESS.BASIC_INFORMATION = undefined;
        return switch (windows.ntdll.NtQueryInformationProcess(
            id,
            .BasicInformation,
            &info,
            @sizeOf(windows.PROCESS.BASIC_INFORMATION),
            null,
        )) {
            .SUCCESS => @intCast(info.UniqueProcessId),
            else => 0,
        };
    }

    return @intCast(id);
}

fn rawTerminateProcess(id: std.process.Child.Id, signal_code: c_int, process_group: bool) void {
    if (signal_code == 0) return;

    if (comptime builtin.os.tag == .windows) {
        const windows = std.os.windows;
        _ = windows.ntdll.NtTerminateProcess(
            id,
            @enumFromInt(@as(windows.UINT, @intCast(signal_code))),
        );
        return;
    }

    const signal: std.posix.SIG = @enumFromInt(@as(std.meta.Tag(std.posix.SIG), @intCast(signal_code)));
    if (comptime builtin.os.tag == .linux) {
        if (process_group) {
            std.posix.kill(-id, signal) catch {
                std.posix.kill(id, signal) catch {};
            };
            return;
        }
    }
    std.posix.kill(id, signal) catch {};
}

const SpawnControl = struct {
    io: std.Io,
    id: std.process.Child.Id,
    mutex: std.Io.Mutex = .init,
    alive: bool = true,
    kill_signal: c_int,
    process_group: bool,
    termination_reason: SpawnTerminationReason = .none,
    termination_requested_while_alive: bool = false,
    max_buffer_exceeded: bool = false,

    fn requestTermination(self: *SpawnControl, reason: SpawnTerminationReason) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);

        if (reason == .max_buffer) self.max_buffer_exceeded = true;
        if (self.termination_reason != .none) return;
        self.termination_reason = reason;
        if (!self.alive) return;
        self.termination_requested_while_alive = true;

        const signal_code = if (reason == .io_error and self.kill_signal == 0) 15 else self.kill_signal;
        rawTerminateProcess(self.id, signal_code, self.process_group);
    }

    fn markExited(self: *SpawnControl) void {
        self.mutex.lockUncancelable(self.io);
        self.alive = false;
        self.mutex.unlock(self.io);
    }
};

const SpawnReadContext = struct {
    io: std.Io,
    file: std.Io.File = undefined,
    control: *SpawnControl,
    max_buffer_enabled: bool,
    max_buffer: u64,
    output: std.ArrayList(u8) = .empty,
    error_name: ?[]const u8 = null,

    fn run(self: *SpawnReadContext) void {
        defer self.file.close(self.io);

        const gpa = std.heap.c_allocator;
        var buffer: [16 * 1024]u8 = undefined;
        while (true) {
            const count = self.file.readStreaming(self.io, &.{buffer[0..]}) catch |err| switch (err) {
                error.EndOfStream => break,
                else => {
                    self.error_name = @errorName(err);
                    self.control.requestTermination(.io_error);
                    break;
                },
            };
            if (count == 0) continue;

            self.output.appendSlice(gpa, buffer[0..count]) catch {
                self.error_name = "OutOfMemory";
                self.control.requestTermination(.io_error);
                break;
            };
            if (self.max_buffer_enabled and self.output.items.len > self.max_buffer) {
                self.control.requestTermination(.max_buffer);
            }
        }
    }
};

const SpawnWriteContext = struct {
    io: std.Io,
    file: std.Io.File = undefined,
    control: *SpawnControl,
    input: []const u8,
    error_name: ?[]const u8 = null,

    fn run(self: *SpawnWriteContext) void {
        defer self.file.close(self.io);
        self.file.writeStreamingAll(self.io, self.input) catch |err| switch (err) {
            error.BrokenPipe => {},
            else => {
                self.error_name = @errorName(err);
                self.control.requestTermination(.io_error);
            },
        };
    }
};

fn spawnReadThread(context: *SpawnReadContext) std.Thread.SpawnError!std.Thread {
    // Let libc account for platform TLS requirements. A fixed 256 KiB stack
    // is rejected with EINVAL on Linux ARM64 once JavaScriptCore is linked.
    const config: std.Thread.SpawnConfig = if (comptime builtin.os.tag == .linux)
        .{}
    else
        .{ .stack_size = 256 * 1024 };
    return std.Thread.spawn(config, SpawnReadContext.run, .{context});
}

fn spawnWriteThread(context: *SpawnWriteContext) std.Thread.SpawnError!std.Thread {
    const config: std.Thread.SpawnConfig = if (comptime builtin.os.tag == .linux)
        .{}
    else
        .{ .stack_size = 256 * 1024 };
    return std.Thread.spawn(config, SpawnWriteContext.run, .{context});
}

fn joinThread(thread: ?std.Thread) void {
    if (thread) |value| value.join();
}

fn closeChildPipes(child: *std.process.Child, io: std.Io) void {
    if (child.stdin) |file| file.close(io);
    if (child.stdout) |file| file.close(io);
    if (child.stderr) |file| file.close(io);
    child.stdin = null;
    child.stdout = null;
    child.stderr = null;
}

fn statusToTerm(status: u32) std.process.Child.Term {
    return if (std.posix.W.IFEXITED(status))
        .{ .exited = std.posix.W.EXITSTATUS(status) }
    else if (std.posix.W.IFSIGNALED(status))
        .{ .signal = std.posix.W.TERMSIG(status) }
    else if (std.posix.W.IFSTOPPED(status))
        .{ .stopped = std.posix.W.STOPSIG(status) }
    else
        .{ .unknown = status };
}

fn pollPosixChild(child: *std.process.Child, control: *SpawnControl) !?std.process.Child.Term {
    control.mutex.lockUncancelable(control.io);
    defer control.mutex.unlock(control.io);

    var status: if (builtin.link_libc) c_int else u32 = undefined;
    var usage: std.posix.rusage = undefined;
    while (true) {
        const rc = std.posix.system.wait4(
            child.id.?,
            &status,
            @intCast(std.posix.W.NOHANG),
            if (child.request_resource_usage_statistics) &usage else null,
        );
        switch (std.posix.errno(rc)) {
            .SUCCESS => {
                if (rc == 0) return null;
                if (child.request_resource_usage_statistics) {
                    child.resource_usage_statistics.rusage = usage;
                }
                control.alive = false;
                child.id = null;
                return statusToTerm(@bitCast(status));
            },
            .INTR => continue,
            else => |err| return std.posix.unexpectedErrno(err),
        }
    }
}

fn nonnegativeSpawnUsage(value: anytype) u64 {
    return if (value > 0) @intCast(value) else 0;
}

fn spawnCpuTimeMicros(value: std.posix.timeval) u64 {
    return nonnegativeSpawnUsage(value.sec) * 1_000_000 + nonnegativeSpawnUsage(value.usec);
}

fn populateSpawnResourceUsage(result: *CtHostSpawnResult, child: *const std.process.Child) void {
    if (comptime builtin.os.tag == .windows) {
        if (child.resource_usage_statistics.getMaxRss()) |max_rss| {
            result.resource_usage_present = true;
            result.max_rss = @intCast(max_rss);
        }
        return;
    }

    const supports_rusage = switch (builtin.os.tag) {
        .dragonfly,
        .freebsd,
        .netbsd,
        .openbsd,
        .illumos,
        .linux,
        .serenity,
        .driverkit,
        .ios,
        .maccatalyst,
        .macos,
        .tvos,
        .visionos,
        .watchos,
        => true,
        else => false,
    };
    if (comptime supports_rusage) {
        if (child.resource_usage_statistics.rusage) |usage| {
            result.resource_usage_present = true;
            result.user_cpu_time = spawnCpuTimeMicros(usage.utime);
            result.system_cpu_time = spawnCpuTimeMicros(usage.stime);
            result.max_rss = @intCast(child.resource_usage_statistics.getMaxRss() orelse 0);
            result.shared_memory_size = nonnegativeSpawnUsage(usage.ixrss);
            result.swapped_out = nonnegativeSpawnUsage(usage.nswap);
            result.fs_read = nonnegativeSpawnUsage(usage.inblock);
            result.fs_write = nonnegativeSpawnUsage(usage.oublock);
            result.ipc_sent = nonnegativeSpawnUsage(usage.msgsnd);
            result.ipc_received = nonnegativeSpawnUsage(usage.msgrcv);
            result.signals_count = nonnegativeSpawnUsage(usage.nsignals);
            result.voluntary_context_switches = nonnegativeSpawnUsage(usage.nvcsw);
            result.involuntary_context_switches = nonnegativeSpawnUsage(usage.nivcsw);
        }
    }
}

fn pollWindowsChild(child: *std.process.Child, control: *SpawnControl) !bool {
    const windows = std.os.windows;
    control.mutex.lockUncancelable(control.io);
    defer control.mutex.unlock(control.io);

    var timeout: windows.LARGE_INTEGER = 0;
    return switch (windows.ntdll.NtWaitForSingleObject(child.id.?, .FALSE, &timeout)) {
        windows.NTSTATUS.WAIT_0 => result: {
            control.alive = false;
            break :result true;
        },
        .TIMEOUT => false,
        else => |status| windows.unexpectedStatus(status),
    };
}

fn waitForConstrainedChild(
    child: *std.process.Child,
    control: *SpawnControl,
    timeout_enabled: bool,
    timeout_ms: u64,
    abort_requested: bool,
) !std.process.Child.Term {
    const started_at = std.Io.Clock.awake.now(control.io);
    const timeout_duration = std.Io.Duration.fromMilliseconds(@intCast(timeout_ms));
    const deadline = started_at.addDuration(timeout_duration);
    var abort_sent = false;

    while (true) {
        if (comptime builtin.os.tag == .windows) {
            if (try pollWindowsChild(child, control)) return child.wait(control.io);
        } else {
            if (try pollPosixChild(child, control)) |term| return term;
        }

        if (abort_requested and !abort_sent) {
            abort_sent = true;
            control.requestTermination(.abort_signal);
        } else if (timeout_enabled and std.Io.Clock.awake.now(control.io).nanoseconds >= deadline.nanoseconds) {
            control.requestTermination(.timeout);
        }

        std.Io.sleep(control.io, .fromMilliseconds(1), .awake) catch {};
    }
}

fn appendPemCertificate(
    output: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    der_bytes: []const u8,
) !void {
    try output.appendSlice(allocator, "-----BEGIN CERTIFICATE-----\n");

    const encoder = std.base64.standard.Encoder;
    var offset: usize = 0;
    while (offset < der_bytes.len) {
        // 48 input bytes encode to one conventional 64-column PEM line.
        const end = @min(offset + 48, der_bytes.len);
        const chunk = der_bytes[offset..end];
        const encoded = try output.addManyAsSlice(allocator, encoder.calcSize(chunk.len));
        _ = encoder.encode(encoded, chunk);
        try output.append(allocator, '\n');
        offset = end;
    }

    try output.appendSlice(allocator, "-----END CERTIFICATE-----");
}

fn windowsSystemRootCertificates() ![:0]u8 {
    const allocator = std.heap.c_allocator;
    var bundle: std.crypto.Certificate.Bundle = .empty;
    defer bundle.deinit(allocator);
    try bundle.rescan(allocator, getIo(), std.Io.Clock.real.now(getIo()));

    var offsets: std.ArrayList(u32) = .empty;
    defer offsets.deinit(allocator);
    var iterator = bundle.map.valueIterator();
    while (iterator.next()) |offset| {
        try offsets.append(allocator, offset.*);
    }
    if (offsets.items.len == 0) return error.CertificateAuthorityBundleEmpty;
    std.mem.sort(u32, offsets.items, {}, std.sort.asc(u32));

    var pem: std.ArrayList(u8) = .empty;
    errdefer pem.deinit(allocator);
    for (offsets.items, 0..) |start, index| {
        const end: usize = if (index + 1 < offsets.items.len)
            offsets.items[index + 1]
        else
            bundle.bytes.items.len;
        if (index > 0) try pem.append(allocator, '\n');
        try appendPemCertificate(&pem, allocator, bundle.bytes.items[start..end]);
    }
    return pem.toOwnedSliceSentinel(allocator, 0);
}

pub export fn ct_host_system_root_certificates(error_out: *?[*:0]u8) ?[*:0]u8 {
    error_out.* = null;
    if (comptime builtin.os.tag != .windows) return null;

    const pem = windowsSystemRootCertificates() catch |err| {
        setFormattedErrorOut(error_out, "Unable to load Windows system certificates: {s}", .{@errorName(err)});
        return null;
    };
    return pem.ptr;
}

pub export fn ct_host_string_free(value: ?[*:0]u8) void {
    if (value) |ptr| {
        c.free(@ptrCast(ptr));
    }
}

pub export fn ct_host_buffer_free(value: ?[*]u8) void {
    if (value) |ptr| {
        c.free(@ptrCast(ptr));
    }
}

pub export fn ct_host_exists(path: [*:0]const u8) bool {
    const sub_path = std.mem.span(path);
    if (comptime builtin.os.tag == .windows) {
        return windowsPathAttributes(sub_path) != null;
    }
    std.Io.Dir.cwd().access(getIo(), sub_path, .{}) catch return false;
    return true;
}

pub export fn ct_host_mime_type_by_extension(
    extension_ptr: [*]const u8,
    extension_len: usize,
    result_len_out: *usize,
) [*]const u8 {
    const mime_type = compiler.http.MimeType.byExtension(extension_ptr[0..extension_len]);
    result_len_out.* = mime_type.value.len;
    return mime_type.value.ptr;
}

const fs_walk_magic = "CTFW";

// Wire format: magic, entry count, then mode/descend and four length-prefixed
// strings (name, full path, parent path, relative path) for each entry.
fn appendU32Le(output: *std.ArrayList(u8), allocator: std.mem.Allocator, value: u32) !void {
    try output.appendSlice(allocator, &.{
        @truncate(value),
        @truncate(value >> 8),
        @truncate(value >> 16),
        @truncate(value >> 24),
    });
}

fn appendWalkString(
    output: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    value: []const u8,
) !void {
    if (value.len > std.math.maxInt(u32)) return error.NameTooLong;
    try appendU32Le(output, allocator, @intCast(value.len));
    try output.appendSlice(allocator, value);
}

fn fileKindMode(kind: std.Io.File.Kind) u32 {
    return switch (kind) {
        .named_pipe => 0o010000,
        .character_device => 0o020000,
        .directory => 0o040000,
        .block_device => 0o060000,
        .file => 0o100000,
        .sym_link => 0o120000,
        .unix_domain_socket => 0o140000,
        else => 0,
    };
}

const FsWalkContext = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    output: *std.ArrayList(u8),
    seen_directories: *std.StringHashMap(void),
    count: u32 = 0,
    error_path: ?[]const u8 = null,
    error_syscall: []const u8 = "scandir",

    fn appendEntry(
        self: *FsWalkContext,
        name: []const u8,
        full_path: []const u8,
        parent_path: []const u8,
        relative_path: []const u8,
        mode: u32,
        descends: bool,
    ) !void {
        if (self.count == std.math.maxInt(u32)) return error.TooManyFiles;
        const output_allocator = std.heap.c_allocator;
        try appendU32Le(self.output, output_allocator, mode);
        try self.output.append(output_allocator, @intFromBool(descends));
        try appendWalkString(self.output, output_allocator, name);
        try appendWalkString(self.output, output_allocator, full_path);
        try appendWalkString(self.output, output_allocator, parent_path);
        try appendWalkString(self.output, output_allocator, relative_path);
        self.count += 1;
    }

    fn walk(self: *FsWalkContext, directory: []const u8, prefix: []const u8) !void {
        const cwd = std.Io.Dir.cwd();
        var dir = cwd.openDir(self.io, directory, .{ .iterate = true }) catch |err| {
            self.error_path = directory;
            self.error_syscall = "scandir";
            return err;
        };
        defer dir.close(self.io);

        var iterator = dir.iterate();
        while (iterator.next(self.io) catch |err| {
            self.error_path = directory;
            self.error_syscall = "scandir";
            return err;
        }) |entry| {
            const name = try self.allocator.dupe(u8, entry.name);
            const full_path = try std.fs.path.join(self.allocator, &.{ directory, name });
            const relative_path = if (prefix.len == 0)
                try self.allocator.dupe(u8, name)
            else
                try std.fmt.allocPrint(self.allocator, "{s}/{s}", .{ prefix, name });

            const link_stat = cwd.statFile(self.io, full_path, .{ .follow_symlinks = false }) catch |err| {
                self.error_path = full_path;
                self.error_syscall = "lstat";
                return err;
            };
            var descends = link_stat.kind == .directory;
            if (!descends and link_stat.kind == .sym_link) {
                const followed = cwd.statFile(self.io, full_path, .{ .follow_symlinks = true }) catch null;
                descends = followed != null and followed.?.kind == .directory;
            }

            try self.appendEntry(
                name,
                full_path,
                directory,
                relative_path,
                fileKindMode(link_stat.kind),
                descends,
            );
            if (!descends) continue;

            const canonical = cwd.realPathFileAlloc(self.io, full_path, self.allocator) catch
                try self.allocator.dupeZ(u8, full_path);
            if (self.seen_directories.contains(canonical)) continue;
            try self.seen_directories.put(canonical, {});
            try self.walk(full_path, relative_path);
        }
    }
};

pub export fn ct_host_walk_dir(
    root: [*:0]const u8,
    prefix: [*:0]const u8,
    output_len: *usize,
    error_out: *?[*:0]u8,
    error_path_out: *?[*:0]u8,
    error_syscall_out: *?[*:0]u8,
) ?[*]u8 {
    output_len.* = 0;
    error_out.* = null;
    error_path_out.* = null;
    error_syscall_out.* = null;

    var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const root_path = std.mem.span(root);

    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(std.heap.c_allocator);
    output.appendSlice(std.heap.c_allocator, fs_walk_magic) catch {
        setErrorOut(error_out, "OutOfMemory");
        return null;
    };
    appendU32Le(&output, std.heap.c_allocator, 0) catch {
        setErrorOut(error_out, "OutOfMemory");
        return null;
    };

    var seen_directories = std.StringHashMap(void).init(allocator);
    defer seen_directories.deinit();
    const cwd = std.Io.Dir.cwd();
    if (cwd.realPathFileAlloc(getIo(), root_path, allocator)) |canonical_root| {
        seen_directories.put(canonical_root, {}) catch {
            setErrorOut(error_out, "OutOfMemory");
            return null;
        };
    } else |_| {}

    var context: FsWalkContext = .{
        .allocator = allocator,
        .io = getIo(),
        .output = &output,
        .seen_directories = &seen_directories,
    };
    context.walk(root_path, std.mem.span(prefix)) catch |err| {
        setFormattedErrorOut(error_out, "{s}: {s}", .{ @errorName(err), root_path });
        setErrorOut(error_path_out, context.error_path orelse root_path);
        setErrorOut(error_syscall_out, context.error_syscall);
        return null;
    };

    output.items[4] = @truncate(context.count);
    output.items[5] = @truncate(context.count >> 8);
    output.items[6] = @truncate(context.count >> 16);
    output.items[7] = @truncate(context.count >> 24);
    const owned = output.toOwnedSlice(std.heap.c_allocator) catch {
        setErrorOut(error_out, "OutOfMemory");
        return null;
    };
    output_len.* = owned.len;
    return owned.ptr;
}

const NativeCopyContext = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    recursive: bool,
    force: bool,
    error_on_exist: bool,
    error_path: ?[]const u8 = null,
    error_destination: ?[]const u8 = null,
    error_syscall: []const u8 = "cp",

    fn pathsEqual(left: []const u8, right: []const u8) bool {
        if (comptime builtin.os.tag == .windows) {
            return std.ascii.eqlIgnoreCase(left, right);
        }
        return std.mem.eql(u8, left, right);
    }

    fn isSubdirectory(parent: []const u8, candidate: []const u8) bool {
        if (candidate.len <= parent.len) return false;
        const prefix_matches = if (comptime builtin.os.tag == .windows)
            std.ascii.eqlIgnoreCase(parent, candidate[0..parent.len])
        else
            std.mem.eql(u8, parent, candidate[0..parent.len]);
        if (!prefix_matches) return false;
        return std.fs.path.isSep(parent[parent.len - 1]) or
            std.fs.path.isSep(candidate[parent.len]);
    }

    fn fail(
        self: *NativeCopyContext,
        source: []const u8,
        destination: []const u8,
        syscall: []const u8,
        err: anyerror,
    ) anyerror {
        self.error_path = source;
        self.error_destination = destination;
        self.error_syscall = syscall;
        return err;
    }

    fn statIfPresent(
        self: *NativeCopyContext,
        path: []const u8,
        follow_symlinks: bool,
        source: []const u8,
        destination: []const u8,
    ) !?std.Io.File.Stat {
        return std.Io.Dir.cwd().statFile(self.io, path, .{
            .follow_symlinks = follow_symlinks,
        }) catch |err| switch (err) {
            error.FileNotFound => null,
            else => return self.fail(source, destination, "lstat", err),
        };
    }

    fn setCopiedPermissions(
        self: *NativeCopyContext,
        source: []const u8,
        destination: [:0]const u8,
        permissions: std.Io.File.Permissions,
        is_directory: bool,
    ) !void {
        if (comptime builtin.os.tag == .windows) {
            const mode = windowsCopiedMode(permissions, is_directory);
            const code = ct_native_chmod(destination.ptr, mode);
            if (code != 0) return self.fail(source, destination, "chmod", nativeChmodError(code));
            return;
        }
        std.Io.Dir.cwd().setFilePermissions(self.io, destination, permissions, .{}) catch |err|
            return self.fail(source, destination, "chmod", err);
    }

    fn copyFileBytes(
        self: *NativeCopyContext,
        source: []const u8,
        destination: []const u8,
        exclusive: bool,
    ) !void {
        const source_z = self.allocator.dupeZ(u8, source) catch |err|
            return self.fail(source, destination, "copyfile", err);
        const destination_z = self.allocator.dupeZ(u8, destination) catch |err|
            return self.fail(source, destination, "copyfile", err);
        if (ct_native_copy_file(source_z.ptr, destination_z.ptr, @intFromBool(exclusive)) == 0) {
            return;
        }

        const cwd = std.Io.Dir.cwd();
        const source_file = cwd.openFile(self.io, source, .{}) catch |err|
            return self.fail(source, destination, "open", err);
        defer source_file.close(self.io);

        const source_stat = source_file.stat(self.io) catch |err|
            return self.fail(source, destination, "fstat", err);
        if (source_stat.kind != .file and
            source_stat.kind != .block_device and
            source_stat.kind != .character_device)
        {
            return self.fail(source, destination, "copyfile", error.OperationUnsupported);
        }

        const destination_file = cwd.createFile(self.io, destination, .{
            .truncate = true,
            .exclusive = exclusive,
            .permissions = source_stat.permissions,
        }) catch |err| return self.fail(source, destination, "open", err);
        defer destination_file.close(self.io);

        var source_reader: std.Io.File.Reader = .init(source_file, self.io, &.{});
        if (source_stat.kind == .file) source_reader.size = source_stat.size;
        var buffer: [64 * 1024]u8 = undefined;
        var destination_writer = destination_file.writer(self.io, &buffer);
        _ = destination_writer.interface.sendFileAll(&source_reader, .unlimited) catch |err| switch (err) {
            error.ReadFailed => return self.fail(source, destination, "read", source_reader.err.?),
            error.WriteFailed => return self.fail(source, destination, "write", destination_writer.err.?),
        };
        destination_writer.flush() catch |err|
            return self.fail(source, destination, "write", err);
        try self.setCopiedPermissions(source, destination_z, source_stat.permissions, false);
    }

    fn copySymlink(
        self: *NativeCopyContext,
        source: []const u8,
        destination: []const u8,
        destination_stat: ?std.Io.File.Stat,
        replace_cloned: bool,
    ) !void {
        const cwd = std.Io.Dir.cwd();
        if (destination_stat) |existing| {
            if (!replace_cloned and !self.force) {
                if (self.error_on_exist) {
                    return self.fail(source, destination, "symlink", error.PathAlreadyExists);
                }
                return;
            }
            if (existing.kind != .sym_link) {
                return self.fail(source, destination, "symlink", error.PathAlreadyExists);
            }
        }

        var target_buffer: [std.fs.max_path_bytes]u8 = undefined;
        const target_len = cwd.readLink(self.io, source, &target_buffer) catch |err|
            return self.fail(source, destination, "readlink", err);
        const raw_target = target_buffer[0..target_len];
        const target = if (std.fs.path.isAbsolute(raw_target))
            raw_target
        else
            std.fs.path.resolve(
                self.allocator,
                &.{ std.fs.path.dirname(source) orelse ".", raw_target },
            ) catch |err| return self.fail(source, destination, "symlink", err);
        const followed_source: ?std.Io.File.Stat = cwd.statFile(self.io, source, .{
            .follow_symlinks = true,
        }) catch null;
        const target_is_directory = if (followed_source) |stat|
            stat.kind == .directory
        else
            false;

        if (destination_stat != null) {
            var destination_target_buffer: [std.fs.max_path_bytes]u8 = undefined;
            const destination_target_len = cwd.readLink(
                self.io,
                destination,
                &destination_target_buffer,
            ) catch |err| return self.fail(source, destination, "readlink", err);
            const raw_destination_target = destination_target_buffer[0..destination_target_len];
            const destination_target = if (std.fs.path.isAbsolute(raw_destination_target))
                raw_destination_target
            else
                std.fs.path.resolve(
                    self.allocator,
                    &.{ std.fs.path.dirname(destination) orelse ".", raw_destination_target },
                ) catch |err| return self.fail(source, destination, "symlink", err);
            if (target_is_directory) {
                if (pathsEqual(target, destination_target)) {
                    if (replace_cloned) return; // clone already produced the desired link
                    return self.fail(source, destination, "cp", error.CopyInvalid);
                }
                if (isSubdirectory(target, destination_target) or
                    isSubdirectory(destination_target, target))
                {
                    return self.fail(source, destination, "cp", error.SymlinkToSubdirectory);
                }
            }
            cwd.deleteFile(self.io, destination) catch |err|
                return self.fail(source, destination, "unlink", err);
        }
        cwd.symLink(self.io, target, destination, .{
            .is_directory = target_is_directory,
        }) catch |err| return self.fail(source, destination, "symlink", err);
    }

    fn normalizeClonedSymlinks(
        self: *NativeCopyContext,
        source: [:0]const u8,
        destination: [:0]const u8,
    ) !void {
        const cwd = std.Io.Dir.cwd();
        var directory = cwd.openDir(self.io, source, .{ .iterate = true }) catch |err|
            return self.fail(source, destination, "scandir", err);
        defer directory.close(self.io);
        var iterator = directory.iterate();
        while (iterator.next(self.io) catch |err|
            return self.fail(source, destination, "scandir", err)) |entry|
        {
            const child_source = std.fs.path.joinZ(self.allocator, &.{ source, entry.name }) catch |err|
                return self.fail(source, destination, "cp", err);
            const child_destination = std.fs.path.joinZ(self.allocator, &.{ destination, entry.name }) catch |err|
                return self.fail(source, destination, "cp", err);
            const child_stat = cwd.statFile(self.io, child_source, .{
                .follow_symlinks = false,
            }) catch |err| return self.fail(child_source, child_destination, "lstat", err);
            switch (child_stat.kind) {
                .directory => try self.normalizeClonedSymlinks(child_source, child_destination),
                .sym_link => {
                    const destination_stat = try self.statIfPresent(
                        child_destination,
                        false,
                        child_source,
                        child_destination,
                    );
                    try self.copySymlink(child_source, child_destination, destination_stat, true);
                },
                else => {},
            }
        }
    }

    fn copyEntry(self: *NativeCopyContext, source: [:0]const u8, destination: [:0]const u8) !void {
        const cwd = std.Io.Dir.cwd();
        const source_stat = cwd.statFile(self.io, source, .{
            .follow_symlinks = false,
        }) catch |err| return self.fail(source, destination, "lstat", err);
        const destination_stat = try self.statIfPresent(destination, false, source, destination);

        if (destination_stat) |existing| {
            if (source_stat.inode == existing.inode and
                ct_paths_are_same_file(source.ptr, destination.ptr) != 0)
            {
                return;
            }
            if (source_stat.kind == .directory and existing.kind != .directory) {
                return self.fail(source, destination, "cp", error.IsDir);
            }
            if (source_stat.kind != .directory and existing.kind == .directory) {
                return self.fail(source, destination, "cp", error.NotDir);
            }
        }

        switch (source_stat.kind) {
            .directory => {
                if (!self.recursive) {
                    return self.fail(source, destination, "cp", error.IsDir);
                }
                const created = destination_stat == null;
                if (created and ct_native_clone_tree(source.ptr, destination.ptr) == 0) {
                    try self.normalizeClonedSymlinks(source, destination);
                    return;
                }
                if (created) {
                    cwd.createDir(self.io, destination, .default_dir) catch |err|
                        return self.fail(source, destination, "mkdir", err);
                }

                var directory = cwd.openDir(self.io, source, .{ .iterate = true }) catch |err|
                    return self.fail(source, destination, "scandir", err);
                defer directory.close(self.io);
                var iterator = directory.iterate();
                while (iterator.next(self.io) catch |err|
                    return self.fail(source, destination, "scandir", err)) |entry|
                {
                    const child_source = std.fs.path.joinZ(self.allocator, &.{ source, entry.name }) catch |err|
                        return self.fail(source, destination, "cp", err);
                    const child_destination = std.fs.path.joinZ(self.allocator, &.{ destination, entry.name }) catch |err|
                        return self.fail(source, destination, "cp", err);
                    try self.copyEntry(child_source, child_destination);
                }

                if (created) try self.setCopiedPermissions(
                    source,
                    destination,
                    source_stat.permissions,
                    true,
                );
            },
            .file, .block_device, .character_device => {
                if (destination_stat != null) {
                    if (!self.force) {
                        if (self.error_on_exist) {
                            return self.fail(source, destination, "copyfile", error.PathAlreadyExists);
                        }
                        return;
                    }
                    cwd.deleteFile(self.io, destination) catch |err|
                        return self.fail(source, destination, "unlink", err);
                }
                try self.copyFileBytes(source, destination, false);
            },
            .sym_link => try self.copySymlink(source, destination, destination_stat, false),
            .named_pipe, .unix_domain_socket, .whiteout, .door, .event_port, .unknown => {
                return self.fail(source, destination, "cp", error.InvalidArgument);
            },
        }
    }
};

fn windowsCopiedMode(permissions: std.Io.File.Permissions, is_directory: bool) c_uint {
    const read_only = permissions.toAttributes().READONLY;
    return if (read_only)
        (if (is_directory) 0o555 else 0o444)
    else
        (if (is_directory) 0o777 else 0o666);
}

test "Windows copied permissions preserve the read-only attribute" {
    if (builtin.os.tag != .windows) return error.SkipZigTest;

    const writable: std.Io.File.Permissions = @enumFromInt(0);
    const read_only: std.Io.File.Permissions = @enumFromInt(1);
    try std.testing.expectEqual(@as(c_uint, 0o666), windowsCopiedMode(writable, false));
    try std.testing.expectEqual(@as(c_uint, 0o444), windowsCopiedMode(read_only, false));
    try std.testing.expectEqual(@as(c_uint, 0o777), windowsCopiedMode(writable, true));
    try std.testing.expectEqual(@as(c_uint, 0o555), windowsCopiedMode(read_only, true));
}

fn setNativeCopyError(
    error_out: *?[*:0]u8,
    error_path_out: *?[*:0]u8,
    error_destination_out: *?[*:0]u8,
    error_syscall_out: *?[*:0]u8,
    context: *const NativeCopyContext,
    err: anyerror,
) void {
    setErrorOut(error_out, @errorName(err));
    if (context.error_path) |path| setErrorOut(error_path_out, path);
    if (context.error_destination) |destination| setErrorOut(error_destination_out, destination);
    setErrorOut(error_syscall_out, context.error_syscall);
}

pub export fn ct_host_copy_file(
    source: [*:0]const u8,
    destination: [*:0]const u8,
    exclusive: bool,
    error_out: *?[*:0]u8,
    error_path_out: *?[*:0]u8,
    error_destination_out: *?[*:0]u8,
    error_syscall_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    error_path_out.* = null;
    error_destination_out.* = null;
    error_syscall_out.* = null;

    var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena.deinit();
    var context: NativeCopyContext = .{
        .allocator = arena.allocator(),
        .io = getIo(),
        .recursive = false,
        .force = !exclusive,
        .error_on_exist = exclusive,
    };
    context.copyFileBytes(std.mem.span(source), std.mem.span(destination), exclusive) catch |err| {
        setNativeCopyError(
            error_out,
            error_path_out,
            error_destination_out,
            error_syscall_out,
            &context,
            err,
        );
        return -1;
    };
    return 0;
}

pub export fn ct_host_copy_tree(
    source: [*:0]const u8,
    destination: [*:0]const u8,
    recursive: bool,
    force: bool,
    error_on_exist: bool,
    error_out: *?[*:0]u8,
    error_path_out: *?[*:0]u8,
    error_destination_out: *?[*:0]u8,
    error_syscall_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    error_path_out.* = null;
    error_destination_out.* = null;
    error_syscall_out.* = null;

    var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena.deinit();
    var context: NativeCopyContext = .{
        .allocator = arena.allocator(),
        .io = getIo(),
        .recursive = recursive,
        .force = force,
        .error_on_exist = error_on_exist,
    };
    context.copyEntry(std.mem.span(source), std.mem.span(destination)) catch |err| {
        setNativeCopyError(
            error_out,
            error_path_out,
            error_destination_out,
            error_syscall_out,
            &context,
            err,
        );
        return -1;
    };
    return 0;
}

pub export fn ct_host_mkdir(path: [*:0]const u8, recursive: bool, error_out: *?[*:0]u8) c_int {
    error_out.* = null;

    const cwd = std.Io.Dir.cwd();
    const sub_path = std.mem.span(path);

    if (recursive) {
        cwd.createDirPath(getIo(), sub_path) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };
    } else {
        cwd.createDir(getIo(), sub_path, .default_dir) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };
    }

    return 0;
}

pub export fn ct_host_rm(
    path: [*:0]const u8,
    recursive: bool,
    force: bool,
    max_retries: u32,
    retry_delay_ms: u32,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;

    const cwd = std.Io.Dir.cwd();
    const sub_path = std.mem.span(path);
    const io = getIo();

    if (recursive and !force) {
        _ = cwd.statFile(io, sub_path, .{ .follow_symlinks = false }) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };
    }

    var attempt: u32 = 0;
    while (true) {
        const result = if (recursive)
            cwd.deleteTree(io, sub_path)
        else
            cwd.deleteFile(io, sub_path);
        result catch |err| {
            if (force and err == error.FileNotFound) return 0;
            const retryable = blk: {
                const name = @errorName(err);
                break :blk std.mem.eql(u8, name, "FileBusy") or
                    std.mem.eql(u8, name, "DirNotEmpty") or
                    std.mem.eql(u8, name, "ProcessFdQuotaExceeded") or
                    std.mem.eql(u8, name, "SystemFdQuotaExceeded") or
                    std.mem.eql(u8, name, "PermissionDenied") or
                    std.mem.eql(u8, name, "AccessDenied");
            };
            if (!recursive or !retryable or attempt >= max_retries) {
                setErrorOut(error_out, @errorName(err));
                return -1;
            }
            attempt += 1;
            const delay_ms = @as(u64, retry_delay_ms) * @as(u64, attempt);
            std.Io.sleep(
                io,
                .fromMilliseconds(@intCast(@min(delay_ms, std.math.maxInt(i64)))),
                .awake,
            ) catch {};
            continue;
        };
        return 0;
    }
}

pub export fn ct_host_rmdir(path: [*:0]const u8, error_out: *?[*:0]u8) c_int {
    error_out.* = null;

    std.Io.Dir.cwd().deleteDir(getIo(), std.mem.span(path)) catch |err| {
        setErrorOut(error_out, @errorName(err));
        return -1;
    };

    return 0;
}

pub export fn ct_host_unlink(path: [*:0]const u8, error_out: *?[*:0]u8) c_int {
    error_out.* = null;

    const cwd = std.Io.Dir.cwd();
    const sub_path = std.mem.span(path);

    if (comptime builtin.os.tag == .windows) {
        const attributes = windowsPathAttributes(sub_path);
        if (attributes != null and attributes.?.DIRECTORY and attributes.?.REPARSE_POINT) {
            const tag = windowsDirectoryLinkTag(sub_path);
            if (tag == null or !isWindowsDirectoryLinkTag(tag.?)) {
                setErrorOut(error_out, "IsDir");
                return -1;
            }
            cwd.deleteDir(getIo(), sub_path) catch |err| {
                setErrorOut(error_out, @errorName(err));
                return -1;
            };
            return 0;
        }
    }

    cwd.deleteFile(getIo(), sub_path) catch |err| {
        setErrorOut(error_out, @errorName(err));
        return -1;
    };

    return 0;
}

pub export fn ct_host_chmod(path: [*:0]const u8, mode: c_uint, error_out: *?[*:0]u8) c_int {
    error_out.* = null;

    if (comptime builtin.os.tag == .windows) {
        const code = ct_native_chmod(path, mode);
        if (code != 0) {
            setErrorOut(error_out, @errorName(nativeChmodError(code)));
            return -1;
        }
        return 0;
    }

    const permissions = if (@hasDecl(std.Io.File.Permissions, "fromMode"))
        std.Io.File.Permissions.fromMode(@intCast(mode))
    else
        std.Io.File.Permissions.default_file;

    std.Io.Dir.cwd().setFilePermissions(getIo(), std.mem.span(path), permissions, .{}) catch |err| {
        setErrorOut(error_out, @errorName(err));
        return -1;
    };

    return 0;
}

fn nativeChmodError(code: c_int) anyerror {
    return switch (code) {
        c.ENOENT => error.FileNotFound,
        c.EACCES => error.AccessDenied,
        c.EPERM => error.PermissionDenied,
        c.ENOTDIR => error.NotDir,
        else => error.Unexpected,
    };
}

pub export fn ct_host_spawn_sync(
    file: [*:0]const u8,
    args_ptr: ?[*]const [*:0]const u8,
    arg_count: usize,
    options: CtHostSpawnOptions,
    result_out: *CtHostSpawnResult,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    result_out.* = .{
        .exit_code = 0,
        .signal_code = 0,
        .pid = 0,
        .stdout_ptr = null,
        .stdout_len = 0,
        .stdout_present = false,
        .stderr_ptr = null,
        .stderr_len = 0,
        .stderr_present = false,
        .exited_due_to_timeout = false,
        .exited_due_to_max_buffer = false,
        .memfd_count = 0,
        .resource_usage_present = false,
        .user_cpu_time = 0,
        .system_cpu_time = 0,
        .max_rss = 0,
        .shared_memory_size = 0,
        .swapped_out = 0,
        .fs_read = 0,
        .fs_write = 0,
        .ipc_sent = 0,
        .ipc_received = 0,
        .signals_count = 0,
        .voluntary_context_switches = 0,
        .involuntary_context_switches = 0,
    };

    const gpa = std.heap.c_allocator;
    const io = getIo();

    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(gpa);

    argv.append(gpa, if (options.argv0) |argv0| std.mem.span(argv0) else std.mem.span(file)) catch {
        setErrorOut(error_out, "OutOfMemory");
        return -1;
    };

    if (args_ptr) |ptr| {
        for (0..arg_count) |index| {
            argv.append(gpa, std.mem.span(ptr[index])) catch {
                setErrorOut(error_out, "OutOfMemory");
                return -1;
            };
        }
    }

    var env_map: ?std.process.Environ.Map = null;
    defer if (env_map) |*map| map.deinit();

    if (options.clear_env or (options.env_entries != null and options.env_count > 0)) {
        var map = std.process.Environ.Map.init(gpa);
        errdefer map.deinit();

        if (options.env_entries) |env_entries| {
            for (0..options.env_count) |index| {
                map.put(std.mem.span(env_entries[index].name), std.mem.span(env_entries[index].value)) catch {
                    setErrorOut(error_out, "OutOfMemory");
                    return -1;
                };
            }
        }
        inheritWindowsSystemRoot(&map, gpa) catch {
            setErrorOut(error_out, "OutOfMemory");
            return -1;
        };

        env_map = map;
    }

    const env_map_ptr = if (env_map) |*map| map else null;
    const child_cwd = cwdOption(options.cwd);

    const input: []const u8 = if (options.input_ptr) |ptr| ptr[0..options.input_len] else &.{};
    var stdin_memfd: ?std.Io.File = null;
    var stdout_memfd: ?std.Io.File = null;
    var stderr_memfd: ?std.Io.File = null;
    if (comptime builtin.os.tag == .linux) {
        if (options.stdin_mode == @intFromEnum(SpawnStdio.pipe) and options.input_present) {
            stdin_memfd = createSpawnMemfd("spawn_stdio_stdin", false);
            if (stdin_memfd) |file_handle| {
                file_handle.writePositionalAll(io, input, 0) catch {
                    file_handle.close(io);
                    stdin_memfd = null;
                };
            }
        }
        if (!options.max_buffer_enabled and options.stdout_mode == @intFromEnum(SpawnStdio.pipe)) {
            stdout_memfd = createSpawnMemfd("spawn_stdio_stdout", true);
        }
        if (!options.max_buffer_enabled and options.stderr_mode == @intFromEnum(SpawnStdio.pipe)) {
            stderr_memfd = createSpawnMemfd("spawn_stdio_stderr", true);
        }
    }
    defer if (stdin_memfd) |file_handle| file_handle.close(io);
    defer if (stdout_memfd) |file_handle| file_handle.close(io);
    defer if (stderr_memfd) |file_handle| file_handle.close(io);

    const stdin_option: std.process.SpawnOptions.StdIo = if (stdin_memfd) |file_handle|
        .{ .file = file_handle }
    else
        spawnStdioOption(options.stdin_mode, options.stdin_fd);
    const stdout_option: std.process.SpawnOptions.StdIo = if (stdout_memfd) |file_handle|
        .{ .file = file_handle }
    else
        spawnStdioOption(options.stdout_mode, options.stdout_fd);
    const stderr_option: std.process.SpawnOptions.StdIo = if (stderr_memfd) |file_handle|
        .{ .file = file_handle }
    else
        spawnStdioOption(options.stderr_mode, options.stderr_fd);
    const isolate_process_group = builtin.os.tag == .linux and
        (options.timeout_enabled or options.max_buffer_enabled or options.abort_requested);
    const hide_spawn_window = options.windows_hide or
        shouldCreateNoWindow(options.stdin_mode, options.stdout_mode, options.stderr_mode);

    const spawn_options: std.process.SpawnOptions = .{
        .argv = argv.items,
        .cwd = child_cwd,
        .environ_map = env_map_ptr,
        .stdin = stdin_option,
        .stdout = stdout_option,
        .stderr = stderr_option,
        .request_resource_usage_statistics = true,
        .pgid = if (isolate_process_group) 0 else null,
        .create_no_window = hide_spawn_window,
    };
    var native_windows_options = options;
    native_windows_options.windows_hide = hide_spawn_window;
    var signal_scope = signal_forwarding.Scope.begin();
    defer signal_scope.deinit();
    const child_result = if (comptime builtin.os.tag != .windows)
        if (options.argv0 != null or options.stdin_fd >= 0 or options.stdout_fd >= 0 or options.stderr_fd >= 0)
            spawnPosixWithArgv0(
                file,
                argv.items,
                options.cwd,
                env_map_ptr,
                stdin_option,
                stdout_option,
                stderr_option,
                isolate_process_group,
            )
        else
            std.process.spawn(io, spawn_options)
    else
        // Keep every Windows spawn route on the native implementation that
        // uses PROC_THREAD_ATTRIBUTE_HANDLE_LIST. std.process.spawn inherits
        // unrelated process-wide inheritable handles under concurrent workers.
        spawnWindowsNative(file, args_ptr, arg_count, native_windows_options);
    var child = child_result catch |err| {
        setErrorOut(error_out, @errorName(err));
        return -1;
    };
    defer child.kill(io);
    if (child.id) |id| signal_scope.setChild(id);

    result_out.memfd_count = @intFromBool(stdin_memfd != null) +
        @intFromBool(stdout_memfd != null) +
        @intFromBool(stderr_memfd != null);

    result_out.pid = processId(child.id.?);
    var control = SpawnControl{
        .io = io,
        .id = child.id.?,
        .kill_signal = options.kill_signal,
        .process_group = isolate_process_group,
    };

    var stdin_context = SpawnWriteContext{
        .io = io,
        .control = &control,
        .input = input,
    };
    var stdout_context = SpawnReadContext{
        .io = io,
        .control = &control,
        .max_buffer_enabled = options.max_buffer_enabled,
        .max_buffer = options.max_buffer,
    };
    defer stdout_context.output.deinit(gpa);
    var stderr_context = SpawnReadContext{
        .io = io,
        .control = &control,
        .max_buffer_enabled = options.max_buffer_enabled,
        .max_buffer = options.max_buffer,
    };
    defer stderr_context.output.deinit(gpa);

    var stdin_thread: ?std.Thread = null;
    var stdout_thread: ?std.Thread = null;
    var stderr_thread: ?std.Thread = null;

    const setup_error: ?anyerror = setup: {
        if (child.stdout) |stdout_file| {
            stdout_context.file = stdout_file;
            child.stdout = null;
            stdout_thread = spawnReadThread(&stdout_context) catch |err| {
                stdout_file.close(io);
                break :setup err;
            };
        }
        if (child.stderr) |stderr_file| {
            stderr_context.file = stderr_file;
            child.stderr = null;
            stderr_thread = spawnReadThread(&stderr_context) catch |err| {
                stderr_file.close(io);
                break :setup err;
            };
        }
        if (child.stdin) |stdin_file| {
            stdin_context.file = stdin_file;
            child.stdin = null;
            stdin_thread = spawnWriteThread(&stdin_context) catch |err| {
                stdin_file.close(io);
                break :setup err;
            };
        }
        break :setup null;
    };

    if (setup_error) |err| {
        closeChildPipes(&child, io);
        control.requestTermination(.io_error);
        if (child.id != null) {
            _ = waitForConstrainedChild(&child, &control, false, 0, false) catch {
                if (child.id != null) child.kill(io);
            };
        }
        control.markExited();
        joinThread(stdin_thread);
        joinThread(stdout_thread);
        joinThread(stderr_thread);
        setErrorOut(error_out, @errorName(err));
        return -1;
    }

    const constrained = options.timeout_enabled or options.max_buffer_enabled or options.abort_requested or
        stdin_thread != null or stdout_thread != null or stderr_thread != null;
    const term = (if (constrained)
        waitForConstrainedChild(&child, &control, options.timeout_enabled, options.timeout_ms, options.abort_requested)
    else
        child.wait(io)) catch |err| {
        control.requestTermination(.io_error);
        if (child.id != null) child.kill(io);
        control.markExited();
        joinThread(stdin_thread);
        joinThread(stdout_thread);
        joinThread(stderr_thread);
        setErrorOut(error_out, @errorName(err));
        return -1;
    };
    control.markExited();

    joinThread(stdin_thread);
    joinThread(stdout_thread);
    joinThread(stderr_thread);

    // The forwarding scope routed any termination signal aimed at this process
    // to the synchronous child. Returning to JavaScript here would make a
    // spawn loop (every upstream test file that shells out) permanently immune
    // to SIGTERM: the supervisor's timeout is swallowed, the runner keeps
    // spawning, and each new child outlives whatever finally SIGKILLs it.
    if (signal_scope.takeForwardedTermination()) |signal_number| {
        signal_scope.deinit();
        signal_forwarding.exitWithSignalNumber(signal_number);
    }

    if (stdout_memfd) |file_handle| {
        readSpawnMemfd(file_handle, io, &stdout_context.output) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };
    }
    if (stderr_memfd) |file_handle| {
        readSpawnMemfd(file_handle, io, &stderr_context.output) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };
    }

    if (stdin_context.error_name orelse stdout_context.error_name orelse stderr_context.error_name) |error_name| {
        setErrorOut(error_out, error_name);
        return -1;
    }

    result_out.exit_code = termToExitCode(term);
    result_out.signal_code = termToSignalCode(term);
    if (comptime builtin.os.tag == .windows) {
        if (control.termination_requested_while_alive and
            control.termination_reason != .io_error)
        {
            result_out.signal_code = options.kill_signal;
            result_out.exit_code = 128 + options.kill_signal;
        }
    }
    result_out.exited_due_to_timeout = control.termination_reason == .timeout;
    result_out.exited_due_to_max_buffer = control.max_buffer_exceeded;
    populateSpawnResourceUsage(result_out, &child);

    if (options.stdout_mode == @intFromEnum(SpawnStdio.pipe)) {
        result_out.stdout_ptr = allocBuffer(stdout_context.output.items) orelse {
            setErrorOut(error_out, "OutOfMemory");
            return -1;
        };
        result_out.stdout_len = stdout_context.output.items.len;
        result_out.stdout_present = true;
    }
    if (options.stderr_mode == @intFromEnum(SpawnStdio.pipe)) {
        result_out.stderr_ptr = allocBuffer(stderr_context.output.items) orelse {
            if (result_out.stdout_ptr) |stdout_ptr| ct_host_buffer_free(stdout_ptr);
            result_out.stdout_ptr = null;
            result_out.stdout_len = 0;
            result_out.stdout_present = false;
            setErrorOut(error_out, "OutOfMemory");
            return -1;
        };
        result_out.stderr_len = stderr_context.output.items.len;
        result_out.stderr_present = true;
    }

    return 0;
}
