const std = @import("std");

const version = "0.1.0-dev";
const help_text_template =
    \\cottontail {s}
    \\Tiny Zig-based JavaScript runtime scaffold for Electrobun.
    \\
    \\Usage:
    \\  cottontail
    \\  cottontail --help
    \\  cottontail --version
    \\
    \\Status:
    \\  QuickJS-ng embedding is not wired yet.
    \\  This scaffold exists to lock in the Bun + vendored Zig workflow.
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

    try stderr.print(
        "cottontail: runtime bootstrap is not implemented yet; received argument: {s}\n",
        .{arg},
    );
    try stderr.flush();
    std.process.exit(2);
}

test "help text mentions cottontail and QuickJS-ng" {
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "cottontail") != null);
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "QuickJS-ng") != null);
}
