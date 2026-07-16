const std = @import("std");
const compiler = @import("cottontail_compiler");

const c_allocator = std.heap.c_allocator;

fn setError(error_out: *?[*:0]u8, comptime fmt: []const u8, args: anytype) void {
    const message = std.fmt.allocPrintSentinel(c_allocator, fmt, args, 0) catch {
        error_out.* = null;
        return;
    };
    error_out.* = message.ptr;
}

export fn ct_diff_format(
    received_ptr: ?[*]const u8,
    received_len: usize,
    expected_ptr: ?[*]const u8,
    expected_len: usize,
    not: bool,
    enable_ansi_colors: bool,
    output_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    output_len.* = 0;
    error_out.* = null;

    const received = if (received_ptr) |ptr| ptr[0..received_len] else if (received_len == 0) "" else {
        setError(error_out, "Received diff value pointer is null", .{});
        return null;
    };
    const expected = if (expected_ptr) |ptr| ptr[0..expected_len] else if (expected_len == 0) "" else {
        setError(error_out, "Expected diff value pointer is null", .{});
        return null;
    };

    var arena_state = std.heap.ArenaAllocator.init(c_allocator);
    defer arena_state.deinit();

    var output = std.Io.Writer.Allocating.init(c_allocator);
    defer output.deinit();
    compiler.test_diff.printDiffMain(
        arena_state.allocator(),
        not,
        received,
        expected,
        &output.writer,
        compiler.test_diff.DiffConfig.default(false, enable_ansi_colors),
    ) catch |err| {
        setError(error_out, "Diff formatting failed: {s}", .{@errorName(err)});
        return null;
    };

    const rendered = output.toOwnedSlice() catch |err| {
        setError(error_out, "Diff output allocation failed: {s}", .{@errorName(err)});
        return null;
    };
    output_len.* = rendered.len;
    return rendered.ptr;
}

export fn ct_diff_free(ptr: ?[*]u8, len: usize) void {
    if (ptr) |value| c_allocator.free(value[0..len]);
}

export fn ct_diff_string_free(ptr: ?[*:0]u8) void {
    if (ptr) |value| c_allocator.free(std.mem.span(value));
}

pub fn forceLink() void {
    _ = &ct_diff_format;
    _ = &ct_diff_free;
    _ = &ct_diff_string_free;
}
