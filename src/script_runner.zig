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

const ScriptExecution = struct {
    io: std.Io,
    allocator: std.mem.Allocator,
    runnable_path: [:0]const u8,
    script_args: []const [:0]const u8,
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
    const allocator = init.arena.allocator();
    const exe_dir = try std.process.executableDirPathAlloc(init.io, allocator);
    const ctx = Context{
        .io = init.io,
        .allocator = allocator,
        .environ_map = init.environ_map,
        .cottontail_home = try findCottontailHome(init, allocator, exe_dir),
        .project_root = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator),
    };

    const runnable_path = if (runtimeModulesAvailable(&ctx) or isTypescriptPath(script_path))
        try bundleScriptWithEsbuild(&ctx, script_path)
    else blk: {
        const script_abs = try resolvePathForCwd(ctx.io, ctx.allocator, script_path);
        if (try shouldBundleCommonJsEntrypoint(&ctx, script_abs)) {
            const tmp_dir = try ensureTempDir(&ctx);
            break :blk try writeCommonJsEntryWrapper(&ctx, tmp_dir, script_abs);
        }
        break :blk script_abs;
    };

    const runnable_path_z = try allocator.dupeZ(u8, runnable_path);
    const process_args = try allocator.alloc([:0]const u8, script_args.len + 1);
    process_args[0] = script_path;
    for (script_args, 0..) |arg, index| {
        process_args[index + 1] = arg;
    }

    var execution = ScriptExecution{
        .io = init.io,
        .allocator = allocator,
        .runnable_path = runnable_path_z,
        .script_args = process_args,
    };
    const thread = try std.Thread.spawn(
        .{ .stack_size = script_thread_stack_size },
        runScriptExecution,
        .{&execution},
    );

    if (shouldRunElectrobunMainThread(&ctx)) {
        const main_thread_status = runElectrobunMainThread(&ctx) catch |err| blk: {
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

    var core = try std.DynLib.open(core_path);
    defer core.close();

    const run_main_thread = core.lookup(
        RunElectrobunMainThreadFn,
        "electrobun_core_run_main_thread",
    ) orelse return error.MissingElectrobunRunMainThread;
    const last_error = core.lookup(
        ElectrobunLastErrorFn,
        "electrobun_core_last_error",
    ) orelse return error.MissingElectrobunLastError;

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

    js_runtime.setArgs(execution.script_args) catch {
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

fn bundleScriptWithEsbuild(ctx: *const Context, script_path: []const u8) ![]const u8 {
    try ensureEsbuild(ctx);

    const tmp_dir = try ensureTempDir(ctx);

    const script_abs = try resolvePathForCwd(ctx.io, ctx.allocator, script_path);
    const wrapped_entry = if (try shouldBundleCommonJsEntrypoint(ctx, script_abs))
        try writeCommonJsEntryWrapper(ctx, tmp_dir, script_abs)
    else
        try writeCottontailEntryWrapper(ctx, tmp_dir, script_abs);
    const bundle_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "script.bundle.mjs" });
    const esbuild_bin = try esbuildBinaryPath(ctx);
    const script_dir = std.fs.path.dirname(script_abs) orelse ctx.project_root;
    const script_url = try std.fmt.allocPrint(ctx.allocator, "file://{s}", .{script_abs});
    const script_dir_literal = try jsonStringLiteral(ctx, script_dir);
    const script_basename_literal = try jsonStringLiteral(ctx, std.fs.path.basename(script_abs));
    const script_path_literal = try jsonStringLiteral(ctx, script_abs);
    const script_url_literal = try jsonStringLiteral(ctx, script_url);

    const bun_module = try runtimeModulePath(ctx, &.{ "bun", "index.js" });
    const bun_ffi_module = try runtimeModulePath(ctx, &.{ "bun", "ffi.js" });
    const fs_module = try runtimeModulePath(ctx, &.{ "node", "fs.js" });
    const fs_promises_module = try runtimeModulePath(ctx, &.{ "node", "fs", "promises.js" });
    const os_module = try runtimeModulePath(ctx, &.{ "node", "os.js" });
    const path_module = try runtimeModulePath(ctx, &.{ "node", "path.js" });
    const process_module = try runtimeModulePath(ctx, &.{ "node", "process.js" });
    const readline_module = try runtimeModulePath(ctx, &.{ "node", "readline.js" });
    const util_module = try runtimeModulePath(ctx, &.{ "node", "util.js" });
    const util_types_module = try runtimeModulePath(ctx, &.{ "node", "util", "types.js" });
    const events_module = try runtimeModulePath(ctx, &.{ "node", "events.js" });
    const assert_module = try runtimeModulePath(ctx, &.{ "node", "assert.cjs" });
    const assert_strict_module = try runtimeModulePath(ctx, &.{ "node", "assert", "strict.js" });
    const console_module = try runtimeModulePath(ctx, &.{ "node", "console.js" });
    const tty_module = try runtimeModulePath(ctx, &.{ "node", "tty.js" });
    const v8_module = try runtimeModulePath(ctx, &.{ "node", "v8.js" });
    const stream_module = try runtimeModulePath(ctx, &.{ "node", "stream.js" });
    const perf_hooks_module = try runtimeModulePath(ctx, &.{ "node", "perf_hooks.js" });
    const vm_module = try runtimeModulePath(ctx, &.{ "node", "vm.js" });
    const module_module = try runtimeModulePath(ctx, &.{ "node", "module.js" });
    const net_module = try runtimeModulePath(ctx, &.{ "node", "net.js" });
    const url_module = try runtimeModulePath(ctx, &.{ "node", "url.js" });
    const crypto_module = try runtimeModulePath(ctx, &.{ "node", "crypto.js" });
    const buffer_module = try runtimeModulePath(ctx, &.{ "node", "buffer.js" });
    const child_process_module = try runtimeModulePath(ctx, &.{ "node", "child_process.js" });
    const path_posix_module = try runtimeModulePath(ctx, &.{ "node", "path", "posix.js" });
    const path_win32_module = try runtimeModulePath(ctx, &.{ "node", "path", "win32.js" });
    const sys_module = try runtimeModulePath(ctx, &.{ "node", "sys.js" });
    const zlib_module = try runtimeModulePath(ctx, &.{ "node", "zlib.js" });

    const args = [_][]const u8{
        esbuild_bin,
        wrapped_entry,
        "--bundle",
        "--platform=neutral",
        "--format=esm",
        "--main-fields=module,main",
        "--target=es2022",
        try std.fmt.allocPrint(ctx.allocator, "--outfile={s}", .{bundle_path}),
        try std.fmt.allocPrint(ctx.allocator, "--define:import.meta.dirname={s}", .{script_dir_literal}),
        try std.fmt.allocPrint(ctx.allocator, "--define:import.meta.dir={s}", .{script_dir_literal}),
        try std.fmt.allocPrint(ctx.allocator, "--define:import.meta.filename={s}", .{script_path_literal}),
        try std.fmt.allocPrint(ctx.allocator, "--define:import.meta.file={s}", .{script_basename_literal}),
        try std.fmt.allocPrint(ctx.allocator, "--define:import.meta.path={s}", .{script_path_literal}),
        try std.fmt.allocPrint(ctx.allocator, "--define:import.meta.url={s}", .{script_url_literal}),
        "--define:import.meta.main=true",
        try std.fmt.allocPrint(ctx.allocator, "--alias:bun={s}", .{bun_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:bun:ffi={s}", .{bun_ffi_module}),
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
        try std.fmt.allocPrint(ctx.allocator, "--alias:util={s}", .{util_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:util={s}", .{util_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:util/types={s}", .{util_types_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:util/types={s}", .{util_types_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:events={s}", .{events_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:events={s}", .{events_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:assert={s}", .{assert_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:assert={s}", .{assert_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:assert/strict={s}", .{assert_strict_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:assert/strict={s}", .{assert_strict_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:console={s}", .{console_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:console={s}", .{console_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:sys={s}", .{sys_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:sys={s}", .{sys_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:tty={s}", .{tty_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:tty={s}", .{tty_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:v8={s}", .{v8_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:v8={s}", .{v8_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:stream={s}", .{stream_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:stream={s}", .{stream_module}),
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
        try std.fmt.allocPrint(ctx.allocator, "--alias:crypto={s}", .{crypto_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:crypto={s}", .{crypto_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:buffer={s}", .{buffer_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:buffer={s}", .{buffer_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:child_process={s}", .{child_process_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:child_process={s}", .{child_process_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:zlib={s}", .{zlib_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:zlib={s}", .{zlib_module}),
    };

    const result = try std.process.run(ctx.allocator, ctx.io, .{
        .argv = &args,
        .cwd = .{ .path = ctx.project_root },
        .create_no_window = true,
    });
    defer ctx.allocator.free(result.stdout);
    defer ctx.allocator.free(result.stderr);

    if (termExitCode(result.term) != 0) {
        if (result.stdout.len > 0) ctx.writeStdout("{s}", .{result.stdout});
        if (result.stderr.len > 0) ctx.writeStderr("{s}", .{result.stderr});
        return error.EsbuildFailed;
    }

    return bundle_path;
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

fn writeCottontailEntryWrapper(ctx: *const Context, tmp_dir: []const u8, script_abs: []const u8) ![]const u8 {
    const bun_module = try runtimeModulePath(ctx, &.{ "bun", "index.js" });
    const wrapper_name = try std.fmt.allocPrint(
        ctx.allocator,
        "script-entry-{x}.mjs",
        .{std.hash.Wyhash.hash(0, script_abs)},
    );
    const wrapper_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, wrapper_name });
    const bun_literal = try jsonStringLiteral(ctx, bun_module);
    const script_literal = try jsonStringLiteral(ctx, script_abs);
    const source = try std.fmt.allocPrint(
        ctx.allocator,
        "import {s};\nimport {s};\n",
        .{ bun_literal, script_literal },
    );
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = wrapper_path, .data = source });
    return wrapper_path;
}

fn writeCommonJsEntryWrapper(ctx: *const Context, tmp_dir: []const u8, script_abs: []const u8) ![]const u8 {
    const wrapper_name = try std.fmt.allocPrint(
        ctx.allocator,
        "script-entry-cjs-{x}.mjs",
        .{std.hash.Wyhash.hash(0, script_abs)},
    );
    const wrapper_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, wrapper_name });

    const bun_module = try runtimeModulePath(ctx, &.{ "bun", "index.js" });
    const fs_module = try runtimeModulePath(ctx, &.{ "node", "fs.js" });
    const fs_promises_module = try runtimeModulePath(ctx, &.{ "node", "fs", "promises.js" });
    const os_module = try runtimeModulePath(ctx, &.{ "node", "os.js" });
    const path_module = try runtimeModulePath(ctx, &.{ "node", "path.js" });
    const process_module = try runtimeModulePath(ctx, &.{ "node", "process.js" });
    const readline_module = try runtimeModulePath(ctx, &.{ "node", "readline.js" });
    const util_module = try runtimeModulePath(ctx, &.{ "node", "util.js" });
    const util_types_module = try runtimeModulePath(ctx, &.{ "node", "util", "types.js" });
    const events_module = try runtimeModulePath(ctx, &.{ "node", "events.js" });
    const assert_module = try runtimeModulePath(ctx, &.{ "node", "assert.js" });
    const assert_strict_module = try runtimeModulePath(ctx, &.{ "node", "assert", "strict.js" });
    const console_module = try runtimeModulePath(ctx, &.{ "node", "console.js" });
    const tty_module = try runtimeModulePath(ctx, &.{ "node", "tty.js" });
    const v8_module = try runtimeModulePath(ctx, &.{ "node", "v8.js" });
    const stream_module = try runtimeModulePath(ctx, &.{ "node", "stream.js" });
    const perf_hooks_module = try runtimeModulePath(ctx, &.{ "node", "perf_hooks.js" });
    const vm_module = try runtimeModulePath(ctx, &.{ "node", "vm.js" });
    const module_module = try runtimeModulePath(ctx, &.{ "node", "module.js" });
    const net_module = try runtimeModulePath(ctx, &.{ "node", "net.js" });
    const url_module = try runtimeModulePath(ctx, &.{ "node", "url.js" });
    const crypto_module = try runtimeModulePath(ctx, &.{ "node", "crypto.js" });
    const buffer_module = try runtimeModulePath(ctx, &.{ "node", "buffer.js" });
    const child_process_module = try runtimeModulePath(ctx, &.{ "node", "child_process.js" });
    const path_posix_module = try runtimeModulePath(ctx, &.{ "node", "path", "posix.js" });
    const path_win32_module = try runtimeModulePath(ctx, &.{ "node", "path", "win32.js" });
    const sys_module = try runtimeModulePath(ctx, &.{ "node", "sys.js" });
    const zlib_module = try runtimeModulePath(ctx, &.{ "node", "zlib.js" });

    const source = try std.fmt.allocPrint(
        ctx.allocator,
        \\import {s};
        \\import * as fs from {s};
        \\import * as fsPromises from {s};
        \\import * as os from {s};
        \\import * as path from {s};
        \\import * as processModule from {s};
        \\import * as readline from {s};
        \\import * as util from {s};
        \\import * as utilTypes from {s};
        \\import * as events from {s};
        \\import * as assert from {s};
        \\import * as assertStrict from {s};
        \\import * as consoleModule from {s};
        \\import * as tty from {s};
        \\import * as v8 from {s};
        \\import * as stream from {s};
        \\import * as perfHooks from {s};
        \\import * as vm from {s};
        \\import * as moduleModule from {s};
        \\import * as net from {s};
        \\import * as url from {s};
        \\import * as crypto from {s};
        \\import * as buffer from {s};
        \\import * as childProcess from {s};
        \\import * as pathPosix from {s};
        \\import * as pathWin32 from {s};
        \\import * as sys from {s};
        \\import * as zlib from {s};
        \\moduleModule.__setBuiltinModules({{
        \\  fs, "node:fs": fs,
        \\  "fs/promises": fsPromises, "node:fs/promises": fsPromises,
        \\  os, "node:os": os,
        \\  path, "node:path": path,
        \\  process: processModule, "node:process": processModule,
        \\  readline, "node:readline": readline,
        \\  util, "node:util": util,
        \\  "util/types": utilTypes, "node:util/types": utilTypes,
        \\  events, "node:events": events,
        \\  assert, "node:assert": assert,
        \\  "assert/strict": assertStrict, "node:assert/strict": assertStrict,
        \\  console: consoleModule, "node:console": consoleModule,
        \\  tty, "node:tty": tty,
        \\  v8, "node:v8": v8,
        \\  stream, "node:stream": stream,
        \\  perf_hooks: perfHooks, "node:perf_hooks": perfHooks,
        \\  vm, "node:vm": vm,
        \\  module: moduleModule, "node:module": moduleModule,
        \\  net, "node:net": net,
        \\  url, "node:url": url,
        \\  crypto, "node:crypto": crypto,
        \\  buffer, "node:buffer": buffer,
        \\  child_process: childProcess, "node:child_process": childProcess,
        \\  "path/posix": pathPosix, "node:path/posix": pathPosix,
        \\  "path/win32": pathWin32, "node:path/win32": pathWin32,
        \\  sys, "node:sys": sys,
        \\  zlib, "node:zlib": zlib
        \\}});
        \\moduleModule.__runMain({s});
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
            try jsonStringLiteral(ctx, util_module),
            try jsonStringLiteral(ctx, util_types_module),
            try jsonStringLiteral(ctx, events_module),
            try jsonStringLiteral(ctx, assert_module),
            try jsonStringLiteral(ctx, assert_strict_module),
            try jsonStringLiteral(ctx, console_module),
            try jsonStringLiteral(ctx, tty_module),
            try jsonStringLiteral(ctx, v8_module),
            try jsonStringLiteral(ctx, stream_module),
            try jsonStringLiteral(ctx, perf_hooks_module),
            try jsonStringLiteral(ctx, vm_module),
            try jsonStringLiteral(ctx, module_module),
            try jsonStringLiteral(ctx, net_module),
            try jsonStringLiteral(ctx, url_module),
            try jsonStringLiteral(ctx, crypto_module),
            try jsonStringLiteral(ctx, buffer_module),
            try jsonStringLiteral(ctx, child_process_module),
            try jsonStringLiteral(ctx, path_posix_module),
            try jsonStringLiteral(ctx, path_win32_module),
            try jsonStringLiteral(ctx, sys_module),
            try jsonStringLiteral(ctx, zlib_module),
            try jsonStringLiteral(ctx, script_abs),
        },
    );
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
