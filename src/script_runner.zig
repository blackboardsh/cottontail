const std = @import("std");
const builtin = @import("builtin");
const compiler = @import("cottontail_compiler");
const cli_run_execution = @import("cli_run_execution.zig");
const runtime = @import("runtime.zig");
const heap_profiler = @import("heap_profiler.zig");
const icu_bootstrap = @import("icu_bootstrap.zig");
const native_bundler = @import("cottontail_bundler.zig");
const native_transpiler = @import("cottontail_transpiler.zig");
const embedded_runtime_modules = @import("embedded_runtime_modules.zig");
const standalone_executable = @import("standalone_executable.zig");

const script_thread_stack_size = 128 * 1024 * 1024;
const script_js_stack_size = 96 * 1024 * 1024;

var process_init: ?std.process.Init = null;

pub fn configureProcess(init: std.process.Init) void {
    process_init = init;
}

const RunElectrobunMainThreadFn = *const fn (
    [*:0]const u8,
    [*:0]const u8,
    [*:0]const u8,
    c_int,
) callconv(.c) c_int;
const ElectrobunLastErrorFn = *const fn () callconv(.c) ?[*:0]const u8;

const Win32Library = opaque {};
extern "kernel32" fn LoadLibraryA(path: [*:0]const u8) callconv(.c) ?*Win32Library;
extern "kernel32" fn GetProcAddress(library: *Win32Library, name: [*:0]const u8) callconv(.c) ?*anyopaque;
extern "kernel32" fn FreeLibrary(library: *Win32Library) callconv(.c) c_int;
extern "kernel32" fn CreateThread(
    thread_attributes: ?*anyopaque,
    stack_size: usize,
    start_address: *const fn (?*anyopaque) callconv(.winapi) u32,
    parameter: ?*anyopaque,
    creation_flags: u32,
    thread_id: ?*u32,
) callconv(.winapi) ?std.os.windows.HANDLE;
extern "kernel32" fn VirtualQuery(
    address: ?*const anyopaque,
    information: *WindowsMemoryBasicInformation,
    information_size: usize,
) callconv(.winapi) usize;
extern "kernel32" fn GetCurrentProcess() callconv(.winapi) std.os.windows.HANDLE;
extern "kernel32" fn TerminateProcess(
    process: std.os.windows.HANDLE,
    exit_code: u32,
) callconv(.winapi) i32;

const stack_size_param_is_a_reservation = 0x00010000;
const mem_reserve = 0x00002000;
const page_guard = 0x00000100;

const WindowsMemoryBasicInformation = extern struct {
    base_address: ?*anyopaque,
    allocation_base: ?*anyopaque,
    allocation_protect: u32,
    partition_id: u16,
    region_size: usize,
    state: u32,
    protect: u32,
    kind: u32,
};

const ReloadMode = enum {
    none,
    hot,
    watch,
};

const ReloadExecution = struct {
    ctx: Context,
    entrypoint_path: []const u8,
    process_argv: []const [:0]const u8,
    mode: ReloadMode,
    clear_screen: bool,
};

const ScriptExecution = struct {
    io: std.Io,
    allocator: std.mem.Allocator,
    runnable_path: [:0]const u8,
    process_args: []const [:0]const u8,
    process_user_arg_offset: usize,
    exec_args: []const [:0]const u8,
    inspector: ?InspectorLaunch = null,
    embedded_source: ?[]const u8 = null,
    embedded_source_map: ?[]const u8 = null,
    embedded_files: ?[]const u8 = null,
    embedded_bytecode: ?[]const u8 = null,
    standalone_flags: ?standalone_executable.Flags = null,
    exit_cleanup_path: ?[:0]const u8 = null,
    test_cli_execution: bool = false,
    reload: ?ReloadExecution = null,
    exit_code: u8 = 1,
};

const InspectorLaunch = struct {
    options: runtime.InspectorOptions,
    display_address: []const u8,
    notification: ?InspectorNotification = null,
    wait_for_connection: bool = false,
    automatic: bool = false,
};

const InspectorNotification = union(enum) {
    unix: [:0]const u8,
    tcp: struct {
        host: [:0]const u8,
        port: u16,
    },
};

const WindowsScriptThread = struct {
    handle: std.os.windows.HANDLE,

    fn start(execution: *ScriptExecution) !WindowsScriptThread {
        return startRaw(windowsScriptThreadEntry, execution);
    }

    fn startRaw(
        start_address: *const fn (?*anyopaque) callconv(.winapi) u32,
        parameter: ?*anyopaque,
    ) !WindowsScriptThread {
        const handle = CreateThread(
            null,
            script_thread_stack_size,
            start_address,
            parameter,
            stack_size_param_is_a_reservation,
            null,
        ) orelse return error.ScriptThreadSpawnFailed;
        return .{ .handle = handle };
    }

    fn join(self: WindowsScriptThread) void {
        const infinite_timeout: std.os.windows.LARGE_INTEGER = std.math.minInt(std.os.windows.LARGE_INTEGER);
        switch (std.os.windows.ntdll.NtWaitForSingleObject(self.handle, .FALSE, &infinite_timeout)) {
            .WAIT_0 => {},
            else => |status| std.os.windows.unexpectedStatus(status) catch unreachable,
        }
    }

    fn deinit(self: WindowsScriptThread) void {
        std.os.windows.CloseHandle(self.handle);
    }
};

fn windowsScriptThreadEntry(raw_execution: ?*anyopaque) callconv(.winapi) u32 {
    const execution: *ScriptExecution = @ptrCast(@alignCast(raw_execution.?));
    runScriptExecution(execution);
    return 0;
}

fn windowsStackLayoutSupportsWebKit() bool {
    var marker: u8 = 0;
    var current_region: WindowsMemoryBasicInformation = undefined;
    if (VirtualQuery(&marker, &current_region, @sizeOf(WindowsMemoryBasicInformation)) == 0) return false;
    const allocation_base = current_region.allocation_base orelse return false;
    const region_base = current_region.base_address orelse return false;
    const origin = @intFromPtr(region_base) + current_region.region_size;

    var reserved_region: WindowsMemoryBasicInformation = undefined;
    if (VirtualQuery(allocation_base, &reserved_region, @sizeOf(WindowsMemoryBasicInformation)) == 0) return false;
    if (reserved_region.state != mem_reserve) return false;

    const guard_address: *const anyopaque = @ptrFromInt(@intFromPtr(reserved_region.base_address orelse return false) + reserved_region.region_size);
    var guard_region: WindowsMemoryBasicInformation = undefined;
    if (VirtualQuery(guard_address, &guard_region, @sizeOf(WindowsMemoryBasicInformation)) == 0) return false;
    if (guard_region.protect & page_guard == 0) return false;

    const guard_base = guard_region.base_address orelse return false;
    if (@intFromPtr(guard_base) != @intFromPtr(guard_address)) return false;
    const bound = @intFromPtr(guard_base) + guard_region.region_size;
    const marker_address = @intFromPtr(&marker);
    return origin >= marker_address and marker_address > bound;
}

test "Windows script thread reserves a WebKit-compatible stack" {
    if (builtin.os.tag != .windows) return error.SkipZigTest;

    const Probe = struct {
        fn run(raw_result: ?*anyopaque) callconv(.winapi) u32 {
            const result: *bool = @ptrCast(@alignCast(raw_result.?));
            result.* = windowsStackLayoutSupportsWebKit();
            return 0;
        }
    };

    var valid = false;
    const thread = try WindowsScriptThread.startRaw(Probe.run, &valid);
    defer thread.deinit();
    thread.join();
    try std.testing.expect(valid);
}

pub const StandaloneSource = standalone_executable.Source;
pub const StandaloneSourceMap = standalone_executable.SourceMap;

const standalone_virtual_path: [:0]const u8 = if (builtin.os.tag == .windows)
    "B:/~BUN/root/index.js"
else
    "/$bunfs/root/index.js";

const Context = struct {
    io: std.Io,
    allocator: std.mem.Allocator,
    environ_map: *std.process.Environ.Map,
    project_root: []const u8,
    executable_stamp: []const u8,
    stderr_capture: ?*std.ArrayList(u8) = null,

    fn writeStdout(self: *const Context, comptime fmt: []const u8, args: anytype) void {
        var buffer: [2048]u8 = undefined;
        var writer = std.Io.File.stdout().writer(self.io, &buffer);
        const stdout = &writer.interface;
        stdout.print(fmt, args) catch {};
        stdout.flush() catch {};
    }

    fn writeStderr(self: *const Context, comptime fmt: []const u8, args: anytype) void {
        if (self.stderr_capture) |capture| {
            const message = std.fmt.allocPrint(self.allocator, fmt, args) catch return;
            capture.appendSlice(self.allocator, message) catch {};
            return;
        }
        var buffer: [2048]u8 = undefined;
        var writer = std.Io.File.stderr().writer(self.io, &buffer);
        const stderr = &writer.interface;
        stderr.print(fmt, args) catch {};
        stderr.flush() catch {};
    }
};

const RuntimeArtifact = struct {
    path: []const u8,
    lease_file: ?std.Io.File = null,

    fn deinit(self: *RuntimeArtifact, ctx: *const Context) void {
        if (self.lease_file) |file| file.close(ctx.io);
        cleanupRunnableDirectory(ctx, self.path);
        self.* = undefined;
    }
};

pub fn run(init: std.process.Init, script_path: [:0]const u8, script_args: []const [:0]const u8) !u8 {
    const empty_exec_args: [0][:0]const u8 = .{};
    return try runWithExecArgv(init, script_path, script_args, empty_exec_args[0..]);
}

pub fn runWithExecArgv(
    init: std.process.Init,
    script_path: [:0]const u8,
    script_args: []const [:0]const u8,
    exec_args: []const [:0]const u8,
) !u8 {
    return runWithExecArgvDisplay(init, script_path, null, script_args, exec_args);
}

fn reloadMode(exec_args: []const [:0]const u8) ReloadMode {
    var mode: ReloadMode = .none;
    for (exec_args) |arg_z| {
        const arg: []const u8 = arg_z;
        if (std.mem.eql(u8, arg, "--hot")) return .hot;
        if (std.mem.eql(u8, arg, "--watch")) mode = .watch;
    }
    return mode;
}

fn reloadShouldClearScreen(exec_args: []const [:0]const u8) bool {
    for (exec_args) |arg_z| {
        const arg: []const u8 = arg_z;
        if (std.mem.eql(u8, arg, "--no-clear-screen")) return false;
    }
    return true;
}

fn preloadPathExists(ctx: *const Context, path: []const u8) bool {
    if (pathExists(ctx.io, path)) return true;
    const extension = std.fs.path.extension(path);
    const suffixes: []const []const u8 = if (extension.len == 0)
        &.{ ".js", ".jsx", ".ts", ".tsx", ".mjs", ".mts", ".cjs", ".cts", ".json" }
    else if (std.mem.eql(u8, extension, ".js") or std.mem.eql(u8, extension, ".jsx"))
        &.{ ".ts", ".tsx", ".mts" }
    else if (std.mem.eql(u8, extension, ".mjs"))
        &.{".mts"}
    else
        &.{};
    const stem = path[0 .. path.len - extension.len];
    for (suffixes) |suffix| {
        const candidate = std.mem.concat(ctx.allocator, u8, &.{ stem, suffix }) catch return false;
        if (pathExists(ctx.io, candidate)) return true;
    }
    for ([_][]const u8{ "index.js", "index.jsx", "index.ts", "index.tsx", "index.mjs", "index.cjs", "package.json" }) |name| {
        const candidate = std.fs.path.join(ctx.allocator, &.{ path, name }) catch return false;
        if (pathExists(ctx.io, candidate)) return true;
    }
    return false;
}

fn missingExplicitPreload(ctx: *const Context, exec_args: []const [:0]const u8) ?[]const u8 {
    var index: usize = 0;
    while (index < exec_args.len) : (index += 1) {
        const arg = exec_args[index];
        var specifier: ?[]const u8 = null;
        if ((std.mem.eql(u8, arg, "--preload") or
            std.mem.eql(u8, arg, "--require") or
            std.mem.eql(u8, arg, "--import") or
            std.mem.eql(u8, arg, "-r")) and index + 1 < exec_args.len)
        {
            index += 1;
            specifier = exec_args[index];
        } else if (std.mem.startsWith(u8, arg, "--preload=")) {
            specifier = arg["--preload=".len..];
        } else if (std.mem.startsWith(u8, arg, "--require=")) {
            specifier = arg["--require=".len..];
        } else if (std.mem.startsWith(u8, arg, "--import=")) {
            specifier = arg["--import=".len..];
        }
        const raw = specifier orelse continue;
        if (!std.fs.path.isAbsolute(raw) and !std.mem.startsWith(u8, raw, ".")) continue;
        const resolved = if (std.fs.path.isAbsolute(raw))
            raw
        else
            std.fs.path.join(ctx.allocator, &.{ ctx.project_root, raw }) catch return raw;
        if (!preloadPathExists(ctx, resolved)) return raw;
    }
    return null;
}

pub fn bunEntrypointFallbackExtensions(path: []const u8) []const []const u8 {
    const extension = std.fs.path.extension(path);
    if (std.mem.eql(u8, extension, ".mjs")) return &.{".mts"};
    if (std.mem.eql(u8, extension, ".js") or std.mem.eql(u8, extension, ".jsx")) return &.{ ".ts", ".tsx", ".mts" };
    return &.{};
}

fn resolveBunEntrypointFallback(ctx: *const Context, script_path: []const u8) ![]const u8 {
    const absolute = try absolutePathForCwd(ctx.io, ctx.allocator, script_path);
    if (realPathIfFile(ctx, absolute)) |resolved| return resolved;

    const extension = std.fs.path.extension(absolute);
    const replacements = bunEntrypointFallbackExtensions(absolute);
    if (replacements.len == 0) return absolute;

    const stem = absolute[0 .. absolute.len - extension.len];
    for (replacements) |replacement| {
        const candidate = try std.mem.concat(ctx.allocator, u8, &.{ stem, replacement });
        if (realPathIfFile(ctx, candidate)) |resolved| return resolved;
    }
    return absolute;
}

pub fn runWithExecArgvDisplay(
    init: std.process.Init,
    script_path: [:0]const u8,
    display_path: ?[:0]const u8,
    script_args: []const [:0]const u8,
    exec_args: []const [:0]const u8,
) !u8 {
    const allocator = init.arena.allocator();
    const ctx = try makeContext(init);
    const entrypoint_path = try resolveBunEntrypointFallback(&ctx, script_path);

    maybeAutoInstall(&ctx, entrypoint_path, exec_args) catch {};

    if (try rejectInvalidBunCjsPragma(&ctx, entrypoint_path)) return 1;

    const process_args = try allocator.alloc([:0]const u8, script_args.len + 1);
    const canonical_script_path = resolvePathForCwd(ctx.io, allocator, script_path) catch
        try absolutePathForCwd(ctx.io, allocator, script_path);
    process_args[0] = display_path orelse try allocator.dupeZ(u8, canonical_script_path);
    for (script_args, 0..) |arg, index| {
        process_args[index + 1] = arg;
    }

    const reload_mode = reloadMode(exec_args);
    if (reload_mode != .none) {
        return try runReloadPrepared(
            init,
            &ctx,
            entrypoint_path,
            process_args,
            exec_args,
            reload_mode,
            reloadShouldClearScreen(exec_args),
        );
    }

    var runnable = bundleScriptNative(&ctx, entrypoint_path, exec_args, script_args, null, null, null, false, null, false) catch |err| {
        if (err == error.TestBundleFailed) return 1;
        if (err == error.SyntaxError) {
            ctx.writeStderr("error: Syntax Error\n", .{});
            return 1;
        }
        return err;
    };
    defer runnable.deinit(&ctx);

    const runnable_path_z = try allocator.dupeZ(u8, runnable.path);
    return try runPrepared(init, &ctx, runnable_path_z, process_args, 1, exec_args, null, null, null, null, null);
}

const AutoInstallMode = enum { auto, fallback, force, disable };

fn autoInstallMode(exec_args: []const [:0]const u8) AutoInstallMode {
    var mode: AutoInstallMode = .auto;
    var index: usize = 0;
    while (index < exec_args.len) : (index += 1) {
        const arg: []const u8 = exec_args[index];
        if (std.mem.eql(u8, arg, "-i")) {
            mode = .fallback;
        } else if (std.mem.startsWith(u8, arg, "--install=")) {
            const value = arg["--install=".len..];
            if (std.mem.eql(u8, value, "auto")) mode = .auto else if (std.mem.eql(u8, value, "fallback")) mode = .fallback else if (std.mem.eql(u8, value, "force")) mode = .force else if (std.mem.eql(u8, value, "disable")) mode = .disable;
        } else if (std.mem.eql(u8, arg, "--install") and index + 1 < exec_args.len) {
            index += 1;
            const value: []const u8 = exec_args[index];
            if (std.mem.eql(u8, value, "auto")) mode = .auto else if (std.mem.eql(u8, value, "fallback")) mode = .fallback else if (std.mem.eql(u8, value, "force")) mode = .force else if (std.mem.eql(u8, value, "disable")) mode = .disable;
        } else if (std.mem.eql(u8, arg, "--no-install")) {
            mode = .disable;
        }
    }
    return mode;
}

const AutoInstallRequest = struct {
    install_specifier: []const u8,
    package_name: []const u8,
    requested_version: ?[]const u8,
};

fn autoInstallRequestFromSpecifier(specifier: []const u8) ?AutoInstallRequest {
    if (specifier.len == 0 or
        std.fs.path.isAbsolute(specifier) or
        std.mem.startsWith(u8, specifier, "./") or
        std.mem.startsWith(u8, specifier, "../") or
        std.mem.startsWith(u8, specifier, "node:") or
        std.mem.startsWith(u8, specifier, "bun:") or
        std.mem.startsWith(u8, specifier, "data:") or
        std.mem.startsWith(u8, specifier, "file:")) return null;
    if (isMinimalRuntimeAliasSpecifier(specifier)) return null;

    const package_end = if (specifier[0] == '@') blk: {
        const slash = std.mem.indexOfScalarPos(u8, specifier, 1, '/') orelse return null;
        break :blk std.mem.indexOfScalarPos(u8, specifier, slash + 1, '/') orelse specifier.len;
    } else std.mem.indexOfScalar(u8, specifier, '/') orelse specifier.len;
    const install_specifier = specifier[0..package_end];
    const version_separator = std.mem.lastIndexOfScalar(u8, install_specifier, '@');
    const has_version = if (version_separator) |separator|
        separator > 0 and (specifier[0] != '@' or std.mem.indexOfScalarPos(u8, install_specifier, 1, '/').? < separator)
    else
        false;
    const package_name = if (has_version) install_specifier[0..version_separator.?] else install_specifier;
    const requested_version = if (has_version and version_separator.? + 1 < install_specifier.len)
        install_specifier[version_separator.? + 1 ..]
    else
        null;
    return .{
        .install_specifier = install_specifier,
        .package_name = package_name,
        .requested_version = requested_version,
    };
}

fn directoryHasNodeModules(ctx: *const Context, start_dir: []const u8) bool {
    var current = start_dir;
    while (true) {
        const path = std.fs.path.join(ctx.allocator, &.{ current, "node_modules" }) catch return false;
        if (std.Io.Dir.cwd().statFile(ctx.io, path, .{})) |stat| {
            if (stat.kind == .directory) return true;
        } else |_| {}
        const parent = std.fs.path.dirname(current) orelse return false;
        if (std.mem.eql(u8, parent, current)) return false;
        current = parent;
    }
}

fn packageIsInstalled(ctx: *const Context, start_dir: []const u8, package_name: []const u8) bool {
    var current = start_dir;
    while (true) {
        const path = std.fs.path.join(ctx.allocator, &.{ current, "node_modules", package_name, "package.json" }) catch return false;
        if (std.Io.Dir.cwd().statFile(ctx.io, path, .{})) |stat| {
            if (stat.kind == .file) return true;
        } else |_| {}
        const parent = std.fs.path.dirname(current) orelse return false;
        if (std.mem.eql(u8, parent, current)) return false;
        current = parent;
    }
}

const ModuleIdentifier = enum { other, import_keyword, export_keyword, require_identifier, from_keyword };

const ScannedModuleIdentifier = struct {
    end: usize,
    kind: ModuleIdentifier,
};

const UnicodeIdentifierEscape = struct {
    end: usize,
    codepoint: u21,
};

fn scanUnicodeIdentifierEscape(source: []const u8, start: usize) ?UnicodeIdentifierEscape {
    if (start + 2 > source.len or source[start] != '\\' or source[start + 1] != 'u') return null;
    var cursor = start + 2;
    var value: u32 = 0;
    if (cursor < source.len and source[cursor] == '{') {
        cursor += 1;
        const digits_start = cursor;
        while (cursor < source.len and source[cursor] != '}') : (cursor += 1) {
            const digit = std.fmt.charToDigit(source[cursor], 16) catch return null;
            value = std.math.mul(u32, value, 16) catch return null;
            value = std.math.add(u32, value, digit) catch return null;
            if (value > 0x10ffff) return null;
        }
        if (cursor == digits_start or cursor >= source.len) return null;
        cursor += 1;
    } else {
        if (cursor + 4 > source.len) return null;
        for (source[cursor .. cursor + 4]) |byte| {
            const digit = std.fmt.charToDigit(byte, 16) catch return null;
            value = value * 16 + digit;
        }
        cursor += 4;
    }
    return .{ .end = cursor, .codepoint = @intCast(value) };
}

fn scanModuleIdentifier(source: []const u8, start: usize) ScannedModuleIdentifier {
    var cursor = start;
    var decoded: [8]u8 = undefined;
    var decoded_len: usize = 0;
    var can_match = true;
    while (cursor < source.len) {
        if (isIdentifierPart(source[cursor])) {
            if (decoded_len < decoded.len) {
                decoded[decoded_len] = source[cursor];
                decoded_len += 1;
            } else {
                can_match = false;
            }
            cursor += 1;
            continue;
        }
        const escape = scanUnicodeIdentifierEscape(source, cursor) orelse break;
        if (escape.codepoint <= std.math.maxInt(u8) and isIdentifierPart(@intCast(escape.codepoint))) {
            if (decoded_len < decoded.len) {
                decoded[decoded_len] = @intCast(escape.codepoint);
                decoded_len += 1;
            } else {
                can_match = false;
            }
        } else {
            can_match = false;
        }
        cursor = escape.end;
    }
    const identifier = decoded[0..decoded_len];
    const kind: ModuleIdentifier = if (!can_match)
        .other
    else if (std.mem.eql(u8, identifier, "import"))
        .import_keyword
    else if (std.mem.eql(u8, identifier, "export"))
        .export_keyword
    else if (std.mem.eql(u8, identifier, "require"))
        .require_identifier
    else if (std.mem.eql(u8, identifier, "from"))
        .from_keyword
    else
        .other;
    return .{ .end = @max(cursor, start + 1), .kind = kind };
}

fn containsModuleIdentifier(source: []const u8) bool {
    var cursor: usize = 0;
    while (cursor < source.len) {
        if (isIdentifierStart(source[cursor]) or scanUnicodeIdentifierEscape(source, cursor) != null) {
            const identifier = scanModuleIdentifier(source, cursor);
            if (identifier.kind == .import_keyword or
                identifier.kind == .export_keyword or
                identifier.kind == .require_identifier) return true;
            cursor = identifier.end;
        } else {
            cursor += 1;
        }
    }
    return false;
}

fn sourceMayLoadModules(source: []const u8) bool {
    var cursor: usize = 0;
    var previous_was_dot = false;
    var export_clause = false;
    while (cursor < source.len) {
        cursor = skipJavaScriptTrivia(source, cursor);
        if (cursor >= source.len) break;

        const byte = source[cursor];
        if (byte == '\'' or byte == '"') {
            cursor = skipQuotedJavaScript(source, cursor);
            previous_was_dot = false;
            continue;
        }
        if (byte == '`') {
            const end = skipQuotedJavaScript(source, cursor);
            if (containsModuleIdentifier(source[cursor + 1 .. end])) return true;
            cursor = end;
            previous_was_dot = false;
            continue;
        }
        if (isIdentifierStart(byte) or scanUnicodeIdentifierEscape(source, cursor) != null) {
            const identifier = scanModuleIdentifier(source, cursor);
            cursor = identifier.end;
            if (!previous_was_dot and identifier.kind == .import_keyword) return true;
            if (identifier.kind == .require_identifier) {
                const next = skipJavaScriptTrivia(source, cursor);
                if (next < source.len and source[next] == '(') return true;
            }
            if (!previous_was_dot and identifier.kind == .export_keyword) {
                export_clause = true;
            } else if (export_clause and identifier.kind == .from_keyword) {
                return true;
            }
            previous_was_dot = false;
            continue;
        }

        previous_was_dot = byte == '.';
        if (byte == ';') export_clause = false;
        cursor += 1;
    }
    return false;
}

fn autoInstallPathIsDirectory(ctx: *const Context, path: []const u8) bool {
    const stat = std.Io.Dir.cwd().statFile(ctx.io, path, .{}) catch return false;
    return stat.kind == .directory;
}

fn prependAutoInstallNodePath(ctx: *const Context, node_modules: []const u8) !void {
    const existing = ctx.environ_map.get("NODE_PATH") orelse "";
    if (std.mem.indexOf(u8, existing, node_modules) != null) return;
    const value = if (existing.len == 0)
        node_modules
    else
        try std.fmt.allocPrint(ctx.allocator, "{s}{c}{s}", .{ node_modules, std.fs.path.delimiter, existing });
    try ctx.environ_map.put("NODE_PATH", value);
    const value_z = try ctx.allocator.dupeZ(u8, value);
    _ = setenv("NODE_PATH", value_z.ptr, 1);
}

fn installedAutoPackageVersion(ctx: *const Context, package_dir: []const u8) ?[]const u8 {
    const package_json = std.fs.path.join(ctx.allocator, &.{ package_dir, "package.json" }) catch return null;
    const contents = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        package_json,
        ctx.allocator,
        .limited(16 * 1024 * 1024),
    ) catch return null;
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, ctx.allocator, contents, .{}) catch return null;
    if (parsed != .object) return null;
    const version = parsed.object.get("version") orelse return null;
    return if (version == .string) version.string else null;
}

fn createAutoInstallSymlink(ctx: *const Context, target: []const u8, link_path: []const u8) !void {
    if (autoInstallPathIsDirectory(ctx, link_path)) return;
    if (std.fs.path.dirname(link_path)) |parent| try std.Io.Dir.cwd().createDirPath(ctx.io, parent);
    std.Io.Dir.symLinkAbsolute(ctx.io, target, link_path, .{ .is_directory = true }) catch |err| switch (err) {
        error.PathAlreadyExists => {},
        else => return err,
    };
}

fn exposeAutoInstalledPackage(
    ctx: *const Context,
    cache_root: []const u8,
    staging_node_modules: []const u8,
    request: AutoInstallRequest,
) !void {
    const installed_dir = try std.fs.path.join(ctx.allocator, &.{ staging_node_modules, request.package_name });
    if (!autoInstallPathIsDirectory(ctx, installed_dir)) return error.AutoInstallFailed;
    const version = installedAutoPackageVersion(ctx, installed_dir) orelse request.requested_version orelse "latest";
    const cache_package_dir = try std.fs.path.join(ctx.allocator, &.{ cache_root, request.package_name });
    try std.Io.Dir.cwd().createDirPath(ctx.io, cache_package_dir);
    const cache_entry_name = try std.fmt.allocPrint(ctx.allocator, "{s}@@@1", .{version});
    const cache_entry = try std.fs.path.join(ctx.allocator, &.{ cache_package_dir, cache_entry_name });
    try createAutoInstallSymlink(ctx, installed_dir, cache_entry);

    if (!std.mem.eql(u8, request.install_specifier, request.package_name)) {
        const alias = try std.fs.path.join(ctx.allocator, &.{ staging_node_modules, request.install_specifier });
        try createAutoInstallSymlink(ctx, installed_dir, alias);
    }
}

fn maybeAutoInstall(ctx: *const Context, entrypoint_path: []const u8, exec_args: []const [:0]const u8) !void {
    const mode = autoInstallMode(exec_args);
    if (mode == .disable) return;
    const entry_dir = std.fs.path.dirname(entrypoint_path) orelse ctx.project_root;
    const configured_cache = ctx.environ_map.get("BUN_INSTALL_CACHE_DIR");
    const cache_root = if (configured_cache) |path|
        if (std.fs.path.isAbsolute(path)) path else try absolutePathForCwd(ctx.io, ctx.allocator, path)
    else
        null;
    const staging_root = if (cache_root) |root|
        try std.fs.path.join(ctx.allocator, &.{ root, ".cottontail-auto-install" })
    else
        null;
    const staging_node_modules = if (staging_root) |root|
        try std.fs.path.join(ctx.allocator, &.{ root, "node_modules" })
    else
        null;
    if (staging_node_modules) |node_modules| {
        if (autoInstallPathIsDirectory(ctx, node_modules)) try prependAutoInstallNodePath(ctx, node_modules);
    }
    if (mode == .auto and directoryHasNodeModules(ctx, entry_dir)) return;

    const loader = transpilerLoaderForPath(entrypoint_path) orelse return;
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        entrypoint_path,
        ctx.allocator,
        .limited(16 * 1024 * 1024),
    ) catch return;
    // COTTONTAIL-COMPAT: Bun discovers missing packages during its normal
    // parser pass. Avoid a redundant compiler pass when no module-loading
    // token exists; large generated scripts otherwise miss Bun's test deadline.
    if (!sourceMayLoadModules(source)) return;
    const imports_json = native_transpiler.scanImportsJson(source, loader) catch return;
    defer std.heap.c_allocator.free(imports_json);
    const ScannedImport = struct { path: []const u8, kind: []const u8 };
    const parsed = std.json.parseFromSlice([]const ScannedImport, ctx.allocator, imports_json, .{}) catch return;
    defer parsed.deinit();

    var packages: std.ArrayList(AutoInstallRequest) = .empty;
    for (parsed.value) |item| {
        const request = autoInstallRequestFromSpecifier(item.path) orelse continue;
        if (request.requested_version == null and packageIsInstalled(ctx, entry_dir, request.package_name)) continue;
        if (staging_node_modules) |node_modules| {
            const installed_alias = try std.fs.path.join(ctx.allocator, &.{ node_modules, request.install_specifier });
            if (autoInstallPathIsDirectory(ctx, installed_alias)) {
                try exposeAutoInstalledPackage(ctx, cache_root.?, node_modules, request);
                continue;
            }
        }
        var duplicate = false;
        for (packages.items) |existing| {
            if (std.mem.eql(u8, existing.install_specifier, request.install_specifier)) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) try packages.append(ctx.allocator, request);
    }
    if (packages.items.len == 0) return;

    const executable = try std.process.executablePathAlloc(ctx.io, ctx.allocator);
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.appendSlice(ctx.allocator, &.{ executable, "add", "--no-save", "--silent" });
    if (mode == .force) try argv.append(ctx.allocator, "--force");
    for (packages.items) |request| try argv.append(ctx.allocator, request.install_specifier);
    const install_cwd = staging_root orelse entry_dir;
    if (staging_root) |root| try std.Io.Dir.cwd().createDirPath(ctx.io, root);
    var child_env = try ctx.environ_map.clone(ctx.allocator);
    defer child_env.deinit();
    if (cache_root) |root| {
        const download_cache = try std.fs.path.join(ctx.allocator, &.{ root, ".cottontail-download-cache" });
        try std.Io.Dir.cwd().createDirPath(ctx.io, download_cache);
        try child_env.put("BUN_INSTALL_CACHE_DIR", download_cache);
    }
    const result = try std.process.run(ctx.allocator, ctx.io, .{
        .argv = argv.items,
        .cwd = .{ .path = install_cwd },
        .environ_map = &child_env,
        .stdout_limit = .limited(64 * 1024 * 1024),
        .stderr_limit = .limited(64 * 1024 * 1024),
    });
    switch (result.term) {
        .exited => |code| if (code != 0) return error.AutoInstallFailed,
        else => return error.AutoInstallFailed,
    }
    if (staging_node_modules) |node_modules| {
        try prependAutoInstallNodePath(ctx, node_modules);
        for (packages.items) |request| try exposeAutoInstalledPackage(ctx, cache_root.?, node_modules, request);
    }
}

test "auto-install preflight cannot skip module-loading syntax" {
    try std.testing.expect(sourceMayLoadModules("import value from 'pkg';"));
    try std.testing.expect(sourceMayLoadModules("export * from 'pkg';"));
    try std.testing.expect(sourceMayLoadModules("const value = `${await import('pkg')}`;"));
    try std.testing.expect(sourceMayLoadModules("module.require('pkg');"));
    try std.testing.expect(sourceMayLoadModules("requ\\u0069re('pkg');"));
    try std.testing.expect(!sourceMayLoadModules("const __require = require.apply.bind(require);"));
    try std.testing.expect(!sourceMayLoadModules("const answer = 42;"));
}

const BundleDiagnostic = struct {
    file: []const u8,
    line: usize,
    column: usize,
    message: []const u8,
};

fn extractCompilerDiagnosticMessage(text: []const u8) []const u8 {
    const prefix = "error: ";
    const line_prefix = "\n" ++ prefix;
    const start = if (std.mem.lastIndexOf(u8, text, line_prefix)) |marker|
        marker + line_prefix.len
    else if (std.mem.startsWith(u8, text, prefix))
        prefix.len
    else
        return text;
    const message = text[start..];
    const end = std.mem.indexOfScalar(u8, message, '\n') orelse message.len;
    return std.mem.trimEnd(u8, message[0..end], "\r");
}

fn parseBundleDiagnosticLocation(location: []const u8, message: []const u8, fallback_file: []const u8) BundleDiagnostic {
    const extracted_message = extractCompilerDiagnosticMessage(message);
    const location_line_end = std.mem.indexOfAny(u8, location, "\r\n") orelse location.len;
    const location_line = std.mem.trim(u8, location[0..location_line_end], " \t");
    const column_separator = std.mem.lastIndexOfScalar(u8, location_line, ':') orelse return .{
        .file = fallback_file,
        .line = 1,
        .column = 1,
        .message = extracted_message,
    };
    const line_separator = std.mem.lastIndexOfScalar(u8, location_line[0..column_separator], ':') orelse return .{
        .file = fallback_file,
        .line = 1,
        .column = 1,
        .message = extracted_message,
    };
    const line = std.fmt.parseUnsigned(usize, location_line[line_separator + 1 .. column_separator], 10) catch 1;
    const column = std.fmt.parseUnsigned(usize, location_line[column_separator + 1 ..], 10) catch 1;
    return .{
        .file = if (line_separator > 0) location_line[0..line_separator] else fallback_file,
        .line = @max(line, 1),
        .column = @max(column, 1),
        .message = extracted_message,
    };
}

fn parseBundleDiagnostic(text: []const u8, fallback_file: []const u8) BundleDiagnostic {
    const bun_location_marker = "\n    at ";
    if (std.mem.lastIndexOf(u8, text, bun_location_marker)) |marker| {
        return parseBundleDiagnosticLocation(
            text[marker + bun_location_marker.len ..],
            text[0..marker],
            fallback_file,
        );
    }

    // Accept the original Cottontail bridge representation for cached output
    // and for diagnostics produced by older embedded compiler builds.
    const message_separator = std.mem.lastIndexOf(u8, text, ": ") orelse return .{
        .file = fallback_file,
        .line = 1,
        .column = 1,
        .message = text,
    };
    return parseBundleDiagnosticLocation(
        text[0..message_separator],
        text[message_separator + 2 ..],
        fallback_file,
    );
}

const JavaScriptModuleTokenKind = enum { identifier, string, punct };

const JavaScriptModuleToken = struct {
    kind: JavaScriptModuleTokenKind,
    text: []const u8,
};

fn tokenizeJavaScriptModuleSyntax(
    allocator: std.mem.Allocator,
    source: []const u8,
) ![]JavaScriptModuleToken {
    var tokens: std.ArrayList(JavaScriptModuleToken) = .empty;
    var cursor: usize = 0;
    while (cursor < source.len) {
        cursor = skipJavaScriptTrivia(source, cursor);
        if (cursor >= source.len) break;

        const start = cursor;
        const byte = source[cursor];
        if (isIdentifierStart(byte)) {
            cursor += 1;
            while (cursor < source.len and isIdentifierPart(source[cursor])) cursor += 1;
            try tokens.append(allocator, .{ .kind = .identifier, .text = source[start..cursor] });
            continue;
        }
        if (byte == '\'' or byte == '"' or byte == '`') {
            cursor = skipQuotedJavaScript(source, cursor);
            const content_end = if (cursor > start and cursor <= source.len and source[cursor - 1] == byte)
                cursor - 1
            else
                cursor;
            try tokens.append(allocator, .{ .kind = .string, .text = source[start + 1 .. content_end] });
            continue;
        }

        cursor += 1;
        try tokens.append(allocator, .{ .kind = .punct, .text = source[start..cursor] });
    }
    return try tokens.toOwnedSlice(allocator);
}

fn tokenIs(token: JavaScriptModuleToken, kind: JavaScriptModuleTokenKind, text: []const u8) bool {
    return token.kind == kind and std.mem.eql(u8, token.text, text);
}

fn closingModuleClause(tokens: []const JavaScriptModuleToken, open: usize) ?usize {
    var depth: usize = 0;
    for (tokens[open..], open..) |token, index| {
        if (tokenIs(token, .punct, "{")) {
            depth += 1;
        } else if (tokenIs(token, .punct, "}")) {
            if (depth == 0) return null;
            depth -= 1;
            if (depth == 0) return index;
        }
    }
    return null;
}

fn moduleClauseReferences(
    tokens: []const JavaScriptModuleToken,
    open: usize,
    close: usize,
    name: []const u8,
) bool {
    for (tokens[open + 1 .. close]) |token| {
        if ((token.kind == .identifier or token.kind == .string) and std.mem.eql(u8, token.text, name)) return true;
    }
    return false;
}

const NamedImportBinding = struct {
    local_name: []const u8,
    specifier: []const u8,
};

fn namedImportBinding(
    tokens: []const JavaScriptModuleToken,
    imported_name: []const u8,
) ?NamedImportBinding {
    var index: usize = 0;
    while (index < tokens.len) : (index += 1) {
        if (!tokenIs(tokens[index], .identifier, "import")) continue;
        var open = index + 1;
        if (open < tokens.len and tokenIs(tokens[open], .identifier, "type")) open += 1;
        if (open >= tokens.len or !tokenIs(tokens[open], .punct, "{")) continue;
        const close = closingModuleClause(tokens, open) orelse continue;
        if (close + 2 >= tokens.len or
            !tokenIs(tokens[close + 1], .identifier, "from") or
            tokens[close + 2].kind != .string)
        {
            continue;
        }

        var item = open + 1;
        while (item < close) {
            if (tokenIs(tokens[item], .punct, ",")) {
                item += 1;
                continue;
            }
            if (tokenIs(tokens[item], .identifier, "type")) item += 1;
            if (item >= close or (tokens[item].kind != .identifier and tokens[item].kind != .string)) break;
            const imported = tokens[item].text;
            var local = imported;
            item += 1;
            if (item + 1 < close and tokenIs(tokens[item], .identifier, "as")) {
                local = tokens[item + 1].text;
                item += 2;
            }
            if (std.mem.eql(u8, imported, imported_name)) {
                return .{ .local_name = local, .specifier = tokens[close + 2].text };
            }
            while (item < close and !tokenIs(tokens[item], .punct, ",")) item += 1;
        }
    }
    return null;
}

fn reexportSpecifierForMissingImport(
    allocator: std.mem.Allocator,
    source: []const u8,
    imported_name: []const u8,
) !?[]const u8 {
    const tokens = try tokenizeJavaScriptModuleSyntax(allocator, source);
    defer allocator.free(tokens);
    const binding = namedImportBinding(tokens, imported_name);

    var index: usize = 0;
    while (index < tokens.len) : (index += 1) {
        if (!tokenIs(tokens[index], .identifier, "export")) continue;
        var open = index + 1;
        if (open < tokens.len and tokenIs(tokens[open], .identifier, "type")) open += 1;
        if (open >= tokens.len or !tokenIs(tokens[open], .punct, "{")) continue;
        const close = closingModuleClause(tokens, open) orelse continue;

        if (close + 2 < tokens.len and
            tokenIs(tokens[close + 1], .identifier, "from") and
            tokens[close + 2].kind == .string and
            moduleClauseReferences(tokens, open, close, imported_name))
        {
            return tokens[close + 2].text;
        }
        if (binding) |named_import| {
            if (moduleClauseReferences(tokens, open, close, named_import.local_name)) return named_import.specifier;
        }
    }
    return null;
}

fn sourceHasNamedDefaultExport(
    allocator: std.mem.Allocator,
    source: []const u8,
    name: []const u8,
) !bool {
    const tokens = try tokenizeJavaScriptModuleSyntax(allocator, source);
    defer allocator.free(tokens);
    var index: usize = 0;
    while (index + 3 < tokens.len) : (index += 1) {
        if (!tokenIs(tokens[index], .identifier, "export") or
            !tokenIs(tokens[index + 1], .identifier, "default"))
        {
            continue;
        }
        var declaration = index + 2;
        if (tokenIs(tokens[declaration], .identifier, "async")) declaration += 1;
        if (declaration + 1 >= tokens.len) continue;
        if ((!tokenIs(tokens[declaration], .identifier, "function") and
            !tokenIs(tokens[declaration], .identifier, "class")) or
            tokens[declaration + 1].kind != .identifier)
        {
            continue;
        }
        if (std.mem.eql(u8, tokens[declaration + 1].text, name)) return true;
    }
    return false;
}

const MissingExportDiagnostic = struct {
    target: []const u8,
    name: []const u8,
};

fn parseMissingExportDiagnostic(message: []const u8) ?MissingExportDiagnostic {
    const prefix = "No matching export in \"";
    if (!std.mem.startsWith(u8, message, prefix)) return null;
    const target_end = std.mem.indexOfScalarPos(u8, message, prefix.len, '"') orelse return null;
    const import_prefix = " for import \"";
    if (!std.mem.startsWith(u8, message[target_end + 1 ..], import_prefix)) return null;
    const name_start = target_end + 1 + import_prefix.len;
    const name_end = std.mem.indexOfScalarPos(u8, message, name_start, '"') orelse return null;
    return .{ .target = message[prefix.len..target_end], .name = message[name_start..name_end] };
}

fn quotedDiagnosticName(message: []const u8, prefix: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, message, prefix)) return null;
    const end = std.mem.indexOfScalarPos(u8, message, prefix.len, '"') orelse return null;
    return message[prefix.len..end];
}

fn isRuntimePackageDiagnostic(name: []const u8) bool {
    return name.len > 0 and
        name[0] != '.' and
        name[0] != '/' and
        name[0] != '\\' and
        std.mem.indexOfScalar(u8, name, ':') == null and
        std.mem.indexOfScalar(u8, name, '/') == null;
}

fn diagnosticPathMatchesEntrypoint(
    ctx: *const Context,
    diagnostic_path: []const u8,
    entrypoint_path: []const u8,
) bool {
    const diagnostic_trimmed = std.mem.trim(u8, diagnostic_path, " \t\r\n");
    const entrypoint_trimmed = std.mem.trim(u8, entrypoint_path, " \t\r\n");
    if (std.mem.eql(u8, diagnostic_trimmed, entrypoint_trimmed)) return true;

    const diagnostic_real = resolvePathForCwd(ctx.io, ctx.allocator, diagnostic_trimmed) catch return false;
    const entrypoint_real = resolvePathForCwd(ctx.io, ctx.allocator, entrypoint_trimmed) catch return false;
    return std.mem.eql(u8, diagnostic_real, entrypoint_real);
}

// COTTONTAIL-COMPAT: Direct execution currently links through Cottontail's
// native bundler instead of JSC's module loader. Preserve Bun's runtime-facing
// linkage diagnostics here; Bun.build continues to expose compiler diagnostics.
fn runtimeLinkDiagnostic(
    ctx: *const Context,
    script_abs: []const u8,
    script_entry_abs: []const u8,
    text: []const u8,
) !?[]const u8 {
    const diagnostic = parseBundleDiagnostic(text, script_abs);
    if (quotedDiagnosticName(diagnostic.message, "Could not resolve: \"")) |name| {
        if (isRuntimePackageDiagnostic(name)) {
            return try std.fmt.allocPrint(
                ctx.allocator,
                "error: Cannot find package '{s}'\n    at {s}:{}:{}",
                .{ name, diagnostic.file, diagnostic.line, diagnostic.column },
            );
        }
        return try std.fmt.allocPrint(
            ctx.allocator,
            "error: Cannot find module \"{s}\"\n    at {s}:{}:{}",
            .{ name, diagnostic.file, diagnostic.line, diagnostic.column },
        );
    }
    if (parseMissingExportDiagnostic(diagnostic.message)) |missing| {
        const source = std.Io.Dir.cwd().readFileAlloc(
            ctx.io,
            diagnostic.file,
            ctx.allocator,
            .limited(16 * 1024 * 1024),
        ) catch "";
        if (try reexportSpecifierForMissingImport(ctx.allocator, source, missing.name)) |specifier| {
            return try std.fmt.allocPrint(
                ctx.allocator,
                "SyntaxError: export '{s}' not found in '{s}'\n    at {s}:{}:{}",
                .{ missing.name, specifier, diagnostic.file, diagnostic.line, diagnostic.column },
            );
        }

        const target_path = if (std.fs.path.isAbsolute(missing.target))
            missing.target
        else
            try std.fs.path.join(ctx.allocator, &.{ std.fs.path.dirname(diagnostic.file) orelse ctx.project_root, missing.target });
        const target_source = std.Io.Dir.cwd().readFileAlloc(
            ctx.io,
            target_path,
            ctx.allocator,
            .limited(16 * 1024 * 1024),
        ) catch "";
        const suggestion = if (try sourceHasNamedDefaultExport(ctx.allocator, target_source, missing.name))
            " Did you mean to import default?"
        else
            "";
        return try std.fmt.allocPrint(
            ctx.allocator,
            "SyntaxError: Export named '{s}' not found in module '{s}'.{s}\n    at {s}:{}:{}",
            .{ missing.name, missing.target, suggestion, diagnostic.file, diagnostic.line, diagnostic.column },
        );
    }

    const duplicate_prefix = "Multiple exports with the same name \"";
    const is_entrypoint = diagnosticPathMatchesEntrypoint(ctx, diagnostic.file, script_abs) or
        diagnosticPathMatchesEntrypoint(ctx, diagnostic.file, script_entry_abs);
    if (!is_entrypoint) {
        if (quotedDiagnosticName(diagnostic.message, duplicate_prefix)) |name| {
            return try std.fmt.allocPrint(
                ctx.allocator,
                "SyntaxError: Cannot export a duplicate name '{s}'.\n    at {s}:{}:{}",
                .{ name, diagnostic.file, diagnostic.line, diagnostic.column },
            );
        }
    }

    const ambiguous_prefix = "Ambiguous import \"";
    if (quotedDiagnosticName(diagnostic.message, ambiguous_prefix)) |name| {
        return try std.fmt.allocPrint(
            ctx.allocator,
            "SyntaxError: Export named '{s}' cannot be resolved due to ambiguous multiple bindings in module '{s}'.\n    at {s}:{}:{}",
            .{ name, diagnostic.file, diagnostic.file, diagnostic.line, diagnostic.column },
        );
    }
    return null;
}

test "parse Bun and legacy compiler diagnostics" {
    const bun_style = parseBundleDiagnostic(
        "No matching export\n    at /tmp/source.ts:4:9",
        "fallback.ts",
    );
    try std.testing.expectEqualStrings("No matching export", bun_style.message);
    try std.testing.expectEqualStrings("/tmp/source.ts", bun_style.file);
    try std.testing.expectEqual(@as(usize, 4), bun_style.line);
    try std.testing.expectEqual(@as(usize, 9), bun_style.column);

    const legacy = parseBundleDiagnostic(
        "C:\\project\\source.ts:2:7: Could not resolve",
        "fallback.ts",
    );
    try std.testing.expectEqualStrings("Could not resolve", legacy.message);
    try std.testing.expectEqualStrings("C:\\project\\source.ts", legacy.file);
    try std.testing.expectEqual(@as(usize, 2), legacy.line);
    try std.testing.expectEqual(@as(usize, 7), legacy.column);

    const formatted_missing_export = parseBundleDiagnostic(
        "1 | import { type_only } from './types.ts';\n             ^\nerror: No matching export in \"types.ts\" for import \"type_only\"\n    at /tmp/source.ts:1:10",
        "fallback.ts",
    );
    try std.testing.expectEqualStrings(
        "No matching export in \"types.ts\" for import \"type_only\"",
        formatted_missing_export.message,
    );
    try std.testing.expectEqualStrings("/tmp/source.ts", formatted_missing_export.file);
    try std.testing.expectEqual(@as(usize, 1), formatted_missing_export.line);
    try std.testing.expectEqual(@as(usize, 10), formatted_missing_export.column);

    const formatted_resolution = parseBundleDiagnostic(
        "2 | import { add } from '@utils/math';\n                        ^\nerror: Could not resolve: \"@utils/math\"\n    at /tmp/math.test.ts:2:21",
        "fallback.ts",
    );
    try std.testing.expectEqualStrings("Could not resolve: \"@utils/math\"", formatted_resolution.message);

    const diagnostic_with_context = parseBundleDiagnostic(
        "error: Multiple exports with the same name \"value\"\n    at /tmp/a.js:1:36\n\n1 | export {value};",
        "fallback.ts",
    );
    try std.testing.expectEqualStrings("Multiple exports with the same name \"value\"", diagnostic_with_context.message);
    try std.testing.expectEqualStrings("/tmp/a.js", diagnostic_with_context.file);
    try std.testing.expectEqual(@as(usize, 1), diagnostic_with_context.line);
    try std.testing.expectEqual(@as(usize, 36), diagnostic_with_context.column);
}

test "runtime missing-package diagnostics follow Bun's resolver classification" {
    try std.testing.expect(isRuntimePackageDiagnostic("is-even"));
    try std.testing.expect(!isRuntimePackageDiagnostic("@helpers/math"));
    try std.testing.expect(!isRuntimePackageDiagnostic("package/subpath"));
    try std.testing.expect(!isRuntimePackageDiagnostic("./local.js"));
}

test "classify runtime missing-export diagnostics" {
    const missing = parseMissingExportDiagnostic(
        "No matching export in \"a.ts\" for import \"type_only\"",
    ).?;
    try std.testing.expectEqualStrings("a.ts", missing.target);
    try std.testing.expectEqualStrings("type_only", missing.name);

    const direct = try reexportSpecifierForMissingImport(
        std.testing.allocator,
        "export { type_only } from './types.ts';",
        "type_only",
    );
    try std.testing.expectEqualStrings("./types.ts", direct.?);

    const indirect = try reexportSpecifierForMissingImport(
        std.testing.allocator,
        "import { type_only as local } from './types.ts'; export { local };",
        "type_only",
    );
    try std.testing.expectEqualStrings("./types.ts", indirect.?);
    try std.testing.expect(try sourceHasNamedDefaultExport(
        std.testing.allocator,
        "export default async function type_only() {}",
        "type_only",
    ));
}

test "JavaScript re-exports do not erase missing TypeScript values" {
    const allocator = std.testing.allocator;
    const io = std.Io.Threaded.global_single_threaded.io();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.writeFile(io, .{
        .sub_path = "types.ts",
        .data = "export type type_only = 'type_only';\n",
    });
    try tmp.dir.writeFile(io, .{
        .sub_path = "entry.js",
        .data = "export { type_only } from './types.ts';\n",
    });
    const relative_root = try std.fs.path.join(allocator, &.{ ".zig-cache", "tmp", &tmp.sub_path });
    defer allocator.free(relative_root);
    const absolute_root = try std.Io.Dir.cwd().realPathFileAlloc(io, relative_root, allocator);
    defer allocator.free(absolute_root);
    const entry_path = try std.fs.path.join(allocator, &.{ absolute_root, "entry.js" });
    defer allocator.free(entry_path);

    var error_message: ?[*:0]u8 = null;
    defer if (error_message) |message| native_bundler.ct_bundle_string_free(message);
    if (native_bundler.bundleEntryPointWithOptions(entry_path, absolute_root, .{}, &error_message)) |output| {
        std.heap.c_allocator.free(output);
        return error.ExpectedMissingExport;
    } else |_| {}
    try std.testing.expect(error_message != null);
    try std.testing.expect(std.mem.indexOf(u8, std.mem.span(error_message.?), "No matching export") != null);
}

fn appendTestAggregate(ctx: *const Context, path: []const u8, summary: []const u8) void {
    const file = std.Io.Dir.cwd().openFile(ctx.io, path, .{ .mode = .write_only }) catch return;
    defer file.close(ctx.io);
    const stat = file.stat(ctx.io) catch return;
    var buffer: [128]u8 = undefined;
    var writer = file.writer(ctx.io, &buffer);
    writer.seekTo(stat.size) catch return;
    writer.interface.writeAll(summary) catch return;
    writer.interface.flush() catch return;
}

fn reportTestBundleError(ctx: *const Context, script_abs: []const u8, text: []const u8) void {
    const diagnostic = parseBundleDiagnostic(text, script_abs);
    const diagnostic_file = blk: {
        if (std.fs.path.isAbsolute(diagnostic.file)) {
            std.Io.Dir.accessAbsolute(ctx.io, diagnostic.file, .{}) catch break :blk script_abs;
        } else {
            std.Io.Dir.cwd().access(ctx.io, diagnostic.file, .{}) catch break :blk script_abs;
        }
        break :blk diagnostic.file;
    };
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        diagnostic_file,
        ctx.allocator,
        .limited(16 * 1024 * 1024),
    ) catch "";
    var source_lines = std.mem.splitScalar(u8, source, '\n');
    var source_line: []const u8 = "";
    var line_number: usize = 1;
    while (source_lines.next()) |line| : (line_number += 1) {
        if (line_number == diagnostic.line) {
            source_line = std.mem.trimEnd(u8, line, "\r");
            break;
        }
    }
    const display_path = if (std.mem.startsWith(u8, diagnostic_file, ctx.project_root) and
        diagnostic_file.len > ctx.project_root.len and
        (diagnostic_file[ctx.project_root.len] == '/' or diagnostic_file[ctx.project_root.len] == '\\'))
        diagnostic_file[ctx.project_root.len + 1 ..]
    else
        std.fs.path.basename(diagnostic_file);
    const line_width = std.fmt.count("{}", .{diagnostic.line});
    const caret_padding = line_width + 3 + diagnostic.column - 1;
    const caret_spaces = ctx.allocator.alloc(u8, caret_padding) catch return;
    @memset(caret_spaces, ' ');
    ctx.writeStderr(
        "\n{s}:\n\n# Unhandled error between tests\n-------------------------------\n{} | {s}\n{s}^\nerror: {s}\n    at {s}:{}:{}\n-------------------------------\n",
        .{
            display_path,
            diagnostic.line,
            source_line,
            caret_spaces,
            diagnostic.message,
            diagnostic_file,
            diagnostic.line,
            diagnostic.column,
        },
    );

    if (ctx.environ_map.get("COTTONTAIL_TEST_AGGREGATE_FILE")) |aggregate_path| {
        appendTestAggregate(ctx, aggregate_path, "0\t0\t0\t1\t1\t0\n");
    } else {
        ctx.writeStderr("\n\n 0 pass\n 1 fail\n 1 error\nRan 1 test across 1 file. [0.00ms]\n", .{});
    }
}

fn validateCommonJsTestSyntax(ctx: *const Context, script_abs: []const u8) !void {
    const loader = transpilerLoaderForPath(script_abs) orelse return;
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        script_abs,
        ctx.allocator,
        .limited(16 * 1024 * 1024),
    ) catch return;
    var error_message: ?[*:0]u8 = null;
    const imports = native_transpiler.scanImportsJsonWithError(source, loader, &error_message) catch {
        if (error_message) |message| {
            defer native_transpiler.ct_transpiler_string_free(message);
            writeTranspilerDiagnostic(ctx, std.mem.span(message), script_abs);
        }
        return error.TestBundleFailed;
    };
    std.heap.c_allocator.free(imports);
}

fn writeTranspilerDiagnostic(ctx: *const Context, text: []const u8, display_path: []const u8) void {
    var rewritten = text;
    for ([_][]const u8{ "input.js", "input.jsx", "input.ts", "input.tsx" }) |stdin_name| {
        const needle = std.fmt.allocPrint(ctx.allocator, "    at {s}:", .{stdin_name}) catch continue;
        const replacement = std.fmt.allocPrint(ctx.allocator, "    at {s}:", .{display_path}) catch continue;
        rewritten = std.mem.replaceOwned(u8, ctx.allocator, rewritten, needle, replacement) catch rewritten;
    }
    ctx.writeStderr("{s}\n", .{rewritten});
}

pub fn runEval(
    init: std.process.Init,
    source: [:0]const u8,
    script_args: []const [:0]const u8,
    exec_args: []const [:0]const u8,
    print_result: bool,
) !u8 {
    const ctx = try makeContext(init);
    const executable_source = (try rewriteLegacyHtmlClosingComments(ctx.allocator, source)) orelse source;
    if (!validateEvalSyntax(&ctx, executable_source)) return 1;
    const module_input = hasModuleInputType(exec_args) or sourceLooksEsm(executable_source);
    const eval_entry = try writeEvalEntrypoint(&ctx, ctx.project_root, executable_source, print_result, module_input, "[eval]", true, .omit_entrypoint);
    defer std.Io.Dir.cwd().deleteFile(ctx.io, eval_entry.entry_path) catch {};
    defer if (eval_entry.source_path) |path| std.Io.Dir.cwd().deleteFile(ctx.io, path) catch {};
    var runnable = try bundleScriptNative(&ctx, eval_entry.entry_path, exec_args, script_args, ctx.project_root, null, null, false, null, false);
    defer runnable.deinit(&ctx);
    canonicalizeEvalSourceMap(&ctx, runnable.path, eval_entry.source_path orelse eval_entry.entry_path) catch |err| switch (err) {
        error.EvalSourceMissingFromSourceMap => {},
        else => return err,
    };
    const runnable_path_z = try init.arena.allocator().dupeZ(u8, runnable.path);
    const process_args = try init.arena.allocator().alloc([:0]const u8, script_args.len + 1);
    process_args[0] = try init.arena.allocator().dupeZ(u8, eval_entry.entry_path);
    for (script_args, 0..) |arg, index| process_args[index + 1] = arg;
    return try runPrepared(init, &ctx, runnable_path_z, process_args, 1, exec_args, null, null, null, null, null);
}

const HtmlDevServerRun = struct {
    init: std.process.Init,
    source: [:0]const u8,
    early_source: [:0]const u8,
    script_args: []const [:0]const u8,
    exec_args: []const [:0]const u8,
    exit_code: u8 = 1,
};

pub fn runHtmlDevServer(
    init: std.process.Init,
    source: [:0]const u8,
    early_source: [:0]const u8,
    script_args: []const [:0]const u8,
    exec_args: []const [:0]const u8,
) !u8 {
    var server_run = HtmlDevServerRun{
        .init = init,
        .source = source,
        .early_source = early_source,
        .script_args = script_args,
        .exec_args = exec_args,
    };
    if (comptime builtin.os.tag == .windows) {
        const thread = try WindowsScriptThread.startRaw(windowsHtmlDevServerThreadEntry, &server_run);
        defer thread.deinit();
        thread.join();
    } else {
        const thread = try std.Thread.spawn(
            .{ .stack_size = script_thread_stack_size },
            runHtmlDevServerThread,
            .{&server_run},
        );
        thread.join();
    }
    return server_run.exit_code;
}

fn windowsHtmlDevServerThreadEntry(raw_server_run: ?*anyopaque) callconv(.winapi) u32 {
    const server_run: *HtmlDevServerRun = @ptrCast(@alignCast(raw_server_run.?));
    runHtmlDevServerThread(server_run);
    return 0;
}

fn runHtmlDevServerThread(server_run: *HtmlDevServerRun) void {
    server_run.exit_code = runHtmlDevServerOnThread(server_run) catch |err| {
        writeStderr(server_run.init.io, "cottontail: failed to start HTML development server: {s}\n", .{@errorName(err)});
        return;
    };
}

fn runHtmlDevServerOnThread(server_run: *HtmlDevServerRun) !u8 {
    const init = server_run.init;
    const ctx = try makeContext(init);
    const executable_source = (try rewriteLegacyHtmlClosingComments(ctx.allocator, server_run.source)) orelse server_run.source;
    if (!validateEvalSyntax(&ctx, executable_source)) return 1;

    const module_input = hasModuleInputType(server_run.exec_args) or sourceLooksEsm(executable_source);
    const eval_entry = try writeEvalEntrypoint(
        &ctx,
        ctx.project_root,
        executable_source,
        false,
        module_input,
        "[eval]",
        true,
        .omit_entrypoint,
    );
    defer std.Io.Dir.cwd().deleteFile(ctx.io, eval_entry.entry_path) catch {};
    defer if (eval_entry.source_path) |path| std.Io.Dir.cwd().deleteFile(ctx.io, path) catch {};

    const process_args = try ctx.allocator.alloc([:0]const u8, server_run.script_args.len + 1);
    process_args[0] = try ctx.allocator.dupeZ(u8, eval_entry.entry_path);
    for (server_run.script_args, 0..) |arg, index| process_args[index + 1] = arg;
    if (!applyRuntimeEnvFlags(init.io, ctx.allocator, server_run.exec_args)) return 1;
    const inspector = inspectorLaunchFromArgs(&ctx, server_run.exec_args) catch |err| {
        ctx.writeStderr("cottontail: invalid inspector endpoint: {s}\n", .{@errorName(err)});
        return 1;
    };
    icu_bootstrap.ensure(init) catch |err| {
        ctx.writeStderr("cottontail: failed to initialize ICU: {s}\n", .{@errorName(err)});
        return 1;
    };

    var js_runtime = try runtime.Runtime.initWithStackSize(init.io, ctx.allocator, script_js_stack_size);
    defer js_runtime.deinit();
    try js_runtime.setProcessArgs(process_args, 1, server_run.exec_args);
    var execution = ScriptExecution{
        .io = init.io,
        .allocator = ctx.allocator,
        .runnable_path = process_args[0],
        .process_args = process_args,
        .process_user_arg_offset = 1,
        .exec_args = server_run.exec_args,
        .inspector = inspector,
    };
    if (!configureRuntimeInspector(&execution, &js_runtime)) return 1;

    try js_runtime.evalImmediate(server_run.early_source, "cottontail:html-server-prebind");

    var runnable = try bundleScriptNative(
        &ctx,
        eval_entry.entry_path,
        server_run.exec_args,
        server_run.script_args,
        ctx.project_root,
        null,
        null,
        false,
        null,
        false,
    );
    defer runnable.deinit(&ctx);
    canonicalizeEvalSourceMap(&ctx, runnable.path, eval_entry.source_path orelse eval_entry.entry_path) catch |err| switch (err) {
        error.EvalSourceMissingFromSourceMap => {},
        else => return err,
    };

    const source_map_path = try std.mem.concat(ctx.allocator, u8, &.{ runnable.path, ".map" });
    if (std.Io.Dir.cwd().access(ctx.io, source_map_path, .{})) {
        try js_runtime.setExternalSourceMap(source_map_path, runnable.path);
    } else |_| {}
    if (runnableDirectoryForCleanup(&ctx, runnable.path)) |directory| {
        try js_runtime.setExitCleanupPath(try ctx.allocator.dupeZ(u8, directory));
    }

    return js_runtime.runFile(try ctx.allocator.dupeZ(u8, runnable.path));
}

fn validateEvalSyntax(ctx: *const Context, source: []const u8) bool {
    var error_message: ?[*:0]u8 = null;
    const imports = native_transpiler.scanImportsJsonWithError(source, "tsx", &error_message) catch {
        if (error_message) |message| {
            defer native_transpiler.ct_transpiler_string_free(message);
            const display_path = std.fs.path.join(ctx.allocator, &.{ ctx.project_root, "[eval]" }) catch "[eval]";
            writeTranspilerDiagnostic(ctx, std.mem.span(message), display_path);
        } else {
            ctx.writeStderr("error: Syntax Error\n", .{});
        }
        return false;
    };
    std.heap.c_allocator.free(imports);
    return true;
}

fn canonicalizeEvalSourceMap(ctx: *const Context, runnable_path: []const u8, eval_path: []const u8) !void {
    return canonicalizeVirtualSourceMap(ctx, runnable_path, eval_path, "[eval]");
}

fn canonicalizeVirtualSourceMap(
    ctx: *const Context,
    runnable_path: []const u8,
    physical_path: []const u8,
    virtual_name: []const u8,
) !void {
    const source_map_path = try std.mem.concat(ctx.allocator, u8, &.{ runnable_path, ".map" });
    const allocator = std.heap.c_allocator;
    const source_map = try std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        source_map_path,
        allocator,
        .limited(64 * 1024 * 1024),
    );
    defer allocator.free(source_map);

    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, source_map, .{});
    defer parsed.deinit();
    if (!try replaceVirtualSourcePath(allocator, &parsed.value, physical_path, virtual_name)) return error.EvalSourceMissingFromSourceMap;

    const rewritten = try std.json.Stringify.valueAlloc(allocator, parsed.value, .{});
    defer allocator.free(rewritten);
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = source_map_path, .data = rewritten });
}

fn replaceEvalSourcePath(allocator: std.mem.Allocator, source_map: *std.json.Value, eval_path: []const u8) !bool {
    return replaceVirtualSourcePath(allocator, source_map, eval_path, "[eval]");
}

fn replaceVirtualSourcePath(
    allocator: std.mem.Allocator,
    source_map: *std.json.Value,
    physical_path: []const u8,
    virtual_name: []const u8,
) !bool {
    if (source_map.* != .object) return false;
    const sources = source_map.object.getPtr("sources") orelse return false;
    if (sources.* != .array) return false;
    const sources_content = source_map.object.getPtr("sourcesContent");

    const physical_name = std.fs.path.basename(physical_path);
    const encoder = std.base64.standard.Encoder;
    const encoded_path = try allocator.alloc(u8, encoder.calcSize(physical_path.len));
    defer allocator.free(encoded_path);
    const encoded_physical_path = encoder.encode(encoded_path, physical_path);
    const physical_dir = std.fs.path.dirname(physical_path) orelse ".";
    const virtual_eval_path = try std.fs.path.join(allocator, &.{ physical_dir, virtual_name });
    defer allocator.free(virtual_eval_path);
    const encoded_virtual_path_buffer = try allocator.alloc(u8, encoder.calcSize(virtual_eval_path.len));
    defer allocator.free(encoded_virtual_path_buffer);
    const encoded_virtual_path = encoder.encode(encoded_virtual_path_buffer, virtual_eval_path);
    var replaced = false;
    for (sources.array.items, 0..) |*source, index| {
        if (source.* != .string) continue;
        const direct_match = sourcePathEndsWithComponent(source.string, physical_name);
        const generated_match = if (sources_content) |content_value|
            content_value.* == .array and
                index < content_value.array.items.len and
                (sourceHasOriginalPath(content_value.array.items[index], encoded_physical_path) or
                    sourceHasOriginalPath(content_value.array.items[index], encoded_virtual_path))
        else
            false;
        if (!direct_match and !generated_match) continue;
        // COTTONTAIL-COMPAT: Bun evaluates a virtual cwd/[eval] module. Keep
        // Cottontail's concurrency-safe disk path for resolution, but expose
        // the same virtual source identity through the generated source map.
        source.* = .{ .string = virtual_name };
        replaced = true;
    }
    return replaced;
}

fn sourceHasOriginalPath(source_content: std.json.Value, encoded_path: []const u8) bool {
    if (source_content != .string) return false;
    const marker = "/*@cottontail-original-path-base64:";
    if (!std.mem.startsWith(u8, source_content.string, marker)) return false;
    const encoded_end = std.mem.indexOfPos(u8, source_content.string, marker.len, "*/") orelse return false;
    return std.mem.eql(u8, source_content.string[marker.len..encoded_end], encoded_path);
}

fn originalPathFromSourceMarker(allocator: std.mem.Allocator, source: []const u8) !?[]const u8 {
    const marker = "/*@cottontail-original-path-base64:";
    if (!std.mem.startsWith(u8, source, marker)) return null;
    const encoded_end = std.mem.indexOfPos(u8, source, marker.len, "*/") orelse return null;
    const encoded = source[marker.len..encoded_end];
    const decoded_len = std.base64.standard.Decoder.calcSizeForSlice(encoded) catch return null;
    const decoded = try allocator.alloc(u8, decoded_len);
    std.base64.standard.Decoder.decode(decoded, encoded) catch {
        allocator.free(decoded);
        return null;
    };
    return decoded;
}

fn sourcePathEndsWithComponent(path: []const u8, component: []const u8) bool {
    if (!std.mem.endsWith(u8, path, component)) return false;
    if (path.len == component.len) return true;
    const separator = path[path.len - component.len - 1];
    return separator == '/' or separator == '\\';
}

fn runtimeEntrypointIdentity(
    ctx: *const Context,
    physical_path: []const u8,
    fallback_path: []const u8,
) ![]const u8 {
    const name = std.fs.path.basename(physical_path);
    if (!std.mem.startsWith(u8, name, ".cottontail-compat-") and
        !std.mem.startsWith(u8, name, ".cottontail-eval-"))
    {
        return fallback_path;
    }
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        physical_path,
        ctx.allocator,
        .limited(64 * 1024 * 1024),
    ) catch return fallback_path;
    return (try originalPathFromSourceMarker(ctx.allocator, source)) orelse fallback_path;
}

fn rewriteRuntimeEntrypointCode(
    ctx: *const Context,
    code: []const u8,
    physical_path: []const u8,
    identity_path: []const u8,
) ![]const u8 {
    if (std.mem.eql(u8, physical_path, identity_path)) return code;
    const physical_literal = try jsonStringLiteral(ctx, physical_path);
    if (std.mem.indexOf(u8, code, physical_literal) == null) return code;
    const identity_literal = try jsonStringLiteral(ctx, identity_path);
    // The compiler injects the entry's unbound __filename as a path literal.
    // Replace that ephemeral physical identity after linking; imports have
    // already been resolved and the generated source can still be deleted.
    return try std.mem.replaceOwned(u8, ctx.allocator, code, physical_literal, identity_literal);
}

fn rewriteRuntimeEntrypointSourceMap(
    ctx: *const Context,
    source_map: []const u8,
    physical_path: []const u8,
    identity_path: []const u8,
) ![]const u8 {
    // COTTONTAIL-COMPAT: Runtime wrappers already resolve relative map sources
    // against the project root. Avoid parsing and reserializing large hot maps
    // when no generated entrypoint identity needs to be repaired.
    if (std.mem.eql(u8, physical_path, identity_path)) return source_map;

    var parsed = try std.json.parseFromSlice(std.json.Value, ctx.allocator, source_map, .{});
    defer parsed.deinit();
    if (parsed.value != .object) return source_map;
    const sources = parsed.value.object.getPtr("sources") orelse return source_map;
    if (sources.* != .array) return source_map;
    const sources_content = parsed.value.object.getPtr("sourcesContent");

    const physical_name = std.fs.path.basename(physical_path);
    const identity_name = std.fs.path.basename(identity_path);
    var changed = false;
    for (sources.array.items, 0..) |*source, index| {
        if (sources_content) |content_value| {
            if (content_value.* == .array and index < content_value.array.items.len) {
                const content = content_value.array.items[index];
                if (content == .string) {
                    if (try originalPathFromSourceMarker(ctx.allocator, content.string)) |original_path| {
                        source.* = .{ .string = original_path };
                        changed = true;
                        continue;
                    }
                }
            }
        }
        if (source.* == .string and !std.fs.path.isAbsolute(source.string)) {
            const project_path = try std.fs.path.resolve(ctx.allocator, &.{ ctx.project_root, source.string });
            const stat = std.Io.Dir.cwd().statFile(ctx.io, project_path, .{}) catch null;
            if (stat != null and stat.?.kind == .file) {
                source.* = .{ .string = project_path };
                changed = true;
                continue;
            }
        }
        if (source.* != .string or
            !sourcePathEndsWithComponent(source.string, physical_name))
        {
            continue;
        }
        source.* = .{ .string = try std.mem.concat(ctx.allocator, u8, &.{
            source.string[0 .. source.string.len - physical_name.len],
            identity_name,
        }) };
        changed = true;
    }
    if (!changed) return source_map;
    return try std.json.Stringify.valueAlloc(ctx.allocator, parsed.value, .{});
}

const StandaloneNativeAssets = struct {
    source: []const u8,
    directory: ?[]const u8 = null,
    preserve: bool = false,

    fn deinit(self: StandaloneNativeAssets, io: std.Io) void {
        if (self.preserve) return;
        if (self.directory) |directory| std.Io.Dir.cwd().deleteTree(io, directory) catch {};
    }
};

fn standaloneNativeTempBase(init: std.process.Init) []const u8 {
    for ([_][]const u8{ "BUN_TMPDIR", "TMPDIR", "TEMP", "TMP" }) |name| {
        if (init.environ_map.get(name)) |value| {
            if (value.len > 0) return value;
        }
    }
    return if (builtin.os.tag == .windows) "C:\\Temp" else "/tmp";
}

fn createStandaloneNativeDirectory(init: std.process.Init, allocator: std.mem.Allocator) ![]const u8 {
    const base = standaloneNativeTempBase(init);
    try std.Io.Dir.cwd().createDirPath(init.io, base);
    for (0..8) |_| {
        var random: [8]u8 = undefined;
        init.io.random(&random);
        const suffix = std.fmt.bytesToHex(random, .lower);
        const name = try std.fmt.allocPrint(allocator, "cottontail-node-{s}", .{&suffix});
        const directory = try std.fs.path.join(allocator, &.{ base, name });
        std.Io.Dir.cwd().createDir(init.io, directory, .default_dir) catch |err| switch (err) {
            error.PathAlreadyExists => continue,
            else => return err,
        };
        return directory;
    }
    return error.TempDirCollision;
}

fn prepareStandaloneNativeAssets(
    init: std.process.Init,
    source: []const u8,
    files: ?[]const u8,
) !StandaloneNativeAssets {
    const graph = files orelse return .{ .source = source };
    const v1_magic = "CTGRAPH1";
    const v2_magic = "CTGRAPH2";
    const graph_v2 = graph.len >= v2_magic.len and std.mem.eql(u8, graph[0..v2_magic.len], v2_magic);
    const magic = if (graph_v2) v2_magic else v1_magic;
    if (graph.len < magic.len + @sizeOf(u32) or !std.mem.eql(u8, graph[0..magic.len], magic))
        return error.InvalidStandaloneGraph;

    const allocator = init.arena.allocator();
    var cursor: usize = magic.len;
    const file_count = readLauncherCacheInt(u32, graph, &cursor) orelse return error.InvalidStandaloneGraph;
    var rewritten_source = source;
    var needs_native_require_helper = false;
    var directory: ?[]const u8 = null;
    const preserve = init.environ_map.get("COTTONTAIL_KEEP_TEMP") != null;
    errdefer if (!preserve) {
        if (directory) |path| std.Io.Dir.cwd().deleteTree(init.io, path) catch {};
    };

    for (0..@as(usize, @intCast(file_count))) |_| {
        const metadata_len: usize = if (graph_v2) 1 else 0;
        const header_end = std.math.add(usize, cursor, 1 + metadata_len + @sizeOf(u32) + @sizeOf(u64)) catch
            return error.InvalidStandaloneGraph;
        if (header_end > graph.len) return error.InvalidStandaloneGraph;
        cursor += 1; // Encoding is only needed by the JavaScript file map.
        if (graph_v2) cursor += 1; // Runtime metadata is consumed by the JavaScriptCore bridge.
        const path_len = readLauncherCacheInt(u32, graph, &cursor) orelse return error.InvalidStandaloneGraph;
        const contents_len_u64 = readLauncherCacheInt(u64, graph, &cursor) orelse return error.InvalidStandaloneGraph;
        const contents_len = std.math.cast(usize, contents_len_u64) orelse return error.InvalidStandaloneGraph;
        const path_end = std.math.add(usize, cursor, path_len) catch return error.InvalidStandaloneGraph;
        if (path_end > graph.len) return error.InvalidStandaloneGraph;
        const virtual_path = graph[cursor..path_end];
        cursor = path_end;
        const contents_end = std.math.add(usize, cursor, contents_len) catch return error.InvalidStandaloneGraph;
        if (contents_end > graph.len) return error.InvalidStandaloneGraph;
        cursor = contents_end;

        if (!std.mem.endsWith(u8, virtual_path, ".node")) continue;
        const native_directory = directory orelse create: {
            const created = try createStandaloneNativeDirectory(init, allocator);
            directory = created;
            break :create created;
        };
        const basename = std.fs.path.basename(virtual_path);
        const destination = try std.fs.path.join(allocator, &.{ native_directory, basename });

        const virtual_path_literal = try std.json.Stringify.valueAlloc(
            allocator,
            std.json.Value{ .string = virtual_path },
            .{},
        );
        const destination_literal = try std.json.Stringify.valueAlloc(
            allocator,
            std.json.Value{ .string = destination },
            .{},
        );
        for ([_][]const u8{
            try std.mem.concat(allocator, u8, &.{ "./", basename }),
            virtual_path,
        }) |specifier| {
            const specifier_literal = try std.json.Stringify.valueAlloc(
                allocator,
                std.json.Value{ .string = specifier },
                .{},
            );
            // Check the longer helper spelling first because `require(` is a
            // suffix of `__require(`.
            for ([_][]const u8{ "__require", "require" }) |callee| {
                const old_call = try std.mem.concat(allocator, u8, &.{ callee, "(", specifier_literal, ")" });
                if (std.mem.indexOf(u8, rewritten_source, old_call) == null) continue;
                const new_call = try std.mem.concat(allocator, u8, &.{
                    "__ctStandaloneNativeRequire(",
                    virtual_path_literal,
                    ",",
                    destination_literal,
                    ")",
                });
                rewritten_source = try std.mem.replaceOwned(
                    u8,
                    allocator,
                    rewritten_source,
                    old_call,
                    new_call,
                );
                needs_native_require_helper = true;
            }
        }
    }
    if (cursor != graph.len) return error.InvalidStandaloneGraph;
    if (needs_native_require_helper) {
        const preserve_literal = if (preserve) "true" else "false";
        const helper = try std.mem.concat(allocator, u8, &.{
            "const __ctStandaloneNativeRequire = (virtualPath, path) => {" ++
                "const contents = globalThis.__cottontailStandaloneFiles?.[virtualPath];" ++
                "if (contents === undefined) throw new Error(`Missing standalone native addon: ${virtualPath}`);" ++
                "const slash = Math.max(path.lastIndexOf(\"/\"), path.lastIndexOf(\"\\\\\"));" ++
                "if (slash > 0) globalThis.cottontail.mkdirSync(path.slice(0, slash), true);" ++
                "globalThis.cottontail.writeFile(path, contents);" ++
                "const loaded = require(path);" ++
                "if (!",
            preserve_literal,
            " && globalThis.process?.platform !== \"win32\") {" ++
                "try {" ++
                "globalThis.cottontail.unlinkSync(path);" ++
                "if (slash > 0) { try { globalThis.cottontail.rmdirSync(path.slice(0, slash)); } catch {} }" ++
                "} catch {}" ++
                "}" ++
                "return loaded;" ++
                "};\n",
        });
        rewritten_source = try std.mem.concat(allocator, u8, &.{ helper, rewritten_source });
    }
    if (!preserve) {
        if (directory) |path| std.Io.Dir.cwd().deleteTree(init.io, path) catch {};
    }
    return .{ .source = rewritten_source, .directory = directory, .preserve = preserve };
}

pub fn runEmbedded(
    init: std.process.Init,
    source: []const u8,
    source_map: ?[]const u8,
    files: ?[]const u8,
    bytecode: ?[]const u8,
    script_args: []const [:0]const u8,
    exec_args: []const [:0]const u8,
    flags: standalone_executable.Flags,
) !u8 {
    const allocator = init.arena.allocator();
    const ctx = try makeContext(init);
    const native_assets = try prepareStandaloneNativeAssets(init, source, files);
    defer native_assets.deinit(init.io);
    const process_args = try allocator.alloc([:0]const u8, script_args.len + 1);
    process_args[0] = standalone_virtual_path;
    for (script_args, 0..) |arg, index| process_args[index + 1] = arg;
    return try runPrepared(
        init,
        &ctx,
        standalone_virtual_path,
        process_args,
        1,
        exec_args,
        native_assets.source,
        source_map,
        files,
        bytecode,
        flags,
    );
}

pub fn compileStandaloneSource(
    init: std.process.Init,
    entry_paths: []const []const u8,
    output_path: []const u8,
    build_options: native_bundler.BundleOptions,
) !StandaloneSource {
    const ctx = try makeContext(init);
    return compileStandaloneSourceWithContext(init, &ctx, entry_paths, output_path, build_options);
}

fn compileStandaloneSourceWithContext(
    init: std.process.Init,
    ctx: *const Context,
    entry_paths: []const []const u8,
    output_path: []const u8,
    build_options: native_bundler.BundleOptions,
) !StandaloneSource {
    if (entry_paths.len == 0) return error.MissingStandaloneEntryPoint;
    if (build_options.bytecode) try icu_bootstrap.ensure(init);
    const empty_args: [0][:0]const u8 = .{};
    var standalone_options = build_options;
    // Cottontail serializes the exact source consumed by its stock-JSC
    // wrapper after bundling. The inherited Bun compiler bytecode hook targets
    // Bun's patched SourceProvider and must stay disabled here.
    standalone_options.bytecode = false;
    standalone_options.compile = true;
    standalone_options.public_path = standaloneVirtualRoot();
    standalone_options.additional_entry_points = entry_paths[1..];
    standalone_options.entry_naming = if (entry_paths.len == 1) "index.js" else "[dir]/[name].[ext]";
    if (standalone_options.source_map != .none) standalone_options.source_map = .linked;
    try applyStandaloneCompileDefines(ctx, output_path, &standalone_options);
    var graph: native_bundler.BundleGraphOutput = undefined;
    var runnable = try bundleScriptNative(
        ctx,
        entry_paths[0],
        empty_args[0..],
        empty_args[0..],
        null,
        standalone_options,
        &graph,
        true,
        null,
        false,
    );
    defer runnable.deinit(ctx);
    defer graph.deinit();
    if (standalone_options.code_splitting) {
        try bundleStandaloneBootstrap(ctx, runnable.path, &graph, build_options.source_map != .none);
    }
    const entry = graph.entryPoint() orelse return error.MissingStandaloneEntryPoint;
    const source = try ctx.allocator.dupe(u8, entry.contents);
    const source_map = if (entry.source_map) |source_map|
        try ctx.allocator.dupe(u8, source_map.contents)
    else
        null;
    var source_maps: std.ArrayList(StandaloneSourceMap) = .empty;
    for (graph.files, 0..) |file, index| {
        if (index == graph.entry_point_file_index.?) continue;
        if (file.source_map) |map| {
            try source_maps.append(ctx.allocator, .{
                .path = try ctx.allocator.dupe(u8, map.path),
                .contents = try ctx.allocator.dupe(u8, map.contents),
            });
        }
    }
    const files = try serializeStandaloneGraph(ctx, &graph);
    const bytecode = if (build_options.bytecode)
        try runtime.generateCachedBytecode(ctx.allocator, source, standalone_virtual_path)
    else
        null;
    return .{
        .source = source,
        .source_map = source_map,
        .source_maps = try source_maps.toOwnedSlice(ctx.allocator),
        .files = files,
        .bytecode = bytecode,
    };
}

fn applyStandaloneCompileDefines(
    ctx: *const Context,
    output_path: []const u8,
    options: *native_bundler.BundleOptions,
) !void {
    const platform = switch (builtin.os.tag) {
        .macos => "\"darwin\"",
        .linux => "\"linux\"",
        .windows => "\"win32\"",
        else => @compileError("unsupported standalone platform"),
    };
    const architecture = switch (builtin.cpu.arch) {
        .aarch64 => "\"arm64\"",
        .x86_64 => "\"x64\"",
        else => @compileError("unsupported standalone architecture"),
    };
    const output_name = std.fs.path.basename(output_path);
    if (output_name.len == 0) return error.InvalidStandaloneOutputPath;
    const virtual_dir = if (builtin.os.tag == .windows) "B:\\~BUN\\root" else "/$bunfs/root";
    const virtual_path = try std.fmt.allocPrint(
        ctx.allocator,
        if (builtin.os.tag == .windows) "{s}\\{s}" else "{s}/{s}",
        .{ virtual_dir, output_name },
    );
    const url_path = try std.fmt.allocPrint(
        ctx.allocator,
        if (builtin.os.tag == .windows) "/B:/~BUN/root/{s}" else "/$bunfs/root/{s}",
        .{output_name},
    );
    const uri: std.Uri = .{
        .scheme = "file",
        .host = .{ .raw = "" },
        .path = .{ .raw = url_path },
    };
    const virtual_url = try std.fmt.allocPrint(ctx.allocator, "{f}", .{&uri});

    const compile_keys = [_][]const u8{
        "process.platform",
        "process.arch",
        "process.versions.bun",
        "import.meta.path",
        "import.meta.filename",
        "import.meta.dir",
        "import.meta.dirname",
        "import.meta.url",
    };
    const compile_values = [_][]const u8{
        platform,
        architecture,
        "\"1.3.10\"",
        try jsonStringLiteral(ctx, virtual_path),
        try jsonStringLiteral(ctx, virtual_path),
        try jsonStringLiteral(ctx, virtual_dir),
        try jsonStringLiteral(ctx, virtual_dir),
        try jsonStringLiteral(ctx, virtual_url),
    };

    var keys: std.ArrayList([]const u8) = .empty;
    var values: std.ArrayList([]const u8) = .empty;
    try keys.appendSlice(ctx.allocator, &compile_keys);
    try values.appendSlice(ctx.allocator, &compile_values);
    // Bun installs target defaults before user defines so explicit --define
    // values retain precedence.
    try keys.appendSlice(ctx.allocator, options.define_keys);
    try values.appendSlice(ctx.allocator, options.define_values);
    options.define_keys = keys.items;
    options.define_values = values.items;
}

const CompileBuildOutputJson = struct {
    path: []const u8,
    kind: []const u8,
    loader: []const u8,
};

const CompileBuildResultJson = struct {
    success: bool = true,
    outputs: []const CompileBuildOutputJson,
};

fn setCompileBuildError(error_out: *?[*:0]u8, comptime fmt: []const u8, args: anytype) void {
    const message = std.fmt.allocPrintSentinel(std.heap.c_allocator, fmt, args, 0) catch return;
    error_out.* = message.ptr;
}

fn compileObject(request: *const std.json.ObjectMap) ?*const std.json.ObjectMap {
    const value = request.getPtr("compile") orelse return null;
    return if (value.* == .object) &value.object else null;
}

fn compileExecArgv(
    allocator: std.mem.Allocator,
    compile: ?*const std.json.ObjectMap,
) ![]const u8 {
    const object = compile orelse return "";
    const value = object.get("execArgv") orelse return "";
    if (value != .array) return "";

    var joined: std.ArrayList(u8) = .empty;
    for (value.array.items) |item| {
        if (item != .string) return error.InvalidCompileExecArgv;
        if (joined.items.len > 0) try joined.append(allocator, ' ');
        try joined.appendSlice(allocator, item.string);
    }
    return joined.items;
}

fn compileFlags(compile: ?*const std.json.ObjectMap) standalone_executable.Flags {
    const object = compile orelse return .{};
    const boolValue = struct {
        fn get(map: *const std.json.ObjectMap, name: []const u8, default: bool) bool {
            const value = map.get(name) orelse return default;
            return if (value == .bool) value.bool else default;
        }
    }.get;
    return .{
        .disable_default_env_files = !boolValue(object, "autoloadDotenv", true),
        .disable_autoload_bunfig = !boolValue(object, "autoloadBunfig", true),
        .disable_autoload_tsconfig = !boolValue(object, "autoloadTsconfig", false),
        .disable_autoload_package_json = !boolValue(object, "autoloadPackageJson", false),
    };
}

fn compileExecutablePath(
    io: std.Io,
    allocator: std.mem.Allocator,
    working_dir: []const u8,
    compile: ?*const std.json.ObjectMap,
) !?[]const u8 {
    const object = compile orelse return null;
    const value = object.get("executablePath") orelse return null;
    if (value != .string or value.string.len == 0) return error.InvalidCompileExecutablePath;
    const candidate = if (std.fs.path.isAbsolute(value.string))
        try allocator.dupe(u8, value.string)
    else
        try std.fs.path.resolve(allocator, &.{ working_dir, value.string });
    const stat = std.Io.Dir.cwd().statFile(io, candidate, .{}) catch return error.InvalidCompileExecutablePath;
    if (stat.kind != .file) return error.InvalidCompileExecutablePath;
    return candidate;
}

fn wantsExternalCompileSourceMap(request: *const std.json.ObjectMap) bool {
    const value = request.get("sourcemap") orelse return false;
    return value == .string and
        (std.ascii.eqlIgnoreCase(value.string, "external") or
            std.ascii.eqlIgnoreCase(value.string, "linked"));
}

fn compileBuild(
    request_json: []const u8,
    working_dir: []const u8,
    output_path: []const u8,
    diagnostic_out: *?[]u8,
) ![]u8 {
    const configured_init = process_init orelse return error.ProcessNotConfigured;
    var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var init = configured_init;
    init.arena = &arena;
    init.gpa = std.heap.c_allocator;

    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, request_json, .{});
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidCompileOptions;
    const request = &parsed.value.object;
    const entries_value = request.get("entrypoints") orelse return error.MissingCompileEntryPoint;
    if (entries_value != .array or entries_value.array.items.len != 1 or entries_value.array.items[0] != .string) {
        return error.InvalidCompileEntryPoint;
    }
    const entry_path = entries_value.array.items[0].string;
    const entry_z = try allocator.dupeZ(u8, entry_path);

    var build_options = try native_bundler.parseBuildOptions(request_json, allocator);
    build_options.target = .bun;
    build_options.output_format = .esm;

    var diagnostics: std.ArrayList(u8) = .empty;
    var ctx = try makeContext(init);
    ctx.project_root = std.Io.Dir.cwd().realPathFileAlloc(init.io, working_dir, allocator) catch
        try std.fs.path.resolve(allocator, &.{working_dir});
    ctx.stderr_capture = &diagnostics;

    var payload = compileStandaloneSourceWithContext(init, &ctx, &.{entry_z}, output_path, build_options) catch |err| {
        const message = std.mem.trim(u8, diagnostics.items, " \t\r\n");
        if (message.len > 0) {
            diagnostic_out.* = try std.heap.c_allocator.dupe(u8, message);
            return error.CompileBuildDiagnostic;
        }
        return err;
    };
    const compile_options = compileObject(request);
    payload.compile_exec_argv = try compileExecArgv(allocator, compile_options);
    payload.flags = compileFlags(compile_options);
    const write_external_source_map = wantsExternalCompileSourceMap(request);
    const executable_path = try compileExecutablePath(init.io, allocator, working_dir, compile_options);
    try standalone_executable.write(
        init,
        output_path,
        executable_path,
        payload,
        write_external_source_map,
    );

    var outputs: std.ArrayList(CompileBuildOutputJson) = .empty;
    try outputs.append(allocator, .{ .path = output_path, .kind = "entry-point", .loader = "file" });
    if (write_external_source_map and payload.source_map != null) {
        try outputs.append(allocator, .{
            .path = try std.mem.concat(allocator, u8, &.{ output_path, ".map" }),
            .kind = "sourcemap",
            .loader = "json",
        });
        for (payload.source_maps) |source_map| {
            try outputs.append(allocator, .{
                .path = try standalone_executable.extraSourceMapPath(allocator, output_path, source_map.path),
                .kind = "sourcemap",
                .loader = "json",
            });
        }
    }

    const json = try std.json.Stringify.valueAlloc(
        allocator,
        CompileBuildResultJson{ .outputs = outputs.items },
        .{},
    );
    return try std.heap.c_allocator.dupe(u8, json);
}

pub export fn ct_compile_build(
    request_ptr: ?[*]const u8,
    request_len: usize,
    working_dir_ptr: ?[*]const u8,
    working_dir_len: usize,
    output_path_ptr: ?[*]const u8,
    output_path_len: usize,
    out_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    out_len.* = 0;
    error_out.* = null;
    const request_json = if (request_ptr) |ptr| ptr[0..request_len] else {
        setCompileBuildError(error_out, "Bun.build compile options are required", .{});
        return null;
    };
    const working_dir = if (working_dir_ptr) |ptr| ptr[0..working_dir_len] else {
        setCompileBuildError(error_out, "Bun.build compile working directory is required", .{});
        return null;
    };
    const output_path = if (output_path_ptr) |ptr| ptr[0..output_path_len] else {
        setCompileBuildError(error_out, "Bun.build compile output path is required", .{});
        return null;
    };

    var diagnostic: ?[]u8 = null;
    defer if (diagnostic) |message| std.heap.c_allocator.free(message);
    const output = compileBuild(request_json, working_dir, output_path, &diagnostic) catch |err| {
        if (diagnostic) |message| {
            setCompileBuildError(error_out, "{s}", .{message});
        } else {
            setCompileBuildError(error_out, "Standalone build failed: {s}", .{@errorName(err)});
        }
        return null;
    };
    out_len.* = output.len;
    return output.ptr;
}

pub export fn ct_compile_build_free(ptr: ?[*]u8, len: usize) void {
    if (ptr) |value| std.heap.c_allocator.free(value[0..len]);
}

pub export fn ct_compile_build_string_free(ptr: ?[*:0]u8) void {
    if (ptr) |value| std.heap.c_allocator.free(std.mem.span(value));
}

pub fn forceLink() void {
    _ = &ct_compile_build;
    _ = &ct_compile_build_free;
    _ = &ct_compile_build_string_free;
}

fn standaloneGraphOutputPath(ctx: *const Context, output_path: []const u8) ![]const u8 {
    if (std.fs.path.isAbsolute(output_path)) return error.InvalidStandaloneGraphPath;
    const normalized = try ctx.allocator.dupe(u8, output_path);
    if (builtin.os.tag == .windows) std.mem.replaceScalar(u8, normalized, '\\', '/');
    var trimmed: []const u8 = normalized;
    while (std.mem.startsWith(u8, trimmed, "./")) trimmed = trimmed[2..];
    if (trimmed.len == 0 or std.mem.eql(u8, trimmed, "..") or std.mem.startsWith(u8, trimmed, "../")) {
        return error.InvalidStandaloneGraphPath;
    }
    return trimmed;
}

fn writeStandaloneGraphFile(ctx: *const Context, root: []const u8, path: []const u8, contents: []const u8) ![]const u8 {
    const relative = try standaloneGraphOutputPath(ctx, path);
    const destination = try std.fs.path.join(ctx.allocator, &.{ root, relative });
    if (std.fs.path.dirname(destination)) |parent| try std.Io.Dir.cwd().createDirPath(ctx.io, parent);
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = destination, .data = contents });
    return destination;
}

fn bundleStandaloneBootstrap(
    ctx: *const Context,
    runnable_path: []const u8,
    graph: *native_bundler.BundleGraphOutput,
    source_maps: bool,
) !void {
    const entry = graph.entryPoint() orelse return error.MissingStandaloneEntryPoint;
    const runnable_dir = std.fs.path.dirname(runnable_path) orelse return error.InvalidStandaloneGraphPath;
    const graph_root = try std.fs.path.join(ctx.allocator, &.{ runnable_dir, "standalone-graph" });
    try std.Io.Dir.cwd().createDirPath(ctx.io, graph_root);

    var disk_entry: ?[]const u8 = null;
    for (graph.files, 0..) |file, index| {
        const destination = try writeStandaloneGraphFile(ctx, graph_root, file.path, file.contents);
        if (index == graph.entry_point_file_index.?) disk_entry = destination;
        if (file.source_map) |source_map| {
            _ = try writeStandaloneGraphFile(ctx, graph_root, source_map.path, source_map.contents);
        }
    }

    const ScannedImport = struct { path: []const u8, kind: []const u8 };
    var dynamic_imports: std.ArrayList([]const u8) = .empty;
    for (graph.files) |file| {
        if (!file.loader.isJavaScriptLike()) continue;
        const imports_json = try native_transpiler.scanImportsJson(file.contents, "js");
        defer std.heap.c_allocator.free(imports_json);
        const parsed = try std.json.parseFromSlice([]const ScannedImport, ctx.allocator, imports_json, .{});
        defer parsed.deinit();
        for (parsed.value) |item| {
            if (!std.mem.eql(u8, item.kind, "dynamic-import")) continue;
            var already_present = false;
            for (dynamic_imports.items) |existing| {
                if (std.mem.eql(u8, existing, item.path)) {
                    already_present = true;
                    break;
                }
            }
            if (!already_present) {
                try dynamic_imports.append(ctx.allocator, try ctx.allocator.dupe(u8, item.path));
            }
        }
    }

    var virtual_file_paths: std.ArrayList([]const u8) = .empty;
    var virtual_file_contents: std.ArrayList([]const u8) = .empty;
    for (graph.files, 0..) |file, index| {
        if (index == graph.entry_point_file_index.? or !file.loader.isJavaScriptLike()) continue;
        try virtual_file_paths.append(ctx.allocator, try standaloneVirtualPath(ctx, file.path));
        try virtual_file_contents.append(ctx.allocator, file.contents);
    }

    var options: native_bundler.BundleOptions = .{
        .source_map = if (source_maps) .external else .none,
        .output_format = .esm,
        .target = .bun,
        .external = dynamic_imports.items,
        .virtual_file_paths = virtual_file_paths.items,
        .virtual_file_contents = virtual_file_contents.items,
        .entry_naming = "index.js",
        .code_splitting = false,
        .inline_import_meta_properties = true,
        .preserve_external_require_name = true,
    };
    options.public_path = "";
    var error_message: ?[*:0]u8 = null;
    defer if (error_message) |message| native_bundler.ct_bundle_string_free(message);
    var bootstrap = native_bundler.bundleEntryPointGraphWithOptions(
        disk_entry orelse return error.MissingStandaloneEntryPoint,
        graph_root,
        options,
        &error_message,
    ) catch |err| {
        if (error_message) |message| ctx.writeStderr("error: standalone bootstrap: {s}\n", .{std.mem.span(message)});
        return err;
    };
    defer bootstrap.deinit();
    const bootstrap_entry = bootstrap.entryPoint() orelse return error.MissingStandaloneEntryPoint;

    const replacement_contents = bootstrap_entry.takeContents();
    if (entry.owns_contents) std.heap.c_allocator.free(entry.contents);
    entry.contents = replacement_contents;
    entry.owns_contents = true;
    entry.hash = bootstrap_entry.hash;

    var replacement_map: ?native_bundler.GraphSourceMap = null;
    errdefer if (replacement_map) |*source_map| source_map.deinit();
    if (bootstrap_entry.source_map) |source_map| {
        replacement_map = .{
            .path = try std.heap.c_allocator.dupe(u8, source_map.path),
            .contents = try std.heap.c_allocator.dupe(u8, source_map.contents),
        };
    }
    if (entry.source_map) |*source_map| source_map.deinit();
    entry.source_map = replacement_map;
}

fn standaloneVirtualPath(
    ctx: *const Context,
    output_path: []const u8,
) ![]const u8 {
    const trimmed = try standaloneGraphOutputPath(ctx, output_path);

    return try std.mem.concat(ctx.allocator, u8, &.{ standaloneVirtualRoot(), trimmed });
}

fn standaloneVirtualRoot() []const u8 {
    return if (builtin.os.tag == .windows) "B:/~BUN/root/" else "/$bunfs/root/";
}

fn serializeStandaloneGraph(
    ctx: *const Context,
    graph: *const native_bundler.BundleGraphOutput,
) ![]const u8 {
    const entry_index = graph.entry_point_file_index orelse return error.MissingStandaloneEntryPoint;
    const entry_path = graph.files[entry_index].path;
    var bytes: std.ArrayList(u8) = .empty;
    try bytes.appendSlice(ctx.allocator, "CTGRAPH2");
    try bytes.appendNTimes(ctx.allocator, 0, @sizeOf(u32));
    var file_count: u32 = 0;

    for (graph.files, 0..) |file, index| {
        if (ctx.environ_map.get("COTTONTAIL_DEBUG_STANDALONE_GRAPH") != null) {
            ctx.writeStderr("standalone graph: entry={s} output={s} bytes={d}\n", .{ entry_path, file.path, file.contents.len });
        }
        // The entry source is already the first standalone payload field. It
        // is installed separately at the canonical virtual entry path.
        if (index != entry_index) {
            const path = try standaloneVirtualPath(ctx, file.path);
            const appears_in_embedded_files = (file.side != null and file.side.? == .client) or
                !file.loader.isJavaScriptLike();
            const is_bytecode_entry = file.entry_point_index != null and file.loader.isJavaScriptLike();
            try appendStandaloneGraphFile(
                &bytes,
                ctx.allocator,
                path,
                file.contents,
                appears_in_embedded_files,
                is_bytecode_entry,
            );
            file_count += 1;
        }
        if (file.source_map) |source_map| {
            const map_path = try standaloneVirtualPath(ctx, source_map.path);
            try appendStandaloneGraphFile(&bytes, ctx.allocator, map_path, source_map.contents, false, false);
            file_count += 1;
        }
    }

    var count_bytes: [@sizeOf(u32)]u8 = undefined;
    std.mem.writeInt(u32, &count_bytes, file_count, .little);
    @memcpy(bytes.items["CTGRAPH1".len..][0..count_bytes.len], &count_bytes);
    return try bytes.toOwnedSlice(ctx.allocator);
}

fn appendStandaloneGraphFile(
    bytes: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    path: []const u8,
    contents: []const u8,
    appears_in_embedded_files: bool,
    is_bytecode_entry: bool,
) !void {
    if (path.len > std.math.maxInt(u32)) return error.StandaloneGraphPathTooLong;
    var header: [2 + @sizeOf(u32) + @sizeOf(u64)]u8 = undefined;
    header[0] = if (std.unicode.utf8ValidateSlice(contents)) 0 else 1;
    header[1] = @as(u8, @intFromBool(appears_in_embedded_files)) |
        (@as(u8, @intFromBool(is_bytecode_entry)) << 1);
    std.mem.writeInt(u32, header[2 .. 2 + @sizeOf(u32)], @intCast(path.len), .little);
    std.mem.writeInt(u64, header[2 + @sizeOf(u32) ..], @intCast(contents.len), .little);
    try bytes.appendSlice(allocator, &header);
    try bytes.appendSlice(allocator, path);
    try bytes.appendSlice(allocator, contents);
}

pub fn runStdin(
    init: std.process.Init,
    script_args: []const [:0]const u8,
    exec_args: []const [:0]const u8,
) !u8 {
    const allocator = init.arena.allocator();
    var source: std.ArrayList(u8) = .empty;
    defer source.deinit(allocator);

    var reader_buffer: [8192]u8 = undefined;
    var buffer: [8192]u8 = undefined;
    var stdin_reader = std.Io.File.stdin().readerStreaming(init.io, &reader_buffer);
    while (true) {
        const count = stdin_reader.interface.readSliceShort(&buffer) catch |err| switch (err) {
            error.ReadFailed => return error.ReadFailed,
        };
        if (count == 0) break;
        if (source.items.len + count > 64 * 1024 * 1024) return error.StreamTooLong;
        try source.appendSlice(allocator, buffer[0..count]);
    }

    const ctx = try makeContext(init);
    const source_z = try allocator.dupeZ(u8, source.items);
    const module_input = hasModuleInputType(exec_args) or sourceLooksEsm(source_z);
    const stdin_entry = try writeEvalEntrypoint(&ctx, ctx.project_root, source_z, false, module_input, "[stdin]", true, .stdin);
    defer std.Io.Dir.cwd().deleteFile(ctx.io, stdin_entry.entry_path) catch {};
    defer if (stdin_entry.source_path) |path| std.Io.Dir.cwd().deleteFile(ctx.io, path) catch {};
    var runnable = try bundleScriptNative(&ctx, stdin_entry.entry_path, exec_args, script_args, ctx.project_root, null, null, false, null, false);
    defer runnable.deinit(&ctx);
    canonicalizeVirtualSourceMap(&ctx, runnable.path, stdin_entry.source_path orelse stdin_entry.entry_path, "[stdin]") catch |err| switch (err) {
        error.EvalSourceMissingFromSourceMap => {},
        else => return err,
    };

    const runnable_path_z = try allocator.dupeZ(u8, runnable.path);
    const process_args = try allocator.alloc([:0]const u8, script_args.len + 1);
    process_args[0] = try allocator.dupeZ(u8, stdin_entry.entry_path);
    @memcpy(process_args[1..], script_args);
    return try runPrepared(init, &ctx, runnable_path_z, process_args, 1, exec_args, null, null, null, null, null);
}

fn makeContext(init: std.process.Init) !Context {
    const allocator = init.arena.allocator();
    const discovered_executable_path = try std.process.executablePathAlloc(init.io, allocator);
    const executable_path = std.Io.Dir.cwd().realPathFileAlloc(
        init.io,
        discovered_executable_path,
        allocator,
    ) catch discovered_executable_path;
    const executable_stamp = if (std.Io.Dir.cwd().statFile(init.io, executable_path, .{})) |stat|
        try std.fmt.allocPrint(allocator, "{s}:{d}:{d}", .{ executable_path, stat.size, stat.mtime.nanoseconds })
    else |_|
        try allocator.dupe(u8, executable_path);
    return .{
        .io = init.io,
        .allocator = allocator,
        .environ_map = init.environ_map,
        .project_root = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator),
        .executable_stamp = executable_stamp,
    };
}

extern "c" fn setenv(name: [*:0]const u8, value: [*:0]const u8, overwrite: c_int) c_int;

fn applyRuntimeEnvFlags(io: std.Io, allocator: std.mem.Allocator, exec_args: []const [:0]const u8) bool {
    for (exec_args, 0..) |arg, index| {
        var value: ?[]const u8 = null;
        if (std.mem.startsWith(u8, arg, "--max-http-header-size=")) {
            value = arg["--max-http-header-size=".len..];
        } else if (std.mem.eql(u8, arg, "--max-http-header-size") and index + 1 < exec_args.len) {
            value = exec_args[index + 1];
        }
        if (value) |size_text| {
            const value_z = allocator.dupeZ(u8, size_text) catch return false;
            _ = setenv("BUN_HTTP_MAX_HEADER_SIZE", value_z.ptr, 1);
        }

        var console_depth: ?[]const u8 = null;
        if (std.mem.startsWith(u8, arg, "--console-depth=")) {
            console_depth = arg["--console-depth=".len..];
        } else if (std.mem.eql(u8, arg, "--console-depth") and index + 1 < exec_args.len) {
            console_depth = exec_args[index + 1];
        }
        if (console_depth) |depth_text| {
            _ = std.fmt.parseUnsigned(u16, depth_text, 10) catch {
                var buffer: [512]u8 = undefined;
                var writer = std.Io.File.stderr().writer(io, &buffer);
                writer.interface.print(
                    "error: Invalid value for --console-depth: \"{s}\". Must be a positive integer\n",
                    .{depth_text},
                ) catch {};
                writer.interface.flush() catch {};
                return false;
            };
            const value_z = allocator.dupeZ(u8, depth_text) catch return false;
            _ = setenv("COTTONTAIL_CONSOLE_DEPTH", value_z.ptr, 1);
        }
    }
    return true;
}

const InspectorFlag = struct {
    address: []const u8,
    wait_for_connection: bool,
    pause_on_start: bool,
};

fn inspectorFlagValue(exec_args: []const [:0]const u8, name: []const u8) ?[]const u8 {
    for (exec_args, 0..) |arg_z, index| {
        const arg: []const u8 = arg_z;
        if (std.mem.eql(u8, arg, name)) {
            if (index + 1 < exec_args.len and !std.mem.startsWith(u8, exec_args[index + 1], "-"))
                return exec_args[index + 1];
            return "";
        }
        if (arg.len > name.len and std.mem.startsWith(u8, arg, name) and arg[name.len] == '=')
            return arg[name.len + 1 ..];
    }
    return null;
}

fn inspectorFlag(exec_args: []const [:0]const u8) ?InspectorFlag {
    if (inspectorFlagValue(exec_args, "--inspect")) |address| return .{
        .address = address,
        .wait_for_connection = false,
        .pause_on_start = false,
    };
    if (inspectorFlagValue(exec_args, "--inspect-wait")) |address| return .{
        .address = address,
        .wait_for_connection = true,
        .pause_on_start = false,
    };
    if (inspectorFlagValue(exec_args, "--inspect-brk")) |address| return .{
        .address = address,
        .wait_for_connection = true,
        .pause_on_start = true,
    };
    return null;
}

fn parseInspectorPort(text: []const u8) !u16 {
    if (text.len == 0) return error.InvalidInspectorAddress;
    return std.fmt.parseUnsigned(u16, text, 10) catch error.InvalidInspectorAddress;
}

fn parseInspectorAuthority(authority: []const u8, default_port: u16) !struct { host: []const u8, port: u16 } {
    if (authority.len == 0) return .{ .host = "localhost", .port = default_port };
    if (authority[0] == '[') {
        const closing = std.mem.indexOfScalar(u8, authority, ']') orelse return error.InvalidInspectorAddress;
        if (closing == 1) return error.InvalidInspectorAddress;
        const host = authority[1..closing];
        if (closing + 1 == authority.len) return .{ .host = host, .port = default_port };
        if (authority[closing + 1] != ':') return error.InvalidInspectorAddress;
        return .{ .host = host, .port = try parseInspectorPort(authority[closing + 2 ..]) };
    }
    if (std.mem.lastIndexOfScalar(u8, authority, ':')) |colon| {
        if (std.mem.indexOfScalar(u8, authority[0..colon], ':') != null)
            return error.InvalidInspectorAddress;
        return .{
            .host = if (colon == 0) "localhost" else authority[0..colon],
            .port = try parseInspectorPort(authority[colon + 1 ..]),
        };
    }
    if (std.ascii.isDigit(authority[0])) {
        var all_digits = true;
        for (authority) |byte| {
            if (!std.ascii.isDigit(byte)) {
                all_digits = false;
                break;
            }
        }
        if (all_digits) return .{ .host = "localhost", .port = try parseInspectorPort(authority) };
    }
    return .{ .host = authority, .port = default_port };
}

fn decodeInspectorSocketPath(allocator: std.mem.Allocator, encoded: []const u8) ![:0]const u8 {
    if (encoded.len == 0) return error.InvalidInspectorAddress;
    const storage = try allocator.dupe(u8, encoded);
    const decoded = std.Uri.percentDecodeInPlace(storage);
    if (decoded.len == 0 or std.mem.indexOfScalar(u8, decoded, 0) != null)
        return error.InvalidInspectorAddress;
    return try allocator.dupeZ(u8, decoded);
}

fn parseInspectorFd(address: []const u8) !c_int {
    const value = if (std.mem.startsWith(u8, address, "fd://"))
        address["fd://".len..]
    else
        address["fd:".len..];
    const fd = std.fmt.parseInt(c_int, value, 10) catch return error.InvalidInspectorAddress;
    if (fd < 0) return error.InvalidInspectorAddress;
    return fd;
}

fn parseFramedTcp(allocator: std.mem.Allocator, address: []const u8) !runtime.InspectorTransport {
    const endpoint = if (std.mem.startsWith(u8, address, "tcp://"))
        address["tcp://".len..]
    else
        address["tcp:".len..];
    if (std.mem.indexOfScalar(u8, endpoint, '/') != null) return error.InvalidInspectorAddress;
    const parsed = try parseInspectorAuthority(endpoint, 6499);
    if (parsed.host.len == 0 or parsed.port == 0) return error.InvalidInspectorAddress;
    return .{ .framed_tcp = .{
        .host = try allocator.dupeZ(u8, parsed.host),
        .port = parsed.port,
    } };
}

fn parseInspectorLaunch(
    io: std.Io,
    allocator: std.mem.Allocator,
    raw_address: []const u8,
    wait_for_connection: bool,
    pause_on_start: bool,
    automatic: bool,
    connect_to: bool,
) !InspectorLaunch {
    var address = raw_address;
    var wait = wait_for_connection;
    var pause = pause_on_start;
    if (std.mem.endsWith(u8, address, "?break=1")) {
        address = address[0 .. address.len - "?break=1".len];
        wait = true;
        pause = true;
    } else if (std.mem.endsWith(u8, address, "?wait=1")) {
        address = address[0 .. address.len - "?wait=1".len];
        wait = true;
    }

    if (connect_to and std.fs.path.isAbsolute(address)) {
        return .{
            .options = .{
                .transport = .{ .framed_unix = try allocator.dupeZ(u8, address) },
                .pause_on_start = pause,
            },
            .display_address = address,
            .wait_for_connection = wait,
            .automatic = automatic,
        };
    }

    if (std.mem.startsWith(u8, address, "unix://") or std.mem.startsWith(u8, address, "unix:")) {
        const encoded_path = if (std.mem.startsWith(u8, address, "unix://"))
            address["unix://".len..]
        else
            address["unix:".len..];
        return .{
            .options = .{
                .transport = .{ .framed_unix = try decodeInspectorSocketPath(allocator, encoded_path) },
                .pause_on_start = pause,
            },
            .display_address = address,
            .wait_for_connection = wait,
            .automatic = automatic,
        };
    }

    if (std.mem.startsWith(u8, address, "fd://") or std.mem.startsWith(u8, address, "fd:")) {
        return .{
            .options = .{
                .transport = .{ .framed_fd = try parseInspectorFd(address) },
                .pause_on_start = pause,
            },
            .display_address = address,
            .wait_for_connection = wait,
            .automatic = automatic,
        };
    }

    if (std.mem.startsWith(u8, address, "tcp://") or std.mem.startsWith(u8, address, "tcp:")) {
        return .{
            .options = .{
                .transport = try parseFramedTcp(allocator, address),
                .pause_on_start = pause,
            },
            .display_address = address,
            .wait_for_connection = wait,
            .automatic = automatic,
        };
    }

    if (connect_to) return error.InvalidInspectorAddress;

    if (std.mem.startsWith(u8, address, "ws+unix://") or std.mem.startsWith(u8, address, "ws+unix:")) {
        const encoded_path = if (std.mem.startsWith(u8, address, "ws+unix://"))
            address["ws+unix://".len..]
        else
            address["ws+unix:".len..];
        return .{
            .options = .{
                .transport = .{ .websocket_unix = try decodeInspectorSocketPath(allocator, encoded_path) },
                .pause_on_start = pause,
            },
            .display_address = address,
            .wait_for_connection = wait,
            .automatic = automatic,
        };
    }

    const explicit_websocket = std.mem.startsWith(u8, address, "ws://");
    const shorthand = if (explicit_websocket) address["ws://".len..] else address;
    const slash = std.mem.indexOfScalar(u8, shorthand, '/');
    const authority = if (slash) |index| shorthand[0..index] else shorthand;
    const path_text: ?[]const u8 = if (slash) |index| shorthand[index..] else null;
    const parsed = try parseInspectorAuthority(authority, if (explicit_websocket) 0 else 6499);
    if (parsed.host.len == 0) return error.InvalidInspectorAddress;

    const generated_path = if (path_text) |path|
        path
    else if (explicit_websocket)
        "/"
    else generated: {
        var random: [8]u8 = undefined;
        io.random(&random);
        const suffix = std.fmt.bytesToHex(random, .lower);
        break :generated try std.fmt.allocPrint(allocator, "/{s}", .{&suffix});
    };
    const host_z = try allocator.dupeZ(u8, parsed.host);
    const path_z = try allocator.dupeZ(u8, generated_path);
    return .{
        .options = .{
            .transport = .{ .websocket = .{
                .host = host_z,
                .port = parsed.port,
                .path = path_z,
            } },
            .pause_on_start = pause,
        },
        .display_address = address,
        .wait_for_connection = wait,
        .automatic = automatic,
    };
}

fn inspectorNotificationFromEnvironment(ctx: *const Context) !?InspectorNotification {
    const address = ctx.environ_map.get("BUN_INSPECT_NOTIFY") orelse return null;
    if (address.len == 0) return null;

    if (std.mem.startsWith(u8, address, "unix://")) {
        const path = try decodeInspectorSocketPath(ctx.allocator, address["unix://".len..]);
        const absolute = try absolutePathForCwd(ctx.io, ctx.allocator, path);
        return .{ .unix = try ctx.allocator.dupeZ(u8, absolute) };
    }

    const endpoint = if (std.mem.indexOf(u8, address, "://")) |scheme_end|
        address[scheme_end + 3 ..]
    else
        address;
    if (std.mem.indexOfScalar(u8, endpoint, '/') != null) return error.InvalidInspectorAddress;
    const parsed = try parseInspectorAuthority(endpoint, 0);
    if (parsed.host.len == 0 or parsed.port == 0) return error.InvalidInspectorAddress;
    return .{ .tcp = .{
        .host = try ctx.allocator.dupeZ(u8, parsed.host),
        .port = parsed.port,
    } };
}

fn inspectorLaunchFromArgs(ctx: *const Context, exec_args: []const [:0]const u8) !?InspectorLaunch {
    var launch: ?InspectorLaunch = null;
    if (inspectorFlag(exec_args)) |flag| {
        launch = try parseInspectorLaunch(
            ctx.io,
            ctx.allocator,
            flag.address,
            flag.wait_for_connection,
            flag.pause_on_start,
            false,
            false,
        );
    } else {
        if (ctx.environ_map.get("BUN_INSPECT")) |address| {
            if (address.len > 0)
                launch = try parseInspectorLaunch(ctx.io, ctx.allocator, address, false, false, true, false);
        }
        if (launch == null) {
            if (ctx.environ_map.get("BUN_INSPECT_CONNECT_TO")) |address| {
                if (address.len > 0)
                    launch = try parseInspectorLaunch(ctx.io, ctx.allocator, address, false, false, true, true);
            }
        }
    }
    if (launch) |*configured| {
        configured.notification = try inspectorNotificationFromEnvironment(ctx);
        if (configured.notification != null)
            _ = setenv("BUN_INSPECT_NOTIFY", "", 1);
    }
    return launch;
}

fn runPrepared(
    init: std.process.Init,
    ctx: *const Context,
    runnable_path_z: [:0]const u8,
    process_args: []const [:0]const u8,
    process_user_arg_offset: usize,
    exec_args: []const [:0]const u8,
    embedded_source: ?[]const u8,
    embedded_source_map: ?[]const u8,
    embedded_files: ?[]const u8,
    embedded_bytecode: ?[]const u8,
    standalone_flags: ?standalone_executable.Flags,
) !u8 {
    const allocator = init.arena.allocator();
    if (!applyRuntimeEnvFlags(init.io, allocator, exec_args)) return 1;
    const inspector = inspectorLaunchFromArgs(ctx, exec_args) catch |err| {
        ctx.writeStderr("cottontail: invalid inspector endpoint: {s}\n", .{@errorName(err)});
        return 1;
    };
    icu_bootstrap.ensure(init) catch |err| {
        ctx.writeStderr("cottontail: failed to initialize ICU: {s}\n", .{@errorName(err)});
        return 1;
    };
    var execution = ScriptExecution{
        .io = init.io,
        .allocator = allocator,
        .runnable_path = runnable_path_z,
        .process_args = process_args,
        .process_user_arg_offset = process_user_arg_offset,
        .exec_args = exec_args,
        .inspector = inspector,
        .embedded_source = embedded_source,
        .embedded_source_map = embedded_source_map,
        .embedded_files = embedded_files,
        .embedded_bytecode = embedded_bytecode,
        .test_cli_execution = ctx.environ_map.get("COTTONTAIL_TEST_CLI_HEADER_PRINTED") != null,
        .standalone_flags = standalone_flags,
        .exit_cleanup_path = if (runnableDirectoryForCleanup(ctx, runnable_path_z)) |path|
            try allocator.dupeZ(u8, path)
        else
            null,
    };
    return try runExecutionThread(ctx, &execution);
}

fn configureRuntimeInspector(execution: *const ScriptExecution, js_runtime: *runtime.Runtime) bool {
    const inspector = execution.inspector orelse return true;
    const inspector_url = js_runtime.startInspector(inspector.options) catch {
        writeStderr(execution.io, "cottontail: failed to start inspector\n", .{});
        return false;
    };
    defer if (inspector_url) |url| js_runtime.allocator.free(url);

    if (!inspector.automatic) {
        switch (inspector.options.transport) {
            .websocket => {
                const url = inspector_url orelse {
                    writeStderr(execution.io, "cottontail: inspector did not report a listening URL\n", .{});
                    return false;
                };
                const browser_target = if (std.mem.startsWith(u8, url, "ws://"))
                    url["ws://".len..]
                else
                    url;
                writeStderr(
                    execution.io,
                    "--------------------- Bun Inspector ---------------------\nListening:\n  {s}\nInspect in browser:\n  https://debug.bun.sh/#{s}\n--------------------- Bun Inspector ---------------------\n",
                    .{ url, browser_target },
                );
            },
            .websocket_unix => {},
            else => writeStderr(
                execution.io,
                "--------------------- Bun Inspector ---------------------\nListening on {s}\n--------------------- Bun Inspector ---------------------\n",
                .{inspector.display_address},
            ),
        }
    }
    if (inspector.notification) |notification| {
        switch (notification) {
            .unix => |path| js_runtime.notifyInspectorUnix(path),
            .tcp => |endpoint| js_runtime.notifyInspectorTcp(endpoint.host, endpoint.port),
        }
    }
    if (inspector.wait_for_connection) {
        js_runtime.waitForInspector() catch {
            writeStderr(execution.io, "cottontail: inspector stopped before a debugger connected\n", .{});
            return false;
        };
    }
    return true;
}

fn reloadProcessArgv(init: std.process.Init, allocator: std.mem.Allocator) ![]const [:0]const u8 {
    const args = try init.minimal.args.toSlice(allocator);
    if (comptime builtin.os.tag == .windows) return args;
    const spawn_gate_prefix = "--cottontail-spawn-gate=";
    if (args.len < 2 or !std.mem.startsWith(u8, args[1], spawn_gate_prefix)) return args;

    const visible = try allocator.alloc([:0]const u8, args.len - 1);
    visible[0] = args[0];
    @memcpy(visible[1..], args[2..]);
    return visible;
}

fn runReloadPrepared(
    init: std.process.Init,
    ctx: *const Context,
    entrypoint_path: []const u8,
    process_args: []const [:0]const u8,
    exec_args: []const [:0]const u8,
    mode: ReloadMode,
    clear_screen: bool,
) !u8 {
    const allocator = init.arena.allocator();
    if (comptime builtin.os.tag == .windows) {
        if (mode == .watch and !compiler.windows.isWatcherChild()) {
            compiler.windows.becomeWatcherManager(allocator);
        }
    }
    if (missingExplicitPreload(ctx, exec_args)) |specifier| {
        ctx.writeStderr("error: preload not found {s}\n", .{specifier});
        return 1;
    }
    if (!applyRuntimeEnvFlags(init.io, allocator, exec_args)) return 1;
    const inspector = inspectorLaunchFromArgs(ctx, exec_args) catch |err| {
        ctx.writeStderr("cottontail: invalid inspector endpoint: {s}\n", .{@errorName(err)});
        return 1;
    };
    icu_bootstrap.ensure(init) catch |err| {
        ctx.writeStderr("cottontail: failed to initialize ICU: {s}\n", .{@errorName(err)});
        return 1;
    };
    var execution = ScriptExecution{
        .io = init.io,
        .allocator = allocator,
        .runnable_path = "",
        .process_args = process_args,
        .process_user_arg_offset = 1,
        .exec_args = exec_args,
        .inspector = inspector,
        .reload = .{
            .ctx = ctx.*,
            .entrypoint_path = entrypoint_path,
            .process_argv = try reloadProcessArgv(init, allocator),
            .mode = mode,
            .clear_screen = clear_screen,
        },
    };
    return try runExecutionThread(ctx, &execution);
}

fn runExecutionThread(ctx: *const Context, execution: *ScriptExecution) !u8 {
    const main_thread_status: ?u8 = if (builtin.os.tag == .windows) blk: {
        // Zig's Windows Thread.spawn passes stack_size to NtCreateThreadEx as
        // committed memory. A fully committed 128 MiB stack has no reserved
        // region or guard page for WebKit's Windows StackBounds discovery.
        // Reserve the large limit while retaining normal incremental commits.
        const thread = try WindowsScriptThread.start(execution);
        defer thread.deinit();
        const status = if (shouldRunElectrobunMainThread(ctx))
            runElectrobunMainThread(ctx) catch |err| status: {
                ctx.writeStderr("cottontail: failed to run Electrobun main thread: {s}\n", .{@errorName(err)});
                break :status @as(u8, 1);
            }
        else
            null;
        thread.join();
        break :blk status;
    } else blk: {
        const thread = try std.Thread.spawn(
            .{ .stack_size = script_thread_stack_size },
            runScriptExecution,
            .{execution},
        );
        const status = if (shouldRunElectrobunMainThread(ctx))
            runElectrobunMainThread(ctx) catch |err| status: {
                ctx.writeStderr("cottontail: failed to run Electrobun main thread: {s}\n", .{@errorName(err)});
                break :status @as(u8, 1);
            }
        else
            null;
        thread.join();
        break :blk status;
    };

    if (main_thread_status) |status| {
        if (status != 0) {
            return status;
        }
    }

    return execution.exit_code;
}

fn shouldRunElectrobunMainThread(ctx: *const Context) bool {
    return ctx.environ_map.get("COTTONTAIL_ELECTROBUN_DIST") != null;
}

fn electrobunCoreFileName() []const u8 {
    return switch (builtin.os.tag) {
        .windows => "ElectrobunCore.dll",
        .macos => "libElectrobunCore.dylib",
        else => "libElectrobunCore.so",
    };
}

fn electrobunEnv(ctx: *const Context, name: []const u8, fallback: []const u8) []const u8 {
    const value = ctx.environ_map.get(name) orelse return fallback;
    return if (value.len == 0) fallback else value;
}

fn runElectrobunMainThread(ctx: *const Context) !u8 {
    const dist_dir = ctx.environ_map.get("COTTONTAIL_ELECTROBUN_DIST") orelse return 0;
    const core_path = try std.fs.path.join(ctx.allocator, &.{ dist_dir, electrobunCoreFileName() });

    var windows_core: ?*Win32Library = null;
    var unix_core: std.DynLib = undefined;
    var unix_core_open = false;
    defer if (builtin.os.tag == .windows) {
        if (windows_core) |core| _ = FreeLibrary(core);
    } else if (unix_core_open) {
        unix_core.close();
    };

    const run_main_thread: RunElectrobunMainThreadFn, const last_error: ElectrobunLastErrorFn = if (builtin.os.tag == .windows) blk: {
        const core_path_z = try ctx.allocator.dupeZ(u8, core_path);
        const core = LoadLibraryA(core_path_z.ptr) orelse return error.OpenElectrobunCoreFailed;
        windows_core = core;
        const run_symbol = GetProcAddress(core, "electrobun_core_run_main_thread") orelse
            return error.MissingElectrobunRunMainThread;
        const error_symbol = GetProcAddress(core, "electrobun_core_last_error") orelse
            return error.MissingElectrobunLastError;
        break :blk .{ @ptrCast(run_symbol), @ptrCast(error_symbol) };
    } else blk: {
        unix_core = try std.DynLib.open(core_path);
        unix_core_open = true;
        const run_symbol = unix_core.lookup(
            RunElectrobunMainThreadFn,
            "electrobun_core_run_main_thread",
        ) orelse return error.MissingElectrobunRunMainThread;
        const error_symbol = unix_core.lookup(
            ElectrobunLastErrorFn,
            "electrobun_core_last_error",
        ) orelse return error.MissingElectrobunLastError;
        break :blk .{ run_symbol, error_symbol };
    };

    const identifier = try ctx.allocator.dupeZ(
        u8,
        electrobunEnv(ctx, "COTTONTAIL_ELECTROBUN_IDENTIFIER", "app.cottontail.electrobun"),
    );
    const name = try ctx.allocator.dupeZ(
        u8,
        electrobunEnv(ctx, "COTTONTAIL_ELECTROBUN_NAME", "Electrobun"),
    );
    const channel = try ctx.allocator.dupeZ(
        u8,
        electrobunEnv(ctx, "COTTONTAIL_ELECTROBUN_CHANNEL", "dev"),
    );

    const status = run_main_thread(identifier.ptr, name.ptr, channel.ptr, 0);
    if (status != 0) {
        if (last_error()) |message| {
            const message_slice = std.mem.span(message);
            if (message_slice.len > 0) {
                ctx.writeStderr("cottontail: ElectrobunCore failed: {s}\n", .{message_slice});
            }
        }
        return @intCast(@min(status, 255));
    }

    return 0;
}

fn bunfigTestCoverageEnabled(contents: []const u8) bool {
    var in_test_section = false;
    var enabled = false;
    var lines = std.mem.splitScalar(u8, contents, '\n');
    while (lines.next()) |raw_line| {
        const comment = std.mem.indexOfScalar(u8, raw_line, '#') orelse raw_line.len;
        const line = std.mem.trim(u8, raw_line[0..comment], " \t\r");
        if (line.len == 0) continue;
        if (line[0] == '[') {
            in_test_section = std.mem.eql(u8, line, "[test]");
            continue;
        }
        if (!in_test_section) continue;
        const equals = std.mem.indexOfScalar(u8, line, '=') orelse continue;
        const key = std.mem.trim(u8, line[0..equals], " \t");
        if (!std.mem.eql(u8, key, "coverage")) continue;
        const value = std.mem.trim(u8, line[equals + 1 ..], " \t");
        if (std.mem.eql(u8, value, "true")) enabled = true;
        if (std.mem.eql(u8, value, "false")) enabled = false;
    }
    return enabled;
}

fn testCoverageRequestedFromArgs(
    io: std.Io,
    allocator: std.mem.Allocator,
    test_cli_execution: bool,
    args: []const [:0]const u8,
) bool {
    if (!test_cli_execution) return false;
    for (args) |arg| {
        if (std.mem.eql(u8, arg, "--coverage")) return true;
    }

    const configured = configPathFromArgs(args) orelse "bunfig.toml";
    const contents = std.Io.Dir.cwd().readFileAlloc(
        io,
        configured,
        allocator,
        .limited(1024 * 1024),
    ) catch return false;
    return bunfigTestCoverageEnabled(contents);
}

fn testCoverageRequested(execution: *const ScriptExecution) bool {
    if (execution.process_args.len == 0) return false;
    return testCoverageRequestedFromArgs(
        execution.io,
        execution.allocator,
        execution.test_cli_execution,
        execution.process_args[1..],
    );
}

const ReloadDependencies = struct {
    paths: []const [:0]const u8 = &.{},

    fn init(entrypoint_path: []const u8) !ReloadDependencies {
        var result: ReloadDependencies = .{};
        const initial = [_][]const u8{entrypoint_path};
        try result.replace(initial[0..]);
        return result;
    }

    fn replaceAfterBuildFailure(
        self: *ReloadDependencies,
        ctx: *const Context,
        entrypoint_path: []const u8,
    ) !void {
        var paths: std.ArrayList([]const u8) = .empty;
        try paths.append(ctx.allocator, entrypoint_path);

        const entrypoint_dir = std.fs.path.dirname(entrypoint_path) orelse ctx.project_root;
        const root = if (std.mem.startsWith(u8, entrypoint_path, ctx.project_root))
            ctx.project_root
        else
            entrypoint_dir;
        try appendReloadWatchDirectory(ctx.allocator, &paths, root);

        var directory = std.Io.Dir.cwd().openDir(ctx.io, root, .{ .iterate = true }) catch {
            try self.replace(paths.items);
            return;
        };
        defer directory.close(ctx.io);
        var walker = try directory.walk(ctx.allocator);
        defer walker.deinit();
        while (try walker.next(ctx.io)) |entry| {
            if (entry.kind != .directory) continue;
            if (reloadWatchDirectoryExcluded(entry.basename)) {
                walker.leave(ctx.io);
                continue;
            }
            const absolute = try std.fs.path.join(ctx.allocator, &.{ root, entry.path });
            try appendReloadWatchDirectory(ctx.allocator, &paths, absolute);
        }
        try self.replace(paths.items);
    }

    fn replace(self: *ReloadDependencies, paths: anytype) !void {
        const next = try std.heap.c_allocator.alloc([:0]const u8, paths.len);
        var initialized: usize = 0;
        errdefer {
            for (next[0..initialized]) |path| std.heap.c_allocator.free(path);
            if (next.len > 0) std.heap.c_allocator.free(next);
        }
        for (paths, 0..) |path, index| {
            next[index] = try std.heap.c_allocator.dupeZ(u8, path);
            initialized += 1;
        }
        self.deinit();
        self.paths = next;
    }

    fn deinit(self: *ReloadDependencies) void {
        for (self.paths) |path| std.heap.c_allocator.free(path);
        if (self.paths.len > 0) std.heap.c_allocator.free(self.paths);
        self.paths = &.{};
    }
};

fn reloadWatchDirectoryExcluded(name: []const u8) bool {
    return std.mem.eql(u8, name, ".git") or
        std.mem.eql(u8, name, "node_modules") or
        std.mem.eql(u8, name, ".cottontail-tmp") or
        std.mem.eql(u8, name, ".zig-cache") or
        std.mem.eql(u8, name, "zig-cache");
}

fn appendReloadWatchDirectory(
    allocator: std.mem.Allocator,
    paths: *std.ArrayList([]const u8),
    directory: []const u8,
) !void {
    const marker = try std.fmt.allocPrint(allocator, "{s}{c}", .{ directory, std.fs.path.sep });
    try paths.append(allocator, marker);
}

const ReloadGenerationResult = union(enum) {
    reload,
    exit: u8,
};

fn initReloadRuntime(execution: *ScriptExecution) !runtime.Runtime {
    var js_runtime = try runtime.Runtime.initWithStackSize(
        execution.io,
        std.heap.c_allocator,
        script_js_stack_size,
    );
    errdefer js_runtime.deinit();
    try js_runtime.setProcessArgs(
        execution.process_args,
        execution.process_user_arg_offset,
        execution.exec_args,
    );
    if (!configureRuntimeInspector(execution, &js_runtime)) return error.InspectorSetupFailed;
    return js_runtime;
}

fn ensureHotRuntime(
    execution: *ScriptExecution,
    hot_runtime: *?runtime.Runtime,
) !*runtime.Runtime {
    if (hot_runtime.* == null) hot_runtime.* = try initReloadRuntime(execution);
    return if (hot_runtime.*) |*js_runtime| js_runtime else unreachable;
}

fn waitForReloadAfterBuildFailure(
    js_runtime: *runtime.Runtime,
    dependencies: *const ReloadDependencies,
) !ReloadGenerationResult {
    try js_runtime.setWatchPaths(dependencies.paths);
    try js_runtime.waitForReload();
    return .reload;
}

fn runReloadGeneration(
    execution: *ScriptExecution,
    reload: *ReloadExecution,
    generation_ctx: *const Context,
    dependencies: *ReloadDependencies,
    hot_runtime: *?runtime.Runtime,
) !ReloadGenerationResult {
    var watch_runtime: ?runtime.Runtime = null;
    defer if (watch_runtime) |*js_runtime| js_runtime.deinit();

    const reuse_reload_runtime = reload.mode == .hot and hot_runtime.* != null;
    const js_runtime: *runtime.Runtime = if (reload.mode == .hot)
        try ensureHotRuntime(execution, hot_runtime)
    else blk: {
        watch_runtime = try initReloadRuntime(execution);
        break :blk if (watch_runtime) |*value| value else unreachable;
    };

    var generated_dependencies: []const [:0]const u8 = &.{};
    var runnable = bundleScriptNative(
        generation_ctx,
        reload.entrypoint_path,
        execution.exec_args,
        execution.process_args[execution.process_user_arg_offset..],
        null,
        null,
        null,
        false,
        &generated_dependencies,
        reuse_reload_runtime,
    ) catch |err| {
        if (err != error.ReloadBundleFailed and err != error.TestBundleFailed) {
            generation_ctx.writeStderr("cottontail: reload build failed: {s}\n", .{@errorName(err)});
        }
        try dependencies.replaceAfterBuildFailure(generation_ctx, reload.entrypoint_path);
        return try waitForReloadAfterBuildFailure(js_runtime, dependencies);
    };
    defer runnable.deinit(generation_ctx);
    const runnable_path_z = try generation_ctx.allocator.dupeZ(u8, runnable.path);

    const source_map_path = try std.mem.concat(
        generation_ctx.allocator,
        u8,
        &.{ runnable.path, ".map" },
    );
    if (std.Io.Dir.cwd().access(execution.io, source_map_path, .{})) {
        try js_runtime.setExternalSourceMap(source_map_path, runnable.path);
    } else |_| {}

    if (runnableDirectoryForCleanup(generation_ctx, runnable.path)) |directory| {
        try js_runtime.setExitCleanupPath(try generation_ctx.allocator.dupeZ(u8, directory));
    }
    try dependencies.replace(generated_dependencies);
    try js_runtime.setWatchPaths(dependencies.paths);

    return switch (js_runtime.runReloadableFile(runnable_path_z)) {
        .reload => result: {
            if (reload.mode == .hot) try js_runtime.prepareHotReload();
            break :result .reload;
        },
        .failed => result: {
            try js_runtime.prepareHotReload();
            try js_runtime.waitForReload();
            break :result .reload;
        },
        .exited => |code| result: {
            if (code != 0) break :result .{ .exit = code };
            try js_runtime.waitForReload();
            if (reload.mode == .hot) try js_runtime.prepareHotReload();
            break :result .reload;
        },
    };
}

fn clearReloadScreen(execution: *const ScriptExecution, reload: *const ReloadExecution) void {
    if (!reload.clear_screen or !(std.Io.File.stdout().isTty(execution.io) catch false)) return;
    var buffer: [64]u8 = undefined;
    var writer = std.Io.File.stdout().writer(execution.io, &buffer);
    writer.interface.writeAll("\x1b[2J\x1b[H") catch {};
    writer.interface.flush() catch {};
}

fn replaceWatchProcess(execution: *const ScriptExecution, reload: *const ReloadExecution) !void {
    if (comptime builtin.os.tag == .windows) {
        if (TerminateProcess(
            GetCurrentProcess(),
            @intCast(compiler.windows.watcher_reload_exit),
        ) == 0) return error.WatchProcessReplacementFailed;
        while (true) std.atomic.spinLoopHint();
    }

    if (comptime builtin.os.tag == .macos or builtin.os.tag == .linux) {
        const allocator = std.heap.c_allocator;
        const executable = try std.process.executablePathAlloc(execution.io, allocator);
        defer allocator.free(executable);

        const argv = try allocator.allocSentinel(?[*:0]const u8, reload.process_argv.len, null);
        var argv_initialized: usize = 0;
        defer {
            for (argv[0..argv_initialized]) |arg| allocator.free(std.mem.span(arg.?));
            allocator.free(argv);
        }
        for (reload.process_argv, 0..) |arg, index| {
            argv[index] = (try allocator.dupeZ(u8, arg)).ptr;
            argv_initialized += 1;
        }

        const current_environment = std.mem.span(std.c.environ);
        const environment = try allocator.allocSentinel(?[*:0]const u8, current_environment.len, null);
        var environment_initialized: usize = 0;
        defer {
            for (environment[0..environment_initialized]) |entry| allocator.free(std.mem.span(entry.?));
            allocator.free(environment);
        }
        for (current_environment, 0..) |entry, index| {
            environment[index] = if (entry) |value|
                (try allocator.dupeZ(u8, std.mem.span(value))).ptr
            else
                null;
            environment_initialized += 1;
        }

        if (std.c.execve(
            executable.ptr,
            @ptrCast(argv.ptr),
            @ptrCast(environment.ptr),
        ) != 0) return error.WatchProcessReplacementFailed;
        unreachable;
    }

    return error.WatchProcessReplacementUnsupported;
}

fn runReloadExecution(execution: *ScriptExecution, reload: *ReloadExecution) void {
    var dependencies = ReloadDependencies.init(reload.entrypoint_path) catch {
        writeStderr(execution.io, "cottontail: failed to initialize reload dependencies\n", .{});
        execution.exit_code = 1;
        return;
    };
    defer dependencies.deinit();

    var hot_runtime: ?runtime.Runtime = null;
    defer if (hot_runtime) |*js_runtime| js_runtime.deinit();

    var generation: usize = 0;
    while (true) : (generation += 1) {
        if (generation > 0) {
            clearReloadScreen(execution, reload);
        }

        const result: ReloadGenerationResult = generation_result: {
            var generation_arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
            defer generation_arena.deinit();
            var generation_ctx = reload.ctx;
            generation_ctx.allocator = generation_arena.allocator();
            break :generation_result runReloadGeneration(
                execution,
                reload,
                &generation_ctx,
                &dependencies,
                &hot_runtime,
            ) catch |err| {
                writeStderr(execution.io, "cottontail: reload failed: {s}\n", .{@errorName(err)});
                execution.exit_code = 1;
                return;
            };
        };
        switch (result) {
            .reload => {
                if (reload.mode == .watch) {
                    clearReloadScreen(execution, reload);
                    replaceWatchProcess(execution, reload) catch |err| {
                        writeStderr(execution.io, "cottontail: failed to replace watch process: {s}\n", .{@errorName(err)});
                        execution.exit_code = 1;
                        return;
                    };
                    unreachable;
                }
                continue;
            },
            .exit => |code| {
                execution.exit_code = code;
                return;
            },
        }
    }
}

fn runScriptExecution(execution: *ScriptExecution) void {
    if (execution.reload) |*reload| {
        runReloadExecution(execution, reload);
        return;
    }
    const profiler_options = parseCpuProfileOptions(execution.exec_args);
    const heap_profile_options = parseHeapProfileOptions(execution.exec_args);
    writeCpuProfileWarnings(execution.io, profiler_options);
    writeHeapProfileWarnings(execution.io, heap_profile_options);
    var js_runtime = runtime.Runtime.initWithStackSize(
        execution.io,
        execution.allocator,
        script_js_stack_size,
    ) catch {
        writeStderr(execution.io, "cottontail: failed to initialize the embedded JavaScriptCore runtime\n", .{});
        execution.exit_code = 1;
        return;
    };
    defer js_runtime.deinit();

    // COTTONTAIL-COMPAT: Stock JSCOnly can export the sampling API while being
    // built without ENABLE(SAMPLING_PROFILER). Never synthesize a profile when
    // the engine reports that sampling is unavailable.
    const cpu_profiler_started = profiler_options.enabled() and js_runtime.enableSamplingProfiler();
    if (profiler_options.enabled() and !cpu_profiler_started) {
        writeStderr(execution.io, "cottontail: failed to enable the JSC sampling profiler\n", .{});
    }

    if (testCoverageRequested(execution) and !js_runtime.enableControlFlowProfiler()) {
        writeStderr(execution.io, "cottontail: failed to enable JavaScriptCore coverage profiling\n", .{});
        execution.exit_code = 1;
        return;
    }

    if (execution.exit_cleanup_path) |path| {
        js_runtime.setExitCleanupPath(path) catch {
            writeStderr(execution.io, "cottontail: failed to initialize transient artifact cleanup\n", .{});
            execution.exit_code = 1;
            return;
        };
    }

    js_runtime.setProcessArgs(
        execution.process_args,
        execution.process_user_arg_offset,
        execution.exec_args,
    ) catch {
        writeStderr(execution.io, "cottontail: failed to initialize cottontail.args\n", .{});
        execution.exit_code = 1;
        return;
    };

    if (!configureRuntimeInspector(execution, &js_runtime)) {
        execution.exit_code = 1;
        return;
    }

    // Cached runtime artifacts keep their external map beside the immutable
    // generated source. Install its stable path and let the stack remapper load
    // the multi-megabyte map lazily only when a generated frame needs it.
    if (execution.embedded_source == null) {
        const source_map_path = std.mem.concat(
            execution.allocator,
            u8,
            &.{ execution.runnable_path, ".map" },
        ) catch null;
        if (source_map_path) |path| {
            if (std.Io.Dir.cwd().access(execution.io, path, .{})) {
                js_runtime.setExternalSourceMap(path, execution.runnable_path) catch {
                    writeStderr(execution.io, "cottontail: failed to install generated source map\n", .{});
                    execution.exit_code = 1;
                    return;
                };
            } else |_| {}
        }
    }

    execution.exit_code = if (execution.embedded_source) |source| blk: {
        if (execution.standalone_flags) |flags| {
            js_runtime.setStandaloneFlags(flags) catch {
                writeStderr(execution.io, "cottontail: failed to install standalone runtime flags\n", .{});
                break :blk 1;
            };
        }
        if (execution.embedded_files) |files| {
            js_runtime.setStandaloneFiles(files) catch {
                writeStderr(execution.io, "cottontail: failed to install standalone module graph\n", .{});
                break :blk 1;
            };
        }
        if (execution.embedded_source_map) |source_map| {
            js_runtime.setEmbeddedSourceMap(source_map, execution.runnable_path) catch {
                writeStderr(execution.io, "cottontail: failed to install standalone source map\n", .{});
                break :blk 1;
            };
        }
        break :blk if (execution.embedded_bytecode) |bytecode|
            js_runtime.runSourceWithBytecode(source, execution.runnable_path, bytecode)
        else
            js_runtime.runSource(source, execution.runnable_path);
    } else js_runtime.runFile(execution.runnable_path);
    if (cpu_profiler_started) {
        const raw_profile = js_runtime.takeSamplingProfile() catch |err| profile: {
            writeStderr(execution.io, "cottontail: failed to collect CPU profile: {s}\n", .{@errorName(err)});
            execution.exit_code = 1;
            break :profile null;
        };
        if (raw_profile) |profile| {
            writeCpuProfiles(execution, profiler_options, profile) catch |err| {
                writeStderr(execution.io, "cottontail: failed to write CPU profile: {s}\n", .{@errorName(err)});
                execution.exit_code = 1;
            };
        } else {
            writeStderr(execution.io, "cottontail: JSC returned no CPU profile\n", .{});
            execution.exit_code = 1;
        }
    } else if (profiler_options.enabled()) {
        execution.exit_code = 1;
    }
    if (heap_profile_options.enabled()) {
        writeHeapProfile(execution, &js_runtime, heap_profile_options) catch |err| {
            writeStderr(execution.io, "cottontail: failed to write heap profile: {s}\n", .{@errorName(err)});
        };
    }
}

const HeapProfileFormat = enum { v8, markdown };

const HeapProfileOptions = struct {
    v8: bool = false,
    markdown: bool = false,
    dir: ?[]const u8 = null,
    name: ?[]const u8 = null,

    fn enabled(self: HeapProfileOptions) bool {
        return self.v8 or self.markdown;
    }

    fn format(self: HeapProfileOptions) HeapProfileFormat {
        return if (self.markdown) .markdown else .v8;
    }
};

fn parseHeapProfileOptions(args: []const [:0]const u8) HeapProfileOptions {
    var options: HeapProfileOptions = .{};
    for (args, 0..) |arg_z, index| {
        const arg: []const u8 = arg_z;
        if (std.mem.eql(u8, arg, "--heap-prof")) {
            options.v8 = true;
        } else if (std.mem.eql(u8, arg, "--heap-prof-md")) {
            options.markdown = true;
        } else if (std.mem.startsWith(u8, arg, "--heap-prof-dir=")) {
            options.dir = arg["--heap-prof-dir=".len..];
        } else if (std.mem.eql(u8, arg, "--heap-prof-dir") and index + 1 < args.len) {
            options.dir = args[index + 1];
        } else if (std.mem.startsWith(u8, arg, "--heap-prof-name=")) {
            options.name = arg["--heap-prof-name=".len..];
        } else if (std.mem.eql(u8, arg, "--heap-prof-name") and index + 1 < args.len) {
            options.name = args[index + 1];
        }
    }
    return options;
}

fn writeHeapProfileWarnings(io: std.Io, options: HeapProfileOptions) void {
    if (options.v8 and options.markdown) {
        writeStderr(io, "warn: Both --heap-prof and --heap-prof-md specified; using --heap-prof-md (markdown format)\n", .{});
        return;
    }
    if (options.enabled()) return;
    if (options.name != null) {
        writeStderr(io, "warn: --heap-prof-name requires --heap-prof or --heap-prof-md to be enabled\n", .{});
    }
    if (options.dir != null) {
        writeStderr(io, "warn: --heap-prof-dir requires --heap-prof or --heap-prof-md to be enabled\n", .{});
    }
}

fn heapProfileDefaultName(
    io: std.Io,
    allocator: std.mem.Allocator,
    format: HeapProfileFormat,
) ![]const u8 {
    const now_ns = std.Io.Clock.real.now(io).nanoseconds;
    const timestamp_us: u64 = @intCast(@max(0, @divTrunc(now_ns, 1000)));
    const pid = profileProcessId();
    const extension = if (format == .markdown) "md" else "heapsnapshot";
    return try std.fmt.allocPrint(allocator, "Heap.{d}.{d}.{s}", .{ timestamp_us, pid, extension });
}

fn heapProfilePath(
    io: std.Io,
    allocator: std.mem.Allocator,
    options: HeapProfileOptions,
) ![]const u8 {
    const name = if (options.name) |configured|
        if (configured.len > 0) configured else try heapProfileDefaultName(io, allocator, options.format())
    else
        try heapProfileDefaultName(io, allocator, options.format());
    if (options.dir) |dir| {
        if (dir.len > 0) return try std.fs.path.join(allocator, &.{ dir, name });
    }
    return name;
}

fn writeHeapProfile(
    execution: *ScriptExecution,
    js_runtime: *runtime.Runtime,
    options: HeapProfileOptions,
) !void {
    const format = options.format();
    const raw_snapshot = try js_runtime.takeHeapSnapshot(format == .markdown) orelse return error.HeapSnapshotUnavailable;
    const profile = switch (format) {
        .v8 => try heap_profiler.convertJscToV8(execution.allocator, raw_snapshot),
        .markdown => try heap_profiler.buildMarkdown(execution.allocator, raw_snapshot),
    };
    const path = try heapProfilePath(execution.io, execution.allocator, options);
    if (std.fs.path.dirname(path)) |parent| {
        if (parent.len > 0) try std.Io.Dir.cwd().createDirPath(execution.io, parent);
    }
    try std.Io.Dir.cwd().writeFile(execution.io, .{ .sub_path = path, .data = profile });

    const cwd = try std.process.currentPathAlloc(execution.io, execution.allocator);
    const absolute_path = try std.fs.path.resolve(execution.allocator, &.{ cwd, path });
    writeStderr(execution.io, "Heap profile written to: {s}\n", .{absolute_path});
}

const CpuProfileOptions = struct {
    json: bool = false,
    markdown: bool = false,
    dir: ?[]const u8 = null,
    name: ?[]const u8 = null,
    interval_us: u32 = 1000,
    interval_supplied: bool = false,

    fn enabled(self: CpuProfileOptions) bool {
        return self.json or self.markdown;
    }
};

const cpu_profiler_start_statement =
    \\if ((globalThis.process?.execArgv ?? []).some((arg) => arg === "--cpu-prof" || arg === "--cpu-prof-md")) {
    \\  globalThis.cottontail?.startSamplingProfiler?.();
    \\}
;

fn parseCpuProfileOptions(args: []const [:0]const u8) CpuProfileOptions {
    var options: CpuProfileOptions = .{};
    for (args, 0..) |arg_z, index| {
        const arg: []const u8 = arg_z;
        if (std.mem.eql(u8, arg, "--cpu-prof")) {
            options.json = true;
        } else if (std.mem.eql(u8, arg, "--cpu-prof-md")) {
            options.markdown = true;
        } else if (std.mem.startsWith(u8, arg, "--cpu-prof-dir=")) {
            options.dir = arg["--cpu-prof-dir=".len..];
        } else if (std.mem.eql(u8, arg, "--cpu-prof-dir") and index + 1 < args.len) {
            options.dir = args[index + 1];
        } else if (std.mem.startsWith(u8, arg, "--cpu-prof-name=")) {
            options.name = arg["--cpu-prof-name=".len..];
        } else if (std.mem.eql(u8, arg, "--cpu-prof-name") and index + 1 < args.len) {
            options.name = args[index + 1];
        } else if (std.mem.startsWith(u8, arg, "--cpu-prof-interval=")) {
            options.interval_supplied = true;
            options.interval_us = std.fmt.parseUnsigned(u32, arg["--cpu-prof-interval=".len..], 10) catch 1000;
        } else if (std.mem.eql(u8, arg, "--cpu-prof-interval") and index + 1 < args.len) {
            options.interval_supplied = true;
            options.interval_us = std.fmt.parseUnsigned(u32, args[index + 1], 10) catch 1000;
        }
    }
    return options;
}

fn writeCpuProfileWarnings(io: std.Io, options: CpuProfileOptions) void {
    if (options.enabled()) return;
    if (options.name != null) {
        writeStderr(io, "warn: --cpu-prof-name requires --cpu-prof or --cpu-prof-md to be enabled\n", .{});
    }
    if (options.dir != null) {
        writeStderr(io, "warn: --cpu-prof-dir requires --cpu-prof or --cpu-prof-md to be enabled\n", .{});
    }
    if (options.interval_supplied) {
        writeStderr(io, "warn: --cpu-prof-interval requires --cpu-prof or --cpu-prof-md to be enabled\n", .{});
    }
}

const CpuCallFrame = struct {
    functionName: []const u8,
    scriptId: []const u8,
    url: []const u8,
    lineNumber: i64,
    columnNumber: i64,
};

const CpuProfileNode = struct {
    id: u32,
    callFrame: CpuCallFrame,
    hitCount: u32,
    children: []const u32,
};

const MutableCpuProfileNode = struct {
    id: u32,
    call_frame: CpuCallFrame,
    parent_id: u32,
    hit_count: u32 = 0,
    total_samples: u32 = 0,
    children: std.ArrayList(u32) = .empty,
};

const ChromeCpuProfile = struct {
    nodes: []const CpuProfileNode,
    startTime: u64,
    endTime: u64,
    samples: []const u32,
    timeDeltas: []const u64,
};

const BuiltCpuProfile = struct {
    chrome: ChromeCpuProfile,
    mutable_nodes: []const MutableCpuProfileNode,
    interval_us: u64,
};

fn jsonNumber(value: std.json.Value) ?f64 {
    return switch (value) {
        .integer => |number| @floatFromInt(number),
        .float => |number| number,
        .number_string => |number| std.fmt.parseFloat(f64, number) catch null,
        else => null,
    };
}

fn jsonUnsigned(value: std.json.Value) ?u64 {
    const number = jsonNumber(value) orelse return null;
    if (number < 0 or number > @as(f64, @floatFromInt(std.math.maxInt(u64)))) return null;
    return @intFromFloat(number);
}

fn chromePosition(value: ?std.json.Value) i64 {
    const position = jsonUnsigned(value orelse return -1) orelse return -1;
    if (position == 0 or position >= std.math.maxInt(u32)) return -1;
    return @intCast(position - 1);
}

fn cpuSourceUrl(
    allocator: std.mem.Allocator,
    sources: *const std.AutoHashMapUnmanaged(u64, []const u8),
    source_id: u64,
) ![]const u8 {
    const url = sources.get(source_id) orelse return "";
    if (!std.fs.path.isAbsolute(url)) return url;
    if (builtin.os.tag == .windows) return try std.fmt.allocPrint(allocator, "file:///{s}", .{url});
    return try std.fmt.allocPrint(allocator, "file://{s}", .{url});
}

fn buildCpuProfile(
    io: std.Io,
    allocator: std.mem.Allocator,
    raw_profile: []const u8,
    configured_interval_us: u32,
) !BuiltCpuProfile {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, raw_profile, .{});
    if (parsed.value != .object) return error.InvalidCpuProfile;
    const raw_object = parsed.value.object;

    var source_urls: std.AutoHashMapUnmanaged(u64, []const u8) = .empty;
    if (raw_object.get("sources")) |sources| {
        if (sources == .array) for (sources.array.items) |source| {
            if (source != .object) continue;
            const source_id = jsonUnsigned(source.object.get("sourceID") orelse continue) orelse continue;
            const url_value = source.object.get("url") orelse continue;
            if (url_value != .string) continue;
            try source_urls.put(allocator, source_id, url_value.string);
        };
    }

    var nodes: std.ArrayList(MutableCpuProfileNode) = .empty;
    try nodes.append(allocator, .{
        .id = 1,
        .parent_id = 0,
        .call_frame = .{
            .functionName = "(root)",
            .scriptId = "0",
            .url = "",
            .lineNumber = -1,
            .columnNumber = -1,
        },
    });
    var node_ids: std.StringHashMapUnmanaged(u32) = .empty;
    var samples: std.ArrayList(u32) = .empty;
    var time_deltas: std.ArrayList(u64) = .empty;

    const raw_interval_seconds = if (raw_object.get("interval")) |value| jsonNumber(value) orelse 0.001 else 0.001;
    const interval_us: u64 = if (configured_interval_us != 1000)
        @as(u64, configured_interval_us)
    else
        @max(1, @as(u64, @intFromFloat(@max(0.000001, raw_interval_seconds) * 1_000_000.0)));
    var first_timestamp: ?f64 = null;
    var last_timestamp: ?f64 = null;

    if (raw_object.get("traces")) |traces| {
        if (traces == .array) for (traces.array.items) |trace| {
            if (trace != .object) continue;
            const timestamp = jsonNumber(trace.object.get("timestamp") orelse continue) orelse continue;
            const frames = trace.object.get("frames") orelse continue;
            if (frames != .array) continue;

            const previous_timestamp = last_timestamp;
            if (first_timestamp == null) first_timestamp = timestamp;
            last_timestamp = timestamp;
            const delta_us = if (previous_timestamp) |previous|
                @as(u64, @intFromFloat(@max(0.0, timestamp - previous) * 1_000_000.0))
            else
                interval_us;
            try time_deltas.append(allocator, delta_us);

            var parent_id: u32 = 1;
            nodes.items[0].total_samples += 1;
            var frame_index = frames.array.items.len;
            while (frame_index > 0) {
                frame_index -= 1;
                const frame = frames.array.items[frame_index];
                if (frame != .object) continue;
                const source_id = jsonUnsigned(frame.object.get("sourceID") orelse .{ .integer = 0 }) orelse 0;
                const raw_name = frame.object.get("name") orelse std.json.Value{ .string = "" };
                const function_name = if (raw_name == .string and raw_name.string.len > 0) raw_name.string else "(anonymous)";
                const line_number = chromePosition(frame.object.get("line"));
                const column_number = chromePosition(frame.object.get("column"));
                const key = try std.fmt.allocPrint(
                    allocator,
                    "{d}\x00{d}\x00{d}\x00{d}\x00{s}",
                    .{ parent_id, source_id, line_number, column_number, function_name },
                );

                var node_id = node_ids.get(key);
                if (node_id == null) {
                    const new_id: u32 = @intCast(nodes.items.len + 1);
                    try node_ids.put(allocator, key, new_id);
                    try nodes.append(allocator, .{
                        .id = new_id,
                        .parent_id = parent_id,
                        .call_frame = .{
                            .functionName = function_name,
                            .scriptId = try std.fmt.allocPrint(allocator, "{d}", .{source_id}),
                            .url = try cpuSourceUrl(allocator, &source_urls, source_id),
                            .lineNumber = line_number,
                            .columnNumber = column_number,
                        },
                    });
                    try nodes.items[parent_id - 1].children.append(allocator, new_id);
                    node_id = new_id;
                }
                parent_id = node_id.?;
                nodes.items[parent_id - 1].total_samples += 1;
            }
            nodes.items[parent_id - 1].hit_count += 1;
            try samples.append(allocator, parent_id);
        };
    }

    const now_ns = std.Io.Clock.real.now(io).nanoseconds;
    const end_time: u64 = @intCast(@max(0, @divTrunc(now_ns, 1000)));
    const duration_us: u64 = if (first_timestamp != null and last_timestamp != null)
        @intFromFloat(@max(0.0, last_timestamp.? - first_timestamp.?) * 1_000_000.0)
    else
        0;
    const start_time = end_time -| duration_us;

    const chrome_nodes = try allocator.alloc(CpuProfileNode, nodes.items.len);
    for (nodes.items, 0..) |node, index| {
        chrome_nodes[index] = .{
            .id = node.id,
            .callFrame = node.call_frame,
            .hitCount = node.hit_count,
            .children = node.children.items,
        };
    }
    return .{
        .chrome = .{
            .nodes = chrome_nodes,
            .startTime = start_time,
            .endTime = end_time,
            .samples = samples.items,
            .timeDeltas = time_deltas.items,
        },
        .mutable_nodes = nodes.items,
        .interval_us = interval_us,
    };
}

fn cpuProfileMarkdown(allocator: std.mem.Allocator, profile: BuiltCpuProfile) ![]const u8 {
    var output = std.array_list.Managed(u8).init(allocator);
    const duration_us = profile.chrome.endTime -| profile.chrome.startTime;
    try output.print(
        "# CPU Profile\n\n| Duration | Samples | Interval | Functions |\n|----------|---------|----------|-----------|\n| {d:.3} ms | {d} | {d} us | {d} |\n\n",
        .{ @as(f64, @floatFromInt(duration_us)) / 1000.0, profile.chrome.samples.len, profile.interval_us, profile.mutable_nodes.len -| 1 },
    );

    try output.appendSlice("## Hot Functions (Self Time)\n\n| Function | Self Time | Samples |\n|----------|-----------|---------|\n");
    for (profile.mutable_nodes[1..]) |node| {
        if (node.hit_count == 0) continue;
        try output.print("| `{s}` | {d} us | {d} |\n", .{ node.call_frame.functionName, @as(u64, node.hit_count) * profile.interval_us, node.hit_count });
    }

    try output.appendSlice("\n## Call Tree (Total Time)\n\n| Function | Total Time | Samples |\n|----------|------------|---------|\n");
    for (profile.mutable_nodes[1..]) |node| {
        try output.print("| `{s}` | {d} us | {d} |\n", .{ node.call_frame.functionName, @as(u64, node.total_samples) * profile.interval_us, node.total_samples });
    }

    try output.appendSlice("\n## Function Details\n\n");
    for (profile.mutable_nodes[1..]) |node| {
        const parent = profile.mutable_nodes[node.parent_id - 1];
        try output.print("### `{s}`\n\n", .{node.call_frame.functionName});
        if (node.call_frame.url.len > 0) {
            try output.print("- **Location:** `{s}:{d}:{d}`\n", .{ node.call_frame.url, node.call_frame.lineNumber + 1, node.call_frame.columnNumber + 1 });
        }
        try output.print("- **Called by:** `{s}`\n", .{parent.call_frame.functionName});
        try output.appendSlice("- **Calls:** ");
        if (node.children.items.len == 0) {
            try output.appendSlice("None\n\n");
        } else {
            for (node.children.items, 0..) |child_id, index| {
                if (index > 0) try output.appendSlice(", ");
                try output.print("`{s}`", .{profile.mutable_nodes[child_id - 1].call_frame.functionName});
            }
            try output.appendSlice("\n\n");
        }
    }

    try output.appendSlice("## Files\n\n");
    var files: std.StringHashMapUnmanaged(void) = .empty;
    for (profile.mutable_nodes[1..]) |node| {
        const url = node.call_frame.url;
        if (url.len == 0 or files.contains(url)) continue;
        try files.put(allocator, url, {});
        try output.print("- `{s}`\n", .{url});
    }
    return output.items;
}

fn profileProcessId() u32 {
    return if (builtin.os.tag == .windows)
        std.os.windows.GetCurrentProcessId()
    else
        @intCast(std.c.getpid());
}

fn cpuProfileDefaultName(
    io: std.Io,
    allocator: std.mem.Allocator,
    markdown: bool,
) ![]const u8 {
    const now_ns = std.Io.Clock.real.now(io).nanoseconds;
    const timestamp_us: u64 = @intCast(@max(0, @divTrunc(now_ns, 1000)));
    const extension = if (markdown) "md" else "cpuprofile";
    return try std.fmt.allocPrint(allocator, "CPU.{d}.{d}.{s}", .{ timestamp_us, profileProcessId(), extension });
}

fn cpuProfilePath(
    io: std.Io,
    allocator: std.mem.Allocator,
    options: CpuProfileOptions,
    markdown: bool,
) ![]const u8 {
    const name = name: {
        if (options.name) |configured| {
            if (configured.len > 0) {
                if (options.json and options.markdown) {
                    const extension = if (markdown) ".md" else ".cpuprofile";
                    break :name try std.fmt.allocPrint(allocator, "{s}{s}", .{ configured, extension });
                }
                break :name configured;
            }
        }
        break :name try cpuProfileDefaultName(io, allocator, markdown);
    };
    if (options.dir) |dir| {
        if (dir.len > 0) return try std.fs.path.join(allocator, &.{ dir, name });
    }
    return name;
}

fn writeCpuProfiles(execution: *ScriptExecution, options: CpuProfileOptions, raw_profile: []const u8) !void {
    const profile = try buildCpuProfile(execution.io, execution.allocator, raw_profile, options.interval_us);
    if (options.dir) |dir| {
        if (dir.len > 0) try std.Io.Dir.cwd().createDirPath(execution.io, dir);
    }

    if (options.json) {
        const path = try cpuProfilePath(execution.io, execution.allocator, options, false);
        const json = try std.json.Stringify.valueAlloc(execution.allocator, profile.chrome, .{});
        try std.Io.Dir.cwd().writeFile(execution.io, .{ .sub_path = path, .data = json });
    }
    if (options.markdown) {
        const path = try cpuProfilePath(execution.io, execution.allocator, options, true);
        const markdown = try cpuProfileMarkdown(execution.allocator, profile);
        try std.Io.Dir.cwd().writeFile(execution.io, .{ .sub_path = path, .data = markdown });
    }
}

fn writeStderr(io: std.Io, comptime fmt: []const u8, args: anytype) void {
    var buffer: [2048]u8 = undefined;
    var writer = std.Io.File.stderr().writer(io, &buffer);
    const stderr = &writer.interface;
    stderr.print(fmt, args) catch {};
    stderr.flush() catch {};
}

fn isTypescriptPath(path: []const u8) bool {
    return std.mem.endsWith(u8, path, ".ts") or
        std.mem.endsWith(u8, path, ".tsx") or
        std.mem.endsWith(u8, path, ".mts") or
        std.mem.endsWith(u8, path, ".cts");
}

fn rejectInvalidBunCjsPragma(ctx: *const Context, script_path: []const u8) !bool {
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        script_path,
        ctx.allocator,
        .limited(4 * 1024 * 1024),
    ) catch return false;
    const line_end = std.mem.indexOfScalar(u8, source, '\n') orelse source.len;
    const first_line = source[0..line_end];
    if (!std.mem.startsWith(u8, first_line, "//") or std.mem.indexOf(u8, first_line, "@bun-cjs") == null) return false;

    const remainder = std.mem.trimStart(u8, source[line_end..], " \t\r\n");
    if (std.mem.startsWith(u8, remainder, "(function")) return false;

    ctx.writeStderr("error: Expected CommonJS module to have a function wrapper. This usually means the file was not generated by Bun.\n", .{});
    return true;
}

const NodeRuntimeAlias = struct {
    specifier: []const u8,
    relative_path: []const u8,
};

const node_runtime_aliases = [_]NodeRuntimeAlias{
    .{ .specifier = "fs", .relative_path = "node/fs.js" },
    .{ .specifier = "fs/promises", .relative_path = "node/fs/promises.js" },
    .{ .specifier = "os", .relative_path = "node/os.js" },
    .{ .specifier = "path", .relative_path = "node/path.js" },
    .{ .specifier = "path/posix", .relative_path = "node/path/posix.cjs" },
    .{ .specifier = "path/win32", .relative_path = "node/path/win32.cjs" },
    .{ .specifier = "process", .relative_path = "node/process.js" },
    .{ .specifier = "readline", .relative_path = "node/readline.js" },
    .{ .specifier = "readline/promises", .relative_path = "node/readline/promises.js" },
    .{ .specifier = "util", .relative_path = "node/util.js" },
    .{ .specifier = "util/types", .relative_path = "node/util/types.js" },
    .{ .specifier = "events", .relative_path = "node/events.cjs" },
    .{ .specifier = "async_hooks", .relative_path = "node/async_hooks.js" },
    .{ .specifier = "assert", .relative_path = "node/assert.cjs" },
    .{ .specifier = "assert/strict", .relative_path = "node/assert/strict.js" },
    .{ .specifier = "console", .relative_path = "node/console.js" },
    .{ .specifier = "diagnostics_channel", .relative_path = "node/diagnostics_channel.js" },
    .{ .specifier = "domain", .relative_path = "node/domain.js" },
    .{ .specifier = "sys", .relative_path = "node/sys.js" },
    .{ .specifier = "repl", .relative_path = "node/repl.js" },
    .{ .specifier = "sea", .relative_path = "node/sea.js" },
    .{ .specifier = "sqlite", .relative_path = "node/sqlite.js" },
    .{ .specifier = "test", .relative_path = "node/test.js" },
    .{ .specifier = "test/reporters", .relative_path = "node/test/reporters.js" },
    .{ .specifier = "tty", .relative_path = "node/tty.js" },
    .{ .specifier = "v8", .relative_path = "node/v8.js" },
    .{ .specifier = "stream", .relative_path = "node/stream.cjs" },
    .{ .specifier = "stream/consumers", .relative_path = "node/stream/consumers.js" },
    .{ .specifier = "stream/promises", .relative_path = "node/stream/promises.js" },
    .{ .specifier = "stream/web", .relative_path = "node/stream/web.js" },
    .{ .specifier = "perf_hooks", .relative_path = "node/perf_hooks.js" },
    .{ .specifier = "vm", .relative_path = "node/vm.js" },
    .{ .specifier = "module", .relative_path = "node/module.js" },
    .{ .specifier = "net", .relative_path = "node/net.js" },
    .{ .specifier = "url", .relative_path = "node/url.js" },
    .{ .specifier = "constants", .relative_path = "node/constants.js" },
    .{ .specifier = "crypto", .relative_path = "node/crypto.js" },
    .{ .specifier = "buffer", .relative_path = "node/buffer.js" },
    .{ .specifier = "cluster", .relative_path = "node/cluster.js" },
    .{ .specifier = "punycode", .relative_path = "node/punycode.js" },
    .{ .specifier = "querystring", .relative_path = "node/querystring.js" },
    .{ .specifier = "child_process", .relative_path = "node/child_process.js" },
    .{ .specifier = "string_decoder", .relative_path = "node/string_decoder.js" },
    .{ .specifier = "timers", .relative_path = "node/timers.js" },
    .{ .specifier = "timers/promises", .relative_path = "node/timers/promises.js" },
    .{ .specifier = "trace_events", .relative_path = "node/trace_events.js" },
    .{ .specifier = "wasi", .relative_path = "node/wasi.js" },
    .{ .specifier = "worker_threads", .relative_path = "node/worker_threads.js" },
    .{ .specifier = "zlib", .relative_path = "node/zlib.js" },
    .{ .specifier = "http", .relative_path = "node/http.js" },
    .{ .specifier = "https", .relative_path = "node/https.js" },
    .{ .specifier = "http2", .relative_path = "node/http2.js" },
    .{ .specifier = "inspector", .relative_path = "node/inspector.js" },
    .{ .specifier = "inspector/promises", .relative_path = "node/inspector/promises.js" },
    .{ .specifier = "dgram", .relative_path = "node/dgram.js" },
    .{ .specifier = "dns", .relative_path = "node/dns.js" },
    .{ .specifier = "dns/promises", .relative_path = "node/dns/promises.js" },
    .{ .specifier = "tls", .relative_path = "node/tls.js" },
};

const reusable_runtime_bundle_root = if (builtin.os.tag == .windows) "C:\\" else "/";

fn runtimeModuleRelativePath(
    ctx: *const Context,
    runtime_virtual_root: []const u8,
    relative_path: []const u8,
) ![]const u8 {
    return embedded_runtime_modules.virtualPath(ctx.allocator, runtime_virtual_root, relative_path);
}

fn appendRuntimeAlias(
    ctx: *const Context,
    aliases: *std.ArrayList(native_bundler.RuntimeAlias),
    runtime_virtual_root: []const u8,
    specifier: []const u8,
    relative_path: []const u8,
) !void {
    try aliases.append(ctx.allocator, .{
        .specifier = specifier,
        .path = try runtimeModuleRelativePath(ctx, runtime_virtual_root, relative_path),
    });
}

fn buildRuntimeAliases(
    ctx: *const Context,
    runtime_virtual_root: []const u8,
) ![]const native_bundler.RuntimeAlias {
    var aliases: std.ArrayList(native_bundler.RuntimeAlias) = .empty;
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "bun", "bun/index.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "bun:ffi", "bun/ffi.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "bun:jsc", "bun/jsc.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "bun:sqlite", "bun/sqlite.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "bun:test", "bun/test.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "bun:internal-for-testing", "bun/internal-for-testing.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "bun:wrap", "bun/wrap.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "vitest", "bun/test.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "string-width", "bun/string-width.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "strip-ansi", "bun/strip-ansi.js");
    // Bun ships built-in overrides for these npm packages.
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "node-fetch", "bun/node-fetch.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "next/dist/compiled/node-fetch", "bun/node-fetch.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "isomorphic-fetch", "vendor/isomorphic-fetch.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "@vercel/fetch", "vendor/vercel-fetch.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "abort-controller", "vendor/abort-controller.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "utf-8-validate", "bun/utf-8-validate.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "ws", "vendor/ws.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "ws/lib/websocket", "vendor/ws.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "next/dist/compiled/ws", "vendor/ws.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "undici", "node/undici-public.js");
    try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, "node:undici", "node/undici-public.js");

    for (node_runtime_aliases) |alias| {
        try appendRuntimeAlias(ctx, &aliases, runtime_virtual_root, alias.specifier, alias.relative_path);
        try appendRuntimeAlias(
            ctx,
            &aliases,
            runtime_virtual_root,
            try std.fmt.allocPrint(ctx.allocator, "node:{s}", .{alias.specifier}),
            alias.relative_path,
        );
    }
    return aliases.toOwnedSlice(ctx.allocator);
}

fn isRuntimeAliasSpecifier(specifier: []const u8) bool {
    const bare = if (std.mem.startsWith(u8, specifier, "node:")) specifier["node:".len..] else specifier;
    for (node_runtime_aliases) |alias| {
        if (std.mem.eql(u8, bare, alias.specifier)) return true;
    }
    return std.mem.eql(u8, specifier, "bun") or
        std.mem.eql(u8, specifier, "bun:ffi") or
        std.mem.eql(u8, specifier, "bun:jsc") or
        std.mem.eql(u8, specifier, "bun:sqlite") or
        std.mem.eql(u8, specifier, "bun:test") or
        std.mem.eql(u8, specifier, "bun:internal-for-testing") or
        std.mem.eql(u8, specifier, "bun:wrap") or
        std.mem.eql(u8, specifier, "vitest") or
        std.mem.eql(u8, specifier, "string-width") or
        std.mem.eql(u8, specifier, "strip-ansi") or
        std.mem.eql(u8, specifier, "node-fetch") or
        std.mem.eql(u8, specifier, "next/dist/compiled/node-fetch") or
        std.mem.eql(u8, specifier, "isomorphic-fetch") or
        std.mem.eql(u8, specifier, "@vercel/fetch") or
        std.mem.eql(u8, specifier, "abort-controller") or
        std.mem.eql(u8, specifier, "utf-8-validate") or
        std.mem.eql(u8, specifier, "ws") or
        std.mem.eql(u8, specifier, "ws/lib/websocket") or
        std.mem.eql(u8, specifier, "next/dist/compiled/ws") or
        std.mem.eql(u8, specifier, "undici") or
        std.mem.eql(u8, specifier, "node:undici");
}

fn isMinimalRuntimeAliasSpecifier(specifier: []const u8) bool {
    const bare = if (std.mem.startsWith(u8, specifier, "node:")) specifier["node:".len..] else specifier;
    for (node_runtime_aliases) |alias| {
        if (std.mem.eql(u8, bare, alias.specifier)) return true;
    }
    return false;
}

fn transpilerLoaderForPath(path: []const u8) ?[]const u8 {
    const extension = std.fs.path.extension(path);
    if (std.mem.eql(u8, extension, ".js") or
        std.mem.eql(u8, extension, ".mjs") or
        std.mem.eql(u8, extension, ".cjs")) return "js";
    if (std.mem.eql(u8, extension, ".jsx")) return "jsx";
    if (std.mem.eql(u8, extension, ".ts") or
        std.mem.eql(u8, extension, ".mts") or
        std.mem.eql(u8, extension, ".cts")) return "ts";
    if (std.mem.eql(u8, extension, ".tsx")) return "tsx";
    return null;
}

fn entrypointImportsOnlyRuntimeAliases(ctx: *const Context, path: []const u8) !bool {
    const loader = transpilerLoaderForPath(path) orelse return false;
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        path,
        ctx.allocator,
        .limited(4 * 1024 * 1024),
    ) catch return false;
    const imports_json = native_transpiler.scanImportsJson(source, loader) catch return false;
    defer std.heap.c_allocator.free(imports_json);

    const ScannedImport = struct {
        path: []const u8,
        kind: []const u8,
    };
    const parsed = std.json.parseFromSlice([]const ScannedImport, ctx.allocator, imports_json, .{}) catch return false;
    defer parsed.deinit();
    for (parsed.value) |item| {
        if (!std.mem.eql(u8, item.kind, "import-statement") or
            item.path.len == 0 or
            !isMinimalRuntimeAliasSpecifier(item.path)) return false;
    }
    return true;
}

fn minimalRuntimeBunProperty(name: []const u8) bool {
    return std.mem.eql(u8, name, "argv") or
        std.mem.eql(u8, name, "cwd") or
        std.mem.eql(u8, name, "env") or
        std.mem.eql(u8, name, "fileURLToPath") or
        std.mem.eql(u8, name, "gc") or
        std.mem.eql(u8, name, "isMainThread") or
        std.mem.eql(u8, name, "main") or
        std.mem.eql(u8, name, "nanoseconds") or
        std.mem.eql(u8, name, "pathToFileURL") or
        std.mem.eql(u8, name, "revision") or
        std.mem.eql(u8, name, "sleep") or
        std.mem.eql(u8, name, "sleepSync") or
        std.mem.eql(u8, name, "version") or
        std.mem.eql(u8, name, "version_with_sha");
}

fn minimalRuntimeProcessProperty(name: []const u8) bool {
    return std.mem.eql(u8, name, "arch") or
        std.mem.eql(u8, name, "argv") or
        std.mem.eql(u8, name, "argv0") or
        std.mem.eql(u8, name, "browser") or
        std.mem.eql(u8, name, "chdir") or
        std.mem.eql(u8, name, "cwd") or
        std.mem.eql(u8, name, "env") or
        std.mem.eql(u8, name, "execArgv") or
        std.mem.eql(u8, name, "execPath") or
        std.mem.eql(u8, name, "exit") or
        std.mem.eql(u8, name, "exitCode") or
        std.mem.eql(u8, name, "hrtime") or
        std.mem.eql(u8, name, "isBun") or
        std.mem.eql(u8, name, "memoryUsage") or
        std.mem.eql(u8, name, "nextTick") or
        std.mem.eql(u8, name, "pid") or
        std.mem.eql(u8, name, "platform") or
        std.mem.eql(u8, name, "ppid") or
        std.mem.eql(u8, name, "reallyExit") or
        std.mem.eql(u8, name, "release") or
        std.mem.eql(u8, name, "revision") or
        std.mem.eql(u8, name, "stderr") or
        std.mem.eql(u8, name, "stdout") or
        std.mem.eql(u8, name, "title") or
        std.mem.eql(u8, name, "uptime") or
        std.mem.eql(u8, name, "version") or
        std.mem.eql(u8, name, "versions");
}

fn fullRuntimeGlobal(name: []const u8) bool {
    for ([_][]const u8{
        "AbortController",
        "AbortSignal",
        "BroadcastChannel",
        "CloseEvent",
        "CompressionStream",
        "Crypto",
        "CryptoKey",
        "CustomEvent",
        "DecompressionStream",
        "ErrorEvent",
        "Event",
        "EventTarget",
        "FormData",
        "Headers",
        "HTMLRewriter",
        "MessageChannel",
        "MessageEvent",
        "MessagePort",
        "Performance",
        "PerformanceEntry",
        "PerformanceMark",
        "PerformanceMeasure",
        "PerformanceObserver",
        "Request",
        "Response",
        "SubtleCrypto",
        "WebSocket",
        "afterAll",
        "afterEach",
        "beforeAll",
        "beforeEach",
        "crypto",
        "describe",
        "expect",
        "expectTypeOf",
        "fetch",
        "it",
        "navigator",
        "performance",
        "require",
        "reportError",
        "structuredClone",
        "test",
        "xdescribe",
        "xit",
        "xtest",
    }) |global_name| {
        if (std.mem.eql(u8, name, global_name)) return true;
    }
    return false;
}

fn runtimeMemberProperty(tokens: []const JavaScriptModuleToken, index: usize) ?[]const u8 {
    var property_index = index + 1;
    if (property_index < tokens.len and tokenIs(tokens[property_index], .punct, "?")) property_index += 1;
    if (property_index >= tokens.len or !tokenIs(tokens[property_index], .punct, ".")) return null;
    property_index += 1;
    if (property_index >= tokens.len or tokens[property_index].kind != .identifier) return null;
    return tokens[property_index].text;
}

const RuntimeBootstrapMode = enum {
    full,
    minimal,
    process,
};

fn entrypointRuntimeBootstrapMode(ctx: *const Context, path: []const u8) !RuntimeBootstrapMode {
    if (!try entrypointImportsOnlyRuntimeAliases(ctx, path)) return .full;
    return sourceRuntimeBootstrapMode(ctx, path);
}

fn sourceRuntimeBootstrapMode(ctx: *const Context, path: []const u8) !RuntimeBootstrapMode {
    const loader = transpilerLoaderForPath(path) orelse return .full;
    _ = loader;
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        path,
        ctx.allocator,
        .limited(16 * 1024 * 1024),
    ) catch return .full;
    const tokens = try tokenizeJavaScriptModuleSyntax(ctx.allocator, source);

    var mode: RuntimeBootstrapMode = .minimal;
    var index: usize = 0;
    while (index < tokens.len) : (index += 1) {
        const token = tokens[index];
        if (tokenIs(token, .identifier, "export") and
            index + 1 < tokens.len and
            tokenIs(tokens[index + 1], .identifier, "default")) return .full;
        if (token.kind != .identifier) continue;
        if (std.mem.eql(u8, token.text, "Bun")) {
            const property = runtimeMemberProperty(tokens, index) orelse return .full;
            if (!minimalRuntimeBunProperty(property)) return .full;
        } else if (std.mem.eql(u8, token.text, "process")) {
            const property = runtimeMemberProperty(tokens, index) orelse return .full;
            if (std.mem.eql(u8, property, "mainModule")) return .full;
            if (!minimalRuntimeProcessProperty(property)) mode = .process;
        } else if (std.mem.eql(u8, token.text, "Error")) {
            if (runtimeMemberProperty(tokens, index)) |property| {
                if (std.mem.eql(u8, property, "captureStackTrace") or
                    std.mem.eql(u8, property, "prepareStackTrace") or
                    std.mem.eql(u8, property, "stackTraceLimit")) return .full;
            }
        } else if (fullRuntimeGlobal(token.text)) {
            return .full;
        }
    }
    return mode;
}

const ReloadRuntimeImport = union(enum) {
    script: []const u8,
    asset,
};

fn resolveReloadRuntimeImport(
    ctx: *const Context,
    importer: []const u8,
    specifier: []const u8,
) !?ReloadRuntimeImport {
    if (!std.fs.path.isAbsolute(specifier) and !std.mem.startsWith(u8, specifier, ".")) return null;
    const importer_dir = std.fs.path.dirname(importer) orelse ctx.project_root;
    const base = if (std.fs.path.isAbsolute(specifier))
        specifier
    else
        try std.fs.path.resolve(ctx.allocator, &.{ importer_dir, specifier });

    if (pathExists(ctx.io, base)) {
        if (transpilerLoaderForPath(base) != null) return .{ .script = base };
        return .asset;
    }

    const extension = std.fs.path.extension(base);
    const suffixes: []const []const u8 = if (extension.len == 0)
        &.{ ".js", ".jsx", ".ts", ".tsx", ".mjs", ".mts", ".cjs", ".cts", ".json", ".css" }
    else if (std.mem.eql(u8, extension, ".js") or std.mem.eql(u8, extension, ".jsx"))
        &.{ ".ts", ".tsx", ".mts" }
    else if (std.mem.eql(u8, extension, ".mjs"))
        &.{".mts"}
    else
        &.{};
    const stem = base[0 .. base.len - extension.len];
    for (suffixes) |suffix| {
        const candidate = try std.mem.concat(ctx.allocator, u8, &.{ stem, suffix });
        if (!pathExists(ctx.io, candidate)) continue;
        if (transpilerLoaderForPath(candidate) != null) return .{ .script = candidate };
        return .asset;
    }

    for ([_][]const u8{ "index.js", "index.jsx", "index.ts", "index.tsx", "index.mjs", "index.mts", "index.cjs", "index.cts", "index.json" }) |name| {
        const candidate = try std.fs.path.join(ctx.allocator, &.{ base, name });
        if (!pathExists(ctx.io, candidate)) continue;
        if (transpilerLoaderForPath(candidate) != null) return .{ .script = candidate };
        return .asset;
    }
    return null;
}

fn mergeRuntimeBootstrapMode(left: RuntimeBootstrapMode, right: RuntimeBootstrapMode) RuntimeBootstrapMode {
    if (left == .full or right == .full) return .full;
    if (left == .process or right == .process) return .process;
    return .minimal;
}

fn reloadRuntimeBootstrapModeVisit(
    ctx: *const Context,
    path: []const u8,
    visited: *std.StringHashMapUnmanaged(void),
) !RuntimeBootstrapMode {
    const canonical = resolvePathForCwd(ctx.io, ctx.allocator, path) catch path;
    if (visited.contains(canonical)) return .minimal;
    try visited.put(ctx.allocator, canonical, {});

    var mode = try sourceRuntimeBootstrapMode(ctx, canonical);
    if (mode == .full) return .full;
    const loader = transpilerLoaderForPath(canonical) orelse return .full;
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        canonical,
        ctx.allocator,
        .limited(4 * 1024 * 1024),
    ) catch return .full;
    const imports_json = native_transpiler.scanImportsJson(source, loader) catch return .full;
    defer std.heap.c_allocator.free(imports_json);
    const ScannedImport = struct {
        path: []const u8,
        kind: []const u8,
    };
    const parsed = std.json.parseFromSlice([]const ScannedImport, ctx.allocator, imports_json, .{}) catch return .full;
    defer parsed.deinit();

    for (parsed.value) |item| {
        if (!std.mem.eql(u8, item.kind, "import-statement") or item.path.len == 0) return .full;
        if (isMinimalRuntimeAliasSpecifier(item.path)) continue;
        const resolved = try resolveReloadRuntimeImport(ctx, canonical, item.path) orelse return .full;
        switch (resolved) {
            .asset => {},
            .script => |dependency| {
                mode = mergeRuntimeBootstrapMode(mode, try reloadRuntimeBootstrapModeVisit(ctx, dependency, visited));
                if (mode == .full) return .full;
            },
        }
    }
    return mode;
}

fn reloadRuntimeBootstrapMode(ctx: *const Context, path: []const u8) !RuntimeBootstrapMode {
    var visited: std.StringHashMapUnmanaged(void) = .empty;
    return reloadRuntimeBootstrapModeVisit(ctx, path, &visited);
}

fn nativeBundleFailure(
    ctx: *const Context,
    script_abs: []const u8,
    script_entry_abs: []const u8,
    tmp_dir: []const u8,
    runtime_execution: bool,
    recoverable: bool,
    error_message: ?[*:0]u8,
    err: anyerror,
) anyerror {
    if (error_message) |message| {
        defer native_bundler.ct_bundle_string_free(message);
        const text = decodeBundleDiagnostic(ctx, std.mem.span(message));
        if (ctx.environ_map.get("COTTONTAIL_TEST_CLI_HEADER_PRINTED") != null) {
            const display_text = if (runtime_execution)
                (runtimeLinkDiagnostic(ctx, script_abs, script_entry_abs, text) catch null) orelse text
            else
                text;
            reportTestBundleError(ctx, script_abs, display_text);
            cleanupGeneratedSource(ctx, script_entry_abs, script_abs);
            std.Io.Dir.cwd().deleteTree(ctx.io, tmp_dir) catch {};
            return error.TestBundleFailed;
        }
        const display_text = if (runtime_execution)
            (runtimeLinkDiagnostic(ctx, script_abs, script_entry_abs, text) catch null) orelse text
        else
            text;
        if (std.mem.startsWith(u8, display_text, "error:") or
            std.mem.startsWith(u8, display_text, "SyntaxError:"))
        {
            ctx.writeStderr("{s}\n", .{display_text});
        } else {
            ctx.writeStderr("error: {s}\n", .{display_text});
        }
        // Resolution and parse diagnostics are complete at this point. Avoid
        // adding a Zig error-return trace to an ordinary JavaScript failure.
        cleanupGeneratedSource(ctx, script_entry_abs, script_abs);
        std.Io.Dir.cwd().deleteTree(ctx.io, tmp_dir) catch {};
        if (ctx.stderr_capture != null) return error.NativeBundleFailed;
        if (recoverable) return error.ReloadBundleFailed;
        std.process.exit(1);
    }
    ctx.writeStderr("cottontail: native bundle failed: {s}\n", .{@errorName(err)});
    return error.NativeBundleFailed;
}

fn decodeBundleDiagnostic(ctx: *const Context, wire: []const u8) []const u8 {
    if (!std.mem.startsWith(u8, wire, native_bundler.binary_diagnostic_prefix)) return wire;
    const encoded = wire[native_bundler.binary_diagnostic_prefix.len..];
    const decoded_len = std.base64.standard.Decoder.calcSizeForSlice(encoded) catch return wire;
    const decoded = ctx.allocator.alloc(u8, decoded_len) catch return wire;
    std.base64.standard.Decoder.decode(decoded, encoded) catch return wire;
    return decoded;
}

const runtime_native_addon_public_path = "/__cottontail_native_addons__/";

fn isRuntimeNativeAddonOutput(file: *const native_bundler.GraphOutputFile) bool {
    return file.kind == .asset and
        (file.loader == .napi or
            std.mem.endsWith(u8, file.path, ".node") or
            std.mem.endsWith(u8, file.source_path, ".node"));
}

const RuntimeNativeAddons = struct {
    code: []const u8,
};

fn rewriteRuntimeNativeAddonReference(
    ctx: *const Context,
    code: []const u8,
    public_path: []const u8,
    output_name: []const u8,
    source_path: []const u8,
) ![]const u8 {
    const source_absolute = try resolvePathForCwd(ctx.io, ctx.allocator, source_path);
    const destination = try std.mem.replaceOwned(u8, ctx.allocator, source_absolute, "\\", "/");
    var rewritten = code;
    var found = false;
    var search_from: usize = 0;

    while (std.mem.indexOfPos(u8, rewritten, search_from, public_path)) |path_start| {
        const path_end = std.mem.indexOfScalarPos(u8, rewritten, path_start, '"') orelse
            return error.InvalidNativeAddonReference;
        const specifier = rewritten[path_start..path_end];
        search_from = path_end + 1;
        if (!std.mem.endsWith(u8, specifier, output_name)) continue;

        found = true;
        if (std.mem.eql(u8, specifier, destination)) continue;
        rewritten = try std.mem.replaceOwned(u8, ctx.allocator, rewritten, specifier, destination);
        search_from = path_start + destination.len;
    }
    if (!found) return error.MissingNativeAddonReference;
    return rewritten;
}

fn prepareRuntimeNativeAddons(
    ctx: *const Context,
    public_path: []const u8,
    code: []const u8,
    files: []const native_bundler.GraphOutputFile,
) !RuntimeNativeAddons {
    var result: RuntimeNativeAddons = .{ .code = code };
    for (files) |*file| {
        if (!isRuntimeNativeAddonOutput(file)) continue;

        const name = std.fs.path.basename(file.path);
        if (name.len == 0 or !std.mem.endsWith(u8, name, ".node")) {
            return error.InvalidNativeAddonOutputPath;
        }
        if (file.source_path.len == 0) return error.MissingNativeAddonSourcePath;
        result.code = try rewriteRuntimeNativeAddonReference(
            ctx,
            result.code,
            public_path,
            name,
            file.source_path,
        );
    }
    return result;
}

const RuntimeModuleLaunchRequirements = struct {
    has_source_base_dir: bool = false,
    has_build_options: bool = false,
    has_graph_output: bool = false,
    standalone_compile: bool = false,
    tracks_reload_dependencies: bool = false,
    test_cli_execution: bool = false,
    wasm_entrypoint: bool = false,
};

fn canUseRuntimeModuleLauncher(requirements: RuntimeModuleLaunchRequirements) bool {
    return !requirements.has_source_base_dir and
        !requirements.has_build_options and
        !requirements.has_graph_output and
        !requirements.standalone_compile and
        !requirements.tracks_reload_dependencies and
        !requirements.test_cli_execution and
        !requirements.wasm_entrypoint;
}

fn bundleScriptNative(
    ctx: *const Context,
    script_path: []const u8,
    exec_args: []const [:0]const u8,
    script_args: []const [:0]const u8,
    source_base_dir: ?[]const u8,
    build_options: ?native_bundler.BundleOptions,
    graph_out: ?*native_bundler.BundleGraphOutput,
    standalone_compile: bool,
    reload_dependencies_out: ?*[]const [:0]const u8,
    reuse_reload_runtime: bool,
) !RuntimeArtifact {
    if (reload_dependencies_out) |dependencies| dependencies.* = &.{};
    const tmp_dir = try ensureTempDir(ctx);
    errdefer std.Io.Dir.cwd().deleteTree(ctx.io, tmp_dir) catch {};

    const script_abs = try resolvePathForCwd(ctx.io, ctx.allocator, script_path);
    const script_dir = std.fs.path.dirname(script_abs) orelse ctx.project_root;
    const is_test_cli_execution = ctx.environ_map.get("COTTONTAIL_TEST_CLI_HEADER_PRINTED") != null;
    const is_test_runtime_execution = is_test_cli_execution or
        ctx.environ_map.get("COTTONTAIL_TEST_FILE_COUNT") != null or
        isTestEntrypointPath(script_abs);
    var package_json_patch = try maybePatchEmptyPackageJsonForBundle(ctx, script_dir);
    defer restoreEmptyMetadataPatch(ctx, &package_json_patch);

    const is_wasm_entrypoint = std.mem.eql(u8, std.fs.path.extension(script_abs), ".wasm");
    const runtime_module_launcher_candidate = canUseRuntimeModuleLauncher(.{
        .has_source_base_dir = source_base_dir != null,
        .has_build_options = build_options != null,
        .has_graph_output = graph_out != null,
        .standalone_compile = standalone_compile,
        .tracks_reload_dependencies = reload_dependencies_out != null,
        .test_cli_execution = is_test_runtime_execution,
        .wasm_entrypoint = is_wasm_entrypoint,
    });
    // CommonJS already has a runtime-only Module.runMain() launcher. Route
    // ordinary ESM through the same on-demand module system without changing
    // the compatibility transforms used by CommonJS and test entry points.
    const runtime_candidate_is_common_js = if (runtime_module_launcher_candidate)
        try shouldBundleCommonJsEntrypoint(ctx, script_abs)
    else
        false;
    const runtime_module_entrypoint = runtime_module_launcher_candidate and !runtime_candidate_is_common_js;
    const script_entry_abs = if (is_wasm_entrypoint or runtime_module_entrypoint)
        script_abs
    else
        try writeBunCompatTransformedSource(ctx, script_abs, source_base_dir, standalone_compile);
    defer cleanupGeneratedSource(ctx, script_entry_abs, script_abs);
    const script_identity_abs = if (is_wasm_entrypoint)
        script_abs
    else
        try runtimeEntrypointIdentity(ctx, script_entry_abs, script_abs);

    const bunfig_preload_imports = if (standalone_compile)
        ""
    else
        try buildBunfigTestPreloadImports(
            ctx,
            script_abs,
            is_test_cli_execution,
            exec_args,
            script_args,
        );
    const startup_options = try cli_run_execution.StartupOptions.parse(ctx.allocator, exec_args);
    const sql_module_path = if (startup_options.sql_preconnect)
        try runtimeModulePath(ctx, &.{ "bun", "sql.js" })
    else
        null;
    var cli_startup_imports: std.ArrayList(u8) = .empty;
    try startup_options.appendSource(ctx.allocator, &cli_startup_imports, sql_module_path);
    const cli_preload_imports = try buildCliPreloadImports(ctx, script_abs, exec_args, true);
    const test_preload_imports = if (is_test_cli_execution)
        try buildCliPreloadImports(ctx, script_abs, script_args, false)
    else
        "";
    const preload_imports = try std.mem.concat(ctx.allocator, u8, &.{ bunfig_preload_imports, cli_startup_imports.items, cli_preload_imports, test_preload_imports });
    const requires_full_runtime_preloads = bunfig_preload_imports.len > 0 or
        cli_preload_imports.len > 0 or
        test_preload_imports.len > 0 or
        startup_options.requiresFullRuntime();
    const runtime_transpiler_cache_enabled = cli_run_execution.runtimeTranspilerCacheEnabled(ctx.environ_map);
    const runtime_cache_common_js_entrypoint = if (!runtime_module_entrypoint and
        runtime_transpiler_cache_enabled and
        !is_wasm_entrypoint)
        try runtimeCacheCanUseCommonJsLoader(ctx, script_abs)
    else
        false;
    const detected_common_js_entrypoint = if (is_wasm_entrypoint or runtime_module_entrypoint)
        false
    else
        try shouldBundleCommonJsEntrypoint(ctx, script_entry_abs);
    const is_common_js_entrypoint = detected_common_js_entrypoint or runtime_cache_common_js_entrypoint;
    if (is_common_js_entrypoint) try validateCommonJsTestSyntax(ctx, script_entry_abs);
    const runtime_bootstrap_mode: RuntimeBootstrapMode = if (!runtime_module_entrypoint and
        !runtime_cache_common_js_entrypoint and
        !standalone_compile and
        build_options == null and
        !requires_full_runtime_preloads and
        !is_wasm_entrypoint)
        if (reload_dependencies_out != null)
            try reloadRuntimeBootstrapMode(ctx, script_entry_abs)
        else
            try entrypointRuntimeBootstrapMode(ctx, script_entry_abs)
    else
        .full;
    const use_selective_runtime = runtime_bootstrap_mode != .full;
    // COTTONTAIL-COMPAT: Hot mode keeps one JSC runtime alive. Once its minimal
    // bootstrap has run, later generations only need to evaluate the entry.
    const reuse_minimal_reload_runtime = reuse_reload_runtime and
        runtime_bootstrap_mode == .minimal and
        !is_common_js_entrypoint and
        !is_wasm_entrypoint;
    const has_custom_conditions = hasCustomConditions(exec_args) or hasCustomConditions(script_args);
    const tsconfig_override = (try tsconfigOverridePath(ctx, exec_args)) orelse
        try tsconfigOverridePath(ctx, script_args);
    var features: std.ArrayList([]const u8) = .empty;
    if (build_options) |provided| try features.appendSlice(ctx.allocator, provided.features);
    try collectFeatures(ctx.allocator, &features, exec_args);
    try collectFeatures(ctx.allocator, &features, script_args);
    const ignore_dce_annotations = for (exec_args) |arg| {
        if (std.mem.eql(u8, arg, "--ignore-dce-annotations")) break true;
    } else false;
    const plain_launcher_cacheable = preload_imports.len == 0 and
        build_options == null and
        !has_custom_conditions and
        !ignore_dce_annotations and
        reload_dependencies_out == null and
        features.items.len == 0 and
        tsconfig_override == null and
        !package_json_patch.active and
        ctx.environ_map.get("COTTONTAIL_RUNTIME_MODULES_DIR") == null and
        ctx.environ_map.get("COTTONTAIL_KEEP_TEMP") == null and
        !is_test_cli_execution;
    // Standalone executables cannot fall back to Module.runMain() loading the
    // original entrypoint from disk. Make the CommonJS entry an explicit
    // graph edge whenever build options are present so its source and
    // transitive dependencies are embedded in the generated bundle.
    const bundle_common_js_entrypoint = is_common_js_entrypoint and
        (has_custom_conditions or build_options != null or use_selective_runtime or reload_dependencies_out != null);
    const runtime_only_launcher = runtime_module_entrypoint or
        (is_common_js_entrypoint and !bundle_common_js_entrypoint);
    const use_runtime_module_launcher_cache = runtime_module_entrypoint and plain_launcher_cacheable;
    const use_esm_bundle_cache = !runtime_module_entrypoint and
        !is_wasm_entrypoint and
        !is_common_js_entrypoint and
        plain_launcher_cacheable;
    const use_common_js_launcher_cache = !runtime_module_entrypoint and
        is_common_js_entrypoint and
        !bundle_common_js_entrypoint and
        plain_launcher_cacheable;
    const runtime_virtual_root = if (use_common_js_launcher_cache or use_runtime_module_launcher_cache)
        reusable_runtime_bundle_root
    else
        ctx.project_root;
    const wrapped_entry = if (reuse_minimal_reload_runtime)
        try writeReusedReloadEntryWrapper(
            ctx,
            tmp_dir,
            script_entry_abs,
            script_identity_abs,
            is_test_cli_execution,
        )
    else if (is_wasm_entrypoint)
        try writeWasiEntryWrapper(ctx, tmp_dir, script_abs)
    else if (runtime_module_entrypoint)
        try writeRuntimeEntryWrapper(
            ctx,
            tmp_dir,
            script_abs,
            script_abs,
            false,
            preload_imports,
            is_test_cli_execution,
            use_runtime_module_launcher_cache,
            runtime_virtual_root,
            runtime_bootstrap_mode,
            true,
        )
    else if (is_common_js_entrypoint)
        try writeRuntimeEntryWrapper(
            ctx,
            tmp_dir,
            script_entry_abs,
            script_identity_abs,
            bundle_common_js_entrypoint,
            preload_imports,
            is_test_cli_execution,
            use_common_js_launcher_cache,
            runtime_virtual_root,
            runtime_bootstrap_mode,
            false,
        )
    else
        try writeCottontailEntryWrapper(
            ctx,
            tmp_dir,
            script_entry_abs,
            script_identity_abs,
            preload_imports,
            is_test_cli_execution,
            use_esm_bundle_cache,
            runtime_bootstrap_mode,
        );

    var conditions: std.ArrayList([]const u8) = .empty;
    try collectConditions(ctx.allocator, &conditions, exec_args);
    try collectConditions(ctx.allocator, &conditions, script_args);
    const aliases = try buildRuntimeAliases(ctx, runtime_virtual_root);
    const bundle_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "script.bundle.mjs" });

    var error_message: ?[*:0]u8 = null;
    var options = build_options orelse native_bundler.BundleOptions{};
    options.ignore_dce_annotations = options.ignore_dce_annotations or ignore_dce_annotations;
    if (build_options == null) {
        // The runtime-only artifact has no user graph to retain. Release the
        // compiler arena before on-demand modules start accumulating in JSC.
        options.skip_teardown = !runtime_only_launcher;
        options.externalize_runtime_require_resolve = true;
        // COTTONTAIL-COMPAT: Runtime HTML imports are lazy HTMLBundle values.
        // Bake owns the browser graph build so client errors remain recoverable.
        options.loader_extensions = &.{ ".html", ".htm" };
        options.loader_values = &.{ .file, .file };
        options.runtime_file_loader_paths = true;
    }
    options.aliases = aliases;
    options.conditions = conditions.items;
    options.node_path = ctx.environ_map.get("NODE_PATH");
    options.features = features.items;
    options.tsconfig_override = tsconfig_override;
    options.include_runtime_modules = true;
    options.runtime_virtual_root = runtime_virtual_root;
    options.preserve_external_require_name = true;
    options.rewrite_jest_for_tests = is_test_cli_execution;
    if (build_options == null) {
        options.code_coverage = testCoverageRequestedFromArgs(
            ctx.io,
            ctx.allocator,
            is_test_cli_execution,
            script_args,
        );
    }
    options.inline_import_meta_properties = true;
    if (build_options == null and graph_out == null) {
        // Runtime execution can load the original addon directly. A fixed
        // prefix makes the compiler-emitted asset reference unambiguous so it
        // can be replaced after the graph exposes the addon's source path.
        options.public_path = runtime_native_addon_public_path;
    }
    var runtime_define_keys: std.ArrayList([]const u8) = .empty;
    var runtime_define_values: std.ArrayList([]const u8) = .empty;
    try runtime_define_keys.appendSlice(ctx.allocator, options.define_keys);
    try runtime_define_values.appendSlice(ctx.allocator, options.define_values);
    for ([_]struct { key: []const u8, value: []const u8 }{
        .{ .key = "import.meta.resolveSync", .value = "globalThis.__ctMetaResolveSync" },
        .{ .key = "import.meta.resolve", .value = "globalThis.__ctMetaResolve" },
    }) |runtime_define| {
        for (runtime_define_keys.items) |key| {
            if (std.mem.eql(u8, key, runtime_define.key)) break;
        } else {
            try runtime_define_keys.append(ctx.allocator, runtime_define.key);
            try runtime_define_values.append(ctx.allocator, runtime_define.value);
        }
    }
    options.define_keys = runtime_define_keys.items;
    options.define_values = runtime_define_values.items;

    const launcher_cache_name: ?[]const u8 = if (use_runtime_module_launcher_cache)
        "module-runtime"
    else if (use_common_js_launcher_cache)
        "commonjs-runtime"
    else if (use_esm_bundle_cache)
        try std.fmt.allocPrint(ctx.allocator, "esm-entry-{x}", .{std.hash.Wyhash.hash(0, script_abs)})
    else
        null;
    // Runtime bundles advertise an adjacent source map to the JS stack
    // remapper. Cached maps move with their immutable generated artifact.
    if (build_options == null) {
        options.source_map = .external;
        // COTTONTAIL-COMPAT: Repeated hot maps should not copy a large entry
        // source that remains available at its stable on-disk identity.
        if (reload_dependencies_out != null and std.mem.eql(u8, script_entry_abs, script_identity_abs)) {
            options.source_map_exclude_sources_content = &.{script_abs};
        }
    }
    var launcher_cache = if (launcher_cache_name) |name|
        try acquireLauncherCache(
            ctx,
            wrapped_entry,
            name,
            use_common_js_launcher_cache or use_runtime_module_launcher_cache,
            if (use_esm_bundle_cache) script_entry_abs else null,
        )
    else
        null;
    defer if (launcher_cache) |*cache| cache.lock_file.close(ctx.io);
    if (launcher_cache) |cache| {
        if (try launcherCacheHit(ctx, &cache)) |cached_artifact| {
            std.Io.Dir.cwd().deleteTree(ctx.io, tmp_dir) catch {};
            return cached_artifact;
        }
    }

    const bundle_working_dir = if (use_common_js_launcher_cache or use_runtime_module_launcher_cache)
        reusable_runtime_bundle_root
    else
        ctx.project_root;
    if (graph_out) |graph| {
        graph.* = native_bundler.bundleEntryPointGraphWithOptions(
            wrapped_entry,
            bundle_working_dir,
            options,
            &error_message,
        ) catch |err| return nativeBundleFailure(
            ctx,
            script_abs,
            script_entry_abs,
            tmp_dir,
            build_options == null,
            reload_dependencies_out != null,
            error_message,
            err,
        );
        errdefer graph.deinit();
        const entry = graph.entryPoint() orelse return error.MissingStandaloneEntryPoint;
        try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = bundle_path, .data = entry.contents });
        if (entry.source_map) |source_map| {
            const source_map_path = try std.mem.concat(ctx.allocator, u8, &.{ bundle_path, ".map" });
            try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = source_map_path, .data = source_map.contents });
        }
        return .{ .path = bundle_path };
    }

    var output = native_bundler.bundleEntryPointGraphWithOptions(
        wrapped_entry,
        bundle_working_dir,
        options,
        &error_message,
    ) catch |err| return nativeBundleFailure(
        ctx,
        script_abs,
        script_entry_abs,
        tmp_dir,
        build_options == null,
        reload_dependencies_out != null,
        error_message,
        err,
    );
    defer output.deinit();
    if (reload_dependencies_out) |dependencies| {
        dependencies.* = try collectReloadDependencyPaths(
            ctx,
            wrapped_entry,
            script_entry_abs,
            script_abs,
            output.input_files,
        );
    }
    const entry = output.entryPoint() orelse return error.MissingRuntimeEntryPoint;
    const output_source_map: ?[]const u8 = if (entry.source_map) |source_map| source_map.contents else null;
    const native_addons: RuntimeNativeAddons = if (build_options == null)
        try prepareRuntimeNativeAddons(ctx, options.public_path, entry.contents, output.files)
    else
        .{ .code = entry.contents };
    const runtime_code = if (build_options == null)
        try rewriteRuntimeEntrypointCode(ctx, native_addons.code, script_entry_abs, script_identity_abs)
    else
        entry.contents;
    const runtime_source_map = if (build_options == null and output_source_map != null)
        try rewriteRuntimeEntrypointSourceMap(ctx, output_source_map.?, script_entry_abs, script_identity_abs)
    else
        output_source_map;
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = bundle_path, .data = runtime_code });
    if (runtime_source_map) |source_map| {
        const source_map_path = try std.mem.concat(ctx.allocator, u8, &.{ bundle_path, ".map" });
        try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = source_map_path, .data = source_map });
    }
    if (launcher_cache) |cache| {
        const cached_artifact = installLauncherCache(
            ctx,
            &cache,
            wrapped_entry,
            script_entry_abs,
            if (use_esm_bundle_cache) script_abs else null,
            runtime_code,
            runtime_source_map,
            output.input_files,
        ) catch return .{ .path = bundle_path };
        std.Io.Dir.cwd().deleteTree(ctx.io, tmp_dir) catch {};
        return cached_artifact;
    }
    return .{ .path = bundle_path };
}

const LauncherCache = struct {
    cache_root: []const u8,
    cache_name: []const u8,
    manifest_path: []const u8,
    stale_path: []const u8,
    key: [64]u8,
    lock_file: std.Io.File,
};

const launcher_cache_magic = "CTLCACH3";
const launcher_cache_manifest_limit = 16 * 1024 * 1024;
const launcher_cache_stale_limit = 64;
const launcher_cache_cleanup_scan_limit = 256;

const LauncherCacheDependencyKind = enum(u8) {
    file = 1,
    missing = 2,
    directory = 3,
};

const LauncherCacheDependency = struct {
    kind: LauncherCacheDependencyKind,
    path: []const u8,
    size: u64 = 0,
    stamp: i64 = 0,
    digest: [32]u8 = [_]u8{0} ** 32,
};

const LauncherCacheManifest = struct {
    bytes: []u8,
    artifact_id: [64]u8,
    code_digest: [32]u8,
    source_map_digest: [32]u8,
};

fn acquireLauncherCache(
    ctx: *const Context,
    wrapped_entry: []const u8,
    cache_name: []const u8,
    hash_wrapper_source: bool,
    key_material_path: ?[]const u8,
) !?LauncherCache {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update("cottontail-launcher-v4\x00");
    hasher.update(cache_name);
    hasher.update("\x00");
    hasher.update(ctx.executable_stamp);
    if (hash_wrapper_source) {
        const wrapper_source = std.Io.Dir.cwd().readFileAlloc(
            ctx.io,
            wrapped_entry,
            ctx.allocator,
            .limited(1024 * 1024),
        ) catch return null;
        hasher.update("\x00wrapper\x00");
        hasher.update(wrapper_source);
    }
    if (key_material_path) |path| {
        const key_material = std.Io.Dir.cwd().readFileAlloc(
            ctx.io,
            path,
            ctx.allocator,
            .limited(4 * 1024 * 1024),
        ) catch return null;
        hasher.update("\x00entry\x00");
        hasher.update(key_material);
    }
    for ([_][]const u8{"NODE_PATH"}) |name| {
        hasher.update("\x00");
        hasher.update(name);
        hasher.update("=");
        if (ctx.environ_map.get(name)) |value| hasher.update(value);
    }
    // The reusable CommonJS launcher contains only Cottontail's runtime and
    // reads NODE_ENV from process.env. Next sets NODE_ENV for its server
    // worker, but that must not force an identical runtime bundle rebuild.
    if (!hash_wrapper_source) {
        hasher.update("\x00NODE_ENV=");
        if (ctx.environ_map.get("NODE_ENV")) |value| hasher.update(value);
    }
    var digest: [32]u8 = undefined;
    hasher.final(&digest);

    const cache_root = try launcherCacheRoot(ctx);
    std.Io.Dir.cwd().createDirPath(ctx.io, cache_root) catch return null;

    const lock_name = try std.fmt.allocPrint(ctx.allocator, "{s}.lock", .{cache_name});
    const lock_path = try std.fs.path.join(ctx.allocator, &.{ cache_root, lock_name });
    const lock_file = std.Io.Dir.cwd().createFile(ctx.io, lock_path, .{
        .read = true,
        .truncate = false,
    }) catch return null;
    errdefer lock_file.close(ctx.io);
    const locked = lock_file.tryLock(ctx.io, .exclusive) catch {
        lock_file.close(ctx.io);
        return null;
    };
    if (!locked) {
        lock_file.close(ctx.io);
        return null;
    }

    return .{
        .cache_root = cache_root,
        .cache_name = cache_name,
        .manifest_path = try std.fs.path.join(ctx.allocator, &.{ cache_root, try std.fmt.allocPrint(ctx.allocator, "{s}.manifest", .{cache_name}) }),
        .stale_path = try std.fs.path.join(ctx.allocator, &.{ cache_root, try std.fmt.allocPrint(ctx.allocator, "{s}.stale", .{cache_name}) }),
        .key = std.fmt.bytesToHex(digest, .lower),
        .lock_file = lock_file,
    };
}

fn launcherCacheRoot(ctx: *const Context) ![]const u8 {
    if (ctx.environ_map.get("COTTONTAIL_TMP_DIR")) |tmp_dir| {
        if (tmp_dir.len > 0) {
            return try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "cottontail", "cache" });
        }
    }
    if (builtin.os.tag == .windows) {
        if (ctx.environ_map.get("LOCALAPPDATA")) |local_app_data| {
            if (local_app_data.len > 0) {
                return try std.fs.path.join(ctx.allocator, &.{ local_app_data, "cottontail", "cache" });
            }
        }
    }
    if (ctx.environ_map.get("XDG_CACHE_HOME")) |xdg_cache_home| {
        if (xdg_cache_home.len > 0) {
            return try std.fs.path.join(ctx.allocator, &.{ xdg_cache_home, "cottontail", "cache" });
        }
    }
    if (ctx.environ_map.get("HOME")) |home| {
        if (home.len > 0) {
            return try std.fs.path.join(ctx.allocator, &.{ home, ".cache", "cottontail", "cache" });
        }
    }
    return try std.fs.path.join(ctx.allocator, &.{ osTempBase(ctx), "cottontail", "cache" });
}

fn launcherCacheArtifactPath(
    ctx: *const Context,
    cache: *const LauncherCache,
    artifact_id: []const u8,
) ![]const u8 {
    const name = try std.fmt.allocPrint(ctx.allocator, "{s}-{s}.mjs", .{ cache.cache_name, artifact_id });
    return try std.fs.path.join(ctx.allocator, &.{ cache.cache_root, name });
}

fn launcherCacheSourceMapPath(ctx: *const Context, bundle_path: []const u8) ![]const u8 {
    return try std.mem.concat(ctx.allocator, u8, &.{ bundle_path, ".map" });
}

fn launcherCacheLeasePath(ctx: *const Context, bundle_path: []const u8) ![]const u8 {
    return try std.mem.concat(ctx.allocator, u8, &.{ bundle_path, ".lease" });
}

fn writeLauncherCacheFileAtomic(ctx: *const Context, path: []const u8, data: []const u8) !void {
    var atomic_file = try std.Io.Dir.cwd().createFileAtomic(ctx.io, path, .{ .replace = true });
    defer atomic_file.deinit(ctx.io);

    var buffer: [16 * 1024]u8 = undefined;
    var writer = atomic_file.file.writer(ctx.io, &buffer);
    try writer.interface.writeAll(data);
    try writer.interface.flush();
    try atomic_file.replace(ctx.io);
}

fn hashLauncherCacheBytes(bytes: []const u8) [32]u8 {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update(bytes);
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    return digest;
}

fn hashLauncherCacheFile(ctx: *const Context, path: []const u8) ![32]u8 {
    const file = try std.Io.Dir.cwd().openFile(ctx.io, path, .{});
    defer file.close(ctx.io);

    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var reader_buffer: [16 * 1024]u8 = undefined;
    var chunk: [64 * 1024]u8 = undefined;
    var reader = file.readerStreaming(ctx.io, &reader_buffer);
    while (true) {
        const count = try reader.interface.readSliceShort(&chunk);
        if (count == 0) break;
        hasher.update(chunk[0..count]);
    }
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    return digest;
}

fn launcherCacheFileMatches(
    ctx: *const Context,
    path: []const u8,
    expected_size: u64,
    expected_digest: *const [32]u8,
) bool {
    const stat = std.Io.Dir.cwd().statFile(ctx.io, path, .{}) catch return false;
    if (stat.kind != .file or stat.size != expected_size) return false;
    const actual_digest = hashLauncherCacheFile(ctx, path) catch return false;
    return std.mem.eql(u8, &actual_digest, expected_digest);
}

fn acquireLauncherCacheArtifactLease(ctx: *const Context, bundle_path: []const u8) !?std.Io.File {
    const lease_path = try launcherCacheLeasePath(ctx, bundle_path);
    const lease_file = std.Io.Dir.cwd().createFile(ctx.io, lease_path, .{
        .read = true,
        .truncate = false,
    }) catch return null;
    errdefer lease_file.close(ctx.io);
    if (!try lease_file.tryLock(ctx.io, .shared)) {
        lease_file.close(ctx.io);
        return null;
    }
    return lease_file;
}

const LauncherCacheRemoval = enum { removed, busy, unmanaged };

fn removeLauncherCacheArtifact(
    ctx: *const Context,
    cache: *const LauncherCache,
    artifact_id: []const u8,
) LauncherCacheRemoval {
    const bundle_path = launcherCacheArtifactPath(ctx, cache, artifact_id) catch return .unmanaged;
    const source_map_path = launcherCacheSourceMapPath(ctx, bundle_path) catch return .unmanaged;
    const lease_path = launcherCacheLeasePath(ctx, bundle_path) catch return .unmanaged;
    const lease_file = std.Io.Dir.cwd().openFile(ctx.io, lease_path, .{ .mode = .read_write }) catch
        return .unmanaged;

    const locked = lease_file.tryLock(ctx.io, .exclusive) catch false;
    if (!locked) {
        lease_file.close(ctx.io);
        return .busy;
    }
    std.Io.Dir.cwd().deleteFile(ctx.io, bundle_path) catch {};
    std.Io.Dir.cwd().deleteFile(ctx.io, source_map_path) catch {};
    lease_file.close(ctx.io);
    std.Io.Dir.cwd().deleteFile(ctx.io, lease_path) catch {};
    return .removed;
}

fn queueStaleLauncherCacheArtifact(
    ctx: *const Context,
    cache: *const LauncherCache,
    artifact_id: []const u8,
) void {
    if (!launcherCacheHexIdValid(artifact_id)) return;
    const existing = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        cache.stale_path,
        ctx.allocator,
        .limited((64 + 1) * launcher_cache_stale_limit),
    ) catch "";

    var output: std.ArrayList(u8) = .empty;
    var count: usize = 0;
    var lines = std.mem.splitScalar(u8, existing, '\n');
    while (lines.next()) |line| {
        if (!launcherCacheHexIdValid(line)) continue;
        if (std.mem.eql(u8, line, artifact_id)) return;
        if (count >= launcher_cache_stale_limit - 1) continue;
        output.appendSlice(ctx.allocator, line) catch return;
        output.append(ctx.allocator, '\n') catch return;
        count += 1;
    }
    output.appendSlice(ctx.allocator, artifact_id) catch return;
    output.append(ctx.allocator, '\n') catch return;
    writeLauncherCacheFileAtomic(ctx, cache.stale_path, output.items) catch {};
}

fn cleanupQueuedLauncherCacheArtifacts(ctx: *const Context, cache: *const LauncherCache) void {
    const existing = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        cache.stale_path,
        ctx.allocator,
        .limited((64 + 1) * launcher_cache_stale_limit),
    ) catch return;

    var remaining: std.ArrayList(u8) = .empty;
    var count: usize = 0;
    var lines = std.mem.splitScalar(u8, existing, '\n');
    while (lines.next()) |artifact_id| {
        if (!launcherCacheHexIdValid(artifact_id) or count >= launcher_cache_stale_limit) continue;
        count += 1;
        if (removeLauncherCacheArtifact(ctx, cache, artifact_id) != .busy) continue;
        remaining.appendSlice(ctx.allocator, artifact_id) catch return;
        remaining.append(ctx.allocator, '\n') catch return;
    }
    if (remaining.items.len == 0) {
        std.Io.Dir.cwd().deleteFile(ctx.io, cache.stale_path) catch {};
    } else {
        writeLauncherCacheFileAtomic(ctx, cache.stale_path, remaining.items) catch {};
    }
}

fn launcherCacheManifestArtifactId(manifest: []const u8) ?[]const u8 {
    const header_len = launcher_cache_magic.len + 64 + 64;
    if (manifest.len < header_len or
        !std.mem.eql(u8, manifest[0..launcher_cache_magic.len], launcher_cache_magic))
    {
        return null;
    }
    const artifact_id = manifest[launcher_cache_magic.len + 64 .. header_len];
    return if (launcherCacheHexIdValid(artifact_id)) artifact_id else null;
}

fn discardLauncherCacheManifest(
    ctx: *const Context,
    cache: *const LauncherCache,
    manifest: []const u8,
) void {
    std.Io.Dir.cwd().deleteFile(ctx.io, cache.manifest_path) catch {};
    const artifact_id = launcherCacheManifestArtifactId(manifest) orelse return;
    if (removeLauncherCacheArtifact(ctx, cache, artifact_id) == .busy) {
        queueStaleLauncherCacheArtifact(ctx, cache, artifact_id);
    }
}

fn cleanupLauncherCacheArtifacts(
    ctx: *const Context,
    cache: *const LauncherCache,
    keep_artifact_id: []const u8,
) void {
    var directory = std.Io.Dir.cwd().openDir(ctx.io, cache.cache_root, .{ .iterate = true }) catch return;
    defer directory.close(ctx.io);

    const prefix = std.fmt.allocPrint(ctx.allocator, "{s}-", .{cache.cache_name}) catch return;
    var scanned: usize = 0;
    var iterator = directory.iterate();
    while (scanned < launcher_cache_cleanup_scan_limit) : (scanned += 1) {
        const entry = (iterator.next(ctx.io) catch return) orelse break;
        if (entry.kind != .file or
            !std.mem.startsWith(u8, entry.name, prefix) or
            !std.mem.endsWith(u8, entry.name, ".mjs"))
        {
            continue;
        }
        const artifact_id = entry.name[prefix.len .. entry.name.len - ".mjs".len];
        if (!launcherCacheHexIdValid(artifact_id) or std.mem.eql(u8, artifact_id, keep_artifact_id)) continue;
        if (removeLauncherCacheArtifact(ctx, cache, artifact_id) == .busy) {
            queueStaleLauncherCacheArtifact(ctx, cache, artifact_id);
        }
    }
}

const LauncherCacheDirectoryEntry = struct {
    name: []const u8,
    kind: u8,
};

fn launcherCacheDirectoryEntryLessThan(
    _: void,
    left: LauncherCacheDirectoryEntry,
    right: LauncherCacheDirectoryEntry,
) bool {
    return switch (std.mem.order(u8, left.name, right.name)) {
        .lt => true,
        .gt => false,
        .eq => left.kind < right.kind,
    };
}

fn isGeneratedLauncherSource(name: []const u8) bool {
    return std.mem.startsWith(u8, name, ".cottontail-compat-") or
        std.mem.startsWith(u8, name, ".cottontail-eval-");
}

fn hashLauncherCacheDirectory(ctx: *const Context, path: []const u8) ![32]u8 {
    var directory = try std.Io.Dir.cwd().openDir(ctx.io, path, .{ .iterate = true });
    defer directory.close(ctx.io);

    var entries: std.ArrayList(LauncherCacheDirectoryEntry) = .empty;
    var iterator = directory.iterate();
    while (try iterator.next(ctx.io)) |entry| {
        if (isGeneratedLauncherSource(entry.name)) continue;
        try entries.append(ctx.allocator, .{
            .name = try ctx.allocator.dupe(u8, entry.name),
            .kind = @intFromEnum(entry.kind),
        });
    }
    std.mem.sort(LauncherCacheDirectoryEntry, entries.items, {}, launcherCacheDirectoryEntryLessThan);

    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    for (entries.items) |entry| {
        hasher.update(entry.name);
        hasher.update(&.{ 0, entry.kind });
    }
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    return digest;
}

fn appendLauncherCacheDependency(
    ctx: *const Context,
    dependencies: *std.ArrayList(LauncherCacheDependency),
    seen: *std.StringHashMapUnmanaged(void),
    path: []const u8,
    include_missing: bool,
) !bool {
    if (path.len == 0 or seen.contains(path)) return false;

    const stat = std.Io.Dir.cwd().statFile(ctx.io, path, .{}) catch {
        if (!include_missing) return false;
        try seen.put(ctx.allocator, path, {});
        try dependencies.append(ctx.allocator, .{ .kind = .missing, .path = path });
        return false;
    };
    if (stat.kind != .file) return false;

    try seen.put(ctx.allocator, path, {});
    try dependencies.append(ctx.allocator, .{
        .kind = .file,
        .path = path,
        .size = stat.size,
        .digest = try hashLauncherCacheFile(ctx, path),
    });
    return true;
}

fn appendLauncherCacheDirectory(
    ctx: *const Context,
    dependencies: *std.ArrayList(LauncherCacheDependency),
    seen: *std.StringHashMapUnmanaged(void),
    path: []const u8,
) !void {
    if (path.len == 0 or seen.contains(path)) return;
    const stat = std.Io.Dir.cwd().statFile(ctx.io, path, .{}) catch return;
    if (stat.kind != .directory) return;
    try seen.put(ctx.allocator, path, {});
    try dependencies.append(ctx.allocator, .{
        .kind = .directory,
        .path = path,
        .digest = try hashLauncherCacheDirectory(ctx, path),
    });
}

fn appendLauncherCacheConfigChain(
    ctx: *const Context,
    dependencies: *std.ArrayList(LauncherCacheDependency),
    seen: *std.StringHashMapUnmanaged(void),
    start_dir: []const u8,
) !void {
    var current = start_dir;
    while (current.len > 0) {
        for ([_][]const u8{
            "package.json",
            "tsconfig.json",
            "jsconfig.json",
            "bunfig.toml",
            "bun.lock",
            "bun.lockb",
        }) |name| {
            const path = try std.fs.path.join(ctx.allocator, &.{ current, name });
            _ = try appendLauncherCacheDependency(ctx, dependencies, seen, path, true);
        }
        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = parent;
    }
}

fn collectLauncherCacheDependencies(
    ctx: *const Context,
    wrapped_entry: []const u8,
    generated_entry: []const u8,
    original_entry: ?[]const u8,
    input_files: []const native_bundler.GraphInputFile,
) ![]LauncherCacheDependency {
    var dependencies: std.ArrayList(LauncherCacheDependency) = .empty;
    var seen: std.StringHashMapUnmanaged(void) = .empty;
    defer seen.deinit(ctx.allocator);

    const wrapped_entry_real = std.Io.Dir.cwd().realPathFileAlloc(
        ctx.io,
        wrapped_entry,
        ctx.allocator,
    ) catch wrapped_entry;
    const generated_entry_real = std.Io.Dir.cwd().realPathFileAlloc(
        ctx.io,
        generated_entry,
        ctx.allocator,
    ) catch generated_entry;
    const original_entry_real = if (original_entry) |path|
        std.Io.Dir.cwd().realPathFileAlloc(ctx.io, path, ctx.allocator) catch path
    else
        null;
    const has_generated_entry = if (original_entry_real) |path|
        !std.mem.eql(u8, generated_entry_real, path)
    else
        false;

    for (input_files) |input| {
        const path = input.path;
        if (std.mem.eql(u8, path, wrapped_entry_real) or
            (has_generated_entry and std.mem.eql(u8, path, generated_entry_real)) or
            std.mem.indexOf(u8, path, embedded_runtime_modules.virtual_directory_name) != null)
        {
            continue;
        }
        if (!try appendLauncherCacheDependency(ctx, &dependencies, &seen, path, false)) continue;
        const parent = std.fs.path.dirname(path) orelse continue;
        try appendLauncherCacheDirectory(ctx, &dependencies, &seen, parent);
        try appendLauncherCacheConfigChain(ctx, &dependencies, &seen, parent);
    }
    if (original_entry_real) |path| {
        if (try appendLauncherCacheDependency(ctx, &dependencies, &seen, path, false)) {
            if (std.fs.path.dirname(path)) |parent| {
                try appendLauncherCacheDirectory(ctx, &dependencies, &seen, parent);
                try appendLauncherCacheConfigChain(ctx, &dependencies, &seen, parent);
            }
        }
    }
    return try dependencies.toOwnedSlice(ctx.allocator);
}

fn pathHasNodeModulesComponent(path: []const u8) bool {
    var components = std.mem.tokenizeAny(u8, path, "/\\");
    while (components.next()) |component| {
        if (builtin.os.tag == .windows) {
            if (std.ascii.eqlIgnoreCase(component, "node_modules")) return true;
        } else if (std.mem.eql(u8, component, "node_modules")) {
            return true;
        }
    }
    return false;
}

fn collectReloadDependencyPaths(
    ctx: *const Context,
    wrapped_entry: []const u8,
    generated_entry: []const u8,
    original_entry: []const u8,
    input_files: []const native_bundler.GraphInputFile,
) ![]const [:0]const u8 {
    const dependencies = try collectLauncherCacheDependencies(
        ctx,
        wrapped_entry,
        generated_entry,
        original_entry,
        input_files,
    );
    var paths: std.ArrayList([:0]const u8) = .empty;
    for (dependencies) |dependency| {
        if (dependency.kind == .directory or pathHasNodeModulesComponent(dependency.path)) continue;
        try paths.append(ctx.allocator, try ctx.allocator.dupeZ(u8, dependency.path));
    }
    return try paths.toOwnedSlice(ctx.allocator);
}

fn launcherCacheDependencyLessThan(
    _: void,
    left: LauncherCacheDependency,
    right: LauncherCacheDependency,
) bool {
    return switch (std.mem.order(u8, left.path, right.path)) {
        .lt => true,
        .gt => false,
        .eq => @intFromEnum(left.kind) < @intFromEnum(right.kind),
    };
}

fn appendLauncherCacheInt(
    bytes: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    comptime T: type,
    value: T,
) !void {
    var buffer: [@sizeOf(T)]u8 = undefined;
    std.mem.writeInt(T, &buffer, value, .little);
    try bytes.appendSlice(allocator, &buffer);
}

fn readLauncherCacheInt(
    comptime T: type,
    bytes: []const u8,
    cursor: *usize,
) ?T {
    const end = std.math.add(usize, cursor.*, @sizeOf(T)) catch return null;
    if (end > bytes.len) return null;
    const value = std.mem.readInt(T, bytes[cursor.*..end][0..@sizeOf(T)], .little);
    cursor.* = end;
    return value;
}

fn buildLauncherCacheManifest(
    ctx: *const Context,
    cache: *const LauncherCache,
    dependencies: []LauncherCacheDependency,
    code: []const u8,
    source_map: []const u8,
) !LauncherCacheManifest {
    std.mem.sort(LauncherCacheDependency, dependencies, {}, launcherCacheDependencyLessThan);

    const code_digest = hashLauncherCacheBytes(code);
    const source_map_digest = hashLauncherCacheBytes(source_map);
    var payload: std.ArrayList(u8) = .empty;
    try appendLauncherCacheInt(&payload, ctx.allocator, u64, @intCast(code.len));
    try payload.appendSlice(ctx.allocator, &code_digest);
    try appendLauncherCacheInt(&payload, ctx.allocator, u64, @intCast(source_map.len));
    try payload.appendSlice(ctx.allocator, &source_map_digest);
    try appendLauncherCacheInt(&payload, ctx.allocator, u32, @intCast(dependencies.len));
    for (dependencies) |dependency| {
        try payload.append(ctx.allocator, @intFromEnum(dependency.kind));
        try appendLauncherCacheInt(&payload, ctx.allocator, u32, @intCast(dependency.path.len));
        try appendLauncherCacheInt(&payload, ctx.allocator, u64, dependency.size);
        try appendLauncherCacheInt(&payload, ctx.allocator, i64, dependency.stamp);
        try payload.appendSlice(ctx.allocator, &dependency.digest);
        try payload.appendSlice(ctx.allocator, dependency.path);
    }

    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update(&cache.key);
    hasher.update(payload.items);
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    const artifact_id = std.fmt.bytesToHex(digest, .lower);

    var manifest: std.ArrayList(u8) = .empty;
    try manifest.appendSlice(ctx.allocator, launcher_cache_magic);
    try manifest.appendSlice(ctx.allocator, &cache.key);
    try manifest.appendSlice(ctx.allocator, &artifact_id);
    try manifest.appendSlice(ctx.allocator, payload.items);
    return .{
        .bytes = try manifest.toOwnedSlice(ctx.allocator),
        .artifact_id = artifact_id,
        .code_digest = code_digest,
        .source_map_digest = source_map_digest,
    };
}

fn launcherCacheHexIdValid(value: []const u8) bool {
    if (value.len != 64) return false;
    for (value) |byte| {
        if (!std.ascii.isHex(byte)) return false;
    }
    return true;
}

fn validateLauncherCacheDependency(
    ctx: *const Context,
    kind: LauncherCacheDependencyKind,
    path: []const u8,
    size: u64,
    stamp: i64,
    digest: *const [32]u8,
) bool {
    _ = stamp;
    const stat = std.Io.Dir.cwd().statFile(ctx.io, path, .{}) catch {
        return kind == .missing;
    };
    return switch (kind) {
        .missing => false,
        .directory => blk: {
            if (stat.kind != .directory) break :blk false;
            const actual_digest = hashLauncherCacheDirectory(ctx, path) catch break :blk false;
            break :blk std.mem.eql(u8, &actual_digest, digest);
        },
        .file => blk: {
            if (stat.kind != .file or stat.size != size) break :blk false;
            const actual_digest = hashLauncherCacheFile(ctx, path) catch break :blk false;
            break :blk std.mem.eql(u8, &actual_digest, digest);
        },
    };
}

fn validateLauncherCacheManifest(
    ctx: *const Context,
    cache: *const LauncherCache,
    manifest: []const u8,
) !?RuntimeArtifact {
    const fixed_metadata_len = @sizeOf(u64) + 32 + @sizeOf(u64) + 32;
    const header_len = launcher_cache_magic.len + cache.key.len + 64;
    if (manifest.len < header_len + fixed_metadata_len + @sizeOf(u32) or
        !std.mem.eql(u8, manifest[0..launcher_cache_magic.len], launcher_cache_magic) or
        !std.mem.eql(u8, manifest[launcher_cache_magic.len..][0..cache.key.len], &cache.key))
    {
        return null;
    }
    const artifact_id = manifest[launcher_cache_magic.len + cache.key.len .. header_len];
    if (!launcherCacheHexIdValid(artifact_id)) return null;

    var artifact_hasher = std.crypto.hash.sha2.Sha256.init(.{});
    artifact_hasher.update(&cache.key);
    artifact_hasher.update(manifest[header_len..]);
    var artifact_digest: [32]u8 = undefined;
    artifact_hasher.final(&artifact_digest);
    const expected_artifact_id = std.fmt.bytesToHex(artifact_digest, .lower);
    if (!std.mem.eql(u8, artifact_id, &expected_artifact_id)) return null;

    var cursor = header_len;
    const code_size = readLauncherCacheInt(u64, manifest, &cursor) orelse return null;
    const code_digest_end = std.math.add(usize, cursor, 32) catch return null;
    if (code_digest_end > manifest.len) return null;
    const code_digest: *const [32]u8 = @ptrCast(manifest[cursor..code_digest_end].ptr);
    cursor = code_digest_end;
    const source_map_size = readLauncherCacheInt(u64, manifest, &cursor) orelse return null;
    const source_map_digest_end = std.math.add(usize, cursor, 32) catch return null;
    if (source_map_digest_end > manifest.len) return null;
    const source_map_digest: *const [32]u8 = @ptrCast(manifest[cursor..source_map_digest_end].ptr);
    cursor = source_map_digest_end;
    if (code_size == 0 or source_map_size == 0) return null;

    const dependency_count = readLauncherCacheInt(u32, manifest, &cursor) orelse return null;
    for (0..@as(usize, @intCast(dependency_count))) |_| {
        if (cursor >= manifest.len) return null;
        const kind: LauncherCacheDependencyKind = switch (manifest[cursor]) {
            @intFromEnum(LauncherCacheDependencyKind.file) => .file,
            @intFromEnum(LauncherCacheDependencyKind.missing) => .missing,
            @intFromEnum(LauncherCacheDependencyKind.directory) => .directory,
            else => return null,
        };
        cursor += 1;
        const path_len = readLauncherCacheInt(u32, manifest, &cursor) orelse return null;
        const size = readLauncherCacheInt(u64, manifest, &cursor) orelse return null;
        const stamp = readLauncherCacheInt(i64, manifest, &cursor) orelse return null;
        const digest_end = std.math.add(usize, cursor, 32) catch return null;
        if (digest_end > manifest.len) return null;
        const digest: *const [32]u8 = @ptrCast(manifest[cursor..digest_end].ptr);
        cursor = digest_end;
        const path_end = std.math.add(usize, cursor, path_len) catch return null;
        if (path_end > manifest.len) return null;
        const path = manifest[cursor..path_end];
        cursor = path_end;
        if (!validateLauncherCacheDependency(ctx, kind, path, size, stamp, digest)) return null;
    }
    if (cursor != manifest.len) return null;

    const bundle_path = try launcherCacheArtifactPath(ctx, cache, artifact_id);
    if (!launcherCacheFileMatches(ctx, bundle_path, code_size, code_digest)) return null;
    const source_map_path = try launcherCacheSourceMapPath(ctx, bundle_path);
    if (!launcherCacheFileMatches(ctx, source_map_path, source_map_size, source_map_digest)) return null;
    const lease_file = (try acquireLauncherCacheArtifactLease(ctx, bundle_path)) orelse return null;
    return .{ .path = bundle_path, .lease_file = lease_file };
}

fn launcherCacheHit(ctx: *const Context, cache: *const LauncherCache) !?RuntimeArtifact {
    cleanupQueuedLauncherCacheArtifacts(ctx, cache);
    const manifest = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        cache.manifest_path,
        ctx.allocator,
        .limited(launcher_cache_manifest_limit),
    ) catch return null;
    const artifact = try validateLauncherCacheManifest(ctx, cache, manifest);
    if (artifact == null) discardLauncherCacheManifest(ctx, cache, manifest);
    return artifact;
}

fn installLauncherCache(
    ctx: *const Context,
    cache: *const LauncherCache,
    wrapped_entry: []const u8,
    generated_entry: []const u8,
    original_entry: ?[]const u8,
    code: []const u8,
    source_map: ?[]const u8,
    input_files: []const native_bundler.GraphInputFile,
) !RuntimeArtifact {
    const map = source_map orelse return error.MissingLauncherSourceMap;
    const dependencies = try collectLauncherCacheDependencies(
        ctx,
        wrapped_entry,
        generated_entry,
        original_entry,
        input_files,
    );
    const manifest = try buildLauncherCacheManifest(ctx, cache, dependencies, code, map);
    const bundle_path = try launcherCacheArtifactPath(ctx, cache, &manifest.artifact_id);
    const source_map_path = try launcherCacheSourceMapPath(ctx, bundle_path);

    if (!launcherCacheFileMatches(ctx, bundle_path, @intCast(code.len), &manifest.code_digest)) {
        try writeLauncherCacheFileAtomic(ctx, bundle_path, code);
    }
    if (!launcherCacheFileMatches(ctx, source_map_path, @intCast(map.len), &manifest.source_map_digest)) {
        try writeLauncherCacheFileAtomic(ctx, source_map_path, map);
    }
    const lease_file = (try acquireLauncherCacheArtifactLease(ctx, bundle_path)) orelse
        return error.LauncherArtifactBusy;
    errdefer lease_file.close(ctx.io);

    // The fixed manifest is the generation index. Publish it only after both
    // immutable artifact files are complete.
    try writeLauncherCacheFileAtomic(ctx, cache.manifest_path, manifest.bytes);
    cleanupLauncherCacheArtifacts(ctx, cache, &manifest.artifact_id);
    return .{ .path = bundle_path, .lease_file = lease_file };
}

fn tsconfigOverridePath(ctx: *const Context, exec_args: []const [:0]const u8) !?[]const u8 {
    var index: usize = 0;
    var value: ?[]const u8 = null;
    while (index < exec_args.len) : (index += 1) {
        const arg: []const u8 = exec_args[index];
        if (std.mem.startsWith(u8, arg, "--tsconfig-override=")) {
            value = arg["--tsconfig-override=".len..];
        } else if (std.mem.eql(u8, arg, "--tsconfig-override") and index + 1 < exec_args.len) {
            index += 1;
            value = exec_args[index];
        }
    }
    const path = value orelse return null;
    if (path.len == 0) return null;
    return resolvePathForCwd(ctx.io, ctx.allocator, path) catch try ctx.allocator.dupe(u8, path);
}

fn runnableDirectoryForCleanup(ctx: *const Context, runnable_path: []const u8) ?[]const u8 {
    if (ctx.environ_map.get("COTTONTAIL_KEEP_TEMP") != null) return null;
    const directory = std.fs.path.dirname(runnable_path) orelse return null;
    const run_root = std.fs.path.dirname(directory) orelse return null;
    if (!std.mem.eql(u8, std.fs.path.basename(run_root), "run")) return null;

    const generated_name = std.fs.path.basename(directory);
    if (generated_name.len != 32) return null;
    for (generated_name) |byte| {
        if (!std.ascii.isHex(byte)) return null;
    }
    return directory;
}

fn cleanupRunnableDirectory(ctx: *const Context, runnable_path: []const u8) void {
    const directory = runnableDirectoryForCleanup(ctx, runnable_path) orelse return;
    std.Io.Dir.cwd().deleteTree(ctx.io, directory) catch {};
}

fn collectConditions(
    allocator: std.mem.Allocator,
    conditions: *std.ArrayList([]const u8),
    cli_args: []const [:0]const u8,
) !void {
    var index: usize = 0;
    while (index < cli_args.len) : (index += 1) {
        const arg: []const u8 = cli_args[index];
        if (std.mem.startsWith(u8, arg, "--conditions=")) {
            const value = arg["--conditions=".len..];
            if (value.len > 0) try conditions.append(allocator, value);
        } else if (std.mem.eql(u8, arg, "--conditions") and index + 1 < cli_args.len) {
            index += 1;
            const value: []const u8 = cli_args[index];
            if (value.len > 0) try conditions.append(allocator, value);
        }
    }
}

fn collectFeatures(
    allocator: std.mem.Allocator,
    features: *std.ArrayList([]const u8),
    cli_args: []const [:0]const u8,
) !void {
    var index: usize = 0;
    while (index < cli_args.len) : (index += 1) {
        const arg: []const u8 = cli_args[index];
        if (std.mem.startsWith(u8, arg, "--feature=")) {
            const value = arg["--feature=".len..];
            if (value.len > 0) try features.append(allocator, value);
        } else if (std.mem.eql(u8, arg, "--feature") and index + 1 < cli_args.len) {
            index += 1;
            const value: []const u8 = cli_args[index];
            if (value.len > 0) try features.append(allocator, value);
        }
    }
}

fn hasCustomConditions(cli_args: []const [:0]const u8) bool {
    for (cli_args) |arg| {
        if (std.mem.eql(u8, arg, "--conditions") or std.mem.startsWith(u8, arg, "--conditions=")) return true;
    }
    return false;
}

fn shouldBundleCommonJsEntrypoint(ctx: *const Context, script_abs: []const u8) !bool {
    if (std.mem.endsWith(u8, script_abs, ".cjs") or std.mem.endsWith(u8, script_abs, ".cts")) {
        return !try entrypointHasTopLevelAwait(ctx, script_abs);
    }
    if (std.mem.endsWith(u8, script_abs, ".mjs") or std.mem.endsWith(u8, script_abs, ".mts")) return false;
    const supports_syntax_detection = std.mem.endsWith(u8, script_abs, ".js") or
        std.mem.endsWith(u8, script_abs, ".jsx") or
        std.mem.endsWith(u8, script_abs, ".ts") or
        std.mem.endsWith(u8, script_abs, ".tsx");
    if (!supports_syntax_detection) {
        if (std.fs.path.extension(script_abs).len == 0) {
            return try extensionlessEntrypointLooksCommonJs(ctx, script_abs);
        }
        return false;
    }

    if (try entrypointModuleSyntax(ctx, script_abs)) |syntax| {
        if (syntax.has_top_level_await or syntax.exports_kind == .esm) return false;
        if (syntax.exports_kind == .cjs) return true;
    } else {
        if (try sourceFileLooksEsm(ctx, script_abs)) return false;
        if (try sourceLooksCommonJs(ctx, script_abs)) return true;
    }

    const script_dir = std.fs.path.dirname(script_abs) orelse ctx.project_root;
    return !(try nearestPackageTypeIsModule(ctx, script_dir));
}

fn runtimeCacheCanUseCommonJsLoader(ctx: *const Context, script_abs: []const u8) !bool {
    const extension = std.fs.path.extension(script_abs);
    const explicit_common_js = std.mem.eql(u8, extension, ".cjs") or
        std.mem.eql(u8, extension, ".cts");
    if (!explicit_common_js and
        !std.mem.eql(u8, extension, ".js") and
        !std.mem.eql(u8, extension, ".jsx") and
        !std.mem.eql(u8, extension, ".ts") and
        !std.mem.eql(u8, extension, ".tsx"))
    {
        return false;
    }
    const script_dir = std.fs.path.dirname(script_abs) orelse ctx.project_root;
    if (!explicit_common_js and try nearestPackageTypeIsModule(ctx, script_dir)) return false;
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        script_abs,
        ctx.allocator,
        .limited(16 * 1024 * 1024),
    ) catch return false;
    return !sourceLooksEsm(source);
}

const EntrypointModuleSyntax = struct {
    has_top_level_await: bool,
    exports_kind: enum { none, cjs, esm },
};

fn entrypointModuleSyntax(ctx: *const Context, script_abs: []const u8) !?EntrypointModuleSyntax {
    const loader = transpilerLoaderForPath(script_abs) orelse return null;
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        script_abs,
        ctx.allocator,
        .limited(16 * 1024 * 1024),
    ) catch return null;
    const syntax_json = native_transpiler.scanModuleSyntaxJson(source, loader) catch return null;
    defer std.heap.c_allocator.free(syntax_json);
    const ModuleSyntax = struct {
        hasTopLevelAwait: bool,
        exportsKind: []const u8,
    };
    const parsed = std.json.parseFromSlice(ModuleSyntax, ctx.allocator, syntax_json, .{}) catch return null;
    defer parsed.deinit();
    return .{
        .has_top_level_await = parsed.value.hasTopLevelAwait,
        .exports_kind = if (std.mem.eql(u8, parsed.value.exportsKind, "cjs"))
            .cjs
        else if (std.mem.startsWith(u8, parsed.value.exportsKind, "esm"))
            .esm
        else
            .none,
    };
}

fn entrypointHasTopLevelAwait(ctx: *const Context, script_abs: []const u8) !bool {
    const syntax = try entrypointModuleSyntax(ctx, script_abs) orelse return false;
    return syntax.has_top_level_await;
}

fn extensionlessEntrypointLooksCommonJs(ctx: *const Context, script_abs: []const u8) !bool {
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        script_abs,
        ctx.allocator,
        .limited(256 * 1024),
    ) catch return false;
    if (!std.mem.startsWith(u8, source, "#!")) return false;

    const line_end = std.mem.indexOfScalar(u8, source, '\n') orelse @min(source.len, 256);
    const shebang = source[0..@min(line_end, 256)];
    const looks_node_cli =
        std.mem.indexOf(u8, shebang, "node") != null or
        std.mem.indexOf(u8, shebang, "bun") != null or
        std.mem.indexOf(u8, shebang, "env") != null;
    if (!looks_node_cli) return false;

    return std.mem.indexOf(u8, source, "require(") != null or
        std.mem.indexOf(u8, source, "require.resolve") != null or
        std.mem.indexOf(u8, source, "module.exports") != null or
        std.mem.indexOf(u8, source, "exports.") != null;
}

fn sourceLooksCommonJs(ctx: *const Context, script_abs: []const u8) !bool {
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        script_abs,
        ctx.allocator,
        .limited(256 * 1024),
    ) catch return false;
    if (sourceLooksEsm(source)) return false;
    return std.mem.indexOf(u8, source, "require(") != null or
        std.mem.indexOf(u8, source, "require.resolve") != null or
        std.mem.indexOf(u8, source, "module.exports") != null or
        std.mem.indexOf(u8, source, "exports.") != null;
}

fn sourceFileLooksEsm(ctx: *const Context, script_abs: []const u8) !bool {
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        script_abs,
        ctx.allocator,
        .limited(256 * 1024),
    ) catch return false;
    return sourceLooksEsm(source);
}

fn sourceLooksEsm(source: []const u8) bool {
    if (std.mem.indexOf(u8, source, "import(") != null or
        std.mem.indexOf(u8, source, "import (") != null or
        std.mem.indexOf(u8, source, "import.meta") != null or
        (std.mem.indexOf(u8, source, "require(") != null and std.mem.indexOf(u8, source, "?raw") != null) or
        std.mem.indexOf(u8, source, "await ") != null)
    {
        return true;
    }
    var remaining = source;
    while (true) {
        const line_end = std.mem.indexOfScalar(u8, remaining, '\n') orelse remaining.len;
        if (lineLooksEsm(remaining[0..line_end])) return true;
        if (line_end == remaining.len) return false;
        remaining = remaining[line_end + 1 ..];
    }
}

fn lineLooksEsm(line: []const u8) bool {
    const trimmed = std.mem.trim(u8, line, " \t\r");
    return startsWithModuleKeyword(trimmed, "import", &.{ ' ', '\t', '{', '*' }) or
        startsWithModuleKeyword(trimmed, "export", &.{ ' ', '\t', '{', '*', 'd', 'c', 'f', 'l', 'v' }) or
        startsWithModuleKeyword(trimmed, "await", &.{ ' ', '\t' });
}

fn startsWithModuleKeyword(line: []const u8, keyword: []const u8, delimiters: []const u8) bool {
    if (!std.mem.startsWith(u8, line, keyword)) return false;
    if (line.len == keyword.len) return true;
    for (delimiters) |delimiter| {
        if (line[keyword.len] == delimiter) return true;
    }
    return false;
}

fn nearestPackageTypeIsModule(ctx: *const Context, start_dir: []const u8) !bool {
    var current: []const u8 = try ctx.allocator.dupe(u8, start_dir);
    while (true) {
        const package_json = try std.fs.path.join(ctx.allocator, &.{ current, "package.json" });
        if (pathExists(ctx.io, package_json)) {
            const source = std.Io.Dir.cwd().readFileAlloc(
                ctx.io,
                package_json,
                ctx.allocator,
                .limited(1024 * 1024),
            ) catch return false;
            return packageJsonDeclaresModuleType(source);
        }

        const parent = std.fs.path.dirname(current) orelse return false;
        if (std.mem.eql(u8, parent, current)) return false;
        current = parent;
    }
}

fn packageJsonDeclaresModuleType(source: []const u8) bool {
    var offset: usize = 0;
    while (std.mem.indexOfPos(u8, source, offset, "\"type\"")) |index| {
        const after_key = source[index + "\"type\"".len ..];
        const colon_index = std.mem.indexOfScalar(u8, after_key, ':') orelse {
            offset = index + "\"type\"".len;
            continue;
        };
        const value = std.mem.trim(u8, after_key[colon_index + 1 ..], " \t\r\n");
        return std.mem.startsWith(u8, value, "\"module\"");
    }
    return false;
}

fn hasModuleInputType(exec_args: []const [:0]const u8) bool {
    for (exec_args, 0..) |arg, index| {
        if (std.mem.eql(u8, arg, "--input-type=module") or
            std.mem.eql(u8, arg, "--experimental-default-type=module"))
        {
            return true;
        }
        if ((std.mem.eql(u8, arg, "--input-type") or
            std.mem.eql(u8, arg, "--experimental-default-type")) and
            index + 1 < exec_args.len and
            std.mem.eql(u8, exec_args[index + 1], "module"))
        {
            return true;
        }
    }
    return false;
}

// Bun exposes its built-in modules as writable, enumerable globals for -e/-p.
// Keep these lazy so an eval only initializes the modules it actually touches.
const bun_eval_globals_bootstrap =
    \\globalThis.__cottontailImportMeta ??= {};
    \\Object.defineProperty(globalThis.__cottontailImportMeta, "require", {
    \\  value: globalThis.require, writable: true, enumerable: true, configurable: true,
    \\});
    \\const __ctEvalGlobalModules = {
    \\  ffi: "bun:ffi", assert: "node:assert", async_hooks: "node:async_hooks",
    \\  child_process: "node:child_process", cluster: "node:cluster", dgram: "node:dgram",
    \\  diagnostics_channel: "node:diagnostics_channel", dns: "node:dns", domain: "node:domain",
    \\  events: "node:events", fs: "node:fs", http: "node:http", http2: "node:http2",
    \\  https: "node:https", inspector: "node:inspector", net: "node:net", os: "node:os",
    \\  path: "node:path", perf_hooks: "node:perf_hooks", punycode: "node:punycode",
    \\  querystring: "node:querystring", readline: "node:readline", stream: "node:stream",
    \\  sys: "node:util", timers: "node:timers", tls: "node:tls",
    \\  trace_events: "node:trace_events", tty: "node:tty", url: "node:url", util: "node:util",
    \\  v8: "node:v8", vm: "node:vm", wasi: "node:wasi", sqlite: "bun:sqlite",
    \\  worker_threads: "node:worker_threads", zlib: "node:zlib", constants: "node:constants",
    \\  string_decoder: "node:string_decoder", buffer: "node:buffer", jsc: "bun:jsc",
    \\};
    \\const __ctPrepareEvalGlobal = (name, value) => {
    \\  if (name === "fs" && typeof value?.accessSync === "function") {
    \\    const originalAccessSync = value.accessSync;
    \\    const bunAccessSync = function accessSync(...args) {
    \\      const result = originalAccessSync.apply(this, args);
    \\      return result === undefined ? null : result;
    \\    };
    \\    Object.defineProperty(value, "accessSync", {
    \\      value: bunAccessSync, writable: true, enumerable: true, configurable: true,
    \\    });
    \\  }
    \\  return value;
    \\};
    \\const __ctSetEvalGlobal = (name, value) => {
    \\  value = __ctPrepareEvalGlobal(name, value);
    \\  Object.defineProperty(globalThis, name, { value, writable: true, enumerable: true, configurable: true });
    \\  return value;
    \\};
    \\for (const [__ctName, __ctSpecifier] of Object.entries(__ctEvalGlobalModules)) {
    \\  if (Object.hasOwn(globalThis, __ctName)) continue;
    \\  Object.defineProperty(globalThis, __ctName, {
    \\    enumerable: true,
    \\    configurable: true,
    \\    get() { return __ctSetEvalGlobal(__ctName, globalThis.require(__ctSpecifier)); },
    \\    set(value) { __ctSetEvalGlobal(__ctName, value); },
    \\  });
    \\}
;

fn sourceNeedsEvalModuleGlobals(allocator: std.mem.Allocator, source: []const u8) !bool {
    const module_globals = [_][]const u8{
        "ffi",         "assert",              "async_hooks",    "child_process", "cluster",
        "dgram",       "diagnostics_channel", "dns",            "domain",        "events",
        "fs",          "http",                "http2",          "https",         "inspector",
        "net",         "os",                  "path",           "perf_hooks",    "punycode",
        "querystring", "readline",            "stream",         "sys",           "timers",
        "tls",         "trace_events",        "tty",            "url",           "util",
        "v8",          "vm",                  "wasi",           "sqlite",        "worker_threads",
        "zlib",        "constants",           "string_decoder", "buffer",        "jsc",
        "require",     "module",              "exports",        "__filename",    "__dirname",
    };
    const tokens = try tokenizeJavaScriptModuleSyntax(allocator, source);
    for (tokens) |token| {
        if (token.kind != .identifier) continue;
        for (module_globals) |name| {
            if (std.mem.eql(u8, token.text, name)) return true;
        }
    }
    return false;
}

const EvalArgvMode = enum { unchanged, omit_entrypoint, stdin };

const EvalEntrypoint = struct {
    entry_path: []const u8,
    source_path: ?[]const u8 = null,
};

fn markVirtualSource(
    ctx: *const Context,
    tmp_dir: []const u8,
    virtual_name: []const u8,
    source: []const u8,
) ![]const u8 {
    const virtual_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, virtual_name });
    const encoder = std.base64.standard.Encoder;
    const encoded_path = try ctx.allocator.alloc(u8, encoder.calcSize(virtual_path.len));
    const encoded = encoder.encode(encoded_path, virtual_path);
    return try std.mem.concat(ctx.allocator, u8, &.{
        "/*@cottontail-original-path-base64:",
        encoded,
        "*/",
        source,
    });
}

fn writeEvalEntrypoint(
    ctx: *const Context,
    tmp_dir: []const u8,
    source: []const u8,
    print_result: bool,
    module_input: bool,
    virtual_name: []const u8,
    expose_process_eval: bool,
    argv_mode: EvalArgvMode,
) !EvalEntrypoint {
    const extension = if (module_input) "tsx" else "cts";
    var random_bytes: [8]u8 = undefined;
    ctx.io.random(&random_bytes);
    const wrapper_name = try std.fmt.allocPrint(
        ctx.allocator,
        ".cottontail-eval-{x}-{x}.{s}",
        .{
            std.hash.Wyhash.hash(if (print_result) 1 else 0, source),
            std.mem.readInt(u64, &random_bytes, .little),
            extension,
        },
    );
    const wrapper_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, wrapper_name });
    const source_literal = try jsonStringLiteral(ctx, source);

    var transformed_source_path: ?[]const u8 = null;
    var transformed_module_source: ?[]const u8 = null;
    const eval_source = if (!print_result and !module_input)
        try std.fmt.allocPrint(
            ctx.allocator,
            \\(async () => {{
            \\{s}
            \\}})().catch((error) => {{
            \\  const message = globalThis.__cottontailFormatUncaughtException?.(error) ?? error?.stack ?? error;
            \\  console.error(typeof message === "string" && message.startsWith("Error:") ? "error:" + message.slice("Error:".length) : message);
            \\  process.exitCode = 1;
            \\}});
            \\
        ,
            .{source},
        )
    else if (!print_result)
        source
    else if (module_input) blk: {
        var transform_error: ?[*:0]u8 = null;
        const transformed = native_transpiler.transformEvalPrintModule(source, &transform_error) catch |err| {
            if (transform_error) |message| {
                defer native_transpiler.ct_transpiler_string_free(message);
                ctx.writeStderr("{s}\nerror: {s}\n", .{ source, std.mem.span(message) });
            }
            return err;
        };
        defer std.heap.c_allocator.free(transformed);
        const source_name = try std.fmt.allocPrint(
            ctx.allocator,
            ".cottontail-eval-source-{x}-{x}.tsx",
            .{ std.hash.Wyhash.hash(2, source), std.mem.readInt(u64, &random_bytes, .little) },
        );
        const source_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, source_name });
        transformed_source_path = source_path;
        transformed_module_source = try ctx.allocator.dupe(u8, transformed);
        break :blk try std.fmt.allocPrint(
            ctx.allocator,
            \\const gc = globalThis.gc;
            \\const __ctPrintNamespace = await import({s});
            \\const __ctPrintResult = __ctPrintNamespace.default;
            \\console.log(typeof __ctPrintResult === "string" ? __ctPrintResult : Array.isArray(__ctPrintResult) ? JSON.stringify(__ctPrintResult) : Bun.inspect(__ctPrintResult));
            \\
        ,
            .{try jsonStringLiteral(ctx, source_path)},
        );
    } else try std.fmt.allocPrint(
        ctx.allocator,
        \\const gc = globalThis.gc;
        \\const __ctPrintResult = eval({s});
        \\console.log(typeof __ctPrintResult === "string" ? __ctPrintResult : Array.isArray(__ctPrintResult) ? JSON.stringify(__ctPrintResult) : Bun.inspect(__ctPrintResult));
        \\
    ,
        .{source_literal},
    );

    const process_eval_source = if (expose_process_eval)
        try std.fmt.allocPrint(
            ctx.allocator,
            "Object.defineProperty(globalThis[\"process\"], \"_eval\", {{ value: {s}, writable: true, configurable: true }});\n",
            .{source_literal},
        )
    else
        "";
    const argv_source = switch (argv_mode) {
        .unchanged => "",
        .omit_entrypoint => "process.argv.splice(1, 1);\n",
        .stdin => "process.argv[1] = \"-\";\n",
    };
    const virtual_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, virtual_name });
    const virtual_url = try std.fmt.allocPrint(ctx.allocator, "file://{s}", .{virtual_path});
    const virtual_namespace_source = try std.fmt.allocPrint(ctx.allocator,
        \\globalThis.__cottontailVirtualModuleNamespaces ??= new Map();
        \\{{
        \\  const __ctVirtualNamespace = {{}};
        \\  Object.defineProperty(__ctVirtualNamespace, Symbol.toStringTag, {{ value: "Module" }});
        \\  globalThis.__cottontailVirtualModuleNamespaces.set({s}, __ctVirtualNamespace);
        \\  globalThis.__cottontailVirtualModuleNamespaces.set({s}, __ctVirtualNamespace);
        \\}}
    , .{ try jsonStringLiteral(ctx, virtual_path), try jsonStringLiteral(ctx, virtual_url) });
    const eval_globals_source = if (try sourceNeedsEvalModuleGlobals(ctx.allocator, source))
        bun_eval_globals_bootstrap
    else
        "";
    // COTTONTAIL-COMPAT: Keep eval on disk for stock JSC and concurrent
    // invocations while exposing Bun's virtual cwd/[eval] identity to
    // import.meta through the compiler's generated-source marker.
    const preamble = try std.mem.concat(ctx.allocator, u8, &.{
        eval_globals_source,
        process_eval_source,
        argv_source,
        virtual_namespace_source,
    });
    const wrapper_source = if (transformed_source_path) |source_path| blk: {
        const module_source = try std.mem.concat(ctx.allocator, u8, &.{ preamble, transformed_module_source.? });
        const marked_module_source = try markVirtualSource(ctx, tmp_dir, virtual_name, module_source);
        try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = source_path, .data = marked_module_source });
        errdefer std.Io.Dir.cwd().deleteFile(ctx.io, source_path) catch {};
        break :blk eval_source;
    } else try std.mem.concat(ctx.allocator, u8, &.{ preamble, eval_source });
    const marked_source = if (transformed_source_path == null)
        try markVirtualSource(ctx, tmp_dir, virtual_name, wrapper_source)
    else
        wrapper_source;
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = wrapper_path, .data = marked_source });
    return .{ .entry_path = wrapper_path, .source_path = transformed_source_path };
}

fn isTestEntrypointPath(path: []const u8) bool {
    const name = std.fs.path.basename(path);
    const extensions = [_][]const u8{ ".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts" };
    const extension = std.fs.path.extension(name);
    if (extension.len == 0) return false;
    const stem = name[0 .. name.len - extension.len];
    const has_test_suffix = std.mem.endsWith(u8, stem, ".test") or
        std.mem.endsWith(u8, stem, "_test") or
        std.mem.endsWith(u8, stem, ".spec") or
        std.mem.endsWith(u8, stem, "_spec");
    if (!has_test_suffix) return false;
    for (extensions) |candidate| {
        if (std.mem.eql(u8, extension, candidate)) return true;
    }
    return false;
}

fn isTestAggregateEntrypointPath(path: []const u8) bool {
    return std.mem.eql(u8, std.fs.path.basename(path), "entry.mjs") and
        std.mem.indexOf(u8, path, "test-aggregate-") != null;
}

fn shouldLoadBunfigTestPreloads(path: []const u8, test_cli_execution: bool) bool {
    _ = path;
    return test_cli_execution;
}

/// Append every quoted ("..." or '...') segment in `text` to `list`,
/// stopping at an unquoted `#` comment marker.
fn appendQuotedStrings(
    allocator: std.mem.Allocator,
    list: *std.ArrayList([]const u8),
    text: []const u8,
) !void {
    var index: usize = 0;
    while (index < text.len) {
        const char = text[index];
        if (char == '"' or char == '\'') {
            const close = std.mem.indexOfScalarPos(u8, text, index + 1, char) orelse break;
            const value = text[index + 1 .. close];
            if (value.len > 0) try list.append(allocator, try allocator.dupe(u8, value));
            index = close + 1;
            continue;
        }
        if (char == '#') break;
        index += 1;
    }
}

/// Extract the `[test]` section's `preload` entries from bunfig.toml text.
/// Handles a quoted string or an array of quoted strings (single- or
/// multi-line), tolerates comments, and ignores everything else.
fn parseBunfigTestPreloads(allocator: std.mem.Allocator, toml: []const u8, include_test_section: bool) ![]const []const u8 {
    var preloads: std.ArrayList([]const u8) = .empty;
    var in_active_section = !include_test_section;
    var in_preload_array = false;
    var lines = std.mem.splitScalar(u8, toml, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trim(u8, raw_line, " \t\r");
        if (in_preload_array) {
            try appendQuotedStrings(allocator, &preloads, line);
            if (std.mem.indexOfScalar(u8, line, ']') != null) in_preload_array = false;
            continue;
        }
        if (line.len == 0 or line[0] == '#') continue;
        if (line[0] == '[') {
            in_active_section = include_test_section and std.mem.eql(u8, line, "[test]");
            continue;
        }
        if (!in_active_section) continue;
        const equals = std.mem.indexOfScalar(u8, line, '=') orelse continue;
        const key = std.mem.trim(u8, line[0..equals], " \t");
        if (!std.mem.eql(u8, key, "preload")) continue;
        const value = std.mem.trim(u8, line[equals + 1 ..], " \t");
        try appendQuotedStrings(allocator, &preloads, value);
        if (value.len > 0 and value[0] == '[' and std.mem.indexOfScalar(u8, value, ']') == null) {
            in_preload_array = true;
        }
    }
    return try preloads.toOwnedSlice(allocator);
}

/// Discover bunfig.toml by walking up from the script's directory and return
/// preload imports resolved relative to the bunfig.toml's directory. Test
/// preloads apply to direct test files and generated multi-file entrypoints.
fn buildBunfigTestPreloadImports(
    ctx: *const Context,
    script_abs: []const u8,
    test_cli_execution: bool,
    exec_args: []const [:0]const u8,
    script_args: []const [:0]const u8,
) ![]const u8 {
    const include_test_section = shouldLoadBunfigTestPreloads(script_abs, test_cli_execution);
    const explicit_config = configPathFromArgs(exec_args) orelse configPathFromArgs(script_args);
    if (explicit_config) |configured| {
        const bunfig_path = if (std.fs.path.isAbsolute(configured))
            configured
        else
            try std.fs.path.join(ctx.allocator, &.{ ctx.project_root, configured });
        const contents = std.Io.Dir.cwd().readFileAlloc(
            ctx.io,
            bunfig_path,
            ctx.allocator,
            .limited(1024 * 1024),
        ) catch return "";
        const config_dir = std.fs.path.dirname(bunfig_path) orelse ctx.project_root;
        return buildBunfigPreloadImports(ctx, contents, config_dir, include_test_section);
    }

    var dir: ?[]const u8 = std.fs.path.dirname(script_abs);
    while (dir) |current| : (dir = std.fs.path.dirname(current)) {
        const bunfig_path = try std.fs.path.join(ctx.allocator, &.{ current, "bunfig.toml" });
        const contents = std.Io.Dir.cwd().readFileAlloc(
            ctx.io,
            bunfig_path,
            ctx.allocator,
            .limited(1024 * 1024),
        ) catch continue;

        // The nearest bunfig.toml wins, matching bun's discovery.
        return buildBunfigPreloadImports(ctx, contents, current, include_test_section);
    }
    return "";
}

fn configPathFromArgs(args: []const [:0]const u8) ?[]const u8 {
    var index: usize = 0;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.startsWith(u8, arg, "--config=")) return arg["--config=".len..];
        if (std.mem.startsWith(u8, arg, "-c=")) return arg["-c=".len..];
        if ((std.mem.eql(u8, arg, "--config") or std.mem.eql(u8, arg, "-c")) and index + 1 < args.len) {
            return args[index + 1];
        }
    }
    return null;
}

fn buildBunfigPreloadImports(
    ctx: *const Context,
    contents: []const u8,
    config_dir: []const u8,
    include_test_section: bool,
) ![]const u8 {
    const preloads = try parseBunfigTestPreloads(ctx.allocator, contents, include_test_section);
    var imports: std.ArrayList(u8) = .empty;
    for (preloads) |preload| {
        const is_path = std.fs.path.isAbsolute(preload) or std.mem.startsWith(u8, preload, ".");
        const preload_specifier = if (std.fs.path.isAbsolute(preload) or !is_path)
            preload
        else
            try std.fs.path.join(ctx.allocator, &.{ config_dir, preload });
        if (is_path and !preloadPathExists(ctx, preload_specifier)) {
            try imports.appendSlice(ctx.allocator, "console.error('error: preload not found ' + ");
            try imports.appendSlice(ctx.allocator, try jsonStringLiteral(ctx, preload));
            try imports.appendSlice(ctx.allocator, "); globalThis.process?.exit?.(1);\n");
            continue;
        }
        try imports.appendSlice(ctx.allocator, "globalThis.__cottontailTestRegistrationLayer = (globalThis.__cottontailTestRegistrationLayer ?? 0) + 1;\n");
        try imports.appendSlice(ctx.allocator, "await import(");
        try imports.appendSlice(ctx.allocator, try jsonStringLiteral(ctx, preload_specifier));
        try imports.appendSlice(ctx.allocator, ");\n");
    }
    return try imports.toOwnedSlice(ctx.allocator);
}

const PreloadArgumentKind = enum { preload, require, import };

fn appendCliPreloadKind(
    ctx: *const Context,
    output: *std.ArrayList(u8),
    args: []const [:0]const u8,
    kind: PreloadArgumentKind,
) !void {
    var index: usize = 0;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        var specifier: ?[]const u8 = null;
        switch (kind) {
            .preload => {
                if (std.mem.eql(u8, arg, "--preload") and index + 1 < args.len) {
                    index += 1;
                    specifier = args[index];
                } else if (std.mem.startsWith(u8, arg, "--preload=")) {
                    specifier = arg["--preload=".len..];
                }
            },
            .require => {
                if ((std.mem.eql(u8, arg, "-r") or std.mem.eql(u8, arg, "--require")) and index + 1 < args.len) {
                    index += 1;
                    specifier = args[index];
                } else if (std.mem.startsWith(u8, arg, "--require=")) {
                    specifier = arg["--require=".len..];
                }
            },
            .import => {
                if (std.mem.eql(u8, arg, "--import") and index + 1 < args.len) {
                    index += 1;
                    specifier = args[index];
                } else if (std.mem.startsWith(u8, arg, "--import=")) {
                    specifier = arg["--import=".len..];
                }
            },
        }
        if (specifier) |raw_specifier| {
            const resolved_specifier = if (std.mem.startsWith(u8, raw_specifier, "."))
                try std.fs.path.join(ctx.allocator, &.{ ctx.project_root, raw_specifier })
            else
                raw_specifier;
            try output.appendSlice(ctx.allocator, "globalThis.__cottontailTestRegistrationLayer = (globalThis.__cottontailTestRegistrationLayer ?? 0) + 1;\nawait import(");
            try output.appendSlice(ctx.allocator, try jsonStringLiteral(ctx, resolved_specifier));
            try output.appendSlice(ctx.allocator, ");\n");
        }
    }
}

fn buildCliPreloadImports(ctx: *const Context, script_abs: []const u8, exec_args: []const [:0]const u8, include_inspect_preload: bool) ![]const u8 {
    var output: std.ArrayList(u8) = .empty;
    _ = script_abs;
    try appendCliPreloadKind(ctx, &output, exec_args, .preload);
    try appendCliPreloadKind(ctx, &output, exec_args, .require);
    try appendCliPreloadKind(ctx, &output, exec_args, .import);
    if (include_inspect_preload) {
        if (ctx.environ_map.get("BUN_INSPECT_PRELOAD")) |inspect_preload| {
            const inspect_args = [_][:0]const u8{
                "--import",
                try ctx.allocator.dupeZ(u8, inspect_preload),
            };
            try appendCliPreloadKind(ctx, &output, &inspect_args, .import);
        }
    }
    return try output.toOwnedSlice(ctx.allocator);
}

fn writeReusedReloadEntryWrapper(
    ctx: *const Context,
    tmp_dir: []const u8,
    script_import_abs: []const u8,
    script_abs: []const u8,
    test_cli_execution: bool,
) ![]const u8 {
    const wrapper_name = try std.fmt.allocPrint(
        ctx.allocator,
        "script-entry-reload-{x}.mjs",
        .{std.hash.Wyhash.hash(0, script_abs)},
    );
    const wrapper_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, wrapper_name });
    const test_header_signal = if (test_cli_execution)
        "globalThis.__cottontailBunTestHeaderPrinted = true;"
    else
        "";
    const source = try std.fmt.allocPrint(ctx.allocator,
        \\globalThis.__cottontailLoadingTestModules = true;
        \\try {{
        \\  {s}
        \\  globalThis.__cottontailTestRegistrationLayer = (globalThis.__cottontailTestRegistrationLayer ?? 0) + 1;
        \\  await import({s});
        \\}} finally {{
        \\  globalThis.__cottontailLoadingTestModules = false;
        \\  globalThis[Symbol.for("cottontail.internal.startTestRun")]?.();
        \\}}
        \\
    , .{
        test_header_signal,
        try jsonStringLiteral(ctx, script_import_abs),
    });
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = wrapper_path, .data = source });
    return wrapper_path;
}

fn writeMinimalRuntimeEntryWrapper(
    ctx: *const Context,
    tmp_dir: []const u8,
    script_import_abs: []const u8,
    script_abs: []const u8,
    preload_imports: []const u8,
    test_cli_execution: bool,
    stable_source_map_path: bool,
    runtime_virtual_root: []const u8,
    bootstrap_mode: RuntimeBootstrapMode,
) ![]const u8 {
    std.debug.assert(bootstrap_mode != .full);
    const process_bootstrap_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "internal", "runtime-process-bootstrap.js" });
    const bootstrap_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "internal", "runtime-bootstrap.js" });
    const url_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "url.js" });
    const process_import = if (bootstrap_mode == .process) blk: {
        const process_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "process.js" });
        break :blk try std.fmt.allocPrint(
            ctx.allocator,
            "import __ctFullProcess from {s};\n",
            .{try jsonStringLiteral(ctx, process_module)},
        );
    } else "";
    const ipc_bootstrap_import = if (ctx.environ_map.get("COTTONTAIL_IPC_BOOTSTRAP")) |mode| blk: {
        if (!std.mem.eql(u8, mode, "node")) break :blk "";
        const child_process_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "child_process.js" });
        break :blk try std.fmt.allocPrint(
            ctx.allocator,
            "import {s};\n",
            .{try jsonStringLiteral(ctx, child_process_module)},
        );
    } else "";
    const process_install = if (bootstrap_mode == .process)
        "globalThis.process = __ctFullProcess;"
    else
        "";
    const wrapper_name = try std.fmt.allocPrint(
        ctx.allocator,
        "script-entry-minimal-{x}.mjs",
        .{std.hash.Wyhash.hash(0, script_abs)},
    );
    const wrapper_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, wrapper_name });
    const bundle_map_literal = if (stable_source_map_path)
        "\"\""
    else blk: {
        const bundle_map_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "script.bundle.mjs.map" });
        break :blk try jsonStringLiteral(ctx, bundle_map_path);
    };
    const script_dir = std.fs.path.dirname(script_abs) orelse ctx.project_root;
    const test_header_signal = if (test_cli_execution)
        "globalThis.__cottontailBunTestHeaderPrinted = true;"
    else
        "";
    const source = try std.fmt.allocPrint(ctx.allocator,
        \\import {s};
        \\import {{ installRuntimeBootstrap as __ctInstallRuntimeBootstrap }} from {s};
        \\import {{ fileURLToPath as __ctFileURLToPath, pathToFileURL as __ctPathToFileURL }} from {s};
        \\{s}
        \\{s}
        \\__ctInstallRuntimeBootstrap({{ fileURLToPath: __ctFileURLToPath, pathToFileURL: __ctPathToFileURL }});
        \\{s}
        \\globalThis.__cottontailBundleSourceMap ??= {s};
        \\globalThis.__cottontailBundleSourceRoot ??= {s};
        \\globalThis.__filename ??= {s};
        \\globalThis.__dirname ??= {s};
        \\globalThis.Loader ??= {{ registry: new Map() }};
        \\{s}
        \\globalThis.__cottontailLoadDotenv?.();
        \\await globalThis.__cottontailLoadStandaloneBunfig?.();
        \\await globalThis.__cottontailLoadStandaloneExecPreloads?.();
        \\globalThis.__cottontailLoadingTestModules = true;
        \\try {{
        \\{s}
        \\{s}  globalThis.__cottontailTestRegistrationLayer = (globalThis.__cottontailTestRegistrationLayer ?? 0) + 1;
        \\  await import({s});
        \\}} finally {{
        \\  globalThis.__cottontailLoadingTestModules = false;
        \\  globalThis[Symbol.for("cottontail.internal.startTestRun")]?.();
        \\}}
        \\
    , .{
        try jsonStringLiteral(ctx, process_bootstrap_module),
        try jsonStringLiteral(ctx, bootstrap_module),
        try jsonStringLiteral(ctx, url_module),
        process_import,
        ipc_bootstrap_import,
        process_install,
        bundle_map_literal,
        try jsonStringLiteral(ctx, ctx.project_root),
        try jsonStringLiteral(ctx, script_abs),
        try jsonStringLiteral(ctx, script_dir),
        test_header_signal,
        cpu_profiler_start_statement,
        preload_imports,
        try jsonStringLiteral(ctx, script_import_abs),
    });
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = wrapper_path, .data = source });
    return wrapper_path;
}

fn writeCottontailEntryWrapper(
    ctx: *const Context,
    tmp_dir: []const u8,
    script_import_abs: []const u8,
    script_abs: []const u8,
    preload_imports: []const u8,
    test_cli_execution: bool,
    stable_source_map_path: bool,
    bootstrap_mode: RuntimeBootstrapMode,
) ![]const u8 {
    if (bootstrap_mode != .full) return writeMinimalRuntimeEntryWrapper(
        ctx,
        tmp_dir,
        script_import_abs,
        script_abs,
        preload_imports,
        test_cli_execution,
        stable_source_map_path,
        ctx.project_root,
        bootstrap_mode,
    );
    const bun_module = try runtimeModulePath(ctx, &.{ "bun", "index.js" });
    const bake_dev_server_module = try runtimeModulePath(ctx, &.{ "bun", "bake-dev-server.js" });
    const wrapper_name = try std.fmt.allocPrint(
        ctx.allocator,
        "script-entry-{x}.mjs",
        .{std.hash.Wyhash.hash(0, script_abs)},
    );
    const wrapper_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, wrapper_name });
    const bun_literal = try jsonStringLiteral(ctx, bun_module);
    const bake_dev_server_literal = try jsonStringLiteral(ctx, bake_dev_server_module);
    const script_import_literal = try jsonStringLiteral(ctx, script_import_abs);
    const script_literal = try jsonStringLiteral(ctx, script_abs);
    const script_dir = std.fs.path.dirname(script_abs) orelse ctx.project_root;
    const script_dir_literal = try jsonStringLiteral(ctx, script_dir);
    const test_header_signal = if (test_cli_execution)
        "globalThis.__cottontailBunTestHeaderPrinted = true;"
    else
        "";
    const bundle_map_literal = if (stable_source_map_path)
        "\"\""
    else blk: {
        const bundle_map_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "script.bundle.mjs.map" });
        break :blk try jsonStringLiteral(ctx, bundle_map_path);
    };
    const bundle_source_root_literal = try jsonStringLiteral(ctx, ctx.project_root);
    // COTTONTAIL-COMPAT: Standalone import-meta resolution starts at the
    // serialized graph entry; ordinary runs retain the source entry path.
    const source = try std.fmt.allocPrint(
        ctx.allocator,
        \\import __ctBunModule from {s};
        \\import {{ startDefaultApp as __ctStartDefaultApp }} from {s};
        \\import {{ createRequire as __ctCreateRequire }} from "node:module";
        \\import {{ existsSync as __ctExistsSync }} from "node:fs";
        \\import {{ dirname as __ctPathDirname, resolve as __ctPathResolve }} from "node:path";
        \\globalThis.__cottontailBundleSourceMap ??= {s};
        \\globalThis.__cottontailBundleSourceRoot ??= {s};
        \\globalThis.__filename ??= {s};
        \\globalThis.__dirname ??= {s};
        \\globalThis.Loader ??= {{ registry: new Map() }};
        \\const __ctImportMetaBase = globalThis.__cottontailStandaloneFiles == null ? {s} : import.meta.path;
        \\const __ctImportMetaParentDir = (parent) => {{
        \\  let text = String(parent);
        \\  if (text.startsWith("file:")) text = __ctBunModule.fileURLToPath(text);
        \\  return __ctPathDirname(text);
        \\}};
        \\const __ctResolveImportMetaTypeScript = (specifier, parent) => {{
        \\  const text = String(specifier);
        \\  if (!text.startsWith(".") && !text.startsWith("/")) return undefined;
        \\  const extension = text.endsWith(".mjs") ? ".mjs" : text.endsWith(".jsx") ? ".jsx" : text.endsWith(".js") ? ".js" : "";
        \\  if (!extension) return undefined;
        \\  const absolute = __ctPathResolve(__ctImportMetaParentDir(parent), text);
        \\  const stem = absolute.slice(0, -extension.length);
        \\  for (const replacement of extension === ".mjs" ? [".mts"] : [".ts", ".tsx", ".mts"]) {{
        \\    const candidate = stem + replacement;
        \\    if (__ctExistsSync(candidate)) return candidate;
        \\  }}
        \\  return undefined;
        \\}};
        \\globalThis.__cottontailImportMetaResolveSync = (specifier, parent = __ctImportMetaBase) => {{
        \\  const text = String(specifier);
        \\  if (text.startsWith("node:") || text.startsWith("bun:")) return text;
        \\  try {{ return __ctBunModule.resolveSync(text, __ctImportMetaParentDir(parent)); }}
        \\  catch (error) {{
        \\    const rewritten = __ctResolveImportMetaTypeScript(text, parent);
        \\    if (rewritten !== undefined) return rewritten;
        \\    if (error && (typeof error === "object" || typeof error === "function")) error.referrer = String(parent);
        \\    throw error;
        \\  }}
        \\}};
        \\globalThis.__cottontailImportMetaResolve = (specifier, parent = __ctImportMetaBase) => {{
        \\  const text = String(specifier);
        \\  if (text.startsWith("node:") || text.startsWith("bun:") || text.startsWith("file:")) return text;
        \\  if (text.startsWith(".") || text.startsWith("/")) {{
        \\    return new URL(text, __ctBunModule.pathToFileURL(parent).href).href;
        \\  }}
        \\  const resolved = __ctBunModule.resolveSync(text, __ctImportMetaParentDir(parent));
        \\  return resolved.startsWith("/") ? __ctBunModule.pathToFileURL(resolved).href : resolved;
        \\}};
        \\globalThis.__ctMetaRequire ??= __ctCreateRequire(__ctImportMetaBase);
        \\globalThis.require = globalThis.__ctMetaRequire;
        \\globalThis.__ctMetaResolveSync = (specifier, parent = __ctImportMetaBase) => globalThis.__cottontailImportMetaResolveSync(specifier, parent);
        \\globalThis.__ctMetaResolve = (specifier, parent = __ctImportMetaBase) => globalThis.__cottontailImportMetaResolve(specifier, parent);
        \\{s}
        \\globalThis.__cottontailLoadDotenv?.();
        \\await globalThis.__cottontailLoadStandaloneBunfig?.();
        \\await globalThis.__cottontailLoadStandaloneExecPreloads?.();
        \\globalThis.__cottontailLoadingTestModules = true;
        \\try {{
        \\{s}
        \\{s}  globalThis.__cottontailTestRegistrationLayer = (globalThis.__cottontailTestRegistrationLayer ?? 0) + 1;
        \\  const __ctPluginEntry = await globalThis.__cottontailResolvePluginEntrypoint?.({s}, {s});
        \\  const __ctEntryNamespace = __ctPluginEntry?.matched ? await __ctPluginEntry.value : await import({s});
        \\  __ctStartDefaultApp(__ctEntryNamespace);
        \\}} finally {{
        \\  globalThis.__cottontailLoadingTestModules = false;
        \\  globalThis[Symbol.for("cottontail.internal.startTestRun")]?.();
        \\}}
        \\
    ,
        .{
            bun_literal,
            bake_dev_server_literal,
            bundle_map_literal,
            bundle_source_root_literal,
            script_literal,
            script_dir_literal,
            script_literal,
            test_header_signal,
            cpu_profiler_start_statement,
            preload_imports,
            script_literal,
            script_literal,
            script_import_literal,
        },
    );
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = wrapper_path, .data = source });
    return wrapper_path;
}

fn writeWasiEntryWrapper(
    ctx: *const Context,
    tmp_dir: []const u8,
    script_abs: []const u8,
) ![]const u8 {
    const wrapper_name = try std.fmt.allocPrint(
        ctx.allocator,
        "script-entry-wasi-{x}.mjs",
        .{std.hash.Wyhash.hash(0, script_abs)},
    );
    const wrapper_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, wrapper_name });
    const script_literal = try jsonStringLiteral(ctx, script_abs);
    const source = try std.fmt.allocPrint(ctx.allocator,
        \\import {{ readFileSync }} from "node:fs";
        \\import {{ WASI }} from "node:wasi";
        \\{s}
        \\const __ctWasi = new WASI({{ version: "preview1", args: process.argv.slice(1), env: process.env }});
        \\const __ctWasmModule = new WebAssembly.Module(readFileSync({s}));
        \\const __ctWasiImports = {{
        \\  wasi_snapshot_preview1: __ctWasi.wasiImport,
        \\  wasi_unstable: __ctWasi.wasiImport,
        \\}};
        \\const __ctWasmInstance = new WebAssembly.Instance(__ctWasmModule, __ctWasiImports);
        \\__ctWasi.start(__ctWasmInstance);
        \\
    , .{ cpu_profiler_start_statement, script_literal });
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = wrapper_path, .data = source });
    return wrapper_path;
}

fn cleanupGeneratedSource(ctx: *const Context, generated_path: []const u8, original_path: []const u8) void {
    if (std.mem.eql(u8, generated_path, original_path)) return;
    if (isTestAggregateEntrypointPath(original_path)) {
        const source = std.Io.Dir.cwd().readFileAlloc(
            ctx.io,
            generated_path,
            ctx.allocator,
            .limited(16 * 1024 * 1024),
        ) catch null;
        if (source) |contents| cleanupGeneratedTestDependencies(ctx, contents);
    }
    std.Io.Dir.cwd().deleteFile(ctx.io, generated_path) catch {};
}

const generated_test_dependency_marker = "/*@cottontail-generated-test-dependency-base64:";

fn cleanupGeneratedTestDependencies(ctx: *const Context, source: []const u8) void {
    var cursor: usize = 0;
    while (std.mem.indexOfPos(u8, source, cursor, generated_test_dependency_marker)) |start| {
        const encoded_start = start + generated_test_dependency_marker.len;
        const encoded_end = std.mem.indexOfPos(u8, source, encoded_start, "*/") orelse return;
        cursor = encoded_end + 2;
        const encoded = source[encoded_start..encoded_end];
        const decoded_len = std.base64.standard.Decoder.calcSizeForSlice(encoded) catch continue;
        const path = ctx.allocator.alloc(u8, decoded_len) catch continue;
        std.base64.standard.Decoder.decode(path, encoded) catch continue;
        if (std.mem.startsWith(u8, std.fs.path.basename(path), ".cottontail-compat-")) {
            std.Io.Dir.cwd().deleteFile(ctx.io, path) catch {};
        }
    }
}

const EmptyMetadataPatch = struct {
    path: []const u8 = "",
    original: []const u8 = "",
    active: bool = false,
};

fn maybePatchEmptyPackageJsonForBundle(ctx: *const Context, script_dir: []const u8) !EmptyMetadataPatch {
    const package_json = try std.fs.path.join(ctx.allocator, &.{ script_dir, "package.json" });
    const original = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        package_json,
        ctx.allocator,
        .limited(1024 * 1024),
    ) catch |err| switch (err) {
        error.FileNotFound => return .{},
        else => return err,
    };
    if (std.mem.trim(u8, original, " \t\r\n").len != 0) return .{};
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = package_json, .data = "{}\n" });
    return .{ .path = package_json, .original = original, .active = true };
}

fn metadataFileIsEmpty(ctx: *const Context, script_dir: []const u8, basename: []const u8) !bool {
    const path = try std.fs.path.join(ctx.allocator, &.{ script_dir, basename });
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        path,
        ctx.allocator,
        .limited(1024 * 1024),
    ) catch |err| switch (err) {
        error.FileNotFound => return false,
        else => return err,
    };
    return std.mem.trim(u8, source, " \t\r\n").len == 0;
}

fn restoreEmptyMetadataPatch(ctx: *const Context, patch: *EmptyMetadataPatch) void {
    if (!patch.active) return;
    std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = patch.path, .data = patch.original }) catch {};
    patch.active = false;
}

fn rewriteLegacyHtmlClosingComments(allocator: std.mem.Allocator, source: []const u8) !?[]u8 {
    var rewritten = try allocator.dupe(u8, source);
    var changed = false;
    var line_start: usize = 0;
    while (line_start < rewritten.len) {
        var cursor = line_start;
        while (cursor < rewritten.len and (rewritten[cursor] == ' ' or rewritten[cursor] == '\t')) cursor += 1;
        if (cursor + 3 <= rewritten.len and std.mem.eql(u8, rewritten[cursor .. cursor + 3], "-->")) {
            rewritten[cursor] = '/';
            rewritten[cursor + 1] = '/';
            changed = true;
        }
        const newline = std.mem.indexOfScalarPos(u8, rewritten, line_start, '\n') orelse break;
        line_start = newline + 1;
    }
    return if (changed) rewritten else null;
}

fn sourceIsStrictDirectiveOnly(allocator: std.mem.Allocator, source: []const u8) !bool {
    const tokens = try tokenizeJavaScriptModuleSyntax(allocator, source);
    defer allocator.free(tokens);
    if (tokens.len == 0) return false;

    var has_strict = false;
    var index: usize = 0;
    while (index < tokens.len) {
        if (tokens[index].kind != .string) return false;
        has_strict = has_strict or std.mem.eql(u8, tokens[index].text, "use strict");
        index += 1;
        if (index < tokens.len and tokenIs(tokens[index], .punct, ";")) index += 1;
    }
    return has_strict;
}

const SelfNamespaceExport = struct {
    exported_name: []const u8,
    local_name: []const u8,
};

fn appendSelfNamespaceExport(
    allocator: std.mem.Allocator,
    exports: *std.ArrayList(SelfNamespaceExport),
    exported_name: []const u8,
    local_name: []const u8,
) !void {
    for (exports.items) |item| {
        if (std.mem.eql(u8, item.exported_name, exported_name)) return;
    }
    try exports.append(allocator, .{ .exported_name = exported_name, .local_name = local_name });
}

fn collectSelfNamespaceExports(
    allocator: std.mem.Allocator,
    source: []const u8,
) ![]SelfNamespaceExport {
    const tokens = try tokenizeJavaScriptModuleSyntax(allocator, source);
    defer allocator.free(tokens);
    var exports: std.ArrayList(SelfNamespaceExport) = .empty;

    var index: usize = 0;
    while (index + 1 < tokens.len) : (index += 1) {
        if (!tokenIs(tokens[index], .identifier, "export")) continue;
        const next = tokens[index + 1];
        if (next.kind == .identifier and
            (std.mem.eql(u8, next.text, "const") or
                std.mem.eql(u8, next.text, "let") or
                std.mem.eql(u8, next.text, "var") or
                std.mem.eql(u8, next.text, "function") or
                std.mem.eql(u8, next.text, "class")))
        {
            if (index + 2 < tokens.len and tokens[index + 2].kind == .identifier) {
                try appendSelfNamespaceExport(allocator, &exports, tokens[index + 2].text, tokens[index + 2].text);
            }
            continue;
        }
        if (!tokenIs(next, .punct, "{")) continue;
        const close = closingModuleClause(tokens, index + 1) orelse continue;
        var item = index + 2;
        while (item < close) {
            if (tokenIs(tokens[item], .punct, ",")) {
                item += 1;
                continue;
            }
            if (tokens[item].kind != .identifier and tokens[item].kind != .string) break;
            const local_name = tokens[item].text;
            var exported_name = local_name;
            item += 1;
            if (item + 1 < close and tokenIs(tokens[item], .identifier, "as")) {
                exported_name = tokens[item + 1].text;
                item += 2;
            }
            try appendSelfNamespaceExport(allocator, &exports, exported_name, local_name);
            while (item < close and !tokenIs(tokens[item], .punct, ",")) item += 1;
        }
        index = close;
    }
    return try exports.toOwnedSlice(allocator);
}

fn rewriteSelfNamespaceImports(
    ctx: *const Context,
    source: []const u8,
    source_path: []const u8,
    resolution_dir: []const u8,
) !?[]u8 {
    const exports = try collectSelfNamespaceExports(ctx.allocator, source);
    var output: std.ArrayList(u8) = .empty;
    var copied_until: usize = 0;
    var changed = false;
    var cursor: usize = 0;

    while (cursor < source.len) {
        if (source[cursor] == '\'' or source[cursor] == '"' or source[cursor] == '`') {
            cursor = skipQuotedJavaScript(source, cursor);
            continue;
        }
        if (source[cursor] == '/') {
            const after_comment = skipJavaScriptComment(source, cursor);
            if (after_comment != cursor) {
                cursor = after_comment;
                continue;
            }
        }
        if (!std.mem.startsWith(u8, source[cursor..], "import") or
            (cursor > 0 and isIdentifierPart(source[cursor - 1])) or
            (cursor + "import".len < source.len and isIdentifierPart(source[cursor + "import".len])))
        {
            cursor += 1;
            continue;
        }

        const clause_start = skipWhitespace(source, cursor + "import".len);
        if (clause_start >= source.len or source[clause_start] != '*') {
            cursor += "import".len;
            continue;
        }
        var specifier_start = clause_start;
        while (specifier_start < source.len and source[specifier_start] != '\'' and source[specifier_start] != '"') : (specifier_start += 1) {}
        if (specifier_start >= source.len) break;
        const specifier_end = skipQuotedJavaScript(source, specifier_start);
        const semicolon = std.mem.indexOfScalarPos(u8, source, specifier_end, ';') orelse {
            cursor = specifier_end;
            continue;
        };
        const specifier = (try decodeJavaScriptStringPrefix(ctx.allocator, source[specifier_start..specifier_end])) orelse {
            cursor = semicolon + 1;
            continue;
        };
        const target_path = (try resolveDynamicImportTarget(ctx, resolution_dir, specifier)) orelse {
            cursor = semicolon + 1;
            continue;
        };
        if (!std.mem.eql(u8, target_path, source_path)) {
            cursor = semicolon + 1;
            continue;
        }

        const clause = std.mem.trim(u8, source[clause_start..specifier_start], " \t\r\n");
        if (!std.mem.endsWith(u8, clause, "from")) {
            cursor = semicolon + 1;
            continue;
        }
        const namespace_clause = std.mem.trim(u8, clause[0 .. clause.len - "from".len], " \t\r\n");
        const after_star = std.mem.trim(u8, namespace_clause[1..], " \t\r\n");
        if (!std.mem.startsWith(u8, after_star, "as")) {
            cursor = semicolon + 1;
            continue;
        }
        const binding = std.mem.trim(u8, after_star["as".len..], " \t\r\n");
        if (binding.len == 0 or !isIdentifierStart(binding[0])) {
            cursor = semicolon + 1;
            continue;
        }
        var valid_binding = true;
        for (binding[1..]) |byte| {
            if (!isIdentifierPart(byte)) valid_binding = false;
        }
        if (!valid_binding) {
            cursor = semicolon + 1;
            continue;
        }

        try output.appendSlice(ctx.allocator, source[copied_until..cursor]);
        try output.appendSlice(ctx.allocator, "const ");
        try output.appendSlice(ctx.allocator, binding);
        try output.appendSlice(ctx.allocator, " = {}; Object.defineProperty(");
        try output.appendSlice(ctx.allocator, binding);
        try output.appendSlice(ctx.allocator, ", Symbol.toStringTag, { value: \"Module\" });\n");
        for (exports) |item| {
            try output.appendSlice(ctx.allocator, "Object.defineProperty(");
            try output.appendSlice(ctx.allocator, binding);
            try output.appendSlice(ctx.allocator, ", ");
            try output.appendSlice(ctx.allocator, try jsonStringLiteral(ctx, item.exported_name));
            try output.appendSlice(ctx.allocator, ", { enumerable: true, get: () => ");
            try output.appendSlice(ctx.allocator, item.local_name);
            try output.appendSlice(ctx.allocator, " });\n");
        }
        copied_until = semicolon + 1;
        cursor = copied_until;
        changed = true;
    }

    if (!changed) return null;
    try output.appendSlice(ctx.allocator, source[copied_until..]);
    return try output.toOwnedSlice(ctx.allocator);
}

fn writeBunCompatTransformedSource(
    ctx: *const Context,
    script_abs: []const u8,
    source_base_dir: ?[]const u8,
    preserve_static_html_imports: bool,
) anyerror![]const u8 {
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        script_abs,
        ctx.allocator,
        .limited(4 * 1024 * 1024),
    ) catch return script_abs;
    var transformed_source: []const u8 = source;
    var changed = false;
    // Rewrites can prepend compatibility helpers, so neutralize the hashbang
    // while it is still guaranteed to be the first line of the source.
    if (std.mem.startsWith(u8, transformed_source, "#!")) {
        const stripped = try ctx.allocator.dupe(u8, transformed_source);
        stripped[0] = '/';
        stripped[1] = '/';
        transformed_source = stripped;
        changed = true;
    }
    if (isTestAggregateEntrypointPath(script_abs)) {
        if (try rewriteTestAggregateImports(ctx, transformed_source, preserve_static_html_imports)) |transformed| {
            transformed_source = transformed;
            changed = true;
        }
    }
    const has_bun_transpiled_pragma = hasBunTranspiledPragma(source);
    const cjs_top_level_await = (std.mem.endsWith(u8, script_abs, ".cjs") or
        std.mem.endsWith(u8, script_abs, ".cts")) and
        try entrypointHasTopLevelAwait(ctx, script_abs);
    if (cjs_top_level_await) changed = true;
    if (bunCjsFactorySource(source)) |factory| {
        transformed_source = try std.mem.concat(ctx.allocator, u8, &.{
            "const __ctBunCjsFactory = ",
            factory,
            ";\n__ctBunCjsFactory(exports, require, module, __filename, __dirname);\n",
        });
        changed = true;
    }
    // A `// @bun` artifact is already JavaScript even when its filename ends
    // in `.ts`. Give the compiler a generated `.js` path so type syntax is
    // rejected instead of silently stripped.
    if (has_bun_transpiled_pragma) changed = true;
    if (std.mem.indexOf(u8, transformed_source, ".__esModule") != null) {
        if (try rewriteNamespaceEsModuleAssignments(ctx.allocator, transformed_source)) |transformed| {
            transformed_source = transformed;
            changed = true;
        }
    }
    if (try rewriteLegacyHtmlClosingComments(ctx.allocator, transformed_source)) |transformed| {
        transformed_source = transformed;
        changed = true;
    }
    if (try sourceIsStrictDirectiveOnly(ctx.allocator, transformed_source)) {
        transformed_source = try std.mem.concat(ctx.allocator, u8, &.{ transformed_source, "\nvoid 0;\n" });
        changed = true;
    }

    var import_meta_main_source: ?[]u8 = null;
    defer if (import_meta_main_source) |value| std.heap.c_allocator.free(value);
    if (std.mem.indexOf(u8, transformed_source, "import.meta.main") != null or
        std.mem.indexOf(u8, transformed_source, "require.main") != null)
    {
        if (transpilerLoaderForPath(script_abs)) |loader| {
            const transformed = try native_transpiler.transformEntrypointImportMetaMain(transformed_source, loader);
            import_meta_main_source = transformed;
            transformed_source = transformed;
            changed = true;
        }
    }

    const resolution_dir = source_base_dir orelse std.fs.path.dirname(script_abs) orelse ctx.project_root;
    if (try rewriteSelfNamespaceImports(ctx, transformed_source, script_abs, resolution_dir)) |transformed| {
        transformed_source = transformed;
        changed = true;
    }
    if (try rewriteQueryImports(
        ctx,
        transformed_source,
        resolution_dir,
        transpilerLoaderForPath(script_abs),
        preserve_static_html_imports,
    )) |transformed| {
        transformed_source = transformed;
        changed = true;
    }
    // Bun treats extensionless entrypoints as TypeScript, so rewrite them into
    // a generated .ts file before invoking the compiler.
    const extensionless = std.fs.path.extension(script_abs).len == 0;
    if (extensionless) changed = true;
    if (!changed) return script_abs;

    const script_dir = std.fs.path.dirname(script_abs) orelse ctx.project_root;
    const ext = blk: {
        const value = std.fs.path.extension(script_abs);
        break :blk if (has_bun_transpiled_pragma)
            ".js"
        else if (cjs_top_level_await)
            if (std.mem.eql(u8, value, ".cts")) ".mts" else ".mjs"
        else if (value.len == 0)
            ".ts"
        else
            value;
    };
    var invocation_bytes: [8]u8 = undefined;
    ctx.io.random(&invocation_bytes);
    const generated_name = try std.fmt.allocPrint(
        ctx.allocator,
        ".cottontail-compat-{x}-{x}{s}",
        .{ std.hash.Wyhash.hash(0, source), std.hash.Wyhash.hash(0, &invocation_bytes), ext },
    );
    const generated_path = try std.fs.path.join(ctx.allocator, &.{ script_dir, generated_name });
    const script_name = std.fs.path.basename(script_abs);
    const generated_input = std.mem.startsWith(u8, script_name, ".cottontail-eval-") or
        std.mem.startsWith(u8, script_name, ".cottontail-compat-");
    const original_path = if (generated_input)
        (try originalPathFromSourceMarker(ctx.allocator, source)) orelse script_abs
    else
        script_abs;
    const encoder = std.base64.standard.Encoder;
    const encoded_path = try ctx.allocator.alloc(u8, encoder.calcSize(original_path.len));
    const encoded = encoder.encode(encoded_path, original_path);
    const generated_source = try std.mem.concat(ctx.allocator, u8, &.{
        "/*@cottontail-original-path-base64:",
        encoded,
        "*/",
        transformed_source,
    });
    std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = generated_path, .data = generated_source }) catch return script_abs;
    return generated_path;
}

fn rewriteTestAggregateImports(
    ctx: *const Context,
    source: []const u8,
    preserve_static_html_imports: bool,
) anyerror!?[]u8 {
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(ctx.allocator);
    var generated_paths: std.ArrayList([]const u8) = .empty;
    defer generated_paths.deinit(ctx.allocator);
    var copied_until: usize = 0;
    var cursor: usize = 0;

    while (cursor < source.len) {
        if (!std.mem.startsWith(u8, source[cursor..], "import") or
            (cursor > 0 and isIdentifierPart(source[cursor - 1])) or
            (cursor + "import".len < source.len and isIdentifierPart(source[cursor + "import".len])))
        {
            cursor += 1;
            continue;
        }
        const quote_start = skipWhitespace(source, cursor + "import".len);
        if (quote_start >= source.len or (source[quote_start] != '\'' and source[quote_start] != '"')) {
            cursor += "import".len;
            continue;
        }
        const quote_end = skipQuotedJavaScript(source, quote_start);
        if (quote_end > source.len) break;
        const specifier = (try decodeJavaScriptStringPrefix(ctx.allocator, source[quote_start..quote_end])) orelse {
            cursor = quote_end;
            continue;
        };
        if (!std.fs.path.isAbsolute(specifier) or !isTestEntrypointPath(specifier)) {
            cursor = quote_end;
            continue;
        }

        const transformed_path = try writeBunCompatTransformedSource(
            ctx,
            specifier,
            null,
            preserve_static_html_imports,
        );
        if (std.mem.eql(u8, transformed_path, specifier)) {
            cursor = quote_end;
            continue;
        }
        try output.appendSlice(ctx.allocator, source[copied_until..quote_start]);
        try output.appendSlice(ctx.allocator, try jsonStringLiteral(ctx, transformed_path));
        copied_until = quote_end;
        try generated_paths.append(ctx.allocator, transformed_path);
        cursor = quote_end;
    }

    if (generated_paths.items.len == 0) {
        output.deinit(ctx.allocator);
        return null;
    }
    try output.appendSlice(ctx.allocator, source[copied_until..]);
    const encoder = std.base64.standard.Encoder;
    for (generated_paths.items) |path| {
        const encoded_buffer = try ctx.allocator.alloc(u8, encoder.calcSize(path.len));
        const encoded = encoder.encode(encoded_buffer, path);
        try output.append(ctx.allocator, '\n');
        try output.appendSlice(ctx.allocator, generated_test_dependency_marker);
        try output.appendSlice(ctx.allocator, encoded);
        try output.appendSlice(ctx.allocator, "*/\n");
    }
    return try output.toOwnedSlice(ctx.allocator);
}

fn hasBunTranspiledPragma(source: []const u8) bool {
    var line_start: usize = 0;
    if (std.mem.startsWith(u8, source, "#!")) {
        line_start = if (std.mem.indexOfScalar(u8, source, '\n')) |newline| newline + 1 else return false;
    }
    const line_end = std.mem.indexOfScalarPos(u8, source, line_start, '\n') orelse source.len;
    const line = std.mem.trim(u8, source[line_start..line_end], " \t\r");
    if (!std.mem.startsWith(u8, line, "//")) return false;
    const comment = std.mem.trimStart(u8, line[2..], " \t");
    if (!std.mem.startsWith(u8, comment, "@bun")) return false;
    return comment.len == "@bun".len or std.ascii.isWhitespace(comment["@bun".len]);
}

fn bunCjsFactorySource(source: []const u8) ?[]const u8 {
    const line_end = std.mem.indexOfScalar(u8, source, '\n') orelse return null;
    const first_line = std.mem.trim(u8, source[0..line_end], " \t\r");
    if (!std.mem.startsWith(u8, first_line, "//") or std.mem.indexOf(u8, first_line, "@bun-cjs") == null) {
        return null;
    }
    const remainder = std.mem.trim(u8, source[line_end + 1 ..], " \t\r\n");
    if (!std.mem.startsWith(u8, remainder, "(function")) return null;
    return remainder;
}

fn isIdentifierStart(byte: u8) bool {
    return (byte >= 'A' and byte <= 'Z') or
        (byte >= 'a' and byte <= 'z') or
        byte == '_' or
        byte == '$';
}

fn isIdentifierPart(byte: u8) bool {
    return isIdentifierStart(byte) or (byte >= '0' and byte <= '9');
}

fn hasNamespaceImport(source: []const u8, name: []const u8, allocator: std.mem.Allocator) !bool {
    const pattern = try std.fmt.allocPrint(allocator, "import * as {s}", .{name});
    return std.mem.indexOf(u8, source, pattern) != null;
}

fn skipWhitespace(source: []const u8, start: usize) usize {
    var cursor = start;
    while (cursor < source.len and std.ascii.isWhitespace(source[cursor])) : (cursor += 1) {}
    return cursor;
}

fn skipJavaScriptTrivia(source: []const u8, start: usize) usize {
    var cursor = start;
    while (cursor < source.len) {
        cursor = skipWhitespace(source, cursor);
        if (cursor >= source.len or source[cursor] != '/') return cursor;
        const after_comment = skipJavaScriptComment(source, cursor);
        if (after_comment == cursor) return cursor;
        cursor = after_comment;
    }
    return cursor;
}

fn hasPriorRequireBinding(source: []const u8, end: usize) bool {
    const prefix = source[0..@min(end, source.len)];
    return std.mem.lastIndexOf(u8, prefix, "const require") != null or
        std.mem.lastIndexOf(u8, prefix, "let require") != null or
        std.mem.lastIndexOf(u8, prefix, "var require") != null;
}

fn isTypeScriptAsImport(source: []const u8, import_start: usize) bool {
    var cursor = import_start;
    while (cursor > 0 and std.ascii.isWhitespace(source[cursor - 1])) cursor -= 1;
    const token_end = cursor;
    while (cursor > 0 and isIdentifierPart(source[cursor - 1])) cursor -= 1;
    return std.mem.eql(u8, source[cursor..token_end], "as");
}

const DynamicImportOccurrence = struct {
    start: usize,
    end: usize,
    expression: []const u8,
    options: []const u8,
    target_index: ?usize,
    static_binding: ?[]const u8 = null,
    is_static: bool = false,
    needs_await: bool = false,
    runtime_require: bool = false,
    runtime_require_resolve: bool = false,
    native_bun_identity: bool = false,
    mock_binding_clause: ?[]const u8 = null,
    mock_binding_specifier: ?[]const u8 = null,
};

const DynamicImportTarget = struct {
    path: []const u8,
    mutable_namespace: bool = false,
    javascript_loader_mask: u8 = 0,
};

const javascript_loader_names = [_][]const u8{ "js", "jsx", "ts", "tsx" };
const all_javascript_loader_mask: u8 = (1 << javascript_loader_names.len) - 1;

fn javascriptLoaderBit(loader: []const u8) u8 {
    for (javascript_loader_names, 0..) |name, index| {
        if (std.mem.eql(u8, loader, name)) return @as(u8, 1) << @intCast(index);
    }
    return 0;
}

fn requestedJavaScriptLoaderMask(options: []const u8, has_options: bool) u8 {
    if (!has_options) return 0;

    var search_from: usize = 0;
    while (std.mem.indexOfPos(u8, options, search_from, "type")) |type_index| {
        const type_end = type_index + "type".len;
        if ((type_index > 0 and isIdentifierPart(options[type_index - 1])) or
            (type_end < options.len and isIdentifierPart(options[type_end])))
        {
            search_from = type_end;
            continue;
        }

        var cursor = skipWhitespace(options, type_end);
        if (cursor >= options.len or options[cursor] != ':') {
            search_from = type_end;
            continue;
        }
        cursor = skipWhitespace(options, cursor + 1);
        if (cursor >= options.len or (options[cursor] != '\'' and options[cursor] != '"')) {
            return all_javascript_loader_mask;
        }
        const value_end = skipQuotedJavaScript(options, cursor);
        if (value_end > options.len or value_end <= cursor + 1) return all_javascript_loader_mask;
        return javascriptLoaderBit(options[cursor + 1 .. value_end - 1]);
    }

    // The options expression may compute `with.type` at runtime. Generate all
    // JavaScript-family variants so a dynamic loader choice remains faithful.
    return all_javascript_loader_mask;
}

fn skipQuotedJavaScript(source: []const u8, start: usize) usize {
    const quote = source[start];
    var cursor = start + 1;
    var escaped = false;
    while (cursor < source.len) : (cursor += 1) {
        const byte = source[cursor];
        if (escaped) {
            escaped = false;
        } else if (byte == '\\') {
            escaped = true;
        } else if (byte == quote) {
            return cursor + 1;
        }
    }
    return source.len;
}

fn skipJavaScriptComment(source: []const u8, start: usize) usize {
    if (start + 1 >= source.len or source[start] != '/') return start;
    if (source[start + 1] == '/') {
        return (std.mem.indexOfScalarPos(u8, source, start + 2, '\n') orelse source.len);
    }
    if (source[start + 1] == '*') {
        const end = std.mem.indexOfPos(u8, source, start + 2, "*/") orelse return source.len;
        return end + 2;
    }
    return start;
}

fn findClosingParenthesis(source: []const u8, open: usize) ?usize {
    var depth: usize = 1;
    var cursor = open + 1;
    while (cursor < source.len) {
        const byte = source[cursor];
        if (byte == '\'' or byte == '"' or byte == '`') {
            cursor = skipQuotedJavaScript(source, cursor);
            continue;
        }
        if (byte == '/') {
            const after_comment = skipJavaScriptComment(source, cursor);
            if (after_comment != cursor) {
                cursor = after_comment;
                continue;
            }
        }
        if (byte == '(') {
            depth += 1;
        } else if (byte == ')') {
            depth -= 1;
            if (depth == 0) return cursor;
        }
        cursor += 1;
    }
    return null;
}

fn findTopLevelComma(source: []const u8) ?usize {
    var parens: usize = 0;
    var braces: usize = 0;
    var brackets: usize = 0;
    var cursor: usize = 0;
    while (cursor < source.len) {
        const byte = source[cursor];
        if (byte == '\'' or byte == '"' or byte == '`') {
            cursor = skipQuotedJavaScript(source, cursor);
            continue;
        }
        if (byte == '/') {
            const after_comment = skipJavaScriptComment(source, cursor);
            if (after_comment != cursor) {
                cursor = after_comment;
                continue;
            }
        }
        switch (byte) {
            '(' => parens += 1,
            ')' => if (parens > 0) {
                parens -= 1;
            },
            '{' => braces += 1,
            '}' => if (braces > 0) {
                braces -= 1;
            },
            '[' => brackets += 1,
            ']' => if (brackets > 0) {
                brackets -= 1;
            },
            ',' => if (parens == 0 and braces == 0 and brackets == 0) return cursor,
            else => {},
        }
        cursor += 1;
    }
    return null;
}

fn decodeJavaScriptStringPrefix(allocator: std.mem.Allocator, expression: []const u8) !?[]const u8 {
    const trimmed = std.mem.trim(u8, expression, " \t\r\n");
    if (trimmed.len < 2 or (trimmed[0] != '\'' and trimmed[0] != '"')) return null;

    const quote = trimmed[0];
    var output: std.ArrayList(u8) = .empty;
    var cursor: usize = 1;
    while (cursor < trimmed.len) : (cursor += 1) {
        const byte = trimmed[cursor];
        if (byte == quote) return try output.toOwnedSlice(allocator);
        if (byte != '\\' or cursor + 1 >= trimmed.len) {
            try output.append(allocator, byte);
            continue;
        }

        cursor += 1;
        const escaped = trimmed[cursor];
        try output.append(allocator, switch (escaped) {
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'b' => 0x08,
            'f' => 0x0c,
            else => escaped,
        });
    }
    return null;
}

fn isExactJavaScriptStringLiteral(expression: []const u8) bool {
    const trimmed = std.mem.trim(u8, expression, " \t\r\n");
    if (trimmed.len < 2 or (trimmed[0] != '\'' and trimmed[0] != '"')) return false;
    return skipQuotedJavaScript(trimmed, 0) == trimmed.len;
}

fn pathWithoutQueryOrFragment(path: []const u8) []const u8 {
    const query = std.mem.indexOfScalar(u8, path, '?') orelse path.len;
    const fragment = std.mem.indexOfScalar(u8, path, '#') orelse path.len;
    return path[0..@min(query, fragment)];
}

fn realPathIfFile(ctx: *const Context, path: []const u8) ?[]const u8 {
    if (!pathExists(ctx.io, path)) return null;
    return std.Io.Dir.cwd().realPathFileAlloc(ctx.io, path, ctx.allocator) catch null;
}

fn resolveDynamicImportTarget(
    ctx: *const Context,
    resolution_dir: []const u8,
    specifier_prefix: []const u8,
) !?[]const u8 {
    var bare = pathWithoutQueryOrFragment(specifier_prefix);
    if (compiler.resolver.FileURL.isFileURL(bare)) {
        bare = compiler.resolver.FileURL.pathFromURLAlloc(ctx.allocator, bare) catch return null;
    }
    if (bare.len == 0) return null;

    const candidate = if (std.fs.path.isAbsolute(bare))
        try ctx.allocator.dupe(u8, bare)
    else if (std.mem.startsWith(u8, bare, "./") or std.mem.startsWith(u8, bare, "../"))
        try std.fs.path.join(ctx.allocator, &.{ resolution_dir, bare })
    else
        return null;

    if (realPathIfFile(ctx, candidate)) |resolved| return resolved;
    // Bun resolves JavaScript extensions after application-specific suffixes
    // such as `fixture` (`./case.fixture` -> `./case.fixture.ts`). Known data
    // and JavaScript extensions remain exact-path requests.
    if (std.fs.path.extension(candidate).len != 0) {
        const loader = inferredLoaderForTarget(candidate);
        if (loader == null or !std.mem.eql(u8, loader.?, "file")) return null;
    }
    for ([_][]const u8{ ".js", ".jsx", ".ts", ".tsx", ".mjs", ".mts", ".cjs", ".cts", ".json" }) |extension| {
        const with_extension = try std.mem.concat(ctx.allocator, u8, &.{ candidate, extension });
        if (realPathIfFile(ctx, with_extension)) |resolved| return resolved;
    }
    return null;
}

fn dynamicTargetHasUnresolvedLocalImport(ctx: *const Context, target_path: []const u8) !bool {
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        target_path,
        ctx.allocator,
        .limited(4 * 1024 * 1024),
    ) catch return false;
    const loader = transpilerLoaderForPath(target_path) orelse return false;
    const imports_json = native_transpiler.scanImportsJson(source, loader) catch return true;
    defer std.heap.c_allocator.free(imports_json);

    const ScannedImport = struct { path: []const u8, kind: []const u8 };
    const parsed = std.json.parseFromSlice([]const ScannedImport, ctx.allocator, imports_json, .{}) catch return true;
    defer parsed.deinit();
    const target_dir = std.fs.path.dirname(target_path) orelse ctx.project_root;
    for (parsed.value) |item| {
        if (std.mem.eql(u8, item.kind, "dynamic-import")) continue;
        const bare = pathWithoutQueryOrFragment(item.path);
        if (!std.fs.path.isAbsolute(bare) and
            !std.mem.startsWith(u8, bare, "./") and
            !std.mem.startsWith(u8, bare, "../")) continue;
        if (try resolveDynamicImportTarget(ctx, target_dir, item.path) == null) return true;
    }
    return false;
}

fn dynamicTargetIndex(
    allocator: std.mem.Allocator,
    targets: *std.ArrayList(DynamicImportTarget),
    path: []const u8,
    mutable_namespace: bool,
    javascript_loader_mask: u8,
) !usize {
    for (targets.items, 0..) |target, index| {
        if (std.mem.eql(u8, target.path, path)) {
            if (mutable_namespace) targets.items[index].mutable_namespace = true;
            targets.items[index].javascript_loader_mask |= javascript_loader_mask;
            return index;
        }
    }
    try targets.append(allocator, .{
        .path = path,
        .mutable_namespace = mutable_namespace,
        .javascript_loader_mask = javascript_loader_mask,
    });
    return targets.items.len - 1;
}

fn staticImportBinding(allocator: std.mem.Allocator, clause: []const u8) !?[]const u8 {
    const trimmed = std.mem.trim(u8, clause, " \t\r\n");
    if (trimmed.len == 0) return "";
    if (!std.mem.endsWith(u8, trimmed, "from")) return null;
    const head = std.mem.trim(u8, trimmed[0 .. trimmed.len - "from".len], " \t\r\n");
    if (std.mem.startsWith(u8, head, "*")) {
        const after_star = std.mem.trim(u8, head[1..], " \t\r\n");
        if (!std.mem.startsWith(u8, after_star, "as")) return null;
        const binding = std.mem.trim(u8, after_star["as".len..], " \t\r\n");
        if (binding.len == 0 or !isIdentifierStart(binding[0])) return null;
        for (binding[1..]) |byte| if (!isIdentifierPart(byte)) return null;
        return binding;
    }
    if (std.mem.indexOfAny(u8, head, "{},") != null) return null;
    if (head.len == 0 or !isIdentifierStart(head[0])) return null;
    for (head[1..]) |byte| if (!isIdentifierPart(byte)) return null;
    return try std.fmt.allocPrint(allocator, "{{ default: {s} }}", .{head});
}

fn isJsoncLikeSpecifier(specifier: []const u8) bool {
    const bare = pathWithoutQueryOrFragment(specifier);
    const basename = std.fs.path.basename(bare);
    return std.mem.eql(u8, std.fs.path.extension(bare), ".jsonc") or
        std.mem.eql(u8, basename, "tsconfig.json") or
        std.mem.eql(u8, basename, "package.json") or
        std.mem.eql(u8, basename, "bun.lock");
}

fn isJson5Specifier(specifier: []const u8) bool {
    const bare = pathWithoutQueryOrFragment(specifier);
    return std.mem.eql(u8, std.fs.path.extension(bare), ".json5");
}

fn isTomlSpecifier(specifier: []const u8) bool {
    const bare = pathWithoutQueryOrFragment(specifier);
    return std.mem.eql(u8, std.fs.path.extension(bare), ".toml");
}

fn hasMacroImportAttribute(attributes: []const u8) bool {
    const type_index = std.mem.indexOf(u8, attributes, "type") orelse return false;
    const value = attributes[type_index + "type".len ..];
    return std.mem.indexOf(u8, value, "\"macro\"") != null or
        std.mem.indexOf(u8, value, "'macro'") != null;
}

fn loaderOptionsLiteral(ctx: *const Context, loader: []const u8) ![]const u8 {
    const loader_literal = try jsonStringLiteral(ctx, loader);
    return try std.fmt.allocPrint(ctx.allocator, "{{ with: {{ type: {s} }} }}", .{loader_literal});
}

fn scanDynamicImports(
    ctx: *const Context,
    source: []const u8,
    resolution_dir: []const u8,
    occurrences: *std.ArrayList(DynamicImportOccurrence),
    targets: *std.ArrayList(DynamicImportTarget),
    rewrite_standard_imports: bool,
    source_loader: ?[]const u8,
    preserve_static_html_imports: bool,
) !bool {
    var has_custom_signal = false;
    const uses_module_mock = std.mem.indexOf(u8, source, "mock.module(") != null or
        std.mem.indexOf(u8, source, "mock.module (") != null;
    const source_is_typescript = if (source_loader) |loader|
        std.mem.eql(u8, loader, "ts") or std.mem.eql(u8, loader, "tsx")
    else
        false;
    var runtime_dynamic_import_starts: std.ArrayList(usize) = .empty;
    defer runtime_dynamic_import_starts.deinit(ctx.allocator);
    if (source_is_typescript) {
        if (source_loader) |loader| {
            const ranges_json = native_transpiler.scanImportRangesJson(source, loader) catch null;
            if (ranges_json) |json| {
                defer std.heap.c_allocator.free(json);
                const ScannedImportRange = struct {
                    path: []const u8,
                    kind: []const u8,
                    start: i32,
                    end: i32,
                };
                const parsed = std.json.parseFromSlice([]const ScannedImportRange, ctx.allocator, json, .{}) catch null;
                if (parsed) |document| {
                    defer document.deinit();
                    for (document.value) |record| {
                        if (record.start >= 0 and std.mem.eql(u8, record.kind, "dynamic-import")) {
                            try runtime_dynamic_import_starts.append(ctx.allocator, @intCast(record.start));
                        }
                    }
                }
            }
        }
    }
    var cursor: usize = 0;
    while (cursor < source.len) {
        const byte = source[cursor];
        if (byte == '\'' or byte == '"' or byte == '`') {
            cursor = skipQuotedJavaScript(source, cursor);
            continue;
        }
        if (byte == '/') {
            const after_comment = skipJavaScriptComment(source, cursor);
            if (after_comment != cursor) {
                cursor = after_comment;
                continue;
            }
        }
        if (std.mem.startsWith(u8, source[cursor..], "import.meta.require") and
            (cursor == 0 or !isIdentifierPart(source[cursor - 1])))
        {
            const open = skipWhitespace(source, cursor + "import.meta.require".len);
            if (open < source.len and source[open] == '(') {
                if (findClosingParenthesis(source, open)) |close| {
                    const arguments = source[open + 1 .. close];
                    const comma = findTopLevelComma(arguments);
                    const expression = std.mem.trim(u8, if (comma) |index| arguments[0..index] else arguments, " \t\r\n");
                    const options = std.mem.trim(u8, if (comma) |index| arguments[index + 1 ..] else "undefined", " \t\r\n");
                    var target_index: ?usize = null;
                    if (try decodeJavaScriptStringPrefix(ctx.allocator, expression)) |prefix| {
                        if (try resolveDynamicImportTarget(ctx, resolution_dir, prefix)) |target_path| {
                            target_index = try dynamicTargetIndex(
                                ctx.allocator,
                                targets,
                                target_path,
                                false,
                                requestedJavaScriptLoaderMask(options, comma != null),
                            );
                        }
                    }
                    if (comma != null) {
                        try occurrences.append(ctx.allocator, .{
                            .start = cursor,
                            .end = close + 1,
                            .expression = expression,
                            .options = options,
                            .target_index = target_index,
                            .needs_await = true,
                        });
                        has_custom_signal = true;
                        cursor = close + 1;
                        continue;
                    }
                }
            }
        }
        if (std.mem.startsWith(u8, source[cursor..], "require.resolve") and
            (cursor == 0 or (!isIdentifierPart(source[cursor - 1]) and source[cursor - 1] != '.')) and
            (cursor + "require.resolve".len >= source.len or !isIdentifierPart(source[cursor + "require.resolve".len])) and
            !hasPriorRequireBinding(source, cursor))
        {
            const open = skipWhitespace(source, cursor + "require.resolve".len);
            if (open < source.len and source[open] == '(') {
                if (findClosingParenthesis(source, open)) |close| {
                    try occurrences.append(ctx.allocator, .{
                        .start = cursor,
                        .end = close + 1,
                        .expression = std.mem.trim(u8, source[open + 1 .. close], " \t\r\n"),
                        .options = "undefined",
                        .target_index = null,
                        .runtime_require_resolve = true,
                    });
                    has_custom_signal = true;
                    cursor = close + 1;
                    continue;
                }
            }
        }
        if (std.mem.startsWith(u8, source[cursor..], "require") and
            (cursor == 0 or !isIdentifierPart(source[cursor - 1])) and
            (cursor + "require".len >= source.len or !isIdentifierPart(source[cursor + "require".len])) and
            !hasPriorRequireBinding(source, cursor))
        {
            const open = skipWhitespace(source, cursor + "require".len);
            if (open < source.len and source[open] == '(') {
                if (findClosingParenthesis(source, open)) |close| {
                    const arguments = source[open + 1 .. close];
                    const comma = findTopLevelComma(arguments);
                    const expression = std.mem.trim(u8, if (comma) |index| arguments[0..index] else arguments, " \t\r\n");
                    const options = std.mem.trim(u8, if (comma) |index| arguments[index + 1 ..] else "undefined", " \t\r\n");
                    if (try decodeJavaScriptStringPrefix(ctx.allocator, expression)) |prefix| {
                        const inferred_loader = inferredLoaderForTarget(prefix);
                        if (comma != null or std.mem.indexOfAny(u8, prefix, "?#") != null or uses_module_mock or
                            (inferred_loader != null and std.mem.eql(u8, inferred_loader.?, "text")))
                        {
                            if (comma == null) {
                                try occurrences.append(ctx.allocator, .{
                                    .start = cursor,
                                    .end = close + 1,
                                    .expression = expression,
                                    .options = "undefined",
                                    .target_index = null,
                                    .runtime_require = true,
                                });
                                has_custom_signal = true;
                                cursor = close + 1;
                                continue;
                            }
                            const target_path = try resolveDynamicImportTarget(ctx, resolution_dir, prefix);
                            const target_index = if (target_path) |path|
                                try dynamicTargetIndex(
                                    ctx.allocator,
                                    targets,
                                    path,
                                    false,
                                    requestedJavaScriptLoaderMask(options, comma != null),
                                )
                            else
                                null;
                            try occurrences.append(ctx.allocator, .{
                                .start = cursor,
                                .end = close + 1,
                                .expression = expression,
                                .options = options,
                                .target_index = target_index,
                                .needs_await = true,
                            });
                            has_custom_signal = true;
                            cursor = close + 1;
                            continue;
                        }
                    }
                }
            }
        }
        if (!std.mem.startsWith(u8, source[cursor..], "import") or
            (cursor > 0 and (isIdentifierPart(source[cursor - 1]) or source[cursor - 1] == '#' or source[cursor - 1] == '.')) or
            (cursor + "import".len < source.len and isIdentifierPart(source[cursor + "import".len])))
        {
            cursor += 1;
            continue;
        }

        const open = skipWhitespace(source, cursor + "import".len);
        if (open >= source.len or source[open] != '(') {
            if (open >= source.len or source[open] == '.') {
                cursor += "import".len;
                continue;
            }

            var specifier_start = open;
            while (specifier_start < source.len and source[specifier_start] != '\'' and source[specifier_start] != '"') : (specifier_start += 1) {}
            if (specifier_start >= source.len) {
                cursor += "import".len;
                continue;
            }
            const specifier_end = skipQuotedJavaScript(source, specifier_start);
            if (specifier_end > source.len) {
                cursor += "import".len;
                continue;
            }
            const semicolon = std.mem.indexOfScalarPos(u8, source, specifier_end, ';') orelse {
                cursor = specifier_end;
                continue;
            };
            const expression = source[specifier_start..specifier_end];
            const prefix = (try decodeJavaScriptStringPrefix(ctx.allocator, expression)) orelse {
                cursor = semicolon + 1;
                continue;
            };
            const after_specifier = std.mem.trim(u8, source[specifier_end..semicolon], " \t\r\n");
            const has_attributes = std.mem.startsWith(u8, after_specifier, "with") or
                std.mem.startsWith(u8, after_specifier, "assert");
            // Macro imports belong to the compiler's macro pass. Rewriting a
            // namespace import into a runtime dynamic load bypasses expansion.
            if (has_attributes and hasMacroImportAttribute(after_specifier)) {
                cursor = semicolon + 1;
                continue;
            }
            const has_query = std.mem.indexOfAny(u8, prefix, "?#") != null;
            const assumes_jsonc = isJsoncLikeSpecifier(prefix);
            const assumes_json5 = isJson5Specifier(prefix);
            const assumes_toml = isTomlSpecifier(prefix);
            const target_path = try resolveDynamicImportTarget(ctx, resolution_dir, prefix);
            const prefix_loader = if (!has_attributes and !has_query) inferredLoaderForImportSpecifier(prefix) else null;
            const inferred_loader = if (!has_attributes and !has_query)
                if (target_path) |path| inferredLoaderForTarget(path) else inferredLoaderForImportSpecifier(prefix)
            else
                null;
            if (preserve_static_html_imports and inferred_loader != null and
                (std.mem.eql(u8, inferred_loader.?, "html") or
                    std.mem.eql(u8, inferred_loader.?, "file")))
            {
                // COTTONTAIL-COMPAT: Standalone compilation must leave native
                // asset imports in the compiler graph so they are serialized
                // into the executable instead of becoming disk-backed loaders.
                cursor = semicolon + 1;
                continue;
            }
            const needs_compat_resolution = target_path != null and prefix_loader != null and
                std.mem.eql(u8, prefix_loader.?, "file") and inferred_loader == null;
            const import_clause = source[cursor + "import".len .. specifier_start];
            const force_spy_namespace = std.mem.indexOf(u8, source, "spyOn(") != null and
                std.mem.indexOfScalar(u8, import_clause, '*') != null;
            const force_mock_bindings = uses_module_mock and std.mem.startsWith(u8, prefix, ".") and
                std.mem.indexOfScalar(u8, import_clause, '{') != null;
            if (!force_spy_namespace and !force_mock_bindings and !has_attributes and !has_query and !assumes_jsonc and !assumes_json5 and !assumes_toml and inferred_loader == null and !needs_compat_resolution) {
                cursor = semicolon + 1;
                continue;
            }

            const binding = if (force_mock_bindings)
                null
            else
                (try staticImportBinding(ctx.allocator, import_clause)) orelse {
                    cursor = semicolon + 1;
                    continue;
                };
            const options = if (has_attributes) blk: {
                const keyword_len: usize = if (std.mem.startsWith(u8, after_specifier, "with")) "with".len else "assert".len;
                const attributes = std.mem.trim(u8, after_specifier[keyword_len..], " \t\r\n");
                break :blk try std.fmt.allocPrint(ctx.allocator, "{{ with: {s} }}", .{attributes});
            } else if (assumes_jsonc)
                "{ with: { type: \"jsonc\" } }"
            else if (assumes_json5)
                "{ with: { type: \"json5\" } }"
            else if (assumes_toml)
                "{ with: { type: \"toml\" } }"
            else if (inferred_loader) |loader|
                try loaderOptionsLiteral(ctx, loader)
            else
                "undefined";
            const target_index = if (target_path) |path|
                try dynamicTargetIndex(
                    ctx.allocator,
                    targets,
                    path,
                    force_spy_namespace or force_mock_bindings,
                    requestedJavaScriptLoaderMask(options, has_attributes),
                )
            else
                null;
            try occurrences.append(ctx.allocator, .{
                .start = cursor,
                .end = semicolon + 1,
                .expression = expression,
                .options = options,
                .target_index = target_index,
                .static_binding = binding,
                .is_static = true,
                .mock_binding_clause = if (force_mock_bindings) import_clause else null,
                .mock_binding_specifier = if (force_mock_bindings) expression else null,
            });
            has_custom_signal = true;
            cursor = semicolon + 1;
            continue;
        }
        const close = findClosingParenthesis(source, open) orelse {
            cursor = open + 1;
            continue;
        };
        const arguments = source[open + 1 .. close];
        const after_close = skipJavaScriptTrivia(source, close + 1);
        // `import` is a valid class/object method name. Only an actual import
        // expression reaches the rewrite path; method parameters are followed
        // by a body and an empty import expression is invalid JavaScript.
        if (std.mem.trim(u8, arguments, " \t\r\n").len == 0 or
            (after_close < source.len and source[after_close] == '{'))
        {
            cursor = close + 1;
            continue;
        }
        if (isTypeScriptAsImport(source, cursor)) {
            cursor = close + 1;
            continue;
        }
        const comma = findTopLevelComma(arguments);
        const expression = std.mem.trim(u8, if (comma) |index| arguments[0..index] else arguments, " \t\r\n");
        if (source_is_typescript and isExactJavaScriptStringLiteral(expression)) {
            const expression_start = @intFromPtr(expression.ptr) - @intFromPtr(source.ptr);
            var is_runtime_import = false;
            for (runtime_dynamic_import_starts.items) |start| {
                if (start == expression_start) {
                    is_runtime_import = true;
                    break;
                }
            }
            const literal = try decodeJavaScriptStringPrefix(ctx.allocator, expression);
            const may_use_runtime_plugin = if (literal) |specifier|
                if (inferredLoaderForTarget(specifier)) |loader| std.mem.eql(u8, loader, "file") else false
            else
                false;
            if (!is_runtime_import and !may_use_runtime_plugin) {
                cursor = close + 1;
                continue;
            }
        }
        var options = std.mem.trim(u8, if (comma) |index| arguments[index + 1 ..] else "undefined", " \t\r\n");

        var target_index: ?usize = null;
        var native_bun_identity = false;
        var needs_generated_loader = rewrite_standard_imports or comma != null;
        if (try decodeJavaScriptStringPrefix(ctx.allocator, expression)) |prefix| {
            if (std.mem.eql(u8, prefix, "bun") and isExactJavaScriptStringLiteral(expression)) {
                native_bun_identity = true;
                needs_generated_loader = true;
            }
            if (std.mem.indexOfAny(u8, prefix, "?#") != null) {
                has_custom_signal = true;
                needs_generated_loader = true;
            }
            if (comma == null and isJsoncLikeSpecifier(prefix)) {
                options = "{ with: { type: \"jsonc\" } }";
                has_custom_signal = true;
                needs_generated_loader = true;
            } else if (comma == null and isJson5Specifier(prefix)) {
                options = "{ with: { type: \"json5\" } }";
                has_custom_signal = true;
                needs_generated_loader = true;
            } else if (comma == null and isTomlSpecifier(prefix)) {
                options = "{ with: { type: \"toml\" } }";
                has_custom_signal = true;
                needs_generated_loader = true;
            } else if (comma == null) {
                if (inferredLoaderForImportSpecifier(prefix)) |loader| {
                    options = try loaderOptionsLiteral(ctx, loader);
                    has_custom_signal = true;
                    needs_generated_loader = true;
                }
            }
            if (uses_module_mock) needs_generated_loader = true;
            const target_path = try resolveDynamicImportTarget(ctx, resolution_dir, prefix);
            if (target_path) |path| {
                if (!needs_generated_loader and try dynamicTargetHasUnresolvedLocalImport(ctx, path)) {
                    needs_generated_loader = true;
                }
            }
            // The compiler owns ordinary local module graphs once resolution
            // succeeds. Unresolved literals still need the runtime dispatcher
            // so native builtins and resolution failures retain Bun semantics.
            if (!rewrite_standard_imports and !needs_generated_loader and target_path == null) {
                needs_generated_loader = true;
            }
            if (needs_generated_loader) {
                if (target_path) |path| {
                    target_index = try dynamicTargetIndex(
                        ctx.allocator,
                        targets,
                        path,
                        uses_module_mock,
                        requestedJavaScriptLoaderMask(options, comma != null),
                    );
                }
            }
        } else {
            // Opaque specifiers need the runtime dispatcher. Bun's linker owns
            // ordinary literal JavaScript imports so it can preserve graph
            // identity, cycles, live bindings, and top-level await propagation.
            needs_generated_loader = true;
        }
        if (comma != null) has_custom_signal = true;
        if (!needs_generated_loader) {
            cursor = close + 1;
            continue;
        }
        try occurrences.append(ctx.allocator, .{
            .start = cursor,
            .end = close + 1,
            .expression = expression,
            .options = options,
            .target_index = target_index,
            .native_bun_identity = native_bun_identity,
        });
        cursor = close + 1;
    }
    return has_custom_signal;
}

fn rewriteTranspiledDynamicImports(
    ctx: *const Context,
    source: []const u8,
    resolution_dir: []const u8,
) ![]const u8 {
    var occurrences: std.ArrayList(DynamicImportOccurrence) = .empty;
    defer occurrences.deinit(ctx.allocator);
    var targets: std.ArrayList(DynamicImportTarget) = .empty;
    defer targets.deinit(ctx.allocator);
    _ = try scanDynamicImports(ctx, source, resolution_dir, &occurrences, &targets, true, null, false);

    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(ctx.allocator);
    var copied_until: usize = 0;
    var changed = false;
    for (occurrences.items) |occurrence| {
        if (occurrence.is_static or occurrence.runtime_require or occurrence.runtime_require_resolve or
            !std.mem.startsWith(u8, source[occurrence.start..], "import")) continue;
        try output.appendSlice(ctx.allocator, source[copied_until..occurrence.start]);
        try output.appendSlice(ctx.allocator, "__ctDynamicImport(");
        try output.appendSlice(ctx.allocator, occurrence.expression);
        try output.appendSlice(ctx.allocator, ", ");
        try output.appendSlice(ctx.allocator, occurrence.options);
        try output.append(ctx.allocator, ')');
        copied_until = occurrence.end;
        changed = true;
    }
    if (!changed) {
        output.deinit(ctx.allocator);
        return source;
    }
    try output.appendSlice(ctx.allocator, source[copied_until..]);
    return try output.toOwnedSlice(ctx.allocator);
}

fn transpileDynamicTarget(
    ctx: *const Context,
    target_path: []const u8,
    loader_override: ?[]const u8,
    external_packages: bool,
    build_error: *?[]const u8,
) !?[]const u8 {
    var error_message: ?[*:0]u8 = null;
    const output = native_bundler.bundleEntryPointWithOptions(
        target_path,
        ctx.project_root,
        .{
            .output_format = .cjs,
            .target = .node,
            .loader = loader_override,
            .external_packages = external_packages,
            // Dynamic target factories share createRequire()'s module cache.
            // Keep JavaScript dependencies external instead of embedding a
            // private copy in every target; assets such as CSS remain bundled.
            .external = &.{ "*.js", "*.mjs", "*.cjs" },
            // The factory wrapper (`appendDynamicTargetFactory`) evaluates
            // this output inside `new Function(..., "__ctImportMeta", ...)`
            // and computes the complete metadata object — including any
            // `?query`/`#fragment` suffix — at runtime. Replacing the whole
            // object also keeps bare `import.meta` valid in the CJS factory.
            .define_keys = &.{"import.meta"},
            .define_values = &.{"__ctImportMeta"},
        },
        &error_message,
    ) catch {
        if (error_message) |message| {
            defer native_bundler.ct_bundle_string_free(message);
            if (build_error.* == null) build_error.* = try ctx.allocator.dupe(u8, std.mem.span(message));
        }
        return null;
    };
    defer native_bundler.ct_bundle_free(output.ptr, output.len);
    const copied = try ctx.allocator.dupe(u8, output);
    return try rewriteTranspiledDynamicImports(ctx, copied, std.fs.path.dirname(target_path) orelse ctx.project_root);
}

fn inferredLoaderForTarget(path: []const u8) ?[]const u8 {
    const bare = pathWithoutQueryOrFragment(path);
    const basename = std.fs.path.basename(bare);
    const extension = std.fs.path.extension(bare);
    if (std.mem.eql(u8, basename, "tsconfig.json") or
        std.mem.eql(u8, basename, "package.json")) return "jsonc";
    if (std.mem.eql(u8, extension, ".json")) return "json";
    if (std.mem.eql(u8, extension, ".json5")) return "json5";
    if (std.mem.eql(u8, extension, ".jsonc") or std.mem.eql(u8, basename, "bun.lock")) return "jsonc";
    if (std.mem.eql(u8, extension, ".toml")) return "toml";
    if (std.mem.eql(u8, extension, ".yaml") or std.mem.eql(u8, extension, ".yml")) return "yaml";
    if (std.mem.eql(u8, extension, ".txt")) return "text";
    if (std.mem.eql(u8, extension, ".html") or std.mem.eql(u8, extension, ".htm")) return "html";
    if (std.mem.eql(u8, extension, ".cjs") or std.mem.eql(u8, extension, ".cts")) return "js";
    if (std.mem.eql(u8, extension, ".js") or
        std.mem.eql(u8, extension, ".jsx") or
        std.mem.eql(u8, extension, ".ts") or
        std.mem.eql(u8, extension, ".tsx") or
        std.mem.eql(u8, extension, ".mjs") or
        std.mem.eql(u8, extension, ".mts") or
        extension.len == 0)
    {
        return null;
    }
    return "file";
}

fn inferredLoaderForImportSpecifier(specifier: []const u8) ?[]const u8 {
    const loader = inferredLoaderForTarget(specifier) orelse return null;
    if (!std.mem.eql(u8, loader, "file")) return loader;

    const bare = pathWithoutQueryOrFragment(specifier);
    if (std.fs.path.isAbsolute(bare) or
        std.mem.startsWith(u8, bare, "./") or
        std.mem.startsWith(u8, bare, "../") or
        compiler.resolver.FileURL.isFileURL(bare))
    {
        return loader;
    }

    // A dot in a package subpath is not necessarily a file extension. For
    // example, React exports `react-dom/server.browser` as JavaScript.
    return null;
}

fn appendDynamicFactorySourceLiteral(
    ctx: *const Context,
    output: *std.ArrayList(u8),
    source: ?[]const u8,
    mutable_namespace: bool,
    mock_key_literal: []const u8,
    path_literal: []const u8,
) !void {
    const transpiled = source orelse {
        try output.appendSlice(ctx.allocator, "null");
        return;
    };
    const factory_source = if (mutable_namespace)
        try std.fmt.allocPrint(
            ctx.allocator,
            "{s}\nconst __ctUpdateLexicalBindings = (value) => {{ for (const name of Object.keys(value ?? {{}})) {{ if (!Object.hasOwn(module.exports, name)) continue; try {{ eval(name + \" = value[name]\"); }} catch {{}} }} }}; globalThis.__cottontailRegisterModuleBindings?.({s}, __ctUpdateLexicalBindings); globalThis.__cottontailRegisterModuleBindings?.({s}, __ctUpdateLexicalBindings);",
            .{ transpiled, mock_key_literal, path_literal },
        )
    else
        transpiled;
    try output.appendSlice(ctx.allocator, try jsonStringLiteral(ctx, factory_source));
}

fn appendDynamicTargetFactory(
    ctx: *const Context,
    output: *std.ArrayList(u8),
    target: DynamicImportTarget,
    index: usize,
) !void {
    const inferred_loader = inferredLoaderForTarget(target.path);
    var build_error: ?[]const u8 = null;
    const default_cjs_source = try transpileDynamicTarget(
        ctx,
        target.path,
        if (inferred_loader != null and std.mem.eql(u8, inferred_loader.?, "text")) "text" else null,
        target.mutable_namespace,
        &build_error,
    );
    var javascript_sources = [_]?[]const u8{ null, null, null, null };
    var javascript_loader_mask = target.javascript_loader_mask;
    // Preserve the previous parse-diagnostic fallback when the file's normal
    // loader cannot produce a module, even if no explicit type was requested.
    if (default_cjs_source == null) javascript_loader_mask |= all_javascript_loader_mask;
    for (javascript_loader_names, 0..) |loader, loader_index| {
        const loader_bit = @as(u8, 1) << @intCast(loader_index);
        if (javascript_loader_mask & loader_bit == 0) continue;
        javascript_sources[loader_index] = try transpileDynamicTarget(
            ctx,
            target.path,
            loader,
            target.mutable_namespace,
            &build_error,
        );
    }
    const factory_error = if (build_error != null and std.mem.indexOf(u8, build_error.?, "Could not resolve:") != null)
        try std.fmt.allocPrint(
            ctx.allocator,
            "{{ const error = new Error({s}); error.code = \"MODULE_NOT_FOUND\"; throw error; }}",
            .{try jsonStringLiteral(ctx, build_error.?)},
        )
    else if (build_error) |message|
        try std.fmt.allocPrint(
            ctx.allocator,
            "{{ const error = new SyntaxError({s}); error.name = \"BuildMessage\"; throw error; }}",
            .{try jsonStringLiteral(ctx, message)},
        )
    else
        "{ const error = new SyntaxError(\"Unable to parse module with the selected loader\"); error.name = \"BuildMessage\"; throw error; }";
    const raw_source = try std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        target.path,
        ctx.allocator,
        .limited(64 * 1024 * 1024),
    );
    const path_literal = try jsonStringLiteral(ctx, target.path);
    const raw_literal = try jsonStringLiteral(ctx, raw_source);
    const file_url = try std.fmt.allocPrint(ctx.allocator, "file://{s}", .{target.path});
    const url_literal = try jsonStringLiteral(ctx, file_url);
    const dirname = std.fs.path.dirname(target.path) orelse ctx.project_root;
    const dirname_literal = try jsonStringLiteral(ctx, dirname);
    const basename_literal = try jsonStringLiteral(ctx, std.fs.path.basename(target.path));
    const mock_key = try std.fmt.allocPrint(ctx.allocator, "./{s}", .{std.fs.path.stem(target.path)});
    const mock_key_literal = try jsonStringLiteral(ctx, mock_key);
    const inferred_loader_literal = if (inferredLoaderForTarget(target.path)) |loader|
        try jsonStringLiteral(ctx, loader)
    else
        "null";
    const is_cjs_target = std.mem.eql(u8, std.fs.path.extension(target.path), ".cjs") or
        std.mem.eql(u8, std.fs.path.extension(target.path), ".cts");
    const package_type_module = if (is_cjs_target)
        try nearestPackageTypeIsModule(ctx, dirname)
    else
        false;

    const prefix = try std.fmt.allocPrint(ctx.allocator,
        \\const __ctPath{d} = {s};
        \\const __ctURL{d} = {s};
        \\function __ctLoad{d}(specifier, options) {{
        \\  const __ctText = String(specifier);
        \\  const __ctMarker = __ctText.search(/[?#]/);
        \\  const __ctSuffix = __ctMarker < 0 ? "" : __ctText.slice(__ctMarker);
        \\  const __ctPlugin = globalThis.__cottontailImportPluginModule?.(__ctText, __ctPath{d}, options, __ctPath{d} + __ctSuffix);
        \\  if (__ctPlugin?.matched) return Promise.resolve(__ctPlugin.value);
        \\  const __ctInferredType = {s};
        \\  const __ctType = options?.with?.type ?? options?.assert?.type ?? options?.type ?? (__ctSuffix === "?raw" ? "text" : __ctInferredType);
        \\  const __ctKey = __ctPath{d} + __ctSuffix + (__ctType == null ? "" : "\\u0000" + __ctType);
        \\  const __ctRegistry = globalThis.Loader.registry;
        \\  if (__ctRegistry.has(__ctKey)) return __ctRegistry.get(__ctKey);
        \\  const __ctPromise = (async () => {{
        \\    const __ctImportMeta = {{ url: __ctURL{d} + __ctSuffix, dir: {s}, dirname: {s}, file: {s}, path: __ctPath{d}, filename: __ctPath{d}, main: false }};
        \\    __ctImportMeta.require = __ctCreateRequire(__ctPath{d});
        \\    __ctImportMeta.resolveSync = (specifier, parent = __ctPath{d}) => globalThis.__cottontailImportMetaResolveSync(specifier, parent);
        \\    __ctImportMeta.resolve = (specifier, parent = __ctPath{d}) => globalThis.__cottontailImportMetaResolve(specifier, parent);
        \\    const __ctRaw = {s};
        \\    if (__ctType === "text") return {{ default: __ctRaw }};
        \\    if (__ctType === "file" || __ctType === "css") return {{ default: __ctPath{d} }};
        \\    if (__ctType === "html") return {{ default: {{ index: __ctPath{d}, files: null }} }};
        \\    if (__ctType === "json") return __ctLoaderNamespace(JSON.parse(__ctRaw));
        \\    if (__ctType === "jsonc") return __ctLoaderNamespace(__ctParseJSONC(__ctRaw));
        \\    if (__ctType === "json5") return __ctLoaderNamespace(__ctParseJSON5(__ctRaw));
        \\    if (__ctType === "toml") return __ctLoaderNamespace(__ctParseRuntimeTOML(__ctRaw));
        \\    if (__ctType === "yaml") return __ctLoaderNamespace(__ctRaw.trim() === "" ? {{}} : __ctParseRuntimeYAML(__ctRaw));
        \\    if (__ctType === "wasm" || __ctType === "base64" || __ctType === "dataurl") {{
        \\      if (__ctRaw.length === 0) return {{ default: __ctPath{d} }};
        \\    }}
        \\    if (__ctType === "sqlite" || __ctType === "sqlite_embedded") {{
        \\      const __ctDatabase = new __ctLoaderDatabase(__ctPath{d});
        \\      for (const __ctKey of Object.keys(__ctDatabase)) {{
        \\        if (__ctKey !== "filename") Object.defineProperty(__ctDatabase, __ctKey, {{ enumerable: false }});
        \\      }}
        \\      return {{ db: __ctDatabase, default: __ctDatabase }};
        \\    }}
        \\    if (__ctType != null && __ctType !== "js" && __ctType !== "jsx" && __ctType !== "ts" && __ctType !== "tsx") {{
        \\      throw new TypeError(`Unsupported loader type: ${{__ctType}}`);
        \\    }}
        \\    const module = {{ exports: {{}} }};
        \\    const exports = module.exports;
        \\
    , .{ index, path_literal, index, url_literal, index, index, index, inferred_loader_literal, index, index, dirname_literal, dirname_literal, basename_literal, index, index, index, index, index, raw_literal, index, index, index, index });
    try output.appendSlice(ctx.allocator, prefix);
    try output.appendSlice(ctx.allocator, "    const __ctDefaultFactorySource = ");
    try appendDynamicFactorySourceLiteral(
        ctx,
        output,
        default_cjs_source,
        target.mutable_namespace,
        mock_key_literal,
        path_literal,
    );
    try output.appendSlice(ctx.allocator, ";\n    const __ctJavaScriptFactories = {");
    for (javascript_loader_names, 0..) |loader, loader_index| {
        if (javascript_loader_mask & (@as(u8, 1) << @intCast(loader_index)) == 0) continue;
        try output.appendSlice(ctx.allocator, try jsonStringLiteral(ctx, loader));
        try output.appendSlice(ctx.allocator, ": ");
        try appendDynamicFactorySourceLiteral(
            ctx,
            output,
            javascript_sources[loader_index],
            target.mutable_namespace,
            mock_key_literal,
            path_literal,
        );
        try output.append(ctx.allocator, ',');
    }
    try output.appendSlice(ctx.allocator, "};\n    const __ctFactorySource = __ctType == null || (__ctType === __ctInferredType && __ctJavaScriptFactories[__ctType] == null) ? __ctDefaultFactorySource : __ctJavaScriptFactories[__ctType];\n    if (__ctFactorySource == null) ");
    try output.appendSlice(ctx.allocator, factory_error);
    try output.appendSlice(ctx.allocator, "\n    new Function(\"module\", \"exports\", \"require\", \"__ctImportMeta\", \"__ctDynamicImport\", __ctFactorySource)(module, exports, __ctCreateRequire(__ctPath");
    try output.appendSlice(ctx.allocator, try std.fmt.allocPrint(ctx.allocator, "{d}", .{index}));
    // The target promise's normalization catch adds one reaction of its own.
    // Two empty reactions keep nested evaluation behind both that propagation
    // and the outer import's fulfillment handler.
    try output.appendSlice(ctx.allocator, "), __ctImportMeta, (specifier, importOptions) => Promise.resolve().then(() => {}).then(() => {}).then(() => globalThis.__cottontailImportModule(String(specifier), __ctPath");
    try output.appendSlice(ctx.allocator, try std.fmt.allocPrint(ctx.allocator, "{d}", .{index}));
    try output.appendSlice(ctx.allocator, ", importOptions)));\n");
    const return_expression = if (is_cjs_target)
        try std.fmt.allocPrint(ctx.allocator, "__ctCommonJSNamespace(module.exports, {s})", .{if (package_type_module) "true" else "false"})
    else if (target.mutable_namespace)
        try std.fmt.allocPrint(
            ctx.allocator,
            "(() => {{ const namespace = __ctMutableNamespace(module.exports); const update = value => Object.assign(namespace, value ?? {{}}); globalThis.__cottontailRegisterModuleBindings({s}, update); globalThis.__cottontailRegisterModuleBindings({s}, update); return namespace; }})()",
            .{ path_literal, mock_key_literal },
        )
    else
        "module.exports";
    const suffix = try std.fmt.allocPrint(ctx.allocator,
        \\    return module.exports;
        \\  }})().catch(error => {{ __ctRegistry.delete(__ctKey); throw __ctNormalizeImportError(error); }});
        \\  __ctRegistry.set(__ctKey, __ctPromise);
        \\  return __ctPromise;
        \\}}
        \\
    , .{});
    const return_marker = "return module.exports;";
    const marker_index = std.mem.indexOf(u8, suffix, return_marker) orelse unreachable;
    try output.appendSlice(ctx.allocator, suffix[0..marker_index]);
    try output.appendSlice(ctx.allocator, "return ");
    try output.appendSlice(ctx.allocator, return_expression);
    try output.appendSlice(ctx.allocator, ";");
    try output.appendSlice(ctx.allocator, suffix[marker_index + return_marker.len ..]);
}

fn appendDynamicDispatcher(
    ctx: *const Context,
    output: *std.ArrayList(u8),
    targets: []const DynamicImportTarget,
    resolution_dir: []const u8,
) !void {
    try output.appendSlice(ctx.allocator,
        \\function __ctImportBun() { return Promise.resolve(globalThis.Bun); }
        \\
        \\async function __ctImportDynamic(specifier, options) {
        \\  const __ctText = String(specifier);
        \\  const __ctMarker = __ctText.search(/[?#]/);
        \\  const __ctBare = __ctMarker < 0 ? __ctText : __ctText.slice(0, __ctMarker);
        \\
    );
    for (targets, 0..) |target, index| {
        const path_literal = try jsonStringLiteral(ctx, target.path);
        const file_url = try std.fmt.allocPrint(ctx.allocator, "file://{s}", .{target.path});
        const url_literal = try jsonStringLiteral(ctx, file_url);
        const branch = try std.fmt.allocPrint(
            ctx.allocator,
            "  if (__ctBare === {s} || __ctBare === {s}) return __ctLoad{d}(__ctText, options);\n",
            .{ path_literal, url_literal, index },
        );
        try output.appendSlice(ctx.allocator, branch);
    }
    const referrer = try std.fmt.allocPrint(ctx.allocator, "{s}/", .{resolution_dir});
    const referrer_literal = try jsonStringLiteral(ctx, referrer);
    // COTTONTAIL-COMPAT: A rewritten dynamic import is still an asynchronous
    // ESM operation. Let the runtime loader promote top-level-await sources
    // without changing ordinary CommonJS interop.
    const fallback = try std.fmt.allocPrint(ctx.allocator,
        \\  if (typeof globalThis.__cottontailImportModule === "function") {{
        \\    try {{ return await globalThis.__cottontailImportModule(__ctText, {s}, options, true); }}
        \\    catch (error) {{
        \\      if (__ctBare.toLowerCase().startsWith("file:") && error && (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_MODULE_NOT_FOUND")) {{
        \\        error.message = `Cannot find module '${{__ctText}}'`;
        \\      }}
        \\      throw __ctNormalizeImportError(error);
        \\    }}
        \\  }}
        \\  throw new Error(`Cannot find module '${{__ctText}}'`);
        \\}}
        \\
    , .{referrer_literal});
    try output.appendSlice(ctx.allocator, fallback);
    try output.appendSlice(ctx.allocator, "const __ctRuntimeRequire = __ctCreateRequire(");
    try output.appendSlice(ctx.allocator, referrer_literal);
    try output.appendSlice(ctx.allocator, ");\n");
}

fn reexportLocalName(source: []const u8, exported_name: []const u8) ?[]const u8 {
    var search_from: usize = 0;
    while (std.mem.indexOfPos(u8, source, search_from, " as ")) |as_index| {
        var exported_start = as_index + " as ".len;
        while (exported_start < source.len and std.ascii.isWhitespace(source[exported_start])) exported_start += 1;
        const exported_end = exported_start + exported_name.len;
        if (exported_end <= source.len and std.mem.eql(u8, source[exported_start..exported_end], exported_name) and
            (exported_end == source.len or !isIdentifierPart(source[exported_end])))
        {
            var local_end = as_index;
            while (local_end > 0 and std.ascii.isWhitespace(source[local_end - 1])) local_end -= 1;
            var local_start = local_end;
            while (local_start > 0 and isIdentifierPart(source[local_start - 1])) local_start -= 1;
            if (local_start < local_end) return source[local_start..local_end];
        }
        search_from = as_index + " as ".len;
    }
    return null;
}

fn relativeImportSourceForName(source: []const u8, name: []const u8) ?[]const u8 {
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |line| {
        if (std.mem.indexOf(u8, line, name) == null or std.mem.indexOf(u8, line, "from") == null) continue;
        const from_index = std.mem.indexOf(u8, line, "from") orelse continue;
        var quote_index = from_index + "from".len;
        while (quote_index < line.len and line[quote_index] != '\'' and line[quote_index] != '"') : (quote_index += 1) {}
        if (quote_index >= line.len) continue;
        const quote = line[quote_index];
        const end = std.mem.indexOfScalarPos(u8, line, quote_index + 1, quote) orelse continue;
        const specifier = line[quote_index + 1 .. end];
        if (std.mem.startsWith(u8, specifier, ".")) return specifier;
    }
    return null;
}

fn appendMockBindingImport(
    ctx: *const Context,
    output: *std.ArrayList(u8),
    occurrence: DynamicImportOccurrence,
    target: DynamicImportTarget,
    function_name: []const u8,
) !void {
    const clause = occurrence.mock_binding_clause.?;
    const open_brace = std.mem.indexOfScalar(u8, clause, '{') orelse return error.InvalidMockImport;
    const close_brace = std.mem.lastIndexOfScalar(u8, clause, '}') orelse return error.InvalidMockImport;
    if (close_brace <= open_brace) return error.InvalidMockImport;
    const namespace_name = try std.fmt.allocPrint(ctx.allocator, "__ctMockImport{d}", .{occurrence.start});
    try output.appendSlice(ctx.allocator, "const ");
    try output.appendSlice(ctx.allocator, namespace_name);
    try output.appendSlice(ctx.allocator, " = await ");
    try output.appendSlice(ctx.allocator, function_name);
    try output.append(ctx.allocator, '(');
    try output.appendSlice(ctx.allocator, occurrence.expression);
    try output.appendSlice(ctx.allocator, ", ");
    try output.appendSlice(ctx.allocator, occurrence.options);
    try output.appendSlice(ctx.allocator, ");\n");

    const target_source = try std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        target.path,
        ctx.allocator,
        .limited(4 * 1024 * 1024),
    );
    var bindings = std.mem.splitScalar(u8, clause[open_brace + 1 .. close_brace], ',');
    var assignments: std.ArrayList(u8) = .empty;
    var dependency_notifications: std.ArrayList(u8) = .empty;
    while (bindings.next()) |part| {
        const binding = std.mem.trim(u8, part, " \t\r\n");
        if (binding.len == 0) continue;
        const as_index = std.mem.indexOf(u8, binding, " as ");
        const imported_name = std.mem.trim(u8, if (as_index) |index| binding[0..index] else binding, " \t\r\n");
        const local_name = std.mem.trim(u8, if (as_index) |index| binding[index + " as ".len ..] else binding, " \t\r\n");
        if (local_name.len == 0 or !isIdentifierStart(local_name[0])) continue;
        const imported_literal = try jsonStringLiteral(ctx, imported_name);
        try output.appendSlice(ctx.allocator, "let ");
        try output.appendSlice(ctx.allocator, local_name);
        try output.appendSlice(ctx.allocator, " = ");
        try output.appendSlice(ctx.allocator, namespace_name);
        try output.append(ctx.allocator, '[');
        try output.appendSlice(ctx.allocator, imported_literal);
        try output.appendSlice(ctx.allocator, "];\n");

        try assignments.appendSlice(ctx.allocator, local_name);
        try assignments.appendSlice(ctx.allocator, " = Object.hasOwn(value, ");
        try assignments.appendSlice(ctx.allocator, imported_literal);
        try assignments.appendSlice(ctx.allocator, ") ? value[");
        try assignments.appendSlice(ctx.allocator, imported_literal);
        try assignments.appendSlice(ctx.allocator, "] : ");
        if (reexportLocalName(target_source, imported_name)) |source_name| {
            const source_literal = try jsonStringLiteral(ctx, source_name);
            try assignments.appendSlice(ctx.allocator, "value[");
            try assignments.appendSlice(ctx.allocator, source_literal);
            try assignments.appendSlice(ctx.allocator, "];");
        } else {
            try assignments.appendSlice(ctx.allocator, local_name);
            try assignments.append(ctx.allocator, ';');
        }
        if (relativeImportSourceForName(target_source, imported_name)) |dependency| {
            const dependency_literal = try jsonStringLiteral(ctx, dependency);
            const dependency_name = reexportLocalName(target_source, imported_name) orelse imported_name;
            const dependency_name_literal = try jsonStringLiteral(ctx, dependency_name);
            try dependency_notifications.appendSlice(ctx.allocator, "globalThis.__cottontailNotifyModuleBindings?.(");
            try dependency_notifications.appendSlice(ctx.allocator, dependency_literal);
            try dependency_notifications.appendSlice(ctx.allocator, ", {");
            try dependency_notifications.appendSlice(ctx.allocator, dependency_name);
            try dependency_notifications.appendSlice(ctx.allocator, ": Object.hasOwn(value, ");
            try dependency_notifications.appendSlice(ctx.allocator, imported_literal);
            try dependency_notifications.appendSlice(ctx.allocator, ") ? value[");
            try dependency_notifications.appendSlice(ctx.allocator, imported_literal);
            try dependency_notifications.appendSlice(ctx.allocator, "] : value[");
            try dependency_notifications.appendSlice(ctx.allocator, dependency_name_literal);
            try dependency_notifications.appendSlice(ctx.allocator, "]});");
        }
    }
    try output.appendSlice(ctx.allocator, "globalThis.__cottontailRegisterModuleBindings(");
    try output.appendSlice(ctx.allocator, occurrence.mock_binding_specifier.?);
    try output.appendSlice(ctx.allocator, ", (value) => {");
    try output.appendSlice(ctx.allocator, assignments.items);
    try output.appendSlice(ctx.allocator, "globalThis.__cottontailNotifyModuleBindings?.(");
    try output.appendSlice(ctx.allocator, try jsonStringLiteral(ctx, target.path));
    try output.appendSlice(ctx.allocator, ", value);");
    try output.appendSlice(ctx.allocator, dependency_notifications.items);
    try output.appendSlice(ctx.allocator, "});\n");
}

fn rewriteQueryImports(
    ctx: *const Context,
    source: []const u8,
    resolution_dir: []const u8,
    source_loader: ?[]const u8,
    preserve_static_html_imports: bool,
) !?[]u8 {
    var occurrences: std.ArrayList(DynamicImportOccurrence) = .empty;
    var targets: std.ArrayList(DynamicImportTarget) = .empty;
    _ = try scanDynamicImports(
        ctx,
        source,
        resolution_dir,
        &occurrences,
        &targets,
        false,
        source_loader,
        preserve_static_html_imports,
    );
    if (occurrences.items.len == 0) return null;

    var output: std.ArrayList(u8) = .empty;
    const json5_module = try runtimeModulePath(ctx, &.{ "bun", "json5.js" });
    const json5_literal = try jsonStringLiteral(ctx, json5_module);
    const toml_module = try runtimeModulePath(ctx, &.{ "bun", "toml.js" });
    const toml_literal = try jsonStringLiteral(ctx, toml_module);
    const yaml_module = try runtimeModulePath(ctx, &.{ "bun", "yaml.js" });
    const yaml_literal = try jsonStringLiteral(ctx, yaml_module);
    try output.appendSlice(ctx.allocator,
        \\import { Database as __ctLoaderDatabase } from "bun:sqlite";
        \\import { createRequire as __ctCreateRequire } from "node:module";
        \\import { parse as __ctParseJSON5 } from 
    );
    try output.appendSlice(ctx.allocator, json5_literal);
    try output.appendSlice(ctx.allocator, ";\n");
    try output.appendSlice(ctx.allocator, "import { parse as __ctParseRuntimeTOML } from ");
    try output.appendSlice(ctx.allocator, toml_literal);
    try output.appendSlice(ctx.allocator, ";\n");
    try output.appendSlice(ctx.allocator, "import { parse as __ctParseRuntimeYAML } from ");
    try output.appendSlice(ctx.allocator, yaml_literal);
    try output.appendSlice(ctx.allocator, ";\n");
    try output.appendSlice(ctx.allocator,
        \\globalThis.Loader ??= { registry: new Map() };
        \\globalThis.__cottontailModuleBindingListeners ??= new Map();
        \\globalThis.__cottontailModuleBindingValues ??= new Map();
        \\globalThis.__cottontailRegisterModuleBindings ??= (key, listener) => {
        \\  key = String(key);
        \\  const listeners = globalThis.__cottontailModuleBindingListeners.get(key) ?? [];
        \\  listeners.push(listener);
        \\  globalThis.__cottontailModuleBindingListeners.set(key, listeners);
        \\  if (globalThis.__cottontailModuleBindingValues.has(key)) listener(globalThis.__cottontailModuleBindingValues.get(key));
        \\};
        \\function __ctNormalizeImportError(error) {
        \\  if (error && error.code === "MODULE_NOT_FOUND") {
        \\    error.code = "ERR_MODULE_NOT_FOUND";
        \\    error.name = "ResolveMessage";
        \\    error.line ??= 0;
        \\    error.column ??= 0;
        \\    error.position ??= { line: error.line, column: error.column };
        \\  }
        \\  return error;
        \\}
        \\function __ctLoaderNamespace(value) {
        \\  if (value !== null && typeof value === "object" && !Array.isArray(value)) return Object.assign({ default: value }, value);
        \\  return { default: value };
        \\}
        \\function __ctCommonJSNamespace(value, packageTypeModule) {
        \\  const namespace = { default: value };
        \\  Object.defineProperty(namespace, Symbol.toStringTag, { value: "Module" });
        \\  if (value !== null && (typeof value === "object" || typeof value === "function")) {
        \\    try { Object.defineProperty(value, Symbol.for("cottontail.commonjsExports"), { value: true }); } catch {}
        \\    let isEsModule = false;
        \\    try { isEsModule = value.__esModule === true; } catch {}
        \\    if (!packageTypeModule && isEsModule && Object.hasOwn(value, "default")) namespace.default = value.default;
        \\    for (const key of Object.getOwnPropertyNames(value)) {
        \\      if (key === "default" || (!packageTypeModule && key === "__esModule")) continue;
        \\      const descriptor = Object.getOwnPropertyDescriptor(value, key);
        \\      if (!descriptor) continue;
        \\      if ("value" in descriptor) namespace[key] = descriptor.value;
        \\      else if (descriptor.enumerable) {
        \\        try { namespace[key] = value[key]; } catch { namespace[key] = undefined; }
        \\      }
        \\    }
        \\  }
        \\  return namespace;
        \\}
        \\function __ctMutableNamespace(value) {
        \\  const namespace = {};
        \\  Object.defineProperty(namespace, Symbol.toStringTag, { value: "Module" });
        \\  for (const key of Object.keys(value ?? {})) {
        \\    if (key !== "__esModule") namespace[key] = value[key];
        \\  }
        \\  return namespace;
        \\}
        \\function __ctStripJSONC(source) {
        \\  let output = "";
        \\  let quote = "";
        \\  let escaped = false;
        \\  for (let index = 0; index < source.length; index++) {
        \\    const char = source[index];
        \\    if (quote) {
        \\      output += char;
        \\      if (escaped) escaped = false;
        \\      else if (char === "\\") escaped = true;
        \\      else if (char === quote) quote = "";
        \\      continue;
        \\    }
        \\    if (char === '"') { quote = char; output += char; continue; }
        \\    if (char === "/" && source[index + 1] === "/") {
        \\      while (index < source.length && source[index] !== "\n") index++;
        \\      output += "\n";
        \\      continue;
        \\    }
        \\    if (char === "/" && source[index + 1] === "*") {
        \\      index += 2;
        \\      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index++;
        \\      index++;
        \\      continue;
        \\    }
        \\    output += char;
        \\  }
        \\  return output.replace(/,\s*([}\]])/g, "$1");
        \\}
        \\function __ctParseJSONC(source) {
        \\  if (source.trim() === "") return {};
        \\  return JSON.parse(__ctStripJSONC(source));
        \\}
        \\function __ctStripDataComment(source, marker) {
        \\  let quote = "";
        \\  let escaped = false;
        \\  for (let index = 0; index < source.length; index++) {
        \\    const char = source[index];
        \\    if (quote) {
        \\      if (escaped) escaped = false;
        \\      else if (char === "\\") escaped = true;
        \\      else if (char === quote) quote = "";
        \\    } else if (char === '"' || char === "'") quote = char;
        \\    else if (char === marker) return source.slice(0, index);
        \\  }
        \\  return source;
        \\}
        \\function __ctParseDataScalar(source) {
        \\  const value = source.trim().replace(/,$/, "").trim();
        \\  if (value === "") return null;
        \\  if (value === "true") return true;
        \\  if (value === "false") return false;
        \\  if (value === "null" || value === "~") return null;
        \\  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
        \\  if (value[0] === '"') return JSON.parse(value);
        \\  if (value[0] === "'" && value[value.length - 1] === "'") return value.slice(1, -1).replace(/''/g, "'");
        \\  if (value[0] === "[" || value[0] === "{") return JSON.parse(value);
        \\  return value;
        \\}
        \\function __ctParseTOML(source) {
        \\  const root = {};
        \\  let current = root;
        \\  for (const rawLine of source.split(/\r?\n/)) {
        \\    const line = __ctStripDataComment(rawLine, "#").trim();
        \\    if (!line) continue;
        \\    if (line.startsWith("[") && line.endsWith("]")) {
        \\      const path = line.slice(1, -1).trim().split(".");
        \\      if (path.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new SyntaxError("Invalid TOML section");
        \\      current = root;
        \\      for (const part of path) current = current[part] ??= {};
        \\      continue;
        \\    }
        \\    const equals = line.indexOf("=");
        \\    if (equals <= 0) throw new SyntaxError("Invalid TOML assignment");
        \\    const key = line.slice(0, equals).trim();
        \\    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new SyntaxError("Invalid TOML key");
        \\    current[key] = __ctParseDataScalar(line.slice(equals + 1));
        \\  }
        \\  return root;
        \\}
        \\function __ctYAMLColon(line) {
        \\  let quote = "";
        \\  for (let index = 0; index < line.length; index++) {
        \\    const char = line[index];
        \\    if (quote) { if (char === quote && line[index - 1] !== "\\") quote = ""; }
        \\    else if (char === '"' || char === "'") quote = char;
        \\    else if (char === ":") return index;
        \\  }
        \\  return -1;
        \\}
        \\function __ctParseYAML(source) {
        \\  if (source.trim() === "") return {};
        \\  try {
        \\    const jsonValue = __ctParseJSONC(source);
        \\    if (jsonValue !== null && typeof jsonValue === "object" && !Array.isArray(jsonValue)) {
        \\      for (const line of source.split(/\r?\n/)) {
        \\        const comment = line.match(/\/\/\s*([^,}\r\n]+)\s*[,}]?\s*$/);
        \\        if (comment) jsonValue[`// ${comment[1].trim()}`] = null;
        \\      }
        \\    }
        \\    return jsonValue;
        \\  } catch {}
        \\  const root = {};
        \\  const stack = [{ indent: -1, value: root }];
        \\  let sawMapping = false;
        \\  for (const rawLine of source.split(/\r?\n/)) {
        \\    if (!rawLine.trim() || rawLine.trim().startsWith("#") || rawLine.trim() === "---") continue;
        \\    const indent = rawLine.length - rawLine.trimStart().length;
        \\    const line = __ctStripDataComment(rawLine.trim(), "#").trim();
        \\    const colon = __ctYAMLColon(line);
        \\    if (colon <= 0) continue;
        \\    sawMapping = true;
        \\    let key = line.slice(0, colon).trim();
        \\    if ((key[0] === '"' && key.at(-1) === '"') || (key[0] === "'" && key.at(-1) === "'")) key = key.slice(1, -1);
        \\    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
        \\    const parent = stack.at(-1).value;
        \\    const rest = line.slice(colon + 1).trim();
        \\    if (rest === "") {
        \\      const child = {};
        \\      parent[key] = child;
        \\      stack.push({ indent, value: child });
        \\    } else parent[key] = __ctParseDataScalar(rest);
        \\  }
        \\  if (sawMapping) return root;
        \\  if (/\r?\n/.test(source)) throw new SyntaxError("Invalid YAML document");
        \\  return source.trim();
        \\}
        \\
    );
    for (targets.items, 0..) |target, index| {
        try appendDynamicTargetFactory(ctx, &output, target, index);
    }
    try appendDynamicDispatcher(ctx, &output, targets.items, resolution_dir);

    var copied_until: usize = 0;
    for (occurrences.items) |occurrence| {
        try output.appendSlice(ctx.allocator, source[copied_until..occurrence.start]);
        const function_name = if (occurrence.native_bun_identity)
            "__ctImportBun"
        else if (occurrence.runtime_require_resolve)
            "__ctRuntimeRequire.resolve"
        else if (occurrence.runtime_require)
            "__ctRuntimeRequire"
        else if (occurrence.target_index) |index|
            try std.fmt.allocPrint(ctx.allocator, "__ctLoad{d}", .{index})
        else
            "__ctImportDynamic";
        if (occurrence.mock_binding_clause != null) {
            const target = targets.items[occurrence.target_index.?];
            try appendMockBindingImport(ctx, &output, occurrence, target, function_name);
            copied_until = occurrence.end;
            continue;
        }
        if (occurrence.is_static) {
            if (occurrence.static_binding) |binding| {
                if (binding.len > 0) {
                    try output.appendSlice(ctx.allocator, "const ");
                    try output.appendSlice(ctx.allocator, binding);
                    try output.appendSlice(ctx.allocator, " = await ");
                } else {
                    try output.appendSlice(ctx.allocator, "await ");
                }
            }
        } else if (occurrence.needs_await) {
            try output.appendSlice(ctx.allocator, "(await ");
        }
        try output.appendSlice(ctx.allocator, function_name);
        try output.append(ctx.allocator, '(');
        try output.appendSlice(ctx.allocator, occurrence.expression);
        if (!occurrence.runtime_require and !occurrence.runtime_require_resolve) {
            try output.appendSlice(ctx.allocator, ", ");
            try output.appendSlice(ctx.allocator, occurrence.options);
        }
        try output.append(ctx.allocator, ')');
        if (occurrence.is_static) try output.append(ctx.allocator, ';');
        if (occurrence.needs_await) try output.append(ctx.allocator, ')');
        copied_until = occurrence.end;
    }
    try output.appendSlice(ctx.allocator, source[copied_until..]);
    return try output.toOwnedSlice(ctx.allocator);
}

fn rewriteNamespaceEsModuleAssignments(allocator: std.mem.Allocator, source: []const u8) !?[]u8 {
    const property = ".__esModule";
    var output: std.ArrayList(u8) = .empty;
    var copied_until: usize = 0;
    var search_from: usize = 0;
    var changed = false;

    while (std.mem.indexOfPos(u8, source, search_from, property)) |dot_index| {
        var lhs_start = dot_index;
        while (lhs_start > 0 and isIdentifierPart(source[lhs_start - 1])) : (lhs_start -= 1) {}
        if (lhs_start == dot_index or !isIdentifierStart(source[lhs_start])) {
            search_from = dot_index + 1;
            continue;
        }

        const lhs = source[lhs_start..dot_index];
        if (!(try hasNamespaceImport(source, lhs, allocator))) {
            search_from = dot_index + 1;
            continue;
        }

        var cursor = skipWhitespace(source, dot_index + property.len);
        const is_assignment = cursor < source.len and
            source[cursor] == '=' and
            (cursor + 1 >= source.len or (source[cursor + 1] != '=' and source[cursor + 1] != '>'));

        try output.appendSlice(allocator, source[copied_until..lhs_start]);
        if (is_assignment) {
            cursor = skipWhitespace(source, cursor + 1);
            const value_start = cursor;
            if (std.mem.startsWith(u8, source[value_start..], "true")) {
                cursor = value_start + "true".len;
            } else if (std.mem.startsWith(u8, source[value_start..], "false")) {
                cursor = value_start + "false".len;
            } else {
                try output.appendSlice(allocator, source[lhs_start .. dot_index + property.len]);
                copied_until = dot_index + property.len;
                search_from = copied_until;
                changed = true;
                continue;
            }
            try output.appendSlice(allocator, "Object.defineProperty(Object(");
            try output.appendSlice(allocator, lhs);
            try output.appendSlice(allocator, "), \"__esModule\", { value: ");
            try output.appendSlice(allocator, source[value_start..cursor]);
            try output.appendSlice(allocator, ", configurable: true })");
            copied_until = cursor;
            search_from = cursor;
        } else {
            try output.appendSlice(allocator, "Object(");
            try output.appendSlice(allocator, lhs);
            try output.appendSlice(allocator, ")[\"__esModule\"]");
            copied_until = dot_index + property.len;
            search_from = copied_until;
        }
        changed = true;
    }

    if (!changed) return null;
    try output.appendSlice(allocator, source[copied_until..]);
    return try output.toOwnedSlice(allocator);
}

fn writeRuntimeEntryWrapper(
    ctx: *const Context,
    tmp_dir: []const u8,
    script_import_abs: []const u8,
    script_abs: []const u8,
    bundle_entry: bool,
    preload_imports: []const u8,
    test_cli_execution: bool,
    stable_source_map_path: bool,
    runtime_virtual_root: []const u8,
    bootstrap_mode: RuntimeBootstrapMode,
    runtime_module_entrypoint: bool,
) ![]const u8 {
    if (bootstrap_mode != .full) return writeMinimalRuntimeEntryWrapper(
        ctx,
        tmp_dir,
        script_import_abs,
        script_abs,
        preload_imports,
        test_cli_execution,
        stable_source_map_path,
        runtime_virtual_root,
        bootstrap_mode,
    );
    const wrapper_name = try std.fmt.allocPrint(
        ctx.allocator,
        "script-entry-cjs-{x}.mjs",
        .{std.hash.Wyhash.hash(0, script_abs)},
    );
    const wrapper_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, wrapper_name });

    const bun_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "bun", "index.js" });
    const bun_internal_for_testing_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "bun", "internal-for-testing.js" });
    const bun_wrap_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "bun", "wrap.js" });
    const fs_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "fs.js" });
    const fs_promises_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "fs", "promises.js" });
    const os_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "os.js" });
    const path_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "path.js" });
    const process_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "process.js" });
    const readline_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "readline.js" });
    const readline_promises_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "readline", "promises.js" });
    const util_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "util.js" });
    const util_types_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "util", "types.js" });
    const events_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "events.js" });
    const async_hooks_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "async_hooks.js" });
    const assert_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "assert.js" });
    const assert_strict_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "assert", "strict.js" });
    const console_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "console.js" });
    const diagnostics_channel_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "diagnostics_channel.js" });
    const domain_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "domain.js" });
    const tty_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "tty.js" });
    const v8_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "v8.js" });
    const stream_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "stream.js" });
    const stream_consumers_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "stream", "consumers.js" });
    const stream_promises_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "stream", "promises.js" });
    const stream_web_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "stream", "web.js" });
    const perf_hooks_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "perf_hooks.js" });
    const vm_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "vm.js" });
    const module_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "module.js" });
    const net_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "net.js" });
    const url_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "url.js" });
    const constants_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "constants.js" });
    const crypto_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "crypto.js" });
    const buffer_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "buffer.js" });
    const cluster_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "cluster.js" });
    const punycode_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "punycode.js" });
    const querystring_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "querystring.js" });
    const child_process_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "child_process.js" });
    const path_posix_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "path", "posix.cjs" });
    const path_win32_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "path", "win32.cjs" });
    const string_decoder_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "string_decoder.js" });
    const sys_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "sys.js" });
    const repl_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "repl.js" });
    const sea_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "sea.js" });
    const sqlite_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "sqlite.js" });
    const node_test_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "test.js" });
    const test_reporters_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "test", "reporters.js" });
    const timers_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "timers.js" });
    const timers_promises_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "timers", "promises.js" });
    const trace_events_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "trace_events.js" });
    const wasi_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "wasi.js" });
    const worker_threads_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "worker_threads.js" });
    const zlib_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "zlib.js" });
    const http_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "http.js" });
    const https_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "https.js" });
    const http2_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "http2.js" });
    const inspector_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "inspector.js" });
    const inspector_promises_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "inspector", "promises.js" });
    const dgram_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "dgram.js" });
    const dns_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "dns.js" });
    const dns_promises_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "dns", "promises.js" });
    const tls_module = try runtimeModulePathAtRoot(ctx, runtime_virtual_root, &.{ "node", "tls.js" });

    const imports_a = try std.fmt.allocPrint(
        ctx.allocator,
        \\import {s};
        \\import * as fs from {s};
        \\import * as fsPromises from {s};
        \\import * as os from {s};
        \\import * as path from {s};
        \\import * as processModule from {s};
        \\import * as readline from {s};
        \\import * as readlinePromises from {s};
        \\import * as util from {s};
        \\import * as utilTypes from {s};
        \\import * as events from {s};
        \\import * as asyncHooks from {s};
        \\import * as assert from {s};
        \\import * as assertStrict from {s};
        \\import * as consoleModule from {s};
        \\import * as diagnosticsChannel from {s};
        \\import * as domain from {s};
        \\
    ,
        .{
            try jsonStringLiteral(ctx, bun_module),
            try jsonStringLiteral(ctx, fs_module),
            try jsonStringLiteral(ctx, fs_promises_module),
            try jsonStringLiteral(ctx, os_module),
            try jsonStringLiteral(ctx, path_module),
            try jsonStringLiteral(ctx, process_module),
            try jsonStringLiteral(ctx, readline_module),
            try jsonStringLiteral(ctx, readline_promises_module),
            try jsonStringLiteral(ctx, util_module),
            try jsonStringLiteral(ctx, util_types_module),
            try jsonStringLiteral(ctx, events_module),
            try jsonStringLiteral(ctx, async_hooks_module),
            try jsonStringLiteral(ctx, assert_module),
            try jsonStringLiteral(ctx, assert_strict_module),
            try jsonStringLiteral(ctx, console_module),
            try jsonStringLiteral(ctx, diagnostics_channel_module),
            try jsonStringLiteral(ctx, domain_module),
        },
    );
    const imports_b = try std.fmt.allocPrint(
        ctx.allocator,
        \\import * as tty from {s};
        \\import * as v8 from {s};
        \\import * as stream from {s};
        \\import * as streamConsumers from {s};
        \\import * as streamPromises from {s};
        \\import * as streamWeb from {s};
        \\import * as perfHooks from {s};
        \\import * as vm from {s};
        \\import * as moduleModule from {s};
        \\import * as net from {s};
        \\import * as url from {s};
        \\import * as constants from {s};
        \\import * as crypto from {s};
        \\import * as buffer from {s};
        \\import * as cluster from {s};
        \\import * as punycode from {s};
        \\import * as querystring from {s};
        \\import * as childProcess from {s};
        \\import * as pathPosix from {s};
        \\import * as pathWin32 from {s};
        \\import * as stringDecoder from {s};
        \\import * as sys from {s};
        \\import * as repl from {s};
        \\import * as sea from {s};
        \\import * as nodeTest from {s};
        \\import * as testReporters from {s};
        \\import * as timers from {s};
        \\import * as timersPromises from {s};
        \\import * as traceEvents from {s};
        \\import * as wasi from {s};
        \\import * as workerThreads from {s};
        \\import * as zlib from {s};
        \\
    ,
        .{
            try jsonStringLiteral(ctx, tty_module),
            try jsonStringLiteral(ctx, v8_module),
            try jsonStringLiteral(ctx, stream_module),
            try jsonStringLiteral(ctx, stream_consumers_module),
            try jsonStringLiteral(ctx, stream_promises_module),
            try jsonStringLiteral(ctx, stream_web_module),
            try jsonStringLiteral(ctx, perf_hooks_module),
            try jsonStringLiteral(ctx, vm_module),
            try jsonStringLiteral(ctx, module_module),
            try jsonStringLiteral(ctx, net_module),
            try jsonStringLiteral(ctx, url_module),
            try jsonStringLiteral(ctx, constants_module),
            try jsonStringLiteral(ctx, crypto_module),
            try jsonStringLiteral(ctx, buffer_module),
            try jsonStringLiteral(ctx, cluster_module),
            try jsonStringLiteral(ctx, punycode_module),
            try jsonStringLiteral(ctx, querystring_module),
            try jsonStringLiteral(ctx, child_process_module),
            try jsonStringLiteral(ctx, path_posix_module),
            try jsonStringLiteral(ctx, path_win32_module),
            try jsonStringLiteral(ctx, string_decoder_module),
            try jsonStringLiteral(ctx, sys_module),
            try jsonStringLiteral(ctx, repl_module),
            try jsonStringLiteral(ctx, sea_module),
            try jsonStringLiteral(ctx, node_test_module),
            try jsonStringLiteral(ctx, test_reporters_module),
            try jsonStringLiteral(ctx, timers_module),
            try jsonStringLiteral(ctx, timers_promises_module),
            try jsonStringLiteral(ctx, trace_events_module),
            try jsonStringLiteral(ctx, wasi_module),
            try jsonStringLiteral(ctx, worker_threads_module),
            try jsonStringLiteral(ctx, zlib_module),
        },
    );
    const imports_c = try std.fmt.allocPrint(
        ctx.allocator,
        \\import * as http from {s};
        \\import * as https from {s};
        \\import * as http2 from {s};
        \\import * as inspector from {s};
        \\import * as inspectorPromises from {s};
        \\import * as dgram from {s};
        \\import * as dns from {s};
        \\import * as dnsPromises from {s};
        \\import * as tls from {s};
        \\import * as sqlite from {s};
        \\import * as bunInternalForTesting from {s};
        \\import * as bunWrap from {s};
        \\
    ,
        .{
            try jsonStringLiteral(ctx, http_module),
            try jsonStringLiteral(ctx, https_module),
            try jsonStringLiteral(ctx, http2_module),
            try jsonStringLiteral(ctx, inspector_module),
            try jsonStringLiteral(ctx, inspector_promises_module),
            try jsonStringLiteral(ctx, dgram_module),
            try jsonStringLiteral(ctx, dns_module),
            try jsonStringLiteral(ctx, dns_promises_module),
            try jsonStringLiteral(ctx, tls_module),
            try jsonStringLiteral(ctx, sqlite_module),
            try jsonStringLiteral(ctx, bun_internal_for_testing_module),
            try jsonStringLiteral(ctx, bun_wrap_module),
        },
    );
    const script_literal = try jsonStringLiteral(ctx, script_abs);
    const script_import_literal = try jsonStringLiteral(ctx, script_import_abs);
    const bundle_map_literal = if (stable_source_map_path)
        "\"\""
    else blk: {
        const bundle_map_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "script.bundle.mjs.map" });
        break :blk try jsonStringLiteral(ctx, bundle_map_path);
    };
    const bundle_source_root_literal = try jsonStringLiteral(
        ctx,
        if (stable_source_map_path) runtime_virtual_root else ctx.project_root,
    );
    const test_header_signal = if (test_cli_execution)
        "globalThis.__cottontailBunTestHeaderPrinted = true;"
    else
        "";
    const main_action = if (runtime_module_entrypoint)
        \\const __ctEntryPath = globalThis.process?.argv?.[1];
        \\if (!__ctEntryPath) throw new Error("Missing runtime entrypoint");
        \\const __ctPluginEntry = await globalThis.__cottontailResolvePluginEntrypoint?.(__ctEntryPath, __ctEntryPath);
        \\if (__ctPluginEntry?.matched) await __ctPluginEntry.value;
        \\else await globalThis.__cottontailImportModule(__ctEntryPath, __ctEntryPath, undefined, true);
    else if (bundle_entry)
        try std.fmt.allocPrint(ctx.allocator,
            \\const __ctPluginEntry = await globalThis.__cottontailResolvePluginEntrypoint?.({s}, {s});
            \\if (__ctPluginEntry?.matched) await __ctPluginEntry.value;
            \\else await import({s});
        , .{ script_literal, script_literal, script_import_literal })
    else
        try std.fmt.allocPrint(ctx.allocator,
            \\const __ctPluginEntry = await globalThis.__cottontailResolvePluginEntrypoint?.({s}, {s});
            \\if (__ctPluginEntry?.matched) await __ctPluginEntry.value;
            \\else (moduleModule.default ?? moduleModule.Module).runMain();
        , .{ script_literal, script_literal });
    const main_statement = try std.fmt.allocPrint(ctx.allocator,
        \\globalThis.__cottontailLoadDotenv?.();
        \\await globalThis.__cottontailLoadStandaloneBunfig?.();
        \\await globalThis.__cottontailLoadStandaloneExecPreloads?.();
        \\{s}
        \\globalThis.__cottontailLoadingTestModules = true;
        \\try {{
        \\{s}
        \\{s}globalThis.__cottontailTestRegistrationLayer = (globalThis.__cottontailTestRegistrationLayer ?? 0) + 1;
        \\{s}
        \\}} finally {{
        \\  globalThis.__cottontailLoadingTestModules = false;
        \\  globalThis[Symbol.for("cottontail.internal.startTestRun")]?.();
        \\}}
    , .{ test_header_signal, cpu_profiler_start_statement, preload_imports, main_action });
    // process.js initializes through a runtime cycle, so its bundled namespace
    // can expose an uninitialized default even after the global is ready.
    const bootstrap = try std.fmt.allocPrint(
        ctx.allocator,
        \\globalThis.__cottontailBundleSourceMap ??= {s};
        \\globalThis.__cottontailBundleSourceRoot ??= {s};
        \\globalThis.Loader ??= {{ registry: new Map() }};
        \\const eventsBuiltin = events.default ?? events;
        \\const assertBuiltin = assert.default ?? assert;
        \\const assertStrictBuiltin = assertStrict.default ?? assertStrict;
        \\const nodeTestBuiltin = nodeTest.default ?? nodeTest;
        \\const streamBuiltin = stream.default ?? stream;
        \\const pathBuiltin = path.default ?? path;
        \\const processBuiltin = globalThis.process ?? processModule.default ?? processModule;
        \\const pathPosixBuiltin = pathBuiltin.posix ?? pathPosix.default ?? pathPosix;
        \\const pathWin32Builtin = pathBuiltin.win32 ?? pathWin32.default ?? pathWin32;
        \\moduleModule.__setBuiltinModules({{
        \\  fs, "node:fs": fs,
        \\  "fs/promises": fsPromises, "node:fs/promises": fsPromises,
        \\  os, "node:os": os,
        \\  path: pathBuiltin, "node:path": pathBuiltin,
        \\  process: processBuiltin, "node:process": processBuiltin,
        \\  readline, "node:readline": readline,
        \\  "readline/promises": readlinePromises, "node:readline/promises": readlinePromises,
        \\  util, "node:util": util,
        \\  "util/types": utilTypes, "node:util/types": utilTypes,
        \\  events: eventsBuiltin, "node:events": eventsBuiltin,
        \\  async_hooks: asyncHooks, "node:async_hooks": asyncHooks,
        \\  assert: assertBuiltin, "node:assert": assertBuiltin,
        \\  "assert/strict": assertStrictBuiltin, "node:assert/strict": assertStrictBuiltin,
        \\  console: consoleModule, "node:console": consoleModule,
        \\  diagnostics_channel: diagnosticsChannel, "node:diagnostics_channel": diagnosticsChannel,
        \\  domain, "node:domain": domain,
        \\  tty, "node:tty": tty,
        \\  v8, "node:v8": v8,
        \\  stream: streamBuiltin, "node:stream": streamBuiltin,
        \\  "stream/consumers": streamConsumers, "node:stream/consumers": streamConsumers,
        \\  "stream/promises": streamPromises, "node:stream/promises": streamPromises,
        \\  "stream/web": streamWeb, "node:stream/web": streamWeb,
        \\  perf_hooks: perfHooks, "node:perf_hooks": perfHooks,
        \\  vm, "node:vm": vm,
        \\  module: moduleModule.default ?? moduleModule.Module, "node:module": moduleModule.default ?? moduleModule.Module,
        \\  net, "node:net": net,
        \\  url, "node:url": url,
        \\  constants, "node:constants": constants,
        \\  crypto, "node:crypto": crypto,
        \\  buffer, "node:buffer": buffer,
        \\  cluster, "node:cluster": cluster,
        \\  punycode, "node:punycode": punycode,
        \\  querystring, "node:querystring": querystring,
        \\  child_process: childProcess, "node:child_process": childProcess,
        \\  "path/posix": pathPosixBuiltin, "node:path/posix": pathPosixBuiltin,
        \\  "path/win32": pathWin32, "node:path/win32": pathWin32,
        \\  string_decoder: stringDecoder, "node:string_decoder": stringDecoder,
        \\  sys, "node:sys": sys,
        \\  repl, "node:repl": repl,
        \\  "node:sea": sea,
        \\  "node:sqlite": sqlite,
        \\  "node:test": nodeTestBuiltin,
        \\  "test/reporters": testReporters, "node:test/reporters": testReporters,
        \\  timers, "node:timers": timers,
        \\  "timers/promises": timersPromises, "node:timers/promises": timersPromises,
        \\  trace_events: traceEvents, "node:trace_events": traceEvents,
        \\  wasi, "node:wasi": wasi,
        \\  worker_threads: workerThreads, "node:worker_threads": workerThreads,
        \\  zlib, "node:zlib": zlib,
        \\  http, "node:http": http,
        \\  https, "node:https": https,
        \\  http2, "node:http2": http2,
        \\  inspector, "node:inspector": inspector,
        \\  "inspector/promises": inspectorPromises, "node:inspector/promises": inspectorPromises,
        \\  dgram, "node:dgram": dgram,
        \\  dns, "node:dns": dns,
        \\  "dns/promises": dnsPromises, "node:dns/promises": dnsPromises,
        \\  tls, "node:tls": tls,
        \\  "bun:internal-for-testing": bunInternalForTesting,
        \\  "internal-for-testing": bunInternalForTesting,
        \\  "bun:wrap": bunWrap
        \\}});
        \\{s}
        \\
    ,
        .{
            bundle_map_literal,
            bundle_source_root_literal,
            main_statement,
        },
    );
    const source = try std.mem.concat(ctx.allocator, u8, &.{ imports_a, imports_b, imports_c, bootstrap });
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = wrapper_path, .data = source });
    return wrapper_path;
}

fn jsonStringLiteral(ctx: *const Context, value: []const u8) ![]const u8 {
    return try std.json.Stringify.valueAlloc(ctx.allocator, std.json.Value{ .string = value }, .{});
}

fn runtimeModulePath(ctx: *const Context, parts: []const []const u8) ![]const u8 {
    return runtimeModulePathAtRoot(ctx, ctx.project_root, parts);
}

fn runtimeModulePathAtRoot(
    ctx: *const Context,
    runtime_virtual_root: []const u8,
    parts: []const []const u8,
) ![]const u8 {
    const relative_path = try std.fs.path.join(ctx.allocator, parts);
    return embedded_runtime_modules.virtualPath(ctx.allocator, runtime_virtual_root, relative_path);
}

fn ensureTempDir(ctx: *const Context) ![]const u8 {
    const run_root = try ensureTempRunRoot(ctx);

    var random_bytes: [16]u8 = undefined;
    for (0..8) |_| {
        ctx.io.random(&random_bytes);
        const dirname = try std.fmt.allocPrint(
            ctx.allocator,
            "{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}",
            .{
                random_bytes[0],
                random_bytes[1],
                random_bytes[2],
                random_bytes[3],
                random_bytes[4],
                random_bytes[5],
                random_bytes[6],
                random_bytes[7],
                random_bytes[8],
                random_bytes[9],
                random_bytes[10],
                random_bytes[11],
                random_bytes[12],
                random_bytes[13],
                random_bytes[14],
                random_bytes[15],
            },
        );
        const tmp_dir = try std.fs.path.join(ctx.allocator, &.{ run_root, dirname });
        std.Io.Dir.cwd().createDir(ctx.io, tmp_dir, .default_dir) catch |err| switch (err) {
            error.PathAlreadyExists => continue,
            else => return err,
        };
        return tmp_dir;
    }

    return error.TempDirCollision;
}

fn ensureTempRunRoot(ctx: *const Context) ![]const u8 {
    if (ctx.environ_map.get("COTTONTAIL_TMP_DIR")) |tmp_dir| {
        if (tmp_dir.len > 0) {
            const run_root = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "cottontail", "run" });
            try std.Io.Dir.cwd().createDirPath(ctx.io, run_root);
            return run_root;
        }
    }

    const project_run_root = try std.fs.path.join(ctx.allocator, &.{ ctx.project_root, ".cottontail-tmp", "run" });
    if (try createDirPathIfWritable(ctx, project_run_root)) {
        return project_run_root;
    }

    const os_tmp_root = try std.fs.path.join(ctx.allocator, &.{ osTempBase(ctx), "cottontail", "run" });
    try std.Io.Dir.cwd().createDirPath(ctx.io, os_tmp_root);
    return os_tmp_root;
}

fn createDirPathIfWritable(ctx: *const Context, path: []const u8) !bool {
    std.Io.Dir.cwd().createDirPath(ctx.io, path) catch |err| switch (err) {
        error.AccessDenied,
        error.FileNotFound,
        error.NotDir,
        error.ReadOnlyFileSystem,
        => return false,
        else => return err,
    };
    return true;
}

fn osTempBase(ctx: *const Context) []const u8 {
    if (ctx.environ_map.get("TMPDIR")) |value| {
        if (value.len > 0) return value;
    }
    if (ctx.environ_map.get("TEMP")) |value| {
        if (value.len > 0) return value;
    }
    if (ctx.environ_map.get("TMP")) |value| {
        if (value.len > 0) return value;
    }
    return if (builtin.os.tag == .windows) "C:\\Temp" else "/tmp";
}

fn resolvePathForCwd(io: std.Io, allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    return try std.Io.Dir.cwd().realPathFileAlloc(io, path, allocator);
}

fn absolutePathForCwd(io: std.Io, allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    if (std.fs.path.isAbsolute(path)) return try allocator.dupe(u8, path);
    const cwd = try std.Io.Dir.cwd().realPathFileAlloc(io, ".", allocator);
    return try std.fs.path.join(allocator, &.{ cwd, path });
}

fn pathExists(io: std.Io, path: []const u8) bool {
    if (std.fs.path.isAbsolute(path)) {
        std.Io.Dir.accessAbsolute(io, path, .{}) catch return false;
    } else {
        std.Io.Dir.cwd().access(io, path, .{}) catch return false;
    }
    return true;
}

fn runInherited(ctx: *const Context, argv: []const []const u8, cwd: []const u8) !void {
    var child = try std.process.spawn(ctx.io, .{
        .argv = argv,
        .cwd = .{ .path = cwd },
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    });
    defer child.kill(ctx.io);

    const term = try child.wait(ctx.io);
    if (termExitCode(term) != 0) return error.ProcessFailed;
}

fn termExitCode(term: std.process.Child.Term) u8 {
    return switch (term) {
        .exited => |code| @intCast(@min(code, 255)),
        .signal => 1,
        .stopped => 1,
        .unknown => 1,
    };
}

test "import attributes select JavaScript loader variants" {
    try std.testing.expectEqual(@as(u8, 0), requestedJavaScriptLoaderMask("undefined", false));
    try std.testing.expectEqual(javascriptLoaderBit("js"), requestedJavaScriptLoaderMask("{ with: { type: 'js' } }", true));
    try std.testing.expectEqual(javascriptLoaderBit("tsx"), requestedJavaScriptLoaderMask("{ assert: { type: \"tsx\" } }", true));
    try std.testing.expectEqual(@as(u8, 0), requestedJavaScriptLoaderMask("{ with: { type: \"json\" } }", true));
    try std.testing.expectEqual(all_javascript_loader_mask, requestedJavaScriptLoaderMask("options", true));
    try std.testing.expectEqual(all_javascript_loader_mask, requestedJavaScriptLoaderMask("{ with: { type: loader } }", true));
}

test "runtime module launcher is limited to ordinary file execution" {
    try std.testing.expect(canUseRuntimeModuleLauncher(.{}));
    try std.testing.expect(!canUseRuntimeModuleLauncher(.{ .has_source_base_dir = true }));
    try std.testing.expect(!canUseRuntimeModuleLauncher(.{ .has_build_options = true }));
    try std.testing.expect(!canUseRuntimeModuleLauncher(.{ .has_graph_output = true }));
    try std.testing.expect(!canUseRuntimeModuleLauncher(.{ .standalone_compile = true }));
    try std.testing.expect(!canUseRuntimeModuleLauncher(.{ .tracks_reload_dependencies = true }));
    try std.testing.expect(!canUseRuntimeModuleLauncher(.{ .test_cli_execution = true }));
    try std.testing.expect(!canUseRuntimeModuleLauncher(.{ .wasm_entrypoint = true }));
}

test "eval source maps use Bun's virtual source identity" {
    const source_map =
        \\{"version":3,"sources":[".cottontail-eval-abc.mts","src/other.ts",".cottontail-compat-physical.mts",".cottontail-compat-virtual.mts"],"sourcesContent":[null,null,"/*@cottontail-original-path-base64:L3dvcmsvLmNvdHRvbnRhaWwtZXZhbC1hYmMubXRz*/generated","/*@cottontail-original-path-base64:L3dvcmsvW2V2YWxd*/generated"],"mappings":""}
    ;
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, source_map, .{});
    defer parsed.deinit();

    try std.testing.expect(try replaceEvalSourcePath(std.testing.allocator, &parsed.value, "/work/.cottontail-eval-abc.mts"));
    const sources = parsed.value.object.get("sources").?.array.items;
    try std.testing.expectEqualStrings("[eval]", sources[0].string);
    try std.testing.expectEqualStrings("src/other.ts", sources[1].string);
    try std.testing.expectEqualStrings("[eval]", sources[2].string);
    try std.testing.expectEqualStrings("[eval]", sources[3].string);
    try std.testing.expect(!sourcePathEndsWithComponent("prefix.cottontail-eval-abc.mts", ".cottontail-eval-abc.mts"));
    try std.testing.expect(sourcePathEndsWithComponent("C:\\work\\.cottontail-eval-abc.mts", ".cottontail-eval-abc.mts"));
}

test "parseBunfigTestPreloads extracts single quoted preload" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const toml =
        "# top comment\n" ++
        "[install]\n" ++
        "preload = \"./not-this.ts\"\n" ++
        "[test]\n" ++
        "# comment inside\n" ++
        "coverage = true\n" ++
        "preload = \"./preload.ts\" # trailing comment\n" ++
        "[other]\n" ++
        "preload = \"./nor-this.ts\"\n";
    const preloads = try parseBunfigTestPreloads(arena.allocator(), toml, true);
    try std.testing.expectEqual(@as(usize, 1), preloads.len);
    try std.testing.expectEqualStrings("./preload.ts", preloads[0]);
}

test "parseBunfigTestPreloads extracts array preloads" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const single_line = "[test]\npreload = [\"./a.ts\", './b.ts']\n";
    const single = try parseBunfigTestPreloads(arena.allocator(), single_line, true);
    try std.testing.expectEqual(@as(usize, 2), single.len);
    try std.testing.expectEqualStrings("./a.ts", single[0]);
    try std.testing.expectEqualStrings("./b.ts", single[1]);

    const multi_line = "[test]\npreload = [\n  \"./a.ts\",\n  \"./b.ts\", # comment\n]\ncoverage = false\n";
    const multi = try parseBunfigTestPreloads(arena.allocator(), multi_line, true);
    try std.testing.expectEqual(@as(usize, 2), multi.len);
    try std.testing.expectEqualStrings("./a.ts", multi[0]);
    try std.testing.expectEqualStrings("./b.ts", multi[1]);
}

test "parseBunfigTestPreloads ignores test subsections and missing preload" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const toml = "[test.coverage]\npreload = \"./nope.ts\"\n[test]\ncoverage = true\n";
    const preloads = try parseBunfigTestPreloads(arena.allocator(), toml, true);
    try std.testing.expectEqual(@as(usize, 0), preloads.len);
}

test "isTestEntrypointPath matches bun test naming" {
    try std.testing.expect(isTestEntrypointPath("/a/b/example.test.ts"));
    try std.testing.expect(isTestEntrypointPath("/a/b/example.test.cjs"));
    try std.testing.expect(isTestEntrypointPath("/a/b/example_test.ts"));
    try std.testing.expect(isTestEntrypointPath("/a/b/example.spec.mts"));
    try std.testing.expect(isTestEntrypointPath("/a/b/example_spec.cts"));
    try std.testing.expect(!isTestEntrypointPath("/a/b.test.d/example.ts"));
    try std.testing.expect(!isTestEntrypointPath("/a/b/example.test.txt"));
    try std.testing.expect(!isTestEntrypointPath("/a/b/example.ts"));

    try std.testing.expect(shouldLoadBunfigTestPreloads("/a/b/example.test.ts", true));
    try std.testing.expect(shouldLoadBunfigTestPreloads("/a/.cottontail-tmp/test-aggregate-1/entry.mjs", true));
    try std.testing.expect(!shouldLoadBunfigTestPreloads("/a/b/example.test.ts", false));
    try std.testing.expect(!shouldLoadBunfigTestPreloads("/a/b/example.ts", true));
}
