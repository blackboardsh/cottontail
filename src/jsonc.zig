const std = @import("std");

pub fn normalize(allocator: std.mem.Allocator, source: []const u8) ![]const u8 {
    var without_comments = std.array_list.Managed(u8).init(allocator);
    try without_comments.ensureTotalCapacity(source.len);

    const State = enum { normal, string, line_comment, block_comment };
    var state: State = .normal;
    var escaped = false;
    var index: usize = 0;
    while (index < source.len) : (index += 1) {
        const byte = source[index];
        switch (state) {
            .normal => {
                if (byte == '"') {
                    state = .string;
                    try without_comments.append(byte);
                } else if (byte == '/' and index + 1 < source.len and source[index + 1] == '/') {
                    state = .line_comment;
                    try without_comments.appendSlice("  ");
                    index += 1;
                } else if (byte == '/' and index + 1 < source.len and source[index + 1] == '*') {
                    state = .block_comment;
                    try without_comments.appendSlice("  ");
                    index += 1;
                } else {
                    try without_comments.append(byte);
                }
            },
            .string => {
                try without_comments.append(byte);
                if (escaped) {
                    escaped = false;
                } else if (byte == '\\') {
                    escaped = true;
                } else if (byte == '"') {
                    state = .normal;
                }
            },
            .line_comment => {
                if (byte == '\n' or byte == '\r') {
                    state = .normal;
                    try without_comments.append(byte);
                } else {
                    try without_comments.append(' ');
                }
            },
            .block_comment => {
                if (byte == '*' and index + 1 < source.len and source[index + 1] == '/') {
                    state = .normal;
                    try without_comments.appendSlice("  ");
                    index += 1;
                } else {
                    try without_comments.append(if (byte == '\n' or byte == '\r') byte else ' ');
                }
            },
        }
    }
    if (state == .string or state == .block_comment) return error.InvalidJsonc;

    const normalized = without_comments.items;
    state = .normal;
    escaped = false;
    index = 0;
    while (index < normalized.len) : (index += 1) {
        const byte = normalized[index];
        if (state == .string) {
            if (escaped) {
                escaped = false;
            } else if (byte == '\\') {
                escaped = true;
            } else if (byte == '"') {
                state = .normal;
            }
            continue;
        }
        if (byte == '"') {
            state = .string;
            continue;
        }
        if (byte != ',') continue;
        var next = index + 1;
        while (next < normalized.len and std.ascii.isWhitespace(normalized[next])) : (next += 1) {}
        if (next < normalized.len and (normalized[next] == '}' or normalized[next] == ']')) normalized[index] = ' ';
    }
    return normalized;
}

test "normalize removes comments and trailing commas without changing strings" {
    const source =
        \\{
        \\  // comment
        \\  "url": "https://example.test/a//b",
        \\  "values": [1, 2,],
        \\}
    ;
    const normalized = try normalize(std.testing.allocator, source);
    defer std.testing.allocator.free(normalized);

    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, normalized, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings(
        "https://example.test/a//b",
        parsed.value.object.get("url").?.string,
    );
    try std.testing.expectEqual(@as(usize, 2), parsed.value.object.get("values").?.array.items.len);
}
