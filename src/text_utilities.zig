pub export fn ct_text_ascii_width(
    input_ptr: ?[*]const u16,
    input_len: usize,
) isize {
    if (input_len == 0) return 0;
    const input = (input_ptr orelse return -1)[0..input_len];

    var width: usize = 0;
    for (input) |unit| {
        if (unit > 0x7f or unit == 0x1b) return -1;
        width += @intFromBool(unit >= 0x20 and unit < 0x7f);
    }
    return @intCast(width);
}

test "ASCII width counts printable code units" {
    const input = [_]u16{ 'a', 0, 'b', '\n', 0x7f, 'c' };
    try @import("std").testing.expectEqual(
        @as(isize, 3),
        ct_text_ascii_width(&input, input.len),
    );
}

test "ASCII width rejects complex strings" {
    const unicode = [_]u16{ 'a', 0x100 };
    const ansi = [_]u16{ 'a', 0x1b, '[', 'm' };
    try @import("std").testing.expectEqual(
        @as(isize, -1),
        ct_text_ascii_width(&unicode, unicode.len),
    );
    try @import("std").testing.expectEqual(
        @as(isize, -1),
        ct_text_ascii_width(&ansi, ansi.len),
    );
}
