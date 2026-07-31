const std = @import("std");

const allocator = std.heap.c_allocator;

pub const Latin1Result = extern struct {
    ptr: ?[*]const u8,
    len: usize,
    capacity: usize,
};

pub const Utf16Result = extern struct {
    ptr: ?[*]const u16,
    len: usize,
    capacity: usize,
};

fn isControl(code: u16) bool {
    return code == 0x1b or code == 0x90 or code == 0x98 or
        (code >= 0x9b and code <= 0x9f);
}

fn consume(comptime T: type, input: []const T, start: usize) usize {
    var state: u3 = 0;
    for (input[start..], start..) |unit, index| {
        const code: u16 = unit;
        switch (state) {
            0 => {
                if (code == 0x1b) state = 1 else if (code == 0x9b) state = 3 else if (code == 0x9d) state = 4 else if (code == 0x90 or code == 0x98 or code == 0x9e or code == 0x9f) state = 6 else return index;
            },
            1 => {
                if (code == 0x5b) {
                    state = 3;
                } else if (code == 0x20 or code == 0x23 or code == 0x25 or
                    code == 0x28 or code == 0x29 or code == 0x2a or
                    code == 0x2b or code == 0x2e or code == 0x2f)
                {
                    state = 2;
                } else if (code == 0x5d) {
                    state = 4;
                } else if (code == 0x50 or code == 0x58 or code == 0x5e or code == 0x5f) {
                    state = 6;
                } else {
                    state = 0;
                }
            },
            2 => state = 0,
            3 => if (code >= 0x40 and code <= 0x7e) {
                state = 0;
            },
            4 => {
                if (code == 0x07 or code == 0x9c) state = 0 else if (code == 0x1b) state = 5;
            },
            5 => state = if (code == 0x5c) 0 else 4,
            6 => {
                if (code == 0x9c) state = 0 else if (code == 0x1b) state = 7;
            },
            7 => state = if (code == 0x5c) 0 else 6,
        }
    }
    return input.len;
}

fn strip(comptime T: type, input: []const T) !?[]T {
    var first_control: ?usize = null;
    for (input, 0..) |unit, index| {
        if (isControl(unit)) {
            first_control = index;
            break;
        }
    }
    if (first_control == null) return null;

    const output = try allocator.alloc(T, input.len);
    var written: usize = 0;
    var plain_start: usize = 0;
    var index: usize = first_control.?;
    if (index > 0) {
        @memcpy(output[0..index], input[0..index]);
        written = index;
    }
    plain_start = index;

    while (index < input.len) {
        if (!isControl(input[index])) {
            index += 1;
            continue;
        }
        if (plain_start < index) {
            const plain = input[plain_start..index];
            @memcpy(output[written..][0..plain.len], plain);
            written += plain.len;
        }
        const next = consume(T, input, index);
        if (next == index) {
            output[written] = input[index];
            written += 1;
            index += 1;
        } else {
            index = next;
        }
        plain_start = index;
    }
    if (plain_start < input.len) {
        const plain = input[plain_start..];
        @memcpy(output[written..][0..plain.len], plain);
        written += plain.len;
    }
    return output[0..written];
}

pub export fn ct_strip_ansi_latin1(
    pointer: ?[*]const u8,
    len: usize,
    result: *Latin1Result,
) c_int {
    result.* = .{ .ptr = null, .len = 0, .capacity = 0 };
    const input = if (len == 0) &.{} else pointer.?[0..len];
    const output = strip(u8, input) catch return -1;
    if (output) |value| {
        result.* = .{ .ptr = value.ptr, .len = value.len, .capacity = input.len };
        return 1;
    }
    return 0;
}

pub export fn ct_strip_ansi_utf16(
    pointer: ?[*]const u16,
    len: usize,
    result: *Utf16Result,
) c_int {
    result.* = .{ .ptr = null, .len = 0, .capacity = 0 };
    const input = if (len == 0) &.{} else pointer.?[0..len];
    const output = strip(u16, input) catch return -1;
    if (output) |value| {
        result.* = .{ .ptr = value.ptr, .len = value.len, .capacity = input.len };
        return 1;
    }
    return 0;
}

pub export fn ct_strip_ansi_free_latin1(pointer: ?[*]u8, capacity: usize) void {
    if (pointer == null or capacity == 0) return;
    allocator.free(pointer.?[0..capacity]);
}

pub export fn ct_strip_ansi_free_utf16(pointer: ?[*]u16, capacity: usize) void {
    if (pointer == null or capacity == 0) return;
    allocator.free(pointer.?[0..capacity]);
}

test "strip ANSI handles CSI, OSC, and unterminated controls" {
    const csi = try strip(u8, "before\x1b[31mred\x1b[0mafter");
    defer ct_strip_ansi_free_latin1(csi.?.ptr, "before\x1b[31mred\x1b[0mafter".len);
    try std.testing.expectEqualStrings("beforeredafter", csi.?);

    const osc = try strip(u8, "before\x1b]0;title\x07after");
    defer ct_strip_ansi_free_latin1(osc.?.ptr, "before\x1b]0;title\x07after".len);
    try std.testing.expectEqualStrings("beforeafter", osc.?);

    const unterminated = try strip(u8, "before\x1b[31");
    defer ct_strip_ansi_free_latin1(unterminated.?.ptr, "before\x1b[31".len);
    try std.testing.expectEqualStrings("before", unterminated.?);
}
