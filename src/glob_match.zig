const compiler = @import("cottontail_compiler");

fn bytes(pointer: ?[*]const u8, length: usize) ?[]const u8 {
    if (length == 0) return &.{};
    const value = pointer orelse return null;
    return value[0..length];
}

pub export fn ct_glob_match(
    pattern_pointer: ?[*]const u8,
    pattern_length: usize,
    path_pointer: ?[*]const u8,
    path_length: usize,
) bool {
    const pattern = bytes(pattern_pointer, pattern_length) orelse return false;
    const path = bytes(path_pointer, path_length) orelse return false;
    return compiler.glob.match(pattern, path).matches();
}

test "native glob matcher covers Bun pattern grammar" {
    const cases = [_]struct {
        pattern: []const u8,
        path: []const u8,
        expected: bool,
    }{
        .{ .pattern = "*.ts", .path = "index.ts", .expected = true },
        .{ .pattern = "*.ts", .path = "src/index.ts", .expected = false },
        .{ .pattern = "src/**/*.ts", .path = "src/index.ts", .expected = true },
        .{ .pattern = "src/**/*.ts", .path = "src/lib/index.ts", .expected = true },
        .{ .pattern = "index.{ts,tsx,js}", .path = "index.tsx", .expected = true },
        .{ .pattern = "F{ë,£,a}", .path = "F£", .expected = true },
        .{ .pattern = "foo/**", .path = "foo", .expected = false },
        .{ .pattern = "foo/**", .path = "foo/bar/baz", .expected = true },
        .{ .pattern = "!**/*.md", .path = "src/index.js", .expected = true },
        .{ .pattern = "!**/*.md", .path = "src/readme.md", .expected = false },
    };

    for (cases) |case| {
        try std.testing.expectEqual(
            case.expected,
            ct_glob_match(case.pattern.ptr, case.pattern.len, case.path.ptr, case.path.len),
        );
    }
}

const std = @import("std");
