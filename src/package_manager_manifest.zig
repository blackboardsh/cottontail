const std = @import("std");
const compiler = @import("cottontail_compiler");

const Value = std.json.Value;

pub const ResolveError = error{
    CatalogDependencyNotFound,
    InvalidCatalogDependency,
};

pub const Policy = struct {
    allocator: std.mem.Allocator,
    root: *const Value,
    overrides: std.StringHashMap([]const u8),
    patched_dependencies: std.StringHashMap([]const u8),
    default_catalog: std.StringHashMap([]const u8),
    catalog_groups: std.StringHashMap(std.StringHashMap([]const u8)),
    trusted_dependencies: ?std.StringHashMap(void) = null,

    pub fn init(allocator: std.mem.Allocator, root: *const Value) !Policy {
        var policy = Policy{
            .allocator = allocator,
            .root = root,
            .overrides = std.StringHashMap([]const u8).init(allocator),
            .patched_dependencies = std.StringHashMap([]const u8).init(allocator),
            .default_catalog = std.StringHashMap([]const u8).init(allocator),
            .catalog_groups = std.StringHashMap(std.StringHashMap([]const u8)).init(allocator),
        };
        errdefer policy.deinit();

        try policy.parseOverrides();
        try policy.parsePatchedDependencies();
        try policy.parseCatalogs();
        try policy.parseTrustedDependencies();
        return policy;
    }

    pub fn deinit(policy: *Policy) void {
        policy.overrides.deinit();
        policy.patched_dependencies.deinit();
        policy.default_catalog.deinit();
        var groups = policy.catalog_groups.valueIterator();
        while (groups.next()) |group| group.deinit();
        policy.catalog_groups.deinit();
        if (policy.trusted_dependencies) |*trusted| trusted.deinit();
    }

    pub fn resolveDependency(
        policy: *const Policy,
        package_name: []const u8,
        requested: []const u8,
        workspace_package: bool,
    ) ResolveError![]const u8 {
        var effective = requested;
        if (!workspace_package) {
            if (policy.overrides.get(package_name)) |override| {
                effective = policy.resolveOverrideReference(override) orelse override;
            }
        }

        if (!std.mem.startsWith(u8, effective, "catalog:")) return effective;
        const group_name = std.mem.trim(u8, effective["catalog:".len..], " \t\r\n");
        const catalog = if (group_name.len == 0)
            &policy.default_catalog
        else
            policy.catalog_groups.getPtr(group_name) orelse return error.CatalogDependencyNotFound;
        const resolved = catalog.get(package_name) orelse return error.CatalogDependencyNotFound;
        if (!isValidDependencyValue(resolved)) return error.InvalidCatalogDependency;
        return resolved;
    }

    pub fn isTrusted(policy: *const Policy, package_name: []const u8, npm_package: bool) bool {
        if (policy.trusted_dependencies) |trusted| return trusted.contains(package_name);
        return npm_package and isDefaultTrustedDependency(package_name);
    }

    pub fn patchPath(policy: *const Policy, package_name: []const u8, version: []const u8) ?[]const u8 {
        var key_buffer: [1024]u8 = undefined;
        const key = std.fmt.bufPrint(&key_buffer, "{s}@{s}", .{ package_name, version }) catch return null;
        return policy.patched_dependencies.get(key);
    }

    pub fn wasTrustedInLock(document: *const Value, package_name: []const u8, npm_package: bool) bool {
        if (document.* != .object) return false;
        const trusted = document.object.get("trustedDependencies") orelse
            return npm_package and isDefaultTrustedDependency(package_name);
        if (trusted != .array) return false;
        for (trusted.array.items) |entry| {
            if (entry == .string and std.mem.eql(u8, entry.string, package_name)) return true;
        }
        return false;
    }

    pub fn wasTrustedInLockHashes(
        trusted_hashes: ?[]const compiler.install.TruncatedPackageNameHash,
        package_name: []const u8,
        npm_package: bool,
    ) bool {
        const hashes = trusted_hashes orelse return npm_package and isDefaultTrustedDependency(package_name);
        const package_hash: compiler.install.TruncatedPackageNameHash =
            @truncate(compiler.Semver.String.Builder.stringHash(package_name));
        return std.mem.indexOfScalar(compiler.install.TruncatedPackageNameHash, hashes, package_hash) != null;
    }

    pub fn matchesLockDocument(policy: *const Policy, document: *const Value) bool {
        if (!policy.matchesLockDocumentWithoutTrustedDependencies(document)) return false;

        const lock_trusted = document.object.get("trustedDependencies");
        if (policy.trusted_dependencies) |trusted| {
            if (lock_trusted == null or lock_trusted.? != .array or lock_trusted.?.array.items.len != trusted.count()) return false;
            for (lock_trusted.?.array.items) |entry| {
                if (entry != .string or !trusted.contains(entry.string)) return false;
            }
            return true;
        }
        return lock_trusted == null;
    }

    pub fn matchesLockDocumentWithoutTrustedDependencies(policy: *const Policy, document: *const Value) bool {
        if (document.* != .object) return false;
        if (!stringMapMatchesValue(&policy.overrides, document.object.get("overrides"))) return false;
        if (!policy.patchesMatchLockDocument(document)) return false;
        if (!stringMapMatchesValue(&policy.default_catalog, document.object.get("catalog"))) return false;
        if (!catalogGroupsMatchValue(&policy.catalog_groups, document.object.get("catalogs"))) return false;
        return true;
    }

    pub fn matchesTrustedDependencyHashes(
        policy: *const Policy,
        lock_hashes: ?[]const compiler.install.TruncatedPackageNameHash,
    ) bool {
        const trusted = policy.trusted_dependencies orelse return lock_hashes == null;
        const hashes = lock_hashes orelse return false;

        var trusted_names = trusted.keyIterator();
        while (trusted_names.next()) |name| {
            const hash: compiler.install.TruncatedPackageNameHash = @truncate(compiler.Semver.String.Builder.stringHash(name.*));
            if (std.mem.indexOfScalar(compiler.install.TruncatedPackageNameHash, hashes, hash) == null) return false;
        }
        for (hashes) |hash| {
            var matching_name = trusted.keyIterator();
            while (matching_name.next()) |name| {
                if (hash == @as(compiler.install.TruncatedPackageNameHash, @truncate(compiler.Semver.String.Builder.stringHash(name.*)))) break;
            } else return false;
        }
        return true;
    }

    pub fn patchesMatchLockDocument(policy: *const Policy, document: *const Value) bool {
        if (document.* != .object) return false;
        return stringMapMatchesValue(&policy.patched_dependencies, document.object.get("patchedDependencies"));
    }

    pub fn writeLockFields(policy: *const Policy, writer: *std.Io.Writer) !void {
        if (policy.trusted_dependencies) |trusted| {
            try writer.writeAll(",\n  \"trustedDependencies\": [");
            if (trusted.count() > 0) {
                const names = try sortedKeys(void, policy.allocator, &trusted);
                defer policy.allocator.free(names);
                for (names, 0..) |name, index| {
                    try writer.writeAll(if (index == 0) "\n    " else ",\n    ");
                    try writeJSONString(writer, name);
                }
                try writer.writeAll("\n  ");
            }
            try writer.writeByte(']');
        }
        if (policy.patched_dependencies.count() > 0) {
            try writeStringMapField(writer, policy.allocator, "patchedDependencies", &policy.patched_dependencies, 2);
        }
        if (policy.overrides.count() > 0) {
            try writeStringMapField(writer, policy.allocator, "overrides", &policy.overrides, 2);
        }
        if (policy.default_catalog.count() > 0) {
            try writeStringMapField(writer, policy.allocator, "catalog", &policy.default_catalog, 2);
        }
        if (policy.catalog_groups.count() > 0) {
            try writer.writeAll(",\n  \"catalogs\": {");
            const names = try sortedKeys(std.StringHashMap([]const u8), policy.allocator, &policy.catalog_groups);
            defer policy.allocator.free(names);
            for (names, 0..) |name, index| {
                try writer.writeAll(if (index == 0) "\n    " else ",\n    ");
                try writeJSONString(writer, name);
                try writer.writeAll(": {");
                const group = policy.catalog_groups.getPtr(name).?;
                const packages = try sortedKeys([]const u8, policy.allocator, group);
                defer policy.allocator.free(packages);
                for (packages, 0..) |package_name, package_index| {
                    try writer.writeAll(if (package_index == 0) "\n      " else ",\n      ");
                    try writeJSONString(writer, package_name);
                    try writer.writeAll(": ");
                    try writeJSONString(writer, group.get(package_name).?);
                }
                if (packages.len > 0) try writer.writeByte('\n');
                try writer.writeAll("    }");
            }
            if (names.len > 0) try writer.writeByte('\n');
            try writer.writeAll("  }");
        }
    }

    fn parseOverrides(policy: *Policy) !void {
        if (policy.root.* != .object) return;
        if (policy.root.object.get("overrides")) |overrides| {
            if (overrides != .object) return error.InvalidOverrides;
            for (overrides.object.keys(), overrides.object.values()) |raw_name, value| {
                if (raw_name.len == 0) continue;
                const override = switch (value) {
                    .string => |string| string,
                    .object => |object| blk: {
                        const dot = object.get(".") orelse continue;
                        if (dot != .string) continue;
                        break :blk dot.string;
                    },
                    else => continue,
                };
                if (override.len == 0) continue;
                try policy.overrides.put(try policy.allocator.dupe(u8, raw_name), try policy.allocator.dupe(u8, override));
            }
            return;
        }

        const resolutions = policy.root.object.get("resolutions") orelse return;
        if (resolutions != .object) return;
        for (resolutions.object.keys(), resolutions.object.values()) |raw_name, value| {
            if (value != .string) continue;
            const name = if (std.mem.startsWith(u8, raw_name, "**/")) raw_name[3..] else raw_name;
            if (!isSinglePackageName(name) or value.string.len == 0) continue;
            try policy.overrides.put(try policy.allocator.dupe(u8, name), try policy.allocator.dupe(u8, value.string));
        }
    }

    fn parsePatchedDependencies(policy: *Policy) !void {
        if (policy.root.* != .object) return;
        const patched = policy.root.object.get("patchedDependencies") orelse return;
        if (patched != .object) return error.InvalidPatchedDependencies;
        for (patched.object.keys(), patched.object.values()) |key, value| {
            if (key.len == 0 or value != .string or value.string.len == 0) return error.InvalidPatchedDependencies;
            try policy.patched_dependencies.put(
                try policy.allocator.dupe(u8, key),
                try policy.allocator.dupe(u8, value.string),
            );
        }
    }

    fn parseCatalogs(policy: *Policy) !void {
        if (policy.root.* != .object) return;
        const workspaces = policy.root.object.get("workspaces") orelse return;
        var source = workspaces;
        const workspace_has_catalogs = workspaces == .object and
            (workspaces.object.get("catalog") != null or workspaces.object.get("catalogs") != null);
        if (!workspace_has_catalogs) source = policy.root.*;
        if (source != .object) return;

        if (source.object.get("catalog")) |catalog| {
            if (catalog == .object) try parseStringMap(policy.allocator, &policy.default_catalog, &catalog.object);
        }
        if (source.object.get("catalogs")) |catalogs| {
            if (catalogs != .object) return;
            for (catalogs.object.keys(), catalogs.object.values()) |name, value| {
                if (value != .object) continue;
                var group = std.StringHashMap([]const u8).init(policy.allocator);
                errdefer group.deinit();
                try parseStringMap(policy.allocator, &group, &value.object);
                try policy.catalog_groups.put(try policy.allocator.dupe(u8, name), group);
            }
        }
    }

    fn parseTrustedDependencies(policy: *Policy) !void {
        if (policy.root.* != .object) return;
        const value = policy.root.object.get("trustedDependencies") orelse return;
        if (value != .array) return error.InvalidTrustedDependencies;
        var trusted = std.StringHashMap(void).init(policy.allocator);
        errdefer trusted.deinit();
        for (value.array.items) |entry| {
            if (entry != .string) return error.InvalidTrustedDependencies;
            try trusted.put(try policy.allocator.dupe(u8, entry.string), {});
        }
        policy.trusted_dependencies = trusted;
    }

    fn resolveOverrideReference(policy: *const Policy, override: []const u8) ?[]const u8 {
        if (override.len < 2 or override[0] != '$') return null;
        const dependency_name = override[1..];
        const sections = [_][]const u8{ "dependencies", "devDependencies", "optionalDependencies", "peerDependencies" };
        for (sections) |section_name| {
            const section = policy.root.object.get(section_name) orelse continue;
            if (section != .object) continue;
            const value = section.object.get(dependency_name) orelse continue;
            if (value == .string) return value.string;
        }
        return null;
    }
};

fn parseStringMap(allocator: std.mem.Allocator, map: *std.StringHashMap([]const u8), object: *const std.json.ObjectMap) !void {
    for (object.keys(), object.values()) |name, value| {
        if (value != .string) continue;
        try map.put(try allocator.dupe(u8, name), try allocator.dupe(u8, value.string));
    }
}

fn stringMapMatchesValue(map: *const std.StringHashMap([]const u8), maybe_value: ?Value) bool {
    if (map.count() == 0) return maybe_value == null or (maybe_value.? == .object and maybe_value.?.object.count() == 0);
    const value = maybe_value orelse return false;
    if (value != .object or value.object.count() != map.count()) return false;
    var iterator = map.iterator();
    while (iterator.next()) |entry| {
        const actual = value.object.get(entry.key_ptr.*) orelse return false;
        if (actual != .string or !std.mem.eql(u8, actual.string, entry.value_ptr.*)) return false;
    }
    return true;
}

fn catalogGroupsMatchValue(groups: *const std.StringHashMap(std.StringHashMap([]const u8)), maybe_value: ?Value) bool {
    if (groups.count() == 0) return maybe_value == null or (maybe_value.? == .object and maybe_value.?.object.count() == 0);
    const value = maybe_value orelse return false;
    if (value != .object or value.object.count() != groups.count()) return false;
    var iterator = groups.iterator();
    while (iterator.next()) |entry| {
        const actual = value.object.get(entry.key_ptr.*) orelse return false;
        if (!stringMapMatchesValue(entry.value_ptr, actual)) return false;
    }
    return true;
}

fn isSinglePackageName(name: []const u8) bool {
    if (name.len == 0) return false;
    if (name[0] != '@') return std.mem.indexOfScalar(u8, name, '/') == null;
    const first_slash = std.mem.indexOfScalar(u8, name, '/') orelse return false;
    return first_slash > 1 and first_slash + 1 < name.len and std.mem.indexOfScalarPos(u8, name, first_slash + 1, '/') == null;
}

fn isValidDependencyValue(value: []const u8) bool {
    if (value.len == 0) return false;
    if (std.mem.indexOf(u8, value, "://")) |scheme| return scheme > 0;
    if (std.mem.indexOfScalar(u8, value, ':')) |colon| {
        const known = [_][]const u8{ "npm:", "file:", "link:", "workspace:", "catalog:", "git:", "git+", "github:", "patch:" };
        for (known) |prefix| if (std.mem.startsWith(u8, value, prefix)) return true;
        return colon == 1 and std.ascii.isAlphabetic(value[0]);
    }
    return true;
}

pub const default_trusted_dependencies_source = @embedFile("compiler/src/install/default-trusted-dependencies.txt");

pub fn isDefaultTrustedDependency(name: []const u8) bool {
    var names = std.mem.tokenizeAny(u8, default_trusted_dependencies_source, " \r\n\t");
    while (names.next()) |trusted| if (std.mem.eql(u8, trusted, name)) return true;
    return false;
}

pub fn mergeTrustedDependencies(
    allocator: std.mem.Allocator,
    document: *Value,
    additions: []const []const u8,
) ![][]const u8 {
    if (document.* != .object) return error.InvalidPackageJSON;
    var names = std.StringHashMap(void).init(allocator);
    defer names.deinit();
    if (document.object.get("trustedDependencies")) |trusted| {
        if (trusted != .array) return error.InvalidTrustedDependencies;
        for (trusted.array.items) |entry| {
            if (entry != .string) return error.InvalidTrustedDependencies;
            try names.put(entry.string, {});
        }
    }
    for (additions) |name| try names.put(name, {});

    const sorted = try allocator.alloc([]const u8, names.count());
    var iterator = names.keyIterator();
    var index: usize = 0;
    while (iterator.next()) |name| : (index += 1) sorted[index] = name.*;
    std.mem.sort([]const u8, sorted, {}, struct {
        fn lessThan(_: void, left: []const u8, right: []const u8) bool {
            return std.mem.order(u8, left, right) == .lt;
        }
    }.lessThan);

    var array = std.json.Array.init(allocator);
    for (sorted) |name| try array.append(.{ .string = name });
    try document.object.put(allocator, "trustedDependencies", .{ .array = array });
    return sorted;
}

fn sortedKeys(comptime V: type, allocator: std.mem.Allocator, map: *const std.StringHashMap(V)) ![][]const u8 {
    const keys = try allocator.alloc([]const u8, map.count());
    var iterator = map.keyIterator();
    var index: usize = 0;
    while (iterator.next()) |key| : (index += 1) keys[index] = key.*;
    std.mem.sort([]const u8, keys, {}, struct {
        fn lessThan(_: void, left: []const u8, right: []const u8) bool {
            return std.mem.order(u8, left, right) == .lt;
        }
    }.lessThan);
    return keys;
}

fn writeStringMapField(
    writer: *std.Io.Writer,
    allocator: std.mem.Allocator,
    field_name: []const u8,
    map: *const std.StringHashMap([]const u8),
    indent: usize,
) !void {
    try writer.writeAll(",\n  ");
    try writeJSONString(writer, field_name);
    try writer.writeAll(": {");
    const keys = try sortedKeys([]const u8, allocator, map);
    defer allocator.free(keys);
    for (keys, 0..) |key, index| {
        try writer.writeAll(if (index == 0) "\n    " else ",\n    ");
        try writeJSONString(writer, key);
        try writer.writeAll(": ");
        try writeJSONString(writer, map.get(key).?);
    }
    if (keys.len > 0) try writer.writeByte('\n');
    var count: usize = 0;
    while (count < indent) : (count += 1) try writer.writeByte(' ');
    try writer.writeByte('}');
}

fn writeJSONString(writer: *std.Io.Writer, value: []const u8) !void {
    try std.json.Stringify.value(value, .{}, writer);
}

test "manifest policy resolves catalogs and overrides" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var root = try std.json.parseFromSliceLeaky(Value, allocator,
        \\{
        \\  "workspaces": { "packages": ["packages/*"], "catalog": { "foo": "1.2.3" }, "catalogs": { "web": { "bar": "npm:baz@2.0.0" } } },
        \\  "dependencies": { "shared": "^3.0.0" },
        \\  "overrides": { "qux": "$shared" },
        \\  "trustedDependencies": ["foo"],
        \\  "patchedDependencies": { "bar@2.0.0": "patches/bar.patch" }
        \\}
    , .{});
    var policy = try Policy.init(allocator, &root);
    defer policy.deinit();

    try std.testing.expectEqualStrings("1.2.3", try policy.resolveDependency("foo", "catalog:", false));
    try std.testing.expectEqualStrings("npm:baz@2.0.0", try policy.resolveDependency("bar", "catalog:web", false));
    try std.testing.expectEqualStrings("^3.0.0", try policy.resolveDependency("qux", "latest", false));
    try std.testing.expectEqualStrings("latest", try policy.resolveDependency("qux", "latest", true));
    try std.testing.expect(policy.isTrusted("foo", true));
    try std.testing.expect(!policy.isTrusted("bar", true));
    try std.testing.expectEqualStrings("patches/bar.patch", policy.patchPath("bar", "2.0.0").?);
}

test "default trust applies only to npm packages" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const root = try std.json.parseFromSliceLeaky(Value, allocator, "{}", .{});
    var policy = try Policy.init(allocator, &root);
    defer policy.deinit();

    try std.testing.expect(policy.isTrusted("esbuild", true));
    try std.testing.expect(!policy.isTrusted("esbuild", false));
    try std.testing.expect(!policy.isTrusted("not-default-trusted", true));
}

test "trusted dependency updates are a sorted union" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var root = try std.json.parseFromSliceLeaky(
        Value,
        allocator,
        "{\"trustedDependencies\":[\"z-package\",\"a-package\"]}",
        .{},
    );
    const names = try mergeTrustedDependencies(allocator, &root, &.{ "m-package", "a-package" });
    try std.testing.expectEqual(@as(usize, 3), names.len);
    try std.testing.expectEqualStrings("a-package", names[0]);
    try std.testing.expectEqualStrings("m-package", names[1]);
    try std.testing.expectEqualStrings("z-package", names[2]);
}

test "manifest policy preserves trusted dependency presence" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const absent_root = try std.json.parseFromSliceLeaky(Value, allocator, "{}", .{});
    const empty_root = try std.json.parseFromSliceLeaky(Value, allocator, "{\"trustedDependencies\":[]}", .{});
    const named_root = try std.json.parseFromSliceLeaky(Value, allocator, "{\"trustedDependencies\":[\"not-installed\"]}", .{});
    const absent_lock = try std.json.parseFromSliceLeaky(Value, allocator, "{}", .{});
    const empty_lock = try std.json.parseFromSliceLeaky(Value, allocator, "{\"trustedDependencies\":[]}", .{});
    const named_lock = try std.json.parseFromSliceLeaky(Value, allocator, "{\"trustedDependencies\":[\"not-installed\"]}", .{});

    var absent_policy = try Policy.init(allocator, &absent_root);
    defer absent_policy.deinit();
    var empty_policy = try Policy.init(allocator, &empty_root);
    defer empty_policy.deinit();
    var named_policy = try Policy.init(allocator, &named_root);
    defer named_policy.deinit();

    try std.testing.expect(absent_policy.matchesLockDocument(&absent_lock));
    try std.testing.expect(!absent_policy.matchesLockDocument(&empty_lock));
    try std.testing.expect(empty_policy.matchesLockDocument(&empty_lock));
    try std.testing.expect(!empty_policy.matchesLockDocument(&absent_lock));

    try std.testing.expect(Policy.wasTrustedInLock(&absent_lock, "electron", true));
    try std.testing.expect(!Policy.wasTrustedInLock(&absent_lock, "electron", false));
    try std.testing.expect(!Policy.wasTrustedInLock(&named_lock, "electron", true));
    try std.testing.expect(Policy.wasTrustedInLock(&named_lock, "not-installed", true));

    const named_hash: compiler.install.TruncatedPackageNameHash = @truncate(compiler.Semver.String.Builder.stringHash("not-installed"));
    try std.testing.expect(absent_policy.matchesTrustedDependencyHashes(null));
    try std.testing.expect(!absent_policy.matchesTrustedDependencyHashes(&.{named_hash}));
    try std.testing.expect(empty_policy.matchesTrustedDependencyHashes(&.{}));
    try std.testing.expect(!empty_policy.matchesTrustedDependencyHashes(null));
    try std.testing.expect(named_policy.matchesTrustedDependencyHashes(&.{named_hash}));
    try std.testing.expect(Policy.wasTrustedInLockHashes(null, "electron", true));
    try std.testing.expect(!Policy.wasTrustedInLockHashes(null, "electron", false));
    try std.testing.expect(!Policy.wasTrustedInLockHashes(&.{named_hash}, "electron", true));
    try std.testing.expect(Policy.wasTrustedInLockHashes(&.{named_hash}, "not-installed", true));

    var output: std.Io.Writer.Allocating = .init(allocator);
    try empty_policy.writeLockFields(&output.writer);
    try std.testing.expectEqualStrings(",\n  \"trustedDependencies\": []", output.written());
}
