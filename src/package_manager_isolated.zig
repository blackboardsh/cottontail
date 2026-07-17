const std = @import("std");
const compiler = @import("cottontail_compiler");
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

pub const PeerResolution = struct {
    name: []const u8,
    resolution: []const u8,
};

pub const PeerContext = struct {
    hash: u64 = 0,

    pub fn init(allocator: std.mem.Allocator, resolutions: []const PeerResolution) !PeerContext {
        if (resolutions.len == 0) return .{};

        const sorted = try allocator.dupe(PeerResolution, resolutions);
        defer allocator.free(sorted);
        std.sort.pdq(PeerResolution, sorted, {}, struct {
            fn lessThan(_: void, left: PeerResolution, right: PeerResolution) bool {
                const name_order = std.mem.order(u8, left.name, right.name);
                if (name_order != .eq) return name_order == .lt;
                return std.mem.order(u8, left.resolution, right.resolution) == .lt;
            }
        }.lessThan);

        // Bun keys an isolated entry by its resolved peer package set, not by
        // the peer ranges declared in package.json. Aliases resolving to the
        // same package are intentionally deduplicated here as they are in
        // Store.Node.TransitivePeer.
        var hasher = compiler.Wyhash11.init(0);
        var previous: ?PeerResolution = null;
        for (sorted) |peer| {
            if (previous) |seen| {
                if (std.mem.eql(u8, seen.name, peer.name) and
                    std.mem.eql(u8, seen.resolution, peer.resolution)) continue;
            }
            hasher.update(peer.name);
            hasher.update(peer.resolution);
            previous = peer;
        }
        return .{ .hash = hasher.final() };
    }
};

pub const HoistPattern = struct {
    patterns: []const Pattern,
    behavior: Behavior,

    const Pattern = struct {
        text: []const u8,
        exclude: bool,
    };

    const Behavior = enum {
        all_include,
        all_exclude,
        mixed,
    };

    pub fn init(allocator: std.mem.Allocator, values: []const []const u8) !HoistPattern {
        const patterns = try allocator.alloc(Pattern, values.len);
        var has_include = false;
        var has_exclude = false;
        for (values, patterns) |raw, *pattern| {
            var value = std.mem.trim(u8, raw, " \t\r\n");
            const exclude = value.len > 0 and value[0] == '!';
            if (exclude) value = value[1..];
            pattern.* = .{
                .text = try allocator.dupe(u8, value),
                .exclude = exclude,
            };
            has_exclude = has_exclude or exclude;
            has_include = has_include or !exclude;
        }
        return .{
            .patterns = patterns,
            .behavior = if (!has_include)
                .all_exclude
            else if (!has_exclude)
                .all_include
            else
                .mixed,
        };
    }

    pub fn isMatch(pattern: *const HoistPattern, name: []const u8) bool {
        if (pattern.patterns.len == 0) return false;
        return switch (pattern.behavior) {
            .all_include => blk: {
                for (pattern.patterns) |entry| {
                    if (wildcardMatch(entry.text, name)) break :blk true;
                }
                break :blk false;
            },
            .all_exclude => blk: {
                for (pattern.patterns) |entry| {
                    if (wildcardMatch(entry.text, name)) break :blk false;
                }
                break :blk true;
            },
            .mixed => blk: {
                var matched = false;
                for (pattern.patterns) |entry| {
                    if (wildcardMatch(entry.text, name)) matched = !entry.exclude;
                }
                break :blk matched;
            },
        };
    }
};

pub fn placement(
    allocator: std.mem.Allocator,
    root_dir: []const u8,
    name: []const u8,
    version: []const u8,
    kind: Lockfile.Kind,
    source: []const u8,
) !Placement {
    return placementWithPeerContext(allocator, root_dir, name, version, kind, source, .{});
}

pub fn placementWithPeerContext(
    allocator: std.mem.Allocator,
    root_dir: []const u8,
    name: []const u8,
    version: []const u8,
    kind: Lockfile.Kind,
    source: []const u8,
    peer_context: PeerContext,
) !Placement {
    const store_key = try storeKeyWithPeerContext(allocator, name, version, kind, source, peer_context);
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
    return storeKeyWithPeerContext(allocator, name, version, kind, source, .{});
}

pub fn storeKeyWithPeerContext(
    allocator: std.mem.Allocator,
    name: []const u8,
    version: []const u8,
    kind: Lockfile.Kind,
    source: []const u8,
    peer_context: PeerContext,
) ![]const u8 {
    const escaped_name = try escapeStoreComponent(allocator, name);
    const base = try switch (kind) {
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
    if (peer_context.hash == 0) return base;
    return std.fmt.allocPrint(allocator, "{s}+{x}", .{ base, peer_context.hash });
}

fn wildcardMatch(pattern: []const u8, value: []const u8) bool {
    var pattern_index: usize = 0;
    var value_index: usize = 0;
    var star_index: ?usize = null;
    var star_value_index: usize = 0;

    while (value_index < value.len) {
        if (pattern_index < pattern.len and pattern[pattern_index] == value[value_index]) {
            pattern_index += 1;
            value_index += 1;
        } else if (pattern_index < pattern.len and pattern[pattern_index] == '*') {
            star_index = pattern_index;
            pattern_index += 1;
            star_value_index = value_index;
        } else if (star_index) |star| {
            pattern_index = star + 1;
            star_value_index += 1;
            value_index = star_value_index;
        } else {
            return false;
        }
    }
    while (pattern_index < pattern.len and pattern[pattern_index] == '*') pattern_index += 1;
    return pattern_index == pattern.len;
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

test "peer contexts use Bun's resolved peer hash" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const context = try PeerContext.init(allocator, &.{
        .{ .name = "no-deps", .resolution = "1.0.1" },
    });
    try std.testing.expectEqual(@as(u64, 0xf8a822eca018d0a1), context.hash);

    const contextual = try placementWithPeerContext(
        allocator,
        "/project",
        "one-optional-peer-dep",
        "1.0.2",
        .npm,
        "",
        context,
    );
    try std.testing.expectEqualStrings(
        "one-optional-peer-dep@1.0.2+f8a822eca018d0a1",
        contextual.store_key,
    );

    const ordered = try PeerContext.init(allocator, &.{
        .{ .name = "alpha", .resolution = "1.0.0" },
        .{ .name = "zeta", .resolution = "2.0.0" },
    });
    const reversed_with_duplicate = try PeerContext.init(allocator, &.{
        .{ .name = "zeta", .resolution = "2.0.0" },
        .{ .name = "alpha", .resolution = "1.0.0" },
        .{ .name = "zeta", .resolution = "2.0.0" },
    });
    try std.testing.expectEqual(ordered.hash, reversed_with_duplicate.hash);
}

test "hoist patterns follow pnpm include and exclude ordering" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const include = try HoistPattern.init(allocator, &.{ "@types/*", "no-*" });
    try std.testing.expect(include.isMatch("@types/is-number"));
    try std.testing.expect(include.isMatch("no-deps"));
    try std.testing.expect(!include.isMatch("a-dep"));

    const exclude = try HoistPattern.init(allocator, &.{"!no-deps"});
    try std.testing.expect(!exclude.isMatch("no-deps"));
    try std.testing.expect(exclude.isMatch("a-dep"));

    const mixed = try HoistPattern.init(allocator, &.{ "*", "!@types*", "@types/private-*" });
    try std.testing.expect(mixed.isMatch("a-dep"));
    try std.testing.expect(!mixed.isMatch("@types/is-number"));
    try std.testing.expect(mixed.isMatch("@types/private-tool"));
}
