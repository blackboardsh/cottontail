const std = @import("std");

const Value = std.json.Value;

pub const Kind = enum {
    npm,
    folder,
    symlink,
    workspace,
    local_tarball,
    remote_tarball,
    git,
    github,
    root,
};

pub const Package = struct {
    key: []const u8,
    name: []const u8,
    resolution: []const u8,
    version: []const u8 = "",
    source: []const u8 = "",
    integrity: []const u8 = "",
    info: ?*const Value = null,
    kind: Kind,

    pub fn dependencySection(package: *const Package, section: []const u8) ?*const Value {
        const info = package.info orelse return null;
        if (info.* != .object) return null;
        const value = info.object.getPtr(section) orelse return null;
        return if (value.* == .object) value else null;
    }
};

pub const Graph = struct {
    document: Value,
    version: u32,
    root_workspace: *const Value,
    workspaces: std.StringHashMap(*const Value),
    packages: std.StringHashMap(Package),

    pub fn deinit(graph: *Graph) void {
        graph.workspaces.deinit();
        graph.packages.deinit();
    }

    pub fn get(graph: *const Graph, key: []const u8) ?*const Package {
        return graph.packages.getPtr(key);
    }

    pub fn rootMatchesPackageJSON(graph: *const Graph, package_json: *const Value) bool {
        return workspaceValueMatches(graph.root_workspace, package_json);
    }

    pub fn workspaceMatchesPackageJSON(graph: *const Graph, path: []const u8, package_json: *const Value) bool {
        const workspace = graph.workspaces.get(path) orelse return false;
        return workspaceValueMatches(workspace, package_json);
    }
};

const dependency_sections = [_][]const u8{
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
};

pub fn parseText(allocator: std.mem.Allocator, source: []const u8) !Graph {
    const json = try normalizeJsonc(allocator, source);
    var document = std.json.parseFromSliceLeaky(Value, allocator, json, .{}) catch return error.InvalidTextLockfile;
    if (document != .object) return error.InvalidTextLockfile;

    const version_value = document.object.get("lockfileVersion") orelse return error.MissingLockfileVersion;
    const version: u32 = switch (version_value) {
        .integer => |number| if (number >= 0 and number <= 1) @intCast(number) else return error.UnsupportedLockfileVersion,
        else => return error.InvalidLockfileVersion,
    };

    const workspaces_value = document.object.getPtr("workspaces") orelse return error.MissingWorkspacesObject;
    if (workspaces_value.* != .object) return error.InvalidWorkspacesObject;
    const root_workspace = workspaces_value.object.getPtr("") orelse return error.MissingRootWorkspace;
    if (root_workspace.* != .object) return error.InvalidRootWorkspace;

    var graph = Graph{
        .document = document,
        .version = version,
        .root_workspace = root_workspace,
        .workspaces = std.StringHashMap(*const Value).init(allocator),
        .packages = std.StringHashMap(Package).init(allocator),
    };
    errdefer graph.deinit();

    for (workspaces_value.object.keys(), workspaces_value.object.values()) |path, *workspace| {
        if (workspace.* != .object) return error.InvalidWorkspace;
        try graph.workspaces.put(path, workspace);
    }

    if (document.object.getPtr("packages")) |packages_value| {
        if (packages_value.* != .object) return error.InvalidPackagesObject;
        for (packages_value.object.keys(), packages_value.object.values()) |key, *entry| {
            const package = try parsePackageEntry(key, entry);
            try graph.packages.put(key, package);
        }
    }

    return graph;
}

fn parsePackageEntry(key: []const u8, entry: *const Value) !Package {
    if (entry.* != .array or entry.array.items.len == 0) return error.InvalidPackageInfo;
    const resolution_value = &entry.array.items[0];
    if (resolution_value.* != .string) return error.InvalidPackageResolution;
    const split = try splitNameAndResolution(resolution_value.string);
    const kind = resolutionKind(split.resolution);

    var package = Package{
        .key = key,
        .name = split.name,
        .resolution = split.resolution,
        .kind = kind,
    };

    switch (kind) {
        .npm => {
            if (entry.array.items.len < 2 or entry.array.items[1] != .string) return error.MissingNpmRegistry;
            package.version = split.resolution;
            package.source = entry.array.items[1].string;
            package.info = objectAt(entry, 2);
            package.integrity = stringAt(entry, 3) orelse "";
        },
        .folder, .symlink => {
            package.source = split.resolution[std.mem.indexOfScalar(u8, split.resolution, ':').? + 1 ..];
            package.info = objectAt(entry, 1);
        },
        .workspace => {
            package.source = split.resolution["workspace:".len..];
            package.info = objectAt(entry, 1);
        },
        .local_tarball, .remote_tarball => {
            package.source = split.resolution;
            package.info = objectAt(entry, 1);
            package.integrity = stringAt(entry, 2) orelse "";
        },
        .git, .github => {
            package.source = split.resolution;
            package.info = objectAt(entry, 1);
        },
        .root => {
            package.info = objectAt(entry, 1);
        },
    }
    return package;
}

fn objectAt(entry: *const Value, index: usize) ?*const Value {
    if (index >= entry.array.items.len) return null;
    const value = &entry.array.items[index];
    return if (value.* == .object) value else null;
}

fn stringAt(entry: *const Value, index: usize) ?[]const u8 {
    if (index >= entry.array.items.len) return null;
    const value = entry.array.items[index];
    return if (value == .string) value.string else null;
}

fn splitNameAndResolution(input: []const u8) !struct { name: []const u8, resolution: []const u8 } {
    if (std.mem.eql(u8, input, "@root:")) return .{ .name = "", .resolution = "root:" };

    const separator = if (std.mem.startsWith(u8, input, "@")) blk: {
        const slash = std.mem.indexOfScalar(u8, input, '/') orelse return error.InvalidPackageResolution;
        break :blk std.mem.indexOfScalarPos(u8, input, slash + 1, '@') orelse return error.InvalidPackageResolution;
    } else std.mem.indexOfScalar(u8, input, '@') orelse return error.InvalidPackageResolution;

    if (separator == 0 or separator + 1 >= input.len) return error.InvalidPackageResolution;
    return .{ .name = input[0..separator], .resolution = input[separator + 1 ..] };
}

fn resolutionKind(resolution: []const u8) Kind {
    if (std.mem.eql(u8, resolution, "root:")) return .root;
    if (std.mem.startsWith(u8, resolution, "workspace:")) return .workspace;
    if (std.mem.startsWith(u8, resolution, "link:")) return .symlink;
    if (std.mem.startsWith(u8, resolution, "file:")) return .folder;
    if (std.mem.startsWith(u8, resolution, "github:")) return .github;
    if (std.mem.startsWith(u8, resolution, "git+") or std.mem.startsWith(u8, resolution, "git://")) return .git;
    if (std.mem.startsWith(u8, resolution, "http://") or std.mem.startsWith(u8, resolution, "https://")) return .remote_tarball;
    if (isTarballPath(resolution)) return .local_tarball;
    return .npm;
}

fn isTarballPath(path: []const u8) bool {
    const without_fragment = if (std.mem.indexOfScalar(u8, path, '#')) |index| path[0..index] else path;
    const without_query = if (std.mem.indexOfScalar(u8, without_fragment, '?')) |index| without_fragment[0..index] else without_fragment;
    return std.mem.endsWith(u8, without_query, ".tgz") or std.mem.endsWith(u8, without_query, ".tar.gz");
}

fn optionalStringEqual(left: *const Value, right: *const Value, key: []const u8) bool {
    const left_value = left.object.get(key);
    const right_value = right.object.get(key);
    if (left_value == null or left_value.? != .string) return right_value == null or right_value.? != .string;
    return right_value != null and right_value.? == .string and std.mem.eql(u8, left_value.?.string, right_value.?.string);
}

fn workspaceValueMatches(workspace: *const Value, package_json: *const Value) bool {
    if (package_json.* != .object or workspace.* != .object) return false;
    if (!optionalStringEqual(workspace, package_json, "name")) return false;
    for (dependency_sections) |section| {
        if (!stringObjectEqual(workspace, package_json, section)) return false;
    }
    return true;
}

fn stringObjectEqual(left: *const Value, right: *const Value, key: []const u8) bool {
    const left_value = left.object.get(key);
    const right_value = right.object.get(key);
    const left_count = if (left_value != null and left_value.? == .object) left_value.?.object.count() else 0;
    const right_count = if (right_value != null and right_value.? == .object) right_value.?.object.count() else 0;
    if (left_count != right_count) return false;
    if (left_count == 0) return true;
    if (left_value == null or left_value.? != .object or right_value == null or right_value.? != .object) return false;

    for (left_value.?.object.keys(), left_value.?.object.values()) |name, expected| {
        if (expected != .string) return false;
        const actual = right_value.?.object.get(name) orelse return false;
        if (actual != .string or !std.mem.eql(u8, expected.string, actual.string)) return false;
    }
    return true;
}

fn normalizeJsonc(allocator: std.mem.Allocator, source: []const u8) ![]const u8 {
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
    if (state == .string or state == .block_comment) return error.InvalidTextLockfile;

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

test "parse Bun text lockfile graph and package metadata" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var graph = try parseText(allocator,
        \\{
        \\  // Bun text lockfiles are JSONC.
        \\  "lockfileVersion": 1,
        \\  "workspaces": {
        \\    "": { "name": "app", "dependencies": { "foo": "^1.0.0" }, },
        \\  },
        \\  "packages": {
        \\    "foo": ["foo@1.2.3", "", { "dependencies": { "bar": "2.0.0" } }, "sha512-a"],
        \\    "foo/bar": ["bar@2.0.0", "https://registry.example/bar.tgz", {}, "sha512-b"],
        \\  },
        \\}
    );
    defer graph.deinit();

    try std.testing.expectEqual(@as(u32, 1), graph.version);
    const foo = graph.get("foo").?;
    try std.testing.expectEqual(Kind.npm, foo.kind);
    try std.testing.expectEqualStrings("1.2.3", foo.version);
    try std.testing.expectEqualStrings("2.0.0", foo.dependencySection("dependencies").?.object.get("bar").?.string);
    try std.testing.expectEqualStrings("https://registry.example/bar.tgz", graph.get("foo/bar").?.source);
}

test "frozen root comparison is order independent and exact" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var graph = try parseText(allocator,
        \\{"lockfileVersion":1,"workspaces":{"":{"name":"app","dependencies":{"a":"^1","b":"2"}}},"packages":{}}
    );
    defer graph.deinit();

    const matching = try std.json.parseFromSliceLeaky(Value, allocator,
        \\{"dependencies":{"b":"2","a":"^1"},"name":"app"}
    , .{});
    const changed = try std.json.parseFromSliceLeaky(Value, allocator,
        \\{"name":"app","dependencies":{"a":"^2","b":"2"}}
    , .{});
    try std.testing.expect(graph.rootMatchesPackageJSON(&matching));
    try std.testing.expect(!graph.rootMatchesPackageJSON(&changed));
}

test "parse scoped and non-registry resolutions" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var graph = try parseText(allocator,
        \\{"lockfileVersion":1,"workspaces":{"":{}},"packages":{
        \\  "@scope/pkg":["@scope/pkg@workspace:packages/pkg"],
        \\  "linked":["linked@link:../linked",{}],
        \\  "archive":["archive@./archive.tgz",{},"sha512-c"]
        \\}}
    );
    defer graph.deinit();

    try std.testing.expectEqual(Kind.workspace, graph.get("@scope/pkg").?.kind);
    try std.testing.expectEqualStrings("packages/pkg", graph.get("@scope/pkg").?.source);
    try std.testing.expectEqual(Kind.symlink, graph.get("linked").?.kind);
    try std.testing.expectEqual(Kind.local_tarball, graph.get("archive").?.kind);
}

test "frozen workspace comparison covers workspace dependency graphs" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var graph = try parseText(allocator,
        \\{"lockfileVersion":1,"workspaces":{
        \\  "": {"name":"app"},
        \\  "packages/api":{"name":"@app/api","dependencies":{"foo":"1.0.0"}}
        \\},"packages":{}}
    );
    defer graph.deinit();

    const matching = try std.json.parseFromSliceLeaky(Value, allocator,
        \\{"dependencies":{"foo":"1.0.0"},"name":"@app/api"}
    , .{});
    const changed = try std.json.parseFromSliceLeaky(Value, allocator,
        \\{"name":"@app/api","dependencies":{"foo":"2.0.0"}}
    , .{});
    try std.testing.expect(graph.workspaceMatchesPackageJSON("packages/api", &matching));
    try std.testing.expect(!graph.workspaceMatchesPackageJSON("packages/api", &changed));
}
