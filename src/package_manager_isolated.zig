const std = @import("std");
const Lockfile = @import("package_manager_lockfile.zig");

pub const Linker = enum {
    hoisted,
    isolated,

    pub fn parse(value: []const u8) ?Linker {
        if (std.mem.eql(u8, value, "hoisted")) return .hoisted;
        if (std.mem.eql(u8, value, "isolated")) return .isolated;
        return null;
    }
};

pub const Placement = struct {
    store_key: []const u8,
    modules_dir: []const u8,
    package_dir: []const u8,
};

pub fn placement(
    allocator: std.mem.Allocator,
    root_dir: []const u8,
    name: []const u8,
    version: []const u8,
    kind: Lockfile.Kind,
    source: []const u8,
) !Placement {
    const store_key = try storeKey(allocator, name, version, kind, source);
    const modules_dir = try std.fs.path.join(allocator, &.{ root_dir, "node_modules", ".bun", store_key, "node_modules" });
    return .{
        .store_key = store_key,
        .modules_dir = modules_dir,
        .package_dir = try std.fs.path.join(allocator, &.{ modules_dir, name }),
    };
}

pub fn storeKey(
    allocator: std.mem.Allocator,
    name: []const u8,
    version: []const u8,
    kind: Lockfile.Kind,
    source: []const u8,
) ![]const u8 {
    const escaped_name = try escapeStoreComponent(allocator, name);
    return switch (kind) {
        .npm => std.fmt.allocPrint(allocator, "{s}@{s}", .{ escaped_name, version }),
        .folder => std.fmt.allocPrint(allocator, "{s}@file+{s}", .{
            escaped_name,
            try escapeStoreComponent(allocator, normalizedLocalSource(source)),
        }),
        .symlink => std.fmt.allocPrint(allocator, "{s}@link+{s}", .{
            escaped_name,
            try escapeStoreComponent(allocator, normalizedLocalSource(source)),
        }),
        .workspace => std.fmt.allocPrint(allocator, "{s}@workspace+{s}", .{
            escaped_name,
            try escapeStoreComponent(allocator, source),
        }),
        .local_tarball => std.fmt.allocPrint(allocator, "{s}@file+{s}", .{
            escaped_name,
            try escapeStoreComponent(allocator, normalizedLocalSource(source)),
        }),
        .remote_tarball, .git, .github => std.fmt.allocPrint(allocator, "{s}@{s}+{x}", .{
            escaped_name,
            @tagName(kind),
            std.hash.Wyhash.hash(0, source),
        }),
        .root => std.fmt.allocPrint(allocator, "{s}@root", .{escaped_name}),
    };
}

fn normalizedLocalSource(source: []const u8) []const u8 {
    if (std.mem.startsWith(u8, source, "file:")) return source["file:".len..];
    if (std.mem.startsWith(u8, source, "link:")) return source["link:".len..];
    if (std.mem.startsWith(u8, source, "./")) return source[2..];
    return source;
}

fn escapeStoreComponent(allocator: std.mem.Allocator, value: []const u8) ![]const u8 {
    const escaped = try allocator.dupe(u8, value);
    for (escaped) |*byte| switch (byte.*) {
        '/', '\\', ':' => byte.* = '+',
        else => {},
    };
    return escaped;
}

test "isolated store paths match Bun package layout" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const plain = try placement(allocator, "/project", "no-deps", "1.0.0", .npm, "");
    try std.testing.expectEqualStrings("no-deps@1.0.0", plain.store_key);
    try std.testing.expectEqualStrings(
        "/project/node_modules/.bun/no-deps@1.0.0/node_modules/no-deps",
        plain.package_dir,
    );

    const scoped = try placement(allocator, "/project", "@types/is-number", "1.0.0", .npm, "");
    try std.testing.expectEqualStrings("@types+is-number@1.0.0", scoped.store_key);
    try std.testing.expectEqualStrings(
        "/project/node_modules/.bun/@types+is-number@1.0.0/node_modules/@types/is-number",
        scoped.package_dir,
    );

    const folder = try placement(allocator, "/project", "folder-dep", "1.0.0", .folder, "./pkg-1");
    try std.testing.expectEqualStrings("folder-dep@file+pkg-1", folder.store_key);

    const root = try placement(allocator, "/project", "root-file-dep", "0.0.0", .root, "");
    try std.testing.expectEqualStrings("root-file-dep@root", root.store_key);
}
