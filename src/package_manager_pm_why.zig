const std = @import("std");
const compiler = @import("cottontail_compiler");
const BunLockfile = @import("package_manager_bun_lockfile.zig");
const Lockfile = @import("package_manager_lockfile.zig");

const Semver = compiler.Semver;
const Value = std.json.Value;
const cottontail_version = @import("version.zig").version;

pub const Options = struct {
    top_only: bool = false,
    depth: ?usize = null,
};

const DependencyType = enum { prod, dev, peer, optional };

const Dependent = struct {
    key: []const u8,
    name: []const u8,
    version: []const u8,
    spec: []const u8,
    dependency_type: DependencyType,
    workspace: bool,
};

const ReverseGraph = std.StringHashMap(std.array_list.Managed(Dependent));

const Query = struct {
    name: []const u8,
    version: []const u8,
};

pub fn run(
    init: std.process.Init,
    args: []const []const u8,
    options: Options,
    cwd: []const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    if (args.len == 0) {
        try printHelp(stdout);
        return 1;
    }

    const allocator = init.arena.allocator();
    const root_dir = findLockfileRoot(init.io, allocator, cwd) catch |err| {
        try stderr.print("error: unable to find lockfile: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };
    var graph = loadGraph(init.io, allocator, root_dir) catch |err| {
        try stderr.print("error: unable to load lockfile: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };
    defer graph.deinit();

    var reverse = ReverseGraph.init(allocator);
    try buildReverseGraph(allocator, &graph, &reverse);

    const query = parseQuery(args[0]);
    var targets = std.array_list.Managed(*const Lockfile.Package).init(allocator);
    var package_iterator = graph.packages.iterator();
    while (package_iterator.next()) |entry| {
        const package = entry.value_ptr;
        if (!globMatches(query.name, package.name) and !globMatches(query.name, package.key)) continue;
        if (!versionMatches(allocator, query.version, packageVersion(package))) continue;
        try targets.append(package);
    }

    if (targets.items.len == 0) {
        try stderr.print("error: No packages matching '{s}' found in lockfile\n", .{args[0]});
        try stderr.flush();
        return 1;
    }

    std.sort.pdq(*const Lockfile.Package, targets.items, {}, lessPackage);
    const max_depth = if (options.top_only) 1 else options.depth orelse 100;
    for (targets.items) |target| {
        const display_name = if (std.mem.indexOfScalar(u8, query.name, '*') == null and
            std.mem.eql(u8, target.key, query.name)) query.name else target.name;
        try stdout.print("{s}@{s}\n", .{ display_name, packageVersion(target) });
        if (reverse.get(target.key)) |dependents| {
            var path = std.StringHashMap(void).init(allocator);
            var expanded = std.StringHashMap(void).init(allocator);
            try path.put(target.key, {});
            try expanded.put(target.key, {});
            try printDependents(&reverse, dependents.items, "  ", 1, max_depth, &path, &expanded, stdout);
        } else {
            try stdout.writeAll("  └─ No dependents found\n");
        }
        try stdout.writeByte('\n');
    }
    try stdout.flush();
    return 0;
}

fn printHelp(stdout: *std.Io.Writer) !void {
    try stdout.print(
        "bun why v{s}\n" ++
            "Explain why a package is installed\n\n" ++
            "Arguments:\n" ++
            "  <package>     Package name or glob to explain\n\n" ++
            "Options:\n" ++
            "  --top         Show only top-level dependents\n" ++
            "  --depth NUM   Limit dependency-tree depth\n",
        .{cottontail_version},
    );
    try stdout.flush();
}

fn findLockfileRoot(io: std.Io, allocator: std.mem.Allocator, cwd: []const u8) ![]const u8 {
    var current = cwd;
    while (true) {
        const text_path = try std.fs.path.join(allocator, &.{ current, "bun.lock" });
        if (fileExists(io, text_path)) return current;
        const binary_path = try std.fs.path.join(allocator, &.{ current, "bun.lockb" });
        if (fileExists(io, binary_path)) return current;
        const parent = std.fs.path.dirname(current) orelse return error.LockfileNotFound;
        if (std.mem.eql(u8, parent, current)) return error.LockfileNotFound;
        current = parent;
    }
}

fn loadGraph(io: std.Io, allocator: std.mem.Allocator, root_dir: []const u8) !Lockfile.Graph {
    const text_path = try std.fs.path.join(allocator, &.{ root_dir, "bun.lock" });
    if (readOptionalFile(io, allocator, text_path)) |source| {
        return Lockfile.parseText(allocator, source);
    } else |_| {}

    const binary_path = try std.fs.path.join(allocator, &.{ root_dir, "bun.lockb" });
    const binary = try std.Io.Dir.cwd().readFileAlloc(io, binary_path, allocator, .limited(256 * 1024 * 1024));
    return Lockfile.parseText(allocator, try BunLockfile.binaryToText(allocator, binary));
}

fn buildReverseGraph(
    allocator: std.mem.Allocator,
    graph: *const Lockfile.Graph,
    reverse: *ReverseGraph,
) !void {
    const root_name = jsonString(graph.root_workspace, "name") orelse "root";
    const root_version = jsonString(graph.root_workspace, "version") orelse "";
    try addManifestDependencies(
        allocator,
        graph,
        reverse,
        "@root",
        root_name,
        root_version,
        false,
        graph.root_workspace,
    );

    var workspace_iterator = graph.workspaces.iterator();
    while (workspace_iterator.next()) |entry| {
        if (entry.key_ptr.*.len == 0) continue;
        const manifest = entry.value_ptr.*;
        const name = jsonString(manifest, "name") orelse std.fs.path.basename(entry.key_ptr.*);
        const version = jsonString(manifest, "version") orelse "";
        const package_key = workspacePackageKey(graph, entry.key_ptr.*, name) orelse entry.key_ptr.*;
        try addManifestDependencies(allocator, graph, reverse, package_key, name, version, true, manifest);
    }

    var package_iterator = graph.packages.iterator();
    while (package_iterator.next()) |entry| {
        const package = entry.value_ptr;
        if (package.kind == .workspace or package.kind == .root) continue;
        const manifest = package.info orelse continue;
        try addManifestDependencies(
            allocator,
            graph,
            reverse,
            package.key,
            package.name,
            packageVersion(package),
            false,
            manifest,
        );
    }
}

fn addManifestDependencies(
    allocator: std.mem.Allocator,
    graph: *const Lockfile.Graph,
    reverse: *ReverseGraph,
    parent_key: []const u8,
    parent_name: []const u8,
    parent_version: []const u8,
    workspace: bool,
    manifest: *const Value,
) !void {
    const sections = [_]struct { []const u8, DependencyType }{
        .{ "dependencies", .prod },
        .{ "devDependencies", .dev },
        .{ "peerDependencies", .peer },
        .{ "optionalDependencies", .optional },
    };
    if (manifest.* != .object) return;
    for (sections) |section| {
        const dependencies = manifest.object.get(section[0]) orelse continue;
        if (dependencies != .object) continue;
        for (dependencies.object.keys(), dependencies.object.values()) |alias, value| {
            if (value != .string) continue;
            const target_key = try resolveDependencyKey(allocator, graph, parent_key, alias, value.string) orelse continue;
            const result = try reverse.getOrPut(target_key);
            if (!result.found_existing) result.value_ptr.* = std.array_list.Managed(Dependent).init(allocator);
            if (dependentExists(result.value_ptr.items, parent_key, section[1])) continue;
            try result.value_ptr.append(.{
                .key = parent_key,
                .name = parent_name,
                .version = parent_version,
                .spec = value.string,
                .dependency_type = section[1],
                .workspace = workspace,
            });
        }
    }
}

fn resolveDependencyKey(
    allocator: std.mem.Allocator,
    graph: *const Lockfile.Graph,
    parent_key: []const u8,
    alias: []const u8,
    spec: []const u8,
) !?[]const u8 {
    if (!std.mem.eql(u8, parent_key, "@root")) {
        var prefix = parent_key;
        while (prefix.len > 0) {
            const nested = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ prefix, alias });
            if (graph.get(nested) != null) return nested;
            const slash = std.mem.lastIndexOfScalar(u8, prefix, '/') orelse break;
            prefix = prefix[0..slash];
        }
    }
    if (graph.get(alias) != null) return alias;

    const actual_name = npmAliasName(spec) orelse alias;
    var iterator = graph.packages.iterator();
    while (iterator.next()) |entry| {
        const package = entry.value_ptr;
        if (!std.mem.eql(u8, package.name, actual_name)) continue;
        if (dependencySpecMatches(allocator, spec, packageVersion(package))) return package.key;
    }
    return null;
}

fn npmAliasName(spec: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, spec, "npm:")) return null;
    const value = spec["npm:".len..];
    if (value.len == 0) return null;
    if (value[0] == '@') {
        const slash = std.mem.indexOfScalar(u8, value, '/') orelse return value;
        const at = std.mem.indexOfScalarPos(u8, value, slash + 1, '@') orelse return value;
        return value[0..at];
    }
    const at = std.mem.indexOfScalar(u8, value, '@') orelse return value;
    return value[0..at];
}

fn dependencySpecMatches(allocator: std.mem.Allocator, raw_spec: []const u8, version: []const u8) bool {
    var spec = raw_spec;
    if (std.mem.startsWith(u8, spec, "npm:")) {
        const value = spec["npm:".len..];
        const at = if (value.len > 0 and value[0] == '@') blk: {
            const slash = std.mem.indexOfScalar(u8, value, '/') orelse return true;
            break :blk std.mem.indexOfScalarPos(u8, value, slash + 1, '@') orelse return true;
        } else std.mem.indexOfScalar(u8, value, '@') orelse return true;
        spec = value[at + 1 ..];
    }
    if (std.mem.startsWith(u8, spec, "workspace:")) spec = spec["workspace:".len..];
    return versionMatches(allocator, spec, version);
}

fn parseQuery(pattern: []const u8) Query {
    if (pattern.len > 0 and pattern[0] == '@') {
        const slash = std.mem.indexOfScalar(u8, pattern, '/') orelse return .{ .name = pattern, .version = "" };
        const at = std.mem.indexOfScalarPos(u8, pattern, slash + 1, '@') orelse return .{ .name = pattern, .version = "" };
        return .{ .name = pattern[0..at], .version = pattern[at + 1 ..] };
    }
    const at = std.mem.indexOfScalar(u8, pattern, '@') orelse return .{ .name = pattern, .version = "" };
    return .{ .name = pattern[0..at], .version = pattern[at + 1 ..] };
}

fn globMatches(pattern: []const u8, value: []const u8) bool {
    const wildcard = std.mem.indexOfScalar(u8, pattern, '*') orelse return std.mem.eql(u8, pattern, value);
    const prefix = pattern[0..wildcard];
    const suffix = pattern[wildcard + 1 ..];
    return value.len >= prefix.len + suffix.len and
        std.mem.startsWith(u8, value, prefix) and
        std.mem.endsWith(u8, value, suffix);
}

fn versionMatches(allocator: std.mem.Allocator, query: []const u8, version: []const u8) bool {
    if (query.len == 0 or std.mem.eql(u8, query, "*") or std.mem.eql(u8, query, "latest")) return true;
    if (std.mem.eql(u8, query, version)) return true;
    const parsed = Semver.Version.parseUTF8(version);
    if (!parsed.valid) return false;
    const sliced = Semver.SlicedString.init(query, query);
    var semver_query = Semver.Query.parse(allocator, query, sliced) catch return false;
    defer semver_query.deinit();
    return semver_query.satisfies(parsed.version.min(), query, version);
}

fn printDependents(
    reverse: *const ReverseGraph,
    dependents: []const Dependent,
    prefix: []const u8,
    depth: usize,
    max_depth: usize,
    path: *std.StringHashMap(void),
    expanded: *std.StringHashMap(void),
    stdout: *std.Io.Writer,
) !void {
    for (dependents, 0..) |dependent, index| {
        const last = index + 1 == dependents.len;
        try stdout.print("{s}{s} ", .{ prefix, if (last) "└─" else "├─" });
        switch (dependent.dependency_type) {
            .dev => try stdout.writeAll("dev "),
            .peer => try stdout.writeAll("peer "),
            .optional => try stdout.writeAll("optional "),
            .prod => {},
        }
        try stdout.print("{s}", .{dependent.name});
        if (dependent.version.len > 0) {
            if (dependent.workspace) try stdout.writeAll("@workspace") else try stdout.print("@{s}", .{dependent.version});
        }
        try stdout.print(" (requires {s})\n", .{dependent.spec});

        const children = reverse.get(dependent.key) orelse continue;
        if (depth >= max_depth) {
            try stdout.print("{s}{s}└─ (deeper dependencies hidden)\n", .{ prefix, if (last) "   " else "│  " });
            continue;
        }
        if (path.contains(dependent.key)) {
            try stdout.print("{s}{s}└─ *circular\n", .{ prefix, if (last) "   " else "│  " });
            continue;
        }
        if (expanded.contains(dependent.key)) continue;
        try expanded.put(dependent.key, {});
        try path.put(dependent.key, {});
        defer _ = path.remove(dependent.key);
        const child_prefix = try std.fmt.allocPrint(path.allocator, "{s}{s}", .{ prefix, if (last) "   " else "│  " });
        try printDependents(reverse, children.items, child_prefix, depth + 1, max_depth, path, expanded, stdout);
    }
}

fn workspacePackageKey(graph: *const Lockfile.Graph, path: []const u8, name: []const u8) ?[]const u8 {
    var iterator = graph.packages.iterator();
    while (iterator.next()) |entry| {
        const package = entry.value_ptr;
        if (package.kind != .workspace) continue;
        if (std.mem.eql(u8, package.source, path) or std.mem.eql(u8, package.name, name)) return package.key;
    }
    return null;
}

fn packageVersion(package: *const Lockfile.Package) []const u8 {
    if (package.version.len > 0) return package.version;
    if (package.info) |info| return jsonString(info, "version") orelse package.resolution;
    return package.resolution;
}

fn jsonString(value: *const Value, key: []const u8) ?[]const u8 {
    if (value.* != .object) return null;
    const field = value.object.get(key) orelse return null;
    return if (field == .string) field.string else null;
}

fn dependentExists(dependents: []const Dependent, key: []const u8, dependency_type: DependencyType) bool {
    for (dependents) |dependent| {
        if (dependent.dependency_type == dependency_type and std.mem.eql(u8, dependent.key, key)) return true;
    }
    return false;
}

fn lessPackage(_: void, left: *const Lockfile.Package, right: *const Lockfile.Package) bool {
    const name_order = std.mem.order(u8, left.name, right.name);
    if (name_order != .eq) return name_order == .lt;
    return std.mem.order(u8, packageVersion(left), packageVersion(right)) == .lt;
}

fn fileExists(io: std.Io, path: []const u8) bool {
    std.Io.Dir.cwd().access(io, path, .{}) catch return false;
    return true;
}

fn readOptionalFile(io: std.Io, allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(256 * 1024 * 1024));
}

test "scoped package query keeps the scope in the name" {
    const query = parseQuery("@types/react@^18");
    try std.testing.expectEqualStrings("@types/react", query.name);
    try std.testing.expectEqualStrings("^18", query.version);
}
