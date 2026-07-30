const std = @import("std");

extern "c" fn memcmp(left: *const anyopaque, right: *const anyopaque, length: usize) c_int;

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

pub export fn ct_buffer_compare(
    left_pointer: ?[*]const u8,
    left_length: usize,
    right_pointer: ?[*]const u8,
    right_length: usize,
) c_int {
    const left = constBytes(left_pointer, left_length) orelse return 0;
    const right = constBytes(right_pointer, right_length) orelse return 0;
    const common_length = @min(left.len, right.len);
    if (common_length > 0 and left.ptr != right.ptr) {
        const result = memcmp(left.ptr, right.ptr, common_length);
        if (result < 0) return -1;
        if (result > 0) return 1;
    }
    return if (left.len < right.len) -1 else if (left.len > right.len) 1 else 0;
}

pub export fn ct_buffer_index_of(
    haystack_pointer: ?[*]const u8,
    haystack_length: usize,
    needle_pointer: ?[*]const u8,
    needle_length: usize,
    offset: usize,
    reverse: u8,
) isize {
    const haystack = constBytes(haystack_pointer, haystack_length) orelse return -1;
    const needle = constBytes(needle_pointer, needle_length) orelse return -1;
    if (needle.len == 0) return @intCast(@min(offset, haystack.len));
    if (needle.len > haystack.len) return -1;

    const maximum = haystack.len - needle.len;
    if (reverse == 0) {
        if (offset > maximum) return -1;
        const found = std.mem.findPos(u8, haystack, offset, needle) orelse return -1;
        return @intCast(found);
    }

    const candidate = @min(offset, maximum);
    const search_end = candidate + needle.len;
    const found = std.mem.findLast(u8, haystack[0..search_end], needle) orelse return -1;
    return @intCast(found);
}

fn rangesOverlap(left: []const u8, right: []const u8) bool {
    if (left.len == 0 or right.len == 0) return false;
    const left_address = @intFromPtr(left.ptr);
    const right_address = @intFromPtr(right.ptr);
    if (left_address <= right_address) return right_address - left_address < left.len;
    return left_address - right_address < right.len;
}

pub export fn ct_buffer_fill_pattern(
    target_pointer: ?[*]u8,
    target_length: usize,
    pattern_pointer: ?[*]const u8,
    pattern_length: usize,
) c_int {
    const target = mutableBytes(target_pointer, target_length) orelse return -1;
    const original_pattern = constBytes(pattern_pointer, pattern_length) orelse return -1;
    if (target.len == 0) return 0;
    if (original_pattern.len == 0) return -1;

    var owned_pattern: ?[]u8 = null;
    defer if (owned_pattern) |bytes| std.heap.c_allocator.free(bytes);

    var pattern = original_pattern;
    if (rangesOverlap(target, original_pattern)) {
        const copy = std.heap.c_allocator.alloc(u8, original_pattern.len) catch return -2;
        @memcpy(copy, original_pattern);
        owned_pattern = copy;
        pattern = copy;
    }

    const initial_length = @min(pattern.len, target.len);
    @memcpy(target[0..initial_length], pattern[0..initial_length]);
    var filled = initial_length;
    while (filled < target.len) {
        const copy_length = @min(filled, target.len - filled);
        @memcpy(target[filled..][0..copy_length], target[0..copy_length]);
        filled += copy_length;
    }
    return 0;
}

test "buffer compare is lexicographic" {
    const short = "cottontail";
    const equal = "cottontail";
    const greater = "cottontb";
    try std.testing.expectEqual(@as(c_int, 0), ct_buffer_compare(short.ptr, short.len, equal.ptr, equal.len));
    try std.testing.expectEqual(@as(c_int, -1), ct_buffer_compare(short.ptr, short.len, greater.ptr, greater.len));
    try std.testing.expectEqual(@as(c_int, 1), ct_buffer_compare(greater.ptr, greater.len, short.ptr, short.len));
    try std.testing.expectEqual(@as(c_int, -1), ct_buffer_compare("cot".ptr, 3, short.ptr, short.len));
}

test "buffer search handles both directions" {
    const haystack = "xxneedlexxneedlex";
    const needle = "needle";
    try std.testing.expectEqual(@as(isize, 2), ct_buffer_index_of(
        haystack.ptr,
        haystack.len,
        needle.ptr,
        needle.len,
        0,
        0,
    ));
    try std.testing.expectEqual(@as(isize, 10), ct_buffer_index_of(
        haystack.ptr,
        haystack.len,
        needle.ptr,
        needle.len,
        haystack.len - needle.len,
        1,
    ));
}

test "buffer fill repeats patterns and snapshots overlapping inputs" {
    var bytes = [_]u8{ 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l' };
    try std.testing.expectEqual(@as(c_int, 0), ct_buffer_fill_pattern(
        &bytes,
        bytes.len,
        bytes[2..5].ptr,
        3,
    ));
    try std.testing.expectEqualSlices(u8, "cdecdecdecde", &bytes);

    var output: [10]u8 = undefined;
    try std.testing.expectEqual(@as(c_int, 0), ct_buffer_fill_pattern(
        &output,
        output.len,
        "ab".ptr,
        2,
    ));
    try std.testing.expectEqualSlices(u8, "ababababab", &output);
}
