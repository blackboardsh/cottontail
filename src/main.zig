const std = @import("std");
const cottontail_transpiler = @import("cottontail_transpiler.zig");
const host = @import("host.zig");
const script_runner = @import("script_runner.zig");

comptime {
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

fn parseInvocation(allocator: std.mem.Allocator, args: []const [:0]const u8) !CliInvocation {
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

    const invocation = parseInvocation(init.arena.allocator(), args) catch |err| switch (err) {
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
        .script => try script_runner.runWithExecArgv(init, invocation.payload, invocation.args, invocation.exec_args),
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
