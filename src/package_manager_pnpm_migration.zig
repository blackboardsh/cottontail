const std = @import("std");
const compiler = @import("cottontail_compiler");
const Lockfile = @import("package_manager_lockfile.zig");

const Value = std.json.Value;

pub const ParseError = error{
    InvalidPnpmLockfile,
    PnpmLockfileTooOld,
} || std.mem.Allocator.Error;

const dependency_sections = [_][]const u8{
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
};

const runtime_dependency_sections = [_][]const u8{
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
};

const Entry = struct {
    selector: []const u8,
    name: []const u8,
    version: []const u8,
    source: []const u8,
    kind: Lockfile.Kind,
    integrity: []const u8,
    metadata: *Value,
};

const State = struct {
    allocator: std.mem.Allocator,
    graph: *Lockfile.Graph,
    entries: []const Entry,
    selectors: *const std.StringHashMap(usize),
    direct_names: std.StringHashMap(void),
    direct_references: std.StringHashMap([]const u8),
    placed_selectors: std.StringHashMap([]const u8),
    resolving: std.StringHashMap(void),
};

pub fn parse(
    io: std.Io,
    allocator: std.mem.Allocator,
    root_dir: []const u8,
    root: *const Value,
    source: []const u8,
) ParseError!Lockfile.Graph {
    compiler.install.initializeStore();
    var log = compiler.logger.Log.init(allocator);
    defer log.deinit();
    const yaml_source = compiler.logger.Source.initPathString("pnpm-lock.yaml", source);
    const yaml = compiler.interchange.yaml.YAML.parse(&yaml_source, &log, allocator) catch return error.InvalidPnpmLockfile;
    var document = try yamlToJson(allocator, &yaml);
    if (document != .object) return error.InvalidPnpmLockfile;

    const lockfile_version = pnpmLockfileVersion(&document) orelse return error.InvalidPnpmLockfile;
    if (lockfile_version < 7) return error.PnpmLockfileTooOld;

    const importers = objectField(&document, "importers") orelse return error.InvalidPnpmLockfile;
    const root_importer = importers.getPtr(".") orelse return error.InvalidPnpmLockfile;
    const root_workspace = try buildLockWorkspace(allocator, root, root_importer);
    const package_json_changed = try migrateRootPolicy(allocator, root, &document);

    var graph = Lockfile.Graph{
        .document = root.*,
        .version = 1,
        .config_version = .v1,
        .provenance = .pnpm,
        .root_workspace = root_workspace,
        .workspaces = std.StringHashMap(*const Value).init(allocator),
        .packages = std.StringHashMap(Lockfile.Package).init(allocator),
        .package_json_changed = package_json_changed,
    };
    errdefer graph.deinit();
    try graph.workspaces.put("", root_workspace);

    try appendWorkspaces(io, allocator, root_dir, importers, &graph);

    var entries_list = std.array_list.Managed(Entry).init(allocator);
    const packages = objectField(&document, "packages");
    const snapshots = objectField(&document, "snapshots");
    if (snapshots) |snapshot_map| {
        const package_map = packages orelse return error.InvalidPnpmLockfile;
        for (snapshot_map.keys(), snapshot_map.values()) |selector, *snapshot_value| {
            const identity = parseSelector(selector) orelse return error.InvalidPnpmLockfile;
            const package_value = try findPackage(allocator, package_map, selector, identity);
            const metadata = try buildMetadata(allocator, package_value, snapshot_value);
            const resolution = classifyResolution(identity.version);
            try entries_list.append(.{
                .selector = trimLeadingSlash(selector),
                .name = identity.name,
                .version = identity.version,
                .source = resolution.source,
                .kind = resolution.kind,
                .integrity = packageIntegrity(package_value),
                .metadata = metadata,
            });
        }
    } else if (packages) |package_map| {
        for (package_map.keys(), package_map.values()) |selector, *package_value| {
            const identity = parseSelector(selector) orelse return error.InvalidPnpmLockfile;
            const metadata = try buildMetadata(allocator, package_value, null);
            const resolution = classifyResolution(identity.version);
            try entries_list.append(.{
                .selector = trimLeadingSlash(selector),
                .name = identity.name,
                .version = identity.version,
                .source = resolution.source,
                .kind = resolution.kind,
                .integrity = packageIntegrity(package_value),
                .metadata = metadata,
            });
        }
    }

    var selectors = std.StringHashMap(usize).init(allocator);
    defer selectors.deinit();
    for (entries_list.items, 0..) |entry, index| {
        try putSelector(&selectors, entry.selector, index);
        const base = try std.fmt.allocPrint(allocator, "{s}@{s}", .{ entry.name, entry.version });
        try putSelector(&selectors, base, index);
    }

    var state = State{
        .allocator = allocator,
        .graph = &graph,
        .entries = entries_list.items,
        .selectors = &selectors,
        .direct_names = std.StringHashMap(void).init(allocator),
        .direct_references = std.StringHashMap([]const u8).init(allocator),
        .placed_selectors = std.StringHashMap([]const u8).init(allocator),
        .resolving = std.StringHashMap(void).init(allocator),
    };
    defer state.direct_names.deinit();
    defer state.direct_references.deinit();
    defer state.placed_selectors.deinit();
    defer state.resolving.deinit();

    if (state.graph.root_workspace.* == .object) {
        for (dependency_sections) |section_name| {
            const section = state.graph.root_workspace.object.get(section_name) orelse continue;
            if (section != .object) continue;
            for (section.object.keys()) |name| try state.direct_names.put(name, {});
        }
    }
    if (root_importer.* == .object) {
        for (dependency_sections) |section_name| {
            const section = root_importer.object.get(section_name) orelse continue;
            if (section != .object) continue;
            for (section.object.keys(), section.object.values()) |name, dependency| {
                const reference = dependencyReference(dependency) orelse continue;
                const entry = try state.direct_references.getOrPut(name);
                if (!entry.found_existing) entry.value_ptr.* = reference;
            }
        }
    }

    for (importers.keys(), importers.values()) |raw_path, *importer| {
        if (importer.* != .object) return error.InvalidPnpmLockfile;
        const importer_path = if (std.mem.eql(u8, raw_path, ".")) "" else raw_path;
        const parent_key = if (importer_path.len == 0)
            ""
        else blk: {
            const workspace = graph.workspaces.get(importer_path) orelse return error.InvalidPnpmLockfile;
            break :blk jsonString(workspace, "name") orelse return error.InvalidPnpmLockfile;
        };
        var importer_names = std.StringHashMap(void).init(allocator);
        defer importer_names.deinit();

        for (dependency_sections) |section_name| {
            const section = importer.object.get(section_name) orelse continue;
            if (section != .object) return error.InvalidPnpmLockfile;
            for (section.object.keys(), section.object.values()) |alias, dependency| {
                const name_entry = try importer_names.getOrPut(alias);
                if (name_entry.found_existing) continue;
                const reference = dependencyReference(dependency) orelse continue;
                if (try placeWorkspaceReference(&state, importer_path, alias, reference)) continue;
                _ = placeDependency(&state, alias, reference, parent_key, importer_path.len == 0) catch |err| {
                    if (std.mem.eql(u8, section_name, "optionalDependencies") or
                        std.mem.eql(u8, section_name, "peerDependencies")) continue;
                    return err;
                };
            }
        }
    }

    return graph;
}

fn yamlToJson(allocator: std.mem.Allocator, expr: *const compiler.ast.Expr) ParseError!Value {
    return switch (expr.data) {
        .e_null, .e_undefined => .null,
        .e_boolean, .e_branch_boolean => |boolean| .{ .bool = boolean.value },
        .e_number => |number| if (std.math.isFinite(number.value) and
            number.value == @trunc(number.value) and
            number.value >= @as(f64, @floatFromInt(std.math.minInt(i64))) and
            number.value <= @as(f64, @floatFromInt(std.math.maxInt(i64))))
            .{ .integer = @intFromFloat(number.value) }
        else
            .{ .float = number.value },
        .e_string => |string| .{ .string = try allocator.dupe(u8, string.slice(allocator)) },
        .e_array => |array| blk: {
            var values = std.json.Array.init(allocator);
            for (array.items.slice()) |*item| try values.append(try yamlToJson(allocator, item));
            break :blk .{ .array = values };
        },
        .e_object => |object| blk: {
            var values: std.json.ObjectMap = .empty;
            for (object.properties.slice()) |property| {
                const key_expr = property.key orelse return error.InvalidPnpmLockfile;
                const value_expr = property.value orelse return error.InvalidPnpmLockfile;
                const key = key_expr.asString(allocator) orelse return error.InvalidPnpmLockfile;
                try values.put(allocator, try allocator.dupe(u8, key), try yamlToJson(allocator, &value_expr));
            }
            break :blk .{ .object = values };
        },
        else => error.InvalidPnpmLockfile,
    };
}

fn pnpmLockfileVersion(document: *const Value) ?f64 {
    const value = document.object.get("lockfileVersion") orelse return null;
    return switch (value) {
        .integer => |number| @floatFromInt(number),
        .float => |number| number,
        .string => |text| blk: {
            const end = std.mem.indexOfScalar(u8, text, '.') orelse text.len;
            break :blk std.fmt.parseFloat(f64, text[0..end]) catch return null;
        },
        else => null,
    };
}

fn appendWorkspaces(
    io: std.Io,
    allocator: std.mem.Allocator,
    root_dir: []const u8,
    importers: *const std.json.ObjectMap,
    graph: *Lockfile.Graph,
) ParseError!void {
    for (importers.keys(), importers.values()) |path, *importer| {
        if (std.mem.eql(u8, path, ".")) continue;
        if (importer.* != .object) return error.InvalidPnpmLockfile;
        const package_path = try std.fs.path.join(allocator, &.{ root_dir, path, "package.json" });
        const source = std.Io.Dir.cwd().readFileAlloc(io, package_path, allocator, .limited(64 * 1024 * 1024)) catch return error.InvalidPnpmLockfile;
        const package_json = try allocator.create(Value);
        package_json.* = std.json.parseFromSliceLeaky(Value, allocator, source, .{}) catch return error.InvalidPnpmLockfile;
        if (package_json.* != .object) return error.InvalidPnpmLockfile;
        const name = jsonString(package_json, "name") orelse return error.InvalidPnpmLockfile;
        const lock_workspace = try buildLockWorkspace(allocator, package_json, importer);
        try graph.workspaces.put(try allocator.dupe(u8, path), lock_workspace);
        try graph.packages.put(try allocator.dupe(u8, name), .{
            .key = try allocator.dupe(u8, name),
            .name = name,
            .resolution = try std.fmt.allocPrint(allocator, "workspace:{s}", .{path}),
            .version = jsonString(package_json, "version") orelse "",
            .source = path,
            .info = lock_workspace,
            .kind = .workspace,
        });
    }
}

fn buildLockWorkspace(
    allocator: std.mem.Allocator,
    root: *const Value,
    importer: *const Value,
) ParseError!*Value {
    if (root.* != .object or importer.* != .object) return error.InvalidPnpmLockfile;
    const workspace = try allocator.create(Value);
    workspace.* = .{ .object = .empty };
    if (root.object.get("name")) |name| {
        if (name != .string) return error.InvalidPnpmLockfile;
        try workspace.object.put(allocator, "name", name);
    }
    var migrated_names = std.StringHashMap(void).init(allocator);
    defer migrated_names.deinit();
    for ([_][]const u8{ "dependencies", "devDependencies", "optionalDependencies" }) |section_name| {
        const section = importer.object.get(section_name) orelse continue;
        if (section != .object) return error.InvalidPnpmLockfile;
        var migrated: std.json.ObjectMap = .empty;
        for (section.object.keys(), section.object.values()) |alias, dependency| {
            const name_entry = try migrated_names.getOrPut(alias);
            if (name_entry.found_existing) continue;
            const specifier = dependencySpecifier(dependency) orelse return error.InvalidPnpmLockfile;
            const lock_specifier = if (std.mem.startsWith(u8, specifier, "catalog:"))
                dependencyReference(dependency) orelse return error.InvalidPnpmLockfile
            else
                specifier;
            try migrated.put(
                allocator,
                try allocator.dupe(u8, alias),
                .{ .string = try allocator.dupe(u8, stripPnpmSuffix(lock_specifier)) },
            );
        }
        if (migrated.count() > 0) try workspace.object.put(allocator, section_name, .{ .object = migrated });
    }
    return workspace;
}

fn migrateRootPolicy(allocator: std.mem.Allocator, root_const: *const Value, document: *const Value) ParseError!bool {
    const root = @constCast(root_const);
    if (root.* != .object) return error.InvalidPnpmLockfile;
    var changed = false;
    var nested_overrides: ?Value = null;
    var nested_patched: ?Value = null;
    var remove_pnpm = false;

    if (root.object.getPtr("pnpm")) |pnpm| {
        if (pnpm.* != .object) return error.InvalidPnpmLockfile;
        if (pnpm.object.get("overrides")) |overrides| {
            nested_overrides = overrides;
            _ = pnpm.object.orderedRemove("overrides");
            changed = true;
        }
        if (pnpm.object.get("patchedDependencies")) |patched| {
            nested_patched = patched;
            _ = pnpm.object.orderedRemove("patchedDependencies");
            changed = true;
        }
        remove_pnpm = pnpm.object.count() == 0;
    }
    if (remove_pnpm) _ = root.object.orderedRemove("pnpm");
    if (nested_overrides) |overrides| try mergeStringPolicy(allocator, root, "overrides", overrides);
    if (nested_patched) |patched| try mergeStringPolicy(allocator, root, "patchedDependencies", patched);

    if (document.object.get("overrides")) |overrides| {
        try mergeStringPolicy(allocator, root, "overrides", overrides);
        changed = true;
    }
    if (document.object.get("patchedDependencies")) |patched| {
        if (patched != .object) return error.InvalidPnpmLockfile;
        const migrated = try ensurePolicyObject(allocator, root, "patchedDependencies");
        for (patched.object.keys(), patched.object.values()) |name, value| {
            if (value != .object) return error.InvalidPnpmLockfile;
            const path = jsonString(&value, "path") orelse return error.InvalidPnpmLockfile;
            try migrated.put(
                allocator,
                try allocator.dupe(u8, name),
                .{ .string = try allocator.dupe(u8, path) },
            );
        }
        changed = true;
    }
    if (try migrateCatalogs(allocator, root, document)) changed = true;
    return changed;
}

fn migrateCatalogs(
    allocator: std.mem.Allocator,
    root: *Value,
    document: *const Value,
) ParseError!bool {
    const source = document.object.get("catalogs") orelse return false;
    if (source != .object) return error.InvalidPnpmLockfile;

    var default_catalog: std.json.ObjectMap = .empty;
    var catalog_groups: std.json.ObjectMap = .empty;
    for (source.object.keys(), source.object.values()) |group_name, group_value| {
        if (group_value != .object) return error.InvalidPnpmLockfile;
        var migrated_group: std.json.ObjectMap = .empty;
        for (group_value.object.keys(), group_value.object.values()) |name, entry| {
            if (entry != .object) return error.InvalidPnpmLockfile;
            const specifier = jsonString(&entry, "specifier") orelse return error.InvalidPnpmLockfile;
            try migrated_group.put(
                allocator,
                try allocator.dupe(u8, name),
                .{ .string = try allocator.dupe(u8, specifier) },
            );
        }
        if (std.mem.eql(u8, group_name, "default")) {
            default_catalog = migrated_group;
        } else {
            try catalog_groups.put(
                allocator,
                try allocator.dupe(u8, group_name),
                .{ .object = migrated_group },
            );
        }
    }

    if (default_catalog.count() == 0 and catalog_groups.count() == 0) return false;
    const workspaces = try ensureWorkspacePolicyObject(allocator, root);
    if (default_catalog.count() > 0) {
        try workspaces.put(allocator, "catalog", .{ .object = default_catalog });
    }
    if (catalog_groups.count() > 0) {
        try workspaces.put(allocator, "catalogs", .{ .object = catalog_groups });
    }
    return true;
}

fn ensureWorkspacePolicyObject(
    allocator: std.mem.Allocator,
    root: *Value,
) ParseError!*std.json.ObjectMap {
    if (root.object.getPtr("workspaces")) |workspaces| {
        switch (workspaces.*) {
            .object => return &workspaces.object,
            .array => {
                const packages = workspaces.*;
                workspaces.* = .{ .object = .empty };
                try workspaces.object.put(allocator, "packages", packages);
                return &workspaces.object;
            },
            else => return error.InvalidPnpmLockfile,
        }
    }
    try root.object.put(allocator, "workspaces", .{ .object = .empty });
    return &root.object.getPtr("workspaces").?.object;
}

fn buildMetadata(allocator: std.mem.Allocator, package: *const Value, snapshot: ?*const Value) ParseError!*Value {
    const metadata = try allocator.create(Value);
    metadata.* = .{ .object = .empty };
    if (package.* != .object) return error.InvalidPnpmLockfile;

    const dependency_source = if (snapshot) |value|
        if (value.* == .object) value.object.get("dependencies") else null
    else
        package.object.get("dependencies");
    const package_peers = objectField(package, "peerDependencies");
    var dependencies: std.json.ObjectMap = .empty;
    var peers: std.json.ObjectMap = .empty;
    if (dependency_source) |source| {
        if (source != .object) return error.InvalidPnpmLockfile;
        for (source.object.keys(), source.object.values()) |name, dependency| {
            const reference = dependencyReference(dependency) orelse return error.InvalidPnpmLockfile;
            const normalized = stripPnpmSuffix(reference);
            const destination = if (package_peers != null and package_peers.?.get(name) != null)
                &peers
            else
                &dependencies;
            try destination.put(
                allocator,
                try allocator.dupe(u8, name),
                .{ .string = try allocator.dupe(u8, normalized) },
            );
        }
    }
    if (dependencies.count() > 0) try metadata.object.put(allocator, "dependencies", .{ .object = dependencies });
    if (peers.count() > 0) try metadata.object.put(allocator, "peerDependencies", .{ .object = peers });

    for ([_][]const u8{ "devDependencies", "optionalDependencies" }) |field| {
        const source = if (snapshot) |value|
            if (value.* == .object) value.object.get(field) else null
        else
            package.object.get(field);
        if (source) |contents| {
            const normalized = try normalizeDependencySection(allocator, contents);
            if (normalized.object.count() > 0) try metadata.object.put(allocator, field, normalized);
        }
    }
    for ([_][]const u8{ "os", "cpu", "bin" }) |field| {
        if (package.object.get(field)) |contents| try metadata.object.put(allocator, field, contents);
    }
    if (peers.count() > 0) {
        if (package.object.get("peerDependenciesMeta")) |contents| {
            try metadata.object.put(allocator, "peerDependenciesMeta", contents);
        }
    }
    return metadata;
}

fn normalizeDependencySection(allocator: std.mem.Allocator, source: Value) ParseError!Value {
    if (source != .object) return error.InvalidPnpmLockfile;
    var normalized: std.json.ObjectMap = .empty;
    for (source.object.keys(), source.object.values()) |name, dependency| {
        const reference = dependencyReference(dependency) orelse return error.InvalidPnpmLockfile;
        try normalized.put(
            allocator,
            try allocator.dupe(u8, name),
            .{ .string = try allocator.dupe(u8, stripPnpmSuffix(reference)) },
        );
    }
    return .{ .object = normalized };
}

fn ensurePolicyObject(
    allocator: std.mem.Allocator,
    root: *Value,
    field: []const u8,
) ParseError!*std.json.ObjectMap {
    if (root.object.getPtr(field)) |value| {
        if (value.* != .object) return error.InvalidPnpmLockfile;
        return &value.object;
    }
    try root.object.put(allocator, try allocator.dupe(u8, field), .{ .object = .empty });
    return &root.object.getPtr(field).?.object;
}

fn mergeStringPolicy(
    allocator: std.mem.Allocator,
    root: *Value,
    field: []const u8,
    source: Value,
) ParseError!void {
    if (source != .object) return error.InvalidPnpmLockfile;
    const destination = try ensurePolicyObject(allocator, root, field);
    for (source.object.keys(), source.object.values()) |name, value| {
        if (value != .string) return error.InvalidPnpmLockfile;
        try destination.put(
            allocator,
            try allocator.dupe(u8, name),
            .{ .string = try allocator.dupe(u8, value.string) },
        );
    }
}

fn packageIntegrity(package: *const Value) []const u8 {
    if (package.* != .object) return "";
    const resolution = package.object.get("resolution") orelse return "";
    if (resolution != .object) return "";
    return jsonString(&resolution, "integrity") orelse "";
}

fn findPackage(
    allocator: std.mem.Allocator,
    packages: *const std.json.ObjectMap,
    selector: []const u8,
    identity: Identity,
) ParseError!*const Value {
    if (packages.getPtr(selector)) |value| return value;
    if (packages.getPtr(trimLeadingSlash(selector))) |value| return value;
    const base = try std.fmt.allocPrint(allocator, "{s}@{s}", .{ identity.name, identity.version });
    if (packages.getPtr(base)) |value| return value;
    const slash_base = try std.fmt.allocPrint(allocator, "/{s}", .{base});
    return packages.getPtr(slash_base) orelse error.InvalidPnpmLockfile;
}

fn putSelector(selectors: *std.StringHashMap(usize), key: []const u8, index: usize) !void {
    const entry = try selectors.getOrPut(key);
    if (!entry.found_existing) entry.value_ptr.* = index;
}

const Identity = struct {
    name: []const u8,
    version: []const u8,
};

fn parseSelector(raw: []const u8) ?Identity {
    const selector = trimLeadingSlash(raw);
    const suffix = std.mem.indexOfScalar(u8, selector, '(') orelse selector.len;
    const base = selector[0..suffix];
    const at = std.mem.lastIndexOfScalar(u8, base, '@');
    if (at) |index| {
        if (index > 0) {
            return .{ .name = base[0..index], .version = base[index + 1 ..] };
        }
    }
    const slash = std.mem.lastIndexOfScalar(u8, base, '/') orelse return null;
    if (slash == 0 or slash + 1 >= base.len) return null;
    return .{ .name = base[0..slash], .version = base[slash + 1 ..] };
}

fn classifyResolution(resolution: []const u8) struct { kind: Lockfile.Kind, source: []const u8 } {
    if (std.mem.startsWith(u8, resolution, "file:")) {
        const source = resolution["file:".len..];
        return .{
            .kind = if (isTarballPath(source)) .local_tarball else .folder,
            .source = source,
        };
    }
    if (std.mem.startsWith(u8, resolution, "http://") or std.mem.startsWith(u8, resolution, "https://")) {
        return .{ .kind = .remote_tarball, .source = resolution };
    }
    if (std.mem.startsWith(u8, resolution, "github:")) {
        return .{ .kind = .github, .source = resolution };
    }
    if (std.mem.startsWith(u8, resolution, "git+") or
        std.mem.startsWith(u8, resolution, "git://") or
        std.mem.startsWith(u8, resolution, "ssh://") or
        std.mem.startsWith(u8, resolution, "git@"))
    {
        return .{ .kind = .git, .source = resolution };
    }
    return .{ .kind = .npm, .source = "" };
}

fn isTarballPath(path: []const u8) bool {
    const without_fragment = if (std.mem.indexOfScalar(u8, path, '#')) |index| path[0..index] else path;
    const without_query = if (std.mem.indexOfScalar(u8, without_fragment, '?')) |index| without_fragment[0..index] else without_fragment;
    return std.mem.endsWith(u8, without_query, ".tgz") or std.mem.endsWith(u8, without_query, ".tar.gz");
}

fn trimLeadingSlash(value: []const u8) []const u8 {
    return if (value.len > 0 and value[0] == '/') value[1..] else value;
}

fn dependencyReference(value: Value) ?[]const u8 {
    return switch (value) {
        .string => |text| text,
        .object => |object| blk: {
            const version = object.get("version") orelse return null;
            break :blk if (version == .string) version.string else null;
        },
        else => null,
    };
}

fn dependencySpecifier(value: Value) ?[]const u8 {
    return switch (value) {
        .string => |text| text,
        .object => |object| blk: {
            const specifier = object.get("specifier") orelse return null;
            break :blk if (specifier == .string) specifier.string else null;
        },
        else => null,
    };
}

fn stripPnpmSuffix(value: []const u8) []const u8 {
    if (value.len < 2 or value[value.len - 1] != ')') return value;
    const suffix = std.mem.indexOfScalar(u8, value, '(') orelse return value;
    return value[0..suffix];
}

fn placeWorkspaceReference(
    state: *State,
    importer_path: []const u8,
    alias: []const u8,
    reference: []const u8,
) ParseError!bool {
    if (!std.mem.startsWith(u8, reference, "link:") and !std.mem.startsWith(u8, reference, "workspace:")) return false;
    if (std.mem.startsWith(u8, reference, "workspace:")) {
        if (state.graph.packages.get(alias)) |package| return package.kind == .workspace;
        return false;
    }

    const joined = try std.fs.path.join(state.allocator, &.{ importer_path, reference["link:".len..] });
    const normalized = try normalizeRelativePath(state.allocator, joined);
    const workspace = state.graph.workspaces.get(normalized) orelse return false;
    const name = jsonString(workspace, "name") orelse return error.InvalidPnpmLockfile;
    const package = state.graph.packages.get(name) orelse return false;
    if (!std.mem.eql(u8, alias, name) and state.graph.packages.get(alias) == null) {
        const key = try state.allocator.dupe(u8, alias);
        var aliased_package = package;
        aliased_package.key = key;
        try state.graph.packages.put(key, aliased_package);
    }
    return true;
}

fn placeDependency(
    state: *State,
    alias: []const u8,
    reference: []const u8,
    parent_key: []const u8,
    direct: bool,
) ParseError![]const u8 {
    if (std.mem.eql(u8, reference, "link:") or std.mem.eql(u8, reference, "link:.")) {
        const root_reserved = !direct and state.direct_names.contains(alias);
        const key = if (direct or (!root_reserved and state.graph.packages.get(alias) == null))
            try state.allocator.dupe(u8, alias)
        else
            try std.fmt.allocPrint(state.allocator, "{s}/{s}", .{ parent_key, alias });
        const root_name = jsonString(state.graph.root_workspace, "name") orelse alias;
        try state.graph.packages.put(key, .{
            .key = key,
            .name = root_name,
            .resolution = "workspace:.",
            .source = ".",
            .info = state.graph.root_workspace,
            .kind = .workspace,
        });
        return key;
    }

    const entry_index = findEntry(state, alias, reference) orelse return error.InvalidPnpmLockfile;
    const entry = state.entries[entry_index];
    const root_package = state.graph.packages.get(alias);
    const root_selector = state.placed_selectors.get(alias);
    const root_reserved = !direct and state.direct_names.contains(alias);
    const compatible_root = root_package != null and root_selector != null and std.mem.eql(u8, root_selector.?, entry.selector);
    const compatible_direct = if (state.direct_references.get(alias)) |direct_reference|
        if (findEntry(state, alias, direct_reference)) |direct_entry_index|
            direct_entry_index == entry_index
        else
            false
    else
        false;
    const key = if (direct)
        try state.allocator.dupe(u8, alias)
    else if (root_reserved and compatible_direct and (root_package == null or compatible_root))
        try state.allocator.dupe(u8, alias)
    else if (!root_reserved and (root_package == null or compatible_root))
        try state.allocator.dupe(u8, alias)
    else
        try std.fmt.allocPrint(state.allocator, "{s}/{s}", .{ parent_key, alias });

    if (state.placed_selectors.get(key)) |selector| {
        if (std.mem.eql(u8, selector, entry.selector)) return key;
    }

    const cycle_key = try std.fmt.allocPrint(state.allocator, "{d}:{s}", .{ entry_index, key });
    if (state.resolving.contains(cycle_key)) return key;
    try state.resolving.put(cycle_key, {});
    defer _ = state.resolving.remove(cycle_key);

    try state.graph.packages.put(key, .{
        .key = key,
        .name = entry.name,
        .resolution = entry.version,
        .version = if (entry.kind == .npm) entry.version else "",
        .source = entry.source,
        .integrity = entry.integrity,
        .info = entry.metadata,
        .kind = entry.kind,
    });
    try state.placed_selectors.put(key, entry.selector);

    for (runtime_dependency_sections) |section_name| {
        const section = entry.metadata.object.get(section_name) orelse continue;
        if (section != .object) continue;
        for (section.object.keys(), section.object.values()) |dependency_alias, dependency| {
            const dependency_reference = dependencyReference(dependency) orelse continue;
            _ = placeDependency(state, dependency_alias, dependency_reference, key, false) catch |err| {
                if (std.mem.eql(u8, section_name, "optionalDependencies")) continue;
                return err;
            };
        }
    }
    return key;
}

fn findEntry(state: *const State, alias: []const u8, reference_raw: []const u8) ?usize {
    var reference = trimLeadingSlash(reference_raw);
    if (std.mem.startsWith(u8, reference, "npm:")) reference = reference["npm:".len..];
    if (state.selectors.get(reference)) |index| return index;
    var buffer: [8192]u8 = undefined;
    const selector = std.fmt.bufPrint(&buffer, "{s}@{s}", .{ alias, reference }) catch return null;
    if (state.selectors.get(selector)) |index| return index;
    return null;
}

fn normalizeRelativePath(allocator: std.mem.Allocator, path: []const u8) ParseError![]const u8 {
    var parts = std.array_list.Managed([]const u8).init(allocator);
    var iterator = std.mem.tokenizeAny(u8, path, "/\\");
    while (iterator.next()) |part| {
        if (std.mem.eql(u8, part, ".")) continue;
        if (std.mem.eql(u8, part, "..")) {
            if (parts.items.len == 0) return error.InvalidPnpmLockfile;
            _ = parts.pop();
            continue;
        }
        try parts.append(part);
    }
    return std.mem.join(allocator, "/", parts.items);
}

fn objectField(value: *const Value, key: []const u8) ?*const std.json.ObjectMap {
    if (value.* != .object) return null;
    const field = value.object.getPtr(key) orelse return null;
    return if (field.* == .object) &field.object else null;
}

fn jsonString(value: *const Value, key: []const u8) ?[]const u8 {
    if (value.* != .object) return null;
    const field = value.object.get(key) orelse return null;
    return if (field == .string) field.string else null;
}
