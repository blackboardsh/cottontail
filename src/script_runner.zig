const std = @import("std");
const builtin = @import("builtin");
const runtime = @import("runtime.zig");

const esbuild_version = "0.28.0";

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

    const runnable_path = if (isTypescriptPath(script_path))
        try bundleTypescript(&ctx, script_path)
    else blk: {
        const script_abs = try resolvePathForCwd(ctx.io, ctx.allocator, script_path);
        if (!runtimeModulesAvailable(&ctx)) break :blk script_abs;
        const tmp_dir = try ensureTempDir(&ctx);
        break :blk try writeCottontailEntryWrapper(&ctx, tmp_dir, script_abs);
    };

    const runnable_path_z = try allocator.dupeZ(u8, runnable_path);

    var js_runtime = runtime.Runtime.init(init.io, allocator) catch {
        ctx.writeStderr("cottontail: failed to initialize the embedded QuickJS runtime\n", .{});
        return 1;
    };
    defer js_runtime.deinit();

    js_runtime.setArgs(script_args) catch {
        ctx.writeStderr("cottontail: failed to initialize cottontail.args\n", .{});
        return 1;
    };

    return js_runtime.runFile(runnable_path_z);
}

fn isTypescriptPath(path: []const u8) bool {
    return std.mem.endsWith(u8, path, ".ts") or
        std.mem.endsWith(u8, path, ".tsx") or
        std.mem.endsWith(u8, path, ".mts") or
        std.mem.endsWith(u8, path, ".cts");
}

fn bundleTypescript(ctx: *const Context, script_path: []const u8) ![]const u8 {
    try ensureEsbuild(ctx);

    const tmp_dir = try ensureTempDir(ctx);

    const script_abs = try resolvePathForCwd(ctx.io, ctx.allocator, script_path);
    const wrapped_entry = try writeCottontailEntryWrapper(ctx, tmp_dir, script_abs);
    const bundle_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "script.bundle.mjs" });
    const esbuild_bin = try esbuildBinaryPath(ctx);

    const bun_module = try runtimeModulePath(ctx, &.{ "bun", "index.js" });
    const bun_ffi_module = try runtimeModulePath(ctx, &.{ "bun", "ffi.js" });
    const fs_module = try runtimeModulePath(ctx, &.{ "node", "fs.js" });
    const fs_promises_module = try runtimeModulePath(ctx, &.{ "node", "fs", "promises.js" });
    const os_module = try runtimeModulePath(ctx, &.{ "node", "os.js" });
    const path_module = try runtimeModulePath(ctx, &.{ "node", "path.js" });
    const process_module = try runtimeModulePath(ctx, &.{ "node", "process.js" });
    const util_module = try runtimeModulePath(ctx, &.{ "node", "util.js" });
    const events_module = try runtimeModulePath(ctx, &.{ "node", "events.js" });
    const crypto_module = try runtimeModulePath(ctx, &.{ "node", "crypto.js" });
    const child_process_module = try runtimeModulePath(ctx, &.{ "node", "child_process.js" });
    const zlib_module = try runtimeModulePath(ctx, &.{ "node", "zlib.js" });

    const args = [_][]const u8{
        esbuild_bin,
        wrapped_entry,
        "--bundle",
        "--platform=neutral",
        "--format=esm",
        "--target=es2022",
        try std.fmt.allocPrint(ctx.allocator, "--outfile={s}", .{bundle_path}),
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
        try std.fmt.allocPrint(ctx.allocator, "--alias:process={s}", .{process_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:process={s}", .{process_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:util={s}", .{util_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:util={s}", .{util_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:events={s}", .{events_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:events={s}", .{events_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:crypto={s}", .{crypto_module}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:node:crypto={s}", .{crypto_module}),
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
    const tmp_dir = try std.fs.path.join(ctx.allocator, &.{ ctx.project_root, ".cottontail-tmp", "run" });
    try std.Io.Dir.cwd().createDirPath(ctx.io, tmp_dir);
    return tmp_dir;
}

fn findCottontailHome(init: std.process.Init, allocator: std.mem.Allocator, exe_dir: []const u8) ![]const u8 {
    if (init.environ_map.get("COTTONTAIL_HOME")) |home| {
        return try resolvePathForCwd(init.io, allocator, home);
    }

    if (init.environ_map.get("DASH_COTTONTAIL_ROOT")) |home| {
        return try resolvePathForCwd(init.io, allocator, home);
    }

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

fn looksLikeCottontailHome(io: std.Io, allocator: std.mem.Allocator, candidate: []const u8) bool {
    const package_json = std.fs.path.join(allocator, &.{ candidate, "package.json" }) catch return false;
    defer allocator.free(package_json);
    const src_main = std.fs.path.join(allocator, &.{ candidate, "src", "main.zig" }) catch return false;
    defer allocator.free(src_main);
    return pathExists(io, package_json) and pathExists(io, src_main);
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
