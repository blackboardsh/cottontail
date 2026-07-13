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
