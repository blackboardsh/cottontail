const std = @import("std");
const Compiler = @import("cottontail_compiler");
const Lockfile = @import("package_manager_lockfile.zig");
const Workspaces = @import("package_manager_workspaces.zig");
const Pnpm = @import("package_manager_pnpm_migration.zig");

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
    invalid_pnpm_lockfile,
    pnpm_lockfile_too_old,
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
        const graph = parseYarn(allocator, root, source) catch {
            return .{ .ignored = .{ .source = .yarn, .reason = .invalid_yarn_lockfile } };
        };
        return .{ .migrated = .{ .graph = graph, .source = .yarn } };
    }

    const pnpm_path = try std.fs.path.join(allocator, &.{ root_dir, Source.pnpm.filename() });
    if (try readOptional(io, allocator, pnpm_path, 256 * 1024 * 1024)) |source| {
        const graph = Pnpm.parse(io, allocator, root_dir, root, source) catch |err| {
            return .{ .ignored = .{
                .source = .pnpm,
                .reason = if (err == error.PnpmLockfileTooOld) .pnpm_lockfile_too_old else .invalid_pnpm_lockfile,
            } };
        };
        return .{ .migrated = .{ .graph = graph, .source = .pnpm } };
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

    // Discover npm workspace links before translating nested install paths so
    // `packages/app/node_modules/pkg` becomes Bun's `app/pkg` logical key.
    for (packages_value.object.keys(), packages_value.object.values()) |raw_path, *package_value| {
        if (raw_path.len == 0 or package_value.* != .object or !jsonBool(package_value, "link")) continue;
        const normalized_path = try normalizePath(allocator, raw_path);
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
    }

    for (packages_value.object.keys(), packages_value.object.values()) |raw_path, *package_value| {
        if (raw_path.len == 0) continue;
        if (package_value.* != .object) return error.InvalidNPMLockfile;
        if (jsonBool(package_value, "extraneous")) continue;
        if (jsonBool(package_value, "inBundle")) {
            // npm marks package-lock placements as `inBundle`; Bun lockfiles
            // mark the corresponding package record as `bundled`.
            try package_value.object.put(allocator, "bundled", .{ .bool = true });
        }

        const normalized_path = try normalizePath(allocator, raw_path);
        if (jsonBool(package_value, "link")) continue;
        if (std.mem.indexOf(u8, normalized_path, "node_modules/") == null and
            !std.mem.startsWith(u8, normalized_path, "node_modules/")) continue;

        const key = try logicalKeyFromNpmInstallPath(allocator, normalized_path, &graph.workspaces);
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
        try pruneMissingNpmDependencies(
            allocator,
            package_value,
            normalized_path,
            &packages_value.object,
        );
        try graph.packages.put(key, .{
            .key = key,
            .name = name,
            .resolution = resolutionFor(kind, version, source_value),
            .version = version,
            .source = source_value,
            .git_resolved = if (kind == .git or kind == .github) gitResolvedTag(source_value) else "",
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
            try pruneMissingNpmDependencies(allocator, package_json, resolved, packages);
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

fn pruneMissingNpmDependencies(
    allocator: std.mem.Allocator,
    package: *Value,
    install_path: []const u8,
    packages: *const std.json.ObjectMap,
) !void {
    if (package.* != .object) return;
    for (dependency_sections) |section_name| {
        const section = package.object.getPtr(section_name) orelse continue;
        if (section.* != .object) continue;

        var missing = std.array_list.Managed([]const u8).init(allocator);
        defer missing.deinit();
        for (section.object.keys()) |alias| {
            if (std.mem.eql(u8, section_name, "peerDependencies") and
                npmPeerDependencyIsOptional(package, alias)) continue;
            if (!try npmLockContainsDependency(allocator, packages, install_path, alias)) {
                try missing.append(alias);
            }
        }
        for (missing.items) |alias| _ = section.object.orderedRemove(alias);
    }
}

fn npmLockContainsDependency(
    allocator: std.mem.Allocator,
    packages: *const std.json.ObjectMap,
    install_path: []const u8,
    alias: []const u8,
) !bool {
    var base = install_path;
    while (true) {
        const candidate = if (base.len == 0)
            try std.fmt.allocPrint(allocator, "node_modules/{s}", .{alias})
        else
            try std.fmt.allocPrint(allocator, "{s}/node_modules/{s}", .{ base, alias });
        if (packages.getPtr(candidate)) |entry| {
            return entry.* == .object and !jsonBool(entry, "inBundle");
        }

        if (std.mem.lastIndexOf(u8, base, "/node_modules/")) |index| {
            base = base[0..index];
        } else if (base.len > 0) {
            base = "";
        } else {
            return false;
        }
    }
}

fn npmPeerDependencyIsOptional(package: *const Value, alias: []const u8) bool {
    if (package.* != .object) return false;
    const metadata = package.object.get("peerDependenciesMeta") orelse return false;
    if (metadata != .object) return false;
    const entry = metadata.object.get(alias) orelse return false;
    return entry == .object and jsonBool(&entry, "optional");
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

pub fn parseYarn(
    allocator: std.mem.Allocator,
    root: *const Value,
    source: []const u8,
) !Lockfile.Graph {
    const entries = try parseYarnEntries(allocator, source);

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
        .config_version = .v1,
        .provenance = .yarn,
        .root_workspace = root,
        .workspaces = std.StringHashMap(*const Value).init(allocator),
        .packages = std.StringHashMap(Lockfile.Package).init(allocator),
    };
    errdefer graph.deinit();
    try graph.workspaces.put("", root);

    try placeYarnGraph(allocator, root, entries, &selectors, &graph);
    return graph;
}

fn placeYarnGraph(
    allocator: std.mem.Allocator,
    root: *const Value,
    entries: []const YarnEntry,
    selectors: *const std.StringHashMap(usize),
    graph: *Lockfile.Graph,
) !void {
    if (entries.len == 0) return;

    const invalid_id = Compiler.install.invalid_package_id;
    const entry_package_ids = try allocator.alloc(Compiler.install.PackageID, entries.len);
    const package_entry_indices = try allocator.alloc(usize, entries.len + 1);
    const package_identities = try allocator.alloc(YarnIdentity, entries.len + 1);
    @memset(package_entry_indices, std.math.maxInt(usize));

    var package_groups = std.StringHashMap(Compiler.install.PackageID).init(allocator);
    defer package_groups.deinit();

    var package_count: Compiler.install.PackageID = 1;
    for (entries, 0..) |entry, entry_index| {
        const selector = entry.specs[0];
        const alias = yarnSelectorName(selector);
        const spec = yarnSelectorSpec(selector);
        const identity = try yarnIdentity(allocator, alias, spec, entry);
        const group_name = yarnGroupingName(alias, spec, identity);
        const group_key = try std.fmt.allocPrint(allocator, "{s}\x00{s}", .{ group_name, entry.version });
        const result = try package_groups.getOrPut(group_key);
        if (!result.found_existing) {
            result.value_ptr.* = package_count;
            package_entry_indices[package_count] = entry_index;
            package_identities[package_count] = identity;
            package_count += 1;
        }
        entry_package_ids[entry_index] = result.value_ptr.*;
    }

    var binary: Compiler.install.Lockfile = undefined;
    binary.initEmpty(allocator);
    defer binary.deinit();

    {
        var string_buf = binary.stringBuf();
        const root_name_slice = jsonString(root, "name") orelse "";
        const root_name_hash = Compiler.Semver.String.Builder.stringHash(root_name_slice);
        const root_name = try string_buf.appendWithHash(root_name_slice, root_name_hash);
        try binary.packages.append(allocator, .{
            .name = root_name,
            .name_hash = root_name_hash,
            .resolution = Compiler.install.Resolution.init(.{ .root = {} }),
            .meta = .{ .id = 0, .origin = .local },
        });
    }

    var package_id: Compiler.install.PackageID = 1;
    while (package_id < package_count) : (package_id += 1) {
        const identity = package_identities[package_id];
        var string_buf = binary.stringBuf();
        const name_hash = Compiler.Semver.String.Builder.stringHash(identity.name);
        const name = try string_buf.appendWithHash(identity.name, name_hash);
        try binary.packages.append(allocator, .{
            .name = name,
            .name_hash = name_hash,
            .resolution = try yarnCompilerResolution(&binary, identity),
            .meta = .{ .id = package_id },
        });
    }

    var packages = binary.packages.slice();
    const root_dependencies_offset: u32 = @intCast(binary.buffers.dependencies.items.len);
    if (root.* == .object) {
        for (dependency_sections) |section_name| {
            const section = root.object.get(section_name) orelse continue;
            if (section != .object) continue;
            for (section.object.keys()) |name| {
                const spec_value = section.object.get(name).?;
                if (spec_value != .string) continue;
                const resolved_id = yarnResolvedPackageID(selectors, entry_package_ids, name, spec_value.string) orelse invalid_id;
                try appendYarnHoistDependency(
                    allocator,
                    &binary,
                    name,
                    spec_value.string,
                    yarnDependencyBehavior(section_name),
                    resolved_id,
                );
            }
        }
    }
    packages.items(.dependencies)[0] = .{
        .off = root_dependencies_offset,
        .len = @intCast(binary.buffers.dependencies.items.len - root_dependencies_offset),
    };
    packages.items(.resolutions)[0] = .{
        .off = root_dependencies_offset,
        .len = @intCast(binary.buffers.dependencies.items.len - root_dependencies_offset),
    };

    for (entries, 0..) |entry, entry_index| {
        const resolved_package_id = entry_package_ids[entry_index];
        const dependencies_offset: u32 = @intCast(binary.buffers.dependencies.items.len);
        for (dependency_sections) |section_name| {
            const section = entry.metadata.object.get(section_name) orelse continue;
            if (section != .object) continue;
            for (section.object.keys()) |name| {
                const spec_value = section.object.get(name).?;
                if (spec_value != .string) continue;
                const child_id = yarnResolvedPackageID(selectors, entry_package_ids, name, spec_value.string) orelse invalid_id;
                try appendYarnHoistDependency(
                    allocator,
                    &binary,
                    name,
                    spec_value.string,
                    yarnDependencyBehavior(section_name),
                    child_id,
                );
            }
        }
        packages.items(.dependencies)[resolved_package_id] = .{
            .off = dependencies_offset,
            .len = @intCast(binary.buffers.dependencies.items.len - dependencies_offset),
        };
        packages.items(.resolutions)[resolved_package_id] = .{
            .off = dependencies_offset,
            .len = @intCast(binary.buffers.dependencies.items.len - dependencies_offset),
        };
    }

    var log = Compiler.logger.Log.init(allocator);
    defer log.deinit();
    try binary.resolve(&log);

    const string_bytes = binary.buffers.string_bytes.items;
    var tree_iterator = Compiler.install.Lockfile.Tree.Iterator(.pkg_path).init(&binary);
    while (tree_iterator.next({})) |tree| {
        for (tree.dependencies) |dependency_id| {
            const resolved_package_id = binary.buffers.resolutions.items[dependency_id];
            if (resolved_package_id == invalid_id or resolved_package_id >= package_count) continue;
            const dependency = binary.buffers.dependencies.items[dependency_id];
            const alias = dependency.name.slice(string_bytes);
            const key = if (tree.relative_path.len == 0)
                try allocator.dupe(u8, alias)
            else
                try std.fmt.allocPrint(allocator, "{s}/{s}", .{ tree.relative_path, alias });
            const entry_index = package_entry_indices[resolved_package_id];
            if (entry_index == std.math.maxInt(usize)) continue;
            const entry = entries[entry_index];
            const identity = package_identities[resolved_package_id];
            try graph.packages.put(key, .{
                .key = key,
                .name = identity.name,
                .resolution = resolutionFor(identity.kind, entry.version, identity.source),
                .version = entry.version,
                .source = identity.source,
                .integrity = entry.integrity,
                .info = entry.metadata,
                .kind = identity.kind,
            });
        }
    }
}

fn appendYarnHoistDependency(
    allocator: std.mem.Allocator,
    binary: *Compiler.install.Lockfile,
    name_slice: []const u8,
    spec: []const u8,
    behavior: Compiler.install.Dependency.Behavior,
    resolved_package_id: Compiler.install.PackageID,
) !void {
    var string_buf = binary.stringBuf();
    const name_hash = Compiler.Semver.String.Builder.stringHash(name_slice);
    const name = try string_buf.appendWithHash(name_slice, name_hash);
    const literal = try string_buf.append(spec);
    const string_bytes = binary.buffers.string_bytes.items;
    var version = Compiler.install.Dependency.parse(
        allocator,
        name,
        name_hash,
        literal.slice(string_bytes),
        &literal.sliced(string_bytes),
        null,
        null,
    ) orelse Compiler.install.Dependency.Version{};
    version.literal = literal;
    try binary.buffers.dependencies.append(allocator, .{
        .name = name,
        .name_hash = name_hash,
        .version = version,
        .behavior = behavior,
    });
    try binary.buffers.resolutions.append(allocator, resolved_package_id);
}

fn yarnCompilerResolution(binary: *Compiler.install.Lockfile, identity: YarnIdentity) !Compiler.install.Resolution {
    var string_buf = binary.stringBuf();
    return switch (identity.kind) {
        .npm => blk: {
            const literal = try string_buf.append(identity.version);
            const parsed = Compiler.Semver.Version.parse(literal.sliced(binary.buffers.string_bytes.items));
            if (!parsed.valid) break :blk .{};
            break :blk Compiler.install.Resolution.init(.{ .npm = .{ .url = .{}, .version = parsed.version.min() } });
        },
        .folder => Compiler.install.Resolution.init(.{ .folder = try string_buf.append(identity.source) }),
        .symlink => Compiler.install.Resolution.init(.{ .symlink = try string_buf.append(identity.source) }),
        .workspace => Compiler.install.Resolution.init(.{ .workspace = try string_buf.append(identity.source) }),
        .local_tarball => Compiler.install.Resolution.init(.{ .local_tarball = try string_buf.append(identity.source) }),
        .remote_tarball => Compiler.install.Resolution.init(.{ .remote_tarball = try string_buf.append(identity.source) }),
        .git, .github => Compiler.install.Resolution.fromTextLockfile(identity.source, &string_buf) catch |err| switch (err) {
            error.OutOfMemory => return err,
            else => .{},
        },
        .root => Compiler.install.Resolution.init(.{ .root = {} }),
    };
}

fn yarnDependencyBehavior(section_name: []const u8) Compiler.install.Dependency.Behavior {
    if (std.mem.eql(u8, section_name, "devDependencies")) return .{ .dev = true };
    if (std.mem.eql(u8, section_name, "optionalDependencies")) return .{ .optional = true };
    if (std.mem.eql(u8, section_name, "peerDependencies")) return .{ .peer = true };
    return .{ .prod = true };
}

fn yarnResolvedPackageID(
    selectors: *const std.StringHashMap(usize),
    entry_package_ids: []const Compiler.install.PackageID,
    name: []const u8,
    spec: []const u8,
) ?Compiler.install.PackageID {
    var buffer: [4096]u8 = undefined;
    const selector = std.fmt.bufPrint(&buffer, "{s}@{s}", .{ name, spec }) catch return null;
    const entry_index = selectors.get(selector) orelse return null;
    return entry_package_ids[entry_index];
}

fn yarnSelectorSpec(selector: []const u8) []const u8 {
    const name = yarnSelectorName(selector);
    if (name.len >= selector.len or selector[name.len] != '@') return "";
    return selector[name.len + 1 ..];
}

fn yarnGroupingName(alias: []const u8, spec: []const u8, identity: YarnIdentity) []const u8 {
    const alias_target = parseNpmAliasTarget(spec);
    const resolution_spec = alias_target.spec orelse spec;
    if (std.mem.startsWith(u8, resolution_spec, "http://") or
        std.mem.startsWith(u8, resolution_spec, "https://")) return alias;
    return identity.name;
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

const YarnIdentity = struct {
    name: []const u8,
    version: []const u8,
    source: []const u8,
    kind: Lockfile.Kind,
};

fn yarnIdentity(
    allocator: std.mem.Allocator,
    alias: []const u8,
    spec: []const u8,
    entry: YarnEntry,
) !YarnIdentity {
    const alias_target = parseNpmAliasTarget(spec);
    var name = alias_target.name orelse alias;
    const resolution_spec = alias_target.spec orelse spec;

    if (std.mem.startsWith(u8, resolution_spec, "file:") or
        std.mem.startsWith(u8, resolution_spec, "./") or
        std.mem.startsWith(u8, resolution_spec, "../"))
    {
        // Yarn records a content hash in `resolved`, but Bun preserves the
        // selector path for local folders and tarballs.
        const source = localResolutionPath(resolution_spec);
        return .{ .name = name, .version = entry.version, .source = source, .kind = if (isTarballPath(source)) .local_tarball else .folder };
    }

    const direct_url = std.mem.startsWith(u8, resolution_spec, "http://") or
        std.mem.startsWith(u8, resolution_spec, "https://");
    if (direct_url) {
        const source = if (entry.resolved.len > 0) entry.resolved else resolution_spec;
        name = yarnRegistryPackageName(source) orelse name;
        return .{ .name = name, .version = entry.version, .source = source, .kind = .remote_tarball };
    }

    // Bun derives Git metadata from Yarn's resolved field. A shorthand selector
    // with a non-Git resolved URL (notably codeload.github.com) remains an npm
    // package with that URL as its registry, matching Yarn v1 migration.
    const git_source: ?[]const u8 = if (isGitResolution(entry.resolved))
        entry.resolved
    else if (entry.resolved.len == 0 and isGitResolution(resolution_spec))
        resolution_spec
    else
        null;
    if (git_source) |source| {
        return try yarnGitIdentity(allocator, name, entry.version, source);
    }

    return .{
        .name = name,
        .version = entry.version,
        .source = if (isDefaultYarnRegistryURL(entry.resolved)) "" else entry.resolved,
        .kind = .npm,
    };
}

fn yarnGitIdentity(
    allocator: std.mem.Allocator,
    fallback_name: []const u8,
    version: []const u8,
    source: []const u8,
) !YarnIdentity {
    const github_prefix = "github:";
    if (std.mem.startsWith(u8, source, github_prefix)) {
        const path_and_commit = source[github_prefix.len..];
        const hash = std.mem.indexOfScalar(u8, path_and_commit, '#');
        const repository = path_and_commit[0 .. hash orelse path_and_commit.len];
        const name = std.fs.path.basename(repository);
        if (hash) |index| {
            const commit = path_and_commit[index + 1 ..];
            const normalized = try std.fmt.allocPrint(allocator, "github:{s}#{s}", .{
                repository,
                commit[0..@min(commit.len, github_prefix.len)],
            });
            return .{ .name = name, .version = version, .source = normalized, .kind = .github };
        }
        return .{ .name = name, .version = version, .source = source, .kind = .github };
    }

    const github_marker = "github.com/";
    if (std.mem.indexOf(u8, source, github_marker)) |marker| {
        const repository_start = marker + github_marker.len;
        const hash = std.mem.indexOfScalarPos(u8, source, repository_start, '#');
        var repository = source[repository_start .. hash orelse source.len];
        repository = std.mem.trimEnd(u8, repository, "/");
        if (std.mem.endsWith(u8, repository, ".git")) repository = repository[0 .. repository.len - ".git".len];
        const name = std.fs.path.basename(repository);
        const normalized = if (hash) |index| blk: {
            const commit = source[index + 1 ..];
            break :blk try std.fmt.allocPrint(allocator, "github:{s}#{s}", .{
                repository,
                commit[0..@min(commit.len, github_prefix.len)],
            });
        } else try std.fmt.allocPrint(allocator, "github:{s}", .{repository});
        return .{ .name = name, .version = version, .source = normalized, .kind = .github };
    }

    return .{ .name = fallback_name, .version = version, .source = source, .kind = .git };
}

fn yarnRegistryPackageName(resolved: []const u8) ?[]const u8 {
    const package_end = std.mem.indexOf(u8, resolved, "/-/") orelse return null;
    const scheme_end = std.mem.indexOf(u8, resolved, "://") orelse return null;
    const package_start = std.mem.indexOfScalarPos(u8, resolved, scheme_end + "://".len, '/') orelse return null;
    if (package_start + 1 >= package_end) return null;
    return resolved[package_start + 1 .. package_end];
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

fn logicalKeyFromNpmInstallPath(
    allocator: std.mem.Allocator,
    path: []const u8,
    workspaces: *const std.StringHashMap(*const Value),
) ![]const u8 {
    var selected_path: ?[]const u8 = null;
    var selected_name: ?[]const u8 = null;
    var iterator = workspaces.iterator();
    while (iterator.next()) |entry| {
        const workspace_path = entry.key_ptr.*;
        if (workspace_path.len == 0 or workspace_path.len >= path.len) continue;
        if (!std.mem.startsWith(u8, path, workspace_path) or path[workspace_path.len] != '/') continue;
        if (selected_path != null and selected_path.?.len >= workspace_path.len) continue;
        selected_path = workspace_path;
        selected_name = jsonString(entry.value_ptr.*, "name") orelse std.fs.path.basename(workspace_path);
    }

    const workspace_path = selected_path orelse return logicalKeyFromInstallPath(allocator, path);
    const child_path = std.mem.trimStart(u8, path[workspace_path.len..], "/");
    const child_key = try logicalKeyFromInstallPath(allocator, child_path);
    if (child_key.len == 0) return allocator.dupe(u8, selected_name.?);
    return std.fmt.allocPrint(allocator, "{s}/{s}", .{ selected_name.?, child_key });
}

fn packageNameFromInstallPath(path: []const u8) []const u8 {
    const marker = "/node_modules/";
    const start: usize = if (std.mem.lastIndexOf(u8, path, marker)) |index|
        index + marker.len
    else if (std.mem.startsWith(u8, path, "node_modules/"))
        "node_modules/".len
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

test "npm install paths select the deepest package name" {
    try std.testing.expectEqualStrings("plain", packageNameFromInstallPath("node_modules/plain"));
    try std.testing.expectEqualStrings("@scope/parent", packageNameFromInstallPath("node_modules/@scope/parent"));
    try std.testing.expectEqualStrings("child", packageNameFromInstallPath("node_modules/@scope/parent/node_modules/child"));
    try std.testing.expectEqualStrings("@nested/child", packageNameFromInstallPath("node_modules/parent/node_modules/@nested/child"));
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

fn gitResolvedTag(value: []const u8) []const u8 {
    const hash = std.mem.lastIndexOfScalar(u8, value, '#') orelse return "";
    return if (hash + 1 < value.len) value[hash + 1 ..] else "";
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

fn isDefaultYarnRegistryURL(value: []const u8) bool {
    return std.mem.startsWith(u8, value, "https://registry.npmjs.org/") or
        std.mem.startsWith(u8, value, "https://registry.yarnpkg.com/");
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

test "npm lock migration retains bundled dependency placements" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var root = try std.json.parseFromSliceLeaky(Value, allocator,
        \\{"name":"app","dependencies":{"owner":"1.0.0"}}
    , .{});
    var graph = try parseNpm(allocator, std.testing.io, ".", &root,
        \\{
        \\  "lockfileVersion": 3,
        \\  "packages": {
        \\    "": {"name":"app"},
        \\    "node_modules/owner": {"version":"1.0.0","bundleDependencies":["child"],"dependencies":{"child":"2.0.0"}},
        \\    "node_modules/owner/node_modules/child": {"version":"2.0.0","inBundle":true}
        \\  }
        \\}
    );
    defer graph.deinit();

    try std.testing.expectEqual(@as(usize, 2), graph.packages.count());
    const child = graph.get("owner/child").?;
    try std.testing.expectEqualStrings("child", child.name);
    try std.testing.expect(child.info != null);
    try std.testing.expect(jsonBool(child.info.?, "bundled"));
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

test "Yarn v1 migration accepts an empty lock for a dependency-free package" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var root = try std.json.parseFromSliceLeaky(Value, allocator,
        \\{"name":"dependency-free","version":"1.0.0"}
    , .{});
    var graph = try parseYarn(allocator, &root,
        \\# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
        \\# yarn lockfile v1
        \\
    );
    defer graph.deinit();

    try std.testing.expectEqual(@as(usize, 0), graph.packages.count());
    try std.testing.expect(graph.workspaces.get("") != null);
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
