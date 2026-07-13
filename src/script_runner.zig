const std = @import("std");
const builtin = @import("builtin");
const runtime = @import("runtime.zig");

const esbuild_version = "0.28.0";
const script_thread_stack_size = 128 * 1024 * 1024;
const script_js_stack_size = 96 * 1024 * 1024;

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

const ScriptExecution = struct {
    io: std.Io,
    allocator: std.mem.Allocator,
    runnable_path: [:0]const u8,
    process_args: []const [:0]const u8,
    process_user_arg_offset: usize,
    exec_args: []const [:0]const u8,
    exit_code: u8 = 1,
};

const Context = struct {
    io: std.Io,
    allocator: std.mem.Allocator,
    environ_map: *std.process.Environ.Map,
    cottontail_home: []const u8,
    project_root: []const u8,

    fn writeStdout(self: *const Context, comptime fmt: []const u8, args: anytype) void {
        var buffer: [2048]u8 = undefined;
        var writer = std.Io.File.stdout().writer(self.io, &buffer);
        const stdout = &writer.interface;
        stdout.print(fmt, args) catch {};
        stdout.flush() catch {};
    }

    fn writeStderr(self: *const Context, comptime fmt: []const u8, args: anytype) void {
        var buffer: [2048]u8 = undefined;
        var writer = std.Io.File.stderr().writer(self.io, &buffer);
        const stderr = &writer.interface;
        stderr.print(fmt, args) catch {};
        stderr.flush() catch {};
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

pub fn runWithExecArgvDisplay(
    init: std.process.Init,
    script_path: [:0]const u8,
    display_path: ?[:0]const u8,
    script_args: []const [:0]const u8,
    exec_args: []const [:0]const u8,
) !u8 {
    const allocator = init.arena.allocator();
    const ctx = try makeContext(init);

    if (try rejectInvalidBunCjsPragma(&ctx, script_path)) return 1;

    const runnable_path = if (runtimeModulesAvailable(&ctx) or isTypescriptPath(script_path))
        try bundleScriptWithEsbuild(&ctx, script_path, exec_args, script_args, null)
    else blk: {
        const script_abs = try resolvePathForCwd(ctx.io, ctx.allocator, script_path);
        if (try shouldBundleCommonJsEntrypoint(&ctx, script_abs)) {
            const tmp_dir = try ensureTempDir(&ctx);
            break :blk try writeCommonJsEntryWrapper(&ctx, tmp_dir, script_abs, false, "");
        }
        break :blk script_abs;
    };
    defer cleanupRunnableDirectory(&ctx, runnable_path);

    const runnable_path_z = try allocator.dupeZ(u8, runnable_path);
    const process_args = try allocator.alloc([:0]const u8, script_args.len + 1);
    process_args[0] = display_path orelse script_path;
    for (script_args, 0..) |arg, index| {
        process_args[index + 1] = arg;
    }

    return try runPrepared(init, &ctx, runnable_path_z, process_args, 1, exec_args);
}

pub fn runEval(
    init: std.process.Init,
    source: [:0]const u8,
    script_args: []const [:0]const u8,
    exec_args: []const [:0]const u8,
    print_result: bool,
) !u8 {
    const ctx = try makeContext(init);
    const module_input = hasModuleInputType(exec_args) or sourceLooksEsm(source);
    const eval_path = try writeEvalEntrypoint(&ctx, ctx.project_root, source, print_result, module_input);
    var eval_path_active = true;
    defer if (eval_path_active) std.Io.Dir.cwd().deleteFile(ctx.io, eval_path) catch {};
    const runnable_path = if (runtimeModulesAvailable(&ctx) or isTypescriptPath(eval_path))
        try bundleScriptWithEsbuild(&ctx, eval_path, exec_args, script_args, ctx.project_root)
    else
        eval_path;
    if (!std.mem.eql(u8, runnable_path, eval_path)) {
        std.Io.Dir.cwd().deleteFile(ctx.io, eval_path) catch {};
        eval_path_active = false;
    }
    defer cleanupRunnableDirectory(&ctx, runnable_path);
    const runnable_path_z = try init.arena.allocator().dupeZ(u8, runnable_path);
    return try runPrepared(init, &ctx, runnable_path_z, script_args, 0, exec_args);
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

    const source_z = try allocator.dupeZ(u8, source.items);
    return try runEval(init, source_z, script_args, exec_args, false);
}

fn makeContext(init: std.process.Init) !Context {
    const allocator = init.arena.allocator();
    const exe_dir = try std.process.executableDirPathAlloc(init.io, allocator);
    return .{
        .io = init.io,
        .allocator = allocator,
        .environ_map = init.environ_map,
        .cottontail_home = try findCottontailHome(init, allocator, exe_dir),
        .project_root = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator),
    };
}

extern "c" fn setenv(name: [*:0]const u8, value: [*:0]const u8, overwrite: c_int) c_int;

fn applyRuntimeEnvFlags(allocator: std.mem.Allocator, exec_args: []const [:0]const u8) void {
    for (exec_args, 0..) |arg, index| {
        var value: ?[]const u8 = null;
        if (std.mem.startsWith(u8, arg, "--max-http-header-size=")) {
            value = arg["--max-http-header-size=".len..];
        } else if (std.mem.eql(u8, arg, "--max-http-header-size") and index + 1 < exec_args.len) {
            value = exec_args[index + 1];
        }
        if (value) |size_text| {
            const value_z = allocator.dupeZ(u8, size_text) catch return;
            _ = setenv("BUN_HTTP_MAX_HEADER_SIZE", value_z.ptr, 1);
        }
    }
}

fn runPrepared(
    init: std.process.Init,
    ctx: *const Context,
    runnable_path_z: [:0]const u8,
    process_args: []const [:0]const u8,
    process_user_arg_offset: usize,
    exec_args: []const [:0]const u8,
) !u8 {
    const allocator = init.arena.allocator();
    applyRuntimeEnvFlags(allocator, exec_args);
    var execution = ScriptExecution{
        .io = init.io,
        .allocator = allocator,
        .runnable_path = runnable_path_z,
        .process_args = process_args,
        .process_user_arg_offset = process_user_arg_offset,
        .exec_args = exec_args,
    };
    const thread = try std.Thread.spawn(
        .{ .stack_size = script_thread_stack_size },
        runScriptExecution,
        .{&execution},
    );

    if (shouldRunElectrobunMainThread(ctx)) {
        const main_thread_status = runElectrobunMainThread(ctx) catch |err| blk: {
            ctx.writeStderr("cottontail: failed to run Electrobun main thread: {s}\n", .{@errorName(err)});
            break :blk @as(u8, 1);
        };
        thread.join();
        if (main_thread_status != 0) {
            return main_thread_status;
        }
    } else {
        thread.join();
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

fn runScriptExecution(execution: *ScriptExecution) void {
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

    js_runtime.setProcessArgs(
        execution.process_args,
        execution.process_user_arg_offset,
        execution.exec_args,
    ) catch {
        writeStderr(execution.io, "cottontail: failed to initialize cottontail.args\n", .{});
        execution.exit_code = 1;
        return;
    };

    execution.exit_code = js_runtime.runFile(execution.runnable_path);
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

fn bundleScriptWithEsbuild(
    ctx: *const Context,
    script_path: []const u8,
    exec_args: []const [:0]const u8,
    script_args: []const [:0]const u8,
    source_base_dir: ?[]const u8,
) ![]const u8 {
    try ensureEsbuild(ctx);
    const tmp_dir = try ensureTempDir(ctx);
    errdefer std.Io.Dir.cwd().deleteTree(ctx.io, tmp_dir) catch {};

    const script_abs = try resolvePathForCwd(ctx.io, ctx.allocator, script_path);
    const script_dir = std.fs.path.dirname(script_abs) orelse ctx.project_root;
    var package_json_patch = try maybePatchEmptyPackageJsonForBundle(ctx, script_dir);
    defer restoreEmptyMetadataPatch(ctx, &package_json_patch);

    const is_wasm_entrypoint = std.mem.eql(u8, std.fs.path.extension(script_abs), ".wasm");
    const script_entry_abs = if (is_wasm_entrypoint)
        script_abs
    else
        try writeBunCompatTransformedSource(ctx, script_abs, source_base_dir);
    defer cleanupGeneratedSource(ctx, script_entry_abs, script_abs);

    const preload_imports = try buildBunfigTestPreloadImports(ctx, script_abs);
    const wrapped_entry = if (is_wasm_entrypoint)
        try writeWasiEntryWrapper(ctx, tmp_dir, script_abs)
    else if (try shouldBundleCommonJsEntrypoint(ctx, script_abs))
        try writeCommonJsEntryWrapper(
            ctx,
            tmp_dir,
            script_abs,
            hasCustomConditions(exec_args) or hasCustomConditions(script_args),
            preload_imports,
        )
    else
        try writeCottontailEntryWrapper(ctx, tmp_dir, script_entry_abs, script_abs, preload_imports);
    const bundle_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "script.bundle.mjs" });
    const esbuild_bin = try esbuildBinaryPath(ctx);
    const script_url = try std.fmt.allocPrint(ctx.allocator, "file://{s}", .{script_abs});
    const script_dir_literal = try jsonStringLiteral(ctx, script_dir);
    const script_basename_literal = try jsonStringLiteral(ctx, std.fs.path.basename(script_abs));
    const script_path_literal = try jsonStringLiteral(ctx, script_abs);
    const script_url_literal = try jsonStringLiteral(ctx, script_url);

    const bun_module = try runtimeModulePath(ctx, &.{ "bun", "index.js" });
    const bun_ffi_module = try runtimeModulePath(ctx, &.{ "bun", "ffi.js" });
    const bun_jsc_module = try runtimeModulePath(ctx, &.{ "bun", "jsc.js" });
    const bun_sqlite_module = try runtimeModulePath(ctx, &.{ "bun", "sqlite.js" });
    const bun_test_module = try runtimeModulePath(ctx, &.{ "bun", "test.js" });
    const bun_internal_for_testing_module = try runtimeModulePath(ctx, &.{ "bun", "internal-for-testing.js" });
    const string_width_module = try runtimeModulePath(ctx, &.{ "bun", "string-width.js" });
    const strip_ansi_module = try runtimeModulePath(ctx, &.{ "bun", "strip-ansi.js" });
    const fs_module = try runtimeModulePath(ctx, &.{ "node", "fs.js" });
    const fs_promises_module = try runtimeModulePath(ctx, &.{ "node", "fs", "promises.js" });
    const os_module = try runtimeModulePath(ctx, &.{ "node", "os.js" });
    const path_module = try runtimeModulePath(ctx, &.{ "node", "path.js" });
    const process_module = try runtimeModulePath(ctx, &.{ "node", "process.js" });
    const readline_module = try runtimeModulePath(ctx, &.{ "node", "readline.js" });
    const readline_promises_module = try runtimeModulePath(ctx, &.{ "node", "readline", "promises.js" });
    const util_module = try runtimeModulePath(ctx, &.{ "node", "util.js" });
    const util_types_module = try runtimeModulePath(ctx, &.{ "node", "util", "types.js" });
    const events_module = try runtimeModulePath(ctx, &.{ "node", "events.cjs" });
    const async_hooks_module = try runtimeModulePath(ctx, &.{ "node", "async_hooks.js" });
    const assert_module = try runtimeModulePath(ctx, &.{ "node", "assert.cjs" });
    const assert_strict_module = try runtimeModulePath(ctx, &.{ "node", "assert", "strict.js" });
    const console_module = try runtimeModulePath(ctx, &.{ "node", "console.js" });
    const diagnostics_channel_module = try runtimeModulePath(ctx, &.{ "node", "diagnostics_channel.js" });
    const domain_module = try runtimeModulePath(ctx, &.{ "node", "domain.js" });
    const tty_module = try runtimeModulePath(ctx, &.{ "node", "tty.js" });
    const v8_module = try runtimeModulePath(ctx, &.{ "node", "v8.js" });
    const stream_module = try runtimeModulePath(ctx, &.{ "node", "stream.cjs" });
    const stream_consumers_module = try runtimeModulePath(ctx, &.{ "node", "stream", "consumers.js" });
    const stream_promises_module = try runtimeModulePath(ctx, &.{ "node", "stream", "promises.js" });
    const stream_web_module = try runtimeModulePath(ctx, &.{ "node", "stream", "web.js" });
    const perf_hooks_module = try runtimeModulePath(ctx, &.{ "node", "perf_hooks.js" });
    const vm_module = try runtimeModulePath(ctx, &.{ "node", "vm.js" });
    const module_module = try runtimeModulePath(ctx, &.{ "node", "module.js" });
    const net_module = try runtimeModulePath(ctx, &.{ "node", "net.js" });
    const url_module = try runtimeModulePath(ctx, &.{ "node", "url.js" });
    const constants_module = try runtimeModulePath(ctx, &.{ "node", "constants.js" });
    const crypto_module = try runtimeModulePath(ctx, &.{ "node", "crypto.js" });
    const buffer_module = try runtimeModulePath(ctx, &.{ "node", "buffer.js" });
    const cluster_module = try runtimeModulePath(ctx, &.{ "node", "cluster.js" });
    const punycode_module = try runtimeModulePath(ctx, &.{ "node", "punycode.js" });
    const querystring_module = try runtimeModulePath(ctx, &.{ "node", "querystring.js" });
    const child_process_module = try runtimeModulePath(ctx, &.{ "node", "child_process.js" });
    const path_posix_module = try runtimeModulePath(ctx, &.{ "node", "path", "posix.cjs" });
    const path_win32_module = try runtimeModulePath(ctx, &.{ "node", "path", "win32.cjs" });
    const string_decoder_module = try runtimeModulePath(ctx, &.{ "node", "string_decoder.js" });
    const sys_module = try runtimeModulePath(ctx, &.{ "node", "sys.js" });
    const repl_module = try runtimeModulePath(ctx, &.{ "node", "repl.js" });
    const sea_module = try runtimeModulePath(ctx, &.{ "node", "sea.js" });
    const sqlite_module = try runtimeModulePath(ctx, &.{ "node", "sqlite.js" });
    const node_test_module = try runtimeModulePath(ctx, &.{ "node", "test.js" });
    const test_reporters_module = try runtimeModulePath(ctx, &.{ "node", "test", "reporters.js" });
    const timers_module = try runtimeModulePath(ctx, &.{ "node", "timers.js" });
    const timers_promises_module = try runtimeModulePath(ctx, &.{ "node", "timers", "promises.js" });
    const trace_events_module = try runtimeModulePath(ctx, &.{ "node", "trace_events.js" });
    const wasi_module = try runtimeModulePath(ctx, &.{ "node", "wasi.js" });
    const worker_threads_module = try runtimeModulePath(ctx, &.{ "node", "worker_threads.js" });
    const zlib_module = try runtimeModulePath(ctx, &.{ "node", "zlib.js" });
    const http_module = try runtimeModulePath(ctx, &.{ "node", "http.js" });
    const https_module = try runtimeModulePath(ctx, &.{ "node", "https.js" });
    const http2_module = try runtimeModulePath(ctx, &.{ "node", "http2.js" });
    const inspector_module = try runtimeModulePath(ctx, &.{ "node", "inspector.js" });
    const inspector_promises_module = try runtimeModulePath(ctx, &.{ "node", "inspector", "promises.js" });
    const dgram_module = try runtimeModulePath(ctx, &.{ "node", "dgram.js" });
    const dns_module = try runtimeModulePath(ctx, &.{ "node", "dns.js" });
    const dns_promises_module = try runtimeModulePath(ctx, &.{ "node", "dns", "promises.js" });
    const tls_module = try runtimeModulePath(ctx, &.{ "node", "tls.js" });

    const base_args = [_][]const u8{
        esbuild_bin,
        wrapped_entry,
        "--bundle",
        "--platform=neutral",
        "--format=esm",
        "--main-fields=main,module",
        "--target=es2022",
        "--external:internal/*",
        "--loader:.txt=text",
        try std.fmt.allocPrint(ctx.allocator, "--alias:vitest={s}", .{bun_test_module}),
        "--external:jest-extended",
        "--external:@jest/globals",
        "--sourcemap=external",
        // Bun resolves .mjs/.cjs for extensionless specifiers; esbuild's default list omits them.
        "--resolve-extensions=.tsx,.ts,.jsx,.mjs,.js,.cjs,.json",
        try std.fmt.allocPrint(ctx.allocator, "--outfile={s}", .{bundle_path}),
        // import.meta.* map to bundle-scope vars (seeded via --banner) instead of
        // string literals so user code can also assign to them (e.g. fs.test.ts
        // does `import.meta.dir = "."`).
        "--define:import.meta.dirname=__ctMetaDirname",
        "--define:import.meta.dir=__ctMetaDir",
        "--define:import.meta.filename=__ctMetaFilename",
        "--define:import.meta.file=__ctMetaFile",
        "--define:import.meta.path=__ctMetaPath",
        "--define:import.meta.url=__ctMetaUrl",
        "--define:import.meta.main=__ctMetaMain",
        "--define:import.meta.env=__ctMetaEnv",
        "--define:import.meta.require=__ctMetaRequire",
        "--define:import.meta.resolveSync=__ctMetaResolveSync",
        "--define:import.meta.resolve=__ctMetaResolve",
        try std.fmt.allocPrint(
            ctx.allocator,
            "--banner:js=/* cottontail:module-syntax-lowered */ var __ctMetaDirname = {s}, __ctMetaDir = {s}, __ctMetaFilename = {s}, __ctMetaFile = {s}, __ctMetaPath = {s}, __ctMetaUrl = {s}, __ctMetaMain = true, __ctMetaEnv, __ctMetaRequire, __ctMetaResolveSync, __ctMetaResolve;",
            .{ script_dir_literal, script_dir_literal, script_path_literal, script_basename_literal, script_path_literal, script_url_literal },
        ),
        try std.fmt.allocPrint(ctx.allocator, "--alias:bun={s}", .{bun_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:bun:ffi={s}", .{bun_ffi_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:bun:jsc={s}", .{bun_jsc_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:bun:sqlite={s}", .{bun_sqlite_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:bun:test={s}", .{bun_test_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:bun:internal-for-testing={s}", .{bun_internal_for_testing_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:string-width={s}", .{string_width_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:strip-ansi={s}", .{strip_ansi_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:fs={s}", .{fs_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:fs={s}", .{fs_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:fs/promises={s}", .{fs_promises_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:fs/promises={s}", .{fs_promises_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:os={s}", .{os_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:os={s}", .{os_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:path={s}", .{path_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:path={s}", .{path_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:path/posix={s}", .{path_posix_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:path/posix={s}", .{path_posix_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:path/win32={s}", .{path_win32_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:path/win32={s}", .{path_win32_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:process={s}", .{process_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:process={s}", .{process_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:readline={s}", .{readline_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:readline={s}", .{readline_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:readline/promises={s}", .{readline_promises_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:readline/promises={s}", .{readline_promises_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:util={s}", .{util_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:util={s}", .{util_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:util/types={s}", .{util_types_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:util/types={s}", .{util_types_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:events={s}", .{events_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:events={s}", .{events_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:async_hooks={s}", .{async_hooks_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:async_hooks={s}", .{async_hooks_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:assert={s}", .{assert_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:assert={s}", .{assert_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:assert/strict={s}", .{assert_strict_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:assert/strict={s}", .{assert_strict_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:console={s}", .{console_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:console={s}", .{console_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:diagnostics_channel={s}", .{diagnostics_channel_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:diagnostics_channel={s}", .{diagnostics_channel_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:domain={s}", .{domain_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:domain={s}", .{domain_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:sys={s}", .{sys_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:sys={s}", .{sys_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:repl={s}", .{repl_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:repl={s}", .{repl_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:sea={s}", .{sea_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:sqlite={s}", .{sqlite_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:test={s}", .{node_test_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:test/reporters={s}", .{test_reporters_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:test/reporters={s}", .{test_reporters_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:tty={s}", .{tty_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:tty={s}", .{tty_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:v8={s}", .{v8_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:v8={s}", .{v8_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:stream={s}", .{stream_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:stream={s}", .{stream_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:stream/consumers={s}", .{stream_consumers_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:stream/consumers={s}", .{stream_consumers_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:stream/promises={s}", .{stream_promises_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:stream/promises={s}", .{stream_promises_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:stream/web={s}", .{stream_web_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:stream/web={s}", .{stream_web_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:perf_hooks={s}", .{perf_hooks_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:perf_hooks={s}", .{perf_hooks_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:vm={s}", .{vm_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:vm={s}", .{vm_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:module={s}", .{module_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:module={s}", .{module_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:net={s}", .{net_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:net={s}", .{net_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:url={s}", .{url_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:url={s}", .{url_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:constants={s}", .{constants_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:constants={s}", .{constants_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:crypto={s}", .{crypto_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:crypto={s}", .{crypto_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:buffer={s}", .{buffer_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:buffer={s}", .{buffer_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:cluster={s}", .{cluster_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:cluster={s}", .{cluster_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:punycode={s}", .{punycode_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:punycode={s}", .{punycode_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:querystring={s}", .{querystring_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:querystring={s}", .{querystring_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:child_process={s}", .{child_process_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:child_process={s}", .{child_process_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:string_decoder={s}", .{string_decoder_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:string_decoder={s}", .{string_decoder_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:timers={s}", .{timers_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:timers={s}", .{timers_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:timers/promises={s}", .{timers_promises_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:timers/promises={s}", .{timers_promises_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:trace_events={s}", .{trace_events_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:trace_events={s}", .{trace_events_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:wasi={s}", .{wasi_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:wasi={s}", .{wasi_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:worker_threads={s}", .{worker_threads_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:worker_threads={s}", .{worker_threads_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:zlib={s}", .{zlib_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:zlib={s}", .{zlib_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:http={s}", .{http_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:http={s}", .{http_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:https={s}", .{https_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:https={s}", .{https_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:http2={s}", .{http2_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:http2={s}", .{http2_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:inspector={s}", .{inspector_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:inspector={s}", .{inspector_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:inspector/promises={s}", .{inspector_promises_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:inspector/promises={s}", .{inspector_promises_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:dgram={s}", .{dgram_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:dgram={s}", .{dgram_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:dns={s}", .{dns_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:dns={s}", .{dns_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:dns/promises={s}", .{dns_promises_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:dns/promises={s}", .{dns_promises_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:tls={s}", .{tls_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:tls={s}", .{tls_module}),
    };

    var args: std.ArrayList([]const u8) = .empty;
    try args.appendSlice(ctx.allocator, &base_args);
    if (try tsconfigOverridePath(ctx, exec_args)) |tsconfig_path| {
        try args.append(ctx.allocator, try std.fmt.allocPrint(ctx.allocator, "--tsconfig={s}", .{tsconfig_path}));
    } else if (try metadataFileIsEmpty(ctx, script_dir, "tsconfig.json")) {
        try args.append(ctx.allocator, "--tsconfig-raw={}");
    }
    try appendEsbuildConditions(ctx.allocator, &args, exec_args, script_args);

    const result = try std.process.run(ctx.allocator, ctx.io, .{
        .argv = args.items,
        .cwd = .{ .path = ctx.project_root },
        .create_no_window = true,
    });
    defer ctx.allocator.free(result.stdout);
    defer ctx.allocator.free(result.stderr);

    if (termExitCode(result.term) != 0) {
        if (result.stdout.len > 0) ctx.writeStdout("{s}", .{result.stdout});
        if (result.stderr.len > 0) ctx.writeStderr("{s}", .{result.stderr});
        if (std.mem.indexOf(u8, result.stderr, "Could not resolve \"")) |marker| {
            const spec_start = marker + "Could not resolve \"".len;
            if (std.mem.indexOfScalarPos(u8, result.stderr, spec_start, '"')) |spec_end| {
                ctx.writeStderr("error: Cannot find module \"{s}\"\n", .{result.stderr[spec_start..spec_end]});
            }
        }
        return error.EsbuildFailed;
    }

    return bundle_path;
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

fn cleanupRunnableDirectory(ctx: *const Context, runnable_path: []const u8) void {
    const directory = std.fs.path.dirname(runnable_path) orelse return;
    const run_root = std.fs.path.dirname(directory) orelse return;
    if (!std.mem.eql(u8, std.fs.path.basename(run_root), "run")) return;

    const generated_name = std.fs.path.basename(directory);
    if (generated_name.len != 32) return;
    for (generated_name) |byte| {
        if (!std.ascii.isHex(byte)) return;
    }
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

fn hasCustomConditions(cli_args: []const [:0]const u8) bool {
    for (cli_args) |arg| {
        if (std.mem.eql(u8, arg, "--conditions") or std.mem.startsWith(u8, arg, "--conditions=")) return true;
    }
    return false;
}

fn appendEsbuildConditions(
    allocator: std.mem.Allocator,
    args: *std.ArrayList([]const u8),
    exec_args: []const [:0]const u8,
    script_args: []const [:0]const u8,
) !void {
    var conditions: std.ArrayList([]const u8) = .empty;
    try collectConditions(allocator, &conditions, exec_args);
    try collectConditions(allocator, &conditions, script_args);
    if (conditions.items.len == 0) return;

    const joined = try std.mem.join(allocator, ",", conditions.items);
    try args.append(allocator, try std.fmt.allocPrint(allocator, "--conditions={s}", .{joined}));
}

fn shouldBundleCommonJsEntrypoint(ctx: *const Context, script_abs: []const u8) !bool {
    if (std.mem.endsWith(u8, script_abs, ".cjs")) return true;
    if (std.mem.endsWith(u8, script_abs, ".mjs")) return false;
    if (!std.mem.endsWith(u8, script_abs, ".js")) {
        if (std.fs.path.extension(script_abs).len == 0) {
            return try extensionlessEntrypointLooksCommonJs(ctx, script_abs);
        }
        return false;
    }

    if (try sourceFileLooksEsm(ctx, script_abs)) return false;
    if (try sourceLooksCommonJs(ctx, script_abs)) return true;

    const script_dir = std.fs.path.dirname(script_abs) orelse ctx.project_root;
    return !(try nearestPackageTypeIsModule(ctx, script_dir));
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

fn writeEvalEntrypoint(
    ctx: *const Context,
    tmp_dir: []const u8,
    source: []const u8,
    print_result: bool,
    module_input: bool,
) ![]const u8 {
    const extension = if (module_input) "mts" else "cts";
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

    const eval_source = if (!print_result and !module_input)
        try std.fmt.allocPrint(
            ctx.allocator,
            \\(async () => {{
            \\{s}
            \\}})().catch((error) => {{
            \\  console.error(error?.stack ?? error);
            \\  process.exitCode = 1;
            \\}});
            \\
        ,
            .{source},
        )
    else if (!print_result)
        source
    else if (module_input)
        try std.fmt.allocPrint(
            ctx.allocator,
            \\import * as __ctUtil from "node:util";
            \\const gc = globalThis.gc;
            \\const __ctPrintResult = eval({s});
            \\console.log(typeof __ctPrintResult === "string" ? __ctPrintResult : __ctUtil.inspect(__ctPrintResult));
            \\
        ,
            .{source_literal},
        )
    else
        try std.fmt.allocPrint(
            ctx.allocator,
            \\const __ctUtil = require("node:util");
            \\const gc = globalThis.gc;
            \\const __ctPrintResult = eval({s});
            \\console.log(typeof __ctPrintResult === "string" ? __ctPrintResult : __ctUtil.inspect(__ctPrintResult));
            \\
        ,
            .{source_literal},
        );

    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = wrapper_path, .data = eval_source });
    return wrapper_path;
}

fn isTestEntrypointPath(path: []const u8) bool {
    const name = std.fs.path.basename(path);
    if (std.mem.indexOf(u8, name, ".test.") == null) return false;
    const extensions = [_][]const u8{ ".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts" };
    for (extensions) |extension| {
        if (std.mem.endsWith(u8, name, extension)) return true;
    }
    return false;
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
    var in_active_section = true;
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
            in_active_section = include_test_section and std.mem.startsWith(u8, line, "[test]");
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

/// For a test entrypoint, discover bunfig.toml by walking up from the
/// script's directory (matching `bun test` discovery) and return
/// `await import(...)` statements for its `[test] preload` entries, resolved
/// relative to the bunfig.toml's directory. Returns "" when not applicable.
fn buildBunfigTestPreloadImports(ctx: *const Context, script_abs: []const u8) ![]const u8 {
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
        const preloads = try parseBunfigTestPreloads(ctx.allocator, contents, isTestEntrypointPath(script_abs));
        var imports: std.ArrayList(u8) = .empty;
        for (preloads) |preload| {
            const preload_abs = if (std.fs.path.isAbsolute(preload))
                preload
            else
                try std.fs.path.join(ctx.allocator, &.{ current, preload });
            if (!pathExists(ctx.io, preload_abs)) {
                try imports.appendSlice(ctx.allocator, "console.error('error: preload not found ' + ");
                try imports.appendSlice(ctx.allocator, try jsonStringLiteral(ctx, preload));
                try imports.appendSlice(ctx.allocator, "); globalThis.process?.exit?.(1);\n");
                continue;
            }
            try imports.appendSlice(ctx.allocator, "await import(");
            try imports.appendSlice(ctx.allocator, try jsonStringLiteral(ctx, preload_abs));
            try imports.appendSlice(ctx.allocator, ");\n");
        }
        return try imports.toOwnedSlice(ctx.allocator);
    }
    return "";
}

fn writeCottontailEntryWrapper(
    ctx: *const Context,
    tmp_dir: []const u8,
    script_import_abs: []const u8,
    script_abs: []const u8,
    preload_imports: []const u8,
) ![]const u8 {
    const bun_module = try runtimeModulePath(ctx, &.{ "bun", "index.js" });
    const wrapper_name = try std.fmt.allocPrint(
        ctx.allocator,
        "script-entry-{x}.mjs",
        .{std.hash.Wyhash.hash(0, script_abs)},
    );
    const wrapper_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, wrapper_name });
    const bun_literal = try jsonStringLiteral(ctx, bun_module);
    const script_import_literal = try jsonStringLiteral(ctx, script_import_abs);
    const script_literal = try jsonStringLiteral(ctx, script_abs);
    const script_dir = std.fs.path.dirname(script_abs) orelse ctx.project_root;
    const script_dir_literal = try jsonStringLiteral(ctx, script_dir);
    const test_header_signal = if (ctx.environ_map.get("COTTONTAIL_TEST_CLI_HEADER_PRINTED") != null)
        "globalThis.__cottontailBunTestHeaderPrinted = true;"
    else
        "";
    const bundle_map_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "script.bundle.mjs.map" });
    const bundle_map_literal = try jsonStringLiteral(ctx, bundle_map_path);
    const source = try std.fmt.allocPrint(
        ctx.allocator,
        \\import __ctBunModule from {s};
        \\import {{ createRequire as __ctCreateRequire }} from "node:module";
        \\globalThis.__cottontailBundleSourceMap ??= {s};
        \\globalThis.__filename ??= {s};
        \\globalThis.__dirname ??= {s};
        \\globalThis.Loader ??= {{ registry: new Map() }};
        \\globalThis.__cottontailImportMetaResolveSync = (specifier, parent = {s}) => __ctBunModule.resolveSync(specifier, parent);
        \\globalThis.__cottontailImportMetaResolve = (specifier, parent = {s}) => {{
        \\  const resolved = __ctBunModule.resolveSync(specifier, parent);
        \\  return resolved.startsWith("/") ? __ctBunModule.pathToFileURL(resolved).href : resolved;
        \\}};
        \\__ctMetaRequire ??= __ctCreateRequire({s});
        \\__ctMetaResolveSync ??= (specifier, parent = {s}) => __ctBunModule.resolveSync(specifier, parent);
        \\__ctMetaResolve ??= (specifier) => {{
        \\  const resolved = __ctBunModule.resolveSync(specifier, {s});
        \\  return resolved.startsWith("/") ? __ctBunModule.pathToFileURL(resolved).href : resolved;
        \\}};
        \\{s}
        \\globalThis.__cottontailLoadDotenv?.();
        \\{s}await import({s});
        \\
    ,
        .{
            bun_literal,
            bundle_map_literal,
            script_literal,
            script_dir_literal,
            script_literal,
            script_literal,
            script_literal,
            script_literal,
            script_literal,
            test_header_signal,
            preload_imports,
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
    const source = try std.fmt.allocPrint(
        ctx.allocator,
        \\import {{ readFileSync }} from "node:fs";
        \\import {{ WASI }} from "node:wasi";
        \\const __ctWasi = new WASI({{ version: "preview1", args: process.argv.slice(1), env: process.env }});
        \\const __ctWasmModule = new WebAssembly.Module(readFileSync({s}));
        \\const __ctWasiImports = {{
        \\  wasi_snapshot_preview1: __ctWasi.wasiImport,
        \\  wasi_unstable: __ctWasi.wasiImport,
        \\}};
        \\const __ctWasmInstance = new WebAssembly.Instance(__ctWasmModule, __ctWasiImports);
        \\__ctWasi.start(__ctWasmInstance);
        \\
    , .{script_literal});
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = wrapper_path, .data = source });
    return wrapper_path;
}

fn cleanupGeneratedSource(ctx: *const Context, generated_path: []const u8, original_path: []const u8) void {
    if (std.mem.eql(u8, generated_path, original_path)) return;
    std.Io.Dir.cwd().deleteFile(ctx.io, generated_path) catch {};
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

fn writeBunCompatTransformedSource(
    ctx: *const Context,
    script_abs: []const u8,
    source_base_dir: ?[]const u8,
) ![]const u8 {
    const source = std.Io.Dir.cwd().readFileAlloc(
        ctx.io,
        script_abs,
        ctx.allocator,
        .limited(4 * 1024 * 1024),
    ) catch return script_abs;
    var transformed_source: []const u8 = source;
    var changed = false;
    if (std.mem.indexOf(u8, source, ".__esModule") != null) {
        if (try rewriteNamespaceEsModuleAssignments(ctx.allocator, source)) |transformed| {
            transformed_source = transformed;
            changed = true;
        }
    }

    const resolution_dir = source_base_dir orelse std.fs.path.dirname(script_abs) orelse ctx.project_root;
    if (try rewriteQueryImports(ctx, transformed_source, resolution_dir)) |transformed| {
        transformed_source = transformed;
        changed = true;
    }
    // Bun treats extensionless entrypoints as TypeScript; esbuild would parse
    // them as plain JS, so rewrite them into a generated .ts file.
    const extensionless = std.fs.path.extension(script_abs).len == 0;
    if (extensionless) changed = true;
    if (!changed) return script_abs;

    if (std.mem.startsWith(u8, transformed_source, "#!")) {
        const stripped = try ctx.allocator.dupe(u8, transformed_source);
        stripped[0] = '/';
        stripped[1] = '/';
        transformed_source = stripped;
    }

    const script_dir = std.fs.path.dirname(script_abs) orelse ctx.project_root;
    const ext = blk: {
        const value = std.fs.path.extension(script_abs);
        break :blk if (value.len == 0) ".ts" else value;
    };
    const generated_name = try std.fmt.allocPrint(
        ctx.allocator,
        ".cottontail-compat-{x}{s}",
        .{ std.hash.Wyhash.hash(0, source), ext },
    );
    const generated_path = try std.fs.path.join(ctx.allocator, &.{ script_dir, generated_name });
    std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = generated_path, .data = transformed_source }) catch return script_abs;
    return generated_path;
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
    mock_binding_clause: ?[]const u8 = null,
    mock_binding_specifier: ?[]const u8 = null,
};

const DynamicImportTarget = struct {
    path: []const u8,
    mutable_namespace: bool = false,
};

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
    if (std.mem.startsWith(u8, bare, "file://")) bare = bare["file://".len..];
    if (bare.len == 0) return null;

    const candidate = if (std.fs.path.isAbsolute(bare))
        try ctx.allocator.dupe(u8, bare)
    else if (std.mem.startsWith(u8, bare, "./") or std.mem.startsWith(u8, bare, "../"))
        try std.fs.path.join(ctx.allocator, &.{ resolution_dir, bare })
    else
        return null;

    if (realPathIfFile(ctx, candidate)) |resolved| return resolved;
    if (std.fs.path.extension(candidate).len != 0) return null;
    for ([_][]const u8{ ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json" }) |extension| {
        const with_extension = try std.mem.concat(ctx.allocator, u8, &.{ candidate, extension });
        if (realPathIfFile(ctx, with_extension)) |resolved| return resolved;
    }
    return null;
}

fn dynamicTargetIndex(
    allocator: std.mem.Allocator,
    targets: *std.ArrayList(DynamicImportTarget),
    path: []const u8,
    mutable_namespace: bool,
) !usize {
    for (targets.items, 0..) |target, index| {
        if (std.mem.eql(u8, target.path, path)) {
            if (mutable_namespace) targets.items[index].mutable_namespace = true;
            return index;
        }
    }
    try targets.append(allocator, .{ .path = path, .mutable_namespace = mutable_namespace });
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
) !bool {
    var has_custom_signal = false;
    const uses_module_mock = std.mem.indexOf(u8, source, "mock.module(") != null or
        std.mem.indexOf(u8, source, "mock.module (") != null;
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
                            target_index = try dynamicTargetIndex(ctx.allocator, targets, target_path, false);
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
            (cursor == 0 or !isIdentifierPart(source[cursor - 1])) and
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
                            if (comma == null and inferred_loader != null and std.mem.eql(u8, inferred_loader.?, "text")) {
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
                            if (uses_module_mock and comma == null and std.mem.indexOfAny(u8, prefix, "?#") == null) {
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
                                try dynamicTargetIndex(ctx.allocator, targets, path, false)
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
            (cursor > 0 and isIdentifierPart(source[cursor - 1])) or
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
            const has_query = std.mem.indexOfAny(u8, prefix, "?#") != null;
            const assumes_jsonc = isJsoncLikeSpecifier(prefix);
            const assumes_json5 = isJson5Specifier(prefix);
            const assumes_toml = isTomlSpecifier(prefix);
            const inferred_loader = if (!has_attributes and !has_query) inferredLoaderForTarget(prefix) else null;
            const import_clause = source[cursor + "import".len .. specifier_start];
            const force_spy_namespace = std.mem.indexOf(u8, source, "spyOn(") != null and
                std.mem.indexOfScalar(u8, import_clause, '*') != null;
            const force_mock_bindings = uses_module_mock and std.mem.startsWith(u8, prefix, ".") and
                std.mem.indexOfScalar(u8, import_clause, '{') != null;
            if (!force_spy_namespace and !force_mock_bindings and !has_attributes and !has_query and !assumes_jsonc and !assumes_json5 and !assumes_toml and inferred_loader == null) {
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
            const target_path = try resolveDynamicImportTarget(ctx, resolution_dir, prefix);
            const target_index = if (target_path) |path|
                try dynamicTargetIndex(ctx.allocator, targets, path, force_spy_namespace or force_mock_bindings)
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
        if (isTypeScriptAsImport(source, cursor)) {
            cursor = close + 1;
            continue;
        }
        const arguments = source[open + 1 .. close];
        const comma = findTopLevelComma(arguments);
        const expression = std.mem.trim(u8, if (comma) |index| arguments[0..index] else arguments, " \t\r\n");
        var options = std.mem.trim(u8, if (comma) |index| arguments[index + 1 ..] else "undefined", " \t\r\n");

        var target_index: ?usize = null;
        if (try decodeJavaScriptStringPrefix(ctx.allocator, expression)) |prefix| {
            if (std.mem.indexOfAny(u8, prefix, "?#") != null) has_custom_signal = true;
            if (comma == null and isJsoncLikeSpecifier(prefix)) {
                options = "{ with: { type: \"jsonc\" } }";
                has_custom_signal = true;
            } else if (comma == null and isJson5Specifier(prefix)) {
                options = "{ with: { type: \"json5\" } }";
                has_custom_signal = true;
            } else if (comma == null and isTomlSpecifier(prefix)) {
                options = "{ with: { type: \"toml\" } }";
                has_custom_signal = true;
            } else if (comma == null) {
                if (inferredLoaderForTarget(prefix)) |loader| {
                    options = try loaderOptionsLiteral(ctx, loader);
                    has_custom_signal = true;
                }
            }
            if (try resolveDynamicImportTarget(ctx, resolution_dir, prefix)) |target_path| {
                target_index = try dynamicTargetIndex(ctx.allocator, targets, target_path, uses_module_mock);
            }
        }
        if (comma != null) has_custom_signal = true;
        try occurrences.append(ctx.allocator, .{
            .start = cursor,
            .end = close + 1,
            .expression = expression,
            .options = options,
            .target_index = target_index,
        });
        cursor = close + 1;
    }
    return has_custom_signal;
}

fn transpileDynamicTarget(
    ctx: *const Context,
    target_path: []const u8,
    loader_override: ?[]const u8,
    external_packages: bool,
) !?[]const u8 {
    const esbuild_bin = try esbuildBinaryPath(ctx);
    const base_args = [_][]const u8{
        esbuild_bin,
        target_path,
        "--format=cjs",
        "--platform=neutral",
        "--target=es2022",
        "--log-level=silent",
        "--define:import.meta.url=__ctImportMeta.url",
        "--define:import.meta.dir=__ctImportMeta.dir",
        "--define:import.meta.file=__ctImportMeta.file",
        "--define:import.meta.path=__ctImportMeta.path",
        "--define:import.meta.dirname=__ctImportMeta.dirname",
        "--define:import.meta.filename=__ctImportMeta.filename",
        "--define:import.meta.main=false",
    };
    var args: std.ArrayList([]const u8) = .empty;
    try args.appendSlice(ctx.allocator, &base_args);
    if (loader_override) |loader| {
        const extension = std.fs.path.extension(target_path);
        try args.append(ctx.allocator, try std.fmt.allocPrint(
            ctx.allocator,
            "--loader:{s}={s}",
            .{ extension, loader },
        ));
    }
    if (external_packages) try args.append(ctx.allocator, "--packages=external");
    try args.append(ctx.allocator, "--bundle");
    const bundled_result = try std.process.run(ctx.allocator, ctx.io, .{
        .argv = args.items,
        .cwd = .{ .path = ctx.project_root },
        .create_no_window = true,
    });
    defer ctx.allocator.free(bundled_result.stdout);
    defer ctx.allocator.free(bundled_result.stderr);
    if (termExitCode(bundled_result.term) == 0) return try ctx.allocator.dupe(u8, bundled_result.stdout);

    _ = args.pop();
    if (external_packages) _ = args.pop();
    const result = try std.process.run(ctx.allocator, ctx.io, .{
        .argv = args.items,
        .cwd = .{ .path = ctx.project_root },
        .create_no_window = true,
    });
    defer ctx.allocator.free(result.stdout);
    defer ctx.allocator.free(result.stderr);
    if (termExitCode(result.term) != 0) return null;
    return try ctx.allocator.dupe(u8, result.stdout);
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
    if (std.mem.eql(u8, extension, ".cjs")) return "js";
    if (std.mem.eql(u8, extension, ".js") or
        std.mem.eql(u8, extension, ".jsx") or
        std.mem.eql(u8, extension, ".ts") or
        std.mem.eql(u8, extension, ".tsx") or
        std.mem.eql(u8, extension, ".mjs") or
        extension.len == 0)
    {
        return null;
    }
    return "file";
}

fn appendDynamicTargetFactory(
    ctx: *const Context,
    output: *std.ArrayList(u8),
    target: DynamicImportTarget,
    index: usize,
) !void {
    const inferred_loader = inferredLoaderForTarget(target.path);
    var cjs_source = try transpileDynamicTarget(
        ctx,
        target.path,
        if (inferred_loader != null and std.mem.eql(u8, inferred_loader.?, "text")) "text" else null,
        target.mutable_namespace,
    );
    var loader_guard: []const u8 = "";
    if (cjs_source == null) {
        var allowed: std.ArrayList(u8) = .empty;
        for ([_][]const u8{ "js", "jsx", "ts", "tsx" }) |loader| {
            if (try transpileDynamicTarget(ctx, target.path, loader, target.mutable_namespace)) |candidate| {
                if (cjs_source == null) cjs_source = candidate;
                if (allowed.items.len > 0) try allowed.appendSlice(ctx.allocator, " && ");
                try allowed.appendSlice(ctx.allocator, "__ctType !== ");
                try allowed.appendSlice(ctx.allocator, try jsonStringLiteral(ctx, loader));
            }
        }
        loader_guard = if (allowed.items.len == 0)
            "{ const error = new SyntaxError(\"Unable to parse module with the selected loader\"); error.name = \"BuildMessage\"; throw error; }"
        else
            try std.fmt.allocPrint(
                ctx.allocator,
                "if ({s}) throw new SyntaxError(\"Unable to parse module with the selected loader\");",
                .{allowed.items},
            );
    }
    const use_runtime_factory = cjs_source != null;
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
    const is_cjs_target = std.mem.eql(u8, std.fs.path.extension(target.path), ".cjs");
    const package_type_module = if (is_cjs_target)
        try nearestPackageTypeIsModule(ctx, dirname)
    else
        false;

    const prefix = try std.fmt.allocPrint(ctx.allocator,
        \\const __ctPath{d} = {s};
        \\const __ctURL{d} = {s};
        \\async function __ctLoad{d}(specifier, options) {{
        \\  const __ctText = String(specifier);
        \\  const __ctMarker = __ctText.search(/[?#]/);
        \\  const __ctSuffix = __ctMarker < 0 ? "" : __ctText.slice(__ctMarker);
        \\  const __ctInferredType = {s};
        \\  const __ctType = options?.with?.type ?? options?.assert?.type ?? options?.type ?? (__ctSuffix === "?raw" ? "text" : __ctInferredType);
        \\  const __ctKey = __ctPath{d} + __ctSuffix + (__ctType == null ? "" : "\\u0000" + __ctType);
        \\  const __ctRegistry = globalThis.Loader.registry;
        \\  if (__ctRegistry.has(__ctKey)) return await __ctRegistry.get(__ctKey);
        \\  const __ctPromise = (async () => {{
        \\    const __ctImportMeta = {{ url: __ctURL{d} + __ctSuffix, dir: {s}, dirname: {s}, file: {s}, path: __ctPath{d}, filename: __ctPath{d}, main: false }};
        \\    const __ctRaw = {s};
        \\    if (__ctType === "text") return {{ default: __ctRaw }};
        \\    if (__ctType === "file" || __ctType === "css") return {{ default: __ctPath{d} }};
        \\    if (__ctType === "html") return {{ default: {{ index: __ctPath{d} }} }};
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
        \\    {s}
        \\    const module = {{ exports: {{}} }};
        \\    const exports = module.exports;
        \\
    , .{ index, path_literal, index, url_literal, index, inferred_loader_literal, index, index, dirname_literal, dirname_literal, basename_literal, index, index, raw_literal, index, index, index, index, loader_guard });
    try output.appendSlice(ctx.allocator, prefix);
    if (cjs_source) |transpiled| {
        if (use_runtime_factory) {
            const factory_source = if (target.mutable_namespace)
                try std.fmt.allocPrint(ctx.allocator,
                    "{s}\nconst __ctUpdateLexicalBindings = (value) => {{ for (const name of Object.keys(value ?? {{}})) {{ if (!Object.hasOwn(module.exports, name)) continue; try {{ eval(name + \" = value[name]\"); }} catch {{}} }} }}; globalThis.__cottontailRegisterModuleBindings?.({s}, __ctUpdateLexicalBindings); globalThis.__cottontailRegisterModuleBindings?.({s}, __ctUpdateLexicalBindings);",
                    .{ transpiled, mock_key_literal, path_literal },
                )
            else
                transpiled;
            const transpiled_literal = try jsonStringLiteral(ctx, factory_source);
            try output.appendSlice(ctx.allocator, "    new Function(\"module\", \"exports\", \"require\", \"__ctImportMeta\", ");
            try output.appendSlice(ctx.allocator, transpiled_literal);
            try output.appendSlice(ctx.allocator, ")(module, exports, __ctCreateRequire(__ctPath");
            try output.appendSlice(ctx.allocator, try std.fmt.allocPrint(ctx.allocator, "{d}", .{index}));
            try output.appendSlice(ctx.allocator, "), __ctImportMeta);\n");
        } else {
            try output.appendSlice(ctx.allocator, transpiled);
        }
    }
    const return_expression = if (is_cjs_target)
        try std.fmt.allocPrint(ctx.allocator, "__ctCommonJSNamespace(module.exports, {s})", .{if (package_type_module) "true" else "false"})
    else if (target.mutable_namespace)
        try std.fmt.allocPrint(ctx.allocator,
            "(() => {{ const namespace = __ctMutableNamespace(module.exports); const update = value => Object.assign(namespace, value ?? {{}}); globalThis.__cottontailRegisterModuleBindings({s}, update); globalThis.__cottontailRegisterModuleBindings({s}, update); return namespace; }})()",
            .{ path_literal, mock_key_literal },
        )
    else
        "module.exports";
    const suffix = try std.fmt.allocPrint(ctx.allocator,
        \\    return module.exports;
        \\  }})();
        \\  __ctRegistry.set(__ctKey, __ctPromise);
        \\  try {{ return await __ctPromise; }} catch (error) {{ __ctRegistry.delete(__ctKey); throw __ctNormalizeImportError(error); }}
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
    const fallback = try std.fmt.allocPrint(ctx.allocator,
        \\  if (typeof globalThis.__cottontailImportModule === "function") {{
        \\    try {{ return await globalThis.__cottontailImportModule(__ctText, {s}, options); }}
        \\    catch (error) {{ throw __ctNormalizeImportError(error); }}
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
) !?[]u8 {
    var occurrences: std.ArrayList(DynamicImportOccurrence) = .empty;
    var targets: std.ArrayList(DynamicImportTarget) = .empty;
    _ = try scanDynamicImports(ctx, source, resolution_dir, &occurrences, &targets);
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
        \\  if (value !== null && (typeof value === "object" || typeof value === "function")) {
        \\    if (!packageTypeModule && value.__esModule === true && Object.hasOwn(value, "default")) {
        \\      namespace.default = value.default;
        \\    }
        \\    for (const key of Object.keys(value)) {
        \\      if (key === "default" || (!packageTypeModule && key === "__esModule")) continue;
        \\      namespace[key] = value[key];
        \\    }
        \\  }
        \\  return namespace;
        \\}
        \\function __ctMutableNamespace(value) {
        \\  const namespace = {};
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
        const function_name = if (occurrence.runtime_require_resolve)
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

fn writeCommonJsEntryWrapper(
    ctx: *const Context,
    tmp_dir: []const u8,
    script_abs: []const u8,
    bundle_entry: bool,
    preload_imports: []const u8,
) ![]const u8 {
    const wrapper_name = try std.fmt.allocPrint(
        ctx.allocator,
        "script-entry-cjs-{x}.mjs",
        .{std.hash.Wyhash.hash(0, script_abs)},
    );
    const wrapper_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, wrapper_name });

    const bun_module = try runtimeModulePath(ctx, &.{ "bun", "index.js" });
    const bun_internal_for_testing_module = try runtimeModulePath(ctx, &.{ "bun", "internal-for-testing.js" });
    const fs_module = try runtimeModulePath(ctx, &.{ "node", "fs.js" });
    const fs_promises_module = try runtimeModulePath(ctx, &.{ "node", "fs", "promises.js" });
    const os_module = try runtimeModulePath(ctx, &.{ "node", "os.js" });
    const path_module = try runtimeModulePath(ctx, &.{ "node", "path.js" });
    const process_module = try runtimeModulePath(ctx, &.{ "node", "process.js" });
    const readline_module = try runtimeModulePath(ctx, &.{ "node", "readline.js" });
    const readline_promises_module = try runtimeModulePath(ctx, &.{ "node", "readline", "promises.js" });
    const util_module = try runtimeModulePath(ctx, &.{ "node", "util.js" });
    const util_types_module = try runtimeModulePath(ctx, &.{ "node", "util", "types.js" });
    const events_module = try runtimeModulePath(ctx, &.{ "node", "events.js" });
    const async_hooks_module = try runtimeModulePath(ctx, &.{ "node", "async_hooks.js" });
    const assert_module = try runtimeModulePath(ctx, &.{ "node", "assert.js" });
    const assert_strict_module = try runtimeModulePath(ctx, &.{ "node", "assert", "strict.js" });
    const console_module = try runtimeModulePath(ctx, &.{ "node", "console.js" });
    const diagnostics_channel_module = try runtimeModulePath(ctx, &.{ "node", "diagnostics_channel.js" });
    const domain_module = try runtimeModulePath(ctx, &.{ "node", "domain.js" });
    const tty_module = try runtimeModulePath(ctx, &.{ "node", "tty.js" });
    const v8_module = try runtimeModulePath(ctx, &.{ "node", "v8.js" });
    const stream_module = try runtimeModulePath(ctx, &.{ "node", "stream.js" });
    const stream_consumers_module = try runtimeModulePath(ctx, &.{ "node", "stream", "consumers.js" });
    const stream_promises_module = try runtimeModulePath(ctx, &.{ "node", "stream", "promises.js" });
    const stream_web_module = try runtimeModulePath(ctx, &.{ "node", "stream", "web.js" });
    const perf_hooks_module = try runtimeModulePath(ctx, &.{ "node", "perf_hooks.js" });
    const vm_module = try runtimeModulePath(ctx, &.{ "node", "vm.js" });
    const module_module = try runtimeModulePath(ctx, &.{ "node", "module.js" });
    const net_module = try runtimeModulePath(ctx, &.{ "node", "net.js" });
    const url_module = try runtimeModulePath(ctx, &.{ "node", "url.js" });
    const constants_module = try runtimeModulePath(ctx, &.{ "node", "constants.js" });
    const crypto_module = try runtimeModulePath(ctx, &.{ "node", "crypto.js" });
    const buffer_module = try runtimeModulePath(ctx, &.{ "node", "buffer.js" });
    const cluster_module = try runtimeModulePath(ctx, &.{ "node", "cluster.js" });
    const punycode_module = try runtimeModulePath(ctx, &.{ "node", "punycode.js" });
    const querystring_module = try runtimeModulePath(ctx, &.{ "node", "querystring.js" });
    const child_process_module = try runtimeModulePath(ctx, &.{ "node", "child_process.js" });
    const path_posix_module = try runtimeModulePath(ctx, &.{ "node", "path", "posix.cjs" });
    const path_win32_module = try runtimeModulePath(ctx, &.{ "node", "path", "win32.cjs" });
    const string_decoder_module = try runtimeModulePath(ctx, &.{ "node", "string_decoder.js" });
    const sys_module = try runtimeModulePath(ctx, &.{ "node", "sys.js" });
    const repl_module = try runtimeModulePath(ctx, &.{ "node", "repl.js" });
    const sea_module = try runtimeModulePath(ctx, &.{ "node", "sea.js" });
    const sqlite_module = try runtimeModulePath(ctx, &.{ "node", "sqlite.js" });
    const node_test_module = try runtimeModulePath(ctx, &.{ "node", "test.js" });
    const test_reporters_module = try runtimeModulePath(ctx, &.{ "node", "test", "reporters.js" });
    const timers_module = try runtimeModulePath(ctx, &.{ "node", "timers.js" });
    const timers_promises_module = try runtimeModulePath(ctx, &.{ "node", "timers", "promises.js" });
    const trace_events_module = try runtimeModulePath(ctx, &.{ "node", "trace_events.js" });
    const wasi_module = try runtimeModulePath(ctx, &.{ "node", "wasi.js" });
    const worker_threads_module = try runtimeModulePath(ctx, &.{ "node", "worker_threads.js" });
    const zlib_module = try runtimeModulePath(ctx, &.{ "node", "zlib.js" });
    const http_module = try runtimeModulePath(ctx, &.{ "node", "http.js" });
    const https_module = try runtimeModulePath(ctx, &.{ "node", "https.js" });
    const http2_module = try runtimeModulePath(ctx, &.{ "node", "http2.js" });
    const inspector_module = try runtimeModulePath(ctx, &.{ "node", "inspector.js" });
    const inspector_promises_module = try runtimeModulePath(ctx, &.{ "node", "inspector", "promises.js" });
    const dgram_module = try runtimeModulePath(ctx, &.{ "node", "dgram.js" });
    const dns_module = try runtimeModulePath(ctx, &.{ "node", "dns.js" });
    const dns_promises_module = try runtimeModulePath(ctx, &.{ "node", "dns", "promises.js" });
    const tls_module = try runtimeModulePath(ctx, &.{ "node", "tls.js" });

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
        },
    );
    const script_literal = try jsonStringLiteral(ctx, script_abs);
    const bundle_map_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "script.bundle.mjs.map" });
    const bundle_map_literal = try jsonStringLiteral(ctx, bundle_map_path);
    const main_statement = if (bundle_entry)
        try std.fmt.allocPrint(ctx.allocator, "globalThis.__cottontailLoadDotenv?.();\n{s}await import({s});", .{ preload_imports, script_literal })
    else
        try std.fmt.allocPrint(ctx.allocator, "globalThis.__cottontailLoadDotenv?.();\n{s}moduleModule.__runMain({s});", .{ preload_imports, script_literal });
    const bootstrap = try std.fmt.allocPrint(
        ctx.allocator,
        \\globalThis.__cottontailBundleSourceMap ??= {s};
        \\const eventsBuiltin = events.default ?? events;
        \\const assertBuiltin = assert.default ?? assert;
        \\const assertStrictBuiltin = assertStrict.default ?? assertStrict;
        \\const nodeTestBuiltin = nodeTest.default ?? nodeTest;
        \\const streamBuiltin = stream.default ?? stream;
        \\const pathBuiltin = path.default ?? path;
        \\const pathPosixBuiltin = pathBuiltin.posix ?? pathPosix.default ?? pathPosix;
        \\const pathWin32Builtin = pathBuiltin.win32 ?? pathWin32.default ?? pathWin32;
        \\moduleModule.__setBuiltinModules({{
        \\  fs, "node:fs": fs,
        \\  "fs/promises": fsPromises, "node:fs/promises": fsPromises,
        \\  os, "node:os": os,
        \\  path: pathBuiltin, "node:path": pathBuiltin,
        \\  process: processModule, "node:process": processModule,
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
        \\  module: moduleModule, "node:module": moduleModule,
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
        \\  "internal-for-testing": bunInternalForTesting
        \\}});
        \\{s}
        \\
    ,
        .{
            bundle_map_literal,
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
    const all_parts = try ctx.allocator.alloc([]const u8, parts.len + 2);
    all_parts[0] = ctx.cottontail_home;
    all_parts[1] = "src/runtime_modules";
    for (parts, 0..) |part, index| {
        all_parts[index + 2] = part;
    }
    return try std.fs.path.join(ctx.allocator, all_parts);
}

fn runtimeModulesAvailable(ctx: *const Context) bool {
    const bun_module = runtimeModulePath(ctx, &.{ "bun", "index.js" }) catch return false;
    return pathExists(ctx.io, bun_module);
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

fn findCottontailHome(init: std.process.Init, allocator: std.mem.Allocator, exe_dir: []const u8) ![]const u8 {
    if (init.environ_map.get("COTTONTAIL_HOME")) |home| {
        const absolute = try resolvePathForCwd(init.io, allocator, home);
        if (looksLikeCottontailRuntimeHome(init.io, allocator, absolute)) {
            return absolute;
        }
    }

    if (init.environ_map.get("DASH_COTTONTAIL_ROOT")) |home| {
        const absolute = try resolvePathForCwd(init.io, allocator, home);
        if (looksLikeCottontailRuntimeHome(init.io, allocator, absolute)) {
            return absolute;
        }
    }

    const cwd = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator);
    if (try findCottontailHomeNear(init.io, allocator, cwd)) |home| return home;
    if (try findCottontailHomeNear(init.io, allocator, exe_dir)) |home| return home;

    const sibling_candidates = [_][]const u8{
        try std.fs.path.join(allocator, &.{ exe_dir, "..", "..", "..", "cottontail" }),
        try std.fs.path.join(allocator, &.{ exe_dir, "..", "..", "..", "..", "cottontail" }),
        try std.fs.path.join(allocator, &.{ exe_dir, "..", "cottontail" }),
    };
    for (sibling_candidates) |candidate| {
        const absolute = std.Io.Dir.cwd().realPathFileAlloc(init.io, candidate, allocator) catch candidate;
        if (looksLikeCottontailHome(init.io, allocator, absolute)) return absolute;
    }

    var current: []const u8 = try allocator.dupe(u8, exe_dir);
    while (true) {
        if (looksLikeCottontailHome(init.io, allocator, current)) return current;
        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = parent;
    }

    return try allocator.dupe(u8, exe_dir);
}

fn findCottontailHomeNear(io: std.Io, allocator: std.mem.Allocator, start_dir: []const u8) !?[]const u8 {
    var current: []const u8 = try allocator.dupe(u8, start_dir);
    while (true) {
        if (looksLikeCottontailHome(io, allocator, current)) {
            return current;
        }

        const sibling = try std.fs.path.join(allocator, &.{ current, "cottontail" });
        const sibling_absolute = std.Io.Dir.cwd().realPathFileAlloc(io, sibling, allocator) catch sibling;
        if (looksLikeCottontailHome(io, allocator, sibling_absolute)) {
            return sibling_absolute;
        }

        const parent = std.fs.path.dirname(current) orelse return null;
        if (std.mem.eql(u8, parent, current)) return null;
        current = parent;
    }
}

fn looksLikeCottontailHome(io: std.Io, allocator: std.mem.Allocator, candidate: []const u8) bool {
    const package_json = std.fs.path.join(allocator, &.{ candidate, "package.json" }) catch return false;
    defer allocator.free(package_json);
    const src_main = std.fs.path.join(allocator, &.{ candidate, "src", "main.zig" }) catch return false;
    defer allocator.free(src_main);
    return pathExists(io, package_json) and pathExists(io, src_main);
}

fn looksLikeCottontailRuntimeHome(io: std.Io, allocator: std.mem.Allocator, candidate: []const u8) bool {
    if (looksLikeCottontailHome(io, allocator, candidate)) return true;

    const runtime_module = std.fs.path.join(allocator, &.{ candidate, "src", "runtime_modules", "bun", "index.js" }) catch return false;
    defer allocator.free(runtime_module);
    return pathExists(io, runtime_module);
}

fn resolvePathForCwd(io: std.Io, allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    if (std.fs.path.isAbsolute(path)) return try allocator.dupe(u8, path);
    return try std.Io.Dir.cwd().realPathFileAlloc(io, path, allocator);
}

fn pathExists(io: std.Io, path: []const u8) bool {
    if (std.fs.path.isAbsolute(path)) {
        std.Io.Dir.accessAbsolute(io, path, .{}) catch return false;
    } else {
        std.Io.Dir.cwd().access(io, path, .{}) catch return false;
    }
    return true;
}

fn ensureEsbuild(ctx: *const Context) !void {
    const vendor_dir = try std.fs.path.join(ctx.allocator, &.{ ctx.cottontail_home, "vendors", "esbuild" });
    const version_file = try std.fs.path.join(ctx.allocator, &.{ vendor_dir, ".esbuild-version" });
    const esbuild_bin = try std.fs.path.join(ctx.allocator, &.{ vendor_dir, esbuildBinaryName() });

    if (pathExists(ctx.io, version_file) and pathExists(ctx.io, esbuild_bin)) {
        const current_version = std.Io.Dir.cwd().readFileAlloc(ctx.io, version_file, ctx.allocator, .limited(64)) catch "";
        if (std.mem.eql(u8, std.mem.trim(u8, current_version, " \r\n\t"), esbuild_version)) return;
    }

    if (pathExists(ctx.io, vendor_dir)) {
        std.Io.Dir.cwd().deleteTree(ctx.io, vendor_dir) catch {};
    }
    try std.Io.Dir.cwd().createDirPath(ctx.io, vendor_dir);

    const package_name = try esbuildPackageName();
    const tarball_name = try esbuildTarballName();
    const url = try std.fmt.allocPrint(ctx.allocator, "https://registry.npmjs.org/@esbuild/{s}/-/{s}-{s}.tgz", .{ package_name, tarball_name, esbuild_version });
    const tarball_path = try std.fs.path.join(ctx.allocator, &.{ vendor_dir, "esbuild.tgz" });
    const extract_dir = try std.fs.path.join(ctx.allocator, &.{ vendor_dir, "extract" });

    ctx.writeStdout("Vendoring esbuild {s} ({s})...\n", .{ esbuild_version, package_name });

    try runInherited(ctx, &[_][]const u8{ "curl", "-L", "--fail", "-o", tarball_path, url }, ctx.cottontail_home);
    try std.Io.Dir.cwd().createDirPath(ctx.io, extract_dir);
    try runInherited(ctx, &[_][]const u8{ "tar", "-xzf", tarball_path, "-C", extract_dir }, ctx.cottontail_home);

    const extracted_bin = try std.fs.path.join(ctx.allocator, &.{ extract_dir, "package", "bin", esbuildBinaryName() });
    try std.Io.Dir.copyFileAbsolute(extracted_bin, esbuild_bin, ctx.io, .{});
    if (builtin.os.tag != .windows) {
        try runInherited(ctx, &[_][]const u8{ "chmod", "+x", esbuild_bin }, ctx.cottontail_home);
    }

    std.Io.Dir.cwd().deleteFile(ctx.io, tarball_path) catch {};
    std.Io.Dir.cwd().deleteTree(ctx.io, extract_dir) catch {};
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = version_file, .data = esbuild_version ++ "\n" });
}

fn esbuildBinaryPath(ctx: *const Context) ![]const u8 {
    return try std.fs.path.join(ctx.allocator, &.{ ctx.cottontail_home, "vendors", "esbuild", esbuildBinaryName() });
}

fn esbuildBinaryName() []const u8 {
    return if (builtin.os.tag == .windows) "esbuild.exe" else "esbuild";
}

fn esbuildPackageName() ![]const u8 {
    return switch (builtin.os.tag) {
        .macos => switch (builtin.cpu.arch) {
            .aarch64 => "darwin-arm64",
            .x86_64 => "darwin-x64",
            else => error.UnsupportedEsbuildPlatform,
        },
        .linux => switch (builtin.cpu.arch) {
            .aarch64 => "linux-arm64",
            .x86_64 => "linux-x64",
            else => error.UnsupportedEsbuildPlatform,
        },
        .windows => switch (builtin.cpu.arch) {
            .aarch64 => "win32-arm64",
            .x86_64 => "win32-x64",
            else => error.UnsupportedEsbuildPlatform,
        },
        else => error.UnsupportedEsbuildPlatform,
    };
}

fn esbuildTarballName() ![]const u8 {
    return switch (builtin.os.tag) {
        .windows => switch (builtin.cpu.arch) {
            .aarch64 => "win32-arm64",
            .x86_64 => "win32-x64",
            else => error.UnsupportedEsbuildPlatform,
        },
        else => try esbuildPackageName(),
    };
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
    try std.testing.expect(!isTestEntrypointPath("/a/b.test.d/example.ts"));
    try std.testing.expect(!isTestEntrypointPath("/a/b/example.test.txt"));
    try std.testing.expect(!isTestEntrypointPath("/a/b/example.ts"));
}
