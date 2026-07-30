const std = @import("std");
const compiler = @import("cottontail_compiler");

fn constBytes(pointer: ?[*]const u8, length: usize) ?[]const u8 {
    if (length == 0) return &.{};
    const bytes = pointer orelse return null;
    return bytes[0..length];
}

fn mutableBytes(pointer: ?[*]u8, length: usize) ?[]u8 {
    if (length == 0) return &.{};
    const bytes = pointer orelse return null;
    return bytes[0..length];
}

pub fn headerLength(payload_length: usize) usize {
    return if (payload_length < 126) 2 else if (payload_length <= std.math.maxInt(u16)) 4 else 10;
}

pub export fn ct_websocket_frame_encode(
    output_pointer: ?[*]u8,
    output_length: usize,
    payload_pointer: ?[*]const u8,
    payload_length: usize,
    opcode: u8,
    rsv1: u8,
    masked: u8,
    mask_pointer: ?[*]const u8,
) c_int {
    const output = mutableBytes(output_pointer, output_length) orelse return -1;
    const payload = constBytes(payload_pointer, payload_length) orelse return -1;
    const is_masked = masked != 0;
    const header_length = headerLength(payload.len);
    const mask_length: usize = if (is_masked) 4 else 0;
    const expected_length = std.math.add(usize, header_length + mask_length, payload.len) catch return -1;
    if (output.len != expected_length) return -1;
    if ((opcode & 0x08) != 0 and payload.len > 125) return -1;

    output[0] = 0x80 | (if (rsv1 != 0) @as(u8, 0x40) else 0) | (opcode & 0x0f);
    if (payload.len < 126) {
        output[1] = (if (is_masked) @as(u8, 0x80) else 0) | @as(u8, @intCast(payload.len));
    } else if (payload.len <= std.math.maxInt(u16)) {
        output[1] = (if (is_masked) @as(u8, 0x80) else 0) | 126;
        std.mem.writeInt(u16, output[2..4], @intCast(payload.len), .big);
    } else {
        output[1] = (if (is_masked) @as(u8, 0x80) else 0) | 127;
        std.mem.writeInt(u64, output[2..10], @intCast(payload.len), .big);
    }

    const body_offset = header_length + mask_length;
    if (!is_masked) {
        compiler.highway.fillWithSkipMask(
            .{ 0, 0, 0, 0 },
            output[body_offset..],
            payload,
            true,
        );
        return 0;
    }

    const mask_bytes = constBytes(mask_pointer, 4) orelse return -1;
    const mask: [4]u8 = mask_bytes[0..4].*;
    @memcpy(output[header_length .. header_length + 4], &mask);
    compiler.highway.fillWithSkipMask(mask, output[body_offset..], payload, false);
    return 0;
}

pub export fn ct_websocket_unmask_copy(
    output_pointer: ?[*]u8,
    input_pointer: ?[*]const u8,
    length: usize,
    mask_pointer: ?[*]const u8,
) c_int {
    const output = mutableBytes(output_pointer, length) orelse return -1;
    const input = constBytes(input_pointer, length) orelse return -1;
    const mask_bytes = constBytes(mask_pointer, 4) orelse return -1;
    const mask: [4]u8 = mask_bytes[0..4].*;
    compiler.highway.fillWithSkipMask(mask, output, input, false);
    return 0;
}

test "WebSocket frame encoder writes canonical lengths and masks payloads" {
    const payload = "hello";
    const mask = [4]u8{ 0x37, 0xfa, 0x21, 0x3d };
    var output: [11]u8 = undefined;
    try std.testing.expectEqual(@as(c_int, 0), ct_websocket_frame_encode(
        &output,
        output.len,
        payload.ptr,
        payload.len,
        1,
        0,
        1,
        &mask,
    ));
    try std.testing.expectEqualSlices(
        u8,
        &.{ 0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x5f, 0x9f, 0x4d, 0x51, 0x58 },
        &output,
    );

    var medium: [130]u8 = @splat(0x5a);
    var medium_frame: [134]u8 = undefined;
    try std.testing.expectEqual(@as(c_int, 0), ct_websocket_frame_encode(
        &medium_frame,
        medium_frame.len,
        &medium,
        medium.len,
        2,
        1,
        0,
        null,
    ));
    try std.testing.expectEqualSlices(u8, &.{ 0xc2, 126, 0, 130 }, medium_frame[0..4]);
    try std.testing.expectEqualSlices(u8, &medium, medium_frame[4..]);
}

test "WebSocket unmask copies without mutating input" {
    const mask = [4]u8{ 1, 2, 3, 4 };
    const input = [_]u8{ 0x60, 0x60, 0x60, 0x60, 0x64 };
    var output: [5]u8 = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        ct_websocket_unmask_copy(&output, &input, input.len, &mask),
    );
    try std.testing.expectEqualSlices(u8, "abcde", &output);
    try std.testing.expectEqualSlices(u8, &.{ 0x60, 0x60, 0x60, 0x60, 0x64 }, &input);
}
