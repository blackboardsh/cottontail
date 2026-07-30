const std = @import("std");

const allocator = std.heap.c_allocator;

const backward_slash: u16 = '\\';
const colon: u16 = ':';
const dot: u16 = '.';
const forward_slash: u16 = '/';
const question_mark: u16 = '?';

const dot_path = [_]u16{dot};
const dot_slash_path = [_]u16{ dot, forward_slash };
const posix_root = [_]u16{forward_slash};
const windows_root = [_]u16{backward_slash};

pub const Slice = extern struct {
    ptr: ?[*]const u16,
    len: usize,
};

pub const Result = extern struct {
    ptr: ?[*]const u16,
    len: usize,
};

fn asSlice(value: Slice) []const u16 {
    if (value.len == 0) return &.{};
    return value.ptr.?[0..value.len];
}

fn isSeparator(value: u16, windows: bool) bool {
    return value == forward_slash or (windows and value == backward_slash);
}

fn isWindowsDeviceRoot(value: u16) bool {
    return (value >= 'A' and value <= 'Z') or (value >= 'a' and value <= 'z');
}

// Adapted from Bun 1.3.14's Zig port of Node's normalizeString helper.
fn normalizeString(
    path: []const u16,
    allow_above_root: bool,
    separator: u16,
    windows: bool,
    buffer: []u16,
) []u16 {
    var buffer_size: usize = 0;
    var last_segment_length: usize = 0;
    var last_slash: ?usize = null;
    var dots: ?usize = 0;
    var value: u16 = 0;

    var index: usize = 0;
    while (index <= path.len) : (index += 1) {
        if (index < path.len) {
            value = path[index];
        } else if (isSeparator(value, windows)) {
            break;
        } else {
            value = forward_slash;
        }

        if (isSeparator(value, windows)) {
            if ((last_slash == null and index == 0) or
                (last_slash != null and index > 0 and last_slash.? == index - 1) or
                (dots != null and dots.? == 1))
            {
                // Repeated separators and single-dot components are omitted.
            } else if (dots != null and dots.? == 2) {
                if (buffer_size < 2 or
                    last_segment_length != 2 or
                    buffer[buffer_size - 1] != dot or
                    buffer[buffer_size - 2] != dot)
                {
                    if (buffer_size > 2) {
                        const last_separator = std.mem.lastIndexOfScalar(
                            u16,
                            buffer[0..buffer_size],
                            separator,
                        );
                        if (last_separator) |position| {
                            buffer_size = position;
                            const previous_separator = std.mem.lastIndexOfScalar(
                                u16,
                                buffer[0..buffer_size],
                                separator,
                            );
                            last_segment_length = if (previous_separator) |previous|
                                buffer_size - 1 - previous
                            else
                                buffer_size;
                        } else {
                            buffer_size = 0;
                            last_segment_length = 0;
                        }
                        last_slash = index;
                        dots = 0;
                        continue;
                    } else if (buffer_size != 0) {
                        buffer_size = 0;
                        last_segment_length = 0;
                        last_slash = index;
                        dots = 0;
                        continue;
                    }
                }
                if (allow_above_root) {
                    if (buffer_size > 0) {
                        buffer[buffer_size] = separator;
                        buffer[buffer_size + 1] = dot;
                        buffer[buffer_size + 2] = dot;
                        buffer_size += 3;
                    } else {
                        buffer[0] = dot;
                        buffer[1] = dot;
                        buffer_size = 2;
                    }
                    last_segment_length = 2;
                }
            } else {
                if (buffer_size > 0) {
                    buffer[buffer_size] = separator;
                    buffer_size += 1;
                }
                const slice_start = if (last_slash) |position| position + 1 else 0;
                const component = path[slice_start..index];
                @memcpy(buffer[buffer_size..][0..component.len], component);
                buffer_size += component.len;
                const subtract = if (last_slash) |position| position + 1 else 2;
                last_segment_length = if (index >= subtract) index - subtract else 0;
            }
            last_slash = index;
            dots = 0;
        } else if (value == dot and dots != null) {
            dots = dots.? + 1;
        } else {
            dots = null;
        }
    }

    return buffer[0..buffer_size];
}

fn normalizePosix(path: []const u16, buffer: []u16) []const u16 {
    if (path.len == 0) return &dot_path;

    const is_absolute = path[0] == forward_slash;
    const trailing_separator = path[path.len - 1] == forward_slash;
    var normalized = normalizeString(path, !is_absolute, forward_slash, false, buffer);

    if (normalized.len == 0) {
        if (is_absolute) return &posix_root;
        return if (trailing_separator) &dot_slash_path else &dot_path;
    }

    if (trailing_separator) {
        buffer[normalized.len] = forward_slash;
        normalized = buffer[0 .. normalized.len + 1];
    }

    if (is_absolute) {
        @memmove(buffer[1..][0..normalized.len], normalized);
        buffer[0] = forward_slash;
        normalized = buffer[0 .. normalized.len + 1];
    }
    return normalized;
}

// Adapted from Bun 1.3.14's Zig port of Node's win32.normalize.
fn normalizeWindows(path: []const u16, buffer: []u16) []const u16 {
    if (path.len == 0) return &dot_path;
    if (path.len == 1) {
        return if (isSeparator(path[0], true)) &windows_root else path;
    }

    var root_end: usize = 0;
    var device: ?[]const u16 = null;
    var is_absolute = false;
    var buffer_size: usize = 0;

    if (isSeparator(path[0], true)) {
        is_absolute = true;
        if (isSeparator(path[1], true)) {
            var index: usize = 2;
            const first_start = index;
            while (index < path.len and !isSeparator(path[index], true)) index += 1;
            if (index < path.len and index != first_start) {
                const first_part = path[first_start..index];
                const separator_start = index;
                while (index < path.len and isSeparator(path[index], true)) index += 1;
                if (index < path.len and index != separator_start) {
                    const second_start = index;
                    while (index < path.len and !isSeparator(path[index], true)) index += 1;
                    if (first_part.len == 1 and
                        (first_part[0] == dot or first_part[0] == question_mark))
                    {
                        buffer[0] = backward_slash;
                        buffer[1] = backward_slash;
                        buffer[2] = first_part[0];
                        device = buffer[0..3];
                        root_end = 4;
                    } else if (index == path.len) {
                        buffer[0] = backward_slash;
                        buffer[1] = backward_slash;
                        @memcpy(buffer[2..][0..first_part.len], first_part);
                        buffer_size = 2 + first_part.len;
                        buffer[buffer_size] = backward_slash;
                        buffer_size += 1;
                        const second_part = path[second_start..];
                        @memcpy(buffer[buffer_size..][0..second_part.len], second_part);
                        buffer_size += second_part.len;
                        buffer[buffer_size] = backward_slash;
                        return buffer[0 .. buffer_size + 1];
                    } else if (index != second_start) {
                        buffer[0] = backward_slash;
                        buffer[1] = backward_slash;
                        @memcpy(buffer[2..][0..first_part.len], first_part);
                        buffer_size = 2 + first_part.len;
                        buffer[buffer_size] = backward_slash;
                        buffer_size += 1;
                        const second_part = path[second_start..index];
                        @memcpy(buffer[buffer_size..][0..second_part.len], second_part);
                        buffer_size += second_part.len;
                        device = buffer[0..buffer_size];
                        root_end = index;
                    }
                }
            }
        } else {
            root_end = 1;
        }
    } else if (isWindowsDeviceRoot(path[0]) and path[1] == colon) {
        buffer[0] = path[0];
        buffer[1] = colon;
        device = buffer[0..2];
        root_end = 2;
        if (path.len > 2 and isSeparator(path[2], true)) {
            is_absolute = true;
            root_end = 3;
        }
    }

    var buffer_offset = (if (device) |value| value.len else 0) + @intFromBool(is_absolute);
    var tail_length = if (root_end < path.len)
        normalizeString(
            path[root_end..],
            !is_absolute,
            backward_slash,
            true,
            buffer[buffer_offset..],
        ).len
    else
        0;

    if (tail_length == 0 and !is_absolute) {
        buffer[buffer_offset] = dot;
        tail_length = 1;
    }
    if (tail_length > 0 and isSeparator(path[path.len - 1], true)) {
        buffer[buffer_offset + tail_length] = backward_slash;
        tail_length += 1;
    }

    buffer_size = buffer_offset + tail_length;
    if (is_absolute) {
        buffer_offset -= 1;
        buffer[buffer_offset] = backward_slash;
    }
    return buffer[0..buffer_size];
}

fn storeResult(value: []const u16, output: *Result) !void {
    output.* = .{ .ptr = null, .len = 0 };
    if (value.len == 0) return;
    const copy = try allocator.dupe(u16, value);
    output.* = .{ .ptr = copy.ptr, .len = copy.len };
}

pub export fn ct_path_core_normalize(
    windows: u8,
    input_value: Slice,
    output: *Result,
) c_int {
    const input = asSlice(input_value);
    const buffer = allocator.alloc(u16, input.len + 16) catch return -1;
    defer allocator.free(buffer);
    const result = if (windows != 0)
        normalizeWindows(input, buffer)
    else
        normalizePosix(input, buffer);
    storeResult(result, output) catch return -1;
    return 0;
}

pub export fn ct_path_core_free(pointer: ?*anyopaque, len: usize) void {
    if (pointer == null or len == 0) return;
    const values: [*]u16 = @ptrCast(@alignCast(pointer.?));
    allocator.free(values[0..len]);
}
