const std = @import("std");
const builtin = @import("builtin");

const allocator = std.heap.c_allocator;
const windows_extensions = [_][]const u8{ ".exe", ".cmd", ".bat" };

pub const Slice = extern struct {
    ptr: ?[*]const u8,
    len: usize,
};

pub const Result = extern struct {
    ptr: ?[*]const u8,
    len: usize,
};

fn asSlice(value: Slice) []const u8 {
    if (value.len == 0) return &.{};
    return value.ptr.?[0..value.len];
}

fn hasWindowsExecutableExtension(path: []const u8) bool {
    for (windows_extensions) |extension| {
        if (std.ascii.endsWithIgnoreCase(path, extension)) return true;
    }
    return false;
}

fn isPathSeparator(byte: u8) bool {
    return byte == '/' or byte == '\\';
}

fn rootCharacterEqual(left: u8, right: u8) bool {
    if (isPathSeparator(left) and isPathSeparator(right)) return true;
    return std.ascii.toLower(left) == std.ascii.toLower(right);
}

fn hasSystemRootPrefix(path: []const u8, system_root: []const u8) bool {
    if (system_root.len == 0 or path.len < system_root.len) return false;
    for (path[0..system_root.len], system_root) |path_byte, root_byte| {
        if (!rootCharacterEqual(path_byte, root_byte)) return false;
    }
    return path.len == system_root.len or isPathSeparator(path[system_root.len]);
}

fn canonicalizeWindowsSearchDirectory(
    arena: std.mem.Allocator,
    path: []const u8,
    system_root: []const u8,
    canonical_system_root: []const u8,
) ![]const u8 {
    if (comptime builtin.os.tag != .windows) return path;
    if (canonical_system_root.len == 0 or !hasSystemRootPrefix(path, system_root)) return path;
    return try std.mem.concat(arena, u8, &.{ canonical_system_root, path[system_root.len..] });
}

fn joinNormalized(arena: std.mem.Allocator, parts: []const []const u8) ![]const u8 {
    const joined = try std.fs.path.join(arena, parts);
    return try std.fs.path.resolve(arena, &.{joined});
}

fn effectiveCwd(
    arena: std.mem.Allocator,
    io: std.Io,
    cwd: []const u8,
) ![]const u8 {
    if (std.fs.path.isAbsolute(cwd)) return cwd;
    const process_cwd = try std.Io.Dir.cwd().realPathFileAlloc(io, ".", arena);
    return try std.fs.path.resolve(arena, &.{ process_cwd, cwd });
}

fn isExecutableFile(io: std.Io, path: []const u8) bool {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = true }) catch return false;
    if (stat.kind != .file) return false;
    if (comptime builtin.os.tag == .windows) return true;
    return (stat.permissions.toMode() & 0o111) != 0;
}

fn findCandidate(
    arena: std.mem.Allocator,
    io: std.Io,
    resolved_base: []const u8,
    displayed_base: []const u8,
) !?[]const u8 {
    if (comptime builtin.os.tag == .windows) {
        if (!hasWindowsExecutableExtension(resolved_base)) {
            for (windows_extensions) |extension| {
                const resolved = try std.mem.concat(arena, u8, &.{ resolved_base, extension });
                if (!isExecutableFile(io, resolved)) continue;
                return try std.mem.concat(arena, u8, &.{ displayed_base, extension });
            }
            return null;
        }
    }

    return if (isExecutableFile(io, resolved_base)) displayed_base else null;
}

fn findOnPath(
    arena: std.mem.Allocator,
    io: std.Io,
    path: []const u8,
    cwd: []const u8,
    bin: []const u8,
    system_root: []const u8,
    canonical_system_root: []const u8,
) !?[]const u8 {
    const delimiter: u8 = if (builtin.os.tag == .windows) ';' else ':';
    var resolved_cwd: ?[]const u8 = null;
    var path_iterator = std.mem.tokenizeScalar(u8, path, delimiter);

    while (path_iterator.next()) |segment| {
        const search_directory = try canonicalizeWindowsSearchDirectory(
            arena,
            segment,
            system_root,
            canonical_system_root,
        );
        const displayed_base = try joinNormalized(arena, &.{ search_directory, bin });
        const resolved_base = if (std.fs.path.isAbsolute(search_directory))
            displayed_base
        else blk: {
            if (resolved_cwd == null) resolved_cwd = try effectiveCwd(arena, io, cwd);
            break :blk try std.fs.path.resolve(arena, &.{ resolved_cwd.?, search_directory, bin });
        };

        if (try findCandidate(arena, io, resolved_base, displayed_base)) |candidate| {
            return candidate;
        }
    }
    return null;
}

fn storeResult(value: []const u8, output: *Result) !void {
    const copy = try allocator.dupe(u8, value);
    output.* = .{ .ptr = copy.ptr, .len = copy.len };
}

pub fn findOnPathWithIo(
    io: std.Io,
    path_value: Slice,
    cwd_value: Slice,
    bin_value: Slice,
    system_root_value: Slice,
    canonical_system_root_value: Slice,
    output: *Result,
) c_int {
    output.* = .{ .ptr = null, .len = 0 };
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();

    const found = findOnPath(
        arena_state.allocator(),
        io,
        asSlice(path_value),
        asSlice(cwd_value),
        asSlice(bin_value),
        asSlice(system_root_value),
        asSlice(canonical_system_root_value),
    ) catch return -1;
    if (found) |value| storeResult(value, output) catch return -1;
    return 0;
}

pub fn freeResult(pointer: ?*anyopaque, len: usize) void {
    if (pointer == null or len == 0) return;
    const bytes: [*]u8 = @ptrCast(pointer.?);
    allocator.free(bytes[0..len]);
}

test "native which normalizes relative display paths" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const value = try joinNormalized(arena_state.allocator(), &.{ "tools", ".", "bin" });
    try std.testing.expectEqualStrings(
        if (builtin.os.tag == .windows) "tools\\bin" else "tools/bin",
        value,
    );
}

test "native which SystemRoot prefix matching is case and separator insensitive" {
    try std.testing.expect(hasSystemRootPrefix("C:/WINDOWS/system32", "c:\\Windows"));
    try std.testing.expect(!hasSystemRootPrefix("C:/WindowsOld/system32", "C:\\Windows"));
}

test "native which core is analyzed for the target" {
    _ = &findOnPathWithIo;
    _ = &freeResult;
}
