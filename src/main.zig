const std = @import("std");
const builtin = @import("builtin");
const cottontail_hash = @import("cottontail_hash.zig");
const cottontail_password = @import("cottontail_password.zig");
const cottontail_transpiler = @import("cottontail_transpiler.zig");
const host = @import("host.zig");
const script_runner = @import("script_runner.zig");

comptime {
    cottontail_hash.forceLink();
    cottontail_password.forceLink();
    cottontail_transpiler.forceLink();
    host.forceLink();
}

const version = "0.1.1-beta.0";
const help_text_template =
    \\cottontail {s}
    \\Tiny Zig-based JavaScript runtime.
    \\
    \\Usage:
    \\  cottontail <entrypoint.js|entrypoint.ts> [args...]
    \\  cottontail run <entrypoint.js|entrypoint.ts> [args...]
    \\  cottontail test [args...]
    \\  cottontail -e|--eval <script> [args...]
    \\  cottontail -p|--print <expression> [args...]
    \\  cottontail --help
    \\  cottontail --version
    \\
    \\Status:
    \\  JavaScriptCore is embedded with ESM imports, async job draining, and a small cottontail host API.
    \\  Entry points can be classic scripts, ESM modules, or TypeScript transpiled through esbuild.
    \\
;

fn printHelp(writer: anytype) !void {
    try writer.print(help_text_template, .{version});
}

const CliMode = enum { script, eval, print, stdin };

const CliInvocation = struct {
    mode: CliMode,
    payload: [:0]const u8,
    args: []const [:0]const u8,
    exec_args: []const [:0]const u8,
};

const CliParseError = error{
    MissingEntrypoint,
    MissingEvalSource,
    MissingPrintSource,
};

fn appendExecArg(exec_args: [][:0]const u8, exec_len: *usize, arg: [:0]const u8) void {
    exec_args[exec_len.*] = arg;
    exec_len.* += 1;
}

fn argAfterPrefix(allocator: std.mem.Allocator, arg: [:0]const u8, prefix: []const u8) ![:0]const u8 {
    return try allocator.dupeZ(u8, arg[prefix.len..]);
}

fn runtimeFlagTakesValue(arg: []const u8) bool {
    if (std.mem.indexOfScalar(u8, arg, '=') != null) return false;
    const value_flags = [_][]const u8{
        "-r",
        "--require",
        "--import",
        "--loader",
        "--experimental-loader",
        "--conditions",
        "--input-type",
        "--experimental-default-type",
        "--inspect-publish-uid",
        "--icu-data-dir",
        "--env-file",
        "--env-file-if-exists",
        "--diagnostic-dir",
        "--redirect-warnings",
        "--snapshot-blob",
        "--test-name-pattern",
        "--test-reporter",
        "--test-reporter-destination",
        "--test-shard",
    };
    for (value_flags) |candidate| {
        if (std.mem.eql(u8, arg, candidate)) return true;
    }
    return false;
}

fn isRuntimeFlag(arg: []const u8) bool {
    if (std.mem.eql(u8, arg, "-r")) return true;
    return std.mem.startsWith(u8, arg, "--");
}

fn testFlagTakesValue(arg: []const u8) bool {
    if (std.mem.indexOfScalar(u8, arg, '=') != null) return false;
    const value_flags = [_][]const u8{
        "--bail",
        "--max-concurrency",
        "--preload",
        "--timeout",
    };
    for (value_flags) |candidate| {
        if (std.mem.eql(u8, arg, candidate)) return true;
    }
    return false;
}

fn testEntrypointIndex(args: []const [:0]const u8) ?usize {
    var index: usize = 2;
    while (index < args.len) {
        const arg = args[index];
        if (!std.mem.startsWith(u8, arg, "-")) return index;
        index += if (testFlagTakesValue(arg) and index + 1 < args.len) 2 else 1;
    }
    return null;
}

fn resolveTestEntrypoint(io: std.Io, allocator: std.mem.Allocator, requested: [:0]const u8) ![:0]const u8 {
    std.Io.Dir.cwd().access(io, requested, .{}) catch {
        if (std.fs.path.extension(requested).len > 0) return requested;
        const directory = try std.Io.Dir.cwd().openDir(io, ".", .{ .iterate = true });
        defer directory.close(io);
        var iterator = directory.iterate();
        while (try iterator.next(io)) |entry| {
            if (entry.kind != .file or !isTestEntrypoint(entry.name)) continue;
            if (std.mem.startsWith(u8, entry.name, requested)) return try allocator.dupeZ(u8, entry.name);
        }
    };
    return requested;
}

fn testScriptArgs(
    allocator: std.mem.Allocator,
    args: []const [:0]const u8,
    entrypoint_index: usize,
) ![]const [:0]const u8 {
    const result = try allocator.alloc([:0]const u8, args.len - 3);
    var output_index: usize = 0;
    for (args[2..], 2..) |arg, index| {
        if (index == entrypoint_index) continue;
        result[output_index] = arg;
        output_index += 1;
    }
    return result;
}

fn testEntrypointMask(allocator: std.mem.Allocator, args: []const [:0]const u8) ![]bool {
    const mask = try allocator.alloc(bool, args.len);
    @memset(mask, false);
    var index: usize = 2;
    while (index < args.len) {
        const arg = args[index];
        if (std.mem.startsWith(u8, arg, "-")) {
            index += if (testFlagTakesValue(arg) and index + 1 < args.len) 2 else 1;
            continue;
        }
        mask[index] = true;
        index += 1;
    }
    return mask;
}

fn childExitCode(term: std.process.Child.Term) u8 {
    return switch (term) {
        .exited => |code| @intCast(@min(code, 255)),
        .signal, .stopped, .unknown => 1,
    };
}

fn isBunShellScript(path: []const u8) bool {
    return std.mem.endsWith(u8, path, ".bun.sh");
}

fn runBunShellScript(init: std.process.Init, script_path: [:0]const u8, script_args: []const [:0]const u8) !u8 {
    const allocator = init.arena.allocator();
    const argv = try allocator.alloc([]const u8, script_args.len + 2);
    argv[0] = "sh";
    argv[1] = script_path;
    for (script_args, 0..) |arg, index| {
        argv[index + 2] = arg;
    }
    var child = try std.process.spawn(init.io, .{
        .argv = argv,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    });
    defer child.kill(init.io);
    return childExitCode(try child.wait(init.io));
}

fn runMultipleTestFiles(init: std.process.Init, args: []const [:0]const u8) !?u8 {
    if (args.len < 4 or !std.mem.eql(u8, args[1], "test")) return null;
    const allocator = init.arena.allocator();
    const entrypoints = try testEntrypointMask(allocator, args);
    var entrypoint_count: usize = 0;
    for (entrypoints) |is_entrypoint| entrypoint_count += @intFromBool(is_entrypoint);
    if (entrypoint_count <= 1) return null;

    var exit_code: u8 = 0;
    for (entrypoints, 0..) |is_entrypoint, entrypoint_index| {
        if (!is_entrypoint) continue;
        const child_args = try allocator.alloc([]const u8, args.len - entrypoint_count + 1);
        child_args[0] = args[0];
        child_args[1] = args[1];
        var child_index: usize = 2;
        for (args[2..], 2..) |arg, index| {
            if (entrypoints[index] and index != entrypoint_index) continue;
            child_args[child_index] = arg;
            child_index += 1;
        }
        var child = try std.process.spawn(init.io, .{
            .argv = child_args,
            .stdin = .inherit,
            .stdout = .inherit,
            .stderr = .inherit,
            .create_no_window = true,
        });
        defer child.kill(init.io);
        const code = childExitCode(try child.wait(init.io));
        if (code != 0) exit_code = code;
    }
    return exit_code;
}

fn parseInvocation(io: std.Io, allocator: std.mem.Allocator, args: []const [:0]const u8) !CliInvocation {
    if (args.len <= 1) return CliParseError.MissingEntrypoint;

    const exec_args_storage = try allocator.alloc([:0]const u8, args.len);
    var exec_len: usize = 0;

    if (std.mem.eql(u8, args[1], "run")) {
        if (args.len <= 2) return CliParseError.MissingEntrypoint;
        return .{
            .mode = .script,
            .payload = args[2],
            .args = args[3..],
            .exec_args = exec_args_storage[0..0],
        };
    }

    if (std.mem.eql(u8, args[1], "test")) {
        if (testEntrypointIndex(args)) |entrypoint_index| {
            return .{
                .mode = .script,
                .payload = try resolveTestEntrypoint(io, allocator, args[entrypoint_index]),
                .args = try testScriptArgs(allocator, args, entrypoint_index),
                .exec_args = exec_args_storage[0..0],
            };
        }
        return .{
            .mode = .script,
            .payload = try defaultTestEntrypoint(io, allocator),
            .args = args[2..],
            .exec_args = exec_args_storage[0..0],
        };
    }

    var index: usize = 1;
    while (index < args.len) {
        const arg = args[index];

        if (std.mem.eql(u8, arg, "--")) {
            index += 1;
            if (index >= args.len) return CliParseError.MissingEntrypoint;
            return .{
                .mode = .script,
                .payload = args[index],
                .args = args[index + 1 ..],
                .exec_args = exec_args_storage[0..exec_len],
            };
        }

        if (std.mem.eql(u8, arg, "-e") or std.mem.eql(u8, arg, "--eval")) {
            if (index + 1 >= args.len) return CliParseError.MissingEvalSource;
            appendExecArg(exec_args_storage, &exec_len, arg);
            appendExecArg(exec_args_storage, &exec_len, args[index + 1]);
            return .{
                .mode = .eval,
                .payload = args[index + 1],
                .args = args[index + 2 ..],
                .exec_args = exec_args_storage[0..exec_len],
            };
        }

        if (std.mem.startsWith(u8, arg, "--eval=")) {
            appendExecArg(exec_args_storage, &exec_len, arg);
            return .{
                .mode = .eval,
                .payload = try argAfterPrefix(allocator, arg, "--eval="),
                .args = args[index + 1 ..],
                .exec_args = exec_args_storage[0..exec_len],
            };
        }

        if (std.mem.eql(u8, arg, "-p") or std.mem.eql(u8, arg, "--print")) {
            if (index + 1 >= args.len) return CliParseError.MissingPrintSource;
            appendExecArg(exec_args_storage, &exec_len, arg);
            appendExecArg(exec_args_storage, &exec_len, args[index + 1]);
            return .{
                .mode = .print,
                .payload = args[index + 1],
                .args = args[index + 2 ..],
                .exec_args = exec_args_storage[0..exec_len],
            };
        }

        if (std.mem.startsWith(u8, arg, "--print=")) {
            appendExecArg(exec_args_storage, &exec_len, arg);
            return .{
                .mode = .print,
                .payload = try argAfterPrefix(allocator, arg, "--print="),
                .args = args[index + 1 ..],
                .exec_args = exec_args_storage[0..exec_len],
            };
        }

        if (isRuntimeFlag(arg)) {
            appendExecArg(exec_args_storage, &exec_len, arg);
            if (runtimeFlagTakesValue(arg) and index + 1 < args.len) {
                appendExecArg(exec_args_storage, &exec_len, args[index + 1]);
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }

        return .{
            .mode = .script,
            .payload = arg,
            .args = args[index + 1 ..],
            .exec_args = exec_args_storage[0..exec_len],
        };
    }

    if (exec_len > 0) {
        return .{
            .mode = .stdin,
            .payload = try allocator.dupeZ(u8, ""),
            .args = args[args.len..],
            .exec_args = exec_args_storage[0..exec_len],
        };
    }

    return CliParseError.MissingEntrypoint;
}

fn isTestEntrypoint(name: []const u8) bool {
    const extensions = [_][]const u8{ ".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts" };
    if (std.mem.indexOf(u8, name, ".test.") == null) return false;
    for (extensions) |extension| {
        if (std.mem.endsWith(u8, name, extension)) return true;
    }
    return false;
}

fn defaultTestEntrypoint(io: std.Io, allocator: std.mem.Allocator) ![:0]const u8 {
    const candidates = [_][]const u8{
        "index.test.ts",
        "index.test.tsx",
        "index.test.js",
        "index.test.mjs",
        "index.test.cjs",
        "test.ts",
        "test.js",
    };
    for (candidates) |candidate| {
        std.Io.Dir.cwd().access(io, candidate, .{}) catch continue;
        return try allocator.dupeZ(u8, candidate);
    }

    const directory = try std.Io.Dir.cwd().openDir(io, ".", .{ .iterate = true });
    defer directory.close(io);
    var iterator = directory.iterate();
    var selected: ?[]const u8 = null;
    while (try iterator.next(io)) |entry| {
        if (entry.kind != .file or !isTestEntrypoint(entry.name)) continue;
        if (selected == null or std.mem.order(u8, entry.name, selected.?) == .lt) {
            selected = try allocator.dupe(u8, entry.name);
        }
    }
    if (selected) |name| return try allocator.dupeZ(u8, name);
    return CliParseError.MissingEntrypoint;
}

pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(init.arena.allocator());

    var stdout_buffer: [1024]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(init.io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    var stderr_buffer: [1024]u8 = undefined;
    var stderr_writer = std.Io.File.stderr().writer(init.io, &stderr_buffer);
    const stderr = &stderr_writer.interface;

    if (args.len <= 1) {
        try printHelp(stdout);
        try stdout.flush();
        return;
    }

    const arg = args[1];

    if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
        try printHelp(stdout);
        try stdout.flush();
        return;
    }

    if (std.mem.eql(u8, arg, "--version") or std.mem.eql(u8, arg, "-v")) {
        try stdout.print("{s}\n", .{version});
        try stdout.flush();
        return;
    }

    if (std.mem.eql(u8, arg, "exec")) {
        if (args.len <= 2) {
            try stderr.print("cottontail: exec requires a command\n", .{});
            try stderr.flush();
            std.process.exit(1);
        }
        if (builtin.os.tag == .windows) {
            try stderr.print("cottontail: exec is unavailable on this platform yet\n", .{});
            try stderr.flush();
            std.process.exit(1);
        }

        const allocator = init.arena.allocator();
        const command_parts = try allocator.alloc([]const u8, args.len - 2);
        for (command_parts, 0..) |*part, index| {
            part.* = args[index + 2];
        }
        const command = try std.mem.joinZ(allocator, " ", command_parts);
        const shell = "/bin/sh";
        const shell_arg = "-c";
        const exec_args = [_:null]?[*:0]const u8{ shell.ptr, shell_arg.ptr, command.ptr };
        _ = std.c.execve(shell.ptr, &exec_args, @ptrCast(std.c.environ));
        try stderr.print("cottontail: exec failed\n", .{});
        try stderr.flush();
        std.process.exit(127);
    }

    if (try runMultipleTestFiles(init, args)) |exit_code| {
        if (exit_code != 0) std.process.exit(exit_code);
        return;
    }

    if (std.mem.eql(u8, arg, "test")) {
        try stdout.print("bun test 0.0.0-cottontail (cottontail)\n", .{});
        try stdout.flush();
        try init.environ_map.put("COTTONTAIL_TEST_CLI_HEADER_PRINTED", "1");
    }

    const invocation = parseInvocation(init.io, init.arena.allocator(), args) catch |err| switch (err) {
        CliParseError.MissingEntrypoint => {
            try stderr.print("cottontail: expected an entrypoint script, -e script, or -p expression\n", .{});
            try stderr.flush();
            std.process.exit(1);
        },
        CliParseError.MissingEvalSource => {
            try stderr.print("cottontail: -e/--eval requires a script argument\n", .{});
            try stderr.flush();
            std.process.exit(1);
        },
        CliParseError.MissingPrintSource => {
            try stderr.print("cottontail: -p/--print requires an expression argument\n", .{});
            try stderr.flush();
            std.process.exit(1);
        },
        else => return err,
    };

    const exit_code = switch (invocation.mode) {
        .script => if (isBunShellScript(invocation.payload))
            try runBunShellScript(init, invocation.payload, invocation.args)
        else
            try script_runner.runWithExecArgv(init, invocation.payload, invocation.args, invocation.exec_args),
        .eval => try script_runner.runEval(init, invocation.payload, invocation.args, invocation.exec_args, false),
        .print => try script_runner.runEval(init, invocation.payload, invocation.args, invocation.exec_args, true),
        .stdin => try script_runner.runStdin(init, invocation.args, invocation.exec_args),
    };
    if (exit_code != 0) {
        try stderr.flush();
        std.process.exit(@intCast(exit_code));
    }
}

test "help text mentions cottontail and script usage" {
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "cottontail") != null);
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "JavaScriptCore") != null);
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "<entrypoint.js|entrypoint.ts>") != null);
}

test "test entrypoint names use supported test extensions" {
    try std.testing.expect(isTestEntrypoint("example.test.ts"));
    try std.testing.expect(isTestEntrypoint("example.test.cjs"));
    try std.testing.expect(!isTestEntrypoint("example.ts"));
    try std.testing.expect(!isTestEntrypoint("example.test.txt"));
}

test "test flags can precede the entrypoint" {
    const args = [_][:0]const u8{ "cottontail", "test", "--max-concurrency", "3", "suite.test.ts" };
    try std.testing.expectEqual(@as(?usize, 4), testEntrypointIndex(&args));
    try std.testing.expectEqual(@as(?usize, null), testEntrypointIndex(args[0..4]));
}
