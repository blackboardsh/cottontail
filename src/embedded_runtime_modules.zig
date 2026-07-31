const std = @import("std");

const blob = @embedFile("runtime_modules_blob");

pub const virtual_directory_name = ".cottontail-embedded-runtime";

pub const Entry = struct {
    path: []const u8,
    contents: []const u8,
};

pub const Iterator = struct {
    cursor: usize = 8,
    remaining: u32,

    pub fn init() !Iterator {
        if (blob.len < 8 or !std.mem.eql(u8, blob[0..4], "CTRM")) return error.InvalidRuntimeModuleBlob;
        return .{ .remaining = readU32(blob, 4) };
    }

    pub fn next(self: *Iterator) !?Entry {
        if (self.remaining == 0) return null;
        if (self.cursor + 8 > blob.len) return error.InvalidRuntimeModuleBlob;

        const path_len = readU32(blob, self.cursor);
        const contents_len = readU32(blob, self.cursor + 4);
        self.cursor += 8;

        const path_end = std.math.add(usize, self.cursor, path_len) catch return error.InvalidRuntimeModuleBlob;
        const contents_end = std.math.add(usize, path_end, contents_len) catch return error.InvalidRuntimeModuleBlob;
        if (contents_end > blob.len) return error.InvalidRuntimeModuleBlob;

        const entry = Entry{
            .path = blob[self.cursor..path_end],
            .contents = blob[path_end..contents_end],
        };
        self.cursor = contents_end;
        self.remaining -= 1;
        return entry;
    }
};

pub fn sourceForPath(path: []const u8) !?[]const u8 {
    const relative_path = relativePath(path);
    var iterator = try Iterator.init();
    while (try iterator.next()) |entry| {
        if (normalizedPathEql(relative_path, entry.path)) return entry.contents;
    }
    return null;
}

pub export fn ct_embedded_runtime_module_source(
    path_ptr: [*]const u8,
    path_len: usize,
    source_out: *?[*]const u8,
    source_len_out: *usize,
) c_int {
    source_out.* = null;
    source_len_out.* = 0;
    const source = (sourceForPath(path_ptr[0..path_len]) catch return -1) orelse return 0;
    source_out.* = source.ptr;
    source_len_out.* = source.len;
    return 1;
}

pub fn virtualPath(allocator: std.mem.Allocator, root: []const u8, relative_path: []const u8) ![]u8 {
    const path = try std.fs.path.join(allocator, &.{ root, virtual_directory_name, relative_path });
    if (@import("builtin").os.tag == .windows) {
        for (path) |*byte| {
            if (byte.* == '/') byte.* = '\\';
        }
    }
    return path;
}

fn readU32(bytes: []const u8, offset: usize) u32 {
    return std.mem.readInt(u32, bytes[offset..][0..4], .little);
}

fn relativePath(path: []const u8) []const u8 {
    if (std.mem.indexOf(u8, path, virtual_directory_name)) |index| {
        var start = index + virtual_directory_name.len;
        while (start < path.len and (path[start] == '/' or path[start] == '\\')) : (start += 1) {}
        return path[start..];
    }
    var start: usize = 0;
    while (start < path.len and (path[start] == '/' or path[start] == '\\')) : (start += 1) {}
    return path[start..];
}

fn normalizedPathEql(left: []const u8, right: []const u8) bool {
    if (left.len != right.len) return false;
    for (left, right) |left_byte, right_byte| {
        const normalized_left = if (left_byte == '\\') '/' else left_byte;
        const normalized_right = if (right_byte == '\\') '/' else right_byte;
        if (normalized_left != normalized_right) return false;
    }
    return true;
}

test "embedded runtime source lookup accepts relative and virtual paths" {
    var iterator = try Iterator.init();
    const first = (try iterator.next()).?;
    try std.testing.expectEqualStrings(first.contents, (try sourceForPath(first.path)).?);

    const virtual = try std.fmt.allocPrint(
        std.testing.allocator,
        "/tmp/{s}/{s}",
        .{ virtual_directory_name, first.path },
    );
    defer std.testing.allocator.free(virtual);
    try std.testing.expectEqualStrings(first.contents, (try sourceForPath(virtual)).?);
}
