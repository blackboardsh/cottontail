const std = @import("std");
const builtin = @import("builtin");
const compiler = @import("cottontail_compiler");
const Scripts = @import("package_manager_scripts.zig");
const Workspaces = @import("package_manager_workspaces.zig");

const Value = std.json.Value;
const fixed_mtime = 499162500;
const max_file_bytes = 512 * 1024 * 1024;

pub const Options = struct {
    destination: ?[]const u8 = null,
    filename: ?[]const u8 = null,
    gzip_level: ?[]const u8 = null,
    dry_run: bool = false,
    ignore_scripts: bool = false,
    quiet: bool = false,
};

pub const Entry = struct {
    path: []const u8,
    contents: []const u8,
    mode: u32,
    bundled: bool = false,
};

const Bin = union(enum) {
    file: []const u8,
    directory: []const u8,
};

pub const Manifest = struct {
    source: []const u8,
    value: Value,
};

const Selection = struct {
    entries: std.array_list.Managed(Entry),
    bundled_count: usize = 0,
};

pub const BuildOptions = struct {
    gzip_level: ?[]const u8 = null,
    create_tarball: bool = true,
};

pub const PreparedPackage = struct {
    manifest: Manifest,
    package_json: []const u8,
    name: []const u8,
    version: []const u8,
    tarball_name: []const u8,
    tarball: ?[]const u8,
    entries: []const Entry,
    unpacked_size: usize,
    bundled_count: usize,
    uses_workspaces: bool,
};

pub fn run(
    init: std.process.Init,
    project_root: []const u8,
    package_dir: []const u8,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    if (options.filename != null and options.destination != null) {
        try stderr.print(
            "error: cannot use both filename and destination at the same time with tarball: filename \"{s}\" and destination \"{s}\"\n",
            .{ options.filename.?, options.destination.? },
        );
        try stderr.flush();
        return 1;
    }

    _ = parseGzipLevel(options.gzip_level) catch {
        const received = options.gzip_level orelse "9";
        try stderr.print("error: compression level must be between 0 and 9, received {s}\n", .{received});
        try stderr.flush();
        return 1;
    };

    const package_json_path = try std.fs.path.join(allocator, &.{ package_dir, "package.json" });
    var manifest = readManifest(init.io, allocator, package_json_path) catch |err| {
        if (err == error.FileNotFound) {
            try stderr.print("error: No package.json was found for directory \"{s}\"\n", .{package_dir});
        } else {
            try stderr.print("error: failed to read package.json: {s}\n", .{@errorName(err)});
        }
        try stderr.flush();
        return 1;
    };
    if (manifest.value != .object) {
        try stderr.writeAll("error: package.json must contain an object\n");
        try stderr.flush();
        return 1;
    }

    if (!options.quiet) try stdout.writeAll("bun pack v1.3.10 (cottontail)\n");

    if (!options.ignore_scripts) {
        Scripts.runPackStage(init, package_dir, &manifest.value, "prepack", options.quiet, stderr) catch return 1;
        Scripts.runPackStage(init, package_dir, &manifest.value, "prepare", options.quiet, stderr) catch return 1;
        manifest = readManifest(init.io, allocator, package_json_path) catch |err| {
            try stderr.print("error: failed to read package.json after lifecycle scripts: {s}\n", .{@errorName(err)});
            try stderr.flush();
            return 1;
        };
    }

    const prepared = build(
        init,
        project_root,
        package_dir,
        .{ .gzip_level = options.gzip_level, .create_tarball = !options.dry_run },
        stderr,
    ) catch |err| {
        switch (err) {
            error.MissingPackageName, error.MissingPackageVersion => try stderr.writeAll("error: package.json must have `name` and `version` fields\n"),
            error.InvalidPackageName, error.InvalidPackageVersion => try stderr.writeAll("error: package.json `name` and `version` fields must be non-empty strings\n"),
            error.InvalidPackageJSON => try stderr.writeAll("error: package.json must contain an object\n"),
            error.WorkspaceVersionUnresolved, error.InvalidBundledDependencies, error.InvalidFiles => {},
            else => try stderr.print("error: failed to prepare package: {s}\n", .{@errorName(err)}),
        }
        try stderr.flush();
        return 1;
    };

    const destination = try tarballDestination(allocator, package_dir, prepared.tarball_name, options);
    if (prepared.tarball) |tarball| {
        if (options.destination) |_| {
            if (std.fs.path.dirname(destination)) |parent| try std.Io.Dir.cwd().createDirPath(init.io, parent);
        }
        std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = destination, .data = tarball }) catch |err| {
            try stderr.print("error: failed to open tarball file destination: \"{s}\": {s}\n", .{ destination, @errorName(err) });
            try stderr.flush();
            return 1;
        };
    }

    if (options.quiet) {
        try stdout.print("{s}\n", .{if (options.filename) |filename| filename else prepared.tarball_name});
    } else {
        try printEntries(stdout, prepared.entries);
        const display_name = if (options.filename != null or options.destination != null) destination else prepared.tarball_name;
        try stdout.print("\n{s}\n\n", .{display_name});
        try printSummary(stdout, prepared, allocator);
    }
    try stdout.flush();

    if (!options.ignore_scripts) {
        if (!options.quiet and hasScript(&prepared.manifest.value, "postpack")) {
            try stdout.writeByte('\n');
            try stdout.flush();
        }
        Scripts.runPackStage(init, package_dir, &prepared.manifest.value, "postpack", options.quiet, stderr) catch return 1;
    }
    return 0;
}

pub fn build(
    init: std.process.Init,
    project_root: []const u8,
    package_dir: []const u8,
    options: BuildOptions,
    stderr: *std.Io.Writer,
) !PreparedPackage {
    const allocator = init.arena.allocator();
    const gzip_level = try parseGzipLevel(options.gzip_level);
    const package_json_path = try std.fs.path.join(allocator, &.{ package_dir, "package.json" });
    var manifest = try readManifest(init.io, allocator, package_json_path);
    if (manifest.value != .object) return error.InvalidPackageJSON;

    const name_value = manifest.value.object.get("name") orelse return error.MissingPackageName;
    const version_value = manifest.value.object.get("version") orelse return error.MissingPackageVersion;
    if (name_value != .string or name_value.string.len == 0) return error.InvalidPackageName;
    if (version_value != .string or version_value.string.len == 0) return error.InvalidPackageVersion;
    const uses_workspaces = usesWorkspaceProtocol(&manifest.value);

    const edited_package_json = try editWorkspaceProtocols(
        init.io,
        allocator,
        project_root,
        &manifest,
        stderr,
    );
    var selection = try collectEntries(
        init.io,
        allocator,
        package_dir,
        &manifest.value,
        edited_package_json,
        stderr,
    );
    std.mem.sort(Entry, selection.entries.items[1..], {}, lessEntry);

    var unpacked_size: usize = 0;
    for (selection.entries.items) |entry| unpacked_size += entry.contents.len;
    const tarball = if (options.create_tarball) blk: {
        const tar_bytes = try createTar(allocator, selection.entries.items);
        break :blk try gzip(allocator, tar_bytes, gzip_level);
    } else null;

    return .{
        .manifest = manifest,
        .package_json = edited_package_json,
        .name = name_value.string,
        .version = version_value.string,
        .tarball_name = try defaultTarballName(allocator, name_value.string, version_value.string),
        .tarball = tarball,
        .entries = selection.entries.items,
        .unpacked_size = unpacked_size,
        .bundled_count = selection.bundled_count,
        .uses_workspaces = uses_workspaces,
    };
}

pub fn printSummary(writer: *std.Io.Writer, prepared: PreparedPackage, allocator: std.mem.Allocator) !void {
    try writer.print("Total files: {d}\n", .{prepared.entries.len});
    if (prepared.tarball) |bytes| {
        var shasum: [20]u8 = undefined;
        std.crypto.hash.Sha1.hash(bytes, &shasum, .{});
        var integrity_digest: [64]u8 = undefined;
        std.crypto.hash.sha2.Sha512.hash(bytes, &integrity_digest, .{});
        const integrity_len = std.base64.standard.Encoder.calcSize(integrity_digest.len);
        const integrity = try allocator.alloc(u8, integrity_len);
        _ = std.base64.standard.Encoder.encode(integrity, &integrity_digest);
        try writer.print("Shasum: {s}\n", .{std.fmt.bytesToHex(shasum, .lower)});
        try writer.print("Integrity: sha512-{s}\n", .{integrity});
    }
    try writer.writeAll("Unpacked size: ");
    try printSize(writer, prepared.unpacked_size);
    try writer.writeByte('\n');
    if (prepared.tarball) |bytes| {
        try writer.writeAll("Packed size: ");
        try printSize(writer, bytes.len);
        try writer.writeByte('\n');
    }
    if (prepared.bundled_count > 0) try writer.print("Bundled deps: {d}\n", .{prepared.bundled_count});
}

fn readManifest(io: std.Io, allocator: std.mem.Allocator, path: []const u8) !Manifest {
    const source = try std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(64 * 1024 * 1024));
    return .{
        .source = source,
        .value = try std.json.parseFromSliceLeaky(Value, allocator, source, .{}),
    };
}

fn parseGzipLevel(raw: ?[]const u8) !u4 {
    const level = std.fmt.parseInt(u4, raw orelse "9", 10) catch return error.InvalidGzipLevel;
    if (level > 9) return error.InvalidGzipLevel;
    return level;
}

fn editWorkspaceProtocols(
    io: std.Io,
    allocator: std.mem.Allocator,
    project_root: []const u8,
    manifest: *Manifest,
    stderr: *std.Io.Writer,
) ![]const u8 {
    var root_manifest = manifest.value;
    const root_package_json = try std.fs.path.join(allocator, &.{ project_root, "package.json" });
    if (readManifest(io, allocator, root_package_json)) |root| {
        root_manifest = root.value;
    } else |_| {}
    const discovery = try Workspaces.discover(io, allocator, project_root, &root_manifest);
    const has_lockfile = pathExists(io, try std.fs.path.join(allocator, &.{ project_root, "bun.lock" })) or
        pathExists(io, try std.fs.path.join(allocator, &.{ project_root, "bun.lockb" }));

    for ([_][]const u8{ "dependencies", "devDependencies", "optionalDependencies", "peerDependencies" }) |section_name| {
        const section = manifest.value.object.getPtr(section_name) orelse continue;
        if (section.* != .object) continue;
        for (section.object.keys()) |dependency_name| {
            const value = section.object.getPtr(dependency_name).?;
            if (value.* != .string or !std.mem.startsWith(u8, value.string, "workspace:")) continue;
            const requested = value.string["workspace:".len..];
            const rewritten = if (std.mem.eql(u8, requested, "*") or
                std.mem.eql(u8, requested, "^") or
                std.mem.eql(u8, requested, "~"))
            blk: {
                if (!has_lockfile) {
                    try stderr.print(
                        "error: Failed to resolve workspace version for \"{s}\" in `{s}`. Run `bun install` and try again.\n",
                        .{ dependency_name, section_name },
                    );
                    return error.WorkspaceVersionUnresolved;
                }
                const version = workspaceVersion(discovery.entries, dependency_name) orelse {
                    try stderr.print(
                        "error: Failed to resolve workspace version for \"{s}\" in `{s}`. Run `bun install` and try again.\n",
                        .{ dependency_name, section_name },
                    );
                    return error.WorkspaceVersionUnresolved;
                };
                if (std.mem.eql(u8, requested, "*")) break :blk version;
                break :blk try std.fmt.allocPrint(allocator, "{s}{s}", .{ requested, version });
            } else requested;
            value.* = .{ .string = try allocator.dupe(u8, rewritten) };
        }
    }
    var output: std.Io.Writer.Allocating = .init(allocator);
    const indentation = detectIndentation(manifest.source);
    try writePackJson(&output.writer, manifest.value, indentation, 0);
    if (manifest.source.len > 0 and manifest.source[manifest.source.len - 1] == '\n') {
        try output.writer.writeByte('\n');
    }
    return output.toOwnedSlice();
}

fn detectIndentation(source: []const u8) []const u8 {
    var lines = std.mem.splitScalar(u8, source, '\n');
    _ = lines.next();
    while (lines.next()) |line| {
        var count: usize = 0;
        while (count < line.len and (line[count] == ' ' or line[count] == '\t')) : (count += 1) {}
        if (count > 0 and count < line.len) return line[0..count];
    }
    return "";
}

fn writePackJson(writer: *std.Io.Writer, value: Value, indentation: []const u8, depth: usize) !void {
    switch (value) {
        .object => |object| {
            try writer.writeByte('{');
            if (object.count() > 0) {
                try writer.writeByte('\n');
                for (object.keys(), object.values(), 0..) |key, child, index| {
                    try writeIndent(writer, indentation, depth + 1);
                    try std.json.Stringify.value(key, .{}, writer);
                    try writer.writeAll(": ");
                    try writePackJson(writer, child, indentation, depth + 1);
                    if (index + 1 < object.count()) try writer.writeByte(',');
                    try writer.writeByte('\n');
                }
                try writeIndent(writer, indentation, depth);
            }
            try writer.writeByte('}');
        },
        .array => |array| {
            try writer.writeByte('[');
            for (array.items, 0..) |child, index| {
                if (index > 0) try writer.writeAll(", ");
                try writePackJson(writer, child, indentation, depth);
            }
            try writer.writeByte(']');
        },
        else => try std.json.Stringify.value(value, .{}, writer),
    }
}

fn writeIndent(writer: *std.Io.Writer, indentation: []const u8, depth: usize) !void {
    for (0..depth) |_| try writer.writeAll(indentation);
}

fn workspaceVersion(entries: []const Workspaces.Entry, name: []const u8) ?[]const u8 {
    for (entries) |entry| {
        if (std.mem.eql(u8, entry.name, name) and entry.has_version) return entry.version;
    }
    return null;
}

fn collectEntries(
    io: std.Io,
    allocator: std.mem.Allocator,
    package_dir: []const u8,
    manifest: *const Value,
    package_json: []const u8,
    stderr: *std.Io.Writer,
) !Selection {
    var result = Selection{ .entries = std.array_list.Managed(Entry).init(allocator) };
    try result.entries.append(.{ .path = "package.json", .contents = package_json, .mode = 0o644 });
    var seen = std.StringHashMap(void).init(allocator);
    try seen.put("package.json", {});

    const bins = try packageBins(allocator, manifest);
    const files = if (manifest.* == .object) manifest.object.get("files") else null;
    if (files) |files_value| {
        if (files_value != .array) {
            try stderr.writeAll("error: expected `files` to be an array of string values\n");
            return error.InvalidFiles;
        }
    }

    var directory = try std.Io.Dir.openDirAbsolute(io, package_dir, .{ .iterate = true });
    defer directory.close(io);
    var walker = try directory.walk(allocator);
    defer walker.deinit();
    while (try walker.next(io)) |walk_entry| {
        const relative = try posixPath(allocator, walk_entry.path);
        if (walk_entry.kind == .directory) {
            if (std.mem.eql(u8, relative, "node_modules") or isHardExcludedName(walk_entry.basename)) walker.leave(io);
            continue;
        }
        if (walk_entry.kind != .file or std.mem.eql(u8, relative, "package.json")) continue;

        const is_bin = matchesBin(bins, relative);
        const include = is_bin or try shouldIncludeProjectFile(io, allocator, package_dir, relative, files);
        if (!include or seen.contains(relative)) continue;
        const absolute = try std.fs.path.join(allocator, &.{ package_dir, walk_entry.path });
        const contents = try std.Io.Dir.cwd().readFileAlloc(io, absolute, allocator, .limited(max_file_bytes));
        const stat = try std.Io.Dir.cwd().statFile(io, absolute, .{ .follow_symlinks = false });
        var mode: u32 = @intCast(@intFromEnum(stat.permissions));
        mode |= 0o644;
        if (is_bin) mode |= 0o111;
        try seen.put(relative, {});
        try result.entries.append(.{ .path = relative, .contents = contents, .mode = mode });
    }

    const bundled = try bundledDependencyNames(allocator, manifest, stderr);
    var bundled_paths = std.StringHashMap(void).init(allocator);
    for (bundled) |dependency_name| {
        try collectBundledDependency(
            io,
            allocator,
            package_dir,
            package_dir,
            dependency_name,
            &result,
            &seen,
            &bundled_paths,
        );
    }
    return result;
}

fn packageBins(allocator: std.mem.Allocator, manifest: *const Value) ![]const Bin {
    var bins = std.array_list.Managed(Bin).init(allocator);
    if (manifest.* != .object) return bins.toOwnedSlice();
    if (manifest.object.get("bin")) |value| switch (value) {
        .string => try bins.append(.{ .file = try normalizePattern(allocator, value.string) }),
        .object => {
            for (value.object.values()) |bin_value| {
                if (bin_value == .string) try bins.append(.{ .file = try normalizePattern(allocator, bin_value.string) });
            }
        },
        else => {},
    } else if (manifest.object.get("directories")) |directories| {
        if (directories == .object) {
            if (directories.object.get("bin")) |bin| {
                if (bin == .string) try bins.append(.{ .directory = try normalizePattern(allocator, bin.string) });
            }
        }
    }
    return bins.toOwnedSlice();
}

fn usesWorkspaceProtocol(manifest: *const Value) bool {
    if (manifest.* != .object) return false;
    for ([_][]const u8{ "dependencies", "devDependencies", "optionalDependencies", "peerDependencies" }) |section_name| {
        const section = manifest.object.get(section_name) orelse continue;
        if (section != .object) continue;
        for (section.object.values()) |dependency| {
            if (dependency == .string and std.mem.startsWith(u8, dependency.string, "workspace:")) return true;
        }
    }
    return false;
}

fn matchesBin(bins: []const Bin, path: []const u8) bool {
    for (bins) |bin| switch (bin) {
        .file => |file| if (std.mem.eql(u8, file, path)) return true,
        .directory => |directory| {
            if (std.mem.startsWith(u8, path, directory) and path.len > directory.len and path[directory.len] == '/') {
                const remainder = path[directory.len + 1 ..];
                if (std.mem.indexOfScalar(u8, remainder, '/') == null) return true;
                // Bun archives nested files in directories.bin, but only direct children are executable.
                return true;
            }
        },
    };
    return false;
}

fn shouldIncludeProjectFile(
    io: std.Io,
    allocator: std.mem.Allocator,
    package_dir: []const u8,
    path: []const u8,
    maybe_files: ?Value,
) !bool {
    const basename = std.fs.path.basename(path);
    if (isUnconditionallyIncluded(basename)) return true;

    if (maybe_files) |files| {
        var included = false;
        var included_ancestor = false;
        for (files.array.items) |item| {
            if (item != .string or item.string.len == 0 or item.string[0] == '!') continue;
            const pattern = try normalizePattern(allocator, item.string);
            if (pattern.len == 0) continue;
            if (matchPattern(pattern, path)) included = true;
            var ancestor = std.fs.path.dirname(path);
            while (ancestor) |directory| : (ancestor = std.fs.path.dirname(directory)) {
                if (matchPattern(pattern, directory)) {
                    included = true;
                    included_ancestor = true;
                    break;
                }
            }
        }
        if (!included) return false;
        for (files.array.items) |item| {
            if (item != .string or item.string.len < 2 or item.string[0] != '!') continue;
            var pattern = try normalizePattern(allocator, item.string[1..]);
            const leading_globstar = std.mem.startsWith(u8, pattern, "**/");
            if (leading_globstar) pattern = pattern[3..];
            const candidate = if (included_ancestor or leading_globstar) basename else path;
            if (matchPattern(pattern, candidate)) return false;
        }
        return !isDefaultExcluded(path, false);
    }

    if (isSpecialFile(basename, "CHANGELOG")) return true;
    if (isDefaultExcluded(path, true)) return false;
    return !try ignoredByFiles(io, allocator, package_dir, path);
}

fn ignoredByFiles(io: std.Io, allocator: std.mem.Allocator, package_dir: []const u8, path: []const u8) !bool {
    var ignored = false;
    var relative_directory: []const u8 = "";
    while (true) {
        const absolute_directory = if (relative_directory.len == 0)
            package_dir
        else
            try std.fs.path.join(allocator, &.{ package_dir, relative_directory });
        const npmignore = try std.fs.path.join(allocator, &.{ absolute_directory, ".npmignore" });
        const gitignore = try std.fs.path.join(allocator, &.{ absolute_directory, ".gitignore" });
        const ignore_path = if (pathExists(io, npmignore)) npmignore else if (pathExists(io, gitignore)) gitignore else null;
        if (ignore_path) |file_path| {
            const source = try std.Io.Dir.cwd().readFileAlloc(io, file_path, allocator, .limited(16 * 1024 * 1024));
            const relative = if (relative_directory.len == 0) path else path[relative_directory.len + 1 ..];
            var lines = std.mem.splitScalar(u8, source, '\n');
            while (lines.next()) |raw_line| {
                var line = std.mem.trimEnd(u8, raw_line, "\r");
                if (line.len == 0 or line[0] == '#') continue;
                var negated = false;
                while (line.len > 0 and line[0] == '!') {
                    negated = true;
                    line = line[1..];
                }
                if (line.len == 0) continue;
                const pattern = try normalizePattern(allocator, line);
                if (ignorePatternMatches(pattern, relative)) ignored = !negated;
            }
        }

        const next_separator = std.mem.indexOfScalarPos(u8, path, relative_directory.len + @intFromBool(relative_directory.len > 0), '/') orelse break;
        relative_directory = path[0..next_separator];
    }
    return ignored;
}

fn ignorePatternMatches(pattern: []const u8, path: []const u8) bool {
    var value = pattern;
    if (value.len > 0 and value[0] == '/') value = value[1..];
    const dirs_only = value.len > 0 and value[value.len - 1] == '/';
    if (dirs_only) value = value[0 .. value.len - 1];
    if (value.len == 0) return false;
    if (std.mem.indexOfScalar(u8, value, '/') != null) {
        if (matchPattern(value, path)) return true;
        var ancestor = std.fs.path.dirname(path);
        while (ancestor) |directory| : (ancestor = std.fs.path.dirname(directory)) {
            if (matchPattern(value, directory)) return true;
        }
        return false;
    }
    var parts = std.mem.splitScalar(u8, path, '/');
    while (parts.next()) |part| if (matchPattern(value, part)) return true;
    return false;
}

fn isDefaultExcluded(path: []const u8, root_rules: bool) bool {
    const basename = std.fs.path.basename(path);
    if (isHardExcludedName(basename)) return true;
    if (root_rules and std.mem.indexOfScalar(u8, path, '/') == null) {
        for ([_][]const u8{ "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock" }) |name| {
            if (std.mem.eql(u8, basename, name)) return true;
        }
    }
    return matchPattern(".*.swp", basename) or
        matchPattern("._*", basename) or
        matchPattern(".wafpickle-*", basename) or
        std.mem.eql(u8, basename, ".DS_Store") or
        std.mem.eql(u8, basename, ".gitignore") or
        std.mem.eql(u8, basename, ".npmignore") or
        std.mem.eql(u8, basename, ".lock-wscript") or
        std.mem.eql(u8, basename, ".svn") or
        std.mem.eql(u8, basename, "CVS") or
        std.mem.eql(u8, basename, "npm-debug.log") or
        std.mem.eql(u8, basename, ".env.production") or
        std.mem.eql(u8, basename, "bunfig.toml");
}

fn isHardExcludedName(name: []const u8) bool {
    return std.mem.eql(u8, name, ".git") or
        std.mem.eql(u8, name, ".hg") or
        std.mem.eql(u8, name, ".npmrc");
}

fn isUnconditionallyIncluded(name: []const u8) bool {
    return isSpecialFile(name, "LICENSE") or isSpecialFile(name, "LICENCE") or isSpecialFile(name, "README");
}

fn isSpecialFile(name: []const u8, prefix: []const u8) bool {
    if (name.len < prefix.len) return false;
    const prefix_matches = if (builtin.os.tag == .linux)
        std.mem.eql(u8, name[0..prefix.len], prefix)
    else
        std.ascii.eqlIgnoreCase(name[0..prefix.len], prefix);
    return prefix_matches and (name.len == prefix.len or (name.len > prefix.len + 1 and name[prefix.len] == '.'));
}

fn bundledDependencyNames(
    allocator: std.mem.Allocator,
    manifest: *const Value,
    stderr: *std.Io.Writer,
) ![]const []const u8 {
    var names = std.array_list.Managed([]const u8).init(allocator);
    if (manifest.* != .object) return names.toOwnedSlice();
    const bundled = manifest.object.get("bundledDependencies") orelse
        manifest.object.get("bundleDependencies") orelse return names.toOwnedSlice();
    switch (bundled) {
        .bool => |include_all| {
            if (!include_all) return names.toOwnedSlice();
            const dependencies = manifest.object.get("dependencies") orelse return names.toOwnedSlice();
            if (dependencies != .object) return names.toOwnedSlice();
            for (dependencies.object.keys()) |name| try names.append(name);
        },
        .array => |items| {
            for (items.items) |item| {
                if (item != .string) {
                    try stderr.writeAll("error: expected `bundledDependencies` to be a boolean or an array of strings\n");
                    return error.InvalidBundledDependencies;
                }
                try names.append(item.string);
            }
        },
        else => {
            try stderr.writeAll("error: expected `bundledDependencies` to be a boolean or an array of strings\n");
            return error.InvalidBundledDependencies;
        },
    }
    return names.toOwnedSlice();
}

fn collectBundledDependency(
    io: std.Io,
    allocator: std.mem.Allocator,
    package_root: []const u8,
    owner_dir: []const u8,
    dependency_name: []const u8,
    selection: *Selection,
    seen_entries: *std.StringHashMap(void),
    seen_packages: *std.StringHashMap(void),
) !void {
    const dependency_dir = resolveDependency(io, allocator, package_root, owner_dir, dependency_name) orelse return;
    const package_key = try allocator.dupe(u8, dependency_dir);
    const package_seen = try seen_packages.getOrPut(package_key);
    if (package_seen.found_existing) return;
    selection.bundled_count += 1;

    var directory = try std.Io.Dir.openDirAbsolute(io, dependency_dir, .{ .iterate = true });
    defer directory.close(io);
    var walker = try directory.walk(allocator);
    defer walker.deinit();
    while (try walker.next(io)) |walk_entry| {
        if (walk_entry.kind == .directory) {
            if (std.mem.eql(u8, walk_entry.basename, "node_modules") or isHardExcludedName(walk_entry.basename)) walker.leave(io);
            continue;
        }
        if (walk_entry.kind != .file) continue;
        const absolute = try std.fs.path.join(allocator, &.{ dependency_dir, walk_entry.path });
        const relative_to_root = try std.fs.path.relative(allocator, package_root, null, package_root, absolute);
        const archive_path = try posixPath(allocator, relative_to_root);
        if (seen_entries.contains(archive_path)) continue;
        const relative_to_package = try posixPath(allocator, walk_entry.path);
        if (!isUnconditionallyIncluded(std.fs.path.basename(relative_to_package)) and
            (isDefaultExcluded(relative_to_package, true) or try ignoredByFiles(io, allocator, dependency_dir, relative_to_package))) continue;
        const contents = try std.Io.Dir.cwd().readFileAlloc(io, absolute, allocator, .limited(max_file_bytes));
        const stat = try std.Io.Dir.cwd().statFile(io, absolute, .{ .follow_symlinks = false });
        const mode: u32 = @intCast(@intFromEnum(stat.permissions));
        try seen_entries.put(archive_path, {});
        try selection.entries.append(.{ .path = archive_path, .contents = contents, .mode = mode | 0o644, .bundled = true });
    }

    const manifest_path = try std.fs.path.join(allocator, &.{ dependency_dir, "package.json" });
    const dependency_manifest = readManifest(io, allocator, manifest_path) catch return;
    if (dependency_manifest.value != .object) return;
    for ([_][]const u8{ "dependencies", "optionalDependencies" }) |section_name| {
        const dependencies = dependency_manifest.value.object.get(section_name) orelse continue;
        if (dependencies != .object) continue;
        for (dependencies.object.keys()) |child_name| {
            try collectBundledDependency(
                io,
                allocator,
                package_root,
                dependency_dir,
                child_name,
                selection,
                seen_entries,
                seen_packages,
            );
        }
    }
}

fn resolveDependency(
    io: std.Io,
    allocator: std.mem.Allocator,
    package_root: []const u8,
    owner_dir: []const u8,
    dependency_name: []const u8,
) ?[]const u8 {
    var current = owner_dir;
    while (true) {
        const candidate = std.fs.path.join(allocator, &.{ current, "node_modules", dependency_name }) catch return null;
        const stat = std.Io.Dir.cwd().statFile(io, candidate, .{}) catch null;
        if (stat) |info| if (info.kind == .directory) return candidate;
        if (std.mem.eql(u8, current, package_root)) break;
        const parent = std.fs.path.dirname(current) orelse break;
        if (parent.len < package_root.len or std.mem.eql(u8, parent, current)) break;
        current = parent;
    }
    return null;
}

fn createTar(allocator: std.mem.Allocator, entries: []const Entry) ![]const u8 {
    var output = try std.Io.Writer.Allocating.initCapacity(allocator, 1024);
    var tar_writer = std.tar.Writer{ .underlying_writer = &output.writer };
    for (entries) |entry| {
        const archive_path = try std.fmt.allocPrint(allocator, "package/{s}", .{entry.path});
        try tar_writer.writeFileBytes(archive_path, entry.contents, .{ .mode = entry.mode, .mtime = fixed_mtime });
    }
    try tar_writer.finishPedantically();
    return output.toOwnedSlice();
}

fn gzip(allocator: std.mem.Allocator, source: []const u8, level: u4) ![]const u8 {
    if (level == 0) return gzipStored(allocator, source);
    var output = try std.Io.Writer.Allocating.initCapacity(allocator, @max(@as(usize, 64), source.len / 2));
    const history = try allocator.alloc(u8, std.compress.flate.max_window_len * 2);
    const compression_options: std.compress.flate.Compress.Options = switch (level) {
        1 => .level_1,
        2 => .level_2,
        3 => .level_3,
        4 => .level_4,
        5 => .level_5,
        6 => .level_6,
        7 => .level_7,
        8 => .level_8,
        9 => .level_9,
        else => unreachable,
    };
    var compressor = try std.compress.flate.Compress.init(&output.writer, history, .gzip, compression_options);
    try compressor.writer.writeAll(source);
    try compressor.finish();
    return output.toOwnedSlice();
}

fn gzipStored(allocator: std.mem.Allocator, source: []const u8) ![]const u8 {
    var output = try std.Io.Writer.Allocating.initCapacity(allocator, source.len + 64);
    try output.writer.writeAll(&.{ 0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff });
    var offset: usize = 0;
    while (offset < source.len or (source.len == 0 and offset == 0)) {
        const remaining = source.len - offset;
        const length: u16 = @intCast(@min(remaining, 65535));
        const final = offset + length == source.len;
        try output.writer.writeByte(if (final) 1 else 0);
        try writeLittle(&output.writer, length, 2);
        try writeLittle(&output.writer, ~length, 2);
        try output.writer.writeAll(source[offset .. offset + length]);
        offset += length;
        if (final) break;
    }
    try writeLittle(&output.writer, std.hash.Crc32.hash(source), 4);
    try writeLittle(&output.writer, @as(u32, @truncate(source.len)), 4);
    return output.toOwnedSlice();
}

fn writeLittle(writer: *std.Io.Writer, value: anytype, byte_count: usize) !void {
    const unsigned: u64 = @intCast(value);
    for (0..byte_count) |index| try writer.writeByte(@truncate(unsigned >> @intCast(index * 8)));
}

fn defaultTarballName(allocator: std.mem.Allocator, name: []const u8, package_version: []const u8) ![]const u8 {
    if (name[0] == '@') {
        if (name.len > 1) {
            if (std.mem.indexOfScalar(u8, name, '/')) |slash| {
                return std.fmt.allocPrint(allocator, "{s}-{s}-{s}.tgz", .{ name[1..slash], name[slash + 1 ..], package_version });
            }
        }
        return std.fmt.allocPrint(allocator, "{s}-{s}.tgz", .{ name[1..], package_version });
    }
    return std.fmt.allocPrint(allocator, "{s}-{s}.tgz", .{ name, package_version });
}

fn tarballDestination(
    allocator: std.mem.Allocator,
    package_dir: []const u8,
    tarball_name: []const u8,
    options: Options,
) ![]const u8 {
    if (options.filename) |filename| return filename;
    const destination_dir = if (options.destination) |destination|
        if (std.fs.path.isAbsolute(destination)) destination else try std.fs.path.join(allocator, &.{ package_dir, destination })
    else
        package_dir;
    return std.fmt.allocPrint(allocator, "{s}{c}{s}", .{ std.mem.trimEnd(u8, destination_dir, "/\\"), std.fs.path.sep, tarball_name });
}

pub fn printEntries(writer: *std.Io.Writer, entries: []const Entry) !void {
    var printed_any = false;
    for (entries) |entry| {
        if (entry.bundled) continue;
        if (!printed_any) try writer.writeByte('\n');
        printed_any = true;
        try writer.writeAll("packed ");
        try printSize(writer, entry.contents.len);
        try writer.print(" {s}\n", .{entry.path});
    }
}

pub fn printSize(writer: *std.Io.Writer, bytes: usize) !void {
    if (bytes < 1000) return writer.print("{d}B", .{bytes});
    if (bytes < 1_000_000) return writer.print("{d:.2}KB", .{@as(f64, @floatFromInt(bytes)) / 1000.0});
    return writer.print("{d:.2}MB", .{@as(f64, @floatFromInt(bytes)) / 1_000_000.0});
}

fn normalizePattern(allocator: std.mem.Allocator, input: []const u8) ![]const u8 {
    var output: std.Io.Writer.Allocating = .init(allocator);
    var parts = std.mem.tokenizeAny(u8, input, "/\\");
    var first = true;
    while (parts.next()) |part| {
        if (std.mem.eql(u8, part, ".")) continue;
        if (!first) try output.writer.writeByte('/');
        try output.writer.writeAll(part);
        first = false;
    }
    return output.toOwnedSlice();
}

fn posixPath(allocator: std.mem.Allocator, input: []const u8) ![]const u8 {
    const path = try allocator.dupe(u8, input);
    std.mem.replaceScalar(u8, path, '\\', '/');
    return path;
}

fn matchPattern(pattern: []const u8, path: []const u8) bool {
    if (std.mem.eql(u8, pattern, path)) return true;
    if (std.mem.startsWith(u8, path, pattern) and path.len > pattern.len and path[pattern.len] == '/' and
        std.mem.indexOfAny(u8, pattern, "*?[{") == null) return true;
    return compiler.glob.match(pattern, path).matches();
}

fn hasScript(manifest: *const Value, name: []const u8) bool {
    if (manifest.* != .object) return false;
    const scripts = manifest.object.get("scripts") orelse return false;
    if (scripts != .object) return false;
    const script = scripts.object.get(name) orelse return false;
    return script == .string and script.string.len > 0;
}

fn pathExists(io: std.Io, path: []const u8) bool {
    std.Io.Dir.cwd().access(io, path, .{}) catch return false;
    return true;
}

fn lessEntry(_: void, left: Entry, right: Entry) bool {
    return std.mem.order(u8, left.path, right.path) == .lt;
}

test "tarball names follow Bun pack normalization" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectEqualStrings("scoped-pkg-1.2.3.tgz", try defaultTarballName(arena.allocator(), "@scoped/pkg", "1.2.3"));
    try std.testing.expectEqualStrings("s-1.2.3.tgz", try defaultTarballName(arena.allocator(), "@s", "1.2.3"));
    try std.testing.expectEqualStrings("plain-1.2.3.tgz", try defaultTarballName(arena.allocator(), "plain", "1.2.3"));
}

test "gzip level zero emits a valid stored stream" {
    const compressed = try gzipStored(std.testing.allocator, "cottontail pack");
    defer std.testing.allocator.free(compressed);
    try std.testing.expectEqualSlices(u8, &.{ 0x1f, 0x8b, 0x08 }, compressed[0..3]);
    try std.testing.expect(compressed.len > "cottontail pack".len);
}
