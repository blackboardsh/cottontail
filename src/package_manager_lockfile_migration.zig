const std = @import("std");
const Lockfile = @import("package_manager_lockfile.zig");
const Workspaces = @import("package_manager_workspaces.zig");

const Value = std.json.Value;

const dependency_sections = [_][]const u8{
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
};
const runtime_dependency_sections = [_][]const u8{
    "dependencies",
    "optionalDependencies",
};

pub const Source = enum {
    npm,
    yarn,
    pnpm,

    pub fn filename(source: Source) []const u8 {
        return switch (source) {
            .npm => "package-lock.json",
            .yarn => "yarn.lock",
            .pnpm => "pnpm-lock.yaml",
        };
    }
};

pub const IgnoreReason = enum {
    invalid_npm_lockfile,
    invalid_yarn_lockfile,
    pnpm_not_implemented,
};

pub const Detection = union(enum) {
    not_found,
    migrated: struct {
        graph: Lockfile.Graph,
        source: Source,
    },
    ignored: struct {
        source: Source,
        reason: IgnoreReason,
    },
};

pub fn detect(
    io: std.Io,
    allocator: std.mem.Allocator,
    root_dir: []const u8,
    root: *const Value,
) !Detection {
    const npm_path = try std.fs.path.join(allocator, &.{ root_dir, Source.npm.filename() });
    if (try readOptional(io, allocator, npm_path, 256 * 1024 * 1024)) |source| {
        const graph = parseNpm(allocator, io, root_dir, root, source) catch |err| switch (err) {
            error.NPMLockfileVersionMismatch => return err,
            else => return .{ .ignored = .{ .source = .npm, .reason = .invalid_npm_lockfile } },
        };
        return .{ .migrated = .{ .graph = graph, .source = .npm } };
    }

    const yarn_path = try std.fs.path.join(allocator, &.{ root_dir, Source.yarn.filename() });
    if (try readOptional(io, allocator, yarn_path, 256 * 1024 * 1024)) |source| {
        var graph = parseYarn(allocator, root, source) catch {
            return .{ .ignored = .{ .source = .yarn, .reason = .invalid_yarn_lockfile } };
        };
        appendYarnWorkspaces(io, allocator, root_dir, root, &graph) catch {
            graph.deinit();
            return .{ .ignored = .{ .source = .yarn, .reason = .invalid_yarn_lockfile } };
        };
        return .{ .migrated = .{ .graph = graph, .source = .yarn } };
    }

    const pnpm_path = try std.fs.path.join(allocator, &.{ root_dir, Source.pnpm.filename() });
    if (try readOptional(io, allocator, pnpm_path, 256 * 1024 * 1024) != null) {
        return .{ .ignored = .{ .source = .pnpm, .reason = .pnpm_not_implemented } };
    }
    return .not_found;
}

fn readOptional(
    io: std.Io,
    allocator: std.mem.Allocator,
    path: []const u8,
    limit: usize,
) !?[]const u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(limit)) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
}

pub fn parseNpm(
    allocator: std.mem.Allocator,
    io: std.Io,
    root_dir: []const u8,
    root: *const Value,
    source: []const u8,
) !Lockfile.Graph {
    var document = std.json.parseFromSliceLeaky(Value, allocator, source, .{}) catch return error.InvalidNPMLockfile;
    if (document != .object) return error.InvalidNPMLockfile;
    const lockfile_version = document.object.get("lockfileVersion") orelse return error.InvalidNPMLockfile;
    if (lockfile_version != .integer) return error.InvalidNPMLockfile;
    if (lockfile_version.integer < 2 or lockfile_version.integer > 3) return error.NPMLockfileVersionMismatch;
    const packages_value = document.object.getPtr("packages") orelse return error.InvalidNPMLockfile;
    if (packages_value.* != .object or packages_value.object.getPtr("") == null) return error.InvalidNPMLockfile;

    var graph = Lockfile.Graph{
        .document = root.*,
        .version = 1,
        .config_version = .v0,
        .provenance = .npm,
        .root_workspace = root,
        .workspaces = std.StringHashMap(*const Value).init(allocator),
        .packages = std.StringHashMap(Lockfile.Package).init(allocator),
    };
    errdefer graph.deinit();
    try graph.workspaces.put("", root);

    for (packages_value.object.keys(), packages_value.object.values()) |raw_path, *package_value| {
        if (raw_path.len == 0) continue;
        if (package_value.* != .object) return error.InvalidNPMLockfile;
        if (jsonBool(package_value, "extraneous") or jsonBool(package_value, "inBundle")) continue;

        const normalized_path = try normalizePath(allocator, raw_path);
        if (jsonBool(package_value, "link")) {
            try appendNpmLink(
                allocator,
                io,
                root_dir,
                root,
                &graph,
                normalized_path,
                package_value,
                &packages_value.object,
            );
            continue;
        }
        if (std.mem.indexOf(u8, normalized_path, "node_modules/") == null and
            !std.mem.startsWith(u8, normalized_path, "node_modules/")) continue;

        const key = try logicalKeyFromInstallPath(allocator, normalized_path);
        const alias = packageNameFromInstallPath(normalized_path);
        if (key.len == 0 or alias.len == 0) return error.InvalidNPMLockfile;
        const name = jsonString(package_value, "name") orelse alias;
        const version = jsonString(package_value, "version") orelse "0.0.0";
        const resolved = jsonString(package_value, "resolved") orelse "";
        const requested = npmRequestedSpec(root, &packages_value.object, normalized_path, alias);
        const kind = npmResolutionKind(resolved, version, requested);
        const source_value = switch (kind) {
            .npm => if (isDefaultRegistryURL(resolved)) "" else resolved,
            .folder, .symlink, .local_tarball => localResolutionPath(if (resolved.len > 0) resolved else requested orelse ""),
            .remote_tarball => if (resolved.len > 0) resolved else requested orelse "",
            .git, .github => if (resolved.len > 0) resolved else requested orelse "",
            else => resolved,
        };
        try graph.packages.put(key, .{
            .key = key,
            .name = name,
            .resolution = resolutionFor(kind, version, source_value),
            .version = version,
            .source = source_value,
            .integrity = jsonString(package_value, "integrity") orelse "",
            .info = package_value,
            .kind = kind,
        });
    }
    return graph;
}

fn appendNpmLink(
    allocator: std.mem.Allocator,
    io: std.Io,
    root_dir: []const u8,
    root: *const Value,
    graph: *Lockfile.Graph,
    install_path: []const u8,
    package_value: *const Value,
    packages: *const std.json.ObjectMap,
) !void {
    const key = try logicalKeyFromInstallPath(allocator, install_path);
    const alias = packageNameFromInstallPath(install_path);
    if (key.len == 0 or alias.len == 0) return error.InvalidNPMLockfile;
    const raw_resolved = jsonString(package_value, "resolved") orelse "";
    const resolved = try normalizePath(allocator, raw_resolved);
    if (resolved.len == 0 or std.mem.eql(u8, resolved, ".")) {
        try graph.packages.put(key, .{
            .key = key,
            .name = jsonString(root, "name") orelse alias,
            .resolution = "root:",
            .version = jsonString(root, "version") orelse "0.0.0",
            .source = ".",
            .info = root,
            .kind = .root,
        });
        return;
    }

    const target_value = packages.getPtr(resolved);
    const declared_workspace = (Workspaces.matchesManifestPath(allocator, root, resolved) catch false) or
        (try manifestDeclaresExactWorkspacePath(allocator, root, resolved));
    var metadata: ?*const Value = if (target_value) |value| value else null;
    if (declared_workspace) {
        const package_json_path = try std.fs.path.join(allocator, &.{ root_dir, resolved, "package.json" });
        if (try readOptional(io, allocator, package_json_path, 64 * 1024 * 1024)) |package_source| {
            const package_json = try allocator.create(Value);
            package_json.* = std.json.parseFromSliceLeaky(Value, allocator, package_source, .{}) catch return error.InvalidNPMLockfile;
            if (package_json.* != .object) return error.InvalidNPMLockfile;
            metadata = package_json;
            try graph.workspaces.put(resolved, package_json);
        }
    }
    const info = metadata orelse package_value;
    const name = jsonString(info, "name") orelse alias;
    const version = jsonString(info, "version") orelse "0.0.0";
    const kind: Lockfile.Kind = if (declared_workspace) .workspace else .symlink;
    try graph.packages.put(key, .{
        .key = key,
        .name = name,
        .resolution = resolutionFor(kind, version, resolved),
        .version = version,
        .source = resolved,
        .info = info,
        .kind = kind,
    });
}

fn npmResolutionKind(resolved: []const u8, version: []const u8, requested: ?[]const u8) Lockfile.Kind {
    const request = requested orelse "";
    const git_source = if (isGitResolution(resolved)) resolved else request;
    if (isGitResolution(git_source)) return if (std.mem.startsWith(u8, git_source, "github:")) .github else .git;
    const local_source = if (isLocalResolution(resolved)) resolved else request;
    if (isLocalResolution(local_source)) {
        return if (isTarballPath(local_source)) .local_tarball else .folder;
    }
    if ((std.mem.startsWith(u8, request, "http://") or std.mem.startsWith(u8, request, "https://")) and
        isTarballPath(request)) return .remote_tarball;
    if (version.len == 0 and (std.mem.startsWith(u8, resolved, "http://") or std.mem.startsWith(u8, resolved, "https://"))) {
        return .remote_tarball;
    }
    return .npm;
}

fn npmRequestedSpec(
    root: *const Value,
    packages: *const std.json.ObjectMap,
    install_path: []const u8,
    alias: []const u8,
) ?[]const u8 {
    const marker = "/node_modules/";
    const parent_path: ?[]const u8 = if (std.mem.lastIndexOf(u8, install_path, marker)) |index|
        install_path[0..index]
    else if (std.mem.startsWith(u8, install_path, "node_modules/"))
        ""
    else
        null;
    if (parent_path) |path| {
        const parent = if (path.len == 0) root else packages.getPtr(path) orelse null;
        if (parent) |value| {
            if (dependencySpec(value, alias)) |spec| return spec;
        }
    }

    var unique: ?[]const u8 = null;
    if (dependencySpec(root, alias)) |spec| unique = spec;
    for (packages.values()) |*package| {
        const spec = dependencySpec(package, alias) orelse continue;
        if (!isSpecialNpmMigrationSpec(spec)) continue;
        if (unique) |existing| {
            if (!std.mem.eql(u8, existing, spec)) return unique;
        } else {
            unique = spec;
        }
    }
    return unique;
}

fn dependencySpec(package: *const Value, alias: []const u8) ?[]const u8 {
    if (package.* != .object) return null;
    for (dependency_sections) |section_name| {
        const section = package.object.get(section_name) orelse continue;
        if (section != .object) continue;
        const spec = section.object.get(alias) orelse continue;
        if (spec == .string) return spec.string;
    }
    return null;
}

fn isSpecialNpmMigrationSpec(spec: []const u8) bool {
    return isGitResolution(spec) or isLocalResolution(spec) or
        ((std.mem.startsWith(u8, spec, "http://") or std.mem.startsWith(u8, spec, "https://")) and isTarballPath(spec));
}

fn isLocalResolution(value: []const u8) bool {
    return std.mem.startsWith(u8, value, "file:") or
        std.mem.startsWith(u8, value, "link:") or
        std.mem.startsWith(u8, value, "./") or
        std.mem.startsWith(u8, value, "../");
}

fn manifestDeclaresExactWorkspacePath(
    allocator: std.mem.Allocator,
    manifest: *const Value,
    resolved: []const u8,
) !bool {
    if (manifest.* != .object) return false;
    var workspaces = manifest.object.get("workspaces") orelse return false;
    if (workspaces == .object) workspaces = workspaces.object.get("packages") orelse return false;
    if (workspaces != .array) return false;
    const normalized_resolved = try normalizePath(allocator, resolved);
    for (workspaces.array.items) |entry| {
        if (entry != .string or std.mem.indexOfAny(u8, entry.string, "*?[{") != null) continue;
        const normalized_entry = try normalizePath(allocator, entry.string);
        if (std.mem.eql(u8, normalized_entry, normalized_resolved)) return true;
    }
    return false;
}

fn resolutionFor(kind: Lockfile.Kind, version: []const u8, source: []const u8) []const u8 {
    return switch (kind) {
        .npm => version,
        .folder => source,
        .symlink => source,
        .workspace => source,
        .local_tarball, .remote_tarball, .git, .github => source,
        .root => "root:",
    };
}

const YarnEntry = struct {
    specs: []const []const u8,
    version: []const u8,
    resolved: []const u8,
    integrity: []const u8,
    metadata: *Value,
};

const YarnBuilder = struct {
    specs: []const []const u8,
    version: []const u8 = "",
    resolved: []const u8 = "",
    integrity: []const u8 = "",
    dependencies: std.json.ObjectMap,
    optional_dependencies: std.json.ObjectMap,
    peer_dependencies: std.json.ObjectMap,
    dev_dependencies: std.json.ObjectMap,

    fn init(allocator: std.mem.Allocator, specs: []const []const u8) YarnBuilder {
        _ = allocator;
        return .{
            .specs = specs,
            .dependencies = .empty,
            .optional_dependencies = .empty,
            .peer_dependencies = .empty,
            .dev_dependencies = .empty,
        };
    }
};

const YarnSection = enum {
    dependencies,
    optional_dependencies,
    peer_dependencies,
    dev_dependencies,
};

const YarnState = struct {
    allocator: std.mem.Allocator,
    entries: []const YarnEntry,
    selectors: *const std.StringHashMap(usize),
    graph: *Lockfile.Graph,
    direct_names: std.StringHashMap(void),
    resolving: std.StringHashMap(void),
};

pub fn parseYarn(
    allocator: std.mem.Allocator,
    root: *const Value,
    source: []const u8,
) !Lockfile.Graph {
    const entries = try parseYarnEntries(allocator, source);
    if (entries.len == 0) return error.InvalidYarnLockfile;

    var selectors = std.StringHashMap(usize).init(allocator);
    defer selectors.deinit();
    for (entries, 0..) |entry, index| {
        if (entry.version.len == 0) return error.InvalidYarnLockfile;
        for (entry.specs) |spec| {
            const selector = try selectors.getOrPut(spec);
            if (!selector.found_existing) selector.value_ptr.* = index;
        }
    }

    var graph = Lockfile.Graph{
        .document = root.*,
        .version = 1,
        .config_version = .v0,
        .provenance = .yarn,
        .root_workspace = root,
        .workspaces = std.StringHashMap(*const Value).init(allocator),
        .packages = std.StringHashMap(Lockfile.Package).init(allocator),
    };
    errdefer graph.deinit();
    try graph.workspaces.put("", root);

    var state = YarnState{
        .allocator = allocator,
        .entries = entries,
        .selectors = &selectors,
        .graph = &graph,
        .direct_names = std.StringHashMap(void).init(allocator),
        .resolving = std.StringHashMap(void).init(allocator),
    };
    defer state.direct_names.deinit();
    defer state.resolving.deinit();

    if (root.* == .object) {
        for (dependency_sections) |section_name| {
            const section = root.object.get(section_name) orelse continue;
            if (section != .object) continue;
            for (section.object.keys()) |name| try state.direct_names.put(name, {});
        }
        for (dependency_sections) |section_name| {
            const section = root.object.get(section_name) orelse continue;
            if (section != .object) continue;
            const names = try sortedObjectKeys(allocator, &section.object);
            for (names) |name| {
                const spec_value = section.object.get(name).?;
                if (spec_value != .string) continue;
                const optional = std.mem.eql(u8, section_name, "optionalDependencies");
                _ = placeYarnDependency(&state, name, spec_value.string, "", true) catch |err| {
                    if (optional and err == error.YarnResolutionNotFound) continue;
                    return err;
                };
            }
        }
    }
    return graph;
}

fn appendYarnWorkspaces(
    io: std.Io,
    allocator: std.mem.Allocator,
    root_dir: []const u8,
    root: *const Value,
    graph: *Lockfile.Graph,
) !void {
    const discovery = try Workspaces.discover(io, allocator, root_dir, root);
    if (discovery.diagnostics.len > 0) return error.InvalidYarnLockfile;
    for (discovery.entries) |workspace| {
        try graph.workspaces.put(workspace.relative_path, workspace.package_json);
        try graph.packages.put(workspace.name, .{
            .key = workspace.name,
            .name = workspace.name,
            .resolution = workspace.relative_path,
            .version = workspace.version,
            .source = workspace.relative_path,
            .info = workspace.package_json,
            .kind = .workspace,
        });
    }
}

fn parseYarnEntries(allocator: std.mem.Allocator, source: []const u8) ![]const YarnEntry {
    var entries = std.array_list.Managed(YarnEntry).init(allocator);
    var current: ?YarnBuilder = null;
    var section: ?YarnSection = null;
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trimEnd(u8, raw_line, " \t\r");
        if (line.len == 0) continue;
        const trimmed_left = std.mem.trimStart(u8, line, " \t");
        if (trimmed_left.len == 0 or trimmed_left[0] == '#') continue;
        const indent = line.len - trimmed_left.len;

        if (indent == 0 and trimmed_left[trimmed_left.len - 1] == ':') {
            if (current) |builder| try appendYarnEntry(allocator, &entries, builder);
            const selectors = try parseYarnSelectors(allocator, trimmed_left[0 .. trimmed_left.len - 1]);
            if (selectors.len == 0) return error.InvalidYarnLockfile;
            current = YarnBuilder.init(allocator, selectors);
            section = null;
            continue;
        }
        if (current == null) continue;

        if (indent <= 2) {
            if (std.mem.eql(u8, trimmed_left, "dependencies:")) {
                section = .dependencies;
            } else if (std.mem.eql(u8, trimmed_left, "optionalDependencies:")) {
                section = .optional_dependencies;
            } else if (std.mem.eql(u8, trimmed_left, "peerDependencies:")) {
                section = .peer_dependencies;
            } else if (std.mem.eql(u8, trimmed_left, "devDependencies:")) {
                section = .dev_dependencies;
            } else {
                section = null;
                const property = try parseYarnProperty(allocator, trimmed_left);
                if (std.mem.eql(u8, property.key, "version")) {
                    current.?.version = property.value;
                } else if (std.mem.eql(u8, property.key, "resolved")) {
                    current.?.resolved = property.value;
                } else if (std.mem.eql(u8, property.key, "integrity")) {
                    current.?.integrity = property.value;
                }
            }
            continue;
        }

        if (section) |active_section| {
            const property = try parseYarnProperty(allocator, trimmed_left);
            const target = switch (active_section) {
                .dependencies => &current.?.dependencies,
                .optional_dependencies => &current.?.optional_dependencies,
                .peer_dependencies => &current.?.peer_dependencies,
                .dev_dependencies => &current.?.dev_dependencies,
            };
            try target.put(allocator, property.key, .{ .string = property.value });
        }
    }
    if (current) |builder| try appendYarnEntry(allocator, &entries, builder);
    return entries.toOwnedSlice();
}

fn appendYarnEntry(
    allocator: std.mem.Allocator,
    entries: *std.array_list.Managed(YarnEntry),
    builder: YarnBuilder,
) !void {
    const metadata = try allocator.create(Value);
    metadata.* = .{ .object = .empty };
    if (builder.dependencies.count() > 0) try metadata.object.put(allocator, "dependencies", .{ .object = builder.dependencies });
    if (builder.optional_dependencies.count() > 0) try metadata.object.put(allocator, "optionalDependencies", .{ .object = builder.optional_dependencies });
    if (builder.peer_dependencies.count() > 0) try metadata.object.put(allocator, "peerDependencies", .{ .object = builder.peer_dependencies });
    if (builder.dev_dependencies.count() > 0) try metadata.object.put(allocator, "devDependencies", .{ .object = builder.dev_dependencies });
    try entries.append(.{
        .specs = builder.specs,
        .version = builder.version,
        .resolved = builder.resolved,
        .integrity = builder.integrity,
        .metadata = metadata,
    });
}

fn placeYarnDependency(
    state: *YarnState,
    alias: []const u8,
    spec: []const u8,
    parent_key: []const u8,
    direct: bool,
) ![]const u8 {
    const entry_index = findYarnEntry(state, alias, spec) orelse return error.YarnResolutionNotFound;
    const entry = state.entries[entry_index];
    const identity = yarnIdentity(alias, spec, entry);
    const root_package = state.graph.packages.get(alias);
    const root_reserved = !direct and state.direct_names.contains(alias);
    const key = if (direct)
        try state.allocator.dupe(u8, alias)
    else if (!root_reserved and (root_package == null or yarnPackageMatches(root_package.?, identity)))
        try state.allocator.dupe(u8, alias)
    else
        try std.fmt.allocPrint(state.allocator, "{s}/{s}", .{ parent_key, alias });

    if (state.graph.packages.get(key)) |existing| {
        if (yarnPackageMatches(existing, identity)) return key;
    }

    const cycle_key = try std.fmt.allocPrint(state.allocator, "{d}:{s}", .{ entry_index, key });
    if (state.resolving.contains(cycle_key)) return key;
    try state.resolving.put(cycle_key, {});
    defer _ = state.resolving.remove(cycle_key);

    const package = Lockfile.Package{
        .key = key,
        .name = identity.name,
        .resolution = resolutionFor(identity.kind, entry.version, identity.source),
        .version = entry.version,
        .source = identity.source,
        .integrity = entry.integrity,
        .info = entry.metadata,
        .kind = identity.kind,
    };
    try state.graph.packages.put(key, package);

    for (runtime_dependency_sections) |section_name| {
        const section = entry.metadata.object.get(section_name) orelse continue;
        if (section != .object) continue;
        const names = try sortedObjectKeys(state.allocator, &section.object);
        for (names) |name| {
            const value = section.object.get(name).?;
            if (value != .string) continue;
            const optional = std.mem.eql(u8, section_name, "optionalDependencies");
            _ = placeYarnDependency(state, name, value.string, key, false) catch |err| {
                if (optional and err == error.YarnResolutionNotFound) continue;
                return err;
            };
        }
    }
    return key;
}

const YarnIdentity = struct {
    name: []const u8,
    version: []const u8,
    source: []const u8,
    kind: Lockfile.Kind,
};

fn yarnIdentity(alias: []const u8, spec: []const u8, entry: YarnEntry) YarnIdentity {
    const alias_target = parseNpmAliasTarget(spec);
    const name = alias_target.name orelse alias;
    const resolution_spec = alias_target.spec orelse spec;
    if (isGitResolution(entry.resolved) or isGitResolution(resolution_spec)) {
        const source = if (entry.resolved.len > 0) entry.resolved else resolution_spec;
        return .{ .name = name, .version = entry.version, .source = source, .kind = if (std.mem.startsWith(u8, source, "github:")) .github else .git };
    }
    if (std.mem.startsWith(u8, resolution_spec, "file:") or
        std.mem.startsWith(u8, resolution_spec, "./") or
        std.mem.startsWith(u8, resolution_spec, "../"))
    {
        const source = if (entry.resolved.len > 0) localResolutionPath(entry.resolved) else localResolutionPath(resolution_spec);
        return .{ .name = name, .version = entry.version, .source = source, .kind = if (isTarballPath(source)) .local_tarball else .folder };
    }
    if ((std.mem.startsWith(u8, resolution_spec, "http://") or std.mem.startsWith(u8, resolution_spec, "https://")) and
        isTarballPath(resolution_spec))
    {
        return .{ .name = name, .version = entry.version, .source = if (entry.resolved.len > 0) entry.resolved else resolution_spec, .kind = .remote_tarball };
    }
    return .{
        .name = name,
        .version = entry.version,
        .source = if (isDefaultRegistryURL(entry.resolved)) "" else entry.resolved,
        .kind = .npm,
    };
}

fn yarnPackageMatches(package: Lockfile.Package, identity: YarnIdentity) bool {
    return package.kind == identity.kind and
        std.mem.eql(u8, package.name, identity.name) and
        std.mem.eql(u8, package.version, identity.version) and
        std.mem.eql(u8, package.source, identity.source);
}

fn findYarnEntry(state: *const YarnState, name: []const u8, spec: []const u8) ?usize {
    var buffer: [4096]u8 = undefined;
    const selector = std.fmt.bufPrint(&buffer, "{s}@{s}", .{ name, spec }) catch return null;
    if (state.selectors.get(selector)) |index| return index;
    for (state.entries, 0..) |entry, index| {
        for (entry.specs) |candidate| {
            if (std.mem.eql(u8, yarnSelectorName(candidate), name)) return index;
        }
    }
    return null;
}

fn jsonString(value: *const Value, key: []const u8) ?[]const u8 {
    if (value.* != .object) return null;
    const field = value.object.get(key) orelse return null;
    return if (field == .string) field.string else null;
}

fn jsonBool(value: *const Value, key: []const u8) bool {
    if (value.* != .object) return false;
    const field = value.object.get(key) orelse return false;
    return field == .bool and field.bool;
}

fn sortedObjectKeys(
    allocator: std.mem.Allocator,
    object: *const std.json.ObjectMap,
) ![]const []const u8 {
    const keys = try allocator.alloc([]const u8, object.count());
    @memcpy(keys, object.keys());
    std.mem.sort([]const u8, keys, {}, struct {
        fn lessThan(_: void, left: []const u8, right: []const u8) bool {
            return std.mem.order(u8, left, right) == .lt;
        }
    }.lessThan);
    return keys;
}

fn normalizePath(allocator: std.mem.Allocator, raw: []const u8) ![]const u8 {
    const normalized = try allocator.dupe(u8, raw);
    std.mem.replaceScalar(u8, normalized, '\\', '/');

    var segments = std.array_list.Managed([]const u8).init(allocator);
    var iterator = std.mem.splitScalar(u8, normalized, '/');
    while (iterator.next()) |segment| {
        if (segment.len == 0 or std.mem.eql(u8, segment, ".")) continue;
        if (std.mem.eql(u8, segment, "..") and segments.items.len > 0 and
            !std.mem.eql(u8, segments.items[segments.items.len - 1], ".."))
        {
            _ = segments.pop();
            continue;
        }
        try segments.append(segment);
    }
    return std.mem.join(allocator, "/", segments.items);
}

fn logicalKeyFromInstallPath(allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    var output: std.Io.Writer.Allocating = .init(allocator);
    var components = std.mem.tokenizeScalar(u8, path, '/');
    while (components.next()) |component| {
        if (std.mem.eql(u8, component, "node_modules")) continue;
        if (output.written().len > 0) try output.writer.writeByte('/');
        try output.writer.writeAll(component);
    }
    return output.toOwnedSlice();
}

fn packageNameFromInstallPath(path: []const u8) []const u8 {
    const marker = "/node_modules/";
    const start: usize = if (std.mem.startsWith(u8, path, "node_modules/"))
        "node_modules/".len
    else if (std.mem.lastIndexOf(u8, path, marker)) |index|
        index + marker.len
    else
        return "";
    if (start >= path.len) return "";
    if (path[start] == '@') {
        const scope_end = std.mem.indexOfScalarPos(u8, path, start, '/') orelse return "";
        const package_end = std.mem.indexOfScalarPos(u8, path, scope_end + 1, '/') orelse path.len;
        if (scope_end + 1 >= package_end) return "";
        return path[start..package_end];
    }
    const package_end = std.mem.indexOfScalarPos(u8, path, start, '/') orelse path.len;
    return path[start..package_end];
}

fn isGitResolution(value: []const u8) bool {
    return std.mem.startsWith(u8, value, "git+") or
        std.mem.startsWith(u8, value, "git://") or
        std.mem.startsWith(u8, value, "git@") or
        std.mem.startsWith(u8, value, "github:") or
        std.mem.startsWith(u8, value, "ssh://") or
        ((std.mem.startsWith(u8, value, "http://github.com/") or
            std.mem.startsWith(u8, value, "https://github.com/")) and
            std.mem.indexOf(u8, value, ".git") != null);
}

fn isTarballPath(value: []const u8) bool {
    const end = std.mem.indexOfAny(u8, value, "?#") orelse value.len;
    const path = value[0..end];
    return std.mem.endsWith(u8, path, ".tgz") or
        std.mem.endsWith(u8, path, ".tar.gz") or
        std.mem.endsWith(u8, path, ".tar");
}

fn localResolutionPath(value: []const u8) []const u8 {
    if (std.mem.startsWith(u8, value, "file:")) return value["file:".len..];
    if (std.mem.startsWith(u8, value, "link:")) return value["link:".len..];
    return value;
}

fn isDefaultRegistryURL(value: []const u8) bool {
    return value.len == 0 or
        std.mem.startsWith(u8, value, "https://registry.npmjs.org/") or
        std.mem.startsWith(u8, value, "http://registry.npmjs.org/") or
        std.mem.startsWith(u8, value, "https://registry.yarnpkg.com/") or
        std.mem.startsWith(u8, value, "http://registry.yarnpkg.com/");
}

const YarnProperty = struct {
    key: []const u8,
    value: []const u8,
};

fn parseYarnProperty(allocator: std.mem.Allocator, line: []const u8) !YarnProperty {
    const split = yarnTokenEnd(line) orelse return error.InvalidYarnLockfile;
    const raw_key = std.mem.trim(u8, line[0..split], " \t");
    const raw_value = std.mem.trim(u8, line[split..], " \t");
    if (raw_key.len == 0 or raw_value.len == 0) return error.InvalidYarnLockfile;
    return .{
        .key = try decodeYarnToken(allocator, raw_key),
        .value = try decodeYarnToken(allocator, raw_value),
    };
}

fn yarnTokenEnd(line: []const u8) ?usize {
    var quote: u8 = 0;
    var escaped = false;
    for (line, 0..) |byte, index| {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote != 0 and byte == '\\') {
            escaped = true;
            continue;
        }
        if (byte == '"' or byte == '\'') {
            if (quote == 0) quote = byte else if (quote == byte) quote = 0;
            continue;
        }
        if (quote == 0 and (byte == ' ' or byte == '\t')) return index;
    }
    return null;
}

fn parseYarnSelectors(allocator: std.mem.Allocator, line: []const u8) ![]const []const u8 {
    var selectors = std.array_list.Managed([]const u8).init(allocator);
    var start: usize = 0;
    var quote: u8 = 0;
    var escaped = false;
    for (line, 0..) |byte, index| {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote != 0 and byte == '\\') {
            escaped = true;
            continue;
        }
        if (byte == '"' or byte == '\'') {
            if (quote == 0) quote = byte else if (quote == byte) quote = 0;
            continue;
        }
        if (quote == 0 and byte == ',') {
            const raw = std.mem.trim(u8, line[start..index], " \t");
            if (raw.len == 0) return error.InvalidYarnLockfile;
            try selectors.append(try decodeYarnToken(allocator, raw));
            start = index + 1;
        }
    }
    if (quote != 0) return error.InvalidYarnLockfile;
    const raw = std.mem.trim(u8, line[start..], " \t");
    if (raw.len == 0) return error.InvalidYarnLockfile;
    try selectors.append(try decodeYarnToken(allocator, raw));
    return selectors.toOwnedSlice();
}

fn decodeYarnToken(allocator: std.mem.Allocator, raw: []const u8) ![]const u8 {
    if (raw.len < 2 or (raw[0] != '"' and raw[0] != '\'')) return raw;
    if (raw[raw.len - 1] != raw[0]) return error.InvalidYarnLockfile;
    if (raw[0] == '\'') return allocator.dupe(u8, raw[1 .. raw.len - 1]);
    const parsed = std.json.parseFromSliceLeaky(Value, allocator, raw, .{}) catch return error.InvalidYarnLockfile;
    if (parsed != .string) return error.InvalidYarnLockfile;
    return parsed.string;
}

fn yarnSelectorName(selector: []const u8) []const u8 {
    if (selector.len == 0) return selector;
    if (selector[0] == '@') {
        const slash = std.mem.indexOfScalar(u8, selector, '/') orelse return selector;
        const version_at = std.mem.indexOfScalarPos(u8, selector, slash + 1, '@') orelse return selector;
        return selector[0..version_at];
    }
    const version_at = std.mem.indexOfScalar(u8, selector, '@') orelse return selector;
    return selector[0..version_at];
}

const NpmAliasTarget = struct {
    name: ?[]const u8 = null,
    spec: ?[]const u8 = null,
};

fn parseNpmAliasTarget(spec: []const u8) NpmAliasTarget {
    if (!std.mem.startsWith(u8, spec, "npm:")) return .{};
    const target = spec["npm:".len..];
    if (target.len == 0) return .{};
    if (target[0] == '@') {
        const slash = std.mem.indexOfScalar(u8, target, '/') orelse return .{};
        const version_at = std.mem.indexOfScalarPos(u8, target, slash + 1, '@');
        if (version_at) |index| return .{ .name = target[0..index], .spec = target[index + 1 ..] };
        return .{ .name = target, .spec = "latest" };
    }
    if (std.mem.indexOfScalar(u8, target, '@')) |index| {
        return .{ .name = target[0..index], .spec = target[index + 1 ..] };
    }
    return .{ .name = target, .spec = "latest" };
}

test "npm lock migration preserves placements links integrity and config version" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io, "packages/workspace");
    try tmp.dir.writeFile(io, .{
        .sub_path = "packages/workspace/package.json",
        .data = "{\"name\":\"workspace\",\"version\":\"3.0.0\"}",
    });

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const relative_root = try std.fs.path.join(allocator, &.{ ".zig-cache", "tmp", &tmp.sub_path });
    const root_dir = try std.Io.Dir.cwd().realPathFileAlloc(io, relative_root, allocator);
    var root = try std.json.parseFromSliceLeaky(Value, allocator,
        \\{"name":"app","version":"1.0.0","workspaces":["packages/../packages/workspace"],"dependencies":{"foo":"^1","archive":"file:archive.tgz","remote":"https://example.test/remote.tgz","workspace":"workspace:*","self":"."}}
    , .{});
    var graph = try parseNpm(allocator, io, root_dir, &root,
        \\{
        \\  "lockfileVersion": 3,
        \\  "packages": {
        \\    "": {"name":"app","version":"1.0.0"},
        \\    "node_modules/foo": {"name":"foo","version":"1.2.3","integrity":"sha512-foo","dependencies":{"bar":"2.0.0"}},
        \\    "node_modules/foo/node_modules/bar": {"name":"bar","version":"2.0.0","resolved":"https://registry.npmjs.org/bar/-/bar-2.0.0.tgz","integrity":"sha512-bar"},
        \\    "node_modules/archive": {"name":"archive","version":"1.0.0","resolved":"file:archive.tgz","integrity":"sha512-archive"},
        \\    "node_modules/remote": {"name":"remote","version":"2.0.0","resolved":"https://example.test/remote.tgz","integrity":"sha512-remote"},
        \\    "packages/workspace": {"name":"workspace","version":"3.0.0"},
        \\    "node_modules/workspace": {"resolved":"packages/workspace","link":true},
        \\    "node_modules/self": {"resolved":"","link":true}
        \\  }
        \\}
    );
    defer graph.deinit();

    try std.testing.expectEqual(Lockfile.Provenance.npm, graph.provenance);
    try std.testing.expectEqual(Lockfile.ConfigVersion.v0, graph.config_version.?);
    try std.testing.expectEqual(@as(usize, 6), graph.packages.count());
    try std.testing.expectEqualStrings("sha512-foo", graph.get("foo").?.integrity);
    try std.testing.expectEqualStrings("2.0.0", graph.get("foo/bar").?.version);
    try std.testing.expectEqual(Lockfile.Kind.local_tarball, graph.get("archive").?.kind);
    try std.testing.expectEqualStrings("archive.tgz", graph.get("archive").?.source);
    try std.testing.expectEqual(Lockfile.Kind.remote_tarball, graph.get("remote").?.kind);
    try std.testing.expectEqualStrings("https://example.test/remote.tgz", graph.get("remote").?.source);
    try std.testing.expectEqual(Lockfile.Kind.workspace, graph.get("workspace").?.kind);
    try std.testing.expectEqualStrings("3.0.0", graph.get("workspace").?.version);
    try std.testing.expectEqual(Lockfile.Kind.root, graph.get("self").?.kind);
}

test "npm lock migration rejects unsupported package lock versions" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var root = try std.json.parseFromSliceLeaky(Value, allocator, "{}", .{});
    try std.testing.expectError(error.NPMLockfileVersionMismatch, parseNpm(
        allocator,
        std.testing.io,
        ".",
        &root,
        "{\"lockfileVersion\":1,\"packages\":{\"\":{}}}",
    ));
}

test "Yarn v1 migration hoists compatible packages and nests conflicts" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var root = try std.json.parseFromSliceLeaky(Value, allocator,
        \\{"name":"app","dependencies":{"b":"^1.0.0","@scope/pkg":"^3.0.0","a":"^1.0.0"}}
    , .{});
    var graph = try parseYarn(allocator, &root,
        \\# yarn lockfile v1
        \\
        \\a@^1.0.0:
        \\  version "1.1.0"
        \\  resolved "https://registry.yarnpkg.com/a/-/a-1.1.0.tgz"
        \\  integrity sha512-a
        \\  dependencies:
        \\    shared "^1.0.0"
        \\
        \\b@^1.0.0:
        \\  version "1.2.0"
        \\  resolved "https://registry.yarnpkg.com/b/-/b-1.2.0.tgz"
        \\  dependencies:
        \\    shared "^2.0.0"
        \\
        \\shared@^1.0.0:
        \\  version "1.5.0"
        \\  resolved "https://registry.yarnpkg.com/shared/-/shared-1.5.0.tgz"
        \\  integrity sha512-shared-one
        \\
        \\shared@^2.0.0:
        \\  version "2.1.0"
        \\  resolved "https://registry.yarnpkg.com/shared/-/shared-2.1.0.tgz"
        \\  integrity sha512-shared-two
        \\
        \\"@scope/pkg@^3.0.0":
        \\  version "3.1.0"
        \\  resolved "https://registry.yarnpkg.com/@scope%2fpkg/-/pkg-3.1.0.tgz"
    );
    defer graph.deinit();

    try std.testing.expectEqual(Lockfile.Provenance.yarn, graph.provenance);
    try std.testing.expectEqual(@as(usize, 5), graph.packages.count());
    try std.testing.expectEqualStrings("1.5.0", graph.get("shared").?.version);
    try std.testing.expectEqualStrings("sha512-shared-one", graph.get("shared").?.integrity);
    try std.testing.expectEqualStrings("2.1.0", graph.get("b/shared").?.version);
    try std.testing.expectEqualStrings("@scope/pkg", graph.get("@scope/pkg").?.name);
}

test "Yarn selector parsing handles scoped aliases and quoted selector groups" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const selectors = try parseYarnSelectors(allocator, "\"@scope/pkg@^1.0.0\", alias@npm:@scope/pkg@^1.0.0");
    try std.testing.expectEqual(@as(usize, 2), selectors.len);
    try std.testing.expectEqualStrings("@scope/pkg", yarnSelectorName(selectors[0]));
    const target = parseNpmAliasTarget("npm:@scope/pkg@^1.0.0");
    try std.testing.expectEqualStrings("@scope/pkg", target.name.?);
    try std.testing.expectEqualStrings("^1.0.0", target.spec.?);
}

test "Yarn migration materializes workspace package records" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io, "packages/app");
    try tmp.dir.writeFile(io, .{
        .sub_path = "packages/app/package.json",
        .data = "{\"name\":\"workspace-app\",\"version\":\"2.0.0\",\"dependencies\":{\"foo\":\"^1.0.0\"}}",
    });

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const relative_root = try std.fs.path.join(allocator, &.{ ".zig-cache", "tmp", &tmp.sub_path });
    const root_dir = try std.Io.Dir.cwd().realPathFileAlloc(io, relative_root, allocator);
    var root = try std.json.parseFromSliceLeaky(Value, allocator,
        \\{"name":"root","workspaces":["packages/*"]}
    , .{});
    var graph = try parseYarn(allocator, &root,
        \\# yarn lockfile v1
        \\
        \\foo@^1.0.0:
        \\  version "1.1.0"
        \\  resolved "https://registry.yarnpkg.com/foo/-/foo-1.1.0.tgz"
    );
    defer graph.deinit();
    try appendYarnWorkspaces(io, allocator, root_dir, &root, &graph);

    try std.testing.expect(graph.workspaces.get("packages/app") != null);
    const workspace = graph.get("workspace-app").?;
    try std.testing.expectEqual(Lockfile.Kind.workspace, workspace.kind);
    try std.testing.expectEqualStrings("2.0.0", workspace.version);
    try std.testing.expectEqualStrings("packages/app", workspace.source);
}
