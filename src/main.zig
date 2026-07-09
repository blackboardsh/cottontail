const std = @import("std");
const host = @import("host.zig");
const script_runner = @import("script_runner.zig");

comptime {
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

    const script_path = if (std.mem.eql(u8, arg, "run")) blk: {
        if (args.len <= 2) {
            try stderr.print("cottontail: run requires an entrypoint script\n", .{});
            try stderr.flush();
            std.process.exit(1);
        }
        break :blk args[2];
    } else arg;
    const script_args = if (std.mem.eql(u8, arg, "run")) args[3..] else args[2..];

    const exit_code = try script_runner.run(init, script_path, script_args);
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
