const std = @import("std");
const builtin = @import("builtin");
const compiler = @import("cottontail_compiler");
const c = @cImport({
    @cInclude("stdlib.h");
});

const Semver = compiler.Semver;
const HostedGitInfo = compiler.install.HostedGitInfo;
const BunLockfile = compiler.install.Lockfile;
const PackageManagerBunLockfile = @import("package_manager_bun_lockfile.zig");

pub const CtHostEnvEntry = extern struct {
    name: [*:0]const u8,
    value: [*:0]const u8,
};

pub const CtHostSpawnOptions = extern struct {
    cwd: ?[*:0]const u8,
    env_entries: ?[*]const CtHostEnvEntry,
    env_count: usize,
    clear_env: bool,
    stdin_mode: c_int,
    stdout_mode: c_int,
    stderr_mode: c_int,
    input_present: bool,
    input_ptr: ?[*]const u8,
    input_len: usize,
    timeout_enabled: bool,
    timeout_ms: u64,
    max_buffer_enabled: bool,
    max_buffer: u64,
    kill_signal: c_int,
    abort_requested: bool,
};

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

pub fn forceLink() void {
    _ = &ct_host_string_free;
    _ = &ct_host_buffer_free;
    _ = &ct_host_exists;
    _ = &ct_host_mkdir;
    _ = &ct_host_rm;
    _ = &ct_host_rmdir;
    _ = &ct_host_unlink;
    _ = &ct_host_chmod;
    _ = &ct_host_spawn_sync;
    _ = &ct_semver_order;
    _ = &ct_semver_satisfies;
    _ = &ct_hosted_git_info_parse_url;
    _ = &ct_hosted_git_info_from_url;
    _ = &ct_package_manager_parse_lockfile;
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

export fn ct_semver_order(
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

export fn ct_semver_satisfies(
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

export fn ct_hosted_git_info_parse_url(
    input_ptr: [*]const u8,
    input_len: usize,
    output_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    output_len.* = 0;
    error_out.* = null;

    const parsed = HostedGitInfo.parseUrl(std.heap.c_allocator, input_ptr[0..input_len]) catch |err| {
        setFormattedErrorOut(error_out, "Invalid Git URL: {s}", .{@errorName(err)});
        return null;
    };
    defer parsed.url.deinit();

    output_len.* = parsed.url.backing.len;
    return allocBuffer(parsed.url.backing) orelse {
        setErrorOut(error_out, "Out of memory");
        return null;
    };
}

export fn ct_hosted_git_info_from_url(
    input_ptr: [*]const u8,
    input_len: usize,
    output_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    output_len.* = 0;
    error_out.* = null;

    const maybe_info = HostedGitInfo.HostedGitInfo.fromUrl(
        std.heap.c_allocator,
        input_ptr[0..input_len],
    ) catch |err| {
        setFormattedErrorOut(error_out, "Invalid Git URL: {s}", .{@errorName(err)});
        return null;
    };
    var info = maybe_info orelse return null;
    defer info.deinit();

    const Response = struct {
        type: []const u8,
        domain: []const u8,
        project: []const u8,
        user: ?[]const u8,
        committish: ?[]const u8,
        default: []const u8,
    };
    const json = std.json.Stringify.valueAlloc(std.heap.c_allocator, Response{
        .type = info.host_provider.typeStr(),
        .domain = info.host_provider.domain(),
        .project = info.project,
        .user = info.user,
        .committish = info.committish,
        .default = @tagName(info.default_representation),
    }, .{}) catch {
        setErrorOut(error_out, "Out of memory");
        return null;
    };
    defer std.heap.c_allocator.free(json);

    output_len.* = json.len;
    return allocBuffer(json) orelse {
        setErrorOut(error_out, "Out of memory");
        return null;
    };
}

export fn ct_package_manager_parse_lockfile(
    cwd_ptr: [*]const u8,
    cwd_len: usize,
    output_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    output_len.* = 0;
    error_out.* = null;

    const allocator = std.heap.c_allocator;
    const cwd = cwd_ptr[0..cwd_len];
    const binary_path = std.fs.path.join(allocator, &.{ cwd, "bun.lockb" }) catch {
        setErrorOut(error_out, "Out of memory");
        return null;
    };
    defer allocator.free(binary_path);

    const binary = std.Io.Dir.cwd().readFileAlloc(
        getIo(),
        binary_path,
        allocator,
        .limited(256 * 1024 * 1024),
    ) catch |err| binary: {
        if (err != error.FileNotFound) {
            setFormattedErrorOut(error_out, "failed to load lockfile: {s}, '{s}'", .{ @errorName(err), binary_path });
            return null;
        }
        const text_path = std.fs.path.join(allocator, &.{ cwd, "bun.lock" }) catch {
            setErrorOut(error_out, "Out of memory");
            return null;
        };
        defer allocator.free(text_path);
        const text_lockfile = std.Io.Dir.cwd().readFileAlloc(
            getIo(),
            text_path,
            allocator,
            .limited(256 * 1024 * 1024),
        ) catch |text_err| {
            setFormattedErrorOut(error_out, "failed to load lockfile: {s}, '{s}'", .{ @errorName(text_err), text_path });
            return null;
        };
        defer allocator.free(text_lockfile);
        break :binary PackageManagerBunLockfile.textToBinaryAtRoot(
            allocator,
            text_lockfile,
            getIo(),
            cwd,
        ) catch |convert_err| {
            setFormattedErrorOut(error_out, "failed to load lockfile: {s}, '{s}'", .{ @errorName(convert_err), text_path });
            return null;
        };
    };
    defer allocator.free(binary);

    var log = compiler.logger.Log.init(allocator);
    defer log.deinit();
    var lockfile: BunLockfile = undefined;
    const load_result = lockfile.loadFromBytesStandalone(binary, allocator, &log);
    switch (load_result) {
        .ok => {},
        .err => |failure| {
            setFormattedErrorOut(error_out, "failed to load lockfile: {s}, '{s}'", .{ @errorName(failure.value), binary_path });
            return null;
        },
        .not_found => {
            setFormattedErrorOut(error_out, "lockfile not found: '{s}'", .{binary_path});
            return null;
        },
    }
    defer lockfile.deinit();

    const json = std.fmt.allocPrint(allocator, "{f}", .{std.json.fmt(lockfile, .{
        .whitespace = .indent_2,
        .emit_null_optional_fields = true,
        .emit_nonportable_numbers_as_strings = true,
    })}) catch {
        setErrorOut(error_out, "Out of memory");
        return null;
    };
    defer allocator.free(json);

    output_len.* = json.len;
    return allocBuffer(json) orelse {
        setErrorOut(error_out, "Out of memory");
        return null;
    };
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

fn spawnStdioOption(mode: c_int) std.process.SpawnOptions.StdIo {
    return switch (@as(SpawnStdio, @enumFromInt(mode))) {
        .pipe => .pipe,
        .inherit => .inherit,
        .ignore => .ignore,
    };
}

fn createSpawnMemfd(name: []const u8) ?std.Io.File {
    if (comptime builtin.os.tag != .linux) return null;
    const fd = std.posix.memfd_create(name, 0) catch return null;
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

fn rawTerminateProcess(id: std.process.Child.Id, signal_code: c_int) void {
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
    std.posix.kill(id, signal) catch {};
}

const SpawnControl = struct {
    io: std.Io,
    id: std.process.Child.Id,
    mutex: std.Io.Mutex = .init,
    alive: bool = true,
    kill_signal: c_int,
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
        rawTerminateProcess(self.id, signal_code);
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

export fn ct_host_string_free(value: ?[*:0]u8) void {
    if (value) |ptr| {
        c.free(@ptrCast(ptr));
    }
}

export fn ct_host_buffer_free(value: ?[*]u8) void {
    if (value) |ptr| {
        c.free(@ptrCast(ptr));
    }
}

export fn ct_host_exists(path: [*:0]const u8) bool {
    const sub_path = std.mem.span(path);
    if (comptime builtin.os.tag == .windows) {
        return windowsPathAttributes(sub_path) != null;
    }
    std.Io.Dir.cwd().access(getIo(), sub_path, .{}) catch return false;
    return true;
}

export fn ct_host_mkdir(path: [*:0]const u8, recursive: bool, error_out: *?[*:0]u8) c_int {
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

export fn ct_host_rm(
    path: [*:0]const u8,
    recursive: bool,
    force: bool,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;

    const cwd = std.Io.Dir.cwd();
    const sub_path = std.mem.span(path);

    if (force and !ct_host_exists(path)) {
        return 0;
    }

    if (recursive) {
        cwd.deleteTree(getIo(), sub_path) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };
    } else {
        cwd.deleteFile(getIo(), sub_path) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };
    }

    return 0;
}

export fn ct_host_rmdir(path: [*:0]const u8, error_out: *?[*:0]u8) c_int {
    error_out.* = null;

    std.Io.Dir.cwd().deleteDir(getIo(), std.mem.span(path)) catch |err| {
        setErrorOut(error_out, @errorName(err));
        return -1;
    };

    return 0;
}

export fn ct_host_unlink(path: [*:0]const u8, error_out: *?[*:0]u8) c_int {
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

export fn ct_host_chmod(path: [*:0]const u8, mode: c_uint, error_out: *?[*:0]u8) c_int {
    error_out.* = null;

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

export fn ct_host_spawn_sync(
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

    argv.append(gpa, std.mem.span(file)) catch {
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
            stdin_memfd = createSpawnMemfd("spawn_stdio_stdin");
            if (stdin_memfd) |file_handle| {
                file_handle.writePositionalAll(io, input, 0) catch {
                    file_handle.close(io);
                    stdin_memfd = null;
                };
            }
        }
        if (!options.max_buffer_enabled and options.stdout_mode == @intFromEnum(SpawnStdio.pipe)) {
            stdout_memfd = createSpawnMemfd("spawn_stdio_stdout");
        }
        if (!options.max_buffer_enabled and options.stderr_mode == @intFromEnum(SpawnStdio.pipe)) {
            stderr_memfd = createSpawnMemfd("spawn_stdio_stderr");
        }
    }
    defer if (stdin_memfd) |file_handle| file_handle.close(io);
    defer if (stdout_memfd) |file_handle| file_handle.close(io);
    defer if (stderr_memfd) |file_handle| file_handle.close(io);

    const stdin_option: std.process.SpawnOptions.StdIo = if (stdin_memfd) |file_handle|
        .{ .file = file_handle }
    else
        spawnStdioOption(options.stdin_mode);
    const stdout_option: std.process.SpawnOptions.StdIo = if (stdout_memfd) |file_handle|
        .{ .file = file_handle }
    else
        spawnStdioOption(options.stdout_mode);
    const stderr_option: std.process.SpawnOptions.StdIo = if (stderr_memfd) |file_handle|
        .{ .file = file_handle }
    else
        spawnStdioOption(options.stderr_mode);

    var child = std.process.spawn(io, .{
        .argv = argv.items,
        .cwd = child_cwd,
        .environ_map = env_map_ptr,
        .stdin = stdin_option,
        .stdout = stdout_option,
        .stderr = stderr_option,
        .request_resource_usage_statistics = true,
        .create_no_window = shouldCreateNoWindow(options.stdin_mode, options.stdout_mode, options.stderr_mode),
    }) catch |err| {
        setErrorOut(error_out, @errorName(err));
        return -1;
    };
    defer child.kill(io);

    result_out.memfd_count = @intFromBool(stdin_memfd != null) +
        @intFromBool(stdout_memfd != null) +
        @intFromBool(stderr_memfd != null);

    result_out.pid = processId(child.id.?);
    var control = SpawnControl{
        .io = io,
        .id = child.id.?,
        .kill_signal = options.kill_signal,
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
