const std = @import("std");
const builtin = @import("builtin");
const c = @cImport({
    @cInclude("stdlib.h");
});

pub const boot_delay_ms_default: u64 = 100;

const WindowCloseHandler = *const fn (u32) callconv(.c) void;
const WindowMoveHandler = *const fn (u32, f64, f64) callconv(.c) void;
const WindowResizeHandler = *const fn (u32, f64, f64, f64, f64) callconv(.c) void;
const WindowFocusHandler = *const fn (u32) callconv(.c) void;
const WindowBlurHandler = *const fn (u32) callconv(.c) void;
const WindowKeyHandler = *const fn (u32, u32, u32, u32, u32) callconv(.c) void;

const LastErrorFn = *const fn () callconv(.c) [*:0]const u8;
const RunMainThreadFn = *const fn (
    [*:0]const u8,
    [*:0]const u8,
    [*:0]const u8,
    c_int,
) callconv(.c) c_int;
const GetWindowStyleFn = *const fn (
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
) callconv(.c) u32;
const CreateWindowFn = *const fn (
    f64,
    f64,
    f64,
    f64,
    u32,
    [*:0]const u8,
    bool,
    [*:0]const u8,
    bool,
    bool,
    f64,
    f64,
    ?WindowCloseHandler,
    ?WindowMoveHandler,
    ?WindowResizeHandler,
    ?WindowFocusHandler,
    ?WindowBlurHandler,
    ?WindowKeyHandler,
) callconv(.c) u32;
const StopEventLoopFn = *const fn () callconv(.c) void;
const WaitForShutdownCompleteFn = *const fn (c_int) callconv(.c) void;
const ForceExitFn = *const fn (c_int) callconv(.c) void;

const Core = struct {
    lib: std.DynLib,
    symbols: Symbols,

    const Symbols = struct {
        last_error: LastErrorFn,
        run_main_thread: RunMainThreadFn,
        get_window_style: GetWindowStyleFn,
        create_window: CreateWindowFn,
        stop_event_loop: StopEventLoopFn,
        wait_for_shutdown_complete: WaitForShutdownCompleteFn,
        force_exit: ForceExitFn,
    };

    fn open(lib_path: []const u8) !Core {
        var lib = try std.DynLib.open(lib_path);

        return .{
            .lib = lib,
            .symbols = .{
                .last_error = lib.lookup(LastErrorFn, "electrobun_core_last_error") orelse return error.MissingCoreSymbol,
                .run_main_thread = lib.lookup(RunMainThreadFn, "electrobun_core_run_main_thread") orelse return error.MissingCoreSymbol,
                .get_window_style = lib.lookup(GetWindowStyleFn, "getWindowStyle") orelse return error.MissingCoreSymbol,
                .create_window = lib.lookup(CreateWindowFn, "createWindow") orelse return error.MissingCoreSymbol,
                .stop_event_loop = lib.lookup(StopEventLoopFn, "stopEventLoop") orelse return error.MissingCoreSymbol,
                .wait_for_shutdown_complete = lib.lookup(WaitForShutdownCompleteFn, "waitForShutdownComplete") orelse return error.MissingCoreSymbol,
                .force_exit = lib.lookup(ForceExitFn, "forceExit") orelse return error.MissingCoreSymbol,
            },
        };
    }

    fn close(self: *Core) void {
        self.lib.close();
    }

    fn lastError(self: *const Core) []const u8 {
        return std.mem.span(self.symbols.last_error());
    }

    fn defaultWindowStyle(self: *const Core) u32 {
        return self.symbols.get_window_style(
            false,
            true,
            true,
            true,
            true,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
        );
    }
};

const BridgeState = struct {
    enabled: bool = false,
    app_identifier: ?[:0]u8 = null,
    app_name: ?[:0]u8 = null,
    app_channel: ?[:0]u8 = null,
    core: ?Core = null,
    quit_on_close_windows: std.AutoHashMapUnmanaged(u32, void) = .empty,
    created_window_count: std.atomic.Value(u32) = .init(0),
    lock: std.atomic.Mutex = .unlocked,
};

var state = BridgeState{};

pub fn forceLink() void {
    _ = &ct_electrobun_enabled;
    _ = &ct_electrobun_create_window_host;
    _ = &ct_electrobun_quit_host;
}

pub fn init(io: std.Io, allocator: std.mem.Allocator) !void {
    if (state.enabled) {
        return;
    }

    const exe_dir = try std.process.executableDirPathAlloc(io, allocator);
    defer allocator.free(exe_dir);

    const dist_dir = try resolveDistDir(io, allocator, exe_dir);
    defer allocator.free(dist_dir);

    try stageLibraries(io, allocator, dist_dir, exe_dir);

    const core_path = try std.fs.path.join(allocator, &.{ exe_dir, coreLibraryName() });
    defer allocator.free(core_path);

    const core = try Core.open(core_path);

    state.core = core;
    state.app_identifier = try envOrDefault(allocator, "COTTONTAIL_ELECTROBUN_IDENTIFIER", "dev.electrobun.cottontail");
    state.app_name = try envOrDefault(allocator, "COTTONTAIL_ELECTROBUN_NAME", "Cottontail");
    state.app_channel = try envOrDefault(allocator, "COTTONTAIL_ELECTROBUN_CHANNEL", "dev");
    state.enabled = true;
}

pub fn bootDelayNs() u64 {
    if (std.c.getenv("COTTONTAIL_ELECTROBUN_BOOT_DELAY_MS")) |value| {
        const parsed = std.fmt.parseInt(u64, std.mem.span(value), 10) catch return boot_delay_ms_default * std.time.ns_per_ms;
        return parsed * std.time.ns_per_ms;
    }

    return boot_delay_ms_default * std.time.ns_per_ms;
}

pub fn runMainThread(exit_code: c_int) !void {
    const core = state.core orelse return error.ElectrobunNotInitialized;
    const identifier = state.app_identifier orelse return error.ElectrobunNotInitialized;
    const name = state.app_name orelse return error.ElectrobunNotInitialized;
    const channel = state.app_channel orelse return error.ElectrobunNotInitialized;

    const status = core.symbols.run_main_thread(identifier.ptr, name.ptr, channel.ptr, exit_code);
    if (status != 0) {
        return error.RunMainThreadFailed;
    }
}

pub fn forceExit(code: u8) noreturn {
    if (state.core) |core| {
        core.symbols.force_exit(@intCast(code));
    }
    std.process.exit(code);
}

pub fn createdWindowCount() u32 {
    return state.created_window_count.load(.monotonic);
}

pub fn lastError() []const u8 {
    if (state.core) |*core| {
        const message = core.lastError();
        if (message.len > 0) {
            return message;
        }
    }
    return "Electrobun bridge operation failed";
}

fn coreLibraryName() []const u8 {
    return switch (builtin.os.tag) {
        .windows => "ElectrobunCore.dll",
        .macos => "libElectrobunCore.dylib",
        else => "libElectrobunCore.so",
    };
}

fn nativeWrapperLibraryName() []const u8 {
    return switch (builtin.os.tag) {
        .windows => "libNativeWrapper.dll",
        .macos => "libNativeWrapper.dylib",
        else => "libNativeWrapper.so",
    };
}

fn asarLibraryName() []const u8 {
    return switch (builtin.os.tag) {
        .windows => "libasar.dll",
        else => "libasar." ++ switch (builtin.os.tag) {
            .macos => "dylib",
            else => "so",
        },
    };
}

fn wgpuLibraryName() []const u8 {
    return switch (builtin.os.tag) {
        .windows => "webgpu_dawn.dll",
        .macos => "libwebgpu_dawn.dylib",
        else => "libwebgpu_dawn.so",
    };
}

fn envOrDefault(allocator: std.mem.Allocator, name: [:0]const u8, default_value: []const u8) ![:0]u8 {
    if (std.c.getenv(name)) |value| {
        return allocator.dupeZ(u8, std.mem.span(value));
    }

    return allocator.dupeZ(u8, default_value);
}

fn spinLock() void {
    while (!state.lock.tryLock()) {
        std.atomic.spinLoopHint();
    }
}

fn unlock() void {
    state.lock.unlock();
}

fn resolveDistDir(io: std.Io, allocator: std.mem.Allocator, exe_dir: []const u8) ![]u8 {
    if (std.c.getenv("COTTONTAIL_ELECTROBUN_DIST")) |value| {
        const env_dir = try allocator.dupe(u8, std.mem.span(value));
        if (distDirLooksUsable(io, allocator, env_dir)) {
            return env_dir;
        }
        allocator.free(env_dir);
    }

    const exe_candidate = try std.fs.path.join(allocator, &.{ exe_dir, "..", "..", "..", "electrobun", "package", "dist" });
    if (distDirLooksUsable(io, allocator, exe_candidate)) {
        return exe_candidate;
    }
    allocator.free(exe_candidate);

    return error.ElectrobunDistNotFound;
}

fn distDirLooksUsable(io: std.Io, allocator: std.mem.Allocator, dist_dir: []const u8) bool {
    const core_path = std.fs.path.join(allocator, &.{ dist_dir, coreLibraryName() }) catch return false;
    defer allocator.free(core_path);

    const native_wrapper_path = std.fs.path.join(allocator, &.{ dist_dir, nativeWrapperLibraryName() }) catch return false;
    defer allocator.free(native_wrapper_path);

    return fileExists(io, core_path) and fileExists(io, native_wrapper_path);
}

fn stageLibraries(io: std.Io, allocator: std.mem.Allocator, dist_dir: []const u8, exe_dir: []const u8) !void {
    const required = [_][]const u8{
        coreLibraryName(),
        nativeWrapperLibraryName(),
        asarLibraryName(),
    };

    for (required) |file_name| {
        try stageIfPresent(io, allocator, dist_dir, exe_dir, file_name, true);
    }

    try stageIfPresent(io, allocator, dist_dir, exe_dir, wgpuLibraryName(), false);
}

fn stageIfPresent(
    io: std.Io,
    allocator: std.mem.Allocator,
    source_dir: []const u8,
    dest_dir: []const u8,
    file_name: []const u8,
    required: bool,
) !void {
    const source_path = try std.fs.path.join(allocator, &.{ source_dir, file_name });
    defer allocator.free(source_path);

    if (!fileExists(io, source_path)) {
        if (required) {
            return error.MissingElectrobunArtifact;
        }
        return;
    }

    const dest_path = try std.fs.path.join(allocator, &.{ dest_dir, file_name });
    defer allocator.free(dest_path);

    try std.Io.Dir.copyFileAbsolute(source_path, dest_path, io, .{
        .replace = true,
        .make_path = true,
    });
}

fn fileExists(io: std.Io, path: []const u8) bool {
    std.Io.Dir.cwd().access(io, path, .{}) catch return false;
    return true;
}

fn allocCString(bytes: []const u8) ?[*:0]u8 {
    const raw = c.malloc(bytes.len + 1) orelse return null;
    const ptr: [*]u8 = @ptrCast(raw);
    @memcpy(ptr[0..bytes.len], bytes);
    ptr[bytes.len] = 0;
    return @ptrCast(ptr);
}

fn setErrorOut(error_out: *?[*:0]u8, message: []const u8) void {
    error_out.* = allocCString(message);
}

fn onWindowClose(window_id: u32) callconv(.c) void {
    var should_quit = false;
    var core_ptr: ?*Core = null;

    spinLock();
    defer unlock();

    should_quit = state.quit_on_close_windows.remove(window_id);
    if (state.core) |*core| {
        core_ptr = core;
    }

    if (should_quit and core_ptr != null) {
        core_ptr.?.symbols.stop_event_loop();
    }
}

export fn ct_electrobun_enabled() bool {
    return state.enabled;
}

export fn ct_electrobun_create_window_host(
    title: [*:0]const u8,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    hidden: bool,
    activate: bool,
    quit_on_close: bool,
    error_out: *?[*:0]u8,
) c_uint {
    error_out.* = null;

    if (!state.enabled) {
        setErrorOut(error_out, "electrobun bridge is not enabled");
        return 0;
    }

    const core = state.core orelse {
        setErrorOut(error_out, "electrobun core is not loaded");
        return 0;
    };

    const title_bar_style = "default";
    const style_mask = core.defaultWindowStyle();

    const window_id = core.symbols.create_window(
        x,
        y,
        width,
        height,
        style_mask,
        title_bar_style.ptr,
        false,
        title,
        hidden,
        activate,
        0,
        0,
        onWindowClose,
        null,
        null,
        null,
        null,
        null,
    );

    if (window_id == 0) {
        setErrorOut(error_out, lastError());
        return 0;
    }

    if (quit_on_close) {
        spinLock();
        defer unlock();

        state.quit_on_close_windows.put(std.heap.c_allocator, window_id, {}) catch {
            setErrorOut(error_out, "Failed to store window close policy");
            return 0;
        };
    }

    _ = state.created_window_count.fetchAdd(1, .monotonic);
    return window_id;
}

export fn ct_electrobun_quit_host(error_out: *?[*:0]u8) c_int {
    error_out.* = null;

    if (!state.enabled) {
        setErrorOut(error_out, "electrobun bridge is not enabled");
        return -1;
    }

    const core = state.core orelse {
        setErrorOut(error_out, "electrobun core is not loaded");
        return -1;
    };

    core.symbols.stop_event_loop();
    return 0;
}
