const std = @import("std");

extern fn ct_run_file(script_path: [*:0]const u8) c_int;

const version = "0.1.0-dev";
const help_text_template =
    \\cottontail {s}
    \\Tiny Zig-based JavaScript runtime for Electrobun.
    \\
    \\Usage:
    \\  cottontail <script.js>
    \\  cottontail --help
    \\  cottontail --version
    \\
    \\Status:
    \\  QuickJS-ng is embedded with a minimal console.log / console.error host.
    \\  Pass a JavaScript file path to evaluate it as a global script.
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

    const exit_code = ct_run_file(arg.ptr);
    if (exit_code != 0) {
        try stderr.flush();
        std.process.exit(@intCast(exit_code));
    }
}

test "help text mentions cottontail and script usage" {
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "cottontail") != null);
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "QuickJS-ng") != null);
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "<script.js>") != null);
}
