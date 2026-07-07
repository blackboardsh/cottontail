const std = @import("std");
const host = @import("host.zig");

const c = @cImport({
    @cInclude("qjs_runner.h");
});

pub const Runtime = struct {
    io: std.Io,
    allocator: std.mem.Allocator,
    handle: *c.CtQjsRuntime,
    max_script_size: usize = 64 * 1024 * 1024,

    pub fn init(io: std.Io, allocator: std.mem.Allocator) !Runtime {
        const handle = c.ct_qjs_runtime_create() orelse return error.RuntimeInitFailed;
        host.configure(io);
        return .{
            .io = io,
            .allocator = allocator,
            .handle = handle,
        };
    }

    pub fn deinit(self: *Runtime) void {
        c.ct_qjs_runtime_destroy(self.handle);
    }

    pub fn setArgs(self: *Runtime, args: []const [:0]const u8) !void {
        const arg_ptrs = try self.allocator.alloc([*c]const u8, args.len);
        for (args, 0..) |arg, index| {
            arg_ptrs[index] = arg.ptr;
        }

        var eval_error: [*c]u8 = null;
        const argv_ptr = if (arg_ptrs.len == 0)
            @as([*c]const [*c]const u8, null)
        else
            @as([*c]const [*c]const u8, @ptrCast(arg_ptrs.ptr));

        if (c.ct_qjs_runtime_set_args(self.handle, args.len, argv_ptr, &eval_error) != 0) {
            defer if (eval_error != null) {
                c.ct_qjs_string_free(eval_error);
            };

            if (eval_error != null) {
                self.writeStderrLine(std.mem.span(eval_error));
            } else {
                self.writeStderrLine("Failed to set cottontail.args");
            }

            return error.SetArgsFailed;
        }
    }

    pub fn runFile(self: *Runtime, script_path: [:0]const u8) u8 {
        const source = std.Io.Dir.cwd().readFileAlloc(
            self.io,
            script_path,
            self.allocator,
            .limited(self.max_script_size),
        ) catch |err| {
            self.writeLoadError(script_path, err);
            return 1;
        };

        const source_z = self.allocator.alloc(u8, source.len + 1) catch {
            self.writeStderrLine("cottontail: out of memory preparing script source");
            return 1;
        };
        @memcpy(source_z[0..source.len], source);
        source_z[source.len] = 0;

        var eval_error: [*c]u8 = null;

        if (c.ct_qjs_runtime_eval(self.handle, source_z.ptr, source.len, script_path.ptr, &eval_error) != 0) {
            defer if (eval_error != null) {
                c.ct_qjs_string_free(eval_error);
            };

            if (eval_error != null) {
                self.writeStderrLine(std.mem.span(eval_error));
            } else {
                self.writeStderrLine("Unknown JavaScript exception");
            }

            return 1;
        }

        return 0;
    }

    pub fn tick(self: *Runtime) !void {
        var eval_error: [*c]u8 = null;
        if (c.ct_qjs_runtime_tick(self.handle, &eval_error) != 0) {
            defer if (eval_error != null) {
                c.ct_qjs_string_free(eval_error);
            };

            if (eval_error != null) {
                self.writeStderrLine(std.mem.span(eval_error));
            } else {
                self.writeStderrLine("Unknown JavaScript exception during Cottontail tick");
            }

            return error.TickFailed;
        }
    }

    fn writeLoadError(self: *Runtime, script_path: []const u8, err: anyerror) void {
        var stderr_buffer: [1024]u8 = undefined;
        var stderr_writer = std.Io.File.stderr().writer(self.io, &stderr_buffer);
        const stderr = &stderr_writer.interface;

        stderr.print(
            "cottontail: failed to load script {s}: {s}\n",
            .{ script_path, @errorName(err) },
        ) catch {};
        stderr.flush() catch {};
    }

    fn writeStderrLine(self: *Runtime, message: []const u8) void {
        var stderr_buffer: [1024]u8 = undefined;
        var stderr_writer = std.Io.File.stderr().writer(self.io, &stderr_buffer);
        const stderr = &stderr_writer.interface;

        stderr.print("{s}\n", .{message}) catch {};
        stderr.flush() catch {};
    }
};
