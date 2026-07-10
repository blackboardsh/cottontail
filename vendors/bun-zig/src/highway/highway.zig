fn highway_char_frequency(
    text: [*]const u8,
    text_len: usize,
    freqs: [*]i32,
    delta: i32,
) void {
    for (text[0..text_len]) |c| {
        if (c >= 'a' and c <= 'z') {
            freqs[c - 'a'] += delta;
        } else if (c >= 'A' and c <= 'Z') {
            freqs[c - 'A' + 26] += delta;
        } else if (c >= '0' and c <= '9') {
            freqs[c - '0' + 52] += delta;
        } else if (c == '_') {
            freqs[62] += delta;
        } else if (c == '$') {
            freqs[63] += delta;
        }
    }
}

fn highway_index_of_char(
    haystack: [*]const u8,
    haystack_len: usize,
    needle: u8,
) usize {
    for (haystack[0..haystack_len], 0..) |c, i| {
        if (c == needle) return i;
    }
    return haystack_len;
}

fn highway_index_of_interesting_character_in_string_literal(
    noalias text: [*]const u8,
    text_len: usize,
    quote: u8,
) usize {
    for (text[0..text_len], 0..) |c, i| {
        if (c == quote or c == '\\' or c < 0x20 or c > 0x7e) return i;
    }
    return text_len;
}

fn highway_index_of_newline_or_non_ascii(
    noalias haystack: [*]const u8,
    haystack_len: usize,
) usize {
    for (haystack[0..haystack_len], 0..) |c, i| {
        if (c > 127 or c < 0x20) return i;
    }
    return haystack_len;
}

fn highway_index_of_newline_or_non_ascii_or_ansi(
    noalias haystack: [*]const u8,
    haystack_len: usize,
) usize {
    return highway_index_of_newline_or_non_ascii(haystack, haystack_len);
}

fn highway_index_of_newline_or_non_ascii_or_hash_or_at(
    noalias haystack: [*]const u8,
    haystack_len: usize,
) usize {
    for (haystack[0..haystack_len], 0..) |c, i| {
        if (c == '#' or c == '@' or c < 0x20 or c > 127) return i;
    }
    return haystack_len;
}

fn highway_index_of_space_or_newline_or_non_ascii(
    noalias haystack: [*]const u8,
    haystack_len: usize,
) usize {
    for (haystack[0..haystack_len], 0..) |c, i| {
        if (c <= ' ' or c > 127) return i;
    }
    return haystack_len;
}

fn highway_contains_newline_or_non_ascii_or_quote(
    noalias text: [*]const u8,
    text_len: usize,
) bool {
    for (text[0..text_len]) |c| {
        if (c > 127 or c < 0x20 or c == '"') return true;
    }
    return false;
}

fn highway_index_of_needs_escape_for_javascript_string(
    noalias text: [*]const u8,
    text_len: usize,
    quote_char: u8,
) usize {
    for (text[0..text_len], 0..) |c, i| {
        if (c >= 127 or c < 0x20 or c == '\\' or c == quote_char or (quote_char == '`' and c == '$')) return i;
    }
    return text_len;
}

fn highway_index_of_any_char(
    noalias text: [*]const u8,
    text_len: usize,
    noalias chars: [*]const u8,
    chars_len: usize,
) usize {
    for (text[0..text_len], 0..) |c, i| {
        for (chars[0..chars_len]) |needle| {
            if (c == needle) return i;
        }
    }
    return text_len;
}

fn highway_fill_with_skip_mask(
    mask: [*]const u8,
    mask_len: usize,
    output: [*]u8,
    input: [*]const u8,
    length: usize,
    skip_mask: bool,
) void {
    if (skip_mask) {
        @memcpy(output[0..length], input[0..length]);
        return;
    }

    for (input[0..length], 0..) |byte, i| {
        output[i] = byte ^ mask[i % mask_len];
    }
}

/// Count frequencies of [a-zA-Z0-9_$] characters in a string
/// Updates the provided frequency array with counts (adds delta for each occurrence)
pub fn scanCharFrequency(text: string, freqs: *[64]i32, delta: i32) void {
    if (text.len == 0 or delta == 0) {
        return;
    }

    highway_char_frequency(
        text.ptr,
        text.len,
        freqs.ptr,
        delta,
    );
}

pub fn indexOfChar(haystack: string, needle: u8) ?usize {
    if (haystack.len == 0) {
        return null;
    }

    const result = highway_index_of_char(
        haystack.ptr,
        haystack.len,
        needle,
    );

    if (result == haystack.len) {
        return null;
    }

    bun.debugAssert(haystack[result] == needle);

    return result;
}

pub fn indexOfInterestingCharacterInStringLiteral(slice: string, quote_type: u8) ?usize {
    if (slice.len == 0) {
        return null;
    }

    const result = highway_index_of_interesting_character_in_string_literal(
        slice.ptr,
        slice.len,
        quote_type,
    );

    if (result == slice.len) {
        return null;
    }

    return result;
}

pub fn indexOfNewlineOrNonASCII(haystack: string) ?usize {
    bun.debugAssert(haystack.len > 0);

    const result = highway_index_of_newline_or_non_ascii(
        haystack.ptr,
        haystack.len,
    );

    if (result == haystack.len) {
        return null;
    }
    if (comptime Environment.isDebug) {
        const haystack_char = haystack[result];
        if (!(haystack_char > 127 or haystack_char < 0x20 or haystack_char == '\r' or haystack_char == '\n')) {
            @panic("Invalid character found in indexOfNewlineOrNonASCII");
        }
    }

    return result;
}

pub fn indexOfNewlineOrNonASCIIOrANSI(haystack: string) ?usize {
    bun.debugAssert(haystack.len > 0);

    const result = highway_index_of_newline_or_non_ascii_or_ansi(
        haystack.ptr,
        haystack.len,
    );

    if (result == haystack.len) {
        return null;
    }
    if (comptime Environment.isDebug) {
        const haystack_char = haystack[result];
        if (!(haystack_char > 127 or haystack_char < 0x20 or haystack_char == '\r' or haystack_char == '\n')) {
            @panic("Invalid character found in indexOfNewlineOrNonASCIIOrANSI");
        }
    }

    return result;
}

/// Checks if the string contains any newlines, non-ASCII characters, or quotes
pub fn containsNewlineOrNonASCIIOrQuote(text: string) bool {
    if (text.len == 0) {
        return false;
    }

    return highway_contains_newline_or_non_ascii_or_quote(
        text.ptr,
        text.len,
    );
}

/// Finds the first character that needs escaping in a JavaScript string
/// Looks for characters above ASCII (> 127), control characters (< 0x20),
/// backslash characters (`\`), the quote character itself, and for backtick
/// strings also the dollar sign (`$`)
pub fn indexOfNeedsEscapeForJavaScriptString(slice: string, quote_char: u8) ?u32 {
    if (slice.len == 0) {
        return null;
    }

    const result = highway_index_of_needs_escape_for_javascript_string(
        slice.ptr,
        slice.len,
        quote_char,
    );

    if (result == slice.len) {
        return null;
    }

    if (comptime Environment.isDebug) {
        const haystack_char = slice[result];
        if (!(haystack_char >= 127 or haystack_char < 0x20 or haystack_char == '\\' or haystack_char == quote_char or haystack_char == '$' or haystack_char == '\r' or haystack_char == '\n')) {
            std.debug.panic("Invalid character found in indexOfNeedsEscapeForJavaScriptString: U+{x}. Full string: \"{f}\"", .{ haystack_char, std.zig.fmtString(slice) });
        }
    }

    return @truncate(result);
}

pub fn indexOfAnyChar(haystack: string, chars: string) ?usize {
    if (haystack.len == 0 or chars.len == 0) {
        return null;
    }

    const result = highway_index_of_any_char(haystack.ptr, haystack.len, chars.ptr, chars.len);

    if (result == haystack.len) {
        return null;
    }

    if (comptime Environment.isDebug) {
        const haystack_char = haystack[result];
        var found = false;
        for (chars) |c| {
            if (c == haystack_char) {
                found = true;
                break;
            }
        }
        if (!found) {
            @panic("Invalid character found in indexOfAnyChar");
        }
    }

    return result;
}

fn highway_copy_u16_to_u8(
    input: [*]align(1) const u16,
    count: usize,
    output: [*]u8,
) void {
    for (input[0..count], 0..) |value, i| {
        output[i] = @truncate(value);
    }
}

pub fn copyU16ToU8(input: []align(1) const u16, output: []u8) void {
    highway_copy_u16_to_u8(input.ptr, input.len, output.ptr);
}

/// Apply a WebSocket mask to data using SIMD acceleration
/// If skip_mask is true, data is copied without masking
pub fn fillWithSkipMask(mask: [4]u8, output: []u8, input: []const u8, skip_mask: bool) void {
    if (input.len == 0) {
        return;
    }

    highway_fill_with_skip_mask(
        &mask,
        4,
        output.ptr,
        input.ptr,
        input.len,
        skip_mask,
    );
}

/// Useful for single-line JavaScript comments.
/// Scans for:
/// - `\n`, `\r`
/// - Non-ASCII characters (which implicitly include `\n`, `\r`)
/// - `#`
/// - `@`
pub fn indexOfNewlineOrNonASCIIOrHashOrAt(haystack: string) ?usize {
    if (haystack.len == 0) {
        return null;
    }

    const result = highway_index_of_newline_or_non_ascii_or_hash_or_at(
        haystack.ptr,
        haystack.len,
    );

    if (result == haystack.len) {
        return null;
    }

    return result;
}

/// Scans for:
/// - " "
/// - Non-ASCII characters (which implicitly include `\n`, `\r`, '\t')
pub fn indexOfSpaceOrNewlineOrNonASCII(haystack: string) ?usize {
    if (haystack.len == 0) {
        return null;
    }

    const result = highway_index_of_space_or_newline_or_non_ascii(
        haystack.ptr,
        haystack.len,
    );

    if (result == haystack.len) {
        return null;
    }

    return result;
}

const string = []const u8;

const std = @import("std");

const bun = @import("bun");
const Environment = bun.Environment;
const strings = bun.strings;
