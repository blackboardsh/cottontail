const std = @import("std");

const allocator = std.heap.c_allocator;

const escape: u16 = 0x1b;
const c1_dcs: u16 = 0x90;
const c1_sos: u16 = 0x98;
const c1_csi: u16 = 0x9b;
const c1_st: u16 = 0x9c;
const c1_osc: u16 = 0x9d;
const c1_pm: u16 = 0x9e;
const c1_apc: u16 = 0x9f;

pub const Slice = extern struct {
    ptr: ?[*]const u16,
    len: usize,
};

pub const Result = extern struct {
    ptr: ?[*]const u16,
    len: usize,
    capacity: usize,
};

fn asSlice(value: Slice) []const u16 {
    if (value.len == 0) return &.{};
    return value.ptr.?[0..value.len];
}

fn findControl(input: []const u16, start: usize) ?usize {
    const vector_length = 8;
    const Vector = @Vector(vector_length, u16);
    const Mask = @Vector(vector_length, u1);
    var index = start;
    while (index + vector_length <= input.len) : (index += vector_length) {
        const chunk: Vector = input[index..][0..vector_length].*;
        const matches =
            (chunk == @as(Vector, @splat(escape))) |
            (chunk == @as(Vector, @splat(c1_dcs))) |
            (chunk == @as(Vector, @splat(c1_sos))) |
            (chunk == @as(Vector, @splat(c1_csi))) |
            (chunk == @as(Vector, @splat(c1_st))) |
            (chunk == @as(Vector, @splat(c1_osc))) |
            (chunk == @as(Vector, @splat(c1_pm))) |
            (chunk == @as(Vector, @splat(c1_apc)));
        const mask: u8 = @bitCast(@as(Mask, @bitCast(matches)));
        if (mask != 0) return index + @as(usize, @intCast(@ctz(mask)));
    }
    while (index < input.len) : (index += 1) {
        switch (input[index]) {
            escape, c1_dcs, c1_sos, c1_csi, c1_st, c1_osc, c1_pm, c1_apc => return index,
            else => {},
        }
    }
    return null;
}

fn consumeANSI(input: []const u16, start: usize) usize {
    const State = enum {
        start,
        got_esc,
        ignore_next,
        in_csi,
        in_osc,
        in_osc_got_esc,
        need_st,
        need_st_got_esc,
    };

    var state: State = .start;
    var index = start;
    while (index < input.len) : (index += 1) {
        const code = input[index];
        switch (state) {
            .start => switch (code) {
                escape => state = .got_esc,
                c1_csi => state = .in_csi,
                c1_osc => state = .in_osc,
                c1_dcs, c1_sos, c1_pm, c1_apc => state = .need_st,
                else => return index,
            },
            .got_esc => switch (code) {
                '[' => state = .in_csi,
                ' ', '#', '%', '(', ')', '*', '+', '.', '/' => state = .ignore_next,
                ']' => state = .in_osc,
                'P', 'X', '^', '_' => state = .need_st,
                else => state = .start,
            },
            .ignore_next => state = .start,
            .in_csi => {
                if (code >= 0x40 and code <= 0x7e) state = .start;
            },
            .in_osc => {
                if (code == 0x07 or code == c1_st) {
                    state = .start;
                } else if (code == escape) {
                    state = .in_osc_got_esc;
                }
            },
            .in_osc_got_esc => {
                state = if (code == '\\') .start else .in_osc;
            },
            .need_st => {
                if (code == c1_st) {
                    state = .start;
                } else if (code == escape) {
                    state = .need_st_got_esc;
                }
            },
            .need_st_got_esc => {
                state = if (code == '\\') .start else .need_st;
            },
        }
    }
    return input.len;
}

fn stripANSI(input: []const u16, output: []u16) ?[]u16 {
    var control = findControl(input, 0) orelse return null;
    var read_index: usize = 0;
    var write_index: usize = 0;

    while (true) {
        const plain = input[read_index..control];
        @memcpy(output[write_index..][0..plain.len], plain);
        write_index += plain.len;

        const next = consumeANSI(input, control);
        if (next == control) {
            output[write_index] = input[control];
            write_index += 1;
            read_index = control + 1;
        } else {
            read_index = next;
        }

        control = findControl(input, read_index) orelse break;
    }

    const tail = input[read_index..];
    @memcpy(output[write_index..][0..tail.len], tail);
    return output[0 .. write_index + tail.len];
}

pub export fn ct_strip_ansi_core(
    input_value: Slice,
    output: *Result,
) c_int {
    output.* = .{ .ptr = null, .len = 0, .capacity = 0 };
    const input = asSlice(input_value);
    if (findControl(input, 0) == null) return 1;

    const buffer = allocator.alloc(u16, input.len) catch return -1;
    const result = stripANSI(input, buffer).?;
    output.* = .{
        .ptr = buffer.ptr,
        .len = result.len,
        .capacity = buffer.len,
    };
    return 0;
}

pub export fn ct_strip_ansi_core_free(pointer: ?*anyopaque, capacity: usize) void {
    if (pointer == null or capacity == 0) return;
    const values: [*]u16 = @ptrCast(@alignCast(pointer.?));
    allocator.free(values[0..capacity]);
}

test "stripANSI mirrors CSI OSC C1 malformed and Unicode behavior" {
    const cases = [_]struct {
        input: []const u16,
        expected: []const u16,
    }{
        .{ .input = &.{ 'p', 'l', 'a', 'i', 'n' }, .expected = &.{ 'p', 'l', 'a', 'i', 'n' } },
        .{ .input = &.{ escape, '[', '3', '1', 'm', 'r', 'e', 'd', escape, '[', '0', 'm' }, .expected = &.{ 'r', 'e', 'd' } },
        .{ .input = &.{ escape, ']', '0', ';', 'x', 0x07, 't' }, .expected = &.{'t'} },
        .{ .input = &.{ escape, ']', '0', ';', 'x', escape, '\\', 't' }, .expected = &.{'t'} },
        .{ .input = &.{ escape, ']', '0', ';', 'x', c1_st, 't' }, .expected = &.{'t'} },
        .{ .input = &.{ c1_csi, '3', '1', 'm', 't' }, .expected = &.{'t'} },
        .{ .input = &.{ c1_csi, '[', '3', '1', 'm', 't' }, .expected = &.{ '3', '1', 'm', 't' } },
        .{ .input = &.{ c1_dcs, 'x', escape, '\\', 't' }, .expected = &.{'t'} },
        .{ .input = &.{ c1_sos, 'x', c1_st, 't' }, .expected = &.{'t'} },
        .{ .input = &.{ c1_pm, 'x', escape, '\\', 't' }, .expected = &.{'t'} },
        .{ .input = &.{ c1_apc, 'x', c1_st, 't' }, .expected = &.{'t'} },
        .{ .input = &.{ c1_st, 't' }, .expected = &.{ c1_st, 't' } },
        .{ .input = &.{ 't', escape }, .expected = &.{'t'} },
        .{ .input = &.{ escape, ']', 'x' }, .expected = &.{} },
        .{ .input = &.{ escape, '[', 0xd83d, 0xde00 }, .expected = &.{} },
    };

    for (cases) |case| {
        var output: [32]u16 = undefined;
        const actual = stripANSI(case.input, &output);
        if (findControl(case.input, 0) == null) {
            try std.testing.expect(actual == null);
        } else {
            try std.testing.expectEqualSlices(u16, case.expected, actual.?);
        }
    }
}
