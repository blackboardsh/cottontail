const std = @import("std");
const builtin = @import("builtin");
const script_runner = @import("script_runner.zig");

const interactive_bootstrap =
    \\import { runBuiltinCLI } from "node:repl";
    \\await runBuiltinCLI();
;

const interactive_banner =
    "Welcome to Bun v1.3.10\n" ++
    "Type .copy [code] to copy to clipboard. .help for more info.\n\n" ++
    "> ";

const eval_bootstrap_prefix =
    \\import { runBuiltinEval } from "node:repl";
    \\await runBuiltinEval(
;

pub fn run(init: std.process.Init, args: []const [:0]const u8) !u8 {
    if (args.len == 0) {
        if (try stdinIsKnownEof(init)) {
            try writeInteractiveBanner(init);
            try writeInteractiveEof(init);
            return 0;
        }
        return script_runner.runEval(init, interactive_bootstrap, &.{}, &.{}, false);
    }

    const allocator = init.arena.allocator();
    const arg = args[0];
    var source: ?[:0]const u8 = null;
    var print_result = false;
    var consumed: usize = 1;

    if (std.mem.eql(u8, arg, "-e") or std.mem.eql(u8, arg, "--eval")) {
        if (args.len > 1) {
            source = args[1];
            consumed = 2;
        }
    } else if (std.mem.eql(u8, arg, "-p") or std.mem.eql(u8, arg, "--print")) {
        print_result = true;
        if (args.len > 1) {
            source = args[1];
            consumed = 2;
        }
    } else if (std.mem.startsWith(u8, arg, "--eval=")) {
        source = try allocator.dupeZ(u8, arg["--eval=".len..]);
    } else if (std.mem.startsWith(u8, arg, "--print=")) {
        print_result = true;
        source = try allocator.dupeZ(u8, arg["--print=".len..]);
    } else {
        var stderr_buffer: [1024]u8 = undefined;
        var stderr_writer = std.Io.File.stderr().writer(init.io, &stderr_buffer);
        try stderr_writer.interface.print("cottontail repl: unknown option '{s}'\n", .{arg});
        try stderr_writer.interface.flush();
        return 1;
    }

    const eval_source = source orelse {
        var stderr_buffer: [1024]u8 = undefined;
        var stderr_writer = std.Io.File.stderr().writer(init.io, &stderr_buffer);
        try stderr_writer.interface.writeAll("cottontail repl: -e/--eval and -p/--print require a script argument\n");
        try stderr_writer.interface.flush();
        return 1;
    };

    const source_literal = try std.json.Stringify.valueAlloc(allocator, eval_source, .{});
    const bootstrap_text = try std.fmt.allocPrint(
        allocator,
        "{s}{s}, {s});\n",
        .{ eval_bootstrap_prefix, source_literal, if (print_result) "true" else "false" },
    );
    const bootstrap = try allocator.dupeZ(u8, bootstrap_text);
    return script_runner.runEval(init, bootstrap, args[consumed..], &.{}, false);
}

fn writeInteractiveBanner(init: std.process.Init) !void {
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(init.io, &stdout_buffer);
    try stdout_writer.interface.writeAll(interactive_banner);
    try stdout_writer.interface.flush();
}

fn writeInteractiveEof(init: std.process.Init) !void {
    var stdout_buffer: [1]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(init.io, &stdout_buffer);
    try stdout_writer.interface.writeByte('\n');
    try stdout_writer.interface.flush();
}

fn stdinIsKnownEof(init: std.process.Init) !bool {
    const stdin = std.Io.File.stdin();
    if (stdin.isTty(init.io) catch false) return false;

    const stdin_stat = stdin.stat(init.io) catch return false;
    if (stdin_stat.kind == .file and stdin_stat.size == 0) return true;
    if (stdin_stat.kind != .character_device) return false;

    const null_path = if (builtin.os.tag == .windows) "NUL" else "/dev/null";
    const null_file = std.Io.Dir.cwd().openFile(init.io, null_path, .{}) catch return false;
    defer null_file.close(init.io);
    const null_stat = null_file.stat(init.io) catch return false;
    return null_stat.kind == .character_device and stdin_stat.inode == null_stat.inode;
}

test "REPL bootstrap uses the runtime REPL module" {
    try std.testing.expect(std.mem.indexOf(u8, interactive_bootstrap, "runBuiltinCLI") != null);
    try std.testing.expect(std.mem.indexOf(u8, eval_bootstrap_prefix, "runBuiltinEval") != null);
}
