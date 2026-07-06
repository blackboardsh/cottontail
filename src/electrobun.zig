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
const DecideNavigationHandler = *const fn (u32, [*:0]const u8) callconv(.c) u32;
const WebviewEventHandler = *const fn (u32, [*:0]const u8, [*:0]const u8) callconv(.c) void;
const WebviewPostMessageHandler = *const fn (u32, [*:0]const u8) callconv(.c) void;
const StatusItemHandler = *const fn (u32, [*:0]const u8) callconv(.c) void;
const GlobalShortcutHandler = *const fn ([*:0]const u8) callconv(.c) void;
const URLOpenHandler = *const fn ([*:0]const u8) callconv(.c) void;
const AppReopenHandler = *const fn () callconv(.c) void;
const QuitRequestedHandler = *const fn () callconv(.c) void;

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
const ConfigureWebviewRuntimeFn = *const fn (u32, [*:0]const u8, [*:0]const u8) callconv(.c) bool;
const CreateWebviewFn = *const fn (
    u32,
    u32,
    [*:0]const u8,
    [*:0]const u8,
    f64,
    f64,
    f64,
    f64,
    bool,
    [*:0]const u8,
    ?DecideNavigationHandler,
    ?WebviewEventHandler,
    ?WebviewPostMessageHandler,
    ?WebviewPostMessageHandler,
    ?WebviewPostMessageHandler,
    [*:0]const u8,
    [*:0]const u8,
    [*:0]const u8,
    bool,
    bool,
    bool,
) callconv(.c) u32;
const CloseWindowFn = *const fn (u32) callconv(.c) void;
const SetWindowAlwaysOnTopFn = *const fn (u32, bool) callconv(.c) void;
const SendHostMessageToWebviewViaTransportFn = *const fn (u32, [*:0]const u8) callconv(.c) bool;
const PopNextQueuedHostMessageFn = *const fn (*u32) callconv(.c) ?[*:0]u8;
const FreeCoreStringFn = *const fn (?[*:0]u8) callconv(.c) void;
const StopEventLoopFn = *const fn () callconv(.c) void;
const WaitForShutdownCompleteFn = *const fn (c_int) callconv(.c) void;
const ForceExitFn = *const fn (c_int) callconv(.c) void;

const U32Fn = *const fn (u32) callconv(.c) void;
const U32BoolRetFn = *const fn (u32) callconv(.c) bool;
const U32BoolFn = *const fn (u32, bool) callconv(.c) void;
const BoolFn = *const fn (bool) callconv(.c) void;
const BoolRetFn = *const fn () callconv(.c) bool;
const U32StringFn = *const fn (u32, [*:0]const u8) callconv(.c) void;
const U32StringBoolRetFn = *const fn (u32, [*:0]const u8) callconv(.c) bool;
const U32StringBoolBoolFn = *const fn (u32, [*:0]const u8, bool, bool) callconv(.c) void;
const U32F64F64Fn = *const fn (u32, f64, f64) callconv(.c) void;
const U32F64Fn = *const fn (u32, f64) callconv(.c) void;
const U32F64RetFn = *const fn (u32) callconv(.c) f64;
const U32F64F64F64F64Fn = *const fn (u32, f64, f64, f64, f64) callconv(.c) void;
const GetWindowFrameFn = *const fn (u32, *f64, *f64, *f64, *f64) callconv(.c) void;
const ResizeViewFn = *const fn (u32, f64, f64, f64, f64, [*:0]const u8) callconv(.c) void;
const NativeRet0Fn = *const fn () callconv(.c) u64;
const NativeRet1Fn = *const fn (u64) callconv(.c) u64;
const NativeRet2Fn = *const fn (u64, u64) callconv(.c) u64;
const NativeRet3Fn = *const fn (u64, u64, u64) callconv(.c) u64;
const NativeRet4Fn = *const fn (u64, u64, u64, u64) callconv(.c) u64;
const NativeRet5Fn = *const fn (u64, u64, u64, u64, u64) callconv(.c) u64;
const NativeRet6Fn = *const fn (u64, u64, u64, u64, u64, u64) callconv(.c) u64;
const NativeRet7Fn = *const fn (u64, u64, u64, u64, u64, u64, u64) callconv(.c) u64;
const NativeRet8Fn = *const fn (u64, u64, u64, u64, u64, u64, u64, u64) callconv(.c) u64;
const NativeVoid0Fn = *const fn () callconv(.c) void;
const NativeVoid1Fn = *const fn (u64) callconv(.c) void;
const NativeVoid2Fn = *const fn (u64, u64) callconv(.c) void;
const NativeVoid3Fn = *const fn (u64, u64, u64) callconv(.c) void;
const NativeVoid4Fn = *const fn (u64, u64, u64, u64) callconv(.c) void;
const NativeVoid5Fn = *const fn (u64, u64, u64, u64, u64) callconv(.c) void;
const NativeVoid6Fn = *const fn (u64, u64, u64, u64, u64, u64) callconv(.c) void;
const NativeVoid7Fn = *const fn (u64, u64, u64, u64, u64, u64, u64) callconv(.c) void;
const NativeVoid8Fn = *const fn (u64, u64, u64, u64, u64, u64, u64, u64) callconv(.c) void;
const WgpuRenderPassSetViewportFn = *const fn (u64, f32, f32, f32, f32, f32, f32) callconv(.c) void;
const StringFn = *const fn ([*:0]const u8) callconv(.c) void;
const StringBoolRetFn = *const fn ([*:0]const u8) callconv(.c) bool;
const StringRetFn = *const fn () callconv(.c) ?[*:0]u8;
const StringStringRetFn = *const fn ([*:0]const u8, [*:0]const u8) callconv(.c) ?[*:0]u8;
const StringStringBoolRetFn = *const fn ([*:0]const u8, [*:0]const u8) callconv(.c) bool;
const StringStringStringBoolRetFn = *const fn ([*:0]const u8, [*:0]const u8, [*:0]const u8) callconv(.c) bool;
const StringStringFn = *const fn ([*:0]const u8, [*:0]const u8) callconv(.c) void;
const IntFn = *const fn (c_int) callconv(.c) void;
const VoidFn = *const fn () callconv(.c) void;
const U32PtrRetFn = *const fn (u32) callconv(.c) ?*anyopaque;
const CreateWGPUViewFn = *const fn (u32, f64, f64, f64, f64, bool, bool, bool) callconv(.c) u32;
const CreateTrayFn = *const fn ([*:0]const u8, [*:0]const u8, bool, u32, u32, ?StatusItemHandler) callconv(.c) u32;
const ShowTrayFn = *const fn (u32) callconv(.c) bool;
const U32ConstStringRetFn = *const fn (u32) callconv(.c) ?[*:0]const u8;
const NotificationFn = *const fn ([*:0]const u8, [*:0]const u8, [*:0]const u8, bool) callconv(.c) void;
const MenuFn = *const fn ([*:0]const u8, ?StatusItemHandler) callconv(.c) void;
const OpenFileDialogFn = *const fn ([*:0]const u8, [*:0]const u8, c_int, c_int, c_int) callconv(.c) ?[*:0]u8;
const ShowMessageBoxFn = *const fn ([*:0]const u8, [*:0]const u8, [*:0]const u8, [*:0]const u8, [*:0]const u8, c_int, c_int) callconv(.c) c_int;
const SetGlobalShortcutCallbackFn = *const fn (?GlobalShortcutHandler) callconv(.c) void;
const SetURLOpenHandlerFn = *const fn (?URLOpenHandler) callconv(.c) void;
const SetAppReopenHandlerFn = *const fn (?AppReopenHandler) callconv(.c) void;
const SetQuitRequestedHandlerFn = *const fn (?QuitRequestedHandler) callconv(.c) void;

const Core = struct {
    lib: std.DynLib,
    symbols: Symbols,

    const Symbols = struct {
        last_error: LastErrorFn,
        run_main_thread: RunMainThreadFn,
        configure_webview_runtime: ConfigureWebviewRuntimeFn,
        get_window_style: GetWindowStyleFn,
        create_window: CreateWindowFn,
        create_webview: CreateWebviewFn,
        close_window: CloseWindowFn,
        set_window_always_on_top: SetWindowAlwaysOnTopFn,
        send_host_message_to_webview_via_transport: SendHostMessageToWebviewViaTransportFn,
        pop_next_queued_host_message: PopNextQueuedHostMessageFn,
        free_core_string: FreeCoreStringFn,
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
                .configure_webview_runtime = lib.lookup(ConfigureWebviewRuntimeFn, "configureWebviewRuntime") orelse return error.MissingCoreSymbol,
                .get_window_style = lib.lookup(GetWindowStyleFn, "getWindowStyle") orelse return error.MissingCoreSymbol,
                .create_window = lib.lookup(CreateWindowFn, "createWindow") orelse return error.MissingCoreSymbol,
                .create_webview = lib.lookup(CreateWebviewFn, "createWebview") orelse return error.MissingCoreSymbol,
                .close_window = lib.lookup(CloseWindowFn, "closeWindow") orelse return error.MissingCoreSymbol,
                .set_window_always_on_top = lib.lookup(SetWindowAlwaysOnTopFn, "setWindowAlwaysOnTop") orelse return error.MissingCoreSymbol,
                .send_host_message_to_webview_via_transport = lib.lookup(SendHostMessageToWebviewViaTransportFn, "sendHostMessageToWebviewViaTransport") orelse return error.MissingCoreSymbol,
                .pop_next_queued_host_message = lib.lookup(PopNextQueuedHostMessageFn, "popNextQueuedHostMessage") orelse return error.MissingCoreSymbol,
                .free_core_string = lib.lookup(FreeCoreStringFn, "freeCoreString") orelse return error.MissingCoreSymbol,
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
    wgpu_lib: ?std.DynLib = null,
    exe_dir: ?[:0]u8 = null,
    running_in_app_bundle: bool = false,
    quit_on_close_windows: std.AutoHashMapUnmanaged(u32, void) = .empty,
    event_queue: std.ArrayListUnmanaged([:0]u8) = .empty,
    created_window_count: std.atomic.Value(u32) = .init(0),
    lock: std.atomic.Mutex = .unlocked,
};

var state = BridgeState{};

pub fn forceLink() void {
    _ = &ct_electrobun_enabled;
    _ = &ct_electrobun_create_window_host;
    _ = &ct_electrobun_create_webview_host;
    _ = &ct_electrobun_close_window_host;
    _ = &ct_electrobun_set_window_always_on_top_host;
    _ = &ct_electrobun_send_host_message_host;
    _ = &ct_electrobun_pop_host_message_host;
    _ = &ct_electrobun_pop_event_host;
    _ = &ct_electrobun_call_u32_host;
    _ = &ct_electrobun_call_u32_bool_host;
    _ = &ct_electrobun_call_u32_bool_ret_host;
    _ = &ct_electrobun_call_u32_string_host;
    _ = &ct_electrobun_call_u32_string_bool_ret_host;
    _ = &ct_electrobun_call_u32_string_bool_bool_host;
    _ = &ct_electrobun_call_u32_f64_f64_host;
    _ = &ct_electrobun_call_u32_f64_host;
    _ = &ct_electrobun_call_u32_f64_ret_host;
    _ = &ct_electrobun_call_u32_f64_f64_f64_f64_host;
    _ = &ct_electrobun_get_window_frame_host;
    _ = &ct_electrobun_resize_view_host;
    _ = &ct_electrobun_call_bool_host;
    _ = &ct_electrobun_call_bool_ret_host;
    _ = &ct_electrobun_call_void_host;
    _ = &ct_electrobun_call_string_host;
    _ = &ct_electrobun_call_string_bool_ret_host;
    _ = &ct_electrobun_call_string_ret_host;
    _ = &ct_electrobun_call_string_string_ret_host;
    _ = &ct_electrobun_call_string_string_bool_ret_host;
    _ = &ct_electrobun_call_string_string_string_bool_ret_host;
    _ = &ct_electrobun_call_string_string_host;
    _ = &ct_electrobun_call_int_host;
    _ = &ct_electrobun_call_u32_ptr_exists_host;
    _ = &ct_electrobun_native_call_host;
    _ = &ct_electrobun_create_wgpu_view_host;
    _ = &ct_electrobun_create_tray_host;
    _ = &ct_electrobun_show_tray_host;
    _ = &ct_electrobun_get_tray_bounds_host;
    _ = &ct_electrobun_show_notification_host;
    _ = &ct_electrobun_set_menu_host;
    _ = &ct_electrobun_open_file_dialog_host;
    _ = &ct_electrobun_show_message_box_host;
    _ = &ct_electrobun_set_global_shortcut_callback_host;
    _ = &ct_electrobun_set_url_open_handler_host;
    _ = &ct_electrobun_set_app_reopen_handler_host;
    _ = &ct_electrobun_set_quit_requested_handler_host;
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
    try configureWebviewRuntime(io, allocator, &core, dist_dir);

    state.core = core;
    state.exe_dir = try allocator.dupeZ(u8, exe_dir);
    state.app_identifier = try envOrDefault(allocator, "COTTONTAIL_ELECTROBUN_IDENTIFIER", "dev.electrobun.cottontail");
    state.app_name = try envOrDefault(allocator, "COTTONTAIL_ELECTROBUN_NAME", "Cottontail");
    state.app_channel = try envOrDefault(allocator, "COTTONTAIL_ELECTROBUN_CHANNEL", "dev");
    state.running_in_app_bundle = std.mem.indexOf(u8, exe_dir, ".app/Contents/MacOS") != null;
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
    return "Electrobun bridge operation failed; no native error was reported";
}

fn operationError(error_out: *?[*:0]u8, comptime operation: []const u8) void {
    const message = lastError();
    if (std.mem.eql(u8, message, "Electrobun bridge operation failed; no native error was reported")) {
        setErrorOut(error_out, operation ++ " failed; no native error was reported");
        return;
    }
    setErrorOut(error_out, message);
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

    if (std.mem.eql(u8, source_path, dest_path)) {
        return;
    }

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

fn readFileZ(io: std.Io, allocator: std.mem.Allocator, path: []const u8) ![:0]u8 {
    const bytes = try std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .unlimited);
    defer allocator.free(bytes);
    return allocator.dupeZ(u8, bytes);
}

fn configureWebviewRuntime(io: std.Io, allocator: std.mem.Allocator, core: *const Core, dist_dir: []const u8) !void {
    const full_path = try std.fs.path.join(allocator, &.{ dist_dir, "preload-full.js" });
    defer allocator.free(full_path);
    const sandboxed_path = try std.fs.path.join(allocator, &.{ dist_dir, "preload-sandboxed.js" });
    defer allocator.free(sandboxed_path);

    const full_preload = try readFileZ(io, allocator, full_path);
    defer allocator.free(full_preload);
    const sandboxed_preload = try readFileZ(io, allocator, sandboxed_path);
    defer allocator.free(sandboxed_preload);

    if (!core.symbols.configure_webview_runtime(0, full_preload.ptr, sandboxed_preload.ptr)) {
        return error.ConfigureWebviewRuntimeFailed;
    }
}

fn setErrorOut(error_out: *?[*:0]u8, message: []const u8) void {
    error_out.* = allocCString(message);
}

fn requireCore(error_out: *?[*:0]u8) ?*Core {
    if (!state.enabled) {
        setErrorOut(error_out, "electrobun bridge is not enabled");
        return null;
    }

    if (state.core) |*core| {
        return core;
    }

    setErrorOut(error_out, "electrobun core is not loaded");
    return null;
}

fn lookupCoreSymbol(comptime T: type, core: *Core, symbol_name: [*:0]const u8, error_out: *?[*:0]u8) ?T {
    return core.lib.lookup(T, std.mem.span(symbol_name)) orelse {
        const message = std.fmt.allocPrint(std.heap.c_allocator, "missing electrobun core symbol: {s}", .{std.mem.span(symbol_name)}) catch {
            setErrorOut(error_out, "missing electrobun core symbol");
            return null;
        };
        defer std.heap.c_allocator.free(message);
        setErrorOut(error_out, message);
        return null;
    };
}

fn ensureWgpuLib(error_out: *?[*:0]u8) ?*std.DynLib {
    if (!state.enabled) {
        setErrorOut(error_out, "electrobun bridge is not enabled");
        return null;
    }

    if (state.wgpu_lib) |*lib| {
        return lib;
    }

    const exe_dir = state.exe_dir orelse {
        setErrorOut(error_out, "electrobun executable directory is not available");
        return null;
    };
    const path = std.fs.path.join(std.heap.c_allocator, &.{ exe_dir, wgpuLibraryName() }) catch {
        setErrorOut(error_out, "failed to build WGPU library path");
        return null;
    };
    defer std.heap.c_allocator.free(path);

    state.wgpu_lib = std.DynLib.open(path) catch {
        setErrorOut(error_out, "failed to load WGPU library");
        return null;
    };
    return &state.wgpu_lib.?;
}

fn finishCoreVoidCall(core: *Core, error_out: *?[*:0]u8) c_int {
    _ = core;
    _ = error_out;
    return 0;
}

fn copyAndFreeCoreString(core: *Core, value: ?[*:0]u8, error_out: *?[*:0]u8) ?[*:0]u8 {
    const ptr = value orelse return null;
    defer core.symbols.free_core_string(ptr);

    return allocCString(std.mem.span(ptr)) orelse {
        setErrorOut(error_out, "failed to allocate string result");
        return null;
    };
}

fn enqueueOwnedEvent(event: [:0]u8) void {
    spinLock();
    defer unlock();

    state.event_queue.append(std.heap.c_allocator, event) catch {
        std.heap.c_allocator.free(event);
    };
}

fn enqueueEvent(comptime fmt: []const u8, args: anytype) void {
    const event = std.fmt.allocPrintSentinel(std.heap.c_allocator, fmt, args, 0) catch return;
    enqueueOwnedEvent(event);
}

fn jsonStringAlloc(value: []const u8) ?[]u8 {
    return std.json.Stringify.valueAlloc(std.heap.c_allocator, value, .{}) catch null;
}

fn onWindowClose(window_id: u32) callconv(.c) void {
    var should_quit = false;
    var core_ptr: ?*Core = null;

    {
        spinLock();
        defer unlock();

        should_quit = state.quit_on_close_windows.remove(window_id);
        if (state.core) |*core| {
            core_ptr = core;
        }
    }

    enqueueEvent("{{\"type\":\"windowClose\",\"windowId\":{d}}}", .{window_id});

    if (should_quit and core_ptr != null) {
        core_ptr.?.symbols.stop_event_loop();
    }
}

fn onWindowMove(window_id: u32, x: f64, y: f64) callconv(.c) void {
    enqueueEvent("{{\"type\":\"windowMove\",\"windowId\":{d},\"x\":{d},\"y\":{d}}}", .{ window_id, x, y });
}

fn onWindowResize(window_id: u32, x: f64, y: f64, width: f64, height: f64) callconv(.c) void {
    enqueueEvent(
        "{{\"type\":\"windowResize\",\"windowId\":{d},\"x\":{d},\"y\":{d},\"width\":{d},\"height\":{d}}}",
        .{ window_id, x, y, width, height },
    );
}

fn onWindowFocus(window_id: u32) callconv(.c) void {
    enqueueEvent("{{\"type\":\"windowFocus\",\"windowId\":{d}}}", .{window_id});
}

fn onWindowBlur(window_id: u32) callconv(.c) void {
    enqueueEvent("{{\"type\":\"windowBlur\",\"windowId\":{d}}}", .{window_id});
}

fn allowAllNavigation(_: u32, _: [*:0]const u8) callconv(.c) u32 {
    return 1;
}

fn onWebviewEvent(webview_id: u32, event_name: [*:0]const u8, detail: [*:0]const u8) callconv(.c) void {
    const event_name_json = jsonStringAlloc(std.mem.span(event_name)) orelse return;
    defer std.heap.c_allocator.free(event_name_json);
    const detail_json = jsonStringAlloc(std.mem.span(detail)) orelse return;
    defer std.heap.c_allocator.free(detail_json);

    enqueueEvent(
        "{{\"type\":\"webviewEvent\",\"webviewId\":{d},\"eventName\":{s},\"detail\":{s}}}",
        .{ webview_id, event_name_json, detail_json },
    );
}

fn onWebviewEventBridge(webview_id: u32, message: [*:0]const u8) callconv(.c) void {
    const message_json = jsonStringAlloc(std.mem.span(message)) orelse return;
    defer std.heap.c_allocator.free(message_json);

    enqueueEvent(
        "{{\"type\":\"webviewEventBridge\",\"webviewId\":{d},\"message\":{s}}}",
        .{ webview_id, message_json },
    );
}

fn onWebviewHostBridge(webview_id: u32, message: [*:0]const u8) callconv(.c) void {
    const message_json = jsonStringAlloc(std.mem.span(message)) orelse return;
    defer std.heap.c_allocator.free(message_json);

    enqueueEvent(
        "{{\"type\":\"webviewHostBridge\",\"webviewId\":{d},\"message\":{s}}}",
        .{ webview_id, message_json },
    );
}

fn onWebviewInternalBridge(webview_id: u32, message: [*:0]const u8) callconv(.c) void {
    const message_json = jsonStringAlloc(std.mem.span(message)) orelse return;
    defer std.heap.c_allocator.free(message_json);

    enqueueEvent(
        "{{\"type\":\"webviewInternalBridge\",\"webviewId\":{d},\"message\":{s}}}",
        .{ webview_id, message_json },
    );
}

fn onStatusItem(item_id: u32, message: [*:0]const u8) callconv(.c) void {
    const message_json = jsonStringAlloc(std.mem.span(message)) orelse return;
    defer std.heap.c_allocator.free(message_json);

    enqueueEvent(
        "{{\"type\":\"statusItem\",\"itemId\":{d},\"message\":{s}}}",
        .{ item_id, message_json },
    );
}

fn onGlobalShortcut(accelerator: [*:0]const u8) callconv(.c) void {
    const accelerator_json = jsonStringAlloc(std.mem.span(accelerator)) orelse return;
    defer std.heap.c_allocator.free(accelerator_json);

    enqueueEvent("{{\"type\":\"globalShortcut\",\"accelerator\":{s}}}", .{accelerator_json});
}

fn onURLOpen(url: [*:0]const u8) callconv(.c) void {
    const url_json = jsonStringAlloc(std.mem.span(url)) orelse return;
    defer std.heap.c_allocator.free(url_json);

    enqueueEvent("{{\"type\":\"urlOpen\",\"url\":{s}}}", .{url_json});
}

fn onAppReopen() callconv(.c) void {
    enqueueEvent("{{\"type\":\"appReopen\"}}", .{});
}

fn onQuitRequested() callconv(.c) void {
    enqueueEvent("{{\"type\":\"quitRequested\"}}", .{});
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
    title_bar_style: [*:0]const u8,
    transparent: bool,
    hidden: bool,
    activate: bool,
    traffic_light_x: f64,
    traffic_light_y: f64,
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

    const style_mask = core.defaultWindowStyle();

    const window_id = core.symbols.create_window(
        x,
        y,
        width,
        height,
        style_mask,
        title_bar_style,
        transparent,
        title,
        hidden,
        activate,
        traffic_light_x,
        traffic_light_y,
        onWindowClose,
        onWindowMove,
        onWindowResize,
        onWindowFocus,
        onWindowBlur,
        null,
    );

    if (window_id == 0) {
        operationError(error_out, "createWindow");
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

export fn ct_electrobun_create_webview_host(
    window_id: u32,
    host_webview_id: u32,
    renderer: [*:0]const u8,
    url: [*:0]const u8,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    auto_resize: bool,
    partition: [*:0]const u8,
    secret_key: [*:0]const u8,
    preload: [*:0]const u8,
    views_root: [*:0]const u8,
    sandbox: bool,
    start_transparent: bool,
    start_passthrough: bool,
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

    const webview_id = core.symbols.create_webview(
        window_id,
        host_webview_id,
        renderer,
        url,
        x,
        y,
        width,
        height,
        auto_resize,
        partition,
        allowAllNavigation,
        onWebviewEvent,
        onWebviewEventBridge,
        onWebviewHostBridge,
        onWebviewInternalBridge,
        secret_key,
        preload,
        views_root,
        sandbox,
        start_transparent,
        start_passthrough,
    );

    if (webview_id == 0) {
        operationError(error_out, "createWebview");
        return 0;
    }

    return webview_id;
}

export fn ct_electrobun_close_window_host(window_id: u32, error_out: *?[*:0]u8) c_int {
    error_out.* = null;

    if (!state.enabled) {
        setErrorOut(error_out, "electrobun bridge is not enabled");
        return -1;
    }

    const core = state.core orelse {
        setErrorOut(error_out, "electrobun core is not loaded");
        return -1;
    };

    core.symbols.close_window(window_id);
    return 0;
}

export fn ct_electrobun_set_window_always_on_top_host(window_id: u32, flag: bool, error_out: *?[*:0]u8) c_int {
    error_out.* = null;

    if (!state.enabled) {
        setErrorOut(error_out, "electrobun bridge is not enabled");
        return -1;
    }

    const core = state.core orelse {
        setErrorOut(error_out, "electrobun core is not loaded");
        return -1;
    };

    core.symbols.set_window_always_on_top(window_id, flag);
    return 0;
}

export fn ct_electrobun_send_host_message_host(
    webview_id: u32,
    message: [*:0]const u8,
    error_out: *?[*:0]u8,
) bool {
    error_out.* = null;

    const core = requireCore(error_out) orelse return false;

    if (core.symbols.send_host_message_to_webview_via_transport(webview_id, message)) {
        return true;
    }

    const eval_func = lookupCoreSymbol(U32StringFn, core, "evaluateJavaScriptWithNoCompletion", error_out) orelse return false;
    const js = std.fmt.allocPrint(
        std.heap.c_allocator,
        "window.__electrobun.receiveMessageFromHost({s});",
        .{std.mem.span(message)},
    ) catch {
        setErrorOut(error_out, "failed to allocate host message fallback script");
        return false;
    };
    defer std.heap.c_allocator.free(js);
    const js_z = std.heap.c_allocator.dupeZ(u8, js) catch {
        setErrorOut(error_out, "failed to allocate host message fallback script");
        return false;
    };
    defer std.heap.c_allocator.free(js_z);

    eval_func(webview_id, js_z.ptr);
    if (finishCoreVoidCall(core, error_out) != 0) {
        return false;
    }

    return true;
}

export fn ct_electrobun_pop_host_message_host(
    out_webview_id: *u32,
    error_out: *?[*:0]u8,
) ?[*:0]u8 {
    error_out.* = null;
    out_webview_id.* = 0;

    if (!state.enabled) {
        setErrorOut(error_out, "electrobun bridge is not enabled");
        return null;
    }

    const core = state.core orelse {
        setErrorOut(error_out, "electrobun core is not loaded");
        return null;
    };

    const message = core.symbols.pop_next_queued_host_message(out_webview_id) orelse return null;
    defer core.symbols.free_core_string(message);

    return allocCString(std.mem.span(message)) orelse {
        setErrorOut(error_out, "Failed to allocate host message");
        return null;
    };
}

export fn ct_electrobun_pop_event_host(error_out: *?[*:0]u8) ?[*:0]u8 {
    error_out.* = null;

    spinLock();
    const event = if (state.event_queue.items.len > 0)
        state.event_queue.orderedRemove(0)
    else
        null;
    unlock();

    const owned = event orelse return null;
    defer std.heap.c_allocator.free(owned);

    return allocCString(owned) orelse {
        setErrorOut(error_out, "failed to allocate native event");
        return null;
    };
}

export fn ct_electrobun_call_u32_host(symbol_name: [*:0]const u8, value: u32, error_out: *?[*:0]u8) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(U32Fn, core, symbol_name, error_out) orelse return -1;
    func(value);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_call_u32_bool_host(symbol_name: [*:0]const u8, value: u32, flag: bool, error_out: *?[*:0]u8) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(U32BoolFn, core, symbol_name, error_out) orelse return -1;
    func(value, flag);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_call_u32_bool_ret_host(symbol_name: [*:0]const u8, value: u32, error_out: *?[*:0]u8) bool {
    error_out.* = null;
    const core = requireCore(error_out) orelse return false;
    const func = lookupCoreSymbol(U32BoolRetFn, core, symbol_name, error_out) orelse return false;
    return func(value);
}

export fn ct_electrobun_call_u32_string_host(symbol_name: [*:0]const u8, value: u32, text: [*:0]const u8, error_out: *?[*:0]u8) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(U32StringFn, core, symbol_name, error_out) orelse return -1;
    func(value, text);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_call_u32_string_bool_ret_host(symbol_name: [*:0]const u8, value: u32, text: [*:0]const u8, error_out: *?[*:0]u8) bool {
    error_out.* = null;
    const core = requireCore(error_out) orelse return false;
    const func = lookupCoreSymbol(U32StringBoolRetFn, core, symbol_name, error_out) orelse return false;
    return func(value, text);
}

export fn ct_electrobun_call_u32_string_bool_bool_host(
    symbol_name: [*:0]const u8,
    value: u32,
    text: [*:0]const u8,
    a: bool,
    b: bool,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(U32StringBoolBoolFn, core, symbol_name, error_out) orelse return -1;
    func(value, text, a, b);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_call_u32_f64_f64_host(
    symbol_name: [*:0]const u8,
    value: u32,
    x: f64,
    y: f64,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(U32F64F64Fn, core, symbol_name, error_out) orelse return -1;
    func(value, x, y);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_call_u32_f64_host(symbol_name: [*:0]const u8, value: u32, number: f64, error_out: *?[*:0]u8) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(U32F64Fn, core, symbol_name, error_out) orelse return -1;
    func(value, number);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_call_u32_f64_ret_host(symbol_name: [*:0]const u8, value: u32, error_out: *?[*:0]u8) f64 {
    error_out.* = null;
    const core = requireCore(error_out) orelse return 0;
    const func = lookupCoreSymbol(U32F64RetFn, core, symbol_name, error_out) orelse return 0;
    return func(value);
}

export fn ct_electrobun_call_u32_f64_f64_f64_f64_host(
    symbol_name: [*:0]const u8,
    value: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(U32F64F64F64F64Fn, core, symbol_name, error_out) orelse return -1;
    func(value, x, y, width, height);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_get_window_frame_host(window_id: u32, error_out: *?[*:0]u8) ?[*:0]u8 {
    error_out.* = null;
    const core = requireCore(error_out) orelse return null;
    const func = lookupCoreSymbol(GetWindowFrameFn, core, "getWindowFrame", error_out) orelse return null;

    var x: f64 = 0;
    var y: f64 = 0;
    var width: f64 = 0;
    var height: f64 = 0;
    func(window_id, &x, &y, &width, &height);
    if (finishCoreVoidCall(core, error_out) != 0) {
        return null;
    }

    const json = std.fmt.allocPrintSentinel(
        std.heap.c_allocator,
        "{{\"x\":{d},\"y\":{d},\"width\":{d},\"height\":{d}}}",
        .{ x, y, width, height },
        0,
    ) catch {
        setErrorOut(error_out, "failed to allocate window frame");
        return null;
    };
    return json.ptr;
}

export fn ct_electrobun_resize_view_host(
    symbol_name: [*:0]const u8,
    view_id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    masks_json: [*:0]const u8,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(ResizeViewFn, core, symbol_name, error_out) orelse return -1;
    func(view_id, x, y, width, height, masks_json);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_call_bool_host(symbol_name: [*:0]const u8, flag: bool, error_out: *?[*:0]u8) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(BoolFn, core, symbol_name, error_out) orelse return -1;
    func(flag);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_call_bool_ret_host(symbol_name: [*:0]const u8, error_out: *?[*:0]u8) bool {
    error_out.* = null;
    const core = requireCore(error_out) orelse return false;
    const func = lookupCoreSymbol(BoolRetFn, core, symbol_name, error_out) orelse return false;
    return func();
}

export fn ct_electrobun_call_void_host(symbol_name: [*:0]const u8, error_out: *?[*:0]u8) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(VoidFn, core, symbol_name, error_out) orelse return -1;
    func();
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_call_string_host(symbol_name: [*:0]const u8, value: [*:0]const u8, error_out: *?[*:0]u8) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(StringFn, core, symbol_name, error_out) orelse return -1;
    func(value);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_call_string_bool_ret_host(symbol_name: [*:0]const u8, value: [*:0]const u8, error_out: *?[*:0]u8) bool {
    error_out.* = null;
    const core = requireCore(error_out) orelse return false;
    const func = lookupCoreSymbol(StringBoolRetFn, core, symbol_name, error_out) orelse return false;
    return func(value);
}

export fn ct_electrobun_call_string_ret_host(symbol_name: [*:0]const u8, error_out: *?[*:0]u8) ?[*:0]u8 {
    error_out.* = null;
    const core = requireCore(error_out) orelse return null;
    const func = lookupCoreSymbol(StringRetFn, core, symbol_name, error_out) orelse return null;
    return copyAndFreeCoreString(core, func(), error_out);
}

export fn ct_electrobun_call_string_string_ret_host(
    symbol_name: [*:0]const u8,
    a: [*:0]const u8,
    b: [*:0]const u8,
    error_out: *?[*:0]u8,
) ?[*:0]u8 {
    error_out.* = null;
    const core = requireCore(error_out) orelse return null;
    const func = lookupCoreSymbol(StringStringRetFn, core, symbol_name, error_out) orelse return null;
    return copyAndFreeCoreString(core, func(a, b), error_out);
}

export fn ct_electrobun_call_string_string_bool_ret_host(
    symbol_name: [*:0]const u8,
    a: [*:0]const u8,
    b: [*:0]const u8,
    error_out: *?[*:0]u8,
) bool {
    error_out.* = null;
    const core = requireCore(error_out) orelse return false;
    const func = lookupCoreSymbol(StringStringBoolRetFn, core, symbol_name, error_out) orelse return false;
    return func(a, b);
}

export fn ct_electrobun_call_string_string_string_bool_ret_host(
    symbol_name: [*:0]const u8,
    a: [*:0]const u8,
    b: [*:0]const u8,
    d: [*:0]const u8,
    error_out: *?[*:0]u8,
) bool {
    error_out.* = null;
    const core = requireCore(error_out) orelse return false;
    const func = lookupCoreSymbol(StringStringStringBoolRetFn, core, symbol_name, error_out) orelse return false;
    return func(a, b, d);
}

export fn ct_electrobun_call_string_string_host(
    symbol_name: [*:0]const u8,
    a: [*:0]const u8,
    b: [*:0]const u8,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(StringStringFn, core, symbol_name, error_out) orelse return -1;
    func(a, b);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_call_int_host(symbol_name: [*:0]const u8, value: c_int, error_out: *?[*:0]u8) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(IntFn, core, symbol_name, error_out) orelse return -1;
    func(value);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_call_u32_ptr_exists_host(symbol_name: [*:0]const u8, value: u32, error_out: *?[*:0]u8) bool {
    error_out.* = null;
    const core = requireCore(error_out) orelse return false;
    const func = lookupCoreSymbol(U32PtrRetFn, core, symbol_name, error_out) orelse return false;
    return func(value) != null;
}

fn nativeCallVoid(lib: *std.DynLib, symbol_name: [:0]const u8, args: []const u64, error_out: *?[*:0]u8) bool {
    if (std.mem.eql(u8, symbol_name, "wgpuRenderPassEncoderSetViewport")) {
        if (args.len != 7) {
            setErrorOut(error_out, "wgpuRenderPassEncoderSetViewport requires 7 arguments");
            return false;
        }
        const func = lib.lookup(WgpuRenderPassSetViewportFn, symbol_name) orelse return missingNativeSymbol(symbol_name, error_out);
        func(
            args[0],
            @floatFromInt(args[1]),
            @floatFromInt(args[2]),
            @floatFromInt(args[3]),
            @floatFromInt(args[4]),
            @floatFromInt(args[5]),
            @floatFromInt(args[6]),
        );
        return true;
    }

    switch (args.len) {
        0 => (lib.lookup(NativeVoid0Fn, symbol_name) orelse return missingNativeSymbol(symbol_name, error_out))(),
        1 => (lib.lookup(NativeVoid1Fn, symbol_name) orelse return missingNativeSymbol(symbol_name, error_out))(args[0]),
        2 => (lib.lookup(NativeVoid2Fn, symbol_name) orelse return missingNativeSymbol(symbol_name, error_out))(args[0], args[1]),
        3 => (lib.lookup(NativeVoid3Fn, symbol_name) orelse return missingNativeSymbol(symbol_name, error_out))(args[0], args[1], args[2]),
        4 => (lib.lookup(NativeVoid4Fn, symbol_name) orelse return missingNativeSymbol(symbol_name, error_out))(args[0], args[1], args[2], args[3]),
        5 => (lib.lookup(NativeVoid5Fn, symbol_name) orelse return missingNativeSymbol(symbol_name, error_out))(args[0], args[1], args[2], args[3], args[4]),
        6 => (lib.lookup(NativeVoid6Fn, symbol_name) orelse return missingNativeSymbol(symbol_name, error_out))(args[0], args[1], args[2], args[3], args[4], args[5]),
        7 => (lib.lookup(NativeVoid7Fn, symbol_name) orelse return missingNativeSymbol(symbol_name, error_out))(args[0], args[1], args[2], args[3], args[4], args[5], args[6]),
        8 => (lib.lookup(NativeVoid8Fn, symbol_name) orelse return missingNativeSymbol(symbol_name, error_out))(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]),
        else => {
            setErrorOut(error_out, "native calls support at most 8 arguments");
            return false;
        },
    }
    return true;
}

fn nativeCallRet(lib: *std.DynLib, symbol_name: [:0]const u8, args: []const u64, error_out: *?[*:0]u8) ?u64 {
    return switch (args.len) {
        0 => (lib.lookup(NativeRet0Fn, symbol_name) orelse return missingNativeSymbolRet(symbol_name, error_out))(),
        1 => (lib.lookup(NativeRet1Fn, symbol_name) orelse return missingNativeSymbolRet(symbol_name, error_out))(args[0]),
        2 => (lib.lookup(NativeRet2Fn, symbol_name) orelse return missingNativeSymbolRet(symbol_name, error_out))(args[0], args[1]),
        3 => (lib.lookup(NativeRet3Fn, symbol_name) orelse return missingNativeSymbolRet(symbol_name, error_out))(args[0], args[1], args[2]),
        4 => (lib.lookup(NativeRet4Fn, symbol_name) orelse return missingNativeSymbolRet(symbol_name, error_out))(args[0], args[1], args[2], args[3]),
        5 => (lib.lookup(NativeRet5Fn, symbol_name) orelse return missingNativeSymbolRet(symbol_name, error_out))(args[0], args[1], args[2], args[3], args[4]),
        6 => (lib.lookup(NativeRet6Fn, symbol_name) orelse return missingNativeSymbolRet(symbol_name, error_out))(args[0], args[1], args[2], args[3], args[4], args[5]),
        7 => (lib.lookup(NativeRet7Fn, symbol_name) orelse return missingNativeSymbolRet(symbol_name, error_out))(args[0], args[1], args[2], args[3], args[4], args[5], args[6]),
        8 => (lib.lookup(NativeRet8Fn, symbol_name) orelse return missingNativeSymbolRet(symbol_name, error_out))(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]),
        else => {
            setErrorOut(error_out, "native calls support at most 8 arguments");
            return null;
        },
    };
}

fn missingNativeSymbol(symbol_name: []const u8, error_out: *?[*:0]u8) bool {
    const message = std.fmt.allocPrint(std.heap.c_allocator, "missing native symbol: {s}", .{symbol_name}) catch {
        setErrorOut(error_out, "missing native symbol");
        return false;
    };
    defer std.heap.c_allocator.free(message);
    setErrorOut(error_out, message);
    return false;
}

fn missingNativeSymbolRet(symbol_name: []const u8, error_out: *?[*:0]u8) ?u64 {
    _ = missingNativeSymbol(symbol_name, error_out);
    return null;
}

export fn ct_electrobun_native_call_host(
    library_name: [*:0]const u8,
    symbol_name: [*:0]const u8,
    return_type: [*:0]const u8,
    argc: usize,
    args_ptr: [*]const u64,
    result_out: *u64,
    error_out: *?[*:0]u8,
) bool {
    error_out.* = null;
    result_out.* = 0;

    const library = std.mem.span(library_name);
    const symbol: [:0]const u8 = std.mem.span(symbol_name);
    const returns = std.mem.span(return_type);
    const args = args_ptr[0..argc];

    const lib = if (std.mem.eql(u8, library, "core"))
        &(requireCore(error_out) orelse return false).lib
    else if (std.mem.eql(u8, library, "wgpu"))
        ensureWgpuLib(error_out) orelse return false
    else {
        setErrorOut(error_out, "unknown native library");
        return false;
    };

    if (std.mem.eql(u8, returns, "void")) {
        return nativeCallVoid(lib, symbol, args, error_out);
    }

    const result = nativeCallRet(lib, symbol, args, error_out) orelse return false;
    result_out.* = result;
    return true;
}

export fn ct_electrobun_create_wgpu_view_host(
    window_id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    start_transparent: bool,
    start_passthrough: bool,
    hidden: bool,
    error_out: *?[*:0]u8,
) c_uint {
    error_out.* = null;
    const core = requireCore(error_out) orelse return 0;
    const func = lookupCoreSymbol(CreateWGPUViewFn, core, "createWGPUView", error_out) orelse return 0;
    const view_id = func(window_id, x, y, width, height, start_transparent, start_passthrough, hidden);
    if (view_id == 0) {
        operationError(error_out, "createWGPUView");
    }
    return view_id;
}

export fn ct_electrobun_create_tray_host(
    title: [*:0]const u8,
    image: [*:0]const u8,
    is_template: bool,
    width: u32,
    height: u32,
    handler_enabled: bool,
    error_out: *?[*:0]u8,
) c_uint {
    error_out.* = null;
    const core = requireCore(error_out) orelse return 0;
    const func = lookupCoreSymbol(CreateTrayFn, core, "createTray", error_out) orelse return 0;
    const tray_id = func(title, image, is_template, width, height, if (handler_enabled) onStatusItem else null);
    if (tray_id == 0) {
        operationError(error_out, "createTray");
    }
    return tray_id;
}

export fn ct_electrobun_show_tray_host(tray_id: u32, error_out: *?[*:0]u8) bool {
    error_out.* = null;
    const core = requireCore(error_out) orelse return false;
    const func = lookupCoreSymbol(ShowTrayFn, core, "showTray", error_out) orelse return false;
    const ok = func(tray_id);
    if (!ok) {
        operationError(error_out, "showTray");
    }
    return ok;
}

export fn ct_electrobun_get_tray_bounds_host(tray_id: u32, error_out: *?[*:0]u8) ?[*:0]u8 {
    error_out.* = null;
    const core = requireCore(error_out) orelse return null;
    const func = lookupCoreSymbol(U32ConstStringRetFn, core, "getTrayBounds", error_out) orelse return null;
    const ptr = func(tray_id) orelse {
        operationError(error_out, "getTrayBounds");
        return null;
    };
    return allocCString(std.mem.span(ptr)) orelse {
        setErrorOut(error_out, "failed to allocate tray bounds");
        return null;
    };
}

export fn ct_electrobun_show_notification_host(
    title: [*:0]const u8,
    body: [*:0]const u8,
    subtitle: [*:0]const u8,
    silent: bool,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    if (builtin.os.tag == .macos and !state.running_in_app_bundle) {
        return 0;
    }
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(NotificationFn, core, "showNotification", error_out) orelse return -1;
    func(title, body, subtitle, silent);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_set_menu_host(
    symbol_name: [*:0]const u8,
    menu_json: [*:0]const u8,
    handler_enabled: bool,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(MenuFn, core, symbol_name, error_out) orelse return -1;
    func(menu_json, if (handler_enabled) onStatusItem else null);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_open_file_dialog_host(
    starting_folder: [*:0]const u8,
    allowed_file_types: [*:0]const u8,
    can_choose_files: c_int,
    can_choose_directories: c_int,
    allows_multiple_selection: c_int,
    error_out: *?[*:0]u8,
) ?[*:0]u8 {
    error_out.* = null;
    const core = requireCore(error_out) orelse return null;
    const func = lookupCoreSymbol(OpenFileDialogFn, core, "openFileDialog", error_out) orelse return null;
    return copyAndFreeCoreString(
        core,
        func(starting_folder, allowed_file_types, can_choose_files, can_choose_directories, allows_multiple_selection),
        error_out,
    );
}

export fn ct_electrobun_show_message_box_host(
    box_type: [*:0]const u8,
    title: [*:0]const u8,
    message: [*:0]const u8,
    detail: [*:0]const u8,
    buttons: [*:0]const u8,
    default_id: c_int,
    cancel_id: c_int,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(ShowMessageBoxFn, core, "showMessageBox", error_out) orelse return -1;
    const result = func(box_type, title, message, detail, buttons, default_id, cancel_id);
    _ = finishCoreVoidCall(core, error_out);
    return result;
}

export fn ct_electrobun_set_global_shortcut_callback_host(enabled: bool, error_out: *?[*:0]u8) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(SetGlobalShortcutCallbackFn, core, "setGlobalShortcutCallback", error_out) orelse return -1;
    func(if (enabled) onGlobalShortcut else null);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_set_url_open_handler_host(enabled: bool, error_out: *?[*:0]u8) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(SetURLOpenHandlerFn, core, "setURLOpenHandler", error_out) orelse return -1;
    func(if (enabled) onURLOpen else null);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_set_app_reopen_handler_host(enabled: bool, error_out: *?[*:0]u8) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(SetAppReopenHandlerFn, core, "setAppReopenHandler", error_out) orelse return -1;
    func(if (enabled) onAppReopen else null);
    return finishCoreVoidCall(core, error_out);
}

export fn ct_electrobun_set_quit_requested_handler_host(enabled: bool, error_out: *?[*:0]u8) c_int {
    error_out.* = null;
    const core = requireCore(error_out) orelse return -1;
    const func = lookupCoreSymbol(SetQuitRequestedHandlerFn, core, "setQuitRequestedHandler", error_out) orelse return -1;
    func(if (enabled) onQuitRequested else null);
    return finishCoreVoidCall(core, error_out);
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
