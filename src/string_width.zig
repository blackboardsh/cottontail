const compiler = @import("cottontail_compiler");

extern fn u_hasBinaryProperty(code_point: i32, property: i32) i8;

export fn icu_hasBinaryProperty(code_point: u32, property: c_uint) bool {
    return u_hasBinaryProperty(@bitCast(code_point), @intCast(property)) != 0;
}

pub export fn ct_string_width_utf16(
    ptr: [*]const u16,
    len: usize,
    exclude_ansi: bool,
    ambiguous_as_wide: bool,
) isize {
    const input = ptr[0..len];
    if (!supportsCompilerWidthSemantics(input, exclude_ansi, ambiguous_as_wide)) {
        return -1;
    }
    const width = if (exclude_ansi)
        compiler.strings.visible.width.exclude_ansi_colors.utf16(input, ambiguous_as_wide)
    else
        compiler.strings.visible.width.utf16(input, ambiguous_as_wide);
    return @intCast(width);
}

pub export fn ct_string_width_latin1(
    ptr: [*]const u8,
    len: usize,
    exclude_ansi: bool,
    ambiguous_as_wide: bool,
) isize {
    const input = ptr[0..len];
    if (ambiguous_as_wide or !supportsLatin1CompilerWidthSemantics(input, exclude_ansi)) {
        return -1;
    }
    const width = if (exclude_ansi)
        compiler.strings.visible.width.exclude_ansi_colors.latin1(input)
    else
        compiler.strings.visible.width.latin1(input);
    return @intCast(width);
}

fn supportsLatin1CompilerWidthSemantics(input: []const u8, exclude_ansi: bool) bool {
    var saw_escape = false;
    for (input) |byte| {
        if (byte == 0x1b) {
            saw_escape = true;
        } else if (exclude_ansi and saw_escape and byte >= 0x80) {
            return false;
        }
    }
    return true;
}

fn supportsCompilerWidthSemantics(
    input: []const u16,
    exclude_ansi: bool,
    ambiguous_as_wide: bool,
) bool {
    // The compiler helper follows Unicode's complete ambiguous-width table,
    // while Bun.stringWidth currently widens only four code points. Keep the
    // uncommon non-default option on the authoritative JS path.
    if (ambiguous_as_wide) return false;

    var saw_escape = false;
    for (input) |code_unit| {
        if (code_unit == 0x1b) {
            saw_escape = true;
        } else if (exclude_ansi and saw_escape and code_unit >= 0x80) {
            // The public implementation does not recognize C1 ST. Avoid
            // duplicating its parser state here by conservatively falling
            // back for any non-ASCII code unit following an ESC.
            return false;
        }

        // Latin-1 is exhaustively differential-tested and lets the compiler
        // helper use its SIMD ASCII/ANSI paths. Its full grapheme algorithm is
        // slower than the current JS policy on CJK and intentionally differs
        // for several Unicode edge cases, so those stay on JS.
        if (code_unit > 0xff) return false;
    }
    return true;
}

test "native string width delegates to the compiler Unicode implementation" {
    const expectEqual = @import("std").testing.expectEqual;
    const hello = [_]u16{ 'h', 'e', 'l', 'l', 'o' };
    const ansi = [_]u16{ 0x1b, '[', '3', '1', 'm' };

    try expectEqual(@as(isize, 5), ct_string_width_utf16(&hello, hello.len, true, false));
    try expectEqual(@as(isize, 0), ct_string_width_utf16(&ansi, ansi.len, true, false));
    try expectEqual(@as(isize, 4), ct_string_width_utf16(&ansi, ansi.len, false, false));
    try expectEqual(@as(isize, 5), ct_string_width_latin1("hello", 5, true, false));
}
