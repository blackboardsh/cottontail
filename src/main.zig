const std = @import("std");
const electrobun_bridge = @import("electrobun.zig");
const electrobun_cli = @import("electrobun_cli.zig");
const host = @import("host.zig");
const runtime = @import("runtime.zig");
const script_runner = @import("script_runner.zig");

comptime {
    electrobun_bridge.forceLink();
    electrobun_cli.forceLink();
    host.forceLink();
}

const version = "0.1.1-beta.0";
const help_text_template =
    \\cottontail {s}
    \\Tiny Zig-based JavaScript runtime for Electrobun.
    \\
    \\Usage:
    \\  cottontail <entrypoint.js|entrypoint.ts> [args...]
    \\  cottontail run <entrypoint.js|entrypoint.ts> [args...]
    \\  cottontail electrobun <entrypoint.js> [args...]
    \\  cottontail electrobun <init|config|build|run|dev> [args...]
    \\  cottontail --help
    \\  cottontail --version
    \\
    \\Status:
    \\  QuickJS-ng is embedded with ESM imports, async job draining, and a small cottontail host API.
    \\  Entry points can be classic scripts, ESM modules, or TypeScript transpiled through esbuild.
    \\  Electrobun bridge mode can open native windows through the local Electrobun core.
    \\
;

fn printHelp(writer: anytype) !void {
    try writer.print(help_text_template, .{version});
}

const JsThreadContext = struct {
    io: std.Io,
    script_path: [:0]const u8,
    script_args: []const [:0]const u8,
};

fn runElectrobunJsThread(context: *const JsThreadContext) void {
    std.Io.sleep(
        context.io,
        std.Io.Duration.fromNanoseconds(@intCast(electrobun_bridge.bootDelayNs())),
        .awake,
    ) catch {};

    var arena_state = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena_state.deinit();

    var js_runtime = runtime.Runtime.init(context.io, arena_state.allocator()) catch {
        std.debug.print("cottontail: failed to initialize the embedded QuickJS runtime for electrobun mode\n", .{});
        electrobun_bridge.forceExit(1);
    };
    defer js_runtime.deinit();

    js_runtime.setArgs(context.script_args) catch {
        std.debug.print("cottontail: failed to initialize cottontail.args in electrobun mode\n", .{});
        electrobun_bridge.forceExit(1);
    };

    const exit_code = js_runtime.runFile(context.script_path);
    if (exit_code != 0) {
        electrobun_bridge.forceExit(exit_code);
    }

    if (electrobun_bridge.createdWindowCount() == 0) {
        electrobun_bridge.forceExit(0);
    }
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

    if (std.mem.eql(u8, arg, "electrobun")) {
        if (args.len <= 2) {
            const exit_code = try electrobun_cli.run(init, &.{});
            if (exit_code != 0) {
                try stderr.flush();
                std.process.exit(exit_code);
            }
            return;
        }

        if (std.mem.eql(u8, args[2], "build") or
            std.mem.eql(u8, args[2], "config") or
            std.mem.eql(u8, args[2], "init") or
            std.mem.eql(u8, args[2], "run") or
            std.mem.eql(u8, args[2], "dev") or
            std.mem.eql(u8, args[2], "--help") or
            std.mem.eql(u8, args[2], "-h"))
        {
            const exit_code = try electrobun_cli.run(init, args[2..]);
            if (exit_code != 0) {
                try stderr.flush();
                std.process.exit(exit_code);
            }
            return;
        }

        electrobun_bridge.init(init.io, init.arena.allocator()) catch |err| {
            try stderr.print("cottontail: failed to initialize electrobun bridge: {s}\n", .{@errorName(err)});
            if (electrobun_bridge.lastError().len > 0) {
                try stderr.print("{s}\n", .{electrobun_bridge.lastError()});
            }
            try stderr.flush();
            std.process.exit(1);
        };

        var js_thread_context = JsThreadContext{
            .io = init.io,
            .script_path = args[2],
            .script_args = args[3..],
        };

        const js_thread = try std.Thread.spawn(.{}, runElectrobunJsThread, .{&js_thread_context});
        js_thread.detach();

        electrobun_bridge.runMainThread(0) catch |err| {
            try stderr.print("cottontail: electrobun main thread failed: {s}\n", .{@errorName(err)});
            if (electrobun_bridge.lastError().len > 0) {
                try stderr.print("{s}\n", .{electrobun_bridge.lastError()});
            }
            try stderr.flush();
            std.process.exit(1);
        };

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
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "QuickJS-ng") != null);
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "<entrypoint.js|entrypoint.ts>") != null);
}
